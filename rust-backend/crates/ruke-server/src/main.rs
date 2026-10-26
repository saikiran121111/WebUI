//! ruke-server — Part 1 foundation binary.
//!
//! Deliberately a *scaffold*: it boots the shared state (project root,
//! settings store, inference slot, turn counter), initializes tracing, and
//! serves a single health endpoint on loopback. NO existing TS route is
//! proxied, cut over, or re-implemented yet (MIGRATION-MAP.md §10 Part 1
//! scope; Rule 18: deletion/cutover come last). It listens on its own
//! port (default 3101) so it can coexist with the authoritative Next
//! server on :3000 during the whole migration.
//!
//! Rule 17 observability: all logs go through `tracing` with explicit
//! fields. Never log: API keys / Authorization headers, settings.json
//! contents, attachment contents, or (future) internal bridge secrets.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use ruke_core::{config, settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<SettingsStore>,
    pub slot: Arc<InferenceSlot>,
    pub turns: Arc<TurnCounter>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/ruke/health", get(health))
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

fn init_tracing() {
    let filter = match std::env::var("RUKE_LOG") {
        Ok(v) => tracing_subscriber::EnvFilter::new(v),
        Err(_) => tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
    };
    tracing_subscriber::fmt().with_env_filter(filter).with_target(true).init();
}

#[tokio::main]
async fn main() {
    init_tracing();

    let root = config::project_root();
    let settings = Arc::new(SettingsStore::new(config::settings_path(&root)));
    let port = config::backend_port();

    let state = AppState {
        settings,
        slot: Arc::new(InferenceSlot::new()),
        turns: Arc::new(TurnCounter::new()),
    };

    // Loopback bind: this scaffold has no auth, and the migration's
    // privileged RPC (Rule 9) must be loopback-only anyway. The cutover
    // (Part 8) decides the final bind address explicitly.
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind ruke-server (is RUKE_BACKEND_PORT free?)");

    tracing::info!(
        %addr,
        root = %root.display(),
        "ruke-server scaffold listening — no TS routes cut over; Next :3000 remains authoritative"
    );

    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received; draining");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http;
    use tower::ServiceExt; // oneshot

    fn state() -> AppState {
        let tmp = tempfile::tempdir().unwrap();
        AppState {
            settings: Arc::new(SettingsStore::new(tmp.path().join("settings.json"))),
            slot: Arc::new(InferenceSlot::new()),
            turns: Arc::new(TurnCounter::new()),
        }
    }

    #[tokio::test]
    async fn health_endpoint_ok_and_reports_idle_slot() {
        let resp = build_router(state())
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
    async fn no_existing_next_routes_are_served_yet_part1_guarantee() {
        let router = build_router(state());
        for path in ["/api/chat", "/api/settings", "/api/search", "/api/conversations"] {
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
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{path} must not exist in Part 1");
        }
    }
}
