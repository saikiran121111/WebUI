//! auth_handoff.rs — Phase 9 browser-auth handoff
//! (`svc-browser-auth` capture SVC-D4, reverse-engineering docs). The
//! model *describes* a sign-in (fields, options, submit action) and the
//! human supplies the credentials in the Browser Panel. Credential
//! values travel UI → engine → CDP fill only; they are never logged,
//! never surfaced to the model, and never echoed back in results.
//!
//! Recovered contracts honored here:
//! - the SVC-D4 zod `requestSchema` boundaries with their verbatim
//!   refine messages (id grammar, ≤6 fields, 2..=10 options, selector
//!   XOR field_ids, `qr_code` literal true, password-only
//!   `account_identifier`, the "requires …" floor, otpHandle 1..=16384,
//!   origin http(s));
//! - the result enum `submitted | declined | cancelled | unavailable |
//!   expired | origin_changed | page_changed | locator_invalid |
//!   submission_failed` with the optional `locator_error{field_id,
//!   reason:"not_user_visible"}` and `selected_option` (the reference's
//!   optional KB diagnostics block is [adapted] away — Ruke logs
//!   nothing about the credentials themselves);
//! - the origin floor: the request's `origin` must equal the tab's live
//!   origin, else the handoff is refused (a stale description of a
//!   navigated page must never drive fills).
//!
//! The panel wait is [`AUTH_HANDOFF_TIMEOUT`] ([adapted]: the reference
//! leaves the browserAuth request promise open indefinitely; Ruke caps
//! every panel-decision wait so a command can never hang a turn
//! forever — matching the locked approval timeout pattern at 120s, the
//! sign-in form gets a longer 300s budget).

use std::time::Duration;

use serde_json::{json, Value};
use url::Url;

use crate::authority::{origin_of, Parked};
use crate::cdp::CdpConn;
use crate::engine::BrowserRuntime;
use crate::errors::BrowserError;
use crate::schemas::{is_browser_auth_id, BrowserAuthHandoffPayload, BrowserAuthSubmitAction};
use crate::session::{TabRecord, TurnKey};

/// How long the handoff card may sit unanswered in the Browser Panel
/// before the command resolves `expired` ([adapted], see module header).
pub const AUTH_HANDOFF_TIMEOUT: Duration = Duration::from_secs(300);

const COMMAND: &str = "tab_browser_auth_handoff";

fn invalid(reason: impl Into<String>) -> BrowserError {
    BrowserError::PayloadInvalid {
        command: COMMAND.into(),
        reason: reason.into(),
    }
}

/// HTTP(S)-only parse of a URL string used for origin math.
fn http_url(s: &str) -> Option<Url> {
    Url::parse(s)
        .ok()
        .filter(|u| u.scheme() == "http" || u.scheme() == "https")
}

/// SVC-D4 zod `requestSchema` validation (shape is serde's job; these
/// are the refine/refinement boundaries with the recovered messages,
/// kept verbatim because the model's recovery reads them).
pub(crate) fn validate_browser_auth(p: &BrowserAuthHandoffPayload) -> Result<(), BrowserError> {
    if http_url(&p.origin).is_none() {
        return Err(invalid("origin must be an absolute http(s) origin"));
    }
    if p.fields.len() > 6 {
        return Err(invalid("browser auth requests carry at most 6 fields"));
    }
    for f in &p.fields {
        if !is_browser_auth_id(&f.id) {
            return Err(invalid(format!(
                "field id {:?} must match ^[A-Za-z0-9_-]{{1,48}}$ and never a JS reserved key",
                f.id
            )));
        }
        if f.label.trim().is_empty() {
            return Err(invalid("field labels must be non-empty"));
        }
        if f.field_type.trim().is_empty() {
            return Err(invalid("field types must be non-empty"));
        }
        if f.selector.trim().is_empty() {
            return Err(invalid("field selectors must be non-empty"));
        }
    }

    let options = p.options.as_deref().unwrap_or(&[]);
    if p.options.is_some() {
        if !(2..=10).contains(&options.len()) {
            return Err(invalid("browser auth options must number between 2 and 10"));
        }
        for o in options {
            if !is_browser_auth_id(&o.id) {
                return Err(invalid(format!(
                    "option id {:?} must match ^[A-Za-z0-9_-]{{1,48}}$ and never a JS reserved key",
                    o.id
                )));
            }
            let label = o.label.trim();
            if label.is_empty() || label.chars().count() > 120 {
                return Err(invalid("option labels must be 1..=120 characters"));
            }
            let has_selector = o.selector.as_deref().is_some_and(|s| !s.trim().is_empty());
            let has_fields = o.field_ids.as_ref().is_some_and(|f| !f.is_empty());
            if has_selector == has_fields {
                return Err(invalid(
                    "browser auth options require either a selector or credential fields",
                ));
            }
            if let Some(ids) = &o.field_ids {
                if ids.len() > 6 {
                    return Err(invalid("browser auth options carry at most 6 field ids"));
                }
            }
        }
    }

    if p.qr_code == Some(false) {
        return Err(invalid("qr_code must be the literal true"));
    }

    if let Some(acc) = &p.account_identifier {
        let acc = acc.trim();
        if acc.is_empty() || acc.chars().count() > 320 {
            return Err(invalid("account_identifier must be 1..=320 characters"));
        }
        // zod refine: the identifier pre-fill only makes sense for the
        // single-password SSO shape (message verbatim).
        let password_only = p.fields.len() == 1
            && p.fields[0].field_type == "password"
            && p.options.is_none()
            && p.qr_code.is_none()
            && p.otp_handle.is_none();
        if !password_only {
            return Err(invalid(
                "account_identifier is only supported for a password-only sign-in",
            ));
        }
    }

    if let Some(otp) = &p.otp_handle {
        if otp.is_empty() || otp.chars().count() > 16384 {
            return Err(invalid("otpHandle must be 1..=16384 characters"));
        }
    }

    if p.fields.is_empty() && options.is_empty() && p.qr_code != Some(true) {
        return Err(invalid(
            "browser auth requests require credential fields, sign-in options, or a QR code",
        ));
    }
    Ok(())
}

