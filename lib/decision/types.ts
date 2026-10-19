/**
 * Decision Engine contract — the exact DecisionEnvelope shape shared with
 * .decision-engine/worker/schemas.py. Every routing/mode decision BEFORE the
 * main LLM flows through this envelope; frontend renderers and validators
 * gate exclusively on active_mode.
 */

export const RENDERER_MODES = [
  "excel", "docs", "pdf", "ppt", "3d_asset",
  "cad_blueprint", "chart", "html_render", "standard_chat",
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
  "3d_asset": "threejs-skills",
  cad_blueprint: "archify",
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
  "3d_asset": "scene3d",
  cad_blueprint: "cad",
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
  needle_latency_ms: number;
  lfm_latency_ms: number;
  /**
   * Diagnostics for the dev-terminal decision table (lib/server/decision-log.ts).
   * Never used for routing; absent on fallback/passthrough envelopes.
   */
  needle_prior?: { modes: RendererMode[]; confidence: number } | null;
  lfm_input?: string | null;
  lfm_raw?: string | null;
}
