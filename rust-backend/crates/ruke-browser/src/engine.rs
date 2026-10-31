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
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::cdp::{CdpConn, CdpEvent};
use crate::cdp_buffer::{buffered_method, CdpEventBuffer};
use crate::errors::BrowserError;
use crate::host::{HostConfig, LaunchedHost};
use crate::session::{Registry, TurnKey};
use crate::ui::UiHub;

/// The single Ruke agent browser's id. The payloads carry `browser_id`
/// because the reference contract does; anything else fails closed.
pub const BROWSER_ID: &str = "default";

/// [adapted] A runaway-command cap for one agent browser turn. The
/// reference contract has turn-scoped command budgets; the count itself
/// is not a model-visible contract, but a cap protects the shared host
/// from a model driving the browser forever. Human turns (`ui`) are
/// exempt — a human typing is not a runaway.
pub const MAX_COMMANDS_PER_TURN: u32 = 120;

pub struct BrowserRuntime {
    // Phase 13: the profile root is also the History-db home, so the
    // executor's history/clear arms read it directly.
    pub(crate) root: PathBuf,
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
    /// The per-origin authority store (Phase 9): persisted facet rules
    /// (`<root>/ruke-browser-policy.json`) consulted before gated
    /// commands; survives host restarts and shutdown on purpose — a
    /// saved deny is a saved deny.
    pub(crate) authority: Arc<crate::authority::AuthorityStore>,
    /// Pending Browser Panel approvals (Phase 9): permission cards and
    /// browser-auth handoff forms parked on their turn's command.
    /// Tab-removal paths forget their waiters; host death cancels all.
    pub(crate) approvals: Arc<crate::authority::ApprovalRegistry>,
    /// Per-turn cancellation tokens (Phase 11): `begin_turn` registers
    /// one, parked approval/handoff waits select on it, and `end_turn`
    /// or the turn guard's Drop fires it — a stopped turn can never
    /// leave a zombie waiting on a panel card nobody will answer.
    pub(crate) turn_cancels: Mutex<HashMap<TurnKey, CancellationToken>>,
    /// Per-turn command counts for `MAX_COMMANDS_PER_TURN` (Phase 11).
    pub(crate) turn_command_counts: Mutex<HashMap<TurnKey, u32>>,
    /// Site-submission evidence (Phase 14): origin → ISO-8601 stamp of
    /// the last `2xx Document` response the engine OBSERVED on a
    /// registered tab's session (`Network.responseReceived`). Fed by
    /// the pump, read by `site_submission_verified`. Session-scoped on
    /// purpose — cleared with the host, because the honest claim is
    /// "this browser session received it", not a persistent ledger.
    pub(crate) submission_verified: Arc<Mutex<HashMap<String, String>>>,
    /// Dev-log mirror (Phase 15): tab_id → the console/log entries the
    /// pump OBSERVED on that tab's session (`Runtime.consoleAPICalled`
    /// and `Log.entryAdded`), kept in a rolling `DEV_LOG_CAP` window.
    ///
    /// Fed by the pump, read by `tab_dev_logs`: the engine answers
    /// from what it actually saw, never from asking the page, and the
    /// mirror clears with the host like every other session registry.
    pub(crate) dev_logs: Arc<Mutex<HashMap<String, Vec<DevLogEntry>>>>,
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
        // Phase 9: policy loads before `root` moves; a missing or
        // corrupt file is the all-always-ask default, never an error.
        let authority = Arc::new(crate::authority::AuthorityStore::load(&root));
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
            authority,
            approvals: Arc::new(crate::authority::ApprovalRegistry::new()),
            turn_cancels: Mutex::new(HashMap::new()),
            turn_command_counts: Mutex::new(HashMap::new()),
            submission_verified: Arc::new(Mutex::new(HashMap::new())),
            dev_logs: Arc::new(Mutex::new(HashMap::new())),
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
            self.approvals.cancel_all();
            self.cancel_all_turns();
            self.submission_verified.lock().clear();
            self.dev_logs.lock().clear();
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
            headless,
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
            headless,
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
                Arc::clone(&self.approvals),
                Arc::clone(&self.submission_verified),
                Arc::clone(&self.dev_logs),
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

    /// Engine-state visibility for `browser_visibility_get` (Phase 15):
    /// `(running, headless)` of the current host slot. Never launches
    /// — same no-resurrect law as [`try_client`](Self::try_client).
    /// With no live host, "headless" is vacuous (nothing is visible
    /// anywhere), so the pair stays honest without a phantom window.
    pub(crate) async fn host_visibility(&self) -> (bool, bool) {
        let slot = self.host.lock().await;
        match slot.as_ref().filter(|h| h.conn.is_alive()) {
            Some(h) => (true, h.headless),
            None => (false, true),
        }
    }

