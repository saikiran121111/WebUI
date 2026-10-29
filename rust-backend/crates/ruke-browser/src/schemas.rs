//! Typed command payloads.
//!
//! Field names/shapes mirror the recovered zod payload objects verbatim
//! where they were recovered (gk, yk, qR, $R, p1, VR — see
//! `schemas-and-ipc.md` §2), and the api.json option surfaces (Appendix
//! A) for the rest. Wire keys are snake_case uniformly `[adapted]` from
//! api.json's camelCase option names (the §2 zod layer itself uses
//! snake_case: `timeout_ms`, `disable_diffing`, `selector_mode`); enum
//! VALUES stay verbatim reference strings (`"axState"`,
//! `"domcontentloaded"`, `"ControlOrMeta"`, `"cursor_before"`).
//!
//! Numeric bounds enforced here match the recovered zod constraints
//! (e.g. `timeout_ms` `m.number().int().positive()`, press-key
//! `duration` 0..30, cua `button` 1..5).

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Shared geometry / primitives ──────────────────────────────────────

/// Viewport-coordinate point (`$v` click point / cua coordinates).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
pub struct Xy {
    pub x: f64,
    pub y: f64,
}

/// ScreenshotOptions.clip (api.json ClipRect).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
pub struct ClipRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The payload every tab-scoped command carries: `{browser_id,tab_id}`
/// (zod `gk`/`p1` verbatim).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct TabTarget {
    pub browser_id: String,
    pub tab_id: String,
}

/// Payload for browser-level commands that take only `{browser_id}`
/// (`browser_visibility_get` verbatim payload shape, api.json Browser
/// entry points).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BrowserOnly {
    pub browser_id: String,
}

/// `{text}`-only payloads (`cua_type`, `dom_cua_type`,
/// `tab_clipboard_write_text`).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct TextPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub text: String,
}

/// `{keys[]}`-only payloads (zod `yk` verbatim:
/// `{browser_id,tab_id,keys:m.array(m.string())}`), shared by
/// `dom_cua_keypress` and `cua_keypress`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct KeysPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub keys: Vec<String>,
}

// ── Navigation / tabs ─────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct TabListQuery {
    /// Absent ⇒ the default browser (api.json `browsers.getDefault`).
    #[serde(default)]
    pub browser_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct NavigateUrlPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct TabNewPayload {
    pub browser_id: String,
    #[serde(default)]
    pub url: Option<String>,
}

// ── AX surface (zod qR / $R verbatim) ────────────────────────────────

/// `content: m.enum(["axState","screenshot","axStateAndScreenshot"])`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum AxStateContent {
    #[serde(rename = "axState")]
    AxState,
    #[serde(rename = "screenshot")]
    Screenshot,
    #[serde(rename = "axStateAndScreenshot")]
    AxStateAndScreenshot,
}

/// `qR = {browser_id,tab_id,content,disable_diffing?}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct AxGetStatePayload {
    pub browser_id: String,
    pub tab_id: String,
    pub content: AxStateContent,
    #[serde(default)]
    pub disable_diffing: Option<bool>,
}

/// AX target for click/scroll/drag actions: `element_index` (resolution
/// via `targetForElement`) or a `{x,y}` point.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum AxTarget {
    ElementIndex(u64),
    Point(Xy),
}

/// AX mouse buttons including the recovered single-letter aliases
/// (`left|right|middle|l|r|m`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum AxMouseButton {
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(rename = "middle")]
    Middle,
    #[serde(rename = "l")]
    L,
    #[serde(rename = "r")]
    R,
    #[serde(rename = "m")]
    M,
}

/// Scroll direction union (AXAPI: `up|down|left|right|u|d|l|r`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum ScrollDirection {
    #[serde(rename = "up")]
    Up,
    #[serde(rename = "down")]
    Down,
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(rename = "u")]
    U,
    #[serde(rename = "d")]
    D,
    #[serde(rename = "l")]
    L,
    #[serde(rename = "r")]
    R,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum PasteFormat {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "md")]
    Md,
    #[serde(rename = "html")]
    Html,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum AxSelectionType {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "cursor_before")]
    CursorBefore,
    #[serde(rename = "cursor_after")]
    CursorAfter,
}

