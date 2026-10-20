/**
 * Universal general-web search engine pool.
 *
 * Each fetcher returns RawSearchResult[] for a single query string.
 * The pool is selected by intent (see poolForIntent in metasearch.ts).
 *
 * Engine backbones:
 *   - DDG HTML POST      → DuckDuckGo's own index (cookie-primed)
 *   - DDG lite POST      → fallback when html POST is anomaly-blocked
 *   - Yahoo              → Bing global web index (RU= redirect unwrap)
 *   - Startpage          → Google live web index (SSR HTML)
 *   - Brave              → Brave's own index (SSR HTML + __INITIAL_STATE__)
 *   - AOL                → Bing index (RU= redirect unwrap, same as Yahoo)
 *   - Mojeek             → independent UK web index
 *   - SearXNG            → aggregated multi-engine (HTML mode, dynamic instance)
 *   - Reddit             → old.reddit.com JSON (community ground-truth)
 *
 * All scrapers use impit Chrome TLS fingerprint via fetchPage/fetchUrl
 * from tls-client.ts. Each engine has a 40-second wall-clock ceiling.
 *
 * Per-engine pacing: one in-flight request per host, 250–450 ms jitter
 * between sub-queries, so 4 LFM sub-queries never fire 32 simultaneous
 * requests at any single search-engine host.
 */
import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawSearchResult } from "./types";
import {
  fetchPage,
  fetchUrl,
  realisticHeaders,
  apiHeaders,
  isSafeUrl,
  newCookieJar,
} from "./tls-client";
import { childLogger } from "@/lib/server/logger";

const log = childLogger("web-search/general-pool");

const ENGINE_TIMEOUT_MS = 40_000;
/** Priming request timeout (shorter — we only need the cookie). */
const PRIME_TIMEOUT_MS = 12_000;

/* ── per-engine pacing ───────────────────────────────────────────────────── */

/**
 * Per-engine concurrency limiter (concurrency=1) + 250–450 ms jitter.
 *
 * The jitter is applied BETWEEN consecutive calls to the same engine,
 * so sub-query 1 → DDG at t=0ms, sub-query 2 → DDG at t=350ms, etc.
 * This prevents the self-DDoS burst where 4 LFM sub-queries fire at
 * the same host at the exact same millisecond and get bot-flagged.
 */
const enginePacers = new Map<string, { limit: ReturnType<typeof pLimit>; lastCall: number }>();

