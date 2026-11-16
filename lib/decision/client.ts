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
/** Anchored form of the SAME body — "is the whole token this word set?"
 *  (partitive complements, quoted bare format labels). */
const anchoredRe = (body: string) => new RegExp(`^(?:${body})$`, "iu");

const ARTIFACT_WORD_RES: Record<ArtifactMode, RegExp> = {
  excel: wordRe("spreadsheet|excel|[.]xlsx|workbook|xlsx"),
  docs: wordRe("word ?document|[.]docx|docx|resume|résumé|cv"),
  pdf: wordRe("pdf"),
  ppt: wordRe("power ?point|presentation|[.]pptx|pptx|deck"),
  chart: wordRe("chart"),
  html_render: wordRe("web ?page|landing ?page|html|interactive (?:ui|page|demo|prototype)"),
};
/** Same bodies, anchored: a QUOTED span counts as a deliverable label only
 *  when its whole content is one bare artifact word ("create a \"PDF\""). */
const ARTIFACT_BARE_RES: Record<ArtifactMode, RegExp> = {
  excel: anchoredRe("spreadsheet|excel|[.]xlsx|workbook|xlsx"),
  docs: anchoredRe("word ?document|[.]docx|docx|resume|résumé|cv"),
  pdf: anchoredRe("pdf"),
  ppt: anchoredRe("power ?point|presentation|[.]pptx|pptx|deck"),
  chart: anchoredRe("chart"),
  html_render: anchoredRe("web ?page|landing ?page|html|interactive (?:ui|page|demo|prototype)"),
};

/** Quoted speech, typographic quotes, guillemets, inline code: never user policy or a request. */
const QUOTED_SPAN_RE = /"[^"]*"|“[^”]*”|«[^»]*»|`[^`]*`/g;
/** Alnum-dot-alnum (file.docx, v2.5): a filename/version/decimal, never a
 *  sentence boundary — the dot becomes a space so the clause split keeps
 *  the phrase together (groups preserved verbatim; one char in, one out). */
const INNER_DOT_RE = /([\p{L}\p{N}])\.([\p{L}\p{N}])/gu;

