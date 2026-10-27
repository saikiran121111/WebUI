//! `streamHeaders` from `app/api/chat/route.ts:61` (application headers).
//!
//! Part 4 ships exactly the header set the Part-4 corpus pins:
//! content-type (upstream's on the legacy path, `text/event-stream` on the
//! progress path), `Cache-Control: no-cache, no-transform`,
//! `Connection: keep-alive`, `X-Accel-Buffering: no`, `x-decision-mode`,
//! and the user-tier-only `X-Used-Skill`.
//!
//! Part 8 wired the web-gate pair (Rule 2.3): `X-Web-Citations`
//! (`encodeURIComponent(JSON.stringify(map))`, only when the map is
//! truthy AND non-empty — an EMPTY map skips the header but an empty map
//! is still "truthy" for the `searchGate ? …` gate pairing) and
//! `X-Search-Gate` appear on the LEGACY path only, fed by
//! `forward_legacy`'s citation/gate parameters. The progress path NEVER
//! carries them (TS's progress headers are built before the gate runs;
//! the citations ride the `web_meta` frame instead).

use axum::http::{HeaderMap, HeaderName, HeaderValue};

use ruke_contracts::stages::{CitationMap, ResearchMeta};

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

/// `encodeURIComponent`: the unreserved set `A-Za-z0-9-_.!~*'()` passes
/// through; every other UTF-8 byte becomes `%XX` (uppercase hex). Same
/// implementation the ruke-websearch port uses for the search-route pair,
/// so header values and fixture comparisons stay byte-identical. (TS's
/// lone-surrogate TypeError is unreachable here: a Rust `String` cannot
/// carry unpaired surrogates, and `JSON.stringify` escapes any surrogate
/// pair member that could reach the encoder into ASCII `\uXXXX`.)
fn js_encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(b) {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Mirror of `streamHeaders(contentType ?? "text/event-stream", usedSkill,
/// decisionMode, webCitations, searchGate)`. The last two are the LEGACY
/// path only; `None` on the progress path.
pub fn stream_headers(
    content_type: Option<&str>,
    used_skill: Option<&str>,
    decision_mode: &str,
    web_citations: Option<&CitationMap>,
    search_gate: Option<&ResearchMeta>,
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
    // TS: `if (webCitations && Object.keys(webCitations).length > 0)`.
    // `Some(empty)` is the truthy-empty-map case: NO citations header, but
    // the gate header still rides when `search_gate` is Some (TS passes
    // `searchGate` through whenever the citations arg is non-null).
    if let Some(c) = web_citations {
        if !c.is_empty() {
            insert(
                &mut h,
                HeaderName::from_static("x-web-citations"),
                &js_encode_uri_component(&serde_json::to_string(c).unwrap_or_default()),
            );
        }
    }
    if let Some(g) = search_gate {
        insert(
            &mut h,
            HeaderName::from_static("x-search-gate"),
            &js_encode_uri_component(&serde_json::to_string(g).unwrap_or_default()),
        );
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cite(source_id: &str, url: &str) -> CitationMap {
        let mut m = CitationMap::new();
        m.insert(
            source_id.to_string(),
            serde_json::json!({
                "sourceId": source_id, "url": url, "title": "t", "domain": "d.example"
            }),
        );
        m
    }

    fn gate() -> ResearchMeta {
        ResearchMeta {
            depth: "quick".into(),
            freshness: "any".into(),
            decided_by: Some("main-model".into()),
            queries: vec![ruke_contracts::stages::GateQuery {
                query: "q one? &x".into(),
                intent: "news".into(),
            }],
        }
    }

    #[test]
    fn progress_headers_exact_order_and_defaults() {
        let h = stream_headers(None, None, "chart", None, None);
        assert_eq!(h[axum::http::header::CONTENT_TYPE], "text/event-stream");
        assert_eq!(h[axum::http::header::CACHE_CONTROL], "no-cache, no-transform");
        assert_eq!(h[axum::http::header::CONNECTION], "keep-alive");
        assert_eq!(h["x-accel-buffering"], "no");
        assert_eq!(h["x-decision-mode"], "chart");
        assert!(!h.contains_key("x-used-skill"));
    }

    #[test]
    fn upstream_content_type_and_used_skill_pass_through() {
        let h = stream_headers(Some("application/json"), Some("pdf-report"), "pdf", None, None);
        assert_eq!(h[axum::http::header::CONTENT_TYPE], "application/json");
        assert_eq!(h["x-used-skill"], "pdf-report");
    }

    #[test]
    fn web_gate_headers_encode_like_the_ts_wire() {
        // The map value is the compact JSON, encodeURIComponent'd — the
        // TS header is `encodeURIComponent(JSON.stringify(map))`.
        let h = stream_headers(None, None, "research_chat", Some(&cite("S1", "https://x.example/a?b=1&c=2")), Some(&gate()));
        assert_eq!(
            h["x-web-citations"],
            "%7B%22S1%22%3A%7B%22sourceId%22%3A%22S1%22%2C%22url%22%3A%22https%3A%2F%2Fx.example%2Fa%3Fb%3D1%26c%3D2%22%2C%22title%22%3A%22t%22%2C%22domain%22%3A%22d.example%22%7D%7D"
        );
        assert_eq!(
            h["x-search-gate"],
            "%7B%22depth%22%3A%22quick%22%2C%22freshness%22%3A%22any%22%2C%22decidedBy%22%3A%22main-model%22%2C%22queries%22%3A%5B%7B%22query%22%3A%22q%20one%3F%20%26x%22%2C%22intent%22%3A%22news%22%7D%5D%7D"
        );
    }

    #[test]
    fn empty_citation_map_skips_its_header_but_not_the_gate() {
        // TS `webCitations && Object.keys(webCitations).length > 0` is
        // FALSE for `{}`, but the gate arg stays non-null (the handler
        // pairs them), so x-search-gate still rides.
        let empty = CitationMap::new();
        let h = stream_headers(None, None, "research_chat", Some(&empty), Some(&gate()));
        assert!(!h.contains_key("x-web-citations"));
        assert!(h.contains_key("x-search-gate"));

        // Null pair: neither header exists on the progress / no-gate paths.
        let h = stream_headers(None, None, "standard_chat", None, None);
        assert!(!h.contains_key("x-web-citations"));
        assert!(!h.contains_key("x-search-gate"));
    }
}
