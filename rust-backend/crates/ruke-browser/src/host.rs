//! host.rs — the Chromium process host: Rust launches the Playwright-
//! installed Chromium as a SUBORDINATE external process and controls it
//! exclusively over CDP (plan §0). No Playwright library is linked; the
//! browser is a runtime binary already vendored under `.data/`
//! (gitignored) by the Playwright install step.
//!
//! Handshake: `--remote-debugging-port=0` makes Chromium pick an ephemeral
//! port and write `<profile>/DevToolsActivePort` (line 1 = port, line 2 =
//! browser WebSocket path). The stale file from a previous run is deleted
//! BEFORE launch so a dead port can never masquerade as a live handshake.
//!
//! Lifecycle: `kill_on_drop(true)` guarantees no zombie Chromium survives
//! a crash or an aborted host slot; [`LaunchedHost::shutdown`] is the
//! graceful path (`Browser.close`, then a bounded wait, then kill).
//!
//! Stdout/stderr are nulled rather than piped: Chromium is chatty and an
//! unread pipe deadlocks the child. Diagnostics flow through the DevTools
//! socket (dev-logs commands arrive with their phase), not the pipes.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use url::Url;

use crate::cdp::{self, CdpConn, CdpEvent};
use crate::errors::BrowserError;

/// Env overrides (documented, product-supported — not test hooks):
/// force a specific binary, or opt into a visible OS window.
pub const ENV_EXECUTABLE: &str = "RUKE_BROWSER_EXECUTABLE";
pub const ENV_HEADED: &str = "RUKE_BROWSER_HEADED";
/// Chromium's handshake file inside the user-data dir.
pub const DEVTOOLS_ACTIVE_PORT_FILE: &str = "DevToolsActivePort";
/// Persistent user profile: cookies/history/site data stay the user's
/// (plan §0 profile semantics).
pub const PROFILE_DIR_NAME: &str = "ruke-browser-profile";

/// A page target Chromium already had open at launch (the startup tab).
#[derive(Clone, Debug)]
pub struct InitialPageTarget {
    pub target_id: String,
    pub url: String,
    pub title: String,
}

pub struct HostConfig {
    pub executable: PathBuf,
    pub profile_dir: PathBuf,
    pub headless: bool,
}

impl HostConfig {
    /// Locate the bundled Chromium: `RUKE_BROWSER_EXECUTABLE` wins; else
    /// the highest-versioned `chromium-<n>` Playwright bundle under
    /// `<root>/.data/ms-playwright` (the bundle dir is versioned —
    /// `chromium-1243` today — so discovery must not hardcode the number).
    /// The Windows bundle nests under `chrome-win64/` (NOT `chrome-win/`;
    /// plan text corrected at Phase 2). Headless-shell bundles are never
    /// candidates: the agent browser needs a real, attachable browser.
    pub fn discover(root: &Path) -> Result<HostConfig, BrowserError> {
        let profile_dir = root.join(".data").join(PROFILE_DIR_NAME);

        if let Some(p) = std::env::var_os(ENV_EXECUTABLE) {
            let exe = PathBuf::from(p);
            if !exe.is_file() {
                tracing::error!(exe = %exe.display(), "{ENV_EXECUTABLE} points at a missing file");
                return Err(BrowserError::HostUnavailable);
            }
            return Ok(Self {
                executable: exe,
                profile_dir,
                headless: !headed(),
            });
        }

        let ms = root.join(".data").join("ms-playwright");
        let mut best: Option<(u32, PathBuf)> = None;
        if let Ok(entries) = std::fs::read_dir(&ms) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(digit_tail) = name.strip_prefix("chromium-") else {
                    continue;
                };
                let Ok(version) = digit_tail.parse::<u32>() else {
                    continue;
                };
                for sub in [
                    "chrome-win64/chrome.exe",
                    "chrome-win/chrome.exe",
                    "chrome-linux/chrome",
                    "chrome-linux64/chrome",
                ] {
                    let cand = entry.path().join(sub);
                    if cand.is_file() {
                        let better = match &best {
                            None => true,
                            Some((v, _)) => version > *v,
                        };
                        if better {
                            best = Some((version, cand));
                        }
                        break;
                    }
                }
            }
        }
        match best {
            Some((version, executable)) => {
                tracing::info!(exe = %executable.display(), version, "Chromium bundle discovered");
                Ok(Self {
                    executable,
                    profile_dir,
                    headless: !headed(),
                })
            }
            None => {
                tracing::error!(
                    dir = %ms.display(),
                    "no Playwright Chromium bundle found (run the Playwright browser install)"
                );
                Err(BrowserError::HostUnavailable)
            }
        }
    }
}

fn headed() -> bool {
    matches!(std::env::var(ENV_HEADED).as_deref(), Ok(v) if v == "1" || v.eq_ignore_ascii_case("true"))
}

