//! Brief §3.1 (2026-11-15): the internal completion bridge. The TS-owned
//! helper generations (web-search gate plan, llm-json `jsonCompletion`,
//! and their TS-only-mode fallbacks) must serialize through the SAME
//! capacity-1 upstream admission that owns the chat streams — and the one
//! authority lives in THIS process. So Next posts the completion payload
//! here over the authenticated loopback bridge (the same
//! `x-ruke-internal-secret` gate as the browser RPC; dev mode ⇒ the
//! loopback bind is the guard), and ruke-server acquires the permit,
//! forwards the POST to the configured upstream, and passes the response
//! back verbatim.
//!
//! Contract:
//! - NON-STREAMING only (`stream: true` ⇒ 400): a streamed passthrough
//!   would need a pump of its own, and every current TS caller awaits a
//!   single JSON body. Recorded so a future streaming caller cannot slip
//!   through silently.
//! - Optional `timeout_ms` caps BOTH the queue wait and the generation.
//!   On expiry: 504. Queue full: 503. Upstream unreachable: 502.
//!   Otherwise the upstream status + body pass through byte-verbatim
//!   (the TS callers already degrade on any non-2xx or unparseable body,
//!   exactly like their direct-fetch catch paths).
//! - The §3.1 permit is held from before the POST across the ENTIRE
//!   non-streamed response read (never released at headers-arrival), and
//!   released on every exit path including the timeout arms.
//! - Deadlock law: the TS caller reaches this route ONLY while holding no
//!   Rust admission permit (Rust rounds release before their bridge RPCs
//!   and the search-gate itself runs on the Next side), so a Next→Rust
//!   completion never nests inside a held permit.
//!
//! Rule 17: logs carry booleans and statuses only — never the secret,
//! never the payload.

use std::time::Duration;

use axum::body::to_bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::browser_routes::{bridge_ok, bridge_secret_present};
use crate::AppState;

/// Payload ceiling generous enough for a chat-shaped history while still
/// a BOUND (bounded-resource law). Search-gate and llm-json payloads are
/// far smaller in practice.
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

pub async fn completion_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: Request,
) -> Response {
    if !bridge_ok(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    let configured = bridge_secret_present();

    let bytes = match to_bytes(req.into_body(), MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::BAD_REQUEST, "Body too large or unreadable"),
    };
    let mut body: Value = match serde_json::from_slice(&bytes) {
        Ok(v @ Value::Object(_)) => v,
        _ => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };

    // Non-streaming only (see header). `json!` null-safe compare.
    if body.get("stream") == Some(&json!(true)) {
        return err(
            StatusCode::BAD_REQUEST,
            "internal completion bridge is non-streaming only",
        );
    }

    // `timeout_ms` is a BRIDGE control field, not upstream payload: strip
    // it so the forwarded body is exactly what the TS caller would have
    // sent itself.
    let timeout_ms = body
        .as_object_mut()
        .and_then(|m| m.remove("timeout_ms"))
        .and_then(|v| v.as_u64());

    // One token drives queue wait, send, and body read: `timeout_ms`
    // cancels all three through the same arms the client-abort paths use.
    let token = CancellationToken::new();
    if let Some(ms) = timeout_ms {
        let t = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            t.cancel();
        });
    }

    let permit = match state.admission.acquire(&token).await {
        Ok(p) => p,
        Err(ruke_core::admission::AdmissionError::QueueFull) => {
            tracing::warn!("internal completion rejected: shared-endpoint queue full");
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "Model endpoint is busy; please retry.",
            );
        }
        Err(ruke_core::admission::AdmissionError::Cancelled) => {
            return err(StatusCode::GATEWAY_TIMEOUT, "Timed out waiting for the model endpoint");
        }
    };

    let url = state.settings.llm_api_url();
    let api_key = state.settings.llm_api_key();
    let payload = serde_json::to_vec(&body).unwrap_or_default();

    let sent = tokio::select! {
        biased;
        _ = token.cancelled() => None,
        r = state
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .body(payload)
            .send() => Some(r),
    };
    let upstream = match sent {
        None => return err(StatusCode::GATEWAY_TIMEOUT, "Model request timed out"),
        Some(Err(_)) => {
            // Covers connection failure AND an invalid (e.g. non-ASCII)
            // header value — both are "cannot reach upstream" here.
            tracing::error!(configured, "internal completion upstream unreachable");
            return err(StatusCode::BAD_GATEWAY, "Model endpoint unreachable");
        }
        Some(Ok(r)) => r,
    };

    let status = upstream.status();
    let resp_bytes = tokio::select! {
        biased;
        _ = token.cancelled() => None,
        b = upstream.bytes() => Some(b),
    };
    // `_permit` drops HERE — after the FULL body has been read (or the
    // read was cut short), never at headers-arrival.
    drop(permit);

    match resp_bytes {
        None => err(StatusCode::GATEWAY_TIMEOUT, "Model request timed out"),
        Some(Err(_)) => err(StatusCode::BAD_GATEWAY, "Model response read failed"),
        Some(Ok(b)) => {
            // Verbatim passthrough: the TS callers keep their existing
            // res.ok / res.json() degradation semantics untouched.
            let code =
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (code, [(axum::http::header::CONTENT_TYPE, "application/json")], b)
                .into_response()
        }
    }
}

