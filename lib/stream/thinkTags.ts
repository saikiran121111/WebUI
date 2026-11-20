/**
 * Split inline <think>...</think> blocks into two channels.
 * Handles tags split across chunk boundaries by looking back into the tail.
 *
 * Fence-aware (brief 2026-11-15 F17): an inline tag inside a fenced code
 * block (``` or ~~~) is LITERAL text - a model demonstrating the tag in
 * code must not have its example swallowed into the reasoning channel.
 *
 * Literal-code law (brief 2026-11-16 section 6): ONLY a delimiter that the
 * markdown says is REAL switches channels. Code content is literal text of
 * the CURRENT channel. Three reproduced loss classes are fixed here:
 *   1. an inline code span (a tag written between backticks) was scanned as
 *      a real delimiter pair, so the example vanished from the answer;
 *   2. a 4-space / tab indented code block was scanned the same way;
 *   3. a fence inside a blockquote ("> ```py") never opened, so its contents
 *      - including any tag spelling - was routed into private reasoning.
 * Fixing the loss must NOT swallow live delimiters: a real tag after the
 * code is still a real tag (see the frozen tests).
 *
 * Recognised markdown (CommonMark within an explicit, documented subset):
 *   - FENCE OPENER: a line whose first non-space content (at most 3 spaces
 *     of indent, after an optional blockquote marker ">") is a run of 3+
 *     backticks or 3+ tildes; a backtick fence's info string must contain no
 *     backtick (CommonMark's own rule).
 *   - FENCE CLOSER: a line (same <=3-space indent) of ONLY the same fence
 *     char in a run at least as long as the opener, then spaces/tabs. A
 *     fence opened inside a blockquote also accepts a blockquote-prefixed
 *     closer line and a lazy (unprefixed) closer line; a fence NOT opened in
 *     a blockquote never strips a ">" marker.
 *   - INLINE CODE SPAN: a run of N backticks opens a span that ends at the
 *     next run of EXACTLY N backticks on the SAME line (CommonMark's own
 *     matching rule). Everything between, delimiters included, is literal.
 *     An opening run with no matching closer on that line is plain
 *     punctuation, not a span.
 *   - INDENTED CODE CHUNK: a line whose (blockquote-stripped) body starts
 *     with a tab or 4+ spaces, only when the previous line was blank or this
 *     is the start of the field; the chunk continues through blank lines and
 *     ends at the first blank-or-not line that is neither blank nor indented.
 * Indentation is measured on the blockquote-stripped body, and classification
 * never rewrites bytes: what is emitted is always the ORIGINAL text.
 *
 * Chunking-invariance law: a line whose open/close/indented-code intent is
 * not yet decidable stays wholly unprocessed until its newline (or stream
 * end) is known, and an unterminated line parks from the first backtick run
 * whose span match is not yet decidable. Routing therefore depends on the
 * CONTENT only, never on where field pieces were split. Fences and spans are
 * honored inside reasoning blocks too - an unclosed "</think>" inside code
 * does not close the block.
 *
 * The Rust port is rust-backend/crates/ruke-server/src/chat/scrubber.rs
 * (ThinkFieldSplitter); the two machines MUST stay behaviorally identical -
 * same holdback law, same chunking invariance. Cross-engine chunk vectors are
 * re-recorded by __tests__/rust-golden/sse-vectors.test.ts into
 * rust-backend/fixtures/sse/02-think-split-matrix.json and replayed by
 * crates/ruke-server/tests/scrubber_vectors.rs.
 */

const OPEN = "<think>";
const CLOSE = "</think>";
const BACKTICK = "`";

export interface ThinkSplit {
  content: string;
  reasoning: string;
}

