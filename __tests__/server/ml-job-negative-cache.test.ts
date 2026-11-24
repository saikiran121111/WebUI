/**
 * F87 (2026-11-23): the negative-cache law at the mlJob seam.
 *
 * C3 evidence chain: while a 37-minute video job held the supervisor's only
 * heavy slot, documents.parse was refused admission with the typed transient
 * reason "resource_busy" (retryable). ml-job.ts caches cacheable reasons for
 * 60 s keyed by CAPABILITY, so the refusal became a capability-wide blackout:
 * mat-1.mat — which the Python parser decodes perfectly in ~10 ms — got the
 * cached "unavailable" envelope 8 ms after upload and the row answered from
 * the labeled byte-scan fallback ("only one printable run: yields", fr-M1
 * FAIL). One file's heavy job starved every sibling document row for a
 * minute, across files and capabilities of the same name.
 *
 * The law this pins: a busy slot is transient CONTENTION, not the
 * backend/rendezvous being broken. Re-admission is a ~20 ms round trip, so
 * resource_busy must never be cached — the next job re-probes and gets the
 * structured parse the moment the slot frees. Backend/rendezvous faults
 * (deadline_exceeded, unreachable, contract_mismatch, not_configured, ...)
 * keep their 60 s backoff, and file-specific typed refusals (unsupported_input,
 * input_rejected) were and stay uncached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mlJob, resetMlJobNegativeCache } from "../../lib/server/ml-job";

const CAP = "documents.parse";

const envelope = (state: string, error?: { reason: string; retryable: boolean }): unknown => ({
  state,
  capability: CAP,
  job_id: "job_1",
  run_id: "run_1",
  request_id: "req_1",
  deadline_s: 60,
  source: "test",
  ...(error ? { error: { ...error, message: `stub: ${error.reason}`, human_step: "" } } : {}),
  ...(state === "ready" ? { result: { kind: "mat", blocks: [], coverage: {} } } : {}),
});

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetMlJobNegativeCache();
  process.env.RUKE_RUST_BACKEND = "1";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RUKE_RUST_BACKEND;
  resetMlJobNegativeCache();
});

describe("F87: capability-level negative cache law", () => {
  it("a resource_busy refusal is NOT cached: the next job re-probes admission", async () => {
    fetchMock
      .mockResolvedValueOnce(response(envelope("failed", { reason: "resource_busy", retryable: true })))
      .mockResolvedValueOnce(response(envelope("ready")));

    const busy = await mlJob(CAP, { path: "old-2.xls" });
    expect(busy?.state).toBe("failed");
    expect(busy?.error?.reason).toBe("resource_busy");

    // Sibling file, slot freed: the structured parse must run, not replay the cached refusal.
    const parsed = await mlJob(CAP, { path: "mat-1.mat" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parsed?.state).toBe("ready");
  });

  it("backend/rendezvous faults keep their 60 s backoff (deadline_exceeded cached)", async () => {
    fetchMock
      .mockResolvedValueOnce(response(envelope("failed", { reason: "deadline_exceeded", retryable: true })))
      .mockResolvedValueOnce(response(envelope("ready")));

    const first = await mlJob(CAP, { path: "vid-2.mp4" });
    expect(first?.state).toBe("failed");

    const second = await mlJob(CAP, { path: "mat-1.mat" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // served from cache: the backoff law stands
    expect(second?.state).toBe("failed");
    expect(second?.error?.reason).toBe("deadline_exceeded");
  });

  it("file-specific typed refusals are never cached (unsupported_input re-probes)", async () => {
    fetchMock
      .mockResolvedValueOnce(response(envelope("failed", { reason: "unsupported_input", retryable: false })))
      .mockResolvedValueOnce(response(envelope("ready")));

    const refused = await mlJob(CAP, { path: "old-1.doc" }); // the deliberately malformed OLE fixture
    expect(refused?.state).toBe("failed");
    expect(refused?.error?.reason).toBe("unsupported_input");

    const parsed = await mlJob(CAP, { path: "mat-1.mat" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parsed?.state).toBe("ready");
  });
});
