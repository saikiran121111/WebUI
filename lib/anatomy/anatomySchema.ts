import { z } from "zod";

/**
 * ```anatomy fence contract — isometric technical illustrations built by the
 * deterministic kit builder in lib/anatomy/anatomyBuilder.ts. Validated JSON
 * only: model output is never executed as code. Geometry is authored in a
 * z-up world (1 unit ≈ 1px) and projected by the vendored Anatomy kit.
 *
 * Two budget profiles:
 *  - "standard" (default): the original craft-figure limits.
 *  - "advanced": architectural cutaways / engineering illustrations with
 *    logical groups, floor modules, connections and system flows. Logical
 *    parts are capped at maxParts; module expansion is additionally capped
 *    at maxRenderedParts so repeated floors stay benchmarked, not unbounded.
 * A scene over its profile budget fails validation with a clear issue —
 * the renderer never silently truncates.
 */

export const ANATOMY_BUDGETS = {
  maxParts: 90,
  maxControls: 6,
  maxReadouts: 6,
  maxLegend: 8,
  maxRodPoints: 24,
  maxOutlinePoints: 40,
  maxGroups: 6,
  maxFloors: 24,
  maxModules: 4,
  maxConnections: 12,
  maxFlows: 12,
  maxRenderedParts: 150,
} as const;

export const ANATOMY_ADVANCED_BUDGETS = {
  maxParts: 240,
  maxControls: 14,
  maxReadouts: 8,
  maxLegend: 12,
  maxRodPoints: 24,
  maxOutlinePoints: 40,
  maxGroups: 12,
  maxFloors: 100,
  maxModules: 8,
  maxConnections: 48,
  maxFlows: 48,
  maxRenderedParts: 700,
} as const;

export type AnatomyProfile = "standard" | "advanced";

const coord = z.number().finite().gte(-600).lte(600);
const positive = (max: number) => z.number().finite().gt(0).lte(max);
const whole = (min: number, max: number) => z.number().int().gte(min).lte(max);
const degrees = z.number().finite().gte(-720).lte(720);
const vec2 = z.tuple([coord, coord]);
const vec3 = z.tuple([coord, coord, coord]);
const partId = z.string().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);

/** Craft tone hierarchy: base=lo, structure=subject=mid range, accent=hi+lit (exactly one, top-level only). */
const anatomyTone = z.enum(["base", "structure", "subject", "accent"]);
const svgTone = z.enum(["hi", "mid", "lo", "faint"]);
const leaderTone = z.enum(["hi", "mid", "lo", "faint", "lit", "red", "green", "blue"]);

/** System color conventions shared by groups, flows and the legend. */
const systemColor = z.enum(["gray", "green", "blue", "amber", "red", "violet", "cyan"]);

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
  /** Logical layer group this part belongs to (visibility + system selection). */
  group: partId.optional(),
  /** Floor id (spec.floors) this part sits on — floor navigation dims the rest. */
  floor: partId.optional(),
  /** Boolean toggle control id: part is hidden unless that toggle is on. */
  visibleWhen: partId.optional(),
  /** Inspection text shown in the info panel when the part is clicked (falls back to note). */
  info: z.string().max(240).optional(),
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
    outline: z.array(vec2).min(3).max(ANATOMY_ADVANCED_BUDGETS.maxOutlinePoints),
    z: coord,
    height: positive(300),
    convex: z.boolean().default(true),
    ...commonFields,
  })
  .strict();

