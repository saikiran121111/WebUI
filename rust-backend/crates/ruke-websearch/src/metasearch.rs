//! OWNER: W2 — parity port of `lib/web-search/metasearch.ts` (1213 lines).
//!
//! Net seam: every I/O function takes `&dyn Net` as its first parameter
//! (TS closes over `net.ts` module state). Tests use [`net::ScriptedNet`];
//! production passes `RealNet`.
//!
//! Pub surface ⇔ TS exports (downstream contracts):
//! - `SearchPlan` ⇔ `SearchPlan` (query_planner), `strip_url_plans` ⇔ `stripUrlPlans`
//! - `normalize_url` ⇔ `normalizeUrl`, `query_core_tokens` ⇔ `queryCoreTokens`,
//!   `meets_lexical_threshold` ⇔ `meetsLexicalThreshold`,
//!   `count_lexically_relevant` ⇔ `countLexicallyRelevant`
//! - `reciprocal_rank_fuse` ⇔ `reciprocalRankFuse`, `metasearch` ⇔ `metasearch`,
//!   `metasearch_with_freshness_recovery` ⇔ `metasearchWithFreshnessRecovery`,
//!   `metasearch_with_budget` ⇔ `metasearchWithBudget`,
//!   `url_search_fallback` ⇔ `urlSearchFallback` (extractor),
//!   `slug_triangulation` ⇔ `slugTriangulation` (extractor).
//!
//! TypeScript quirks reproduced VERBATIM (do not "fix"):
//! - `const limit = pLimit(ENGINE_CONCURRENCY)` is created but NEVER used
//!   anywhere in metasearch.ts — dead code; mirrored below as a dead fn.
//! - `searchOne`'s comment claims verticals "run in parallel with the pool";
//!   the code awaits the pool race FIRST, then the verticals SEQUENTIALLY.
//! - IMDb is not lexically gated and gets 1.2× general-web weight (it is
//!   deliberately absent from `VERTICAL_ENGINES`).
//! - News results are double-capped: `slice(0, capForEngine("bing-news"))`
//!   then `applyEngineCap` again.
//! - `metasearchWithFreshnessRecovery`'s second pass calls a subset of the
//!   first pass's engines, so `secondPass.length > firstPass.length` is
//!   effectively unreachable in practice — kept as-is.
//! - `urlSearchFallback` rrf uses the FUSION index `i` (1/(60+i+1)), not the
//!   engine rank, and `engineRanks` stores the fusion index + 1.
//! - `slugTriangulation`'s `broadQuery` template always leaves a trailing
//!   space when there are no slug tokens; `siteQuery` falls back to `"*"`.
//! - Dev regex `c\+\+`/`c#` + `\b` quirk: `\b` after a non-word char (`+`/`#`)
//!   requires the NEXT char to be a word char, so "c++17" matches but
//!   "foo c++" / "c# " do not. Same pattern, same failure modes.
//! - SemanticScholar's `.filter(r => r.url)` runs AFTER the map, so ranks
//!   count url-less papers (kept: rank before url filter).
//! - Wikipedia/HN/StackExchange/Wikidata/SemanticScholar ranks are the
//!   POST-gate map index; arXiv/IMDb ranks are output-position counters.
//! - arXiv's invalid CSS selector `link[@rel='alternate']` (linkedom-specific
//!   XPath-ish syntax) is ported as `link[rel="alternate"]`.
//! - StackExchange: a non-numeric `creation_date` makes `new Date(...)`'s
//!   `toISOString()` throw in JS → the OUTER try/catch turns the WHOLE stage
//!   into `[]`. Reproduced (early return). Out-of-±8.64e15ms dates likewise.
//! - metasearch quorum: grace timer arms once when ≥15 raw results from
//!   ≥2 engines land; a 6s grace abandons pending plans; all-plans-settled
//!   resolves immediately; 15s hard cap is the deadlock net.
//!
//! Unavoidable Rust-vs-JS divergences (recorded, NOT fixed):
//! - Abandoned plan/pool futures are CANCELLED when the grace/hard-cap fires
//!   (Rust drops the future); JS leaves them firing in the background.
//! - `childLogger` telemetry lines are dropped (no logger crate here);
//!   `console.warn` in `metasearchWithBudget` becomes `eprintln!`.
//! - `p-limit`/`parseInt`: `Math.max(8, parseInt(garbage))` yields NaN in JS;
//!   the dead mirror falls back to 8 on unparsable env values.
//! - `countLexicallyRelevant`'s structural param `{title,snippet,url}[]`
//!   becomes `&[RankedResult]` (structural typing has no Rust analogue).
//! - JS default args (`maxResults = 20`) become explicit params;
//!   stringly-typed `Intent`/`freshness` use the ported `types::Intent` /
//!   `types::Freshness` enums; `Intent::Other(_)` falls back to the general
//!   vertical list exactly like TS's `VERTICAL_BY_INTENT[intent] ?? general`.
//! - JS `undefined` interpolated in string concat becomes `""` (or
//!   `"undefined"` in template-literal positions, ported via `tpl_str`);
//!   `JSON.parse` number→string conversions use serde's shortest formatting
//!   (JS exponent forms like `1e+21` differ). Missing JSON fields coerce to
//!   `""` where TS would carry `undefined` (type lied either way).
//! - `normalizeUrl`: `URLSearchParams` here splits on `&` only (WHATWG's
//!   `;`-as-separator rule for form data is not reproduced); `url`-crate
//!   setter failures on opaque/non-special URLs are ignored where WHATWG
//!   throws into the catch (raw passthrough). WHATWG `u.toString()` vs
//!   `Url::as_str()` agree for http(s) (default ports dropped both sides).
//! - JS `\s`/`\b` vs regex-crate classes: ASCII classes (`(?-u)`) used where
//!   JS semantics are ASCII (`\b` word chars, `[^\s]` replace collapses to the
//!   same token boundaries under `split_whitespace`); JS `\s` excludes
//!   U+0085, Rust `char::is_whitespace` includes it (same split outcome).
//! - linkedom vs scraper: `Html::parse_fragment` for the arXiv Atom feed
//!   (`text()` node runs joined with `""` mimic `textContent`); arXiv title
//!   JS `.trim().replace(/\s+/g," ")` ≈ `split_whitespace().join(" ")`.
//! - JS timers vs tokio timers: retry backoff (2s), searchOne pool cap (10s),
//!   grace (6s) and hard cap (15s) are `tokio::time`. The workspace does NOT
//!   enable tokio's `test-util` feature, so tests cannot pause-advance them:
//!   the 2s backoff is slept for real in tests, and the grace/hard-cap/pool
//!   timers never fire in scripted replays (all fetches resolve instantly).
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::future::{join_all, BoxFuture, OptionFuture};
use futures_util::stream::{FuturesUnordered, StreamExt};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use serde_json::{Map, Value};
use url::Url;

use crate::engines::{
    bing_news_rss_search, deduplicate_queries, dev_to_search, github_search, google_search,
    reddit_search, run_general_web_search, run_general_web_search_sharded, EngineFn,
};
use crate::net::{Net, UrlFetchOpts};
use crate::ssrf::is_safe_url;
use crate::types::{engine_rank_value, Freshness, Intent, RawSearchResult, RankedResult};

/// TS: `const ENGINE_TIMEOUT_MS = 40_000` — every metasearch fetcher.
const ENGINE_TIMEOUT_MS: u64 = 40_000;
/// TS: one automatic retry with 2s backoff on 429/503.
const RETRY_BACKOFF_MS: u64 = 2_000;
/// TS: `SEARCH_ONE_CAP_MS = 10_000` — general-pool wall-clock race cap.
const SEARCH_ONE_CAP_MS: u64 = 10_000;
const QUORUM_MIN_RESULTS: usize = 15;
const QUORUM_MIN_ENGINES: usize = 2;
const GRACE_TIMER_MS: u64 = 6_000;
const RRF_K: f64 = 60.0;
const PREFERRED_BOOST: f64 = 0.015;
const VERTICAL_PER_ENGINE_CAP: usize = 5;

/// TS quirk: `const limit = pLimit(ENGINE_CONCURRENCY)` — the limit is
/// NEVER used anywhere in metasearch.ts (dead code). `Math.max(8,
/// parseInt(process.env.WEB_SEARCH_ENGINE_CONCURRENCY ?? "8", 10))` yields
/// NaN for garbage values in JS; the mirror falls back to 8 instead.
#[allow(dead_code)]
fn engine_concurrency() -> i64 {
    let raw = std::env::var("WEB_SEARCH_ENGINE_CONCURRENCY").unwrap_or_else(|_| "8".into());
    let parsed: i64 = raw.trim().parse().unwrap_or(if raw.trim().is_empty() { 8 } else { i64::MIN });
    8.max(parsed)
}

/* ── SearchPlan (TS export; downstream: query_planner) ──────────────────── */

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPlan {
    pub query: String,
    pub intent: Intent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_domains: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freshness: Option<Freshness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relevance_anchor: Option<String>,
}

/// TS: `const METASEARCH_URL_PLANS = /^https?:\/\//i`.
pub fn strip_url_plans(plans: &[SearchPlan]) -> Vec<SearchPlan> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)^https?://").expect("static regex"));
    let kept: Vec<SearchPlan> = plans.iter().filter(|p| !re.is_match(&p.query)).cloned().collect();
    if !kept.is_empty() {
        kept // all-URL → keep raw plans (TS quirk)
    } else {
        plans.to_vec()
    }
}

/* ── URL normalization ──────────────────────────────────────────────────── */

const TRACKING_PARAMS: [&str; 7] = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "fbclid",
    "gclid",
    "ref",
];

/// JS `encodeURIComponent` (mirror of the private engines helper).
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

/// `URLSearchParams` percent-decode: `+` → space, then lossy percent-decode.
fn form_decode(s: &str) -> String {
    let plus = s.replace('+', " ");
    percent_encoding::percent_decode_str(&plus)
        .decode_utf8_lossy()
        .into_owned()
}

/// JS `URLSearchParams` serializer: alnum + `*-._` pass through, space →
/// `+`, everything else percent-encoded (uppercase hex).
const FORM_SET: &AsciiSet = &NON_ALPHANUMERIC.remove(b'*').remove(b'-').remove(b'.').remove(b'_');

fn form_encode(s: &str) -> String {
    utf8_percent_encode(s, FORM_SET).to_string().replace("%20", "+")
}

/// `new URLSearchParams(search)` entry list (order preserved; a chunk with
/// no `=` still yields a `(chunk, "")` entry; empty chunks skipped).
fn parse_form_pairs(search: &str) -> Vec<(String, String)> {
    let s = search.strip_prefix('?').unwrap_or(search);
    let mut out = Vec::new();
    for chunk in s.split('&') {
        if chunk.is_empty() {
            continue;
        }
        let (k, v) = match chunk.split_once('=') {
            Some((k, v)) => (k, v),
            None => (chunk, ""),
        };
        out.push((form_decode(k), form_decode(v)));
    }
    out
}

/// Parity port of `normalizeUrl`: hash clear → tracking-param delete via
/// URLSearchParams round-trip → lowercase host + `www.` strip → pathname
/// trailing-slash strip guarded by `length > 1` → `"" → "/"`. Invalid URLs
/// pass through verbatim (the TS catch).
pub fn normalize_url(raw: &str) -> String {
    let mut u = match Url::parse(raw) {
        Ok(u) => u,
        Err(_) => return raw.to_string(),
    };
    u.set_fragment(None);
    let search = u.query().unwrap_or("").to_string();
    let mut pairs = parse_form_pairs(&search);
    pairs.retain(|(k, _)| !TRACKING_PARAMS.contains(&k.as_str()));
    let q: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v)))
        .collect();
    let q = q.join("&");
    u.set_query(if q.is_empty() { None } else { Some(&q) });
    let host = u.host_str().unwrap_or("").to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let _ = u.set_host(Some(&host));
    static TRAIL: OnceLock<Regex> = OnceLock::new();
    let path = u.path().to_string();
    // TS: `path.length > 1` (UTF-16); pathnames are percent-encoded → ASCII.
    let path = if path.chars().count() > 1 {
        TRAIL.get_or_init(|| Regex::new(r"/+$").expect("static regex"))
            .replace_all(&path, "")
            .into_owned()
    } else {
        path
    };
    let path = if path.is_empty() { "/".to_string() } else { path };
    u.set_path(&path);
    u.as_str().to_string()
}

