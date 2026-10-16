import { describe, it, expect } from "vitest";
import { anatomySpecSchema } from "../../lib/anatomy/anatomySchema";

export const VALID_SPEC = {
  title: "Single-cylinder head",
  fig: "FIG 1",
  label: "Cutaway single-cylinder head with a sliding piston",
  width: 560,
  height: 420,
  parts: [
    { id: "deck", tone: "base", kind: "slab", plan: { x: -40, y: -30, w: 80, d: 60, r: 6 }, z: 0, height: 14, label: "Deck", note: "Crankcase deck" },
    { id: "barrel", tone: "structure", kind: "cylinder", center: [0, 0], r: 22, z: 14, height: 46, label: "Cylinder barrel", on: "deck", explode: [0, 0, 18] },
    { id: "piston", tone: "subject", kind: "cylinder", center: [0, 0], r: 20, z: 18, height: 16, label: "Piston", on: "deck", slide: { axis: "z", from: 2, to: 26, state: "stroke" }, note: "Runs in the bore" },
    { id: "plug", tone: "accent", kind: "cylinder", center: [0, 0], r: 3, z: 60, height: 8, label: "Spark plug", on: "deck" },
  ],
  controls: [{ id: "stroke", kind: "slider", label: "Piston position", min: 0, max: 1, step: 0.01, value: 0.5 }],
  readouts: [{ id: "pos", label: "Piston height", unit: "mm", decimals: 1, formula: "18 + 24 * stroke" }],
  explode: { label: "Explode" },
  export: { filename: "single-cyl-head" },
};

