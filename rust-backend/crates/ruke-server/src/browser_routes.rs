//! browser_routes.rs — the HTTP surface of the Browser Use engine
//! (Phase 2): `POST /api/ruke/browser/command`, the RPC the Next browser
//! panel and (Phase 10) the Rust tool loop ride. The command contract
//! itself — envelope validation, metadata gate, payload decode — lives
//! in `ruke_browser::contract`; this handler only transports.
//!
//! Auth model: the supervisor-generated process-local bridge secret,
//! reusing the exact constants as every other internal loopback hop
//! (`ruke_websearch::browser_bridge::{SECRET_HEADER, ENV_SECRET}`).
//! Env unset ⇒ the header check is skipped — this server binds loopback
//! only (main.rs), which is the same protection stance as its other
//! routes; the secret is what *adds* the check when the supervisor
//! exports it. Rule 17: log booleans, never the secret or header value.
//!
//! Wire contract: browser-RPC errors ride the envelope with HTTP 200
//! (`{"ok":false,"error_code":…,"message":…}`) — the model/panel layer
//! keys off `error_code`, never status. HTTP status is reserved for
//! transport-level failures (401 auth, 413 oversized body).

use axum::extract::State;
use axum::http::{header::HeaderName, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use bytes::Bytes;
use serde_json::{json, Value};

use ruke_browser::contract::parse_envelope;
use ruke_browser::errors::BrowserError;

use crate::AppState;

pub async fn command_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(expected) = bridge_secret() {
        let presented = headers
            .get(HeaderName::from_static(
                ruke_websearch::browser_bridge::SECRET_HEADER,
            ))
            .and_then(|v| v.to_str().ok());
        if presented != Some(expected.as_str()) {
            tracing::warn!("browser command rejected: bridge secret mismatch");
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response();
        }
    }

    // A body that is not JSON is still an envelope error on the wire —
    // the RPC contract says errors are answers, not HTTP failures.
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return wire_error(&BrowserError::BadEnvelope),
    };
    let envelope = match parse_envelope(&value) {
        Ok(env) => env,
        Err(e) => return wire_error(&e),
    };
    match state
        .browser
        .command(&envelope.session_id, &envelope.turn_id, &envelope.command)
        .await
    {
        Ok(data) => (StatusCode::OK, Json(json!({ "ok": true, "data": data }))).into_response(),
        Err(e) => wire_error(&e),
    }
}

fn wire_error(e: &BrowserError) -> Response {
    (StatusCode::OK, Json(e.to_wire())).into_response()
}

/// Some(secret configured) / None(dev mode: loopback bind is the guard).
/// Never log the value — Rule 17.
fn bridge_secret() -> Option<String> {
    std::env::var(ruke_websearch::browser_bridge::ENV_SECRET)
        .ok()
        .filter(|s| !s.is_empty())
}
