//! Stateful `<think>…</think>` FIELD splitter (2026-11-13 brief §2).
//!
//! This module used to be `ThinkScrubber`: a byte machine that DELETED
//! `<think>…</think>` blocks from the raw transport stream (the Part-4
//! "approved deviation"). That design is retired: it rewrote bytes it had
//! never parsed (a per-chunk TextDecoder mangled multibyte sequences, and an
//! unterminated opener silently swallowed everything after it — including
//! the SSE envelope), and it starved the client's own splitter, which is the
//! component that routes think text to the *reasoning* channel. The 2026-11-13
//! brief forbids silently deleting answer text on a heuristic and mandates
//! "parse SSE/JSON before transforming text fields, normalize once statefully
//! across chunks". Therefore:
//!
//! - the transport paths ([`super::forward`]) are raw byte passthrough;
//! - the audit-loop relays ([`super::browser_loop::ToolStreamRelay`] ⇔ TS
//!   `lib/chat/web-tool-loop.ts`) feed the `delta.content` string of an
//!   ALREADY-PARSED frame through this splitter;
//! - think text is ROUTED to the reasoning channel, never deleted; an
//!   unclosed opener's tail becomes visible reasoning at round end.
//!
//! This is the byte-exact Rust port of `lib/stream/thinkTags.ts`
//! `createThinkSplitter()` ⇔. Both machines MUST stay behaviorally identical:
//! same holdback law (a trailing partial delimiter of the CURRENT channel's
//! tag parks until the next feed or a flush releases it into that channel),
//! same channel state across flush (flush releases held text but does NOT
//! flip the channel), same chunking invariance — the routing depends on the
//! CONTENT, never on where chunk boundaries fell.
//!
//! Fence-aware law (brief 2026-11-15 F17, identical in both engines): an
//! inline tag inside a fenced code block (``` or ~~~) is LITERAL text of
//! the current channel — a model demonstrating the tag inside code keeps
//! its example visible instead of having it routed to reasoning. Fence
//! recognition follows CommonMark within a documented subset:
//! - OPENER: a line whose first non-space content (≤3 spaces of indent) is
//!   a run of 3+ backticks or 3+ tildes; a backtick fence's info string
//!   must contain no backtick (CommonMark's own rule);
//! - CLOSER: a line (same ≤3-space indent) of ONLY the same fence char in a
//!   run at least as long as the opener, then spaces/tabs only.
//! Literal-code law (brief 2026-11-16 section 6, identical in both engines):
//! ONLY a delimiter the markdown says is REAL switches channels, so code
//! content is literal text of the CURRENT channel. Beyond fenced blocks:
//! - INLINE CODE SPAN: a run of N backticks opens a span ending at the next
//!   run of EXACTLY N backticks ON THE SAME LINE (CommonMark's matching rule);
//!   everything between - tag spellings included - is literal, and an opening
//!   run with no matching closer on that line is plain punctuation;
//! - INDENTED CODE CHUNK: a line whose (blockquote-stripped) body starts with
//!   a tab or 4+ spaces, only when the previous line was blank or this is the
//!   field start; it continues through blank lines and ends at the first line
//!   that is neither blank nor indented;
//! - BLOCKQUOTED FENCE: a fence opener/closer may sit behind "> " markers; the
//!   markers are stripped for CLASSIFICATION only, never for output, so every
//!   emitted byte stays exactly as it arrived. A fence opened inside a
//!   blockquote also closes on a quoted or a lazy (unprefixed) closer line; a
//!   fence not opened in a blockquote never strips a ">".
//! Live delimiters AFTER the code still route (fixing the loss must not
//! swallow real tags), and flush() classifies a parked tail instead of dumping
//! it: the law is literal CODE, never literal silence about real delimiters.
//! Chunking invariance is preserved by parking any fence-candidate line
//! WHOLE until its newline (or the stream end) is known: the decision reads
//! only complete lines, so piece boundaries never change routing. Fences
//! apply inside reasoning blocks too — a `</think>` inside a fence does not
//! close the block. Fence delimiter lines are emitted verbatim into the
//! current channel (nothing is ever deleted, per §2).
//!
//! UTF-8 is never split here: `feed` takes complete decoded `&str` values
//! from parsed JSON fields, and every scan window ends at a newline or the
//! piece end, so every slice boundary is a char boundary (fence chars and
//! tag delimiters are ASCII; a byte equal to an ASCII delimiter cannot be a
//! UTF-8 continuation byte).
//! `fixtures/sse/02` + `sse/03` (re-recorded 2026-11-13; fence vectors added
//! 2026-11-15) carry the recorded cross-engine chunk vectors consumed by
//! `tests/scrubber_vectors.rs`; the mirrored unit tests below mirror
//! `__tests__/think-splitter.test.ts`.

