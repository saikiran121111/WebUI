/**
 * Anti-bot network layer: single TLS-impersonated Impit client (Chrome
 * impersonation) + SSRF guards, size/time limits, and rotating realistic
 * headers.
 *
 * Every external fetch in the web-search pipeline MUST go through
 * fetchPage / fetchUrl here — native Node fetch is not allowed for
 * scraper traffic because it fingerprints as a Node client and gets 403'd
 * by search-engine CDNs within seconds.
 */
import { Impit } from "impit";
import { gunzipSync } from "node:zlib";

/* ── Shared TLS-impersonated pool ────────────────────────────────────────── */
// One lazily-created Impit instance: Impit keeps a per-host HTTP/2
// connection pool in native Rust memory (negligible vs. the headless
// browser pool this replaces — the whole point of the 1GB → ~135MB cut).
//
// Fingerprint rotation (chrome ↔ firefox) is done at the request level:
// Impit's constructor fixes the UA profile for the whole instance, so we
// keep ONE shared pool and pass `impersonate` per-request on 403/429/503
// retries instead of spawning second pools.
let _client: Impit | null = null;

export type BrowserFingerprint = "chrome" | "firefox" | "safari" | "edge";

/**
 * Social link-preview crawler User-Agents.
 *
 * Hostile WAFs (Akamai, PerimeterX, Cloudflare, DataDome) whitelist the
 * link-preview bots that render share-cards on WhatsApp, Facebook,
 * Twitter/X, and Slack — so when a standard browser TLS fingerprint is
 * blocked, retrying under these UAs often succeeds where the browser
 * profile does not. This is Tier 2 of the 7-tier anti-bot cascade.
 *
 * Each entry: [userAgent, extra headers the crawler sends].
 */
export const LINK_PREVIEW_UAS: Array<{
  name: string;
  userAgent: string;
  headers: Record<string, string>;
}> = [
  {
    name: "whatsapp",
    userAgent: "WhatsApp/2.23.20.0",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.whatsapp.com/",
    },
  },
  {
    name: "facebook",
    userAgent:
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.facebook.com/",
    },
  },
  {
    name: "twitter",
    userAgent: "Twitterbot/1.0",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://twitter.com/",
    },
  },
  {
    name: "slack",
    userAgent: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://slack.com/",
    },
  },
];

export function tlsClient(fp: BrowserFingerprint = "chrome"): Impit {
  // Per-browser Impit instances so N parallel workers can all use
  // Chrome/TLS-131 without sharing one 8-socket HTTP/2 pool.
  //
  // Impit's Browser type only supports chrome/firefox variants — "edge"
  // and "safari" fall back to the closest TLS-131 profile:
  //   edge   → firefox (Firefox ships on Windows the same way Edge does)
  //   safari → chrome (no Safari TLS-131 profile in impit; Chrome is the
  //             closest general desktop browser fingerprint)
  switch (fp) {
    case "firefox":
      if (!_clientFire) _clientFire = new Impit({ browser: "firefox" });
      return _clientFire;
    case "edge":
      if (!_clientEdge) _clientEdge = new Impit({ browser: "firefox" });
      return _clientEdge;
    case "safari":
      if (!_clientSafari) _clientSafari = new Impit({ browser: "chrome" });
      return _clientSafari;
    default:
      break;
  }
  if (!_client) {
    _client = new Impit({ browser: "chrome" });
  }
  return _client;
}

let _clientFire: Impit | null = null;
let _clientEdge: Impit | null = null;
let _clientSafari: Impit | null = null;

/**
 * Best-effort pool teardown. Impit's native pool releases sockets on
 * process exit in the current build. This hook exists for future versions
 * where close() lands — it is safe to call repeatedly.
 */
export function closeTlsClient(): void {
  for (const c of [_client, _clientFire, _clientEdge, _clientSafari]) {
    try {
      (c as any)?.close?.();
    } catch {
      /* no-op in builds where close() is not yet exposed */
    }
  }
  _client = null;
  _clientFire = null;
  _clientEdge = null;
  _clientSafari = null;
}

/* ── SSRF ───────────────────────────────────────────────────────────────── */

const PRIVATE_HOST_RE =
  /^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc|fd)/i;

/**
 * Block file://, data:, and any URL resolving to loopback / private /
 * link-local ranges. Returns the URL if safe, else null.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !PRIVATE_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/* ── Header rotation ───────────────────────────────────────────────────── */

