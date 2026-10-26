//! ruke-server binary entrypoint: boots the shared state and serves the
//! library router (`ruke_server::build_router`). Part 4 scope — health
//! scaffold + the isolated `/api/chat` core; Next.js :3000 remains
//! authoritative for every user-facing route (see lib.rs docs).

use std::sync::Arc;

use ruke_core::{config, settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};
use ruke_server::{build_router, init_tracing, AppState};

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
        root: root.clone(),
        // No client timeouts: a slow local model is normal operation, and
        // the TS baseline `fetch` has none either (MIGRATION-MAP §2).
        http: reqwest::Client::new(),
        // Part 5 production seam: no embedding model runs on the Rust
        // side (ONNX stays a Node concern; Part 8 decides otherwise).
        // Retrieval then degrades exactly like the TS `embedOne` catch —
        // empty vector, BM25-alone ranking.
        attach_embedder: Arc::new(ruke_attach::UnavailableEmbedder),
    };

    // Loopback bind: this parallel server has no auth, and the migration's
    // privileged RPC (Rule 9) must be loopback-only anyway. The cutover
    // (Part 8) decides the final bind address explicitly.
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind ruke-server (is RUKE_BACKEND_PORT free?)");

    tracing::info!(
        %addr,
        root = %root.display(),
        "ruke-server listening (health + isolated /api/chat) — Next :3000 remains authoritative"
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
