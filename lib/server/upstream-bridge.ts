/**
 * upstream-bridge.ts — the ONE client-side door to direct generations
 * against the shared model endpoint (2026-11-15 brief §3.1).
 *
 * The endpoint serves ONE concurrent generation. Rust's
 * `ruke_core::admission::UpstreamAdmission` (ruke-server `AppState
 * .admission`) is the single authority whenever the Rust backend runs —
 * which is every non-chat TS generation (search-gate plan, llm-json,
 * vision pre-pass, attach notes, titles, audio warm-up). So in Rust mode
 * this module posts the payload to ruke-server's authenticated loopback
 * route `/api/ruke/internal/completion` and the Rust permit serializes it
 * beside the chat streams.
 *
 * When `RUKE_RUST_BACKEND !== "1"` there is no Rust process, so the same
 * helpers fall back to a PROCESS-LOCAL capacity-1 admission with the same
 * honest semantics (bounded waiters, fail-fast busy, cancel-safe). That
 * local gate also governs the TS-owned STREAMING sites (chat route,
 * web-tool-loop rounds) — reachable only in TS-only mode, because
 * `app/api/chat` proxies straight to Rust otherwise (route.ts:573), and
 * Rust's own admission already owns its streams. The two authorities
 * therefore never race for the same endpoint.
 *
 * Deadlock law (mirrors the Rust side): a caller must never hold a local
 * permit while awaiting another acquire. Rounds release the permit when
 * the response body fully drains (never at headers arrival); tool/helper
 * generations run strictly after that release.
 *
 * Rule 17: logs carry labels and statuses only — never the secret, never
 * payload bodies.
 */

import { rustEnabled, rustBaseUrl, internalSecretHeaders } from "./rustProxy";
import { llmApiUrl, llmApiKey } from "./settings";
import { childLogger } from "./logger";

const log = childLogger("upstream-bridge");

/** Same bound as the Rust authority's DEFAULT_MAX_WAITERS. */
const MAX_WAITERS = 4;

/** Fail-fast "the shared endpoint is saturated" signal (streams throw it;
 * completions degrade to `null` with it logged). */
export class UpstreamBusyError extends Error {
  constructor() {
    super("Model endpoint is busy; please retry.");
    this.name = "UpstreamBusyError";
  }
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

interface LocalWaiter {
  settled: boolean;
  grant(release: () => void): void;
}

/** Capacity-1 FIFO admission for this process (TS-only mode). Mirrors the
 * Rust semantics: bounded queue, cancel-safe waiters, exactly-once release
 * with FIFO hand-off. */
class LocalUpstreamAdmission {
  private active = false;
  private queue: LocalWaiter[] = [];

