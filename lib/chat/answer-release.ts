/**
 * answer-release.ts — WS06 (audit 2026-11-05 item 6): the grounded answer
 * RELEASE check for research turns.
 *
 * Audit law (verbatim): "server-enforced action/citation/claim checks before
 * releasing final research assertions, including the normal finish path. A
 * prompt or attached ledger is not enforcement. Buffer answer units or use a
 * bounded draft/verify/release phase; repair or qualify unsupported claims."
 * WEB_TOOL_GUIDANCE already TELLS the model these rules; this module is the
 * part that ENFORCES them on what the model actually streamed — wired by
 * lib/chat/web-tool-loop.ts (content is buffered per round, audited here,
 * then released). Post-MHR-A (2026-11-05) the loop is armed for EVERY
 * progress-path chat turn (no gate prefetch; the model directs the tools);
 * the legacy stream:false path is a plain forward and never runs here.
 *
 * Enforcement is deterministic — never a vibes-model call. MHR-F (WS26,
 * 2026-11-06) split the checks by OWNER:
 *  R1 CITATION INTEGRITY (the harness's, enforced at release): every [S#]
 *    marker must resolve to a citation the SERVER actually minted (pipeline
 *    bundle or tool-minted seeds). The [S#] grammar is a server mint, so an
 *    unresolvable marker is a broken REFERENCE — its bytes are stripped
 *    (whitespace/punctuation residue cleanup only). The sentence's words
 *    are otherwise released UNTOUCHED: the harness never qualifies a claim
 *    "(unverified)", and a minted citation is NEVER removed, moved or
 *    altered — even when an adjacent marker in the same sentence is fake.
 *  R2 SEMANTIC SUPPORT (the model's; diagnosis CLOSED to log telemetry by
 *    the 2026-11-13 brief): the volatile-claim detectors (currency/percent/
 *    rating/temperature/date/coordinate/price- or weather-word + digit, no
 *    resolving [S#]) live in diagnoseResearchAnswer ONLY — written to the
 *    SERVER LOG, never to the model, never rewritten on release. They are
 *    lexical PRIORS that over-match (a '%' in CSS) and under-match; a flag
 *    decides nothing user-visible. Correct local answers (re-stated user
 *    constraints, conversational numbers) release byte-intact.
 *  R3 action check (kept at release): research-claiming wording
 *    ("according to my searches…") on a turn where NOTHING was retrieved
 *    (empty citation map and no successful action in the ledger) gets a
 *    prepended server-attested check line. This is a fact about the
 *    HARNESS's own behavior read from the LEDGER (server record of tool
 *    outcomes), not a rewrite of the model's claims.
 *
 * Protections: fenced code blocks and inline code spans are byte-protected
 * (research answers legitimately carry code/config: stripping [S#]-shaped
 * bytes inside them would corrupt user-facing artifacts). Code fences'
 * [S#] text is literal code content, not a citation contract. Idempotency
 * law: the integrity layer only removes bytes, so released text is safe to
 * persist, replay, and audit again on follow-up turns.
 *
 * MHR-D (brief 2026-11-05) added the NON-DESTRUCTIVE half; the 2026-11-13
 * brief CLOSED its destructive tail. The loop used to RETRACT a flagged
 * answer (an empty-contentText revise erasing live text) and feed ONE
 * byte-locked "[Harness feedback]" message back into the tool loop. That
 * lifecycle silently deleted and regenerated whole answers on a heuristic
 * flag, and its header claimed the answer text "was held back and NOT
 * released to the human" — the feedback bytes never reached the human at
 * all, so the report was not a truthful account of where the text went.
 * diagnoseResearchAnswer now exists for SERVER TELEMETRY ONLY (the loop
 * emits logger.warn / tracing::warn!): released text changes only via
 * R1/R3, the model is never lectured, no streamed text is erased, and no
 * regeneration round is bought by a flag. Detector laws pinned by the
 * matrix (`diagnose`/`separation` sections): DATE VALIDITY — an a/b/c
 * numeral triple is a date only if it reads plausibly as m/d/y or d/m/y
 * with a 2-4 digit year ("31/39/40" compiler line numbers are NOT a date;
 * 05/12/2026 and 12/05/2026 are); HEDGE LAW — the word "unverified" never
 * bypasses the report; CITATION IDENTITY — a resolvable [S#] proves the
 * reference resolves, NOT that its passage supports the sentence.
 *
 * ⇔ Rust `crates/ruke-server/src/chat/answer_release.rs` (wired into
 * chat/web_loop.rs). Both sides read the ONE vendored truth matrix
 * `rust-backend/fixtures/answer-release/matrix.json` — cross-language
 * byte-lock, same pattern as the WEB_TOOL_GUIDANCE probe.
 * Known limitation (documented, not hidden): R3 wording detection is
 * English-phrase-based; the citation and volatile checks (R1/R2) are
 * language-agnostic.
 */

