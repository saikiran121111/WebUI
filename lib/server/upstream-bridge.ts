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

/** The lifecycle deadline expired (distinct from a caller cancellation). */
export class UpstreamTimeoutError extends Error {
  constructor(ms: number) {
    super(`Upstream deadline of ${ms}ms expired`);
    this.name = "UpstreamTimeoutError";
  }
}

/** How an upstream operation ended. The outcome stays distinguishable all
 * the way into the logs: abort != timeout != saturation != upstream error. */
export type UpstreamOutcome = "caller-abort" | "deadline" | "saturated" | "upstream" | "ok";

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/** True for anything fetch rejects because its signal aborted. */
export function isAbortLike(e: unknown): boolean {
  const name = (e as Error)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

interface UpstreamLifecycle {
  /** Combined signal: caller abort OR deadline. It is passed to the queue
   * wait, the fetch and the response-body consumption alike. `undefined`
   * when the caller gave neither a signal nor a timeout. */
  signal: AbortSignal | undefined;
  /** Why the combined signal fired ("" while still live). */
  endReason(): "" | "caller" | "timeout";
  /** Removes the external listener and clears the timer. Idempotent. */
  dispose(): void;
}

/**
 * Build the ONE cancellation+deadline lifecycle for an operation (R01).
 * The timer starts NOW, strictly before any queue wait, and an already
 * aborted caller signal fires immediately, so pre-aborted work never
 * enters the queue and a deadline spent queuing is a real timeout.
 */
function startLifecycle(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): UpstreamLifecycle {
  if (!external && timeoutMs === undefined) {
    return { signal: undefined, endReason: () => "", dispose: () => {} };
  }
  const ctrl = new AbortController();
  let reason: "" | "caller" | "timeout" = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let offExternal: (() => void) | undefined;
  const fire = (r: "caller" | "timeout") => {
    if (reason !== "") return;
    reason = r;
    // abort(reason) makes undici reject with THIS reason, which is how the
    // two endings stay tellable apart downstream.
    ctrl.abort(r === "timeout" ? new UpstreamTimeoutError(timeoutMs ?? 0) : (external?.reason ?? r));
  };
  if (external) {
    if (external.aborted) fire("caller");
    else {
      const onAbort = () => fire("caller");
      external.addEventListener("abort", onAbort, { once: true });
      offExternal = () => external.removeEventListener("abort", onAbort);
    }
  }
  if (timeoutMs !== undefined && timeoutMs >= 0 && reason === "") {
    timer = setTimeout(() => fire("timeout"), timeoutMs);
  }
  return {
    signal: ctrl.signal,
    endReason: () => reason,
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (offExternal) {
        offExternal();
        offExternal = undefined;
      }
    },
  };
}

/** Classify a thrown error plus the live lifecycle state into an outcome. */
function outcomeOf(e: unknown, lc: UpstreamLifecycle): UpstreamOutcome {
  if (e instanceof UpstreamBusyError) return "saturated";
  if (e instanceof UpstreamTimeoutError || lc.endReason() === "timeout") return "deadline";
  if (isAbortLike(e) || lc.endReason() === "caller") return "caller-abort";
  return "upstream";
}

/**
 * Race a RESPONSE-BODY read against the operation's lifecycle (R01: the
 * lifecycle governs queue wait, fetch AND body consumption). A transport
 * that stalls mid-body can therefore never park the one permit past its
 * deadline; the pending read is abandoned with a best-effort cancel and the
 * real cause (deadline vs caller abort) is re-thrown, not flattened.
 */
function raceBody<T>(read: Promise<T>, res: Response, lc: UpstreamLifecycle): Promise<T> {
  if (!lc.signal) return read;
  const signal = lc.signal;
  return new Promise<T>((resolve, reject) => {
    const lose = () => {
      try {
        void res.body?.cancel().catch(() => undefined);
      } catch {
        /* already consumed/locked — nothing else to give back */
      }
      reject(signal.reason ?? abortError());
    };
    if (signal.aborted) {
      lose();
      return;
    }
    signal.addEventListener("abort", lose, { once: true });
    read.then(
      (value) => {
        signal.removeEventListener("abort", lose);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", lose);
        reject(err);
      },
    );
  });
}

/* -- endpoint / resource identity (R03) ----------------------------------- */

