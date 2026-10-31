//! tools.rs — the MODEL-FACING tool surface of the browser engine
//! (Browser Use, Phase 10). The chat pipeline injects `model_tools()`
//! into the upstream request for browser turns; the Rust tool loop
//! (`ruke-server chat/browser_loop`) dispatches each call through the
//! SAME validated envelope path the panel RPC uses
//! ([`crate::contract::parse_envelope`] → [`crate::engine::BrowserRuntime::command`]).
//!
//! Surface policy (pinned by the tests below):
//! - every exposed name must be a registry [`crate::contract::CommandKind`]
//!   AND have a real executor arm — an exposed tool can never hit the
//!   `Unsupported` catch-all, so the model is never handed a fake tool;
//! - the raw-CDP pair (`tab_cdp_call`/`tab_cdp_events`) is never exposed:
//!   raw CDP bypasses the DOM/AX contracts and is authority-gated by the
//!   `full_cdp_access` facet for the human panel only;
//! - the human-side handoff pair (`browser_user_open_tabs`/
//!   `browser_user_claim_tab`) is never exposed: claiming a tab is a
//!   human gesture (the Browser Panel owns it), mirroring the reference
//!   product's shared-tab rule.
//!
//! `browser_id` is deliberately absent from every schema: the tool loop
//! injects the default browser before decoding, so the model never has
//! to (and cannot) address a browser by id [adapted — the reference pool
//! carries it; Ruke has exactly one engine-owned browser].

use serde_json::{json, Value};

/// Commands the executor implements but the MODEL must never see.
pub const NOT_MODEL_EXPOSED: &[&str] = &[
    "tab_cdp_call",
    "tab_cdp_events",
    "browser_user_open_tabs",
    "browser_user_claim_tab",
];

