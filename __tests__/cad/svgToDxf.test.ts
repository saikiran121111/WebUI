import { describe, expect, it } from "vitest";
import { cadSpecSchema } from "../../lib/cad/cadSchema";
import { cadToDxf, dxfLayerName } from "../../lib/cad/svgToDxf";

const spec = cadSpecSchema.parse({
  title: "Dxf export test",
  units: "m",
  layers: [
    { id: "walls", color: "#F87171" },
    { id: "anno", color: "#E2E8F0", lineType: "dashed" },
  ],
  entities: [
    { kind: "line", layer: "walls", from: [0, 0], to: [10, 0] },
    { kind: "rect", layer: "walls", x: 1, y: 1, w: 2, h: 2 },
    { kind: "polyline", layer: "anno", points: [[0, 5], [2, 5], [2, 7]] },
    { kind: "polygon", layer: "anno", points: [[8, 1], [9, 1], [9, 2]] },
    { kind: "circle", layer: "anno", cx: 5, cy: 5, r: 1 },
    { kind: "arc", layer: "anno", cx: 1, cy: 1, r: 0.9, startDeg: 0, endDeg: 90 },
    { kind: "text", layer: "anno", x: 3, y: 3, content: "Floor\n© plan", height: 0.3 },
  ],
  walls: [{ id: "w1", layer: "walls", path: [[0, 0], [10, 0], [10, 6]], closed: true }],
  slabs: [],
  floors: [],
  hotspots: [],
  flows: [],
});

describe("dxfLayerName", () => {
  it("uppercases and prefixes layer ids", () => {
    expect(dxfLayerName("walls")).toBe("L-WALLS");
    expect(dxfLayerName("part-a")).toBe("L-PART-A");
    expect(dxfLayerName("a b!")).toBe("L-AB");
    expect(dxfLayerName("")).toBe("L-0");
  });
});

describe("cadToDxf", () => {
  it("R2000 emits LWPOLYLINE and truecolor layers", () => {
    const dxf = cadToDxf(spec, { version: "R2000" });
    expect(dxf).toContain("AC1015");
    expect(dxf).toContain("LWPOLYLINE");
    expect(dxf).toContain("L-WALLS");
    expect(dxf).toContain("420");
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
  });

  it("R12 falls back to POLYLINE/VERTEX/SEQEND and no LWPOLYLINE", () => {
    const dxf = cadToDxf(spec, { version: "R12" });
    expect(dxf).toContain("AC1009");
    expect(dxf).toContain("POLYLINE");
    expect(dxf).toContain("SEQEND");
    expect(dxf).not.toContain("LWPOLYLINE");
  });

  it("sanitizes TEXT content (newlines → space, non-ASCII stripped)", () => {
    const dxf = cadToDxf(spec, { version: "R2000" });
    expect(dxf).not.toContain("©");
    expect(dxf).toContain("Floor");
  });

  it("emits LINE, CIRCLE and ARC entities on the right layers", () => {
    const dxf = cadToDxf(spec, { version: "R2000" });
    expect(dxf).toContain("LINE");
    expect(dxf).toContain("CIRCLE");
    expect(dxf).toContain("ARC");
  });
});
