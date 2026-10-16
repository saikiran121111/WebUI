import {
  boxCorners,
  coil,
  corners,
  cylinder,
  depthOf,
  dotsSvg,
  extrude,
  faceTextSvg,
  figureSvg,
  fitProjection,
  insetPlan,
  iso,
  joinPaths,
  knurl,
  lineOnTop,
  lineSvg,
  plateHtml,
  pointsAt,
  radialTicks,
  ring,
  segment,
  slabOf,
  solidSvg,
  topMatrix,
  topTicks,
  wireSvg,
  type LegendKey,
  type LineTone,
  type Plane,
  type Point3,
  type Projection,
  type Tone,
} from "./kit/iso-kit";
import { tubePieces, tubeSvg } from "./kit/tube.mjs";
import { dot3, viewOf } from "./kit/lathe.mjs";
import { expandFloorModules } from "./floorModules";
import { budgetsFor, type AnatomyPart, type AnatomySpec } from "./anatomySchema";

/**
 * Deterministic Anatomy figure builder: validated ```anatomy JSON in, finished
 * plate markup + live spec out. Pure string/geometry code — runs identically on
 * the server (export route) and in the browser (AnatomyBlock). The model never
 * draws: it only authors this contract, and the kit does the projecting.
 */

export interface AnatomyLiveSpec {
  camera: { origin: [number, number]; scale: number; azimuth: number; elevation: number };
  controls: Array<{
    id: string;
    kind: "slider" | "toggle" | "button" | "select";
    label: string;
    min?: number;
    max?: number;
    step?: number;
    value?: number | boolean | string;
    group?: string;
    action?: string;
    target?: "floor" | "system";
    options?: Array<{ value: string; label: string }>;
  }>;
  groups: Array<{ id: string; label: string; color: string; section?: string }>;
  floors: Array<{ id: string; label: string }>;
  parts: Array<{
    id: string;
    slide?: { axis: "x" | "y" | "z"; from: number; to: number; state?: string; oscillate?: { period: number } };
    explode?: [number, number, number];
    needle?: { cx: number; cy: number; z: number; r: number; length: number; from: number; to: number; state?: string };
  }>;
  readouts: Array<{ id: string; label: string; unit?: string; decimals: number; formula: string }>;
  explode: boolean;
}

export interface AnatomyFigure {
  plate: string;
  svg: string;
  liveSpec: AnatomyLiveSpec;
  warnings: string[];
  filename: string;
}

const TONE_STYLE: Record<string, { edge: Tone; lit: boolean }> = {
  base: { edge: "lo", lit: false },
  structure: { edge: "mid", lit: false },
  subject: { edge: "hi", lit: false },
  accent: { edge: "hi", lit: true },
};

const RADIANS = Math.PI / 180;
const round1 = (value: number) => String(Math.round(value * 10) / 10);

const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const add3 = (a: Point3, b: Point3): Point3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const shift2 = ([x, y]: Plane, o: Point3): Plane => [x + o[0], y + o[1]];
const shift3 = ([x, y, z]: Point3, o: Point3): Point3 => [x + o[0], y + o[1], z + o[2]];
const shiftPlan = (plan: { x: number; y: number; w: number; d: number; r: number }, o: Point3) => ({
  ...plan,
  x: plan.x + o[0],
  y: plan.y + o[1],
});

const OVERLAY_KINDS = new Set(["callout", "faceLabel"]);

/** Inline system colors keep connections/flows self-styled in app, export and TSX alike. */
const SYSTEM_HEX: Record<string, string> = {
  gray: "#8a8a84",
  green: "#3f9d5f",
  blue: "#3d7dd8",
  amber: "#d8963d",
  red: "#d84f4f",
  violet: "#9a5fd8",
  cyan: "#3db8c9",
};

function anchorOf(part: AnatomyPart): Point3 {
  switch (part.kind) {
    case "slab":
      return [part.plan.x + part.plan.w / 2, part.plan.y + part.plan.d / 2, part.z + part.height / 2];
    case "cylinder":
    case "knob":
      return [part.center[0], part.center[1], part.z + part.height / 2];
    case "prism": {
      const xs = part.outline.map(([x]) => x);
      const ys = part.outline.map(([, y]) => y);
      return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length, part.z + part.height / 2];
    }
    case "rod":
      return part.path[Math.floor(part.path.length / 2)];
    case "coil":
      return [(part.from + part.to) / 2, part.center[0], part.center[1]];
    case "dial":
      return [part.center[0], part.center[1], part.z];
    case "ruler":
      return [(part.from + part.to) / 2, part.edge, part.z];
    case "screws":
      return [part.plan.x + part.plan.w / 2, part.plan.y + part.plan.d / 2, part.z];
    case "callout":
      return part.at;
    case "faceLabel":
      return [0, 0, 0];
  }
}

