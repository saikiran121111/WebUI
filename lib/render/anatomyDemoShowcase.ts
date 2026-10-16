import type { Conversation, Message } from "../types";

export const ANATOMY_DEMO_CONVERSATION_ID = "demo_anatomy_showcase";

/**
 * Deterministic Anatomy showcase used by the `/demo-anatomy` command and the
 * `?demo=anatomy` query trigger. It renders five crafted isometric figures —
 * a single-cylinder head, a dial indicator, a hydraulic hand pump, a
 * connection-pool analogy, and an advanced-profile architectural cutaway —
 * entirely client-side through the Anatomy builder and live engine, with no
 * model server involved.
 */

function fence(spec: unknown): string {
  return "```anatomy\n" + JSON.stringify(spec, null, 2) + "\n```";
}

const HEAD_SPEC = {
  title: "Single-cylinder head",
  fig: "FIG 1",
  label: "Cutaway single-cylinder head with a sliding piston",
  width: 560,
  height: 420,
  parts: [
    { id: "deck", tone: "base", kind: "slab", plan: { x: -40, y: -30, w: 80, d: 60, r: 6 }, z: 0, height: 14, label: "Deck", note: "Crankcase deck" },
    { id: "barrel", tone: "structure", kind: "cylinder", center: [0, 0], r: 22, z: 14, height: 46, label: "Cylinder barrel", on: "deck", explode: [0, 0, 18] },
    { id: "piston", tone: "subject", kind: "cylinder", center: [0, 0], r: 20, z: 18, height: 16, label: "Piston", on: "deck", slide: { axis: "z", from: 2, to: 26, state: "stroke" }, note: "Runs in the bore" },
    { id: "plug", tone: "accent", kind: "cylinder", center: [0, 0], r: 3, z: 60, height: 8, label: "Spark plug", on: "deck" },
  ],
  controls: [{ id: "stroke", kind: "slider", label: "Piston position", min: 0, max: 1, step: 0.01, value: 0.5 }],
  readouts: [{ id: "pos", label: "Piston height", unit: "mm", decimals: 1, formula: "18 + 24 * stroke" }],
  explode: { label: "Explode" },
  caption: "The slider and the height readout share one state model — drag the slider and the number is the piston's actual position.",
  export: { filename: "single-cyl-head" },
};

const DIAL_SPEC = {
  title: "Dial indicator",
  fig: "FIG 2",
  label: "Dial indicator: plunger travel drives a live needle",
  width: 480,
  height: 400,
  parts: [
    { id: "case", tone: "base", kind: "cylinder", center: [0, 0], r: 30, z: 24, height: 16, label: "Case", note: "Houses the rack and pinion" },
    { id: "bezel", tone: "structure", kind: "cylinder", center: [0, 0], r: 32, z: 40, height: 3, label: "Bezel", on: "case" },
    {
      id: "face", tone: "subject", kind: "dial", center: [0, 0], z: 43, r: 26, label: "Dial face", on: "case",
      ticks: { count: 50, every: 5, minor: 1.5, major: 3, from: -135, span: 270 },
      needle: { from: -135, to: 135, state: "lift", length: 0.85 },
    },
    { id: "plunger", tone: "structure", kind: "rod", path: [[0, 0, 6], [0, 0, 26]], r: 4, label: "Plunger", note: "Lifts as the measured part moves", slide: { axis: "z", from: 0, to: 6, state: "lift" } },
    { id: "jewel", tone: "accent", kind: "screws", plan: { x: -20, y: -20, w: 40, d: 40, r: 0 }, z: 41, label: "Bearing jewel", on: "case" },
  ],
  controls: [{ id: "lift", kind: "slider", label: "Plunger lift", min: 0, max: 1, step: 0.01, value: 0.35 }],
  readouts: [{ id: "mm", label: "Lift", unit: "mm", decimals: 2, formula: "0.8 * lift" }],
  caption: "The needle angle and the millimetre readout are the same measurement, recomputed from one slider.",
  export: { filename: "dial-indicator" },
};

