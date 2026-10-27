/**
 * Part-8 thin-proxy seam (MIGRATION-MAP §7).
 *
 * When — and ONLY when — `scripts/dev-supervisor.mjs` exported
 * `RUKE_RUST_BACKEND=1`, a proxied Next route delegates the request to
 * the Rust backend (`ruke-server` on loopback, port
 * `RUKE_BACKEND_PORT`, default 3101) and hands its response straight
 * back: same status, same headers (minus hop-by-hop), same body —
 * including the SSE stream for /api/chat.
 *
 * With the variable unset — every vitest run, plain `next dev`
 * (`npm run dev:next`), and any process not started by the supervisor —
 * `rustEnabled()` is false and the route's own TS handler runs
 * verbatim. That keeps the TS oracle live, the 664-test in-process
 * golden suites untouched, and the no-Rust-binary fallback intact
 * (Rule 18: no TS deletion until parity is manually confirmed).
 *
 * Failure posture: if the Rust server is unreachable the proxy logs and
 * returns an honest 502 — it does NOT silently fall back to the TS
 * handler. Falling back after a partially streamed response would mix
 * two backends inside one turn, which is indistinguishable from a bug.
 * The supervisor owns the all-or-nothing lifecycle; a missing
 * ruke-server.exe fails the `npm run dev` boot immediately instead.
 *
 * Failure CLASSIFICATION (manual-regression fix, Part 8): a fetch()
 * rejection is only a connectivity failure when it is NOT an abort.
 * Per the fetch spec undici rejects an in-flight fetch with the signal's
 * ABORT REASON, so a browser that navigates away mid-title (Next aborts
 * `req.signal` with a `ResponseAborted` DOMException on Node 26) surfaces
 * HERE, in the same catch — it must never be stamped "unreachable".
 * See `__tests__/rust-proxy.test.ts` for the behavioral contract.
 *
 * No pino import here: `lib/server/logger.ts` is DELETE_AFTER_PARITY and
 * this seam must survive its removal, so it logs through console.
 */

export function rustEnabled(): boolean {
  return process.env.RUKE_RUST_BACKEND === "1";
}

export function rustBaseUrl(): string {
  const port = process.env.RUKE_BACKEND_PORT?.trim() || "3101";
  return `http://127.0.0.1:${port}`;
}

// Hop-by-hop headers must not cross the proxy (RFC 9110 §7.6.1).
// `accept-encoding` is stripped on the REQUEST leg so undici negotiates
// (and transparently decodes) its own; the Rust handlers parse request
// bodies as text, so a browser's `gzip` on the wire would corrupt them.
// `content-length`/`transfer-encoding` are stripped on the RESPONSE leg
// because undici has already re-framed the body we re-emit.
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);

function forwardableHeaders(headers: Headers): [string, string][] {
  const out: [string, string][] = [];
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.push([key, value]);
  });
  return out;
}

/**
 * Was a fetch() rejection caused by the DOWNSTREAM client hanging up rather
 * than by Rust being unreachable? Evidence combined (never the error name
 * alone): `req.signal` is the ONLY signal handed to fetch(), so once it is
 * aborted, whatever name undici stamped (AbortError, or ResponseAborted when
 * Node/Next aborts with that reason) describes our own teardown of the
 * upstream leg — not a connectivity failure. A genuine connect failure is a
 * TypeError("fetch failed") carrying err.cause.code, with the signal untouched.
 * An abort-named error arriving with an un-aborted signal is still in the
 * cancellation family (nothing else in this seam can abort the fetch).
 */
function isDownstreamCancellation(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === "AbortError" || name === "ResponseAborted";
}

/** Best specific code for the §9 log tag: undici puts the real errno on cause. */
function connectivityCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown; name?: unknown } } | null | undefined)?.cause;
  const causeCode = typeof cause?.code === "string" ? cause.code : undefined;
  const causeName = typeof cause?.name === "string" ? cause.name : undefined;
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return causeCode ?? causeName ?? (typeof name === "string" ? name : "unknown");
}

/**
 * `rustPath` is the Rust-mounted path (e.g. "/api/ruke/settings" or the
 * same-path "/api/chat"); dynamic segments are the CALLER's job (it
 * holds the decoded Next route params — encodeURIComponent them there).
 * The original query string is preserved verbatim.
 */
export async function rustProxy(req: Request, rustPath: string): Promise<Response> {
  const base = rustBaseUrl();
  const query = new URL(req.url).search;
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: forwardableHeaders(req.headers),
    signal: req.signal,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Streaming pass-through of the request body (chat payloads carry
    // attachment REFS, not bytes, but half-duplex keeps it general).
    init.body = req.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(base + rustPath + query, init);
  } catch (err) {
    if (isDownstreamCancellation(err, req.signal)) {
      // The DOWNSTREAM request was cancelled (chat "stop", a navigated-away
      // title request). Rust was reached — or the client was already gone
      // before we connected — so the "unreachable" 502 would be a lie the
      // dead client can never see. Rust's own semantics own what happens
      // next (title jobs are not bound to the HTTP request; the chat
      // request abort has already propagated upstream via the forwarded
      // req.signal on `init`).
      console.debug(`[rust-proxy] ${req.method} ${rustPath} -> ${base}: cancelled by downstream client`);
      // Never delivered (the downstream socket is gone); the status is a
      // formality and must NOT be the 502 unreachable shape.
      return new Response(null, { status: 204 });
    }
    // Genuine connectivity failure — or an unrecognized error, which fails
    // CLOSED to the honest 502 so a real Rust crash is never swallowed.
    console.error(`[rust-proxy] ${req.method} ${rustPath} -> ${base}: unreachable [${connectivityCode(err)}]`);
    return new Response(JSON.stringify({ error: `Rust backend unreachable at ${base}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.append(key, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}
