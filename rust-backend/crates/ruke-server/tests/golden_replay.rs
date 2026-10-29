//! End-to-end replay of the frozen wire contract against the recorded
//! fixture corpus (`fixtures/chat`, `fixtures/errors`).
//!
//! Each test drives the REAL router (`build_router` → `POST /api/chat`)
//! with the fixture's exact `request.rawBody`, against a scripted mock
//! upstream standing in for Strata (`:8080` is never contacted from tests),
//! and compares: status, the full application header set, the byte-exact
//! body (legacy) or `bodyMsNormalized` (progress), the logical SSE frame
//! sequence, and the forwarded upstream request — body byte-identical.
//! Nothing is hand-adjusted to make Rust pass: divergence means the Rust
//! side is wrong (or the fixture documents an approved deviation).

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::StreamExt;
use serde_json::{json, Value};

use common::{
    assert_response, assert_slot_idle, assert_upstream_call, load_fixture, parse_logical,
    post_chat, split_chunks, test_state, MockUpstream, Script, STD_UPSTREAM,
};

/// Every normal chat fixture replays the same upstream stream, fed in three
/// chunks (so the scrubber/pump are exercised across frame boundaries).
fn std_scripts() -> Vec<Script> {
    vec![Script::stream(split_chunks(STD_UPSTREAM, &[50, 120]))]
}

/// `Upstream returned <status>: <errText>` — recover the upstream status and
/// the exact error text the mock must echo, from the recorded contract (the
/// legacy JSON body or the progress `ruke_error` frame). The prefix parse is
/// what lets the replay stay honest: the scripted error text is DERIVED from
/// the fixture, never retyped.
fn recorded_upstream_error(fx: &Value) -> (u16, String) {
    let msg = if let Some(lossy) = fx["response"]["body"].get("utf8Lossy") {
        let body: Value = serde_json::from_str(lossy.as_str().unwrap()).unwrap();
        body["error"].as_str().expect("error field").to_string()
    } else {
        fx["logicalFrames"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|f| f.get("message").and_then(Value::as_str))
            .expect("ruke_error frame")
            .to_string()
    };
    let rest = msg.strip_prefix("Upstream returned ").expect("contract prefix");
    let colon = rest.find(": ").expect("status separator");
    let status: u16 = rest[..colon].parse().expect("status digits");
    (status, rest[colon + 2..].to_string())
}

async fn replay(rel: &str, make: impl FnOnce(&Value) -> Vec<Script>) {
    let fx = load_fixture(rel);
    let scripts = make(&fx);
    let raw = fx["request"]["rawBody"].as_str().expect("rawBody");

    let mock = MockUpstream::start(scripts).await;
    let url = mock.url();
    let (state, _tmp) = test_state(Some((url.as_str(), "golden-key")));

    let (status, headers, bytes) = post_chat(&state, raw).await;
    assert_response(&fx, rel, status, &headers, &bytes);
    assert_upstream_call(&fx, rel, &mock.calls());
    assert_slot_idle(&state, rel).await; // Rule 6: released exactly once
}

// ---------------------------------------------------------------------------
// chat/ corpus
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_01_stream_normal() {
    replay("chat/01-stream-normal.json", |_| std_scripts()).await;
}

#[tokio::test]
async fn chat_02_legacy_nonstream() {
    replay("chat/02-legacy-nonstream.json", |_| std_scripts()).await;
}

#[tokio::test]
async fn chat_03_malformed_forwarded_verbatim() {
    // Unparseable body ⇒ raw bytes forwarded untouched (gate never runs).
    replay("chat/03-malformed-passthrough.json", |_| std_scripts()).await;
}

#[tokio::test]
async fn chat_04a_minimal_empty_object() {
    replay("chat/04a-minimal-empty-object.json", |_| std_scripts()).await;
}

#[tokio::test]
async fn chat_04b_minimal_empty_user_turn() {
    replay("chat/04b-minimal-empty-user-turn.json", |_| std_scripts()).await;
}

#[tokio::test]
async fn chat_04c_minimal_empty_messages() {
    // Empty messages array ⇒ the decision gate is skipped entirely.
    replay("chat/04c-minimal-empty-messages.json", |_| std_scripts()).await;
}

#[tokio::test]
async fn chat_05_compaction_passthrough() {
    // purpose stripped, attachment_ref parts removed, legacy shape always.
    replay("chat/05-compaction-passthrough.json", |_| std_scripts()).await;
}

#[tokio::test]
async fn chat_06a_decision_mode_legacy() {
    // Pinned mode consumed (key deleted), chart skill block injected into
    // the forwarded body byte-for-byte from the repo's real .cskills.
    replay("chat/06a-decision-mode-legacy.json", |_| std_scripts()).await;
}

#[tokio::test]
async fn chat_06b_decision_mode_progress() {
    replay("chat/06b-decision-mode-progress.json", |_| std_scripts()).await;
}

#[tokio::test]
async fn chat_08_web_search_disabled() {
    replay("chat/08-web-search-disabled.json", |_| std_scripts()).await;
}

// ---------------------------------------------------------------------------
// errors/ corpus
// ---------------------------------------------------------------------------

#[tokio::test]
async fn errors_01_upstream_400_legacy() {
    replay("errors/01-upstream-400-legacy.json", |fx| {
        let (st, body) = recorded_upstream_error(fx);
        vec![Script::http_error(st, &body)]
    })
    .await;
}

