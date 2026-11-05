/**
 * Universal general-web search engine pool.
 *
 * Each fetcher returns RawSearchResult[] for a single query string.
 * The pool is selected by intent (see poolForIntent in metasearch.ts).
 *
 * Engine backbones:
 *   - DDG HTML POST      → DuckDuckGo's own index (cookie-primed)
 *   - DDG lite POST      → fallback when html POST is anomaly-blocked
 *   - Google             → Google live web index (got-scraping fingerprints)
 *   - Yahoo              → Bing global web index (RU= redirect unwrap)
 *   - Brave              → Brave's own index (SSR HTML + __INITIAL_STATE__)
 *   - Reddit             → old.reddit.com JSON (community ground-truth)
 *
 * All scrapers go through fetchPage/fetchUrl in net.ts — got-scraping
 * (header-generator fingerprints) first, impit TLS rotation as the internal
 * fallback. Each engine has a 40-second wall-clock ceiling.
 *
 * Per-engine pacing: one in-flight request per host, 250–450 ms jitter
 * between sub-queries, so 4 planned sub-queries never fire 32 simultaneous
 * requests at any single search-engine host.
 */
import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import type { RawSearchResult } from "./types";
import { scrubQuerySecrets } from "./ssrf";
import {
  fetchPage,
  fetchUrl,
  realisticHeaders,
  apiHeaders,
  isSafeUrl,
  newCookieJar,
} from "./net";
import { childLogger } from "@/lib/server/logger";

const log = childLogger("web-search/general-pool");

/**
 * Per-request ceiling for a single engine fetch. A blocked / captcha-walled
 * engine still takes a few seconds to return its challenge, so we allow 40s
 * for the *first* attempt at a slow-but-valid host (arXiv, Google) while
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

/**
 * Per-engine circuit breaker: when an engine returns 0 results (timeout,
 * HTTP 202/403/429, or a challenge page) it is "tripped" and all
 * subsequent calls to that engine are skipped for 60 seconds. This stops
 * a rate-limited DDG from stalling metasearch for 3×12s = 36s on every
 * sub-query when Bing/Brave/Reddit/GitHub already returned 30+ results
 * in <2.5s. A single 0-result call is NOT enough to trip: a narrow
 * `site:` operator query can legitimately have zero hits, and tripping
 * the whole engine on that starves every later healthy query for 60s
 * (measured: a `site:linkedin.com/in/` zero put DDG in cooldown and
 * killed the regional variant that actually had the hit). The breaker
 * therefore trips on the SECOND consecutive 0-result outcome within a
 * 2-minute window — a genuinely blocked/throttled engine returns 0 on
 * every sub-query, so it still trips almost immediately.
 */

/* ── per-engine pacing & circuit breaker ──────────────────────────────────── */

/**
 * Per-engine concurrency limiter (concurrency=1) + 250–450 ms jitter.
 *
 * The jitter is applied BETWEEN consecutive calls to the same engine,
 * so sub-query 1 → DDG at t=0ms, sub-query 2 → DDG at t=350ms, etc.
 * This prevents the self-DDoS burst where 4 gate sub-queries fire at
 * the same host at the exact same millisecond and get bot-flagged.
 */
const ENGINE_COOLDOWN_MS = 60_000;
const engineCooldownUntil = new Map<string, number>();
/**
 * Consecutive-zero tracking: engine → {count, at}. tripCircuitBreaker is
 * only called on 0-result outcomes, so each call means "another zero" —
 * and each ENGINE CALL contributes at most one zero observation.
 * The streak resets whenever that engine next serves real results
 * (noteEngineSuccess) or when the previous zero is older than
 * ZERO_STREAK_WINDOW_MS (a lone niche zero expires out of the window).
 */
const engineZeroStreaks = new Map<string, { count: number; at: number }>();
const ZERO_STREAK_TO_TRIP = 2;
const ZERO_STREAK_WINDOW_MS = 120_000;
const enginePacers = new Map<string, { limit: ReturnType<typeof pLimit>; lastCall: number }>();

/**
 * Check whether an engine is currently in its 60s cooldown window.
 * Returns true when the caller should skip this engine immediately.
 */
function engineIsCoolingDown(engine: string): boolean {
  const until = engineCooldownUntil.get(engine);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    // Cooldown expired — clear it so the next call retries.
    engineCooldownUntil.delete(engine);
    return false;
  }
  return true;
}

/**
 * Remaining breaker cooldown for an engine, in ms (0 when not cooling).
 * Lets targeted recovery hops wait the cooldown out exactly instead of
 * firing seconds later straight into a blackholed engine.
 */
export function engineCooldownRemainingMs(engine: string): number {
  const until = engineCooldownUntil.get(engine);
  if (until === undefined) return 0;
  return Math.max(0, until - Date.now());
}

/**
 * Record a 0-result outcome for an engine and trip the breaker only on
 * the SECOND consecutive zero (within ZERO_STREAK_WINDOW_MS). Callers
 * invoke this on every 0-result path; the streak logic lives here so a
 * single legitimate "no hits for this query" answer cannot blackhole a
 * healthy engine for the whole cooldown window.
 */
function tripCircuitBreaker(engine: string, reason: string): void {
  const now = Date.now();
  const prev = engineZeroStreaks.get(engine);
  const streak =
    prev && now - prev.at <= ZERO_STREAK_WINDOW_MS ? prev.count + 1 : 1;
  if (streak < ZERO_STREAK_TO_TRIP) {
    engineZeroStreaks.set(engine, { count: streak, at: now });
    log.info(
      { engine, reason, streak },
      "engine 0-result outcome — breaker not tripped yet (single zero may be query-specific)",
    );
    return;
  }
  engineZeroStreaks.delete(engine);
  engineCooldownUntil.set(engine, now + ENGINE_COOLDOWN_MS);
  log.info({ engine, reason, cooldownMs: ENGINE_COOLDOWN_MS }, "engine circuit breaker tripped");
}

/**
 * The engine served real results — clear its zero streak so a future
 * lone zero (a genuinely empty niche `site:` query) can never tip it
 * into cooldown.
 */
function noteEngineSuccess(engine: string): void {
  engineZeroStreaks.delete(engine);
}

/**
 * Pacer gate (audit 2026-11-04 fix). The old pacer resolved pLimit's thunk
 * after applying jitter — releasing the single in-flight slot BEFORE the
 * caller's SERP fetch actually started, so two "paced" queries to the same
 * engine host overlapped in flight (the file-header one-in-flight-per-host
 * law was enforced only by the jitter delay). The slot now spans the whole
 * engine call: the gate hands the caller a held slot and `done()` frees
 * it. Callers acquire, check `allowed`, and MUST release in `finally`.
 */
interface PacerGate {
  allowed: boolean;
  done: () => void;
}
const NO_PACER_GATE: PacerGate = { allowed: false, done: () => {} };

