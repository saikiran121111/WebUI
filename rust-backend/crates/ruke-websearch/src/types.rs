//! Parity port of `lib/web-search/types.ts` — the SHARED Part-6 contract.
//!
//! Two zod schemas parse the gate model's decision JSON; BOTH refine
//! predicates are ported VERBATIM, including their opposite polarity —
//! a genuine TS bug kept as-is (PARITY migration, fixtures README §8):
//! - `SearchDecisionSchema` (strict, `.strict()`-equivalent: unknown keys
//!   REJECTED): `.refine(d => d.search_required || d.queries.length > 0)`
//!   → fails when `search_required=false AND queries=[]` (the comment
//!   above it claims the opposite is allowed).
//! - `SearchDecisionSchemaCompat`: `.refine(d => !d.search_required || d.queries.length > 0)`
//!   → fails when `search_required=true AND queries=[]`; plain `.object()`
//!   semantics → unknown keys are silently STRIPPED.
//!
//! Both share the identical message [`REFINE_MESSAGE`].
//!
//! Serde-vs-JS notes (W2/W3/W4 must read):
//! - Schema/decision keys are snake_case (`search_required`,
//!   `preferred_domains`) exactly as the model emits them; the result /
//!   evidence / gate interfaces are camelCase (`publishedDate`,
//!   `bm25Score`, `engineRanks`, `gateMs`) — renames mirror TS exactly.
//! - JS `number` fields that can be integral (`rrf`, `bm25Score`, `gateMs`)
//!   serialize through [`js_number_ser::serialize`] (integral f64 →
//!   integer token) — the same serializer ruke-decision shipped for
//!   `confidence` (fixtures README discovery #1, RESOLVED Part 3).
//! - `engineRanks: Record<string, number>` is a serde_json Map with
//!   `preserve_order`: build values via [`js_number`] and preserve the
//!   TS insertion order.
//! - `Freshness` compat path passes UNKNOWN values through untouched
//!   (TS `f as SearchDecision["freshness"]` cast — the raw string flows
//!   into the JSON). [`Freshness::Other`] carries it verbatim; the strict
//!   schema rejects unknown instead.
//! - `EvidencePacket.classification` is a plain `string?` in TS (the
//!   SUCCESS_*/FAIL_* names are documentation only) — kept as String.
//! - `rank` is an engine-emitted integer; typed i64 (TS `number`).

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Map, Value};

/// Shared zod refine message (VERBATIM, both schemas).
pub const REFINE_MESSAGE: &str = "search_required=true requires at least one query";

/// JS-number → JSON number: integral doubles serialize as integers
/// (`1`, not `1.0`) exactly like `JSON.stringify`. Same rule as
/// ruke-decision's serializer; usable for Map values.
pub fn js_number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992f64 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

/// `serialize_with` target for f64 fields TS declares as `number`
/// (rrf / bm25Score / gateMs) — mirrors [`js_number`].
pub mod js_number_ser {
    use serde::Serializer;

    pub fn serialize<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992f64 {
            s.serialize_i64(*v as i64)
        } else {
            s.serialize_f64(*v)
        }
    }
}

// ── enums ────────────────────────────────────────────────────────────────

/// `z.enum([...])` + the compat passthrough for unknown strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Freshness {
    None,
    Day,
    Week,
    Month,
    Year,
    Any,
    /// Compat-schema passthrough (TS cast keeps the raw string verbatim).
    Other(String),
}

