//! P5 — Rich-result protocol (Rich-Results Addendum §2, §40, §75).
//!
//! ⇔ TS `lib/web-search/rich-results.ts`. ONE universal structured-result
//! protocol: tool/retrieval evidence → validated `RichResult` envelope →
//! client renderer. The model never authors these envelopes and never
//! invents prices, coordinates, weather values, or source metadata (§3).
//!
//! Trust law: every envelope passes `sanitize_rich_result()` before it
//! crosses to the client — safe-URL validation, embed allowlist,
//! coordinate/NaN rejection, payload size cap, action whitelisting.
//! Unknown kinds fall back to a generic card, never a crash (§2). The
//! parity tests on BOTH sides pin the exact JSON strings byte-for-byte.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use url::Url;

use crate::planner_law::domain_within;
use crate::presentation::{PresentationLayout, PresentationPlan, PresentationPrimary};
use crate::types::{js_number, EvidencePacket, RankedResult};

/// §2 kind vocabulary (order ⇔ TS RICH_RESULT_KINDS).
pub const RICH_RESULT_KINDS: [&str; 29] = [
    "generic",
    "sources",
    "image_gallery",
    "video",
    "audio",
    "map",
    "local_business",
    "weather",
    "finance",
    "sports",
    "news",
    "product",
    "product_carousel",
    "product_comparison",
    "restaurant",
    "reservation",
    "job",
    "event",
    "tracker",
    "entity",
    "table",
    "chart",
    "metrics",
    "timeline",
    "flashcards",
    "quiz",
    "simulation",
    "file",
    "app",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RichKind {
    Generic,
    Sources,
    ImageGallery,
    Video,
    Audio,
    Map,
    LocalBusiness,
    Weather,
    Finance,
    Sports,
    News,
    Product,
    ProductCarousel,
    ProductComparison,
    Restaurant,
    Reservation,
    Job,
    Event,
    Tracker,
    Entity,
    Table,
    Chart,
    Metrics,
    Timeline,
    Flashcards,
    Quiz,
    Simulation,
    File,
    App,
}

fn kind_from_str(k: &str) -> Option<RichKind> {
    RICH_RESULT_KINDS
        .into_iter()
        .find(|&s| s == k)
        .map(|s| match s {
            "generic" => RichKind::Generic,
            "sources" => RichKind::Sources,
            "image_gallery" => RichKind::ImageGallery,
            "video" => RichKind::Video,
            "audio" => RichKind::Audio,
            "map" => RichKind::Map,
            "local_business" => RichKind::LocalBusiness,
            "weather" => RichKind::Weather,
            "finance" => RichKind::Finance,
            "sports" => RichKind::Sports,
            "news" => RichKind::News,
            "product" => RichKind::Product,
            "product_carousel" => RichKind::ProductCarousel,
            "product_comparison" => RichKind::ProductComparison,
            "restaurant" => RichKind::Restaurant,
            "reservation" => RichKind::Reservation,
            "job" => RichKind::Job,
            "event" => RichKind::Event,
            "tracker" => RichKind::Tracker,
            "entity" => RichKind::Entity,
            "table" => RichKind::Table,
            "chart" => RichKind::Chart,
            "metrics" => RichKind::Metrics,
            "timeline" => RichKind::Timeline,
            "flashcards" => RichKind::Flashcards,
            "quiz" => RichKind::Quiz,
            "simulation" => RichKind::Simulation,
            "file" => RichKind::File,
            "app" => RichKind::App,
            _ => RichKind::Generic,
        })
}

/// §40 action bridge — 10 variants; the client executes ONLY these.
/// Variant field order ⇔ TS zod object order; `type` tag is emitted
/// first (⇔ TS object literal `{ type, … }`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RichAction {
    OpenSource {
        url: String,
    },
    OpenDetail {
        #[serde(rename = "targetId")]
        target_id: String,
    },
    Lightbox {
        #[serde(rename = "targetId")]
        target_id: String,
    },
    Fullscreen {
        #[serde(rename = "targetId")]
        target_id: String,
    },
    Pip {
        #[serde(rename = "targetId")]
        target_id: String,
    },
    IssueFollowup {
        prompt: String,
    },
    Compare {
        ids: Vec<String>,
    },
    SelectMapPin {
        id: String,
    },
    SeekMedia {
        // js_number token parity ⇔ JSON.stringify: integer-valued seconds
        // serialize as `5`, not serde's `5.0` (decimals pass through).
        #[serde(serialize_with = "crate::types::js_number_ser::serialize")]
        seconds: f64,
    },
    PrepareAction {
        action_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RichPreferred {
    Inline,
    Carousel,
    Grid,
    Fullscreen,
    Pip,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RichPresentationHint {
    preferred: RichPreferred,
}

/// Envelope key order ⇔ zod schema shape order ⇔ TS output key order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RichResult {
    pub id: String,
    pub version: u8,
    pub kind: RichKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub source_refs: Vec<String>,
    /// `z.unknown()` — an absent payload stays absent in the TS zod output
    /// (⇔ Option), while an explicit `null` payload survives as null.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<RichAction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<RichPresentationHint>,
}

/// Map evidence gathered by the Maps companion hop (validated provider only).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoPoint {
    pub id: String,
    pub lat: f64,
    pub lng: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
}

// ── §75 validation law ───────────────────────────────────────────────────

/// JS `String.length` (UTF-16 code units) — zod `.max()` counts the same.
fn js_len(s: &str) -> usize {
    s.chars()
        .map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 })
        .sum()
}

