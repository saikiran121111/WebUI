/**
 * Anti-bot network layer — got-scraping first, impit TLS rotation as the
 * internal fallback.
 *
 * Every external fetch in the web-search pipeline MUST go through
 * fetchPage / fetchUrl here.  Pass A is `got-scraping` (v4) driven by
 * header-generator fingerprints (rotating Chrome/Firefox HTTP/2 header
 * sets + scraping defaults).  When got returns a block status
 * (403/429/503) or throws, Pass B re-tries through the TLS-impersonated
 * impit clients with the chrome → firefox → edge header rotation.
 * Native Node fetch is not allowed for scraper traffic because it
 * fingerprints as a Node client and gets 403'd by search-engine CDNs.
 *
 * SSRF guarding lives in ssrf.ts (shared with lib/web-search/agentBrowser.ts); this module
 * re-exports isSafeUrl so existing importers keep working.
 */
import { Impit } from "impit";

/* wreq-js — Rust-backed browser-TLS HTTP client (JA3/JA4 spoofing).
   Used as Pass C: fires when got-scraping AND all three impit
   fingerprints have been blocked.  wreq-js's TLS emulation is
   implemented in Rust and produces a different JA3/JA4 signature
   than impit's Python/Node C-extension, so it can clear challenges
   that impit trips.  Lazy-imported so a broken install degrades
   gracefully to the impit-only path. */
let _wreqReady: Promise<typeof import("wreq-js")> | null = null;
function wreqLoad(): Promise<typeof import("wreq-js")> {
  if (!_wreqReady) _wreqReady = import("wreq-js").catch(() => (null as any));
  return _wreqReady;
}
// Exported for the pinned wreq-API regression test (net-wreq.test.ts); the
// cascade reaches it only via Pass C, which no hermetic cascade fixture can force.
export async function wreqFetch(
  url: string,
  opts: { method?: "GET" | "POST"; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; ok: boolean; body: string; contentType: string; url: string } | null> {
  try {
    const wreq = await wreqLoad();
    if (!wreq) return null;
    const method: "GET" | "POST" = opts.method ?? "GET";
    const res = await (method === "POST" ? wreq.post : wreq.get)(url, {
      headers: opts.headers ?? {},
      // RESTORED-BUGFIX (rollback manifest §A.1): wreq-js 3.2.0 takes
      // timeout in MILLISECONDS and names the client option `browser`.
      // The historical code passed seconds under `emulate` (hidden by the
      // `as any`): a 120 ms local response timed out with timeout:30.
      timeout: opts.timeoutMs ?? 30_000,
      browser: "chrome",
    } as any);
    const body: string = await res.text();
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 400,
      body,
      contentType: String(res.headers?.get?.("content-type") ?? ""),
      // SSRF revalidation needs the FINAL URL after wreq's own redirect
      // following; when the binding doesn't surface one, fall back to the
      // request URL (the entry guard already cleared it).
      url: String((res as any)?.url ?? url),
    };
  } catch {
    return null;
  }
}
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import https from "node:https";
import { parse as tldtsParse } from "tldts";
import { isSafeUrl, isSafeUrlWithDns, firstUnsafeRedirectHop } from "./ssrf";

export { isSafeUrl };

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

