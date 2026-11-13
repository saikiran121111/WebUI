export type QueryMode = "point_qa" | "time_range" | "sequential" | "exhaustive" | "whole_video";

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

/**
 * Regex-only query routing (zero LLM calls). Order matters: explicit time
 * windows beat "module N", which beats exhaustive-mention phrasing, which
 * beats whole-content summary phrasing; everything else is point Q&A.
 */
export function routeQuery(q: string): RoutedQuery {
  const text = q.toLowerCase();

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
  if (times.length >= 2) {
    return { mode: "time_range", fromSec: Math.min(...times), toSec: Math.max(...times) };
  }
  if (times.length === 1) {
    const c = times[0];
    return { mode: "time_range", fromSec: Math.max(0, c - 180), toSec: c + 180 };
  }

  const firstMin = wordRe(String.raw`first\s+(\d{1,3})\s*(?:minutes?|mins?|m)`).exec(text);
  if (firstMin) return { mode: "time_range", fromSec: 0, toSec: +firstMin[1] * 60 };

  const atMin = wordRe(String.raw`(?:at|around)\s+(?:minute|min)\s*(\d{1,3})`).exec(text);
  if (atMin) {
    const c = +atMin[1] * 60;
    return { mode: "time_range", fromSec: Math.max(0, c - 180), toSec: c + 180 };
  }

  // I22: "show me the last 10 minutes" — no absolute anchor exists until
  // the turn consults meta.durationSec.
  const lastMin = wordRe(String.raw`last\s+(\d{1,3})\s*(?:minutes?|mins?|m)`).exec(text);
  if (lastMin) return { mode: "time_range", lastSec: +lastMin[1] * 60 };

  const block = wordRe(String.raw`(?:module|section|chapter|part|lesson|unit)\s+(\d{1,2})`).exec(text);
  if (block) return { mode: "sequential", blockIndex: +block[1] - 1 };

  if (
    wordRe(
      String.raw`every time|all (?:the )?times|how many times|list every|every mention|each mention|wherever|any time|mentioned how often|all (?:the )?mentions?|list all`,
    ).test(text)
  ) {
    return { mode: "exhaustive" };
  }

  if (
    wordRe(
      String.raw`summar(?:y|ize|ise)|outline|course notes|main points|key points|whole (?:video|course|lecture)|entire (?:video|course|lecture)|teach me the (?:whole|entire)|walk me through the (?:whole|entire)|from (?:the )?beginning to (?:the )?end`,
    ).test(text)
  ) {
    return { mode: "whole_video" };
  }

  return { mode: "point_qa" };
}