/// The action dispatch union `WR` (dom-snapshot §5, verbatim field
/// lists): paste / click / drag / perform_secondary_action / press_key /
/// scroll / select_text / set_value / type_text.
///
/// `[adapted]` wire form: the recovered union is structural, but two
/// members (`paste` and `type_text`) share the identical field shape
/// `{element_index?, text}`, so a structural discriminator is impossible;
/// the Ruke wire tags the union with an explicit `"kind"` key carrying
/// the recovered variant names. Behavior is unchanged.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AxAction {
    Paste {
        #[serde(default)]
        element_index: Option<u64>,
        text: String,
        #[serde(default)]
        format: Option<PasteFormat>,
    },
    Click {
        target: AxTarget,
        #[serde(default)]
        mouse_button: Option<AxMouseButton>,
        #[serde(default)]
        click_count: Option<u32>,
    },
    Drag {
        from: AxTarget,
        to: AxTarget,
    },
    PerformSecondaryAction {
        element_index: u64,
        action: String,
    },
    PressKey {
        #[serde(default)]
        element_index: Option<u64>,
        key: String,
        /// 0..30 seconds (recovered zod bound).
        #[serde(default)]
        duration: Option<f64>,
    },
    Scroll {
        target: AxTarget,
        direction: ScrollDirection,
        #[serde(default)]
        pages: Option<f64>,
    },
    SelectText {
        element_index: u64,
        text: String,
        #[serde(default)]
        prefix: Option<String>,
        #[serde(default)]
        suffix: Option<String>,
        #[serde(default)]
        selection_type: Option<AxSelectionType>,
    },
    SetValue {
        element_index: u64,
        value: String,
    },
    TypeText {
        #[serde(default)]
        element_index: Option<u64>,
        text: String,
    },
}

impl AxAction {
    /// Recovered variant name as it appears in the JS-dialog interrupt
    /// message (`Browser action "${kind}" interrupted by …`).
    pub fn kind_name(&self) -> &'static str {
        match self {
            AxAction::Paste { .. } => "paste",
            AxAction::Click { .. } => "click",
            AxAction::Drag { .. } => "drag",
            AxAction::PerformSecondaryAction { .. } => "perform_secondary_action",
            AxAction::PressKey { .. } => "press_key",
            AxAction::Scroll { .. } => "scroll",
            AxAction::SelectText { .. } => "select_text",
            AxAction::SetValue { .. } => "set_value",
            AxAction::TypeText { .. } => "type_text",
        }
    }
}

/// `$R = {browser_id,tab_id,action:WR}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct AxActionPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub action: AxAction,
}

// ── Screenshots / dialogs ─────────────────────────────────────────────

/// ScreenshotOptions (`{clip?, fullPage?}`; keys snake-cased `[adapted]`).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ScreenshotPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub clip: Option<ClipRect>,
    #[serde(default)]
    pub full_page: Option<bool>,
}

/// Dialog handling: `confirm`/`prompt` accept+dismiss, `alert` dismiss
/// only, `prompt` accept carries the text. `beforeunload` is dismissed by
/// the engine's dialog race (Phase 8), never through this payload.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct HandleJsDialogPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub accept: bool,
    #[serde(default)]
    pub prompt_text: Option<String>,
}

// ── Content export / clipboard ────────────────────────────────────────

/// TabsContentOptions.contentType (`html|text|domSnapshot`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum ContentFormat {
    #[serde(rename = "html")]
    Html,
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "domSnapshot")]
    DomSnapshot,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ContentExportPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub format: Option<ContentFormat>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// TabsContentOptions.urls — restrict export to these URLs.
    #[serde(default)]
    pub urls: Option<Vec<String>>,
}

/// ContentAPI.exportGsuite(type: `pdf|md|xlsx|csv|docx|pptx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum GsuiteDocType {
    #[serde(rename = "pdf")]
    Pdf,
    #[serde(rename = "md")]
    Md,
    #[serde(rename = "xlsx")]
    Xlsx,
    #[serde(rename = "csv")]
    Csv,
    #[serde(rename = "docx")]
    Docx,
    #[serde(rename = "pptx")]
    Pptx,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct GsuiteExportPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(rename = "type")]
    pub doc_type: GsuiteDocType,
}

/// TabClipboardEntry (`{base64?, mimeType?, text?}` → snake keys).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ClipboardEntry {
    #[serde(default)]
    pub base64: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

