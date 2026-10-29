//! engine.rs — [`BrowserRuntime`]: the long-lived browser service held in
//! `AppState`. One shared Chromium (the Ruke agent browser, `browser_id`
//! "default"), lazily launched on the first browser command, with the
//! session/tab [`Registry`] as the single source of truth for tab handles.
//!
//! Concurrency: the host slot is an async mutex so concurrent commands
//! serialize *only* against (re)launch; once live, commands run in
//! parallel against the single CDP socket (request ids make that safe).
//! Phase 10 injects the turn-scoped serialization at the agent-loop layer
//! (the shared inference slot guard), matching the reference's per-turn
//! command caps.
//!
//! A dead socket is detected lazily: the next command relaunches the host
//! and clears the stale registry — every model-visible handle then fails
//! closed with `browser_context_unavailable` rather than silently binding
//! to the new browser (stale-handle rule from §"Cleanup").

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;

use crate::cdp::{CdpConn, CdpEvent};
use crate::errors::BrowserError;
use crate::host::{HostConfig, LaunchedHost};
use crate::session::Registry;

/// The single Ruke agent browser's id. The payloads carry `browser_id`
/// because the reference contract does; anything else fails closed.
pub const BROWSER_ID: &str = "default";

pub struct BrowserRuntime {
    root: PathBuf,
    host: AsyncMutex<Option<LaunchedHost>>,
    pub(crate) registry: Arc<Mutex<Registry>>,
    pub(crate) session_names: Mutex<HashMap<String, String>>,
}

impl BrowserRuntime {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            host: AsyncMutex::new(None),
            registry: Arc::new(Mutex::new(Registry::default())),
            session_names: Mutex::new(HashMap::new()),
        }
    }

    /// Ensure a live CDP connection, launching Chromium on demand. Startup
    /// tabs (the Chromium initial page) are attached and registered as
    /// USER tabs (owner `None`) so they participate in listing and the
    /// claim protocol exactly like tabs the user opens from the panel.
    pub(crate) async fn client(&self) -> Result<Arc<CdpConn>, BrowserError> {
        let mut slot = self.host.lock().await;
        if let Some(host) = slot.as_ref() {
            if host.conn.is_alive() {
                return Ok(host.conn.clone());
            }
            // Dead host: child killed on drop (kill_on_drop), registry
            // wiped — every handle now fails closed.
            let dead = slot.take().expect("slot checked above");
            drop(dead);
            self.registry.lock().clear_all();
        }

        let cfg = HostConfig::discover(&self.root)?;
        let LaunchedHost {
            conn,
            events,
            child,
            writer,
            reader,
            initial_page_targets,
        } = LaunchedHost::launch(&cfg).await?;

        for t in &initial_page_targets {
            match Self::attach_target(&conn, &t.target_id).await {
                Ok(session_id) => {
                    let mut reg = self.registry.lock();
                    if reg.by_target(&t.target_id).is_none() {
                        reg.add_tab(&t.target_id, &session_id, &t.url, &t.title, None);
                    }
                }
                Err(e) => {
                    tracing::warn!(target = %t.target_id, error = %e, "startup tab attach failed; skipping it");
                }
            }
        }

        *slot = Some(LaunchedHost {
            conn: conn.clone(),
            events: None,
            child,
            writer,
            reader,
            initial_page_targets: Vec::new(),
        });
        if let Some(rx) = events {
            tokio::spawn(event_pump(rx, Arc::clone(&self.registry)));
        }
        Ok(conn)
    }

    /// Like [`client`](Self::client) but never launches: turn cleanup and
    /// shutdown call this — the browser must not be resurrected to close
    /// tabs nobody can see anymore.
    pub(crate) async fn try_client(&self) -> Result<Arc<CdpConn>, BrowserError> {
        let slot = self.host.lock().await;
        match slot.as_ref().filter(|h| h.conn.is_alive()) {
            Some(h) => Ok(h.conn.clone()),
            None => Err(BrowserError::HostUnavailable),
        }
    }

    /// Attach flattened to a page target and turn on the domain events
    /// every later phase leans on (Page lifecycle + Runtime contexts).
    pub(crate) async fn attach_target(
        conn: &CdpConn,
        target_id: &str,
    ) -> Result<String, BrowserError> {
        let res = conn
            .call(
                "Target.attachToTarget",
                Some(json!({"targetId": target_id, "flatten": true})),
                None,
            )
            .await?;
        let session_id = res
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BrowserError::Internal {
                detail: "Target.attachToTarget returned no sessionId".into(),
            })?
            .to_string();
        conn.call("Page.enable", None, Some(&session_id)).await?;
        conn.call("Runtime.enable", None, Some(&session_id)).await?;
        Ok(session_id)
    }

    /// Turn end: release claims and run turn cleanup — close the tabs the
    /// turn created that are neither the deliverable nor the handoff tab.
    /// Best-effort CDP closes: a tab that vanished on its own is simply
    /// forgotten (its handle was already removed).
    pub async fn end_turn(&self, session_id: &str, turn_id: &str) {
        let to_close = self
            .registry
            .lock()
            .end_turn(&(session_id.to_string(), turn_id.to_string()));
        if to_close.is_empty() {
            return;
        }
        let Ok(conn) = self.try_client().await else {
            return; // host already gone: its tabs are gone with it
        };
        for t in to_close {
            let _ = conn
                .call(
                    "Target.closeTarget",
                    Some(json!({"targetId": &t.target_id})),
                    None,
                )
                .await;
            self.registry.lock().remove_tab(&t.tab_id);
        }
    }

    /// Graceful browser teardown (supervisor shutdown / server exit).
    pub async fn shutdown(&self) {
        let host = {
            let mut slot = self.host.lock().await;
            slot.take()
        };
        if let Some(host) = host {
            host.shutdown().await;
        }
        self.registry.lock().clear_all();
    }
}