export const SERVER_CHECK_LINE =
  "(Server check: no successful web retrieval this turn — the text below is unverified background knowledge, not research.)";

/* ── volatile-fact shapes (digit gate applied per sentence) ───────────── */

const RE_CURRENCY =
  /[$€£₹¥]\s?\d|\d[\d.,]*\s?(?:USD|EUR|GBP|INR|dollars?|rupees?|euros?|pounds?)(?:\b|(?=[.,;:!?]))/i;
const RE_PERCENT = /\d[\d.,]*\s?(?:%|percent)/i;
const RE_RATING = /\b(?:rated|rating|score|stars?)\b|\bout of \d/i;
const RE_TEMP = /°\s?[CF]\b|\b(?:degrees?|celsius|fahrenheit)\b/i;
// Date law (matrix "D", 2026-11-13): an a/b/c numeral triple is a date
// only when the first two fields fit a PLAUSIBLE m/d OR d/m ordering with
// a 2-4 digit year — compiler line-number/ratio triples ("31/39/40",
// "13/45/2026") are not dates. The alternation is Rust-regex-safe (no
// lookaround; ⇔ answer_release.rs RE_DATE must stay byte-equivalent).
const RE_DATE =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2]))\/\d{2,4}\b/i;
const RE_COORDS = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,2}\.\d{3,}/;
const RE_PRICEWORD =
  /\b(?:price|pricing|cost|costs|fee|fees|paid|subscription|priced|fare|ticket)\b|\bstarts at\b/i;
const RE_WEATHER = /\b(?:weather|forecast|temperature|rain|sunny|humid|wind)\b/i;
const RE_GEOWORD = /\b(?:latitude|longitude|coordinates?|lat|lon)\b/i;

const VOLATILE = [RE_CURRENCY, RE_PERCENT, RE_RATING, RE_TEMP, RE_DATE, RE_COORDS, RE_PRICEWORD, RE_WEATHER, RE_GEOWORD];

/* ── research-claiming wording (R3; English-only — see header limitation) ─ */

const RE_RESEARCH_WORDING =
  /according to (?:my |the |our |these |those )?(?:web )?(?:searches?\b|research\b|sources?\b|findings\b)|\b(?:my |our |the )?search(?:es| results)? (?:show|shows|found|confirm|confirms|indicate|suggest|suggests)\b|\b(?:my |our )?research (?:show|shows|found|confirm|confirms|indicates|suggests)\b|\b(?:the |these )?sources? (?:say|says|show|shows|confirm|indicate)\b/i;

const RE_MARKER = /\[S(\d+)\]/g;

/**
 * Audit one research answer against the turn's SERVER-MINTED citations and
 * the ledger's retrieval outcome. Pure and deterministic; safe to run again
 * on its own output (idempotent).
 *
 * @param citations ids the server minted this turn (pipeline bundle map +
 *                  tool-minted [S#] seeds — keys like "S1").
 * @param retrieved true iff the turn actually obtained anything: the tool
 *                  action ledger has ≥1 successful action, or citations is
 *                  non-empty. Computed by the CALLER from server state —
 *                  never from model prose.
 */
