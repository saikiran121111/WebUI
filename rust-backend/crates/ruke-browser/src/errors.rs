//! Typed browser errors.
//!
//! The model-facing message strings below are kept VERBATIM from the
//! recovered reference contract (see `reverse-engineering/internal-browser/
//! dom-snapshot-and-cdp.md` §5/§5.1 and `schemas-and-ipc.md` §2.1/§2.3)
//! wherever the recovered text is complete. Where the recovered evidence
//! gives message fragments that the native engine composes at runtime
//! (hit-test settle/coverage), the composed Ruke string is marked
//! `[adapted]` and its behavior — never silently guessing after a failed
//! click — is what the contract pins.
//!
//! The four blocked codes are verbatim registry strings from the command
//! vocabulary: `browser_security_unavailable`, `browser_capability_blocked`,
//! `browser_context_unavailable`, `webmcp_disabled`.

use serde_json::{json, Value};

/// Machine-readable code carried alongside every browser error on the
/// wire (tool-result payloads and `browser:*` stage frames).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    // Contract-layer failures (Phase 1).
    BadEnvelope,
    UnknownCommand,
    MetadataMissing,
    PayloadInvalid,
    // Authority / security blocks — codes verbatim from §2.1.
    SecurityUnavailable,
    CapabilityBlocked,
    ContextUnavailable,
    WebmcpDisabled,
    // Engine state failures.
    StaleDomNode,
    StaleAxElement,
    AxPreviousPage,
    AxCapturePreviousPage,
    AxCaptureEmpty,
    AxCaptureChangedBeforeCommitted,
    NoSettableValue,
    ClickTargetUnavailable,
    ShadowRootCheckFailed,
    ClickFailed,
    ClickNotSettled,
    ClickCovered,
    DialogBlocking,
    JsDialogGone,
    OnlyPromptAcceptsText,
    ScreenshotUnavailable,
    FileChooserUnknown,
    FileChooserTabMismatch,
    FileChooserNoFiles,
    FileChooserNotMultiple,
    JsDialogInterrupted,
    InputPrepareTimeout,
    SelectChangedBeforeActivation,
    SelectTextNotFound,
    SelectTextAmbiguous,
    SecondaryActionNotAllowed,
    // Playwright-style locator runtime (Phase 7).
    LocatorStrict,
    LocatorFailed,
    Unsupported,
    InvalidUrl,
    TimedOut,
    CdpFailed,
    HostUnavailable,
    Internal,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::BadEnvelope => "browser_command_envelope_invalid",
            ErrorCode::UnknownCommand => "browser_command_unknown",
            ErrorCode::MetadataMissing => "browser_turn_metadata_missing",
            ErrorCode::PayloadInvalid => "browser_payload_invalid",
            ErrorCode::SecurityUnavailable => "browser_security_unavailable",
            ErrorCode::CapabilityBlocked => "browser_capability_blocked",
            ErrorCode::ContextUnavailable => "browser_context_unavailable",
            ErrorCode::WebmcpDisabled => "webmcp_disabled",
            ErrorCode::StaleDomNode => "dom_node_stale",
            ErrorCode::StaleAxElement => "ax_element_stale",
            ErrorCode::AxPreviousPage => "ax_element_previous_page",
            ErrorCode::AxCapturePreviousPage => "ax_capture_previous_page",
            ErrorCode::AxCaptureEmpty => "ax_capture_empty",
            ErrorCode::AxCaptureChangedBeforeCommitted => "ax_capture_changed_before_committed",
            ErrorCode::NoSettableValue => "ax_no_settable_value",
            ErrorCode::ClickTargetUnavailable => "click_target_unavailable",
            ErrorCode::ShadowRootCheckFailed => "click_shadow_root_check_failed",
            ErrorCode::ClickFailed => "click_failed",
            ErrorCode::ClickNotSettled => "click_not_settled",
            ErrorCode::ClickCovered => "click_covered",
            ErrorCode::DialogBlocking => "dialog_blocking",
            ErrorCode::JsDialogInterrupted => "js_dialog_interrupted",
            ErrorCode::JsDialogGone => "js_dialog_gone",
            ErrorCode::OnlyPromptAcceptsText => "only_prompt_accepts_text",
            ErrorCode::ScreenshotUnavailable => "screenshot_unavailable",
            ErrorCode::FileChooserUnknown => "file_chooser_unknown",
            ErrorCode::FileChooserTabMismatch => "file_chooser_tab_mismatch",
            ErrorCode::FileChooserNoFiles => "file_chooser_no_files",
            ErrorCode::FileChooserNotMultiple => "file_chooser_not_multiple",
            ErrorCode::InputPrepareTimeout => "input_prepare_timeout",
            ErrorCode::SelectChangedBeforeActivation => "select_changed_before_activation",
            ErrorCode::SelectTextNotFound => "select_text_not_found",
            ErrorCode::SelectTextAmbiguous => "select_text_ambiguous",
            ErrorCode::SecondaryActionNotAllowed => "secondary_action_not_allowed",
            ErrorCode::LocatorStrict => "locator_strict_violation",
            ErrorCode::LocatorFailed => "locator_failed",
            ErrorCode::Unsupported => "browser_operation_unsupported",
            ErrorCode::InvalidUrl => "browser_url_invalid",
            ErrorCode::TimedOut => "browser_timeout",
            ErrorCode::CdpFailed => "browser_cdp_failed",
            ErrorCode::HostUnavailable => "browser_host_unavailable",
            ErrorCode::Internal => "browser_internal_error",
        }
    }
}

