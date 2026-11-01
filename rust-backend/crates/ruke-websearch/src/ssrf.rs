//! Parity port of `lib/web-search/ssrf.ts` — the single source of truth
//! for "may we fetch this URL?".
//!
//! HARDENED 2026-11-02 (web-search P6 safety — the cross-language change
//! the old module docs told us not to make without mirroring TS: TS
//! `lib/web-search/ssrf.ts` carries the identical hardening, same commit).
//! The legacy hostname-PREFIX regex is kept VERBATIM — its deliberate
//! over-blocks (`fd.nl`, `10.example.com`) and its misses (`172.15.0.1` /
//! `172.32.0.1` allowed) stay pinned on BOTH sides. Added on top (mirrors
//! the TS header):
//!  - bracketed IPv6 parsing: `::`, `::1`, ULA fc00::/7 `(g0&0xfe00)==0xfc00`,
//!    link-local fe80::/10, multicast ff00::/8, and embedded-IPv4 forms
//!    (IPv4-mapped `::ffff:…` incl. hex groups, 6to4 `2002::…`, Teredo
//!    `2001:0::…` obfuscated client + server v4). The RECORDED quirk that
//!    `http://[::1]/` / `http://[fd00::1234]/` slipped through the dead
//!    bare-`::1|fc|fd` regex alternatives is now REVERSED: they are
//!    BLOCKED (TS same). The alternatives themselves are still dead code
//!    against bracketed hosts — WHATWG brackets IPv6 (`[::1]`) in BOTH
//!    Node's `URL.hostname` and the url crate's `host_str()`.
//!  - CGNAT 100.64.0.0/10 (100.63.255.255 stays allowed) and 0.0.0.0/8;
//!  - reserved suffixes: .local / .internal / .localhost / .home.arpa / .invalid;
//!  - userinfo rejection (`http://user:pass@host/` is unsafe — §19);
//!  - `is_safe_url_with_dns`: DNS-rebinding guard. `is_safe_url_with_records`
//!    is the deterministic core so cargo tests inject A/AAAA records the way
//!    the TS suite injects fake resolvers. Resolution uses
//!    `std::net::ToSocketAddrs` on the blocking pool (the workspace tokio
//!    build lacks the `net` feature). Documented superset vs TS: getaddrinfo
//!    also consults the OS hosts file where TS `dns.resolve4/resolve6` is
//!    DNS-only — the Rust side can classify MORE addresses private, never
//!    fewer. Total resolution failure falls back to the literal decision.
//!  - `first_unsafe_redirect_hop`: redirect-chain revalidation helper
//!    (net-layer per-hop `Policy::custom` + final-URL rechecks);
//!  - `scrub_query_secrets`: deterministic outbound-query secret strip (§14).
//!
//! PARITY CAVEATS (documented, do not "fix"):
//! - Rust `\b`/`\s` are Unicode-aware, JS's are ASCII-only. Every shared
//!   test vector is ASCII so behavior matches; non-ASCII adjacency around a
//!   scrub pattern boundary could in principle differ. Recorded.
//! - The dotted-quad rewrite inside `parse_ipv6_groups` is a DEAD path in
//!   TS: the anchored `IPV4_RE.exec` only ever matches a WHOLE-string
//!   dotted-quad, whose rewritten `":hi:lo"` form then fails the hex-group
//!   parse ⇒ null. Ported verbatim. Dotted IPv4-mapped literals like
//!   `[::ffff:127.0.0.1]` are handled upstream instead: both engines'
//!   WHATWG normalization hex-forms them to `[::ffff:7f00:1]` before the
//!   classifier ever sees them (and anything still dotted falls into the
//!   "bracketed but unparseable ⇒ refuse" path — refuse either way).
//! - **NO `RUKE_TEST_FIXTURES=1` allow-list.** MIGRATION-MAP §2.5 still
//!   mentions `isFixtureAllowed`, but that code was DELETED from the
//!   current TypeScript (verified 2026-10-27: no `isFixtureAllowed` /
//!   `RUKE_TEST_FIXTURES` exists anywhere in `lib/`). There is nothing to
//!   port; we deliberately do NOT fabricate one (SSRF must not be
//!   weakened — fixture isolation happens at the `net::Net` /
//!   `cache::SearchCache` trait seams, not at the SSRF layer).
//!
//! RUST MIRROR (this file ⇄ `lib/web-search/ssrf.ts`): test vectors are
//! deliberately shared with `__tests__/web-search/security.test.ts`;
//! changing one side's pins requires changing the other's in the same
//! commit.

