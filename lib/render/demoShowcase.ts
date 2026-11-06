import type { Conversation, Message } from "../types";

/**
 * Deterministic interactive-UI showcase used by the `/demo-ui` command and
 * the `?demo=ui` query trigger. It renders the full interactive surface —
 * chart with What-If sliders + type switcher, mermaid with step playback,
 * an SVG anatomy cutaway with a piston slider + explode control, KPI cards
 * calculators, and a markdown table — entirely client-side, with no model
 * server involved.
 */

export const DEMO_CONVERSATION_ID = "demo_ui_showcase";

const SHOWCASE_MARKDOWN = [
  "## Interactive UI showcase",
  "",
  "Everything below is generated from fenced blocks and fully interactive:",
  "click marks, toggle the legend, drag the sliders, play the steps,",
  "explode the anatomy figure, recompute the KPI cards.",
  "",
  "### Chart — click a bar, toggle a series, drag the What-If slider",
  "",
  "```chart",
  JSON.stringify({
    type: "bar",
    title: "Regional Revenue 2026",
    subtitle: "Q1 vs Q2 by region, thousands USD",
    insight: "East grew fastest after the new distribution hub opened in March.",
    unit: "k$",
    categories: ["North", "South", "East", "West"],
    notes: [
      "Mature market, flat growth",
      "Price cuts lifted volume",
      "New distribution hub came online",
      "Supply shortage capped Q1",
    ],
    series: [
      { name: "Q1", data: [42, 28, 31, 24] },
      { name: "Q2", data: [45, 39, 52, 27] },
    ],
    sliders: [
      { id: "growth", label: "What-if growth", min: 0.5, max: 2, step: 0.05, defaultValue: 1, operation: "multiply" },
    ],
  }, null, 2),
  "```",
  "",
  "### Diagram — press Play for synced step playback",
  "",
  "```mermaid",
  [
    "flowchart TD",
    "  %%step: intake | Receive request | The user message arrives and is routed by intent.",
    "  %%step: plan | Plan the answer | The model picks which visual blocks will help.",
    "  %%step: render | Render blocks | Chart and diagram fences stream into the UI.",
    "  %%step: review | Review together | Follow-up questions drill into any mark or node.",
    "  intake --> plan --> render --> review",
    "  review -->|tune| render",
  ].join("\n"),
  "```",
  "",
  "### Anatomy figure — drag the piston slider, press Explode",
  "",
  "```anatomy",
  JSON.stringify({
    title: "Single-cylinder head — cutaway",
    fig: "FIG 2",
    label: "Cutaway single-cylinder head with a sliding piston and an explode control",
    width: 560,
    height: 420,
    parts: [
      { id: "deck", tone: "base", kind: "slab", plan: { x: -40, y: -30, w: 80, d: 60, r: 6 }, z: 0, height: 14, label: "Deck" },
      { id: "barrel", tone: "structure", kind: "cylinder", center: [0, 0], r: 22, z: 14, height: 46, label: "Barrel", on: "deck" },
      { id: "piston", tone: "subject", kind: "cylinder", center: [0, 0], r: 20, z: 18, height: 16, label: "Piston", on: "deck", slide: { axis: "z", from: 2, to: 26, state: "stroke" } },
      { id: "plug", tone: "accent", kind: "cylinder", center: [0, 0], r: 3, z: 60, height: 8, label: "Plug", on: "deck" },
    ],
    controls: [{ id: "stroke", kind: "slider", label: "Piston position", min: 0, max: 1, step: 0.01, value: 0.5 }],
    readouts: [{ id: "pos", label: "Piston height", unit: "mm", decimals: 1, formula: "18 + 24 * stroke" }],
    explode: { label: "Explode" },
    export: { filename: "showcase-head" },
  }, null, 2),
  "```",
  "",
  "### KPI — drag the sliders, click a card for its formula",
  "",
  "```widget",
  JSON.stringify({
    kind: "kpi",
    title: "Unit economics — live what-if",
    insight: "Drag a slider: every bound card value and sparkline recomputes instantly.",
    sliders: [
      { id: "growth", label: "Growth multiplier", min: 0.5, max: 2, step: 0.05, defaultValue: 1 },
      { id: "extra", label: "Extra revenue", min: 0, max: 20, step: 1, defaultValue: 0, unit: "k$" },
    ],
    cards: [
      {
        id: "mrr", label: "Net revenue", value: 52, prefix: "$", unit: "k",
        delta: "+18% QoQ", trend: "up", sparkline: [40, 42, 45, 48, 50, 52],
        formula: "base × growth multiplier", detail: "Recurring revenue across all regions for the latest quarter.",
        bindSlider: "growth", operation: "multiply",
      },
      {
        id: "cogs", label: "Cost of goods", value: 21, prefix: "$", unit: "k",
        delta: "+6% QoQ", trend: "down", sparkline: [18, 19, 19, 20, 21, 21],
        formula: "base × growth multiplier", detail: "Direct costs scale with the same volume driver as revenue.",
        bindSlider: "growth", operation: "multiply",
      },
      {
        id: "margin", label: "Gross margin", value: 31, prefix: "$", unit: "k",
        delta: "+12% QoQ", trend: "up", sparkline: [22, 23, 26, 28, 29, 31],
        formula: "revenue - cost of goods", detail: "What remains after direct costs — the engine of the P&L.",
        bindSlider: "growth", operation: "multiply",
      },
      {
        id: "forecast", label: "Forecast revenue", value: 52, prefix: "$", unit: "k",
        trend: "neutral", sparkline: [44, 46, 48, 50, 51, 52],
        formula: "base + extra revenue slider", detail: "Base revenue plus whatever the extra-revenue slider adds.",
        bindSlider: "extra", operation: "add",
      },
    ],
  }, null, 2),
  "```",
  "",
  "### Table — click a header to sort, right-click a header to filter",
  "",
  "| Region | Q1 (k$) | Q2 (k$) | Growth |",
  "| --- | --- | --- | --- |",
  "| North | 42 | 45 | +7% |",
  "| South | 28 | 39 | +39% |",
  "| East | 31 | 52 | +68% |",
  "| West | 24 | 27 | +13% |",
  "",
  "### Legacy 3D content — compatibility card, never executed",
  "",
  "```scene3d",
  "// A pre-Phase-4 saved scene. The built-in viewer retired 2026-11-06;\n" +
  "// this source is preserved verbatim for copy/download and never runs.\n" +
  "new THREE.Mesh(sphereGeo, steelMat);",
  "```",
].join("\n");

export const DEMO_SHOWCASE_MARKDOWN = SHOWCASE_MARKDOWN;

function demoMessage(id: string, role: "user" | "assistant", content: string, now: number): Message {
  return {
    id,
    conversationId: DEMO_CONVERSATION_ID,
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

export function buildDemoConversation(): Conversation {
  const now = Date.now();
  const messages = [
    demoMessage("demo_u1", "user", "/demo-ui", now),
    demoMessage("demo_a1", "assistant", SHOWCASE_MARKDOWN, now),
  ];
  return {
    id: DEMO_CONVERSATION_ID,
    meta: {
      id: DEMO_CONVERSATION_ID,
      title: "Interactive UI showcase",
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      mode: "chat",
      preview: "Interactive UI showcase",
      messageCount: messages.length,
    },
    messages,
  };
}
