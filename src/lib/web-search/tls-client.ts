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

// One lazily-created shared pool: Impit keeps a per-host HTTP/2
// connection pool in native Rust memory (negligible vs. the headless
// browser pool this replaces — the whole point of the 1GB→135MB cut).
let _client: Impit | null = null;

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

// Chrome 131 fingerprint (matches impit's "chrome" browser profile):
// the Sec-CH-UA triplet must agree with the JA3/TLS fingerprint or the
// request looks machine-made.
const SEC_CH_UA =
  '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"';

const LANGS = [
  "en-US,en;q=0.9",
  "en-US,en;q=0.9,de;q=0.8,fr;q=0.7",
  "en-GB,en;q=0.9",
  "en-US,en;q=0.8,es;q=0.6",
];

let _rotate = 0;

export function realisticHeaders(extra?: Record<string, string>): Record<string, string> {
  const n = _rotate++ % LANGS.length;
  const base: Record<string, string> = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": LANGS[n],
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    "upgrade-insecure-requests": "1",
  };
  return { ...base, ...extra };
}

/** Same header set for API-style JSON endpoints (algolia, arxiv, ...). */
export function apiHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": LANGS[_rotate++ % LANGS.length],
    "sec-ch-ua": SEC_CH_UA,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
}

/* ── Bounded body reading (memory guard) ──────────────────────────────── */

const PAGE_LIMIT_BYTES = 2 * 1024 * 1024; // 2MB hard cap per response

/**
 * Read a response body with an absolute byte ceiling. The stream is
 * destroyed the instant the cap is crossed — a 50MB HTML page never
 * allocates 50MB.
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
}

/**
 * Tier-1 direct page fetch: TLS-impersonated, bounded body, wall-clock
 * deadline. All limits live here so no caller can accidentally exceed them.
 */
export async function fetchPage(
  url: string,
  opts: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    method?: "GET" | "POST";
  } = {},
): Promise<PageResponse | null> {
  if (!isSafeUrl(url)) return null;
  const t0 = performance.now();
  try {
    const res = await tlsClient().fetch(url, {
      method: opts.method ?? "GET",
      headers: { ...realisticHeaders(), ...opts.headers },
      timeout: opts.timeoutMs ?? 3500,
    } as any);
    const status: number = res.status;
    const body = await readBounded((res as any).body, PAGE_LIMIT_BYTES).catch(
      () => "",
    );
    const contentType = String(
      (res.headers as any)?.get?.("content-type") ??
        (res.headers as any)?.["content-type"] ??
        "",
    );
    return {
      status,
      ok: status >= 200 && status < 400,
      body,
      contentType,
      elapsedMs: Math.round(performance.now() - t0),
    };
  } catch {
    return null; // timeout / network error → caller falls to next tier
  }
}

/** Quick read of a JSON-ish endpoint (algolia, arxiv, reddit, ...). */
export async function fetchUrl(
  url: string,
  opts: {
    timeoutMs?: number;
    body?: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; ok: boolean; text: string } | null> {
  if (!isSafeUrl(url)) return null;
  try {
    const res = await tlsClient().fetch(url, {
      method: opts.method ?? "GET",
      headers: { ...apiHeaders(), ...(opts.headers ?? {}) },
      timeout: opts.timeoutMs ?? 2500,
      ...(opts.body ? { body: opts.body } : {}),
    } as any);
    const status: number = res.status;
    const text = await readBounded((res as any).body, 1024 * 1024).catch(
      () => "",
    );
    return { status, ok: status >= 200 && status < 300, text };
  } catch {
    return null;
  }
}
