//! Brief §3.5 (R05) acceptance, part 2: the header-phase proof in
//! `admission_exclusion.rs` only shows that a handler SLEEPING BEFORE ITS
//! HEADERS serializes. It cannot distinguish "permit released at headers"
//! from "permit held through the body". These two probes close that gap
//! with a mock whose response BODY is gated on a channel:
//!
//! 1. the chat forward delivers its HEADERS and FIRST body chunk promptly,
//!    then holds the body open on the gate; while that body is open a
//!    second (bridge completion) request must stay QUEUED — never admitted
//!    — and the mock's own concurrent-body count must never exceed 1;
//! 2. a client that abandons the streamed body (axum drops the response
//!    body stream ⇒ `AbortOnDrop` cancels the request token ⇒ the pump
//!    drops the upstream response) releases the permit so the queued
//!    waiter proceeds — with no lost verdict and no stranded slot.
//!
//! Each probe builds its OWN mock (own counters + own gate), so the tests
//! in this binary are independent even though cargo runs them on parallel
//! threads.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{header::CONTENT_TYPE, Request as HttpRequest, StatusCode};
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use futures_util::StreamExt;
use http_body_util::BodyExt; // into_data_stream
use serde_json::json;
use tokio::sync::watch;
use tower::ServiceExt; // oneshot

use ruke_attach::UnavailableEmbedder;
use ruke_core::{
    admission::UpstreamAdmission, settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter,
};
use ruke_server::{
    build_router, persistence::ConversationStore,
    titles::{generate::UnconfiguredTitleModel, queue::TitleQueue},
    AppState,
};

/// Per-mock state: counts the mock's OWN concurrently open response bodies
/// (incremented when the handler starts = about to send headers, decremented
/// when that body stream ENDS OR IS DROPPED — see `BodyGuard`) and the gate
/// that holds the body open.
#[derive(Clone)]
struct Mock {
    active: Arc<AtomicUsize>,
    high: Arc<AtomicUsize>,
    gate: watch::Sender<bool>,
    // A watch::Sender::send FAILS once every receiver is gone. Each handler
    // subscribes its own receiver and drops it when its body ends (including
    // when a client disconnect tears the connection down), so a mock holding
    // only the sender would turn gate.send(true) into a harness failure in
    // the disconnect probe. Holding one receiver keeps the gate usable by
    // whoever subscribes later; nothing polls this receiver.
    _gate_keepalive: watch::Receiver<bool>,
}

/// The body-lifetime half of the accounting. Placed INSIDE the response
/// stream's state so it drops whether the body completes, errors, or the
/// connection is torn down — exactly the interval the admission permit is
/// supposed to cover.
struct BodyGuard {
    active: Arc<AtomicUsize>,
}

impl Drop for BodyGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Gated {
    rx: watch::Receiver<bool>,
    // Named with a leading underscore on purpose: nothing reads it; its
    // Drop IS the accounting (see BodyGuard).
    _guard: BodyGuard,
    first_sent: bool,
}

