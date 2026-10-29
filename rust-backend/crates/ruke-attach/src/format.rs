//! `lib/server/attachindex/format.ts` — timestamp rendering + the
//! sentence-clipping helpers. The sentence regexes (`^[^.!?]+[.!?]?` and
//! `/[^.!?]+[.!?]?/g`) are ported as hand scans (greedy run up to the
//! first of `.!?`, then ONE optional punctuation char, leftmost
//! non-overlapping) — identical semantics to the regex without pulling a
//! compile for it.

use ruke_skills::jsstr::{js_len, js_slice_head, js_slice_tail, js_trim, js_trim_end, js_trim_start};

/// `fmtStamp`: `[HH:MM:SS]` with `Math.max(0, Math.round(sec))` first.
/// JS `Math.round` rounds half toward +∞ where Rust rounds half away from
/// 0, but the `Math.max(0, ·)` clamps every negative result to 0 either
/// way, and the positive half-way cases agree — so porting as
/// `sec.round()` then clamp-to-0 is exact.
pub fn fmt_stamp(sec: f64) -> String {
    // Saturating cast bounds the pathological inputs (a >i64 timestamp
    // produces nonsense either way; no fixture approaches it).
    let s = (sec.round().clamp(0.0, i64::MAX as f64)) as i64;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let r = s % 60;
    format!("{h:02}:{m:02}:{r:02}")
}

/// Scan the leading `[^.!?]+[.!?]?` occurrence at position 0 of `trimmed`
/// (JS `/^[^.!?]+[.!?]?/`). Returns None when the text is empty or starts
/// with punctuation (the `+` needs one char).
fn leading_sentence(trimmed: &str) -> Option<&str> {
    let mut iter = trimmed.char_indices().peekable();
    let mut end = 0usize;
    while let Some(&(i, c)) = iter.peek() {
        if matches!(c, '.' | '!' | '?') {
            break;
        }
        end = i + c.len_utf8();
        iter.next();
    }
    if end == 0 {
        return None; // no `[.]`-class char matched — `+` failed at pos 0
    }
    // Optional single trailing punctuation.
    if let Some((_, pc)) = iter.next() {
        if matches!(pc, '.' | '!' | '?') {
            end += pc.len_utf8();
        }
    }
    Some(&trimmed[..end])
}

/// `firstSentence(text, max = 90)`.
pub fn first_sentence(text: &str, max: usize) -> String {
    let m = leading_sentence(js_trim(text)).map(str::to_string);
    // JS `(m?.[0] ?? text).trim()` — falls back to the ORIGINAL (untrimmed)
    // text, then trims (same result as the already-trimmed scan input).
    let m = m.unwrap_or_else(|| text.to_string());
    let s = js_trim(&m);
    if js_len(s) > max {
        format!("{}...", js_trim_end(&js_slice_head(s, max)))
    } else {
        s.to_string()
    }
}

/// All `[^.!?]+[.!?]?` occurrences, leftmost non-overlapping (`/…/g`).
fn sentence_parts(trimmed: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < trimmed.len() {
        let c = trimmed[i..].chars().next().unwrap();
        if matches!(c, '.' | '!' | '?') {
            // `+` fails here; the engine advances one position (JS regex
            // semantics). Continuation bytes never match anyway, but this
            // branch also skips punctuation chars only (1 byte).
            i += 1;
            continue;
        }
        // greedy run of non-punctuation chars
        let mut end = i;
        loop {
            match trimmed[end..].chars().next() {
                Some(nc) if !matches!(nc, '.' | '!' | '?') => end += nc.len_utf8(),
                _ => break,
            }
        }
        // optional single punctuation
        if let Some(nc) = trimmed[end..].chars().next() {
            if matches!(nc, '.' | '!' | '?') {
                end += nc.len_utf8();
            }
        }
        out.push(&trimmed[i..end]);
        i = end;
    }
    out
}

/// `lastSentence(text, max = 90)`.
pub fn last_sentence(text: &str, max: usize) -> String {
    let parts = sentence_parts(js_trim(text));
    let s_owned;
    let s: &str = match parts.last() {
        Some(p) => {
            s_owned = p.to_string();
            js_trim(&s_owned)
        }
        None => {
            s_owned = text.to_string();
            js_trim(&s_owned)
        }
    };
    if js_len(s) > max {
        format!("...{}", js_trim_start(js_slice_tail(s, max)))
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_stamp_table() {
        assert_eq!(fmt_stamp(0.0), "00:00:00");
        assert_eq!(fmt_stamp(5.0), "00:00:05");
        assert_eq!(fmt_stamp(6310.0), "01:45:10");
        assert_eq!(fmt_stamp(3599.4), "00:59:59");
        // JS round(4.5)=5 == Rust round(4.5)=5 (positive halfway agrees).
        assert_eq!(fmt_stamp(4.5), "00:00:05");
        // Negative rounds differ per-language, but max(0,·) clamps both to 0.
        assert_eq!(fmt_stamp(-0.5), "00:00:00");
        assert_eq!(fmt_stamp(-2.5), "00:00:00");
        // padStart only pads to 2; 100+ hours print fully.
        assert_eq!(fmt_stamp(360_000.0), "100:00:00");
    }

    #[test]
    fn first_sentence_table() {
        assert_eq!(first_sentence("Stomata regulate gas exchange. More text.", 90), "Stomata regulate gas exchange.");
        // No sentence terminator in the leading run ⇒ whole trimmed text.
        assert_eq!(first_sentence("  no terminator here ", 90), "no terminator here");
        // Leading punctuation: regex can't match ⇒ fallback to whole trimmed text.
        assert_eq!(first_sentence("!. odd start.", 90), "!. odd start.");
        // Clip: slice(0,12) = "aaaaaaaaaa b" (10 a's + space + "b"), no
        // trailing WS to trim ⇒ +"...".
        assert_eq!(first_sentence("aaaaaaaaaa bbbbbbbbbb c", 12), "aaaaaaaaaa b...");
        // UTF-16 length counts (astral = 2 units).
        assert_eq!(first_sentence("a\u{1D54F}bcd", 2), "a...");
    }

    #[test]
    fn last_sentence_table() {
        assert_eq!(last_sentence("One. Two sentence here!", 90), "Two sentence here!");
        // Multiple punctuation in a row: each punct advances separately.
        assert_eq!(last_sentence("a!!b", 90), "b");
        assert_eq!(last_sentence("no terminator ", 90), "no terminator");
        // Tail clip: slice(-12) of "aaaaaaaaaa bbbbbbbbbb" (21 units) is
        // "a bbbbbbbbbb" — the 10th "a" and the space ride along; the
        // slice does not start with WS ⇒ trimStart is a no-op.
        assert_eq!(last_sentence("aaaaaaaaaa bbbbbbbbbb", 12), "...a bbbbbbbbbb");
        // Astral: JS keeps the lone low surrogate on slice(-2); Rust snaps
        // up past the pair (documented jsstr deviation) ⇒ "y".
        assert_eq!(last_sentence("x\u{1D54F}y", 2), "...y");
    }

    #[test]
    fn sentence_parts_scan_matches_greedy_single_optional_punct() {
        assert_eq!(sentence_parts("a!!b"), ["a!", "b"]);
        // A lone trailing "!" can never START `[^.!?]+` ⇒ JS matchAll
        // produces no third part (the engine scans and fails at that pos).
        assert_eq!(sentence_parts("Hello. World?!"), ["Hello.", " World?"]);
        assert_eq!(sentence_parts(""), Vec::<&str>::new());
        assert_eq!(sentence_parts("plain"), ["plain"]);
    }
}
