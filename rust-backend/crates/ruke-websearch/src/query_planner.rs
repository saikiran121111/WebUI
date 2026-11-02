//! OWNER: W2 — parity port of `lib/web-search/query-planner.ts` (473 lines).
//!
//! PARITY port of `lib/web-search/query-planner.ts` (multi-hop query
//! planner & coverage/gap evaluator). TypeScript quirks are reproduced
//! verbatim; unavoidable Rust-vs-JS divergences are recorded below.
//!
//! The planner is fully deterministic — `query-planner.ts` performs NO LLM
//! call (the brief's unroutable-LLM-endpoint guidance does not apply here);
//! the only I/O leg is [`run_gap_metasearch`], which the caller supplies a
//! [`Net`] seam for (see divergence #8).
//!
//! Divergences (TS ⇏ Rust, recorded, NOT fixed):
//! 1. JS `\b` is always ASCII (`[0-9A-Za-z_]`); every `\b` here is ported
//!    as `(?-u:\b)`. JS `\w`/`\d` are ASCII too → `(?-u:\w*)`/`(?-u:\d)`;
//!    JS `\s` is Unicode in every mode (includes NBSP/U+3000/U+FEFF, NOT
//!    U+0085) → ported as Unicode `\s`; the Rust-vs-JS `\s` sets differ
//!    only at U+0085 / U+FEFF.
//! 2. `String.prototype.trim()` trims JS WhiteSpace+LineTerminator
//!    (White_Space ∪ {U+FEFF}, NOT U+0085); Rust `str::trim` trims
//!    U+0085 but not U+FEFF → private [`js_trim`] mirrors JS.
//! 3. `.slice(0, N)` counts UTF-16 units → [`js_slice_max`] (whole chars,
//!    no surrogate split); `.length` → [`js_len`].
//! 4. Quoted-phrase quantifier `{4,80}` counts code points in the regex
//!    crate but UTF-16 units in JS (astral text counts double in JS).
//! 5. `toLowerCase()` JS vs Rust: Rust applies final-sigma handling
//!    (Σ→ς at word end) JS does not; `(?i)` case-folding additionally
//!    diverges at exotic single-char folds (e.g. U+0130). Left unfixed.
//! 6. `PlannedQuery.intent` widens to [`types::Intent`]: the TS-only
//!    labels `pdf`/`github`/`review`/`pricing` ride `Intent::Other(...)`
//!    (custom serde passthrough keeps the raw label on the wire).
//!    `freshness` is always `None` — `planQueries` never sets it (TS
//!    quirk kept: the field exists but is dead in this module).
//! 7. `origin: "gap"` is declared in the TS union but NEVER produced by
//!    this module — kept in [`PlanOrigin`] for parity (dead variant).
//! 8. TS `runGapMetasearch(gapQuery)` uses the ambient real net; Rust
//!    takes `net: &dyn Net` as an extra first parameter (the crate-wide
//!    mock-boundary seam) — call-site divergence only.
//! 9. `evaluateCoverage`'s comment claims whole-word matching but the
//!    code is `haystack.includes(...)` — plain substring matching is
//!    ported as-is (TS quirk kept).

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::metasearch::{metasearch, strip_url_plans, SearchPlan};
use crate::net::Net;
use crate::reranker::tokenize;
use crate::task_scope::{TargetState, TaskScope};
use crate::types::{Intent, RankedResult, SearchQuery};

/* ── JS-semantics helpers (private; house-style copies, not imported) ── */

/// JS `s.length` in UTF-16 code units.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
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

/// JS `String.prototype.trim()` — White_Space ∪ {U+FEFF} minus U+0085
/// (JS does not treat NEL as whitespace; Rust's `char::is_whitespace`
/// does). Divergence #2.
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

/// TS `s.replace(/\s+/g, " ").trim()` (Unicode `\s` — JS `\s` is Unicode
/// in every mode; divergence #1).
static RE_WS_RUN: OnceLock<Regex> = OnceLock::new();
fn collapse_ws(s: &str) -> String {
    RE_WS_RUN
        .get_or_init(|| Regex::new(r"\s+").expect("static regex"))
        .replace_all(s, " ")
        .to_string()
}

/* ── entity extraction (cheap, no LLM) ───────────────────────────────── */

/// TS `ENTITY_PATTERNS` (query-planner.ts 36-42), ported per divergence #1.
fn entity_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            // version numbers — /\bv\d+(\.\d+)+\b/g (ASCII through-and-through)
            r"(?-u:\bv\d+(?:\.\d+)+\b)",
            // product names — \s stays Unicode; ranges/boundaries ASCII
            r"(?-u:\b)[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?(?:\.(?:com|org|in|io|dev|ai|co))(?-u:\b)",
            // quoted phrases (open class: U+0022/U+201C; close: U+0022/U+201D)
            "[\"\u{201C}]([^\"\u{201D}]{4,80})[\"\u{201D}]",
            // error strings
            r"(?i)(?-u:\b(?:error|exception|fail(?:ed|ure)?|cannot|unable|crash(?:es|ed)?))\s+(?-u:[a-z_]{3,})",
            // identifier + kind noun
            r"(?i)(?-u:\b[a-z_]\w*)\s+(?:function|method|class|module|library|framework|api)(?-u:\b)",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("static regex"))
        .collect()
    })
}

