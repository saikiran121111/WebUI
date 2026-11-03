//! Task scope — the server-authoritative "which website is this turn about"
//! contract (task-scope audit 2026-11-02, brief items #1, #3, #5, #6).
//! RUST MIRROR of `lib/decision/task-scope.ts` — same tokenizer, same word
//! lists, same four passes, same resolution law. Parity is pinned by the
//! shared corpus `rust-backend/fixtures/task-scope/cases.json` ("the corpus
//! is the contract": the TS vitest harness and the `#[cfg(test)]` tests here
//! both replay the same 43 cases; neither side can drift without failing).
//!
//! ONE deterministic, pure, server-side interpretation of the user's own
//! words. No network, no model, no brand tables. Downstream planner/gate/
//! browser layers ENFORCE this scope — they never re-derive it, and model
//! tool arguments can never widen it (the only way a bare-name host is
//! filled in is [`resolve_target`] over ranked retrieval candidates the
//! server already fetched).
//!
//! Hard laws (user brief, verbatim intent):
//!  - NO hardcoded website names, brand→domain mappings, preferred TLDs,
//!    or blanket source bans anywhere in this module.
//!  - Explicit URLs/domains resolve via the PSL-aware url-detector ONLY
//!    (this retires the `site:what.com` / `blinkitcom.com` / `foo.community`
//!    bug family — no pascal-case brand guessing, no TLD invention).
//!  - Bare names bound by operational/source prepositions ("order milk on
//!    Zepto", "do this in Blinkit") become UNRESOLVED targets — never a
//!    guessed domain.
//!  - Incidental mentions (reported speech, generic noun phrases, names not
//!    bound by an operational/source preposition) never become scope.
//!  - `Operate` / `SiteInfo` / `CompareSites` are the enforceable intents;
//!    `Research` targets are topic mentions only — soft research
//!    preferences stay in the existing reranker layer (brief #5).
//!
//! KNOWN LIMITATION (parity-shared, documented): the corpus is ASCII-only.
//! Char-offset/`to_lowercase` semantics for non-ASCII target phrases are
//! untested territory on both sides.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

use crate::url_detector::detect_urls_and_domains;

// ─── Public contract (serde names = fixture key names) ─────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskIntent {
    #[serde(rename = "none")]
    NoScope,
    Research,
    SiteInfo,
    Operate,
    CompareSites,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetState {
    Unresolved,
    Resolved,
    Ambiguous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetProvenance {
    #[serde(rename = "none")]
    NoProvenance,
    ExplicitUrl,
    ExplicitDomain,
    ResolvedSearch,
    ResolvedCache,
    Ambiguous,
}

/// One site the turn is about. Field order is the serialization contract
/// (fixture byte-parity; mirror of `SiteTarget` in task-scope.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteTarget {
    /// Verbatim phrase from the user (case, spacing, punctuation preserved).
    pub phrase: String,
    pub state: TargetState,
    /// Verified registrable host (PSL), "" when unresolved/ambiguous.
    pub host: String,
    /// Exact verified URL when one was seen, "" otherwise.
    pub url: String,
    /// Candidate hosts when ambiguous (distinct, sorted, capped).
    pub candidates: Vec<String>,
    pub provenance: TargetProvenance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskScope {
    pub intent: TaskIntent,
    pub targets: Vec<SiteTarget>,
    /// Phrases the user explicitly excluded ("don't use reddit").
    pub excluded_phrases: Vec<String>,
    /// Extra hosts the user authorized (auth/pay hops), never primary targets.
    pub authorized_hosts: Vec<String>,
}

/// Enforcement law (brief #1/#3): research is NEVER scope-enforced.
pub fn is_enforceable_scope(scope: &TaskScope) -> bool {
    matches!(
        scope.intent,
        TaskIntent::Operate | TaskIntent::SiteInfo | TaskIntent::CompareSites
    )
}

/// Browser-activation law (brief #2/#3): a chat turn runs the BROWSER tool
/// loop only for an operational scope. The intent ladder makes `Operate`
/// structurally imply at least one target, so a browser turn always has a
/// site-bound destination to resolve before touching the engine. Research,
/// site-info and compare turns route through the scope-enforced research
/// path instead. Panel visibility NEVER decides this — the client's
/// `browser_session` marker is conversation identity only.
/// ⇔ `routesToBrowserTurn` in `lib/decision/task-scope.ts`.
pub fn routes_to_browser_turn(scope: &TaskScope) -> bool {
    scope.intent == TaskIntent::Operate
}

/// Distinct resolved hosts in scope order (for gate/planner/browser enforcement).
pub fn scope_hosts(scope: &TaskScope) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in &scope.targets {
        if t.state == TargetState::Resolved && !t.host.is_empty() && !out.contains(&t.host) {
            out.push(t.host.clone());
        }
    }
    for h in &scope.authorized_hosts {
        if !h.is_empty() && !out.contains(h) {
            out.push(h.clone());
        }
    }
    out
}

fn re_scheme() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://").unwrap())
}

/// PSL registrable host for a bare hostname or full URL string (None → null).
/// tldts.parse ⇔ psl::domain_str (see url_detector.rs module docs).
pub fn registrable_host(input: &str) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    let host = if re_scheme().is_match(input) {
        url::Url::parse(input)
            .ok()?
            .host_str()
            .map(|h| h.to_lowercase())?
    } else {
        input.split('/').next().unwrap_or("").to_lowercase()
    };
    if host.is_empty() {
        return None;
    }
    psl::domain_str(&host).map(str::to_string)
}

// ─── Word lists (pure language vocabulary — NO brands, NO TLD hints) ───────
// VERBATIM mirror of the TS sets; keep in lock-step on every change.

const PREPS: &[&str] = &["on", "from", "in", "at", "via", "through"];

// Operational verbs: things done AT/THROUGH a website. "get/got" deliberately
// absent (false-positive magnet). "open" is both operational and source-ish.
const OP_VERBS: &[&str] = &[
    "buy",
    "buys",
    "buying",
    "purchased",
    "purchases",
    "purchasing",
    "purchase",
    "ordered",
    "orders",
    "ordering",
    "order",
    "booked",
    "books",
    "booking",
    "book",
    "reserved",
    "reserves",
    "reserving",
    "reserve",
    "rented",
    "rents",
    "renting",
    "rent",
    "subscribed",
    "subscribes",
    "subscribing",
    "subscribe",
    "paid",
    "pays",
    "paying",
    "pay",
    "checkout",
    "add",
    "adds",
    "adding",
    "added",
    "deliver",
    "delivers",
    "delivered",
    "ship",
    "ships",
    "shipped",
    "shipping",
    "apply",
    "applies",
    "applying",
    "applied",
    "renew",
    "renews",
    "renewing",
    "upgrade",
    "upgrades",
    "upgrading",
    "use",
    "uses",
    "using",
    "used",
    "grab",
    "signup",
    "register",
    "registers",
    "do",
    "does",
    "did",
    "done",
    "doing",
    "open",
    "opens",
    "opening",
    // UI-action verbs (2026-11-03 audit #2): "Click the login button on
    // example.com" must be OPERATE (browser routing accepts only operate),
    // so the click/tap/scroll/select/submit/fill family belongs in the
    // operational vocabulary. "type" deliberately absent (common noun magnet).
    "click",
    "clicks",
    "clicked",
    "clicking",
    "tap",
    "taps",
    "tapped",
    "tapping",
    "scroll",
    "scrolls",
    "scrolling",
    "select",
    "selects",
    "selecting",
    "submit",
    "submits",
    "submitting",
    "fill",
    "fills",
    "filling",
];

