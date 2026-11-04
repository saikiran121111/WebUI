//! The frozen error contract of `app/api/chat/route.ts` (§2 of the
//! migration map), identical strings in BOTH response shapes:
//!
//! - legacy path  → real HTTP status + `{"error": "…"}` JSON body
//!   (`upstreamErrorResponse`, route.ts:91).
//! - progress path → the SAME message carried in a `ruke_error` frame,
//!   followed by exactly one `data: [DONE]` (the channel emits both).
//!
//! Corpus: `fixtures/errors/01…08` pin every combination
//! (upstream 400/500, no-body, unreachable × legacy/progress).

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use serde_json::json;

/// The pinned upstream header trio (`upstreamHeaders`, route.ts:47):
/// `Content-Type: application/json`, `Authorization: Bearer <key>`,
/// `Accept: text/event-stream`. `None` models the JS case where a
/// non-ASCII key makes `fetch` throw — the throw lands in the SAME catch
/// as a failed connection, so callers treat it as the unreachable branch.
pub fn upstream_headers(api_key: &str) -> Option<HeaderMap> {
    let mut h = HeaderMap::new();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {api_key}")).ok()?,
    );
    h.insert(
        header::ACCEPT,
        HeaderValue::from_static("text/event-stream"),
    );
    Some(h)
}

/// `try { new URL(llmApiUrl()).host } catch { "the configured port" }`.
/// JS `URL.host` = hostname, plus the explicit port whenever it differs
/// from the scheme default (`url::Url::port()` has the same rule).
pub fn unreachable_message(url: &str) -> String {
    let host = match url::Url::parse(url) {
        Ok(u) => match u.host_str() {
            Some(h) if !h.is_empty() => match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            },
            _ => return configured_port_message(),
        },
        Err(_) => return configured_port_message(),
    };
    format!("Could not reach the model server at {host}.")
}

fn configured_port_message() -> String {
    "Could not reach the model server at the configured port.".to_string()
}

/// `"Upstream returned " + status + (errText ? ": " + errText.slice(0, 200) : "")`.
/// JS `String.prototype.slice` counts UTF-16 code units, so the truncation
/// does too (fixtures are ASCII; the units-vs-chars difference only shows
/// for astral characters in an upstream error body).
pub fn upstream_error_message(status: u16, err_text: &str) -> String {
    let mut out = format!("Upstream returned {status}");
    if !err_text.is_empty() {
        out.push_str(": ");
        let mut units = 0usize;
        for ch in err_text.chars() {
            let w = ch.len_utf16();
            if units + w > 200 {
                break;
            }
            out.push(ch);
            units += w;
        }
    }
    out
}

/// `NextResponse.json({ error: message }, { status })` — compact JSON,
/// `content-type: application/json` (no charset), status mirrored.
pub fn json_error(status: StatusCode, message: &str) -> Response {
    let body = serde_json::to_vec(&json!({ "error": message }))
        .unwrap_or_else(|_| br#"{"error":"Internal Server Error"}"#.to_vec());
    // Built by hand, NOT via the (status, headers, body) tuple: the oracle's
    // NextResponse.json carries only `content-type` in its application-level
    // header set (the fixtures pin that exactly). Two frameworks try to help:
    // axum 0.8's top-level RouteFuture inserts a `content-length` taken from
    // the body's EXACT size hint (routing/route.rs `set_content_length`), and
    // hyper likewise derives one when the body reports a known length. So the
    // body is presented as a one-frame stream: the size hint stays unknown,
    // the recorded header set is reproduced verbatim, and the wire framing
    // (chunked here vs content-length on Node's socket) is invisible to any
    // fetch client — status and body bytes are identical.
    let mut resp = Response::new(Body::from_stream(futures_util::stream::iter([Ok::<
        _,
        std::io::Error,
    >(
        Bytes::from(body),
    )])));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_err_text_omits_the_colon_clause() {
        assert_eq!(upstream_error_message(400, ""), "Upstream returned 400");
    }

    #[test]
    fn err_text_truncates_at_200_chars_like_slice() {
        let long = format!("upstream exploded: {}", "X".repeat(300));
        let m = upstream_error_message(500, &long);
        let tail = m.strip_prefix("Upstream returned 500: ").expect("prefix");
        assert!(tail.starts_with("upstream exploded: "));
        assert_eq!(tail.chars().count(), 200, "errText.slice(0, 200)");
        assert_eq!(tail, &long.chars().take(200).collect::<String>());
    }

    #[test]
    fn truncation_counts_utf16_units_not_runes() {
        let s = "\u{1F600}".repeat(150); // 300 UTF-16 units
        let m = upstream_error_message(500, &s);
        assert_eq!(
            m,
            format!("Upstream returned 500: {}", "\u{1F600}".repeat(100))
        );
    }

    #[test]
    fn host_extraction_mirrors_js_url_host() {
        assert_eq!(
            unreachable_message("http://127.0.0.1:9/v1/chat/completions"),
            "Could not reach the model server at 127.0.0.1:9."
        );
        // default port dropped, exactly like URL.host
        assert_eq!(
            unreachable_message("http://example.com:80/v1/x"),
            "Could not reach the model server at example.com."
        );
        assert_eq!(
            unreachable_message("https://strata.local/v1/x"),
            "Could not reach the model server at strata.local."
        );
        assert_eq!(
            unreachable_message("http://[::1]:8080/v1/x"),
            "Could not reach the model server at [::1]:8080."
        );
        assert_eq!(
            unreachable_message("not a url"),
            "Could not reach the model server at the configured port."
        );
    }

    #[test]
    fn json_error_body_shape() {
        let resp = json_error(StatusCode::BAD_GATEWAY, "No response body from model");
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
    }
}
