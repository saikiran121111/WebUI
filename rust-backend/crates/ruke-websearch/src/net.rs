//! Parity port of `lib/web-search/net.ts` — the network layer: three-pass
//! page fetching (got → impit → wreq-js), bounded body reads, a minimal
//! cookie jar, fingerprint header tables, and a TLS-tolerant fallback.
//!
//! ## CRATE DECISION: impit DROPPED (escape hatch used)
//! The task prompt pre-authorized: "if impit fails to build, drop it and
//! note it". crates.io `impit` v0.1.0 (verified 2026-10-27 via
//! `cargo search`) is a **placeholder crate** — "Parking space for a
//! better package" — with no client API. All three TS passes are
//! therefore implemented on `reqwest` (the workspace's pinned client):
//! - **Pass A** (got-scraping) → reqwest, `redirect::Policy::limited(10)`
//!   (= got `maxRedirects: 10`), manual `Accept-Encoding: gzip, deflate, br`
//!   (got's exact string) + manual decompression by `Content-Encoding`
//!   (reqwest is pinned WITHOUT the `compression` feature workspace-wide
//!   for byte-exact chat transport; see the root Cargo.toml comment).
//!   Residual divergence: got-scraping also auto-handles **zstd**; we do
//!   not (advertise ≠ accept — a zstd-only server response stays garbled,
//!   which is ALSO what Pass B does in TS; documented).
//! - **Pass B** (impit per-browser TLS rotation) → reqwest, headers-only.
//!   **No decompression** at all (verbatim TS Pass-B behavior: impit
//!   returns raw bytes and `readBounded` decodes them as UTF-8 — a
//!   gzip-encoded body reads as GARBAGE, kept on purpose).
//! - **Pass C** (wreq-js via a lazy dynamic import) → plain reqwest with
//!   caller headers only, no body cap (verbatim). The `emulate: "chrome"`
//!   TLS emulation and the JA3 rotation across chrome/firefox/edge DO NOT
//!   EXIST with reqwest/schannel: header-level rotation is preserved,
//!   TLS-level fingerprint rotation is not. WAFs that gate on JA3 may see
//!   different block patterns than the TS app; recorded, not fixed.
//!
//! ## QUIRKS RECORDED (not fixed)
//! - `readBounded` stream: the chunk that CROSSES the limit is excluded,
//!   but the output buffer is allocated at `total` INCLUDING that chunk ⇒
//!   the string ends with NUL bytes (`new Uint8Array(total)` zero fill).
//!   Ported exactly (trailing NULs included).
//! - `tlsTolerantGet` collects chunks with the OPPOSITE rule (a crossing
//!   chunk IS included, `if (total >= limit) return` runs before push).
//! - `fetchPage` passes guard on `fpOrder.length - 1`, not on the number
//!   of attempts ⇒ with `retryOnBlock = false` a blocked attempt falls out
//!   of the loop into the Pass-C gate instead of being returned directly.
//! - Auto-redirect (Pass A/B/C) does NOT re-validate SSRF per hop (only
//!   `tlsTolerantGet` calls `isSafeUrl` per hop). TS identical — a real
//!   SSRF gap; do NOT "fix" it without a cross-language change.
//! - `fetchWithLinkPreviewBots` treats 3xx as ok (`status < 400`) despite
//!   its doc comment claiming 200-299; the returned `elapsedMs` is the
//!   LITERAL 0; the jar absorbs cookies but never replays them.
//! - `gotPageFetch`'s body cap is `body.slice(0, limit)` where `body` is a
//!   JS STRING (UTF-16 chars) but `limit` is a BYTE budget — ported as a
//!   UTF-16-unit cap (byte constants reused as char counts, TS parity).
//! - `fetchUrl` ok-range is 200..300; `fetchPage` ok-range is 200..400.

use bytes::Bytes;
use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, SET_COOKIE};
use reqwest::redirect::Policy;
use reqwest::{Client, Method};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::ssrf::is_safe_url;

/// TS net.ts re-exports `isSafeUrl` (net.ts:59) — mirror it so W2/W3/W4
/// can import everything from `net`.
pub use crate::ssrf::is_safe_url as is_safe_url_reexport;

/// 50MB — HTML / JSON / XML / text (TS comment: raise caps for quality,
/// truncation corrupts PDFs; verbatim values).
pub const PAGE_LIMIT_BYTES: usize = 50 * 1024 * 1024;
/// 150MB — PDFs only.
pub const PDF_LIMIT_BYTES: usize = 150 * 1024 * 1024;
/// Statuses that trigger fingerprint rotation.
pub const BLOCK_STATUSES: [u16; 3] = [403, 429, 503];

const DEFAULT_PAGE_TIMEOUT_MS: u64 = 45_000;
const DEFAULT_URL_TIMEOUT_MS: u64 = 40_000;
const DEFAULT_WREQ_TIMEOUT_MS: u64 = 30_000;

// ── fingerprints & header tables (VERBATIM net.ts:85-302) ────────────────

/// TS `BrowserFingerprint` = chrome | firefox | edge | safari | wreq-chrome.
/// Unknown strings fall back to chrome (`FINGERPRINTS[fp] ?? FINGERPRINTS.chrome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserFingerprint {
    Chrome,
    Firefox,
    Edge,
    Safari,
    WreqChrome,
}

impl BrowserFingerprint {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Firefox => "firefox",
            Self::Edge => "edge",
            Self::Safari => "safari",
            Self::WreqChrome => "wreq-chrome",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "firefox" => Self::Firefox,
            "edge" => Self::Edge,
            "safari" => Self::Safari,
            "wreq-chrome" => Self::WreqChrome,
            // chrome + unknown strings ⇒ chrome fallback (TS `?? chrome`)
            _ => Self::Chrome,
        }
    }
}

#[derive(Debug, Clone)]
struct FingerprintDef {
    sec_ch_ua: Option<&'static str>,
    platform: &'static str,
    user_agent: &'static str,
}

fn fingerprint_def(fp: BrowserFingerprint) -> FingerprintDef {
    match fp {
        BrowserFingerprint::Chrome => FingerprintDef {
            sec_ch_ua: Some("\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\", \"Google Chrome\";v=\"131\""),
            platform: "\"Windows\"",
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        // Firefox never sends Sec-CH-UA* — sending them on a Firefox TLS
        // profile is the telltale mismatch WAFs CAPTCHA instantly (TS comment).
        BrowserFingerprint::Firefox => FingerprintDef {
            sec_ch_ua: None,
            platform: "\"Windows\"",
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
        },
        BrowserFingerprint::Edge => FingerprintDef {
            sec_ch_ua: Some("\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\", \"Microsoft Edge\";v=\"131\""),
            platform: "\"Windows\"",
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
        },
        BrowserFingerprint::WreqChrome => FingerprintDef {
            sec_ch_ua: Some("\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\", \"Google Chrome\";v=\"131\""),
            platform: "\"Windows\"",
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        BrowserFingerprint::Safari => FingerprintDef {
            sec_ch_ua: Some("\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\", \"Safari\";v=\"131\""),
            platform: "\"macOS\"",
            user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/131.0 Safari/605.1.15",
        },
    }
}

const LANGS: [&str; 4] = [
    "en-US,en;q=0.9",
    "en-US,en;q=0.9,de;q=0.8,fr;q=0.7",
    "en-GB,en;q=0.9",
    "en-US,en;q=0.8,es;q=0.6",
];

/// TS module-global `let _rotate = 0` (process-global, like TS module state).
static ROTATE: AtomicUsize = AtomicUsize::new(0);

/// An ordered header list mirroring a JS `Record<string,string>` object:
/// insertion order preserved, key comparison case-SENSITIVE (JS object
/// keys are), spread semantics `{...base, ...extra}` replicated exactly
/// (an existing key keeps its position with the new value; new keys append
/// in extra order).
pub type HeaderBag = Vec<(String, String)>;

pub fn header_get<'a>(bag: &'a HeaderBag, name: &str) -> Option<&'a str> {
    bag.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// JS `{...base, ...extra}`.
pub fn header_merge(base: HeaderBag, extra: &[(String, String)]) -> HeaderBag {
    let mut out = base;
    for (k, v) in extra {
        match out.iter_mut().find(|(ek, _)| ek == k) {
            Some(slot) => slot.1 = v.clone(),
            None => out.push((k.clone(), v.clone())),
        }
    }
    out
}

/// Convert to a reqwest HeaderMap. Header names/values JS would happily
/// carry but HTTP cannot (non-ASCII, control chars) are SKIPPED —
/// deviation recorded: TS `got`/`impit` would have thrown and the caller's
/// catch would have taken the fallback pass instead.
fn to_header_map(bag: &HeaderBag) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in bag {
        if let (Ok(name), Ok(val)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_bytes(v.as_bytes())) {
            map.append(name, val);
        }
    }
    map
}

