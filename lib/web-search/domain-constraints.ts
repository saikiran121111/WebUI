/**
 * F03 (2026-11-16 brief): TYPED domain constraints.
 *
 * The retired law (planner-law.ts §4b) scanned two FLAT cue lists - allow and
 * block - and let the nearest cue decide a domain token. That conflated five
 * different speech acts, and the brief's reproductions are exactly what that
 * conflation costs:
 *   "Do not use alpha.com, but only use beta.com"  -> BOTH blocked (no scope end)
 *   "Trust alpha.com, but also consult beta.com"   -> hard wall (preference read as exclusive)
 *   Explaining the syntax "site:alpha.com"         -> armed an allow-list (raw scan)
 *   Only use "alpha.com"                           -> restriction vanished (operand masked)
 *   "Do not exclude alpha.com"                     -> blocked (double negation)
 *   "Search everything except alpha.com"           -> no exclusion at all (cue absent)
 *
 * This module represents each constraint on the axes the brief names instead of
 * adding one special-case regex per example: target, polarity, clause +
 * contrast-bounded CUE SCOPE, EXCLUSIVITY (a separate axis from preference),
 * the exact EVIDENCE SPAN, instruction AUTHORITY (user command / quoted operand
 * / explicit "site:" operator), postposed-cue handling for SOV scripts, and a
 * cross-clause contradiction + correction law.
 *
 * Cue CLASSES (never a bare allow/block boolean):
 *   negator    dont / do not / never ...           negates the cue it governs
 *   block      avoid / skip / exclude / without    hard exclusion
 *   exclusion  except / other than / apart from    removes ONE target from a set
 *   exclusive  only / solely / stick to / nowhere else  arms the allow-list wall
 *   prefer     trust / consult / prefer / rely on  RANKING, never a wall
 *   correction actually / in fact / i mean ...     retracts an earlier policy
 *
 * Polarity composition is mechanical, never example-shaped:
 *   negator alone              -> block      ("do not use reddit.com")
 *   negator + block/exclusion  -> cancel     ("dont exclude alpha.com" makes NO policy)
 *   negator + prefer           -> block      ("never trust quora.com")
 *   negator + exclusive        -> cancel     ("not just alpha.com")
 *   exclusive alone            -> allow + wall
 *   prefer  alone              -> prefer, NO wall
 *   prefer + exclusive marker in the same cue scope -> allow + wall ("consult X only")
 *   bare "site:host" operator  -> allow + wall (an explicit operator IS user policy)
 *   cueless mention            -> no policy at all (a mention is never a wall)
 *
 * The vocabulary is script-aware: ASCII cues keep ASCII word guards, non-Latin
 * cues use unicode-letter guards (CJK terms are not required to end at a letter,
 * because Han/Kana words are not space-delimited). Postposed cues (Hindi
 * "ke alava", Japanese "igai", Telugu ...) bind a target that PRECEDES them only
 * when the cue trails the target across nothing but filler AND nothing but
 * filler follows the cue in its clause - which is what keeps an English
 * "check X, do not use Y" from draping backwards onto X.
 */
import { normalizeDomain } from "./domain-match";

export type ConstraintPolarity = "allow" | "prefer" | "block" | "cancel";
export type ConstraintAuthority = "user" | "quoted-operand" | "site-operator";
export type CueClass =
  | "negator"
  | "block"
  | "exclusion"
  | "exclusive"
  | "prefer"
  | "correction";

export interface DomainConstraint {
  /** Normalized registrable host the constraint is about. */
  target: string;
  polarity: ConstraintPolarity;
  /** The cue class that decided it (null for a bare site: operator). */
  cueClass: CueClass | null;
  cue: string | null;
  /** Instruction authority: user command vs quoted operand vs site: operator. */
  authority: ConstraintAuthority;
  /** True when the constraint ARMS an allow-list wall (never a mere preference). */
  exclusivity: boolean;
  /** True when the cue trails its target (SOV postposition). */
  postposed: boolean;
  /** True when the governing clause is a self-correction. */
  corrected: boolean;
  clauseIndex: number;
  clauseStart: number;
  clauseEnd: number;
  /** Cue scope within the clause: after the last contrast boundary. */
  scopeStart: number;
  cueStart: number;
  cueEnd: number;
  /** Exact user-text span of the TARGET (offsets into the ORIGINAL prompt). */
  targetStart: number;
  targetEnd: number;
  evidence: string;
}

