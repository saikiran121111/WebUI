import {
  SCENE_BUDGETS,
  scene3dSpecSchema,
  type Scene3DGeometry,
  type Scene3DMaterial,
  type Scene3DNode,
  type Scene3DSpec,
} from "./sceneSchema";

/**
 * Fault-tolerant ```scene3d normalizer.
 *
 * The strict schema is a contract, not a gate. Local models drift constantly —
 * segment counts out of range, animations pointing at parts that were never
 * emitted, aliases like "cube", geometry fields sitting on the node itself.
 * This module repairs ANY JSON object that carries an objects/meshes/nodes
 * array into a schema-legal spec so the studio viewer always mounts. Only
 * truly unusable input (bad JSON, no object array) fails, and then the UI
 * offers the "Fix with AI" path instead of a dead "did not validate" wall.
 */

export interface SceneNormalizeOk { ok: true; spec: Scene3DSpec; warnings: string[] }
export interface SceneNormalizeFail { ok: false; error: string }
export type SceneNormalizeResult = SceneNormalizeOk | SceneNormalizeFail;

const KNOWN_PRESETS = new Set(["studio", "dramatic", "blueprint", "space"]);

/** Lowercased model kind spellings -> canonical schema kind. */
const CANON_KINDS: Record<string, string> = {
  sphere: "sphere", ball: "sphere", orb: "sphere",
  box: "box", cube: "box", rectangular: "box",
  torus: "torus",
  torusknot: "torusKnot", knot: "torusKnot",
  cylinder: "cylinder",
  cone: "cone", pyramid: "cone",
  plane: "plane", quad: "plane",
  ring: "ring", annulus: "ring", disc: "ring",
  capsule: "capsule",
  icosahedron: "icosahedron", ico: "icosahedron",
  octahedron: "octahedron", dodecahedron: "dodecahedron", tetrahedron: "tetrahedron",
  group: "group", empty: "group", container: "group",
  lathe: "lathe", profile: "lathe",
  extrude: "extrude",
  tube: "tube", pipe: "tube",
  grid: "grid", arrow: "arrow",
};

const SLIDER_BINDINGS = new Set([
  "rotation", "position", "scale",
  "material.emissiveIntensity", "material.roughness", "material.metalness", "material.opacity",
]);
const MATERIAL_KEYS: Record<string, string> = {
  emissiveintensity: "material.emissiveIntensity",
  roughness: "material.roughness",
  metalness: "material.metalness",
  opacity: "material.opacity",
};

const num = (v: unknown, def: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : def;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const intClamp = (v: unknown, def: number, lo: number, hi: number) =>
  Math.round(clamp(num(v, def), lo, hi));

const HEX6 = /^#[0-9a-fA-F]{6}$/;
export function normHex(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (HEX6.test(t)) return t;
  if (/^#[0-9a-fA-F]{3}$/.test(t)) return "#" + [...t.slice(1)].map(c => c + c).join("");
  return undefined;
}

function normVec3(v: unknown): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const [x, y, z] = v;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
  return [x, y, z];
}

/** [[x,y],...] or [{x,y},...] -> finite pairs. */
function normPairs(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const p of v) {
    if (Array.isArray(p) && p.length >= 2) {
      const [x, y] = p;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
    } else if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const x = o.x ?? o.r;
      const y = o.y ?? o.z;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
    }
  }
  return out;
}

/** id -> schema-legal `^[a-zA-Z][a-zA-Z0-9_-]*$` (max 40), deduped via ctx. */
function normId(raw: unknown, prefix: string, used: Set<string>, warnings: string[]): string {
  let base = String(raw ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^[^a-zA-Z]+/, "");
  if (!base) base = `${prefix}_${used.size + 1}`;
  base = base.slice(0, 40);
  let id = base;
  if (used.has(id)) {
    let k = 2;
    while (used.has(`${base}_${k}`)) k += 1;
    id = `${base}_${k}`;
    warnings.push(`duplicate id "${base}" renamed to "${id}"`);
  }
  used.add(id);
  return id;
}