/// TabClipboardItem (`{entries[], presentationStyle?}`).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ClipboardItem {
    pub entries: Vec<ClipboardEntry>,
    #[serde(default)]
    pub presentation_style: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ClipboardWritePayload {
    pub browser_id: String,
    pub tab_id: String,
    pub items: Vec<ClipboardItem>,
}

// ── CDP / assets ──────────────────────────────────────────────────────

/// Raw CDP call — gated by the `full_cdp_access` facet (Phase 9); never
/// exposed automatically.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CdpCallPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

/// Bounded event buffer paging: cursor semantics are `1..=1000` items
/// per page (recovered buffer contract; enforced by the engine — the
/// schema only rejects non-positive limits).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CdpEventsPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub cursor: Option<u64>,
    #[serde(default)]
    pub limit: Option<u64>,
}

// ── Dev logs / handoff ────────────────────────────────────────────────

/// TabDevLogsOptions levels (Playwright-style console levels).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum DevLogLevel {
    #[serde(rename = "verbose")]
    Verbose,
    #[serde(rename = "info")]
    Info,
    #[serde(rename = "warning")]
    Warning,
    #[serde(rename = "error")]
    Error,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct DevLogsPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub levels: Option<Vec<DevLogLevel>>,
    #[serde(default)]
    pub limit: Option<u64>,
}

/// Tab.requestUserTakeover reason union (api.json, verbatim).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum HandoffReason {
    #[serde(rename = "authentication")]
    Authentication,
    #[serde(rename = "captcha")]
    Captcha,
    #[serde(rename = "user_requested")]
    UserRequested,
    #[serde(rename = "other")]
    Other,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct HandoffPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub reason: Option<HandoffReason>,
}

// ── DOM CUA ───────────────────────────────────────────────────────────

/// DomClickOptions `{node_id}` (shared by click/double_click).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct DomNodePayload {
    pub browser_id: String,
    pub tab_id: String,
    pub node_id: u64,
}

/// DomScrollOptions `{node_id?, x, y}` (pixel wheel deltas).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct DomScrollPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub node_id: Option<u64>,
    pub x: i64,
    pub y: i64,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct DomDownloadMediaPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub node_id: u64,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

// ── Screen-coordinate CUA ─────────────────────────────────────────────

/// ClickOptions `{button?:1..=5, keypress?[], x, y}`. In Ruke the
/// coordinates are screencast-viewport pixels (the shared visible
/// session), NOT OS-desktop pixels `[adapted]` — the model and the human
/// address the same tab state.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CuaClickPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub button: Option<u8>,
    #[serde(default)]
    pub keys: Option<Vec<String>>,
}

/// DragOptions `{keys?, path:[{x,y}]}` (the engine interpolates the
/// recovered 8-point dragPath when the caller supplies endpoints).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CuaDragPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub path: Vec<Xy>,
    #[serde(default)]
    pub keys: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CuaMovePayload {
    pub browser_id: String,
    pub tab_id: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub keys: Option<Vec<String>>,
}

/// CUAAPI.scroll `{keypress?, scrollX, scrollY, x, y}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct CuaScrollPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub x: f64,
    pub y: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    #[serde(default)]
    pub keys: Option<Vec<String>>,
}

// ── Playwright-equivalent layer ───────────────────────────────────────

/// `VR` verbatim:
/// `{browser_id, selector?, selector_mode:"all"?, tab_id, script,
///   timeout_ms?:int>0}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct EvaluatePayload {
    pub browser_id: String,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub selector_mode: Option<SelectorMode>,
    pub tab_id: String,
    pub script: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum SelectorMode {
    #[serde(rename = "all")]
    All,
}

/// PlaywrightAPI.elementInfo `{includeNonInteractable?, x, y}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ElementInfoPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub include_non_interactable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct TimeoutPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// `playwright_wait_for_timeout` requires a positive timeout (the
/// recovered tool schema has no default wait).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct RequiredTimeoutPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub timeout_ms: u64,
}

/// LoadState (`load|domcontentloaded|networkidle`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum LoadState {
    #[serde(rename = "load")]
    Load,
    #[serde(rename = "domcontentloaded")]
    DomContentLoaded,
    #[serde(rename = "networkidle")]
    NetworkIdle,
}

