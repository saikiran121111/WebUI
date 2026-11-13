//! `lib/server/attachindex/router.ts` — regex-only query routing, zero LLM.
//!
//! WORD-BOUNDARY PARITY (§6 Unicode law): JS enforces boundaries with
//! `(?<![\p{L}\p{N}\p{M}_])` / `(?![\p{L}\p{N}\p{M}_])`. (The retired JS
//! `\b` was ASCII-only, so every non-ASCII letter looked like a boundary —
//! "café1:45" routed where "this1:45" did not.) The regex crate has no
//! lookaround, so every `\b` is STRIPPED from the Rust pattern and enforced
//! manually: a candidate is accepted only when the CHAR before its start
//! and the CHAR after its end are OUTSIDE `[\p{L}\p{N}\p{M}_]` (string
//! edges count as outside). Combining marks belong to their word, so
//! mark-final Indic/Thai words glue exactly like Latin words. On rejection
//! the scan resumes at `candidate_start + 1` — the JS engine's per-position
//! retry (every pattern here starts with an ASCII byte, so that offset is
//! always a char boundary).
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
/// `last_sec` (I22): "the last N minutes" carries NO window of its own —
/// the turn layer resolves it against the index's own duration (TS
/// `lastSec`, resolved in `build_attachment_turn`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RoutedQuery {
    pub mode: QueryMode,
    pub from_sec: Option<f64>,
    pub to_sec: Option<f64>,
    pub block_index: Option<i64>,
    pub last_sec: Option<f64>,
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
fn last_min() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"last\s+([0-9]{1,3})\s*(?:minutes?|mins?|m)"))
}
fn block_kw() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"(?:module|section|chapter|part|lesson|unit)\s+([0-9]{1,2})"))
}
fn exhaustive_kw() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        re(r"every time|all (?:the )?times|how many times|list every|every mention|each mention|wherever|any time|mentioned how often|all (?:the )?mentions?|list all")
    })
}
fn whole_kw() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        re(r"summar(?:y|ize|ise)|outline|course notes|main points|key points|whole (?:video|course|lecture)|entire (?:video|course|lecture)|teach me the (?:whole|entire)|walk me through the (?:whole|entire)|from (?:the )?beginning to (?:the )?end")
    })
}

/// `PRONOUN_RE` from `turn.ts` lives here so the §6 Unicode word-boundary
/// emulation exists exactly once.
pub(crate) fn pronoun_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"(?i)(?:why|how come|that|this|these|those|it|its|they|them|there|here)"))
}

/// §6 word class, byte-for-byte the JS lookaround class
/// `[\p{L}\p{N}\p{M}_]` (letters, numbers, combining marks, underscore).
fn word_class() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"[\p{L}\p{N}\p{M}_]"))
}

fn is_word_char(c: char) -> bool {
    word_class().is_match(c.encode_utf8(&mut [0u8; 4]))
}

fn word_bounds_ok(hay: &str, start: usize, end: usize) -> bool {
    // Match offsets are always char boundaries, so the neighbors are whole
    // code points — exactly what the JS `/u` lookbehind/lookahead reads.
    let prev_ok = start == 0 || !is_word_char(hay[..start].chars().next_back().expect("char boundary"));
    let next_ok = end == hay.len() || !is_word_char(hay[end..].chars().next().expect("char boundary"));
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
    caps.get(n)
        .map(|m| m.as_str().parse::<f64>().unwrap_or(0.0))
        .unwrap_or(0.0)
}

