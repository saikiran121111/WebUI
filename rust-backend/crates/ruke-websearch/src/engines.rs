//! OWNER: W2 — parity port of `lib/web-search/engines.ts` (1564 lines).
//!
//! Universal general-web search engine pool: per-engine SERP scrapers,
//! per-engine pacing + circuit breaker, and the pool runners.
//!
//! # Net seam (W2's scripted SERP table)
//! Every engine call goes through [`net::Net`] — `fetch_page` for the
//! got-scraping page path (priming GETs + SERP HTML) and `fetch_url` for the
//! form-POST / RSS / JSON path. Unit tests drive every parser
//! deterministically by scripting exact request URLs on
//! [`net::ScriptedNet`]:
//! - `with_page(url, PageResponse)` scripts a `fetch_page` response
//!   (status/ok/body/cookies all under test control);
//! - `with_url(url, UrlFetchResult)` scripts a `fetch_url` response;
//! - an un-scripted seam call returns `None` — the equivalent of TS's
//!   `try { fetch } catch { [] }` dead-engine path;
//! - `ScriptedNet::calls` records `(url, "fetch_page"|"fetch_url")` in
//!   order, asserting each engine's stage cascade.
//!   `is_safe_url` is NOT mocked: it runs REAL (fixtures-README mock boundary).
//!
//! # Scripting recipes (exact URLs the builders emit)
//! - DDG html:  page `https://html.duckduckgo.com/html/` (prime) +
//!   url  `https://html.duckduckgo.com/html/` (POST)
//! - DDG lite:  page `https://lite.duckduckgo.com/lite/?q=test` (prime) +
//!   url  `https://lite.duckduckgo.com/lite/` (POST)
//! - Google:    page `https://www.google.com/search?q=<enc>&num=20&hl=en&gl=us`
//! - Brave:     page `https://search.brave.com/search?q=<enc>&source=web`
//! - Yahoo:     page `https://in.search.yahoo.com/search?p=<enc>&n=15` (then
//!   `https://search.yahoo.com/search?p=<enc>&n=15`)
//! - Bing:      url  `https://www.bing.com/search?q=<enc>&format=rss&count=15`;
//!   HTML fallback: page `https://www.bing.com/` (prime) +
//!   page `https://www.bing.com/search?q=<enc>&setlang=en&cc=US`
//! - Reddit:    url  `https://www.reddit.com/search.rss?q=<enc>&sort=relevance&limit=20`
//!   (then old.reddit RSS → pullpush → search.json)
//! - Bing News: url  `https://www.bing.com/news/search?q=<enc>&format=rss&count=20`
//!   (then `https://news.google.com/rss/search?q=<enc>&hl=en-IN&gl=IN&ceid=IN:en`)
//! - GitHub:    url  `https://api.github.com/search/{users,repositories,issues}?q=<enc>&per_page=N`
//! - Dev.to:    url  `https://dev.to/api/articles?per_page=15&top=365&tag=<tag>` +
//!   `https://dev.to/search/feed_content?per_page=15&page=0&class_name=Article&search_fields=<enc>`
//!   where `<enc>` is JS `encodeURIComponent` (space → `%20`, not `+`).
//!
//! # Recorded TS quirks (reproduced, not fixed)
//! - DDG/VQD/Bing-News "double decode": `searchParams.get(k)` already
//!   percent-decodes; TS then wraps it in `decodeURIComponent(...)` AGAIN —
//!   ports with query_pairs + a second `percent_decode_str`.
//! - Yahoo RU regex `RU=([^&/]+)(?:\/RK=|$)` runs on `u.href`; the
//!   `searchParams.get("RU")` branch only fires for query-string RU links,
//!   the path-style `/RU=…/RK=` links take the regex branch.
//! - `decodeBingCk`'s "direct (no ck/a wrapper)" branch is dead: both arms
//!   `return u.href` — kept verbatim.
//! - `ddgVqd` (Stage C) and `EngineBudget` are defined but never called by
//!   any engine (VQD is skipped whenever lite 0-returns); kept with
//!   `allow(dead_code)`.
//! - `PRIME_TIMEOUT_MS` constant is unused in TS — kept unused.
//! - One zero-result observation per engine CALL (not per stage); the
//!   breaker trips only on the SECOND consecutive zero within
//!   `ZERO_STREAK_WINDOW_MS`.
//! - `GENERAL_WEB_ENGINES` order is ddg, ddg-lite, google, bing, yahoo,
//!   brave, reddit (NOT the doc-comment backbone order); merged results keep
//!   that concatenation order and per-engine ranks.
//! - `deduplicateQueries`: TS header claims ">80% token overlap" but the
//!   math is `|A∩B| / max(1, min(|A|,|B|)) > 0.8` (Jaccard-min) — the biryani
//!   example in the TS header actually measures 0.6 and would NOT collapse;
//!   ported formula as-is. `split(/\s+/)`-style token filter `length > 2`
//!   counts UTF-16 units.
//! - Yahoo regional loop swallows per-region errors and tries the next URL;
//!   `h3.title` matches carry no `href` and are skipped by the href guard.
//! - GitHub: `repo.name` has NO `??` fallback in TS (missing name ⇒
//!   `undefined` title) — Rust's `RawSearchResult.title: String` forces `""`
//!   (recorded divergence below).
//!
//! # Unavoidable Rust-vs-JS divergences
//! - DOM: linkedom (`parseHTML` + `querySelectorAll`) ⇔ scraper/html5ever —
//!   both are lenient parsers but tree-recovery differs on malformed HTML.
//!   Comma-separated selector lists: linkedom returns matches interleaved in
//!   DOCUMENT order and de-duplicated; scraper yields per-alternative groups,
//!   so we de-duplicate by node identity but keep per-alternative order —
//!   irrelevant for every engine here (rank numbering only depends on the
//!   final order within a homogeneous block list).
//! - `linkedom.textContent` vs scraper `.text()`: equivalent for the SERP
//!   shapes here (script/style text is included by both).
//! - `Math.random` jitter: no `rand` crate in the frozen manifest — a
//!   splitmix64/xorshift seeded from the clock is used instead; only the
//!   250–449 / 150–299 ms ranges matter for pacing parity.
//! - `new Date(created_utc*1000).toISOString()` ⇔ chrono RFC3339 with
//!   forced-millis UTC ("…sssZ") — identical for in-range values; an
//!   out-of-range `created_utc` throws in JS (whole stage caught → next
//!   stage) and returns `None` (→ whole stage `[]`) here.
//! - `undefined` fields (`title: repo.name` w/o fallback, non-string JSON)
//!   collapse to `""`/lossy strings because `RawSearchResult` is typed.
//! - `Promise.allSettled` + `Array.flat` ⇔ `join_all` + concat — same merge
//!   order; engine `.catch(() => [])` is trivially replicated because no
//!   Rust stage function throws (parse failures already yield empty vecs).
//! - JS `.length`/`.slice(0, n)` are UTF-16 units — mirrored via
//!   `js_len`/`js_slice_max`.
//! - Header construction: TS engines build full `realisticHeaders()`/
//!   `apiHeaders()` objects at the call site; net.rs already applies those
//!   bases internally (`use_realistic_headers`/fingerprint options), so
//!   engines pass only the semantic extras (referer/cookie/accept/…) —
//!   `ScriptedNet` ignores headers entirely.
//! - `linkedom` `decodeURIComponent` throws on malformed `%` escapes and the
//!   whole decode falls back to `href` via try/catch;
//!   `percent_decode_str` is lossy (keeps invalid `%` sequences as-is).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::future::{join_all, BoxFuture};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde_json::Value;
use url::Url;

use crate::net::{CookieJar, FetchPageOpts, Net, UrlFetchOpts};
use crate::ssrf::is_safe_url;
use crate::types::RawSearchResult;

// ── constants (engines.ts 38-58, 86-98, 323, 395) ───────────────────────

/// TS `ENGINE_TIMEOUT_MS`.
const ENGINE_TIMEOUT_MS: u64 = 40_000;
/// TS `PRIME_TIMEOUT_MS` — declared but never referenced in TS; kept.
#[allow(dead_code)]
const PRIME_TIMEOUT_MS: u64 = 12_000;
/// TS `ENGINE_WALL_CLOCK_MS` — only referenced by the never-instantiated
/// `EngineBudget` (dead in TS); kept for parity.
#[allow(dead_code)]
const ENGINE_WALL_CLOCK_MS: i64 = 55_000;

const ENGINE_COOLDOWN_MS: i64 = 60_000;
const ZERO_STREAK_TO_TRIP: i64 = 2;
const ZERO_STREAK_WINDOW_MS: i64 = 120_000;

const DDG_STAGE_TIMEOUT_MS: u64 = 12_000;
const DDG_LITE_TIMEOUT_MS: u64 = 6_000;

/// TS `class EngineBudget` — never constructed anywhere in TS (dead);
/// reproduced verbatim.
#[allow(dead_code)]
struct EngineBudget {
    deadline: i64,
}

#[allow(dead_code)]
impl EngineBudget {
    fn new() -> Self {
        Self {
            deadline: now_ms() + ENGINE_WALL_CLOCK_MS,
        }
    }
    /// ms remaining before the engine gives up; 0 if the budget is exhausted.
    fn remaining(&self) -> i64 {
        (self.deadline - now_ms()).max(0)
    }
    /// True when at least `need` ms are left (callers pass a short need so a
    /// near-dead budget still allows one quick probe). TS default `has(ms = 1000)`.
    fn has(&self, ms: i64) -> bool {
        self.remaining() >= ms
    }
    /// A sensible per-fetch timeout: the smaller of the engine's own cap and
    /// what's left in the budget.
    fn timeout(&self, max_ms: i64) -> i64 {
        (max_ms).min(self.remaining()).max(5_000)
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// `Math.random()` stand-in (no `rand` in the frozen manifest): splitmix64
/// seed + xorshift64* stream → [0,1). Divergence recorded in module docs.
static JITTER_STATE: AtomicU64 = AtomicU64::new(0);
fn js_random() -> f64 {
    let seed = JITTER_STATE.fetch_add(1, Ordering::Relaxed);
    let mut z = (now_ms() as u64)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(seed | 1);
    z ^= z >> 30;
    z = z.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z ^= z >> 27;
    z = z.wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    // 53-bit mantissa like Math.random.
    ((z >> 11) as f64) / (1u64 << 53) as f64
}

/// JS `encodeURIComponent` set: alphanumerics + `-_.!~*'()` pass through.
const URI_COMPONENT_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn enc_component(s: &str) -> String {
    utf8_percent_encode(s, URI_COMPONENT_SET).to_string()
}

/// JS `String.prototype.length` (UTF-16 code units).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(0, max_units)` on UTF-16 units.
fn js_slice_max(s: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for ch in s.chars() {
        let w = ch.len_utf16();
        if units + w > max_units {
            break;
        }
        units += w;
        out.push(ch);
    }
    out
}

/// JS `body.slice(0, 3000)` head (UTF-16 units; a split surrogate pair is
/// kept as an unpaired code point — only used against an ASCII regex).
fn js_head(s: &str, max_units: usize) -> String {
    js_slice_max(s, max_units)
}

// ── per-engine pacing & circuit breaker (engines.ts 76-226) ─────────────

fn cooldown_map() -> &'static Mutex<HashMap<String, i64>> {
    static M: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn streak_map() -> &'static Mutex<HashMap<String, (i64, i64)>> {
    static M: OnceLock<Mutex<HashMap<String, (i64, i64)>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Consecutive trips per engine (cleared by a real success) — drives the
/// exponential cooldown escalation (60/120/240/480 s). Health knowledge is
/// cross-request and bounded: one entry per engine name, never a blacklist.
fn trip_count_map() -> &'static Mutex<HashMap<String, u32>> {
    static M: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// TS `enginePacers` — the tokio Mutex standing in for p-limit(1) serializes
/// the jitter window only (TS holds the pLimit slot just for the scheduling
/// section, never across the actual fetch).
fn pacer_map() -> &'static tokio::sync::Mutex<HashMap<String, i64>> {
    static M: OnceLock<tokio::sync::Mutex<HashMap<String, i64>>> = OnceLock::new();
    M.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// TS `engineIsCoolingDown` — expired entries are deleted on read.
fn engine_is_cooling_down(engine: &str) -> bool {
    let m = cooldown_map();
    let mut m = m.lock().expect("cooldown map lock");
    if let Some(&until) = m.get(engine) {
        if now_ms() >= until {
            m.remove(engine);
            return false;
        }
        return true;
    }
    false
}

/// TS `engineCooldownRemainingMs` (exported).
pub fn engine_cooldown_remaining_ms(engine: &str) -> i64 {
    let m = cooldown_map();
    let m = m.lock().expect("cooldown map lock");
    match m.get(engine) {
        Some(&until) => (until - now_ms()).max(0),
        None => 0,
    }
}

/// TS `tripCircuitBreaker` — one zero observation per call; trips on the
/// SECOND consecutive zero inside `ZERO_STREAK_WINDOW_MS`.
pub(crate) fn trip_circuit_breaker(engine: &str, reason: &str) {
    let now = now_ms();
    let streak = {
        let sm = streak_map();
        let mut sm = sm.lock().expect("streak map lock");
        let streak = match sm.get(engine) {
            Some(&(count, at)) if now - at <= ZERO_STREAK_WINDOW_MS => count + 1,
            _ => 1,
        };
        if streak < ZERO_STREAK_TO_TRIP {
            sm.insert(engine.to_string(), (streak, now));
            tracing::info!(
                engine = engine,
                reason = reason,
                streak,
                "engine 0-result outcome — breaker not tripped yet (single zero may be query-specific)"
            );
            return;
        }
        sm.remove(engine);
        streak
    };
    let _ = streak;
    // Escalation: repeated trips back off exponentially (60/120/240/480 s),
    // cleared by any real success. A single zero stays query-specific.
    let trips = {
        let tm = trip_count_map();
        let mut tm = tm.lock().expect("trip count lock");
        let c = tm.entry(engine.to_string()).or_insert(0);
        *c += 1;
        *c
    };
    let cooldown = ENGINE_COOLDOWN_MS << (trips - 1).min(3);
    cooldown_map()
        .lock()
        .expect("cooldown map lock")
        .insert(engine.to_string(), now + cooldown);
    tracing::info!(
        engine = engine,
        reason = reason,
        cooldown_ms = cooldown,
        consecutive_trips = trips,
        "engine circuit breaker tripped"
    );
}

/// Transport failure (fetch → None/timeout) is never query-specific: cool the
/// engine down on the first observation instead of waiting for a second zero.
fn trip_immediate(engine: &str, reason: &str) {
    streak_map().lock().expect("streak map lock").remove(engine);
    let trips = {
        let tm = trip_count_map();
        let mut tm = tm.lock().expect("trip count lock");
        let c = tm.entry(engine.to_string()).or_insert(0);
        *c += 1;
        *c
    };
    let cooldown = ENGINE_COOLDOWN_MS << (trips - 1).min(3);
    cooldown_map()
        .lock()
        .expect("cooldown map lock")
        .insert(engine.to_string(), now_ms() + cooldown);
    tracing::info!(
        engine = engine,
        reason = reason,
        cooldown_ms = cooldown,
        "engine transport failure — breaker tripped immediately"
    );
}

/// TS `noteEngineSuccess` — a real success clears BOTH the zero streak and
/// the escalation history (the engine is healthy again).
pub(crate) fn note_engine_success(engine: &str) {
    streak_map()
        .lock()
        .expect("streak map lock")
        .remove(engine);
    trip_count_map()
        .lock()
        .expect("trip count lock")
        .remove(engine);
}

/// Clears all pacing/breaker state. TS module state lives for the whole
/// process; this test-support helper exists because cargo runs #[test]s in
/// parallel threads (divergence recorded in module docs).
#[cfg(test)]
pub(crate) fn reset_engine_state_for_tests() {
    cooldown_map().lock().expect("lock").clear();
    streak_map().lock().expect("lock").clear();
    trip_count_map().lock().expect("lock").clear();
    // try_lock (not blocking_lock): the pacer holds only scheduling
    // timestamps (absolute epoch-ms), so a stale map across tests just adds
    // one jitter window to the next call — harmless. Since the verticals
    // went pacer-guarded, non-token tests can be queued on this mutex while
    // a token test resets, so a hard expect() here is a cross-module race.
    if let Ok(mut pm) = pacer_map().try_lock() {
        pm.clear();
    }
}

/// Test-only serialization token: engine-level flows share the (process-wide,
/// TS-parity) breaker/pacer statics, so these tests take turns. pub(crate):
/// metasearch's pool-fanning integration tests take the SAME token.
#[cfg(test)]
pub(crate) fn engine_test_lock() -> &'static tokio::sync::Mutex<()> {
    static M: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    M.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// TS `enginePacerWithBreaker` — true ⇒ allowed, false ⇒ skipped.
/// pub(crate): the metasearch vertical fetchers were unguarded (bench
/// 2026-10-29: 429 storms with zero pacing) and now share this guard.
pub(crate) async fn engine_pacer_with_breaker(engine: &str) -> bool {
    if engine_is_cooling_down(engine) {
        return false;
    }
    let mut map = pacer_map().lock().await;
    if engine_is_cooling_down(engine) {
        return false;
    }
    // Jitter: stagger consecutive calls to the same engine by 250–450 ms.
    let jitter = (js_random() * 200.0).floor() as i64 + 250;
    let entry = map.entry(engine.to_string()).or_insert(0);
    let elapsed = now_ms() - *entry;
    if elapsed < jitter {
        tokio::time::sleep(Duration::from_millis((jitter - elapsed) as u64)).await;
    }
    // Re-borrow after await (entry could have moved if the map grew).
    let entry = map.entry(engine.to_string()).or_insert(0);
    *entry = now_ms();
    drop(map);
    true
}

// ── helpers (engines.ts 228-307) ─────────────────────────────────────────

/// TS `docOf(parseHTML)`.
fn doc_of(html: &str) -> Html {
    Html::parse_document(html)
}

/// linkedom-style comma-separated selector list ⇒ scraper Selectors
/// (scraper's `Selector::parse` rejects lists, so we split — divergence
/// recorded: per-alternative order instead of document order).
fn parse_sels(patterns: &str) -> Vec<Selector> {
    patterns
        .split(',')
        .filter_map(|p| Selector::parse(p.trim()).ok())
        .collect()
}

fn is_same_node(a: &ElementRef<'_>, b: &ElementRef<'_>) -> bool {
    a == b
}

/// querySelectorAll over a comma list with de-dup (DOM APIs never repeat a
/// node across alternatives).
fn query_all<'a>(root: &'a Html, patterns: &str) -> Vec<ElementRef<'a>> {
    let mut out: Vec<ElementRef<'a>> = Vec::new();
    for sel in parse_sels(patterns) {
        for el in root.select(&sel) {
            if !out.iter().any(|x| is_same_node(x, &el)) {
                out.push(el);
            }
        }
    }
    out
}

