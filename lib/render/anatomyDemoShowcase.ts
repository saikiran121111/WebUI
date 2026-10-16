import type { Conversation, Message } from "../types";

export const ANATOMY_DEMO_CONVERSATION_ID = "demo_anatomy_showcase";

/**
 * Deterministic Anatomy showcase used by the `/demo-anatomy` command and the
 * `?demo=anatomy` query trigger. It renders four crafted isometric figures —
 * a single-cylinder head, a dial indicator, a hydraulic hand pump, and a
 * connection-pool analogy — entirely client-side through the Anatomy builder
 * and live engine, with no model server involved.
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

const SHOWCASE_MARKDOWN = [
  "## Anatomy illustration showcase",
  "",
  "Four crafted isometric technical illustrations, built from the Anatomy kit's deterministic geometry — every figure is an SVG vector plate, not a 3D mesh.",
  "Each figure's numbers come from the same live state model that drives its motion.",
  "",
  fence(HEAD_SPEC),
  "",
  fence(DIAL_SPEC),
  "",
  fence(PUMP_SPEC),
  "",
  fence(POOL_SPEC),
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
