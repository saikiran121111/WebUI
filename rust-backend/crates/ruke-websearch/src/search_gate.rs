//! Parity port of `lib/web-search/search-gate.ts` — the SEARCH-BY-DEFAULT
//! gate: Stage-0 deterministic hard bypass → trivial short-circuit →
//! main-model JSON verdict re-verified against the external-entity
//! heuristic → always-search rules fallback.
//!
//! JS-vs-Rust divergences recorded per the PARITY rule (nothing "fixed"):
//! - **Dropped dead code** (never referenced in TS): `GATE_JSON_SCHEMA`
//!   (the fetch body only sends `response_format: {type:"json_object"}`),
//!   `KNOWN_SITE_TOKEN_RE`, `DOMAIN_TLD_TOKEN_RE`, `WWW_TOKEN_RE` (the
//!   bypass uses the tldts/psl detector instead), the unused
//!   `searchByDefault` binding (ported as `_search_by_default`), and the
//!   `HardBypassHit.matched: "known_site"` variant is NEVER constructed
//!   by TS — kept in the enum, never produced.
//! - **Raw reqwest here is load-bearing**: TS `mainModelGate` carries the
//!   last-4 history turns inside `messages`, which
//!   [`crate::llm_json::json_completion`] (system+user only) cannot
//!   express; it also has NO `registerTitleCall` slot (unlike llm_json),
//!   so no [`ruke_core::slot::InferenceSlot`] is registered. The 35 s
//!   `AbortSignal.timeout` maps to `tokio::time::timeout` wrapping the
//!   whole send+read, and `endpoint()`/`llmApiKey()` resolve to CALLER
//!   fields on [`SearchGateOptions`] (mirrors llm_json's pattern — this
//!   crate must not read settings.json itself). `SearchGateOptions::
//!   gate_disabled: Some(bool)` additionally overrides the two env vars
//!   for tests/callers — an ADDED seam, TS reads env only.
//! - `String(x ?? default)` coercion: numbers/bools format identically,
//!   but objects render as serde JSON (`{"a":1}`) where JS gives
//!   `[object Object]`, and arrays as `[1,2]` where JS gives `1,2`.
//!   `preferred_domains` non-string elements are coerced to strings.
//!   Only reachable from a model emitting wrong types; recorded, not fixed.
//! - JS `.slice(4)` on the external-entity check is UTF-16 → [`utf16_from`].
//! - The prompt-comment numbering in `promptHasExternalEntity` skips "2."
//!   in TS (the known-site/domain checks were folded into tldts) — kept.
//! - JSON.parse vs serde_json: both reject trailing commas / NaN/Infinity;
//!   model-facing payloads only. JS `\s` vs regex-crate `\s` differ on
//!   U+0085 (JS excludes) and U+FEFF (JS includes) — ASCII prompts only.
//! - Math.round vs f64::round: differ only for negative halves; gateMs
//!   and (in reranker) scores are never negative.

use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::llm_json::apply_thinking_off;
use crate::types::{
    Depth, Freshness, GateSource, Intent, SearchDecision, SearchGateContext, SearchGateResult,
    SearchQuery,
};
use crate::url_detector::{detect_prompt_urls, detect_urls_and_domains, DetectedUrl};

// ⇔ `process.env.WEB_SEARCH_LLM_ENDPOINT ?? llmApiUrl()` / `llmApiKey()` —
// resolved by the CALLER per invocation (settings.json edits land without
// a restart), same contract as `llm_json::JsonCompletionOptions`.
pub struct SearchGateOptions {
    pub endpoint: String,
    pub api_key: String,
    /// ⇔ `WEB_SEARCH_GATE_DISABLED === "1" || WEB_SEARCH_LFM_DISABLED ===
    /// "1"` when `None`; `Some` overrides the env check (test seam).
    pub gate_disabled: Option<bool>,
}

const MAIN_GATE_TIMEOUT_MS: u64 = 35_000;
const MAIN_GATE_MAX_TOKENS: u64 = 320;

