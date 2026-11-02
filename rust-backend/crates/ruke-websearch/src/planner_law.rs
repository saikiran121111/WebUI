//! P4 — Deterministic planner law (§11.5/§11.6/§11.14/§11.17/§11.21).
//! ⇔ lib/web-search/planner-law.ts
//!
//! A pure, model-free law layer that derives domain control, coarse
//! localization, expected source types, budgets, sufficiency, and the
//! gap-demand contract from the user prompt + gate decision. The gate wire
//! schema is deliberately NOT extended — the model cannot be trusted to
//! emit these fields, and `parse_search_decision` enforces a strict
//! top-level allowlist. Everything here is deterministic text law so the
//! answer never depends on an extra LLM call (§11.22).
//!
//! Privacy law (§11.17/§11.22): `location` is only a coarse phrase lifted
//! from the user's own words — never a precise IP, coordinates, or derived
//! geolocation. Nothing here sends account data to providers; the location
//! only rides into derived queries.
//!
//! Regex parity notes vs TS (documented divergences):
//! 1. TS regexes are non-/u except LOCATION_PHRASE_RE (`/gu`). A JS `\b`
//!    is ASCII-word-semantics without /u and Unicode-ish with /u; every
//!    ASCII-law boundary here is scoped `(?-u:\b)` to match, while the
//!    location regexes stay full-Unicode BOTH sides (JS /u ⇔ Rust
//!    default) — a deliberate divergence from the ASCII-`\b` legacy
//!    planner regexes.
//! 2. JS `\s` is Unicode in EVERY mode; Rust Unicode `\s` adds NEL
//!    (U+0085) — established divergence #1 across this crate; `js_trim`
//!    is exact.
//! 3. METRIC_VALUE_RE's gap+value run is scoped `(?-u:...)`: JS `\D`
//!    counts UTF-16 code units and `\d` is ASCII; byte-mode `\D` counts
//!    UTF-8 bytes (astral gap chars diverge 4-vs-2 counts — irrelevant
//!    for `{0,12}` prose gaps, ASCII digits stay exact).
//! 4. Map iteration insertion order (TS Map) ⇔ insertion-ordered Vec +
//!    HashMap here (Rust HashMap iteration is random).
//! 5. `source_domains.sort()` — JS sorts UTF-16 code units, Rust sorts
//!    UTF-8 bytes; identical for the ASCII domains the law produces
//!    (non-ASCII IDN hosts sort differently — benign, report-only).
//! 6. `host_of` uses the `url` crate; a successfully-parsed URL with NO
//!    host (mailto:, data:) falls back to the domain-token regex where
//!    JS's `new URL().hostname` returns "" — benign edge, both end up
//!    "" for anything the token regex can't name a TLD for.
//! 7. `to_lowercase()` — full Unicode lowercase vs JS toLowerCase
//!    (Turkish-I class divergences) — established crate-wide.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use chrono::{Datelike, Utc};
use regex::Regex;
use serde::Serialize;

use crate::query_planner::{
    infer_brand_domain, source_class, CoverageReport, PlanOrigin, PlannedQuery,
};
use crate::types::{
    Depth, EvidencePacket, EvidencePassage, ExtractionKind, Freshness, Intent, RankedResult,
    SearchDecision, SearchOrigin,
};

/* ── JS-coercion helpers (per-module, mirrored from siblings) ─────────── */

fn is_js_ws(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

fn js_trim(s: &str) -> &str {
    let start = s.find(|c: char| !is_js_ws(c)).unwrap_or(s.len());
    let end = s
        .rfind(|c: char| !is_js_ws(c))
        .map(|i| i + s[i..].chars().next().unwrap().len_utf8());
    &s[start..end.unwrap_or(start)]
}

/// JS `s.slice(0, max_units)` (UTF-16 units; whole chars kept).
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

/// TS `s.replace(/\s+/g, " ")` (Unicode `\s`; divergence #2).
static RE_WS_RUN: OnceLock<Regex> = OnceLock::new();
fn collapse_ws(s: &str) -> String {
    RE_WS_RUN
        .get_or_init(|| Regex::new(r"\s+").expect("static regex"))
        .replace_all(s, " ")
        .to_string()
}

/* ── regex law table (⇔ TS module constants) ──────────────────────────── */

fn re_segment_split() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // ⇔ SEGMENT_SPLIT_RE: "." splits ONLY as sentence end (whitespace or
    // end-of-text follows) so dotted domains survive the segment scan;
    // `!`, `?`, newlines always split. No lookaround; `$` = end-of-haystack
    // (multiline off ⇔ JS non-multiline `$`).
    R.get_or_init(|| Regex::new(r"(?:[!?\n]+|\.(?:\s|$))").expect("static regex"))
}
fn re_domain_token() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}").expect("static regex")
    })
}
fn re_site_op() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(?-u:\b)site:\s*([a-z0-9][a-z0-9.:-]*)(?:/[^\s]*)?").expect("static regex")
    })
}
fn re_only_scope() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)only\s+(?:search|searching|use|using|check|checking|consult|look|refer|stick|restrict|trust|results?|from)(?-u:\b)",
        )
        .expect("static regex")
    })
}
fn re_block_scope() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(?-u:\b)(?:don'?t|do\s+not|never|avoid|skip|exclude|without)(?-u:\b)")
            .expect("static regex")
    })
}
/// Platform names usable as block verbs without a written domain token.
fn re_block_names() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)(?:reddit|quora|facebook|instagram|twitter|pinterest|medium|tiktok|youtube|4chan)s?(?-u:\b)",
        )
        .expect("static regex")
    })
}
const NAME_TO_DOMAIN: [(&str, &str); 10] = [
    ("reddit", "reddit.com"),
    ("quora", "quora.com"),
    ("facebook", "facebook.com"),
    ("instagram", "instagram.com"),
    ("twitter", "twitter.com"),
    ("pinterest", "pinterest.com"),
    ("medium", "medium.com"),
    ("tiktok", "tiktok.com"),
    ("youtube", "youtube.com"),
    ("4chan", "4chan.org"),
];

