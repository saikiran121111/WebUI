export type QueryMode = "point_qa" | "time_range" | "sequential" | "exhaustive" | "whole_video";

/**
 * F07 (2026-11-15): the TIME AXIS is a property of the content, not of the
 * wording. A document or a spreadsheet has no timeline, so "the 1:20 ratio in
 * this document" used to fabricate a time window and route to video keyframes
 * (reproduced: document ratio 1:20 selected video time-range retrieval). The
 * caller reads the axis off the index it is asking (durationSec / any timed
 * chunk), never off the model and never off the attachment name.
 */
export type RouteAxis = "time" | "text";

export interface RouteScope {
  axis?: RouteAxis;
}

/** One bounded time cue. Comparative asks keep their cues SEPARATE (F07). */
export interface TimeWindow {
  fromSec: number;
  toSec: number;
}

export interface RoutedQuery {
  mode: QueryMode;
  fromSec?: number;
  toSec?: number;
  /** 0-based spine block for `sequential` ("module 2" → 1). */
  blockIndex?: number;
  /**
   * "last N minutes" (I22): a window anchored at the END of the content.
   * The router has no index access, so the turn resolves this against
   * `meta.durationSec` (time_range [dur − lastSec, dur]) and downgrades to
   * `point_qa` best-effort when the duration is unknown.
   */
  lastSec?: number;
  /**
   * F07: "compare the intro at 0:30 with the recap at 9:00" names TWO cues.
   * A single [min,max] hull drags every unrelated passage BETWEEN them into
   * the evidence, so comparative asks carry per-cue windows here while
   * fromSec/toSec stay the hull for consumers that only understand one range.
   */
  windows?: TimeWindow[];
}

/**
 * §6 Unicode word-boundary law (⇔ ruke-attach router.rs `is_word_char`):
 * JS `\b` is ASCII-only, so it treated every non-ASCII letter as a word
 * BOUNDARY — "café1:45" fired the timestamp rules while "this1:45" did not.
 * `[\p{L}\p{N}\p{M}_]` makes glue glue in EVERY script, and combining marks
 * (Telugu vowel signs, Devanagari matras/virama, Thai sara) belong to their
 * word, never to a boundary. Variable-width lookbehind is fine in V8; the
 * `u` flag is required for the \p classes.
 */
const WB_L = String.raw`(?<![\p{L}\p{N}\p{M}_])`;
const WB_R = String.raw`(?![\p{L}\p{N}\p{M}_])`;
const wordRe = (body: string, flags = "") =>
  new RegExp(`${WB_L}(?:${body})${WB_R}`, flags + (flags.includes("u") ? "" : "u"));

const HMS = wordRe(String.raw`(\d{1,2}):([0-5]\d):([0-5]\d)`, "g");
const MS = wordRe(String.raw`(\d{1,2}):([0-5]\d)`, "g");

/** +-180 s around an explicit cue (the window law the golden replays pin). */
const WINDOW_PAD_SEC = 180;

/**
 * F07 exhaustiveness / wholeness classes, compiled once with `g` and consulted
 * occurrence-by-occurrence through `unblocked`. The old code called bare
 * `.test()` on an inline wordRe, so a negation ANYWHERE in the sentence still
 * hijacked the route ("do not summarize; find the invoice number" became a
 * whole-content summary) and an explicit occurrence ask stayed point QA
 * ("find every occurrence of the logo"). Negation scope is CLAUSE-local:
 * "not X" suppresses X, it does not suppress the rest of the sentence.
 */
const EXHAUSTIVE_RE = wordRe(
  String.raw`every time|all (?:the )?times|how many times|list every|every mention|each mention|wherever|any time|mentioned how often|all (?:the )?mentions?|list all` +
    String.raw`|every (?:single )?(?:occurrence|instance|appearance|example|place|spot|time)|all (?:the )?(?:occurrences|instances|appearances|examples|places|spots)|each (?:occurrence|instance|appearance|example|place|spot)`,
  "g",
);

const WHOLE_RE = wordRe(
  String.raw`summar(?:y|ize|ise)|outline|course notes|main points|key points|whole (?:video|course|lecture)|entire (?:video|course|lecture)|teach me the (?:whole|entire)|walk me through the (?:whole|entire)|from (?:the )?beginning to (?:the )?end`,
  "g",
);

const NEGATION_RE = wordRe(
  String.raw`not|no|never|nor|without|neither|cannot|ca(?:n'?t)|don'?t|doesn'?t|didn'?t|won'?t|isn'?t|aren'?t|wasn'?t|weren'?t|needn'?t|no need|needless|avoid|refrain|omit|skip|instead of|rather than`,
);

/** Juxtaposed cues asked side by side are COMPARED, not spanned. */
const COMPARATIVE_RE = wordRe(
  String.raw`compare|compared|comparison|contrast|versus|vs|difference|as well as|separately|each of|instead of|rather than|one by one|before and after`,
);

const CLAUSE_END = /[.;,!?:\n]/;

/**
 * F07: is the ask at offset `at` inside a NEGATED clause? The clause starts at
 * the last clause/sentence separator before it, so "do not summarize; find the
 * invoice number" negates only "summarize".
 */