const signedScaleClamp = (v: number) => {
  const a = clamp(Math.abs(v), 0.001, 100);
  return v < 0 ? -a : a;
};

function normScale(v: unknown): [number, number, number] | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    const s = signedScaleClamp(v);
    return [s, s, s];
  }
  const vec = normVec3(v);
  if (!vec) return undefined;
  return [signedScaleClamp(vec[0]), signedScaleClamp(vec[1]), signedScaleClamp(vec[2])];
}

const DEFAULT_BOX: Scene3DGeometry = { kind: "box", width: 1, height: 1, depth: 1 };

function normalizeGeometry(raw: unknown, warnings: string[]): Scene3DGeometry {
  const g = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const rawKind = String(g.kind ?? g.type ?? "").trim();
  const kind = CANON_KINDS[rawKind.toLowerCase()];
  if (!kind) {
    if (rawKind) warnings.push(`unknown geometry kind "${rawKind}" → box`);
    return { ...DEFAULT_BOX };
  }
  switch (kind) {
    case "box": {
      const size = num(g.size, NaN);
      return {
        kind: "box",
        width: clamp(num(g.width, Number.isFinite(size) ? size : 1), 0.001, 100),
        height: clamp(num(g.height, Number.isFinite(size) ? size : 1), 0.001, 100),
        depth: clamp(num(g.depth, Number.isFinite(size) ? size : 1), 0.001, 100),
      };
    }
    case "sphere":
      return {
        kind: "sphere",
        radius: clamp(num(g.radius, 1), 0.001, 50),
        widthSegments: intClamp(g.widthSegments, 32, 3, 64),
        heightSegments: intClamp(g.heightSegments, 32, 2, 64),
      };
    case "cylinder":
      return {
        kind: "cylinder",
        radiusTop: clamp(num(g.radiusTop ?? g.radius, 1), 0, 50),
        radiusBottom: clamp(num(g.radiusBottom ?? g.radius, 1), 0, 50),
        height: clamp(num(g.height, 1), 0.001, 100),
        radialSegments: intClamp(g.radialSegments, 24, 3, 64),
        ...(typeof g.openEnded === "boolean" ? { openEnded: g.openEnded } : {}),
      };
    case "cone":
      return {
        kind: "cone",
        radius: clamp(num(g.radius, 1), 0.001, 50),
        height: clamp(num(g.height, 1), 0.001, 100),
        radialSegments: intClamp(g.radialSegments, 24, 3, 64),
      };
    case "torus":
      return {
        kind: "torus",
        radius: clamp(num(g.radius, 1), 0.001, 50),
        tube: clamp(num(g.tube, 0.1), 0.001, 20),
        radialSegments: intClamp(g.radialSegments, 16, 3, 32),
        tubularSegments: intClamp(g.tubularSegments, 64, 3, 128),
      };
    case "torusKnot":
      return {
        kind: "torusKnot",
        radius: clamp(num(g.radius, 1), 0.001, 50),
        tube: clamp(num(g.tube, 0.1), 0.001, 20),
        radialSegments: intClamp(g.radialSegments, 16, 3, 64),
        tubularSegments: intClamp(g.tubularSegments, 64, 3, 256),
        p: intClamp(g.p, 2, 1, 12),
        q: intClamp(g.q, 3, 1, 12),
      };
    case "capsule":
      return {
        kind: "capsule",
        radius: clamp(num(g.radius, 0.5), 0.001, 50),
        length: clamp(num(g.length, 1), 0.001, 100),
        capSegments: intClamp(g.capSegments, 8, 1, 16),
        radialSegments: intClamp(g.radialSegments, 16, 3, 64),
      };
    case "plane":
      return { kind: "plane", width: clamp(num(g.width, 1), 0.001, 100), height: clamp(num(g.height, 1), 0.001, 100) };
    case "ring":
      return {
        kind: "ring",
        innerRadius: clamp(num(g.innerRadius ?? g.inner, 0.5), 0, 50),
        outerRadius: clamp(num(g.outerRadius ?? g.outer ?? g.radius, 1), 0.001, 50),
        thetaSegments: intClamp(g.thetaSegments, 32, 3, 128),
        phiSegments: intClamp(g.phiSegments, 1, 1, 16),
      };
    case "icosahedron":
      return { kind: "icosahedron", radius: clamp(num(g.radius, 1), 0.001, 50), detail: intClamp(g.detail, 0, 0, 4) };
    case "octahedron":
      return { kind: "octahedron", radius: clamp(num(g.radius, 1), 0.001, 50), detail: intClamp(g.detail, 0, 0, 4) };
    case "dodecahedron":
      return { kind: "dodecahedron", radius: clamp(num(g.radius, 1), 0.001, 50), detail: intClamp(g.detail, 0, 0, 4) };
    case "tetrahedron":
      return { kind: "tetrahedron", radius: clamp(num(g.radius, 1), 0.001, 50), detail: intClamp(g.detail, 0, 0, 4) };
    case "group":
      return { kind: "group" };
    case "grid":
      return { kind: "grid", size: clamp(num(g.size, 10), 0.5, 100), divisions: intClamp(g.divisions, 10, 1, 100) };
    case "arrow":
      return {
        kind: "arrow",
        length: clamp(num(g.length, 1), 0.01, 50),
        shaftRadius: clamp(num(g.shaftRadius, 0.05), 0.001, 5),
        headRadius: clamp(num(g.headRadius, 0.12), 0.001, 5),
        headLength: clamp(num(g.headLength, 0.3), 0.01, 10),
      };
    case "lathe": {
      const points = normPairs(g.points).map(([r, y]) => [clamp(r, 0, 50), y] as [number, number]);
      if (points.length >= 2) return { kind: "lathe", points: points.slice(0, 64), segments: intClamp(g.segments, 24, 3, 64) };
      warnings.push("lathe geometry without valid points → box");
      return { ...DEFAULT_BOX };
    }
    case "extrude": {
      const shape = normPairs(g.shape);
      if (shape.length >= 3) {
        return {
          kind: "extrude",
          shape: shape.slice(0, 40),
          depth: clamp(num(g.depth, 0.2), 0.001, 50),
          ...(typeof g.bevelEnabled === "boolean" ? { bevelEnabled: g.bevelEnabled } : {}),
          bevelSegments: intClamp(g.bevelSegments, 2, 0, 8),
        };
      }
      warnings.push("extrude geometry without a valid shape (need ≥3 points) → box");
      return { ...DEFAULT_BOX };
    }
    case "tube": {
      const path = (Array.isArray(g.path) ? g.path : []).map(normVec3).filter((p): p is [number, number, number] => !!p);
      if (path.length >= 2) {
        return {
          kind: "tube",
          path: path.slice(0, 64),
          radius: clamp(num(g.radius, 0.1), 0.001, 10),
          radialSegments: intClamp(g.radialSegments, 8, 3, 32),
          tubularSegments: intClamp(g.tubularSegments, 24, 3, 128),
          ...(typeof g.closed === "boolean" ? { closed: g.closed } : {}),
        };
      }
      warnings.push("tube geometry without a valid path → box");
      return { ...DEFAULT_BOX };
    }
    default:
      return { ...DEFAULT_BOX };
  }
}

