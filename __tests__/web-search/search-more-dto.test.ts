/**
 * Brief §12 — /api/search-more DTO caps are ENFORCED, not just documented.
 *
 * The route header always documented "max 3 new queries, ≤ 100 chars
 * each" but the code filtered to strings and sliced to 3 while letting
 * unbounded strings (and junk types) through into the pipeline. Vectors
 * pin: length cap, count cap, trim, non-string rejection, and the
 * existing 400 shape when nothing usable remains.
 *
 * Hermetic: the pipeline module is spied wholesale — zero engine/reader
 * traffic regardless of harness behavior.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const { runWebResearchSpy } = vi.hoisted(() => ({ runWebResearchSpy: vi.fn() }));

vi.mock("@/lib/web-search/pipeline", () => ({
  runWebResearch: runWebResearchSpy,
  evidenceBlock: () => "[evidence]",
}));

let POST: (req: NextRequest) => Promise<Response>;
beforeAll(async () => {
  POST = (await import("@/app/api/search-more/route")).POST;
});

beforeEach(() => {
  runWebResearchSpy.mockReset();
});

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost:3000/api/search-more", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("/api/search-more DTO caps (brief §12)", () => {
  it("caps the array at 3 and every string at 100 chars", async () => {
    runWebResearchSpy.mockResolvedValueOnce(null);
    const long = "x".repeat(500);
    const res = await POST(
      makeRequest({ queries: [long, "q1", "  q2  ", "q3", "q4", 42, null, {}] }),
    );
    expect(res.status).toBe(200);
    const ctx = runWebResearchSpy.mock.calls.at(-1)![0] as { userPrompt: string };
    const tokens = ctx.userPrompt.split(" ");
    expect(tokens.length).toBeLessThanOrEqual(3);
    for (const t of tokens) expect(t.length).toBeLessThanOrEqual(100);
    // The long query survives TRUNCATED (not dropped) and keeps its slot;
    // "  q2  " survives trimmed; q3/q4 fell off the count cap.
    expect(ctx.userPrompt.startsWith("x".repeat(100))).toBe(true);
    expect(ctx.userPrompt).toContain("q1");
    expect(ctx.userPrompt).toContain("q2");
    expect(ctx.userPrompt).not.toContain("q3");
    expect(ctx.userPrompt).not.toContain("q4");
  });

  it("non-string and whitespace-only entries never reach the pipeline", async () => {
    runWebResearchSpy.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ queries: ["   ", "", 7, {}, []] }));
    expect(res.status).toBe(400); // nothing usable survived the caps
    expect(res.body).toBeTruthy();
  });

  it("a non-array queries value still degrades to the documented 400", async () => {
    const res = await POST(makeRequest({ queries: "just one big string" }));
    expect(res.status).toBe(400);
    expect(runWebResearchSpy).not.toHaveBeenCalled();
  });
});
