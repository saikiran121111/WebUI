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

/// Test-only serialization of the ONE process-global bridge-secret env var.
/// Cargo runs this binary's tests on parallel threads and `set_var` mutates
/// process state, so an unguarded writer used to flip an unrelated bridge
/// test's gate mid-request (the "returns 401 and calls that a pass" defect
/// in `internal_completion`'s tests). Every test that READS the gate while
/// issuing a bridge request, and every test that WRITES the var, holds this
/// lock for the whole request.
#[cfg(test)]
pub(crate) mod test_guard {
    use tokio::sync::{Mutex, MutexGuard};
    use super::ENV_SECRET;

    static SECRET_ENV: Mutex<()> = Mutex::const_new(());

    /// Pins the secret for the duration of one test's bridge traffic.
    /// `value == ""` means dev mode (loopback bind is the guard).
    pub(crate) async fn pin_bridge_secret(
        value: &str,
    ) -> MutexGuard<'static, ()> {
        let guard = SECRET_ENV.lock().await;
        std::env::set_var(ENV_SECRET, value);
        guard
    }
}