/* ── JS-string helpers (UTF-16 semantics) ─────────────────────────────── */

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(n)` — drop the first `n` UTF-16 units (char-boundary snap).
fn utf16_from(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut u = 0usize;
    for c in s.chars() {
        let cu = c.len_utf16();
        if u >= n {
            out.push(c);
        }
        u += cu;
    }
    out
}

/// JS `s.slice(0, n)`.
fn utf16_prefix(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut u = 0usize;
    for c in s.chars() {
        let cu = c.len_utf16();
        if u + cu > n {
            break;
        }
        out.push(c);
        u += cu;
    }
    out
}

/// `/\s+/g → " "` collapse, trim, `.slice(0, 300)` — the normalized-query
/// form used by every fallback path.
fn normalized_query_text(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let collapsed = RE.get_or_init(|| Regex::new(r"\s+").unwrap()).replace_all(s, " ");
    utf16_prefix(collapsed.trim(), 300)
}

/* ── trivial prompt short-circuit (the ONLY regex that survives) ─────── */

const TRIVIAL_EXACT: &[&str] = &[
    // greetings
    "hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "thx", "ok", "okay", "cool", "nice",
    "got it", "sounds good", "bye", "goodbye",
    // assistant-identity / pure chit-chat
    "what are you doing", "what are you up to", "which model are you", "what model are you",
    "who are you", "who made you", "who created you", "what are you", "are you alive",
    "how do you work", "how are you", "what can you do",
];

fn re_trivial_filler() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(?:by the way|so|anyway|then|oh|hmm|hi|hey|hello|thanks|thank you)\s+")
            .unwrap()
    })
}

fn is_js_ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

fn is_trivial_prompt(prompt: &str) -> bool {
    let mut p = prompt.trim().to_lowercase();
    // ⇔ `p.replace(/[.!?…\s]+$/, "")` (… is multi-byte → manual trim).
    let mut end = p.len();
    for (i, c) in p.char_indices().rev() {
        if ".!?…".contains(c) || is_js_ws(c) {
            end = i;
        } else {
            break;
        }
    }
    p.truncate(end);
    if TRIVIAL_EXACT.contains(&p.as_str()) {
        return true;
    }
    let peeled = re_trivial_filler().replace(&p, "").into_owned();
    peeled != p && TRIVIAL_EXACT.contains(&peeled.as_str())
}

/// ⇔ TS `extractPromptUrls` (tldts-based ⇔ psl-based detector).
pub fn extract_prompt_urls(prompt: &str) -> Vec<String> {
    detect_prompt_urls(prompt)
}

/* ── regex tables (ASCII-semantics \b scoped with (?-u:…)) ───────────── */

fn re_web_intent() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b(?:search|watch|video|location|maps|linkedin|reddit|latest|current|today|price|jobs|hiring|20(?:2[4-9]))\b)|(?-u:\blook)\s?(?-u:up\b)|(?-u:\bwho)\s+(?-u:won\b))",
        )
        .unwrap()
    })
}

/// Lookup-intent words that only count when an image is attached.
fn re_image_lookup_intent() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b(?:search|linkedin|profile|find|guy|person|company|location|product)\b)|(?-u:\bwho)\s*'?s?\s+(?-u:is\b)|(?-u:\bwhere\s+is\b)|(?-u:\bwhat\s+is\s+this\b))",
        )
        .unwrap()
    })
}

fn re_http_url_strip() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)https?://[^\s"'<>\[\]]+"#).unwrap())
}

fn re_newsy() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?-u:\b(?:latest|current|today|20(?:2[4-9]))\b|(?-u:\bwho)\s+(?-u:won\b)|(?-u:\b(?:price|jobs|hiring)\b))")
            .unwrap()
    })
}

fn re_proper_noun() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?-u:\b[A-Z][a-z]{2,})\s+(?-u:[A-Z][a-z]{2,}\b)").unwrap())
}

fn re_version_number() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?-u:\bv?\d+\.\d+(?:\.\d+)?\b)").unwrap())
}

fn re_model_number() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?-u:\b[A-Z]{2,})\s?(?-u:\d{2,4}\b)").unwrap())
}

fn re_time_sensitive() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?-u:\b(?:today|current|latest|recent|20(?:[012]\d))\b)").unwrap())
}

fn re_nonleading_cap() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?-u:\b[A-Z][a-z]{3,}\b)").unwrap())
}

/// rulesBasedPlan time signal — deliberately NO word boundaries in TS
/// ("renew" contains "new"); kept verbatim.
fn re_rule_time() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)latest|recent|new|current|today|this (week|month|year|quarter)").unwrap())
}

fn re_rule_version() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:(?-u:\bv?\d+\.\d+)|version (?-u:\d))").unwrap())
}

/* ── STAGE 0: deterministic hard bypass (0 ms, no LLM call) ─────────── */

/// ⇔ `HardBypassHit.matched`. NOTE: `KnownSite` is NEVER produced — the
/// TS code paths that used the old token regexes now route through the
/// tldts/psl detector and land on `Url` (dead variant kept for surface
/// parity, exactly like TS's dead `KNOWN_SITE_TOKEN_RE` family).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BypassMatched {
    Url,
    KnownSite,
    WebIntent,
    ImageIntent,
}

// NOTE: no `Serialize` — `DetectedUrl` (W0, not editable) does not
// implement it; the TS interface is a type surface, not a wire format.
#[derive(Debug, Clone, PartialEq)]
pub struct HardBypassHit {
    pub matched: BypassMatched,
    /// psl-detected URLs/bare-domains (normalised https:// form).
    pub detected: Vec<DetectedUrl>,
}

/// ⇔ TS's `{ decision, hit }` return.
#[derive(Debug, Clone, PartialEq)]
pub struct HardBypassResult {
    pub decision: SearchDecision,
    pub hit: HardBypassHit,
}

pub fn deterministic_hard_bypass(ctx: &SearchGateContext) -> Option<HardBypassResult> {
    let p = ctx.user_prompt.trim();
    if p.is_empty() {
        return None;
    }

    let detected = detect_urls_and_domains(p, true);
    let matched = if !detected.is_empty() {
        BypassMatched::Url
    } else if re_web_intent().is_match(p) {
        BypassMatched::WebIntent
    } else if ctx.has_image_attachment.unwrap_or(false) && re_image_lookup_intent().is_match(p) {
        BypassMatched::ImageIntent
    } else {
        return None;
    };
    let hit = HardBypassHit { matched, detected };

    let mut queries: Vec<SearchQuery> = Vec::new();
    // Keyword form first: search engines index pages, not URL strings.
    const FILLER: &[&str] = &[
        "tell", "me", "what", "is", "the", "a", "an", "i", "want", "to", "so", "you", "can",
        "could", "please", "how", "about", "in", "on", "at", "by", "for", "from", "with", "that",
        "this", "these", "those", "there", "here", "would", "like", "need", "look", "find",
        "show", "give", "get", "best", "top", "good", "and", "it", "its", "of", "up",
    ];
    let filler: HashSet<&str> = FILLER.iter().copied().collect();
    let lowered = re_http_url_strip().replace_all(p, " ").to_lowercase();
    let cleaned: String = lowered
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || is_js_ws(c) {
                c
            } else {
                ' '
            }
        })
        .collect();
    let keywords = cleaned
        .split_whitespace()
        .filter(|w| w.chars().count() > 2 && !filler.contains(*w))
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    if utf16_len(&keywords) > 3 {
        queries.push(SearchQuery {
            query: keywords,
            intent: Intent::General,
            preferred_domains: None,
        });
    }

    // URL plans: kept as last queries (cache-key continuity).
    for d in hit.detected.iter().take(4) {
        if !queries.iter().any(|q| q.query == d.url) {
            queries.push(SearchQuery {
                query: d.url.clone(),
                intent: Intent::General,
                preferred_domains: None,
            });
        }
    }
    if queries.is_empty() {
        queries.push(SearchQuery {
            query: normalized_query_text(p),
            intent: Intent::General,
            preferred_domains: None,
        });
    }

    let is_newsy = re_newsy().is_match(p);
    let has_detected = !hit.detected.is_empty();
    Some(HardBypassResult {
        hit,
        decision: SearchDecision {
            search_required: true,
            reason: "deterministic_url_or_intent".into(),
            freshness: if is_newsy { Freshness::Week } else { Freshness::Any },
            depth: if has_detected { Depth::Deep } else { Depth::Standard },
            queries,
        },
    })
}

/* ── external-entity detector (the search-by-default re-verify) ──────── */

pub fn prompt_has_external_entity(prompt: &str) -> bool {
    let p = prompt;
    if p.trim().is_empty() {
        return false;
    }
    // 1. Explicit URL or bare domain (tldts ⇔ psl).
    if !detect_urls_and_domains(p, true).is_empty() {
        return true;
    }
    // (TS numbering skips "2." — the known-site/domain token checks were
    // folded into the detector above; comment kept for parity.)
    // 3. Proper-noun phrase: two consecutive capitalized words.
    if re_proper_noun().is_match(p) {
        return true;
    }
    // 4. Version numbers / model numbers (v1.2.3, 15.2, 3090, RTX 4090…).
    if re_version_number().is_match(p) || re_model_number().is_match(p) {
        return true;
    }
    // 5. Time-sensitivity signal.
    if re_time_sensitive().is_match(p) {
        return true;
    }
    // 6. Capitalized 4+ char token after position 4 (JS UTF-16 slice).
    if re_nonleading_cap().is_match(&utf16_from(p, 4)) {
        return true;
    }
    false
}

/* ── deterministic fallback plans (emergency only) ───────────────────── */

pub fn rules_based_plan(ctx: &SearchGateContext) -> SearchGateResult {
    let p = ctx.user_prompt.trim();
    let has_time_signal = re_rule_time().is_match(p);
    let has_version = re_rule_version().is_match(p);
    let urls = extract_prompt_urls(p);
    let mut queries = vec![SearchQuery {
        query: normalized_query_text(p),
        intent: if has_time_signal { Intent::News } else { Intent::General },
        preferred_domains: None,
    }];
    for u in urls.iter().take(3) {
        queries.push(SearchQuery {
            query: u.clone(),
            intent: Intent::General,
            preferred_domains: None,
        });
    }
    SearchGateResult {
        decision: SearchDecision {
            // SEARCH-BY-DEFAULT: the rules fallback always searches.
            search_required: true,
            reason: "rule-based search-by-default plan (main model unreachable)".into(),
            freshness: if has_time_signal {
                Freshness::Day
            } else if has_version {
                Freshness::Month
            } else {
                Freshness::Any
            },
            depth: Depth::Standard,
            queries,
        },
        source: GateSource::Rules,
        gate_ms: 0.0,
    }
}

fn no_search_plan(reason: &str) -> SearchGateResult {
    SearchGateResult {
        decision: SearchDecision {
            search_required: false,
            reason: reason.to_string(),
            freshness: Freshness::None,
            depth: Depth::Quick,
            queries: Vec::new(),
        },
        source: GateSource::Rules,
        gate_ms: 0.0,
    }
}

/// ⇔ `buildFallbackQueries` — minimal keyword-form list; the normalized
/// prompt is unshifted in front of the URL plans.
fn build_fallback_queries(prompt: &str) -> Vec<SearchQuery> {
    let urls = extract_prompt_urls(prompt);
    let mut out: Vec<SearchQuery> = urls
        .iter()
        .take(3)
        .map(|u| SearchQuery {
            query: u.clone(),
            intent: Intent::General,
            preferred_domains: None,
        })
        .collect();
    let has_time_signal = re_rule_time().is_match(prompt);
    out.insert(
        0,
        SearchQuery {
            query: normalized_query_text(prompt),
            intent: if has_time_signal { Intent::News } else { Intent::General },
            preferred_domains: None,
        },
    );
    out
}

/* ── LLM call (main model ONLY) ─────────────────────────────────────── */

const MAIN_GATE_SYSTEM_PROMPT: &str = r#"You are the search router for your own answering pipeline.
SEARCH-BY-DEFAULT POLICY: answer search_required = true for essentially
every real question. The ONLY prompts that get search_required = false are
exactly these two:
  (a) Pure conversational filler / greetings / thanks / assistant chitchat
      ("hi", "hello", "thank you", "which model are you") — no external
      facts are being asked about.
  (b) A completely self-contained offline task (code, math, text
      transformation) where the user supplied 100% of the input AND the
      task mentions zero external brands, websites, people, places,
      products, events, versions, prices, or facts from the world.
If ANY proper noun, brand name, website, product, movie, restaurant,
location, company, person, version number, price, or factual question
appears — including a Blinkit/Myntra/Zepto/BookMyShow/Zomato style
platform name, a local business, or a niche tool — search_required MUST
be true. When in doubt between "I might know" and "I don't know exactly",
ALWAYS search: the user would rather have a verified answer than a
confident guess.

Answer with ONLY valid JSON:
{"search_required": boolean, "reason": string,
 "freshness": "none"|"day"|"week"|"month"|"year"|"any",
 "depth": "quick"|"standard"|"deep",
 "queries": [{"query": string, "intent": "general"|"news"|"docs"|"code"|"academic"|"forum", "preferred_domains"?: string[]}]}

Decision rules (search-first):
- search_required = true for: news, prices, stock/crypto rates, weather,
  sports results, releases, product availability, local places/businesses,
  current events, restaurant menus, movie showtimes, job listings,
  anything about a specific named entity you are not 100% sure of,
  any explicit URL, any follow-up that asks for a LINK/URL or the CURRENT
  availability/stock/price/open-closed status of something in the
  conversation, or details/reviews of an entity you recommended.
- The conversation history is part of the request: resolve "it / this /
  that" against it before deciding.
- A NEW, unrelated chit-chat turn about the ASSISTANT itself (not about
  a world fact) is the only follow-up that may be no-search.

Query rules (only when search_required = true):
- 2-4 queries. KEYWORD FORM, not full sentences. Never paste the user's
  question verbatim; never write a query that is only stopwords or generic
  phrasing.
- Anchor every query on the concrete entities of the request (names,
  numbers, products, places) plus at most one topic word.
- Example good: ["NVIDIA stock price", "NVDA share price today"].
  Example bad: ["What is the minimum number of cuts needed to partition
  the string so that each part is a palindrome"].
- Use the user's exact terminology for proper nouns and version numbers.
- On follow-up turns, anchor every query on the RESOLVED entity name in
  exact quotes: ["Honor 200 5G" site:amazon.in, "Honor 200 5G" price buy
  India] — the site: form when the user or the conversation has named the
  store/platform, the topic form ("price buy", "apply", "reviews open")
  otherwise.
- Set preferred_domains when an authoritative source is obvious.
- freshness = "any" unless the fact is explicitly live (breaking news,
  today's price/weather/score). depth: "quick" single fact, "standard"
  comparison, "deep" multi-source research.
Do NOT add anything else to your output."#;

/// ⇔ the inline `{ role, content }` message shape (locally defined —
/// distinct from `types::HistoryTurn`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn build_main_gate_messages(ctx: &SearchGateContext) -> Vec<ChatMessage> {
    let mut msgs = vec![ChatMessage {
        role: "system".into(),
        content: MAIN_GATE_SYSTEM_PROMPT.into(),
    }];
    if let Some(h) = ctx.history.as_ref() {
        if !h.is_empty() {
            // ⇔ `ctx.history.slice(-4)`
            for m in &h[h.len().saturating_sub(4)..] {
                msgs.push(ChatMessage {
                    role: m.role.clone(),
                    content: utf16_prefix(&m.content, 300),
                });
            }
        }
    }
    let body = utf16_prefix(&ctx.user_prompt, 2000);
    let content = if ctx.has_image_attachment.unwrap_or(false) {
        format!("{body}\n\n(The user also attached an image/screenshot to this message.)")
    } else {
        body
    };
    msgs.push(ChatMessage {
        role: "user".into(),
        content,
    });
    msgs
}

fn strip_and_repair(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // Strip thinking/reasoning blocks — terminated or orphan-truncated.
    static THINK: OnceLock<Regex> = OnceLock::new();
    static FENCE_LEAD: OnceLock<Regex> = OnceLock::new();
    static FENCE_TRAIL: OnceLock<Regex> = OnceLock::new();
    s = THINK
        .get_or_init(|| {
            Regex::new(r"(?i)<(?:think|thinking)>[\s\S]*?(?:</(?:think|thinking)>|$)").unwrap()
        })
        .replace_all(&s, "")
        .into_owned();
    s = FENCE_LEAD
        .get_or_init(|| Regex::new(r"(?i)^```(?:json)?\s*").unwrap())
        .replace(&s, "")
        .into_owned();
    s = FENCE_TRAIL
        .get_or_init(|| Regex::new(r"(?i)```\s*$").unwrap())
        .replace(&s, "")
        .into_owned();
    if let Some(i) = s.find('{') {
        if i > 0 {
            s = s[i..].to_string();
        }
    }
    s
}

