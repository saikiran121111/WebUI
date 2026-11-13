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
//! INTENT_ORDER first-match PRECEDENCE is retired — two requested intents
//! = honest standard_chat ambiguity, never an arbitrary winner. Confidence
//! is honest: 0.8 verb-bound, 0.5 uncertain (the old blanket 1.0 was false).
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
const WB_L: &str = r"(?:^|[^\p{L}\p{N}_])";
const WB_R: &str = r"(?:[^\p{L}\p{N}_]|$)";

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
static CLAUSE_SPLIT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.!?\n;]+").unwrap());

static CREATE_CUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    word_re(
        "create|creates|created|creating|make|makes|making|build|builds|building|\
         generat(?:e|es|ed|ing)|produc(?:e|es|ed|ing)|prepar(?:e|es|ed|ing)|\
         writ(?:e|es|ing)|draft|drafts|drafted|drafting|design|designs|designed|designing|\
         assemble|assembles|assembled|assembling|give me|gave me|get me|got me|\
         send me|sending me|sent me|need|needs|needed|want|wants|wanted|put together",
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

/// Match position — ONLY the start is recorded: the §4a law compares
/// matches by start order alone (see the parity note at the module top;
/// `end` was dropped once no rule read it, keeping dead-code at zero).
struct At {
    start: usize,
}

fn positions(re: &Regex, s: &str) -> Vec<At> {
    re.find_iter(s).map(|m| At { start: m.start() }).collect()
}

fn mask_quoted(text: &str) -> String {
    // regex 1.13's Replacer-closure form takes &Captures; QUOTED_RE has no
    // capture groups, so get(0) is always the whole quoted span (length in
    // BYTES — a byte-length space filler never reorders anything after it,
    // and offsets are only compared by ORDER — see the parity note above).
    QUOTED_RE
        .replace_all(text, |c: &Captures| {
            " ".repeat(c.get(0).map_or(0, |m| m.len()))
        })
        .into_owned()
}

/// The §4a scan: returns (single requested intent, ambiguous flag).
/// Deterministic enumeration order (NOT a precedence — precedence is
/// retired; two+ distinct requested intents = ambiguity, never a winner).
fn detect_deliverable_intent(trimmed: &str) -> (Option<RendererMode>, bool) {
    let masked = INNER_DOT_RE
        .replace_all(&mask_quoted(trimmed), |c: &Captures| format!("{} {}", &c[1], &c[2]))
        .into_owned();
    let mut requested: Vec<RendererMode> = Vec::new();

    for clause in CLAUSE_SPLIT_RE.split(&masked) {
        if clause.is_empty() {
            continue;
        }
        let creates = positions(&CREATE_CUE_RE, clause);
        let transforms = positions(&TRANSFORM_CUE_RE, clause);
        let dirs = positions(&DIRECTION_RE, clause);
        let negs = positions(&NEGATION_RE, clause);
        let metas = positions(&META_PHRASE_RE, clause);

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
                let a = At { start: m.start() };
                // All relational tests use match-START ORDER only (`<` on
                // offsets). Adjacent matches share their boundary character
                // (WB_R of the cue == WB_L of the next word), so cross-match
                // end-vs-start tests were off-by-one against directly
                // adjacent cue->word pairs ("export as xlsx", "make deck",
                // "generate pdf") — a real defect, bug-for-bug with the TS
                // mirror until fixed in both engines at once.
                if negs.iter().any(|n| n.start < a.start) {
                    continue; // negation veto
                }
                let governed_source = transforms.iter().any(|t| {
                    t.start < a.start && !dirs.iter().any(|d| d.start > t.start && d.start < a.start)
                });
                if governed_source {
                    continue; // the convert/export SOURCE format, not the ask
                }
                let meta_gap = metas.iter().any(|m| {
                    m.start < a.start
                        && (creates.iter().any(|c| c.start < m.start)
                            || transforms.iter().any(|t| t.start < m.start))
                });
                if meta_gap {
                    continue; // discussed material ("write a summary of the pdf")
                }
                let create_bound = creates.iter().any(|c| c.start < a.start);
                let transform_bound = transforms.iter().any(|t| {
                    t.start < a.start && dirs.iter().any(|d| d.start > t.start && d.start < a.start)
                });
                if create_bound || transform_bound {
                    if !requested.contains(&mode) {
                        requested.push(mode);
                    }
                    break;
                }
            }
        }
    }

    match requested.len() {
        0 => (None, false),
        1 => (Some(requested[0]), false),
        _ => (None, true),
    }
}

/// `getDecisionSync(message, conversationHistory)`. The TS accepts history
/// but never reads it on this path; the parameter is kept for
/// call-compatibility only. Compiled once (statics above), pure string
/// matching — no network, no LFM, near-zero latency (§18).
pub fn get_decision_sync(message: &str, _history: &[Value]) -> DecisionEnvelope {
    // const trimmed = (message ?? "").trim(); if (!trimmed) return fallbackEnvelope("");
    let trimmed = js_trim(message);
    if trimmed.is_empty() {
        return DecisionEnvelope::fallback("");
    }
    let (intent, ambiguous) = detect_deliverable_intent(trimmed);
    let active = intent.unwrap_or(RendererMode::StandardChat);
    DecisionEnvelope {
        active_mode: active,
        // §4a honest confidence: 0.8 verb-bound, 0.5 uncertain. Non-integral
        // values serialize as JSON floats — byte-parity with JSON.stringify
        // (0.8 -> "0.8"); the integral branch still serves passthrough 1.0.
        confidence: if intent.is_some() { 0.8 } else { 0.5 },
        decided_by: if ambiguous {
            "in-process-deliverable-ambiguous".to_string()
        } else {
            "in-process-deliverable-match".to_string()
        },
        // stripped_prompt is the TRIMMED message — never rewritten.
        stripped_prompt: trimmed.to_string(),
        skill_to_load: intent.and_then(mode_skill),
        allowed_code_fence: None,
        disable_validators: RendererMode::disable_validators_for(active),
        enable_validator: active,
        task_constraints: Vec::new(),
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
        detect_deliverable_intent(js_trim(prompt))
    }

    fn envelope_for(prompt: &str) -> DecisionEnvelope {
        get_decision_sync(prompt, &[])
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
        assert_eq!(env.decided_by, "in-process-deliverable-ambiguous");
        assert_eq!(env.confidence, 0.5);
        let env = envelope_for("create a résumé and a spreadsheet");
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.decided_by, "in-process-deliverable-ambiguous");
        let env = envelope_for("make a chart and a deck");
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.decided_by, "in-process-deliverable-ambiguous");
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
        assert!(env.task_constraints.is_empty() && env.extracted_entities.is_empty());
    }

    #[test]
    fn miss_envelope_keeps_no_skill_and_honest_confidence() {
        let env = get_decision_sync("tell me a joke", &[]);
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.decided_by, "in-process-deliverable-match");
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
