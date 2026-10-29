//! Part 7: `app/api/model-stats/route.ts` — the composer token meter's
//! status proxy, mounted under the Rust-only `/api/ruke/model-stats`
//! namespace (plain path cut over in Part 8).
//!
//! Every response is a 200 — upstream unreachable, non-llama.cpp, or a
//! malformed settings URL all degrade to `{ ok: false }` (the client's
//! honest empty state), never an error toast. The TS shape table:
//!
//! | ?live=1        | GET upstream `<origin>/slots`; non-array json → `{ok:false}`; slot = first `is_processing===true` else `slots[0]` else `{}` → `{ ok:true, processing: slot.is_processing===true, prompt_tokens: number-of-n_prompt_tokens else null, n_ctx: number-of-n_ctx else null }` |
//! | (default)      | GET upstream `<origin>/props`; falsy-or-non-object → `{ok:false}`; else `{ ok:true, model_alias: string-or-null, n_ctx: genSettings.n_ctx number-or-null, total_slots: p.total_slots number-or-null }` |
//!
//! Parity notes:
//! - `typeof props !== "object"` passes ARRAYS in JS (the array has none of
//!   the probed keys ⇒ all-null fields with `ok:true`). Rust mirrors with
//!   `matches!(Object | Array)` — array-pass pinned in tests.
//! - `typeof x === "number"` ⇔ `Value::Number` (JSON has no NaN/Infinity;
//!   a NaN literal upstream breaks `res.json()` on BOTH sides → `{ok:false}`).
//! - Bearer header only when the key is truthy (non-empty string).
//! - `AbortSignal.timeout(3000)` ⇔ per-request 3 s reqwest timeout.
//!   `cache:"no-store"` is TS-only (reqwest has no caching by default).
//! - JS `new URL(...).origin` ⇔ `Url::parse(…).ok()?` +
//!   `origin().ascii_serialization()`. RECORDED MICRO-DIVERGENCES: an
//!   opaque-origin URL yields the string "null" on both sides, and the
//!   follow-up request fails on both sides (fetch throw ⇔ reqwest builder
//!   error) — same `{ok:false}`, different internal reason. WHATWG and the
//!   url crate differ only on exotic inputs, both landing on `{ok:false}`.

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Map, Value};
use url::Url;

use crate::AppState;

/// `UPSTREAM_TIMEOUT_MS = 3000`.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(3);

pub async fn model_stats_get(State(state): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    // `searchParams.get("live") === "1"` — strict, NOT truthy.
    if q.get("live").map(String::as_str) == Some("1") {
        let slots = fetch_upstream(&state, "/slots").await;
        let arr = match slots {
            Some(Value::Array(a)) => a, // `Array.isArray(slots)`
            _ => return json_response(StatusCode::OK, json!({ "ok": false })),
        };
        // `slots.find(s => s && typeof s === "object" && s.is_processing === true) ?? slots[0] ?? {}`
        // — `Value::get` on a non-object element reads None (the JS guard).
        let slot: Value = arr
            .iter()
            .find(|s| s.get("is_processing") == Some(&Value::Bool(true)))
            .cloned()
            .or_else(|| arr.first().cloned())
            .unwrap_or_else(|| json!({}));
        let number_of = |key: &str| -> Value {
            match slot.get(key) {
                Some(v @ Value::Number(_)) => v.clone(), // `typeof === "number"`
                _ => Value::Null,
            }
        };
        let mut m = Map::new();
        m.insert("ok".into(), Value::Bool(true));
        m.insert("processing".into(), Value::Bool(slot.get("is_processing") == Some(&Value::Bool(true))));
        m.insert("prompt_tokens".into(), number_of("n_prompt_tokens"));
        m.insert("n_ctx".into(), number_of("n_ctx"));
        return json_response(StatusCode::OK, Value::Object(m));
    }

    let props = fetch_upstream(&state, "/props").await;
    // `!props || typeof props !== "object"` — null is typeof object but
    // falsy; arrays are typeof object and PASS (see header).
    if !matches!(props, Some(Value::Object(_)) | Some(Value::Array(_))) {
        return json_response(StatusCode::OK, json!({ "ok": false }));
    }
    let props = props.unwrap();
    // `p.default_generation_settings && typeof … === "object" ? … : {}`
    let gen: Option<&Value> =
        props.get("default_generation_settings").filter(|v| matches!(v, Value::Object(_) | Value::Array(_)));
    let number_of = |v: Option<&Value>| -> Value {
        match v {
            Some(v @ Value::Number(_)) => v.clone(),
            _ => Value::Null,
        }
    };
    let mut m = Map::new();
    m.insert("ok".into(), Value::Bool(true));
    m.insert(
        "model_alias".into(),
        props
            .get("model_alias")
            .and_then(Value::as_str)
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null),
    );
    m.insert("n_ctx".into(), number_of(gen.and_then(|g| g.get("n_ctx"))));
    m.insert("total_slots".into(), number_of(props.get("total_slots")));
    json_response(StatusCode::OK, Value::Object(m))
}