// Chrome 131 + Firefox 131 fingerprints: the Sec-CH-UA triplet must agree
// with the active JA3/TLS profile for every request. We rotate at the
// request level (see FINGERPRINTS + pickFingerprint below) so a 403 from
// one host can be retried under a different browser profile without a
// second Impit pool.
const FINGERPRINTS: Record<BrowserFingerprint, { secChUa: string | null; platform: string; userAgent: string }> = {
  chrome: {
    secChUa: '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    platform: '"Windows"',
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  firefox: {
    // Firefox never sends Sec-CH-UA* headers — a Firefox TLS fingerprint
    // that DOES send them is a telltale mismatch that WAFs CAPTCHA instantly.
    secChUa: null,
    platform: '"Windows"',
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  },
  edge: {
    secChUa: '"Chromium";v="131", "Not_A Brand";v="24", "Microsoft Edge";v="131"',
    platform: '"Windows"',
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  },
  safari: {
    secChUa: '"Chromium";v="131", "Not_A Brand";v="24", "Safari";v="131"',
    platform: '"macOS"',
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/131.0 Safari/605.1.15",
  },
};

const LANGS = [
  "en-US,en;q=0.9",
  "en-US,en;q=0.9,de;q=0.8,fr;q=0.7",
  "en-GB,en;q=0.9",
  "en-US,en;q=0.8,es;q=0.6",
];

let _rotate = 0;

/**
 * Pick the next browser fingerprint in rotation order. When a request
 * returns 403/429/503, the caller re-invokes with `exclude` = the
 * fingerprint that just failed, and we cycle to the next profile —
 * this defeats hosts that block a single UA fingerprint.
 */
export function pickFingerprint(
  exclude?: BrowserFingerprint,
): { fp: BrowserFingerprint; headers: Record<string, string> } {
  const order: BrowserFingerprint[] = ["chrome", "firefox", "edge"];
  const starting = _rotate++ % order.length;
  for (let i = 0; i < order.length; i++) {
    const fp = order[(starting + i) % order.length];
    if (fp === exclude) continue;
    return { fp, headers: browserIdentHeaders(fp) };
  }
  return { fp: "chrome", headers: browserIdentHeaders("chrome") };
}

/**
 * The UA + Accept-Language + Sec-CH-UA identity for one fingerprint.
 * Sec-CH-UA is OMITTED for firefox (Firefox never sends it — including it
 * on a Firefox TLS fingerprint is the telltale mismatch WAFs flag).
 */
function browserIdentHeaders(fp: BrowserFingerprint): Record<string, string> {
  const f = FINGERPRINTS[fp] ?? FINGERPRINTS.chrome;
  const n = _rotate % LANGS.length;
  const headers: Record<string, string> = {
    "user-agent": f.userAgent,
    "accept-language": LANGS[n],
  };
  if (f.secChUa) {
    headers["sec-ch-ua"] = f.secChUa;
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = f.platform;
  }
  return headers;
}

/** Realistic browser-navigate headers for a given fingerprint. */
export function realisticHeaders(
  extra?: Record<string, string>,
  fp: BrowserFingerprint = "chrome",
): Record<string, string> {
  const base: Record<string, string> = {
    ...browserIdentHeaders(fp),
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    "upgrade-insecure-requests": "1",
  };
  return { ...base, ...extra };
}

/** Same header set for API-style JSON endpoints (algolia, arxiv, ...). */
export function apiHeaders(
  extra?: Record<string, string>,
  fp: BrowserFingerprint = "chrome",
): Record<string, string> {
  const f = FINGERPRINTS[fp] ?? FINGERPRINTS.chrome;
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "accept-language": LANGS[_rotate++ % LANGS.length],
    "user-agent": f.userAgent,
  };
  if (f.secChUa) {
    headers["sec-ch-ua"] = f.secChUa;
  }
  return { ...headers, ...extra };
}

/* ── Bounded body reading (memory guard) ──────────────────────────────── */