impl Freshness {
    pub const KNOWN: [&'static str; 6] = ["none", "day", "week", "month", "year", "any"];

    pub fn known(s: &str) -> Option<Self> {
        match s {
            "none" => Some(Self::None),
            "day" => Some(Self::Day),
            "week" => Some(Self::Week),
            "month" => Some(Self::Month),
            "year" => Some(Self::Year),
            "any" => Some(Self::Any),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::None => "none",
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
            Self::Year => "year",
            Self::Any => "any",
            Self::Other(s) => s,
        }
    }
}

impl Serialize for Freshness {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Freshness {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Ok(Freshness::known(&raw).unwrap_or(Freshness::Other(raw)))
    }
}

/// Legacy freshness values normalized to the new set on parse
/// (`normalizeFreshness`, verbatim switch).
pub fn normalize_freshness(f: &str) -> Freshness {
    match f {
        "current" => Freshness::Day,
        "recent" => Freshness::Month,
        other => Freshness::known(other).unwrap_or_else(|| Freshness::Other(other.to_string())),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    General,
    News,
    Docs,
    Code,
    Academic,
    Forum,
    /// Only reachable via hand-built values — both schemas land on one of
    /// the six canonical labels (strict rejects, compat coerces).
    Other(String),
}

impl Intent {
    /// Order matters — `coerceIntent` scans it for the starts_with match.
    pub const KNOWN: [&'static str; 6] = ["general", "news", "docs", "code", "academic", "forum"];

    pub fn known(s: &str) -> Option<Self> {
        match s {
            "general" => Some(Self::General),
            "news" => Some(Self::News),
            "docs" => Some(Self::Docs),
            "code" => Some(Self::Code),
            "academic" => Some(Self::Academic),
            "forum" => Some(Self::Forum),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::General => "general",
            Self::News => "news",
            Self::Docs => "docs",
            Self::Code => "code",
            Self::Academic => "academic",
            Self::Forum => "forum",
            Self::Other(s) => s,
        }
    }
}

impl Serialize for Intent {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Intent {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Ok(Intent::known(&raw).unwrap_or(Intent::Other(raw)))
    }
}

/// Map any intent label the router emits to the canonical enum.
/// Unknown values fall back to "general" (VERBATIM port of `coerceIntent`,
/// including the KNOWN-scan order and the five fuzzy groups).
pub fn coerce_intent(raw: &str) -> Intent {
    let lower = raw.to_lowercase().trim().to_string();
    for k in Intent::KNOWN {
        if lower == k || lower.starts_with(k) {
            return Intent::known(k).expect("KNOWN ⊆ known()");
        }
    }
    if lower.contains("news") || lower.contains("current") || lower.contains("breaking") {
        return Intent::News;
    }
    if lower.contains("doc") || lower.contains("manual") || lower.contains("reference") {
        return Intent::Docs;
    }
    if lower.contains("code") || lower.contains("program") || lower.contains("bug") {
        return Intent::Code;
    }
    if lower.contains("acad") || lower.contains("research") || lower.contains("science") {
        return Intent::Academic;
    }
    if lower.contains("forum") || lower.contains("community") || lower.contains("reddit") {
        return Intent::Forum;
    }
    Intent::General
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Depth {
    Quick,
    Standard,
    Deep,
}

fn parse_depth(raw: &str) -> Result<Depth, String> {
    match raw {
        "quick" => Ok(Depth::Quick),
        "standard" => Ok(Depth::Standard),
        "deep" => Ok(Depth::Deep),
        other => Err(format!(
            "depth: Invalid enum value. Expected 'quick' | 'standard' | 'deep', received '{other}'"
        )),
    }
}

// ── decision structs (snake_case — the exact model JSON contract) ───────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SearchQuery {
    pub query: String,
    pub intent: Intent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_domains: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SearchDecision {
    pub search_required: bool,
    pub reason: String,
    pub freshness: Freshness,
    pub depth: Depth,
    pub queries: Vec<SearchQuery>,
}

// ── schema parsers ───────────────────────────────────────────────────────

fn as_object<'a>(v: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    v.as_object()
        .ok_or_else(|| format!("{what}: Expected object, received {}", json_kind(v)))
}

fn json_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn req_str<'a>(m: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    m.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key}: Required"))
}

fn reject_unknown(m: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    let unknown: Vec<String> = m
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .map(|k| format!("'{k}'"))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Unrecognized key(s) in object: {}",
            unknown.join(", ")
        ))
    }
}

