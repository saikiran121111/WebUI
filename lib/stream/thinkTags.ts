/**
 * Split inline <think>...</think> blocks into two channels.
 * Handles tags split across chunk boundaries by looking back into the tail.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

export interface ThinkSplit {
  content: string;
  reasoning: string;
}

export function splitThinkTags(input: string, inThink: boolean): ThinkSplit {
  const result: ThinkSplit = { content: "", reasoning: "" };
  let i = 0;
  let mode = inThink;

  while (i < input.length) {
    if (mode) {
      const end = input.indexOf(CLOSE, i);
      if (end === -1) {
        result.reasoning += input.slice(i);
        break;
      }
      result.reasoning += input.slice(i, end);
      i = end + CLOSE.length;
      mode = false;
    } else {
      const start = input.indexOf(OPEN, i);
      if (start === -1) {
        result.content += input.slice(i);
        break;
      }
      // Text before the think tag
      result.content += input.slice(i, start);
      i = start + OPEN.length;
      mode = true;
    }
  }

  // We cannot tell if the tail ends with a partial close/open tag from this
  // single call. The caller is responsible for tracking inThink state.
  // Any unclosed content in the current mode is already in the result.
  return result;
}

/**
 * Stateful splitter (I02). Holds back any tail that could be the start of
 * the delimiter for the current channel (`<think>` outside, `</think>`
 * inside) so a tag split across network chunks can never leak: `<thi` +
 * `nk>SECRET` produces ZERO content. Channel switches inside one chunk are
 * handled by the scan loop, so open/close re-opening within a single delta
 * is also exact. `flush()` releases any still-held tail as literal text in
 * the current channel at end-of-stream.
 */
export interface ThinkSplitter {
  (chunk: string): ThinkSplit;
  flush(): ThinkSplit;
}

export function createThinkSplitter(): ThinkSplitter {
  let inThink = false;
  let held = ""; // tail that might begin the current channel's delimiter

  const next = function (chunk: string): ThinkSplit {
    const text = held + chunk;
    held = "";
    const out: ThinkSplit = { content: "", reasoning: "" };
    let i = 0;
    while (i < text.length) {
      const tag = inThink ? CLOSE : OPEN;
      const at = text.indexOf(tag, i);
      const end = at === -1 ? holdStart(text, i, tag) : at;
      const emit = text.slice(i, end);
      if (emit) {
        if (inThink) out.reasoning += emit;
        else out.content += emit;
      }
      if (at === -1) {
        held = text.slice(end);
        break;
      }
      inThink = !inThink;
      i = end + tag.length;
    }
    return out;
  } as ThinkSplitter;

  next.flush = function (): ThinkSplit {
    const out: ThinkSplit = { content: "", reasoning: "" };
    if (held) {
      if (inThink) out.reasoning = held;
      else out.content = held;
      held = "";
    }
    return out;
  };

  return next;
}

/**
 * Start index of the longest suffix of `text` that is a PROPER prefix of
 * `tag` (and lies at or after `from`). Returns text.length when no such
 * suffix exists — nothing to hold back.
 */
function holdStart(text: string, from: number, tag: string): number {
  const max = Math.min(tag.length - 1, text.length - from);
  for (let k = max; k >= 1; k--) {
    if (text.endsWith(tag.slice(0, k))) return text.length - k;
  }
  return text.length;
}