/// ⇔ TS `NAME_TO_DOMAIN[k] ?? NAME_TO_DOMAIN[k.replace(/s$/,"")]` —
/// plural-tolerant lookup: "don't use reddits" still blocks reddit.com.
fn name_domain(tok: &str) -> Option<&'static str> {
    let k = tok.to_lowercase();
    NAME_TO_DOMAIN
        .iter()
        .find(|(n, _)| *n == k)
        .map(|(_, d)| *d)
        .or_else(|| {
            let s = k.strip_suffix('s').unwrap_or(&k);
            NAME_TO_DOMAIN
                .iter()
                .find(|(n, _)| *n == s)
                .map(|(_, d)| *d)
        })
}

fn re_official_source() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(?-u:\b)official\s+sources?(?-u:\b)|(?-u:\b)only\s+official(?-u:\b)|(?-u:\b)stick\s+to\s+official(?-u:\b)|(?-u:\b)official\s+(?:documentation|docs)(?-u:\b))",
        )
        .expect("static regex")
    })
}
fn re_brand_docs() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)(?:search|find|check|look\s+up|google)\s+([a-z][a-z0-9-]{2,24})\s+(?:docs?|documentation|official)(?-u:\b)",
        )
        .expect("static regex")
    })
}
fn re_brand_docs_rev() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)(?:docs?|documentation)\s+(?:of|for)\s+([a-z][a-z0-9-]{2,24})(?-u:\b)",
        )
        .expect("static regex")
    })
}
/// Stop-list so "search the docs" / "check your docs" never fabricate a brand.
const BRAND_STOPWORDS: [&str; 28] = [
    "this", "that", "with", "your", "their", "from", "there", "these", "those", "some", "any",
    "all", "the", "and", "for", "how", "why", "what", "when", "where", "who", "whom", "which",
    "about", "into", "over", "user", "users",
];

fn re_local_intent() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)(?:weather|forecast|temperature|humidity|air\s+quality|aqi|restaurant|cafe|coffee\s+shop|food|delivery|hotel|motel|guesthouse|shop|store|market|mall|nearby|near\s+me|around\s+me|close\s+by|event|concert|meetup|webinar|festival|job|vacancy|hiring|opening|salon|clinic|hospital|dentist|doctor|plumber|electrician|mechanic|gym|tour|travel|flight|train|bus|route|directions|traffic|real\s+estate|rent|rental)s?(?-u:\b)",
        )
        .expect("static regex")
    })
}
/// Unicode letter semantics on BOTH sides (JS /u ⇔ Rust default Unicode).
fn re_location_phrase() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"\b(?:near|around|close\s+to|in|from)\s+([A-Z][\p{Ll}'’]{2,24}(?:\s+(?:[a-z]{1,3}|[A-Z][\p{Ll}'’]{2,24})){0,2})",
        )
        .expect("static regex")
    })
}
fn re_query_site() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)site:\s*([a-z0-9][a-z0-9.:-]*)(?:/[^\s]*)?").expect("static regex")
    })
}
// SUCCESS_* classifications are usable EXCEPT snippet-only extraction
// (§11.14 hard law — a search snippet is not a consulted page).
// Contradiction scan: same metric word, different numeric values from
// DIFFERENT sources. Currency symbols stay outside the pattern body so
// both sides share the ASCII core (divergence #3).
// Divergence #8: the regex crate REJECTS byte-mode `\D` outright ("pattern
// can match invalid UTF-8" — byte-mode \D could match a lone 0x80-0xFF).
// JS `\D{0,12}?` ≡ "any char except [0-9], 0..12 times"; the Unicode-mode
// class `[^\x30-\x39]` is the exact char-level equivalent that can only
// match valid UTF-8, and the numeric tail stays ASCII-only via `(?-u:...)`.
// Counting law: JS counts UTF-16 code units in the gap, Rust counts chars —
// only astral chars in the gap shift the 12-bound (same class as #4).
fn re_metric_value() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)(price|cost|salary|revenue|funding|valuation|population|score|rating)(?-u:\b)[^\x30-\x39]{0,12}?(?-u:([0-9][0-9,]*(?:\.[0-9]+)?))",
        )
        .expect("static regex")
    })
}

/* ── budget (§11.21) ─────────────────────────────────────────────────── */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchBudget {
    /// Hard ceiling on planned sub-queries (plan_queries cap).
    pub max_query_waves: usize,
    /// First-hop page-fetch ceiling (mirrors READ_MAX_PAGES).
    pub max_page_fetches: usize,
    /// 2nd-hop / wave page-fetch ceiling (mirrors extract_all(gap, 3)).
    pub max_gap_page_fetches: usize,
    /// §11.6 deep-research follow-up query budget (deep depth only).
    pub demand_wave_queries: usize,
    /// Final passage ceiling (mirrors rerank top-k 15).
    pub max_passages: usize,
}

/// Fast-search vs deep-research duality (§11.22): the same primitives run
/// at every depth; only the demand-wave follow-up budget widens for deep.
/// Ceilings mirror the constants already enforced by pipeline.rs
/// (READ_MAX_PAGES=10, gap extract_all=3, rerank k=15) — kept in sync by
/// the P4 tests, not re-imported (planner_law must not depend on
/// pipeline's private consts; ⇔ TS comment).
pub fn budget_for_depth(depth: Depth) -> SearchBudget {
    SearchBudget {
        max_query_waves: 4,
        max_page_fetches: 10,
        max_gap_page_fetches: 3,
        // A two-word factual query never gets an investigation budget: the
        // wave only arms at depth "deep" (§11.21).
        demand_wave_queries: if depth == Depth::Deep { 2 } else { 0 },
        max_passages: 15,
    }
}

/* ── planner law (§11.17) ────────────────────────────────────────────── */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerLaw {
    pub allowed_domains: Vec<String>,
    pub blocked_domains: Vec<String>,
    pub preferred_domains: Vec<String>,
    /// Coarse localization phrase from the user's own words, or null.
    pub location: Option<String>,
    /// "pdf" | "github" | "profiles" | "official_docs" | "reviews" |
    /// "pricing" | "news" | "papers" | "forums" | "code" (deduped).
    pub expected_source_types: Vec<String>,
    pub budget: SearchBudget,
}