fn parse_queries(v: Option<&Value>, strict: bool) -> Result<Vec<SearchQuery>, String> {
    let arr = v.and_then(Value::as_array).ok_or("queries: Required")?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let m = as_object(item, &format!("queries.{i}"))?;
        if strict {
            reject_unknown(m, &["query", "intent", "preferred_domains"])?;
        }
        let query = req_str(m, "query")?.to_string();
        let intent_raw = req_str(m, "intent")?;
        let intent = if strict {
            Intent::known(intent_raw).ok_or_else(|| {
                format!(
                    "intent: Invalid enum value. Expected 'general' | 'news' | 'docs' | 'code' | 'academic' | 'forum', received '{intent_raw}'"
                )
            })?
        } else {
            // compat: free string first, then coerced (unknown → general).
            coerce_intent(intent_raw)
        };
        let preferred_domains = match m.get("preferred_domains") {
            None => None,
            Some(v) => {
                let list = v.as_array().ok_or("preferred_domains: Expected array")?;
                let mut d = Vec::with_capacity(list.len());
                for x in list {
                    d.push(x.as_str().ok_or("preferred_domains: Expected string")?.to_string());
                }
                Some(d)
            }
        };
        out.push(SearchQuery {
            query,
            intent,
            preferred_domains,
        });
    }
    Ok(out)
}

/// `SearchDecisionSchema.safeParse` equivalent. Strict: unknown keys are
/// REJECTED (zod `.strict()`-style), enums are exact.
///
/// QUIRK (ported verbatim): the refine predicate is
/// `d.search_required || d.queries.length > 0` — a `search_required=false`
/// verdict with an EMPTY queries array FAILS, despite the TS comment
/// claiming it is allowed. `search_required=true` with queries passes;
/// `true` with none passes the predicate (zod never sees an empty array
/// reject on the true branch).
pub fn parse_search_decision(v: &Value) -> Result<SearchDecision, String> {
    let m = as_object(v, "decision")?;
    reject_unknown(m, &["search_required", "reason", "freshness", "depth", "queries"])?;

    let search_required = m
        .get("search_required")
        .and_then(Value::as_bool)
        .ok_or("search_required: Required")?;
    let reason = req_str(m, "reason")?.to_string();
    let freshness_raw = req_str(m, "freshness")?;
    let freshness = Freshness::known(freshness_raw).ok_or_else(|| {
        format!(
            "freshness: Invalid enum value. Expected 'none' | 'day' | 'week' | 'month' | 'year' | 'any', received '{freshness_raw}'"
        )
    })?;
    let depth = parse_depth(req_str(m, "depth")?)?;
    let queries = parse_queries(m.get("queries"), true)?;

    if !(search_required || !queries.is_empty()) {
        return Err(REFINE_MESSAGE.to_string());
    }
    Ok(SearchDecision {
        search_required,
        reason,
        freshness,
        depth,
        queries,
    })
}

/// `SearchDecisionSchemaCompat.safeParse` equivalent: accepts legacy
/// freshness (current/recent) and free-form intent labels; unknown TOP-
/// LEVEL/QUERY keys are silently stripped (plain zod `.object()`), and
/// unknown freshness strings pass through verbatim into
/// [`Freshness::Other`].
///
/// The refine here has the OPPOSITE polarity (`!search_required ||
/// queries.length > 0`) — it fails exactly when the strict schema does
/// NOT. Ported verbatim; do not "unify" the two.
pub fn parse_search_decision_compat(v: &Value) -> Result<SearchDecision, String> {
    let m = as_object(v, "decision")?;

    let search_required = m
        .get("search_required")
        .and_then(Value::as_bool)
        .ok_or("search_required: Required")?;
    let reason = req_str(m, "reason")?.to_string();
    // compat freshness: z.string() — any string accepted, then normalized.
    let freshness_raw = req_str(m, "freshness")?;
    let freshness = normalize_freshness(freshness_raw);
    let depth = parse_depth(req_str(m, "depth")?)?;
    let queries = parse_queries(m.get("queries"), false)?;

    if search_required && queries.is_empty() {
        return Err(REFINE_MESSAGE.to_string());
    }
    Ok(SearchDecision {
        search_required,
        reason,
        freshness,
        depth,
        queries,
    })
}

