//! OWNER: W3 — parity port of `lib/web-search/extractor.ts` (the extraction
//! half of the pipeline: 7-tier anti-bot cascade + classification tail).
//!
//! The TS oracle is adjudication truth for every threshold, gate order,
//! reason string and classification label below. Note the TS header's tier
//! numbering is aspirational; the CODE's actual cascade (what is ported) is:
//!   baseline → Tier0 cache → Tier1.5 adapter → Tier1 direct →
//!   Tier2 link-preview → Browser tier → Jina → Wayback → snippet tail →
//!   Tier6 triangulation → classification.
//!
//! ## QUIRKS (kept verbatim)
//! - `head.includes("Just a moment")` / `"Checking your browser"` /
//!   `"Sign in to LinkedIn"` match MIXED CASE against the LOWER-CASED
//!   first 4 KB — in JS those three signature conjuncts can NEVER be true
//!   (TS bug). Ported with the same mixed-case literals, same deadness.
//! - `detectBlock(page.body, …)` is called BEFORE the block-gate ordering
//!   check of `!page.ok || body < 200` runs AFTER charset normalization —
//!   and in extractDirect the normalized `html` variable is assigned but
//!   NEVER USED (every later call re-reads `page.body`). Ported as `_html`
//!   (computed, dropped) — observable behavior identical.
//! - `status === 999` returns "HTTP 999 (LinkedIn-style auth redirect)"
//!   before the signature table, making the LinkedIn table entry's own
//!   `status === 999` conjunct unreachable. Order preserved.
//! - `stripWafChallengeText`: match indices are computed on the ORIGINAL
//!   text but `cleaned.slice(0,start)+" "+cleaned.slice(end)` applies them
//!   to the ALREADY-MUTATED `cleaned` — after the first cut every later
//!   cut lands at the wrong place. Faithfully reproduced (indices stay
//!   original-text UTF-16 offsets applied to the shrinking buffer).
//! - `bodyPlainLen` collapses tags but NOT whitespace (`trim()` only) —
//!   no `\s+`→" " like the fallback path. Kept.
//! - extractLinkPreview's raw-text fallback has NO 12 000-char slice cap
//!   (unlike extractDirect's), and the Wayback markdown has NO cap either.
//! - Tier4 `snippet = result.snippet || result.title || ""` keeps the
//!   snippet WITHOUT `.trim()` (the serp-baseline trims, Tier4 does not).
//! - Wayback success sets `packet.extraction = "jina-fallback"` (label
//!   REUSE bug in TS) while classifying SUCCESS_WAYBACK and caching under
//!   the "wayback" tier. Kept.
//! - `SUCCESS_BROWSER` is emitted by the code but absent from the file
//!   header's classification list — code is truth; emitted as-is.
//! - extractDirect `detectBlockInText(page.body)` on Wayback — the block
//!   text gate runs on the RAW snapshot HTML, not extracted markdown. Kept.
//! - putCachedPage's ≥200-char signal guard lives inside cache.ts (ported
//!   in cache.rs), not here — the extractor calls it unconditionally on
//!   every successful tier exactly like TS.
//!
//! ## RECORDED MICRO-DIVERGENCES
//! - TS reads WEB_SEARCH_CONCURRENCY / WEB_SEARCH_JINA_CONCURRENCY once at
//!   module load; Rust reads them per extract_all() call (first use for
//!   Jina). Invalid values: TS `Math.max(4, NaN)` = NaN makes pLimit throw
//!   at IMPORT time (hard app crash); Rust falls back to the default
//!   instead — reproducing a module-load crash has no Rust analog.
//! - TS `pLimit(n)` is strictly FIFO; Rust uses tokio Semaphore which is
//!   documented-fair (FIFO waiter order) — behaviorally equivalent for
//!   this use (all work submitted up-front).
//! - The Jina limiter is a process-global `OnceLock<Semaphore>` created on
//!   first use (TS creates `jinaLimit` at module load).
//! - extractAll: TS `Promise.all` rejects with whichever task rejects
//!   FIRST in time; Rust propagates the FIRST `Err` in index order. Cache
//!   throws (the only throw source) are synchronous-ish in TS, so this is
//!   only observable under genuine nondeterminism.
//! - JS string slicing can split a surrogate pair leaving a lone half;
//!   Rust replaces it with U+FFFD via `from_utf16_lossy` (crate-wide
//!   precedent, net.rs/youtube.rs). UTF-16 unit COUNTS stay equal, so all
//!   `.length` parity gates are unaffected; only the replacement char
//!   differs on a split boundary.
//! - JS `\s` includes U+FEFF (Rust Unicode `\s` / `trim()` do not). All
//!   whitespace-collapse/trim sites are otherwise identical.
//! - Wayback availability/CDX JSON: non-STRING snapshot fields (numbers)
//!   are treated as absent (JS would coerce into the URL template and then
//!   fail the later fetch, ending at the same "no snapshot" outcome).
//! - `page.botName` is typed `string` in TS but `Option<String>` in the
//!   Rust PageResponse seam; `None` formats as `""` (only ScriptedNet
//!   pages can leave it unset).
//! - `browser pool error: ` catch formats `e?.message ?? String(e)`; the
//!   bridge seam's `Err(String)` already carries the message, so Rust
//!   appends it directly.
//!
//! Tier-3b note: the browser tier calls the [`BrowserBridge`] seam
//! (`browser_bridge.rs`) — production ships [`NoBrowserBridge`] until the
//! Next route lands with the Part-6 pipeline step, reproducing the TS
//! pool-kill-switch tier exactly. No Playwright in this crate, ever.

use futures_util::future::join_all;
use regex::Regex;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Semaphore;

use crate::browser_bridge::BrowserBridge;
use crate::cache::{CacheError, PageTier, SearchCache};
use crate::charset_normalizer::{detect_charset, normalize_body};
use crate::hydration_unpacker::{unpack_hydration, walk_generic_json_for_entities, WalkerOptions};
use crate::metasearch::{slug_triangulation, url_search_fallback};
use crate::net::{BrowserFingerprint, FetchPageOpts, Net, UrlFetchOpts, PAGE_LIMIT_BYTES};
use crate::platform_api::{platform_adapter, Verticals};
use crate::schema_extract::{schema_extract, schema_extract_from_blocks};
use crate::types::{EvidencePacket, EvidencePassage, ExtractionKind, RankedResult};
use crate::universal_extractor::{
    detect_mode, extract_document_sync, structural_extract, ExtractionMode,
};

// Per-tier timeouts (extractor.ts lines 71–75). PDF_DOWNLOAD_TIMEOUT_MS is
// declared in TS but NEVER referenced in-file (dead) — not ported as a
// Rust const (dead_code lint); noted here for parity instead.
const TIER1_TIMEOUT_MS: u64 = 45_000;
const LINK_PREVIEW_TIMEOUT_MS: u64 = 45_000;
const JINA_TIMEOUT_MS: u64 = 45_000;
const WAYBACK_TIMEOUT_MS: u64 = 45_000;

// APPROVED PART-10 PARITY DEVIATION (MIGRATION-MAP §11.3) — TOTAL per-page
// wall-clock budget. Every timeout above is PER REQUEST, not per PAGE: one
// dead/unreachable host stacks tier1 + link-preview bots + Jina + Wayback
// (avail + CDX + snapshot) sequentially into minutes. Live evidence
// (2026-10-28): ONE of ten pages held `join_all` — and with it the whole
// evidence stream and the client's search-toggle UI — for 3m51s. The budget
// abandons the cascade at the cap and folds the page into the SAME snippet
// baseline terminal packet `extract_url` already produces when the cascade
// legitimately fails, so one slow site can never hold the other nine (or
// the user) hostage. Golden fixture replays are in-process and instant, so
// the timer never fires there — fixtures stay byte-identical. Mirrored in
// extractor.ts (same default, same fallback shape, classification
// "PAGE_BUDGET_TIMEOUT" never appears elsewhere).
const PAGE_BUDGET_DEFAULT_MS: u64 = 60_000;

// Concurrency env knobs (extractor.ts 85–100): Math.max(min, parseInt(…)).
const ENV_EXTRACTION_CONCURRENCY: &str = "WEB_SEARCH_CONCURRENCY";
const ENV_JINA_CONCURRENCY: &str = "WEB_SEARCH_JINA_CONCURRENCY";

// ── JS-semantics helpers (module-local crate convention) ───────────────