    /// Attach flattened to a page target and turn on the domain events
    /// every later phase leans on (Page lifecycle + Runtime contexts).
    /// Thin wrapper over [`attach_page_target`]: `self` supplies only
    /// the downloads directory for the per-tab `setDownloadBehavior`
    /// pin (Phase 8).
    pub(crate) async fn attach_target(
        &self,
        conn: &CdpConn,
        target_id: &str,
    ) -> Result<String, BrowserError> {
        attach_page_target(conn, target_id, self.io.download_dir()).await
    }

    // ── turn lifecycle (Phase 11) ─────────────────────────────────────

    /// Register a turn's cancellation token and hand back an RAII guard.
    /// However the turn leaves — clean finish, Stop, an error `?`, or a
    /// task abort — the guard's Drop (or an explicit `finish`) fires the
    /// token and prunes the turn's parked cards, so no parked wait ever
    /// outlives its turn. A same-key re-begin cancels the stale token.
    pub fn begin_turn(self: &Arc<Self>, session_id: &str, turn_id: &str) -> BrowserTurnGuard {
        let key = (session_id.to_string(), turn_id.to_string());
        let stale = self
            .turn_cancels
            .lock()
            .insert(key.clone(), CancellationToken::new());
        if let Some(stale) = stale {
            stale.cancel();
        }
        self.turn_command_counts.lock().insert(key.clone(), 0);
        BrowserTurnGuard {
            runtime: self.clone(),
            key,
            armed: true,
        }
    }

    /// The token a parked wait selects on, when the turn is registered.
    pub(crate) fn turn_cancel(&self, key: &TurnKey) -> Option<CancellationToken> {
        self.turn_cancels.lock().get(key).cloned()
    }

    /// Fire and unregister ONE turn's cancellation, in order: the token
    /// first (parked waits wake and fail closed), then that turn's
    /// parked cards — each pruned with an `approval_stale` frame so the
    /// panel removes the card instead of surfacing a too-late click as
    /// an error — then its command budget. Idempotent: reached from
    /// both `end_turn` and the guard's Drop.
    fn fire_turn_cancel(&self, key: &TurnKey) {
        if let Some(token) = self.turn_cancels.lock().remove(key) {
            token.cancel();
        }
        for id in self.approvals.forget_turn(key) {
            self.ui.event(json!({ "type": "approval_stale", "id": id }));
        }
        self.turn_command_counts.lock().remove(key);
    }

    /// Host death / shutdown: every turn's token fires at once.
    fn cancel_all_turns(&self) {
        let mut map = std::mem::take(&mut *self.turn_cancels.lock());
        for (_, token) in map.drain() {
            token.cancel();
        }
        self.turn_command_counts.lock().clear();
    }

