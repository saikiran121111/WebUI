//! Parity port of `lib/web-search/ssrf.ts` — the single source of truth
//! for "may we fetch this URL?".
//!
//! PARITY NOTES (verbatim TS behavior — quirks RECORDED, not fixed):
//! - The regex is a HOSTNAME *prefix* test (no word boundary): any
//!   hostname starting with `127.`, `10.`, `fc`, `fd`, … is blocked, so
//!   public hosts like `fd.nl` or `fc-blog.org` are refused. TS identical.
//! - The bare `::1` / `fc` / `fd` alternatives can NEVER match a WHATWG
//!   IPv6 host because `new URL(...)` bracket-wraps it (`[::1]`), so
//!   bracketed IPv6 loopback/ULA (`http://[::1]/`, `http://[fd00::1]/`)
//!   are NOT blocked by this regex. TS identical — kept verbatim; the
//!   net layer's other guards happen to refuse such URLs anyway, but
//!   do not rely on this regex alone.
//! - WHATWG normalization DOES deflate decimal/hex/octal IPv4 forms
//!   (`2130706433` → `127.0.0.1`), so those ARE blocked. Both engines
//!   (Node `URL` and the `url` crate) follow the WHATWG spec here.
//! - NO DNS resolution: DNS-rebinding TOCTOU is out of scope (TS same).
//! - **NO `RUKE_TEST_FIXTURES=1` allow-list.** MIGRATION-MAP §2.5 still
//!   mentions `isFixtureAllowed`, but that code was DELETED from the
//!   current TypeScript (verified 2026-10-27: no `isFixtureAllowed` /
//!   `RUKE_TEST_FIXTURES` exists anywhere in `lib/`). There is nothing to
//!   port; we deliberately do NOT fabricate one (SSRF must not be
//!   weakened — fixture isolation happens at the `net::Net` /
//!   `cache::SearchCache` trait seams, not at the SSRF layer).

use regex::Regex;
use std::sync::OnceLock;

fn private_host_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc|fd)",
        )
        .expect("static regex compiles")
    })
}

/// Block `file:`, `data:`, and any URL whose hostname is loopback /
/// private / link-local. Returns true only for http(s) URLs with a
/// "public" hostname per the prefix table above.
pub fn is_safe_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) => {
            if u.scheme() != "http" && u.scheme() != "https" {
                return false;
            }
            match u.host_str() {
                // WHATWG Url::host_str brackets IPv6; the TS `hostname`
                // accessor does not — but for regex purposes Node's
                // `u.hostname` for IPv6 is "::1"-style WITHOUT brackets…
                // (Node: new URL("http://[::1]/").hostname === "[::1]"
                //  — brackets INCLUDED, which is why the bare `::1`
                //  alternative is dead code. url crate host_str for
                //  IPv6 is "::{...}"-style bracketless? It is bracketed
                //  in Display but host_str() gives "[::1]" — SAME as
                //  Node. Parity holds.)
                Some(host) => !private_host_re().is_match(host),
                None => false, // opaque host (non-special scheme) — unreachable for http(s)
            }
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_public_http_https() {
        assert!(is_safe_url("https://skiran.dev/blog"));
        assert!(is_safe_url("http://example.com:8080/path?q=1#f"));
        assert!(is_safe_url("https://EXAMPLE.com/UpperCasing")); // WHATWG lowercases
    }

    #[test]
    fn blocks_non_http_schemes() {
        assert!(!is_safe_url("file:///etc/passwd"));
        assert!(!is_safe_url("data:text/html,<script/>"));
        assert!(!is_safe_url("ftp://example.com/x"));
        assert!(!is_safe_url("gopher://example.com"));
        assert!(!is_safe_url("not a url at all"));
        assert!(!is_safe_url(""));
    }

    #[test]
    fn blocks_private_and_loopback_prefixes_case_insensitively() {
        for u in [
            "http://localhost/x",
            "http://LocalHost:3000/x",
            "http://127.0.0.1:3101/api",
            "http://127.8.9.10/",
            "http://0.0.0.0/",
            "http://10.1.2.3/",
            "http://169.254.169.254/latest/meta-data/",
            "http://172.16.0.1/",
            "http://172.20.5.5/",
            "http://172.31.255.255/",
            "http://192.168.1.1/",
        ] {
            assert!(!is_safe_url(u), "must block {u}");
        }
        // 172.15.x and 172.32.x are NOT private — allowed (TS parity).
        assert!(is_safe_url("http://172.15.0.1/"));
        assert!(is_safe_url("http://172.32.0.1/"));
    }

    #[test]
    fn whatwg_normalization_defeats_obfuscated_ips() {
        // Node's WHATWG URL and the url crate both normalize these to
        // 127.0.0.1 ⇒ the `127.` prefix catches them.
        assert!(!is_safe_url("http://2130706433/"));
        assert!(!is_safe_url("http://0x7f000001/"));
    }

    #[test]
    fn recorded_quirks_verbatim() {
        // 1. prefix-with-no-boundary: public hosts starting with the
        //    blocked strings are refused (TS identical).
        assert!(!is_safe_url("https://fd.nl/")); // fd ⇒ Finnish news site
        assert!(!is_safe_url("https://10.example.com/")); // numeric-label prefix "10."
        // 2. bracketed IPv6 slips past the bare ::1/fc/fd alternatives
        //    (both Node and url crate bracket the host — TS identical).
        assert!(is_safe_url("http://[::1]/")); // DEAD regex alternative quirk
        assert!(is_safe_url("http://[fd00::1234]/"));
        // The bare forms never reach the regex (parse failure):
        assert!(!is_safe_url("http://::1/"));
    }
}
