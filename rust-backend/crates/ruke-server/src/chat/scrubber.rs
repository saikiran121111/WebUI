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
                if terminated {
                    let nl_at = nl.unwrap();
                    match self.fence {
                        Some((fc, fl)) => {
                            // Inside a fence the ONLY decision is whether
                            // this line closes it; tags are literal and the
                            // line rides the current channel verbatim.
                            emit(&mut out, self.in_think, &text[i..nl_at + 1]);
                            if is_close_line(line, fc, fl) {
                                self.fence = None;
                            }
                        }
                        None => match parse_open_line(line) {
                            Some((c, len)) => {
                                self.fence = Some((c, len));
                                emit(&mut out, self.in_think, &text[i..nl_at + 1]);
                            }
                            None => {
                                self.scan_line(&text, &mut out, i, body_end);
                                // The newline belongs to whatever channel
                                // the last switch inside the line left.
                                emit(&mut out, self.in_think, "\n");
                            }
                        },
                    }
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
        let held = std::mem::take(&mut self.held);
        if !held.is_empty() {
            if self.in_think {
                out.reasoning = held;
            } else {
                out.content = held;
            }
        }
        out
    }

    /// Scan the COMPLETE line body [i, body_end) for the current channel's
    /// tag, flipping the channel at every hit. A tag can never straddle a
    /// newline, so every hit lies wholly inside the window and NOTHING
    /// needs holding back. ⇔ the TS `scanLine`.
    fn scan_line(&mut self, text: &str, out: &mut SplitOut, mut i: usize, body_end: usize) {
        while i < body_end {
            let tag: &str = if self.in_think { CLOSE } else { OPEN };
            match text[i..body_end].find(tag) {
                Some(p) => {
                    let a = i + p;
                    emit(out, self.in_think, &text[i..a]);
                    self.in_think = !self.in_think;
                    i = a + tag.len();
                }
                None => {
                    emit(out, self.in_think, &text[i..body_end]);
                    i = body_end;
                }
            }
        }
    }

    /// Process the rest of an UNTERMINATED line (runs to the piece end):
    /// the old holdback scan — park only a partial-delimiter suffix of the
    /// current channel's tag at the very end of the buffer. ⇔ TS
    /// `scanToBufferEnd`.
    fn scan_to_buffer_end(&mut self, text: &str, out: &mut SplitOut, mut i: usize) {
        while i < text.len() {
            let tag: &str = if self.in_think { CLOSE } else { OPEN };
            let at = text[i..].find(tag).map(|p| i + p);
            let end = match at {
                Some(a) => a,
                None => hold_end(text, i, tag),
            };
            emit(out, self.in_think, &text[i..end]);
            match at {
                None => {
                    self.held.push_str(&text[end..]);
                    break;
                }
                Some(_) => {
                    self.in_think = !self.in_think;
                    i = end + tag.len();
                }
            }
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
        Some(b' ') => true,
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
}
