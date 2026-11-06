//! bridge.rs — Phase 2: the Playwright MCP actuation bridge.
//!
//! The plan replaces Ruke's hand-driven interactive action primitives
//! with the official Microsoft Playwright MCP server as the ONE
//! actuation driver, attached to the SAME authorized Chromium through
//! its loopback DevTools port (`mcp.rs` pins the package and the
//! attach). Everything OBSERVATIONAL (reads, waits, snapshots,
//! screenshots, downloads, lifecycle) stays native CDP — MCP is a
//! driver, not the source of truth. This module owns the actuation
//! half of that split.
//!
//! Compatibility law (every legacy command keeps its contract):
//! - **Native pre-resolution first.** Every locator actuation resolves
//!   its target through the native registry (`pw_actionable` /
//!   `pw_strict_one`) BEFORE any MCP call, preserving the typed
//!   `LocatorTimeout`/`LocatorStrict`/`LocatorStaleRef` errors, the
//!   aria-ref grammar, ` >> ` frame chains, actionability gating, and
//!   `force` semantics exactly as before.
//! - **Route selection.** A selector that parses to exactly one plain
//!   CSS target (no engine prefixes, no ref chains, no frame hops) is
//!   handed to MCP's locator tools directly. Everything else was
//!   already resolved natively to a node (backendNodeId/objectId) and
//!   is actuated through MCP's coordinate + keyboard tools, which DO
//!   reach into frames (probe-proven: `mouse_move_xy`/`mouse_click_xy`
//!   and focused-element key events land inside iframes; MCP locator
//!   `target` addresses the MAIN frame only).
//! - **Tab scoping (pin).** MCP has one "current tab"; every actuation
//!   pins the MCP selection to Ruke's target tab first (`mcp_pin`),
//!   verified against MCP's own tab list, with a title-probe fallback
//!   for tabs whose url is stale or ambiguous. An un-pinnable tab is
//!   an honest `CapabilityBlocked`, never a best-effort guess at the
//!   wrong tab.
//! - **Retained app glue (plan: one driver, short rationale).** The
//!   `mcp_call` guard serializes pin→select→actuate so two turns can
//!   never steer each other's tab selection; the pin procedure and
//!   the typed error back-mapping (`map_tool_error`) are glue that
//!   makes MCP behave like the contract, not a second driver.
//! - **Modal state ownership.** While a file chooser or JS dialog is
//!   open on the pinned page, 0.0.84 refuses every other tab tool.
//!   State Ruke's registries hold belongs to the model-facing
//!   command that owns it (`playwright_file_chooser_set_files`,
//!   `tab_handle_js_dialog` — the bridge also routes BOTH actuations
//!   MCP-first when the driver's page sees the same chooser/dialog);
//!   driver-side-only orphans are cleared by the recovery law in
//!   `modal_state_recovery` and the blocked call retried exactly
//!   once, so a pre-attach orphan can never wedge the bridge.
//!
//! Honest capability limits (typed, never silent):
//! - held-modifier `keys` on cua pointer commands: MCP's coordinate
//!   tools carry no modifier state → `CapabilityBlocked`;
//! - buttons 4/5 (back/forward): outside MCP's left|right|middle →
//!   `Unsupported`;
//! - keyboard-routed text entry is bounded (`MAX_KEYBOARD_FILL_CHARS`)
//!   and cannot press every glyph — a refused key press is a typed
//!   failure naming the key.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::MutexGuard;

use crate::cdp::CdpConn;
use crate::cua::{cua_button_str, drag_path, held_modifier_mask, validate_point, DRAG_STEP_MS};
use crate::engine::{raise_wheel_target, BrowserRuntime};
use crate::errors::{payload_invalid, BrowserError};
use crate::mcp::{self, tool, McpCall, McpError, McpSession, TabLine};
use crate::pw::{
    combo_mask, parse_selector, pw_box_center, pw_call_value, pw_eval_fn, pw_handle, pw_key_spec,
    Seg, DEFAULT_TIMEOUT_MS,
};
use crate::schemas::{
    CuaClickPayload, CuaDragPayload, CuaMovePayload, CuaScrollPayload, FillFormPayload,
    FormFieldType, FormFormField, LocatorCheckedPayload, LocatorClickPayload, LocatorKeyPayload,
    LocatorSelectPayload, LocatorTextPayload, LocatorValuePayload, MouseButton, SelectOptionInput,
    SelectOptionOne, SelectOptionSingle,
};
use crate::session::{TabRecord, TurnKey};

/// Keyboard-routed text entry goes one MCP `press_key` per character;
/// bound so a pathological fill cannot wedge the driver. This is an
/// honest capability ceiling, surfaced as `CapabilityBlocked`.
const MAX_KEYBOARD_FILL_CHARS: usize = 2000;

/// Title-probe pin: MCP's tab list is polled at this cadence/budget
/// for the marker to surface, and the whole probe may repeat
/// `PIN_ATTEMPTS` times before the honest `CapabilityBlocked`.
const PIN_POLL_MS: u64 = 200;
const PIN_POLLS: usize = 6;
const PIN_ATTEMPTS: usize = 3;

/// Modal-state recovery settles once at this budget before deciding a
/// driver-side dialog entry is stale: the CDP `javascriptDialogClosed`
/// broadcast clears the driver's state a beat after our registry
/// removes ours (the `mcp-chooser-proto.mjs` A4 settle loop is this
/// exact window).
const DIALOG_SETTLE_MS: u64 = 300;

// ── Route selection ────────────────────────────────────────────────────

/// How a natively-resolved target will be actuated through MCP.
#[derive(Debug)]
enum ActRoute {
    /// The selector is a single plain-CSS target: MCP's locator tools
    /// address it directly by `target`.
    MainCss(String),
    /// Natively-resolved node (objectId): aria refs, frame hops,
    /// composite selectors, or engine-prefixed selectors MCP could not
    /// address — actuate at the resolved box/keyboard. (The
    /// backendNodeId travels beside the route in `bridge_prelude`'s
    /// tuple, so it is not repeated here.)
    Resolved(String),
}

/// Playwright-private selector engines that must NOT reach MCP's
/// `target` surface (native `pw_nodes` resolves them; actuation then
/// goes through the resolved-node route).
const ENGINE_PREFIXES: &[&str] = &["internal:", "aria/", "aria-ref=", "text=", "xpath=", "nth="];

/// True when the selector body is plain CSS (optionally `css:`-marked,
/// the marker `parse_selector` itself strips) that Playwright's
/// `target` surface can compile unchanged. A `css=` marker is NOT
/// plain here: this port rejects that engine form, and the bridge
/// must not turn a former typed rejection into an MCP success.
fn looks_plain_css(sel: &str) -> bool {
    let s = sel.trim();
    if s.is_empty() {
        return false;
    }
    if ENGINE_PREFIXES.iter().any(|p| s.starts_with(p)) {
        return false;
    }
    if let Some(rest) = s.strip_prefix("css:") {
        return looks_plain_css(rest);
    }
    // Any other `<engine>=` prefix form (`visible=`, `checktext=`, …)
    // is engine syntax, not CSS: reject. A bare leading `:` (pseudo,
    // `:hover`) is CSS and passes (the scan below only rejects word
    // prefixes immediately followed by `=`).
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
        i += 1;
    }
    !(i > 0 && i < bytes.len() && bytes[i] == b'=')
}

/// Parse to EXACTLY one group holding exactly one plain-CSS segment.
/// Anything else (multi-group frame chains, ` >> ` chains, ref
/// segments, engine prefixes) routes through the resolved node.
fn main_css_target(selector: &str) -> Option<String> {
    let groups = parse_selector(selector).ok()?;
    if groups.len() != 1 {
        return None;
    }
    let segs = &groups[0];
    if segs.len() != 1 {
        return None;
    }
    match &segs[0] {
        Seg::Css(c) if looks_plain_css(c) => Some(c.trim().to_string()),
        _ => None,
    }
}

// ── Batch form fields (Phase 3) ────────────────────────────────────────

/// Hard bound on one `playwright_fill_form` batch: enough to fill any
/// form the model has actually read, small enough that pre-validation
/// and read-back each stay a single round-trip.
pub(crate) const MAX_FORM_FIELDS: usize = 16;

/// Typed payload → the pinned driver's `fields` array. Everything the
/// driver would reject at actuation time is rejected HERE instead, with
/// a message that names the field — a bad batch then costs zero
/// side-effects (plan Phase 3: preconditions checked before applying).
fn validate_fill_form(fields: &[FormFormField]) -> Result<Vec<Value>, BrowserError> {
    if fields.is_empty() {
        return Err(payload_invalid(
            "playwright_fill_form",
            "needs at least one field",
        ));
    }
    if fields.len() > MAX_FORM_FIELDS {
        return Err(payload_invalid(
            "playwright_fill_form",
            format!(
                "takes at most {MAX_FORM_FIELDS} fields per batch (got {}); fill a smaller \
                 batch, re-observe, then continue",
                fields.len()
            ),
        ));
    }
    let mut out = Vec::with_capacity(fields.len());
    for (i, f) in fields.iter().enumerate() {
        if f.name.trim().is_empty() {
            return Err(payload_invalid(
                "playwright_fill_form",
                format!("field {i} needs a non-empty name"),
            ));
        }
        if f.target.trim().is_empty() {
            return Err(payload_invalid(
                "playwright_fill_form",
                format!("field {:?} needs a non-empty target selector", f.name),
            ));
        }
        if matches!(f.field_type, FormFieldType::Checkbox | FormFieldType::Radio)
            && !matches!(f.value.as_str(), "true" | "false")
        {
            return Err(payload_invalid(
                "playwright_fill_form",
                format!(
                    "field {:?}: checkbox/radio value must be \"true\" or \"false\" (got {:?})",
                    f.name, f.value
                ),
            ));
        }
        out.push(json!({
            "target": f.target,
            "name": f.name,
            "type": f.field_type,
            "value": f.value,
        }));
    }
    Ok(out)
}

/// Does the live field currently hold the intended value? Comboboxes
/// get a second chance through `alt` (the selected option's VALUE
/// attribute) because the driver addresses options by visible TEXT —
/// an intent written as a value must not be called a failure when the
/// right option is in fact selected.
fn field_holds(f: &FormFormField, actual: &str, alt: Option<&str>) -> bool {
    actual == f.value || (f.field_type == FormFieldType::Combobox && alt == Some(f.value.as_str()))
}