fn query_all_el<'a>(el: &ElementRef<'a>, patterns: &str) -> Vec<ElementRef<'a>> {
    let mut out: Vec<ElementRef<'a>> = Vec::new();
    for sel in parse_sels(patterns) {
        for sub in el.select(&sel) {
            if !out.iter().any(|x| is_same_node(x, &sub)) {
                out.push(sub);
            }
        }
    }
    out
}

/// querySelector (first match per alternative; per-alternative order).
fn query_first<'a>(el: &ElementRef<'a>, patterns: &str) -> Option<ElementRef<'a>> {
    query_all_el(el, patterns).into_iter().next()
}

/// linkedom `el.closest("a, b")` (includes self, nearest ancestor first).
fn closest<'a>(el: &ElementRef<'a>, patterns: &str) -> Option<ElementRef<'a>> {
    let sels = parse_sels(patterns);
    for node in el.ancestors() {
        if let Some(anc) = ElementRef::wrap(node) {
            if sels.iter().any(|s| s.matches(&anc)) {
                return Some(anc);
            }
        }
    }
    None
}

/// linkedom `textContent?.trim() ?? ""`.
fn text_trim(el: &ElementRef<'_>) -> String {
    el.text().collect::<String>().trim().to_string()
}

fn attr(el: &ElementRef<'_>, name: &str) -> String {
    el.attr(name).unwrap_or("").to_string()
}

/// WHATWG-style base resolution: `new URL(href, base)` — url-encoding
/// differences between url::Url and WHATWG left un-mirrored (recorded
/// generally in module docs). `None` where JS would throw.
fn resolve_url(base: &str, href: &str) -> Option<Url> {
    let b = Url::parse(base).ok()?;
    // Absolute input parses directly; relative goes through join.
    match Url::parse(href) {
        Ok(u) => Some(u),
        Err(_) => b.join(href).ok(),
    }
}

/// TS `decodeUddg` — `/l/?uddg=<encoded>` redirect decode (double-decode
/// quirk: searchParams value is decoded AGAIN via decodeURIComponent).
fn decode_uddg(href: &str) -> String {
    let u = match resolve_url("https://duckduckgo.com", href) {
        Some(u) => u,
        None => return href.to_string(),
    };
    if let Some((_, v)) = u.query_pairs().find(|(k, _)| k == "uddg") {
        // JS: decodeURIComponent(uddg) — uddg is already query-pairs decoded ⇒
        // a SECOND percent-decode pass (parity quirk).
        return percent_decode_str(v.as_ref()).decode_utf8_lossy().into_owned();
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"uddg=([^&]+)").unwrap());
    if let Some(c) = re.captures(u.as_str()) {
        return percent_decode_str(&c[1]).decode_utf8_lossy().into_owned();
    }
    u.as_str().to_string()
}

/// TS `unwrapRuHref` — Yahoo/AOL `RU=<encoded>/RK=` unwrap.
fn unwrap_ru_href(href: &str, base: &str) -> String {
    let u = match resolve_url(base, href) {
        Some(u) => u,
        None => return href.to_string(),
    };
    if let Some((_, v)) = u.query_pairs().find(|(k, _)| k == "RU") {
        return percent_decode_str(v.as_ref()).decode_utf8_lossy().into_owned();
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"RU=([^&/]+)(?:/RK=|$)").unwrap());
    if let Some(c) = re.captures(u.as_str()) {
        return percent_decode_str(&c[1]).decode_utf8_lossy().into_owned();
    }
    u.as_str().to_string()
}

/// TS `unwrapGoogleHref` — legacy `/url?q=` redirect decode.
fn unwrap_google_href(href: &str) -> String {
    let u = match resolve_url("https://www.google.com", href) {
        Some(u) => u,
        None => return href.to_string(),
    };
    if u.path() == "/url" {
        if let Some((_, v)) = u.query_pairs().find(|(k, _)| k == "q") {
            return percent_decode_str(v.as_ref()).decode_utf8_lossy().into_owned();
        }
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"[?&]url=([^&]+)").unwrap());
        if let Some(c) = re.captures(u.as_str()) {
            return percent_decode_str(&c[1]).decode_utf8_lossy().into_owned();
        }
    }
    u.as_str().to_string()
}

/// Node `Buffer.from(s, "base64").toString("utf8")` — forgiving:
/// non-alphabet characters are skipped, padding optional, invalid UTF-8 →
/// U+FFFD (lossy).
fn node_base64_decode(s: &str) -> String {
    static ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits: u32 = 0;
    let mut nbits: u32 = 0;
    let mut bytes: Vec<u8> = Vec::new();
    for &b in s.as_bytes() {
        if b == b'=' {
            break;
        }
        let idx = match ALPHA.iter().position(|&c| c == b) {
            Some(i) => i as u32,
            None => continue, // Node skips non-alphabet chars
        };
        bits = (bits << 6) | idx;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            bytes.push((bits >> nbits) as u8);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// TS `decodeBingCk` — Bing `ck/a?...&u=a1<base64>` link decoder. The
/// "direct (no ck/a wrapper)" branch is DEAD in TS (both arms return u.href);
/// reproduced verbatim.
fn decode_bing_ck(href: &str) -> String {
    let u = match resolve_url("https://www.bing.com", href) {
        Some(u) => u,
        None => return href.to_string(),
    };
    let u_param = u.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.into_owned());
    if let Some(up) = u_param {
        if let Some(b64) = up.strip_prefix("a1") {
            // strip the "a1" prefix
            let decoded = node_base64_decode(b64);
            if decoded.starts_with("http") {
                return decoded;
            }
        }
    }
    let href_s = u.as_str().to_string();
    if href_s.starts_with("http") && !href_s.contains("bing.com/ck/") {
        return href_s;
    }
    href_s
}

fn re_blocked() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)verifyngo|challenge|anomaly|captcha|please enable javascript|not a robot")
            .unwrap()
    })
}

/// TS `isBlocked` — ONLY safe as a secondary check after parse found 0
/// results (module-parity comment preserved: engines embed "captcha"
/// strings in boilerplate scripts on valid 200 SERPs).
fn is_blocked(body: &str) -> bool {
    if js_len(body) < 500 {
        return true;
    }
    let head = js_head(body, 3000);
    re_blocked().is_match(&head)
}

/// TS `hasSerResults` — `engineDomain` parameter is IGNORED in the TS body
/// (dead param, kept in signature for parity).
///
/// The TS regex
/// `/href="(https?:\/\/(?!www\.[\w.-]+\.(com|org|…|pro)[\w.-]*\/))[^"]+/gi`
/// relies on a negative lookahead, which the regex crate cannot express.
/// Divergence-recorded equivalent: manual scanner anchored on the regex
/// `(?i)href="https?://` plus an explicit replication of the lookahead
/// semantics (ASCII `\w` = alphanumeric+underscore, JS case-insensitivity).
#[allow(unused_variables)]
#[allow(dead_code)] // parity: `hasSerResults` is only reachable from the dead `isBlockedAfterParse` in engines.ts
fn has_ser_results(html: &str, engine_domain: Option<&str>, min_results: usize) -> bool {
    let mut links = 0usize;
    let mut idx = 0usize;
    while let Some(m) = re_href_scheme().find_at(html, idx) {
        let scheme_end = m.end(); // right after "://"
        let rest = &html[scheme_end..];
        let nonquote: usize = rest.chars().take_while(|&c| c != '"').count();
        // JS `[^"]+` needs ≥1 char; the lookahead must NOT match.
        if nonquote >= 1 && !ser_excluded_host(rest) {
            links += 1;
            // JS /g resumes after the whole match (up to the closing ").
            idx = scheme_end + nonquote;
        } else {
            idx = m.start() + 1;
        }
    }
    links >= min_results
}

#[allow(dead_code)] // parity: reachable only from the dead SERP helpers below
fn re_href_scheme() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)href="https?://"#).unwrap())
}

/// The `www\.[\w.-]+\.(com|org|net|in|co|dev|io|me|uk|cc|ad|cloud|xyz|
/// online|top|site|info|biz|pro)[\w.-]*\/` lookahead body, evaluated by hand
/// at the position right after `http(s)://`. Existence semantics (JS
/// backtracking): some split `[\w.-]+` / `.` / tld-prefix / `[\w.-]*` / `/`
/// within the maximal [\w.-] run.
#[allow(dead_code)] // parity: reachable only from the dead SERP helpers below
fn ser_excluded_host(rest: &str) -> bool {
    const TLDS: [&str; 19] = [
        "com", "org", "net", "in", "co", "dev", "io", "me", "uk", "cc", "ad", "cloud", "xyz",
        "online", "top", "site", "info", "biz", "pro",
    ];
    // to_ascii_lowercase is byte-length preserving; JS /i folds ASCII only in
    // this pattern's classes, so ASCII folding is the faithful equivalent.
    let lb = rest.to_ascii_lowercase();
    let b = lb.as_bytes();
    if b.len() < 4 || &b[..4] != b"www." {
        return false;
    }
    let p = 4usize; // just past "www."
    // Maximal run of [\w.-] starting at p; q = first non-[\w.-] byte.
    let mut q = p;
    while q < b.len() && (b[q].is_ascii_alphanumeric() || matches!(b[q], b'_' | b'.' | b'-')) {
        q += 1;
    }
    if q >= b.len() || b[q] != b'/' {
        return false; // [\w.-]*\/ requires a '/' right after the run
    }
    // JS backtracking: some split [\w.-]+ / '.' / tld / [\w.-]* / '/' exists.
    for (off, &ch) in b[p..q].iter().enumerate() {
        if ch != b'.' {
            continue;
        }
        let s = p + off + 1;
        for tld in TLDS {
            let e = s + tld.len();
            if e <= q && lb[s..e] == *tld {
                return true;
            }
        }
    }
    false
}

/// TS `isBlockedAfterParse`.
#[allow(dead_code)] // parity: `isBlockedAfterParse` is never called in engines.ts (comment mentions only)
fn is_blocked_after_parse(body: &str, min_results: usize) -> bool {
    if has_ser_results(body, None, min_results) {
        return false;
    }
    is_blocked(body)
}

// ── DuckDuckGo (3-stage, fast switching: 12s per stage) ───────────────────
// (engines.ts 311-575). TS engines call fetchPage/fetchUrl directly and
// `.catch(() => null)`; net::Net methods already surface failures as None,
// so every TS catch becomes the None-arm below (dead-engine path parity).

/// JS `arr.slice(0, n)`.
fn take_n(mut v: Vec<RawSearchResult>, n: usize) -> Vec<RawSearchResult> {
    v.truncate(n);
    v
}

/// JSON `item.x ?? ""` chain (null/missing ⇒ try next key; non-string
/// scalars stringify — objects collapse to "", divergence recorded).
fn jstr_chain(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        match v.get(*k) {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) => return s.clone(),
            Some(Value::Number(n)) => return n.to_string(),
            Some(Value::Bool(b)) => return b.to_string(),
            Some(_) => return String::new(),
        }
    }
    String::new()
}

/// JS `state?.a?.b ?? state?.c ?? []` — first path that resolves to a
/// defined value; DIVERGENCE: JS then iterates the value (strings iterate
/// chars; other non-iterables throw into the caller's catch), while Rust
/// only accepts JSON arrays and falls through to the next alternative.
fn jarr_chain(v: &Value, paths: &[&[&str]]) -> Vec<Value> {
    for path in paths {
        let mut cur = v;
        let mut resolved = true;
        for k in *path {
            match cur.get(*k) {
                Some(n) => cur = n,
                None => {
                    resolved = false;
                    break;
                }
            }
        }
        if resolved {
            if let Value::Array(arr) = cur {
                return arr.clone();
            }
        }
    }
    Vec::new()
}

/// TS `ddgHtml` — Stage A: cookie-primed html.duckduckgo.com/html/ POST.
async fn ddg_html(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let jar = CookieJar::new();
    let host = "https://html.duckduckgo.com";

    // Priming request: sets session cookies.
    let prime = net
        .fetch_page(
            &(host.to_string() + "/html/"),
            &FetchPageOpts {
                timeout_ms: Some(DDG_STAGE_TIMEOUT_MS),
                headers: vec![("referer".to_string(), host.to_string() + "/")],
                ..Default::default()
            },
        )
        .await;
    if let Some(p) = &prime {
        if !p.cookies.is_empty() {
            jar.absorb(&(host.to_string() + "/html/"), &p.cookies);
        }
    }
    let cookie_val = jar.cookie_for(&(host.to_string() + "/html/"));

    // POST with session cookies + realistic browser-navigate headers.
    // use_realistic_headers ensures Accept: text/html (not application/json),
    // which is what DDG's anomaly detector expects for a form submission.
    let mut headers: crate::net::HeaderBag = Vec::new();
    if let Some(c) = cookie_val {
        headers.push(("cookie".to_string(), c));
    }
    headers.push((
        "content-type".to_string(),
        "application/x-www-form-urlencoded".to_string(),
    ));
    headers.push(("origin".to_string(), host.to_string()));
    headers.push(("referer".to_string(), host.to_string() + "/"));
    let res = net
        .fetch_url(
            &(host.to_string() + "/html/"),
            &UrlFetchOpts {
                timeout_ms: Some(DDG_STAGE_TIMEOUT_MS),
                body: Some("q=".to_string() + &enc_component(query)),
                method: Some("POST".to_string()),
                headers,
                use_realistic_headers: true,
                ..Default::default()
            },
        )
        .await;
    let res = match res {
        Some(r) => r,
        None => return Vec::new(),
    };
    // Parse FIRST — DDG's 202 body may contain "captcha" in script tags.
    if !res.ok || res.text.is_empty() {
        return Vec::new();
    }
    let results = parse_ddg_html(&res.text);
    if results.len() >= 2 {
        return results;
    }
    // <2 results: check if it's a genuine block (202 challenge, 403, 429).
    if res.status == 202 || res.status == 403 || res.status == 429 {
        return Vec::new();
    }
    if is_blocked(&res.text) {
        return Vec::new();
    }
    results
}

fn parse_ddg_html(html: &str) -> Vec<RawSearchResult> {
    let doc = doc_of(html);
    let mut out: Vec<RawSearchResult> = Vec::new();
    // DDG HTML result blocks: div.result with a.result__a (title link)
    // and .result__snippet (snippet text)
    let blocks = query_all(&doc, "div.result, div.links_main");
    for block in &blocks {
        let a = query_first(block, "a.result__a, a.result-link");
        let snippet_el = query_first(block, ".result__snippet, .result-snippet");
        let url_el = query_first(block, ".result__url");
        let href = match a.as_ref().map(|e| attr(e, "href")) {
            Some(h) if !h.is_empty() => h,
            _ => url_el.as_ref().map(|e| attr(e, "href")).unwrap_or_default(),
        };
        if href.is_empty() {
            continue;
        }
        let url = decode_uddg(&href);
        if !is_safe_url(&url) {
            continue;
        }
        out.push(RawSearchResult {
            title: a.as_ref().map(|e| text_trim(e)).unwrap_or_default(),
            url,
            snippet: snippet_el.as_ref().map(|e| text_trim(e)).unwrap_or_default(),
            engine: "duckduckgo".to_string(),
            // TS omits publishedDate entirely (undefined key) ⇒ None.
            published_date: None,
            rank: (out.len() + 1) as i64,
        });
    }
    take_n(out, 10)
}

