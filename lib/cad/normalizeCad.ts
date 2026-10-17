import { CAD_BUDGETS, type CadSpec } from "./cadSchema";
import { normHex } from "../three3d/normalizeScene";

/**
 * Fault-tolerant ```cad normalizer.
 *
 * The strict cadSchema gate produced errors like `entities.12.content:
 * Required (+115 more)` because local models emit `text`/`label` instead of
 * `content`, forget `layer`, use `width`/`height` instead of `w`/`h`, or drop
 * a stray empty key (`{"kind":"circle","":"layer-dimensions",...}`). This
 * module repairs every entity it can and SKIPS the ones it cannot, so a
 * single malformed entity never kills the whole drawing. There is deliberately
 * no zod safety net here: normalized text entities carry a `text` mirror the
 * strict schema would reject, so correctness is guaranteed by construction —
 * only the 7 known entity kinds with legal shapes are ever emitted.
 */

export interface CadNormalizeOk { ok: true; spec: CadSpec; warnings: string[] }
export interface CadNormalizeFail { ok: false; error: string }
export type CadNormalizeResult = CadNormalizeOk | CadNormalizeFail;

/** Fallback palette matching the architecture output contract's layer ids. */
const DEFAULT_LAYERS: Record<string, { name: string; color: string }> = {
  "layer-structural": { name: "Structural", color: "#F87171" },
  "layer-architectural": { name: "Architectural", color: "#38BDF8" },
  "layer-furniture": { name: "Furniture", color: "#34D399" },
  "layer-mep": { name: "MEP", color: "#FBBF24" },
  "layer-dimensions": { name: "Dimensions", color: "#94A3B8" },
  "layer-annotations": { name: "Annotations", color: "#C084FC" },
  "layer-flow": { name: "Flow", color: "#22D3EE" },
};
const FALLBACK_LAYER = "layer-architectural";

const KIND_ALIASES: Record<string, string> = {
  rectangle: "rect", box: "rect",
  label: "text", note: "text", annotation: "text", dimension_text: "text",
  polyline2d: "polyline", path: "polyline",
  closed_polyline: "polygon", area: "polygon",
  dot: "circle", point_circle: "circle",
  arc_line: "arc",
  wall_line: "line",
};

const num = (v: unknown, def: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : def;
const numOpt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function sanitizeId(raw: unknown, prefix: string, used: Set<string>, warnings: string[]): string {
  let base = (str(raw) ?? "").replace(/\s+/g, "-").slice(0, 40);
  if (!base) base = `${prefix}-${used.size + 1}`;
  let id = base;
  if (used.has(id)) {
    let k = 2;
    while (used.has(`${base}-${k}`)) k += 1;
    id = `${base}-${k}`;
    warnings.push(`duplicate id "${base}" renamed to "${id}"`);
  }
  used.add(id);
  return id;
}

/** [[x,y],...] or [{x,y},...] -> finite tuples. */
function toPoints(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const p of v) {
    if (Array.isArray(p) && p.length >= 2) {
      const x = numOpt(p[0]);
      const y = numOpt(p[1]);
      if (x != null && y != null) out.push([x, y]);
    } else if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const x = numOpt(o.x);
      const y = numOpt(o.y);
      if (x != null && y != null) out.push([x, y]);
    }
  }
  return out;
}

/**
 * Resolve an entity's layer: explicit layer/layerId, then the stray empty-key
 * value (the `{"kind":"circle","":"layer-dimensions"}` typo), then default.
 */
function pickLayer(e: Record<string, unknown>, warnings: string[]): string {
  const candidates = [e.layer, e.layerId, (e as Record<string, unknown>)[""]];
  for (const c of candidates) {
    const s = str(c);
    if (s) return s.slice(0, 40);
  }
  if (e.layer != null || e.layerId != null) warnings.push("entity had a non-string layer — defaulted");
  return FALLBACK_LAYER;
}

