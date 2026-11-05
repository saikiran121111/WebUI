/**
 * AUDIT 2026-11-05 (brief item 16 / WS16) — cancellation must propagate
 * through every transport, not just settle the pipeline wait.
 *
 * Fix wording (verbatim): "Fix cancellation propagation and settlement
 * through direct reads, provider calls, render acquisition and queued
 * work. Do not leave abandoned work occupying inference/browser/network
 * capacity."
 *
 * Same live-server harness shape as net-pinned-redirect-cookies.test.ts:
 * the ACTUAL installed clients (got 14.6.6, impit-win32-x64-msvc) talk to
 * a REAL local server that answers SLOWLY, so a transport that ignores an
 * abort is observable as a late body + slow return, while a transport that
 * honors it settles promptly with no body. SSRF mocked to pass (loopback;
 * ssrf.ts has its own suite).
 *
 * Pins (universal transport law — no site/brand rules):
 *  - fetchPage (Pass A got): a mid-flight abort returns null promptly —
 *    no late body lands (got's native signal cancels the stream);
 *  - fetchPage pinned fingerprint (Pass B impit walker): the abort settles
 *    the hop race promptly and no later hop starts;
 *  - fetchUrl (JSON-endpoint transport): same;
 *  - an already-aborted signal short-circuits BEFORE any server hit;
 *  - control: un-aborted slow reads still succeed (the abort wiring must
 *    not break normal reads).
 * Honest limitation: impit's native binding exposes no per-request cancel
 * — the walker races each hop against the abort, so the JS side settles
 * promptly while the in-flight Rust request completes briefly in the
 * background bounded by its own timeout (bounded capacity leak, zero
 * late state; documented at the impitFollow site).
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/web-search/ssrf", () => ({
  isSafeUrl: () => true,
  isSafeUrlWithDns: async () => true,
  firstUnsafeRedirectHop: () => null,
}));

import { fetchPage, fetchUrl } from "../../lib/web-search/net";

const SLOW_MS = 2_500;
/** paths the server actually received a request for */
const requested: Record<string, number> = {};

let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    requested[path] = (requested[path] ?? 0) + 1;
    if (path === "/slow" || path === "/slowu" || path === "/slowpin" || path === "/slowok") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("slowbody");
      }, SLOW_MS);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

/** Run fn, abort the controller after abortAfterMs, report result + wall
 *  time. A transport honoring the abort returns in ~abortAfterMs; one
 *  ignoring it returns only when the slow server answers (≥ SLOW_MS). */
async function timedWithAbort<T>(fn: (sig: AbortSignal) => Promise<T>, abortAfterMs: number) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), abortAfterMs);
  const t0 = Date.now();
  const res = await fn(ac.signal);
  clearTimeout(timer);
  return { res, elapsed: Date.now() - t0 };
}

describe("WS16 — cancellation propagates through every transport", () => {
  it("fetchPage (got path): mid-flight abort returns null promptly, no late body", async () => {
    const { res, elapsed } = await timedWithAbort(
      (sig) => fetchPage(`${base}/slow`, { timeoutMs: 20_000, signal: sig }),
      250,
    );
    // THE DEFECT: the transports ignore the signal entirely — the read
    // runs to completion (200 slowbody) and only then returns.
    expect(res, "a cancelled read must not deliver a late body").toBeNull();
    expect(
      elapsed,
      "the abort must settle the read well before the slow server answers (no abandoned read holding network capacity to completion)",
    ).toBeLessThan(2_000);
  }, 25_000);

  it("fetchPage pinned fingerprint (impit walker): abort settles the pending hop promptly", async () => {
    const { res, elapsed } = await timedWithAbort(
      (sig) => fetchPage(`${base}/slowpin`, { fingerprint: "chrome", timeoutMs: 20_000, signal: sig }),
      250,
    );
    expect(res, "the pinned native path must settle on abort, not complete the hop").toBeNull();
    expect(elapsed).toBeLessThan(2_000);
    // No second hop/work started after the abort.
    expect(requested["/slowpin"], "exactly one hop in flight when cancelled — nothing re-dispatched after abort").toBe(1);
  }, 25_000);

  it("fetchUrl (JSON-endpoint transport): mid-flight abort returns null promptly", async () => {
    const { res, elapsed } = await timedWithAbort(
      (sig) => fetchUrl(`${base}/slowu`, { timeoutMs: 20_000, signal: sig }),
      250,
    );
    expect(res).toBeNull();
    expect(elapsed).toBeLessThan(2_000);
  }, 25_000);

  it("already-aborted signal short-circuits before any server hit", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const page = await fetchPage(`${base}/preA`, { timeoutMs: 20_000, signal: ac.signal });
    const json = await fetchUrl(`${base}/preB`, { timeoutMs: 20_000, signal: ac.signal });
    const elapsed = Date.now() - t0;
    expect(page).toBeNull();
    expect(json).toBeNull();
    expect(requested["/preA"], "cancelled work must never touch the network").toBeUndefined();
    expect(requested["/preB"]).toBeUndefined();
    expect(elapsed).toBeLessThan(1_000);
  }, 10_000);

  it("control: un-aborted slow reads still succeed (abort wiring must not break normal reads)", async () => {
    const res = await fetchPage(`${base}/slowok`, { timeoutMs: 10_000 });
    expect(res, "the slow server DOES answer — a null here would make every abort pin above vacuous").not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.body).toContain("slowbody");
  }, 25_000);
});