// The local workstation has 64GB RAM — the goal is maximum data quality,
// not benchmark speed. Raise the caps so large documents, long HTML pages,
// and multi-megabyte PDFs are never truncated mid-stream (truncation
// corrupts the PDF xref table and loses the tail of long JSON-LD blocks).
const PAGE_LIMIT_BYTES = 50 * 1024 * 1024;   // 50MB — HTML / JSON / XML / text
const PDF_LIMIT_BYTES = 150 * 1024 * 1024;   // 150MB — PDFs only
export { PAGE_LIMIT_BYTES, PDF_LIMIT_BYTES };

/**
 * Read a response body with an absolute byte ceiling. The stream is
 * destroyed the instant the cap is crossed.
 *
 * `limitBytes` is caller-selectable: the default is the 50MB HTML/text
 * cap; PDF downloads pass `PDF_LIMIT_BYTES` (150MB).
 *
 * If the response is gzip-encoded (Content-Encoding: gzip), the bytes
 * are transparently decompressed before returning the string.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | any,
  limitBytes: number = PAGE_LIMIT_BYTES,
  isGzip = false,
): Promise<string> {
  const reader = body?.getReader?.();
  if (!reader) {
    // Non-WebStream body (Buffer / string fallback).
    const buf: Buffer = await body;
    if (isGzip) {
      return gunzipSync(buf.subarray(0, limitBytes)).toString("utf8");
    }
    return buf.subarray(0, limitBytes).toString("utf8");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      reader.cancel().catch(() => {}); // stop the socket, free the rest
      break;
    }
    chunks.push(value);
  }
  if (chunks.length === 0) return "";
  // Concatenate — avoids a full-Array copy through Array.from, which
  // would spike allocation for large HTML.
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  // Transparently decompress gzip-encoded responses (StackExchange,
  // Reddit JSON APIs, etc.). The Impit TLS client does NOT auto-decode
  // content-encoding — it passes the raw bytes through.
  if (isGzip) {
    return gunzipSync(out).toString("utf8");
  }
  return new TextDecoder("utf-8").decode(out);
}

/* ── Fetch helpers ─────────────────────────────────────────────────────── */

export interface PageResponse {
  status: number;
  ok: boolean;
  body: string;
  contentType: string;
  elapsedMs: number;
  /** The fingerprint that produced this response (for retry rotation). */
  fingerprint: BrowserFingerprint;
  /** Set-Cookie header pairs from the final hop (empty when none). */
  cookies: string[];
}

/**
 * Lightweight per-request cookie jar for 301/302/303/307/308 redirect
 * chains (up to 5 hops). Sites like Walmart, Flipkart, Naukri and NYTimes
 * set a session cookie on hop 1 and verify it on hop 2 — without this
 * jar the second hop 403s and looks like a WAF block.
 *
 * The jar is in-memory (no disk, no persistence): it lives for the
 * duration of one `fetchPage` call and is discarded when the promise
 * settles. This avoids cross-request contamination across hosts.
 */
export interface CookieJar {
  /** Read stored cookies for the current URL, return as `Cookie:` header value. */
  cookieFor(url: string): string | null;
  /** Absorb Set-Cookie pairs from a response for the current URL. */
  absorb(url: string, setCookie: string[] | string): void;
}

export function newCookieJar(): CookieJar {
  // host -> "k=v; k2=v2" (single concatenated string per host)
  const store = new Map<string, string>();

  function hostOf(u: string): string {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  }

  return {
    cookieFor(url: string): string | null {
      const host = hostOf(url);
      const val = store.get(host);
      return val && val.length > 0 ? val : null;
    },
    absorb(url: string, setCookie: string[] | string): void {
      const host = hostOf(url);
      if (!host) return;
      const pairs = Array.isArray(setCookie) ? setCookie : [setCookie];
      let current = store.get(host) ?? "";
      for (const sc of pairs) {
        // Set-Cookie: name=value; Path=/; Expires=...
        const firstSemi = sc.indexOf(";");
        const pair = (firstSemi > 0 ? sc.slice(0, firstSemi) : sc).trim();
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        // Empty value = deletion
        if (value === "") {
          current = current
            .split("; ")
            .filter((s) => !s.startsWith(name + "="))
            .join("; ");
          continue;
        }
        // Replace existing same-name cookie
        current = current
          .split("; ")
          .filter((s) => s.split("=")[0] !== name)
          .join("; ");
        current = current ? current + "; " + name + "=" + value : name + "=" + value;
      }
      store.set(host, current);
    },
  };
}

