/**
 * Brief §10 — web-research bridge cancellation vectors.
 *
 * Pins the three-part cancellation contract of
 * app/api/internal/web-research/route.ts:
 *   1. a request whose signal was ALREADY aborted when the handler starts
 *      must never spin up a research run — addEventListener never replays
 *      an abort that already fired, so the initial-state mirror plus the
 *      start() guard are the only things stopping it. Result: zero
 *      pipeline calls, zero frames on the wire;
 *   2. a LIVE signal starts exactly one research run and gets exactly one
 *      terminal frame (the control that keeps vector 1 honest — an empty
 *      stream must mean "cancelled", never "broken harness");
 *   3. the CONSUMER cancelling the response body aborts the signal handed
 *      to runWebResearch (the stream cancel() hook).
 *
 * Hermetic: the pipeline module is spied wholesale, so no engine/reader/
 * browser/model traffic is possible regardless of harness behavior.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NextRequest } from "next/server";

const { runWebResearchSpy } = vi.hoisted(() => ({
  runWebResearchSpy: vi.fn(),
}));

vi.mock("@/lib/web-search/pipeline", () => ({
  runWebResearch: runWebResearchSpy,
  buildMainModelContext: () => ({ systemBlock: "" }),
}));

const SECRET = "abort-test-bridge-secret";

let POST: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  process.env.RUKE_BROWSER_BRIDGE_SECRET = SECRET;
  POST = (await import("@/app/api/internal/web-research/route")).POST;
});

afterAll(() => {
  delete process.env.RUKE_BROWSER_BRIDGE_SECRET;
});

function makeRequest(signal: AbortSignal): NextRequest {
  const req = new Request("http://localhost:3000/api/internal/web-research", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ruke-internal-secret": SECRET,
    },
    body: JSON.stringify({ prompt: "what is the latest stable release of node" }),
    // Pre-aborted signals still deliver a static body (verified against
    // undici) — this mirrors the real case: Rust hung up, the HTTP layer
    // already buffered the body, and only the signal carries the abort.
    signal,
  });
  // The route reads only standard Request members; NextRequest is a type.
  return req as unknown as NextRequest;
}

async function frames(res: Response): Promise<any[]> {
  const text = new TextDecoder().decode(await res.arrayBuffer());
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("web-research bridge cancellation (brief §10)", () => {
  it("an already-aborted request never starts research and sends zero frames", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await POST(makeRequest(ac.signal));
    expect(res.status).toBe(200);
    expect(await frames(res)).toEqual([]);
    expect(runWebResearchSpy).not.toHaveBeenCalled();
  });

  it("a live request starts exactly one research run and gets one terminal frame", async () => {
    runWebResearchSpy.mockImplementationOnce(async () => null);
    const ac = new AbortController();
    const res = await POST(makeRequest(ac.signal));
    expect(await frames(res)).toEqual([{ type: "result", status: "no_bundle" }]);
    expect(runWebResearchSpy).toHaveBeenCalledTimes(1);
  });

  it("the consumer cancelling the response body aborts the retrieval signal", async () => {
    let handed: AbortSignal | undefined;
    runWebResearchSpy.mockImplementationOnce(async (_ctx, onProgress, signal) => {
      handed = signal as AbortSignal;
      onProgress({ stage: "planning" });
      await new Promise((r) => setTimeout(r, 30));
      return null;
    });
    const res = await POST(makeRequest(new AbortController().signal));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(first.value)).stage).toBe("planning");
    await reader.cancel(); // the Rust transport vanished mid-stream
    await new Promise((r) => setTimeout(r, 50));
    expect(handed?.aborted).toBe(true);
  });
});
