/**
 * In-process decision routing (2026-10-22 rewrite; §4a intent law 2026-11-13).
 *
 * The old :8790 Hybrid Decision Engine (a Python worker + a second LFM2.5
 * llama-server on :8791) spent ~1.36 GB of RAM to classify every turn,
 * rewrite the user's message (`stripped_prompt`), and pin which renderer
 * the UI was allowed to mount. That classification kept misfiring on
 * chit-chat and, when it flipped a valid ```xlsx block to "standard_chat",
 * the studio viewer never mounted.
 *
 * Decision is made IN-PROCESS, cheaply, without ever touching the user's
 * message:
 *
 *   1. The §4a intent law below decides whether the turn REQUESTS a
 *      deliverable (excel / docs / pdf / ppt / chart / html).
 *   2. The matched .cskills skill bundle + the mode's output contract are
 *      injected as ONE system block — the main model (:8080) sees the
 *      available studio fences and writes the right fenced block itself.
 *      Skill loading stays lazy: no intent, no block, zero skill tokens.
 *   3. `stripped_prompt` is ALWAYS the original message, verbatim. No
 *      prompt rewrite ever happens in this file.
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

/* ── §4a intent law (2026-11-13 brief) ────────────────────────────────────
 * An artifact WORD is not an artifact REQUEST. The pre-§4a matchers fired on
 * bare noun mentions ("What is a PDF?" -> pdf mode, "Explain a deck of
 * cards." -> ppt), INTENT_ORDER gave arbitrary first-match precedence to
 * mixed-deliverable prompts, and every envelope claimed confidence 1 for
 * all of it. The law now:
 *
 *   1. PROVENANCE: quoted spans ("..." / “...” / «...» / `code`) are masked
 *      before scanning — explaining a phrase never requests it.
 *   2. CLAUSE BINDING: text splits on [.!?\n;]+; cues bind only inside
 *      their own clause. A dot BETWEEN two alphanumerics ("file.docx",
 *      "2.5") is NOT a clause boundary — it becomes a space first, so
 *      filenames / versions / decimals survive the split (§5: preserve
 *      identifiers and numbers) and their cue still binds.
 *   3. PRODUCTION CUE REQUIRED: an artifact word counts as requested only
 *      when a production cue (create/make/build/...) PRECEDES it inside
 *      the same clause (cues/artifacts/directions/negations/meta words are
 *      compared by MATCH-START ORDER only — adjacent matches share their
 *      boundary character, so end-vs-start tests are off-by-one there).
 *      The cue vocabulary is ENGLISH-ONLY —
 *      a documented limitation: a non-Latin production verb with a Latin
 *      artifact word falls to standard_chat (graceful; the main model
 *      still receives the full message and may fence freely).
 *   4. NEGATION VETO: a negation cue (not/no/never/without/...) earlier
 *      than the artifact word vetoes that occurrence.
 *   5. TRANSFORM DIRECTION: convert/turn into/export/save govern an
 *      artifact word directly (no to/into/as between) as the SOURCE
 *      format — never a request; the word after the direction word is
 *      the requested output ("Convert the PDF to Excel" -> excel).
 *   6. META PHRASES: a summary/outline/about-style word between the cue
 *      and the artifact marks the artifact as discussed material, not
 *      the requested deliverable ("write a summary of the pdf").
 *   7. NO PRECEDENCE: two or more requested intents = a real mixed
 *      deliverable -> honest standard_chat ambiguity ("in-process-
 *      deliverable-ambiguous"), never one arbitrary winner.
 *   8. HONEST CONFIDENCE: 0.8 for a verb-bound single intent; 0.5 for
 *      ambiguous, miss, and fallback outcomes (the old 1.0 was false).
 *
 * REGEX PARITY (rust-backend/crates/ruke-decision/src/engine.rs mirrors
 * this EXACTLY): no lookaround on either side; identical CONSUMING Unicode
 * word classes `(?:^|[^\p{L}\p{N}_])` / `(?:[^\p{L}\p{N}_]|$)` — JS with
 * the /u flag, Rust's regex crate natively. The retired ASCII-\b quirk
 * (the résumé consuming-tail branch that made "Create a résumé." MISS
 * while "Create a résumé2." matched, and "caféexcel" match) is a
 * documented legacy defect: "caféexcel" no longer splits at the é, and
 * bare "résumé" finally matches its own word. Match offsets compare by
 * ORDER only (JS UTF-16 units vs Rust bytes), so the engines agree on
 * every before/after relation regardless of the indexing space.
 */

