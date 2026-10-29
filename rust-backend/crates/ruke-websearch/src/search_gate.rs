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

/// Part-10 UNIVERSAL pre-gate refinement (APPROVED PART-10 DEVIATION):
/// the BARE `search` token is gone — it force-YESed codegen prompts like
/// "Write Python code for binary search." and made the engine pool search
/// the user's own instruction (the bug class this part retires). Only an
/// explicit web-search frame ("search the web/online/internet", "web/
/// google search") force-YESes here; a bare "search for X" now reaches
/// the model gate, whose explicit-search rule still answers YES. TS
/// `WEB_INTENT_RE` mirrors this body byte-identically (minus (?-u:)
/// scoping); web.test.ts goldens contain no "search"-shaped prompts, so
/// recorded bytes are unaffected.
fn re_web_intent() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b(?:watch|video|location|maps|linkedin|reddit|latest|current|today|price|jobs|hiring|20(?:2[4-9]))\b)|(?-u:\bsearch(?:es|ing|ed)?\s+(?:the\s+)?(?:web|internet|online)\b)|(?-u:\b(?:web|google|internet)\s+search(?:es|ing)?\b)|(?-u:\blook)\s?(?-u:up\b)|(?-u:\bwho)\s+(?-u:won\b))",
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

/// Part-10 APPROVED DEVIATION — the attachment-aware escape hatch. A turn
/// with attachment evidence is suppressed ONLY when it shows no sign of
/// wanting live-web/current/external information. This broader phrase list
/// is consulted ONLY when attachment evidence is present, so non-attachment
/// turns keep byte-identical parity behavior via the narrow
/// `re_web_intent` above. Word-boundary phrases only: "research" never
/// matches through "search", "renew" never through "news".
fn re_explicit_web_intent() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b(?:website|web|browse|online|internet|google|news|recent|recently|newest|currently|fact(?:\s|-)+check)\b|(?-u:\blook\s?online\b)|(?-u:\bup[\s-]?to[\s-]?date\b)|(?-u:\bstill\s+(?:true|accurate|valid|current|available)\b))"
        )
        .unwrap()
    })
}

/* ── universal search pre-gate regexes (APPROVED PART-10 DEVIATION) ──── */

/// Layer 2 — high-confidence freshness / time-sensitive → FORCE SEARCH.
/// Deliberately NARROW and phrase-anchored: only staleness-prone shapes
/// the model must never be allowed to veto; the gray middle stays with
/// the (date-aware) model gate. Office-holder nouns only match inside
/// the "who is/are the …" frame; overlap with `re_web_intent`'s narrow
/// words is harmless (that arm already force-YESes first).
fn re_freshness() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b(?:currently|weather|forecast)\b)|(?:(?-u:\bhow\s+much\b)[^.!?]{0,40}?(?:(?-u:\bcosts?\b)|(?-u:\bprice\b)|(?-u:\bworth\b)))|(?-u:\bthis\s+(?:week|month|year)\b)|(?-u:\bmost\s+recent\b)|(?-u:\bas\s+of\s+now\b)|(?-u:\bup[\s-]?to[\s-]?date\b)|(?-u:\bstill\s+(?:supported|available|maintained|true|accurate|valid|current)\b)|(?-u:\bwho\s+(?:is|are)\s+the\s+(?:ceo|president|mayor|governor|chairman|director|coach|captain)\b)|(?-u:\b(?:current|latest)\s+(?:version|release)\b))"
        )
        .unwrap()
    })
}

/// Layer 1a — the user EXPLICITLY scoped the turn to local evidence.
/// NOTE: this regex intentionally contains "web" ("do not search the
/// web"), so unlike every other force-NO it gets NO escape-hatch check —
/// any escape would self-cancel the rule.
fn re_local_only() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b(?:do not|don't|dont|no)\s+(?:web\s+)?(?:search|browsing?|googling?|looking\s+online)\b)|(?-u:\bwithout\s+(?:searching|browsing)\b)|(?-u:\b(?:only|just)\s+(?:from|based on|using)\s+(?:the\s+)?(?:attached|provided|supplied|uploaded|pasted|given)\b)|(?-u:\b(?:answer|respond|reply)\s+based on\s+(?:the\s+)?(?:attached|provided|supplied|uploaded|pasted|given)\b)|(?-u:\banswer\s+(?:only|strictly)\s+from\b)|(?-u:\buse\s+only\s+the\s+attached\b)|(?-u:\bnothing\s+else\b))"
        )
        .unwrap()
    })
}

