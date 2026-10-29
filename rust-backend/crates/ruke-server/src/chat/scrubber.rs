//! Incremental `<think>…</think>` scrubber (Part 4 core deliverable).
//!
//! APPROVED DEVIATION (MIGRATION-MAP §10/§21): the TS oracle's
//! `scrubThinkTags` runs per *decoded network chunk*, so a tag split across
//! two chunks leaks into the client-visible stream (and the TS goldens
//! recorded that mangled byte sequence). The Rust implementation instead
//! reproduces the **atomic** semantics — what `scrubThinkTags` would return
//! if the whole stream were scrubbed in one pass — and must stay identical
//! under ANY network split point. Rust golden comparisons use the recorded
//! `expectedRust*` vectors in `fixtures/sse/02`/`03`, NOT the mangled TS
//! bytes. This is the deviation the Part-4 brief authorizes; the TS route
//! is left untouched (Rule 18).
//!
//! Semantics the state machine implements (single-pass over the fully
//! concatenated stream):
//! - text outside a `<think>` block passes through verbatim;
//! - a `<think>` opens a block; the block is dropped up to and including the
//!   first `</think>` (nested `<think>` inside a block is just block text —
//!   matching `indexOf`-based TS scanning, not a counter);
//! - an unterminated `<think>` swallows everything to end-of-stream
//!   (`break` in the TS loop — nothing after the opener is emitted);
//! - tag fragments at a chunk boundary NEVER leak: the scanner holds back
//!   the longest tail that is a proper prefix of a tag (nothing else can
//!   later become part of one, so literal bytes are never delayed).
//!
//! UTF-8 safety is inherent: the tags are pure ASCII, and no ASCII byte can
//! appear inside a multi-byte UTF-8 sequence (continuation bytes are all
//! ≥ 0x80), so a byte-level scan can never split a code point. `fixtures/
//! sse/03` pins exactly this property (the TS decoder-per-chunk path mangles
//! code points at 20 of the split points; the Rust output is byte-identical
//! to the upstream bytes at every split point).

/// Hidden-reasoning opener (7 bytes).
const OPEN: &[u8] = b"<think>";
/// Hidden-reasoning closer (8 bytes).
const CLOSE: &[u8] = b"</think>";

/// Streaming scrubber: `feed` per upstream chunk, `finish` once at EOF.
#[derive(Default)]
pub struct ThinkScrubber {
    /// Inside a `<think>` block (open seen, close not yet seen).
    in_block: bool,
    /// Bytes not yet scanned/emitted. Bounded: outside a block at most
    /// `OPEN.len()-1` bytes are retained (a possible partial opener);
    /// inside a block at most `CLOSE.len()-1` (a possible partial closer),
    /// because block content is consumed (dropped) as it is scanned.
    pending: Vec<u8>,
}

impl ThinkScrubber {
    /// Absorbs one upstream chunk; returns the scrubbed bytes safe to emit
    /// NOW (never a partial tag, never block content).
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut cursor = 0usize;

        // Single scan cursor over `pending`; matches the atomic single-pass
        // semantics regardless of where previous chunk boundaries fell.
        loop {
            if self.in_block {
                match find(&self.pending, CLOSE, cursor) {
                    Some(pos) => {
                        cursor = pos + CLOSE.len();
                        self.in_block = false;
                    }
                    None => break,
                }
            } else {
                match find(&self.pending, OPEN, cursor) {
                    Some(pos) => {
                        out.extend_from_slice(&self.pending[cursor..pos]);
                        cursor = pos + OPEN.len();
                        self.in_block = true;
                    }
                    None => break,
                }
            }
        }