/** One of the 7 schema entity kinds, or null when beyond repair. */
function normalizeEntity(raw: unknown, warnings: string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("skipped non-object entity");
    return null;
  }
  const e = raw as Record<string, unknown>;
  const layer = pickLayer(e, warnings);
  const kindRaw = String(e.kind ?? e.type ?? "").trim().toLowerCase();
  const kind = KIND_ALIASES[kindRaw] ?? kindRaw;

  switch (kind) {
    case "line": {
      const pts = lineEnds(e);
      if (!pts) { warnings.push("line entity without usable endpoints — skipped"); return null; }
      return { kind: "line", layer, from: pts[0], to: pts[1] };
    }
    case "rect": {
      const x = numOpt(e.x);
      const y = numOpt(e.y);
      const w = Math.abs(numOpt(e.w ?? e.width) ?? 1);
      const h = Math.abs(numOpt(e.h ?? e.height) ?? 1);
      if (x == null || y == null) { warnings.push("rect entity without x/y — skipped"); return null; }
      return { kind: "rect", layer, x, y, w: Math.max(w, 0.001), h: Math.max(h, 0.001), filled: e.filled === true };
    }
    case "polyline": {
      const points = toPoints(e.points).slice(0, CAD_BUDGETS.maxPointsPerEntity);
      if (points.length < 2) { warnings.push("polyline with <2 usable points — skipped"); return null; }
      return { kind: "polyline", layer, points, closed: e.closed === true };
    }
    case "polygon": {
      const points = toPoints(e.points).slice(0, CAD_BUDGETS.maxPointsPerEntity);
      if (points.length < 3) { warnings.push("polygon with <3 usable points — skipped"); return null; }
      return { kind: "polygon", layer, points };
    }
    case "circle": {
      const cx = numOpt(e.cx ?? e.x);
      const cy = numOpt(e.cy ?? e.y);
      const r = Math.abs(numOpt(e.r ?? e.radius) ?? 0.25);
      if (cx == null || cy == null) { warnings.push("circle without a center — skipped"); return null; }
      return { kind: "circle", layer, cx, cy, r: Math.max(r, 0.001), filled: e.filled === true };
    }
    case "arc": {
      const cx = numOpt(e.cx ?? e.x);
      const cy = numOpt(e.cy ?? e.y);
      const r = Math.abs(numOpt(e.r ?? e.radius) ?? 0.5);
      if (cx == null || cy == null) { warnings.push("arc without a center — skipped"); return null; }
      return {
        kind: "arc", layer, cx, cy, r: Math.max(r, 0.001),
        startDeg: num(e.startDeg ?? e.startAngle, 0),
        endDeg: num(e.endDeg ?? e.endAngle, 90),
      };
    }
    case "text": {
      const x = numOpt(e.x);
      const y = numOpt(e.y);
      if (x == null || y == null) { warnings.push("text entity without x/y — skipped"); return null; }
      const content = (str(e.content) ?? str(e.text) ?? str(e.label) ?? str(e.title) ?? "").slice(0, 200);
      const anchor = e.anchor === "middle" || e.anchor === "end" ? e.anchor : "start";
      // `text` mirror keeps both spellings defined for every consumer.
      return {
        kind: "text", layer, x, y, content, text: content,
        height: clamp(num(e.height, 0.25), 0.001, 10),
        rotation: num(e.rotation, 0),
        anchor,
      };
    }
    default:
      return inferEntity(e, layer, warnings);
  }
}

/** line endpoints: {from,to} tuples/objects OR x1/y1/x2/y2. */
function lineEnds(e: Record<string, unknown>): [[number, number], [number, number]] | null {
  const pts = toPoints([e.from, e.to]);
  if (pts.length === 2) return [pts[0], pts[1]];
  const x1 = numOpt(e.x1 ?? e.xa);
  const y1 = numOpt(e.y1 ?? e.ya);
  const x2 = numOpt(e.x2 ?? e.xb);
  const y2 = numOpt(e.y2 ?? e.yb);
  if (x1 != null && y1 != null && x2 != null && y2 != null) return [[x1, y1], [x2, y2]];
  return null;
}

/** Unknown/missing kind: guess the shape from the fields that ARE present. */
function inferEntity(e: Record<string, unknown>, layer: string, warnings: string[]): Record<string, unknown> | null {
  const line = lineEnds(e);
  if (line) return { kind: "line", layer, from: line[0], to: line[1] };
  const points = toPoints(e.points);
  if (points.length >= 3) return { kind: "polygon", layer, points: points.slice(0, CAD_BUDGETS.maxPointsPerEntity) };
  if (points.length === 2) return { kind: "polyline", layer, points, closed: e.closed === true };
  const cx = numOpt(e.cx ?? e.x);
  const cy = numOpt(e.cy ?? e.y);
  const r = numOpt(e.r ?? e.radius);
  if (cx != null && cy != null && r != null) {
    return { kind: "circle", layer, cx, cy, r: Math.max(Math.abs(r), 0.001), filled: e.filled === true };
  }
  const w = numOpt(e.w ?? e.width);
  const h = numOpt(e.h ?? e.height);
  if (cx != null && cy != null && w != null && h != null) {
    return { kind: "rect", layer, x: cx, y: cy, w: Math.max(Math.abs(w), 0.001), h: Math.max(Math.abs(h), 0.001), filled: e.filled === true };
  }
  const content = str(e.content) ?? str(e.text) ?? str(e.label) ?? str(e.title);
  if (content && cx != null && cy != null) {
    return { kind: "text", layer, x: cx, y: cy, content: content.slice(0, 200), text: content.slice(0, 200), height: clamp(num(e.height, 0.25), 0.001, 10), rotation: 0, anchor: "start" };
  }
  warnings.push(`unrecognizable entity (kind: "${e.kind ?? "?"}") — skipped`);
  return null;
}