export interface ResolvedDomainPolicy {
  allowed: string[];
  blocked: string[];
  preferred: string[];
  /** Targets whose derived policy was retracted (correction / double negation). */
  withdrawn: string[];
}

/* -- cue vocabulary ------------------------------------------------------- */
/* Terms are lowercase, may contain spaces (compiled to \s+). Multi-word terms
 * are matched longest-first, so "do not exclude" reads as negator+exclusion and
 * "no other source" never splits into a stray negator. */

const NEGATOR_TERMS = [
  "don't", "dont", "do not", "does not", "doesn't", "doesnt", "never",
  "nunca", "niemals", "jamais", "\u0111\u1ee9ng",
  "\u092e\u0924", // hi  mata      (prohibitive "don't")
  "\u4e0d\u8981", // zh  buyao     ("don't")
  "\u7981\u6b62", // zh  jinzhi    ("forbidden")
  "\u4f7f\u7528\u306a", // ja  tsukauna ("do not use")
  "\u0c35\u0c26\u0c4d\u0c26\u0c41", // te  vaddu ("don't / not wanted")
];

const BLOCK_TERMS = [
  "avoid", "skip", "exclude", "without", "ban", "block", "blocked", "blocklist",
  "blacklist", "ignore", "stay away from", "steer clear of", "shut out",
  "evita", "evitar", "omite", "ignora", "evite", "vermeide", "meide",
  "\u062a\u062c\u0646\u0628", // ar  tajannab ("avoid")
  "\u0628\u062f\u0648\u0646", // ar  bidun     ("without")
  "tr\u1ea1nh", // vi  tranh     ("avoid")
  "\u092a\u0930\u0939\u0947\u091c", // hi  parhez ("avoid/shun")
];

const EXCLUSION_TERMS = [
  "except", "except for", "with the exception of", "other than", "apart from",
  "excluding", "but not", "anything but", "everything but", "save for", "minus",
  "except that", "salvo", "excepto", "exceto", "sauf", "au\u00dfer", "ausser",
  "\u0938\u093f\u0935\u093e\u092f", // hi  sirivaay ("except")
  "\u0915\u0947 \u0905\u0932\u093e\u0935\u093e", // hi  ke alavaa ("except for")
  "\u4ee5\u5916", // ja/zh  igai / yiwai ("other than")
  "\u9664\u4e86", // zh   chule     ("except")
  "\u0645\u0627 \u0639\u062f\u0627", // ar  ma 'ada ("except")
  "\u0625\u0644\u0627", // ar  illa      ("except/but")
  "tr\u1EEB", // vi   tru        ("except")
  "\u0c2e\u0c3f\u0c28\u0c39\u0c3e\u0c2f\u0c3f\u0c02\u0c1a\u0c3f", // te  minahaayimsi  (excluding)
  "\u0915\u0947 \u0938\u093f\u0935\u093e\u092f", // hi  ke sirvaay  (postpositional phrase)
];
const EXCLUSIVE_TERMS = [
  "only", "solely", "exclusively", "purely", "restrict to", "restricted to",
  "confine to", "confined to", "limit to", "limited to", "stick to", "sticks to",
  "nothing but", "nothing else", "nothing more", "nowhere else", "no other source",
  "no other site", "no other domain", "one source only", "single source",
  "just use", "just search", "just consult", "just cite", "just ask", "just go to",
  "just stick to", "just from",
  "solo", "solamente", "\u00fanicamente", "exclusivamente", "apenas", "somente",
  "uniquement", "seulement", "exclusivement", "nur", "ausschlie\u00dflich", "lediglich",
  "\u0915\u0947\u0935\u0932", // hi  keval
  "\u0938\u093f\u0930\u094d\u092b", // hi  sirf
  "\u306e\u307f", // ja  nomi
  "\u3060\u3051", // ja  dake
  "\u53ea", // zh  zhi  ("only")
  "\u4ec5", // zh  jin  ("solely")
  "\u0641\u0642\u0637", // ar  faqat
  "ch\u1ec9", // vi  chi   ("only")
  "duy nh\u1ea5t", // vi  duy nhat ("sole")
  "\u0c15\u0c47\u0c35\u0c32\u0c02", // te  kelam  ("only")
  "\u0c2e\u0c3e\u0c24\u0c30\u0c2e\u0c47", // te  matrame ("only/alone")
];