// ── page-side primitives ──────────────────────────────────────────────
//
// Selector and value are injected as JSON string literals (a JSON
// string is a valid JS string literal in modern Chromium), so page
// content can never escape into code position.

fn js_lit(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "''".into())
}

fn click_js(selector: &str) -> String {
    format!(
        "(() => {{ const el = document.querySelector({}); if (!el) return 'missing'; el.click(); return 'ok'; }})()",
        js_lit(selector)
    )
}

fn focus_js(selector: &str) -> String {
    format!(
        "(() => {{ const el = document.querySelector({}); if (!el) return 'missing'; el.focus(); return 'ok'; }})()",
        js_lit(selector)
    )
}

/// Framework-safe fill: native value setter + input/change events so
/// React/Vue see the edit; contenteditable gets execCommand insertText.
/// Never logs the value (it is a credential).
fn fill_js(selector: &str, value: &str) -> String {
    let (sel, val) = (js_lit(selector), js_lit(value));
    format!(
        "(() => {{ const el = document.querySelector({sel}); if (!el) return 'missing'; \
         if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox','radio','file','submit','button'].includes(el.type))) {{ \
           const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; \
           Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, {val}); \
           el.dispatchEvent(new Event('input', {{bubbles:true}})); \
           el.dispatchEvent(new Event('change', {{bubbles:true}})); \
           return 'ok'; \
         }} \
         if (el.isContentEditable) {{ el.focus(); return document.execCommand('insertText', false, {val}) ? 'ok' : 'missing'; }} \
         return 'not-editable'; \
         }})()"
    )
}

impl BrowserRuntime {
    /// `tab_browser_auth_handoff`: validate the model's sign-in
    /// description, pin it to the tab's live origin, park a credential
    /// form in the Browser Panel, then apply the human's answer to the
    /// page over CDP. Statuses follow the SVC-D4 result enum. The wait
    /// is parked against its turn (Phase 11): when the turn ends the
    /// card is pruned and the handoff resolves "cancelled".
    pub(crate) async fn tab_browser_auth_handoff(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &BrowserAuthHandoffPayload,
        key: &TurnKey,
    ) -> Result<Value, BrowserError> {
        validate_browser_auth(p)?;

        let req_origin = origin_of(&Url::parse(&p.origin).expect("validated above"));
        let tab_origin = http_url(&rec.url).map(|u| origin_of(&u));
        if tab_origin.as_deref() != Some(req_origin.as_str()) {
            return Err(invalid(
                "the request origin does not match the tab's current origin",
            ));
        }

        if !self.ui.has_clients() {
            return Err(BrowserError::CapabilityBlocked {
                reason: "a browser-auth handoff needs your approval, but no Browser Panel is connected to grant it (open the panel and try again)".into(),
            });
        }

        let (id, rx) = self.approvals.register(&rec.tab_id, key);
        // The card frame carries the sign-in DESCRIPTION only — never
        // any credential value (there are none in the payload; the
        // panel supplies them locally).
        self.ui.event(json!({
            "type": "auth_handoff_request",
            "id": id,
            "tab_id": rec.tab_id,
            "origin": p.origin,
            "url": rec.url,
            "account_identifier": p.account_identifier,
            "fields": p.fields,
            "options": p.options,
            "qr_code": p.qr_code.unwrap_or(false),
            "submit": p.submit,
            "has_otp": p.otp_handle.is_some(),
        }));

        match self.park_approval(key, &id, rx, AUTH_HANDOFF_TIMEOUT).await {
            Parked::Expired => Ok(json!({ "status": "expired" })),
            // Turn ended or tab/panel vanished: the SVC-D4 status enum
            // already has "cancelled" for both; the panel card was
            // pruned with an approval_stale frame for the stale case.
            Parked::Cancelled | Parked::SenderClosed => Ok(json!({ "status": "cancelled" })),
            Parked::Answer(answer) => match answer.get("action").and_then(Value::as_str) {
                Some("decline") => Ok(json!({ "status": "declined" })),
                Some("cancel") => Ok(json!({ "status": "cancelled" })),
                Some("proceed") => {
                    self.complete_browser_auth(conn, rec, p, &answer, &req_origin)
                        .await
                }
                other => Err(invalid(format!(
                    "browser-auth answer carries an unknown action {:?}: expected proceed | decline | cancel",
                    other.unwrap_or_default()
                ))),
            },
        }
    }

