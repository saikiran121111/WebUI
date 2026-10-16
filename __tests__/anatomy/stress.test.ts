import { describe, expect, it } from "vitest";
import {
  ANATOMY_ADVANCED_BUDGETS,
  anatomySpecSchema,
  logicalPartCount,
  renderedPartCount,
  type AnatomySpec,
} from "../../lib/anatomy/anatomySchema";
import { buildAnatomyFigure } from "../../lib/anatomy/anatomyBuilder";
import { expandFloorModules } from "../../lib/anatomy/floorModules";
import { buildAetherionSpec, slab } from "../../tests/helpers/aetherion";

describe("AETHERION advanced-profile stress benchmark", () => {
  const raw = buildAetherionSpec();
  const parsed = anatomySpecSchema.safeParse(raw);

  it("validates at the very edge of every advanced budget", () => {
    if (!parsed.success) {
      console.log("ISSUES", JSON.stringify(parsed.error.issues.slice(0, 8), null, 1));
      throw new Error("AETHERION spec must validate");
    }
    const spec = parsed.data;
    expect(spec.floors).toHaveLength(80);
    expect(logicalPartCount(spec)).toBe(240);
    expect(renderedPartCount(spec)).toBeLessThanOrEqual(ANATOMY_ADVANCED_BUDGETS.maxRenderedParts);
    expect(renderedPartCount(spec)).toBe(497);
    // Repeated floors never duplicate authored geometry: 80 floors share 5 modules.
    expect(expandFloorModules(spec)).toHaveLength(497);
  });

  it("builds the full 497-part plate with every part drawn, fast", () => {
    if (!parsed.success) throw new Error("spec must validate first");
    const started = performance.now();
    const figure = buildAnatomyFigure(parsed.data);
    const elapsedMs = performance.now() - started;
    const drawn = (figure.plate.match(/data-part="/g) ?? []).length;
    console.log(`AETHERION build: 497 rendered parts in ${elapsedMs.toFixed(1)} ms, plate ${figure.plate.length} chars`);
    expect(drawn).toBe(497);
    // One aggregated notice instead of 493 per-part lines.
    expect(figure.warnings).toEqual(['493 parts have no explode offset and will stay put (first: "core-a")']);
    expect(elapsedMs).toBeLessThan(4000);
  });

  // Over-budget specs must fail with precise messages in BOTH the scene
  // contract and the renderer — never silently truncated.
  function overBudgetSpec() {
    const over = buildAetherionSpec();
    over.modules = [{ id: "big", anchorZ: 0, parts: Array.from({ length: 100 }, (_, i) => slab(`b${i + 1}`, i * 4 - 200, 0, 3, 3, 0, 3, "base")) }];
    over.floors = Array.from({ length: 8 }, (_, i) => ({ id: `g${i + 1}`, z: i * 7, module: "big" }));
    over.parts = [slab("anchor", 0, 0, 4, 4, 0, 4, "structure")];
    return over;
  }

  it("scene contract rejects an over-rendered spec with a precise message", () => {
    const res = anatomySpecSchema.safeParse(overBudgetSpec());
    expect(res.success).toBe(false);
    if (res.success) return;
    const message = res.error.issues.find((issue) => issue.path[0] === "floors")?.message ?? "";
    expect(message).toContain("801 rendered parts");
    expect(message).toContain("cap of 700");
  });

  it("renderer refuses an over-budget figure instead of silently truncating it", () => {
    expect(() => buildAnatomyFigure(overBudgetSpec() as unknown as AnatomySpec)).toThrow(/anatomy build refused: 801 rendered parts exceed the "advanced" cap of 700/);
  });
});
