import { describe, expect, it } from "vitest";
import { cadSpecSchema } from "../../lib/cad/cadSchema";
import {
  angleAtDeg,
  distance,
  entityPoints,
  formatAngle,
  formatArea,
  formatLength,
  formatScaleLabel,
  isoProject,
  niceRoundStep,
  polylineLength,
  shoelaceArea,
  specBBox,
  sunPosition,
  thermalColor,
  toMeters,
  trimZero,
} from "../../lib/cad/cad2d";

const spec = cadSpecSchema.parse({
  title: "BBox test",
  units: "m",
  layers: [
    { id: "walls", color: "#F87171" },
    { id: "anno", color: "#E2E8F0" },
  ],
  entities: [
    { kind: "rect", layer: "anno", x: 1, y: 2, w: 3, h: 4 },
    { kind: "text", layer: "anno", x: 9, y: 9, content: "x", height: 0.3 },
  ],
  walls: [{ id: "w1", layer: "walls", path: [[0, 0], [12, 0]] }],
  slabs: [],
  floors: [],
  hotspots: [{ id: "h1", x: 6, y: 3, title: "core" }],
  flows: [],
});

describe("cad2d geometry", () => {
  it("specBBox spans entities, walls and hotspots", () => {
    expect(specBBox(spec)).toEqual({ minX: 0, minY: 0, maxX: 12, maxY: 9 });
  });

  it("entityPoints returns rect corners", () => {
    const rect = spec.entities.find(e => e.kind === "rect")!;
    expect(entityPoints(rect)).toEqual([[1, 2], [4, 6]]);
  });

  it("distance is euclidean", () => {
    expect(distance([0, 0], [3, 4])).toBe(5);
  });

  it("shoelaceArea is positive for a unit square", () => {
    expect(shoelaceArea([[0, 0], [1, 0], [1, 1], [0, 1]])).toBe(1);
    expect(shoelaceArea([[0, 0], [0, 1], [1, 1], [1, 0]])).toBe(1); // reversed winding
  });

  it("polylineLength adds the closing edge only when closed", () => {
    expect(polylineLength([[0, 0], [3, 0], [3, 4]], false)).toBe(7);
    expect(polylineLength([[0, 0], [3, 0], [3, 4]], true)).toBe(12);
  });

  it("angleAtDeg gives the interior angle at the middle vertex", () => {
    expect(angleAtDeg([1, 0], [0, 0], [0, 1])).toBeCloseTo(90);
    expect(angleAtDeg([1, 0], [0, 0], [-1, 0])).toBeCloseTo(180);
  });

  it("toMeters converts every unit", () => {
    expect(toMeters(2, "m")).toBe(2);
    expect(toMeters(1000, "mm")).toBeCloseTo(1);
    expect(toMeters(2, "ft")).toBeCloseTo(0.6096);
  });

  it("formatLength labels units and imperial feet-inches", () => {
    expect(formatLength(12.5, "m")).toBe("12.5 m");
    expect(formatLength(5, "mm")).toBe("5 mm");
    expect(formatLength(2.5, "ft")).toBe("2'-6\"");
  });

  it("formatArea converts through square meters", () => {
    expect(formatArea(4, "m")).toBe("4 m²");
    expect(formatArea(1, "ft")).toBe("1 ft²");
  });

  it("formatAngle trims trailing zeros", () => {
    expect(formatAngle(90)).toBe("90°");
    expect(formatAngle(45.5)).toBe("45.5°");
  });

  it("isoProject is the classic 2:1 isometric", () => {
  const [ix, iy] = isoProject(1, 0, 0);
    expect(ix).toBeCloseTo(0.8660254);
    expect(iy).toBeCloseTo(0.5);
    expect(isoProject(0, 0, 1)).toEqual([0, -1]);
  });

  it("niceRoundStep snaps to 1/2/5×10^k", () => {
    expect(niceRoundStep(100, 10)).toBe(10);
    expect(niceRoundStep(1000, 10)).toBe(100);
    expect(niceRoundStep(0, 10)).toBe(1);
  });

  it("sunPosition peaks near noon and reports night outside the arc", () => {
    expect(sunPosition(13).altitudeDeg).toBeCloseTo(70);
    expect(sunPosition(13).azimuthDeg).toBeCloseTo(180);
    expect(sunPosition(7).altitudeDeg).toBeGreaterThan(0);
    expect(sunPosition(21).altitudeDeg).toBe(-5);
  });

  it("thermalColor ramps cool→hot as hex", () => {
    expect(thermalColor(0)).toMatch(/^#[0-9a-f]{6}$/);
    expect(thermalColor(0)).not.toBe(thermalColor(1));
  });

  it("formatScaleLabel and trimZero", () => {
    expect(formatScaleLabel(75)).toBe("1:75");
    expect(trimZero(12.5, 2)).toBe("12.5");
    expect(trimZero(12, 2)).toBe("12");
  });
});