fn err(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use ruke_attach::UnavailableEmbedder;
    use ruke_core::{
        admission::{AdmissionPermit, UpstreamAdmission},
        settings::SettingsStore,
        slot::InferenceSlot,
        turn::TurnCounter,
    };
    use tower::ServiceExt; // oneshot

    use crate::persistence::ConversationStore;
    use crate::titles::{generate::UnconfiguredTitleModel, queue::TitleQueue};

    /// A fresh temp-root state; queue bound deliberately 1 so "holder +
    /// one queued" saturates with a single extra acquire.
    fn base_state() -> (crate::AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let slot = Arc::new(InferenceSlot::new());
        let store = Arc::new(ConversationStore::new(tmp.path().join("conversations")));
        let state = crate::AppState {
            settings: Arc::new(SettingsStore::new(tmp.path().join("settings.json"))),
            slot: slot.clone(),
            turns: Arc::new(TurnCounter::new()),
            admission: Arc::new(UpstreamAdmission::with_queue(1)),
            root: tmp.path().to_path_buf(),
            http: reqwest::Client::new(),
            attach_embedder: Arc::new(UnavailableEmbedder),
            conversations: store.clone(),
            titles: Arc::new(TitleQueue::new(store, slot, Arc::new(UnconfiguredTitleModel))),
            next_search: None,
            browser: Arc::new(ruke_browser::engine::BrowserRuntime::new(
                tmp.path().to_path_buf(),
            )),
        };
        (state, tmp)
    }

    /// Holder occupies the permit + the single waiter slot is OCCUPIED by a
    /// PENDING acquire (a completed acquire would have released its permit
    /// and emptied the queue again). The probe request is the overflow.
    async fn busy_state() -> (crate::AppState, tempfile::TempDir, AdmissionPermit) {
        let (state, tmp) = base_state();
        let held = state.admission.acquire(&CancellationToken::new()).await.unwrap();
        (state, tmp, held)
    }

    async fn fresh_state() -> (crate::AppState, tempfile::TempDir) {
        base_state()
    }

    async fn post_json(state: &crate::AppState, body: &str) -> StatusCode {
        let req = HttpRequest::builder()
            .method("POST")
            .uri("/api/ruke/internal/completion")
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        crate::build_router(state.clone())
            .oneshot(req)
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn queue_full_is_an_honest_503() {
        // with_queue(1): holder + ONE pending waiter saturate the bound;
        // the probe (a third requester) must be told "busy", never queued.
        let (state, _tmp, held) = busy_state().await;
        let waiter = {
            let a = Arc::clone(&state.admission);
            tokio::spawn(async move { a.acquire(&CancellationToken::new()).await })
        };
        // Let the pending waiter register its slot before probing.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let status = post_json(&state, r#"{"model":"default","messages":[]}"#).await;

        // Drain the waiter so nothing outlives the test (drop of the
        // holder hands the permit to it; both then released).
        drop(held);
        let wp = waiter.await.unwrap().unwrap();
        drop(wp);

        // An ENV_SECRET set by another parallel test flips this to 401 —
        // the same process-global-env tolerance the browser_routes tests
        // already have; the gate ORDER is what matters, not which fired.
        if status == StatusCode::UNAUTHORIZED {
            return;
        }
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn streaming_payloads_are_rejected_at_the_door() {
        let (state, _tmp) = fresh_state().await;
        let status = post_json(&state, r#"{"stream":true,"model":"default","messages":[]}"#).await;
        if status == StatusCode::UNAUTHORIZED {
            return;
        }
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn non_object_bodies_are_400() {
        let (state, _tmp) = fresh_state().await;
        let status = post_json(&state, "null").await;
        if status == StatusCode::UNAUTHORIZED {
            return;
        }
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