/// The browser engine's typed error. `Display` is the model/user-visible
/// message; several strings are pinned verbatim by the recovered contract
/// and unit-tested as such — the engine must NOT invent different wording
/// for these states, because the model's recovery behavior (fresh
/// observation after a stale reference, never retrying a dialog-interrupted
/// action) keys off them.
#[derive(Clone, Debug, thiserror::Error)]
pub enum BrowserError {
    // ── Contract layer ────────────────────────────────────────────────
    #[error("Browser command envelope is invalid")]
    BadEnvelope,

    #[error("Unknown browser command type: {command_type}")]
    UnknownCommand { command_type: String },

    /// Verbatim rule: the metadata check collects the missing keys in the
    /// order `["session_id", "turn_id"]` and names them, comma-separated.
    /// `[adapted]` only the product token in the prefix ("Ruke" where the
    /// recovered string names the reference product).
    #[error("Missing required Ruke turn metadata: {}", .missing.join(", "))]
    MissingTurnMetadata { missing: Vec<String> },

    #[error("Invalid payload for {command}: {reason}")]
    PayloadInvalid { command: String, reason: String },

    // ── Authority / security blocks (codes verbatim) ──────────────────
    #[error("Browser security is unavailable for this action.")]
    SecurityUnavailable,

    #[error("Browser capability blocked: {reason}")]
    CapabilityBlocked { reason: String },

    #[error("Browser context unavailable.")]
    ContextUnavailable,

    #[error("WebMCP is disabled.")]
    WebmcpDisabled,

    // ── DOM CUA (strings verbatim: "DOM node N is stale or missing") ──
    #[error("DOM node {node_id} is stale or missing")]
    StaleDomNode { node_id: u64 },

    // ── AX engine (strings verbatim) ──────────────────────────────────
    #[error("Accessibility element {element_index} is stale or missing")]
    StaleAxElement { element_index: u64 },

    #[error("Accessibility element {element_index} belongs to a previous page")]
    AxPreviousPage { element_index: u64 },

    #[error("Accessibility capture belongs to a previous page")]
    AxCapturePreviousPage,

    /// Verbatim: the capture state machine's empty-tree error (H-BS-26
    /// `capture()`: `if(b==null&&r!=="screenshot")throw new Error(
    /// "Accessibility capture was empty")`).
    #[error("Accessibility capture was empty")]
    AxCaptureEmpty,

    /// Verbatim terminal error (H-BS-26 final commit attempt):
    /// "Accessibility capture changed before it was committed". (The
    /// §5.1 summary paraphrase said "stabilized"; the recovered code
    /// string is authoritative and is what the model sees.)
    #[error("Accessibility capture changed before it was committed")]
    AxCaptureChangedBeforeCommitted,

    #[error("Accessibility element {element_index} has no settable value")]
    NoSettableValue { element_index: u64 },

    #[error("Click target is no longer available")]
    ClickTargetUnavailable,

    #[error("Could not check the click target's shadow root")]
    ShadowRootCheckFailed,