    /// Turn end: release claims and run turn cleanup — close the tabs the
    /// turn created that are neither the deliverable nor the handoff tab.
    /// Best-effort CDP closes: a tab that vanished on its own is simply
    /// forgotten (its handle was already removed). The turn's parked
    /// waits are cancelled FIRST (Phase 11), so no approval or handoff
    /// wait is still parked while its tabs are closed underneath it.
    pub async fn end_turn(&self, session_id: &str, turn_id: &str) {
        let key = (session_id.to_string(), turn_id.to_string());
        self.fire_turn_cancel(&key);
        let to_close = self.registry.lock().end_turn(&key);
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
            self.approvals.forget_tab(&t.tab_id);
            self.dev_logs.lock().remove(&t.tab_id);
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
        self.approvals.cancel_all();
        self.cancel_all_turns();
        self.submission_verified.lock().clear();
        self.dev_logs.lock().clear();
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

    // ── Phase 9: approvals + human-side policy ───────────────────────

    /// Answer a parked approval/handoff card from the panel socket
    /// (`{"id":…, …}`). False = unknown, already-answered, or expired.
    pub fn resolve_approval(&self, id: &str, answer: &Value) -> bool {
        self.approvals.resolve(id, answer)
    }

    /// The persisted facet rules, for the policy GET route.
    pub fn policy_list(&self) -> Value {
        json!({ "rules": self.authority.list() })
    }

    /// Human-side policy write (Panel settings / "always allow"
    /// management): unknown facet or decision strings are typed
    /// payload refusals; a successful write persists immediately.
    pub fn policy_set(&self, host: &str, facet: &str, decision: &str) -> Result<(), BrowserError> {
        let host = host.trim();
        if host.is_empty() {
            return Err(BrowserError::PayloadInvalid {
                command: "browser_policy_set".into(),
                reason: "host must be a non-empty registrable domain".into(),
            });
        }
        let facet =
            crate::authority::Facet::parse(facet).ok_or_else(|| BrowserError::PayloadInvalid {
                command: "browser_policy_set".into(),
                reason: format!(
                    "unknown facet {facet:?}: expected access | uploads | downloads | \
                 full_cdp_access | history"
                ),
            })?;
        let decision = crate::authority::Decision::parse(decision).ok_or_else(|| {
            BrowserError::PayloadInvalid {
                command: "browser_policy_set".into(),
                reason: "unknown decision: expected deny | always_ask | never_ask".into(),
            }
        })?;
        self.authority.set(host, facet, decision);
        Ok(())
    }

    /// Forget a domain's saved rules (policy UI "forget this site").
    pub fn policy_clear_host(&self, host: &str) {
        self.authority.clear_host(host.trim());
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
            // Chromium composites only the FOREGROUND tab, so a
            // screencast started on a background tab never produces a
            // frame. A fresh view therefore raises its tab first: the
            // panel's contract is "you see live what you are looking
            // at", and a later subscribe (a different tab) raises that
            // one instead. Best-effort — a vanished page must not
            // fail the subscription itself.
            let _ = conn
                .call("Page.bringToFront", Some(json!({})), Some(&cdp_session))
                .await;
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
        if params.get("type").and_then(Value::as_str) == Some("mouseWheel") {
            raise_wheel_target(&conn, &rec.cdp_session_id).await;
        }
        conn.call(method, Some(params), Some(&rec.cdp_session_id))
            .await?;
        Ok(())
    }
}

/// Wheel input is serviced only for COMPOSITED tabs: in the single
/// window (and under the `--headless=new` product default) a hidden
/// tab's compositor does no work at all, so `Input.dispatchMouseEvent
/// {mouseWheel}` would sit pending until the CDP timeout. Every wheel
/// path (`cua_scroll`, `dom_cua_scroll`, `tab_ax_action` Scroll, and
/// the panel wheel) therefore raises the acted-on tab first — the same
/// "you act on what the window shows" contract a fresh panel subscribe
/// establishes in [`BrowserRuntime::ui_subscribe`]. Best-effort: if the
/// page is already gone the wheel dispatch itself surfaces the error.
pub(crate) async fn raise_wheel_target(conn: &CdpConn, session: &str) {
    let _ = conn
        .call("Page.bringToFront", Some(json!({})), Some(session))
        .await;
}

/// Attach flattened to a page target and turn on the domain events every
/// later phase leans on (Page lifecycle + Runtime contexts). Both the
/// launch path ([`BrowserRuntime::attach_target`]) and the pump's popup
/// adoption arm (Phase 16) go through here, so an adopted popup has
/// exactly the enabled domains a command-created tab has.
async fn attach_page_target(
    conn: &CdpConn,
    target_id: &str,
    download_dir: &Path,
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
    // Phase 14: the Network domain backs `site_submission_verified`
    // — the engine can only verify what it actually observes, so
    // `Network.responseReceived` must flow on every attached tab.
    // The pump records 2xx Document responses per origin; the
    // replay buffer bounds the traffic.
    conn.call("Network.enable", None, Some(&session_id)).await?;
    // Phase 15 (`tab_dev_logs`): the Log domain supplies the
    // browser-level half of what a developer console shows
    // (`Log.entryAdded`). Best-effort — an old host or a refused
    // domain costs mirrored entries, never the attach itself.
    let _ = conn.call("Log.enable", None, Some(&session_id)).await;
    // Phase 12: the page-runtime annotation surface. Install the
    // `document.oai.annotation` script for every future document in
    // this tab, run it once in the already-loaded document, and add
    // the single JSON bridge binding those payloads travel through.
    // All three calls are best-effort: an older Chromium without
    // Runtime.addBinding/Page.addScriptToEvaluateOnNewDocument keeps
    // the annotation surface honestly absent at call time instead
    // of failing the attach.
    let _ = conn
        .call(
            "Runtime.addBinding",
            Some(json!({"name": crate::page_runtime::ANNOTATION_BINDING})),
            Some(&session_id),
        )
        .await;
    let _ = conn
        .call(
            "Page.addScriptToEvaluateOnNewDocument",
            Some(json!({"source": crate::page_runtime::PAGE_RUNTIME_SCRIPT})),
            Some(&session_id),
        )
        .await;
    let _ = conn
        .call(
            "Runtime.evaluate",
            Some(json!({
                "expression": crate::page_runtime::PAGE_RUNTIME_SCRIPT,
                "sourceURL": "ruke-page-runtime",
            })),
            Some(&session_id),
        )
        .await;
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
                "downloadPath": download_dir.to_string_lossy(),
                "eventsEnabled": true,
            })),
            Some(&session_id),
        )
        .await;
    Ok(session_id)
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
    approvals: Arc<crate::authority::ApprovalRegistry>,
    submission_verified: Arc<Mutex<HashMap<String, String>>>,
    dev_logs: Arc<Mutex<HashMap<String, Vec<DevLogEntry>>>>,
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
            // [adapted] Popup adoption (Phase 16): the reference's
            // shared session shows `window.open` / `target=_blank`
            // popups as real tabs — both the model (in `tabs`) and the
            // human (in the panel strip) see them, and either can pick
            // them up. Ruke adopts only page targets whose `openerId`
            // points at an already-registered tab: startup targets have
            // no opener (the launch loop attaches them) and
            // browser-level `Target.createTarget` launches (`tab_new`)
            // have no opener and are registered synchronously by their
            // own command arm, so the opener condition removes every
            // double-attach race with the command paths. Ownership
            // inherits the opener: a popup from an agent tab belongs to
            // the same turn (turn-cleanup candidate unless marked),
            // while a popup the human opens with real panel mouse input
            // stays a user tab and is claimable with
            // `browser_user_claim_tab` exactly like any other human
            // tab.
            "Target.targetCreated" => {
                let info = ev.params.get("targetInfo");
                let popup = info
                    .filter(|i| i.get("type").and_then(|v| v.as_str()) == Some("page"))
                    .and_then(|i| i.get("targetId"))
                    .and_then(|v| v.as_str())
                    .zip(
                        info.and_then(|i| i.get("openerId"))
                            .and_then(|v| v.as_str()),
                    );
                if let Some((target_id, opener_id)) = popup {
                    let inherit = {
                        let reg = registry.lock();
                        if reg.by_target(target_id).is_some() {
                            None
                        } else {
                            reg.by_target(opener_id)
                                .map(|opener| opener.created_by_turn.clone())
                        }
                    };
                    if let Some(inherit) = inherit {
                        let url = info
                            .and_then(|i| i.get("url"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let title = info
                            .and_then(|i| i.get("title"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        match attach_page_target(&conn, target_id, io.download_dir()).await {
                            Ok(session_id) => {
                                let adopted = {
                                    let mut reg = registry.lock();
                                    if reg.by_target(target_id).is_none() {
                                        reg.add_tab(target_id, &session_id, url, title, inherit);
                                        true
                                    } else {
                                        false
                                    }
                                };
                                if adopted {
                                    ui.tabs_changed();
                                }
                            }
                            Err(e) => tracing::warn!(
                                popup_target = %target_id,
                                error = %e,
                                "popup target adopt failed; skipping it"
                            ),
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
                        approvals.forget_tab(&rec.tab_id);
                        dev_logs.lock().remove(&rec.tab_id);
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
            "Runtime.bindingCalled" => {
                // Phase 12: the page-runtime annotation bridge
                // (`page_runtime`). One binding carries every
                // page→engine message this phase forwards; payloads
                // arrive as JSON strings and cross to the panel hub as
                // typed frames. Site-initiated `open_annotation` is
                // evidence, never permission — the panel renders it and
                // the composer grammar marks it untrusted.
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                if ev.params.get("name").and_then(Value::as_str)
                    != Some(crate::page_runtime::ANNOTATION_BINDING)
                {
                    continue;
                }
                let Some(raw) = ev.params.get("payload").and_then(Value::as_str) else {
                    continue;
                };
                let Ok(msg) = serde_json::from_str::<Value>(raw) else {
                    continue;
                };
                let kind = msg.get("kind").and_then(Value::as_str).unwrap_or("");
                let frame_type = match kind {
                    "open_annotation" => "open_annotation",
                    "features" => "annotation_features",
                    "mode" => "annotation_mode",
                    "controls" => "annotation_controls",
                    // Phase 14: the page's `toolchange` mirror. The
                    // recovered preload forwards a `webmcp_changed`
                    // note (version-tagged) on every registration
                    // change; the panel uses it to refresh its
                    // "this page declares AI tools" badge. Evidence,
                    // never permission — the tools themselves are
                    // listed only through the gated command.
                    "webmcp" => "webmcp_changed",
                    _ => continue,
                };
                let tab = registry.lock().by_session(sid).cloned();
                if let Some(t) = tab.as_ref() {
                    ui.event(json!({
                        "type": frame_type,
                        "tab_id": t.tab_id,
                        "detail": msg.get("detail").cloned().unwrap_or(Value::Null),
                    }));
                }
            }
            "Network.responseReceived" => {
                // Phase 14 (`site_submission_verified`): the ONLY
                // submission evidence the engine can honestly claim is
                // a document response it actually observed on a
                // registered tab's session. Stamp the origin on a 2xx
                // Document; the reader answers `verified_at` from this
                // map. Registry guard is bound to a cloned local first
                // — never held across the map write.
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let Some(origin) = submission_document_origin(&ev.params) else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                if tab.is_some() {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    submission_verified.lock().insert(
                        origin,
                        crate::history::iso8601_from_chrome_us(crate::history::ms_to_chrome_us(
                            now_ms,
                        )),
                    );
                }
            }
            "Runtime.consoleAPICalled" => {
                // Phase 15 (`tab_dev_logs`): mirror page console output
                // per registered tab. The engine answers only from what
                // the CDP session actually emitted — it never asks the
                // page for its own console (a page could lie).
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                let Some(tab) = tab.as_ref() else {
                    continue;
                };
                push_dev_log(
                    &dev_logs,
                    &tab.tab_id,
                    DevLogEntry {
                        level: crate::content_api::console_level_of(
                            ev.params
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or("log"),
                        ),
                        text: crate::content_api::console_args_text(
                            ev.params.get("args").and_then(Value::as_array),
                        ),
                        url: ev
                            .params
                            .pointer("/stackTrace/callFrames/0/url")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        ts_ms: now_ms(),
                    },
                );
            }
            "Log.entryAdded" => {
                // Phase 15: the browser-level half of the console —
                // network warnings, deprecations, violations. Only
                // entries observed on a registered tab's session are
                // mirrored (the same session-scoped honesty law).
                let Some(sid) = ev.session_id.as_deref() else {
                    continue;
                };
                let tab = registry.lock().by_session(sid).cloned();
                let Some(tab) = tab.as_ref() else {
                    continue;
                };
                let Some(entry) = ev.params.get("entry") else {
                    continue;
                };
                let level = match entry.get("level").and_then(Value::as_str) {
                    Some("verbose") => "verbose",
                    Some("warning") => "warning",
                    Some("error") => "error",
                    _ => "info",
                };
                push_dev_log(
                    &dev_logs,
                    &tab.tab_id,
                    DevLogEntry {
                        level,
                        text: entry
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        url: entry.get("url").and_then(Value::as_str).map(str::to_string),
                        ts_ms: now_ms(),
                    },
                );
            }
            _ => {}
        }
    }
    tracing::debug!("browser event pump ended");
}

/// From one `Network.responseReceived` payload: the origin whose
/// DOCUMENT submission this is, if the response is a same-protocol
/// (http/https) 2xx document. Redirects (3xx) and error statuses are
/// deliberately not "verified" — only the final document the page
/// rendered counts. [adapted] scope: Ruke verifies what its own
/// attached sessions observed; the reference product additionally
/// carries diagnostics attempt events (browserAuth §attempt schema),
/// which Ruke's Phase-9 handoff deliberately does not model.
fn submission_document_origin(params: &Value) -> Option<String> {
    let resp = params.get("response")?;
    if resp.get("type").and_then(Value::as_str) != Some("Document") {
        return None;
    }
    let status = resp.get("status").and_then(Value::as_u64)?;
    if !(200..=299).contains(&status) {
        return None;
    }
    let url = url::Url::parse(resp.get("url").and_then(Value::as_str)?).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some(crate::authority::origin_of(&url))
}

// ── Dev-log mirror (Phase 15, `tab_dev_logs`) ─────────────────────────

/// One mirrored console/log entry observed on a registered tab's CDP
/// session. Levels are the four wire names the `tab_dev_logs` payload
/// filters on; text is the flattened single-line rendering (never raw
/// CDP arg trees — the mirror answers what a developer would have
/// *read*, not an object dump). Page-authored text is evidence, never
/// instructions or permission, exactly like every other content read.
#[derive(Clone, Debug)]
pub(crate) struct DevLogEntry {
    pub(crate) level: &'static str,
    pub(crate) text: String,
    pub(crate) url: Option<String>,
    pub(crate) ts_ms: i64,
}

/// Rolling per-tab window. A long-lived tab can log thousands of
/// lines; the model-facing mirror keeps only the tail, and the answer
/// reports how much older it omitted rather than pretending the
/// window was the whole story.
pub(crate) const DEV_LOG_CAP: usize = 200;

/// Append one observed entry and trim the oldest past the cap.
pub(crate) fn push_dev_log(
    dev_logs: &Mutex<HashMap<String, Vec<DevLogEntry>>>,
    tab_id: &str,
    entry: DevLogEntry,
) {
    let mut map = dev_logs.lock();
    let v = map.entry(tab_id.to_string()).or_default();
    v.push(entry);
    if v.len() > DEV_LOG_CAP {
        let excess = v.len() - DEV_LOG_CAP;
        v.drain(..excess);
    }
}

/// Wire name of a payload level (kept separate from the entry's
/// stored name so the two stay pinned by the same match).
fn level_name(level: crate::schemas::DevLogLevel) -> &'static str {
    match level {
        crate::schemas::DevLogLevel::Verbose => "verbose",
        crate::schemas::DevLogLevel::Info => "info",
        crate::schemas::DevLogLevel::Warning => "warning",
        crate::schemas::DevLogLevel::Error => "error",
    }
}

/// Read the mirror for `tab_id`: level filter, case-insensitive
/// substring over text+url, and a bounded tail of the most recent
/// matches. Returns the JSON array plus how many matching entries the
/// tail cut off (`omitted_older`) — never silently fewer.
pub(crate) fn filter_dev_logs(
    dev_logs: &Mutex<HashMap<String, Vec<DevLogEntry>>>,
    tab_id: &str,
    filter: Option<&str>,
    levels: Option<&[crate::schemas::DevLogLevel]>,
    limit: Option<u64>,
) -> (Vec<Value>, usize) {
    let guard = dev_logs.lock();
    let entries: &[DevLogEntry] = guard.get(tab_id).map(Vec::as_slice).unwrap_or(&[]);
    let needle = filter.map(|f| f.to_ascii_lowercase());
    let wanted: Vec<&DevLogEntry> = entries
        .iter()
        .filter(|e| levels.is_none_or(|lv| lv.iter().any(|l| e.level == level_name(*l))))
        .filter(|e| {
            let Some(n) = needle.as_deref() else {
                return true;
            };
            e.text.to_ascii_lowercase().contains(n)
                || e.url
                    .as_deref()
                    .map(|u| u.to_ascii_lowercase().contains(n))
                    .unwrap_or(false)
        })
        .collect();
    // Default 100, bounded 1..=500 — the tail model-facing read, like
    // the history and dev tools surfaces.
    let limit = limit.unwrap_or(100).clamp(1, 500) as usize;
    let kept = &wanted[wanted.len().saturating_sub(limit)..];
    let omitted = wanted.len() - kept.len();
    (
        kept.iter()
            .map(|e| {
                json!({
                    "level": e.level,
                    "text": e.text,
                    "url": e.url,
                    "ts_ms": e.ts_ms,
                })
            })
            .collect(),
        omitted,
    )
}

/// Epoch millis for mirror timestamps (coarse is fine: entries are
/// stamped at observation, and ordering within the window is the
/// insertion order).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── RAII turn guard (Phase 11) ─────────────────────────────────────────

/// Guard returned by [`BrowserRuntime::begin_turn`]. `finish` runs the
/// full turn-end cleanup explicitly; if the guard is dropped without
/// `finish` — Stop mid-command, an error `?`, a round-cap `break`, a
/// task abort — Drop runs the same cleanup on a best-effort spawn, so
/// claims are released, parked waits fail closed, and the turn's tabs
/// close whatever way the turn left. Dropping the guard without
/// finishing is a bug the type makes loud: cleanup still happens.
pub struct BrowserTurnGuard {
    runtime: Arc<BrowserRuntime>,
    key: TurnKey,
    armed: bool,
}

impl BrowserTurnGuard {
    /// Explicit turn end: cancel the turn's waits, release claims, and
    /// close its unmarked tabs (idempotent with the Drop path).
    pub async fn finish(mut self) {
        self.armed = false;
        self.runtime.end_turn(&self.key.0, &self.key.1).await;
    }
}

impl Drop for BrowserTurnGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        // Fire the token + prune cards synchronously: parked waits
        // must not linger on a dead turn even if the CDP closes are
        // deferred to a spawn.
        self.runtime.fire_turn_cancel(&self.key);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                let runtime = self.runtime.clone();
                let key = self.key.clone();
                handle.spawn(async move {
                    runtime.end_turn(&key.0, &key.1).await;
                });
            }
            Err(_) => {
                // No runtime to spawn the CDP closes on (Drop off the
                // async context): the waits are already failed closed
                // and the counts pruned; the tabs go with the next
                // host death or shutdown.
                tracing::warn!(
                    session_id = %self.key.0,
                    turn_id = %self.key.1,
                    "browser turn guard dropped with no runtime handle: tab closes deferred"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::Parked;

    fn runtime() -> (tempfile::TempDir, Arc<BrowserRuntime>) {
        let dir = tempfile::tempdir().unwrap();
        let rt = Arc::new(BrowserRuntime::new(dir.path().to_path_buf()));
        (dir, rt)
    }

    #[tokio::test]
    async fn begin_turn_registers_and_finish_clears_the_token() {
        let (_dir, rt) = runtime();
        let guard = rt.begin_turn("s", "7");
        assert!(rt
            .turn_cancel(&("s".to_string(), "7".to_string()))
            .is_some());
        guard.finish().await;
        assert!(rt
            .turn_cancel(&("s".to_string(), "7".to_string()))
            .is_none());
        assert!(rt.turn_command_counts.lock().is_empty());
    }

    #[tokio::test]
    async fn guard_drop_without_finish_unwinds_parked_cards() {
        let (_dir, rt) = runtime();
        let key = ("s".to_string(), "7".to_string());
        let guard = rt.begin_turn("s", "7");
        let (id, rx) = rt.approvals.register("t1", &key);
        drop(guard);
        // Token fired, card pruned (failed closed), counts cleared.
        assert!(rt.turn_cancel(&key).is_none());
        assert!(rx.await.is_err());
        assert!(!rt.approvals.resolve(&id, &json!({"decision": "accept"})));
        // The spawned end_turn runs against a dead host: best-effort.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(rt.turn_command_counts.lock().is_empty());
    }

    #[tokio::test]
    async fn end_turn_fires_token_and_prunes_only_that_turns_cards() {
        let (_dir, rt) = runtime();
        let mine = ("s".to_string(), "7".to_string());
        let theirs = ("s".to_string(), "8".to_string());
        let _g7 = rt.begin_turn("s", "7");
        let _g8 = rt.begin_turn("s", "8");
        let (gone_id, gone_rx) = rt.approvals.register("t1", &mine);
        let (keep_id, keep_rx) = rt.approvals.register("t2", &theirs);
        rt.turn_command_counts.lock().insert(mine.clone(), 5);
        rt.end_turn("s", "7").await;
        assert!(rt.turn_cancel(&mine).is_none());
        assert!(gone_rx.await.is_err());
        assert!(!rt.approvals.resolve(&gone_id, &json!({})));
        // The other turn is untouched.
        assert!(rt.turn_cancel(&theirs).is_some());
        assert!(rt
            .approvals
            .resolve(&keep_id, &json!({"decision": "accept"})));
        assert!(keep_rx.await.is_ok());
        assert!(!rt.turn_command_counts.lock().contains_key(&mine));
    }

    #[tokio::test]
    async fn park_cancelled_by_turn_token_and_expired_without_one() {
        let (_dir, rt) = runtime();
        let key = ("s".to_string(), "7".to_string());
        let guard = rt.begin_turn("s", "7");
        let (id, rx) = rt.approvals.register("t1", &key);
        let token = rt.turn_cancel(&key).unwrap();
        // Fire the turn token from a side task while the wait is parked.
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            token.cancel();
        });
        let parked = rt
            .park_approval(&key, &id, rx, std::time::Duration::from_secs(30))
            .await;
        assert!(matches!(parked, Parked::Cancelled), "got {parked:?}");
        assert_eq!(rt.approvals.pending_count(), 0); // pruned
        cancel_task.await.unwrap();
        drop(guard);
        // Without a registered turn, the timeout is the only exit. (A
        // fresh key: the ended turn's spawned end_turn prunes anything
        // parked under its own key — the deliberate fail-closed race
        // behavior — so this card uses its own unregistered turn.)
        let key2 = ("s".to_string(), "9".to_string());
        let (id2, rx2) = rt.approvals.register("t2", &key2);
        let parked = rt
            .park_approval(&key2, &id2, rx2, std::time::Duration::from_millis(20))
            .await;
        assert!(matches!(parked, Parked::Expired), "got {parked:?}");
        assert_eq!(rt.approvals.pending_count(), 0);
    }

    #[tokio::test]
    async fn answer_wins_a_park_wait() {
        let (_dir, rt) = runtime();
        let key = ("s".to_string(), "7".to_string());
        let guard = rt.begin_turn("s", "7");
        let (id, rx) = rt.approvals.register("t1", &key);
        rt.approvals
            .resolve(&id, &json!({"decision": "accept", "note": "ok"}));
        let parked = rt
            .park_approval(&key, &id, rx, std::time::Duration::from_secs(30))
            .await;
        match parked {
            Parked::Answer(answer) => assert_eq!(answer["decision"], "accept"),
            other => panic!("expected an answered park, got {other:?}"),
        }
        assert_eq!(rt.approvals.pending_count(), 0); // answered cards leave the registry
        guard.finish().await;
    }

    // ── Phase 14: submission evidence + local site status ─────────────

    #[test]
    fn submission_evidence_needs_a_2xx_document_on_the_page_protocol() {
        let doc200 = json!({
            "response": { "type": "Document", "status": 200, "url": "https://app.example.com/x" }
        });
        assert_eq!(
            submission_document_origin(&doc200).as_deref(),
            Some("https://app.example.com")
        );
        // Port-carrying origins keep the port (origin floor grammar).
        let ported = json!({
            "response": { "type": "Document", "status": 201, "url": "http://localhost:3210/done" }
        });
        assert_eq!(
            submission_document_origin(&ported).as_deref(),
            Some("http://localhost:3210")
        );
        // A redirect is not a received document…
        let redirect = json!({
            "response": { "type": "Document", "status": 302, "url": "https://app.example.com/" }
        });
        assert_eq!(submission_document_origin(&redirect), None);
        // …nor is an error page, nor a subresource, nor a non-web scheme.
        for params in [
            json!({ "response": { "type": "Document", "status": 404, "url": "https://x.dev/" } }),
            json!({ "response": { "type": "XHR", "status": 200, "url": "https://x.dev/api" } }),
            json!({ "response": { "type": "Document", "status": 200, "url": "file:///c:/x.html" } }),
            json!({ "response": { "type": "Document", "status": 200 } }),
            json!({}),
        ] {
            assert_eq!(submission_document_origin(&params), None, "got {params:?}");
        }
    }

    #[tokio::test]
    async fn site_status_answers_from_saved_permissions_not_a_remote_service() {
        let (_dir, rt) = runtime();
        let ask = rt
            .command(
                "s",
                "u",
                &crate::contract::Command::SiteStatus(crate::schemas::SiteQueryPayload {
                    browser_id: None,
                    url: "https://www.example.com/board".into(),
                }),
            )
            .await
            .expect("site_status answers without a live host");
        assert_eq!(ask["host"], "example.com");
        // Nothing saved yet: every facet answers the honest effective
        // default, and the browser-level history facet reads the global
        // "*" row (also unset ⇒ always_ask).
        for facet in [
            "access",
            "uploads",
            "downloads",
            "full_cdp_access",
            "history",
        ] {
            assert_eq!(ask["permissions"][facet], "always_ask", "facet {facet}");
        }
        rt.policy_set("example.com", "access", "deny").unwrap();
        rt.policy_set("*", "history", "never_ask").unwrap();
        let ans = rt
            .command(
                "s",
                "u",
                &crate::contract::Command::SiteStatus(crate::schemas::SiteQueryPayload {
                    browser_id: None,
                    url: "https://www.example.com/board".into(),
                }),
            )
            .await
            .unwrap();
        assert_eq!(ans["host"], "example.com");
        assert_eq!(ans["permissions"]["access"], "deny");
        // An access-deny is the site-wide effective floor — every other
        // facet on that host answers deny too (the same cascade the gate
        // itself applies), and history reads the global row.
        assert_eq!(ans["permissions"]["uploads"], "deny");
        assert_eq!(ans["permissions"]["history"], "never_ask");
        // Closed contract, spelled out in the answer itself.
        assert!(ans["note"]
            .as_str()
            .unwrap()
            .contains("no remote site-status service"));
        // Non-web schemes and relative junk are typed refusals.
        for bad in ["javascript:alert(1)", "not a url", "ftp://x.dev/"] {
            let err = rt
                .command(
                    "s",
                    "u",
                    &crate::contract::Command::SiteStatus(crate::schemas::SiteQueryPayload {
                        browser_id: None,
                        url: bad.into(),
                    }),
                )
                .await
                .expect_err("site_status must refuse non-web urls");
            assert!(
                matches!(err, BrowserError::PayloadInvalid { .. }),
                "got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn site_submission_verified_answers_observed_evidence_or_none() {
        let (_dir, rt) = runtime();
        rt.submission_verified.lock().insert(
            "https://app.example.com".into(),
            "2026-10-31T00:00:00Z".into(),
        );
        let ans = rt
            .command(
                "s",
                "u",
                &crate::contract::Command::SiteSubmissionVerified(
                    crate::schemas::SiteQueryPayload {
                        browser_id: None,
                        url: "https://app.example.com/thank-you".into(),
                    },
                ),
            )
            .await
            .unwrap();
        assert_eq!(ans["origin"], "https://app.example.com");
        assert_eq!(ans["verified_at"], "2026-10-31T00:00:00Z");
        // An origin nobody submitted to this session: honest null,
        // never a guessed "yes".
        let ans = rt
            .command(
                "s",
                "u",
                &crate::contract::Command::SiteSubmissionVerified(
                    crate::schemas::SiteQueryPayload {
                        browser_id: None,
                        url: "https://never.example/".into(),
                    },
                ),
            )
            .await
            .unwrap();
        assert!(ans["verified_at"].is_null());
    }

    #[test]
    fn dev_log_mirror_window_and_filter_are_honest() {
        use crate::schemas::DevLogLevel;
        let map: Mutex<HashMap<String, Vec<DevLogEntry>>> = Mutex::new(HashMap::new());
        for i in 0..=204u32 {
            push_dev_log(
                &map,
                "t1",
                DevLogEntry {
                    level: if i % 3 == 0 { "error" } else { "info" },
                    text: format!("msg {i}"),
                    url: None,
                    ts_ms: i as i64,
                },
            );
        }
        // Two honest layers: the mirror itself is capped at
        // DEV_LOG_CAP (205 pushes ⇒ the oldest 5 are gone), and the
        // default read window keeps the newest 100 — each layer
        // REPORTS what it dropped instead of hiding it.
        let (logs, omitted) = filter_dev_logs(&map, "t1", None, None, None);
        assert_eq!(logs.len(), 100);
        assert_eq!(omitted, 100);
        assert_eq!(logs[0]["text"], "msg 105");
        assert_eq!(logs[logs.len() - 1]["text"], "msg 204");
        // Level filter + limit: of the 200 surviving mirror entries 67
        // are errors; the reader keeps the newest 5 and says so.
        let (errors, omitted) = filter_dev_logs(
            &map,
            "t1",
            None,
            Some([DevLogLevel::Error].as_slice()),
            Some(5),
        );
        assert_eq!(errors.len(), 5);
        assert_eq!(omitted, 62);
        assert_eq!(errors[4]["text"], "msg 204");
        for e in &errors {
            assert_eq!(e["level"], "error");
        }
        // The substring filter is case-insensitive over text + url.
        let (hits, omitted) = filter_dev_logs(&map, "t1", Some("MSG 150"), None, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["text"], "msg 150");
        assert_eq!(omitted, 0);
        // A tab nobody ever logged on answers honestly empty.
        let (none, omitted) = filter_dev_logs(&map, "nobody", None, None, None);
        assert!(none.is_empty());
        assert_eq!(omitted, 0);
    }
}