/// Hidden-reasoning opener (7 bytes, ASCII).
const OPEN: &str = "<think>";
/// Hidden-reasoning closer (8 bytes, ASCII).
const CLOSE: &str = "</think>";

/// One feed/flush step's output: text for the answer channel and text routed
/// to the reasoning channel. Either may be empty.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SplitOut {
    pub content: String,
    pub reasoning: String,
}

/// Streaming field splitter: `feed` per content-field piece, `flush` once at
/// round/stream end.
#[derive(Debug)]
pub struct ThinkFieldSplitter {
    /// Inside a `<think>` block (open seen, close not yet seen).
    in_think: bool,
    /// Inside a fenced code block: (fence char, opening run length).
    fence: Option<(u8, usize)>,
    /// The fence opener was a blockquote-prefixed line, so a blockquote-prefixed
    /// closer line or a lazy (unprefixed) closer line may close it.
    fence_quoted: bool,
    /// Inside a 4-space / tab indented code chunk (markdown classification only
    /// - bytes are always emitted unchanged). Mirrors the TS `codeIndent`.
    code_indent: bool,
    /// Was the line just consumed blank? An indented code chunk may only start
    /// after a blank line or at the start of the field (CommonMark subset).
    last_line_blank: bool,
    /// The byte just after the last consumed piece is a line start.
    at_line_start: bool,
    /// Unprocessed tail: an incomplete fence-candidate line and/or (once
    /// the line is known not to be fence-relevant) a partial-delimiter
    /// suffix of the current channel's tag.
    held: String,
}

impl Default for ThinkFieldSplitter {
    fn default() -> Self {
        Self {
            in_think: false,
            fence: None,
            fence_quoted: false,
            code_indent: false,
            last_line_blank: true,
            at_line_start: true,
            held: String::new(),
        }
    }
}

impl ThinkFieldSplitter {
    /// Absorbs one decoded content-field piece; returns what this step
    /// produced. Mirrors `createThinkSplitter`'s scan loop exactly.
    pub fn feed(&mut self, chunk: &str) -> SplitOut {
        let text = std::mem::take(&mut self.held) + chunk;
        let mut out = SplitOut::default();
        // Byte cursor into `text`; it only ever sits on char boundaries
        // because every advance is past an ASCII delimiter and every window
        // ends at a newline (or the piece end).
        let mut i = 0usize;
        while i < text.len() {
            let nl = text[i..].find('\n').map(|p| i + p);
            let terminated = nl.is_some();
            let body_end = nl.unwrap_or(text.len());

            if self.at_line_start {
                let line = &text[i..body_end];
                // Markdown classification ONLY (fence / indented code). Never
                // used to rewrite bytes: every emit below takes the ORIGINAL
                // text. Blockquote markers are ASCII, so byte slicing into the
                // stripped body stays char-boundary safe.
                let body = strip_blockquote(line);
                if terminated {
                    let nl_at = nl.unwrap();
                    if let Some((fc, fl)) = self.fence {
                        // Inside a fence the ONLY decision is whether this
                        // line closes it; tags are literal and the line rides
                        // the current channel verbatim. A fence opened inside a
                        // blockquote also closes on a quoted or lazy closer.
                        emit(&mut out, self.in_think, &text[i..nl_at + 1]);
                        let quoted = self.fence_quoted && is_close_line(&body, fc, fl);
                        if is_close_line(line, fc, fl) || quoted {
                            self.fence = None;
                            self.fence_quoted = false;
                        }
                    } else if self.code_indent
                        && (is_blank_line(&body) || is_indented_code_line(&body))
                    {
                        // Blank or still-indented line: continuation of the
                        // indented code chunk, so its tags are literal.
                        emit(&mut out, self.in_think, &text[i..nl_at + 1]);
                    } else if self.code_indent {
                        // The chunk ended at this non-indented, non-blank line;
                        // an indented chunk cannot start here, so classify as
                        // an ordinary/fence line.
                        self.code_indent = false;
                        match parse_open_line(&body) {
                            Some((c, len)) => {
                                self.fence = Some((c, len));
                                self.fence_quoted = body != line;
                                emit(&mut out, self.in_think, &text[i..nl_at + 1]);
                            }
                            None => {
                                self.scan_line(&text, &mut out, i, body_end);
                                emit(&mut out, self.in_think, "\n");
                            }
                        }
                    } else if is_indented_code_line(&body) && self.last_line_blank {
                        self.code_indent = true;
                        emit(&mut out, self.in_think, &text[i..nl_at + 1]);
                    } else {
                        match parse_open_line(&body) {
                            Some((c, len)) => {
                                self.fence = Some((c, len));
                                self.fence_quoted = body != line;
                                emit(&mut out, self.in_think, &text[i..nl_at + 1]);
                            }
                            None => {
                                self.scan_line(&text, &mut out, i, body_end);
                                // The newline belongs to whatever channel the
                                // last switch inside the line left.
                                emit(&mut out, self.in_think, "\n");
                            }
                        }
                    }
                    self.last_line_blank = is_blank_line(&body);
                    i = nl_at + 1; // the next line starts at a line start
                    continue;
                }
                // Unterminated line: a fence-candidate line parks WHOLE —
                // its open/close intent is undecidable until the newline
                // (or stream end) is known. Other lines process mid-line.
                if could_be_fence_line(line, self.fence) {
                    self.held.push_str(&text[i..]);
                    break;
                }
                self.at_line_start = false;
            }

            // Mid-line (the line is already known not to open or close a
            // fence — transitions are only possible at a line start).
            if self.fence.is_some() {
                let stop = if terminated { nl.unwrap() + 1 } else { text.len() };
                emit(&mut out, self.in_think, &text[i..stop]);
                i = stop;
                self.at_line_start = terminated;
                continue;
            }
            if terminated {
                self.scan_line(&text, &mut out, i, body_end);
                emit(&mut out, self.in_think, "\n");
                i = nl.unwrap() + 1;
                self.at_line_start = true;
                continue;
            }
            self.scan_to_buffer_end(&text, &mut out, i);
            break; // consumed everything consumable (held tail may be set)
        }
        out
    }