/**
 * Legacy stateless one-shot split (kept for the lib/stream public surface).
 * NOT fence/span/indent-aware and NOT holdback-safe: streaming consumers must
 * use createThinkSplitter(), which is the exact machine.
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
 * Stateful splitter (I02 + F17 + F05 literal code). Holds back any tail that
 * could still change the routing - a partial delimiter of the current
 * channel's tag ("<think>" outside, "</think>" inside), a fence-candidate or
 * indented-code-candidate line, or an unterminated line whose first backtick
 * run has no proven closer yet - so a delimiter split across network chunks
 * can never leak: "<thi" + "nk>SECRET" produces ZERO content. Channel
 * switches inside one chunk are handled by the scan loop. flush() releases
 * any still-held tail as LITERAL text in the current channel at end of
 * stream - an unclosed fence, span, indented block or think block never
 * deletes anything (2026-11-13 brief section 2).
 */
export interface ThinkSplitter {
  (chunk: string): ThinkSplit;
  flush(): ThinkSplit;
}

export function createThinkSplitter(): ThinkSplitter {
  let inThink = false;
  // Active fence: "" means outside a fenced code block.
  let fenceChar = "";
  let fenceLen = 0;
  // True when the fence opener was a blockquote-prefixed line, in which case
  // a blockquote-prefixed or lazy closer line may close it.
  let fenceQuoted = false;
  // Inside a 4-space / tab indented code chunk (markdown classification only -
  // bytes are always emitted unchanged).
  let codeIndent = false;
  // Was the line just consumed blank? A chunk of indented code may only start
  // after a blank line (or at the start of the field).
  let lastLineBlank = true;
  let atLineStart = true;
  // Unprocessed tail: an incomplete line whose line-start classification is
  // still open and/or (once it is settled) a partial-delimiter suffix.
  let held = "";

  const emit = (out: ThinkSplit, piece: string) => {
    if (!piece) return;
    if (inThink) out.reasoning += piece;
    else out.content += piece;
  };

  /**
   * Scan [i, end) of `text` - a TERMINATED line body, so it contains no "\n"
   * and every delimiter lies wholly inside the window. Commits everything:
   * nothing left to hold. Code spans are consumed before any tag inside them,
   * so a tag spelled inside a span never switches channel.
   */
  const scanLine = (out: ThinkSplit, text: string, i: number, end: number): void => {
    while (i < end) {
      const tag = inThink ? CLOSE : OPEN;
      const at = text.indexOf(tag, i);
      const run = nextBacktick(text, i, end);
      if (at !== -1 && at < end && (run === -1 || at < run)) {
        emit(out, text.slice(i, at));
        inThink = !inThink;
        i = at + tag.length;
        continue;
      }
      if (run === -1) {
        emit(out, text.slice(i, end));
        return;
      }
      // A backtick run precedes any tag hit in this window.
      emit(out, text.slice(i, run));
      const len = runLen(text, run, end);
      const close = findSpanClose(text, run + len, end, len);
      if (close === -1) {
        // No closer on this line: the run is literal punctuation.
        emit(out, text.slice(run, run + len));
        i = run + len;
        continue;
      }
      emit(out, text.slice(run, close + len)); // the WHOLE span, verbatim
      i = close + len;
    }
  };

  /**
   * Process the rest of an UNTERMINATED line (runs to buffer end): span-aware
   * scan plus the holdback rule - park a partial-delimiter suffix of the
   * current channel's tag, and park from a backtick run whose span match is
   * not yet decidable (its closer, or the run's own length, may still arrive).
   */
  const scanToBufferEnd = (out: ThinkSplit, text: string, i: number): void => {
    while (i < text.length) {
      const tag = inThink ? CLOSE : OPEN;
      const at = text.indexOf(tag, i);
      const run = nextBacktick(text, i, text.length);
      if (at !== -1 && (run === -1 || at < run)) {
        emit(out, text.slice(i, at));
        inThink = !inThink;
        i = at + tag.length;
        continue;
      }
      if (run === -1) {
        const stop = at === -1 ? holdStart(text, i, tag) : at;
        emit(out, text.slice(i, stop));
        held = text.slice(stop);
        return;
      }
      emit(out, text.slice(i, run));
      const len = runLen(text, run, text.length);
      const close = findSpanClose(text, run + len, text.length, len);
      if (close === -1 || run + len >= text.length || close + len >= text.length) {
        // Undecidable until more bytes arrive - park from the run itself.
        held = text.slice(run);
        return;
      }
      emit(out, text.slice(run, close + len));
      i = close + len;
    }
  };

  /**
   * End-of-stream law: once the stream has ended, no further byte can change
   * a line, so a parked tail's line-start classification (fence opener,
   * indented code chunk, ordinary prose line) IS decidable. flush() therefore
   * classifies and ROUTES the tail like any other complete line instead of
   * dumping it as literal text - only a tail parked inside a fenced block, an
   * indented code chunk or a real fence opener line stays literal. A tail
   * parked inside an already-classified line is a partial delimiter or an
   * unmatched code run: at end of stream neither can complete any more, so it
   * is scanned as a final line body (literal where undecidable).
   */
  const finishHeld = (out: ThinkSplit): void => {
    if (!held) return;
    const text = held; // never contains a newline: parks take one line suffix
    held = "";
    if (fenceChar) {
      emit(out, text); // inside a fenced block: tags are literal
      return;
    }
    if (!atLineStart) {
      scanLine(out, text, 0, text.length);
      return;
    }
    const body = stripBlockquote(text);
    if (codeIndent && (isBlankLine(body) || isIndentedCodeLine(body))) {
      emit(out, text);
      return;
    }
    if (codeIndent) codeIndent = false;
    if (isIndentedCodeLine(body) && lastLineBlank) {
      codeIndent = true;
      emit(out, text);
      return;
    }
    const open = parseOpenLine(body);
    if (open) {
      fenceChar = open.char;
      fenceLen = open.len;
      fenceQuoted = body !== text;
      emit(out, text);
      return;
    }
    scanLine(out, text, 0, text.length);
    lastLineBlank = isBlankLine(body);
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
        // Markdown classification only (fence / indented code). NEVER used to
        // rewrite bytes - every emit below takes the ORIGINAL text.
        const body = stripBlockquote(line);

        if (terminated) {
          if (fenceChar) {
            // Inside a fence: the ONLY decision is whether this line closes
            // it. Tags here are literal - the line rides the current channel
            // verbatim (a fence inside a think block stays reasoning text).
            emit(out, text.slice(i, nl + 1));
            if (isCloseLine(line, fenceChar, fenceLen)
              || (fenceQuoted && isCloseLine(body, fenceChar, fenceLen))) {
              fenceChar = "";
              fenceLen = 0;
              fenceQuoted = false;
            }
          } else if (codeIndent && (isBlankLine(body) || isIndentedCodeLine(body))) {
            // Blank or still-indented line: continuation of the code chunk,
            // its tags are literal.
            emit(out, text.slice(i, nl + 1));
          } else if (codeIndent) {
            // The indented chunk ended at this non-indented, non-blank line;
            // an indented chunk cannot start here, so classify as ordinary.
            codeIndent = false;
            const open = parseOpenLine(body);
            if (open) {
              fenceChar = open.char;
              fenceLen = open.len;
              fenceQuoted = body !== line;
              emit(out, text.slice(i, nl + 1));
            } else {
              // Ordinary line: tag/span-scan its body, then the newline
              // belongs to whatever channel the last switch left.
              scanLine(out, text, i, bodyEnd);
              emit(out, "\n");
            }
          } else if (isIndentedCodeLine(body) && lastLineBlank) {
            codeIndent = true;
            emit(out, text.slice(i, nl + 1));
          } else {
            const open = parseOpenLine(body);
            if (open) {
              fenceChar = open.char;
              fenceLen = open.len;
              fenceQuoted = body !== line;
              emit(out, text.slice(i, nl + 1));
            } else {
              scanLine(out, text, i, bodyEnd);
              emit(out, "\n");
            }
          }
          lastLineBlank = isBlankLine(body);
          i = nl + 1; // the next line starts at a line start
          continue;
        }

        // Unterminated line: anything whose line-start classification (fence
        // open/close, indented code) is still open parks WHOLE - that intent
        // is undecidable until the newline (or stream end) is known. Leading
        // space/tab and ">" (a blockquote fence) always qualify.
        if (couldBeFenceLine(line, fenceChar)) {
          held = text.slice(i);
          break;
        }
        atLineStart = false;
      }

      // Mid-line (the current line is already known not to open or close a
      // fence or indented chunk - a transition is only possible at a line
      // start, and every such line parked while unterminated).
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
    // Everything still held is COMPLETE text at this point: an unterminated
    // block, an unclosed fence, an unmatched code span or an unfinished
    // fence/indented-code line all release as LITERAL text of the current
    // channel - never deleted. A tail that is ordinary prose still gets its
    // real delimiters routed (the law is literal CODE, not literal silence).
    finishHeld(out);
    return out;
  };

  return next;
}