async function enginePacer(engine: string): Promise<void> {
  const jitter = 250 + Math.floor(Math.random() * 200);
  let entry = enginePacers.get(engine);
  if (!entry) {
    const limit = pLimit(1);
    entry = { limit, lastCall: 0 };
    enginePacers.set(engine, entry);
  }
  const waitUntil = entry.lastCall + jitter;
  const now = Date.now();
  const delay = Math.max(0, waitUntil - now);
  entry.lastCall = now + delay;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  await entry.limit(() => {});
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function docOf(html: string): any {
  const w: any = parseHTML(html);
  return w?.document ?? w;
}

/** Decode /l/?uddg=<encoded> redirect URLs back to the target. */
function decodeUddg(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    const m = u.href.match(/uddg=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    return u.href;
  } catch {
    return href;
  }
}

/** Unwrap Yahoo/AOL RU=<encoded>/RK= redirect links. */
function unwrapRuHref(href: string, base: string): string {
  try {
    const u = new URL(href, base);
    const ru = u.searchParams.get("RU");
    if (ru) return decodeURIComponent(ru);
    const m = u.href.match(/RU=([^&/]+)(?:\/RK=|$)/);
    if (m) return decodeURIComponent(m[1]);
    return u.href;
  } catch {
    return href;
  }
}

/**
 * Detect CAPTCHA / challenge / anomaly blocks on a response body.
 * Returns true when the body is a challenge page (should return [] not parse it).
 */
function isBlocked(body: string): boolean {
  if (body.length < 500) return true;
  const head = body.slice(0, 3000);
  return (
    /verifyngo|challenge|anomaly|captcha|please enable javascript|not a robot/i.test(head)
  );
}

/* ── DuckDuckGo (3-stage) ────────────────────────────────────────────────── */

/**
 * DDG's anomaly detector flags requests that don't look like real browser
 * navigations. Two things matter:
 *   1. A session cookie from a prior GET to the same host (cookie priming).
 *   2. The header set must match a browser navigation (Accept: text/html,
 *      full sec-ch-ua triplet) — NOT Accept: application/json.
 *
 * Stage A: GET html.duckduckgo.com/html/ (priming) → POST with cookies
 * Stage B: GET lite.duckduckgo.com/lite/  (priming) → POST with cookies
 * Stage C: VQD token flow (GET duckduckgo.com → links.duckduckgo.com/d.js)
 */
async function ddgHtml(query: string): Promise<RawSearchResult[]> {
  const jar = newCookieJar();
  const host = "https://html.duckduckgo.com";

  // Priming request: sets session cookies. The 202/302 response body
  // doesn't matter — we only need the cookie jar populated.
  const prime = await fetchPage(host + "/html/", {
    timeoutMs: PRIME_TIMEOUT_MS,
    headers: realisticHeaders({ referer: host + "/" }),
  } as any);
  if (prime?.cookies?.length) jar.absorb(host + "/html/", prime.cookies);
  const cookieVal = jar.cookieFor(host + "/html/");

  // POST with session cookies + realistic browser-navigate headers.
  // useRealisticHeaders ensures Accept: text/html (not application/json),
  // which is what DDG's anomaly detector expects for a form submission.
  const res = await fetchUrl(host + "/html/", {
    timeoutMs: ENGINE_TIMEOUT_MS,
    method: "POST",
    body: "q=" + encodeURIComponent(query),
    useRealisticHeaders: true,
    headers: {
      ...(cookieVal ? { cookie: cookieVal } : {}),
      "content-type": "application/x-www-form-urlencoded",
      origin: host,
      referer: host + "/",
    },
  });
  if (!res || !res.ok || !res.text || isBlocked(res.text)) return [];
  return parseDdgHtml(res.text);
}

function parseDdgHtml(html: string): RawSearchResult[] {
  const doc = docOf(html);
  const out: RawSearchResult[] = [];
  // DDG HTML result blocks: div.result with a.result__a (title link)
  // and .result__snippet (snippet text)
  const blocks: any[] = doc.querySelectorAll("div.result, div.links_main");
  for (const block of blocks) {
    const a = block.querySelector("a.result__a, a.result-link");
    const snippetEl = block.querySelector(".result__snippet, .result-snippet");
    const urlEl = block.querySelector(".result__url");
    const href = a?.getAttribute("href") ?? urlEl?.getAttribute("href") ?? "";
    if (!href) continue;
    let url = decodeUddg(href);
    if (!isSafeUrl(url)) continue;
    out.push({
      title: a?.textContent?.trim() ?? "",
      url,
      snippet: snippetEl?.textContent?.trim() ?? "",
      engine: "duckduckgo",
      rank: out.length + 1,
    });
  }
  return out.slice(0, 10);
}

async function ddgLite(query: string): Promise<RawSearchResult[]> {
  const jar = newCookieJar();
  const host = "https://lite.duckduckgo.com";

  const prime = await fetchPage(host + "/lite/?q=test", {
    timeoutMs: PRIME_TIMEOUT_MS,
    headers: realisticHeaders({ referer: host + "/" }),
  } as any);
  if (prime?.cookies?.length) jar.absorb(host + "/lite/", prime.cookies);
  const cookieVal = jar.cookieFor(host + "/lite/");

  const res = await fetchUrl(host + "/lite/", {
    timeoutMs: ENGINE_TIMEOUT_MS,
    method: "POST",
    body: "q=" + encodeURIComponent(query),
    useRealisticHeaders: true,
    headers: {
      ...(cookieVal ? { cookie: cookieVal } : {}),
      "content-type": "application/x-www-form-urlencoded",
      origin: host,
      referer: host + "/",
    },
  });
  if (!res?.text || res.status !== 200 || isBlocked(res.text)) return [];
  const doc = docOf(res.text);
  const out: RawSearchResult[] = [];
  const links: any[] = doc.querySelectorAll("table.result a.result-link, a.result-link");
  for (const a of links) {
    const href = a.getAttribute("href") ?? "";
    if (!href) continue;
    let url = decodeUddg(href);
    if (!isSafeUrl(url)) continue;
    out.push({
      title: a.textContent?.trim() ?? "",
      url,
      snippet:
        a.parentElement?.querySelector(".result-snippet")?.textContent?.trim() ?? "",
      engine: "duckduckgo",
      rank: out.length + 1,
    });
  }
  return out.slice(0, 10);
}

async function ddgVqd(query: string): Promise<RawSearchResult[]> {
  const res1 = await fetchPage("https://duckduckgo.com/?q=" + encodeURIComponent(query), {
    timeoutMs: ENGINE_TIMEOUT_MS,
    headers: realisticHeaders({ referer: "https://duckduckgo.com/" }),
  } as any);
  if (!res1?.body) return [];
  const vqdMatch = res1.body.match(/"vqd"\s*:\s*"(\d+)"/) ?? res1.body.match(/vqd=(\d+)/);
  const vqd = vqdMatch?.[1];
  if (!vqd) return [];

  const res2 = await fetchUrl(
    `https://links.duckduckgo.com/d.js?q=${encodeURIComponent(query)}&vqd=${vqd}`,
    {
      timeoutMs: ENGINE_TIMEOUT_MS,
      headers: apiHeaders({ referer: "https://duckduckgo.com/" }),
    },
  );
  if (!res2?.text) return [];

  const js = res2.text;
  const out: RawSearchResult[] = [];
  // The d.js response embeds result data as JSON-like structures
  const resultBlocks = js.match(/"results":\s*\[(.*?)\]/)?.[1] ?? "";
  const items = resultBlocks
    .split(/\},\s*\{/)
    .map((block) => {
      try { return JSON.parse("{" + block + "}"); } catch { return null; }
    })
    .filter(Boolean);
  for (const item of items) {
    const url = item.u ?? item.url ?? "";
    if (!isSafeUrl(url)) continue;
    out.push({
      title: item.t ?? item.title ?? "",
      url,
      snippet: item.b ?? item.snippet ?? "",
      engine: "duckduckgo",
      rank: out.length + 1,
    });
  }
  return out.slice(0, 10);
}

/**
 * 3-stage DDG: try Stage A (cookie-primed html POST), fall back to
 * Stage B (lite POST), then Stage C (vqd token). Returns the first
 * stage that produces results.
 */
export async function ddgSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("duckduckgo");
  const stageA = await ddgHtml(query).catch(() => [] as RawSearchResult[]);
  if (stageA.length > 0) return stageA;
  const stageB = await ddgLite(query).catch(() => [] as RawSearchResult[]);
  if (stageB.length > 0) return stageB;
  const stageC = await ddgVqd(query).catch(() => [] as RawSearchResult[]);
  if (stageC.length > 0) return stageC;
  log.warn({ query: query.slice(0, 80) }, "ddg: all 3 stages returned 0 results");
  return [];
}

