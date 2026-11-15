/**
 * Split inline <think>...</think> blocks into two channels.
 * Handles tags split across chunk boundaries by looking back into the tail.
 *
 * Fence-aware (brief 2026-11-15 F17): an inline tag inside a fenced code
 * block (``` or ~~~) is LITERAL text — a model demonstrating the tag in
 * code must not have its example swallowed into the reasoning channel.
 * Fence recognition follows CommonMark within a documented subset:
 *   - an OPENER is a line whose first non-space content (at most 3 spaces
 *     of indent) is a run of 3+ ` or 3+ ~; a backtick fence's info string
 *     must contain no backtick (CommonMark's own rule);
 *   - a CLOSER is a line (same ≤3-space indent) of ONLY the same fence
 *     char in a run at least as long as the opener, then spaces/tabs.
 * Chunking-invariance law: a line that could open or close a fence stays
 * wholly unprocessed until its newline (or stream end) is known, so
 * routing depends on the CONTENT only, never on where field pieces were
 * split. Fences are honored inside reasoning blocks too — an unclosed
 * `</think>` inside a fence does not close the block.
 *
 * The Rust port is rust-backend/crates/ruke-server/src/chat/scrubber.rs
 * (`ThinkFieldSplitter`); the two machines MUST stay behaviorally
 * identical — same holdback law, same chunking invariance.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

export interface ThinkSplit {
  content: string;
  reasoning: string;
}

/**
 * Legacy stateless one-shot split (kept for the lib/stream public surface).
 * NOT fence-aware and NOT holdback-safe: streaming consumers must use
 * createThinkSplitter(), which is the exact machine.
 */
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
 * Stateful splitter (I02 + F17). Holds back any tail that could be the
 * start of the delimiter for the current channel (`<think>` outside,
 * `</think>` inside) so a tag split across network chunks can never leak:
 * `<thi` + `nk>SECRET` produces ZERO content. Channel switches inside one
 * chunk are handled by the scan loop. Fence-candidate lines park whole
 * until their newline arrives (F17). `flush()` releases any still-held
 * tail as literal text in the current channel at end-of-stream — an
 * unclosed fence or block never deletes anything (2026-11-13 brief §2).
 */
export interface ThinkSplitter {
  (chunk: string): ThinkSplit;
  flush(): ThinkSplit;
}