/** Hostnames that all name THIS machine's inference server. */
const LOOPBACK_ALIASES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "ip6-localhost",
  "ip6-loopback",
  "host.docker.internal",
]);

/**
 * Identity of an inference RESOURCE = origin (scheme + canonical host +
 * effective port). Capacity is a property of the SERVER, not of a path or
 * a spelling, so "/v1/chat/completions" and "/v1/completions" on one origin
 * are the same resource, and localhost/127.0.0.1/::1 are one alias family.
 * Unparseable strings degrade to a trimmed lowercase spelling.
 */
export function resourceKey(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "raw:" + rawUrl.trim().toLowerCase();
  }
  const scheme = u.protocol === "https:" ? "https" : "http";
  let host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (LOOPBACK_ALIASES.has(host)) host = "127.0.0.1";
  const implicitPort = scheme === "http" ? "80" : "443";
  const port = u.port && u.port !== implicitPort ? `:${u.port}` : "";
  return `${scheme}://${host}${port}`;
}

/** True when `candidate` addresses the SAME server as the configured model. */
export function sameResourceAsConfigured(candidate: string): boolean {
  return resourceKey(candidate) === resourceKey(llmApiUrl());
}

/**
 * Credential for one resource. The configured bearer belongs to the
 * configured endpoint ONLY; a different origin authenticates with its own
 * WEB_SEARCH_LLM_API_KEY (or with nothing), never with the main model token.
 */
function credentialFor(resKey: string): string | undefined {
  if (resKey === resourceKey(llmApiUrl())) return llmApiKey();
  const own = process.env.WEB_SEARCH_LLM_API_KEY?.trim();
  return own || undefined;
}

interface LocalWaiter {
  settled: boolean;
  grant(release: () => void): void;
  /** Detaches this waiter's abort listener. Called on grant, so a granted
   * waiter never keeps a listener parked on the caller's signal. */
  off?: () => void;
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
      if (signal) {
        const onAbort = () => {
          // A waiter that already took the hand-off is handled by the door
          // (it releases immediately) — never splice a granted waiter.
          if (w.settled) return;
          w.settled = true;
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        w.off = () => signal.removeEventListener("abort", onAbort);
      }
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
          next.off?.();
          next.off = undefined;
          next.grant(this.makeRelease());
          return;
        }
      }
      this.active = false;
    };
  }
}

/** One capacity-1 gate per distinct inference RESOURCE. The configured
 * endpoint owns the shared gate; an override origin gets its own gate and
 * its own credential, so two different servers never share one permit. */
const localAdmissions = new Map<string, LocalUpstreamAdmission>();

function admissionForResource(resKey: string): LocalUpstreamAdmission {
  let a = localAdmissions.get(resKey);
  if (!a) {
    a = new LocalUpstreamAdmission();
    localAdmissions.set(resKey, a);
  }
  return a;
}

const configuredGate = () => admissionForResource(resourceKey(llmApiUrl()));

/**
 * Acquire the gate for one resource under the operation's lifecycle (R01).
 * Handles the abort/grant race: if the lifecycle died while the FIFO
 * hand-off was in flight, `releaseEarly` reports a permit we must hand back
 * immediately instead of pretending the work is live.
 */
