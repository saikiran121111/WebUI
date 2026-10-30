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
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;

use crate::cdp::{CdpConn, CdpEvent};
use crate::cdp_buffer::{buffered_method, CdpEventBuffer};
use crate::errors::BrowserError;
use crate::host::{HostConfig, LaunchedHost};
use crate::session::Registry;
use crate::ui::UiHub;

/// The single Ruke agent browser's id. The payloads carry `browser_id`
/// because the reference contract does; anything else fails closed.
pub const BROWSER_ID: &str = "default";

pub struct BrowserRuntime {
    root: PathBuf,
    host: AsyncMutex<Option<LaunchedHost>>,
    pub(crate) registry: Arc<Mutex<Registry>>,
    pub(crate) session_names: Mutex<HashMap<String, String>>,
    /// The Browser Panel hub (Phase 3): UI sockets, screencast
    /// ref-counting, tab/frame fan-out.
    pub ui: Arc<UiHub>,
    /// The bounded per-tab CDP event replay buffer (Phase 4): fed by the
    /// lifecycle pump, served by `tab_cdp_events`.
    pub(crate) cdp_events: Arc<CdpEventBuffer>,
    /// The DOM CUA registries (Phase 5): per-tab snapshot frame/node
    /// maps and the FIFO isolated-world cache. Every tab-removal path
    /// forgets here too, so stale handles fail closed.
    pub(crate) dom: Arc<crate::dom_cua::DomRegistries>,
    /// The AX registries (Phase 6): per-tab navigation state machine,
    /// committed revisions, and the capture pipeline. Every tab-removal
    /// path forgets here too, so stale handles fail closed.
    pub(crate) ax: Arc<crate::ax::AxRegistries>,
    /// The Playwright-style locator registries (Phase 7): per-tab aria
    /// snapshot `[ref=eN]` maps consumed by the `playwright_*` command
    /// family. Every tab-removal path forgets here too, so stale refs
    /// fail closed.
    pub(crate) pw: Arc<crate::pw::PwRegistries>,
    /// The I/O registries (Phase 8): per-tab JavaScript dialog state,
    /// intercepted file choosers, and downloads (`allowAndName` files
    /// under `<root>/downloads`). Every tab-removal path forgets here
    /// too, so stale handles fail closed.
    pub(crate) io: Arc<crate::io_state::IoRegistries>,
}