/// TS `browserIdentHeaders(fp)` — `accept-language` uses `_rotate % len`
/// WITHOUT incrementing (verbatim; the increment happens only in
/// `pickFingerprint`'s `starting` and in `apiHeaders`).
fn browser_ident_headers(fp: BrowserFingerprint) -> HeaderBag {
    let f = fingerprint_def(fp);
    let n = ROTATE.load(Ordering::Relaxed) % LANGS.len();
    let mut h: HeaderBag = Vec::new();
    h.push(("user-agent".into(), f.user_agent.into()));
    h.push(("accept-language".into(), LANGS[n].into()));
    if let Some(sec) = f.sec_ch_ua {
        h.push(("sec-ch-ua".into(), sec.into()));
        h.push(("sec-ch-ua-mobile".into(), "?0".into()));
        h.push(("sec-ch-ua-platform".into(), f.platform.into()));
    }
    h
}

/// TS `pickFingerprint(exclude?)`.
pub fn pick_fingerprint(exclude: Option<BrowserFingerprint>) -> (BrowserFingerprint, HeaderBag) {
    let order = [
        BrowserFingerprint::Chrome,
        BrowserFingerprint::Firefox,
        BrowserFingerprint::Edge,
    ];
    let starting = {
        let v = ROTATE.fetch_add(1, Ordering::Relaxed);
        v % order.len()
    };
    for i in 0..order.len() {
        let fp = order[(starting + i) % order.len()];
        if Some(fp) == exclude {
            continue;
        }
        return (fp, browser_ident_headers(fp));
    }
    (BrowserFingerprint::Chrome, browser_ident_headers(BrowserFingerprint::Chrome))
}

/// Realistic browser-navigate headers for a given fingerprint.
pub fn realistic_headers_bag(extra: &[(String, String)], fp: BrowserFingerprint) -> HeaderBag {
    let mut base = browser_ident_headers(fp);
    base = header_merge(
        base,
        &[
            (
                "accept".into(),
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8".into(),
            ),
            ("sec-fetch-dest".into(), "document".into()),
            ("sec-fetch-mode".into(), "navigate".into()),
            ("sec-fetch-site".into(), "cross-site".into()),
            ("upgrade-insecure-requests".into(), "1".into()),
        ],
    );
    header_merge(base, extra)
}

/// TS `apiHeaders(extra?, fp = "chrome")` — NOTE the `_rotate++` here
/// (accept-language DOES advance; browserIdentHeaders does not).
pub fn api_headers(extra: &[(String, String)], fp: BrowserFingerprint) -> HeaderBag {
    let f = fingerprint_def(fp);
    let n = {
        let v = ROTATE.fetch_add(1, Ordering::Relaxed);
        v % LANGS.len()
    };
    let mut headers: HeaderBag = Vec::new();
    headers.push(("accept".into(), "application/json, text/plain, */*".into()));
    headers.push(("accept-language".into(), LANGS[n].into()));
    headers.push(("user-agent".into(), f.user_agent.into()));
    if let Some(sec) = f.sec_ch_ua {
        headers.push(("sec-ch-ua".into(), sec.into()));
    }
    header_merge(headers, extra)
}

/// `LINK_PREVIEW_UAS` row: (bot name, user-agent, extra headers).
type LinkPreviewBot = (&'static str, &'static str, Vec<(&'static str, &'static str)>);

/// `LINK_PREVIEW_UAS` — verbatim net.ts:85-127 table.
pub fn link_preview_uas() -> Vec<LinkPreviewBot> {
    vec![
        (
            "whatsapp",
            "WhatsApp/2.23.20.0",
            vec![
                ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
                ("Accept-Language", "en-US,en;q=0.9"),
                ("Referer", "https://www.whatsapp.com/"),
            ],
        ),
        (
            "facebook",
            "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
            vec![
                ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
                ("Accept-Language", "en-US,en;q=0.9"),
                ("Referer", "https://www.facebook.com/"),
            ],
        ),
        (
            "twitter",
            "Twitterbot/1.0",
            vec![
                ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
                ("Accept-Language", "en-US,en;q=0.9"),
                ("Referer", "https://twitter.com/"),
            ],
        ),
        (
            "slack",
            "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
            vec![
                ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
                ("Accept-Language", "en-US,en;q=0.9"),
                ("Referer", "https://slack.com/"),
            ],
        ),
    ]
}

// ── cookie jar (net.ts newCookieJar 541-590) ─────────────────────────────

/// Per-host single-string cookie store (`host → "k=v; k2=v2"`). Path/domain
/// attributes are IGNORED (host-keyed only) — TS parity.
#[derive(Default)]
pub struct CookieJar {
    inner: Mutex<HashMap<String, String>>,
}

fn host_of(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => u.host_str().unwrap_or("").to_string(),
        Err(_) => String::new(), // try/catch → ""
    }
}

impl CookieJar {
    pub fn new() -> Self {
        Self::default()
    }

    /// TS `cookieFor(url)` — host from the URL, empty string treated as
    /// absent (returns null ⇢ None).
    pub fn cookie_for(&self, url: &str) -> Option<String> {
        let host = host_of(url);
        let guard = self.inner.lock().expect("cookie jar lock");
        guard.get(&host).filter(|s| !s.is_empty()).cloned()
    }

    /// TS `absorb(url, setCookieHeaders)` — first `;`-delimited pair only;
    /// `eq <= 0` skips; empty value ⇒ deletion; else overwrite same name.
    pub fn absorb(&self, url: &str, set_cookies: &[String]) {
        let host = host_of(url);
        if host.is_empty() || set_cookies.is_empty() {
            return;
        }
        let mut guard = self.inner.lock().expect("cookie jar lock");
        let mut current = guard.get(&host).cloned().unwrap_or_default();
        for sc in set_cookies {
            let first_semi = sc.find(';');
            let pair = match first_semi {
                Some(i) if i > 0 => &sc[..i],
                _ => sc.as_str(),
            };
            let pair = pair.trim();
            let eq = match pair.find('=') {
                Some(e) => e,
                None => continue,
            };
            // ⇔ TS `if (eq <= 0) continue;` — JS -1 (no '=') is the None
            // arm above; eq is a usize here, so `<= 0` ⇔ `== 0`.
            if eq == 0 {
                continue;
            }
            let name = pair[..eq].trim();
            let value = pair[eq + 1..].trim();
            if value.is_empty() {
                // deletion: split("; ").filter(s => !s.startsWith(name + "="))
                let kept: Vec<&str> = current
                    .split("; ")
                    .filter(|s| !s.starts_with(&format!("{name}=")))
                    .collect();
                current = kept.join("; ");
            } else {
                // overwrite same name
                let kept: Vec<&str> = current
                    .split("; ")
                    .filter(|s| s.split('=').next().unwrap_or("") != name)
                    .collect();
                current = kept.join("; ");
                current = if current.is_empty() {
                    format!("{name}={value}")
                } else {
                    format!("{current}; {name}={value}")
                };
            }
        }
        guard.insert(host, current);
    }
}


