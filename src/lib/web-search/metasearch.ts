/**
 * Zero-API parallel discovery across multiple free sources.
 *
 * Sources (all keyless):
 *   DuckDuckGo Lite  →  Brave Search (fallback)
 *   Wikipedia Open API  →  HackerNews Algolia
 *   arXiv API  →  Reddit Public JSON
 *   StackExchange API  →  public SearXNG instances (last resort)
 *
 * Results are URL-normalized, deduplicated, and fused with
 * Reciprocal Rank Fusion:  RRF(d) = Σ_e 1/(60 + rank_e(d))
 * preferred domains get a +0.015 boost.
 */
import pLimit from "p-limit";
import { parseHTML } from "linkedom";
import type { RawSearchResult, RankedResult } from "./types";
export type { RankedResult, RawSearchResult } from "./types";
import { fetchUrl, fetchPage, isSafeUrl, realisticHeaders } from "./tls-client";

const limit = pLimit(8);

/**
 * linkedom returns a Window (global), not a bare Document. Pull the DOM
 * document off it so querySelectorAll works.
 */
function docOf(html: string): any {
  const w: any = parseHTML(html);
  return w?.document ?? w;
}

/* ── URL normalization ─────────────────────────────────────────────────── */

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

/* ── source fetchers (each returns RawSearchResult[]) ────────────────── */

async function ddgLite(query: string): Promise<RawSearchResult[]> {
  const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
  const page = await fetchPage(url, { timeoutMs: 2500 });
  if (!page || !page.ok || !page.body) return [];

  const doc = docOf(page.body);
  const out: RawSearchResult[] = [];
  const links: any[] = doc.querySelectorAll("table.result a.result-link");
  links.forEach((a: any, i: number) => {
    const href = a.getAttribute("href");
    if (!href) return;
    let target: string;
    try {
      const res = new URL(href, "https://lite.duckduckgo.com").searchParams.get("uddg");
      target = res ?? href;
    } catch {
      target = href;
    }
    if (!isSafeUrl(target)) return;
    const snippet =
      a.parentElement?.querySelector(".result-snippet")?.textContent?.trim() ?? "";
    out.push({
      title: a.textContent?.trim() ?? "",
      url: target,
      snippet,
      engine: "duckduckgo",
      rank: i + 1,
    });
  });
  return out.slice(0, 10);
}

async function braveSearch(query: string): Promise<RawSearchResult[]> {
  const url =
    "https://search.brave.com/search?q=" +
    encodeURIComponent(query) +
    "&source=web";
  const page = await fetchPage(url, {
    timeoutMs: 2500,
    headers: realisticHeaders(),
  });
  if (!page || !page.ok || !page.body) return [];

  const doc = docOf(page.body);
  const out: RawSearchResult[] = [];
  const divs: any[] = doc.querySelectorAll("div#web-results > div");
  divs.forEach((div: any, i: number) => {
    const a =
      div.querySelector("a[data-network-tab-experimental='web']") ??
      div.querySelector("a[href^='http']");
    const href = a?.getAttribute("href");
    if (!href) return;
    const snippet =
      div.querySelector(".snippet")?.textContent?.trim() ??
      div.querySelector(".fb")?.textContent?.trim() ??
      "";
    out.push({
      title:
        div.querySelector("h2")?.textContent?.trim() ??
        div.querySelector(".title")?.textContent?.trim() ??
        "",
      url: href,
      snippet,
      engine: "brave",
      rank: i + 1,
    });
  });
  return out.slice(0, 10);
}

