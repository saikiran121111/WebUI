//! Phase 8 — the `tab_ax_action` executor (dom-snapshot §5 action
//! dispatch over the COMMITTED accessibility revision).
//!
//! The model was just shown a rendered AX tree whose lines carry
//! `element_index` handles. Those handles address the committed
//! revision only — this module resolves them against the live page and
//! enforces the recovered staleness contract:
//!
//! * index absent from the committed revision → [`BrowserError::StaleAxElement`]
//!   ("that element is not on the page you were shown");
//! * committed `documentKey` ≠ current `documentKey` →
//!   [`BrowserError::AxPreviousPage`] ("the page changed under the
//!   revision you were shown — re-inspect before acting").
//!
//! Element actions reuse the Phase-7 trusted-input primitives:
//! `DOM.scrollIntoViewIfNeeded` → settled `DOM.getBoxModel` center →
//! `document.elementFromPoint` containment hit-test →
//! `Input.dispatchMouseEvent`. A box that never appears is a broken
//! handle ([`BrowserError::ClickFailed`]); a box that is still moving
//! at the deadline is [`BrowserError::ClickNotSettled`]; a box whose
//! center belongs to another element is [`BrowserError::ClickCovered`].
//!
//! The dialog race is `[adapted]`: the recovered engine aborts an
//! in-flight action when a JavaScript dialog opens mid-action and tells
//! the model the action MAY already have taken effect (do not retry).
//! Ruke cannot interrupt an await mid-CDP-round-trip, so the race is
//! detected at the action boundary — if the per-tab dialog generation
//! changed while the action ran, the pending dialog is consumed and a
//! [`BrowserError::JsDialogInterrupted`] is surfaced instead of the
//! action result.
//!
//! Point-target actions (`AxTarget::Point`) are raw viewport
//! coordinates — validated against `cssVisualViewport`, no hit-test,
//! no settle (the human-facing CUA semantics).

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::ax::AxElementRef;
use crate::cdp::CdpConn;
use crate::engine::BrowserRuntime;
use crate::errors::{payload_invalid, BrowserError};
use crate::pw::{
    pw_box_center, pw_call_value, pw_dispatch_click, pw_handle, pw_key_spec, pw_scroll_into_view,
    pw_send_key,
};
use crate::schemas::{
    AxAction, AxActionPayload, AxMouseButton, AxSelectionType, AxTarget, PasteFormat,
    ScrollDirection,
};
use crate::session::TabRecord;

/// Box-settle window for trusted element clicks: poll the box center
/// every `SETTLE_POLL_MS` until it is stable within `SETTLE_TOL`.
const SETTLE_TIMEOUT_MS: u64 = 500;
const SETTLE_POLL_MS: u64 = 25;
const SETTLE_TOL: f64 = 0.5;

/// How long an element may take to become ready for input after the
/// focus/click prepare (the recovered "Could not prepare accessibility
/// element N for input within 3000 ms" contract).
const INPUT_PREPARE_MS: u64 = 3_000;
const INPUT_PREPARE_POLL_MS: u64 = 100;

/// Interpolated `mouseMoved` events in a trusted drag (HTML5 dnd needs
/// intermediate moves; a press→release jump never fires dragstart).
const DRAG_STEPS: u32 = 8;

/// Recovered secondary-action grammar: only Expand/Collapse are
/// dispatchable, and only when the committed tree advertised them.
fn secondary_action_allowed(action: &str, advertised: &[String]) -> bool {
    (action == "Expand" || action == "Collapse") && advertised.iter().any(|a| a == action)
}

fn button_name(mb: Option<AxMouseButton>) -> &'static str {
    match mb.unwrap_or(AxMouseButton::Left) {
        AxMouseButton::Left | AxMouseButton::L => "left",
        AxMouseButton::Right | AxMouseButton::R => "right",
        AxMouseButton::Middle | AxMouseButton::M => "middle",
    }
}

fn sel_type_name(st: Option<AxSelectionType>) -> &'static str {
    match st.unwrap_or(AxSelectionType::Text) {
        AxSelectionType::Text => "text",
        AxSelectionType::CursorBefore => "cursor_before",
        AxSelectionType::CursorAfter => "cursor_after",
    }
}

/// `duration` seconds → between-key delay ms; the schema bounds
/// 0..=30 s but the payload is user-supplied so the executor re-checks.
fn duration_delay_ms(duration: Option<f64>) -> Result<u64, BrowserError> {
    match duration {
        None => Ok(0),
        Some(s) if s.is_finite() && (0.0..=30.0).contains(&s) => Ok((s * 1000.0) as u64),
        Some(_) => Err(payload_invalid(
            "tab_ax_action",
            "duration must be within 0..=30 seconds",
        )),
    }
}

