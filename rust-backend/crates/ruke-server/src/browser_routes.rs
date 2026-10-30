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

use std::collections::HashMap;

use axum::extract::{Query, State, WebSocketUpgrade};
use axum::extract::ws::{Message, WebSocket};
use axum::http::{header, header::HeaderName, HeaderMap, StatusCode};
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
    if !bridge_ok(&headers) {
        return unauthorized();
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

/// Bridge-secret gate shared by the RPC and the ticket hop. Rule 17:
/// log a boolean, never the secret or the presented header value.
fn bridge_ok(headers: &HeaderMap) -> bool {
    let Some(expected) = bridge_secret() else {
        return true; // dev mode: the loopback bind is the guard
    };
    let presented = headers
        .get(HeaderName::from_static(
            ruke_websearch::browser_bridge::SECRET_HEADER,
        ))
        .and_then(|v| v.to_str().ok());
    if presented != Some(expected.as_str()) {
        tracing::warn!("browser RPC rejected: bridge secret mismatch");
        return false;
    }
    true
}

/// Auth failures are the only status-code failures on this surface
/// (the wire contract keeps command errors on HTTP 200).
fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response()
}

/// Some(secret configured) / None(dev mode: loopback bind is the guard).
/// Never log the value — Rule 17.
fn bridge_secret() -> Option<String> {
    std::env::var(ruke_websearch::browser_bridge::ENV_SECRET)
        .ok()
        .filter(|s| !s.is_empty())
}

// ── Browser Panel socket (Phase 3) ─────────────────────────────────────────
// The panel mints a one-shot ticket over the bridge-authed HTTP hop, then
// opens the WebSocket DIRECTLY against this loopback server (Next cannot
// proxy a WS upgrade — rustProxy strips `upgrade`). A WS handshake cannot
// carry the bridge-secret header, so the ticket plus an Origin allowlist
// are the socket's admission gates. Rule 17: a ticket is secret material
// — log booleans only, never its value.

/// Hand a one-shot panel-socket ticket to the authenticated caller.
pub async fn ws_ticket_post(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !bridge_ok(&headers) {
        return unauthorized();
    }
    let (ticket, ttl_ms) = state.browser.ws_ticket();
    // The panel dials this server directly; same port main.rs bound
    // (RUKE_BACKEND_PORT-aware), same loopback-only stance.
    let ws_url = format!(
        "ws://127.0.0.1:{}/api/ruke/browser/ws",
        ruke_core::config::backend_port()
    );
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "data": { "ws_url": ws_url, "ticket": ticket, "ttl_ms": ttl_ms },
        })),
    )
        .into_response()
}

/// Panel WebSocket admission: Origin allowlist first (fail-closed on a
/// missing Origin — browsers always send one on WS upgrades), then the
/// one-shot ticket. Refusals are 403 BEFORE the upgrade so the panel
/// sees a real HTTP status, never a half-open socket.
pub async fn ui_ws_get(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !origin_allowed(origin) {
        tracing::warn!(origin = %origin, "browser panel WS rejected: origin not allowed");
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "origin_not_allowed" })),
        )
            .into_response();
    }
    let ticket_ok = query
        .get("ticket")
        .is_some_and(|t| state.browser.claim_ws_ticket(t));
    if !ticket_ok {
        // Booleans only — the ticket itself is never logged (Rule 17).
        tracing::warn!("browser panel WS rejected: ticket invalid or expired");
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "invalid_or_expired_ticket" })),
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| serve_ui_socket(socket, state))
}

/// Env RUKE_BROWSER_UI_ORIGINS: comma-separated exact origins. The
/// default matches the dev WebUI origin; a missing/empty Origin fails
/// closed. This is CSRF-shaped defense for a loopback socket: any page
/// in the user's browser could otherwise dial 127.0.0.1:port and —
/// without the Origin check — attempt the upgrade (the ticket still
/// gates it, but defense is layered, not single).
fn origin_allowed(origin: &str) -> bool {
    if origin.is_empty() {
        return false;
    }
    let list = std::env::var("RUKE_BROWSER_UI_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:3000,http://127.0.0.1:3000".into());
    list.split(',')
        .map(str::trim)
        .any(|o| !o.is_empty() && o == origin)
}

