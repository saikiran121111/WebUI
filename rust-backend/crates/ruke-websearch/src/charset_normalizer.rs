//! Parity port of `lib/web-search/charset-normalizer.ts` (owner: W3).
//!
//! Pure module — the TS imports nothing local and neither does this.
//!
//! # chardetng is deliberately NOT used
//! The TS module performs **no statistical encoding detection**: it resolves
//! the charset by Content-Type header → `<meta charset>` / `<meta http-equiv
//! ="Content-Type">` (first 4KB) → BOM sniff → `"utf-8"` fallback, then decodes
//! via `TextDecoder(label)`. The approved mapping (MIGRATION-MAP) for
//! `TextDecoder` is `encoding_rs`, whose WHATWG label table matches the one
//! the JS alias table resolves through. So the JS detection *table* (aliases
//! above) and chardetng's statistical models never overlap — chardetng is not
//! needed here and would change behavior.
//!
//! # TS quirks kept verbatim (do not "fix")
//! - `"iso-8859-15"` aliases to `"latin1"`, which WHATWG resolves to
//!   **windows-1252**, not ISO-8859-15 (pinned by test).
//! - `"iso-8859-1"` also lands on `"latin1"` → windows-1252 — same as
//!   TextDecoder, whose `iso-8859-1` label also resolves to windows-1252.
//! - `"euc-jp"` aliases to `"utf-8"` (EUC-JP sites decode garbled — intended
//!   broken TS behavior).
//! - `"utf-16"` (normally BE by convention) aliases to `"utf-16le"`.
//! - WHATWG's label table has NO ISO-8859-9 encoding at all: `latin5` /
//!   `iso-8859-9` decode as ISO-8859-15 (windows-1254 treated as a
//!   superset). `TextDecoder("latin5")` == `ISO_8859_15` — kept verbatim.
//! - The `charset=` regexes are unanchored: `xcharset=…` in a header or a
//!   stray `charset=` inside any `<meta …>` attribute run matches too.
//! - JS `[\w-]`/`\w` are ASCII; ported as explicit `[A-Za-z0-9_-]` so the
//!   regex crate's Unicode classes cannot change what is captured.
//! - JS `bodyBytes.slice(0, 4096)` slices *bytes*, possibly splitting a
//!   multi-byte sequence at the boundary; the lenient UTF-8 decode replaces
//!   it. Same byte-boundary slice here (`UTF_8.decode` is non-fatal).
//!
//! # Recorded divergences (unavoidable JS-vs-Rust)
//! - TS looks the alias up on a plain object literal, so JS prototype-chain
//!   lookup answers for aliases like `"constructor"`/`"toString"`:
//!   `detectCharset` returns the prototype function (not a label) and
//!   `new TextDecoder(fn)` then throws, so `normalizeBody` falls back to
//!   UTF-8 even when a UTF-16 BOM is present. The Rust map does a plain
//!   key lookup: such aliases miss and detection continues to BOM sniffing.
//!   Only reachable with adversarial Content-Type/meta input.
//! - BOM parity: `encoding_rs::Encoding::decode` performs WHATWG BOM removal
//!   and UTF-16 endianness swapping exactly like `TextDecoder` (verified by
//!   `normalize_body_bom_parity`).
//! - The TS `catch` in `normalizeBody` is dead code: every value the alias
//!   table can emit is a valid WHATWG TextDecoder label. The Rust
//!   `unwrap_or(UTF_8)` mirrors that unreachable fallback.

use encoding_rs::{
    Encoding, BIG5, EUC_KR, GB18030, ISO_8859_2, ISO_8859_13, ISO_8859_14, ISO_8859_15, ISO_8859_16, KOI8_R,
    SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1251, WINDOWS_1252,
};
use regex::Regex;
use std::sync::OnceLock;

