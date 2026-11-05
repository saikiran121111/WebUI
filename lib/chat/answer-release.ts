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
 * then released). Ordinary non-research chat never runs through this code
 * path (the route only enters the web loop when the gate produced a bundle).
 *
 * Enforcement is deterministic — never a vibes-model call:
 *  R1 misattributed citation: every [S#] marker must resolve to a citation
 *    the SERVER actually minted (pipeline bundle or tool-minted seeds). An
 *    unresolvable marker is STRIPPED; if the sentence is then left without
 *    any valid source, it is qualified "(unverified)".
 *  R2 volatile-claim support: a sentence carrying a digit-shaped volatile
 *    fact (currency/percent/rating/temperature/date/coordinate/price- or
 *    weather-word + digit) with NO valid [S#] citation is qualified. This
 *    mirrors the guidance law "give a value only when it appears in
 *    retrieved evidence" — the server, not the model, polices it.
 *  R3 action check: research-claiming wording ("according to my searches…")
 *    on a turn where NOTHING was retrieved (empty citation map and no
 *    successful action in the ledger) gets a prepended server-attested
 *    check line. This reads the LEDGER (server record of tool outcomes),
 *    not the model's prose, to decide whether retrieval happened.
 *
 * Protections: fenced code blocks and inline code spans are byte-protected
 * (research answers legitimately carry code/config: auditing digits inside
 * them would corrupt user-facing artifacts). Code fences' [S#] text is
 * literal code content, not a citation contract. Already-qualified wording
 * is never double-qualified (idempotency law: released text is persisted,
 * replayed, and audited again on follow-up turns).
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
const RE_DATE =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i;
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

function auditSentence(sentence: string, ids: Set<string>): string {
  if (!sentence || !/[^\s]/.test(sentence)) return sentence;
  const markerIds = [...sentence.matchAll(RE_MARKER)].map((m) => "S" + m[1]);
  if (markerIds.length === 0 && !/\d/.test(sentence)) return sentence;

  // R1: unresolvable [S#] markers never survive release.
  let out = sentence;
  const invalid = markerIds.filter((id) => !ids.has(id)).length > 0;
  if (invalid) {
    out = out.replace(RE_MARKER, (whole, digits) => (ids.has("S" + digits) ? whole : ""));
    // Residue cleanup only where a marker was removed.
    out = out.replace(/ {2,}/g, " ").replace(/ ([.,;:!?])/g, "$1");
  }
  const stillValid = [...out.matchAll(RE_MARKER)].some((m) => ids.has("S" + m[1]));
  if (stillValid) return out; // the sentence's source resolved — release as-is

  const misattributed = invalid; // cited, but no cited source is real
  const volatile = /\d/.test(out) && VOLATILE.some((re) => re.test(out));
  if ((misattributed || volatile) && !/unverified/i.test(out)) {
    out = qualify(out);
  }
  return out;
}

/** Insert the qualifier before the sentence's terminal punctuation. */
function qualify(sentence: string): string {
  const tw = /\s*$/.exec(sentence)![0];
  const body = sentence.slice(0, sentence.length - tw.length);
  const punct = /(?:[.!?]+)$/.exec(body);
  if (punct) {
    return body.slice(0, punct.index) + " (unverified)" + body.slice(punct.index) + tw;
  }
  return body + " (unverified)" + tw;
}
