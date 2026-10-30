//! Direct Rust test route for lazy course notes — the port of
//! `app/api/attach/[id]/notes/route.ts`, mounted under the Rust-only
//! namespace `/api/ruke/attach/{id}/notes`. Part 5 scope (§18/§19): this
//! route exists ONLY on the isolated Rust server (:3101); Next.js does not
//! proxy or cut over to it — no production route migration before Part 8.
//!
//! The status/shape table mirrors the TS verbatim:
//!
//! | GET  | `readNotes` truthy → 200 `{notes}`; falsy (missing/corrupt/empty-string) → 404 `{"error":"No cached notes for this attachment"}` |
//! | POST | `!hasIndex` → 404 `{"error":"No knowledge index for this attachment"}`; `?force=1` skips the cache; truthy cached notes → 200 `{notes, cached:true}`; `!readIndex` → 500 `{"error":"Index unreadable"}`; abort → 499 `{"error":"Cancelled"}`; empty notes → 422 `{"error":"Nothing to summarize"}`; else 200 `{notes, cached:false}` |
//!
//! Parity notes:
//! - TS `if (!notes)` / `if (cached)` are FALSY tests: a cached `""`
//!   GET-404s and POST *regenerates* — the `Some("")` from the store keeps
//!   that split observable here, exactly like TS.
//! - The TS 502 "Notes generation failed" arm has no Rust counterpart:
//!   `generateNotes` only ever throws AbortError (every other failure
//!   degrades inside `noteForBlock`; `writeNotes` is try-wrapped), and the
//!   Rust error type is exactly that abort — [`Cancelled`].
//! - TS aborts generation via `req.signal` on browser disconnect. The Rust
//!   server's client-disconnect wiring for this route is Part 8 work; the
//!   499 branch is exercised by unit test with a pre-cancelled token.
//! - A bad attachment id is NOT an error path: `has_index`/`read_notes`/
//!   `read_index` all swallow the TS `indexDir` throw (store parity), so a
//!   malformed id GET-404s and POST-404s at "No knowledge index".

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use ruke_attach::{generate_notes, has_index, read_index, read_notes, Cancelled, NotesLlm};

use crate::AppState;

pub async fn notes_get(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match read_notes(&state.root, &id) {
        Some(notes) if !notes.is_empty() => {
            json_response(StatusCode::OK, json!({ "notes": notes }))
        }
        _ => err(StatusCode::NOT_FOUND, "No cached notes for this attachment"),
    }
}

pub async fn notes_post(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    // `searchParams.get("force") === "1"` — strict, NOT truthy.
    let force = q.get("force").map(String::as_str) == Some("1");
    // Per-request token; the browser-abort wiring lands in Part 8 (module
    // docs), so this token only fires if the handler itself is torn down.
    notes_post_inner(&state, &id, force, &CancellationToken::new()).await
}

/// The POST body, factored out so the abort (499) branch can be driven
/// with a pre-cancelled token — the TS route's only throwing path.
async fn notes_post_inner(
    state: &AppState,
    att_id: &str,
    force: bool,
    token: &CancellationToken,
) -> Response {
    if !has_index(&state.root, att_id) {
        return err(
            StatusCode::NOT_FOUND,
            "No knowledge index for this attachment",
        );
    }
    if !force {
        // `if (cached)` — truthy only: `Some("")` falls through to regen.
        if let Some(cached) = read_notes(&state.root, att_id) {
            if !cached.is_empty() {
                // Key order ⇔ `NextResponse.json({ notes: cached, cached: true })`.
                return json_response(StatusCode::OK, json!({ "notes": cached, "cached": true }));
            }
        }
    }

    let index = match read_index(&state.root, att_id) {
        Some(i) => i,
        None => return err(StatusCode::INTERNAL_SERVER_ERROR, "Index unreadable"),
    };

    // Same settings resolution as the chat forwarder (override > file >
    // env > fallback), read PER REQUEST — never captured, never logged
    // (Rule 17: only the att id travels to the log).
    let llm = NotesLlm {
        url: state.settings.llm_api_url(),
        key: state.settings.llm_api_key(),
    };
    match generate_notes(&state.root, att_id, &index, &state.http, &llm, token).await {
        Err(Cancelled) => {
            tracing::warn!(att_id, "notes generation aborted by client");
            err(StatusCode::from_u16(499).unwrap(), "Cancelled")
        }
        Ok(notes) if notes.is_empty() => {
            err(StatusCode::UNPROCESSABLE_ENTITY, "Nothing to summarize")
        }
        Ok(notes) => json_response(StatusCode::OK, json!({ "notes": notes, "cached": false })),
    }
}