/// The lifecycle pump: keeps the registry in step with what the browser
/// is actually doing (the human may click, close tabs, or navigate while
/// the agent works — the shared-session rule). Later phases extend this
/// match (dialogs Phase 8, request/CDP buffer Phase 4, WebMCP, etc.);
/// unhandled methods are simply not registry-relevant yet.
async fn event_pump(mut rx: mpsc::UnboundedReceiver<CdpEvent>, registry: Arc<Mutex<Registry>>) {
    while let Some(ev) = rx.recv().await {
        match ev.method.as_str() {
            "Target.targetInfoChanged" => {
                let info = ev.params.get("targetInfo");
                if info.is_some_and(|i| i.get("type").and_then(|v| v.as_str()) == Some("page")) {
                    if let Some(target_id) = info
                        .and_then(|i| i.get("targetId"))
                        .and_then(|v| v.as_str())
                    {
                        let url = info.and_then(|i| i.get("url")).and_then(|v| v.as_str());
                        let title = info.and_then(|i| i.get("title")).and_then(|v| v.as_str());
                        // Chromium's provisional (no-title-yet) tab titles
                        // are address-bar placeholders: empty, the full
                        // URL, or the URL with the scheme stripped. A
                        // queued placeholder event must never overwrite a
                        // real title (or a fresh post-navigation settle
                        // read) with address text.
                        let schemeless = url.and_then(|u| u.split_once("://").map(|(_, r)| r));
                        let meaningful = title
                            .filter(|t| !t.is_empty() && Some(*t) != url && Some(*t) != schemeless);
                        registry.lock().update_by_target(target_id, url, meaningful);
                    }
                }
            }
            "Target.targetDestroyed" => {
                if let Some(target_id) = ev.params.get("targetId").and_then(|v| v.as_str()) {
                    registry.lock().remove_by_target(target_id);
                }
            }
            "Page.frameNavigated" => {
                // Main-frame navigations only (parentId absent).
                let frame = ev.params.get("frame");
                let main = frame.is_some_and(|f| f.get("parentId").is_none());
                if main {
                    if let (Some(sid), Some(url)) = (
                        ev.session_id.as_deref(),
                        frame.and_then(|f| f.get("url")).and_then(|v| v.as_str()),
                    ) {
                        registry.lock().update_by_session(sid, Some(url), None);
                    }
                }
            }
            _ => {}
        }
    }
    tracing::debug!("browser event pump ended");
}