/// Lowercase + strip `www.` + drop any path — registrable-parent style.
pub fn normalize_domain(raw: &str) -> String {
    let d = js_trim(raw).to_lowercase();
    let d = d.split('/').next().unwrap_or("");
    d.strip_prefix("www.").unwrap_or(d).to_string()
}

/// Suffix containment rule (no PSL): host === d or host ends with ".d".
/// ⇔ TS `domainWithin` (mirrors the metasearch preferred-boost ancestor law).
pub fn domain_within(host: &str, domain: &str) -> bool {
    let h = normalize_domain(host);
    let d = normalize_domain(domain);
    if h.is_empty() || d.is_empty() {
        return false;
    }
    h == d || h.ends_with(&format!(".{d}"))
}

fn host_of(url: &str) -> String {
    if let Ok(u) = url::Url::parse(url) {
        if let Some(h) = u.host_str() {
            return h.to_string();
        }
    }
    // TS fallback: first DOMAIN_TOKEN_RE exec (divergence #6 for
    // host-less-but-parseable URLs; same outcome for TLD-less strings).
    re_domain_token()
        .find(url)
        .map(|m| m.as_str().to_string())
        .unwrap_or_default()
}

fn push_unique(list: &mut Vec<String>, v: &str) {
    let d = normalize_domain(v);
    if !d.is_empty() && !list.contains(&d) {
        list.push(d);
    }
}

fn extract_location(prompt: &str) -> Option<String> {
    if !re_local_intent().is_match(prompt) {
        return None;
    }
    let caps = re_location_phrase().captures(prompt)?;
    let collapsed = collapse_ws(&caps[1]);
    let name = js_trim(&collapsed);
    if name.is_empty() {
        return None;
    }
    // Coarse-only law: never more than 3 words, never coordinates.
    Some(name.split(' ').take(3).collect::<Vec<_>>().join(" "))
}

/// Derive the deterministic planner law from the user prompt + gate
/// decision. Gate `queries[].preferred_domains` always merge into the
/// law's preferred list (model suggested sources are honored as
/// preference, never as an allow-list).
pub fn derive_planner_law(user_prompt: &str, decision: &SearchDecision) -> PlannerLaw {
    let mut allowed: Vec<String> = Vec::new();
    let mut blocked: Vec<String> = Vec::new();
    let mut preferred: Vec<String> = Vec::new();

    for seg in re_segment_split().split(user_prompt) {
        let domains = re_domain_token()
            .find_iter(seg)
            .map(|m| normalize_domain(m.as_str()));
        // Plural-tolerant lookup: "don't use reddits" still blocks reddit.com.
        let names = re_block_names()
            .find_iter(seg)
            .filter_map(|m| name_domain(m.as_str()).map(|d| d.to_string()));
        let mut tokens: Vec<String> = Vec::new();
        for t in domains.chain(names) {
            if !tokens.contains(&t) {
                tokens.push(t);
            }
        }
        if tokens.is_empty() {
            continue;
        }
        if re_only_scope().is_match(seg) {
            for d in tokens {
                push_unique(&mut allowed, &d);
            }
        } else if re_block_scope().is_match(seg) {
            for d in tokens {
                push_unique(&mut blocked, &d);
            }
        }
    }

    // Explicit site: operators in the USER PROMPT are user-directed scoping
    // (§11.17). Gate-emitted site: stays targeted-query guidance only.
    for caps in re_site_op().captures_iter(user_prompt) {
        push_unique(&mut allowed, &caps[1]);
    }

    // Preferred ≠ allowed: an "official sources" demand must never
    // fabricate an allow-list (§11.17) — it only steers the expected
    // source type below.
    let brand_caps = re_brand_docs()
        .captures(user_prompt)
        .or_else(|| re_brand_docs_rev().captures(user_prompt));
    if let Some(caps) = brand_caps {
        let brand = caps[1].to_lowercase();
        if !BRAND_STOPWORDS.contains(&brand.as_str()) && brand.chars().count() >= 3 {
            let d = infer_brand_domain(&brand);
            push_unique(&mut preferred, &d);
        }
    }

    for q in &decision.queries {
        if let Some(ds) = &q.preferred_domains {
            for d in ds {
                push_unique(&mut preferred, d);
            }
        }
    }

    // Contradiction law: an explicit block always wins over preference;
    // "only" (allowed) and "don't" (blocked) on the same domain → block
    // wins. (pushUnique keeps both lists duplicate-free, so `retain`
    // ⇔ the TS single-occurrence splice.)
    for d in &blocked {
        preferred.retain(|p| p != d);
    }

    let mut expected: Vec<String> = Vec::new();
    if let Some(cls) = source_class(user_prompt) {
        let want = match cls {
            "pdf" => Some("pdf"),
            "github" => Some("github"),
            "linkedin" => Some("profiles"),
            "docs" => Some("official_docs"),
            "review" => Some("reviews"),
            "pricing" => Some("pricing"),
            _ => None,
        };
        if let Some(w) = want {
            expected.push(w.to_string());
        }
    }
    if re_official_source().is_match(user_prompt) && !expected.iter().any(|e| e == "official_docs")
    {
        expected.push("official_docs".to_string());
    }
    for q in &decision.queries {
        let w = match q.intent {
            Intent::News => Some("news"),
            Intent::Academic => Some("papers"),
            Intent::Forum => Some("forums"),
            Intent::Code => Some("code"),
            Intent::Docs => Some("official_docs"),
            _ => None,
        };
        if let Some(w) = w {
            if !expected.iter().any(|e| e == w) {
                expected.push(w.to_string());
            }
        }
    }

    PlannerLaw {
        allowed_domains: allowed,
        blocked_domains: blocked,
        preferred_domains: preferred,
        location: extract_location(user_prompt),
        expected_source_types: expected,
        budget: budget_for_depth(decision.depth),
    }
}

/* ── plan application (§11.5/§11.17) ─────────────────────────────────── */

fn query_site_domains(query: &str) -> Vec<String> {
    re_query_site()
        .captures_iter(query)
        .map(|caps| normalize_domain(&caps[1]))
        .collect()
}

