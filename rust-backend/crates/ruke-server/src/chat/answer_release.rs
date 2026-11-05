//! answer_release.rs — WS06 (audit 2026-11-05 item 6): the grounded answer
//! RELEASE check for research turns (⇔ TS `lib/chat/answer-release.ts`).
//!
//! Audit law (verbatim): "server-enforced action/citation/claim checks before
//! releasing final research assertions, including the normal finish path. A
//! prompt or attached ledger is not enforcement. Buffer answer units or use a
//! bounded draft/verify/release phase; repair or qualify unsupported claims."
//! The guidance text already TELLS the model these laws; this module ENFORCES
//! them on what the model actually streamed — [`crate::chat::web_loop`]
//! buffers each round's content, audits it here, and only then releases.
//! Post-MHR-A (2026-11-05) the loop is armed for EVERY progress-path chat
//! turn (no gate prefetch; the model directs the tools); the legacy
//! stream:false plain forward never runs here.
//!
//! Enforcement is deterministic — never a vibes-model call. MHR-F (WS26,
//! 2026-11-06) split the checks by OWNER:
//!  R1 CITATION INTEGRITY (the harness's, enforced at release): every [S#]
//!    marker must resolve to a citation the SERVER minted (pipeline bundle
//!    or tool-minted seeds). The [S#] grammar is a server mint, so an
//!    unresolvable marker is a broken REFERENCE — its bytes are stripped
//!    (whitespace/punctuation residue cleanup only). The sentence's words
//!    are otherwise released UNTOUCHED: the harness never qualifies a claim
//!    "(unverified)", and a minted citation is NEVER removed, moved or
//!    altered — even when an adjacent marker in the same sentence is fake.
//!  R2 SEMANTIC SUPPORT (the model's, diagnosis-only since MHR-F): the
//!    volatile-claim detectors (currency/percent/rating/temperature/date/
//!    coordinate/price- or weather-word + digit, no resolving [S#]) live in
//!    diagnose_research_answer ONLY — reported to the model once through
//!    the byte-locked harness feedback, never rewritten on release.
//!  R3 action check (kept at release): research-claiming wording on a turn
//!    where NOTHING was retrieved (empty citation map, no successful ledger
//!    action) gets a prepended server-attested check line. The LEDGER
//!    decides, never prose — an attestation about the harness, not a
//!    rewrite of the model's claims.
//!
//! Protections: fenced code blocks and inline code spans are byte-protected;
//! idempotency law: the integrity layer only REMOVES bytes, so released
//! text is safe to persist, replay, and audit again on follow-up turns.
//!
//! MHR-D (brief 2026-11-05) adds the NON-DESTRUCTIVE half:
//! [`diagnose_research_answer`] runs the SAME detectors but only REPORTS
//! the server's actual state (fabricated markers, unsupported sentences
//! VERBATIM, research wording without retrieval). The loop holds a
//! diagnosed-bad answer back and injects ONE byte-locked feedback message
//! ([`build_answer_feedback`] — pinned by the matrix's mhrD section) into
//! the EXISTING tool loop; the MODEL then decides the next action. The
//! harness never rewrites semantics with thresholds or phrase patches.
//! MHR-F (WS26, 2026-11-06) CLOSED that half-state: the release audit
//! enforces CITATION INTEGRITY only, and semantic support rides the
//! diagnosis→feedback channel alone (the mhrF matrix section pins the
//! separation).
//!
//! Cross-language byte-lock: BOTH this module and the TS side read the ONE
//! vendored truth matrix `rust-backend/fixtures/answer-release/matrix.json`
//! (include_str! below ⇔ vitest readFileSync). If either implementation
//! drifts, its own test suite goes red on identical inputs.
//! Known limitation (documented, shared with TS): R3 wording detection is
//! English-phrase-based; R1/R2 are language-agnostic.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

/// ⇔ TS `SERVER_CHECK_LINE` — byte-locked by the matrix `serverCheckLine`,
/// never by editing either side independently (the em-dash included).
pub const SERVER_CHECK_LINE: &str = "(Server check: no successful web retrieval this turn — the text below is unverified background knowledge, not research.)";

/* ── volatile-fact shapes (digit gate applied per sentence; ⇔ TS) ─────── */