/// Resolve the committed-revision element for `element_index`, then
/// reject "the page moved" (the two document keys differ) so a stale
/// handle is never aimed at a fresh document.
fn ax_node_of(el: &AxElementRef, element_index: u64) -> Result<i64, BrowserError> {
    el.target
        .backend_dom_node_id
        .ok_or(BrowserError::StaleAxElement { element_index })
}

/// `DOM.resolveNode` → `Runtime.callFunctionOn` convenience for the
/// JS-backed actions (hit-test, select, set value): the node binds as
/// `this` (pw.rs probe law) and args serialize as plain values.
async fn ax_call(
    conn: &CdpConn,
    session: &str,
    bnid: i64,
    declaration: &str,
    args: Vec<Value>,
) -> Result<Value, BrowserError> {
    let object_id = pw_handle(conn, session, bnid).await?;
    pw_call_value(conn, session, Some(&object_id), declaration, Some(args)).await
}

impl BrowserRuntime {
    /// The `tab_ax_action` entry: dialog-race wrapper around the inner
    /// action dispatch (module docs — race detected at the boundary).
    pub(crate) async fn tab_ax_action(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &AxActionPayload,
    ) -> Result<Value, BrowserError> {
        let kind = p.action.kind_name();
        let gen = self.io.dialog_generation(&rec.tab_id);
        let out = self.ax_action_inner(conn, rec, p).await;
        // A dialog that opened mid-action outranks both the action
        // result and the action error: the model must learn a dialog
        // is pending AND that the action may already have taken
        // effect, either way retrying blind is unsafe.
        if self.io.dialog_generation(&rec.tab_id) != gen {
            if let Some(d) = self.io.interrupt_dialog(&rec.tab_id) {
                return Err(BrowserError::JsDialogInterrupted {
                    action_kind: kind.to_string(),
                    dialog_type: d.dialog_type,
                    // Quoted so the model sees the exact dialog copy.
                    detail: format!("\"{}\"", d.message),
                });
            }
        }
        out
    }