use regex::Regex;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::OnceLock;

/// The legacy prefix regex, kept VERBATIM (do not "fix" its over-blocks —
/// parity pins: https://fd.nl and https://10.example.com are blocked;
/// http://172.15.0.1 / http://172.32.0.1 are allowed).
fn private_host_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc|fd)",
        )
        .expect("static regex compiles")
    })
}

/// Reserved / non-routable name suffixes (new, both engines). Note the
/// leading-dot requirement: bare `localhost` stays blocked via the legacy
/// regex above, while `notlocalhost.example.com` remains allowed.
fn unsafe_suffix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\.(local|internal|localhost|home\.arpa|invalid)$")
            .expect("static regex compiles")
    })
}

fn ipv4_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$").expect("static regex compiles")
    })
}

fn octet(m: &regex::Captures, i: usize) -> u32 {
    m[i].parse::<u32>().unwrap_or(9999) // \d{1,3} ⇒ always parses
}

/// True for loopback / RFC1918 / link-local / CGNAT / "this" networks.
fn private_ipv4_octets(a: u32, b: u32, c: u32, d: u32) -> bool {
    if a > 255 || b > 255 || c > 255 || d > 255 {
        return false; // malformed — not an address decision
    }
    a == 0 // 0.0.0.0/8 "this network" (includes 0.0.0.0)
        || a == 10
        || a == 127
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64.0.0/10
}

fn private_ipv4_host(host: &str) -> bool {
    match ipv4_re().captures(host) {
        Some(m) => private_ipv4_octets(octet(&m, 1), octet(&m, 2), octet(&m, 3), octet(&m, 4)),
        None => false,
    }
}

fn hex_group(t: &str) -> Option<u32> {
    if !t.is_empty() && t.len() <= 4 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
        u32::from_str_radix(t, 16).ok()
    } else {
        None
    }
}

/// Parse an unbracketed IPv6 literal into exactly 8 16-bit groups.
/// Mirrors TS `parseIPv6Groups` (incl. its dead dotted-quad rewrite path —
/// see module docs) and its one-directional leniency: `x:y:…::` with ≤8
/// explicit groups is accepted (being lenient can only ever block more).
fn parse_ipv6_groups(input: &str) -> Option<Vec<u32>> {
    let mut s = input.to_string();

    // Trailing dotted-quad → two hex groups (anchored exec ⇒ head is
    // always empty ⇒ the rewritten form fails to parse; VERBATIM TS).
    if let Some(m) = ipv4_re().captures(&s) {
        let (a, b, c, d) = (octet(&m, 1), octet(&m, 2), octet(&m, 3), octet(&m, 4));
        if a > 255 || b > 255 || c > 255 || d > 255 {
            return None;
        }
        let whole = m.get(0).expect("whole match").end(); // m4[0].length
        let mut head = &s[..s.len() - whole];
        if let Some(h) = head.strip_suffix(':') {
            head = h;
        }
        let hi = (a << 8) | b;
        let lo = (c << 8) | d;
        s = format!("{}:{:x}:{:x}", head, hi, lo);
    }

    let dbl = s.find("::");
    if let Some(p) = dbl {
        if s[p + 1..].contains("::") {
            return None; // two "::"
        }
    }

    let (left, right): (Vec<&str>, Option<Vec<&str>>) = match dbl {
        None => (s.split(':').collect(), None),
        Some(p) => {
            let lpart = &s[..p];
            let rpart = &s[p + 2..];
            (
                if lpart.is_empty() {
                    Vec::new()
                } else {
                    lpart.split(':').collect()
                },
                Some(if rpart.is_empty() {
                    Vec::new()
                } else {
                    rpart.split(':').collect()
                }),
            )
        }
    };

    let mut parsed: Vec<u32> = Vec::new();
    for t in left {
        parsed.push(hex_group(t)?);
    }
    if let Some(right) = right {
        if parsed.len() + right.len() > 8 {
            return None;
        }
        while parsed.len() + right.len() < 8 {
            parsed.push(0);
        }
        for t in right {
            parsed.push(hex_group(t)?);
        }
    } else if parsed.len() != 8 {
        return None;
    }
    Some(parsed)
}

