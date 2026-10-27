//! Shared Part-4 replay harness.
//!
//! Mirrors `__tests__/rust-golden/support/golden.ts`: fixture loading, the
//! `bodyMsNormalized` ms-normalization, the logical-SSE-frame parser, and a
//! deterministic scripted mock upstream (the stand-in for llama.cpp :8080 —
//! tests NEVER contact live inference, per the Part-4 brief).

#![allow(dead_code)] // shared across several test binaries

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header::CONTENT_TYPE, HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use bytes::Bytes;
use futures_util::stream::Stream;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt; // oneshot

use ruke_core::{settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};
use ruke_server::{
    persistence::ConversationStore,
    titles::{generate::UnconfiguredTitleModel, queue::TitleQueue},
    AppState,
};

/// The fixed unreachable upstream used by the unreachable-contract fixtures
/// (same URL the TS harness records; port 9 = discard, always refused).
pub const PORT9_URL: &str = "http://127.0.0.1:9/v1/chat/completions";

/// The scripted upstream stream every normal chat fixture replays against
/// (the TS harness's default `chunks`; 181 bytes — the legacy fixtures'
/// recorded `utf8Lossy` body IS these bytes, which the replay re-verifies).
pub const STD_UPSTREAM: &[u8] = b"data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"\
    delta\":{\"role\":\"assistant\"}}]}\n\ndata: {\"id\":\"c1\",\"choices\":[{\"\
    index\":0,\"delta\":{\"content\":\"Hello!\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures"))
}

/// Repo root: the anchor for `skills/`, `.cskills/` and scenario JSON, used
/// by slash-skill routing and the decision skill block (chat/06a/06b replay
/// must reproduce the recorded `<decision_skill …>` block byte-for-byte).
pub fn repo_root() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
}

/// The committed cross-language store fixture for one attachment
/// (`fixtures/attachments/store/<attId>`) — bytes written by the PRODUCTION
/// Node writer (`writeIndex`), recorded by
/// `__tests__/rust-golden/store-fixture.test.ts`. Never regenerated or
/// edited on the Rust side; the §27 tests copy these VERBATIM.
pub fn store_fixture_dir(att_id: &str) -> PathBuf {
    fixtures_dir().join("attachments").join("store").join(att_id)
}

/// Byte-for-byte recursive directory copy (fixture bytes -> live store dir).
pub fn copy_tree(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &to);
        } else {
            std::fs::copy(entry.path(), &to).unwrap();
        }
    }
}

pub fn load_fixture(rel: &str) -> Value {
    let path = fixtures_dir().join(rel);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read fixture {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("bad fixture JSON {}: {e}", path.display()))
}

/// Fresh server state beside the REAL repo root (skill blocks must load from
/// the same tracked files the fixtures were recorded against). The temp dir
/// only isolates `settings.json`. Returned with the TempDir so the caller
/// keeps it alive.
pub fn test_state(upstream: Option<(&str, &str)>) -> (AppState, TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let slot = Arc::new(InferenceSlot::new());
    let store = Arc::new(ConversationStore::new(tmp.path().join("conversations")));
    let state = AppState {
        settings: Arc::new(SettingsStore::new(tmp.path().join("settings.json"))),
        slot: slot.clone(),
        turns: Arc::new(TurnCounter::new()),
        root: repo_root(),
        http: reqwest::Client::new(),
        attach_embedder: Arc::new(ruke_attach::UnavailableEmbedder),
        conversations: store.clone(),
        // Replay fixtures never trigger title generation; the queue is
        // present so AppState matches the production shape.
        titles: Arc::new(TitleQueue::new(store, slot, Arc::new(UnconfiguredTitleModel))),
    };
    if let Some((url, key)) = upstream {
        state.settings.set_upstream_override(url, key);
    }
    (state, tmp)
}

// ---------------------------------------------------------------------------
// Fixture comparison helpers (mirrors golden.ts)
// ---------------------------------------------------------------------------

