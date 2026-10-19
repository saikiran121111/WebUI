export type QueryMode = "point_qa" | "time_range" | "sequential" | "exhaustive" | "whole_video";

export interface RoutedQuery {
  mode: QueryMode;
  fromSec?: number;
  toSec?: number;
  /** 0-based spine block for `sequential` ("module 2" → 1). */
  blockIndex?: number;
}

const HMS = /\b(\d{1,2}):([0-5]\d):([0-5]\d)\b/g;
const MS = /\b(\d{1,2}):([0-5]\d)\b/g;

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
    .replace(new RegExp(HMS.source, "g"), (_s, h, m, s) => {
      times.push(+h * 3600 + +m * 60 + +s);
      return " ";
    })
    .replace(new RegExp(MS.source, "g"), (_s, m, s) => {
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

  const firstMin = /\bfirst\s+(\d{1,3})\s*(?:minutes?|mins?|m)\b/.exec(text);
  if (firstMin) return { mode: "time_range", fromSec: 0, toSec: +firstMin[1] * 60 };

  const atMin = /\b(?:at|around)\s+(?:minute|min)\s*(\d{1,3})\b/.exec(text);
  if (atMin) {
    const c = +atMin[1] * 60;
    return { mode: "time_range", fromSec: Math.max(0, c - 180), toSec: c + 180 };
  }

  const block = /\b(?:module|section|chapter|part|lesson|unit)\s+(\d{1,2})\b/.exec(text);
  if (block) return { mode: "sequential", blockIndex: +block[1] - 1 };

  if (
    /\b(every time|all (?:the )?times|how many times|list every|every mention|each mention|wherever|any time|mentioned how often)\b/.test(
      text,
    )
  ) {
    return { mode: "exhaustive" };
  }

  if (
    /\b(summar(?:y|ize|ise)|outline|course notes|main points|key points|whole (?:video|course|lecture)|entire (?:video|course|lecture)|teach me the (?:whole|entire)|walk me through the (?:whole|entire)|from (?:the )?beginning to (?:the )?end)\b/.test(
      text,
    )
  ) {
    return { mode: "whole_video" };
  }

  return { mode: "point_qa" };
}