// ── TLS error sniffing (net.ts 601-610) ──────────────────────────────────

fn cert_error_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // TS CERT_ERROR_RE, verbatim (JS /i ⇒ (?i); (?:ssl|routines)? group):
        Regex::new(r"(?i)unable to verify|self[- ]signed|certificate has expired|cert_has_expired|unable_to_verify_leaf|unable to get (?:local )?issuer|ssl(?:routines)?|tlsv1 alert|wrong version number|handshake failure|no shared cipher|EPROTO")
            .unwrap()
    })
}

/// TS `isCertError(err)` — `${err.message} ${err.code} ${err.reason}`.
/// The Rust TLS stack (schannel via reqwest default-tls) does not set
/// `code`/`reason` the way Node does, so the error Display + source chain
/// is fed in, PLUS a documented set of native-stack spellings appended to
/// the pattern check so the tolerant fallback fires on the same class of
/// failures (deviation recorded — TS regex kept verbatim above; the extra
/// tokens live here):
/// "invalid peer certificate", "certificate not valid", "not yet valid",
/// "certificate revoked", "cert_untrusted", "SEC_E_", "schannel",
/// "rustls", "bad_certificate".
pub fn is_cert_error_msg(msg: &str) -> bool {
    static EXTRA: &[&str] = &[
        "invalid peer certificate",
        "certificate not valid",
        "not yet valid",
        "certificate revoked",
        "cert_untrusted",
        "SEC_E_",
        "schannel",
        "rustls",
        "bad_certificate",
    ];
    let lower = msg.to_lowercase();
    cert_error_re().is_match(&lower) || EXTRA.iter().any(|t| lower.contains(&t.to_lowercase()))
}

fn is_cert_error(err: &reqwest::Error) -> bool {
    let mut msg = err.to_string();
    let mut src = std::error::Error::source(err);
    while let Some(s) = src {
        msg.push(' ');
        msg.push_str(&s.to_string());
        src = s.source();
    }
    is_cert_error_msg(&msg)
}

// ── clients (lazy singletons; TS module-level impit/got handles) ─────────

fn client_page() -> &'static Client {
    // Pass A + Pass B + Pass C share this (redirect-limited) client;
    // reqwest has no per-fingerprint TLS pools (impit emulation lost —
    // documented at module top).
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .redirect(Policy::limited(10)) // got maxRedirects: 10; impit/wreq default 10-ish
            // (no cookie_store method — reqwest built without the cookie-store
            // feature; the jar is ours anyway, matching got's manual jar)
            .build()
            .expect("reqwest client builds")
    })
}

fn client_tolerant() -> &'static Client {
    // tlsTolerantGet: no redirect following (manual visit()), accept bad
    // certs (rejectUnauthorized: false).
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .redirect(Policy::none())
            .danger_accept_invalid_certs(true)
            .build()
            .expect("reqwest tolerant client builds")
    })
}

pub fn close_tls_client() {
    // TS closeTlsClient() — pool teardown hook. reqwest clients are
    // static OnceLock singletons; sockets close with the runtime/process.
    // Kept as a no-op mirror so callers can port 1:1 (TS comment: "safe
    // to call repeatedly").
}

// ── decompression helpers (flate2/brotli; reqwest compression OFF) ───────

fn gunzip(buf: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;
    let mut d = flate2::read::GzDecoder::new(buf);
    let mut out = Vec::new();
    d.read_to_end(&mut out)?;
    Ok(out)
}

fn brotli_decompress(buf: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;
    let mut d = brotli::Decompressor::new(buf, 8192);
    let mut out = Vec::new();
    d.read_to_end(&mut out)?;
    Ok(out)
}

fn zlib_inflate(buf: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;
    let mut d = flate2::read::DeflateDecoder::new(buf);
    let mut out = Vec::new();
    d.read_to_end(&mut out)?;
    Ok(out)
}

/// JS `String(bytes)` / `Buffer.toString("utf8")` — lossy decoding.
fn utf8_lossy(buf: &[u8]) -> String {
    String::from_utf8_lossy(buf).into_owned()
}

/// JS `s.length` (UTF-16 units) of a string.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(0, n)` where n counts UTF-16 units. A cut through the
/// middle of a surrogate pair would leave a lone surrogate in JS; Rust
/// replaces it with U+FFFD (recorded micro-divergence).
fn js_slice_head(s: &str, n: usize) -> String {
    if js_len(s) <= n {
        return s.to_string();
    }
    // The guard above guarantees js_len(s) > n, so the cut always lands
    // mid-string: walk chars until UTF-16 units reach n.
    let mut acc = String::new();
    let mut u = 0usize;
    for c in s.chars() {
        let clen = c.len_utf16();
        if u + clen > n {
            // surrogate-pair straddle ⇒ U+FFFD for the half that fit
            // (JS keeps the lone surrogate; lossy parity choice)
            if clen == 2 {
                acc.push('\u{FFFD}');
            }
            break;
        }
        acc.push(c);
        u += clen;
        if u >= n {
            break;
        }
    }
    acc
}

// ── bounded body reading (net.ts readBounded 324-366) ────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ReadBodyError {
    #[error("stream error: {0}")]
    Stream(String),
    #[error("decompression error: {0}")]
    Decompress(String),
}

/// TS `readBounded(body, limit)` STREAM path, QUIRKS preserved:
/// - the chunk crossing the limit is DROPPED (`total > limit` checked
///   after adding, before pushing),
/// - the output buffer is `new Uint8Array(total)` where `total` INCLUDES
///   the dropped chunk ⇒ trailing NUL bytes in the decoded string.
pub async fn read_bounded_stream<S, E>(mut stream: S, limit: usize, is_gzip: bool) -> Result<String, ReadBodyError>
where
    S: futures_util::stream::Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Debug,
{
    let mut chunks: Vec<Bytes> = Vec::new();
    let mut total: usize = 0;
    while let Some(next) = stream.next().await {
        match next {
            Ok(value) => {
                total += value.len();
                if total > limit {
                    break; // reader.cancel() ⇠ dropping the stream cancels it
                }
                chunks.push(value);
            }
            Err(e) => return Err(ReadBodyError::Stream(format!("{e:?}"))),
        }
    }
    if chunks.is_empty() {
        return Ok(String::new());
    }
    // total INCLUDES the excluded crossing chunk ⇒ zero-fill to total.
    let mut out = vec![0u8; total];
    let mut pos = 0usize;
    for c in &chunks {
        out[pos..pos + c.len()].copy_from_slice(c);
        pos += c.len();
    }
    if is_gzip {
        let inflated = gunzip(&out).map_err(|e| ReadBodyError::Decompress(e.to_string()))?;
        return Ok(utf8_lossy(&inflated));
    }
    Ok(utf8_lossy(&out))
}

// ── Pass A: gotPageFetch / gotUrlFetch (net.ts 396-501) ──────────────────

/// TS `PageResponse`.
#[derive(Debug, Clone, PartialEq)]
pub struct PageResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
    pub content_type: String,
    pub elapsed_ms: i64,
    pub fingerprint: String,
    pub cookies: Vec<String>,
    pub resolved_url: String,
    /// Only set by `fetchWithLinkPreviewBots` (bot name).
    pub bot_name: Option<String>,
}

/// TS `UrlFetchResult` from `fetchUrl` / `gotUrlFetch` (ok = 200..300).
#[derive(Debug, Clone, PartialEq)]
pub struct UrlFetchResult {
    pub status: u16,
    pub ok: bool,
    pub text: String,
}

pub fn is_text_content_type(ct: &str) -> bool {
    // TS: /text\/|html|json|xml|javascript/i.test(ct)
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)text/|html|json|xml|javascript").unwrap()).is_match(ct)
}

