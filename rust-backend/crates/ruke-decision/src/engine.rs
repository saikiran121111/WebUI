//! Intent detection + envelope construction — oracle:
//! `lib/decision/client.ts` (`getDecisionSync` path, which is ALL the live
//! TS route ever calls; the async/worker paths there are inert shims).
//!
//! §4a INTENT LAW (2026-11-13 brief) — mirrored EXACTLY by the TS:
//! an artifact WORD is not an artifact REQUEST. Bare noun mentions ("What
//! is a PDF?", "Explain a deck of cards.") no longer route; an artifact
//! word counts only when a production cue binds to it in the same clause
//! (a dot between two alphanumerics — "file.docx", "2.5" — is masked to a
//! space first so filenames/versions/decimals never sever a clause, §5);
//! negation vetoes it; a convert/export cue governs the word directly as
//! the SOURCE format (the word after a to/into/as direction word is the
//! requested output); quoted/code spans are masked before scanning; and
//! Every requested deliverable is recorded (F02, 2026-11-16): the scan returns
//! ZERO, ONE or SEVERAL intents. One -> that mode; several -> standard_chat
//! plus a typed task_constraints list naming EACH request (no arbitrary winner,
//! no silently dropped deliverable); zero -> standard_chat. Confidence is honest:
//! 0.8 single verb-bound intent, 0.5 for a miss or a multi-deliverable turn (the
//! old blanket 1.0 was false certainty).
//!
//! REGEX PARITY with the TS (§6: the old ASCII-\b quirks are RETIRED
//! legacy defects, not contracts):
//! - No lookaround on either side (the regex crate forbids it); identical
//!   CONSUMING Unicode word classes `(?:^|[^\p{L}\p{N}_])` /
//!   `(?:[^\p{L}\p{N}_]|$)` on BOTH sides — JS with the /u flag, Rust
//!   natively. Consuming the boundary chars is safe ONLY because match
//!   positions are compared by MATCH-START ORDER — never end-vs-start
//!   across different matches (adjacent matches SHARE their boundary
//!   char: WB_R of the cue == WB_L of the next word, making end-vs-start
//!   off-by-one against directly adjacent pairs like "export as xlsx" or
//!   "make deck"), never by distance or equality (JS UTF-16 indices vs
//!   Rust byte indices advance monotonically with text position, and the
//!   space filler for quoted spans can differ in length without
//!   reordering anything after it).
//! - The `résumé` consuming-tail branch (which made "caféexcel" match on
//!   the ASCII-\b é quirk and bare "résumé" miss while "résumé2" matched)
//!   is retired: é is \p{L}, so "caféexcel"/"résumébuilder" no longer
//!   split, and bare "résumé" finally matches its own word.
//! - Alternation order is written identically in both engines so
//!   leftmost-first matching picks the same branch (e.g. "cannot" before
//!   the "no" branch inside NEGATION).
//!
//! `3d_asset`/`cad_blueprint` retired 2026-11-06 (Ruke plan Phase 4) and
//! `anatomy` 2026-11-07 (user directive): their matchers no longer exist,
//! so old prompts ("render a 3d scene", "floor plan", "cutaway of the
//! marine engine") fall to `standard_chat` unless a §4a-verb-bound
//! deliverable request survives in the clause.

use std::sync::LazyLock;
use std::time::Instant;

use regex::{Captures, Regex};
use serde_json::Value;

use ruke_contracts::decision::{mode_skill, DecisionEnvelope, RendererMode};
use ruke_skills::jsstr::js_trim;

/// Unicode word classes shared by every matcher (mirrors the TS `WB_L` /
/// `WB_R` constants; `String.raw` there, raw strings here).
// §6 generalization: \p{M} joins the class. Indic/Thai words routinely END
// in combining marks (vowel signs, virama), so without \p{M} the end of
// those words looked like a boundary and cues fired through glue that Latin
// script would block — failing to generalize for exactly the held-out
// scripts. Mirrors the TS `client.ts` constants after the same change.
const WB_L: &str = r"(?:^|[^\p{L}\p{N}\p{M}_])";
const WB_R: &str = r"(?:[^\p{L}\p{N}\p{M}_]|$)";

fn word_re(body: &str) -> Regex {
    Regex::new(&format!("(?i){WB_L}(?:{body}){WB_R}")).unwrap()
}

/// Artifact WORD inventory — presence proves nothing; the cue/negation/
/// direction/meta scan below decides whether the word is REQUESTED.
static EXCEL_RE: LazyLock<Regex> =
    LazyLock::new(|| word_re("spreadsheet|excel|[.]xlsx|workbook|xlsx"));
static DOCS_RE: LazyLock<Regex> =
    LazyLock::new(|| word_re("word ?document|[.]docx|docx|resume|résumé|cv"));
static PDF_RE: LazyLock<Regex> = LazyLock::new(|| word_re("pdf"));
static PPT_RE: LazyLock<Regex> =
    LazyLock::new(|| word_re("power ?point|presentation|[.]pptx|pptx|deck"));
static CHART_RE: LazyLock<Regex> = LazyLock::new(|| word_re("chart"));
static HTML_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re("web ?page|landing ?page|html|interactive (?:ui|page|demo|prototype)")
});