/// TS `(?:\b|(?=[.,;:!?]))` tail: the regex crate has no lookahead; plain
/// `\b` covers the punctuated tail too (word→non-word transition before
/// `.`, `,`, etc. matches), so the shapes stay identical in behavior.
static RE_CURRENCY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[$€£₹¥]\s?\d|\d[\d.,]*\s?(?:USD|EUR|GBP|INR|dollars?|rupees?|euros?|pounds?)\b").unwrap()
});
static RE_PERCENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\d[\d.,]*\s?(?:%|percent)").unwrap());
static RE_RATING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:rated|rating|score|stars?)\b|\bout of \d").unwrap()
});
static RE_TEMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)°\s?[CF]\b|\b(?:degrees?|celsius|fahrenheit)\b").unwrap()
});
static RE_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b")
        .unwrap()
});
static RE_COORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,2}\.\d{3,}").unwrap()
});
static RE_PRICEWORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:price|pricing|cost|costs|fee|fees|paid|subscription|priced|fare|ticket)\b|\bstarts at\b")
        .unwrap()
});
static RE_WEATHER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:weather|forecast|temperature|rain|sunny|humid|wind)\b").unwrap()
});
static RE_GEOWORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:latitude|longitude|coordinates?|lat|lon)\b").unwrap());

static VOLATILE: LazyLock<Vec<&'static LazyLock<Regex>>> =
    LazyLock::new(|| vec![
        &RE_CURRENCY, &RE_PERCENT, &RE_RATING, &RE_TEMP, &RE_DATE, &RE_COORDS, &RE_PRICEWORD,
        &RE_WEATHER, &RE_GEOWORD,
    ]);

/* ── research-claiming wording (R3; English-only — see header limitation) ─ */

static RE_RESEARCH_WORDING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)according to (?:my |the |our |these |those )?(?:web )?(?:searches?\b|research\b|sources?\b|findings\b)|\b(?:my |our |the )?search(?:es| results)? (?:show|shows|found|confirm|confirms|indicate|suggest|suggests)\b|\b(?:my |our )?research (?:show|shows|found|confirm|confirms|indicates|suggests)\b|\b(?:the |these )?sources? (?:say|says|show|shows|confirm|indicate)\b")
        .unwrap()
});

static RE_MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[S(\d+)\]").unwrap());
static RE_DOUBLE_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" {2,}").unwrap());
static RE_PUNCT_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" ([.,;:!?])").unwrap());
/// Kept for the DIAGNOSIS half only (MHR-F): sentences that already carry
/// "unverified" wording are not re-reported as unsupported. The release
/// path no longer produces or inspects qualifiers at all.
static RE_UNVERIFIED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)unverified").unwrap());

fn marker_ids(s: &str) -> Vec<String> {
    RE_MARKER
        .captures_iter(s)
        .map(|c| format!("S{}", &c[1]))
        .collect()
}

/// Audit one research answer against the turn's SERVER-MINTED citations and
/// the ledger's retrieval outcome (⇔ TS `auditResearchAnswer`). Pure and
/// deterministic; idempotent on its own output.
///
/// `retrieved` is computed by the CALLER from server state (citation map /
/// action ledger) — never from model prose.
pub fn audit_research_answer(text: &str, citations: &HashSet<String>, retrieved: bool) -> String {
    let repaired = audit_prose(text, citations);
    // R3: the ledger decides, not the prose. Only when the server knows the
    // turn retrieved NOTHING does research-claiming wording get flagged.
    let no_sources = citations.is_empty() && !retrieved;
    if no_sources
        && RE_RESEARCH_WORDING.is_match(&repaired)
        && !repaired.starts_with(SERVER_CHECK_LINE)
    {
        return format!("{SERVER_CHECK_LINE}\n{repaired}");
    }
    repaired
}

/* ── segmentation: fenced blocks and inline code are byte-protected ───── */

fn audit_prose(text: &str, ids: &HashSet<String>) -> String {
    let mut parts: Vec<String> = Vec::new();
    segments(text, 0, ids, &mut parts);
    parts.concat()
}