/// JS `JSON.stringify(x).length` on a UTF-16 measure basis.
fn json_js_len(v: &Value) -> usize {
    js_len(&v.to_string())
}

fn urlish_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| {
        Regex::new(r"(?i)url|uri|href|src|link|embed|thumb|image|poster|artwork|avatar|website")
            .unwrap()
    })
}

/// §61 embed allowlist — explicit, nothing else may frame inside chat.
const EMBED_HOSTS: [&str; 2] = ["www.youtube-nocookie.com", "www.openstreetmap.org"];

fn control_rx() -> &'static Regex {
    // ASCII \u{} escapes ONLY (literal invisible chars in a class are a hazard).
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| {
        Regex::new(r"[\x00-\x1f\x7f\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]").unwrap()
    })
}

const FORBIDDEN_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];
pub const MAX_PAYLOAD_BYTES: usize = 65_536;
const MAX_DEPTH: usize = 8;
const MAX_NODES: usize = 4000;

/// Safe display URL: http(s) only, no credentials, no hostless/loopback-ish
/// bare names, no control/bidi characters, length-capped. (javascript:,
/// data:, file:, localhost, .local, .onion, and IP-literal hosts are out.)
/// ⇔ TS isSafeHttpUrl. Returns the validated hostname on success.
fn safe_host(u: &str) -> Option<String> {
    if u.is_empty() || js_len(u) > 2048 {
        return None;
    }
    if u.chars().any(char::is_whitespace) || control_rx().is_match(u) {
        return None;
    }
    let parsed = Url::parse(u).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = parsed.host_str()?.to_lowercase();
    let host = host.strip_prefix('[').unwrap_or(&host);
    let host = host.strip_suffix(']').unwrap_or(host);
    if host.is_empty() {
        return None;
    }
    if host == "localhost" || host.ends_with(".local") || host.ends_with(".onion") {
        return None;
    }
    if !host.contains('.') && !host.contains(':') {
        return None; // bare name / single label
    }
    if host.replace('.', "").chars().all(|c| c.is_ascii_digit()) {
        return None; // IPv4 literal
    }
    if parsed.host_str().is_some_and(|h| h.starts_with('[')) {
        return None; // IPv6 literal
    }
    Some(parsed.host_str().unwrap_or("").to_lowercase())
}

pub fn is_safe_http_url(u: &Value) -> bool {
    match u.as_str() {
        Some(s) => safe_host(s).is_some(),
        None => false,
    }
}

enum CoordOut {
    Absent,
    Invalid,
    Valid(f64, f64),
}

/// lat/lng (and lon/latitude/longitude aliases) validated pair-wise.
/// `??` semantics ⇔ first non-null value among the aliases.
fn coords_valid(obj: &Map<String, Value>) -> CoordOut {
    // `??` semantics: first NON-null value among the aliases (null is
    // nullish, so it falls through to the next alias).
    let pick = |keys: &[&str]| -> Option<&Value> {
        keys.iter()
            .filter_map(|k| obj.get(*k))
            .find(|v| !v.is_null())
    };
    let lat = pick(&["lat", "latitude"]);
    let lng = pick(&["lng", "lon", "longitude"]);
    if lat.is_none() && lng.is_none() {
        return CoordOut::Absent;
    }
    let lat_ok = lat
        .and_then(Value::as_f64)
        .is_some_and(|v| v.is_finite() && (-90.0..=90.0).contains(&v));
    let lng_ok = lng
        .and_then(Value::as_f64)
        .is_some_and(|v| v.is_finite() && (-180.0..=180.0).contains(&v));
    match (lat_ok, lng_ok) {
        (true, true) => CoordOut::Valid(
            lat.and_then(Value::as_f64).unwrap(),
            lng.and_then(Value::as_f64).unwrap(),
        ),
        _ => CoordOut::Invalid, // present-but-invalid ⇒ strip the pair (§75)
    }
}

struct WalkBudget {
    nodes: usize,
    overflow: bool,
}

