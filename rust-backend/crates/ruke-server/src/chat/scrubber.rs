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
//! UTF-8 is never split here: `feed` takes complete decoded `&str` values
//! from parsed JSON fields, and the holdback window is measured in bytes of
//! ASCII-only delimiters — a byte tail that equals an ASCII tag prefix cannot
//! be a UTF-8 continuation byte, so every slice boundary is a char boundary.
//! `fixtures/sse/02` + `sse/03` (re-recorded 2026-11-13) carry the recorded
//! cross-engine chunk vectors consumed by `tests/scrubber_vectors.rs`; the
//! mirrored unit tests below mirror `__tests__/think-splitter.test.ts`.

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
#[derive(Debug, Default)]
pub struct ThinkFieldSplitter {
    /// Inside a `<think>` block (open seen, close not yet seen).
    in_think: bool,
    /// Tail that could still grow into the current channel's delimiter.
    /// Bounded by `max(OPEN, CLOSE).len() - 1` bytes.
    held: String,
}

impl ThinkFieldSplitter {
    /// Absorbs one decoded content-field piece; returns what this step
    /// produced. Mirrors `createThinkSplitter`'s scan loop exactly.
    pub fn feed(&mut self, chunk: &str) -> SplitOut {
        let text = std::mem::take(&mut self.held) + chunk;
        let mut out = SplitOut::default();
        // Byte cursor into `text`; it only ever sits on char boundaries
        // because every advance is past an ASCII delimiter.
        let mut i = 0usize;
        while i < text.len() {
            let tag: &str = if self.in_think { CLOSE } else { OPEN };
            let at = text[i..].find(tag).map(|p| i + p);
            let end = match at {
                Some(a) => a,
                None => hold_end(&text, i, tag),
            };
            if end > i {
                let piece = &text[i..end];
                if self.in_think {
                    out.reasoning.push_str(piece);
                } else {
                    out.content.push_str(piece);
                }
            }
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
        out
    }

    /// Releases any still-held tail into the CURRENT channel (a partial tag
    /// that never completed is literal text; an unclosed block's held tail
    /// rides the reasoning channel — never dropped). Channel state is kept,
    /// exactly like the TS `flush()`. Repeated calls are safe.
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
        assert_eq!(s.feed("abc<"), SplitOut { content: "abc".into(), reasoning: String::new() });
        assert_eq!(s.feed("think>xyz"), SplitOut { content: String::new(), reasoning: "xyz".into() });
        assert_eq!(s.feed("</think>tail"), SplitOut { content: "tail".into(), reasoning: String::new() });
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
            SplitOut { content: "ace".into(), reasoning: "bd".into() }
        );
    }

    #[test]
    fn flush_releases_held_partial_open_as_literal_content() {
        let mut s = ThinkFieldSplitter::default();
        assert_eq!(s.feed("x<thi"), SplitOut { content: "x".into(), reasoning: String::new() });
        assert_eq!(s.flush(), SplitOut { content: "<thi".into(), reasoning: String::new() });
        assert_eq!(s.flush(), SplitOut::default()); // terminal-safe
    }

    #[test]
    fn flush_inside_a_block_releases_nothing_extra() {
        let mut s = ThinkFieldSplitter::default();
        assert_eq!(
            s.feed("<think>still thinking"),
            SplitOut { content: String::new(), reasoning: "still thinking".into() }
        );
        assert_eq!(s.flush(), SplitOut::default());
    }

    #[test]
    fn flush_releases_held_partial_close_as_reasoning() {
        let mut s = ThinkFieldSplitter::default();
        s.feed("<think>abc");
        assert_eq!(s.feed("</th"), SplitOut::default());
        assert_eq!(s.flush(), SplitOut { content: String::new(), reasoning: "</th".into() });
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
}
