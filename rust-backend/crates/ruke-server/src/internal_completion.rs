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
//! - Deadline OWNERSHIP (brief §3.4, R04): `timeout_ms` is validated and
//!   clamped, the timer task is ABORTED when the request ends (no job
//!   parked until its deadline after an early completion), and the request
//!   token is cancelled if this future is ever dropped (client disconnect /
//!   shutdown) instead of only through an explicit cancel arm. The response
//!   body is read under a byte bound.
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
use futures_util::StreamExt;

use crate::browser_routes::{bridge_ok, bridge_secret_present};
use crate::AppState;

/// Payload ceiling generous enough for a chat-shaped history while still
/// a BOUND (bounded-resource law). Search-gate and llm-json payloads are
/// far smaller in practice.
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Same bound applies to what an upstream may hand BACK while we hold the
/// only permit: an unbounded `bytes()` read would let a faulty or hostile
/// upstream grow this process without limit.
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// Bridge deadlines are VALIDATED, never trusted verbatim: the TS callers
/// use seconds-scale values. A caller typo of "999999999 ms" must never be
/// able to park the one permit for hours, and 0/near-0 is a caller bug
/// rather than a legitimate instant cancellation (that is what the client
/// token is for). Out-of-range values clamp and are logged.
const MIN_DEADLINE_MS: u64 = 50;
const MAX_DEADLINE_MS: u64 = 900_000;

fn validated_deadline_ms(raw: Option<u64>) -> Option<u64> {
    let v = raw?;
    if v < MIN_DEADLINE_MS {
        tracing::warn!(raw = v, clamped_to = MIN_DEADLINE_MS, "internal completion deadline too small");
        return Some(MIN_DEADLINE_MS);
    }
    if v > MAX_DEADLINE_MS {
        tracing::warn!(raw = v, clamped_to = MAX_DEADLINE_MS, "internal completion deadline too large");
        return Some(MAX_DEADLINE_MS);
    }
    Some(v)
}

/// Owns the per-request deadline timer (R04). Aborting on drop is the
/// point: a request that finished in 30 ms with a 20 s deadline must not
/// leave a task sleeping for another 19.97 s holding a clone of the
/// request's cancellation token.
struct DeadlineTask {
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl DeadlineTask {
    fn start(token: &CancellationToken, ms: u64) -> Self {
        let t = token.clone();
        Self {
            handle: Some(tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                t.cancel();
            })),
        }
    }
}

impl Drop for DeadlineTask {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }
}

/// Drop-scoped cancellation (R04): an axum handler future can be DROPPED
/// (client disconnect, shutdown) without ever reaching a cancel arm. The
/// permit itself already rides RAII, but the token would otherwise stay
/// live for whatever still holds a clone — this makes "the request is
/// gone" explicit for every owned child.
struct TokenGuard {
    token: CancellationToken,
}

impl Drop for TokenGuard {
    fn drop(&mut self) {
        self.token.cancel();
    }
}