async function acquirePacerSlot(
  engine: string,
  jitterMs: () => number,
): Promise<PacerGate> {
  let entry = enginePacers.get(engine);
  if (!entry) {
    entry = { limit: pLimit(1), lastCall: 0 };
    enginePacers.set(engine, entry);
  }
  let grant!: () => void;
  const granted = new Promise<void>((r) => {
    grant = r;
  });
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  // pLimit(1) runs this thunk only when the slot is free; it stays busy
  // until the current holder calls done() → release().
  entry.limit(async () => {
    grant();
    await held;
  });
  await granted;
  // Jitter INSIDE the slot: consecutive same-engine calls serialize on
  // both spacing and in-flight time. Brave 429s aggressively when its
  // SERPs are ~300 ms apart (live-probed 2026-11-04: a second brave query
  // one second after the first got throttled), so brave's consecutive-
  // call spacing is raised to 1.5-2.5s.
  const wait = Math.max(0, entry.lastCall + jitterMs() - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  entry.lastCall = Date.now();
  let closed = false;
  return {
    allowed: true,
    done: () => {
      if (!closed) {
        closed = true;
        release();
      }
    },
  };
}

/**
 * Pacer with the circuit-breaker guard. Returns allowed=false when the
 * engine is in its cooldown window; a granted gate MUST be released.
 */
async function enginePacerWithBreaker(engine: string): Promise<PacerGate> {
  if (engineIsCoolingDown(engine)) return NO_PACER_GATE;
  const gate = await acquirePacerSlot(engine, () =>
    engine === "brave"
      ? 1_500 + Math.floor(Math.random() * 1_000)
      : 250 + Math.floor(Math.random() * 200),
  );
  if (engineIsCoolingDown(engine)) {
    gate.done();
    return NO_PACER_GATE;
  }
  return gate;
}

/**
 * Plain pacer without the circuit-breaker guard.
 * Used by engines that trip the breaker explicitly at their own call
 * sites (e.g. bingSearch, bingNewsRssSearch, redditSearch).
 */
async function enginePacer(engine: string): Promise<PacerGate> {
  return acquirePacerSlot(engine, () => 250 + Math.floor(Math.random() * 200));
}

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
 *
 * IMPORTANT: search engines (Yahoo, Bing, Startpage, AOL) embed
 * `recaptcha`/`captcha` strings inside boilerplate <script> tags on valid
 * 200 OK result pages. This function is ONLY safe to call when you have
 * already parsed the page and found 0 results — it must NEVER be the
 * first gate before parsing. For engines that use it, always parse
 * first, and only invoke isBlocked as a secondary check when the parser
 * returned zero results.
 */
function isBlocked(body: string): boolean {
  if (body.length < 500) return true;
  const head = body.slice(0, 3000);
  return (
    /verifyngo|challenge|anomaly|captcha|please enable javascript|not a robot/i.test(head)
  );
}

/**
 * A result-count check: if the HTML contains at least MIN_RESULTS external
 * http/https links that are NOT the engine's own domain, the page is a
 * valid SERP (the "captcha" substring is just script boilerplate).
 * Call this BEFORE isBlocked() to avoid false positives.
 */
function hasSerResults(html: string, engineDomain?: string, minResults = 2): boolean {
  // Quick count of absolute http/https links in the body (cheap heuristic
  // that works on real SERP pages: result anchors always use full URLs).
  const links = html.match(/href="(https?:\/\/(?!www\.[\w.-]+\.(com|org|net|in|co|dev|io|me|uk|cc|ad|cloud|xyz|online|top|site|info|biz|pro)[\w.-]*\/))[^"]+/gi) ?? [];
  // The engine's own domain will have many internal links (nav, footer, etc.)
  // but the regex above is a rough gate — if we found at least minResults
  // absolute external-looking links, the page is not an empty challenge.
  return links.length >= minResults;
}

/**
 * Combined parse-first, block-check-later helper.
 * For a 200 OK body: if it has enough external links, treat it as valid
 * regardless of any "captcha" substring. If not, run the block check.
 */
function isBlockedAfterParse(body: string, minResults = 2): boolean {
  if (hasSerResults(body, undefined, minResults)) return false;
  return isBlocked(body);
}

/* ── DuckDuckGo (3-stage, fast switching: 12s per stage) ────────────────── */

/**
 * DDG's anomaly detector flags requests that don't look like real browser
 * navigations. Two things matter:
 *   1. A session cookie from a prior GET to the same host (cookie priming).
 *   2. The header set must match a browser navigation (Accept: text/html,
 *      full sec-ch-ua triplet) — NOT Accept: application/json.
 *
 * Each stage gets a fast 12s timeout instead of the 55s pool budget.
 * Stage A: html.duckduckgo.com/html/ — cookie-primed POST
 * Stage B: lite.duckduckgo.com/lite/ — cookie-primed POST, same-origin
 * Stage C: VQD token flow (duckduckgo.com → links.duckduckgo.com/d.js)
 */
const DDG_STAGE_TIMEOUT_MS = 12_000;

/**
 * Stage A: cookie-primed html.duckduckgo.com/html/ POST.
 * Fast-fail: 12s timeout; switch to lite if blocked/0 results.
 */