function normalizeRoomEntities(room: unknown, warnings: string[]): Record<string, unknown>[] {
  if (!room || typeof room !== "object" || Array.isArray(room)) return [];
  const rm = room as Record<string, unknown>;
  const name = str(rm.name ?? rm.label ?? rm.title ?? rm.roomType ?? rm.type) ?? "Room";
  const outline = toPoints(rm.outline ?? rm.points ?? rm.polygon ?? rm.path);
  const x = numOpt(rm.x);
  const y = numOpt(rm.y);
  const w = numOpt(rm.w ?? rm.width);
  const h = numOpt(rm.h ?? rm.height);
  const out: Record<string, unknown>[] = [];
  if (outline.length >= 3) {
    out.push({ kind: "polygon", layer: FALLBACK_LAYER, points: outline.slice(0, CAD_BUDGETS.maxPointsPerEntity) });
    const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length;
    const cy = outline.reduce((s, p) => s + p[1], 0) / outline.length;
    out.push({ kind: "text", layer: "layer-annotations", x: cx, y: cy, content: name, text: name, height: 0.3, rotation: 0, anchor: "middle" });
  } else if (x != null && y != null && w != null && h != null) {
    out.push({ kind: "rect", layer: FALLBACK_LAYER, x, y, w: Math.max(Math.abs(w), 0.001), h: Math.max(Math.abs(h), 0.001), filled: true });
    out.push({ kind: "text", layer: "layer-annotations", x: x + w / 2, y: y + h / 2, content: name, text: name, height: 0.3, rotation: 0, anchor: "middle" });
  } else {
    warnings.push(`room "${name}" has no usable outline — skipped`);
  }
  return out;
}

function normalizeWall(raw: unknown, idx: number, used: Set<string>, warnings: string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;
  const path = toPoints(w.path ?? w.points).slice(0, 200);
  if (path.length < 2) { warnings.push(`wall #${idx} without a usable path — skipped`); return null; }
  const out: Record<string, unknown> = {
    id: sanitizeId(w.id ?? w.name, "wall", used, warnings),
    layer: pickLayer(w, warnings),
    path,
    height: clamp(num(w.height, 3), 0.001, 50),
    thickness: clamp(num(w.thickness ?? w.t, 0.2), 0.001, 5),
    z: num(w.z, 0),
    closed: w.closed === true,
  };
  const label = str(w.label ?? w.name);
  if (label) out.label = label.slice(0, 60);
  return out;
}

function normalizeSlab(raw: unknown, idx: number, used: Set<string>, warnings: string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const outline = toPoints(s.outline ?? s.points).slice(0, 200);
  if (outline.length < 3) { warnings.push(`slab #${idx} without a usable outline — skipped`); return null; }
  const out: Record<string, unknown> = {
    id: sanitizeId(s.id ?? s.name, "slab", used, warnings),
    layer: pickLayer(s, warnings),
    outline,
    z: num(s.z, 0),
    thickness: clamp(num(s.thickness ?? s.t, 0.2), 0.001, 2),
  };
  const label = str(s.label ?? s.name);
  if (label) out.label = label.slice(0, 60);
  return out;
}

function normalizeFloor(raw: unknown, idx: number, used: Set<string>): Record<string, unknown> {
  if (typeof raw === "string" && raw.trim()) {
    return { id: sanitizeId(raw, "floor", used, []), label: raw.trim().slice(0, 60), z: 0 };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const f = raw as Record<string, unknown>;
    const id = sanitizeId(f.id ?? f.name, "floor", used, []);
    return { id, label: (str(f.label ?? f.name) ?? id).slice(0, 60), z: num(f.z, 0) };
  }
  return { id: `floor-${idx + 1}`, label: `Level ${idx + 1}`, z: 0 };
}

