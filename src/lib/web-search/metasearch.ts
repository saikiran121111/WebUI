/**
 * Zero-API parallel discovery across multiple free sources.
 *
 * General Web Index Pool (always included for every intent):
 *   DDG HTML POST (3-stage) → Yahoo (Bing) → Startpage (Google)
 *   → Brave → AOL (Bing) → Mojeek → SearXNG (HTML) → Reddit (JSON)
 *
 * Vertical sources (gated by intent + lexical overlap):
 *   Wikipedia → HackerNews → arXiv → StackExchange
 *
 * Results are URL-normalized, deduplicated, and fused with
 * source-weighted Reciprocal Rank Fusion:
 *   general-web 1.2× · reddit 1.0× · vertical 0.65×
 *   RRF(d) = Σ_e 1/(60 + rank_e(d)) × weight(engine)
 *
 * Vertical sources are additionally gated: any Wikipedia / HN / arXiv /
 * StackExchange result whose title + snippet matches < 50% of the
 * query's core non-stopword tokens is DROPPED before fusion, so a
 * fuzzy "Manikonda Chalapathi Rau → Lucknow" match can never poison
 * the evidence bundle.
 */
import pLimit from "p-limit";
import { parseHTML } from "linkedom";
import type { RawSearchResult, RankedResult, LfmDecision } from "./types";
export type { RankedResult, RawSearchResult } from "./types";
import { fetchUrl, fetchPage, isSafeUrl, realisticHeaders, apiHeaders } from "./tls-client";
import {
  ddgSearch,
  yahooSearch,
  startpageSearch,
  braveSearch,
  aolSearch,
  mojeekSearch,
  searxSearch,
  redditSearch,
  runGeneralWebSearch,
} from "./general-pool";
import { childLogger } from "@/lib/server/logger";

const log = childLogger("web-search/metasearch");

// Give all metasearch fetchers up to 40 seconds per request. Slow high-
// value engines (arXiv, SearXNG) are never cut off just because a faster
// engine returned first — Promise.allSettled waits for ALL engines.
const ENGINE_TIMEOUT_MS = 40_000;
// One automatic retry with 2s backoff on 429/503 (transient rate-limit).
const RETRY_BACKOFF_MS = 2000;

/* ── engine concurrency ─────────────────────────────────────────────────── */

// General-web engines are paced per-host by general-pool.ts (one in-flight
// per host, 250–450ms jitter). The global limit here bounds the total
// number of engine calls that can run in parallel across ALL sub-queries.
//
// Default is 8 (production: ≤5 LFM plans × a few sources each). The
// INSANE stress runner sets WEB_SEARCH_ENGINE_CONCURRENCY to match its
// worker pool so every worker can fan out in parallel.
const ENGINE_CONCURRENCY = Math.max(
  8,
  parseInt(process.env.WEB_SEARCH_ENGINE_CONCURRENCY ?? "8", 10),
);
const limit = pLimit(ENGINE_CONCURRENCY);

/**
 * linkedom returns a Window (global), not a bare Document. Pull the DOM
 * document off it so querySelectorAll works.
 */
function docOf(html: string): any {
  const w: any = parseHTML(html);
  return w?.document ?? w;
}

/* ── URL normalization ─────────────────────────────────────────────────────── */

const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term",
  "fbclid", "gclid", "ref",
];

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    const p = new URLSearchParams(u.search);
    for (const k of TRACKING_PARAMS) p.delete(k);
    const q = p.toString();
    u.search = q ? "?" + q : "";
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    u.hostname = host;
    let path = u.pathname;
    if (path.length > 1) path = path.replace(/\/+$/, "");
    if (path === "") path = "/";
    u.pathname = path;
    return u.toString();
  } catch {
    return raw;
  }
}

/* ── vertical source fetchers (gated by intent + lexical overlap) ──────── */

