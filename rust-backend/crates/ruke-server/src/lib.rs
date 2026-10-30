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
//! - Part 8 (cutover support): the chat web-research seam is LIVE — the
//!   pipeline now runs the full `ruke-websearch` gate/retrieval flow and
//!   wires the `web:<stage>` frames, the `web_meta` frame, and the
//!   citation/gate header pair exactly like `app/api/chat/route.ts`. The
//!   search pair and the decision route join the namespace (`GET
//!   /api/ruke/search`, `POST /api/ruke/search-more`, `POST
//!   /api/ruke/decision`); the production cutover is env-gated inside the
//!   Next routes (`scripts/dev-supervisor.mjs` exports
//!   `RUKE_RUST_BACKEND=1`; unset ⇒ the TS handler runs verbatim), so the
//!   plain paths still stay Next-owned ON THIS SERVER and the guard test
//!   below keeps pinning that.
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
pub mod browser_routes;
pub mod chat;
pub mod conversations_routes;
pub mod decision_routes;
pub mod model_stats;
pub mod persistence;
pub mod search_routes;
pub mod settings_routes;
pub mod skills_install;
pub mod skills_routes;
pub mod titles;

/// Part 8: the web-research runtime (`ruke-websearch`), shared by the
/// chat seam and the search pair. Mirrors the TS module singletons: the
/// real `Net`, the SQLite search cache, the platform verticals, and the
/// Tier-3b browser-read bridge (`NoBrowserBridge` when the supervisor
/// did not wire a Next-hosted hop — page reads then degrade exactly like
/// the TS path with no Playwright pool).
pub struct WebRuntime {
    pub net: ruke_websearch::net::RealNet,
    pub cache: Arc<ruke_websearch::cache::SqliteSearchCache>,
    pub verticals: ruke_websearch::platform_api::RealVerticals,
    pub bridge: Arc<dyn ruke_websearch::browser_bridge::BrowserBridge>,
}

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
    /// Part 8: the web-research runtime (chat seam + search pair).
    pub web: Arc<WebRuntime>,
    /// Browser Use (Phase 2): the long-lived browser runtime — one shared
    /// Chromium launched lazily on the first browser command. Tests only
    /// construct it (lazy = nothing launches; short-circuit routes never
    /// touch it).
    pub browser: Arc<ruke_browser::engine::BrowserRuntime>,
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
        // Part 8: the search pair + decision route under the same
        // Rust-only namespace. Next proxies its plain paths here ONLY
        // when the supervisor exports RUKE_RUST_BACKEND=1; the plain
        // paths stay Next-owned on this server (guard test below).
        .route("/api/ruke/search", get(search_routes::search_get))
        .route("/api/ruke/search-more", post(search_routes::search_more_post))
        .route("/api/ruke/decision", post(decision_routes::decision_post))
        // Browser Use (Phase 2): the command RPC for the browser panel /
        // tool loop. Errors ride the wire contract with HTTP 200; only
        // auth failures use a status code (browser_routes.rs).
        .route("/api/ruke/browser/command", post(browser_routes::command_post))
        // Browser Panel socket (Phase 3): ticket mint is bridge-authed;
        // the WS itself admits on Origin + one-shot ticket (ticket
        // because a WS handshake cannot carry the bridge-secret header).
        .route(
            "/api/ruke/browser/ws-ticket",
            post(browser_routes::ws_ticket_post),
        )
        .route("/api/ruke/browser/ws", get(browser_routes::ui_ws_get))
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
        // The Part-8 web seam must never reach the internet or Strata
        // from unit tests: the golden corpus was recorded with the gate
        // disabled, so short-circuit it exactly like the corpus does.
        // Every caller of state() wants the same value; edition-2021
        // set_var across this binary's test threads is benign here.
        std::env::set_var("WEB_SEARCH_GATE_DISABLED", "1");
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
            web: Arc::new(WebRuntime {
                net: ruke_websearch::net::RealNet,
                cache: Arc::new(ruke_websearch::cache::SqliteSearchCache::new(tmp.path())),
                verticals: ruke_websearch::platform_api::RealVerticals,
                bridge: Arc::new(ruke_websearch::browser_bridge::NoBrowserBridge),
            }),
            // Lazy by construction: no Chromium launches unless a real
            // browser command reaches the engine (rooted in the temp dir,
            // never the repo).
            browser: Arc::new(ruke_browser::engine::BrowserRuntime::new(
                tmp.path().to_path_buf(),
            )),
        };
        (state, tmp)
    }

    // Browser Use (Phase 2): the two contract short-circuits answer on the
    // wire BEFORE the engine is touched — no browser is ever launched for
    // a malformed or unknown command. (Auth is off here: the secret env
    // is forced empty so the loopback-only stance matches the tests'
    // other routes.)
    #[tokio::test]
    async fn browser_command_bad_envelope_answers_on_the_wire() {
        std::env::set_var(ruke_websearch::browser_bridge::ENV_SECRET, "");
        let (s, _t) = state();
        let resp = build_router(s)
            .oneshot(
                http::Request::builder()
                    .method("POST")
                    .uri("/api/ruke/browser/command")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(r#"{"commandType": ""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error_code"], "browser_command_envelope_invalid");
    }

    #[tokio::test]
    async fn browser_command_unknown_kind_short_circuits_before_the_engine() {
        std::env::set_var(ruke_websearch::browser_bridge::ENV_SECRET, "");
        let (s, _t) = state();
        let resp = build_router(s)
            .oneshot(
                http::Request::builder()
                    .method("POST")
                    .uri("/api/ruke/browser/command")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"commandType":"totally_not_a_command","session_id":"s","turn_id":"t"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error_code"], "browser_command_unknown");
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

    /// Part 8: the decision ROUTE wrapper. The envelope bytes themselves
    /// are already pinned by the Part-7 decision fixtures; this guards
    /// the route-level 400 bodies, the `application/json` content type,
    /// and that the 200 envelope keeps TS's snake_case wire keys
    /// (`DecisionEnvelope` has no `rename_all`).
    #[tokio::test]
    async fn decision_route_parity_bodies() {
        let (s, _t) = state();
        let router = build_router(s);

        let resp = router
            .clone()
            .oneshot(
                http::Request::builder()
                    .method(http::Method::POST)
                    .uri("/api/ruke/decision")
                    .body(axum::body::Body::from("{ not json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(resp.headers()[http::header::CONTENT_TYPE], "application/json");
        let bytes = axum::body::to_bytes(resp.into_body(), 64_000).await.unwrap();
        assert_eq!(&bytes[..], br#"{"error":"invalid JSON body"}"#);

        let resp = router
            .clone()
            .oneshot(
                http::Request::builder()
                    .method(http::Method::POST)
                    .uri("/api/ruke/decision")
                    .body(axum::body::Body::from(r#"{"message":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(resp.into_body(), 64_000).await.unwrap();
        assert_eq!(&bytes[..], br#"{"error":"message required"}"#);

        // 200 path: the in-process deterministic router answers without
        // any IO (no Strata contact).
        let resp = router
            .clone()
            .oneshot(
                http::Request::builder()
                    .method(http::Method::POST)
                    .uri("/api/ruke/decision")
                    .body(axum::body::Body::from(r#"{"message":"make me a chart of sales"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()[http::header::CONTENT_TYPE], "application/json");
        let bytes = axum::body::to_bytes(resp.into_body(), 64_000).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        for key in ["active_mode", "decided_by", "stripped_prompt", "confidence", "skill_to_load"] {
            assert!(v.get(key).is_some(), "envelope must carry snake_case key {key}");
        }
        assert_eq!(v["stripped_prompt"], json!("make me a chart of sales"));
    }

    /// Part 8: the search pair's short-circuit contracts — paths that
    /// answer before any network IO (no-q, malformed, empty queries).
    #[tokio::test]
    async fn search_routes_short_circuit_contracts() {
        let (s, _t) = state();
        let router = build_router(s);

        // TS `if (!query) return { results: [] }` — an empty `?q=` is
        // falsy in JS, so both URIs take the same early return.
        for uri in ["/api/ruke/search", "/api/ruke/search?q="] {
            let resp = router
                .clone()
                .oneshot(
                    http::Request::builder().uri(uri).body(axum::body::Body::empty()).unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK, "{uri}");
            let bytes = axum::body::to_bytes(resp.into_body(), 64_000).await.unwrap();
            assert_eq!(&bytes[..], br#"{"results":[]}"#, "{uri}");
        }

        let cases: [(&str, &[u8]); 2] = [
            ("{oops", br#"{"error":"Malformed JSON body"}"#.as_slice()),
            (
                r#"{"queries":[]}"#,
                br#"{"error":"queries array is required (1-3 string entries)"}"#.as_slice(),
            ),
        ];
        for (body, want) in cases {
            let resp = router
                .clone()
                .oneshot(
                    http::Request::builder()
                        .method(http::Method::POST)
                        .uri("/api/ruke/search-more")
                        .body(axum::body::Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{body}");
            let bytes = axum::body::to_bytes(resp.into_body(), 64_000).await.unwrap();
            assert_eq!(&bytes[..], want, "{body}");
        }
    }
}