/// Private-classification over the 8 parsed groups (see module header).
fn private_ipv6_groups(g: &[u32]) -> bool {
    if g.iter().all(|&x| x == 0) {
        return true; // `::` unspecified
    }
    if g[..7].iter().all(|&x| x == 0) && g[7] == 1 {
        return true; // `::1`
    }

    let g0 = g[0];
    if (g0 & 0xfe00) == 0xfc00 {
        return true; // ULA fc00::/7
    }
    if (g0 & 0xffc0) == 0xfe80 {
        return true; // link-local fe80::/10
    }
    if (g0 & 0xff00) == 0xff00 {
        return true; // multicast ff00::/8
    }

    // IPv4-compatible (::/96) and IPv4-mapped (::ffff:/96): delegate the
    // last 32 bits to the IPv4 classifier — this catches `::ffff:7f00:1`
    // (hex) and `::ffff:127.0.0.1` (dotted, normalized to hex upstream).
    if g[..5].iter().all(|&x| x == 0) && (g[5] == 0 || g[5] == 0xffff) {
        return private_ipv4_octets(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
    }

    // 6to4 2002::/16 — embedded v4 in groups 1-2.
    if g0 == 0x2002 {
        return private_ipv4_octets(g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff);
    }

    // Teredo 2001:0000::/32 — server v4 in groups 2-3; the client v4 is
    // obfuscated by XOR with the 16-bit flags field (group 4):
    // client = (g5:g6) XOR (g4:g4). JS >>>0 ⇒ Rust u32 wrapping arithmetic.
    if g0 == 0x2001 && g[1] == 0 {
        if private_ipv4_octets(g[2] >> 8, g[2] & 0xff, g[3] >> 8, g[3] & 0xff) {
            return true;
        }
        let obf = (g[5] << 16) | g[6];
        let flags32 = (g[4] << 16) | g[4];
        let c = obf ^ flags32;
        return private_ipv4_octets(
            (c >> 24) & 0xff,
            (c >> 16) & 0xff,
            (c >> 8) & 0xff,
            c & 0xff,
        );
    }

    false
}

/// True when a URL hostname belongs to a private / reserved / non-routable
/// destination. `host` is the WHATWG hostname form (brackets INCLUDED for
/// IPv6, lowercase, no port, no userinfo — url crate `host_str()` and Node
/// `URL.hostname` agree here, parity holds).
pub fn is_private_host(host: &str) -> bool {
    if host.is_empty() {
        return true;
    }
    if private_host_re().is_match(host) {
        return true;
    }
    if unsafe_suffix_re().is_match(host) {
        return true;
    }
    if let Some(rest) = host.strip_prefix('[') {
        let inner = rest.strip_suffix(']').unwrap_or(rest);
        return match parse_ipv6_groups(inner) {
            None => true, // bracketed but unparseable → refuse
            Some(g) => private_ipv6_groups(&g),
        };
    }
    if ipv4_re().is_match(host) {
        return private_ipv4_host(host);
    }
    false
}

/// Block `file:`, `data:`, userinfo, and any URL whose hostname is
/// loopback / private / link-local / reserved. Returns true only for
/// http(s) URLs with a "public" hostname per the checks above.
pub fn is_safe_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) => guard_shape(&u).is_some_and(|host| !is_private_host(host)),
        Err(_) => false,
    }
}

/// Shared shape checks for `is_safe_url` / `is_safe_url_with_dns`:
/// http(s)-only + no userinfo (§19: credentials embedded in a URL are
/// never legitimate scraper traffic and are an exfiltration/log-leak
/// vector). Returns the WHATWG host or None when outright unsafe.
fn guard_shape(u: &url::Url) -> Option<&str> {
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    // opaque host (non-special scheme) — unreachable for http(s); treat as unsafe.
    u.host_str()
}