    /// Releases any still-held tail into the CURRENT channel (a partial tag
    /// that never completed, an unfinished fence line, an unterminated
    /// block or an unclosed fence: all LITERAL — never dropped). Channel
    /// state is kept, exactly like the TS `flush()`. Repeated calls are safe.
    pub fn flush(&mut self) -> SplitOut {
        let mut out = SplitOut::default();
        // Everything still held is COMPLETE text at this point: an unterminated
        // block, an unclosed fence, an unmatched code span or an unfinished
        // fence/indented-code line all release as LITERAL text of the current
        // channel - never deleted. A tail that is ordinary prose still gets its
        // real delimiters routed (the law is literal CODE, not literal silence).
        self.finish_held(&mut out);
        out
    }

    /// End-of-stream law (mirrors the TS `finishHeld`): once the stream ended,
    /// no further byte can change a line, so a parked tail's line-start
    /// classification IS decidable - flush classifies and routes it like any
    /// other complete line instead of dumping it as literal text. Only a tail
    /// parked inside a fenced block, an indented code chunk or a real fence
    /// opener line stays literal. A tail parked inside an already-classified
    /// line is a partial delimiter or an unmatched code run: neither can
    /// complete any more, so it is scanned as a final line body.
    fn finish_held(&mut self, out: &mut SplitOut) {
        let text = std::mem::take(&mut self.held);
        if text.is_empty() {
            return; // never contains a newline: parks take one line suffix
        }
        if self.fence.is_some() {
            emit(out, self.in_think, &text); // inside a fence: tags are literal
            return;
        }
        if !self.at_line_start {
            let len = text.len();
            self.scan_line(&text, out, 0, len);
            return;
        }
        let body = strip_blockquote(&text);
        if self.code_indent && (is_blank_line(&body) || is_indented_code_line(&body)) {
            emit(out, self.in_think, &text);
            return;
        }
        self.code_indent = false;
        if is_indented_code_line(&body) && self.last_line_blank {
            self.code_indent = true;
            emit(out, self.in_think, &text);
            return;
        }
        match parse_open_line(&body) {
            Some((c, len)) => {
                self.fence = Some((c, len));
                self.fence_quoted = body != text;
                emit(out, self.in_think, &text);
            }
            None => {
                let len = text.len();
                self.scan_line(&text, out, 0, len);
                self.last_line_blank = is_blank_line(&body);
            }
        }
    }

    /// Scan the COMPLETE line body [i, body_end) for the current channel's
    /// tag, flipping the channel at every hit. A tag can never straddle a
    /// newline, so every hit lies wholly inside the window and NOTHING
    /// needs holding back. ⇔ the TS `scanLine`.
    fn scan_line(&mut self, text: &str, out: &mut SplitOut, mut i: usize, body_end: usize) {
        while i < body_end {
            let tag: &str = if self.in_think { CLOSE } else { OPEN };
            let at = text[i..body_end].find(tag).map(|p| i + p);
            let run = text[i..body_end].find('`').map(|p| i + p);
            let tag_first = match (at, run) {
                (Some(a), Some(r)) => a < r,
                (Some(_), None) => true,
                (None, _) => false,
            };
            if tag_first {
                let a = at.unwrap();
                emit(out, self.in_think, &text[i..a]);
                self.in_think = !self.in_think;
                i = a + tag.len();
                continue;
            }
            let run = match run {
                Some(r) => r,
                None => {
                    emit(out, self.in_think, &text[i..body_end]);
                    return;
                }
            };
            // A backtick run precedes any tag hit in this window: consume the
            // WHOLE code span (delimiters included, verbatim) so a tag spelled
            // inside the span never switches channel.
            emit(out, self.in_think, &text[i..run]);
            let len = run_len(text, run, body_end);
            match find_span_close(text, run + len, body_end, len) {
                Some(c) => {
                    emit(out, self.in_think, &text[run..c + len]);
                    i = c + len;
                }
                None => {
                    // No closer on this line: the run is literal punctuation.
                    emit(out, self.in_think, &text[run..run + len]);
                    i = run + len;
                }
            }
        }
    }