/**
 * Core non-stopword tokens from the query, used for the vertical-source
 * lexical gate. A Wikipedia/HN/arXiv result must contain at least 50%
 * of these tokens in its title + snippet to survive fusion.
 *
 * This gate is QUERY-AGNOSTIC — it works for any domain (restaurants,
 * jobs, products, tech, travel, legal, etc.) because it only asks
 * "does this result actually mention the specific entities the user
 * asked about?" rather than hardcoding topic-specific rules.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "can", "may", "might", "shall", "may", "must",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
  "us", "them", "my", "your", "his", "its", "our", "their",
  "this", "that", "these", "those", "here", "there", "where", "when",
  "what", "which", "who", "whom", "whose", "how", "why",
  "and", "or", "but", "if", "then", "else", "so", "yet", "also",
  "very", "really", "just", "quite", "rather", "too", "only",
  "please", "tell", "want", "need", "look", "find", "get", "show",
  "best", "good", "top", "great", "nice", "awesome", "amazing",
  "in", "on", "at", "by", "for", "from", "to", "of", "with", "without",
  "about", "into", "onto", "over", "under", "near", "around",
  "me", "i", "my", "im", "ill", "ive", "dont", "cant", "wont",
  "so", "i", "you", "your",
]);

export function queryCoreTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Return true when `text` contains at least 50% of the query's core
 * tokens. Used as a gate on vertical (Wikipedia/HN/arXiv/StackExchange)
 * results so a fuzzy token match like "Manikonda Chalapathi Rau →
 * Lucknow" is dropped before it can poison the RRF fusion.
 */
export function meetsLexicalThreshold(text: string, coreTokens: string[]): boolean {
  if (coreTokens.length === 0) return true;
  const lower = text.toLowerCase();
  const hits = coreTokens.filter((t) => lower.includes(t)).length;
  return hits / coreTokens.length >= 0.5;
}