/// Redirect-chain revalidation: given the ordered chain of URLs a fetch
/// traversed, returns the FIRST hop that is unsafe, or None when the whole
/// chain is safe. The net layer enforces this live via the redirect
/// policy; this helper mirrors TS `firstUnsafeRedirectHop` for tests and
/// post-hoc chain checks.
pub fn first_unsafe_redirect_hop(hops: &[String]) -> Option<String> {
    for h in hops {
        if h.is_empty() {
            continue;
        }
        if !is_safe_url(h) {
            return Some(h.clone());
        }
    }
    None
}

/// A/AAAA records for a host — ⇠ TS `{ v4, v6 }` from the injectable
/// resolver. `None` records ⇠ TS "resolver threw / returned null".
#[derive(Debug, Clone, Default)]
pub struct DnsRecords {
    pub v4: Vec<String>,
    pub v6: Vec<String>,
}

fn resolved_address_private(addr: &str) -> bool {
    let t = addr.trim();
    if ipv4_re().is_match(t) {
        return private_ipv4_host(t);
    }
    // Resolvers may hand back scoped/link forms; classify by the
    // bracketless parser. Garbage from a resolver → refuse.
    let cleaned = t.replace(['[', ']'], "");
    match parse_ipv6_groups(&cleaned) {
        Some(g) => private_ipv6_groups(&g),
        None => true,
    }
}

/// Host classification gate shared by the literal and DNS-aware guards.
/// `None` ⇒ outright unsafe; `Some(None)` ⇒ host is an IP literal, already
/// fully classified (skip DNS); `Some(Some(host))` ⇒ a domain name that
/// needs record resolution.
fn dns_gate_host(url: &str) -> Option<Option<String>> {
    let u = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return None,
    };
    let host = guard_shape(&u)?;
    if is_private_host(host) {
        return None;
    }
    if host.starts_with('[') || ipv4_re().is_match(host) {
        return Some(None); // literal, already classified
    }
    Some(Some(host.to_string()))
}

/// DNS-aware decision with records supplied DETERMINISTICALLY — the cargo
/// mirror of the TS `isSafeUrlWithDns` + fake-resolver tests. `None`
/// records ⇠ resolver threw / returned null ⇒ LITERAL decision (true here:
/// the host already passed the literal checks — a resolver outage must not
/// masquerade as an SSRF denial). Any single private record ⇒ false.
pub fn is_safe_url_with_records(url: &str, records: Option<DnsRecords>) -> bool {
    match dns_gate_host(url) {
        None => false,
        Some(None) => true,
        Some(Some(_host)) => {
            let recs = match records {
                Some(r) => r,
                None => return true, // literal decision (see docs above)
            };
            for a in recs.v4.iter().chain(recs.v6.iter()) {
                if resolved_address_private(a) {
                    return false;
                }
            }
            true
        }
    }
}

/// SSRF guard with DNS-awareness (⇠ TS `isSafeUrlWithDns`): after the
/// literal host check, resolves A and AAAA records and refuses the URL
/// when ANY resolved address is private — closing the DNS-rebinding TOCTOU
/// a literal-only check cannot see, because the guard and the fetch
/// consult the same name in the same call.
///
/// Resolution runs `std::net::ToSocketAddrs` on tokio's blocking pool
/// (workspace tokio lacks the `net` feature). See module docs for the
/// documented hosts-file superset vs TS `dns.resolve4/resolve6`.
pub async fn is_safe_url_with_dns(url: &str) -> bool {
    let host = match dns_gate_host(url) {
        None => return false,
        Some(None) => return true,
        Some(Some(h)) => h,
    };
    let records = tokio::task::spawn_blocking(move || {
        match (host.as_str(), 0u16).to_socket_addrs() {
            Ok(addrs) => {
                let mut r = DnsRecords::default();
                for a in addrs {
                    match a {
                        SocketAddr::V4(a4) => r.v4.push(a4.ip().to_string()),
                        SocketAddr::V6(a6) => r.v6.push(a6.ip().to_string()),
                    }
                }
                // ⇠ TS defaultDnsResolver: no records at all ⇒ null ⇒ literal decision.
                if r.v4.is_empty() && r.v6.is_empty() {
                    None
                } else {
                    Some(r)
                }
            }
            Err(_) => None,
        }
    })
    .await
    .unwrap_or(None); // join panic/cancel ⇠ resolver throw ⇒ literal decision
    is_safe_url_with_records(url, records)
}