// ── result / evidence / gate structs (camelCase wire shapes) ────────────

/// `RawSearchResult` — one SERP row from an engine adapter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    /// Engine-emitted integer rank (TS `number`).
    pub rank: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePassage {
    /// "S1", "S2", …
    pub source_id: String,
    pub url: String,
    pub title: String,
    pub domain: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub passage_text: String,
    #[serde(serialize_with = "js_number_ser::serialize")]
    pub bm25_score: f64,
}

/// A normalized result from ANY search source, after URL cleanup + dedup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedResult {
    pub url: String,
    pub canonical: String,
    pub title: String,
    pub snippet: String,
    pub engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    pub domain: String,
}

/// `Record<string, number>` — serde_json Map (preserve_order ⇒ TS
/// insertion order). Build values with [`js_number`].
pub type EngineRanks = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedResult {
    pub url: String,
    pub canonical: String,
    pub title: String,
    pub snippet: String,
    pub engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    pub domain: String,
    /// RRF score — higher = better.
    #[serde(serialize_with = "js_number_ser::serialize")]
    pub rrf: f64,
    /// Which engines surfaced this URL (corroboration display).
    pub engines: Vec<String>,
    /// Rank in each engine that returned this result.
    pub engine_ranks: EngineRanks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtractionKind {
    Direct,
    JinaFallback,
    SnippetOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePacket {
    pub source_id: String,
    pub url: String,
    pub title: String,
    pub domain: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub extraction: ExtractionKind,
    pub passages: Vec<EvidencePassage>,
    /// Plain `string?` in TS — the SUCCESS_*/FAIL_* stress-test labels
    /// are documentation, NOT a zod enum. Absent on pre-upgrade packets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification: Option<String>,
}

/// `history?: { role: string; content: string }[]` element.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryTurn {
    pub role: String,
    pub content: String,
}

/// The exact context the search gate accepts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchGateContext {
    pub user_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<HistoryTurn>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_image_attachment: Option<bool>,
    /// Part-10 APPROVED PARITY DEVIATION (attachment-aware gate): the
    /// CURRENT turn carries attachment evidence (`attachment_ref` blocks —
    /// the same flag the retrieval stage keys off). Consulted ONLY by the
    /// STAGE 0 attachment-local suppression rule; absent/false ⇒ behavior
    /// byte-identical to the pre-deviation parity baseline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_attachment_evidence: Option<bool>,
    /// Part-10 APPROVED PARITY DEVIATION (universal search pre-gate): the
    /// runtime date the gate model should reason against (YYYY-MM-DD).
    /// NEVER hardcoded — when absent the gate falls back to the real
    /// runtime date (`chrono::Utc::now()`); tests inject a fixed date so
    /// they never depend on the wall clock. Mirrors the TS `currentDate`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_data_urls: Option<Vec<String>>,
}

/// `"deterministic" | "main-model" | "rules"` (Stage 0 / main LLM /
/// emergency fallback).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GateSource {
    Deterministic,
    MainModel,
    Rules,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchGateResult {
    pub decision: SearchDecision,
    pub source: GateSource,
    /// Milliseconds spent in the gate (0 on Stage 0 / rules short-circuit).
    #[serde(serialize_with = "js_number_ser::serialize")]
    pub gate_ms: f64,
}

/// Convenience for hand-building `engineRanks` values in insertion order.
pub fn engine_rank_value(rank: i64) -> Value {
    Value::from(rank)
}