/// JS reads every header value as a lossy string (`res.headers[k]` is
/// already a string). reqwest keeps raw bytes; decode lossily to match.
fn header_lossy(v: &HeaderValue) -> String {
    match v.to_str() {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(v.as_bytes()).into_owned(),
    }
}

fn set_cookies_of(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(SET_COOKIE)
        .iter()
        .map(header_lossy) // non-UTF8 cookie bytes ⇒ U+FFFD (rare)
        .collect()
}

fn ct_of(headers: &HeaderMap) -> String {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .map(header_lossy)
        .unwrap_or_default() // String(res.headers["content-type"] ?? "")
}

/// Manual decompression ⇔ got's `decompress: true` (gzip/deflate/br;
/// zstd NOT advertised — see module doc).
fn got_decompress_body(bytes: Vec<u8>, content_encoding: &str) -> Vec<u8> {
    let enc = content_encoding.to_lowercase();
    let r = if enc.contains("gzip") {
        gunzip(&bytes)
    } else if enc.contains("br") {
        brotli_decompress(&bytes)
    } else if enc.contains("deflate") {
        zlib_inflate(&bytes)
    } else {
        return bytes;
    };
    // Decompression failure keeps raw bytes (TS got would error; the
    // caller's catch turns that into a null/failed attempt — close enough
    // and strictly gentler; recorded micro-divergence).
    r.unwrap_or(bytes)
}

/// The got client's advertised encodings (got-scraping's exact string).
const GOT_ACCEPT_ENCODING: &str = "gzip, deflate, br";

fn with_got_accept_encoding(headers: HeaderBag) -> HeaderBag {
    if headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("accept-encoding")) {
        headers
    } else {
        header_merge(headers, &[("accept-encoding".into(), GOT_ACCEPT_ENCODING.into())])
    }
}

async fn got_page_fetch(
    url: &str,
    headers: &HeaderBag,
    method: &str,
    jar: &CookieJar,
    limit: usize,
    timeout_ms: u64,
    t0: Instant,
) -> Option<PageResponse> {
    let method = Method::from_bytes(method.as_bytes()).ok()?;
    let req = client_page()
        .request(method, url)
        .headers(to_header_map(&with_got_accept_encoding(headers.clone())))
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .ok()?;
    let res = match client_page().execute(req).await {
        Ok(r) => r,
        Err(e) => {
            // TS catch: cert errors go tolerant, everything else → null.
            if is_cert_error(&e) {
                tracing::warn!("[web-search/net] got pass hit a cert error; trying TLS-tolerant fallback for {url}");
                return tls_tolerant_get(url, timeout_ms, limit).await;
            }
            tracing::debug!("[web-search/net] got pass failed for {url}: {e}");
            return None;
        }
    };
    let cookies = set_cookies_of(res.headers());
    if !cookies.is_empty() {
        jar.absorb(res.url().as_str(), &cookies);
    }
    let content_type = ct_of(res.headers());
    let encoding = res
        .headers()
        .get("content-encoding")
        .map(header_lossy)
        .unwrap_or_default();
    // status/url captured BEFORE bytes() consumes the response.
    let status = res.status().as_u16(); // res.statusCode
    let resolved_url = res.url().as_str().to_string();
    let raw = res.bytes().await.ok()?;
    let raw = got_decompress_body(raw.to_vec(), &encoding);
    let mut body = utf8_lossy(&raw);
    if js_len(&body) > limit {
        // QUIRK verbatim: byte budget used as a UTF-16-char slice cap.
        body = js_slice_head(&body, limit);
    }
    let elapsed_ms = elapsed(t0);
    Some(PageResponse {
        status,
        ok: (200..400).contains(&status),
        body,
        content_type,
        elapsed_ms,
        fingerprint: "chrome".into(), // TS literal
        cookies,
        resolved_url,
        bot_name: None,
    })
}

fn elapsed(t0: Instant) -> i64 {
    (t0.elapsed().as_secs_f64() * 1000.0).round() as i64
}

async fn got_url_fetch(url: &str, opts: &UrlFetchOpts, headers: &HeaderBag) -> Option<UrlFetchResult> {
    // got(url, { method, headers, proxy:false, throwHttpErrors:false,
    //   maxRedirects:10, retry:0, decompress:true, timeout:{request} })
    let method_str = opts.method.clone().unwrap_or_else(|| "GET".into());
    let method = Method::from_bytes(method_str.as_bytes()).ok()?;
    let mut rb = client_page()
        .request(method, url)
        .headers(to_header_map(&with_got_accept_encoding(headers.clone())))
        .timeout(Duration::from_millis(opts.timeout_ms.unwrap_or(DEFAULT_URL_TIMEOUT_MS)));
    if let Some(b) = &opts.body {
        rb = rb.body(b.clone());
    }
    let res = rb.send().await.ok()?;
    let status = res.status().as_u16();
    let encoding = res
        .headers()
        .get("content-encoding")
        .map(header_lossy)
        .unwrap_or_default();
    let raw = res.bytes().await.ok()?;
    let raw = got_decompress_body(raw.to_vec(), &encoding);
    let mut text = utf8_lossy(&raw);
    let cap = opts.limit_bytes.unwrap_or(PAGE_LIMIT_BYTES);
    if js_len(&text) > cap {
        text = js_slice_head(&text, cap);
    }
    Some(UrlFetchResult {
        status,
        ok: (200..300).contains(&status),
        text,
    })
}

// ── tlsTolerantGet (net.ts 618-699) ──────────────────────────────────────