const CREATE_CUE_RE = wordRe(
  "create|creates|created|creating|make|makes|making|build|builds|building|" +
    "rebuild|rebuilds|rebuilt|rebuilding|redraft|redrafts|redrafted|redrafting|" +
    "revise|revises|revised|revising|rework|reworks|reworked|reworking|" +
    "reformat|reformats|reformatted|reformatting|" +
    "generat(?:e|es|ed|ing)|produc(?:e|es|ed|ing)|prepar(?:e|es|ed|ing)|" +
    "writ(?:e|es|ing)|draft|drafts|drafted|drafting|design|designs|designed|designing|" +
    "assemble|assembles|assembled|assembling|give me|gave me|get me|got me|" +
    "send me|sending me|sent me|need|needs|needed|want|wants|wanted|put together|" +
    "would like|d like",
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

/* ── F02 relations (2026-11-16): the artifact relation is TYPED ─────────────
 * A production cue plus an artifact word is not yet a deliverable REQUEST:
 * the word also has a ROLE (destination / source / container / discussed
 * subject / reported-past object) and the clause has a FRAME (didactic vs
 * transactional). These matchers name those roles; none of them is keyed to a
 * specific example, domain, format name or user phrase. Mirrored EXACTLY by
 * rust-backend/crates/ruke-decision/src/engine.rs (same alternation ORDER,
 * consuming Unicode word classes, no lookaround).                                       */

/** Phrase boundary INSIDE a clause: a negation or a reported action governs
 *  its own phrase, never a request that starts after the boundary. */
const SEGMENT_SPLIT_RE = /[,;:—–()\n]+/g;
/** Same character class as CLAUSE_SPLIT_RE, global form for span scanning. */
const CLAUSE_SPAN_RE = /[.!?\n;]+/g;

/** Didactic frame: the turn explains HOW something is produced, or names the
 *  artifact as the SUBJECT being explained. Only fires when the marker sits
 *  between (or before) the production cue and the artifact word. */
const DIDACTIC_RE = wordRe(
  "explain|explains|explained|explaining|teach|teaches|teaching|taught|" +
    "tutorial|tutorials|lesson|lessons|walkthrough|walk me through|learn how|" +
    "how to|how do|how does|how can|how could|how would|how should|steps to|" +
    "step-by-step|guide to|introduction to|demonstrate|demonstrates|demonstrating|" +
    "understand|understands|understood|understanding|comprehend|comprehends|comprehended|comprehending|" +
    "know|knows|knowing|realize|realizes|realized|realizing",
);
/** Past-tense production verbs — a REPORTED action on an existing file. */
const PAST_PRODUCTION_RE = wordRe(
  "made|created|built|wrote|generated|produced|prepared|exported|saved|converted|" +
    "drafted|designed|assembled|gave|sent|rebuilt|revised|printed|shared|delivered|submitted",
);
/** Explicit agents: a reported action needs one; a bare imperative never does. */
const SUBJECT_RE = wordRe(
  "i|we|they|he|she|you|someone|somebody|anyone|anybody|everybody|team|company|" +
    "department|client|colleague|coworker|boss|manager|group|office|classmate|friend",
);
/** Politeness/desire markers: "I wanted a PDF" IS a request, so the reported-past
 *  law must not fire. Scoped to the reported action's own phrase. */
const DESIRE_MODAL_RE = wordRe(
  "want|wants|wanted|wanting|need|needs|needed|needing|like|likes|liked|would|could|" +
    "should|please|kindly|hope|hoped|hoping|wish|wished|request|requesting|" +
    "can you|could you|would you|will you",
);
/** Source-role markers: the artifact word after one is the MATERIAL, not the ask. */
const SOURCE_ROLE_RE = wordRe(
  "from|based on|out of|starting from|extracted from|derived from|imported from|" +
    "scanned from|copied from|copy of|instead of|taken from|read from",
);
/** Container markers naming the FORMAT as the container of the deliverable
 *  ("summary IN PDF", "output AS a pptx"). Longest-first alternation: the
 *  consuming word classes would otherwise stop inside "into"/"formats". */
const CONTAINER_PREP_RE = wordRe("into|in|as|to|formats|format|outputs|output|extensions|extension|forms|form");
/** Only articles/quantifiers may sit between a container marker and the format. */
const FILLER_BETWEEN_RE =
  /^\s*(?:(?:a|an|the|this|that|these|those|my|your|our|their|his|her|its|one|two|new|single|separate|each|another|clean|blank)\s*)*$/i;
/** Metalinguistic mention: a quoted format NAME inside such a clause is a
 *  label being discussed, never the requested deliverable. */
const META_LINGUISTIC_RE = wordRe(
  "term|terms|phrase|phrases|expression|expressions|means|meaning|called|named|syntax|" +
    "says|said|quote|quoted|quoting|definition|literally|refers to|referred to|spelling",
);
/** Partitive complement right after a polysemous lexeme ("deck OF cards"). */
const PARTITIVE_RE = /^\s*of\s+(?:the\s+|a\s+|an\s+)?([\p{L}][\p{L}']*)/iu;

interface WeakSense {
  /** The lexeme whose sense is ambiguous. */
  lexeme: RegExp;
  /** Anchored set: the partitive complement / nearby domain that CORROBORATES it. */
  corroborated: RegExp;
  /** Competing-sense frame words that suppress it in the same phrase. */
  senseFrame: RegExp;
}
/** A lexeme with a strong non-document sense only routes with its own domain
 *  in reach. "deck" is the documented case (card deck, garden deck); adding a
 *  lexeme here is a general sense table, never an example-specific rule. */
const WEAK_SENSES: Partial<Record<ArtifactMode, WeakSense>> = {
  ppt: {
    lexeme: wordRe("deck"),
    corroborated: anchoredRe("slides|slide|presentation|power ?point|pptx|lecture|talk|pitch"),
    senseFrame: wordRe(
      "card|cards|poker|solitaire|patio|porch|garden|backyard|balcony|roof|decking|wood|" +
        "carpenter|carpentry|stairs|staircase|stair|railing|fence|terrace|veranda|outdoor|" +
        "furniture|sofa|chair",
    ),
  },
};

interface At {
  start: number;
  end: number;
}

function positions(re: RegExp, s: string): At[] {
  const out: At[] = [];
  for (const m of s.matchAll(re)) out.push({ start: m.index!, end: m.index! + m[0].length });
  return out;
}

interface Span {
  start: number;
  end: number;
}

/** Clause/phrase split that KEEPS offsets (F02 needs segment membership, not
 *  just clause text): the text between separator matches, as [start,end). */
function spans(text: string, sep: RegExp): Span[] {
  const out: Span[] = [];
  let from = 0;
  for (const m of text.matchAll(sep)) {
    const at = m.index ?? 0;
    if (at > from) out.push({ start: from, end: at });
    from = at + m[0].length;
  }
  if (from < text.length) out.push({ start: from, end: text.length });
  return out;
}

/**
 * Quote masking with ONE documented exception (F02 rule 7 - label vs mention):
 * a quoted span whose WHOLE content is a bare artifact word inside an explicit
 * production request ('create a "PDF"' / 'make an "xlsx"') labels the
 * deliverable and stays live; a quoted INSTRUCTION ('he said "create a PDF"')
 * or a metalinguistic mention ('the term "presentation"') stays masked. The
 * quote characters are replaced by spaces, so no offset downstream moves.
 */
function maskQuotedSpans(message: string): string {
  const outer = message.replace(QUOTED_SPAN_RE, (s) => " ".repeat(s.length));
  const cueOutside =
    positions(CREATE_CUE_RE, outer).length > 0 || positions(TRANSFORM_CUE_RE, outer).length > 0;
  const metalinguistic = positions(META_LINGUISTIC_RE, outer).length > 0;
  let out = "";
  let from = 0;
  for (const m of message.matchAll(QUOTED_SPAN_RE)) {
    const at = m.index ?? 0;
    out += message.slice(from, at);
    const span = m[0];
    const inner = span.slice(1, -1);
    const bare = Object.values(ARTIFACT_BARE_RES).some((re) => re.test(inner));
    out += bare && cueOutside && !metalinguistic ? " " + inner + " " : " ".repeat(span.length);
    from = at + span.length;
  }
  return out + message.slice(from);
}

/**
 * F02 rule 5 (container role): a format named immediately after a container
 * preposition IS the deliverable, so a content word between the cue and it
 * ("summary IN PDF", "output AS a pptx") never vetoes it. Only an article or a
 * quantifier may sit in the gap - any other word means the container is
 * governing a different phrase.
 */
function containerNamed(clause: string, a: At): boolean {
  for (const c of positions(CONTAINER_PREP_RE, clause)) {
    if (c.start >= a.start) continue;
    if (c.end >= a.start) return true; // adjacent: the classes share the boundary char
    if (FILLER_BETWEEN_RE.test(clause.slice(c.end, a.start))) return true;
  }
  return false;
}

/**
 * F02 rule 6 (polysemy): a lexeme with a strong non-document sense routes only
 * with its own domain in reach. A partitive complement decides directly
 * ("deck OF cards" vs "deck OF slides"); otherwise a competing-sense frame
 * inside the same phrase ("GARDEN deck") suppresses it.
 */
function weakSenseSuppressed(clause: string, seg: Span, mode: ArtifactMode, a: At): boolean {
  const w = WEAK_SENSES[mode];
  if (!w) return false;
  if (!positions(w.lexeme, clause).some((p) => p.start === a.start && p.end === a.end)) return false;
  const part = PARTITIVE_RE.exec(clause.slice(a.end));
  if (part) return !w.corroborated.test(part[1]);
  return positions(w.senseFrame, clause).some((f) => f.start >= seg.start && f.start < seg.end);
}

interface IntentScan {
  /** Requested deliverables, FIRST-APPEARANCE order, deduped. Zero = no
   *  request; two or more = a genuine multi-deliverable turn (never an
   *  arbitrary winner, never a silently dropped second ask). */
  modes: ArtifactMode[];
}

/**
 * The scan: clause by clause, phrase by phrase. Every relation is a typed
 * ROLE (destination / source / container / discussed subject / reported-past
 * object) plus a clause FRAME (didactic vs transactional), decided by
 * MATCH-START ORDER only.
 *
 * Adjacent matches share their boundary character (WB_R of the cue == WB_L of
 * the next word), so cross-match end-vs-start tests are off-by-one against
 * directly adjacent cue->word pairs ("export as xlsx", "make deck"): start
 * order is immune AND stays JS/Rust parity (JS UTF-16 units vs Rust bytes are
 * never compared by distance, only by order; the same-engine gap checks in
 * containerNamed/weakSenseSuppressed slice text BETWEEN two matches, which is
 * content, not an offset space).
 */
function detectDeliverableIntent(message: string): IntentScan {
  const masked = maskQuotedSpans(message).replace(
    INNER_DOT_RE,
    (_all: string, a: string, b: string) => `${a} ${b}`,
  );
  const found: Array<{ mode: ArtifactMode; clause: number; start: number }> = [];
  const clauseSpans = spans(masked, CLAUSE_SPAN_RE);

  for (let ci = 0; ci < clauseSpans.length; ci++) {
    const cs = clauseSpans[ci];
    const clause = masked.slice(cs.start, cs.end);
    if (!clause) continue;
    const creates = positions(CREATE_CUE_RE, clause);
    const transforms = positions(TRANSFORM_CUE_RE, clause);
    const dirs = positions(DIRECTION_RE, clause);
    const negs = positions(NEGATION_RE, clause);
    const metas = positions(META_PHRASE_RE, clause);
    const sources = positions(SOURCE_ROLE_RE, clause);
    const didactics = positions(DIDACTIC_RE, clause);
    const pasts = positions(PAST_PRODUCTION_RE, clause);
    const subjects = positions(SUBJECT_RE, clause);
    const modals = positions(DESIRE_MODAL_RE, clause);
    const cues = [...creates, ...transforms];
    const segs = spans(clause, SEGMENT_SPLIT_RE);
    const inSeg = (ps: At[], seg: Span) =>
      ps.filter((p) => p.start >= seg.start && p.start < seg.end);

    for (const mode of ARTIFACT_MODES) {
      for (const a of positions(ARTIFACT_WORD_RES[mode], clause)) {
        const seg = segs.find((s) => a.start >= s.start && a.start < s.end) ?? {
          start: 0,
          end: clause.length,
        };
        // 1. NEGATION governs its own phrase only. A request that starts
        //    after the phrase boundary survives ("Without using Excel,
        //    create a PDF"); a negation inside the request phrase vetoes it.
        if (inSeg(negs, seg).some((n) => n.start < a.start)) continue;
        // 2. TRANSFORM DIRECTION: convert/export governs the word directly as
        //    the SOURCE format; the word after a to/into/as direction is the output.
        const governedSource = transforms.some(
          (t) => t.start < a.start && !dirs.some((d) => d.start > t.start && d.start < a.start),
        );
        if (governedSource) continue;
        // 3. SOURCE ROLE: "from / based on / out of <format>" marks the word as
        //    the material. One destination + one source is NOT an ambiguity.
        if (
          sources.some(
            (s) => s.start < a.start && !cues.some((c) => c.start > s.start && c.start < a.start),
          )
        )
          continue;
        // 4. DIDACTIC FRAME: a didactic marker between the cue and the word
        //    either puts the production cue inside a how-to ("Explain HOW TO
        //    create a PDF") or names the word as the subject being explained
        //    ("Create a PDF that explains how SPREADSHEETS work").
        if (
          didactics.some(
            (d) =>
              d.start < a.start &&
              (cues.some((c) => c.start > d.start && c.start < a.start) ||
                cues.some((c) => c.start < d.start)),
          )
        )
          continue;
        // 5. REPORTED PAST ACTION: an explicit agent plus a past-tense
        //    production verb inside one phrase describes an EXISTING file.
        //    Desire/politeness ("I wanted a PDF") is exempt.
        if (
          inSeg(pasts, seg).some(
            (p) =>
              p.start < a.start &&
              inSeg(subjects, seg).some((s) => s.start < p.start) &&
              inSeg(modals, seg).length === 0,
          )
        )
          continue;
        // 6. DISCUSSED MATERIAL: a summary/outline-style word between the cue
        //    and the format marks the format as the subject - UNLESS the
        //    format is named as the container ("summary IN PDF" -> pdf).
        const metaGap =
          metas.some(
            (m) =>
              m.start < a.start &&
              (creates.some((c) => c.start < m.start) || transforms.some((t) => t.start < m.start)),
          ) && !containerNamed(clause, a);
        if (metaGap) continue;
        // 7. POLYSEMY: a weak lexeme needs its own domain in reach.
        if (weakSenseSuppressed(clause, seg, mode, a)) continue;
        // 8. BINDING: a production cue (or a transform + direction) precedes it.
        const createBound = creates.some((c) => c.start < a.start);
        const transformBound = transforms.some(
          (t) => t.start < a.start && dirs.some((d) => d.start > t.start && d.start < a.start),
        );
        if (createBound || transformBound) {
          found.push({ mode, clause: ci, start: a.start });
          break;
        }
      }
    }
  }

  found.sort((x, y) => x.clause - y.clause || x.start - y.start);
  const modes: ArtifactMode[] = [];
  for (const f of found) if (!modes.includes(f.mode)) modes.push(f.mode);
  return { modes };
}

/**
 * No Python, no second LLM: the envelope is built locally in ~0ms.
 *
 * `stripped_prompt` is the message verbatim - the main model (:8080) decides
 * what to render from the user's own words + the injected skill block; the UI
 * never hard-gates fences on this envelope (see
 * `MarkdownRenderer.kindAllowed` - always true).
 */
export function getDecisionSync(
  message: string,
  _conversationHistory: { role: string; content: string }[] = [],
): DecisionEnvelope {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return fallbackEnvelope("");
  const { modes } = detectDeliverableIntent(trimmed);
  const single = modes.length === 1 ? modes[0] : null;
  const active = single ?? "standard_chat";
  return {
    active_mode: active,
    // Honest confidence: 0.8 only for a verb-bound SINGLE intent; 0.5 for a
    // miss and for a multi-deliverable turn (the scan cannot claim which one).
    confidence: single ? 0.8 : 0.5,
    // F02 honest vocabulary: the outcome names itself. A miss is NOT reported
    // as a match, and two deliverables are NOT reported as mere ambiguity.
    decided_by:
      modes.length === 0
        ? "in-process-deliverable-none"
        : modes.length === 1
          ? "in-process-deliverable-match"
          : "in-process-deliverable-multiple",
    stripped_prompt: trimmed, // never rewritten
    skill_to_load: single ? MODE_SKILL[single] : null,
    allowed_code_fence: null, // the contract inside the skill block names it
    disable_validators: RENDERER_MODES.filter((m) => m !== active) as RendererMode[],
    enable_validator: active,
    // F02: requested deliverables are recorded explicitly, in first-appearance
    // order, so a multi-deliverable turn can arm EVERY requested contract
    // instead of silently losing one. Provenance: this in-process scan.
    task_constraints: modes.map((m) => `deliverable-request=${m}`),
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
