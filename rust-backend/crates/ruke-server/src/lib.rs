//! ruke-server — the Part-4 backend binary beside the Part-1 scaffold.
//!
//! Deliberately a *parallel* server (MIGRATION-MAP.md §10 Part 1/Part 4;
//! Rule 18: deletion/cutover come last): it boots the shared state
//! (project root, settings store, inference slot, turn counter, upstream
//! HTTP client), initializes tracing, and serves
//!
//! - `GET  /api/ruke/health`  — the Part-1 liveness endpoint, and
//! - `POST /api/chat`         — the Rust chat core, added per §25/26 for
//!   ISOLATED parity testing against the golden corpus. It is NOT cut
//!   over: Next.js `app/api/chat/route.ts` remains authoritative, `npm
//!   run dev` is untouched, and no TS route is proxied to this server.
//!   It listens on its own port (default 3101) beside Next :3000.
//! - `GET/POST /api/ruke/attach/{id}/notes` — the Part-5 notes route as a
//!   DIRECT Rust test route (§18/§19): mounted ONLY here on :3101; Next's
//!   `app/api/attach/[id]/notes/route.ts` stays authoritative and does not
//!   proxy to it (no production route migration before Part 8).
//! - Part 7 server state — conversations, settings, model-stats and
//!   skills — mounted under the Rust-only `/api/ruke/*` namespace for the
//!   same reason: the plain paths stay Next-owned until the Part 8
//!   cutover, and the guard test below pins that.
//!
//! Rule 17 observability: all logs go through `tracing` with explicit
//! fields. Never log: API keys / Authorization headers, settings.json
//! contents, attachment contents, or (future) internal bridge secrets.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde_json::json;

use ruke_core::{settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};

pub mod attach_notes;
pub mod chat;
pub mod conversations_routes;
pub mod model_stats;
pub mod persistence;
pub mod settings_routes;
pub mod skills_install;
pub mod skills_routes;
pub mod titles;

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<SettingsStore>,
    pub slot: Arc<InferenceSlot>,
    pub turns: Arc<TurnCounter>,
    /// Project root: the anchor for `skills/`, `.cskills/` and scenario
    /// JSON paths used by skill routing and the decision skill block.
    pub root: PathBuf,
    /// Shared upstream client: NO timeouts (a slow local model is normal;
    /// TS `fetch` has none either), no accept-encoding (byte-verbatim SSE).
    pub http: reqwest::Client,
    /// Query-embedding seam for attachment retrieval
    /// (`ruke_attach::QueryEmbedder`). Production wires
    /// `UnavailableEmbedder` — no second embedding model runs on the Rust
    /// side — so retrieval degrades exactly like the TS `embedOne` catch:
    /// empty vector, BM25-alone ranking. Golden replay swaps in
    /// `FixedEmbedder` with the fixtures' recorded vector.
    pub attach_embedder: Arc<dyn ruke_attach::QueryEmbedder>,
    /// Part 7: the on-disk conversation store (`persistence`), rooted at
    /// the TS chain's conversations dir in production and a temp dir in
    /// tests.
    pub conversations: Arc<persistence::ConversationStore>,
    /// Part 7: the serialized title-generation scheduler
    /// (`titles::queue`), coalescing per-conversation jobs onto the
    /// shared inference slot.
    pub titles: Arc<titles::queue::TitleQueue>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/ruke/health", get(health))
        // Part 4 (§25/26): the Rust chat core, live for isolated testing
        // only — the Next route at :3000 remains the user-facing one.
        .route("/api/chat", post(chat::chat_post))
        // Part 5 (§18/§19): notes as a DIRECT Rust test route under the
        // Rust-only /api/ruke namespace. Next does not proxy to it —
        // cutover is Part 8.
        .route(
            "/api/ruke/attach/{id}/notes",
            get(attach_notes::notes_get).post(attach_notes::notes_post),
        )
        // Part 7: the five state services under the Rust-only namespace.
        .route(
            "/api/ruke/conversations",
            get(conversations_routes::conversations_list_get)
                .post(conversations_routes::conversation_create_post),
        )
        .route(
            "/api/ruke/conversations/{id}",
            get(conversations_routes::conversation_doc_get)
                .put(conversations_routes::conversation_doc_put)
                .delete(conversations_routes::conversation_doc_delete),
        )
        .route(
            "/api/ruke/conversations/{id}/title",
            post(conversations_routes::conversation_title_post),
        )
        .route(
            "/api/ruke/settings",
            get(settings_routes::settings_get)
                .put(settings_routes::settings_put)
                .delete(settings_routes::settings_delete),
        )
        .route("/api/ruke/model-stats", get(model_stats::model_stats_get))
        .route("/api/ruke/skills", get(skills_routes::skills_get))
        .route("/api/ruke/skills/install", post(skills_install::skills_install_post))
        .route("/api/ruke/skills/{skillName}", delete(skills_routes::skill_delete))
        .route(
            "/api/ruke/skills/{skillName}/scenario",
            patch(skills_routes::scenario_patch),
        )
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            // Liveness of the coordination primitives only — no settings
            // contents (may hold an API key), per Rule 17.
            "user_turn_active": state.slot.user_turn_active(),
        })),
    )
}

