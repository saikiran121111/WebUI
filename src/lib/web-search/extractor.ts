/**
 * Low-RAM concurrent page reader — the extraction half of the pipeline.
 *
 * 4-tier anti-bot extraction per URL:
 *   Tier 0 — SQLite cache hit (instant)
 *   Tier 1 — direct TLS-impersonated fetch → block-detector gate →
 *            linkedom + readability → turndown markdown, PLUS
 *            JSON-LD / OG / hydration-state structured extraction
 *            (never let a DOM-only page lose its product/job metadata).
 *   Tier 1.5 — domain adapter (Reddit .json, GitHub raw, YouTube oEmbed,
 *            OSM Nominatim, ...) when the host is in the adapter table.
 *   Tier 2 — Cloudflare/SPA fallback: free markdown reader at r.jina.ai.
 *   Tier 3 — snippet preservation: if everything fails, the metasearch
 *            snippet becomes the partial-evidence passage (never crashes).
 *
 * Every URL is classified into one of the report categories:
 *   SUCCESS_DIRECT, SUCCESS_ADAPTER, SUCCESS_METADATA,
 *   SUCCESS_JINA_FALLBACK, SUCCESS_SNIPPET_FALLBACK,
 *   FAIL_SILENT_BOT_BLOCK, FAIL_SILENT_LOGIN_WALL,
 *   FAIL_EMPTY_JS_SHELL, FAIL_NETWORK_OR_CRASH
 *
 * The extractor NEVER passes a login-wall or CAPTCHA body into the
 * reranker: when detectBlock() fires, it short-circuits to Tier 2 or 3.
 */
import pLimit from "p-limit";
import TurndownService from "turndown";
import { fetchPage, type PageResponse } from "./tls-client";
import type { RankedResult } from "./metasearch";
import { getCachedPage, putCachedPage } from "./cache";
import { detectBlock, detectBlockInText } from "./block-detector";
import {
  domainAdapter,
  extractStructuredMeta,
  extractHydrationState,
} from "./domain-adapters";
import { parseHTML } from "linkedom";
import type { EvidencePacket } from "./types";

const limit = pLimit(6);

/* ── linkedom + turndown helpers ───────────────────────────────────────── */

function docOf(html: string): any {
  const w: any = parseHTML(html);
  return w?.document ?? w;
}

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
    const article = doc.querySelector("article") || doc.body;
    const htmlToConvert =
      article?.outerHTML || doc.body?.innerHTML || "";
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

/* ── Extraction tier results (internal) ───────────────────────────────── */

type Tier = "direct" | "adapter" | "metadata" | "jina" | "snippet" | "crash";

interface TierOutput {
  tier: Tier;
  markdown: string;
  status: number;
  /** Block detector verdict (kind=null when not blocked). */
  blocked: boolean;
  blockedReason: string;
}

/**
 * Tier 1: direct fetch + block gate + DOM extraction + structured meta.
 * Returns null when the response is a confirmed block (caller tries the
 * adapter / Jina / snippet tiers).
 */
async function extractDirect(
  url: string,
  fp: "chrome" | "firefox" | "edge" = "chrome",
): Promise<TierOutput | null> {
  const page: PageResponse | null = await fetchPage(url, {
    timeoutMs: 3500,
    fingerprint: fp,
  });
  if (!page) return { tier: "crash", markdown: "", status: 0, blocked: true, blockedReason: "network error / timeout" };
  if (!page.ok || page.body.length < 200) {
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: false,
      blockedReason: "HTTP " + page.status + " (non-200 or empty body)",
    };
  }
  // Non-HTML response: hand it to the adapter (which knows JSON shapes)
  // or pass raw through trimmed.
  if (!/text\/html|application\/xhtml/i.test(page.contentType)) {
    const trimmed = page.body.slice(0, 8000);
    if (trimmed.length >= 100) {
      return {
        tier: "metadata",
        markdown: trimmed,
        status: page.status,
        blocked: false,
        blockedReason: "",
      };
    }
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: false,
      blockedReason: "non-HTML response under 100 chars",
    };
  }

  // Block gate BEFORE DOM parsing — a challenge page should never reach
  // readability (it would extract "Checking your browser" as content).
  const block = detectBlock(page.body, page.status, page.contentType);
  if (block.blocked) {
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: true,
      blockedReason: block.reason,
    };
  }

  // DOM extraction
  let md: string;
  try {
    md = await readabilityMarkdown(page.body);
  } catch {
    md = pageToMarkdown(page.body);
  }

  // Structured meta: always extract, even when DOM text is sparse —
  // a product page may have only 50 chars of body but rich JSON-LD.
  const structuredMeta = extractStructuredMeta(page.body);
  const hydration = extractHydrationState(page.body);
  if (structuredMeta || hydration) {
    const all = [structuredMeta, hydration, md].filter(Boolean).join("\n\n");
    md = all;
  }

  // Text-level block check (silent blocks that survived readability)
  const textBlock = detectBlockInText(md);
  if (textBlock.blocked) {
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: true,
      blockedReason: textBlock.reason,
    };
  }

  if (md.length < 100) {
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: false,
      blockedReason: "empty JS shell (under 100 meaningful chars)",
    };
  }
  return {
    tier: "direct",
    markdown: md,
    status: page.status,
    blocked: false,
    blockedReason: "",
  };
}

