import { z } from "zod";

/**
 * Scene3D v2 specification: the validated contract between the model and the
 * deterministic three.js builder. Model output is NEVER executed as code —
 * it is parsed against this schema, bounded by hard budgets, and translated
 * into real geometry by lib/three3d/sceneBuilder.ts.
 *
 * The fence contract documented in archive/skills/3d/SKILL.md must stay in sync with
 * this file; the schema is the source of truth.
 */

const finite = z.number().finite();
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const id = z.string().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
const vec3 = z.tuple([finite, finite, finite]);
const scale3 = z.tuple([finite, finite, finite]).refine(
  t => t.every(v => Math.abs(v) >= 0.001 && Math.abs(v) <= 100),
  "scale components must be within [0.001, 100] in magnitude",
);

const seg = (min: number, max: number, def: number) =>
  z.number().int().min(min).max(max).default(def).optional();

/* ── geometry kinds (named params, hard caps) ─────────────────────────── */

const geometrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), width: z.number().min(0.001).max(100), height: z.number().min(0.001).max(100), depth: z.number().min(0.001).max(100) }).strict(),
  z.object({ kind: z.literal("sphere"), radius: z.number().min(0.001).max(50), widthSegments: seg(3, 64, 24), heightSegments: seg(2, 32, 16) }).strict(),
  z.object({ kind: z.literal("cylinder"), radiusTop: z.number().min(0).max(50), radiusBottom: z.number().min(0).max(50), height: z.number().min(0.001).max(100), radialSegments: seg(3, 64, 24), openEnded: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("cone"), radius: z.number().min(0.001).max(50), height: z.number().min(0.001).max(100), radialSegments: seg(3, 64, 24) }).strict(),
  z.object({ kind: z.literal("torus"), radius: z.number().min(0.001).max(50), tube: z.number().min(0.001).max(20), radialSegments: seg(3, 32, 16), tubularSegments: seg(3, 128, 32) }).strict(),
  z.object({ kind: z.literal("capsule"), radius: z.number().min(0.001).max(50), length: z.number().min(0.001).max(100), capSegments: seg(1, 16, 8), radialSegments: seg(3, 64, 16) }).strict(),
  z.object({
    kind: z.literal("lathe"),
    points: z.array(z.tuple([z.number().min(0).max(50), finite])).min(2).max(64),
    segments: seg(3, 64, 24),
  }).strict(),
  z.object({
    kind: z.literal("extrude"),
    shape: z.array(z.tuple([finite, finite])).min(3).max(40),
    depth: z.number().min(0.001).max(50),
    bevelEnabled: z.boolean().optional(),
    bevelSize: z.number().min(0).max(5).optional(),
    bevelThickness: z.number().min(0).max(5).optional(),
    bevelSegments: seg(0, 8, 2),
  }).strict(),
  z.object({
    kind: z.literal("tube"),
    path: z.array(vec3).min(2).max(64),
    radius: z.number().min(0.001).max(10),
    radialSegments: seg(3, 32, 8),
    tubularSegments: seg(3, 128, 24),
    closed: z.boolean().optional(),
  }).strict(),
  z.object({ kind: z.literal("plane"), width: z.number().min(0.001).max(100), height: z.number().min(0.001).max(100) }).strict(),
  z.object({ kind: z.literal("grid"), size: z.number().min(0.5).max(100), divisions: z.number().int().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("arrow"), length: z.number().min(0.01).max(50), shaftRadius: z.number().min(0.001).max(5), headRadius: z.number().min(0.001).max(5), headLength: z.number().min(0.01).max(10) }).strict(),
]);

export type Scene3DGeometry = z.infer<typeof geometrySchema>;

/* ── materials ────────────────────────────────────────────────────────── */

const materialSchema = z.object({
  color: hex.optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  transparent: z.boolean().optional(),
  emissive: hex.optional(),
  emissiveIntensity: z.number().min(0).max(5).optional(),
  flatShading: z.boolean().optional(),
  side: z.enum(["front", "back", "double"]).optional(),
}).strict();

export type Scene3DMaterial = z.infer<typeof materialSchema>;

/* ── node tree ────────────────────────────────────────────────────────── */

interface SceneNode {
  id: string;
  label?: string;
  geometry: Scene3DGeometry;
  material?: Scene3DMaterial;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  visible?: boolean;
  children?: SceneNode[];
}

const nodeSchema: z.ZodType<SceneNode> = z.lazy(() =>
  z.object({
    id,
    label: z.string().min(1).max(80).optional(),
    geometry: geometrySchema,
    material: materialSchema.optional(),
    position: vec3.optional(),
    rotation: vec3.optional(),
    scale: scale3.optional(),
    visible: z.boolean().optional(),
    children: z.array(nodeSchema).max(60).optional(),
  }).strict(),
);

export { nodeSchema };
export type Scene3DNode = SceneNode;

/* ── camera / lighting / labels / animation / sliders ─────────────────── */

