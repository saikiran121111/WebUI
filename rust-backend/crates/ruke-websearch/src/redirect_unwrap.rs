//! OWNER: W4 — parity port of `lib/web-search/redirect-unwrap.ts`.
//!
//! Stage-0 redirect unwrapper: follows the HTTP 3xx `Location` chain (the
//! TLS layer already resolved it — `PageResponse.resolvedUrl`) and then any
//! `<meta http-equiv="refresh">` hop, bounded by `maxHops`.
//!
//! NOTE: despite the Part-6 plan's shorthand ("unwrap google /url?,
//! bing /ck/a, duckduckgo uddg"), THIS TS module is not a query-param
//! redirector decoder — those forms live in `engines.ts` (shipped,
//! `engines.rs`). This module only handles short-link / dynamic-link stubs
//! plus HTTP-chain + meta-refresh hops; ported exactly, no engines logic
//! merged in (parity, not DRY).
//!
//! ## QUIRKS / DIVERGENCES (kept, not fixed)
//! - `page.resolvedUrl && page.resolvedUrl !== current` — the HTTP-chain
//!   branch wins whenever the fetch layer reports a different final URL,
//!   EVEN IF the same body also carries a meta-refresh (the refresh is
//!   only consulted on the `else` arm). Verbatim.
//! - Chain breaks mid-flight (`fetchPage` → null) return the partial
//!   `{ finalUrl: current, hops }` when `hops > 0`, `null` on hop-0
//!   failure. The loop-end `return { finalUrl, hops }` (maxHops exhausted)
//!   can report `hops == maxHops + 1`. Verbatim.
//! - `decodeURIComponent` maps to [`decode_uri_component`]: throws ⇢
//!   `None` (bad `%` escape or undecodable UTF-8), caught → `next = ""` →
//!   the chain "settles" on `current`. Verbatim.
//! - `new URL(decoded, current).toString()` → WHATWG base resolution;
//!   `url::Url::parse` + `join` is used. Micro-divergence recorded: WHATWG
//!   special-scheme normalization (backslash→slash, tab/newline stripping,
//!   single-dot collapse in odd spots) differs from the `url` crate in a
//!   handful of degenerate inputs; the common absolute-target case is
//!   identical.
//! - `SHORTLINK_HOSTS` matched after `.toLowerCase().replace(/^www\./,"")`
//!   (ONE www strip only, unlike platform-api's double strip) plus the
//!   `.page.link` / `.app.link` suffix scan. Verbatim.
//! - IDN hosts: `url::Url` punycodes/lowers hosts; JS `new URL()` lowers +
//!   punycodes identically, so the `www.`-strip on a punycoded host (e.g.
//!   `www.XN--…`) behaves the same.
//! - No `process.env` / API-key reads anywhere in this TS file (and none
//!   in its Rust port); timeouts/hops come from the options object only.

use regex::Regex;
use std::sync::OnceLock;
use url::Url;

use crate::net::{FetchPageOpts, Net};

/// TS `SHORTLINK_HOSTS` — the verbatim ReadonlySet contents.
pub fn shortlink_hosts() -> &'static [&'static str] {
    &[
        // Google / Firebase dynamic links
        "maps.app.goo.gl",
        "g.page",
        "goo.gl",
        "page.link",
        "app.link",
        // generic shorteners named in the spec + common siblings
        "bit.ly",
        "t.co",
        "lnkd.in",
        "redd.it",
        "amzn.to",
        "amzn.eu",
        "buff.ly",
        "tinyurl.com",
        "ow.ly",
        "is.gd",
        "cutt.ly",
        "s.id",
        "shorturl.at",
    ]
}

/// TS `isShortLinkUrl(url)` — invalid URL ⇒ false (try/catch).
pub fn is_short_link_url(url: &str) -> bool {
    let host = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let host = match host.host_str() {
        Some(h) => h,
        None => return false,
    };
    let host = host.to_lowercase();
    // ONE leading www. strip (JS replace(/^www\./, "")):
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if shortlink_hosts().contains(&host) {
        return true;
    }
    // Firebase dynamic-link subdomains: <project>.page.link / <x>.app.link
    for suffix in [".page.link", ".app.link"] {
        if host.ends_with(suffix) {
            return true;
        }
    }
    false
}

