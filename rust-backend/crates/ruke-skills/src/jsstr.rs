//! JS `String` semantics that Rust `str` does not share, and that the
//! skill engine's caps/trim/length arithmetic depends on:
//!
//! - **UTF-16 code-unit lengths.** JS `String.length`/`slice`/
//!   `lastIndexOf` count UTF-16 units, so the 9 000-unit core cap and the
//!   160 000-unit user cap are unit caps, not byte caps. `MAX_..._BYTES`
//!   constant names are kept verbatim from the TS for grep-ability.
//! - **JS `.trim()` whitespace set.** ECMAScript `WhiteSpace ∪
//!   LineTerminator` includes U+FEFF but excludes U+0085 — the exact
//!   opposite of Rust's `char::is_whitespace` behavior on those two.
//! - **Truthiness** for the `scenario.enabled` guard.
//!
//! Deviation (documented, §16 note in `js_slice_head`): a JS `slice` that
//! cuts between the halves of a surrogate pair yields a lone surrogate;
//! Rust `String` cannot hold one, so we snap to the last complete char
//! BELOW the cut. No replay target's bundle contains astral chars below
//! its cap, so no golden fixture exercises this.

use serde_json::Value;

/// ECMAScript `WhiteSpace ∪ LineTerminator` — the code units JS
/// `String.prototype.trim()` removes.
pub fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// JS `String.prototype.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// JS `String.prototype.length` — UTF-16 code units.
pub fn js_len(s: &str) -> usize {
    s.chars()
        .map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 })
        .sum()
}

/// JS `s.slice(0, units)`, but a cut landing inside a surrogate pair snaps
/// to the last complete char BELOW the cut instead of yielding a lone
/// surrogate (unrepresentable in Rust `String`). Corpus-inert deviation —
/// see module docs.
pub fn js_slice_head(s: &str, units: usize) -> String {
    let mut out = String::with_capacity(s.len().min(units));
    let mut acc = 0usize;
    for c in s.chars() {
        let ul = if (c as u32) > 0xFFFF { 2 } else { 1 };
        if acc + ul > units {
            break;
        }
        out.push(c);
        acc += ul;
    }
    out
}

/// JS `s.lastIndexOf("\n", cap)` — the last `\n` starting at or before
/// UTF-16 unit `cap`. Returns both the UTF-16 index (for the JS numeric
/// comparison `cut > 4500`) and the byte index (for slicing).
pub fn last_newline_at_or_below(s: &str, cap: usize) -> Option<(usize, usize)> {
    let mut units = 0usize;
    let mut found = None;
    for (byte, c) in s.char_indices() {
        if c == '\n' {
            if units > cap {
                break;
            }
            found = Some((units, byte));
        }
        units += if (c as u32) > 0xFFFF { 2 } else { 1 };
        if units > cap {
            break;
        }
    }
    found
}

/// JS truthiness for JSON values. JSON can't carry NaN, but the guard is
/// kept for parity honesty; `-0`/`0`/`0.0` are falsy, every object/array
/// is truthy (`!{}` is `false` in JS).
pub fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => match n.as_f64() {
            Some(f) => f != 0.0 && !f.is_nan(),
            None => true,
        },
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_trim_matches_ecma_not_rust_trim() {
        // FEFF: JS trims, Rust doesn't. U+0085: Rust trims, JS doesn't.
        assert_eq!(js_trim("\u{feff} hi \u{feff}"), "hi");
        assert_eq!(js_trim("\u{85}hi\u{85}"), "\u{85}hi\u{85}");
        assert_eq!(js_trim("\u{2028}a\u{2029}"), "a");
        assert_eq!(js_trim("\t\n\u{b}\u{c}\r x\r\n"), "x");
        assert_eq!(js_trim("no\u{a0}trim\u{a0}"), "no\u{a0}trim");
    }

    #[test]
    fn js_len_counts_utf16_units() {
        assert_eq!(js_len("abc"), 3);
        assert_eq!(js_len("café"), 4);
        assert_eq!(js_len("𝕏x"), 3); // astral = surrogate pair
    }

    #[test]
    fn js_slice_head_cuts_by_units_and_snaps_surrogates() {
        assert_eq!(js_slice_head("abcdef", 3), "abc");
        assert_eq!(js_slice_head("abc", 99), "abc");
        // Cut would land between the halves of the pair: snap below.
        assert_eq!(js_slice_head("a\u{1D54F}b", 1), "a");
        // Pair fully within the budget is kept.
        assert_eq!(js_slice_head("a\u{1D54F}b", 3), "a\u{1D54F}");
    }

    #[test]
    fn last_newline_respects_cap_inclusive_like_js_lastindexof() {
        // newline at utf16 index 2 of "ab\ncd", cap 2 qualifies (inclusive).
        assert_eq!(last_newline_at_or_below("ab\ncd", 2), Some((2, 2)));
        assert_eq!(last_newline_at_or_below("ab\ncd", 1), None);
        assert_eq!(last_newline_at_or_below("a\nb\nc", 3), Some((3, 3)));
        // Astral prefix shifts the unit index of later newlines.
        assert_eq!(last_newline_at_or_below("\u{1D54F}\n", 2), Some((2, 4)));
        assert_eq!(last_newline_at_or_below("\u{1D54F}\n", 1), None);
    }

    #[test]
    fn js_truthy_table() {
        let t = |raw: &str| js_truthy(&serde_json::from_str::<Value>(raw).unwrap());
        assert!(!t("null"));
        assert!(!t("false"));
        assert!(!t("0"));
        assert!(!t("\"\""));
        assert!(t("true"));
        assert!(t("1"));
        assert!(t("\"x\""));
        assert!(t("[]"));
        assert!(t("{}"));
    }
}