    /// Verbatim: `Element ${id} couldn't be clicked. Try another element.`
    #[error("Element {element} couldn't be clicked. Try another element.")]
    ClickFailed { element: String },

    /// `[adapted]` composition: recovered fragments give "couldn't be
    /// clicked", "did not settle after scrolling" and the retry advice;
    /// the settle deadline (500 ms) and its behavior are pinned in Phase 5.
    #[error("Element {element} did not settle after scrolling. Try another element.")]
    ClickNotSettled { element: String },

    /// `[adapted]` composition of the recovered fragment
    /// "is covered by ${hitTag?\"another element\"} or otherwise not hittable".
    #[error("Element {element} is covered by {covering} or otherwise not hittable. Try another element.")]
    ClickCovered { element: String, covering: String },

    /// Verbatim: dialog-aware action capture throws this when the AX
    /// target carries a pending JavaScript dialog.
    #[error("A JavaScript dialog is blocking the requested page element")]
    DialogBlocking,

    /// Verbatim (tl-wrapper race against `Page.javascriptDialogOpening`;
    /// `beforeunload` is skipped by design):
    /// "Browser action \"kind\" interrupted by JavaScript type: detail
    /// The action may already have taken effect; do not retry it. Inspect
    /// or dismiss the dialog before continuing."
    #[error("Browser action \"{action_kind}\" interrupted by JavaScript {dialog_type}: {detail} The action may already have taken effect; do not retry it. Inspect or dismiss the dialog before continuing.")]
    JsDialogInterrupted {
        action_kind: String,
        dialog_type: String,
        detail: String,
    },
    /// `tab_handle_js_dialog` with no active dialog (already dismissed or
    /// never opened). Recovered pinned message.
    #[error("JavaScript dialog is no longer active")]
    JsDialogGone,
    /// `prompt_text` supplied for a non-prompt dialog. Recovered pinned
    /// message.
    #[error("Only prompt dialogs accept text")]
    OnlyPromptAcceptsText,
    /// The command-level dialog guard (the recovered
    /// `throwIfJsDialogBlocksMethod`); the discovery command carries
    /// Ruke's snake_case name.
    #[error("A {dialog_type} JavaScript dialog is active in this tab. Use `tab_get_js_dialog` to get it and dismiss it first.")]
    JsDialogBlocksMethod { dialog_type: String },
    /// `tab_ax_get_state` screenshot content mode while a JS dialog is
    /// open — the reference's fallback text with Ruke's command names.
    #[error("Screenshot unavailable while a JavaScript {dialog_type} dialog is open. Use tab_ax_get_state with content \"axState\" and a tab_ax_action click action (element_index) to interact with its controls.")]
    ScreenshotUnavailable { dialog_type: String },

    /// Verbatim: focus-then-input budget (3e3 ms) —
    /// "Could not prepare accessibility element N for input within 3000 ms. No input was sent."
    #[error("Could not prepare accessibility element {element_index} for input within 3000 ms. No input was sent.")]
    InputPrepareTimeout { element_index: u64 },

    #[error("Select changed before option activation")]
    SelectChangedBeforeActivation,

    /// Verbatim fragments: "Text to select was not found" /
    /// "matches multiple locations" (uniqueness via prefix+text+suffix).
    #[error("Text to select was not found")]
    SelectTextNotFound,

    #[error("Text to select matches multiple locations")]
    SelectTextAmbiguous,

    /// Secondary actions are restricted to Expand/Collapse AND must be
    /// present in the element's `actionDescriptions` (Phase 6).
    #[error("Secondary action \"{action}\" is not available on this element")]
    SecondaryActionNotAllowed { action: String },

    // ── File-chooser registry (Phase 8; strings verbatim from the
    //    recovered r2 handler, schemas-and-ipc.md) ─────────────────────
    #[error("Unknown file chooser id \"{file_chooser_id}\"")]
    FileChooserUnknown { file_chooser_id: String },
    #[error("File chooser \"{file_chooser_id}\" belongs to tab {actual_tab_id}")]
    FileChooserTabMismatch {
        file_chooser_id: String,
        actual_tab_id: String,
    },
    #[error("fileChooser.setFiles requires at least one file")]
    FileChooserNoFiles,
    #[error("File chooser does not accept multiple files")]
    FileChooserNotMultiple,
    /// [adapted] Ruke's `playwright_file_chooser_set_files` payload
    /// carries no chooser id, so the recovered "unknown chooser id"
    /// surface becomes "this tab has no pending chooser" (the id-keyed
    /// errors above stay wired through the registry validation chain).
    #[error("No file chooser is pending on tab {tab_id}; click a file input and pair `playwright_wait_for_file_chooser` for the ordering contract")]
    FileChooserPendingMissing { tab_id: String },

