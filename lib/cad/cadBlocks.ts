/**
 * Pure 2D CAD block geometry for the AutoCAD-grade blueprint engine.
 * No React, no three — ArchitectureCadViewer rasterizes these primitives into
 * SVG: double-lined poché-hatched walls, door leaves + swing arcs, triple-line
 * glazing, authentic furniture blocks, 45° dimension ticks, grid axes/bubbles
 * and collision-checked room tag pills.
 *
 * All coordinates are model-space (meters, y-up); the viewer's viewBox flip
 * handles screen space. pxPerModel converts screen pixel sizes (fonts, pills)
 * back into model units.
 */

export type Pt = [number, number];

export interface RectBox { x: number; y: number; w: number; h: number }

export type BlockPrim =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "line"; a: Pt; b: Pt; dash?: string }
  | { kind: "circle"; cx: number; cy: number; r: number; filled?: boolean }
  | { kind: "arc"; cx: number; cy: number; r: number; a0: number; a1: number; dash?: string };

export const FURNITURE_CATEGORIES = [
  "sofa", "table", "dining_table", "coffee_table", "counter", "sink", "bed", "wardrobe",
  "toilet", "shower", "desk", "chair", "shelving", "stairs", "plant", "server_rack",
  "appliance", "generic",
] as const;
export type FurnitureCategory = (typeof FURNITURE_CATEGORIES)[number];

export function deg2rad(d: number): number { return (d * Math.PI) / 180; }

/* ── wall offsetting (double lines + poché) ─────────────────────────────── */

function segOffset(a: Pt, b: Pt, off: number): [Pt, Pt] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * off;
  const ny = (dx / len) * off;
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny]];
}

function lineIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  return [p1[0] + d1x * t, p1[1] + d1y * t];
}

/**
 * Miter-offset a polyline into its two face lines. Closed polylines produce
 * two closed rings (outer + inner, evenodd-fillable); open polylines produce
 * two open strips. Miters longer than 4×off are clamped to the bevel midpoint
 * so degenerate spikes never escape the wall.
 */
export function offsetPolyline(path: Pt[], off: number, closed: boolean): { outer: Pt[]; inner: Pt[] } {
  const side = (sign: number): Pt[] => {
    const segs: [Pt, Pt][] = [];
    for (let i = 0; i < path.length - 1; i++) segs.push(segOffset(path[i], path[i + 1], off * sign));
    if (closed && path.length > 2) segs.push(segOffset(path[path.length - 1], path[0], off * sign));
    if (!segs.length) return path.map((p) => [p[0], p[1]] as Pt);
    const out: Pt[] = [];
    if (closed) {
      for (let i = 0; i < segs.length; i++) {
        const a = segs[i], b = segs[(i + 1) % segs.length];
        const vertex = path[(i + 1) % path.length];
        const hit = lineIntersect(a[0], a[1], b[0], b[1]);
        if (hit && Math.hypot(hit[0] - vertex[0], hit[1] - vertex[1]) <= 4 * off) out.push(hit);
        else out.push([(a[1][0] + b[0][0]) / 2, (a[1][1] + b[0][1]) / 2]);
      }
    } else {
      out.push(segs[0][0]);
      for (let i = 0; i < segs.length - 1; i++) {
        const vertex = path[i + 1];
        const hit = lineIntersect(segs[i][0], segs[i][1], segs[i + 1][0], segs[i + 1][1]);
        if (hit && Math.hypot(hit[0] - vertex[0], hit[1] - vertex[1]) <= 4 * off) out.push(hit);
        else out.push([(segs[i][1][0] + segs[i + 1][0][0]) / 2, (segs[i][1][1] + segs[i + 1][0][1]) / 2]);
      }
      out.push(segs[segs.length - 1][1]);
    }
    return out;
  };
  return { outer: side(1), inner: side(-1) };
}

/** SVG path for the wall poché: closed rings use evenodd (outer + reversed inner). */
export function hatchFillPath(outer: Pt[], inner: Pt[], closed: boolean): string {
  const fmt = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join("");
  const rev = [...inner].reverse();
  return `${fmt(outer)}${fmt(rev)}Z`;
}

/* ── openings ───────────────────────────────────────────────────────────── */