// Direct-object site-taking verbs (2026-11-03 audit #2): "Open Zepto",
// "Search Amazon for milk" — the verb's OBJECT is the destination itself.
// "buy/order/find" deliberately absent: their objects are entities, not
// sites ("Buy iPhone" must never scope iPhone as a website).
const DO_SITE_VERBS: &[&str] = &[
    "open",
    "opens",
    "opening",
    "visit",
    "visits",
    "visiting",
    "browse",
    "browses",
    "browsing",
    "search",
    "searches",
    "searched",
    "searching",
    "lookup",
    "lookups",
    "use",
    "uses",
    "using",
    "used",
    "navigate",
    "navigates",
    "navigating",
    "access",
    "accesses",
    "accessing",
    "launch",
    "launches",
    "launching",
];

// Scaffold words that can never be a direct-object site ("Open the login
// page", "Open my account" ⇒ nothing, not a "login"/"account" website).
const DO_SCAFFOLD: &[&str] = &[
    "login",
    "logins",
    "signin",
    "button",
    "buttons",
    "link",
    "links",
    "tab",
    "tabs",
    "form",
    "forms",
    "menu",
    "menus",
    "setting",
    "settings",
    "search",
    "bar",
    "screen",
    "window",
    "dashboard",
    "account",
    "page",
    "pages",
    "app",
    "apps",
    "site",
    "website",
];

// Coordinating conjunctions END the Pass-3 backward scan: an eligible verb
// from a different coordinated instruction must not license this NP.
const CONJ_STOPS: &[&str] = &["and", "or", "but", "then", "nor"];

const FIND_VERBS: &[&str] = &[
    "find",
    "finds",
    "finding",
    "search",
    "searches",
    "searched",
    "searching",
    "check",
    "checks",
    "checked",
    "checking",
    "read",
    "reads",
    "see",
    "sees",
    "show",
    "shows",
    "showing",
    "browse",
    "browses",
    "browsing",
    "explore",
    "explores",
    "exploring",
    "look",
    "looks",
    "looking",
    "lookup",
    "lookups",
    "track",
    "tracks",
    "tracking",
    "visit",
    "visits",
    "visiting",
    "open",
    "opens",
    "opening",
    "review",
    "reviews",
    "reviewed",
    "rate",
    "rates",
    "rated",
    "watch",
    "watches",
    "watching",
];

const CUE_NOUNS: &[&str] = &[
    "price",
    "prices",
    "cost",
    "costs",
    "rate",
    "rates",
    "pricing",
    "menu",
    "menus",
    "stock",
    "availability",
    "review",
    "reviews",
    "rating",
    "ratings",
    "deal",
    "deals",
    "offer",
    "offers",
    "discount",
    "discounts",
    "coupon",
    "coupons",
    "delivery",
    "shipping",
    "listing",
    "listings",
    "status",
    "catalog",
    "catalogue",
    "invoice",
    "receipt",
    "balance",
    "order",
    "orders",
    "cart",
    "checkout",
    "subscription",
];

const COMPARE_WORDS: &[&str] = &[
    "compare",
    "compares",
    "compared",
    "comparison",
    "comparing",
    "vs",
    "versus",
];
const COMPARE_ADJ: &[&str] = &["better", "worse", "cheaper", "costlier", "faster", "slower"];

// Generic sentence-scaffold words. A noun phrase that STARTS with one of
// these is never a site name — this (plus the detector-only path) is what
// retired the `site:what.com` bug: sentence-initial "What" can no longer
// become a "brand".
const GENERIC_FIRST: &[&str] = &[
    "what",
    "when",
    "where",
    "why",
    "how",
    "who",
    "whom",
    "whose",
    "which",
    "whether",
    // protocol words are sentence scaffolding, never site names ("https" as
    // an NP head would otherwise fabricate the phrase "https www.x.com").
    "http",
    "https",
    "www",
    "the",
    "a",
    "an",
    "some",
    "any",
    "no",
    "not",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "i",
    "you",
    "he",
    "she",
    "we",
    "they",
    "them",
    "me",
    "my",
    "your",
    "his",
    "her",
    "our",
    "their",
    "every",
    "each",
    "both",
    "either",
    "neither",
    "all",
    "most",
    "more",
    "less",
    "few",
    "many",
    "several",
    "one",
    "two",
    "three",
    "another",
    "other",
    "others",
    "such",
    "own",
    "best",
    "better",
    "top",
    "cheapest",
    "cheap",
    "expensive",
    "official",
    "online",
    "new",
    "latest",
    "same",
    "nearby",
    "local",
    "recent",
    "current",
    "general",
    "store",
    "stores",
    "shop",
    "shops",
    "market",
    "markets",
    "mall",
    "malls",
    "website",
    "websites",
    "site",
    "sites",
    "app",
    "apps",
    "platform",
    "platforms",
    "portal",
    "portals",
    "page",
    "pages",
    "internet",
    "web",
    "home",
    "house",
    "office",
    "offices",
    "city",
    "town",
    "country",
    "state",
    "district",
    "area",
    "region",
    "place",
    "near",
    "nearest",
    "different",
    "order",
    "orders",
    "cart",
    "checkout",
    "milk",
    "beer",
    "wine",
    "water",
    "bread",
    "egg",
    "eggs",
    "coffee",
    "tea",
    "juice",
    "soda",
    "snack",
    "snacks",
    "grocery",
    "groceries",
    "vegetable",
    "vegetables",
    "fruit",
    "fruits",
    "food",
    "meal",
    "meals",
    "ticket",
    "tickets",
    "seat",
    "seats",
    "table",
    "tables",
    "room",
    "rooms",
    "hotel",
    "hotels",
    "flight",
    "flights",
    "cab",
    "cabs",
    "car",
    "cars",
    "bike",
    "bikes",
    "scooter",
    "job",
    "jobs",
    "movie",
    "movies",
    "song",
    "songs",
    "book",
    "books",
    "gift",
    "gifts",
    "flower",
    "flowers",
    "medicine",
    "medicines",
    "pill",
    "pills",
    "phone",
    "phones",
    "laptop",
    "laptops",
    "shoe",
    "shoes",
    "shirt",
    "shirts",
    "dress",
    "dresses",
    "saree",
    "kurta",
];

