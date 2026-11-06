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
//! `standard_chat` or, for the shared anatomy vocabulary, `anatomy`.

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
static HTML_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^A-Za-z0-9_])(?:web ?page|landing ?page|html|interactive (?:ui|page|demo|prototype))(?:[^A-Za-z0-9_]|$)").unwrap()
});

/// `INTENT_ORDER` iteration with the compiled matchers — first match wins,
/// exactly like the TS `for (const intent of INTENT_ORDER)` loop.
fn match_intent(trimmed: &str) -> Option<RendererMode> {
    let rules = [
        (RendererMode::Excel, &*EXCEL_RE),
        (RendererMode::Docs, &*DOCS_RE),
        (RendererMode::Pdf, &*PDF_RE),
        (RendererMode::Ppt, &*PPT_RE),
        (RendererMode::Chart, &*CHART_RE),
        (RendererMode::Anatomy, &*ANATOMY_RE),
        (RendererMode::HtmlRender, &*HTML_RE),
    ];
    rules
        .into_iter()
        .find_map(|(mode, re)| re.is_match(trimmed).then_some(mode))
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
