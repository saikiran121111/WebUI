//! ruke-server binary entrypoint: boots the shared state and serves the
//! library router (`ruke_server::build_router`). Part 4/7/8 scope —
//! health, the `/api/chat` core WITH the live Part-8 web seam, the
//! Part-7 state services (conversations store + title queue + settings)
//! and the Part-8 search/decision pair. Next.js :3000 stays
//! authoritative for user-facing routes; the Part-8 cutover flips only
//! which backend a Next route delegates to, and only when the supervisor
//! exports `RUKE_RUST_BACKEND=1` (see lib.rs docs).

use std::path::PathBuf;
use std::sync::Arc;

use ruke_core::{config, settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};
use ruke_server::{
    build_router, init_tracing, persistence::ConversationStore,
    titles::{generate::HttpTitleModel, queue::TitleQueue},
    AppState, WebRuntime,
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

    // Part 8: the web-research runtime, mirroring the TS module
    // singletons — the SQLite search cache lives under the project root
    // (same DB the TS pipeline uses; the purge sweep is idempotent and
    // started once here). The Tier-3b browser-read bridge is wired ONLY
    // when the supervisor exported both env vars; otherwise
    // NoBrowserBridge, and page reads degrade exactly like the TS path
    // with no Playwright pool. Rule 17: log the boolean outcome, never
    // the secret.
    let web_cache = Arc::new(ruke_websearch::cache::SqliteSearchCache::new(&root));
    ruke_websearch::cache::start_purge_sweep(web_cache.clone());
    let bridge: Arc<dyn ruke_websearch::browser_bridge::BrowserBridge> =
        match ruke_websearch::browser_bridge::HttpBrowserBridge::from_env() {
            Some(b) => {
                tracing::info!("Tier-3b browser-read bridge configured (Next-hosted RPC seam)");
                Arc::new(b)
            }
            None => {
                tracing::info!(
                    "Tier-3b browser-read bridge not configured: page reads degrade \
                     like the TS no-Playwright path"
                );
                Arc::new(ruke_websearch::browser_bridge::NoBrowserBridge)
            }
        };
    // The InnerTube seam (youtube.rs header): the Next-hosted evidence RPC
    // carries info/transcript/comments, where the transcript tier rides
    // the universal browser caption engine. Same env pair as the browser
    // bridge; unset ⇒ NoInnerTube (oEmbed-only, TS source-3 behavior).
    // Rule 17: log the boolean, never the secret.
    let innertube: Arc<dyn ruke_websearch::youtube::InnerTubeClient> =
        match ruke_websearch::youtube_bridge::HttpInnerTube::from_env() {
            Some(c) => {
                tracing::info!(
                    "InnerTube evidence bridge configured (Next-hosted RPC + caption capture)"
                );
                Arc::new(c)
            }
            None => {
                tracing::info!(
                    "InnerTube evidence bridge not configured: YouTube evidence stays \
                     oEmbed-only"
                );
                Arc::new(ruke_websearch::youtube::NoInnerTube)
            }
        };
    ruke_websearch::youtube::set_default_inner_tube(innertube);
    let web = Arc::new(WebRuntime {
        net: ruke_websearch::net::RealNet,
        cache: web_cache,
        verticals: ruke_websearch::platform_api::RealVerticals,
        bridge,
    });

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
        // Part 8: shared web runtime (chat seam + search pair).
        web,
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