/* ── Outbound-query secret scrub (§14) ────────────────────────────────────
 * Deterministic, model-free: strips well-known credential shapes from any
 * query string before it leaves this machine via a search-engine request.
 * Conservative patterns — a benign query ("python 3.11 release notes")
 * must survive untouched; pinned by tests in BOTH languages. Vectors are
 * shared with `__tests__/web-search/security.test.ts` verbatim.
 */
fn scrub_res_cs() -> &'static [Regex] {
    static V: OnceLock<Vec<Regex>> = OnceLock::new();
    V.get_or_init(|| {
        [
            r"sk-[A-Za-z0-9_-]{16,}", // OpenAI/Stripe-style secret keys
            r"\bAKIA[0-9A-Z]{16}\b",  // AWS access key id
            r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b", // GitHub OAuth/PAT
            r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", // GitHub fine-grained PAT
            r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", // Slack tokens
            r"\bAIza[0-9A-Za-z_-]{35}\b", // Google API key
            r"\bya29\.[A-Za-z0-9_-]{20,}\b", // Google OAuth token
            r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b", // JWT (header.payload.sig)
        ]
        .map(|p| Regex::new(p).expect("static scrub regex compiles"))
        .into_iter()
        .collect()
    })
}

fn scrub_res_ci() -> &'static [Regex] {
    static V: OnceLock<Vec<Regex>> = OnceLock::new();
    V.get_or_init(|| {
        [
            // Authorization-style bearer values (`gi` ⇠ JS /gi; Rust is
            // byte-case-sensitive, so the flag lives in the pattern)
            r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*",
            // key: value pairs
            r"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+",
        ]
        .map(|p| Regex::new(p).expect("static scrub regex compiles"))
        .into_iter()
        .collect()
    })
}

fn whitespace_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").expect("static regex compiles"))
}