/// JS `String.length` = UTF-16 code units.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(0, n)` on UTF-16 units (lone-surrogate boundary → U+FFFD).
fn js_slice_head(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// JS `s.slice(from)` on UTF-16 units.
fn js_slice_from(s: &str, from: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().skip(from).collect();
    String::from_utf16_lossy(&units)
}

/// JS `encodeURI` — keeps the reserved+unreserved set
/// `A-Za-z0-9 ; / ? : @ & = + $ , # - _ . ! ~ * ' ( )`, %XX-encodes the
/// rest of the UTF-8 bytes. (Jina tier builds its URL with encodeURI, NOT
/// encodeURIComponent — a port bug here would double-encode `:/?&`.)
fn js_encode_uri(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b';' | b'/' | b'?' | b':' | b'@'
            | b'&' | b'=' | b'+' | b'$' | b',' | b'#' | b'-' | b'_' | b'.' | b'!' | b'~'
            | b'*' | b'\'' | b'(' | b')' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// JS `encodeURIComponent` (bytes outside `A-Za-z0-9-_.!~*'()` → %XX).
fn js_encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// JS `parseInt(v, 10)`: leading whitespace, optional sign, digit run
/// only (stops at the first non-digit); empty/no-digits → None (= NaN).
fn js_parse_int(v: &str) -> Option<i64> {
    let t = v.trim_start_matches(char::is_whitespace);
    let (sign, rest) = match t.strip_prefix('-') {
        Some(r) => (-1i64, r),
        None => (1i64, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<i64>().ok().map(|n| sign * n)
}

/// TS `Math.max(min, parseInt(process.env[k] ?? default, 10))` with the
/// NaN→default fallback recorded above (TS would crash at module load).
fn env_concurrency(key: &str, default: &str, min: usize) -> usize {
    let raw = std::env::var(key).unwrap_or_else(|_| default.to_string());
    let raw = if raw.is_empty() { default } else { &raw };
    match js_parse_int(raw) {
        Some(n) if n > min as i64 => n as usize,
        _ => min,
    }
}

// ── Lazy regex statics (crate regex_static pattern) ────────────────────

fn regex_static(slot: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    slot.get_or_init(|| Regex::new(pat).expect("static regex compiles"))
}

macro_rules! re {
    ($name:ident, $pat:expr) => {
        fn $name() -> &'static Regex {
            static SLOT: OnceLock<Regex> = OnceLock::new();
            regex_static(&SLOT, $pat)
        }
    };
}

re!(re_html_ct, r"(?i)text/html|application/xhtml");
re!(re_tag, r"<[^>]+>");
re!(re_ws_run, r"\s+");
re!(re_ws3, r"\s{3,}");
re!(
    re_waf_boilerplate,
    r"(?i)checking your browser|just a moment|please enable javascript and cookies|verify you are human|i'm not a robot|are you a robot|enable cookies to continue|cf-chl|cf-turnstile|turnstile|please wait|verifying connection|access to this page has been limited|you are being redirected"
);
re!(re_login_wall1, r"(?i)sign in to (linkedin|facebook|instagram|twitter|x|youtube)");
re!(re_login_wall2, r"(?i)log (in|sign in) to (continue|begin)");
re!(re_login_wall3, r"(?i)please (log in|sign in|create an account) (to|and)");
re!(re_login_wall4, r"(?i)your session has expired");
re!(re_og_meta, r"^(og:|twitter:)");
re!(re_class_login, r"(?i)login|sign in|auth");
re!(re_class_bot, r"(?i)cloudflare|akamai|perimeterx|datadome|captcha|bot|js");
re!(re_src_id, r"^S(\d+)$");

/// collapse whitespace runs to single spaces + trim (JS `.replace(/\s+/g," ").trim()`).
fn collapse_ws_trim(s: &str) -> String {
    re_ws_run().replace_all(s, " ").trim().to_string()
}

fn mode_str(m: ExtractionMode) -> &'static str {
    match m {
        ExtractionMode::Article => "article",
        ExtractionMode::Structural => "structural",
        ExtractionMode::Docs => "docs",
        ExtractionMode::Document => "document",
    }
}

// ── Block gate (inlined; extractor.ts 102–279) ──────────────────────────
//
// Reason strings are LOAD-BEARING: the classification tail regex-matches
// them (/login|sign in|auth/i → FAIL_SILENT_LOGIN_WALL, /cloudflare|akamai|
// perimeterx|datadome|captcha|bot|js/i → FAIL_SILENT_BOT_BLOCK).

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlockVerdict {
    blocked: bool,
    reason: String,
}

impl BlockVerdict {
    fn blocked(reason: &str) -> Self {
        Self { blocked: true, reason: reason.to_string() }
    }
    const OK: BlockVerdict = BlockVerdict { blocked: false, reason: String::new() };
}

/// Classify a raw HTTP response for silent block signals (BEFORE DOM
/// extraction). Order matters: first matching signature wins; substring
/// checks run against the lower-cased first 4000 UTF-16 units.
fn detect_block(html: &str, status: u16, _content_type: &str) -> BlockVerdict {
    if status == 999 {
        return BlockVerdict::blocked("HTTP 999 (LinkedIn-style auth redirect)");
    }
    let head = js_slice_head(html, 4000).to_lowercase();
    let has = |s: &str| head.contains(s);
    // Cloudflare Turnstile / challenge
    if has("cf-chl")
        || has("challenge-platform")
        || has("cf-turnstile")
        || has("__cf_chl")
        || has("Just a moment")
        || has("Checking your browser")
        || (status == 503 && has("cf-ray"))
    {
        return BlockVerdict::blocked("Cloudflare challenge / Turnstile");
    }
    // Akamai Bot Manager
    if (has("akamai") && (has("bot") || has("dm_oo") || has("akb")))
        || (has("please enable cookies") && has("akamai"))
    {
        return BlockVerdict::blocked("Akamai Bot Manager block");
    }
    // PerimeterX / HUMAN
    if has("_pxhd") || has("_px2") || has("perimeterx") || has("px-captcha") {
        return BlockVerdict::blocked("PerimeterX / HUMAN bot challenge");
    }
    // DataDome
    if has("_ddg") || has("datadome") || (has("dd-") && has("captcha")) {
        return BlockVerdict::blocked("DataDome bot challenge");
    }
    // Generic CAPTCHA
    if has("g-recaptcha")
        || has("hcaptcha")
        || has("funcaptcha")
        || has("arkoselabs")
        || has("please verify you are not a robot")
        || has("i'm not a robot")
    {
        return BlockVerdict::blocked("CAPTCHA challenge");
    }
    // "Enable JavaScript and cookies to continue"
    if has("enable javascript and cookies")
        || has("please enable cookies")
        || has("js is required")
        || (js_len(&head) < 800 && has("<noscript") && has("javascript"))
    {
        // JS: head.length < 800 is UTF-16 units; head is the slice's
        // lowercase form — the slice already capped at 4000 units, so the
        // <800 test measures the SAME unit count. js_len keeps parity.
        return BlockVerdict::blocked("JavaScript + cookies required (SPA shell)");
    }
    // LinkedIn login wall
    if status == 999
        || has("linkedin.com/uas/login")
        || has("href=\"https://www.linkedin.com/login")
        || (has("Sign in to LinkedIn") && js_len(&head) < 20000)
    {
        return BlockVerdict::blocked("LinkedIn login wall");
    }
    // Instagram / Facebook login walls
    if ((has("instagram.com") || has("facebook.com"))
        && (has("log in") || has("login") || has("password"))
        && has("auth_session"))
        || has("please log in to continue")
    {
        return BlockVerdict::blocked("Instagram / Facebook login wall");
    }
    // Amazon robot check
    if has("validatecaptcha")
        || has("enter the characters you see")
        || (has("type the characters") && has("captcha"))
    {
        return BlockVerdict::blocked("Amazon robot / captcha check");
    }
    // AWS WAF challenge
    if has("awswaf") || has("aws-waf") || has("challenge.js") || (status == 202 && has("challenge"))
    {
        return BlockVerdict::blocked("AWS WAF bot challenge");
    }
    BlockVerdict::OK
}

/// Post-extraction text gate (extractor.ts 249–279).
fn detect_block_in_text(text: &str) -> BlockVerdict {
    let lower = js_slice_head(text, 2000).to_lowercase();
    if lower.contains("just a moment") {
        return BlockVerdict::blocked("Cloudflare challenge text survived extraction");
    }
    for re in [
        re_login_wall1(),
        re_login_wall2(),
        re_login_wall3(),
        re_login_wall4(),
    ] {
        if re.is_match(&lower) {
            return BlockVerdict::blocked("Login wall text in extraction");
        }
    }
    if lower.contains("captcha")
        || lower.contains("verify you are human")
        || lower.contains("i'm not a robot")
    {
        return BlockVerdict::blocked("CAPTCHA text in extraction");
    }
    if js_len(&collapse_ws_trim(text)) < 100 {
        return BlockVerdict::blocked("Extraction under 100 meaningful chars (JS shell)");
    }
    BlockVerdict::OK
}

/// Strip residual WAF/CAPTCHA boilerplate windows (extractor.ts 287–317)
/// — with the mutated-`cleaned` index quirk preserved (see module doc).
fn strip_waf_challenge_text(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let total_units = js_len(text);
    let mut cleaned = text.to_string();
    for m in re_waf_boilerplate().find_iter(text) {
        let m_units = js_len(m.as_str());
        let m_start_units = js_len(&text[..m.start()]);
        // JS `Math.max(0, m.index - 80)` → saturating_sub.
        let start = m_start_units.saturating_sub(80);
        let end = total_units.min(m_start_units + m_units + 80);
        cleaned = js_slice_head(&cleaned, start) + " " + &js_slice_from(&cleaned, end);
    }
    re_ws3().replace_all(&cleaned, "  ").trim().to_string()
}

fn has_meaningful_content(text: &str, min_chars: usize) -> bool {
    js_len(&collapse_ws_trim(text)) >= min_chars
}

// ── Extraction tier results (internal; extractor.ts 326–349) ───────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // `Browser`/`Snippet` exist in the TS union but NO
                    // TierOutput is ever constructed with them (extractBrowser
                    // returns its own shape; the snippet tier bypasses
                    // TierOutput). Kept for union parity documentation.
enum Tier {
    Direct,
    Adapter,
    Browser,
    Metadata,
    Jina,
    Wayback,
    Snippet,
    Crash,
}

#[derive(Debug, Clone)]
struct TierOutput {
    tier: Tier,
    markdown: String,
    status: u16,
    blocked: bool,
    blocked_reason: String,
    // TierOutput-shape parity: extractUrl NEVER reads mode/table/code
    // counts — the TS packet surfaces neither. Pipeline ports may.
    #[allow(dead_code)]
    mode: Option<String>,
    #[allow(dead_code)]
    table_count: Option<usize>,
    #[allow(dead_code)]
    code_block_count: Option<usize>,
}

impl TierOutput {
    fn crash(status: u16, reason: &str) -> Self {
        Self {
            tier: Tier::Crash,
            markdown: String::new(),
            status,
            blocked: true,
            blocked_reason: reason.to_string(),
            mode: None,
            table_count: None,
            code_block_count: None,
        }
    }
    fn crash_unblocked(status: u16, reason: &str) -> Self {
        Self {
            tier: Tier::Crash,
            markdown: String::new(),
            status,
            blocked: false,
            blocked_reason: reason.to_string(),
            mode: None,
            table_count: None,
            code_block_count: None,
        }
    }
}

/// extractBrowser's return shape (extractor.ts 610–690): NOT a TierOutput.
/// `status` mirrors `number | null`. `status`/`blocked_reason` are carried
/// for TS return-shape parity; extractUrl reads neither (the TS caller
/// inspects only `markdown`/`blocked`) — pipeline ports may.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct BrowserOut {
    markdown: String,
    status: Option<i64>,
    blocked: bool,
    blocked_reason: String,
}

// ── Tier implementations ───────────────────────────────────────────────

/// The extractor's dependency seams — mirrors the module-level imports of
/// extractor.ts (net/cache/platform-api/agentBrowser) as injectable traits
/// so pipeline replays use Scripted* fixtures. `Real*` impls get wired by
/// the Part-6 pipeline step.
pub struct Extractor<'a> {
    pub net: &'a dyn Net,
    pub cache: &'a dyn SearchCache,
    pub verticals: &'a dyn Verticals,
    pub bridge: &'a dyn BrowserBridge,
}

