//! `lib/server/attachindex/router.ts` — regex-only query routing, zero LLM.
//!
//! WORD-BOUNDARY PARITY (`\b`): JS `\b` is ASCII-only (`[A-Za-z0-9_]`)
//! while the regex crate's `\b` is Unicode-word, so every `\b` is STRIPPED
//! from the Rust pattern and enforced manually: a candidate is accepted
//! only when the byte before its start and the byte after its end are NOT
//! ASCII word bytes (string edges count as non-word). A multibyte neighbor
//! never looks like an ASCII word byte, matching JS's "non-ASCII char is a
//! non-word char" behavior. On rejection the scan resumes at
//! `candidate_start + 1` — the JS engine's per-position retry.
//!
//! Why one candidate per start position suffices (no length re-tries):
//! every pattern's variable-width piece (`\d{1,2}`, `\d{1,3}`, `minutes?`,
//! `(?:the )?`) is immediately followed by a distinguishing literal or a
//! fixed-width digit class, and every trailing `\b` sits either after a
//! fixed-width class (so the neighbor char is the same for all length
//! choices) or after a digit run (where a shorter choice only makes the
//! neighbor a DIGIT — also word — so acceptance never flips). The regex
//! crate's leftmost-first semantics then pick the same candidate JS's
//! backtracking settles on. Adversarial unit tests below pin the family.

use std::sync::OnceLock;

use regex::Regex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum QueryMode {
    /// The TS fallback mode (`routeQuery`'s final return) — only ever
    /// used to fill struct-update syntax, never to route.
    #[default]
    PointQa,
    TimeRange,
    Sequential,
    Exhaustive,
    WholeVideo,
}

/// `RoutedQuery` — `blockIndex` is 0-based ("module 2" → 1).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RoutedQuery {
    pub mode: QueryMode,
    pub from_sec: Option<f64>,
    pub to_sec: Option<f64>,
    pub block_index: Option<i64>,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

// Every pattern below is the TS original with `\b` removed (manually
// re-imposed); alternation/group structure and quantifier greediness are
// untouched.

fn hms() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"([0-9]{1,2}):([0-5][0-9]):([0-5][0-9])"))
}
fn ms() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"([0-9]{1,2}):([0-5][0-9])"))
}
fn first_min() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"first\s+([0-9]{1,3})\s*(?:minutes?|mins?|m)"))
}
fn at_min() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"(?:at|around)\s+(?:minute|min)\s*([0-9]{1,3})"))
}
fn block_kw() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"(?:module|section|chapter|part|lesson|unit)\s+([0-9]{1,2})"))
}
fn exhaustive_kw() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        re(r"every time|all (?:the )?times|how many times|list every|every mention|each mention|wherever|any time|mentioned how often")
    })
}
fn whole_kw() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        re(r"summar(?:y|ize|ise)|outline|course notes|main points|key points|whole (?:video|course|lecture)|entire (?:video|course|lecture)|teach me the (?:whole|entire)|walk me through the (?:whole|entire)|from (?:the )?beginning to (?:the )?end")
    })
}

/// `PRONOUN_RE` (`/\b(…)\b/gi` from `turn.ts`) lives here so the
/// word-boundary emulation exists exactly once.
pub(crate) fn pronoun_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"(?i)(?:why|how come|that|this|these|those|it|its|they|them|there|here)"))
}

fn is_ascii_word_byte(b: u8) -> bool {
    b == b'_' || b.is_ascii_alphanumeric()
}

fn word_bounds_ok(hay: &str, start: usize, end: usize) -> bool {
    let prev_ok = start == 0 || !is_ascii_word_byte(hay.as_bytes()[start - 1]);
    let next_ok = end == hay.len() || !is_ascii_word_byte(hay.as_bytes()[end]);
    prev_ok && next_ok
}

/// Leftmost match at ≥ `from` whose both edges satisfy the manual `\b`;
/// rejected candidates advance the scan by ONE char (JS engine semantics).
pub(crate) fn next_caps<'t>(re: &Regex, hay: &'t str, from: usize) -> Option<regex::Captures<'t>> {
    let mut pos = from;
    while let Some(caps) = re.captures_at(hay, pos) {
        let m = caps.get(0).expect("whole match");
        if word_bounds_ok(hay, m.start(), m.end()) {
            return Some(caps);
        }
        pos = m.start() + 1;
    }
    None
}

