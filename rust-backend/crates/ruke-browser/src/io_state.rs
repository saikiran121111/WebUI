//! io_state.rs — Phase-8 per-tab I/O registries: JavaScript dialogs,
//! intercepted file choosers, and downloads.
//!
//! The dialog registry mirrors the recovered `jsDialogsByTabId` tail
//! verbatim in behavior (schemas-and-ipc.md §"JS dialog CDP class"):
//! `Page.javascriptDialogOpening` remembers `{id,message,promptText,
//! type,target,url}` with incrementing string ids; `beforeunload` is
//! auto-accepted by the pump AFTER remembering; `Page.javascriptDialogClosed`
//! deletes. The chooser registry mirrors the `fileChoosersById` entry
//! shape the recovered `r2` handler consumes (`{tabId,isMultiple,
//! backendNodeId}` plus the id).
//!
//! `[adapted]` (not in the recovered bundle — CDP ingestion for these
//! events is absent from the extracted docs): interception is enabled
//! with `Page.setInterceptFileChooserDialog` and downloads captured with
//! `Page.setDownloadBehavior {behavior:"allowAndName", eventsEnabled:
//! true}` on each tab's flattened session, so per-tab attribution comes
//! free from the session-scoped events. Files land under
//! `<root>/downloads/<guid>`; `playwright_download_path` (TabTarget —
//! Ruke's registry carries no download_id) answers the tab's most recent
//! COMPLETED download path.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::Value;

use crate::errors::BrowserError;

/// Poll cadence for the wait primitives (matches the locator runtime).
const POLL_MS: u64 = 100;

/// One active JavaScript dialog on a tab (recovered entry shape).
#[derive(Clone, Debug)]
pub(crate) struct JsDialog {
    pub id: String,
    pub message: String,
    pub prompt_text: Option<String>,
    pub dialog_type: String,
    pub url: Option<String>,
}

/// One intercepted file chooser awaiting `set_files`.
#[derive(Clone, Debug)]
pub(crate) struct FileChooser {
    pub id: String,
    pub tab_id: String,
    // Recorded from the chooser event for frame-scoped chooser
    // attribution; the set_files path addresses by tab + pending
    // position today, so the field is forensic until frame targeting.
    #[allow(dead_code)]
    pub frame_id: String,
    pub is_multiple: bool,
    pub backend_node_id: Option<i64>,
}

/// One observed download (`allowAndName` stores it at `path`).
#[derive(Clone, Debug)]
pub(crate) struct Download {
    pub guid: String,
    // Download origin, kept for forensics/logging; the wait/path
    // surfaces address downloads by guid + tab, not origin.
    #[allow(dead_code)]
    pub url: String,
    pub suggested_filename: String,
    pub state: String,
    pub path: String,
}

#[derive(Default)]
struct Inner {
    seq: u64,
    dialogs: HashMap<String, JsDialog>,
    /// Bumped on every dialog open/close — the "dialog appeared during
    /// this action" detector (the recovered `tl` race's Ruke stand-in).
    dialog_gen: HashMap<String, u64>,
    /// Last closed dialog per tab: the interrupt message detail must
    /// survive long enough for the action that raced it to report.
    last_closed: HashMap<String, JsDialog>,
    chooser_intercept_on: HashMap<String, bool>,
    choosers: Vec<FileChooser>,
    chooser_gen: HashMap<String, u64>,
    downloads: HashMap<String, Vec<Download>>,
    download_gen: HashMap<String, u64>,
}

pub(crate) struct IoRegistries {
    download_dir: PathBuf,
    inner: Mutex<Inner>,
}

impl IoRegistries {
    pub(crate) fn new(download_dir: PathBuf) -> Self {
        Self {
            download_dir,
            inner: Mutex::new(Inner::default()),
        }
    }

    pub(crate) fn download_dir(&self) -> &PathBuf {
        &self.download_dir
    }