// NP terminators (function words).
const STOP_TOKENS: &[&str] = &[
    "on", "in", "at", "from", "via", "through", "to", "for", "with", "about", "of", "and", "or",
    "but", "so", "then", "than", "that", "this", "these", "those", "who", "which", "as", "by",
    "up", "down", "out", "into", "over", "under", "again", "now", "here", "there", "today",
    "tonight", "tomorrow", "my", "your", "his", "her", "their", "our", "its", "me", "you", "he",
    "she", "they", "it", "not", "please", "pls", "vs", "versus",
];

// Words stripped from the END of a noun phrase ("Blinkit App" → "Blinkit").
const TRAILING_STRIP: &[&str] = &[
    "app", "website", "site", "platform", "portal", "online", "order", "orders", "cart",
    "checkout", "page", "pages", "account", "delivery", "now", "today", "here", "there", "quickly",
    "pls", "please", "side",
];

const ARTICLES: &[&str] = &["the", "a", "an"];
// Relative-pronoun follow-ups mean the NP was a sentence subject, not an
// object of the preposition ("I read on reddit THAT blinkit raised…").
const POST_NP_REJECT: &[&str] = &["that", "which", "who", "was", "were"];

const ONLY_LEAD: &[&str] = &["only", "just", "strictly"];
const ONLY_VERB: &[&str] = &[
    "use",
    "uses",
    "using",
    "used",
    "from",
    "on",
    "via",
    "through",
    "search",
    "searches",
    "searched",
    "searching",
    "check",
    "checks",
    "checking",
    "browse",
    "browses",
    "browsing",
    "order",
    "orders",
    "ordering",
    "buy",
    "buys",
    "buying",
];
const EXCL_LEAD: &[&str] = &[
    "don't",
    "dont",
    "never",
    "avoid",
    "avoided",
    "avoiding",
    "without",
    "exclude",
    "excluding",
];
const EXCL_VERB: &[&str] = &[
    "use",
    "using",
    "uses",
    "used",
    "from",
    "on",
    "via",
    "through",
    "search",
    "searching",
    "searched",
    "check",
    "checking",
    "browse",
    "browsing",
    "order",
    "ordering",
    "order",
    "buy",
    "buying",
    "see",
    "seeing",
    "show",
    "showing",
];
const AUTH_LEAD1: &[&str] = &["allowed", "permitted"];
const AUTH_VERB: &[&str] = &[
    "use", "visit", "open", "check", "go", "login", "signin", "sign", "pay", "try",
];

const RESEARCH_CUE_WORDS: &[&str] = &[
    "search",
    "searches",
    "searching",
    "research",
    "latest",
    "current",
    "recent",
    "news",
    "explain",
];
const INTERROG: &[&str] = &["who", "what", "when", "where", "why", "how", "which"];
const COPULAS: &[&str] = &[
    "is", "was", "are", "were", "will", "would", "can", "could", "does", "did", "has", "have",
];
const FOLLOW_CUES: &[&str] = &[
    "it", "its", "them", "this", "that", "same", "again", "too", "also", "then", "now", "but",
    "and", "here", "there",
];

fn in_list(list: &[&str], w: &str) -> bool {
    list.iter().any(|x| *x == w)
}

// ─── Tokenizer (shared law with task-scope.ts) ─────────────────────────────
// Punctuation never forms a token on its own; "." stays INSIDE tokens
// ("blinkit.com" is one token, so sentence dots inside domains don't split);
// clause boundaries are computed from the GAPS between tokens.

struct Tok {
    raw: String,
    clean: String, // lowercased, trailing sentence punct removed
    start: usize,  // byte offset (ASCII corpus — see module docs)
    end: usize,
}

fn re_token() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\p{L}\p{N}][\p{L}\p{N}'&_.+#-]*").unwrap())
}

/// JS `t.replace(/[.,;:!?"']+$/, "")` — strip the trailing run of these chars.
fn strip_tail_punct(t: &str) -> String {
    const CUT: &[char] = &['.', ',', ';', ':', '!', '?', '"', '\''];
    let n = t
        .char_indices()
        .rev()
        .take_while(|(_, c)| CUT.contains(c))
        .count();
    // char count → byte cut: all CUT chars are 1 byte, so the tail run is
    // exactly `n` bytes.
    t[..t.len() - n].to_string()
}

fn tokenize(s: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    for m in re_token().find_iter(s) {
        let raw = m.as_str().to_string();
        let clean = strip_tail_punct(&raw.to_lowercase());
        out.push(Tok {
            raw,
            clean,
            start: m.start(),
            end: m.end(),
        });
    }
    out
}

/// Head-length guard: JS `head.replace(/[.,]/g, "").length < 2`.
fn dotted_len_short(clean: &str) -> bool {
    clean.chars().filter(|c| *c != '.' && *c != ',').count() < 2
}

// ─── NP collection ─────────────────────────────────────────────────────────

struct Np {
    words: Vec<String>,
    first_tok: usize,
    last_tok: usize, // inclusive
    next: usize,     // first token index after the NP
}

/// Collect a noun phrase starting at token `i`. Terminates on stop words,
/// clause boundaries, verbs, and a 3-word cap; strips trailing scaffold
/// words; rejects generic/verb-leading heads. `extra_stops` adds pattern-
/// specific terminators (compare connectors). `skip_articles` matches the
/// TS `opts.skipArticles !== false` default (authorization passes false).
fn collect_np(
    prompt: &str,
    toks: &[Tok],
    boundary: &[bool],
    i: usize,
    extra_stops: Option<&[&str]>,
    skip_articles: bool,
) -> Option<Np> {
    let n = toks.len();
    let mut j = i;
    if j >= n || boundary[j] {
        return None;
    }
    if skip_articles {
        while j < n && in_list(ARTICLES, &toks[j].clean) {
            j += 1;
        }
    }
    if j >= n || boundary[j] {
        return None;
    }
    let head = toks[j].clean.as_str();
    if in_list(GENERIC_FIRST, head) || in_list(OP_VERBS, head) || in_list(FIND_VERBS, head) {
        return None;
    }
    if dotted_len_short(head) {
        return None;
    }

    let mut words: Vec<String> = Vec::new();
    let first_tok = j;
    while j < n {
        let t = &toks[j];
        if boundary[j]
            || in_list(STOP_TOKENS, &t.clean)
            || extra_stops.map_or(false, |e| in_list(e, &t.clean))
        {
            break;
        }
        if !words.is_empty() && (in_list(OP_VERBS, &t.clean) || in_list(FIND_VERBS, &t.clean)) {
            break;
        }
        if words.len() >= 3 {
            break;
        }
        words.push(strip_tail_punct(&t.raw));
        j += 1;
    }
    // strip trailing scaffold tokens (compare against collected tokens, newest first)
    let mut last = j as i64 - 1;
    while words.len() > 1 && in_list(TRAILING_STRIP, &toks[last as usize].clean) {
        words.pop();
        last -= 1;
    }
    if words.is_empty() {
        return None;
    }
    // "on reddit that …" ⇒ the NP was a sentence subject, not the object of
    // the preposition. A comma EXEMPTS non-restrictive relatives
    // ("zepto, which is cheaper…" — zepto IS the object of "vs").
    if post_np_rejected(prompt, toks, boundary, last, j as i64) {
        return None;
    }
    Some(Np {
        words,
        first_tok,
        last_tok: last as usize,
        next: j,
    })
}