async function fetchUrlWithRetry(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<Awaited<ReturnType<typeof fetchUrl>>> {
  const res = await fetchUrl(url, { timeoutMs: ENGINE_TIMEOUT_MS, ...opts });
  if (res && (res.status === 429 || res.status === 503)) {
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    return fetchUrl(url, { timeoutMs: ENGINE_TIMEOUT_MS, ...opts });
  }
  return res;
}

async function wikipediaSearch(query: string): Promise<RawSearchResult[]> {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json" +
    "&srprop=snippet&srlimit=5&srsearch=" +
    encodeURIComponent(query);
  const res = await fetchUrlWithRetry(url, { headers: { accept: "application/json" } });
  if (!res || !res.ok) return [];
  try {
    const data: any = JSON.parse(res.text);
    const core = queryCoreTokens(query);
    return (data?.query?.search ?? [])
      .filter((s: any) => meetsLexicalThreshold(s.title + " " + s.snippet, core))
      .map(
        (s: any, i: number): RawSearchResult => ({
          title: s.title,
          url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(s.title.replace(/ /g, "_")),
          snippet: s.snippet?.replace(/<[^>]+>/g, "") ?? "",
          engine: "wikipedia",
          rank: i + 1,
        }),
      );
  } catch {
    return [];
  }
}

async function hackerNewsSearch(query: string): Promise<RawSearchResult[]> {
  const url =
    "https://hn.algolia.com/api/v1/search?query=" +
    encodeURIComponent(query) +
    "&hitsPerPage=5";
  const res = await fetchUrlWithRetry(url, { headers: { accept: "application/json" } });
  if (!res || !res.ok) return [];
  try {
    const data: any = JSON.parse(res.text);
    const core = queryCoreTokens(query);
    return (data?.hits ?? [])
      .filter((h: any) => meetsLexicalThreshold((h.title ?? "") + " " + (h.story_text ?? ""), core))
      .map(
        (h: any, i: number): RawSearchResult => ({
          title: h.title ?? h.story_text?.slice(0, 100) ?? "HN discussion",
          url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
          snippet: (h.comment_text ?? h.story_text ?? "").slice(0, 300),
          engine: "hackernews",
          publishedDate: h.created_at,
          rank: i + 1,
        }),
      );
  } catch {
    return [];
  }
}

async function arxivSearch(query: string): Promise<RawSearchResult[]> {
  const url =
    "http://export.arxiv.org/api/query?search_query=all:" +
    encodeURIComponent(query) +
    "&max_results=5";
  const res = await fetchUrlWithRetry(url, { headers: { accept: "application/xml" } });
  if (!res || !res.ok) return [];
  const doc = docOf(res.text);
  const out: RawSearchResult[] = [];
  const entries: any[] = doc.querySelectorAll("entry");
  const core = queryCoreTokens(query);
  for (const entry of entries) {
    const title =
      entry.querySelector("title")?.textContent?.trim().replace(/\s+/g, " ") ?? "";
    const link =
      entry.querySelector("link[@rel='alternate']")?.getAttribute("href") ?? "";
    const summary = entry.querySelector("summary")?.textContent?.trim() ?? "";
    if (!meetsLexicalThreshold(title + " " + summary, core)) continue;
    out.push({
      title,
      url: link,
      snippet: summary.slice(0, 400),
      engine: "arxiv",
      publishedDate: entry.querySelector("published")?.textContent?.trim() || undefined,
      rank: out.length + 1,
    });
  }
  return out;
}

async function stackExchangeSearch(query: string): Promise<RawSearchResult[]> {
  const url =
    "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance" +
    "&q=" +
    encodeURIComponent(query) +
    "&site=stackoverflow&pagesize=5";
  const res = await fetchUrl(url, { timeoutMs: ENGINE_TIMEOUT_MS });
  if (!res || !res.ok) return [];
  try {
    const data: any = JSON.parse(res.text);
    const core = queryCoreTokens(query);
    return (data?.items ?? [])
      .filter((item: any) => meetsLexicalThreshold(item.title, core))
      .map(
        (item: any, i: number): RawSearchResult => ({
          title: item.title,
          url: item.link,
          snippet: item.title,
          engine: "stackexchange",
          publishedDate: item.creation_date ? new Date(item.creation_date * 1000).toISOString() : undefined,
          rank: i + 1,
        }),
      );
  } catch {
    return [];
  }
}

/* ── source pool selection by intent ────────────────────────────────────── */

type Intent = "general" | "news" | "docs" | "code" | "academic" | "forum";

type SourceFn = (query: string) => Promise<RawSearchResult[]>;

/**
 * Engines whose results are gated by the lexical threshold (vertical
 * APIs that do fuzzy token matching). General-web engines are NOT gated
 * — they are already ranked by the search engine's own relevance model.
 */
const VERTICAL_ENGINES = new Set(["wikipedia", "hackernews", "arxiv", "stackexchange"]);

function poolFor(intent: Intent): SourceFn[] {
  // General-web engines are ALWAYS in the pool (the universal backbone).
  // Vertical engines are added based on intent.
  const general: SourceFn[] = [
    ddgSearch,
    yahooSearch,
    startpageSearch,
    braveSearch,
    aolSearch,
    mojeekSearch,
    searxSearch,
    redditSearch,
  ];

  switch (intent) {
    case "code":
      return [...general, stackExchangeSearch];
    case "academic":
      return [...general, arxivSearch, wikipediaSearch];
    case "forum":
      return [...general, hackerNewsSearch];
    case "news":
      return [...general];
    case "docs":
      return [...general, stackExchangeSearch, wikipediaSearch];
    default:
      // "general": all general-web engines + Reddit (already in general)
      // + Wikipedia (only when lexical gate passes)
      return [...general, wikipediaSearch];
  }
}

/**
 * Run a single query against its source pool in parallel and return the
 * merged raw result list (ranks are per-source; fusion happens later).
 *
 * Per-engine pacing (250–450ms jitter, one in-flight per host) is
 * handled by general-pool.ts enginePacer() for all general-web engines.
 */
async function searchOne(query: string, intent: Intent): Promise<RawSearchResult[]> {
  const pool = poolFor(intent);
  const settled = await Promise.allSettled(
    pool.map((fn) => limit(() => fn(query))),
  );
  const out: RawSearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  return out;
}

/* ── Source-weighted Reciprocal Rank Fusion ─────────────────────────────── */

const RRF_K = 60;
const PREFERRED_BOOST = 0.015;

/**
 * Per-engine weights for the RRF fusion:
 *   - General-web indexers (DDG, Yahoo, Startpage, Brave, AOL, Mojeek,
 *     SearXNG) get 1.2× — they are ranked by the engine's own relevance
 *     model and are the highest-signal source for most queries.
 *   - Reddit gets 1.0× — community ground-truth for local places, jobs,
 *     products, and troubleshooting.
 *   - Vertical/encyclopedia APIs (Wikipedia, HN, arXiv, StackExchange)
 *     get 0.65× unless the query intent is explicitly academic/docs —
 *     their fuzzy token matching can surface irrelevant encyclopedia
 *     pages (e.g. "Manikonda Chalapathi Rau → Lucknow" for a biryani
 *     query) that would otherwise poison the evidence bundle.
 */
function engineWeight(engine: string, intent: Intent): number {
  if (engine === "reddit") return 1.0;
  if (VERTICAL_ENGINES.has(engine)) {
    // Boost verticals only when the intent is explicitly academic/docs
    if (intent === "academic" || intent === "docs") return 1.0;
    return 0.65;
  }
  // All general-web indexers
  return 1.2;
}

export function reciprocalRankFuse(
  rawResults: RawSearchResult[],
  preferredDomains?: string[],
  intent: Intent = "general",
): RankedResult[] {
  // key = normalized URL, value = best raw + per-engine rank map
  const byUrl = new Map<
    string,
    { result: RawSearchResult; ranks: Map<string, number> }
  >();

  for (const r of rawResults) {
    let norm: string;
    try {
      norm = normalizeUrl(r.url);
    } catch {
      continue;
    }
    if (!norm || !isSafeUrl(norm)) continue;

    const entry = byUrl.get(norm);
    if (!entry) {
      byUrl.set(norm, { result: { ...r, url: norm }, ranks: new Map() });
    }
    const e = byUrl.get(norm)!;
    e.ranks.set(r.engine, e.ranks.get(r.engine) ?? r.rank);
    // Prefer a non-empty snippet from any engine
    if (r.snippet && !e.result.snippet) e.result.snippet = r.snippet;
    if (r.title && !e.result.title) e.result.title = r.title;
  }

  const preferred = new Set(
    (preferredDomains ?? []).map((d) =>
      d.toLowerCase().replace(/^www\./, "").split("/")[0],
    ),
  );

  const out: RankedResult[] = [];
  for (const [canonical, { result, ranks }] of byUrl) {
    let score = 0;
    for (const [engine, rank] of ranks.entries()) {
      // Source-weighted RRF: general-web 1.2×, Reddit 1.0×, vertical 0.65×
      score += (engineWeight(engine, intent) / (RRF_K + rank));
    }

    let domain = "";
    try {
      domain = new URL(canonical).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      domain = "";
    }
    // Match by host or any parent domain in preferred list
    if ([domain, ...domain.split(".").slice(1)].some((d) => preferred.has(d))) {
      score += PREFERRED_BOOST;
    }

    out.push({
      ...result,
      url: canonical,
      canonical,
      domain,
      rrf: score,
      engines: [...ranks.keys()],
      engineRanks: Object.fromEntries(ranks),
    });
  }

  out.sort((a, b) => b.rrf - a.rrf);
  return out;
}

/* ── public API ─────────────────────────────────────────────────────────── */

export interface SearchPlan {
  query: string;
  intent: Intent;
  preferredDomains?: string[];
  /**
   * Freshness filter: "any" (no time filter), "day", "week", "month",
   * "year". Passed to the search engines as tf= / df= params where
   * supported. A non-"any" freshness that returns < 5 results triggers
   * an automatic re-run with "any" (see metasearchWithFreshnessRecovery).
   */
  freshness?: "none" | "day" | "week" | "month" | "year" | "any";
}

/**
 * Run all plans in parallel against the full source pool. Each plan is
 * answered by ALL engines in its pool (general-web always, verticals by
 * intent), with per-engine pacing so 4 sub-queries never fire 32
 * simultaneous requests at any single host.
 *
 * Returns the top N unique URLs after source-weighted RRF fusion.
 */
export async function metasearch(
  plans: SearchPlan[],
  maxResults = 20,
): Promise<RankedResult[]> {
  const rawLists = await Promise.all(
    plans.map((p) => searchOne(p.query, p.intent).catch(() => [] as RawSearchResult[])),
  );
  const flat = rawLists.flat();
  const preferred = plans.flatMap((p) => p.preferredDomains ?? []);
  // Use the first plan's intent for the weight table (all plans in one
  // call share the same LFM decision, so they all have the same intent).
  const intent = plans[0]?.intent ?? "general";
  const ranked = reciprocalRankFuse(flat, preferred, intent);
  return ranked.slice(0, maxResults);
}

/**
 * Freshness filter trap recovery: if the LFM gate applied a time filter
 * (freshness !== "any") and the first pass returned fewer than 5 results,
 * automatically re-run the same plans with freshness "any" — a 30-day
 * filter on an evergreen/local/product query drops 99% of relevant pages.
 */
export async function metasearchWithFreshnessRecovery(
  plans: SearchPlan[],
  maxResults = 20,
): Promise<{ results: RankedResult[]; freshnessRecoveryUsed: boolean }> {
  const anyPlan = plans.every((p) => !p.freshness || p.freshness === "any");
  const firstPass = await metasearch(plans, maxResults);

  if (!anyPlan && firstPass.length < 5) {
    log.info(
      { initial: firstPass.length, freshness: plans[0]?.freshness },
      "freshness filter returned <5 results — re-running with freshness='any'",
    );
    const cleared = plans.map((p) => ({ ...p, freshness: "any" as const }));
    const secondPass = await metasearch(cleared, maxResults);
    if (secondPass.length > firstPass.length) {
      return { results: secondPass, freshnessRecoveryUsed: true };
    }
  }

  return { results: firstPass, freshnessRecoveryUsed: false };
}

/**
 * Same as metasearch but with an absolute wall-clock deadline. If the
 * Promise.all runs long (very slow source), still fuse whatever came back —
 * a partial set is better than none, and extraction gets the rest of the
 * budget.
 */
export async function metasearchWithBudget(
  plans: SearchPlan[],
  maxResults: number,
  budgetMs: number,
): Promise<RankedResult[]> {
  const t0 = Date.now();
  const results = await metasearch(plans, maxResults);
  const elapsed = Date.now() - t0;
  if (elapsed > budgetMs + 5000) {
    console.warn(
      `[metasearch] wall-clock budget (${budgetMs}ms) exceeded by ${elapsed - budgetMs}ms; ${results.length} results returned`,
    );
  }
  return results;
}

/**
 * URL-targeted search fallback: when a specific URL in the user's prompt
 * or a search result points to a hard-blocked / auth-walled page, harvest
 * the aggregated snippets for that exact URL across the DDG / Brave / SearX
 * source pool so the LLM still receives verified facts from OTHER engines
 * that DID index it.
 *
 * The returned `RankedResult[]` is fused from all engines that returned a
 * snippet for the target URL — this is the "verified snippet fallback"
 * path for Tier 3 (SUCCESS_SNIPPET_FALLBACK).
 */
export async function urlSearchFallback(
  targetUrl: string,
  title?: string,
): Promise<RankedResult[]> {
  const titlePrefix = title && title !== targetUrl && title.length > 0 ? title + " " : "";
  const query = titlePrefix + targetUrl;

  const raw: RawSearchResult[] = [];

  const ddg = await searchOne(query, "general");
  raw.push(...ddg);

  const searx = await searxSearch(query).catch(() => [] as RawSearchResult[]);
  raw.push(...searx);

  let targetHost = "";
  let targetPath = "";
  try {
    const tu = new URL(targetUrl);
    targetHost = tu.hostname.toLowerCase().replace(/^www\./, "");
    targetPath = tu.pathname.replace(/\/+$/, "");
  } catch { /* keep empty */ }

  const matching = raw.filter((r) => {
    let rHost = "";
    let rPath = "";
    try {
      const ru = new URL(r.url);
      rHost = ru.hostname.toLowerCase().replace(/^www\./, "");
      rPath = ru.pathname.replace(/\/+$/, "");
    } catch {
      return false;
    }
    if (rHost !== targetHost) return false;
    if (targetPath && rPath && targetPath !== rPath) return false;
    return true;
  });

  return matching.map((r, i) => ({
    ...r,
    url: targetUrl,
    canonical: normalizeUrl(targetUrl),
    domain: targetHost,
    rrf: 1 / (RRF_K + i + 1),
    engines: [r.engine],
    engineRanks: { [r.engine]: i + 1 },
  }));
}

/**
 * Tier 6 — deep URL-slug metasearch triangulation.
 *
 * The guaranteed zero-block fallback: when Tiers 1–5 (direct, browser
 * rotation, link-preview bots, platform JSON, Jina, Wayback) all fail on
 * a hard WAF, parse the target URL into meaningful slug keywords and run
 * a `site:`-scoped metasearch across all engines. Titles + snippets +
 * metadata from every matching result are synthesized into a single
 * "[Synthesized Web Index Evidence]" block that the caller returns as
 * SUCCESS_SNIPPET_FALLBACK instead of FAIL_SILENT_BOT_BLOCK.
 *
 * Examples:
 *   https://www.airbnb.com/rooms/12345
 *     → site:airbnb.com "12345"  +  "airbnb" "rooms" "12345"
 *   https://github.com/nicksix/fd
 *     → site:github.com "nicksix" "fd"
 *
 * Returns a markdown synthesis string ("" when nothing useful found).
 */
export async function slugTriangulation(
  targetUrl: string,
  title?: string,
): Promise<string> {
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return "";
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  const slugTokens = u.pathname
    .split("/")
    .filter((s) => s.length > 2 && !/^\d+$/.test(s))
    .map((s) => s.replace(/[-_]/g, " ").trim())
    .filter((s) => s.length > 2)
    .slice(0, 4);

  const siteQuery = `site:${host} ${slugTokens.map((t) => `"${t}"`).join(" ") || "*"}`;
  const broadQuery = `"${host.replace(/\.\w+$/, "")}" ${slugTokens.join(" ")}`;

  const [siteResults, broadResults] = await Promise.all([
    searchOne(siteQuery, "general"),
    searchOne(broadQuery, "general"),
  ]);

  const seen = new Set<string>();
  const all = [...siteResults, ...broadResults].filter((r) => {
    let norm = "";
    try { norm = normalizeUrl(r.url); } catch { return false; }
    if (seen.has(norm)) return false;
    seen.add(norm);
    return (r.snippet ?? "").length >= 20 || (r.title ?? "").length >= 20;
  });

  if (all.length === 0) return "";

  const lines: string[] = [
    "[Synthesized Web Index Evidence] for " + targetUrl,
    title ? "Page title (from metasearch): " + title : "",
    "",
  ].filter(Boolean);

  for (const r of all.slice(0, 8)) {
    lines.push(`- [${r.engine}] ${r.title || "(untitled)"}`);
    lines.push(`  URL: ${r.url}`);
    if (r.snippet?.length) lines.push(`  Snippet: ${r.snippet.slice(0, 400)}`);
    lines.push("");
  }

  return lines.join("\n");
}