async function ddgHtml(query: string): Promise<RawSearchResult[]> {
  const jar = newCookieJar();
  const host = "https://html.duckduckgo.com";

  // Priming request: sets session cookies.
  const prime = await fetchPage(host + "/html/", {
    timeoutMs: DDG_STAGE_TIMEOUT_MS,
    headers: realisticHeaders({ referer: host + "/" }),
  } as any);
  if (prime?.cookies?.length) jar.absorb(host + "/html/", prime.cookies);
  const cookieVal = jar.cookieFor(host + "/html/");

  // POST with session cookies + realistic browser-navigate headers.
  // useRealisticHeaders ensures Accept: text/html (not application/json),
  // which is what DDG's anomaly detector expects for a form submission.
  const res = await fetchUrl(host + "/html/", {
    timeoutMs: DDG_STAGE_TIMEOUT_MS,
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
  // Parse FIRST — DDG's 202 body may contain "captcha" in script tags.
  if (!res || !res.ok || !res.text) return [];
  const results = parseDdgHtml(res.text);
  if (results.length >= 2) return results;
  // <2 results: check if it's a genuine block (202 challenge, 403, 429).
  if (res.status === 202 || res.status === 403 || res.status === 429) return [];
  if (isBlocked(res.text)) return [];
  return results;
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

/**
 * Stage B: lite.duckduckgo.com/lite/ POST.
 * Fast-fail: 6s timeout (spec Fix 1A); switch to VQD if this fails too.
 */
const DDG_LITE_TIMEOUT_MS = 6_000;
async function ddgLite(query: string): Promise<RawSearchResult[]> {
  const jar = newCookieJar();
  const host = "https://lite.duckduckgo.com";

  const prime = await fetchPage(host + "/lite/?q=test", {
    timeoutMs: DDG_LITE_TIMEOUT_MS,
    headers: realisticHeaders({ referer: host + "/" }),
  } as any);
  if (prime?.cookies?.length) jar.absorb(host + "/lite/", prime.cookies);
  const cookieVal = jar.cookieFor(host + "/lite/");

  const res = await fetchUrl(host + "/lite/", {
    timeoutMs: DDG_LITE_TIMEOUT_MS,
    method: "POST",
    body: "q=" + encodeURIComponent(query),
    useRealisticHeaders: true,
    headers: {
      ...(cookieVal ? { cookie: cookieVal } : {}),
      "content-type": "application/x-www-form-urlencoded",
      origin: host,
      referer: host + "/",
      "sec-fetch-site": "same-origin",
    },
  });
  if (!res?.text || res.status !== 200) return [];
  // Parse first, then check block.
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
  if (out.length >= 2) return out.slice(0, 10);
  if (isBlocked(res.text)) return [];
  return out.slice(0, 10);
}

/**
 * Stage C: VQD token flow (GET duckduckgo.com → links.duckduckgo.com/d.js).
 * Uses apiHeaders (JSON-accept is fine for the d.js endpoint — it returns JS).
 */
async function ddgVqd(query: string): Promise<RawSearchResult[]> {
  const res1 = await fetchPage("https://duckduckgo.com/?q=" + encodeURIComponent(query), {
    timeoutMs: DDG_STAGE_TIMEOUT_MS,
    headers: realisticHeaders({ referer: "https://duckduckgo.com/" }),
  } as any);
  if (!res1?.body) return [];
  const vqdMatch = res1.body.match(/"vqd"\s*:\s*"(\d+)"/) ?? res1.body.match(/vqd=(\d+)/);
  const vqd = vqdMatch?.[1];
  if (!vqd) return [];

  const res2 = await fetchUrl(
    `https://links.duckduckgo.com/d.js?q=${encodeURIComponent(query)}&vqd=${vqd}`,
    {
      timeoutMs: DDG_STAGE_TIMEOUT_MS,
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

async function ddgLitePost(query: string): Promise<RawSearchResult[]> {
  const gate = await enginePacerWithBreaker("ddg-lite");
  if (!gate.allowed) return [];
  try {
    return await ddgLitePostInner(query);
  } finally {
    gate.done();
  }
}
async function ddgLitePostInner(query: string): Promise<RawSearchResult[]> {
  const jar = newCookieJar();
  const host = "https://lite.duckduckgo.com";

  const prime = await fetchPage(host + "/lite/", {
    timeoutMs: DDG_LITE_TIMEOUT_MS,
    headers: realisticHeaders({ referer: host + "/" }),
  } as any).catch(() => null);
  if (prime?.cookies?.length) jar.absorb(host + "/", prime.cookies);
  const cookieVal = jar.cookieFor(host + "/");

  // POST with form-encoded body — much more resilient against 429s than
  // a GET to html.duckduckgo.com (no referrer fingerprint, no JS).
  const res = await fetchUrl(host + "/lite/", {
    timeoutMs: DDG_LITE_TIMEOUT_MS,
    method: "POST",
    body: "q=" + encodeURIComponent(query) + "&b=chrome",
    useRealisticHeaders: true,
    headers: {
      ...(cookieVal ? { cookie: cookieVal } : {}),
      "content-type": "application/x-www-form-urlencoded",
      origin: host,
      referer: host + "/",
      "sec-fetch-site": "same-origin",
    },
  }).catch(() => null);
  if (!res?.text || res.status !== 200) return [];
  const doc = docOf(res.text);
  const out: RawSearchResult[] = [];
  const links: any[] = doc.querySelectorAll("a.result-link, a.result-a");
  for (const a of links) {
    const href = a.getAttribute("href") ?? "";
    if (!href) continue;
    let url = decodeUddg(href);
    if (!isSafeUrl(url)) continue;
    out.push({
      title: a.textContent?.trim() ?? "",
      url,
      snippet: a.closest("tr")?.querySelector("td.result-snippet")?.textContent?.trim() ?? "",
      engine: "ddg-lite",
      rank: out.length + 1,
    });
  }
  if (out.length >= 2) noteEngineSuccess("ddg-lite");
  else tripCircuitBreaker("ddg-lite", "ddg-lite POST returned 0 results");
  return out.slice(0, 10);
}

/**
 * 3-stage DDG: try Stage A (cookie-primed html POST, 12s), fall back to
 * Stage B (lite POST, 6s fast timeout), then Stage C (VQD token, 12s)
 * only if Stage B returned some results.
 *
 * Fast-fail strategy:
 *   - Stage A: 12s. If 0 results → trip breaker (202/403/429 is the
 *     usual cause) and immediately try Stage B.
 *   - Stage B: 6s (DDG_LITE_TIMEOUT_MS). If 0 results → trip breaker
 *     and SKIP Stage C entirely. VQD is only useful when the IP is
 *     not rate-limited; when lite fails with 0, VQD will also be
 *     throttled so we abandon the DDG path and let the pool fuse
 *     results from the other engines.
 *
 * Total DDG wall-clock: 12s + 6s = 18s when all stages are attempted,
 * or ~12s when Stage B is skipped after Stage A's fast-fail.
 */
export async function ddgSearch(query: string): Promise<RawSearchResult[]> {
  const gate = await enginePacerWithBreaker("duckduckgo");
  if (!gate.allowed) return [];
  try {
    return await ddgSearchInner(query);
  } finally {
    gate.done();
  }
}
async function ddgSearchInner(query: string): Promise<RawSearchResult[]> {
  const stageA = await ddgHtml(query).catch(() => [] as RawSearchResult[]);
  if (stageA.length > 0) { noteEngineSuccess("duckduckgo"); return stageA; }
  // Stage A 0-result is NOT a trip observation by itself: the lite
  // endpoint may still answer, and a genuinely empty query (a niche
  // `site:` operator) legitimately 0s on every endpoint. One zero
  // observation per engine CALL — tripping per stage let a single empty
  // query self-cooldown DDG before a re-hop seconds later (measured).
  const stageB = await ddgLite(query).catch(() => [] as RawSearchResult[]);
  if (stageB.length > 0) { noteEngineSuccess("duckduckgo"); return stageB; }
  // Both endpoints 0 for this query. Skip Stage C entirely (VQD will
  // also be throttled when the IP is rate-limited).
  tripCircuitBreaker("duckduckgo", "both endpoints returned 0 results for this query");
  return [];
}

/* ── Yahoo (Bing index, RU= redirect unwrap) ────────────────────────────── */

export async function yahooSearch(query: string): Promise<RawSearchResult[]> {
  const gate = await enginePacerWithBreaker("yahoo");
  if (!gate.allowed) return [];
  try {
    return await yahooSearchInner(query);
  } finally {
    gate.done();
  }
}
async function yahooSearchInner(query: string): Promise<RawSearchResult[]> {
  const regions = [
    "https://in.search.yahoo.com/search?p=" + encodeURIComponent(query) + "&n=15",
    "https://search.yahoo.com/search?p=" + encodeURIComponent(query) + "&n=15",
  ];
  for (const url of regions) {
    try {
      const res = await fetchPage(url, {
        timeoutMs: ENGINE_TIMEOUT_MS,
        headers: realisticHeaders({
          referer: url.split("/search")[0] + "/",
          "sec-fetch-site": "same-origin",
        }),
      } as any);
      // Yahoo may return 307/500 but impit follows redirects — parse
      // FIRST: if the body has ≥2 result links, the page is a valid SERP.
      if (!res?.body || res.body.length < 500) continue;
      const doc = docOf(res.body);
      const out: RawSearchResult[] = [];
      const results: any[] = doc.querySelectorAll(
        "h3.title, .compTitle a, .algo a[href], li.strm, div.dd.algo a[href^='http'], a[href*='RU=']",
      );
      for (const el of results) {
        let href = el.getAttribute("href") ?? "";
        if (!href) continue;
        let target = unwrapRuHref(href, url);
        if (target.startsWith("/")) {
          try { target = new URL(target, url).href; } catch { continue; }
        }
        if (!isSafeUrl(target)) continue;
        try {
          const tHost = new URL(target).hostname.toLowerCase();
          if (/^(www\.)?yahoo\.com$/.test(tHost) && !target.includes("/r/")) continue;
          if (tHost.includes(".aol.") || tHost.includes("bing.com/aclick")) continue;
        } catch { /* ignore */ }
        out.push({
          title: el.textContent?.trim() ?? "",
          url: target,
          snippet:
            el.closest("li, div")?.querySelector(".compText, .snippet, p, .fz-ms")?.textContent?.trim() ?? "",
          engine: "yahoo",
          rank: out.length + 1,
        });
        if (out.length >= 15) break;
      }
      if (out.length >= 2) { noteEngineSuccess("yahoo"); return out; }
      if (isBlocked(res.body)) continue;
      if (out.length > 0) { noteEngineSuccess("yahoo"); return out; }
    } catch { /* try next regional URL */ }
  }
  // Both regions returned 0 results — trip the breaker.
  tripCircuitBreaker("yahoo", "both regions returned 0 results");
  return [];
}

/* ── Google (Web SERP, got-scraping header fingerprints) ────────────────── */

/** Unwrap legacy /url?q= redirect links Google emits for organic results. */
function unwrapGoogleHref(href: string): string {
  try {
    const u = new URL(href, "https://www.google.com");
    if (u.pathname === "/url") {
      const q = u.searchParams.get("q");
      if (q) return decodeURIComponent(q);
      const m = u.href.match(/[?&]url=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return u.href;
  } catch {
    return href;
  }
}

/**
 * Google Web search through the classic HTML SERP endpoint. got-scraping's
 * header-generator fingerprints (rotating Chrome/Firefox HTTP/2 headers via
 * net.ts) get past the consent/bot heuristics that sink raw fetches.
 * Parse-first rule: the page is only judged blocked when the parser finds
 * zero results (isBlockedAfterParse), never before.
 */
/* Local app, local context (2026-11-04 pivot): Google's `gl` region
 * comes from the machine's own Intl locale (en-IN → "in"), so brand
 * and commerce queries rank the user's country's sites first. No
 * hardcoded location — it IS the user's system. */
function systemGl(): string {
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US";
    const region = locale.split("-").filter(Boolean).pop() ?? "US";
    return region.length === 2 ? region.toLowerCase() : "us";
  } catch {
    return "us";
  }
}

/* Google's HTML SERP is a JS-required shell for scraper fingerprints
 * (live-probed 2026-11-04: 200 OK, 94 KB, organic results absent), so
 * when the HTTP tier comes back empty the SERP is rendered in the
 * stealth browser pool instead — the same real-Chromium tier that reads
 * Cloudflare-Walled sites. Dynamic import keeps playwright out of every
 * module graph that only needs the HTTP engines. */
async function googleSerpFallback(query: string): Promise<RawSearchResult[]> {
  try {
    const { readGoogleSerp } = await import("./agentBrowser");
    const rows = await readGoogleSerp(query, systemGl(), { timeoutMs: 12_000 });
    if (rows.length >= 2) {
      noteEngineSuccess("google");
      return rows.map((r, i) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        engine: "google",
        rank: i + 1,
      }));
    }
  } catch {
    /* pool unavailable / render failed — honest zero */
  }
  return [];
}

export async function googleSearch(query: string): Promise<RawSearchResult[]> {
  const gate = await enginePacerWithBreaker("google");
  if (!gate.allowed) return [];
  try {
    return await googleSearchInner(query);
  } finally {
    gate.done();
  }
}
async function googleSearchInner(query: string): Promise<RawSearchResult[]> {
  const res = await fetchPage(
    "https://www.google.com/search?q=" +
      encodeURIComponent(query) +
      "&num=20&hl=en&gl=" + systemGl(),
    {
      timeoutMs: ENGINE_TIMEOUT_MS,
      headers: realisticHeaders({ referer: "https://www.google.com/" }),
    } as any,
  );
  if (!res?.body || res.body.length < 500) {
    const fb = await googleSerpFallback(query);
    if (fb.length > 0) return fb;
    tripCircuitBreaker("google", "google HTTP empty response + browser tier no results");
    return [];
  }

  const doc = docOf(res.body);
  const out: RawSearchResult[] = [];
  const blocks: any[] = doc.querySelectorAll("div.g, .MjjYud, div.s");
  for (const div of blocks) {
    const a = div.querySelector("a[href^='http'], a[href^='/url']");
    if (!a) continue;
    const url = unwrapGoogleHref(a.getAttribute("href") ?? "");
    if (!isSafeUrl(url)) continue;
    try {
      const host = new URL(url).hostname;
      if (host === "google.com" || host.endsWith(".google.com")) continue;
    } catch {
      continue;
    }
    out.push({
      title:
        div.querySelector("h3")?.textContent?.trim() ??
        a.textContent?.trim() ??
        "",
      url,
      snippet:
        div.querySelector(".VwiC3b, .IsZvec, span.st, .st")?.textContent?.trim() ??
        "",
      engine: "google",
      rank: out.length + 1,
    });
    if (out.length >= 15) break;
  }

  if (out.length >= 2) { noteEngineSuccess("google"); return out; }
  if (!res.ok || isBlocked(res.body)) {
    tripCircuitBreaker("google", "google returned " + res.status + " with no results");
    return [];
  }
  // 200 OK but no organic anchors in the HTML: the JS-required shell.
  // Render the SERP in the stealth pool.
  const browsed = await googleSerpFallback(query);
  if (browsed.length > 0) return browsed;
  if (out.length === 0) {
    tripCircuitBreaker("google", "google HTTP + browser tiers both returned no results");
  } else {
    noteEngineSuccess("google");
  }
  return out;
}

/* ── Brave (own index, SSR HTML + __INITIAL_STATE__) ────────────────────── */

export async function braveSearch(query: string): Promise<RawSearchResult[]> {
  const gate = await enginePacerWithBreaker("brave");
  if (!gate.allowed) return [];
  try {
    return await braveSearchInner(query);
  } finally {
    gate.done();
  }
}
async function braveSearchInner(query: string): Promise<RawSearchResult[]> {
  const res = await fetchPage(
    "https://search.brave.com/search?q=" + encodeURIComponent(query) + "&source=web",
    {
      timeoutMs: ENGINE_TIMEOUT_MS,
      headers: realisticHeaders({ referer: "https://search.brave.com/" }),
    } as any,
  );
  // Fail fast on a genuinely empty/throttled 429: if there is no body
  // content to parse, don't waste time on a parser pass.
  if (!res?.body || res.body.length < 500) return [];
  // Parse FIRST on any non-empty body (including a 429 that still carries
  // a valid SERP). Pages with real results are never discarded by
  // false-positive "captcha" strings in <script> tags.
  const doc = docOf(res.body);
  const out: RawSearchResult[] = [];

  // Primary: #results / div#web-results > div with a.result-header / .snippet-description
  const results: any[] = doc.querySelectorAll(
    "#results > div, div#web-results > div, .result, .snippet, div.web-result",
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
        div.querySelector(".snippet-description, .snippet, .desc, .fb, p")?.textContent?.trim() ?? "",
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

  // Return results whenever the parser found ≥2 — regardless of the HTTP
  // status (429 with a valid body still serves real results).
  if (out.length >= 2) { noteEngineSuccess("brave"); return out.slice(0, 15); }
  // No results: a non-200 status or a genuine block → trip the breaker.
  if (!res.ok || isBlocked(res.body)) {
    tripCircuitBreaker("brave", "brave returned " + res.status + " with no results");
    return [];
  }
  if (out.length > 0) noteEngineSuccess("brave");
  return out.slice(0, 15);
}

/* ── Reddit (3-stage keyless community cascade) ─────────────────────────── */

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
  const gate = await enginePacer("reddit");
  try {
    const stageA = await redditRss(query).catch(() => [] as RawSearchResult[]);
    if (stageA.length > 0) return stageA;
    const stageB = await redditPullPush(query).catch(() => [] as RawSearchResult[]);
    if (stageB.length > 0) return stageB;
    const stageC = await redditJson(query).catch(() => [] as RawSearchResult[]);
    if (stageC.length > 0) return stageC;
    log.warn({ query: query.slice(0, 80) }, "reddit: all 3 stages returned 0 results");
    return [];
  } finally {
    gate.done();
  }
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
    host + "/search?q=" + encodeURIComponent(query) + "&setlang=en&cc=US",
    {
      timeoutMs: 30_000,
      headers: {
        ...realisticHeaders(cookieVal ? { cookie: cookieVal } : { referer: host + "/" }),
        "accept-language": "en-US,en;q=0.9",
      },
    } as any,
  );
  if (!res?.ok || !res?.body) return [];
  const doc = docOf(res.body);
  const out: RawSearchResult[] = [];
  // Bing HTML parse-first (captcha strings in <script> tags on valid SERPs).
  // b_algo blocks: <li class="b_algo" ...><h2 ...><a href="/ck/a?...">…</a>
  // Snippet: .b_caption p or p.b_lineclamp...
  const results: any[] = doc.querySelectorAll("li.b_algo, div.b_algo, li.b_ans");
  for (const div of results) {
    // Title link: h2 > a (with attributes) OR /ck/a link OR direct http
    const a = div.querySelector("h2 a, a[href^='/ck/'], a[href^='http']");
    if (!a) continue;
    let href = a.getAttribute("href") ?? "";
    if (href.startsWith("/ck/")) href = host + href;
    const target = decodeBingCk(href);
    if (!isSafeUrl(target)) continue;
    // Filter out bing.com internal links (settings, help, feedback).
    try {
      const tHost = new URL(target).hostname.toLowerCase();
      if (tHost === "www.bing.com" || tHost === "bing.com") {
        // Keep /search results, skip internal bing.com pages
        if (!target.includes("/search")) continue;
      }
    } catch { /* ignore */ }
    out.push({
      title: a.textContent?.trim() ?? "",
      url: target,
      snippet:
        div.querySelector(".b_caption p, .b_caption .b_lineclamp, p.b_lineclamp, p")?.textContent?.trim() ?? "",
      engine: "bing",
      rank: out.length + 1,
    });
  }
  if (out.length >= 2) return out.slice(0, 15);
  if (isBlocked(res.body)) return [];
  return out.slice(0, 15);
}

/**
 * 2-stage Bing: RSS feed → cookie-primed HTML.
 * Returns the first stage that produces results.
 */
export async function bingSearch(query: string): Promise<RawSearchResult[]> {
  const gate = await enginePacer("bing");
  try {
    const stageA = await bingRss(query).catch(() => [] as RawSearchResult[]);
    if (stageA.length > 0) return stageA;
    const stageB = await bingHtml(query).catch(() => [] as RawSearchResult[]);
    if (stageB.length > 0) return stageB;
    log.warn({ query: query.slice(0, 80) }, "bing: both stages returned 0 results");
    return [];
  } finally {
    gate.done();
  }
}

/* ── Bing News RSS + Google News fallback (keyless, real target URLs) ────── */

/**
 * Bing News RSS (primary) + Google News RSS fallback.
 *
 * - Bing News RSS: each <item><link> is a click-tracker that carries the
 *   REAL publisher URL in its url= query parameter. We extract that so
 *   extractor.ts receives real, extractable web pages.
 * - Google News RSS (fallback when Bing returns 0): use the
 *   <source url="..."> attribute (the authoritative publisher domain)
 *   and drop any item that has no source (encrypted google.com/rss/articles/
 *   wrappers fail full-page extraction and must be avoided).
 */
export async function bingNewsRssSearch(query: string): Promise<RawSearchResult[]> {
  const gate = await enginePacer("bing-news");
  try {
    return await bingNewsRssSearchInner(query);
  } finally {
    gate.done();
  }
}
async function bingNewsRssSearchInner(query: string): Promise<RawSearchResult[]> {
  // ── Stage A: Bing News RSS (real target URLs via url= param) ────────
  const bingUrl =
    "https://www.bing.com/news/search?q=" +
    encodeURIComponent(query) +
    "&format=rss&count=20";
  try {
    const res = await fetchUrl(bingUrl, {
      timeoutMs: 15_000,
      headers: {
        ...realisticHeaders({
          accept: "application/rss+xml, application/xml, text/xml;q=0.9",
          referer: "https://www.bing.com/",
        }),
      },
    } as any);
    if (res?.ok && res.text) {
      const out = parseBingNewsRss(res.text);
      if (out.length > 0) return out;
    }
  } catch { /* fall through to Google News */ }

  // ── Stage B: Google News RSS fallback (source-url extraction) ──────
  // Only keep items where <source url="..."> gave us the real
  // publisher URL — encrypted news.google.com/rss/articles/ wrappers
  // are NOT extractable and must be skipped.
  const gnewsUrl =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(query) +
    "&hl=en-IN&gl=IN&ceid=IN:en";
  try {
    const res = await fetchUrl(gnewsUrl, {
      timeoutMs: 15_000,
      headers: {
        ...realisticHeaders({
          accept: "application/rss+xml, application/xml, text/xml;q=0.9",
          referer: "https://news.google.com/",
        }),
      },
    } as any);
    if (!res?.ok || !res.text) return [];
    const out: RawSearchResult[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(res.text)) !== null && out.length < 25) {
      const item = m[1];
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const pubDateMatch = item.match(/<pubDate>([^<]+)<\/pubDate>/);
      // <source url="..."> = the authoritative publisher URL.
      const sourceMatch = item.match(/<source[^>]*url="([^"]+)"/);
      const target = sourceMatch?.[1]?.trim() ?? "";
      if (!target || !isSafeUrl(target)) continue;
      out.push({
        title: titleMatch?.[1]?.trim().replace(/\s+/g, " ") ?? "",
        url: target,
        snippet: "",
        engine: "google-news",
        publishedDate: pubDateMatch?.[1],
        rank: out.length + 1,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Parse Bing News RSS: extract real target URL from the url= param. */
function parseBingNewsRss(xml: string): RawSearchResult[] {
  const out: RawSearchResult[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && out.length < 25) {
    const item = m[1];
    const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?<\/title>/);
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
    const pubDateMatch = item.match(/<pubDate>([^<]+)<\/pubDate>/);
    const descMatch = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);

    // Bing wraps news links as:
    //   http://www.bing.com/news/apiclick.aspx?...&url=https%3a%2f%2f<real-domain>/...
    let target = linkMatch?.[1]?.trim().replace(/&amp;/g, "&") ?? "";
    try {
      const u = new URL(target);
      const urlParam = u.searchParams.get("url");
      if (urlParam) target = decodeURIComponent(urlParam);
    } catch { /* keep as-is */ }

    if (!isSafeUrl(target)) continue;
    out.push({
      title: titleMatch?.[1]?.trim().replace(/\s+/g, " ") ?? "",
      url: target,
      snippet: descMatch?.[1]?.replace(/<[^>]+>/g, "").slice(0, 400) ?? "",
      engine: "bing-news",
      publishedDate: pubDateMatch?.[1],
      rank: out.length + 1,
    });
  }
  return out;
}
/* ── GitHub (repos + issues, keyless API) ─────────────────────────────────── */

/**
 * GitHub search: keyless REST API for repo + issue search.
 * Returns real project/issue results for tech/coding queries.
 * Zero CAPTCHAs — GitHub's API allows 60 unauthenticated req/hr/IP.
 */
export async function githubSearch(query: string): Promise<RawSearchResult[]> {
  const gate = await enginePacerWithBreaker("github");
  if (!gate.allowed) return [];
  try {
    return await githubSearchInner(query);
  } finally {
    gate.done();
  }
}
async function githubSearchInner(query: string): Promise<RawSearchResult[]> {
  const out: RawSearchResult[] = [];

  // 0. User search — instant JSON for developer portfolios / named devs
  //    (the .dev domain case: "skiran" → their GitHub profile).
  try {
    const userRes = await fetchUrl(
      "https://api.github.com/search/users?q=" +
        encodeURIComponent(query) +
        "&per_page=5",
      {
        timeoutMs: 12_000,
        headers: {
          ...apiHeaders({ "accept": "application/vnd.github+json" }),
          "x-github-api-version": "2022-11-28",
        },
      } as any,
    );
    if (userRes?.ok && userRes.text) {
      const data: any = JSON.parse(userRes.text);
      for (const u of data.items ?? []) {
        out.push({
          title: `GitHub: ${u.login}`,
          url: u.html_url ?? "https://github.com/" + u.login,
          snippet: `${u.type ?? "User"} — GitHub profile for "${query}"`,
          engine: "github",
          rank: out.length + 1,
        });
      }
    }
  } catch { /* try repos next */ }

  // 1. Repository search
  try {
    const repoRes = await fetchUrl(
      "https://api.github.com/search/repositories?q=" +
        encodeURIComponent(query) +
        "&per_page=8",
      {
        timeoutMs: 15_000,
        headers: {
          ...apiHeaders({ "accept": "application/vnd.github+json" }),
          "x-github-api-version": "2022-11-28",
        },
      } as any,
    );
    if (repoRes?.ok && repoRes.text) {
      const data: any = JSON.parse(repoRes.text);
      for (const repo of data.items ?? []) {
        out.push({
          title: repo.name,
          url: repo.html_url ?? "https://github.com/" + repo.full_name,
          snippet: (repo.description ?? "").slice(0, 400),
          engine: "github",
          rank: out.length + 1,
        });
      }
    }
  } catch { /* try issues next */ }

  // 2. Issue search (fills gaps when repo search is sparse)
  if (out.length < 5) {
    try {
      const issueRes = await fetchUrl(
        "https://api.github.com/search/issues?q=" +
          encodeURIComponent(query) +
          "&per_page=8",
        {
          timeoutMs: 15_000,
          headers: {
            ...apiHeaders({ "accept": "application/vnd.github+json" }),
            "x-github-api-version": "2022-11-28",
          },
        } as any,
      );
      if (issueRes?.ok && issueRes.text) {
        const data: any = JSON.parse(issueRes.text);
        for (const item of data.items ?? []) {
          const url = item.pull_request?.url ?? item.html_url ?? "";
          if (!isSafeUrl(url)) continue;
          out.push({
            title: item.title ?? "",
            url,
            snippet: (item.body ?? "").slice(0, 400),
            engine: "github",
            publishedDate: item.created_at,
            rank: out.length + 1,
          });
        }
      }
    } catch { /* ignore */ }
  }

  return out.slice(0, 15);
}

/* ── Dev.to (keyless JSON API, technical tutorials) ───────────────────────── */

/**
 * Dev.to search: keyless JSON API returning full technical tutorials and
 * best-practice articles. Two endpoints:
 *   1. Tagged feed: GET /api/articles?per_page=15&top=365&tag=<tech_tag>
 *   2. Free-text search: GET /search/feed_content?per_page=15&page=0&
 *      class_name=Article&search_fields=<encoded_query>
 *
 * The tag endpoint is used when the query contains a recognisable tech
 * tag (a known language / framework / library); the free-text endpoint
 * is the fallback for arbitrary queries.
 */
const DEVTO_TECH_TAGS = new Set([
  "javascript", "typescript", "node", "nodejs", "python", "rust", "go",
  "golang", "java", "kotlin", "swift", "ruby", "php", "c", "c++",
  "react", "nextjs", "next.js", "vue", "angular", "svelte",
  "express", "nestjs", "django", "flask", "fastapi",
  "reactjs", "html", "css", "sql", "graphql", "postgres",
  "linux", "git", "docker", "kubernetes", "terraform",
  "aws", "azure", "gcp", "firebase",
]);

/**
 * Extract a Dev.to tag from a query: the first token that matches a
 * known tech tag (case-insensitive, dotted names like "next.js" map
 * to the "nextjs" tag Dev.to uses).
 */
function devtoTagForQuery(query: string): string | null {
  const tokens = query.toLowerCase().replace(/[._-]/g, "").split(/\s+/);
  for (const t of tokens) {
    if (DEVTO_TECH_TAGS.has(t)) return t;
  }
  return null;
}

export async function devToSearch(query: string): Promise<RawSearchResult[]> {
  const gate = await enginePacerWithBreaker("devto");
  if (!gate.allowed) return [];
  try {
    return await devToSearchInner(query);
  } finally {
    gate.done();
  }
}
async function devToSearchInner(query: string): Promise<RawSearchResult[]> {
  const out: RawSearchResult[] = [];

  // 1. Tagged feed (when the query contains a known tech tag).
  const tag = devtoTagForQuery(query);
  if (tag) {
    try {
      const tagUrl = "https://dev.to/api/articles?per_page=15&top=365&tag=" + encodeURIComponent(tag);
      const tagRes = await fetchUrl(tagUrl, {
        timeoutMs: 15_000,
        headers: { ...apiHeaders({ accept: "application/json" }), referer: "https://dev.to/" },
      } as any);
      if (tagRes?.ok && tagRes.text) {
        const data: any = JSON.parse(tagRes.text);
        for (const article of Array.isArray(data) ? data : []) {
          const url = article?.url ?? "https://dev.to/" + (article?.user?.username ?? "") + "/" + (article?.slug ?? "");
          if (!isSafeUrl(url)) continue;
          out.push({
            title: article?.title ?? "",
            url,
            snippet: (article?.tag_list?.join(", ") ?? "") + " — " + (article?.description ?? "").slice(0, 200),
            engine: "devto",
            publishedDate: article?.published_at,
            rank: out.length + 1,
          });
        }
      }
    } catch { /* fall through to free-text search */ }
  }

  // 2. Free-text search (fills gaps when tag feed is sparse or tag is null).
  if (out.length < 5) {
    try {
      const searchUrl =
        "https://dev.to/search/feed_content?per_page=15&page=0&class_name=Article&search_fields=" +
        encodeURIComponent(query);
      const searchRes = await fetchUrl(searchUrl, {
        timeoutMs: 15_000,
        headers: { ...apiHeaders({ accept: "application/json" }), referer: "https://dev.to/" },
      } as any);
      if (searchRes?.ok && searchRes.text) {
        const data: any = JSON.parse(searchRes.text);
        const items: any[] = data?.items ?? data?.results ?? (Array.isArray(data) ? data : []);
        for (const item of items) {
          const url = item?.url ?? item?.link ?? "";
          if (!isSafeUrl(url)) continue;
          out.push({
            title: item?.title ?? "",
            url,
            snippet: (item?.description ?? item?.snippet ?? "").slice(0, 400),
            engine: "devto",
            publishedDate: item?.published_at ?? item?.created_at,
            rank: out.length + 1,
          });
        }
      }
    } catch { /* ignore */ }
  }

  if (out.length === 0) tripCircuitBreaker("devto", "dev.to returned 0 results");
  else noteEngineSuccess("devto");
  return out.slice(0, 15);
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * Deduplicate sub-queries that share >80% token overlap.
 *
 * Before the search gate's 4 sub-queries are fanned out to the pool, this
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
 * Strictly general-web + community engines. News/dev verticals
 * (bingNewsRssSearch, githubSearch, devToSearch) are routed by intent
 * in metasearch.ts, NOT run on every sub-query.
 *
 * Every sub-query in a plan is distributed across this pool with
 * per-engine pacing (one in-flight per host, 250–450 ms jitter) so that
 * 4 sub-queries × 6 engines never fire 24 simultaneous requests at any
 * single host.
 */
/* Engine priority law (2026-11-04, user): Google is the #1 source for
   every search, Brave #2, the rest only when both of those failed.
   The array order IS that law — the fallback paths below slice off the
   first two entries once they've already been tried in priority order. */
export const GENERAL_WEB_ENGINES = [
  googleSearch,          // Google live web index (got-scraping fingerprints, parse-first) — PRIORITY 1
  braveSearch,           // Brave's own index — PRIORITY 2
  ddgSearch,             // DuckDuckGo (3-stage: cookie-primed html POST → lite POST → VQD, 12s per stage)
  ddgLitePost,           // DDG Lite form-POST — resilient when html.duckduckgo.com 429s
  bingSearch,            // Bing (RSS feed → cookie-primed HTML, ck/a decode, parse-first)
  yahooSearch,           // Bing global web index (RU= unwrap, parse-first)
  redditSearch,          // community ground-truth (3-stage: RSS → PullPush → JSON)
] as const;

/* A priority attempt is abandoned when it exceeds its cap: ENGINE_TIMEOUT_MS
   (40s) is the net-cascade ceiling, but the metasearch searchOne cap is far
   tighter — an engine that hasn't answered by now counts as "didn't work"
   and the next-priority engine takes over. Google's cap is wider than the
   others because its working tier is the browser SERP (render ~4s + signed
   redirect resolution), not a plain HTTP fetch. */
const GOOGLE_ATTEMPT_CAP_MS = 20_000;
const BRAVE_ATTEMPT_CAP_MS = 12_000;

function attempt<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/* ── Evidence-gap recovery law (P4, staged-research brief §4/§6) ─────────
   "Google answered" used to mean "returned anything at all" — a consent
   wall, CAPTCHA interstitial or generic-junk SERP therefore ENDED all
   further provider investigation even when no result title/snippet/URL
   contained a single content word of the query. The engine priority law
   stands (Google #1, Brave #2, rest only when both failed); this law only
   sharpens "failed" to include "answered but the answer never touches the
   query's own vocabulary": a provider counts as answering ONLY when at
   least half of the query's content words appear somewhere in its result
   text. Vocabulary self-overlap, entity knowledge never consulted — the
   SAME 0.5 coverage law as query-planner.evaluateCoverage, and the same
   function-word filter as its GAP_STOPWORDS (the metasearch → engines
   import cycle forbids reuse, so this filter mirrors it — same precedent
   as metasearch.ts:837 mirroring query-planner's GENERIC word set). NO
   brand/site/domain table, NO URL template, NO magic phrase. */
const POOL_QUERY_STOPWORDS = new Set([
  "which", "what", "when", "where", "who", "whose", "why", "how",
  "does", "do", "did", "can", "could", "would", "should", "will", "shall",
  "is", "are", "was", "were", "be", "been", "being", "the", "a", "an",
  "for", "of", "in", "on", "at", "to", "and", "or", "with", "about",
  "from", "tell", "me", "please", "give", "show", "list", "any", "all",
]);

/** Search-one budget guard: searchOne races the whole pool at
   SEARCH_ONE_CAP_MS (40 s). Recovery adds a provider tier that the old
   early-return never reached — once the priority attempts have already
   burned most of that wall clock, asking the fallback pool just guarantees
   the cap fires and the caller gets NOTHING. shortcut: fixed constant,
   not threaded state; upgrade trigger = SEARCH_ONE_CAP_MS ever moves. */
const RECOVERY_POOL_TIME_GUARD_MS = 25_000;

/** The recovery predicate: is this provider's SERP grounded in the query's
   own words? (empty results = never answered.) WS12 audit refinements
   (2026-11-05 item 12): tokenization keeps EVERY script — letters, numbers
   and combining marks, the same general-category classes the gate tokenizer
   uses (ICU script-name properties are unavailable on this Node build) —
   so a non-Latin query gets real content terms instead of being stripped
   to an empty set; an EMPTY/unjudgeable term set is UNKNOWN relevance,
   NOT success (the old benefit-of-the-doubt TRUE let stripped queries and
   junk SERPs suppress recovery; the never-lose law in the cascade still
   returns the priority provider's non-empty results when recovery finds
   nothing better). Short content queries (≤ 3 terms) must be FULLY
   covered — half of a two-term entity+generic fragment is precisely the
   audit's "absent distinguishing entity" hole; longer queries keep the
   established 0.5 boundary (same law as query-planner.evaluateCoverage). */
export function serpCoversQuery(query: string, results: RawSearchResult[]): boolean {
  if (results.length === 0) return false;
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => [...w].length > 2 && !POOL_QUERY_STOPWORDS.has(w));
  if (terms.length === 0) return false;
  const haystack = results
    .map((r) => `${r.title} ${r.snippet} ${r.url}`)
    .join(" ")
    .toLowerCase();
  const hits = terms.filter((t) => haystack.includes(t)).length;
  if (terms.length <= 3) return hits === terms.length;
  return hits / terms.length >= 0.5;
}

/**
 * Priority run for a single query: Google first; if Google answered AND
 * its results are grounded in the query vocabulary, its results are used
 * and no other engine is consulted at all. If Google failed (block,
 * timeout, parse-miss) OR answered with a SERP that never touches the
 * query's own content words (evidence-gap recovery), Brave; only if Brave
 * also failed/missed does the rest of the pool run. The pool is skipped
 * when the priority attempts already burned the searchOne budget
 * (RECOVERY_POOL_TIME_GUARD_MS), and a fully-failed cascade still returns
 * the priority providers' non-empty results rather than nothing.
 */
export async function runGeneralWebSearch(query: string): Promise<RawSearchResult[]> {
  // (audit 2026-11-04) Secret scrub is enforced HERE, at the shared engine
  // entry point — the metasearch-side scrub only covered the metasearch
  // path; any other caller of this export used to ship tokens/keys sitting
  // in a query string straight to Google/Brave/DDG. scrubQuerySecrets is
  // idempotent, so the upstream scrub costs nothing.
  query = scrubQuerySecrets(query);
  const startedAt = Date.now();
  const googleResults = await attempt(
    googleSearch(query).catch(() => [] as RawSearchResult[]),
    GOOGLE_ATTEMPT_CAP_MS,
    [] as RawSearchResult[],
  );
  if (serpCoversQuery(query, googleResults)) return googleResults;
  if (googleResults.length > 0) {
    log.info(
      { results: googleResults.length },
      "evidence-gap recovery: Google answered but its result text never touches the query vocabulary — asking Brave",
    );
  }

  const braveResults = await attempt(
    braveSearch(query).catch(() => [] as RawSearchResult[]),
    BRAVE_ATTEMPT_CAP_MS,
    [] as RawSearchResult[],
  );
  if (serpCoversQuery(query, braveResults)) return braveResults;

  const gapRecovery = googleResults.length > 0 || braveResults.length > 0;
  if (gapRecovery && Date.now() - startedAt > RECOVERY_POOL_TIME_GUARD_MS) {
    return braveResults.length > 0 ? braveResults : googleResults;
  }

  const settled = await Promise.allSettled(
    GENERAL_WEB_ENGINES.slice(2).map((fn) => fn(query).catch(() => [] as RawSearchResult[])),
  );
  const out: RawSearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  // Never-lose law: recovery must not make a poor provider answer WORSE
  // than the old early-return — an empty fallback pool returns the
  // priority providers' results (priority order preserved) instead of [].
  if (out.length > 0) return out;
  return braveResults.length > 0 ? braveResults : googleResults;
}

/**
 * Priority metasearch (2026-11-04 engine priority law — user):
 *
 *   1. Google — the #1 source for every search in the plan. When Google
 *      answers the primary query, ONLY Google's results are used (its
 *      rank order is the best available ranking signal) and no other
 *      engine is asked at all.
 *   2. Brave — same all-or-nothing rule, tried only when Google failed.
 *   3. The rest of the pool — DDG (HTML + lite), Bing, Yahoo, Reddit,
 *      Bing News RSS, GitHub — staggered as before, and only reached
 *      when BOTH priority engines failed or timed out (their circuit
 *      breakers are typically open by then, so re-asking them would
 *      just burn load).
 *
 * "Failed" includes a timeout: each priority attempt is race-capped at
 * GOOGLE/BRAVE_ATTEMPT_CAP_MS so one hung engine cannot eat the whole
 * searchOne wall-clock budget. The stagger between fallback engines
 * (150-300 ms) is what prevents the production 429 cascade observed
 * during the November engine-throttle night.
 *
 * Evidence-gap recovery (P4) applies the same law as runGeneralWebSearch:
 * a priority engine counts as answering only when its MERGED results are
 * grounded in the primary query's own vocabulary (serpCoversQuery); a
 * nonempty-but-ungrounded SERP falls through to the next tier, subject to
 * the RECOVERY_POOL_TIME_GUARD_MS budget guard and the never-lose
 * fallback. Coverage is judged against the merged multi-query result set,
 * so a paraphrase query whose results legitimately lack primary terms
 * still counts once ANY tier result touches them — conservative.
 *
 * Returns the merged raw result list for RRF fusion.
 */
export async function runGeneralWebSearchSharded(
  primaryQuery: string,
  allQueries: string[],
): Promise<RawSearchResult[]> {
  // Same entry-point scrub law as runGeneralWebSearch.
  primaryQuery = scrubQuerySecrets(primaryQuery);
  allQueries = allQueries.map(scrubQuerySecrets);
  const startedAt = Date.now();
  const stagger = () => new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 150)));

  const runPriorityEngine = async (
    fn: (q: string) => Promise<RawSearchResult[]>,
    primaryCapMs: number,
    restCapMs: number,
  ): Promise<RawSearchResult[]> => {
    const primary = await attempt(
      fn(primaryQuery).catch(() => [] as RawSearchResult[]),
      primaryCapMs,
      [] as RawSearchResult[],
    );
    if (primary.length === 0) return [];
    const out: RawSearchResult[] = [...primary];
    const rest: Promise<RawSearchResult[]>[] = [];
    for (const q of allQueries) {
      if (q === primaryQuery) continue;
      rest.push(
        attempt(fn(q).catch(() => [] as RawSearchResult[]), restCapMs, [] as RawSearchResult[]),
      );
    }
    for (const r of await Promise.all(rest)) out.push(...r);
    return out;
  };

  /* Google's rest-query cap is wider than Brave's: by the time the
     extra queries run, the browser pool is warm, but each one still
     pays SERP render + redirect resolution. */
  const googleResults = await runPriorityEngine(googleSearch, GOOGLE_ATTEMPT_CAP_MS, 15_000);
  if (serpCoversQuery(primaryQuery, googleResults)) return googleResults;
  if (googleResults.length > 0) {
    log.info(
      { results: googleResults.length },
      "evidence-gap recovery: Google answered but its result text never touches the query vocabulary — asking Brave",
    );
  }

  const braveResults = await runPriorityEngine(braveSearch, BRAVE_ATTEMPT_CAP_MS, 8_000);
  if (serpCoversQuery(primaryQuery, braveResults)) return braveResults;

  const gapRecovery = googleResults.length > 0 || braveResults.length > 0;
  if (gapRecovery && Date.now() - startedAt > RECOVERY_POOL_TIME_GUARD_MS) {
    return braveResults.length > 0 ? braveResults : googleResults;
  }

  // Fallback pool — Google and Brave just failed (or answered without
  // grounding); everyone else pays.
  const tier1: Promise<RawSearchResult[]>[] = [];
  for (let i = 0; i < allQueries.length; i++) {
    if (i > 0) await stagger();
    tier1.push(ddgLitePost(allQueries[i]).catch(() => [] as RawSearchResult[]));
  }
  await stagger();
  const tier2: Promise<RawSearchResult[]>[] = [
    ddgSearch(primaryQuery).catch(() => [] as RawSearchResult[]),
  ];
  await stagger();
  tier2.push(bingSearch(primaryQuery).catch(() => [] as RawSearchResult[]));
  await stagger();
  tier2.push(yahooSearch(primaryQuery).catch(() => [] as RawSearchResult[]));

  const tier3: Promise<RawSearchResult[]>[] = [];
  for (let i = 0; i < allQueries.length; i++) {
    if (i > 0) await stagger();
    tier3.push(redditSearch(allQueries[i]).catch(() => [] as RawSearchResult[]));
  }
  await stagger();
  tier3.push(bingNewsRssSearch(primaryQuery).catch(() => [] as RawSearchResult[]));

  // GitHub: instant JSON, zero CAPTCHA — fires in parallel with tier 1.
  const github = githubSearch(primaryQuery).catch(() => [] as RawSearchResult[]);

  const settled = await Promise.allSettled(
    [...tier1, ...tier2, ...tier3, github],
  );
  const out: RawSearchResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  // Never-lose law (same as runGeneralWebSearch): recovery must not turn a
  // poor provider answer into zero results — an empty fallback pool
  // returns the priority providers' results (priority order) instead.
  if (out.length > 0) return out;
  return braveResults.length > 0 ? braveResults : googleResults;
}