/// One live-read row (see `FORM_READ_JS`). `found: false` means the
/// read could not say anything (target vanished or JS failed) — the
/// honest third state between applied and not-applied.
#[derive(Debug)]
struct FormFieldState {
    found: bool,
    actual: String,
    alt: Option<String>,
}

/// Pre-apply probe (single round-trip law): validate each target as
/// unique, visible, enabled, and type-correct BEFORE the driver touches
/// the page. Pushes the failure reason (a string) or null when the
/// field is good — `probe_verdicts` below enforces the one-verdict-per-
/// field shape instead of letting an unreadable response mean "all good".
const FORM_PROBE_JS: &str = r#"(specs)=>{
    const out=[];
    for (const s of specs){
        let els;
        try { els=document.querySelectorAll(s.target); }
        catch(e){ out.push("target is not a valid CSS selector"); continue; }
        if (els.length===0){ out.push("no element matches the target"); continue; }
        if (els.length>1){ out.push("target is not unique ("+els.length+" elements match)"); continue; }
        const el=els[0];
        if (el.getClientRects().length===0){ out.push("element is not visible"); continue; }
        if (el.disabled===true){ out.push("element is disabled"); continue; }
        // Usability is more than the DOM `disabled` property, which only
        // exists on form controls: a custom [role=combobox] widget or a
        // control wrapped in a disabled <fieldset> reports `undefined`
        // here and used to pass pre-flight, only for the driver to fail
        // mid-batch (audit finding 2).
        if ((el.getAttribute("aria-disabled")||"").toLowerCase()==="true"){ out.push("element is aria-disabled"); continue; }
        if (el.tagName!=="LEGEND" && el.closest("fieldset[disabled]")!==null){ out.push("element sits inside a disabled <fieldset>"); continue; }
        let cs=null; try { cs=window.getComputedStyle(el); } catch(e){}
        if (cs && (cs.pointerEvents==="none" || cs.visibility==="hidden" || cs.display==="none")){
            out.push("element cannot receive input (pointer-events/visibility)"); continue;
        }
        const tag=el.tagName;
        const ty=(el.getAttribute("type")||"").toLowerCase();
        const role=(el.getAttribute("role")||"").toLowerCase();
        let bad=null;
        if (s.type==="textbox"){
            if (tag==="TEXTAREA" || (tag==="INPUT" && !["checkbox","radio","file","range","submit","button","image","hidden","color"].includes(ty))){
                if (el.readOnly===true) bad="element is read-only";
            } else bad="element is not a textbox";
        } else if (s.type==="checkbox"){
            if (!(tag==="INPUT" && ty==="checkbox")) bad="element is not a checkbox";
        } else if (s.type==="radio"){
            if (!(tag==="INPUT" && ty==="radio")) bad="element is not a radio button";
        } else if (s.type==="combobox"){
            if (!(tag==="SELECT" || role==="combobox")) bad="element is not a combobox (<select> or [role=combobox])";
        } else if (s.type==="slider"){
            if (!((tag==="INPUT" && ty==="range") || role==="slider")) bad="element is not a slider";
        } else bad="unknown field type";
        out.push(bad);
    }
    return out;
}"#;

/// Post-apply live read-back. Never raises: an unreadable target reads
/// as `found:false` so partial progress is still reportable. For
/// `<select>` the visible option text is `actual` and the option's
/// value attribute is `alt`; checkboxes/radios read back as
/// "true"/"false" so they are comparable to the payload's intent.
const FORM_READ_JS: &str = r#"(specs)=>{
    const out=[];
    for (const s of specs){
        let el=null;
        try { const els=document.querySelectorAll(s.target); if (els.length===1) el=els[0]; } catch(e){}
        if (el===null){ out.push({found:false, actual:""}); continue; }
        const tag=el.tagName;
        const role=(el.getAttribute("role")||"").toLowerCase();
        if (s.type==="checkbox" || s.type==="radio"){ out.push({found:true, actual:String(el.checked===true)}); continue; }
        if (tag==="SELECT"){
            const o=(el.selectedOptions&&el.selectedOptions.length>0)?el.selectedOptions[0]:null;
            out.push({found:true, actual:o?String(o.textContent||"").trim():"", alt:o?String(o.value):null});
            continue;
        }
        if (role==="combobox"){
            const v=(el.value!=null)?String(el.value):(el.getAttribute("aria-valuetext")||"");
            out.push({found:true, actual:v, alt:el.getAttribute("aria-valuetext")});
            continue;
        }
        out.push({found:true, actual:(el.value!=null)?String(el.value):""});
    }
    return out;
}"#;

/// The per-target spec both probe and read-back key on.
fn form_spec(fields: &[FormFormField]) -> Value {
    let spec: Vec<Value> = fields
        .iter()
        .map(|f| json!({ "target": f.target, "type": f.field_type }))
        .collect();
    Value::Array(spec)
}

fn parse_form_states(fields: &[FormFormField], out: &Value) -> Vec<FormFieldState> {
    let arr = out.as_array();
    (0..fields.len())
        .map(
            |i| match arr.and_then(|a| a.get(i)).filter(|r| r.is_object()) {
                Some(r) => FormFieldState {
                    found: r.get("found").and_then(|v| v.as_bool()).unwrap_or(false),
                    actual: r
                        .get("actual")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    alt: r.get("alt").and_then(|v| v.as_str()).map(str::to_string),
                },
                None => FormFieldState {
                    found: false,
                    actual: String::new(),
                    alt: None,
                },
            },
        )
        .collect()
}

/// Human/model-readable progress line for the partial-failure path:
/// exactly which names the live page confirms, denies, or cannot tell.
fn describe_form_state(fields: &[FormFormField], states: &[FormFieldState]) -> String {
    let mut ok: Vec<&str> = Vec::new();
    let mut no: Vec<&str> = Vec::new();
    let mut unk: Vec<&str> = Vec::new();
    for (f, st) in fields.iter().zip(states) {
        if !st.found {
            unk.push(f.name.as_str());
        } else if field_holds(f, &st.actual, st.alt.as_deref()) {
            ok.push(f.name.as_str());
        } else {
            no.push(f.name.as_str());
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if !ok.is_empty() {
        parts.push(format!("applied: {}", ok.join(", ")));
    }
    if !no.is_empty() {
        parts.push(format!("not applied: {}", no.join(", ")));
    }
    if !unk.is_empty() {
        parts.push(format!("unverifiable: {}", unk.join(", ")));
    }
    if parts.is_empty() {
        "no fields".to_string()
    } else {
        parts.join("; ")
    }
}

/// What the live read-back can honestly claim about one field
/// (audit finding 1): a target the page could not be read for is NOT
/// "not applied" — and it is certainly not "verified". It is the third
/// state, and it must never inflate the applied count. The old success
/// path counted `field_holds` alone, so an unfound field whose intended
/// value was "" (clearing a text box) reported `verified: true`.
fn field_verdict(f: &FormFormField, st: &FormFieldState) -> &'static str {
    if !st.found {
        "unverifiable"
    } else if field_holds(f, &st.actual, st.alt.as_deref()) {
        "applied"
    } else {
        "not-applied"
    }
}

/// The batch's tool result. Kept pure (fields + states in, JSON out) so the
/// three-state honesty law is unit-testable without a browser.
fn form_readback_response(fields: &[FormFormField], states: &[FormFieldState]) -> Value {
    let rows: Vec<Value> = fields
        .iter()
        .zip(states)
        .map(|(f, st)| {
            let verdict = field_verdict(f, st);
            json!({
                "name": f.name,
                "target": f.target,
                "intended": f.value,
                "actual": st.actual,
                "state": verdict,
                "verified": verdict == "applied",
            })
        })
        .collect();
    let applied = rows
        .iter()
        .filter(|r| r["verified"].as_bool().unwrap_or(false))
        .count();
    let all_verified = applied == fields.len();
    json!({
        "applied": applied,
        "total": fields.len(),
        "all_verified": all_verified,
        "fields": rows,
        "note": if all_verified {
            "read-back confirms every field holds its intended value".to_string()
        } else {
            format!(
                "READ-BACK NOT FULLY CONFIRMED: {}. Never treat an unverifiable field as \
                 applied: re-observe the page and fill only what is missing",
                describe_form_state(fields, states)
            )
        },
    })
}

/// The pre-flight probe's response contract: EXACTLY one verdict per field —
/// `null` when the field is usable, a string naming the reason when it is not.
/// Anything else (no array, a short/long array, a number/object verdict) means
/// the probe did not run as written, and the batch must not be applied on the
/// assumption that everything is fine (audit finding 2: the old code keyed on
/// "is there a string anywhere", so a malformed response read as all-clear).
fn probe_verdicts(fields: &[FormFormField], probe: &Value) -> Result<Vec<Option<String>>, String> {
    let arr = match probe.as_array() {
        Some(a) => a,
        None => {
            let got = match probe {
                Value::Null => "null",
                Value::Bool(_) => "a boolean",
                Value::Number(_) => "a number",
                Value::String(_) => "a string",
                Value::Object(_) => "an object",
                Value::Array(_) => "an array",
            };
            return Err(format!(
                "expected an array of {} verdict(s), got {got}",
                fields.len()
            ));
        }
    };
    if arr.len() != fields.len() {
        return Err(format!(
            "returned {} verdict(s) for {} field(s)",
            arr.len(),
            fields.len()
        ));
    }
    arr.iter()
        .enumerate()
        .map(|(i, v)| match v {
            Value::Null => Ok(None),
            Value::String(reason) => Ok(Some(reason.clone())),
            other => Err(format!(
                "verdict for field {:?} is neither null nor a string ({other})",
                fields[i].name
            )),
        })
        .collect()
}

// ── Key grammar → MCP press grammar ────────────────────────────────────

/// `combo_mask` name aliases → the MCP/Playwright press-key modifier
/// names (`ControlOrMeta` is an action option, not press grammar; on
/// this CDP surface it means Control).
fn mcp_modifier_name(token: &str) -> &'static str {
    match token.to_ascii_lowercase().as_str() {
        "alt" => "Alt",
        "ctrl" | "control" | "controlormeta" | "ctl" => "Control",
        "shift" => "Shift",
        "meta" | "command" | "super" | "cmd" => "Meta",
        _ => "Alt", // unreachable: combo_mask validated the name first
    }
}