    /// Apply a "proceed" answer: chosen sign-in option → field fills →
    /// submit gesture, then the origin re-check. Every DOM/CDP failure
    /// maps onto the SVC-D4 status enum rather than an exception, so
    /// the model can react. Credential values stay inside the JS they
    /// are interpolated into — never logged, never in results.
    async fn complete_browser_auth(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &BrowserAuthHandoffPayload,
        answer: &Value,
        req_origin: &str,
    ) -> Result<Value, BrowserError> {
        let session = &rec.cdp_session_id;

        let locator_invalid = |field_id: &str| {
            Ok(json!({
                "status": "locator_invalid",
                "locator_error": { "field_id": field_id, "reason": "not_user_visible" },
            }))
        };
        let submission_failed = |stage: &str| {
            tracing::warn!(
                tab_id = %rec.tab_id,
                stage,
                "browser_use_auth_handoff_submission_failed"
            );
            json!({ "status": "submission_failed" })
        };

        // 1. Sign-in option the human picked (selector route = a page
        //    control; field_ids route only re-scopes which fields the
        //    panel filled — nothing engine-side to do).
        let mut selected_option: Option<String> = None;
        if let Some(chosen) = answer.get("selected_option").and_then(Value::as_str) {
            let Some(opt) = p
                .options
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .find(|o| o.id == chosen)
            else {
                return Err(invalid(format!(
                    "selected_option {chosen:?} names no defined browser-auth option"
                )));
            };
            selected_option = Some(opt.id.clone());
            if let Some(sel) = opt.selector.as_deref() {
                match Self::eval_string(conn, session, &click_js(sel)).await {
                    Ok(Some(r)) if r == "ok" => {}
                    Ok(_) => return locator_invalid(&opt.id),
                    Err(_) => return Ok(submission_failed("option-click")),
                }
            }
        }

        // 2. Fill the values the human supplied, keyed by field id.
        if let Some(values) = answer.get("values").and_then(Value::as_object) {
            for (field_id, value) in values {
                let Some(field) = p.fields.iter().find(|f| &f.id == field_id) else {
                    return locator_invalid(field_id);
                };
                let Some(text) = value.as_str() else {
                    return Err(invalid(format!(
                        "the answer value for field {field_id:?} must be a string"
                    )));
                };
                match Self::eval_string(conn, session, &fill_js(&field.selector, text)).await {
                    Ok(Some(r)) if r == "ok" => {}
                    Ok(Some(r)) if r == "not-editable" => {
                        return Ok(submission_failed("field-not-editable"))
                    }
                    Ok(_) => return locator_invalid(&field.id),
                    Err(_) => return Ok(submission_failed("field-fill")),
                }
            }
        }

        // 3. The submit gesture the model described.
        if let Some(submit) = &p.submit {
            match submit.action {
                BrowserAuthSubmitAction::Click => {
                    match Self::eval_string(conn, session, &click_js(&submit.selector)).await {
                        Ok(Some(r)) if r == "ok" => {}
                        Ok(_) => return locator_invalid("submit"),
                        Err(_) => return Ok(submission_failed("submit-click")),
                    }
                }
                BrowserAuthSubmitAction::PressEnter => {
                    match Self::eval_string(conn, session, &focus_js(&submit.selector)).await {
                        Ok(Some(r)) if r == "ok" => {}
                        Ok(_) => return locator_invalid("submit"),
                        Err(_) => return Ok(submission_failed("submit-focus")),
                    }
                    let enter = crate::pw::pw_key_spec("Enter").expect("Enter is a valid key");
                    if crate::pw::pw_send_key(conn, session, &enter, 0, 0)
                        .await
                        .is_err()
                    {
                        return Ok(submission_failed("submit-enter"));
                    }
                }
            }
        }

        // 4. Post-op origin re-check (SVC-D4: a sign-in that bounced to
        //    a different origin or left the page unreadable is a
        //    distinct status, not a silent success).
        let href = match Self::eval_string(conn, session, "location.href").await {
            Ok(Some(href)) => href,
            Ok(_) => return Ok(json!({ "status": "page_changed" })),
            Err(_) => return Ok(submission_failed("origin-recheck")),
        };
        let Some(now) = http_url(&href).map(|u| origin_of(&u)) else {
            return Ok(json!({ "status": "page_changed" }));
        };
        if now != req_origin {
            return Ok(json!({ "status": "origin_changed" }));
        }
        let mut out = json!({ "status": "submitted" });
        if let Some(opt) = selected_option {
            out["selected_option"] = json!(opt);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schemas::BrowserAuthSubmitAction::*;
    use crate::schemas::{BrowserAuthField, BrowserAuthOption, BrowserAuthSubmit};

    fn field(id: &str, ftype: &str) -> BrowserAuthField {
        BrowserAuthField {
            id: id.into(),
            label: "Label".into(),
            field_type: ftype.into(),
            autocomplete: None,
            required: true,
            selector: "#s".into(),
        }
    }

    fn payload(fields: Vec<BrowserAuthField>) -> BrowserAuthHandoffPayload {
        BrowserAuthHandoffPayload {
            browser_id: "default".into(),
            tab_id: "1".into(),
            origin: "https://shop.example.com".into(),
            account_identifier: None,
            fields,
            options: None,
            qr_code: None,
            submit: None,
            otp_handle: None,
        }
    }

    /// Assert a rejection whose reason matches verbatim.
    fn reason(err: BrowserError) -> String {
        match err {
            BrowserError::PayloadInvalid { reason, .. } => reason,
            other => panic!("expected PayloadInvalid, got {other:?}"),
        }
    }

    #[test]
    fn minimal_password_request_validates() {
        assert!(validate_browser_auth(&payload(vec![field("pw", "password")])).is_ok());
    }

    #[test]
    fn origin_must_be_absolute_https() {
        let mut p = payload(vec![field("u", "text")]);
        for bad in ["shop.example.com", "ftp://x.test", "javascript:alert(1)"] {
            p.origin = bad.into();
            assert_eq!(
                reason(validate_browser_auth(&p).unwrap_err()),
                "origin must be an absolute http(s) origin",
                "{bad}"
            );
        }
        p.origin = "http://shop.example.com".into();
        assert!(validate_browser_auth(&p).is_ok(), "plain http is allowed");
    }

    #[test]
    fn field_count_and_id_grammar_boundaries() {
        let many = payload((1..=7).map(|i| field(&format!("f{i}"), "text")).collect());
        assert!(validate_browser_auth(&many).is_err());
        let six = payload((1..=6).map(|i| field(&format!("f{i}"), "text")).collect());
        assert!(validate_browser_auth(&six).is_ok());

        for bad in [
            "",
            "a.b",
            "x".repeat(49).as_str(),
            "__proto__",
            "constructor",
        ] {
            let p = payload(vec![field(bad, "text")]);
            assert!(validate_browser_auth(&p).is_err(), "id {bad:?}");
        }
    }

    #[test]
    fn option_selector_xor_field_ids_refine_is_verbatim() {
        let mk = |id: &str, selector: Option<&str>, ids: Option<Vec<String>>| BrowserAuthOption {
            id: id.into(),
            label: "Log in".into(),
            selector: selector.map(str::to_string),
            field_ids: ids,
        };
        // neither
        let mut p = payload(vec![field("u", "text")]);
        p.options = Some(vec![mk("a", None, None), mk("b", None, None)]);
        assert_eq!(
            reason(validate_browser_auth(&p).unwrap_err()),
            "browser auth options require either a selector or credential fields"
        );
        // both
        p.options = Some(vec![
            mk("a", Some("#x"), Some(vec!["u".into()])),
            mk("b", Some("#y"), None),
        ]);
        assert_eq!(
            reason(validate_browser_auth(&p).unwrap_err()),
            "browser auth options require either a selector or credential fields"
        );
        // counts: 1 and 11 are out, 2 and 10 are in
        p.options = Some(vec![mk("a", Some("#x"), None)]);
        assert!(validate_browser_auth(&p).is_err(), "single option");
        p.options = Some(
            (1..=11)
                .map(|i| mk(&format!("o{i}"), Some("#x"), None))
                .collect(),
        );
        assert!(validate_browser_auth(&p).is_err(), "eleven options");
        p.options = Some(
            (1..=10)
                .map(|i| mk(&format!("o{i}"), Some("#x"), None))
                .collect(),
        );
        assert!(validate_browser_auth(&p).is_ok());
    }

    #[test]
    fn qr_code_is_the_literal_true() {
        let mut p = payload(vec![]);
        assert_eq!(
            reason(validate_browser_auth(&p).unwrap_err()),
            "browser auth requests require credential fields, sign-in options, or a QR code"
        );
        p.qr_code = Some(true);
        assert!(
            validate_browser_auth(&p).is_ok(),
            "QR-only is a complete request"
        );
        p.qr_code = Some(false);
        assert_eq!(
            reason(validate_browser_auth(&p).unwrap_err()),
            "qr_code must be the literal true"
        );
    }

    #[test]
    fn account_identifier_requires_password_only_shape() {
        let mut p = payload(vec![field("pw", "password")]);
        p.account_identifier = Some("user@example.com".into());
        assert!(validate_browser_auth(&p).is_ok());

        // two fields ⇒ not password-only
        let mut two = payload(vec![field("u", "text"), field("pw", "password")]);
        two.account_identifier = Some("user@example.com".into());
        assert_eq!(
            reason(validate_browser_auth(&two).unwrap_err()),
            "account_identifier is only supported for a password-only sign-in"
        );
        // non-password single field
        let mut nonpw = payload(vec![field("u", "text")]);
        nonpw.account_identifier = Some("user".into());
        assert!(validate_browser_auth(&nonpw).is_err());
        // with otp present it is no longer password-only
        let mut otp = payload(vec![field("pw", "password")]);
        otp.account_identifier = Some("user".into());
        otp.otp_handle = Some("handle".into());
        assert!(validate_browser_auth(&otp).is_err());
        // blank / oversized
        let mut blank = payload(vec![field("pw", "password")]);
        blank.account_identifier = Some("   ".into());
        assert!(validate_browser_auth(&blank).is_err());
        let mut big = payload(vec![field("pw", "password")]);
        big.account_identifier = Some("x".repeat(321));
        assert!(validate_browser_auth(&big).is_err());
    }

    #[test]
    fn otp_handle_length_and_submit_shape() {
        let mut p = payload(vec![field("u", "text"), field("pw", "password")]);
        p.otp_handle = Some("h".repeat(16385));
        assert!(validate_browser_auth(&p).is_err());
        p.otp_handle = Some("h".into());
        p.submit = Some(BrowserAuthSubmit {
            selector: "button[type=submit]".into(),
            action: PressEnter,
        });
        assert!(validate_browser_auth(&p).is_ok());
    }

    #[test]
    fn js_literals_escape_injection_attempts() {
        // Selectors/values become JSON string literals (a JSON string
        // is a valid JS string literal), so serde's escaping is the
        // injection floor: no raw `"` may survive unescaped inside the
        // literal, or page-supplied text could reach code position.
        let evil = "', document.write(\"pwned\"), '";
        let lit = js_lit(evil);
        assert!(lit.starts_with('"') && lit.ends_with('"'));
        let inner = &lit[1..lit.len() - 1];
        assert!(
            !inner.replace("\\\\", "").replace("\\\"", "").contains('"'),
            "unescaped quote inside the literal: {lit}"
        );
        let expr = fill_js(evil, evil);
        assert!(
            expr.contains(&lit),
            "both selector and value routed through the escaped literal"
        );
    }

    #[test]
    fn origin_of_helpers_agree_with_authority() {
        // The handoff's origin floor uses the same registrable-origin
        // math as the policy layer.
        let a = http_url("https://shop.example.com/login?x=1").unwrap();
        let b = http_url("https://shop.example.com/other").unwrap();
        assert_eq!(origin_of(&a), origin_of(&b));
        assert_ne!(
            origin_of(&a),
            origin_of(&http_url("https://other.example.com/").unwrap())
        );
        assert_ne!(
            origin_of(&a),
            origin_of(&http_url("http://shop.example.com/").unwrap())
        );
    }
}