/// JS `decodeURIComponent(s)` — `None` ⇔ URIError (a `%` not followed by
/// exactly two hex digits, or a decoded-byte sequence that is not valid
/// UTF-8). Literal multi-byte chars pass through as their UTF-8 bytes and
/// re-group with adjacent `%XX` bytes exactly like V8's byte-run decode.
fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `<meta http-equiv="refresh" content="0;url=https://…">` (the hop HTTP can't see).
fn meta_refresh_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // VERBATIM JS /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'\s>]+)/i
        // (JS \s is Unicode; the regex crate's \s is Unicode by default too.)
        Regex::new(r#"(?i)<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'\s>]+)"#)
            .unwrap()
    })
}

/// TS `opts: { maxHops?: number; timeoutMs?: number } = {}`.
#[derive(Debug, Clone, Default)]
pub struct UnwrapOpts {
    /// TS default 5.
    pub max_hops: Option<usize>,
    /// TS default 20_000.
    pub timeout_ms: Option<u64>,
}

/// TS `{ finalUrl: string; hops: number }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnwrapResult {
    pub final_url: String,
    pub hops: usize,
}

/// TS `unwrapRedirect(url, opts)` — follow the HTTP-chain then
/// meta-refresh hops; `null` only when hop-0 fetch fails outright.
pub async fn unwrap_redirect(net: &dyn Net, url: &str, opts: UnwrapOpts) -> Option<UnwrapResult> {
    let max_hops = opts.max_hops.unwrap_or(5);
    let timeout_ms = opts.timeout_ms.unwrap_or(20_000);
    let mut current = url.to_string();
    let mut hops: usize = 0;

    while hops <= max_hops {
        let page = net
            .fetch_page(
                &current,
                &FetchPageOpts {
                    timeout_ms: Some(timeout_ms),
                    retry_on_block: Some(true),
                    ..Default::default()
                },
            )
            .await;
        let page = match page {
            Some(p) => p,
            None => {
                // Chain broke mid-flight: keep whatever destination we reached.
                return if hops > 0 {
                    Some(UnwrapResult { final_url: current, hops })
                } else {
                    None
                };
            }
        };

        let mut next = String::new();
        if !page.resolved_url.is_empty() && page.resolved_url != current {
            // HTTP 3xx chain already followed by the TLS layer.
            next = page.resolved_url.clone();
        } else {
            // meta-refresh hop.
            if let Some(cap) = meta_refresh_re().captures(page.body.as_str()) {
                if let Some(decoded) = decode_uri_component(cap[1].trim()) {
                    // new URL(decoded, current).toString() — absolute target
                    // wins, else resolve against `current`; a throw (invalid
                    // relative + invalid base) leaves next = "".
                    next = match Url::parse(&decoded) {
                        Ok(u) => u.as_str().to_string(),
                        Err(_) => match Url::parse(&current) {
                            Ok(base) => base.join(&decoded).map(|u| u.as_str().to_string()).unwrap_or_default(),
                            Err(_) => String::new(),
                        },
                    };
                }
            }
        }

        if next.is_empty() || next == current {
            // Settled: `current` is the real destination (possibly == the input).
            return Some(UnwrapResult { final_url: current, hops });
        }
        current = next;
        hops += 1;
    }
    Some(UnwrapResult { final_url: current, hops })
}

