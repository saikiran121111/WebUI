//! Intent detection + envelope construction — oracle:
//! `lib/decision/client.ts` (`getDecisionSync` path, which is ALL the live
//! TS route ever calls; the async/worker paths there are inert shims).
//!
//! JS↔Rust regex parity — the TS matchers use `\b` and `\w`, which are
//! ASCII in JS but Unicode-aware in Rust's default regex mode. Every
//! boundary is therefore written as an explicit class: JS's `\b` before a
//! word-initial alternative becomes `(?:^|[^A-Za-z0-9_])`, and after a
//! word-final alternative becomes `(?:[^A-Za-z0-9_]|$)` (existence
//! semantics only — `.test()` never needs the boundary bytes themselves,
//! so consuming them is safe). `\w*` becomes `[A-Za-z0-9_]*`. (The 3d_asset
//! bridging `.*` that needed the CR/LF/U+2028/U+2029 class retired with the
//! mode on 2026-11-06 — Ruke plan Phase 4 — so no matcher uses `.` anymore.)
//!
//! Boundary polarity depends on the word-ness of the EDGE CHAR of the
//! matched alternative (JS `\b` = ASCII-word XOR across the position):
//! - Alternatives ending in a non-ASCII char: `docs`' `résumé` ends in
//!   `é`, non-word for JS `\b`, so the trailing boundary demands a WORD
//!   char next ("résumébuilder" matches; "résumé" at end or "résumé x"
//!   match in NEITHER language). It gets its own branch with a consuming
//!   `[A-Za-z0-9_]` tail. No other alternative has a non-ASCII edge char.
//! - Alternatives starting with `.` (`\.xlsx` etc.): JS demands a WORD
//!   char before the dot — the exact complement of the sibling bare
//!   alternative's non-word precondition, and with an identical tail, so
//!   the dotted alternative can never fire where the bare one doesn't.
//!   It is redundant in the oracle itself; the uniform group classes stay
//!   correct without a special branch.
//!
//! First-match precedence follows `INTENT_ORDER` (chart BEFORE anatomy;
//! pdf BEFORE ppt; anatomy BEFORE html_render). `3d_asset`/`cad_blueprint`
//! were retired 2026-11-06 (Ruke plan Phase 4): their matchers no longer
//! exist, so old prompts ("render a 3d scene", "floor plan") now fall to
//! `standard_chat` or, for the shared anatomy vocabulary, `anatomy` — but
//! only outside a conversational frame: the anatomy branch rejects
//! ask/definition/explanation frames and the fitness / school-subject senses
//! of its words, because one bare keyword is not an illustration request
//! (audit finding 5, 2026-11-06; see `anatomy_intent`).

use std::sync::LazyLock;
use std::time::Instant;

use regex::Regex;
use serde_json::Value;

use ruke_contracts::decision::{mode_skill, DecisionEnvelope, RendererMode};
use ruke_skills::jsstr::js_trim;

static EXCEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|[^A-Za-z0-9_])(?:spreadsheet|excel|[.]xlsx|workbook|xlsx)(?:[^A-Za-z0-9_]|$)",
    )
    .unwrap()
});
static DOCS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:(?:^|[^A-Za-z0-9_])(?:word ?document|[.]docx|docx|resume|cv)(?:[^A-Za-z0-9_]|$)",
        // `résumé`'s last char is non-word (ASCII \b) -> JS requires the
        // NEXT char to be a word char; the tail is consuming and must exist.
        r"|(?:^|[^A-Za-z0-9_])résumé[A-Za-z0-9_])"
    ))
    .unwrap()
});
static PDF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|[^A-Za-z0-9_])pdf(?:[^A-Za-z0-9_]|$)").unwrap());
static PPT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^A-Za-z0-9_])(?:power ?point|presentation|[.]pptx|pptx|deck)(?:[^A-Za-z0-9_]|$)").unwrap()
});
static CHART_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|[^A-Za-z0-9_])chart(?:[^A-Za-z0-9_]|$)").unwrap());
// ASSET3D_RE / CAD_RE removed 2026-11-06 (Ruke plan Phase 4): the
// 3d_asset / cad_blueprint modes and their intent rules are retired.
/// `cross-section`'s interior `-` is a plain literal; JS `\b` only anchors
/// before "cross" and after "section", exactly as the bridge classes do.
static ANATOMY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^A-Za-z0-9_])(?:anatomy|cutaway|cross-section|isometric|exploded)(?:[^A-Za-z0-9_]|$)").unwrap()
});

