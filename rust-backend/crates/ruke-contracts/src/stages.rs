//! SSE progress-stage contract — mirror of `StageEvent` (`lib/types.ts:272`)
//! and the frame writers in `app/api/chat/route.ts` (`ruke_stage`,
//! `ruke_error`, `web_meta`). Rule 2.3 of the migration map is the spec.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::decision::RendererMode;

/// `[S1]…[Sn]` citation map carried by `web_meta` and `X-Web-Citations`.
pub type CitationMap = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub source_id: String,
    pub url: String,
    pub title: String,
    pub domain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

/// Search-gate summary (`ResearchMeta` in the chat route): shown collapsed
/// in the Research Trail card. `decidedBy` is omitted when absent (TS `?`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchMeta {
    pub depth: String,
    pub freshness: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    pub queries: Vec<GateQuery>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GateQuery {
    pub query: String,
    pub intent: String,
}

/// Exact `StageEvent` shape: every optional TS field is
/// `skip_serializing_if = "none"` because `JSON.stringify` drops `undefined`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageEvent {
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<RendererMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<f64>,
    /// `browser:*` frames (Phase-10 tool loop) only: the browser session
    /// (conversation id) the model's browser activity belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_citations: Option<CitationMap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_gate: Option<ResearchMeta>,
}

impl StageEvent {
    pub fn new(stage: impl Into<String>) -> Self {
        Self {
            stage: stage.into(),
            detail: None,
            mode: None,
            ms: None,
            done: None,
            total: None,
            coverage: None,
            session: None,
            url: None,
            domain: None,
            web_citations: None,
            search_gate: None,
        }
    }
}

/// `"data: " + JSON.stringify({ruke_stage}) + "\n\n"` framing is built in
/// the server crate; these helpers pin the JSON body shape only.
pub fn stage_frame(e: &StageEvent) -> Value {
    serde_json::json!({ "ruke_stage": e })
}

pub fn error_frame(message: &str) -> Value {
    serde_json::json!({ "ruke_error": { "message": message } })
}

/// The `web_meta` frame the progress path emits when citations exist
/// (headers carry citations ONLY on the legacy non-stream path — Rule 2.3).
pub fn web_meta_frame(citations: CitationMap, gate: Option<ResearchMeta>) -> Value {
    let mut ev = StageEvent::new("web_meta");
    ev.web_citations = Some(citations);
    ev.search_gate = gate;
    stage_frame(&ev)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_event_omits_every_absent_field_and_matches_ts_shape() {
        let mut e = StageEvent::new("decision_done");
        e.mode = Some(RendererMode::StandardChat);
        e.ms = Some(0);
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"stage":"decision_done","mode":"standard_chat","ms":0}"#
        );
        let e2 = StageEvent::new("retrieval");
        assert_eq!(serde_json::to_string(&e2).unwrap(), r#"{"stage":"retrieval"}"#);
    }

    #[test]
    fn frame_envelopes_are_exact() {
        let f = stage_frame(&StageEvent::new("web:gate"));
        assert_eq!(f, serde_json::json!({ "ruke_stage": { "stage": "web:gate" } }));
        let e = error_frame("Upstream returned 500: boom");
        assert_eq!(e, serde_json::json!({ "ruke_error": { "message": "Upstream returned 500: boom" } }));
    }

    #[test]
    fn web_meta_uses_camelcase_web_citations_and_optional_search_gate() {
        let mut cites = CitationMap::new();
        let c = Citation {
            source_id: "S1".into(),
            url: "https://example.com/a".into(),
            title: "A".into(),
            domain: "example.com".into(),
            published_at: None,
        };
        cites.insert("S1".into(), serde_json::to_value(&c).unwrap());
        let f = web_meta_frame(cites, None);
        assert!(f["ruke_stage"].get("webCitations").is_some());
        assert!(f["ruke_stage"].get("searchGate").is_none());
        assert!(!f["ruke_stage"]["webCitations"]["S1"].get("publishedAt").is_some_and(|v| !v.is_null()));

        let gate = ResearchMeta {
            depth: "deep".into(),
            freshness: "week".into(),
            decided_by: None,
            queries: vec![GateQuery { query: "q".into(), intent: "news".into() }],
        };
        let g = serde_json::to_string(&gate).unwrap();
        assert_eq!(
            g,
            r#"{"depth":"deep","freshness":"week","queries":[{"query":"q","intent":"news"}]}"#
        );
    }
}