pub struct LaunchedHost {
    pub conn: std::sync::Arc<CdpConn>,
    /// Taken by the engine to feed its lifecycle pump; `shutdown` ignores it.
    pub events: Option<tokio::sync::mpsc::UnboundedReceiver<CdpEvent>>,
    pub child: Child,
    pub writer: JoinHandle<()>,
    pub reader: JoinHandle<()>,
    pub initial_page_targets: Vec<InitialPageTarget>,
}

impl LaunchedHost {
    pub async fn launch(cfg: &HostConfig) -> Result<LaunchedHost, BrowserError> {
        if !cfg.executable.is_file() {
            tracing::error!(exe = %cfg.executable.display(), "Chromium executable missing");
            return Err(BrowserError::HostUnavailable);
        }
        std::fs::create_dir_all(&cfg.profile_dir).map_err(|e| {
            tracing::error!(dir = %cfg.profile_dir.display(), error = %e, "profile dir creation failed");
            BrowserError::HostUnavailable
        })?;
        let dtap = cfg.profile_dir.join(DEVTOOLS_ACTIVE_PORT_FILE);
        // Stale handshake file must not poison the port wait.
        let _ = std::fs::remove_file(&dtap);

        let profile_arg = format!("--user-data-dir={}", cfg.profile_dir.display());
        let mut command = Command::new(&cfg.executable);
        command.args([
            "--remote-debugging-port=0",
            profile_arg.as_str(),
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--metrics-recording-only",
            "--mute-audio",
            // The window is often minimized/occluded while the user works
            // elsewhere; without these the renderer throttles and the
            // screencast (Phase 3/4) stalls.
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
        ]);
        if cfg.headless {
            command.arg("--headless=new");
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // tokio::process: the kill is armed at spawn time, so even a
        // panic/abort between here and shutdown cannot leak a Chromium
        // (Command-level setting, inherited by the Child).
        command.kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| {
            tracing::error!(exe = %cfg.executable.display(), error = %e, "Chromium spawn failed");
            BrowserError::HostUnavailable
        })?;
        tracing::info!(
            exe = %cfg.executable.display(),
            headless = cfg.headless,
            pid = child.id(),
            "Chromium host launched"
        );

        let ws_url = wait_for_devtools_ws_url(&dtap, &mut child).await?;
        let opened = cdp::CdpConn::connect(&ws_url).await?;

        // Target discovery powers the lifecycle pump (targetInfoChanged /
        // targetDestroyed) and lists the startup tab.
        opened
            .conn
            .call(
                "Target.setDiscoverTargets",
                Some(json!({"discover": true})),
                None,
            )
            .await?;
        let targets = opened.conn.call("Target.getTargets", None, None).await?;
        let initial_page_targets = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some("page"))
            .map(|t| InitialPageTarget {
                target_id: t
                    .get("targetId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                url: t
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                title: t
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
            .collect();

        Ok(LaunchedHost {
            conn: opened.conn,
            events: Some(opened.events),
            child,
            writer: opened.writer,
            reader: opened.reader,
            initial_page_targets,
        })
    }

    /// Graceful teardown: `Browser.close` ⇒ bounded wait ⇒ kill (belt:
    /// `kill_on_drop`). Never hangs past the bounded wait.
    pub async fn shutdown(self) {
        let _ = self.conn.call("Browser.close", None, None).await;
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut child = self.child;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => break,
                _ => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        // Dropping (not aborting) the socket tasks is intentional: the
        // socket died with Browser.close, so both loops exit on their own.
        drop(self.writer);
        drop(self.reader);
        drop(child); // kill_on_drop cleans up anything left
    }
}

/// Poll for the DevToolsActivePort handshake (bounded), failing fast if
/// Chromium died before writing it.
async fn wait_for_devtools_ws_url(dtap: &Path, child: &mut Child) -> Result<Url, BrowserError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            tracing::error!(%status, "Chromium exited before the DevTools handshake");
            return Err(BrowserError::Internal {
                detail: format!("Chromium exited early during launch ({status})"),
            });
        }
        if let Ok(text) = std::fs::read_to_string(dtap) {
            let mut lines = text.lines();
            let port: u16 = lines.next().unwrap_or("").trim().parse().unwrap_or(0);
            let path = lines.next().unwrap_or("").trim();
            if port > 0 && path.starts_with('/') {
                let url = Url::parse(&format!("ws://127.0.0.1:{port}{path}")).map_err(|_| {
                    BrowserError::Internal {
                        detail: "malformed DevToolsActivePort file".into(),
                    }
                })?;
                return Ok(url);
            }
        }
        if Instant::now() >= deadline {
            tracing::error!("timed out waiting for the DevToolsActivePort handshake");
            return Err(BrowserError::TimedOut {
                what: "Chromium DevToolsActivePort handshake".into(),
            });
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}