/* ── lexical gate helpers ───────────────────────────────────────────────── */

fn meta_stop_words() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            // generic modifiers
            "latest", "recent", "current", "new", "newest", "update", "updates", "release",
            "releases", "notes", "note", "changelog", "changes", "best", "top", "good", "great",
            "practices", "practice", "guide", "tutorial", "review", "reviews", "rating", "ratings",
            "rated", "place", "places", "spot", "spots", "option", "options", "pick", "tell",
            "want", "need", "find", "search", "looking", "look", "recommend", "recommendation",
            "recommendations", "suggestion", "vs", "versus", "compare", "comparison",
            "error", "errors", "handling", "how", "what", "where", "which", "when", "why", "issue",
            "issues", "problem", "problems", "bug", "bugs", "feature", "features", "list", "lists",
            "type", "types", "kind", "kinds", "way", "ways", "method", "methods", "style", "styles",
            "format", "formats", "version", "versions", "setup", "install", "installation",
            "config", "configuration", "configurating", "use", "using", "used", "usedto", "working",
            "work", "works", "workaround", "workarounds", "fix", "fixes", "fixed", "solution",
            "solutions", "help", "show", "please", "can", "could", "would", "should", "you",
            "your", "yours", "i", "me", "my", "is", "are", "was", "were", "be", "been", "being",
            "have", "has", "had", "in", "on", "at", "by", "for", "from", "to", "of", "with",
            "without", "about", "into", "onto", "over", "under", "near", "around", "between",
            "and", "or", "but", "if", "then", "else", "so", "yet", "also", "very", "really",
            "just", "quite", "rather", "too", "only", "the", "a", "an", "this", "that", "these",
            "those", "here", "there", "who", "whom", "whose", "shall", "may", "might", "must",
            "do", "does", "did", "im", "ill", "ive", "dont", "cant", "wont", "our", "them", "they",
            "he", "she", "its", "her", "him", "us",
            // standalone small numbers that are just version/quantity modifiers
            "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "30", "32", "50",
            "100",
        ]
        .into_iter()
        // TS keeps a duplicated "our" in the literal — a Set collapses it.
        .collect::<HashSet<&'static str>>()
    })
}

fn non_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^a-z0-9\s.]").expect("static regex"))
}

/// Core non-stopword tokens, first-occurrence order (JS `new Set`).
pub fn query_core_tokens(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let cleaned = non_token_re().replace_all(&lower, " ").into_owned();
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for t in cleaned.split_whitespace() {
        // TS `t.length > 2`: surviving token chars are ASCII after the
        // replace, so char-count == UTF-16 count.
        if t.chars().count() > 2 && !meta_stop_words().contains(t) && seen.insert(t) {
            out.push(t.to_string());
        }
    }
    out
}

fn dot_dash_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[.\-_]").expect("static regex"))
}

fn normalize_token(token: &str) -> String {
    dot_dash_re().replace_all(&token.to_lowercase(), "").into_owned()
}

/// Lower + `" "` + punctuation-stripped copy so "next.js" matches "nextjs".
fn normalize_text_for_match(text: &str) -> String {
    let lower = text.to_lowercase();
    let stripped = dot_dash_re().replace_all(&lower, "").into_owned();
    format!("{lower} {stripped}")
}

pub fn meets_lexical_threshold(text: &str, core_tokens: &[String]) -> bool {
    if core_tokens.is_empty() {
        return true;
    }
    let normalized = normalize_text_for_match(text);
    let hits = core_tokens
        .iter()
        .filter(|t| normalized.contains(&normalize_token(t)))
        .count();
    let n = core_tokens.len();
    let pct_floor = ((n as f64) * 0.4).ceil() as usize;
    let abs_floor = if n >= 3 { 2 } else { 1 };
    // TS: `hits >= Math.min(pctFloor, absFloor === 1 ? 1 : 2) || hits >= absFloor`
    hits >= pct_floor.min(if abs_floor == 1 { 1 } else { 2 }) || hits >= abs_floor
}

/// Same normalization as `meets_lexical_threshold` but with the pipeline's
/// fixed dynamic floor. TS structural param `{title,snippet,url}[]` →
/// `&[RankedResult]` (divergence: concrete type; fields identical).
pub fn count_lexically_relevant(results: &[RankedResult], anchor_text: &str) -> usize {
    let core = query_core_tokens(anchor_text);
    if core.is_empty() {
        return results.len();
    }
    let norm_tokens: Vec<String> = core.iter().map(|t| normalize_token(t)).collect();
    let pct_floor = ((core.len() as f64) * 0.4).ceil() as usize;
    let abs_floor = if core.len() >= 3 { 2 } else { 1 };
    // TS quirk: `Math.min(...) || absFloor` — note `||`, not `?:`. The
    // `min(...)` term can only be 0 when pct_floor == 0 (impossible for
    // core.length ≥ 1), so this is equal to the meetsLexicalThreshold form
    // for all reachable inputs — kept as `||` anyway.
    let min_hits = {
        let m = pct_floor.min(if abs_floor == 1 { 1 } else { 2 });
        if m == 0 {
            abs_floor
        } else {
            m
        }
    };
    results
        .iter()
        .filter(|r| {
            // TS: `${r.title} ${r.snippet ?? ""} ${r.url}` (snippet is
            // always a String on the Rust side).
            let raw = format!("{} {} {}", r.title, r.snippet, r.url).to_lowercase();
            let combined = format!(
                "{raw} {}",
                dot_dash_re().replace_all(&raw, "").into_owned()
            );
            norm_tokens.iter().filter(|t| combined.contains(t.as_str())).count() >= min_hits
        })
        .count()
}

/* ── JSON → JS value helpers ────────────────────────────────────────────── */

/// JS ToString for a present JSON scalar (objects/arrays fall back to a
/// coarse approximation; recorded in the header).
fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(_) | Value::Object(_) => "[object Object]".to_string(),
    }
}

/// TS `x?.f ?? fallback` access: Some(present non-null), None for missing
/// OR null (JS `??` treats both as missing).
fn opt_field<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|x| !x.is_null())
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    opt_field(v, key).map(value_to_string)
}

/// JS template-literal interpolation: missing/null → "undefined".
fn tpl_str(v: &Value, key: &str) -> String {
    match opt_field(v, key) {
        Some(x) => value_to_string(x),
        None => "undefined".to_string(),
    }
}

fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_array<'a>(v: Option<&'a Value>, key: &str) -> Vec<&'a Value> {
    match v.and_then(|v| v.get(key)).filter(|x| !x.is_null()) {
        Some(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    }
}

/* ── JS string semantics helpers (mirrors engines.rs private helpers) ──── */

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

/// JS `x * 1000`-style ToNumber for JSON scalars (hex literals like
/// `"0x10"` fall to None = NaN — divergence recorded in the header).
fn to_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok()
            }
        }
        _ => None,
    }
}

/* ── fetch-with-retry (429/503 → 2s → refetch once) ────────────────────── */

async fn fetch_url_with_retry(
    net: &dyn Net,
    url: &str,
    caller: UrlFetchOpts,
) -> Option<crate::net::UrlFetchResult> {
    // TS: `fetchUrl(url, { timeoutMs: ENGINE_TIMEOUT_MS, ...opts })` —
    // the caller's opts spread AFTER the base overrides timeoutMs.
    let mut opts = caller;
    if opts.timeout_ms.is_none() {
        opts.timeout_ms = Some(ENGINE_TIMEOUT_MS);
    }
    let res = net.fetch_url(url, &opts).await;
    if res.as_ref().is_some_and(|r| r.status == 429 || r.status == 503) {
        tokio::time::sleep(Duration::from_millis(RETRY_BACKOFF_MS)).await;
        return net.fetch_url(url, &opts).await;
    }
    res
}

fn json_headers(ct: &str) -> Vec<(String, String)> {
    vec![("accept".to_string(), ct.to_string())]
}

/* ── vertical source fetchers (gated by intent + lexical overlap) ──────── */

use chrono::{DateTime, SecondsFormat};
use scraper::{Html, Selector};
use crate::engines::{engine_pacer_with_breaker, note_engine_success, trip_circuit_breaker};

pub fn wikipedia_search<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        // Guarded (bench 2026-10-29: 429x90, zero pacing/health state). An
        // empty call is always a zero observation — inner early returns
        // (429/transport/unparseable JSON) all funnel through here.
        if !engine_pacer_with_breaker("wikipedia").await {
            return Vec::new();
        }
        let out = wikipedia_vertical(net, &q).await;
        if out.is_empty() {
            trip_circuit_breaker("wikipedia", "wikipedia vertical returned 0 results");
        } else {
            note_engine_success("wikipedia");
        }
        out
    })
}

fn wikipedia_vertical<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        let url = format!(
            "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json\
             &srprop=snippet&srlimit=5&srsearch={}",
            enc_component(&q)
        );
        let res = fetch_url_with_retry(net, &url, UrlFetchOpts {
            headers: json_headers("application/json"),
            ..Default::default()
        })
        .await;
        let res = match res {
            Some(r) if r.ok => r,
            _ => return Vec::new(),
        };
        // TS try/catch: JSON.parse or map-time throw → the whole stage [].
        let data: Value = match serde_json::from_str(&res.text) {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let core = query_core_tokens(&q);
        // snippet?.replace(/<[^>]+>/g, "") — regex hoisted out of the loop
        static TAGS: OnceLock<Regex> = OnceLock::new();
        let tags = TAGS.get_or_init(|| Regex::new(r"<[^>]+>").expect("static regex"));
        let mut out: Vec<RawSearchResult> = Vec::new();
        for s in js_array(data.get("query"), "search") {
            // TS gate: `s.title + " " + s.snippet` — JS String() of a
            // missing prop is "undefined", of null "null".
            let gate = format!(
                "{} {}",
                concat_field(s, "title"),
                concat_field(s, "snippet")
            );
            if !meets_lexical_threshold(&gate, &core) {
                continue;
            }
            // TS quirk: the map calls `s.title.replace(/ /g, "_")` — a
            // non-string/missing title throws TypeError → whole stage [].
            let title = match opt_field(s, "title") {
                Some(Value::String(t)) => t.clone(),
                _ => return Vec::new(),
            };
            let snippet = match opt_field(s, "snippet") {
                Some(v) => tags.replace_all(&value_to_string(v), "").into_owned(),
                None => String::new(),
            };
            out.push(RawSearchResult {
                url: format!(
                    "https://en.wikipedia.org/wiki/{}",
                    enc_component(&title.replace(' ', "_"))
                ),
                title,
                snippet,
                engine: "wikipedia".to_string(),
                published_date: None,
                rank: (out.len() + 1) as i64,
            });
        }
        out
    })
}

/// JS String()-with-undefined for `+`-concat: missing → "undefined",
/// null → "null" (JS `String(undefined)` is "undefined", `String(null)` "null").
fn concat_field(obj: &Value, key: &str) -> String {
    match obj.get(key) {
        None => "undefined".to_string(),
        Some(v) => value_to_string(v),
    }
}

pub fn hackernews_search<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        if !engine_pacer_with_breaker("hackernews").await {
            return Vec::new();
        }
        let out = hackernews_vertical(net, &q).await;
        if out.is_empty() {
            trip_circuit_breaker("hackernews", "hackernews vertical returned 0 results");
        } else {
            note_engine_success("hackernews");
        }
        out
    })
}