// Deliberately loose: these tests construct INVALID specs to prove the
// schema rejects them, so the deep copy must not carry VALID_SPEC's typing.
function clone(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

describe("anatomySpecSchema", () => {
  it("accepts the documented worked example", () => {
    const parsed = anatomySpecSchema.safeParse(VALID_SPEC);
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown top-level keys (strict contract)", () => {
    const bad = { ...clone(VALID_SPEC), svg: "<svg/>" };
    expect(anatomySpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate ids across parts and controls", () => {
    const bad = clone(VALID_SPEC);
    bad.parts[1].id = "stroke";
    expect(anatomySpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a slide bound to a non-existent control", () => {
    const bad = clone(VALID_SPEC);
    bad.parts[2].slide.state = "nope";
    expect(anatomySpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a dangling parent reference", () => {
    const bad = clone(VALID_SPEC);
    bad.parts[1].on = "ghost";
    expect(anatomySpecSchema.safeParse(bad).success).toBe(false);
  });

  it("allows at most one accent part", () => {
    const bad = clone(VALID_SPEC);
    bad.parts[1].tone = "accent";
    expect(anatomySpecSchema.safeParse(bad).success).toBe(false);
  });

  it("readout formulas may only reference control ids and whitelisted functions", () => {
    const bad = clone(VALID_SPEC);
    bad.readouts[0].formula = "18 + 24 * piston_height";
    expect(anatomySpecSchema.safeParse(bad).success).toBe(false);

    const good = clone(VALID_SPEC);
    good.readouts[0].formula = "clamp(0, 100 * stroke, 100)";
    expect(anatomySpecSchema.safeParse(good).success).toBe(true);
  });

  it("enforces budgets: part count and rod path length", () => {
    const tooMany = clone(VALID_SPEC);
    tooMany.parts = Array.from({ length: 91 }, (_, i) => ({
      id: `p${i}`, tone: "base", kind: "slab", plan: { x: 0, y: 0, w: 1, d: 1, r: 0 }, z: 0, height: 1,
    }));
    expect(anatomySpecSchema.safeParse(tooMany).success).toBe(false);

    const longRod = clone(VALID_SPEC);
    longRod.parts = [{ id: "run", tone: "structure", kind: "rod", r: 2, path: Array.from({ length: 25 }, (_, i) => [i, 0, 0]) }];
    expect(anatomySpecSchema.safeParse(longRod).success).toBe(false);
  });

  it("rejects non-finite coordinates", () => {
    const bad = clone(VALID_SPEC);
    bad.parts[0].plan.w = null;
    expect(anatomySpecSchema.safeParse(bad).success).toBe(false);
  });

  // ── v2: profiles, budgets, and architectural references ──

  function slabs(count: number, prefix: string) {
    return Array.from({ length: count }, (_, i) => ({
      id: `${prefix}${i}`, tone: "base", kind: "slab", plan: { x: 0, y: 0, w: 1, d: 1, r: 0 }, z: 0, height: 1,
    }));
  }

  it("advanced profile lifts the logical part budget; standard still caps at 90", () => {
    const big = clone(VALID_SPEC);
    big.profile = "advanced";
    big.parts = slabs(240, "p");
    expect(anatomySpecSchema.safeParse(big).success).toBe(true);

    const bigStandard = clone(VALID_SPEC);
    bigStandard.parts = slabs(240, "p");
    expect(anatomySpecSchema.safeParse(bigStandard).success).toBe(false);
  });

  it("counts floor-module expansion against the rendered-instance cap", () => {
    const spec = clone(VALID_SPEC);
    spec.modules = [{ id: "mod", parts: slabs(40, "m") }];
    spec.floors = [0, 1, 2, 3].map((i) => ({ id: `fl${i}`, z: i * 10, module: "mod" }));
    // 4 authored parts + 4 floors x 40 instances = 164 rendered > 150 standard cap
    expect(anatomySpecSchema.safeParse(spec).success).toBe(false);

    spec.profile = "advanced";
    expect(anatomySpecSchema.safeParse(spec).success).toBe(true);
  });

  it("module parts count once toward the logical budget, not per floor", () => {
    const spec = clone(VALID_SPEC);
    spec.profile = "advanced";
    spec.parts = slabs(200, "p");
    spec.modules = [{ id: "mod", parts: slabs(50, "m") }];
    spec.floors = [{ id: "fl1", z: 0, module: "mod" }];
    // logical = 200 + 50 = 250 > 240 even though rendered = 250 <= 700
    expect(anatomySpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects dangling group, floor, module, connection and flow references", () => {
    const cases: Array<(spec: any) => void> = [
      (s) => { s.parts[0].group = "ghost-group"; },
      (s) => { s.parts[0].floor = "ghost-floor"; },
      (s) => { s.floors = [{ id: "fl1", z: 0, module: "ghost-module" }]; },
      (s) => { s.connections = [{ id: "c1", from: "ghost-part", path: [[0, 0, 0], [1, 1, 1]] }]; },
      (s) => { s.connections = [{ id: "c1", path: [[0, 0, 0], [1, 1, 1]] }]; s.flows = [{ id: "fl", connection: "ghost-conn" }]; },
      (s) => { s.groups = [{ id: "g1", label: "G" }]; s.controls.push({ id: "tg", kind: "toggle", label: "T", group: "ghost" }); },
    ];
    for (const mutate of cases) {
      const bad = clone(VALID_SPEC);
      mutate(bad);
      expect(anatomySpecSchema.safeParse(bad).success, JSON.stringify(mutate)).toBe(false);
    }
  });

  it("visibleWhen must reference a toggle control, not a slider", () => {
    const bad = clone(VALID_SPEC);
    bad.parts[0].visibleWhen = "stroke"; // stroke is a slider
    expect(anatomySpecSchema.safeParse(bad).success).toBe(false);

    const good = clone(VALID_SPEC);
    good.controls.push({ id: "showDeck", kind: "toggle", label: "Deck", value: true });
    good.parts[0].visibleWhen = "showDeck";
    expect(anatomySpecSchema.safeParse(good).success).toBe(true);
  });

  it("keeps the single-accent rule out of reach for module parts", () => {
    const bad = clone(VALID_SPEC);
    bad.modules = [{ id: "mod", parts: [{ id: "m0", tone: "accent", kind: "slab", plan: { x: 0, y: 0, w: 1, d: 1, r: 0 }, z: 0, height: 1 }] }];
    bad.floors = [{ id: "fl1", z: 0, module: "mod" }];
    expect(anatomySpecSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts the v2 control kinds with valid references", () => {
    const good = clone(VALID_SPEC);
    good.groups = [{ id: "g1", label: "Frame", color: "blue", section: "Shell" }];
    good.floors = [{ id: "fl1", z: 0, label: "Level 1" }];
    good.controls.push(
      { id: "tg", kind: "toggle", label: "Frame", value: true, group: "g1" },
      { id: "bt", kind: "button", label: "Play", action: "play" },
      { id: "sf", kind: "select", label: "Floor", target: "floor", value: "fl1" },
      { id: "ss", kind: "select", label: "System", target: "system", options: [{ value: "g1", label: "Frame" }] },
    );
    expect(anatomySpecSchema.safeParse(good).success).toBe(true);
  });

  it("select target floor needs floors, select target system needs groups", () => {
    const noFloors = clone(VALID_SPEC);
    noFloors.controls.push({ id: "sf", kind: "select", label: "Floor", target: "floor" });
    expect(anatomySpecSchema.safeParse(noFloors).success).toBe(false);

    const noGroups = clone(VALID_SPEC);
    noGroups.controls.push({ id: "ss", kind: "select", label: "System", target: "system" });
    expect(anatomySpecSchema.safeParse(noGroups).success).toBe(false);
  });
});