/// TS `ddgLite` — Stage B: lite.duckduckgo.com/lite/ POST.
/// Fast-fail: 6s timeout (spec Fix 1A); switch to VQD if this fails too.
async fn ddg_lite(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let jar = CookieJar::new();
    let host = "https://lite.duckduckgo.com";

    let prime = net
        .fetch_page(
            &(host.to_string() + "/lite/?q=test"),
            &FetchPageOpts {
                timeout_ms: Some(DDG_LITE_TIMEOUT_MS),
                headers: vec![("referer".to_string(), host.to_string() + "/")],
                ..Default::default()
            },
        )
        .await;
    if let Some(p) = &prime {
        if !p.cookies.is_empty() {
            jar.absorb(&(host.to_string() + "/lite/"), &p.cookies);
        }
    }
    let cookie_val = jar.cookie_for(&(host.to_string() + "/lite/"));

    let mut headers: crate::net::HeaderBag = Vec::new();
    if let Some(c) = cookie_val {
        headers.push(("cookie".to_string(), c));
    }
    headers.push((
        "content-type".to_string(),
        "application/x-www-form-urlencoded".to_string(),
    ));
    headers.push(("origin".to_string(), host.to_string()));
    headers.push(("referer".to_string(), host.to_string() + "/"));
    headers.push(("sec-fetch-site".to_string(), "same-origin".to_string()));
    let res = net
        .fetch_url(
            &(host.to_string() + "/lite/"),
            &UrlFetchOpts {
                timeout_ms: Some(DDG_LITE_TIMEOUT_MS),
                body: Some("q=".to_string() + &enc_component(query)),
                method: Some("POST".to_string()),
                headers,
                use_realistic_headers: true,
                ..Default::default()
            },
        )
        .await;
    let res = match res {
        Some(r) => r,
        None => return Vec::new(),
    };
    // TS checks `!res?.text` BEFORE `res.status !== 200` (order preserved).
    if res.text.is_empty() || res.status != 200 {
        return Vec::new();
    }
    // Parse first, then check block.
    let doc = doc_of(&res.text);
    let mut out: Vec<RawSearchResult> = Vec::new();
    let links = query_all(&doc, "table.result a.result-link, a.result-link");
    for a in &links {
        let href = attr(a, "href");
        if href.is_empty() {
            continue;
        }
        let url = decode_uddg(&href);
        if !is_safe_url(&url) {
            continue;
        }
        let snippet = a
            .parent()
            .and_then(ElementRef::wrap)
            .and_then(|p| query_first(&p, ".result-snippet"))
            .map(|e| text_trim(&e))
            .unwrap_or_default();
        out.push(RawSearchResult {
            title: text_trim(a),
            url,
            snippet,
            engine: "duckduckgo".to_string(),
            published_date: None,
            rank: (out.len() + 1) as i64,
        });
    }
    if out.len() >= 2 {
        return take_n(out, 10);
    }
    if is_blocked(&res.text) {
        return Vec::new();
    }
    take_n(out, 10)
}