    /// Process the rest of an UNTERMINATED line (runs to the piece end):
    /// the old holdback scan — park only a partial-delimiter suffix of the
    /// current channel's tag at the very end of the buffer. ⇔ TS
    /// `scanToBufferEnd`.
    fn scan_to_buffer_end(&mut self, text: &str, out: &mut SplitOut, mut i: usize) {
        let limit = text.len();
        while i < limit {
            let tag: &str = if self.in_think { CLOSE } else { OPEN };
            let at = text[i..].find(tag).map(|p| i + p);
            let run = text[i..].find('`').map(|p| i + p);
            let tag_first = match (at, run) {
                (Some(a), Some(r)) => a < r,
                (Some(_), None) => true,
                (None, _) => false,
            };
            if tag_first {
                let a = at.unwrap();
                emit(out, self.in_think, &text[i..a]);
                self.in_think = !self.in_think;
                i = a + tag.len();
                continue;
            }
            let run = match run {
                Some(r) => r,
                None => {
                    // The holdback rule: park only a partial-delimiter suffix
                    // of the current channel's tag at the very end.
                    let end = match at {
                        Some(a) => a,
                        None => hold_end(text, i, tag),
                    };
                    emit(out, self.in_think, &text[i..end]);
                    self.held.push_str(&text[end..]);
                    return;
                }
            };
            emit(out, self.in_think, &text[i..run]);
            let len = run_len(text, run, limit);
            let close = find_span_close(text, run + len, limit, len);
            if close.is_none() || run + len >= limit || close.unwrap() + len >= limit {
                // The span decision needs bytes that have not arrived (the
                // closer, or the opening run's own length) - park from the run.
                self.held.push_str(&text[run..]);
                return;
            }
            let c = close.unwrap();
            emit(out, self.in_think, &text[run..c + len]);
            i = c + len;
        }
    }
}

/// Route a piece into the channel selected by `in_think`.
fn emit(out: &mut SplitOut, in_think: bool, piece: &str) {
    if piece.is_empty() {
        return;
    }
    if in_think {
        out.reasoning.push_str(piece);
    } else {
        out.content.push_str(piece);
    }
}

/// Could this (possibly incomplete) line still open or close a fence?
/// Leading spaces always qualify (the ≤3-space rule is only decidable once
/// the first non-space char arrives); outside a fence only `` ` `` / `~`
/// starts qualify; inside a fence only the active fence char can. ⇔ TS
/// `couldBeFenceLine`.
fn could_be_fence_line(line: &str, fence: Option<(u8, usize)>) -> bool {
    match line.as_bytes().first() {
        None => false,
        // Leading space/tab always qualify (the indent width is only decidable
        // once the first non-space char arrives, and an indented code chunk
        // needs the same whole-line decision). ">" qualifies because a fence
        // may be blockquote-prefixed - inside a fence too, since a quoted
        // closer line is only recognizable once the line is complete.
        Some(b' ') | Some(b'\t') | Some(b'>') => true,
        Some(b) => match fence {
            Some((c, _)) => *b == c,
            None => *b == b'`' || *b == b'~',
        },
    }
}

/// Recognize a fence OPENER line (CommonMark subset, see module docs). ⇔ TS
/// `parseOpenLine`. Returns (fence char, run length).
fn parse_open_line(line: &str) -> Option<(u8, usize)> {
    let body = line.strip_suffix('\r').unwrap_or(line);
    let b = body.as_bytes();
    let mut p = 0usize;
    while p < b.len() && p < 4 && b[p] == b' ' {
        p += 1;
    }
    if p >= b.len() || p == 4 {
        return None; // blank line or 4+ space indent
    }
    let c = b[p];
    if c != b'`' && c != b'~' {
        return None;
    }
    let mut q = p;
    while q < b.len() && b[q] == c {
        q += 1;
    }
    let len = q - p;
    if len < 3 {
        return None;
    }
    if c == b'`' && b[q..].contains(&b'`') {
        return None; // info string must not contain a backtick
    }
    Some((c, len))
}

