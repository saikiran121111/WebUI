//! The closed command contract: vocabulary registry, envelope, and
//! typed dispatch.
//!
//! The command vocabulary is the recovered §2.1 registry pool verbatim
//! (73 reference command names) plus 9 `[adapted]` lifecycle commands
//! derived from the api.json surface (`tab_new`, `tab_close`, `tabs`
//! listing was in the pool; `tab_mark_deliverable`, `tab_mark_handoff`,
//! `browser_session_name`, `browser_history`, `browser_clear_data`,
//! `browser_user_open_tabs`, `browser_user_claim_tab` implement the
//! §2.4 turn-lifecycle and Appendix B history semantics that the pool
//! references but does not itself name).
//!
//! The envelope rule is verbatim from §2.2: `session_id` and `turn_id`
//! must both be present *as strings* (an empty string counts as present
//! at this layer — the recovered check is `typeof … === "string"`; the
//! engine fails closed later via context errors for unknown sessions).
//! The metadata-missing error enumerates the missing keys in the fixed
//! order `["session_id", "turn_id"]`.
//!
//! Validation order (contract contract, exercised by tests):
//! envelope shape → command type → turn metadata → payload decode →
//! numeric bounds. A malformed payload never masks a metadata failure.

use crate::errors::{payload_invalid, BrowserError};
use crate::schemas::*;
use serde_json::Value;