async function acquireFor(
  resKey: string,
  lc: UpstreamLifecycle,
): Promise<{ release: () => void; releaseEarly: boolean }> {
  const release = await admissionForResource(resKey).acquire(lc.signal);
  return { release, releaseEarly: lc.signal?.aborted === true };
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
  const abortOutcome = (e: unknown): null => {
    if (isAbortLike(e) && o.throwOnAbort && o.signal?.aborted) throw e as Error;
    return null;
  };
  // R01: ONE lifecycle, created before admission. Its deadline starts on the
  // queue, and its signal carries through fetch AND body consumption.
  const lc = startLifecycle(o.signal, o.timeoutMs);
  try {
    // Pre-aborted work never enters the queue.
    if (lc.signal?.aborted) return abortOutcome(lc.signal.reason ?? abortError());

    // R03: RESOURCE IDENTITY decides the authority. A targetUrl that merely
    // re-states the configured endpoint (alias, path or port spelling) is the
    // same resource and still goes through the Rust authority in Rust mode;
    // only a genuinely different origin may use a separate gate.
    const configured = !o.targetUrl || sameResourceAsConfigured(o.targetUrl);

    if (rustEnabled() && configured) {
      const payload: Record<string, unknown> = { ...o.body };
      // `timeout_ms` is the BRIDGE control (caps queue wait AND generation
      // inside ruke-server); it is stripped there before forwarding.
      if (o.timeoutMs !== undefined) payload.timeout_ms = o.timeoutMs;
      const res = await fetch(`${rustBaseUrl()}/api/ruke/internal/completion`, {
        method: "POST",
        headers: { "content-type": "application/json", ...internalSecretHeaders() },
        body: JSON.stringify(payload),
        signal: lc.signal,
      });
      if (res.status === 401 || res.status === 403) {
        // Misconfiguration, not busy: honestly loud, still degrading.
        log.error({ label: o.label }, "internal completion bridge refused (secret mismatch?)");
        return null;
      }
      const json = await raceBody(res.json().catch(() => null), res, lc);
      return { status: res.status, json };
    }

    // Same server with no Rust process, OR a genuinely different origin:
    // per-resource process-local capacity-1, with the matching credential.
    const resKey = configured ? resourceKey(llmApiUrl()) : resourceKey(o.targetUrl!);
    let release: (() => void) | undefined;
    try {
      const grant = await acquireFor(resKey, lc);
      release = grant.release;
      if (grant.releaseEarly) {
        release();
        release = undefined;
        return abortOutcome(lc.signal?.reason ?? abortError());
      }
    } catch (e: unknown) {
      const outcome = outcomeOf(e, lc);
      if (outcome === "saturated") {
        log.warn({ label: o.label, outcome }, "local queue full; degrading");
      } else if (outcome === "deadline") {
        // The deadline started BEFORE the queue wait, so a request that
        // spent its whole budget queued reports the REAL cause.
        log.warn({ label: o.label, outcome, timeoutMs: o.timeoutMs }, "deadline expired while queued");
      }
      return abortOutcome(e);
    }
    try {
      const cred = credentialFor(resKey);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cred) headers.Authorization = "Bearer " + cred;
      const res = await fetch(o.targetUrl ?? llmApiUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(o.body),
        // The lifecycle signal, not a post-acquisition one: an abort or a
        // deadline that fires mid-body now reaches the transport.
        signal: lc.signal,
      });
      const json = await raceBody(res.json().catch(() => null), res, lc);
      return { status: res.status, json };
    } finally {
      release?.();
    }
  } catch (e: unknown) {
    // Timeout and caller-abort stay distinguishable from an unreachable
    // upstream (R01 acceptance: no collapsed outcomes in the logs).
    const outcome = outcomeOf(e, lc);
    if (isAbortLike(e) || e instanceof UpstreamTimeoutError) {
      // A caller cancellation is expected (the user pressed stop) and stays
      // quiet; a DEADLINE that expired mid-fetch or mid-body-consumption is
      // a real failure and must be recorded, never swallowed by the abort
      // path.
      if (outcome === "deadline") {
        log.warn(
          { label: o.label, outcome, timeoutMs: o.timeoutMs, err: (e as Error)?.message },
          "upstream deadline expired",
        );
      }
      return abortOutcome(e);
    }
    log.warn(
      { label: o.label, outcome, err: (e as Error)?.message },
      outcome === "deadline" ? "upstream deadline expired" : "upstream unreachable",
    );
    return null;
  } finally {
    // Every outcome disposes the timer AND the external-signal listener:
    // success, abort, timeout, busy degrade and a throw out of res.json().
    lc.dispose();
  }
}

/**
 * STREAMING shared generation (TS-only-mode chat paths only — see module
 * header). Throws like `fetch` (AbortError on abort/timeout, TypeError on
 * network failure) plus UpstreamBusyError when the local queue is
 * saturated. The caller's signal covers the queue wait, the fetch AND the
 * body; the permit releases when the response drains, errors, or the
 * consumer's cancellation has been ACKNOWLEDGED by the transport (R02) —
 * never at headers arrival and never while a cancel is still outstanding.
 */