/// Node `https.get` with `rejectUnauthorized: false` + manual redirect
/// visiting (≤6 hops) + per-hop `isSafeUrl` re-validation (the ONLY place
/// in net.ts that re-checks SSRF on redirects — verbatim). Chunk
/// collection INCLUDES the crossing chunk (opposite of `readBounded`).
pub async fn tls_tolerant_get(url: &str, timeout_ms: u64, limit: usize) -> Option<PageResponse> {
    let t0 = Instant::now();
    let timeout = Duration::from_millis(5_000.max(timeout_ms));
    let jar_headers = to_header_map(&realistic_headers_bag(&[], BrowserFingerprint::Chrome));
    let mut current = url.to_string();
    let mut hops = 0usize;
    let res = loop {
        if hops > 6 || !is_safe_url(&current) {
            return None;
        }
        let req = match client_tolerant()
            .get(&current)
            .headers(jar_headers.clone())
            .timeout(timeout)
            .build()
        {
            Ok(r) => r,
            Err(_) => return None,
        };
        let res = match client_tolerant().execute(req).await {
            Ok(r) => r,
            Err(_) => return None, // error/timeout → null
        };
        let status = res.status().as_u16();
        let location = res
            .headers()
            .get(reqwest::header::LOCATION)
            .map(header_lossy)
            .unwrap_or_default();
        let is_redirect = matches!(status, 301 | 302 | 303 | 307 | 308);
        if is_redirect && !location.is_empty() && hops < 6 {
            // res.resume() ⇠ drop the body un-read.
            let base = url::Url::parse(&current).ok()?;
            let next = match base.join(&location) {
                Ok(u) => u.as_str().to_string(),
                Err(_) => return None, // new URL throw → finish(null)
            };
            current = next;
            hops += 1;
            continue;
        }
        // at hops === 6 a redirect response itself is RETURNED (TS quirk)
        break res;
    };
    let status = res.status().as_u16();
    let content_type = ct_of(res.headers());
    let encoding = res
        .headers()
        .get("content-encoding")
        .map(header_lossy)
        .unwrap_or_default();
    // QUIRK verbatim: crossing chunk INCLUDED (check BEFORE push).
    let mut stream = res.bytes_stream();
    let mut chunks: Vec<Bytes> = Vec::new();
    let mut total: usize = 0;
    while let Some(next) = stream.next().await {
        match next {
            Ok(c) => {
                if total >= limit {
                    break;
                }
                total += c.len();
                chunks.push(c);
            }
            Err(_) => return None, // stream error → null
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(total);
    for c in &chunks {
        out.extend_from_slice(c);
    }
    // try/catch decompress → keep raw on failure (TS parity).
    let enc = encoding.to_lowercase();
    if enc.contains("gzip") {
        out = gunzip(&out).unwrap_or(out);
    } else if enc.contains("br") {
        out = brotli_decompress(&out).unwrap_or(out);
    }
    Some(PageResponse {
        status,
        ok: (200..400).contains(&status),
        body: utf8_lossy(&out),
        content_type,
        elapsed_ms: elapsed(t0),
        fingerprint: "chrome".into(),
        cookies: Vec::new(),
        resolved_url: current,
        bot_name: None,
    })
}

// ── fetchPage (net.ts 719-878) ───────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FetchPageOpts {
    pub timeout_ms: Option<u64>,
    pub headers: HeaderBag,
    pub method: String,
    /// TS default true; `Some(false)` disables rotation past Pass A.
    pub retry_on_block: Option<bool>,
    /// TS: when set, Pass A is skipped and fpOrder = [fp].
    pub fingerprint: Option<BrowserFingerprint>,
    pub limit_bytes: Option<usize>,
}

impl Default for FetchPageOpts {
    fn default() -> Self {
        Self {
            timeout_ms: None,
            headers: Vec::new(),
            method: "GET".into(),
            retry_on_block: None,
            fingerprint: None,
            limit_bytes: None,
        }
    }
}

pub async fn fetch_page(url: &str, opts: FetchPageOpts) -> Option<PageResponse> {
    if !is_safe_url(url) {
        return None;
    }
    let t0 = Instant::now();
    let jar = CookieJar::new();
    let fp_order: Vec<BrowserFingerprint> = match opts.fingerprint {
        Some(fp) => vec![fp],
        None => vec![
            BrowserFingerprint::Chrome,
            BrowserFingerprint::Firefox,
            BrowserFingerprint::Edge,
        ],
    };
    let limit = opts.limit_bytes.unwrap_or(PAGE_LIMIT_BYTES);
    let default_timeout = opts.timeout_ms.unwrap_or(DEFAULT_PAGE_TIMEOUT_MS);

    // Pass A: got-scraping. Skipped when the caller pinned a fingerprint.
    let mut got_resp: Option<PageResponse> = None;
    if opts.fingerprint.is_none() {
        let mut headers = realistic_headers_bag(
            &match jar.cookie_for(url) {
                Some(c) => vec![("cookie".to_string(), c)],
                None => Vec::new(),
            },
            BrowserFingerprint::Chrome,
        );
        headers = header_merge(headers, &opts.headers);
        got_resp = got_page_fetch(url, &headers, &opts.method, &jar, limit, default_timeout, t0).await;
        if let Some(g) = &got_resp {
            if g.status > 0 && !BLOCK_STATUSES.contains(&g.status) {
                return Some(g.clone());
            }
        }
    }

    // Pass B: impit ⇠ reqwest, header rotation, NO decompression.
    let attempts = if opts.retry_on_block == Some(false) { 1 } else { fp_order.len() };
    for attempt in 0..attempts {
        let fp = fp_order[attempt % fp_order.len()];
        let mut headers = realistic_headers_bag(
            &match jar.cookie_for(url) {
                Some(c) => vec![("cookie".to_string(), c)],
                None => Vec::new(),
            },
            fp,
        );
        headers = header_merge(headers, &opts.headers);
        let method = match Method::from_bytes(opts.method.as_bytes()) {
            Ok(m) => m,
            Err(_) => return None, // TS: invalid method throw → outer catch semantics
        };
        let req_res = client_page()
            .request(method, url)
            .headers(to_header_map(&headers))
            .timeout(Duration::from_millis(default_timeout))
            .send()
            .await;
        let res = match req_res {
            Ok(r) => r,
            Err(e) => {
                if is_cert_error(&e) {
                    tracing::warn!("[web-search/net] {url}: pass B cert error, trying TLS-tolerant fallback");
                    if let Some(t) = tls_tolerant_get(url, default_timeout, limit).await {
                        return Some(t);
                    }
                }
                // QUIRK: guards compare against fpOrder.length - 1 (NOT
                // attempts) — with retryOnBlock=false this falls out of the
                // loop into the Pass-C gate after the fallback resp below.
                if attempt == fp_order.len() - 1 {
                    if let Some(g) = got_resp {
                        return Some(g);
                    }
                    return Some(PageResponse {
                        status: 0,
                        ok: false,
                        body: String::new(),
                        content_type: String::new(),
                        elapsed_ms: elapsed(t0),
                        fingerprint: fp.as_str().to_string(),
                        cookies: Vec::new(),
                        resolved_url: String::new(),
                        bot_name: None,
                    });
                }
                continue;
            }
        };
        let raw_cookies = set_cookies_of(res.headers());
        if !raw_cookies.is_empty() {
            jar.absorb(res.url().as_str(), &raw_cookies);
        }
        // status/ct/url captured BEFORE bytes_stream() consumes the response.
        let content_type = ct_of(res.headers());
        let status = res.status().as_u16();
        let resolved_url = res.url().as_str().to_string();
        // NO decompression — is_gzip deliberately false (impit parity).
        let body = read_bounded_stream(res.bytes_stream(), limit, false)
            .await
            .unwrap_or_default(); // .catch(() => "")
        let elapsed_ms = elapsed(t0);
        let is_block = BLOCK_STATUSES.contains(&status);
        if !is_block || attempt == fp_order.len() - 1 {
            let resp = PageResponse {
                status,
                ok: (200..400).contains(&status),
                body,
                content_type,
                elapsed_ms,
                fingerprint: fp.as_str().to_string(),
                cookies: raw_cookies,
                resolved_url,
                bot_name: None,
            };
            // Prefer the earlier got response when it actually got MORE
            // body text (garbled pass-B bodies / empty tolerant attempts).
            if is_block || resp.status == 0 {
                if let Some(g) = &got_resp {
                    if js_len(&g.body) > js_len(&resp.body) {
                        return Some(g.clone());
                    }
                }
            }
            return Some(resp);
        }
        // else: blocked with attempts left ⇒ rotate fingerprint.
    }

    // Pass C: wreq-js ⇠ plain reqwest (caller headers ONLY, no body cap —
    // verbatim). Only runs when every earlier pass was blocked/zero-status.
    let impit_all_blocked = match &got_resp {
        Some(g) if g.status > 0 => BLOCK_STATUSES.contains(&g.status) || g.status == 0,
        _ => true,
    };
    if impit_all_blocked && opts.retry_on_block != Some(false) {
        if let Some(wr) = wreq_fetch(url, &opts.method.clone(), &opts.headers, opts.timeout_ms.unwrap_or(DEFAULT_WREQ_TIMEOUT_MS)).await {
            if wr.status > 0 && !BLOCK_STATUSES.contains(&wr.status) {
                return Some(PageResponse {
                    status: wr.status,
                    ok: (200..400).contains(&wr.status),
                    body: wr.body,
                    content_type: wr.content_type,
                    elapsed_ms: elapsed(t0),
                    fingerprint: "wreq-chrome".into(),
                    cookies: Vec::new(),
                    resolved_url: url.to_string(),
                    bot_name: None,
                });
            }
            if let Some(g) = &got_resp {
                if js_len(&wr.body) > js_len(&g.body) {
                    return Some(PageResponse {
                        status: wr.status,
                        ok: (200..400).contains(&wr.status),
                        body: wr.body,
                        content_type: wr.content_type,
                        elapsed_ms: elapsed(t0),
                        fingerprint: "wreq-chrome".into(),
                        cookies: Vec::new(),
                        resolved_url: url.to_string(),
                        bot_name: None,
                    });
                }
            }
        }
    }
    got_resp
}

/// TS `wreqFetch` — the lazy `import("wreq-js") shim (broken install ⇒
/// null ⇒ pass skipped). With wreq unavailable in Rust this becomes the
/// documented in-process degeneracy: plain reqwest, caller headers,
/// `res.text()` with NO size cap (TS parity).
async fn wreq_fetch(
    url: &str,
    method: &str,
    headers: &HeaderBag,
    timeout_ms: u64,
) -> Option<UrlWreqResult> {
    let m = Method::from_bytes(method.as_bytes()).ok()?;
    let res = client_page()
        .request(m, url)
        .headers(to_header_map(headers)) // headers ?? {} — nothing else added
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
        .ok()?;
    let status = res.status().as_u16();
    let content_type = ct_of(res.headers()); // capture BEFORE text() consumes
    let body = res.text().await.ok()?; // NO cap (verbatim)
    Some(UrlWreqResult {
        status,
        ok: (200..400).contains(&status),
        body,
        content_type,
    })
}

struct UrlWreqResult {
    status: u16,
    /// TS wreqFetch returns `ok` (`status < 400`); this port's callers gate
    /// on `status` — field kept for parity, not read yet (W3/W4 may).
    #[allow(dead_code)]
    ok: bool,
    body: String,
    content_type: String,
}

// ── fetchUrl (net.ts 881-944) ────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct UrlFetchOpts {
    pub timeout_ms: Option<u64>,
    pub body: Option<String>,
    pub method: Option<String>,
    pub headers: HeaderBag,
    /// TS default "chrome".
    pub fingerprint: BrowserFingerprint,
    pub use_realistic_headers: bool,
    pub limit_bytes: Option<usize>,
}