/// Generates the `CommandKind` enum (with `as_str`/`parse`/`ALL`), the
/// `Command` enum, and the payload-decode dispatch from one table, so
/// the registry coverage matrix (Phase 26) is mechanically complete:
/// every row is one line here, and the test suite round-trips every
/// kind in `CommandKind::ALL`.
macro_rules! command_registry {
    ( $( $(#[$m:meta])* $kind:ident / $name:literal => $payload:ty ),* $(,)? ) => {
        /// One variant per registry row; `as_str()` is the wire
        /// `commandType`, verbatim to the §2.1 pool where recovered.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum CommandKind {
            $( $(#[$m])* $kind, )*
        }

        impl CommandKind {
            pub fn as_str(&self) -> &'static str {
                match self {
                    $( CommandKind::$kind => $name, )*
                }
            }

            pub fn parse(s: &str) -> Option<CommandKind> {
                match s {
                    $( $name => Some(CommandKind::$kind), )*
                    _ => None,
                }
            }

            /// Every registry row — the coverage-matrix spine.
            pub const ALL: &'static [CommandKind] = &[
                $( CommandKind::$kind, )*
            ];
        }

        /// Fully-decoded command: kind + typed payload.
        #[derive(Clone, Debug, PartialEq)]
        pub enum Command {
            $( $(#[$m])* $kind($payload), )*
        }

        impl Command {
            pub fn kind(&self) -> CommandKind {
                match self {
                    $( Command::$kind(..) => CommandKind::$kind, )*
                }
            }
        }

        fn decode_payload(kind: CommandKind, payload: &Value) -> Result<Command, BrowserError> {
            match kind {
                $(
                    CommandKind::$kind => serde_json::from_value::<$payload>(payload.clone())
                        .map(Command::$kind)
                        .map_err(|e| payload_invalid(kind.as_str(), e.to_string())),
                )*
            }
        }
    };
}

command_registry! {
    // ── §2.1 pool: verbatim command names ─────────────────────────────
    Tabs / "tabs" => TabListQuery,
    NavigateTabUrl / "navigate_tab_url" => NavigateUrlPayload,
    NavigateTabBack / "navigate_tab_back" => TabTarget,
    NavigateTabForward / "navigate_tab_forward" => TabTarget,
    NavigateTabReload / "navigate_tab_reload" => TabTarget,
    TabAxAction / "tab_ax_action" => AxActionPayload,
    TabAxGetState / "tab_ax_get_state" => AxGetStatePayload,
    TabScreenshot / "tab_screenshot" => ScreenshotPayload,
    TabHandleJsDialog / "tab_handle_js_dialog" => HandleJsDialogPayload,
    TabGetJsDialog / "tab_get_js_dialog" => TabTarget,
    TabContentExport / "tab_content_export" => ContentExportPayload,
    TabContentExportGsuite / "tab_content_export_gsuite" => GsuiteExportPayload,
    TabContentExportYoutubeTranscript / "tab_content_export_youtube_transcript" => TabTarget,
    TabClipboardRead / "tab_clipboard_read" => TabTarget,
    TabClipboardReadText / "tab_clipboard_read_text" => TabTarget,
    TabClipboardWrite / "tab_clipboard_write" => ClipboardWritePayload,
    TabClipboardWriteText / "tab_clipboard_write_text" => TextPayload,
    /// Raw CDP — authority-gated by the `full_cdp_access` facet
    /// (Phase 9); never exposed to the model by default.
    TabCdpCall / "tab_cdp_call" => CdpCallPayload,
    TabCdpEvents / "tab_cdp_events" => CdpEventsPayload,
    TabPageAssetsList / "tab_page_assets_list" => TabTarget,
    TabPageAssetsBundle / "tab_page_assets_bundle" => TabTarget,
    TabBrowserAuthHandoff / "tab_browser_auth_handoff" => TabTarget,
    TabBotDetectionReport / "tab_bot_detection_report" => TabTarget,
    TabDevLogs / "tab_dev_logs" => DevLogsPayload,
    TabManualHandoffRequest / "tab_manual_handoff_request" => HandoffPayload,
    DomCuaGetVisibleDom / "dom_cua_get_visible_dom" => TabTarget,
    DomCuaClick / "dom_cua_click" => DomNodePayload,
    DomCuaDoubleClick / "dom_cua_double_click" => DomNodePayload,
    DomCuaKeypress / "dom_cua_keypress" => KeysPayload,
    DomCuaScroll / "dom_cua_scroll" => DomScrollPayload,
    DomCuaType / "dom_cua_type" => TextPayload,
    DomCuaDownloadMedia / "dom_cua_download_media" => DomDownloadMediaPayload,
    GetTab / "get_tab" => TabTarget,
    BrowserVisibilityGet / "browser_visibility_get" => BrowserOnly,
    CuaClick / "cua_click" => CuaClickPayload,
    CuaDoubleClick / "cua_double_click" => CuaClickPayload,
    CuaDrag / "cua_drag" => CuaDragPayload,
    CuaKeypress / "cua_keypress" => KeysPayload,
    CuaMove / "cua_move" => CuaMovePayload,
    CuaScroll / "cua_scroll" => CuaScrollPayload,
    CuaType / "cua_type" => TextPayload,
    PlaywrightDomSnapshot / "playwright_dom_snapshot" => TabTarget,
    PlaywrightEvaluate / "playwright_evaluate" => EvaluatePayload,
    PlaywrightElementInfo / "playwright_element_info" => ElementInfoPayload,
    PlaywrightElementScreenshot / "playwright_element_screenshot" => ScreenshotPayload,
    PlaywrightDownloadPath / "playwright_download_path" => TabTarget,
    PlaywrightWaitForDownload / "playwright_wait_for_download" => TimeoutPayload,
    PlaywrightWaitForFileChooser / "playwright_wait_for_file_chooser" => TimeoutPayload,
    PlaywrightWaitForLoadState / "playwright_wait_for_load_state" => WaitForLoadStatePayload,
    PlaywrightWaitForTimeout / "playwright_wait_for_timeout" => RequiredTimeoutPayload,
    PlaywrightWaitForUrl / "playwright_wait_for_url" => WaitForUrlPayload,
    PlaywrightFileChooserSetFiles / "playwright_file_chooser_set_files" => FileChooserSetFilesPayload,
    PlaywrightLocatorAllTextContents / "playwright_locator_all_text_contents" => LocatorPayload,
    PlaywrightLocatorClick / "playwright_locator_click" => LocatorClickPayload,
    PlaywrightLocatorCount / "playwright_locator_count" => LocatorPayload,
    PlaywrightLocatorDblclick / "playwright_locator_dblclick" => LocatorClickPayload,
    PlaywrightLocatorDownloadMedia / "playwright_locator_download_media" => LocatorTimeoutPayload,
    PlaywrightLocatorFill / "playwright_locator_fill" => LocatorValuePayload,
    PlaywrightLocatorGetAttribute / "playwright_locator_get_attribute" => LocatorNamePayload,
    PlaywrightLocatorInnerText / "playwright_locator_inner_text" => LocatorPayload,
    PlaywrightLocatorIsEnabled / "playwright_locator_is_enabled" => LocatorPayload,
    PlaywrightLocatorIsVisible / "playwright_locator_is_visible" => LocatorPayload,
    PlaywrightLocatorPress / "playwright_locator_press" => LocatorKeyPayload,
    PlaywrightLocatorPressSequentially / "playwright_locator_press_sequentially" => LocatorTextPayload,
    PlaywrightLocatorReadAll / "playwright_locator_read_all" => LocatorPayload,
    PlaywrightLocatorSelectOption / "playwright_locator_select_option" => LocatorSelectPayload,
    PlaywrightLocatorSetChecked / "playwright_locator_set_checked" => LocatorCheckedPayload,
    PlaywrightLocatorTextContent / "playwright_locator_text_content" => LocatorPayload,
    PlaywrightLocatorWaitFor / "playwright_locator_wait_for" => LocatorWaitPayload,
    WebmcpListTools / "webmcp_list_tools" => TabTarget,
    WebmcpInvokeTool / "webmcp_invoke_tool" => WebmcpInvokePayload,
    SiteStatus / "site_status" => SiteQueryPayload,
    SiteSubmissionVerified / "site_submission_verified" => SiteQueryPayload,

    // ── [adapted] lifecycle commands (api.json Tab/Browser surface +
    //    §2.4 turn semantics; absent from the §2.1 name pool) ─────────
    #[doc = "[adapted] §2.4 markDeliverable: turn-scoped, latest wins."]
    TabMarkDeliverable / "tab_mark_deliverable" => TabTarget,
    #[doc = "[adapted] §2.4 markHandoff: tab survives turn cleanup as handed off."]
    TabMarkHandoff / "tab_mark_handoff" => HandoffPayload,
    #[doc = "[adapted] api.json Tab-level new tab (agent-created ⇒ turn cleanup closes it unless marked)."]
    TabNew / "tab_new" => TabNewPayload,
    #[doc = "[adapted] api.json Tab.close()."]
    TabClose / "tab_close" => TabTarget,
    #[doc = "[adapted] Appendix B session naming."]
    BrowserSessionName / "browser_session_name" => SessionNamePayload,
    #[doc = "[adapted] Appendix B history (native Chromium History DB via rusqlite)."]
    BrowserHistory / "browser_history" => HistoryQueryPayload,
    #[doc = "[adapted] Appendix B clearData."]
    BrowserClearData / "browser_clear_data" => ClearDataPayload,
    #[doc = "[adapted] §2.4 user-facing tab listing for handoff UI."]
    BrowserUserOpenTabs / "browser_user_open_tabs" => BrowserOnly,
    #[doc = "[adapted] §2.4 claimTab from the user side."]
    BrowserUserClaimTab / "browser_user_claim_tab" => TabTarget,
}

/// The exact §2.1 reference pool (73 names) — the coverage test asserts
/// every one of these parses to a distinct registry kind.
pub const REFERENCE_COMMAND_POOL: [&str; 73] = [
    "tabs",
    "navigate_tab_url",
    "navigate_tab_back",
    "navigate_tab_forward",
    "navigate_tab_reload",
    "tab_ax_action",
    "tab_ax_get_state",
    "tab_screenshot",
    "tab_handle_js_dialog",
    "tab_get_js_dialog",
    "tab_content_export",
    "tab_content_export_gsuite",
    "tab_content_export_youtube_transcript",
    "tab_clipboard_read",
    "tab_clipboard_read_text",
    "tab_clipboard_write",
    "tab_clipboard_write_text",
    "tab_cdp_call",
    "tab_cdp_events",
    "tab_page_assets_list",
    "tab_page_assets_bundle",
    "tab_browser_auth_handoff",
    "tab_bot_detection_report",
    "tab_dev_logs",
    "tab_manual_handoff_request",
    "dom_cua_get_visible_dom",
    "dom_cua_click",
    "dom_cua_double_click",
    "dom_cua_keypress",
    "dom_cua_scroll",
    "dom_cua_type",
    "dom_cua_download_media",
    "get_tab",
    "browser_visibility_get",
    "cua_click",
    "cua_double_click",
    "cua_drag",
    "cua_keypress",
    "cua_move",
    "cua_scroll",
    "cua_type",
    "playwright_dom_snapshot",
    "playwright_evaluate",
    "playwright_element_info",
    "playwright_element_screenshot",
    "playwright_download_path",
    "playwright_wait_for_download",
    "playwright_wait_for_file_chooser",
    "playwright_wait_for_load_state",
    "playwright_wait_for_timeout",
    "playwright_wait_for_url",
    "playwright_file_chooser_set_files",
    "playwright_locator_all_text_contents",
    "playwright_locator_click",
    "playwright_locator_count",
    "playwright_locator_dblclick",
    "playwright_locator_download_media",
    "playwright_locator_fill",
    "playwright_locator_get_attribute",
    "playwright_locator_inner_text",
    "playwright_locator_is_enabled",
    "playwright_locator_is_visible",
    "playwright_locator_press",
    "playwright_locator_press_sequentially",
    "playwright_locator_read_all",
    "playwright_locator_select_option",
    "playwright_locator_set_checked",
    "playwright_locator_text_content",
    "playwright_locator_wait_for",
    "webmcp_list_tools",
    "webmcp_invoke_tool",
    "site_status",
    "site_submission_verified",
];

/// [adapted] lifecycle names (9).
pub const ADAPTED_COMMAND_POOL: [&str; 9] = [
    "tab_mark_deliverable",
    "tab_mark_handoff",
    "tab_new",
    "tab_close",
    "browser_session_name",
    "browser_history",
    "browser_clear_data",
    "browser_user_open_tabs",
    "browser_user_claim_tab",
];

/// The metadata keys, in the fixed order the recovered check uses.
const METADATA_KEYS: [&str; 2] = ["session_id", "turn_id"];

/// Parse the full command envelope.
///
/// Wire form (plan §"Key locked facts", nested payload `[adapted]`):
/// `{ "commandType": "…", "session_id": "…", "turn_id": "…",
///   "payload": { … command-specific … } }`
pub fn parse_command(value: &Value) -> Result<Command, BrowserError> {
    let obj = value.as_object().ok_or(BrowserError::BadEnvelope)?;

    let command_type = obj
        .get("commandType")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(BrowserError::BadEnvelope)?;

    let kind = CommandKind::parse(command_type).ok_or_else(|| BrowserError::UnknownCommand {
        command_type: command_type.to_string(),
    })?;

    // §2.2 verbatim: collect keys whose value is not a JSON string.
    // Empty string counts as PRESENT (typeof "" === "string").
    let missing: Vec<String> = METADATA_KEYS
        .iter()
        .filter(|k| !obj.get(**k).is_some_and(Value::is_string))
        .map(|k| (*k).to_string())
        .collect();
    if !missing.is_empty() {
        return Err(BrowserError::MissingTurnMetadata { missing });
    }

    // Absent payload decodes as `{}` so option-only commands work and
    // required-field commands fail with a precise PayloadInvalid.
    let payload = obj
        .get("payload")
        .cloned()
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));

    let cmd = decode_payload(kind, &payload)?;
    validate_command(&cmd)?;
    Ok(cmd)
}

/// Numeric/semantic bounds layered on top of the structural decode —
/// mirrors the recovered zod constraints (positive timeouts, the 1..1000
/// event-page cap, cua button 1..=5, press_key duration 0..=30 s).
fn validate_command(cmd: &Command) -> Result<(), BrowserError> {
    let kind = cmd.kind();
    let bad = |reason: &str| payload_invalid(kind.as_str(), reason);

    // Positive-timeout surface (`m.number().int().positive()`).
    match cmd {
        Command::PlaywrightEvaluate(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::PlaywrightWaitForDownload(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::PlaywrightWaitForFileChooser(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::PlaywrightWaitForLoadState(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::PlaywrightFileChooserSetFiles(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::DomCuaDownloadMedia(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::PlaywrightLocatorDownloadMedia(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::PlaywrightLocatorClick(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::PlaywrightLocatorDblclick(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::PlaywrightWaitForUrl(p) => check_positive_timeout(p.timeout_ms, kind)?,
        Command::PlaywrightWaitForTimeout(p) if p.timeout_ms == 0 => {
            return Err(bad("timeout_ms must be positive"))
        }
        _ => {}
    }

    if let Command::TabCdpEvents(p) = cmd {
        if let Some(limit) = p.limit {
            // Recovered buffer contract: pages of 1..=1000 events.
            if limit == 0 || limit > 1000 {
                return Err(bad("limit must be within 1..=1000"));
            }
        }
    }

    if let Command::CuaClick(p) | Command::CuaDoubleClick(p) = cmd {
        if let Some(b) = p.button {
            if !(1..=5).contains(&b) {
                return Err(bad("button must be within 1..=5"));
            }
        }
    }

    if let Command::TabAxAction(p) = cmd {
        if let AxAction::PressKey { duration, .. } = &p.action {
            // Recovered zod bound: 0..30 seconds.
            if duration.is_some_and(|d| !(0.0..=30.0).contains(&d)) {
                return Err(bad("duration must be within 0..=30 seconds"));
            }
        }
    }

    Ok(())
}

fn check_positive_timeout(timeout_ms: Option<u64>, kind: CommandKind) -> Result<(), BrowserError> {
    if timeout_ms.is_some_and(|t| t == 0) {
        return Err(payload_invalid(
            kind.as_str(),
            "timeout_ms must be positive",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ErrorCode;
    use serde_json::json;

    fn envelope(command_type: &str, payload: Value) -> Value {
        json!({
            "commandType": command_type,
            "session_id": "sess-1",
            "turn_id": "turn-1",
            "payload": payload,
        })
    }

    fn tab_payload() -> Value {
        json!({ "browser_id": "b1", "tab_id": "t1" })
    }

    #[test]
    fn registry_round_trips_every_kind() {
        let mut names = std::collections::HashSet::new();
        for kind in CommandKind::ALL {
            let n = kind.as_str();
            assert!(names.insert(n), "duplicate command name: {n}");
            assert_eq!(CommandKind::parse(n), Some(*kind), "round-trip failed: {n}");
        }
        assert_eq!(CommandKind::ALL.len(), 82);
    }

    #[test]
    fn every_registry_row_decodes_its_payload() {
        // Every tab-scoped kind decodes with the minimum `{browser_id,
        // tab_id}` payload; kinds with additional required fields are
        // listed with an augmented payload. This is the machine-level
        // proof that no registry row points at a payload type the
        // contract can't populate.
        let augment: &[(&str, Value)] = &[
            ("navigate_tab_url", json!({"url": "https://example.org/"})),
            (
                "tab_ax_action",
                json!({"action": {"kind": "type_text", "text": "x"}}),
            ),
            ("tab_ax_get_state", json!({"content": "axState"})),
            ("tab_handle_js_dialog", json!({"accept": true})),
            ("tab_content_export_gsuite", json!({"type": "pdf"})),
            ("tab_clipboard_write", json!({"items": []})),
            ("tab_clipboard_write_text", json!({"text": "hi"})),
            ("tab_cdp_call", json!({"method": "Runtime.evaluate"})),
            ("dom_cua_click", json!({"node_id": 1})),
            ("dom_cua_double_click", json!({"node_id": 1})),
            ("dom_cua_keypress", json!({"keys": ["Enter"]})),
            ("dom_cua_scroll", json!({"x": 0, "y": 100})),
            ("dom_cua_type", json!({"text": "hi"})),
            ("dom_cua_download_media", json!({"node_id": 1})),
            ("cua_click", json!({"x": 1.0, "y": 2.0})),
            ("cua_double_click", json!({"x": 1.0, "y": 2.0})),
            (
                "cua_drag",
                json!({"path": [{"x": 0.0, "y": 0.0}, {"x": 5.0, "y": 5.0}]}),
            ),
            ("cua_keypress", json!({"keys": ["a"]})),
            ("cua_move", json!({"x": 1.0, "y": 2.0})),
            (
                "cua_scroll",
                json!({"x": 1.0, "y": 2.0, "scroll_x": 0.0, "scroll_y": 10.0}),
            ),
            ("cua_type", json!({"text": "hi"})),
            ("playwright_evaluate", json!({"script": "1+1"})),
            ("playwright_wait_for_timeout", json!({"timeout_ms": 10})),
            (
                "playwright_wait_for_url",
                json!({"url": "https://example.org/"}),
            ),
            (
                "playwright_file_chooser_set_files",
                json!({"files": ["C:/x/y.png"]}),
            ),
            (
                "playwright_locator_all_text_contents",
                json!({"selector": "#a"}),
            ),
            ("playwright_locator_click", json!({"selector": "#a"})),
            ("playwright_locator_count", json!({"selector": "#a"})),
            ("playwright_locator_dblclick", json!({"selector": "#a"})),
            (
                "playwright_locator_download_media",
                json!({"selector": "#a"}),
            ),
            (
                "playwright_locator_fill",
                json!({"selector": "#a", "value": "v"}),
            ),
            (
                "playwright_locator_get_attribute",
                json!({"selector": "#a", "name": "href"}),
            ),
            ("playwright_locator_inner_text", json!({"selector": "#a"})),
            ("playwright_locator_is_enabled", json!({"selector": "#a"})),
            ("playwright_locator_is_visible", json!({"selector": "#a"})),
            (
                "playwright_locator_press",
                json!({"selector": "#a", "key": "Enter"}),
            ),
            (
                "playwright_locator_press_sequentially",
                json!({"selector": "#a", "text": "hi"}),
            ),
            ("playwright_locator_read_all", json!({"selector": "#a"})),
            (
                "playwright_locator_select_option",
                json!({"selector": "select", "option": "One"}),
            ),
            (
                "playwright_locator_set_checked",
                json!({"selector": "#c", "checked": true}),
            ),
            ("playwright_locator_text_content", json!({"selector": "#a"})),
            (
                "playwright_locator_wait_for",
                json!({"selector": "#a", "state": "visible"}),
            ),
            ("webmcp_invoke_tool", json!({"tool": "t"})),
            ("site_status", json!({"url": "https://example.org/"})),
            (
                "site_submission_verified",
                json!({"url": "https://example.org/"}),
            ),
            ("browser_session_name", json!({"name": "n"})),
            ("browser_history", json!({})),
            ("browser_clear_data", json!({})),
            ("tab_mark_handoff", json!({})),
        ];
        let extra: std::collections::HashMap<&str, Value> = augment.iter().cloned().collect();

        for kind in CommandKind::ALL {
            let base = tab_payload();
            let payload = match kind {
                // Browser-level kinds.
                CommandKind::Tabs
                | CommandKind::SiteStatus
                | CommandKind::SiteSubmissionVerified => {
                    let mut p = json!({"url": "https://example.org/"});
                    if matches!(kind, CommandKind::Tabs) {
                        p = json!({});
                    }
                    p
                }
                CommandKind::BrowserVisibilityGet | CommandKind::BrowserUserOpenTabs => {
                    json!({"browser_id": "b1"})
                }
                CommandKind::TabNew => json!({"browser_id": "b1"}),
                CommandKind::BrowserSessionName
                | CommandKind::BrowserHistory
                | CommandKind::BrowserClearData => {
                    let mut p = json!({"browser_id": "b1"});
                    if let Some(x) = extra.get(kind.as_str()) {
                        if let (Some(o), Some(xo)) = (p.as_object_mut(), x.as_object()) {
                            for (k, v) in xo {
                                o.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    p
                }
                _ => {
                    let mut p = base;
                    if let Some(x) = extra.get(kind.as_str()) {
                        if let (Some(o), Some(xo)) = (p.as_object_mut(), x.as_object()) {
                            for (k, v) in xo {
                                o.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    p
                }
            };
            let cmd = parse_command(&envelope(kind.as_str(), payload))
                .unwrap_or_else(|e| panic!("{}: {e}", kind.as_str()));
            assert_eq!(cmd.kind(), *kind);
        }
    }

    #[test]
    fn reference_pool_all_parse_to_distinct_kinds() {
        assert_eq!(REFERENCE_COMMAND_POOL.len(), 73);
        let mut kinds = std::collections::HashSet::new();
        for name in REFERENCE_COMMAND_POOL {
            let k = CommandKind::parse(name)
                .unwrap_or_else(|| panic!("§2.1 pool name not registered: {name}"));
            assert_eq!(k.as_str(), name);
            assert!(kinds.insert(k));
        }
        for name in ADAPTED_COMMAND_POOL {
            let k = CommandKind::parse(name).expect("adapted name not registered");
            assert_eq!(k.as_str(), name);
            assert!(kinds.insert(k));
        }
        assert_eq!(kinds.len(), CommandKind::ALL.len());
    }

    #[test]
    fn unknown_command_is_typed_error() {
        let e = parse_command(&envelope("not_a_command", json!({}))).unwrap_err();
        assert_eq!(e.code(), ErrorCode::UnknownCommand);
        assert!(e.to_string().contains("not_a_command"));
    }

    #[test]
    fn envelope_shape_failures() {
        assert_eq!(
            parse_command(&json!("x")).unwrap_err().code(),
            ErrorCode::BadEnvelope
        );
        assert_eq!(
            parse_command(&json!({"payload": {}})).unwrap_err().code(),
            ErrorCode::BadEnvelope
        );
        assert_eq!(
            parse_command(&json!({"commandType": 7, "session_id": "s", "turn_id": "t"}))
                .unwrap_err()
                .code(),
            ErrorCode::BadEnvelope
        );
        assert_eq!(
            parse_command(&envelope("", json!({}))).unwrap_err().code(),
            ErrorCode::BadEnvelope
        );
    }

    #[test]
    fn metadata_rule_is_faithful_to_the_recovered_check() {
        // Both missing: message enumerates both, contract order.
        let e = parse_command(&json!({
            "commandType": "tabs",
            "payload": {},
        }))
        .unwrap_err();
        assert_eq!(
            e.to_string(),
            "Missing required Ruke turn metadata: session_id, turn_id"
        );
        assert_eq!(e.code(), ErrorCode::MetadataMissing);

        // Only turn_id missing.
        let e = parse_command(&json!({
            "commandType": "tabs",
            "session_id": "s",
            "payload": {},
        }))
        .unwrap_err();
        assert_eq!(
            e.to_string(),
            "Missing required Ruke turn metadata: turn_id"
        );

        // Non-string metadata counts as missing (typeof check).
        let e = parse_command(&json!({
            "commandType": "tabs",
            "session_id": 3,
            "turn_id": null,
            "payload": {},
        }))
        .unwrap_err();
        assert_eq!(
            e.to_string(),
            "Missing required Ruke turn metadata: session_id, turn_id"
        );

        // Empty string is PRESENT (typeof "" === "string"); decoding proceeds.
        let cmd = parse_command(&json!({
            "commandType": "tabs",
            "session_id": "",
            "turn_id": "",
            "payload": {},
        }))
        .expect("empty-string metadata must pass the metadata gate");
        assert_eq!(cmd.kind(), CommandKind::Tabs);
    }

    #[test]
    fn metadata_checked_before_payload() {
        // Bad payload AND missing metadata ⇒ metadata error wins
        // (validation order is a contract rule).
        let e = parse_command(&json!({
            "commandType": "playwright_evaluate",
            "payload": {"nope": true},
        }))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::MetadataMissing);
    }

    #[test]
    fn gk_tab_target_parses_and_fails_closed() {
        // zod gk = {browser_id, tab_id} — tab_screenshot uses it.
        let cmd = parse_command(&envelope(
            "tab_screenshot",
            json!({"browser_id": "b", "tab_id": "7"}),
        ))
        .unwrap();
        assert_eq!(
            cmd,
            Command::TabScreenshot(ScreenshotPayload {
                browser_id: "b".into(),
                tab_id: "7".into(),
                clip: None,
                full_page: None,
            })
        );

        // Missing tab_id ⇒ PayloadInvalid.
        let e = parse_command(&envelope("tab_screenshot", json!({"browser_id": "b"}))).unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);
        assert!(e.to_string().contains("tab_screenshot"));
    }

    #[test]
    fn ax_get_state_content_enum_verbatim() {
        for (raw, expected) in [
            ("axState", AxStateContent::AxState),
            ("screenshot", AxStateContent::Screenshot),
            ("axStateAndScreenshot", AxStateContent::AxStateAndScreenshot),
        ] {
            let cmd = parse_command(&envelope(
                "tab_ax_get_state",
                json!({ "browser_id": "b", "tab_id": "1", "content": raw }),
            ))
            .unwrap();
            let Command::TabAxGetState(p) = cmd else {
                panic!("wrong variant");
            };
            assert_eq!(p.content, expected);
        }
        let e = parse_command(&envelope(
            "tab_ax_get_state",
            json!({ "browser_id": "b", "tab_id": "1", "content": "ax_state" }),
        ))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);
    }

    #[test]
    fn vr_evaluate_payload_and_timeout_bounds() {
        // zod VR verbatim shape.
        let cmd = parse_command(&envelope(
            "playwright_evaluate",
            json!({
                "browser_id": "b",
                "selector": "#root",
                "selector_mode": "all",
                "tab_id": "1",
                "script": "document.title",
                "timeout_ms": 1500,
            }),
        ))
        .unwrap();
        let Command::PlaywrightEvaluate(p) = cmd else {
            panic!("wrong variant");
        };
        assert_eq!(p.selector.as_deref(), Some("#root"));
        assert_eq!(p.selector_mode, Some(SelectorMode::All));
        assert_eq!(p.script, "document.title");
        assert_eq!(p.timeout_ms, Some(1500));

        // Non-integer timeout ⇒ PayloadInvalid (zod number.int).
        let e = parse_command(&envelope(
            "playwright_evaluate",
            json!({"browser_id": "b", "tab_id": "1", "script": "1", "timeout_ms": "abc"}),
        ))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);

        // timeout_ms: 0 ⇒ positive-bound rejection.
        let e = parse_command(&envelope(
            "playwright_evaluate",
            json!({"browser_id": "b", "tab_id": "1", "script": "1", "timeout_ms": 0}),
        ))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);
        assert!(e.to_string().contains("positive"));

        // Negative timeouts are structurally rejected (u64).
        let e = parse_command(&envelope(
            "playwright_evaluate",
            json!({"browser_id": "b", "tab_id": "1", "script": "1", "timeout_ms": -5}),
        ))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);

        // wait_for_timeout REQUIRES timeout_ms.
        let e = parse_command(&envelope(
            "playwright_wait_for_timeout",
            json!({"browser_id": "b", "tab_id": "1"}),
        ))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);
        // …and it must be positive.
        let e = parse_command(&envelope(
            "playwright_wait_for_timeout",
            json!({"browser_id": "b", "tab_id": "1", "timeout_ms": 0}),
        ))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);
    }

    #[test]
    fn ax_action_union_all_kinds() {
        let cases = [
            (
                json!({"kind": "paste", "text": "hi", "format": "html"}),
                "paste",
            ),
            (json!({"kind": "click", "target": 5}), "click"),
            (
                json!({"kind": "click", "target": {"x": 1.5, "y": 2.5}, "mouse_button": "r", "click_count": 2}),
                "click",
            ),
            (
                json!({"kind": "drag", "from": 1, "to": {"x": 0.0, "y": 0.0}}),
                "drag",
            ),
            (
                json!({"kind": "perform_secondary_action", "element_index": 4, "action": "Expand"}),
                "perform_secondary_action",
            ),
            (
                json!({"kind": "press_key", "key": "Enter", "duration": 30.0}),
                "press_key",
            ),
            (
                json!({"kind": "scroll", "target": 2, "direction": "u", "pages": 1.5}),
                "scroll",
            ),
            (
                json!({"kind": "select_text", "element_index": 6, "text": "abc", "prefix": "x", "suffix": "y", "selection_type": "cursor_after"}),
                "select_text",
            ),
            (
                json!({"kind": "set_value", "element_index": 8, "value": "7"}),
                "set_value",
            ),
            (
                json!({"kind": "type_text", "element_index": 9, "text": "go"}),
                "type_text",
            ),
        ];
        for (action, kind_name) in cases {
            let cmd = parse_command(&envelope(
                "tab_ax_action",
                json!({"browser_id": "b", "tab_id": "1", "action": action}),
            ))
            .unwrap_or_else(|e| panic!("{kind_name}: {e}"));
            let Command::TabAxAction(p) = cmd else {
                panic!("wrong variant");
            };
            assert_eq!(p.action.kind_name(), kind_name);
        }

        // Missing/unknown `kind` discriminator ⇒ PayloadInvalid.
        let e = parse_command(&envelope(
            "tab_ax_action",
            json!({"browser_id": "b", "tab_id": "1", "action": {"text": "x"}}),
        ))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);
        let e = parse_command(&envelope(
            "tab_ax_action",
            json!({"browser_id": "b", "tab_id": "1", "action": {"kind": "hover", "x": 1.0}}),
        ))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);

        // press_key duration bound: recovered 0..30.
        for dur in [json!(30.0), json!(0.0)] {
            parse_command(&envelope(
                "tab_ax_action",
                json!({"browser_id": "b", "tab_id": "1", "action": {"kind": "press_key", "key": "a", "duration": dur}}),
            ))
            .expect("duration within 0..=30 must pass");
        }
        for dur in [json!(31.0), json!(-1.0)] {
            let e = parse_command(&envelope(
                "tab_ax_action",
                json!({"browser_id": "b", "tab_id": "1", "action": {"kind": "press_key", "key": "a", "duration": dur}}),
            ))
            .unwrap_err();
            assert_eq!(e.code(), ErrorCode::PayloadInvalid);
        }
    }

    #[test]
    fn select_option_input_shapes() {
        // string | {index,label,value} | array — all three parse.
        for option in [
            json!("One"),
            json!({"label": "One"}),
            json!({"index": 2}),
            json!(["a", {"value": "b"}]),
        ] {
            parse_command(&envelope(
                "playwright_locator_select_option",
                json!({"browser_id": "b", "tab_id": "1", "selector": "select", "option": option}),
            ))
            .unwrap_or_else(|e| panic!("option shape rejected: {e}"));
        }
    }

    #[test]
    fn load_state_wait_until_and_wait_for_state() {
        let cmd = parse_command(&envelope(
            "playwright_wait_for_load_state",
            json!({"browser_id": "b", "tab_id": "1", "state": "domcontentloaded"}),
        ))
        .unwrap();
        let Command::PlaywrightWaitForLoadState(p) = cmd else {
            panic!("wrong variant");
        };
        assert_eq!(p.state, Some(LoadState::DomContentLoaded));

        let cmd = parse_command(&envelope(
            "playwright_wait_for_url",
            json!({"browser_id": "b", "tab_id": "1", "url": "https://e.org/x", "wait_until": "commit"}),
        ))
        .unwrap();
        let Command::PlaywrightWaitForUrl(p) = cmd else {
            panic!("wrong variant");
        };
        assert_eq!(p.wait_until, Some(WaitUntil::Commit));

        let e = parse_command(&envelope(
            "playwright_locator_wait_for",
            json!({"browser_id": "b", "tab_id": "1", "selector": "#a", "state": "ready"}),
        ))
        .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PayloadInvalid);
    }

    #[test]
    fn cua_button_bounds() {
        for b in [1u8, 3, 5] {
            parse_command(&envelope(
                "cua_click",
                json!({"browser_id": "b", "tab_id": "1", "x": 1.0, "y": 2.0, "button": b}),
            ))
            .unwrap_or_else(|e| panic!("button {b}: {e}"));
        }
        for b in [0u8, 6] {
            let e = parse_command(&envelope(
                "cua_click",
                json!({"browser_id": "b", "tab_id": "1", "x": 1.0, "y": 2.0, "button": b}),
            ))
            .unwrap_err();
            assert_eq!(e.code(), ErrorCode::PayloadInvalid);
        }
    }

    #[test]
    fn cdp_events_page_cap() {
        for limit in [1u64, 1000] {
            parse_command(&envelope(
                "tab_cdp_events",
                json!({"browser_id": "b", "tab_id": "1", "cursor": 0, "limit": limit}),
            ))
            .unwrap_or_else(|e| panic!("limit {limit}: {e}"));
        }
        for limit in [0u64, 1001] {
            let e = parse_command(&envelope(
                "tab_cdp_events",
                json!({"browser_id": "b", "tab_id": "1", "limit": limit}),
            ))
            .unwrap_err();
            assert_eq!(e.code(), ErrorCode::PayloadInvalid);
            assert!(e.to_string().contains("1..=1000"));
        }
    }

    #[test]
    fn browser_visibility_get_wire_sample() {
        // Recovered: payload {browser_id} → {visible:boolean} (response
        // shape is the engine's; here the request decodes).
        let cmd = parse_command(&envelope(
            "browser_visibility_get",
            json!({"browser_id": "b1"}),
        ))
        .unwrap();
        assert_eq!(
            cmd,
            Command::BrowserVisibilityGet(BrowserOnly {
                browser_id: "b1".into()
            })
        );
    }

    #[test]
    fn absent_payload_decodes_optionals() {
        let cmd = parse_command(&json!({
            "commandType": "tabs",
            "session_id": "s",
            "turn_id": "t",
        }))
        .unwrap();
        assert_eq!(cmd, Command::Tabs(TabListQuery { browser_id: None }));
    }
}