/* ── Yahoo (Bing index, RU= redirect unwrap) ────────────────────────────── */

export async function yahooSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("yahoo");
  const urls = [
    "https://search.yahoo.com/search?p=" + encodeURIComponent(query) + "&n=15",
    "https://in.search.yahoo.com/search?p=" + encodeURIComponent(query) + "&n=15",
  ];
  for (const url of urls) {
    try {
      const res = await fetchPage(url, {
        timeoutMs: ENGINE_TIMEOUT_MS,
        headers: realisticHeaders({ referer: "https://www.yahoo.com/" }),
      } as any);
      if (!res?.ok || !res?.body) continue;
      if (isBlocked(res.body)) continue;
      const doc = docOf(res.body);
      const out: RawSearchResult[] = [];
      // Yahoo SSR: div.algo > div.Sr (each result) with .compTitle a + .compText
      // Also try the new Bing-based layout: div.b_algo > h2 > a
      const results: any[] = doc.querySelectorAll(
        "div.algo, div.Sr, div.b_algo, div[data-algo]",
      );
      for (const div of results) {
        const a = div.querySelector(
          "a.hktoggle, a.title, .compTitle a, h2 a, a[href^='http']",
        );
        if (!a) continue;
        const href = a.getAttribute("href") ?? "";
        if (!href) continue;
        let target = unwrapRuHref(href, url);
        if (target.startsWith("/")) target = new URL(target, url).href;
        if (!isSafeUrl(target)) continue;
        out.push({
          title: a.textContent?.trim() ?? "",
          url: target,
          snippet:
            div.querySelector(".compText, .fp, .snippet, .b_caption p")?.textContent?.trim() ?? "",
          engine: "yahoo",
          rank: out.length + 1,
        });
      }
      if (out.length > 0) return out.slice(0, 15);
    } catch { /* try next regional URL */ }
  }
  return [];
}

