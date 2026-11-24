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
//! - Engine keys: `speech_model` only when `typeof === "string"` — inserted
//!   RAW; `ocr_engine` only the named engines `"paddle"` / `"tesseract"` /
//!   `""` (the empty string is the PaddleOCR-default selection); junk is
//!   dropped. The retired marketplace keys (`hf_token`, `model_mirror`) are
//!   NOT writable: their writes are ignored (final-decision addendum
//!   2026-11-22 — the Hugging Face token/mirror surface is removed).
//! - Every GET/PUT first runs `migrate_engines`: a stored `hf_token`/
//!   `model_mirror` is PURGED from the store, and a `speech_model` stored
//!   with anything other than the fixed Parakeet id is rewritten to it
//!   (visible migration of an obsolete ASR preference). On the ONE read that
//!   rewrote it, the response also carries `speech_model_migrated: <old
//!   value>` — present only on the migrating read. An explicit
//!   Tesseract-only `ocr_engine` is preserved untouched. The response view
//!   never carries the retired keys, in any spelling (`hf_token_set`
//!   included). Parity: `migrateEngines`/`settingsResponse` in
//!   app/api/settings/route.ts.
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
    let (settings, migrated_from) = migrate_engines(&state.settings);
    settings_response(settings, migrated_from)
}

/// The body both GET and PUT answer: the public settings view, plus
/// `speech_model_migrated: <obsolete value>` on the ONE read that rewrote an
/// obsolete ASR preference (the "migrate VISIBLY" law).
fn settings_response(settings: Map<String, Value>, migrated_from: Option<String>) -> Response {
    let mut body = Map::new();
    body.insert("settings".into(), public_settings(settings));
    if let Some(old) = migrated_from {
        body.insert("speech_model_migrated".into(), Value::String(old));
    }
    json_response(StatusCode::OK, Value::Object(body))
}

/// The frozen English release names ONE ASR engine (final decision 2026-11-22):
/// the registry's pinned Parakeet row. Parity with PARAKEET_ID in
/// python-backend/ruke_ml/models/registry.py and FIXED_SPEECH_MODEL in
/// lib/settings/client.ts.
pub const FIXED_SPEECH_MODEL: &str = "nvidia/parakeet-tdt-0.6b-v3";

/// FINAL DECISION addendum 2026-11-22: the Hugging Face token/mirror fields
/// belonged to the removed model-manager surface, and Parakeet is the sole
/// ASR engine. An existing install's retired settings are migrated ONCE,
/// visibly: `hf_token`/`model_mirror` are purged from the store, and a
/// `speech_model` stored with any other value is rewritten to the fixed
/// Parakeet id. An explicit Tesseract-only `ocr_engine` is PRESERVED.
/// Parity of `migrateEngines` in app/api/settings/route.ts. The second
/// element is the OBSOLETE speech_model value when it was rewritten, so the
/// response can name it (`speech_model_migrated`).
fn migrate_engines(store: &ruke_core::settings::SettingsStore) -> (Map<String, Value>, Option<String>) {
    let current = store.read_settings();
    let purge: Vec<&str> = ["hf_token", "model_mirror"]
        .into_iter()
        .filter(|k| current.contains_key(*k))
        .collect();
    let migrated_from = current
        .get("speech_model")
        .filter(|v| *v != &json!(FIXED_SPEECH_MODEL))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if purge.is_empty() && migrated_from.is_none() {
        return (current, None);
    }
    let mut next = current;
    for k in purge {
        next.remove(k);
    }
    if migrated_from.is_some() {
        next.insert("speech_model".into(), json!(FIXED_SPEECH_MODEL));
    }
    (store.replace_settings(&next), migrated_from)
}