impl<'a> Extractor<'a> {
    /// Tier 1: direct fetch + block gate + structural DOM extraction +
    /// schema/hydration facts (extractor.ts 364–529). Never null.
    async fn extract_direct(&self, url: &str, fp: BrowserFingerprint) -> TierOutput {
        let opts = FetchPageOpts {
            timeout_ms: Some(TIER1_TIMEOUT_MS),
            fingerprint: Some(fp),
            ..Default::default()
        };
        let page = match self.net.fetch_page(url, &opts).await {
            Some(p) => p,
            None => return TierOutput::crash(0, "network error / timeout"),
        };

        // Charset normalization (extractor.ts 387–390). QUIRK: TS assigns
        // `html` but every later call re-reads page.body — `_html` is
        // computed and dropped, observable behavior identical.
        let bytes = page.body.as_bytes();
        let charset = detect_charset(&page.content_type, bytes);
        let _html = if charset == "utf-8" {
            page.body.clone()
        } else {
            normalize_body(bytes, &page.content_type)
        };

        if !page.ok || js_len(&page.body) < 200 {
            return TierOutput::crash_unblocked(
                page.status,
                &format!("HTTP {} (non-200 or empty body)", page.status),
            );
        }

        // Non-HTML response → document mode (CSV/JSON/Markdown sync).
        if !re_html_ct().is_match(&page.content_type) {
            let md = extract_document_sync(&page.body, &page.content_type, url);
            if js_len(&md) >= 100 {
                return TierOutput {
                    tier: Tier::Metadata,
                    markdown: md,
                    status: page.status,
                    blocked: false,
                    blocked_reason: String::new(),
                    mode: Some("document".to_string()),
                    table_count: None,
                    code_block_count: None,
                };
            }
            return TierOutput::crash_unblocked(page.status, "non-HTML response under 100 chars");
        }

        // Block gate BEFORE DOM parsing.
        let block = detect_block(&page.body, page.status, &page.content_type);
        if block.blocked {
            let mut t = TierOutput::crash(page.status, &block.reason);
            t.blocked = true;
            return t;
        }

        // DOM extraction: pick the structural mode automatically.
        let det = detect_mode(&page.body, &page.content_type, url);
        let struct_out = structural_extract(&page.body, &page.content_type, url);
        let mut md = struct_out.markdown;
        let table_count = Some(struct_out.table_count);
        let code_block_count = Some(struct_out.code_block_count);
        if js_len(&md) < 100 {
            let fallback = collapse_ws_trim(&re_tag().replace_all(&page.body, " "));
            if js_len(&fallback) >= 100 {
                md = "## Page text (raw extraction)\n".to_string()
                    + &js_slice_head(&fallback, 12_000);
            }
        }

        // Pass A structured facts + hydration — only when DOM came up thin.
        // QUIRK: bodyPlainLen collapses tags but NOT whitespace runs.
        let body_plain_len =
            js_len(re_tag().replace_all(&page.body, " ").trim());
        let dom_thin = det.mode == ExtractionMode::Document
            || body_plain_len < 1500
            || js_len(&md) < 800;
        if dom_thin {
            let schema_md = schema_extract(&page.body);
            let hydration_md = unpack_hydration(&page.body);
            if !schema_md.is_empty() || !hydration_md.is_empty() {
                md = [schema_md.as_str(), hydration_md.as_str(), md.as_str()]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<&str>>()
                    .join("\n\n");
            }
        }

        // Text-level block check (silent blocks that survived readability).
        let text_block = detect_block_in_text(&md);
        if text_block.blocked {
            return TierOutput::crash(page.status, &text_block.reason);
        }

        if js_len(&md) < 100 {
            let mut t = TierOutput::crash_unblocked(
                page.status,
                "empty JS shell (under 100 meaningful chars)",
            );
            t.mode = Some(mode_str(det.mode).to_string());
            t.table_count = table_count;
            t.code_block_count = code_block_count;
            return t;
        }
        TierOutput {
            tier: Tier::Direct,
            markdown: md,
            status: page.status,
            blocked: false,
            blocked_reason: String::new(),
            mode: Some(mode_str(det.mode).to_string()),
            table_count,
            code_block_count,
        }
    }

    /// Tier 1.5: keyless platform API adapter (extractor.ts 532–542).
    async fn extract_adapter(&self, url: &str) -> Option<TierOutput> {
        let result = platform_adapter(self.net, self.verticals, url, 0).await?;
        Some(TierOutput {
            tier: Tier::Adapter,
            markdown: result.markdown,
            status: 200,
            blocked: false,
            blocked_reason: String::new(),
            mode: None,
            table_count: None,
            code_block_count: None,
        })
    }

    /// Browser tier via the Tier-3b bridge (extractor.ts 610–690).
    /// Never null (all TS paths, including the catch, return an object).
    async fn extract_browser(&self, result: &RankedResult) -> BrowserOut {
        let r = match self
            .bridge
            .extract_page_in_one_pass(&result.canonical, Some(45_000))
            .await
        {
            Ok(r) => r,
            Err(msg) => {
                // catch (e): "browser pool error: " + (e?.message ?? String(e))
                return BrowserOut {
                    markdown: String::new(),
                    status: Some(0),
                    blocked: false,
                    blocked_reason: "browser pool error: ".to_string() + &msg,
                };
            }
        };
        if !r.ok {
            return BrowserOut {
                markdown: String::new(),
                status: Some(r.status.unwrap_or(0)),
                blocked: r.status == Some(403) || r.status == Some(429) || r.status == Some(503),
                blocked_reason: r
                    .error
                    .clone()
                    .unwrap_or_else(|| "browser extraction failed".to_string()),
            };
        }
        let mut parts: Vec<String> = Vec::new();

        // 1. Live-rendered DOM body text.
        if js_len(&r.body_text) >= 100 {
            parts.push(
                "## Rendered page body (Playwright stealth Chromium)\n".to_string()
                    + &js_slice_head(&r.body_text, 12_000),
            );
        }
        // 2. Final URL after JS/HTTP redirects.
        if !r.final_url.is_empty() && r.final_url != result.canonical {
            parts.push("Final URL after redirects: ".to_string() + &r.final_url);
        }
        // 3. Title.
        if !r.title.is_empty() {
            parts.push("# ".to_string() + &r.title);
        }
        // 4. JSON-LD (same formatter as the Pass A HTML path).
        if !r.json_ld.is_empty() {
            let schema_md = schema_extract_from_blocks(&r.json_ld).join("\n\n");
            if !schema_md.is_empty() {
                parts.push("[Structured Page Facts]\n\n".to_string() + &schema_md);
            }
        }
        // 5. OpenGraph / Twitter meta (document order — de_string_pairs).
        if !r.meta.is_empty() {
            let lines: Vec<String> = r
                .meta
                .iter()
                .filter(|(k, _)| re_og_meta().is_match(k) || k == "description")
                .map(|(k, v)| "- ".to_string() + k + ": " + &js_slice_head(v, 300))
                .collect();
            if !lines.is_empty() {
                parts.push("## Page Metadata (browser)\n".to_string() + &lines.join("\n"));
            }
        }
        // 6. Window-global hydration state (generic JSON walker).
        for (key, raw) in &r.window_state {
            let parsed: Value = match serde_json::from_str(raw) {
                Ok(v) => v,
                Err(_) => continue, // "not valid JSON under this key — skip"
            };
            let cards = walk_generic_json_for_entities(
                &parsed,
                &WalkerOptions {
                    max_cards: Some(60),
                    label: Some(key.clone()),
                    max_depth: None,
                },
            );
            if !cards.is_empty() {
                parts.push(
                    "## Hydration state (".to_string() + key + ")\n" + &cards,
                );
            }
        }
        // 7. ARIA semantic snapshot (capped for reranker budget).
        if !r.aria_snapshot.is_empty() && js_len(&r.aria_snapshot) >= 100 {
            parts.push(
                "## ARIA snapshot (accessibility tree)\n".to_string()
                    + &js_slice_head(&r.aria_snapshot, 8_000),
            );
        }

        let markdown = parts.join("\n\n"); // parts.filter(Boolean) is a no-op
        if js_len(&markdown) < 60 {
            // QUIRK-preserved: this branch keeps r.status verbatim (may be
            // None = JS null) while the success branch uses `?? 200`.
            return BrowserOut {
                markdown,
                status: r.status,
                blocked: false,
                blocked_reason: "browser returned little content".to_string(),
            };
        }
        BrowserOut {
            markdown,
            status: Some(r.status.unwrap_or(200)),
            blocked: false,
            blocked_reason: String::new(),
        }
    }