const PREFER_TERMS = [
  "trust", "trusts", "consult", "consults", "consider", "considers", "prefer",
  "prefers", "prioritize", "prioritise", "favour", "favor", "rely on", "relies on",
  "depend on", "depends on",
  "conf\u00eda", "confiar", "confie", "confiance", "pr\u00e9f\u00e8re", "vertraue",
  "vertrauen", "bevorzuge",
  "\u092d\u0930\u094b\u0938\u093e", // hi  bharosa ("trust")
  "\u4fe1\u8cf4", // ja  shinrai  ("trust")
  "\u4f18\u5148", // zh  youxian  ("prioritize")
  "\u4fe1\u4efb", // zh  renxin   ("trust")
  "tin t\u01b0\u1edfng", // vi  tin tuong ("trust")
  "\u0c28\u0c2e\u0c4d\u0c2e\u0c15\u0c02", // te  nammakam ("trust")
];

const CORRECTION_TERMS = [
  "actually", "in fact", "i mean", "correction", "no wait", "on second thought",
  "scratch that", "disregard that", "forget that", "en realidad", "de hecho",
  "en fait", "eigentlich",
  "\u5176\u5b9e", // zh  qishi     ("actually")
  "\u5b9f\u969b", // ja  jissai    ("actually")
  "\u0935\u093e\u0938\u094d\u0924\u0935", // hi  vastav ("actually")
  "\u0641\u064a \u0627\u0644\u0648\u0627\u0642\u0639", // ar  fi-l-waqi ("in fact")
  "th\u1ef1c ra", // vi  thuc ra   ("actually")
];

/** Contrastive conjunctions END a cue's scope; they never create a policy. */
const CONTRAST_TERMS = [
  "but", "however", "although", "though", "whereas", "nevertheless", "conversely",
  "on the other hand", "pero", "mais", "aber",
  "\u0932\u0947\u0915\u093f\u0928", // hi  lekin
  "\u3057\u304b\u3057", // ja  shikashi
  "\u305f\u3060\u3057", // ja  tadashi
  "\u4f46\u662f", // zh  danshi
  "\u0644\u0643\u0646", // ar  lakin
  "nh\u01b0ng", // vi  nhung
];

/** Platform names usable as targets of a block cue (NEVER a default block list;
 *  the reranker softly ranks weak sources, only the USER blocks). */
const PLATFORM_TO_DOMAIN: Record<string, string> = {
  reddit: "reddit.com", quora: "quora.com", facebook: "facebook.com",
  instagram: "instagram.com", twitter: "twitter.com", pinterest: "pinterest.com",
  medium: "medium.com", tiktok: "tiktok.com", youtube: "youtube.com", "4chan": "4chan.org",
};

/* -- compiled patterns ---------------------------------------------------- */

function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s+");
}
function alternation(terms: string[]): string {
  const uniq = [...new Set(terms)].sort((a, b) => b.length - a.length);
  return uniq.map(escapeTerm).join("|");
}

const CUE_CLASSES: Array<[CueClass, string[]]> = [
  ["negator", NEGATOR_TERMS],
  ["block", BLOCK_TERMS],
  ["exclusion", EXCLUSION_TERMS],
  ["exclusive", EXCLUSIVE_TERMS],
  ["prefer", PREFER_TERMS],
  ["correction", CORRECTION_TERMS],
];
const CUE_PATTERNS: Array<{ cls: CueClass; re: RegExp }> = CUE_CLASSES.map(
  ([cls, terms]) => ({ cls, re: new RegExp("(?:" + alternation(terms) + ")", "giu") }),
);
const CONTRAST_RE = new RegExp("(?:" + alternation(CONTRAST_TERMS) + ")", "giu");