fn plan_covers_domain(plan: &PlannedQuery, domain: &str) -> bool {
    let d = normalize_domain(domain);
    if plan
        .preferred_domains
        .as_ref()
        .is_some_and(|ps| ps.iter().any(|p| normalize_domain(p) == d))
    {
        return true;
    }
    query_site_domains(&plan.query)
        .into_iter()
        .any(|s| s == d || s.ends_with(&format!(".{d}")) || d.ends_with(&format!(".{s}")))
}

/// Emit site-scoped companion queries for allowed/preferred domains that
/// no existing plan already scopes — honoring the existing 4-plan cap and
/// never repeating a scoped domain. Purely additive: `plan_queries` is
/// untouched, so existing behavior (and goldens) stay byte-identical.
pub fn apply_planner_law(plans: Vec<PlannedQuery>, law: &PlannerLaw) -> Vec<PlannedQuery> {
    let targets: Vec<&String> = law
        .allowed_domains
        .iter()
        .chain(law.preferred_domains.iter())
        .collect();
    if targets.is_empty() || plans.is_empty() {
        return plans;
    }
    let mut out = plans;
    let base = out[0].query.clone();
    for d in targets {
        if out.len() >= law.budget.max_query_waves {
            break;
        }
        if out.iter().any(|p| plan_covers_domain(p, d)) {
            continue;
        }
        out.push(PlannedQuery {
            query: js_slice_max(&format!("{base} site:{d}"), 200),
            intent: Intent::General,
            preferred_domains: Some(vec![d.clone()]),
            origin: PlanOrigin::Preferred,
            freshness: None,
        });
    }
    out
}

/// Hard domain control on merged results (§11.17). Results the USER
/// directed (origin "user" — pasted URLs) are exempt: the user's own link
/// is never a casualty of a domain law they wrote for OTHER sources.
///
/// Search-policy correction (2026-11-02): this is the ONLY hard exclusion
/// mechanism and it is populated only by an EXPLICIT user block or a
/// request-level policy — never automatically because a source is weaker.
/// Soft de-prioritization of Reddit/Wikipedia/forums/community rides the
/// order-only authority prior in `reranker.rs` (ranking, not blocking —
/// fallback law: weak evidence stays usable). P4 (this module) EXPRESSes
/// preferences; the reranking layer decides strength. No duplicate
/// decision logic.
pub fn apply_domain_control(results: Vec<RankedResult>, law: &PlannerLaw) -> Vec<RankedResult> {
    if law.allowed_domains.is_empty() && law.blocked_domains.is_empty() {
        return results;
    }
    results
        .into_iter()
        .filter(|r| {
            if matches!(r.origin, Some(SearchOrigin::User)) {
                return true;
            }
            let host = if r.domain.is_empty() {
                host_of(&r.url)
            } else {
                r.domain.clone()
            };
            if law.blocked_domains.iter().any(|d| domain_within(&host, d)) {
                return false;
            }
            if !law.allowed_domains.is_empty()
                && !law.allowed_domains.iter().any(|d| domain_within(&host, d))
            {
                return false;
            }
            true
        })
        .collect()
}

/* ── sufficiency (§11.14) ────────────────────────────────────────────── */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SufficiencyReport {
    pub enough_sources: bool,
    pub key_claims_supported: bool,
    pub freshness_ok: bool,
    pub primary_present: bool,
    pub independent_domains: bool,
    pub contradiction_suspected: bool,
    pub pages_useful: bool,
    /// All gates pass cleanly → stop early, spend nothing more.
    pub stop_early: bool,
    /// Distinct usable (non-snippet-only) evidence domains.
    pub source_domains: Vec<String>,
    /// Metric words carrying conflicting values (feeds gap demand).
    pub contradiction_metrics: Vec<String>,
}

fn counted_source_ids(packets: &[EvidencePacket]) -> HashSet<&str> {
    let mut ok: HashSet<&str> = HashSet::new();
    for p in packets {
        if !p
            .classification
            .as_deref()
            .unwrap_or("")
            .starts_with("SUCCESS")
        {
            continue;
        }
        if p.extraction == ExtractionKind::SnippetOnly {
            continue;
        }
        ok.insert(p.source_id.as_str());
    }
    ok
}

/// TS Map-of-Maps scan ported with an insertion-ordered metric list
/// (divergence #4 — TS Map iteration order is part of the contract).
fn detect_contradictions(passages: &[&EvidencePassage]) -> (Vec<String>, bool) {
    let mut order: Vec<String> = Vec::new();
    let mut by: HashMap<String, HashMap<String, HashSet<String>>> = HashMap::new();
    for p in passages {
        for caps in re_metric_value().captures_iter(&p.passage_text) {
            let metric = caps[1].to_lowercase();
            let value = caps[2].replace(',', "");
            if !by.contains_key(&metric) {
                by.insert(metric.clone(), HashMap::new());
                order.push(metric.clone());
            }
            by.get_mut(&metric)
                .unwrap()
                .entry(p.source_id.clone())
                .or_default()
                .insert(value);
        }
    }
    let mut metrics: Vec<String> = Vec::new();
    for m in &order {
        let per = &by[m];
        let mut values: HashSet<&String> = HashSet::new();
        let mut sources_with_values = 0usize;
        for set in per.values() {
            if set.is_empty() {
                continue;
            }
            sources_with_values += 1;
            values.extend(set.iter());
        }
        if sources_with_values >= 2 && values.len() >= 2 {
            metrics.push(m.clone());
        }
    }
    // Compute the flag before `metrics` is moved into the tuple (the tuple
    // evaluates left-to-right, so inlining the borrow would move-then-borrow).
    let suspected = !metrics.is_empty();
    (metrics, suspected)
}