    async fn ax_action_inner(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &AxActionPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        match &p.action {
            AxAction::Click {
                target,
                mouse_button,
                click_count,
            } => {
                let button = button_name(*mouse_button);
                let count = click_count.unwrap_or(1);
                match target {
                    AxTarget::ElementIndex(idx) => {
                        let el = self.ax_element_ref(rec, *idx)?;
                        if el.target.is_option_element {
                            self.ax_click_option(conn, session, &el).await?;
                        } else {
                            let bnid = ax_node_of(&el, *idx)?;
                            self.ax_click_element(conn, session, *idx, bnid, button, count)
                                .await?;
                        }
                    }
                    AxTarget::Point(pt) => {
                        let (x, y) = self.ax_point(conn, session, pt.x, pt.y).await?;
                        pw_dispatch_click(conn, session, x, y, button, count, 0).await?;
                    }
                }
            }
            AxAction::Drag { from, to } => {
                let (fx, fy) = self.ax_target_point(conn, rec, from).await?;
                let (tx, ty) = self.ax_target_point(conn, rec, to).await?;
                conn.call(
                    "Input.dispatchMouseEvent",
                    Some(json!({"type":"mousePressed","x":fx,"y":fy,"button":"left","clickCount":1,"modifiers":0})),
                    Some(session),
                )
                .await?;
                for i in 1..=DRAG_STEPS {
                    let t = (i as f64) / (DRAG_STEPS as f64);
                    conn.call(
                        "Input.dispatchMouseEvent",
                        Some(json!({"type":"mouseMoved","x":fx+(tx-fx)*t,"y":fy+(ty-fy)*t,"button":"left","clickCount":1,"modifiers":0})),
                        Some(session),
                    )
                    .await?;
                }
                conn.call(
                    "Input.dispatchMouseEvent",
                    Some(json!({"type":"mouseReleased","x":tx,"y":ty,"button":"left","clickCount":1,"modifiers":0})),
                    Some(session),
                )
                .await?;
            }
            AxAction::PerformSecondaryAction {
                element_index,
                action,
            } => {
                let el = self.ax_element_ref(rec, *element_index)?;
                if !secondary_action_allowed(action, &el.target.action_descriptions) {
                    return Err(BrowserError::SecondaryActionNotAllowed {
                        action: action.clone(),
                    });
                }
                let bnid = ax_node_of(&el, *element_index)?;
                self.ax_click_element(conn, session, *element_index, bnid, "left", 1)
                    .await?;
            }
            AxAction::PressKey {
                element_index,
                key,
                duration,
            } => {
                let spec = pw_key_spec(key).ok_or_else(|| {
                    payload_invalid("tab_ax_action", format!("unknown key \"{key}\""))
                })?;
                let delay = duration_delay_ms(*duration)?;
                if let Some(idx) = element_index {
                    self.ax_focus_element(conn, rec, *idx).await?;
                }
                pw_send_key(conn, session, &spec, 0, delay).await?;
            }
            AxAction::Scroll {
                target,
                direction,
                pages,
            } => {
                let (x, y) = self.ax_target_point(conn, rec, target).await?;
                let (w, h) = self.ax_viewport(conn, session).await?;
                let pages = pages.unwrap_or(1.0);
                let (mut dx, mut dy) = (0.0, 0.0);
                match direction {
                    ScrollDirection::Up | ScrollDirection::U => dy = -(h.max(100.0)) * pages,
                    ScrollDirection::Down | ScrollDirection::D => dy = (h.max(100.0)) * pages,
                    ScrollDirection::Left | ScrollDirection::L => dx = -(w.max(100.0)) * pages,
                    ScrollDirection::Right | ScrollDirection::R => dx = (w.max(100.0)) * pages,
                }
                // Wheels only service the composited (foreground) tab —
                // raise it before the dispatch (engine::raise_wheel_target).
                crate::engine::raise_wheel_target(conn, session).await;
                conn.call(
                    "Input.dispatchMouseEvent",
                    Some(json!({"type":"mouseWheel","x":x,"y":y,"deltaX":dx,"deltaY":dy,"modifiers":0})),
                    Some(session),
                )
                .await?;
            }
            AxAction::SelectText {
                element_index,
                text,
                prefix,
                suffix,
                selection_type,
            } => {
                let el = self.ax_element_ref(rec, *element_index)?;
                let bnid = ax_node_of(&el, *element_index)?;
                // Form fields take the native selection API; text nodes
                // take a TreeWalker offset walk into a live Range. The
                // prefix/suffix disambiguates repeats exactly as the
                // recovered grammar pins (not found / ambiguous errors).
                let decl = r#"function(text, prefix, suffix, selType) {
                    const pre = prefix || '', suf = suffix || '';
                    const needle = pre + text + suf;
                    const kind = selType === 'cursor_before' ? 'before'
                                 : selType === 'cursor_after' ? 'after' : 'text';
                    if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
                        const v = this.value || '';
                        const at = v.indexOf(needle);
                        if (at === -1) return { err: 'not-found' };
                        if (v.indexOf(needle, at + 1) !== -1) return { err: 'ambiguous' };
                        const s = at + pre.length, e = s + text.length;
                        this.focus();
                        if (kind === 'before') this.setSelectionRange(s, s);
                        else if (kind === 'after') this.setSelectionRange(e, e);
                        else this.setSelectionRange(s, e);
                        return { ok: true };
                    }
                    const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
                    let full = '';
                    const offs = [];
                    while (walker.nextNode()) {
                        const n = walker.currentNode;
                        offs.push([n, full.length]);
                        full += n.nodeValue || '';
                    }
                    const at = full.indexOf(needle);
                    if (at === -1) return { err: 'not-found' };
                    if (full.indexOf(needle, at + 1) !== -1) return { err: 'ambiguous' };
                    const s = at + pre.length, e = s + text.length;
                    const find = (pos) => {
                        for (const pair of offs) {
                            const len = (pair[0].nodeValue || '').length;
                            if (pos >= pair[1] && pos <= pair[1] + len) return [pair[0], pos - pair[1]];
                        }
                        return null;
                    };
                    const a = find(s), b = find(e);
                    if (!a || !b) return { err: 'not-found' };
                    const range = document.createRange();
                    if (kind === 'before') { range.setStart(a[0], a[1]); range.collapse(true); }
                    else if (kind === 'after') { range.setStart(b[0], b[1]); range.collapse(true); }
                    else { range.setStart(a[0], a[1]); range.setEnd(b[0], b[1]); }
                    const sel = getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return { ok: true };
                }"#;
                let v = ax_call(
                    conn,
                    session,
                    bnid,
                    decl,
                    vec![
                        json!(text),
                        json!(prefix.clone().unwrap_or_default()),
                        json!(suffix.clone().unwrap_or_default()),
                        json!(sel_type_name(*selection_type)),
                    ],
                )
                .await?;
                if v.get("ok").and_then(Value::as_bool) == Some(true) {
                    return Ok(action_result(rec, p));
                }
                return Err(match v.pointer("/err").and_then(Value::as_str) {
                    Some("ambiguous") => BrowserError::SelectTextAmbiguous,
                    _ => BrowserError::SelectTextNotFound,
                });
            }
            AxAction::SetValue {
                element_index,
                value,
            } => {
                let el = self.ax_element_ref(rec, *element_index)?;
                let bnid = ax_node_of(&el, *element_index)?;
                // Native prototype setters (React-controlled inputs
                // ignore direct property writes), select by value-then-
                // unique-label, and a retention check: a value the page
                // did not keep is not a value the model should believe.
                let decl = r#"function(value) {
                    const t = this.tagName;
                    const ty = (this.type || '').toLowerCase();
                    if (t === 'INPUT' && ty === 'file') return { err: 'file-input' };
                    const fire = () => {
                        this.dispatchEvent(new Event('input', { bubbles: true }));
                        this.dispatchEvent(new Event('change', { bubbles: true }));
                    };
                    if (t === 'INPUT' && (ty === 'checkbox' || ty === 'radio')) {
                        const on = /^(true|1|checked|yes|on)$/i.test(value);
                        const off = /^(false|0|unchecked|no|off)$/i.test(value);
                        if (!on && !off) return { err: 'no-settable' };
                        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')
                            .set.call(this, on);
                        fire();
                        return { ok: true, held: String(this.checked), want: String(on) };
                    }
                    if (t === 'SELECT') {
                        const opts = Array.from(this.options);
                        let m = opts.find(o => o.value === value);
                        if (!m) {
                            const byLabel = opts.filter(o => o.label === value);
                            if (byLabel.length === 1) m = byLabel[0];
                        }
                        if (!m) return { err: 'no-settable' };
                        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
                            .set.call(this, m.value);
                        fire();
                        return { ok: true, held: this.value, want: m.value };
                    }
                    if (t === 'TEXTAREA' || t === 'INPUT') {
                        const applied = (t === 'INPUT' && ty === 'color') ? value.toLowerCase() : value;
                        const proto = t === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                        Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, applied);
                        fire();
                        return { ok: true, held: this.value, want: applied };
                    }
                    return { err: 'no-settable' };
                }"#;
                let v = ax_call(conn, session, bnid, decl, vec![json!(value)]).await?;
                if v.get("ok").and_then(Value::as_bool) == Some(true) {
                    let held = v.get("held").and_then(Value::as_str).unwrap_or("");
                    let want = v.get("want").and_then(Value::as_str).unwrap_or("");
                    if held != want {
                        return Err(payload_invalid(
                            "tab_ax_action",
                            format!(
                                "element {element_index} did not retain the value (the page rejected it)"
                            ),
                        ));
                    }
                    return Ok(action_result(rec, p));
                }
                return Err(match v.pointer("/err").and_then(Value::as_str) {
                    Some("file-input") => payload_invalid(
                        "tab_ax_action",
                        "file inputs cannot be set with set_value; use playwright_file_chooser_set_files",
                    ),
                    _ => BrowserError::NoSettableValue {
                        element_index: *element_index,
                    },
                });
            }
            AxAction::TypeText {
                element_index,
                text,
            } => {
                if let Some(idx) = element_index {
                    self.ax_focus_element(conn, rec, *idx).await?;
                }
                conn.call(
                    "Input.insertText",
                    Some(json!({"text": text})),
                    Some(session),
                )
                .await?;
            }
            AxAction::Paste {
                element_index,
                text,
                format,
            } => {
                if let Some(idx) = element_index {
                    self.ax_focus_element(conn, rec, *idx).await?;
                }
                match format.unwrap_or(PasteFormat::Text) {
                    // The recovered html-paste path keeps pasted
                    // structure via insertHTML; text/md ride insertText.
                    PasteFormat::Html => {
                        Self::eval_string(
                            conn,
                            session,
                            &format!("document.execCommand('insertHTML', false, {})", json!(text)),
                        )
                        .await?;
                    }
                    PasteFormat::Text | PasteFormat::Md => {
                        conn.call(
                            "Input.insertText",
                            Some(json!({"text": text})),
                            Some(session),
                        )
                        .await?;
                    }
                }
            }
        }
        Ok(action_result(rec, p))
    }

    // ── element resolution / staleness ──────────────────────────────

    fn ax_element_ref(
        &self,
        rec: &TabRecord,
        element_index: u64,
    ) -> Result<AxElementRef, BrowserError> {
        let el = self
            .ax
            .ax_element(&rec.tab_id, element_index)
            .ok_or(BrowserError::StaleAxElement { element_index })?;
        if el.committed_document_key != el.current_document_key {
            return Err(BrowserError::AxPreviousPage { element_index });
        }
        Ok(el)
    }

    /// Resolve an `AxTarget` to a dispatch coordinate: element targets
    /// scroll into view and take their current box center; point
    /// targets are viewport-validated.
    async fn ax_target_point(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        target: &AxTarget,
    ) -> Result<(f64, f64), BrowserError> {
        let session = rec.cdp_session_id.as_str();
        match target {
            AxTarget::ElementIndex(idx) => {
                let el = self.ax_element_ref(rec, *idx)?;
                let bnid = ax_node_of(&el, *idx)?;
                pw_scroll_into_view(conn, session, bnid).await.ok();
                pw_box_center(conn, session, bnid)
                    .await?
                    .ok_or(BrowserError::ClickFailed {
                        element: idx.to_string(),
                    })
            }
            AxTarget::Point(pt) => self.ax_point(conn, session, pt.x, pt.y).await,
        }
    }

    async fn ax_point(
        &self,
        conn: &CdpConn,
        session: &str,
        x: f64,
        y: f64,
    ) -> Result<(f64, f64), BrowserError> {
        let (w, h) = self.ax_viewport(conn, session).await?;
        if x < 0.0 || y < 0.0 || x >= w || y >= h {
            return Err(payload_invalid(
                "tab_ax_action",
                "Coordinate is outside the active tab content viewport",
            ));
        }
        Ok((x, y))
    }

    async fn ax_viewport(&self, conn: &CdpConn, session: &str) -> Result<(f64, f64), BrowserError> {
        let m = conn
            .call("Page.getLayoutMetrics", None, Some(session))
            .await?;
        let vp = m.get("cssVisualViewport").unwrap_or(&m);
        let w = vp.pointer("/width").and_then(Value::as_f64).unwrap_or(0.0);
        let h = vp.pointer("/height").and_then(Value::as_f64).unwrap_or(0.0);
        Ok((w.max(1.0), h.max(1.0)))
    }

    // ── trusted click pipeline ──────────────────────────────────────

    /// scroll into view → box-settle → hit-test containment → trusted
    /// press/release. Failure modes mirror the recovered error grammar
    /// (see module docs).
    async fn ax_click_element(
        &self,
        conn: &CdpConn,
        session: &str,
        element_index: u64,
        bnid: i64,
        button: &str,
        click_count: u32,
    ) -> Result<(), BrowserError> {
        let element = element_index.to_string();
        pw_scroll_into_view(conn, session, bnid).await.ok();
        let deadline = Instant::now() + Duration::from_millis(SETTLE_TIMEOUT_MS);
        let mut prev: Option<(f64, f64)> = None;
        let mut settled: Option<(f64, f64)> = None;
        let mut saw_box = false;
        loop {
            let center = pw_box_center(conn, session, bnid).await.unwrap_or(None);
            if let Some(c) = center {
                saw_box = true;
                match prev {
                    Some((px, py))
                        if (c.0 - px).abs() <= SETTLE_TOL && (c.1 - py).abs() <= SETTLE_TOL =>
                    {
                        settled = Some(c);
                        break;
                    }
                    _ => prev = Some(c),
                }
            } else {
                prev = None;
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(SETTLE_POLL_MS)).await;
        }
        if !saw_box {
            return Err(BrowserError::ClickFailed { element });
        }
        let (x, y) = settled.ok_or(BrowserError::ClickNotSettled {
            element: element.clone(),
        })?;
        let decl = r#"function(x, y) {
            const hit = document.elementFromPoint(x, y);
            if (!hit) return "none";
            if (hit === this || this.contains(hit) || hit.contains(this)) return "ok";
            return (hit.tagName || "another element").toLowerCase();
        }"#;
        let verdict = ax_call(conn, session, bnid, decl, vec![json!(x), json!(y)])
            .await?
            .as_str()
            .unwrap_or("none")
            .to_string();
        if verdict != "ok" {
            return Err(BrowserError::ClickCovered {
                element,
                covering: if verdict == "none" {
                    "another element".to_string()
                } else {
                    verdict
                },
            });
        }
        pw_dispatch_click(conn, session, x, y, button, click_count, 0).await
    }

    /// `<option>` clicks: a single-select option takes the recovered
    /// JS selection path (native `selected` + input/change dispatch +
    /// verification); multi-select options and options with no owning
    /// `<select>` fall back to the trusted physical click so the page's
    /// own modifier logic still runs.
    async fn ax_click_option(
        &self,
        conn: &CdpConn,
        session: &str,
        el: &AxElementRef,
    ) -> Result<(), BrowserError> {
        let idx = el.target.element_index;
        let bnid = ax_node_of(el, idx)?;
        let decl = r#"function() {
            const sel = this.closest ? this.closest('select') : null;
            if (!sel) return { kind: 'no-select' };
            if (sel.multiple) return { kind: 'multi' };
            this.selected = true;
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            if (sel.value !== this.value) return { err: 'changed' };
            return { kind: 'single' };
        }"#;
        let v = ax_call(conn, session, bnid, decl, vec![])
            .await
            .unwrap_or(json!({ "kind": "no-select" }));
        if v.pointer("/kind").and_then(Value::as_str) == Some("single") {
            return Ok(());
        }
        if v.pointer("/err").and_then(Value::as_str) == Some("changed") {
            return Err(BrowserError::SelectChangedBeforeActivation);
        }
        self.ax_click_element(conn, session, idx, bnid, "left", 1)
            .await
    }

    /// Prepare an element for keyboard input: scroll, try `focus()`
    /// (falling back to a trusted click for pointer-driven widgets),
    /// then poll until the focused element can accept typed input —
    /// the recovered 3000 ms "prepare for input" budget.
    async fn ax_focus_element(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        element_index: u64,
    ) -> Result<(), BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let el = self.ax_element_ref(rec, element_index)?;
        let bnid = ax_node_of(&el, element_index)?;
        pw_scroll_into_view(conn, session, bnid).await.ok();
        let focused = ax_call(
            conn,
            session,
            bnid,
            "function(){ this.focus(); return document.activeElement === this ? 'yes' : 'no'; }",
            vec![],
        )
        .await
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
        if focused != "yes" {
            self.ax_click_element(conn, session, element_index, bnid, "left", 1)
                .await
                .ok();
        }
        let deadline = Instant::now() + Duration::from_millis(INPUT_PREPARE_MS);
        loop {
            let ready = Self::eval_string(
                conn,
                session,
                "document.activeElement && (document.activeElement.isContentEditable \
                 || ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) \
                 ? 'ready' : ''",
            )
            .await
            .ok()
            .flatten();
            if ready.as_deref() == Some("ready") {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::InputPrepareTimeout { element_index });
            }
            tokio::time::sleep(Duration::from_millis(INPUT_PREPARE_POLL_MS)).await;
        }
    }
}

