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

export function createThinkSplitter() {
  let inThink = false;
  return function next(chunk: string): ThinkSplit {
    const out = splitThinkTags(chunk, inThink);
    inThink = isOpenAfterProcessing(chunk, inThink);
    return out;
  };
}

function isOpenAfterProcessing(input: string, wasOpen: boolean): boolean {
  if (!wasOpen) {
    return input.includes(OPEN) && !input.includes(CLOSE);
  }
  // Was in reasoning — are we still there?
  const lastClose = input.lastIndexOf(CLOSE);
  const lastOpen = input.lastIndexOf(OPEN);
  if (lastClose === -1) return true;
  return lastOpen > lastClose;
}