/// ⇔ TS `extractEntities` (44-63). TS `head.match(re)` with /g returns the
/// FULL matches (not capture groups) — `find_iter` matches 1:1.
fn extract_entities(prompt: &str) -> Vec<String> {
    let head = js_slice_max(prompt, 600);
    let mut out: Vec<String> = Vec::new();
    for re in entity_patterns() {
        for m in re.find_iter(&head) {
            out.push(js_trim(m.as_str()).to_string());
        }
    }
    // Also pull the top non-stopword content words as loose entities
    out.extend(tokenize(&head).into_iter().take(12));
    // Dedupe (case-insensitive, first wins)
    let mut seen = HashSet::new();
    out.retain(|e| seen.insert(e.to_lowercase()));
    out.into_iter().take(10).collect()
}

/// TS `sourceClass` (69-81) — returns the class label or None. All TS
/// regexes are non-/u → `\b`/`\w` ASCII (ported `(?-u:)`), `\s` Unicode.
/// P4: `pub` for the planner-law expected-source-type derivation
/// (planner_law.rs ⇔ planner-law.ts).
pub fn source_class(prompt: &str) -> Option<&'static str> {
    static PDF: OnceLock<Regex> = OnceLock::new();
    static LINKEDIN: OnceLock<Regex> = OnceLock::new();
    static GITHUB: OnceLock<Regex> = OnceLock::new();
    static DOCS: OnceLock<Regex> = OnceLock::new();
    static REVIEW: OnceLock<Regex> = OnceLock::new();
    static PRICING: OnceLock<Regex> = OnceLock::new();
    let p = prompt.to_lowercase();
    if PDF.get_or_init(|| {
        Regex::new(r"(?:(?-u:\b)filetype\s*:\s*pdf(?-u:\b)|(?-u:\bpaper\b)|(?-u:\bpdf\b)|(?-u:\bwhite ?paper\b))")
            .expect("static regex")
    })
    .is_match(&p)
    {
        return Some("pdf");
    }
    if LINKEDIN
        .get_or_init(|| {
            Regex::new(
                r"(?:(?-u:\blinked ?in\b)|(?-u:lnkd\.in)|(?-u:/profile\b)|person profile|(?-u:\bfind (?:this|the|that) (?:guy|person|profile)\b))",
            )
            .expect("static regex")
        })
        .is_match(&p)
    {
        return Some("linkedin");
    }
    if GITHUB
        .get_or_init(|| {
            Regex::new(
                r"(?:(?-u:\bsite)\s*:\s*github\.com(?-u:\b)|github|(?-u:repo(?:sitory)?)\s+(?:(?-u:page)(?-u:\b))?(?-u:\b))",
            )
            .expect("static regex")
        })
        .is_match(&p)
    {
        return Some("github");
    }
    if DOCS
        .get_or_init(|| {
            Regex::new(r"(?:(?-u:\b)docs?|documentation|manual|guide|reference|readme)")
                .expect("static regex")
        })
        .is_match(&p)
    {
        return Some("docs");
    }
    if REVIEW
        .get_or_init(|| {
            Regex::new(r"(?:(?-u:\b)review|rating|versus|vs(?-u:\b)|comparison|benchmark)")
                .expect("static regex")
        })
        .is_match(&p)
    {
        return Some("review");
    }
    if PRICING
        .get_or_init(|| {
            Regex::new(r"(?:(?-u:\b)pricing|price|cost|plans?|subscription(?-u:\b))")
                .expect("static regex")
        })
        .is_match(&p)
    {
        return Some("pricing");
    }
    None
}

/* ── strong entities & generic-word anchor guards (audit 2026-11-02) ─── */

/// ⇔ TS `strongEntities` (95-110): the strict ENTITY_PATTERNS ONLY, NO
/// loose `tokenize()` content-word fallback. Loose words remain in
/// [`extract_entities`] for coverage SCORING, but query CONSTRUCTION on
/// them poisoned SERPs — quoting every generic content word produced
/// over-constrained zero-hit SERPs (task-scope audit 2026-11-02,
/// brief #4). Mirrors TS `strongEntities` verbatim.
fn strong_entities(prompt: &str) -> Vec<String> {
    let head = js_slice_max(prompt, 600);
    let mut out: Vec<String> = Vec::new();
    for re in entity_patterns() {
        for m in re.find_iter(&head) {
            out.push(js_trim(m.as_str()).to_string());
        }
    }
    // Dedupe (case-insensitive, first wins)
    let mut seen = HashSet::new();
    out.retain(|e| seen.insert(e.to_lowercase()));
    out.into_iter().take(10).collect()
}