/**
 * Tier-1 direct page fetch: TLS-impersonated, bounded body, wall-clock
 * deadline. All limits live here so no caller can accidentally exceed them.
 *
 * When `opts.retryOnBlock` is true (default), a 403/429/503 from the
 * first fingerprint triggers ONE retry under the next fingerprint in the
 * rotation, with the redirect cookie jar re-applied. The returned
 * `fingerprint` tells the caller which profile produced the result.
 *
 * Default timeout is 45 seconds (up from 3.5s): WAF-heavy sites
 * (Cloudflare, DataDome) legitimately take 10-20s to serve a challenge
 * page, and arXiv/SearXNG can be slow on first hit. 45s keeps the
 * pipeline fast for real pages while never aborting a slow-but-valid
 * response.
 */
export async function fetchPage(
  url: string,
  opts: {
    /** Per-request wall-clock deadline (ms). Default 45_000. */
    timeoutMs?: number;
    headers?: Record<string, string>;
    method?: "GET" | "POST";
    /** Rotate fingerprint on 403/429/503 (default: true). */
    retryOnBlock?: boolean;
    /** Use a specific fingerprint instead of rotating (default: auto). */
    fingerprint?: BrowserFingerprint;
    /** Byte cap for the response body. Default: PAGE_LIMIT_BYTES (50MB).
     *  Pass PDF_LIMIT_BYTES (150MB) for PDF downloads. */
    limitBytes?: number;
  } = {},
): Promise<PageResponse | null> {
  if (!isSafeUrl(url)) return null;

  const t0 = performance.now();
  const jar = newCookieJar();
  const fpOrder = opts.fingerprint
    ? [opts.fingerprint]
    : (["chrome", "firefox", "edge"] as BrowserFingerprint[]);
  const limitBytes = opts.limitBytes ?? PAGE_LIMIT_BYTES;
  const defaultTimeout = 45_000;

  for (let attempt = 0; attempt < (opts.retryOnBlock === false ? 1 : fpOrder.length); attempt++) {
    const fp = fpOrder[attempt];
    const cookieVal = jar.cookieFor(url);
    const headers = {
      ...realisticHeaders(cookieVal ? { cookie: cookieVal } : {}, fp),
      ...(opts.headers ?? {}),
    };

    try {
      const res = await tlsClient(fp).fetch(url, {
        method: opts.method ?? "GET",
        headers,
        timeout: opts.timeoutMs ?? defaultTimeout,
      } as any);

      const status: number = res.status;
      const rawCookies: string[] =
        Array.from((res.headers as any)?.getSetCookie?.() ?? []) as string[];

      // Absorb cookies so a subsequent retry (or a same-call follow-up)
      // re-sends the session cookie the site just issued.
      if (rawCookies.length > 0) jar.absorb(url, rawCookies);

      const body = await readBounded((res as any).body, limitBytes).catch(
        () => "",
      );
      const contentType = String(
        (res.headers as any)?.get?.("content-type") ??
          (res.headers as any)?.["content-type"] ??
          "",
      );
      const elapsedMs = Math.round(performance.now() - t0);
      const isBlock = status === 403 || status === 429 || status === 503;

      if (!isBlock || attempt === fpOrder.length - 1) {
        return {
          status,
          ok: status >= 200 && status < 400,
          body,
          contentType,
          elapsedMs,
          fingerprint: fp,
          cookies: rawCookies,
        };
      }
      // Block status: fall through to the next fingerprint in the rotation.
    } catch {
      // Timeout / network error: if we've tried all fingerprints, surface
      // null; otherwise the next attempt uses a different fingerprint.
      if (attempt === fpOrder.length - 1) {
        return {
          status: 0,
          ok: false,
          body: "",
          contentType: "",
          elapsedMs: Math.round(performance.now() - t0),
          fingerprint: fp,
          cookies: [],
        };
      }
    }
  }
  return null; // unreachable — the loop above always returns
}