/// Payload hygiene walker (§75): drops forbidden keys, non-safe URL-ish
/// strings, non-allowlisted embeds, invalid coordinate pairs; enforces
/// depth/node budgets. serde_json cannot carry NaN/Infinity (parse-time
/// null ⇔ JS non-finite drop). ⇔ TS sanitizeValue.
fn sanitize_value(v: &Value, depth: usize, budget: &mut WalkBudget) -> Option<Value> {
    if budget.overflow {
        return None;
    }
    budget.nodes += 1;
    if budget.nodes > MAX_NODES {
        budget.overflow = true;
        return None;
    }
    match v {
        Value::Null => Some(Value::Null),
        // JSON.stringify formats JS numbers (5, not 5.0) — re-emit every
        // float through `js_number` so both sides write identical tokens.
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                Some(v.clone())
            } else {
                Some(js_number(n.as_f64().unwrap_or(0.0)))
            }
        }
        Value::Bool(_) | Value::String(_) => Some(v.clone()),
        Value::Array(items) => {
            if depth >= MAX_DEPTH {
                return None;
            }
            let out: Vec<Value> = items
                .iter()
                .filter_map(|item| sanitize_value(item, depth + 1, budget))
                .collect();
            Some(Value::Array(out))
        }
        Value::Object(src) => {
            if depth >= MAX_DEPTH {
                return None;
            }
            let coords = coords_valid(src);
            let mut out = Map::new();
            for (k, val) in src.iter() {
                if FORBIDDEN_KEYS.contains(&k.as_str()) {
                    continue;
                }
                let is_coord_key =
                    matches!(k.as_str(), "lat" | "lng" | "lon" | "latitude" | "longitude");
                if is_coord_key {
                    continue; // emitted canonically as lat/lng below
                }
                let cleaned = match sanitize_value(val, depth + 1, budget) {
                    Some(c) => c,
                    None => continue,
                };
                if cleaned.is_string() && urlish_rx().is_match(k) {
                    let s = cleaned.as_str().unwrap();
                    let host = match safe_host(s) {
                        Some(h) => h,
                        None => continue,
                    };
                    if k.to_lowercase().contains("embed") && !EMBED_HOSTS.contains(&host.as_str()) {
                        continue;
                    }
                }
                out.insert(k.clone(), cleaned);
            }
            if let CoordOut::Valid(lat, lng) = coords {
                out.insert("lat".into(), js_number(lat));
                out.insert("lng".into(), js_number(lng));
            }
            Some(Value::Object(out))
        }
    }
}

/// zod-equivalent single-action validator (strict object, 10 variants).
fn parse_action(v: &Value) -> Option<RichAction> {
    let o = v.as_object()?;
    let str_field = |k: &str, min: usize, max: usize| -> Option<String> {
        o.get(k)
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .filter(|s| js_len(s) >= min && js_len(s) <= max)
    };
    let only_keys = |extra: &[&str]| -> bool {
        let mut allowed: HashSet<&str> = extra.iter().copied().collect();
        allowed.insert("type");
        o.keys().all(|k| allowed.contains(k.as_str()))
    };
    match o.get("type").and_then(Value::as_str)? {
        "open_source" if only_keys(&["url"]) => Some(RichAction::OpenSource {
            url: str_field("url", 1, 2048)?,
        }),
        "open_detail" if only_keys(&["targetId"]) => Some(RichAction::OpenDetail {
            target_id: str_field("targetId", 1, 120)?,
        }),
        "lightbox" if only_keys(&["targetId"]) => Some(RichAction::Lightbox {
            target_id: str_field("targetId", 1, 120)?,
        }),
        "fullscreen" if only_keys(&["targetId"]) => Some(RichAction::Fullscreen {
            target_id: str_field("targetId", 1, 120)?,
        }),
        "pip" if only_keys(&["targetId"]) => Some(RichAction::Pip {
            target_id: str_field("targetId", 1, 120)?,
        }),
        "issue_followup" if only_keys(&["prompt"]) => Some(RichAction::IssueFollowup {
            prompt: str_field("prompt", 1, 2000)?,
        }),
        "compare" if only_keys(&["ids"]) => {
            let arr = o.get("ids")?.as_array()?;
            if arr.is_empty() || arr.len() > 16 {
                return None;
            }
            let ids: Option<Vec<String>> = arr
                .iter()
                .map(|i| {
                    i.as_str()
                        .map(String::from)
                        .filter(|s| js_len(s) >= 1 && js_len(s) <= 120)
                })
                .collect();
            Some(RichAction::Compare { ids: ids? })
        }
        "select_map_pin" if only_keys(&["id"]) => Some(RichAction::SelectMapPin {
            id: str_field("id", 1, 120)?,
        }),
        "seek_media" if only_keys(&["seconds"]) => {
            let s = o.get("seconds")?.as_f64()?;
            if s.is_finite() && (0.0..=86_400.0).contains(&s) {
                Some(RichAction::SeekMedia { seconds: s })
            } else {
                None
            }
        }
        "prepare_action" if only_keys(&["actionId"]) => Some(RichAction::PrepareAction {
            action_id: str_field("actionId", 1, 120)?,
        }),
        _ => None,
    }
}

