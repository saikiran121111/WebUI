//! cua.rs — Phase 15: the CUA pixel-input surface (`cua_*`).
//!
//! The reference product's `CUAAPI` drove raw pointer input at
//! OS-desktop coordinates. Ruke's coordinates are SCREENCAST-viewport
//! css pixels in the same shared visible session the human is looking
//! at ([adapted] — already pinned in the `CuaClickPayload` schema doc:
//! model and human address the same tab state through the same
//! pixels). This module owns the pointer path (trusted
//! `Input.dispatchMouseEvent` sequences); `cua_keypress` and `cua_type`
//! deliberately REUSE the DOM-CUA key/text primitives in `dom_cua.rs`
//! — the payloads are the same schemas (`KeysPayload`/`TextPayload`),
//! so one real behavior serves both reference names instead of two
//! near-duplicate stacks.

use serde_json::{json, Value};

use crate::cdp::CdpConn;
use crate::errors::{payload_invalid, BrowserError};
use crate::pw::{combo_mask, pw_dispatch_click};
use crate::schemas::{CuaClickPayload, CuaDragPayload, CuaMovePayload, CuaScrollPayload, Xy};
use crate::session::TabRecord;

/// Pause between drag steps (ms): enough for dragover handlers to run
/// without turning a drag into a slow-motion tour.
const DRAG_STEP_MS: u64 = 12;

/// The number of points the recovered reference `dragPath` uses for a
/// two-endpoint drag (the engine interpolates, so the model never has
/// to hand-draw the curve).
const DRAG_INTERPOLATED_POINTS: usize = 8;

/// Viewport coordinates must be finite non-negative css pixels — the
/// same floor the panel applies when it maps human pointer events.
fn validate_point(command: &str, x: f64, y: f64) -> Result<(), BrowserError> {
    if !x.is_finite() || !y.is_finite() {
        return Err(payload_invalid(command, "x/y must be finite coordinates"));
    }
    if x < 0.0 || y < 0.0 {
        return Err(payload_invalid(
            command,
            "x/y must be non-negative viewport pixels",
        ));
    }
    Ok(())
}

/// Mouse-button number → CDP button name. The reference ClickOptions
/// grammar is `button?:1..=5` (left/middle/right/back/forward); absent
/// ⇒ left. A `0` (the CDP `buttons` bitmask habit) is a typed refusal,
/// never a silently-accepted alias.
pub(crate) fn cua_button_str(
    command: &str,
    button: Option<u8>,
) -> Result<&'static str, BrowserError> {
    match button {
        None | Some(1) => Ok("left"),
        Some(2) => Ok("middle"),
        Some(3) => Ok("right"),
        Some(4) => Ok("back"),
        Some(5) => Ok("forward"),
        Some(other) => Err(payload_invalid(
            command,
            format!(
                "button {other} is outside the reference grammar \
                 (1=left, 2=middle, 3=right, 4=back, 5=forward)"
            ),
        )),
    }
}

/// The `keys` held-modifier array → the CDP modifier bitmask. Each
/// entry must be a modifier NAME (xdotool aliases like `ctrl`/`super`
/// or the raw CDP names): this is *held state* for the pointer action,
/// not a combo to press, so `+` chains and non-modifier tokens are
/// typed refusals — silently ignoring a token would fake a modifier
/// state the page never actually sees.
pub(crate) fn held_modifier_mask(
    command: &str,
    keys: Option<&[String]>,
) -> Result<u32, BrowserError> {
    let mut names: Vec<&str> = Vec::new();
    for token in keys.unwrap_or(&[]) {
        let name = match token.to_ascii_lowercase().as_str() {
            "alt" | "option" => "Alt",
            "ctrl" | "control" | "controlormeta" => "Control",
            "shift" => "Shift",
            "meta" | "super" | "cmd" | "command" | "win" => "Meta",
            _ => {
                return Err(payload_invalid(
                    command,
                    format!(
                        "\"{token}\" is not a held-modifier name (cua `keys` \
                         carries held modifier state, not key presses)"
                    ),
                ))
            }
        };
        names.push(name);
    }
    // combo_mask only errors on unknown names, which the match above
    // already rejects — re-tag the command label for honest errors.
    combo_mask(&names).map_err(|e| match e {
        BrowserError::PayloadInvalid { reason, .. } => payload_invalid(command, reason),
        other => other,
    })
}

