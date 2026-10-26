//! Parity port of `lib/web-search/llm-json.ts` — the shared ONE-SHOT JSON
//! completion helper for the main model (:8080).
//!
//! TS module-doc lessons preserved verbatim: thinking must be forced OFF
//! (or a thinking model spends the whole output budget inside
//! `reasoning_content` and `message.content` comes back null), and a hard
//! timeout keeps a cold model load from holding the single inference slot
//! indefinitely. [`apply_thinking_off`] ⇔ `THINKING_OFF_BODY` so the search
//! gate and any audit send byte-identical flags.
//!
//! Slot accounting: TS `registerTitleCall`/`unregisterTitleCall` ⇔
//! [`InferenceSlot::title_call`] + RAII drop — a NEW user turn aborts this
//! call instead of queueing behind it (user traffic always owns the single
//! local slot). The AbortController maps to a [`CancellationToken`] (the
//! registered token IS the abort handle), the `setTimeout` abort maps to
//! the select arm's sleep, and `signal` maps to the caller's parent token.
//!
//! Micro-divergence (recorded, not fixed): JS serializes `temperature: 0`
//! as `0`, serde writes `0.0`. Nothing on either side byte-compares this
//! background body (no fixture pins gate-model calls — the web fixtures
//! run the gate Stage-0 hard bypass, which never reaches [`json_completion`]).

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use ruke_core::slot::InferenceSlot;

/// ⇔ `THINKING_OFF_BODY`: insert the two thinking-off flags. Insertion
/// order matches the TS spread (preserved by `serde_json` `preserve_order`).
pub fn apply_thinking_off(body: &mut Map<String, Value>) {
    body.insert("reasoning_effort".into(), Value::String("none".into()));
    let mut kwargs = Map::new();
    kwargs.insert("enable_thinking".into(), Value::Bool(false));
    body.insert("chat_template_kwargs".into(), Value::Object(kwargs));
}

/// `/<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/gi` — strip
/// thinking blocks (terminated OR orphan-truncated) before brace scanning.
fn re_think_block() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<(?:think|thinking)>[\s\S]*?(?:</(?:think|thinking)>|$)").unwrap())
}

/// `` /```(?:json)?\s*([\s\S]*?)```/i ``
fn re_fence() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)```(?:json)?\s*([\s\S]*?)```").unwrap())
}

/// ⇔ `extractJsonObject`: strip prose/code fences around a JSON payload the
/// model wrapped anyway. Brace window = first `{` .. last `}` after cleaning.
pub fn extract_json_object(text: &str) -> Option<String> {
    if text.is_empty() {
        return None; // TS `if (!text) return null`
    }
    let cleaned = re_think_block().replace_all(text, "");
    let candidate = match re_fence().captures(&cleaned) {
        Some(c) => c[1].to_string(),
        None => cleaned.into_owned(),
    };
    let start = candidate.find('{')?;
    let end = candidate.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(candidate[start..=end].to_string())
}

/// ⇔ `JsonCompletionOptions`. `endpoint`/`api_key` are resolved by the
/// CALLER (TS `MAIN_LLM_ENDPOINT()` reads settings per-call so a
/// settings.json change lands without restart; this crate must not depend
/// on `ruke-core::settings` wiring — the chat pipeline passes its own).
pub struct JsonCompletionOptions {
    pub system: String,
    pub user: String,
    /// llama.cpp structured-output grammar. Strongly recommended: small
    /// models drift out of JSON otherwise.
    pub json_schema: Option<Value>,
    pub max_tokens: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub temperature: Option<f64>,
    pub endpoint: String,
    pub api_key: String,
    /// Label for the log line ("search-gate", "claim-audit").
    pub label: Option<String>,
}