fn parse_preferred(v: &Value) -> Option<RichPreferred> {
    let o = v.as_object()?;
    if o.keys().any(|k| k != "preferred") {
        return None;
    }
    match o.get("preferred").and_then(Value::as_str)? {
        "inline" => Some(RichPreferred::Inline),
        "carousel" => Some(RichPreferred::Carousel),
        "grid" => Some(RichPreferred::Grid),
        "fullscreen" => Some(RichPreferred::Fullscreen),
        "pip" => Some(RichPreferred::Pip),
        _ => None,
    }
}

/// §75 graceful validation: returns a safe envelope or None (drop the
/// surface). Unknown kind ⇒ generic card; oversized payload ⇒ drop;
/// invalid actions dropped individually before the envelope itself.
/// ⇔ TS sanitizeRichResult.
pub fn sanitize_rich_result(raw: &Value) -> Option<RichResult> {
    let src = raw.as_object()?;
    // missing/empty id ⇒ drop (length checked at the envelope stage below)
    src.get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    match src.get("version") {
        None => {}                               // undefined ⇒ default 1
        Some(v) if v.as_f64() == Some(1.0) => {} // version !== 1 ⇒ drop
        Some(_) => return None,
    }
    let kind = match src
        .get("kind")
        .and_then(Value::as_str)
        .and_then(kind_from_str)
    {
        Some(k) => k,
        None => RichKind::Generic, // §2 unknown-kind fallback
    };
    let source_refs: Vec<Value> = src
        .get("sourceRefs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let payload: Option<Value> = match src.get("payload") {
        None => None, // undefined payload ⇒ key absent in the zod output
        Some(p) => {
            let mut budget = WalkBudget {
                nodes: 0,
                overflow: false,
            };
            let cleaned = sanitize_value(p, 0, &mut budget)?;
            if budget.overflow || json_js_len(&cleaned) > MAX_PAYLOAD_BYTES {
                return None; // §75 oversized / node overflow
            }
            Some(cleaned)
        }
    };

    // actions individually validated first (>12 ⇒ envelope fails at the
    // strict stage; presentation-retry re-fails ⇒ drop — mirrored).
    let actions: Option<Vec<RichAction>> = match src.get("actions") {
        None => None,
        Some(a) => {
            let list: Vec<Value> = a.as_array().cloned().unwrap_or_default();
            let kept: Vec<RichAction> = list.iter().filter_map(parse_action).collect();
            if kept.is_empty() {
                None
            } else {
                Some(kept)
            }
        }
    };

    let build = |presentation: Option<RichPreferred>| -> Option<RichResult> {
        let str_opt = |k: &str, max: usize| -> Option<Option<String>> {
            match src.get(k) {
                None => Some(None),
                Some(Value::String(s)) if js_len(s) <= max => Some(Some(s.clone())),
                Some(_) => None, // present-but-invalid ⇒ strict-parse fail
            }
        };
        let title = str_opt("title", 300)?;
        let subtitle = str_opt("subtitle", 300)?;
        if source_refs.len() > 64 {
            return None;
        }
        let refs: Option<Vec<String>> = source_refs
            .iter()
            .map(|r| {
                r.as_str()
                    .map(String::from)
                    .filter(|s| !s.is_empty() && js_len(s) <= 160)
            })
            .collect();
        let refs = refs?;
        let id = src
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| js_len(s) <= 160)?;
        let actions = actions.clone();
        if actions.as_ref().is_some_and(|a| a.len() > 12) {
            return None;
        }
        Some(RichResult {
            id: id.to_string(),
            version: 1,
            kind,
            title,
            subtitle,
            source_refs: refs,
            payload: payload.clone(),
            actions,
            presentation: presentation.map(|preferred| RichPresentationHint { preferred }),
        })
    };

    // Graceful retry: a broken optional presentation hint must not kill a
    // sound result.
    match src.get("presentation") {
        None => build(None),
        Some(p) => match parse_preferred(p) {
            Some(pr) => build(Some(pr)),
            None => build(None),
        },
    }
}

// ── Producer: evidence → surfaces (never model-authored) ────────────────

const YOUTUBE_DOMAINS: [&str; 2] = ["youtube.com", "youtu.be"];
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

fn yt_rx() -> &'static Regex {
    static RX: OnceLock<Regex> = OnceLock::new();
    RX.get_or_init(|| {
        Regex::new(r"(?:[?&]v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})").unwrap()
    })
}

fn youtube_video_id(url: &str) -> Option<String> {
    yt_rx().captures(url).map(|c| c[1].to_string())
}

fn preferred_for(layout: PresentationLayout) -> RichPreferred {
    match layout {
        PresentationLayout::Carousel => RichPreferred::Carousel,
        PresentationLayout::Grid => RichPreferred::Grid,
        PresentationLayout::FullscreenCapable => RichPreferred::Fullscreen,
        _ => RichPreferred::Inline,
    }
}