/// The panel socket loop: hub frames/tab broadcasts out, client
/// messages in. The initial tab snapshot rides immediately — later
/// changes arrive as `tabs_changed` broadcasts, so the panel never
/// polls. Closing (any path) unregisters the client, which stops the
/// screencasts it was the last viewer of.
async fn serve_ui_socket(mut socket: WebSocket, state: AppState) {
    let (client, mut hub_rx) = state.browser.ui_open();
    let snapshot = match serde_json::to_string(&state.browser.ui_tabs_snapshot()) {
        Ok(text) => text,
        Err(e) => {
            tracing::warn!(error = %e, "tab snapshot serialization failed; closing panel socket");
            state.browser.ui_close(client).await;
            return;
        }
    };
    if socket.send(Message::Text(snapshot.into())).await.is_err() {
        state.browser.ui_close(client).await;
        return;
    }
    loop {
        tokio::select! {
            msg = hub_rx.recv() => {
                let Some(value) = msg else { break };
                let Ok(text) = serde_json::to_string(&value) else { continue };
                if socket.send(Message::Text(text.into())).await.is_err() {
                    break; // viewer gone; the hub also prunes on fan-out
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_ui_message(&state, client, text.as_str(), &mut socket).await;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {} // binary/ping/pong: protocol is text-only
                }
            }
        }
    }
    state.browser.ui_close(client).await;
}

/// One protocol turn: `subscribe` / `unsubscribe` / `input` / `ping`.
/// Successes answer `subscribed` / `pong` (input is fire-and-observe:
/// its effect shows up as frames + tab broadcasts, exactly like the
/// model-facing contract); refusals ride the SAME typed error wire as
/// the command RPC, tagged `"type":"error"` for the panel to key off.
async fn handle_ui_message(state: &AppState, client: u64, text: &str, socket: &mut WebSocket) {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            send_ui_error(
                socket,
                &BrowserError::PayloadInvalid {
                    command: "browser_ui_message".into(),
                    reason: "message is not valid JSON".into(),
                },
            )
            .await;
            return;
        }
    };
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let tab_id = value.get("tab_id").and_then(Value::as_str).unwrap_or("");
    let result = match kind {
        "subscribe" => state
            .browser
            .ui_subscribe(client, tab_id)
            .await
            .map(|tab| Some(json!({ "type": "subscribed", "tab": tab }))),
        "unsubscribe" => state
            .browser
            .ui_unsubscribe(client, tab_id)
            .await
            .map(|()| None),
        "input" => match value.get("event") {
            Some(event) => state
                .browser
                .ui_input(client, tab_id, event)
                .await
                .map(|()| None),
            None => Err(BrowserError::PayloadInvalid {
                command: "browser_ui_input".into(),
                reason: "input message carries no \"event\" object".into(),
            }),
        },
        "ping" => Ok(Some(json!({ "type": "pong" }))),
        other => Err(BrowserError::PayloadInvalid {
            command: "browser_ui_message".into(),
            reason: format!("unknown message type {other:?}"),
        }),
    };
    match result {
        Ok(Some(answer)) => {
            if let Ok(text) = serde_json::to_string(&answer) {
                let _ = socket.send(Message::Text(text.into())).await;
            }
        }
        // unsubscribe/input successes are observable in the stream
        // themselves (tab broadcast / frames); no ack frame is owed.
        Ok(None) => {}
        Err(e) => send_ui_error(socket, &e).await,
    }
}

/// Typed panel refusal: the same `to_wire()` shape as the RPC plus
/// `"type":"error"`. Rule 17: no ticket/secret material ever reaches
/// here — BrowserError messages are command-scoped by construction.
async fn send_ui_error(socket: &mut WebSocket, e: &BrowserError) {
    let mut wire = e.to_wire();
    if let Some(obj) = wire.as_object_mut() {
        obj.insert("type".into(), json!("error"));
    }
    if let Ok(text) = serde_json::to_string(&wire) {
        let _ = socket.send(Message::Text(text.into())).await;
    }
}