/// ⇔ TS `stripQuotes` (117-119): removes the wrapping quote characters
/// (U+0022/U+201C/U+201D/U+0027) a quoted-phrase entity carries so
/// re-quoting never yields `""…""`. JS anchors `^`/`$` (no /m) ported as
/// `\A`/`\z` per house rule; `/g` ⇒ `replace_all`.
static RE_QUOTE_EDGES: OnceLock<Regex> = OnceLock::new();
fn strip_quotes(e: &str) -> String {
    let s = RE_QUOTE_EDGES
        .get_or_init(|| {
            Regex::new("\\A[\"\u{201C}\u{201D}']|[\"\u{201C}\u{201D}']\\z")
                .expect("static regex")
        })
        .replace_all(e, "")
        .to_string();
    js_trim(&s).to_string()
}

/// ⇔ TS `GENERIC_QUERY_WORDS` (175-182): generic action/descriptor words
/// that must NEVER anchor a quoted targeted query on their own — a quoted
/// `"price"` or `"order"` returns junk (the `pricing "price"` regression,
/// brief #4 bug 2). Vision hints can surface these, so the targeted-step
/// base selection skips them and falls back to the keyword gate query.
/// Mirrored verbatim from TS.
const GENERIC_QUERY_WORDS: [&str; 36] = [
    "price", "prices", "pricing", "cost", "costs", "book", "booking", "buy", "order", "orders",
    "search", "find", "check", "look", "latest", "current", "official", "site", "website", "docs",
    "documentation", "review", "reviews", "news", "near", "nearby", "weather", "delivery", "menu",
    "product", "products", "ticket", "tickets", "showtime", "showtimes", "profile",
];

/* ── planner ─────────────────────────────────────────────────────────── */

/// ⇔ TS `PlannedQuery["origin"]` (221). `"gap"` is declared but never
/// produced here (divergence #7 / TS quirk). Serde labels match TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanOrigin {
    Semantic,
    Entity,
    Targeted,
    /// TS quirk: declared in the union, never emitted by `planQueries`.
    Gap,
    /// Task-scope audit 2026-11-02 (brief #4): REPLACED the old
    /// `"deep-brand"` origin whose domain was a fabricated guess
    /// (`site:what.com`, `blinkitcom.com`, …). Emitted only by the scope
    /// step (1b): a VERIFIED target host's `site:` companion, or a bare
    /// quoted-phrase discovery query for an unresolved target.
    Scope,
    /// P4: emitted by the planner law (`planner_law::apply_planner_law`)
    /// for site-scoped companions of allowed/preferred domains. Never
    /// produced by `plan_queries` itself.
    Preferred,
}

/// ⇔ TS `PlannedQuery` (206-224). `intent` carries the TS-only labels via
/// [`Intent::Other`] (divergence #6); `freshness` is always `None` here —
/// `planQueries` never sets it (TS quirk kept: field declared, dead).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedQuery {
    pub query: String,
    pub intent: Intent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_domains: Option<Vec<String>>,
    pub origin: PlanOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freshness: Option<crate::types::Freshness>,
}

/// ⇔ TS `mergeEntities` (231-242).
fn merge_entities(hints: &[String], auto: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for e in hints.iter().chain(auto.iter()) {
        let t = js_trim(e);
        if t.is_empty() || js_len(t) < 2 || seen.contains(&t.to_lowercase()) {
            continue;
        }
        seen.insert(t.to_lowercase());
        out.push(t.to_string());
        if out.len() >= 12 {
            break;
        }
    }
    out
}