export function auditResearchAnswer(
  text: string,
  citations: Iterable<string>,
  retrieved: boolean,
): string {
  const ids = new Set(citations);
  const repaired = auditProse(text, ids);
  // R3: the ledger decides, not the prose. Only when the server knows the
  // turn retrieved NOTHING does research-claiming wording get flagged.
  const noSources = ids.size === 0 && !retrieved;
  if (noSources && RE_RESEARCH_WORDING.test(repaired) && !repaired.startsWith(SERVER_CHECK_LINE)) {
    return SERVER_CHECK_LINE + "\n" + repaired;
  }
  return repaired;
}

/* ── segmentation: fenced blocks and inline code are byte-protected ───── */

function auditProse(text: string, ids: Set<string>): string {
  const parts: string[] = [];
  const segments = (s: string, depth: number): void => {
    if (s === "") return;
    if (depth === 0) {
      const at = s.indexOf("```");
      if (at >= 0) {
        segments(s.slice(0, at), 1);
        const close = s.indexOf("```", at + 3);
        const end = close < 0 ? s.length : close + 3;
        parts.push(s.slice(at, end)); // fence: verbatim
        segments(s.slice(end), 0);
        return;
      }
    }
    if (depth <= 1) {
      const at = s.indexOf("`");
      if (at >= 0) {
        const close = s.indexOf("`", at + 1);
        const nl = s.indexOf("\n", at + 1);
        if (close >= 0 && (nl < 0 || close < nl)) {
          segments(s.slice(0, at), 2);
          parts.push(s.slice(at, close + 1)); // inline code: verbatim
          segments(s.slice(close + 1), 1);
          return;
        }
      }
    }
    parts.push(auditSentences(s, ids));
  };
  segments(text, 0);
  return parts.join("");
}

/** Split prose into lines, then sentences; audit each sentence. Newlines
 * are hard sentence boundaries (markdown lists must not merge lines and
 * lose the citation check — the WS06 matrix pins this). Captured-group
 * splits keep every separator byte for the rejoin. */