async fn gated_body_handler(State(m): State<Mock>, _req: Request) -> Response {
    let n = m.active.fetch_add(1, Ordering::SeqCst) + 1;
    m.high.fetch_max(n, Ordering::SeqCst);
    let st = Gated {
        rx: m.gate.subscribe(),
        _guard: BodyGuard {
            active: m.active.clone(),
        },
        first_sent: false,
    };
    let stream = futures_util::stream::unfold(st, |mut g| async move {
        if !g.first_sent {
            g.first_sent = true;
            return Some((
                Ok::<_, std::io::Error>(bytes::Bytes::from_static(
                    b"data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n",
                )),
                g,
            ));
        }
        // Headers and the first frame are OUT; the body now stays open on
        // the gate. A permit that released at headers-arrival would admit a
        // second upstream request right here and push high to 2.
        loop {
            let released = { *g.rx.borrow_and_update() };
            if released {
                break;
            }
            if g.rx.changed().await.is_err() {
                break; // sender gone: end honestly rather than hang
            }
        }
        None
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/event-stream")
        .body(Body::from_stream(stream))
        .unwrap()
}

async fn spawn_gated_mock() -> (String, Mock) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = watch::channel(false);
    let mock = Mock {
        active: Arc::new(AtomicUsize::new(0)),
        high: Arc::new(AtomicUsize::new(0)),
        gate: tx,
        _gate_keepalive: rx,
    };
    let server_state = mock.clone();
    tokio::spawn(async move {
        let app = Router::new()
            .fallback(post(gated_body_handler))
            .with_state(server_state);
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://127.0.0.1:{port}/x"), mock)
}

fn state_with_mock(mock_url: &str) -> (AppState, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("settings.json"),
        json!({ "llm_api_url": mock_url, "llm_api_key": "test-key" }).to_string(),
    )
    .unwrap();
    let slot = Arc::new(InferenceSlot::new());
    let store = Arc::new(ConversationStore::new(tmp.path().join("conversations")));
    let state = AppState {
        settings: Arc::new(SettingsStore::new(tmp.path().join("settings.json"))),
        slot: slot.clone(),
        turns: Arc::new(TurnCounter::new()),
        admission: Arc::new(UpstreamAdmission::new()),
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

fn chat_request(body: String) -> HttpRequest<Body> {
    HttpRequest::builder()
        .method("POST")
        .uri("/api/chat")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

fn completion_request(body: String) -> HttpRequest<Body> {
    HttpRequest::builder()
        .method("POST")
        .uri("/api/ruke/internal/completion")
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

fn chat_body() -> String {
    json!({
        "model": "mock-model",
        "messages": [{ "role": "user", "content": "slow body probe" }],
        "stream": true,
    })
    .to_string()
}

fn completion_body() -> String {
    json!({
        "model": "default",
        "messages": [{ "role": "user", "content": "plan" }],
        "timeout_ms": 20000,
    })
    .to_string()
}

/// Poll `cond` until true or the budget runs out (no fixed sleeps that
/// race a slower CI box).
async fn wait_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while !cond() {
        if tokio::time::Instant::now() >= deadline {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gated_streamed_body_keeps_the_permit_and_a_second_request_queued() {
    let (mock_url, mock) = spawn_gated_mock().await;
    let (state, _tmp) = state_with_mock(&mock_url);
    let router = build_router(state.clone());

    // (1) Prompt header delivery: headers arrive while the upstream body is
    // still open, and the caller-visible stream is already live (the first
    // chunk may be ruke's own stage frame or the upstream's first frame —
    // either way the response exists before the upstream body has drained).
    let resp = router
        .clone()
        .oneshot(chat_request(chat_body()))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "headers must be delivered before the body drains"
    );
    let mut stream = resp.into_data_stream();
    let chunk1 = tokio::time::timeout(Duration::from_secs(3), stream.next())
        .await
        .expect("first body frame must arrive while the rest of the body is gated")
        .expect("first frame")
        .expect("no transport error");
    assert!(!chunk1.is_empty(), "the first frame must reach the caller");

    // The upstream leg starts a moment after the caller sees its first
    // frame, so wait for it instead of racing it with a fixed sleep.
    wait_until("the mock to open exactly one response body", || {
        mock.active.load(Ordering::SeqCst) == 1
    })
    .await;
    assert!(
        state.admission.generation_in_flight(),
        "the permit must still be held while the response body is open"
    );

    // (2) A second request against the SAME shared resource must queue.
    let r2 = router.clone();
    let second = tokio::spawn(async move { r2.oneshot(completion_request(completion_body())).await });
    wait_until("the completion request to register as a waiter", || {
        state.admission.queued() == 1
    })
    .await;
    assert!(
        !second.is_finished(),
        "the queued request must NOT complete while the first body owns the endpoint"
    );
    assert_eq!(
        mock.active.load(Ordering::SeqCst),
        1,
        "the queued request must not even reach the upstream"
    );
    assert_eq!(
        mock.high.load(Ordering::SeqCst),
        1,
        "shared-endpoint concurrent response bodies must never exceed 1"
    );

    // (3) Release the body: both must finish, everything must wind down.
    mock.gate.send(true).unwrap();
    let mut drained = 0usize;
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(3), stream.next())
        .await
        .expect("stream must end after the gate opens")
    {
        match chunk {
            Ok(b) => drained += b.len(),
            Err(e) => panic!("stream error while draining: {e}"),
        }
    }
    assert!(drained > 0, "the gated tail must still be delivered");

    let resp2 = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .expect("the queued request must run once the first body ends")
        .unwrap()
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);
    let b2 = to_bytes(resp2.into_body(), 1 << 20).await.unwrap();
    assert!(
        String::from_utf8_lossy(&b2).contains("first"),
        "the completion response passed through the bridge: {b2:?}"
    );

    assert_eq!(
        mock.high.load(Ordering::SeqCst),
        1,
        "the high-water mark across headers, body AND queue hand-off stays 1"
    );
    assert_eq!(mock.active.load(Ordering::SeqCst), 0);
    assert!(
        !state.admission.generation_in_flight(),
        "both permits released after their bodies drained"
    );
    assert_eq!(state.admission.queued(), 0, "no waiter slot leaked");
}

#[tokio::test(flavor = "multi_thread")]
async fn abandoning_a_streamed_body_releases_the_permit_for_the_queued_waiter() {
    let (mock_url, mock) = spawn_gated_mock().await;
    let (state, _tmp) = state_with_mock(&mock_url);
    let router = build_router(state.clone());

    let resp = router
        .clone()
        .oneshot(chat_request(chat_body()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let mut stream = resp.into_data_stream();
    let _ = tokio::time::timeout(Duration::from_secs(3), stream.next())
        .await
        .expect("first frame")
        .expect("first frame")
        .expect("no transport error");
    wait_until("the pump to hold the permit", || {
        state.admission.generation_in_flight()
    })
    .await;

    // Queued waiter, then the client walks away mid-body.
    let r2 = router.clone();
    let second = tokio::spawn(async move { r2.oneshot(completion_request(completion_body())).await });
    wait_until("the completion request to register as a waiter", || {
        state.admission.queued() == 1
    })
    .await;
    assert!(!second.is_finished());

    // Client disconnect: dropping the response body stream is what axum
    // does when the connection goes away, and AbortOnDrop turns that into
    // the request token firing.
    drop(stream);
    // Open the gate so the (now) admitted waiter's body can finish too.
    mock.gate.send(true).unwrap();

    let resp2 = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .expect("the abandoned body must release the permit, not strand the queue")
        .unwrap()
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);
    let _ = to_bytes(resp2.into_body(), 1 << 20).await.unwrap();

    wait_until("the abandoned upstream body to be torn down", || {
        // Not "<= 1": after the disconnect the FIRST generation must be fully
        // gone (its BodyGuard dropped), so a count of 1 here would mean the
        // abandoned handler was still holding a generation open while the
        // waiter was already running.
        mock.active.load(Ordering::SeqCst) == 0
    })
    .await;
    assert_eq!(
        mock.high.load(Ordering::SeqCst),
        1,
        "even across a disconnect the endpoint never carried two generations \
         (forward::run_pump drops the upstream response BEFORE releasing the \
         admission permit, so the waiter cannot reach the mock until the \
         abandoned generation's connection is closed on our side)"
    );
    assert!(
        !state.admission.generation_in_flight(),
        "the disconnect released the permit exactly once"
    );
    assert_eq!(state.admission.queued(), 0, "no waiter slot leaked");
    // The freed endpoint is usable again (proves nothing is stranded).
    let fresh = state.admission.acquire(&tokio_util::sync::CancellationToken::new()).await;
    assert!(fresh.is_ok(), "the endpoint is available again after the abort");
}