/// Validate a combo against the native key grammar (`combo_mask` +
/// `pw_key_spec` keep the typed `payload_invalid` messages) and
/// rebuild it in MCP press-key grammar ("Control+a", "Enter", …).
fn mcp_press_key_expr(raw: &str) -> Result<String, BrowserError> {
    let (mods_raw, base) = match raw.rsplit_once('+') {
        Some((m, b)) if !m.is_empty() => (m, b),
        _ => ("", raw),
    };
    let names: Vec<&str> = if mods_raw.is_empty() {
        Vec::new()
    } else {
        mods_raw.split('+').collect()
    };
    combo_mask(&names)?; // typed payload_invalid("key", …) on bad names
    let spec = pw_key_spec(base)
        .ok_or_else(|| payload_invalid("key", format!("unknown key \"{raw}\"")))?;
    let mods: Vec<&str> = names.iter().map(|t| mcp_modifier_name(t)).collect();
    Ok(if mods.is_empty() {
        spec.key
    } else {
        format!("{}+{}", mods.join("+"), spec.key)
    })
}

// ── MCP tool-error back-mapping ────────────────────────────────────────

/// Extract `resolved to N` from a Playwright strict-violation message.
fn parse_resolved_count(text: &str) -> Option<usize> {
    let at = text.find("resolved to ")? + "resolved to ".len();
    let digits = text[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    digits.parse().ok().filter(|n: &usize| *n > 1)
}

/// Extract the milliseconds from MCP's `Timeout <n>ms exceeded…`.
fn parse_timeout_ms(text: &str) -> Option<u64> {
    let at = text.find("Timeout ")? + "Timeout ".len();
    let digits = text[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    digits.parse().ok()
}

/// Map an MCP tool failure back onto the contract's typed surface.
/// Locator-tool routes (selector known) become `LocatorStrict` /
/// `LocatorTimeout` / `LocatorFailed`; coordinate/keyboard routes
/// surface as the honest driver-level `McpToolFailed`.
fn map_tool_error(tool: String, text: String, selector: Option<&str>) -> BrowserError {
    let trimmed = text.trim().to_string();
    if let Some(sel) = selector {
        if trimmed.contains("strict mode violation") {
            if let Some(count) = parse_resolved_count(&trimmed) {
                return BrowserError::LocatorStrict {
                    selector: sel.to_string(),
                    count,
                };
            }
        }
        if trimmed.starts_with("Timeout") {
            if let Some(ms) = parse_timeout_ms(&trimmed) {
                return BrowserError::LocatorTimeout {
                    selector: sel.to_string(),
                    state: "actionable".to_string(),
                    timeout_ms: ms,
                };
            }
        }
        return BrowserError::LocatorFailed {
            selector: sel.to_string(),
            reason: trimmed,
        };
    }
    BrowserError::McpToolFailed {
        tool,
        reason: trimmed,
    }
}

// ── Modal-state refusal grammar (driver state blocks a tool) ──────────

/// The two modal states the pinned driver surfaces on a refusal
/// (`### Modal state` entries, verbatim in
/// `.ai-coordination/fixture-run.log` and the `mcp-chooser-proto.mjs`
/// post-mortems).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModalKind {
    Chooser,
    Dialog,
}

/// Recognize the driver's modal-state refusal — `Error: Tool "…" does
/// not handle the modal state.` plus its `### Modal state` section.
/// Only ever consulted for tool ERRORS (`mcp_call1` returns success
/// before recovery, and successful tool responses may carry the
/// section informationally). The chooser entry wins if both names
/// appear: Chromium keeps one modal item per page, so both cannot be
/// live at once.
fn parse_modal_state(text: &str) -> Option<ModalKind> {
    if !text.contains("does not handle the modal state") {
        return None;
    }
    let (_, section) = text.split_once("### Modal state")?;
    if section.contains("[File chooser]") {
        Some(ModalKind::Chooser)
    } else if section.contains("dialog with message") {
        Some(ModalKind::Dialog)
    } else {
        None
    }
}

/// Outcome of the modal-state recovery law for one refusal (the law
/// itself: `BrowserRuntime::modal_state_recovery`).
enum ModalRecovery {
    /// Not a (recognized) modal-state refusal: map the tool error.
    None,
    /// Ruke's native registry owns the modal state — the model-facing
    /// commands (`playwright_file_chooser_set_files` /
    /// `tab_handle_js_dialog`) are the ONLY way through. Surface the
    /// driver's own message as a typed error; never act around state
    /// the model was told to handle.
    OwnedByRuke(BrowserError),
    /// Driver-side-only state was cleared by a recovery call; retry
    /// the blocked action exactly once.
    Recovered,
}

// ── The pinned actuation target ───────────────────────────────────────

/// The warm driver session plus the tab it is pinned to. Carrying the
/// tab id with the session is what lets the modal-state recovery law
/// consult Ruke's native chooser/dialog registry for the SAME tab the
/// blocked call targeted — pinning is per-call, and a recovery must
/// never read another tab's state.
pub(crate) struct McpTarget {
    sess: Arc<McpSession>,
    tab_id: String,
}

// ── Page-side JS (bridge-owned; tiny, read-mostly) ────────────────────

const BRIDGE_CHECKED_JS: &str = "function(){ return !!this.checked; }";
const BRIDGE_FOCUS_JS: &str =
    "function(){ if (this.focus) this.focus(); return document.activeElement === this; }";
const BRIDGE_TITLE_GET_JS: &str = "function(){ return document.title; }";
const BRIDGE_TITLE_SET_JS: &str = "function(t){ document.title = t; }";
const BRIDGE_SELECTED_VALUES_JS: &str = "function(){ if (this.tagName !== 'SELECT') return { error: 'target is not a <select>' }; return { values: Array.prototype.map.call(this.selectedOptions, function(o){ return o.value; }) }; }";
const BRIDGE_OPTIONS_JS: &str = "function(){ if (this.tagName !== 'SELECT') return { error: 'target is not a <select>' }; return { options: Array.prototype.map.call(this.options, function(o, i){ return { index: i, label: o.text, value: o.value }; }) }; }";
/// A unique, self-validated CSS path for the resolved node within its
/// own document: id fast-path, else a `nth-of-type` chain anchored at
/// `html`. The walk validates its own output (`querySelectorAll(path)
/// .length === 1`) so a frame-local path can never masquerade as a
/// main-frame address.
const BRIDGE_UNIQUE_PATH_JS: &str = r"function(){
  try {
    const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
    if (this.id) { const p = '#' + esc(this.id); if (document.querySelectorAll(p).length === 1) return p; }
    const seg = [];
    let n = this;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      let part = n.tagName.toLowerCase();
      if (n.classList.length) part += '.' + Array.prototype.map.call(n.classList, esc).join('.');
      const parent = n.parentElement;
      const sibs = parent ? Array.prototype.filter.call(parent.children, (c) => c.tagName === n.tagName) : [];
      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      seg.unshift(part);
      n = parent;
    }
    const path = 'html > ' + seg.join(' > ');
    if (seg.length && document.querySelectorAll(path).length === 1) return path;
  } catch (e) {}
  return null;
}";