export interface DoorSymbol { leaf: [Pt, Pt]; arc: { cx: number; cy: number; r: number; a0: number; a1: number } }

export function doorSymbol(hinge: Pt, angleDeg: number, width: number, swingDeg: number): DoorSymbol {
  const a = deg2rad(angleDeg);
  const tip: Pt = [hinge[0] + Math.cos(a) * width, hinge[1] + Math.sin(a) * width];
  return { leaf: [hinge, tip], arc: { cx: hinge[0], cy: hinge[1], r: width, a0: angleDeg, a1: angleDeg + swingDeg } };
}

/** Triple-line glazing: two frame lines, center glass line, mullion ticks. */
export function windowLines(from: Pt, to: Pt, depth: number, mullions: number): { a: Pt; b: Pt }[] {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (depth / 2);
  const ny = (dx / len) * (depth / 2);
  const lines: { a: Pt; b: Pt }[] = [
    { a: [from[0] + nx, from[1] + ny], b: [to[0] + nx, to[1] + ny] },
    { a: [from[0] - nx, from[1] - ny], b: [to[0] - nx, to[1] - ny] },
    { a: from, b: to },
  ];
  for (let i = 1; i <= mullions; i++) {
    const t = i / (mullions + 1);
    const px = from[0] + dx * t, py = from[1] + dy * t;
    lines.push({ a: [px - nx, py - ny], b: [px + nx, py + ny] });
  }
  return lines;
}

/* ── furniture category inference ───────────────────────────────────────── */

const CATEGORY_KEYWORDS: [FurnitureCategory, string[]][] = [
  ["sofa", ["sofa", "couch", "seating", "lounge", "bench"]],
  ["dining_table", ["dining", "banquet", "cafe table"]],
  ["coffee_table", ["coffee"]],
  ["counter", ["counter", "bar ", "bar", "island", "kitchen", "vanity"]],
  ["sink", ["sink", "basin", "wash"]],
  ["bed", ["bed", "cot"]],
  ["wardrobe", ["wardrobe", "closet", "cabinet", "cupboard"]],
  ["toilet", ["toilet", "wc", "water closet"]],
  ["shower", ["shower"]],
  ["desk", ["desk", "workstation", "workbench"]],
  ["chair", ["chair", "stool"]],
  ["shelving", ["shelf", "shelves", "bookcase"]],
  ["stairs", ["stair", "staircase"]],
  ["plant", ["plant", "planter", "tree", "garden", "solar"]],
  ["server_rack", ["server", "rack", "quantum", "cooling", "pdu"]],
  ["appliance", ["fridge", "refrigerator", "espresso machine", "oven", "dishwasher", "appliance", "cooler"]],
];

export function inferCategory(label: string, w: number, h: number): FurnitureCategory {
  const l = ` ${label.toLowerCase().trim()} `;
  for (const [cat, keys] of CATEGORY_KEYWORDS) {
    if (keys.some((k) => l.includes(k))) return cat;
  }
  if (l.includes("table")) return "table";
  const area = w * h;
  const ratio = Math.max(w, h) / Math.max(0.01, Math.min(w, h));
  if (area >= 3.2 && ratio < 2.2) return "table";
  if (area < 0.6) return "chair";
  return "generic";
}

/* ── procedural CAD block symbols (local [0,w]×[0,h], y-up) ─────────────── */

