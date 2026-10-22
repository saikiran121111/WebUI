import { describe, it, expect } from "vitest";
import {
  computeBaselines,
  TurnProgressTracker,
  type ProgressBaselines,
} from "../lib/progress/turnProgress";
import type { Message, StageEvent } from "../lib/types";

/**
 * Honesty contract for the progress engine: percentages come from real
 * counts (query pools, pages read) and real ETAs (measured medians), the
 * sequence is monotonic, and nothing claims 100% unless the turn finished.
 */

const NO_BASELINES: ProgressBaselines = { reasoningMs: null, completionTokens: null };

const stage = (e: StageEvent) => e;

describe("computeBaselines", () => {
  const msg = (m: Partial<Message>): Message =>
    ({ role: "assistant", state: "complete", ...m } as Message);

  it("takes medians over completed assistant turns only", () => {
    const b = computeBaselines([
      msg({ reasoningMs: 1000, usage: { completionTokens: 100 } }),
      msg({ reasoningMs: 3000, usage: { completionTokens: 300 } }),
      msg({ reasoningMs: 2000, usage: { completionTokens: 200 } }),
      msg({ role: "user", reasoningMs: 99999 }),
      msg({ state: "streaming", reasoningMs: 88888 }),
    ]);
    expect(b.reasoningMs).toBe(2000);
    expect(b.completionTokens).toBe(200);
  });

  it("returns nulls with no history", () => {
    expect(computeBaselines([])).toEqual({ reasoningMs: null, completionTokens: null });
  });
});

describe("TurnProgressTracker — phases", () => {
  it("starts with an honest routing step, never below 5%", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    const s = t.snapshot(Date.now());
    expect(s.steps).toEqual([{ id: "routing", label: "Analyzing your request", status: "active", percent: 10 }]);
    expect(s.chipLabel).toBe("Step 1 of 1");
    expect(s.state).toBe("running");
  });

  it("decision_done carries the real mode and advances routing", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "decision_done", mode: "ppt", ms: 900 }));
    const s = t.snapshot(Date.now());
    expect(s.steps[0].percent).toBe(60);
  });

  it("skipped web gate removes the step instead of faking it", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "web:lfm" }));
    t.noteStage(stage({ stage: "web:skipped" }));
    const s = t.snapshot(Date.now());
    expect(s.steps.find(st => st.id === "websearch")).toBeUndefined();
    expect(s.chipLabel).toBe("Step 1 of 1");
  });

  it("web bands use real counters: query pools and page x/y subdivide reading", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "web:searching", total: 2 }));
    expect(t.snapshot(Date.now()).steps.find(s => s.id === "websearch")!.label)
      .toBe("Searching the web — 2 query pool(s)");

    t.noteStage(stage({ stage: "web:reading", total: 10 }));
    t.noteStage(stage({ stage: "web:reading", done: 5, total: 10 }));
    const ws = t.snapshot(Date.now()).steps.find(s => s.id === "websearch")!;
    expect(ws.label).toBe("Reading web sources — page 5 of 10");
    expect(ws.percent).toBe(86); // 80 + (5/10)*12

    t.noteStage(stage({ stage: "web:reranking" }));
    expect(t.snapshot(Date.now()).steps.find(s => s.id === "websearch")!.percent).toBe(92);

    t.noteStage(stage({ stage: "web:done", total: 12 }));
    const doneStep = t.snapshot(Date.now()).steps.find(s => s.id === "websearch")!;
    expect(doneStep.status).toBe("done");
    expect(doneStep.percent).toBe(100);
  });

  it("percents never walk backwards", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "web:reranking" })); // 92
    t.noteStage(stage({ stage: "web:searching", total: 3 })); // band 55 — must not lower
    const s = t.snapshot(Date.now());
    const ws = s.steps.find(st => st.id === "websearch")!;
    expect(ws.percent).toBeGreaterThanOrEqual(92);
  });

  it("gap-search reports the real coverage number in its label", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "web:gap-search", coverage: 0.62 }));
    expect(t.snapshot(Date.now()).steps.find(s => s.id === "websearch")!.label)
      .toBe("Searching for missing details (62% covered)");
  });
});