/**
 * Could this (possibly incomplete) line still open or close a fence, or open
 * / continue an indented code chunk? Leading spaces and tabs always qualify;
 * outside a fence ` / ~ starts and ">" (a blockquote fence opener) qualify;
 * inside a fence the active fence char qualifies, and ">" qualifies because a
 * blockquoted fence closes on a blockquote-prefixed line.
 */
function couldBeFenceLine(line: string, fenceChar: string): boolean {
  if (!line) return false;
  if (line[0] === " " || line[0] === "\t" || line[0] === ">") return true;
  return fenceChar ? line[0] === fenceChar : line[0] === "`" || line[0] === "~";
}

/**
 * Strip blockquote markers for CLASSIFICATION only (never for output):
 * repeated [up to 3 spaces] ">" [one optional space or tab].
 */
function stripBlockquote(line: string): string {
  let p = 0;
  for (;;) {
    let q = p;
    while (q < p + 3 && line[q] === " ") q++;
    if (line[q] !== ">") return line.slice(p);
    q++;
    if (line[q] === " " || line[q] === "\t") q++;
    p = q;
  }
}

/** A line of nothing but spaces/tabs (a CR from CRLF counts as blank). */
function isBlankLine(line: string): boolean {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== " " && c !== "\t" && c !== "\r") return false;
  }
  return true;
}

