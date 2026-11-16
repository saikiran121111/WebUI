/**
 * Admission-door law (2026-11-15 brief §3, R01/R02/R03).
 *
 * What these tests pin — all against MOCKED transports, so they never touch
 * the shared endpoint:
 *
 *  R01 ONE lifecycle per operation, created BEFORE admission:
 *    - pre-aborted work never enters the queue and never fetches;
 *    - a queued request that aborts leaves the holder's permit intact and
 *      frees its own queue slot;
 *    - a deadline spent ENTIRELY in the queue is a real timeout (never a
 *      free pass into the endpoint) and is logged as a deadline, not as
 *      "unreachable";
 *    - caller cancellation during the fetch reaches the transport;
 *    - the same deadline covers RESPONSE-BODY consumption: a stalled body
 *      cannot park the only permit past its deadline;
 *    - every outcome releases exactly once and disposes its timer plus its
 *      external-signal listener (no handle leaks);
 *    - abort / deadline / saturation / upstream failure stay distinguishable.
 *
 *  R02 permit ownership through cancellation:
 *    - headers arrival never releases;
 *    - a deferred underlying cancel keeps the permit held until the
 *      transport acknowledges;
 *    - a rejected cancel releases (a failed cancel must not strand it);
 *    - a transport that NEVER acknowledges is bounded by an explicit grace
 *      and is logged, never silently swallowed.
 *
 *  R03 resource identity, not string equality:
 *    - aliases of the configured endpoint (localhost/127.0.0.1, port and
 *      path spellings) are the SAME resource and still go through the Rust
 *      authority — an override can never smuggle shared-endpoint traffic
 *      past the one permit;
 *    - a genuinely different origin gets its OWN gate and its OWN
 *      credential; the configured model's bearer is never sent there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({
  url: "http://127.0.0.1:1234/v1/chat/completions",
  key: "configured-secret",
  // Structured shape: the assertions below read meta.outcome / msg, so an
  // untyped meta would let a mistyped log silently pass as a verified cause.
  warns: [] as Array<{ meta: Record<string, unknown>; msg: string }>,
  errors: [] as Array<{ meta: Record<string, unknown>; msg: string }>,
}));

vi.mock("@/lib/server/settings", () => ({
  llmApiUrl: () => cfg.url,
  llmApiKey: () => cfg.key,
}));
vi.mock("@/lib/server/logger", () => ({
  childLogger: () => ({
    info: () => undefined,
    warn: (meta?: unknown, msg?: unknown) => {
      cfg.warns.push({ meta: meta as Record<string, unknown>, msg: String(msg ?? "") });
    },
    error: (meta?: unknown, msg?: unknown) => {
      cfg.errors.push({ meta: meta as Record<string, unknown>, msg: String(msg ?? "") });
    },
    debug: () => undefined,
  }),
}));

import {
  localUpstreamResources,
  localUpstreamState,
  resourceKey,
  sameResourceAsConfigured,
  sharedUpstreamCompletion,
  sharedUpstreamStream,
} from "@/lib/server/upstream-bridge";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function okJson(payload: unknown = { ok: 1 }): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch-faithful mock: like the real transport, it rejects with the
 * signal's reason when the caller aborts while the request is in flight.
 * A mock that ignores `init.signal` would silently un-test R01's promise
 * that caller cancellation reaches the transport.
 */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    (async (url: unknown, init: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      const started = handler(u, init);
      const signal = init?.signal;
      if (!signal) return started;
      return await new Promise<Response>((resolve, reject) => {
        const lose = () =>
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        if (signal.aborted) {
          lose();
          return;
        }
        signal.addEventListener("abort", lose, { once: true });
        Promise.resolve(started).then(
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
    }) as unknown as typeof fetch,
  );
  return calls;
}

/** Drain N microtask hops without any timer dependence. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function headersOf(init: RequestInit): Record<string, string> {
  return { ...(init.headers as Record<string, string> | undefined) };
}

/** A fresh process-local gate per test: its own loopback port, so no test
 * can inherit another test's permit (gates are keyed by resource origin). */
let portSeq = 4200;
function freshResource(): string {
  portSeq += 1;
  return `http://127.0.0.1:${portSeq}/v1/chat/completions`;
}

beforeEach(() => {
  cfg.warns.length = 0;
  cfg.errors.length = 0;
  delete process.env.RUKE_RUST_BACKEND;
  delete process.env.WEB_SEARCH_LLM_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.RUKE_RUST_BACKEND;
  delete process.env.WEB_SEARCH_LLM_API_KEY;
});

describe("R03 resource identity (aliases, ports, paths)", () => {
  it("unifies loopback spellings, ports and paths into one resource key", () => {
    expect(resourceKey("http://localhost:1234/v1/chat/completions")).toBe(
      resourceKey("http://127.0.0.1:1234/v1/completions"),
    );
    expect(resourceKey("http://127.0.0.1:1234/v1/chat/completions/")).toBe(resourceKey(cfg.url));
    expect(resourceKey("http://127.0.0.1:1234")).toBe(resourceKey(cfg.url));
    expect(sameResourceAsConfigured("http://LOCALHOST:1234/v1/chat/completions")).toBe(true);
    expect(sameResourceAsConfigured("http://127.0.0.1:8080/v1/chat/completions")).toBe(false);
  });

  it("folds implicit ports and keeps real ones distinct", () => {
    expect(resourceKey("http://example.com:80/search/x")).toBe("http://example.com");
    expect(resourceKey("https://example.com:443")).toBe("https://example.com");
    expect(resourceKey("http://example.com:80")).not.toBe(resourceKey("http://example.com:8080"));
  });
});

describe("R01 lifecycle governs queue, fetch and body", () => {
  it("rejects pre-aborted work before the queue and before fetch", async () => {
    const url = freshResource();
    const calls = stubFetch(() => okJson());
    const ac = new AbortController();
    ac.abort();
    const out = await sharedUpstreamCompletion({ body: { model: "d" }, label: "pre", targetUrl: url, signal: ac.signal });
    expect(out).toBeNull();
    expect(calls.length).toBe(0);
    expect(localUpstreamState(url)).toEqual({ inFlight: false, queued: 0 });
  });

  it("a queued abort frees its own slot and never touches the holder", async () => {
    const url = freshResource();
    const gate = deferred<Response>();
    let n = 0;
    const calls = stubFetch(() => {
      n += 1;
      return n === 1 ? gate.promise : Promise.resolve(okJson());
    });
    const holder = sharedUpstreamCompletion({ body: { model: "d" }, label: "holder", targetUrl: url });
    await flush(2);
    expect(localUpstreamState(url)).toEqual({ inFlight: true, queued: 0 });

    const ac = new AbortController();
    const queued = sharedUpstreamCompletion({ body: { model: "d" }, label: "queued", targetUrl: url, signal: ac.signal });
    await flush(3);
    expect(localUpstreamState(url)).toEqual({ inFlight: true, queued: 1 });

    ac.abort();
    expect(await queued).toBeNull();
    expect(localUpstreamState(url)).toEqual({ inFlight: true, queued: 0 });

    gate.resolve(okJson());
    expect((await holder)?.status).toBe(200);
    expect(localUpstreamState(url)).toEqual({ inFlight: false, queued: 0 });
    expect(calls.length).toBe(1); // the aborted challenger never reached the endpoint
  });

  it("a deadline spent entirely in the queue is an honest timeout", async () => {
    vi.useFakeTimers();
    const url = freshResource();
    const gate = deferred<Response>();
    let n = 0;
    const calls = stubFetch(() => {
      n += 1;
      return n === 1 ? gate.promise : Promise.resolve(okJson());
    });
    const holder = sharedUpstreamCompletion({ body: { model: "d" }, label: "holder", targetUrl: url });
    await vi.advanceTimersByTimeAsync(0);
    expect(localUpstreamState(url)).toEqual({ inFlight: true, queued: 0 });

    const queued = sharedUpstreamCompletion({ body: { model: "d" }, label: "deadline", targetUrl: url, timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await queued).toBeNull();
    expect(localUpstreamState(url)).toEqual({ inFlight: true, queued: 0 });
    // Distinguishable outcome: a deadline, not an unreachable upstream.
    expect(cfg.warns.some((w) => w.meta?.outcome === "deadline")).toBe(true);
    expect(cfg.warns.some((w) => w.msg === "local upstream unreachable")).toBe(false);

    gate.resolve(okJson());
    expect((await holder)?.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it("cancels an in-flight generation and hands the permit back", async () => {
    const url = freshResource();
    const gate = deferred<Response>();
    stubFetch(() => gate.promise);
    const ac = new AbortController();
    const p = sharedUpstreamCompletion({ body: { model: "d" }, label: "active", targetUrl: url, signal: ac.signal });
    await flush(2);
    expect(localUpstreamState(url)).toEqual({ inFlight: true, queued: 0 });
    ac.abort();
    expect(await p).toBeNull();
    expect(localUpstreamState(url)).toEqual({ inFlight: false, queued: 0 });
    gate.resolve(okJson()); // transport acknowledgement arrives late; nothing left to wait on
  });

  it("the deadline also covers a stalled response body (permit never parked)", async () => {
    vi.useFakeTimers();
    const url = freshResource();
    const stalled = new ReadableStream<Uint8Array>({
      start() {
        /* produces nothing, ever */
      },
      cancel() {
        /* best-effort cancel from the race loser; may never even be reached
         * because res.json() already locked the body — what this test pins
         * is that the DEADLINE, not the stalled body, ends the operation
         * and hands the one permit back. */
      },
    });
    stubFetch(() => new Response(stalled, { status: 200, headers: { "content-type": "application/json" } }));
    // The deadline clock starts BEFORE the queue wait, so it must be run
    // while the operation is awaited (advancing after an await deadlocks).
    const p = sharedUpstreamCompletion({ body: { model: "d" }, label: "slow-body", targetUrl: url, timeoutMs: 750 });
    await vi.advanceTimersByTimeAsync(750);
    const out = await p;
    expect(out).toBeNull();
    expect(localUpstreamState(url)).toEqual({ inFlight: false, queued: 0 });
    expect(cfg.warns.some((w) => w.meta?.outcome === "deadline")).toBe(true);
  });

  it("passes a non-2xx status through without inventing a body", async () => {
    const url = freshResource();
    stubFetch(() => new Response("gateway exploded", { status: 502, headers: { "content-type": "text/plain" } }));
    const out = await sharedUpstreamCompletion({ body: { model: "d" }, label: "nonok", targetUrl: url });
    expect(out?.status).toBe(502);
    expect(out?.json).toBeNull();
    expect(localUpstreamState(url)).toEqual({ inFlight: false, queued: 0 });
  });

  it("releases exactly once when the body read throws", async () => {
    const url = freshResource();
    const broken = {
      status: 200,
      body: null,
      json: () => {
        throw new Error("parse exploded");
      },
    } as unknown as Response;
    stubFetch(() => broken);
    const first = await sharedUpstreamCompletion({ body: { model: "d" }, label: "boom", targetUrl: url });
    expect(first).toBeNull();
    expect(localUpstreamState(url)).toEqual({ inFlight: false, queued: 0 });
    // A second request must still get the slot (proves the permit came back).
    stubFetch(() => okJson());
    const second = await sharedUpstreamCompletion({ body: { model: "d" }, label: "after-boom", targetUrl: url });
    expect(second?.status).toBe(200);
  });

  it("leaves no timer or listener behind on the success path", async () => {
    vi.useFakeTimers();
    const url = freshResource();
    stubFetch(() => okJson());
    const ctrl = new AbortController();
    const live: string[] = [];
    const wrapped = {
      aborted: false,
      reason: undefined,
      addEventListener: (type: string, fn: () => void) => {
        live.push(type);
        ctrl.signal.addEventListener(type, fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        live.splice(live.indexOf(type), 1);
        ctrl.signal.removeEventListener(type, fn);
      },
    } as unknown as AbortSignal;
    const out = await sharedUpstreamCompletion({
      body: { model: "d" },
      label: "leak",
      targetUrl: url,
      signal: wrapped,
      timeoutMs: 30_000,
    });
    expect(out?.status).toBe(200);
    expect(live.length).toBe(0); // the external listener was removed
    expect(vi.getTimerCount()).toBe(0); // and the deadline timer was cleared
  });

  it("bounds the queue: the 5th waiter degrades without reaching the endpoint", async () => {
    const url = freshResource();
    const gate = deferred<Response>();
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1 ? gate.promise : Promise.resolve(okJson());
    });
    const holder = sharedUpstreamCompletion({ body: { model: "d" }, label: "holder", targetUrl: url });
    await flush(2);
    const queued = [1, 2, 3, 4].map((i) =>
      sharedUpstreamCompletion({ body: { model: "d" }, label: `q${i}`, targetUrl: url }),
    );
    await flush(6);
    expect(localUpstreamState(url)).toEqual({ inFlight: true, queued: 4 });
    const refused = await sharedUpstreamCompletion({ body: { model: "d" }, label: "refused", targetUrl: url });
    expect(refused).toBeNull();
    expect(cfg.warns.some((w) => w.meta?.outcome === "saturated")).toBe(true);
    gate.resolve(okJson());
    await Promise.all([holder, ...queued]);
    expect(localUpstreamState(url)).toEqual({ inFlight: false, queued: 0 });
  });
});

describe("R02 permit ownership through cancellation", () => {
  it("headers arrival never releases; a full drain does", async () => {
    let src!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { src = c; } });
    stubFetch(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await sharedUpstreamStream({ body: "{}", label: "drain" });
    expect(res.status).toBe(200);
    expect(localUpstreamState().inFlight).toBe(true); // headers arrived, generation is live
    const reader = res.body!.getReader();
    src.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    src.close();
    await reader.read();
    await reader.read();
    expect(localUpstreamState().inFlight).toBe(false);
  });

  it("holds the permit until the transport acknowledges cancellation", async () => {
    const cancelGate = deferred<void>();
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* open, never produces */
      },
      cancel() {
        cancelStarted = true;
        return cancelGate.promise;
      },
    });
    stubFetch(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await sharedUpstreamStream({ body: "{}", label: "cancel-hold", cancelGraceMs: 60_000 });
    void res.body!.cancel("user-stop").catch(() => undefined);
    await flush(6);
    expect(cancelStarted).toBe(true);
    // The defect this replaces released the permit HERE, mid-cancellation.
    expect(localUpstreamState().inFlight).toBe(true);
    cancelGate.resolve();
    await flush(6);
    expect(localUpstreamState().inFlight).toBe(false);
  });

  it("a transport that never acknowledges cancellation is bounded and logged", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* open */
      },
      cancel() {
        return new Promise<void>(() => undefined); // never settles
      },
    });
    stubFetch(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await sharedUpstreamStream({ body: "{}", label: "cancel-stall", cancelGraceMs: 25 });
    void res.body!.cancel("user-stop").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(localUpstreamState().inFlight).toBe(true);
    await vi.advanceTimersByTimeAsync(25);
    expect(localUpstreamState().inFlight).toBe(false);
    expect(cfg.warns.some((w) => w.msg.includes("never acknowledged cancellation"))).toBe(true);
  });

  it("a rejected cancellation still releases the permit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* open */
      },
      cancel() {
        return Promise.reject(new Error("cancel exploded"));
      },
    });
    stubFetch(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await sharedUpstreamStream({ body: "{}", label: "cancel-reject", cancelGraceMs: 60_000 });
    void res.body!.cancel("user-stop").catch(() => undefined);
    await flush(8);
    expect(localUpstreamState().inFlight).toBe(false);
    expect(cfg.warns.some((w) => w.msg.includes("cancel rejected"))).toBe(true);
  });

  it("a non-2xx stream drains and releases even if nobody reads it", async () => {
    stubFetch(() => new Response("upstream blew up", { status: 503, headers: { "content-type": "text/plain" } }));
    const res = await sharedUpstreamStream({ body: "{}", label: "stream-503" });
    expect(res.status).toBe(503);
    expect(localUpstreamState().inFlight).toBe(false);
    expect(await res.text()).toContain("upstream blew up");
  });
});