/// Endpoint-only paths get the recovered reference's natural drag: 8
/// interpolated points. Explicit multi-point paths drive verbatim.
pub(crate) fn drag_path(points: &[Xy]) -> Vec<Xy> {
    if points.len() != 2 {
        return points.to_vec();
    }
    let (a, b) = (points[0], points[1]);
    (0..DRAG_INTERPOLATED_POINTS)
        .map(|i| {
            let t = i as f64 / (DRAG_INTERPOLATED_POINTS - 1) as f64;
            Xy {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            }
        })
        .collect()
}

/// Trusted pointer move (`mouseMoved`) on the tab's CDP session.
async fn pixel_move(
    conn: &CdpConn,
    rec: &TabRecord,
    x: f64,
    y: f64,
    modifiers: u32,
) -> Result<(), BrowserError> {
    conn.call(
        "Input.dispatchMouseEvent",
        Some(json!({"type": "mouseMoved", "x": x, "y": y, "modifiers": modifiers})),
        Some(&rec.cdp_session_id),
    )
    .await?;
    Ok(())
}

pub(crate) async fn cua_click(
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
    let button = cua_button_str(command, p.button)?;
    let modifiers = held_modifier_mask(command, p.keys.as_deref())?;
    // Hover before pressing: real pointers pass through hover first,
    // and skipping it leaves hover-only surfaces (menus, video
    // overlays) unreachable — the reference CUA moved, then clicked.
    pixel_move(conn, rec, p.x, p.y, modifiers).await?;
    pw_dispatch_click(
        conn,
        &rec.cdp_session_id,
        p.x,
        p.y,
        button,
        if double { 2 } else { 1 },
        modifiers,
    )
    .await?;
    Ok(json!({
        "tab_id": rec.tab_id,
        "x": p.x,
        "y": p.y,
        "button": button,
        "click_count": if double { 2 } else { 1 },
    }))
}

pub(crate) async fn cua_move(
    conn: &CdpConn,
    rec: &TabRecord,
    p: &CuaMovePayload,
) -> Result<Value, BrowserError> {
    validate_point("cua_move", p.x, p.y)?;
    let modifiers = held_modifier_mask("cua_move", p.keys.as_deref())?;
    pixel_move(conn, rec, p.x, p.y, modifiers).await?;
    Ok(json!({"tab_id": rec.tab_id, "x": p.x, "y": p.y}))
}