/// ⇔ TS `String(x)` coercion for the ??-defaulted scalar fields (see the
/// module-doc divergence note on objects/arrays).
fn js_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn js_opt_string(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(v) => Some(js_to_string(v)),
    }
}

/// Parse the main model's combined verdict+plan. A `search_required:
/// false` answer is a first-class outcome — not a failure. Explicit
/// prompt URLs are still force-added.
fn parse_main_gate_json(raw: &str, ctx: &SearchGateContext) -> Option<SearchDecision> {
    if raw.trim().is_empty() {
        return None;
    }
    for cand in [strip_and_repair(raw), raw.trim().to_string()] {
        let Ok(parsed) = serde_json::from_str::<Value>(&cand) else {
            continue;
        };
        let Some(search_required) = parsed.get("search_required").and_then(Value::as_bool) else {
            continue;
        };

        if !search_required {
            // Search-by-default re-verify: the model may only veto for
            // genuinely self-contained prompts.
            let veto_allowed = !prompt_has_external_entity(&ctx.user_prompt)
                && !(ctx.has_image_attachment.unwrap_or(false)
                    && re_image_lookup_intent().is_match(&ctx.user_prompt));
            if !veto_allowed {
                let urls = extract_prompt_urls(&ctx.user_prompt);
                let mut queries: Vec<SearchQuery> = urls
                    .into_iter()
                    .map(|u| SearchQuery {
                        query: u,
                        intent: Intent::General,
                        preferred_domains: None,
                    })
                    .collect();
                if queries.is_empty() {
                    queries.push(SearchQuery {
                        query: normalized_query_text(&ctx.user_prompt),
                        intent: Intent::General,
                        preferred_domains: None,
                    });
                }
                return Some(SearchDecision {
                    search_required: true,
                    reason: "search-by-default: model veto overturned (external entity present)"
                        .into(),
                    freshness: Freshness::Any,
                    depth: Depth::Standard,
                    queries,
                });
            }
            let reason = js_opt_string(parsed.get("reason"))
                .unwrap_or_else(|| "main model: no live web content needed".into());
            return Some(SearchDecision {
                search_required: false,
                reason: utf16_prefix(&reason, 300),
                freshness: Freshness::None,
                depth: Depth::Quick,
                queries: Vec::new(),
            });
        }

        let mut queries: Vec<SearchQuery> = match parsed.get("queries").and_then(Value::as_array) {
            Some(arr) => arr
                .iter()
                .map(|q| {
                    let query = js_opt_string(q.get("query"))
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    let intent = q
                        .get("intent")
                        .and_then(Value::as_str)
                        .and_then(Intent::known)
                        .unwrap_or(Intent::General);
                    let preferred_domains = q
                        .get("preferred_domains")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().map(js_to_string).collect());
                    SearchQuery {
                        query,
                        intent,
                        preferred_domains,
                    }
                })
                .filter(|q| !q.query.is_empty())
                .collect(),
            None => Vec::new(),
        };

        let urls = extract_prompt_urls(&ctx.user_prompt);
        for u in urls {
            if !queries.iter().any(|q| q.query == u) {
                queries.push(SearchQuery {
                    query: u,
                    intent: Intent::General,
                    preferred_domains: None,
                });
            }
        }
        if queries.is_empty() {
            queries.push(SearchQuery {
                query: normalized_query_text(&ctx.user_prompt),
                intent: Intent::General,
                preferred_domains: None,
            });
        }

        let freshness = js_opt_string(parsed.get("freshness"))
            .and_then(|s| Freshness::known(&s))
            .unwrap_or(Freshness::Any);
        let depth = match parsed.get("depth").and_then(Value::as_str) {
            Some("quick") => Depth::Quick,
            Some("standard") => Depth::Standard,
            Some("deep") => Depth::Deep,
            _ => Depth::Standard,
        };
        let reason = js_opt_string(parsed.get("reason"))
            .unwrap_or_else(|| "main model: live web content needed".into());
        return Some(SearchDecision {
            search_required: true,
            reason: utf16_prefix(&reason, 300),
            freshness,
            depth,
            queries,
        });
    }
    None
}