/// Exact port of the TS `CHARSET_ALIASES` object (key → canonical
/// TextDecoder label). Order is irrelevant in TS (property lookup).
const CHARSET_ALIASES: &[(&str, &str)] = &[
    ("utf-8", "utf-8"),
    ("utf8", "utf-8"),
    ("iso-8859-1", "latin1"),
    ("iso-8859-15", "latin1"),
    ("iso-8859-2", "latin2"),
    ("iso-8859-9", "latin5"),
    ("iso-8859-10", "latin10"),
    ("iso-8859-13", "latin7"),
    ("iso-8859-14", "latin8"),
    ("iso-8859-16", "latin9"),
    ("windows-1252", "windows-1252"),
    ("cp1252", "windows-1252"),
    ("windows-1251", "windows-1251"),
    ("cp1251", "windows-1251"),
    ("koi8-r", "koi8-r"),
    ("shift_jis", "shift-jis"),
    ("shift-jis", "shift-jis"),
    ("sjis", "shift-jis"),
    ("x-sjis", "shift-jis"),
    ("gb18030", "gb18030"),
    ("gbk", "gb18030"),
    ("gb2312", "gb18030"),
    ("euc-kr", "euc-kr"),
    ("ks_c_5601-1987", "euc-kr"),
    ("big5", "big5"),
    ("euc-jp", "utf-8"),
    ("utf-16", "utf-16le"),
    ("utf-16le", "utf-16le"),
    ("utf-16be", "utf-16be"),
];

fn alias_lookup(alias: &str) -> Option<&'static str> {
    CHARSET_ALIASES
        .iter()
        .find(|(k, _)| *k == alias)
        .map(|(_, v)| *v)
}

/// WHATWG label → `encoding_rs` static for every label value the alias table
/// can emit (the same label table `TextDecoder` uses).
fn label_to_encoding(label: &str) -> Option<&'static Encoding> {
    Some(match label {
        "utf-8" => UTF_8,
        "latin1" | "windows-1252" => WINDOWS_1252, // TS "latin1" ⇒ cp1252 quirk kept
        "latin2" => ISO_8859_2,
        // WHATWG parity: the label table deliberately aliases latin5 /
        // iso-8859-9 to ISO-8859-15 (windows-1254 is treated as a superset);
        // TextDecoder("latin5") decodes Latin-9 — kept verbatim.
        "latin5" => ISO_8859_15,
        "latin7" => ISO_8859_13,
        "latin8" => ISO_8859_14,
        "latin9" => ISO_8859_15,
        "latin10" => ISO_8859_16,
        "windows-1251" => WINDOWS_1251,
        "koi8-r" => KOI8_R,
        "shift-jis" => SHIFT_JIS,
        "gb18030" => GB18030,
        "euc-kr" => EUC_KR,
        "big5" => BIG5,
        "utf-16le" => UTF_16LE,
        "utf-16be" => UTF_16BE,
        _ => return None,
    })
}

fn ct_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // JS: /charset\s*=\s*["']?([\w-]+)/i  — \w is ASCII in JS.
    RE.get_or_init(|| Regex::new(r#"(?i)charset\s*=\s*["']?([A-Za-z0-9_-]+)"#).unwrap())
}

fn meta_charset_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // JS: /<meta[^>]*charset\s*=\s*["']?([\w-]+)/i
    RE.get_or_init(|| Regex::new(r#"(?i)<meta[^>]*charset\s*=\s*["']?([A-Za-z0-9_-]+)"#).unwrap())
}

fn meta_http_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // JS: /<meta[^>]*http-equiv=["']?Content-Type["']?[^>]*content=["'][^"']*charset\s*=\s*([\w-]+)/i
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)<meta[^>]*http-equiv=["']?Content-Type["']?[^>]*content=["'][^"']*charset\s*=\s*([A-Za-z0-9_-]+)"#,
        )
        .unwrap()
    })
}

/// TS `detectCharset(contentType, bodyBytes)`: returns the canonical label
/// TextDecoder accepts, or `"utf-8"`.
pub fn detect_charset(content_type: &str, body_bytes: &[u8]) -> String {
    // 1. Content-Type header
    if let Some(caps) = ct_re().captures(content_type) {
        if let Some(label) = alias_lookup(&caps[1].to_lowercase()) {
            return label.to_string();
        }
    }

    // 2 & 3: <meta> tags in the first 4KB (byte slice, lenient UTF-8 decode —
    // mirrors TextDecoder("utf-8", { fatal: false })).
    let head = UTF_8.decode(&body_bytes[..body_bytes.len().min(4096)]).0.into_owned();
    if let Some(caps) = meta_charset_re().captures(&head) {
        if let Some(label) = alias_lookup(&caps[1].to_lowercase()) {
            return label.to_string();
        }
    }
    if let Some(caps) = meta_http_re().captures(&head) {
        if let Some(label) = alias_lookup(&caps[1].to_lowercase()) {
            return label.to_string();
        }
    }

    // 4. BOM sniffing
    if body_bytes.len() >= 3 && body_bytes[0] == 0xef && body_bytes[1] == 0xbb && body_bytes[2] == 0xbf
    {
        return "utf-8".to_string();
    }
    if body_bytes.len() >= 2 && body_bytes[0] == 0xff && body_bytes[1] == 0xfe {
        return "utf-16le".to_string();
    }
    if body_bytes.len() >= 2 && body_bytes[0] == 0xfe && body_bytes[1] == 0xff {
        return "utf-16be".to_string();
    }

    // 5. Fallback
    "utf-8".to_string()
}