/// TS `ddgVqd` — Stage C: VQD token flow (GET duckduckgo.com →
/// links.duckduckgo.com/d.js). Uses apiHeaders (JSON-accept is fine for the
/// d.js endpoint — it returns JS). DEFINED BUT NEVER CALLED in TS (Stage C
/// is skipped whenever Stage B 0-returns) — dead code kept verbatim.
/// Quirk kept: JS `split(/\},\s*\{/)` strips only INNER separators, then
/// every chunk is re-braced `"{" + block + "}"` — for well-formed content
/// the first chunk starts with `{` (⇒ `{{…` invalid) and the last ends with
/// `}` (⇒ `…}}` invalid), so real multi-item payloads JSON.parse to zero
/// items (JS catch ⇒ null ⇒ filtered). serde_json::from_str rejects trailing
/// garbage like JSON.parse does — same outcome.
#[allow(dead_code)]
async fn ddg_vqd(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let res1 = net
        .fetch_page(
            &("https://duckduckgo.com/?q=".to_string() + &enc_component(query)),
            &FetchPageOpts {
                timeout_ms: Some(DDG_STAGE_TIMEOUT_MS),
                headers: vec![("referer".to_string(), "https://duckduckgo.com/".to_string())],
                ..Default::default()
            },
        )
        .await;
    let res1 = match res1 {
        Some(r) => r,
        None => return Vec::new(),
    };
    if res1.body.is_empty() {
        return Vec::new();
    }
    static RE_VQD_JSON: OnceLock<Regex> = OnceLock::new();
    static RE_VQD_EQ: OnceLock<Regex> = OnceLock::new();
    let m = RE_VQD_JSON
        .get_or_init(|| Regex::new(r#""vqd"\s*:\s*"([0-9]+)"#).unwrap())
        .captures(&res1.body)
        .or_else(|| RE_VQD_EQ.get_or_init(|| Regex::new(r"vqd=([0-9]+)").unwrap()).captures(&res1.body));
    let vqd = match m {
        Some(c) => c[1].to_string(),
        None => return Vec::new(),
    };

    let res2 = net
        .fetch_url(
            &format!(
                "https://links.duckduckgo.com/d.js?q={}&vqd={}",
                enc_component(query),
                vqd
            ),
            &UrlFetchOpts {
                timeout_ms: Some(DDG_STAGE_TIMEOUT_MS),
                headers: vec![("referer".to_string(), "https://duckduckgo.com/".to_string())],
                ..Default::default()
            },
        )
        .await;
    let res2 = match res2 {
        Some(r) => r,
        None => return Vec::new(),
    };
    if res2.text.is_empty() {
        return Vec::new();
    }

    let js = res2.text;
    let mut out: Vec<RawSearchResult> = Vec::new();
    // The d.js response embeds result data as JSON-like structures.
    // No (?s): JS `(.*?)` without the s flag — `.` excludes newlines (parity).
    static RE_RESULTS: OnceLock<Regex> = OnceLock::new();
    let result_blocks = RE_RESULTS
        .get_or_init(|| Regex::new(r#""results":\s*\[(.*?)\]"#).unwrap())
        .captures(&js)
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    static RE_SPLIT: OnceLock<Regex> = OnceLock::new();
    let items: Vec<Value> = RE_SPLIT
        .get_or_init(|| Regex::new(r"\},\s*\{").unwrap())
        .split(&result_blocks)
        .filter_map(|block| serde_json::from_str(&format!("{{{}}}", block)).ok())
        .filter(|v: &Value| !v.is_null())
        .collect();
    for item in &items {
        let url = jstr_chain(item, &["u", "url"]);
        if !is_safe_url(&url) {
            continue;
        }
        out.push(RawSearchResult {
            title: jstr_chain(item, &["t", "title"]),
            url,
            snippet: jstr_chain(item, &["b", "snippet"]),
            engine: "duckduckgo".to_string(),
            published_date: None,
            rank: (out.len() + 1) as i64,
        });
    }
    take_n(out, 10)
}

/// TS `ddgLitePost` — breaker-guarded lite POST (separate "ddg-lite" bucket).
async fn ddg_lite_post_inner(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let allowed = engine_pacer_with_breaker("ddg-lite").await;
    if !allowed {
        return Vec::new();
    }
    let jar = CookieJar::new();
    let host = "https://lite.duckduckgo.com";

    let prime = net
        .fetch_page(
            &(host.to_string() + "/lite/"),
            &FetchPageOpts {
                timeout_ms: Some(DDG_LITE_TIMEOUT_MS),
                headers: vec![("referer".to_string(), host.to_string() + "/")],
                ..Default::default()
            },
        )
        .await;
    // TS absorbs at host + "/" here (host ROOT, not "/lite/" like ddgLite)
    // and reads cookieFor(host + "/") — kept verbatim.
    if let Some(p) = &prime {
        if !p.cookies.is_empty() {
            jar.absorb(&(host.to_string() + "/"), &p.cookies);
        }
    }
    let cookie_val = jar.cookie_for(&(host.to_string() + "/"));

    // POST with form-encoded body — much more resilient against 429s than
    // a GET to html.duckduckgo.com (no referrer fingerprint, no JS).
    let mut headers: crate::net::HeaderBag = Vec::new();
    if let Some(c) = cookie_val {
        headers.push(("cookie".to_string(), c));
    }
    headers.push((
        "content-type".to_string(),
        "application/x-www-form-urlencoded".to_string(),
    ));
    headers.push(("origin".to_string(), host.to_string()));
    headers.push(("referer".to_string(), host.to_string() + "/"));
    headers.push(("sec-fetch-site".to_string(), "same-origin".to_string()));
    let res = net
        .fetch_url(
            &(host.to_string() + "/lite/"),
            &UrlFetchOpts {
                timeout_ms: Some(DDG_LITE_TIMEOUT_MS),
                body: Some("q=".to_string() + &enc_component(query) + "&b=chrome"),
                method: Some("POST".to_string()),
                headers,
                use_realistic_headers: true,
                ..Default::default()
            },
        )
        .await;
    let res = match res {
        Some(r) => r,
        None => return Vec::new(),
    };
    if res.text.is_empty() || res.status != 200 {
        return Vec::new();
    }
    let doc = doc_of(&res.text);
    let mut out: Vec<RawSearchResult> = Vec::new();
    let links = query_all(&doc, "a.result-link, a.result-a");
    for a in &links {
        let href = attr(a, "href");
        if href.is_empty() {
            continue;
        }
        let url = decode_uddg(&href);
        if !is_safe_url(&url) {
            continue;
        }
        let snippet = closest(a, "tr")
            .and_then(|tr| query_first(&tr, "td.result-snippet"))
            .map(|e| text_trim(&e))
            .unwrap_or_default();
        out.push(RawSearchResult {
            title: text_trim(a),
            url,
            snippet,
            engine: "ddg-lite".to_string(),
            published_date: None,
            rank: (out.len() + 1) as i64,
        });
    }
    if out.len() >= 2 {
        note_engine_success("ddg-lite");
    } else {
        trip_circuit_breaker("ddg-lite", "ddg-lite POST returned 0 results");
    }
    take_n(out, 10)
}

/// TS `ddgSearch` — 3-stage DDG: Stage A (cookie-primed html POST, 12s) →
/// Stage B (lite POST, 6s fast timeout); Stage C (VQD) is skipped whenever
/// Stage B 0-returns. Stage-A 0-result is NOT a trip observation — ONE zero
/// observation per engine CALL (module-parity comment preserved below).
async fn ddg_search_inner(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let allowed = engine_pacer_with_breaker("duckduckgo").await;
    if !allowed {
        return Vec::new();
    }
    let stage_a = ddg_html(net, query).await;
    if !stage_a.is_empty() {
        note_engine_success("duckduckgo");
        return stage_a;
    }
    // Stage A 0-result is NOT a trip observation by itself: the lite
    // endpoint may still answer, and a genuinely empty query (a niche
    // `site:` operator) legitimately 0s on every endpoint. One zero
    // observation per engine CALL — tripping per stage let a single empty
    // query self-cooldown DDG before a re-hop seconds later (measured).
    let stage_b = ddg_lite(net, query).await;
    if !stage_b.is_empty() {
        note_engine_success("duckduckgo");
        return stage_b;
    }
    // Both endpoints 0 for this query. Skip Stage C entirely (VQD will
    // also be throttled when the IP is rate-limited).
    trip_circuit_breaker("duckduckgo", "both endpoints returned 0 results for this query");
    Vec::new()
}

// ── Yahoo (Bing index, RU= redirect unwrap) ───────────────────────────────

/// TS `yahooSearch` — regional cascade (in.search.yahoo.com then
/// search.yahoo.com); per-region errors are swallowed and the next region is
/// tried (TS try/catch ⇔ ScriptedNet None / net None-arm `continue`).
async fn yahoo_search_inner(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let allowed = engine_pacer_with_breaker("yahoo").await;
    if !allowed {
        return Vec::new();
    }
    let enc = enc_component(query);
    let regions = [
        "https://in.search.yahoo.com/search?p=".to_string() + &enc + "&n=15",
        "https://search.yahoo.com/search?p=".to_string() + &enc + "&n=15",
    ];
    for url in regions {
        // referer: url.split("/search")[0] + "/" (JS split: first "/search"
        // occurrence; no occurrence ⇒ whole url + "/").
        let referer = match url.find("/search") {
            Some(i) => url[..i].to_string(),
            None => url.clone(),
        } + "/";
        let res = net
            .fetch_page(
                &url,
                &FetchPageOpts {
                    timeout_ms: Some(ENGINE_TIMEOUT_MS),
                    headers: vec![
                        ("referer".to_string(), referer),
                        ("sec-fetch-site".to_string(), "same-origin".to_string()),
                    ],
                    ..Default::default()
                },
            )
            .await;
        let res = match res {
            Some(r) => r,
            None => continue,
        };
        // Yahoo may return 307/500 but impit follows redirects — parse
        // FIRST: if the body has ≥2 result links, the page is a valid SERP.
        if res.body.is_empty() || js_len(&res.body) < 500 {
            continue;
        }
        let doc = doc_of(&res.body);
        let mut out: Vec<RawSearchResult> = Vec::new();
        let results = query_all(
            &doc,
            "h3.title, .compTitle a, .algo a[href], li.strm, div.dd.algo a[href^='http'], a[href*='RU=']",
        );
        for el in &results {
            let href = attr(el, "href");
            if href.is_empty() {
                continue;
            }
            let mut target = unwrap_ru_href(&href, &url);
            if target.starts_with('/') {
                match resolve_url(&url, &target) {
                    Some(u) => target = u.as_str().to_string(),
                    None => continue,
                }
            }
            if !is_safe_url(&target) {
                continue;
            }
            // Host filters (TS try/catch: unparseable target skips the check
            // and pushes anyway). tHost.includes("bing.com/aclick") can never
            // fire — a hostname never contains "/" (dead branch, kept).
            if let Ok(tu) = Url::parse(&target) {
                let t_host = tu.host_str().unwrap_or("").to_ascii_lowercase();
                let yahoo_host = t_host == "yahoo.com" || t_host == "www.yahoo.com";
                if yahoo_host && !target.contains("/r/") {
                    continue;
                }
                if t_host.contains(".aol.") || t_host.contains("bing.com/aclick") {
                    continue;
                }
            }
            let snippet = closest(el, "li, div")
                .and_then(|c| {
                    query_first(&c, ".compText, .snippet, p, .fz-ms")
                })
                .map(|e| text_trim(&e))
                .unwrap_or_default();
            out.push(RawSearchResult {
                title: text_trim(el),
                url: target,
                snippet,
                engine: "yahoo".to_string(),
                published_date: None,
                rank: (out.len() + 1) as i64,
            });
            if out.len() >= 15 {
                break;
            }
        }
        if out.len() >= 2 {
            note_engine_success("yahoo");
            return out;
        }
        if is_blocked(&res.body) {
            continue;
        }
        if !out.is_empty() {
            note_engine_success("yahoo");
            return out;
        }
    }
    // Both regions returned 0 results — trip the breaker.
    trip_circuit_breaker("yahoo", "both regions returned 0 results");
    Vec::new()
}

// ── Google (Web SERP, got-scraping header fingerprints) ───────────────────

/// TS `googleSearch` — classic HTML SERP endpoint. got-scraping's
/// header-generator fingerprints (rotating Chrome/Firefox HTTP/2 headers via
/// net.ts) get past the consent/bot heuristics that sink raw fetches.
/// Parse-first rule: the page is only judged blocked when the parser finds
/// zero results (isBlockedAfterParse), never before.
async fn google_search_inner(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let allowed = engine_pacer_with_breaker("google").await;
    if !allowed {
        return Vec::new();
    }
    let res = net
        .fetch_page(
            &( "https://www.google.com/search?q=".to_string()
                + &enc_component(query)
                + "&num=20&hl=en&gl=us"),
            &FetchPageOpts {
                timeout_ms: Some(ENGINE_TIMEOUT_MS),
                headers: vec![(
                    "referer".to_string(),
                    "https://www.google.com/".to_string(),
                )],
                ..Default::default()
            },
        )
        .await;
    let res = match res {
        Some(r) => r,
        None => {
            trip_immediate("google", "google SERP fetch failed (transport/timeout)");
            return Vec::new();
        }
    };
    if res.body.is_empty() || js_len(&res.body) < 500 {
        return Vec::new();
    }

    let doc = doc_of(&res.body);
    let mut out: Vec<RawSearchResult> = Vec::new();
    let blocks = query_all(&doc, "div.g, .MjjYud, div.s");
    for div in &blocks {
        let a = match query_first(div, "a[href^='http'], a[href^='/url']") {
            Some(a) => a,
            None => continue,
        };
        let url = unwrap_google_href(&attr(&a, "href"));
        if !is_safe_url(&url) {
            continue;
        }
        match Url::parse(&url) {
            Ok(u) => {
                let host = u.host_str().unwrap_or("");
                if host == "google.com" || host.ends_with(".google.com") {
                    continue;
                }
            }
            Err(_) => continue,
        }
        let title = query_first(div, "h3")
            .map(|e| text_trim(&e))
            .or_else(|| Some(text_trim(&a)))
            .unwrap_or_default();
        let snippet = query_first(div, ".VwiC3b, .IsZvec, span.st, .st")
            .map(|e| text_trim(&e))
            .unwrap_or_default();
        out.push(RawSearchResult {
            title,
            url,
            snippet,
            engine: "google".to_string(),
            published_date: None,
            rank: (out.len() + 1) as i64,
        });
        if out.len() >= 15 {
            break;
        }
    }

    if out.len() >= 2 {
        note_engine_success("google");
        return out;
    }
    if !res.ok || is_blocked(&res.body) {
        trip_circuit_breaker(
            "google",
            &format!("google returned {} with no results", res.status),
        );
        return Vec::new();
    }
    if out.is_empty() {
        // Bench 2026-10-29: a 200 consent/bot wall parses to ZERO results;
        // without recording the zero here the breaker never engages and
        // google burns a full SERP fetch on every single cycle (59/59 live).
        trip_circuit_breaker(
            "google",
            "google returned 200 with 0 parsed results (consent/bot wall)",
        );
    } else {
        note_engine_success("google");
    }
    out
}

// ── Brave (own index, SSR HTML + __INITIAL_STATE__) ───────────────────────

/// TS `braveSearch` — SSR HTML first, `window.__INITIAL_STATE__` JSON regex
/// fallback; ≥2 results are served regardless of HTTP status (429 with a
/// valid body still serves real results).
async fn brave_search_inner(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let allowed = engine_pacer_with_breaker("brave").await;
    if !allowed {
        return Vec::new();
    }
    let res = net
        .fetch_page(
            &( "https://search.brave.com/search?q=".to_string()
                + &enc_component(query)
                + "&source=web"),
            &FetchPageOpts {
                timeout_ms: Some(ENGINE_TIMEOUT_MS),
                headers: vec![(
                    "referer".to_string(),
                    "https://search.brave.com/".to_string(),
                )],
                ..Default::default()
            },
        )
        .await;
    let res = match res {
        Some(r) => r,
        None => return Vec::new(),
    };
    // Fail fast on a genuinely empty/throttled 429: if there is no body
    // content to parse, don't waste time on a parser pass.
    if res.body.is_empty() || js_len(&res.body) < 500 {
        return Vec::new();
    }
    // Parse FIRST on any non-empty body (including a 429 that still carries
    // a valid SERP). Pages with real results are never discarded by
    // false-positive "captcha" strings in <script> tags.
    let doc = doc_of(&res.body);
    let mut out: Vec<RawSearchResult> = Vec::new();

    // Primary: #results / div#web-results > div with a.result-header / .snippet-description
    let results = query_all(
        &doc,
        "#results > div, div#web-results > div, .result, .snippet, div.web-result",
    );
    for div in &results {
        let a = match query_first(
            div,
            "a.result-header, a.result-title, .snippet a, a[href^='http']",
        ) {
            Some(a) => a,
            None => continue,
        };
        let href = attr(&a, "href");
        // TS checks isSafeUrl(href) on the RAW href (no base resolution) —
        // relative hrefs fail the guard, kept verbatim.
        if !is_safe_url(&href) {
            continue;
        }
        out.push(RawSearchResult {
            title: query_first(div, ".title, h2, .result-title")
                .map(|e| text_trim(&e))
                .unwrap_or_default(),
            url: href,
            snippet: query_first(div, ".snippet-description, .snippet, .desc, .fb, p")
                .map(|e| text_trim(&e))
                .unwrap_or_default(),
            engine: "brave".to_string(),
            published_date: None,
            rank: (out.len() + 1) as i64,
        });
    }

    // Fallback: embedded SSR script data (window.__INITIAL_STATE__ or similar)
    if out.is_empty() {
        static RE_STATE: OnceLock<Regex> = OnceLock::new();
        if let Some(m) = RE_STATE
            .get_or_init(|| {
                Regex::new(
                    r"window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});?\s*</script>",
                )
                .unwrap()
            })
            .captures(&res.body)
        {
            if let Ok(state) = serde_json::from_str::<Value>(&m[1]) {
                let results2 = jarr_chain(&state, &[&["searchResults", "results"], &["results"], &["webResults"]]);
                for r in results2 {
                    let url = jstr_chain(&r, &["url", "link"]);
                    if !is_safe_url(&url) {
                        continue;
                    }
                    out.push(RawSearchResult {
                        title: jstr_chain(&r, &["title"]),
                        url,
                        snippet: jstr_chain(&r, &["description", "snippet"]),
                        engine: "brave".to_string(),
                        published_date: None,
                        rank: (out.len() + 1) as i64,
                    });
                }
            }
        }
    }

    // Return results whenever the parser found ≥2 — regardless of the HTTP
    // status (429 with a valid body still serves real results).
    if out.len() >= 2 {
        note_engine_success("brave");
        return take_n(out, 15);
    }
    // No results: a non-200 status or a genuine block → trip the breaker.
    if !res.ok || is_blocked(&res.body) {
        trip_circuit_breaker(
            "brave",
            &format!("brave returned {} with no results", res.status),
        );
        return Vec::new();
    }
    if !out.is_empty() {
        note_engine_success("brave");
    }
    take_n(out, 15)
}

// ── Reddit (3-stage keyless community cascade) ────────────────────────────
//   Stage A — Reddit RSS/Atom feed (no auth, no rate-limit like the JSON API)
//   Stage B — PullPush Reddit archive API (independent third-party, keyless)
//   Stage C — Cookie-primed old.reddit.com/search.json (last resort)
// Stage A is the most reliable: Reddit's Atom search endpoint serves clean
// XML to any browser UA with no session cookies and no 403 challenge.
// NOTE (parity): no stage of the Reddit cascade calls isSafeUrl.

fn re_reddit_entry() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<entry>[\s\S]*?</entry>").unwrap())
}

/// TS `parseRedditFeed` — regex-parsed Atom (TS has no XML parser; Reddit
/// feeds are machine-generated and stable). Divergence: JS `while
/// ((m = entryRe.exec(xml)) !== null && out.length < 20)` checks the cap
/// BEFORE processing; Rust `take(20)` on matches is the same count.
#[allow(clippy::regex_creation_in_loops)] // parity: the OnceLock inits mirror TS per-entry regex literals
fn parse_reddit_feed(xml: &str) -> Vec<RawSearchResult> {
    static RE_TITLE: OnceLock<Regex> = OnceLock::new();
    static RE_LINK: OnceLock<Regex> = OnceLock::new();
    static RE_CONTENT: OnceLock<Regex> = OnceLock::new();
    static RE_PUBLISHED: OnceLock<Regex> = OnceLock::new();
    static RE_TAGS: OnceLock<Regex> = OnceLock::new();
    let mut out: Vec<RawSearchResult> = Vec::new();
    for m in re_reddit_entry().find_iter(xml) {
        if out.len() >= 20 {
            break;
        }
        let entry = m.as_str();
        let title_match = RE_TITLE
            .get_or_init(|| {
                Regex::new(r"<title>(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?</title>").unwrap()
            })
            .captures(entry);
        let link_match = RE_LINK
            .get_or_init(|| Regex::new(r#"<link[^>]*href="(https?://[^"]+)"#).unwrap())
            .captures(entry);
        let url = match link_match {
            Some(c) => c[1].to_string(),
            None => continue, // JS: if (!url) continue
        };
        let content_match = RE_CONTENT
            .get_or_init(|| Regex::new(r"<content[^>]*>([\s\S]*?)</content>").unwrap())
            .captures(entry);
        let snippet = content_match
            .map(|c| {
                let stripped = RE_TAGS
                    .get_or_init(|| Regex::new(r"<[^>]+>").unwrap())
                    .replace_all(&c[1], "")
                    .into_owned();
                js_slice_max(&stripped, 400)
            })
            .unwrap_or_default();
        let published = RE_PUBLISHED
            .get_or_init(|| Regex::new(r"<published>([^<]+)</published>").unwrap())
            .captures(entry)
            .map(|c| c[1].to_string());
        out.push(RawSearchResult {
            title: title_match.map(|c| c[1].trim().to_string()).unwrap_or_default(),
            url,
            snippet,
            engine: "reddit".to_string(),
            published_date: published,
            rank: (out.len() + 1) as i64,
        });
    }
    out
}

/// JS truthiness of a JSON scalar (0, NaN, "" and null are false).
fn js_truthy_json(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) => f != 0.0 && !f.is_nan(),
            None => true,
        },
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `new Date(secs * 1000).toISOString()` — None when JS would throw
/// (out-of-range ⇒ the enclosing stage's catch swallows the whole stage).
fn js_iso_from_utc_secs(v: &Value) -> Option<String> {
    let secs = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    } * 1000.0;
    // JS Date accepts ±8.64e15 ms; NaN/Infinity/out-of-range make
    // toISOString() THROW (the stage catch swallows the whole stage).
    if !secs.is_finite() || secs > 8.64e15 || secs < -8.64e15 {
        return None;
    }
    let ms = secs.round() as i64;
    DateTime::from_timestamp_millis(ms).map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// TS `redditRss` — Stage A: Atom/RSS search feeds (www then old).
async fn reddit_rss(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let enc = enc_component(query);
    let urls = [
        "https://www.reddit.com/search.rss?q=".to_string() + &enc + "&sort=relevance&limit=20",
        "https://old.reddit.com/search.rss?q=".to_string() + &enc + "&sort=relevance&limit=20",
    ];
    for url in urls {
        let res = match net
            .fetch_url(
                &url,
                &UrlFetchOpts {
                    timeout_ms: Some(25_000),
                    headers: vec![
                        (
                            "user-agent".to_string(),
                            "webui-search/1.0 (research pipeline)".to_string(),
                        ),
                        (
                            "accept".to_string(),
                            "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8".to_string(),
                        ),
                    ],
                    ..Default::default()
                },
            )
            .await
        {
            Some(r) => r,
            None => continue,
        };
        if !res.ok || res.text.is_empty() {
            continue;
        }
        let results = parse_reddit_feed(&res.text);
        if !results.is_empty() {
            return results;
        }
    }
    Vec::new()
}

/// TS `redditPullPush` — Stage B: PullPush archive API.
async fn reddit_pull_push(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let url = "https://api.pullpush.io/reddit/search/submission/?q=".to_string()
        + &enc_component(query)
        + "&size=15&sort=score&sort_type=desc";
    let res = match net
        .fetch_url(
            &url,
            &UrlFetchOpts {
                timeout_ms: Some(25_000),
                headers: vec![
                    ("user-agent".to_string(), "webui-search/1.0".to_string()),
                    ("accept".to_string(), "application/json".to_string()),
                ],
                ..Default::default()
            },
        )
        .await
    {
        Some(r) => r,
        None => return Vec::new(),
    };
    if !res.ok || res.text.is_empty() {
        return Vec::new();
    }
    let data: Value = match serde_json::from_str(&res.text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let items: Vec<Value> = match data.get("data") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(), // data?.data ?? []
    };
    if items.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<RawSearchResult> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        // item.url ?? `https://www.reddit.com${item.permalink ?? ""}` —
        // an EMPTY-string url is defined, so it wins over the fallback.
        let url = match item.get("url") {
            None | Some(Value::Null) => {
                format!("https://www.reddit.com{}", jstr_chain(item, &["permalink"]))
            }
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::Bool(b)) => b.to_string(),
            Some(_) => String::new(),
        };
        let published = if js_truthy_json(item.get("created_utc")) {
            match js_iso_from_utc_secs(item.get("created_utc").unwrap()) {
                Some(s) => Some(s),
                // JS new Date(...).toISOString() throws mid-map ⇒ the whole
                // stage catch returns [] ⇒ try the next stage.
                None => return Vec::new(),
            }
        } else {
            None
        };
        let snippet_src = jstr_chain(item, &["selftext", "title"]);
        out.push(RawSearchResult {
            title: jstr_chain(item, &["title"]),
            url,
            snippet: js_slice_max(&snippet_src, 400),
            engine: "reddit".to_string(),
            published_date: published,
            rank: (i + 1) as i64,
        });
    }
    take_n(out, 15)
}

/// TS `redditJson` — Stage C: old.reddit then www search.json.
async fn reddit_json(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let enc = enc_component(query);
    let urls = [
        "https://old.reddit.com/search.json?q=".to_string()
            + &enc
            + "&sort=relevance&t=all&limit=15",
        "https://www.reddit.com/search.json?q=".to_string()
            + &enc
            + "&sort=relevance&t=all&limit=15",
    ];
    for url in urls {
        let res = match net
            .fetch_url(
                &url,
                &UrlFetchOpts {
                    timeout_ms: Some(25_000),
                    headers: vec![
                        (
                            "user-agent".to_string(),
                            "webui-search/1.0 (research pipeline)".to_string(),
                        ),
                        ("accept".to_string(), "application/json".to_string()),
                    ],
                    ..Default::default()
                },
            )
            .await
        {
            Some(r) => r,
            None => continue,
        };
        if !res.ok || res.text.is_empty() {
            continue;
        }
        let data: Value = match serde_json::from_str(&res.text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let children: Vec<Value> = match data.get("data").and_then(|d| d.get("children")) {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(), // data?.data?.children ?? []
        };
        if children.is_empty() {
            continue; // quirk: an EMPTY children array tries the next URL
        }
        let mut out: Vec<RawSearchResult> = Vec::new();
        let mut threw = false;
        for (i, c) in children.iter().enumerate() {
            let p: Value = c
                .get("data")
                .cloned()
                .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
            let url = match p.get("url") {
                None | Some(Value::Null) => {
                    format!("https://www.reddit.com{}", jstr_chain(&p, &["permalink"]))
                }
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::Bool(b)) => b.to_string(),
                Some(_) => String::new(),
            };
            let published = if js_truthy_json(p.get("created_utc")) {
                match js_iso_from_utc_secs(p.get("created_utc").unwrap()) {
                    Some(s) => Some(s),
                    // JS throw mid-map ⇒ this URL's catch ⇒ NEXT URL.
                    None => {
                        threw = true;
                        break;
                    }
                }
            } else {
                None
            };
            let snippet_src = jstr_chain(&p, &["selftext", "title"]);
            out.push(RawSearchResult {
                title: jstr_chain(&p, &["title"]),
                url,
                snippet: js_slice_max(&snippet_src, 400),
                engine: "reddit".to_string(),
                published_date: published,
                rank: (i + 1) as i64,
            });
        }
        if threw {
            continue;
        }
        return take_n(out, 15);
    }
    Vec::new()
}

/// TS `redditSearch` — 3-stage Reddit: RSS feed → PullPush → search.json.
/// Returns the first stage that produces results. Breaker-gated ("reddit");
/// trips / notes on the final result count (bench 2026-10-29: 429x54 on the
/// general pool with no cooldown ever — unguarded).
async fn reddit_search_inner(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    if !engine_pacer_with_breaker("reddit").await {
        return Vec::new();
    }
    let stage_a = reddit_rss(net, query).await;
    if !stage_a.is_empty() {
        note_engine_success("reddit");
        return stage_a;
    }
    let stage_b = reddit_pull_push(net, query).await;
    if !stage_b.is_empty() {
        note_engine_success("reddit");
        return stage_b;
    }
    let stage_c = reddit_json(net, query).await;
    if !stage_c.is_empty() {
        note_engine_success("reddit");
        return stage_c;
    }
    tracing::warn!(
        query = js_slice_max(query, 80),
        "reddit: all 3 stages returned 0 results"
    );
    trip_circuit_breaker("reddit", "reddit: all 3 stages returned 0 results");
    Vec::new()
}

// ── Bing ─────────────────────────────────────────────────────────────────
//
// TS `parseBingRss` — RSS <item> parser for the Bing RSS endpoint.
fn parse_bing_rss(xml: &str) -> Vec<RawSearchResult> {
    static RE_ITEM: OnceLock<Regex> = OnceLock::new();
    static RE_TITLE: OnceLock<Regex> = OnceLock::new();
    static RE_LINK: OnceLock<Regex> = OnceLock::new();
    static RE_DESC: OnceLock<Regex> = OnceLock::new();
    let re_item = RE_ITEM.get_or_init(|| Regex::new(r"<item>[\s\S]*?</item>").unwrap());
    let re_title = RE_TITLE
        .get_or_init(|| Regex::new(r#"<title>(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?</title>"#).unwrap());
    let re_link = RE_LINK
        .get_or_init(|| Regex::new(r"<link>([^<]+)</link>").unwrap());
    let re_desc = RE_DESC
        .get_or_init(|| Regex::new(r"<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</description>").unwrap());
    static RE_TAGS: OnceLock<Regex> = OnceLock::new();
    let re_tags = RE_TAGS.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());

    let mut out: Vec<RawSearchResult> = Vec::new();
    for item in re_item.find_iter(xml) {
        if out.len() >= 15 {
            break; // JS while (m && out.length < 15) — checked BEFORE the entry
        }
        let entry = item.as_str();
        let title = match re_title.captures(entry) {
            Some(c) => c[1].trim().to_string(),
            None => String::new(),
        };
        let link = match re_link.captures(entry) {
            Some(c) => c[1].to_string(),
            None => String::new(),
        };
        let url = link.trim().to_string();
        if url.is_empty() {
            continue;
        }
        let desc = match re_desc.captures(entry) {
            Some(c) => c[1].to_string(),
            None => String::new(),
        };
        let snippet = js_slice_max(&re_tags.replace_all(&desc, ""), 400);
        out.push(RawSearchResult {
            title,
            url,
            snippet,
            engine: "bing".to_string(),
            published_date: None,
            rank: (out.len() + 1) as i64,
        });
    }
    out
}

/// TS `bingRss` — Stage A: Bing's RSS endpoint (one call, no cascade).
async fn bing_rss(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let url = "https://www.bing.com/search?q=".to_string()
        + &enc_component(query)
        + "&format=rss&count=15";
    let res = match net
        .fetch_url(
            &url,
            &UrlFetchOpts {
                timeout_ms: Some(25_000),
                use_realistic_headers: true,
                headers: vec![(
                    "accept".to_string(),
                    "application/rss+xml, application/xml, text/xml;q=0.9".to_string(),
                )],
                ..Default::default()
            },
        )
        .await
    {
        Some(r) => r,
        None => return Vec::new(),
    };
    if !res.ok || res.text.is_empty() {
        return Vec::new();
    }
    let results = parse_bing_rss(&res.text);
    if !results.is_empty() {
        return results;
    }
    Vec::new()
}

/// TS `bingHtml` — Stage B: cookie-primed Bing HTML SERP.
async fn bing_html(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let jar = CookieJar::new();
    let host = "https://www.bing.com";

    // Priming: sets the session cookie that Bing's HTML endpoint expects.
    let prime = net
        .fetch_page(
            &(host.to_string() + "/"),
            &FetchPageOpts {
                timeout_ms: Some(12_000),
                headers: vec![("referer".to_string(), "https://www.bing.com/".to_string())],
                ..Default::default()
            },
        )
        .await;
    if let Some(p) = &prime {
        if !p.cookies.is_empty() {
            jar.absorb(&(host.to_string() + "/"), &p.cookies);
        }
    }
    let cookie_val = jar.cookie_for(&(host.to_string() + "/"));

    // QUIRK (parity): when the priming cookie EXISTS, realisticHeaders gets
    // {cookie} — the referer is NOT sent at all on the SERP request.
    let mut headers: crate::net::HeaderBag = match &cookie_val {
        Some(c) => vec![("cookie".to_string(), c.clone())],
        None => vec![("referer".to_string(), host.to_string() + "/")],
    };
    headers.push((
        "accept-language".to_string(),
        "en-US,en;q=0.9".to_string(),
    ));
    let res = match net
        .fetch_page(
            &(host.to_string() + "/search?q=" + &enc_component(query) + "&setlang=en&cc=US"),
            &FetchPageOpts {
                timeout_ms: Some(30_000),
                headers,
                ..Default::default()
            },
        )
        .await
    {
        Some(r) => r,
        None => return Vec::new(),
    };
    if !res.ok || res.body.is_empty() {
        return Vec::new();
    }
    let doc = doc_of(&res.body);
    let mut out: Vec<RawSearchResult> = Vec::new();
    // Bing HTML parse-first (captcha strings in <script> tags on valid SERPs).
    // b_algo blocks: <li class="b_algo" ...><h2 ...><a href="/ck/a?...">…</a>
    // Snippet: .b_caption p or p.b_lineclamp...
    for div in query_all(&doc, "li.b_algo, div.b_algo, li.b_ans") {
        // Title link: h2 > a (with attributes) OR /ck/a link OR direct http
        let a = match query_first(&div, "h2 a, a[href^='/ck/'], a[href^='http']") {
            Some(a) => a,
            None => continue,
        };
        let mut href = attr(&a, "href");
        if href.starts_with("/ck/") {
            href = host.to_string() + &href;
        }
        let target = decode_bing_ck(&href);
        if !crate::ssrf::is_safe_url(&target) {
            continue;
        }
        // Filter out bing.com internal links (settings, help, feedback).
        if let Ok(u) = url::Url::parse(&target) {
            let t_host = u.host_str().unwrap_or("").to_ascii_lowercase();
            if t_host == "www.bing.com" || t_host == "bing.com" {
                // Keep /search results, skip internal bing.com pages
                if !target.contains("/search") {
                    continue;
                }
            }
        }
        out.push(RawSearchResult {
            title: text_trim(&a),
            url: target,
            snippet: match query_first(&div, ".b_caption p, .b_caption .b_lineclamp, p.b_lineclamp, p") {
                Some(s) => text_trim(&s),
                None => String::new(),
            },
            engine: "bing".to_string(),
            published_date: None,
            rank: (out.len() + 1) as i64,
        });
    }
    if out.len() >= 2 {
        return take_n(out, 15);
    }
    if is_blocked(&res.body) {
        return Vec::new();
    }
    take_n(out, 15)
}

/// TS `bingSearch` — 2-stage Bing: RSS feed → cookie-primed HTML.
/// Returns the first stage that produces results. Breaker-gated ("bing");
/// trips / notes on the final result count.
async fn bing_search_inner(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    if !engine_pacer_with_breaker("bing").await {
        return Vec::new();
    }
    let stage_a = bing_rss(net, query).await;
    if !stage_a.is_empty() {
        note_engine_success("bing");
        return stage_a;
    }
    let stage_b = bing_html(net, query).await;
    if !stage_b.is_empty() {
        note_engine_success("bing");
        return stage_b;
    }
    tracing::warn!(
        query = js_slice_max(query, 80),
        "bing: both stages returned 0 results"
    );
    trip_circuit_breaker("bing", "bing: both stages returned 0 results");
    Vec::new()
}

/// TS `parseBingNewsRss` — extract the real target URL from the url= param.
fn parse_bing_news_rss(xml: &str) -> Vec<RawSearchResult> {
    static RE_ITEM: OnceLock<Regex> = OnceLock::new();
    static RE_TITLE: OnceLock<Regex> = OnceLock::new();
    static RE_LINK: OnceLock<Regex> = OnceLock::new();
    static RE_PUB: OnceLock<Regex> = OnceLock::new();
    static RE_DESC: OnceLock<Regex> = OnceLock::new();
    static RE_TAGS: OnceLock<Regex> = OnceLock::new();
    static RE_WS: OnceLock<Regex> = OnceLock::new();
    let re_item = RE_ITEM.get_or_init(|| Regex::new(r"<item>[\s\S]*?</item>").unwrap());
    // NOTE (parity): the news title regex uses [\s\S]*? (NOT the
    // [^<\]]+? flavour used by parseBingRss / parseRedditFeed).
    let re_title = RE_TITLE
        .get_or_init(|| Regex::new(r"<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</title>").unwrap());
    let re_link = RE_LINK
        .get_or_init(|| Regex::new(r"<link>([\s\S]*?)</link>").unwrap());
    let re_pub = RE_PUB
        .get_or_init(|| Regex::new(r"<pubDate>([^<]+)</pubDate>").unwrap());
    let re_desc = RE_DESC
        .get_or_init(|| Regex::new(r"<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</description>").unwrap());
    let re_tags = RE_TAGS.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let re_ws = RE_WS.get_or_init(|| Regex::new(r"\s+").unwrap());

    let mut out: Vec<RawSearchResult> = Vec::new();
    for item_m in re_item.find_iter(xml) {
        if out.len() >= 25 {
            break;
        }
        let item = item_m.as_str();
        let title = match re_title.captures(item) {
            // .trim().replace(/\s+/g, " ") — trim FIRST, then collapse.
            Some(c) => re_ws.replace_all(c[1].trim(), " ").to_string(),
            None => String::new(),
        };
        let pub_date = re_pub.captures(item).map(|c| c[1].to_string());
        let desc = match re_desc.captures(item) {
            Some(c) => c[1].to_string(),
            None => String::new(),
        };
        let snippet = js_slice_max(&re_tags.replace_all(&desc, ""), 400);

        // Bing wraps news links as:
        //   http://www.bing.com/news/apiclick.aspx?...&url=https%3a%2f%2f<real-domain>/...
        let link_raw = match re_link.captures(item) {
            Some(c) => c[1].trim().replace("&amp;", "&"),
            None => String::new(),
        };
        let mut target = link_raw;
        if let Ok(u) = url::Url::parse(&target) {
            if let Some(url_param) = u.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned())
            {
                if !url_param.is_empty() {
                    // DIVERGENCE: decodeURIComponent THROWS on a malformed
                    // sequence (→ catch keeps the tracker URL); our
                    // percent-decode is lossy and substitutes instead.
                    target = percent_decode_str(&url_param).decode_utf8_lossy().into_owned();
                }
            }
        }
        if !crate::ssrf::is_safe_url(&target) {
            continue;
        }
        out.push(RawSearchResult {
            title,
            url: target,
            snippet,
            engine: "bing-news".to_string(),
            published_date: pub_date,
            rank: (out.len() + 1) as i64,
        });
    }
    out
}

/// TS `bingNewsRssSearch` — Bing News RSS (primary) + Google News RSS
/// fallback. Breaker-gated ("bing-news"); trips / notes on the final count.
async fn bing_news_rss_search_inner(
    net: &dyn Net,
    query: &str,
) -> Vec<RawSearchResult> {
    if !engine_pacer_with_breaker("bing-news").await {
        return Vec::new();
    }

    // ── Stage A: Bing News RSS (real target URLs via url= param) ────────
    let bing_url = "https://www.bing.com/news/search?q=".to_string()
        + &enc_component(query)
        + "&format=rss&count=20";
    let res = net
        .fetch_url(
            &bing_url,
            &UrlFetchOpts {
                timeout_ms: Some(15_000),
                use_realistic_headers: true,
                headers: vec![
                    (
                        "accept".to_string(),
                        "application/rss+xml, application/xml, text/xml;q=0.9".to_string(),
                    ),
                    ("referer".to_string(), "https://www.bing.com/".to_string()),
                ],
                ..Default::default()
            },
        )
        .await;
    if let Some(res) = res {
        if res.ok && !res.text.is_empty() {
            let out = parse_bing_news_rss(&res.text);
            if !out.is_empty() {
                note_engine_success("bing-news");
                return out;
            }
        }
    }

    // ── Stage B: Google News RSS fallback (source-url extraction) ──────
    // Only keep items where <source url="..."> gave us the real
    // publisher URL — encrypted news.google.com/rss/articles/ wrappers
    // are NOT extractable and must be skipped.
    let gnews_url = "https://news.google.com/rss/search?q=".to_string()
        + &enc_component(query)
        + "&hl=en-IN&gl=IN&ceid=IN:en";
    let res = match net
        .fetch_url(
            &gnews_url,
            &UrlFetchOpts {
                timeout_ms: Some(15_000),
                use_realistic_headers: true,
                headers: vec![
                    (
                        "accept".to_string(),
                        "application/rss+xml, application/xml, text/xml;q=0.9".to_string(),
                    ),
                    ("referer".to_string(), "https://news.google.com/".to_string()),
                ],
                ..Default::default()
            },
        )
        .await
    {
        Some(r) => r,
        None => {
            trip_immediate("bing-news", "google-news RSS fetch failed (transport/timeout)");
            return Vec::new();
        }
    };
    if !res.ok || res.text.is_empty() {
        trip_circuit_breaker(
            "bing-news",
            &format!("news feeds returned {} with no usable items", res.status),
        );
        return Vec::new();
    }
    static RE_GN_ITEM: OnceLock<Regex> = OnceLock::new();
    static RE_GN_TITLE: OnceLock<Regex> = OnceLock::new();
    static RE_GN_PUB: OnceLock<Regex> = OnceLock::new();
    static RE_GN_SOURCE: OnceLock<Regex> = OnceLock::new();
    static RE_WS2: OnceLock<Regex> = OnceLock::new();
    let re_item = RE_GN_ITEM.get_or_init(|| Regex::new(r"<item>[\s\S]*?</item>").unwrap());
    let re_title = RE_GN_TITLE
        .get_or_init(|| Regex::new(r"<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</title>").unwrap());
    let re_pub = RE_GN_PUB.get_or_init(|| Regex::new(r"<pubDate>([^<]+)</pubDate>").unwrap());
    let re_source =
        RE_GN_SOURCE.get_or_init(|| Regex::new(r#"<source[^>]*url="([^"]+)""#).unwrap());
    let re_ws = RE_WS2.get_or_init(|| Regex::new(r"\s+").unwrap());

    let mut out: Vec<RawSearchResult> = Vec::new();
    for item_m in re_item.find_iter(&res.text) {
        if out.len() >= 25 {
            break;
        }
        let item = item_m.as_str();
        let title = match re_title.captures(item) {
            Some(c) => re_ws.replace_all(c[1].trim(), " ").to_string(),
            None => String::new(),
        };
        let pub_date = re_pub.captures(item).map(|c| c[1].to_string());
        // <source url="..."> = the authoritative publisher URL.
        let target = match re_source.captures(item) {
            Some(c) => c[1].trim().to_string(),
            None => String::new(),
        };
        if target.is_empty() || !crate::ssrf::is_safe_url(&target) {
            continue;
        }
        out.push(RawSearchResult {
            title,
            url: target,
            snippet: String::new(),
            engine: "google-news".to_string(),
            published_date: pub_date,
            rank: (out.len() + 1) as i64,
        });
    }
    if out.is_empty() {
        trip_circuit_breaker("bing-news", "news feeds parsed 0 usable items");
    } else {
        note_engine_success("bing-news");
    }
    out
}

/// JS template-literal / string-concatenation coercion:
/// `undefined` → "undefined", `null` → "null", numbers/bools → their
/// string form, arrays → comma join, objects → "[object Object]".
/// (JS `${u.login}` with a MISSING login yields "GitHub: undefined" —
/// jstr_chain's "" would be wrong here; this helper keeps parity.)
fn js_tostring_json(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| js_tostring_json(Some(x)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// JS `x ?? fallback` for one property: nullish (missing / null) takes
/// the fallback; any other value stringifies JS-concat style.
fn js_nullish_concat(
    obj: &Value,
    key: &str,
    fallback: impl FnOnce(&Value) -> String,
) -> String {
    match obj.get(key) {
        None | Some(Value::Null) => fallback(obj),
        Some(v) => js_tostring_json(Some(v)),
    }
}

/// TS `x ?? ""` for a plain string field (repo.name without the ??:
/// a MISSING name is `undefined` in JS; DIVERGENCE: becomes "" here).
fn js_tostring_or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_tostring_json(Some(v)),
    }
}

/// TS `x ?? "default"` nullish stringification (u.type ?? "User").
fn js_tostring_or_nullish_default(v: Option<&Value>, default: &str) -> String {
    match v {
        None | Some(Value::Null) => default.to_string(),
        Some(v) => js_tostring_json(Some(v)),
    }
}

/// TS `githubSearch` — keyless REST API: users → repositories → issues.
/// Breaker-gated ("github"); trips / notes on the FINAL result count
/// (bench 2026-10-29: 403x35 + 429x109 with no cooldown ever).
async fn github_search_inner(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    if !engine_pacer_with_breaker("github").await {
        return Vec::new();
    }
    let mut out: Vec<RawSearchResult> = Vec::new();

    // 0. User search — instant JSON for developer portfolios / named devs
    //    (the .dev domain case: "skiran" → their GitHub profile).
    let user_res = net
        .fetch_url(
            &("https://api.github.com/search/users?q=".to_string()
                + &enc_component(query)
                + "&per_page=5"),
            &UrlFetchOpts {
                timeout_ms: Some(12_000),
                headers: vec![
                    ("accept".to_string(), "application/vnd.github+json".to_string()),
                    ("x-github-api-version".to_string(), "2022-11-28".to_string()),
                ],
                ..Default::default()
            },
        )
        .await;
    if let Some(r) = user_res {
        if r.ok && !r.text.is_empty() {
            if let Ok(data) = serde_json::from_str::<Value>(&r.text) {
                if let Some(Value::Array(items)) = data.get("items") {
                    for u in items {
                        out.push(RawSearchResult {
                            title: format!("GitHub: {}", js_tostring_json(u.get("login"))),
                            url: js_nullish_concat(u, "html_url", |obj| {
                                "https://github.com/".to_string()
                                    + &js_tostring_json(obj.get("login"))
                            }),
                            snippet: format!(
                                "{} \u{2014} GitHub profile for \"{}\"",
                                js_tostring_or_nullish_default(u.get("type"), "User"),
                                query
                            ),
                            engine: "github".to_string(),
                            published_date: None,
                            rank: (out.len() + 1) as i64,
                        });
                    }
                }
            }
        }
    }

    // 1. Repository search
    let repo_res = net
        .fetch_url(
            &("https://api.github.com/search/repositories?q=".to_string()
                + &enc_component(query)
                + "&per_page=8"),
            &UrlFetchOpts {
                timeout_ms: Some(15_000),
                headers: vec![
                    ("accept".to_string(), "application/vnd.github+json".to_string()),
                    ("x-github-api-version".to_string(), "2022-11-28".to_string()),
                ],
                ..Default::default()
            },
        )
        .await;
    if let Some(r) = repo_res {
        if r.ok && !r.text.is_empty() {
            if let Ok(data) = serde_json::from_str::<Value>(&r.text) {
                if let Some(Value::Array(items)) = data.get("items") {
                    for repo in items {
                        out.push(RawSearchResult {
                            // QUIRK (parity): repo.name has NO ?? — a MISSING
                            // name is `undefined` in JS. DIVERGENCE: Rust
                            // stores "" (RawSearchResult.title is String).
                            title: js_tostring_or_empty(repo.get("name")),
                            url: js_nullish_concat(repo, "html_url", |obj| {
                                "https://github.com/".to_string()
                                    + &js_tostring_json(obj.get("full_name"))
                            }),
                            snippet: js_slice_max(
                                &js_tostring_or_empty(repo.get("description")),
                                400,
                            ),
                            engine: "github".to_string(),
                            published_date: None,
                            rank: (out.len() + 1) as i64,
                        });
                    }
                }
            }
        }
    }

    // 2. Issue search (fills gaps when repo search is sparse)
    if out.len() < 5 {
        let issue_res = net
            .fetch_url(
                &("https://api.github.com/search/issues?q=".to_string()
                    + &enc_component(query)
                    + "&per_page=8"),
                &UrlFetchOpts {
                    timeout_ms: Some(15_000),
                    headers: vec![
                        (
                            "accept".to_string(),
                            "application/vnd.github+json".to_string(),
                        ),
                        ("x-github-api-version".to_string(), "2022-11-28".to_string()),
                    ],
                    ..Default::default()
                },
            )
            .await;
        if let Some(r) = issue_res {
            if r.ok && !r.text.is_empty() {
                if let Ok(data) = serde_json::from_str::<Value>(&r.text) {
                    if let Some(Value::Array(items)) = data.get("items") {
                        for item in items {
                            // item.pull_request?.url ?? item.html_url ?? ""
                            let url = match item.get("pull_request").and_then(|pr| pr.get("url")) {
                                None | Some(Value::Null) => match item.get("html_url") {
                                    None | Some(Value::Null) => String::new(),
                                    Some(v) => js_tostring_json(Some(v)),
                                },
                                Some(v) => js_tostring_json(Some(v)),
                            };
                            if !crate::ssrf::is_safe_url(&url) {
                                continue;
                            }
                            out.push(RawSearchResult {
                                title: js_tostring_or_empty(item.get("title")),
                                url,
                                snippet: js_slice_max(
                                    &js_tostring_or_empty(item.get("body")),
                                    400,
                                ),
                                engine: "github".to_string(),
                                // item.created_at passes through raw; only a
                                // JSON string survives as Some (divergence:
                                // a numeric created_at reaches JS untouched).
                                published_date: item
                                    .get("created_at")
                                    .and_then(|v| v.as_str())
                                    .map(String::from),
                                rank: (out.len() + 1) as i64,
                            });
                        }
                    }
                }
            }
        }
    }

    if out.is_empty() {
        trip_circuit_breaker("github", "github API returned 0 usable results");
    } else {
        note_engine_success("github");
    }
    take_n(out, 15)
}

/// TS `DEVTO_TECH_TAGS` — verbatim set (the dotted "next.js" entry is
/// dead code: devtoTagForQuery strips dots BEFORE matching, so a token
/// can never contain "."; kept for parity).
const DEVTO_TECH_TAGS: &[&str] = &[
    "javascript", "typescript", "node", "nodejs", "python", "rust", "go", "golang", "java", "kotlin",
    "swift", "ruby", "php", "c", "c++", "react", "nextjs", "next.js", "vue", "angular", "svelte",
    "express", "nestjs", "django", "flask", "fastapi", "reactjs", "html", "css", "sql", "graphql",
    "postgres", "linux", "git", "docker", "kubernetes", "terraform", "aws", "azure", "gcp",
    "firebase",
];

/// TS `devtoTagForQuery` — the first whitespace token that matches a
/// known tech tag after lowercasing and stripping [._-].
/// DIVERGENCE: JS split(/\s+/) yields a leading EMPTY token when the
/// query starts with whitespace; "" is not in the tag set, so the
/// outcome is identical to split_whitespace.
fn devto_tag_for_query(query: &str) -> Option<&'static str> {
    let cleaned = query.to_lowercase().replace(['.', '_', '-'], "");
    for t in cleaned.split_whitespace() {
        if let Some(tag) = DEVTO_TECH_TAGS.iter().find(|tag| **tag == t) {
            return Some(tag);
        }
    }
    None
}

/// TS `devToSearch` — tagged feed → free-text feed_content.
/// Breaker-gated ("devto"); trips / notes on the FINAL result count.
async fn dev_to_search_inner(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    if !engine_pacer_with_breaker("devto").await {
        return Vec::new();
    }
    let mut out: Vec<RawSearchResult> = Vec::new();

    // 1. Tagged feed (when the query contains a known tech tag).
    if let Some(tag) = devto_tag_for_query(query) {
        let tag_url = "https://dev.to/api/articles?per_page=15&top=365&tag=".to_string()
            + &enc_component(tag);
        let tag_res = net
            .fetch_url(
                &tag_url,
                &UrlFetchOpts {
                    timeout_ms: Some(15_000),
                    headers: vec![
                        ("accept".to_string(), "application/json".to_string()),
                        ("referer".to_string(), "https://dev.to/".to_string()),
                    ],
                    ..Default::default()
                },
            )
            .await;
        if let Some(r) = tag_res {
            if r.ok && !r.text.is_empty() {
                // collapsible_match wants one nested pattern — the two-step
                // shape mirrors the TS `try { parse } + Array.isArray` pair.
                if let Ok(data) = serde_json::from_str::<Value>(&r.text) {
                    // Array.isArray(data) ? data : []
                    #[allow(clippy::collapsible_match)]
                    if let Value::Array(articles) = data {
                        for article in &articles {
                            let url = match article.get("url") {
                                None | Some(Value::Null) => {
                                    // "https://dev.to/" + (user?.username ?? "")
                                    //            + "/" + (slug ?? "")
                                    // user?.username ?? "" — a non-object
                                    // user (string/number) yields undefined
                                    // in JS ⇒ "" (Value::get ⇒ None here).
                                    let username =
                                        match article.get("user").and_then(|u| u.get("username"))
                                        {
                                            None | Some(Value::Null) => String::new(),
                                            Some(v) => js_tostring_json(Some(v)),
                                        };
                                    format!(
                                        "https://dev.to/{}/{}",
                                        username,
                                        js_tostring_or_empty(article.get("slug"))
                                    )
                                }
                                Some(v) => js_tostring_json(Some(v)),
                            };
                            if !crate::ssrf::is_safe_url(&url) {
                                continue;
                            }
                            // article?.tag_list?.join(", ") ?? "" — a
                            // NON-array tag_list makes JS throw (.join) into
                            // the block catch; Rust treats it as "" (only the
                            // array branch is joined).
                            let tags = match article.get("tag_list") {
                                Some(Value::Array(list)) => list
                                    .iter()
                                    .map(|x| js_tostring_json(Some(x)))
                                    .collect::<Vec<_>>()
                                    .join(", "),
                                _ => String::new(),
                            };
                            out.push(RawSearchResult {
                                title: js_tostring_or_empty(article.get("title")),
                                url,
                                snippet: tags
                                    + " \u{2014} "
                                    + &js_slice_max(
                                        &js_tostring_or_empty(article.get("description")),
                                        200,
                                    ),
                                engine: "devto".to_string(),
                                published_date: article
                                    .get("published_at")
                                    .and_then(|v| v.as_str())
                                    .map(String::from),
                                rank: (out.len() + 1) as i64,
                            });
                        }
                    }
                }
            }
        }
    }

    // 2. Free-text search (fills gaps when tag feed is sparse or tag is null).
    if out.len() < 5 {
        let search_url =
            "https://dev.to/search/feed_content?per_page=15&page=0&class_name=Article&search_fields="
                .to_string()
                + &enc_component(query);
        let search_res = net
            .fetch_url(
                &search_url,
                &UrlFetchOpts {
                    timeout_ms: Some(15_000),
                    headers: vec![
                        ("accept".to_string(), "application/json".to_string()),
                        ("referer".to_string(), "https://dev.to/".to_string()),
                    ],
                    ..Default::default()
                },
            )
            .await;
        if let Some(r) = search_res {
            if r.ok && !r.text.is_empty() {
                if let Ok(data) = serde_json::from_str::<Value>(&r.text) {
                    // data?.items ?? data?.results ?? (Array.isArray(data) ? data : [])
                    // DIVERGENCE: JS picks the first NON-nullish items/results
                    // value even when it is a non-array object (for..of then
                    // THROWS into the block catch); Rust requires an actual
                    // ARRAY to iterate and falls through to the next ?? arm /
                    // the array check otherwise.
                    let items: Vec<Value> = match data.get("items") {
                        Some(Value::Array(a)) => a.clone(),
                        Some(Value::Null) | None => match data.get("results") {
                            Some(Value::Array(a)) => a.clone(),
                            Some(Value::Null) | None => match &data {
                                Value::Array(a) => a.clone(),
                                _ => Vec::new(),
                            },
                            Some(_) => Vec::new(),
                        },
                        Some(_) => Vec::new(),
                    };
                    for item in &items {
                        let url = match item.get("url") {
                            None | Some(Value::Null) => match item.get("link") {
                                None | Some(Value::Null) => String::new(),
                                Some(v) => js_tostring_json(Some(v)),
                            },
                            Some(v) => js_tostring_json(Some(v)),
                        };
                        if !crate::ssrf::is_safe_url(&url) {
                            continue;
                        }
                        out.push(RawSearchResult {
                            title: js_tostring_or_empty(item.get("title")),
                            url,
                            snippet: js_slice_max(
                                &match item.get("description") {
                                    None | Some(Value::Null) => match item.get("snippet") {
                                        None | Some(Value::Null) => String::new(),
                                        Some(v) => js_tostring_json(Some(v)),
                                    },
                                    Some(v) => js_tostring_json(Some(v)),
                                },
                                400,
                            ),
                            engine: "devto".to_string(),
                            published_date: match item.get("published_at") {
                                None | Some(Value::Null) => item
                                    .get("created_at")
                                    .and_then(|v| v.as_str())
                                    .map(String::from),
                                Some(v) => v.as_str().map(String::from),
                            },
                            rank: (out.len() + 1) as i64,
                        });
                    }
                }
            }
        }
    }

    if out.is_empty() {
        trip_circuit_breaker("devto", "dev.to returned 0 results");
    } else {
        note_engine_success("devto");
    }
    take_n(out, 15)
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/// TS `deduplicateQueries` — collapse sub-queries sharing >80% token
/// overlap. NOTE (parity): the TS header claims the biryani pair shares
/// "~80%"; the ACTUAL formula is |A∩B| / max(1, min(|A|,|B|)) with a
/// STRICT `> 0.8` threshold — at exactly 0.8 the query is KEPT.
pub fn deduplicate_queries(queries: &[String]) -> Vec<String> {
    if queries.len() <= 1 {
        return queries.to_vec();
    }
    // t.length > 2 is a UTF-16 code-unit count (js_len), parity.
    let token_sets: Vec<HashSet<String>> = queries
        .iter()
        .map(|q| {
            q.to_lowercase()
                .split_whitespace()
                .filter(|t| js_len(t) > 2)
                .map(String::from)
                .collect()
        })
        .collect();
    let mut keep: Vec<String> = Vec::new();
    let mut kept_sets: Vec<&HashSet<String>> = Vec::new();
    for (i, q) in queries.iter().enumerate() {
        let mut is_dup = false;
        for b in &kept_sets {
            let a = &token_sets[i];
            // Jaccard-style: |A∩B| / min(|A|,|B|)
            let intersection = a.iter().filter(|t| b.contains(*t)).count();
            let overlap =
                intersection as f64 / (token_sets[i].len().min(b.len()).max(1)) as f64;
            if overlap > 0.8 {
                is_dup = true;
                break;
            }
        }
        if !is_dup {
            keep.push(q.clone());
            kept_sets.push(&token_sets[i]);
        }
    }
    // The first query is always kept, so the `keep.length > 0` branch is
    // effectively dead; the fallback is retained for parity.
    if !keep.is_empty() {
        keep
    } else {
        vec![queries[0].clone()]
    }
}

/// Engine entry shape (TS `GENERAL_WEB_ENGINES` element type). The Net
/// seam is the FIRST parameter — the TS engines close over the module's
/// real fetchPage/fetchUrl; Rust injects `net` so tests can drive every
/// parser through [`crate::net::ScriptedNet`] with zero network.
// Instrumentation only: per-engine wall-clock + result count. Tracing fields
// are NOT part of the observable parity surface, so this wraps the pub engine
// wrappers without touching wire/cache behavior.
async fn timed_engine(
    engine: &'static str,
    fut: impl std::future::Future<Output = Vec<RawSearchResult>>,
) -> Vec<RawSearchResult> {
    let t0 = std::time::Instant::now();
    let out = fut.await;
    tracing::info!(
        engine,
        engine_ms = t0.elapsed().as_millis() as u64,
        results = out.len(),
        "engine outcome"
    );
    out
}

pub type EngineFn =
    for<'a, 'b> fn(&'a dyn Net, &'b str) -> BoxFuture<'a, Vec<RawSearchResult>>;

// Exported engine wrappers (TS `export async function` equivalents). Each
// copies the query so the returned future is `Send + 'a` (the borrowed query
// only lives during the call itself).

pub fn ddg_search<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("duckduckgo", ddg_search_inner(net, &q)).await })
}

pub fn ddg_lite_post<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("ddg-lite", ddg_lite_post_inner(net, &q)).await })
}

