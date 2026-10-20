/**
 * Low-RAM concurrent page reader — the extraction half of the pipeline.
 *
 * 3-tier anti-bot extraction per URL:
 *   Tier 1 — direct TLS-impersonated fetch → linkedom + readability →
 *            turndown markdown (≤ 2MB body, 3500ms ceiling)
 *   Tier 2 — Cloudflare/SPA fallback: free markdown reader at r.jina.ai
 *            (3000ms)
 *   Tier 3 — snippet preservation: if both fail, the metasearch snippet
 *            becomes the partial-evidence passage (never crashes)
 *
 * Concurrency: p-limit(6) so RAM stays well under 100MB for a 10-URL
 * scrape (one linkedom document is ~8–15MB at peak, freed as each
 * settles).
 */
import pLimit from "p-limit";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { fetchPage } from "./tls-client";
import type { RankedResult } from "./metasearch";
import { getCachedPage, putCachedPage } from "./cache";
import type { EvidencePacket } from "./types";

const limit = pLimit(6);

/** linkedom returns a Window (global); pull the DOM document off it. */
function docOf(html: string): any {
  const w: any = parseHTML(html);
  return w?.document ?? w;
}

// One Turndown instance (pure-JS stateful processor — cheap).
let _td: TurndownService | null = null;
function turndown(): TurndownService {
  if (!_td) {
    _td = new TurndownService();
    _td.addRule("pre-wrap", {
      filter: "pre",
      replacement: (content: string) => `\n\`\`\`\n${content}\n\`\`\`\n`,
    });
  }
  return _td;
}

async function loadReadability(): Promise<
  ((doc: any) => { content: string } | null)
> {
  const mod: any = await import("@mozilla/readability");
  const Readability = mod.Readability ?? mod.default?.Readability;
  return (doc: any) =>
    Readability ? new Readability(doc).parse() : null;
}

function pageToMarkdown(html: string): string {
  try {
    const doc = docOf(html);
    const article: any = (doc as any).querySelector("article") || (doc as any).body;
    const htmlToConvert: string = article?.outerHTML || (doc as any).body?.innerHTML || "";
    const md = turndown().turndown(
      "<html><body>" + htmlToConvert + "</body></html>",
    );
    return md.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

async function readabilityMarkdown(
  html: string,
): Promise<string> {
  const doc = docOf(html);
  const readability = await loadReadability();
  const parsed = readability(doc);
  const content: string = parsed?.content || "";
  if (content.length < 200) return pageToMarkdown(html);
  return turndown().turndown(content).replace(/\n{3,}/g, "\n\n").trim();
}

/** Tier 1: direct fetch + DOM extraction. */
async function extractDirect(url: string): Promise<string | null> {
  const page = await fetchPage(url, { timeoutMs: 3500 });
  if (!page || !page.ok || page.body.length < 200) return null;
  if (!/text\/html|application\/xhtml/i.test(page.contentType)) {
    // Not HTML (PDF, JSON blob, ...) — pass raw through trimmed
    return page.body.slice(0, 8000);
  }
  // Detect Cloudflare / JS challenge pages → Tier 2 handles them
  const cloudflareSignals = [
    "cf-chl",
    "challenge-platform",
    "just a moment",
    "checking your browser",
  ].some((sig) => page.body.toLowerCase().includes(sig));
  if (cloudflareSignals) return null;
  try {
    const md = await readabilityMarkdown(page.body);
    return md.length >= 200 ? md : null;
  } catch {
    return null;
  }
}

/** Tier 2: free jina.ai markdown reader. */
async function extractJina(url: string): Promise<string | null> {
  const jinaUrl = "https://r.jina.ai/" + encodeURI(url);
  const page = await fetchPage(jinaUrl, {
    timeoutMs: 3000,
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!page || !page.ok) return null;
  const body = page.body.trim();
  return body.length >= 200 ? body : null;
}

/**
 * Fetch + extract one URL through all three tiers (cache-aware).
 * Never throws: returns a snippet-only packet on total failure.
 */
export async function extractUrl(
  result: RankedResult,
): Promise<EvidencePacket> {
  const url = result.canonical;
  const packet: EvidencePacket = {
    sourceId: "", // assigned later
    url,
    title: result.title,
    domain: result.domain,
    publishedAt: result.publishedDate,
    extraction: "snippet-only",
    passages: [],
  };

  // Tier 0: SQLite cache hit
  const cached = getCachedPage(url);
  if (cached && cached.extracted.length >= 200) {
    packet.extraction =
      cached.tier === "jina" ? "jina-fallback" : "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: cached.extracted.slice(0, 12000),
      bm25Score: 0,
    });
    return packet;
  }

  // Tier 1: direct
  let md = await extractDirect(url);
  let tier: EvidencePacket["extraction"] = "direct";
  if (md) {
    putCachedPage(url, md, "direct");
  } else {
    // Tier 2: jina fallback
    md = await extractJina(url);
    if (md) {
      tier = "jina-fallback";
      putCachedPage(url, md, "jina");
    }
  }

  if (md) {
    packet.extraction = tier;
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: md.slice(0, 12000),
      bm25Score: 0,
    });
  } else {
    // Tier 3: snippet preservation — never crash, never hang
    packet.extraction = "snippet-only";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: result.snippet || result.title,
      bm25Score: 0,
    });
  }
  return packet;
}

/**
 * Extract the top N ranked results in parallel (capped at 10 URLs, 6 at a
 * time). Returns packets ready for BM25 scoring.
 */
export async function extractAll(
  ranked: RankedResult[],
  maxUrls = 10,
): Promise<EvidencePacket[]> {
  const top = ranked.slice(0, maxUrls);
  const settled = await Promise.all(
    top.map((r) => limit(() => extractUrl(r))),
  );
  // Assign S1..Sn in rank order
  settled.forEach((packet: EvidencePacket, i: number) => {
    packet.sourceId = "S" + (i + 1);
    for (const p of packet.passages) p.sourceId = packet.sourceId;
  });
  return settled;
}