function negatedInClause(text: string, at: number): boolean {
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (CLAUSE_END.test(text[i])) {
      start = i + 1;
      break;
    }
  }
  return NEGATION_RE.test(text.slice(start, at));
}

/** True when at least one occurrence of `re` sits in an UNNEGATED clause. */
function unblocked(re: RegExp, text: string): boolean {
  for (const m of text.matchAll(re)) {
    if (!negatedInClause(text, m.index ?? 0)) return true;
  }
  return false;
}

const comparativeAsk = (text: string): boolean => COMPARATIVE_RE.test(text);

/**
 * Regex-only query routing (zero LLM calls). Order matters: explicit time
 * windows beat "module N", which beats exhaustive-mention phrasing, which
 * beats whole-content summary phrasing; everything else is point Q&A.
 */
export function routeQuery(q: string, scope: RouteScope = {}): RoutedQuery {
  const text = q.toLowerCase();
  // Default "time" keeps every pre-F07 pin; a caller that knows the content
  // has no timeline passes { axis: "text" } and no time rule can fire.
  const axis = scope.axis ?? "time";

  // Explicit timestamps: "from 1:00:00 to 1:30:00", "around 12:30".
  const times: number[] = [];
  const stripped = q
    .replace(HMS, (_s, h, m, s) => {
      times.push(+h * 3600 + +m * 60 + +s);
      return " ";
    })
    .replace(MS, (_s, m, s) => {
      times.push(+m * 60 + +s);
      return " ";
    });
  if (axis === "time" && times.length >= 2) {
    const fromSec = Math.min(...times);
    const toSec = Math.max(...times);
    const windows: TimeWindow[] = times.map(c => ({
      fromSec: Math.max(0, c - WINDOW_PAD_SEC),
      toSec: c + WINDOW_PAD_SEC,
    }));
    return {
      mode: "time_range",
      fromSec,
      toSec,
      ...(comparativeAsk(text) ? { windows } : {}),
    };
  }
  if (axis === "time" && times.length === 1) {
    const c = times[0];
    return {
      mode: "time_range",
      fromSec: Math.max(0, c - WINDOW_PAD_SEC),
      toSec: c + WINDOW_PAD_SEC,
    };
  }

  const firstMin =
    axis === "time" ? wordRe(String.raw`first\s+(\d{1,3})\s*(?:minutes?|mins?|m)`).exec(text) : null;
  if (firstMin) return { mode: "time_range", fromSec: 0, toSec: +firstMin[1] * 60 };

  const atMin =
    axis === "time" ? wordRe(String.raw`(?:at|around)\s+(?:minute|min)\s*(\d{1,3})`).exec(text) : null;
  if (atMin) {
    const c = +atMin[1] * 60;
    return { mode: "time_range", fromSec: Math.max(0, c - 180), toSec: c + 180 };
  }

  // I22: "show me the last 10 minutes" — no absolute anchor exists until
  // the turn consults meta.durationSec.
  const lastMin =
    axis === "time" ? wordRe(String.raw`last\s+(\d{1,3})\s*(?:minutes?|mins?|m)`).exec(text) : null;
  if (lastMin) return { mode: "time_range", lastSec: +lastMin[1] * 60 };

  const block = wordRe(String.raw`(?:module|section|chapter|part|lesson|unit)\s+(\d{1,2})`).exec(text);
  if (block) return { mode: "sequential", blockIndex: +block[1] - 1 };

  if (unblocked(EXHAUSTIVE_RE, text)) {
    return { mode: "exhaustive" };
  }

  if (unblocked(WHOLE_RE, text)) {
    return { mode: "whole_video" };
  }

  return { mode: "point_qa" };
}

/**
 * F07: stable query IDENTITY for the shown ledger. Normalized whitespace and
 * case, then FNV-1a 32 over the UTF-8 BYTES so the Rust mirror computes the
 * identical string in the shared .shown.json. Format "<fnv1a32 hex>:<bytes>".
 * It encodes no meaning at all -- it answers exactly one question: "is this
 * literally the same question again?"
 */
export function fingerprintQuery(s: string): string {
  const norm = s.toLowerCase().replace(/\s+/g, " ").trim();
  const bytes = new TextEncoder().encode(norm);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${bytes.length}`;
}

/**
 * F07: an explicit ask for MORE of the same material. Only these rotate to
 * fresh passages -- an unanswered repeat question must get its own answer back
 * instead of a demoted substitute (reproduced: a repeated exact question lost
 * its answer because the passages it had been shown were demoted).
 */
const CONTINUATION_RE = wordRe(
  String.raw`continue|keep going|go on|carry on|what else|anything else|any more|more of|the rest|further|other (?:passages?|parts?|sections?|examples?|items?|ones?)|different (?:passages?|parts?|sections?|examples?|items?|ones?)|next (?:part|section|passage|bit|chunk|page|slide)`,
);

export function isContinuationAsk(s: string): boolean {
  // Case-folded on purpose: "Keep going" and "keep going" are the same ask.
  // (Rust `is_continuation_ask` mirrors this exactly.)
  return CONTINUATION_RE.test(s.toLowerCase());
}