  get inFlight(): boolean {
    return this.active;
  }
  get queued(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!this.active) {
      this.active = true;
      return Promise.resolve(this.makeRelease());
    }
    if (this.queue.length >= MAX_WAITERS) return Promise.reject(new UpstreamBusyError());
    return new Promise<() => void>((resolve, reject) => {
      const w: LocalWaiter = { settled: false, grant: resolve };
      this.queue.push(w);
      signal?.addEventListener(
        "abort",
        () => {
          if (w.settled) return;
          w.settled = true;
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  private makeRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      // FIFO hand-off: the capacity passes straight to the oldest
      // unsettled waiter; only an empty queue frees the slot.
      while (this.queue.length) {
        const next = this.queue.shift()!;
        if (!next.settled) {
          next.settled = true;
          next.grant(this.makeRelease());
          return;
        }
      }
      this.active = false;
    };
  }
}

const localAdmission = new LocalUpstreamAdmission();

/** Merge the caller's signal with an optional timeout; returns a
 * `dispose()` that clears the timer (no dangling handles). */
function mergeSignal(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs === undefined && !external) return { signal: undefined, dispose: () => {} };
  const ctrl = new AbortController();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export interface UpstreamAnswer {
  status: number;
  /** Parsed JSON body, or null when the body was absent/unparseable. */
  json: unknown;
}

/**
 * NON-STREAMING shared completion. Never throws except when the CALLER's
 * own `signal` aborted and `throwOnAbort` is set (titles rely on the
 * abort-throw to yield the queue). Every other failure — busy queue,
 * timeout, unreachable upstream, bridge refusal — returns `null`, exactly
 * matching each call site's existing degrade-on-catch semantics.
 *
 * `targetUrl` (dev override, e.g. WEB_SEARCH_LLM_ENDPOINT): the bridge
 * route only reaches the CONFIGURED main model, so an explicit alternate
 * target runs under the LOCAL admission with a direct fetch — still
 * managed, just not behind the Rust authority.
 */
export async function sharedUpstreamCompletion(o: {
  body: Record<string, unknown>;
  label: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  throwOnAbort?: boolean;
  targetUrl?: string;
}): Promise<UpstreamAnswer | null> {
  if (o.body.stream === true) {
    throw new Error("sharedUpstreamCompletion: stream:true must use sharedUpstreamStream");
  }
  const aborted = (e: unknown) => (e as Error)?.name === "AbortError";
  const abortOutcome = (e: unknown): null => {
    if (aborted(e) && o.throwOnAbort && o.signal?.aborted) throw e as Error;
    return null;
  };

  if (rustEnabled() && !o.targetUrl) {
    const payload: Record<string, unknown> = { ...o.body };
    // `timeout_ms` is the BRIDGE control (caps queue wait AND generation
    // inside ruke-server); it is stripped there before forwarding.
    if (o.timeoutMs !== undefined) payload.timeout_ms = o.timeoutMs;
    const sig = mergeSignal(o.signal, o.timeoutMs);
    try {
      const res = await fetch(`${rustBaseUrl()}/api/ruke/internal/completion`, {
        method: "POST",
        headers: { "content-type": "application/json", ...internalSecretHeaders() },
        body: JSON.stringify(payload),
        signal: sig.signal,
      });
      if (res.status === 401 || res.status === 403) {
        // Misconfiguration, not busy: honestly loud, still degrading.
        log.error({ label: o.label }, "internal completion bridge refused (secret mismatch?)");
        return null;
      }
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    } catch (e: unknown) {
      if (aborted(e)) return abortOutcome(e);
      log.warn({ label: o.label, err: (e as Error).message }, "completion bridge unreachable");
      return null;
    } finally {
      sig.dispose();
    }
  }

  // TS-only mode (or an explicit alternate target): process-local capacity-1.
  let release: (() => void) | undefined;
  try {
    release = await localAdmission.acquire(o.signal);
  } catch (e: unknown) {
    if (e instanceof UpstreamBusyError) log.warn({ label: o.label }, "local queue full; degrading");
    return abortOutcome(e);
  }
  const sig = mergeSignal(undefined, o.timeoutMs);
  try {
    const res = await fetch(o.targetUrl ?? llmApiUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer " + llmApiKey(),
      },
      body: JSON.stringify(o.body),
      signal: sig.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (e: unknown) {
    if (aborted(e)) return abortOutcome(e);
    log.warn({ label: o.label, err: (e as Error).message }, "local upstream unreachable");
    return null;
  } finally {
    sig.dispose();
    release();
  }
}

/**
 * STREAMING shared generation (TS-only-mode chat paths only — see module
 * header). Throws like `fetch` (AbortError on abort/timeout, TypeError on
 * network failure) plus UpstreamBusyError when the local queue is
 * saturated; the permit is released when the RESPONSE drains to the end
 * or the consumer cancels — never at headers arrival.
 */
export async function sharedUpstreamStream(o: {
  body: string;
  label: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const release = await localAdmission.acquire(o.signal);
  try {
    const res = await fetch(llmApiUrl(), {
      method: "POST",
      // Byte-locked order ⇔ Rust `error::upstream_headers` (content-type,
      // authorization, accept). The rust-golden fixtures record these.
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer " + llmApiKey(),
        Accept: "text/event-stream",
      },
      body: o.body,
      signal: o.signal,
    });
    if (!res.ok) {
      // Drain here so release never depends on the caller consuming.
      const errText = await res.text().catch(() => "");
      release();
      return new Response(errText, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
      });
    }
    if (!res.body) {
      release();
      return res;
    }
    const wrapped = wrapBodyReleasing(res.body, release);
    return new Response(wrapped, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e: unknown) {
    release();
    throw e;
  }
}

function wrapBodyReleasing(
  src: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { value, done: d } = await reader.read();
        if (d) {
          once();
          ctrl.close();
        } else {
          ctrl.enqueue(value);
        }
      } catch (e: unknown) {
        once();
        ctrl.error(e);
      }
    },
    cancel(reason) {
      once();
      return reader.cancel(reason);
    },
  });
}

/** Telemetry/test seam: the local authority's live state. */
export function localUpstreamState(): { inFlight: boolean; queued: number } {
  return { inFlight: localAdmission.inFlight, queued: localAdmission.queued };
}