/// Recognize a CLOSER line for the active fence (see module docs). ⇔ TS
/// `isCloseLine`.
fn is_close_line(line: &str, fence_char: u8, fence_len: usize) -> bool {
    let body = line.strip_suffix('\r').unwrap_or(line);
    let b = body.as_bytes();
    let mut p = 0usize;
    while p < b.len() && p < 4 && b[p] == b' ' {
        p += 1;
    }
    if p >= b.len() || p == 4 {
        return false;
    }
    if b[p] != fence_char {
        return false;
    }
    let mut q = p;
    while q < b.len() && b[q] == fence_char {
        q += 1;
    }
    if q - p < fence_len {
        return false;
    }
    b[q..].iter().all(|&x| x == b' ' || x == b'\t')
}

/// Strip blockquote markers for CLASSIFICATION ONLY (never for output):
/// repeated [up to 3 spaces] ">" [one optional space or tab]. The markers are
/// ASCII, so the returned String is a suffix of `line` (byte lengths stay
/// comparable with `!= line`, which is how the fence law learns whether the
/// opener was quoted).
fn strip_blockquote(line: &str) -> String {
    let b = line.as_bytes();
    let mut p = 0usize;
    loop {
        let mut q = p;
        while q < p + 3 && q < b.len() && b[q] == b' ' {
            q += 1;
        }
        if q >= b.len() || b[q] != b'>' {
            return line[p..].to_string();
        }
        q += 1;
        if q < b.len() && (b[q] == b' ' || b[q] == b'\t') {
            q += 1;
        }
        p = q;
    }
}

/// A line of nothing but spaces/tabs (a CR from CRLF counts as blank).
fn is_blank_line(line: &str) -> bool {
    line.bytes().all(|c| c == b' ' || c == b'\t' || c == b'\r')
}

/// Tab-indented, or indented by 4+ spaces (measured on the stripped body).
fn is_indented_code_line(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    line.as_bytes()[0] == b'\t' || line.starts_with("    ")
}

/// Index of the next backtick in [from, limit), or None. Char-boundary safe:
/// backtick is ASCII, so its byte index is a char boundary.
fn next_backtick(text: &str, from: usize, limit: usize) -> Option<usize> {
    text[from..limit].find('`').map(|p| from + p)
}

/// Length of the backtick run starting at `start`, capped at `limit`.
fn run_len(text: &str, start: usize, limit: usize) -> usize {
    let mut q = start;
    while q < limit && text.as_bytes()[q] == b'`' {
        q += 1;
    }
    q - start
}

/// Start index of the FIRST backtick run of EXACTLY `len` backticks in
/// [from, limit) - CommonMark's code-span closer rule (a run of a different
/// length is span content, not a closer). None when the window has no closer.
fn find_span_close(text: &str, from: usize, limit: usize, len: usize) -> Option<usize> {
    let mut p = from;
    while p < limit {
        let q = next_backtick(text, p, limit)?;
        let r = run_len(text, q, limit);
        if r == len {
            return Some(q);
        }
        p = q + r;
    }
    None
}