fn post_np_rejected(prompt: &str, toks: &[Tok], boundary: &[bool], last: i64, next: i64) -> bool {
    let n = toks.len() as i64;
    if next >= n || next < 0 || boundary[next as usize] {
        return false;
    }
    if !in_list(POST_NP_REJECT, &toks[next as usize].clean) {
        return false;
    }
    !prompt[toks[last as usize].end..toks[next as usize].start].contains(',')
}

/// Single-token NP guard (compare-vs operands, and-continuations).
fn guarded_single(
    prompt: &str,
    toks: &[Tok],
    boundary: &[bool],
    i: i64,
    extra_stops: Option<&[&str]>,
) -> Option<Np> {
    let n = toks.len() as i64;
    if i < 0 || i >= n || boundary[i as usize] {
        return None;
    }
    let t = &toks[i as usize];
    let c = t.clean.as_str();
    if in_list(STOP_TOKENS, c) || extra_stops.map_or(false, |e| in_list(e, c)) {
        return None;
    }
    if in_list(GENERIC_FIRST, c) || in_list(OP_VERBS, c) || in_list(FIND_VERBS, c) {
        return None;
    }
    if dotted_len_short(c) {
        return None;
    }
    if post_np_rejected(prompt, toks, boundary, i, i + 1) {
        return None;
    }
    Some(Np {
        words: vec![strip_tail_punct(&t.raw)],
        first_tok: i as usize,
        last_tok: i as usize,
        next: (i + 1) as usize,
    })
}

// ─── Derivation ────────────────────────────────────────────────────────────

fn is_interrog(clean: &str) -> bool {
    for w in INTERROG {
        if clean == *w {
            return true;
        }
        // what's, who'll… — JS `clean[w.length] === "'"`
        if clean.starts_with(w) && clean.as_bytes().get(w.len()) == Some(&b'\'') {
            return true;
        }
    }
    false
}

struct MutableTarget {
    phrase: String,
    span_start: usize, // prompt byte offsets (for sort + overlap)
    span_end: usize,
    // Token index of the NP head (usize::MAX for detector-promoted targets).
    // Needed by the Pass-3b clause gate: a verb whose clause already
    // produced a token target has an ENTITY object, not a site.
    first_tok: usize,
    state: TargetState,
    host: String,
    url: String,
    candidates: Vec<String>,
    provenance: TargetProvenance,
}

struct Det {
    raw: String,
    url: String,
    domain: String,
    has_scheme: bool,
    span_start: usize,
    span_end: usize,
}

fn push_target(
    targets: &mut Vec<MutableTarget>,
    consumed: &mut HashSet<usize>,
    n: usize,
    toks: &[Tok],
    np: &Np,
) {
    targets.push(MutableTarget {
        phrase: np.words.join(" "),
        span_start: toks[np.first_tok].start,
        span_end: toks[np.last_tok].end,
        first_tok: np.first_tok,
        state: TargetState::Unresolved,
        host: String::new(),
        url: String::new(),
        candidates: Vec::new(),
        provenance: TargetProvenance::NoProvenance,
    });
    consume(consumed, n, np.first_tok as i64, np.last_tok as i64);
}

fn consume(consumed: &mut HashSet<usize>, n: usize, a: i64, b: i64) {
    let mut i = a.max(0) as usize;
    let b = b as i64;
    while i < n && (i as i64) <= b {
        consumed.insert(i);
        i += 1;
    }
}

fn overlaps_target(targets: &[MutableTarget], ss: usize, se: usize) -> bool {
    targets.iter().any(|t| ss < t.span_end && se > t.span_start)
}

fn overlaps_consumed(toks: &[Tok], consumed: &HashSet<usize>, ss: usize, se: usize) -> bool {
    toks.iter()
        .enumerate()
        .any(|(i, t)| consumed.contains(&i) && ss < t.end && se > t.start)
}

/// Detector host → PSL registrable host (⇔ TS `detHost`): the detector's
/// `domain` field is the full host form; SiteTarget.host is registrable.
fn det_host(d: &Det) -> String {
    registrable_host(if d.has_scheme { &d.url } else { &d.domain })
        .unwrap_or_else(|| d.domain.clone())
}

fn promoted_target(d: &Det, prov: TargetProvenance) -> MutableTarget {
    MutableTarget {
        phrase: d.raw.clone(),
        span_start: d.span_start,
        span_end: d.span_end,
        first_tok: usize::MAX, // detector span, not a token NP
        state: TargetState::Resolved,
        host: det_host(d),
        url: d.url.clone(),
        candidates: Vec::new(),
        provenance: prov,
    }
}

fn eligible_word(w: &str) -> bool {
    in_list(OP_VERBS, w)
        || in_list(FIND_VERBS, w)
        || in_list(CUE_NOUNS, w)
        || in_list(COMPARE_WORDS, w)
}