pub(crate) async fn cua_scroll(
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
    let modifiers = held_modifier_mask("cua_scroll", p.keys.as_deref())?;
    // Wheels only service the composited (foreground) tab — raise it
    // (engine::raise_wheel_target) before any input lands.
    crate::engine::raise_wheel_target(conn, &rec.cdp_session_id).await;
    // A wheel always happens over a point: move first, then wheel
    // (deltaX/deltaY are the CDP wheel deltas; negative scrolls
    // up/left, matching the reference CUA scroll signs).
    pixel_move(conn, rec, p.x, p.y, modifiers).await?;
    conn.call(
        "Input.dispatchMouseEvent",
        Some(json!({
            "type": "mouseWheel",
            "x": p.x,
            "y": p.y,
            "deltaX": p.scroll_x,
            "deltaY": p.scroll_y,
            "modifiers": modifiers,
        })),
        Some(&rec.cdp_session_id),
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

pub(crate) async fn cua_drag(
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
    let modifiers = held_modifier_mask("cua_drag", p.keys.as_deref())?;
    let path = drag_path(&p.path);
    let session = rec.cdp_session_id.as_str();
    let start = path[0];
    let end = path[path.len() - 1];
    pixel_move(conn, rec, start.x, start.y, modifiers).await?;
    conn.call(
        "Input.dispatchMouseEvent",
        Some(json!({
            "type": "mousePressed",
            "x": start.x,
            "y": start.y,
            "button": "left",
            "clickCount": 1,
            "modifiers": modifiers,
        })),
        Some(session),
    )
    .await?;
    for pt in &path[1..] {
        pixel_move(conn, rec, pt.x, pt.y, modifiers).await?;
        tokio::time::sleep(std::time::Duration::from_millis(DRAG_STEP_MS)).await;
    }
    conn.call(
        "Input.dispatchMouseEvent",
        Some(json!({
            "type": "mouseReleased",
            "x": end.x,
            "y": end.y,
            "button": "left",
            "clickCount": 1,
            "modifiers": modifiers,
        })),
        Some(session),
    )
    .await?;
    Ok(json!({
        "tab_id": rec.tab_id,
        "from": {"x": start.x, "y": start.y},
        "to": {"x": end.x, "y": end.y},
        "points": path.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::BrowserError;

    fn xy(x: f64, y: f64) -> Xy {
        Xy { x, y }
    }

    fn payload_invalid_for(cmd: &str, r: Result<(), BrowserError>) {
        match r {
            Err(BrowserError::PayloadInvalid { command, .. }) => assert_eq!(command, cmd),
            other => panic!("expected PayloadInvalid, got {other:?}"),
        }
    }

    #[test]
    fn button_grammar_is_the_reference_numbering() {
        assert_eq!(cua_button_str("cua_click", None).unwrap(), "left");
        for (n, name) in [
            (1u8, "left"),
            (2, "middle"),
            (3, "right"),
            (4, "back"),
            (5, "forward"),
        ] {
            assert_eq!(cua_button_str("cua_click", Some(n)).unwrap(), name);
        }
        // 0 is the CDP bitmask habit, not the reference grammar.
        payload_invalid_for(
            "cua_click",
            cua_button_str("cua_click", Some(0)).map(|_| ()),
        );
        payload_invalid_for(
            "cua_double_click",
            cua_button_str("cua_double_click", Some(6)).map(|_| ()),
        );
    }

    #[test]
    fn held_modifiers_normalize_and_reject_non_modifiers() {
        let k = |names: &[&str]| -> Vec<String> { names.iter().map(|s| s.to_string()).collect() };
        assert_eq!(held_modifier_mask("cua_click", None).unwrap(), 0);
        assert_eq!(
            held_modifier_mask("cua_click", Some(&k(&["ctrl", "Shift"]))).unwrap(),
            2 | 8
        );
        assert_eq!(
            held_modifier_mask("cua_move", Some(&k(&["super"]))).unwrap(),
            4
        );
        assert_eq!(
            held_modifier_mask("cua_move", Some(&k(&["option"]))).unwrap(),
            1
        );
        // Held state is NOT combo grammar: these are typed refusals.
        payload_invalid_for(
            "cua_scroll",
            held_modifier_mask("cua_scroll", Some(&k(&["Control+a"]))).map(|_| ()),
        );
        payload_invalid_for(
            "cua_click",
            held_modifier_mask("cua_click", Some(&k(&["a"]))).map(|_| ()),
        );
    }

    #[test]
    fn two_endpoint_drag_interpolates_to_the_reference_path() {
        let path = drag_path(&[xy(0.0, 0.0), xy(10.0, 20.0)]);
        assert_eq!(path.len(), DRAG_INTERPOLATED_POINTS);
        assert_eq!(path[0], xy(0.0, 0.0));
        assert_eq!(path[path.len() - 1], xy(10.0, 20.0));
        // Monotone toward the endpoint.
        for w in path.windows(2) {
            assert!(w[1].x >= w[0].x && w[1].y >= w[0].y);
        }
        // Explicit paths drive verbatim (the model can hand-draw).
        let three = [xy(1.0, 1.0), xy(5.0, 9.0), xy(9.0, 2.0)];
        assert_eq!(drag_path(&three), three.to_vec());
    }

    #[test]
    fn coordinates_are_finite_non_negative_pixels() {
        assert!(validate_point("cua_click", 0.0, 0.0).is_ok());
        payload_invalid_for("cua_move", validate_point("cua_move", f64::NAN, 4.0));
        payload_invalid_for("cua_scroll", validate_point("cua_scroll", 1.0, -1.0));
        payload_invalid_for("cua_drag", validate_point("cua_drag", f64::INFINITY, 0.0));
    }
}
