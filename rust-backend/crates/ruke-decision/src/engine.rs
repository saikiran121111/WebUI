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
//! so consuming them is safe). `\w*` becomes `[A-Za-z0-9_]*`. JS's `.`
//! excludes CR, LF, U+2028 and U+2029, while Rust's `.` excludes only LF
//! — the 3d_asset bridging `.*` is therefore spelled
//! `[^\r\n\u{2028}\u{2029}]*` to match.
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
//! First-match precedence follows `INTENT_ORDER` (chart BEFORE 3d_asset
//! and cad_blueprint; pdf BEFORE ppt).

use std::sync::LazyLock;
use std::time::Instant;

use regex::Regex;
use serde_json::Value;

use ruke_contracts::decision::{mode_skill, DecisionEnvelope, RendererMode};
use ruke_skills::jsstr::js_trim;

static EXCEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^A-Za-z0-9_])(?:spreadsheet|excel|[.]xlsx|workbook|xlsx)(?:[^A-Za-z0-9_]|$)").unwrap()
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
/// Branch 3 of the TS matcher is `\b(?:render|model|visualise|visualize)\b`
/// `.*` `\b(?:3d|scene|mesh)\b`. A naive port that consumes the verb's
/// trailing boundary breaks "render scene": the SINGLE space serves as both
/// the verb's trailing `\b` and the target's leading `\b`. Look-around is
/// unavailable in the Rust crate, so the bridging `.*` is restructured into
/// an explicit bridge — at least one non-word, non-line-terminator char
/// directly after the verb, optional same-line filler, and a final non-word
/// char directly before the target (the one-space case collapses both
/// boundary requirements onto the same char, matching JS). The bridge
/// excludes CR/LF/U+2028/U+2029, so `.` parity keeps "render\nscene"
/// unmatched.
static ASSET3D_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:(?:^|[^A-Za-z0-9_])3d(?:[^A-Za-z0-9_]|$)",
        r"|(?:^|[^A-Za-z0-9_])three[.]?js(?:[^A-Za-z0-9_]|$)",
        r"|(?:^|[^A-Za-z0-9_])(?:render|model|visualise|visualize)",
        r"[^A-Za-z0-9_\r\n\u{2028}\u{2029}]",
        r"(?:[^\r\n\u{2028}\u{2029}]*[^A-Za-z0-9_\r\n\u{2028}\u{2029}])?",
        r"(?:3d|scene|mesh)(?:[^A-Za-z0-9_]|$))"
    ))
    .unwrap()
});
static CAD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^A-Za-z0-9_])(?:floor ?plan|architect[A-Za-z0-9_]*|blueprint|building|room layout|interior)(?:[^A-Za-z0-9_]|$)").unwrap()
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
        (RendererMode::Asset3D, &*ASSET3D_RE),
        (RendererMode::CadBlueprint, &*CAD_RE),
        (RendererMode::HtmlRender, &*HTML_RE),
    ];
    rules.into_iter().find_map(|(mode, re)| re.is_match(trimmed).then_some(mode))
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
        assert_eq!(mode_for("threejss"), RendererMode::StandardChat);
        assert_eq!(mode_for("3 d"), RendererMode::StandardChat);
        // JS `.` never crosses \n: the render…scene bridge stays line-local
        assert_eq!(mode_for("render\nscene"), RendererMode::StandardChat);
        assert_eq!(mode_for("render scene"), RendererMode::Asset3D);
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
        // pdf (2) before cad (6): interior+pdf stays pdf
        assert_eq!(mode_for("the interior of the pdf"), RendererMode::Pdf);
        // chart (4) before 3d (5) and cad (6)
        assert_eq!(mode_for("3d chart"), RendererMode::Chart);
        assert_eq!(mode_for("chart of this building's architecture"), RendererMode::Chart);
        // excel (0) beats chart (4)
        assert_eq!(mode_for("spreadsheet and a chart"), RendererMode::Excel);
        // 3d (5) before cad (6)
        assert_eq!(mode_for("3D building model"), RendererMode::Asset3D);
        // cad (6) before html (7)
        assert_eq!(mode_for("interior design with html"), RendererMode::CadBlueprint);
        // architect[w]* ascii star: "architectural" still cad
        assert_eq!(mode_for("an architectural sketch"), RendererMode::CadBlueprint);
        // no match at all
        assert_eq!(mode_for("tell me a joke"), RendererMode::StandardChat);
        assert_eq!(intent_for("a model of the city"), None); // no 3d/scene/mesh after model
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
        assert_eq!(env.disable_validators.len(), 8);
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
        assert_eq!((r.status, r.body.as_str()), (400, "{\"error\":\"message required\"}"));

        let r = decision_route("{\"history\":[]}"); // no `message` key at all
        assert_eq!((r.status, r.body.as_str()), (400, "{\"error\":\"message required\"}"));

        let r = decision_route("\"just a string\""); // non-object body
        assert_eq!((r.status, r.body.as_str()), (400, "{\"error\":\"message required\"}"));
    }

    #[test]
    fn route_success_is_compact_json_with_full_envelope_shape() {
        let r = decision_route(&json!({ "message": "make a deck" }).to_string());
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"active_mode\":\"ppt\""));
        assert!(r.body.contains("\"decided_by\":\"in-process-deliverable-match\""));
        assert!(r.body.contains("\"skill_to_load\":\"pptx\""));
        assert!(!r.body.contains('\n')); // compact == JSON.stringify
    }
}