fn segments(s: &str, depth: u8, ids: &HashSet<String>, parts: &mut Vec<String>) {
    if s.is_empty() {
        return;
    }
    if depth == 0 {
        if let Some(at) = s.find("```") {
            segments(&s[..at], 1, ids, parts);
            let end = match s[at + 3..].find("```") {
                Some(close) => at + 3 + close + 3,
                None => s.len(),
            };
            parts.push(s[at..end].to_string()); // fence: verbatim
            segments(&s[end..], 0, ids, parts);
            return;
        }
    }
    if depth <= 1 {
        if let Some(at) = s.find('`') {
            let close = s[at + 1..].find('`').map(|c| at + 1 + c);
            let nl = s[at + 1..].find('\n').map(|n| at + 1 + n);
            if let Some(close) = close {
                if nl.map_or(true, |n| close < n) {
                    segments(&s[..at], 2, ids, parts);
                    parts.push(s[at..=close].to_string()); // inline code: verbatim
                    segments(&s[close + 1..], 1, ids, parts);
                    return;
                }
            }
        }
    }
    parts.push(audit_sentences(s, ids));
}

/// Split prose into lines, then sentences; audit each sentence. Newlines are
/// hard sentence boundaries (markdown lists must not merge lines and lose
/// the citation check — the WS06 matrix pins this). Separators are kept as
/// list elements at odd indices so every byte survives the rejoin
/// (⇔ the TS captured-group splits).
fn audit_sentences(prose: &str, ids: &HashSet<String>) -> String {
    let mut lines: Vec<String> = Vec::new();
    for (idx, part) in prose.split('\n').enumerate() {
        if idx > 0 {
            lines.push("\n".to_string());
        }
        lines.push(part.to_string());
    }
    for i in (0..lines.len()).step_by(2) {
        let mut pieces = split_sentences(&lines[i]);
        for j in (0..pieces.len()).step_by(2) {
            pieces[j] = audit_sentence(&pieces[j], ids);
        }
        lines[i] = pieces.concat();
    }
    lines.concat()
}

/// ⇔ TS `split(/((?<=[.!?])\s+)/)`: a boundary is a run of whitespace that
/// directly follows [.!?]; pieces alternate sentence / separator (odd =
/// separator), so `pieces.concat()` reproduces the input byte-for-byte.
fn split_sentences(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace()
            && matches!(cur.chars().next_back(), Some('.' | '!' | '?'))
        {
            out.push(std::mem::take(&mut cur));
            let start = i;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            out.push(chars[start..i].iter().collect());
            continue;
        }
        cur.push(c);
        i += 1;
    }
    out.push(cur);
    out
}

/// MHR-F (WS26): INTEGRITY ONLY (⇔ TS `auditSentence`). A marker that
/// resolves to a minted source is left byte-intact (never removed, however
/// the sentence reads); a marker that resolves to NOTHING is a broken
/// reference and its bytes are stripped. Nothing else on the sentence
/// changes — semantic support is the model's job via the diagnosis→
/// feedback channel, and volatile-claim qualification is exactly the
/// semantic patching the harness may not do.
fn audit_sentence(sentence: &str, ids: &HashSet<String>) -> String {
    if sentence.is_empty() || !sentence.chars().any(|c| !c.is_whitespace()) {
        return sentence.to_string();
    }
    let marker_ids = marker_ids(sentence);
    if marker_ids.is_empty() {
        return sentence.to_string(); // no references — nothing the integrity layer owns
    }
    let invalid = marker_ids.iter().any(|id| !ids.contains(id));
    if !invalid {
        return sentence.to_string(); // every reference resolves — release verbatim
    }
    let mut out = RE_MARKER
        .replace_all(sentence, |caps: &regex::Captures| {
            if ids.contains(&format!("S{}", &caps[1])) {
                caps[0].to_string()
            } else {
                String::new()
            }
        })
        .to_string();
    // Residue cleanup only where a marker was removed.
    out = RE_DOUBLE_SPACE.replace_all(&out, " ").to_string();
    out = RE_PUNCT_SPACE.replace_all(&out, "$1").to_string();
    out
}