pub struct RichResultSource<'a> {
    pub plan: Option<&'a PresentationPlan>,
    pub results: &'a [RankedResult],
    pub packets: &'a [EvidencePacket],
    pub geo_points: &'a [GeoPoint],
}

/// Deterministic producer (§54: ONE primary surface by default). Surfaces
/// exist ONLY where retrieval already carries the structured data (§3/§56):
/// video → YouTube evidence; map → validated geo pins; news → news-domain
/// results; entity → the Wikipedia packet. Every other primary keeps prose
/// + citation pills (§53 honesty — no synthesized weather/finance payloads).
/// ⇔ TS deriveRichResults.
pub fn derive_rich_results(src: &RichResultSource) -> Vec<RichResult> {
    let plan = match src.plan {
        Some(p) => p,
        None => return Vec::new(),
    };
    let pres = || {
        Some(RichPresentationHint {
            preferred: preferred_for(plan.layout),
        })
    };
    let mut out: Vec<RichResult> = Vec::new();

    match plan.primary {
        PresentationPrimary::Video => {
            let mut seen: HashSet<String> = HashSet::new();
            let mut made = 0usize;
            let mut push = |domain: &str,
                            url: &str,
                            source_id: &str,
                            title: &str,
                            out: &mut Vec<RichResult>| {
                if made >= 6 {
                    return;
                }
                if !YOUTUBE_DOMAINS.iter().any(|y| domain_within(domain, y)) {
                    return;
                }
                let video_id = match youtube_video_id(url) {
                    Some(v) => v,
                    None => return,
                };
                if seen.contains(&video_id) {
                    return;
                }
                seen.insert(video_id.clone());
                made += 1;
                let watch_url = format!("https://www.youtube.com/watch?v={video_id}");
                let mut payload = Map::new();
                payload.insert("videoId".into(), json!(video_id));
                payload.insert("url".into(), json!(&watch_url));
                payload.insert(
                    "thumbnail".into(),
                    json!(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")),
                );
                out.push(RichResult {
                    id: format!("rich:video:{video_id}"),
                    version: 1,
                    kind: RichKind::Video,
                    title: if title.is_empty() {
                        None
                    } else {
                        Some(title.to_string())
                    },
                    subtitle: None,
                    source_refs: vec![source_id.to_string()],
                    payload: Some(Value::Object(payload)),
                    actions: Some(vec![RichAction::OpenSource { url: watch_url }]),
                    presentation: pres(),
                });
            };
            for p in src.packets {
                push(&p.domain, &p.url, &p.source_id, &p.title, &mut out);
            }
            for r in src.results {
                push(&r.domain, &r.url, &r.domain, &r.title, &mut out);
            }
        }
        PresentationPrimary::Map if !src.geo_points.is_empty() => {
            let pins: &[GeoPoint] = &src.geo_points[..src.geo_points.len().min(10)];
            let first = &pins[0];
            let payload_pins: Vec<Value> = pins
                .iter()
                .map(|g| {
                    let mut pin = Map::new();
                    pin.insert("id".into(), json!(&g.id));
                    pin.insert("lat".into(), json!(g.lat));
                    pin.insert("lng".into(), json!(g.lng));
                    if let Some(l) = &g.label {
                        pin.insert("label".into(), json!(l));
                    }
                    if let Some(a) = &g.address {
                        pin.insert("address".into(), json!(a));
                    }
                    if let Some(u) = &g.url {
                        pin.insert("url".into(), json!(u));
                    }
                    Value::Object(pin)
                })
                .collect();
            let mut payload = Map::new();
            payload.insert("pins".into(), Value::Array(payload_pins));
            out.push(RichResult {
                id: "rich:map".into(),
                version: 1,
                kind: RichKind::Map,
                title: None,
                subtitle: None,
                source_refs: pins.iter().filter_map(|g| g.source_ref.clone()).collect(),
                payload: Some(Value::Object(payload)),
                actions: first
                    .url
                    .as_ref()
                    .map(|u| vec![RichAction::OpenSource { url: u.clone() }]),
                presentation: pres(),
            });
        }
        PresentationPrimary::News => {
            let mut seen: HashSet<String> = HashSet::new();
            let mut items: Vec<Value> = Vec::new();
            for r in src.results {
                if items.len() >= 8 {
                    break;
                }
                if !NEWS_DOMAINS.iter().any(|n| domain_within(&r.domain, n))
                    || seen.contains(&r.canonical)
                {
                    continue;
                }
                seen.insert(r.canonical.clone());
                let mut item = Map::new();
                item.insert("title".into(), json!(&r.title));
                item.insert("url".into(), json!(&r.canonical));
                item.insert("domain".into(), json!(&r.domain));
                if let Some(pd) = &r.published_date {
                    item.insert("publishedAt".into(), json!(pd));
                }
                items.push(Value::Object(item));
            }
            if !items.is_empty() {
                let source_refs = items
                    .iter()
                    .map(|i| i["domain"].as_str().unwrap().to_string())
                    .collect();
                let mut payload = Map::new();
                payload.insert("items".into(), Value::Array(items));
                out.push(RichResult {
                    id: "rich:news".into(),
                    version: 1,
                    kind: RichKind::News,
                    title: Some("News".into()),
                    subtitle: None,
                    source_refs,
                    payload: Some(Value::Object(payload)),
                    actions: None,
                    presentation: pres(),
                });
            }
        }
        PresentationPrimary::Entity => {
            if let Some(wiki) = src
                .packets
                .iter()
                .find(|p| domain_within(&p.domain, "wikipedia.org"))
            {
                let text = wiki
                    .passages
                    .first()
                    .map(|p| p.passage_text.clone())
                    .unwrap_or_default();
                let mut payload = Map::new();
                payload.insert("url".into(), json!(&wiki.url));
                if !text.is_empty() {
                    let desc: String = text.chars().take(480).collect();
                    payload.insert("description".into(), json!(desc));
                }
                out.push(RichResult {
                    id: format!("rich:entity:{}", wiki.source_id),
                    version: 1,
                    kind: RichKind::Entity,
                    title: if wiki.title.is_empty() {
                        None
                    } else {
                        Some(wiki.title.clone())
                    },
                    subtitle: Some(wiki.domain.clone()),
                    source_refs: vec![wiki.source_id.clone()],
                    payload: Some(Value::Object(payload)),
                    actions: Some(vec![RichAction::OpenSource {
                        url: wiki.url.clone(),
                    }]),
                    presentation: pres(),
                });
            }
        }
        _ => {}
    }

    // Belt-and-braces: producer output re-enters the §75 walker.
    out.iter()
        .filter_map(|r| sanitize_rich_result(&serde_json::to_value(r).unwrap()))
        .collect()
}

/* ── tests ────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{PresentationLayout, PresentationPlan};
    use crate::types::{EngineRanks, EvidencePacket, ExtractionKind, RankedResult};

    fn pl(primary: PresentationPrimary, layout: PresentationLayout) -> PresentationPlan {
        PresentationPlan {
            primary,
            layout,
            reason: "test".into(),
        }
    }

    fn ranked(url: &str, domain: &str, title: &str) -> RankedResult {
        RankedResult {
            url: url.into(),
            canonical: url.into(),
            title: title.into(),
            snippet: String::new(),
            engine: "e".into(),
            published_date: None,
            domain: domain.into(),
            rrf: 1.0,
            engines: vec!["e".into()],
            engine_ranks: EngineRanks::default(),
            origin: None,
        }
    }

    fn packet(
        source_id: &str,
        url: &str,
        domain: &str,
        title: &str,
        passage: &str,
    ) -> EvidencePacket {
        EvidencePacket {
            source_id: source_id.into(),
            url: url.into(),
            title: title.into(),
            domain: domain.into(),
            published_at: None,
            extraction: ExtractionKind::Direct,
            passages: if passage.is_empty() {
                Vec::new()
            } else {
                vec![crate::types::EvidencePassage {
                    source_id: source_id.into(),
                    url: url.into(),
                    title: title.into(),
                    domain: domain.into(),
                    published_at: None,
                    passage_text: passage.into(),
                    bm25_score: 0.0,
                }]
            },
            classification: None,
        }
    }

    #[test]
    fn kind_vocabulary_serializes_exactly_like_ts() {
        let kinds: Vec<String> = [
            RichKind::Generic,
            RichKind::Sources,
            RichKind::ImageGallery,
            RichKind::Video,
            RichKind::Audio,
            RichKind::Map,
            RichKind::LocalBusiness,
            RichKind::Weather,
            RichKind::Finance,
            RichKind::Sports,
            RichKind::News,
            RichKind::Product,
            RichKind::ProductCarousel,
            RichKind::ProductComparison,
            RichKind::Restaurant,
            RichKind::Reservation,
            RichKind::Job,
            RichKind::Event,
            RichKind::Tracker,
            RichKind::Entity,
            RichKind::Table,
            RichKind::Chart,
            RichKind::Metrics,
            RichKind::Timeline,
            RichKind::Flashcards,
            RichKind::Quiz,
            RichKind::Simulation,
            RichKind::File,
            RichKind::App,
        ]
        .iter()
        .map(|k| {
            serde_json::to_value(k)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
        assert_eq!(kinds, RICH_RESULT_KINDS.to_vec());
    }

    #[test]
    fn actions_are_tagged_and_camelcase() {
        assert_eq!(
            serde_json::to_string(&RichAction::OpenSource {
                url: "https://x.example/1".into()
            })
            .unwrap(),
            r#"{"type":"open_source","url":"https://x.example/1"}"#
        );
        assert_eq!(
            serde_json::to_string(&RichAction::SeekMedia { seconds: 5.0 }).unwrap(),
            r#"{"type":"seek_media","seconds":5}"#
        );
        assert_eq!(
            serde_json::to_string(&RichAction::OpenDetail {
                target_id: "t1".into()
            })
            .unwrap(),
            r#"{"type":"open_detail","targetId":"t1"}"#
        );
    }

    #[test]
    fn safe_url_law() {
        assert!(safe_host("https://example.com/a").is_some());
        assert!(safe_host("javascript:alert(1)").is_none());
        assert!(safe_host("data:text/html,x").is_none());
        assert!(safe_host("file:///etc/passwd").is_none());
        assert!(safe_host("http://localhost:3000").is_none());
        assert!(safe_host("http://127.0.0.1").is_none());
        assert!(safe_host("http://[::1]/").is_none());
        assert!(safe_host("http://barename").is_none());
        assert!(safe_host("http://user:pass@evil.example/").is_none());
        assert!(safe_host("http://x.onion/").is_none());
        assert!(safe_host("https://ex ample.com/").is_none());
        // Bidi-override character must be rejected — escape it in source
        // (literal U+202E inside a string literal is a compiler error AND
        // a screen-ordering hazard).
        assert!(safe_host("https://ex\u{202E}ample.com/").is_none());
        assert_eq!(
            safe_host("https://WWW.Example.com/x").unwrap(),
            "www.example.com"
        );
    }

    #[test]
    fn sanitizer_rejects_bad_payloads_and_falls_back() {
        // §75 reject matrix (mirrors the TS test suite strings).
        let drop = |v: Value| assert!(sanitize_rich_result(&v).is_none(), "should drop: {v}");
        drop(json!({"kind": "map"})); // missing id
        drop(json!({"id": "", "kind": "map"}));
        drop(json!({"id": "x", "version": 2, "kind": "map"})); // unknown protocol version
        drop(json!({"id": "x", "kind": "map", "payload": {"big": "x".repeat(70000)}}));
        // javascript url stripped (key-ish), payload survives with the field gone
        let r = sanitize_rich_result(&json!({
            "id": "x", "kind": "map",
            "payload": {"url": "javascript:alert(1)", "ok": 1}
        }))
        .unwrap();
        assert_eq!(r.payload, Some(json!({"ok": 1})));
        // invalid coordinate pair stripped, valid kept
        let r = sanitize_rich_result(&json!({
            "id": "y", "kind": "map",
            "payload": {"a": {"lat": 999, "lng": 0}, "b": {"latitude": 12.5, "longitude": 75.0}}
        }))
        .unwrap();
        // 75.0 ⇒ JSON token "75" (js_number law ⇔ JSON.stringify).
        assert_eq!(
            r.payload,
            Some(json!({"a": {}, "b": {"lat": 12.5, "lng": 75}}))
        );
        // non-allowlisted embed dropped; allowlisted kept
        let r = sanitize_rich_result(&json!({
            "id": "z", "kind": "video",
            "payload": {"embed": "https://evil.example/embed", "ok": "https://www.youtube-nocookie.com/embed/abc"}
        }))
        .unwrap();
        let pay = r.payload.unwrap();
        assert!(pay.get("embed").is_none());
        assert!(pay.get("ok").is_some());
        // unknown kind ⇒ generic card (§2)
        let r =
            sanitize_rich_result(&json!({"id": "k", "kind": "holodeck", "payload": {}})).unwrap();
        assert_eq!(r.kind, RichKind::Generic);
        // invalid actions dropped individually; bad presentation hint retried away
        let r = sanitize_rich_result(&json!({
            "id": "a", "kind": "video", "payload": {},
            "actions": [{"type": "hack"}, {"type": "open_source", "url": "https://ok.example/1"}],
            "presentation": {"preferred": "sideways"}
        }))
        .unwrap();
        assert_eq!(
            r.actions,
            Some(vec![RichAction::OpenSource {
                url: "https://ok.example/1".into()
            }])
        );
        assert_eq!(r.presentation, None);
        // prototype-pollution keys stripped
        let r = sanitize_rich_result(&json!({
            "id": "p", "kind": "generic",
            "payload": {"__proto__": {"a": 1}, "constructor": 2, "kept": true}
        }))
        .unwrap();
        assert_eq!(r.payload, Some(json!({"kept": true})));
        // >12 actions ⇒ drop (mirrors the TS strict-parse + retry law)
        let mut acts: Vec<Value> = Vec::new();
        for i in 0..13 {
            acts.push(json!({"type": "open_detail", "targetId": format!("t{i}")}));
        }
        drop(json!({"id": "n", "kind": "generic", "payload": {}, "actions": acts}));
    }

    #[test]
    fn producer_emits_only_structured_evidence_surfaces() {
        // video: youtube packet + ranked result, dedupe by video id
        let plan = pl(PresentationPrimary::Video, PresentationLayout::Carousel);
        let packets = vec![packet(
            "S1",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "youtube.com",
            "Rick Astley",
            "",
        )];
        let results = vec![
            ranked(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "youtube.com",
                "dup",
            ),
            ranked("https://youtu.be/9bZkp7q19f0", "youtu.be", "Gangnam"),
            ranked("https://example.com/no", "example.com", "no"),
        ];
        let src = RichResultSource {
            plan: Some(&plan),
            results: &results,
            packets: &packets,
            geo_points: &[],
        };
        let got = derive_rich_results(&src);
        assert_eq!(got.len(), 2);
        assert_eq!(
            serde_json::to_string(&got[0]).unwrap(),
            r#"{"id":"rich:video:dQw4w9WgXcQ","version":1,"kind":"video","title":"Rick Astley","sourceRefs":["S1"],"payload":{"videoId":"dQw4w9WgXcQ","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","thumbnail":"https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"},"actions":[{"type":"open_source","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}],"presentation":{"preferred":"carousel"}}"#
        );
        assert_eq!(got[1].source_refs, vec!["youtu.be".to_string()]);

        // map: pins from validated geo evidence only
        let geo = vec![GeoPoint {
            id: "pin1".into(),
            lat: 12.9152,
            lng: 77.5245,
            label: Some("India Gate".into()),
            address: None,
            url: Some("https://maps.google.com/?q=India+Gate".into()),
            source_ref: Some("maps".into()),
        }];
        let plan = pl(PresentationPrimary::Map, PresentationLayout::MapSplit);
        let src = RichResultSource {
            plan: Some(&plan),
            results: &[],
            packets: &[],
            geo_points: &geo,
        };
        let got = derive_rich_results(&src);
        assert_eq!(
            serde_json::to_string(&got[0]).unwrap(),
            r#"{"id":"rich:map","version":1,"kind":"map","sourceRefs":["maps"],"payload":{"pins":[{"id":"pin1","label":"India Gate","url":"https://maps.google.com/?q=India+Gate","lat":12.9152,"lng":77.5245}]},"actions":[{"type":"open_source","url":"https://maps.google.com/?q=India+Gate"}],"presentation":{"preferred":"inline"}}"#
        );

        // news: news-domain ranked results only
        let plan = pl(PresentationPrimary::News, PresentationLayout::Grid);
        let mut r1 = ranked("https://reuters.com/world/1", "reuters.com", "Summit ends");
        r1.published_date = Some("2026-11-01".into());
        let results = vec![
            r1,
            ranked("https://reuters.com/world/1", "reuters.com", "dup"),
            ranked("https://randomblog.io/x", "randomblog.io", "off"),
            ranked("https://www.bbc.com/news/2", "bbc.com", "Broadcast"),
        ];
        let src = RichResultSource {
            plan: Some(&plan),
            results: &results,
            packets: &[],
            geo_points: &[],
        };
        let got = derive_rich_results(&src);
        assert_eq!(
            serde_json::to_string(&got[0]).unwrap(),
            r#"{"id":"rich:news","version":1,"kind":"news","title":"News","sourceRefs":["reuters.com","bbc.com"],"payload":{"items":[{"title":"Summit ends","url":"https://reuters.com/world/1","domain":"reuters.com","publishedAt":"2026-11-01"},{"title":"Broadcast","url":"https://www.bbc.com/news/2","domain":"bbc.com"}]},"presentation":{"preferred":"grid"}}"#
        );

        // entity: wikipedia packet only
        let plan = pl(PresentationPrimary::Entity, PresentationLayout::Inline);
        let packets = vec![
            packet("S1", "https://example.com/x", "example.com", "X", ""),
            packet(
                "S2",
                "https://en.wikipedia.org/wiki/Telephone",
                "en.wikipedia.org",
                "Telephone",
                "The telephone invents sound.",
            ),
        ];
        let src = RichResultSource {
            plan: Some(&plan),
            results: &[],
            packets: &packets,
            geo_points: &[],
        };
        let got = derive_rich_results(&src);
        assert_eq!(
            serde_json::to_string(&got[0]).unwrap(),
            r#"{"id":"rich:entity:S2","version":1,"kind":"entity","title":"Telephone","subtitle":"en.wikipedia.org","sourceRefs":["S2"],"payload":{"url":"https://en.wikipedia.org/wiki/Telephone","description":"The telephone invents sound."},"actions":[{"type":"open_source","url":"https://en.wikipedia.org/wiki/Telephone"}],"presentation":{"preferred":"inline"}}"#
        );

        // other primaries emit NOTHING (§53)
        let plan = pl(PresentationPrimary::Weather, PresentationLayout::Inline);
        let src = RichResultSource {
            plan: Some(&plan),
            results: &results,
            packets: &packets,
            geo_points: &[],
        };
        assert!(derive_rich_results(&src).is_empty());
        let src = RichResultSource {
            plan: None,
            results: &results,
            packets: &packets,
            geo_points: &geo,
        };
        assert!(derive_rich_results(&src).is_empty());
    }
}