fn hackernews_vertical<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        let url = format!(
            "https://hn.algolia.com/api/v1/search?query={}&hitsPerPage=5",
            enc_component(&q)
        );
        let res = fetch_url_with_retry(net, &url, UrlFetchOpts {
            headers: json_headers("application/json"),
            ..Default::default()
        })
        .await;
        let res = match res {
            Some(r) if r.ok => r,
            _ => return Vec::new(),
        };
        let data: Value = match serde_json::from_str(&res.text) {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let core = query_core_tokens(&q);
        let mut out: Vec<RawSearchResult> = Vec::new();
        for h in js_array(Some(&data), "hits") {
            // TS gate: `(h.title ?? "") + " " + (h.story_text ?? "")`
            let title_v = opt_field(h, "title").map(value_to_string);
            let story_v = opt_field(h, "story_text").map(value_to_string);
            let gate = format!(
                "{} {}",
                title_v.clone().unwrap_or_default(),
                story_v.clone().unwrap_or_default()
            );
            if !meets_lexical_threshold(&gate, &core) {
                continue;
            }
            let title = title_v
                .or_else(|| story_v.as_deref().map(|s| js_slice_max(s, 100)))
                .unwrap_or_else(|| "HN discussion".to_string());
            // h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`
            let url_out = match opt_field(h, "url") {
                Some(v) => value_to_string(v),
                None => format!(
                    "https://news.ycombinator.com/item?id={}",
                    tpl_str(h, "objectID")
                ),
            };
            let snippet = opt_field(h, "comment_text")
                .or_else(|| opt_field(h, "story_text"))
                .map(|v| js_slice_max(&value_to_string(v), 300))
                .unwrap_or_default();
            out.push(RawSearchResult {
                title,
                url: url_out,
                snippet,
                engine: "hackernews".to_string(),
                published_date: opt_field(h, "created_at").map(value_to_string),
                rank: (out.len() + 1) as i64,
            });
        }
        out
    })
}

/// linkedom-style `textContent` (text-node runs joined with "").
fn node_text(el: Option<scraper::ElementRef>) -> Option<String> {
    let el = el?;
    Some(el.text().fold(String::new(), |mut acc, t| {
        acc.push_str(t);
        acc
    }))
}

pub fn arxiv_search<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        if !engine_pacer_with_breaker("arxiv").await {
            return Vec::new();
        }
        let out = arxiv_vertical(net, &q).await;
        if out.is_empty() {
            trip_circuit_breaker("arxiv", "arxiv vertical returned 0 results");
        } else {
            note_engine_success("arxiv");
        }
        out
    })
}

fn arxiv_vertical<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        let url = format!(
            "http://export.arxiv.org/api/query?search_query=all:{}&max_results=5",
            enc_component(&q)
        );
        let res = fetch_url_with_retry(net, &url, UrlFetchOpts {
            headers: json_headers("application/xml"),
            ..Default::default()
        })
        .await;
        let res = match res {
            Some(r) if r.ok => r,
            _ => return Vec::new(),
        };
        // Divergence: linkedom parses Atom as DOM; here scraper's
        // Html::parse_fragment. The TS selector `link[@rel='alternate']` is
        // not valid CSS for the scraper crate → ported as link[rel="alternate"].
        let doc = Html::parse_fragment(&res.text);
        let entry_sel = Selector::parse("entry").expect("static selector");
        let title_sel = Selector::parse("title").expect("static selector");
        let link_sel = Selector::parse("link[rel=\"alternate\"]").expect("static selector");
        let summary_sel = Selector::parse("summary").expect("static selector");
        let published_sel = Selector::parse("published").expect("static selector");
        let core = query_core_tokens(&q);
        let mut out: Vec<RawSearchResult> = Vec::new();
        for entry in doc.select(&entry_sel) {
            // title?.textContent?.trim().replace(/\s+/g, " ") ?? ""
            let title = node_text(entry.select(&title_sel).next())
                .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let link = entry
                .select(&link_sel)
                .next()
                .and_then(|e| e.value().attr("href"))
                .unwrap_or("")
                .to_string();
            // summary?.textContent?.trim() ?? ""
            let summary = node_text(entry.select(&summary_sel).next())
                .map(|t| t.trim().to_string())
                .unwrap_or_default();
            if !meets_lexical_threshold(&format!("{title} {summary}"), &core) {
                continue;
            }
            // published?.textContent?.trim() || undefined
            let published = node_text(entry.select(&published_sel).next())
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty());
            out.push(RawSearchResult {
                title,
                url: link,
                snippet: js_slice_max(&summary, 400),
                engine: "arxiv".to_string(),
                published_date: published,
                rank: (out.len() + 1) as i64,
            });
        }
        out
    })
}

pub fn stack_exchange_search<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        if !engine_pacer_with_breaker("stackexchange").await {
            return Vec::new();
        }
        let out = stack_exchange_vertical(net, &q).await;
        if out.is_empty() {
            trip_circuit_breaker("stackexchange", "stackexchange vertical returned 0 results");
        } else {
            note_engine_success("stackexchange");
        }
        out
    })
}

fn stack_exchange_vertical<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        let url = format!(
            "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance\
             &q={}&site=stackoverflow&pagesize=15",
            enc_component(&q)
        );
        // TS quirk: this fetcher does NOT go through fetchUrlWithRetry.
        let res = net
            .fetch_url(
                &url,
                &UrlFetchOpts {
                    timeout_ms: Some(ENGINE_TIMEOUT_MS),
                    headers: vec![
                        ("accept".to_string(), "application/json".to_string()),
                        ("user-agent".to_string(), "webui-search/1.0".to_string()),
                    ],
                    ..Default::default()
                },
            )
            .await;
        let res = match res {
            Some(r) if r.ok => r,
            _ => return Vec::new(),
        };
        let data: Value = match serde_json::from_str(&res.text) {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let core = query_core_tokens(&q);
        let mut out: Vec<RawSearchResult> = Vec::new();
        for item in js_array(Some(&data), "items") {
            // TS: meetsLexicalThreshold(item.title, core) — with core empty
            // the gate returns before touching the text; otherwise a
            // missing/non-string title throws (toLowerCase of undefined)
            // → the outer catch turns the WHOLE stage into [].
            if !core.is_empty() {
                match item.get("title") {
                    Some(Value::String(t)) => {
                        if !meets_lexical_threshold(t, &core) {
                            continue;
                        }
                    }
                    _ => return Vec::new(),
                }
            }
            let title = opt_str(item, "title").unwrap_or_default();
            // item.creation_date ? new Date(item.creation_date * 1000).toISOString() : undefined
            // A NaN/out-of-range Date throws on toISOString() → whole stage [].
            let published = match opt_field(item, "creation_date") {
                Some(v) if js_truthy(v) => match to_number(v) {
                    Some(secs) => {
                        let ms = secs * 1000.0;
                        if !ms.is_finite() || ms.abs() > 8.64e15 {
                            return Vec::new();
                        }
                        match DateTime::from_timestamp_millis(ms.trunc() as i64) {
                            Some(dt) => Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true)),
                            None => return Vec::new(),
                        }
                    }
                    None => return Vec::new(),
                },
                _ => None,
            };
            out.push(RawSearchResult {
                url: opt_str(item, "link").unwrap_or_default(),
                title: title.clone(),
                snippet: title,
                engine: "stackexchange".to_string(),
                published_date: published,
                rank: (out.len() + 1) as i64,
            });
        }
        out
    })
}

pub fn wikidata_search<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        if !engine_pacer_with_breaker("wikidata").await {
            return Vec::new();
        }
        let out = wikidata_vertical(net, &q).await;
        if out.is_empty() {
            trip_circuit_breaker("wikidata", "wikidata vertical returned 0 results");
        } else {
            note_engine_success("wikidata");
        }
        out
    })
}

fn wikidata_vertical<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        let url = format!(
            "https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json\
             &language=en&uselang=en&limit=5&search={}",
            enc_component(&q)
        );
        let res = fetch_url_with_retry(net, &url, UrlFetchOpts {
            headers: json_headers("application/json"),
            ..Default::default()
        })
        .await;
        let res = match res {
            Some(r) if r.ok => r,
            _ => return Vec::new(),
        };
        let data: Value = match serde_json::from_str(&res.text) {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let core = query_core_tokens(&q);
        let mut out: Vec<RawSearchResult> = Vec::new();
        for s in js_array(Some(&data), "entities") {
            // TS gate: `${s.label ?? ""} ${s.description ?? ""}`
            let label = opt_field(s, "label").map(value_to_string);
            let desc = opt_field(s, "description").map(value_to_string);
            let gate = format!(
                "{} {}",
                label.clone().unwrap_or_default(),
                desc.clone().unwrap_or_default()
            );
            if !meets_lexical_threshold(&gate, &core) {
                continue;
            }
            let id = opt_field(s, "id").map(value_to_string).unwrap_or_default();
            // [s.label, s.description].filter(Boolean).join(" — ") || id
            let title = {
                let parts: Vec<String> = [opt_field(s, "label"), opt_field(s, "description")]
                    .into_iter()
                    .flatten()
                    .filter(|v| js_truthy(v))
                    .map(value_to_string)
                    .collect();
                if parts.is_empty() {
                    id.clone()
                } else {
                    parts.join(" — ")
                }
            };
            let url_out = match opt_field(s, "concepturi") {
                Some(v) => value_to_string(v),
                None => format!("https://www.wikidata.org/wiki/{id}"),
            };
            out.push(RawSearchResult {
                title,
                url: url_out,
                snippet: desc.unwrap_or_default(),
                engine: "wikidata".to_string(),
                published_date: None,
                rank: (out.len() + 1) as i64,
            });
        }
        out
    })
}

pub fn semantic_scholar_search<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        if !engine_pacer_with_breaker("semantic-scholar").await {
            return Vec::new();
        }
        let out = semantic_scholar_vertical(net, &q).await;
        if out.is_empty() {
            trip_circuit_breaker("semantic-scholar", "semantic-scholar vertical returned 0 results");
        } else {
            note_engine_success("semantic-scholar");
        }
        out
    })
}

fn semantic_scholar_vertical<'a>(
    net: &'a dyn Net,
    query: &str,
) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        let url = format!(
            "https://api.semanticscholar.org/graph/v1/paper/search?limit=5\
             &fields=title,abstract,url,year,externalIds&query={}",
            enc_component(&q)
        );
        let res = fetch_url_with_retry(net, &url, UrlFetchOpts {
            headers: json_headers("application/json"),
            ..Default::default()
        })
        .await;
        let res = match res {
            Some(r) if r.ok => r,
            _ => return Vec::new(),
        };
        let data: Value = match serde_json::from_str(&res.text) {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let core = query_core_tokens(&q);
        let mut out: Vec<RawSearchResult> = Vec::new();
        for (i, p) in js_array(Some(&data), "data").into_iter().enumerate() {
            let title_v = opt_field(p, "title").map(value_to_string);
            let abstract_v = opt_field(p, "abstract").map(value_to_string);
            let gate = format!(
                "{} {}",
                title_v.clone().unwrap_or_default(),
                abstract_v.clone().unwrap_or_default()
            );
            if !meets_lexical_threshold(&gate, &core) {
                continue;
            }
            // p.url ?? (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : "")
            let doi = opt_field(p, "externalIds").and_then(|e| opt_field(e, "DOI"));
            let url_out = match opt_field(p, "url") {
                Some(v) => value_to_string(v),
                None => match doi {
                    Some(v) if js_truthy(v) => {
                        format!("https://doi.org/{}", value_to_string(v))
                    }
                    _ => String::new(),
                },
            };
            // p.year ? `${p.year}-01-01` : undefined
            let published = match opt_field(p, "year") {
                Some(v) if js_truthy(v) => Some(format!("{}-01-01", value_to_string(v))),
                _ => None,
            };
            out.push(RawSearchResult {
                title: title_v.unwrap_or_default(),
                url: url_out,
                snippet: abstract_v
                    .as_deref()
                    .map(|a| js_slice_max(a, 400))
                    .unwrap_or_default(),
                engine: "semantic-scholar".to_string(),
                published_date: published,
                // TS quirk: rank is the pre-filter map index (i + 1), NOT
                // renumbered by the trailing `.filter(r => r.url)`.
                rank: (i + 1) as i64,
            });
        }
        out.retain(|r| !r.url.is_empty());
        out
    })
}

