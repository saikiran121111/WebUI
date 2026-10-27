//! Part 7: `app/api/conversations/route.ts` (GET/POST),
//! `app/api/conversations/[id]/route.ts` (GET/PUT/DELETE) and
//! `app/api/conversations/[id]/title/route.ts` (POST) — mounted under the
//! Rust-only `/api/ruke/conversations*` namespace (the plain paths stay
//! Next-owned until the Part 8 cutover; the lib.rs guard test pins
//! `/api/conversations` at 404 for now). The on-disk store semantics live
//! in `crate::persistence` and the title scheduler in `crate::titles`
//! (both ported & unit-gated earlier in this Part).
//!
//! The status/shape table mirrors the TS verbatim:
//!
//! | GET    /conversations          | 200 array of `{id, updatedAt, meta}` for parsable docs with a truthy raw payload AND truthy `doc.meta` (per-doc JSON.parse failures are swallowed → that doc is dropped) |
//! | POST   /conversations          | missing-falsy id or non-string json → 400 `{error:"id and json required"}`; then `saveConversationOnDisk(id, mergeProtectedTitle(get(id), json))` → `{ok:true}` |
//! | GET    /conversations/{id}     | falsy stored payload → 404 `{error:"not found"}`; else the stored text VERBATIM with `content-type: application/json` |
//! | PUT    /conversations/{id}     | body read as TEXT (no parse, no merge) → save → `{ok:true}` |
//! | DELETE /conversations/{id}     | GC: `raw.match(/att_[a-z0-9]{4,32}/g)` → `removeIndex` per unique id → `deleteConversationOnDisk` → `{ok:true}` (always 200) |
//! | POST   /conversations/{id}/title | eligibility via `requestTitleGeneration` (force ⇔ `?force=1` strict); skipped → `{queued:false,reason}`; coalesced → `{queued:true,coalesced:true}`; else await job → `{queued:true, ...job}` |
//!
//! Parity notes:
//! - The GET list's three skip rules are TS-exact: `if (!raw) return null`
//!   (an EMPTY file reads as "" ⇒ falsy ⇒ skipped, same as a missing one),
//!   `catch { }` around JSON.parse, and `if (!meta) return null`.
//! - `updatedAt` is the file mtime in ms — `js_ms_number` keeps whole
//!   numbers integer-printed the way JS number→JSON does.
//! - DELETE's att-index GC mirrors the TS greedy `{4,32}` regex + first-
//!   seen Set; `ruke_attach::remove_index` never throws (the TS removeIndex
//!   swallows its own errors), so a bogus-but-matching id is a silent no-op.
//! - Title POST: `req.json().catch(()=>null)` inside an empty try/catch —
//!   a malformed body NEVER fails the request; it just yields no model
//!   override. `model` only when `typeof === "string"` and non-empty.
//! - `{queued:true, ...done}` spread order preserved (queued first).
//!
//! RECORDED MICRO-DIVERGENCES (all are the TS *uncaught throw* → generic
//! Next 500 HTML path, which Rust replaces with a 500 `{error}` envelope —
//! status class identical, body format differs; browsers only check
//! `res.ok` on these calls):
//! - POST create: invalid JSON body (TS `await req.json()` OUTSIDE any
//!   catch), a null body (`body.id` TypeError), a truthy non-string id
//!   (later `id.replace` TypeError), or a save write failure.
//! - PUT/DELETE: body-read or store write failures.
//! - Title POST: a job error (conversation save failure mid-job) → 500;
//!   a closed job channel (impossible unless the worker panicked) →
//!   `{queued:true, ok:false, reason:"no-job"}` mirroring TS's
//!   `Promise.resolve` fallback rather than a throw.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use axum::extract::{Path, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde_json::{json, Map, Value};

use ruke_skills::jsstr;

use crate::persistence::{js_ms_number, merge_protected_title};
use crate::titles::queue::RequestOutcome;
use crate::AppState;