/** Quick read of a JSON-ish endpoint (algolia, arxiv, reddit, ...). */
export async function fetchUrl(
  url: string,
  opts: {
    /** Per-request wall-clock deadline (ms). Default 40_000 (up from 2500). */
    timeoutMs?: number;
    body?: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    fingerprint?: BrowserFingerprint;
    /**
     * Use realistic browser-navigate headers instead of apiHeaders.
     * For HTML form-POST scraping (search engines, SearXNG) the server
     * checks the full browser header set; apiHeaders sends
     * Accept: application/json which DDG's anomaly detector flags as a bot.
     */
    useRealisticHeaders?: boolean;
    /** Byte cap for the response body. Default: 50MB (up from 1MB). */
    limitBytes?: number;
  } = {},
): Promise<{ status: number; ok: boolean; text: string } | null> {
  if (!isSafeUrl(url)) return null;
  try {
    const fp = opts.fingerprint ?? "chrome";
    const baseHeaders = opts.useRealisticHeaders
      ? realisticHeaders(opts.headers, fp)
      : apiHeaders(opts.headers, fp);
    const headers: Record<string, string> = { ...baseHeaders };
    if (opts.body && !headers["content-type"]) {
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await tlsClient(fp).fetch(url, {
      method: opts.method ?? "GET",
      headers,
      timeout: opts.timeoutMs ?? 40_000,
      ...(opts.body ? { body: opts.body } : {}),
    } as any);
    const status: number = res.status;
    // Detect gzip-encoded response (StackExchange, Reddit JSON APIs, etc.)
    const contentEncoding = String(
      (res.headers as any)?.get?.("content-encoding") ??
        (res.headers as any)?.["content-encoding"] ??
        "",
    );
    const isGzip = contentEncoding.toLowerCase().includes("gzip");
    const text = await readBounded((res as any).body, opts.limitBytes ?? 50 * 1024 * 1024, isGzip).catch(
      () => "",
    );
    return { status, ok: status >= 200 && status < 300, text };
  } catch {
    return null;
  }
}

/**
 * Tier 2 of the 7-tier anti-bot cascade: social link-preview crawler bypass.
 *
 * When a standard browser fingerprint (Tier 1A/1B) is WAF-blocked, this
 * probes the same URL with each of the 4 link-preview bot User-Agents in
 * sequence. WAFs like Akamai, Cloudflare, DataDome, and PerimeterX
 * whitelist these bots because they need to render share-cards — so a
 * `WhatsApp/2.23.20.0` request often gets a 200 where a Chrome TLS
 * fingerprint gets a 403.
 *
 * Returns the first successful (non-blocked, 200-299, body ≥200 bytes)
 * response, or null when all 4 bots fail. The caller (extractor.ts)
 * extracts OpenGraph / Twitter / JSON-LD / hydration / body text from the
 * returned body before handing it to the cascade.
 */
export async function fetchWithLinkPreviewBots(
  url: string,
  opts: {
    timeoutMs?: number;
    limitBytes?: number;
  } = {},
): Promise<(PageResponse & { botName: string }) | null> {
  if (!isSafeUrl(url)) return null;
  const timeout = opts.timeoutMs ?? 45_000;
  const limitBytes = opts.limitBytes ?? PAGE_LIMIT_BYTES;
  const jar = newCookieJar();

  for (const bot of LINK_PREVIEW_UAS) {
    // The link-preview bots send their own UA; the TLS layer is still the
    // Chrome profile (the bot's UA is what the WAF whitelist matches).
    const fp: BrowserFingerprint = "chrome";
    try {
      const res = await tlsClient(fp).fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": bot.userAgent,
          ...bot.headers,
        },
        timeout,
      } as any);
      const status: number = res.status;
      const rawCookies: string[] =
        Array.from((res.headers as any)?.getSetCookie?.() ?? []) as string[];
      if (rawCookies.length > 0) jar.absorb(url, rawCookies);

      const ok = status >= 200 && status < 400;
      if (!ok) continue; // blocked or server error — try the next bot

      const body = await readBounded((res as any).body, limitBytes).catch(
        () => "",
      );
      if (body.length < 200) continue; // challenge page / empty shell

      const contentType = String(
        (res.headers as any)?.get?.("content-type") ??
          (res.headers as any)?.["content-type"] ??
          "",
      );

      // A successful bot fetch is the end of the probe — return it. The
      // caller's block-detector gate will verify the body is real content
      // (not a residual challenge page slipped through as a 200).
      return {
        status,
        ok: true,
        body,
        contentType,
        elapsedMs: 0,
        fingerprint: "chrome",
        cookies: rawCookies,
        botName: bot.name,
      };
    } catch {
      // network error on this bot — try the next one
      continue;
    }
  }
  return null;
}