/* ── Startpage (Google live index, SSR HTML) ─────────────────────────────── */

export async function startpageSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("startpage");
  const res = await fetchUrl("https://www.startpage.com/sp/search", {
    timeoutMs: ENGINE_TIMEOUT_MS,
    method: "POST",
    body: "query=" + encodeURIComponent(query) + "&cat=web&language=english",
    headers: {
      ...realisticHeaders({
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://www.startpage.com",
        referer: "https://www.startpage.com/",
      }),
    },
  } as any);
  if (!res?.ok || !res?.text || isBlocked(res.text)) return [];
  const doc = docOf(res.text);
  const out: RawSearchResult[] = [];
  // Startpage SSR: .w-gl__result / .result blocks with .result-link / .w-gl__description
  const results: any[] = doc.querySelectorAll(".w-gl__result, .result, article");
  for (const block of results) {
    const a = block.querySelector("a.result-link, a[href^='http']");
    if (!a) continue;
    const href = a.getAttribute("href") ?? "";
    if (!isSafeUrl(href)) continue;
    out.push({
      title: block.querySelector("h2, .result-title")?.textContent?.trim() ?? "",
      url: href,
      snippet:
        block.querySelector(".w-gl__description, .result-description, .description")?.textContent?.trim() ?? "",
      engine: "startpage",
      rank: out.length + 1,
    });
  }
  return out.slice(0, 15);
}

/* ── Brave Search ─────────────────────────────────────────────────────────── */

export async function braveSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("brave");
  const res = await fetchPage(
    "https://search.brave.com/search?q=" + encodeURIComponent(query) + "&source=web",
    {
      timeoutMs: ENGINE_TIMEOUT_MS,
      headers: realisticHeaders({ referer: "https://search.brave.com/" }),
    } as any,
  );
  if (!res?.ok || !res?.body) return [];
  if (isBlocked(res.body)) return [];

  const doc = docOf(res.body);
  const out: RawSearchResult[] = [];

  // Primary: #results / div#web-results > div with a.result-header / .snippet-description
  const results: any[] = doc.querySelectorAll(
    "#results > div, div#web-results > div, .result, .snippet",
  );
  for (const div of results) {
    const a = div.querySelector("a.result-header, a.result-title, .snippet a, a[href^='http']");
    if (!a) continue;
    const href = a.getAttribute("href") ?? "";
    if (!isSafeUrl(href)) continue;
    out.push({
      title: div.querySelector(".title, h2, .result-title")?.textContent?.trim() ?? "",
      url: href,
      snippet:
        div.querySelector(".snippet-description, .snippet, .desc, .fb")?.textContent?.trim() ?? "",
      engine: "brave",
      rank: out.length + 1,
    });
  }

  // Fallback: embedded SSR script data (window.__INITIAL_STATE__ or similar)
  if (out.length === 0) {
    const scriptData = res.body.match(
      /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});?\s*<\/script>/,
    );
    if (scriptData) {
      try {
        const state = JSON.parse(scriptData[1]);
        const results2: any[] =
          state?.searchResults?.results ?? state?.results ?? state?.webResults ?? [];
        for (const r of results2) {
          const url = r.url ?? r.link ?? "";
          if (!isSafeUrl(url)) continue;
          out.push({
            title: r.title ?? "",
            url,
            snippet: r.description ?? r.snippet ?? "",
            engine: "brave",
            rank: out.length + 1,
          });
        }
      } catch { /* ignore */ }
    }
  }

  return out.slice(0, 15);
}