export function furnitureBlock(category: FurnitureCategory, w: number, h: number): BlockPrim[] {
  switch (category) {
    case "sofa": {
      const hb = Math.min(0.25, h * 0.3);
      const aw = Math.min(0.2, w * 0.12);
      const prims: BlockPrim[] = [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "rect", x: 0, y: h - hb, w, h: hb },
        { kind: "rect", x: 0, y: 0, w: aw, h: h - hb },
        { kind: "rect", x: w - aw, y: 0, w: aw, h: h - hb },
      ];
      const seatW = Math.max(0.2, w - 2 * aw);
      const n = Math.max(1, Math.round(seatW / 0.7));
      for (let i = 1; i < n; i++) {
        const x = aw + (seatW / n) * i;
        prims.push({ kind: "line", a: [x, 0.05], b: [x, h - hb - 0.05] });
      }
      return prims;
    }
    case "table":
      return [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "rect", x: 0.06, y: 0.06, w: Math.max(0.05, w - 0.12), h: Math.max(0.05, h - 0.12) },
      ];
    case "dining_table": {
      const prims: BlockPrim[] = [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "rect", x: 0.06, y: 0.06, w: Math.max(0.05, w - 0.12), h: Math.max(0.05, h - 0.12) },
      ];
      const cw = 0.45, ch = 0.45;
      const nX = Math.max(1, Math.round(w / 0.9));
      const nY = Math.max(0, Math.round(h / 0.9));
      for (let i = 0; i < nX; i++) {
        const cx = ((i + 0.5) / nX) * w - cw / 2;
        prims.push({ kind: "rect", x: cx, y: h + 0.08, w: cw, h: ch });
        prims.push({ kind: "rect", x: cx, y: -0.08 - ch, w: cw, h: ch });
      }
      for (let i = 0; i < nY; i++) {
        const cy = ((i + 0.5) / Math.max(1, nY)) * h - ch / 2;
        prims.push({ kind: "rect", x: w + 0.08, y: cy, w: ch, h: cw });
        prims.push({ kind: "rect", x: -0.08 - ch, y: cy, w: ch, h: cw });
      }
      return prims;
    }
    case "coffee_table":
      return [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "rect", x: 0.05, y: 0.05, w: Math.max(0.05, w - 0.1), h: Math.max(0.05, h - 0.1) },
        { kind: "circle", cx: w / 2, cy: h / 2, r: Math.min(w, h) * 0.18 },
      ];
    case "counter": {
      const prims: BlockPrim[] = [{ kind: "rect", x: 0, y: 0, w, h }];
      const basinW = Math.min(0.55, w * 0.22);
      const basinH = Math.min(0.5, h * 0.6);
      const sx = w * 0.12, sy = (h - basinH) / 2;
      prims.push({ kind: "rect", x: sx, y: sy, w: basinW, h: basinH });
      prims.push({ kind: "rect", x: sx + basinW + 0.06, y: sy, w: basinW, h: basinH });
      prims.push({ kind: "circle", cx: sx + basinW + 0.03, cy: sy + basinH / 2, r: 0.04 });
      if (w >= 1.2) {
        const r = Math.min(0.14, h * 0.16);
        const cx0 = w * 0.62, cy0 = h * 0.3;
        for (const [ox, oy] of [[0, 0], [r * 2.6, 0], [0, r * 2.6], [r * 2.6, r * 2.6]]) {
          prims.push({ kind: "circle", cx: cx0 + ox, cy: cy0 + oy, r });
        }
      }
      return prims;
    }
    case "sink": {
      const inset = Math.min(0.12, w * 0.15, h * 0.15);
      return [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "rect", x: inset, y: inset, w: w - 2 * inset, h: h - 2 * inset },
        { kind: "circle", cx: w / 2, cy: h * 0.45, r: Math.min(w, h) * 0.12 },
        { kind: "circle", cx: w / 2, cy: h - inset * 1.6, r: 0.035 },
      ];
    }
    case "bed": {
      const prims: BlockPrim[] = [{ kind: "rect", x: 0, y: 0, w, h }];
      const pw = Math.max(0.1, (w - 0.1) / 2);
      const ph = Math.min(0.45, h * 0.22);
      prims.push({ kind: "rect", x: 0.03, y: h - 0.06 - ph, w: pw, h: ph });
      prims.push({ kind: "rect", x: 0.07 + pw, y: h - 0.06 - ph, w: pw, h: ph });
      const foldY = h * 0.38;
      prims.push({ kind: "line", a: [0.03, foldY], b: [w - 0.03, foldY] });
      prims.push({ kind: "line", a: [0.03, foldY + 0.06], b: [w - 0.03, foldY + 0.06] });
      return prims;
    }
    case "wardrobe": {
      const prims: BlockPrim[] = [{ kind: "rect", x: 0, y: 0, w, h }];
      for (const t of [1 / 3, 2 / 3]) {
        const x = w * t;
        prims.push({ kind: "line", a: [x, 0], b: [x, h] });
        prims.push({ kind: "circle", cx: x - 0.05, cy: h * 0.5, r: 0.02, filled: true });
        prims.push({ kind: "circle", cx: x + 0.05, cy: h * 0.5, r: 0.02, filled: true });
      }
      return prims;
    }
    case "toilet": {
      const tankW = Math.min(w, 0.7);
      const bowlR = Math.min(w, h) * 0.3;
      return [
        { kind: "rect", x: (w - tankW) / 2, y: h - 0.2, w: tankW, h: 0.2 },
        { kind: "circle", cx: w / 2, cy: h * 0.45, r: bowlR },
        { kind: "arc", cx: w / 2, cy: h * 0.45, r: bowlR * 0.72, a0: 200, a1: 340 },
      ];
    }
    case "shower": {
      const r = Math.min(w, h) * 0.4;
      return [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "line", a: [0, 0], b: [w, h] },
        { kind: "line", a: [0, h], b: [w, 0] },
        { kind: "circle", cx: w / 2, cy: h / 2, r: Math.min(w, h) * 0.08 },
        { kind: "arc", cx: 0, cy: 0, r, a0: 0, a1: 90, dash: "4 3" },
      ];
    }
    case "desk": {
      const mw = Math.min(0.5, w * 0.4);
      return [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "rect", x: (w - mw) / 2, y: h - 0.28, w: mw, h: 0.16 },
        { kind: "line", a: [w * 0.25, h * 0.35], b: [w * 0.75, h * 0.35] },
      ];
    }
    case "chair": {
      const bt = Math.min(0.08, h * 0.25);
      return [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "rect", x: 0, y: h - bt, w, h: bt },
      ];
    }
    case "shelving": {
      const prims: BlockPrim[] = [{ kind: "rect", x: 0, y: 0, w, h }];
      for (let i = 1; i <= 3; i++) {
        const y = (i / 4) * h;
        prims.push({ kind: "line", a: [0, y], b: [w, y] });
      }
      prims.push({ kind: "line", a: [0, 0], b: [w, h] });
      prims.push({ kind: "line", a: [0, h], b: [w, 0] });
      return prims;
    }
    case "stairs": {
      const prims: BlockPrim[] = [{ kind: "rect", x: 0, y: 0, w, h }];
      const n = Math.max(3, Math.round(h / 0.28));
      for (let i = 1; i < n; i++) {
        const y = (i / n) * h;
        prims.push({ kind: "line", a: [0, y], b: [w, y] });
      }
      const cx = w / 2;
      prims.push({ kind: "line", a: [cx, h * 0.12], b: [cx, h * 0.88] });
      prims.push({ kind: "line", a: [cx - w * 0.12, h * 0.76], b: [cx, h * 0.88] });
      prims.push({ kind: "line", a: [cx + w * 0.12, h * 0.76], b: [cx, h * 0.88] });
      return prims;
    }
    case "plant":
      return [
        { kind: "circle", cx: w / 2, cy: h / 2, r: Math.min(w, h) / 2 },
        { kind: "circle", cx: w / 2, cy: h / 2, r: Math.min(w, h) * 0.3 },
      ];
    case "server_rack": {
      const prims: BlockPrim[] = [{ kind: "rect", x: 0, y: 0, w, h }];
      for (let i = 1; i <= 3; i++) {
        const y = (i / 4) * h;
        prims.push({ kind: "line", a: [w * 0.1, y], b: [w * 0.9, y], dash: "4 3" });
        prims.push({ kind: "circle", cx: w * 0.82, cy: y + h * 0.08, r: 0.02, filled: true });
      }
      return prims;
    }
    case "appliance":
      return [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "circle", cx: w / 2, cy: h / 2, r: Math.min(w, h) * 0.32 },
      ];
    default:
      return [
        { kind: "rect", x: 0, y: 0, w, h },
        { kind: "line", a: [0, 0], b: [w, h] },
        { kind: "line", a: [0, h], b: [w, 0] },
      ];
  }
}