/// ⇔ TS `mainModelGate` — the ONE authoritative model call. Raw reqwest
/// is required (history turns in `messages`; llm_json cannot carry them)
/// and NO inference slot is registered (matches TS — no
/// registerTitleCall here).
async fn main_model_gate(
    http: &reqwest::Client,
    ctx: &SearchGateContext,
    o: &SearchGateOptions,
) -> Option<SearchDecision> {
    let messages: Vec<Value> = build_main_gate_messages(ctx)
        .into_iter()
        .map(|m| {
            let mut msg = Map::new();
            msg.insert("role".into(), Value::String(m.role));
            msg.insert("content".into(), Value::String(m.content));
            Value::Object(msg)
        })
        .collect();

    let mut body = Map::new();
    body.insert("model".into(), Value::String("default".into()));
    body.insert("messages".into(), Value::Array(messages));
    // JS `temperature: 0` serializes as `0` — integer, NOT 0.0 (unlike
    // llm_json's float default; recorded divergence does not apply here).
    body.insert("temperature".into(), Value::from(0u64));
    // ⇔ `...THINKING_OFF_BODY` (shared with llm_json so both sends carry
    // byte-identical thinking-off flags).
    apply_thinking_off(&mut body);
    let mut thinking = Map::new();
    thinking.insert("type".into(), Value::String("disabled".into()));
    body.insert("thinking".into(), Value::Object(thinking));
    let mut response_format = Map::new();
    response_format.insert("type".into(), Value::String("json_object".into()));
    body.insert("response_format".into(), Value::Object(response_format));
    body.insert("max_tokens".into(), Value::from(MAIN_GATE_MAX_TOKENS));

    // ⇔ AbortSignal.timeout(MAIN_GATE_TIMEOUT_MS) boundes the WHOLE fetch
    // (send + body read), so the timeout wraps both awaits.
    let fut = async {
        let res = http
            .post(&o.endpoint)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", o.api_key))
            .body(serde_json::to_vec(&Value::Object(body)).unwrap_or_default())
            .send()
            .await;
        let res = match res {
            Err(e) => {
                tracing::warn!(err = %e, timeout_ms = MAIN_GATE_TIMEOUT_MS, "gate unreachable / timeout");
                return None;
            }
            Ok(res) => res,
        };
        if !res.status().is_success() {
            tracing::warn!(status = res.status().as_u16(), "gate non-200");
            return None;
        }
        // `await res.json()` — a throw becomes the outer catch ⇒ null.
        let data = match res.bytes().await {
            Ok(b) => serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null),
            Err(e) => {
                tracing::warn!(err = %e, timeout_ms = MAIN_GATE_TIMEOUT_MS, "gate unreachable / timeout");
                return None;
            }
        };
        let msg = data
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|c| c.get("message"))
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new())); // `?? {}`
        let content = msg.get("content").and_then(Value::as_str).unwrap_or("");
        let reasoning = msg
            .get("reasoning_content")
            .and_then(Value::as_str)
            .unwrap_or("");
        Some((content.to_string(), reasoning.to_string()))
    };
    let (content, reasoning) = match tokio::time::timeout(Duration::from_millis(MAIN_GATE_TIMEOUT_MS), fut).await {
        Err(_) => {
            tracing::warn!(err = "timeout", timeout_ms = MAIN_GATE_TIMEOUT_MS, "gate unreachable / timeout");
            return None;
        }
        Ok(None) => return None,
        Ok(Some(pair)) => pair,
    };

    for raw in [content, reasoning] {
        if let Some(decision) = parse_main_gate_json(&raw, ctx) {
            return Some(decision);
        }
    }
    // Silent fallback: the caller routes to rules_based_plan.
    None
}