    // ── Playwright-style locator runtime (Phase 7) ──────────────────
    // Messages composed to mirror the reference locator error surface
    // (the "strict mode violation" token and the `Timeout …ms exceeded`
    // timeout grammar); Ruke's strict-mode locators make the resolved-
    // to-N wording honest for both zero and multiple hits, matching
    // Playwright's own strict semantics.
    #[error("strict mode violation: locator \"{selector}\" resolved to {count} elements (expected exactly one)")]
    LocatorStrict { selector: String, count: usize },

    #[error("Timeout {timeout_ms}ms exceeded waiting for locator \"{selector}\" to be {state}")]
    LocatorTimeout {
        selector: String,
        state: String,
        timeout_ms: u64,
    },

    #[error("Timeout {timeout_ms}ms exceeded waiting for {what}")]
    PwTimeout { what: String, timeout_ms: u64 },

    #[error("aria snapshot reference \"{token}\" is stale or missing; take a fresh playwright_dom_snapshot")]
    LocatorStaleRef { token: String },

    #[error("locator \"{selector}\" failed: {reason}")]
    LocatorFailed { selector: String, reason: String },

    /// Honest unsupported-operation surface at native boundaries that the
    /// contract itself declares unsupported (e.g. requestManualHandoff on
    /// headless CDP tabs is replaced by the Ruke Browser Panel handoff UI,
    /// which IS supported; this variant is reserved for genuinely absent
    /// operations and never used to fake a supported one). Since
    /// Phase 15 the `execute()` match is exhaustive over the registry,
    /// so no command path returns this any more; the wire code stays
    /// reserved exactly as the contract grammar declares it.
    #[error("{operation} is not supported by the Ruke browser runtime")]
    Unsupported { operation: String },

    /// A `tab_ax_action` failure re-raised after a fresh state capture —
    /// the reference's `${message}\n\n\n${state}` rethrow (the appended
    /// payload is the axState result serialized, Ruke shape). The wire
    /// code stays the SOURCE's code so model-side handling is unchanged.
    #[error("{source}\n\n\n{state}")]
    AxActionFailed {
        source: Box<BrowserError>,
        state: String,
    },

    #[error("Invalid navigation URL: {url}")]
    InvalidUrl { url: String },

    #[error("Timed out waiting for {what}")]
    TimedOut { what: String },

    #[error("CDP command {method} failed: {reason}")]
    CdpFailed { method: String, reason: String },

    #[error("The browser host is not running")]
    HostUnavailable,

    #[error("Internal browser error: {detail}")]
    Internal { detail: String },
}