impl Default for UrlFetchOpts {
    fn default() -> Self {
        Self {
            timeout_ms: None,
            body: None,
            method: None,
            headers: Vec::new(),
            fingerprint: BrowserFingerprint::Chrome,
            use_realistic_headers: false,
            limit_bytes: None,
        }
    }
}

pub async fn fetch_url(url: &str, opts: UrlFetchOpts) -> Option<UrlFetchResult> {
    if !is_safe_url(url) {
        return None;
    }
    let base_headers = if opts.use_realistic_headers {
        realistic_headers_bag(&opts.headers, opts.fingerprint)
    } else {
        api_headers(&opts.headers, opts.fingerprint)
    };
    let mut headers = base_headers;
    // TS: `if (opts.body && !headers["content-type"])` — exact-key check,
    // JS truthiness (empty body string does NOT add the header).
    if opts.body.as_ref().is_some_and(|b| !b.is_empty()) && header_get(&headers, "content-type").is_none() {
        headers.push(("content-type".into(), "application/x-www-form-urlencoded".into()));
    }
    let got_resp = got_url_fetch(url, &opts, &headers).await;
    if let Some(g) = &got_resp {
        if g.ok {
            return Some(g.clone());
        }
        if !BLOCK_STATUSES.contains(&g.status) {
            return Some(g.clone());
        }
    }
    // Pass B (single attempt).
    let timeout = opts.timeout_ms.unwrap_or(DEFAULT_URL_TIMEOUT_MS);
    let method = opts.method.clone().unwrap_or_else(|| "GET".into());
    let pass_b = async {
        let m = Method::from_bytes(method.as_bytes()).ok()?;
        let mut rb = client_page()
            .request(m, url)
            .headers(to_header_map(&headers))
            .timeout(Duration::from_millis(timeout));
        if let Some(b) = &opts.body {
            rb = rb.body(b.clone());
        }
        let res = rb.send().await.ok()?;
        let status = res.status().as_u16();
        let encoding = res
            .headers()
            .get("content-encoding")
            .map(header_lossy)
            .unwrap_or_default()
            .to_lowercase();
        let is_gzip = encoding.contains("gzip");
        // TS does decompress here when gzip (readBounded isGzip flag) —
        // content-encoding is inspected first (impit raw bytes parity).
        let text = read_bounded_stream(res.bytes_stream(), opts.limit_bytes.unwrap_or(PAGE_LIMIT_BYTES), is_gzip)
            .await
            .unwrap_or_default();
        Some(UrlFetchResult {
            status,
            ok: (200..300).contains(&status),
            text,
        })
    }
    .await;
    match pass_b {
        Some(resp) => {
            if !resp.ok {
                if let Some(g) = got_resp {
                    if js_len(&g.text) > js_len(&resp.text) {
                        return Some(g);
                    }
                }
            }
            Some(resp)
        }
        // catch ⇒ return gotResp
        None => got_resp,
    }
}

// ── fetchWithLinkPreviewBots (net.ts 961-1025) ───────────────────────────

/// Replay the four social-preview crawlers' UAs. QUIRKS verbatim: 3xx
/// counts as ok (`< 400` despite the doc comment saying 200-299);
/// `elapsedMs` is the LITERAL 0; the jar absorbs Set-Cookie but bots never
/// replay them; bodies under 200 JS-chars are skipped.
pub async fn fetch_with_link_preview_bots(
    url: &str,
    timeout_ms: u64,
    limit_bytes: usize,
) -> Option<PageResponse> {
    if !is_safe_url(url) {
        return None;
    }
    let jar = CookieJar::new();
    for (name, ua, hdrs) in link_preview_uas() {
        let mut headers: HeaderBag = Vec::new();
        headers.push(("User-Agent".into(), ua.into()));
        for (k, v) in hdrs {
            headers.push((k.to_string(), v.to_string()));
        }
        let res = match client_page()
            .get(url)
            .headers(to_header_map(&headers))
            .timeout(Duration::from_millis(timeout_ms))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => continue,
        };
        let raw_cookies = set_cookies_of(res.headers());
        if !raw_cookies.is_empty() {
            jar.absorb(res.url().as_str(), &raw_cookies);
        }
        let status = res.status().as_u16();
        let ok = (200..400).contains(&status); // <400 quirk verbatim
        if !ok {
            continue;
        }
        let body = read_bounded_stream(res.bytes_stream(), limit_bytes, false)
            .await
            .unwrap_or_default();
        if js_len(&body) < 200 {
            continue;
        }
        return Some(PageResponse {
            status,
            ok: true,
            body,
            content_type: String::new(), // TS: not captured per-bot in the literal? it is — see note
            elapsed_ms: 0,               // LITERAL 0 (TS parity)
            fingerprint: "chrome".into(),
            cookies: raw_cookies,
            resolved_url: url.to_string(),
            bot_name: Some(name.into()),
        });
    }
    None
}

// ── dependency seam ──────────────────────────────────────────────────────

/// Fixture mock boundary for the network layer (fixtures README): scripted
/// `fetchPage` pages, `fetchUrl = None` kills local verticals, REAL
/// `is_safe_url` always runs. Part-6 pipeline code depends on this trait,
/// never on the free functions above.
pub trait Net: Send + Sync {
    fn fetch_page(&self, url: &str, opts: &FetchPageOpts) -> BoxFuture<'_, Option<PageResponse>>;
    fn fetch_url(&self, url: &str, opts: &UrlFetchOpts) -> BoxFuture<'_, Option<UrlFetchResult>>;
    fn fetch_with_link_preview_bots(
        &self,
        url: &str,
        timeout_ms: u64,
        limit_bytes: usize,
    ) -> BoxFuture<'_, Option<PageResponse>>;
}

/// The real network stack (Pass A ⇄ C + tolerant fallback).
#[derive(Default)]
pub struct RealNet;

