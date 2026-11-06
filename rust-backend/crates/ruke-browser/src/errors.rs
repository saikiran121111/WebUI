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
    ClickFailed,
    DialogBlocking,
    JsDialogGone,
    OnlyPromptAcceptsText,
    ScreenshotUnavailable,
    FileChooserUnknown,
    FileChooserTabMismatch,
    FileChooserNoFiles,
    FileChooserNotMultiple,
    // Playwright-style locator runtime (Phase 7).
    LocatorStrict,
    LocatorFailed,
    Unsupported,
    InvalidUrl,
    TimedOut,
    CdpFailed,
    HostUnavailable,
    Internal,
    // Playwright MCP driver layer (Phase 2).
    McpUnavailable,
    McpTimeout,
    McpToolFailed,
    McpCancelled,
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
            ErrorCode::ClickFailed => "click_failed",
            ErrorCode::DialogBlocking => "dialog_blocking",
            ErrorCode::JsDialogGone => "js_dialog_gone",
            ErrorCode::OnlyPromptAcceptsText => "only_prompt_accepts_text",
            ErrorCode::ScreenshotUnavailable => "screenshot_unavailable",
            ErrorCode::FileChooserUnknown => "file_chooser_unknown",
            ErrorCode::FileChooserTabMismatch => "file_chooser_tab_mismatch",
            ErrorCode::FileChooserNoFiles => "file_chooser_no_files",
            ErrorCode::FileChooserNotMultiple => "file_chooser_not_multiple",
            ErrorCode::LocatorStrict => "locator_strict_violation",
            ErrorCode::LocatorFailed => "locator_failed",
            ErrorCode::Unsupported => "browser_operation_unsupported",
            ErrorCode::InvalidUrl => "browser_url_invalid",
            ErrorCode::TimedOut => "browser_timeout",
            ErrorCode::CdpFailed => "browser_cdp_failed",
            ErrorCode::HostUnavailable => "browser_host_unavailable",
            ErrorCode::Internal => "browser_internal_error",
            ErrorCode::McpUnavailable => "browser_mcp_unavailable",
            ErrorCode::McpTimeout => "browser_mcp_timeout",
            ErrorCode::McpToolFailed => "browser_mcp_tool_failed",
            ErrorCode::McpCancelled => "browser_mcp_cancelled",
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

    // ── Click / JS-dialog surfaces ────────────────────────────────────
    // The retired AX capture pipeline's other click diagnostics
    // (target-unavailable, shadow-root check, settle, coverage), the
    // dialog-blocking capture guard, and the dialog-race interrupt all
    // retired with the `tab_ax_*` pair in Phase 2 — see
    // contract.rs::RETIRED_REFERENCE_COMMANDS.
    /// Verbatim: `Element ${id} couldn't be clicked. Try another element.`
    #[error("Element {element} couldn't be clicked. Try another element.")]
    ClickFailed { element: String },

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
    /// A capture requested while a JS dialog is open. The retired
    /// `tab_ax_get_state` screenshot mode was this contract's original
    /// producer (Phase 2 retirement); the wire code and text stay
    /// reserved, and the guidance now names the command pair that is
    /// actually the dismissal route.
    #[error("Screenshot unavailable while a JavaScript {dialog_type} dialog is open. Use `tab_get_js_dialog` to inspect it and `tab_handle_js_dialog` to dismiss it, then retry the capture.")]
    ScreenshotUnavailable { dialog_type: String },

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

    // `AxActionFailed` (the retired `tab_ax_action` rethrow wrapper) was
    // deleted with the Phase-2 retirement of the `tab_ax_*` pair —
    // see contract.rs::RETIRED_REFERENCE_COMMANDS.
    #[error("Invalid navigation URL: {url}")]
    InvalidUrl { url: String },

    #[error("Timed out waiting for {what}")]
    TimedOut { what: String },

    #[error("CDP command {method} failed: {reason}")]
    CdpFailed { method: String, reason: String },

    #[error("The browser host is not running")]
    HostUnavailable,

    // ── Playwright MCP driver layer (Phase 2) ─────────────────────────
    // The actuation driver attaches to the SAME Chromium (same-browser
    // gate). These strings stay honest about what the driver layer
    // means — a timed-out or cancelled MCP action may already have
    // applied, so the message tells the model to re-observe rather
    // than blindly retry.
    #[error("Playwright MCP driver is unavailable: {reason}")]
    McpUnavailable { reason: String },

    #[error("Timeout {timeout_ms}ms exceeded running browser action \"{tool}\"; the action may or may not have been applied — re-observe the page before retrying")]
    McpTimeout { tool: String, timeout_ms: u64 },

    #[error("Browser action \"{tool}\" failed: {reason}")]
    McpToolFailed { tool: String, reason: String },

    #[error("Browser action \"{tool}\" was cancelled mid-action; it may or may not have been applied — re-observe the page before retrying")]
    McpCancelled { tool: String },

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
            BrowserError::ClickFailed { .. } => ErrorCode::ClickFailed,
            BrowserError::JsDialogBlocksMethod { .. } => ErrorCode::DialogBlocking,
            BrowserError::JsDialogGone => ErrorCode::JsDialogGone,
            BrowserError::OnlyPromptAcceptsText => ErrorCode::OnlyPromptAcceptsText,
            BrowserError::ScreenshotUnavailable { .. } => ErrorCode::ScreenshotUnavailable,
            BrowserError::FileChooserUnknown { .. } => ErrorCode::FileChooserUnknown,
            BrowserError::FileChooserTabMismatch { .. } => ErrorCode::FileChooserTabMismatch,
            BrowserError::FileChooserNoFiles => ErrorCode::FileChooserNoFiles,
            BrowserError::FileChooserNotMultiple => ErrorCode::FileChooserNotMultiple,
            BrowserError::FileChooserPendingMissing { .. } => ErrorCode::FileChooserUnknown,
            BrowserError::LocatorStrict { .. } => ErrorCode::LocatorStrict,
            BrowserError::LocatorTimeout { .. } => ErrorCode::TimedOut,
            BrowserError::PwTimeout { .. } => ErrorCode::TimedOut,
            BrowserError::LocatorStaleRef { .. } => ErrorCode::StaleDomNode,
            BrowserError::LocatorFailed { .. } => ErrorCode::LocatorFailed,
            BrowserError::Unsupported { .. } => ErrorCode::Unsupported,
            BrowserError::McpUnavailable { .. } => ErrorCode::McpUnavailable,
            BrowserError::McpTimeout { .. } => ErrorCode::McpTimeout,
            BrowserError::McpToolFailed { .. } => ErrorCode::McpToolFailed,
            BrowserError::McpCancelled { .. } => ErrorCode::McpCancelled,
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

