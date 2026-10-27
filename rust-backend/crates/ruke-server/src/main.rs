//! ruke-server binary entrypoint: boots the shared state and serves the
//! library router (`ruke_server::build_router`). Part 4/7 scope — health,
//! the isolated `/api/chat` core, and the Part-7 state services
//! (conversations store + title queue + settings); Next.js :3000 remains
//! authoritative for every user-facing route (see lib.rs docs).

use std::path::PathBuf;
use std::sync::Arc;

use ruke_core::{config, settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};
use ruke_server::{
    build_router, init_tracing, persistence::ConversationStore,
    titles::{generate::HttpTitleModel, queue::TitleQueue},
    AppState,
};

#[tokio::main]
async fn main() {
    init_tracing();

    let root = config::project_root();
    let settings = Arc::new(SettingsStore::new(config::settings_path(&root)));
    let port = config::backend_port();
    let slot = Arc::new(InferenceSlot::new());
    let http = reqwest::Client::new();

    // Conversations dir mirrors the TS persistence chain
    // `process.env.WEBUI_DATA_DIR ?? join(homedir(), ".local-intelligence",
    // "conversations")` — an EMPTY WEBUI_DATA_DIR is honored (TS `??` keeps
    // ""). RECORDED divergence: TS `HOME!` crashes at import when HOME is
    // unset; Rust falls back to USERPROFILE, then the project root (with a
    // warn) so a missing env never takes the whole backend down.
    let conversations_dir = match std::env::var_os("WEBUI_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            Some(home) => PathBuf::from(home)
                .join(".local-intelligence")
                .join("conversations"),
            None => {
                let fallback = root.join(".local-intelligence").join("conversations");
                tracing::warn!(
                    dir = %fallback.display(),
                    "HOME/USERPROFILE unset: conversations dir falls back to the project root"
                );
                fallback
            }
        },
    };
    let conversations = Arc::new(ConversationStore::new(conversations_dir));

    let state = AppState {
        settings: settings.clone(),
        slot: slot.clone(),
        turns: Arc::new(TurnCounter::new()),
        root: root.clone(),
        // No client timeouts: a slow local model is normal operation, and
        // the TS baseline `fetch` has none either (MIGRATION-MAP §2).
        http: http.clone(),
        // Part 5 production seam: no embedding model runs on the Rust
        // side (ONNX stays a Node concern; Part 8 decides otherwise).
        // Retrieval then degrades exactly like the TS `embedOne` catch —
        // empty vector, BM25-alone ranking.
        attach_embedder: Arc::new(ruke_attach::UnavailableEmbedder),
        conversations: conversations.clone(),
        // TS title scheduler fires on the same settings store + upstream
        // client the chat route uses; the queue serializes jobs globally.
        titles: Arc::new(TitleQueue::new(
            conversations,
            slot.clone(),
            Arc::new(HttpTitleModel { http: http.clone(), settings }),
        )),
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