/** Axis-aligned extent of a block (used for tag-collision obstacles). */
export function blockExtents(prims: BlockPrim[]): RectBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of prims) {
    if (p.kind === "rect") {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
    } else if (p.kind === "line") {
      minX = Math.min(minX, p.a[0], p.b[0]); maxX = Math.max(maxX, p.a[0], p.b[0]);
      minY = Math.min(minY, p.a[1], p.b[1]); maxY = Math.max(maxY, p.a[1], p.b[1]);
    } else if (p.kind === "circle") {
      minX = Math.min(minX, p.cx - p.r); maxX = Math.max(maxX, p.cx + p.r);
      minY = Math.min(minY, p.cy - p.r); maxY = Math.max(maxY, p.cy + p.r);
    } else {
      minX = Math.min(minX, p.cx - p.r); maxX = Math.max(maxX, p.cx + p.r);
      minY = Math.min(minY, p.cy - p.r); maxY = Math.max(maxY, p.cy + p.r);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ── dimension chains, grid axes, room tags ─────────────────────────────── */

/** 45° slash ticks centered on both dimension endpoints (AutoCAD practice). */
export function dimensionDecor(from: Pt, to: Pt, tickLen: number): BlockPrim[] {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const rx = (ux - uy) * Math.SQRT1_2;
  const ry = (ux + uy) * Math.SQRT1_2;
  const half = tickLen / 2;
  return [
    { kind: "line", a: [from[0] - rx * half, from[1] - ry * half], b: [from[0] + rx * half, from[1] + ry * half] },
    { kind: "line", a: [to[0] - rx * half, to[1] - ry * half], b: [to[0] + rx * half, to[1] + ry * half] },
  ];
}

export interface GridLine { a: Pt; b: Pt }
export interface GridBubble { x: number; y: number; label: string }

export function gridAxes(
  columns: { label: string; position: number }[],
  rows: { label: string; position: number }[],
  bbox: RectBox,
  pad: number,
): { lines: GridLine[]; bubbles: GridBubble[] } {
  const lines: GridLine[] = [];
  const bubbles: GridBubble[] = [];
  const x0 = bbox.x - pad, x1 = bbox.x + bbox.w + pad;
  const y0 = bbox.y - pad, y1 = bbox.y + bbox.h + pad;
  for (const c of columns) {
    lines.push({ a: [c.position, y0], b: [c.position, y1] });
    bubbles.push({ x: c.position, y: y0 - pad * 0.6, label: c.label });
    bubbles.push({ x: c.position, y: y1 + pad * 0.6, label: c.label });
  }
  for (const r of rows) {
    lines.push({ a: [x0, r.position], b: [x1, r.position] });
    bubbles.push({ x: x0 - pad * 0.6, y: r.position, label: r.label });
    bubbles.push({ x: x1 + pad * 0.6, y: r.position, label: r.label });
  }
  return { lines, bubbles };
}

export interface RoomTagSeed { x: number; y: number; name: string; area: number; dx: number; dy: number }
export interface PlacedTag { cx: number; cy: number; w: number; h: number; name: string; sub: string }

function overlaps(a: RectBox, b: RectBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Collision-checked room tag pills: each tag is nudged off walls / furniture /
 * other tags by concentric offset rings until its bounding box is clear.
 */
export function layoutRoomTags(seeds: RoomTagSeed[], obstacles: RectBox[], pxPerModel: number): PlacedTag[] {
  const placed: PlacedTag[] = [];
  const boxes = [...obstacles];
  for (const seed of seeds) {
    const name = seed.name.toUpperCase();
    const sub = `${seed.area.toFixed(1)} m² · ${seed.dx.toFixed(1)}×${seed.dy.toFixed(1)}m`;
    const textW = Math.max(name.length * 9 * 0.62, sub.length * 8 * 0.6) + 16;
    const w = textW / Math.max(1, pxPerModel);
    const h = 26 / Math.max(1, pxPerModel);
    const step = h * 1.15;
    const tries: [number, number][] = [[0, 0]];
    for (let ring = 1; ring <= 3; ring++) {
      for (const [ox, oy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        tries.push([ox * step * ring, oy * step * ring]);
      }
    }
    let best: [number, number] = [0, 0];
    for (const [ox, oy] of tries) {
      const box: RectBox = { x: seed.x + ox - w / 2, y: seed.y + oy - h / 2, w, h };
      if (!boxes.some((b) => overlaps(box, b))) { best = [ox, oy]; break; }
    }
    boxes.push({ x: seed.x + best[0] - w / 2, y: seed.y + best[1] - h / 2, w, h });
    placed.push({ cx: seed.x + best[0], cy: seed.y + best[1], w, h, name, sub });
  }
  return placed;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