fn action_result(rec: &TabRecord, p: &AxActionPayload) -> Value {
    json!({ "tab_id": rec.tab_id, "action": p.action.kind_name() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_aliases_map_to_cdp_names() {
        assert_eq!(button_name(None), "left");
        assert_eq!(button_name(Some(AxMouseButton::L)), "left");
        assert_eq!(button_name(Some(AxMouseButton::Right)), "right");
        assert_eq!(button_name(Some(AxMouseButton::M)), "middle");
    }

    #[test]
    fn secondary_action_grammar_is_bounded() {
        let advertised = ["Expand".to_string()];
        assert!(secondary_action_allowed("Expand", &advertised));
        assert!(!secondary_action_allowed("Collapse", &advertised)); // not advertised
        assert!(!secondary_action_allowed("Delete", &advertised)); // never dispatchable
    }

    #[test]
    fn duration_bounds_are_rechecked() {
        assert_eq!(duration_delay_ms(None).unwrap(), 0);
        assert_eq!(duration_delay_ms(Some(2.5)).unwrap(), 2500);
        assert!(duration_delay_ms(Some(31.0)).is_err());
        assert!(duration_delay_ms(Some(-1.0)).is_err());
        assert!(duration_delay_ms(Some(f64::NAN)).is_err());
    }

    #[test]
    fn selection_type_defaults_to_text() {
        assert_eq!(sel_type_name(None), "text");
        assert_eq!(
            sel_type_name(Some(AxSelectionType::CursorAfter)),
            "cursor_after"
        );
    }
}