const rodPart = z
  .object({
    kind: z.literal("rod"),
    path: z.array(vec3).min(2).max(ANATOMY_ADVANCED_BUDGETS.maxRodPoints),
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
      /** When set, the toggle drives the visibility of every part in this group. */
      group: partId.optional(),
    })
    .strict(),
  z
    .object({
      id: partId,
      kind: z.literal("button"),
      label: z.string().min(1).max(40),
      action: z.enum(["explode", "restore", "play", "pause", "reset", "resetView"]),
    })
    .strict(),
  z
    .object({
      id: partId,
      kind: z.literal("select"),
      label: z.string().min(1).max(40),
      /** What the selection drives: floor inspection or system isolation. */
      target: z.enum(["floor", "system"]),
      value: partId.optional(),
      /** Explicit options; when omitted the engine fills them from spec.floors / spec.groups. */
      options: z.array(z.object({ value: partId, label: z.string().min(1).max(40) }).strict()).max(100).optional(),
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

const groupSchema = z
  .object({
    id: partId,
    label: z.string().min(1).max(40),
    color: systemColor.optional(),
    /** Toggles of groups sharing a section render inside one collapsible section. */
    section: z.string().min(1).max(24).optional(),
  })
  .strict();

const floorSchema = z
  .object({
    id: partId,
    z: coord,
    height: positive(300).optional(),
    label: z.string().min(1).max(40).optional(),
    /** Module id whose parts are instantiated at this floor's z (repeated floor geometry). */
    module: partId.optional(),
  })
  .strict();

const moduleSchema = z
  .object({
    id: partId,
    /** Module-local z that aligns with the floor's z (default 0). */
    anchorZ: coord.default(0),
    parts: z.array(partSchema).min(1).max(ANATOMY_ADVANCED_BUDGETS.maxParts),
  })
  .strict();

const connectionSchema = z
  .object({
    id: partId,
    /** System group this connection belongs to (visibility + flow color). */
    system: partId.optional(),
    from: partId.optional(),
    to: partId.optional(),
    label: z.string().min(1).max(40).optional(),
    path: z.array(vec3).min(2).max(ANATOMY_ADVANCED_BUDGETS.maxRodPoints),
  })
  .strict();

const flowSchema = z
  .object({
    id: partId,
    connection: partId,
    speed: z.number().finite().gt(0).lte(4).default(1),
    label: z.string().min(1).max(40).optional(),
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
    profile: z.enum(["standard", "advanced"]).default("standard"),
    width: z.number().int().gte(320).lte(900).default(650),
    height: z.number().int().gte(240).lte(720).default(420),
    camera: z
      .object({
        azimuth: z.number().finite().gte(-180).lte(180).default(45),
        elevation: z.number().finite().gte(5).lte(85).default(30),
      })
      .strict()
      .default({}),
    // Array ceilings are the advanced maxima; the per-profile budget is enforced
    // in superRefine so a standard figure still fails past 90 parts.
    parts: z.array(partSchema).min(1).max(ANATOMY_ADVANCED_BUDGETS.maxParts),
    controls: z.array(controlSchema).max(ANATOMY_ADVANCED_BUDGETS.maxControls).default([]),
    readouts: z.array(readoutSchema).max(ANATOMY_ADVANCED_BUDGETS.maxReadouts).default([]),
    legend: z.array(legendSchema).max(ANATOMY_ADVANCED_BUDGETS.maxLegend).default([]),
    groups: z.array(groupSchema).max(ANATOMY_ADVANCED_BUDGETS.maxGroups).default([]),
    floors: z.array(floorSchema).max(ANATOMY_ADVANCED_BUDGETS.maxFloors).default([]),
    modules: z.array(moduleSchema).max(ANATOMY_ADVANCED_BUDGETS.maxModules).default([]),
    connections: z.array(connectionSchema).max(ANATOMY_ADVANCED_BUDGETS.maxConnections).default([]),
    flows: z.array(flowSchema).max(ANATOMY_ADVANCED_BUDGETS.maxFlows).default([]),
    explode: z.object({ label: z.string().min(1).max(24).optional() }).strict().optional(),
    export: z.object({ filename: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/) }).strict().optional(),
  })
  .strict();

export type AnatomySpec = z.infer<typeof specShape>;

export const anatomySpecSchema = specShape.superRefine(validateAnatomySpec);
export type AnatomyPart = AnatomySpec["parts"][number];
export type AnatomyControl = AnatomySpec["controls"][number];
export type AnatomyGroup = AnatomySpec["groups"][number];
export type AnatomyFloor = AnatomySpec["floors"][number];
export type AnatomyModule = AnatomySpec["modules"][number];
export type AnatomyConnection = AnatomySpec["connections"][number];
export type AnatomyFlow = AnatomySpec["flows"][number];

export function budgetsFor(profile: AnatomyProfile) {
  return profile === "advanced" ? ANATOMY_ADVANCED_BUDGETS : ANATOMY_BUDGETS;
}

/** Total parts after floor-module expansion (what the renderer actually draws). */
export function renderedPartCount(spec: AnatomySpec): number {
  const moduleSize = new Map(spec.modules.map((mod) => [mod.id, mod.parts.length]));
  let count = spec.parts.length;
  for (const floor of spec.floors) count += floor.module ? moduleSize.get(floor.module) ?? 0 : 0;
  return count;
}

/** Logical parts: top-level parts plus each module defined once (not per floor). */
export function logicalPartCount(spec: AnatomySpec): number {
  return spec.parts.length + spec.modules.reduce((sum, mod) => sum + mod.parts.length, 0);
}

function validateAnatomySpec(spec: AnatomySpec, ctx: z.RefinementCtx) {
  const fail = (message: string, path: (string | number)[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

  const budget = budgetsFor(spec.profile);

  const logical = logicalPartCount(spec);
  if (logical > budget.maxParts) {
    fail(`profile "${spec.profile}" allows at most ${budget.maxParts} logical parts, found ${logical}`, ["parts"]);
  }
  const rendered = renderedPartCount(spec);
  if (rendered > budget.maxRenderedParts) {
    fail(
      `floor modules expand to ${rendered} rendered parts, over the "${spec.profile}" cap of ${budget.maxRenderedParts} — use fewer floors or a smaller module`,
      ["floors"],
    );
  }
  if (spec.controls.length > budget.maxControls) fail(`profile "${spec.profile}" allows at most ${budget.maxControls} controls`, ["controls"]);
  if (spec.readouts.length > budget.maxReadouts) fail(`profile "${spec.profile}" allows at most ${budget.maxReadouts} readouts`, ["readouts"]);
  if (spec.legend.length > budget.maxLegend) fail(`profile "${spec.profile}" allows at most ${budget.maxLegend} legend keys`, ["legend"]);
  if (spec.groups.length > budget.maxGroups) fail(`profile "${spec.profile}" allows at most ${budget.maxGroups} groups`, ["groups"]);
  if (spec.floors.length > budget.maxFloors) fail(`profile "${spec.profile}" allows at most ${budget.maxFloors} floors`, ["floors"]);
  if (spec.modules.length > budget.maxModules) fail(`profile "${spec.profile}" allows at most ${budget.maxModules} modules`, ["modules"]);
  if (spec.connections.length > budget.maxConnections) fail(`profile "${spec.profile}" allows at most ${budget.maxConnections} connections`, ["connections"]);
  if (spec.flows.length > budget.maxFlows) fail(`profile "${spec.profile}" allows at most ${budget.maxFlows} flows`, ["flows"]);

  const seen = new Set<string>();
  for (const entry of [...spec.parts, ...spec.controls, ...spec.readouts, ...spec.groups, ...spec.floors, ...spec.modules, ...spec.connections, ...spec.flows]) {
    if (seen.has(entry.id)) fail(`duplicate id "${entry.id}"`, ["parts"]);
    seen.add(entry.id);
  }

  const groupIds = new Set(spec.groups.map((group) => group.id));
  const floorIds = new Set(spec.floors.map((floor) => floor.id));
  const moduleIds = new Set(spec.modules.map((mod) => mod.id));
  const connectionIds = new Set(spec.connections.map((connection) => connection.id));

  for (const floor of spec.floors) {
    if (floor.module && !moduleIds.has(floor.module)) fail(`floor "${floor.id}" references unknown module "${floor.module}"`, ["floors"]);
  }

  const byId = new Map(spec.parts.map((part) => [part.id, part]));
  const sliders = new Map(spec.controls.filter((c) => c.kind === "slider").map((c) => [c.id, c]));
  const toggles = new Map(spec.controls.filter((c) => c.kind === "toggle").map((c) => [c.id, c]));
  const controlIds = new Set(spec.controls.map((c) => c.id));

  const checkPartRefs = (part: AnatomyPart, scope: Map<string, AnatomyPart>, label: string) => {
    if (part.group && !groupIds.has(part.group)) fail(`${label} "${part.id}" references unknown group "${part.group}"`, ["parts"]);
    if (part.floor && !floorIds.has(part.floor)) fail(`${label} "${part.id}" references unknown floor "${part.floor}"`, ["parts"]);
    if (part.visibleWhen && !toggles.has(part.visibleWhen)) {
      fail(`${label} "${part.id}" visibleWhen references unknown toggle "${part.visibleWhen}"`, ["parts"]);
    }
    if (part.on && !scope.has(part.on)) fail(`${label} "${part.id}" attaches to unknown part "${part.on}"`, ["parts"]);
    if (part.on) {
      const chain = new Set([part.id]);
      let walker: AnatomyPart | undefined = part;
      while (walker?.on) {
        if (chain.has(walker.on)) {
          fail(`${label} "${part.id}" has a circular "on" chain`, ["parts"]);
          break;
        }
        chain.add(walker.on);
        walker = scope.get(walker.on);
      }
    }
    if (part.slide?.state && !sliders.has(part.slide.state)) {
      fail(`${label} "${part.id}" slide references unknown slider "${part.slide.state}"`, ["parts"]);
    }
    if (part.kind === "dial" && part.needle?.state && !sliders.has(part.needle.state)) {
      fail(`dial "${part.id}" needle references unknown slider "${part.needle.state}"`, ["parts"]);
    }
    if (part.kind === "faceLabel" && !scope.has(part.target)) {
      fail(`faceLabel "${part.id}" targets unknown part "${part.target}"`, ["parts"]);
    }
  };

  for (const part of spec.parts) checkPartRefs(part, byId, "part");

  for (const mod of spec.modules) {
    const moduleScope = new Map(mod.parts.map((part) => [part.id, part]));
    for (const part of mod.parts) {
      if (part.tone === "accent") fail(`module "${mod.id}" part "${part.id}" may not use the accent tone`, ["modules"]);
      checkPartRefs(part, moduleScope, `module "${mod.id}" part`);
    }
  }

  const accents = spec.parts.filter((part) => part.tone === "accent").length;
  if (accents > 1) fail(`exactly one accent part is allowed, found ${accents}`, ["parts"]);

  for (const control of spec.controls) {
    if (control.kind === "slider" && control.min >= control.max) fail(`slider "${control.id}" needs min < max`, ["controls"]);
    if (control.kind === "toggle" && control.group && !groupIds.has(control.group)) {
      fail(`toggle "${control.id}" drives unknown group "${control.group}"`, ["controls"]);
    }
    if (control.kind === "select") {
      if (control.target === "floor" && spec.floors.length === 0) fail(`select "${control.id}" targets floors but the spec has none`, ["controls"]);
      if (control.target === "system" && spec.groups.length === 0) fail(`select "${control.id}" targets systems but the spec has no groups`, ["controls"]);
      if (control.value && control.target === "floor" && !floorIds.has(control.value)) fail(`select "${control.id}" value is not a floor id`, ["controls"]);
      if (control.value && control.target === "system" && !groupIds.has(control.value)) fail(`select "${control.id}" value is not a group id`, ["controls"]);
    }
  }

  for (const connection of spec.connections) {
    if (connection.system && !groupIds.has(connection.system)) fail(`connection "${connection.id}" references unknown system "${connection.system}"`, ["connections"]);
    if (connection.from && !byId.has(connection.from)) fail(`connection "${connection.id}" from "${connection.from}" is not a top-level part`, ["connections"]);
    if (connection.to && !byId.has(connection.to)) fail(`connection "${connection.id}" to "${connection.to}" is not a top-level part`, ["connections"]);
  }
  for (const flow of spec.flows) {
    if (!connectionIds.has(flow.connection)) fail(`flow "${flow.id}" references unknown connection "${flow.connection}"`, ["flows"]);
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