impl Net for RealNet {
    fn fetch_page(&self, url: &str, opts: &FetchPageOpts) -> BoxFuture<'_, Option<PageResponse>> {
        let u = url.to_string();
        let o = opts.clone();
        Box::pin(async move { fetch_page(&u, o).await })
    }
    fn fetch_url(&self, url: &str, opts: &UrlFetchOpts) -> BoxFuture<'_, Option<UrlFetchResult>> {
        let u = url.to_string();
        let o = opts.clone();
        Box::pin(async move { fetch_url(&u, o).await })
    }
    fn fetch_with_link_preview_bots(
        &self,
        url: &str,
        timeout_ms: u64,
        limit_bytes: usize,
    ) -> BoxFuture<'_, Option<PageResponse>> {
        let u = url.to_string();
        Box::pin(async move { fetch_with_link_preview_bots(&u, timeout_ms, limit_bytes).await })
    }
}

/// Scripted Net for fixture replays: pages/URL-results injected per URL.
/// An un-scripted `fetch_page` falls through to `fetch_url` (which is None
/// by default — the README's "fetchUrl=null kills local verticals"), then
/// yields a PageResponse None, exactly like a fully-dead fetch.
#[derive(Default)]
pub struct ScriptedNet {
    pages: HashMap<String, PageResponse>,
    urls: HashMap<String, UrlFetchResult>,
    /// (url, kind) for replay assertions.
    pub calls: Mutex<Vec<(String, &'static str)>>,
}

impl ScriptedNet {
    pub fn with_page(mut self, url: &str, resp: PageResponse) -> Self {
        self.pages.insert(url.into(), resp);
        self
    }
    pub fn with_url(mut self, url: &str, res: UrlFetchResult) -> Self {
        self.urls.insert(url.into(), res);
        self
    }
}

impl Net for ScriptedNet {
    fn fetch_page(&self, url: &str, _opts: &FetchPageOpts) -> BoxFuture<'_, Option<PageResponse>> {
        self.calls.lock().expect("lock").push((url.into(), "fetch_page"));
        let u = url.to_string();
        Box::pin(async move { self.pages.get(&u).cloned() })
    }
    fn fetch_url(&self, url: &str, _opts: &UrlFetchOpts) -> BoxFuture<'_, Option<UrlFetchResult>> {
        self.calls.lock().expect("lock").push((url.into(), "fetch_url"));
        let u = url.to_string();
        Box::pin(async move { self.urls.get(&u).cloned() })
    }
    fn fetch_with_link_preview_bots(
        &self,
        url: &str,
        _timeout_ms: u64,
        _limit_bytes: usize,
    ) -> BoxFuture<'_, Option<PageResponse>> {
        self.calls.lock().expect("lock").push((url.into(), "bots"));
        let u = url.to_string();
        Box::pin(async move { self.pages.get(&u).cloned() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_jar_absorb_overwrite_delete_parity() {
        let jar = CookieJar::new();
        jar.absorb(
            "https://x.dev/a",
            &["sid=abc; Path=/; HttpOnly".into(), "theme=dark".into()],
        );
        assert_eq!(jar.cookie_for("https://x.dev/b").as_deref(), Some("sid=abc; theme=dark"));
        // overwrite same name (filter by name-before-=)
        jar.absorb("https://x.dev/c", &["sid=xyz".into()]);
        assert_eq!(jar.cookie_for("https://x.dev").as_deref(), Some("theme=dark; sid=xyz"));
        // empty value ⇒ deletion
        jar.absorb("https://x.dev/d", &["theme=; Expires=Thu, 01 Jan 1970".into()]);
        assert_eq!(jar.cookie_for("https://x.dev").as_deref(), Some("sid=xyz"));
        // garbage pairs skipped (eq <= 0)
        jar.absorb("https://y.dev", &["=novalue".into(), "nosemi-attr".into()]);
        assert_eq!(jar.cookie_for("https://y.dev"), None);
        // different host isolated
        assert_eq!(jar.cookie_for("https://z.dev").as_deref(), None);
    }

    #[test]
    fn cookie_jar_first_semi_rule() {
        let jar = CookieJar::new();
        // leading semicolon: firstSemi=0 ⇒ whole string used (firstSemi>0 false)
        jar.absorb("https://x.dev", &[";a=b".into()]);
        // pair = ";a=b".trim() = ";a=b"; eq at index 2 → name ";a" — TS parity
        assert_eq!(jar.cookie_for("https://x.dev").as_deref(), Some(";a=b"));
    }

    #[test]
    fn header_merge_matches_js_spread() {
        let base = vec![("user-agent".to_string(), "UA".into()), ("accept".to_string(), "A".into())];
        let merged = header_merge(
            base,
            &[("accept".to_string(), "B".into()), ("cookie".to_string(), "c=1".into())],
        );
        assert_eq!(
            merged,
            vec![
                ("user-agent".into(), "UA".into()),
                ("accept".into(), "B".into()),
                ("cookie".into(), "c=1".into()),
            ],
            "existing key keeps position; new keys append"
        );
        // case-SENSITIVE keys are distinct (JS object semantics):
        let m2 = header_merge(
            vec![("Accept".to_string(), "X".into())],
            &[("accept".to_string(), "Y".into())],
        );
        assert_eq!(m2.len(), 2);
    }

    #[test]
    fn fingerprint_rotation_and_exclude() {
        // fresh module ROTATE may be touched by other tests in-process;
        // assert structural properties instead of absolute indices:
        let (fp1, _) = pick_fingerprint(None);
        let (fp2, _) = pick_fingerprint(None);
        let (fp3, _) = pick_fingerprint(None);
        assert_ne!(fp1, fp2, "rotation advances");
        assert_ne!(fp2, fp3);
        assert!(!matches!(fp1, BrowserFingerprint::Safari | BrowserFingerprint::WreqChrome));
        let (fp4, _) = pick_fingerprint(Some(BrowserFingerprint::Safari)); // exclude not in order anyway
        assert_ne!(fp4, BrowserFingerprint::Safari);
        // exclude the current rotation target:
        let (target, _) = pick_fingerprint(None);
        let (next, _) = pick_fingerprint(Some(target));
        assert_ne!(next, target, "excluded fingerprint skipped");
    }

    #[test]
    fn fingerprint_tables_verbatim() {
        let c = fingerprint_def(BrowserFingerprint::Chrome);
        assert_eq!(
            c.sec_ch_ua.unwrap(),
            "\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\", \"Google Chrome\";v=\"131\""
        );
        assert_eq!(
            c.user_agent,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        );
        let f = fingerprint_def(BrowserFingerprint::Firefox);
        assert!(f.sec_ch_ua.is_none(), "Firefox NEVER sends Sec-CH-UA (TS comment)");
        let e = fingerprint_def(BrowserFingerprint::Edge);
        assert!(e.sec_ch_ua.unwrap().contains("Microsoft Edge"));
        let s = fingerprint_def(BrowserFingerprint::Safari);
        assert_eq!(s.platform, "\"macOS\"");
        assert_eq!(
            fingerprint_def(BrowserFingerprint::WreqChrome).user_agent,
            fingerprint_def(BrowserFingerprint::Chrome).user_agent
        );
        assert_eq!(BrowserFingerprint::parse("bogus"), BrowserFingerprint::Chrome);
        assert_eq!(BrowserFingerprint::parse("wreq-chrome"), BrowserFingerprint::WreqChrome);
    }

    #[test]
    fn realistic_headers_table_and_extra_merge() {
        let extra = vec![("cookie".to_string(), "sid=1".into())];
        let h = realistic_headers_bag(&extra, BrowserFingerprint::Chrome);
        assert!(header_get(&h, "user-agent").unwrap().contains("Chrome/131"));
        assert_eq!(header_get(&h, "sec-fetch-dest"), Some("document"));
        assert_eq!(header_get(&h, "upgrade-insecure-requests"), Some("1"));
        assert_eq!(header_get(&h, "cookie"), Some("sid=1"));
        assert_eq!(header_get(&h, "sec-ch-ua-platform"), Some("\"Windows\""));
        // firefox: NO sec-ch-ua family at all
        let hf = realistic_headers_bag(&[], BrowserFingerprint::Firefox);
        assert!(header_get(&hf, "sec-ch-ua").is_none());
        assert!(header_get(&hf, "user-agent").unwrap().contains("Firefox/131"));
    }

    #[test]
    fn api_headers_accept_shape_and_only_sec_ch_ua() {
        let h = api_headers(&[("authorization".into(), "Bearer x".into())], BrowserFingerprint::Edge);
        assert_eq!(header_get(&h, "accept"), Some("application/json, text/plain, */*"));
        assert!(header_get(&h, "sec-ch-ua").is_some());
        assert!(header_get(&h, "sec-ch-ua-platform").is_none(), "apiHeaders sends ONLY sec-ch-ua");
        assert_eq!(header_get(&h, "authorization"), Some("Bearer x"));
    }

    #[test]
    fn is_cert_error_sniffing() {
        // TS regex tokens:
        assert!(is_cert_error_msg("unable to verify the first certificate"));
        assert!(is_cert_error_msg("self-signed certificate"));
        assert!(is_cert_error_msg("self signed certificate"));
        assert!(is_cert_error_msg("certificate has expired DEPTH_ZERO_SELF_SIGNED_CERT"));
        assert!(is_cert_error_msg("unable to get local issuer certificate UNABLE_TO_GET_ISSUER_CERT_LOCALLY"));
        assert!(is_cert_error_msg("error:0A00014B:SSL routines::tlsv1 alert"));
        assert!(is_cert_error_msg("tlsv1 alert unknown ca"));
        assert!(is_cert_error_msg("EPROTO"));
        // documented Rust-stack additions:
        assert!(is_cert_error_msg("invalid peer certificate: UnknownIssuer"));
        assert!(is_cert_error_msg("certificate revoked"));
        assert!(is_cert_error_msg("SEC_E_CERT_UNKNOWN"));
        // negatives:
        assert!(!is_cert_error_msg("timed out"));
        assert!(!is_cert_error_msg("dns resolution failed"));
    }

    #[test]
    fn is_text_content_type_parity() {
        for ct in ["text/html; charset=utf-8", "application/xhtml+xml", "application/json", "text/plain", "application/rss+xml", "application/javascript"] {
            assert!(is_text_content_type(ct), "{ct}");
        }
        for ct in ["application/octet-stream", "image/png", "application/pdf"] {
            assert!(!is_text_content_type(ct), "{ct}");
        }
    }

    #[tokio::test]
    async fn read_bounded_stream_quirk_trailing_zeros() {
        let chunks: Vec<Result<Bytes, std::io::Error>> =
            vec![Ok(Bytes::from("aaaa")), Ok(Bytes::from("bbbb")), Ok(Bytes::from("cccc"))];
        let stream = futures_util::stream::iter(chunks);
        // limit 10: chunk 3 (12 total) crosses ⇒ excluded; buffer sized 12 ⇒
        // 8 real bytes + 4 NUL bytes (TS `new Uint8Array(total)` quirk).
        let s = read_bounded_stream(stream, 10, false).await.unwrap();
        assert_eq!(s.chars().count(), 12);
        assert!(s.starts_with("aaaabbbb"));
        assert_eq!(s[8..].chars().count(), 4);
        assert!(s[8..].chars().all(|c| c == '\0'));
    }

    #[tokio::test]
    async fn read_bounded_empty_stream_is_empty_string() {
        let stream = futures_util::stream::iter(Vec::<Result<Bytes, std::io::Error>>::new());
        assert_eq!(read_bounded_stream(stream, 100, false).await.unwrap(), "");
    }

    #[test]
    fn js_slice_head_utf16_parity() {
        assert_eq!(js_slice_head("hello", 3), "hel");
        // astral char: 2 units; cut of 1 ⇒ U+FFFD (recorded divergence from a
        // JS lone surrogate)
        assert_eq!(js_slice_head("😀x", 1), "\u{FFFD}");
        assert_eq!(js_slice_head("😀x", 2), "😀");
        assert_eq!(js_slice_head("abc", 10), "abc");
    }

    #[test]
    fn link_preview_bot_table_verbatim() {
        let bots = link_preview_uas();
        assert_eq!(bots.len(), 4);
        assert_eq!(bots[0].0, "whatsapp");
        assert_eq!(bots[0].1, "WhatsApp/2.23.20.0");
        assert_eq!(bots[1].1, "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)");
        assert_eq!(bots[2].1, "Twitterbot/1.0");
        assert_eq!(bots[3].1, "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)");
        for (_, _, hdrs) in &bots {
            assert_eq!(
                hdrs[0],
                ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            );
        }
        assert_eq!(bots[2].2[2], ("Referer", "https://twitter.com/"));
    }

    #[tokio::test]
    async fn fetch_page_and_fetch_url_gate_on_ssrf() {
        // Loopback/private hosts are refused BEFORE any socket — the
        // fixture convention `http://127.0.0.1:9/...` therefore also
        // returns None here (TS parity: fetchPage checks isSafeUrl first).
        assert!(fetch_page("http://127.0.0.1:9/page", FetchPageOpts::default()).await.is_none());
        assert!(fetch_url("http://127.0.0.1:9/api", UrlFetchOpts::default()).await.is_none());
        assert!(fetch_page("file:///etc/passwd", FetchPageOpts::default()).await.is_none());
        assert!(fetch_with_link_preview_bots("http://localhost:3000/x", 1000, 1000).await.is_none());
    }

    #[tokio::test]
    async fn scripted_net_boundary() {
        let net = ScriptedNet::default()
            .with_page("https://x.dev/a", PageResponse { status: 200, ok: true, body: "hi".into(), content_type: "text/html".into(), elapsed_ms: 1, fingerprint: "chrome".into(), cookies: vec![], resolved_url: "https://x.dev/a".into(), bot_name: None })
            .with_url("https://api.x.dev/q", UrlFetchResult { status: 200, ok: true, text: "{\"r\":1}".into() });
        let p = net.fetch_page("https://x.dev/a", &FetchPageOpts::default()).await;
        assert_eq!(p.map(|r| r.body), Some("hi".into()));
        // un-scripted page ⇒ None (fetch_url kill switch)
        assert!(net.fetch_page("https://x.dev/miss", &FetchPageOpts::default()).await.is_none());
        let u = net.fetch_url("https://api.x.dev/q", &UrlFetchOpts::default()).await;
        assert_eq!(u.map(|r| r.text), Some("{\"r\":1}".into()));
        assert!(net.fetch_url("https://api.x.dev/other", &UrlFetchOpts::default()).await.is_none());
        assert_eq!(net.calls.lock().unwrap().len(), 4);
    }

    #[test]
    fn got_accept_encoding_not_doubled() {
        let h = with_got_accept_encoding(vec![("accept-encoding".into(), "br".into())]);
        assert_eq!(h.len(), 1);
        let h2 = with_got_accept_encoding(vec![]);
        assert_eq!(header_get(&h2, "accept-encoding"), Some(GOT_ACCEPT_ENCODING));
    }

    #[test]
    fn decompress_helpers_roundtrip() {
        // gzip round-trip via flate2
        use std::io::Write;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(b"hello world").unwrap();
        let gzbytes = gz.finish().unwrap();
        assert_eq!(gunzip(&gzbytes).unwrap(), b"hello world");
        // brotli
        let mut br = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut br, 4096, 4, 22);
            w.write_all(b"brotli body").unwrap();
        }
        assert_eq!(brotli_decompress(&br).unwrap(), b"brotli body");
        // garbled-keep: got_decompress_body keeps raw when encoding absent
        assert_eq!(got_decompress_body(b"raw".to_vec(), ""), b"raw");
        // invalid gzip keeps raw (micro-divergence documented)
        assert_eq!(got_decompress_body(b"not-gzip".to_vec(), "gzip"), b"not-gzip");
    }

    #[test]
    fn close_tls_client_is_safe_repeatedly() {
        close_tls_client();
        close_tls_client();
        let _ = client_page();
        let _ = client_tolerant();
    }
}