/// §11.14 claim-level pass, reconstructed deterministically from the
/// evidence already in hand — no extra LLM call. Every check maps to a
/// line in the sufficiency checklist; `stop_early` is true only when the
/// evidence passes cleanly and nothing contradicts.
pub fn evaluate_sufficiency(
    packets: &[EvidencePacket],
    top_passages: &[EvidencePassage],
    coverage: &CoverageReport,
    decision: &SearchDecision,
    law: &PlannerLaw,
) -> SufficiencyReport {
    let counted = counted_source_ids(packets);
    let kept: Vec<&EvidencePassage> = top_passages
        .iter()
        .filter(|p| counted.contains(p.source_id.as_str()))
        .collect();
    let mut source_domains: Vec<String> = kept
        .iter()
        .filter(|p| !p.domain.is_empty())
        .map(|p| p.domain.clone())
        .collect();
    source_domains.sort();
    source_domains.dedup();

    let enough_sources = source_domains.len() >= 3;
    let independent_domains = source_domains.len() >= 2;
    let key_claims_supported = coverage.coverage >= 0.6;

    let freshness_banded = matches!(
        decision.freshness,
        Freshness::Day | Freshness::Week | Freshness::Month | Freshness::Year | Freshness::Realtime
    );
    let freshness_ok = !freshness_banded
        || kept
            .iter()
            .any(|p| p.published_at.as_ref().is_some_and(|s| !s.is_empty()));

    let primaries: Vec<&String> = law
        .allowed_domains
        .iter()
        .chain(law.preferred_domains.iter())
        .collect();
    let primary_present = primaries.is_empty()
        || kept.iter().any(|p| {
            let host = if p.domain.is_empty() {
                host_of(&p.url)
            } else {
                p.domain.clone()
            };
            primaries.iter().any(|d| domain_within(&host, d))
        });

    let (contradiction_metrics, contradiction_suspected) = detect_contradictions(&kept);
    let pages_useful = !counted.is_empty();

    let gates_pass = enough_sources
        && key_claims_supported
        && freshness_ok
        && primary_present
        && independent_domains
        && pages_useful;

    SufficiencyReport {
        enough_sources,
        key_claims_supported,
        freshness_ok,
        primary_present,
        independent_domains,
        contradiction_suspected,
        pages_useful,
        stop_early: gates_pass && !contradiction_suspected,
        source_domains,
        contradiction_metrics,
    }
}

/* ── gap demand (§11.6) ──────────────────────────────────────────────── */

/// Exact §11.6 contract shape (snake_case wire vocabulary).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GapDemand {
    pub missing_claims: Vec<String>,
    pub queries: Vec<String>,
    pub desired_source_types: Vec<String>,
    pub freshness: Freshness,
    pub reason: String,
    pub remaining_budget: usize,
}