describe("TurnProgressTracker — measured thinking/writing ETAs", () => {
  it("thinking % is elapsed ÷ the user's median prior reasoningMs", () => {
    const t = new TurnProgressTracker({ reasoningMs: 18_000, completionTokens: null });
    t.noteReasoningStart();
    const start = t.startedAt; // same tick as internal Date.now()
    const s = t.snapshot(start + 9_000);
    const th = s.steps.find(x => x.id === "thinking")!;
    expect(th.percent).toBe(50);
    expect(th.status).toBe("active");
  });

  it("writing % is streamed chars ÷ median prior completion tokens (×4)", () => {
    const t = new TurnProgressTracker({ reasoningMs: null, completionTokens: 500 });
    t.noteContent(1_000); // etaChars = 2000
    const w = t.snapshot(Date.now()).steps.find(x => x.id === "writing")!;
    expect(w.percent).toBe(50);
  });

  it("writing label follows the decision mode", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "decision_done", mode: "excel" }));
    t.noteContent(10);
    expect(t.snapshot(Date.now()).steps.find(s => s.id === "writing")!.label)
      .toBe("Building your spreadsheet (XLSX)…");
  });

  it("first content snaps thinking and routing to done", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteReasoningStart();
    t.noteContent(5);
    const s = t.snapshot(Date.now());
    expect(s.steps.find(x => x.id === "thinking")!.status).toBe("done");
    expect(s.steps.find(x => x.id === "routing")!.status).toBe("done");
  });

  it("a fence opening yields exactly one real output artifact", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "decision_done", mode: "pdf" }));
    t.openOutput();
    t.openOutput();
    const s = t.snapshot(Date.now());
    expect(s.outputs).toEqual([{ label: "PDF Document", kind: "PDF" }]);
  });

  it("standard chat produces no outputs", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "decision_done", mode: "standard_chat" }));
    t.openOutput();
    expect(t.snapshot(Date.now()).outputs).toEqual([]);
  });
});

describe("TurnProgressTracker — repair, finish, overall", () => {
  it("repair step carries the real round count", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.setRepair(2, 3);
    const r = t.snapshot(Date.now()).steps.find(s => s.id === "repair")!;
    expect(r.label).toBe("Auto-repairing the 3D/CAD model (round 2 of 3)");
    expect(r.status).toBe("active");
  });

  it("complete finish: everything 100, chip 'Done'", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteContent(10);
    t.finish("complete");
    const s = t.snapshot(Date.now());
    expect(s.overall).toBe(100);
    expect(s.chipLabel).toBe("Done");
    for (const st of s.steps) expect(st.percent).toBe(100);
  });

  it("error finish never claims 100%", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.finish("error");
    const s = t.snapshot(Date.now());
    expect(s.chipLabel).toBe("Failed");
    expect(s.overall).toBeLessThan(100);
    expect(s.overall).toBeGreaterThan(0);
  });

  it("overall weights the heavy phases honestly (web 3 / writing 3.5 / thinking 1.5)", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "web:reranking" })); // websearch 92 active… then:
    // routing done(1) + websearch still active: weighted mean, not a plain average.
    const s = t.snapshot(Date.now());
    const done = s.steps.find(x => x.id === "routing")!;
    const ws = s.steps.find(x => x.id === "websearch")!;
    expect(done.status).toBe("done");
    // (100*1 + 92*3) / 4 = 194 → clamp 99 while running
    expect(s.overall).toBe(Math.min(99, Math.round((100 * 1 + ws.percent * 3) / 4)));
  });

  it("overall never walks backwards when a new phase is discovered", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "decision_done", mode: "ppt", ms: 400 }));
    expect(t.snapshot(Date.now()).overall).toBe(60); // routing alone
    // Web search opens at band 10 with weight 3: raw weighted mean would DIP
    // to 33 — the bar must hold its floor, not rewind.
    t.noteStage(stage({ stage: "web:lfm" }));
    expect(t.snapshot(Date.now()).overall).toBe(60);
    t.noteStage(stage({ stage: "web:reranking" })); // (100 + 92*3)/4 = 94 > floor
    expect(t.snapshot(Date.now()).overall).toBe(94);
  });

  it("chip label tracks the active step position", () => {
    const t = new TurnProgressTracker(NO_BASELINES);
    t.noteStage(stage({ stage: "web:lfm" })); // routing done, websearch active
    t.noteContent(10); // websearch + routing done, writing active
    expect(t.snapshot(Date.now()).chipLabel).toBe("Step 3 of 3");
  });
});
