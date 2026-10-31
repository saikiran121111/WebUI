//! executor.rs — the Phase-2 command executor: the first increment of the
//! engine that turns decoded [`Command`]s into real CDP effects through
//! [`BrowserRuntime`]. Every result is grounded in actual browser state
//! (the registry, kept live by the lifecycle pump, plus authoritative
//! `document`/`location` reads after each navigation) — never a text
//! echo of intent.
//!
//! Increment policy (pinned for the Phase-26 coverage audit): the 13
//! lifecycle commands (Phase 2), the raw-CDP bridge pair
//! `tab_cdp_call`/`tab_cdp_events` (Phase 4), the five DOM CUA
//! commands `dom_cua_get_visible_dom`/`dom_cua_click`/
//! `dom_cua_double_click`/`dom_cua_scroll`/`dom_cua_type` (Phase 5),
//! the AX read command `tab_ax_get_state` with ALL three content
//! modes (Phases 6/8), the Phase-7 locator runtime, and the Phase-8
//! surface — `tab_ax_action`, `tab_screenshot`, the JS-dialog pair
//! `tab_get_js_dialog`/`tab_handle_js_dialog`, `dom_cua_keypress`,
//! `dom_cua_download_media`, and the download/file-chooser commands
//! `playwright_wait_for_download`, `playwright_download_path`,
//! `playwright_wait_for_file_chooser`,
//! `playwright_file_chooser_set_files`,
//! `playwright_locator_download_media` — all execute for real. The
//! final eighteen registry rows (`cua_*`, `tab_clipboard_*`,
//! `tab_content_export*`, `tab_page_assets_*`, `tab_dev_logs`,
//! `browser_visibility_get`) landed real arms in Phase 15: the
//! `execute()` match is now EXHAUSTIVE — rustc enforces an arm per
//! registry kind, so the Phase-1 coverage ledger (83 rows) is
//! compile-checked rather than tracked. The `Unsupported` wire code
//! stays reserved (the contract grammar keeps it) but no execute()
//! path returns it.
//!
//! Security floors: navigation is restricted to `http(s)` and
//! `about:blank` — `file:`, `data:` and `javascript:` URLs are refused
//! outright — and the agent may only *mutate* tabs it created or that
//! were explicitly claimed via `browser_user_claim_tab` (the
//! shared-session handoff rule), never while a manual handoff has the
//! tab. Layered on top since Phase 9: the per-origin authority model
//! (`authority.rs` — access / uploads / downloads / full_cdp_access
//! facets, persisted rule store, always-ask approval cards parked in
//! the Browser Panel), the manual-handoff takeover lock, the
//! browser-auth credential handoff (`auth_handoff.rs` — credentials
//! travel human→CDP only, never through the model), and bot-detection
//! telemetry.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use url::Url;

use crate::cdp::CdpConn;
use crate::contract::Command;
use crate::engine::{BrowserRuntime, BROWSER_ID};
use crate::errors::{payload_invalid, BrowserError};
use crate::io_state::IoRegistries;
use crate::schemas::{AxStateContent, ContentFormat, ScreenshotPayload};
use crate::session::{TabRecord, TurnKey};

/// Navigation settle budget: bounded polling of `document.readyState`
/// after every nav-family CDP call. Deliberately short — it only needs
/// to cover the common case so the immediate post-nav read is fresh;
/// anything slower is caught by the lifecycle pump (Page.frameNavigated /
/// Target.targetInfoChanged) and shows up in the *next* tab listing,
/// which is exactly how the reference behaves when a page is still
/// loading.
const SETTLE_BUDGET: Duration = Duration::from_secs(3);
const SETTLE_TICK: Duration = Duration::from_millis(150);

impl BrowserRuntime {
    /// The engine-facing entry (Phase 10's tool loop calls this through
    /// the turn guard): envelope metadata in, browser-grounded JSON out.
    pub async fn command(
        &self,
        session_id: &str,
        turn_id: &str,
        cmd: &Command,
    ) -> Result<Value, BrowserError> {
        let key = (session_id.to_string(), turn_id.to_string());
        self.execute(&key, cmd).await
    }