/// `/api/ruke/conversations` GET — enriched, meta-bearing index.
pub async fn conversations_list_get(State(state): State<AppState>) -> Response {
    let items = match state.conversations.list() {
        Ok(v) => v,
        // TS listConversationsOnDisk swallows read_dir errors as []; the
        // ensure_dir mkdir failure is the one throw that reaches the route
        // uncaught → generic 500. Rust: 500 {error} envelope.
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let mut out: Vec<Value> = Vec::new();
    for it in items {
        // `if (!raw) return null` — covers both a vanished file and an
        // empty one (from_utf8_lossy gives Some(""), which is falsy in JS).
        let raw = match state.conversations.get(&it.id) {
            Some(r) if !r.is_empty() => r,
            _ => continue,
        };
        // `try { doc = JSON.parse(raw) } catch { return null }`
        let doc: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // `const meta = doc.meta; if (!meta) return null`
        let meta = match doc.get("meta") {
            Some(m) if jsstr::js_truthy(m) => m.clone(),
            _ => continue,
        };
        let mut rec = Map::new();
        rec.insert("id".into(), Value::String(it.id));
        rec.insert("updatedAt".into(), js_ms_number(it.updated_at));
        rec.insert("meta".into(), meta);
        out.push(Value::Object(rec));
    }
    json_response(StatusCode::OK, Value::Array(out))
}

/// `/api/ruke/conversations` POST — merge-preserving upsert.
pub async fn conversation_create_post(State(state): State<AppState>, req: Request) -> Response {
    // TS `const body = await req.json()` is OUTSIDE any catch (the 400
    // below is only the required-fields gate). Recorded deviation.
    let bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "invalid request body"),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "invalid JSON body"),
    };
    // TS evaluates `body.id` BEFORE any gate: on a null body that is a
    // TypeError (uncaught ⇒ generic 500). Primitive string/number/bool
    // bodies do NOT throw (property access on the wrapper is legal, reads
    // undefined ⇒ falls to the 400 gate) — only Null needs the extra arm.
    if body.is_null() {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "null body (TS: body.id TypeError)",
        );
    }
    // `if (!body.id || typeof body.json !== "string")`
    let id_truthy = body.get("id").is_some_and(jsstr::js_truthy);
    let json_str = body.get("json").and_then(Value::as_str);
    if !id_truthy || json_str.is_none() {
        return err(StatusCode::BAD_REQUEST, "id and json required");
    }
    // Truthy non-string id: TS passes both gates and then `id.replace`
    // TypeErrors inside getConversationOnDisk → uncaught 500.
    let id = match body.get("id").unwrap() {
        Value::String(s) => s.clone(),
        _ => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "id must be a string (TS: id.replace TypeError)",
            )
        }
    };
    let incoming = json_str.unwrap();
    let stored = state.conversations.get(&id);
    let merged = merge_protected_title(stored.as_deref(), incoming);
    match state.conversations.save(&id, &merged) {
        Ok(()) => json_response(StatusCode::OK, json!({ "ok": true })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// `/api/ruke/conversations/{id}` GET — verbatim stored text.
pub async fn conversation_doc_get(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.conversations.get(&id) {
        Some(raw) if !raw.is_empty() => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            raw,
        )
            .into_response(),
        // TS `if (!raw) return …404` — empty file reads "" ⇒ same 404.
        _ => err(StatusCode::NOT_FOUND, "not found"),
    }
}

/// `/api/ruke/conversations/{id}` PUT — raw text, NO parse/merge (the TS
/// client is the only writer that bypasses mergeProtectedTitle).
pub async fn conversation_doc_put(
    State(state): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(b) => b,
        // req.text() rejection would be an uncaught TS throw → generic 500.
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "invalid request body"),
    };
    // TextDecoder(replacement) ⇔ from_utf8_lossy.
    let text = String::from_utf8_lossy(&bytes).into_owned();
    match state.conversations.save(&id, &text) {
        Ok(()) => json_response(StatusCode::OK, json!({ "ok": true })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// DELETE GC: strip att_* references from the doc before tombstoning it —
/// the ONLY place attachment indexes get collected (TS parity).
static ATT_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"att_[a-z0-9]{4,32}").expect("att regex"));

/// `/api/ruke/conversations/{id}` DELETE.
pub async fn conversation_doc_delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if let Some(raw) = state.conversations.get(&id).filter(|r| !r.is_empty()) {
        // `new Set(raw.match(/att_[a-z0-9]{4,32}/g) ?? [])` — greedy match,
        // first-seen dedup.
        let mut seen: HashSet<&str> = HashSet::new();
        for m in ATT_REF_RE.find_iter(&raw) {
            if seen.insert(m.as_str()) {
                ruke_attach::remove_index(&state.root, m.as_str());
            }
        }
    }
    state.conversations.delete(&id);
    json_response(StatusCode::OK, json!({ "ok": true }))
}

