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
    JsDialogInterrupted,
    InputPrepareTimeout,
    SelectChangedBeforeActivation,
    SelectTextNotFound,
    SelectTextAmbiguous,
    SecondaryActionNotAllowed,
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
            ErrorCode::InputPrepareTimeout => "input_prepare_timeout",
            ErrorCode::SelectChangedBeforeActivation => "select_changed_before_activation",
            ErrorCode::SelectTextNotFound => "select_text_not_found",
            ErrorCode::SelectTextAmbiguous => "select_text_ambiguous",
            ErrorCode::SecondaryActionNotAllowed => "secondary_action_not_allowed",
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

    /// Honest unsupported-operation surface at native boundaries that the
    /// contract itself declares unsupported (e.g. requestManualHandoff on
    /// headless CDP tabs is replaced by the Ruke Browser Panel handoff UI,
    /// which IS supported; this variant is reserved for genuinely absent
    /// operations and never used to fake a supported one).
    #[error("{operation} is not supported by the Ruke browser runtime")]
    Unsupported { operation: String },

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
            BrowserError::JsDialogInterrupted { .. } => ErrorCode::JsDialogInterrupted,
            BrowserError::InputPrepareTimeout { .. } => ErrorCode::InputPrepareTimeout,
            BrowserError::SelectChangedBeforeActivation => ErrorCode::SelectChangedBeforeActivation,
            BrowserError::SelectTextNotFound => ErrorCode::SelectTextNotFound,
            BrowserError::SelectTextAmbiguous => ErrorCode::SelectTextAmbiguous,
            BrowserError::SecondaryActionNotAllowed { .. } => ErrorCode::SecondaryActionNotAllowed,
            BrowserError::Unsupported { .. } => ErrorCode::Unsupported,
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