export function createThinkSplitter(): ThinkSplitter {
  let inThink = false;
  // Active fence: "" ⇔ outside a fenced code block.
  let fenceChar = "";
  let fenceLen = 0;
  let atLineStart = true;
  // Unprocessed tail: an incomplete fence-candidate line and/or (when the
  // line cannot be fence-relevant) a partial-delimiter suffix.
  let held = "";

  const emit = (out: ThinkSplit, piece: string) => {
    if (!piece) return;
    if (inThink) out.reasoning += piece;
    else out.content += piece;
  };

  // Scan [i, end) of `text` — a terminated line body, so it contains no
  // "\n" and every tag found lies wholly inside the window (a tag can
  // never straddle a newline). Commits everything: nothing left to hold.
  const scanLine = (out: ThinkSplit, text: string, i: number, end: number): void => {
    while (i < end) {
      const tag = inThink ? CLOSE : OPEN;
      const at = text.indexOf(tag, i);
      if (at === -1 || at >= end) {
        emit(out, text.slice(i, end));
        return;
      }
      emit(out, text.slice(i, at));
      inThink = !inThink;
      i = at + tag.length;
    }
  };

  // Process the rest of an unterminated line (runs to buffer end): the old
  // holdback scan — park only a partial-delimiter suffix of the current
  // channel's tag at the very end of the buffer.
  const scanToBufferEnd = (out: ThinkSplit, text: string, i: number): void => {
    while (i < text.length) {
      const tag = inThink ? CLOSE : OPEN;
      const at = text.indexOf(tag, i);
      const end = at === -1 ? holdStart(text, i, tag) : at;
      emit(out, text.slice(i, end));
      if (at === -1) {
        held = text.slice(end);
        return;
      }
      inThink = !inThink;
      i = end + tag.length;
    }
  };

  const next = function (chunk: string): ThinkSplit {
    const text = held + chunk;
    held = "";
    const out: ThinkSplit = { content: "", reasoning: "" };
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf("\n", i);
      const terminated = nl !== -1;
      const bodyEnd = terminated ? nl : text.length;

      if (atLineStart) {
        const line = text.slice(i, bodyEnd);
        if (terminated) {
          if (fenceChar) {
            // Inside a fence: the ONLY decision is whether this line closes
            // it. Tags here are literal — the line rides the current channel
            // verbatim (a fence inside a think block stays reasoning text).
            emit(out, text.slice(i, nl + 1));
            if (isCloseLine(line, fenceChar, fenceLen)) {
              fenceChar = "";
              fenceLen = 0;
            }
          } else {
            const open = parseOpenLine(line);
            if (open) {
              fenceChar = open.char;
              fenceLen = open.len;
              emit(out, text.slice(i, nl + 1));
            } else {
              // Ordinary line: tag-scan its body, then the newline belongs
              // to whatever channel the last switch left.
              scanLine(out, text, i, bodyEnd);
              emit(out, "\n");
            }
          }
          i = nl + 1; // the next line starts at a line start
          continue;
        }
        // Unterminated line: a fence-candidate line parks WHOLE — its
        // open/close intent is undecidable until the newline (or stream
        // end) is known. Any other line processes below, mid-line-style.
        if (couldBeFenceLine(line, fenceChar)) {
          held = text.slice(i);
          break;
        }
        atLineStart = false;
      }

      // Mid-line (the current line is already known not to open or close a
      // fence — a fence transition is only possible at a line start).
      if (fenceChar) {
        const stop = terminated ? nl + 1 : text.length;
        emit(out, text.slice(i, stop));
        i = stop;
        atLineStart = terminated;
        continue;
      }
      if (terminated) {
        scanLine(out, text, i, bodyEnd);
        emit(out, "\n");
        i = nl + 1;
        atLineStart = true;
        continue;
      }
      scanToBufferEnd(out, text, i);
      break; // consumed everything consumable (held tail may be set)
    }
    return out;
  } as ThinkSplitter;

  next.flush = function (): ThinkSplit {
    const out: ThinkSplit = { content: "", reasoning: "" };
    if (held) {
      // A partial delimiter, an unfinished fence line, an unterminated
      // block or an unclosed fence: all release as LITERAL text of the
      // current channel — never deleted, never flips the channel.
      emit(out, held);
      held = "";
    }
    return out;
  };

  return next;
}

/**
 * Could this (possibly incomplete) line still open or close a fence?
 * Leading spaces always qualify (the ≤3-space rule is only decidable
 * once the first non-space char arrives); outside a fence only ` / ~
 * starts qualify; inside a fence only the active fence char can.
 */
function couldBeFenceLine(line: string, fenceChar: string): boolean {
  if (!line) return false;
  if (line[0] === " ") return true;
  return fenceChar ? line[0] === fenceChar : line[0] === "`" || line[0] === "~";
}

interface FenceOpen {
  char: string;
  len: number;
}

/** Recognize a fence OPENER line (CommonMark subset, see file header). */
function parseOpenLine(line: string): FenceOpen | null {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  let p = 0;
  while (p < body.length && p < 4 && body[p] === " ") p++;
  if (p >= body.length || p === 4) return null; // blank line or 4+ space indent
  const c = body[p];
  if (c !== "`" && c !== "~") return null;
  let q = p;
  while (q < body.length && body[q] === c) q++;
  const len = q - p;
  if (len < 3) return null;
  if (c === "`" && body.slice(q).includes("`")) return null; // info must not contain `
  return { char: c, len };
}

/** Recognize a CLOSER line for the active fence (see file header). */
function isCloseLine(line: string, fenceChar: string, fenceLen: number): boolean {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  let p = 0;
  while (p < body.length && p < 4 && body[p] === " ") p++;
  if (p >= body.length || p === 4) return false;
  if (body[p] !== fenceChar) return false;
  let q = p;
  while (q < body.length && body[q] === fenceChar) q++;
  if (q - p < fenceLen) return false;
  for (let k = q; k < body.length; k++) {
    if (body[k] !== " " && body[k] !== "\t") return false;
  }
  return true;
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