    /// Tier 2: social link-preview crawler bypass (extractor.ts 701–755).
    async fn extract_link_preview(&self, url: &str) -> Option<TierOutput> {
        let page = self
            .net
            .fetch_with_link_preview_bots(url, LINK_PREVIEW_TIMEOUT_MS, PAGE_LIMIT_BYTES)
            .await?;
        if !page.ok || js_len(&page.body) < 200 {
            return None;
        }
        // Block gate on the bot-fetched body.
        if detect_block(&page.body, page.status, &page.content_type).blocked {
            return None;
        }
        let bot_name = page.bot_name.clone().unwrap_or_default();
        let schema_md = schema_extract(&page.body);
        let hydration_md = unpack_hydration(&page.body);
        let struct_out = structural_extract(&page.body, &page.content_type, url);
        let mut md = struct_out.markdown;
        if js_len(&md) < 100 {
            let fallback = collapse_ws_trim(&re_tag().replace_all(&page.body, " "));
            if js_len(&fallback) >= 100 {
                // QUIRK: NO slice cap here (unlike extractDirect's 12 000).
                md = "## Page text (raw extraction, link-preview bot ".to_string()
                    + &bot_name
                    + ")\n"
                    + &fallback;
            }
        }
        let combined = [schema_md.as_str(), hydration_md.as_str(), md.as_str()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<&str>>()
            .join("\n\n");
        let cleaned = strip_waf_challenge_text(&combined);
        if !has_meaningful_content(&cleaned, 100) {
            return None;
        }
        Some(TierOutput {
            tier: Tier::Direct,
            markdown: "## Link-preview bot response (".to_string() + &bot_name + ")\n" + &cleaned,
            status: page.status,
            blocked: false,
            blocked_reason: String::new(),
            mode: Some(mode_str(struct_out.mode).to_string()),
            table_count: Some(struct_out.table_count),
            code_block_count: Some(struct_out.code_block_count),
        })
    }

    /// Tier 4 (in-cascade): r.jina.ai markdown reader, behind the global
    /// Jina limiter (extractor.ts 756–780).
    async fn extract_jina(&self, url: &str) -> Option<TierOutput> {
        let _permit = Self::jina_semaphore()
            .acquire_owned()
            .await
            .expect("global jina semaphore is never closed");
        let jina_url = "https://r.jina.ai/".to_string() + &js_encode_uri(url);
        let opts = FetchPageOpts {
            timeout_ms: Some(JINA_TIMEOUT_MS),
            headers: vec![("user-agent".to_string(), "Mozilla/5.0".to_string())],
            ..Default::default()
        };
        let page = self.net.fetch_page(&jina_url, &opts).await?;
        if !page.ok {
            return None;
        }
        let body = page.body.trim().to_string();
        if detect_block_in_text(&body).blocked {
            return None; // Jina returned a challenge page — failed tier.
        }
        if js_len(&body) >= 200 {
            Some(TierOutput {
                tier: Tier::Jina,
                markdown: body,
                status: page.status,
                blocked: false,
                blocked_reason: String::new(),
                mode: None,
                table_count: None,
                code_block_count: None,
            })
        } else {
            None
        }
    }

    /// Global Jina limiter (TS module-global `pLimit(JINA_CONCURRENCY)`;
    /// lazily created — recorded micro-divergence).
    fn jina_semaphore() -> Arc<Semaphore> {
        static JINA_SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
        JINA_SEM
            .get_or_init(|| {
                Arc::new(Semaphore::new(env_concurrency(
                    ENV_JINA_CONCURRENCY,
                    "6",
                    6,
                )))
            })
            .clone()
    }

    /// Tier 3: Wayback Machine snapshot (extractor.ts 787–844).
    async fn extract_wayback(&self, url: &str) -> Option<TierOutput> {
        // 1. Availability API — closest snapshot.
        let avail_opts = UrlFetchOpts {
            timeout_ms: Some(WAYBACK_TIMEOUT_MS),
            ..Default::default()
        };
        let avail_res = self
            .net
            .fetch_url(
                &("https://archive.org/wayback/available?url=".to_string()
                    + &js_encode_uri_component(url)),
                &avail_opts,
            )
            .await;
        let mut snapshot_url: Option<String> = None;
        if let Some(res) = avail_res.filter(|r| r.ok) {
            if let Ok(data) = serde_json::from_str::<Value>(&res.text) {
                if let Some(snap) = data
                    .pointer("/archived_snapshots/closest/url")
                    .and_then(Value::as_str)
                {
                    if !snap.is_empty() {
                        snapshot_url = Some(snap.to_string());
                    }
                }
            }
        }
        // 2. CDX fallback — closest snapshot by timestamp.
        if snapshot_url.is_none() {
            let cdx_res = self
                .net
                .fetch_url(
                    &("https://web.archive.org/cdx/search/cdx?url=".to_string()
                        + &js_encode_uri_component(url)
                        + "&limit=1&output=json&fl=original,timestamp,statuscode&from=2020"),
                    &avail_opts,
                )
                .await;
            if let Some(res) = cdx_res.filter(|r| r.ok) {
                if let Ok(rows) = serde_json::from_str::<Vec<Value>>(&res.text) {
                    let row = rows.iter().find(|r| {
                        r.get(2).and_then(Value::as_str).is_some_and(|s| s.starts_with("200"))
                    });
                    if let Some(row) = row {
                        let orig = row.get(0).and_then(Value::as_str).unwrap_or("");
                        let ts = row.get(1).and_then(Value::as_str).unwrap_or("");
                        if !orig.is_empty() && !ts.is_empty() {
                            snapshot_url = Some(format!("https://web.archive.org/web/{ts}/{orig}"));
                        }
                    }
                }
            }
        }
        let snapshot_url = snapshot_url?;

        // 3. Fetch the snapshot HTML and extract it.
        let page = self
            .net
            .fetch_page(
                &snapshot_url,
                &FetchPageOpts {
                    timeout_ms: Some(WAYBACK_TIMEOUT_MS),
                    ..Default::default()
                },
            )
            .await?;
        if !page.ok || js_len(&page.body) < 200 {
            return None;
        }
        // QUIRK: text-level block gate runs on the RAW snapshot HTML.
        if detect_block_in_text(&page.body).blocked {
            return None;
        }
        let struct_out = structural_extract(&page.body, &page.content_type, &snapshot_url);
        let md = struct_out.markdown;
        if js_len(&md) < 100 {
            return None;
        }
        Some(TierOutput {
            tier: Tier::Wayback,
            markdown: "## Wayback Machine snapshot of ".to_string() + url + "\n" + &md,
            status: page.status,
            blocked: false,
            blocked_reason: String::new(),
            mode: Some(mode_str(struct_out.mode).to_string()),
            table_count: Some(struct_out.table_count),
            code_block_count: Some(struct_out.code_block_count),
        })
    }
}

// ── SERP baseline (extractor.ts 551–601) ───────────────────────────────

/// Exact preamble of `serpBaselinePassage` (extractor.ts 551–566),
/// INCLUDING the trailing `]\n` before the sliced snippet.
const SERP_BASELINE_PREAMBLE: &str = "[SERP snippet baseline — the page itself was blocked or empty. The following is the search engine's own indexed title + snippet, guaranteed evidence even when every direct connection fails.]\n";

fn serp_baseline_passage(result: &RankedResult) -> Option<EvidencePassage> {
    let fallback_text = if !result.snippet.is_empty() {
        &result.snippet
    } else if !result.title.is_empty() {
        &result.title
    } else {
        ""
    };
    let snippet = fallback_text.trim().to_string();
    if js_len(&snippet) < 12 {
        return None;
    }
    Some(EvidencePassage {
        source_id: String::new(),
        url: result.canonical.clone(),
        title: result.title.clone(),
        domain: result.domain.clone(),
        published_at: result.published_date.clone(),
        passage_text: SERP_BASELINE_PREAMBLE.to_string() + &js_slice_head(&snippet, 2000),
        bm25_score: 0.0,
    })
}

/// §11.3: the packet `extract_all` yields when a page's tier cascade is
/// abandoned at the total page budget. Shape mirrors the terminal-failure
/// fallback `extract_url` already returns (baseline first; title/marker
/// only when no baseline exists) — the ONLY new artifact is the
/// `PAGE_BUDGET_TIMEOUT` classification (never emitted by any other path,
/// never present in golden fixtures where the timer cannot fire).
/// Mirrors `timeoutFallbackPacket` in extractor.ts.
pub(crate) fn timeout_fallback_packet(result: &RankedResult) -> EvidencePacket {
    let mut packet = EvidencePacket {
        source_id: String::new(),
        url: result.canonical.clone(),
        title: result.title.clone(),
        domain: result.domain.clone(),
        published_at: result.published_date.clone(),
        extraction: ExtractionKind::SnippetOnly,
        passages: Vec::new(),
        classification: None,
    };
    if let Some(baseline) = serp_baseline_passage(result) {
        packet.passages.push(baseline);
    } else {
        packet.passages.push(EvidencePassage {
            source_id: String::new(),
            url: result.canonical.clone(),
            title: result.title.clone(),
            domain: result.domain.clone(),
            published_at: result.published_date.clone(),
            passage_text: if result.title.is_empty() {
                "(page read timed out — no content extracted)".to_string()
            } else {
                result.title.clone()
            },
            bm25_score: 0.0,
        });
    }
    packet.classification = Some("PAGE_BUDGET_TIMEOUT".to_string());
    packet
}

// ── Public entry points ────────────────────────────────────────────────

impl<'a> Extractor<'a> {
    /// Fetch + extract ONE URL through every tier in order
    /// (extractor.ts 855–1199). Classification lands on
    /// `packet.classification` (Rust's Option<String> field — no wrapper
    /// struct needed; TS's `EvidencePacket & { classification }` is the
    /// same JSON shape).
    ///
    /// Cache reads/writes propagate `CacheError` faithfully: TS's
    /// getCachedPage/putCachedPage can throw and extractUrl has NO catch,
    /// so the throw rejects the whole extractAll — Rust returns Err.
    /// Everything else never throws.
    pub async fn extract_url(&self, result: &RankedResult) -> Result<EvidencePacket, CacheError> {
        let url = result.canonical.as_str();
        let mut packet = EvidencePacket {
            source_id: String::new(), // assigned later by extract_all
            url: url.to_string(),
            title: result.title.clone(),
            domain: result.domain.clone(),
            published_at: result.published_date.clone(),
            extraction: ExtractionKind::SnippetOnly,
            passages: Vec::new(),
            classification: None,
        };
        let passage = |text: String| EvidencePassage {
            source_id: String::new(),
            url: url.to_string(),
            title: result.title.clone(),
            domain: result.domain.clone(),
            published_at: result.published_date.clone(),
            passage_text: text,
            bm25_score: 0.0,
        };

        // ── Universal SERP snippet baseline (pushed FIRST) ──────────────
        if let Some(baseline) = serp_baseline_passage(result) {
            packet.passages.push(baseline);
            packet.extraction = ExtractionKind::SnippetOnly;
        }

        // Tier 0: SQLite cache hit
        let cached = self.cache.get_cached_page(url)?;
        if let Some(cached) = cached.filter(|c| js_len(&c.extracted) >= 200) {
            packet.extraction = if cached.tier == "jina" {
                ExtractionKind::JinaFallback
            } else {
                ExtractionKind::Direct
            };
            // No truncation: the cache stores the full extracted document.
            packet.passages.push(passage(cached.extracted.clone()));
            packet.classification = Some(
                match cached.tier.as_str() {
                    "jina" => "SUCCESS_JINA_FALLBACK",
                    "adapter" => "SUCCESS_ADAPTER",
                    "wayback" => "SUCCESS_WAYBACK",
                    "metadata" => "SUCCESS_METADATA",
                    _ => "SUCCESS_DIRECT",
                }
                .to_string(),
            );
            return Ok(packet);
        }

        // Tier 1.5: platform API adapter first (cheapest for known hosts)
        let adapter_out = self.extract_adapter(url).await;
        if let Some(a) = adapter_out.as_ref().filter(|a| js_len(&a.markdown) >= 200) {
            packet.extraction = ExtractionKind::Direct;
            packet.passages.push(passage(a.markdown.clone()));
            self.cache.put_cached_page(url, &a.markdown, PageTier::Adapter)?;
            packet.classification = Some("SUCCESS_ADAPTER".to_string());
            return Ok(packet);
        }

        // Tier 1: direct fetch (fingerprint rotation lives INSIDE fetch_page)
        let direct_out = self.extract_direct(url, BrowserFingerprint::Chrome).await;

        if !direct_out.blocked && js_len(&direct_out.markdown) >= 200 {
            packet.extraction = ExtractionKind::Direct;
            packet.passages.push(passage(direct_out.markdown.clone()));
            self.cache.put_cached_page(url, &direct_out.markdown, PageTier::Direct)?;
            packet.classification = Some("SUCCESS_DIRECT".to_string());
            return Ok(packet);
        }
        if !direct_out.blocked
            && direct_out.tier == Tier::Metadata
            && js_len(&direct_out.markdown) >= 100
        {
            packet.extraction = ExtractionKind::Direct;
            packet.passages.push(passage(direct_out.markdown.clone()));
            self.cache.put_cached_page(url, &direct_out.markdown, PageTier::Metadata)?;
            packet.classification = Some("SUCCESS_METADATA".to_string());
            return Ok(packet);
        }

        // Tier 2: social link-preview crawler bypass.
        let tier1_blocked_or_empty = direct_out.blocked
            || direct_out.status == 0
            || (js_len(&direct_out.markdown) < 200 && direct_out.tier == Tier::Crash);
        let mut link_preview_out: Option<TierOutput> = None;
        if tier1_blocked_or_empty {
            let lp = self.extract_link_preview(url).await;
            if let Some(lp) = lp.as_ref().filter(|l| js_len(&l.markdown) >= 200) {
                packet.extraction = ExtractionKind::Direct;
                packet.passages.push(passage(lp.markdown.clone()));
                self.cache.put_cached_page(url, &lp.markdown, PageTier::Direct)?;
                packet.classification = Some("SUCCESS_DIRECT".to_string());
                return Ok(packet);
            }
            link_preview_out = lp;
        }

        // Browser-tier fallback (Tier-3b bridge seam).
        let direct_thinned_or_blocked = direct_out.blocked
            || direct_out.status == 0
            || direct_out.status == 202 // WAF challenge page (Zepto, DataDome)
            || direct_out.status == 403
            || direct_out.status == 429
            || (js_len(&direct_out.markdown) < 200 && direct_out.tier == Tier::Crash)
            || (js_len(&direct_out.markdown) < 100 && direct_out.tier != Tier::Crash);
        if direct_thinned_or_blocked {
            let browser_out = self.extract_browser(result).await;
            if js_len(&browser_out.markdown) >= 200 && !browser_out.blocked {
                packet.extraction = ExtractionKind::Direct;
                packet.passages.push(passage(browser_out.markdown.clone()));
                self.cache.put_cached_page(url, &browser_out.markdown, PageTier::Browser)?;
                // SUCCESS_BROWSER is real code truth though absent from the
                // TS header list (see module doc).
                packet.classification = Some("SUCCESS_BROWSER".to_string());
                return Ok(packet);
            }
        }

        // Tier 4: Jina fallback — fires on any Tier 1/2 failure.
        let jina_out = self.extract_jina(url).await;
        if let Some(j) = jina_out.as_ref().filter(|j| js_len(&j.markdown) >= 200) {
            packet.extraction = ExtractionKind::JinaFallback;
            packet.passages.push(passage(j.markdown.clone()));
            self.cache.put_cached_page(url, &j.markdown, PageTier::Jina)?;
            packet.classification = Some("SUCCESS_JINA_FALLBACK".to_string());
            return Ok(packet);
        }

        // Tier 3: Wayback Machine snapshot.
        let tier1_failed = direct_out.blocked
            || direct_out.status == 0
            || (js_len(&direct_out.markdown) < 100 && direct_out.tier == Tier::Crash);
        if tier1_failed {
            let wayback_out = self.extract_wayback(url).await;
            if let Some(w) = wayback_out.as_ref().filter(|w| js_len(&w.markdown) >= 200) {
                // QUIRK: extraction label REUSE from the jina branch.
                packet.extraction = ExtractionKind::JinaFallback;
                packet.passages.push(passage(w.markdown.clone()));
                self.cache.put_cached_page(url, &w.markdown, PageTier::Wayback)?;
                packet.classification = Some("SUCCESS_WAYBACK".to_string());
                return Ok(packet);
            }
        }

        // Tier 4: snippet preservation. QUIRK: no .trim() here.
        packet.extraction = ExtractionKind::SnippetOnly;
        let snippet = if !result.snippet.is_empty() {
            result.snippet.clone()
        } else {
            result.title.clone()
        };

        // Tier 6: slug triangulation + exact-URL fallback.
        let direct_blocked = direct_out.blocked;
        let direct_empty_shell = !direct_blocked && direct_out.tier == Tier::Crash;
        if (direct_blocked || direct_empty_shell || link_preview_out.is_none())
            && js_len(&result.snippet) < 20
        {
            // (TS wraps this in try/catch for network failure; the Rust
            // metasearch seam is infallible → no catch needed.)
            let synthesized = slug_triangulation(self.net, url, Some(&result.title)).await;
            if js_len(&synthesized) >= 80 {
                let cleaned = strip_waf_challenge_text(&synthesized);
                if has_meaningful_content(&cleaned, 40) {
                    packet.passages.push(EvidencePassage {
                        source_id: String::new(),
                        url: url.to_string(),
                        title: if result.title.is_empty() {
                            "(triangulated)".to_string()
                        } else {
                            result.title.clone()
                        },
                        domain: result.domain.clone(),
                        published_at: result.published_date.clone(),
                        passage_text: cleaned,
                        bm25_score: 0.0,
                    });
                    packet.classification = Some("SUCCESS_SNIPPET_FALLBACK".to_string());
                    return Ok(packet);
                }
            }
            let fallback_results = url_search_fallback(self.net, url, Some(&result.title)).await;
            if let Some(best) = fallback_results.first() {
                let fb_src = if !best.snippet.is_empty() {
                    &best.snippet
                } else if !best.title.is_empty() {
                    &best.title
                } else {
                    ""
                };
                let fb_snippet = js_slice_head(fb_src, 12_000);
                if js_len(&fb_snippet) >= 20 {
                    let cleaned = strip_waf_challenge_text(&fb_snippet);
                    if has_meaningful_content(&cleaned, 40) {
                        packet.passages.push(EvidencePassage {
                            source_id: String::new(),
                            url: url.to_string(),
                            title: if best.title.is_empty() {
                                result.title.clone()
                            } else {
                                best.title.clone()
                            },
                            domain: if best.domain.is_empty() {
                                result.domain.clone()
                            } else {
                                best.domain.clone()
                            },
                            published_at: best.published_date.clone(),
                            passage_text: cleaned,
                            bm25_score: 0.0,
                        });
                        packet.classification = Some("SUCCESS_SNIPPET_FALLBACK".to_string());
                        return Ok(packet);
                    }
                }
            }
        }

        // Classification tail.
        if direct_out.blocked {
            let kind = direct_out.blocked_reason.clone();
            packet.passages.push(passage(if js_len(&snippet) >= 20 {
                snippet.clone()
            } else if result.title.is_empty() {
                "(blocked page)".to_string()
            } else {
                result.title.clone()
            }));
            packet.classification = Some(
                if re_class_login().is_match(&kind) {
                    "FAIL_SILENT_LOGIN_WALL"
                } else if re_class_bot().is_match(&kind) {
                    "FAIL_SILENT_BOT_BLOCK"
                } else {
                    "FAIL_NETWORK_OR_CRASH"
                }
                .to_string(),
            );
            return Ok(packet);
        }

        if js_len(&snippet) < 20 {
            packet.passages.push(passage(if result.title.is_empty() {
                "(empty page — JS shell, no content extracted)".to_string()
            } else {
                result.title.clone()
            }));
            packet.classification = Some("FAIL_EMPTY_JS_SHELL".to_string());
            return Ok(packet);
        }

        packet.passages.push(passage(snippet));
        packet.classification = Some("SUCCESS_SNIPPET_FALLBACK".to_string());
        Ok(packet)
    }