/// The browser-visible view: never carries the retired marketplace keys in
/// any spelling — not the values, not the old `hf_token_set` shadow.
fn public_settings(settings: Map<String, Value>) -> Value {
    let mut map = settings;
    map.remove("hf_token");
    map.remove("model_mirror");
    map.remove("hf_token_set");
    Value::Object(map)
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
            let auto = if ct.get("auto").and_then(Value::as_f64) == Some(1.0) {
                1
            } else {
                0
            };
            let mut ct_norm = Map::new();
            ct_norm.insert("auto".into(), Value::Number(Number::from(auto)));
            ct_norm.insert(
                "tokens".into(),
                match ct.get("tokens").and_then(Value::as_f64) {
                    Some(x) if x.is_finite() => js_round_max0(x),
                    _ => Value::Number(Number::from(0)),
                },
            );
            patch.insert("compact_thresholds".into(), Value::Object(ct_norm));
        }
    }
    // Engine keys — parity with the TS arm: speech_model strings raw (the
    // migration below normalizes any non-Parakeet value), ocr_engine is a
    // NAMED engine (unset/"" = the PaddleOCR default). The retired hf_token
    // and model_mirror writes are IGNORED: the surface that read them is
    // removed, and ignoring is the only write that cannot resurrect it.
    if let Some(Value::String(s)) = body.get("speech_model") {
        patch.insert("speech_model".into(), Value::String(s.clone()));
    }
    if let Some(Value::String(s)) = body.get("ocr_engine") {
        if s == "paddle" || s == "tesseract" || s.is_empty() {
            patch.insert("ocr_engine".into(), Value::String(s.clone()));
        }
    }

    state.settings.update_settings(&patch);
    let (settings, migrated_from) = migrate_engines(&state.settings);
    settings_response(settings, migrated_from)
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
        Number::from_f64(r)
            .map(Value::Number)
            .unwrap_or_else(|| Value::Number(Number::from(0)))
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
            admission: Arc::new(ruke_core::admission::UpstreamAdmission::new()),
            root: tmp.path().to_path_buf(),
            http: reqwest::Client::new(),
            attach_embedder: Arc::new(UnavailableEmbedder),
            conversations: store.clone(),
            titles: Arc::new(TitleQueue::new(
                store,
                slot,
                Arc::new(UnconfiguredTitleModel),
            )),
            next_search: None,
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
        let resp = crate::build_router(state.clone())
            .oneshot(req)
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 256_000)
            .await
            .unwrap();
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
        let (status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"llm_api_url":"   "}"#),
        )
        .await;
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
        assert_eq!(
            body["settings"]["compact_thresholds"],
            json!({"auto": 0, "tokens": 0})
        );

        let (_status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"compact_thresholds":{"auto":1,"tokens":2.4}}"#),
        )
        .await;
        // Math.round(2.4) = 2; integer JSON (no "2.0").
        assert_eq!(
            serde_json::to_string(body["settings"]["compact_thresholds"].as_object().unwrap())
                .unwrap(),
            "{\"auto\":1,\"tokens\":2}"
        );

        // A partial object fails the `in` gates entirely — key untouched.
        let (_status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"compact_thresholds":{"auto":1}}"#),
        )
        .await;
        assert_eq!(
            body["settings"]["compact_thresholds"],
            json!({"auto": 1, "tokens": 2})
        );

        // tokens non-finite/non-number ⇒ 0.
        let (_status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"compact_thresholds":{"auto":"1","tokens":"12"}}"#),
        )
        .await;
        assert_eq!(
            body["settings"]["compact_thresholds"],
            json!({"auto": 0, "tokens": 0})
        );
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
    async fn engine_keys_persist_and_retired_ones_migrate_visibly() {
        let (s, _t) = state();

        // FINAL DECISION addendum 2026-11-22, parity with
        // app/api/settings/route.ts: a legacy install carrying the retired
        // marketplace keys and an obsolete ASR choice migrates on the first
        // read — the keys are purged from the STORE, the ASR preference is
        // rewritten to the fixed Parakeet, and an explicit Tesseract-only
        // selection survives untouched.
        s.settings.update_settings(&serde_json::from_str::<Map<String, Value>>(
            r#"{"speech_model":"Systran/faster-whisper-base","ocr_engine":"tesseract","model_mirror":"https://mirror.example","hf_token":"hf_serverSideSecret"}"#,
        ).unwrap());
        let (_status, body) = call(&s, "GET", "/api/ruke/settings", Body::empty()).await;
        assert_eq!(
            body["settings"]["speech_model"],
            json!(FIXED_SPEECH_MODEL)
        );
        assert_eq!(body["settings"]["ocr_engine"], json!("tesseract"));
        assert_eq!(body["settings"].get("hf_token"), None);
        assert_eq!(body["settings"].get("model_mirror"), None);
        assert_eq!(body["settings"].get("hf_token_set"), None);
        assert!(!body.to_string().contains("hf_serverSideSecret"));
        // The migration is VISIBLE: the response names the obsolete preference
        // it rewrote (client shows it in the Engines tab).
        assert_eq!(
            body["speech_model_migrated"],
            json!("Systran/faster-whisper-base")
        );

        // The migration PERSISTED: the store itself is purged, not just the view.
        let stored = s.settings.read_settings();
        assert_eq!(stored.get("hf_token"), None);
        assert_eq!(stored.get("model_mirror"), None);
        assert_eq!(stored.get("speech_model"), Some(&json!(FIXED_SPEECH_MODEL)));

        // A retired-key WRITE is ignored: it cannot resurrect the surface.
        let (_status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"hf_token":"hf_new","model_mirror":"https://evil.example"}"#),
        )
        .await;
        assert_eq!(body["settings"].get("hf_token"), None);
        assert_eq!(body["settings"].get("model_mirror"), None);
        assert!(!body.to_string().contains("hf_new"));
        assert!(!body.to_string().contains("evil.example"));

        // A legacy speech_model written through PUT comes back as Parakeet,
        // visibly named by speech_model_migrated.
        let (_status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"speech_model":"OpenAI/whisper-large"}"#),
        )
        .await;
        assert_eq!(
            body["settings"]["speech_model"],
            json!(FIXED_SPEECH_MODEL)
        );
        assert_eq!(body["speech_model_migrated"], json!("OpenAI/whisper-large"));

        // A clean read after the migration says nothing: the notice appears
        // only on the read that migrated.
        let (_status, body) = call(&s, "GET", "/api/ruke/settings", Body::empty()).await;
        assert_eq!(body.get("speech_model_migrated"), None);

        // Named-engine gate stays: junk is not persisted; a non-string
        // speech_model write is ignored by the arm.
        let (_status, body) = call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"ocr_engine":"make-me-a-sandwich","speech_model":{"path":"C:/models"}}"#),
        )
        .await;
        assert_eq!(body["settings"]["ocr_engine"], json!("tesseract"));
        assert_eq!(
            body["settings"]["speech_model"],
            json!(FIXED_SPEECH_MODEL)
        );

        // An empty ocr_engine write is the "PaddleOCR default" selection.
        let (_status, body) =
            call(&s, "PUT", "/api/ruke/settings", Body::from(r#"{"ocr_engine":""}"#)).await;
        assert_eq!(body["settings"]["ocr_engine"], json!(""));
    }

    #[tokio::test]
    async fn a_clean_store_gets_no_migration_write() {
        let (s, _t) = state();
        call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"llm_api_key":"k","ocr_engine":"paddle"}"#),
        )
        .await;
        let before = s.settings.read_settings();
        let (_status, _body) = call(&s, "GET", "/api/ruke/settings", Body::empty()).await;
        // Migration is idempotent and silent: nothing retired, nothing added.
        assert_eq!(s.settings.read_settings(), before);
    }

    #[tokio::test]
    async fn delete_clears_then_get_returns_defaults() {
        let (s, _t) = state();
        call(
            &s,
            "PUT",
            "/api/ruke/settings",
            Body::from(r#"{"llm_api_key":"k"}"#),
        )
        .await;
        let (status, body) = call(&s, "DELETE", "/api/ruke/settings", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "ok": true }));
        let (_status, body) = call(&s, "GET", "/api/ruke/settings", Body::empty()).await;
        assert_eq!(body["settings"].get("llm_api_key"), None);
    }
}
