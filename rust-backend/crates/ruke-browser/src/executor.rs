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
//! `playwright_locator_download_media` — all execute for real; every
//! other registered command kind answers `Unsupported { operation }`
//! — an honest typed error, never a fake success. Later phases
//! (security, tool loop, UI…) replace arm-by-arm as they land; the
//! registry itself (82 rows) was already pinned in Phase 1.
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
use crate::errors::BrowserError;
use crate::io_state::IoRegistries;
use crate::schemas::{AxStateContent, ScreenshotPayload};
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
            // Honest increment: implemented above; everything else is a
            // typed Unsupported until its phase lands (never a stub that
            // pretends to have driven a page).
            other => Err(BrowserError::Unsupported {
                operation: other.kind().as_str().to_string(),
            }),
        }
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