/// Object/Value round-trip guard used by the cache layer; kept here so
/// every Part-6 module shares the same serde_json config.
pub fn to_value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("struct serializes")
}

pub fn from_value<T: DeserializeOwned>(v: &Value) -> Result<T, serde_json::Error> {
    serde_json::from_value(v.clone())
}

// ── tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn strict_ok() -> Value {
        json!({
            "search_required": true,
            "reason": "needs current news",
            "freshness": "week",
            "depth": "standard",
            "queries": [{ "query": "openai news", "intent": "news" },
                        { "query": "openai docs", "intent": "docs", "preferred_domains": ["openai.com"] }]
        })
    }

    #[test]
    fn strict_accepts_and_roundtrips_camel_case_contract() {
        let d = parse_search_decision(&strict_ok()).expect("valid");
        assert_eq!(d.freshness, Freshness::Week);
        assert_eq!(d.depth, Depth::Standard);
        assert_eq!(d.queries[0].intent, Intent::News);
        assert_eq!(
            d.queries[1].preferred_domains.as_deref(),
            Some(&["openai.com".to_string()][..])
        );
        // wire bytes: snake_case keys, struct field order, no nulls.
        let s = serde_json::to_string(&d).unwrap();
        assert_eq!(
            s,
            r#"{"search_required":true,"reason":"needs current news","freshness":"week","depth":"standard","queries":[{"query":"openai news","intent":"news"},{"query":"openai docs","intent":"docs","preferred_domains":["openai.com"]}]}"#
        );
    }

    #[test]
    fn strict_rejects_unknown_keys_but_compat_strips_them() {
        let mut v = strict_ok();
        v["surprise"] = json!(1);
        assert!(parse_search_decision(&v).unwrap_err().contains("Unrecognized key"));

        let mut c = strict_ok();
        c["surprise"] = json!(1);
        c["queries"][0]["bogus"] = json!("x");
        let d = parse_search_decision_compat(&c).expect("compat strips unknown keys");
        assert_eq!(d.queries.len(), 2);
    }

    #[test]
    fn refine_polarity_quirk_both_directions_verbatim() {
        // STRICT quirk: search_required=FALSE + empty queries → REJECTED.
        let v = json!({"search_required": false, "reason": "fine", "freshness": "any",
                       "depth": "quick", "queries": []});
        assert_eq!(parse_search_decision(&v).unwrap_err(), REFINE_MESSAGE);
        // strict true + empty passes the predicate (quirk mirror).
        let v2 = json!({"search_required": true, "reason": "r", "freshness": "any",
                        "depth": "quick", "queries": []});
        assert!(parse_search_decision(&v2).is_ok());
        // COMPAT opposite polarity: search_required=TRUE + empty queries → REJECTED.
        assert_eq!(parse_search_decision_compat(&v2).unwrap_err(), REFINE_MESSAGE);
        // compat false + empty → OK.
        assert!(parse_search_decision_compat(&v).is_ok());
    }

    #[test]
    fn strict_rejects_unknown_enum_members() {
        let mut v = strict_ok();
        v["freshness"] = json!("fortnight");
        assert!(parse_search_decision(&v)
            .unwrap_err()
            .contains("Invalid enum value"));
        v["freshness"] = json!("week");
        v["queries"][0]["intent"] = json!("restaurant recommendation");
        assert!(parse_search_decision(&v)
            .unwrap_err()
            .contains("Invalid enum value"));
    }

    #[test]
    fn compat_normalizes_legacy_and_passes_unknown_freshness_through() {
        // normalizeFreshness: current→day, recent→month.
        let mut v = strict_ok();
        v["freshness"] = json!("current");
        assert_eq!(parse_search_decision_compat(&v).unwrap().freshness, Freshness::Day);
        v["freshness"] = json!("recent");
        assert_eq!(
            parse_search_decision_compat(&v).unwrap().freshness,
            Freshness::Month
        );
        // TS cast passes truly-unknown values through verbatim.
        v["freshness"] = json!("fortnight");
        let d = parse_search_decision_compat(&v).unwrap();
        assert_eq!(d.freshness, Freshness::Other("fortnight".into()));
        assert_eq!(serde_json::to_string(&d.freshness).unwrap(), "\"fortnight\"");
    }

    #[test]
    fn compat_coerces_free_form_intents() {
        let cases: &[(&str, Intent)] = &[
            ("  NEWS  ", Intent::News), // lower + trim, known-prefix first
            ("newspaper round-up", Intent::News), // startsWith("news")
            ("breaking tonight", Intent::News), // fuzzy
            ("documentation", Intent::Docs), // contains "doc"
            ("api manual", Intent::Docs),
            ("bug hunt", Intent::Code),
            ("arxiv research", Intent::Academic),
            ("reddit thread", Intent::Forum),
            ("restaurant recommendation", Intent::General), // the doc'd example
            ("", Intent::General),
        ];
        for (raw, want) in cases {
            assert_eq!(coerce_intent(raw), *want, "coerce_intent({raw:?})");
        }
    }

    #[test]
    fn js_numbers_serialize_as_integers_when_integral() {
        // fixtures README discovery #1 (RESOLVED Part 3 serializer).
        let rr = RankedResult {
            url: "https://x.dev".into(),
            canonical: "x.dev".into(),
            title: "t".into(),
            snippet: "s".into(),
            engine: "ddg".into(),
            published_date: None,
            domain: "x.dev".into(),
            rrf: 1.0,
            engines: vec!["ddg".into()],
            engine_ranks: {
                let mut m = EngineRanks::new();
                m.insert("ddg".into(), js_number(1.0));
                m
            },
        };
        let s = serde_json::to_string(&rr).unwrap();
        assert!(s.contains(r#""rrf":1,"#), "{s}");
        assert!(s.contains(r#""engineRanks":{"ddg":1}"#), "{s}");
        assert!(!s.contains("publishedDate"), "optional absent, not null");

        let p = EvidencePassage {
            source_id: "S1".into(),
            url: "u".into(),
            title: "t".into(),
            domain: "d".into(),
            published_at: None,
            passage_text: "p".into(),
            bm25_score: 2.5,
        };
        assert!(serde_json::to_string(&p)
            .unwrap()
            .contains(r#""bm25Score":2.5"#));
    }

    #[test]
    fn packet_extraction_and_classification_shapes() {
        let v = json!({
            "sourceId": "S1", "url": "u", "title": "t", "domain": "d",
            "extraction": "jina-fallback", "passages": [],
            "classification": "FAIL_SILENT_BOT_BLOCK"
        });
        let p: EvidencePacket = from_value(&v).unwrap();
        assert_eq!(p.extraction, ExtractionKind::JinaFallback);
        assert_eq!(p.classification.as_deref(), Some("FAIL_SILENT_BOT_BLOCK"));
        // classification is a free string in TS — enums are not enforced.
        let v2 = json!({ "sourceId": "S1", "url": "u", "title": "t", "domain": "d",
                         "extraction": "snippet-only", "passages": [] });
        let p2: EvidencePacket = from_value(&v2).unwrap();
        assert!(p2.classification.is_none());
    }

    #[test]
    fn gate_result_wire_shape() {
        let g = SearchGateResult {
            decision: SearchDecision {
                search_required: true,
                reason: "r".into(),
                freshness: Freshness::Day,
                depth: Depth::Quick,
                queries: vec![SearchQuery {
                    query: "q".into(),
                    intent: Intent::General,
                    preferred_domains: None,
                }],
            },
            source: GateSource::MainModel,
            gate_ms: 0.0,
        };
        let s = serde_json::to_string(&g).unwrap();
        assert!(s.contains(r#""source":"main-model""#), "{s}");
        assert!(s.contains(r#""gateMs":0}"#), "js-integer 0 at struct tail: {s}");
    }
}