function normalizeHotspot(raw: unknown, idx: number, used: Set<string>, warnings: string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  const x = numOpt(h.x);
  const y = numOpt(h.y);
  if (x == null || y == null) { warnings.push(`hotspot #${idx} without x/y — skipped`); return null; }
  const out: Record<string, unknown> = {
    id: sanitizeId(h.id ?? h.tag, "hotspot", used, warnings),
    x, y,
    title: (str(h.title ?? h.name ?? h.label) ?? "Hotspot").slice(0, 80),
    layer: pickLayer(h, warnings),
  };
  for (const key of ["role", "material", "dims", "note"] as const) {
    const v = str(h[key]);
    if (v) out[key] = v.slice(0, 200);
  }
  return out;
}

function normalizeFlow(raw: unknown, idx: number, used: Set<string>, warnings: string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  const points = toPoints(f.points).slice(0, 100);
  if (points.length < 2) { warnings.push(`flow #${idx} without a usable path — skipped`); return null; }
  const out: Record<string, unknown> = {
    id: sanitizeId(f.id ?? f.name, "flow", used, warnings),
    points,
    color: normHex(f.color) ?? "#34D399",
    speed: clamp(num(f.speed, 1), 0.1, 5),
    z: num(f.z, 0),
  };
  const label = str(f.label ?? f.name);
  if (label) out.label = label.slice(0, 60);
  return out;
}

/**
 * Parse + repair a ```cad fence body. Never throws. The gate is intentionally
 * loose: any object carrying one of the CAD arrays is enough to try.
 */