/// Layer 1b — a verb that transforms content the user SUPPLIED, within
/// one sentence (no clause punctuation crossed). The demonstrative must
/// be followed (still inside the sentence) by an artifact noun, so
/// "Review this year's finals" never skips — freshness intent wins.
fn re_supplied_task() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?:(?-u:\b(?:summar(?:y|ize|ise)|translat(?:e|ion)|rewrite|paraphrase|shorten|proofread|fix|correct|review|refactor|debug|annotate|explain|clarify|improve|convert|extract|listen|hear)\b)[^.!?]{0,25}?(?-u:\b(?:this|these|my|attached|supplied|uploaded|pasted|provided)\b)[^.!?]{0,20}?(?-u:\b(?:code|file|text|log|logs|pdf|doc|docs|document|documents|paragraph|snippet|function|screenshot|image|essay|article|script|trace|error|message|conversation|table|data|json|csv|resume|letter|contract|draft|passage|chat|audio|video|recording|clip|footage|transcript|voice|speech)\b))|(?-u:\bwhat(?:'s|\s+is)\s+wrong\s+with\b)|(?-u:\bfind\s+the\s+(?:bug|issue|problem)\s+in\b)|(?-u:\bread\s+(?:this|the|an?)\s+(?:attached\s+)?(?:file|code|text|log|pdf|attachment|audio|video|recording|clip|transcript)\b))"
        )
        .unwrap()
    })
}

/// Layer 1b — code-writing tasks fully defined by the prompt itself.
/// Live-intent words (price/latest/…) are already force-YESed upstream,
/// so a codegen-shaped prompt asking for CURRENT facts cannot skip here.
fn re_codegen() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b(?:write|create|generate|give me|produce|implement)\b)[^.!?]{0,30}?(?-u:\b(?:code|function|component|script|program|class|regex|sql|hook|snippet|unit tests?)\b))"
        )
        .unwrap()
    })
}

/// Layer 1b — pure arithmetic ("what is 15 * 17?", "solve 25 * 47").
fn re_math() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b(?:what(?:'s|\s+is)|solve|calculate|compute)\b)[^.!?]{0,12}?\d+\s*[-+*/xX]\s*\d+)"
        )
        .unwrap()
    })
}

/// §11.2 follow-up (APPROVED DEVIATION extension) — attachment
/// self-references must not masquerade as external-media web intent: the
/// narrow `video` token in `re_web_intent` force-YESed "Read the text
/// burned into the attached video …" even though that media IS the user's
/// own attached file. These regexes strip self-refs BEFORE the web-intent
/// arm ONLY (the freshness arm and the query planner still see the FULL
/// prompt, so hybrid turns keep force-YES — freshness never loses):
///   re_media_self_ref — unconditional: an explicit "attached/uploaded/
///     pasted/provided/supplied + media noun" phrase is a self-reference
///     wherever it appears;
///   re_attach_anaphora — pronoun anaphora ("this/the/my video"), stripped
///     ONLY when the turn carries local attachment evidence, so a
///     no-attachment "watch this video on youtube" keeps its web intent.
/// ⇔ TS MEDIA_SELF_REF_RE_G / ATTACH_ANAPHORA_RE_G / webIntentProbe.
fn re_media_self_ref() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b(?:attached|attachment|uploaded|pasted|provided|supplied)\s+(?:[a-z]+\s+){0,2}?(?:audio|video|recording|clip|footage|image|photo|picture|screenshot|pdf|doc(?:ument)?|file|transcript|log|code)\b))"
        )
        .unwrap()
    })
}

fn re_attach_anaphora() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b(?:this|these|my|the)\s+(?:audio|video|recording|clip|footage|image|photo|picture|screenshot|pdf|doc(?:ument)?|file|transcript|log|code)\b))"
        )
        .unwrap()
    })
}