function normalizeMaterial(raw: unknown): Scene3DMaterial | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const color = normHex(m.color);
  if (color) out.color = color;
  if (typeof m.roughness === "number" && Number.isFinite(m.roughness)) out.roughness = clamp(m.roughness, 0, 1);
  if (typeof m.metalness === "number" && Number.isFinite(m.metalness)) out.metalness = clamp(m.metalness, 0, 1);
  const emissive = normHex(m.emissive ?? m.emissiveColor);
  if (emissive) {
    out.emissive = emissive;
    out.emissiveIntensity = clamp(num(m.emissiveIntensity, 1), 0, 5);
  }
  if (typeof m.opacity === "number" && Number.isFinite(m.opacity)) out.opacity = clamp(m.opacity, 0, 1);
  if (typeof m.transparent === "boolean") out.transparent = m.transparent;
  if (typeof m.wireframe === "boolean") out.wireframe = m.wireframe;
  if (typeof m.flatShading === "boolean") out.flatShading = m.flatShading;
  if (m.side === "front" || m.side === "back" || m.side === "double") out.side = m.side;
  return Object.keys(out).length ? (out as Scene3DMaterial) : undefined;
}

interface NodeCtx {
  warnings: string[];
  usedIds: Set<string>;
  nodeCount: number;
}

