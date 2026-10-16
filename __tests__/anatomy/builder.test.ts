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

const ARCH_SPEC = {
  title: "Two-level module stub",
  fig: "FIG 9",
  label: "Two levels of one reusable module with a service route",
  groups: [{ id: "g1", label: "Frame", color: "blue", section: "Shell" }],
  floors: [
    { id: "f1", z: 0, module: "m1", label: "L1" },
    { id: "f2", z: 20, module: "m1", label: "L2" },
  ],
  modules: [
    {
      id: "m1",
      parts: [
        { id: "plate", tone: "base", kind: "slab", plan: { x: -10, y: -10, w: 20, d: 20, r: 1 }, z: 0, height: 3, label: "Plate", group: "g1", explode: [0, 0, 6] },
        { id: "post", tone: "structure", kind: "rod", r: 1, path: [[8, 8, 3], [8, 8, 15]], label: "Post", on: "plate", group: "g1" },
      ],
    },
  ],
  parts: [
    { id: "base", tone: "base", kind: "slab", plan: { x: -14, y: -14, w: 28, d: 28, r: 1 }, z: -4, height: 4, label: "Base", info: "Raft under both levels", visibleWhen: "vis" },
  ],
  connections: [{ id: "c1", system: "g1", from: "base", to: "base", label: "Service loop", path: [[0, 0, 2], [10, 10, 24]] }],
  flows: [{ id: "fl1", connection: "c1", speed: 1.5 }],
  controls: [
    { id: "tg", kind: "toggle", label: "Frame", value: true, group: "g1" },
    { id: "vis", kind: "toggle", label: "Base", value: true },
    { id: "bt", kind: "button", label: "Play", action: "play" },
    { id: "sel", kind: "select", label: "Floor", target: "floor" },
  ],
};

describe("buildAnatomyFigure (architectural v2 markup)", () => {
  const figure = build(ARCH_SPEC);

  it("expands floor modules into addressable per-floor part groups", () => {
    for (const id of ["f1__plate", "f1__post", "f2__plate", "f2__post"]) {
      expect(figure.plate, `missing instance: ${id}`).toContain(`data-part="${id}"`);
    }
    expect(figure.plate).toContain('data-floor="f2"');
    expect(figure.plate).toContain('data-group="g1"');
    expect(figure.plate).toContain('data-visible-when="vis"');
    expect(figure.plate).toContain('data-info="Raft under both levels"');
  });

  it("wraps the drawing in a viewport group and adds the info-panel slot", () => {
    expect(figure.plate).toContain("<g data-viewport>");
    expect(figure.plate).toContain("data-anatomy-info");
  });

  it("draws connections as dashed routes with flow paths on their own paths", () => {
    expect(figure.plate).toContain('data-connection="c1"');
    expect(figure.plate).toContain('data-system="g1"');
    expect(figure.plate).toContain('class="anatomy-flow"');
    expect(figure.plate).toContain('data-speed="1.5"');
    expect(figure.plate).toContain('stroke="#3d7dd8"'); // blue system convention, inline so exports need no app CSS
  });

  it("liveSpec carries groups, floors and the extended control kinds", () => {
    expect(figure.liveSpec.groups).toEqual([{ id: "g1", label: "Frame", color: "blue", section: "Shell" }]);
    expect(figure.liveSpec.floors).toEqual([{ id: "f1", label: "L1" }, { id: "f2", label: "L2" }]);
    const byId = new Map(figure.liveSpec.controls.map((c) => [c.id, c]));
    expect(byId.get("tg")).toMatchObject({ kind: "toggle", group: "g1" });
    expect(byId.get("bt")).toMatchObject({ kind: "button", action: "play" });
    expect(byId.get("sel")).toMatchObject({ kind: "select", target: "floor" });
  });

  it("expanded instances keep their motion bindings in liveSpec", () => {
    const instance = figure.liveSpec.parts.find((p) => p.id === "f2__plate");
    expect(instance?.explode).toEqual([0, 0, 6]);
  });
});