pub fn yahoo_search<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("yahoo", yahoo_search_inner(net, &q)).await })
}

pub fn google_search<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("google", google_search_inner(net, &q)).await })
}

pub fn brave_search<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("brave", brave_search_inner(net, &q)).await })
}

pub fn reddit_search<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("reddit", reddit_search_inner(net, &q)).await })
}

pub fn bing_search<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("bing", bing_search_inner(net, &q)).await })
}

pub fn bing_news_rss_search<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("bing-news", bing_news_rss_search_inner(net, &q)).await })
}

pub fn github_search<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("github", github_search_inner(net, &q)).await })
}

pub fn dev_to_search<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move { timed_engine("devto", dev_to_search_inner(net, &q)).await })
}

/// TS `GENERAL_WEB_ENGINES` — the "General Web Index Pool".
///
/// Strictly general-web + community engines. News/dev verticals
/// (bing_news_rss_search, github_search, dev_to_search) are routed by
/// intent in metasearch.ts, NOT run on every sub-query.
///
/// Every sub-query in a plan is distributed across this pool with
/// per-engine pacing (one in-flight per host, 250–450 ms jitter) so that
/// 4 sub-queries × 6 engines never fire 24 simultaneous requests at any
/// single host.
///
/// ORDER IS LOAD-BEARING (merge order in the runners): ddg, ddg-lite,
/// google, bing, yahoo, brave, reddit — the TS `as const` list verbatim.
pub static GENERAL_WEB_ENGINES: [EngineFn; 7] = [
    ddg_search,      // DuckDuckGo (3-stage: cookie-primed html POST → lite POST → VQD, 12s per stage)
    ddg_lite_post,   // DDG Lite form-POST — resilient when html.duckduckgo.com 429s
    google_search,   // Google live web index (got-scraping fingerprints, parse-first)
    bing_search,     // Bing (RSS feed → cookie-primed HTML, ck/a decode, parse-first)
    yahoo_search,    // Bing global web index (RU= unwrap, parse-first)
    brave_search,    // Brave's own index
    reddit_search,   // community ground-truth (3-stage: RSS → PullPush → JSON)
];

