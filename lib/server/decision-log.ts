/**
 * Human-readable decision table for the `npm run dev` terminal.
 *
 * One pino message per chat turn, rendered as an aligned block so the whole
 * routing story is readable at a glance:
 *   - LFM2.5-1.2B (the sole decision router): the exact input it got + its
 *     raw grammar-constrained JSON output
 *   - the skill actually injected (user tier / core tier, bytes)
 *   - the UI component that will render the reply (3d_asset -> 3D viewer, …)
 *   - what the main LLM finally receives (stripped prompt, constraints)
 *
 * pino-pretty (singleLine mode) preserves newlines inside the message, so
 * the block prints as a table. Diagnostic-only: nothing here changes routing.
 */
import type { Logger } from "pino";
import { RENDERER_MODES, type DecisionEnvelope, type RendererMode } from "../decision/types";

/** mode -> the UI component that will actually handle this turn's reply. */
export const MODE_COMPONENT: Record<RendererMode, string> = {
  excel:         "Excel workbook compiler (```xlsx fence)",
  docs:          "Word document renderer (```docx fence)",
  pdf:           "PDF print renderer (```html fence)",
  ppt:           "PowerPoint deck renderer (```pptx fence)",
  "3d_asset":    "3D Scene Viewer — Three.js (```scene3d fence)",
  cad_blueprint: "CAD Blueprint Viewer (```cad fence)",
  chart:         "Chart Renderer (```chart fence)",
  html_render:   "Sandboxed HTML Preview (```html fence)",
  standard_chat: "Plain chat — no renderer, no fence",
};

/** Collapse to one line (newlines -> ⏎) and cap, so table rows stay aligned. */
function flat(s: string | null | undefined, max: number): string {
  if (!s) return "—";
  const t = s.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

export interface DecisionTableInput {
  /** the user's original message for this turn */
  input: string;
  env: DecisionEnvelope;
  /** user-tier slash skill actually injected (null = none) */
  usedSkill?: string | null;
  /** bytes of the <decision_skill> block injected this turn (0 = nothing) */
  skillBlockBytes?: number;
  model?: string;
  totalMs?: number;
}

export function logDecisionTable(log: Logger, o: DecisionTableInput): void {
  const e = o.env;
  const passthrough = e.decided_by === "repair-passthrough";
  const fallback = e.decided_by.startsWith("fallback");
  const r: string[] = [];

  r.push("┌─ DECISION ───────────────────────────────────────────────────────────────");
  r.push(`│ USER      "${flat(o.input, 200)}"`);
  r.push("│");

  r.push(`│ LFM2.5-1.2B · decision router · ${e.lfm_latency_ms}ms`);
  if (passthrough) {
    r.push("│   IN/OUT  skipped — fence-repair round, mode pinned by the client");
  } else if (fallback) {
    r.push("│   IN/OUT  not called — engine unavailable (fallback envelope)");
  } else {
    r.push(`│   IN      "${flat(e.lfm_input, 200)}"`);
    r.push(`│   OUT     ${flat(e.lfm_raw, 300)}`);
  }
  r.push("│");

  r.push("│ ROUTE → WHAT THE UI DOES");
  r.push(`│   MODE        ${e.active_mode} · conf ${e.confidence} · by ${e.decided_by}`);
  r.push(`│   COMPONENT   ${MODE_COMPONENT[e.active_mode]}`);
  const core = e.skill_to_load ? `core:${e.skill_to_load}` : "core:—";
  const user = o.usedSkill ? `user:${o.usedSkill}` : "user:—";
  r.push(`│   SKILLS      ${core} · ${user} · ${o.skillBlockBytes ?? 0}B block injected`);
  r.push(`│   LLM PROMPT  "${flat(e.stripped_prompt, 200)}"`);
  if (e.task_constraints.length) r.push(`│   CONSTRAINTS ${flat(e.task_constraints.join("; "), 180)}`);
  if (e.extracted_entities.length) r.push(`│   ENTITIES    ${flat(e.extracted_entities.join(", "), 180)}`);
  r.push(`│   VALIDATORS  ${e.enable_validator} ON · ${RENDERER_MODES.length - 1} others OFF · fence \`${e.allowed_code_fence ?? "none"}\``);
  if (o.model) r.push(`│   MAIN LLM    model "${o.model}"`);
  r.push(`└─ ${o.totalMs != null ? `${o.totalMs}ms total` : `${e.lfm_latency_ms}ms (lfm)`}`);

  log.info(r.join("\n"));
}