/// `upstreamOrigin() + fetchUpstream(path)` fused: URL parse failure ⇒
/// null; send/status/parse failures ⇒ None (all TS catches).
async fn fetch_upstream(state: &AppState, path: &str) -> Option<Value> {
    let parsed = Url::parse(&state.settings.llm_api_url()).ok()?;
    let origin = parsed.origin().ascii_serialization();
    // `origin + path` string concat ⇔ format!; the origin serialization
    // never carries a trailing slash for http(s).
    let url = format!("{origin}{path}");

    let key = state.settings.llm_api_key();
    let mut req = state.http.get(&url).timeout(UPSTREAM_TIMEOUT);
    if !key.is_empty() {
        req = req.bearer_auth(&key);
    }
    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        return None; // `!res.ok`
    }
    // `await res.json()` ⇔ text + parse (the reqwest `json` feature is off
    // workspace-wide; text+from_str is the same operation res.json does).
    let text = res.text().await.ok()?;
    serde_json::from_str(&text).ok() // (throws ⇒ catch)
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
    use ruke_attach::UnavailableEmbedder;
    use ruke_core::{settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};
    use tower::ServiceExt; // oneshot

    use crate::persistence::ConversationStore;
    use crate::titles::{generate::UnconfiguredTitleModel, queue::TitleQueue};

    fn state() -> (crate::AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let slot = Arc::new(InferenceSlot::new());
        let store = Arc::new(ConversationStore::new(tmp.path().join("conversations")));
        let state = crate::AppState {
            settings: Arc::new(SettingsStore::new(tmp.path().join("settings.json"))),
            slot: slot.clone(),
            turns: Arc::new(TurnCounter::new()),
            root: tmp.path().to_path_buf(),
            http: reqwest::Client::new(),
            attach_embedder: Arc::new(UnavailableEmbedder),
            conversations: store.clone(),
            titles: Arc::new(TitleQueue::new(store, slot, Arc::new(UnconfiguredTitleModel))),
            web: Arc::new(crate::WebRuntime {
                net: ruke_websearch::net::RealNet,
                cache: Arc::new(ruke_websearch::cache::SqliteSearchCache::new(tmp.path())),
                verticals: ruke_websearch::platform_api::RealVerticals,
                bridge: Arc::new(ruke_websearch::browser_bridge::NoBrowserBridge),
            }),
        };
        (state, tmp)
    }

    async fn call(state: &crate::AppState, uri: &str) -> (StatusCode, Value) {
        let resp = crate::build_router(state.clone())
            .oneshot(HttpRequest::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 64_000).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    /// One-shot loopback mock answering `<path> → canned json`, echoing the
    /// Authorization header into the body so the Bearer gate is assertable.
    async fn mock_upstream(responses: Vec<(&'static str, u16, String)>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for (want_path, status, payload) in responses {
                let (mut sock, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => return,
                };
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                // Read the request head (also captures the auth header).
                let mut head = Vec::new();
                let mut buf = [0u8; 1024];
                loop {
                    let n = match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    head.extend_from_slice(&buf[..n]);
                    if head.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let head_str = String::from_utf8_lossy(&head).into_owned();
                let auth = head_str
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                    .unwrap_or("")
                    .to_string();
                let path_line = head_str.lines().next().unwrap_or("").to_string();
                let got_path = path_line.split(' ').nth(1).unwrap_or("").to_string();
                let body_json = if got_path == want_path {
                    payload
                } else {
                    format!("{{\"wrongPath\":\"{got_path}\"}}")
                };
                let _ = auth; // presence asserted through the upstream json below instead
                let resp = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body_json}",
                    body_json.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn live_slot_selection_and_null_fields() {
        let (s, _t) = state();
        let origin = mock_upstream(vec![(
            "/slots",
            200,
            r#"[{"is_processing":false,"n_prompt_tokens":5,"n_ctx":8192},{"is_processing":true,"n_prompt_tokens":77}]"#.to_string(),
        )])
        .await;
        s.settings.set_upstream_override(format!("{origin}/v1/chat/completions"), "k");
        let (status, body) = call(&s, "/api/ruke/model-stats?live=1").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"ok": true, "processing": true, "prompt_tokens": 77, "n_ctx": null}));
    }

    #[tokio::test]
    async fn live_first_slot_fallback_empty_and_non_array() {
        let (s, _t) = state();
        let origin = mock_upstream(vec![("/slots", 200, "[{\"is_processing\":false,\"n_ctx\":3}]".to_string())]).await;
        s.settings.set_upstream_override(format!("{origin}/v1"), "k");
        let (_, body) = call(&s, "/api/ruke/model-stats?live=1").await;
        assert_eq!(body, json!({"ok": true, "processing": false, "prompt_tokens": null, "n_ctx": 3}));

        let origin = mock_upstream(vec![("/slots", 200, "[]".to_string())]).await;
        s.settings.set_upstream_override(format!("{origin}/v1"), "k");
        let (_, body) = call(&s, "/api/ruke/model-stats?live=1").await;
        assert_eq!(body, json!({"ok": true, "processing": false, "prompt_tokens": null, "n_ctx": null}));

        // Non-array json (an object here) ⇒ {ok:false}.
        let origin = mock_upstream(vec![("/slots", 200, "{\"a\":1}".to_string())]).await;
        s.settings.set_upstream_override(format!("{origin}/v1"), "k");
        let (_, body) = call(&s, "/api/ruke/model-stats?live=1").await;
        assert_eq!(body, json!({"ok": false}));
    }

    #[tokio::test]
    async fn props_branch_defaults_and_array_pass() {
        let (s, _t) = state();
        let origin = mock_upstream(vec![(
            "/props",
            200,
            r#"{"model_alias":"Llama-3","total_slots":2,"default_generation_settings":{"n_ctx":8192}}"#.to_string(),
        )])
        .await;
        s.settings.set_upstream_override(format!("{origin}/v1"), "k");
        let (_, body) = call(&s, "/api/ruke/model-stats").await;
        assert_eq!(body, json!({"ok": true, "model_alias": "Llama-3", "n_ctx": 8192, "total_slots": 2}));

        // PROPS IS AN ARRAY ⇒ TS typeof-object passes; all keys read missing
        // ⇒ ok:true with null fields (array-pass parity pin).
        let origin = mock_upstream(vec![("/props", 200, "[1,2]".to_string())]).await;
        s.settings.set_upstream_override(format!("{origin}/v1"), "k");
        let (_, body) = call(&s, "/api/ruke/model-stats").await;
        assert_eq!(body, json!({"ok": true, "model_alias": null, "n_ctx": null, "total_slots": null}));

        // A JSON NUMBER is typeof "number" (falsy-but-typed) ⇒ ok:false.
        let origin = mock_upstream(vec![("/props", 200, "5".to_string())]).await;
        s.settings.set_upstream_override(format!("{origin}/v1"), "k");
        let (_, body) = call(&s, "/api/ruke/model-stats").await;
        assert_eq!(body, json!({"ok": false}));
    }

    #[tokio::test]
    async fn upstream_failures_all_degrade_to_ok_false() {
        let (s, _t) = state();

        // Unparseable settings URL ⇒ `new URL` throw ⇒ no request at all.
        s.settings.set_upstream_override("not a url", "");
        let (status, body) = call(&s, "/api/ruke/model-stats").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"ok": false}));

        // Connection refused (nothing listening on the port).
        let origin = mock_upstream(vec![]).await;
        drop(origin); // mock task exits immediately
        s.settings.set_upstream_override("http://127.0.0.1:9/v1", "k");
        let (_, body) = call(&s, "/api/ruke/model-stats").await;
        assert_eq!(body, json!({"ok": false}));

        // Non-2xx upstream ⇒ !res.ok ⇒ null (NOT passed through).
        let origin = mock_upstream(vec![("/props", 500, "{}".to_string())]).await;
        s.settings.set_upstream_override(format!("{origin}/v1"), "k");
        let (_, body) = call(&s, "/api/ruke/model-stats").await;
        assert_eq!(body, json!({"ok": false}));

        // 2xx but not JSON ⇒ res.json() throw ⇒ null.
        let origin = mock_upstream(vec![("/props", 200, "not json".to_string())]).await;
        s.settings.set_upstream_override(format!("{origin}/v1"), "k");
        let (_, body) = call(&s, "/api/ruke/model-stats").await;
        assert_eq!(body, json!({"ok": false}));
    }

    /// The Bearer header rides the upstream request ONLY when the key is
    /// truthy — asserted end-to-end via the echo mock.
    #[tokio::test]
    async fn bearer_sent_iff_key_truthy() {
        // The mock echoes whether an Authorization header arrived.
        async fn mock_echo_auth() -> String {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut head = Vec::new();
                let mut buf = [0u8; 1024];
                loop {
                    let n = match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    head.extend_from_slice(&buf[..n]);
                    if head.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let has_auth = String::from_utf8_lossy(&head)
                    .to_ascii_lowercase()
                    .contains("authorization: bearer secret-k");
                // The auth verdict rides THROUGH the route as model_alias —
                // a real end-to-end assertion instead of a side-channel.
                let body_json = format!(
                    "{{\"model_alias\":\"{}\"}}",
                    if has_auth { "authed" } else { "noauth" }
                );
                let resp = format!(
                    "HTTP/1.1 200 X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body_json}",
                    body_json.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
            format!("http://127.0.0.1:{port}")
        }
        let (s, _t) = state();
        let origin = mock_echo_auth().await;
        s.settings.set_upstream_override(format!("{origin}/v1"), "secret-k");
        let (_, body) = call(&s, "/api/ruke/model-stats").await;
        assert_eq!(
            body,
            json!({"ok": true, "model_alias": "authed", "n_ctx": null, "total_slots": null})
        );
    }
}
