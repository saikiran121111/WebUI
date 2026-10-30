//! The search pair: `GET /api/ruke/search` ⇔ `app/api/search/route.ts`
//! and `POST /api/ruke/search-more` ⇔ `app/api/search-more/route.ts`.
//! Both are byte-mirrors of the TS handlers, including their error bodies
//! and key ORDER (serde_json `Map` insertion order ⇔ the TS object
//! literals). Until Part 8 the plain paths stay Next-owned; the Rust
//! mounts live under the Rust-only `/api/ruke` namespace like the other
//! Part-7/8 services.
//!
//! RECORDED DIVERGENCES (see also MIGRATION-MAP Part-8 notes):
//! - `/search` `raw=1` path: the TS `catch ⇒ 502 {"error":"Search
//!   unavailable",…}` arm is UNREACHABLE in Rust —
//!   `run_general_web_search` is infallible (every engine failure already
//!   degrades internally exactly like the TS per-engine catches).
//! - `/search-more`: TS passes `req.signal` to the pipeline; the Rust
//!   route buffers the whole body before research starts, so a client
//!   abort mid-pipeline is not wired (flag left `None`).
//! - `/search-more` pipeline failure: TS has NO try/catch around
//!   `runWebResearch`, so a throw escapes to Next ⇒ 500 with Next's HTML
//!   error body. The Rust route logs and answers 500 with an EMPTY body —
//!   same status, body differs (Next dev HTML is not reproducible and is
//!   not a JSON contract).

use std::time::Instant;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use ruke_websearch::pipeline::{evidence_block, run_web_research};
use ruke_websearch::search_gate::SearchGateOptions;
use ruke_websearch::types::SearchGateContext;

use crate::chat::handler::{read_capped, MAX_CHAT_BODY};
use crate::chat::pipeline::{citation_map_from, wire_str};
use crate::AppState;

/// ⇔ TS `new URL(req.url).searchParams` + `sp.get(...)` (FIRST occurrence
/// of each key wins; `sp.get` returns `null` when absent).
fn param(query: &str, key: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

pub async fn search_get(State(state): State<AppState>, req: Request) -> Response {
    let query = req.uri().query().unwrap_or("");
    // TS `if (!query) return { results: [] }` — an empty-string `?q=` is
    // falsy in JS, so the filter is part of the contract, not validation.
    let q = param(query, "q").filter(|s| !s.is_empty());
    let q = match q {
        Some(q) => q,
        None => return Json(json!({ "results": [] })).into_response(),
    };

    if param(query, "raw").as_deref() == Some("1") {
        // Raw engine pass: infallible in Rust (RECORDED divergence above —
        // the TS 502 catch arm cannot fire). RawSearchResult serializes
        // camelCase with `publishedDate` skipped when absent, same wire.
        let results = ruke_websearch::engines::run_general_web_search(&state.web.net, &q).await;
        return Json(json!({ "query": q, "results": results })).into_response();
    }

    let gate_options = SearchGateOptions {
        endpoint: state.settings.llm_api_url(),
        api_key: state.settings.llm_api_key(),
        gate_disabled: None,
    };
    let ctx = SearchGateContext {
        user_prompt: q,
        history: None,
        has_image_attachment: None,
        // User-initiated search route: never an attachment turn.
        has_attachment_evidence: None,
        // Universal search pre-gate: None ⇒ real runtime date at gate time.
        current_date: None,
        image_data_urls: None,
    };
    let result = run_web_research(
        &state.http,
        &gate_options,
        &state.web.net,
        state.web.cache.as_ref(),
        &state.web.verticals,
        state.web.bridge.as_ref(),
        &ctx,
        None,
        None,
    )
    .await;
    match result {
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("Search pipeline failed: {err}") })),
        )
            .into_response(),
        Ok(None) => Json(json!({
            "evidenceBlock": "No web evidence could be retrieved.",
            "webCitations": {},
        }))
        .into_response(),
        Ok(Some(bundle)) => {
            let d = &bundle.search_gate.decision;
            Json(json!({
                "evidenceBlock": evidence_block(&bundle),
                "webCitations": citation_map_from(&bundle),
                "searchGate": {
                    "source": wire_str(&bundle.search_gate.source),
                    "depth": wire_str(&d.depth),
                    "freshness": wire_str(&d.freshness),
                    // queries here are PLAIN STRINGS on this route's wire
                    // (the chat header's are {query,intent} objects — both
                    // match their own TS shape).
                    "queries": d.queries.iter().map(|q| q.query.clone()).collect::<Vec<_>>(),
                },
            }))
            .into_response()
        }
    }
}

pub async fn search_more_post(State(state): State<AppState>, req: Request) -> Response {
    let raw = match read_capped(req.into_body(), MAX_CHAT_BODY).await {
        Some(b) => b,
        None => {
            tracing::warn!("search-more request body read failed or exceeded the size cap");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let body: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Malformed JSON body" })),
            )
                .into_response();
        }
    };
    // TS `Array.isArray(x) ? x.filter(typeof s === "string").slice(0, 3)
    // : []` — FILTER FIRST, then slice (non-strings don't consume slots).
    let queries: Vec<String> = body
        .get("queries")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|q| q.as_str().map(str::to_string))
                .take(3)
                .collect()
        })
        .unwrap_or_default();
    if queries.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "queries array is required (1-3 string entries)" })),
        )
            .into_response();
    }

    let started = Instant::now();
    let gate_options = SearchGateOptions {
        endpoint: state.settings.llm_api_url(),
        api_key: state.settings.llm_api_key(),
        gate_disabled: None,
    };
    let ctx = SearchGateContext {
        user_prompt: queries.join(" "),
        history: None,
        has_image_attachment: None,
        // User-initiated search route: never an attachment turn.
        has_attachment_evidence: None,
        // Universal search pre-gate: None ⇒ real runtime date at gate time.
        current_date: None,
        image_data_urls: None,
    };
    let result = run_web_research(
        &state.http,
        &gate_options,
        &state.web.net,
        state.web.cache.as_ref(),
        &state.web.verticals,
        state.web.bridge.as_ref(),
        &ctx,
        None,
        None, // RECORDED: TS threads req.signal; see module header
    )
    .await;
    // TS `ms = Math.round(performance.now() - t0)` (integer ms).
    let ms = Value::from(started.elapsed().as_millis() as i64);

    match result {
        // RECORDED divergence: TS lets this throw to Next (500 + HTML);
        // we log and answer a bare 500.
        Err(err) => {
            tracing::error!(err = %err, "search-more pipeline failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Ok(None) => Json(json!({
            "evidenceBlock": "No web evidence could be retrieved for the follow-up queries.",
            "webCitations": {},
            "ms": ms,
        }))
        .into_response(),
        Ok(Some(bundle)) => {
            tracing::info!(
                ms = ms.as_i64().unwrap_or_default(),
                queries = queries.len() as u64,
                results = bundle.search_results.len() as u64,
                "search-more complete"
            );
            Json(json!({
                "evidenceBlock": evidence_block(&bundle),
                "webCitations": citation_map_from(&bundle),
                "ms": ms,
            }))
            .into_response()
        }
    }
}