pub fn scrub_query_secrets(query: &str) -> String {
    if query.is_empty() {
        return query.to_string();
    }
    let mut out = query.to_string();
    for re in scrub_res_cs() {
        out = re.replace_all(&out, " ").into_owned();
    }
    for re in scrub_res_ci() {
        out = re.replace_all(&out, " ").into_owned();
    }
    whitespace_re().replace_all(&out, " ").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── vectors SHARED with __tests__/web-search/security.test.ts ──────

    #[test]
    fn blocks_private_reserved_metadata_userinfo_bad_scheme() {
        for u in [
            // legacy prefix-regex pins (kept VERBATIM — deliberate over-blocks)
            "http://fd.nl/",
            "http://10.example.com/",
            "http://localhost:3000/x",
            "http://127.0.0.1/",
            "http://0.0.0.0/",
            "http://169.254.169.254/latest/meta-data/", // cloud metadata
            "http://192.168.1.1/",
            "http://10.0.0.5/",
            // WHATWG collapses decimal/hex IPv4 forms to dotted-quad
            "http://2130706433/",
            "http://0x7f000001/",
            // hardened vectors
            "http://172.16.0.1/",
            "http://100.64.0.1/", // CGNAT 100.64.0.0/10
            "http://100.127.255.255/",
            "http://[::1]/", // loopback v6 (REVERSED quirk: previously allowed)
            "http://[fd00::1234]/", // ULA (REVERSED quirk: previously allowed)
            "http://[fc00::1]/",
            "http://[::ffff:127.0.0.1]/", // IPv4-mapped (hex-normalized upstream or refused as unparseable)
            "http://[::ffff:7f00:1]/",    // IPv4-mapped hex groups
            "http://[::7f00:1]/",         // IPv4-compatible
            "http://[2002:7f00:1::]/",    // 6to4 embedding 127.0.0.1
            "http://[fe80::1]/",          // link-local
            "http://[::]/",               // unspecified
            "http://[ff02::1]/",          // v6 multicast
            // reserved suffixes
            "http://printer.local/",
            "http://db.internal/",
            "http://x.home.arpa/",
            "http://bad.invalid/",
            "http://sub.localhost/",
            // userinfo (§19)
            "http://user:pass@example.com/",
            "http://admin@example.com/",
            // non-http schemes
            "file:///etc/passwd",
            "data:text/html,hi",
            "gopher://example.com/",
            // never-a-URL
            "not a url at all",
            "",
            "ftp://example.com/x",
            // bare (unbracketed) IPv6 is a parse failure in both engines
            "http://::1/",
        ] {
            assert!(!is_safe_url(u), "must block {u}");
        }
    }

    #[test]
    fn allows_public_hosts_incl_recorded_legacy_quirks() {
        for u in [
            "http://172.15.0.1/", // legacy pins stay ALLOWED (regex only covers 16-31)
            "http://172.32.0.1/",
            "http://notlocalhost.example.com/",
            "http://100.63.255.255/",         // just below CGNAT
            "http://[2002:8888:1111::]/",     // 6to4 with public v4
            "http://[2606:4700:4700::1111]/", // Cloudflare v6
            "https://example.com/",
            "https://news.ycombinator.com/item?id=1",
            "https://skiran.dev/blog",
            "http://example.com:8080/path?q=1#f",
            "https://EXAMPLE.com/UpperCasing", // WHATWG lowercases
        ] {
            assert!(is_safe_url(u), "must allow {u}");
        }
    }

    #[test]
    fn is_private_host_edges() {
        assert!(is_private_host(""));
        assert!(is_private_host("[not-ipv6]")); // bracketed but unparseable → refuse
        assert!(!is_private_host("example.com"));
    }

    #[test]
    fn first_unsafe_redirect_hop_pins() {
        let safe: Vec<String> = ["https://example.com/a", "https://cdn.example.org/b"]
            .map(String::from)
            .to_vec();
        assert_eq!(first_unsafe_redirect_hop(&safe), None);
        let bad: Vec<String> = [
            "https://ok.example.com",
            "",
            "http://169.254.169.254/",
            "http://127.0.0.1:8080/",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            first_unsafe_redirect_hop(&bad).as_deref(),
            Some("http://169.254.169.254/")
        );
    }

    fn rec(v4: &[&str], v6: &[&str]) -> Option<DnsRecords> {
        Some(DnsRecords {
            v4: v4.iter().map(|s| s.to_string()).collect(),
            v6: v6.iter().map(|s| s.to_string()).collect(),
        })
    }

    #[test]
    fn dns_records_decision_pins() {
        // public name resolving to ANY private record (rebinding)
        assert!(!is_safe_url_with_records(
            "http://rebind.test/path",
            rec(&["93.184.216.34", "127.0.0.1"], &[])
        ));
        assert!(!is_safe_url_with_records(
            "http://rebind.test/path",
            rec(&[], &["fd00::5"])
        ));
        // public-only records → safe
        assert!(is_safe_url_with_records(
            "http://ok.test/",
            rec(&["93.184.216.34"], &["2606:4700:4700::1111"])
        ));
        // total resolver failure (None records) falls back to the LITERAL decision
        assert!(is_safe_url_with_records(
            "http://literal-public.test/",
            None
        ));
        assert!(is_safe_url_with_records("http://nx.test/", None));
        // literal-private hosts stay blocked even when DNS is dead
        assert!(!is_safe_url_with_records("http://127.0.0.1:9/x", None));
        assert!(!is_safe_url_with_records("http://localhost:3000/x", None));
        // IP literals skip resolution entirely (records must be ignored)
        assert!(is_safe_url_with_records(
            "http://93.184.216.34/",
            rec(&["127.0.0.1"], &[])
        ));
        // userinfo and reserved suffixes are refused before resolution
        assert!(!is_safe_url_with_records("http://u:p@ok.test/", None));
        assert!(!is_safe_url_with_records("http://host.local/", None));
    }

    #[tokio::test]
    async fn dns_aware_guard_on_literals_never_touches_the_resolver() {
        // IP-literal hosts are fully classified without any lookup, so
        // these run network-free in CI.
        assert!(is_safe_url_with_dns("http://93.184.216.34/").await);
        assert!(!is_safe_url_with_dns("http://127.0.0.1:9/").await);
        assert!(!is_safe_url_with_dns("http://localhost:3000/x").await);
        assert!(!is_safe_url_with_dns("http://[::1]/").await);
        assert!(!is_safe_url_with_dns("file:///etc/passwd").await);
    }

    #[test]
    fn scrub_strips_credential_shapes() {
        assert_eq!(
            scrub_query_secrets("compare sk-abcdefghijklmnopqrstuv1234 pricing"),
            "compare pricing"
        );
        assert_eq!(
            scrub_query_secrets(&format!("aws key AKIA{} expired", "A".repeat(16))),
            "aws key expired"
        );
        assert_eq!(
            scrub_query_secrets(&format!("ghp_{} repo", "A".repeat(36))),
            "repo"
        );
        assert_eq!(
            scrub_query_secrets(&format!(
                "github_pat_{}_{} scopes",
                "a".repeat(24),
                "b".repeat(24)
            )),
            "scopes"
        );
        assert_eq!(
            scrub_query_secrets(&format!("xoxb-{} channel", "1".repeat(12))),
            "channel"
        );
        assert_eq!(
            scrub_query_secrets(&format!("AIza{} maps", "A".repeat(35))),
            "maps"
        );
        assert_eq!(
            scrub_query_secrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuvwxyz"),
            ""
        );
    }

    #[test]
    fn scrub_strips_key_value_pairs_and_bearer_case_insensitively() {
        assert_eq!(
            scrub_query_secrets("login with password=hunter2 please"),
            "login with please"
        );
        assert_eq!(scrub_query_secrets("PASSWORD : S3cr3tValue here"), "here");
        assert_eq!(
            scrub_query_secrets("Authorization: Bearer abcdef123456 token"),
            "Authorization: token"
        );
        assert_eq!(scrub_query_secrets("api_key: 1234567890 docs"), "docs");
    }

    #[test]
    fn scrub_leaves_benign_queries_byte_identical() {
        for q in [
            "python 3.11 release notes",
            "React 19 useEffect cleanup tutorial",
            "oauth bearer token flow explained", // "bearer" without a ≥8-char token value
            "AKIAIOSFODNN7EXAMP is a docs placeholder", // 12 chars after AKIA — below the 16-char pattern
            "password strength estimator npm",          // no key:value assignment
        ] {
            assert_eq!(scrub_query_secrets(q), q, "over-scrubbed: {q}");
        }
    }

    #[test]
    fn scrub_collapses_whitespace_and_can_empty() {
        assert_eq!(scrub_query_secrets("sk-abcdefghijklmnopqrstuv1234"), "");
        assert_eq!(
            scrub_query_secrets("use   sk-abcdefghijklmnopqrstuv1234   now"),
            "use now"
        );
        assert_eq!(scrub_query_secrets(""), ""); // `if (!query) return query`
    }

    #[test]
    fn bracketed_ipv6_parsing_pins() {
        // "::ffff:7f00:1" (mapped hex) and "::7f00:1" (compatible) both parse
        // and delegate to the IPv4 classifier; "::" pads to all-zero.
        assert_eq!(parse_ipv6_groups("::ffff:7f00:1").unwrap().len(), 8);
        assert_eq!(parse_ipv6_groups("::").unwrap(), vec![0u32; 8]);
        assert_eq!(parse_ipv6_groups(":::"), None); // two "::"
        assert_eq!(
            parse_ipv6_groups("1:2:3:4:5:6:7:8"),
            Some(vec![1, 2, 3, 4, 5, 6, 7, 8])
        );
        assert_eq!(parse_ipv6_groups("12345::"), None); // >4-hex digit group
                                                        // the dead dotted-quad rewrite (anchored exec ⇒ always-null)
        assert_eq!(parse_ipv6_groups("127.0.0.1"), None);
    }

    #[test]
    fn teredo_obfuscated_client_v4_is_decoded() {
        // 2001:0000:SERVER…:CLIENT with flags g4=0 → client = g5:g6.
        // 2001:0:7f00:1:0:7f00:1:1 → server 127.0.0.1 AND client 127.0.0.1.
        let g = parse_ipv6_groups("2001:0:7f00:1:0:7f00:1:1").unwrap();
        assert!(private_ipv6_groups(&g));
        // Public server+client pair must NOT trip the Teredo branch.
        let g = parse_ipv6_groups("2001:0:0808:0808:0:0808:0808:0808").unwrap();
        assert!(!private_ipv6_groups(&g));
    }
}
