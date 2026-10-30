//! executor.rs — the Phase-2 command executor: the first increment of the
//! engine that turns decoded [`Command`]s into real CDP effects through
//! [`BrowserRuntime`]. Every result is grounded in actual browser state
//! (the registry, kept live by the lifecycle pump, plus authoritative
//! `document`/`location` reads after each navigation) — never a text
//! echo of intent.
//!
//! Increment policy (pinned for the Phase-26 coverage audit): the 13
//! lifecycle commands implemented here execute for real; every other
//! registered command kind answers `Unsupported { operation }` — an
//! honest typed error, never a fake success. Later phases (DOM/AX,
//! input, dialogs, files, CDP buffer…) replace arm-by-arm; the registry
//! itself (82 rows) was already pinned in Phase 1.
//!
//! Security floor until Phase 9 layers the full authority model:
//! navigation is restricted to `http(s)` and `about:blank` — `file:`,
//! `data:` and `javascript:` URLs are refused outright — and the agent
//! may only *mutate* tabs it created or that were explicitly claimed via
//! `browser_user_claim_tab` (the shared-session handoff rule).

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use url::Url;

use crate::cdp::CdpConn;
use crate::contract::Command;
use crate::engine::{BrowserRuntime, BROWSER_ID};
use crate::errors::BrowserError;
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
                let session_id = Self::attach_target(&conn, &target_id).await?;
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

/// Baseline navigation floor (full origin authority arrives in Phase 9):
/// `http(s)` and `about:blank` only — never `file:`, `data:`, `javascript:`,
/// or anything that could reach the local filesystem or inject script
/// through a URL.
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
    })
}