/// ⇔ TS `normKey` (manual port — one class can't mix ASCII `\w` with
/// Unicode `\s`; JS order lower→collapse→strip→trim preserved by the
/// pending-space law: stripped chars never merge collapsed runs because
/// a collapsed run is maximal-contiguous-`\s` by definition).
fn norm_key(q: &str) -> String {
    let lowered = q.to_lowercase();
    let mut out: Vec<char> = Vec::new();
    let mut pending_space = false;
    for c in lowered.chars() {
        // JS \s (regex mode): White_Space ∪ {U+FEFF} — not the is_js_ws
        // trim predicate (which excludes NEL); collapse is Unicode-`\s`.
        if c.is_whitespace() || c == '\u{FEFF}' {
            pending_space = true;
            continue;
        }
        let allowed = c.is_ascii_alphanumeric() || c == '_' || matches!(c, ':' | '.' | '/' | '-');
        if !allowed {
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    let s: String = out.into_iter().collect();
    js_trim(&s).to_string()
}

const SOURCE_TYPE_WORD: [(&str, &str); 8] = [
    ("official_docs", "official"),
    ("news", "news"),
    ("reviews", "review"),
    ("papers", "paper"),
    ("github", "github"),
    ("pdf", "pdf"),
    ("forums", "discussion"),
    ("code", "code"),
];

fn head_words(prompt: &str, n: usize) -> String {
    collapse_ws(js_trim(prompt))
        .split(' ')
        .take(n)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Build the §11.6 gap contract from the sufficiency gaps. NEVER-REPEAT
/// law (§11.6): every candidate variant is checked, case-insensitively,
/// against every query already used this run — a variant ladder
/// (base → "official" → "review" → year) replaces a repeated query, and
/// a base whose whole ladder collides is DROPPED, not emitted.
pub fn build_gap_demand(
    user_prompt: &str,
    coverage: &CoverageReport,
    sufficiency: &SufficiencyReport,
    decision: &SearchDecision,
    law: &PlannerLaw,
    used_queries: &[String],
) -> Option<GapDemand> {
    if law.budget.demand_wave_queries == 0 {
        return None;
    }

    let mut missing: Vec<String> = Vec::new();
    let mut desired: Vec<String> = Vec::new();
    let mut reasons: Vec<String> = Vec::new();
    let year = Utc::now().year().to_string();

    if !sufficiency.key_claims_supported && !coverage.missing_entities.is_empty() {
        missing.extend(coverage.missing_entities.iter().take(4).cloned());
        desired.extend(["official_docs".to_string(), "news".to_string()]);
        reasons.push("key entities unsupported by evidence".to_string());
    }
    if sufficiency.contradiction_suspected {
        for m in &sufficiency.contradiction_metrics {
            missing.push(format!("conflicting {m} across sources"));
        }
        desired.extend(["reviews".to_string(), "official_docs".to_string()]);
        reasons.push("conflicting values across sources".to_string());
    }
    if !sufficiency.primary_present {
        let d = law
            .allowed_domains
            .first()
            .or(law.preferred_domains.first())
            .map(|s| s.as_str())
            .unwrap_or("asked-for source");
        missing.push(format!("primary source ({d})"));
        desired.push("official_docs".to_string());
        reasons.push("official/primary source missing".to_string());
    }
    if !sufficiency.freshness_ok {
        missing.push("fresh dated evidence".to_string());
        desired.push("news".to_string());
        reasons.push(format!(
            "freshness band \"{}\" not evidenced",
            decision.freshness.as_str()
        ));
    }
    if !sufficiency.enough_sources {
        missing.push("additional independent sources".to_string());
        desired.extend(["news".to_string(), "reviews".to_string()]);
        reasons.push("too few independent domains".to_string());
    }
    if missing.is_empty() {
        return None;
    }

    let entity = coverage
        .missing_entities
        .first()
        .cloned()
        .unwrap_or_else(|| head_words(user_prompt, 6));
    let mut bases: Vec<String> = Vec::new();
    if !sufficiency.key_claims_supported {
        bases.push(coverage.gap_query.clone().unwrap_or_else(|| {
            coverage
                .missing_entities
                .iter()
                .take(3)
                .map(|e| format!("\"{e}\""))
                .collect::<Vec<_>>()
                .join(" ")
        }));
    }
    if sufficiency.contradiction_suspected {
        bases.push(format!(
            "{} {entity} official",
            sufficiency
                .contradiction_metrics
                .first()
                .map(|s| s.as_str())
                .unwrap_or("")
        ));
    }
    if !sufficiency.primary_present {
        if let Some(d) = law
            .allowed_domains
            .first()
            .or(law.preferred_domains.first())
        {
            bases.push(format!("{entity} site:{d}"));
        }
    }
    if !sufficiency.freshness_ok {
        bases.push(format!("{entity} {year}"));
    }
    if !sufficiency.enough_sources {
        let type_word = match law
            .expected_source_types
            .first()
            .map(|s| s.as_str())
            .unwrap_or("")
        {
            k if SOURCE_TYPE_WORD.iter().any(|(key, _)| *key == k) => SOURCE_TYPE_WORD
                .iter()
                .find(|(key, _)| *key == k)
                .map(|(_, w)| *w)
                .unwrap_or("review"),
            _ => "review",
        };
        bases.push(format!("{} {type_word}", head_words(user_prompt, 8)));
    }

    let mut used: HashSet<String> = used_queries.iter().map(|q| norm_key(q)).collect();
    let suffixes = [
        String::new(),
        " official".to_string(),
        " review".to_string(),
        format!(" {year}"),
    ];
    let mut queries: Vec<String> = Vec::new();
    for base in &bases {
        if js_trim(base).is_empty() {
            continue;
        }
        if queries.len() >= law.budget.demand_wave_queries {
            break;
        }
        for suffix in &suffixes {
            let joined = base.clone() + suffix;
            let cand = js_trim(&joined);
            let key = norm_key(cand);
            if !used.contains(&key) {
                used.insert(key);
                queries.push(js_slice_max(cand, 200));
                break;
            }
        }
    }
    if queries.is_empty() {
        return None;
    }

    let mut dedup_desired: Vec<String> = Vec::new();
    for d in desired {
        if !dedup_desired.contains(&d) {
            dedup_desired.push(d);
        }
    }
    // Struct literals evaluate fields in declaration order, so `remaining_budget`
    // must be computed BEFORE `queries` is moved into the literal below.
    let remaining_budget = law.budget.demand_wave_queries.saturating_sub(queries.len());
    Some(GapDemand {
        missing_claims: missing.into_iter().take(6).collect(),
        queries,
        desired_source_types: dedup_desired,
        freshness: decision.freshness.clone(),
        reason: js_slice_max(&reasons.join("; "), 200),
        remaining_budget,
    })
}

/* ── tests (P4 §11.25 suites B+F; ⇔ __tests__/web-search/planner-law.test.ts) ── */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Depth, Freshness, Intent, SearchDecision, SearchQuery};
    use serde_json::json;

    fn decision_with(
        depth: Depth,
        freshness: Freshness,
        queries: Vec<SearchQuery>,
    ) -> SearchDecision {
        SearchDecision {
            search_required: true,
            reason: String::new(),
            freshness,
            depth,
            queries,
        }
    }
    fn pq(query: &str) -> PlannedQuery {
        PlannedQuery {
            query: query.to_string(),
            intent: Intent::General,
            preferred_domains: None,
            origin: PlanOrigin::Semantic,
            freshness: None,
        }
    }
    fn rr(url: &str, domain: &str, origin: Option<&str>) -> RankedResult {
        let mut v = json!({
            "url": url, "canonical": url, "title": "t", "snippet": "s",
            "engine": "e", "domain": domain, "rrf": 1.0,
            "engines": ["e"], "engineRanks": {}
        });
        if let Some(o) = origin {
            v["origin"] = json!(o);
        }
        serde_json::from_value(v).unwrap()
    }
    fn pk(source_id: &str, domain: &str, extraction: &str) -> EvidencePacket {
        serde_json::from_value(json!({
            "sourceId": source_id, "url": format!("https://{domain}/x"), "title": "T",
            "domain": domain, "extraction": extraction, "passages": [],
            "classification": "SUCCESS_OK"
        }))
        .unwrap()
    }
    fn ep(source_id: &str, domain: &str, text: &str) -> EvidencePassage {
        serde_json::from_value(json!({
            "sourceId": source_id, "url": format!("https://{domain}/x"), "title": "T",
            "domain": domain, "passageText": text, "bm25Score": 0
        }))
        .unwrap()
    }
    fn empty_law(prompt: &str, decision: &SearchDecision) -> PlannerLaw {
        derive_planner_law(prompt, decision)
    }

    #[test]
    fn derive_only_scope_allowed_and_blocked_names() {
        // Fixture law (search-policy correction 2026-11-02): reddit and
        // quora land in blocked_domains ONLY because the USER explicitly
        // wrote "Don't use reddit or quora." — this fixture proves the
        // EXPLICIT-user hard-block semantics, it is NOT default policy.
        // Merely-weak sources are softly de-prioritized in reranker.rs
        // and NEVER blocked by default.
        let law = empty_law(
            "Only search arxiv.org for the paper. Don't use reddit or quora.",
            &decision_with(Depth::Standard, Freshness::None, vec![]),
        );
        assert_eq!(law.allowed_domains, ["arxiv.org"]);
        assert_eq!(law.blocked_domains, ["reddit.com", "quora.com"]);
        assert!(law.preferred_domains.is_empty());
        assert!(law.location.is_none());
    }

    #[test]
    fn derive_blocked_names_are_plural_tolerant() {
        // USER-explicit block ("avoid reddits") — not a default block-list
        // (policy correction 2026-11-02; weak sources ride reranker.rs's
        // soft prior, they are never auto-blocked).
        let law = empty_law(
            "avoid reddits at all costs",
            &decision_with(Depth::Standard, Freshness::None, vec![]),
        );
        assert_eq!(law.blocked_domains, ["reddit.com"]);
    }

    #[test]
    fn derive_prompt_site_operator_is_allowed() {
        let law = empty_law(
            "site:react.dev examples please",
            &decision_with(Depth::Standard, Freshness::None, vec![]),
        );
        assert_eq!(law.allowed_domains, ["react.dev"]);
        assert!(law.blocked_domains.is_empty());
    }

    #[test]
    fn derive_official_demand_prefers_without_fabricating_allowlist() {
        let law = empty_law(
            "use official documentation only",
            &decision_with(Depth::Standard, Freshness::None, vec![]),
        );
        assert!(
            law.allowed_domains.is_empty(),
            "Preferred ≠ allowed (§11.17)"
        );
        assert!(law.preferred_domains.is_empty());
        assert!(law
            .expected_source_types
            .iter()
            .any(|e| e == "official_docs"));
    }

    #[test]
    fn derive_brand_docs_pattern_prefers_brand_domain() {
        let law = empty_law(
            "search kubernetes docs please",
            &decision_with(Depth::Standard, Freshness::None, vec![]),
        );
        assert_eq!(law.preferred_domains, ["kubernetes.com"]);
        // A stopword token must never fabricate a brand domain.
        let none = empty_law(
            "search the docs please",
            &decision_with(Depth::Standard, Freshness::None, vec![]),
        );
        assert!(none.preferred_domains.is_empty());
    }

    #[test]
    fn derive_merges_gate_preferred_and_block_wins() {
        let q = SearchQuery {
            query: "docs".into(),
            intent: Intent::Docs,
            preferred_domains: Some(vec!["reddit.com".into(), "docs.rs".into()]),
        };
        let law = empty_law(
            "don't use reddit",
            &decision_with(Depth::Standard, Freshness::None, vec![q]),
        );
        assert_eq!(law.blocked_domains, ["reddit.com"]);
        assert_eq!(law.preferred_domains, ["docs.rs"]);
    }

    #[test]
    fn derive_location_is_coarse_and_gated_by_local_intent() {
        let std = decision_with(Depth::Standard, Freshness::None, vec![]);
        assert_eq!(
            empty_law("weather in Pune", &std).location.as_deref(),
            Some("Pune")
        );
        assert!(empty_law("how do exceptions work in Kubernetes", &std)
            .location
            .is_none());
        assert_eq!(
            empty_law("best restaurants near New York City", &std)
                .location
                .as_deref(),
            Some("New York City")
        );
    }

    #[test]
    fn budget_depths() {
        let deep = budget_for_depth(Depth::Deep);
        assert_eq!(deep.demand_wave_queries, 2);
        for d in [Depth::Quick, Depth::Standard] {
            assert_eq!(budget_for_depth(d).demand_wave_queries, 0);
        }
        assert_eq!(deep.max_page_fetches, 10);
        assert_eq!(deep.max_gap_page_fetches, 3);
        assert_eq!(deep.max_passages, 15);
    }

    #[test]
    fn apply_planner_law_adds_scoped_companions_and_respects_cover() {
        let std = decision_with(Depth::Standard, Freshness::None, vec![]);
        let law = empty_law("only search arxiv.org", &std);
        let out = apply_planner_law(vec![pq("rust async runtime")], &law);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].query, "rust async runtime site:arxiv.org");
        assert_eq!(out[1].origin, PlanOrigin::Preferred);
        assert_eq!(
            out[1].preferred_domains,
            Some(vec!["arxiv.org".to_string()])
        );
        // Already scoped → nothing added.
        let covered = apply_planner_law(vec![pq("rust async runtime site:arxiv.org")], &law);
        assert_eq!(covered.len(), 1);
        // The 4-wave cap holds against a 4-target law.
        let wide = empty_law("only search a.com, b.com, c.com, d.com", &std);
        assert_eq!(wide.allowed_domains.len(), 4);
        let capped = apply_planner_law(vec![pq("base query")], &wide);
        assert_eq!(capped.len(), 4);
    }

    #[test]
    fn apply_domain_control_blocks_allows_and_exempts_user_links() {
        let std = decision_with(Depth::Standard, Freshness::None, vec![]);
        let law = empty_law("Only search arxiv.org. Don't use reddit.", &std);
        let kept: Vec<String> = apply_domain_control(
            vec![
                rr("https://reddit.com/r/x", "reddit.com", None), // blocked
                rr("https://arxiv.org/abs/1", "arxiv.org", None), // allowed
                rr("https://example.com/x", "example.com", None), // outside allowlist
                rr("https://example.com/mine", "example.com", Some("user")), // user-directed exempt
                rr("https://www.arxiv.org/x", "", None),          // host-from-url + www
            ],
            &law,
        )
        .into_iter()
        .map(|r| r.url)
        .collect();
        assert_eq!(
            kept,
            [
                "https://arxiv.org/abs/1",
                "https://example.com/mine",
                "https://www.arxiv.org/x"
            ]
        );
        // No lists → strict no-op identity.
        let plain = empty_law("hello there", &std);
        let input = vec![rr("https://reddit.com/r/x", "reddit.com", None)];
        assert_eq!(apply_domain_control(input.clone(), &plain), input);
    }

    #[test]
    fn sufficiency_gates_snippet_only_and_contradiction() {
        let std = decision_with(Depth::Standard, Freshness::Week, vec![]);
        let law = empty_law("", &std);
        let packets = vec![
            pk("s1", "a.com", "direct"),
            pk("s2", "b.com", "direct"),
            pk("s3", "z.com", "snippet-only"), // §11.14: never counts
        ];
        let passages = vec![
            ep("s1", "a.com", "The price is 10.50 dollars"),
            ep("s2", "b.com", "The price jumped to 12.00"),
            ep("s3", "z.com", "The price is 9.99"), // filtered out with its source
        ];
        let coverage = CoverageReport {
            coverage: 0.8,
            missing_entities: vec![],
            needs_gap_search: false,
            gap_query: None,
        };
        let report = evaluate_sufficiency(&packets, &passages, &coverage, &std, &law);
        assert_eq!(report.source_domains, ["a.com", "b.com"]); // z.com excluded
        assert!(!report.enough_sources); // 2 < 3
        assert!(report.independent_domains);
        assert!(report.key_claims_supported);
        assert!(!report.freshness_ok); // "week" band, no dated kept passage
        assert!(report.primary_present);
        assert!(report.contradiction_suspected);
        assert_eq!(report.contradiction_metrics, ["price"]);
        assert!(report.pages_useful);
        assert!(!report.stop_early);
    }

    #[test]
    fn gap_demand_variants_never_repeat_a_used_query() {
        let deep = decision_with(Depth::Deep, Freshness::Year, vec![]);
        let prompt = "rust performance price report analysis final extra";
        let law = empty_law(prompt, &deep);
        assert_eq!(law.budget.demand_wave_queries, 2);
        let coverage = CoverageReport {
            coverage: 0.9,
            missing_entities: vec![],
            needs_gap_search: false,
            gap_query: None,
        };
        let suff = SufficiencyReport {
            enough_sources: false,
            key_claims_supported: true,
            freshness_ok: true,
            primary_present: true,
            independent_domains: true,
            contradiction_suspected: true,
            pages_useful: true,
            stop_early: false,
            source_domains: vec!["a.com".into(), "b.com".into()],
            contradiction_metrics: vec!["price".into()],
        };
        let entity = "rust performance price report analysis final";
        let base1 = format!("price {entity} official");
        let used = vec![base1.clone()];
        let demand = build_gap_demand(prompt, &coverage, &suff, &deep, &law, &used).unwrap();
        assert_eq!(
            demand.missing_claims,
            [
                "conflicting price across sources",
                "additional independent sources"
            ]
        );
        assert_eq!(
            demand.desired_source_types,
            ["reviews", "official_docs", "news"]
        );
        assert_eq!(
            demand.reason,
            "conflicting values across sources; too few independent domains"
        );
        assert_eq!(demand.queries.len(), 2);
        // Never-repeat law: the collided base climbed the suffix ladder.
        assert_ne!(demand.queries[0], base1);
        assert!(demand.queries[0].ends_with("official official"));
        assert!(demand.queries[1].ends_with(" extra review"));
        assert_eq!(demand.remaining_budget, 0);
        // §11.6 wire shape (snake_case) + key order, exact string.
        assert_eq!(
            serde_json::to_string(&demand).unwrap(),
            format!(
                "{{\"missing_claims\":[\"conflicting price across sources\",\"additional independent sources\"],\"queries\":[{},{}],\"desired_source_types\":[\"reviews\",\"official_docs\",\"news\"],\"freshness\":\"year\",\"reason\":\"conflicting values across sources; too few independent domains\",\"remaining_budget\":0}}",
                serde_json::Value::String(demand.queries[0].clone()),
                serde_json::Value::String(demand.queries[1].clone())
            )
        );
    }

    #[test]
    fn gap_demand_drops_fully_colliding_bases_and_nulls_clean_cases() {
        let deep = decision_with(Depth::Deep, Freshness::Year, vec![]);
        let prompt = "rust performance price report analysis final extra";
        let law = empty_law(prompt, &deep);
        let coverage = CoverageReport {
            coverage: 0.9,
            missing_entities: vec![],
            needs_gap_search: false,
            gap_query: None,
        };
        let suff = SufficiencyReport {
            enough_sources: false,
            key_claims_supported: true,
            freshness_ok: true,
            primary_present: true,
            independent_domains: true,
            contradiction_suspected: true,
            pages_useful: true,
            stop_early: false,
            source_domains: vec!["a.com".into(), "b.com".into()],
            contradiction_metrics: vec!["price".into()],
        };
        // Whole ladder collides for BOTH bases → no query may repeat → None.
        let year = chrono::Utc::now().year().to_string();
        let entity = "rust performance price report analysis final";
        let b1 = format!("price {entity} official");
        let b2 = format!("{prompt} review");
        let used = [
            b1.clone(),
            format!("{b1} official"),
            format!("{b1} review"),
            format!("{b1} {year}"),
            b2.clone(),
            format!("{b2} official"),
            format!("{b2} review"),
            format!("{b2} {year}"),
        ]
        .map(|s| s.to_string())
        .to_vec();
        assert!(build_gap_demand(prompt, &coverage, &suff, &deep, &law, &used).is_none());
        // Nothing missing → None (stop-early case; no demand at all).
        let good = SufficiencyReport {
            enough_sources: true,
            key_claims_supported: true,
            freshness_ok: true,
            primary_present: true,
            independent_domains: true,
            contradiction_suspected: false,
            pages_useful: true,
            stop_early: true,
            source_domains: vec!["a.com".into(), "b.com".into(), "c.com".into()],
            contradiction_metrics: vec![],
        };
        assert!(build_gap_demand(prompt, &coverage, &good, &deep, &law, &[]).is_none());
        // Non-deep depths carry a zero demand-wave budget (§11.21) → None.
        let quick = decision_with(Depth::Quick, Freshness::Year, vec![]);
        let law_q = empty_law(prompt, &quick);
        assert!(build_gap_demand(prompt, &coverage, &suff, &quick, &law_q, &[]).is_none());
    }

    #[test]
    fn serde_field_order_and_vocabulary_match_ts() {
        // PlanOrigin wire label (§ P2 contract).
        assert_eq!(
            serde_json::to_string(&PlanOrigin::Preferred).unwrap(),
            "\"preferred\""
        );
        // PlannerLaw camelCase key ORDER ⇔ TS object literal. The
        // blockedDomains values here are FIXTURE INPUTS proving
        // serialization of an EXPLICIT user block (the prompt above says
        // "Don't use reddit or quora.") — NOT default policy (policy
        // correction 2026-11-02: weak sources are softly ranked in
        // reranker.rs, never blocked by default).
        let std = decision_with(Depth::Standard, Freshness::None, vec![]);
        let law = empty_law(
            "Only search arxiv.org for the paper. Don't use reddit or quora.",
            &std,
        );
        assert_eq!(
            serde_json::to_string(&law).unwrap(),
            // "paper" maps through sourceClass to the pdf class — the SAME
            // classMap runs on both sides, so TS yields ["pdf"] too.
            r#"{"allowedDomains":["arxiv.org"],"blockedDomains":["reddit.com","quora.com"],"preferredDomains":[],"location":null,"expectedSourceTypes":["pdf"],"budget":{"maxQueryWaves":4,"maxPageFetches":10,"maxGapPageFetches":3,"demandWaveQueries":0,"maxPassages":15}}"#
        );
    }
}