/// TS `unwrapShortLink(url)` — the resolved URL string, or null (never throws).
pub async fn unwrap_short_link(net: &dyn Net, url: &str) -> Option<String> {
    unwrap_redirect(net, url, UnwrapOpts::default())
        .await
        .map(|r| r.final_url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{PageResponse, ScriptedNet};

    fn page(_url: &str, resolved: &str, body: &str) -> PageResponse {
        PageResponse {
            status: 200,
            ok: true,
            body: body.into(),
            content_type: "text/html".into(),
            elapsed_ms: 1,
            fingerprint: "chrome".into(),
            cookies: vec![],
            resolved_url: resolved.into(),
            bot_name: None,
        }
    }

    #[test]
    fn shortlink_hosts_table_verbatim() {
        assert_eq!(shortlink_hosts().len(), 18);
        assert!(shortlink_hosts().contains(&"maps.app.goo.gl"));
        assert!(shortlink_hosts().contains(&"shorturl.at"));
    }

    #[test]
    fn is_short_link_url_parity() {
        // exact hosts (case-insensitive, single www strip)
        assert!(is_short_link_url("https://maps.app.goo.gl/abc"));
        assert!(is_short_link_url("https://BIT.LY/x"));
        assert!(is_short_link_url("https://www.bit.ly/x"));
        // www.strip_prefix only ONCE (no double strip):
        assert!(!is_short_link_url("https://www.www.bit.ly/x"));
        // Firebase dynamic-link subdomain suffixes
        assert!(is_short_link_url("https://myproject.page.link/xyz"));
        assert!(is_short_link_url("https://x.app.link/xyz"));
        // suffix scan requires the LEADING DOT — bare host is the exact-match arm
        assert!(is_short_link_url("https://page.link/a"));
        assert!(!is_short_link_url("https://notpage.link/a"));
        assert!(!is_short_link_url("https://page.link.evil.dev/a"));
        // near-misses + negatives
        assert!(!is_short_link_url("https://bit.ly.evil.dev/x"));
        assert!(!is_short_link_url("https://redd.itX/x"));
        assert!(!is_short_link_url("not a url")); // new URL throw → false
        assert!(!is_short_link_url("https://normal.dev/x"));
    }

    #[test]
    fn decode_uri_component_urierror_parity() {
        assert_eq!(decode_uri_component("%41").as_deref(), Some("A"));
        assert_eq!(decode_uri_component("%68%74%74%70%73%3a%2f%2fx.dev%2fa").as_deref(), Some("https://x.dev/a"));
        // DOUBLE encoding: ONE decode pass leaves %25… in place (quirk kept)
        assert_eq!(decode_uri_component("%2541").as_deref(), Some("%41"));
        // malformed ⇒ None (JS URIError → caught → next = "")
        assert_eq!(decode_uri_component("100%"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%c3%28"), None); // invalid UTF-8 byte run
        // literal multi-byte chars re-group with escapes exactly like V8
        assert_eq!(decode_uri_component("a%20b").as_deref(), Some("a b"));
        assert_eq!(decode_uri_component("é").as_deref(), Some("é"));
        assert_eq!(decode_uri_component("a%c3%a9").as_deref(), Some("aé"));
    }

    #[test]
    fn meta_refresh_regex_variants() {
        let re = meta_refresh_re();
        // canonical
        assert!(re.is_match(r#"<meta http-equiv="refresh" content="0;url=https://t.dev/x">"#));
        // uppercase / spaced attrs / single quotes / case-insensitive refresh
        assert!(re.is_match(r#"<META HTTP-EQUIV = 'REFRESH' CONTENT = '5 ; url = https://t.dev/x'>"#));
        // unquoted content
        assert!(re.is_match(r#"<meta http-equiv=refresh content=0;url=https://t.dev/x>"#));
        // attribute-before form (http-equiv AFTER another attr — [^>]+ both sides)
        assert!(re.is_match(r#"<meta charset="utf-8" http-equiv="refresh" content="0; URL=https://t.dev/x">"#));
        // negatives
        assert!(!re.is_match(r#"<meta http-equiv="content-type" content="0;url=https://t.dev/x">"#));
        assert!(!re.is_match(r#"<meta http-equiv="refresh" content="5">"#));
        assert!(!re.is_match(r#"<meta http-equiv="refresh" content="url=https://t.dev/x">"#)); // no \d+
    }

    #[tokio::test]
    async fn http_chain_wins_over_meta_refresh_and_settles() {
        // TS trace: AT A the HTTP branch wins (resolvedUrl B ≠ A), so A's
        // own meta-refresh decoy is IGNORED for that hop. AT B the else-arm
        // fires (resolvedUrl === current) so B's meta-refresh IS honored —
        // the loop re-evaluates at each hop. Then C settles. hops = 2.
        let net = ScriptedNet::default()
            .with_page(
                "https://a.dev/x",
                page("https://a.dev/x", "https://b.dev/y", r#"<meta http-equiv="refresh" content="0;url=https://d.dev/decoy">"#),
            )
            .with_page(
                "https://b.dev/y",
                page("https://b.dev/y", "https://b.dev/y", r#"<meta http-equiv="refresh" content="0;url=https://c.dev/z">"#),
            )
            .with_page("https://c.dev/z", page("https://c.dev/z", "https://c.dev/z", ""));
        let r = unwrap_redirect(&net, "https://a.dev/x", UnwrapOpts::default()).await.unwrap();
        assert_eq!(r, UnwrapResult { final_url: "https://c.dev/z".into(), hops: 2 });
        // D was NEVER fetched (had the decoy won, the unscripted D fetch
        // would break the chain and yield { finalUrl: D, hops: 1 }):
        let urls: Vec<String> = net.calls.lock().unwrap().iter().map(|(u, _)| u.clone()).collect();
        assert_eq!(
            urls,
            vec![
                "https://a.dev/x".to_string(),
                "https://b.dev/y".to_string(),
                "https://c.dev/z".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn meta_refresh_hop_decodes_and_resolves() {
        // percent-encoded absolute target on A, then B settles.
        let net = ScriptedNet::default().with_page(
            "https://a.dev/",
            page("https://a.dev/", "https://a.dev/", r#"<meta http-equiv="refresh" content="0;url=https%3A%2F%2Fb.dev%2Fplace%3Fq%3Dx%20y">"#),
        ).with_page("https://b.dev/place?q=x%20y", page("https://b.dev/place?q=x%20y", "https://b.dev/place?q=x%20y", "settled"));
        let r = unwrap_redirect(&net, "https://a.dev/", UnwrapOpts::default()).await.unwrap();
        assert_eq!(r.final_url, "https://b.dev/place?q=x%20y");
        assert_eq!(r.hops, 1);
    }

    #[tokio::test]
    async fn meta_refresh_relative_target_resolves_against_current() {
        // WHATWG `new URL("two.html", "https://a.dev/one/")` resolves
        // against the trailing-slash DIRECTORY → /one/two.html (the test's
        // original root-relative expectation was NOT TS behavior).
        let net = ScriptedNet::default()
            .with_page("https://a.dev/one/", page("https://a.dev/one/", "https://a.dev/one/", r#"<meta http-equiv="refresh" content="3;url=two.html">"#))
            .with_page("https://a.dev/one/two.html", page("https://a.dev/one/two.html", "https://a.dev/one/two.html", ""));
        let r = unwrap_redirect(&net, "https://a.dev/one/", UnwrapOpts::default()).await.unwrap();
        assert_eq!(r.final_url, "https://a.dev/one/two.html");
        assert_eq!(r.hops, 1);
    }

    #[tokio::test]
    async fn malformed_meta_target_settles_in_place() {
        // decodeURIComponent throw (bad %) ⇒ next = "" ⇒ settled, hops 0.
        let net = ScriptedNet::default().with_page(
            "https://a.dev/",
            page("https://a.dev/", "https://a.dev/", r#"<meta http-equiv="refresh" content="0;url=https://b.dev/%zz">"#),
        );
        let r = unwrap_redirect(&net, "https://a.dev/", UnwrapOpts::default()).await.unwrap();
        assert_eq!(r, UnwrapResult { final_url: "https://a.dev/".into(), hops: 0 });
    }

    #[tokio::test]
    async fn chain_break_semantics() {
        // hop-0 failure → null.
        let net = ScriptedNet::default();
        assert!(unwrap_redirect(&net, "https://a.dev/", UnwrapOpts::default()).await.is_none());
        // broke AFTER one hop → partial result kept.
        let net2 = ScriptedNet::default().with_page("https://a.dev/", page("https://a.dev/", "https://b.dev/", ""));
        let r = unwrap_redirect(&net2, "https://a.dev/", UnwrapOpts::default()).await.unwrap();
        assert_eq!(r, UnwrapResult { final_url: "https://b.dev/".into(), hops: 1 });
    }

    #[tokio::test]
    async fn max_hops_bound_returns_overflow_hops() {
        // A ⇄ B ping-pong: maxHops 1 → the loop-end return reports hops = 2.
        let net = ScriptedNet::default()
            .with_page("https://a.dev/", page("https://a.dev/", "https://b.dev/", ""))
            .with_page("https://b.dev/", page("https://b.dev/", "https://a.dev/", ""));
        let r = unwrap_redirect(&net, "https://a.dev/", UnwrapOpts { max_hops: Some(1), timeout_ms: None }).await.unwrap();
        assert_eq!(r, UnwrapResult { final_url: "https://a.dev/".into(), hops: 2 });
    }

    #[tokio::test]
    async fn non_redirector_url_passes_through_zero_hops() {
        let net = ScriptedNet::default()
            .with_page("https://normal.dev/x", page("https://normal.dev/x", "https://normal.dev/x", "<html>real content</html>"));
        let r = unwrap_redirect(&net, "https://normal.dev/x", UnwrapOpts::default()).await.unwrap();
        assert_eq!(r, UnwrapResult { final_url: "https://normal.dev/x".into(), hops: 0 });
        // convenience mirror: unwrapShortLink never throws, maps Some/None
        assert_eq!(unwrap_short_link(&net, "https://normal.dev/x").await.as_deref(), Some("https://normal.dev/x"));
        let dead = ScriptedNet::default();
        assert!(unwrap_short_link(&dead, "https://normal.dev/x").await.is_none());
    }
}