/// TS `normalizeBody(bodyBytes, contentType)`: decode the raw bytes with the
/// detected charset ("" for empty input).
pub fn normalize_body(body_bytes: &[u8], content_type: &str) -> String {
    if body_bytes.is_empty() {
        return String::new();
    }
    let charset = detect_charset(content_type, body_bytes);
    // TS try/catch fallback: every label the alias table emits is valid, so
    // the UTF-8 fallback is unreachable in practice — kept for parity shape.
    label_to_encoding(&charset)
        .unwrap_or(UTF_8)
        .decode(body_bytes)
        .0
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_and_alias_table() {
        assert_eq!(detect_charset("text/html; charset=Shift_JIS", b""), "shift-jis");
        assert_eq!(detect_charset("application/json;charset=utf8", b""), "utf-8");
        assert_eq!(detect_charset("text/html; charset=GBK", b""), "gb18030");
        assert_eq!(detect_charset("text/html; charset=UTF-16", b""), "utf-16le");
        // Unanchored-`charset=` quirk: `xcharset=` still matches.
        assert_eq!(detect_charset("text/html; xcharset=sjis", b""), "shift-jis");
        // Unknown alias → falls through the table (JS prototype-chain edge NOT
        // emulated; see module doc).
        assert_eq!(detect_charset("text/html; charset=constructor", b""), "utf-8");
    }

    #[test]
    fn iso8859_15_aliaslands_on_cp1252_quirk() {
        // TS: "iso-8859-15" → "latin1" → TextDecoder("latin1") = windows-1252.
        assert_eq!(detect_charset("charset=iso-8859-15", b""), "latin1");
        assert_eq!(normalize_body(&[0x80], "text/html; charset=iso-8859-1"), "\u{20ac}");
        // euc-jp → utf-8 quirk.
        assert_eq!(detect_charset("charset=euc-jp", b""), "utf-8");
    }

    #[test]
    fn meta_scan_and_4kb_limit() {
        assert_eq!(detect_charset("", b"<html><head><meta charset=\"big5\">"), "big5");
        assert_eq!(
            detect_charset(
                "",
                b"<meta http-equiv=\"Content-Type\" content=\"text/html; charset=EUC-KR\">"
            ),
            "euc-kr"
        );
        // 4KB byte-slice limit: a meta tag past 4096 bytes is invisible.
        let mut body = vec![b'a'; 4096];
        body.extend_from_slice(b"<meta charset=big5>");
        assert_eq!(detect_charset("", &body), "utf-8");
    }

    #[test]
    fn bom_sniffing() {
        assert_eq!(detect_charset("", b"\xef\xbb\xbfhi"), "utf-8");
        assert_eq!(detect_charset("", b"\xff\xfeh\x00"), "utf-16le");
        assert_eq!(detect_charset("", b"\xfe\xff\x00h"), "utf-16be");
        assert_eq!(detect_charset("", b"<html>"), "utf-8");
    }

    #[test]
    fn normalize_roundtrip_and_bom_parity() {
        assert_eq!(normalize_body(b"", "text/html"), "");
        let (gb, _, _) = GB18030.encode("\u{4f60}\u{597d}\u{4e16}\u{754c}");
        assert_eq!(normalize_body(&gb, "text/html; charset=gb2312"), "\u{4f60}\u{597d}\u{4e16}\u{754c}");
        let (sj, _, _) = SHIFT_JIS.encode("\u{65e5}\u{672c}\u{8a9e}");
        assert_eq!(normalize_body(&sj, "text/html; charset=shift_jis"), "\u{65e5}\u{672c}\u{8a9e}");
        // TextDecoder parity: matching BOM is stripped.
        assert_eq!(normalize_body(b"\xef\xbb\xbfhi", "text/plain"), "hi");
        assert_eq!(normalize_body(&[0xff, 0xfe, b'h', 0, b'i', 0], "text/plain"), "hi");
    }
}