/* ── AOL (Bing index, RU= redirect unwrap) ──────────────────────────────── */

export async function aolSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("aol");
  const res = await fetchPage(
    "https://search.aol.com/aol/search?q=" + encodeURIComponent(query),
    {
      timeoutMs: ENGINE_TIMEOUT_MS,
      headers: realisticHeaders({ referer: "https://www.aol.com/" }),
    } as any,
  );
  if (!res?.ok || !res?.body) return [];
  if (isBlocked(res.body)) return [];
  const doc = docOf(res.body);
  const out: RawSearchResult[] = [];
  const results: any[] = doc.querySelectorAll("div.algo, div.Sr, .g, [class*='result']");
  for (const div of results) {
    const a = div.querySelector("a[href^='http'], a[href*='RU=']");
    if (!a) continue;
    const href = a.getAttribute("href") ?? "";
    let target = unwrapRuHref(href, "https://search.aol.com");
    if (target.startsWith("/")) target = new URL(target, "https://search.aol.com").href;
    if (!isSafeUrl(target)) continue;
    out.push({
      title: a.textContent?.trim() ?? "",
      url: target,
      snippet: div.querySelector(".snippet, .compText, .fb")?.textContent?.trim() ?? "",
      engine: "aol",
      rank: out.length + 1,
    });
  }
  return out.slice(0, 15);
}

/* ── Mojeek ──────────────────────────────────────────────────────────────── */

export async function mojeekSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("mojeek");
  const res = await fetchPage(
    "https://www.mojeek.com/search?q=" + encodeURIComponent(query),
    {
      timeoutMs: ENGINE_TIMEOUT_MS,
      headers: realisticHeaders({ referer: "https://www.mojeek.com/" }),
    } as any,
  );
  if (!res?.ok || !res?.body) return [];
  if (isBlocked(res.body)) return [];
  const doc = docOf(res.body);
  const out: RawSearchResult[] = [];
  const results: any[] = doc.querySelectorAll("#results .result, article.result, div.result");
  for (const div of results) {
    const a = div.querySelector("a.result-link, h3 a, a[href^='http']");
    if (!a) continue;
    const href = a.getAttribute("href") ?? "";
    if (!isSafeUrl(href)) continue;
    out.push({
      title: a?.textContent?.trim() ?? div.querySelector("h3")?.textContent?.trim() ?? "",
      url: href,
      snippet:
        div.querySelector(".snippet, p.result-description, .result-description")?.textContent?.trim() ?? "",
      engine: "mojeek",
      rank: out.length + 1,
    });
  }
  return out.slice(0, 15);
}

/* ── SearXNG (HTML mode, dynamic healthy instance) ───────────────────────── */

/**
 * Load the cached healthy SearXNG instance list from the local vendor file.
 * The vendor file is periodically refreshed by a separate task; this is
 * the read path used at search time (no network call).
 */
