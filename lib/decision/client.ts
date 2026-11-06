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
 *      (excel / docs / pdf / ppt / anatomy / chart / html).
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
  anatomy: /\b(?:anatomy|cutaway|cross-section|isometric|exploded)\b/i,
  chart: /\bchart\b/i,
  html_render: /\b(?:web ?page|landing ?page|html|interactive (?:ui|page|demo|prototype))\b/i,
};

/*
 * Anatomy over-trigger (2026-11-06 audit, finding 5).
 *
 * One bare keyword used to be enough: "What is the anatomy of the knee?" and
 * "What is an isometric exercise?" both matched `anatomy` and got the anatomy
 * renderer plus its skill block, even though they are a definition question
 * and a fitness question. Anatomy is the ONLY intent whose words name a
 * subject rather than a deliverable — "spreadsheet" is always a spreadsheet,
 * but "anatomy" is usually just what the user wants to talk about.
 *
 * So the anatomy rule is now vocabulary MINUS conversational frames: the
 * vocabulary must not sit inside an ask/definition/explanation frame, and the
 * two domain senses ("isometric exercise", "anatomy exam") are their own
 * frames. The frames are tight word sequences — no unbounded gaps, no
 * lookaheads — so the Rust port (`crates/ruke-decision/src/engine.rs`,
 * `anatomy_intent`) mirrors them pattern-for-pattern with the same bridge
 * classes the other matchers use (JS `\b` is ASCII-only, and the Rust `regex`
 * crate has no lookahead: hence match-then-reject, never a lookahead).
 *
 * Deliberately NOT excluded: an unframed noun phrase ("anatomy of a jet
 * turbine" — a golden-fixture illustration request). The rule keys off the
 * conversational frame, not off a missing ask verb; a false negative is cheap
 * because the UI never hard-gates fences (`kindAllowed` is always true), so
 * the model can still emit an ```anatomy block in a standard_chat turn.
 */
const ANATOMY_VOCAB = "anatomy|cutaway|cross-section|isometric|exploded";
/** Bridge class shared with the Rust port: a non-word char (JS ASCII `\b`). */
const SEP = "[^A-Za-z0-9_]";
/** Articles are optional inside a frame; longest alternative first. */
const ART = "(?:the|this|that|these|those|an|a)";
const VOCAB = `(?:${ANATOMY_VOCAB})(?:${SEP}|$)`;
const ART_GAP = `(?:${ART}${SEP}+)?`;

/** Frames that turn anatomy vocabulary into a topic mention, not a request. */
const ANATOMY_FRAMES: RegExp[] = [
  // "what/how/why is | are | does ... (the) <vocab>"
  new RegExp(`(?:^|${SEP})(?:what|how|why)${SEP}+(?:'s|is|are|was|were|does|do|did)${SEP}+${ART_GAP}${VOCAB}`, "i"),
  // contraction: "what's anatomy", "how's a cutaway different..."
  new RegExp(`(?:^|${SEP})(?:what's|whats|how's|hows)${SEP}+${ART_GAP}${VOCAB}`, "i"),
  // "define <vocab>", "meaning of (the) <vocab>", "definition of <vocab>"
  new RegExp(`(?:^|${SEP})(?:define|definition|meaning)${SEP}+(?:of${SEP}+)?${ART_GAP}${VOCAB}`, "i"),
  // "tell me about (the) <vocab>"
  new RegExp(`(?:^|${SEP})tell${SEP}+me${SEP}+(?:about|of)${SEP}+${ART_GAP}${VOCAB}`, "i"),
  // "explain / describe / discuss (the) <vocab>"
  new RegExp(`(?:^|${SEP})(?:explain|describe|discuss)${SEP}+${ART_GAP}${VOCAB}`, "i"),
  // the other senses of these words: fitness ("isometric exercise") and
  // school subject ("anatomy exam / quiz / class")
  new RegExp(`(?:^|${SEP})isometric${SEP}+(?:exercis|workout|muscle|train|plank|yoga|physio|rehab)[A-Za-z]*`, "i"),
  new RegExp(`(?:^|${SEP})anatomy${SEP}+(?:exam|quiz|test|class|course|chapter|student|study|revision|flashcard|lecture|homework|syllabus|worksheet)[A-Za-z]*`, "i"),
];

/** First matching intent wins; order follows expected user intent frequency. */
const INTENT_ORDER: Exclude<RendererMode, "standard_chat">[] = [
  "excel", "docs", "pdf", "ppt", "chart", "anatomy", "html_render",
];

function anatomyIntent(message: string): boolean {
  if (!INTENT_MATCHERS.anatomy.test(message)) return false;
  return !ANATOMY_FRAMES.some((frame) => frame.test(message));
}

function detectDeliverableIntent(message: string): Exclude<RendererMode, "standard_chat"> | null {
  for (const mode of INTENT_ORDER) {
    if (mode === "anatomy") {
      if (anatomyIntent(message)) return mode;
      continue; // rejected frames never fall through to the other matchers
    }
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

