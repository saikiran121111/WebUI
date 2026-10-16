import { z } from "zod";

/**
 * ```anatomy fence contract — isometric technical illustrations built by the
 * deterministic kit builder in lib/anatomy/anatomyBuilder.ts. Validated JSON
 * only: model output is never executed as code. Geometry is authored in a
 * z-up world (1 unit ≈ 1px) and projected by the vendored Anatomy kit.
 */

export const ANATOMY_BUDGETS = {
  maxParts: 90,
  maxControls: 6,
  maxReadouts: 6,
  maxLegend: 8,
  maxRodPoints: 24,
  maxOutlinePoints: 40,
} as const;

const coord = z.number().finite().gte(-600).lte(600);
const positive = (max: number) => z.number().finite().gt(0).lte(max);
const whole = (min: number, max: number) => z.number().int().gte(min).lte(max);
const degrees = z.number().finite().gte(-720).lte(720);
const vec2 = z.tuple([coord, coord]);
const vec3 = z.tuple([coord, coord, coord]);
const partId = z.string().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);

/** Craft tone hierarchy: base=lo, structure=mid, subject=hi, accent=hi+lit (exactly one). */
const anatomyTone = z.enum(["base", "structure", "subject", "accent"]);
const svgTone = z.enum(["hi", "mid", "lo", "faint"]);
const leaderTone = z.enum(["hi", "mid", "lo", "faint", "lit", "red", "green", "blue"]);

const planSchema = z
  .object({ x: coord, y: coord, w: positive(500), d: positive(500), r: z.number().finite().gte(0).lte(100) })
  .strict();

const slideSchema = z
  .object({
    axis: z.enum(["x", "y", "z"]),
    from: coord,
    to: coord,
    state: partId.optional(),
    oscillate: z.object({ period: z.number().finite().gte(0.5).lte(120) }).strict().optional(),
  })
  .strict();

const commonFields = {
  id: partId,
  tone: anatomyTone,
  label: z.string().min(1).max(60).optional(),
  note: z.string().max(140).optional(),
  /** Parent part id: this part's coordinates become relative to the parent's anchor. */
  on: partId.optional(),
  offset: vec3.default([0, 0, 0]),
  /** World offset applied when the exploded view is toggled on. */
  explode: vec3.optional(),
  slide: slideSchema.optional(),
};

const slabPart = z
  .object({
    kind: z.literal("slab"),
    plan: planSchema,
    z: coord,
    height: positive(300),
    steps: whole(3, 24).default(8),
    bevel: z.number().finite().gte(0).lte(8).default(0),
    ...commonFields,
  })
  .strict();

const cylinderPart = z
  .object({
    kind: z.literal("cylinder"),
    center: vec2,
    r: positive(200),
    z: coord,
    height: positive(300),
    steps: whole(6, 64).default(32),
    bevel: z.number().finite().gte(0).lte(8).default(0),
    ...commonFields,
  })
  .strict();

const prismPart = z
  .object({
    kind: z.literal("prism"),
    outline: z.array(vec2).min(3).max(ANATOMY_BUDGETS.maxOutlinePoints),
    z: coord,
    height: positive(300),
    convex: z.boolean().default(true),
    ...commonFields,
  })
  .strict();

const rodPart = z
  .object({
    kind: z.literal("rod"),
    path: z.array(vec3).min(2).max(ANATOMY_BUDGETS.maxRodPoints),
    r: positive(40),
    ...commonFields,
  })
  .strict();

const coilPart = z
  .object({
    kind: z.literal("coil"),
    from: coord,
    to: coord,
    center: vec2,
    r: positive(60),
    turns: whole(1, 40),
    axis: z.enum(["x", "y"]).default("x"),
    ...commonFields,
  })
  .strict();

const dialPart = z
  .object({
    kind: z.literal("dial"),
    center: vec2,
    z: coord,
    r: positive(200),
    ticks: z
      .object({
        count: whole(4, 120),
        every: whole(1, 20).default(5),
        minor: positive(60).default(2),
        major: positive(60).default(4),
        from: degrees.default(0),
        span: z.number().finite().gt(0).lte(360).default(360),
      })
      .strict()
      .optional(),
    needle: z
      .object({
        from: degrees,
        to: degrees,
        state: partId.optional(),
        length: z.number().finite().gte(0.3).lte(1).default(0.8),
      })
      .strict()
      .optional(),
    face: z.string().min(1).max(16).optional(),
    ...commonFields,
  })
  .strict();

const rulerPart = z
  .object({
    kind: z.literal("ruler"),
    axis: z.enum(["x", "y"]),
    from: coord,
    to: coord,
    step: positive(100),
    every: whole(1, 20),
    edge: coord,
    z: coord,
    lengths: z.tuple([positive(60), positive(60)]),
    ...commonFields,
  })
  .strict();

const knobPart = z
  .object({
    kind: z.literal("knob"),
    center: vec2,
    r: positive(100),
    z: coord,
    height: positive(100),
    knurl: whole(4, 60),
    ...commonFields,
  })
  .strict();

const screwsPart = z
  .object({
    kind: z.literal("screws"),
    plan: planSchema,
    z: coord,
    inset: z.number().finite().gte(0).lte(50).default(2),
    size: positive(10).default(0.5),
    ...commonFields,
  })
  .strict();

const calloutPart = z
  .object({
    kind: z.literal("callout"),
    at: vec3,
    text: z.string().min(1).max(40),
    dx: coord,
    dy: coord,
    leader: leaderTone.default("mid"),
    dashed: z.boolean().default(false),
    ...commonFields,
  })
  .strict();