/// Quoted speech, typographic quotes, guillemets, inline code: masking a
/// span with spaces means explaining a phrase never counts as requesting
/// it (and a period inside a quote can never corrupt a clause split).
static QUOTED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""[^"]*"|“[^”]*”|«[^»]*»|`[^`]*`"#).unwrap()
});
/// Alnum-dot-alnum (file.docx, v2.5): a filename/version/decimal, never a
/// sentence boundary — the dot becomes a space so the clause split keeps
/// the phrase together (mirrors the TS INNER_DOT_RE; the regex crate is
/// Unicode-by-default, no /u flag needed).
static INNER_DOT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([\p{L}\p{N}])\.([\p{L}\p{N}])").unwrap());
static CLAUSE_SPAN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.!?\n;]+").unwrap());

/* F02 relations (2026-11-16): the artifact relation is TYPED -----------
 * A production cue plus an artifact word is not yet a deliverable REQUEST:
 * the word also has a ROLE (destination / source / container / discussed
 * subject / reported-past object) and the clause has a FRAME (didactic vs
 * transactional). These matchers name those roles; none is keyed to a
 * specific example, domain, format name or user phrase. Mirrored EXACTLY by
 * lib/decision/client.ts (same alternation ORDER, consuming Unicode word
 * classes, no lookaround).                                              */

/// Phrase boundary INSIDE a clause: a negation or a reported action governs
/// its own phrase, never a request starting after the boundary. The em/en
/// dash classes are written as code-point escapes so this source stays
/// ASCII-only; the COMPILED pattern is identical to the TS literal (the
/// parity guard test below proves it).
static SEGMENT_SPLIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[,;:\x{2014}\x{2013}()\n]+").unwrap());

static CREATE_CUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "create|creates|created|creating|make|makes|making|build|builds|building|\
         rebuild|rebuilds|rebuilt|rebuilding|redraft|redrafts|redrafted|redrafting|\
         revise|revises|revised|revising|rework|reworks|reworked|reworking|\
         reformat|reformats|reformatted|reformatting|\
         generat(?:e|es|ed|ing)|produc(?:e|es|ed|ing)|prepar(?:e|es|ed|ing)|\
         writ(?:e|es|ing)|draft|drafts|drafted|drafting|design|designs|designed|designing|\
         assemble|assembles|assembled|assembling|give me|gave me|get me|got me|\
         send me|sending me|sent me|need|needs|needed|want|wants|wanted|put together|\
         would like|d like",
    )
});
static TRANSFORM_CUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "convert|converts|converted|converting|turn into|turns into|turned into|\
         change into|changes into|changed into|translate into|translates into|translated into|\
         export|exports|exported|exporting|save|saves|saved|saving|put into|puts into|putting into",
    )
});
static DIRECTION_RE: LazyLock<Regex> = LazyLock::new(|| word_re("to|into|as"));
static NEGATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "not|never|cannot|can'?t|cant|won'?t|wont|don'?t|dont|isn'?t|isnt|aren'?t|arent|wasn'?t|wasnt|\
         without|avoid|avoids|avoided|avoiding|skip|skips|skipped|exclude|excludes|excluded|excluding|no",
    )
});
static META_PHRASE_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "summary|summaries|synopsis|abstract|overview|outline|about|regarding|\
         description|descriptions|analysis|analyses|explanation|explanations",
    )
});

/// Didactic frame: the turn explains HOW something is produced, or names the
/// artifact as the SUBJECT being explained. Only fires when the marker sits
/// between (or before) the production cue and the artifact word.
static DIDACTIC_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "explain|explains|explained|explaining|teach|teaches|teaching|taught|\
         tutorial|tutorials|lesson|lessons|walkthrough|walk me through|learn how|\
         how to|how do|how does|how can|how could|how would|how should|steps to|\
         step-by-step|guide to|introduction to|demonstrate|demonstrates|demonstrating|\
         understand|understands|understood|understanding|comprehend|comprehends|comprehended|comprehending|\
         know|knows|knowing|realize|realizes|realized|realizing",
    )
});
/// Past-tense production verbs -- a REPORTED action on an existing file.
static PAST_PRODUCTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "made|created|built|wrote|generated|produced|prepared|exported|saved|converted|\
         drafted|designed|assembled|gave|sent|rebuilt|revised|printed|shared|delivered|submitted",
    )
});
/// Explicit agents: a reported action needs one; a bare imperative never does.
static SUBJECT_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "i|we|they|he|she|you|someone|somebody|anyone|anybody|everybody|team|company|\
         department|client|colleague|coworker|boss|manager|group|office|classmate|friend",
    )
});
/// Politeness/desire markers: "I wanted a PDF" IS a request, so the
/// reported-past law must not fire. Scoped to the reported action's phrase.
static DESIRE_MODAL_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "want|wants|wanted|wanting|need|needs|needed|needing|like|likes|liked|would|could|\
         should|please|kindly|hope|hoped|hoping|wish|wished|request|requesting|\
         can you|could you|would you|will you",
    )
});
/// Source-role markers: the artifact word after one is the MATERIAL, not the ask.
static SOURCE_ROLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "from|based on|out of|starting from|extracted from|derived from|imported from|\
         scanned from|copied from|copy of|instead of|taken from|read from",
    )
});
/// Container markers naming the FORMAT as the container of the deliverable
/// ("summary IN PDF", "output AS a pptx"). Longest-first alternation: the
/// consuming word classes would otherwise stop inside "into"/"formats".
static CONTAINER_PREP_RE: LazyLock<Regex> =
    LazyLock::new(|| word_re("into|in|as|to|formats|format|outputs|output|extensions|extension|forms|form"));
/// Only articles/quantifiers may sit between a container marker and the format.
static FILLER_BETWEEN_RE: LazyLock<Regex> = LazyLock::new(||
    Regex::new(r"(?i)^\s*(?:(?:a|an|the|this|that|these|those|my|your|our|their|his|her|its|one|two|new|single|separate|each|another|clean|blank)\s*)*$").unwrap());
/// Metalinguistic mention: a quoted format NAME inside such a clause is a
/// label being discussed, never the requested deliverable.
static META_LINGUISTIC_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "term|terms|phrase|phrases|expression|expressions|means|meaning|called|named|syntax|\
         says|said|quote|quoted|quoting|definition|literally|refers to|referred to|spelling",
    )
});
/// Partitive complement right after a polysemous lexeme ("deck OF cards").
static PARTITIVE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*of\s+(?:the\s+|a\s+|an\s+)?([\p{L}][\p{L}']*)").unwrap());

/// Anchored form of the SAME body: "is the whole token this word set?"
/// (partitive complements, quoted bare format labels).
fn anchored_re(body: &str) -> Regex {
    Regex::new(&format!("(?i)^(?:{body})$")).unwrap()
}

/// Derive the anchored (whole-token) form of a `word_re` matcher from its own
/// compiled pattern text, so the word form and the bare form can NEVER drift
/// apart (they are the same body by construction, accents included).
fn anchored_form(word: &Regex) -> Regex {
    let pattern = word.as_str();
    let body = pattern
        .strip_prefix("(?i)")
        .and_then(|p| p.strip_prefix(WB_L))
        .and_then(|p| p.strip_suffix(WB_R))
        .and_then(|p| p.strip_prefix("(?:"))
        .and_then(|p| p.strip_suffix(")"))
        .unwrap_or_else(|| panic!("anchored_form: unexpected word_re pattern shape: {pattern}"));
    anchored_re(body)
}

/// A QUOTED span counts as a deliverable label only when its whole content is
/// one bare artifact word ('create a "PDF"').
static EXCEL_BARE_RE: LazyLock<Regex> = LazyLock::new(|| anchored_form(&EXCEL_RE));
static DOCS_BARE_RE: LazyLock<Regex> = LazyLock::new(|| anchored_form(&DOCS_RE));
static PDF_BARE_RE: LazyLock<Regex> = LazyLock::new(|| anchored_form(&PDF_RE));
static PPT_BARE_RE: LazyLock<Regex> = LazyLock::new(|| anchored_form(&PPT_RE));
static CHART_BARE_RE: LazyLock<Regex> = LazyLock::new(|| anchored_form(&CHART_RE));
static HTML_BARE_RE: LazyLock<Regex> = LazyLock::new(|| anchored_form(&HTML_RE));

/// Weak-sense table (F02 rule 6): a lexeme with a strong non-document sense
/// routes only when its own domain is in reach. "deck" is the documented
/// case (card deck / garden deck); adding an entry is a general sense table,
/// never an example-specific rule.
static DECK_LEXEME_RE: LazyLock<Regex> = LazyLock::new(|| word_re("deck"));
static DECK_CORROBORATED_RE: LazyLock<Regex> = LazyLock::new(|| {
    anchored_re("slides|slide|presentation|power ?point|pptx|lecture|talk|pitch")
});
static DECK_SENSE_FRAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "card|cards|poker|solitaire|patio|porch|garden|backyard|balcony|roof|decking|wood|\
         carpenter|carpentry|stairs|staircase|stair|railing|fence|terrace|veranda|outdoor|\
         furniture|sofa|chair",
    )
});

fn weak_sense(
    mode: RendererMode,
) -> Option<(&'static Regex, &'static Regex, &'static Regex)> {
    match mode {
        RendererMode::Ppt => Some((
            &*DECK_LEXEME_RE,
            &*DECK_CORROBORATED_RE,
            &*DECK_SENSE_FRAME_RE,
        )),
        _ => None,
    }
}

/// Match positions. BOTH ends are recorded: the relation-vs-role relations compare
/// matches by START ORDER across different regexes, while the same-engine
/// gap checks (containerNamed / weakSenseSuppressed) slice the text BETWEEN
/// two matches, which needs each match's end.
#[derive(Clone, Copy)]
struct At {
    start: usize,
    end: usize,
}

fn positions(re: &Regex, s: &str) -> Vec<At> {
    re.find_iter(s)
        .map(|m| At {
            start: m.start(),
            end: m.end(),
        })
        .collect()
}

#[derive(Clone, Copy)]
struct Span {
    start: usize,
    end: usize,
}

/// Clause/phrase split that KEEPS offsets (F02 needs segment membership, not
/// just clause text): the text between separator matches, as [start,end).
fn spans(text: &str, sep: &Regex) -> Vec<Span> {
    let mut out = Vec::new();
    let mut from = 0usize;
    for m in sep.find_iter(text) {
        let at = m.start();
        if at > from {
            out.push(Span {
                start: from,
                end: at,
            });
        }
        from = at + m.as_str().len();
    }
    if from < text.len() {
        out.push(Span {
            start: from,
            end: text.len(),
        });
    }
    out
}

/// Quote masking with ONE documented exception (F02 rule 7 -- label vs
/// mention): a quoted span whose WHOLE content is a bare artifact word inside
/// an explicit production request ('create a "PDF"' / 'make an "xlsx"')
/// labels the deliverable and stays live; a quoted INSTRUCTION ('he said
/// "create a PDF"') or a metalinguistic mention ('the term "presentation"')
/// stays masked. The quote characters become spaces, so no offset downstream
/// moves except by a constant filler length (JS UTF-16 units vs Rust bytes --
/// the exception branch trims a constant number of bytes for multi-byte
/// quote characters; ORDER of every later match is unaffected).
fn mask_quoted(text: &str) -> String {
    // regex 1.13's Replacer-closure form takes &Captures; QUOTED_RE has no
    // capture groups, so get(0) is always the whole quoted span.
    let all_masked = QUOTED_RE
        .replace_all(text, |c: &Captures| " ".repeat(c.get(0).map_or(0, |m| m.len())))
        .into_owned();
    let cue_outside = !positions(&CREATE_CUE_RE, &all_masked).is_empty()
        || !positions(&TRANSFORM_CUE_RE, &all_masked).is_empty();
    let metalinguistic = !positions(&META_LINGUISTIC_RE, &all_masked).is_empty();
    let bare_forms = [
        &*EXCEL_BARE_RE,
        &*DOCS_BARE_RE,
        &*PDF_BARE_RE,
        &*PPT_BARE_RE,
        &*CHART_BARE_RE,
        &*HTML_BARE_RE,
    ];
    let mut out = String::with_capacity(text.len());
    let mut from = 0usize;
    for m in QUOTED_RE.find_iter(text) {
        out.push_str(&text[from..m.start()]);
        let span = m.as_str();
        let chars: Vec<char> = span.chars().collect();
        let inner: String = if chars.len() >= 2 {
            chars[1..chars.len() - 1].iter().collect()
        } else {
            String::new()
        };
        if bare_forms.iter().any(|re| re.is_match(&inner)) && cue_outside && !metalinguistic {
            out.push(' ');
            out.push_str(&inner);
            out.push(' ');
        } else {
            out.push_str(&" ".repeat(span.len()));
        }
        from = m.end();
    }
    out.push_str(&text[from..]);
    out
}

/// F02 rule 5 (container role): a format named immediately after a container
/// preposition IS the deliverable, so a content word between the cue and it
/// ("summary IN PDF", "output AS a pptx") never vetoes it. Only an article or
/// a quantifier may sit in the gap -- any other word means the container is
/// governing a different phrase.
fn container_named(clause: &str, a: &At) -> bool {
    for c in positions(&CONTAINER_PREP_RE, clause) {
        if c.start >= a.start {
            continue;
        }
        if c.end >= a.start {
            return true; // adjacent: the classes share the boundary char
        }
        if FILLER_BETWEEN_RE.is_match(&clause[c.end..a.start]) {
            return true;
        }
    }
    false
}

/// F02 rule 6 (polysemy): a lexeme with a strong non-document sense routes
/// only with its own domain in reach. A partitive complement decides directly
/// ("deck OF cards" vs "deck OF slides"); otherwise a competing-sense frame
/// inside the same phrase ("GARDEN deck") suppresses it.
fn weak_sense_suppressed(clause: &str, seg: Span, mode: RendererMode, a: &At) -> bool {
    let Some((lexeme, corroborated, frame)) = weak_sense(mode) else {
        return false;
    };
    if !positions(lexeme, clause)
        .iter()
        .any(|p| p.start == a.start && p.end == a.end)
    {
        return false;
    }
    if let Some(cap) = PARTITIVE_RE.captures(&clause[a.end..]) {
        let complement = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        return !corroborated.is_match(complement);
    }
    positions(frame, clause).iter().any(|f| f.start >= seg.start && f.start < seg.end)
}

/// The scan: clause by clause, phrase by phrase. Every relation is a typed
/// ROLE (destination / source / container / discussed subject / reported-past
/// object) plus a clause FRAME (didactic vs transactional), decided by
/// MATCH-START ORDER only. Returns the REQUESTED deliverables in
/// first-appearance order: zero = no request, one = that deliverable, two or
/// more = a genuine multi-deliverable turn (never an arbitrary winner, never
/// a silently dropped second ask).
///
/// Adjacent matches share their boundary character (WB_R of the cue == WB_L
/// of the next word), so cross-match end-vs-start tests are off-by-one
/// against directly adjacent cue->word pairs ("export as xlsx", "make deck"):
/// start order is immune AND stays JS/Rust parity (JS UTF-16 units vs Rust
/// bytes are never compared by distance, only by order; the same-engine gap
/// checks in container_named/weak_sense_suppressed slice text BETWEEN two
/// matches, which is content, not an offset space).
fn detect_deliverable_intent(trimmed: &str) -> Vec<RendererMode> {
    let masked = INNER_DOT_RE
        .replace_all(&mask_quoted(trimmed), |c: &Captures| format!("{} {}", &c[1], &c[2]))
        .into_owned();
    let mut found: Vec<(usize, usize, RendererMode)> = Vec::new();
    let clause_spans = spans(&masked, &CLAUSE_SPAN_RE);

    for (ci, cs) in clause_spans.iter().enumerate() {
        let clause = &masked[cs.start..cs.end];
        if clause.is_empty() {
            continue;
        }
        let creates = positions(&CREATE_CUE_RE, clause);
        let transforms = positions(&TRANSFORM_CUE_RE, clause);
        let dirs = positions(&DIRECTION_RE, clause);
        let negs = positions(&NEGATION_RE, clause);
        let metas = positions(&META_PHRASE_RE, clause);
        let sources = positions(&SOURCE_ROLE_RE, clause);
        let didactics = positions(&DIDACTIC_RE, clause);
        let pasts = positions(&PAST_PRODUCTION_RE, clause);
        let subjects = positions(&SUBJECT_RE, clause);
        let modals = positions(&DESIRE_MODAL_RE, clause);
        let cues: Vec<At> = creates.iter().chain(transforms.iter()).copied().collect();
        let segs = spans(clause, &SEGMENT_SPLIT_RE);
        let in_seg = |ps: &[At], seg: Span| -> Vec<At> {
            ps.iter()
                .copied()
                .filter(|p| p.start >= seg.start && p.start < seg.end)
                .collect()
        };

        let matchers = [
            (RendererMode::Excel, &*EXCEL_RE),
            (RendererMode::Docs, &*DOCS_RE),
            (RendererMode::Pdf, &*PDF_RE),
            (RendererMode::Ppt, &*PPT_RE),
            (RendererMode::Chart, &*CHART_RE),
            (RendererMode::HtmlRender, &*HTML_RE),
        ];
        for (mode, re) in matchers {
            for m in re.find_iter(clause) {
                let a = At {
                    start: m.start(),
                    end: m.end(),
                };
                let seg = segs
                    .iter()
                    .find(|s| a.start >= s.start && a.start < s.end)
                    .copied()
                    .unwrap_or(Span {
                        start: 0,
                        end: clause.len(),
                    });
                // 1. NEGATION governs its own phrase only. A request that
                //    starts after the phrase boundary survives ("Without
                //    using Excel, create a PDF"); a negation inside the
                //    request phrase vetoes it.
                if in_seg(&negs, seg).iter().any(|n| n.start < a.start) {
                    continue;
                }
                // 2. TRANSFORM DIRECTION: convert/export governs the word
                //    directly as the SOURCE format; the word after a
                //    to/into/as direction is the output.
                let governed_source = transforms.iter().any(|t| {
                    t.start < a.start
                        && !dirs.iter().any(|d| d.start > t.start && d.start < a.start)
                });
                if governed_source {
                    continue;
                }
                // 3. SOURCE ROLE: "from / based on / out of <format>" marks
                //    the word as the material. One destination + one source
                //    is NOT an ambiguity.
                let source_role = sources.iter().any(|s| {
                    s.start < a.start
                        && !cues.iter().any(|c| c.start > s.start && c.start < a.start)
                });
                if source_role {
                    continue;
                }
                // 4. DIDACTIC FRAME: a didactic marker between the cue and
                //    the word either puts the production cue inside a how-to
                //    ("explain HOW TO create a PDF") or names the word as the
                //    subject being explained ("a PDF that explains how
                //    SPREADSHEETS work").
                let didactic = didactics.iter().any(|d| {
                    d.start < a.start
                        && (cues.iter().any(|c| c.start > d.start && c.start < a.start)
                            || cues.iter().any(|c| c.start < d.start))
                });
                if didactic {
                    continue;
                }
                // 5. REPORTED PAST ACTION: an explicit agent plus a past-tense
                //    production verb inside one phrase describes an EXISTING
                //    file. Desire/politeness ("I wanted a PDF") is exempt.
                let reported_past = in_seg(&pasts, seg).iter().any(|p| {
                    p.start < a.start
                        && in_seg(&subjects, seg).iter().any(|s| s.start < p.start)
                        && in_seg(&modals, seg).is_empty()
                });
                if reported_past {
                    continue;
                }
                // 6. DISCUSSED MATERIAL: a summary/outline-style word between
                //    the cue and the format marks the format as the subject --
                //    UNLESS the format is named as the container ("summary IN
                //    PDF" -> pdf).
                let meta_gap = metas.iter().any(|m| {
                    m.start < a.start
                        && (creates.iter().any(|c| c.start < m.start)
                            || transforms.iter().any(|t| t.start < m.start))
                }) && !container_named(clause, &a);
                if meta_gap {
                    continue;
                }
                // 7. POLYSEMY: a weak lexeme needs its own domain in reach.
                if weak_sense_suppressed(clause, seg, mode, &a) {
                    continue;
                }
                // 8. BINDING: a production cue (or a transform + direction)
                //    precedes it.
                let create_bound = creates.iter().any(|c| c.start < a.start);
                let transform_bound = transforms.iter().any(|t| {
                    t.start < a.start && dirs.iter().any(|d| d.start > t.start && d.start < a.start)
                });
                if create_bound || transform_bound {
                    found.push((ci, a.start, mode));
                    break;
                }
            }
        }
    }

    found.sort_by_key(|f| (f.0, f.1));
    let mut modes: Vec<RendererMode> = Vec::new();
    for f in found {
        if !modes.contains(&f.2) {
            modes.push(f.2);
        }
    }
    modes
}

/// `getDecisionSync(message, conversationHistory)`. The TS accepts history
/// but never reads it on this path; the parameter is kept for
/// call-compatibility only. Compiled once (statics above), pure string
/// matching -- no network, no LFM, near-zero latency.
pub fn get_decision_sync(message: &str, _history: &[Value]) -> DecisionEnvelope {
    // const trimmed = (message ?? "").trim(); if (!trimmed) return fallbackEnvelope("");
    let trimmed = js_trim(message);
    if trimmed.is_empty() {
        return DecisionEnvelope::fallback("");
    }
    let modes = detect_deliverable_intent(trimmed);
    let single = if modes.len() == 1 { Some(modes[0]) } else { None };
    let active = single.unwrap_or(RendererMode::StandardChat);
    DecisionEnvelope {
        active_mode: active,
        // Honest confidence: 0.8 only for a verb-bound SINGLE intent; 0.5 for
        // a miss and for a multi-deliverable turn (the scan cannot claim
        // which one).
        confidence: if single.is_some() { 0.8 } else { 0.5 },
        // F02 honest vocabulary: the outcome names itself. A miss is NOT
        // reported as a match, and two deliverables are NOT reported as mere
        // ambiguity (mirrors the TS none / match / multiple table).
        decided_by: match modes.len() {
            0 => "in-process-deliverable-none".to_string(),
            1 => "in-process-deliverable-match".to_string(),
            _ => "in-process-deliverable-multiple".to_string(),
        },
        // stripped_prompt is the TRIMMED message -- never rewritten.
        stripped_prompt: trimmed.to_string(),
        skill_to_load: single.and_then(mode_skill),
        allowed_code_fence: None,
        disable_validators: RendererMode::disable_validators_for(active),
        enable_validator: active,
        // F02: requested deliverables are recorded explicitly, in
        // first-appearance order, so a multi-deliverable turn can arm EVERY
        // requested contract instead of silently losing one.
        task_constraints: modes
            .iter()
            .map(|m| format!("deliverable-request={}", m.as_str()))
            .collect(),
        extracted_entities: Vec::new(),
        lfm_latency_ms: 0,
        lfm_input: None,
        lfm_raw: None,
    }
}

/// Status + compact-JSON body returned for a `/api/decision`-style POST.
/// `ruke-server` does not wire this route yet (Part 4+); the golden
/// fixtures replay it byte-for-byte against the recorded TS responses.
pub struct DecisionResponse {
    pub status: u16,
    pub body: String,
}

/// Byte-for-byte mirror of `app/api/decision/route.ts`'s POST handler:
/// bad JSON → 400 `{"error":"invalid JSON body"}`; missing/blank message →
/// 400 `{"error":"message required"}`; otherwise 200 + envelope bytes.
pub fn decision_route(raw_body: &str) -> DecisionResponse {
    let started = Instant::now();
    let parsed: Value = match serde_json::from_str(raw_body) {
        Ok(v) => v,
        Err(_) => {
            return DecisionResponse {
                status: 400,
                body: "{\"error\":\"invalid JSON body\"}".to_string(),
            };
        }
    };
    // typeof body === "object" && body !== null ? body.message : undefined
    // — on serde Value, `.get` on a non-object is likewise undefined.
    let Some(message) = parsed.get("message").and_then(Value::as_str) else {
        return DecisionResponse {
            status: 400,
            body: "{\"error\":\"message required\"}".to_string(),
        };
    };
    if js_trim(message).is_empty() {
        return DecisionResponse {
            status: 400,
            body: "{\"error\":\"message required\"}".to_string(),
        };
    }
    // The TS passes history through to getDecision; the sync path ignores
    // it. Ported for fidelity.
    let history: Vec<Value> = parsed
        .get("conversationHistory")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let envelope = get_decision_sync(message, &history);
    // Compact serialization == JSON.stringify; the envelope's serializer
    // is infallible (no user-controlled maps/values).
    let body = serde_json::to_string(&envelope).expect("envelope serialization is infallible");
    // §17: mode/decided_by/latency only — never prompt text or keys.
    tracing::info!(
        active_mode = envelope.active_mode.as_str(),
        decided_by = %envelope.decided_by,
        lfm_latency_ms = envelope.lfm_latency_ms,
        total_ms = started.elapsed().as_millis() as u64,
        "decision served"
    );
    DecisionResponse { status: 200, body }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// §6 test-classification (2026-11-13 brief): every test below is one of
    ///   PROTOCOL   — the wire contract (exact 400 strings, envelope field
    ///              order, compact JSON): pinned by fixtures, unchanged.
    ///   SEMANTIC   — the §4a intent law itself: verb-bound requests, noun
    ///              mentions, negation, direction, provenance, ambiguity.
    ///   RETIRED    — formerly-pinned LEGACY DEFECTS (ASCII-\b quirks,
    ///              INTENT_ORDER precedence, noun-mention routing, the
    ///              blanket confidence 1). Reclassified as regression
    ///              pins for the OPPOSITE (fixed) behavior; each documents
    ///              the fixture change in the vectors corpus.

    fn mode_for(prompt: &str) -> RendererMode {
        get_decision_sync(prompt, &[]).active_mode
    }

    fn scan(prompt: &str) -> (Option<RendererMode>, bool) {
        let modes = detect_deliverable_intent(js_trim(prompt));
        match modes.len() {
            0 => (None, false),
            1 => (Some(modes[0]), false),
            _ => (None, true),
        }
    }

    fn envelope_for(prompt: &str) -> DecisionEnvelope {
        get_decision_sync(prompt, &[])
    }

    /* -- F02 (2026-11-16): the artifact relation is TYPED (role + frame),
       not English grammar luck. Same prompts as the TS law suite in
       __tests__/decision/artifact-intent-f02.test.ts, so any Rust/TS
       divergence shows up here as a parity failure rather than as two
       engines that quietly disagree. */

    #[test]
    fn f02_didactic_and_past() {
        assert_eq!(
            mode_for("Explain how to create a PDF"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("how do I create a PDF?"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("Show me how to make a spreadsheet"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("Give me a tutorial on generating charts"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("how can I export a deck"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("I created a PDF yesterday; explain compression"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("We built a spreadsheet last week. What is a pivot table?"),
            RendererMode::StandardChat
        );
    }

    #[test]
    fn f02_controls_that_still_route() {
        assert_eq!(
            mode_for("Create a PDF"),
            RendererMode::Pdf
        );
        assert_eq!(
            mode_for("Create a PDF that explains how spreadsheets work"),
            RendererMode::Pdf
        );
        assert_eq!(
            mode_for("I wanted a PDF of that, please"),
            RendererMode::Pdf
        );
        assert_eq!(
            mode_for("I need a spreadsheet for this"),
            RendererMode::Excel
        );
        assert_eq!(
            mode_for("Create a business deck"),
            RendererMode::Ppt
        );
        assert_eq!(
            mode_for("give me a presentation"),
            RendererMode::Ppt
        );
    }

    #[test]
    fn f02_negation_scope() {
        assert_eq!(
            mode_for("Without using Excel, create a PDF"),
            RendererMode::Pdf
        );
        assert_eq!(
            mode_for("Skip the spreadsheet, just make a chart of these numbers"),
            RendererMode::Chart
        );
        assert_eq!(
            mode_for("Do not create a PDF"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("Create a chart, not a spreadsheet"),
            RendererMode::Chart
        );
    }

    #[test]
    fn f02_source_vs_destination() {
        assert_eq!(
            mode_for("Make a Word document from this PDF"),
            RendererMode::Docs
        );
        assert_eq!(
            mode_for("Create a chart from this spreadsheet"),
            RendererMode::Chart
        );
        assert_eq!(
            mode_for("Build a deck based on the existing xlsx"),
            RendererMode::Ppt
        );
        assert_eq!(
            mode_for("Write a docx out of the old pdf"),
            RendererMode::Docs
        );
        assert_eq!(
            mode_for("Convert the PDF to Excel"),
            RendererMode::Excel
        );
        assert_eq!(
            mode_for("Export the deck as a PDF"),
            RendererMode::Pdf
        );
        assert_eq!(
            mode_for("Rebuild this PDF, keep the source PDF numbering"),
            RendererMode::Pdf
        );
    }

    #[test]
    fn f02_container_role() {
        assert_eq!(
            mode_for("Create a summary in PDF"),
            RendererMode::Pdf
        );
        assert_eq!(
            mode_for("Create the summary as a docx"),
            RendererMode::Docs
        );
        assert_eq!(
            mode_for("Write the numbers in xlsx format"),
            RendererMode::Excel
        );
        assert_eq!(
            mode_for("Write a summary of the PDF"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("Draft an outline of the deck"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("Create a PDF summary"),
            RendererMode::Pdf
        );
    }

    #[test]
    fn f02_polysemy() {
        assert_eq!(
            mode_for("Create a deck of cards"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("Create a plan for my garden deck"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("Build me a deck for the back patio"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("I need a deck of slides for Monday"),
            RendererMode::Ppt
        );
        assert_eq!(
            mode_for("make a \"quarterly\" deck"),
            RendererMode::Ppt
        );
    }

    #[test]
    fn f02_quotation_role() {
        assert_eq!(
            mode_for("Create a \"PDF\" of this report"),
            RendererMode::Pdf
        );
        assert_eq!(
            mode_for("explain the phrase \"make a deck\""),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("he said \"create a PDF\" and then left"),
            RendererMode::StandardChat
        );
    }

    #[test]
    fn f02_multiple_deliverables_are_recorded_not_resolved() {
        let env = envelope_for("Create a PDF and an XLSX of these numbers");
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.decided_by, "in-process-deliverable-multiple");
        assert_eq!(env.confidence, 0.5);
        assert_eq!(
            env.task_constraints,
            ["deliverable-request=pdf", "deliverable-request=excel"]
        );
        assert_eq!(env.skill_to_load, None);
        assert_eq!(envelope_for("Create a PDF of these numbers").task_constraints,
            ["deliverable-request=pdf"]);
        // the SAME format named twice is one deliverable, not two
        assert_eq!(mode_for("Create a PDF, then create a second PDF"), RendererMode::Pdf);
    }

    #[test]
    fn f02_honest_uncertainty_vocabulary() {
        assert_eq!(envelope_for("What is a PDF?").decided_by, "in-process-deliverable-none");
        assert_eq!(envelope_for("").decided_by, "in-process-fallback");
        assert_eq!(envelope_for("Create a PDF").decided_by, "in-process-deliverable-match");
        assert_eq!(envelope_for("Create a PDF").confidence, 0.8);
        assert_eq!(envelope_for("What is a PDF?").confidence, 0.5);
    }

    /// TS mirror: artifact-intent-f02.test.ts "F02 10". A polite desire
    /// phrase is a PRODUCTION cue ("I would like a workbook" = a request);
    /// a cognitive/perception frame is not. The consuming word class keeps
    /// "looked"/"sounded" whole, so the "d like" branch cannot fire inside
    /// them — a letter before the apostrophe-form blocks WB_L.
    #[test]
    fn f02_desire_cue_and_cognitive_frame() {
        assert_eq!(
            mode_for("I would like a spreadsheet of the quarterly figures"),
            RendererMode::Excel
        );
        assert_eq!(
            mode_for("we would like the numbers as a workbook please"),
            RendererMode::Excel
        );
        assert_eq!(mode_for("she'd like a pdf of the invoice"), RendererMode::Pdf);
        assert_eq!(
            mode_for("I would like a word document of the interview notes"),
            RendererMode::Docs
        );
        for prompt in [
            "I would like to understand how a pdf stores fonts",
            "she'd like to know what a spreadsheet pivot is",
            "it looked like a pdf but it is actually a scan",
            "that sounded like a spreadsheet idea",
            "how would you like the data?",
        ] {
            assert_eq!(mode_for(prompt), RendererMode::StandardChat, "{prompt}");
        }
        // A cognitive verb AFTER the format never suppresses the request:
        assert_eq!(
            mode_for("Create a PDF so I can understand the invoice"),
            RendererMode::Pdf
        );
    }

    #[test]
    fn f02_bare_and_word_matchers_share_one_derived_body() {
        // PARITY GUARD: the anchored (whole-token) form is DERIVED from the
        // compiled word matcher, so word form and bare form cannot drift —
        // the docs matcher carries a non-ASCII branch, exactly where a
        // hand-duplicated body would rot.
        for (name, word, bare) in [
            ("excel", &*EXCEL_RE, &*EXCEL_BARE_RE),
            ("docs", &*DOCS_RE, &*DOCS_BARE_RE),
            ("pdf", &*PDF_RE, &*PDF_BARE_RE),
            ("ppt", &*PPT_RE, &*PPT_BARE_RE),
            ("chart", &*CHART_RE, &*CHART_BARE_RE),
            ("html", &*HTML_RE, &*HTML_BARE_RE),
        ] {
            assert_eq!(anchored_form(word).as_str(), bare.as_str(), "bare body drifted for {name}");
        }
    }

    /* ── SEMANTIC: §4a reproductions from the brief ─────────────────────── */

    #[test]
    fn brief_reproduction_noun_mentions_are_not_requests() {
        // "What is a PDF?" -> was Pdf. "Explain a deck of cards." -> was Ppt.
        assert_eq!(mode_for("What is a PDF?"), RendererMode::StandardChat);
        assert_eq!(mode_for("Explain a deck of cards."), RendererMode::StandardChat);
        // "Do not create Excel. Explain arrays." -> was Excel; clause 1 is
        // negated, clause 2 has no artifact word.
        assert_eq!(
            mode_for("Do not create Excel. Explain arrays."),
            RendererMode::StandardChat
        );
        // "Create a résumé." -> used to MISS (the é consuming-tail quirk).
        assert_eq!(mode_for("Create a résumé."), RendererMode::Docs);
    }

    #[test]
    fn brief_reproduction_mixed_deliverables_have_no_precedence() {
        // "presentation in pdf format": the INTENT_ORDER precedence (pdf
        // beats ppt) is retired — but there is no verb cue at all, so both
        // words are mere mentions.
        assert_eq!(
            mode_for("presentation in pdf format"),
            RendererMode::StandardChat
        );
        assert_eq!(scan("presentation in pdf format"), (None, false));
        // A verb-bound mixed ask = genuine ambiguity, never a winner:
        let env = envelope_for("make a presentation in pdf format");
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.decided_by, "in-process-deliverable-multiple");
        assert_eq!(env.confidence, 0.5);
        let env = envelope_for("create a résumé and a spreadsheet");
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.decided_by, "in-process-deliverable-multiple");
        let env = envelope_for("make a chart and a deck");
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.decided_by, "in-process-deliverable-multiple");
    }

    /* ── SEMANTIC: the §4a cue / veto / provenance law ──────────────────── */

    #[test]
    fn verb_bound_artifact_requests_route() {
        assert_eq!(mode_for("build me a spreadsheet now"), RendererMode::Excel);
        assert_eq!(mode_for("make a résumé for me"), RendererMode::Docs);
        assert_eq!(mode_for("I need a deck of slides for Monday"), RendererMode::Ppt);
        assert_eq!(mode_for("give me a chart of the sales"), RendererMode::Chart);
        assert_eq!(mode_for("build me a landing page"), RendererMode::HtmlRender);
        assert_eq!(mode_for("PDF REPORT".to_lowercase().as_str()), RendererMode::StandardChat); // no cue
        assert_eq!(mode_for("generate pdf report"), RendererMode::Pdf);
        assert_eq!(mode_for("   make a deck \t"), RendererMode::Ppt);
        assert_eq!(mode_for("write a word document"), RendererMode::Docs);
        assert_eq!(mode_for("give me a presentation"), RendererMode::Ppt);
        assert_eq!(mode_for("export as xlsx"), RendererMode::Excel);
        // The retired pre-§4a noun-mention positives now honestly miss:
        assert_eq!(mode_for("an Excel file please"), RendererMode::StandardChat);
        assert_eq!(mode_for("update my resume today"), RendererMode::StandardChat);
        assert_eq!(mode_for("save the .pptx"), RendererMode::StandardChat); // export/save SOURCE rule, no direction word
        assert_eq!(mode_for("print this pdf"), RendererMode::StandardChat);
    }

    #[test]
    fn negation_vetoes_a_cue_bound_artifact_word() {
        assert_eq!(mode_for("do not create excel"), RendererMode::StandardChat);
        assert_eq!(
            mode_for("don't create a pdf, just summarize"),
            RendererMode::StandardChat
        );
        assert_eq!(mode_for("I don't want a presentation, just notes"), RendererMode::StandardChat);
        // Positive control: the same cue without negation still routes.
        assert_eq!(mode_for("create a pdf"), RendererMode::Pdf);
    }

    #[test]
    fn transform_cue_direction_rule_binds_output_not_source() {
        // "Convert the PDF to Excel" -> the PDF is the SOURCE, Excel is the
        // requested output. Pre-§4a the first match (excel in ORDER) was
        // accidental luck; the law now says WHY.
        assert_eq!(mode_for("convert the pdf to excel"), RendererMode::Excel);
        assert_eq!(scan("convert the pdf to excel"), (Some(RendererMode::Excel), false));
        assert_eq!(mode_for("save the deck as a spreadsheet"), RendererMode::Excel);
        // Governed-without-direction = source mention, never a request:
        assert_eq!(mode_for("export the deck"), RendererMode::StandardChat);
    }

    #[test]
    fn quoted_spans_never_create_a_request() {
        assert_eq!(
            mode_for("explain the phrase \"make a deck\""),
            RendererMode::StandardChat
        );
        // Positive control: masking must not eat the real words.
        assert_eq!(mode_for("make a \"quarterly\" deck"), RendererMode::Ppt);
    }

    #[test]
    fn meta_phrases_mark_discussed_material_not_the_ask() {
        assert_eq!(mode_for("write a summary of the pdf"), RendererMode::StandardChat);
        assert_eq!(mode_for("draft an outline of the deck"), RendererMode::StandardChat);
        // Positive control: meta word AFTER the artifact does not veto it.
        assert_eq!(
            mode_for("write a word document about migratory birds"),
            RendererMode::Docs
        );
    }

    /* ── SEMANTIC: Unicode word classes (the §6 fixture-overfitting fix) ── */

    #[test]
    fn unicode_word_boundaries_replace_the_ascii_quirks() {
        // RETIRED quirks (previously pinned as contracts):
        // - "caféexcel" matched because ASCII \b split at the non-word é.
        // - "résumébuilder" matched via the consuming-tail branch.
        // - bare "résumé" MISSED while "résumé2" matched.
        // The law now treats \p{L}/\p{N} uniformly in BOTH runtimes:
        assert_eq!(mode_for("caféexcel"), RendererMode::StandardChat); // é is a letter
        assert_eq!(mode_for("résumébuilder"), RendererMode::StandardChat);
        assert_eq!(mode_for("résumé"), RendererMode::StandardChat); // no cue: a mention
        assert_eq!(mode_for("my résumé"), RendererMode::StandardChat);
        assert_eq!(mode_for("create my résumé"), RendererMode::Docs); // the word, with a cue
        // "Create a résumé2." no longer "matches" — résumé2 is not the word
        // résumé; the honest outcome is standard_chat (the main model still
        // sees the message verbatim).
        assert_eq!(mode_for("résumé2"), RendererMode::StandardChat);
        // Parity cases that hold both before and after:
        assert_eq!(mode_for("the pdfx file"), RendererMode::StandardChat);
        assert_eq!(mode_for("what is excelent"), RendererMode::StandardChat);
        assert_eq!(mode_for("charts"), RendererMode::StandardChat);
        assert_eq!(mode_for("cvx"), RendererMode::StandardChat);
        assert_eq!(mode_for("htmlx dashboard"), RendererMode::StandardChat);
        assert_eq!(mode_for("word  document"), RendererMode::StandardChat); // `word ?document`: one space
        assert_eq!(mode_for("word-document"), RendererMode::StandardChat);
        // Dotted + bare alternatives, now cue-gated:
        assert_eq!(mode_for("file.docx"), RendererMode::StandardChat);
        assert_eq!(mode_for("create file.docx"), RendererMode::Docs);
        assert_eq!(mode_for("file.xlsx"), RendererMode::StandardChat);
        assert_eq!(mode_for("file.pptx"), RendererMode::StandardChat);
    }

    #[test]
    fn mark_final_words_glue_like_latin_words() {
        // §6 \p{M} generalization: Telugu/Devanagari words routinely end in
        // combining marks (virama here). Under the retired class the mark
        // looked like a boundary, so the Latin cue fired THROUGH glue that
        // Latin script would block ("కంప్యూటర్pdf" ≠ "pdfx"). The English
        // verb stays (the cue law needs one); only the boundary class is
        // under test — the spaced control routes, the glued one must not.
        assert_eq!(
            mode_for("create కంప్యూటర్pdf"),
            RendererMode::StandardChat
        );
        assert_eq!(mode_for("create కంప్యూటర్ pdf"), RendererMode::Pdf);
        // Same law for the docs cue joined by a Devanagari virama:
        assert_eq!(
            mode_for("create कंप्यूटर्resume"),
            RendererMode::StandardChat
        );
        assert_eq!(mode_for("create कंप्यूटर् resume"), RendererMode::Docs);
    }

    #[test]
    fn casing_and_entity_rewording_invariance() {
        // The §6 invariants over the cue law: casing changes nothing.
        assert_eq!(mode_for("CREATE A PDF"), mode_for("create a pdf"));
        assert_eq!(mode_for("create a pdf"), RendererMode::Pdf);
        assert_eq!(mode_for("Make Me A Spreadsheet"), RendererMode::Excel);
    }

    #[test]
    fn held_out_non_latin_requests_fall_gracefully() {
        // The cue vocabulary is ENGLISH-ONLY (a documented limitation, not
        // an exception table): a non-Latin production verb with a Latin
        // artifact word never routes, and pure non-Latin prompts match no
        // artifact word at all. standard_chat is the honest outcome — the
        // main model still receives the message verbatim.
        assert_eq!(
            mode_for("कृपया pdf बनाकर दो"),
            RendererMode::StandardChat
        );
        assert_eq!(
            mode_for("స్ప్రెడ్‌షీట్ సృష్టించండి"),
            RendererMode::StandardChat
        );
        // A Latin artifact word inside non-Latin text with NO English cue:
        assert_eq!(mode_for("hi make pdf"), RendererMode::Pdf); // control: cue present
    }

    /* ── RETIRED legacy-vocabulary pins (anatomy/3d/cad) ────────────────── */

    #[test]
    fn retired_vocabulary_no_longer_routes() {
        for prompt in [
            "an exploded view of the reactor core",
            "cutaway of the marine engine",
            "anatomy of a jet turbine",
            "isometric illustration of the server rack",
            "cross-section of the pump housing",
            "a building cutaway diagram",
            "What is the anatomy of the knee?",
            "What is an isometric exercise?",
            "what's anatomy?",
            "define isometric",
            "isometric exercises for beginners",
            "anatomy quiz questions",
            "render scene",
            "render\nscene",
            "3D building model",
            "an architectural sketch",
        ] {
            assert_eq!(mode_for(prompt), RendererMode::StandardChat, "{prompt}");
            assert_eq!(scan(prompt), (None, false), "{prompt}");
        }
        // The retired vocab still doesn't route by itself under the new law:
        assert_eq!(mode_for("exploded diagram in html"), RendererMode::StandardChat);
        assert_eq!(mode_for("exploded isometric chart"), RendererMode::StandardChat);
        // ...but a §4a verb-bound request past it does:
        assert_eq!(
            mode_for("make an exploded diagram in html"),
            RendererMode::HtmlRender
        );
        assert_eq!(mode_for("chart the revenue"), RendererMode::StandardChat); // no separate cue (documented loss)
        assert_eq!(mode_for("make a chart of the revenue"), RendererMode::Chart);
        assert_eq!(
            mode_for("chart of this building's architecture"),
            RendererMode::StandardChat
        );
        // "design" IS a §4a production cue: this phrase is now honestly a
        // cue-bound html request (documented behavior change vs the retired
        // frame-guard pin).
        assert_eq!(mode_for("interior design with html"), RendererMode::HtmlRender);
        assert_eq!(mode_for("3d chart"), RendererMode::StandardChat);
    }

    /* ── PROTOCOL: envelope + route wire contract ───────────────────────── */

    #[test]
    fn blank_message_uses_in_process_fallback_envelope() {
        // JS trim() strips spaces, tabs, newlines AND U+00A0 (§ jsstr table)
        let env = get_decision_sync("   \u{a0} \n", &[]);
        assert_eq!(env.decided_by, "in-process-fallback");
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.stripped_prompt, "");
        assert_eq!(env.confidence, 0.5); // §4a: fallback never claims certainty
    }

    #[test]
    fn match_envelope_field_construction() {
        let env = get_decision_sync("  build me a spreadsheet now  ", &[]);
        assert_eq!(env.active_mode, RendererMode::Excel);
        assert_eq!(env.decided_by, "in-process-deliverable-match");
        assert_eq!(env.stripped_prompt, "build me a spreadsheet now"); // trimmed, not rewritten
        assert_eq!(env.skill_to_load, Some("xlsx"));
        assert_eq!(env.allowed_code_fence, None);
        assert_eq!(env.enable_validator, RendererMode::Excel);
        assert_eq!(env.disable_validators.len(), 6);
        assert!(!env.disable_validators.contains(&RendererMode::Excel));
        assert_eq!(env.confidence, 0.8); // §4a honest confidence
        assert_eq!(env.lfm_latency_ms, 0);
        assert_eq!(env.task_constraints, ["deliverable-request=excel"]);
        assert!(env.extracted_entities.is_empty());
    }

    #[test]
    fn miss_envelope_keeps_no_skill_and_honest_confidence() {
        let env = get_decision_sync("tell me a joke", &[]);
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.decided_by, "in-process-deliverable-none");
        assert_eq!(env.skill_to_load, None); // lazy loading: no intent, no block
        assert_eq!(env.confidence, 0.5);
        assert_eq!(intent_none_control(), (None, false));
    }

    fn intent_none_control() -> (Option<RendererMode>, bool) {
        scan("a model of the city") // model matcher retired with 3d_asset
    }

    #[test]
    fn route_error_shapes_are_exact_ts_strings() {
        let r = decision_route("{oops");
        assert_eq!(r.status, 400);
        assert_eq!(r.body, "{\"error\":\"invalid JSON body\"}");

        let r = decision_route("{\"message\":\"   \"}");
        assert_eq!(
            (r.status, r.body.as_str()),
            (400, "{\"error\":\"message required\"}")
        );

        let r = decision_route("{\"history\":[]}"); // no `message` key at all
        assert_eq!(
            (r.status, r.body.as_str()),
            (400, "{\"error\":\"message required\"}")
        );

        let r = decision_route("\"just a string\""); // non-object body
        assert_eq!(
            (r.status, r.body.as_str()),
            (400, "{\"error\":\"message required\"}")
        );
    }

    #[test]
    fn route_success_is_compact_json_with_full_envelope_shape() {
        let r = decision_route(&json!({ "message": "make a deck" }).to_string());
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"active_mode\":\"ppt\""));
        assert!(r
            .body
            .contains("\"decided_by\":\"in-process-deliverable-match\""));
        assert!(r.body.contains("\"skill_to_load\":\"pptx\""));
        assert!(r.body.contains("\"confidence\":0.8")); // §4a: float rendering == JSON.stringify(0.8)
        assert!(!r.body.contains('\n')); // compact == JSON.stringify
    }
}