export type BrowserFingerprint = "chrome" | "firefox" | "safari" | "edge" | "wreq-chrome";

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
  "wreq-chrome": {
    secChUa: '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    platform: '"Windows"',
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
/**
 * Decode-once law helper (§8 audit 2026-11-04): Content-Encoding describes
 * the WIRE, not the bytes in hand — clients differ in whether they already
 * transparently decoded (impit decodes but echoes the header; raw paths do
 * not), so a gunzip failure normally means "already decoded": keep the
 * bytes. But bytes that CARRY the gzip magic and still fail to decode are
 * genuinely corrupt/truncated — string consumers get a clean failure ("" →
 * parse/network classification) instead of mojibake, while byte consumers
 * still receive the truncated truth.
 */
function gunzipOrKeep(buf: Buffer, limitBytes: number): { bytes: Buffer; text: string } {
  const capped = buf.subarray(0, limitBytes);
  try {
    const dz = gunzipSync(capped).subarray(0, limitBytes); // cap AFTER decompression too (gzip bomb)
    return { bytes: dz, text: dz.toString("utf8") };
  } catch {
    const gzMagic = capped[0] === 0x1f && capped[1] === 0x8b;
    return { bytes: capped, text: gzMagic ? "" : capped.toString("utf8") };
  }
}
export async function readBounded(
  body: ReadableStream<Uint8Array> | any,
  limitBytes: number = PAGE_LIMIT_BYTES,
  isGzip = false,
  /** (audit 2026-11-04) Optional out-sink: the FINAL decompressed bytes
   * are handed back here before the lossy UTF-8 decode, so binary/foreign-
   * charset callers (PDF, Shift_JIS) can work on the true bytes instead of
   * a destroyed string. Existing string callers pass nothing — unchanged. */
  sink?: { bytes?: Uint8Array },
): Promise<string> {
  const reader = body?.getReader?.();
  if (!reader) {
    // Non-WebStream body (Buffer / string fallback).
    const buf: Buffer = await body;
    if (isGzip) {
      const r = gunzipOrKeep(buf, limitBytes);
      if (sink) sink.bytes = r.bytes;
      return r.text;
    }
    const raw = buf.subarray(0, limitBytes);
    if (sink) sink.bytes = raw;
    return raw.toString("utf8");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const room = limitBytes - total;
    // Bounded PREFIX (2026-11-04 audit fix): the overflowing chunk used
    // to inflate `total` without being copied, so the concatenation buffer
    // was allocated larger than the copied bytes — synthetic NUL padding
    // at the end of every capped body. Slice to the cap instead.
    if (room <= 0) {
      reader.cancel().catch(() => {}); // stop the socket, free the rest
      break;
    }
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
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
  // Decompress at most once — see gunzipOrKeep for the decode-exactly-once
  // law (header describes the wire, not these bytes) and the corrupt-gzip
  // distinction (§8: magic present + decode failure = corrupt, never
  // mojibake; the truncation-at-wire-cap case lands here).
  // shortcut: a gzip body larger than the wire cap files as corrupt rather
  // than a salvaged decompressed prefix — the 50MB PAGE cap makes a real
  // page crossing the cap vanishingly rare; add prefix salvage only if one
  // ever does.
  if (isGzip) {
    const r = gunzipOrKeep(Buffer.from(out.buffer, out.byteOffset, out.byteLength), limitBytes);
    if (sink) sink.bytes = r.bytes;
    return r.text;
  }
  if (sink) sink.bytes = out;
  return new TextDecoder("utf-8").decode(out);
}

/* ── got-scraping (Pass A) ─────────────────────────────────────────────── */

const BLOCK_STATUSES = [403, 429, 503];

// got-scraping v4 is ESM-only — lazy-load it once and cache the module so
// a broken/absent install degrades to the impit fallback instead of
// crashing the pipeline.
let _gotPromise: Promise<any> | null = null;
async function gotModule(): Promise<any> {
  if (!_gotPromise) {
    _gotPromise = import("got-scraping")
      // got-scraping v4.2.2 has NO default export (verified against the
      // installed package). The old `m.default ?? m` returned the module
      // NAMESPACE, and every got(...) call below threw "got is not a
      // function" — Pass A had been silently dead (2026-11-04 audit fix).
      .then((m: any) => m?.gotScraping ?? null)
      .catch(() => null);
  }
  const mod = await _gotPromise;
  if (!mod) {
    _gotPromise = null; // allow a retry after a transient load failure
    throw new Error("got-scraping unavailable");
  }
  return mod;
}

/**
 * got-scraping page fetch with the shared cookie jar + bounded body.
 * Returns null on any network/timeout failure so the caller falls through
 * to the impit TLS rotation; cert-shaped errors (broken gov chains) get
 * the one-shot rejectUnauthorized:false retry via tlsTolerantGet.
 */
async function gotPageFetch(
  url: string,
  opts: {
    headers?: Record<string, string>;
    method?: "GET" | "POST";
    /** (WS16) Cancellation: got aborts the stream natively; the error
     *  lands in the catch below and settles this pass as null. */
    signal?: AbortSignal;
  },
  jar: CookieJar,
  limitBytes: number,
  timeoutMs: number,
  t0: number,
): Promise<PageResponse | null> {
  try {
    const got = await gotModule();
    const cookieVal = jar.cookieFor(url);
    // Every redirect target, in order, recorded only after the hook vetted
    // it — drives resolvedUrl and the final-chain SSRF recheck without
    // depending on any given got version's response bookkeeping.
    const hops: string[] = [];
    // STREAM MODE (§8 audit 2026-11-04): buffered mode retained the FULL
    // response before any cap ran, so limitBytes only ever truncated the
    // string — rawBytes kept every wire byte (limitBytes:32 → 5,000 bytes
    // retained, the brief's repro) and an oversized body peaked in RAM
    // first. The stream is now consumed UNDER the cap (cap during
    // consumption), and decompress:true makes the capped chunks the TRUE
    // decompressed bytes for PDF/charset callers (capped again after
    // decompression at the concat).
    const stream: any = got.stream(url, {
      method: opts.method ?? "GET",
      headers: {
        ...realisticHeaders(cookieVal ? { cookie: cookieVal } : {}),
        ...(opts.headers ?? {}),
      },
      throwHttpErrors: false,
      maxRedirects: 10,
      // got v14 option grammar (native-verified against the installed
      // got-scraping 4.2.2 / got 14.6.6): retry takes {limit:0},
      // beforeRedirect lives under hooks, and the v14-era top-level forms
      // used here before made EVERY got-scraping call throw
      // ERR_INVALID_OPTIONS / TypeError. No `proxy` option: v14 rejects
      // `proxy: false`, and got-scraping does not auto-pick system
      // proxies anyway.
      retry: { limit: 0 },
      decompress: true,
      timeout: { request: timeoutMs },
      // (WS16) The combined cancellation signal rides the transport: an
      // abort kills the stream (no late body, no abandoned read running
      // to completion on a cancelled turn).
      ...(opts.signal ? { signal: opts.signal } : {}),
      // SSRF (§P6): refuse every redirect TARGET before it is followed —
      // a public URL 302-ing to http://169.254.169.254/ is the classic
      // SSRF pivot. The throw kills the stream; the catch below turns it
      // into null so Pass B/C run their own entry + final-URL checks
      // instead of silently following the hop.
      hooks: {
        beforeRedirect: [
          // ARITY PINNED TO THE INSTALLED PACKAGE (§8): got 14.6.6 calls
          // `hook(updatedOptions, typedResponse)` — TWO arguments
          // (node_modules/got/dist/source/core/index.js:702). The earlier
          // three-parameter form (redirectOptions, _init, response) pushed
          // the Response into _init and left `response` undefined, so a
          // hop's Set-Cookie was NEVER absorbed — the brief's controlled
          // 302 repro returned NO_COOKIE. got implements no cookie store
          // of its own and DELETES the Cookie header on cross-origin
          // hops, so this hook is the only thing that keeps a session
          // cookie alive through a chain.
          (redirectOptions: any, response: any) => {
            const next = String(redirectOptions?.url ?? "");
            if (next && !isSafeUrl(next)) throw new Error("SSRF redirect blocked");
            hops.push(next);
            const sc = response?.headers?.["set-cookie"];
            const hopCookies: string[] = Array.isArray(sc)
              ? sc.map(String)
              : sc
                ? [String(sc)]
                : [];
            if (hopCookies.length > 0) jar.absorb(String(response?.url ?? url), hopCookies);
            if (next) {
              const carry = jar.cookieFor(next);
              if (carry)
                redirectOptions.headers = {
                  ...(redirectOptions.headers ?? {}),
                  cookie: carry,
                };
            }
          },
        ],
      },
    } as any);
    // got.stream leaves the WRITABLE half open when no body option is set,
    // so a POST would hang forever waiting on its own request end (§8
    // POST-303 repro). End it immediately — an explicitly empty body.
    if ((opts.method ?? "GET") === "POST") stream.end();
    // A late error after our own early destroy (cap hit / cancel) is
    // expected noise; live errors still surface through for-await.
    stream.on("error", () => {});
    let finalRes: any = null;
    stream.on("response", (r: any) => {
      finalRes = r;
    });

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of stream) {
      const b: Buffer = Buffer.isBuffer(c) ? c : Buffer.from(c);
      const room = limitBytes - total;
      if (room <= 0) break;
      chunks.push(b.length > room ? b.subarray(0, room) : b);
      total += Math.min(b.length, room);
      if (total >= limitBytes) {
        stream.destroy(); // stop the socket — the rest never enters RAM
        break;
      }
    }
    const wireBytes: Buffer = Buffer.concat(chunks);

    const status: number = Number(finalRes?.statusCode ?? 0);
    const contentType = String(finalRes?.headers?.["content-type"] ?? "");
    const setCookieHeader = finalRes?.headers?.["set-cookie"];
    const rawCookies: string[] = Array.isArray(setCookieHeader)
      ? setCookieHeader.map(String)
      : setCookieHeader
        ? [String(setCookieHeader)]
        : [];

    const resolvedUrl =
      hops.length > 0 ? hops[hops.length - 1] : String(finalRes?.url ?? url);
    // The FINAL hop's cookies belong to the FINAL host. The old code
    // absorbed them under the ENTRY url, pinning them to the wrong jar
    // key on any chain that changed hosts.
    if (rawCookies.length > 0) jar.absorb(resolvedUrl, rawCookies);

    // Body and rawBytes are the SAME capped decompressed bytes — byte-
    // accurate (the old char-slice could retain up to 4x the byte cap on
    // multibyte text; rawBytes was capped not at all). Text/binary never
    // diverged in meaning here: got already decompressed the stream, so
    // both old branches described one utf-8 render of one buffer.
    const body = wireBytes.toString("utf8");

    // SSRF belt-and-braces: even if a got version skipped beforeRedirect,
    // a chain that touched or landed on a private host never yields a
    // response body here.
    if (firstUnsafeRedirectHop(hops) !== null) return null;
    if (resolvedUrl && !isSafeUrl(resolvedUrl)) return null;

    return {
      status,
      ok: status >= 200 && status < 400,
      body,
      contentType,
      elapsedMs: Math.round(performance.now() - t0),
      fingerprint: "chrome",
      cookies: rawCookies,
      resolvedUrl,
      // Capped decompressed bytes (Buffer view, zero copy) — PDF/charset
      // callers get the true bytes, bounded by limitBytes like everything
      // else on this path.
      ...(wireBytes.length > 0
        ? { rawBytes: new Uint8Array(wireBytes.buffer, wireBytes.byteOffset, wireBytes.byteLength) }
        : {}),
    };
  } catch (err: unknown) {
    if (isCertError(err)) {
      const tolerant = await tlsTolerantGet(url, jar, timeoutMs, limitBytes);
      if (tolerant) return tolerant;
    }
    return null; // got failed / timed out → impit rotation takes over
  }
}

/** got-scraping fetch for JSON-ish / form-POST endpoints.
 *  (WS15 "every transport" leg) Reddit/algolia-class JSON endpoints ride
 *  this path and are cookie-gated behind redirects — got deletes the
 *  Cookie header on hops and has no cookie store of its own, so the
 *  beforeRedirect jar hook (same law as gotPageFetch) is required here
 *  too, not just in the page path. */
async function gotUrlFetch(
  url: string,
  opts: {
    timeoutMs?: number;
    body?: string;
    method?: "GET" | "POST";
    limitBytes?: number;
    /** (WS16) Cancellation — same law as gotPageFetch: the abort kills
     *  the request, the catch settles null. */
    signal?: AbortSignal;
  },
  headers: Record<string, string>,
  jar: CookieJar,
): Promise<{ status: number; ok: boolean; text: string } | null> {
  try {
    const got = await gotModule();
    const res = await got(url, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      throwHttpErrors: false,
      maxRedirects: 10,
      // got v14 option grammar — see gotPageFetch for the law note.
      retry: { limit: 0 },
      decompress: true,
      timeout: { request: opts.timeoutMs ?? 40_000 },
      // (WS16) see gotPageFetch — abort propagates into the JSON-endpoint
      // transport too.
      ...(opts.signal ? { signal: opts.signal } : {}),
      // SSRF + cookies: refuse unsafe redirect targets AND replay the
      // chain's cookies (mirrors gotPageFetch — got 14.6.6 calls the hook
      // as `hook(updatedOptions, typedResponse)`, TWO arguments; the arity
      // is pinned in net-cookies-caps.test.ts).
      hooks: {
        beforeRedirect: [
          (redirectOptions: any, response: any) => {
            const next = String(redirectOptions?.url ?? "");
            if (next && !isSafeUrl(next)) throw new Error("SSRF redirect blocked");
            const sc = response?.headers?.["set-cookie"];
            const hopCookies: string[] = Array.isArray(sc)
              ? sc.map(String)
              : sc
                ? [String(sc)]
                : [];
            if (hopCookies.length > 0) jar.absorb(String(response?.url ?? url), hopCookies);
            if (next) {
              const carry = jar.cookieFor(next);
              if (carry)
                redirectOptions.headers = {
                  ...(redirectOptions.headers ?? {}),
                  cookie: carry,
                };
            }
          },
        ],
      },
    } as any);
    const status: number = res.statusCode ?? 0;
    // SSRF: final-URL revalidation — the chain's landing host must also be
    // public, not just the entry URL.
    if (!isSafeUrl(String(res.url ?? url))) return null;
    let text = String(res.body ?? "");
    const cap = opts.limitBytes ?? 50 * 1024 * 1024;
    // Byte-accurate cap (§8): the old char-slice kept up to 4x the byte
    // cap on multibyte text. shortcut: this JSON-endpoint path stays
    // buffered (caps after decompression); the during-consumption cap
    // lives in the streaming paths (gotPageFetch / readBounded) — switch
    // here only if a JSON feed is ever proven large enough to matter.
    if (Buffer.byteLength(text, "utf8") > cap) {
      text = Buffer.from(text, "utf8").subarray(0, cap).toString("utf8");
    }
    return { status, ok: status >= 200 && status < 300, text };
  } catch {
    return null;
  }
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
  /**
   * The FINAL URL after the full 301/302/303/307/308 redirect chain
   * ("" on network failure). Short links (maps.app.goo.gl, bit.ly, t.co,
   * Firebase dynamic links) surface their real destination here so the
   * pipeline can extract the RESOLVED page, not the redirect stub.
   */
  resolvedUrl: string;
  /**
   * (audit 2026-11-04) Set when the bytes arrived through the gov TLS
   * tolerance path (rejectUnauthorized:false): the chain could not be
   * verified, so downstream layers must not present this content as
   * authenticated. Surfaced, never silent.
   */
  insecureTls?: boolean;
  /**
   * (audit 2026-11-04) The ORIGINAL decompressed bytes whenever the fetch
   * path held them (got's stream path caps them during consumption; the
   * readBounded sink retains the rest). Decoding PDF bytes to a string and
   * re-encoding
   * destroys the file (invalid UTF-8 → U+FFFD), so unpdf could never
   * parse a PDF that traveled only as `body`; and charset detection must
   * sniff the TRUE bytes, not a UTF-8 re-encode of an already-mangled
   * string. Absent only where no bytes survive (wreq Pass C hands back
   * strings) — callers keep the old lossy fallback there.
   */
  rawBytes?: Uint8Array;
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
  // (§8 audit 2026-11-04) Attribute-aware RFC-6265-lite jar. The old store
  // keyed by EXACT host and kept only name/value: Domain=-scoped cookies
  // died on host transitions inside a chain (www → bare), Path-scoped
  // account cookies rode to unrelated paths (cross-account leakage inside
  // one redirect chain), a hostile Domain= grant was accepted verbatim,
  // and expired cookies were replayed. Entries now carry domain/path/
  // secure attributes, Domain= grants are confined to the setting host's
  // REGISTRABLE domain (tldts — a public-suffix or cross-site grant is
  // refused), Max-Age/Expires past values delete, and Secure cookies are
  // withheld from http: URLs. shortcut: no per-entry expiry timers — the
  // jar lives for ONE fetchPage call, so time-based expiry inside a
  // single fetch is noise; re-evaluate only if the jar ever goes
  // cross-request (it must not: that is the cross-account boundary).
  interface JarEntry {
    name: string;
    value: string;
    domain: string;
    hostOnly: boolean;
    path: string;
    secure: boolean;
  }
  const store: JarEntry[] = [];

  function parseUrl(u: string): URL | null {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  }

  function registrable(host: string): string {
    return tldtsParse(host.toLowerCase()).domain ?? host.toLowerCase();
  }

  // RFC 6265 §5.1.4 default-path: everything up to (not including) the
  // last "/", or "/" when the path has no directory segment.
  function defaultPath(pathname: string): string {
    const i = pathname.lastIndexOf("/");
    return i <= 0 ? "/" : pathname.slice(0, i);
  }

  function pathMatch(cookiePath: string, requestPath: string): boolean {
    if (cookiePath === "/") return true;
    if (requestPath === cookiePath) return true;
    return requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : cookiePath + "/");
  }

  function domainMatches(e: JarEntry, host: string): boolean {
    if (e.hostOnly) return host === e.domain;
    return host === e.domain || host.endsWith("." + e.domain);
  }

  return {
    cookieFor(url: string): string | null {
      const u = parseUrl(url);
      if (!u) return null;
      const host = u.hostname;
      const pathname = u.pathname || "/";
      const secureCtx = u.protocol === "https:";
      const matched = store.filter(
        (e) => (!e.secure || secureCtx) && domainMatches(e, host) && pathMatch(e.path, pathname),
      );
      if (matched.length === 0) return null;
      // Cookie header order (RFC 6265 §5.4): most specific path first;
      // stable (insertion order) inside equal paths.
      matched.sort((a, b) => b.path.length - a.path.length);
      return matched.map((e) => `${e.name}=${e.value}`).join("; ");
    },
    absorb(url: string, setCookie: string[] | string): void {
      const u = parseUrl(url);
      if (!u || !u.hostname) return;
      const host = u.hostname;
      const pathname = u.pathname || "/";
      const pairs = Array.isArray(setCookie) ? setCookie : [setCookie];
      for (const sc of pairs) {
        // Set-Cookie: name=value; Path=/; Domain=...; Max-Age=...; Secure
        const parts = String(sc).split(";");
        const pair = parts[0].trim();
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        let domain = host;
        let hostOnly = true;
        let path = defaultPath(pathname);
        let secure = false;
        // Empty value = deletion (RFC-legal); past expiry = deletion too.
        let remove = value === "";
        for (const attrRaw of parts.slice(1)) {
          const s = attrRaw.trim();
          const ae = s.indexOf("=");
          const an = (ae > 0 ? s.slice(0, ae) : s).trim().toLowerCase();
          const av = ae > 0 ? s.slice(ae + 1).trim() : "";
          if (an === "domain") {
            const d = av.replace(/^\./, "").toLowerCase();
            if (!d) continue;
            // The grant must be a suffix of the setting host AND stay
            // inside its registrable domain — otherwise this cookie could
            // ride to a public suffix ("Domain=.co") or to an unrelated
            // site: that is the cross-account leakage boundary.
            if (host !== d && !host.endsWith("." + d)) continue;
            if (registrable(host) !== registrable(d)) continue;
            domain = d;
            hostOnly = false;
          } else if (an === "path") {
            if (!av.startsWith("/")) continue; // invalid attribute value
            if (!pathMatch(av, pathname)) continue; // RFC: set-path must match the request path
            path = av;
          } else if (an === "secure") {
            secure = true; // valueless flag attr (HttpOnly is JS-facing only — never a send filter)
          } else if (an === "max-age") {
            const n = Number(av);
            if (Number.isFinite(n) && n <= 0) remove = true;
          } else if (an === "expires") {
            const t = Date.parse(av);
            if (!Number.isNaN(t) && t <= Date.now()) remove = true;
          }
        }
        // Replace/delete the exact (name, domain, path) triple; same name
        // under different scopes legitimately coexists.
        const idx = store.findIndex(
          (e) => e.name === name && e.domain === domain && e.path === path,
        );
        if (idx >= 0) store.splice(idx, 1);
        if (remove) continue;
        store.push({ name, value, domain, hostOnly, path, secure });
      }
    },
  };
}