const PUMP_SPEC = {
  title: "Hydraulic hand pump",
  fig: "FIG 3",
  label: "Hydraulic pump: lever, ram and delivery port",
  width: 560,
  height: 400,
  parts: [
    { id: "tank", tone: "base", kind: "slab", plan: { x: -55, y: -25, w: 110, d: 50, r: 6 }, z: 0, height: 22, label: "Reservoir", note: "Oil reservoir" },
    { id: "bore", tone: "structure", kind: "cylinder", center: [25, 0], r: 10, z: 22, height: 46, label: "Pump bore", on: "tank", explode: [0, 0, 16] },
    { id: "ram", tone: "subject", kind: "cylinder", center: [25, 0], r: 8, z: 24, height: 14, label: "Ram", on: "tank", slide: { axis: "z", from: 0, to: 26, state: "stroke" }, note: "Two-stage ram" },
    { id: "seal", tone: "accent", kind: "cylinder", center: [25, 0], r: 9, z: 38, height: 3, label: "Piston seal", on: "tank", note: "Wear part — replace when it leaks" },
    { id: "lever", tone: "structure", kind: "rod", path: [[-50, 0, 34], [-15, 0, 34], [-3, 0, 48]], r: 3, label: "Lever", on: "tank" },
    { id: "port", tone: "structure", kind: "rod", path: [[35, 0, 30], [50, 0, 30], [50, 18, 30]], r: 3, label: "Delivery port", on: "tank" },
  ],
  controls: [{ id: "stroke", kind: "slider", label: "Pump stroke", min: 0, max: 1, step: 0.01, value: 0.4 }],
  readouts: [{ id: "disp", label: "Displacement", unit: "cc", decimals: 1, formula: "3.14 * 64 * 26 * stroke / 1000" }],
  explode: { label: "Explode" },
  caption: "Two-stage pump: the small ram trades stroke length for force.",
  export: { filename: "hydraulic-pump" },
};

const POOL_SPEC = {
  title: "Connection pool",
  fig: "FIG 4",
  label: "Connection pool drawn as a tank of reusable service lines",
  width: 520,
  height: 380,
  parts: [
    { id: "tank", tone: "base", kind: "slab", plan: { x: -48, y: -22, w: 96, d: 44, r: 8 }, z: 0, height: 24, label: "Pool", note: "Holds up to 3 open connections" },
    { id: "line1", tone: "structure", kind: "cylinder", center: [-28, 0], r: 4, z: 24, height: 12, label: "Idle line 1", on: "tank" },
    { id: "line2", tone: "structure", kind: "cylinder", center: [0, 0], r: 4, z: 24, height: 12, label: "Idle line 2", on: "tank" },
    { id: "line3", tone: "structure", kind: "cylinder", center: [28, 0], r: 4, z: 24, height: 12, label: "Idle line 3", on: "tank" },
    { id: "request", tone: "subject", kind: "slab", plan: { x: -14, y: -40, w: 28, d: 14, r: 3 }, z: 24, height: 6, label: "Waiting request", on: "tank", slide: { axis: "y", from: -12, to: 0, state: "load" }, note: "Slides in as load rises" },
    { id: "gate", tone: "accent", kind: "knob", center: [48, 0], r: 6, z: 24, height: 6, knurl: 10, label: "Admission gate", on: "tank", note: "Opens when a line is free" },
  ],
  controls: [{ id: "load", kind: "slider", label: "Request load", min: 0, max: 1, step: 0.01, value: 0.5 }],
  readouts: [{ id: "idle", label: "Idle lines", unit: "of 3", decimals: 0, formula: "3 - round(3 * load)" }],
  caption: "Analogy, not a machine: requests borrow idle lines and return them. The idle count is computed from the same load value that moves the request.",
  export: { filename: "connection-pool" },
};

/**
 * Medium-complexity architectural cutaway on the ADVANCED profile — the
 * milestone fixture that exercises every v2 runtime feature: reusable floor
 * modules (one module, six instantiated levels), layer groups with collapsible
 * sections, floor/system inspection selects, clickable parts with info panels,
 * a visibility-gated part, action buttons, and flow animations that follow
 * schema-defined service routes.
 */