pub fn imdb_suggestion_search<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        if !engine_pacer_with_breaker("imdb").await {
            return Vec::new();
        }
        let out = imdb_vertical(net, &q).await;
        if out.is_empty() {
            trip_circuit_breaker("imdb", "imdb vertical returned 0 results");
        } else {
            note_engine_success("imdb");
        }
        out
    })
}

fn imdb_vertical<'a>(net: &'a dyn Net, query: &str) -> BoxFuture<'a, Vec<RawSearchResult>> {
    let q = query.to_string();
    Box::pin(async move {
        let url = format!(
            "https://v3.sg.media-imdb.com/suggestion/x/{}.json?include_WARNINGS=false",
            enc_component(&q)
        );
        let res = fetch_url_with_retry(net, &url, UrlFetchOpts {
            headers: json_headers("application/json"),
            ..Default::default()
        })
        .await;
        let res = match res {
            Some(r) if r.ok => r,
            _ => return Vec::new(),
        };
        let data: Value = match serde_json::from_str(&res.text) {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        static TT_ID: OnceLock<Regex> = OnceLock::new();
        static KIND: OnceLock<Regex> = OnceLock::new();
        let tt = TT_ID.get_or_init(|| Regex::new(r"^tt(?-u:\d){7,10}$").expect("static regex"));
        let kind_re = KIND
            .get_or_init(|| Regex::new(r"movie|series|film").expect("static regex"));
        let mut out: Vec<RawSearchResult> = Vec::new();
        for d in js_array(Some(&data), "d") {
            let id = opt_field(d, "id").map(value_to_string).unwrap_or_default();
            if !tt.is_match(&id) {
                continue;
            }
            let kind = opt_field(d, "q")
                .or_else(|| opt_field(d, "description"))
                .map(value_to_string)
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            if !kind_re.is_match(&kind) {
                continue;
            }
            let title = opt_field(d, "display")
                .or_else(|| opt_field(d, "name"))
                .map(value_to_string)
                .unwrap_or_default();
            // [d?.q, d?.y ? `(${d.y})` : ""].filter(Boolean).join(" ")
            let mut parts: Vec<String> = Vec::new();
            if let Some(v) = opt_field(d, "q") {
                if js_truthy(v) {
                    parts.push(value_to_string(v));
                }
            }
            if let Some(v) = opt_field(d, "y") {
                if js_truthy(v) {
                    parts.push(format!("({})", value_to_string(v)));
                }
            }
            out.push(RawSearchResult {
                title,
                url: format!("https://www.imdb.com/title/{id}/"),
                snippet: parts.join(" "),
                engine: "imdb".to_string(),
                published_date: None,
                rank: (out.len() + 1) as i64,
            });
            if out.len() >= 5 {
                break;
            }
        }
        out
    })
}

/* ── engine policy tables (weights, caps, intent → verticals) ──────────── */

/// Mirrors the `VERTICAL_ENGINES` Set (imdb is NOT a member — TS quirk:
/// imdb results always fuse at the 1.2 general-web weight).
pub fn is_vertical_engine(engine: &str) -> bool {
    matches!(
        engine,
        "wikipedia"
            | "hackernews"
            | "arxiv"
            | "stackexchange"
            | "github"
            | "devto"
            | "bing-news"
            | "wikidata"
            | "semantic-scholar"
    )
}

pub fn engine_weight(engine: &str, intent: &Intent) -> f64 {
    if engine == "reddit" {
        return 1.0;
    }
    if is_vertical_engine(engine) {
        return match intent {
            Intent::Academic | Intent::Docs => 1.0,
            _ => 0.65,
        };
    }
    1.2
}

/// Mirrors `ENGINE_CAPS` with the 5 default (`capForEngine ?? 5`).
pub fn cap_for_engine(engine: &str) -> i64 {
    match engine {
        "github" | "bing-news" | "google-news" | "hackernews" | "wikidata" | "imdb" => 3,
        "wikipedia" | "arxiv" | "stackexchange" | "devto" | "semantic-scholar" => 5,
        // TS: `ENGINE_CAPS[engine] ?? VERTICAL_PER_ENGINE_CAP`.
        _ => VERTICAL_PER_ENGINE_CAP as i64,
    }
}

/// Per-engine keep-first cap. The TS original implements this as a
/// side-effecting `Array.filter` over a `Map` counter — same keep-order
/// semantics here.
fn apply_engine_cap(results: Vec<RawSearchResult>) -> Vec<RawSearchResult> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    results
        .into_iter()
        .filter(|r| {
            let c = counts.entry(r.engine.clone()).or_insert(0);
            *c += 1;
            *c <= cap_for_engine(&r.engine)
        })
        .collect()
}

/// TS `queryLooksLikeDev`. `(?-u)` restores JS's ASCII `\b`/`\s` semantics;
/// the `\b` AFTER `c++` / `c#` is a TS quirk (the class chars are non-word,
/// so "c++" alone never matches while "c++17" does — preserved).
fn query_looks_like_dev(q: &str) -> bool {
    static DEV: OnceLock<Regex> = OnceLock::new();
    let re = DEV
        .get_or_init(|| {
            // NOTE: must stay on one raw string — a `\`-continuation inside a
            // raw literal emits a LITERAL backslash+newline to the regex
            // parser (crash on first call, not compile-time).
            Regex::new(
                r"(?i-u)\b(python|javascript|typescript|node|nodejs|java|kotlin|swift|rust|go|golang|ruby|php|c\+\+|c#|react|angular|vue|svelte|next\.?js|express|nestjs|django|flask|fastapi|sql|graphql|http|api|cli|docker|kubernetes|terraform|aws|azure|github|git|stack\s*overflow|error|exception|bug|tutorial|best\s*practice|refactor)\b",
            )
            .expect("static regex")
        });
    re.is_match(q)
}

/// Mirrors `VERTICAL_BY_INTENT`; unknown/`Other(_)` intents fall to general
/// (the TS lookup miss + `?? GENERAL` arm — Rust's `Intent::Other(s)` maps
/// onto the same general fallback because the TS table is keyed by string).
///
/// Value-first routing (bench 2026-10-29): semantic-scholar (429×113,
/// self-throttled), wikidata (0 results/59) and imdb (2/59, rel 0) left
/// the default intents — still implemented, reachable via explicit intent
/// only. Reddit is a forum specialist (p50 3.6 s, 429×54), so it rides
/// the forum intent instead of the general pool. Docs drops wikidata to
/// match the Rust arm (the TS table had a pre-existing extra wikidata
/// entry; aligned here, wikidata is DISABLED_BY_DEFAULT).
fn vertical_by_intent(intent: &Intent) -> Vec<EngineFn> {
    match intent {
        Intent::Code => vec![stack_exchange_search, dev_to_search],
        Intent::Academic => vec![arxiv_search, wikipedia_search],
        Intent::Forum => vec![hackernews_search, reddit_search],
        Intent::News => vec![hackernews_search],
        Intent::Docs => vec![stack_exchange_search, wikipedia_search, dev_to_search],
        // general + unknown:
        _ => vec![wikipedia_search],
    }
}

/// Mirrors `DEV_VERTICAL_ENGINES`.
fn dev_vertical() -> Vec<EngineFn> {
    vec![github_search, stack_exchange_search, dev_to_search]
}

/* ── searchOne: general pool race + intent verticals (sequential) ──────── */

/// TS `searchOne(query, intent, allQueries?, freshness?)`.
///
/// TS comment claims the verticals "run in parallel with the pool"; the
/// code awaits the pool race FIRST, then runs the verticals SEQUENTIALLY
/// (`await Promise.allSettled(...)` per block). Reproduced as-is.
async fn search_one(
    net: &dyn Net,
    query: &str,
    intent: &Intent,
    all_queries: Option<&[String]>,
    freshness: Option<&Freshness>,
) -> Vec<RawSearchResult> {
    // TS: `allQueries && allQueries.length > 1` → sharded over the deduped
    // sub-queries; `deduplicateQueries(allQueries)[0]` is the primary
    // (JS undefined for an empty dedup list — unreachable when length>1;
    // Rust falls back to "" — divergence recorded in the header).
    let use_sharded = all_queries.is_some_and(|a| a.len() > 1);
    let deduped: Vec<String> = if use_sharded {
        deduplicate_queries(all_queries.unwrap())
    } else {
        Vec::new()
    };
    let primary: String = deduped.first().cloned().unwrap_or_default();
    let pool_task: BoxFuture<'_, Vec<RawSearchResult>> = if use_sharded {
        Box::pin(run_general_web_search_sharded(net, &primary, &deduped))
    } else {
        Box::pin(run_general_web_search(net, query))
    };
    // Promise.race([poolPromise.catch(()=>[]), sleep(CAP) → []]).
    // Divergence: the losing pool future is CANCELLED here (JS keeps it
    // running in the background).
    let t_pool = std::time::Instant::now();
    let pool: Vec<RawSearchResult> = match tokio::time::timeout(
        Duration::from_millis(SEARCH_ONE_CAP_MS),
        pool_task,
    )
    .await
    {
        Ok(v) => {
            tracing::info!(
                pool_ms = t_pool.elapsed().as_millis() as u64,
                pool_results = v.len(),
                pool_timed_out = false,
                sharded = use_sharded,
                "search_one: general pool settled"
            );
            v
        }
        Err(_) => {
            tracing::warn!(
                pool_ms = t_pool.elapsed().as_millis() as u64,
                pool_timed_out = true,
                sharded = use_sharded,
                "search_one: general pool hit SEARCH_ONE_CAP"
            );
            Vec::new()
        }
    };
    let mut results: Vec<RawSearchResult> = pool;

    // Intent verticals (allSettled — ported engine fns cannot reject).
    let verticals = vertical_by_intent(intent);
    if !verticals.is_empty() {
        let t_v = std::time::Instant::now();
        let settled = join_all(verticals.iter().map(|f| f(net, query))).await;
        let v_total: usize = settled.iter().map(|v| v.len()).sum();
        tracing::info!(
            verticals_ms = t_v.elapsed().as_millis() as u64,
            vertical_engines = verticals.len(),
            vertical_results = v_total,
            "search_one: intent verticals settled"
        );
        for v in settled {
            results.extend(apply_engine_cap(v));
        }
    }

    // News-sensitive: explicit "news" intent OR any freshness that is not
    // "any" (TS quirk: freshness "none" is truthy and ≠ "any" → the bing
    // news vertical fires for freshness=none plans).
    let is_news_sensitive = matches!(intent, Intent::News)
        || freshness.is_some_and(|f| f.as_str() != "any");
    if is_news_sensitive {
        let t_news = std::time::Instant::now();
        let news = bing_news_rss_search(net, query).await;
        tracing::info!(
            news_ms = t_news.elapsed().as_millis() as u64,
            news_results = news.len(),
            "search_one: bing-news vertical settled"
        );
        // TS double-cap quirk: slice(0, capForEngine("bing-news")) THEN
        // applyEngineCap again.
        let capped: Vec<RawSearchResult> =
            news.into_iter().take(cap_for_engine("bing-news") as usize).collect();
        results.extend(apply_engine_cap(capped));
    }

    let is_dev_query =
        query_looks_like_dev(query) || matches!(intent, Intent::Code | Intent::Docs);
    if is_dev_query {
        let t_dev = std::time::Instant::now();
        let devs = dev_vertical();
        let settled = join_all(devs.iter().map(|f| f(net, query))).await;
        let d_total: usize = settled.iter().map(|v| v.len()).sum();
        tracing::info!(
            dev_ms = t_dev.elapsed().as_millis() as u64,
            dev_engines = devs.len(),
            dev_results = d_total,
            "search_one: dev verticals settled"
        );
        for v in settled {
            results.extend(apply_engine_cap(v));
        }
    }
    results
}

/* ── reciprocalRankFuse ─────────────────────────────────────────────────── */