        // Hold back ONLY bytes that could still grow into a tag: the longest
        // suffix of the unscanned tail that is a proper prefix of the tag we
        // might complete. A fixed `len(tag)-1` holdback would strand literal
        // bytes (e.g. the last chars of a final SSE frame) whenever the
        // upstream goes quiet before EOF — TS streams those through right
        // away, and the atomic output is identical either way. Block text
        // (in_block) is consumed rather than emitted — the retained prefix is
        // re-scanned next feed.
        let tag: &[u8] = if self.in_block { CLOSE } else { OPEN };
        let hold = proper_prefix_suffix(&self.pending[cursor..], tag);
        let split = self.pending.len() - hold;
        if !self.in_block {
            out.extend_from_slice(&self.pending[cursor..split]);
        }
        self.pending.drain(..split);
        out
    }

    /// End of upstream stream: an unterminated block emits nothing further
    /// (atomic `break` semantics); a complete stream flushes the retained
    /// tag fragment (it never grew into a tag, so it is literal text).
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.in_block {
            out.extend_from_slice(&self.pending);
        }
        self.pending.clear();
        self.in_block = false;
        out
    }
}

/// Longest `0 < h < needle.len()` such that `hay` ENDS with `needle[..h]`
/// (the only tail that could still complete into a tag once more bytes
/// arrive); 0 when no tail byte can join a future tag occurrence.
fn proper_prefix_suffix(hay: &[u8], needle: &[u8]) -> usize {
    let max = (needle.len() - 1).min(hay.len());
    for h in (1..=max).rev() {
        if hay[hay.len() - h..] == needle[..h] {
            return h;
        }
    }
    0
}

/// `slice::find` for a fixed ASCII needle at or after `from`.
fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| from + p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&[u8]]) -> Vec<u8> {
        let mut s = ThinkScrubber::default();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(s.feed(c));
        }
        out.extend(s.finish());
        out
    }

    #[test]
    fn plain_text_passes_through_untouched() {
        assert_eq!(run(&[b"hello ", b"world"]), b"hello world".to_vec());
    }

    #[test]
    fn think_block_dropped_across_arbitrary_splits() {
        let stream = b"a<think>hidden</think>b";
        let expected = b"ab".to_vec();
        assert_eq!(run(&[stream]), expected);
        for i in 1..stream.len() {
            assert_eq!(run(&[&stream[..i], &stream[i..]]), expected, "split at {i}");
        }
        // byte-at-a-time is the worst case for the hold-back logic
        let bytes: Vec<&[u8]> = stream.chunks(1).collect();
        assert_eq!(run(&bytes), expected);
    }

    #[test]
    fn unterminated_think_swallows_to_eof_like_atomic_scrub() {
        let stream = b"x<think>oops tail keeps going";
        assert_eq!(run(&[stream]), b"x".to_vec());
        for i in 1..stream.len() {
            assert_eq!(run(&[&stream[..i], &stream[i..]]), b"x".to_vec(), "split at {i}");
        }
    }

    #[test]
    fn tag_fragments_without_a_full_tag_are_literal_text() {
        // Atomic `indexOf(OPEN) == -1` keeps everything: the retained
        // fragment was never a full tag, so `finish` flushes it as literal
        // text. (Fragments that DO join into a real tag open a block — the
        // split-matrix tests above pin that.)
        assert_eq!(run(&[b"a<thi", b"n>"]), b"a<thin>".to_vec());
        assert_eq!(run(&[b"a</think>"]), b"a</think>".to_vec());
    }

    #[test]
    fn nested_openers_are_plain_block_text_index_style() {
        // TS scans with indexOf: the first </think> ends the block; the
        // second <think> inside was skipped as block content.
        assert_eq!(run(&[b"a<think>b<think>c</think>d"]), b"ad".to_vec());
    }

    #[test]
    fn utf8_bytes_never_split_even_byte_by_byte() {
        let stream = "data: héllo 🎉\n\n".as_bytes().to_vec();
        let expected = stream.clone();
        assert_eq!(run(&[&stream]), expected);
        let chunks: Vec<&[u8]> = stream.chunks(1).collect();
        assert_eq!(run(&chunks), expected);
    }
}
