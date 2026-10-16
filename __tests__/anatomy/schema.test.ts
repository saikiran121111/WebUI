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
});