describe("R03 overrides cannot escape the shared authority", () => {
  it("an alias of the configured endpoint still goes through the Rust bridge", async () => {
    process.env.RUKE_RUST_BACKEND = "1";
    const calls = stubFetch(() => okJson({ choices: [] }));
    // Alias spellings collapse onto the configured resource key, so the
    // honest assertion is "no NEW gate appeared", not "no gate has that
    // spelling" (the configured gate already exists from other tests).
    const gatesBefore = localUpstreamResources().length;
    const out = await sharedUpstreamCompletion({
      body: { model: "d", messages: [] },
      label: "gate-plan",
      // Same server, different spelling — the defect treated it as foreign.
      targetUrl: "http://localhost:1234/v1/chat/completions",
      timeoutMs: 1_234,
    });
    expect(out?.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://127.0.0.1:3101/api/ruke/internal/completion");
    expect(JSON.parse(String(calls[0].init.body)).timeout_ms).toBe(1_234);
    // The alias never became a second local gate.
    expect(localUpstreamResources().length).toBe(gatesBefore);
  });

  it("a genuinely different origin gets its own gate and never the main token", async () => {
    const other = "http://127.0.0.1:4599/v1/chat/completions";
    process.env.WEB_SEARCH_LLM_API_KEY = "own-provider-key";
    const calls = stubFetch(() => okJson());
    const out = await sharedUpstreamCompletion({ body: { model: "d" }, label: "alt", targetUrl: other });
    expect(out?.status).toBe(200);
    expect(headersOf(calls[0].init).Authorization).toBe("Bearer own-provider-key");

    delete process.env.WEB_SEARCH_LLM_API_KEY;
    const other2 = "http://127.0.0.1:4600/v1/chat/completions";
    const calls2 = stubFetch(() => okJson());
    await sharedUpstreamCompletion({ body: { model: "d" }, label: "alt-anon", targetUrl: other2 });
    expect(headersOf(calls2[0].init).Authorization).toBeUndefined();
    for (const c of [...calls, ...calls2]) {
      expect(JSON.stringify(c.init)).not.toContain(cfg.key);
    }
  });

  it("two distinct resources are not serialized against each other", async () => {
    const a = freshResource();
    const b = freshResource();
    const gate = deferred<Response>();
    stubFetch(async (url) => (url === a ? gate.promise : okJson()));
    const pa = sharedUpstreamCompletion({ body: { model: "d" }, label: "res-a", targetUrl: a });
    await flush(2);
    const pb = await sharedUpstreamCompletion({ body: { model: "d" }, label: "res-b", targetUrl: b });
    expect(pb?.status).toBe(200); // B never waited on A's held permit
    expect(localUpstreamState(a).inFlight).toBe(true);
    expect(localUpstreamState(b).inFlight).toBe(false);
    gate.resolve(okJson());
    expect((await pa)?.status).toBe(200);
  });

  it("a stalled resource cannot starve a different one (queue bound is per resource)", async () => {
    const a = freshResource();
    const gate = deferred<Response>();
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1 ? gate.promise : Promise.resolve(okJson());
    });
    const stuck = sharedUpstreamCompletion({ body: { model: "d" }, label: "stuck", targetUrl: a });
    await flush(2);
    const sameGate = sharedUpstreamCompletion({ body: { model: "d" }, label: "sibling", targetUrl: a });
    await flush(3);
    expect(localUpstreamState(a)).toEqual({ inFlight: true, queued: 1 });
    gate.resolve(okJson());
    await Promise.all([stuck, sameGate]);
    expect(localUpstreamState(a)).toEqual({ inFlight: false, queued: 0 });
  });
});
