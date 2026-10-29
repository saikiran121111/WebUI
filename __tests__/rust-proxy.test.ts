/**
 * Part-8 proxy failure-CLASSIFICATION regression suite (MIGRATION-MAP §7).
 *
 * The bug (manual regression 2026-10-27): a browser that abandons a title
 * request makes Next abort `req.signal` with a DOMException whose name is
 * `ResponseAborted`; that same signal is forwarded to the upstream fetch, and
 * per the fetch spec undici rejects the in-flight fetch with the signal's
 * ABORT REASON — so the proxy's single catch stamped it
 * "unreachable" + 502 while the Rust title queue had already accepted the
 * job and completed it. The proxy must distinguish THREE classes:
 *   A. downstream cancellation  → no "unreachable" log, no 502 shape,
 *      Rust-side semantics keep running;
 *   B. genuine connectivity     → unchanged Part-8 honest 502
 *      `{"error":"Rust backend unreachable at <base>"}` + code-tagged log;
 *   C. a genuine Rust response  → pass through untouched (500 stays 500).
 *
 * Real HTTP on loopback (no mocks of fetch); the mock "Rust" mirrors the real
 * routes: the title handler accepts the request, then holds the response
 * while the queue works. Dead-backend arm uses loopback port 3 (free, and
 * outside undici's WHATWG bad-port blocklist — see Test 1's comment for why
 * the Rust-side `127.0.0.1:9` convention cannot cross to the undici side).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rustProxy } from "@/lib/server/rustProxy";

let server: http.Server;
let port = 0;

// Per-test witnesses the mock server records.
interface Witness {
  arrived: Promise<void>; // full request (headers+body) received
  closed: Promise<void>; // downstream connection torn down
  resolveArrived: () => void;
  resolveClosed: () => void;
}
let wit: Witness;
function freshWitness(): Witness {
  let resolveArrived: () => void = () => {};
  let resolveClosed: () => void = () => {};
  const arrived = new Promise<void>((r) => { resolveArrived = r; });
  const closed = new Promise<void>((r) => { resolveClosed = r; });
  return { arrived, closed, resolveArrived, resolveClosed };
}

function startMockRust(): Promise<void> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      if (path === "/api/ruke/conversations/abc/title") {
        // Real Rust title route shape: the queue job is accepted the moment
        // the request arrives; the HTTP response only lands AFTER generation.
        wit.resolveArrived();
        // hold until the client goes away
      } else if (path === "/api/ruke/conversations/norm/title") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ queued: true, ok: true, title: "Fresh title" }));
        wit.resolveArrived();
      } else if (path === "/api/ruke/boom") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        wit.resolveArrived();
      } else if (path === "/api/ruke/slowbody") {
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        res.write('{"a":'); // body begins, never completes
        wit.resolveArrived();
      } else if (path === "/api/chat") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write("data: a\n\n");
        wit.resolveArrived(); // stream stays open until client cancels
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        wit.resolveArrived();
      }
    });
    res.on("close", () => wit.resolveClosed());
    void chunks;
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    port = (server.address() as AddressInfo).port;
    r();
  }));
}

let errLogs: string[];
let warnLogs: string[];
let debugLogs: string[];

function unreachableErrorLogs(): string[] {
  return errLogs.filter((m) => m.includes("unreachable"));
}

const nextUrl = (p: string) => `http://next.local${p}`;

function incoming(p: string, init: RequestInit = {}): Request {
  return new Request(nextUrl(p), {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body,
    signal: init.signal,
  });
}

function responseAborted(): DOMException {
  // The reason Node 26 / Next's web layer uses when a downstream response is
  // abandoned (reproduced for this Node in Phase-1 recon).
  return new DOMException("Response body aborted", "ResponseAborted");
}

beforeAll(async () => {
  await startMockRust();
});

beforeEach(() => {
  process.env.RUKE_BACKEND_PORT = String(port);
  errLogs = [];
  warnLogs = [];
  debugLogs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errLogs.push(String(a[0])); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warnLogs.push(String(a[0])); });
  vi.spyOn(console, "debug").mockImplementation((...a: unknown[]) => { debugLogs.push(String(a[0])); });
  wit = freshWitness();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RUKE_BACKEND_PORT;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("rustProxy failure classification", () => {
  it("Test 1 — genuine unreachable Rust keeps the honest 502 + code-tagged log", async () => {
    // Port 3: free on loopback, NOT on the WHATWG fetch bad-port blocklist
    // (undici REJECTS e.g. port 9 at parse time with a code-less "bad port"
    // TypeError — the Part-8 `127.0.0.1:9` dead-upstream convention only
    // works on the reqwest/Rust side). Nothing on Windows listens on :3 ⇒
    // deterministic ECONNREFUSED, the same arm as a killed ruke-server.
    process.env.RUKE_BACKEND_PORT = "3";
    const res = await rustProxy(incoming("/api/ruke/settings"), "/api/ruke/settings");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Rust backend unreachable at http://127.0.0.1:3",
    });
    const tagged = errLogs.filter((m) => m.includes("unreachable"));
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged[0]).toMatch(/unreachable \[ECONNREFUSED\]/);
    expect(debugLogs).toEqual([]);
  });

  it("Test 2 — a request aborted before the proxy call is NOT backend-unreachable", async () => {
    const ac = new AbortController();
    ac.abort();
    const req = incoming("/api/conversations/abc/title", {
      method: "POST",
      body: JSON.stringify({ model: "m" }),
      signal: ac.signal,
    });
    const res = await rustProxy(req, "/api/ruke/conversations/abc/title");
    expect(unreachableErrorLogs()).toEqual([]);
    expect(errLogs).toEqual([]);
    expect(res.status).not.toBe(502);
    // Rust was never reached (the signal was dead before the fetch) — same as
    // pre-fix behavior; only the classification/logging changed.
    const arrivedFirst = await Promise.race([
      wit.arrived.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 150)),
    ]);
    expect(arrivedFirst).toBe(false);
  });

  it("Test 3 — downstream aborts while Rust holds the title job open ⇒ cancellation, not unreachable", async () => {
    const ac = new AbortController();
    const req = incoming("/api/conversations/abc/title", {
      method: "POST",
      body: JSON.stringify({ model: "m" }),
      signal: ac.signal,
    });
    const proxying = rustProxy(req, "/api/ruke/conversations/abc/title");
    await wit.arrived; // Rust received the request and accepted the job
    ac.abort(responseAborted()); // browser navigated away mid-generation
    const res = await proxying;
    expect(unreachableErrorLogs()).toEqual([]);
    expect(errLogs).toEqual([]);
    expect(res.status).not.toBe(502);
    expect(debugLogs.some((m) => m.includes("cancelled by downstream client"))).toBe(true);
    await wit.closed; // the mock Rust saw the upstream connection tear down
  });

  it("Test 4 — a genuine Rust 500 passes through untouched, never relabeled", async () => {
    const res = await rustProxy(incoming("/api/ruke/boom"), "/api/ruke/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
    expect(unreachableErrorLogs()).toEqual([]);
    expect(debugLogs).toEqual([]);
  });

  it("Test 5 — normal proxied title answers 200 with no proxy error at all", async () => {
    const res = await rustProxy(
      incoming("/api/conversations/norm/title", { method: "POST", body: "{}" }),
      "/api/ruke/conversations/norm/title",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, ok: true, title: "Fresh title" });
    expect(errLogs).toEqual([]);
    expect(warnLogs).toEqual([]);
  });

  it("Test 6 — client aborts DURING Rust's response body ⇒ no unreachable, no false 502", async () => {
    const ac = new AbortController();
    const req = incoming("/api/conversations/abc/slowtitle", {
      method: "POST",
      body: "{}",
      signal: ac.signal,
    });
    const res = await rustProxy(req, "/api/ruke/slowbody");
    expect(res.status).toBe(200); // headers had already arrived — no 502 fabrication
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    ac.abort(responseAborted()); // navigation mid-body
    let caught: unknown = null;
    try {
      await reader.read();
    } catch (e) {
      caught = e;
    }
    // Body-leg abort: the stream errors (or ends) — either way the proxy must
    // not stamp anything "unreachable" (its catch never sees this leg).
    if (caught !== null) {
      expect(["AbortError", "ResponseAborted"].includes((caught as Error).name)).toBe(true);
    }
    expect(unreachableErrorLogs()).toEqual([]);
    await wit.closed;
  });

  it("Test 7 — streaming chat cancelled by the client propagates without any proxy error", async () => {
    const ac = new AbortController();
    const req = incoming("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      signal: ac.signal,
    });
    const proxying = rustProxy(req, "/api/chat");
    await wit.arrived;
    const res = await proxying;
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: a");
    ac.abort(); // "stop generation"
    // Propagation witness: the mock upstream sees the connection die — the
    // same disconnect signal that makes real Rust cancel the Strata turn.
    await wit.closed;
    expect(unreachableErrorLogs()).toEqual([]);
    try {
      await reader.read();
    } catch {
      /* abort-family error is expected here */
    }
  });
});
