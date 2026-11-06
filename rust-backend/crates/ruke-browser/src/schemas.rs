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

// ── Screenshots / dialogs ─────────────────────────────────────────────

/// ScreenshotOptions (`{clip?, fullPage?, selector?, format?, quality?, max_dim?}`;
/// keys snake-cased `[adapted]`). Phase 1 safe transport: `format`/`quality`/
/// `max_dim` let a small vision model request a capture it can actually afford,
/// and the engine answers every capture with tab/frame/viewport/scale/crop
/// metadata so the pixels are attributable.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ScreenshotPayload {
    pub browser_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub clip: Option<ClipRect>,
    #[serde(default)]
    pub full_page: Option<bool>,
    /// Element selector: the capture crops to the first matching element's
    /// rect (main frame). Honors the `playwright_element_screenshot` tool
    /// schema, which always advertised this — until now the wire payload
    /// silently dropped it.
    #[serde(default)]
    pub selector: Option<String>,
    /// `"png"` (default) or `"jpeg"` — jpeg is the compact shape for
    /// model-visible vision reads.
    #[serde(default)]
    pub format: Option<String>,
    /// JPEG quality 1–100 (default 75); ignored for png.
    #[serde(default)]
    pub quality: Option<u32>,
    /// Downscale the capture so its longest side is at most this many
    /// pixels (CDP clip scale; 0/absent = no downscale).
    #[serde(default)]
    pub max_dim: Option<u32>,
}

/// `playwright_dom_snapshot` with targeted-read windows (Phase 1): read a
/// slice of the aria tree by search term or line range instead of dumping
/// the whole page. The full text remains under `dom_snapshot`; windowing
/// metadata rides in `snapshot_meta` only when a window/search applied.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct DomSnapshotPayload {
    pub browser_id: String,
    pub tab_id: String,
    /// Case-insensitive substring: only matching lines are returned (with
    /// their `[ref=eN]` tokens intact, so a hit is directly actionable).
    #[serde(default)]
    pub search: Option<String>,
    /// Return at most this many lines (default 500).
    #[serde(default)]
    pub limit_lines: Option<usize>,
    /// Skip this many lines before the returned window (pagination).
    #[serde(default)]
    pub offset_lines: Option<usize>,
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

// ── bot detection + browser-auth handoff (Phase 9) ────────────────────

/// `tab_bot_detection_report` reason union (MAIN-D1/D6 recovered
/// capture, names verbatim): the model's own diagnosis of *why* the
/// page is resisting automation. Reporting is a pure telemetry
/// gesture — it never unblocks anything by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum BotDetectionReason {
    #[serde(rename = "captcha_failed")]
    CaptchaFailed,
    #[serde(rename = "access_denied")]
    AccessDenied,
    #[serde(rename = "challenge_loop")]
    ChallengeLoop,
    #[serde(rename = "sign_in_blocked")]
    SignInBlocked,
    #[serde(rename = "add_to_cart_blocked")]
    AddToCartBlocked,
    #[serde(rename = "purchase_blocked")]
    PurchaseBlocked,
    #[serde(rename = "unexpected_bot_error")]
    UnexpectedBotError,
}

impl BotDetectionReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CaptchaFailed => "captcha_failed",
            Self::AccessDenied => "access_denied",
            Self::ChallengeLoop => "challenge_loop",
            Self::SignInBlocked => "sign_in_blocked",
            Self::AddToCartBlocked => "add_to_cart_blocked",
            Self::PurchaseBlocked => "purchase_blocked",
            Self::UnexpectedBotError => "unexpected_bot_error",
        }
    }
}

/// `tab_bot_detection_report` payload: reason + tab handle
/// (MAIN-D6 `{...{browser_id, tab_id}}`).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BotReportPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub reason: BotDetectionReason,
}

/// Credential-field id grammar shared by fields and options (SVC-D4
/// zod: `/^[A-Za-z0-9_-]{1,48}$/`). Enforced by the validator in
/// `authority` so the refusal message is explicit, not a serde echo.
pub fn is_browser_auth_id(s: &str) -> bool {
    !matches!(s, "__proto__" | "constructor" | "prototype")
        && !s.is_empty()
        && s.len() <= 48
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// browserAuth request field (SVC-D4 zod `fieldSchema`, wire keys
/// verbatim). `selector` is where the panel's answer is applied in
/// the page; values themselves never travel through the model.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BrowserAuthField {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub autocomplete: Option<String>,
    pub required: bool,
    pub selector: String,
}

/// browserAuth sign-in option (SVC-D4 zod `optionSchema`: either a
/// `selector` or non-empty `field_ids`, never both and never neither
/// — the refine message is kept verbatim).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BrowserAuthOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub field_ids: Option<Vec<String>>,
}

/// How the sign-in is finally submitted after the fields are filled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum BrowserAuthSubmitAction {
    #[serde(rename = "click")]
    Click,
    #[serde(rename = "press_enter")]
    PressEnter,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BrowserAuthSubmit {
    pub selector: String,
    pub action: BrowserAuthSubmitAction,
}

/// `tab_browser_auth_handoff` payload: the SVC-D4 zod
/// `requestSchema` plus the `{browser_id, tab_id}` command framing.
/// The zod refine boundaries (id grammar, counts, origin scheme,
/// conditional rules) are validated in `auth_handoff` with the
/// recovered messages; serde only pins the shape.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BrowserAuthHandoffPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub origin: String,
    #[serde(default)]
    pub account_identifier: Option<String>,
    #[serde(default)]
    pub fields: Vec<BrowserAuthField>,
    #[serde(default)]
    pub options: Option<Vec<BrowserAuthOption>>,
    /// `z.literal(true).optional()` — anything but `true` is refused
    /// by the validator.
    #[serde(default)]
    pub qr_code: Option<bool>,
    #[serde(default)]
    pub submit: Option<BrowserAuthSubmit>,
    /// zod `otpHandle`: wire key is camelCase verbatim.
    #[serde(default, rename = "otpHandle")]
    pub otp_handle: Option<String>,
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

// ── Batch form actuation (Phase 3) ─────────────────────────────────────

/// Control kinds accepted by `playwright_fill_form` — mirroring the
/// pinned driver's `browser_fill_form` field vocabulary (0.0.84 live
/// tools/list dump).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FormFieldType {
    Textbox,
    Checkbox,
    Radio,
    Combobox,
    Slider,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct FormFormField {
    pub name: String,
    /// Driver wire name is `type`.
    #[serde(rename = "type")]
    pub field_type: FormFieldType,
    pub target: String,
    pub value: String,
}

/// One bounded batch of known form fields (Phase 3): the model sends
/// only fields it has observed and decided on; `bridge_fill_form`
/// validates every target BEFORE applying any, then reads the live
/// values back.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct FillFormPayload {
    pub browser_id: String,
    pub tab_id: String,
    pub fields: Vec<FormFormField>,
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