/// The OpenAI function-tool array injected on browser turns. One entry
/// per implemented command minus [`NOT_MODEL_EXPOSED`]; schemas mirror
/// the decoded payload structs in [`crate::schemas`] (snake_case wire
/// keys verbatim).
pub fn model_tools() -> Value {
    let tab = || json!({"type": "string", "description": "tab id from a `tabs` listing"});
    // Any-typed schema slot (a bare `{}` is not a legal nested json! value).
    let any = || json!({});
    let timeout =
        || json!({"type": "integer", "minimum": 1, "description": "max wait in milliseconds"});
    let clip = || {
        json!({"type": "object", "properties": {
            "x": {"type": "number"}, "y": {"type": "number"},
            "width": {"type": "number"}, "height": {"type": "number"}
        }, "required": ["x", "y", "width", "height"]})
    };

    let mut tools: Vec<Value> = Vec::new();
    let mut t = |name: &str, desc: &str, props: Value, req: &[&str]| {
        tools.push(json!({
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": {
                    "type": "object",
                    "properties": props,
                    "required": req,
                    "additionalProperties": false
                }
            }
        }));
    };

    // ── tabs / navigation ───────────────────────────────────────────────
    t(
        "tabs",
        "List the browser's open tabs (tab_id, url, title, which are human-owned or taken over).",
        json!({}),
        &[],
    );
    t(
        "get_tab",
        "Read one tab's current url/title state.",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "tab_new",
        "Open a new browser tab (http/https/about:blank only) and return its tab_id.",
        json!({"url": {"type": "string"}}),
        &[],
    );
    t(
        "tab_close",
        "Close a tab you created or were given.",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "navigate_tab_url",
        "Navigate a tab to an http(s) or about:blank url; answers with the settled url/title.",
        json!({"tab_id": tab(), "url": {"type": "string"}}),
        &["tab_id", "url"],
    );
    t(
        "navigate_tab_back",
        "History-back one page in a tab.",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "navigate_tab_forward",
        "History-forward one page in a tab.",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "navigate_tab_reload",
        "Reload the tab's current page.",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "browser_session_name",
        "Give this browser session a short human-facing name shown in the panel.",
        json!({"name": {"type": "string", "minLength": 1}}),
        &["name"],
    );

    // ── reading the page ────────────────────────────────────────────────
    t(
        "tab_ax_get_state",
        "Read the tab's accessibility state (element_index refs for tab_ax_action), a screenshot, or both. A screenshot answer is a text summary: the human sees the real capture live in the panel.",
        json!({
            "tab_id": tab(),
            "content": {"enum": ["axState", "screenshot", "axStateAndScreenshot"]},
            "disable_diffing": {"type": "boolean", "description": "set true to force a full (non-diffed) snapshot"}
        }),
        &["tab_id", "content"],
    );
    t(
        "dom_cua_get_visible_dom",
        "Read the visible DOM as a tree with stable node_id refs for dom_cua_* actions.",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "playwright_dom_snapshot",
        "Playwright-style aria snapshot with role/name selector refs (locator_* tools act on them).",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "tab_screenshot",
        "Capture a JPEG of the tab (viewport or full page). The answer is a text summary; the human sees the real capture in the panel.",
        json!({"tab_id": tab(), "clip": clip(), "full_page": {"type": "boolean"}}),
        &["tab_id"],
    );
    t(
        "playwright_element_screenshot",
        "Capture the element matching a selector. Answer is a text summary; the panel shows the real capture.",
        json!({"tab_id": tab(), "clip": clip(), "full_page": {"type": "boolean"}, "selector": {"type": "string"}}),
        &["tab_id"],
    );
    t(
        "playwright_element_info",
        "Describe the interactable element at a viewport point (or list interactables).",
        json!({
            "tab_id": tab(),
            "x": {"type": "number"}, "y": {"type": "number"},
            "include_non_interactable": {"type": "boolean"}
        }),
        &["tab_id"],
    );
    t(
        "playwright_evaluate",
        "Run a JS function body in the page (optionally against a selector element as `el`); the return value must be JSON-serializable.",
        json!({
            "tab_id": tab(),
            "script": {"type": "string"},
            "selector": {"type": "string"},
            "selector_mode": {"enum": ["all"]},
            "timeout_ms": timeout()
        }),
        &["tab_id", "script"],
    );
    t(
        "tab_get_js_dialog",
        "Check whether the tab currently has a blocking JavaScript alert/confirm/prompt open.",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "playwright_wait_for_load_state",
        "Wait until the tab reaches a load state.",
        json!({
            "tab_id": tab(),
            "state": {"enum": ["load", "domcontentloaded", "networkidle"]},
            "timeout_ms": timeout()
        }),
        &["tab_id"],
    );
    t(
        "playwright_wait_for_timeout",
        "Wait a fixed time (positive milliseconds) — use sparingly; prefer load-state waits.",
        json!({"tab_id": tab(), "timeout_ms": {"type": "integer", "minimum": 1}}),
        &["tab_id", "timeout_ms"],
    );
    t(
        "playwright_wait_for_url",
        "Wait until the tab's url matches (glob or regex).",
        json!({
            "tab_id": tab(),
            "url": {"type": "string"},
            "timeout_ms": timeout(),
            "wait_until": {"enum": ["commit", "load", "domcontentloaded", "networkidle"]}
        }),
        &["tab_id", "url"],
    );

    // ── acting on the page ──────────────────────────────────────────────
    t(
        "tab_ax_action",
        "Act on an accessibility ref from the latest tab_ax_get_state. `action` is a tagged object: {kind, …} where kind is one of paste{element_index?,text,format?}, click{target: element_index or {x,y}, mouse_button?, click_count?}, drag{from:{x,y},to:{x,y}}, perform_secondary_action{element_index,action}, press_key{element_index?,key,duration?}, scroll{target,direction,pages?}, select_text{element_index,text,prefix?,suffix?,selection_type?}, set_value{element_index,value}, type_text{element_index?,text}. A stale ref means the page changed: re-read first.",
        json!({
            "tab_id": tab(),
            "action": {
                "type": "object",
                "properties": {
                    "kind": {"enum": ["paste", "click", "drag", "perform_secondary_action", "press_key", "scroll", "select_text", "set_value", "type_text"]},
                    "element_index": {"type": "integer"},
                    "target": any(),
                    "from":{"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}, "required": ["x", "y"]},
                    "to": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}, "required": ["x", "y"]},
                    "text": {"type": "string"},
                    "value": {"type": "string"},
                    "format": {"enum": ["text", "md", "html"]},
                    "key": {"type": "string"},
                    "duration": {"type": "integer", "minimum": 0, "maximum": 30},
                    "mouse_button": {"enum": ["left", "right", "middle", "l", "r", "m"]},
                    "click_count": {"type": "integer", "minimum": 1},
                    "direction": {"enum": ["up", "down", "left", "right", "u", "d", "l", "r"]},
                    "pages": {"type": "number"},
                    "prefix": {"type": "string"},
                    "suffix": {"type": "string"},
                    "selection_type": {"enum": ["text", "cursor_before", "cursor_after"]},
                    "action": {"type": "string"}
                },
                "required": ["kind"]
            }
        }),
        &["tab_id", "action"],
    );
    t(
        "dom_cua_click",
        "Click a node_id from the latest dom_cua_get_visible_dom.",
        json!({"tab_id": tab(), "node_id": {"type": "integer"}}),
        &["tab_id", "node_id"],
    );
    t(
        "dom_cua_double_click",
        "Double-click a node_id from the latest dom_cua_get_visible_dom.",
        json!({"tab_id": tab(), "node_id": {"type": "integer"}}),
        &["tab_id", "node_id"],
    );
    t(
        "dom_cua_keypress",
        "Send key strokes (e.g. [\"Enter\"], [\"Control\",\"a\"]) to the tab.",
        json!({"tab_id": tab(), "keys": {"type": "array", "items": {"type": "string"}}}),
        &["tab_id", "keys"],
    );
    t(
        "dom_cua_scroll",
        "Scroll the page (or a node) by pixel deltas.",
        json!({
            "tab_id": tab(),
            "node_id": {"type": "integer"},
            "x": {"type": "integer"}, "y": {"type": "integer"}
        }),
        &["tab_id", "x", "y"],
    );
    t(
        "dom_cua_type",
        "Type text into the tab's focused element.",
        json!({"tab_id": tab(), "text": {"type": "string"}}),
        &["tab_id", "text"],
    );
    t(
        "dom_cua_download_media",
        "Save an <img>/<video>/<canvas> node (node_id) to a file the human can open.",
        json!({"tab_id": tab(), "node_id": {"type": "integer"}, "timeout_ms": timeout()}),
        &["tab_id", "node_id"],
    );
    t(
        "tab_handle_js_dialog",
        "Accept or dismiss the tab's currently open JavaScript dialog (check it with tab_get_js_dialog).",
        json!({"tab_id": tab(), "accept": {"type": "boolean"}, "prompt_text": {"type": "string"}}),
        &["tab_id", "accept"],
    );

    // ── locators (Playwright-style refs from playwright_dom_snapshot) ───
    let sel = || json!({"type": "string", "description": "snapshot selector/ref"});
    t(
        "playwright_locator_read_all",
        "List every locator resolved from the snapshot.",
        json!({"tab_id": tab(), "selector": sel()}),
        &["tab_id", "selector"],
    );
    t(
        "playwright_locator_count",
        "Count elements matching a selector.",
        json!({"tab_id": tab(), "selector": sel()}),
        &["tab_id", "selector"],
    );
    t(
        "playwright_locator_inner_text",
        "Read the rendered innerText of a locator.",
        json!({"tab_id": tab(), "selector": sel()}),
        &["tab_id", "selector"],
    );
    t(
        "playwright_locator_text_content",
        "Read the textContent of a locator.",
        json!({"tab_id": tab(), "selector": sel()}),
        &["tab_id", "selector"],
    );
    t(
        "playwright_locator_all_text_contents",
        "Read textContent of every element matching a locator.",
        json!({"tab_id": tab(), "selector": sel()}),
        &["tab_id", "selector"],
    );
    t(
        "playwright_locator_get_attribute",
        "Read one attribute value from a locator.",
        json!({"tab_id": tab(), "selector": sel(), "name": {"type": "string"}}),
        &["tab_id", "selector", "name"],
    );
    t(
        "playwright_locator_is_enabled",
        "Whether the locator's element is enabled.",
        json!({"tab_id": tab(), "selector": sel()}),
        &["tab_id", "selector"],
    );
    t(
        "playwright_locator_is_visible",
        "Whether the locator's element is visible.",
        json!({"tab_id": tab(), "selector": sel()}),
        &["tab_id", "selector"],
    );
    let click_props = || json!({"tab_id": tab(), "selector": sel(), "button": {"enum": ["left", "right", "middle"]}, "click_count": {"type": "integer", "minimum": 1}, "force": {"type": "boolean"}, "modifiers": {"type": "array", "items": {"enum": ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]}}, "timeout_ms": timeout()});
    t(
        "playwright_locator_click",
        "Click the locator's element.",
        click_props(),
        &["tab_id", "selector"],
    );
    t(
        "playwright_locator_dblclick",
        "Double-click the locator's element.",
        click_props(),
        &["tab_id", "selector"],
    );
    t(
        "playwright_locator_fill",
        "Replace the input/textarea value of a locator.",
        json!({"tab_id": tab(), "selector": sel(), "value": {"type": "string"}}),
        &["tab_id", "selector", "value"],
    );
    t(
        "playwright_locator_press",
        "Press one key (e.g. \"Enter\") on a locator.",
        json!({"tab_id": tab(), "selector": sel(), "key": {"type": "string"}, "delay": {"type": "integer", "minimum": 0}}),
        &["tab_id", "selector", "key"],
    );
    t(
        "playwright_locator_press_sequentially",
        "Type text into a locator key by key.",
        json!({"tab_id": tab(), "selector": sel(), "text": {"type": "string"}, "delay": {"type": "integer", "minimum": 0}}),
        &["tab_id", "selector", "text"],
    );
    t(
        "playwright_locator_select_option",
        "Select an option in a <select> by value/label/index.",
        json!({"tab_id": tab(), "selector": sel(), "option": any()}),
        &["tab_id", "selector", "option"],
    );
    t(
        "playwright_locator_set_checked",
        "Check or uncheck a checkbox/radio locator.",
        json!({"tab_id": tab(), "selector": sel(), "checked": {"type": "boolean"}}),
        &["tab_id", "selector", "checked"],
    );
    t(
        "playwright_locator_wait_for",
        "Wait for a locator's state.",
        json!({"tab_id": tab(), "selector": sel(), "state": {"enum": ["attached", "detached", "visible", "hidden"]}, "timeout_ms": timeout()}),
        &["tab_id", "selector", "state"],
    );
    t(
        "playwright_locator_download_media",
        "Save the media element a locator matches to a file the human can open.",
        json!({"tab_id": tab(), "selector": sel(), "timeout_ms": timeout()}),
        &["tab_id", "selector"],
    );

    // ── downloads / file chooser ────────────────────────────────────────
    t(
        "playwright_wait_for_download",
        "Arm a download wait on the tab, then read where the file lands with playwright_download_path.",
        json!({"tab_id": tab(), "timeout_ms": timeout()}),
        &["tab_id"],
    );
    t(
        "playwright_download_path",
        "Answer the file path of the tab's armed/completed download.",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "playwright_wait_for_file_chooser",
        "Arm a file-chooser wait: click the upload control, then supply files with playwright_file_chooser_set_files.",
        json!({"tab_id": tab(), "timeout_ms": timeout()}),
        &["tab_id"],
    );
    t(
        "playwright_file_chooser_set_files",
        "Complete an armed file chooser with file paths (uploads are authority-gated).",
        json!({"tab_id": tab(), "files": {"type": "array", "items": {"type": "string"}, "minItems": 1}, "multiple": {"type": "boolean"}, "timeout_ms": timeout()}),
        &["tab_id", "files"],
    );

    // ── handoffs / human-participation ──────────────────────────────────
    t(
        "tab_mark_deliverable",
        "Mark the tab the user should keep this turn (all other tabs you opened are cleaned at turn end).",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "tab_mark_handoff",
        "Mark a tab as the one being handed to the human (protected from turn-end cleanup).",
        json!({"tab_id": tab()}),
        &["tab_id"],
    );
    t(
        "tab_manual_handoff_request",
        "Hand the tab to the human (captcha, login they must do, or an explicit user request). The tab locks to them until they return it.",
        json!({"tab_id": tab(), "reason": {"enum": ["authentication", "captcha", "user_requested", "other"]}}),
        &["tab_id"],
    );
    t(
        "tab_browser_auth_handoff",
        "Ask the HUMAN to supply sign-in credentials through the Browser Panel — you never see or type passwords/OTPs. Describe the fields you detected (id/label/type/selector), optional sign-in options, or qr_code=true. The filled result never carries the values.",
        json!({
            "tab_id": tab(),
            "origin": {"type": "string", "description": "absolute http(s) origin of the sign-in page"},
            "account_identifier": {"type": "string", "description": "only for a password-only sign-in the human already authorized"},
            "fields": {"type": "array", "maxItems": 6, "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"}, "label": {"type": "string"},
                    "type": {"type": "string"}, "autocomplete": {"type": "string"},
                    "required": {"type": "boolean"}, "selector": {"type": "string"}
                },
                "required": ["id", "label", "type", "selector"]
            }},
            "options": {"type": "array", "minItems": 2, "maxItems": 10, "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"}, "label": {"type": "string", "maxLength": 120},
                    "selector": {"type": "string"},
                    "field_ids": {"type": "array", "maxItems": 6, "items": {"type": "string"}}
                },
                "required": ["id", "label"]
            }},
            "qr_code": {"const": true},
            "submit": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "action": {"enum": ["click", "press_enter"]}
                },
                "required": ["selector", "action"]
            }
        }),
        &["tab_id", "origin"],
    );
    t(
        "tab_bot_detection_report",
        "Report that the site blocked the visit as a bot (never attempt to bypass detection yourself).",
        json!({"tab_id": tab(), "reason": {"enum": ["captcha_failed", "access_denied", "challenge_loop", "sign_in_blocked", "add_to_cart_blocked", "purchase_blocked", "unexpected_bot_error"]}}),
        &["tab_id", "reason"],
    );

    json!(tools)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::CommandKind;

    fn exposed_names() -> Vec<String> {
        model_tools()
            .as_array()
            .unwrap()
            .iter()
            .map(|tc| tc["function"]["name"].as_str().unwrap().to_string())
            .collect()
    }

    /// Every exposed tool name is a REAL registry kind (round-trips
    /// through `CommandKind::parse`), so the loop's envelope path can
    /// never answer `browser_command_unknown`.
    #[test]
    fn every_exposed_tool_is_a_registry_command() {
        for name in exposed_names() {
            let kind =
                CommandKind::parse(&name).unwrap_or_else(|| panic!("not a registry kind: {name}"));
            assert_eq!(kind.as_str(), name);
        }
    }

    /// Every exposed tool must have a real executor arm INSIDE the
    /// `match cmd` of `execute()` (up to the `Unsupported` catch-all):
    /// the model is never handed a tool that honestly refuses itself.
    #[test]
    fn every_exposed_tool_has_a_real_executor_arm() {
        let src = include_str!("../src/executor.rs");
        let start = src.find("match cmd {").expect("execute() match site");
        let end = src
            .find("other => Err(BrowserError::Unsupported")
            .expect("Unsupported catch-all site");
        assert!(start < end);
        let region = &src[start..end];
        for name in exposed_names() {
            let variant = format!("{:?}", CommandKind::parse(&name).unwrap());
            assert!(
                region.contains(&format!("Command::{variant}(")),
                "exposed tool {name} has no executor arm before the Unsupported catch-all"
            );
        }
    }

    /// The deliberately-unexposed commands stay unexposed, and the
    /// tool-array shape is a valid OpenAI function-tool list.
    #[test]
    fn handoff_and_cdp_pairs_are_never_model_exposed() {
        let names = exposed_names();
        for name in NOT_MODEL_EXPOSED {
            assert!(
                !names.iter().any(|n| n == name),
                "{name} leaked into the model surface"
            );
            assert!(
                CommandKind::parse(name).is_some(),
                "NOT_MODEL_EXPOSED drift: {name}"
            );
        }
        let arr = model_tools();
        let arr = arr.as_array().unwrap();
        assert_eq!(arr.len(), names.len());
        for tc in arr {
            assert_eq!(tc["type"], json!("function"));
            assert_eq!(tc["function"]["parameters"]["type"], json!("object"));
            // browser_id is the loop's job, never the model's.
            assert!(
                tc["function"]["parameters"]["properties"]
                    .get("browser_id")
                    .is_none(),
                "browser_id must not be model-settable"
            );
        }
    }
}