/// Derive the TaskScope for ONE user prompt. Pure, deterministic,
/// word-order aware. Target order: ascending span start (the user's order).
pub fn derive_task_scope(prompt: &str) -> TaskScope {
    let toks = tokenize(prompt);
    let n = toks.len();
    if n == 0 {
        return empty_scope();
    }

    // Clause boundaries: gap punctuation before token i. Token 0 is a clause
    // START, not a break — clause-initial verbs ("compare X and Y", "buy …
    // on …") are perfectly eligible; the window scan bounds itself instead.
    let mut boundary: Vec<bool> = vec![false; n];
    for i in 1..n {
        boundary[i] = prompt[toks[i - 1].end..toks[i].start]
            .chars()
            .any(|c| matches!(c, '.' | '?' | '!' | ';' | '\n'));
    }

    // Explicit URLs/domains — ONLY via the PSL-aware detector, with prompt spans.
    let dets: Vec<Det> = detect_urls_and_domains(prompt, true)
        .into_iter()
        .map(|d| {
            let mut start = prompt.find(&d.raw).map(|i| i as i64).unwrap_or(-1);
            if start < 0 {
                start = prompt
                    .to_lowercase()
                    .find(&d.raw.to_lowercase())
                    .map(|i| i as i64)
                    .unwrap_or(-1);
            }
            let ss = start.max(0) as usize;
            Det {
                raw: d.raw.clone(),
                url: d.url,
                domain: d.domain,
                has_scheme: d.has_scheme,
                span_start: ss,
                span_end: ss + d.raw.len(),
            }
        })
        .collect();

    let mut targets: Vec<MutableTarget> = Vec::new();
    let mut excluded_phrases: Vec<String> = Vec::new();
    let mut authorized_hosts: Vec<String> = Vec::new();
    let mut consumed: HashSet<usize> = HashSet::new();

    // ── Pass 1: restrictions & authorizations (the user's OWN constraints) ──
    let mut k = 0usize;
    while k < n {
        if consumed.contains(&k) {
            k += 1;
            continue;
        }
        let c = toks[k].clean.as_str();
        // Exclusions: don't/don't-bigram/never/without/avoid + verb + NP.
        let excl_lead_len: usize = if in_list(EXCL_LEAD, c) {
            1
        } else if c == "do" && toks.get(k + 1).map_or(false, |t| t.clean == "not") {
            2
        } else {
            0
        };
        if excl_lead_len > 0 {
            let v = k + excl_lead_len;
            if v < n && in_list(EXCL_VERB, &toks[v].clean) && !boundary[v] {
                let mut s = v + 1;
                if s < n && in_list(PREPS, &toks[s].clean) {
                    s += 1;
                }
                if let Some(np) = collect_np(prompt, &toks, &boundary, s, None, true) {
                    excluded_phrases.push(np.words.join(" "));
                    consume(&mut consumed, n, k as i64, np.last_tok as i64);
                    k = np.next;
                    continue;
                }
            }
        }
        // Mandatory restriction: only/just/strictly + use-ish verb + NP.
        if in_list(ONLY_LEAD, c) {
            let v = k + 1;
            if v < n && in_list(ONLY_VERB, &toks[v].clean) && !boundary[v] {
                let mut s = v + 1;
                if s < n && in_list(PREPS, &toks[s].clean) {
                    s += 1;
                }
                if let Some(np) = collect_np(prompt, &toks, &boundary, s, None, true) {
                    push_target(&mut targets, &mut consumed, n, &toks, &np);
                    k = np.next;
                    continue;
                }
            }
        }
        // Authorization (auth/pay hops): you can/may + verb + registrable domain.
        let auth_lead_len: usize = if (toks[k].clean == "you"
            && toks
                .get(k + 1)
                .map_or(false, |t| t.clean == "can" || t.clean == "may"))
            || (toks[k].clean == "feel" && toks.get(k + 1).map_or(false, |t| t.clean == "free"))
        {
            2
        } else if in_list(AUTH_LEAD1, c) {
            1
        } else {
            0
        };
        if auth_lead_len > 0 {
            let v = k + auth_lead_len;
            if v < n && in_list(AUTH_VERB, &toks[v].clean) && !boundary[v] {
                let mut s = v + 1;
                if s < n && in_list(PREPS, &toks[s].clean) {
                    s += 1;
                }
                // authorization ONLY accepts an explicit registrable domain —
                // a bare word never becomes an authorized host.
                if let Some(np) = collect_np(prompt, &toks, &boundary, s, None, false) {
                    if np.words.len() == 1 {
                        if let Some(reg) = registrable_host(&np.words[0]) {
                            authorized_hosts.push(reg);
                            consume(&mut consumed, n, k as i64, np.last_tok as i64);
                            k = np.next;
                            continue;
                        }
                    }
                }
            }
        }
        k += 1;
    }

    // ── Pass 2: compare cues & operands ────────────────────────────────────
    let mut compare_cue = false;
    for i in 0..n {
        let c = toks[i].clean.as_str();
        let nxt = toks.get(i + 1).map(|t| t.clean.as_str()).unwrap_or("");
        if in_list(COMPARE_WORDS, c) {
            compare_cue = true;
        } else if (c == "difference" || c == "contrast") && nxt == "between" {
            compare_cue = true;
        } else if in_list(COMPARE_ADJ, c) && nxt == "than" {
            compare_cue = true;
        }
    }
    const CMP_STOPS: &[&str] = &["vs", "versus"];
    const CMP_SKIP: &[&str] = &[
        "the", "a", "an", "price", "prices", "cost", "costs", "between", "of", "with",
    ];
    const CMP_CONNECTORS: &[&str] = &["and", "with", "vs", "versus", "to", "than"];
    for i in 0..n {
        if consumed.contains(&i) {
            continue;
        }
        let c = toks[i].clean.as_str();
        if (c == "vs" || c == "versus") && !boundary[i] {
            let a = if i > 0 {
                guarded_single(prompt, &toks, &boundary, i as i64 - 1, None)
            } else {
                None
            };
            let b = guarded_single(prompt, &toks, &boundary, i as i64 + 1, None);
            if let Some(np) = a {
                push_target(&mut targets, &mut consumed, n, &toks, &np);
            }
            if let Some(np) = b {
                push_target(&mut targets, &mut consumed, n, &toks, &np);
            }
            continue;
        }
        if in_list(COMPARE_WORDS, c) && c != "vs" && c != "versus" && !boundary[i] {
            let mut j = i + 1;
            while j < n && in_list(CMP_SKIP, &toks[j].clean) {
                j += 1;
            }
            if let Some(a) = collect_np(prompt, &toks, &boundary, j, Some(CMP_STOPS), true) {
                push_target(&mut targets, &mut consumed, n, &toks, &a);
                let mut jn = a.next;
                if jn < n && in_list(CMP_CONNECTORS, &toks[jn].clean) {
                    jn += 1;
                    while jn < n && in_list(CMP_SKIP, &toks[jn].clean) {
                        jn += 1;
                    }
                    if let Some(b) = collect_np(prompt, &toks, &boundary, jn, Some(CMP_STOPS), true)
                    {
                        push_target(&mut targets, &mut consumed, n, &toks, &b);
                    }
                }
            }
            continue;
        }
    }

    // ── Pass 3: candidate targets via operational/source prepositions ──────
    for p in 0..n {
        if !in_list(PREPS, &toks[p].clean) || consumed.contains(&p) || boundary[p] {
            continue;
        }
        // Scan back to the clause start — no fixed token cap (2026-11-03
        // audit #2: the old 8-token window lost "Amazon" in "Find Samsung
        // Galaxy S24 Ultra 256 GB Titanium Gray on Amazon.", where the
        // eligible verb sits past an arbitrarily long entity NP). The scan
        // stops at the clause boundary (a previous clause must not license
        // this NP) and at a coordinating conjunction (a verb from another
        // coordinated instruction must not license it either).
        let mut eligible = false;
        let mut j = p;
        while j > 0 {
            j -= 1;
            if boundary[j] || in_list(CONJ_STOPS, &toks[j].clean) {
                break;
            }
            if eligible_word(&toks[j].clean) {
                eligible = true;
                break;
            }
        }
        if !eligible {
            continue;
        }
        if let Some(np) = collect_np(prompt, &toks, &boundary, p + 1, None, true) {
            if consumed.contains(&np.first_tok) {
                continue;
            }
            push_target(&mut targets, &mut consumed, n, &toks, &np);
            // "amazon and flipkart" → a SECOND target (not one phrase).
            if np.next < n && (toks[np.next].clean == "and" || toks[np.next].clean == "or") {
                if let Some(two) =
                    guarded_single(prompt, &toks, &boundary, np.next as i64 + 1, None)
                {
                    if !consumed.contains(&two.first_tok) {
                        push_target(&mut targets, &mut consumed, n, &toks, &two);
                    }
                }
            }
        }
    }

    // ── Pass 3b: direct-object destinations ("Open Zepto", "Search Amazon
    // for milk") ────────────────────────────────────────────────────────────
    // A site-taking verb whose OBJECT is the destination itself (2026-11-03
    // audit #2: these forms produced no target at all). Gated three ways so
    // an entity object never masquerades as a site: (1) if this clause
    // already produced a token target, the verb's object was the entity —
    // the site was licensed by a preposition ("Find <product> on Amazon");
    // (2) the NP must be a SINGLE word after trailing-token stripping
    // (multiword objects like "a new tab" are not site names); (3) the word
    // must not be UI scaffold ("Open the login page" ⇒ nothing, not a
    // "login" website). Detector spans still merge in Pass 4, so domain
    // objects ("use reddit.com") resolve to explicit hosts through the
    // normal funnel.
    for v in 0..n {
        if consumed.contains(&v) || boundary[v] || !in_list(DO_SITE_VERBS, &toks[v].clean) {
            continue;
        }
        // A verb sitting right after a preposition/article is being used as
        // a NOUN at that position ("in the select tier-select" — HTML
        // <select>), not commanding an object. Skip it.
        if v > 0 && (in_list(PREPS, &toks[v - 1].clean) || in_list(ARTICLES, &toks[v - 1].clean)) {
            continue;
        }
        let mut clause_end = n;
        for b in v + 1..n {
            if boundary[b] {
                clause_end = b;
                break;
            }
        }
        if targets
            .iter()
            .any(|t| t.first_tok > v && t.first_tok < clause_end)
        {
            continue;
        }
        if let Some(np) = collect_np(prompt, &toks, &boundary, v + 1, None, true) {
            if np.words.len() != 1 || consumed.contains(&np.first_tok) {
                continue;
            }
            let w = np.words[0].to_lowercase();
            if in_list(DO_SCAFFOLD, &w) {
                continue;
            }
            push_target(&mut targets, &mut consumed, n, &toks, &np);
            if np.next < n && (toks[np.next].clean == "and" || toks[np.next].clean == "or") {
                if let Some(two) =
                    guarded_single(prompt, &toks, &boundary, np.next as i64 + 1, None)
                {
                    if !consumed.contains(&two.first_tok) {
                        push_target(&mut targets, &mut consumed, n, &toks, &two);
                    }
                }
            }
        }
    }

    // ── Pass 4: explicit merge / promotion (PSL-verified, never guessed) ───
    // The detector's `domain` field carries the full HOST ("www.zepto.com");
    // SiteTarget.host is defined as the PSL REGISTRABLE host ("zepto.com").
    for t in targets.iter_mut() {
        for d in dets.iter() {
            if d.span_start <= t.span_start && d.span_end >= t.span_end {
                t.state = TargetState::Resolved;
                t.host = det_host(d);
                t.url = d.url.clone();
                t.provenance = if d.has_scheme {
                    TargetProvenance::ExplicitUrl
                } else {
                    TargetProvenance::ExplicitDomain
                };
                break;
            }
        }
    }
    for d in dets.iter() {
        if overlaps_target(&targets, d.span_start, d.span_end) {
            continue;
        }
        if d.has_scheme {
            // scheme URLs are ALWAYS scope — an explicit URL is the strongest
            // possible statement of destination.
            targets.push(promoted_target(d, TargetProvenance::ExplicitUrl));
            continue;
        }
        if overlaps_consumed(&toks, &consumed, d.span_start, d.span_end) {
            continue;
        }
        let bare_untied = dets
            .iter()
            .filter(|o| {
                !o.has_scheme
                    && !overlaps_target(&targets, o.span_start, o.span_end)
                    && !overlaps_consumed(&toks, &consumed, o.span_start, o.span_end)
            })
            .count();
        if compare_cue || bare_untied == 1 {
            targets.push(promoted_target(d, TargetProvenance::ExplicitDomain));
        }
    }

    // Sort by user order, then dedupe (host,url,phrase-lower).
    targets.sort_by_key(|t| t.span_start);
    let mut seen: HashSet<String> = HashSet::new();
    let deduped: Vec<MutableTarget> = targets
        .into_iter()
        .filter(|t| {
            // \u{0} delimiter ⇔ TS "\u0000" template delimiter (values can
            // never contain NUL, so dedup keys are collision-free on both sides).
            let key = format!("{}\u{0}{}\u{0}{}", t.host, t.url, t.phrase.to_lowercase());
            if seen.contains(&key) {
                return false;
            }
            seen.insert(key);
            true
        })
        .collect();

    // ── Intent ladder ───────────────────────────────────────────────────────
    let mut research_cue = false;
    let mut i = 0usize;
    while i < n && !research_cue {
        let c = toks[i].clean.as_str();
        if in_list(RESEARCH_CUE_WORDS, c) {
            research_cue = true;
            break;
        }
        if is_interrog(c) {
            let hi = (n - 1).min(i + 2);
            let mut j = i + 1;
            while j <= hi {
                if in_list(COPULAS, &toks[j].clean) {
                    research_cue = true;
                    break;
                }
                j += 1;
            }
        }
        if c == "tell" && toks.get(i + 1).map_or(false, |t| t.clean == "me") {
            research_cue = true;
        }
        i += 1;
    }
    let op_seen = toks.iter().any(|t| in_list(OP_VERBS, &t.clean));

    let intent = if deduped.is_empty() {
        if research_cue {
            TaskIntent::Research
        } else {
            TaskIntent::NoScope
        }
    } else if compare_cue && deduped.len() >= 2 {
        TaskIntent::CompareSites
    } else if op_seen {
        TaskIntent::Operate
    } else {
        TaskIntent::SiteInfo
    };

    TaskScope {
        intent,
        targets: deduped
            .into_iter()
            .map(|t| SiteTarget {
                phrase: t.phrase,
                state: t.state,
                host: t.host,
                url: t.url,
                candidates: t.candidates,
                provenance: t.provenance,
            })
            .collect(),
        excluded_phrases,
        authorized_hosts,
    }
}