// ── Anatomy over-trigger guard (2026-11-06 audit, finding 5) ──────────────
// Mirrors `ANATOMY_FRAMES` in `lib/decision/client.ts` pattern-for-pattern.
// Anatomy is the only intent whose words name a SUBJECT instead of a
// deliverable, so a bare keyword hit is not evidence of an illustration
// request: "What is the anatomy of the knee?" is a definition question and
// "What is an isometric exercise?" is a fitness question — both used to be
// routed into the anatomy renderer. The rule is therefore vocabulary MINUS
// conversational frames, built as plain regexes and applied by
// match-then-reject in `anatomy_intent`: the `regex` crate has no lookahead,
// which is exactly why no pattern here uses one. Every frame is a tight word
// sequence (bridge class + optional article), never an unbounded gap, so the
// two engines cannot drift on `.`-vs-newline semantics either.
const ANATOMY_VOCAB_SRC: &str = "anatomy|cutaway|cross-section|isometric|exploded";
/// The bridge class standing in for JS's ASCII-only `\b` (see module docs).
const BRIDGE: &str = r"[^A-Za-z0-9_]";
/// Articles are optional inside a frame; longest alternative first.
const ARTICLE: &str = r"(?:the|this|that|these|those|an|a)";

/// `(?:vocab)(?:bridge|$)` — the matcher's own trailing boundary.
fn vocab_tail() -> String {
    format!("(?:{v})(?:{b}|$)", v = ANATOMY_VOCAB_SRC, b = BRIDGE)
}

/// Frames that demote anatomy vocabulary to a topic mention.
static ANATOMY_FRAMES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let art = format!("(?:{a}{b}+)?", a = ARTICLE, b = BRIDGE);
    let v = vocab_tail();
    let patterns = [
        // "what/how/why is | are | does ... (the) <vocab>"
        format!(
            r"(?i)(?:^|{b})(?:what|how|why){b}+(?:'s|is|are|was|were|does|do|did){b}+{a}{v}",
            b = BRIDGE,
            a = art,
            v = v
        ),
        // contraction: "what's anatomy"
        format!(
            r"(?i)(?:^|{b})(?:what's|whats|how's|hows){b}+{a}{v}",
            b = BRIDGE,
            a = art,
            v = v
        ),
        // "define <vocab>", "meaning of (the) <vocab>", "definition of <vocab>"
        format!(
            r"(?i)(?:^|{b})(?:define|definition|meaning){b}+(?:of{b}+)?{a}{v}",
            b = BRIDGE,
            a = art,
            v = v
        ),
        // "tell me about (the) <vocab>"
        format!(
            r"(?i)(?:^|{b})tell{b}+me{b}+(?:about|of){b}+{a}{v}",
            b = BRIDGE,
            a = art,
            v = v
        ),
        // "explain / describe / discuss (the) <vocab>"
        format!(
            r"(?i)(?:^|{b})(?:explain|describe|discuss){b}+{a}{v}",
            b = BRIDGE,
            a = art,
            v = v
        ),
        // the other senses of these words: fitness ("isometric exercise") and
        // school subject ("anatomy exam / quiz / class")
        format!(
            r"(?i)(?:^|{b})isometric{b}+(?:exercis|workout|muscle|train|plank|yoga|physio|rehab)[A-Za-z]*",
            b = BRIDGE
        ),
        format!(
            r"(?i)(?:^|{b})anatomy{b}+(?:exam|quiz|test|class|course|chapter|student|study|revision|flashcard|lecture|homework|syllabus|worksheet)[A-Za-z]*",
            b = BRIDGE
        ),
    ];
    patterns.iter().map(|p| Regex::new(p).unwrap()).collect()
});

/// The anatomy branch: vocabulary present AND no conversational frame.
/// Unframed noun phrases ("anatomy of a jet turbine") stay anatomy — the
/// golden fixture pins them as illustration requests.
fn anatomy_intent(trimmed: &str) -> bool {
    ANATOMY_RE.is_match(trimmed) && !ANATOMY_FRAMES.iter().any(|re| re.is_match(trimmed))
}
static HTML_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^A-Za-z0-9_])(?:web ?page|landing ?page|html|interactive (?:ui|page|demo|prototype))(?:[^A-Za-z0-9_]|$)").unwrap()
});