/// ⇔ TS `planQueries` (204-394, exported). No LLM leg — deterministic.
///
/// `scope` (task-scope audit 2026-11-02, brief #3/#4/#6): the
/// server-derived task scope (task_scope.rs). A RESOLVED target's
/// VERIFIED host gets a `site:` companion on the broad query; an
/// UNRESOLVED target gets a bounded discovery query on its bare quoted
/// phrase — NEVER a guessed domain. Scope plans are spliced in right
/// after the first semantic plan so the `take(4)` tail-drop can never
/// starve them. The model never sees or widens this contract.
pub fn plan_queries(
    user_prompt: &str,
    gate_queries: &[SearchQuery],
    entity_hints: Option<&[String]>,
    scope: Option<&TaskScope>,
) -> Vec<PlannedQuery> {
    let mut plans: Vec<PlannedQuery> = Vec::new();

    // 1. Broad semantic query — URL-shaped gate queries are dropped by
    // stripUrlPlans (all-URL case keeps the raw plans — shipped quirk).
    let sp: Vec<SearchPlan> = gate_queries
        .iter()
        .map(|q| SearchPlan {
            query: q.query.clone(),
            intent: q.intent.clone(),
            preferred_domains: q.preferred_domains.clone(),
            freshness: None,
            relevance_anchor: None,
        })
        .collect();
    let keyword_gate_queries = strip_url_plans(&sp);
    for q in keyword_gate_queries.iter().take(2) {
        plans.push(PlannedQuery {
            query: q.query.clone(),
            intent: q.intent.clone(),
            preferred_domains: q.preferred_domains.clone(),
            origin: PlanOrigin::Semantic,
            freshness: None,
        });
    }
    if plans.is_empty() {
        plans.push(PlannedQuery {
            query: js_slice_max(js_trim(&collapse_ws(user_prompt)), 200),
            intent: Intent::General,
            preferred_domains: None,
            origin: PlanOrigin::Semantic,
            freshness: None,
        });
    }

    // 1b. Task-scope queries (audit 2026-11-02, brief #3/#4/#6): the
    // scope contract — and ONLY the contract — decides what gets a
    // site: companion. NO brand tokens, NO domain inference, NO brand
    // lists. A resolved target's VERIFIED host rides the broad query; an
    // unresolved target gets a bounded discovery query on its bare
    // quoted phrase (discovery to RESOLVE the destination, capped at 2).
    // The ambiguous state gets nothing here — ambiguity routes to a
    // clarification upstream in the scope contract.
    if let Some(scope) = scope {
        // `plans[0]?.query ?? …` — plans is never empty after step 1;
        // the ?? arm is dead in TS and kept dead here.
        let broad = plans
            .first()
            .map(|p| p.query.clone())
            .unwrap_or_else(|| js_slice_max(js_trim(&collapse_ws(user_prompt)), 200));
        let mut scope_plans: Vec<PlannedQuery> = Vec::new();
        for t in &scope.targets {
            if scope_plans.len() >= 2 {
                break;
            }
            if t.state == TargetState::Resolved && !t.host.is_empty() {
                scope_plans.push(PlannedQuery {
                    query: js_slice_max(&format!("{broad} site:{}", t.host), 200),
                    intent: Intent::General,
                    preferred_domains: Some(vec![t.host.clone()]),
                    origin: PlanOrigin::Scope,
                    freshness: None,
                });
            } else if t.state == TargetState::Unresolved && !t.phrase.is_empty() {
                let phrase = strip_quotes(&t.phrase);
                if !phrase.is_empty() {
                    scope_plans.push(PlannedQuery {
                        query: js_slice_max(&format!("\"{phrase}\""), 200),
                        intent: Intent::General,
                        preferred_domains: None,
                        origin: PlanOrigin::Scope,
                        freshness: None,
                    });
                }
            }
        }
        // `plans.splice(1, 0, …)`: insert right after the first semantic
        // plan — the plan cap drops from the TAIL, so scope companions
        // survive the 4-query ceiling.
        for (i, plan) in scope_plans.into_iter().enumerate() {
            plans.insert(1 + i, plan);
        }
    }

    let empty: Vec<String> = Vec::new();
    let strong = merge_entities(
        entity_hints.unwrap_or(&empty),
        &strong_entities(user_prompt),
    );
    let cls = source_class(user_prompt);

    // 2. Exact entity / technical query — quoted STRONG entities survive
    // the search engine's paraphrase. Only fires with 2+ strict-pattern
    // entities; the loose content words were removed from construction
    // (quoting them produced over-constrained zero-hit SERPs, brief #4).
    // Quoting decided via strip_quotes so quoted-phrase entities never
    // double-quote.
    if strong.len() >= 2 && plans.len() < 3 {
        let ent_query = js_slice_max(
            &strong
                .iter()
                .take(4)
                .map(|e| format!("\"{}\"", strip_quotes(e)))
                .filter(|q| js_len(q) > 2)
                .collect::<Vec<_>>()
                .join(" "),
            200,
        );
        plans.push(PlannedQuery {
            query: ent_query,
            intent: match cls {
                Some("github") => Intent::Code,
                Some("docs") => Intent::Docs,
                _ => Intent::General,
            },
            preferred_domains: None,
            origin: PlanOrigin::Entity,
            freshness: None,
        });
    }

    // 3. Targeted source query — operator injection for the detected
    // class. The anchor is the first STRONG entity that is not a generic
    // action word (the `pricing "price"` regression, brief #4 bug 2);
    // else the unquoted keyword gate query; else raw prompt words.
    // Quoting is decided ONCE here — never per operator branch.
    if let Some(cls) = cls {
        if plans.len() < 4 {
            let non_generic = strong.iter().find(|e| {
                let k = strip_quotes(e).to_lowercase();
                !GENERIC_QUERY_WORDS.contains(&k.as_str())
            });
            let base: String;
            let anchor: String;
            if let Some(e) = non_generic {
                base = strip_quotes(e);
                anchor = format!("\"{base}\"");
            } else if !keyword_gate_queries.is_empty() {
                base = keyword_gate_queries[0].query.clone();
                anchor = base.clone();
            } else {
                base = js_slice_max(js_trim(&collapse_ws(user_prompt)), 80);
                anchor = base.clone();
            }
            let mut op_query = String::new();
            let mut op_intent = Intent::General;
            let mut domains: Option<Vec<String>> = None;
            match cls {
                "pdf" => {
                    op_query = format!("filetype:pdf {anchor}");
                    op_intent = Intent::Other("pdf".into());
                }
                "github" => {
                    op_query = format!("site:github.com {anchor}");
                    op_intent = Intent::Other("github".into());
                    domains = Some(vec!["github.com".into()]);
                }
                "docs" => {
                    op_query = format!("documentation {anchor}");
                    op_intent = Intent::Docs;
                }
                "review" => {
                    op_query = format!("review {anchor}");
                    op_intent = Intent::Other("review".into());
                }
                "pricing" => {
                    op_query = format!("pricing {anchor}");
                    op_intent = Intent::Other("pricing".into());
                }
                "linkedin" => {
                    // Person lookup: anchor on the NAME SPAN; profiles are
                    // indexed on the regional subdomain. The INSIDE-case
                    // push below AND the after-switch push fire for every
                    // linkedin class ⇒ the query is emitted TWICE
                    // (`…in.linkedin.com` first, then `…linkedin.com/in/`)
                    // — TS quirk kept verbatim.
                    static RE_URL: OnceLock<Regex> = OnceLock::new();
                    static RE_TRIGGER: OnceLock<Regex> = OnceLock::new();
                    static RE_QUOTES: OnceLock<Regex> = OnceLock::new();
                    static RE_NAME_SPAN: OnceLock<Regex> = OnceLock::new();
                    let name_span = {
                        let s = RE_URL
                            .get_or_init(|| Regex::new(r"(?i)https?://\S+").expect("static regex"))
                            .replace_all(user_prompt, " ");
                        let s = RE_TRIGGER
                            .get_or_init(|| {
                                Regex::new(concat!(
                                    r"(?i)(?-u:\b)(?:can|could|would|should|will|you|your|please|i|we|want|",
                                    r"need|like|try|to|find|search|look|see|show|check|up|this|that|these|",
                                    r"those|the|my|me|a|an|on|in|at|of|for|from|help|profile|person|guy|",
                                    r"woman|man|candidate|employee|name|linked ?in|linkedin|lnkd\.in)(?-u:\b)",
                                ))
                                .expect("static regex")
                            })
                            .replace_all(&s, " ");
                        let s = RE_QUOTES
                            .get_or_init(|| {
                                Regex::new("[\"\u{201C}\u{201D}']").expect("static regex")
                            })
                            .replace_all(&s, " ");
                        let s = collapse_ws(&s);
                        js_trim(&s).to_string()
                    };
                    // JS /^[a-zÀ-ÿ' .-]+$/i — \A..\z (JS $ without /m is the
                    // absolute end; Rust's $ also allows a trailing \n).
                    let person_anchor = if js_len(&name_span) >= 3
                        && RE_NAME_SPAN
                            .get_or_init(|| {
                                Regex::new(r"(?i)\A[a-z\u{C0}-\u{FF}' .-]+\z")
                                    .expect("static regex")
                            })
                            .is_match(&name_span)
                    {
                        format!("\"{}\"", js_slice_max(&name_span, 80))
                    } else if strong.len() >= 2 {
                        format!(
                            "\"{}\" \"{}\"",
                            strip_quotes(&strong[0]),
                            strip_quotes(&strong[1])
                        )
                    } else {
                        anchor.clone()
                    };
                    op_query = format!("{person_anchor} site:in.linkedin.com");
                    op_intent = Intent::General;
                    domains = Some(vec!["linkedin.com".into()]);
                    if plans.len() < 4 {
                        plans.push(PlannedQuery {
                            query: format!("{person_anchor} site:linkedin.com/in/"),
                            intent: Intent::General,
                            preferred_domains: domains.clone(),
                            origin: PlanOrigin::Targeted,
                            freshness: None,
                        });
                    }
                }
                _ => {}
            }
            if !op_query.is_empty() {
                plans.push(PlannedQuery {
                    query: op_query,
                    intent: op_intent,
                    preferred_domains: domains,
                    origin: PlanOrigin::Targeted,
                    freshness: None,
                });
            }
        }
    }

    // (Step 4 was the deep-brand query — DELETED by the task-scope audit
    // 2026-11-02, brief #4: extractBrandTokens + inferBrandDomain
    // fabricated domains — `site:what.com` from a sentence-initial
    // "What", `blinkitcom.com` from the dot-strip-before-dot-test,
    // `order.com` for "Zepto", `foo.com` for `foo.community`. The
    // scope step (1b) above replaces it with VERIFIED hosts only.)

    plans.into_iter().take(4).collect()
}