/* ── Gov TLS tolerance ─────────────────────────────────────────────────────
 * Government / institutional hosts (.gov, .gov.in, .nic.in, agency and
 * university mirrors) frequently serve expired, self-signed, or
 * incomplete certificate chains.  impit throws a TLS handshake error on
 * those, which the pipeline would otherwise file as FAIL_NETWORK_OR_CRASH —
 * so on a cert-shaped error we retry ONCE through node:https with
 * rejectUnauthorized:false (manual redirect follow + bounded body), which
 * reads the real circular/page instead of losing it.
 */
const CERT_ERROR_RE =
  /unable to verify|self[- ]signed|certificate has expired|cert_has_expired|unable_to_verify_leaf|unable to get (?:local )?issuer|ssl(?:routines)?|tlsv1 alert|wrong version number|handshake failure|no shared cipher|EPROTO/i;

export function isCertError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${(err as any)?.code ?? ""} ${(err as any)?.reason ?? ""}`
      : String(err ?? "");
  return CERT_ERROR_RE.test(msg);
}

/**
 * rejectUnauthorized:false GET for cert-broken gov pages.  Follows up to
 * 6 redirects (re-running the SSRF guard on every hop), decompresses
 * gzip/br bodies, and caps the body at limitBytes.  Returns null on ANY
 * failure so the caller falls back to the normal failure path.
 */
async function tlsTolerantGet(
  url: string,
  jar: CookieJar,
  timeoutMs = 45_000,
  limitBytes: number = PAGE_LIMIT_BYTES,
  signal?: AbortSignal,
): Promise<PageResponse | null> {
  const t0 = performance.now();
  let settled = false;
  return new Promise<PageResponse | null>((resolve) => {
    const finish = (r: PageResponse | null) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    // (WS16) Cancellation: node:http has no fetch-level cancel, so the
    // abort DESTROYS the in-flight socket and settles null; every queued
    // redirect hop re-checks, so nothing starts post-cancel.
    let activeReq: import("node:http").ClientRequest | null = null;
    if (signal?.aborted) return finish(null);
    signal?.addEventListener(
      "abort",
      () => {
        try {
          activeReq?.destroy();
        } catch {}
        finish(null);
      },
      { once: true },
    );
    const visit = (u: string, hops: number) => {
      if (signal?.aborted) return finish(null);
      if (hops > 6 || !isSafeUrl(u)) return finish(null);
      let req: import("node:http").ClientRequest;
      try {
        activeReq = req = https.get(
          u,
          {
            rejectUnauthorized: false,
            timeout: Math.max(5_000, timeoutMs),
            // (WS15 "every transport" leg) The gov-CERT retry is a third
            // walker of the same chain law: the jar's cookies ride every
            // hop it issues itself.
            headers: (() => {
              const carry = jar.cookieFor(u);
              return carry
                ? { ...realisticHeaders(), cookie: carry }
                : realisticHeaders();
            })(),
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const loc = res.headers["location"];
            const scRaw = res.headers["set-cookie"];
            const hopCookies: string[] = Array.isArray(scRaw)
              ? scRaw.map(String)
              : scRaw
                ? [String(scRaw)]
                : [];
            if (hopCookies.length > 0) jar.absorb(u, hopCookies);
            if (
              [301, 302, 303, 307, 308].includes(status) &&
              loc &&
              hops < 6
            ) {
              res.resume();
              try {
                return visit(new URL(loc, u).toString(), hops + 1);
              } catch {
                return finish(null);
              }
            }
            const chunks: Buffer[] = [];
            let total = 0;
            res.on("data", (c: Buffer) => {
              // Bounded PREFIX during consumption (§8): slice to the cap
              // instead of pushing whole chunks past it.
              const room = limitBytes - total;
              if (room <= 0) return;
              chunks.push(c.length > room ? c.subarray(0, room) : c);
              total += Math.min(c.length, room);
            });
            res.on("end", () => {
              let buf: Buffer = Buffer.concat(chunks);
              const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
              let bodyText: string;
              if (enc.includes("gzip")) {
                const r = gunzipOrKeep(buf, limitBytes);
                buf = r.bytes;
                bodyText = r.text; // corrupt gzip ⇒ clean "", never mojibake
              } else {
                try {
                  if (enc.includes("br")) buf = brotliDecompressSync(buf);
                } catch {
                  /* keep the raw bytes — br has no magic to distinguish corruption; shortcut: upgrade only if a br-corrupt gov page shows up */
                }
                bodyText = buf.toString("utf8");
              }
              // (audit 2026-11-04) Unverified-chain reads are loud, not
              // silent: flag the response and log host+status only (never
              // URLs with query secrets, never cookie material).
              try {
                // eslint-disable-next-line no-console
                console.warn(
                  `[web-search/net] TLS-unverified read (broken cert chain, cert verification disabled for this one retry): ${new URL(u).host} status=${status}`,
                );
              } catch {
                /* unparseable URL — skip the log, still finish */
              }
              const contentType = String(res.headers["content-type"] ?? "");
              finish({
                status,
                ok: status >= 200 && status < 400,
                body: bodyText,
                contentType,
                elapsedMs: Math.round(performance.now() - t0),
                fingerprint: "chrome",
                cookies: hopCookies,
                resolvedUrl: u,
                insecureTls: true,
                // Node Buffer view over the collected bytes — zero copy.
                rawBytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
              });
            });
            res.on("error", () => finish(null));
          },
        );
      } catch {
        return finish(null);
      }
      req.on("error", () => finish(null));
      req.on("timeout", () => {
        req.destroy();
        finish(null);
      });
    };
    visit(url, 0);
  });
}

/**
 * (audit 2026-11-05 WS15) Pass B redirect walker.
 *
 * impit follows redirect chains INSIDE its Rust stack with no per-hop
 * hook: Pass B supplied only the ENTRY cookie and absorbed the FINAL
 * response's Set-Cookie afterwards, so a cookie issued on hop 1 was never
 * replayed on hop 2 — the pinned-fingerprint NO_COOKIE repro (Walmart/
 * Flipkart-style session chains 403 and read as a WAF block).  This
 * mirrors got's beforeRedirect jar hook in TS: every hop is requested
 * with `redirect: "manual"` (confirmed fetch option in the installed
 * impit typings), each hop's Set-Cookie is absorbed under the URL that
 * ISSUED it, and the jar's cookies ride the next request — with the
 * existing domain/path/secure/expiry rules enforced by the jar itself
 * (a hop across domains never sees another site's cookies).
 *
 * Every redirect TARGET is vetted with isSafeUrl before it is issued (the
 * old code only revalidated the final landing — intermediate SSRF hops
 * were never checked).  Method transitions follow the fetch spec: 303 →
 * GET (except HEAD), POST→GET on 301/302/303, method preserved on
 * 307/308.  The hop cap mirrors got's maxRedirects:10, so a loop settles
 * as a failed attempt exactly like the native redirect-limit error did.
 */
const MAX_IMPIT_REDIRECTS = 10;

/** (WS16) Abort helper. The impit native binding exposes no per-request
 *  cancel, so each hop is RACED against the abort: the JS side settles
 *  promptly while the in-flight Rust request completes briefly in the
 *  background bounded by its own timeout (a bounded capacity leak, zero
 *  late state — the jar absorb below only runs if the hop wins the
 *  race). Documented in net-cancellation.test.ts. */
function abortedError() {
  const e = new Error("net request aborted");
  e.name = "AbortError";
  return e;
}

async function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw abortedError();
  let off: () => void = () => {};
  const aborter = new Promise<never>((_, rej) => {
    const onAbort = () => rej(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    off = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([work, aborter]);
  } finally {
    off();
  }
}

async function impitFollow(
  client: Impit,
  url: string,
  req: {
    method: string;
    baseHeaders: Record<string, string>;
    timeout: number;
    body?: string;
  },
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<{ res: any; finalUrl: string }> {
  let cur = url;
  let method = req.method;
  let body = req.body;
  for (let hop = 0; ; hop++) {
    // (WS16) Queued hop: never dispatch the next hop of a cancelled walk.
    if (signal?.aborted) throw new Error("aborted");
    const carry = jar.cookieFor(cur);
    const res = await withAbort(
      client.fetch(cur, {
        method,
        headers: carry ? { ...req.baseHeaders, cookie: carry } : { ...req.baseHeaders },
        timeout: req.timeout,
        redirect: "manual",
        ...(body !== undefined ? { body } : {}),
      } as any),
      signal,
    );
    const sc =
      ((res.headers as any)?.getSetCookie?.() as unknown[] | undefined) ??
      (typeof (res.headers as any)?.get === "function"
        ? [(res.headers as any).get("set-cookie")].filter(Boolean)
        : undefined) ??
      [];
    const hopCookies: string[] = Array.from(sc, String);
    if (hopCookies.length > 0) jar.absorb(cur, hopCookies);
    const status = Number(res?.status ?? 0);
    const loc = String((res.headers as any)?.get?.("location") ?? "");
    if (![301, 302, 303, 307, 308].includes(status) || !loc)
      return { res, finalUrl: cur }; // terminal response (3xx without Location included)
    if (hop >= MAX_IMPIT_REDIRECTS) throw new Error("redirect limit exceeded");
    let next: string;
    try {
      next = new URL(loc, cur).toString();
    } catch {
      return { res, finalUrl: cur }; // malformed Location — surface the 3xx, never loop
    }
    if (!isSafeUrl(next)) throw new Error("SSRF redirect blocked");
    if (
      (status === 303 && method !== "HEAD") ||
      (method === "POST" && status !== 307 && status !== 308)
    ) {
      method = "GET";
      body = undefined;
    }
    cur = next;
  }
}

/**
 * Tier-1 direct page fetch with the two-pass anti-bot strategy:
 *
 *   Pass A — got-scraping (header-generator fingerprints, HTTP/2).
 *   Pass B — on a 403/429/503 (or a got network failure) the request is
 *            re-run through the TLS-impersonated impit clients, rotating
 *            chrome → firefox → edge with the shared redirect cookie jar.
 *
 * When BOTH passes end on a block status, whichever response carries more
 * body bytes wins (challenge pages differ per fingerprint — one of them
 * often leaks the real page). All size/time limits live here so no caller
 * can accidentally exceed them.
 *
 * Default timeout is 45 seconds: WAF-heavy sites (Cloudflare, DataDome)
 * legitimately take 10-20s to serve a challenge page, and arXiv/Google
 * can be slow on first hit. 45s keeps the pipeline fast for real pages
 * while never aborting a slow-but-valid response.
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
    /** Use a specific fingerprint instead of rotating (default: auto).
     *  Pinning a fingerprint skips got-scraping and drives the impit
     *  TLS profiles directly. */
    fingerprint?: BrowserFingerprint;
    /** Byte cap for the response body. Default: PAGE_LIMIT_BYTES (50MB).
     *  Pass PDF_LIMIT_BYTES (150MB) for PDF downloads. */
    limitBytes?: number;
    /** (WS16) Cancellation signal (the pipeline's combined abort+ceiling
     *  signal). Checked at every pass boundary and honored mid-flight by
     *  each transport; a cancelled read settles null promptly. */
    signal?: AbortSignal;
  } = {},
): Promise<PageResponse | null> {
  // (WS16) Queued-work law: a cancelled turn spends not even the DNS
  // lookup on a read nobody will use.
  if (opts.signal?.aborted) return null;
  // DNS-aware entry guard (§P6): a public hostname whose A/AAAA records
  // resolve to a private address (DNS rebinding) is rejected before any
  // pass runs.
  if (!(await isSafeUrlWithDns(url))) return null;

  const t0 = performance.now();
  const jar = newCookieJar();
  const fpOrder = opts.fingerprint
    ? [opts.fingerprint]
    : (["chrome", "firefox", "edge"] as BrowserFingerprint[]);
  const limitBytes = opts.limitBytes ?? PAGE_LIMIT_BYTES;
  const defaultTimeout = 45_000;

  // ── Pass A: got-scraping + header-generator ─────────────────────────────
  let gotResp: PageResponse | null = null;
  if (opts.fingerprint === undefined) {
    gotResp = await gotPageFetch(url, opts, jar, limitBytes, opts.timeoutMs ?? defaultTimeout, t0);
    if (gotResp && gotResp.status > 0 && !BLOCK_STATUSES.includes(gotResp.status)) {
      return gotResp;
    }
  }

  // ── Pass B: impit TLS-impersonation rotation ────────────────────────────
  // (audit 2026-11-05 WS15) That proof arrived: the pinned-fingerprint NO_
  // COOKIE repro, so the per-hop walker (impitFollow) now drives Pass B —
  // redirect:"manual" per hop, jar absorb + carry per hop, isSafeUrl per
  // target.  Pass C (wreq-js) still follows chains in Rust and returns
  // strings only (no hop hook possible there) — it is SEEDED from this jar
  // so at least the entry hop carries the session cookies the failed Pass
  // B attempts earned.
  // Fattest blocked/errored impit+got body handed to Pass C on the terminal
  // attempt (2026-11-04 audit fix — Pass C used to be unreachable because
  // every Pass B branch returned).
  let impitBest: PageResponse | null = null;
  for (let attempt = 0; attempt < (opts.retryOnBlock === false ? 1 : fpOrder.length); attempt++) {
    // (WS16) Cancelled while an earlier pass was in flight: no further
    // fingerprint attempt starts.
    if (opts.signal?.aborted) return null;
    const fp = fpOrder[attempt];
    // (WS15) No entry-cookie header here: the walker reseeds every hop it
    // issues (including this attempt's first) from the jar, so a retry
    // after a block also inherits the session cookies earlier hops earned.
    const baseHeaders = {
      ...realisticHeaders({}, fp),
      ...(opts.headers ?? {}),
    };

    try {
      const { res, finalUrl: walkFinalUrl } = await impitFollow(
        tlsClient(fp),
        url,
        {
          method: opts.method ?? "GET",
          baseHeaders,
          timeout: opts.timeoutMs ?? defaultTimeout,
        },
        jar,
        opts.signal,
      );

      const status: number = res.status;
      const rawCookies: string[] =
        Array.from((res.headers as any)?.getSetCookie?.() ?? []) as string[];
      // The walker already absorbed EVERY hop's Set-Cookie — final
      // included — under the URL that issued it (never the entry URL of a
      // chain that changed hosts), so rawCookies only feeds the response
      // contract below; the jar is the single cookie source of truth.
      const impitFinalUrl = walkFinalUrl;

      const contentType = String(
        (res.headers as any)?.get?.("content-type") ??
          (res.headers as any)?.["content-type"] ??
          "",
      );
      // (audit 2026-11-04) Retain the true bytes through the read — a PDF
      // or foreign-charset body mangled by readBounded's UTF-8 decode is
      // unrecoverable downstream.
      const sink: { bytes?: Uint8Array } = {};
      const body = await readBounded((res as any).body, limitBytes, false, sink).catch(
        () => "",
      );
      const elapsedMs = Math.round(performance.now() - t0);
      const isBlock = BLOCK_STATUSES.includes(status);

      // impit follows redirects internally — revalidate the URL it ACTUALLY
      // landed on. An unsafe landing is a dead pass, never a body.
      const finalUrl = impitFinalUrl;
      if (!isSafeUrl(finalUrl)) {
        if (gotResp) return gotResp;
        return {
          status: 0,
          ok: false,
          body: "",
          contentType: "",
          elapsedMs,
          fingerprint: fp,
          cookies: [],
          resolvedUrl: "",
        };
      }

      if (!isBlock || attempt === fpOrder.length - 1) {
        const resp: PageResponse = {
          status,
          ok: status >= 200 && status < 400,
          body,
          contentType,
          elapsedMs,
          fingerprint: fp,
          cookies: rawCookies,
          resolvedUrl: finalUrl,
          ...(sink.bytes ? { rawBytes: sink.bytes } : {}),
        };
        if (!isBlock && status !== 0) return resp; // clean content — original contract
        // Terminal attempt AND still blocked: do NOT return yet (2026-11-04
        // audit fix). Keep the fattest blocked body and break to Pass C so
        // the wreq-js TLS stack gets its own turn — this branch previously
        // always returned, which made Pass C dead code.
        impitBest = gotResp && gotResp.body.length > resp.body.length ? gotResp : resp;
        if (opts.retryOnBlock === false) return impitBest;
        break;
      }
      // Block status: fall through to the next fingerprint in the rotation.
    } catch (err: unknown) {
      // Gov TLS tolerance: expired / self-signed / incomplete-chain certs
      // (common on .gov, .gov.in, .nic.in circulars) throw a cert error —
      // retry ONCE through a rejectUnauthorized:false path so the page is
      // still readable instead of classifying as FAIL_NETWORK_OR_CRASH.
      if (isCertError(err)) {
        const tolerant = await tlsTolerantGet(url, jar, opts.timeoutMs ?? defaultTimeout, undefined, opts.signal);
        if (tolerant) return tolerant;
      }
      // Timeout / network error: the next attempt uses a different
      // fingerprint; on the last attempt hand the pass to Pass C (wreq-js,
      // independent Rust TLS stack) instead of returning (2026-11-04 audit
      // fix — same dead-code defect as the success branch).
      if (attempt === fpOrder.length - 1) {
        if (opts.retryOnBlock === false) {
          if (gotResp) return gotResp;
          return {
            status: 0,
            ok: false,
            body: "",
            contentType: "",
            elapsedMs: Math.round(performance.now() - t0),
            fingerprint: fp,
            cookies: [],
            resolvedUrl: "",
          };
        }
        impitBest = gotResp;
        break;
      }
    }
  }
  /* Pass C — wreq-js (Rust TLS, different JA3 signature than impit).
     Reached whenever Pass B terminated blocked/errored (2026-11-04 audit
     fix: the loop now BREAKS here instead of always returning, making this
     pass genuinely reachable — the "403 under impit, 200 under wreq"
     counterexample works).  The two TLS stacks have different handshake
     fingerprints, so a site that trips impit's Chrome emulation may
     accept wreq-js's emulation. */
  if (opts.retryOnBlock !== false) {
    // (WS16) Pass-chain boundary: a cancelled turn hands back what Pass B
    // already observed — wreq is never dispatched for abandoned work.
    if (opts.signal?.aborted) return impitBest;
    // (WS15 "every transport" leg) wreq-js has no hop hook — seed its
    // ENTRY request from the jar so cookies the failed impit attempts
    // earned upstream still open the session on the third TLS stack
    // (caller-supplied headers win on conflict, as elsewhere).
    const wrSeed = jar.cookieFor(url);
    const wr = await wreqFetch(url, {
      method: opts.method ?? "GET",
      headers: { ...(wrSeed ? { cookie: wrSeed } : {}), ...(opts.headers ?? {}) },
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    // SSRF: wreq-js follows redirects inside its Rust stack — recheck the
    // final URL it reports; unsafe ⇒ treat the pass as failed.
    if (wr && !isSafeUrl(wr.url ?? url)) {
      return impitBest;
    }
    if (wr && wr.status > 0 && !BLOCK_STATUSES.includes(wr.status)) {
      return {
        status: wr.status,
        ok: wr.ok,
        body: wr.body,
        contentType: wr.contentType,
        elapsedMs: Math.round(performance.now() - t0),
        fingerprint: "wreq-chrome",
        cookies: [],
        resolvedUrl: wr.url ?? url,
      };
    }
    /* wreq also blocked (or failed) — surface whichever body is bigger so
       the extractor's detectBlock has the most signal.  PageResponse shape
       requires the full interface — spread wr onto it explicitly. */
    const wrResp: PageResponse | null = wr
      ? {
          status: wr.status,
          ok: wr.ok,
          body: wr.body,
          contentType: wr.contentType,
          elapsedMs: Math.round(performance.now() - t0),
          fingerprint: "wreq-chrome",
          cookies: [],
          resolvedUrl: wr.url ?? url,
        }
      : null;
    if (wrResp && (!impitBest || wrResp.body.length > impitBest.body.length)) {
      return wrResp;
    }
  }
  return impitBest;
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
     * For HTML form-POST scraping (search-engine SERPs) the server
     * checks the full browser header set; apiHeaders sends
     * Accept: application/json which DDG's anomaly detector flags as a bot.
     */
    useRealisticHeaders?: boolean;
    /** Byte cap for the response body. Default: 50MB (up from 1MB). */
    limitBytes?: number;
    /** (WS16) Cancellation signal — see fetchPage above. */
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; ok: boolean; text: string } | null> {
  // (WS16) Queued-work law — see fetchPage above.
  if (opts.signal?.aborted) return null;
  // DNS-aware entry guard — see fetchPage above.
  if (!(await isSafeUrlWithDns(url))) return null;

  const fp = opts.fingerprint ?? "chrome";
  const baseHeaders = opts.useRealisticHeaders
    ? realisticHeaders(opts.headers, fp)
    : apiHeaders(opts.headers, fp);
  const headers: Record<string, string> = { ...baseHeaders };
  if (opts.body && !headers["content-type"]) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }

  // (WS15) One jar across BOTH passes, like fetchPage: the JSON transport's
  // chains carry cookies through got's hook AND impit's hop walker, and a
  // Pass B retry re-sends what Pass A's chain learned.
  const jar = newCookieJar();

  // ── Pass A: got-scraping. Anything that isn't a block status is final. ──
  const gotResp = await gotUrlFetch(url, opts, headers, jar);
  if (gotResp && gotResp.ok) return gotResp;
  if (gotResp && !BLOCK_STATUSES.includes(gotResp.status)) return gotResp;

  // ── Pass B: impit TLS-impersonation fallback ────────────────────────────
  // (WS16) Boundary check: once cancelled, no second transport is
  // dispatched — whatever Pass A settled with (null on abort) is returned.
  if (opts.signal?.aborted) return gotResp;
  try {
    const { res, finalUrl } = await impitFollow(
      tlsClient(fp),
      url,
      {
        method: opts.method ?? "GET",
        baseHeaders: headers,
        timeout: opts.timeoutMs ?? 40_000,
        body: opts.body,
      },
      jar,
      opts.signal,
    );
    const status: number = res.status;
    // SSRF: impit landed somewhere after redirects — the landing host must
    // be public too; unsafe ⇒ surface the Pass A observation instead.
    if (!isSafeUrl(finalUrl)) return gotResp;
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
    const resp = { status, ok: status >= 200 && status < 300, text };
    // Both passes blocked → the fatter body wins.
    if (!resp.ok && gotResp && gotResp.text.length > text.length) return gotResp;
    return resp;
  } catch {
    // impit failed — surface whatever got-scraping observed (null if both failed).
    return gotResp;
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
    /** (WS16) Cancellation signal — see fetchPage above. */
    signal?: AbortSignal;
  } = {},
): Promise<(PageResponse & { botName: string }) | null> {
  // (WS16) Queued-work law — see fetchPage above.
  if (opts.signal?.aborted) return null;
  // DNS-aware entry guard — see fetchPage above.
  if (!(await isSafeUrlWithDns(url))) return null;
  const timeout = opts.timeoutMs ?? 45_000;
  const limitBytes = opts.limitBytes ?? PAGE_LIMIT_BYTES;
  const jar = newCookieJar();

  for (const bot of LINK_PREVIEW_UAS) {
    // (WS16) No further bot is dispatched once cancelled.
    if (opts.signal?.aborted) return null;
    // The link-preview bots send their own UA; the TLS layer is still the
    // Chrome profile (the bot's UA is what the WAF whitelist matches).
    const fp: BrowserFingerprint = "chrome";
    try {
      // §8 gap fix: this jar used to ABSORB but never RESEED — a session
      // cookie earned under bot 1 was never replayed for bot 2 (mirrors
      // the Pass B reseed in fetchPage).
      const lpCarry = jar.cookieFor(url);
      // (WS16) impit hop race — see withAbort's law note above.
      const res = await withAbort(
        tlsClient(fp).fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": bot.userAgent,
            ...bot.headers,
            ...(lpCarry ? { Cookie: lpCarry } : {}),
          },
          timeout,
        } as any),
        opts.signal,
      );
      const status: number = res.status;
      // SSRF: this bot's chain landed on a private host — skip it, never
      // return that body under any bot label.
      const lpFinalUrl = String((res as any)?.url ?? url);
      if (!isSafeUrl(lpFinalUrl)) continue;
      const rawCookies: string[] =
        Array.from((res.headers as any)?.getSetCookie?.() ?? []) as string[];
      // Absorb under the FINAL host impit actually landed on.
      if (rawCookies.length > 0) jar.absorb(lpFinalUrl, rawCookies);

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
      // caller's block gate (extractor.ts) will verify the body is real content
      // (not a residual challenge page slipped through as a 200).
      return {
        status,
        ok: true,
        body,
        contentType,
        elapsedMs: 0,
        fingerprint: "chrome",
        cookies: rawCookies,
        resolvedUrl: lpFinalUrl,
        botName: bot.name,
      };
    } catch {
      // network error on this bot — try the next one
      continue;
    }
  }
  return null;
}