export async function sharedUpstreamStream(o: {
  body: string;
  label: string;
  signal?: AbortSignal;
  /** Optional hard deadline for queue + generation (same lifecycle law as
   * the completion path: the clock starts before the queue wait). */
  timeoutMs?: number;
  /** Test seam: how long to wait for a transport to acknowledge a cancel
   * before force-releasing the one permit with a loud warning. */
  cancelGraceMs?: number;
}): Promise<Response> {
  // R01: the cancellation/deadline exists BEFORE the queue wait, and the
  // same signal is handed to fetch, so an abort during body consumption
  // reaches the transport instead of leaving the permit parked on a read
  // that will never return.
  const lc = startLifecycle(o.signal, o.timeoutMs);
  let release: (() => void) | undefined;
  try {
    if (lc.signal?.aborted) throw lc.signal.reason ?? abortError();
    const grant = await acquireFor(resourceKey(llmApiUrl()), lc);
    release = grant.release;
    if (grant.releaseEarly) {
      // Abort raced the FIFO hand-off: give the permit straight back.
      release();
      release = undefined;
      throw lc.signal?.reason ?? abortError();
    }
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
      signal: lc.signal,
    });
    if (!res.ok) {
      // Drain here so release never depends on the caller consuming.
      const errText = await raceBody(res.text().catch(() => ""), res, lc).catch(() => "");
      release();
      release = undefined;
      lc.dispose();
      return new Response(errText, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
      });
    }
    if (!res.body) {
      release();
      release = undefined;
      lc.dispose();
      return res;
    }
    // The wrapped body owns the release and the lifecycle disposal.
    const wrapped = wrapBodyReleasing(
      res.body,
      () => {
        lc.dispose();
        release?.();
        release = undefined;
      },
      o.label,
      o.cancelGraceMs ?? CANCEL_GRACE_MS_DEFAULT,
    );
    return new Response(wrapped, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e: unknown) {
    release?.();
    lc.dispose();
    throw e;
  }
}

/** Bound on how long an UNACKNOWLEDGED transport cancel may keep the one
 * permit occupied. Hitting it is a provider-contract violation and is
 * logged loudly, never swallowed (R02 acceptance). */
const CANCEL_GRACE_MS_DEFAULT = 5_000;

function wrapBodyReleasing(
  src: ReadableStream<Uint8Array>,
  release: () => void,
  label: string,
  cancelGraceMs: number,
): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let released = false;
  // Once the CONSUMER cancels, the cancellation path owns the release.
  // Real cause of the R02 defect: the streams spec RESOLVES an outstanding
  // reader.read() as {done:true} the instant cancel() is called, so the
  // pull path used to report a "finished stream" while the transport had
  // not acknowledged the cancel. A resolved read is NOT an acknowledgement.
  let cancelling = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { value, done: d } = await reader.read();
        if (cancelling) return; // consumer is gone; cancel() owns the release
        if (d) {
          finish();
          ctrl.close();
        } else {
          ctrl.enqueue(value);
        }
      } catch (e: unknown) {
        if (!cancelling) finish();
        try {
          ctrl.error(e);
        } catch {
          /* sink already closed by the consumer's cancel */
        }
      }
    },
    cancel(reason): Promise<void> {
      // R02: ownership lasts until the transport ACKNOWLEDGES the cancel.
      // A rejected cancellation still releases (a failed cancel must not
      // strand the only permit), and a transport that never acknowledges
      // gets a bounded grace period plus an honest warning.
      cancelling = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log.warn(
            { label, graceMs: cancelGraceMs },
            "transport never acknowledged cancellation; releasing permit (upstream may still be generating)",
          );
          finish();
          resolve();
        }, cancelGraceMs);
      });
      const ack = reader.cancel(reason).then(
        () => {
          if (timer !== undefined) clearTimeout(timer);
          finish();
        },
        (e: unknown) => {
          if (timer !== undefined) clearTimeout(timer);
          log.warn({ label, err: (e as Error)?.message }, "transport cancel rejected; releasing permit");
          finish();
        },
      );
      return Promise.race([ack, bounded]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    },
  });
}

/** Telemetry/test seam: the live state of the configured endpoint's gate, or
 * of the gate that owns `forUrl` (an override origin reports its own). */
export function localUpstreamState(forUrl?: string): { inFlight: boolean; queued: number } {
  const a = forUrl ? admissionForResource(resourceKey(forUrl)) : configuredGate();
  return { inFlight: a.inFlight, queued: a.queued };
}

/** Telemetry/test seam: which resource gates currently exist. */
export function localUpstreamResources(): string[] {
  return [...localAdmissions.keys()];
}
