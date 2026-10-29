//! Part 7: `app/api/settings/route.ts` — GET/PUT/DELETE mounted under
//! the Rust-only `/api/ruke/settings` namespace (cutover of the plain path
//! is Part 8; the lib.rs guard test keeps `/api/settings` 404).
//!
//! The status/shape table mirrors the TS verbatim:
//!
//! | GET    | 200 `{ settings }` — never leaks more than the settings object itself |
//! | PUT    | unparseable body → 400 `{error:"Invalid JSON body"}`; otherwise the three gated patch keys, then 200 `{ settings }` |
//! | DELETE | 200 `{ ok: true }` after `clearSettings` |
//!
//! Parity notes (patch-key gates are TS-exact):
//! - `llm_api_url`: only when `typeof === "string"` AND the trimmed value
//!   is non-empty — inserted TRIMMED (JS `trim()` = ECMAScript `\s`, via
//!   `jsstr`, not Rust `str::trim`).
//! - `llm_api_key`: only when `typeof === "string"` — inserted RAW
//!   (whitespace included; an empty string clears the key).
//! - `compact_thresholds`: only when an object carrying BOTH `auto` and
//!   `tokens` keys (`in` operator); the value is REPLACED by the normalized
//!   pair `{ auto: auto===1 ? 1 : 0, tokens: finite number ? max(0, round) : 0 }`
//!   — JS `Math.round` is `floor(x + 0.5)`; a non-number/non-finite `tokens`
//!   becomes 0; anything truthy-but-not-1 in `auto` becomes 0.
//!
//! RECORDED MICRO-DIVERGENCES:
//! - A `null` body: TS evaluates `body.llm_api_url` on null → TypeError →
//!   uncaught → generic Next 500. Rust's `Value::get` reads missing keys and
//!   replies 200 with an empty patch (observable only by status code).
//! - `tokens` magnitudes ≥ 2^63 saturate into the float arm instead of
//!   printing JS's exponential integer float (unreachable from the UI's
//!   number inputs).

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Map, Number, Value};

use ruke_skills::jsstr;

use crate::AppState;

pub async fn settings_get(State(state): State<AppState>) -> Response {
    json_response(StatusCode::OK, json!({ "settings": state.settings.read_settings() }))
}

pub async fn settings_put(State(state): State<AppState>, req: Request) -> Response {
    // `try { body = await req.json() } catch { 400 }` — the ONLY throw the
    // TS route catches. (Body size: TS route handlers have no limit;
    // usize::MAX mirrors that.)
    let bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };

    let mut patch = Map::new();
    if let Some(Value::String(s)) = body.get("llm_api_url") {
        let trimmed = jsstr::js_trim(s);
        if !trimmed.is_empty() {
            patch.insert("llm_api_url".into(), Value::String(trimmed.to_string()));
        }
    }
    if let Some(Value::String(s)) = body.get("llm_api_key") {
        patch.insert("llm_api_key".into(), Value::String(s.clone()));
    }
    // `ct && typeof ct === "object" && "auto" in ct && "tokens" in ct` —
    // arrays have neither key in JSON, so the object match is faithful.
    if let Some(Value::Object(ct)) = body.get("compact_thresholds") {
        if ct.contains_key("auto") && ct.contains_key("tokens") {
            let auto = if ct.get("auto").and_then(Value::as_f64) == Some(1.0) { 1 } else { 0 };
            let mut ct_norm = Map::new();
            ct_norm.insert("auto".into(), Value::Number(Number::from(auto)));
            ct_norm.insert("tokens".into(), match ct.get("tokens").and_then(Value::as_f64) {
                Some(x) if x.is_finite() => js_round_max0(x),
                _ => Value::Number(Number::from(0)),
            });
            patch.insert("compact_thresholds".into(), Value::Object(ct_norm));
        }
    }

    let settings = state.settings.update_settings(&patch);
    json_response(StatusCode::OK, json!({ "settings": settings }))
}

pub async fn settings_delete(State(state): State<AppState>) -> Response {
    state.settings.clear_settings();
    json_response(StatusCode::OK, json!({ "ok": true }))
}