/// Back-compatible entry point (kept for external callers/exports).
pub async fn call_llm(
    http: &reqwest::Client,
    ctx: &SearchGateContext,
    o: &SearchGateOptions,
) -> Option<SearchDecision> {
    main_model_gate(http, ctx, o).await
}

/* ── public API ───────────────────────────────────────────────────────── */

/// Test/CI escape hatch check — `WEB_SEARCH_GATE_DISABLED` (renamed from
/// `WEB_SEARCH_LFM_DISABLED`, which keeps working).
pub fn gate_disabled_by_env() -> bool {
    std::env::var("WEB_SEARCH_GATE_DISABLED").as_deref() == Ok("1")
        || std::env::var("WEB_SEARCH_LFM_DISABLED").as_deref() == Ok("1")
}

/// THE gate. SEARCH-BY-DEFAULT policy:
/// 0. hard bypass → search, 0 ms, "deterministic".
/// 1. trivial greeting / assistant-identity → no-search, zero tokens.
/// 2. main model verdict, re-verified against `prompt_has_external_entity`.
/// 3. main model unreachable/unparseable → search-by-default rules plan.
pub async fn run_search_gate(
    http: &reqwest::Client,
    ctx: &SearchGateContext,
    o: &SearchGateOptions,
) -> SearchGateResult {
    // Search-by-default override — computed in TS but NEVER read there
    // (dead binding); kept for parity as `_search_by_default`.
    let _search_by_default = !is_trivial_prompt(&ctx.user_prompt);

    // Test / CI escape hatch: skip the network call entirely.
    if o.gate_disabled.unwrap_or_else(gate_disabled_by_env) {
        let plan = match deterministic_hard_bypass(ctx) {
            Some(bypass) => SearchGateResult {
                decision: bypass.decision,
                source: GateSource::Deterministic,
                gate_ms: 0.0,
            },
            None if is_trivial_prompt(&ctx.user_prompt) => no_search_plan(
                "trivial prompt — no web content needed",
            ),
            None => rules_based_plan(ctx),
        };
        tracing::info!(
            prompt = %utf16_prefix(&ctx.user_prompt, 40),
            "search gate disabled → deterministic plan"
        );
        return plan;
    }

    // Stage 0: hard bypass — a literal link / live-intent word never
    // waits on (or loses to) a model verdict. 0 ms, zero tokens.
    if let Some(bypass) = deterministic_hard_bypass(ctx) {
        tracing::info!(
            matched = ?bypass.hit.matched,
            prompt = %utf16_prefix(&ctx.user_prompt, 60),
            "search gate STAGE 0 hard bypass → search"
        );
        return SearchGateResult {
            decision: bypass.decision,
            source: GateSource::Deterministic,
            gate_ms: 0.0,
        };
    }

    // Fast path: trivial prompt → no LLM call, zero tokens.
    if is_trivial_prompt(&ctx.user_prompt) {
        tracing::info!(
            prompt = %utf16_prefix(&ctx.user_prompt, 40),
            "trivial prompt → skip (no search, zero latency)"
        );
        return no_search_plan("trivial prompt — no web content needed");
    }

    let t0 = Instant::now();
    let main = main_model_gate(http, ctx, o).await;
    if let Some(main) = main {
        let mut decision = main;
        // Search-by-default re-verify: a model "no" only holds when the
        // prompt is truly self-contained.
        let overrode = !decision.search_required && prompt_has_external_entity(&ctx.user_prompt);
        if overrode {
            let queries = if !decision.queries.is_empty() {
                decision.queries.clone()
            } else {
                build_fallback_queries(&ctx.user_prompt)
            };
            decision.search_required = true;
            decision.reason =
                "search-by-default: external entity in prompt — search even though the model vetoed"
                    .into();
            decision.depth = Depth::Standard;
            decision.queries = queries;
        }
        let out = SearchGateResult {
            decision,
            source: GateSource::MainModel,
            gate_ms: (t0.elapsed().as_secs_f64() * 1000.0).round(),
        };
        tracing::info!(
            source = ?out.source,
            search_required = out.decision.search_required,
            gate_ms = out.gate_ms,
            overridden = overrode,
            "search gate verdict (main model)"
        );
        return out;
    }

    // Main model failed → SEARCH-BY-DEFAULT rules plan, never no-search.
    tracing::warn!(
        prompt = %utf16_prefix(&ctx.user_prompt, 80),
        gate_ms = (t0.elapsed().as_secs_f64() * 1000.0).round(),
        "main model unreachable — search-by-default rules plan"
    );
    rules_based_plan(ctx)
}