function normalizeNode(raw: unknown, ctx: NodeCtx, depth: number): Scene3DNode | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    ctx.warnings.push("skipped non-object node");
    return null;
  }
  if (ctx.nodeCount >= SCENE_BUDGETS.maxNodes) {
    ctx.warnings.push(`node budget (${SCENE_BUDGETS.maxNodes}) reached — remaining parts dropped`);
    return null;
  }
  if (depth > SCENE_BUDGETS.maxDepth) {
    ctx.warnings.push(`depth budget (${SCENE_BUDGETS.maxDepth}) exceeded — children dropped`);
    return null;
  }
  const n = raw as Record<string, unknown>;
  const id = normId(n.id ?? n.name, "part", ctx.usedIds, ctx.warnings);
  ctx.nodeCount += 1;

  const node: Scene3DNode = { id };
  const label = typeof n.label === "string" && n.label.trim() ? n.label.trim().slice(0, 80)
    : typeof n.name === "string" && n.name.trim() ? n.name.trim().slice(0, 80) : undefined;
  if (label) node.label = label;

  const childrenKey = Array.isArray(n.children) ? "children" : Array.isArray(n.parts) ? "parts" : Array.isArray(n.meshes) ? "meshes" : null;
  const geoHolder = n.geometry && typeof n.geometry === "object" ? n.geometry : n;
  const hasKind = typeof (geoHolder as Record<string, unknown>).kind === "string" || typeof (geoHolder as Record<string, unknown>).type === "string";
  if (hasKind) node.geometry = normalizeGeometry(geoHolder, ctx.warnings);
  else if (childrenKey) node.geometry = { kind: "group" };
  else node.geometry = normalizeGeometry(geoHolder, ctx.warnings); // box fallback keeps it visible

  const material = normalizeMaterial(n.material);
  if (material) node.material = material;
  const position = normVec3(n.position);
  if (position) node.position = position;
  const rotation = normVec3(n.rotation ?? n.rotate);
  if (rotation) node.rotation = rotation;
  const scale = normScale(n.scale);
  if (scale) node.scale = scale;
  if (n.visible === false) node.visible = false;

  if (childrenKey) {
    const kids = (n[childrenKey] as unknown[]).slice(0, 60)
      .map(c => normalizeNode(c, ctx, depth + 1))
      .filter((c): c is Scene3DNode => !!c);
    if (kids.length) node.children = kids;
  }
  return node;
}

function collectIds(nodes: readonly Scene3DNode[], into: Set<string>): void {
  for (const n of nodes) {
    into.add(n.id);
    if (n.children?.length) collectIds(n.children, into);
  }
}

function normalizeLighting(raw: unknown, warnings: string[]): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const l = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (l.preset != null) {
    const p = String(l.preset);
    if (KNOWN_PRESETS.has(p)) out.preset = p;
    else {
      warnings.push(`unknown lighting preset "${p}" → studio`);
      out.preset = "studio";
    }
  }
  if (typeof l.shadows === "boolean") out.shadows = l.shadows;
  if (typeof l.ambientIntensity === "number" && Number.isFinite(l.ambientIntensity)) out.ambientIntensity = clamp(l.ambientIntensity, 0, 3);
  return Object.keys(out).length ? out : undefined;
}

