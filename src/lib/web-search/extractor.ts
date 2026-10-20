/**
 * Low-RAM concurrent page reader — the extraction half of the pipeline.
 *
 * 5-tier anti-bot extraction per URL:
 *   Tier 0   — SQLite cache hit (instant)
 *   Tier 1   — direct TLS-impersonated fetch → block-detector gate →
 *              structural-mode DOM extraction (article / portfolio /
 *              docs / document) PLUS universal schema/hydration/protocol
 *              discovery (JSON-LD across 14 schema types, OpenGraph,
 *              __NEXT_DATA__, __NUXT_DATA__, ytInitialData, Discourse,
 *              Shopify, CMS RSS alternates, /llms.txt, .md twins).
 *   Tier 1.5 — domain adapter (Reddit .json, GitHub raw, YouTube
 *              oEmbed, OSM Nominatim, ...) for known hard hosts.
 *   Tier 2   — Cloudflare/SPA / WAF fallback: free markdown reader at
 *              r.jina.ai.
 *   Tier 3   — Wayback Machine snapshot (archive.org CDX +
 *              availability API) for hard-blocked / dead / paywalled
 *              URLs.
 *   Tier 4   — snippet / title preservation: if everything fails, the
 *              metasearch snippet becomes the partial-evidence passage
 *              (never crashes).
 *
 * Every URL is classified into one of the report categories:
 *   SUCCESS_DIRECT, SUCCESS_ADAPTER, SUCCESS_METADATA,
 *   SUCCESS_JINA_FALLBACK, SUCCESS_WAYBACK, SUCCESS_SNIPPET_FALLBACK,
 *   FAIL_SILENT_BOT_BLOCK, FAIL_SILENT_LOGIN_WALL,
 *   FAIL_EMPTY_JS_SHELL, FAIL_NETWORK_OR_CRASH
 *
 * The extractor NEVER passes a login-wall or CAPTCHA body into the
 * reranker: when detectBlock() fires, it short-circuits to Tier 2/3/4.
 */
import pLimit from "p-limit";
import {
  fetchPage,
  fetchUrl,
  fetchWithLinkPreviewBots,
  PDF_LIMIT_BYTES,
  type PageResponse,
} from "./tls-client";
import type { RankedResult } from "./metasearch";
import { getCachedPage, putCachedPage } from "./cache";
import { detectBlock, detectBlockInText, stripWafChallengeText, hasMeaningfulContent } from "./block-detector";
import { domainAdapter } from "./domain-adapters";
import { universalDiscovery, universalSchemaExtract } from "./universal-discovery";
import { unpackHydration } from "./hydration-unpacker";
import {
  structuralExtractAsync,
  detectMode,
  extractDocumentSync,
} from "./universal-extractor";
import { normalizeBody, detectCharset } from "./charset-normalizer";
import { urlSearchFallback, slugTriangulation } from "./metasearch";
import type { EvidencePacket } from "./types";

// Per-tier timeouts (7-tier cascade):
//   Tier 1A/1B (direct + browser rotation): 45s each
//   Tier 2   (link-preview bots):           45s per bot, 4 bots
//   Tier 3   (platform JSON / llms.txt):    45s
//   Tier 4   (Jina):                        45s
//   Tier 5   (Wayback):                     45s
//   Tier 6   (slug triangulation):           uses metasearch (40s/engine)
//   PDF downloads:                          120s
const TIER1_TIMEOUT_MS = 45_000;
const LINK_PREVIEW_TIMEOUT_MS = 45_000;
const JINA_TIMEOUT_MS = 45_000;
const WAYBACK_TIMEOUT_MS = 45_000;
const PDF_DOWNLOAD_TIMEOUT_MS = 120_000;

// Concurrency for the DOM-extraction tier. Lowered from 6 → 4 so that
// under the stress test's 8-URL global pool the peak RSS stays under
// the 450MB budget (unpdf / Jina / Wayback each hold a working set of
// ~30-50MB while parsing). The production pipeline (≤10 URLs) is
// unaffected — the extra two slots only matter at corpus scale.
const limit = pLimit(4);