/// Web-intent probe body (see above). replace_all ⇔ TS global replace.
fn web_intent_probe(prompt: &str, has_local_artifact: bool) -> String {
    let mut s = re_media_self_ref().replace_all(prompt, " ").into_owned();
    if has_local_artifact {
        s = re_attach_anaphora().replace_all(&s, " ").into_owned();
    }
    s
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
    /// Part-10 APPROVED DEVIATION (universal search pre-gate, layer 2):
    /// a high-confidence freshness / time-sensitive request — force-YES,
    /// the model never gets veto power over it (⇔ TS `"freshness"`).
    Freshness,
    /// Part-10 APPROVED DEVIATION (attachment-aware gate): the current
    /// turn carries attachment evidence and shows no explicit web intent
    /// (⇔ TS `"attachment_evidence"`).
    AttachmentEvidence,
    /// Part-10 APPROVED DEVIATION (universal search pre-gate, layer 1):
    /// an explicitly local-only turn or an obviously self-contained task
    /// (supplied-content transform / prompt-defined codegen / pure math)
    /// — force-NO with zero queries (⇔ TS `"local_task"`).
    LocalTask,
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

/// The shared force-NO decision for both deterministic local-task layers
/// (explicit local-only intent and self-contained tasks). Structurally
/// guarantees ZERO queries — an operational instruction can never become
/// an engine query from the skip path.
fn local_task_decision() -> SearchDecision {
    SearchDecision {
        search_required: false,
        reason: "deterministic_self_contained".into(),
        freshness: Freshness::Any,
        depth: Depth::Standard,
        queries: vec![],
    }
}

pub fn deterministic_hard_bypass(ctx: &SearchGateContext) -> Option<HardBypassResult> {
    let p = ctx.user_prompt.trim();
    if p.is_empty() {
        return None;
    }

    let detected = detect_urls_and_domains(p, true);
    // Universal policy layer 1a is evaluated AHEAD of the narrow
    // live-intent arm, because the word "search" inside a NEGATION
    // ("do not search the web") must not force a search. The §2
    // tiebreak — freshness never loses — is enforced two ways: the
    // freshness arm below fires on the full prompt, and a turn only
    // counts as deterministically local-only when NO live/freshness
    // intent survives OUTSIDE the negation phrases themselves
    // (residual re-test with the local-only matches stripped out).
    let local_artifact = ctx.has_attachment_evidence.unwrap_or(false);
    let local_only_holds = re_local_only().is_match(p) && {
        let residual = re_local_only().replace_all(p, " ").into_owned();
        !(re_web_intent().is_match(&web_intent_probe(&residual, local_artifact))
            || re_freshness().is_match(&residual))
    };
    let matched = if !detected.is_empty() {
        BypassMatched::Url
    } else if re_freshness().is_match(p) {
        // Universal policy layer 2 (APPROVED PART-10 DEVIATION): a high-
        // confidence freshness / time-sensitive request forces a SEARCH —
        // the model gate never gets veto power over it. It flows into the
        // shared keyword/URL planner below and `re_newsy` still sets
        // week-vs-any exactly as before. Placed AHEAD of every force-NO
        // layer, so a contradictory prompt ("don't search — what's the
        // latest version?") still searches: freshness never loses.
        BypassMatched::Freshness
    } else if local_only_holds {
        // Universal policy layer 1a (APPROVED PART-10 DEVIATION): the user
        // EXPLICITLY scoped the turn to local evidence ("do not search",
        // "answer only from the attached/pasted …"). Deliberately gets NO
        // escape-hatch check: the phrase list contains "web" itself
        // ("do not search the web"), so any escape test would self-cancel
        // — the residual re-test above is the guarded equivalent.
        return Some(HardBypassResult {
            hit: HardBypassHit { matched: BypassMatched::LocalTask, detected: vec![] },
            decision: local_task_decision(),
        });
    } else if re_web_intent().is_match(&web_intent_probe(p, local_artifact)) {
        BypassMatched::WebIntent
    } else if ctx.has_image_attachment.unwrap_or(false) && re_image_lookup_intent().is_match(p) {
        BypassMatched::ImageIntent
    } else if ctx.has_attachment_evidence.unwrap_or(false) {
        // Part-10 APPROVED DEVIATION (attachment-aware gate): the current
        // turn already carries local attachment evidence, so a file-grounded
        // instruction must never wait on — or lose to — a probabilistic
        // model verdict that web-searches the instruction itself. Explicit
        // web/current/external intent falls through to the normal gate
        // (hybrid turns keep web research); anything else is a forced NO:
        // 0 ms, zero tokens, no LLM gate / planner / engines / extractor /
        // browser touch, and NO queries — a meta-instruction can never
        // become an engine query from this path.
        if re_explicit_web_intent().is_match(p) {
            return None;
        }
        return Some(HardBypassResult {
            hit: HardBypassHit { matched: BypassMatched::AttachmentEvidence, detected: vec![] },
            decision: SearchDecision {
                search_required: false,
                reason: "deterministic_attachment_local".into(),
                freshness: Freshness::Any,
                depth: Depth::Standard,
                queries: vec![],
            },
        });
    } else if re_supplied_task().is_match(p) || re_codegen().is_match(p) || re_math().is_match(p) {
        // Universal policy layer 1b (APPROVED PART-10 DEVIATION): an
        // obviously self-contained task — transforming content the user
        // supplied, code-gen the prompt already defines, or pure math —
        // is a deterministic NO with NO attachment required (the rule is
        // universal). The attachment escape-hatch list guards this layer
        // too: any hint of live-web/external intent falls through to the
        // model gate instead.
        if re_explicit_web_intent().is_match(p) {
            return None;
        }
        return Some(HardBypassResult {
            hit: HardBypassHit { matched: BypassMatched::LocalTask, detected: vec![] },
            decision: local_task_decision(),
        });
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
Your parametric knowledge may be STALE. Use the current date at the top of
this message when interpreting words such as latest, current, today,
recent, this year, newest, supported, available, price, version, office
holder, release, schedule, law, regulation, or status — and whenever you
decide whether a fact may have changed since your training.

DECISION STANDARD: ask "Does answering this accurately REQUIRE information
outside the conversation and local evidence that may be current, changing,
or unknown?" — NOT "could web search possibly help?".

Search when:
- the answer depends on facts that may have changed since training
  (versions, releases, prices, office holders, laws, regulations,
  schedules, availability, status, news, sports results);
- external verification materially affects correctness;
- the user explicitly asks to search, fact-check, or verify.

Do NOT search when:
- the task transforms content the user provided (summarize, translate,
  rewrite, proofread, shorten, explain, review, or fix supplied code,
  logs, or text);
- it is ordinary writing, generic coding the prompt already defines, or
  pure math;
- debugging follows from code, logs, or attachments the user supplied;
- the question concerns an established concept, definition, or how-to
  whose answer does not change;
- the conversation or an attached document already supplies the evidence.

For genuinely ambiguous middle cases: if the answer could plausibly have
changed since training, search; otherwise answer without searching.

Answer with ONLY valid JSON:
{"search_required": boolean, "reason": string,
 "freshness": "none"|"day"|"week"|"month"|"year"|"any",
 "depth": "quick"|"standard"|"deep",
 "queries": [{"query": string, "intent": "general"|"news"|"docs"|"code"|"academic"|"forum", "preferred_domains"?: string[]}]}

Query rules (only when search_required = true):
- 2-4 queries. KEYWORD FORM, not full sentences. Never paste the user's
  question or an operational instruction (e.g. "read this file and reply
  YES") as a query; never write a query that is only stopwords or generic
  phrasing.
- Anchor every query on the concrete entities of the request (names,
  numbers, products, places) plus at most one topic word.
- Example good: ["NVIDIA stock price", "NVDA share price today"].
  Example bad: ["What is the minimum number of cuts needed to partition
  the string so that each part is a palindrome"].
- Use the user's exact terminology for proper nouns and version numbers.
- Prefer official/primary sources: when the authoritative source is
  obvious for a version, release, doc set, price, or office-holder fact,
  set preferred_domains to it (e.g. oracle.com, openjdk.org, nodejs.org,
  python.org, official project docs or repositories).
- freshness: "day" for same-day facts, "week"/"month"/"year" when the
  fact is time-scoped, "any" otherwise; "none" only with
  search_required = false.
- depth: "quick" single fact, "standard" comparison, "deep" multi-source
  research.
Do NOT add anything else to your output."#;

/// ⇔ the inline `{ role, content }` message shape (locally defined —
/// distinct from `types::HistoryTurn`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Part-10 (universal search pre-gate): the date the gate reasons about.
/// NEVER hardcoded — tests inject `current_date` so they never depend on
/// the wall clock; production always falls back to the real runtime clock
/// so staleness questions ("is X still supported?") are judged against the
/// actual present. Mirrors the TS `gateCurrentDate`.
fn gate_current_date(ctx: &SearchGateContext) -> String {
    match ctx.current_date.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => chrono::Utc::now().format("%Y-%m-%d").to_string(),
    }
}

fn build_main_gate_messages(ctx: &SearchGateContext) -> Vec<ChatMessage> {
    let date = gate_current_date(ctx);
    let year: String = date.chars().take(4).collect();
    let mut msgs = vec![ChatMessage {
        role: "system".into(),
        content: format!("Current date: {date} (year {year}).\n{MAIN_GATE_SYSTEM_PROMPT}"),
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

/// THE gate. Three-layer decision policy (universal deterministic
/// pre-gate + model-owned gray middle — APPROVED PART-10 DEVIATION):
/// 0. hard bypass → force-YES (URL / live intent / obvious freshness) or
///    force-NO (attachment-local turn, explicit local-only intent,
///    self-contained task), 0 ms, "deterministic".
/// 1. trivial greeting / assistant-identity → no-search, zero tokens.
/// 2. main model decides the ambiguous middle (date-aware prompt),
///    re-verified against `prompt_has_external_entity`.
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
            search_required = bypass.decision.search_required,
            prompt = %utf16_prefix(&ctx.user_prompt, 60),
            "search gate STAGE 0 hard bypass"
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
            has_attachment_evidence: None,
            current_date: None,
            image_data_urls: None,
        }
    }

    /// Part-10 approved deviation: same ctx with attachment evidence on.
    fn att_ctx(prompt: &str) -> SearchGateContext {
        let mut c = ctx(prompt);
        c.has_attachment_evidence = Some(true);
        c
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
        // "weather" now force-YESes via the universal freshness layer
        // (it fires AHEAD of re_web_intent's "look up"); the downstream
        // decision bytes (reason/freshness/depth/queries) are identical.
        assert_eq!(r.hit.matched, BypassMatched::Freshness);
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
        // Part-10 universal pre-gate: pure math is now a deterministic
        // self-contained skip (layer 1b) — it used to fall through.
        let r = deterministic_hard_bypass(&ctx("what is 2+2")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::LocalTask);
        assert!(!r.decision.search_required);
        assert_eq!(r.decision.reason, "deterministic_self_contained");
        assert!(r.decision.queries.is_empty());
    }

    #[test]
    fn bypass_newsy_becomes_week() {
        let r = deterministic_hard_bypass(&ctx("who won the champions final 2026")).unwrap();
        assert_eq!(r.decision.freshness, Freshness::Week);
    }

    /* ── Part-10 approved deviation: attachment-aware gate ───────────── */

    #[test]
    fn bypass_attachment_evidence_forces_no_search() {
        // Local/file-grounded tasks: deterministic NO, zero queries — the
        // meta-instruction NEVER becomes an engine query.
        for p in [
            "Read the attached file and reply YES if you can read it.",
            "Summarize this PDF.",
            "What does this file say about quarterly revenue?",
            "Find the bug in this attached source file.",
            "Explain this screenshot.",
        ] {
            let r = deterministic_hard_bypass(&att_ctx(p)).unwrap_or_else(|| panic!("{p}"));
            assert_eq!(r.hit.matched, BypassMatched::AttachmentEvidence);
            assert!(!r.decision.search_required);
            assert_eq!(r.decision.reason, "deterministic_attachment_local");
            assert!(r.hit.detected.is_empty());
            assert!(r.decision.queries.is_empty(), "{p} generated queries");
        }
        // Part-10 UNIVERSAL pre-gate: the same words WITHOUT an attachment
        // are now a deterministic self-contained skip (layer 1b) — the
        // rule is no longer attachment-only, so it is NOT inert here.
        let r = deterministic_hard_bypass(&ctx("Summarize this PDF.")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::LocalTask);
        assert!(!r.decision.search_required);
        assert_eq!(r.decision.reason, "deterministic_self_contained");
        let mut off = ctx("Summarize this PDF.");
        off.has_attachment_evidence = Some(false);
        let r = deterministic_hard_bypass(&off).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::LocalTask);
    }

    #[test]
    fn bypass_attachment_escape_hatch_never_suppresses() {
        // URL detector outranks the rule.
        let r = deterministic_hard_bypass(&att_ctx("Compare this file with https://example.com"))
            .unwrap();
        assert_eq!(r.hit.matched, BypassMatched::Url);
        assert!(r.decision.search_required);
        // Narrow live-intent words force-YES AHEAD of the attachment rule.
        // ("still current" now lands on the FRESHNESS arm below — same
        // force-YES verdict, different matched label: the freshness layer
        // fires ahead of re_web_intent, "freshness never loses".)
        for p in [
            "Compare this PDF with the latest regulations.",
            "Search the web and fact-check this document.",
            "Read this document and find the latest information about the company.",
            "Compare this resume against current job listings.",
        ] {
            let r = deterministic_hard_bypass(&att_ctx(p)).unwrap_or_else(|| panic!("{p}"));
            assert_eq!(r.hit.matched, BypassMatched::WebIntent, "{p}");
            assert!(r.decision.search_required);
        }
        // Broader hybrid phrasing is NEVER suppressed (never reaches the
        // attachment rule). High-confidence freshness wording ("still
        // accurate/true/current") is now force-YESed by layer 2 AHEAD of
        // the attachment escape — a staleness question about a document
        // must search deterministically; the model cannot veto it either
        // way.
        for p in [
            "Is this information still current?",
            "Check whether the claims in this PDF are still accurate online.",
            "Is the information in this document still true?",
        ] {
            let r = deterministic_hard_bypass(&att_ctx(p)).unwrap_or_else(|| panic!("{p}"));
            assert_eq!(r.hit.matched, BypassMatched::Freshness, "{p}");
            assert!(r.decision.search_required, "{p}");
        }
        // Remaining hybrid phrasing falls through to the NORMAL gate —
        // the model planner still owns those turns.
        for p in [
            "Browse the web and verify this attached document.",
            "Find recent sources supporting this file.",
            "Look online for news about the uploaded article.",
        ] {
            assert!(
                deterministic_hard_bypass(&att_ctx(p)).is_none(),
                "{p} must reach the normal gate"
            );
        }
        // Boundary law: "research" must NOT count through "search".
        let r = deterministic_hard_bypass(&att_ctx("Research this file and rewrite it professionally.")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::AttachmentEvidence);
        assert!(!r.decision.search_required);
    }

    #[test]
    fn bypass_media_self_reference_never_masquerades_as_web_intent() {
        // §11.2 follow-up (user-reported): with an UNINDEXED (inline)
        // attachment there is no attachment_ref, so the chat pipeline now
        // ORs the inline "Attached file:" part into the gate flag — but
        // the guards themselves are UNIVERSAL (flag-free): the self-ref
        // probe and the "…, nothing else." E1 clause.

        // (a) The exact user-reported audio meta-prompt: even with NO
        //     flag at all the nothing-else fingerprint force-SKIPs it —
        //     it can never reach the model gate or an engine query.
        let heard = "Listen to the attached audio and reply with exactly YES followed by the codeword that is spoken, or NO if you cannot hear it. Nothing else.";
        let r = deterministic_hard_bypass(&ctx(heard)).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::LocalTask);
        assert!(!r.decision.search_required);
        assert_eq!(r.decision.reason, "deterministic_self_contained");
        assert!(r.decision.queries.is_empty(), "meta-instruction became a query");
        // Flag on (inline audio turn): still a deterministic NO — the
        // web-intent probe strips "attached audio" before `video`-class
        // narrow tokens can fire.
        let r = deterministic_hard_bypass(&att_ctx(heard)).unwrap();
        assert!(!r.decision.search_required);
        assert!(r.decision.queries.is_empty());

        // (b) Burned-text video: the narrow `video` token no longer
        //     force-YESes through a self-reference. Flag ⇒ attachment
        //     force-NO; no flag ⇒ the read-the-(attached-)video supplied
        //     arm force-NOs.
        let burned = "Read the text burned into the attached video. Reply with exactly what you see.";
        let r = deterministic_hard_bypass(&att_ctx(burned)).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::AttachmentEvidence);
        assert!(!r.decision.search_required);
        let r = deterministic_hard_bypass(&ctx(burned)).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::LocalTask);

        // (c) GENUINE external media intent survives every strip:
        //     un-anchored media nouns and hybrid live-intent words.
        let r = deterministic_hard_bypass(&ctx("watch this video on youtube")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::WebIntent);
        assert!(r.decision.search_required);
        let r = deterministic_hard_bypass(&ctx("search for a video about the keynote")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::WebIntent);
        // Flag on: "attached video" is stripped but `watch` and
        // `latest`/`search the web` are not — hybrid turns keep force-YES.
        let r = deterministic_hard_bypass(&att_ctx(
            "Watch the attached video and search the web for the latest news about the actor.",
        ))
        .unwrap();
        assert_eq!(r.hit.matched, BypassMatched::WebIntent);
        let r = deterministic_hard_bypass(&att_ctx(
            "Compare this audio recording with the latest field recordings.",
        ))
        .unwrap();
        assert_eq!(r.hit.matched, BypassMatched::WebIntent);
        let r = deterministic_hard_bypass(&att_ctx("What's the latest video from NVIDIA?")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::WebIntent);

        // (d) The E1 guard law: "…, nothing else." does NOT make a turn
        //     local when a live-intent token survives OUTSIDE the
        //     phrase — the residual re-test re-fires the web arm.
        let r = deterministic_hard_bypass(&ctx("Watch the launch event tomorrow, nothing else.")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::WebIntent);
    }

    #[tokio::test]
    async fn attachment_gate_never_calls_the_llm_when_enabled() {
        // opts() points at an UNROUTABLE endpoint: if the gate consulted
        // the model, the call would fail and rules_based_plan (search)
        // would answer — source=rules / search_required=true. The bypass
        // must short-circuit BEFORE any LLM touch (call-count == 0).
        let r = run_search_gate(
            &reqwest::Client::new(),
            &att_ctx("Read the attached file and reply YES if readable."),
            &opts(false),
        )
        .await;
        assert_eq!(r.source, GateSource::Deterministic);
        assert!(!r.decision.search_required);
        assert!(r.decision.queries.is_empty());
        assert_eq!(r.gate_ms, 0.0);
    }

    /* ── Part-10 approved deviation: UNIVERSAL search pre-gate ────────── */

    #[test]
    fn bypass_freshness_forces_search() {
        // Layer 2 FORCE_SEARCH: the staleness bug class — these can never
        // fall to a model-gate veto. No attachment flag: universal.
        for p in [
            "Who is the CEO of Acme Corp?",
            "How much does the RTX 5090 cost?",
            "Is React 18 still maintained?",
            "What's the weather tonight?",
            "Update me on the most recent funding round.",
            "Is this package up to date?",
        ] {
            let r = deterministic_hard_bypass(&ctx(p)).unwrap_or_else(|| panic!("{p}"));
            assert_eq!(r.hit.matched, BypassMatched::Freshness, "{p}");
            assert!(r.decision.search_required, "{p}");
            assert_eq!(r.decision.reason, "deterministic_url_or_intent");
            assert!(!r.decision.queries.is_empty(), "{p} must plan queries");
        }
        // Freshness outranks the skip layers even in a task-shaped prompt.
        let r = deterministic_hard_bypass(&ctx("Write a script that reports the most recent release.")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::Freshness);
        assert!(r.decision.search_required);
    }

    #[test]
    fn bypass_local_task_forces_no_search() {
        // Layer 1 FORCE_SKIP: deterministic NO with ZERO queries — an
        // operational instruction can never become an engine query. No
        // attachment required (that is the universal part).
        for p in [
            "Write Python code for binary search.",
            "Explain this supplied stack trace.",
            "Summarize this supplied text.",
            "Read this attachment and reply YES.",
            "Translate this paragraph.",
            "What is 15 * 17?",
            "Solve 25 * 47",
            "Create a regex for this pattern.",
            "Fix this code.",
            "Review this uploaded source file.",
            "Refactor this function.",
            "Do not search the web; answer from the pasted code only.",
            "What's wrong with this regex?",
            "Find the bug in this attached log.",
            // §11.2 follow-up: the "…, nothing else." meta-instruction
            // fingerprint (closed-form local answer). Universal — the
            // flag is NOT required; the residual re-test is the guard.
            "Listen to the attached audio and reply YES. Nothing else.",
            "Repeat after me: hello world. Nothing else.",
        ] {
            let r = deterministic_hard_bypass(&ctx(p)).unwrap_or_else(|| panic!("{p}"));
            assert_eq!(r.hit.matched, BypassMatched::LocalTask, "{p}");
            assert!(!r.decision.search_required, "{p}");
            assert_eq!(r.decision.reason, "deterministic_self_contained");
            assert!(r.decision.queries.is_empty(), "{p} generated queries");
        }
    }

    #[test]
    fn bypass_local_task_escapes_on_external_intent() {
        // The escape-hatch list guards layer 1b: a self-contained shape
        // that ALSO signals live-web intent falls through to the model.
        assert!(deterministic_hard_bypass(&ctx("Translate this paragraph; check the web for slang usage.")).is_none());
        assert!(deterministic_hard_bypass(&ctx("Summarize this text and browse online sources.")).is_none());
        // Layer 1a (explicit local-only intent) deliberately has NO escape
        // — the phrase list contains "web" itself, so an escape test would
        // self-cancel the user's explicit instruction.
        let r = deterministic_hard_bypass(&ctx("Don't browse; only from the attached document.")).unwrap();
        assert_eq!(r.hit.matched, BypassMatched::LocalTask);
        assert!(!r.decision.search_required);
    }

    #[test]
    fn ambiguous_prompts_reach_the_model_gate() {
        // Layer 3 UNDECIDED: the deterministic classifier ABSTAINS — the
        // (now date-aware) main-model gate keeps owning the gray middle.
        for p in [
            "Tell me about Rust async performance.",
            "Is PostgreSQL better than MongoDB for this architecture?",
            "Why does this GPU sometimes disappear?",
            "Explain recursion.",
            "What are some good books about systems thinking?",
        ] {
            assert!(
                deterministic_hard_bypass(&ctx(p)).is_none(),
                "{p} must reach the model gate"
            );
        }
    }

    #[test]
    fn gate_messages_carry_the_current_date() {
        // §13: an INJECTED date proves the gate prompt is date-dynamic.
        let mut c = ctx("is python 2 still supported?");
        c.current_date = Some("2030-06-15".into());
        let m = &build_main_gate_messages_for_test(&c)[0];
        assert!(m.content.starts_with("Current date: 2030-06-15 (year 2030)."));
        assert!(m.content.contains("parametric knowledge may be STALE"));
        // Unset ⇒ the REAL runtime date, never a frozen constant (the
        // assertion is shape-only so the suite never couples to the clock).
        let m2 = &build_main_gate_messages_for_test(&ctx("hello"))[0];
        assert!(Regex::new(r"Current date: \d{4}-\d{2}-\d{2} \(year \d{4}\)\.").unwrap().is_match(&m2.content));
        assert!(!m2.content.contains("2030-06-15"));
    }

    #[tokio::test]
    async fn universal_pre_gate_never_calls_the_llm() {
        // opts(false) points at an UNROUTABLE endpoint: any LLM touch
        // would fall back to rules_based_plan (source=rules, search=YES).
        // source=deterministic + gate_ms 0 proves ZERO gate-model calls
        // in BOTH universal directions (force-YES and force-NO).
        let r = run_search_gate(&reqwest::Client::new(), &ctx("Who is the CEO of Acme Corp?"), &opts(false)).await;
        assert_eq!(r.source, GateSource::Deterministic);
        assert!(r.decision.search_required);
        assert!(!r.decision.queries.is_empty());
        assert_eq!(r.gate_ms, 0.0);

        let r = run_search_gate(&reqwest::Client::new(), &ctx("Write Python code for binary search."), &opts(false)).await;
        assert_eq!(r.source, GateSource::Deterministic);
        assert!(!r.decision.search_required);
        assert!(r.decision.queries.is_empty());
        assert_eq!(r.gate_ms, 0.0);
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