    /// Extract the top N ranked results in parallel (extractor.ts
    /// 1206–1228), then assign S1..Sn in rank order (packet + passages).
    /// `on_page` requires `Send + Sync` (not in the TS original, which has no
    /// Send bound): the pipeline's callback forwards `PipelineProgress` to a
    /// caller that may live behind a spawned server task, and a bare `&dyn Fn`
    /// would make this future non-`Send`. No behavior change; pure trait-bound
    /// widening (RECORDED MICRO-DIVERGENCE in pipeline.rs's header).
    /// `page_budget_ms` (Part-10 deviation §11.3, not in the TS original's
    /// signature — TS hardcodes the same default; tests inject): TOTAL
    /// wall-clock cap per page, applied AFTER the concurrency permit (a
    /// queued page never burns its budget). On expiry the page's cascade is
    /// ABANDONED and the page settles to `timeout_fallback_packet` — the
    /// same snippet-baseline terminal shape a fully-failed cascade gets —
    /// instead of stalling `join_all`. The page still counts toward
    /// `on_page` progress and still gets its S-id, so the bundle shape is
    /// unchanged.
    pub async fn extract_all(
        &self,
        ranked: &[RankedResult],
        max_urls: usize,
        on_page: Option<&(dyn Fn(usize, usize) + Send + Sync)>,
        page_budget_ms: Option<u64>,
    ) -> Result<Vec<EvidencePacket>, CacheError> {
        let top = &ranked[..ranked.len().min(max_urls)];
        let budget = page_budget_ms.unwrap_or(PAGE_BUDGET_DEFAULT_MS);
        // pLimit(EXTRACTION_CONCURRENCY) twin: tokio Semaphore (fair/FIFO).
        let sem = Arc::new(Semaphore::new(env_concurrency(
            ENV_EXTRACTION_CONCURRENCY,
            "4",
            4,
        )));
        let total = top.len();
        // RECORDED MICRO-DIVERGENCE (Send-completeness): the TS original has
        // no Send notion; a `Cell` shared across the join_all futures makes
        // this future non-`Send`, which would make the whole pipeline future
        // non-spawnable in the Part-8 axum server. An `AtomicUsize` (Relaxed)
        // under join_all's single-task polling has identical per-thread
        // sequencing to the Cell — the counter increments in the same order.
        let done_pages = AtomicUsize::new(0usize);
        let settled: Vec<Result<EvidencePacket, CacheError>> = join_all(top.iter().map(|r| {
            let sem = Arc::clone(&sem);
            let done_pages = &done_pages;
            async move {
                let _permit = sem.acquire_owned().await.expect("semaphore is never closed");
                // §11.3 page budget: timeout abandons the cascade (the
                // dropped future cancels every in-flight tier request);
                // cache errors still reject the whole batch exactly like
                // the TS Promise.all.
                let p = match tokio::time::timeout(Duration::from_millis(budget), self.extract_url(r)).await
                {
                    Ok(p) => p?,
                    Err(_) => timeout_fallback_packet(r),
                };
                let done = done_pages.fetch_add(1, Ordering::Relaxed) + 1;
                if let Some(cb) = on_page {
                    cb(done, total);
                }
                Ok(p)
            }
        }))
        .await;
        // Promise.all semantics: any rejection rejects the whole call.
        let mut packets = Vec::with_capacity(settled.len());
        for p in settled {
            packets.push(p?);
        }
        for (i, packet) in packets.iter_mut().enumerate() {
            let id = format!("S{}", i + 1);
            packet.source_id = id.clone();
            for p in packet.passages.iter_mut() {
                p.source_id = id.clone();
            }
        }
        Ok(packets)
    }
}

/// Bundle-level SERP-baseline guarantee for results OUTSIDE the extractor's
/// read window (extractor.ts 578–601).
pub fn baseline_packets_for(
    ranked: &[RankedResult],
    extracted_urls: &std::collections::HashSet<String>,
    max: usize,
) -> Vec<EvidencePacket> {
    let mut out: Vec<EvidencePacket> = Vec::new();
    for r in ranked {
        if out.len() >= max {
            break;
        }
        if extracted_urls.contains(&r.canonical) {
            continue;
        }
        let Some(baseline) = serp_baseline_passage(r) else {
            continue;
        };
        out.push(EvidencePacket {
            source_id: String::new(),
            url: r.canonical.clone(),
            title: r.title.clone(),
            domain: r.domain.clone(),
            published_at: r.published_date.clone(),
            extraction: ExtractionKind::SnippetOnly,
            passages: vec![baseline],
            classification: Some("SUCCESS_SNIPPET_FALLBACK".to_string()),
        });
    }
    out
}

/// Re-number a LATE-MERGED batch so ids cannot collide (extractor.ts
/// 1239–1244). Mutates in place; ids stay "S<number>".
pub fn renumber_packets(packets: &mut [EvidencePacket], start_at: usize) {
    for (i, packet) in packets.iter_mut().enumerate() {
        packet.source_id = format!("S{}", start_at + i);
        let id = packet.source_id.clone();
        for p in packet.passages.iter_mut() {
            p.source_id = id.clone();
        }
    }
}

/// First free source id index after a packet set (extractor.ts 1247–1254).
pub fn next_source_index(packets: &[EvidencePacket]) -> usize {
    let mut max = 0usize;
    for p in packets {
        if let Some(caps) = re_src_id().captures(&p.source_id) {
            if let Ok(n) = caps[1].parse::<usize>() {
                max = max.max(n);
            }
        }
    }
    max + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_bridge::{NoBrowserBridge, ScriptedBridge};
    use crate::cache::{CachedPage, ScriptedCache};
    use crate::net::{PageResponse, ScriptedNet, UrlFetchResult};
    use crate::platform_api::NoVerticals;
    use crate::types::RankedResult;

    fn ranked(url: &str, title: &str, snippet: &str) -> RankedResult {
        RankedResult {
            url: url.to_string(),
            canonical: url.to_string(),
            title: title.to_string(),
            snippet: snippet.to_string(),
            engine: "test".to_string(),
            published_date: None,
            domain: "example.com".to_string(),
            rrf: 1.0,
            engines: vec![],
            engine_ranks: Default::default(),
        }
    }

    fn page(status: u16, ok: bool, body: &str, ct: &str) -> PageResponse {
        PageResponse {
            status,
            ok,
            body: body.to_string(),
            content_type: ct.to_string(),
            elapsed_ms: 0,
            fingerprint: "chrome".to_string(),
            cookies: vec![],
            resolved_url: String::new(),
            bot_name: None,
        }
    }

    fn urlf(ok: bool, text: &str) -> UrlFetchResult {
        UrlFetchResult { status: 200, ok, text: text.to_string() }
    }

    /// Long readable body that survives every gate and yields markdown ≥200.
    fn healthy_html() -> String {
        let para = "The quarterly report shows revenue growth across every division, \
                    driven by enterprise subscriptions and platform expansion into new \
                    markets this fiscal year. Operating margins improved by four hundred \
                    basis points as infrastructure costs declined year over year. "
            .repeat(10);
        format!("<html><head><title>Report</title></head><body><article><p>{para}</p></article></body></html>")
    }

    fn cf_blocked_html() -> String {
        format!(
            "<html><body><div cf-turnstile data-sitekey=x>cf-chl-buffer</div>{}{}",
            "x".repeat(250),
            "</body></html>"
        )
    }

    #[test]
    fn block_signatures_first_match_order_and_reason_strings() {
        // Order + exact reason strings are load-bearing for the
        // classification tail; first matching signature wins.
        let v = detect_block("<div class=cf-turnstile></div>", 200, "text/html");
        assert!(v.blocked);
        assert_eq!(v.reason, "Cloudflare challenge / Turnstile");
        // status 503 + cf-ray → Cloudflare conjunct
        let v = detect_block("<body>cf-ray: 123</body>", 503, "text/html");
        assert_eq!(v.reason, "Cloudflare challenge / Turnstile");
        // Akamai needs akamai + (bot|dm_oo|akb)
        let v = detect_block("akamai says bot", 200, "text/html");
        assert_eq!(v.reason, "Akamai Bot Manager block");
        // DataDome via dd- + captcha
        let v = detect_block("dd-sc captcha", 200, "text/html");
        assert_eq!(v.reason, "DataDome bot challenge");
        // 999 short-circuits BEFORE the table ("HTTP 999…" reason, and the
        // LinkedIn entry's own status===999 conjunct stays unreachable).
        let v = detect_block("<html>", 999, "text/html");
        assert_eq!(v.reason, "HTTP 999 (LinkedIn-style auth redirect)");
        // LinkedIn href signature (lowercase form matches fine)
        let v = detect_block("href=\"https://www.linkedin.com/login\"", 200, "text/html");
        assert_eq!(v.reason, "LinkedIn login wall");
        // AWS WAF 202+challenge
        let v = detect_block("<body>challenge</body>", 202, "text/html");
        assert_eq!(v.reason, "AWS WAF bot challenge");
        // Clean page
        let v = detect_block("<p>plain content here</p>", 200, "text/html");
        assert!(!v.blocked);
        assert_eq!(v.reason, "");
    }

    #[test]
    fn mixed_case_signature_conjuncts_are_dead_in_js_and_rust() {
        // QUIRK: "Just a moment" (mixed case) against the lower-cased head
        // can NEVER match — dead in JS, kept dead here. A pure
        // "just a moment" page hits NO Cloudflare signature in detectBlock
        // (only detectBlockInText catches it later).
        let v = detect_block("<p>Just a moment…</p>", 200, "text/html");
        assert!(!v.blocked);
    }

    #[test]
    fn detect_block_in_text_catches_silent_walls() {
        let v = detect_block_in_text("Just a moment, please verify you are human.");
        assert_eq!(v.reason, "Cloudflare challenge text survived extraction");
        let v = detect_block_in_text(&("x".repeat(300) + " Sign in to LinkedIn to continue."));
        assert_eq!(v.reason, "Login wall text in extraction");
        let v = detect_block_in_text(&("x".repeat(300) + " enter the captcha below"));
        assert_eq!(v.reason, "CAPTCHA text in extraction");
        let v = detect_block_in_text("tiny");
        assert_eq!(v.reason, "Extraction under 100 meaningful chars (JS shell)");
        let v = detect_block_in_text(&"real text. ".repeat(20));
        assert!(!v.blocked);
        // 2000-unit scan window: a wall past 2000 units is NOT caught.
        let v = detect_block_in_text(&("a".repeat(2000) + " please verify you are a human"));
        assert!(!v.blocked);
    }

    #[test]
    fn waf_strip_mutated_cleaned_index_quirk() {
        // Indices computed on the ORIGINAL text, applied to the MUTATED
        // buffer (TS extractor.ts 307–317). Hand-computed on:
        //   100×a + "just a moment" + 100×b + "please wait" + 50×c
        let text = "a".repeat(100) + "just a moment" + &"b".repeat(100) + "please wait" + &"c".repeat(50);
        // match1 @100: cut [20,193) → 20×a + " " + orig[193..end]; end =
        // min(total, 100+13+80=193) → 100×b + "please wait" + 50×c… NO:
        // end=193 slices from UNIT 193 = the 80th b → 20×b remain.
        // cleaned = 20×a + " " + 20×b + "please wait" + 50×c (102 units).
        // match2 @213 (byte 213 → units too here): m_start−80=133 > 102 →
        // start=end=102 (end=min(102? no — total_units=102 caps end)) →
        // cleaned = cleaned[..102] + " " + cleaned[102..] = cleaned + " ".
        // Trailing " " trimmed at the end.
        let got = strip_waf_challenge_text(&text);
        let expected = "a".repeat(20) + " " + &"b".repeat(20) + "please wait" + &"c".repeat(50);
        assert_eq!(got, expected);
        assert_eq!(strip_waf_challenge_text(""), "");
        // Single match, small text: window [0, min(15, 2+13+80)) swallows
        // EVERYTHING → lone " " → trim → "".
        assert_eq!(strip_waf_challenge_text("x just a moment y"), "");
    }

    #[test]
    fn waf_strip_turnstile_alternation_prefers_cf_turnstile() {
        // JS alternation order + leftmost semantics: "cf-turnstile" matches
        // the earlier alternative at the same start position, so the bare
        // "turnstile" never starts inside it.
        let got = strip_waf_challenge_text(&("z".repeat(90) + "cf-turnstile" + &"w".repeat(90)));
        // cut window [10, 90+12+80=182] on 192-unit text → 10×z + " " + orig[182..192]
        // — units 182..192 are the LAST 10 of the 90 w's.
        assert_eq!(got, "z".repeat(10) + " " + &"w".repeat(10));
    }

    #[test]
    fn has_meaningful_content_utf16() {
        assert!(has_meaningful_content(&"a b ".repeat(30), 100));
        assert!(!has_meaningful_content("  \n\t  ", 1));
        // CJK counts 1 UTF-16 unit each (BMP)
        assert!(has_meaningful_content(&"字".repeat(100), 100));
        assert!(!has_meaningful_content(&"字".repeat(99), 100));
    }

    #[test]
    fn serp_baseline_shape_and_caps() {
        let r = ranked("https://example.com/x", "T", &"s".repeat(2500));
        let p = serp_baseline_passage(&r).unwrap();
        assert_eq!(p.url, "https://example.com/x");
        // preamble + snippet sliced to 2000 UTF-16 units
        let text = p.passage_text;
        assert!(text.starts_with(
            "[SERP snippet baseline — the page itself was blocked or empty. The following is the search engine's own indexed title + snippet, guaranteed evidence even when every direct connection fails.]\n"
        ));
        assert_eq!(js_len(&text), js_len(SERP_BASELINE_PREAMBLE) + 2000);
        // snippet < 12 → null; falls back to title when snippet empty
        assert!(serp_baseline_passage(&ranked("u", "short title here", "")).is_some());
        assert!(serp_baseline_passage(&ranked("u", "tiny", "")).is_none());
        // trim happens: "   s…   " trims before the 12 check
        assert!(serp_baseline_passage(&ranked("u", "", "    1234567890ab    ")).is_some());
    }

    #[test]
    fn baseline_packets_for_skips_and_caps() {
        let rs = vec![
            ranked("https://example.com/a", "A", "snippet about a, long enough to pass gate"),
            ranked("https://example.com/b", "B", "snippet about b, long enough to pass gate"),
            ranked("https://example.com/c", "C", "snippet about c, long enough to pass gate"),
            ranked("https://example.com/d", "d", ""), // no baseline (title 1 char)
        ];
        let done = std::collections::HashSet::from(["https://example.com/b".to_string()]);
        let out = baseline_packets_for(&rs, &done, 2);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].url, "https://example.com/a");
        assert_eq!(out[1].url, "https://example.com/c"); // skipped b
        assert_eq!(out[0].classification.as_deref(), Some("SUCCESS_SNIPPET_FALLBACK"));
        assert_eq!(out[0].extraction, ExtractionKind::SnippetOnly);
        assert_eq!(out[0].passages.len(), 1);
    }

    #[test]
    fn renumber_and_next_source_index() {
        let mut ps = baseline_packets_for(
            &[ranked("https://example.com/a", "A", "long enough snippet for the gate here")],
            &Default::default(),
            10,
        );
        renumber_packets(&mut ps, 3);
        assert_eq!(ps[0].source_id, "S3");
        assert_eq!(ps[0].passages[0].source_id, "S3");
        assert_eq!(next_source_index(&ps), 4);
        // Non-S ids and garbage are ignored.
        ps[0].source_id = "X9".to_string();
        assert_eq!(next_source_index(&ps), 1);
        ps[0].source_id = "S10".to_string();
        assert_eq!(next_source_index(&ps), 11);
    }

    #[test]
    fn encode_uri_vs_component() {
        // encodeURI keeps the reserved set intact; component encodes it.
        let u = "https://example.com/a?b=c&d=你好 e";
        assert_eq!(
            js_encode_uri(u),
            "https://example.com/a?b=c&d=%E4%BD%A0%E5%A5%BD%20e"
        );
        assert_eq!(
            js_encode_uri_component(u),
            "https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc%26d%3D%E4%BD%A0%E5%A5%BD%20e"
        );
    }

    #[test]
    fn env_concurrency_parses_like_parseint_then_max() {
        assert_eq!(js_parse_int("64x"), Some(64));
        assert_eq!(js_parse_int("  -7"), Some(-7));
        assert_eq!(js_parse_int("abc"), None);
        assert_eq!(js_parse_int(""), None);
        // invalid env → fallback to min (TS would NaN-crash at import)
        std::env::set_var(ENV_JINA_CONCURRENCY, "abc");
        assert_eq!(env_concurrency(ENV_JINA_CONCURRENCY, "6", 6), 6);
        std::env::set_var(ENV_JINA_CONCURRENCY, "64");
        assert_eq!(env_concurrency(ENV_JINA_CONCURRENCY, "6", 6), 64);
        std::env::set_var(ENV_JINA_CONCURRENCY, "2");
        assert_eq!(env_concurrency(ENV_JINA_CONCURRENCY, "6", 6), 6);
        std::env::remove_var(ENV_JINA_CONCURRENCY);
        assert_eq!(env_concurrency(ENV_JINA_CONCURRENCY, "6", 6), 6);
    }

    #[tokio::test]
    async fn direct_success_writes_cache_and_baseline_first() {
        let net = ScriptedNet::default()
            .with_page("https://example.com/good", page(200, true, &healthy_html(), "text/html"));
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let p = ex.extract_url(&ranked("https://example.com/good", "Report", "indexed snippet of the report page, plenty long.")).await.unwrap();
        assert_eq!(p.classification.as_deref(), Some("SUCCESS_DIRECT"));
        assert_eq!(p.extraction, ExtractionKind::Direct);
        // baseline passage FIRST, direct passage second
        assert_eq!(p.passages.len(), 2);
        assert!(p.passages[0].passage_text.starts_with("[SERP snippet baseline"));
        assert!(!p.passages[1].passage_text.starts_with("[SERP snippet baseline"));
        // parking_lot lock() returns the guard directly (no Result).
        let writes = cache.writes.lock();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0], "p:https://example.com/good");
    }

    #[tokio::test]
    async fn blocked_page_cascades_to_jina_fallback() {
        let jina_body = "The full rendered article body from r.jina.ai. ".repeat(10);
        let net = ScriptedNet::default()
            .with_page("https://example.com/blocked", page(200, true, &cf_blocked_html(), "text/html"))
            // encodeURI keeps :// intact
            .with_page("https://r.jina.ai/https://example.com/blocked", page(200, true, &jina_body, "text/plain"));
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let p = ex.extract_url(&ranked("https://example.com/blocked", "Blocked", "a long enough indexed snippet for the baseline.")).await.unwrap();
        assert_eq!(p.classification.as_deref(), Some("SUCCESS_JINA_FALLBACK"));
        assert_eq!(p.extraction, ExtractionKind::JinaFallback);
        assert!(p.passages.last().unwrap().passage_text.starts_with("The full rendered article"));
    }

    #[tokio::test]
    async fn fail_silent_bot_block_when_every_tier_misses() {
        let net = ScriptedNet::default()
            .with_page("https://example.com/waf", page(200, true, &cf_blocked_html(), "text/html"))
            // jina itself returns challenge text
            .with_page(
                "https://r.jina.ai/https://example.com/waf",
                page(200, true, "Checking your browser before accessing… Just a moment…", "text/plain"),
            )
            // wayback: no snapshot anywhere
            .with_url(
                "https://archive.org/wayback/available?url=https%3A%2F%2Fexample.com%2Fwaf",
                urlf(true, r#"{"archived_snapshots":{}}"#),
            )
            .with_url(
                "https://web.archive.org/cdx/search/cdx?url=https%3A%2F%2Fexample.com%2Fwaf&limit=1&output=json&fl=original,timestamp,statuscode&from=2020",
                urlf(true, "[]"),
            );
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let p = ex.extract_url(&ranked("https://example.com/waf", "Waf", "a long enough indexed snippet for the baseline.")).await.unwrap();
        assert_eq!(p.classification.as_deref(), Some("FAIL_SILENT_BOT_BLOCK"));
        assert_eq!(p.extraction, ExtractionKind::SnippetOnly);
        // baseline + blocked-snippet passage
        assert_eq!(p.passages.len(), 2);
        assert_eq!(p.passages[1].passage_text, "a long enough indexed snippet for the baseline.");
    }

    #[tokio::test]
    async fn linkedin_999_classifies_login_wall() {
        // TS gate order: extractDirect's `!ok || body<200` crash fires
        // BEFORE detectBlock, so a 999 must still pass that gate — script
        // ok:true + 250-char body, then status 999 raises the LinkedIn-style
        // blocked reason inside detectBlock.
        let net = ScriptedNet::default()
            .with_page("https://linkedin.com/in/x", page(999, true, &"x".repeat(250), "text/html"));
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let p = ex.extract_url(&ranked("https://linkedin.com/in/x", "Profile", "headline snippet long enough to be evidence here")).await.unwrap();
        assert_eq!(p.classification.as_deref(), Some("FAIL_SILENT_LOGIN_WALL"));
        assert_eq!(p.passages.len(), 2); // baseline + snippet
    }

    #[tokio::test]
    async fn network_crash_short_title_is_fail_empty_js_shell() {
        // Empty snippets put this test on the snippet-fallback branch, so
        // slug_triangulation/url_search_fallback drive the real engine
        // flows (pacer/breaker statics, jitter sleeps) against the
        // ScriptedNet. Same process-wide state the engine/metasearch tests
        // serialize on — take the SAME token (engines.rs convention;
        // reset_engine_state_for_tests try_locks the pacer map).
        let _engine_turn = crate::engines::engine_test_lock().lock().await;
        let net = ScriptedNet::default() // unscripted fetches → None
            .with_page("https://example.com/gone", page(404, false, "nope", "text/html"));
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        // blocked crash → blocked path → FAIL_NETWORK_OR_CRASH (snippet <20, title used)
        let p = ex.extract_url(&ranked("https://example.com/dead", "My Title", "")).await.unwrap();
        assert_eq!(p.classification.as_deref(), Some("FAIL_NETWORK_OR_CRASH"));
        // "" snippet + 8-char title (<12) → NO baseline passage.
        assert_eq!(p.passages.len(), 1);
        assert_eq!(p.passages[0].passage_text, "My Title");
        // 404 <200 body: crash but NOT blocked → empty-shell branch
        let p = ex.extract_url(&ranked("https://example.com/gone", "Gone Title", "")).await.unwrap();
        assert_eq!(p.classification.as_deref(), Some("FAIL_EMPTY_JS_SHELL"));
    }

    #[tokio::test]
    async fn browser_tier_recovers_when_bridge_scripted() {
        let net = ScriptedNet::default()
            .with_page("https://example.com/spa", page(403, false, &"blocked ".repeat(50), "text/html"));
        let bridge = ScriptedBridge::new();
        let one = crate::browser_bridge::OnePassExtraction {
            url: "https://example.com/spa".to_string(),
            final_url: "https://example.com/spa".to_string(),
            title: "SPA".to_string(),
            status: Some(200),
            body_text: "rendered app body text ".repeat(20),
            aria_snapshot: String::new(),
            json_ld: vec![],
            meta: vec![("og:title".to_string(), "OG SPA".to_string()), ("theme-color".to_string(), "#fff".to_string())],
            window_state: vec![("ytInitialData".to_string(), "{not json".to_string())],
            ok: true,
            error: None,
        };
        bridge.with_page("https://example.com/spa", one.clone());
        // bridge pool-exhaustion throw counterpart on another url
        bridge.with_error("https://example.com/boom", "agentBrowser: pool exhausted after 60000ms wait");
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &bridge };
        let p = ex.extract_url(&ranked("https://example.com/spa", "SPA", "long enough indexed snippet for the baseline gate")).await.unwrap();
        assert_eq!(p.classification.as_deref(), Some("SUCCESS_BROWSER"));
        let text = &p.passages.last().unwrap().passage_text;
        assert!(text.contains("## Rendered page body (Playwright stealth Chromium)"));
        assert!(text.contains("# SPA"));
        assert!(text.contains("## Page Metadata (browser)\n- og:title: OG SPA"));
        assert!(!text.contains("theme-color")); // meta filter drops non-og keys
        assert_eq!(bridge.call_count(), 1);

        // Bridge ok:false/503 → extractBrowser marks blocked (status in
        // {403,429,503}) → jina/wayback unscripted → None → the blocked
        // classification tail (reason "browser returned little content"
        // matches neither login nor bot regexes).
        let mut bad = one.clone();
        bad.ok = false;
        bad.status = Some(503);
        bad.error = Some("nav failed".to_string());
        bridge.with_page("https://example.com/spa2", bad);
        let p = ex
            .extract_url(&ranked("https://example.com/spa2", "SPA2", "long enough indexed snippet for the baseline gate"))
            .await
            .unwrap();
        assert_eq!(p.classification.as_deref(), Some("FAIL_NETWORK_OR_CRASH"));
        assert_eq!(bridge.call_count(), 2);
    }

    #[tokio::test]
    async fn wayback_success_labels_jina_fallback_but_classifies_wayback() {
        let snap_html = healthy_html();
        let net = ScriptedNet::default()
            .with_page("https://example.com/dead2", page(500, false, &"err ".repeat(60), "text/html"))
            .with_url(
                "https://archive.org/wayback/available?url=https%3A%2F%2Fexample.com%2Fdead2",
                urlf(true, r#"{"archived_snapshots":{"closest":{"url":"https://web.archive.org/web/20230101000000/https://example.com/dead2","timestamp":"20230101000000","status":"200"}}}"#),
            )
            .with_page(
                "https://web.archive.org/web/20230101000000/https://example.com/dead2",
                page(200, true, &snap_html, "text/html"),
            );
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let p = ex.extract_url(&ranked("https://example.com/dead2", "Dead", "long enough indexed snippet for the baseline gate")).await.unwrap();
        assert_eq!(p.classification.as_deref(), Some("SUCCESS_WAYBACK"));
        // QUIRK: label reuse — extraction says jina-fallback, cache tier wayback
        assert_eq!(p.extraction, ExtractionKind::JinaFallback);
        assert!(p.passages.last().unwrap().passage_text.starts_with("## Wayback Machine snapshot of https://example.com/dead2"));
    }

    #[tokio::test]
    async fn cache_hit_maps_tier_to_classification_without_network() {
        struct HitCache;
        impl crate::cache::SearchCache for HitCache {
            fn get_cached_query(&self, _: &[String]) -> Result<Option<crate::cache::QueryCacheHit>, CacheError> { Ok(None) }
            fn put_cached_query(&self, _: &[String], _: &Value, _: &[RankedResult], _: &str) -> Result<(), CacheError> { Ok(()) }
            fn get_cached_page(&self, _: &str) -> Result<Option<CachedPage>, CacheError> {
                Ok(Some(CachedPage { extracted: "x".repeat(300), tier: "wayback".to_string() }))
            }
            fn put_cached_page(&self, _: &str, _: &str, _: PageTier) -> Result<(), CacheError> { Ok(()) }
            fn purge_expired(&self) -> Result<usize, CacheError> { Ok(0) }
            fn close(&self) -> Result<(), CacheError> { Ok(()) }
        }
        let net = ScriptedNet::default();
        let ex = Extractor { net: &net, cache: &HitCache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let p = ex.extract_url(&ranked("https://example.com/c", "C", "long enough snippet baseline")).await.unwrap();
        assert_eq!(p.classification.as_deref(), Some("SUCCESS_WAYBACK"));
        assert_eq!(p.extraction, ExtractionKind::Direct); // jina-only exception
        assert_eq!(p.passages.len(), 2);
        assert_eq!(p.passages[1].passage_text.chars().count(), 300); // no truncation
        assert!(net.calls.lock().unwrap().is_empty()); // zero network
    }

    #[tokio::test]
    async fn cache_throw_propagates_like_promise_rejection() {
        let net = ScriptedNet::default();
        let cache = ScriptedCache::default();
        cache.set_throw(true);
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let e = ex.extract_url(&ranked("https://example.com/x", "X", "s")).await.unwrap_err();
        assert!(matches!(e, CacheError::Scripted), "{e:?}");
    }

    #[tokio::test]
    async fn extract_all_assigns_sids_counts_pages_and_propagates_errors() {
        let body = healthy_html();
        let net = ScriptedNet::default()
            .with_page("https://example.com/a", page(200, true, &body, "text/html"))
            .with_page("https://example.com/b", page(200, true, &body, "text/html"));
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let counts = std::sync::Mutex::new(Vec::new());
        let ranked_v = vec![
            ranked("https://example.com/a", "A", "snippet a long enough for baseline"),
            ranked("https://example.com/b", "B", "snippet b long enough for baseline"),
            ranked("https://example.com/c", "C", "snippet c long enough for baseline"),
        ];
        let out = ex
            .extract_all(&ranked_v, 2, Some(&|d: usize, t: usize| counts.lock().unwrap().push((d, t))), None)
            .await
            .unwrap();
        assert_eq!(out.len(), 2); // maxUrls=2 → C never extracted
        assert_eq!(out[0].source_id, "S1");
        assert_eq!(out[1].source_id, "S2");
        assert!(out[0].passages.iter().all(|p| p.source_id == "S1"));
        assert_eq!(*counts.lock().unwrap(), vec![(1, 2), (2, 2)]);

        // Any cache rejection rejects the whole batch (Promise.all).
        cache.set_throw(true);
        assert!(ex.extract_all(&ranked_v, 2, None, None).await.is_err());
    }

    /// §11.3: a net whose every tier call hangs (never returns) reproduces
    /// the live 3m51s stall shape deterministically — the per-page budget
    /// must abandon the cascade at the cap.
    struct SlowNet;
    impl crate::net::Net for SlowNet {
        fn fetch_page(
            &self,
            _: &str,
            _: &FetchPageOpts,
        ) -> futures_util::future::BoxFuture<'_, Option<PageResponse>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                None
            })
        }
        fn fetch_url(
            &self,
            _: &str,
            _: &UrlFetchOpts,
        ) -> futures_util::future::BoxFuture<'_, Option<UrlFetchResult>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                None
            })
        }
        fn fetch_with_link_preview_bots(
            &self,
            _: &str,
            _: u64,
            _: usize,
        ) -> futures_util::future::BoxFuture<'_, Option<PageResponse>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                None
            })
        }
    }

    #[tokio::test]
    async fn page_budget_abandons_slow_page_into_snippet_fallback() {
        let net = SlowNet;
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let ranked_v = vec![ranked(
            "https://dead.example/slow",
            "Slow Site",
            "indexed snippet long enough for the baseline gate",
        )];
        let counts = std::sync::Mutex::new(Vec::new());
        let t0 = std::time::Instant::now();
        let out = ex
            .extract_all(
                &ranked_v,
                10,
                Some(&|d: usize, t: usize| counts.lock().unwrap().push((d, t))),
                Some(300),
            )
            .await
            .unwrap();
        let elapsed = t0.elapsed();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source_id, "S1"); // still numbered — bundle shape unchanged
        assert_eq!(out[0].classification.as_deref(), Some("PAGE_BUDGET_TIMEOUT"));
        assert_eq!(out[0].extraction, ExtractionKind::SnippetOnly);
        assert_eq!(out[0].passages.len(), 1);
        assert!(out[0].passages[0].passage_text.starts_with("[SERP snippet baseline"));
        assert_eq!(*counts.lock().unwrap(), vec![(1, 1)]); // progress counted, no hang
        assert!(elapsed < Duration::from_secs(10), "budget must cap the page: {elapsed:?}");
    }

    #[test]
    fn timeout_fallback_packet_shape_mirrors_terminal_fallback() {
        let with_base =
            timeout_fallback_packet(&ranked("https://e/x", "Title Here", "a snippet long enough for baseline"));
        assert_eq!(with_base.classification.as_deref(), Some("PAGE_BUDGET_TIMEOUT"));
        assert_eq!(with_base.extraction, ExtractionKind::SnippetOnly);
        assert_eq!(with_base.passages.len(), 1);
        assert!(with_base.passages[0].passage_text.starts_with("[SERP snippet baseline"));
        // No baseline (snippet AND title under 12 chars): the title carries
        // the passage; an empty title yields the marker text.
        let tiny = timeout_fallback_packet(&ranked("https://e/y", "Ti", "ab"));
        assert_eq!(tiny.passages[0].passage_text, "Ti");
        let none = timeout_fallback_packet(&ranked("https://e/z", "", "ab"));
        assert_eq!(
            none.passages[0].passage_text,
            "(page read timed out — no content extracted)"
        );
    }

    #[tokio::test]
    async fn adapter_seam_none_without_verticals() {
        let net = ScriptedNet::default();
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        assert!(ex.extract_adapter("https://reddit.com/r/x").await.is_none());
    }

    #[tokio::test]
    async fn non_html_document_hits_direct_gate_before_metadata() {
        let rows: Vec<Value> = (0..40)
            .map(|i| serde_json::json!({"id": i, "name": format!("row {i} with descriptive text")}))
            .collect();
        let json = serde_json::json!({"rows": rows}).to_string();
        assert!(json.len() >= 200);
        let net = ScriptedNet::default()
            .with_page("https://example.com/api.json", page(200, true, &json, "application/json"));
        let cache = ScriptedCache::default();
        let ex = Extractor { net: &net, cache: &cache, verticals: &NoVerticals, bridge: &NoBrowserBridge };
        let p = ex.extract_url(&ranked("https://example.com/api.json", "API", "long enough snippet baseline for gate")).await.unwrap();
        // TS gate order is truth: pretty-printed JSON yields ≥200 chars of
        // document markdown, so the tier-1 DIRECT gate fires BEFORE the
        // metadata gate. SUCCESS_METADATA needs a 100..200-char document
        // (markdown length) — nearly unreachable by design.
        assert_eq!(p.classification.as_deref(), Some("SUCCESS_DIRECT"));
        assert_eq!(p.extraction, ExtractionKind::Direct);
    }
}