function auditSentences(prose: string, ids: Set<string>): string {
  const lines = prose.split(/(\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    const pieces = lines[i].split(/((?<=[.!?])\s+)/);
    for (let j = 0; j < pieces.length; j += 2) {
      pieces[j] = auditSentence(pieces[j], ids);
    }
    lines[i] = pieces.join("");
  }
  return lines.join("");
}

/** MHR-F (WS26): INTEGRITY ONLY. A marker that resolves to a minted source
 * is left byte-intact (never removed, however the sentence reads); a marker
 * that resolves to NOTHING is a broken reference and its bytes are
 * stripped. Nothing else on the sentence changes — semantic support is the
 * model's job (the harness's diagnosis of it is log telemetry only, and
 * volatile-claim qualification is exactly the semantic patching the
 * harness may not do). */
function auditSentence(sentence: string, ids: Set<string>): string {
  if (!sentence || !/[^\s]/.test(sentence)) return sentence;
  const markerIds = [...sentence.matchAll(RE_MARKER)].map((m) => "S" + m[1]);
  if (markerIds.length === 0) return sentence; // no references — nothing the integrity layer owns

  const invalid = markerIds.some((id) => !ids.has(id));
  if (!invalid) return sentence; // every reference resolves — release verbatim
  let out = sentence.replace(RE_MARKER, (whole, digits) => (ids.has("S" + digits) ? whole : ""));
  // Residue cleanup only where a marker was removed.
  out = out.replace(/ {2,}/g, " ").replace(/ ([.,;:!?])/g, "$1");
  return out;
}

/* ══ Answer diagnosis (MHR-D; telemetry-only since 2026-11-13) ════════
 * The loop may not "repair" the model's words into semantic correctness —
 * that is the model's job. The harness's job is to OBSERVE the ACTUAL
 * server state truthfully: which markers don't resolve, which sentences
 * resolve to NO minted source, whether "research" wording is backed by
 * retrieval at all. The diagnosis rides the SERVER LOG ONLY (the loop
 * emits logger.warn / tracing::warn!) — never a model-facing message,
 * never the user's history, titles or exports.
 * ⇔ Rust answer_release.rs diagnose_research_answer / answer_issues.
 */

export interface AnswerDiagnosis {
  /** [S#] marker ids the answer cites that the server never minted. */
  unresolved: string[];
  /** ids the server DID mint this turn (numeric order) — the re-attach targets. */
  available: string[];
  /** sentences whose claims resolve to no valid source — VERBATIM, unrewritten. */
  unsupported: string[];
  /** research-claiming wording on a turn with zero retrieval (R3's signal). */
  claimsResearch: boolean;
}

const numSuffix = (id: string): number => {
  const n = Number(id.slice(1));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

export function diagnoseResearchAnswer(
  text: string,
  citations: Iterable<string>,
  retrieved: boolean,
): AnswerDiagnosis {
  const ids = new Set(citations);
  const unresolved = new Set<string>();
  const unsupported: string[] = [];

  // Same segmentation law as the audit: fenced blocks and inline code
  // contribute NOTHING — no markers, no sentences from code bytes.
  const prose: string[] = [];
  const segments = (s: string, depth: number): void => {
    if (s === "") return;
    if (depth === 0) {
      const at = s.indexOf("```");
      if (at >= 0) {
        segments(s.slice(0, at), 1);
        const close = s.indexOf("```", at + 3);
        const end = close < 0 ? s.length : close + 3;
        segments(s.slice(end), 0); // fence: invisible
        return;
      }
    }
    if (depth <= 1) {
      const at = s.indexOf("`");
      if (at >= 0) {
        const close = s.indexOf("`", at + 1);
        const nl = s.indexOf("\n", at + 1);
        if (close >= 0 && (nl < 0 || close < nl)) {
          segments(s.slice(0, at), 2);
          segments(s.slice(close + 1), 1); // inline code: invisible
          return;
        }
      }
    }
    for (const line of sentencesOf(s)) prose.push(line);
  };
  segments(text, 0);

  for (const sentence of prose) {
    const markerIds = [...sentence.matchAll(RE_MARKER)].map((m) => "S" + m[1]);
    const invalid = markerIds.filter((id) => !ids.has(id));
    for (const id of invalid) unresolved.add(id);
    if (markerIds.length === 0 && !/\d/.test(sentence)) continue;
    // CITATION IDENTITY law (re-commented 2026-11-13): a resolvable [S#]
    // proves the REFERENCE resolves — NOT that its passage SUPPORTS the
    // sentence. A sentence with at least one resolving marker is skipped
    // because the harness owns no claim-evidence matcher: that is the
    // documented identity-vs-support LIMITATION, not a support verdict.
    // A dangling extra marker is still reported under `unresolved`.
    if (markerIds.some((id) => ids.has(id))) continue;
    const misattributed = invalid.length > 0;
    const volatile = /\d/.test(sentence) && VOLATILE.some((re) => re.test(sentence));
    // HEDGE law (2026-11-13): no hedge word — not even "unverified" —
    // bypasses the report. The flag is log-only, so false positives
    // (re-stated user constraints, CSS percentages) decide nothing.
    if (misattributed || volatile) {
      unsupported.push(sentence); // VERBATIM — report, never rewrite
    }
  }

  return {
    unresolved: [...unresolved].sort((a, b) => numSuffix(a) - numSuffix(b)),
    available: [...ids].sort((a, b) => numSuffix(a) - numSuffix(b)),
    unsupported,
    claimsResearch: ids.size === 0 && !retrieved && RE_RESEARCH_WORDING.test(text),
  };
}

/** Lines, then sentences (same split as auditSentences), non-blank units only. */
function sentencesOf(prose: string): string[] {
  const out: string[] = [];
  const lines = prose.split(/(\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    const pieces = lines[i].split(/((?<=[.!?])\s+)/);
    for (let j = 0; j < pieces.length; j += 2) {
      if (pieces[j] && /[^\s]/.test(pieces[j])) out.push(pieces[j]);
    }
  }
  return out;
}

/** Telemetry gate (2026-11-13): true when the diagnosis has anything to
 * say. It decides ONLY whether the loop writes its warn line — it never
 * gates a release, retracts text, or feeds the model. ⇔ Rust
 * answer_release.rs answer_issues. */
export function answerIssues(d: AnswerDiagnosis): boolean {
  return d.unresolved.length > 0 || d.unsupported.length > 0 || d.claimsResearch;
}