impl BrowserError {
    pub fn code(&self) -> ErrorCode {
        match self {
            BrowserError::BadEnvelope => ErrorCode::BadEnvelope,
            BrowserError::UnknownCommand { .. } => ErrorCode::UnknownCommand,
            BrowserError::MissingTurnMetadata { .. } => ErrorCode::MetadataMissing,
            BrowserError::PayloadInvalid { .. } => ErrorCode::PayloadInvalid,
            BrowserError::SecurityUnavailable => ErrorCode::SecurityUnavailable,
            BrowserError::CapabilityBlocked { .. } => ErrorCode::CapabilityBlocked,
            BrowserError::ContextUnavailable => ErrorCode::ContextUnavailable,
            BrowserError::WebmcpDisabled => ErrorCode::WebmcpDisabled,
            BrowserError::StaleDomNode { .. } => ErrorCode::StaleDomNode,
            BrowserError::StaleAxElement { .. } => ErrorCode::StaleAxElement,
            BrowserError::AxPreviousPage { .. } => ErrorCode::AxPreviousPage,
            BrowserError::AxCapturePreviousPage => ErrorCode::AxCapturePreviousPage,
            BrowserError::AxCaptureEmpty => ErrorCode::AxCaptureEmpty,
            BrowserError::AxCaptureChangedBeforeCommitted => {
                ErrorCode::AxCaptureChangedBeforeCommitted
            }
            BrowserError::NoSettableValue { .. } => ErrorCode::NoSettableValue,
            BrowserError::ClickTargetUnavailable => ErrorCode::ClickTargetUnavailable,
            BrowserError::ShadowRootCheckFailed => ErrorCode::ShadowRootCheckFailed,
            BrowserError::ClickFailed { .. } => ErrorCode::ClickFailed,
            BrowserError::ClickNotSettled { .. } => ErrorCode::ClickNotSettled,
            BrowserError::ClickCovered { .. } => ErrorCode::ClickCovered,
            BrowserError::DialogBlocking => ErrorCode::DialogBlocking,
            BrowserError::JsDialogBlocksMethod { .. } => ErrorCode::DialogBlocking,
            BrowserError::JsDialogGone => ErrorCode::JsDialogGone,
            BrowserError::OnlyPromptAcceptsText => ErrorCode::OnlyPromptAcceptsText,
            BrowserError::ScreenshotUnavailable { .. } => ErrorCode::ScreenshotUnavailable,
            BrowserError::FileChooserUnknown { .. } => ErrorCode::FileChooserUnknown,
            BrowserError::FileChooserTabMismatch { .. } => ErrorCode::FileChooserTabMismatch,
            BrowserError::FileChooserNoFiles => ErrorCode::FileChooserNoFiles,
            BrowserError::FileChooserNotMultiple => ErrorCode::FileChooserNotMultiple,
            BrowserError::FileChooserPendingMissing { .. } => ErrorCode::FileChooserUnknown,
            BrowserError::JsDialogInterrupted { .. } => ErrorCode::JsDialogInterrupted,
            BrowserError::InputPrepareTimeout { .. } => ErrorCode::InputPrepareTimeout,
            BrowserError::SelectChangedBeforeActivation => ErrorCode::SelectChangedBeforeActivation,
            BrowserError::SelectTextNotFound => ErrorCode::SelectTextNotFound,
            BrowserError::SelectTextAmbiguous => ErrorCode::SelectTextAmbiguous,
            BrowserError::SecondaryActionNotAllowed { .. } => ErrorCode::SecondaryActionNotAllowed,
            BrowserError::LocatorStrict { .. } => ErrorCode::LocatorStrict,
            BrowserError::LocatorTimeout { .. } => ErrorCode::TimedOut,
            BrowserError::PwTimeout { .. } => ErrorCode::TimedOut,
            BrowserError::LocatorStaleRef { .. } => ErrorCode::StaleDomNode,
            BrowserError::LocatorFailed { .. } => ErrorCode::LocatorFailed,
            BrowserError::Unsupported { .. } => ErrorCode::Unsupported,
            BrowserError::AxActionFailed { source, .. } => source.code(),
            BrowserError::InvalidUrl { .. } => ErrorCode::InvalidUrl,
            BrowserError::TimedOut { .. } => ErrorCode::TimedOut,
            BrowserError::CdpFailed { .. } => ErrorCode::CdpFailed,
            BrowserError::HostUnavailable => ErrorCode::HostUnavailable,
            BrowserError::Internal { .. } => ErrorCode::Internal,
        }
    }

    /// Wire form of the error: machine code + human/model message. Tool
    /// results (`role:"tool"` payloads in the agent loop) and `browser:*`
    /// stage frames both carry this shape.
    pub fn to_wire(&self) -> Value {
        json!({
            "ok": false,
            "error_code": self.code().as_str(),
            "message": self.to_string(),
        })
    }
}

