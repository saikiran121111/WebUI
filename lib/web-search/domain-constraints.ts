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
 *
 * Three more MECHANISM laws (generalization brief 2026-11-16, domain probes
 * 6-8). None is a phrase exception for one prompt:
 *   ELLIPTICAL NEGATOR   a bare "not"/"no"/"non" is a negator only where it
 *                        cannot attach to a preceding predicate (clause-initial
 *                        or after ","/";"/":") AND only governs a target that
 *                        follows it across nothing but filler. That is what
 *                        makes "Only use X, not Y" exclude Y while "that is
 *                        not X's fault" and "no restrictions on X" stay inert.
 *   DISCONTINUOUS FRAME  an exclusive verb class (restrict / limit / confine /
 *                        narrow + inflections) + "to" across a BOUNDED run of
 *                        closed-set filler tokens is ONE exclusive cue
 *                        ("restrict yourself to", "limit the search to").
 *                        Negated, the composition law cancels: the negation
 *                        targets the RESTRICTION, so no domain policy exists
 *                        at all - it is not a block on the named host.
 *   SUPERSESSION         an explicit broadening phrase ("any source", "all
 *                        sites", "no restriction") in the same clause as a
 *                        supersession marker ("now", "previously", "anymore")
 *                        retracts an ALLOW-WALL whose cue and target precede
 *                        it. The withdrawal is RECORDED (polarity cancel),
 *                        never a silent widening, and an explicit exclusion is
 *                        never retracted by it.
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
  | "correction"
  | "broadening";

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
  /** True for a SUPERSESSION withdrawal record (F03b): the cue lives in a
   *  LATER span than the target it retracts, so read the offsets that way. */
  supersession?: boolean;
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

/* Elliptical negators (F03b). The SHORT forms deliberately stay OUT of
 * NEGATOR_TERMS: an unconditional "not"/"no" would turn every copula ("that
 * is not X's fault") and every noun phrase ("no restrictions on X") into an
 * exclusion cue. They count as negators only under the two guards added with
 * them - elliptical position, and an immediately following target. */
const BARE_NEGATOR_TERMS = ["not", "no", "non"];

/* Exclusive verb class usable in a DISCONTINUOUS frame (F03b). The verb and
 * its particle "to" may be separated by at most MAX_RESTRICT_FILLER tokens,
 * and EVERY token between them must come from this CLOSED set - an open-class
 * word in the gap is exactly the case that must not arm a wall. */
const RESTRICT_VERB_TERMS = [
  "restrict", "restricts", "restricted", "restricting",
  "limit", "limits", "limited", "limiting",
  "confine", "confines", "confined", "confining",
  "narrow", "narrows", "narrowed", "narrowing",
];
const RESTRICT_FILLER_TERMS = [
  "yourself", "yourselves", "myself", "it", "them", "the", "our", "my",
  "this", "that", "these", "those", "its", "their",
  "search", "searches", "searching", "results", "result", "output", "outputs",
  "answer", "answers", "response", "responses", "source", "sources", "scope",
  "findings", "things", "topic", "topics", "matter", "matters", "list",
  "lists", "report", "reports", "dataset", "datasets", "collection",
  "collections", "just", "only", "strictly", "further", "more", "down",
];
const MAX_RESTRICT_FILLER = 3;

/* Broadening + supersession (F03b). BOTH must appear in the same clause
 * before anything is retracted: a bare "any source" that merely describes the
 * research space changes no policy. These lists name broadening SPEECH ACTS,
 * never domains, and superseding a restriction never erases an explicit
 * exclusion of some other host. */
const BROADEN_TERMS = [
  "any source", "any sources", "all sources", "every source", "any site",
  "any sites", "all sites", "every site", "any website", "any websites",
  "all websites", "any domain", "any domains", "any url", "any urls",
  "anywhere", "no restriction", "no restrictions", "unrestricted",
  "any search", "any results", "all results", "any provider", "any engine",
  "whatever source", "whatever sources",
];
const SUPERSESSION_TERMS = [
  "now", "previously", "earlier", "before", "at first", "initially",
  "instead", "no longer", "anymore", "retract", "changed my mind",
  "new instruction", "updated",
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
/* F03b machinery (elliptical negator / discontinuous exclusive frame /
 * broadening+supersession). Compiled from the closed vocabularies above; the
 * guards that make them safe live with the cue scan, not in the patterns. */
const BARE_NEGATOR_RE = new RegExp("(?:" + alternation(BARE_NEGATOR_TERMS) + ")", "giu");
const RESTRICT_VERB_RE = new RegExp("(?:" + alternation(RESTRICT_VERB_TERMS) + ")", "giu");
const RESTRICT_FILLER_SET = new Set(RESTRICT_FILLER_TERMS);
const BROADEN_RE = new RegExp("(?:" + alternation(BROADEN_TERMS) + ")", "giu");
const SUPERSESSION_RE = new RegExp("(?:" + alternation(SUPERSESSION_TERMS) + ")", "giu");
/** A contrast term with its trailing punctuation, anchored at the query end -
 *  used to decide whether a bare negator trails one (elliptical scope). */
const TRAILING_CONTRAST_RE = new RegExp(
  "(?:" + alternation(CONTRAST_TERMS) + ")[\\s,;:!]*$",
  "iu",
);

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
/** Gap an ELLIPTICAL negator may cross to reach its target (F03b): punctuation
 *  plus, at most, two light connectives/adverbs. Anything open-class in the gap
 *  ("no restrictions ON X") means the negator governs a different phrase. */
const ELLIPTICAL_GAP_RE =
  /^[\s,;:!-]*(?:\b(?:and|or|also|just|simply|only|even|rather|specifically)\b[\s,;:-]*)*$/iu;

interface Cue {
  start: number;
  end: number;
  text: string;
  cls: CueClass;
  /** Bare "not"/"no" accepted by the elliptical law; it may only govern a
   *  target that FOLLOWS it across pure filler (record-loop guard). */
  elliptical?: boolean;
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
 * Elliptical scope for a bare negator (F03b). A bare "not"/"no"/"non" is a
 * NEGATOR only where it cannot attach backwards to a preceding predicate: at
 * the clause start, right after a separator, or right after a contrast term.
 * "…is not X…" fails this test (a verb governs it), so no cue exists at all -
 * which is exactly why that sentence creates no exclusion.
 */
function ellipticalScopeOk(text: string, start: number, clause: Clause): boolean {
  const before = text.slice(clause.start, start);
  if (before.trim() === "") return true;
  if (/[,;:]\s*$/.test(before)) return true;
  const m = TRAILING_CONTRAST_RE.exec(before);
  if (!m) return false;
  const termStart = start - m[0].length;
  if (termStart <= clause.start) return true;
  return !ASCII_WORD.test(text[termStart - 1]);
}

/**
 * End offset of a DISCONTINUOUS exclusive frame (F03b): from just after an
 * exclusive verb, accept at most MAX_RESTRICT_FILLER closed-set filler tokens
 * and then require the particle "to". Anything else - an open-class word,
 * punctuation, or the clause ending first - means there is NO frame, so a
 * noun phrase like "the download limit to 5 GB" never arms a wall. Returns the
 * offset just past "to", or null.
 */
function restrictFrameEnd(text: string, from: number, clause: Clause): number | null {
  let i = from;
  for (let used = 0; used <= MAX_RESTRICT_FILLER; used++) {
    const rest = text.slice(i, clause.end);
    const m = /^\s+([A-Za-z']+)/.exec(rest);
    if (!m) return null;
    const word = m[1].toLowerCase();
    const wordEnd = i + m[0].length;
    if (word === "to") return wordEnd;
    if (used === MAX_RESTRICT_FILLER) return null;
    if (!RESTRICT_FILLER_SET.has(word)) return null;
    i = wordEnd;
  }
  return null;
}

/**
 * A broadening SUPERSESSION frame (F03b): the clause must state BOTH an
 * explicit broadening speech act and a supersession marker. A bare broadening
 * phrase with no marker (describing the research space, or arguing against
 * broadening) is NOT a frame, so a live restriction is never silently widened.
 */
interface BroadeningFrame {
  text: string;
  start: number;
  end: number;
}

function broadeningFrameOf(masked: string, clause: Clause): BroadeningFrame | null {
  BROADEN_RE.lastIndex = clause.start;
  const broad: RegExpExecArray | null = nextBoundedMatch(BROADEN_RE, masked, clause);
  if (!broad) return null;
  SUPERSESSION_RE.lastIndex = clause.start;
  if (!nextBoundedMatch(SUPERSESSION_RE, masked, clause)) return null;
  return {
    text: masked.slice(broad.index, broad.index + broad[0].length),
    start: broad.index,
    end: broad.index + broad[0].length,
  };
}

/** Next match of `re` inside the clause that also clears the word guards. */
function nextBoundedMatch(
  re: RegExp,
  text: string,
  clause: Clause,
): RegExpExecArray | null {
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index >= clause.end) return null;
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const end = m.index + m[0].length;
    if (end > clause.end) return null;
    if (boundaryOk(text, m.index, end)) return m;
  }
  return null;
}

/**
 * Second half of the elliptical-negator law (F03b). The cue scan decided the
 * negator may EXIST; here it decides what it may GOVERN: a target that follows
 * it across nothing but filler. "only use X, not Y" excludes Y (empty gap);
 * "no restrictions on X" and "is not X's fault" govern nothing, so they create
 * no policy. This mirrors the postposed-cue filler law for the opposite order.
 */
function ellipticalGoverns(text: string, cueEnd: number, targetStart: number): boolean {
  if (targetStart < cueEnd) return false;
  return ELLIPTICAL_GAP_RE.test(text.slice(cueEnd, targetStart));
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
  /* Elliptical negator (F03b): the short forms count ONLY where they cannot
   * attach to a preceding predicate. The companion law - such a negator may
   * govern only a target that immediately FOLLOWS it across filler - runs in
   * the record loop, where the target is known. Together they are what keeps
   * "Only use X, not Y" excluding Y while "is not X's fault" and "no
   * restrictions on X" stay policy-free. */
  BARE_NEGATOR_RE.lastIndex = clause.start;
  let bn: RegExpExecArray | null;
  while ((bn = BARE_NEGATOR_RE.exec(masked)) !== null) {
    if (bn.index >= clause.end) break;
    if (bn[0].length === 0) {
      BARE_NEGATOR_RE.lastIndex++;
      continue;
    }
    const end = bn.index + bn[0].length;
    if (end > clause.end) continue;
    if (!boundaryOk(masked, bn.index, end)) continue;
    if (!ellipticalScopeOk(masked, bn.index, clause)) continue;
    found.push({
      start: bn.index,
      end,
      text: masked.slice(bn.index, end),
      cls: "negator",
      elliptical: true,
    });
  }
  /* Discontinuous exclusive frame (F03b): restrict/limit/confine/narrow + "to"
   * across a BOUNDED run of closed-set filler is one exclusive cue. */
  RESTRICT_VERB_RE.lastIndex = clause.start;
  let v: RegExpExecArray | null;
  while ((v = RESTRICT_VERB_RE.exec(masked)) !== null) {
    if (v.index >= clause.end) break;
    if (v[0].length === 0) {
      RESTRICT_VERB_RE.lastIndex++;
      continue;
    }
    if (!boundaryOk(masked, v.index, v.index + v[0].length)) continue;
    const frameEnd = restrictFrameEnd(masked, v.index + v[0].length, clause);
    if (frameEnd === null) continue;
    found.push({
      start: v.index,
      end: frameEnd,
      text: masked.slice(v.index, frameEnd),
      cls: "exclusive",
    });
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
  const clauses = splitClauses(text);

  for (const clause of clauses) {
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
          /* An elliptical bare negator ("… , not Y") is the weakest cue in the
           * grammar: it may only govern a target that FOLLOWS it across nothing
           * but filler. That companion law is what keeps "no restrictions on X"
           * and "…is not X's fault" from becoming an exclusion of X. */
          if (c.elliptical && !ellipticalGoverns(text, c.end, occ.start)) continue;
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

  /* Supersession pass (F03b). A clause that states BOTH an explicit broadening
   * speech act and a supersession marker retracts an ALLOW-WALL whose cue and
   * target precede it - the current instruction wins over the obsolete one.
   * Three laws keep this honest: only an exclusive allow is retracted (never a
   * block, never a mere preference), the wall must PRECEDE the frame (a later
   * restriction still arms), and the withdrawal is a RECORD the caller can
   * report, never a silent widening. A restriction in the same clause after
   * the broadening phrase is not retracted. */
  for (const clause of clauses) {
    const frame = broadeningFrameOf(text, clause);
    if (!frame) continue;
    const retracted = new Set<string>();
    for (const prior of out.slice()) {
      if (prior.polarity !== "allow" || !prior.exclusivity) continue;
      if (prior.cueEnd > frame.start) continue;
      if (retracted.has(prior.target)) continue;
      retracted.add(prior.target);
      out.push({
        target: prior.target,
        polarity: "cancel",
        cueClass: "broadening",
        cue: frame.text,
        authority: prior.authority,
        exclusivity: false,
        postposed: false,
        corrected: false,
        supersession: true,
        clauseIndex: clause.index,
        clauseStart: clause.start,
        clauseEnd: clause.end,
        scopeStart: clause.start,
        cueStart: frame.start,
        cueEnd: frame.end,
        targetStart: prior.targetStart,
        targetEnd: prior.targetEnd,
        evidence: userPrompt.slice(prior.targetStart, prior.targetEnd),
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