function loadSearxInstances(): string[] {
  try {
    const file = join(process.cwd(), ".local-search", "vendor", "searx-instances.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    return (data.instances ?? [])
      .map((i: any) => (typeof i === "string" ? i : i.url ?? null))
      .filter((u: string | null): u is string => !!u && u.startsWith("https://"));
  } catch {
    return [];
  }
}

/**
 * SearXNG instances block `?format=json` with verifyngo challenges but
 * serve clean HTML to a Referer header from the same origin.
 *
 * The instance list is dynamic: try up to 3 in parallel, return whichever
 * produced the most results. A CAPTCHA/challenge page returns 0 results.
 */
export async function searxSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("searxng");
  const instances = loadSearxInstances();
  if (instances.length === 0) return [];

  const tried = instances.filter((u) => !u.includes(".onion")).slice(0, 3);
  const settled = await Promise.allSettled(
    tried.map(async (base: string) => {
      const url =
        base.replace(/\/$/, "") +
        "/search?q=" +
        encodeURIComponent(query) +
        "&language=en";
      const res = await fetchPage(url, {
        timeoutMs: ENGINE_TIMEOUT_MS,
        headers: realisticHeaders({ referer: base, accept: "text/html" }),
      } as any);
      if (!res?.ok || !res?.body) return [] as RawSearchResult[];
      if (isBlocked(res.body)) return [];
      const doc = docOf(res.body);
      const out: RawSearchResult[] = [];
      // SearXNG HTML: <article class="result ..."> blocks
      const articles: any[] = doc.querySelectorAll("article.result, .result");
      for (const article of articles) {
        const a = article.querySelector("a.url_header, a.result-title, a[href^='http']");
        if (!a) continue;
        const href = a.getAttribute("href") ?? "";
        if (!isSafeUrl(href)) continue;
        out.push({
          title: a.textContent?.trim() ?? "",
          url: href,
          snippet:
            article.querySelector(".result-content, .content, p.result")?.textContent?.trim() ?? "",
          engine: "searxng",
          rank: out.length + 1,
        });
      }
      return out;
    }),
  );

  for (const s of settled) {
    if (s.status === "fulfilled" && s.value.length > 0) return s.value.slice(0, 15);
  }
  return [];
}

/* ── Reddit (community ground-truth, always in general pool) ─────────────── */

export async function redditSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("reddit");
  const urls = [
    "https://old.reddit.com/search.json?q=" +
      encodeURIComponent(query) +
      "&sort=relevance&t=all&limit=15",
    "https://www.reddit.com/search.json?q=" +
      encodeURIComponent(query) +
      "&sort=relevance&t=all&limit=15",
  ];
  for (const url of urls) {
    try {
      const res = await fetchUrl(url, {
        timeoutMs: ENGINE_TIMEOUT_MS,
        headers: {
          ...apiHeaders({ "user-agent": "webui-search/1.0 (research pipeline)" }),
          accept: "application/json",
        },
      });
      if (!res?.ok || !res.text) continue;
      const data: any = JSON.parse(res.text);
      const children = data?.data?.children ?? [];
      if (children.length === 0) continue;
      return children
        .map((c: any, i: number) => {
          const p = c?.data ?? {};
          return {
            title: p.title ?? "",
            url: p.url ?? `https://www.reddit.com${p.permalink ?? ""}`,
            snippet: (p.selftext ?? p.title ?? "").slice(0, 400),
            engine: "reddit",
            publishedDate: p.created_utc
              ? new Date(p.created_utc * 1000).toISOString()
              : undefined,
            rank: i + 1,
          } as RawSearchResult;
        })
        .slice(0, 15);
    } catch { /* try next URL */ }
  }
  return [];
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * All general-web engines (the "General Web Index Pool").
 *
 * Every sub-query in an LFM plan is distributed across this pool with
 * per-engine pacing (one in-flight per host, 250–450 ms jitter) so that
 * 4 sub-queries × 8 engines never fire 32 simultaneous requests at any
 * single host.
 */
export const GENERAL_WEB_ENGINES = [
  ddgSearch,       // DuckDuckGo (3-stage: cookie-primed html POST → lite POST → VQD)
  yahooSearch,     // Bing global web index
  startpageSearch, // Google live web index
  braveSearch,     // Brave's own index
  aolSearch,       // Bing index (RU= unwrap)
  mojeekSearch,    // independent UK index
  searxSearch,     // aggregated multi-engine (HTML mode)
  redditSearch,    // community ground-truth (always included)
] as const;

/**
 * Run a single query against ALL general-web engines in parallel with
 * per-engine pacing. Returns the merged raw result list (ranked per-engine;
 * RRF fusion happens in metasearch.ts).
 */
export async function runGeneralWebSearch(query: string): Promise<RawSearchResult[]> {
  const settled = await Promise.allSettled(
    GENERAL_WEB_ENGINES.map((fn) => fn(query).catch(() => [] as RawSearchResult[])),
  );
  const out: RawSearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  return out;
}