#[tokio::test]
async fn errors_02_upstream_400_progress() {
    replay("errors/02-upstream-400-progress.json", |fx| {
        let (st, body) = recorded_upstream_error(fx);
        vec![Script::http_error(st, &body)]
    })
    .await;
}

#[tokio::test]
async fn errors_03_upstream_500_legacy() {
    replay("errors/03-upstream-500-legacy.json", |fx| {
        let (st, body) = recorded_upstream_error(fx);
        vec![Script::http_error(st, &body)]
    })
    .await;
}

#[tokio::test]
async fn errors_04_upstream_500_progress() {
    replay("errors/04-upstream-500-progress.json", |fx| {
        let (st, body) = recorded_upstream_error(fx);
        vec![Script::http_error(st, &body)]
    })
    .await;
}

#[tokio::test]
async fn errors_05_no_body_legacy() {
    // The no-body class (recorded by undici as `body === null`; in Rust the
    // 204 response is the contract trigger) ⇒ 502 `No response body from model`.
    replay("errors/05-no-body-legacy.json", |_| vec![Script::no_body()]).await;
}

#[tokio::test]
async fn errors_06_no_body_progress() {
    replay("errors/06-no-body-progress.json", |_| vec![Script::no_body()]).await;
}

/// The unreachable pair needs NO mock: the override points at port 9
/// (connection refused). The recorded upstream calls in these fixtures were
/// stubbed by the TS harness (call metadata without network); the Rust
/// replay genuinely fails to connect, so there is nothing to compare there —
/// the response contract is the assertion.
async fn replay_unreachable(rel: &str) {
    let fx = load_fixture(rel);
    let (state, _tmp) = test_state(Some((common::PORT9_URL, "golden-key")));
    let raw = fx["request"]["rawBody"].as_str().expect("rawBody");
    let (status, headers, bytes) = post_chat(&state, raw).await;
    assert_response(&fx, rel, status, &headers, &bytes);
    assert_slot_idle(&state, rel).await;
}

#[tokio::test]
async fn errors_07_unreachable_legacy() {
    replay_unreachable("errors/07-unreachable-legacy.json").await;
}

#[tokio::test]
async fn errors_08_unreachable_progress() {
    replay_unreachable("errors/08-unreachable-progress.json").await;
}

// ---------------------------------------------------------------------------
// chat/07 — the semantic abort fixture (rule: abort must NOT leave a zombie
// turn holding the shared inference slot; upstream must be aborted too).
// The fixture records the observable sequence, not a replayable rawBody, so
// the request is reconstructed from its documented shape; over a REAL socket
// so dropping the client stream is a real disconnect.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chat_07_client_abort_propagates_upstream_and_releases_slot() {
    let fx = load_fixture("chat/07-client-abort.json");

    let abort_witness = Arc::new(AtomicBool::new(false));
    let mock = MockUpstream::start(vec![Script::hold(
        vec![b"data: partial\n\n".to_vec()],
        abort_witness.clone(),
    )])
    .await;
    let url = mock.url();
    let (state, _tmp) = test_state(Some((url.as_str(), "golden-key")));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, ruke_server::build_router(server_state)).await;
    });

    let resp = reqwest::Client::new()
        .post(format!("http://{addr}/api/chat"))
        .header("content-type", "application/json")
        .body(json!({ "messages": [{ "role": "user", "content": "abort me" }] }).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "early-open response");

    // Read until the partial upstream frame surfaces client-side (the frame
    // the upstream sent before it went quiet — TS streams it through right
    // away). A hard deadline distinguishes "stream went quiet as scripted"
    // from "the frame never got delivered".
    let mut stream = resp.bytes_stream();
    let mut acc = String::new();
    let read_deadline = std::time::Instant::now() + Duration::from_secs(8);
    while !acc.contains("data: partial\n\n") {
        let remaining = read_deadline.saturating_duration_since(std::time::Instant::now());
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(chunk))) => acc.push_str(&String::from_utf8_lossy(&chunk)),
            Ok(Some(Err(e))) => panic!("chunk error before the partial frame: {e}; acc={acc:?}"),
            Ok(None) => panic!("stream ended before the partial frame; acc={acc:?}"),
            Err(_) => panic!("timed out waiting for the partial frame; acc={acc:?}"),
        }
    }
    // Contract up to the abort: decision_done + the passthrough frame, and
    // NO error frame (errorFramesAfterAbort: 0 — a client abort closes
    // silently, it is not an upstream failure).
    assert!(!acc.contains("ruke_error"), "abort must not emit a ruke_error frame");
    let (frames, _, _) = parse_logical(&acc);
    assert_eq!(
        Value::Array(frames),
        fx["logicalFramesBeforeAbort"].clone(),
        "frames before the abort"
    );
    assert!(state.slot.user_turn_active(), "turn holds the slot while streaming");

    // The client walks away mid-stream.
    drop(stream);

    // The forwarder must tear the upstream connection down (the mock's body
    // stream is dropped ⇒ witness fires) — no zombie generation.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !abort_witness.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(abort_witness.load(Ordering::SeqCst), "upstream was never aborted");

    // And the inference slot returns (exactly once) so the next turn can run.
    assert_slot_idle(&state, "chat/07").await;

    server.abort();
}