fn empty_scope() -> TaskScope {
    TaskScope {
        intent: TaskIntent::NoScope,
        targets: Vec::new(),
        excluded_phrases: Vec::new(),
        authorized_hosts: Vec::new(),
    }
}

// ─── Host resolution from REAL retrieval candidates (never fabricated) ─────

fn norm(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn candidate_host(c: &str) -> Option<String> {
    registrable_host(c.trim())
}

fn capped_sorted(mut hosts: Vec<String>, max: usize) -> Vec<String> {
    hosts.sort();
    hosts.truncate(max.max(1));
    hosts
}

/// Resolve ONE unresolved target against ranked candidate URLs/hosts.
/// Law (2026-11-03 audit #5): identity is EQUALITY ONLY — the normalized
/// phrase must equal the registrable label. Prefix/containment resemblance
/// NEVER resolves: zeptodiscounts.com is not Zepto, and PSL validity plus
/// string similarity is not identity evidence. Several distinct equality
/// hosts ⇒ ambiguous (clarification territory, brief #4); zero matches
/// leaves the target unresolved — the system never guesses a domain.
pub fn resolve_target(
    t: &SiteTarget,
    candidates: &[String],
    max: usize,
    provenance: TargetProvenance,
) -> SiteTarget {
    if t.state != TargetState::Unresolved {
        return t.clone();
    }
    let pn = norm(&t.phrase);
    if pn.is_empty() {
        return t.clone();
    }

    let mut eq_hosts: Vec<String> = Vec::new();
    for c_raw in candidates {
        let Some(host) = candidate_host(c_raw) else {
            continue;
        };
        let label = host.split('.').next().unwrap_or("");
        let ln = norm(label);
        if ln.is_empty() {
            continue;
        }
        if ln == pn && !eq_hosts.contains(&host) {
            eq_hosts.push(host);
        }
    }

    if eq_hosts.len() == 1 {
        let mut r = t.clone();
        r.state = TargetState::Resolved;
        r.host = eq_hosts.remove(0);
        r.candidates = Vec::new();
        r.provenance = provenance;
        return r;
    }
    if eq_hosts.len() > 1 {
        let mut r = t.clone();
        r.state = TargetState::Ambiguous;
        r.host = String::new();
        r.candidates = capped_sorted(eq_hosts, max);
        r.provenance = TargetProvenance::Ambiguous;
        return r;
    }
    t.clone() // unresolved, provenance stays "none" — no match, no invention
}

pub fn resolve_task_scope(
    scope: &TaskScope,
    candidates: &[String],
    max: usize,
    provenance: TargetProvenance,
) -> TaskScope {
    let mut s = scope.clone();
    s.targets = s
        .targets
        .iter()
        .map(|t| resolve_target(t, candidates, max, provenance))
        .collect();
    s
}

// ─── Turn-to-turn continuity (brief #6: follow-ups must not lose scope) ────

/// Two-tier continuation law (2026-11-03 audit #5: "every short request
/// counted as continuation" carried a prior purchase into "Write a short
/// poem"). Tier 1: an ANAPHORIC cue (it/them/this/same/again/…) marks a
/// follow-up anywhere in the turn. Tier 2: a bare elliptical FRAGMENT — at
/// most six tokens and OPENING with an interrogative, preposition, article,
/// or "only" — continues only when it carries no intent of its own. A full
/// request with its own verb ("Write a short poem") is never a follow-up.
pub fn is_follow_up(prompt: &str) -> bool {
    let toks = tokenize(prompt);
    if toks.is_empty() {
        return false;
    }
    if toks.iter().any(|t| in_list(FOLLOW_CUES, &t.clean)) {
        return true;
    }
    if toks.len() > 6 {
        return false;
    }
    let head = toks[0].clean.as_str();
    is_interrog(head) || in_list(PREPS, head) || in_list(ARTICLES, head) || in_list(ONLY_LEAD, head)
}

fn union_lists(a: &[String], b: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in a.iter().chain(b.iter()) {
        if !out.contains(x) {
            out.push(x.clone());
        }
    }
    out
}

/// Merge the previous turn's scope with this turn's derivation.
/// 1. A fresh derivation with DESTINATIONS replaces (explicit target change
///    wins outright).
/// 2. An intent-only turn (intent, no destinations): on an anaphoric
///    follow-up, KEEP the previous destinations — the research-cue heuristic
///    must not erase an operate destination ("What is its rating?" keeps
///    Zepto) — while the turn's own restrictions/authorizations merge in.
///    Non-anaphoric intent turns stand alone.
/// 3. A derivation with neither intent nor destinations inherits the previous
///    scope on a genuine follow-up; otherwise the topic changed and the
///    scope RESETS.
pub fn merge_task_scope(prev: Option<&TaskScope>, prompt: &str) -> TaskScope {
    let derived = derive_task_scope(prompt);
    if !derived.targets.is_empty() {
        return derived;
    }
    let toks = tokenize(prompt);
    let anaphoric = toks.iter().any(|t| in_list(FOLLOW_CUES, &t.clean));
    if let Some(p) = prev {
        if p.intent != TaskIntent::NoScope {
            if derived.intent != TaskIntent::NoScope {
                if anaphoric {
                    let intent = if derived.intent == TaskIntent::Research {
                        p.intent
                    } else {
                        derived.intent
                    };
                    let mut r = p.clone();
                    r.intent = intent;
                    r.excluded_phrases =
                        union_lists(&p.excluded_phrases, &derived.excluded_phrases);
                    r.authorized_hosts =
                        union_lists(&p.authorized_hosts, &derived.authorized_hosts);
                    return r;
                }
                return derived;
            }
            if is_follow_up(prompt) {
                return p.clone();
            }
        }
    }
    derived
}

/// Fold the conversation's user turns oldest→newest (current turn last).
/// The fold is STATELESS by design: the chat routes (TS `foldTaskScope`
/// in app/api/chat/route.ts, Rust chat pipeline) derive the operational
/// scope per request from the request's own user turns — no session
/// store, nothing for model tool arguments to poison.
pub fn fold_task_scope(user_prompts: &[String]) -> TaskScope {
    let mut prev: Option<TaskScope> = None;
    for p in user_prompts {
        if p.trim().is_empty() {
            continue;
        }
        prev = Some(merge_task_scope(prev.as_ref(), p));
    }
    prev.unwrap_or_else(empty_scope)
}

// ─── Corpus parity tests (the corpus is the contract) ──────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const CORPUS: &str = include_str!("../../../fixtures/task-scope/cases.json");

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
        resolutions: Vec<Resolution>,
        merges: Vec<Merge>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        prompt: String,
        #[serde(flatten)]
        expect: TaskScope,
    }

    #[derive(Deserialize)]
    struct Resolution {
        name: String,
        phrase: String,
        max: usize,
        candidates: Vec<String>,
        expect: SiteTarget,
    }

    #[derive(Deserialize)]
    struct Merge {
        name: String,
        prev: TaskScope,
        prompt: String,
        expect: TaskScope,
    }

    #[test]
    fn corpus_derive_cases() {
        let fx: Fixture = serde_json::from_str(CORPUS).expect("task-scope corpus must parse");
        assert!(!fx.cases.is_empty());
        for c in &fx.cases {
            let got = derive_task_scope(&c.prompt);
            assert_eq!(got, c.expect, "corpus derive case: {}", c.name);
        }
    }

    #[test]
    fn corpus_resolutions() {
        let fx: Fixture = serde_json::from_str(CORPUS).expect("task-scope corpus must parse");
        assert!(!fx.resolutions.is_empty());
        for r in &fx.resolutions {
            let input = SiteTarget {
                phrase: r.phrase.clone(),
                state: TargetState::Unresolved,
                host: String::new(),
                url: String::new(),
                candidates: Vec::new(),
                provenance: TargetProvenance::NoProvenance,
            };
            let cands: Vec<String> = r.candidates.clone();
            let got = resolve_target(&input, &cands, r.max, TargetProvenance::ResolvedSearch);
            assert_eq!(got, r.expect, "corpus resolution case: {}", r.name);
        }
    }

    #[test]
    fn corpus_merges() {
        let fx: Fixture = serde_json::from_str(CORPUS).expect("task-scope corpus must parse");
        assert!(!fx.merges.is_empty());
        for m in &fx.merges {
            let got = merge_task_scope(Some(&m.prev), &m.prompt);
            assert_eq!(got, m.expect, "corpus merge case: {}", m.name);
        }
    }

    // ── Inline law tests (shared intent with the vitest extras) ────────────

    #[test]
    fn serialization_names_are_the_fixture_vocab() {
        let s = TaskScope {
            intent: TaskIntent::SiteInfo,
            targets: vec![SiteTarget {
                phrase: "x.com".into(),
                state: TargetState::Resolved,
                host: "x.com".into(),
                url: "https://x.com".into(),
                candidates: vec![],
                provenance: TargetProvenance::ExplicitDomain,
            }],
            excluded_phrases: vec!["reddit".into()],
            authorized_hosts: vec!["paytm.com".into()],
        };
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains("\"intent\":\"site_info\""));
        assert!(j.contains("\"excludedPhrases\""));
        assert!(j.contains("\"authorizedHosts\""));
        assert!(j.contains("\"provenance\":\"explicit_domain\""));
        let back: TaskScope = serde_json::from_str(&j).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn registrable_host_psl_parity() {
        assert_eq!(
            registrable_host("https://www.zepto.com/x").as_deref(),
            Some("zepto.com")
        );
        assert_eq!(
            registrable_host("docs.example.dev").as_deref(),
            Some("example.dev")
        );
        assert_eq!(registrable_host(""), None);
        assert_eq!(registrable_host("http://localhost:3000/x").as_deref(), None);
    }

    #[test]
    fn followup_without_previous_keeps_derived() {
        let got = merge_task_scope(None, "now find the price");
        assert_eq!(got.intent, TaskIntent::NoScope);
        assert!(got.targets.is_empty());
    }

    #[test]
    fn fold_carries_scope_across_followups() {
        // Brief #6: a short follow-up must NOT silently drop the scope.
        let s = fold_task_scope(&[
            "Order milk on Zepto".to_string(),
            "what about the delivery fee".to_string(),
        ]);
        assert!(!s.targets.is_empty());
        assert!(s
            .targets
            .iter()
            .any(|t| t.phrase.eq_ignore_ascii_case("zepto")));
    }

    #[test]
    fn fold_unrelated_fresh_ask_replaces_scope() {
        // merge_task_scope's replace law holds through the fold: a fresh
        // non-empty derivation must not leak the old constraint forward.
        let s = fold_task_scope(&[
            "Order milk on Zepto".to_string(),
            "compare amazon.com vs flipkart.com laptops".to_string(),
        ]);
        assert!(s
            .targets
            .iter()
            .all(|t| !t.phrase.eq_ignore_ascii_case("zepto")));
        assert!(!s.targets.is_empty());
    }

    #[test]
    fn fold_blank_and_empty_prompts_yield_empty_scope() {
        assert_eq!(fold_task_scope(&[]), empty_scope());
        assert_eq!(
            fold_task_scope(&["".to_string(), "   ".to_string()]),
            empty_scope()
        );
    }

    #[test]
    fn browser_turn_routing_matrix() {
        // ⇔ vitest "only operate scopes route to the browser loop".
        let scoped = |intent: TaskIntent| TaskScope {
            intent,
            targets: vec![SiteTarget {
                phrase: "x.com".into(),
                state: TargetState::Resolved,
                host: "x.com".into(),
                url: "https://x.com".into(),
                candidates: vec![],
                provenance: TargetProvenance::ExplicitDomain,
            }],
            excluded_phrases: vec![],
            authorized_hosts: vec![],
        };
        assert!(routes_to_browser_turn(&scoped(TaskIntent::Operate)));
        for intent in [
            TaskIntent::NoScope,
            TaskIntent::Research,
            TaskIntent::SiteInfo,
            TaskIntent::CompareSites,
        ] {
            assert!(!routes_to_browser_turn(&scoped(intent)));
        }
        assert!(!routes_to_browser_turn(&empty_scope()));
    }

    #[test]
    fn browser_operate_implies_a_target() {
        // Ladder law relied on by the routing predicate: an Operate scope
        // always carries ≥1 target, so the browser loop never runs without
        // a destination to resolve. An operational VERB with NO extractable
        // site never becomes Operate.
        let s = derive_task_scope("order milk on Zepto");
        assert!(routes_to_browser_turn(&s));
        assert!(!s.targets.is_empty());
        let n = derive_task_scope("please do it now");
        assert!(!routes_to_browser_turn(&n));
        assert!(n.targets.is_empty());
    }

    #[test]
    fn acceptance_browser_prompts_route_operate() {
        // Pins the EXACT prompts from tests/browser-model-acceptance.spec.ts
        // (FIXTURE_BASE = http://127.0.0.1:3210) so the scope-driven routing
        // law can never silently drop the browser acceptance journeys out of
        // the browser loop. ⇔ vitest pins with the identical strings.
        const PROMPTS: [&str; 3] = [
            r##"Use the browser tools. A browser tab is already open at http://127.0.0.1:3210/easy. On that SAME tab (do not open new tabs), click the link with CSS selector "#go-arrived", then read the page text and tell me the exact marker text shown in the "#arrived-marker" element."##,
            r##"Use the browser tools on the already-open tab at http://127.0.0.1:3210/medium (do not open new tabs): type RUKE-MEDIUM-42X into the input with CSS selector "#note-input"; select the option value "business" in the select "#tier-select"; tick the checkbox "#subscribe-box"; check the radio button with CSS selector input[name="plan"][value="annual"]; then click the button "#submit-btn". Finally read the page and list the echoed lines you see."##,
            r##"Use the browser tools. Step 1: open a NEW tab at http://127.0.0.1:3210/hard/popup. Step 2: on that page click the button with CSS selector "#open-popup" — it opens a popup, which appears as another browser tab. Step 3: list the browser tabs, find the child tab whose URL ends with "/hard/popup-child", and call the "tab_mark_deliverable" tool on that child tab so it is kept. Step 4: read the child page and tell me the marker text shown."##,
        ];
        for p in PROMPTS {
            let s = derive_task_scope(p);
            assert!(
                !s.targets.is_empty(),
                "acceptance prompt lost its site target: {p}"
            );
            assert_eq!(
                s.intent,
                TaskIntent::Operate,
                "acceptance prompt not operational: {p}"
            );
            assert!(
                routes_to_browser_turn(&s),
                "acceptance prompt must route to the browser loop: {p}"
            );
        }
    }

    #[test]
    fn enforce_ladder() {
        assert!(!is_enforceable_scope(&empty_scope()));
        let s = derive_task_scope("order milk on Zepto");
        assert!(is_enforceable_scope(&s));
        assert!(!s.targets.is_empty());
        // bare name is never a guessed domain — resolution needs real candidates
        assert_eq!(s.targets[0].state, TargetState::Unresolved);
        let r = resolve_task_scope(
            &s,
            &["https://zepto.com/".to_string()],
            8,
            TargetProvenance::ResolvedSearch,
        );
        assert_eq!(r.targets[0].host, "zepto.com");
        assert_eq!(scope_hosts(&r), vec!["zepto.com".to_string()]);
    }
}