/// `/api/ruke/conversations/{id}/title` POST.
pub async fn conversation_title_post(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    req: Request,
) -> Response {
    // `req.nextUrl.searchParams.get("force") === "1"` — strict.
    let force = q.get("force").map(String::as_str) == Some("1");
    // `const body = await req.json().catch(() => null)` inside `try {}
    // catch {}` — ANY body failure just means "no model override".
    let body: Option<Value> = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let model = body
        .as_ref()
        .and_then(|b| b.get("model"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from);

    match state.titles.request(&id, model, force) {
        RequestOutcome::Skipped(reason) => {
            json_response(StatusCode::OK, json!({ "queued": false, "reason": reason }))
        }
        RequestOutcome::Coalesced => {
            json_response(StatusCode::OK, json!({ "queued": true, "coalesced": true }))
        }
        RequestOutcome::Queued(rx) => match rx.await {
            Ok(Ok(job)) => {
                // `{ queued: true, ...done }` — spread keeps queued first.
                let mut m = Map::new();
                m.insert("queued".into(), Value::Bool(true));
                if let Value::Object(entries) = job.to_json() {
                    for (k, v) in entries {
                        m.insert(k, v);
                    }
                }
                json_response(StatusCode::OK, Value::Object(m))
            }
            // Job error (a TS rejected promise awaited unwrapped) → TS
            // uncaught → generic 500. Rust: 500 {error} envelope (recorded).
            Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
            // Closed channel can only mean a panicked worker task — TS has
            // no equivalent; the `?? Promise.resolve({ok:false,
            // reason:"no-job"})` fallback shape is the closest faithful arm.
            Err(_) => json_response(
                StatusCode::OK,
                json!({ "queued": true, "ok": false, "reason": "no-job" }),
            ),
        },
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
    use std::future;
    use std::path::Path;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use futures_util::future::BoxFuture;
    use ruke_attach::UnavailableEmbedder;
    use ruke_core::{settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};
    use tokio_util::sync::CancellationToken;
    use tower::ServiceExt; // oneshot

    use crate::persistence::ConversationStore;
    use crate::titles::generate::TitleCallModel;
    use crate::titles::queue::TitleQueue;

    /// Deterministic title model: always succeeds with a fixed title.
    struct FixedTitle(&'static str);
    impl TitleCallModel for FixedTitle {
        fn call(
            &self,
            _system: String,
            _user: String,
            _model: String,
            _max_tokens: u32,
            _token: CancellationToken,
        ) -> BoxFuture<'static, Option<String>> {
            Box::pin(future::ready(Some(self.0.to_string())))
        }
    }

    fn seeded_state(seed: impl FnOnce(&Path)) -> (crate::AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path());
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
            titles: Arc::new(TitleQueue::new(store, slot, Arc::new(FixedTitle("Generated Title")))),
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
            .body(body)
            .unwrap();
        let resp = crate::build_router(state.clone()).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 256_000).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    async fn call_raw(
        state: &crate::AppState,
        method: &str,
        uri: &str,
        body: Body,
    ) -> (StatusCode, Option<String>, Vec<u8>) {
        let req = HttpRequest::builder().method(method).uri(uri).body(body).unwrap();
        let resp = crate::build_router(state.clone()).oneshot(req).await.unwrap();
        let status = resp.status();
        let ctype = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_string());
        let bytes = axum::body::to_bytes(resp.into_body(), 256_000).await.unwrap();
        (status, ctype, bytes.to_vec())
    }

    #[tokio::test]
    async fn lifecycle_post_list_get_put_delete() {
        let (s, tmp) = seeded_state(|_| {});
        let doc = r#"{"id":"c1","meta":{"title":"Hello world","titleSource":"auto"},"messages":[{"role":"user","content":"hello world"}]}"#;

        let (status, body) = call(
            &s,
            "POST",
            "/api/ruke/conversations",
            Body::from(format!("{{\"id\":\"c1\",\"json\":{}}}", serde_json::to_string(doc).unwrap())),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "ok": true }));

        // A meta-less doc never appears in the list (TS `if (!meta) null`).
        let doc2 = r#"{"id":"c2","messages":[]}"#;
        call(
            &s,
            "POST",
            "/api/ruke/conversations",
            Body::from(format!("{{\"id\":\"c2\",\"json\":{}}}", serde_json::to_string(doc2).unwrap())),
        )
        .await;

        let (_status, list) = call(&s, "GET", "/api/ruke/conversations", Body::empty()).await;
        let arr = list.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["id"], json!("c1"));
        assert!(arr[0]["updatedAt"].is_number());
        assert_eq!(arr[0]["meta"]["title"], json!("Hello world"));

        // GET returns the stored text VERBATIM with application/json.
        let (status, ctype, bytes) =
            call_raw(&s, "GET", "/api/ruke/conversations/c1", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ctype.as_deref(), Some("application/json"));
        assert_eq!(String::from_utf8(bytes).unwrap(), doc);

        // PUT stores RAW TEXT without parsing or merging.
        let (status, _) = call(
            &s,
            "PUT",
            "/api/ruke/conversations/c1",
            Body::from("plain not-even-json"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_status, _, bytes) = call_raw(&s, "GET", "/api/ruke/conversations/c1", Body::empty()).await;
        assert_eq!(String::from_utf8(bytes).unwrap(), "plain not-even-json");
        // …and the list now DROPS it (JSON.parse failure swallowed).
        let (_status, list) = call(&s, "GET", "/api/ruke/conversations", Body::empty()).await;
        assert_eq!(list.as_array().unwrap().len(), 0);

        // DELETE → 404 after, tombstone silences a same-window re-PUT.
        let (status, body) = call(&s, "DELETE", "/api/ruke/conversations/c1", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "ok": true }));
        let (status, _) = call(&s, "GET", "/api/ruke/conversations/c1", Body::empty()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        call(&s, "PUT", "/api/ruke/conversations/c1", Body::from("resurrect?")).await;
        let (status, _) = call(&s, "GET", "/api/ruke/conversations/c1", Body::empty()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "recently-deleted tombstone must swallow the save");
        assert!(!tmp.path().join("conversations").join("c1.json").exists());
    }

    #[tokio::test]
    async fn delete_gcs_referenced_attachment_indexes() {
        let (s, tmp) = seeded_state(|root| {
            // Only one of the two referenced indexes actually exists — the
            // GC loop must tolerate the missing one silently (TS parity).
            let dir = root.join(".data").join("attach-index").join("att_ab12");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("meta.json"), "{}").unwrap();
        });
        let doc = r#"{"id":"gc1","meta":{},"messages":[{"role":"user","content":"see att_ab12 and att_cd34x"}]}"#;
        call(
            &s,
            "POST",
            "/api/ruke/conversations",
            Body::from(format!("{{\"id\":\"gc1\",\"json\":{}}}", serde_json::to_string(doc).unwrap())),
        )
        .await;
        assert!(tmp.path().join(".data/attach-index/att_ab12").exists());

        let (status, _) = call(&s, "DELETE", "/api/ruke/conversations/gc1", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!tmp.path().join(".data/attach-index/att_ab12").exists());
    }

    #[tokio::test]
    async fn post_gates_required_fields_and_nonstring_ids() {
        let (s, _t) = seeded_state(|_| {});
        for body_text in ["{}", r#"{"id":""}"#, r#"{"id":"x"}"#, r#"{"id":"x","json":5}"#, r#"{"json":"{}"}"#] {
            let (status, body) = call(&s, "POST", "/api/ruke/conversations", Body::from(body_text)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body_text} ⇒ {body}");
            assert_eq!(body["error"], json!("id and json required"));
        }
        // Truthy non-string id passes the gates then TypeErrors inside the
        // TS store (recorded: Rust says 500 with an {error} envelope).
        let (status, _) =
            call(&s, "POST", "/api/ruke/conversations", Body::from(r#"{"id":42,"json":"{}"}"#)).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        // Invalid JSON ⇒ recorded deviation of TS's uncaught-throw 500.
        let (status, _) = call(&s, "POST", "/api/ruke/conversations", Body::from("{oops")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        // Null body ⇒ TS `body.id` TypeError ⇒ 500-class as well (the
        // truthy gate in TS threw before it could even reach the 400).
        let (status, _) = call(&s, "POST", "/api/ruke/conversations", Body::from("null")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn post_merges_protected_title_exactly_like_persistence_fn() {
        let (s, _t) = seeded_state(|_| {});
        let stored = r#"{"id":"c5","meta":{"title":"Auto: keep me","titleSource":"auto"},"messages":[]}"#;
        call(
            &s,
            "POST",
            "/api/ruke/conversations",
            Body::from(format!("{{\"id\":\"c5\",\"json\":{}}}", serde_json::to_string(stored).unwrap())),
        )
        .await;
        let incoming = r#"{"id":"c5","meta":{},"messages":[{"role":"user","content":"new turn"}]}"#;
        call(
            &s,
            "POST",
            "/api/ruke/conversations",
            Body::from(format!("{{\"id\":\"c5\",\"json\":{}}}", serde_json::to_string(incoming).unwrap())),
        )
        .await;
        let (_status, _, bytes) = call_raw(&s, "GET", "/api/ruke/conversations/c5", Body::empty()).await;
        let saved = String::from_utf8(bytes).unwrap();
        assert_eq!(saved, merge_protected_title(Some(stored), incoming));
    }

    #[tokio::test]
    async fn title_route_skip_reasons() {
        let (s, _t) = seeded_state(|_| {});

        // Missing conversation.
        let (_status, body) =
            call(&s, "POST", "/api/ruke/conversations/nope/title?force=1", Body::empty()).await;
        assert_eq!(body, json!({ "queued": false, "reason": "not-found" }));

        let put_doc = |state: &crate::AppState, id: &str, doc: &str| {
            let state = state.clone();
            let id = id.to_string(); // owned: the async block must not borrow
            let doc = doc.to_string();
            async move {
                call(&state, "PUT", &format!("/api/ruke/conversations/{id}"), Body::from(doc)).await;
            }
        };

        // titleSource:"manual" short-circuits ahead of the force gate.
        put_doc(
            &s,
            "m1",
            r#"{"id":"m1","meta":{"title":"Locked","titleSource":"manual"},"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}"#,
        )
        .await;
        let (_status, body) = call(&s, "POST", "/api/ruke/conversations/m1/title", Body::empty()).await;
        assert_eq!(body, json!({ "queued": false, "reason": "manual" }));

        // A human-titled conversation: force ⇒ not-auto-title…
        put_doc(
            &s,
            "m2",
            r#"{"id":"m2","meta":{"title":"My Hand Title","titleSource":"user"},"messages":[{"role":"user","content":"hello there"},{"role":"assistant","content":"hi"},{"role":"user","content":"more"},{"role":"assistant","content":"yo"}]}"#,
        )
        .await;
        let (_status, body) =
            call(&s, "POST", "/api/ruke/conversations/m2/title?force=1", Body::empty()).await;
        assert_eq!(body, json!({ "queued": false, "reason": "not-auto-title" }));
        // …and non-force: titleGenCount was never set ⇒ the TS first-time
        // rule (messageCount >= 2) makes shouldGenerate TRUE — the guard
        // only refuses titleSource === "manual", so a "user"-authored
        // title IS overwritten by the auto job (TS quirk, pinned here).
        let (_status, body) = call(&s, "POST", "/api/ruke/conversations/m2/title", Body::empty()).await;
        assert_eq!(body, json!({ "queued": true, "ok": true, "title": "Generated Title" }));
    }

    #[tokio::test]
    async fn title_route_success_writes_title_and_tolerates_bad_body() {
        let (s, _t) = seeded_state(|_| {});
        call(
            &s,
            "PUT",
            "/api/ruke/conversations/t1",
            Body::from(
                r#"{"id":"t1","meta":{"titleSource":"auto"},"messages":[{"role":"user","content":"hello there"},{"role":"assistant","content":"hi"}]}"#,
            ),
        )
        .await;

        let (status, body) =
            call(&s, "POST", "/api/ruke/conversations/t1/title?force=1", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({ "queued": true, "ok": true, "title": "Generated Title" })
        );

        // The saved doc now carries the generated auto title.
        let (_status, _, bytes) = call_raw(&s, "GET", "/api/ruke/conversations/t1", Body::empty()).await;
        let saved: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(saved["meta"]["title"], json!("Generated Title"));
        assert_eq!(saved["meta"]["titleSource"], json!("auto"));

        // A garbage body never breaks the route (TS catch → no override);
        // the doc is still auto-titled ⇒ queued again, still ok.
        let (status, body) =
            call(&s, "POST", "/api/ruke/conversations/t1/title?force=1", Body::from("{oops")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["queued"], json!(true));
        assert_eq!(body["ok"], json!(true));
    }
}