/** Tab-indented, or indented by 4+ spaces (measured on the stripped body). */
function isIndentedCodeLine(line: string): boolean {
  if (!line) return false;
  if (line[0] === "\t") return true;
  return line.startsWith("    ");
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

/** Index of the next backtick in [from, limit), or -1. */
function nextBacktick(text: string, from: number, limit: number): number {
  const q = text.indexOf(BACKTICK, from);
  return q !== -1 && q < limit ? q : -1;
}

/** Length of the backtick run starting at `start`, capped at `limit`. */
function runLen(text: string, start: number, limit: number): number {
  let q = start;
  while (q < limit && text[q] === BACKTICK) q++;
  return q - start;
}

/**
 * Start index of the FIRST backtick run of EXACTLY `len` backticks in
 * [from, limit) - CommonMark's code-span closer rule (a run of a different
 * length is span content, not a closer). -1 when there is no closer in the
 * window.
 */
function findSpanClose(text: string, from: number, limit: number, len: number): number {
  let p = from;
  while (p < limit) {
    const q = nextBacktick(text, p, limit);
    if (q === -1) return -1;
    const r = runLen(text, q, limit);
    if (r === len) return q;
    p = q + r;
  }
  return -1;
}

/**
 * Start index of the longest suffix of `text` that is a PROPER prefix of
 * `tag` (and lies at or after `from`). Returns text.length when no such
 * suffix exists - nothing to hold back.
 */
function holdStart(text: string, from: number, tag: string): number {
  const max = Math.min(tag.length - 1, text.length - from);
  for (let k = max; k >= 1; k--) {
    if (text.endsWith(tag.slice(0, k))) return text.length - k;
  }
  return text.length;
}