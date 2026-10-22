/**
 * In-process decision routing (2026-10-22 rewrite).
 *
 * The old :8790 Hybrid Decision Engine (a Python worker + a second LFM2.5
 * llama-server on :8791) spent ~1.36 GB of RAM to classify every turn,
 * rewrite the user's prompt (`stripped_prompt`), and pin which renderer
 * the UI was allowed to mount. That classification kept misfiring on
 * chit-chat and, when it flipped a valid ```xlsx block to "standard_chat",
 * the studio viewer never mounted.
 *
 * Decision is now made IN-PROCESS, cheaply, without ever touching the
 * user's message:
 *
 *   1. A lightweight keyword match picks the deliverable intent
 *      (excel / docs / pdf / ppt / 3d / cad / chart / html).
 *   2. The matched .cskills skill bundle + the mode's output contract are
 *      injected as ONE system block — the main model (:8080) sees the
 *      available studio fences and writes the right fenced block itself.
 *   3. `stripped_prompt` is ALWAYS the original message, verbatim. No
 *      prompt rewrite ever happens in this file anymore.
 *
 * `warmupDecisionEngine()` is a no-op kept for import compatibility
 * (instrumentation.ts no longer calls it). No process is ever spawned,
 * no port is ever probed.
 */
import { childLogger } from "../server/logger";
import {
  RENDERER_MODES,
  isRendererMode,
  type DecisionEnvelope,
  type RendererMode,
} from "./types";
import { MODE_SKILL } from "./types";

const log = childLogger("decision");

/**
 * Renderer mode → deliverable-intent matchers. Deliberately narrow: the
 * intent words are how users ask for each studio ("spreadsheet", "powerpoint",
 * "an excel file"), not the artifact's content words. On a miss, the turn is
 * standard_chat and no skill block is injected — the user's message still
 * reaches the model untouched.
 */
const INTENT_MATCHERS: Record<Exclude<RendererMode, "standard_chat">, RegExp> = {
  excel: /\b(?:spreadsheet|excel|\.xlsx|workbook|xlsx)\b/i,
  docs: /\b(?:word ?document|\.docx|docx|resume|résumé|cv)\b/i,
  pdf: /\bpdf\b/i,
  ppt: /\b(?:power ?point|presentation|\.pptx|pptx|deck)\b/i,
  "3d_asset": /\b3d\b|\bthree\.?js\b|\b(?:render|model|visualise|visualize)\b.*\b(?:3d|scene|mesh)\b/i,
  cad_blueprint: /\b(?:floor ?plan|architect\w*|blueprint|building|room layout|interior)\b/i,
  chart: /\bchart\b/i,
  html_render: /\b(?:web ?page|landing ?page|html|interactive (?:ui|page|demo|prototype))\b/i,
};

/** First matching intent wins; order follows expected user intent frequency. */
const INTENT_ORDER: Exclude<RendererMode, "standard_chat">[] = [
  "excel", "docs", "pdf", "ppt", "chart", "3d_asset", "cad_blueprint", "html_render",
];

function detectDeliverableIntent(message: string): Exclude<RendererMode, "standard_chat"> | null {
  for (const mode of INTENT_ORDER) {
    if (INTENT_MATCHERS[mode].test(message)) return mode;
  }
  return null;
}

/**
 * No Python, no second LLM: the envelope is built locally in ~0ms.
 * `stripped_prompt` is the message verbatim — the main model (:8080)
 * decides what to render from the user's own words + the injected skill
 * block; the UI no longer hard-gates fences on this envelope (see
 * `MarkdownRenderer.kindAllowed` — always true).
 */
export function getDecisionSync(
  message: string,
  _conversationHistory: { role: string; content: string }[] = [],
): DecisionEnvelope {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return fallbackEnvelope("");
  const intent = detectDeliverableIntent(trimmed);
  return {
    active_mode: intent ?? "standard_chat",
    confidence: 1,
    decided_by: "in-process-deliverable-match",
    stripped_prompt: trimmed, // never rewritten
    skill_to_load: intent ? MODE_SKILL[intent] : null,
    allowed_code_fence: null, // the contract inside the skill block names it
    disable_validators: RENDERER_MODES.filter((m) => m !== (intent ?? "standard_chat")) as RendererMode[],
    enable_validator: intent ?? "standard_chat",
    task_constraints: [],
    extracted_entities: [],
    lfm_latency_ms: 0,
  };
}

// Keep the import surface for app/api/chat and app/api/decision.
async function getDecisionShim(
  message: string,
  conversationHistory: { role: string; content: string }[] = [],
): Promise<DecisionEnvelope> {
  return getDecisionSync(message, conversationHistory);
}

export { getDecisionShim as getDecision };

/** Kept for import compatibility — nothing spawns anymore. */
export function warmupDecisionEngine(): void {
  log.info("warmupDecisionEngine is a no-op since 2026-10-22 (in-process routing)");
}

/** A no-op envelope that keeps chat alive when nothing matches. */
export function fallbackEnvelope(message: string): DecisionEnvelope {
  return {
    active_mode: "standard_chat",
    confidence: 1,
    decided_by: "in-process-fallback",
    stripped_prompt: message,
    skill_to_load: null,
    allowed_code_fence: null,
    disable_validators: RENDERER_MODES.filter((m) => m !== "standard_chat") as RendererMode[],
    enable_validator: "standard_chat",
    task_constraints: [],
    extracted_entities: [],
    lfm_latency_ms: 0,
  };
}

// The legacy `isRendererMode` re-export (used by app/api/chat passthrough).
export { isRendererMode };