const DOMAIN_TOKEN_RE = /(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/gi;
const SITE_OP_RE = /\bsite:\s*([a-z0-9][a-z0-9.:-]*(?:\/[^\s]*)?)/gi;
const PLATFORM_RE = new RegExp(
  "\\b(?:" + Object.keys(PLATFORM_TO_DOMAIN).join("|") + ")s?\\b",
  "gi",
);
/** Sentence terminators, extended for CJK/Arabic punctuation (offsets preserved). */
const SENTENCE_SPLIT_RE =
  /(?:[!?\n;\u3002\uFF01\uFF1F\uFF1B\u061F\u061B]+|\.(?:\s|$))/g;
/** A quoted operand that IS a host (optionally a bare site: operator). */
const BARE_HOST_RE =
  /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(\/\S*)?$/i;
const BARE_SITE_OP_RE = /^site:\s*((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\/?$/i;
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const QUOTE_RE = /"[^"\n]*"|\u201c[^\u201d]*\u201d|\u00ab[^\u00bb]*\u00bb/g;

const ASCII_WORD = /[A-Za-z0-9_]/;
const UNICODE_ALNUM = /[\p{L}\p{N}\p{M}]/u;
/** Han/Kana are not space-delimited: a CJK cue term may abut the next word. */
const CJK_TAIL = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Binding windows (characters, not words) for the two scope rules that need
 *  a distance bound: a postposed cue may only bind backwards across pure
 *  filler inside this window, and a contrast word only ends a cue scope when a
 *  cue follows it within this window. Neither is example-specific: they bound
 *  GENERAL rules, and the filler law is what keeps an English check-X-do-not
 *  use-Y sentence from draping the block backwards onto X. */
const POSTPOSED_WINDOW = 30;
const CONTRAST_LOOKAHEAD = 120;
const FILLER_GAP_RE =
  /^[\s,.!?;]*(?:\b(?:and|or|for|with|please|instead|then|from|to|as|of)\b[\s,.!?;]*){0,2}$/;
const FILLER_TAIL_RE = /^[\s,.!?;]*$/;

interface Cue {
  start: number;
  end: number;
  text: string;
  cls: CueClass;
}
interface Span {
  start: number;
  end: number;
}

/**
 * Word guards that do not assume ASCII. A term beginning with an ASCII letter
 * cannot be glued to an ASCII word character; a term beginning with a non-ASCII
 * letter cannot be glued to any unicode letter/mark. Trailing side likewise,
 * except for Han/Kana term tails (agglutinated, unspaced).
 */
function boundaryOk(text: string, start: number, end: number): boolean {
  const first = text[start];
  const last = text[end - 1];
  const prev = start > 0 ? text[start - 1] : "";
  const next = end < text.length ? text[end] : "";
  if (/[A-Za-z0-9]/.test(first) && ASCII_WORD.test(prev)) return false;
  if (/[A-Za-z0-9]/.test(last) && ASCII_WORD.test(next)) return false;
  if (!/[A-Za-z0-9]/.test(first) && UNICODE_ALNUM.test(prev)) return false;
  if (!/[A-Za-z0-9]/.test(last) && !CJK_TAIL.test(last) && UNICODE_ALNUM.test(next)) return false;
  return true;
}

/* -- offset-preserving masking -------------------------------------------- */

interface MaskedText {
  /** Copy of the prompt with non-instruction spans space-filled. */
  text: string;
  /** Quote spans - candidates for a quoted OPERAND (Only use "x.com"). */
  quotes: Span[];
}

function blankRange(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

/**
 * Space-fill the spans that are NOT user instructions, keeping every offset
 * aligned so a constraint can point back into the ORIGINAL prompt. Order is
 * fence, then inline code, then quotes: code is never an operand at all, a
 * quote is (its inner text may BE the target of a cue).
 */
function maskNonInstructionSpans(text: string): MaskedText {
  let masked = text;
  const quotes: Span[] = [];
  for (const re of [FENCE_RE, INLINE_CODE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      masked = blankRange(masked, m.index, m.index + m[0].length);
    }
  }
  QUOTE_RE.lastIndex = 0;
  let q: RegExpExecArray | null;
  while ((q = QUOTE_RE.exec(masked)) !== null) {
    if (q[0].length === 0) {
      QUOTE_RE.lastIndex++;
      continue;
    }
    quotes.push({ start: q.index, end: q.index + q[0].length });
    masked = blankRange(masked, q.index, q.index + q[0].length);
  }
  return { text: masked, quotes };
}

/* -- clauses, cue matches, contrast scopes --------------------------------- */

interface Clause {
  index: number;
  start: number;
  end: number;
}

/** Sentence segmentation on ABSOLUTE offsets; separators are consumed. */
function splitClauses(text: string): Clause[] {
  const out: Clause[] = [];
  SENTENCE_SPLIT_RE.lastIndex = 0;
  let cursor = 0;
  let index = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_SPLIT_RE.exec(text)) !== null) {
    if (m[0].length === 0) {
      SENTENCE_SPLIT_RE.lastIndex++;
      continue;
    }
    if (m.index > cursor && text.slice(cursor, m.index).trim() !== "") {
      out.push({ index: index++, start: cursor, end: m.index });
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length && text.slice(cursor).trim() !== "") {
    out.push({ index: index++, start: cursor, end: text.length });
  }
  return out;
}

/**
 * Cue matches inside one clause. A term only counts at a real word edge
 * (script-aware guards), and the LONGEST cue wins wherever cues overlap, so
 * "do not exclude" reads as negator+exclusion and a multiword postposition
 * ("ke sirvaay") is never shredded into its inner word.
 */
function collectCues(masked: string, clause: Clause): Cue[] {
  const found: Cue[] = [];
  for (const { cls, re } of CUE_PATTERNS) {
    re.lastIndex = clause.start;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (m.index >= clause.end) break;
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const end = m.index + m[0].length;
      if (end > clause.end) continue;
      if (boundaryOk(masked, m.index, end)) {
        found.push({ start: m.index, end, text: masked.slice(m.index, end), cls });
      }
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Cue[] = [];
  for (const c of found) {
    if (kept.some((k) => c.start >= k.start && c.end <= k.end)) continue;
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i];
      if (c.start <= k.start && c.end >= k.end) kept.splice(i, 1);
    }
    kept.push(c);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Contrast word ENDS a cue scope, it never creates a policy. A contrast that
 * overlaps a cue ("but not") belongs to that cue. A surviving contrast only
 * becomes a boundary when a cue actually follows it inside the clause - a
 * dangling trailing contrast changes nothing.
 */
function contrastEnds(masked: string, clause: Clause, cues: Cue[]): number[] {
  const ends: number[] = [];
  CONTRAST_RE.lastIndex = clause.start;
  let m: RegExpExecArray | null;
  while ((m = CONTRAST_RE.exec(masked)) !== null) {
    if (m.index >= clause.end) break;
    if (m[0].length === 0) {
      CONTRAST_RE.lastIndex++;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    if (end > clause.end) continue;
    if (!boundaryOk(masked, start, end)) continue;
    if (cues.some((c) => c.start < end && c.end > start)) continue;
    const limit = Math.min(clause.end, end + CONTRAST_LOOKAHEAD);
    if (cues.some((c) => c.start >= end && c.start < limit)) ends.push(end);
  }
  return ends;
}

/** Scope start of an occurrence: after the last contrast boundary before it. */
function scopeStartOf(
  ends: number[],
  occurrenceStart: number,
  clauseStart: number,
): number {
  let start = clauseStart;
  for (const e of ends) {
    if (e <= occurrenceStart && e > start) start = e;
  }
  return start;
}

/* -- target occurrences --------------------------------------------------- */

interface Occurrence {
  target: string;
  start: number;
  end: number;
  authority: ConstraintAuthority;
}

/**
 * Every domain-ish target mentioned inside one clause, WITH its authority.
 * An explicit "site:host" operator is user scoping; a plain host/platform
 * name is a user mention; a quoted span whose whole content IS a host (or a
 * bare site: operator) is the OPERAND of the sentence, which is how
 * Only use "alpha.com" survives quote masking while explaining the
 * syntax "site:alpha.com" stays inert (no cue governs it).
 */
function occurrencesIn(
  text: string,
  masked: string,
  clause: Clause,
  quotes: Span[],
): Occurrence[] {
  const out: Occurrence[] = [];
  const overlaps = (a: number, b: number): boolean =>
    out.some((o) => a < o.end && b > o.start);

  SITE_OP_RE.lastIndex = clause.start;
  let m: RegExpExecArray | null;
  while ((m = SITE_OP_RE.exec(masked)) !== null) {
    if (m.index >= clause.end) break;
    const end = m.index + m[0].length;
    if (end > clause.end) continue;
    const host = normalizeDomain(m[1]);
    if (host && !overlaps(m.index, end)) {
      out.push({ target: host, start: m.index, end, authority: "site-operator" });
    }
  }

  DOMAIN_TOKEN_RE.lastIndex = clause.start;
  while ((m = DOMAIN_TOKEN_RE.exec(masked)) !== null) {
    if (m.index >= clause.end) break;
    const end = m.index + m[0].length;
    if (end > clause.end) continue;
    const host = normalizeDomain(m[0]);
    if (host && !overlaps(m.index, end)) {
      out.push({ target: host, start: m.index, end, authority: "user" });
    }
  }

  // Plural-tolerant platform names, but only where no dotted host already
  // claimed the span ("reddit.com" is ONE target, not two).
  PLATFORM_RE.lastIndex = clause.start;
  while ((m = PLATFORM_RE.exec(masked)) !== null) {
    if (m.index >= clause.end) break;
    const end = m.index + m[0].length;
    if (end > clause.end) continue;
    const key = m[0].toLowerCase();
    const d = PLATFORM_TO_DOMAIN[key] ?? PLATFORM_TO_DOMAIN[key.replace(/s$/, "")];
    if (d && !overlaps(m.index, end)) {
      out.push({ target: d, start: m.index, end, authority: "user" });
    }
  }

  for (const q of quotes) {
    if (q.start < clause.start || q.start >= clause.end) continue;
    const inner = text.slice(q.start + 1, q.end - 1).trim();
    if (inner === "") continue;
    const bare = BARE_HOST_RE.exec(inner);
    const op = bare ? null : BARE_SITE_OP_RE.exec(inner);
    const raw = bare ? bare[1] : op ? op[1] : "";
    const host = normalizeDomain(raw);
    if (!host || overlaps(q.start, q.end)) continue;
    out.push({ target: host, start: q.start, end: q.end, authority: "quoted-operand" });
  }

  return out.sort((a, b) => a.start - b.start);
}

/* -- polarity composition -------------------------------------------------- */

interface PolarityRead {
  polarity: ConstraintPolarity;
  exclusivity: boolean;
}

/**
 * Mechanical class composition. The negator never stands alone as a policy
 * for a prefer cue - it flips the cue it governs:
 *   negator+block/exclusion -> NO policy (cancel): "dont exclude X"
 *   negator+exclusive       -> NO policy (cancel): "not only X"
 *   negator+prefer          -> block:             "never trust X"
 * Exclusivity rides only with an affirmative exclusive cue.
 */
function polarityForCue(cls: CueClass, negated: boolean): PolarityRead {
  switch (cls) {
    case "negator":
      return { polarity: "block", exclusivity: false };
    case "block":
    case "exclusion":
      return negated
        ? { polarity: "cancel", exclusivity: false }
        : { polarity: "block", exclusivity: false };
    case "exclusive":
      return negated
        ? { polarity: "cancel", exclusivity: false }
        : { polarity: "allow", exclusivity: true };
    case "prefer":
      return negated
        ? { polarity: "block", exclusivity: false }
        : { polarity: "prefer", exclusivity: false };
    default:
      return { polarity: "cancel", exclusivity: false };
  }
}

/* -- public surface -------------------------------------------------------- */

/**
 * Derive the typed domain constraints written in a user prompt. Offsets and
 * evidence point into the ORIGINAL prompt (masking is space-filled), so a
 * caller can show exactly which words created which policy.
 */
export function deriveDomainConstraints(userPrompt: string): DomainConstraint[] {
  const out: DomainConstraint[] = [];
  if (!userPrompt) return out;
  const masked = maskNonInstructionSpans(userPrompt);
  const text = masked.text;

  for (const clause of splitClauses(text)) {
    const cues = collectCues(text, clause);
    const boundaries = contrastEnds(text, clause, cues);
    const correction = cues.find((c) => c.cls === "correction") ?? null;

    for (const occ of occurrencesIn(userPrompt, text, clause, masked.quotes)) {
      const scopeStart = scopeStartOf(boundaries, occ.start, clause.start);
      let polarity: ConstraintPolarity | null = null;
      let cueClass: CueClass | null = null;
      let cue: string | null = null;
      let cueStart = occ.start;
      let cueEnd = occ.end;
      let exclusivity = false;
      let postposed = false;
      let corrected = false;
      let pendingNeg = false;

      // The NEAREST governing cue decides (last one wins), except that a
      // negator arms the cue that follows it. An earlier block no longer
      // drapes a later allow - that was the audited scope hole.
      for (const c of cues) {
        if (c.start < scopeStart) continue;
        if (c.start >= occ.start) break;
        if (c.cls === "correction") {
          corrected = true;
          continue;
        }
        if (c.cls === "negator") {
          polarity = "block";
          exclusivity = false;
          pendingNeg = true;
        } else {
          const read = polarityForCue(c.cls, pendingNeg);
          polarity = read.polarity;
          exclusivity = read.exclusivity;
          pendingNeg = false;
        }
        cueClass = c.cls;
        cue = c.text;
        cueStart = c.start;
        cueEnd = c.end;
      }

      if (polarity === null && occ.authority === "site-operator") {
        polarity = "allow";
        exclusivity = true;
        cueClass = null;
        cue = "site:";
      }

      // Postposed cue (SOV scripts): binds backwards ONLY across pure filler
      // and only when its clause ends right after it - otherwise a following
      // instruction would drape onto the previous target.
      if (polarity === null) {
        const after = cues
          .filter((c) => c.start >= scopeStart && c.start > occ.end && c.start <= occ.end + POSTPOSED_WINDOW)
          .sort((a, b) => a.start - b.start)[0];
        if (
          after &&
          FILLER_GAP_RE.test(text.slice(occ.end, after.start)) &&
          FILLER_TAIL_RE.test(text.slice(after.end, clause.end))
        ) {
          if (after.cls === "correction") {
            corrected = true;
          } else {
            const read = polarityForCue(after.cls, false);
            polarity = read.polarity;
            exclusivity = read.exclusivity;
            cueClass = after.cls;
            cue = after.text;
            cueStart = after.start;
            cueEnd = after.end;
            postposed = true;
          }
        }
      }

      // A self-correction clause with no other cue RETRACTS whatever policy
      // an earlier clause had about this target.
      if (polarity === null && correction) {
        polarity = "cancel";
        cueClass = "correction";
        cue = correction.text;
        cueStart = correction.start;
        cueEnd = correction.end;
      }

      if (polarity === null) continue;

      // Preference + an explicit exclusivity marker in the same scope IS a
      // wall ("consult X only"); preference alone is ranking, never a wall.
      if (
        polarity === "prefer" &&
        cues.some((c) => c.cls === "exclusive" && c.start >= scopeStart && c.start < clause.end)
      ) {
        polarity = "allow";
        exclusivity = true;
      }

      out.push({
        target: occ.target,
        polarity,
        cueClass,
        cue,
        authority: occ.authority,
        exclusivity,
        postposed,
        corrected,
        clauseIndex: clause.index,
        clauseStart: clause.start,
        clauseEnd: clause.end,
        scopeStart,
        cueStart,
        cueEnd,
        targetStart: occ.start,
        targetEnd: occ.end,
        evidence: userPrompt.slice(occ.start, occ.end),
      });
    }
  }
  return out;
}

/**
 * Resolve constraints into one effective policy. A cancel retracts whatever
 * was recorded before it (double negation, self-correction); a block always
 * wins over preference; an allow/prefer never overrides an existing block
 * UNLESS the later clause is an explicit correction; allow replaces prefer,
 * preference never replaces allow. Insertion order is preserved so the plan
 * order stays deterministic.
 */
export function resolveDomainPolicy(cs: DomainConstraint[]): ResolvedDomainPolicy {
  const records = new Map<string, DomainConstraint>();
  const withdrawn: string[] = [];

  for (const c of cs) {
    const cur = records.get(c.target);
    if (c.polarity === "cancel") {
      if (cur) records.delete(c.target);
      if (!withdrawn.includes(c.target)) withdrawn.push(c.target);
      continue;
    }
    if (cur) {
      if (cur.polarity === "block") {
        const retract = c.corrected && c.clauseIndex > cur.clauseIndex;
        if (!retract && c.polarity !== "block") continue;
      } else if (cur.polarity === "allow" && c.polarity === "prefer") {
        continue;
      }
    }
    records.set(c.target, c);
  }

  const allowed: string[] = [];
  const blocked: string[] = [];
  const preferred: string[] = [];
  for (const [target, c] of records) {
    if (c.polarity === "allow") push(allowed, target);
    else if (c.polarity === "block") push(blocked, target);
    else if (c.polarity === "prefer") push(preferred, target);
  }
  return { allowed, blocked, preferred, withdrawn };
}

function push(list: string[], v: string): void {
  if (v && !list.includes(v)) list.push(v);
}