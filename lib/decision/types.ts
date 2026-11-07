/**
 * Decision Engine contract — the exact DecisionEnvelope shape shared with
 * .decision-engine/worker/schemas.py. Every routing/mode decision BEFORE the
 * main LLM flows through this envelope; frontend renderers and validators
 * gate exclusively on active_mode.
 */

// 3d_asset / cad_blueprint were retired 2026-11-06 (Ruke plan Phase 4):
// saved conversations with ```scene3d/```asset3d/```threejs/```cad fences
// render a read-only compatibility card, never live 3D/CAD viewers.
// anatomy was retired 2026-11-07 by user directive (it grew out of the same
// architecture-design feature); saved conversations with ```anatomy fences
// now render the same compatibility card.
export const RENDERER_MODES = [
  "excel", "docs", "pdf", "ppt",
  "chart", "html_render", "standard_chat",
] as const;

export type RendererMode = (typeof RENDERER_MODES)[number];

export function isRendererMode(value: unknown): value is RendererMode {
  return RENDERER_MODES.includes(value as RendererMode);
}

/** mode -> single core skill in ./.cskills/ (or null). Mirrors schemas.py MODE_MAP. */
export const MODE_SKILL: Record<RendererMode, string | null> = {
  excel: "xlsx",
  docs: "docx",
  pdf: "pdf",
  ppt: "pptx",
  chart: null,
  html_render: "html-viewer",
  standard_chat: null,
};

/** mode -> the ONE code fence its renderer accepts (or null = no fence). */
export const MODE_FENCE: Record<RendererMode, string | null> = {
  excel: "xlsx",
  docs: "docx",
  pdf: "html",
  ppt: "pptx",
  chart: "chart",
  html_render: "html",
  standard_chat: null,
};

export interface DecisionRequest {
  message: string;
  conversationHistory?: { role: string; content: string }[];
}

export interface DecisionEnvelope {
  active_mode: RendererMode;
  confidence: number;
  decided_by: string;
  stripped_prompt: string;
  skill_to_load: string | null;
  allowed_code_fence: string | null;
  /** Every mode whose validators/renderers must NOT inspect this turn's stream. */
  disable_validators: RendererMode[];
  enable_validator: RendererMode;
  task_constraints: string[];
  extracted_entities: string[];
  lfm_latency_ms: number;
  /**
   * Diagnostics for the dev-terminal decision table (lib/server/decision-log.ts).
   * Never used for routing; absent on fallback/passthrough envelopes.
   */
  lfm_input?: string | null;
  lfm_raw?: string | null;
}
