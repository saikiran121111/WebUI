/** The ONE motion plan (preview + export parity source) — unit tests. */
import { describe, it, expect } from "vitest";
import { buildMotionPlan, clickRevealCount, stepFor, stepSchedule, OBJ } from "@/lib/documents/pptxMotion";
import type { PptxSpec } from "@/lib/documents/schemas";

const spec = (over: Partial<PptxSpec>): PptxSpec => ({
  title: "T", filename: "f", tier: "normal",
  theme: { bg: "#0A0A0A", accent: "#38E8FF", positive: "#22C55E" },
  slides: [
    { layout: "title", title: "A", subtitle: "", bullets: [], stats: [], table: { headers: [], rows: [] } },
    { layout: "bullets", title: "B", subtitle: "", bullets: ["x", "y"], stats: [], table: { headers: [], rows: [] } },
    { layout: "bullets", title: "C", subtitle: "", bullets: ["z"], stats: [], table: { headers: [], rows: [] } },
  ],
  ...over,
} as PptxSpec);

describe("buildMotionPlan", () => {
  it("simple tier: no transitions, no steps", () => {
    const plan = buildMotionPlan(spec({ tier: "simple" }));
    expect(plan.map((m) => m.transition)).toEqual(["none", "none", "none"]);
    expect(plan.every((m) => m.steps.length === 0)).toBe(true);
  });

  it("normal tier: Morph only on morphGroup pairs, fade elsewhere", () => {
    const s = spec({});
    s.slides[1].morphGroup = "g1";
    s.slides[2].morphGroup = "g1"; // slide 1->2 morph; 0->1 fade
    const plan = buildMotionPlan(s);
    expect(plan.map((m) => m.transition)).toEqual(["none", "fade", "morph"]);
    expect(plan[2].morphOption).toBe("byObject");
  });

  it("insane tier: Morph on every incoming slide + emphasis steps", () => {
    const plan = buildMotionPlan(spec({ tier: "insane" }));
    expect(plan.map((m) => m.transition)).toEqual(["none", "morph", "morph"]);
    expect(plan[1].steps.some((st) => st.effect === "fadeIn" && st.start === "click" && st.build === "byParagraph")).toBe(true);
    expect(stepFor(plan, 1, OBJ.bullets(1))?.start).toBe("click");
    expect(stepFor(plan, 1, OBJ.title(1))?.start).toBe("withPrevious");
  });

  it("reducedMotion: fade replaces morph and every step is dropped", () => {
    const plan = buildMotionPlan(spec({ tier: "insane", reducedMotion: true }));
    expect(plan.map((m) => m.transition)).toEqual(["none", "fade", "fade"]);
    expect(plan.every((m) => m.steps.length === 0)).toBe(true);
  });

  it("per-slide motion.transition override replaces the tier default", () => {
    const s = spec({ tier: "insane" });
    s.slides[1].motion = { transition: "fade" };
    expect(buildMotionPlan(s)[1].transition).toBe("fade");
    expect(buildMotionPlan(s)[2].transition).toBe("morph");
  });

  it('motion.reveal:"none" kills that slide\'s animation, not its transition', () => {
    const s = spec({ tier: "insane" });
    s.slides[1].motion = { reveal: "none" };
    const plan = buildMotionPlan(s);
    expect(plan[1].transition).toBe("morph");
    expect(plan[1].steps).toEqual([]);
    expect(plan[2].steps.length).toBeGreaterThan(0);
    expect(clickRevealCount(plan, 1, s.slides[1])).toBe(0);
  });

  it("clickRevealCount counts byParagraph bullet reveals only", () => {
    const plan = buildMotionPlan(spec({ tier: "insane" }));
    expect(clickRevealCount(plan, 1, spec({}).slides[1])).toBe(2);
    expect(clickRevealCount(plan, 0, spec({}).slides[0])).toBe(0);
  });

  it("stepSchedule mirrors PowerPoint main-sequence semantics", () => {
    const steps = [
      { objectName: "a", effect: "fadeIn" as const, start: "afterPrevious" as const, durationMs: 300 },
      { objectName: "b", effect: "flyIn" as const, start: "afterPrevious" as const, durationMs: 200 },
      { objectName: "c", effect: "zoomIn" as const, start: "withPrevious" as const, durationMs: 400 },
      { objectName: "d", effect: "fadeIn" as const, start: "click" as const, durationMs: 400 },
    ];
    const t = stepSchedule(steps);
    expect(t.get("a")).toBe(0);
    expect(t.get("b")).toBe(380); // 300 + inter-effect gap
    expect(t.get("c")).toBe(380); // withPrevious shares the slot
    expect(t.has("d")).toBe(false); // click reveals are gated manually
  });

  it("object names: cross-slide pair names repeat verbatim; bands sanitize", () => {
    expect(OBJ.splitMask(2)).toBe(OBJ.splitMask(2));
    expect(OBJ.statFill(1)).toBe("!!StatFill_s1");
    expect(OBJ.morphBand("hero group!!")).toBe("!!MorphBand_herogroup");
  });
});