// Jina rate limiter: r.jina.ai's free tier caps at ~20 req/s per IP.
// 6 concurrent + a 250ms gap between starts keeps us well under that
// without stalling the pipeline.
const jinaLimit = pLimit(6);

/* ── Extraction tier results (internal) ───────────────────────────────── */

type Tier =
  | "direct"
  | "adapter"
  | "metadata"
  | "jina"
  | "wayback"
  | "snippet"
  | "crash";

interface TierOutput {
  tier: Tier;
  markdown: string;
  status: number;
  /** Block detector verdict (kind=null when not blocked). */
  blocked: boolean;
  blockedReason: string;
  /** Which structural mode was used (for the stress-test report). */
  mode?: string;
  /** Number of markdown tables preserved (portfolio / SaaS signal). */
  tableCount?: number;
  /** Number of <pre><code> blocks preserved (docs signal). */
  codeBlockCount?: number;
}

/**
 * Tier 1: direct fetch + block gate + structural-mode DOM extraction +
 * universal schema / hydration / protocol discovery.
 *
 * Fingerprint rotation on 403/429/503 is handled INSIDE fetchPage
 * (tls-client.ts). The caller no longer re-fires Tier 1 with a second
 * fingerprint — that was the double-fetch that kept Jina from ever
 * seeing the clean HTML response on hosts like news.ycombinator.com
 * (a fingerprint the direct fetch had already recovered under).
 *
 * Returns a TierOutput on every path (never null) so the caller can
 * inspect the block verdict, mode, and table/code counts.
 */