/// `INTENT_ORDER` iteration with the compiled matchers — first match wins,
/// exactly like the TS `for (const intent of INTENT_ORDER)` loop.
fn match_intent(trimmed: &str) -> Option<RendererMode> {
    // The five plain matchers first, in `INTENT_ORDER` — chart before anatomy.
    let plain = [
        (RendererMode::Excel, &*EXCEL_RE),
        (RendererMode::Docs, &*DOCS_RE),
        (RendererMode::Pdf, &*PDF_RE),
        (RendererMode::Ppt, &*PPT_RE),
        (RendererMode::Chart, &*CHART_RE),
    ];
    if let Some((mode, _)) = plain.into_iter().find(|(_, re)| re.is_match(trimmed)) {
        return Some(mode);
    }
    // anatomy (5): its own branch, because it is the one intent that has to
    // reject conversational frames before it wins (finding 5).
    if anatomy_intent(trimmed) {
        return Some(RendererMode::Anatomy);
    }
    // html_render (6) last, exactly as in INTENT_ORDER.
    HTML_RE
        .is_match(trimmed)
        .then_some(RendererMode::HtmlRender)
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
    let intent = match_intent(trimmed);
    let active = intent.unwrap_or(RendererMode::StandardChat);
    DecisionEnvelope {
        active_mode: active,
        confidence: 1.0, // serializer renders integral f64 as JSON `1` (§14)
        decided_by: "in-process-deliverable-match".to_string(),
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

    fn mode_for(prompt: &str) -> RendererMode {
        get_decision_sync(prompt, &[]).active_mode
    }

    fn intent_for(prompt: &str) -> Option<RendererMode> {
        match_intent(js_trim(prompt))
    }

    #[test]
    fn core_matcher_quirks_match_js_word_boundaries() {
        // ASCII-boundary quirks the JS exhibits and parity demands:
        assert_eq!(mode_for("caféexcel"), RendererMode::Excel); // é is non-word in JS
        assert_eq!(mode_for("the pdfx file"), RendererMode::StandardChat); // pdfx blocked
        assert_eq!(mode_for("what is excelent"), RendererMode::StandardChat);
        assert_eq!(mode_for("charts"), RendererMode::StandardChat);
        assert_eq!(mode_for("cvx"), RendererMode::StandardChat);
        assert_eq!(mode_for("htmlx dashboard"), RendererMode::StandardChat);
        assert_eq!(mode_for("isometrically"), RendererMode::StandardChat);
        assert_eq!(mode_for("cutaways"), RendererMode::StandardChat);
        // Post-Phase-4: no 3D matcher exists at all — "render scene" and
        // friends fall to standard_chat (the vectors fixture replays this).
        assert_eq!(mode_for("render scene"), RendererMode::StandardChat);
        assert_eq!(mode_for("render\nscene"), RendererMode::StandardChat);
        // single space in `word ?document`, `power ?point`, `floor ?plan`
        assert_eq!(mode_for("word  document"), RendererMode::StandardChat);
        assert_eq!(mode_for("word document"), RendererMode::Docs);
        assert_eq!(mode_for("power  point"), RendererMode::StandardChat);
        assert_eq!(mode_for("résumébuilder"), RendererMode::Docs);
        assert_eq!(mode_for("word-document"), RendererMode::StandardChat);
        // é ends a JS \b on the NON-word side: boundary needs a word char
        // after — these stay unmatched in JS and here.
        assert_eq!(mode_for("résumé"), RendererMode::StandardChat);
        assert_eq!(mode_for("my résumé"), RendererMode::StandardChat);
        assert_eq!(mode_for("résumé2"), RendererMode::Docs); // '2' is a word char
                                                             // Dotted alternatives are dominated by their bare siblings in the
                                                             // oracle (complementary leading boundary, identical tail) — pins.
        assert_eq!(mode_for("file.docx"), RendererMode::Docs);
        assert_eq!(mode_for("file.xlsx"), RendererMode::Excel);
        assert_eq!(mode_for("file.pptx"), RendererMode::Ppt);
    }

    #[test]
    fn intent_order_precedence_pins() {
        // pdf (idx 2) before ppt (3): deck-with-pdf stays pdf
        assert_eq!(mode_for("presentation in pdf format"), RendererMode::Pdf);
        // pdf (2) before html_render (6): interior+pdf stays pdf
        // (cad_blueprint retired — "interior" no longer routes anywhere)
        assert_eq!(mode_for("the interior of the pdf"), RendererMode::Pdf);
        // chart (4) beats every retired-adjacent vocabulary: the cad/3d
        // matchers are gone, chart fires first and alone
        assert_eq!(
            mode_for("chart of this building's architecture"),
            RendererMode::Chart
        );
        // excel (0) beats chart (4)
        assert_eq!(mode_for("spreadsheet and a chart"), RendererMode::Excel);
        // cad (6) retired 2026-11-06: building+cutaway falls to anatomy (5)
        assert_eq!(
            mode_for("a building cutaway diagram"),
            RendererMode::Anatomy
        );
        // chart (4) before anatomy (5)
        assert_eq!(mode_for("exploded isometric chart"), RendererMode::Chart);
        // anatomy (5) before html_render (6)
        assert_eq!(mode_for("exploded diagram in html"), RendererMode::Anatomy);
        // anatomy positive
        assert_eq!(
            mode_for("cutaway of the marine engine"),
            RendererMode::Anatomy
        );
        // no match at all
        assert_eq!(mode_for("tell me a joke"), RendererMode::StandardChat);
        assert_eq!(intent_for("a model of the city"), None); // model matcher retired with 3d_asset
                                                             // Post-retirement falls to standard_chat:
        assert_eq!(mode_for("3D building model"), RendererMode::StandardChat);
        assert_eq!(
            mode_for("interior design with html"),
            RendererMode::HtmlRender
        );
        assert_eq!(
            mode_for("an architectural sketch"),
            RendererMode::StandardChat
        );
        assert_eq!(mode_for("3d chart"), RendererMode::Chart);
    }

    /// Audit finding 5 (2026-11-06): anatomy vocabulary inside a
    /// conversational frame is a TOPIC mention, not an illustration request.
    /// Mirrors `__tests__/decision/anatomy-intent.test.ts` on the TS side and
    /// the same prompts inside `fixtures/decision/06-intent-matcher-vectors`.
    #[test]
    fn anatomy_requires_a_request_not_a_topic_mention() {
        // The two prompts named in the audit brief.
        for prompt in [
            "What is the anatomy of the knee?",
            "What is an isometric exercise?",
        ] {
            assert_eq!(mode_for(prompt), RendererMode::StandardChat, "{prompt}");
            assert_eq!(intent_for(prompt), None, "{prompt}");
        }
        // Definition / explanation frames around the vocabulary.
        for prompt in [
            "what is the anatomy of the knee",
            "what's anatomy?",
            "what does anatomy mean?",
            "what is the meaning of cutaway?",
            "define isometric",
            "definition of a cross-section",
            "how does an exploded view work?",
            "tell me about the anatomy of the knee",
            "explain the anatomy of a knee",
            "isometric exercises for beginners",
            "anatomy quiz questions",
            "I have an anatomy exam tomorrow, any tips?",
        ] {
            assert_eq!(mode_for(prompt), RendererMode::StandardChat, "{prompt}");
        }
        // Illustration requests keep the route: the first five are the golden
        // fixture's requests, the rest are the imperative / polite-question
        // forms users actually type.
        for prompt in [
            "an exploded view of the reactor core",
            "cutaway of the marine engine",
            "anatomy of a jet turbine",
            "isometric illustration of the server rack",
            "cross-section of the pump housing",
            "a building cutaway diagram",
            "exploded diagram in html",
            "draw me a cutaway of a jet engine",
            "can you draw an exploded view of a car engine?",
            "how do I get an isometric diagram of the rack?",
            "show the anatomy of a jet turbine as a diagram",
        ] {
            assert_eq!(mode_for(prompt), RendererMode::Anatomy, "{prompt}");
        }
    }

    #[test]
    fn blank_message_uses_in_process_fallback_envelope() {
        // JS trim() strips spaces, tabs, newlines AND U+00A0 (§ jsstr table)
        let env = get_decision_sync("   \u{a0} \n", &[]);
        assert_eq!(env.decided_by, "in-process-fallback");
        assert_eq!(env.active_mode, RendererMode::StandardChat);
        assert_eq!(env.stripped_prompt, "");
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
        assert_eq!(env.disable_validators.len(), 7);
        assert!(!env.disable_validators.contains(&RendererMode::Excel));
        assert_eq!(env.confidence, 1.0);
        assert_eq!(env.lfm_latency_ms, 0);
        assert!(env.task_constraints.is_empty() && env.extracted_entities.is_empty());
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
        assert!(!r.body.contains('\n')); // compact == JSON.stringify
    }
}