/// Mirrors the TS `byUrl` aggregate (Map insertion order ⇔ Vec + index map;
/// `Map` engine-ranks insertion order ⇔ Vec with first-wins semantics).
struct FuseAggregate {
    url: String,
    title: String,
    snippet: String,
    engine: String,
    published_date: Option<String>,
    ranks: Vec<(String, i64)>,
}

/// TS `reciprocalRankFuse(raw, preferredDomains?, intent = "general")`.
///
/// Insertion order of `byUrl` (⇔ first-seen normalized URL) and of the
/// per-URL engine `ranks` Map are load-bearing for `engines` / `engineRanks`
/// ordering; a `Vec` + index `HashMap` reproduces both. `sort_by` is stable,
/// matching V8's stable `Array.prototype.sort` on equal rrf.
pub fn reciprocal_rank_fuse(
    raw: &[RawSearchResult],
    preferred_domains: Option<&[String]>,
    intent: &Intent,
) -> Vec<RankedResult> {
    let mut aggs: Vec<FuseAggregate> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for r in raw {
        // TS: try { norm = normalizeUrl(r.url) } catch { continue } —
        // normalize_url already swallows parse failures (raw passthrough),
        // matching the TS internal catch.
        let norm = normalize_url(&r.url);
        if norm.is_empty() || !is_safe_url(&norm) {
            continue;
        }
        if let Some(&i) = index.get(&norm) {
            let a = &mut aggs[i];
            // ranks.set(engine, ranks.get(engine) ?? rank) — FIRST WINS.
            if !a.ranks.iter().any(|(e, _)| *e == r.engine) {
                a.ranks.push((r.engine.clone(), r.rank));
            }
            if a.snippet.is_empty() && !r.snippet.is_empty() {
                a.snippet = r.snippet.clone();
            }
            if a.title.is_empty() && !r.title.is_empty() {
                a.title = r.title.clone();
            }
        } else {
            index.insert(norm.clone(), aggs.len());
            aggs.push(FuseAggregate {
                // TS `{ ...r, url: norm }` — canonical = the normalized URL.
                url: norm.clone(),
                title: r.title.clone(),
                snippet: r.snippet.clone(),
                engine: r.engine.clone(),
                published_date: r.published_date.clone(),
                ranks: vec![(r.engine.clone(), r.rank)],
            });
        }
    }

    // preferred domains: lower, strip www., cut at first "/".
    let preferred: HashSet<String> = match preferred_domains {
        Some(ds) => ds
            .iter()
            .map(|d| {
                let lower = d.to_lowercase();
                let no_www = lower.strip_prefix("www.").unwrap_or(&lower);
                no_www.split('/').next().unwrap_or("").to_string()
            })
            .collect(),
        None => HashSet::new(),
    };

    let mut out: Vec<RankedResult> = Vec::new();
    for a in aggs {
        let mut score = 0.0f64;
        for (engine, rank) in &a.ranks {
            score += engine_weight(engine, intent) / (RRF_K + *rank as f64);
        }
        // domain = new URL(canonical).hostname.lower.replace(/^www\./,"")
        // (JS catch → ""; unreachable here since is_safe_url already
        // required a parseable http(s) URL).
        let domain = match Url::parse(&a.url) {
            Ok(u) => {
                let h = u.host_str().unwrap_or("").to_lowercase();
                match h.strip_prefix("www.") {
                    Some(s) => s.to_string(),
                    None => h,
                }
            }
            Err(_) => String::new(),
        };
        // [domain, ...domain.split(".").slice(1)].some(d => preferred.has(d))
        if !preferred.is_empty()
            && std::iter::once(domain.as_str())
                .chain(domain.split('.').skip(1))
                .any(|d| preferred.contains(d))
        {
            score += PREFERRED_BOOST;
        }
        let engines: Vec<String> = a.ranks.iter().map(|(e, _)| e.clone()).collect();
        let mut engine_ranks: Map<String, Value> = Map::new();
        for (engine, rank) in &a.ranks {
            engine_ranks.insert(engine.clone(), engine_rank_value(*rank));
        }
        out.push(RankedResult {
            url: a.url.clone(),
            canonical: a.url,
            title: a.title,
            snippet: a.snippet,
            engine: a.engine,
            published_date: a.published_date,
            domain,
            rrf: score,
            engines,
            engine_ranks,
        });
    }
    // TS: `.sort((a, b) => b.rrf - a.rrf)` — stable, higher rrf first.
    out.sort_by(|a, b| {
        b.rrf.partial_cmp(&a.rrf).unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/* ── metasearch (quorum early-exit) ─────────────────────────────────────── */

/// TS `metasearch(plans, maxResults = 20)`.
///
/// Quorum model ⇔ JS translation:
/// - per-plan promises ⇔ one [`FuturesUnordered`] task per plan writing
///   into `settled[i]` (plan-index order preserved on flatten);
/// - `armGraceTimer` (once) ⇔ `grace_deadline = Some(now + 6s)` guarded by
///   the `grace_armed` flag;
/// - `allPlansSettled.then` immediate resolve ⇔ the loop exits when the
///   task set empties;
/// - the 15s hard cap ⇔ a pinned `sleep_until` select arm.
///
/// Divergences (recorded in the header): abandoned plan futures are
/// CANCELLED on grace/hard-cap (JS keeps them in the background); the
/// `log.info` telemetry lines are dropped; an EMPTY plan list resolves
/// immediately (⇔ `Promise.allSettled([])` wins the race before the 6s
/// grace / 15s hard cap can fire).
pub async fn metasearch(net: &dyn Net, plans: &[SearchPlan], max_results: usize) -> Vec<RankedResult> {
    let effective = strip_url_plans(plans);
    let all_queries: Vec<String> = effective.iter().map(|p| p.query.clone()).collect();
    // TS: `effectivePlans[0]?.freshness ?? "any"` — the FIRST plan's
    // freshness is used for EVERY plan's searchOne call (per-plan
    // freshness is never read here — TS quirk kept).
    let freshness: Freshness = effective
        .first()
        .and_then(|p| p.freshness.clone())
        .unwrap_or(Freshness::Any);

    let mut futs: FuturesUnordered<BoxFuture<'_, (usize, Vec<RawSearchResult>)>> =
        FuturesUnordered::new();
    for (i, p) in effective.iter().enumerate() {
        // freshness/all_queries are cloned per plan (JS closes over the same
        // values; Rust futures need owned captures to keep the borrow
        // checker happy — same observable values).
        let aq = all_queries.clone();
        let fresh = freshness.clone();
        futs.push(Box::pin(async move {
            (i, search_one(net, &p.query, &p.intent, Some(&aq), Some(&fresh)).await)
        }));
    }

    let t_meta_cycle = std::time::Instant::now();
    let mut settled: Vec<Option<Vec<RawSearchResult>>> = vec![None; effective.len()];
    let mut landed_results: usize = 0;
    let mut landed_engines: HashSet<String> = HashSet::new();
    // `graceFired` (JS) is subsumed here: arming only happens from an
    // arm-check that runs before any break, and grace/hard-cap expiry exits
    // the loop immediately — so no re-arm window exists after expiry.
    let mut grace_armed = false;
    let mut grace_deadline: Option<tokio::time::Instant> = None;

    let hard_deadline = tokio::time::Instant::now() + Duration::from_millis(15_000);
    let mut hard_cap = std::pin::pin!(tokio::time::sleep_until(hard_deadline));
    let mut loop_exit = "all-settled";

    loop {
        if futs.is_empty() {
            // ⇔ allPlansSettled.then → immediate resolve.
            break;
        }
        tokio::select! {
            biased;
            _ = OptionFuture::from(grace_deadline.map(tokio::time::sleep_until)),
                if grace_deadline.is_some() => {
                // 6s grace expired with plans still pending — abandon them.
                loop_exit = "grace";
                break;
            }
            item = futs.next() => {
                match item {
                    Some((i, results)) => {
                        landed_results += results.len();
                        for r in &results {
                            landed_engines.insert(r.engine.clone());
                        }
                        settled[i] = Some(results);
                        if !grace_armed
                            && landed_results >= QUORUM_MIN_RESULTS
                            && landed_engines.len() >= QUORUM_MIN_ENGINES
                        {
                            // ⇔ armGraceTimer (guards double-arm).
                            grace_armed = true;
                            grace_deadline = Some(
                                tokio::time::Instant::now() + Duration::from_millis(GRACE_TIMER_MS),
                            );
                        }
                    }
                    None => break,
                }
            }
            _ = &mut hard_cap => {
                // 15s absolute hard cap (deadlock safety net).
                loop_exit = "hard_cap";
                break;
            }
        }
    }

    let flat: Vec<RawSearchResult> = settled.into_iter().flatten().flatten().collect();
    let preferred: Vec<String> = effective
        .iter()
        .flat_map(|p| p.preferred_domains.clone().unwrap_or_default())
        .collect();
    let intent: Intent = effective
        .first()
        .map(|p| p.intent.clone())
        .unwrap_or(Intent::General);
    let ranked = reciprocal_rank_fuse(&flat, Some(&preferred), &intent);

    // ── Per-result relevance floor (starvation-guarded) ──
    let per_query_tokens: Vec<Vec<String>> = {
        let mut anchors: Vec<String> = deduplicate_queries(&all_queries);
        anchors.extend(
            effective
                .iter()
                .map(|p| p.relevance_anchor.clone().unwrap_or_default())
                .filter(|a| !a.is_empty()),
        );
        anchors
            .iter()
            .map(|q| query_core_tokens(q))
            .filter(|toks| !toks.is_empty())
            .collect()
    };
    let relevant: Vec<RankedResult> = if per_query_tokens.is_empty() {
        ranked.clone()
    } else {
        ranked
            .iter()
            .filter(|r| {
                let text = format!("{} {} {}", r.title, r.snippet, r.url);
                per_query_tokens
                    .iter()
                    .any(|toks| meets_lexical_threshold(&text, toks))
            })
            .cloned()
            .collect()
    };
    let fused_n = ranked.len();
    let floor_kept = relevant.len() >= ranked.len().min(5);
    let out: Vec<RankedResult> = if floor_kept {
        // (telemetry `log.info` dropped — divergence recorded.)
        relevant.into_iter().take(max_results).collect()
    } else {
        // (starvation `log.info` dropped.)
        ranked.into_iter().take(max_results).collect()
    };
    tracing::info!(
        plans = effective.len(),
        exit = loop_exit,
        metasearch_cycle_ms = t_meta_cycle.elapsed().as_millis() as u64,
        raw = flat.len(),
        fused = fused_n,
        kept = out.len(),
        relevance_floor_kept = floor_kept,
        "metasearch cycle complete"
    );
    out
}

/// ⇔ TS `{ results, freshnessRecoveryUsed }`.
#[derive(Debug, Clone, PartialEq)]
pub struct FreshnessRecovery {
    pub results: Vec<RankedResult>,
    pub freshness_recovery_used: bool,
}

/// TS `metasearchWithFreshnessRecovery(plans, maxResults = 20)`.
///
/// shortcut: no query-level single-flight coalescing — local single-user
/// app (concurrent identical queries ≈ zero), fanout-level sharing would
/// break TS-oracle/Rust-mirror parity via process statics, and repeat URL
/// work is already covered by canonical dedupe before fetch. Upgrade when
/// a multi-user server ships.
pub async fn metasearch_with_freshness_recovery(
    net: &dyn Net,
    plans: &[SearchPlan],
    max_results: usize,
) -> FreshnessRecovery {
    // TS: `plans.every(p => !p.freshness || p.freshness === "any")` —
    // Freshness::None serializes as "none" and is NOT "any" (kept).
    let any_plan = plans
        .iter()
        .all(|p| p.freshness.as_ref().is_none_or(|f| f.as_str() == "any"));
    let first_pass = metasearch(net, plans, max_results).await;

    if !any_plan && first_pass.len() < 5 {
        let cleared: Vec<SearchPlan> = plans
            .iter()
            .map(|p| SearchPlan {
                freshness: Some(Freshness::Any),
                ..p.clone()
            })
            .collect();
        let second_pass = metasearch(net, &cleared, max_results).await;
        if second_pass.len() > first_pass.len() {
            return FreshnessRecovery {
                results: second_pass,
                freshness_recovery_used: true,
            };
        }
    }

    FreshnessRecovery {
        results: first_pass,
        freshness_recovery_used: false,
    }
}

/// TS `metasearchWithBudget(plans, maxResults, budgetMs)`. `console.warn`
/// becomes `eprintln!` (divergence recorded); the timing clock is the wall
/// clock (JS `Date.now`).
pub async fn metasearch_with_budget(
    net: &dyn Net,
    plans: &[SearchPlan],
    max_results: usize,
    budget_ms: u64,
) -> Vec<RankedResult> {
    let t0 = std::time::Instant::now();
    let results = metasearch(net, plans, max_results).await;
    let elapsed = t0.elapsed().as_millis() as i64;
    if elapsed > budget_ms as i64 + 5_000 {
        eprintln!(
            "[metasearch] wall-clock budget ({budget_ms}ms) exceeded by {}ms; {} results returned",
            elapsed - budget_ms as i64,
            results.len()
        );
    }
    results
}

/* ── urlSearchFallback ──────────────────────────────────────────────────── */

fn host_path_of(u: &Url) -> (String, String) {
    let h = u.host_str().unwrap_or("").to_lowercase();
    let host = match h.strip_prefix("www.") {
        Some(s) => s.to_string(),
        None => h,
    };
    static TRAIL: OnceLock<Regex> = OnceLock::new();
    let re = TRAIL.get_or_init(|| Regex::new(r"/+$").expect("static regex"));
    let path = re.replace_all(u.path(), "").into_owned();
    (host, path)
}

/// TS `urlSearchFallback(targetUrl, title?)`.
///
/// TS quirks kept verbatim: the variable is named `ddg` but the call is
/// `searchOne(query, "general")` (the FULL pool + general verticals); the
/// path compare has NO `path.length>1` guard that `normalizeUrl` has; the
/// output `url` is the RAW targetUrl while `canonical` is normalized; and
/// `rrf` uses the FUSION index (`1/(60+i+1)`), not the engine rank.
///
/// Divergence: `new URL(x)` on a scheme-less string resolves against no
/// base in TS (throws → the catch arms); the `url` crate simply errors →
/// same "keep empty"/"return false" outcome.
pub async fn url_search_fallback(
    net: &dyn Net,
    target_url: &str,
    title: Option<&str>,
) -> Vec<RankedResult> {
    let title_prefix = match title {
        Some(t) if t != target_url && !t.is_empty() => format!("{t} "),
        _ => String::new(),
    };
    let query = format!("{title_prefix}{target_url}");

    let mut raw: Vec<RawSearchResult> = Vec::new();
    // TS comment says "ddg"; the code runs the full general searchOne.
    let pool = search_one(net, &query, &Intent::General, None, None).await;
    raw.extend(pool);
    raw.extend(google_search(net, &query).await);

    let (target_host, target_path) = match Url::parse(target_url) {
        Ok(u) => host_path_of(&u),
        Err(_) => (String::new(), String::new()),
    };

    let matching: Vec<RawSearchResult> = raw
        .into_iter()
        .filter(|r| match Url::parse(&r.url) {
            Ok(u) => {
                let (rh, rp) = host_path_of(&u);
                if rh != target_host {
                    return false;
                }
                if !target_path.is_empty() && !rp.is_empty() && target_path != rp {
                    return false;
                }
                true
            }
            Err(_) => false,
        })
        .collect();

    matching
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            let mut engine_ranks: Map<String, Value> = Map::new();
            engine_ranks.insert(r.engine.clone(), engine_rank_value((i + 1) as i64));
            RankedResult {
                url: target_url.to_string(),
                canonical: normalize_url(target_url),
                title: r.title,
                snippet: r.snippet,
                engine: r.engine.clone(),
                published_date: r.published_date,
                domain: target_host.clone(),
                // FUSION index quirk (NOT the engine rank):
                rrf: 1.0 / (RRF_K + i as f64 + 1.0),
                engines: vec![r.engine],
                engine_ranks,
            }
        })
        .collect()
}

/* ── slugTriangulation ──────────────────────────────────────────────────── */

/// TS `slugTriangulation(targetUrl, title?)` — Tier 6 synthesized-evidence
/// block. `""` when nothing useful is found.
pub async fn slug_triangulation(net: &dyn Net, target_url: &str, title: Option<&str>) -> String {
    let u = match Url::parse(target_url) {
        Ok(u) => u,
        Err(_) => return String::new(),
    };
    let h = u.host_str().unwrap_or("").to_lowercase();
    let host = match h.strip_prefix("www.") {
        Some(s) => s.to_string(),
        None => h,
    };

    static NUMERIC: OnceLock<Regex> = OnceLock::new();
    static DASHES: OnceLock<Regex> = OnceLock::new();
    let numeric = NUMERIC.get_or_init(|| Regex::new(r"^(?-u:\d)+$").expect("static regex"));
    let dashes = DASHES.get_or_init(|| Regex::new(r"[-_]").expect("static regex"));

    let slug_tokens: Vec<String> = u
        .path()
        .split('/')
        .filter(|s| js_len(s) > 2 && !numeric.is_match(s))
        .map(|s| dashes.replace_all(s, " ").trim().to_string())
        .filter(|s| js_len(s) > 2)
        .take(4)
        .collect();

    let quoted: Vec<String> = slug_tokens.iter().map(|t| format!("\"{t}\"")).collect();
    let site_query = format!("site:{host} {}", if quoted.is_empty() { "*".to_string() } else { quoted.join(" ") });
    // `"${host.replace(/\.\w+$/,"")}" ${tokens.join(" ")}` — the trailing
    // space when tokens are empty is a TS quirk, kept verbatim.
    static TLD: OnceLock<Regex> = OnceLock::new();
    let tld = TLD.get_or_init(|| Regex::new(r"\.(?-u:\w)+$").expect("static regex"));
    let root = tld.replace(&host, "");
    let broad_query = format!("\"{root}\" {}", slug_tokens.join(" "));

    let (site_results, broad_results) = futures_util::join!(
        search_one(net, &site_query, &Intent::General, None, None),
        search_one(net, &broad_query, &Intent::General, None, None),
    );

    let mut seen: HashSet<String> = HashSet::new();
    let all: Vec<RawSearchResult> = site_results
        .into_iter()
        .chain(broad_results)
        .filter(|r| {
            // normalizeUrl catch → false (raw passthrough in the Rust port;
            // seen-add still happens for dropped duplicates — TS order kept).
            let norm = normalize_url(&r.url);
            if seen.contains(&norm) {
                return false;
            }
            seen.insert(norm);
            js_len(&r.snippet) >= 20 || js_len(&r.title) >= 20
        })
        .collect();
    if all.is_empty() {
        return String::new();
    }

    let mut lines: Vec<String> = vec![format!("[Synthesized Web Index Evidence] for {target_url}")];
    if let Some(t) = title {
        if !t.is_empty() {
            lines.push(format!("Page title (from metasearch): {t}"));
        }
    }

    for r in all.iter().take(8) {
        let t = if r.title.is_empty() { "(untitled)" } else { r.title.as_str() };
        lines.push(format!("- [{}] {}", r.engine, t));
        lines.push(format!("  URL: {}", r.url));
        if !r.snippet.is_empty() {
            lines.push(format!("  Snippet: {}", js_slice_max(&r.snippet, 400)));
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{ScriptedNet, UrlFetchResult};
    use serde_json::json;

    // ── helpers ───────────────────────────────────────────────────────────

    fn raw(engine: &str, url: &str, rank: i64, title: &str, snippet: &str) -> RawSearchResult {
        RawSearchResult {
            title: title.into(),
            url: url.into(),
            snippet: snippet.into(),
            engine: engine.into(),
            published_date: None,
            rank,
        }
    }

    fn rr(title: &str, snippet: &str, url: &str) -> RankedResult {
        RankedResult {
            url: url.into(),
            canonical: url.into(),
            title: title.into(),
            snippet: snippet.into(),
            engine: "test".into(),
            published_date: None,
            domain: "test.com".into(),
            rrf: 0.0,
            engines: Vec::new(),
            engine_ranks: Map::new(),
        }
    }

    fn ok_body(text: String) -> UrlFetchResult {
        UrlFetchResult {
            status: 200,
            ok: true,
            text,
        }
    }

    fn plan(query: &str, intent: Intent, freshness: Option<Freshness>) -> SearchPlan {
        SearchPlan {
            query: query.into(),
            intent,
            preferred_domains: None,
            freshness,
            relevance_anchor: None,
        }
    }

    fn wiki_url(q: &str) -> String {
        format!(
            "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srprop=snippet&srlimit=5&srsearch={}",
            enc_component(q)
        )
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    // ── normalizeUrl ──────────────────────────────────────────────────────

    #[test]
    fn normalize_url_vectors() {
        // tracking params dropped, non-tracking kept, fragment cleared
        assert_eq!(
            normalize_url("https://en.wikipedia.org/wiki/Foo?utm_source=x&fbclid=y&ref=z&id=5#frag"),
            "https://en.wikipedia.org/wiki/Foo?id=5"
        );
        // empty pair list → query fully removed
        assert_eq!(
            normalize_url("https://example.com/p?utm_medium=m"),
            "https://example.com/p"
        );
        // trailing-slash strip only when path length > 1
        assert_eq!(normalize_url("https://example.com//"), "https://example.com/");
        assert_eq!(normalize_url("https://www.Example.com/A/"), "https://example.com/A");
        // default port collapses via the URL parser
        assert_eq!(normalize_url("http://example.com:80/"), "http://example.com/");
        // URLSearchParams round-trip: a `=`-less chunk becomes `k=`, space → `+`
        assert_eq!(normalize_url("https://example.com/?a b"), "https://example.com/?a+b=");
        // invalid URLs pass through verbatim (the TS catch)
        assert_eq!(normalize_url("not a url"), "not a url");
    }

    // ── stripUrlPlans ─────────────────────────────────────────────────────

    #[test]
    fn strip_url_plans_quirks() {
        let mixed = vec![
            plan("https://example.com/page", Intent::General, None),
            plan("real query here", Intent::News, None),
        ];
        let kept = strip_url_plans(&mixed);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].query, "real query here");
        // TS quirk: when EVERY plan is a URL plan, the original list is kept
        let all_urls = vec![plan("http://a.test/x", Intent::General, None)];
        assert_eq!(strip_url_plans(&all_urls), all_urls);
        assert!(strip_url_plans(&[]).is_empty());
    }

    // ── lexical helpers ───────────────────────────────────────────────────

    #[test]
    fn query_core_tokens_orders_and_stops() {
        assert_eq!(
            query_core_tokens(
                "Next.js 15 App Router server actions error handling best practices"
            ),
            vec!["next.js", "app", "router", "server", "actions"]
        );
        // dedup on first occurrence
        assert_eq!(
            query_core_tokens("foobar foobar wiki"),
            vec!["foobar", "wiki"]
        );
        assert!(query_core_tokens("the a in").is_empty());
    }

    #[test]
    fn meets_lexical_threshold_floors() {
        let toks = query_core_tokens("Next.js 15 App Router server actions error handling best practices");
        assert_eq!(toks.len(), 5); // pctFloor = ceil(2.0) = 2, absFloor = 2
        assert!(meets_lexical_threshold("Next.js app", &toks)); // 2 hits
        assert!(!meets_lexical_threshold("router only", &toks)); // 1 hit
        // punctuation-insensitive: "nextjs" matches token "next.js"
        assert!(meets_lexical_threshold("nextjs", &["next.js".to_string(), "app".to_string()]));
        // empty core → always true
        assert!(meets_lexical_threshold("nothing", &[]));
    }

    #[test]
    fn count_lexically_relevant_counts() {
        let results = vec![
            rr("Nextjs routing", "", "https://x.test/1"),
            rr("zzz", "q", "https://y.test/2"),
        ];
        // anchor core = ["next.js","app"] → minHits = min(ceil(0.8)=1, 1) = 1
        assert_eq!(count_lexically_relevant(&results, "next.js app"), 1);
        // empty anchor core → all results count
        assert_eq!(count_lexically_relevant(&results, "the a"), 2);
    }

    // ── engine policy tables ──────────────────────────────────────────────

    #[test]
    fn vertical_and_weight_tables() {
        assert!(is_vertical_engine("wikipedia"));
        assert!(is_vertical_engine("bing-news"));
        assert!(is_vertical_engine("github"));
        // TS table excludes imdb — imdb falls through to the 1.2 bucket.
        assert!(!is_vertical_engine("imdb"));
        assert!(!is_vertical_engine("google"));

        assert_eq!(engine_weight("google", &Intent::General), 1.2);
        assert_eq!(engine_weight("imdb", &Intent::General), 1.2);
        assert_eq!(engine_weight("reddit", &Intent::Academic), 1.0);
        assert_eq!(engine_weight("wikipedia", &Intent::General), 0.65);
        assert_eq!(engine_weight("github", &Intent::General), 0.65);
        assert_eq!(engine_weight("wikipedia", &Intent::Academic), 1.0);
        assert_eq!(engine_weight("wikipedia", &Intent::Docs), 1.0);
    }

    #[test]
    fn caps_and_engine_cap() {
        assert_eq!(cap_for_engine("github"), 3);
        assert_eq!(cap_for_engine("wikipedia"), 5);
        assert_eq!(cap_for_engine("totally-unknown"), 5); // `?? VERTICAL_PER_ENGINE_CAP`

        let mut input = Vec::new();
        for i in 0..6 {
            input.push(raw("wikipedia", &format!("https://w.test/{i}"), i + 1, "t", "s"));
        }
        for i in 0..5 {
            input.push(raw("github", &format!("https://gh.test/{i}"), i + 1, "t", "s"));
        }
        let capped = apply_engine_cap(input);
        assert_eq!(capped.len(), 8); // 5 wikipedia + 3 github
        assert_eq!(capped.iter().filter(|r| r.engine == "wikipedia").count(), 5);
        assert_eq!(capped.iter().filter(|r| r.engine == "github").count(), 3);
        // keep-first semantics
        assert_eq!(capped[5].url, "https://gh.test/0");
        assert_eq!(capped[7].url, "https://gh.test/2");
    }

    #[test]
    fn query_looks_like_dev_word_boundaries() {
        assert!(query_looks_like_dev("c++17 build flags"));
        assert!(query_looks_like_dev("c#learn"));
        assert!(query_looks_like_dev("learn python"));
        // TS quirk: the trailing `\b` after `c++`/`c#` — a bare "c++" or
        // "c#" followed by whitespace never matches.
        assert!(!query_looks_like_dev("foo c++"));
        assert!(!query_looks_like_dev("using c# today"));
    }

    // ── reciprocalRankFuse ────────────────────────────────────────────────

    #[test]
    fn rrf_merge_order_dedup_and_boost() {
        let input = vec![
            raw("google", "https://example.com/page?utm_source=x", 1, "Google A", "sn g"),
            raw("brave", "https://example.com/page?ref=zz", 2, "", ""),
            raw("google", "https://other.org/b", 5, "", ""),
            raw("wikipedia", "https://other.org/b", 1, "B title", "sb"),
            // SSRF-blocked → dropped before aggregation
            raw("google", "http://127.0.0.1/x", 1, "Unsafe", "nope"),
        ];
        let out = reciprocal_rank_fuse(
            &input,
            Some(&["www.Example.com/Docs".to_string()]),
            &Intent::General,
        );
        assert_eq!(out.len(), 2);

        // entry A wins on score: 1.2/61 + 1.2/62 + 0.015 preferred-domain boost
        assert_eq!(out[0].canonical, "https://example.com/page");
        assert!(approx(
            out[0].rrf,
            1.2 / 61.0 + 1.2 / 62.0 + PREFERRED_BOOST
        ));
        assert_eq!(out[0].domain, "example.com");
        assert_eq!(out[0].engines, vec!["google".to_string(), "brave".to_string()]);
        assert_eq!(out[0].engine_ranks.get("google"), Some(&engine_rank_value(1)));
        assert_eq!(out[0].title, "Google A");
        assert_eq!(out[0].snippet, "sn g");

        // entry B: google rank FIRST-WINS (rank 5 kept over rank 1),
        // title/snippet backfilled from the later wikipedia entry.
        assert_eq!(out[1].canonical, "https://other.org/b");
        assert!(approx(out[1].rrf, 1.2 / 65.0 + 0.65 / 61.0)); // no boost
        assert_eq!(out[1].engine_ranks.get("google"), Some(&engine_rank_value(5)));
        assert_eq!(out[1].engine_ranks.get("wikipedia"), Some(&engine_rank_value(1)));
        assert_eq!(out[1].engines, vec!["google".to_string(), "wikipedia".to_string()]);
        assert_eq!(out[1].title, "B title");
        assert_eq!(out[1].snippet, "sb");
    }

    // ── pool-free async fetchers (direct net.fetch_url; zero engine
    //    statics touched, so these run safely alongside engines::tests) ──

    #[tokio::test]
    async fn retry_429_refetches_once_and_returns_the_refetch() {
        let url = "https://retry.test/once";
        let net = ScriptedNet::default().with_url(
            url,
            UrlFetchResult { status: 429, ok: false, text: "slow down".into() },
        );
        // The scripted 429 fires the 2 s backoff retry. ScriptedNet replays
        // the same scripted URL on every call, so the refetch observes the
        // same 429 — TS returns the REFETCH's response verbatim (never the
        // first one, never None-on-failure when the refetch answered).
        let res = fetch_url_with_retry(&net, url, UrlFetchOpts::default()).await;
        assert_eq!(res.expect("refetch response returned").status, 429);
        let calls = net.calls.lock().expect("lock");
        assert_eq!(calls.len(), 2); // exactly ONE retry (429/503 only)
        assert!(calls.iter().all(|(u, k)| u == url && *k == "fetch_url"));
    }

    #[tokio::test]
    async fn wikipedia_gate_tag_strip_url_and_rank() {
        // The verticals are pacer/breaker-guarded now (bench finding #2), so
        // direct-vertical tests share the engines health statics — same
        // lock+reset discipline as the metasearch() tests further below.
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let net = ScriptedNet::default().with_url(
            &wiki_url("FooBar wiki"),
            ok_body(
                json!({ "query": { "search": [
                    { "title": "Bad entry", "snippet": "totally unrelated text" },
                    { "title": "FooBar wiki entry",
                      "snippet": "a <span class=\"x\">foobar</span> wiki article" }
                ] } })
                .to_string(),
            ),
        );
        let out = wikipedia_search(&net, "FooBar wiki").await;
        assert_eq!(out.len(), 1); // entry 1 fails the 2-token lexical gate
        let e = &out[0];
        assert_eq!(e.engine, "wikipedia");
        assert_eq!(e.title, "FooBar wiki entry");
        assert_eq!(e.snippet, "a foobar wiki article"); // <[^>]+> stripped
        assert_eq!(e.url, "https://en.wikipedia.org/wiki/FooBar_wiki_entry");
        assert_eq!(e.rank, 1); // rank = kept position, not api position
        assert_eq!(e.published_date, None);
        assert_eq!(net.calls.lock().expect("lock").len(), 1);
    }

    #[tokio::test]
    async fn wikipedia_non_string_title_aborts_the_whole_stage() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let net = ScriptedNet::default().with_url(
            &wiki_url("FooBar wiki"),
            ok_body(
                json!({ "query": { "search": [
                    { "title": "FooBar first", "snippet": "a foobar wiki line" },
                    { "title": 404, "snippet": "another foobar wiki thing" }
                ] } })
                .to_string(),
            ),
        );
        // TS quirk: `404` PASSES the gate (String(404) = "404"), then
        // `s.title.replace(...)` TypeErrors → outer catch → stage [] —
        // the already-collected first entry is discarded with it.
        assert!(wikipedia_search(&net, "FooBar wiki").await.is_empty());
        // The wrapper tail records this stage abort as a ZERO observation —
        // one zero stays a streak (two would trip like any other source).
        // Pre-Step-A the verticals recorded NOTHING at all: the 429-storm
        // root cause.
        assert_eq!(crate::engines::engine_cooldown_remaining_ms("wikipedia"), 0);
    }

    #[tokio::test]
    async fn wikipedia_wrapper_trips_breaker_after_two_zeros() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        // Unscripted ⇒ the wiki API fetch yields None ⇒ empty output; the
        // pub wrapper (not just metasearch()) is pacer+breaker-guarded.
        let net = ScriptedNet::default();
        assert!(wikipedia_search(&net, "nothing scripted").await.is_empty());
        assert_eq!(crate::engines::engine_cooldown_remaining_ms("wikipedia"), 0, "streak 1 only");
        assert!(wikipedia_search(&net, "nothing scripted").await.is_empty());
        let remaining = crate::engines::engine_cooldown_remaining_ms("wikipedia");
        assert!(remaining > 0, "the wrapper tail trips at streak 2");
        let calls_after_trip = net.calls.lock().expect("lock").len();
        assert!(wikipedia_search(&net, "nothing scripted").await.is_empty());
        assert_eq!(
            net.calls.lock().expect("lock").len(),
            calls_after_trip,
            "the guard head skips: ZERO fetches while cooling down"
        );
    }

    #[tokio::test]
    async fn arxiv_atom_whitespace_collapse_gate_and_published() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let url = format!(
            "http://export.arxiv.org/api/query?search_query=all:{}&max_results=5",
            enc_component("Quantum foo bar")
        );
        let feed = r#"<feed>
  <entry>
    <title>  Quantum   Foo
  Bar </title>
    <link rel="alternate" href="https://arxiv.org/abs/2401.00001" type="text/html"/>
    <summary>Quantum foo bar baz summary with enough words to pass.</summary>
    <published>2024-01-01T00:00:00Z</published>
  </entry>
  <entry>
    <title>Irrelevant thing</title>
    <link rel="alternate" href="https://arxiv.org/abs/2401.00002"/>
    <summary>nothing matching here at all</summary>
    <published>2024-01-02T00:00:00Z</published>
  </entry>
</feed>"#;
        let net = ScriptedNet::default().with_url(&url, ok_body(feed.to_string()));
        let out = arxiv_search(&net, "Quantum foo bar").await;
        assert_eq!(out.len(), 1); // entry 2 fails the 3-token gate (floor 2)
        let e = &out[0];
        assert_eq!(e.engine, "arxiv");
        assert_eq!(e.title, "Quantum Foo Bar"); // trim + /\s+/g collapse
        assert_eq!(e.url, "https://arxiv.org/abs/2401.00001"); // link[rel=alternate]
        assert_eq!(e.snippet, "Quantum foo bar baz summary with enough words to pass.");
        assert_eq!(e.published_date.as_deref(), Some("2024-01-01T00:00:00Z"));
        assert_eq!(e.rank, 1);
    }

    #[tokio::test]
    async fn stackexchange_bad_creation_date_aborts_and_never_retries() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let url = format!(
            "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q={}&site=stackoverflow&pagesize=15",
            enc_component("Foo bar")
        );
        let net = ScriptedNet::default().with_url(
            &url,
            ok_body(
                json!({ "items": [
                    { "title": "Foo bar question", "link": "https://stackoverflow.com/q/1",
                      "creation_date": "notanumber" }
                ] })
                .to_string(),
            ),
        );
        let out = stack_exchange_search(&net, "Foo bar").await;
        assert!(out.is_empty()); // NaN Date → toISOString throws → whole stage []
        assert_eq!(net.calls.lock().expect("lock").len(), 1); // NO retry (TS quirk)
    }

    #[tokio::test]
    async fn stackexchange_creation_date_rfc3339_and_snippet_eq_title() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let url = format!(
            "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q={}&site=stackoverflow&pagesize=15",
            enc_component("Foo bar")
        );
        let net = ScriptedNet::default().with_url(
            &url,
            ok_body(
                json!({ "items": [
                    { "title": "Foo bar question", "link": "https://stackoverflow.com/q/1",
                      "creation_date": 1700000000 },
                    { "title": "Totally unrelated query", "link": "https://stackoverflow.com/q/2",
                      "creation_date": 1700000001 }
                ] })
                .to_string(),
            ),
        );
        let out = stack_exchange_search(&net, "Foo bar").await;
        assert_eq!(out.len(), 1); // entry 2 fails the title-only gate
        let e = &out[0];
        assert_eq!(e.engine, "stackexchange");
        assert_eq!(e.url, "https://stackoverflow.com/q/1");
        assert_eq!(e.title, "Foo bar question");
        assert_eq!(e.snippet, "Foo bar question"); // snippet = title (TS)
        assert_eq!(e.published_date.as_deref(), Some("2023-11-14T22:13:20.000Z"));
        assert_eq!(e.rank, 1);
    }

    #[tokio::test]
    async fn imdb_id_and_kind_filters_with_cap_at_five() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let url = format!(
            "https://v3.sg.media-imdb.com/suggestion/x/{}.json?include_WARNINGS=false",
            enc_component("the movie")
        );
        let net = ScriptedNet::default().with_url(
            &url,
            ok_body(
                json!({ "d": [
                    { "id": "tt12345", "q": "movie" },
                    { "id": "tt1234567", "q": "movie" },
                    { "id": "tt7654321", "q": "person" },
                    { "id": "tt12345678", "q": "tv series", "y": 2025, "display": "Show Name" },
                    { "id": "tt99999999", "description": "film", "name": "AltName" },
                    { "id": "tt11111111", "q": "movie" },
                    { "id": "tt22222222", "q": "movie" },
                    { "id": "tt33333333", "q": "movie" }
                ] })
                .to_string(),
            ),
        );
        // imdb has NO lexical gate (TS: imdb is not in VERTICAL_ENGINES —
        // it always fuses at the 1.2 general-web weight).
        let out = imdb_suggestion_search(&net, "the movie").await;
        assert_eq!(out.len(), 5); // break at 5 → tt33333333 never reached
        assert_eq!(out[0].url, "https://www.imdb.com/title/tt1234567/"); // tt12345 too short
        assert_eq!(out[0].title, ""); // display ?? name ?? "" (TS quirk)
        assert_eq!(out[0].snippet, "movie");
        assert_eq!(out[1].url, "https://www.imdb.com/title/tt12345678/"); // "tv series" ~ /series/
        assert_eq!(out[1].title, "Show Name");
        assert_eq!(out[1].snippet, "tv series (2025)");
        assert_eq!(out[2].url, "https://www.imdb.com/title/tt99999999/"); // description fallback
        assert_eq!(out[2].title, "AltName");
        assert_eq!(out[2].snippet, ""); // no q/y → filter(Boolean) → ""
        assert_eq!(out[3].rank, 4);
        assert_eq!(out[4].rank, 5);
    }

    // ── pool-free async behavior (zero engine statics touched; always run) ──

    #[tokio::test]
    async fn metasearch_with_empty_plan_list_resolves_immediately() {
        let net = ScriptedNet::default();
        assert!(metasearch(&net, &[], 20).await.is_empty());
        assert!(net.calls.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn freshness_recovery_empty_plans_skips_the_second_pass() {
        let net = ScriptedNet::default();
        let rec = metasearch_with_freshness_recovery(&net, &[], 20).await;
        // `every(...)` over an empty plan list is vacuously true → no recovery.
        assert!(!rec.freshness_recovery_used);
        assert!(rec.results.is_empty());
        assert!(net.calls.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn budget_wrapper_just_returns_metasearch_results() {
        let net = ScriptedNet::default();
        assert!(metasearch_with_budget(&net, &[], 5, 1).await.is_empty());
        assert!(net.calls.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn slug_triangulation_unparseable_url_returns_empty_without_fetch() {
        let net = ScriptedNet::default();
        assert_eq!(slug_triangulation(&net, "not a url", None).await, "");
        assert!(net.calls.lock().expect("lock").is_empty());
    }

    // ── pool-fanning integration tests ────────────────────────────────────
    //
    // These drive search_one → engines::run_general_web_search, and that
    // pool's engines mutate PROCESS-GLOBAL pacing/breaker statics in
    // engines.rs (pacer_map / streak_map / cooldown_map). They hold the
    // SAME engines::engine_test_lock (pub(crate)) that engines' serp_tests
    // serialize behind — and reset statics first, exactly like serp_tests —
    // so the whole engine-touching suite takes turns instead of flaking.

    #[tokio::test]
    async fn metasearch_fuses_scripted_wikipedia_result() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let net = ScriptedNet::default().with_url(
            &wiki_url("FooBar wiki"),
            ok_body(
                json!({ "query": { "search": [
                    { "title": "FooBar wiki entry", "snippet": "a foobar wiki article" }
                ] } })
                .to_string(),
            ),
        );
        let out = metasearch(&net, &[plan("FooBar wiki", Intent::General, None)], 20).await;
        assert_eq!(out.len(), 1); // unscripted pool engines contribute nothing
        let r = &out[0];
        assert_eq!(r.url, "https://en.wikipedia.org/wiki/FooBar_wiki_entry");
        assert_eq!(r.title, "FooBar wiki entry");
        assert_eq!(r.domain, "en.wikipedia.org");
        assert_eq!(r.engines, vec!["wikipedia".to_string()]);
        assert_eq!(r.engine_ranks.get("wikipedia"), Some(&engine_rank_value(1)));
        assert!(approx(r.rrf, 0.65 / 61.0)); // wikipedia@General weight 0.65, rank 1
    }

    #[tokio::test]
    async fn two_plans_shard_the_pool_and_run_both_verticals() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let net = ScriptedNet::default()
            .with_url(
                &wiki_url("FooBar wiki"),
                ok_body(
                    json!({ "query": { "search": [
                        { "title": "FooBar wiki entry", "snippet": "a foobar wiki article" }
                    ] } })
                    .to_string(),
                ),
            )
            .with_url(
                &wiki_url("zzz qqq"),
                ok_body(
                    json!({ "query": { "search": [
                        { "title": "Nothing relevant", "snippet": "totally off topic text here" }
                    ] } })
                    .to_string(),
                ),
            );
        let plans = vec![
            plan("FooBar wiki", Intent::General, None),
            plan("zzz qqq", Intent::General, None),
        ];
        let out = metasearch(&net, &plans, 20).await;
        assert_eq!(out.len(), 1); // plan 2's entry fails its query's lexical gate
        assert_eq!(out[0].title, "FooBar wiki entry");
        let calls = net.calls.lock().expect("lock");
        assert!(calls.iter().any(|(u, _)| u == &wiki_url("FooBar wiki")));
        assert!(calls.iter().any(|(u, _)| u == &wiki_url("zzz qqq"))); // both plans ran
    }

    #[tokio::test]
    async fn freshness_week_fires_bing_news_rss_and_any_does_not() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let q = "FooBar wiki";
        let news_url =
            format!("https://www.bing.com/news/search?q={}&format=rss&count=20", enc_component(q));
        let rss = "<rss><channel><item><title><![CDATA[FooBar wiki headline one line]]></title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3A%2F%2Falpha-one.com%2Fnews&amp;get=1</link><pubDate>Tue, 14 Nov 2023 22:13:20 GMT</pubDate><description>a foobar wiki story body</description></item></channel></rss>";
        let net = ScriptedNet::default().with_url(&news_url, ok_body(rss.to_string()));
        let out = search_one(&net, q, &Intent::General, None, Some(&Freshness::Week)).await;
        let news: Vec<&RawSearchResult> =
            out.iter().filter(|r| r.engine == "bing-news").collect();
        assert_eq!(news.len(), 1);
        assert_eq!(news[0].url, "https://alpha-one.com/news"); // url= param, decoded
        assert_eq!(news[0].published_date.as_deref(), Some("Tue, 14 Nov 2023 22:13:20 GMT"));
        assert!(net.calls.lock().expect("lock").iter().any(|(u, _)| u == &news_url));

        // Freshness::Any must NOT fire the news vertical (TS gate: != "any").
        let net2 = ScriptedNet::default();
        let out2 = search_one(&net2, q, &Intent::General, None, Some(&Freshness::Any)).await;
        assert!(out2.is_empty());
        assert!(!net2.calls.lock().expect("lock").iter().any(|(u, _)| u == &news_url));
    }

    #[tokio::test]
    async fn url_search_fallback_maps_a_wiki_hit_onto_the_target() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let target = "https://en.wikipedia.org/wiki/FooBar";
        let net = ScriptedNet::default().with_url(
            &wiki_url(target),
            ok_body(
                json!({ "query": { "search": [
                    { "title": "FooBar", "snippet": "the foobar wiki article about things" }
                ] } })
                .to_string(),
            ),
        );
        let out = url_search_fallback(&net, target, None).await;
        assert_eq!(out.len(), 1);
        let r = &out[0];
        // TS quirks: url = RAW target; canonical = normalized; rrf = FUSION
        // index 1/(60+i+1), not the engine rank; domain = target host.
        assert_eq!(r.url, target);
        assert_eq!(r.canonical, "https://en.wikipedia.org/wiki/FooBar");
        assert_eq!(r.domain, "en.wikipedia.org");
        assert!(approx(r.rrf, 1.0 / 61.0));
        assert_eq!(r.engines, vec!["wikipedia".to_string()]);
        assert_eq!(r.engine_ranks.get("wikipedia"), Some(&engine_rank_value(1)));
    }

    #[tokio::test]
    async fn slug_triangulation_synthesizes_evidence_and_dedupes_both_queries() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let target = "https://example.com/foo-bar/baz";
        let site_q = "site:example.com \"foo bar\" \"baz\"";
        let broad_q = "\"example\" foo bar baz";
        let entry = json!({ "query": { "search": [
            { "title": "Foo bar baz page",
              "snippet": "An example snippet that is definitely longer than twenty characters" }
        ] } });
        let net = ScriptedNet::default()
            .with_url(&wiki_url(site_q), ok_body(entry.to_string()))
            .with_url(&wiki_url(broad_q), ok_body(entry.to_string()));
        let out = slug_triangulation(&net, target, Some("My Target Title")).await;
        assert!(out.starts_with("[Synthesized Web Index Evidence] for https://example.com/foo-bar/baz"));
        assert!(out.contains("Page title (from metasearch): My Target Title"));
        assert_eq!(out.matches("- [").count(), 1); // normalizeUrl dedupe across passes
        assert!(out.contains("  URL: https://en.wikipedia.org/wiki/Foo_bar_baz_page"));
        assert!(out.contains("  Snippet: An example snippet"));
        let calls = net.calls.lock().expect("lock");
        assert!(calls.iter().any(|(u, _)| u == &wiki_url(site_q)));
        assert!(calls.iter().any(|(u, _)| u == &wiki_url(broad_q)));
    }

    #[tokio::test]
    async fn freshness_recovery_refires_with_any_but_keeps_first_when_no_gain() {
        let _g = crate::engines::engine_test_lock().lock().await;
        crate::engines::reset_engine_state_for_tests();
        let net = ScriptedNet::default().with_url(
            &wiki_url("FooBar wiki"),
            ok_body(
                json!({ "query": { "search": [
                    { "title": "FooBar wiki entry", "snippet": "a foobar wiki article" }
                ] } })
                .to_string(),
            ),
        );
        let plans = [plan("FooBar wiki", Intent::General, Some(Freshness::Week))];
        let rec = metasearch_with_freshness_recovery(&net, &plans, 20).await;
        assert_eq!(rec.results.len(), 1);
        assert!(!rec.freshness_recovery_used); // 2nd pass not strictly better → keep 1st
        let wiki_hits = net
            .calls
            .lock()
            .expect("lock")
            .iter()
            .filter(|(u, _)| u == &wiki_url("FooBar wiki"))
            .count();
        assert_eq!(wiki_hits, 2); // both passes ran (news vertical unscripted → [])
    }
}