const ARCH_SPEC = {
  title: "Six-level service core cutaway",
  fig: "FIG 5",
  label: "Cutaway of a six-level office block: one reusable floor module, four service systems",
  profile: "advanced",
  width: 640,
  height: 520,
  groups: [
    { id: "structure", label: "Structure", color: "gray", section: "Structure" },
    { id: "facade", label: "Facade", color: "gray", section: "Structure" },
    { id: "hvac", label: "HVAC", color: "cyan", section: "Services" },
    { id: "electrical", label: "Electrical", color: "amber", section: "Services" },
    { id: "water", label: "Water", color: "blue", section: "Services" },
    { id: "circulation", label: "Circulation", color: "green", section: "Circulation" },
  ],
  floors: [
    { id: "f1", z: 0, height: 24, label: "Level 1", module: "floor-unit" },
    { id: "f2", z: 26, height: 24, label: "Level 2", module: "floor-unit" },
    { id: "f3", z: 52, height: 24, label: "Level 3", module: "floor-unit" },
    { id: "f4", z: 78, height: 24, label: "Level 4", module: "floor-unit" },
    { id: "f5", z: 104, height: 24, label: "Level 5", module: "floor-unit" },
    { id: "f6", z: 130, height: 24, label: "Level 6", module: "floor-unit" },
  ],
  modules: [
    {
      id: "floor-unit",
      parts: [
        { id: "plate", tone: "base", kind: "slab", plan: { x: -46, y: -30, w: 92, d: 60, r: 2 }, z: 0, height: 4, label: "Floor plate", group: "structure" },
        { id: "office-a", tone: "subject", kind: "cylinder", center: [-26, 10], r: 8, z: 4, height: 18, label: "Office cluster A", group: "structure", on: "plate", info: "Reusable floor module — authored once, instantiated per level" },
        { id: "office-b", tone: "subject", kind: "cylinder", center: [26, -10], r: 8, z: 4, height: 18, label: "Office cluster B", group: "structure", on: "plate", info: "Reusable floor module — authored once, instantiated per level" },
        { id: "mep-unit", tone: "structure", kind: "slab", plan: { x: 14, y: 16, w: 12, d: 8, r: 1 }, z: 4, height: 6, label: "MEP unit", group: "hvac", on: "plate" },
      ],
    },
  ],
  parts: [
    { id: "foundation", tone: "base", kind: "slab", plan: { x: -50, y: -34, w: 100, d: 68, r: 3 }, z: -6, height: 6, label: "Foundation raft", group: "structure", info: "Raft supporting the core and the facade columns" },
    { id: "core-shaft", tone: "structure", kind: "rod", path: [[0, 0, -6], [0, 0, 154]], r: 6, label: "Circulation core", group: "circulation", info: "Stair and lift core serving every level" },
    { id: "col1", tone: "structure", kind: "rod", path: [[-46, -30, -6], [-46, -30, 154]], r: 2.5, label: "Facade column 1", group: "facade" },
    { id: "col2", tone: "structure", kind: "rod", path: [[46, -30, -6], [46, -30, 154]], r: 2.5, label: "Facade column 2", group: "facade" },
    { id: "col3", tone: "structure", kind: "rod", path: [[-46, 30, -6], [-46, 30, 154]], r: 2.5, label: "Facade column 3", group: "facade" },
    { id: "col4", tone: "structure", kind: "rod", path: [[46, 30, -6], [46, 30, 154]], r: 2.5, label: "Facade column 4", group: "facade" },
    { id: "hvac-trunk", tone: "subject", kind: "rod", path: [[-34, -24, 150], [-34, -24, 10]], r: 2.5, label: "HVAC trunk", group: "hvac" },
    { id: "water-riser", tone: "subject", kind: "rod", path: [[34, -24, 150], [34, -24, 10]], r: 2, label: "Water riser", group: "water" },
    { id: "energy-riser", tone: "subject", kind: "rod", path: [[-34, 24, 150], [-34, 24, 10]], r: 2, label: "Electrical riser", group: "electrical" },
    { id: "chiller", tone: "structure", kind: "cylinder", center: [30, 18], r: 8, z: 158, height: 10, label: "Chiller plant", group: "hvac", explode: [0, 0, 34] },
    { id: "tank", tone: "structure", kind: "cylinder", center: [-14, 18], r: 6, z: 158, height: 10, label: "Break tank", group: "water", explode: [0, 0, 34] },
    { id: "pv-array", tone: "accent", kind: "slab", plan: { x: -40, y: 12, w: 56, d: 16, r: 1 }, z: 158, height: 3, label: "PV array", group: "electrical", visibleWhen: "tPv", explode: [0, 0, 40], info: "Rooftop solar — shown only while the PV toggle is on" },
    { id: "canopy", tone: "base", kind: "slab", plan: { x: -50, y: -34, w: 100, d: 68, r: 3 }, z: 154, height: 4, label: "Roof canopy", group: "facade", explode: [0, 0, 26] },
    { id: "plaza", tone: "base", kind: "slab", plan: { x: -12, y: -42, w: 24, d: 10, r: 2 }, z: -4, height: 2, label: "Entrance plaza", group: "circulation" },
  ],
  connections: [
    { id: "conn-hvac", system: "hvac", from: "chiller", to: "hvac-trunk", label: "Cool-air trunk run", path: [[30, 18, 158], [-30, -20, 158], [-34, -24, 150], [-34, -24, 10]] },
    { id: "conn-water", system: "water", from: "tank", to: "water-riser", label: "Potable riser", path: [[-14, 18, 158], [20, -24, 158], [34, -24, 150], [34, -24, 10]] },
    { id: "conn-energy", system: "electrical", from: "pv-array", to: "energy-riser", label: "PV distribution", path: [[-12, 20, 158], [-34, 24, 156], [-34, 24, 10]] },
    { id: "conn-circ", system: "circulation", from: "plaza", to: "core-shaft", label: "Occupant route", path: [[0, -37, -4], [0, -20, 0], [0, 0, 10], [0, 0, 150]] },
  ],
  flows: [
    { id: "flow-hvac", connection: "conn-hvac", speed: 1.4, label: "Cool air" },
    { id: "flow-water", connection: "conn-water", speed: 1, label: "Potable water" },
    { id: "flow-energy", connection: "conn-energy", speed: 2.2, label: "Energy" },
    { id: "flow-circ", connection: "conn-circ", speed: 0.7, label: "Movement" },
  ],
  controls: [
    { id: "tStructure", kind: "toggle", label: "Structure", value: true, group: "structure" },
    { id: "tFacade", kind: "toggle", label: "Facade", value: true, group: "facade" },
    { id: "tHvac", kind: "toggle", label: "HVAC", value: true, group: "hvac" },
    { id: "tWater", kind: "toggle", label: "Water", value: true, group: "water" },
    { id: "tEnergy", kind: "toggle", label: "Electrical", value: true, group: "electrical" },
    { id: "tCirc", kind: "toggle", label: "Circulation", value: true, group: "circulation" },
    { id: "tPv", kind: "toggle", label: "PV array", value: true },
    { id: "bExplode", kind: "button", label: "Explode", action: "explode" },
    { id: "bRestore", kind: "button", label: "Restore", action: "restore" },
    { id: "bPlay", kind: "button", label: "Play flows", action: "play" },
    { id: "bPause", kind: "button", label: "Pause", action: "pause" },
    { id: "bReset", kind: "button", label: "Reset", action: "reset" },
    { id: "selFloor", kind: "select", label: "Floor", target: "floor" },
    { id: "selSystem", kind: "select", label: "System", target: "system" },
  ],
  readouts: [
    { id: "levels", label: "Levels", unit: "floors", decimals: 0, formula: "6" },
    { id: "liveSystems", label: "Systems on", unit: "of 4", decimals: 0, formula: "tHvac + tWater + tEnergy + tCirc" },
  ],
  legend: [
    { mark: "dotted", label: "Service route (dashed)" },
    { mark: "blue", label: "Water flow" },
    { mark: "green", label: "Circulation flow" },
    { mark: "lit", label: "PV / energy accent" },
  ],
  explode: { label: "Explode roof" },
  caption: "Advanced profile: six levels share ONE reusable floor module. Layer toggles, floor/system inspection, clickable parts with info panels, and flow animations that follow the schema's service routes.",
  export: { filename: "service-core-cutaway" },
};