type ArtifactMode = Exclude<RendererMode, "standard_chat">;

/** Deterministic scan order (NOT a precedence — precedence is retired). */
const ARTIFACT_MODES: ArtifactMode[] = ["excel", "docs", "pdf", "ppt", "chart", "html_render"];

/**
 * Artifact WORD inventory (a word's mere presence proves nothing — the
 * cue/negation/direction/meta rules above decide whether it is requested).
 */
// §6 generalization: \p{M} (combining marks) joins the word class. Words in
// Telugu/Devanagari/Thai end in marks (vowel signs, virama/matras), so the
// old class treated the END of those words as a boundary — the cue rules
// failed to generalize for exactly the scripts held-out vectors test.
const WB_L = String.raw`(?:^|[^\p{L}\p{N}\p{M}_])`;
const WB_R = String.raw`(?:[^\p{L}\p{N}\p{M}_]|$)`;
const wordRe = (body: string) => new RegExp(`${WB_L}(?:${body})${WB_R}`, "giu");

const ARTIFACT_WORD_RES: Record<ArtifactMode, RegExp> = {
  excel: wordRe("spreadsheet|excel|[.]xlsx|workbook|xlsx"),
  docs: wordRe("word ?document|[.]docx|docx|resume|résumé|cv"),
  pdf: wordRe("pdf"),
  ppt: wordRe("power ?point|presentation|[.]pptx|pptx|deck"),
  chart: wordRe("chart"),
  html_render: wordRe("web ?page|landing ?page|html|interactive (?:ui|page|demo|prototype)"),
};

/** Quoted speech, typographic quotes, guillemets, inline code: never user policy or a request. */
const QUOTED_SPAN_RE = /"[^"]*"|“[^”]*”|«[^»]*»|`[^`]*`/g;
/** Alnum-dot-alnum (file.docx, v2.5): a filename/version/decimal, never a
 *  sentence boundary — the dot becomes a space so the clause split keeps
 *  the phrase together (groups preserved verbatim; one char in, one out). */
const INNER_DOT_RE = /([\p{L}\p{N}])\.([\p{L}\p{N}])/gu;
const CLAUSE_SPLIT_RE = /[.!?\n;]+/;

const CREATE_CUE_RE = wordRe(
  "create|creates|created|creating|make|makes|making|build|builds|building|" +
    "generat(?:e|es|ed|ing)|produc(?:e|es|ed|ing)|prepar(?:e|es|ed|ing)|" +
    "writ(?:e|es|ing)|draft|drafts|drafted|drafting|design|designs|designed|designing|" +
    "assemble|assembles|assembled|assembling|give me|gave me|get me|got me|" +
    "send me|sending me|sent me|need|needs|needed|want|wants|wanted|put together",
);
const TRANSFORM_CUE_RE = wordRe(
  "convert|converts|converted|converting|turn into|turns into|turned into|" +
    "change into|changes into|changed into|translate into|translates into|translated into|" +
    "export|exports|exported|exporting|save|saves|saved|saving|put into|puts into|putting into",
);
const DIRECTION_RE = wordRe("to|into|as");
const NEGATION_RE = wordRe(
  "not|never|cannot|can'?t|cant|won'?t|wont|don'?t|dont|isn'?t|isnt|aren'?t|arent|wasn'?t|wasnt|" +
    "without|avoid|avoids|avoided|avoiding|skip|skips|skipped|exclude|excludes|excluded|excluding|no",
);
const META_PHRASE_RE = wordRe(
  "summary|summaries|synopsis|abstract|overview|outline|about|regarding|" +
    "description|descriptions|analysis|analyses|explanation|explanations",
);

interface At {
  start: number;
  end: number;
}

function positions(re: RegExp, s: string): At[] {
  const out: At[] = [];
  for (const m of s.matchAll(re)) out.push({ start: m.index!, end: m.index! + m[0].length });
  return out;
}