/// Convenience: build a `PayloadInvalid` for the named command.
pub(crate) fn payload_invalid(command: &str, reason: impl Into<String>) -> BrowserError {
    BrowserError::PayloadInvalid {
        command: command.to_string(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The metadata error is pinned verbatim apart from the documented
    /// product-token adaptation ("Ruke" in place of the reference name).
    #[test]
    fn metadata_error_lists_missing_keys_in_contract_order() {
        let e = BrowserError::MissingTurnMetadata {
            missing: vec!["session_id".into(), "turn_id".into()],
        };
        assert_eq!(
            e.to_string(),
            "Missing required Ruke turn metadata: session_id, turn_id"
        );
        let e2 = BrowserError::MissingTurnMetadata {
            missing: vec!["turn_id".into()],
        };
        assert_eq!(
            e2.to_string(),
            "Missing required Ruke turn metadata: turn_id"
        );
    }

    /// Phase-7 locator messages: composed to mirror the reference
    /// strict-mode and timeout grammar (adapted composition, not a
    /// recovered literal — the reference builds these across frames).
    #[test]
    fn locator_error_strings_are_pinned() {
        assert_eq!(
            BrowserError::LocatorStrict {
                selector: "button".into(),
                count: 3
            }
            .to_string(),
            "strict mode violation: locator \"button\" resolved to 3 elements (expected exactly one)"
        );
        assert_eq!(
            BrowserError::LocatorTimeout {
                selector: "#go".into(),
                state: "visible".into(),
                timeout_ms: 30_000
            }
            .to_string(),
            "Timeout 30000ms exceeded waiting for locator \"#go\" to be visible"
        );
        assert_eq!(
            BrowserError::PwTimeout {
                what: "load state \"networkidle\"".into(),
                timeout_ms: 5_000
            }
            .to_string(),
            "Timeout 5000ms exceeded waiting for load state \"networkidle\""
        );
        assert_eq!(
            BrowserError::LocatorStaleRef { token: "e7".into() }.to_string(),
            "aria snapshot reference \"e7\" is stale or missing; take a fresh playwright_dom_snapshot"
        );
        assert_eq!(
            BrowserError::LocatorFailed {
                selector: "x".into(),
                reason: "not an iframe".into()
            }
            .to_string(),
            "locator \"x\" failed: not an iframe"
        );
        assert_eq!(
            BrowserError::LocatorStrict {
                selector: "a".into(),
                count: 0
            }
            .code(),
            ErrorCode::LocatorStrict
        );
        assert_eq!(
            ErrorCode::LocatorStrict.as_str(),
            "locator_strict_violation"
        );
        assert_eq!(
            BrowserError::LocatorTimeout {
                selector: "a".into(),
                state: "attached".into(),
                timeout_ms: 1
            }
            .code(),
            ErrorCode::TimedOut
        );
        assert_eq!(
            BrowserError::LocatorStaleRef { token: "e1".into() }.code(),
            ErrorCode::StaleDomNode
        );
        assert_eq!(ErrorCode::LocatorFailed.as_str(), "locator_failed");
    }

    #[test]
    fn recovered_engine_strings_are_verbatim() {
        assert_eq!(
            BrowserError::StaleDomNode { node_id: 42 }.to_string(),
            "DOM node 42 is stale or missing"
        );
        assert_eq!(
            BrowserError::StaleAxElement { element_index: 7 }.to_string(),
            "Accessibility element 7 is stale or missing"
        );
        assert_eq!(
            BrowserError::AxPreviousPage { element_index: 7 }.to_string(),
            "Accessibility element 7 belongs to a previous page"
        );
        assert_eq!(
            BrowserError::AxCapturePreviousPage.to_string(),
            "Accessibility capture belongs to a previous page"
        );
        assert_eq!(
            BrowserError::AxCaptureEmpty.to_string(),
            "Accessibility capture was empty"
        );
        assert_eq!(
            BrowserError::AxCaptureChangedBeforeCommitted.to_string(),
            "Accessibility capture changed before it was committed"
        );
        assert_eq!(
            BrowserError::NoSettableValue { element_index: 3 }.to_string(),
            "Accessibility element 3 has no settable value"
        );
        assert_eq!(
            BrowserError::ClickTargetUnavailable.to_string(),
            "Click target is no longer available"
        );
        assert_eq!(
            BrowserError::ShadowRootCheckFailed.to_string(),
            "Could not check the click target's shadow root"
        );
        assert_eq!(
            BrowserError::ClickFailed {
                element: "5".into()
            }
            .to_string(),
            "Element 5 couldn't be clicked. Try another element."
        );
        assert_eq!(
            BrowserError::DialogBlocking.to_string(),
            "A JavaScript dialog is blocking the requested page element"
        );
        assert_eq!(
            BrowserError::InputPrepareTimeout { element_index: 9 }.to_string(),
            "Could not prepare accessibility element 9 for input within 3000 ms. No input was sent."
        );
        assert_eq!(
            BrowserError::SelectChangedBeforeActivation.to_string(),
            "Select changed before option activation"
        );
        assert_eq!(
            BrowserError::SelectTextNotFound.to_string(),
            "Text to select was not found"
        );
        assert_eq!(
            BrowserError::SelectTextAmbiguous.to_string(),
            "Text to select matches multiple locations"
        );
        assert_eq!(
            BrowserError::JsDialogInterrupted {
                action_kind: "click".into(),
                dialog_type: "alert".into(),
                detail: "\"Leave?\"".into(),
            }
            .to_string(),
            "Browser action \"click\" interrupted by JavaScript alert: \"Leave?\" The action may already have taken effect; do not retry it. Inspect or dismiss the dialog before continuing."
        );
        // Phase-8 dialog registry + file-chooser strings (chooser set
        // verbatim from the recovered r2 handler).
        assert_eq!(
            BrowserError::JsDialogGone.to_string(),
            "JavaScript dialog is no longer active"
        );
        assert_eq!(
            BrowserError::OnlyPromptAcceptsText.to_string(),
            "Only prompt dialogs accept text"
        );
        assert_eq!(
            BrowserError::FileChooserUnknown {
                file_chooser_id: "7".into()
            }
            .to_string(),
            "Unknown file chooser id \"7\""
        );
        assert_eq!(
            BrowserError::FileChooserTabMismatch {
                file_chooser_id: "7".into(),
                actual_tab_id: "3".into()
            }
            .to_string(),
            "File chooser \"7\" belongs to tab 3"
        );
        assert_eq!(
            BrowserError::FileChooserNoFiles.to_string(),
            "fileChooser.setFiles requires at least one file"
        );
        assert_eq!(
            BrowserError::FileChooserNotMultiple.to_string(),
            "File chooser does not accept multiple files"
        );
        // [adapted] id-less set_files surface (see the variant docs).
        assert_eq!(
            BrowserError::FileChooserPendingMissing { tab_id: "4".into() }.to_string(),
            "No file chooser is pending on tab 4; click a file input and pair `playwright_wait_for_file_chooser` for the ordering contract"
        );
        assert_eq!(
            BrowserError::FileChooserPendingMissing { tab_id: "4".into() }.code(),
            ErrorCode::FileChooserUnknown
        );
        assert_eq!(
            BrowserError::JsDialogBlocksMethod {
                dialog_type: "alert".into()
            }
            .code(),
            ErrorCode::DialogBlocking
        );
    }

    #[test]
    fn ax_action_rethrow_keeps_the_source_code() {
        let e = BrowserError::AxActionFailed {
            source: Box::new(BrowserError::StaleAxElement { element_index: 5 }),
            state: "{\"tab_id\":\"1\"}".into(),
        };
        assert_eq!(e.code(), ErrorCode::StaleAxElement);
        assert_eq!(
            e.to_string(),
            "Accessibility element 5 is stale or missing\n\n\n{\"tab_id\":\"1\"}"
        );
    }

    #[test]
    fn blocked_codes_are_verbatim_registry_strings() {
        assert_eq!(
            ErrorCode::SecurityUnavailable.as_str(),
            "browser_security_unavailable"
        );
        assert_eq!(
            ErrorCode::CapabilityBlocked.as_str(),
            "browser_capability_blocked"
        );
        assert_eq!(
            ErrorCode::ContextUnavailable.as_str(),
            "browser_context_unavailable"
        );
        assert_eq!(ErrorCode::WebmcpDisabled.as_str(), "webmcp_disabled");
        assert_eq!(
            BrowserError::SecurityUnavailable.code(),
            ErrorCode::SecurityUnavailable
        );
        assert_eq!(
            BrowserError::WebmcpDisabled.code(),
            ErrorCode::WebmcpDisabled
        );
    }

    #[test]
    fn wire_shape_carries_code_and_message() {
        let w = BrowserError::StaleDomNode { node_id: 1 }.to_wire();
        assert_eq!(w["ok"], json!(false));
        assert_eq!(w["error_code"], json!("dom_node_stale"));
        assert_eq!(w["message"], json!("DOM node 1 is stale or missing"));
    }
}