    fn next_id(&self, inner: &mut Inner) -> String {
        inner.seq += 1;
        // Recovered rule: dialog ids are an incrementing sequence minted
        // as strings.
        inner.seq.to_string()
    }

    // ── JavaScript dialogs ─────────────────────────────────────────────

    pub(crate) fn on_dialog_open(&self, tab_id: &str, params: &Value) -> JsDialog {
        let mut inner = self.inner.lock();
        let id = self.next_id(&mut inner);
        let dialog = JsDialog {
            id,
            message: params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            prompt_text: params
                .get("defaultPrompt")
                .and_then(Value::as_str)
                .map(str::to_string),
            dialog_type: params
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("alert")
                .to_string(),
            url: params
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string),
        };
        // One active dialog per tab at most (a modal JS dialog blocks the
        // renderer, so a second opening cannot predate the first close).
        inner.dialogs.insert(tab_id.to_string(), dialog.clone());
        *inner.dialog_gen.entry(tab_id.to_string()).or_insert(0) += 1;
        dialog
    }

    pub(crate) fn on_dialog_closed(&self, tab_id: &str) {
        let mut inner = self.inner.lock();
        if let Some(closed) = inner.dialogs.remove(tab_id) {
            inner.last_closed.insert(tab_id.to_string(), closed);
        }
        *inner.dialog_gen.entry(tab_id.to_string()).or_insert(0) += 1;
    }

    /// Remove the dialog after `tab_handle_js_dialog` succeeded (the
    /// `javascriptDialogClosed` event will also arrive; removal is
    /// idempotent).
    pub(crate) fn take_dialog(&self, tab_id: &str) -> Option<JsDialog> {
        let mut inner = self.inner.lock();
        let taken = inner.dialogs.remove(tab_id);
        if taken.is_some() {
            *inner.dialog_gen.entry(tab_id.to_string()).or_insert(0) += 1;
        }
        taken
    }

    pub(crate) fn js_dialog(&self, tab_id: &str) -> Option<JsDialog> {
        self.inner.lock().dialogs.get(tab_id).cloned()
    }

    pub(crate) fn dialog_generation(&self, tab_id: &str) -> u64 {
        *self.inner.lock().dialog_gen.get(tab_id).unwrap_or(&0)
    }

    /// The dialog to name in a `JsDialogInterrupted` message: still-open
    /// first, else the most recently closed one.
    pub(crate) fn interrupt_dialog(&self, tab_id: &str) -> Option<JsDialog> {
        let inner = self.inner.lock();
        inner
            .dialogs
            .get(tab_id)
            .or_else(|| inner.last_closed.get(tab_id))
            .cloned()
    }

    // ── File choosers ──────────────────────────────────────────────────

    pub(crate) fn on_file_chooser_opened(&self, tab_id: &str, params: &Value) -> FileChooser {
        let mut inner = self.inner.lock();
        let id = self.next_id(&mut inner);
        let chooser = FileChooser {
            id,
            tab_id: tab_id.to_string(),
            frame_id: params
                .get("frameId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            // `mode` "selectMultiple" ⇒ multi; anything else single
            // (CDP Page.fileChooserOpened mode grammar).
            is_multiple: params
                .get("mode")
                .and_then(Value::as_str)
                .is_some_and(|m| m.eq_ignore_ascii_case("selectMultiple")),
            // Present on modern Chromium's Page.fileChooserOpened; the
            // set_files path falls back to the focused input when not.
            backend_node_id: params.get("backendNodeId").and_then(Value::as_i64),
        };
        inner.choosers.push(chooser.clone());
        *inner.chooser_gen.entry(tab_id.to_string()).or_insert(0) += 1;
        chooser
    }

    pub(crate) fn chooser_intercept_enabled(&self, tab_id: &str) -> bool {
        *self
            .inner
            .lock()
            .chooser_intercept_on
            .get(tab_id)
            .unwrap_or(&false)
    }

    pub(crate) fn mark_chooser_intercept(&self, tab_id: &str) {
        self.inner
            .lock()
            .chooser_intercept_on
            .insert(tab_id.to_string(), true);
    }

    pub(crate) fn chooser_generation(&self, tab_id: &str) -> u64 {
        *self.inner.lock().chooser_gen.get(tab_id).unwrap_or(&0)
    }

    /// Direct id lookup. The Ruke `set_files` wire carries no chooser
    /// id (it addresses the tab's latest pending chooser), so this is
    /// reserved for the `FileChooserUnknown` diagnostic path.
    #[allow(dead_code)]
    pub(crate) fn chooser(&self, file_chooser_id: &str) -> Option<FileChooser> {
        self.inner
            .lock()
            .choosers
            .iter()
            .find(|c| c.id == file_chooser_id)
            .cloned()
    }

    /// The most recent still-pending chooser on the tab — the target
    /// of Ruke's id-less `playwright_file_chooser_set_files` (the
    /// pump's `Page.fileChooserOpened` arm and `remove_chooser` keep
    /// the pending set live).
    pub(crate) fn latest_pending_chooser_for_tab(&self, tab_id: &str) -> Option<FileChooser> {
        self.inner
            .lock()
            .choosers
            .iter()
            .rev()
            .find(|c| c.tab_id == tab_id)
            .cloned()
    }

    pub(crate) fn remove_chooser(&self, file_chooser_id: &str) {
        let mut inner = self.inner.lock();
        inner.choosers.retain(|c| c.id != file_chooser_id);
    }

    /// Wait for the NEXT chooser opened on the tab after `since_gen`.
    pub(crate) async fn wait_for_chooser(
        &self,
        tab_id: &str,
        since_gen: u64,
        timeout_ms: u64,
    ) -> Result<FileChooser, BrowserError> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if self.chooser_generation(tab_id) != since_gen {
                if let Some(chooser) = self
                    .inner
                    .lock()
                    .choosers
                    .iter()
                    .rev()
                    .find(|c| c.tab_id == tab_id)
                    .cloned()
                {
                    return Ok(chooser);
                }
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::PwTimeout {
                    what: "a file chooser".to_string(),
                    timeout_ms,
                });
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }
    }

    /// The recovered `r2` validation chain, pinned order and wording:
    /// unknown id (caller), tab mismatch, empty files, multi mismatch.
    pub(crate) fn validate_set_files(
        files: &[String],
        chooser: &FileChooser,
        tab_id: &str,
    ) -> Result<(), BrowserError> {
        if chooser.tab_id != tab_id {
            return Err(BrowserError::FileChooserTabMismatch {
                file_chooser_id: chooser.id.clone(),
                actual_tab_id: chooser.tab_id.clone(),
            });
        }
        if files.is_empty() {
            return Err(BrowserError::FileChooserNoFiles);
        }
        if !chooser.is_multiple && files.len() > 1 {
            return Err(BrowserError::FileChooserNotMultiple);
        }
        Ok(())
    }

    // ── Downloads ──────────────────────────────────────────────────────

    pub(crate) fn on_download_begin(&self, tab_id: &str, params: &Value) {
        let guid = params
            .get("guid")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if guid.is_empty() {
            return;
        }
        let path = self.download_dir.join(&guid).to_string_lossy().to_string();
        let mut inner = self.inner.lock();
        let entry = Download {
            guid: guid.clone(),
            url: params
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            suggested_filename: params
                .get("suggestedFilename")
                .and_then(Value::as_str)
                .unwrap_or(&guid)
                .to_string(),
            state: "in_progress".to_string(),
            path,
        };
        inner
            .downloads
            .entry(tab_id.to_string())
            .or_default()
            .push(entry);
        *inner.download_gen.entry(tab_id.to_string()).or_insert(0) += 1;
    }

    pub(crate) fn on_download_progress(&self, tab_id: &str, params: &Value) {
        let guid = params.get("guid").and_then(Value::as_str).unwrap_or("");
        let state = params.get("state").and_then(Value::as_str).unwrap_or("");
        let mut inner = self.inner.lock();
        if let Some(list) = inner.downloads.get_mut(tab_id) {
            if let Some(d) = list.iter_mut().find(|d| d.guid == guid) {
                if !state.is_empty() {
                    d.state = state.to_string();
                }
            }
        }
    }

    pub(crate) fn download_generation(&self, tab_id: &str) -> u64 {
        *self.inner.lock().download_gen.get(tab_id).unwrap_or(&0)
    }

    pub(crate) fn latest_download(&self, tab_id: &str) -> Option<Download> {
        self.inner
            .lock()
            .downloads
            .get(tab_id)
            .and_then(|l| l.last())
            .cloned()
    }

    pub(crate) fn latest_completed_download(&self, tab_id: &str) -> Option<Download> {
        self.inner
            .lock()
            .downloads
            .get(tab_id)
            .and_then(|l| l.iter().rev().find(|d| d.state == "completed"))
            .cloned()
    }

    pub(crate) fn download_state(&self, guid: &str) -> Option<String> {
        let inner = self.inner.lock();
        inner
            .downloads
            .values()
            .flatten()
            .find(|d| d.guid == guid)
            .map(|d| d.state.clone())
    }

    /// Wait for the NEXT download begun on the tab after `since_gen`.
    pub(crate) async fn wait_for_download(
        &self,
        tab_id: &str,
        since_gen: u64,
        timeout_ms: u64,
    ) -> Result<Download, BrowserError> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if self.download_generation(tab_id) != since_gen {
                if let Some(d) = self.latest_download(tab_id) {
                    return Ok(d);
                }
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::PwTimeout {
                    what: "a download".to_string(),
                    timeout_ms,
                });
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }
    }

    /// Wait for an already-begun download to leave `in_progress`.
    pub(crate) async fn wait_for_download_complete(
        &self,
        guid: &str,
        timeout_ms: u64,
    ) -> Result<Download, BrowserError> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            match self.download_state(guid).as_deref() {
                Some("completed") | Some("canceled") => {
                    if let Some(d) = self.download_by_guid(guid) {
                        return Ok(d);
                    }
                    break;
                }
                Some(_) => {}
                None => break,
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::PwTimeout {
                    what: "a download to complete".to_string(),
                    timeout_ms,
                });
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }
        Err(BrowserError::PwTimeout {
            what: "a download to complete".to_string(),
            timeout_ms,
        })
    }

    fn download_by_guid(&self, guid: &str) -> Option<Download> {
        let inner = self.inner.lock();
        inner
            .downloads
            .values()
            .flatten()
            .find(|d| d.guid == guid)
            .cloned()
    }

    // ── Lifetime ───────────────────────────────────────────────────────

    pub(crate) fn forget_tab(&self, tab_id: &str) {
        let mut inner = self.inner.lock();
        inner.dialogs.remove(tab_id);
        inner.dialog_gen.remove(tab_id);
        inner.last_closed.remove(tab_id);
        inner.chooser_intercept_on.remove(tab_id);
        inner.chooser_gen.remove(tab_id);
        inner.choosers.retain(|c| c.tab_id != tab_id);
        inner.downloads.remove(tab_id);
        inner.download_gen.remove(tab_id);
    }

    pub(crate) fn clear_all(&self) {
        *self.inner.lock() = Inner::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn io() -> IoRegistries {
        IoRegistries::new(PathBuf::from("downloads"))
    }

    #[test]
    fn dialog_open_remember_close_sequence() {
        let r = io();
        let d = r.on_dialog_open(
            "1",
            &json!({"message": "Leave?", "defaultPrompt": "", "type": "confirm", "url": "https://x.test"}),
        );
        assert_eq!(d.id, "1");
        assert_eq!(r.js_dialog("1").unwrap().dialog_type, "confirm");
        assert!(r.js_dialog("2").is_none());
        let gen_after_open = r.dialog_generation("1");
        r.on_dialog_closed("1");
        assert!(r.js_dialog("1").is_none());
        assert!(r.dialog_generation("1") > gen_after_open);
        // The closed dialog is what an interrupted action quotes.
        assert_eq!(r.interrupt_dialog("1").unwrap().message, "Leave?");
    }

    #[test]
    fn dialog_ids_are_incrementing_strings_across_kinds() {
        let r = io();
        let a = r.on_dialog_open("1", &json!({"type": "alert", "message": "a"}));
        r.on_dialog_closed("1");
        let b = r.on_file_chooser_opened("2", &json!({"mode": "selectSingle", "frameId": "f"}));
        let c = r.on_dialog_open(
            "1",
            &json!({"type": "prompt", "message": "p", "defaultPrompt": "hi"}),
        );
        assert_eq!(
            (a.id.as_str(), b.id.as_str(), c.id.as_str()),
            ("1", "2", "3")
        );
        assert_eq!(c.prompt_text.as_deref(), Some("hi"));
    }

    #[test]
    fn chooser_validation_chain_pinned_errors_and_order() {
        let r = io();
        let single = r.on_file_chooser_opened(
            "1",
            &json!({"mode": "selectSingle", "frameId": "f1", "backendNodeId": 42}),
        );
        assert_eq!(single.backend_node_id, Some(42));
        // Tab mismatch precedes every content check (recovered r2 order).
        let err = IoRegistries::validate_set_files(&["a".into()], &single, "2").unwrap_err();
        assert_eq!(err.to_string(), "File chooser \"1\" belongs to tab 1");
        let err = IoRegistries::validate_set_files(&[], &single, "1").unwrap_err();
        assert_eq!(
            err.to_string(),
            "fileChooser.setFiles requires at least one file"
        );
        let err =
            IoRegistries::validate_set_files(&["a".into(), "b".into()], &single, "1").unwrap_err();
        assert_eq!(
            err.to_string(),
            "File chooser does not accept multiple files"
        );
        assert!(IoRegistries::validate_set_files(&["a".into()], &single, "1").is_ok());
        let multi =
            r.on_file_chooser_opened("1", &json!({"mode": "selectMultiple", "frameId": "f1"}));
        assert!(multi.is_multiple);
        assert!(IoRegistries::validate_set_files(&["a".into(), "b".into()], &multi, "1").is_ok());
    }

    #[test]
    fn downloads_track_state_and_completion() {
        let r = io();
        let g0 = r.download_generation("1");
        r.on_download_begin(
            "1",
            &json!({"guid": "abc123", "url": "https://x.test/f.zip", "suggestedFilename": "f.zip"}),
        );
        assert!(r.download_generation("1") > g0);
        assert_eq!(r.latest_download("1").unwrap().state, "in_progress");
        assert_eq!(
            r.latest_download("1").unwrap().path.replace('\\', "/"),
            "downloads/abc123"
        );
        assert!(r.latest_completed_download("1").is_none());
        r.on_download_progress(
            "1",
            &json!({"guid": "abc123", "totalBytes": 10, "receivedBytes": 10, "state": "completed"}),
        );
        let done = r.latest_completed_download("1").unwrap();
        assert_eq!(done.guid, "abc123");
        // Empty guid is ignored (no phantom entry).
        r.on_download_begin("1", &json!({"url": "x"}));
        assert_eq!(r.latest_download("1").unwrap().guid, "abc123");
    }

    #[test]
    fn forget_tab_clears_every_io_handle() {
        let r = io();
        r.on_dialog_open("1", &json!({"type": "alert", "message": "m"}));
        r.on_file_chooser_opened("1", &json!({"mode": "selectSingle", "frameId": "f"}));
        r.on_download_begin(
            "1",
            &json!({"guid": "g", "url": "u", "suggestedFilename": "s"}),
        );
        r.mark_chooser_intercept("1");
        r.forget_tab("1");
        assert!(r.js_dialog("1").is_none());
        assert!(r.chooser("1").is_none());
        assert!(r.latest_download("1").is_none());
        assert!(!r.chooser_intercept_enabled("1"));
    }
}