pub fn init_tracing() {
    let filter = match std::env::var("RUKE_LOG") {
        Ok(v) => tracing_subscriber::EnvFilter::new(v),
        Err(_) => tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
    };
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_target(true).try_init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http;
    use tower::ServiceExt; // oneshot

    fn state() -> (AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let slot = Arc::new(InferenceSlot::new());
        let conversations =
            Arc::new(persistence::ConversationStore::new(tmp.path().join("conversations")));
        let state = AppState {
            settings: Arc::new(SettingsStore::new(tmp.path().join("settings.json"))),
            slot: slot.clone(),
            turns: Arc::new(TurnCounter::new()),
            root: tmp.path().to_path_buf(),
            http: reqwest::Client::new(),
            attach_embedder: Arc::new(ruke_attach::UnavailableEmbedder),
            conversations: conversations.clone(),
            titles: Arc::new(titles::queue::TitleQueue::new(
                conversations,
                slot,
                Arc::new(titles::generate::UnconfiguredTitleModel),
            )),
        };
        (state, tmp)
    }

    #[tokio::test]
    async fn health_endpoint_ok_and_reports_idle_slot() {
        let (s, _t) = state();
        let resp = build_router(s)
            .oneshot(
                http::Request::builder()
                    .uri("/api/ruke/health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 64_000).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], json!(true));
        assert_eq!(v["user_turn_active"], json!(false));
        assert!(v.get("version").is_some());
        // Rule 17 sanity: the payload must never carry settings material.
        assert!(v.get("llm_api_key").is_none());
    }

    #[tokio::test]
    async fn other_next_routes_are_still_not_served() {
        // /api/chat is intentionally REMOVED from this list: §25/26 added
        // it as the isolated Rust core (the Next route stays authoritative).
        let (s, _t) = state();
        let router = build_router(s);
        for path in ["/api/settings", "/api/search", "/api/conversations"] {
            let resp = router
                .clone()
                .oneshot(
                    http::Request::builder()
                        .method(http::Method::POST)
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{path} must not exist before its Part");
        }
    }

    /// §26: `/api/chat` now EXISTS (no longer 404). With the upstream
    /// pinned to a dead port, the progress path must stream decision
    /// frames, then the frozen unreachable error frame + one [DONE] — all
    /// without ever touching the live Strata :8080.
    #[tokio::test]
    async fn chat_route_exists_and_streams_the_unreachable_contract() {
        let (s, _t) = state();
        s.settings.set_upstream_override("http://127.0.0.1:9/v1/chat/completions", "golden-key");
        let resp = build_router(s.clone())
            .oneshot(
                http::Request::builder()
                    .method(http::Method::POST)
                    .uri("/api/chat")
                    .header(http::header::CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(
                        r#"{"messages":[{"role":"user","content":"hello there"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "early-open progress response");
        assert_eq!(resp.headers()[http::header::CONTENT_TYPE], "text/event-stream");
        assert_eq!(resp.headers()["cache-control"], "no-cache, no-transform");
        assert_eq!(resp.headers()["x-accel-buffering"], "no");
        assert!(resp.headers().contains_key("x-decision-mode"));

        let bytes = axum::body::to_bytes(resp.into_body(), 256_000).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.starts_with("data: {\"ruke_stage\":{\"stage\":\"decision_done\""));
        assert!(text.contains(
            "data: {\"ruke_error\":{\"message\":\"Could not reach the model server at 127.0.0.1:9.\"}}"
        ));
        assert!(text.ends_with("data: [DONE]\n\n"));

        // Rule 6: the slot released exactly once.
        assert!(!s.slot.user_turn_active());
    }
}