/// Regression-test surface: the main-gate messages are exported so tests
/// can assert on what the classifier actually sees.
pub fn build_main_gate_messages_for_test(ctx: &SearchGateContext) -> Vec<ChatMessage> {
    build_main_gate_messages(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(prompt: &str) -> SearchGateContext {
        SearchGateContext {
            user_prompt: prompt.into(),
            history: None,
            has_image_attachment: None,
            image_data_urls: None,
        }
    }

    fn opts(gate_disabled: bool) -> SearchGateOptions {
        SearchGateOptions {
            // Unroutable — nothing listens on :9 (parity with llm_json
            // tests; the gate must never touch a real server here).
            endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
            api_key: "test-key".into(),
            gate_disabled: Some(gate_disabled),
        }
    }

    #[test]
    fn trivial_matrix() {
        assert!(is_trivial_prompt("hi"));
        assert!(is_trivial_prompt("  Hello!!  "));
        assert!(is_trivial_prompt("By the way which model are you"));
        assert!(is_trivial_prompt("thank you …"));
        // filler peel must re-match the EXACT list — "hey there" peels to
        // "there" (not in the list) ⇒ not trivial
        assert!(!is_trivial_prompt("hey there"));
        assert!(!is_trivial_prompt("what is the weather"));
    }

    #[test]
    fn bypass_url_builds_keyword_then_url_queries() {
        let r = deterministic_hard_bypass(&ctx("check https://example.com now")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::Url);
        assert!(r.decision.search_required);
        assert_eq!(r.decision.reason, "deterministic_url_or_intent");
        assert_eq!(r.decision.depth, Depth::Deep);
        assert_eq!(r.decision.freshness, Freshness::Any);
        assert_eq!(r.decision.queries[0].query, "check now");
        assert_eq!(r.decision.queries[1].query, "https://example.com");
    }

    #[test]
    fn bypass_web_intent_and_image_intent() {
        let r = deterministic_hard_bypass(&ctx("look up the weather in Portland Oregon")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::WebIntent);
        assert!(r.hit.detected.is_empty());
        assert_eq!(r.decision.depth, Depth::Standard);
        // filler strips "look"/"up"/"the"/"in" (filler list, verbatim)
        assert_eq!(r.decision.queries[0].query, "weather portland oregon");

        let mut c = ctx("who is this guy");
        c.has_image_attachment = Some(true);
        let r = deterministic_hard_bypass(&c).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::ImageIntent);

        // no attachment ⇒ the same words are NOT an image bypass
        assert!(deterministic_hard_bypass(&ctx("who is this guy")).is_none());
        assert!(deterministic_hard_bypass(&ctx("what is 2+2")).is_none());
    }

    #[test]
    fn bypass_newsy_becomes_week() {
        let r = deterministic_hard_bypass(&ctx("who won the champions final 2026")).unwrap();
        assert_eq!(r.decision.freshness, Freshness::Week);
    }

    #[test]
    fn external_entity_matrix() {
        // "NVIDIA stock" is FALSE in TS too — all-caps brand matches
        // neither proper-noun pattern (no digits, no lowercase tail);
        // pinned as a TS quirk.
        assert!(!prompt_has_external_entity("NVIDIA stock"));
        assert!(prompt_has_external_entity("fix v1.2.3 regression"));
        assert!(prompt_has_external_entity("RTX 4090 review"));
        assert!(prompt_has_external_entity("the quick Brown fox jumps"));
        assert!(prompt_has_external_entity("need 2026 dates"));
        assert!(prompt_has_external_entity("visit https://skiran.dev now"));
        assert!(!prompt_has_external_entity("hello there friend"));
        assert!(!prompt_has_external_entity("   "));
    }

    #[test]
    fn rules_plan_always_searches() {
        let r = rules_based_plan(&ctx("latest news on react 18.2 release"));
        assert!(r.decision.search_required);
        assert_eq!(r.source, GateSource::Rules);
        assert_eq!(r.gate_ms, 0.0);
        assert_eq!(r.decision.freshness, Freshness::Day);
        assert_eq!(r.decision.queries[0].intent, Intent::News);
        assert_eq!(r.decision.queries[0].query, "latest news on react 18.2 release");

        let r = rules_based_plan(&ctx("explain recursion simply"));
        assert_eq!(r.decision.freshness, Freshness::Any);
        assert_eq!(r.decision.queries[0].intent, Intent::General);
    }

    #[test]
    fn gate_messages_cap_history_and_prompt() {
        let mut c = ctx(&"x".repeat(2500));
        c.history = Some((0..6).map(|i| crate::types::HistoryTurn { role: "user".into(), content: format!("{i}{}", "y".repeat(400)) }).collect());
        c.has_image_attachment = Some(true);
        let msgs = build_main_gate_messages_for_test(&c);
        assert_eq!(msgs.len(), 6); // system + last-4 history + user
        assert_eq!(msgs[1].content.chars().count(), 300); // history content sliced 300
        assert!(msgs[1].content.starts_with("2")); // slice(-4) kept turns 2..5
        assert_eq!(msgs[5].role, "user");
        assert!(msgs[5].content.ends_with("(The user also attached an image/screenshot to this message.)"));
        assert_eq!(msgs[5].content.chars().count(), 2000 + "\n\n(The user also attached an image/screenshot to this message.)".chars().count());
    }

    #[test]
    fn parse_json_true_decision() {
        let raw = "Sure! {\"search_required\": true, \"reason\": \"need live\", \"freshness\": \"bogus\", \"depth\": \"deep\", \"queries\": [{\"query\": \"   \", \"intent\": \"news\"}, {\"query\": \"NVIDIA stock\", \"intent\": \"bogus\"}, {\"query\": 5, \"intent\": \"general\"}]}";
        let d = parse_main_gate_json(raw, &ctx("plain question here")).unwrap();
        assert!(d.search_required);
        assert_eq!(d.reason, "need live");
        assert_eq!(d.freshness, Freshness::Any); // whitelist miss → any
        assert_eq!(d.depth, Depth::Deep);
        // blank filtered; bogus intent → general; numeric query coerced "5"
        assert_eq!(d.queries.len(), 2);
        assert_eq!(d.queries[0].query, "NVIDIA stock");
        assert_eq!(d.queries[0].intent, Intent::General);
        assert_eq!(d.queries[1].query, "5");
    }

    #[test]
    fn parse_json_false_veto_overturned_when_entity_present() {
        let raw = "```json\n{\"search_required\": false, \"reason\": \"i know this\"}\n```";
        let d = parse_main_gate_json(raw, &ctx("prices in Mumbai this week")).unwrap();
        assert!(d.search_required);
        assert_eq!(
            d.reason,
            "search-by-default: model veto overturned (external entity present)"
        );
        assert_eq!(d.depth, Depth::Standard);
        assert_eq!(d.queries[0].query, "prices in Mumbai this week");
    }

    #[test]
    fn parse_json_false_honored_when_self_contained() {
        let raw = "{\"search_required\": false, \"reason\": 42}";
        let d = parse_main_gate_json(raw, &ctx("write a reverse string function")).unwrap();
        assert!(!d.search_required);
        assert_eq!(d.reason, "42"); // String(number) coercion, verbatim
        assert_eq!(d.freshness, Freshness::None);
        assert_eq!(d.depth, Depth::Quick);
        assert!(d.queries.is_empty());
    }

    #[test]
    fn parse_json_garbage_returns_none() {
        assert!(parse_main_gate_json("", &ctx("x")).is_none());
        assert!(parse_main_gate_json("   ", &ctx("x")).is_none());
        assert!(parse_main_gate_json("not json at all", &ctx("x")).is_none());
        assert!(parse_main_gate_json("{\"search_required\": \"yes\"}", &ctx("x")).is_none());
    }

    #[tokio::test]
    async fn run_gate_disabled_uses_deterministic_and_rules() {
        let http = reqwest::Client::new();
        let r = run_search_gate(&http, &ctx("open https://skiran.dev now"), &opts(true)).await;
        assert_eq!(r.source, GateSource::Deterministic);
        assert_eq!(r.decision.reason, "deterministic_url_or_intent");

        let r = run_search_gate(&http, &ctx("thanks"), &opts(true)).await;
        assert_eq!(r.source, GateSource::Rules);
        assert!(!r.decision.search_required);
        assert_eq!(r.decision.freshness, Freshness::None);
        assert_eq!(r.decision.depth, Depth::Quick);

        let r = run_search_gate(&http, &ctx("how do I structure a monorepo build"), &opts(true)).await;
        assert!(r.decision.search_required);
        assert_eq!(r.source, GateSource::Rules);
    }

    #[tokio::test]
    async fn run_gate_unreachable_model_falls_back_to_rules() {
        let http = reqwest::Client::new();
        let r = run_search_gate(
            &http,
            &ctx("how do I structure a monorepo build"),
            &opts(false),
        )
        .await;
        assert_eq!(r.source, GateSource::Rules);
        assert!(r.decision.search_required);
        assert_eq!(
            r.decision.reason,
            "rule-based search-by-default plan (main model unreachable)"
        );
    }

    #[tokio::test]
    async fn call_llm_unreachable_returns_none() {
        assert!(call_llm(&reqwest::Client::new(), &ctx("hello friend"), &opts(false)).await.is_none());
    }
}