/// Read a response body with BOTH a byte bound and the request deadline
/// attached. `Ok(None)` means the deadline cut it short; `Err(())` means
/// the upstream broke the bound or the read failed. Generic over the error
/// so the bound is unit-testable without a live HTTP server.
async fn read_capped<S, E>(mut stream: S, token: &CancellationToken, cap: usize) -> Result<Option<Vec<u8>>, ()>
where
    S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Unpin,
{
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = token.cancelled() => return Ok(None),
            n = stream.next() => n,
        };
        match next {
            None => return Ok(Some(buf)),
            Some(Err(_)) => return Err(()),
            Some(Ok(chunk)) => {
                if buf.len() + chunk.len() > cap {
                    tracing::error!("internal completion upstream exceeded the response byte bound");
                    return Err(());
                }
                buf.extend_from_slice(&chunk);
            }
        }
    }
}

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

    // One token drives queue wait, send, and body read; ONE owned timer
    // task drives the token. Both are scoped to THIS future: the timer is
    // aborted when the request ends, and the token is cancelled if the
    // future is dropped at all (R04 — no orphan jobs, no live token after
    // a disconnect, no retained permit).
    let token = CancellationToken::new();
    let _token_guard = TokenGuard { token: token.clone() };
    let _deadline = validated_deadline_ms(timeout_ms).map(|ms| DeadlineTask::start(&token, ms));

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
    let capped = read_capped(Box::pin(upstream.bytes_stream()), &token, MAX_RESPONSE_BYTES).await;
    // `_permit` drops HERE — after the FULL body has been read (or the
    // read was cut short), never at headers-arrival.
    drop(permit);

    match capped {
        Ok(None) => err(StatusCode::GATEWAY_TIMEOUT, "Model request timed out"),
        Err(()) => err(StatusCode::BAD_GATEWAY, "Model response read failed"),
        Ok(Some(b)) => {
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

    /// R05 isolation: the bridge secret lives in a process-global env var
    /// and this binary's tests run on parallel threads. Every request here
    /// pins the secret under the shared lock for its whole lifetime, so a
    /// parallel writer can no longer turn a behavioural assertion into an
    /// accidental 401 — and NO test may treat 401 as a pass.
    async fn post_with_secret(
        state: &crate::AppState,
        body: &str,
        secret: Option<&str>,
    ) -> (tokio::sync::MutexGuard<'static, ()>, StatusCode) {
        post_pinned(state, body, secret.unwrap_or(""), secret.is_some()).await
    }

    /// Same door, but the PINNED secret and the PRESENTED header are
    /// independent — which is exactly what an authentication test needs.
    async fn post_pinned(
        state: &crate::AppState,
        body: &str,
        pin: &str,
        present_header: bool,
    ) -> (tokio::sync::MutexGuard<'static, ()>, StatusCode) {
        let guard = crate::ipc::test_guard::pin_bridge_secret(pin).await;
        let mut builder = HttpRequest::builder()
            .method("POST")
            .uri("/api/ruke/internal/completion")
            .header(axum::http::header::CONTENT_TYPE, "application/json");
        if present_header {
            builder = builder.header(crate::ipc::SECRET_HEADER, pin);
        }
        let req = builder.body(Body::from(body.to_string())).unwrap();
        let status = crate::build_router(state.clone())
            .oneshot(req)
            .await
            .unwrap()
            .status();
        (guard, status)
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
        let (_env, status) = post_with_secret(&state, r#"{"model":"default","messages":[]}"#, None).await;

        // Drain the waiter so nothing outlives the test (drop of the
        // holder hands the permit to it; both then released).
        drop(held);
        let wp = waiter.await.unwrap().unwrap();
        drop(wp);

        // No early return on an authentication accident: the secret is
        // pinned, so this MUST be the saturation branch (R05).
        assert_ne!(status, StatusCode::UNAUTHORIZED, "auth must not shadow the assertion");
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn streaming_payloads_are_rejected_at_the_door() {
        let (state, _tmp) = fresh_state().await;
        let (_env, status) =
            post_with_secret(&state, r#"{"stream":true,"model":"default","messages":[]}"#, None).await;
        assert_ne!(status, StatusCode::UNAUTHORIZED, "auth must not shadow the assertion");
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn non_object_bodies_are_400() {
        let (state, _tmp) = fresh_state().await;
        let (_env, status) = post_with_secret(&state, "null", None).await;
        assert_ne!(status, StatusCode::UNAUTHORIZED, "auth must not shadow the assertion");
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    /// Authentication gets its OWN test (it was previously hiding the
    /// assertions of three other tests). A configured secret with no header
    /// is a 401; the SAME secret, presented correctly, must reach the real
    /// branch — proven here by the 400 that only the JSON parse can produce.
    #[tokio::test]
    async fn bridge_secret_gate_is_checked_once_and_its_pass_is_observable() {
        // The guards are MUTUALLY EXCLUSIVE (one process-global env var),
        // so the two legs run strictly one after the other.
        let missing = {
            let (state, _tmp) = fresh_state().await;
            let (env, status) =
                post_pinned(&state, r#"{"model":"default"}"#, "bridge-must-match", false).await;
            drop(env);
            status
        };
        let presented = {
            let (state, _tmp) = fresh_state().await;
            let (env, status) = post_pinned(&state, "null", "bridge-must-match", true).await;
            drop(env);
            status
        };
        // A configured secret with no header is refused...
        assert_eq!(missing, StatusCode::UNAUTHORIZED);
        // ...and the SAME secret, presented, demonstrably reaches the real
        // branch (400 can only come from the JSON parse, past the gate).
        assert_eq!(presented, StatusCode::BAD_REQUEST);
    }

    /// R04: a deadline spent in the QUEUE is an honest 504, and the holder
    /// keeps its permit (never "the next caller got let in because the
    /// waiter vanished without a verdict").
    #[tokio::test]
    async fn queued_deadline_is_a_504_and_leaves_the_permit_intact() {
        let (state, _tmp, held) = busy_state().await;
        let (_env, status) = post_with_secret(
            &state,
            r#"{"model":"default","messages":[],"timeout_ms":80}"#,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
        assert!(
            state.admission.generation_in_flight(),
            "the holder's permit survives an expired waiter"
        );
        assert_eq!(state.admission.queued(), 0, "the expired waiter handed its slot back");
        drop(held);
        assert!(state.admission.acquire(&CancellationToken::new()).await.is_ok());
    }

    /// R04: a client that vanishes while QUEUED (axum drops the handler
    /// future) must leave no waiter slot and no retained permit.
    #[tokio::test(flavor = "multi_thread")]
    async fn dropped_handler_future_while_queued_leaks_nothing() {
        let (state, _tmp, held) = busy_state().await;
        let st = state.clone();
        let job = tokio::spawn(async move {
            let req = HttpRequest::builder()
                .method("POST")
                .uri("/api/ruke/internal/completion")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"model":"default","messages":[]}"#.to_string()))
                .unwrap();
            crate::build_router(st).oneshot(req).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(state.admission.queued(), 1, "the request registered as a waiter");
        job.abort(); // disconnect simulation: future dropped mid-await
        let _ = job.await;
        assert_eq!(state.admission.queued(), 0, "dropped waiter handed its slot back");
        assert!(state.admission.generation_in_flight());
        drop(held);
        assert!(state.admission.acquire(&CancellationToken::new()).await.is_ok());
    }

    /// R04: the deadline timer belongs to the request. If the request ends
    /// early, the timer is ABORTED — the token must still be uncancelled
    /// once the deadline window has passed. The control half proves the
    /// timer really does fire while the request is live.
    #[tokio::test(start_paused = true)]
    async fn deadline_timer_fires_only_while_the_request_owns_it() {
        // Control: an owned timer that is NOT dropped fires on schedule.
        let live = CancellationToken::new();
        let live_task = DeadlineTask::start(&live, 20);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(live.is_cancelled(), "a live request's deadline must fire");
        drop(live_task);

        // The R04 defect: an abandoned timer kept a task (and a token
        // clone) alive after the request was over.
        let ended = CancellationToken::new();
        let ended_task = DeadlineTask::start(&ended, 20);
        drop(ended_task); // request finished at t=0
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !ended.is_cancelled(),
            "an abandoned deadline timer must not fire later — the request ended"
        );
    }

    /// R04: caller-supplied `timeout_ms` is a control field, not something
    /// to trust: absurd values are clamped, so a typo can never park the
    /// one permit for hours.
    #[test]
    fn deadlines_are_validated_not_trusted() {
        assert_eq!(validated_deadline_ms(None), None);
        assert_eq!(validated_deadline_ms(Some(0)), Some(MIN_DEADLINE_MS));
        assert_eq!(validated_deadline_ms(Some(123)), Some(123));
        assert_eq!(validated_deadline_ms(Some(u64::MAX)), Some(MAX_DEADLINE_MS));
    }

    /// R04: the response read is byte-bounded — an upstream that streams
    /// more than the bound must fail, never grow this process while it
    /// holds the only permit.
    #[tokio::test]
    async fn response_body_is_byte_bounded() {
        let token = CancellationToken::new();
        let over = Box::pin(futures_util::stream::iter(vec![
            Ok::<bytes::Bytes, ()>(bytes::Bytes::from_static(b"1234")),
            Ok::<bytes::Bytes, ()>(bytes::Bytes::from_static(b"5678")),
        ]));
        assert_eq!(read_capped(over, &token, 8).await, Ok(Some(b"12345678".to_vec())));
        let too_many = Box::pin(futures_util::stream::iter(vec![
            Ok::<bytes::Bytes, ()>(bytes::Bytes::from_static(b"12345")),
            Ok::<bytes::Bytes, ()>(bytes::Bytes::from_static(b"67890")),
        ]));
        assert_eq!(read_capped(too_many, &token, 8).await, Err(()));
    }

    /// R04: a stalled body is cut short by the deadline instead of parking
    /// the permit on a read that will never return.
    #[tokio::test(start_paused = true)]
    async fn stalled_response_body_is_cut_short_by_the_deadline() {
        let token = CancellationToken::new();
        let t = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            t.cancel();
        });
        let stalled = Box::pin(
            futures_util::stream::iter(vec![Ok::<bytes::Bytes, ()>(bytes::Bytes::from_static(
                b"partial",
            ))])
            .chain(futures_util::stream::pending::<Result<bytes::Bytes, ()>>()),
        );
        assert_eq!(read_capped(stalled, &token, 4096).await, Ok(None));
    }
}