const SHOWCASE_MARKDOWN = [
  "## Anatomy illustration showcase",
  "",
  "Five crafted isometric technical illustrations, built from the Anatomy kit's deterministic geometry — every figure is an SVG vector plate, not a 3D mesh.",
  "Each figure's numbers come from the same live state model that drives its motion.",
  "",
  fence(HEAD_SPEC),
  "",
  fence(DIAL_SPEC),
  "",
  fence(PUMP_SPEC),
  "",
  fence(POOL_SPEC),
  "",
  fence(ARCH_SPEC),
].join("\n");

export const ANATOMY_DEMO_MARKDOWN = SHOWCASE_MARKDOWN;

function demoMessage(id: string, role: "user" | "assistant", content: string, now: number): Message {
  return {
    id,
    conversationId: ANATOMY_DEMO_CONVERSATION_ID,
    role,
    content,
    reasoning: "",
    attachments: [],
    toolCalls: [],
    citations: [],
    createdAt: now,
    finishedAt: now,
    state: "complete",
    mode: "chat",
  };
}

export function buildAnatomyDemoConversation(): Conversation {
  const now = Date.now();
  const messages = [
    demoMessage("anatomy_demo_u1", "user", "/demo-anatomy", now),
    demoMessage("anatomy_demo_a1", "assistant", SHOWCASE_MARKDOWN, now),
  ];
  return {
    id: ANATOMY_DEMO_CONVERSATION_ID,
    meta: {
      id: ANATOMY_DEMO_CONVERSATION_ID,
      title: "Anatomy illustration showcase",
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      mode: "chat",
      preview: "Anatomy illustration showcase",
      messageCount: messages.length,
    },
    messages,
  };
}