/// Map an MCP-layer failure onto the typed command surface. Service
/// failures collapse into `McpUnavailable` (the bridge clears its cached
/// session and re-attaches once; a second service failure is surfaced
/// honestly to the model, naming the pinned package in the reason).
impl From<crate::mcp::McpError> for BrowserError {
    fn from(e: crate::mcp::McpError) -> Self {
        match e {
            crate::mcp::McpError::Unavailable { why } => {
                BrowserError::McpUnavailable { reason: why }
            }
            crate::mcp::McpError::Service { detail } => BrowserError::McpUnavailable {
                reason: format!(
                    "driver connection failed ({}): {detail}",
                    crate::mcp::MCP_PACKAGE
                ),
            },
            crate::mcp::McpError::Timeout { tool, timeout_ms } => {
                BrowserError::McpTimeout { tool, timeout_ms }
            }
            crate::mcp::McpError::Tool { tool, text } => {
                BrowserError::McpToolFailed { tool, reason: text }
            }
        }
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
            BrowserError::ClickFailed {
                element: "5".into()
            }
            .to_string(),
            "Element 5 couldn't be clicked. Try another element."
        );
        // The retired `tab_ax_*` capture pipeline pinned its own verbatim
        // strings; they left with the capture engine in Phase 2 (see
        // contract.rs::RETIRED_REFERENCE_COMMANDS). The live surfaces keep:
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

