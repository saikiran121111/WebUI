//! Brief §3.1 acceptance probe: the ONE shared-endpoint authority in
//! action. Concurrent chat forwards (the streaming legacy path) and
//! internal-completion bridge calls (the TS helpers' route) hit a mock
//! upstream that COUNTS its own simultaneous in-flight requests; the
//! high-water mark MUST be exactly 1. This is the cross-route proof that
//! the `UpstreamAdmission` permit is held across the FULL response — a
//! headers-arrival release would let the mock overlap and fail here.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header::CONTENT_TYPE, Request as HttpRequest, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::json;
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

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static HIGH: AtomicUsize = AtomicUsize::new(0);

async fn mock_handler(_: Request) -> Response {
    let n = ACTIVE.fetch_add(1, Ordering::SeqCst) + 1;
    HIGH.fetch_max(n, Ordering::SeqCst);
    // The "generation": the mock holds the connection busy. A permit that
    // released at headers-arrival would let the next request START here.
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    ACTIVE.fetch_sub(1, Ordering::SeqCst);
    (
        StatusCode::OK,
        [(CONTENT_TYPE, "application/json")],
        r#"{"choices":[{"message":{"content":"mock"}}]}"#,
    )
        .into_response()
}

async fn spawn_mock() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let app = axum::Router::new().fallback(post(mock_handler));
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://127.0.0.1:{port}/x")
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

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_chat_and_completion_upstream_overlap_is_one() {
    ACTIVE.store(0, Ordering::SeqCst);
    HIGH.store(0, Ordering::SeqCst);

    let mock = spawn_mock().await;
    let (state, _tmp) = state_with_mock(&mock);
    let router = build_router(state.clone());

    let chat_body = json!({
        "model": "mock-model",
        "messages": [{ "role": "user", "content": "overlap probe" }],
        "stream": true,
    })
    .to_string();
    let comp_body = json!({
        "model": "default",
        "messages": [{ "role": "user", "content": "plan" }],
        "timeout_ms": 8000,
    })
    .to_string();

    // Two streaming chat forwards + two bridge completions, launched
    // together. Queue bound (4 waiters) covers 1 holder + 3 queued.
    let mut handles = Vec::new();
    for variant in ["chat", "chat", "comp", "comp"] {
        let r = router.clone();
        let (uri, body) = if variant == "chat" {
            ("/api/chat", chat_body.clone())
        } else {
            ("/api/ruke/internal/completion", comp_body.clone())
        };
        handles.push(tokio::spawn(async move {
            let req = HttpRequest::builder()
                .method("POST")
                .uri(uri)
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap();
            let resp = r.oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            (status, bytes)
        }));
    }

    for h in handles {
        let (status, body) = h.await.unwrap();
        assert_eq!(status, StatusCode::OK, "body: {body:?}");
    }

    assert_eq!(
        HIGH.load(Ordering::SeqCst),
        1,
        "the shared endpoint's active generation count must never exceed 1"
    );
    assert_eq!(ACTIVE.load(Ordering::SeqCst), 0);
    assert!(
        !state.admission.generation_in_flight(),
        "every permit released after its response drained"
    );
    assert_eq!(state.admission.queued(), 0, "no waiter slots leaked");
}
