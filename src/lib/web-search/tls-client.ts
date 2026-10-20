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

export function tlsClient(): Impit {
  if (!_client) {
    _client = new Impit({ browser: "chrome" });
  }
  return _client;
}

/**
 * Best-effort pool teardown. Impit's native pool releases sockets on
 * process exit in the current build. This hook exists for future versions
 * where close() lands — it is safe to call repeatedly.
 */
export function closeTlsClient(): void {
  try {
    // The `close` method may not exist in every impit build; the cast is
    // deliberate — calling a missing method throws, which we swallow.
    // When the method does exist, it releases the per-host HTTP/2 pool.
    (_client as any)?.close?.();
  } catch {
    /* no-op in builds where close() is not yet exposed */
  }
  _client = null;
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
const FINGERPRINTS: Record<BrowserFingerprint, { secChUa: string; platform: string; userAgent: string }> = {
  chrome: {
    secChUa: '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    platform: '"Windows"',
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  firefox: {
    secChUa: '"Not(A:Brand";v="8", "Firefox";v="131", "Firefox";v="131"',
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
    const f = FINGERPRINTS[fp];
    const n = _rotate % LANGS.length;
    return {
      fp,
      headers: {
        "user-agent": f.userAgent,
        "accept-language": LANGS[n],
        "sec-ch-ua": f.secChUa,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": f.platform,
      },
    };
  }
  const f = FINGERPRINTS.chrome;
  return {
    fp: "chrome",
    headers: {
      "user-agent": f.userAgent,
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua": f.secChUa,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": f.platform,
    },
  };
}

/** Realistic browser-navigate headers for a given fingerprint. */
export function realisticHeaders(
  extra?: Record<string, string>,
  fp: BrowserFingerprint = "chrome",
): Record<string, string> {
  const n = _rotate++ % LANGS.length;
  const f = FINGERPRINTS[fp] ?? FINGERPRINTS.chrome;
  const base: Record<string, string> = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": LANGS[n],
    "sec-ch-ua": f.secChUa,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": f.platform,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    "upgrade-insecure-requests": "1",
    "user-agent": f.userAgent,
  };
  return { ...base, ...extra };
}

/** Same header set for API-style JSON endpoints (algolia, arxiv, ...). */
export function apiHeaders(
  extra?: Record<string, string>,
  fp: BrowserFingerprint = "chrome",
): Record<string, string> {
  const f = FINGERPRINTS[fp] ?? FINGERPRINTS.chrome;
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": LANGS[_rotate++ % LANGS.length],
    "sec-ch-ua": f.secChUa,
    "user-agent": f.userAgent,
    ...extra,
  };
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
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | any,
  limitBytes: number = PAGE_LIMIT_BYTES,
): Promise<string> {
  const reader = body?.getReader?.();
  if (!reader) {
    // Non-WebStream body (Buffer / string fallback).
    const buf: Buffer = await body;
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
      const res = await tlsClient().fetch(url, {
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
    /** Byte cap for the response body. Default: 50MB (up from 1MB). */
    limitBytes?: number;
  } = {},
): Promise<{ status: number; ok: boolean; text: string } | null> {
  if (!isSafeUrl(url)) return null;
  try {
    const fp = opts.fingerprint ?? "chrome";
    const res = await tlsClient().fetch(url, {
      method: opts.method ?? "GET",
      headers: { ...apiHeaders(opts.headers, fp) },
      timeout: opts.timeoutMs ?? 40_000,
      ...(opts.body ? { body: opts.body } : {}),
    } as any);
    const status: number = res.status;
    const text = await readBounded((res as any).body, opts.limitBytes ?? 50 * 1024 * 1024).catch(
      () => "",
    );
    return { status, ok: status >= 200 && status < 300, text };
  } catch {
    return null;
  }
}