/* ══ MHR-D: non-destructive diagnosis (same detectors, report-only) ════
 * ⇔ TS `diagnoseResearchAnswer / answerFeedbackNeeded / buildAnswerFeedback`
 * in lib/chat/answer-release.ts. The loop may not "repair" the model's
 * words into semantic correctness — that is the model's job. The harness
 * reports the ACTUAL server state truthfully and ONCE (fabricated markers,
 * sentences resolving to no minted source — quoted VERBATIM, research
 * wording without retrieval), holds the diagnosed-bad answer back, and
 * injects ONE byte-locked feedback message into the EXISTING tool loop;
 * the model decides the next action (retrieve / re-attach / state the gap).
 * Rewrites nothing; since MHR-F (WS26) the release audit enforces CITATION
 * INTEGRITY only, and this diagnosis→feedback channel is the SOLE route
 * for semantic support.
 */

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Diagnosis {
    pub unresolved: Vec<String>,
    pub available: Vec<String>,
    pub unsupported: Vec<String>,
    #[serde(rename = "claimsResearch")]
    pub claims_research: bool,
}

fn num_suffix(id: &str) -> u64 {
    id.get(1..).and_then(|s| s.parse().ok()).unwrap_or(u64::MAX)
}

pub fn diagnose_research_answer(text: &str, ids: &HashSet<String>, retrieved: bool) -> Diagnosis {
    let mut unresolved: Vec<String> = Vec::new();
    let mut unsupported: Vec<String> = Vec::new();
    for sentence in diagnose_prose(text) {
        let marker_ids = marker_ids(&sentence);
        for m in &marker_ids {
            if !ids.contains(m) && !unresolved.contains(m) {
                unresolved.push(m.clone()); // dedup; sorted numerically below
            }
        }
        if marker_ids.is_empty() && !sentence.bytes().any(|b| b.is_ascii_digit()) {
            continue;
        }
        // stillValid law identical to the audit: one resolvable marker means
        // the sentence IS sourced — dangling extras ride under `unresolved`.
        if marker_ids.iter().any(|id| ids.contains(id)) {
            continue;
        }
        let misattributed = marker_ids.iter().any(|id| !ids.contains(id));
        let digit = sentence.bytes().any(|b| b.is_ascii_digit());
        let volatile = digit && VOLATILE.iter().any(|re| re.is_match(&sentence));
        if (misattributed || volatile) && !RE_UNVERIFIED.is_match(&sentence) {
            unsupported.push(sentence); // VERBATIM — report, never rewrite
        }
    }
    unresolved.sort_by_key(|id| num_suffix(id));
    let mut available: Vec<String> = ids.iter().cloned().collect();
    available.sort_by_key(|id| num_suffix(id));
    Diagnosis {
        unresolved,
        available,
        unsupported,
        claims_research: ids.is_empty() && !retrieved && RE_RESEARCH_WORDING.is_match(text),
    }
}

/// Same segmentation law as the audit: fenced blocks and inline code
/// contribute NOTHING — no markers, no sentences from code bytes. Only the
/// prose units are COLLECTED (never rejoined — diagnosis rewrites nothing).
fn diagnose_prose(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    diagnose_segments(text, 0, &mut out);
    out
}

fn diagnose_segments(s: &str, depth: u8, out: &mut Vec<String>) {
    if s.is_empty() {
        return;
    }
    if depth == 0 {
        if let Some(at) = s.find("```") {
            diagnose_segments(&s[..at], 1, out);
            let end = match s[at + 3..].find("```") {
                Some(close) => at + 3 + close + 3,
                None => s.len(),
            };
            diagnose_segments(&s[end..], 0, out); // fence: invisible
            return;
        }
    }
    if depth <= 1 {
        if let Some(at) = s.find('`') {
            let close = s[at + 1..].find('`').map(|c| at + 1 + c);
            let nl = s[at + 1..].find('\n').map(|n| at + 1 + n);
            if let Some(close) = close {
                if nl.map_or(true, |n| close < n) {
                    diagnose_segments(&s[..at], 2, out);
                    diagnose_segments(&s[close + 1..], 1, out); // inline code: invisible
                    return;
                }
            }
        }
    }
    out.extend(sentences_of(s));
}

/// Lines, then sentences (same splits as audit_sentences/split_sentences),
/// non-blank units only.
fn sentences_of(prose: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in prose.split('\n') {
        let pieces = split_sentences(line);
        for i in (0..pieces.len()).step_by(2) {
            if !pieces[i].is_empty() && pieces[i].chars().any(|c| !c.is_whitespace()) {
                out.push(pieces[i].clone());
            }
        }
    }
    out
}

pub fn answer_issues(d: &Diagnosis) -> bool {
    !d.unresolved.is_empty() || !d.unsupported.is_empty() || d.claims_research
}

