//! ipc.rs — the neutral home of the internal-bridge trust constants
//! (2026-11-03 TS-ownership rollback). These used to live in
//! `ruke-websearch::browser_bridge` — a web-search module — even though
//! they serve every Rust⇄Next loopback leg (web research bridge,
//! attachment embedder, browser-routes auth, and their tests). They now
//! belong to the server itself: the crate they configure is gone; the
//! secret handshake is not.
//!
//! Rule 17: log the boolean wiring outcome, never the secret value.

/// Supervisor-exported base URL of the Next process (loopback).
pub const ENV_BASE_URL: &str = "RUKE_BROWSER_BRIDGE_BASE_URL";
/// Supervisor-generated per-run shared secret (process env, never logged).
pub const ENV_SECRET: &str = "RUKE_BROWSER_BRIDGE_SECRET";
/// Header carrying the secret on every internal RPC leg. NEVER
/// browser-visible (loopback-only in practice).
pub const SECRET_HEADER: &str = "x-ruke-internal-secret";