/// End index of the longest suffix of `text` (at or after `from`) that is a
/// PROPER prefix of `tag` — the only tail that could still complete into a
/// delimiter. Returns `text.len()` when nothing needs holding back.
/// Byte slices are char-boundary-safe: any matched tail bytes equal an ASCII
/// tag prefix, so they are ASCII and cannot split a multi-byte code point.
fn hold_end(text: &str, from: usize, tag: &str) -> usize {
    let max = (tag.len() - 1).min(text.len() - from);
    for k in (1..=max).rev() {
        if text.as_bytes()[text.len() - k..] == tag.as_bytes()[..k] {
            return text.len() - k;
        }
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(chunks: &[&str]) -> SplitOut {
        let mut s = ThinkFieldSplitter::default();
        let mut acc = SplitOut::default();
        for c in chunks {
            let o = s.feed(c);
            acc.content.push_str(&o.content);
            acc.reasoning.push_str(&o.reasoning);
        }
        let f = s.flush();
        acc.content.push_str(&f.content);
        acc.reasoning.push_str(&f.reasoning);
        acc
    }

    // Every case below mirrors its twin in __tests__/think-splitter.test.ts
    // (cross-engine chunking-invariance law, 2026-11-13 §6).

    #[test]
    fn four_piece_delimiter_split_leaks_nothing() {
        let mut s = ThinkFieldSplitter::default();
        let outs: Vec<SplitOut> = ["<thi", "nk>SECRET", "</th", "ink>FINAL"]
            .iter()
            .map(|c| s.feed(c))
            .collect::<Vec<_>>();
        let content: String = outs.iter().map(|o| o.content.as_str()).collect();
        let reasoning: String = outs.iter().map(|o| o.reasoning.as_str()).collect();
        assert_eq!(content, "FINAL");
        assert_eq!(reasoning, "SECRET");
        for o in &outs {
            assert!(!o.content.contains("<think") && !o.content.contains("</think"));
            assert!(!o.reasoning.contains("<think") && !o.reasoning.contains("</think"));
        }
    }

    #[test]
    fn partial_open_tag_is_held_not_emitted() {
        let mut s = ThinkFieldSplitter::default();
        assert_eq!(
            s.feed("abc<"),
            SplitOut {
                content: "abc".into(),
                reasoning: String::new()
            }
        );
        assert_eq!(
            s.feed("think>xyz"),
            SplitOut {
                content: String::new(),
                reasoning: "xyz".into()
            }
        );
        assert_eq!(
            s.feed("</think>tail"),
            SplitOut {
                content: "tail".into(),
                reasoning: String::new()
            }
        );
    }

    #[test]
    fn partial_close_tag_is_held_not_emitted() {
        let mut s = ThinkFieldSplitter::default();
        s.feed("x<think>y");
        assert_eq!(s.feed("</thin"), SplitOut::default());
        assert_eq!(s.feed("k>z").content, "z");
    }

    #[test]
    fn single_delta_routes_four_sections() {
        assert_eq!(
            feed_all(&["a<think>b</think>c<think>d</think>e"]),
            SplitOut {
                content: "ace".into(),
                reasoning: "bd".into()
            }
        );
    }

    #[test]
    fn flush_releases_held_partial_open_as_literal_content() {
        let mut s = ThinkFieldSplitter::default();
        assert_eq!(
            s.feed("x<thi"),
            SplitOut {
                content: "x".into(),
                reasoning: String::new()
            }
        );
        assert_eq!(
            s.flush(),
            SplitOut {
                content: "<thi".into(),
                reasoning: String::new()
            }
        );
        assert_eq!(s.flush(), SplitOut::default()); // terminal-safe
    }

    #[test]
    fn flush_inside_a_block_releases_nothing_extra() {
        let mut s = ThinkFieldSplitter::default();
        assert_eq!(
            s.feed("<think>still thinking"),
            SplitOut {
                content: String::new(),
                reasoning: "still thinking".into()
            }
        );
        assert_eq!(s.flush(), SplitOut::default());
    }

    #[test]
    fn flush_releases_held_partial_close_as_reasoning() {
        let mut s = ThinkFieldSplitter::default();
        s.feed("<think>abc");
        assert_eq!(s.feed("</th"), SplitOut::default());
        assert_eq!(
            s.flush(),
            SplitOut {
                content: String::new(),
                reasoning: "</th".into()
            }
        );
    }

    #[test]
    fn real_delimiter_wins_over_held_text() {
        let mut s = ThinkFieldSplitter::default();
        assert_eq!(s.feed("<"), SplitOut::default());
        assert_eq!(s.feed("think>in").reasoning, "in");
    }

    #[test]
    fn every_char_cut_routes_identically() {
        let text = "pre<thin".to_string() + "k>mid</thi" + "nk>post<think>x</think>end";
        let whole = feed_all(&[text.as_str()]);
        assert_eq!(whole.content, "prepostend");
        assert_eq!(whole.reasoning, "midx");
        for (cut, _) in text.char_indices().skip(1) {
            assert_eq!(feed_all(&[&text[..cut], &text[cut..]]), whole, "cut={cut}");
        }
    }

    #[test]
    fn unterminated_opener_routes_to_reasoning_never_deletes() {
        // 2026-11-13 brief §2: the retired byte scrubber DROPPED everything
        // from an unterminated `<think>` onward (and swallowed the stream
        // envelope with it). The splitter opens the reasoning channel — the
        // tail SURVIVES as visible reasoning text.
        let out = feed_all(&["B<think>oops"]);
        assert_eq!(out.content, "B");
        assert_eq!(out.reasoning, "oops");
    }

    #[test]
    fn multibyte_text_survives_char_at_a_time_feeding() {
        let text = "héllo 🎉 తెలుగు <think>ne</think>end";
        let whole = feed_all(&[text]);
        assert_eq!(whole.content, "héllo 🎉 తెలుగు end");
        assert_eq!(whole.reasoning, "ne");
        let chars: Vec<String> = text.chars().map(|c| c.to_string()).collect();
        let refs: Vec<&str> = chars.iter().map(String::as_str).collect();
        assert_eq!(feed_all(&refs), whole, "char-at-a-time feeding == atomic");
    }

    // ---- F17 fence-awareness (2026-11-15; mirrors TS fence describe) ----

    const FENCED: &str = "pre\n```html\n<think>literal</think>\n```\npost";

    #[test]
    fn fence_literal_tag_stays_content_never_reasoning() {
        // F17 core case: a model DEMONSTRATING the tag inside a code fence
        // keeps its example verbatim in the answer channel.
        let out = feed_all(&[FENCED]);
        assert_eq!(out.content, FENCED);
        assert_eq!(out.reasoning, "");
    }

    #[test]
    fn every_char_cut_of_a_fenced_text_routes_identically() {
        let whole = feed_all(&[FENCED]);
        for (cut, _) in FENCED.char_indices().skip(1) {
            assert_eq!(feed_all(&[&FENCED[..cut], &FENCED[cut..]]), whole, "cut={cut}");
        }
        let chars: Vec<String> = FENCED.chars().map(|c| c.to_string()).collect();
        let refs: Vec<&str> = chars.iter().map(String::as_str).collect();
        assert_eq!(feed_all(&refs), whole, "char-at-a-time == atomic");
    }

    #[test]
    fn tilde_fence_with_info_holds_tags_literal() {
        let text = "~~~js [S9]\nx <think>y\n~~~\nz";
        let out = feed_all(&[text]);
        assert_eq!(out.content, text);
        assert_eq!(out.reasoning, "");
    }

    #[test]
    fn fence_inside_a_reasoning_block_protects_close_tag() {
        let text = "<think>\n```\n</think> is literal\n```\n</think>tail";
        let out = feed_all(&[text]);
        // The OPEN delimiter itself is consumed (routed markers are never
        // emitted); fenced text — including the `</think>` spelling — stays
        // verbatim reasoning until the fence closes, then the real close tag.
        assert_eq!(out.reasoning, "\n```\n</think> is literal\n```\n");
        assert_eq!(out.content, "tail");
    }

    #[test]
    fn shorter_close_run_does_not_close_the_fence() {
        let text = "```\n<think>t\n``\nu";
        let out = feed_all(&[text]);
        assert_eq!(out.content, text);
        assert_eq!(out.reasoning, "");
    }

    #[test]
    fn longer_close_run_closes_the_fence() {
        let text = "````\nx\n`````\n<think>t</think>y";
        let out = feed_all(&[text]);
        assert_eq!(out.content, "````\nx\n`````\ny");
        assert_eq!(out.reasoning, "t");
    }

    #[test]
    fn backtick_fence_info_with_backtick_is_not_a_fence() {
        // CommonMark law both engines implement: an info string containing
        // a backtick disqualifies the backtick fence → plain text line.
        let out = feed_all(&["```a`b\n<think>t\n```"]);
        assert_eq!(out.content, "```a`b\n");
        assert_eq!(out.reasoning, "t\n```");
    }

    #[test]
    fn indented_fence_up_to_three_spaces_opens_and_closes() {
        let text = "   ```\n<think>t</think>\n   ```\npost";
        let out = feed_all(&[text]);
        assert_eq!(out.content, text);
        assert_eq!(out.reasoning, "");
    }

    #[test]
    fn four_space_indent_is_never_a_fence() {
        let out = feed_all(&["    ```\n<think>t</think>\n    ```\nx"]);
        assert_eq!(out.content, "    ```\n\n    ```\nx");
        assert_eq!(out.reasoning, "t");
    }

    #[test]
    fn tags_never_swallowed_inside_unclosed_fence_flush_keeps_all() {
        let out = feed_all(&["```x\n<thi"]);
        assert_eq!(out.content, "```x\n<thi");
        assert_eq!(out.reasoning, "");
    }

    #[test]
    fn incomplete_fence_opener_flushes_as_literal() {
        let mut s = ThinkFieldSplitter::default();
        assert_eq!(s.feed("a\n``").content, "a\n");
        assert_eq!(
            s.flush(),
            SplitOut {
                content: "``".into(),
                reasoning: String::new()
            }
        );
    }

    #[test]
    fn trailing_spaces_after_close_run_still_close() {
        let text = "```\nx\n``` \t\n<think>t</think>y";
        let out = feed_all(&[text]);
        assert_eq!(out.content, "```\nx\n``` \t\ny");
        assert_eq!(out.reasoning, "t");
    }

    #[test]
    fn blank_line_does_not_close_a_fence() {
        let text = "```\nx\n\n<think>t</think>\n```\ny";
        let out = feed_all(&[text]);
        assert_eq!(out.content, text);
        assert_eq!(out.reasoning, "");
    }

    // ---- F05 literal code (brief 2026-11-16 section 6; mirrors the TS
    // "F05 literal code" describe - spans, indented blocks, blockquote fences)

    #[test]
    fn inline_code_span_keeps_tag_spelling_in_the_answer() {
        let text = "Say `<think>x</think>` now";
        let out = feed_all(&[text]);
        assert_eq!(out.content, text);
        assert_eq!(out.reasoning, "");
    }

    #[test]
    fn code_span_on_one_line_never_disables_live_tags_on_the_next() {
        let text = "Say `<think>` now\n<think>real</think>after\n";
        let out = feed_all(&[text]);
        assert_eq!(out.content, "Say `<think>` now\nafter\n");
        assert_eq!(out.reasoning, "real");
    }

    #[test]
    fn longer_backtick_run_delimits_the_span_tags_inside_stay_literal() {
        let text = "`` <think>a</think> `` b";
        let out = feed_all(&[text]);
        assert_eq!(out.content, text);
        assert_eq!(out.reasoning, "");
    }

    #[test]
    fn live_tag_after_a_closed_span_on_the_same_line_still_switches() {
        let out = feed_all(&["code `<think>` end <think>hid</think>out"]);
        assert_eq!(out.content, "code `<think>` end out");
        assert_eq!(out.reasoning, "hid");
    }

    #[test]
    fn unmatched_backtick_on_a_finished_line_is_literal_punctuation() {
        let out = feed_all(&["a ` b\nc <think>r</think>d"]);
        assert_eq!(out.content, "a ` b\nc d");
        assert_eq!(out.reasoning, "r");
    }

    #[test]
    fn indented_code_block_keeps_tags_literal_and_ends_where_markdown_ends_it() {
        let text = "intro\n\n    code <think>lit1</think>\n    more <think>lit2</think>\nafter <think>real</think>end";
        let out = feed_all(&[text]);
        assert_eq!(
            out.content,
            "intro\n\n    code <think>lit1</think>\n    more <think>lit2</think>\nafter end"
        );
        assert_eq!(out.reasoning, "real");
    }

    #[test]
    fn tab_indented_code_block_keeps_tags_literal() {
        let text = "\ttabbed <think>lit</think>\nreal <think>r</think>z";
        let out = feed_all(&[text]);
        assert_eq!(out.content, "\ttabbed <think>lit</think>\nreal z");
        assert_eq!(out.reasoning, "r");
    }

    #[test]
    fn blockquoted_fence_opens_protects_contents_and_closes() {
        let text = "para\n\n> ```py\n> <think>lit</think>\n> ```\n\nafter <think>real</think>end";
        let out = feed_all(&[text]);
        // The fence keeps its quoted contents verbatim; the live tag AFTER the
        // fence closes still routes (fixing the loss must not swallow it).
        assert_eq!(out.content, "para\n\n> ```py\n> <think>lit</think>\n> ```\n\nafter end");
        assert_eq!(out.reasoning, "real");
    }

    #[test]
    fn lazy_unprefixed_closer_still_closes_a_blockquoted_fence() {
        let text = "> ```py\n> <think>lit</think>\n```\nafter <think>real</think>end";
        let out = feed_all(&[text]);
        // A lazy (unprefixed) closer line closes a fence opened behind "> ",
        // and the live tag after it still routes.
        assert_eq!(out.content, "> ```py\n> <think>lit</think>\n```\nafter end");
        assert_eq!(out.reasoning, "real");
    }

    #[test]
    fn blockquote_markers_never_disable_a_live_tag_in_quoted_prose() {
        let out = feed_all(&["> answer <think>hid</think>out"]);
        assert_eq!(out.content, "> answer out");
        assert_eq!(out.reasoning, "hid");
    }

    #[test]
    fn code_span_inside_a_reasoning_block_protects_the_close_spelling() {
        let out = feed_all(&["<think>see `<b/>` and `</think>` tail"]);
        assert_eq!(out.reasoning, "see `<b/>` and `</think>` tail");
        assert_eq!(out.content, "");
    }

    #[test]
    fn every_code_form_keeps_its_own_chunking_invariance() {
        let texts = [
            "Say `<think>x</think>` now",
            "Say `<think>` now\n<think>real</think>after\n",
            "`` <think>a</think> `` b",
            "code `<think>` end <think>hid</think>out",
            "a ` b\nc <think>r</think>d",
            "intro\n\n    code <think>lit1</think>\n    more <think>lit2</think>\nafter <think>real</think>end",
            "\ttabbed <think>lit</think>\nreal <think>r</think>z",
            "para\n\n> ```py\n> <think>lit</think>\n> ```\n\nafter <think>real</think>end",
            "> ```py\n> <think>lit</think>\n```\nafter <think>real</think>end",
            "> answer <think>hid</think>out",
            "<think>see `<b/>` and `</think>` tail",
        ];
        for text in texts {
            let whole = feed_all(&[text]);
            assert!(
                !(whole.content.is_empty() && whole.reasoning.is_empty()),
                "nothing may be lost: {text:?}"
            );
            assert_ne!(
                whole.content.clone() + &whole.reasoning,
                "",
                "nothing may be lost: {text:?}"
            );
            for (cut, _) in text.char_indices().skip(1) {
                assert_eq!(
                    feed_all(&[&text[..cut], &text[cut..]]),
                    whole,
                    "cut={cut} of {text:?}"
                );
            }
            let chars: Vec<String> = text.chars().map(|c| c.to_string()).collect();
            let refs: Vec<&str> = chars.iter().map(String::as_str).collect();
            assert_eq!(feed_all(&refs), whole, "char-by-char of {text:?}");
        }
    }
}