function extentsOf(part: AnatomyPart): Point3[] {
  switch (part.kind) {
    case "slab":
    case "screws":
      return boxCorners(part.plan, part.z, part.z + (part.kind === "slab" ? part.height : 0));
    case "cylinder":
    case "knob":
      return [
        [part.center[0] - part.r, part.center[1] - part.r, part.z],
        [part.center[0] + part.r, part.center[1] + part.r, part.z + part.height],
      ];
    case "prism":
      return part.outline.flatMap(([x, y]) => [
        [x, y, part.z] as Point3,
        [x, y, part.z + part.height] as Point3,
      ]);
    case "rod":
      return part.path;
    case "coil":
      return [
        [part.from, part.center[0] - part.r, part.center[1] - part.r],
        [part.to, part.center[0] + part.r, part.center[1] + part.r],
      ];
    case "dial":
      return [
        [part.center[0] - part.r, part.center[1] - part.r, part.z],
        [part.center[0] + part.r, part.center[1] + part.r, part.z],
      ];
    case "ruler":
      return [
        [Math.min(part.from, part.to), part.edge, part.z],
        [Math.max(part.from, part.to), part.edge + Math.max(part.lengths[0], part.lengths[1]), part.z],
      ];
    case "callout":
      return [part.at];
    case "faceLabel":
      return [];
  }
}

/** Top face height in the part's own coordinate space (for face labels). */
function topZOf(part: AnatomyPart): number | null {
  if (part.kind === "slab" || part.kind === "cylinder" || part.kind === "prism" || part.kind === "knob") return part.z + part.height;
  if (part.kind === "dial") return part.z;
  return null;
}