/* ── coverage & gap evaluator ────────────────────────────────────────── */

/// ⇔ TS `CoverageReport` (400-411). `coverage` serializes through
/// `js_number_ser` (integral fractions print as `1`, matching
/// `JSON.stringify`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageReport {
    #[serde(serialize_with = "crate::types::js_number_ser::serialize")]
    pub coverage: f64,
    pub missing_entities: Vec<String>,
    pub needs_gap_search: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap_query: Option<String>,
}

/// ⇔ TS `evaluateCoverage` (424-461, exported). NOTE the TS comment claims
/// whole-word matching but the code is plain `includes` — substring
/// matching is ported verbatim (divergence #9).
pub fn evaluate_coverage(user_prompt: &str, retrieved_passages: &[String]) -> CoverageReport {
    let entities = extract_entities(user_prompt);
    if entities.is_empty() {
        return CoverageReport {
            coverage: 1.0,
            missing_entities: Vec::new(),
            needs_gap_search: false,
            gap_query: None,
        };
    }

    // Concatenate all retrieved text into one haystack
    let haystack = retrieved_passages.join(" ").to_lowercase();
    let hit_set: HashSet<usize> = entities
        .iter()
        .enumerate()
        .filter(|(_, e)| haystack.contains(&e.to_lowercase()))
        .map(|(i, _)| i)
        .collect();
    let hits = hit_set.len();

    let coverage = hits as f64 / entities.len() as f64;
    let missing: Vec<String> = entities
        .iter()
        .enumerate()
        .filter(|(i, _)| !hit_set.contains(i))
        .map(|(_, e)| e.clone())
        .collect();
    let cls = source_class(user_prompt);

    let needs_gap_search = (coverage < 0.5 && !missing.is_empty()) || retrieved_passages.len() < 2;

    let mut gap_query: Option<String> = None;
    if needs_gap_search && !missing.is_empty() {
        let quoted = missing
            .iter()
            .take(3)
            .map(|e| {
                if js_len(e) > 3 {
                    format!("\"{e}\"")
                } else {
                    e.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        gap_query = Some(match cls {
            Some("github") => format!("site:github.com {quoted}"),
            Some("pdf") => format!("filetype:pdf {quoted}"),
            _ => quoted,
        });
    }

    CoverageReport {
        coverage,
        missing_entities: missing,
        needs_gap_search,
        gap_query,
    }
}

/// ⇔ TS `runGapMetasearch` (468-475). Divergence #8: Rust takes the
/// [`Net`] seam as an extra first parameter (TS closes over the ambient
/// real net).
pub async fn run_gap_metasearch(net: &dyn Net, gap_query: &str) -> Vec<RankedResult> {
    let cls = source_class(gap_query);
    let intent = match cls {
        Some("github") => Intent::Code,
        Some("pdf") => Intent::Academic,
        _ => Intent::General,
    };
    let plan = SearchPlan {
        query: gap_query.to_string(),
        intent,
        preferred_domains: None,
        freshness: None,
        relevance_anchor: None,
    };
    metasearch(net, &[plan], 8).await
}

/* ── tests (deterministic; zero network — ScriptedNet only) ─────────── */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::ScriptedNet;

    fn q(query: &str) -> SearchQuery {
        SearchQuery {
            query: query.into(),
            intent: Intent::General,
            preferred_domains: None,
        }
    }

    #[test]
    fn entity_patterns_basic_extraction() {
        let e = extract_entities(
            "CrashLoopBackOff on Kubernetes v1.2.3 \"node not ready\" error handling function timeout",
        );
        // version number, quoted phrase, error string, ident+noun all present
        assert!(e.iter().any(|x| x == "v1.2.3"), "{e:?}");
        assert!(e.iter().any(|x| x == "\"node not ready\""), "{e:?}");
        assert!(e.iter().any(|x| x.starts_with("error")), "{e:?}");
        assert!(e.iter().any(|x| x.contains("function")), "{e:?}");
        assert!(!e.is_empty());
    }

    #[test]
    fn version_pattern_matches_js_backtracking_quirk() {
        // JS /\bv\d+(\.\d+)+\b/ on "v1.2.34x" matches "v1.2" (the greedy
        // (?:\.\d+)+ backtracks until the trailing \b holds). The regex
        // crate's leftmost-first semantics agree.
        let e = extract_entities("upgrading v1.2.34x today");
        assert!(e.iter().any(|x| x == "v1.2"), "{e:?}");
        assert!(!e.iter().any(|x| x.contains(".34")), "{e:?}");
    }

    #[test]
    fn entities_capped_at_ten_dedup_ci() {
        let e = extract_entities("Rust crate rust CRATE crate");
        let mut seen = HashSet::new();
        for x in &e {
            assert!(seen.insert(x.to_lowercase()), "ci-dup leaked: {e:?}");
        }
        assert!(e.len() <= 10);
    }

    /* ── task-scope audit regressions (brief #4, 2026-11-02) ─────────── */

    fn scope_resolved(host: &str) -> TaskScope {
        use crate::task_scope::{SiteTarget, TaskIntent, TargetProvenance};
        TaskScope {
            intent: TaskIntent::Operate,
            targets: vec![SiteTarget {
                phrase: host.into(),
                state: TargetState::Resolved,
                host: host.into(),
                url: String::new(),
                candidates: Vec::new(),
                provenance: TargetProvenance::ExplicitDomain,
            }],
            excluded_phrases: Vec::new(),
            authorized_hosts: Vec::new(),
        }
    }

    fn scope_unresolved(phrase: &str) -> TaskScope {
        use crate::task_scope::{SiteTarget, TaskIntent, TargetProvenance};
        TaskScope {
            intent: TaskIntent::Operate,
            targets: vec![SiteTarget {
                phrase: phrase.into(),
                state: TargetState::Unresolved,
                host: String::new(),
                url: String::new(),
                candidates: Vec::new(),
                provenance: TargetProvenance::NoProvenance,
            }],
            excluded_phrases: Vec::new(),
            authorized_hosts: Vec::new(),
        }
    }

    #[test]
    fn planner_never_fabricates_domains_from_prompt() {
        // The old brand path emitted `site:what.com` (sentence-initial
        // "What") and `site:kingfisher…` here. Without a VERIFIED scope
        // host, NO plan may carry a `site:` operator at all for a
        // non-github/linkedin class.
        let plans = plan_queries(
            "What is the price of kingfisher beer 650ml on the official site?",
            &[],
            None,
            None,
        );
        assert!(
            plans.iter().all(|p| !p.query.contains("site:")),
            "{plans:?}"
        );
    }

    #[test]
    fn plan_queries_scope_resolved_host_gets_site_companion() {
        let plans = plan_queries(
            "order milk",
            &[q("order milk groceries")],
            None,
            Some(&scope_resolved("zepto.com")),
        );
        // Companion spliced right after the broad query (TS splice(1,0,…)).
        assert_eq!(plans[1].origin, PlanOrigin::Scope);
        assert_eq!(plans[1].query, "order milk groceries site:zepto.com");
        assert_eq!(
            plans[1].preferred_domains.as_deref(),
            Some(&["zepto.com".to_string()][..])
        );
    }

    #[test]
    fn plan_queries_scope_unresolved_bare_phrase_discovery() {
        // "Order milk on Zepto": the old path fabricated site:order.com /
        // site:zepto…; now discovery is the BARE quoted phrase only.
        let plans = plan_queries(
            "Order milk on Zepto",
            &[],
            None,
            Some(&scope_unresolved("Zepto")),
        );
        let scope_plans: Vec<&PlannedQuery> = plans
            .iter()
            .filter(|p| p.origin == PlanOrigin::Scope)
            .collect();
        assert_eq!(scope_plans.len(), 1, "{plans:?}");
        assert_eq!(scope_plans[0].query, "\"Zepto\"");
        assert!(
            plans.iter().all(|p| !p.query.contains("site:")),
            "{plans:?}"
        );
    }

    #[test]
    fn plan_queries_scope_companion_survives_query_cap() {
        // Brief #6: an explicit target survives the 4-query budget.
        let plans = plan_queries(
            "read the documentation for rust tokio runtime",
            &[q("q one"), q("q two"), q("q three"), q("q four")],
            None,
            Some(&scope_resolved("tokio.rs")),
        );
        assert!(plans.len() <= 4, "{plans:?}");
        assert!(
            plans
                .iter()
                .any(|p| p.origin == PlanOrigin::Scope
                    && p.query.ends_with(" site:tokio.rs")),
            "{plans:?}"
        );
    }

    #[test]
    fn plan_queries_generic_words_never_anchor_targeted_operators() {
        // The old step-3 anchored targeted operators on the first entity,
        // producing `pricing "price"`. Generic hint words must never
        // anchor; the keyword-gate query is the unquoted anchor.
        let plans = plan_queries(
            "check the latest prices",
            &[q("latest movie showtimes pvr")],
            Some(&["price".into(), "latest".into()]),
            None,
        );
        assert!(
            plans.iter().any(|p| p.origin == PlanOrigin::Targeted
                && p.query == "pricing latest movie showtimes pvr"),
            "{plans:?}"
        );
    }

    #[test]
    fn plan_queries_semantic_from_gate_and_url_quirk() {
        let plans = plan_queries(
            "compare react and vue performance",
            &[q("https://example.com/blog"), q("react vue performance")],
            None,
            None,
        );
        // URL-shaped gate query stripped; keyword one kept first
        assert_eq!(plans[0].query, "react vue performance");
        assert_eq!(plans[0].origin, PlanOrigin::Semantic);

        // ALL gate queries are URLs ⇒ stripUrlPlans keeps the raw plans
        // (shipped TS quirk) so an origin-semantic URL plan survives.
        let plans = plan_queries("x", &[q("https://only.example/one")], None, None);
        assert_eq!(plans[0].query, "https://only.example/one");
    }

    #[test]
    fn plan_queries_empty_gate_falls_back_to_prompt() {
        let plans = plan_queries("deep multi\n\twrapped   prompt here", &[], None, None);
        assert_eq!(plans[0].query, "deep multi wrapped prompt here");
        assert_eq!(plans[0].intent, Intent::General);
    }

    #[test]
    fn plan_queries_linkedin_pushes_twice() {
        // TS quirk: linkedin class pushes the regional subdomain plan
        // inside the switch AND the operator plan after the switch.
        let plans = plan_queries(
            "can you find this profile name John Doe in linkedin",
            &[],
            None,
            None,
        );
        let targeted: Vec<&PlannedQuery> = plans
            .iter()
            .filter(|p| p.origin == PlanOrigin::Targeted)
            .collect();
        assert!(
            targeted
                .iter()
                .any(|p| p.query.ends_with("site:in.linkedin.com") && p.query.starts_with('"')),
            "{plans:?}"
        );
        assert!(
            targeted
                .iter()
                .any(|p| p.query.ends_with("site:linkedin.com/in/")),
            "{plans:?}"
        );
        assert!(targeted
            .iter()
            .all(|p| p.preferred_domains.as_deref() == Some(&["linkedin.com".to_string()][..])));
    }

    #[test]
    fn plan_queries_class_operators_and_cap() {
        let plans = plan_queries(
            "read the whitepaper on transformers architecture",
            &[],
            None,
            None,
        );
        // sourceClass=pdf ⇒ filetype:pdf targeted plan. The audit fixed
        // the anchor: the prompt fallback is UNQUOTED (the old code
        // emitted `filetype:pdf "read the whitepaper…"` with a quoted
        // base that over-constrained the SERP).
        assert!(
            plans.iter().any(|p| p.query.starts_with("filetype:pdf ")
                && !p.query.contains('"')),
            "{plans:?}"
        );
        assert!(plans
            .iter()
            .any(|p| p.intent == Intent::Other("pdf".into())));
        assert!(plans.len() <= 4);
    }

    #[test]
    fn entity_query_quotes_long_entities() {
        let plans = plan_queries(
            "Gandalf Mordor",
            &[],
            Some(&["Gandalf".into(), "Mordor".into()]),
            None,
        );
        let ent = plans.iter().find(|p| p.origin == PlanOrigin::Entity);
        assert!(ent.is_some(), "{plans:?}");
        assert_eq!(ent.unwrap().query, "\"Gandalf\" \"Mordor\"");
    }

    #[test]
    fn evaluate_coverage_gap_and_substring_quirk() {
        // substring matching quirk: "cat" counts as hit by "catastrophe".
        // TS quirk: extractEntities emits "v1.2.3" twice-ish — once from
        // the version pattern, once as "v1" via reranker tokenize (which
        // strips the dots), so 3 entities → coverage 1/3 < 0.5 and the
        // gap search fires even though "cat" substring-hit. gapQuery
        // quotes only the >3-char missing entity ("v1" stays bare).
        let rep = evaluate_coverage(
            "cat v1.2.3",
            &["catastrophe 1.2.3 details".into(), "more".into()],
        );
        assert!((rep.coverage - 1.0 / 3.0).abs() < 1e-9, "{rep:?}");
        assert_eq!(rep.missing_entities, ["v1.2.3", "v1"]);
        assert!(rep.needs_gap_search, "{rep:?}");
        assert_eq!(rep.gap_query.as_deref(), Some("\"v1.2.3\" v1"));

        let rep = evaluate_coverage("blinkit grocery v1.2.3", &["nothing relevant here".into()]);
        assert!(rep.needs_gap_search); // < 2 passages AND missing entities
        assert!(!rep.missing_entities.is_empty());
        let gq = rep.gap_query.expect("gap query");
        assert!(!gq.starts_with("site:github.com"), "{gq}");
    }

    #[test]
    fn evaluate_coverage_github_class_gap_prefix() {
        let rep = evaluate_coverage("github repo crashdump v9.9.9", &["unrelated".into()]);
        let gq = rep.gap_query.expect("gap query");
        assert!(gq.starts_with("site:github.com "), "{gq}");
    }

    #[test]
    fn evaluate_coverage_no_entities_full_coverage() {
        // entities always include tokenize() words, so craft empty prompt
        let rep = evaluate_coverage("", &[]);
        assert_eq!(rep.coverage, 1.0);
        assert!(!rep.needs_gap_search);
        assert_eq!(rep.gap_query, None);
    }

    #[tokio::test]
    async fn run_gap_metasearch_intent_mapping_and_net_seam() {
        // ScriptedNet with NO routes ⇒ every engine fetch misses ⇒ empty.
        // (Zero network; exercises the net seam + intent mapping only.)
        // run_gap_metasearch → metasearch → engines: the (process-wide,
        // TS-parity) pacer/breaker statics are shared with engines' and
        // metasearch's tests, which serialize on engine_test_lock() and
        // reset the pacer map with try_lock — this test MUST hold the
        // same token or its live pacer trips their reset (divergence
        // note: cargo parallelism, recorded in the module header).
        let _serial = crate::engines::engine_test_lock().lock().await;
        let net = ScriptedNet::default();
        let res = run_gap_metasearch(&net, "site:github.com \"widget lib\"").await;
        assert!(res.is_empty());
        let calls = net.calls.lock().expect("lock");
        assert!(!calls.is_empty(), "engines should have attempted fetches");
        drop(calls);
        crate::engines::reset_engine_state_for_tests();
    }
}
