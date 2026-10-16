import type { Conversation, Message } from "../types";

/**
 * Deterministic interactive-UI showcase used by the `/demo-ui` command and
 * the `?demo=ui` query trigger. It renders the full interactive surface —
 * chart with What-If sliders + type switcher, mermaid with step playback,
 * scene3d with pitch/roll/yaw sliders, live KPI cards with formula
 * calculators, and a markdown table — entirely client-side, with no model
 * server involved.
 */

export const DEMO_CONVERSATION_ID = "demo_ui_showcase";

const SHOWCASE_MARKDOWN = [
  "## Interactive UI showcase",
  "",
  "Everything below is generated from fenced blocks and fully interactive:",
  "click marks, toggle the legend, drag the sliders, play the steps, orbit the 3D,",
  "recompute the KPI cards.",
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
    "  %%step: render | Render blocks | Chart, diagram and 3D fences stream into the UI.",
    "  %%step: review | Review together | Follow-up questions drill into any mark or node.",
    "  intake --> plan --> render --> review",
    "  review -->|tune| render",
  ].join("\n"),
  "```",
  "",
  "### 3D scene — orbit by dragging, tune attitude with the sliders",
  "",
  "```scene3d",
  JSON.stringify({
    title: "Lander attitude demo",
    objects: [
      { id: "grid", kind: "grid", position: [0, -1.2, 0] },
      { id: "body", kind: "box", label: "Lander body", position: [0, 0, 0], scale: [1.4, 1, 1.4], color: "#A78BFA" },
      { id: "tank", kind: "cylinder", label: "Fuel tank", position: [0, 1.1, 0], scale: [0.8, 0.9, 0.8], color: "#38BDF8" },
      { id: "dish", kind: "cone", label: "Comms dish", position: [1.3, 0.4, 0], rotation: [0, 0, -1.2], color: "#FBBF24" },
      { id: "ring", kind: "torus", label: "Gyro ring", position: [0, -0.2, 0], rotation: [1.57, 0, 0], color: "#34D399" },
      { id: "thruster", kind: "arrow", label: "Descent thruster", position: [0, -0.9, 0], rotation: [3.14, 0, 0], color: "#FB7185" },
    ],
    sliders: [
      { id: "pitch", label: "Pitch", min: -1.2, max: 1.2, step: 0.01, defaultValue: 0, target: "body", binding: "rotation", axis: "x" },
      { id: "roll", label: "Roll", min: -1.2, max: 1.2, step: 0.01, defaultValue: 0, target: "body", binding: "rotation", axis: "z" },
      { id: "yaw", label: "Yaw", min: -3.14, max: 3.14, step: 0.01, defaultValue: 0, target: "body", binding: "rotation", axis: "y" },
    ],
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