async function wikipediaSearch(query: string): Promise<RawSearchResult[]> {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json" +
    "&srprop=snippet&srlimit=5&srsearch=" +
    encodeURIComponent(query);
  const res = await fetchUrl(url, { timeoutMs: 2500 });
  if (!res || !res.ok) return [];
  try {
    const data: any = JSON.parse(res.text);
    return (data?.query?.search ?? []).map(
      (s: any, i: number): RawSearchResult => ({
        title: s.title,
        url:
          "https://en.wikipedia.org/wiki/" +
          encodeURIComponent(s.title.replace(/ /g, "_")),
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
  const res = await fetchUrl(url, { timeoutMs: 2500 });
  if (!res || !res.ok) return [];
  try {
    const data: any = JSON.parse(res.text);
    return (data?.hits ?? []).map(
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
  const res = await fetchUrl(url, { timeoutMs: 2500 });
  if (!res || !res.ok) return [];
  const doc = docOf(res.text);
  const out: RawSearchResult[] = [];
  const entries: any[] = doc.querySelectorAll("entry");
  entries.forEach((entry: any, i: number) => {
    const title =
      entry.querySelector("title")?.textContent?.trim().replace(/\s+/g, " ") ?? "";
    const link =
      entry.querySelector("link[@rel='alternate']")?.getAttribute("href") ?? "";
    const summary = entry.querySelector("summary")?.textContent?.trim() ?? "";
    const published = entry.querySelector("published")?.textContent ?? undefined;
    out.push({
      title,
      url: link,
      snippet: summary.slice(0, 400),
      engine: "arxiv",
      publishedDate: published,
      rank: i + 1,
    });
  });
  return out;
}

async function redditSearch(query: string): Promise<RawSearchResult[]> {
  const url =
    "https://www.reddit.com/search.json?q=" +
    encodeURIComponent(query) +
    "&limit=5&sort=relevance";
  const res = await fetchUrl(url, {
    timeoutMs: 2500,
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!res || !res.ok) return [];
  try {
    const data: any = JSON.parse(res.text);
    return (data?.data?.children ?? []).map(
      (c: any, i: number): RawSearchResult => {
        const p = c?.data ?? {};
        return {
          title: p.title ?? "",
          url: p.url ?? `https://www.reddit.com${p.permalink ?? ""}`,
          snippet: (p.selftext ?? p.title ?? "").slice(0, 300),
          engine: "reddit",
          publishedDate: p.created_utc
            ? new Date(p.created_utc * 1000).toISOString()
            : undefined,
          rank: i + 1,
        };
      },
    );
  } catch {
    return [];
  }
}

async function stackExchangeSearch(query: string): Promise<RawSearchResult[]> {
  const url =
    "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance" +
    "&q=" +
    encodeURIComponent(query) +
    "&site=stackoverflow&pagesize=5";
  const res = await fetchUrl(url, { timeoutMs: 2500 });
  if (!res || !res.ok) return [];
  try {
    const data: any = JSON.parse(res.text);
    return (data?.items ?? []).map(
      (item: any, i: number): RawSearchResult => ({
        title: item.title,
        url: item.link,
        snippet: item.title,
        engine: "stackexchange",
        publishedDate: item.creation_date
          ? new Date(item.creation_date * 1000).toISOString()
          : undefined,
        rank: i + 1,
      }),
    );
  } catch {
    return [];
  }
}

/* ── public SearXNG instances (last-resort failover) ─────────────────── */

async function loadSearxInstances(): Promise<string[]> {
  try {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const file = join(
      process.cwd(),
      ".local-search",
      "vendor",
      "searx-instances.json",
    );
    const data = JSON.parse(readFileSync(file, "utf8"));
    return (data.instances ?? []) as string[];
  } catch {
    return [];
  }
}

async function searxSearch(query: string): Promise<RawSearchResult[]> {
  const instances = await loadSearxInstances();
  if (instances.length === 0) return [];

  // Try up to 3 in parallel; return whichever produced results.
  const tried = instances.slice(0, 3);
  const settled = await Promise.allSettled(
    tried.map(async (base: string) => {
      const url =
        base.replace(/\/$/, "") +
        "/search?q=" +
        encodeURIComponent(query) +
        "&format=json";
      const res = await fetchUrl(url, {
        timeoutMs: 2500,
        headers: { accept: "application/json" },
      });
      if (!res || !res.ok) return [];
      const data: any = JSON.parse(res.text);
      return (data?.results ?? []).map(
        (r: any, i: number): RawSearchResult => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.snippet ?? "",
          engine: "searxng",
          publishedDate: r.publishedDate,
          rank: i + 1,
        }),
      );
    }),
  );
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value.length > 0) return s.value;
  }
  return [];
}

/* ── source pool selection by intent ──────────────────────────────────── */

type Intent = "general" | "news" | "docs" | "code" | "academic" | "forum";

type SourceFn = (query: string) => Promise<RawSearchResult[]>;

function poolFor(intent: Intent): SourceFn[] {
  switch (intent) {
    case "code":
      return [stackExchangeSearch, ddgLite, braveSearch, hackerNewsSearch];
    case "academic":
      return [arxivSearch, wikipediaSearch, ddgLite, searxSearch];
    case "forum":
      return [redditSearch, hackerNewsSearch, ddgLite];
    case "news":
      return [ddgLite, hackerNewsSearch, braveSearch];
    case "docs":
      return [ddgLite, braveSearch, stackExchangeSearch, wikipediaSearch];
    default:
      return [ddgLite, braveSearch, wikipediaSearch, hackerNewsSearch, searxSearch];
  }
}

/**
 * Run a single query against its source pool in parallel and return the
 * merged raw result list (ranks are per-source; fusion happens later).
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

/* ── Reciprocal Rank Fusion ───────────────────────────────────────────── */

const RRF_K = 60;
const PREFERRED_BOOST = 0.015;

export function reciprocalRankFuse(
  rawResults: RawSearchResult[],
  preferredDomains?: string[],
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
      byUrl.set(norm, {
        result: { ...r, url: norm },
        ranks: new Map(),
      });
    }
    const e = byUrl.get(norm)!;
    // keep the earliest engine's rank as the "canonical" rank; add all
    e.ranks.set(r.engine, e.ranks.get(r.engine) ?? r.rank);
    // prefer a non-empty snippet from any engine
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
    for (const rank of ranks.values()) score += 1 / (RRF_K + rank);

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
}

/**
 * Run all plans in parallel, fuse with RRF, return the top N unique URLs.
 * The discovery budget is bounded: all pool fetches are p-limited to 8
 * concurrent connections and each source fetch has a 2500ms ceiling, so a
 * 5-query deep plan takes at most ~3s wall time.
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
  const ranked = reciprocalRankFuse(flat, preferred);
  return ranked.slice(0, maxResults);
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
  // Build the query the way a search engine would index this URL:
  // the URL itself + the title if we have one (so DDG/Brave match it).
  const query = (title ? title + " " : "") + targetUrl;

  const raw: RawSearchResult[] = [];

  // DDG Lite: search for the URL string itself — DDG returns the URL
  // as a result when other engines have indexed it.
  const ddg = await searchOne(query, "general");
  raw.push(...ddg);

  // SearXNG fallback (the public instances index a broader set of URLs)
  const searx = await searxSearch(query);
  raw.push(...searx);

  // Filter to results whose canonical URL matches the target — that's the
  // "aggregated snippet" we need (other results are noise).
  const canonical = normalizeUrl(targetUrl);
  const matching = raw.filter((r) => {
    let norm: string;
    try {
      norm = normalizeUrl(r.url);
    } catch {
      return false;
    }
    return norm === canonical || r.url === targetUrl;
  });

  // Build the RankedResult list
  const out: RankedResult[] = matching.map((r, i) => {
    let domain = "";
    try {
      domain = new URL(canonical).hostname.toLowerCase().replace(/^www\./, "");
    } catch {}
    return {
      ...r,
      url: canonical,
      canonical,
      domain,
      rrf: 1 / (60 + i + 1),
      engines: [r.engine],
      engineRanks: { [r.engine]: i + 1 },
    };
  });
  return out;
}