const faceLabelPart = z
  .object({
    kind: z.literal("faceLabel"),
    target: partId,
    text: z.string().min(1).max(24),
    size: positive(14).default(3),
    along: z.enum(["x", "y"]).default("x"),
    faceTone: svgTone.default("mid"),
    ...commonFields,
  })
  .strict();

const partSchema = z.discriminatedUnion("kind", [
  slabPart,
  cylinderPart,
  prismPart,
  rodPart,
  coilPart,
  dialPart,
  rulerPart,
  knobPart,
  screwsPart,
  calloutPart,
  faceLabelPart,
]);

const controlSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: partId,
      kind: z.literal("slider"),
      label: z.string().min(1).max(40),
      min: coord,
      max: coord,
      step: positive(100),
      value: coord,
    })
    .strict(),
  z
    .object({
      id: partId,
      kind: z.literal("toggle"),
      label: z.string().min(1).max(40),
      value: z.boolean().default(true),
    })
    .strict(),
]);

const readoutSchema = z
  .object({
    id: partId,
    label: z.string().min(1).max(40),
    unit: z.string().min(1).max(16).optional(),
    decimals: whole(0, 4).default(1),
    /** Restricted arithmetic over control ids: + - * / ( ) and the listed functions only. */
    formula: z.string().min(1).max(120),
  })
  .strict();

const legendSchema = z
  .object({
    mark: z.enum(["raised", "flat", "lit", "edge", "dim", "dotted", "dashed", "red", "green", "blue"]),
    label: z.string().min(1).max(40),
  })
  .strict();

export const FORMULA_FUNCTIONS = ["min", "max", "abs", "clamp", "floor", "ceil", "round", "sqrt"] as const;

const specShape = z
  .object({
    title: z.string().min(1).max(80),
    fig: z.string().min(1).max(12).default("FIG"),
    /** Accessible concept statement: what the figure explains. */
    label: z.string().min(1).max(200),
    caption: z.string().max(240).optional(),
    hint: z.string().max(60).optional(),
    width: z.number().int().gte(320).lte(900).default(650),
    height: z.number().int().gte(240).lte(720).default(420),
    camera: z
      .object({
        azimuth: z.number().finite().gte(-180).lte(180).default(45),
        elevation: z.number().finite().gte(5).lte(85).default(30),
      })
      .strict()
      .default({}),
    parts: z.array(partSchema).min(1).max(ANATOMY_BUDGETS.maxParts),
    controls: z.array(controlSchema).max(ANATOMY_BUDGETS.maxControls).default([]),
    readouts: z.array(readoutSchema).max(ANATOMY_BUDGETS.maxReadouts).default([]),
    legend: z.array(legendSchema).max(ANATOMY_BUDGETS.maxLegend).default([]),
    explode: z.object({ label: z.string().min(1).max(24).optional() }).strict().optional(),
    export: z.object({ filename: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/) }).strict().optional(),
  })
  .strict();

export type AnatomySpec = z.infer<typeof specShape>;

export const anatomySpecSchema = specShape.superRefine(validateAnatomySpec);
export type AnatomyPart = AnatomySpec["parts"][number];
export type AnatomyControl = AnatomySpec["controls"][number];

function validateAnatomySpec(spec: AnatomySpec, ctx: z.RefinementCtx) {
  const fail = (message: string, path: (string | number)[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

  const seen = new Set<string>();
  for (const entry of [...spec.parts, ...spec.controls, ...spec.readouts]) {
    if (seen.has(entry.id)) fail(`duplicate id "${entry.id}"`, ["parts"]);
    seen.add(entry.id);
  }

  const byId = new Map(spec.parts.map((part) => [part.id, part]));
  const sliders = new Map(spec.controls.filter((c) => c.kind === "slider").map((c) => [c.id, c]));
  const controlIds = new Set(spec.controls.map((c) => c.id));

  for (const part of spec.parts) {
    if (part.on && !byId.has(part.on)) fail(`part "${part.id}" attaches to unknown part "${part.on}"`, ["parts"]);
    if (part.on) {
      const chain = new Set([part.id]);
      let walker: AnatomyPart | undefined = part;
      while (walker?.on) {
        if (chain.has(walker.on)) {
          fail(`part "${part.id}" has a circular "on" chain`, ["parts"]);
          break;
        }
        chain.add(walker.on);
        walker = byId.get(walker.on);
      }
    }
    if (part.slide?.state && !sliders.has(part.slide.state)) {
      fail(`part "${part.id}" slide references unknown slider "${part.slide.state}"`, ["parts"]);
    }
    if (part.kind === "dial" && part.needle?.state && !sliders.has(part.needle.state)) {
      fail(`dial "${part.id}" needle references unknown slider "${part.needle.state}"`, ["parts"]);
    }
    if (part.kind === "faceLabel" && !byId.has(part.target)) {
      fail(`faceLabel "${part.id}" targets unknown part "${part.target}"`, ["parts"]);
    }
  }

  const accents = spec.parts.filter((part) => part.tone === "accent").length;
  if (accents > 1) fail(`exactly one accent part is allowed, found ${accents}`, ["parts"]);

  for (const control of spec.controls) {
    if (control.kind === "slider" && control.min >= control.max) fail(`slider "${control.id}" needs min < max`, ["controls"]);
  }

  const allowedFunctions = new Set<string>(FORMULA_FUNCTIONS);
  for (const readout of spec.readouts) {
    for (const token of readout.formula.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []) {
      if (!controlIds.has(token) && !allowedFunctions.has(token)) {
        fail(`readout "${readout.id}" formula references unknown name "${token}"`, ["readouts"]);
      }
    }
  }
}