export function buildAnatomyFigure(spec: AnatomySpec): AnatomyFigure {
  const warnings: string[] = [];
  const parts = expandFloorModules(spec);
  // Renderer-side budget guard (the schema already rejects over-budget specs;
  // this protects every other caller too). Over-budget figures are refused
  // outright — never silently truncated.
  const budget = budgetsFor(spec.profile);
  if (parts.length > budget.maxRenderedParts) {
    throw new Error(
      `anatomy build refused: ${parts.length} rendered parts exceed the "${spec.profile}" cap of ${budget.maxRenderedParts}`,
    );
  }
  const byId = new Map(parts.map((part) => [part.id, part]));
  const origins = new Map<string, Point3>();

  const originOf = (part: AnatomyPart): Point3 => {
    const cached = origins.get(part.id);
    if (cached) return cached;
    const origin = part.on && byId.has(part.on) ? add3(add3(originOf(byId.get(part.on)!), anchorOf(byId.get(part.on)!)), part.offset) : part.offset;
    origins.set(part.id, origin);
    return origin;
  };

  const fitPoints: Point3[] = [];
  for (const part of parts) {
    if (OVERLAY_KINDS.has(part.kind) && part.kind !== "callout") continue;
    fitPoints.push(...extentsOf(part).map((point) => shift3(point, originOf(part))));
  }
  for (const connection of spec.connections) fitPoints.push(...connection.path);
  if (!fitPoints.length) fitPoints.push([0, 0, 0], [10, 10, 10]);

  const P: Projection = fitProjection(fitPoints, spec.width, spec.height, {
    pad: 28,
    azimuth: spec.camera.azimuth,
    elevation: spec.camera.elevation,
  });

  const styleOf = (part: AnatomyPart) => TONE_STYLE[part.tone];

  function solidMarkup(paths: ReturnType<typeof slabOf>, part: AnatomyPart) {
    const { edge, lit } = styleOf(part);
    return solidSvg(paths, { tone: edge, lit, halo: part.tone === "base" });
  }

  function partMarkup(part: AnatomyPart): string {
    const o = originOf(part);
    const { edge } = styleOf(part);
    switch (part.kind) {
      case "slab":
        return solidMarkup(slabOf(shiftPlan(part.plan, o), part.z + o[2], part.height, P, part.steps, part.bevel), part);
      case "cylinder":
        return solidMarkup(cylinder(part.center[0] + o[0], part.center[1] + o[1], part.r, part.z + o[2], part.height, P, part.steps, part.bevel), part);
      case "prism":
        return solidMarkup(extrude(part.outline.map((point) => shift2(point, o)), part.z + o[2], part.height, P, { convex: part.convex, bevel: 0 }), part);
      case "rod": {
        const pieces = tubePieces(part.path.map((point) => shift3(point, o)), part.r, P);
        const view = viewOf(P);
        return pieces
          .slice()
          .sort((a, b) => dot3(a.mid, view) - dot3(b.mid, view))
          .map((piece) => tubeSvg(piece, { tone: edge as LineTone }))
          .join("");
      }
      case "coil": {
        const { back, front } = coil(part.from, part.to, shift2(part.center, o), part.r, part.turns, part.axis, P);
        return lineSvg(back, { tone: "faint" }) + lineSvg(front, { tone: edge });
      }
      case "dial": {
        const cx = part.center[0] + o[0];
        const cy = part.center[1] + o[1];
        const z = part.z + o[2];
        const parts: string[] = [lineSvg(ring(cx, cy, part.r, z + 0.02, P), { tone: edge })];
        if (part.ticks) {
          const ticks = radialTicks(
            cx,
            cy,
            part.r,
            part.ticks.count,
            part.ticks.every,
            z + 0.02,
            [part.ticks.minor, part.ticks.major],
            P,
            part.ticks.from * RADIANS,
            part.ticks.span * RADIANS,
          );
          parts.push(lineSvg(ticks.minor, { tone: "faint" }), lineSvg(ticks.major, { tone: "mid" }));
        }
        if (part.face) parts.push(faceTextSvg(topMatrix([cx, cy], z + 0.05, P, "x"), part.face, { size: Math.max(2.5, part.r * 0.12), tone: "mid", anchor: "middle" }));
        if (part.needle) {
          const angle = part.needle.from * RADIANS;
          const tip: Point3 = [cx + Math.sin(angle) * part.r * part.needle.length, cy - Math.cos(angle) * part.r * part.needle.length, z + 0.04];
          parts.push(
            `<path class="iso-line" data-needle="${part.id}" data-tone="lit" d="${segment([cx, cy, z + 0.04], tip, P)}"/>`,
            dotsSvg(pointsAt([[cx, cy, z + 0.04]], P), { size: 1, tone: "hi" }),
          );
        }
        return parts.join("");
      }
      case "ruler": {
        const ticks = topTicks(
          part.from,
          part.to,
          part.step,
          part.every,
          part.edge + o[1],
          part.z + o[2],
          part.lengths,
          P,
          part.axis,
        );
        const baseline =
          part.axis === "x"
            ? lineOnTop([part.from + o[0], part.edge + o[1]], [part.to + o[0], part.edge + o[1]], part.z + o[2], P)
            : lineOnTop([part.edge + o[0], part.from + o[1]], [part.edge + o[0], part.to + o[1]], part.z + o[2], P);
        return lineSvg(baseline, { tone: "mid" }) + lineSvg(ticks.minor, { tone: "faint" }) + lineSvg(ticks.major, { tone: edge });
      }
      case "knob": {
        const marks = knurl(part.center[0] + o[0], part.center[1] + o[1], part.r, part.z + o[2], part.z + part.height + o[2], part.knurl, P);
        return solidMarkup(cylinder(part.center[0] + o[0], part.center[1] + o[1], part.r, part.z + o[2], part.height, P, 24, 0), part) + lineSvg(Array.isArray(marks) ? joinPaths(marks) : marks, { tone: "faint" });
      }
      case "screws": {
        const dots = pointsAt(corners(insetPlan(shiftPlan(part.plan, o), part.inset), 0).map(([x, y]) => [x, y, part.z + o[2] + 0.02] as Point3), P);
        return dotsSvg(dots, { size: part.size, tone: edge === "lo" ? "mid" : edge });
      }
      default:
        return "";
    }
  }

  const childrenOf = new Map<string, AnatomyPart[]>();
  const roots: AnatomyPart[] = [];
  for (const part of parts) {
    if (OVERLAY_KINDS.has(part.kind)) continue;
    if (part.on && byId.has(part.on)) {
      const siblings = childrenOf.get(part.on) ?? [];
      siblings.push(part);
      childrenOf.set(part.on, siblings);
    } else {
      roots.push(part);
    }
  }

  const worldAnchor = (part: AnatomyPart) => add3(originOf(part), anchorOf(part));
  const byDepth = (a: AnatomyPart, b: AnatomyPart) => depthOf(worldAnchor(a), P) - depthOf(worldAnchor(b), P);

  function renderPart(part: AnatomyPart): string {
    const children = (childrenOf.get(part.id) ?? []).slice().sort(byDepth);
    const attrs = [`data-part="${part.id}"`];
    if (part.label) attrs.push(`data-label="${attr(part.label)}"`);
    if (part.note) attrs.push(`data-note="${attr(part.note)}"`);
    if (part.info) attrs.push(`data-info="${attr(part.info)}"`);
    if (part.group) attrs.push(`data-group="${part.group}"`);
    if (part.floor) attrs.push(`data-floor="${part.floor}"`);
    if (part.visibleWhen) attrs.push(`data-visible-when="${part.visibleWhen}"`);
    return `<g ${attrs.join(" ")}>${partMarkup(part)}${children.map(renderPart).join("")}</g>`;
  }

  function overlayMarkup(part: AnatomyPart): string {
    const o = originOf(part);
    if (part.kind === "callout") {
      const from = iso(shift3(part.at, o), P);
      const to: [number, number] = [from[0] + part.dx, from[1] + part.dy];
      const textTone: Tone = part.leader === "lit" ? "hi" : part.leader === "red" || part.leader === "green" || part.leader === "blue" ? "mid" : part.leader;
      return (
        `<g data-part="${part.id}"${part.label ? ` data-label="${attr(part.label)}"` : ""}${part.note ? ` data-note="${attr(part.note)}"` : ""}${part.info ? ` data-info="${attr(part.info)}"` : ""}${part.group ? ` data-group="${part.group}"` : ""}${part.floor ? ` data-floor="${part.floor}"` : ""}${part.visibleWhen ? ` data-visible-when="${part.visibleWhen}"` : ""}>` +
        wireSvg(from, to, { tone: part.leader, dashed: part.dashed, ends: "to" }) +
        faceTextSvg(`translate(${round1(to[0] + (part.dx < 0 ? -4 : 4))} ${round1(to[1] + 3)})`, part.text, {
          size: 3.2,
          tone: textTone,
          anchor: part.dx < 0 ? "end" : "start",
        }) +
        "</g>"
      );
    }
    if (part.kind === "faceLabel") {
      const target = byId.get(part.target);
      if (!target) return "";
      const anchor = shift3(anchorOf(target), originOf(target));
      const topZ = topZOf(target);
      if (topZ === null) return "";
      return faceTextSvg(topMatrix([anchor[0], anchor[1]], topZ + o[2] + 0.15, P, part.along), part.text, {
        size: part.size,
        tone: part.faceTone,
        anchor: "middle",
      });
    }
    return "";
  }

  const groupColor = new Map(spec.groups.map((group) => [group.id, group.color ?? "gray"]));

  function connectionMarkup(connection: AnatomySpec["connections"][number]): string {
    const projected = connection.path.map((point) => iso(point, P));
    const d = projected.map(([x, y], index) => `${index ? "L" : "M"}${round1(x)} ${round1(y)}`).join("");
    const color = SYSTEM_HEX[connection.system ? groupColor.get(connection.system) ?? "gray" : "gray"] ?? "#8a8a84";
    const attrs = ['class="anatomy-connection"', `data-connection="${connection.id}"`, `stroke="${color}"`];
    if (connection.system) attrs.push(`data-system="${connection.system}"`);
    if (connection.label) attrs.push(`data-label="${attr(connection.label)}"`);
    const flows = spec.flows
      .filter((flow) => flow.connection === connection.id)
      .map(
        (flow) =>
          `<path class="anatomy-flow" data-flow="${flow.id}" data-connection="${connection.id}" data-speed="${flow.speed}" stroke="${color}" fill="none" stroke-width="2" stroke-linecap="round" d="${d}"/>`,
      )
      .join("");
    return `<g ${attrs.join(" ")} fill="none"><path d="${d}" stroke-width="1.1" stroke-opacity="0.55" stroke-dasharray="2 3"/>${flows}</g>`;
  }

  const overlays = parts.filter((part) => OVERLAY_KINDS.has(part.kind));
  // Aggregate the (common) static-explode notice: a large advanced figure can
  // have hundreds of intentionally static parts, and one warning per part
  // would flood the block's warning strip.
  let staticExplodeCount = 0;
  let staticExplodeSample = "";
  for (const part of parts) {
    if (spec.explode && part.explode === undefined && !OVERLAY_KINDS.has(part.kind)) {
      staticExplodeCount++;
      if (!staticExplodeSample) staticExplodeSample = part.id;
    }
    if (part.slide && !part.slide.state && !part.slide.oscillate) {
      warnings.push(`part "${part.id}" slide needs a state slider or oscillate to move`);
    }
  }
  if (staticExplodeCount > 0) {
    warnings.push(`${staticExplodeCount} parts have no explode offset and will stay put (first: "${staticExplodeSample}")`);
  }

  const drawing =
    [...roots].sort(byDepth).map(renderPart).join("") +
    spec.connections.map(connectionMarkup).join("") +
    overlays.map(overlayMarkup).join("");
  const body = `<g data-viewport>${drawing}</g>`;
  const svg = figureSvg({ width: spec.width, height: spec.height, label: spec.label, body, className: "anatomy-svg" });

  const readoutsHtml = spec.readouts.length
    ? `<div class="anatomy-readouts" data-anatomy-readouts>${spec.readouts
        .map(
          (readout) =>
            `<span class="anatomy-readout"><span class="anatomy-readout-label">${attr(readout.label)}</span>` +
            `<span class="anatomy-readout-value" data-anatomy-readout="${readout.id}">&mdash;</span>` +
            (readout.unit ? `<span class="anatomy-readout-unit">${attr(readout.unit)}</span>` : "") +
            "</span>",
        )
        .join("")}</div>`
    : "";
  const controlsSlot = spec.controls.length ? `<div class="chart-sliders anatomy-controls" data-anatomy-controls></div>` : "";
  const infoSlot = `<div class="anatomy-info" data-anatomy-info hidden></div>`;

  const plate = plateHtml({
    fig: spec.fig,
    title: spec.title,
    hint: spec.hint ?? "hover parts for notes",
    readout: spec.readouts[0] ? `${spec.readouts[0].label} —` : "",
    keys: spec.legend.map((key) => ({ mark: key.mark, label: key.label }) as LegendKey),
    caption: spec.caption,
    body: svg + infoSlot + readoutsHtml + controlsSlot,
  });

  const liveParts = parts
    .filter((part) => part.slide || part.explode || (part.kind === "dial" && part.needle))
    .map((part) => {
      const o = originOf(part);
      const entry: AnatomyLiveSpec["parts"][number] = { id: part.id };
      if (part.slide) entry.slide = { ...part.slide };
      if (part.explode) entry.explode = part.explode;
      if (part.kind === "dial" && part.needle) {
        entry.needle = {
          cx: part.center[0] + o[0],
          cy: part.center[1] + o[1],
          z: part.z + o[2],
          r: part.r,
          length: part.needle.length,
          from: part.needle.from,
          to: part.needle.to,
          state: part.needle.state,
        };
      }
      return entry;
    });

  const liveSpec: AnatomyLiveSpec = {
    camera: { origin: P.origin, scale: P.scale ?? 1, azimuth: P.azimuth ?? 45, elevation: P.elevation ?? 30 },
    controls: spec.controls.map((control) =>
      control.kind === "slider"
        ? { id: control.id, kind: "slider", label: control.label, min: control.min, max: control.max, step: control.step, value: control.value }
        : control.kind === "toggle"
          ? { id: control.id, kind: "toggle", label: control.label, value: control.value, group: control.group }
          : control.kind === "button"
            ? { id: control.id, kind: "button", label: control.label, action: control.action }
            : { id: control.id, kind: "select", label: control.label, target: control.target, value: control.value, options: control.options },
    ),
    groups: spec.groups.map((group) => ({ id: group.id, label: group.label, color: group.color ?? "gray", section: group.section })),
    floors: spec.floors.map((floor) => ({ id: floor.id, label: floor.label ?? floor.id })),
    parts: liveParts,
    readouts: spec.readouts.map((readout) => ({
      id: readout.id,
      label: readout.label,
      unit: readout.unit,
      decimals: readout.decimals,
      formula: readout.formula,
    })),
    explode: Boolean(spec.explode),
  };

  const filename = spec.export?.filename ?? (spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 49) || "anatomy-figure");

  return { plate, svg, liveSpec, warnings, filename };
}