/// ⇔ TS FEEDBACK_HEADER/FEEDBACK_FOOTER — the bytes live INSIDE the message
/// the model reads; the matrix mhrD `feedback` fields pin the full render.
const FEEDBACK_HEADER: &str = "[Harness feedback] Your answer text was held back and NOT released to the human. Actual server state this turn:";
const FEEDBACK_FOOTER: &str = "Decide the next action yourself: run web_search/read_page to retrieve the missing facts, re-attach your claims to the minted [S#] source ids, or state plainly which requested facts could not be verified. Never repeat the held text unchanged.";

pub fn build_answer_feedback(d: &Diagnosis) -> String {
    let mut lines: Vec<String> = Vec::new();
    if !d.unresolved.is_empty() {
        let marks: Vec<String> = d.unresolved.iter().map(|id| format!("[{id}]")).collect();
        let avail = if d.available.is_empty() {
            "none".to_string()
        } else {
            d.available.join(", ")
        };
        lines.push(format!(
            "- Citation marker(s) {} do not exist. Sources minted this turn: {avail}.",
            marks.join(", ")
        ));
    }
    if !d.unsupported.is_empty() {
        let quoted: Vec<String> = d.unsupported.iter().map(|s| format!("\"{s}\"")).collect();
        lines.push(format!("- Unsupported claim sentence(s): {}", quoted.join(", ")));
    }
    if d.claims_research {
        lines.push("- The text claims web research, but no retrieval succeeded this turn.".to_string());
    }
    format!("{FEEDBACK_HEADER}\n{}\n{FEEDBACK_FOOTER}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ONE vendored truth matrix — the same bytes the TS suite reads
    /// (`__tests__/chat/answer-release.test.ts`). Cross-language drift in
    /// either direction goes red here with identical inputs.
    const MATRIX_JSON: &str = include_str!("../../../../fixtures/answer-release/matrix.json");

    struct Case {
        name: String,
        text: String,
        citations: HashSet<String>,
        retrieved: bool,
        expected: String,
    }

    fn matrix() -> (String, Vec<Case>) {
        let v: serde_json::Value =
            serde_json::from_str(MATRIX_JSON).expect("matrix.json parses");
        let line = v["serverCheckLine"].as_str().expect("serverCheckLine").to_string();
        let cases = v["cases"]
            .as_array()
            .expect("cases array")
            .iter()
            .map(|c| Case {
                name: c["name"].as_str().unwrap_or("").to_string(),
                text: c["text"].as_str().unwrap_or("").to_string(),
                citations: c["citations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap().to_string())
                    .collect::<Vec<_>>()
                    .into_iter()
                    .collect(),
                retrieved: c["retrieved"].as_bool().unwrap(),
                expected: c["expected"].as_str().unwrap().to_string(),
            })
            .collect();
        (line, cases)
    }

    #[test]
    fn matrix_is_present_and_the_server_check_line_is_byte_locked() {
        let (line, cases) = matrix();
        assert!(cases.len() >= 15, "the matrix must stay non-trivial");
        assert_eq!(SERVER_CHECK_LINE, line.as_str());
    }

    #[test]
    fn every_matrix_case_repairs_identically_to_ts() {
        let (_line, cases) = matrix();
        for c in &cases {
            let got = audit_research_answer(&c.text, &c.citations, c.retrieved);
            assert_eq!(got, c.expected, "matrix case: {}", c.name);
        }
    }

    #[test]
    fn the_audit_is_idempotent_released_text_never_accumulates_qualifiers() {
        let (_line, cases) = matrix();
        for c in &cases {
            let once = audit_research_answer(&c.text, &c.citations, c.retrieved);
            let twice = audit_research_answer(&once, &c.citations, c.retrieved);
            assert_eq!(twice, once, "idempotency broken on case: {}", c.name);
        }
    }

    #[test]
    fn the_server_check_line_appears_at_most_once_and_only_at_the_start() {
        let mut out = audit_research_answer(
            "According to my searches, X leads. As my research shows, X is the best.",
            &HashSet::new(),
            false,
        );
        assert_eq!(out.matches(SERVER_CHECK_LINE).count(), 1);
        assert!(out.starts_with(&format!("{SERVER_CHECK_LINE}\n")));
        // Second audit pass keeps it singular (idempotency guard).
        out = audit_research_answer(&out, &HashSet::new(), false);
        assert_eq!(out.matches(SERVER_CHECK_LINE).count(), 1);
    }

    #[test]
    fn positive_control_a_fabricated_invalid_citation_cannot_pass() {
        let ids: HashSet<String> = ["S1".to_string()].into_iter().collect();
        assert_eq!(
            audit_research_answer("Boreal costs $99 [S1].", &ids, true),
            "Boreal costs $99 [S1]."
        );
        // MHR-F: the broken REFERENCE is stripped (integrity); the words
        // are never qualified (semantics is the model's job via feedback).
        assert_eq!(
            audit_research_answer("Boreal costs $99 [S9].", &ids, true),
            "Boreal costs $99."
        );
    }

    #[test]
    fn no_retrieval_and_no_citation_map_only_research_wording_is_flagged() {
        assert_eq!(
            audit_research_answer("The weather is nice.", &HashSet::new(), false),
            "The weather is nice."
        );
    }

    /* ── MHR-D: the vendored mhrD diagnose cases ══════════════════════
     * Same matrix, same fictional entities — diagnosis byte-parity with
     * TS `__tests__/chat/answer-release.test.ts`. Held-answer feedback is
     * the model-facing contract: byte-exact or the promise is a lie.
     */

    struct MhrCase {
        name: String,
        text: String,
        citations: HashSet<String>,
        retrieved: bool,
        expected: Diagnosis,
        feedback: String,
    }

    fn mhr_matrix() -> Vec<MhrCase> {
        let v: serde_json::Value =
            serde_json::from_str(MATRIX_JSON).expect("matrix.json parses");
        v["mhrD"]["diagnoseCases"]
            .as_array()
            .expect("mhrD.diagnoseCases array")
            .iter()
            .map(|c| MhrCase {
                name: c["name"].as_str().unwrap_or("").to_string(),
                text: c["text"].as_str().unwrap_or("").to_string(),
                citations: c["citations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap().to_string())
                    .collect(),
                retrieved: c["retrieved"].as_bool().unwrap(),
                expected: serde_json::from_value(c["expected"].clone())
                    .expect("expected matches Diagnosis shape"),
                feedback: c["feedback"].as_str().unwrap_or("").to_string(),
            })
            .collect()
    }

    #[test]
    fn the_mhrd_matrix_section_is_present() {
        let cases = mhr_matrix();
        assert!(cases.len() >= 8, "mhrD must vend ≥8 diagnose cases");
    }

    #[test]
    fn every_mhrd_case_diagnoses_identically_to_ts() {
        for c in &mhr_matrix() {
            let d = diagnose_research_answer(&c.text, &c.citations, c.retrieved);
            assert_eq!(d, c.expected, "mhrD case: {}", c.name);
            assert_eq!(
                answer_issues(&d),
                !c.feedback.is_empty(),
                "feedback gate on case: {}",
                c.name
            );
            if !c.feedback.is_empty() {
                assert_eq!(
                    build_answer_feedback(&d),
                    c.feedback,
                    "feedback bytes on case: {}",
                    c.name
                );
            }
        }
    }

    #[test]
    fn mhrd_diagnosis_is_non_destructive_a_clean_answer_stays_silent() {
        // The report quotes VERBATIM — never the retired "(unverified)"
        // rewrite (MHR-F) — and a clean fully-cited answer fires
        // nothing at all (the feedback round must not haunt good turns).
        let ids: HashSet<String> = ["S1".to_string()].into_iter().collect();
        let d = diagnose_research_answer("Boreal costs $99 [S9] per seat.", &ids, true);
        assert_eq!(
            d.unsupported,
            vec!["Boreal costs $99 [S9] per seat.".to_string()]
        );
        assert!(!d.unsupported[0].contains("(unverified)"));
        assert_eq!(d.unresolved, vec!["S9".to_string()]);

        let clean = diagnose_research_answer("Boreal costs $99 [S1] per seat.", &ids, true);
        assert!(!answer_issues(&clean));
    }

    /* ── MHR-F (WS26, 2026-11-06): integrity/semantics separation ══════
     * Same matrix as the TS "MHR-F" describes: the release audit enforces
     * CITATION INTEGRITY only (a [S#] marker resolving to no minted source
     * is stripped; semantics are NEVER rewritten; a minted citation is
     * never removed), while the diagnosis reports the full semantic state
     * byte-exactly through the mhrD feedback contract.
     */

    struct FReleaseCase {
        name: String,
        text: String,
        citations: HashSet<String>,
        retrieved: bool,
        expected: String,
    }

    struct FSepCase {
        name: String,
        text: String,
        citations: HashSet<String>,
        retrieved: bool,
        expected_release: String,
        expected_diagnosis: Diagnosis,
        feedback: String,
    }

    fn cited(c: &serde_json::Value) -> HashSet<String> {
        c["citations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect()
    }

    fn mhrf_release_matrix() -> Vec<FReleaseCase> {
        let v: serde_json::Value =
            serde_json::from_str(MATRIX_JSON).expect("matrix.json parses");
        v["mhrF"]["releaseCases"]
            .as_array()
            .expect("mhrF.releaseCases array")
            .iter()
            .map(|c| FReleaseCase {
                name: c["name"].as_str().unwrap_or("").to_string(),
                text: c["text"].as_str().unwrap_or("").to_string(),
                citations: cited(c),
                retrieved: c["retrieved"].as_bool().unwrap(),
                expected: c["expected"].as_str().unwrap().to_string(),
            })
            .collect()
    }

    fn mhrf_sep_matrix() -> Vec<FSepCase> {
        let v: serde_json::Value =
            serde_json::from_str(MATRIX_JSON).expect("matrix.json parses");
        v["mhrF"]["separationCases"]
            .as_array()
            .expect("mhrF.separationCases array")
            .iter()
            .map(|c| FSepCase {
                name: c["name"].as_str().unwrap_or("").to_string(),
                text: c["text"].as_str().unwrap_or("").to_string(),
                citations: cited(c),
                retrieved: c["retrieved"].as_bool().unwrap(),
                expected_release: c["expectedRelease"].as_str().unwrap().to_string(),
                expected_diagnosis: serde_json::from_value(c["expectedDiagnosis"].clone())
                    .expect("expectedDiagnosis matches Diagnosis shape"),
                feedback: c["feedback"].as_str().unwrap_or("").to_string(),
            })
            .collect()
    }

    #[test]
    fn the_mhrf_matrix_section_is_present() {
        let r = mhrf_release_matrix();
        assert!(r.len() >= 5, "mhrF must vend ≥5 releaseCases");
        let s = mhrf_sep_matrix();
        assert!(s.len() >= 3, "mhrF must vend ≥3 separationCases");
    }

    #[test]
    fn every_mhrf_release_case_releases_integrity_only() {
        for c in &mhrf_release_matrix() {
            let got = audit_research_answer(&c.text, &c.citations, c.retrieved);
            assert_eq!(got, c.expected, "mhrF release case: {}", c.name);
            let twice = audit_research_answer(&got, &c.citations, c.retrieved);
            assert_eq!(twice, got, "idempotency broken on mhrF case: {}", c.name);
        }
    }

    #[test]
    fn every_mhrf_separation_case_releases_integrity_and_reports_semantics() {
        for c in &mhrf_sep_matrix() {
            assert_eq!(
                audit_research_answer(&c.text, &c.citations, c.retrieved),
                c.expected_release,
                "mhrF separation release on case: {}",
                c.name
            );
            let d = diagnose_research_answer(&c.text, &c.citations, c.retrieved);
            assert_eq!(
                d, c.expected_diagnosis,
                "mhrF separation diagnosis on case: {}",
                c.name
            );
            assert_eq!(
                answer_issues(&d),
                !c.feedback.is_empty(),
                "feedback gate on mhrF case: {}",
                c.name
            );
            if !c.feedback.is_empty() {
                assert_eq!(
                    build_answer_feedback(&d),
                    c.feedback,
                    "feedback bytes on mhrF case: {}",
                    c.name
                );
            }
        }
    }

    #[test]
    fn mhrf_never_removes_a_minted_citation() {
        // Anti-silent-removal law: every resolvable [S#] stays byte-intact
        // even when an adjacent marker in the same sentence is fabricated.
        let ids: HashSet<String> = ["S1".to_string(), "S2".to_string()].into_iter().collect();
        let out = audit_research_answer("Mixed [S1] real and [S9] fake in one [S2].", &ids, true);
        assert!(out.contains("[S1]") && out.contains("[S2]"));
        assert!(!out.contains("[S9]"));
    }
}
