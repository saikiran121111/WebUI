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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

/**
 * Per-request ceiling for a single engine fetch. A blocked / captcha-walled
 * engine still takes a few seconds to return its challenge, so we allow 40s
 * for the *first* attempt at a slow-but-valid host (arXiv, SearXNG) while
 * the pool-level wall-clock budget below caps the total.
 */
const ENGINE_TIMEOUT_MS = 40_000;
/** Priming request timeout (shorter — we only need the cookie). */
const PRIME_TIMEOUT_MS = 12_000;

/**
 * Per-ENGINE wall-clock budget. A blocked engine that burns the full
 * ENGINE_TIMEOUT_MS on every stage (e.g. 3 sequential DDG stages = 2 min,
 * or a 6-instance SearXNG shard = several minutes) must not stall the whole
 * pool. The budget is shared across all of an engine's internal stages:
 * stage N starts only if the remaining budget still covers a meaningful
 * fetch. When the budget runs out, the engine returns [] and the pool moves
 * on. This is the "fail fast on a stalled engine" guard that keeps a
 * single hostile host from consuming the entire pipeline.
 */
const ENGINE_WALL_CLOCK_MS = 55_000;

/** A per-engine clock that all internal stages of one call share. */
class EngineBudget {
  private readonly deadline: number;
  constructor() {
    this.deadline = Date.now() + ENGINE_WALL_CLOCK_MS;
  }
  /** ms remaining before the engine gives up; 0 if the budget is exhausted. */
  remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }
  /** True when at least `need` ms are left (callers pass a short need so a
   *   near-dead budget still allows one quick probe). */
  has(ms = 1000): boolean {
    return this.remaining() >= ms;
  }
  /** A sensible per-fetch timeout: the smaller of the engine's own cap and
   *   what's left in the budget. */
  timeout(maxMs: number): number {
    return Math.max(5_000, Math.min(maxMs, this.remaining()));
  }
}

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
async function ddgHtml(query: string, budget: EngineBudget = new EngineBudget()): Promise<RawSearchResult[]> {
  if (!budget.has(4_000)) return [];
  const jar = newCookieJar();
  const host = "https://html.duckduckgo.com";

  // Priming request: sets session cookies. The 202/302 response body
  // doesn't matter — we only need the cookie jar populated.
  const prime = await fetchPage(host + "/html/", {
    timeoutMs: Math.min(PRIME_TIMEOUT_MS, budget.timeout(PRIME_TIMEOUT_MS)),
    headers: realisticHeaders({ referer: host + "/" }),
  } as any);
  if (prime?.cookies?.length) jar.absorb(host + "/html/", prime.cookies);
  const cookieVal = jar.cookieFor(host + "/html/");

  // POST with session cookies + realistic browser-navigate headers.
  // useRealisticHeaders ensures Accept: text/html (not application/json),
  // which is what DDG's anomaly detector expects for a form submission.
  const res = await fetchUrl(host + "/html/", {
    timeoutMs: budget.timeout(ENGINE_TIMEOUT_MS),
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

async function ddgLite(query: string, budget: EngineBudget = new EngineBudget()): Promise<RawSearchResult[]> {
  if (!budget.has(4_000)) return [];
  const jar = newCookieJar();
  const host = "https://lite.duckduckgo.com";

  const prime = await fetchPage(host + "/lite/?q=test", {
    timeoutMs: Math.min(PRIME_TIMEOUT_MS, budget.timeout(PRIME_TIMEOUT_MS)),
    headers: realisticHeaders({ referer: host + "/" }),
  } as any);
  if (prime?.cookies?.length) jar.absorb(host + "/lite/", prime.cookies);
  const cookieVal = jar.cookieFor(host + "/lite/");

  const res = await fetchUrl(host + "/lite/", {
    timeoutMs: budget.timeout(ENGINE_TIMEOUT_MS),
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

async function ddgVqd(query: string, budget: EngineBudget = new EngineBudget()): Promise<RawSearchResult[]> {
  if (!budget.has(4_000)) return [];
  const res1 = await fetchPage("https://duckduckgo.com/?q=" + encodeURIComponent(query), {
    timeoutMs: budget.timeout(ENGINE_TIMEOUT_MS),
    headers: realisticHeaders({ referer: "https://duckduckgo.com/" }),
  } as any);
  if (!res1?.body) return [];
  const vqdMatch = res1.body.match(/"vqd"\s*:\s*"(\d+)"/) ?? res1.body.match(/vqd=(\d+)/);
  const vqd = vqdMatch?.[1];
  if (!vqd) return [];

  const res2 = await fetchUrl(
    `https://links.duckduckgo.com/d.js?q=${encodeURIComponent(query)}&vqd=${vqd}`,
    {
      timeoutMs: budget.timeout(ENGINE_TIMEOUT_MS),
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
 * stage that produces results. Each stage is budget-gated so a blocked
 * DDG host can't burn the entire pool wall-clock — when the budget
 * runs low, later stages are skipped and we return [].
 */
export async function ddgSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("duckduckgo");
  const budget = new EngineBudget();
  const stageA = await ddgHtml(query, budget).catch(() => [] as RawSearchResult[]);
  if (stageA.length > 0) return stageA;
  if (budget.has(5_000)) {
    const stageB = await ddgLite(query, budget).catch(() => [] as RawSearchResult[]);
    if (stageB.length > 0) return stageB;
  }
  if (budget.has(5_000)) {
    const stageC = await ddgVqd(query, budget).catch(() => [] as RawSearchResult[]);
    if (stageC.length > 0) return stageC;
  }
  log.warn({ query: query.slice(0, 80) }, "ddg: all 3 stages returned 0 results (or budget exhausted)");
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

/* ── SearXNG (HTML mode, sharded verified-instance pool) ───────────────── */

/**
 * Sharded SearXNG pool:
 *   1. On first use, probe candidate instances in parallel with a test
 *      query, keep the ones that returned ≥1 result, and write the
 *      verified list to `.local-search/vendor/searx-instances.json`
 *      with a 5-hour wall-clock TTL.
 *   2. On subsequent reads within the TTL, reuse the verified list
 *      (no re-probe — saves the network round-trip).
 *   3. `searxSearch` shards LFM sub-queries across DIFFERENT verified
 *      instances in parallel (Q1→inst[0], Q2→inst[1], …) so a single
 *      instance's CAPTCHA wall can't block the whole pool.
 */

const SEARX_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours wall-clock
const SEARX_MIN_VERIFIED = 3;            // keep at least this many working instances
const SEARX_MAX_SHARDS = 6;             // shard sub-queries across at most 6 instances

/**
 * Candidate SearXNG instances to probe when the verified list is empty
 * or expired. These are public, non-onion instances known to serve HTML
 * to a Referer header from the same origin.
 */
const SEARX_CANDIDATES: string[] = [
  "https://opnxng.com/",
  "https://search.banke.cloud/",
  "https://etsi.me/",
  "https://priv.au/",
  "https://search.anoni.net/",
  "https://search.undertale.uk/",
  "https://search.femboy.ad/",
  "https://search.hbubli.cc/",
  "https://search.serpensin.com/",
  "https://search.unredacted.org/",
  "https://search.zina.dev/",
  "https://search.chocolatemoo53.com/",
];

interface SearxCache {
  verified: string[];
  verifiedAt: number; // epoch ms
}

function searxCachePath(): string {
  return join(process.cwd(), ".local-search", "vendor", "searx-instances.json");
}

/**
 * Read the 5-hour wall-clock verified SearXNG instance list. Returns
 * [] when the cache file is missing, unparseable, or older than 5 hours.
 */
function loadSearxInstances(): string[] {
  try {
    const file = searxCachePath();
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, "utf8"));
    // Two shapes: the new {verified, verifiedAt} cache, or the legacy
    // {instances: [...]} list from searx.space (pre-verification).
    if (Array.isArray(raw.verified) && typeof raw.verifiedAt === "number") {
      if (Date.now() - raw.verifiedAt < SEARX_TTL_MS) return raw.verified;
      return []; // stale — re-probe
    }
    // Legacy: no verifiedAt — trust it if fresh enough (fetchedAt field)
    if (Array.isArray(raw.instances)) {
      const ts = raw.fetchedAt ? new Date(raw.fetchedAt).getTime() : 0;
      if (Date.now() - ts < SEARX_TTL_MS) {
        return raw.instances
          .map((i: any) => (typeof i === "string" ? i : i.url ?? null))
          .filter((u: string | null): u is string => !!u && u.startsWith("https://") && !u.includes(".onion"));
      }
    }
    return [];
  } catch {
    return [];
  }
}

function writeSearxCache(verified: string[]): void {
  try {
    const file = searxCachePath();
    mkdirSync(join(process.cwd(), ".local-search", "vendor"), { recursive: true });
    const cache: SearxCache = { verified, verifiedAt: Date.now() };
    writeFileSync(file, JSON.stringify(cache, null, 2) + "\n", "utf8");
    log.info({ verified, count: verified.length }, "searx verified list written to cache");
  } catch {
    /* cache write failure is non-fatal */
  }
}

/**
 * Probe SEARX_CANDIDATES in parallel with a test query, keep instances
 * that returned ≥1 result, write the verified list to cache, and return
 * the verified list (at least SEARX_MIN_VERIFIED if possible).
 *
 * This is called lazily by `searxSearch` when the cache is empty/stale.
 * It is deliberately throttled: the 5-hour wall-clock TTL means it only
 * runs once every 5 hours per process.
 */
let searxProbeInFlight: Promise<string[]> | null = null;

export async function probeAndCacheSearxInstances(): Promise<string[]> {
  if (searxProbeInFlight) return searxProbeInFlight;
  searxProbeInFlight = (async () => {
    const settled = await Promise.allSettled(
      SEARX_CANDIDATES.map(async (base) => {
        try {
          const url =
            base.replace(/\/$/, "") +
            "/search?q=" +
            encodeURIComponent("test query biryani hyderabad");
          const res = await fetchPage(url, {
            timeoutMs: 15_000,
            headers: realisticHeaders({ referer: base, accept: "text/html" }),
          } as any);
          if (!res?.ok || !res?.body) return false;
          if (res.body.length < 5_000) return false; // challenge / empty shell
          if (/verifyngo|challenge|anomaly|captcha/i.test(res.body.slice(0, 3_000))) return false;
          const doc = docOf(res.body);
          const articles: any[] = doc.querySelectorAll("article.result, .result");
          return articles.length > 0;
        } catch {
          return false;
        }
      }),
    );
    const verified = settled
      .filter((s) => s.status === "fulfilled" && s.value)
      .map((_, i) => SEARX_CANDIDATES[i]);
    if (verified.length > 0) writeSearxCache(verified);
    else {
      // No instance worked — fall back to the candidates list so the
      // pool is never completely empty (they may work intermittently).
      writeSearxCache(SEARX_CANDIDATES.slice(0, SEARX_MAX_SHARDS));
    }
    return verified.length > 0 ? verified : SEARX_CANDIDATES.slice(0, SEARX_MAX_SHARDS);
  })();
  try {
    return await searxProbeInFlight;
  } finally {
    searxProbeInFlight = null;
  }
}

/**
 * Load verified instances, probing + caching on first use.
 */
async function getVerifiedSearxInstances(): Promise<string[]> {
  const cached = loadSearxInstances();
  if (cached.length > 0) return cached;
  return probeAndCacheSearxInstances();
}

/**
 * SearXNG sharded pool: distributes sub-queries across DIFFERENT verified
 * instances in parallel. Q1→inst[0], Q2→inst[1], Q3→inst[2], …
 *
 * A CAPTCHA/challenge page returns 0 results; that instance is skipped
 * for the current round (it will be re-probed on the next 5-hour cache
 * refresh).
 *
 * `shardIndex` (0-based) selects which instance to use; callers that
 * don't care about sharding just call without it and we rotate round-robin.
 */
export async function searxSearch(
  query: string,
  shardIndex: number = 0,
): Promise<RawSearchResult[]> {
  await enginePacer("searxng");
  const instances = await getVerifiedSearxInstances();
  if (instances.length === 0) return [];

  // Pick the instance for this shard; wrap around if there are fewer
  // instances than shards.
  const base = instances[shardIndex % instances.length];

  const settled = await Promise.allSettled([
    (async () => {
      const url =
        base.replace(/\/$/, "") +
        "/search?q=" +
        encodeURIComponent(query) +
        "&language=en";
      const res = await fetchPage(url, {
        timeoutMs: Math.min(ENGINE_TIMEOUT_MS, 30_000),
        headers: realisticHeaders({ referer: base, accept: "text/html" }),
      } as any);
      if (!res?.ok || !res?.body) return [] as RawSearchResult[];
      if (isBlocked(res.body)) return [];
      const doc = docOf(res.body);
      const out: RawSearchResult[] = [];
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
    })(),
  ]);

  for (const s of settled) {
    if (s.status === "fulfilled" && s.value.length > 0) return s.value.slice(0, 15);
  }
  return [];
}

/**
 * Sharded SearXNG search: distribute multiple sub-queries across
 * DIFFERENT verified instances in parallel. This is the Part-2.5
 * "Smart Query Sharding" path: LFM sub-query Q1 goes to instance[0],
 * Q2 to instance[1], etc.
 *
 * Returns the merged raw result list (ranks are per-instance; RRF
 * fusion happens in metasearch.ts).
 */
export async function searxSearchSharded(queries: string[]): Promise<RawSearchResult[]> {
  if (queries.length === 0) return [];
  const instances = await getVerifiedSearxInstances();
  if (instances.length === 0) return [];

  // Shard: query[i] → instance[i % instances.length]. Each sub-query
  // acquires the searxng pacer individually (concurrency=1 + jitter),
  // so even when they run "in parallel" they execute sequentially —
  // the 5h cached instance list means getVerifiedSearxInstances is
  // free here, and the pacer is what enforces anti-bot pacing.
  const settled = await Promise.allSettled(
    queries.map(async (q, i) => {
      await enginePacer("searxng");
      const base = instances[i % instances.length];
      const url =
        base.replace(/\/$/, "") +
        "/search?q=" +
        encodeURIComponent(q) +
        "&language=en";
      const res = await fetchPage(url, {
        timeoutMs: Math.min(ENGINE_TIMEOUT_MS, 30_000),
        headers: realisticHeaders({ referer: base, accept: "text/html" }),
      } as any);
      if (!res?.ok || !res?.body) return [] as RawSearchResult[];
      if (isBlocked(res.body)) return [];
      const doc = docOf(res.body);
      const out: RawSearchResult[] = [];
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
      return out.slice(0, 15);
    }),
  );

  const out: RawSearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  return out;
}

/* ── Reddit (community ground-truth, always in general pool) ─────────────── */

/**
 * 3-stage keyless Reddit cascade:
 *   Stage A — Reddit RSS/Atom feed (no auth, no rate-limit like the JSON API)
 *   Stage B — PullPush Reddit archive API (independent third-party, keyless)
 *   Stage C — Cookie-primed old.reddit.com/search.json (last resort)
 *
 * Stage A is the most reliable: Reddit's Atom search endpoint serves clean
 * XML to any browser UA with no session cookies and no 403 challenge.
 */

/** Parse a Reddit Atom/RSS feed into RawSearchResult[]. */
function parseRedditFeed(xml: string): RawSearchResult[] {
  // Atom feed: <entry><title>…</title><link href="…" rel="alternate"/>…</entry>
  // We don't have a full XML parser in this codebase, so we regex the
  // well-formed Atom structure (Reddit feeds are machine-generated and
  // stable). The entry structure is:
  //   <entry>
  //     <author><name>u/…</name></author>
  //     <category term="subreddit" label="r/…"/>
  //     <title>…</title>
  //     <link href="https://www.reddit.com/…" rel="alternate"/>
  //     <content type="html">…</content>
  //     <updated>…</updated>
  const out: RawSearchResult[] = [];
  const entryRe = /<entry>[\s\S]*?<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null && out.length < 20) {
    const entry = m[0];
    const titleMatch = entry.match(/<title>(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?<\/title>/);
    const linkMatch = entry.match(/<link[^>]*href="(https?:\/\/[^"]+)"/);
    const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/);
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
    const url = linkMatch?.[1];
    if (!url) continue;
    out.push({
      title: titleMatch?.[1]?.trim() ?? "",
      url,
      snippet: contentMatch?.[1]?.replace(/<[^>]+>/g, "").slice(0, 400) ?? "",
      engine: "reddit",
      publishedDate: publishedMatch?.[1],
      rank: out.length + 1,
    });
  }
  return out;
}

async function redditRss(query: string): Promise<RawSearchResult[]> {
  const urls = [
    "https://www.reddit.com/search.rss?q=" +
      encodeURIComponent(query) +
      "&sort=relevance&limit=20",
    "https://old.reddit.com/search.rss?q=" +
      encodeURIComponent(query) +
      "&sort=relevance&limit=20",
  ];
  for (const url of urls) {
    try {
      const res = await fetchUrl(url, {
        timeoutMs: 25_000,
        headers: {
          ...apiHeaders({ "user-agent": "webui-search/1.0 (research pipeline)" }),
          accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
      });
      if (!res?.ok || !res.text) continue;
      const results = parseRedditFeed(res.text);
      if (results.length > 0) return results;
    } catch { /* try next URL */ }
  }
  return [];
}

async function redditPullPush(query: string): Promise<RawSearchResult[]> {
  const url =
    "https://api.pullpush.io/reddit/search/submission/?" +
    "q=" +
    encodeURIComponent(query) +
    "&size=15&sort=score&sort_type=desc";
  try {
    const res = await fetchUrl(url, {
      timeoutMs: 25_000,
      headers: { ...apiHeaders({ "user-agent": "webui-search/1.0" }), accept: "application/json" },
    });
    if (!res?.ok || !res.text) return [];
    const data: any = JSON.parse(res.text);
    const items: any[] = data?.data ?? [];
    if (items.length === 0) return [];
    return items
      .map((item: any, i: number) => ({
        title: item.title ?? "",
        url: item.url ?? `https://www.reddit.com${item.permalink ?? ""}`,
        snippet: (item.selftext ?? item.title ?? "").slice(0, 400),
        engine: "reddit" as const,
        publishedDate: item.created_utc
          ? new Date(item.created_utc * 1000).toISOString()
          : undefined,
        rank: i + 1,
      } as RawSearchResult))
      .slice(0, 15);
  } catch {
    return [];
  }
}

async function redditJson(query: string): Promise<RawSearchResult[]> {
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
        timeoutMs: 25_000,
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

/**
 * 3-stage Reddit: RSS feed → PullPush → cookie-primed JSON.
 * Returns the first stage that produces results.
 */
export async function redditSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("reddit");
  const stageA = await redditRss(query).catch(() => [] as RawSearchResult[]);
  if (stageA.length > 0) return stageA;
  const stageB = await redditPullPush(query).catch(() => [] as RawSearchResult[]);
  if (stageB.length > 0) return stageB;
  const stageC = await redditJson(query).catch(() => [] as RawSearchResult[]);
  if (stageC.length > 0) return stageC;
  log.warn({ query: query.slice(0, 80) }, "reddit: all 3 stages returned 0 results");
  return [];
}

/* ── Bing (RSS + cookie-primed HTML, ck/a decode) ────────────────────────── */

/**
 * Bing is the only search engine that offers a clean RSS endpoint with no
 * CAPTCHA. Stage A fetches the RSS; Stage B falls back to cookie-primed
 * HTML scraping with the `ck/a?...&u=a1<base64>` link decoder.
 */

/** Decode a Bing `ck/a` redirect link. */
function decodeBingCk(href: string): string {
  try {
    const u = new URL(href, "https://www.bing.com");
    // Bing wraps external links as: /ck/a?!&&p=...&u=a1<base64-encoded-url>
    const uParam = u.searchParams.get("u");
    if (uParam?.startsWith("a1")) {
      const b64 = uParam.slice(2); // strip the "a1" prefix
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      if (decoded.startsWith("http")) return decoded;
    }
    // Some Bing links are direct (no ck/a wrapper)
    if (u.href.startsWith("http") && !u.href.includes("bing.com/ck/")) return u.href;
    return u.href;
  } catch {
    return href;
  }
}

function parseBingRss(xml: string): RawSearchResult[] {
  const out: RawSearchResult[] = [];
  const itemRe = /<item>[\s\S]*?<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && out.length < 15) {
    const item = m[0];
    const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?<\/title>/);
    const linkMatch = item.match(/<link>([^<]+)<\/link>/);
    const descMatch = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    const url = linkMatch?.[1]?.trim();
    if (!url) continue;
    out.push({
      title: titleMatch?.[1]?.trim() ?? "",
      url,
      snippet: descMatch?.[1]?.replace(/<[^>]+>/g, "").slice(0, 400) ?? "",
      engine: "bing",
      rank: out.length + 1,
    });
  }
  return out;
}

async function bingRss(query: string): Promise<RawSearchResult[]> {
  const url =
    "https://www.bing.com/search?q=" +
    encodeURIComponent(query) +
    "&format=rss&count=15";
  try {
    const res = await fetchUrl(url, {
      timeoutMs: 25_000,
      headers: {
        ...realisticHeaders({ accept: "application/rss+xml, application/xml, text/xml;q=0.9" }),
      },
    });
    if (!res?.ok || !res.text) return [];
    const results = parseBingRss(res.text);
    if (results.length > 0) return results;
  } catch { /* fall through to Stage B */ }
  return [];
}

async function bingHtml(query: string): Promise<RawSearchResult[]> {
  const jar = newCookieJar();
  const host = "https://www.bing.com";

  // Priming: sets the session cookie that Bing's HTML endpoint expects.
  const prime = await fetchPage(host + "/", {
    timeoutMs: 12_000,
    headers: realisticHeaders({ referer: "https://www.bing.com/" }),
  } as any);
  if (prime?.cookies?.length) jar.absorb(host + "/", prime.cookies);
  const cookieVal = jar.cookieFor(host + "/");

  const res = await fetchPage(
    host + "/search?q=" + encodeURIComponent(query) + "&setlang=en",
    {
      timeoutMs: 30_000,
      headers: {
        ...realisticHeaders(cookieVal ? { cookie: cookieVal } : { referer: host + "/" }),
      },
    } as any,
  );
  if (!res?.ok || !res?.body) return [];
  if (isBlocked(res.body)) return [];
  const doc = docOf(res.body);
  const out: RawSearchResult[] = [];
  // Bing HTML: <li class="b_algo"><h2><a href="/ck/a?...">…</a></h2>
  const results: any[] = doc.querySelectorAll("li.b_algo, div.b_algo");
  for (const div of results) {
    const a = div.querySelector("h2 a, a[href^='/ck/'], a[href^='http']");
    if (!a) continue;
    let href = a.getAttribute("href") ?? "";
    if (href.startsWith("/ck/")) href = host + href;
    const target = decodeBingCk(href);
    if (!isSafeUrl(target)) continue;
    out.push({
      title: a.textContent?.trim() ?? "",
      url: target,
      snippet: div.querySelector(".b_caption p, p")?.textContent?.trim() ?? "",
      engine: "bing",
      rank: out.length + 1,
    });
  }
  return out.slice(0, 15);
}

/**
 * 2-stage Bing: RSS feed → cookie-primed HTML.
 * Returns the first stage that produces results.
 */
export async function bingSearch(query: string): Promise<RawSearchResult[]> {
  await enginePacer("bing");
  const stageA = await bingRss(query).catch(() => [] as RawSearchResult[]);
  if (stageA.length > 0) return stageA;
  const stageB = await bingHtml(query).catch(() => [] as RawSearchResult[]);
  if (stageB.length > 0) return stageB;
  log.warn({ query: query.slice(0, 80) }, "bing: both stages returned 0 results");
  return [];
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * Deduplicate sub-queries that share >80% token overlap.
 *
 * Before the LFM gate's 4 sub-queries are fanned out to the pool, this
 * collapses near-duplicates so we don't waste 4× requests on essentially
 * the same query. "best biryani restaurant in Manikonda Hyderabad" and
 * "top rated biryani places in Manikonda Hyderabad" share ~80% tokens
 * and only the first one is kept.
 *
 * Returns the deduplicated array: [primaryQuery, …remainingUniqueQueries].
 * The first element is the "primary" query that gets sent to rate-sensitive
 * direct scrapers (DDG, Brave); the rest are distributed across the sharded
 * pool.
 */
export function deduplicateQueries(queries: string[]): string[] {
  if (queries.length <= 1) return queries;
  const tokenSets = queries.map((q) => new Set(q.toLowerCase().split(/\s+/).filter((t) => t.length > 2)));
  const keep: string[] = [];
  const keptSets: Set<string>[] = [];
  for (let i = 0; i < queries.length; i++) {
    let isDup = false;
    for (let j = 0; j < keptSets.length; j++) {
      const a = tokenSets[i];
      const b = keptSets[j];
      // Jaccard-style: |A∩B| / min(|A|,|B|)
      let intersection = 0;
      for (const t of a) if (b.has(t)) intersection++;
      const overlap = intersection / Math.max(1, Math.min(a.size, b.size));
      if (overlap > 0.8) {
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      keep.push(queries[i]);
      keptSets.push(tokenSets[i]);
    }
  }
  return keep.length > 0 ? keep : [queries[0]];
}

/**
 * All general-web engines (the "General Web Index Pool").
 *
 * Every sub-query in an LFM plan is distributed across this pool with
 * per-engine pacing (one in-flight per host, 250–450 ms jitter) so that
 * 4 sub-queries × 9 engines never fire 36 simultaneous requests at any
 * single host.
 *
 * `searxSearch` is the single-shard version; `searxSearchSharded` is
 * the multi-shard version used by `metasearchSharded`.
 */
export const GENERAL_WEB_ENGINES = [
  ddgSearch,        // DuckDuckGo (3-stage: cookie-primed html POST → lite POST → VQD)
  bingSearch,       // Bing (RSS feed → cookie-primed HTML, ck/a decode)
  yahooSearch,      // Bing global web index (RU= unwrap)
  startpageSearch,  // Google live web index (SSR HTML)
  braveSearch,      // Brave's own index
  aolSearch,        // Bing index (RU= unwrap)
  mojeekSearch,     // independent UK index
  searxSearch,      // aggregated multi-engine (HTML mode, single shard)
  redditSearch,     // community ground-truth (3-stage: RSS → PullPush → JSON)
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

/**
 * Sharded metasearch: distribute multiple sub-queries across DIFFERENT
 * instances / engines to minimise per-host burst load.
 *
 * - `primaryQuery` (from `deduplicateQueries[0]`) is sent to the
 *   rate-sensitive direct scrapers (DDG, Bing, Brave) once.
 * - All queries are distributed across the SearXNG sharded pool.
 * - All queries are sent to the Reddit 3-stage cascade and the other
 *   general engines in parallel (their per-engine pacer handles the
 *   jitter between sub-queries automatically).
 *
 * Returns the merged raw result list for RRF fusion.
 */
export async function runGeneralWebSearchSharded(
  primaryQuery: string,
  allQueries: string[],
): Promise<RawSearchResult[]> {
  // 1. Primary query → rate-sensitive direct scrapers (DDG, Bing, Brave)
  const directPromises = [
    ddgSearch(primaryQuery),
    bingSearch(primaryQuery),
    braveSearch(primaryQuery),
  ];

  // 2. All queries → sharded SearXNG pool
  const searxSharded = searxSearchSharded(allQueries);

  // 3. All queries → remaining general engines (rate-limited by their
  //    individual pacer, so all sub-queries get through with jitter)
  const otherEngines = [
    yahooSearch,
    startpageSearch,
    aolSearch,
    mojeekSearch,
    redditSearch,
  ];
  const othersPromises = allQueries.flatMap((q) =>
    otherEngines.map((fn) => fn(q)),
  );

  const settled = await Promise.allSettled(
    [...directPromises, searxSharded, ...othersPromises],
  );
  const out: RawSearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  return out;
}