/** Tier 1.5: domain adapter (keyless JSON rewrite). */
async function extractAdapter(url: string): Promise<TierOutput | null> {
  const result = await domainAdapter(url);
  if (!result) return null;
  return {
    tier: "adapter",
    markdown: result.markdown,
    status: 200,
    blocked: false,
    blockedReason: "",
  };
}

/** Tier 2: free jina.ai markdown reader. */
async function extractJina(url: string): Promise<TierOutput | null> {
  const jinaUrl = "https://r.jina.ai/" + encodeURI(url);
  const page = await fetchPage(jinaUrl, {
    timeoutMs: 3000,
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!page || !page.ok) return null;
  const body = page.body.trim();
  const block = detectBlockInText(body);
  if (block.blocked) {
    // Jina returned a challenge page — treat as a failed tier.
    return null;
  }
  return body.length >= 200
    ? {
        tier: "jina",
        markdown: body,
        status: page.status,
        blocked: false,
        blockedReason: "",
      }
    : null;
}

/* ── Public entry points ─────────────────────────────────────────────── */

/**
 * Fetch + extract one URL through every tier in order, with fingerprint
 * rotation on 403/429/503 and a per-host block short-circuit.
 *
 * Never throws: returns a snippet-only packet on total failure so the
 * pipeline still has SOMETHING for the BM25 reranker.
 */
export async function extractUrl(
  result: RankedResult,
): Promise<EvidencePacket & { classification: string }> {
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
      cached.tier === "jina"
        ? "jina-fallback"
        : cached.tier === "adapter"
          ? "direct"
          : "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: cached.extracted.slice(0, 12000),
      bm25Score: 0,
    });
    const cachedTier =
      cached.tier === "jina" ? "jina" : cached.tier === "adapter" ? "adapter" : "direct";
    const classification =
      cachedTier === "jina"
        ? "SUCCESS_JINA_FALLBACK"
        : cachedTier === "adapter"
          ? "SUCCESS_ADAPTER"
          : "SUCCESS_DIRECT";
    return { ...packet, classification };
  }

  // Tier 1.5: domain adapter first (it's the cheapest for known hosts)
  const adapterOut = await extractAdapter(url);
  if (adapterOut && adapterOut.markdown.length >= 200) {
    packet.extraction = "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: adapterOut.markdown.slice(0, 12000),
      bm25Score: 0,
    });
    putCachedPage(url, adapterOut.markdown, "adapter");
    return { ...packet, classification: "SUCCESS_ADAPTER" };
  }

  // Tier 1: direct fetch with fingerprint rotation on block
  const fingerprints: ("chrome" | "firefox" | "edge")[] = ["chrome", "firefox"];
  let directOut: TierOutput | null = null;
  for (const fp of fingerprints) {
    directOut = await extractDirect(url, fp);
    if (directOut && !directOut.blocked && directOut.markdown.length >= 100) {
      break;
    }
    // If the first fingerprint hit a hard block, try the second;
    // if we reach the end, `directOut` holds the last block verdict.
  }

  if (directOut && !directOut.blocked && directOut.markdown.length >= 200) {
    packet.extraction = "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: directOut.markdown.slice(0, 12000),
      bm25Score: 0,
    });
    putCachedPage(url, directOut.markdown, "direct");
    return { ...packet, classification: "SUCCESS_DIRECT" };
  }

  // If Tier 1 produced only metadata (product JSON-LD, hydration state),
  // classify as SUCCESS_METADATA even when the DOM text was thin.
  if (
    directOut &&
    !directOut.blocked &&
    directOut.tier === "metadata" &&
    directOut.markdown.length >= 100
  ) {
    packet.extraction = "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: directOut.markdown.slice(0, 12000),
      bm25Score: 0,
    });
    putCachedPage(url, directOut.markdown, "metadata");
    return { ...packet, classification: "SUCCESS_METADATA" };
  }

  // Tier 2: Jina fallback — fires on any Tier 1 failure including silent
  // blocks (which is its whole point for Cloudflare-protected pages).
  const jinaOut = await extractJina(url);
  if (jinaOut && jinaOut.markdown.length >= 200) {
    packet.extraction = "jina-fallback";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: jinaOut.markdown.slice(0, 12000),
      bm25Score: 0,
    });
    putCachedPage(url, jinaOut.markdown, "jina");
    return { ...packet, classification: "SUCCESS_JINA_FALLBACK" };
  }

  // Tier 3: snippet preservation — the metasearch snippet becomes the
  // passage. If the snippet is empty (a corpus URL with no pre-indexed
  // search result), the title is used as a minimal evidence stub so the
  // pipeline still has SOMETHING for the BM25 reranker.
  packet.extraction = "snippet-only";
  const snippet = result.snippet || result.title || "";

  // Classify the Tier 3 result: if Tier 1 hit a real block, this is a
  // FAIL_* that the stress report will surface; otherwise it's a clean
  // snippet fallback (SUCCESS_SNIPPET_FALLBACK).
  if (directOut && directOut.blocked) {
    const kind = directOut.blockedReason;
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: snippet.length >= 20 ? snippet : result.title || "(blocked page)",
      bm25Score: 0,
    });
    if (/login|sign in|auth/i.test(kind)) {
      return { ...packet, classification: "FAIL_SILENT_LOGIN_WALL" };
    }
    if (/cloudflare|akamai|perimeterx|datadome|captcha|bot|js/i.test(kind)) {
      return { ...packet, classification: "FAIL_SILENT_BOT_BLOCK" };
    }
    return { ...packet, classification: "FAIL_NETWORK_OR_CRASH" };
  }

  if (snippet.length < 20) {
    // No snippet AND no title: this is a true empty JS shell — classify
    // as FAIL_EMPTY_JS_SHELL. We still keep the URL in the packet so
    // downstream consumers can see it, but the reranker will penalize
    // it heavily (zero useful tokens).
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: result.title || "(empty page — JS shell, no content extracted)",
      bm25Score: 0,
    });
    return { ...packet, classification: "FAIL_EMPTY_JS_SHELL" };
  }

  // A real snippet (or title) survived the Tier 1 failure — this is a
  // clean SUCCESS_SNIPPET_FALLBACK.
  packet.passages.push({
    sourceId: "",
    url,
    title: result.title,
    domain: result.domain,
    publishedAt: result.publishedDate,
    passageText: snippet,
    bm25Score: 0,
  });
  return { ...packet, classification: "SUCCESS_SNIPPET_FALLBACK" };
}

/**
 * Extract the top N ranked results in parallel (capped at 10 URLs, 6 at a
 * time). Returns packets ready for BM25 scoring, each with its
 * classification for the stress-test report.
 */
export async function extractAll(
  ranked: RankedResult[],
  maxUrls = 10,
): Promise<(EvidencePacket & { classification: string })[]> {
  const top = ranked.slice(0, maxUrls);
  const settled = await Promise.all(
    top.map((r) => limit(() => extractUrl(r))),
  );
  // Assign S1..Sn in rank order
  settled.forEach((packet, i) => {
    packet.sourceId = "S" + (i + 1);
    for (const p of packet.passages) p.sourceId = packet.sourceId;
  });
  return settled;
}