function normalizeCamera(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const position = normVec3(c.position);
  if (position) out.position = position;
  const target = normVec3(c.target ?? c.lookAt);
  if (target) out.target = target;
  if (typeof c.fov === "number" && Number.isFinite(c.fov)) out.fov = clamp(c.fov, 10, 100);
  return Object.keys(out).length ? out : undefined;
}

function normalizeBinding(raw: unknown, warnings: string[]): string {
  const s = String(raw ?? "").trim();
  if (SLIDER_BINDINGS.has(s)) return s;
  const materialKey = s.toLowerCase().replace(/^material[._]?/, "");
  if (MATERIAL_KEYS[materialKey]) {
    warnings.push(`slider binding "${s}" → ${MATERIAL_KEYS[materialKey]}`);
    return MATERIAL_KEYS[materialKey];
  }
  if (s) warnings.push(`unknown slider binding "${s}" → position`);
  return "position";
}

/**
 * Parse + repair a ```scene3d fence body. Never throws.
 * `warnings` describe every silent repair so they can be surfaced in tests.
 */
export function normalizeScene3d(source: string): SceneNormalizeResult {
  let root: unknown;
  try {
    root = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: `invalid JSON — ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { ok: false, error: "3D scene JSON must be an object" };
  }
  const r = root as Record<string, unknown>;
  const container = r.scene && typeof r.scene === "object" && !Array.isArray(r.scene) ? (r.scene as Record<string, unknown>) : r;
  const objectsRaw =
    [r.objects, r.meshes, r.nodes, r.parts, container.objects, container.meshes, container.nodes].find(Array.isArray) ??
    (Array.isArray(r.scene) ? r.scene : undefined);
  if (!objectsRaw) return { ok: false, error: "3D scene JSON has no objects/meshes/nodes array" };
  if (objectsRaw.length === 0) return { ok: false, error: "3D scene objects array is empty" };

  const warnings: string[] = [];
  if (objectsRaw.length > 40) {
    warnings.push(`top-level object list trimmed to 40 (was ${objectsRaw.length})`);
  }
  const ctx: NodeCtx = { warnings, usedIds: new Set<string>(), nodeCount: 0 };
  const objects = objectsRaw.slice(0, 40)
    .map(o => normalizeNode(o, ctx, 1))
    .filter((o): o is Scene3DNode => !!o);
  if (objects.length === 0) return { ok: false, error: "no valid objects after normalization" };

  const ids = new Set<string>();
  collectIds(objects, ids);

  const spec: Record<string, unknown> = { objects };
  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 120) : undefined;
  if (title) spec.title = title;

  const lighting = normalizeLighting(r.lighting ?? container.lighting, warnings);
  if (lighting) spec.lighting = lighting;
  const camera = normalizeCamera(r.camera ?? container.camera);
  if (camera) spec.camera = camera;

  if (Array.isArray(r.labels)) {
    const labels: Record<string, unknown>[] = [];
    for (const l of r.labels) {
      if (!l || typeof l !== "object") continue;
      const lo = l as Record<string, unknown>;
      const target = String(lo.target ?? lo.id ?? "");
      const text = typeof lo.text === "string" ? lo.text.trim().slice(0, 80) : "";
      if (!ids.has(target) || !text) {
        warnings.push(`label for unknown target "${target}" dropped`);
        continue;
      }
      const entry: Record<string, unknown> = { target, text };
      const offset = normVec3(lo.offset);
      if (offset) entry.offset = offset;
      labels.push(entry);
    }
    if (labels.length > SCENE_BUDGETS.maxLabels) warnings.push(`labels trimmed to ${SCENE_BUDGETS.maxLabels}`);
    if (labels.length) spec.labels = labels.slice(0, SCENE_BUDGETS.maxLabels);
  }

  if (Array.isArray(r.animations)) {
    const animIds = new Set<string>();
    const animations: Record<string, unknown>[] = [];
    for (const a of r.animations) {
      if (!a || typeof a !== "object") continue;
      const ao = a as Record<string, unknown>;
      const target = String(ao.target ?? "");
      if (!ids.has(target)) {
        warnings.push(`animation "${ao.id ?? "?"}" targets unknown id "${target}" — dropped`);
        continue;
      }
      const channel = String(ao.channel ?? "rotation");
      if (channel !== "rotation" && channel !== "position" && channel !== "scale") {
        warnings.push(`animation channel "${channel}" invalid — dropped`);
        continue;
      }
      const axis = ao.axis === "x" || ao.axis === "z" ? ao.axis : "y";
      animations.push({
        id: normId(ao.id, "anim", animIds, warnings),
        target,
        channel,
        axis,
        from: num(ao.from, 0),
        to: num(ao.to, 0),
        duration: clamp(num(ao.duration, 4), 0.05, 120),
        ...(typeof ao.loop === "boolean" ? { loop: ao.loop } : {}),
        ...(typeof ao.yoyo === "boolean" ? { yoyo: ao.yoyo } : {}),
      });
    }
    if (animations.length > SCENE_BUDGETS.maxAnimations) warnings.push(`animations trimmed to ${SCENE_BUDGETS.maxAnimations}`);
    if (animations.length) spec.animations = animations.slice(0, SCENE_BUDGETS.maxAnimations);
  }

  if (Array.isArray(r.sliders)) {
    const sliderIds = new Set<string>();
    const sliders: Record<string, unknown>[] = [];
    for (const s of r.sliders) {
      if (!s || typeof s !== "object") continue;
      const so = s as Record<string, unknown>;
      const target = String(so.target ?? "");
      if (!ids.has(target)) {
        warnings.push(`slider "${so.id ?? "?"}" targets unknown id "${target}" — dropped`);
        continue;
      }
      let min = num(so.min, 0);
      let max = num(so.max, 1);
      if (min >= max) {
        warnings.push(`slider "${so.id ?? "?"}" min >= max — max set to min + 1`);
        max = min + 1;
      }
      const step = Math.abs(num(so.step, 0.01)) || 0.01;
      const defaultValue = clamp(num(so.defaultValue ?? so.value, (min + max) / 2), min, max);
      const axis = so.axis === "x" || so.axis === "z" ? so.axis : "y";
      sliders.push({
        id: normId(so.id, "slider", sliderIds, warnings),
        label: (typeof so.label === "string" && so.label.trim() ? so.label.trim() : "Slider").slice(0, 60),
        min, max, step, defaultValue, target,
        binding: normalizeBinding(so.binding, warnings),
        axis,
      });
    }
    if (sliders.length > SCENE_BUDGETS.maxSliders) warnings.push(`sliders trimmed to ${SCENE_BUDGETS.maxSliders}`);
    if (sliders.length) spec.sliders = sliders.slice(0, SCENE_BUDGETS.maxSliders);
  }

  if (r.interactions && typeof r.interactions === "object" && !Array.isArray(r.interactions)) {
    const i = r.interactions as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of ["orbit", "pan", "select", "hover"]) {
      if (typeof i[key] === "boolean") out[key] = i[key];
    }
    if (Object.keys(out).length) spec.interactions = out;
  }

  if (r.export && typeof r.export === "object" && !Array.isArray(r.export)) {
    const ex = r.export as Record<string, unknown>;
    const slug = String(ex.filename ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const out: Record<string, unknown> = {};
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) out.filename = slug;
    const formats = (Array.isArray(ex.formats) ? ex.formats : [])
      .map(f => String(f).toLowerCase())
      .filter(f => ["glb", "gltf", "obj", "stl", "ply", "usdz"].includes(f))
      .slice(0, 6);
    if (formats.length) out.formats = formats;
    if (Object.keys(out).length) spec.export = out;
  }

  // Safety net: the normalizer only ever emits schema-legal keys, so a failure
  // here means a real bug — surface it instead of silently rendering garbage.
  const parsed = scene3dSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "normalization produced an invalid scene" };
  }
  return { ok: true, spec: parsed.data, warnings };
}