/// TS `runGeneralWebSearch` — one query against ALL pool engines.
///
/// DIVERGENCE (async model): every TS engine already swallows its own
/// errors (`.catch(() => [])` is belt-and-braces; `Promise.allSettled`
/// likewise). The ported engines likewise always return a Vec, so
/// `join_all` reproduces the settled-merge. A Rust PANIC (impossible in
/// the JS control flow) is NOT caught, unlike the TS catch-alls.
pub async fn run_general_web_search(net: &dyn Net, query: &str) -> Vec<RawSearchResult> {
    let settled = join_all(GENERAL_WEB_ENGINES.iter().map(|f| f(net, query))).await;
    let mut out: Vec<RawSearchResult> = Vec::new();
    for v in settled {
        out.extend(v);
    }
    out
}

/// TS `runGeneralWebSearchSharded` — distribute sub-queries across
/// DIFFERENT engines with 150–300 ms stagger (anti-429-cascade design;
/// see the TS doc comment preserved on the TS export).
///
/// DIVERGENCE (async model, recorded): in TS the staged `Promise`
/// factories START dispatching as they are created, so the stagger
/// literally paces the outbound requests. Rust `BoxFuture`s are lazy —
/// nothing is polled until `join_all` at the bottom — so the stagger
/// still burns the same wall-clock before polling starts, but the
/// cross-engine request interleaving afterwards is governed by
/// `join_all` poll order plus the per-engine pacer (which enforces the
/// one-in-flight-per-host rule the stagger was protecting).
pub async fn run_general_web_search_sharded(
    net: &dyn Net,
    primary_query: &str,
    all_queries: &[String],
) -> Vec<RawSearchResult> {
    // TS: 150 + Math.floor(Math.random() * 150) ms.
    let stagger = || async {
        let ms = 150 + (js_random() * 150.0).floor() as u64;
        tokio::time::sleep(Duration::from_millis(ms)).await;
    };

    // Tier 1: fast zero-CAPTCHA feeds — every query, staggered by 200 ms.
    let mut tier1: Vec<BoxFuture<'_, Vec<RawSearchResult>>> = Vec::new();
    for (i, q) in all_queries.iter().enumerate() {
        if i > 0 {
            stagger().await;
        }
        tier1.push(ddg_lite_post(net, q));
    }

    // Tier 2: rate-sensitive direct scrapers — primary query only, staggered.
    stagger().await;
    let mut tier2: Vec<BoxFuture<'_, Vec<RawSearchResult>>> = Vec::new();
    tier2.push(ddg_search(net, primary_query));
    stagger().await;
    tier2.push(google_search(net, primary_query));
    stagger().await;
    tier2.push(brave_search(net, primary_query));
    stagger().await;
    tier2.push(yahoo_search(net, primary_query));

    // Tier 3: community / news — every query, staggered.
    let mut tier3: Vec<BoxFuture<'_, Vec<RawSearchResult>>> = Vec::new();
    for (i, q) in all_queries.iter().enumerate() {
        if i > 0 {
            stagger().await;
        }
        tier3.push(reddit_search(net, q));
    }
    stagger().await;
    tier3.push(bing_search(net, primary_query));
    stagger().await;
    tier3.push(bing_news_rss_search(net, primary_query));

    // GitHub: instant JSON, zero CAPTCHA — fires in parallel with tier 1.
    let github = github_search(net, primary_query);

    let mut all: Vec<BoxFuture<'_, Vec<RawSearchResult>>> = Vec::new();
    all.extend(tier1);
    all.extend(tier2);
    all.extend(tier3);
    all.push(github);
    let settled = join_all(all).await;
    let mut out: Vec<RawSearchResult> = Vec::new();
    for v in settled {
        out.extend(v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── pure helpers ───────────────────────────────────────────────────────

    #[test]
    fn decode_uddg_double_decode_quirk() {
        // The SERP href stores uddg percent-encoded TWICE (searchParams
        // decodes once, decodeURIComponent decodes again — TS quirk).
        assert_eq!(
            decode_uddg("//duckduckgo.com/l/?uddg=https%253A%252f%252falpha-one.com%252f&rut=ab"),
            "https://alpha-one.com/"
        );
        // No uddg at all ⇒ the resolved redirect URL itself.
        assert_eq!(
            decode_uddg("/something"),
            "https://duckduckgo.com/something"
        );
        // Regex fallback branch (uddg inside a fragment ⇒ not a query key).
        assert_eq!(
            decode_uddg("https://duckduckgo.com/l#uddg=https%3A%2F%2Fgamma-three.net%2Fz"),
            "https://gamma-three.net/z"
        );
    }

    #[test]
    fn unwrap_ru_href_decodes_and_resolves() {
        assert_eq!(
            unwrap_ru_href(
                "/search?p=x&RU=https%3A%2F%2Falpha-one.com%2Fart&RK=9",
                "https://in.search.yahoo.com/search?p=t&n=15"
            ),
            "https://alpha-one.com/art"
        );
        // Regex fallback (RU=/RK= shape inside a fragment).
        assert_eq!(
            unwrap_ru_href(
                "https://in.search.yahoo.com/s?x=1#RU=https%3A%2F%2Fgamma-three.net%2Fw/RK=9",
                "https://in.search.yahoo.com/search?p=t&n=15"
            ),
            "https://gamma-three.net/w"
        );
    }

    #[test]
    fn unwrap_google_href_branches() {
        assert_eq!(
            unwrap_google_href("/url?q=https%3A%2F%2Falpha-one.com%2Fpage"),
            "https://alpha-one.com/page"
        );
        // /url with NO q param ⇒ the [?&]url= regex fallback.
        assert_eq!(
            unwrap_google_href("/url?url=https%3A%2F%2Fbeta-two.org%2Fy"),
            "https://beta-two.org/y"
        );
        // Non-/url paths pass through resolved.
        assert_eq!(
            unwrap_google_href("/search?q=x"),
            "https://www.google.com/search?q=x"
        );
    }

    #[test]
    fn node_base64_decode_is_forgiving_like_node() {
        assert_eq!(
            node_base64_decode("aHR0cHM6Ly90ZXN0LmNvbS8="),
            "https://test.com/"
        );
        // Node SKIPS non-alphabet chars and tolerates missing padding.
        assert_eq!(
            node_base64_decode("a!H R0c HM6Ly90ZXN0LmNvbS8"),
            "https://test.com/"
        );
    }

    #[test]
    fn decode_bing_ck_branches() {
        assert_eq!(
            decode_bing_ck("/ck/a?u=a1aHR0cHM6Ly9jazEtcGFyaXR5LmNvbS9h&psig=Q"),
            "https://ck1-parity.com/a"
        );
        // Direct (non-ck) absolute href passes through resolved.
        assert_eq!(
            decode_bing_ck("https://direct-one.com/x"),
            "https://direct-one.com/x"
        );
        // ck/a WITHOUT a u param: stays the (resolved) tracker URL.
        assert_eq!(
            decode_bing_ck("https://www.bing.com/ck/a?nope=1"),
            "https://www.bing.com/ck/a?nope=1"
        );
    }

    #[test]
    fn is_blocked_secondary_check_only() {
        assert!(is_blocked("tiny"), "body < 500 units is blocked");
        assert!(!is_blocked(&"a".repeat(600)));
        let mut padded = "x".repeat(100);
        padded.push_str("Please enable JavaScript to continue");
        padded.push_str(&"y".repeat(500));
        assert!(is_blocked(&padded));
    }

    #[test]
    fn utf16_length_semantics() {
        assert_eq!(js_len("a\u{1F600}b"), 4); // astral char = 2 UTF-16 units
        assert_eq!(js_slice_max("hello\u{1F600}world", 7), "hello\u{1F600}");
        assert_eq!(js_slice_max("hello", 2), "he");
    }

    #[test]
    fn js_iso_matches_date_toseconds_isostring() {
        assert_eq!(
            js_iso_from_utc_secs(&json!(1_700_000_000)).as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(
            js_iso_from_utc_secs(&json!("1700000000")).as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        // Out of Date range ⇒ JS toISOString() throws ⇒ stage swallow.
        assert!(js_iso_from_utc_secs(&json!(1e30)).is_none());
        assert!(js_iso_from_utc_secs(&json!(null)).is_none());
    }

    #[test]
    fn devto_tag_matching() {
        // "."/ "_" / "-" are stripped from each token before lookup.
        assert_eq!(devto_tag_for_query("Next.js here"), Some("nextjs"));
        assert_eq!(devto_tag_for_query("Learn C++ today"), Some("c++"));
        assert_eq!(devto_tag_for_query("nope nothing"), None);
    }

    #[test]
    fn deduplicate_queries_jaccard_semantics() {
        // Exactly-0.8 overlap KEEPS both (the TS guard is `> 0.8`).
        let kept = deduplicate_queries(&[
            "alpha bravo charlie delta echo".to_string(),
            "alpha bravo charlie delta foxtrot".to_string(),
        ]);
        assert_eq!(kept.len(), 2);
        // Full overlap drops the second.
        let dropped = deduplicate_queries(&[
            "rust web dev".to_string(),
            "rust web dev".to_string(),
        ]);
        assert_eq!(dropped, vec!["rust web dev".to_string()]);
        // <=1 query passes through untouched.
        let single = deduplicate_queries(&["solo".to_string()]);
        assert_eq!(single, vec!["solo".to_string()]);
        assert!(deduplicate_queries(&[]).is_empty());
    }

    #[test]
    fn take_n_truncates_like_slice_0_n() {
        let v = vec![
            RawSearchResult { title: "1".into(), url: "https://a.com/".into(), snippet: String::new(), engine: "e".into(), published_date: None, rank: 1 },
            RawSearchResult { title: "2".into(), url: "https://b.com/".into(), snippet: String::new(), engine: "e".into(), published_date: None, rank: 2 },
        ];
        assert_eq!(take_n(v.clone(), 1).len(), 1);
        assert_eq!(take_n(v, 5).len(), 2);
    }

    #[test]
    fn general_web_engines_order_is_load_bearing() {
        let want: [EngineFn; 7] = [
            ddg_search, ddg_lite_post, google_search, bing_search,
            yahoo_search, brave_search, reddit_search,
        ];
        assert_eq!(GENERAL_WEB_ENGINES.len(), 7);
        for i in 0..7usize {
            assert_eq!(
                GENERAL_WEB_ENGINES[i] as usize,
                want[i] as usize,
                "GENERAL_WEB_ENGINES position {i} diverged from the TS `as const` order"
            );
        }
    }
}


// ── Engine-family tests ───────────────────────────────────────────────────
// Deterministic via ScriptedNet only — zero real network. The pacer and
// circuit-breaker maps are process-wide statics, so every engine test
// takes `engine_test_lock()` and resets state first.
#[cfg(test)]
mod serp_tests {
    use super::*;
    use crate::net::{PageResponse, ScriptedNet, UrlFetchResult};

    fn page(body: &str) -> PageResponse {
        PageResponse {
            status: 200,
            ok: true,
            body: body.to_string(),
            content_type: "text/html".into(),
            elapsed_ms: 1,
            fingerprint: "chrome".into(),
            cookies: vec![],
            resolved_url: String::new(),
            bot_name: None,
        }
    }

    fn txt(text: &str) -> UrlFetchResult {
        UrlFetchResult {
            status: 200,
            ok: true,
            text: text.to_string(),
        }
    }

    fn calls_of(net: &ScriptedNet) -> Vec<(String, &'static str)> {
        net.calls.lock().expect("lock").clone()
    }

    const DDG_HTML_URL: &str = "https://html.duckduckgo.com/html/";
    const DDG_LITE_PRIME: &str = "https://lite.duckduckgo.com/lite/?q=test";
    const DDG_LITE_POST: &str = "https://lite.duckduckgo.com/lite/";

    #[tokio::test]
    async fn ddg_stage_a_html_hits_and_short_circuits() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        let body = "<div class=\"result\"><h2><a class=\"result__a\" href=\"//duckduckgo.com/l/?uddg=https%253A%252f%252falpha-one.com%252f\">Alpha</a></h2><a class=\"result__snippet\">Alpha sn</a></div><div class=\"result\"><h2><a class=\"result__a\" href=\"//duckduckgo.com/l/?uddg=https%253A%252f%252fbeta-two.org%252fx\">Beta</a></h2><a class=\"result__snippet\">Beta sn</a></div>";
        let net = ScriptedNet::default()
            .with_page(DDG_HTML_URL, page(body))
            .with_url(DDG_HTML_URL, txt(body));
        let out = ddg_search(&net, "test").await;
        assert_eq!(out.len(), 2, "stage A >=2 results short-circuits");
        assert_eq!(out[0].url, "https://alpha-one.com/");
        assert_eq!(out[0].snippet, "Alpha sn");
        assert_eq!(out[0].engine, "duckduckgo");
        assert_eq!(out[1].rank, 2);
        assert_eq!(
            calls_of(&net),
            vec![
                (DDG_HTML_URL.to_string(), "fetch_page"),
                (DDG_HTML_URL.to_string(), "fetch_url"),
            ],
            "lite endpoints must not be touched when html answers"
        );
        assert_eq!(engine_cooldown_remaining_ms("duckduckgo"), 0);
    }

    #[tokio::test]
    async fn ddg_cascade_falls_to_lite_and_snippets_from_parent() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        // html stage: page scripted-but-EMPTY and url unscripted ⇒ stage A 0s;
        // lite stage answers. Snippet lives in the anchor's parent cell
        // (TS: a.parentElement?.querySelector(".result-snippet")).
        let lite_body = "<table><tr><td><a class=\"result-link\" href=\"/l/?uddg=https%253A%252f%252falpha-one.com%252f\">A</a><div class=\"result-snippet\">SnA</div></td></tr><tr><td><a class=\"result-link\" href=\"/l/?uddg=https%253A%252f%252fbeta-two.org%252fy\">B</a><div class=\"result-snippet\">SnB</div></td></tr></table>";
        let net = ScriptedNet::default()
            .with_page(DDG_HTML_URL, page("<html>nothing here</html>"))
            .with_page(DDG_LITE_PRIME, page("<html>prime</html>"))
            .with_url(DDG_LITE_POST, txt(lite_body));
        let out = ddg_search(&net, "test").await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].url, "https://alpha-one.com/");
        assert_eq!(out[0].snippet, "SnA", "lite snippet comes from the parent cell");
        assert_eq!(out[1].snippet, "SnB");
        assert_eq!(
            calls_of(&net),
            vec![
                (DDG_HTML_URL.to_string(), "fetch_page"),
                (DDG_HTML_URL.to_string(), "fetch_url"),
                (DDG_LITE_PRIME.to_string(), "fetch_page"),
                (DDG_LITE_POST.to_string(), "fetch_url"),
            ]
        );
        assert_eq!(engine_cooldown_remaining_ms("duckduckgo"), 0);
    }

    #[tokio::test]
    async fn ddg_breaker_needs_two_zero_observations_per_call() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        let net = ScriptedNet::default(); // every stage unscripted ⇒ None
        let a = ddg_search(&net, "test").await;
        assert!(a.is_empty());
        assert_eq!(
            engine_cooldown_remaining_ms("duckduckgo"),
            0,
            "streak 1 is an info-log observation only"
        );
        // Call 2 is still ALLOWED (the trip lands at its END): 4 stage
        // requests fire, then the streak-2 trip opens the cooldown.
        let b = ddg_search(&net, "test").await;
        assert!(b.is_empty());
        let remaining = engine_cooldown_remaining_ms("duckduckgo");
        assert!(remaining > 0 && remaining <= ENGINE_COOLDOWN_MS);
        let calls_after_trip = calls_of(&net).len();
        let c = ddg_search(&net, "test").await;
        assert!(c.is_empty());
        assert_eq!(
            calls_of(&net).len(),
            calls_after_trip,
            "while cooling down the engine makes ZERO requests"
        );
    }

    #[tokio::test]
    async fn yahoo_region_cascade_ru_unwrap_and_host_filter() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        let serp = "<li class=\"strm\"><a class=\"dd\" href=\"/search?p=test&RU=https%3A%2F%2Falpha-one.com%2Fart&RK=1\">One</a><p>Sn1</p></li><li class=\"strm\"><a class=\"dd\" href=\"/search?p=test&RU=https%3A%2F%2Fbeta-two.org%2Fb&RK=1\">Two</a><p>Sn2</p></li><div class=\"algo\"><a href=\"https://www.yahoo.com/news/x\">skip</a></div>".to_string()
            + &"p".repeat(600);
        let region2 = "https://search.yahoo.com/search?p=test&n=15";
        let net = ScriptedNet::default().with_page(region2, page(&serp));
        let out = yahoo_search(&net, "test").await;
        assert_eq!(out.len(), 2, "the yahoo.com internal link is filtered");
        assert_eq!(out[0].url, "https://alpha-one.com/art");
        assert_eq!(out[0].snippet, "Sn1");
        assert_eq!(out[0].engine, "yahoo");
        assert_eq!(out[1].url, "https://beta-two.org/b");
        assert_eq!(
            calls_of(&net),
            vec![
                ("https://in.search.yahoo.com/search?p=test&n=15".to_string(), "fetch_page"),
                (region2.to_string(), "fetch_page"),
            ],
            "region 1 unscripted ⇒ None ⇒ next region (TS try/catch)"
        );
        assert_eq!(engine_cooldown_remaining_ms("yahoo"), 0);
    }

    #[tokio::test]
    async fn google_serp_url_redirectunwrap_and_internal_skip() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        let serp = "<div class=\"g\"><a href=\"/url?q=https%3A%2F%2Falpha-one.com%2Fpage\">Alpha</a><h3>Alpha T</h3><span class=\"st\">Alpha S</span></div><div class=\"g\"><a href=\"https://www.google.com/search?x=1\">glink</a></div><div class=\"g\"><a href=\"/url?url=https%3A%2F%2Fbeta-two.org%2Fy\">B</a><h3>Beta T</h3><p class=\"IsZvec\">Beta S</p></div>".to_string()
            + &"p".repeat(600);
        let url = "https://www.google.com/search?q=test&num=20&hl=en&gl=us";
        let net = ScriptedNet::default().with_page(url, page(&serp));
        let out = google_search(&net, "test").await;
        assert_eq!(out.len(), 2, "the google.com block is skipped internally");
        assert_eq!(out[0].url, "https://alpha-one.com/page");
        assert_eq!(out[0].title, "Alpha T");
        assert_eq!(out[0].snippet, "Alpha S");
        // /url with no q param ⇒ the [?&]url= regex fallback branch.
        assert_eq!(out[1].url, "https://beta-two.org/y");
        assert_eq!(out[1].snippet, "Beta S");
        assert_eq!(engine_cooldown_remaining_ms("google"), 0);
    }

    #[tokio::test]
    async fn google_200_wall_zeros_trip_breaker_and_skip_while_cooling() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        // Bench finding #1 regression pin: a 200 consent wall parses to ZERO
        // results and pre-fix recorded NEITHER trip nor success, so the
        // breaker never engaged (google burned 59/59 live SERP fetches).
        let url = "https://www.google.com/search?q=test&num=20&hl=en&gl=us";
        let wall = "p".repeat(600); // ≥500 chars, no div.g blocks, no block keywords
        let net = ScriptedNet::default().with_page(url, page(&wall));
        let a = google_search(&net, "test").await;
        assert!(a.is_empty());
        assert_eq!(
            engine_cooldown_remaining_ms("google"),
            0,
            "streak 1 stays an observation (a single zero may be query-specific)"
        );
        let b = google_search(&net, "test").await;
        assert!(b.is_empty());
        let remaining = engine_cooldown_remaining_ms("google");
        assert!(remaining > 0 && remaining <= ENGINE_COOLDOWN_MS);
        let calls_after_trip = calls_of(&net).len();
        let c = google_search(&net, "test").await;
        assert!(c.is_empty());
        assert_eq!(
            calls_of(&net).len(),
            calls_after_trip,
            "while cooling down google makes ZERO requests"
        );
    }

    #[tokio::test]
    async fn google_transport_none_trips_immediately() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        // Unscripted ⇒ fetch_page None ⇒ transport failure is NEVER
        // query-specific: the FIRST observation already trips the breaker.
        let net = ScriptedNet::default();
        let a = google_search(&net, "test").await;
        assert!(a.is_empty());
        let remaining = engine_cooldown_remaining_ms("google");
        assert!(
            remaining > 0 && remaining <= ENGINE_COOLDOWN_MS,
            "trip_immediate: call 1 already cools google down"
        );
        let calls_after_trip = calls_of(&net).len();
        let b = google_search(&net, "test").await;
        assert!(b.is_empty());
        assert_eq!(calls_of(&net).len(), calls_after_trip, "no retry while cooling down");
    }

    #[tokio::test]
    async fn breaker_cooldown_escalates_and_success_clears_history() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        // Pure health-core test (no net): streak-2 trip, exponential
        // escalation across REPEATED trips, and success clearing history.
        trip_circuit_breaker("esc-engine", "zero 1");
        assert_eq!(engine_cooldown_remaining_ms("esc-engine"), 0, "streak 1 only");
        trip_circuit_breaker("esc-engine", "zero 2"); // trip #1
        let c1 = engine_cooldown_remaining_ms("esc-engine");
        assert!(c1 > 0 && c1 <= ENGINE_COOLDOWN_MS, "first trip: base 60 s");
        trip_circuit_breaker("esc-engine", "zero 3");
        trip_circuit_breaker("esc-engine", "zero 4"); // trip #2 ⇒ escalated
        let c2 = engine_cooldown_remaining_ms("esc-engine");
        assert!(c2 > ENGINE_COOLDOWN_MS && c2 <= 2 * ENGINE_COOLDOWN_MS, "second trip doubles the cooldown");
        note_engine_success("esc-engine"); // healthy again ⇒ escalation history gone
        trip_circuit_breaker("esc-engine", "zero 5");
        trip_circuit_breaker("esc-engine", "zero 6"); // trip back at base
        let c3 = engine_cooldown_remaining_ms("esc-engine");
        assert!(c3 > 0 && c3 <= ENGINE_COOLDOWN_MS, "success resets escalation to base");
    }

    #[tokio::test]
    async fn brave_dom_miss_falls_back_to_initial_state_json() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        // DOM pass yields nothing parseable (relative href ⇒ is_safe_url
        // fails on the RAW href — TS parity: brave never rewrites the href);
        // the window.__INITIAL_STATE__ regex rescue must fire.
        let serp = "<div class=\"result\"><a href=\"/local\">x</a></div><script>window.__INITIAL_STATE__ = {\"searchResults\":{\"results\":[{\"title\":\"T1\",\"url\":\"https://alpha-one.com/a\",\"description\":\"D1\"},{\"title\":\"T2\",\"url\":\"https://beta-two.org/b\",\"snippet\":\"D2\"}]}};</script>".to_string()
            + &"p".repeat(600);
        let url = "https://search.brave.com/search?q=test&source=web";
        let net = ScriptedNet::default().with_page(url, page(&serp));
        let out = brave_search(&net, "test").await;
        assert_eq!(out.len(), 2, "__INITIAL_STATE__ rescue must find both");
        assert_eq!(out[0].url, "https://alpha-one.com/a");
        assert_eq!(out[0].title, "T1");
        assert_eq!(out[0].snippet, "D1");
        assert_eq!(out[1].snippet, "D2", "description/snippet key chain");
        assert_eq!(out[0].engine, "brave");
        assert_eq!(engine_cooldown_remaining_ms("brave"), 0);
    }

    #[tokio::test]
    async fn reddit_atom_stage_a_short_circuits_stages_b_c() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        let atom = "<feed><entry><title>Post One</title><link href=\"https://www.reddit.com/r/rust/comments/1a/one/\"/><content type=\"html\">&lt;p&gt;Body one&lt;/p&gt;</content><published>2023-11-14T22:13:20+00:00</published></entry><entry><title>Post Two</title><link href=\"https://www.reddit.com/r/rust/comments/1b/two/\"/><published>2023-11-15T00:00:00+00:00</published></entry></feed>";
        let rss_url = "https://www.reddit.com/search.rss?q=test&sort=relevance&limit=20";
        let net = ScriptedNet::default().with_url(rss_url, txt(atom));
        let out = reddit_search(&net, "test").await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].url, "https://www.reddit.com/r/rust/comments/1a/one/");
        // Atom content entities are NOT decoded (TS regex pipeline parity).
        assert_eq!(out[0].snippet, "&lt;p&gt;Body one&lt;/p&gt;");
        assert_eq!(out[0].published_date.as_deref(), Some("2023-11-14T22:13:20+00:00"));
        assert_eq!(out[1].snippet, "", "entry without <content> ⇒ empty snippet");
        assert_eq!(out[1].engine, "reddit");
        assert_eq!(
            calls_of(&net),
            vec![(rss_url.to_string(), "fetch_url")],
            "stage A non-empty ⇒ pullpush + search.json never called"
        );
    }

    #[tokio::test]
    async fn bing_rss_stage_a_parses_items() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        let xml = "<rss><channel><item><title><![CDATA[Title One]]></title><link>https://alpha-one.com/r1</link><description><![CDATA[<b>Desc</b> one]]></description></item><item><title>Title Two</title><link>https://beta-two.org/r2</link><description>plain desc</description></item></channel></rss>";
        let rss_url = "https://www.bing.com/search?q=test&format=rss&count=15";
        let net = ScriptedNet::default().with_url(rss_url, txt(xml));
        let out = bing_search(&net, "test").await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].url, "https://alpha-one.com/r1");
        assert_eq!(out[0].snippet, "Desc one", "tags stripped from CDATA desc");
        assert_eq!(out[1].snippet, "plain desc");
        assert_eq!(out[0].engine, "bing");
        assert_eq!(
            calls_of(&net),
            vec![(rss_url.to_string(), "fetch_url")],
            "stage A non-empty ⇒ HTML stage never runs"
        );
    }

    #[tokio::test]
    async fn bing_html_fallback_decodes_ck_links() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        // Stage A returns an itemless feed ⇒ fall through to stage B.
        let serp = "<li class=\"b_algo\"><h2><a href=\"/ck/a?u=a1aHR0cHM6Ly9jazEtcGFyaXR5LmNvbS9h\">CK One</a></h2><div class=\"b_caption\"><p>Cap1</p></div></li><li class=\"b_algo\"><h2><a href=\"/ck/a?u=a1aHR0cHM6Ly9jazItcGFyaXR5LmNvbS9i\">CK Two</a></h2><p class=\"b_lineclamp\">Cap2</p></li><li class=\"b_algo\"><h2><a href=\"https://www.bing.com/help/x\">internal</a></h2><p>x</p></li>";
        let net = ScriptedNet::default()
            .with_url(
                "https://www.bing.com/search?q=test&format=rss&count=15",
                txt("<rss><channel><description>no items here</description></channel></rss>"),
            )
            .with_page("https://www.bing.com/", page("hi"))
            .with_page("https://www.bing.com/search?q=test&setlang=en&cc=US", page(serp));
        let out = bing_search(&net, "test").await;
        assert_eq!(out.len(), 2, "bing.com internal link filtered");
        assert_eq!(out[0].url, "https://ck1-parity.com/a");
        assert_eq!(out[0].title, "CK One");
        assert_eq!(out[0].snippet, "Cap1");
        assert_eq!(out[1].url, "https://ck2-parity.com/b");
        assert_eq!(out[1].snippet, "Cap2");
        assert_eq!(calls_of(&net).len(), 3);
    }

    #[tokio::test]
    async fn bing_news_extracts_url_param_and_collapses_title_ws() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        let xml = "<rss><channel><item><title><![CDATA[Line one\nline two]]></title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3A%2F%2Falpha-one.com%2Fnews&amp;get=1</link><pubDate>Tue, 14 Nov 2023 22:13:20 GMT</pubDate><description>News body</description></item></channel></rss>";
        let news_url = "https://www.bing.com/news/search?q=test&format=rss&count=20";
        let net = ScriptedNet::default().with_url(news_url, txt(xml));
        let out = bing_news_rss_search(&net, "test").await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "Line one line two", "trim-then-collapse parity");
        assert_eq!(out[0].url, "https://alpha-one.com/news", "url= param extracted");
        assert_eq!(
            out[0].published_date.as_deref(),
            Some("Tue, 14 Nov 2023 22:13:20 GMT"),
            "pubDate passed through raw"
        );
        assert_eq!(out[0].engine, "bing-news");
        assert_eq!(
            calls_of(&net),
            vec![(news_url.to_string(), "fetch_url")],
            "stage A non-empty ⇒ Google News fallback never runs"
        );
    }

    #[tokio::test]
    async fn github_users_repos_issues_merge() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        let users_url = "https://api.github.com/search/users?q=test&per_page=5";
        let repos_url = "https://api.github.com/search/repositories?q=test&per_page=8";
        let issues_url = "https://api.github.com/search/issues?q=test&per_page=8";
        let net = ScriptedNet::default()
            .with_url(
                users_url,
                txt("{\"items\":[{\"login\":\"octo\",\"type\":\"User\"},{\"login\":\"duo\",\"html_url\":\"https://github.com/duo\"}]}"),
            )
            .with_url(
                repos_url,
                txt("{\"items\":[{\"name\":\"repoX\",\"full_name\":\"o/repoX\",\"html_url\":\"https://github.com/o/repoX\",\"description\":\"Repo desc\"}]}"),
            )
            .with_url(
                issues_url,
                txt("{\"items\":[{\"title\":\"Issue 1\",\"html_url\":\"https://github.com/o/repoX/issues/1\",\"body\":\"Body issue\",\"created_at\":\"2023-11-14T22:13:20Z\"}]}"),
            );
        let out = github_search(&net, "test").await;
        assert_eq!(out.len(), 4);
        assert_eq!(out[0].title, "GitHub: octo");
        // QUIRK: missing html_url ⇒ "https://github.com/" + login.
        assert_eq!(out[0].url, "https://github.com/octo");
        assert_eq!(
            out[0].snippet,
            "User \u{2014} GitHub profile for \"test\""
        );
        assert_eq!(out[1].url, "https://github.com/duo");
        assert_eq!(out[2].title, "repoX");
        assert_eq!(out[2].snippet, "Repo desc");
        assert_eq!(out[3].url, "https://github.com/o/repoX/issues/1");
        assert_eq!(
            out[3].published_date.as_deref(),
            Some("2023-11-14T22:13:20Z"),
            "created_at passthrough"
        );
        assert!(out.iter().all(|r| r.engine == "github"));
        // Non-empty results ⇒ github noted its own success (Step A), which
        // also clears any stale escalation — cooldown stays 0:
        assert_eq!(engine_cooldown_remaining_ms("github"), 0);
    }

    #[tokio::test]
    async fn devto_tag_feed_plus_freetext_fill() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        let tag_url = "https://dev.to/api/articles?per_page=15&top=365&tag=rust";
        let free_url =
            "https://dev.to/search/feed_content?per_page=15&page=0&class_name=Article&search_fields=rust%20async%20tricks";
        let net = ScriptedNet::default()
            .with_url(
                tag_url,
                txt("[{\"title\":\"Art1\",\"url\":\"https://dev.to/u1/art1\",\"description\":\"Desc1\",\"tag_list\":[\"rust\",\"async\"],\"published_at\":\"2023-11-14T00:00:00Z\"},{\"title\":\"Art2\",\"user\":{\"username\":\"u2\"},\"slug\":\"art2\",\"description\":\"Desc2\"}]"),
            )
            .with_url(
                free_url,
                txt("{\"results\":[{\"url\":\"https://dev.to/u3/art3\",\"title\":\"F1\",\"snippet\":\"S3\",\"created_at\":\"2023-11-15T00:00:00Z\"}]}"),
            );
        let out = dev_to_search(&net, "rust async tricks").await;
        assert_eq!(out.len(), 3, "tag feed (2) + free-text fill (out < 5)");
        assert_eq!(
            out[0].snippet,
            "rust, async \u{2014} Desc1",
            "tag_list join + em-dash + description"
        );
        // url ?? "https://dev.to/" + user?.username + "/" + slug:
        assert_eq!(out[1].url, "https://dev.to/u2/art2");
        assert_eq!(out[1].snippet, " \u{2014} Desc2", "no tag_list ⇒ empty prefix");
        assert_eq!(out[2].url, "https://dev.to/u3/art3");
        assert_eq!(out[2].snippet, "S3", "description ?? snippet chain");
        assert_eq!(
            out[2].published_date.as_deref(),
            Some("2023-11-15T00:00:00Z"),
            "published_at ?? created_at chain"
        );
        assert!(out.iter().all(|r| r.engine == "devto"));
        assert_eq!(out[0].rank, 1);
        assert_eq!(out[2].rank, 3);
        assert_eq!(engine_cooldown_remaining_ms("devto"), 0);
    }

    #[tokio::test]
    async fn run_general_web_search_merges_in_engine_array_order() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        // Only Bing (position 4) and Reddit (position 7) answer; join_all
        // keeps GENERAL_WEB_ENGINES order regardless of completion order.
        let bing_rss = "https://www.bing.com/search?q=test&format=rss&count=15";
        let reddit_rss = "https://www.reddit.com/search.rss?q=test&sort=relevance&limit=20";
        let net = ScriptedNet::default()
            .with_url(
                bing_rss,
                txt("<rss><channel><item><title>B1</title><link>https://alpha-one.com/b1</link></item><item><title>B2</title><link>https://beta-two.org/b2</link></item></channel></rss>"),
            )
            .with_url(
                reddit_rss,
                txt("<feed><entry><title>R1</title><link href=\"https://www.reddit.com/r/rust/comments/1c/one/\"/></entry><entry><title>R2</title><link href=\"https://www.reddit.com/r/rust/comments/1d/two/\"/></entry></feed>"),
            );
        let out = run_general_web_search(&net, "test").await;
        let engines: Vec<&str> = out.iter().map(|r| r.engine.as_str()).collect();
        assert_eq!(engines, vec!["bing", "bing", "reddit", "reddit"]);
        assert_eq!(out[0].url, "https://alpha-one.com/b1");
        assert_eq!(out[3].url, "https://www.reddit.com/r/rust/comments/1d/two/");
    }

    #[tokio::test]
    async fn sharded_runner_fans_out_per_query_tiers() {
        let _g = engine_test_lock().lock().await;
        reset_engine_state_for_tests();
        // Tier-1 lite endpoint answers for BOTH queries; tier-2 ddg stage B
        // answers for the primary (same scripted lite URL). Everything else
        // is unscripted ⇒ None ⇒ [] (TS try/catch).
        let lite_body = "<table><tr><td><a class=\"result-link\" href=\"/l/?uddg=https%253A%252f%252falpha-one.com%252f\">A</a><div class=\"result-snippet\">SnA</div></td></tr><tr><td><a class=\"result-link\" href=\"/l/?uddg=https%253A%252f%252fbeta-two.org%252fy\">B</a><div class=\"result-snippet\">SnB</div></td></tr></table>";
        let net = ScriptedNet::default()
            .with_page("https://lite.duckduckgo.com/lite/", page("<html>prime</html>"))
            .with_page("https://lite.duckduckgo.com/lite/?q=test", page("<html>prime</html>"))
            .with_url("https://lite.duckduckgo.com/lite/", txt(lite_body));
        let queries = vec!["rust".to_string(), "rust async".to_string()];
        let out = run_general_web_search_sharded(&net, "rust", &queries).await;
        let mut lite = 0usize;
        let mut ddg = 0usize;
        for r in &out {
            match r.engine.as_str() {
                "ddg-lite" => lite += 1,
                "duckduckgo" => ddg += 1,
                e => panic!("unexpected engine in sharded pool: {e}"),
            }
        }
        assert_eq!(lite, 4, "tier-1 ddg_lite_post runs once per query");
        assert_eq!(ddg, 2, "tier-2 ddg (primary only) via its lite stage");
        let lite_posts = calls_of(&net)
            .iter()
            .filter(|(u, k)| {
                u == "https://lite.duckduckgo.com/lite/" && *k == "fetch_url"
            })
            .count();
        assert_eq!(lite_posts, 3, "two tier-1 POSTs + one tier-2 stage-B POST");
        // Nobody tripped (every answered engine noted success):
        assert_eq!(engine_cooldown_remaining_ms("ddg-lite"), 0);
        assert_eq!(engine_cooldown_remaining_ms("duckduckgo"), 0);
    }
}