export function normalizeCad(source: string): CadNormalizeResult {
  let root: unknown;
  try {
    root = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: `invalid JSON — ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { ok: false, error: "CAD JSON must be an object" };
  }
  const r = root as Record<string, unknown>;
  const hasAny = ["entities", "walls", "layers", "rooms", "slabs", "floors", "hotspots", "flows"].some(k => Array.isArray(r[k]));
  if (!hasAny) {
    return { ok: false, error: "CAD JSON has none of the entities/walls/layers/rooms/slabs/floors arrays" };
  }

  const warnings: string[] = [];
  const layerMap = new Map<string, Record<string, unknown>>();
  const layerIdUsed = new Set<string>();

  const registerLayer = (raw: unknown): string | null => {
    if (typeof raw === "string") {
      const id = raw.trim().slice(0, 40);
      if (!id) return null;
      if (!layerMap.has(id)) layerMap.set(id, { id, name: DEFAULT_LAYERS[id]?.name ?? id, color: DEFAULT_LAYERS[id]?.color ?? "#38BDF8" });
      return id;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const l = raw as Record<string, unknown>;
    const id = sanitizeId(l.id ?? l.name, "layer", layerIdUsed, warnings);
    if (!layerMap.has(id)) {
      layerMap.set(id, {
        id,
        name: (str(l.name) ?? DEFAULT_LAYERS[id]?.name ?? id).slice(0, 60),
        color: normHex(l.color) ?? DEFAULT_LAYERS[id]?.color ?? "#38BDF8",
        ...(l.lineType === "dashed" || l.lineType === "dotted" || l.lineType === "solid" ? { lineType: l.lineType } : {}),
        ...(typeof l.opacity === "number" && Number.isFinite(l.opacity) ? { opacity: clamp(l.opacity, 0.05, 1) } : {}),
        ...(typeof l.locked === "boolean" ? { locked: l.locked } : {}),
        ...(typeof l.visible === "boolean" ? { visible: l.visible } : {}),
      });
    }
    return id;
  };

  (Array.isArray(r.layers) ? r.layers : []).slice(0, CAD_BUDGETS.maxLayers).forEach(registerLayer);

  // Any layer referenced but never declared gets auto-created with defaults.
  const referenced = new Set<string>();
  const noteRef = (v: unknown) => {
    const s = str(v ?? (v as Record<string, unknown> | undefined)?.[""]);
    if (s) referenced.add(s.slice(0, 40));
  };

  const entities: Record<string, unknown>[] = [];
  const rawEntities = Array.isArray(r.entities) ? r.entities : [];
  for (const e of rawEntities) {
    const ne = normalizeEntity(e, warnings);
    if (ne) {
      entities.push(ne);
      referenced.add(String(ne.layer));
    }
  }
  for (const room of Array.isArray(r.rooms) ? r.rooms : []) {
    for (const ne of normalizeRoomEntities(room, warnings)) {
      entities.push(ne);
      referenced.add(String(ne.layer));
    }
  }
  if (entities.length > CAD_BUDGETS.maxEntities) {
    warnings.push(`entities trimmed to ${CAD_BUDGETS.maxEntities} (was ${entities.length})`);
    entities.length = CAD_BUDGETS.maxEntities;
  }

  const walls = (Array.isArray(r.walls) ? r.walls : []).slice(0, CAD_BUDGETS.maxWalls)
    .map((w, i) => normalizeWall(w, i, new Set<string>(), warnings))
    .filter((w): w is Record<string, unknown> => !!w);
  walls.forEach(w => referenced.add(String(w.layer)));

  const slabs = (Array.isArray(r.slabs) ? r.slabs : []).slice(0, CAD_BUDGETS.maxSlabs)
    .map((s, i) => normalizeSlab(s, i, new Set<string>(), warnings))
    .filter((s): s is Record<string, unknown> => !!s);
  slabs.forEach(s => referenced.add(String(s.layer)));

  const floorIds = new Set<string>();
  const floors = (Array.isArray(r.floors) ? r.floors : []).slice(0, CAD_BUDGETS.maxFloors)
    .map((f, i) => normalizeFloor(f, i, floorIds));

  const hotspotIds = new Set<string>();
  const hotspots = (Array.isArray(r.hotspots) ? r.hotspots : []).slice(0, CAD_BUDGETS.maxHotspots)
    .map((h, i) => normalizeHotspot(h, i, hotspotIds, warnings))
    .filter((h): h is Record<string, unknown> => !!h);
  hotspots.forEach(h => referenced.add(String(h.layer)));

  const flowIds = new Set<string>();
  const flows = (Array.isArray(r.flows) ? r.flows : []).slice(0, CAD_BUDGETS.maxFlows)
    .map((f, i) => normalizeFlow(f, i, flowIds, warnings))
    .filter((f): f is Record<string, unknown> => !!f);

  referenced.forEach(id => {
    if (!layerMap.has(id)) {
      registerLayer(id);
      warnings.push(`layer "${id}" referenced but never declared — auto-created with defaults`);
    }
  });
  void noteRef; // reference collector kept for shape parity with schema checks

  const layers = [...layerMap.values()].slice(0, CAD_BUDGETS.maxLayers);
  if (layers.length === 0) {
    Object.keys(DEFAULT_LAYERS).forEach(id => registerLayer(id));
    warnings.push("no layers present — seeded the standard architecture layer set");
  }

  const spec: Record<string, unknown> = {
    title: (str(r.title) ?? "CAD drawing").slice(0, 120),
    units: str(r.units) === "ft" ? "ft" : "m",
    layers: layers.length ? layers : [...layerMap.values()],
    entities,
    walls,
    slabs,
    floors,
    hotspots,
    flows,
    defaultView: r.defaultView === "3d" || r.defaultView === "isometric" || r.defaultView === "iso" ? (r.defaultView === "iso" ? "isometric" : r.defaultView) : "2d",
  };

  if (r.scale && typeof r.scale === "object" && !Array.isArray(r.scale)) {
    const ratio = numOpt((r.scale as Record<string, unknown>).ratio);
    if (ratio != null) spec.scale = { ratio: clamp(ratio, 1, 10000) };
  }
  if (r.titleBlock && typeof r.titleBlock === "object" && !Array.isArray(r.titleBlock)) {
    const tb = r.titleBlock as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of ["projectName", "sheetTitle", "scaleLabel", "date", "author", "sheetNumber", "legendNote"]) {
      const v = str(tb[key]);
      if (v) out[key] = v.slice(0, 120);
    }
    if (Object.keys(out).length) spec.titleBlock = out;
  }
  if (r.sun && typeof r.sun === "object" && !Array.isArray(r.sun)) {
    const s = r.sun as Record<string, unknown>;
    spec.sun = { enabled: s.enabled !== false, time: clamp(num(s.time, 13), 0, 24) };
  }
  if (r.export && typeof r.export === "object" && !Array.isArray(r.export)) {
    const slug = String((r.export as Record<string, unknown>).filename ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 60);
    if (/^[a-z0-9][a-z0-9-]*$/.test(slug)) spec.export = { filename: slug };
  }

  return { ok: true, spec: spec as unknown as CadSpec, warnings };
}