/// One non-streaming JSON call. Resolves to the parsed object, or `None` on
/// ANY failure (unreachable, non-200, timeout, abort, unparseable) — a
/// background call must never be able to break the turn that shares the
/// slot with it.
pub async fn json_completion(
    http: &reqwest::Client,
    slot: &Arc<InferenceSlot>,
    o: JsonCompletionOptions,
    // ⇔ `signal?: AbortSignal` — an already-cancelled parent behaves like a
    // pre-aborted signal (TS aborts the controller before the fetch).
    parent: Option<&CancellationToken>,
) -> Option<Value> {
    let label = o.label.clone().unwrap_or_else(|| "json-call".into());
    let timeout_ms = o.timeout_ms.unwrap_or(30_000);

    // ⇔ `new AbortController()` + `registerTitleCall(ctrl)`. The registered
    // token is the abort handle: begin_user_turn cancels it; the RAII guard
    // ⇔ the TS `finally { unregisterTitleCall }` on every return path.
    let ctrl = CancellationToken::new();
    let _reg = slot.title_call(ctrl.clone());

    let mut body = Map::new();
    body.insert("model".into(), Value::String("default".into()));
    body.insert("stream".into(), Value::Bool(false));
    body.insert(
        "temperature".into(),
        Value::from(o.temperature.unwrap_or(0.0)),
    );
    body.insert("max_tokens".into(), Value::from(o.max_tokens.unwrap_or(400)));
    apply_thinking_off(&mut body);
    let mut response_format = Map::new();
    response_format.insert("type".into(), Value::String("json_object".into()));
    if let Some(schema) = &o.json_schema {
        // TS replaces response_format with { type, json_schema } here.
        response_format.insert("json_schema".into(), schema.clone());
    }
    body.insert("response_format".into(), Value::Object(response_format));
    let mut sys = Map::new();
    sys.insert("role".into(), Value::String("system".into()));
    sys.insert("content".into(), Value::String(o.system.clone()));
    let mut usr = Map::new();
    usr.insert("role".into(), Value::String("user".into()));
    usr.insert("content".into(), Value::String(o.user.clone()));
    body.insert(
        "messages".into(),
        Value::Array(vec![Value::Object(sys), Value::Object(usr)]),
    );
    if let Some(schema) = &o.json_schema {
        // Top-level json_schema is what llama.cpp's structured-output path
        // reads (assigned last in TS, hence inserted last).
        body.insert("json_schema".into(), schema.clone());
    }

    let started = Instant::now();
    let ms = || started.elapsed().as_millis() as u64;
    let abort_msg = || format!("timeout/abort ({timeout_ms}ms)");

    let parent_fut = async {
        match parent {
            Some(p) => p.cancelled().await,
            None => std::future::pending::<()>().await,
        }
    };
    let req = http
        .post(&o.endpoint)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", o.api_key))
        .body(serde_json::to_vec(&Value::Object(body)).unwrap_or_default());

    let resp = tokio::select! {
        biased;
        _ = ctrl.cancelled() => {
            tracing::warn!(label = %label, ms = ms(), err = %abort_msg(), "json call failed");
            return None;
        }
        _ = parent_fut => {
            tracing::warn!(label = %label, ms = ms(), err = %abort_msg(), "json call failed");
            return None;
        }
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            tracing::warn!(label = %label, ms = ms(), err = %abort_msg(), "json call failed");
            return None;
        }
        r = req.send() => r,
    };
    let res = match resp {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(label = %label, ms = ms(), err = %e, "json call failed");
            return None;
        }
    };
    if !res.status().is_success() {
        tracing::warn!(label = %label, status = res.status().as_u16(), "json call non-200");
        return None;
    }
    // `await res.json().catch(() => null)` — a non-JSON body behaves like data = null.
    // (The workspace reqwest carries no `json` feature; parse the bytes.)
    let data = match res.bytes().await {
        Ok(b) => serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    let msg = data
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new())); // `?? {}`
    let content = msg.get("content").and_then(Value::as_str).unwrap_or("");
    let reasoning = msg
        .get("reasoning_content")
        .and_then(Value::as_str)
        .unwrap_or("");
    let raw = extract_json_object(content).or_else(|| extract_json_object(reasoning));
    let raw = match raw {
        Some(raw) => raw,
        None => {
            tracing::warn!(label = %label, ms = ms(), "json call returned no JSON object");
            return None;
        }
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(parsed) => {
            tracing::info!(label = %label, ms = ms(), "json call complete");
            Some(parsed)
        }
        Err(_) => {
            tracing::warn!(label = %label, ms = ms(), "json call returned unparseable JSON");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_object_matrix() {
        // Prose braces window.
        assert_eq!(extract_json_object("yes {\"a\":1} no").as_deref(), Some("{\"a\":1}"));
        // Fenced JSON.
        assert_eq!(
            extract_json_object("```json\n{\"a\":1}\n```").as_deref(),
            Some("{\"a\":1}")
        );
        // Thinking braces must NOT poison the window (terminated block).
        assert_eq!(
            extract_json_object("<think>{bad}</think>{\"a\":1}").as_deref(),
            Some("{\"a\":1}")
        );
        // Orphan-truncated think: strip to end ⇒ no JSON left.
        assert_eq!(extract_json_object("<think>{bad"), None);
        // Empty / no-brace / reversed-brace cases.
        assert_eq!(extract_json_object(""), None);
        assert_eq!(extract_json_object("no json here"), None);
        assert_eq!(extract_json_object("}{"), None);
    }

    // RAII ⇔ TS `finally`: an unreachable endpoint must still leave the
    // title registry EMPTY (no zombie registrations), exactly like the TS
    // finally block. (Also proves the None-on-any-failure contract.)
    #[tokio::test]
    async fn unreachable_endpoint_returns_none_and_unregisters() {
        let slot = Arc::new(InferenceSlot::new());
        let out = json_completion(
            &reqwest::Client::new(),
            &slot,
            JsonCompletionOptions {
                system: "s".into(),
                user: "u".into(),
                json_schema: None,
                max_tokens: None,
                timeout_ms: Some(2_000),
                temperature: None,
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(), // unroutable
                api_key: "golden-key".into(),
                label: Some("test-call".into()),
            },
            None,
        )
        .await;
        assert!(out.is_none());
        assert_eq!(slot.active_title_calls(), 0, "finally-equivalent released the registration");
    }

    // A NEW user turn aborts an in-flight call instead of queueing (the
    // whole point of the title-call registration).
    #[tokio::test]
    async fn user_turn_aborts_in_flight_call() {
        let slot = Arc::new(InferenceSlot::new());
        let slot2 = Arc::clone(&slot);
        let call = tokio::spawn(async move {
            json_completion(
                &reqwest::Client::new(),
                &slot2,
                JsonCompletionOptions {
                    system: "s".into(),
                    user: "u".into(),
                    json_schema: None,
                    max_tokens: None,
                    timeout_ms: Some(60_000),
                    temperature: None,
                    // Bound port 9 never answers; the abort must win first.
                    endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                    api_key: "k".into(),
                    label: None,
                },
                None,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let _turn = slot.begin_guard();
        let out = call.await.unwrap();
        assert!(out.is_none());
        assert_eq!(slot.active_title_calls(), 0);
    }
}
