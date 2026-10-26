//! `streamHeaders` from `app/api/chat/route.ts:61` (application headers).
//!
//! Part 4 ships exactly the header set the Part-4 corpus pins:
//! content-type (upstream's on the legacy path, `text/event-stream` on the
//! progress path), `Cache-Control: no-cache, no-transform`,
//! `Connection: keep-alive`, `X-Accel-Buffering: no`, `x-decision-mode`,
//! and the user-tier-only `X-Used-Skill`.
//!
//! PART-6 SEAM (insertion point, not implemented here): `X-Web-Citations`
//! (encodeURIComponent(JSON.stringify(map))) and `X-Search-Gate` appear on
//! the LEGACY path only when the web-research gate produced citations —
//! Rule 2.3 of the migration map. `forward_legacy` threads no citation map
//! yet for exactly that reason.

use axum::http::{HeaderMap, HeaderName, HeaderValue};

/// The completion sentinel. Producers own it: the upstream's own
/// `data: [DONE]` passes through the raw-bytes path verbatim, and `fail`
/// emits it exactly once on the error path — the route NEVER appends its
/// own `[DONE]` after raw bytes.
pub const DONE_FRAME: &[u8] = b"data: [DONE]\n\n";

fn insert(h: &mut HeaderMap, name: HeaderName, value: &str) {
    // A non-ASCII value (only reachable via a hostile settings value) is
    // dropped rather than panicking; header NAMES here are all static.
    if let Ok(v) = HeaderValue::from_str(value) {
        h.insert(name, v);
    }
}

/// Mirror of `streamHeaders(contentType ?? "text/event-stream", usedSkill,
/// decisionMode)`.
pub fn stream_headers(
    content_type: Option<&str>,
    used_skill: Option<&str>,
    decision_mode: &str,
) -> HeaderMap {
    let mut h = HeaderMap::new();
    insert(&mut h, axum::http::header::CONTENT_TYPE, content_type.unwrap_or("text/event-stream"));
    insert(&mut h, axum::http::header::CACHE_CONTROL, "no-cache, no-transform");
    insert(&mut h, axum::http::header::CONNECTION, "keep-alive");
    insert(&mut h, HeaderName::from_static("x-accel-buffering"), "no");
    insert(&mut h, HeaderName::from_static("x-decision-mode"), decision_mode);
    // Slash-routed user skill only — decision-engine core skills NEVER ride
    // this header (strict-invisibility rule, project CLAUDE.md §2.2).
    if let Some(s) = used_skill {
        insert(&mut h, HeaderName::from_static("x-used-skill"), s);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_headers_exact_order_and_defaults() {
        let h = stream_headers(None, None, "chart");
        assert_eq!(h[axum::http::header::CONTENT_TYPE], "text/event-stream");
        assert_eq!(h[axum::http::header::CACHE_CONTROL], "no-cache, no-transform");
        assert_eq!(h[axum::http::header::CONNECTION], "keep-alive");
        assert_eq!(h["x-accel-buffering"], "no");
        assert_eq!(h["x-decision-mode"], "chart");
        assert!(!h.contains_key("x-used-skill"));
    }

    #[test]
    fn upstream_content_type_and_used_skill_pass_through() {
        let h = stream_headers(Some("application/json"), Some("pdf-report"), "pdf");
        assert_eq!(h[axum::http::header::CONTENT_TYPE], "application/json");
        assert_eq!(h["x-used-skill"], "pdf-report");
    }
}