    pub(crate) async fn execute(
        &self,
        key: &TurnKey,
        cmd: &Command,
    ) -> Result<Value, BrowserError> {
        // Turn-scoped command budget (Phase 11, plan §"turn-scoped
        // command caps"): the count lives per turn in the engine and
        // dies with it; a runaway model hits a refusal that tells it to
        // report and hand back rather than a silent stall. Human turns
        // (`ui`) are exempt — a human typing is not a runaway.
        if key.1 != crate::authority::HUMAN_TURN_ID {
            let mut counts = self.turn_command_counts.lock();
            let seen = counts.entry(key.clone()).or_insert(0);
            *seen += 1;
            if *seen > crate::engine::MAX_COMMANDS_PER_TURN {
                return Err(BrowserError::CapabilityBlocked {
                    reason: format!(
                        "this browser turn exceeded its cap of {} commands; report what you have and let the user take it from here",
                        crate::engine::MAX_COMMANDS_PER_TURN
                    ),
                });
            }
        }
        // Recovered `throwIfJsDialogBlocksMethod`: while a JS dialog
        // is open on the tab, page-mutating and input-surfacing
        // commands are refused until the model discovers and dismisses
        // it — the error names `tab_get_js_dialog` as the escape
        // route. Exemptions (see `guarded_tab_id`): the dialog pair
        // itself, pure reads/state snapshots, and the download and
        // file-chooser waits (they were legitimately armed *before*
        // the dialog opened and must stay serviceable).
        if let Some(tab_id) = guarded_tab_id(cmd) {
            if let Some(dialog) = self.io.js_dialog(&tab_id) {
                return Err(BrowserError::JsDialogBlocksMethod {
                    dialog_type: dialog.dialog_type,
                });
            }
        }
        // Phase-9 authority facets (the recovered `acquireAuthority()`
        // preamble): observe/act/uploads/downloads/full-CDP each consult
        // the per-origin rule store — a saved deny refuses, always-ask
        // parks an approval card in the Browser Panel. Human-origin
        // commands (the panel itself) skip the gates; the human is the
        // one who grants.
        if let Some((tab_id, gates)) = crate::authority::gate_for(cmd) {
            for gate in gates {
                self.apply_gate(key, &tab_id, gate.facet, gate.label)
                    .await?;
            }
        }
        match cmd {
            Command::Tabs(p) => {
                check_browser(p.browser_id.as_deref().unwrap_or(BROWSER_ID))?;
                // A dead host must not leave ghost rows in a listing:
                // prune first (no relaunch — listing never *starts* a
                // browser).
                if self.try_client().await.is_err() {
                    self.registry.lock().clear_all();
                }
                let tabs: Vec<Value> = self.registry.lock().list().iter().map(tab_json).collect();
                Ok(json!({ "browser_id": BROWSER_ID, "tabs": tabs }))
            }
            Command::BrowserUserOpenTabs(p) => {
                check_browser(&p.browser_id)?;
                if self.try_client().await.is_err() {
                    self.registry.lock().clear_all();
                }
                let tabs: Vec<Value> = self
                    .registry
                    .lock()
                    .user_tabs()
                    .iter()
                    .map(tab_json)
                    .collect();
                Ok(json!({ "browser_id": BROWSER_ID, "tabs": tabs }))
            }
            Command::BrowserUserClaimTab(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                self.registry.lock().claim(&p.tab_id, key)?;
                Ok(tab_json(&rec))
            }
            Command::GetTab(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                Ok(tab_json(&rec))
            }
            Command::AnnotationCapture(p) => {
                // Phase 12: the panel's comment-composer anchor read.
                // Human-only (NOT_MODEL_EXPOSED); the page script owns
                // the anchor shape (page_runtime::ANNOTATION_CAPTURE_JS),
                // the engine just ferries the JSON through. `kind:"none"`
                // is a valid honest answer, not an error.
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                let anchor = Self::eval_string(
                    &conn,
                    &rec.cdp_session_id,
                    crate::page_runtime::ANNOTATION_CAPTURE_JS,
                )
                .await?
                .ok_or_else(|| BrowserError::Internal {
                    detail: "annotation capture returned no anchor".into(),
                })?;
                let anchor: Value =
                    serde_json::from_str(&anchor).map_err(|e| BrowserError::Internal {
                        detail: format!("annotation anchor was not JSON: {e}"),
                    })?;
                Ok(json!({ "tab_id": p.tab_id, "page_url": rec.url, "anchor": anchor }))
            }
            Command::TabNew(p) => {
                check_browser(&p.browser_id)?;
                let url = p.url.as_deref().unwrap_or("about:blank");
                check_navigable(url)?;
                let conn = self.client().await?;
                let res = conn
                    .call("Target.createTarget", Some(json!({"url": url})), None)
                    .await?;
                let target_id = res
                    .get("targetId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BrowserError::Internal {
                        detail: "Target.createTarget returned no targetId".into(),
                    })?
                    .to_string();
                let session_id = self.attach_target(&conn, &target_id).await?;
                let rec = self.registry.lock().add_tab(
                    &target_id,
                    &session_id,
                    url,
                    "",
                    Some(key.clone()),
                );
                Ok(json!({ "browser_id": BROWSER_ID, "tab_id": rec.tab_id }))
            }
            Command::TabClose(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                if !self.registry.lock().can_act_on(&p.tab_id, key) {
                    return Err(BrowserError::CapabilityBlocked {
                        reason: format!(
                            "tab {} is a user tab; claim it with browser_user_claim_tab \
                             before closing it (the agent may only close tabs it created)",
                            p.tab_id
                        ),
                    });
                }
                let conn = self.client().await?;
                conn.call(
                    "Target.closeTarget",
                    Some(json!({"targetId": &rec.target_id})),
                    None,
                )
                .await?;
                self.registry.lock().remove_tab(&p.tab_id);
                // Complement of the pump's targetDestroyed forget: the
                // close command removes the handle first, so the ring
                // must be dropped here (tab ids are never reused).
                self.cdp_events.forget_tab(&p.tab_id);
                self.dom.forget_tab(&p.tab_id);
                self.ax.forget_tab(&p.tab_id);
                self.pw.forget_tab(&p.tab_id);
                self.io.forget_tab(&p.tab_id);
                // Parked approval cards for a closed tab resolve as
                // "cancelled" rather than sitting until timeout.
                self.approvals.forget_tab(&p.tab_id);
                Ok(json!({ "tab_id": p.tab_id, "closed": true }))
            }
            Command::NavigateTabUrl(p) => {
                check_browser(&p.browser_id)?;
                check_navigable(&p.url)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let res = conn
                    .call(
                        "Page.navigate",
                        Some(json!({"url": &p.url})),
                        Some(&rec.cdp_session_id),
                    )
                    .await?;
                // Page.navigate answers 200-ok with an `errorText` when
                // the navigation itself failed (DNS, refused, blocked).
                if let Some(err) = res.get("errorText").and_then(Value::as_str) {
                    return Err(BrowserError::CdpFailed {
                        method: "Page.navigate".into(),
                        reason: err.to_string(),
                    });
                }
                self.settle_page(&conn, &rec.cdp_session_id, &rec.url).await;
                let rec = self.registry.lock().require(&p.tab_id)?;
                Ok(tab_json(&rec))
            }
            Command::NavigateTabBack(p) | Command::NavigateTabForward(p) => {
                let dir: i64 = matches!(cmd, Command::NavigateTabForward(_))
                    .then_some(1)
                    .unwrap_or(-1);
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let hist = conn
                    .call("Page.getNavigationHistory", None, Some(&rec.cdp_session_id))
                    .await?;
                let current = hist
                    .get("currentIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(-1);
                let target = current + dir;
                let entry = hist
                    .get("entries")
                    .and_then(Value::as_array)
                    .and_then(|e| e.get(iusize_or_zero(target)).cloned());
                // Out-of-range history is a no-op (the reference clamps
                // the same way) — answer with the untouched current tab.
                if let Some(entry_id) = entry
                    .as_ref()
                    .and_then(|e| e.get("id"))
                    .and_then(Value::as_i64)
                {
                    conn.call(
                        "Page.navigateToHistoryEntry",
                        Some(json!({"entryId": entry_id})),
                        Some(&rec.cdp_session_id),
                    )
                    .await?;
                    self.settle_page(&conn, &rec.cdp_session_id, &rec.url).await;
                }
                let rec = self.registry.lock().require(&p.tab_id)?;
                Ok(tab_json(&rec))
            }
            Command::NavigateTabReload(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                conn.call("Page.reload", Some(json!({})), Some(&rec.cdp_session_id))
                    .await?;
                self.settle_page(&conn, &rec.cdp_session_id, &rec.url).await;
                let rec = self.registry.lock().require(&p.tab_id)?;
                Ok(tab_json(&rec))
            }
            Command::TabMarkDeliverable(p) => {
                check_browser(&p.browser_id)?;
                self.registry.lock().require(&p.tab_id)?;
                self.registry.lock().mark_deliverable(key, &p.tab_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                Ok(tab_json(&rec))
            }
            Command::TabMarkHandoff(p) => {
                check_browser(&p.browser_id)?;
                self.registry.lock().require(&p.tab_id)?;
                self.registry.lock().mark_handoff(key, &p.tab_id)?;
                tracing::info!(
                    reason = ?p.reason,
                    tab_id = %p.tab_id,
                    "browser handoff marked: the turn keeps this tab open for the user"
                );
                let rec = self.registry.lock().require(&p.tab_id)?;
                Ok(tab_json(&rec))
            }
            Command::BrowserSessionName(p) => {
                check_browser(&p.browser_id)?;
                self.session_names
                    .lock()
                    .insert(key.0.clone(), p.name.clone());
                // Push the rename so the panel header (and any other
                // view of this session) reflects the name whoever set
                // it — the model, the human UI, or a later turn.
                self.ui.event(json!({
                    "type": "session_name",
                    "session_id": key.0,
                    "name": p.name,
                }));
                Ok(json!({ "session_id": key.0, "name": p.name }))
            }
            Command::TabCdpCall(p) => {
                check_browser(&p.browser_id)?;
                // Raw CDP floor — the `full_cdp_access` facet gate
                // (execute's preamble) asks/blocks per origin on top of
                // this ownership floor: a raw call can do anything a
                // structured mutation can, so the turn must own the tab
                // (created or claimed). The method is
                // sent on the tab's own flattened session — never on the
                // bare browser endpoint — so a call can't reach outside
                // the tab it was authorized for.
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let result = conn
                    .call(&p.method, p.params.clone(), Some(&rec.cdp_session_id))
                    .await?;
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "method": p.method,
                    "result": result,
                }))
            }
            Command::TabCdpEvents(p) => {
                check_browser(&p.browser_id)?;
                // Read-only replay from the Phase-4 buffer: the handle
                // must exist (stale handles fail closed); a tab nobody
                // has driven yet simply answers an empty page. Listing
                // semantics: never relaunch the browser for a read.
                let rec = self.registry.lock().require(&p.tab_id)?;
                Ok(self.cdp_events.page(&rec, p.cursor, p.limit))
            }
            Command::DomCuaGetVisibleDom(p) => {
                check_browser(&p.browser_id)?;
                // Read-only snapshot: the handle must exist (stale
                // handles fail closed after a relaunch wiped the
                // registry); never relaunch for a read.
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.dom_visible_dom(&conn, &rec).await
            }
            Command::DomCuaClick(p) | Command::DomCuaDoubleClick(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let click_count: i64 = if matches!(cmd, Command::DomCuaDoubleClick(_)) {
                    2
                } else {
                    1
                };
                self.dom_click(&conn, &rec, p.node_id, click_count).await
            }
            Command::DomCuaScroll(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.dom_scroll(&conn, &rec, p.node_id, p.x, p.y).await
            }
            Command::DomCuaType(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.dom_type(&conn, &rec, &p.text).await
            }
            Command::TabAxGetState(p) => {
                check_browser(&p.browser_id)?;
                match p.content {
                    AxStateContent::AxState => {
                        // Read-only like the visible-DOM read: the
                        // handle must exist, but the capture pipeline
                        // (H-BS-26) drives its own navigation settle,
                        // so no actable-tab gate.
                        let rec = self.registry.lock().require(&p.tab_id)?;
                        let conn = self.client().await?;
                        // H-BS-28 [adapted]: the pipeline already
                        // re-anchors candidates whose document moved
                        // mid-read, so a surfaced
                        // AxCaptureChangedBeforeCommitted means the
                        // committed-revision CAS lost a race. Bound the
                        // retry (diff disabled past attempt 0 keeps the
                        // prev anchor honest under churn) instead of
                        // looping unbounded on a flapping page.
                        for attempt in 0..3u32 {
                            match self
                                .ax
                                .capture(
                                    &conn,
                                    &rec,
                                    p.disable_diffing.unwrap_or(false) || attempt > 0,
                                )
                                .await
                            {
                                Ok(r) => {
                                    return Ok(json!({
                                        "tab_id": rec.tab_id,
                                        "document_key": r.document_key,
                                        "element_count": r.element_count,
                                        "diff": r.used_diff,
                                        "rendered": r.state,
                                    }))
                                }
                                Err(BrowserError::AxCaptureChangedBeforeCommitted)
                                    if attempt < 2 =>
                                {
                                    continue;
                                }
                                Err(e) => return Err(e),
                            }
                        }
                        Err(BrowserError::AxCaptureChangedBeforeCommitted)
                    }
                    AxStateContent::Screenshot | AxStateContent::AxStateAndScreenshot => {
                        // Phase 8: capture rides the same
                        // `Page.captureScreenshot` primitive as
                        // `playwright_element_screenshot` (viewport
                        // mode — no clip, no beyond-viewport), and the
                        // blend keeps the state capture's retry loop
                        // above. A live JS dialog makes the viewport
                        // unshottable (recovered fallback text).
                        let rec = self.registry.lock().require(&p.tab_id)?;
                        if let Some(dialog) = self.io.js_dialog(&rec.tab_id) {
                            return Err(BrowserError::ScreenshotUnavailable {
                                dialog_type: dialog.dialog_type,
                            });
                        }
                        let conn = self.client().await?;
                        let blend = matches!(p.content, AxStateContent::AxStateAndScreenshot);
                        let mut ax_state: Option<Value> = None;
                        if blend {
                            for attempt in 0..3u32 {
                                match self
                                    .ax
                                    .capture(
                                        &conn,
                                        &rec,
                                        p.disable_diffing.unwrap_or(false) || attempt > 0,
                                    )
                                    .await
                                {
                                    Ok(r) => {
                                        ax_state = Some(json!({
                                            "tab_id": rec.tab_id,
                                            "document_key": r.document_key,
                                            "element_count": r.element_count,
                                            "diff": r.used_diff,
                                            "rendered": r.state,
                                        }));
                                        break;
                                    }
                                    Err(BrowserError::AxCaptureChangedBeforeCommitted)
                                        if attempt < 2 =>
                                    {
                                        continue;
                                    }
                                    Err(e) => return Err(e),
                                }
                            }
                        }
                        let shot = self
                            .pw
                            .pw_element_screenshot(
                                &conn,
                                &rec,
                                &ScreenshotPayload {
                                    browser_id: BROWSER_ID.to_string(),
                                    tab_id: rec.tab_id.clone(),
                                    clip: None,
                                    full_page: None,
                                },
                            )
                            .await?;
                        match ax_state {
                            None => Ok(json!({
                                "tab_id": rec.tab_id,
                                "data": shot["image_base64"],
                                "mime_type": shot["mime_type"],
                            })),
                            Some(state) => {
                                let mut out = state;
                                out["data"] = shot["image_base64"].clone();
                                out["mime_type"] = shot["mime_type"].clone();
                                Ok(out)
                            }
                        }
                    }
                }
            }
            // ── Playwright-style locator runtime (Phase 7) ──────────
            // Reads require the tab handle to exist; actions obey the
            // same turn-ownership floor as the DOM-CUA mutators.
            Command::PlaywrightDomSnapshot(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_dom_snapshot(self, &conn, &rec).await
            }
            Command::PlaywrightEvaluate(p) => {
                check_browser(&p.browser_id)?;
                // Arbitrary in-page JS is a mutation: the tab must be
                // ours to drive.
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.pw.pw_evaluate(self, &conn, &rec, p).await
            }
            Command::PlaywrightElementInfo(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_element_info(&conn, &rec, p).await
            }
            Command::PlaywrightElementScreenshot(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_element_screenshot(&conn, &rec, p).await
            }
            Command::PlaywrightWaitForTimeout(p) => {
                check_browser(&p.browser_id)?;
                self.registry.lock().require(&p.tab_id)?;
                self.pw.pw_wait_for_timeout(p).await
            }
            Command::PlaywrightWaitForLoadState(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_wait_for_load_state(&conn, &rec, p).await
            }
            Command::PlaywrightWaitForUrl(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_wait_for_url(&conn, &rec, p).await
            }
            Command::PlaywrightLocatorCount(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_locator_count(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorAllTextContents(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw
                    .pw_locator_all_text_contents(self, &conn, &rec, p)
                    .await
            }
            Command::PlaywrightLocatorReadAll(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_locator_read_all(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorIsVisible(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_locator_is_visible(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorIsEnabled(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_locator_is_enabled(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorGetAttribute(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_locator_get_attribute(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorInnerText(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_locator_inner_text(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorTextContent(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_locator_text_content(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorWaitFor(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_locator_wait_for(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorClick(p) | Command::PlaywrightLocatorDblclick(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let dblclick = matches!(cmd, Command::PlaywrightLocatorDblclick(_));
                self.pw
                    .pw_locator_click(self, &conn, &rec, p, dblclick)
                    .await
            }
            Command::PlaywrightLocatorFill(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.pw.pw_locator_fill(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorPress(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.pw.pw_locator_press(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorPressSequentially(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.pw
                    .pw_locator_press_sequentially(self, &conn, &rec, p)
                    .await
            }
            Command::PlaywrightLocatorSelectOption(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.pw.pw_locator_select_option(self, &conn, &rec, p).await
            }
            Command::PlaywrightLocatorSetChecked(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.pw.pw_locator_set_checked(self, &conn, &rec, p).await
            }
            // ── Phase 8: AX actions, dialogs, screenshots, downloads,
            //    file choosers, DOM-CUA keys/media ────────────────────
            Command::TabAxAction(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                match self.tab_ax_action(&conn, &rec, p).await {
                    Ok(v) => Ok(v),
                    Err(source) => {
                        // Recovered contract: a failed AX action
                        // re-raises with the CURRENT rendered state
                        // appended, so the model re-grounds without a
                        // second round-trip. If the state re-capture
                        // itself fails (tab churn mid-action), keep the
                        // bare source error rather than lie about it.
                        let state = match self.ax.capture(&conn, &rec, true).await {
                            Ok(r) => {
                                let v = json!({
                                    "tab_id": rec.tab_id,
                                    "document_key": r.document_key,
                                    "element_count": r.element_count,
                                    "rendered": r.state,
                                });
                                serde_json::to_string(&v).unwrap_or_default()
                            }
                            Err(_) => String::new(),
                        };
                        if state.is_empty() {
                            Err(source)
                        } else {
                            Err(BrowserError::AxActionFailed {
                                source: Box::new(source),
                                state,
                            })
                        }
                    }
                }
            }
            Command::TabScreenshot(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                self.pw.pw_element_screenshot(&conn, &rec, p).await
            }
            Command::TabGetJsDialog(p) => {
                // The discovery command is never dialog-guarded: it IS
                // the escape route the guard error names.
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                Ok(json!({
                    "dialog": self.io.js_dialog(&rec.tab_id).map(|d| json!({
                        "id": d.id,
                        "type": d.dialog_type,
                        "message": d.message,
                        "prompt_text": d.prompt_text,
                        "url": d.url,
                    })),
                }))
            }
            Command::TabHandleJsDialog(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let dialog = self
                    .io
                    .js_dialog(&rec.tab_id)
                    .ok_or(BrowserError::JsDialogGone)?;
                if p.prompt_text.is_some() && dialog.dialog_type != "prompt" {
                    return Err(BrowserError::OnlyPromptAcceptsText);
                }
                let conn = self.client().await?;
                let mut params = json!({ "accept": p.accept });
                if let Some(t) = &p.prompt_text {
                    params["promptText"] = json!(t);
                }
                conn.call(
                    "Page.handleJavaScriptDialog",
                    Some(params),
                    Some(&rec.cdp_session_id),
                )
                .await?;
                self.io.take_dialog(&rec.tab_id);
                Ok(json!({}))
            }
            Command::DomCuaKeypress(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.dom_cua_keypress(&conn, &rec, &p.keys).await
            }
            Command::DomCuaDownloadMedia(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.dom_cua_download_media(&conn, &rec, p.node_id, p.timeout_ms)
                    .await
            }
            Command::PlaywrightWaitForDownload(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                // Re-assert `allowAndName` on the (possibly re-attached)
                // session before arming the wait: best-effort — the
                // attach-time call usually already holds, and the pump
                // records whatever Chromium reports either way.
                let conn = self.client().await?;
                let _ = conn
                    .call(
                        "Page.setDownloadBehavior",
                        Some(json!({
                            "behavior": "allowAndName",
                            "downloadPath": self.io.download_dir().to_string_lossy(),
                            "eventsEnabled": true,
                        })),
                        Some(&rec.cdp_session_id),
                    )
                    .await;
                let gen = self.io.download_generation(&rec.tab_id);
                let d = self
                    .io
                    .wait_for_download(&rec.tab_id, gen, p.timeout_ms.unwrap_or(30_000))
                    .await?;
                Ok(json!({
                    "download_id": d.guid,
                    "suggested_filename": d.suggested_filename,
                }))
            }
            Command::PlaywrightDownloadPath(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                // [adapted] the TabTarget payload carries no download
                // id (Ruke's one-browser-one-tab model tracks the
                // tab's LATEST completed download — the same file the
                // wait commands just armed). `path: null` honestly
                // means "no completed download on this tab yet".
                Ok(json!({
                    "path": self.io.latest_completed_download(&rec.tab_id).map(|d| d.path),
                }))
            }
            Command::PlaywrightWaitForFileChooser(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                if !self.io.chooser_intercept_enabled(&rec.tab_id) {
                    // Lazy per-tab enable: attach-time enable fired
                    // before this handle existed (and is idempotent —
                    // chooser events flow from the FIRST chooser on
                    // regardless; the mark is what keeps this command
                    // reporting the tab's own state honestly).
                    let conn = self.client().await?;
                    let ok = conn
                        .call(
                            "Page.setInterceptFileChooserDialog",
                            Some(json!({ "enabled": true })),
                            Some(&rec.cdp_session_id),
                        )
                        .await
                        .is_ok();
                    if ok {
                        self.io.mark_chooser_intercept(&rec.tab_id);
                    }
                }
                let gen = self.io.chooser_generation(&rec.tab_id);
                let c = self
                    .io
                    .wait_for_chooser(&rec.tab_id, gen, p.timeout_ms.unwrap_or(30_000))
                    .await?;
                Ok(json!({ "file_chooser_id": c.id, "is_multiple": c.is_multiple }))
            }
            Command::PlaywrightFileChooserSetFiles(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                // The pending-chooser lookup plus the recovered
                // validation chain (tab mismatch → empty files →
                // not-multiple) run before any CDP call.
                let chooser = self
                    .io
                    .latest_pending_chooser_for_tab(&p.tab_id)
                    .ok_or_else(|| BrowserError::FileChooserPendingMissing {
                        tab_id: p.tab_id.clone(),
                    })?;
                IoRegistries::validate_set_files(&p.files, &chooser, &rec.tab_id)?;
                let conn = self.client().await?;
                match chooser.backend_node_id {
                    Some(bnid) => {
                        conn.call(
                            "DOM.setFileInputFiles",
                            Some(json!({ "files": p.files, "backendNodeId": bnid })),
                            Some(&rec.cdp_session_id),
                        )
                        .await?;
                    }
                    None => {
                        // [adapted] chooser event carried no node id:
                        // the input whose activation opened the chooser
                        // is the focused element; resolve it and set
                        // files through the object id.
                        let res = conn
                            .call(
                                "Runtime.evaluate",
                                Some(json!({
                                    "expression": "document.activeElement && \
                                        document.activeElement.tagName === 'INPUT' && \
                                        document.activeElement.type === 'file' ? \
                                        document.activeElement : null",
                                    "objectGroup": "ruke-file-chooser",
                                })),
                                Some(&rec.cdp_session_id),
                            )
                            .await?;
                        let object_id = res
                            .pointer("/result/objectId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let object_id = object_id.ok_or_else(|| {
                            crate::errors::payload_invalid(
                                "playwright_file_chooser_set_files",
                                "no focused file input to receive the files",
                            )
                        })?;
                        conn.call(
                            "DOM.setFileInputFiles",
                            Some(json!({ "files": p.files, "objectId": object_id })),
                            Some(&rec.cdp_session_id),
                        )
                        .await?;
                        let _ = conn
                            .call(
                                "Runtime.releaseObjectGroup",
                                Some(json!({ "objectGroup": "ruke-file-chooser" })),
                                Some(&rec.cdp_session_id),
                            )
                            .await;
                    }
                }
                // The chooser is consumed: the OS dialog never opened
                // and the pending registry entry is retired.
                self.io.remove_chooser(&chooser.id);
                Ok(json!({}))
            }
            Command::PlaywrightLocatorDownloadMedia(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let timeout = p.timeout_ms.unwrap_or(30_000);
                // Generation captured BEFORE the trigger click: only a
                // download that begins after the click counts.
                let gen = self.io.download_generation(&rec.tab_id);
                let bnid = self
                    .pw
                    .pw_strict_one(self, &conn, &rec, &p.selector, timeout)
                    .await?;
                crate::pw::pw_scroll_into_view(&conn, &rec.cdp_session_id, bnid).await?;
                let (x, y) = crate::pw::pw_box_center(&conn, &rec.cdp_session_id, bnid)
                    .await?
                    .ok_or_else(|| BrowserError::ClickFailed {
                        element: p.selector.clone(),
                    })?;
                crate::pw::pw_dispatch_click(&conn, &rec.cdp_session_id, x, y, "left", 1, 0)
                    .await?;
                let d = self.io.wait_for_download(&rec.tab_id, gen, timeout).await?;
                let d = self.io.wait_for_download_complete(&d.guid, timeout).await?;
                Ok(json!({ "path": d.path }))
            }
            // ── Phase 9: manual takeover, bot telemetry, browser-auth ──

            // Fire-and-forget in the reference (returns void); Ruke
            // confirms the takeover it just performed. The tab flips
            // `taken_over`: every agent mutation on it fails closed
            // until the human hands it back via
            // `browser_user_claim_tab` (panel "return to agent").
            Command::TabManualHandoffRequest(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                // The handoff mark also protects the tab from turn
                // cleanup (recovered handoff-tab survival rule).
                self.registry.lock().mark_handoff(key, &p.tab_id)?;
                self.registry.lock().set_taken_over(&p.tab_id, true);
                // Whatever the agent had pending on this tab is dead:
                // parked approval cards resolve as cancelled.
                self.approvals.forget_tab(&p.tab_id);
                self.ui.event(json!({
                    "type": "tab_takeover",
                    "tab_id": rec.tab_id,
                    "reason": p.reason,
                }));
                Ok(json!({}))
            }
            // Pure telemetry (recovered contract: reporting never
            // unblocks anything). The observe facet gate already ran;
            // no ownership floor — a report is a statement, not a
            // mutation, but the handle must be live (fail closed).
            Command::TabBotDetectionReport(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let hostname = crate::authority::registrable_host(&rec.url);
                tracing::info!(
                    tab_id = %rec.tab_id,
                    reason = p.reason.as_str(),
                    hostname = hostname.as_deref().unwrap_or(""),
                    "browser_use_bot_detection_reported"
                );
                Ok(json!({ "status": "reported", "hostname": hostname }))
            }
            // The model describes the sign-in, the human supplies the
            // credentials (validator + origin floor + panel flow in
            // auth_handoff.rs; values never touch the model or logs).
            Command::TabBrowserAuthHandoff(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.tab_browser_auth_handoff(&conn, &rec, p, key).await
            }
            // ── history + browsing data (Phase 13) ──────────────────────
            // The recovered browsing-history authority verb is
            // session-wide, not per-origin, so both commands answer
            // through the browser-level History-facet gate (global "*"
            // policy row, browser-level approval card) — never the
            // tab gates in gate_for, which have no tab to key on.
            Command::BrowserHistory(p) => {
                check_browser(&p.browser_id)?;
                self.apply_global_gate(
                    key,
                    crate::authority::Facet::History,
                    "read browsing history",
                )
                .await?;
                crate::history::read_history_json(&self.root, p)
            }
            Command::BrowserClearData(p) => {
                check_browser(&p.browser_id)?;
                let types = crate::history::normalize_clear_types(p.data_types.as_ref()).map_err(
                    |reason| BrowserError::PayloadInvalid {
                        command: "browser_clear_data".into(),
                        reason,
                    },
                )?;
                self.apply_global_gate(
                    key,
                    crate::authority::Facet::History,
                    "clear browsing data",
                )
                .await?;
                let mut cleared: Vec<&'static str> = Vec::new();
                let mut skipped: Vec<Value> = Vec::new();
                // Cookies/cache live in the live browser's network
                // store: clearing them must NEVER launch Chromium just
                // to clear — try_client (not client), and an honest
                // `skipped` entry when the host is down or the store
                // refuses (never a silent success claim).
                if types.contains(&"cookies") || types.contains(&"cache") {
                    match self.try_client().await {
                        Ok(conn) => {
                            // Any live tab's session works for the
                            // browser-wide Network store; with no tabs
                            // the call goes bare against the browser
                            // endpoint and its honest failure is
                            // recorded as skipped.
                            let sid = self
                                .registry
                                .lock()
                                .list()
                                .first()
                                .map(|t| t.cdp_session_id.clone());
                            for (method, kind) in [
                                ("Network.clearBrowserCookies", "cookies"),
                                ("Network.clearBrowserCache", "cache"),
                            ] {
                                if !types.contains(&kind) {
                                    continue;
                                }
                                match conn.call(method, None, sid.as_deref()).await {
                                    Ok(_) => cleared.push(kind),
                                    Err(e) => skipped.push(json!({
                                        "type": kind,
                                        "reason": format!("{method}: {e}"),
                                    })),
                                }
                            }
                        }
                        Err(_) => {
                            for kind in ["cookies", "cache"] {
                                if types.contains(&kind) {
                                    skipped.push(json!({
                                        "type": kind,
                                        "reason": "the browser host is not running; nothing live to clear",
                                    }));
                                }
                            }
                        }
                    }
                }
                // History + download rows live in the profile's own
                // History database — the omnibox's source of truth.
                // Clearing it IS the real browser's "clear browsing
                // data", not a parallel Ruke-only store.
                //
                // Phase 26 [adapted]: the gap battery proved Chromium's
                // live session holds that database at an exclusive grade
                // (even read-only external connections stay SQLITE_BUSY
                // past 20 s), so an external DELETE can NEVER succeed
                // while the host runs. The live path therefore drives
                // Chromium's own "Clear browsing data" dialog — the
                // reference-product parity is that it clears in-process
                // through `browserSession.clearData`, never through
                // SQLite; the settings UI is Ruke's CDP-reachable form
                // of that same in-browser authority. The direct database
                // clear stays for the host-down case, where nothing
                // holds the db and it is complete and honest.
                if types.contains(&"history") || types.contains(&"downloads") {
                    let want_history = types.contains(&"history");
                    let want_downloads = types.contains(&"downloads");
                    match self.try_client().await {
                        Ok(conn) => {
                            match Self::clear_history_via_settings_ui(
                                &conn,
                                want_history,
                                want_downloads,
                            )
                            .await
                            {
                                Ok(()) => {
                                    if want_history {
                                        cleared.push("history");
                                    }
                                    if want_downloads {
                                        cleared.push("downloads");
                                    }
                                }
                                Err(reason) => {
                                    for kind in ["history", "downloads"] {
                                        let wanted = (kind == "history" && want_history)
                                            || (kind == "downloads" && want_downloads);
                                        if wanted {
                                            skipped.push(
                                                json!({ "type": kind, "reason": reason.clone() }),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        Err(_) => {
                            if want_history {
                                crate::history::clear_history_db(&self.root)?;
                                cleared.push("history");
                            }
                            if want_downloads {
                                crate::history::clear_downloads_db(&self.root)?;
                                cleared.push("downloads");
                            }
                        }
                    }
                }
                Ok(json!({
                    "browser_id": p.browser_id,
                    "cleared": cleared,
                    "skipped": skipped,
                }))
            }
            // ── Phase 14: WebMCP surface (page-declared tools) ────────
            // The shim (page_runtime.rs) is installed on every attached
            // tab. Listing enumerates metadata only — a page's handler
            // never crosses the wire. Invoking runs PAGE-DECLARED code,
            // so the `access`-facet gate (gate_for, "run a page-declared
            // model tool") asks/blocks per origin on top of the
            // ownership floor.
            Command::WebmcpListTools(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let res = conn
                    .call(
                        "Runtime.evaluate",
                        Some(json!({
                            "expression": crate::page_runtime::WEBMCP_LIST_JS,
                            "returnByValue": true,
                        })),
                        Some(&rec.cdp_session_id),
                    )
                    .await?;
                let value = res.pointer("/result/value").cloned().unwrap_or(Value::Null);
                if value
                    .get("unavailable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Err(BrowserError::WebmcpDisabled);
                }
                // A page that registers nothing is a success with an
                // empty list — "this page offers no tools" is exactly
                // the answer the model needs, not an error.
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "url": rec.url,
                    "tools": value
                        .get("tools")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                }))
            }
            Command::WebmcpInvokeTool(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let args = p.args.clone().unwrap_or_else(|| json!({}));
                let js = crate::page_runtime::webmcp_invoke_js(&p.tool, &args);
                let res = conn
                    .call(
                        "Runtime.evaluate",
                        Some(json!({
                            "expression": js,
                            "awaitPromise": true,
                            "returnByValue": true,
                        })),
                        Some(&rec.cdp_session_id),
                    )
                    .await?;
                // The page-side IIFE wraps handler throws as an
                // ok:false envelope, so exceptionDetails only fires if
                // the shim itself broke — echo that as the envelope too
                // instead of failing the whole turn.
                let value = match res.pointer("/result/value") {
                    Some(v) => v.clone(),
                    None => {
                        let reason = res
                            .pointer("/exceptionDetails/exception/description")
                            .or_else(|| res.pointer("/exceptionDetails/text"))
                            .and_then(Value::as_str)
                            .unwrap_or("the WebMCP shim raised an exception")
                            .to_string();
                        return Ok(json!({
                            "tab_id": rec.tab_id,
                            "tool": p.tool,
                            "ok": false,
                            "error": reason,
                        }));
                    }
                };
                if value.get("error").and_then(Value::as_str) == Some("not-registered") {
                    return Err(crate::errors::payload_invalid(
                        "webmcp_invoke_tool",
                        format!(
                            "this page has no WebMCP tool named {:?} (call \
                             webmcp_list_tools first)",
                            p.tool
                        ),
                    ));
                }
                if value.get("ok").and_then(Value::as_bool) != Some(true) {
                    // The page's tool answered that it refused or
                    // failed: the model sees the page's own answer, not
                    // an engine-level error.
                    return Ok(json!({
                        "tab_id": rec.tab_id,
                        "tool": p.tool,
                        "ok": false,
                        "error": value
                            .get("error")
                            .cloned()
                            .unwrap_or(json!("unknown page-side failure")),
                    }));
                }
                // Reference grammar: an executeTool result must be a
                // string or null; anything else is refused with the
                // reference's own sentence.
                let result = &value["result"];
                if !(result.is_string() || result.is_null()) {
                    return Ok(json!({
                        "tab_id": rec.tab_id,
                        "tool": p.tool,
                        "ok": false,
                        "error": "WebMCP executeTool returned an invalid result.",
                    }));
                }
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "tool": p.tool,
                    "ok": true,
                    "result": result,
                }))
            }
            // ── Phase 14: site status + submission-verified ───────────
            // Both deliberately UNGATED (gate_for answers None): they
            // read Ruke's OWN policy store / engine-observed session
            // evidence — never page content, never the network. Gating
            // a question about the policy on that policy would deadlock
            // the very UI that manages it.
            Command::SiteStatus(p) => {
                check_browser(p.browser_id.as_deref().unwrap_or(BROWSER_ID))?;
                let parsed = Self::parse_site_url(&p.url, "site_status")?;
                Ok(Self::site_status_answer(&self.authority, &parsed))
            }
            Command::SiteSubmissionVerified(p) => {
                check_browser(p.browser_id.as_deref().unwrap_or(BROWSER_ID))?;
                let parsed = Self::parse_site_url(&p.url, "site_submission_verified")?;
                let origin = crate::authority::origin_of(&parsed);
                // Honest evidence only: the origin counts verified iff
                // the pump OBSERVED a 2xx Document response on this
                // browser session — never the page claiming success,
                // never a claim persisted across browser sessions.
                let verified_at = self.submission_verified.lock().get(&origin).cloned();
                Ok(json!({
                    "url": parsed.as_str(),
                    "origin": origin,
                    "verified_at": verified_at,
                }))
            }
            // ── Phase 15: the CUA pixel-input surface ────────────────────
            // The model and the human share the same visible session;
            // these are screencast-viewport coordinates on that same
            // tab (the same pixels the panel maps human pointer events
            // onto). Locator-first stays the recommended surface — the
            // tool descriptions say so — and these arms are the raw
            // trusted-pointer path for what no locator can reach.
            Command::CuaClick(p) | Command::CuaDoubleClick(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let double = matches!(cmd, Command::CuaDoubleClick(_));
                crate::cua::cua_click(&conn, &rec, p, double).await
            }
            Command::CuaMove(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                crate::cua::cua_move(&conn, &rec, p).await
            }
            Command::CuaScroll(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                crate::cua::cua_scroll(&conn, &rec, p).await
            }
            Command::CuaDrag(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                crate::cua::cua_drag(&conn, &rec, p).await
            }
            Command::CuaType(p) => {
                // [adapted] cua_type reuses the DOM-CUA text primitive
                // (same `TextPayload` schema): one real behavior
                // serves both reference names instead of two
                // near-duplicate input stacks.
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.dom_type(&conn, &rec, &p.text).await
            }
            Command::CuaKeypress(p) => {
                // [adapted] same reuse law as cua_type (KeysPayload).
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                self.dom_cua_keypress(&conn, &rec, &p.keys).await
            }
            // ── Phase 15: clipboard (the page's own clipboard API) ──────
            // Reads are page-API reads: without focus or permission
            // the API itself refuses, and the answer carries that
            // error verbatim — never an empty-string "success".
            Command::TabClipboardRead(p) | Command::TabClipboardReadText(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                let r = crate::content_api::eval_json(
                    &conn,
                    &rec.cdp_session_id,
                    crate::content_api::CLIPBOARD_READ_JS,
                )
                .await?;
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "ok": r.get("ok").and_then(Value::as_bool).unwrap_or(false),
                    "text": r.get("text").cloned().unwrap_or(Value::Null),
                    "error": r.get("error").cloned().unwrap_or(Value::Null),
                }))
            }
            Command::TabClipboardWrite(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                let items =
                    serde_json::to_string(&p.items).map_err(|e| BrowserError::Internal {
                        detail: format!("clipboard items could not be re-serialized: {e}"),
                    })?;
                let r = crate::content_api::eval_json(
                    &conn,
                    &rec.cdp_session_id,
                    &crate::content_api::clipboard_write_js(&items),
                )
                .await?;
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "ok": r.get("ok").and_then(Value::as_bool).unwrap_or(false),
                    "written": r.get("written").and_then(Value::as_u64).unwrap_or(0),
                    "failed": r.get("failed").cloned().unwrap_or_else(|| json!([])),
                }))
            }
            Command::TabClipboardWriteText(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.actable_tab(&p.tab_id, key)?;
                let conn = self.client().await?;
                // The text convenience is the same write path with a
                // single text-only item — one behavior, two names.
                let items = json!([{"entries": [{"text": p.text}]}]).to_string();
                let r = crate::content_api::eval_json(
                    &conn,
                    &rec.cdp_session_id,
                    &crate::content_api::clipboard_write_js(&items),
                )
                .await?;
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "ok": r.get("ok").and_then(Value::as_bool).unwrap_or(false),
                    "written": r.get("written").and_then(Value::as_u64).unwrap_or(0),
                    "failed": r.get("failed").cloned().unwrap_or_else(|| json!([])),
                }))
            }
            // ── Phase 15: content export surface (in-page reads) ────────
            // Everything runs inside the tab; the exported bytes are
            // PAGE DATA — evidence, never instructions, never
            // permission. Caps and truncation flags are honest
            // counters, never silent cuts.
            Command::TabContentExport(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                let format = p.format.as_ref().unwrap_or(&ContentFormat::Text);
                let fmt_name = match format {
                    ContentFormat::Html => "html",
                    ContentFormat::Text => "text",
                    ContentFormat::DomSnapshot => "domSnapshot",
                };
                // The reference `urls` floor: the export only answers
                // when this tab's current url is among the requested
                // urls — an honest empty, never content from a tab
                // the caller didn't ask about.
                if let Some(urls) = p.urls.as_ref() {
                    if !urls.iter().any(|u| u == &rec.url) {
                        return Ok(json!({
                            "tab_id": rec.tab_id,
                            "url": rec.url,
                            "format": fmt_name,
                            "content": "",
                            "truncated": false,
                            "note": "the tab's current url is not among the requested urls",
                        }));
                    }
                }
                let r = crate::content_api::eval_json(
                    &conn,
                    &rec.cdp_session_id,
                    &crate::content_api::content_extract_js(fmt_name),
                )
                .await?;
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "url": rec.url,
                    "format": fmt_name,
                    "content": r.get("content").and_then(Value::as_str).unwrap_or(""),
                    "truncated": r.get("truncated").and_then(Value::as_bool).unwrap_or(false),
                }))
            }
            Command::TabContentExportGsuite(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let tab_url = Url::parse(&rec.url).map_err(|_| {
                    payload_invalid("tab_content_export_gsuite", "the tab url is not parseable")
                })?;
                let plan = crate::content_api::gsuite_export_plan(&tab_url, p.doc_type)
                    .map_err(|reason| payload_invalid("tab_content_export_gsuite", reason))?;
                let conn = self.client().await?;
                let r = crate::content_api::eval_json(
                    &conn,
                    &rec.cdp_session_id,
                    &crate::content_api::gsuite_fetch_js(&plan.export_url),
                )
                .await?;
                if r.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                    Ok(json!({
                        "tab_id": rec.tab_id,
                        "kind": plan.kind,
                        "export_url": plan.export_url,
                        "ok": true,
                        "mime_type": plan.mime,
                        "bytes": r.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                        "content_base64": r
                            .get("base64")
                            .cloned()
                            .unwrap_or_else(|| Value::String(String::new())),
                        "note": "served verbatim by Google's export endpoint \
                                 with the signed-in session",
                    }))
                } else {
                    Ok(json!({
                        "tab_id": rec.tab_id,
                        "export_url": plan.export_url,
                        "ok": false,
                        "error": r
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("export fetch failed"),
                    }))
                }
            }
            Command::TabContentExportYoutubeTranscript(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                // No captions / failed fetch / non-YouTube tab all
                // answer ok:true with a null transcript + note: a
                // missing transcript is a fact, not a failure.
                let r = crate::content_api::eval_json(
                    &conn,
                    &rec.cdp_session_id,
                    crate::content_api::YT_TRANSCRIPT_JS,
                )
                .await?;
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "url": rec.url,
                    "transcript": r.get("transcript").cloned().unwrap_or(Value::Null),
                    "language": r.get("language").cloned().unwrap_or(Value::Null),
                    "kind": r.get("kind").cloned().unwrap_or(Value::Null),
                    "lines": r.get("lines").and_then(Value::as_u64).unwrap_or(0),
                    "truncated": r.get("truncated").and_then(Value::as_bool).unwrap_or(false),
                    "note": r.get("note").cloned().unwrap_or(Value::Null),
                }))
            }
            // ── Phase 15: page assets (list + same-tab bundle) ──────────
            // The inventory is read from the DOM; the bundle fetches
            // from INSIDE the tab so the page's own origin rules apply
            // (never a Rust-side crawler with different rules).
            Command::TabPageAssetsList(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                let r = crate::content_api::eval_json(
                    &conn,
                    &rec.cdp_session_id,
                    crate::content_api::ASSET_COLLECT_JS,
                )
                .await?;
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "url": rec.url,
                    "assets": r.get("assets").cloned().unwrap_or_else(|| json!([])),
                    "count": r.get("count").and_then(Value::as_u64).unwrap_or(0),
                    "truncated": r.get("truncated").and_then(Value::as_bool).unwrap_or(false),
                }))
            }
            Command::TabPageAssetsBundle(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                let conn = self.client().await?;
                let listed = crate::content_api::eval_json(
                    &conn,
                    &rec.cdp_session_id,
                    crate::content_api::ASSET_COLLECT_JS,
                )
                .await?;
                let listed_assets = listed.get("assets").cloned().unwrap_or_else(|| json!([]));
                let assets_json =
                    serde_json::to_string(&listed_assets).map_err(|e| BrowserError::Internal {
                        detail: format!("asset list could not be re-serialized: {e}"),
                    })?;
                let r = crate::content_api::eval_json(
                    &conn,
                    &rec.cdp_session_id,
                    &crate::content_api::assets_bundle_js(&assets_json),
                )
                .await?;
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "base_origin": rec.url,
                    "assets": r.get("assets").cloned().unwrap_or_else(|| json!([])),
                    "total_bytes": r.get("total_bytes").and_then(Value::as_u64).unwrap_or(0),
                    "truncated": r.get("truncated").and_then(Value::as_bool).unwrap_or(false),
                }))
            }
            // ── Phase 15: dev-log mirror + engine visibility ────────────
            Command::TabDevLogs(p) => {
                check_browser(&p.browser_id)?;
                let rec = self.registry.lock().require(&p.tab_id)?;
                // No CDP call: the answer is what the pump actually
                // OBSERVED on this tab's session. A tab nobody logged
                // on answers honestly empty, never an error and never
                // an on-demand console dump the page could stage.
                let (logs, omitted) = crate::engine::filter_dev_logs(
                    &self.dev_logs,
                    &p.tab_id,
                    p.filter.as_deref(),
                    p.levels.as_deref(),
                    p.limit,
                );
                let count = logs.len();
                Ok(json!({
                    "tab_id": rec.tab_id,
                    "url": rec.url,
                    "logs": logs,
                    "count": count,
                    "omitted_older": omitted,
                }))
            }
            Command::BrowserVisibilityGet(p) => {
                check_browser(&p.browser_id)?;
                // [adapted] the reference asked its Electron window
                // manager whether the browser window was visible;
                // Ruke reports its own engine host state instead
                // (a headed launch is a real OS window). Never
                // launches for a read, and no remote visibility
                // service exists to pretend to ask.
                let (running, headless) = self.host_visibility().await;
                Ok(json!({
                    "browser_id": BROWSER_ID,
                    "running": running,
                    "visible": running && !headless,
                    "note": "reports Ruke's own engine host state (a headed \
                             launch is a real OS window); there is no remote \
                             visibility service",
                }))
            }
        }
    }

    /// Parse + scheme-floor a site-query url (Phase 14): the same
    /// http(s)-only floor navigation enforces, as a typed refusal —
    /// `javascript:`/`data:`/`ftp:` and relative junk never reach the
    /// policy lookup.
    fn parse_site_url(url: &str, command: &str) -> Result<Url, BrowserError> {
        let parsed = Url::parse(url.trim()).map_err(|_| BrowserError::PayloadInvalid {
            command: command.into(),
            reason: "url must be an absolute http(s) url".into(),
        })?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(BrowserError::PayloadInvalid {
                command: command.into(),
                reason: "url must be an absolute http(s) url".into(),
            });
        }
        Ok(parsed)
    }

    /// The site-status answer (Phase 14, CLOSED-contract adaptation):
    /// the reference consulted a remote site-status service (24 h cache,
    /// `site_status_blocked`); Ruke instead answers from the human's own
    /// saved permissions — the truth the gates actually enforce — and
    /// says so. Never a reputation score, never a remote call.
    fn site_status_answer(authority: &crate::authority::AuthorityStore, parsed: &Url) -> Value {
        use crate::authority::Facet;
        let full = parsed.as_str();
        let host = crate::authority::registrable_host(full)
            .unwrap_or_else(|| parsed.host_str().unwrap_or("").to_string());
        let permissions = json!({
            "access": authority.decision(&host, Facet::Access).as_str(),
            "uploads": authority.decision(&host, Facet::Uploads).as_str(),
            "downloads": authority.decision(&host, Facet::Downloads).as_str(),
            "full_cdp_access": authority.decision(&host, Facet::FullCdpAccess).as_str(),
            // History is browser-level: its rule lives on the global
            // "*" row, exactly where the gate reads it.
            "history": authority.decision("*", Facet::History).as_str(),
        });
        json!({
            "url": full,
            "host": host,
            "permissions": permissions,
            "note": "site status reflects the permissions you saved in Ruke \
                     (with the access-deny floor applied); there is no \
                     remote site-status service and no reputation score.",
        })
    }

    /// Shared-tab floor: the tab must exist (stale handles fail closed)
    /// and this turn must own it (created it, or claimed it via
    /// `browser_user_claim_tab`).
    fn actable_tab(&self, tab_id: &str, key: &TurnKey) -> Result<TabRecord, BrowserError> {
        let rec = self.registry.lock().require(tab_id)?;
        if !self.registry.lock().can_act_on(tab_id, key) {
            return Err(BrowserError::CapabilityBlocked {
                reason: format!(
                    "tab {tab_id} belongs to the user; act only after an explicit \
                     browser_user_claim_tab (the agent may only touch tabs it created or claimed)"
                ),
            });
        }
        Ok(rec)
    }

    /// Wait for the navigation to LAND, then poll
    /// `document.readyState == "complete"`, then refresh the registry row
    /// from the page itself. `before_url` anchors "the document actually
    /// changed": an href differing from the pre-navigation URL, or a
    /// `loading` sighting after the first poll (reload / same-URL history
    /// entries keep the href identical), proves the new document
    /// committed. Without that gate the very first poll can read the OLD
    /// already-complete document and settle instantly on stale state —
    /// including Chromium's provisional address-as-title placeholder.
    ///
    /// The two post-poll reads are best-effort *only* because the
    /// lifecycle pump carries the same fields if a slower navigation
    /// lands after the budget closes; they are never how success is
    /// decided.
    async fn settle_page(&self, conn: &CdpConn, cdp_session_id: &str, before_url: &str) {
        let deadline = Instant::now() + SETTLE_BUDGET;
        let mut first = true;
        let mut swapped = false;
        loop {
            let href = Self::eval_string(conn, cdp_session_id, "location.href")
                .await
                .ok()
                .flatten();
            let ready = Self::eval_string(conn, cdp_session_id, "document.readyState")
                .await
                .ok()
                .flatten();
            if !first && !matches!(ready.as_deref(), Some("complete")) {
                swapped = true;
            }
            if (href.as_deref().is_some_and(|h| h != before_url) || swapped)
                && matches!(ready.as_deref(), Some("complete"))
            {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            first = false;
            tokio::time::sleep(SETTLE_TICK).await;
        }
        let url = Self::eval_string(conn, cdp_session_id, "location.href")
            .await
            .ok()
            .flatten();
        let title = Self::eval_string(conn, cdp_session_id, "document.title")
            .await
            .ok()
            .flatten();
        self.registry
            .lock()
            .update_by_session(cdp_session_id, url.as_deref(), title.as_deref());
    }

    /// Evaluate an expression whose value must be a string; a JS-side
    /// throw is a real CdpFailed (not a silent empty read). Also used by
    /// the lifecycle pump for authoritative post-load reads.
    pub(crate) async fn eval_string(
        conn: &CdpConn,
        cdp_session_id: &str,
        expression: &str,
    ) -> Result<Option<String>, BrowserError> {
        let res = conn
            .call(
                "Runtime.evaluate",
                Some(json!({"expression": expression, "returnByValue": true})),
                Some(cdp_session_id),
            )
            .await?;
        if res.get("exceptionDetails").is_some() {
            let reason = res
                .pointer("/exceptionDetails/exception/description")
                .or_else(|| res.pointer("/exceptionDetails/exception/value"))
                .or_else(|| res.pointer("/exceptionDetails/text"))
                .and_then(Value::as_str)
                .unwrap_or("page script raised an exception")
                .to_string();
            return Err(BrowserError::CdpFailed {
                method: "Runtime.evaluate".into(),
                reason,
            });
        }
        // `CdpConn::call` already unwrapped the wire frame's outer
        // `result` (see cdp.rs route_frame); the Runtime.evaluate command
        // result nests its RemoteObject under `result`, so the value path
        // is `result.value` — an extra level here silently reads None and
        // every settle read would come back empty (real-Chromium smoke
        // caught this: pages read fine, registry rows stayed title-less).
        Ok(res
            .pointer("/result/value")
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    /// Live-host history/download-history clear (Phase 26): open a
    /// transient `chrome://settings/clearBrowserData` target (the
    /// deep link auto-opens the Clear-browsing-data dialog), attach
    /// to it, run [`crate::history::clear_dialog_js`], then close
    /// the tab — the CDP grammar mirrors the `tab_new`/`tab_close`
    /// arms. The browser-level `Target.createTarget` carries no
    /// `openerId`, so the pump's popup-adoption arm ignores it and
    /// the tab never enters the registry: `tabs`, `get_tab`, and the
    /// panel strip never see it (a human watching the physical
    /// window may see the tab flash). A raw `Target.attachToTarget`
    /// is deliberate: it keeps the page-runtime bootstrap scripts
    /// out of a chrome:// settings page.
    ///
    /// The transient chrome:// target is an engine-initiated
    /// privileged drive authorized by the `Facet::History` gate every
    /// `browser_clear_data` has already passed; the navigate
    /// command's http(s)-only URL law is a model-facing contract and
    /// stays fully in force — no command payload can produce this
    /// navigation, the URL is a compile-time constant here.
    ///
    /// Every CDP call in the drive is one short synchronous evaluate:
    /// the appear-wait and close-wait loops live HERE, on the Rust
    /// side, so no single call ever runs near the socket round-trip
    /// ceiling (`cdp::CALL_TIMEOUT`) — the codebase's established
    /// law for long browser waits (same shape as the locator
    /// wait-for pollers). Ok only when the dialog itself closed,
    /// i.e. Chromium accepted the deletion; every failure returns the
    /// honest reason the caller records in the answer's `skipped`
    /// entries.
    async fn clear_history_via_settings_ui(
        conn: &CdpConn,
        want_history: bool,
        want_downloads: bool,
    ) -> Result<(), String> {
        let opened = conn
            .call(
                "Target.createTarget",
                Some(json!({"url": "chrome://settings/clearBrowserData"})),
                None,
            )
            .await
            .map_err(|e| format!("Target.createTarget: {e}"))?;
        let target_id = opened
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Target.createTarget returned no targetId".to_string())?
            .to_string();
        let session = conn
            .call(
                "Target.attachToTarget",
                Some(json!({"targetId": &target_id, "flatten": true})),
                None,
            )
            .await
            .map_err(|e| format!("Target.attachToTarget: {e}"))?
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Target.attachToTarget returned no sessionId".to_string())?;

        // The drive runs between open and close; the tab is closed
        // FIRST regardless of how the drive ends, so a failed or
        // wedged drive never leaves a settings tab in the user's
        // window.
        let drive = async {
            // 1. Wait for the deep link's dialog to render (the
            //    settings bundle boots first).
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                if Self::eval_clear_probe(conn, &session).await? {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err("settings clear dialog never opened".into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
            // 2. Set the selection exactly as authorized and click
            //    the dialog's own confirm button.
            let setup = Self::eval_clear_value(
                conn,
                &session,
                &crate::history::clear_setup_js(want_history, want_downloads),
            )
            .await?;
            let status = setup
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("no-status");
            if status != "clicked" {
                return Err(format!("settings clear drive: {setup}"));
            }
            // 3. The dialog closing IS Chromium's own acceptance of
            //    the deletion; the history service commits the
            //    DELETEs synchronously enough for the panel-visible
            //    omnibox rows to drop right after. 20 s covers the
            //    chromium-side spinner phase (the dialog stays open
            //    while `$.spinner` runs) without ever putting a
            //    single long call on the socket.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                if !Self::eval_clear_probe(conn, &session).await? {
                    return Ok(());
                }
                if std::time::Instant::now() >= deadline {
                    return Err("confirm click did not close the settings clear dialog".into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        }
        .await;
        let closed = conn
            .call(
                "Target.closeTarget",
                Some(json!({"targetId": &target_id})),
                None,
            )
            .await;
        drive?;
        closed.map_err(|e| format!("Target.closeTarget: {e}"))?;
        Ok(())
    }

    /// One evaluate of a clear-dialog script; a JS-side throw is an
    /// honest drive failure, never a silent miss. `awaitPromise`
    /// carries the setup script's async body (the one settle tick it
    /// waits after opening the time-range More menu); plain probe
    /// values pass through it unchanged. Every script still finishes
    /// in well under a second, nowhere near `cdp::CALL_TIMEOUT`.
    async fn eval_clear_value(
        conn: &CdpConn,
        session: &str,
        expression: &str,
    ) -> Result<Value, String> {
        let res = conn
            .call(
                "Runtime.evaluate",
                Some(
                    json!({"expression": expression, "returnByValue": true, "awaitPromise": true}),
                ),
                Some(session),
            )
            .await
            .map_err(|e| format!("Runtime.evaluate: {e}"))?;
        if let Some(ex) = res.get("exceptionDetails") {
            return Err(format!("clear dialog script: {ex}"));
        }
        Ok(res.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }

    /// One dialog-presence probe ('present' / 'absent').
    async fn eval_clear_probe(conn: &CdpConn, session: &str) -> Result<bool, String> {
        let v = Self::eval_clear_value(conn, session, &crate::history::clear_probe_js()).await?;
        match v.as_str() {
            Some("present") => Ok(true),
            Some("absent") => Ok(false),
            _ => Err(format!("clear dialog probe returned {v}")),
        }
    }
}

/// Command-level dialog-guard scope (the recovered
/// `throwIfJsDialogBlocksMethod` table, Ruke command names): the tab
/// whose dialog must be checked, for page-mutating and
/// input-surfacing commands. Anything not matched is exempt — the
/// JS-dialog pair (the guard error names it as the dismissal route),
/// lifecycle/discovery reads (`tabs`/`get_tab`/`tab_new`/`tab_close`/
/// the claim pair/`tab_cdp_events`), pure state snapshots
/// (`dom_cua_get_visible_dom`, `playwright_dom_snapshot`,
/// `tab_ax_get_state` — its screenshot mode raises the dedicated
/// `screenshot_unavailable` contract instead), and the download /
/// file-chooser wait + resolve commands (legitimately armed BEFORE a
/// dialog opens; they must stay serviceable while one is up, and they
/// touch no page input). The raw bridge guards every method EXCEPT
/// `Page.handleJavaScriptDialog` — otherwise the model could dismiss
/// through `tab_cdp_call` while the purpose-built command stayed
/// blocked.
fn guarded_tab_id(cmd: &Command) -> Option<String> {
    match cmd {
        Command::NavigateTabUrl(p) => Some(p.tab_id.clone()),
        Command::NavigateTabBack(p) => Some(p.tab_id.clone()),
        Command::NavigateTabForward(p) => Some(p.tab_id.clone()),
        Command::NavigateTabReload(p) => Some(p.tab_id.clone()),
        // Raw-bridge escape hatch exemption (see docs above).
        Command::TabCdpCall(p) if p.method != "Page.handleJavaScriptDialog" => {
            Some(p.tab_id.clone())
        }
        Command::DomCuaClick(p) => Some(p.tab_id.clone()),
        Command::DomCuaDoubleClick(p) => Some(p.tab_id.clone()),
        Command::DomCuaScroll(p) => Some(p.tab_id.clone()),
        Command::DomCuaType(p) => Some(p.tab_id.clone()),
        Command::DomCuaKeypress(p) => Some(p.tab_id.clone()),
        Command::DomCuaDownloadMedia(p) => Some(p.tab_id.clone()),
        Command::TabScreenshot(p) => Some(p.tab_id.clone()),
        Command::TabAxAction(p) => Some(p.tab_id.clone()),
        Command::PlaywrightEvaluate(p) => Some(p.tab_id.clone()),
        Command::PlaywrightElementInfo(p) => Some(p.tab_id.clone()),
        Command::PlaywrightElementScreenshot(p) => Some(p.tab_id.clone()),
        Command::PlaywrightWaitForLoadState(p) => Some(p.tab_id.clone()),
        Command::PlaywrightWaitForUrl(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorCount(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorAllTextContents(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorReadAll(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorIsVisible(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorIsEnabled(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorGetAttribute(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorInnerText(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorTextContent(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorWaitFor(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorClick(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorDblclick(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorFill(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorPress(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorPressSequentially(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorSelectOption(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorSetChecked(p) => Some(p.tab_id.clone()),
        Command::PlaywrightLocatorDownloadMedia(p) => Some(p.tab_id.clone()),
        // Phase 15: CUA input drives the page directly — it queues
        // behind a parked dialog like every other page mutation.
        Command::CuaClick(p) => Some(p.tab_id.clone()),
        Command::CuaDoubleClick(p) => Some(p.tab_id.clone()),
        Command::CuaDrag(p) => Some(p.tab_id.clone()),
        Command::CuaKeypress(p) => Some(p.tab_id.clone()),
        Command::CuaMove(p) => Some(p.tab_id.clone()),
        Command::CuaScroll(p) => Some(p.tab_id.clone()),
        Command::CuaType(p) => Some(p.tab_id.clone()),
        // Clipboard writes run page script (navigator.clipboard) —
        // they must not queue past a parked dialog either.
        Command::TabClipboardWrite(p) => Some(p.tab_id.clone()),
        Command::TabClipboardWriteText(p) => Some(p.tab_id.clone()),
        _ => None,
    }
}

/// History indices are non-negative; `as usize` after a clamp keeps the
/// lookup total (a negative `currentIndex` can only come from a weird
/// engine answer, and then no entry resolves → the no-op branch).
fn iusize_or_zero(v: i64) -> usize {
    usize::try_from(v).unwrap_or(usize::MAX)
}

/// One Ruke agent browser exists ("default"); a wrong `browser_id` is a
/// typed capability refusal, mirroring the reference's "no such browser"
/// stance rather than silently ignoring the field.
fn check_browser(browser_id: &str) -> Result<(), BrowserError> {
    if browser_id == BROWSER_ID {
        return Ok(());
    }
    Err(BrowserError::CapabilityBlocked {
        reason: format!(
            "unknown browser_id {browser_id:?}: Ruke exposes a single agent browser \
             ({BROWSER_ID:?}) plus the user's own browser tabs"
        ),
    })
}

/// Baseline navigation floor: `http(s)` and `about:blank` only — never
/// `file:`, `data:`, `javascript:`, or anything that could reach the
/// local filesystem or inject script through a URL. The per-origin
/// `access` facet (`authority::gate_for`) layers on top of this: a
/// denied or never-yet-approved origin refuses or parks an approval
/// card before this floor is even consulted.
fn check_navigable(url: &str) -> Result<(), BrowserError> {
    if url == "about:blank" {
        return Ok(());
    }
    match Url::parse(url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => Ok(()),
        _ => Err(BrowserError::InvalidUrl {
            url: url.to_string(),
        }),
    }
}

/// Model-facing tab shape: the handles (`tab_id`) plus what the tab
/// actually *is* right now (live url/title from the pump + settle
/// reads), plus the ownership bit the model needs to decide whether to
/// claim. CDP `targetId`s are deliberately never model-visible — the
/// registry handle is the stable contract (stale-handle semantics live
/// in `browser_context_unavailable`).
pub(crate) fn tab_json(rec: &TabRecord) -> Value {
    json!({
        "tab_id": rec.tab_id,
        "url": rec.url,
        "title": rec.title,
        "created_by_agent": rec.created_by_turn.is_some(),
        // Phase 9: the manual-handoff lock rides the row itself so a
        // (re)connected panel paints the "handed to you" banner from
        // the snapshot alone, without replaying the takeover event.
        "taken_over": rec.taken_over,
    })
}