/// JS `Math.min(...times)` / `Math.max(...times)` over a NON-EMPTY vec.
fn fold_min(xs: &[f64]) -> f64 {
    xs.iter()
        .fold(f64::INFINITY, |a, &b| if b < a { b } else { a })
}
fn fold_max(xs: &[f64]) -> f64 {
    xs.iter()
        .fold(f64::NEG_INFINITY, |a, &b| if b > a { b } else { a })
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
            times.push(
                group_f64(&caps, 1) * 3600.0 + group_f64(&caps, 2) * 60.0 + group_f64(&caps, 3),
            );
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
        return RoutedQuery {
            mode: QueryMode::TimeRange,
            from_sec: Some(fold_min(&times)),
            to_sec: Some(fold_max(&times)),
            block_index: None,
            last_sec: None,
        };
    }
    if times.len() == 1 {
        let c = times[0];
        return RoutedQuery {
            mode: QueryMode::TimeRange,
            from_sec: Some((c - 180.0).max(0.0)),
            to_sec: Some(c + 180.0),
            block_index: None,
            last_sec: None,
        };
    }

    if let Some(caps) = next_caps(first_min(), &text, 0) {
        return RoutedQuery {
            mode: QueryMode::TimeRange,
            from_sec: Some(0.0),
            to_sec: Some(group_f64(&caps, 1) * 60.0),
            block_index: None,
            last_sec: None,
        };
    }
    if let Some(caps) = next_caps(at_min(), &text, 0) {
        let c = group_f64(&caps, 1) * 60.0;
        return RoutedQuery {
            mode: QueryMode::TimeRange,
            from_sec: Some((c - 180.0).max(0.0)),
            to_sec: Some(c + 180.0),
            block_index: None,
            last_sec: None,
        };
    }
    if let Some(caps) = next_caps(last_min(), &text, 0) {
        // No from/to here on purpose (I22): only the index's own duration
        // knows where "the end" is — the turn layer resolves it.
        return RoutedQuery {
            mode: QueryMode::TimeRange,
            from_sec: None,
            to_sec: None,
            block_index: None,
            last_sec: Some(group_f64(&caps, 1) * 60.0),
        };
    }
    if let Some(caps) = next_caps(block_kw(), &text, 0) {
        return RoutedQuery {
            mode: QueryMode::Sequential,
            from_sec: None,
            to_sec: None,
            block_index: Some(group_f64(&caps, 1) as i64 - 1),
            last_sec: None,
        };
    }
    if next_caps(exhaustive_kw(), &text, 0).is_some() {
        return RoutedQuery {
            mode: QueryMode::Exhaustive,
            ..Default::default()
        };
    }
    if next_caps(whole_kw(), &text, 0).is_some() {
        return RoutedQuery {
            mode: QueryMode::WholeVideo,
            ..Default::default()
        };
    }
    RoutedQuery {
        mode: QueryMode::PointQa,
        ..Default::default()
    }
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
        assert_eq!(
            tr("walk me from 1:00:00 to 1:30:00"),
            (Some(3600.0), Some(5400.0))
        );
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
        // Spaced boundary survives the §6 class change (c = 105 ⇒ window
        // (max(0,105-180), 105+180); the boundary is the SPACE, not é).
        assert_eq!(tr("café 1:45"), (Some(0.0), Some(285.0)));
        // Trailing-glued word after "first 5 minutes".
        assert_eq!(route_query("first 5 minutesx").mode, QueryMode::PointQa);
        // "summarizes": "summarize" body matches but the "s" glue kills \b;
        // no other alternative matches ⇒ point_qa (JS backtracks identically).
        assert_eq!(
            route_query("can you summarizes it").mode,
            QueryMode::PointQa
        );
        // "everytime" has no space inside "every time".
        assert_eq!(route_query("everytime we meet").mode, QueryMode::PointQa);
    }

    /// §6 independently-generated held-out family (⇔ the TS
    /// `attach-boundary-heldout` suite): glue is glue in EVERY script —
    /// the retired ASCII-`\b` emulation routed non-ASCII-glued timestamps
    /// because a multibyte neighbor never looked like an ASCII word byte.
    /// Combining marks (Telugu vowel signs, Devanagari virama, Thai sara)
    /// join the class, so mark-final words glue exactly like Latin words.
    #[test]
    fn unicode_word_class_heldout() {
        for q in [
            "café1:45",
            "ప్రిస్టూడియో2:30",
            "दृश्य3:20",
            "कंप्यूटर्3:20",
            "片段1:05",
            "วิดีโอ4:45",
        ] {
            assert_eq!(route_query(q).mode, QueryMode::PointQa, "{q}");
        }
        // Positive controls: spaced boundaries route exactly like ASCII.
        assert_eq!(tr("café 1:45"), (Some(0.0), Some(285.0)));
        assert_eq!(
            tr("ప్రిస్టూడియో 2:30 నుండి 4:15 వరకు"),
            (Some(150.0), Some(255.0))
        );
        assert_eq!(tr("दृश्य 3:20"), (Some(20.0), Some(380.0)));
        assert_eq!(tr("片段 1:05"), (Some(0.0), Some(245.0)));
        assert_eq!(tr("วิดีโอ 4:45"), (Some(105.0), Some(465.0)));
        // Mark-final glue on the whole_video cue (Telugu anusvara) vs spaced.
        assert_eq!(route_query("జాప్తంsummarize").mode, QueryMode::PointQa);
        assert_eq!(
            route_query("జాప్తం summarize").mode,
            QueryMode::WholeVideo
        );
        // Pronoun guard: glued pronouns are never counted; spaced ones are.
        assert_eq!(
            count_bounded(
                pronoun_re(),
                "caféit and caféthey explain how the rendering pipeline handles occlusion culling in deferred shaders for this scene"
            ),
            1
        );
        assert_eq!(
            count_bounded(
                pronoun_re(),
                "why does it look wrong when they bake that into the lightmap during this pass here"
            ),
            6
        );
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
    fn last_n_minutes_i22() {
        // last_sec ONLY — no window until the turn layer knows the duration.
        let r = route_query("what happened in the last 10 minutes");
        assert_eq!(r.mode, QueryMode::TimeRange);
        assert_eq!(r.last_sec, Some(600.0));
        assert_eq!(r.from_sec, None);
        assert_eq!(r.to_sec, None);
        assert_eq!(
            route_query("what did he say in the last 5 mins").last_sec,
            Some(300.0)
        );
        assert_eq!(
            route_query("cover the last 2m of the lecture").last_sec,
            Some(120.0)
        );
        // Boundary parity with the JS \b family (word-glued rejections).
        assert_eq!(
            route_query("lastx 10 minutes into it").mode,
            QueryMode::PointQa
        );
        // Trailing glue: every `minutes?|mins?|m` alternative word-glues on
        // 'x' ⇒ no lastSec. With the candidate dead, the rest of the query
        // routes on its own (TS pins both sides in attach-router-phrase).
        assert_eq!(
            route_query("last 10 minutesx into it").mode,
            QueryMode::PointQa
        );
        assert_eq!(
            route_query("last 10 minutesx summary").mode,
            QueryMode::WholeVideo
        );
        // §6 FLIP (was last_sec Some(600.0)): é IS a word char under the
        // Unicode class ⇒ "cafélast" is dead-candidate glue; the rest
        // routes on its own (mirror of the TS attach-router-phrase pin).
        assert_eq!(
            route_query("cafélast 10 minutes summary").mode,
            QueryMode::WholeVideo
        );
        // Absolute timestamps still win (this rule runs after them).
        assert_eq!(
            route_query("summarize the last 10 minutes of 1:00:00 to 1:30:00").last_sec,
            None
        );
    }

    #[test]
    fn exhaustive_phrase_growth_i22() {
        for q in [
            "list all the mentions of entropy",
            "give me all mentions of the word basically",
            "any time he says remember this",
        ] {
            assert_eq!(route_query(q).mode, QueryMode::Exhaustive, "{q}");
        }
        assert_eq!(
            route_query("what is the average of all the quiz scores").mode,
            QueryMode::PointQa
        );
    }

    #[test]
    fn exhaustive_and_whole_video_phrases() {
        assert_eq!(
            route_query("how many times does he say ubiquitin").mode,
            QueryMode::Exhaustive
        );
        assert_eq!(
            route_query("all the times mitosis appears").mode,
            QueryMode::Exhaustive
        );
        assert_eq!(
            route_query("wherever the kernel is mentioned").mode,
            QueryMode::Exhaustive
        );
        assert_eq!(route_query("give me a summary").mode, QueryMode::WholeVideo);
        assert_eq!(
            route_query("course notes for this").mode,
            QueryMode::WholeVideo
        );
        assert_eq!(
            route_query("from the beginning to the end").mode,
            QueryMode::WholeVideo
        );
        // Time windows beat keyword modes (order matters, TS lines 33-51).
        assert_eq!(
            route_query("summarize from 1:00:00 to 1:30:00").mode,
            QueryMode::TimeRange
        );
        assert_eq!(
            route_query("what is photosynthesis").mode,
            QueryMode::PointQa
        );
    }

    #[test]
    fn pronoun_count_matches_js_match_length() {
        // "why … that … it" = 3; word-glued pronouns don't count.
        assert_eq!(
            count_bounded(pronoun_re(), "why does that happen when it rains"),
            3
        );
        // Both candidates are word-glued ("why"+"d", "that"+"1") ⇒ null ⇒ 0.
        assert_eq!(count_bounded(pronoun_re(), "whydoes that1 happen"), 0);
        assert_eq!(count_bounded(pronoun_re(), "How come they left there"), 3); // (?i)
    }
}