/// `normalizeBodyMs`: within each single-line `ruke_stage` frame, replace
/// `"ms":<number>` with `"ms":"<ms>"`. Upstream data frames are never
/// touched (an ms-shaped number in model content is not rewritten).
pub fn normalize_body_ms(text: &str) -> String {
    const PAT: &str = "data: {\"ruke_stage\":{";
    let mut out = String::new();
    let mut pos = 0usize;
    while let Some(rel) = text[pos..].find(PAT) {
        let start = pos + rel;
        out.push_str(&text[pos..start]);
        let after = start + PAT.len();
        // `[^\n]*\}\}\n\n`: the frame must close on the same line.
        let nl = match text[after..].find('\n') {
            Some(i) => after + i,
            None => {
                out.push_str(&text[start..]);
                return out;
            }
        };
        let is_frame = text.get(nl.saturating_sub(2)..nl) == Some("}}")
            && text.get(nl..nl + 2) == Some("\n\n");
        if is_frame {
            out.push_str(&replace_ms_digits(&text[start..nl + 2]));
            pos = nl + 2;
        } else {
            // Not a terminated frame: emit the literal prefix and rescan
            // (PAT cannot self-overlap, so skipping past it is faithful).
            out.push_str(&text[start..after]);
            pos = after;
        }
    }
    out.push_str(&text[pos..]);
    out
}

