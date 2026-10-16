import { describe, it, expect } from "vitest";
import { buildAnatomyFigure } from "../../lib/anatomy/anatomyBuilder";
import { anatomySpecSchema } from "../../lib/anatomy/anatomySchema";
import { VALID_SPEC } from "./schema.test";

function build(raw: unknown) {
  const parsed = anatomySpecSchema.parse(raw);
  return buildAnatomyFigure(parsed);
}

describe("buildAnatomyFigure (deterministic kit projection)", () => {
  const figure = build(VALID_SPEC);

  it("produces an SVG figure with plate chrome and aria label", () => {
    expect(figure.svg).toContain("<svg");
    expect(figure.svg).toContain('class="iso-svg anatomy-svg"');
    expect(figure.svg).toContain('aria-label="Cutaway single-cylinder head');
    expect(figure.plate).toContain('class="iso-figure"');
    expect(figure.plate).toContain('data-corner="fig"');
  });

  it("every part becomes a data-part group; notes ride along for hover", () => {
    for (const id of ["deck", "barrel", "piston", "plug"]) {
      expect(figure.plate, `missing part group: ${id}`).toContain(`data-part="${id}"`);
    }
    expect(figure.plate).toContain('data-note="Runs in the bore"');
  });

  it("painter order: farthest first, children nested after their parent", () => {
    const order = [...figure.svg.matchAll(/data-part="([a-z]+)"/g)].map(m => m[1]);
    expect(order).toEqual(["deck", "piston", "barrel", "plug"]);
  });

  it("liveSpec carries camera, the slide binding, controls and readouts", () => {
    expect(figure.liveSpec.camera.azimuth).toBe(45);
    expect(Number.isFinite(figure.liveSpec.camera.scale)).toBe(true);
    const piston = figure.liveSpec.parts.find(p => p.id === "piston");
    expect(piston?.slide).toBeDefined();
    expect(piston?.slide?.state).toBe("stroke");
    expect(figure.liveSpec.controls.map(c => c.id)).toEqual(["stroke"]);
    expect(figure.liveSpec.readouts[0].formula).toBe("18 + 24 * stroke");
    expect(figure.liveSpec.explode).toBe(true);
  });

  it("escapes model-provided strings (no script injection through titles)", () => {
    const evil = { ...VALID_SPEC, title: "<script>alert(1)</script>", parts: [VALID_SPEC.parts[0]] };
    const f = build(evil);
    expect(f.plate).not.toContain("<script>alert");
    expect(f.plate).toContain("&lt;script&gt;");
  });

  it("dial needles get a data-needle path bound to the live state", () => {
    const gauge = {
      title: "Dial gauge", fig: "FIG 2", label: "Gauge with a live needle",
      parts: [
        { id: "body", tone: "structure", kind: "cylinder", center: [0, 0], r: 30, z: 0, height: 6 },
        { id: "face", tone: "base", kind: "dial", center: [0, 0], z: 6, r: 26,
          ticks: { count: 40, every: 5 }, needle: { from: -120, to: 120, state: "load" } },
      ],
      controls: [{ id: "load", kind: "slider", label: "Load", min: 0, max: 10, step: 0.1, value: 5 }],
      readouts: [{ id: "psi", label: "Pressure", unit: "psi", decimals: 1, formula: "14.7 * load" }],
    };
    const f = build(gauge);
    expect(f.svg).toContain('data-needle="face"');
    expect(f.liveSpec.parts.find(p => p.id === "face")?.needle?.state).toBe("load");
  });

  it("warns when explode is enabled but a part has no explode vector", () => {
    expect(figure.warnings.some(w => w.includes("deck"))).toBe(true);
  });

  it("filename falls back to a slug of the title", () => {
    const noExport = { ...VALID_SPEC };
    delete (noExport as Record<string, unknown>).export;
    expect(build(noExport).filename).toBe("single-cylinder-head");
  });
});