const cameraSchema = z.object({
  position: vec3.optional(),
  target: vec3.optional(),
  fov: z.number().min(10).max(100).optional(),
}).strict();

const lightingSchema = z.object({
  preset: z.enum(["studio", "dramatic", "blueprint", "space"]).default("studio").optional(),
  shadows: z.boolean().optional(),
  ambientIntensity: z.number().min(0).max(3).optional(),
}).strict();

const labelSchema = z.object({
  target: id,
  text: z.string().min(1).max(80),
  offset: vec3.optional(),
}).strict();

const animationSchema = z.object({
  id,
  target: id,
  channel: z.enum(["rotation", "position", "scale"]),
  axis: z.enum(["x", "y", "z"]),
  from: finite,
  to: finite,
  duration: z.number().min(0.05).max(120),
  loop: z.boolean().optional(),
  yoyo: z.boolean().optional(),
}).strict();

const sliderSchema = z.object({
  id,
  label: z.string().min(1).max(60),
  min: finite,
  max: finite,
  step: z.number().positive(),
  defaultValue: finite,
  target: id,
  binding: z.enum(["rotation", "position", "scale"]),
  axis: z.enum(["x", "y", "z"]),
}).strict().refine(s => s.min < s.max, "slider min must be less than max");

const interactionsSchema = z.object({
  orbit: z.boolean().optional(),
  pan: z.boolean().optional(),
  select: z.boolean().optional(),
  hover: z.boolean().optional(),
}).strict();

const exportSchema = z.object({
  filename: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  formats: z.array(z.enum(["glb", "gltf"])).max(2).optional(),
}).strict();

/* ── budgets ──────────────────────────────────────────────────────────── */

export const SCENE_BUDGETS = { maxNodes: 120, maxDepth: 6, maxLabels: 10, maxSliders: 8, maxAnimations: 12 } as const;

function countNodes(nodes: readonly SceneNode[]): { total: number; maxDepth: number } {
  let total = 0;
  let maxDepth = 0;
  const walk = (list: readonly SceneNode[], depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    for (const n of list) {
      total += 1;
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 1);
  return { total, maxDepth };
}

function collectIds(nodes: readonly SceneNode[], into: Set<string>): void {
  for (const n of nodes) {
    into.add(n.id);
    if (n.children?.length) collectIds(n.children, into);
  }
}

/* ── top-level spec ───────────────────────────────────────────────────── */

export const scene3dSpecSchema = z
  .object({
    title: z.string().max(120).optional(),
    camera: cameraSchema.optional(),
    lighting: lightingSchema.optional(),
    objects: z.array(nodeSchema).min(1).max(40),
    labels: z.array(labelSchema).max(SCENE_BUDGETS.maxLabels).optional(),
    animations: z.array(animationSchema).max(SCENE_BUDGETS.maxAnimations).optional(),
    sliders: z.array(sliderSchema).max(SCENE_BUDGETS.maxSliders).optional(),
    interactions: interactionsSchema.optional(),
    export: exportSchema.optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const { total, maxDepth } = countNodes(spec.objects);
    if (total > SCENE_BUDGETS.maxNodes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `scene exceeds ${SCENE_BUDGETS.maxNodes} nodes (found ${total})` });
    }
    if (maxDepth > SCENE_BUDGETS.maxDepth) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `hierarchy exceeds depth ${SCENE_BUDGETS.maxDepth}` });
    }
    const ids = new Set<string>();
    const dupes: string[] = [];
    const seen = new Set<string>();
    const walk = (list: readonly SceneNode[]) => {
      for (const n of list) {
        if (seen.has(n.id)) dupes.push(n.id);
        seen.add(n.id);
        ids.add(n.id);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(spec.objects);
    if (dupes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate node ids: ${[...new Set(dupes)].join(", ")}` });
    }
    for (const ref of [
      ...(spec.labels ?? []).map(l => ({ what: "label", target: l.target })),
      ...(spec.animations ?? []).map(a => ({ what: "animation", target: a.target })),
      ...(spec.sliders ?? []).map(s => ({ what: "slider", target: s.target })),
    ]) {
      if (!ids.has(ref.target)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${ref.what} targets unknown id "${ref.target}"` });
      }
    }
  });

export type Scene3DSpec = z.infer<typeof scene3dSpecSchema>;
export type Scene3DAnimation = z.infer<typeof animationSchema>;
export type Scene3DSlider = z.infer<typeof sliderSchema>;
export type Scene3DLabel = z.infer<typeof labelSchema>;

/* ── asset3d fence: genuine AI-generated mesh request (Mode B) ────────── */

export const asset3dSpecSchema = z.object({
  title: z.string().max(120).optional(),
  prompt: z.string().min(1).max(800),
  formats: z.array(z.enum(["glb", "obj", "fbx", "stl", "usdz", "3mf"])).max(6).optional(),
  quality: z.enum(["standard", "detailed"]).optional(),
}).strict();

export type Asset3DSpec = z.infer<typeof asset3dSpecSchema>;