/// `NextResponse.json` ⇔ status + `application/json` body.
fn json_response(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn err(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "error": message }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::Request;
    use ruke_attach::{write_notes, UnavailableEmbedder};
    use ruke_core::{settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};
    use tower::ServiceExt; // oneshot

    /// A state whose ROOT is a live temp dir seeded with an attachment
    /// store (the route reads through `state.root`).
    fn seeded_state(seed: impl FnOnce(&Path)) -> (AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path());
        let slot = Arc::new(InferenceSlot::new());
        let store = Arc::new(crate::persistence::ConversationStore::new(
            tmp.path().join("conversations"),
        ));
        let state = AppState {
            settings: Arc::new(SettingsStore::new(tmp.path().join("settings.json"))),
            slot: slot.clone(),
            turns: Arc::new(TurnCounter::new()),
            root: tmp.path().to_path_buf(),
            http: reqwest::Client::new(),
            attach_embedder: Arc::new(UnavailableEmbedder),
            conversations: store.clone(),
            titles: Arc::new(crate::titles::queue::TitleQueue::new(
                store,
                slot,
                Arc::new(crate::titles::generate::UnconfiguredTitleModel),
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

    fn seed_store(root: &Path, att: &str, meta_json: &str, jsonl: &str) {
        let dir = root.join(".data").join("attach-index").join(att);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("meta.json"), meta_json).unwrap();
        std::fs::write(dir.join("chunks.jsonl"), jsonl).unwrap();
    }

    const META1: &str = r#"{"attId":"att_notes1","name":"n","category":"text","createdAt":0,"chunkCount":0,"spine":"","spineBlocks":[],"frames":[]}"#;
    /// One spine block over chunk 0 ⇒ `generateNotes` reaches
    /// `noteForBlock` (the only place the abort can surface).
    const META_SPINE: &str = r#"{"attId":"att_notes2","name":"n","category":"text","createdAt":0,"chunkCount":1,"spine":"s","spineBlocks":[{"startSec":0.0,"endSec":60.0,"chunkFrom":0,"chunkTo":0,"keywords":[],"opening":"o","closing":"c"}],"frames":[]}"#;
    const CHUNK0: &str =
        "{\"i\":0,\"startSec\":null,\"endSec\":null,\"text\":\"body text\",\"vec\":[]}\n";

    async fn call(state: &AppState, method: &str, uri: &str) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let resp = crate::build_router(state.clone())
            .oneshot(req)
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 64_000)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn get_notes_table_missing_empty_and_cached() {
        let root_seed = |root: &Path| {
            // att_notes1: index present, no notes file at all.
            seed_store(root, "att_notes1", META1, "");
            // att_notes3: empty-string note (the falsy nuance).
            seed_store(
                root,
                "att_notes3",
                &META1.replace("att_notes1", "att_notes3"),
                "",
            );
            write_notes(root, "att_notes3", "").unwrap();
            // att_notes4: a real cached note.
            seed_store(
                root,
                "att_notes4",
                &META1.replace("att_notes1", "att_notes4"),
                "",
            );
            write_notes(root, "att_notes4", "cached body").unwrap();
        };
        let (state, _tmp) = seeded_state(root_seed);

        let (status, body) = call(&state, "GET", "/api/ruke/attach/att_notes1/notes").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            body,
            json!({ "error": "No cached notes for this attachment" })
        );

        let (status, body) = call(&state, "GET", "/api/ruke/attach/att_notes3/notes").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "empty note is FALSY in TS");
        assert_eq!(
            body,
            json!({ "error": "No cached notes for this attachment" })
        );

        let (status, body) = call(&state, "GET", "/api/ruke/attach/att_notes4/notes").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "notes": "cached body" }));

        // A malformed id (fails ATT_RE) reads like "no notes": the store
        // swallows the TS `indexDir` throw instead of erroring. (A path
        // with `..` segments would not even match the route — it dies at
        // routing, not at the store — so probe an ATT_RE failure here.)
        let (status, body) = call(&state, "GET", "/api/ruke/attach/xyz/notes").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            body,
            json!({ "error": "No cached notes for this attachment" })
        );
    }

    #[tokio::test]
    async fn post_no_index_bad_id_and_unreadable_index() {
        let (state, _tmp) = seeded_state(|root| {
            seed_store(root, "att_notesbad", "{ not json", "");
        });

        let (status, body) = call(&state, "POST", "/api/ruke/attach/att_missing1/notes").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            body,
            json!({ "error": "No knowledge index for this attachment" })
        );

        // Malformed id fails hasIndex too (store parity, not an error path).
        let (status, _) = call(&state, "POST", "/api/ruke/attach/x/notes").await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // meta present but unparseable ⇒ hasIndex true, readIndex null.
        let (status, body) = call(&state, "POST", "/api/ruke/attach/att_notesbad/notes").await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, json!({ "error": "Index unreadable" }));
    }

    #[tokio::test]
    async fn post_cached_truthy_and_force_regenerate_empty() {
        let (state, _tmp) = seeded_state(|root| {
            seed_store(root, "att_notes1", META1, "");
            write_notes(root, "att_notes1", "keep me").unwrap();
            seed_store(
                root,
                "att_notes3",
                &META1.replace("att_notes1", "att_notes3"),
                "",
            );
            write_notes(root, "att_notes3", "").unwrap();
        });
        // Pin the LLM target OFF the live server (golden seam): the
        // spineless index generates Ok("") WITHOUT ever fetching.
        state
            .settings
            .set_upstream_override("http://127.0.0.1:9/v1/chat/completions", "golden-key");

        let (status, body) = call(&state, "POST", "/api/ruke/attach/att_notes1/notes").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "notes": "keep me", "cached": true }));

        // Empty cached note falls through to regeneration: no spine
        // blocks ⇒ Ok("") ⇒ 422 (and TS behaves identically).
        let (status, body) = call(&state, "POST", "/api/ruke/attach/att_notes3/notes").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body, json!({ "error": "Nothing to summarize" }));

        // force=1 skips even a TRUTHY cache ⇒ same 422 (the cached note
        // is not returned and not consulted).
        let (status, body) =
            call(&state, "POST", "/api/ruke/attach/att_notes1/notes?force=1").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body, json!({ "error": "Nothing to summarize" }));

        // A non-"1" force value is NOT force (strict === "1").
        let (status, body) = call(
            &state,
            "POST",
            "/api/ruke/attach/att_notes1/notes?force=yes",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "notes": "keep me", "cached": true }));
    }

    #[tokio::test]
    async fn aborted_generation_is_the_only_499_path() {
        // Drive the inner directly: the router path always builds a fresh
        // (uncancelled) token; the TS route's abort needs the same
        // AbortError the pre-cancelled token models.
        let (state, _tmp) = seeded_state(|root| {
            seed_store(root, "att_notes2", META_SPINE, CHUNK0);
        });
        state
            .settings
            .set_upstream_override("http://127.0.0.1:9/v1/chat/completions", "golden-key");

        let token = CancellationToken::new();
        token.cancel();
        let resp = notes_post_inner(&state, "att_notes2", true, &token).await;
        assert_eq!(resp.status(), StatusCode::from_u16(499).unwrap());
        let bytes = axum::body::to_bytes(resp.into_body(), 64_000)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({ "error": "Cancelled" })
        );
    }
}
