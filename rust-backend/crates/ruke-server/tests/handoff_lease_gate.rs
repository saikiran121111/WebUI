//! 2026-11-17 resource-aware handoff amendment, section 5 ("coordinate all
//! clients") + section 8 ("concurrent inference arriving during processing").
//!
//! A heavyweight document/media job (Python `ruke_ml.handoff`) takes an
//! exclusive cross-process lease and parks the main model while it runs. This
//! probe proves Ruke's OWN HTTP surface refuses to wake it: the chat forward
//! and the TS bridge's internal-completion route both answer an honest 503
//! while a live lease exists, and the mock upstream is never contacted at all.
//! Then, once the window closes, the same routes work.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header::CONTENT_TYPE, Request as HttpRequest, StatusCode};
use axum::response::IntoResponse;
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

// The three tests run concurrently in one process, so the upstream hit counter
// is per-test (a shared static made one test's generation look like another's).
#[derive(Clone)]
struct Hits(Arc<AtomicUsize>);

async fn spawn_mock(hits: &Hits) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = hits.clone();
    tokio::spawn(async move {
        let app = axum::Router::new().fallback(post(move |_: Request| {
            let hits = hits.clone();
            async move {
                hits.0.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                (
                    StatusCode::OK,
                    [(CONTENT_TYPE, "application/json")],
                    r#"{"choices":[{"message":{"content":"mock"}}]}"#,
                )
                    .into_response()
            }
        }));
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://127.0.0.1:{port}/x")
}

fn state_with(mock_url: &str, lease: &std::path::Path, wait_ms: u64) -> (AppState, tempfile::TempDir) {
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
        // THE WIRING UNDER TEST: exactly what main.rs builds, with the lease
        // pointed at this temp dir instead of the real project root.
        admission: Arc::new(UpstreamAdmission::new().with_lease(
            lease,
            std::time::Duration::from_millis(wait_ms),
        )),
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

/// Write a lease record exactly the way the Python coordinator does: a JSON
/// object padded out to a fixed width with NULs.
fn write_live_lease(path: &std::path::Path, phase: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64();
    let record = json!({
        "token": "aaaabbbbccccdddd",
        "owner": "handoff-cli",
        "pid": std::process::id(),
        "phase": phase,
        "started": now,
        "heartbeat": now,
    })
    .to_string();
    let mut bytes = record.into_bytes();
    bytes.resize(512, 0);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

async fn post_json(router: &axum::Router, uri: &str, body: &str) -> (StatusCode, String) {
    let req = HttpRequest::builder()
        .method("POST")
        .uri(uri)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_handoff_window_refuses_both_routes_without_touching_the_model() {
    let hits = Hits(Arc::new(AtomicUsize::new(0)));
    let mock = spawn_mock(&hits).await;
    let tmp = tempfile::tempdir().unwrap();
    let lease = tmp.path().join(".ai-coordination").join("llm-handoff.lock");
    let (state, _keep) = state_with(&mock, &lease, 250);
    // The temp dir for AppState settings is INSIDE state_with; the lease path
    // lives under its own temp dir here, which is fine: the gate only reads it.
    write_live_lease(&lease, "processing");
    let router = build_router(state.clone());

    assert!(state.admission.handoff_held(), "the fresh lease is a live holder");

    let chat_body = json!({
        "model": "mock-model",
        "messages": [{ "role": "user", "content": "read this scanned contract" }],
        "stream": true,
    })
    .to_string();
    let comp_body = json!({
        "model": "default",
        "messages": [{ "role": "user", "content": "plan" }],
        "timeout_ms": 8000,
    })
    .to_string();

    let (s1, b1) = post_json(&router, "/api/chat", &chat_body).await;
    let (s2, b2) = post_json(&router, "/api/ruke/internal/completion", &comp_body).await;

    // /api/chat is the SSE envelope: it answers 200 with headers already sent,
    // then carries the typed refusal inside the stream. What matters is that
    // the refusal is explicit, terminal, and the model was never contacted.
    assert!(
        b1.contains("ruke_error"),
        "the chat stream must end with a typed error, not a silent [DONE]: {b1}"
    );
    assert!(
        b1.contains("parked"),
        "the refusal must say the model is parked by a job, not look like overload: {b1}"
    );
    assert!(
        !b1.contains("\"content\""),
        "no partial answer may be streamed before the refusal: {b1}"
    );
    assert_eq!(s1, StatusCode::OK, "SSE envelope stays 200: {b1}");
    assert_eq!(s2, StatusCode::SERVICE_UNAVAILABLE, "bridge body: {b2}");
    assert!(b2.contains("parked"), "bridge body: {b2}");

    assert_eq!(
        hits.0.load(Ordering::SeqCst),
        0,
        "the parked model was NEVER contacted - this is the whole point"
    );
    assert_eq!(state.admission.lease_refusals(), 2, "both refusals are counted");
    assert!(!state.admission.generation_in_flight(), "no permit was consumed");
    assert_eq!(state.admission.queued(), 0, "no waiter slot was consumed");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_routes_work_once_the_window_closes() {
    let hits = Hits(Arc::new(AtomicUsize::new(0)));
    let mock = spawn_mock(&hits).await;
    let tmp = tempfile::tempdir().unwrap();
    let lease = tmp.path().join(".ai-coordination").join("llm-handoff.lock");
    let (state, _keep) = state_with(&mock, &lease, 250);
    write_live_lease(&lease, "releasing_worker");
    let router = build_router(state.clone());

    let (refused, refused_body) = post_json(
        &router,
        "/api/ruke/internal/completion",
        &json!({"model":"default","messages":[{"role":"user","content":"plan"}],"timeout_ms":8000})
            .to_string(),
    )
    .await;
    assert_eq!(refused, StatusCode::SERVICE_UNAVAILABLE, "{refused_body}");

    std::fs::remove_file(&lease).unwrap();
    let (ok, body) = post_json(
        &router,
        "/api/ruke/internal/completion",
        &json!({"model":"default","messages":[{"role":"user","content":"plan"}],"timeout_ms":8000})
            .to_string(),
    )
    .await;
    assert_eq!(ok, StatusCode::OK, "after the window: {body}");
    assert_eq!(hits.0.load(Ordering::SeqCst), 1, "exactly one generation ran, later");
    assert_eq!(state.admission.lease_refusals(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_abandoned_lease_record_does_not_park_the_endpoint() {
    // Recovery law: a crashed supervisor must not freeze Ruke forever. The
    // record stays on disk (we never delete a foreign lock) but its evidence
    // is older than the stale window, so admission proceeds.
    let hits = Hits(Arc::new(AtomicUsize::new(0)));
    let mock = spawn_mock(&hits).await;
    let tmp = tempfile::tempdir().unwrap();
    let lease = tmp.path().join(".ai-coordination").join("llm-handoff.lock");
    let (state, _keep) = state_with(&mock, &lease, 250);
    write_live_lease(&lease, "processing");
    // Make the evidence old by REWRITING an ancient heartbeat and then letting
    // real time pass against a one-second stale window (mtime is also proof).
    let router = build_router(state.clone());
    let _ = &router;
    let old = json!({
        "token": "deadbeef", "owner": "crashed-cli", "pid": 0, "phase": "processing",
        "started": 1.0, "heartbeat": 1.0,
    })
    .to_string();
    let mut bytes = old.into_bytes();
    bytes.resize(512, 0);
    std::fs::write(&lease, bytes).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;

    let state2 = AppState {
        admission: Arc::new(
            UpstreamAdmission::new()
                .with_lease(&lease, std::time::Duration::from_millis(250))
                .with_lease_stale(std::time::Duration::from_secs(1)),
        ),
        ..state
    };
    let router = build_router(state2.clone());
    let (ok, body) = post_json(
        &router,
        "/api/ruke/internal/completion",
        &json!({"model":"default","messages":[{"role":"user","content":"plan"}],"timeout_ms":8000})
            .to_string(),
    )
    .await;
    assert_eq!(ok, StatusCode::OK, "a provably abandoned lease must not park: {body}");
    assert_eq!(state2.admission.lease_refusals(), 0);
    assert!(lease.exists(), "Ruke never deletes a lock it does not own");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_lease_record_is_never_read_as_an_unlocked_endpoint() {
    // Same defect class, HTTP side: a record that exists but cannot be parsed
    // (a writer died mid-write, a truncated fixed-width slot) used to answer
    // "no holder is claimed", so a chat request woke a model that a live
    // processing job had parked. It is now HELD-UNCERTAIN - admission waits
    // behind it exactly as behind a live heartbeat - and the uncertainty itself
    // is bounded by the record's own file age.
    let hits = Hits(Arc::new(AtomicUsize::new(0)));
    let mock = spawn_mock(&hits).await;
    let tmp = tempfile::tempdir().unwrap();
    let lease = tmp.path().join(".ai-coordination").join("llm-handoff.lock");
    std::fs::create_dir_all(lease.parent().unwrap()).unwrap();
    // A writer that died mid-write: the slot holds a partial JSON document.
    std::fs::write(&lease, b"{\"token\":\"deadbeef").unwrap();
    let (state, _keep) = state_with(&mock, &lease, 250);
    let router = build_router(state.clone());

    assert!(
        state.admission.handoff_held(),
        "an unparseable record must not look like a free endpoint"
    );
    let (status, body) = post_json(
        &router,
        "/api/ruke/internal/completion",
        &json!({"model":"default","messages":[{"role":"user","content":"plan"}],"timeout_ms":8000})
            .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "uncertain record: {body}");
    assert_eq!(
        hits.0.load(Ordering::SeqCst),
        0,
        "a record we cannot read must never wake the parked model"
    );
    assert_eq!(state.admission.lease_refusals(), 1, "the refusal is counted");

    // BOUNDED: once that record's own age passes the window, it is provably
    // abandoned and the endpoint comes back without anyone deleting the file.
    let state2 = AppState {
        admission: Arc::new(
            UpstreamAdmission::new()
                .with_lease(&lease, std::time::Duration::from_millis(250))
                .with_lease_stale(std::time::Duration::from_secs(1)),
        ),
        ..state
    };
    tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;
    let router2 = build_router(state2.clone());
    assert!(!state2.admission.handoff_held(), "aged out: now it IS provable");
    let (ok, body) = post_json(
        &router2,
        "/api/ruke/internal/completion",
        &json!({"model":"default","messages":[{"role":"user","content":"plan"}],"timeout_ms":8000})
            .to_string(),
    )
    .await;
    assert_eq!(ok, StatusCode::OK, "after the bounded window: {body}");
    assert_eq!(hits.0.load(Ordering::SeqCst), 1, "exactly one generation, and only after the bound");
    assert!(lease.exists(), "still never deletes a lock it does not own");
}
