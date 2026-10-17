import type { CadEntity, CadSpec } from "./cadSchema";

/**
 * Pure 2D geometry helpers shared by the ArchitectureCadViewer (blueprint
 * tools: measure / area / protractor / grid / scale bar / sun), the isometric
 * cutaway projection, and the export serializers. No DOM, no three — unit
 * testable in node.
 */

export type Point2 = [number, number];

export interface BBox2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Model-space extent of every drawable in the spec (entities, walls, slabs, hotspots). */
export function specBBox(spec: CadSpec): BBox2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const eat = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const entity of spec.entities) {
    for (const [x, y] of entityPoints(entity)) eat(x, y);
  }
  for (const wall of spec.walls) for (const [x, y] of wall.path) eat(x, y);
  for (const slab of spec.slabs) for (const [x, y] of slab.outline) eat(x, y);
  for (const hotspot of spec.hotspots) eat(hotspot.x, hotspot.y);
  for (const flow of spec.flows) for (const [x, y] of flow.points) eat(x, y);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  return { minX, minY, maxX, maxY };
}

export function entityPoints(entity: CadEntity): Point2[] {
  switch (entity.kind) {
    case "line":
      return [entity.from, entity.to];
    case "rect":
      return [
        [entity.x, entity.y],
        [entity.x + entity.w, entity.y + entity.h],
      ];
    case "polyline":
    case "polygon":
      return entity.points;
    case "circle":
    case "arc":
      return [
        [entity.cx - entity.r, entity.cy - entity.r],
        [entity.cx + entity.r, entity.cy + entity.r],
      ];
    case "text":
      return [[entity.x, entity.y]];
  }
}

export function distance(a: Point2, b: Point2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Shoelace area of a closed ring, always positive (model units²). */
export function shoelaceArea(points: Point2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
}

export function polylineLength(points: Point2[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  if (closed && points.length > 2) total += distance(points[points.length - 1], points[0]);
  return total;
}

/** Interior angle (degrees, 0–180) at vertex `b` between rays b→a and b→c. */
export function angleAtDeg(a: Point2, b: Point2, c: Point2): number {
  const a1 = Math.atan2(a[1] - b[1], a[0] - b[0]);
  const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let delta = Math.abs(a1 - a2) * (180 / Math.PI);
  if (delta > 180) delta = 360 - delta;
  return delta;
}

/** Convert a model-space value to meters for the given unit. */
export function toMeters(value: number, units: CadSpec["units"]): number {
  const factor = { m: 1, mm: 0.001, cm: 0.01, ft: 0.3048 }[units];
  return value * factor;
}

/** Human length label in the spec's unit; feet also get the imperial ft'in" form. */
export function formatLength(value: number, units: CadSpec["units"]): string {
  if (units === "mm") return `${Math.round(value)} mm`;
  if (units === "cm") return `${trimZero(value * 10, 1)} cm`;
  if (units === "m") return `${trimZero(value, 2)} m`;
  const totalTenths = Math.round(value * 12 * 10); // value is already feet → tenths of an inch
  const feet = Math.floor(totalTenths / 120);
  const inches = (totalTenths % 120) / 10;
  return `${feet}'-${trimZero(inches, 1)}"`;
}

export function formatArea(areaModelUnits2: number, units: CadSpec["units"]): string {
  const m2 = toMeters(Math.sqrt(areaModelUnits2), units) ** 2;
  if (units === "ft") return `${trimZero(m2 / 0.3048 ** 2, 2)} ft²`;
  if (units === "mm") return `${trimZero(m2 * 1e6, 0)} mm²`;
  if (units === "cm") return `${trimZero(m2 * 1e4, 1)} cm²`;
  return `${trimZero(m2, 2)} m²`;
}

export function formatAngle(deg: number): string {
  return `${trimZero(deg, 1)}°`;
}

/** Classic 2:1 isometric projection: model (x, y, z) → iso screen (y-down). */
export function isoProject(x: number, y: number, z: number): Point2 {
  return [(x - y) * 0.8660254, (x + y) * 0.5 - z];
}

/** 1/2/5×10^k grid step closest to `span / targetLines`. */
export function niceRoundStep(span: number, targetLines: number): number {
  if (span <= 0 || targetLines <= 0) return 1;
  const raw = span / targetLines;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  const step = unit >= 5 ? 5 : unit >= 2 ? 2 : 1;
  return step * pow;
}

/** Approximate solar altitude/azimuth for the shadow simulator (06:00–20:00 arc). */
export function sunPosition(time: number): { altitudeDeg: number; azimuthDeg: number } {
  const dayT = (time - 6) / 14; // 0 at 06:00, 1 at 20:00
  if (dayT <= 0 || dayT >= 1) return { altitudeDeg: -5, azimuthDeg: 180 };
  const altitudeDeg = 2 + Math.sin(Math.PI * dayT) * 68;
  const azimuthDeg = 90 + dayT * 180; // east → south → west
  return { altitudeDeg, azimuthDeg };
}

/** Thermal / energy theme ramp: cool → hot over t in [0,1]. */
export function thermalColor(t: number): string {
  const stops = ["#1E3A8A", "#38BDF8", "#FBBF24", "#FB7185"];
  const clamped = Math.min(0.999, Math.max(0, t));
  const idx = clamped * (stops.length - 1);
  const lo = stops[Math.floor(idx)];
  const hi = stops[Math.ceil(idx)];
  const f = idx - Math.floor(idx);
  const mix = (a: string, b: string, at: number) => {
    const an = parseInt(a.slice(1), 16);
    const bn = parseInt(b.slice(1), 16);
    const r = Math.round((((an >> 16) & 255) * (1 - at) + ((bn >> 16) & 255) * at));
    const g = Math.round((((an >> 8) & 255) * (1 - at) + ((bn >> 8) & 255) * at));
    const bch = Math.round(((an & 255) * (1 - at) + (bn & 255) * at));
    return `#${((r << 16) | (g << 8) | bch).toString(16).padStart(6, "0")}`;
  };
  return mix(lo, hi, f);
}

export function formatScaleLabel(ratio: number): string {
  return `1:${ratio}`;
}

export function trimZero(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, "$1");
}