/// `text.match(re)?.length` for the global pronoun regex.
pub(crate) fn count_bounded(re: &Regex, hay: &str) -> usize {
    let mut n = 0;
    let mut pos = 0;
    while let Some(caps) = next_caps(re, hay, pos) {
        n += 1;
        pos = caps.get(0).expect("whole match").end();
    }
    n
}

/// `+group` — the groups are digit-only by construction; a parse failure
/// is impossible and reads 0 rather than panicking (never observed).
fn group_f64(caps: &regex::Captures<'_>, n: usize) -> f64 {
    caps.get(n).map(|m| m.as_str().parse::<f64>().unwrap_or(0.0)).unwrap_or(0.0)
}

/// JS `Math.min(...times)` / `Math.max(...times)` over a NON-EMPTY vec.
fn fold_min(xs: &[f64]) -> f64 {
    xs.iter().fold(f64::INFINITY, |a, &b| if b < a { b } else { a })
}
fn fold_max(xs: &[f64]) -> f64 {
    xs.iter().fold(f64::NEG_INFINITY, |a, &b| if b > a { b } else { a })
}

pub fn route_query(q: &str) -> RoutedQuery {
    let text = q.to_lowercase();

    // Explicit timestamps run on the RAW query (JS replaces on `q`, not on
    // `text`); each accepted match is replaced by a single " " and the
    // stripped remainder feeds the MS pass.
    let mut times: Vec<f64> = Vec::new();

    let mut stripped = String::new();
    {
        let (r, mut pos) = (hms(), 0usize);
        while let Some(caps) = next_caps(r, q, pos) {
            let m = caps.get(0).expect("whole match");
            stripped.push_str(&q[pos..m.start()]);
            stripped.push(' ');
            times.push(group_f64(&caps, 1) * 3600.0 + group_f64(&caps, 2) * 60.0 + group_f64(&caps, 3));
            pos = m.end();
        }
        stripped.push_str(&q[pos..]);
    }

    // The MS pass scans the HMS-stripped string (TS replaces on the
    // first replace's RESULT). JS `replace` always scans the ORIGINAL of
    // the pass (never the replacement output), and this pass's replaced
    // remainder is never scanned again — so only the times are collected.
    {
        let (r, mut pos) = (ms(), 0usize);
        while let Some(caps) = next_caps(r, &stripped, pos) {
            times.push(group_f64(&caps, 1) * 60.0 + group_f64(&caps, 2));
            pos = caps.get(0).expect("whole match").end();
        }
    }

    if times.len() >= 2 {
        return RoutedQuery { mode: QueryMode::TimeRange, from_sec: Some(fold_min(&times)), to_sec: Some(fold_max(&times)), block_index: None };
    }
    if times.len() == 1 {
        let c = times[0];
        return RoutedQuery { mode: QueryMode::TimeRange, from_sec: Some((c - 180.0).max(0.0)), to_sec: Some(c + 180.0), block_index: None };
    }

    if let Some(caps) = next_caps(first_min(), &text, 0) {
        return RoutedQuery { mode: QueryMode::TimeRange, from_sec: Some(0.0), to_sec: Some(group_f64(&caps, 1) * 60.0), block_index: None };
    }
    if let Some(caps) = next_caps(at_min(), &text, 0) {
        let c = group_f64(&caps, 1) * 60.0;
        return RoutedQuery { mode: QueryMode::TimeRange, from_sec: Some((c - 180.0).max(0.0)), to_sec: Some(c + 180.0), block_index: None };
    }
    if let Some(caps) = next_caps(block_kw(), &text, 0) {
        return RoutedQuery { mode: QueryMode::Sequential, from_sec: None, to_sec: None, block_index: Some(group_f64(&caps, 1) as i64 - 1) };
    }
    if next_caps(exhaustive_kw(), &text, 0).is_some() {
        return RoutedQuery { mode: QueryMode::Exhaustive, ..Default::default() };
    }
    if next_caps(whole_kw(), &text, 0).is_some() {
        return RoutedQuery { mode: QueryMode::WholeVideo, ..Default::default() };
    }
    RoutedQuery { mode: QueryMode::PointQa, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr(q: &str) -> (Option<f64>, Option<f64>) {
        let r = route_query(q);
        assert_eq!(r.mode, QueryMode::TimeRange, "{q}");
        (r.from_sec, r.to_sec)
    }

    #[test]
    fn hms_pairs_and_windows() {
        assert_eq!(tr("walk me from 1:00:00 to 1:30:00"), (Some(3600.0), Some(5400.0)));
        // "around 1:45:00" — the fixture-05 anchor: 6300 ± 180.
        assert_eq!(tr("around 1:45:00"), (Some(6120.0), Some(6480.0)));
        // min/max fold is order-independent.
        assert_eq!(tr("from 10:00 back to 5:00"), (Some(300.0), Some(600.0)));
        // Single time clamps at 0.
        assert_eq!(tr("at 1:30 what happened"), (Some(0.0), Some(270.0)));
    }

    #[test]
    fn adversarial_word_boundary_family() {
        // HMS "12:34:56" would be word-glued to "7" ⇒ rejected; MS then
        // matches "12:34" (trailing ":" is non-word) ⇒ ONE time 754.
        assert_eq!(tr("12:34:567"), (Some(574.0), Some(934.0)));
        // Left-glued digits: "this1:45" — every candidate has a word byte
        // before it ⇒ no time at all.
        assert_eq!(route_query("this1:45").mode, QueryMode::PointQa);
        // Non-ASCII neighbor is NOT an ASCII word byte ⇒ boundary OK.
        // c = 1*60+45 = 105 ⇒ window (max(0,105-180), 105+180).
        assert_eq!(tr("café 1:45"), (Some(0.0), Some(285.0)));
        // Trailing-glued word after "first 5 minutes".
        assert_eq!(route_query("first 5 minutesx").mode, QueryMode::PointQa);
        // "summarizes": "summarize" body matches but the "s" glue kills \b;
        // no other alternative matches ⇒ point_qa (JS backtracks identically).
        assert_eq!(route_query("can you summarizes it").mode, QueryMode::PointQa);
        // "everytime" has no space inside "every time".
        assert_eq!(route_query("everytime we meet").mode, QueryMode::PointQa);
    }

    #[test]
    fn minute_phrases_and_blocks() {
        assert_eq!(tr("cover the first 5 minutes"), (Some(0.0), Some(300.0)));
        assert_eq!(tr("first 90m in"), (Some(0.0), Some(5400.0)));
        assert_eq!(tr("AT MINUTE 5 please"), (Some(120.0), Some(480.0))); // lowercased text
        assert_eq!(tr("around min 3"), (Some(0.0), Some(360.0)));
        let r = route_query("explain module 2 only");
        assert_eq!(r.mode, QueryMode::Sequential);
        assert_eq!(r.block_index, Some(1));
        assert_eq!(route_query("part3 details").mode, QueryMode::PointQa); // \s+ required
    }

    #[test]
    fn exhaustive_and_whole_video_phrases() {
        assert_eq!(route_query("how many times does he say ubiquitin").mode, QueryMode::Exhaustive);
        assert_eq!(route_query("all the times mitosis appears").mode, QueryMode::Exhaustive);
        assert_eq!(route_query("wherever the kernel is mentioned").mode, QueryMode::Exhaustive);
        assert_eq!(route_query("give me a summary").mode, QueryMode::WholeVideo);
        assert_eq!(route_query("course notes for this").mode, QueryMode::WholeVideo);
        assert_eq!(route_query("from the beginning to the end").mode, QueryMode::WholeVideo);
        // Time windows beat keyword modes (order matters, TS lines 33-51).
        assert_eq!(route_query("summarize from 1:00:00 to 1:30:00").mode, QueryMode::TimeRange);
        assert_eq!(route_query("what is photosynthesis").mode, QueryMode::PointQa);
    }

    #[test]
    fn pronoun_count_matches_js_match_length() {
        // "why … that … it" = 3; word-glued pronouns don't count.
        assert_eq!(count_bounded(pronoun_re(), "why does that happen when it rains"), 3);
        // Both candidates are word-glued ("why"+"d", "that"+"1") ⇒ null ⇒ 0.
        assert_eq!(count_bounded(pronoun_re(), "whydoes that1 happen"), 0);
        assert_eq!(count_bounded(pronoun_re(), "How come they left there"), 3); // (?i)
    }
}