/// `/"ms":-?\d+(\.\d+)?/g` → `"ms":"<ms>"` (JS `\d` = ASCII digits).
fn replace_ms_digits(m: &str) -> String {
    let mut out = String::new();
    let mut i = 0usize;
    while i < m.len() {
        if m[i..].starts_with("\"ms\":") {
            let mut j = i + 5;
            if m.as_bytes().get(j) == Some(&b'-') {
                j += 1;
            }
            let d0 = j;
            while m.as_bytes().get(j).is_some_and(u8::is_ascii_digit) {
                j += 1;
            }
            if j > d0 {
                if m.as_bytes().get(j) == Some(&b'.')
                    && m.as_bytes().get(j + 1).is_some_and(u8::is_ascii_digit)
                {
                    j += 2;
                    while m.as_bytes().get(j).is_some_and(u8::is_ascii_digit) {
                        j += 1;
                    }
                }
                out.push_str("\"ms\":\"<ms>\"");
                i = j;
                continue;
            }
        }
        let ch = m[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `normalizeMs`: volatile `ms` numbers become the `"<ms>"` string, at any
/// depth.
pub fn normalize_ms(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(normalize_ms).collect()),
        Value::Object(m) => {
            let mut o = serde_json::Map::new();
            for (k, val) in m {
                if k == "ms" && matches!(val, Value::Number(_)) {
                    o.insert(k.clone(), json!("<ms>"));
                } else {
                    o.insert(k.clone(), normalize_ms(val));
                }
            }
            Value::Object(o)
        }
        other => other.clone(),
    }
}

/// `parseLogical`: the response text as logical SSE frames (the contract —
/// transport chunk boundaries are not), plus the stream-done flag and the
/// unterminated tail.
pub fn parse_logical(text: &str) -> (Vec<Value>, bool, String) {
    let mut frames: Vec<Value> = Vec::new();
    let mut done = false;
    let mut rest = text;
    while let Some(i) = rest.find("\n\n") {
        push_event(&rest[..i], &mut frames, &mut done);
        rest = &rest[i + 2..];
    }
    (frames, done, rest.to_string())
}

fn push_event(ev: &str, frames: &mut Vec<Value>, done: &mut bool) {
    let payload = match ev.strip_prefix("data: ") {
        Some(p) => p,
        None => match ev.strip_prefix("data:") {
            Some(p) => p,
            None => return, // not a data event (parser ignores it)
        },
    };
    if payload == "[DONE]" {
        *done = true;
        frames.push(json!({ "kind": "done" }));
        return;
    }
    let obj: Option<Value> = serde_json::from_str(payload).ok();
    if let Some(Value::Object(m)) = &obj {
        if let Some(st) = m.get("ruke_stage") {
            frames.push(json!({ "kind": "stage", "obj": normalize_ms(st) }));
            return;
        }
        if let Some(er) = m.get("ruke_error") {
            let msg = er.get("message").and_then(Value::as_str).unwrap_or("");
            frames.push(json!({ "kind": "error", "message": msg }));
            return;
        }
    }
    frames.push(json!({ "kind": "data", "obj": obj.unwrap_or(Value::Null), "raw": payload }));
}

/// Assert the recorded response contract: exact status, the FULL header set
/// (the fixture map is the contract — golden.ts `headerMap`), the byte-exact
/// body where recorded (never for ms-bearing progress streams, which compare
/// `bodyMsNormalized` instead), and the logical frame sequence + tail.
pub fn assert_response(fixture: &Value, rel: &str, status: u16, headers: &HeaderMap, bytes: &[u8]) {
    let resp = &fixture["response"];
    assert_eq!(status, resp["status"].as_u64().unwrap() as u16, "{rel}: status");

    let mut got: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in headers {
        got.insert(k.as_str().to_ascii_lowercase(), v.to_str().unwrap().to_string());
    }
    let want: BTreeMap<String, String> = resp["headers"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect();
    assert_eq!(got, want, "{rel}: application header set");

    let text = String::from_utf8_lossy(bytes).into_owned();
    let body = &resp["body"];
    if let Some(norm) = body.get("bodyMsNormalized") {
        assert_eq!(normalize_body_ms(&text), norm.as_str().unwrap(), "{rel}: bodyMsNormalized");
    } else if let Some(lossy) = body.get("utf8Lossy") {
        assert!(body.get("base64").is_none(), "{rel}: this corpus records no base64 byte fixtures");
        assert_eq!(bytes, lossy.as_str().unwrap().as_bytes(), "{rel}: byte-exact body");
    }

    let (frames, done, tail) = parse_logical(&text);
    assert_eq!(
        Value::Array(frames),
        fixture["logicalFrames"].clone(),
        "{rel}: logical frames"
    );
    assert_eq!(done, fixture["streamDone"].as_bool().unwrap(), "{rel}: streamDone");
    assert_eq!(tail, fixture["unterminatedTail"].as_str().unwrap(), "{rel}: tail");
}

/// Assert the recorded upstream request contract. The recorded URL's host is
/// the harness placeholder (`MOCK_LLM_URL`), so the replay checks the path +
/// method + init headers + byte-identical body instead.
pub fn assert_upstream_call(fixture: &Value, rel: &str, calls: &[RecordedCall]) {
    let want = fixture["upstreamCalls"].as_array().unwrap();
    assert_eq!(calls.len(), want.len(), "{rel}: upstream call count");
    for (c, w) in calls.iter().zip(want) {
        assert_eq!(c.method, w["method"].as_str().unwrap(), "{rel}: upstream method");
        assert_eq!(c.path, "/v1/chat/completions", "{rel}: upstream path");
        for (k, v) in w["headers"].as_object().unwrap() {
            assert_eq!(
                c.headers.get(k.as_str()).map(String::as_str),
                v.as_str(),
                "{rel}: upstream header {k}"
            );
        }
        if let Some(bt) = w.get("bodyText") {
            assert_eq!(
                c.body_text.as_deref(),
                bt.as_str(),
                "{rel}: forwarded upstream body must be byte-identical"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Scripted mock upstream
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct Script {
    pub status: Option<u16>,
    pub chunks: Vec<Vec<u8>>,
    /// Respond with NO body at this status (undici's `body === null` class;
    /// in real HTTP that is 204/205/304, which the route maps to 502).
    pub no_body_status: Option<u16>,
    /// After `chunks`, hold the stream open until the client (the Rust
    /// forwarder) drops it; the flag then fires — the mock-side witness of
    /// client-abort propagation (zombie-turn protection).
    pub hold_until_abort: Option<Arc<AtomicBool>>,
    pub content_type: Option<String>,
}

impl Script {
    pub fn stream(chunks: Vec<Vec<u8>>) -> Self {
        Self { chunks, ..Default::default() }
    }
    pub fn http_error(status: u16, err_text: &str) -> Self {
        Self { status: Some(status), chunks: vec![err_text.as_bytes().to_vec()], ..Default::default() }
    }
    pub fn no_body() -> Self {
        Self { no_body_status: Some(204), ..Default::default() }
    }
    pub fn hold(chunks: Vec<Vec<u8>>, abort_flag: Arc<AtomicBool>) -> Self {
        Self { chunks, hold_until_abort: Some(abort_flag), ..Default::default() }
    }
}

#[derive(Clone)]
pub struct RecordedCall {
    pub path: String,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    pub body_text: Option<String>,
}

#[derive(Default)]
struct Inner {
    calls: Mutex<Vec<RecordedCall>>,
    scripts: Mutex<VecDeque<Script>>,
}

pub struct MockUpstream {
    base: String,
    inner: Arc<Inner>,
}

impl MockUpstream {
    pub async fn start(scripts: Vec<Script>) -> Self {
        let inner = Arc::new(Inner {
            calls: Mutex::new(Vec::new()),
            scripts: Mutex::new(scripts.into()),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/chat/completions", post(upstream_handle))
            .with_state(inner.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { base: format!("http://{addr}"), inner }
    }

    pub fn url(&self) -> String {
        format!("{}/v1/chat/completions", self.base)
    }

    pub fn calls(&self) -> Vec<RecordedCall> {
        self.inner.calls.lock().unwrap().clone()
    }
}

async fn upstream_handle(State(inner): State<Arc<Inner>>, req: Request) -> Response {
    let mut call = RecordedCall {
        path: req.uri().path().to_string(),
        method: req.method().as_str().to_string(),
        headers: req
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_ascii_lowercase(), v.to_str().unwrap_or("").to_string()))
            .collect(),
        body_text: None,
    };
    let body = axum::body::to_bytes(req.into_body(), 32_000_000).await.unwrap_or_default();
    call.body_text = std::str::from_utf8(&body).ok().map(str::to_string);
    inner.calls.lock().unwrap().push(call);

    let script = inner
        .scripts
        .lock()
        .unwrap()
        .pop_front()
        .expect("mock upstream: unexpected extra request (script over)");
    if let Some(st) = script.no_body_status {
        return Response::builder().status(st).body(Body::empty()).unwrap();
    }
    let status = StatusCode::from_u16(script.status.unwrap_or(200)).unwrap();
    let ct = script.content_type.unwrap_or_else(|| "text/event-stream".to_string());
    let body = match script.hold_until_abort {
        Some(flag) => Body::from_stream(HoldStream {
            pending: script.chunks.into_iter().map(Bytes::from).collect::<Vec<_>>().into_iter(),
            flag,
        }),
        None => Body::from_stream(futures_util::stream::iter(
            script.chunks.into_iter().map(|c| Ok::<_, std::io::Error>(Bytes::from(c))),
        )),
    };
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, ct)
        .body(body)
        .unwrap()
}

/// Emits the scripted chunks, then stays open forever; `Drop` (the client
/// walked away ⇒ hyper tore the connection down) raises the abort witness.
struct HoldStream {
    pending: std::vec::IntoIter<Bytes>,
    flag: Arc<AtomicBool>,
}

impl Stream for HoldStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.pending.next() {
            Some(b) => Poll::Ready(Some(Ok(b))),
            None => Poll::Pending,
        }
    }
}

impl Drop for HoldStream {
    fn drop(&mut self) {
        self.flag.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Direct-router driving
// ---------------------------------------------------------------------------

/// `POST /api/chat` through the real router via `oneshot` (no socket needed
/// except for the semantic abort test, which uses `axum::serve`).
pub async fn post_chat(state: &AppState, raw_body: &str) -> (u16, HeaderMap, Vec<u8>) {
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        build_router_for(state).oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/chat")
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(raw_body.to_string()))
                .unwrap(),
        ),
    )
    .await
    .expect("chat handler hung")
    .unwrap();
    let status = resp.status().as_u16();
    let headers = resp.headers().clone();
    let bytes = tokio::time::timeout(Duration::from_secs(20), axum::body::to_bytes(resp.into_body(), 1_000_000))
        .await
        .expect("chat body hung")
        .unwrap();
    (status, headers, bytes.to_vec())
}

fn build_router_for(state: &AppState) -> Router {
    ruke_server::build_router(state.clone())
}

/// Split bytes into chunked scripts at the given boundaries (exercising the
/// scrubber's chunk-independence on every replay).
pub fn split_chunks(data: &[u8], at: &[usize]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut prev = 0usize;
    for &i in at {
        out.push(data[prev..i].to_vec());
        prev = i;
    }
    out.push(data[prev..].to_vec());
    out
}

/// Rule 6: the inference slot released exactly once after a replay.
pub async fn assert_slot_idle(state: &AppState, rel: &str) {
    assert!(
        state.slot.wait_for_user_idle(Duration::from_secs(5), Duration::from_millis(10)).await,
        "{rel}: inference slot never released"
    );
    assert!(!state.slot.user_turn_active(), "{rel}: slot active after idle wait");
}