async function extractDirect(
  url: string,
  fp: "chrome" | "firefox" | "edge" = "chrome",
): Promise<TierOutput> {
  const page: PageResponse | null = await fetchPage(url, {
    timeoutMs: TIER1_TIMEOUT_MS,
    fingerprint: fp,
  });
  if (!page) {
    return {
      tier: "crash",
      markdown: "",
      status: 0,
      blocked: true,
      blockedReason: "network error / timeout",
    };
  }

  // Normalize the body's charset before anything else — this is what
  // keeps Shift_JIS / GB18030 / EUC-KR / Windows-1252 pages readable
  // instead of garbled. (No-op for UTF-8, the common case: impit's
  // readBounded already decoded it, so we only re-decode when the
  // content-type names a non-UTF-8 charset.)
  const bytes = new TextEncoder().encode(page.body);
  const charset = detectCharset(page.contentType, bytes);
  const html =
    charset === "utf-8" ? page.body : normalizeBody(bytes, page.contentType);

  if (!page.ok || page.body.length < 200) {
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: false,
      blockedReason: "HTTP " + page.status + " (non-200 or empty body)",
    };
  }

  // Non-HTML response: hand it to the structural extractor's document
  // mode (CSV/JSON/Markdown sync; PDF via the raw slice — Jina Tier 2
  // handles PDF rendering when it matters).
  if (!/text\/html|application\/xhtml/i.test(page.contentType)) {
    const md = extractDocumentSync(page.body, page.contentType, url);
    if (md.length >= 100) {
      return {
        tier: "metadata",
        markdown: md,
        status: page.status,
        blocked: false,
        blockedReason: "",
        mode: "document",
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
  // the extractor (it would extract "Checking your browser" as content).
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

  // DOM extraction: pick the right structural mode automatically.
  const det = detectMode(page.body, page.contentType, url);
  let md: string;
  let tableCount = 0;
  let codeBlockCount = 0;
  {
    const structOut = await structuralExtractAsync(
      page.body,
      page.contentType,
      url,
    );
    md = structOut.markdown;
    tableCount = structOut.tableCount;
    codeBlockCount = structOut.codeBlockCount;
    // The structural sync path can return "" when turndown + linkedom
    // both choke on a page's DOM shape. Fall back to plain-text
    // extraction so the URL still yields content (and never silently
    // drops to Jina for a page that actually had text in it).
    if (md.length < 100) {
      const fallback = page.body
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (fallback.length >= 100) {
        md = "## Page text (raw extraction)\n" + fallback.slice(0, 12000);
      }
    }
  }

  // Universal machine-readable discovery + SSR hydration unpacking.
  // ONLY fires when the structural DOM extraction came up thin — for a
  // page that already produced enough text, re-parsing the same body
  // through 10 schema/hydration/protocol paths is pure waste (this is
  // what was blowing the 4500ms cold-cache budget on plain HTML pages).
  //
  // Two cheap signals: the ORIGINAL HTML body's plain-text length (before
  // any extraction) and the structural extractor's markdown output.
  // If the body itself has <1500 chars of visible text, it's a JS shell
  // or a structured-data-heavy page → run the schema/hydration channels.
  // Otherwise, skip them (the DOM already gave us real content).
  const bodyPlainLen = page.body.replace(/<[^>]+>/g, " ").trim().length;
  const domThin =
    det.mode === "document" ||
    bodyPlainLen < 1500 ||
    md.length < 800;
  if (domThin) {
    // Cheap pure-HTML channels first (no network): universal schema +
    // hydration unpacking. These parse the same body the DOM pass
    // already paid for.
    const schemaMd = universalSchemaExtract(page.body);
    const hydrationMd = unpackHydration(page.body);
    if (schemaMd || hydrationMd) {
      md = [schemaMd, hydrationMd, md].filter(Boolean).join("\n\n");
    }
    // Only when the body is genuinely a JS shell (<1500 plain-text
    // chars) do we pay for the network-based discovery channels
    // (Discourse .json, Shopify .json, CMS RSS, /llms.txt, markdown
    // negotiation). For a normal page the DOM extraction already won.
    if (bodyPlainLen < 1500) {
      const universalMd = await universalDiscovery(url, page.body, page);
      if (universalMd?.markdown) {
        md = [universalMd.markdown, md].filter(Boolean).join("\n\n");
      }
    }
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
      mode: det.mode,
      tableCount,
      codeBlockCount,
    };
  }
  return {
    tier: "direct",
    markdown: md,
    status: page.status,
    blocked: false,
    blockedReason: "",
    mode: det.mode,
    tableCount,
    codeBlockCount,
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

/**
 * Tier 2: social link-preview crawler bypass (WhatsApp / Facebook /
 * Twitter / Slack UAs). Hostile WAFs whitelist these bots, so a blocked
 * URL that 403'd under browser TLS often returns a clean 200 under a
 * link-preview UA.
 *
 * The response body is a real HTML page — we extract OpenGraph / Twitter
 * / JSON-LD / hydration / body text from it before handing to the cascade.
 */
async function extractLinkPreview(
  url: string,
): Promise<TierOutput | null> {
  const page: (PageResponse & { botName: string }) | null =
    await fetchWithLinkPreviewBots(url, {
      timeoutMs: LINK_PREVIEW_TIMEOUT_MS,
    });
  if (!page || !page.ok || page.body.length < 200) return null;

  // Block gate on the bot-fetched body — a WAF can still return a
  // challenge page as a 200 to a whitelisted bot.
  const block = detectBlock(page.body, page.status, page.contentType);
  if (block.blocked) return null;

  // Extract structured metadata + DOM text from the bot-fetched body.
  const schemaMd = universalSchemaExtract(page.body);
  const hydrationMd = unpackHydration(page.body);
  const structOut = await structuralExtractAsync(
    page.body,
    page.contentType,
    url,
  );
  let md = structOut.markdown;
  // Raw-text fallback if the DOM pass produced little
  if (md.length < 100) {
    const fallback = page.body
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (fallback.length >= 100) {
      md = "## Page text (raw extraction, link-preview bot " + page.botName + ")\n" + fallback;
    }
  }
  // Prepend structured facts so specs / prices / OG metadata survive
  const parts = [schemaMd, hydrationMd, md].filter(Boolean);
  const combined = parts.length > 0 ? parts.join("\n\n") : "";

  // Strip residual WAF boilerplate from the bot response (defense in
  // depth — some WAFs serve a challenge page with a 200 status to
  // whitelisted bots that they didn't fully recognize).
  const cleaned = stripWafChallengeText(combined);
  if (!hasMeaningfulContent(cleaned)) return null;

  return {
    tier: "direct",
    markdown:
      "## Link-preview bot response (" + page.botName + ")\n" + cleaned,
    status: page.status,
    blocked: false,
    blockedReason: "",
    mode: structOut.mode,
    tableCount: structOut.tableCount,
    codeBlockCount: structOut.codeBlockCount,
  };
}
async function extractJina(url: string): Promise<TierOutput | null> {
  return jinaLimit(async () => {
    const jinaUrl = "https://r.jina.ai/" + encodeURI(url);
    const page = await fetchPage(jinaUrl, {
      timeoutMs: JINA_TIMEOUT_MS,
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
  });
}

/**
 * Tier 3: Wayback Machine snapshot — archive.org's availability API +
 * CDX server. Used for hard-blocked / dead / paywalled URLs where no
 * other tier worked.
 */
async function extractWayback(url: string): Promise<TierOutput | null> {
  // 1. Availability API — returns the closest snapshot
  const availRes = await fetchUrl(
    "https://archive.org/wayback/available?url=" +
      encodeURIComponent(url),
    { timeoutMs: WAYBACK_TIMEOUT_MS },
  );
  let snapshotUrl: string | null = null;
  if (availRes && availRes.ok) {
    try {
      const data: any = JSON.parse(availRes.text);
      const snap = data?.archived_snapshots?.closest?.url;
      if (snap) snapshotUrl = snap;
    } catch {
      /* malformed */
    }
  }
  // 2. CDX fallback — the closest snapshot by timestamp
  if (!snapshotUrl) {
    const cdxRes = await fetchUrl(
      "https://web.archive.org/cdx/search/cdx?url=" +
        encodeURIComponent(url) +
        "&limit=1&output=json&fl=original,timestamp,statuscode&from=2020",
      { timeoutMs: WAYBACK_TIMEOUT_MS },
    );
    if (cdxRes && cdxRes.ok) {
      try {
        const rows: any[] = JSON.parse(cdxRes.text);
        const row = rows.find((r) => r?.[2]?.startsWith("200"));
        if (row?.[0] && row?.[1]) {
          snapshotUrl = "https://web.archive.org/web/" + row[1] + "/" + row[0];
        }
      } catch {
        /* malformed */
      }
    }
  }
  if (!snapshotUrl) return null;

  // 3. Fetch the snapshot HTML and extract it
  const page = await fetchPage(snapshotUrl, { timeoutMs: WAYBACK_TIMEOUT_MS });
  if (!page || !page.ok || page.body.length < 200) return null;
  const block = detectBlockInText(page.body);
  if (block.blocked) return null;
  const structOut = await structuralExtractAsync(page.body, page.contentType, snapshotUrl);
  const md = structOut.markdown;
  if (md.length < 100) return null;
  return {
    tier: "wayback",
    markdown: "## Wayback Machine snapshot of " + url + "\n" + md,
    status: page.status,
    blocked: false,
    blockedReason: "",
    mode: structOut.mode,
    tableCount: structOut.tableCount,
    codeBlockCount: structOut.codeBlockCount,
  };
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
    const cachedTier = cached.tier as string;
    packet.extraction =
      cachedTier === "jina" ? "jina-fallback" : "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      // No truncation: the cache stores the full extracted document.
      // The reranker's 2,000-char chunks handle the budget — trimming
      // 12,000 chars here would silently drop tail content (PDF
      // conclusions, long pricing tables, final pages of papers).
      passageText: cached.extracted,
      bm25Score: 0,
    });
    const classification =
      cachedTier === "jina"
        ? "SUCCESS_JINA_FALLBACK"
        : cachedTier === "adapter"
          ? "SUCCESS_ADAPTER"
          : cachedTier === "wayback"
            ? "SUCCESS_WAYBACK"
            : cachedTier === "metadata"
              ? "SUCCESS_METADATA"
              : "SUCCESS_DIRECT";
    return { ...packet, classification };
  }

  // Tier 1.5: domain adapter first (cheapest for known hosts)
  const adapterOut = await extractAdapter(url);
  if (adapterOut && adapterOut.markdown.length >= 200) {
    packet.extraction = "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: adapterOut.markdown,
      bm25Score: 0,
    });
    putCachedPage(url, adapterOut.markdown, "adapter");
    return { ...packet, classification: "SUCCESS_ADAPTER" };
  }

  // Tier 1: direct fetch with fingerprint rotation on block (rotation
  // happens INSIDE fetchPage — the caller only fires Tier 1 once; a
  // second caller-level fingerprint retry would re-fetch the clean HTML
  // that the first already recovered under, and waste the Jina budget
  // on a follow-up that never ran).
  const directOut = await extractDirect(url, "chrome");

  if (directOut && !directOut.blocked && directOut.markdown.length >= 200) {
    packet.extraction = "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: directOut.markdown,
      bm25Score: 0,
    });
    putCachedPage(url, directOut.markdown, "direct");
    return { ...packet, classification: "SUCCESS_DIRECT" };
  }

  // If Tier 1 produced only metadata (product JSON-LD, hydration state,
  // document mode), classify as SUCCESS_METADATA even when the DOM text
  // was thin.
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
      passageText: directOut.markdown,
      bm25Score: 0,
    });
    putCachedPage(url, directOut.markdown, "metadata");
    return { ...packet, classification: "SUCCESS_METADATA" };
  }

  // Tier 2: social link-preview crawler bypass — fires when Tier 1 was
  // blocked or empty (WAF 403/503 / JS shell). Whitelisted bot UAs often
  // get a clean 200 where the browser fingerprint got a challenge page.
  const tier1BlockedOrEmpty =
    (directOut?.blocked ?? false) ||
    (directOut?.status === 0) ||
    (directOut?.markdown.length < 200 && directOut?.tier === "crash");

  let linkPreviewOut: TierOutput | null = null;
  if (tier1BlockedOrEmpty) {
    linkPreviewOut = await extractLinkPreview(url);
    if (linkPreviewOut && linkPreviewOut.markdown.length >= 200) {
      packet.extraction = "direct";
      packet.passages.push({
        sourceId: "",
        url,
        title: result.title,
        domain: result.domain,
        publishedAt: result.publishedDate,
        passageText: linkPreviewOut.markdown,
        bm25Score: 0,
      });
      putCachedPage(url, linkPreviewOut.markdown, "direct");
      return { ...packet, classification: "SUCCESS_DIRECT" };
    }
  }

  // Tier 4: Jina fallback — fires on any Tier 1/2 failure including
  // silent blocks (which is its whole point for Cloudflare-protected pages).
  const jinaOut = await extractJina(url);
  if (jinaOut && jinaOut.markdown.length >= 200) {
    packet.extraction = "jina-fallback";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: jinaOut.markdown,
      bm25Score: 0,
    });
    putCachedPage(url, jinaOut.markdown, "jina");
    return { ...packet, classification: "SUCCESS_JINA_FALLBACK" };
  }

  // Tier 3: Wayback Machine snapshot — fires when Jina also failed AND
  // (a) the original fetch was a hard block / network error, OR
  // (b) Tier 1 produced an empty JS shell (sparse content). This is the
  // last network-based recovery before the snippet tier: archive.org's
  // CDX index covers even SPA sites whose live page returns an empty
  // shell to our fetcher.
  const tier1Failed =
    directOut &&
    (directOut.blocked ||
      directOut.status === 0 ||
      (directOut.markdown.length < 100 && directOut.tier === "crash"));
  if (tier1Failed) {
    const waybackOut = await extractWayback(url);
    if (waybackOut && waybackOut.markdown.length >= 200) {
      packet.extraction = "jina-fallback";
      packet.passages.push({
        sourceId: "",
        url,
        title: result.title,
        domain: result.domain,
        publishedAt: result.publishedDate,
        passageText: waybackOut.markdown,
        bm25Score: 0,
      });
      putCachedPage(url, waybackOut.markdown, "wayback");
      return { ...packet, classification: "SUCCESS_WAYBACK" };
    }
  }

  // Tier 4: snippet preservation — the metasearch snippet becomes the
  // passage. If the snippet is empty (a corpus URL with no pre-indexed
  // search result), the title is used as a minimal evidence stub so the
  // pipeline still has SOMETHING for the BM25 reranker.
  packet.extraction = "snippet-only";
  const snippet = result.snippet || result.title || "";

  // Tier 6: deep URL-slug metasearch triangulation.
  // Guaranteed zero-block fallback: parse the target URL into slug
  // keywords and run a site: scoped metasearch. Titles + snippets from
  // every matching result are synthesized into a clean evidence block.
  // Fires when the URL has no pre-indexed snippet (stress-test case)
  // AND Tier 1 was blocked/empty — converts FAIL_SILENT_BOT_BLOCK and
  // FAIL_EMPTY_JS_SHELL rows into SUCCESS_SNIPPET_FALLBACK.
  const directBlocked = directOut?.blocked ?? false;
  const directEmptyShell =
    !directBlocked &&
    directOut != null &&
    directOut.tier === "crash";

  if ((directBlocked || directEmptyShell || linkPreviewOut === null) && (result.snippet ?? "").length < 20) {
    try {
      // Tier 6a: slug triangulation (site: + broad keyword queries)
      const synthesized = await slugTriangulation(url, result.title);
      if (synthesized.length >= 80) {
        const cleaned = stripWafChallengeText(synthesized);
        if (hasMeaningfulContent(cleaned, 40)) {
          packet.passages.push({
            sourceId: "",
            url,
            title: result.title || "(triangulated)",
            domain: result.domain,
            publishedAt: result.publishedDate,
            passageText: cleaned,
            bm25Score: 0,
          });
          return { ...packet, classification: "SUCCESS_SNIPPET_FALLBACK" };
        }
      }
      // Tier 6b: exact-URL search fallback (search engines that index
      // the literal URL string — a broader net than slug keywords alone)
      const fallbackResults = await urlSearchFallback(url, result.title);
      if (fallbackResults.length > 0) {
        const best = fallbackResults[0];
        const fbSnippet = (best.snippet || best.title || "").slice(0, 12000);
        if (fbSnippet.length >= 20) {
          const cleaned = stripWafChallengeText(fbSnippet);
          if (hasMeaningfulContent(cleaned, 40)) {
            packet.passages.push({
              sourceId: "",
              url,
              title: best.title || result.title,
              domain: best.domain || result.domain,
              publishedAt: best.publishedDate,
              passageText: cleaned,
              bm25Score: 0,
            });
            return { ...packet, classification: "SUCCESS_SNIPPET_FALLBACK" };
          }
        }
      }
    } catch {
      /* triangulation network failure — fall through to Tier 4 */
    }
  }

  // Classify the Tier 4 result: if Tier 1 hit a real block, this is a
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
      passageText:
        snippet.length >= 20 ? snippet : result.title || "(blocked page)",
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
      passageText:
        result.title || "(empty page — JS shell, no content extracted)",
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