interface IntentScan {
  intent: ArtifactMode | null;
  ambiguous: boolean;
}

/**
 * Clause-by-clause scan of the message (quoted spans masked first).
 * Returns the single requested deliverable, an ambiguity flag (>= 2
 * distinct requested intents), or nothing.
 */
function detectDeliverableIntent(message: string): IntentScan {
  const masked = message
    .replace(QUOTED_SPAN_RE, (span) => " ".repeat(span.length))
    .replace(INNER_DOT_RE, (_all: string, a: string, b: string) => `${a} ${b}`);
  const requested = new Set<ArtifactMode>();

  for (const clause of masked.split(CLAUSE_SPLIT_RE)) {
    if (!clause) continue;
    const creates = positions(CREATE_CUE_RE, clause);
    const transforms = positions(TRANSFORM_CUE_RE, clause);
    const dirs = positions(DIRECTION_RE, clause);
    const negs = positions(NEGATION_RE, clause);
    const metas = positions(META_PHRASE_RE, clause);

    for (const mode of ARTIFACT_MODES) {
      for (const a of positions(ARTIFACT_WORD_RES[mode], clause)) {
        // ALL relational tests use match-START ORDER only (`<` on offsets).
        // Adjacent matches share their boundary character (WB_R of the cue
        // == WB_L of the next word), so cross-match end-vs-start tests were
        // off-by-one against directly adjacent cue->word pairs ("export as
        // xlsx", "make deck", "generate pdf") — a real defect in the old
        // form, bug-for-bug in both engines. Pure start-order comparison is
        // immune AND stays JS/Rust-parity: offsets are compared by ORDER
        // only, never by distance (JS UTF-16 units vs Rust bytes).
        if (negs.some((n) => n.start < a.start)) continue; // negation veto
        const governedSource = transforms.some(
          (t) => t.start < a.start && !dirs.some((d) => d.start > t.start && d.start < a.start),
        );
        if (governedSource) continue; // the convert/export SOURCE format, not the ask
        const metaGap = metas.some(
          (m) =>
            m.start < a.start &&
            (creates.some((c) => c.start < m.start) || transforms.some((t) => t.start < m.start)),
        );
        if (metaGap) continue; // discussed material ("write a summary of the pdf")
        const createBound = creates.some((c) => c.start < a.start);
        const transformBound = transforms.some(
          (t) => t.start < a.start && dirs.some((d) => d.start > t.start && d.start < a.start),
        );
        if (createBound || transformBound) {
          requested.add(mode);
          break;
        }
      }
    }
  }

  if (requested.size === 0) return { intent: null, ambiguous: false };
  if (requested.size >= 2) return { intent: null, ambiguous: true };
  return { intent: [...requested][0], ambiguous: false };
}

/**
 * No Python, no second LLM: the envelope is built locally in ~0ms.
 * `stripped_prompt` is the message verbatim — the main model (:8080)
 * decides what to render from the user's own words + the injected skill
 * block; the UI never hard-gates fences on this envelope (see
 * `MarkdownRenderer.kindAllowed` — always true).
 */
export function getDecisionSync(
  message: string,
  _conversationHistory: { role: string; content: string }[] = [],
): DecisionEnvelope {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return fallbackEnvelope("");
  const scan = detectDeliverableIntent(trimmed);
  const active = scan.intent ?? "standard_chat";
  return {
    active_mode: active,
    // §4a: confidence is honest — a verb-bound single intent is 0.8; every
    // uncertain outcome (ambiguous or miss) is 0.5. The old blanket 1.0
    // claimed certainty the regex scan never had.
    confidence: scan.intent ? 0.8 : 0.5,
    decided_by: scan.ambiguous ? "in-process-deliverable-ambiguous" : "in-process-deliverable-match",
    stripped_prompt: trimmed, // never rewritten
    skill_to_load: scan.intent ? MODE_SKILL[scan.intent] : null,
    allowed_code_fence: null, // the contract inside the skill block names it
    disable_validators: RENDERER_MODES.filter((m) => m !== active) as RendererMode[],
    enable_validator: active,
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
    confidence: 0.5, // §4a: an uncertain no-intent outcome never claims 1.0
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
