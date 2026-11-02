//! P4 — Presentation router (Rich-Results Addendum §55–§56).
//! ⇔ lib/web-search/presentation.ts
//!
//! Deterministic primary-surface decision: when the structured retrieval
//! result ALREADY tells us the answer (geocoded hits, YouTube videos,
//! news clusters, intent labels), no extra LLM call is paid for the
//! presentation choice (§55). The router reads signals from the evidence
//! bundle and picks ONE primary surface; `None` means plain text (the
//! §53 no-spam law — "Who invented the telephone?" gets an answer, not a
//! card).
//!
//! P5 WIRING: the pipeline calls `derive_presentation` at bundle assembly
//! and stores the plan on `EvidenceBundle.presentation`; the rich-result
//! producer builds the RichResult envelope from the chosen primary and
//! streams it via the additive `web:surface_*` stage events. The ladder
//! order, vocabulary, and
//! reason strings are byte-parity with TS (incl. quirk preservation:
//! `reserv\b`/`vacanc\b` never fire inside "reservation"/"vacancy" on
//! EITHER side — the same behavior both languages is the law; stems like
//! `equit` and the `.{0,24}` shopping gap behave identically, with JS `.`
//! line-semantics ported as `[^\n\r\u{2028}\u{2029}]`).
//!
//! Regex law: every ASCII boundary is scoped `(?-u:\b)` (JS non-/u `\b`
//! — parity law #1); `\s+` (there is none here — literal multi-word gaps
//! stay literal spaces exactly as in TS) and `\w`/`\d` inside "best
//! \w+"/"top \d" are ASCII-scoped `(?-u:...)` (JS non-/u classes).

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::planner_law::{domain_within, PlannerLaw};
use crate::types::{EvidencePacket, Intent, RankedResult, SearchQuery};

/// Verbatim §55 primary vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresentationPrimary {
    Text,
    Images,
    Video,
    Map,
    Weather,
    Finance,
    Sports,
    News,
    Shopping,
    Business,
    Reservation,
    Jobs,
    Events,
    Tracker,
    Entity,
    Table,
    Chart,
    Learning,
    App,
}

/// Verbatim §55 layout vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PresentationLayout {
    Inline,
    Carousel,
    Grid,
    MapSplit,
    Table,
    FullscreenCapable,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationPlan {
    pub primary: PresentationPrimary,
    pub layout: PresentationLayout,
    pub reason: String,
}

/// Signals computed from the bundle (P5 wiring); pure, serializable.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationInput {
    pub user_prompt: String,
    /// Coarse location from the planner law (§11.17), or null.
    pub location: Option<String>,
    /// True when retrieval produced geocoded/coordinate evidence.
    pub has_geo_evidence: bool,
    /// True when the YouTube structured hop returned video results.
    pub has_youtube_video: bool,
    /// Gate + planned intents (lowercased).
    pub intents: Vec<String>,
    /// Top ranked/packet domains, best first (≤5 consulted).
    pub top_domains: Vec<String>,
}

const NEWS_DOMAINS: [&str; 14] = [
    "reuters.com",
    "apnews.com",
    "bbc.com",
    "bbc.co.uk",
    "cnn.com",
    "nytimes.com",
    "theguardian.com",
    "washingtonpost.com",
    "timesofindia.com",
    "hindustantimes.com",
    "ndtv.com",
    "aljazeera.com",
    "cnbc.com",
    "bloomberg.com",
];

/// Cached-lazy pattern helper (patterns are static; one cell per site).
/// The elided lifetime is ambiguous with two input references, so the
/// output lifetime is pinned to the `OnceLock` cell (all cells are
/// function-local `static`s, i.e. `'static`).
fn rx<'a>(cell: &'a OnceLock<Regex>, pat: &str) -> &'a Regex {
    cell.get_or_init(|| Regex::new(pat).expect("static regex"))
}