    // The `ax_action_rethrow_keeps_the_source_code` test retired with the
    // `AxActionFailed` wrapper (Phase 2), and the recovered ax-state
    // strings retired with the capture engine they came from. What still
    // lives is pinned by the tests above and below.

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

    /// Phase-2 MCP driver strings + codes are pinned (model recovery
    /// keys off the re-observe-before-retry wording).
    #[test]
    fn mcp_driver_strings_and_codes_are_pinned() {
        assert_eq!(
            BrowserError::McpUnavailable {
                reason: "npm ci needed".into()
            }
            .to_string(),
            "Playwright MCP driver is unavailable: npm ci needed"
        );
        assert_eq!(
            BrowserError::McpUnavailable { reason: "x".into() }.code(),
            ErrorCode::McpUnavailable
        );
        assert_eq!(
            BrowserError::McpTimeout {
                tool: "browser_click".into(),
                timeout_ms: 15_000
            }
            .to_string(),
            "Timeout 15000ms exceeded running browser action \"browser_click\"; the action may or may not have been applied — re-observe the page before retrying"
        );
        assert_eq!(
            BrowserError::McpTimeout {
                tool: "t".into(),
                timeout_ms: 1
            }
            .code(),
            ErrorCode::McpTimeout
        );
        assert_eq!(ErrorCode::McpTimeout.as_str(), "browser_mcp_timeout");
        assert_eq!(
            BrowserError::McpToolFailed {
                tool: "browser_click".into(),
                reason: "boom".into()
            }
            .to_string(),
            "Browser action \"browser_click\" failed: boom"
        );
        assert_eq!(
            BrowserError::McpToolFailed {
                tool: "t".into(),
                reason: "r".into()
            }
            .code(),
            ErrorCode::McpToolFailed
        );
        assert_eq!(
            BrowserError::McpCancelled { tool: "browser_type".into() }.to_string(),
            "Browser action \"browser_type\" was cancelled mid-action; it may or may not have been applied — re-observe the page before retrying"
        );
        assert_eq!(
            BrowserError::McpCancelled { tool: "t".into() }.code(),
            ErrorCode::McpCancelled
        );
    }

    #[test]
    fn mcp_error_mapping_collapses_service_into_unavailable() {
        let e: BrowserError = crate::mcp::McpError::Service {
            detail: "died".into(),
        }
        .into();
        match e {
            BrowserError::McpUnavailable { reason } => {
                assert!(reason.contains("@playwright/mcp"), "{reason}");
                assert!(reason.contains("died"), "{reason}");
            }
            other => panic!("expected McpUnavailable, got {other:?}"),
        }
        let e: BrowserError = crate::mcp::McpError::Tool {
            tool: "browser_click".into(),
            text: "strict".into(),
        }
        .into();
        assert!(matches!(e, BrowserError::McpToolFailed { .. }));
        let e: BrowserError = crate::mcp::McpError::Timeout {
            tool: "browser_click".into(),
            timeout_ms: 15_000,
        }
        .into();
        assert!(matches!(e, BrowserError::McpTimeout { .. }));
    }

    #[test]
    fn wire_shape_carries_code_and_message() {
        let w = BrowserError::StaleDomNode { node_id: 1 }.to_wire();
        assert_eq!(w["ok"], json!(false));
        assert_eq!(w["error_code"], json!("dom_node_stale"));
        assert_eq!(w["message"], json!("DOM node 1 is stale or missing"));
    }
}