impl BrowserRuntime {
    pub fn new(root: PathBuf) -> Self {
        let registry = Arc::new(Mutex::new(Registry::default()));
        // [adapted] downloads land under `<root>/downloads` with
        // Chromium-assigned guid filenames (`Page.setDownloadBehavior`
        // allowAndName): deterministic paths for
        // `playwright_download_path` without scraping Chromium's
        // .crdownload bookkeeping. Computed before `root` moves.
        let io = Arc::new(crate::io_state::IoRegistries::new(root.join("downloads")));
        Self {
            root,
            host: AsyncMutex::new(None),
            ui: Arc::new(UiHub::new(Arc::clone(&registry))),
            registry,
            session_names: Mutex::new(HashMap::new()),
            cdp_events: Arc::new(CdpEventBuffer::default()),
            dom: Arc::new(crate::dom_cua::DomRegistries::default()),
            ax: Arc::new(crate::ax::AxRegistries::default()),
            pw: Arc::new(crate::pw::PwRegistries::default()),
            io,
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
            self.cdp_events.clear();
            self.dom.clear_all();
            self.ax.clear_all();
            self.pw.clear_all();
            self.io.clear_all();
            self.ui.clear_state();
            self.ui.tabs_changed();
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

        // [adapted] downloads write here (`attach_target` pins the
        // behavior per tab); best-effort — attach still works without
        // the directory, the download paths would just fail later.
        let _ = tokio::fs::create_dir_all(self.io.download_dir()).await;

        for t in &initial_page_targets {
            match self.attach_target(&conn, &t.target_id).await {
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
            tokio::spawn(event_pump(
                rx,
                Arc::clone(&self.registry),
                Arc::clone(&self.cdp_events),
                Arc::clone(&self.dom),
                Arc::clone(&self.ax),
                Arc::clone(&self.pw),
                Arc::clone(&self.io),
                Arc::clone(&self.ui),
                conn.clone(),
            ));
        }
        // A connected panel learns about session-restored / initial tabs
        // the moment the browser comes up (it never polls).
        self.ui.tabs_changed();
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
    /// `self` supplies only the downloads directory for the per-tab
    /// `setDownloadBehavior` pin (Phase 8).
    pub(crate) async fn attach_target(
        &self,
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
        // Phase 5: the DOM domain backs getFrameOwner/describeNode/
        // getContentQuads for DOM CUA geometry and resolution.
        conn.call("DOM.enable", None, Some(&session_id)).await?;
        // Phase 6: the Accessibility domain backs `getFullAXTree`
        // captures, and its loadComplete/nodesUpdated events drive the
        // capture pipeline's quiet-window waits. Without this enable
        // the AX registries would never observe an update.
        conn.call("Accessibility.enable", None, Some(&session_id))
            .await?;
        // Phase 8: route `<input type=file>` activations through
        // `Page.fileChooserOpened` instead of letting Chromium open an
        // OS file dialog no headless process can service. Best-effort:
        // an older Chromium without this domain method simply keeps the
        // chooser path unsupported at call time.
        let _ = conn
            .call(
                "Page.setInterceptFileChooserDialog",
                Some(json!({"enabled": true})),
                Some(&session_id),
            )
            .await;
        // The per-tab intercept MARK is minted lazily by the executor:
        // attach only ever knows the CDP target id, while the registry
        // mints the tab handle AFTER attach returns — a target-keyed
        // mark could never match the tab-keyed lookups. Enabling here
        // is what matters: chooser events are captured from the tab's
        // very first chooser on, and re-enabling is idempotent.
        // Phase 8 [adapted]: `allowAndName` stores every download at
        // `<download-dir>/<guid>` so `playwright_download_path` and the
        // media-download flows can hand back real filesystem paths with
        // no Chromium dialog and no filename-collision renaming.
        let _ = conn
            .call(
                "Page.setDownloadBehavior",
                Some(json!({
                    "behavior": "allowAndName",
                    "downloadPath": self.io.download_dir().to_string_lossy(),
                    "eventsEnabled": true,
                })),
                Some(&session_id),
            )
            .await;
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
            self.cdp_events.forget_tab(&t.tab_id);
            self.dom.forget_tab(&t.tab_id);
            self.ax.forget_tab(&t.tab_id);
            self.pw.forget_tab(&t.tab_id);
            self.io.forget_tab(&t.tab_id);
            self.ui.drop_tab(&t.tab_id, &t.cdp_session_id);
        }
        self.ui.tabs_changed();
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
        self.cdp_events.clear();
        self.dom.clear_all();
        self.ax.clear_all();
        self.pw.clear_all();
        self.io.clear_all();
        self.ui.clear_state();
        self.ui.tabs_changed();
    }

    // ── Browser Panel (Phase 3) ───────────────────────────────────────
    // The live human view into the SAME session the model controls (plan
    // §0: one browser, one tab set — no parallel hidden browser).
    // Transport guards (loopback bind, Origin allowlist, one-shot
    // ticket) live in the ruke-server route; everything here is the
    // protocol and the CDP plumbing.

    /// Mint a one-shot UI-socket ticket: `(ticket, ttl_ms)`. The
    /// authenticated HTTP route hands it to the panel, which rides it on
    /// the WS query (handshakes cannot set the bridge-secret header).
    pub fn ws_ticket(&self) -> (String, u64) {
        self.ui.mint_ticket()
    }

    /// Admit a WebSocket upgrade exactly once per ticket.
    pub fn claim_ws_ticket(&self, ticket: &str) -> bool {
        self.ui.claim_ticket(ticket)
    }

    /// Register a connected panel socket: its id plus the outbound
    /// channel the route drains into the WebSocket.
    pub fn ui_open(&self) -> (u64, mpsc::UnboundedReceiver<Value>) {
        self.ui.open()
    }

    /// The tab snapshot sent the moment a panel connects.
    pub fn ui_tabs_snapshot(&self) -> Value {
        json!({ "browser_id": BROWSER_ID, "tabs": self.ui.tabs_snapshot() })
    }

    /// Start (or join) viewing a tab: ref-counted `Page.startScreencast`
    /// on its CDP session. A panel watching is a *user* action, so the
    /// host launches on demand like any other command path.
    pub async fn ui_subscribe(&self, client: u64, tab_id: &str) -> Result<Value, BrowserError> {
        let fresh = self.ui.subscribe(client, tab_id)?;
        if let Some(cdp_session) = fresh {
            let conn = self.client().await?;
            let started = conn
                .call(
                    "Page.startScreencast",
                    Some(json!({"format": "jpeg", "quality": 70, "everyNthFrame": 1})),
                    Some(&cdp_session),
                )
                .await;
            if let Err(e) = started {
                self.ui.forget_subscribe(client, tab_id, &cdp_session);
                return Err(e);
            }
        }
        let rec = self.registry.lock().require(tab_id)?;
        Ok(crate::executor::tab_json(&rec))
    }

    pub async fn ui_unsubscribe(&self, client: u64, tab_id: &str) -> Result<(), BrowserError> {
        if let Some(cdp_session) = self.ui.unsubscribe(client, tab_id)? {
            if let Ok(conn) = self.try_client().await {
                // Best-effort: the session may already be gone (tab
                // closed); the hub bookkeeping is unwound either way.
                let _ = conn
                    .call("Page.stopScreencast", Some(json!({})), Some(&cdp_session))
                    .await;
            }
        }
        Ok(())
    }

    /// Panel socket closed: stop the screencasts it was the last viewer
    /// of (a dead host makes them moot, hence try_client + best-effort).
    pub async fn ui_close(&self, client: u64) {
        let stops = self.ui.close(client);
        if stops.is_empty() {
            return;
        }
        if let Ok(conn) = self.try_client().await {
            for session in stops {
                let _ = conn
                    .call("Page.stopScreencast", Some(json!({})), Some(&session))
                    .await;
            }
        }
    }

    /// A panel input event drives the SAME tab over the SAME CDP session
    /// the agent uses. The acting gate is the live subscription itself
    /// (`require_subscribed`): you act only on what you are looking at.
    pub async fn ui_input(
        &self,
        client: u64,
        tab_id: &str,
        event: &Value,
    ) -> Result<(), BrowserError> {
        self.ui.require_subscribed(client, tab_id)?;
        let rec = self.registry.lock().require(tab_id)?;
        let (method, params) = crate::ui::input_dispatch(event)?;
        let conn = self.client().await?;
        conn.call(method, Some(params), Some(&rec.cdp_session_id))
            .await?;
        Ok(())
    }
}

/// The lifecycle pump: keeps the registry in step with what the browser
/// is actually doing (the human may click, close tabs, or navigate while
/// the agent works — the shared-session rule). Later phases extend this
/// match (dialogs Phase 8, WebMCP, etc.); unhandled methods are simply
/// not registry-relevant yet.
#[allow(clippy::too_many_arguments)]
async fn event_pump(
    mut rx: mpsc::UnboundedReceiver<CdpEvent>,
    registry: Arc<Mutex<Registry>>,
    cdp_events: Arc<CdpEventBuffer>,
    dom: Arc<crate::dom_cua::DomRegistries>,
    ax: Arc<crate::ax::AxRegistries>,
    pw: Arc<crate::pw::PwRegistries>,
    io: Arc<crate::io_state::IoRegistries>,
    ui: Arc<UiHub>,
    conn: Arc<CdpConn>,
) {
    while let Some(ev) = rx.recv().await {
        // Phase 4 replay buffer: every event belonging to a registered
        // tab is buffered BEFORE registry routing, so a method the match
        // below ignores still reaches `tab_cdp_events` replay. Frames
        // are excluded (UiHub fan-out, not protocol evidence). Bind the
        // cloned record in a plain statement — an `if let` scrutinee
        // would keep the registry guard alive through the body.
        if let Some(sid) = ev.session_id.as_deref() {
            if buffered_method(&ev.method) {
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(tab) = tab.as_ref() {
                    cdp_events.push(tab, &ev);
                }
            }
        }
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
                        if registry.lock().update_by_target(target_id, url, meaningful) {
                            ui.tabs_changed();
                        }
                    }
                }
            }
            "Target.targetDestroyed" => {
                if let Some(target_id) = ev.params.get("targetId").and_then(|v| v.as_str()) {
                    // Bind the owned record in a plain statement: an
                    // `if let` scrutinee temporary keeps the registry
                    // guard alive through the whole body, and
                    // `tabs_changed` re-locks the registry — parking_lot
                    // is not reentrant, so the nested form self-deadlocked
                    // the moment Chromium destroyed a registered tab on
                    // its own (Browser.close tearing down session-
                    // restored user tabs; caught by the real-Chromium
                    // smoke hanging in shutdown).
                    let destroyed = registry.lock().remove_by_target(target_id);
                    if let Some(rec) = destroyed {
                        cdp_events.forget_tab(&rec.tab_id);
                        dom.forget_tab(&rec.tab_id);
                        ax.forget_tab(&rec.tab_id);
                        pw.forget_tab(&rec.tab_id);
                        io.forget_tab(&rec.tab_id);
                        ui.drop_tab(&rec.tab_id, &rec.cdp_session_id);
                        ui.tabs_changed();
                    }
                }
            }
            "Page.frameNavigated" => {
                // Main-frame navigations only (parentId absent).
                let frame = ev.params.get("frame");
                let main = frame.is_some_and(|f| f.get("parentId").is_none());
                // H-BS-27 committed landing: the AX state machine
                // settles the frame/loader/url pair, flips pending, and
                // (bfcache) fast-paints. Subframe navs invalidate the
                // committed revision outright.
                if let Some(sid) = ev.session_id.as_deref() {
                    let tab = registry.lock().by_session(sid).cloned();
                    if let Some(t) = tab.as_ref() {
                        if main {
                            let bfcache = ev
                                .params
                                .get("type")
                                .or_else(|| frame.and_then(|f| f.get("type")))
                                .and_then(Value::as_str)
                                .is_some_and(|ty| {
                                    ty.eq_ignore_ascii_case("BackForwardCacheRestore")
                                });
                            ax.on_main_frame_navigated(
                                &t.tab_id,
                                frame
                                    .and_then(|f| f.get("id"))
                                    .and_then(Value::as_str)
                                    .unwrap_or(""),
                                frame
                                    .and_then(|f| f.get("loaderId"))
                                    .and_then(Value::as_str),
                                frame.and_then(|f| f.get("url")).and_then(Value::as_str),
                                bfcache,
                            );
                        } else {
                            ax.invalidate_subtree(&t.tab_id);
                        }
                    }
                }
                if main {
                    if let (Some(sid), Some(url)) = (
                        ev.session_id.as_deref(),
                        frame.and_then(|f| f.get("url")).and_then(|v| v.as_str()),
                    ) {
                        if registry.lock().update_by_session(sid, Some(url), None) {
                            ui.tabs_changed();
                        }
                    }
                }
            }
            // Title refresh for navigations nobody commanded (a user
            // click inside a panel-viewed tab, page JS, or a target-init
            // nav): once the new document fires `load`, read its title
            // authoritatively. `Target.targetInfoChanged` is not
            // reliably delivered for title updates on a flattened
            // attach (real-Chromium smoke caught the stale registry
            // title after a page-JS navigation), and the panel tab
            // strip must never show the previous page's title.
            "Page.loadEventFired" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    ax.on_load_event(&t.tab_id);
                }
                let title = BrowserRuntime::eval_string(&conn, sid, "document.title")
                    .await
                    .ok()
                    .flatten();
                if let Some(title) = title {
                    if registry.lock().update_by_session(sid, None, Some(&title)) {
                        ui.tabs_changed();
                    }
                }
            }
            // Panel screencast (Phase 3): frames flow only for sessions
            // with a live `Page.startScreencast` (subscribe ref-counts
            // them). The frameAck is what releases Chromium's NEXT
            // frame, so ack before fanning — a slow or vanished viewer
            // must never stall the pipeline. Anti-throttle launch flags
            // (host.rs) keep frames flowing while the tab is occluded.
            "Page.screencastFrame" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                if !ui.watching(sid) {
                    continue;
                }
                let _ = conn
                    .call(
                        "Page.screencastFrameAck",
                        Some(json!({"sessionId": sid})),
                        Some(sid),
                    )
                    .await;
                ui.frame(
                    sid,
                    ev.params.get("data").and_then(|v| v.as_str()).unwrap_or(""),
                    ev.params.get("metadata"),
                );
            }
            // Phase 6: Accessibility domain activity stamps the tab's
            // last-update instant, which the capture pipeline's quiet
            // window measures against.
            "Accessibility.loadComplete" | "Accessibility.nodesUpdated" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    ax.note_ax_update(&t.tab_id);
                }
            }
            // H-BS-27 navigation state machine. The main-frame filter
            // (and every other rule) lives inside the hooks; the pump
            // only decodes CDP params and hands them over.
            "Page.frameStartedLoading" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let Some(frame_id) = ev.params.get("frameId").and_then(Value::as_str) else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    ax.on_frame_started_loading(
                        &t.tab_id,
                        frame_id,
                        ev.params.get("loaderId").and_then(Value::as_str),
                    );
                }
            }
            "Page.frameDetached" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    ax.invalidate_subtree(&t.tab_id);
                }
            }
            // Dialogs bump the revision: an open dialog blocks page
            // input, so any AX state captured around one is suspect.
            // Phase 8: the opening event is ALSO the dialog registry
            // write (the recovered `jsDialogsByTabId` shape: id,
            // message, defaultPrompt, type, url). `beforeunload` is
            // remembered and auto-accepted (the recovered rule — head-
            // less navigation confirmation must never strand a model
            // command). `[adapted]` the reference's auth-dialog branch
            // that auto-accepts for browser credential injection is
            // N/A: Ruke has no browser-auth credential surface yet, so
            // `beforeunload` is the only auto-accepted type.
            "Page.javascriptDialogOpening" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    let dialog = io.on_dialog_open(&t.tab_id, &ev.params);
                    ax.on_dialog_event(&t.tab_id);
                    if dialog.dialog_type == "beforeunload" {
                        let _ = conn
                            .call(
                                "Page.handleJavaScriptDialog",
                                Some(json!({"accept": true})),
                                Some(sid),
                            )
                            .await;
                    }
                }
            }
            "Page.javascriptDialogClosed" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    io.on_dialog_closed(&t.tab_id);
                    ax.on_dialog_event(&t.tab_id);
                }
            }
            // Phase 8: file-chooser interception (engineered from the
            // CDP event grammar; the recovered bundle carries only the
            // chooser REGISTRY and its consumption points, never this
            // ingestion — see io_state.rs module header).
            "Page.fileChooserOpened" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    io.on_file_chooser_opened(&t.tab_id, &ev.params);
                }
            }
            // Phase 8: download progress for the `allowAndName` files
            // pinned per tab at attach.
            "Page.downloadWillBegin" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    io.on_download_begin(&t.tab_id, &ev.params);
                }
            }
            "Page.downloadProgress" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    io.on_download_progress(&t.tab_id, &ev.params);
                }
            }
            "Page.domContentEventFired" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    ax.on_dom_content_loaded(&t.tab_id);
                }
            }
            "Page.frameStoppedLoading" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let Some(frame_id) = ev.params.get("frameId").and_then(Value::as_str) else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    ax.on_frame_stopped_loading(&t.tab_id, frame_id);
                }
            }
            "Page.navigatedWithinDocument" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let Some(frame_id) = ev.params.get("frameId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(url) = ev.params.get("url").and_then(Value::as_str) else {
                    continue;
                };
                let nav_type = ev.params.get("type").and_then(Value::as_str).unwrap_or("");
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    ax.on_navigated_within_document(&t.tab_id, frame_id, url, nav_type);
                }
            }
            "Page.lifecycleEvent" => {
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let Some(frame_id) = ev.params.get("frameId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(name) = ev.params.get("name").and_then(Value::as_str) else {
                    continue;
                };
                // Loader progress counts as committed unless the engine
                // explicitly says otherwise.
                let progress_committed = ev
                    .params
                    .get("loaderProgress")
                    .is_none_or(|p| p.as_str().is_none_or(|s| s == "committed"));
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    ax.on_lifecycle_event(
                        &t.tab_id,
                        frame_id,
                        ev.params.get("loaderId").and_then(Value::as_str),
                        name,
                        progress_committed,
                    );
                }
            }
            _ => {}
        }
    }
    tracing::debug!("browser event pump ended");
}