/// §56 structured-source routing ladder — checked in priority order.
/// The FIRST signal that fires wins (one primary surface by default);
/// the reason string names the signal so the UI can explain its choice.
pub fn plan_presentation(input: &PresentationInput) -> Option<PresentationPlan> {
    let p = input.user_prompt.as_str();
    let top: Vec<&String> = input.top_domains.iter().take(5).collect();

    // 1. Geocoded evidence → map is the primary surface (§56).
    if input.has_geo_evidence {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Map,
            layout: PresentationLayout::MapSplit,
            reason: "geocoded search evidence".to_string(),
        });
    }

    // 2–4. Structured verticals that retrieval already typed.
    static WEATHER: OnceLock<Regex> = OnceLock::new();
    if rx(
        &WEATHER,
        r"(?i)(?-u:\b)(?:weather|forecast|temperature|humidity|air quality|rain|snow|uv index)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Weather,
            layout: PresentationLayout::Inline,
            reason: "weather intent".to_string(),
        });
    }
    static FINANCE: OnceLock<Regex> = OnceLock::new();
    if rx(
        &FINANCE,
        r"(?i)(?-u:\b)(?:stock|stocks|share price|shares|ticker|equit|nasdaq|s&p|sensex|nifty|bitcoin|ethereum|crypto price|exchange rate|market cap)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Finance,
            layout: PresentationLayout::Inline,
            reason: "finance intent".to_string(),
        });
    }
    static SPORTS: OnceLock<Regex> = OnceLock::new();
    if rx(
        &SPORTS,
        r"(?i)(?-u:\b)(?:match|score|standing|standings|points table|leaderboard|tournament|fixture|series|innings|goal)(?-u:\b)",
    )
    .is_match(p)
    {
        static SPORTS_TABLE: OnceLock<Regex> = OnceLock::new();
        let table = rx(
            &SPORTS_TABLE,
            r"(?i)(?-u:\b)(?:standing|standings|points table|leaderboard|table)(?-u:\b)",
        )
        .is_match(p);
        return Some(PresentationPlan {
            primary: PresentationPrimary::Sports,
            layout: if table {
                PresentationLayout::Table
            } else {
                PresentationLayout::Inline
            },
            reason: if table {
                "sports standings".to_string()
            } else {
                "sports intent".to_string()
            },
        });
    }

    // 5. Live-state trackers (status pages, versions, shipments).
    static TRACKER: OnceLock<Regex> = OnceLock::new();
    if rx(
        &TRACKER,
        r"(?i)(?-u:\b)(?:status page|outage|downtime|incident|tracker|tracking number|shipment|package|version|changelog|release notes)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Tracker,
            layout: PresentationLayout::Inline,
            reason: "live-state intent".to_string(),
        });
    }

    // 6–9. Intent-typed asks. (`reserv`/`vacanc` quirk parity: their
    // trailing \b never matches inside the full words — same on both sides.)
    static RESERVATION: OnceLock<Regex> = OnceLock::new();
    if rx(
        &RESERVATION,
        r"(?i)(?-u:\b)(?:reserv|book (?:a |an )?(?:table|room|slot|ticket)|booking)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Reservation,
            layout: PresentationLayout::Inline,
            reason: "reservation intent".to_string(),
        });
    }
    static JOBS: OnceLock<Regex> = OnceLock::new();
    if rx(
        &JOBS,
        r"(?i)(?-u:\b)(?:jobs?|vacanc|hiring|career|internship|job openings?|employment)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Jobs,
            layout: PresentationLayout::Grid,
            reason: "jobs intent".to_string(),
        });
    }
    static EVENTS: OnceLock<Regex> = OnceLock::new();
    if rx(
        &EVENTS,
        r"(?i)(?-u:\b)(?:events?|concert|meetup|webinar|conference|festival|workshop)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Events,
            layout: PresentationLayout::Grid,
            reason: "events intent".to_string(),
        });
    }
    static BUSINESS_WORD: OnceLock<Regex> = OnceLock::new();
    static BUSINESS_INFO: OnceLock<Regex> = OnceLock::new();
    if rx(
        &BUSINESS_WORD,
        r"(?i)(?-u:\b)(?:company|business|startup|restaurant|hotel|clinic|store)(?-u:\b)",
    )
    .is_match(p)
        && rx(
            &BUSINESS_INFO,
            r"(?i)(?-u:\b)(?:hours|rating|reviews?|contact|address|phone|open now)(?-u:\b)",
        )
        .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Business,
            layout: PresentationLayout::Inline,
            reason: "business info intent".to_string(),
        });
    }

    // 10. Localization law or explicit map ask → map split.
    static MAP_WORDS: OnceLock<Regex> = OnceLock::new();
    if input.location.is_some()
        || rx(
            &MAP_WORDS,
            r"(?i)(?-u:\b)(?:map|maps|directions|route|near me|around me|distance)(?-u:\b)",
        )
        .is_match(p)
    {
        let reason = match input.location.as_ref() {
            Some(loc) => format!("coarse location \"{loc}\""),
            None => "map intent".to_string(),
        };
        return Some(PresentationPlan {
            primary: PresentationPrimary::Map,
            layout: PresentationLayout::MapSplit,
            reason,
        });
    }

    // 11. Shopping. (`.` in JS = any char except line terminators.)
    static SHOPPING: OnceLock<Regex> = OnceLock::new();
    if rx(
        &SHOPPING,
        r"(?i)(?-u:\b)(?:buy|purchase|for sale|deal|discount|coupon|shop for|best (?:[^\n\r\u{2028}\u{2029}]){0,24} under|product)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Shopping,
            layout: PresentationLayout::Grid,
            reason: "shopping intent".to_string(),
        });
    }

    // 12. Video results — structured hop or video-domains up top (§56).
    let video_top = top
        .iter()
        .take(2)
        .any(|d| domain_within(d, "youtube.com") || domain_within(d, "youtu.be"));
    if input.has_youtube_video || video_top {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Video,
            layout: PresentationLayout::Carousel,
            reason: "video results in evidence".to_string(),
        });
    }

    // 13. News cluster — gate intent or ≥2 news domains in the top five.
    let news_hits = top
        .iter()
        .filter(|d| NEWS_DOMAINS.iter().any(|n| domain_within(d, n)))
        .count();
    let news_intent = input.intents.iter().any(|i| i == "news");
    if news_intent || news_hits >= 2 {
        return Some(PresentationPlan {
            primary: PresentationPrimary::News,
            layout: PresentationLayout::Grid,
            reason: if news_hits >= 2 {
                format!("{news_hits} news domains in top results")
            } else {
                "news intent".to_string()
            },
        });
    }

    // 14–18. Remaining surfaces.
    static LEARNING: OnceLock<Regex> = OnceLock::new();
    if rx(
        &LEARNING,
        r"(?i)(?-u:\b)(?:tutorial|learn|course|guide|how to|explain|documentation|docs)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Learning,
            layout: PresentationLayout::Grid,
            reason: "learning intent".to_string(),
        });
    }
    if top
        .iter()
        .take(2)
        .any(|d| domain_within(d, "wikipedia.org"))
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Entity,
            layout: PresentationLayout::Inline,
            reason: "entity evidence (wikipedia)".to_string(),
        });
    }
    // TS: /\b(compare|comparison|versus|\bvs\.?\b|difference between|alternative to|best \w+|top \d)/i
    // — outer \b only; the inner `\bvs.?\b` and the ASCII `\w`/`\d` stay
    // ASCII-scoped, and the whole pattern has NO trailing boundary.
    static TABLE: OnceLock<Regex> = OnceLock::new();
    if rx(
        &TABLE,
        r"(?i)(?-u:\b)(?:compare|comparison|versus|(?-u:\b)vs\.?(?-u:\b)|difference between|alternative to|best (?-u:\w+)|top (?-u:\d))",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Table,
            layout: PresentationLayout::Table,
            reason: "comparison intent".to_string(),
        });
    }
    static CHART: OnceLock<Regex> = OnceLock::new();
    if rx(
        &CHART,
        r"(?i)(?-u:\b)(?:trend|trends|over time|history of|growth|chart|statistics|percentage|population)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::Chart,
            layout: PresentationLayout::Inline,
            reason: "trend/statistics intent".to_string(),
        });
    }
    static APP: OnceLock<Regex> = OnceLock::new();
    if rx(
        &APP,
        r"(?i)(?-u:\b)(?:app|apps|software|tool|library|framework|sdk|download|install)(?-u:\b)",
    )
    .is_match(p)
    {
        return Some(PresentationPlan {
            primary: PresentationPrimary::App,
            layout: PresentationLayout::Grid,
            reason: "app intent".to_string(),
        });
    }

    // §53: no rich signal → plain text. Never decorate a plain answer.
    None
}