/// WaitUntil = LoadState | "commit".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum WaitUntil {
    #[serde(rename = "commit")]
    Commit,
    #[serde(rename = "load")]
    Load,
    #[serde(rename = "domcontentloaded")]
    DomContentLoaded,
    #[serde(rename = "networkidle")]
    NetworkIdle,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct WaitForLoadStatePayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub state: Option<LoadState>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct WaitForUrlPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub url: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub wait_until: Option<WaitUntil>,
}

/// FileChooserFiles (`files: Vec<String>`) + `multiple` + timeout.
/// Paths are validated by the engine against the upload facet (Phase 8/9).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct FileChooserSetFilesPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub files: Vec<String>,
    #[serde(default)]
    pub multiple: Option<bool>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

// ── Locator layer ─────────────────────────────────────────────────────

/// Base locator payload: `{browser_id, tab_id, selector}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
}

/// KeyboardModifier (api.json, verbatim values).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum KeyboardModifier {
    #[serde(rename = "Alt")]
    Alt,
    #[serde(rename = "Control")]
    Control,
    #[serde(rename = "ControlOrMeta")]
    ControlOrMeta,
    #[serde(rename = "Meta")]
    Meta,
    #[serde(rename = "Shift")]
    Shift,
}

/// MouseButton (locator form: no single-letter aliases).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum MouseButton {
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(rename = "middle")]
    Middle,
}

/// LocatorClickOptions `{button?, clickCount?, force?, modifiers?, timeoutMs?}`
/// (shared by click/dblclick — dblclick forces clickCount=2 in the engine).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorClickPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
    #[serde(default)]
    pub button: Option<MouseButton>,
    #[serde(default)]
    pub click_count: Option<u32>,
    #[serde(default)]
    pub force: Option<bool>,
    #[serde(default)]
    pub modifiers: Option<Vec<KeyboardModifier>>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorTimeoutPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Locator.fill(value).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorValuePayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
    pub value: String,
}

/// Locator.getAttribute(name).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorNamePayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
    pub name: String,
}

/// Locator.press(key, {delay?}).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorKeyPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
    pub key: String,
    #[serde(default)]
    pub delay: Option<u64>,
}

/// Locator.pressSequentially(text, {delay?}).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorTextPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
    pub text: String,
    #[serde(default)]
    pub delay: Option<u64>,
}

/// SelectOptionInput: string | {index?,label?,value?} | array of either.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SelectOptionInput {
    Many(Vec<SelectOptionOne>),
    Single(SelectOptionSingle),
    Text(String),
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SelectOptionOne {
    Single(SelectOptionSingle),
    Text(String),
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SelectOptionSingle {
    #[serde(default)]
    pub index: Option<u32>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorSelectPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
    pub option: SelectOptionInput,
}

/// Locator.check()/uncheck() collapsed to `setChecked(bool)`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorCheckedPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
    pub checked: bool,
}

/// Locator.waitFor({state, timeoutMs?}).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum WaitForState {
    #[serde(rename = "attached")]
    Attached,
    #[serde(rename = "detached")]
    Detached,
    #[serde(rename = "visible")]
    Visible,
    #[serde(rename = "hidden")]
    Hidden,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LocatorWaitPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub selector: String,
    pub state: WaitForState,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

// ── WebMCP / site status ──────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct WebmcpInvokePayload {
    pub browser_id: String,
    pub tab_id: String,
    pub tool: String,
    #[serde(default)]
    pub args: Option<Value>,
}

/// `site_status` / `site_submission_verified`: origin-scoped query.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SiteQueryPayload {
    #[serde(default)]
    pub browser_id: Option<String>,
    pub url: String,
}

// ── [adapted] API-derived lifecycle payloads (api.json Tab/Browser
//    surface; absent from the §2.1 registry pool but required by the
//    turn-cleanup / deliverable / history semantics in §2.4/Appendix B) ──

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SessionNamePayload {
    pub browser_id: String,
    pub name: String,
}

/// BrowserHistoryOptions `{from?, limit?, queries?, to?}` (ms epochs).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct HistoryQueryPayload {
    pub browser_id: String,
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
    #[serde(default)]
    pub queries: Option<Vec<String>>,
    #[serde(default)]
    pub limit: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ClearDataPayload {
    pub browser_id: String,
    /// Empty/absent ⇒ clear all session-scoped browsing data categories;
    /// individual categories validated by the engine (Phase 13).
    #[serde(default)]
    pub data_types: Option<Vec<String>>,
}