fn button_name(b: &MouseButton) -> &'static str {
    match b {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

// ── The bridge itself (extension impl on BrowserRuntime) ──────────────

impl BrowserRuntime {
    // ── session / pin plumbing ─────────────────────────────────────────

    /// Serialize one pin→actuate sequence against MCP's single
    /// "current tab" model. Native observation never takes this lock.
    pub(crate) async fn mcp_guard(&self) -> MutexGuard<'_, ()> {
        self.mcp_call.lock().await
    }

    /// Ensure the warm MCP session exists, attached to the live host's
    /// OWN loopback DevTools port. LOCK LAW: `client()` and
    /// `mcp_host_info()` take/release the host lock first; the `mcp`
    /// slot lock is only then taken, briefly, and never while holding
    /// any other MCP lock.
    async fn mcp_session(&self) -> Result<Arc<McpSession>, BrowserError> {
        self.client().await?;
        let (port, headless) = self.mcp_host_info().await?;
        let mut slot = self.mcp.lock().await;
        if let Some(sess) = slot.as_ref() {
            return Ok(sess.clone());
        }
        // The CLI lives in the app tree's node_modules; `root` is the
        // profile root, so fall back to the process CWD for lookup.
        let from = if mcp::resolve_mcp_cli(&self.root).is_ok() {
            self.root.clone()
        } else {
            std::env::current_dir().unwrap_or_else(|_| self.root.clone())
        };
        let out_dir = self.root.join("mcp-out");
        let sess = Arc::new(McpSession::attach(&from, port, headless, &out_dir).await?);
        *slot = Some(sess.clone());
        Ok(sess)
    }

    /// Ready-to-actuate: session acquired + target tab pinned. The
    /// bounded retry covers ONLY the read-only steps (attach/list/
    /// select) — a dead child is re-attached and the pin re-run; the
    /// actuation call itself happens exactly once at the call site,
    /// so no action can be applied twice. The returned `McpTarget`
    /// carries the pinned tab id so the modal-state recovery law can
    /// read the SAME tab's native registry during a refusal recovery.
    pub(crate) async fn mcp_ready(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
    ) -> Result<McpTarget, BrowserError> {
        let sess = match self.mcp_session().await {
            Ok(s) => s,
            Err(BrowserError::McpUnavailable { .. }) => {
                self.mcp_reset().await;
                self.mcp_session().await?
            }
            Err(e) => return Err(e),
        };
        match self.mcp_pin(&sess, conn, rec).await {
            Ok(()) => Ok(McpTarget {
                sess,
                tab_id: rec.tab_id.clone(),
            }),
            Err(BrowserError::McpUnavailable { .. }) => {
                self.mcp_reset().await;
                let s2 = self.mcp_session().await?;
                self.mcp_pin(&s2, conn, rec).await?;
                Ok(McpTarget {
                    sess: s2,
                    tab_id: rec.tab_id.clone(),
                })
            }
            Err(e) => Err(e),
        }
    }

    /// One MCP call, cancellation-aware, error-mapped. Caller holds
    /// the `mcp_call` guard (via `mcp_ready`) and the session is
    /// pinned to `rec`'s tab. A driver modal-state refusal goes
    /// through the recovery law (recover, retry EXACTLY once — never
    /// an un-recovered second attempt); everything else maps once.
    pub(crate) async fn mcp_call1(
        &self,
        t: &McpTarget,
        key: &TurnKey,
        name: &str,
        args: Value,
        selector: Option<&str>,
    ) -> Result<String, BrowserError> {
        let attempt = self.mcp_attempt(t, key, name, args.clone()).await?;
        let err = match attempt {
            Ok(c) => return Ok(c.text),
            Err(e) => e,
        };
        let recovery = match &err {
            McpError::Tool { tool, text } => self.modal_state_recovery(t, key, tool, text).await,
            _ => ModalRecovery::None,
        };
        match recovery {
            ModalRecovery::None => Err(self.attempt_fail(err, selector).await),
            ModalRecovery::OwnedByRuke(e) => Err(e),
            ModalRecovery::Recovered => {
                // The refusal ran NO action and the recovery calls
                // only cleared driver-side state, so re-sending the
                // original arguments still actuates exactly once. A
                // second refusal maps honestly (no further recovery).
                let retry = self.mcp_attempt(t, key, name, args).await?;
                match retry {
                    Ok(c) => Ok(c.text),
                    Err(e) => Err(self.attempt_fail(e, selector).await),
                }
            }
        }
    }

    /// One driver call under the budget, cancellation-aware, and
    /// UNMAPPED: `mcp_call1` decides between the modal-state recovery
    /// law and `attempt_fail`. A cancelled turn is terminal.
    async fn mcp_attempt(
        &self,
        t: &McpTarget,
        key: &TurnKey,
        name: &str,
        args: Value,
    ) -> Result<Result<McpCall, McpError>, BrowserError> {
        let res = tokio::select! {
            r = t.sess.call_ok(name, args, mcp::ACT_TIMEOUT) => r,
            _ = self.wait_turn_cancel(key) => {
                return Err(BrowserError::McpCancelled { tool: name.to_string() });
            }
        };
        Ok(res)
    }

    /// Map one attempt failure onto the typed surface.
    async fn attempt_fail(&self, e: McpError, selector: Option<&str>) -> BrowserError {
        match e {
            McpError::Tool { tool, text } => map_tool_error(tool, text, selector),
            McpError::Service { .. } => {
                // Connection died mid-call: the action may or may not
                // have landed — drop the session so the NEXT command
                // re-attaches fresh, and surface the honest driver
                // message (re-observe before retrying).
                self.mcp_reset().await;
                McpError::Service {
                    detail: "the driver connection dropped mid-action; it may or may not have been applied — re-observe the page before retrying".to_string(),
                }
                .into()
            }
            e => e.into(),
        }
    }

    /// The modal-state recovery law — every branch proven live in
    /// `.ai-coordination/mcp-chooser-proto.mjs` (2026-11-06). 0.0.84
    /// blocks every tab-scoped tool while a modal state is open on
    /// the pinned page, and that state can exist WITHOUT Ruke knowing
    /// — it opened before the driver attached, survived a driver
    /// reset, or fired on a tab whose native chooser interception was
    /// never armed. Such orphans would wedge the bridge (no model
    /// command can see them), so the bridge clears driver-side-only
    /// state itself; anything Ruke's registries still hold belongs to
    /// the model-facing command that owns it:
    /// - File chooser with NO pending chooser in Ruke's registry for
    ///   the pinned tab: cancel through the driver's own cancel
    ///   (`browser_file_upload` with no paths = `setFiles
    ///   (undefined)`, the codegen the proto captured), then retry
    ///   the blocked call once. With a pending chooser the
    ///   wait/set_files flow owns it — honest refusal whose message
    ///   names the driver's own route (`Ruke's
    ///   `playwright_file_chooser_set_files` is the real one).
    /// - JS dialog with NOTHING live in Ruke's registry: the entry is
    ///   stale (a CDP-accepted dialog's `javascriptDialogClosed`
    ///   broadcast clears the driver's state a beat late — proto A1c/
    ///   A4 proved exactly this window) or orphaned. Settle once,
    ///   re-check, then close through the driver (`browser_handle_
    ///   dialog {accept:true}`; its "No dialog visible" tool error is
    ///   benign when the broadcast already cleared both sides) and
    ///   retry once. A dialog Ruke never recorded can never have been
    ///   offered to the model (`tab_get_js_dialog` reports nothing),
    ///   so accepting an orphan cannot destroy a model-visible
    ///   choice. With a live dialog, `tab_handle_js_dialog` owns it —
    ///   honest refusal.
    /// The exactly-once actuation law holds throughout: the refused
    /// call changed nothing, and the recovery calls change no page
    /// state (cancelling an already-interrupted chooser; closing an
    /// already-blocking dialog).
    async fn modal_state_recovery(
        &self,
        t: &McpTarget,
        key: &TurnKey,
        blocked_tool: &str,
        text: &str,
    ) -> ModalRecovery {
        let Some(kind) = parse_modal_state(text) else {
            return ModalRecovery::None;
        };
        let owned = || {
            ModalRecovery::OwnedByRuke(BrowserError::McpToolFailed {
                tool: blocked_tool.to_string(),
                reason: text.trim().to_string(),
            })
        };
        match kind {
            ModalKind::Chooser => {
                if self.io.latest_pending_chooser_for_tab(&t.tab_id).is_some() {
                    return owned();
                }
                let _ = self.mcp_attempt(t, key, tool::FILE_UPLOAD, json!({})).await;
                ModalRecovery::Recovered
            }
            ModalKind::Dialog => {
                if self.io.js_dialog(&t.tab_id).is_some() {
                    return owned();
                }
                tokio::time::sleep(Duration::from_millis(DIALOG_SETTLE_MS)).await;
                if self.io.js_dialog(&t.tab_id).is_some() {
                    return owned();
                }
                let _ = self
                    .mcp_attempt(t, key, tool::HANDLE_DIALOG, json!({ "accept": true }))
                    .await;
                ModalRecovery::Recovered
            }
        }
    }

    /// Actuation half of `playwright_file_chooser_set_files` (the
    /// executor's command arm owns validation and the registry
    /// bookkeeping). Returns whether the DRIVER applied the files:
    /// when its page has seen this chooser, `browser_file_upload
    /// {paths}` is the single actuation (one change event, full form
    /// round-trip — proto stages B4/B8). `Ok(false)` hands the
    /// command to the native CDP apply instead, for every honest
    /// fallback case: the driver never saw this chooser (its own
    /// "only be used when there is related modal state" refusal —
    /// opened before attach or after a reset), pinning could not
    /// scope the driver to this tab (the native path stays tab-exact
    /// through the chooser event's backendNodeId), or the driver is
    /// absent. A failed or timed-out driver upload also lands in the
    /// fallback: Playwright's setFiles REPLACES the input's files, so
    /// a second apply of the SAME paths is idempotent even if a late
    /// driver response still lands (proto B2's double-apply is one
    /// set of files, one change event).
    pub(crate) async fn bridge_file_chooser_set_files(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        files: &[String],
    ) -> Result<bool, BrowserError> {
        let _guard = self.mcp_call.lock().await;
        let t = match self.mcp_ready(conn, rec).await {
            Ok(t) => t,
            // No driver, or the driver cannot be scoped to this tab:
            // the native path takes over (its own CDP failures surface
            // honestly there). Cancellation cannot occur in the
            // read-only ready steps.
            Err(_) => return Ok(false),
        };
        match self
            .mcp_attempt(&t, key, tool::FILE_UPLOAD, json!({ "paths": files }))
            .await?
        {
            Ok(_) => Ok(true),
            Err(McpError::Tool { text, .. })
                if text.contains("only be used when there is related modal state") =>
            {
                Ok(false)
            }
            Err(_) => {
                // Failed/timed out: a late response is harmless under
                // REPLACE semantics, but the session is dropped so
                // the next command starts fresh.
                self.mcp_reset().await;
                Ok(false)
            }
        }
    }

    async fn wait_turn_cancel(&self, key: &TurnKey) {
        match self.turn_cancel(key) {
            Some(t) => t.cancelled().await,
            None => std::future::pending::<()>().await,
        }
    }

    /// Pin MCP's current-tab selection to `rec`'s tab (plan line 105:
    /// per-tab scoping is proven, not assumed). URL match first; a
    /// stale/ambiguous url falls back to the title probe (Ruke writes
    /// a nonce marker into its OWN tab through CDP and finds it in
    /// MCP's list). Exhausted probe = honest `CapabilityBlocked` —
    /// never a best-effort actuation against the wrong tab.
    async fn mcp_pin(
        &self,
        sess: &McpSession,
        conn: &CdpConn,
        rec: &TabRecord,
    ) -> Result<(), BrowserError> {
        let lines = sess.tabs_list().await?;
        let matches: Vec<&TabLine> = lines.iter().filter(|l| l.url == rec.url).collect();
        if matches.len() == 1 {
            let line = matches[0];
            if line.current {
                return Ok(());
            }
            sess.tabs_select(line.index).await?;
            let after = sess.tabs_list().await?;
            if after.iter().any(|l| l.index == line.index && l.current) {
                return Ok(());
            }
        }
        self.mcp_pin_probe(sess, conn, rec).await
    }

    async fn mcp_pin_probe(
        &self,
        sess: &McpSession,
        conn: &CdpConn,
        rec: &TabRecord,
    ) -> Result<(), BrowserError> {
        for _attempt in 0..PIN_ATTEMPTS {
            let original = pw_eval_fn(conn, &rec.cdp_session_id, BRIDGE_TITLE_GET_JS, &[])
                .await
                .ok()
                .and_then(|v| v.as_str().map(String::from));

            let nonce = self.mcp_probe_nonce.fetch_add(1, Ordering::Relaxed);
            let marker = format!("RUKE-PIN-{nonce}");
            pw_eval_fn(
                conn,
                &rec.cdp_session_id,
                BRIDGE_TITLE_SET_JS,
                &[json!(marker)],
            )
            .await?;

            let mut marker_index: Option<usize> = None;
            for _poll in 0..PIN_POLLS {
                let lines = sess.tabs_list().await?;
                if let Some(l) = lines.iter().find(|l| l.title == marker) {
                    marker_index = Some(l.index);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(PIN_POLL_MS)).await;
            }
            if let Some(index) = marker_index {
                sess.tabs_select(index).await?;
                let after = sess.tabs_list().await?;
                if after.iter().any(|l| l.current && l.title == marker) {
                    if let Some(orig) = &original {
                        let _ = pw_eval_fn(
                            conn,
                            &rec.cdp_session_id,
                            BRIDGE_TITLE_SET_JS,
                            &[json!(orig.clone())],
                        )
                        .await;
                    }
                    return Ok(());
                }
            }
            if let Some(orig) = &original {
                let _ = pw_eval_fn(
                    conn,
                    &rec.cdp_session_id,
                    BRIDGE_TITLE_SET_JS,
                    &[json!(orig.clone())],
                )
                .await;
            }
        }
        Err(BrowserError::CapabilityBlocked {
            reason: format!(
                "could not focus tab \"{}\" inside the shared browser through the MCP \
                 driver: its url never matched the driver's tab list uniquely and the \
                 title probe never surfaced ({} attempts)",
                rec.tab_id, PIN_ATTEMPTS
            ),
        })
    }

    // ── locator prelude ────────────────────────────────────────────────

    /// Native pre-resolution shared by every locator actuation (the
    /// contract's typed errors, actionability, force, and grammar all
    /// stay native). Returns the actuation route + the resolved node.
    async fn bridge_prelude(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        selector: &str,
        timeout_ms: Option<u64>,
        force: bool,
    ) -> Result<(ActRoute, i64, String), BrowserError> {
        let timeout = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let (bnid, oid) = if force {
            // force skips the visible/enabled gates but strict
            // resolution still runs (native `pw_locator_click` parity).
            let bnid = self
                .pw
                .pw_strict_one(self, conn, rec, selector, timeout)
                .await?;
            let oid = pw_handle(conn, &rec.cdp_session_id, bnid).await?;
            (bnid, oid)
        } else {
            self.pw
                .pw_actionable(self, conn, rec, selector, timeout)
                .await?
        };
        let route = match main_css_target(selector) {
            Some(css) => ActRoute::MainCss(css),
            None => ActRoute::Resolved(oid.clone()),
        };
        Ok((route, bnid, oid))
    }

    /// Box-center dispatch point for a resolved node (coordinate route).
    async fn bridge_point(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        bnid: i64,
    ) -> Result<(f64, f64), BrowserError> {
        pw_box_center(conn, &rec.cdp_session_id, bnid)
            .await?
            .ok_or_else(|| BrowserError::LocatorFailed {
                selector: String::new(),
                reason: "element has no layout box to click (hidden?)".to_string(),
            })
    }

    // ── locator actuation commands ────────────────────────────────────

    pub(crate) async fn bridge_click(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorClickPayload,
        double: bool,
    ) -> Result<Value, BrowserError> {
        let _guard = self.mcp_call.lock().await;
        self.bridge_click_inner(key, conn, rec, p, double).await
    }

    /// Assumes the `mcp_call` guard is already held (also called by
    /// `bridge_set_checked`, which holds it across click+readback).
    async fn bridge_click_inner(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorClickPayload,
        double: bool,
    ) -> Result<Value, BrowserError> {
        // click_count semantics pinned to native: dblclick clamps to
        // >= 2, plain click to >= 1.
        let click_count = if double {
            p.click_count.unwrap_or(2).max(2)
        } else {
            p.click_count.unwrap_or(1).max(1)
        };
        let button = p.button.as_ref().map(button_name);
        let (route, bnid, _oid) = self
            .bridge_prelude(
                conn,
                rec,
                &p.selector,
                p.timeout_ms,
                p.force.unwrap_or(false),
            )
            .await?;
        let sess = self.mcp_ready(conn, rec).await?;

        match &route {
            ActRoute::MainCss(css) if click_count <= 2 => {
                let mut args = json!({ "target": css });
                if double || click_count == 2 {
                    args["doubleClick"] = json!(true);
                }
                if let Some(b) = button {
                    args["button"] = json!(b);
                }
                if let Some(mods) = &p.modifiers {
                    args["modifiers"] = json!(mods);
                }
                self.mcp_call1(&sess, key, tool::CLICK, args, Some(&p.selector))
                    .await?;
            }
            _ => {
                // >2 clicks and every resolved-node route go through
                // the coordinate tools (click_xy carries clickCount).
                // The prelude resolved a box for the node on BOTH
                // routes, so `bnid` addresses the same element either
                // way — force-with-no-box keeps the native refusal.
                if p.modifiers.as_ref().is_some_and(|m| !m.is_empty()) {
                    return Err(BrowserError::CapabilityBlocked {
                        reason: "locator click with held modifiers cannot route through the \
                                 MCP coordinate tools (they carry no modifier state)"
                            .to_string(),
                    });
                }
                let (x, y) = self.bridge_point(conn, rec, bnid).await?;
                self.mcp_call1(
                    &sess,
                    key,
                    tool::MOUSE_MOVE_XY,
                    json!({ "x": x, "y": y }),
                    Some(&p.selector),
                )
                .await?;
                let mut args = json!({ "x": x, "y": y, "clickCount": click_count });
                if let Some(b) = button {
                    args["button"] = json!(b);
                }
                self.mcp_call1(&sess, key, tool::MOUSE_CLICK_XY, args, Some(&p.selector))
                    .await?;
            }
        }
        Ok(json!({}))
    }

    pub(crate) async fn bridge_fill(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorValuePayload,
    ) -> Result<Value, BrowserError> {
        let _guard = self.mcp_call.lock().await;
        let (route, _bnid, _oid) = self
            .bridge_prelude(conn, rec, &p.selector, None, false)
            .await?;
        let sess = self.mcp_ready(conn, rec).await?;
        match &route {
            ActRoute::MainCss(css) => {
                self.mcp_call1(
                    &sess,
                    key,
                    tool::TYPE,
                    json!({ "target": css, "text": p.value }),
                    Some(&p.selector),
                )
                .await?;
            }
            ActRoute::Resolved(oid) => {
                // Keyboard route: focus natively (exact node), select
                // all (fill REPLACES per the native contract), then
                // press the text char-by-char.
                self.bridge_focus(conn, rec, oid).await?;
                self.mcp_call1(
                    &sess,
                    key,
                    tool::PRESS_KEY,
                    json!({ "key": "Control+a" }),
                    Some(&p.selector),
                )
                .await?;
                self.bridge_press_chars(&sess, key, &p.selector, &p.value, None)
                    .await?;
            }
        }
        Ok(json!({}))
    }

    pub(crate) async fn bridge_press(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorKeyPayload,
    ) -> Result<Value, BrowserError> {
        let _guard = self.mcp_call.lock().await;
        // MCP has no targeted press tool: BOTH routes focus the
        // natively-resolved node, then press into the focused element.
        let (_route, _bnid, oid) = self
            .bridge_prelude(conn, rec, &p.selector, None, false)
            .await?;
        let expr = mcp_press_key_expr(&p.key)?;
        self.bridge_focus(conn, rec, &oid).await?;
        let sess = self.mcp_ready(conn, rec).await?;
        self.mcp_call1(
            &sess,
            key,
            tool::PRESS_KEY,
            json!({ "key": expr }),
            Some(&p.selector),
        )
        .await?;
        Ok(json!({}))
    }

    pub(crate) async fn bridge_press_sequentially(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorTextPayload,
    ) -> Result<Value, BrowserError> {
        let _guard = self.mcp_call.lock().await;
        let (route, _bnid, _oid) = self
            .bridge_prelude(conn, rec, &p.selector, None, false)
            .await?;
        let sess = self.mcp_ready(conn, rec).await?;
        match &route {
            ActRoute::MainCss(css) => {
                self.mcp_call1(
                    &sess,
                    key,
                    tool::TYPE,
                    json!({ "target": css, "text": p.text, "slowly": true }),
                    Some(&p.selector),
                )
                .await?;
            }
            ActRoute::Resolved(oid) => {
                self.bridge_focus(conn, rec, oid).await?;
                self.bridge_press_chars(&sess, key, &p.selector, &p.text, p.delay)
                    .await?;
            }
        }
        Ok(json!({}))
    }

    /// Phase 3 (plan): drive an already-observed form in ONE batch over
    /// the same pinned MCP `browser_fill_form` driver. Three honesty
    /// laws: pre-validate every target BEFORE anything is applied (a
    /// bad batch stops with zero side-effects), read the LIVE field
    /// values back after the call — a successful call is not the
    /// outcome — and report partial progress truthfully so a
    /// half-applied batch is never blindly re-applied whole.
    pub(crate) async fn bridge_fill_form(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &FillFormPayload,
    ) -> Result<Value, BrowserError> {
        let batch = validate_fill_form(&p.fields)?;
        let _guard = self.mcp_call.lock().await;
        let probe = pw_eval_fn(
            conn,
            &rec.cdp_session_id,
            FORM_PROBE_JS,
            &[form_spec(&p.fields)],
        )
        .await?;
        let verdicts =
            probe_verdicts(&p.fields, &probe).map_err(|why| BrowserError::LocatorFailed {
                selector: String::new(),
                reason: format!(
                    "playwright_fill_form stopped before applying ANY field: the pre-flight probe \
                 could not be trusted ({why}). Nothing was applied — re-observe the page, or use \
                 single-field commands"
                ),
            })?;
        if let Some((idx, why)) = verdicts
            .iter()
            .enumerate()
            .find_map(|(i, v)| v.as_deref().map(|w| (i, w.to_string())))
        {
            let f = &p.fields[idx];
            return Err(BrowserError::LocatorFailed {
                selector: f.target.clone(),
                reason: format!(
                    "playwright_fill_form stopped before applying ANY field: field {:?} ({}) \
                     — {why}. Fix the batch (single-field commands still work) or re-observe \
                     the page",
                    f.name, f.target
                ),
            });
        }
        let sess = self.mcp_ready(conn, rec).await?;
        if let Err(e) = self
            .mcp_call1(
                &sess,
                key,
                tool::FILL_FORM,
                json!({ "fields": batch }),
                None,
            )
            .await
        {
            let states = self.form_field_state(conn, rec, &p.fields).await;
            return Err(BrowserError::LocatorFailed {
                selector: String::new(),
                reason: format!(
                    "playwright_fill_form halted mid-batch: {e}. Live read-back: {}. Do NOT \
                     blindly re-apply the whole batch: re-observe and fill only what is \
                     missing",
                    describe_form_state(&p.fields, &states)
                ),
            });
        }
        let states = self.form_field_state(conn, rec, &p.fields).await;
        Ok(form_readback_response(&p.fields, &states))
    }

    /// Read-back that can never fail the command: a broken probe just
    /// makes every field unverifiable (found:false), which the
    /// caller's honest wording covers.
    async fn form_field_state(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        fields: &[FormFormField],
    ) -> Vec<FormFieldState> {
        match pw_eval_fn(
            conn,
            &rec.cdp_session_id,
            FORM_READ_JS,
            &[form_spec(fields)],
        )
        .await
        {
            Ok(v) => parse_form_states(fields, &v),
            Err(_) => fields
                .iter()
                .map(|_| FormFieldState {
                    found: false,
                    actual: String::new(),
                    alt: None,
                })
                .collect(),
        }
    }

    pub(crate) async fn bridge_select_option(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorSelectPayload,
    ) -> Result<Value, BrowserError> {
        let _guard = self.mcp_call.lock().await;
        let (route, _bnid, oid) = self
            .bridge_prelude(conn, rec, &p.selector, None, false)
            .await?;
        let values = self.map_select_values(conn, rec, &oid, &p.option).await?;
        if !values.is_empty() {
            let sess = self.mcp_ready(conn, rec).await?;
            let target: String = match &route {
                ActRoute::MainCss(css) => css.clone(),
                ActRoute::Resolved(oid) => {
                    // MCP's select tool addresses the MAIN frame only:
                    // a frame-scoped select is an honest capability
                    // limit, never a wrong-frame guess.
                    if !self.bridge_is_main_frame(conn, rec, oid).await? {
                        return Err(BrowserError::LocatorFailed {
                            selector: p.selector.clone(),
                            reason: "select_option targets a frame-scoped node, which the \
                                     MCP locator surface cannot address (main-frame only; \
                                     honest capability limit)"
                                .to_string(),
                        });
                    }
                    let path = pw_call_value(
                        conn,
                        &rec.cdp_session_id,
                        Some(oid.as_str()),
                        BRIDGE_UNIQUE_PATH_JS,
                        None,
                    )
                    .await?;
                    path.as_str()
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .ok_or_else(|| BrowserError::LocatorFailed {
                            selector: p.selector.clone(),
                            reason: "cannot address the resolved <select> with a unique CSS \
                                     path (unstable markup); MCP cannot target it by node id"
                                .to_string(),
                        })?
                }
            };
            self.mcp_call1(
                &sess,
                key,
                tool::SELECT_OPTION,
                json!({ "target": target, "values": values }),
                Some(&p.selector),
            )
            .await?;
        }
        // Truth comes from a native read of the live DOM, not the tool
        // response (readback-of-outcome).
        let read = pw_call_value(
            conn,
            &rec.cdp_session_id,
            Some(oid.as_str()),
            BRIDGE_SELECTED_VALUES_JS,
            None,
        )
        .await?;
        if read.get("error").is_some() {
            return Err(BrowserError::LocatorFailed {
                selector: p.selector.clone(),
                reason: "select_option targets a <select> only".to_string(),
            });
        }
        let selected = read.get("values").cloned().unwrap_or_else(|| json!([]));
        Ok(json!({ "selected_values": selected }))
    }

    pub(crate) async fn bridge_set_checked(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorCheckedPayload,
    ) -> Result<Value, BrowserError> {
        let _guard = self.mcp_call.lock().await;
        let (_route, _bnid, oid) = self
            .bridge_prelude(conn, rec, &p.selector, None, false)
            .await?;
        // Same no-op short-circuit as native: already in the wanted
        // state, report it without touching the page.
        let now = self.bridge_checked(conn, rec, &oid).await?;
        if now == p.checked {
            return Ok(json!({ "checked": now }));
        }
        // Native parity: delegate one click through the full click
        // path (prelude + pin + route selection).
        let click = LocatorClickPayload {
            browser_id: p.browser_id.clone(),
            tab_id: p.tab_id.clone(),
            selector: p.selector.clone(),
            button: None,
            click_count: None,
            force: None,
            modifiers: None,
            timeout_ms: None,
        };
        self.bridge_click_inner(key, conn, rec, &click, false)
            .await?;
        // Re-resolve + re-read: the click may have replaced the node.
        let bnid2 = self
            .pw
            .pw_strict_one(self, conn, rec, &p.selector, 2_000)
            .await?;
        let oid2 = pw_handle(conn, &rec.cdp_session_id, bnid2).await?;
        let after = self.bridge_checked(conn, rec, &oid2).await?;
        if after != p.checked {
            return Err(BrowserError::LocatorFailed {
                selector: p.selector.clone(),
                reason: "checked state did not change after the click".to_string(),
            });
        }
        Ok(json!({ "checked": after }))
    }

    // ── shared element helpers ─────────────────────────────────────────

    async fn bridge_focus(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        oid: &str,
    ) -> Result<(), BrowserError> {
        pw_call_value(conn, &rec.cdp_session_id, Some(oid), BRIDGE_FOCUS_JS, None).await?;
        Ok(())
    }

    async fn bridge_checked(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        oid: &str,
    ) -> Result<bool, BrowserError> {
        let v = pw_call_value(
            conn,
            &rec.cdp_session_id,
            Some(oid),
            BRIDGE_CHECKED_JS,
            None,
        )
        .await?;
        Ok(v.as_bool().unwrap_or(false))
    }

    /// Press `text` one char at a time into the focused element
    /// (newline → Enter). `delay` is honored between presses.
    async fn bridge_press_chars(
        &self,
        t: &McpTarget,
        key: &TurnKey,
        selector: &str,
        text: &str,
        delay: Option<u64>,
    ) -> Result<(), BrowserError> {
        let chars: Vec<char> = text.chars().collect();
        if chars.len() > MAX_KEYBOARD_FILL_CHARS {
            return Err(BrowserError::CapabilityBlocked {
                reason: format!(
                    "keyboard-routed text entry is bounded to {MAX_KEYBOARD_FILL_CHARS} \
                     characters ({} requested); the MCP driver has no focused-element \
                     insert tool",
                    chars.len()
                ),
            });
        }
        for c in chars {
            let key_name = if c == '\n' || c == '\r' {
                "Enter".to_string()
            } else {
                c.to_string()
            };
            self.mcp_call1(
                t,
                key,
                tool::PRESS_KEY,
                json!({ "key": key_name }),
                Some(selector),
            )
            .await?;
            if let Some(d) = delay {
                tokio::time::sleep(Duration::from_millis(d)).await;
            }
        }
        Ok(())
    }

    /// True when the resolved node lives in the tab's MAIN frame
    /// (`DOM.describeNode{objectId}` vs `Page.getFrameTree`).
    async fn bridge_is_main_frame(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        oid: &str,
    ) -> Result<bool, BrowserError> {
        let d = conn
            .call(
                "DOM.describeNode",
                Some(json!({ "objectId": oid })),
                Some(&rec.cdp_session_id),
            )
            .await?;
        let frame = d
            .pointer("/node/frameId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let t = conn
            .call(
                "Page.getFrameTree",
                Some(json!({})),
                Some(&rec.cdp_session_id),
            )
            .await?;
        let root_frame = t
            .pointer("/frameTree/frame/id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Ok(!frame.is_empty() && frame == root_frame)
    }

    /// Map the typed `SelectOptionInput` onto MCP's `values: string[]`
    /// (value preferred, then label; index resolves against the live
    /// option list read natively).
    async fn map_select_values(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        oid: &str,
        option: &SelectOptionInput,
    ) -> Result<Vec<String>, BrowserError> {
        let mut out: Vec<String> = Vec::new();
        let push_one = |s: &SelectOptionSingle, out: &mut Vec<String>| {
            if let Some(v) = &s.value {
                out.push(v.clone());
            } else if let Some(l) = &s.label {
                out.push(l.clone());
            }
        };
        match option {
            SelectOptionInput::Text(t) => out.push(t.clone()),
            SelectOptionInput::Single(s) => push_one(s, &mut out),
            SelectOptionInput::Many(list) => {
                for o in list {
                    match o {
                        SelectOptionOne::Text(t) => out.push(t.clone()),
                        SelectOptionOne::Single(s) => push_one(s, &mut out),
                    }
                }
            }
        }
        // Index-only selections need the live option list (native read).
        let needs_index =
            |s: &SelectOptionSingle| s.value.is_none() && s.label.is_none() && s.index.is_some();
        let index_needed = match option {
            SelectOptionInput::Single(s) => needs_index(s),
            SelectOptionInput::Many(list) => list
                .iter()
                .any(|o| matches!(o, SelectOptionOne::Single(s) if needs_index(s))),
            SelectOptionInput::Text(_) => false,
        };
        if index_needed {
            let read = pw_call_value(
                conn,
                &rec.cdp_session_id,
                Some(oid),
                BRIDGE_OPTIONS_JS,
                None,
            )
            .await?;
            if read.get("error").is_some() {
                return Err(BrowserError::LocatorFailed {
                    selector: String::new(),
                    reason: "select_option targets a <select> only".to_string(),
                });
            }
            let options = read
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let pick =
                |s: &SelectOptionSingle, out: &mut Vec<String>| -> Result<(), BrowserError> {
                    if !needs_index(s) {
                        return Ok(());
                    }
                    let want = s.index.unwrap_or(u32::MAX);
                    options
                        .iter()
                        .find(|o| o.get("index").and_then(Value::as_u64) == Some(want as u64))
                        .and_then(|o| {
                            o.get("value")
                                .and_then(Value::as_str)
                                .or_else(|| o.get("label").and_then(Value::as_str))
                                .map(String::from)
                        })
                        .map(|v| out.push(v))
                        .ok_or_else(|| BrowserError::LocatorFailed {
                            selector: String::new(),
                            reason: format!("select has no option at index {want}"),
                        })?;
                    Ok(())
                };
            match option {
                SelectOptionInput::Single(s) => pick(s, &mut out)?,
                SelectOptionInput::Many(list) => {
                    for o in list {
                        if let SelectOptionOne::Single(s) = o {
                            pick(s, &mut out)?;
                        }
                    }
                }
                SelectOptionInput::Text(_) => {}
            }
        }
        Ok(out)
    }

    // ── cua_* pixel surface ───────────────────────────────────────────

    /// Held-modifier state on a pointer command: MCP's coordinate tools
    /// carry no modifier bitmask — typed validation first (the `keys`
    /// grammar stays), then an honest block when state is actually set.
    fn bridge_held_gate(command: &str, keys: Option<&[String]>) -> Result<(), BrowserError> {
        let mask = held_modifier_mask(command, keys)?;
        if mask != 0 {
            return Err(BrowserError::CapabilityBlocked {
                reason: format!(
                    "{command} with held modifiers cannot route through the MCP \
                     coordinate tools (they carry no modifier state)"
                ),
            });
        }
        Ok(())
    }

    pub(crate) async fn bridge_cua_move(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &CuaMovePayload,
    ) -> Result<Value, BrowserError> {
        validate_point("cua_move", p.x, p.y)?;
        Self::bridge_held_gate("cua_move", p.keys.as_deref())?;
        let _guard = self.mcp_call.lock().await;
        let sess = self.mcp_ready(conn, rec).await?;
        self.mcp_call1(
            &sess,
            key,
            tool::MOUSE_MOVE_XY,
            json!({ "x": p.x, "y": p.y }),
            None,
        )
        .await?;
        Ok(json!({ "tab_id": rec.tab_id, "x": p.x, "y": p.y }))
    }

    pub(crate) async fn bridge_cua_click(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &CuaClickPayload,
        double: bool,
    ) -> Result<Value, BrowserError> {
        let command = if double {
            "cua_double_click"
        } else {
            "cua_click"
        };
        validate_point(command, p.x, p.y)?;
        let b = cua_button_str(command, p.button)?;
        // The reference grammar declares back/forward buttons; MCP's
        // click surface is left|right|middle — typed, never silent.
        if b == "back" || b == "forward" {
            return Err(BrowserError::Unsupported {
                operation: format!("{command} button {} ({b})", p.button.unwrap_or(0)),
            });
        }
        Self::bridge_held_gate(command, p.keys.as_deref())?;
        let _guard = self.mcp_call.lock().await;
        let sess = self.mcp_ready(conn, rec).await?;
        // Hover first (native parity: pointers pass through hover).
        self.mcp_call1(
            &sess,
            key,
            tool::MOUSE_MOVE_XY,
            json!({ "x": p.x, "y": p.y }),
            None,
        )
        .await?;
        self.mcp_call1(
            &sess,
            key,
            tool::MOUSE_CLICK_XY,
            json!({ "x": p.x, "y": p.y, "button": b, "clickCount": if double { 2 } else { 1 } }),
            None,
        )
        .await?;
        Ok(json!({
            "tab_id": rec.tab_id,
            "x": p.x,
            "y": p.y,
            "button": b,
            "click_count": if double { 2 } else { 1 },
        }))
    }

    pub(crate) async fn bridge_cua_scroll(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &CuaScrollPayload,
    ) -> Result<Value, BrowserError> {
        validate_point("cua_scroll", p.x, p.y)?;
        if !p.scroll_x.is_finite() || !p.scroll_y.is_finite() {
            return Err(payload_invalid(
                "cua_scroll",
                "scroll_x/scroll_y must be finite",
            ));
        }
        Self::bridge_held_gate("cua_scroll", p.keys.as_deref())?;
        // Wheels only service the foreground tab — raise natively
        // (observation-side), then move + wheel through the driver
        // (probe-pinned: move_xy then mouse_wheel scrolls the page).
        raise_wheel_target(conn, &rec.cdp_session_id).await;
        let _guard = self.mcp_call.lock().await;
        let sess = self.mcp_ready(conn, rec).await?;
        self.mcp_call1(
            &sess,
            key,
            tool::MOUSE_MOVE_XY,
            json!({ "x": p.x, "y": p.y }),
            None,
        )
        .await?;
        self.mcp_call1(
            &sess,
            key,
            tool::MOUSE_WHEEL,
            json!({ "deltaX": p.scroll_x, "deltaY": p.scroll_y }),
            None,
        )
        .await?;
        Ok(json!({
            "tab_id": rec.tab_id,
            "x": p.x,
            "y": p.y,
            "delta_x": p.scroll_x,
            "delta_y": p.scroll_y,
        }))
    }

    pub(crate) async fn bridge_cua_drag(
        &self,
        key: &TurnKey,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &CuaDragPayload,
    ) -> Result<Value, BrowserError> {
        if p.path.len() < 2 {
            return Err(payload_invalid(
                "cua_drag",
                "drag needs a path of at least two points",
            ));
        }
        for pt in &p.path {
            validate_point("cua_drag", pt.x, pt.y)?;
        }
        Self::bridge_held_gate("cua_drag", p.keys.as_deref())?;
        // Interpolation stays native (reference `dragPath` semantics):
        // MCP's single mouse_drag_xy would skip the dragover waypoints,
        // so the explicit down → waypoints → up sequence is driven
        // through the driver and the reported point count is the truth.
        let path = drag_path(&p.path);
        let start = path[0];
        let end = path[path.len() - 1];
        let _guard = self.mcp_call.lock().await;
        let sess = self.mcp_ready(conn, rec).await?;
        self.mcp_call1(
            &sess,
            key,
            tool::MOUSE_MOVE_XY,
            json!({ "x": start.x, "y": start.y }),
            None,
        )
        .await?;
        self.mcp_call1(
            &sess,
            key,
            tool::MOUSE_DOWN,
            json!({ "button": "left" }),
            None,
        )
        .await?;
        for pt in &path[1..] {
            self.mcp_call1(
                &sess,
                key,
                tool::MOUSE_MOVE_XY,
                json!({ "x": pt.x, "y": pt.y }),
                None,
            )
            .await?;
            tokio::time::sleep(Duration::from_millis(DRAG_STEP_MS)).await;
        }
        self.mcp_call1(
            &sess,
            key,
            tool::MOUSE_UP,
            json!({ "x": end.x, "y": end.y, "button": "left" }),
            None,
        )
        .await?;
        Ok(json!({
            "tab_id": rec.tab_id,
            "from": { "x": start.x, "y": start.y },
            "to": { "x": end.x, "y": end.y },
            "points": path.len(),
        }))
    }
}

// ── unit tests (pure layer: grammar, routing, mapping) ───────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ff(name: &str, ty: FormFieldType, target: &str, value: &str) -> FormFormField {
        FormFormField {
            name: name.to_string(),
            field_type: ty,
            target: target.to_string(),
            value: value.to_string(),
        }
    }

    fn payload_reason(e: &BrowserError) -> String {
        match e {
            BrowserError::PayloadInvalid { reason, .. } => reason.clone(),
            other => other.to_string(),
        }
    }

    #[test]
    fn empty_form_batch_is_a_payload_error() {
        let e = validate_fill_form(&[]).unwrap_err();
        assert!(matches!(e, BrowserError::PayloadInvalid { .. }));
        assert!(payload_reason(&e).contains("at least one field"));
    }

    #[test]
    fn oversized_form_batch_names_the_cap() {
        let big = vec![ff("f", FormFieldType::Textbox, "#i", "v"); MAX_FORM_FIELDS + 1];
        let e = validate_fill_form(&big).unwrap_err();
        assert!(payload_reason(&e).contains(&MAX_FORM_FIELDS.to_string()));
    }

    #[test]
    fn blank_names_and_targets_are_rejected_by_name() {
        let e = validate_fill_form(&[ff("  ", FormFieldType::Textbox, "#a", "v")]).unwrap_err();
        assert!(payload_reason(&e).contains("non-empty name"));
        let e = validate_fill_form(&[ff("a", FormFieldType::Textbox, " ", "v")]).unwrap_err();
        assert!(payload_reason(&e).contains("non-empty target"));
    }

    #[test]
    fn checkbox_values_must_be_literal_boolean_strings() {
        let e = validate_fill_form(&[ff("c", FormFieldType::Checkbox, "#c", "True")]).unwrap_err();
        let r = payload_reason(&e);
        assert!(
            r.contains("must be \"true\" or \"false\""),
            "unhelpful: {r}"
        );
    }

    #[test]
    fn form_batch_wire_shape_matches_the_pinned_driver() {
        let v = validate_fill_form(&[ff(
            "plan",
            FormFieldType::Radio,
            "input[name=\"plan\"][value=\"annual\"]",
            "true",
        )])
        .unwrap();
        assert_eq!(
            v[0],
            json!({
                "target": "input[name=\"plan\"][value=\"annual\"]",
                "name": "plan",
                "type": "radio",
                "value": "true",
            })
        );
    }

    #[test]
    fn combobox_holds_on_option_text_or_value_attr() {
        let f = ff("plan", FormFieldType::Combobox, "#plan", "business");
        assert!(field_holds(&f, "business", None));
        assert!(field_holds(&f, "Business Plan", Some("business")));
        assert!(!field_holds(&f, "personal", Some("personal")));
        let c = ff("agree", FormFieldType::Checkbox, "#agree", "true");
        assert!(field_holds(&c, "true", None));
        assert!(!field_holds(&c, "false", Some("business")));
    }

    #[test]
    fn form_state_description_splits_applied_missing_unverifiable() {
        let fields = vec![
            ff("a", FormFieldType::Textbox, "#a", "x"),
            ff("b", FormFieldType::Checkbox, "#b", "true"),
            ff("c", FormFieldType::Textbox, "#c", "y"),
        ];
        let states = vec![
            FormFieldState {
                found: true,
                actual: "x".into(),
                alt: None,
            },
            FormFieldState {
                found: true,
                actual: "false".into(),
                alt: None,
            },
            FormFieldState {
                found: false,
                actual: String::new(),
                alt: None,
            },
        ];
        let d = describe_form_state(&fields, &states);
        assert!(d.contains("applied: a"), "{d}");
        assert!(d.contains("not applied: b"), "{d}");
        assert!(d.contains("unverifiable: c"), "{d}");
    }

    // ── Audit findings 1 + 2 (2026-11-06): the batch must never claim
    // success it cannot prove, in EITHER direction ────────────────────

    fn st(found: bool, actual: &str) -> FormFieldState {
        FormFieldState {
            found,
            actual: actual.into(),
            alt: None,
        }
    }

    #[test]
    fn readback_never_verifies_a_field_the_page_could_not_be_read_for() {
        // The exact false-positive the audit found: the model CLEARS a text
        // box (intended ""), the target vanished between apply and read-back
        // (found:false, actual:""), and `field_holds` alone called that
        // "verified". An unread field is unverifiable, never applied.
        let fields = vec![ff("query", FormFieldType::Textbox, "#q", "")];
        let resp = form_readback_response(&fields, &[st(false, "")]);
        assert_eq!(resp["applied"], json!(0));
        assert_eq!(resp["all_verified"], json!(false));
        assert_eq!(resp["fields"][0]["state"], json!("unverifiable"));
        assert_eq!(resp["fields"][0]["verified"], json!(false));
        let note = resp["note"].as_str().unwrap_or_default();
        assert!(note.contains("unverifiable: query"), "{note}");

        // The same intended value IS verifiable when the read actually saw
        // the element — clearing a field is a legitimate applied state.
        let ok = form_readback_response(&fields, &[st(true, "")]);
        assert_eq!(ok["applied"], json!(1));
        assert_eq!(ok["all_verified"], json!(true));
        assert_eq!(ok["fields"][0]["state"], json!("applied"));
    }

    #[test]
    fn readback_response_labels_applied_not_applied_unverifiable_per_field() {
        let fields = vec![
            ff("a", FormFieldType::Textbox, "#a", "x"),
            ff("b", FormFieldType::Checkbox, "#b", "true"),
            ff("c", FormFieldType::Combobox, "#c", "business"),
            ff("d", FormFieldType::Textbox, "#d", "y"),
        ];
        let states = vec![
            st(true, "x"),
            st(true, "false"),
            FormFieldState {
                found: true,
                actual: "Business Plan".into(),
                alt: Some("business".into()),
            },
            st(false, ""),
        ];
        let resp = form_readback_response(&fields, &states);
        let states_out: Vec<&str> = resp["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["state"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            states_out,
            ["applied", "not-applied", "applied", "unverifiable"]
        );
        assert_eq!(resp["applied"], json!(2));
        assert_eq!(resp["total"], json!(4));
        assert_eq!(resp["all_verified"], json!(false));
    }

    #[test]
    fn probe_verdicts_demands_the_probe_answered_the_contract() {
        let fields = vec![
            ff("a", FormFieldType::Textbox, "#a", "x"),
            ff("b", FormFieldType::Combobox, "#b", "y"),
        ];
        // Well-formed: one verdict per field, null = usable.
        let good = probe_verdicts(
            &fields,
            &json!([
                null,
                "element is not a combobox (<select> or [role=combobox])"
            ]),
        )
        .unwrap();
        assert_eq!(good[0], None);
        assert_eq!(
            good[1].as_deref(),
            Some("element is not a combobox (<select> or [role=combobox])")
        );

        // Malformed responses must NOT read as "all clear" (finding 2: the
        // old code keyed on "is any row a string", so these silently applied
        // the whole batch).
        for bad in [
            json!(null),
            json!("ok"),
            json!([]),
            json!([null]),
            json!([null, 7]),
            json!({"0": "x"}),
        ] {
            let e = probe_verdicts(&fields, &bad).unwrap_err();
            assert!(!e.is_empty(), "{bad} must be rejected");
        }
        // A short/long array and a non-string verdict name what went wrong.
        assert!(probe_verdicts(&fields, &json!([null]))
            .unwrap_err()
            .contains("1 verdict(s) for 2 field(s)"));
        assert!(probe_verdicts(&fields, &json!([null, true]))
            .unwrap_err()
            .contains("neither null nor a string"));
    }

    #[test]
    fn plain_css_routes_direct_multi_segment_and_engines_do_not() {
        assert_eq!(main_css_target("button").as_deref(), Some("button"));
        assert_eq!(main_css_target(".dup").as_deref(), Some(".dup"));
        assert_eq!(main_css_target("#x > li").as_deref(), Some("#x > li"));
        // `css=` is not this port's CSS-marker surface: parse_selector
        // rejects it as an unsupported engine, and the bridge keeps
        // that typed rejection instead of letting MCP accept it.
        assert!(main_css_target("css=.ok").is_none());
        // engine prefixes never reach MCP's target surface…
        assert!(main_css_target("internal:role=button").is_none());
        assert!(main_css_target("text=hello").is_none());
        assert!(main_css_target("visible=true").is_none());
        // …and neither do frame hops / ref chains.
        assert!(main_css_target("button >> input").is_none());
    }

    #[test]
    fn press_grammar_maps_to_mcp_press_surface() {
        assert_eq!(mcp_press_key_expr("Enter").unwrap(), "Enter");
        assert_eq!(mcp_press_key_expr("Control+a").unwrap(), "Control+a");
        assert_eq!(
            mcp_press_key_expr("Ctrl+Shift+Delete").unwrap(),
            "Control+Shift+Delete"
        );
        assert_eq!(mcp_press_key_expr("Super+Enter").unwrap(), "Meta+Enter");
        assert_eq!(mcp_press_key_expr("a").unwrap(), "a");
        let e = mcp_press_key_expr("nosuchkey").unwrap_err();
        assert!(e.to_string().contains("unknown key"));
        let e = mcp_press_key_expr("bogus+a").unwrap_err();
        assert!(e.to_string().contains("bogus"));
        // `combo_mask`'s grammar is case-sensitive and stays so here:
        // lowercase xdotool aliases belong to the dom_cua_keypress
        // surface (which normalizes them itself), not to locator press.
        let e = mcp_press_key_expr("ctrl+a").unwrap_err();
        assert!(e.to_string().contains("unknown modifier \"ctrl\""));
    }

    #[test]
    fn tool_errors_back_map_to_typed_locator_surface() {
        let e = map_tool_error(
            "browser_click".into(),
            "strict mode violation: locator(\".dup\") resolved to 2 elements".into(),
            Some(".dup"),
        );
        match e {
            BrowserError::LocatorStrict { selector, count } => {
                assert_eq!(selector, ".dup");
                assert_eq!(count, 2);
            }
            other => panic!("{other:?}"),
        }
        let e = map_tool_error(
            "browser_click".into(),
            "Timeout 10000ms exceeded".into(),
            Some("button"),
        );
        match e {
            BrowserError::LocatorTimeout {
                state, timeout_ms, ..
            } => {
                assert_eq!(state, "actionable");
                assert_eq!(timeout_ms, 10000);
            }
            other => panic!("{other:?}"),
        }
        let e = map_tool_error("browser_type".into(), "not an input".into(), Some("div"));
        assert!(matches!(e, BrowserError::LocatorFailed { .. }));
        // coordinate routes stay driver-honest, not fake-locator:
        let e = map_tool_error("browser_click_xy".into(), "bad point".into(), None);
        assert!(matches!(e, BrowserError::McpToolFailed { .. }));
    }

    #[test]
    fn timeout_and_count_parsers_are_bounded() {
        assert_eq!(parse_resolved_count("resolved to 2 elements"), Some(2));
        assert_eq!(parse_resolved_count("resolved to many"), None);
        assert_eq!(parse_resolved_count("resolved to 1 element"), None);
        assert_eq!(
            parse_timeout_ms("Timeout 10000ms exceeded waiting"),
            Some(10000)
        );
        assert_eq!(parse_timeout_ms("no number here"), None);
    }

    #[test]
    fn held_gate_validates_grammar_before_blocking() {
        // unknown token is still the typed payload refusal…
        let e = BrowserRuntime::bridge_held_gate("cua_click", Some(&["banana".to_string()]))
            .unwrap_err();
        assert!(e.to_string().contains("not a held-modifier name"));
        // …a valid set is the honest capability block…
        let e =
            BrowserRuntime::bridge_held_gate("cua_move", Some(&["ctrl".to_string()])).unwrap_err();
        assert!(e.to_string().contains("no modifier state"));
        // …and no keys passes through.
        assert!(BrowserRuntime::bridge_held_gate("cua_move", None).is_ok());
    }

    #[test]
    fn parses_captured_chooser_refusal() {
        // Verbatim from the 2026-11-06 modal-state repro
        // (`.ai-coordination/fixture-run.log`): the exact grammar the
        // recovery law keys on.
        let text = r#"Error: Tool "browser_click" does not handle the modal state.
### Modal state
- [File chooser]: can be handled by browser_file_upload"#;
        assert_eq!(parse_modal_state(text), Some(ModalKind::Chooser));
    }

    #[test]
    fn parses_dialog_refusal() {
        // The dialog entry form captured live in
        // `.ai-coordination/mcp-chooser-proto.mjs` stage A.
        let text = r###"Error: Tool "browser_click" does not handle the modal state.
### Modal state
- ["alert" dialog with message "D-MARK"]: can be handled by browser_handle_dialog"###;
        assert_eq!(parse_modal_state(text), Some(ModalKind::Dialog));
    }

    #[test]
    fn modal_state_sections_on_other_errors_are_not_recoverable() {
        // A `### Modal state` section without the refusal phrase (e.g.
        // the SUCCESS suffix every mutating tool appends) is not a
        // refusal and must never trigger recovery…
        let text = r#"Something else failed.
### Modal state
- [File chooser]: can be handled by browser_file_upload"#;
        assert_eq!(parse_modal_state(text), None);
        // …and the upload tool's own "no modal state present" error is
        // an ordinary tool failure (the set_files bridge method maps
        // it to the native fallback), not a recoverable refusal.
        let text = "Tool \"browser_file_upload\" can only be used when \
                    there is related modal state present at the beginning of the navigation.";
        assert_eq!(parse_modal_state(text), None);
    }
}