/// `Math.max(0, Math.round(x))` — JS round is floor(x + 0.5) (so -0.4 → 0,
/// and -0.4999 never yields -0 since max clamps). Integer results stay
/// integer-typed so JSON prints without `.0` (serde f64 would print it).
fn js_round_max0(x: f64) -> Value {
    let r = (x + 0.5).floor();
    if r <= 0.0 {
        Value::Number(Number::from(0))
    } else if r < 9.0e18 {
        Value::Number(Number::from(r as i64))
    } else {
        Number::from_f64(r).map(Value::Number).unwrap_or_else(|| Value::Number(Number::from(0)))
    }
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn err(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "error": message }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::Request as HttpRequest;
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
            titles: Arc::new(TitleQueue::new(
                store,
                slot,
                Arc::new(UnconfiguredTitleModel),
            )),
            web: Arc::new(crate::WebRuntime {
                net: ruke_websearch::net::RealNet,
                cache: Arc::new(ruke_websearch::cache::SqliteSearchCache::new(tmp.path())),
                verticals: ruke_websearch::platform_api::RealVerticals,
                bridge: Arc::new(ruke_websearch::browser_bridge::NoBrowserBridge),
            }),
            browser: Arc::new(ruke_browser::engine::BrowserRuntime::new(
                tmp.path().to_path_buf(),
            )),
        };
        (state, tmp)
    }

    async fn call(
        state: &crate::AppState,
        method: &str,
        uri: &str,
        body: Body,
    ) -> (StatusCode, Value) {
        let req = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(body)
            .unwrap();
        let resp = crate::build_router(state.clone()).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 256_000).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn get_wraps_current_settings() {
        let (s, _t) = state();
        let (status, body) = call(&s, "GET", "/api/ruke/settings", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["settings"].is_object());
    }

    #[tokio::test]
    async fn put_gates_each_key_like_ts() {
        let (s, _t) = state();

        // url trimmed-in, key RAW, non-string types ignored.
        let (status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"llm_api_url":"  http://a:8080/v1  ","llm_api_key":"  spaced  ","llm_api_url2":5}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["settings"]["llm_api_url"], json!("http://a:8080/v1"));
        assert_eq!(body["settings"]["llm_api_key"], json!("  spaced  "));

        // Empty-string url fails the trim gate — NOT inserted, NOT cleared.
        let (status, body) =
            call(&s, "PUT", "/api/ruke/settings", Body::from(r#"{"llm_api_url":"   "}"#)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["settings"]["llm_api_url"], json!("http://a:8080/v1"));

        // compact_thresholds: needs BOTH keys; auto strict === 1; JS round.
        let (status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"compact_thresholds":{"auto":2,"tokens":-5}}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["settings"]["compact_thresholds"], json!({"auto": 0, "tokens": 0}));

        let (_status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"compact_thresholds":{"auto":1,"tokens":2.4}}"#),
        )
        .await;
        // Math.round(2.4) = 2; integer JSON (no "2.0").
        assert_eq!(
            serde_json::to_string(body["settings"]["compact_thresholds"].as_object().unwrap()).unwrap(),
            "{\"auto\":1,\"tokens\":2}"
        );

        // A partial object fails the `in` gates entirely — key untouched.
        let (_status, body) =
            call(&s, "PUT", "/api/ruke/settings", Body::from(r#"{"compact_thresholds":{"auto":1}}"#))
                .await;
        assert_eq!(body["settings"]["compact_thresholds"], json!({"auto": 1, "tokens": 2}));

        // tokens non-finite/non-number ⇒ 0.
        let (_status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"compact_thresholds":{"auto":"1","tokens":"12"}}"#),
        )
        .await;
        assert_eq!(body["settings"]["compact_thresholds"], json!({"auto": 0, "tokens": 0}));
    }

    #[tokio::test]
    async fn put_rejects_bad_json_accepts_null_bodies() {
        let (s, _t) = state();
        let (status, body) = call(&s, "PUT", "/api/ruke/settings", Body::from("{oops")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({ "error": "Invalid JSON body" }));

        // RECORDED deviation: TS would TypeError-500 on a null body; Rust
        // reads every key missing and replies 200 with an unchanged object.
        let (status, body) = call(&s, "PUT", "/api/ruke/settings", Body::from("null")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["settings"].is_object());
    }

    #[tokio::test]
    async fn delete_clears_then_get_returns_defaults() {
        let (s, _t) = state();
        call(&s, "PUT", "/api/ruke/settings", Body::from(r#"{"llm_api_key":"k"}"#)).await;
        let (status, body) = call(&s, "DELETE", "/api/ruke/settings", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "ok": true }));
        let (_status, body) = call(&s, "GET", "/api/ruke/settings", Body::empty()).await;
        assert_eq!(body["settings"].get("llm_api_key"), None);
    }
}