/// YouTube domain law — structured hop domains and short links alike.
const YOUTUBE_DOMAINS: [&str; 2] = ["youtube.com", "youtu.be"];

/// TS gate intents are canonical lowercase strings; the Rust Intent enum
/// mirrors the exact same labels ("general".."forum"). `Other(s)` is the
/// hand-built escape hatch — lowercased verbatim, never title-cased.
fn intent_label(intent: &Intent) -> String {
    match intent {
        Intent::General => "general",
        Intent::News => "news",
        Intent::Docs => "docs",
        Intent::Code => "code",
        Intent::Academic => "academic",
        Intent::Forum => "forum",
        Intent::Other(s) => return s.to_lowercase(),
    }
    .to_string()
}

/// P5 WIRING — computes the §55 signals from pipeline state and runs the
/// router. `has_geo_evidence` is passed by the caller because coordinates
/// exist ONLY while the Maps companion hop decodes them (§11 law:
/// validated provider data, never prose). Domain law ⇔ TS
/// derivePresentation: ranked results first, then packets, first-seen
/// wins, empties skipped, capped at 5.
pub fn derive_presentation(
    user_prompt: &str,
    planner_law: &PlannerLaw,
    gate_queries: &[SearchQuery],
    search_results: &[RankedResult],
    packets: &[EvidencePacket],
    has_geo_evidence: bool,
) -> Option<PresentationPlan> {
    let mut top_domains: Vec<String> = Vec::new();
    for d in search_results
        .iter()
        .map(|r| r.domain.as_str())
        .chain(packets.iter().map(|p| p.domain.as_str()))
    {
        if d.is_empty() || top_domains.iter().any(|seen| seen == d) {
            continue;
        }
        top_domains.push(d.to_string());
        if top_domains.len() == 5 {
            break;
        }
    }
    let has_youtube_video = packets.iter().any(|p| {
        YOUTUBE_DOMAINS
            .iter()
            .any(|y| domain_within(p.domain.as_str(), y))
    });
    plan_presentation(&PresentationInput {
        user_prompt: user_prompt.to_string(),
        location: planner_law.location.clone(),
        has_geo_evidence,
        has_youtube_video,
        intents: gate_queries
            .iter()
            .map(|q| intent_label(&q.intent))
            .collect(),
        top_domains,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(prompt: &str) -> PresentationInput {
        PresentationInput {
            user_prompt: prompt.to_string(),
            location: None,
            has_geo_evidence: false,
            has_youtube_video: false,
            intents: Vec::new(),
            top_domains: Vec::new(),
        }
    }

    #[test]
    fn geo_evidence_wins_everything() {
        let mut i = input("who invented the telephone");
        i.has_geo_evidence = true;
        let plan = plan_presentation(&i).unwrap();
        assert_eq!(plan.primary, PresentationPrimary::Map);
        assert_eq!(plan.layout, PresentationLayout::MapSplit);
        assert_eq!(plan.reason, "geocoded search evidence");
    }

    #[test]
    fn weather_intent_inline() {
        let plan = plan_presentation(&input("weather tomorrow morning")).unwrap();
        assert_eq!(plan.primary, PresentationPrimary::Weather);
        assert_eq!(plan.layout, PresentationLayout::Inline);
        assert_eq!(plan.reason, "weather intent");
    }

    #[test]
    fn sports_standings_table_vs_match_inline() {
        let t = plan_presentation(&input("ipl points table standings")).unwrap();
        assert_eq!(t.primary, PresentationPrimary::Sports);
        assert_eq!(t.layout, PresentationLayout::Table);
        assert_eq!(t.reason, "sports standings");
        let m = plan_presentation(&input("last night match score goal")).unwrap();
        assert_eq!(m.primary, PresentationPrimary::Sports);
        assert_eq!(m.layout, PresentationLayout::Inline);
        assert_eq!(m.reason, "sports intent");
    }

    #[test]
    fn location_reason_is_quoted_coarse_phrase() {
        let mut i = input("good italian food");
        i.location = Some("Pune".to_string());
        let plan = plan_presentation(&i).unwrap();
        assert_eq!(plan.primary, PresentationPrimary::Map);
        assert_eq!(plan.reason, "coarse location \"Pune\"");
        let m = plan_presentation(&input("directions to the airport")).unwrap();
        assert_eq!(m.reason, "map intent");
    }

    #[test]
    fn youtube_top_two_domains_become_video_carousel() {
        let mut i = input("how does a combustion engine work");
        i.top_domains = vec!["m.youtube.com".to_string(), "youtu.be".to_string()];
        let plan = plan_presentation(&i).unwrap();
        assert_eq!(plan.primary, PresentationPrimary::Video);
        assert_eq!(plan.layout, PresentationLayout::Carousel);
        assert_eq!(plan.reason, "video results in evidence");
    }

    #[test]
    fn news_cluster_counts_top_five() {
        let mut i = input("what happened at the summit");
        i.top_domains = vec![
            "reuters.com".to_string(),
            "cnn.com".to_string(),
            "randomblog.io".to_string(),
        ];
        let plan = plan_presentation(&i).unwrap();
        assert_eq!(plan.primary, PresentationPrimary::News);
        assert_eq!(plan.layout, PresentationLayout::Grid);
        assert_eq!(plan.reason, "2 news domains in top results");
        let mut j = input("what happened at the summit");
        j.intents = vec!["news".to_string()];
        assert_eq!(plan_presentation(&j).unwrap().reason, "news intent");
    }

    #[test]
    fn plain_factual_gets_no_surface() {
        // §53 no-spam law: the canonical "Who invented the telephone?"
        assert_eq!(
            plan_presentation(&input("Who invented the telephone?")),
            None
        );
    }

    #[test]
    fn comparison_table_and_learning_and_app() {
        let t = plan_presentation(&input("compare rust vs go")).unwrap();
        assert_eq!(t.primary, PresentationPrimary::Table);
        assert_eq!(t.layout, PresentationLayout::Table);
        assert_eq!(t.reason, "comparison intent");
        let l = plan_presentation(&input("how to learn async rust tutorial")).unwrap();
        assert_eq!(l.primary, PresentationPrimary::Learning);
        assert_eq!(l.reason, "learning intent");
        let a = plan_presentation(&input("pdf tool library download")).unwrap();
        // No table-words ("best \\w+" WOULD win first), no chart/learning
        // words; app words (tool/library/download) fire the app rung.
        assert_eq!(a.primary, PresentationPrimary::App);
        assert_eq!(a.reason, "app intent");
    }

    #[test]
    fn serde_vocabulary_matches_ts_strings() {
        let plan = plan_presentation(&input("weather in the morning")).unwrap();
        let j = serde_json::to_string(&plan).unwrap();
        assert_eq!(
            j,
            r#"{"primary":"weather","layout":"inline","reason":"weather intent"}"#
        );
        let geo = PresentationInput {
            has_geo_evidence: true,
            ..input("x")
        };
        let j2 = serde_json::to_string(&plan_presentation(&geo).unwrap()).unwrap();
        assert!(j2.contains(r#""layout":"map_split""#));
    }

    // ── derive_presentation (⇔ presentation.test.ts derivePresentation) ──
    use crate::planner_law::derive_planner_law;
    use crate::types::{Depth, Freshness, SearchDecision};
    use serde_json::json;

    fn rr(url: &str, domain: &str) -> RankedResult {
        serde_json::from_value(json!({
            "url": url, "canonical": url, "title": "t", "snippet": "s",
            "engine": "e", "domain": domain, "rrf": 1.0,
            "engines": ["e"], "engineRanks": {}
        }))
        .unwrap()
    }

    fn pk(source_id: &str, domain: &str) -> EvidencePacket {
        serde_json::from_value(json!({
            "sourceId": source_id, "url": format!("https://{domain}/x"), "title": "T",
            "domain": domain, "extraction": "direct", "passages": [],
            "classification": "SUCCESS_OK"
        }))
        .unwrap()
    }

    fn gq(query: &str, intent: Intent) -> SearchQuery {
        SearchQuery {
            query: query.to_string(),
            intent,
            preferred_domains: None,
        }
    }

    fn law(prompt: &str) -> PlannerLaw {
        derive_planner_law(
            prompt,
            &SearchDecision {
                search_required: true,
                reason: String::new(),
                freshness: Freshness::None,
                depth: Depth::Standard,
                queries: vec![],
            },
            None,
        )
    }

    #[test]
    fn derive_video_from_youtube_results() {
        let rs = vec![
            rr("https://www.youtube.com/watch?v=x", "youtube.com"),
            rr("https://youtu.be/y", "youtu.be"),
        ];
        let prompt = "how does a combustion engine work";
        let plan = derive_presentation(prompt, &law(prompt), &[], &rs, &[], false).unwrap();
        assert_eq!(plan.primary, PresentationPrimary::Video);
        assert_eq!(plan.layout, PresentationLayout::Carousel);
        assert_eq!(plan.reason, "video results in evidence");
    }

    #[test]
    fn derive_youtube_packet_sets_has_youtube_video() {
        let rs = vec![rr("https://example.com/a", "example.com")];
        let ps = vec![pk("s1", "youtu.be")];
        let prompt = "who invented the telephone";
        let plan = derive_presentation(prompt, &law(prompt), &[], &rs, &ps, false).unwrap();
        assert_eq!(plan.primary, PresentationPrimary::Video);
    }

    #[test]
    fn derive_domains_dedupe_first_seen() {
        let rs = vec![
            rr("https://reuters.com/1", "reuters.com"),
            rr("https://reuters.com/2", "reuters.com"),
            rr("https://example.com/3", "example.com"),
        ];
        // Deduped top = [reuters, example] → ONE news hit → §53 null.
        // Without first-seen dedupe, two reuters rows would fake a cluster.
        let prompt = "what happened at the summit";
        assert_eq!(
            derive_presentation(prompt, &law(prompt), &[], &rs, &[], false),
            None
        );
    }

    #[test]
    fn derive_top_domains_cap_is_five() {
        let mut rs = Vec::new();
        for d in [
            "x.com",
            "y.com",
            "z.com",
            "w.com",
            "v.com",
            "reuters.com",
            "cnn.com",
        ] {
            rs.push(rr(&format!("https://{d}/1"), d));
        }
        // The cap keeps the top five at x/y/z/w/v; reuters+cnn (positions
        // 6–7) never reach the news rung, so §53 returns plain text.
        let prompt = "what happened at the summit";
        assert_eq!(
            derive_presentation(prompt, &law(prompt), &[], &rs, &[], false),
            None
        );
    }

    #[test]
    fn derive_gate_intent_and_geo_signals() {
        let prompt = "what happened at the summit";
        let qs = vec![gq("q one", Intent::News)];
        let plan = derive_presentation(prompt, &law(prompt), &qs, &[], &[], false).unwrap();
        assert_eq!(plan.primary, PresentationPrimary::News);
        assert_eq!(plan.reason, "news intent");

        let telephone = "who invented the telephone";
        let geo = derive_presentation(telephone, &law(telephone), &[], &[], &[], true).unwrap();
        assert_eq!(geo.primary, PresentationPrimary::Map);
        assert_eq!(geo.reason, "geocoded search evidence");

        let loc = "best restaurants near New York City";
        let plan = derive_presentation(loc, &law(loc), &[], &[], &[], false).unwrap();
        assert_eq!(plan.primary, PresentationPrimary::Map);
        assert_eq!(plan.layout, PresentationLayout::MapSplit);
        assert_eq!(plan.reason, "coarse location \"New York City\"");
    }
}
