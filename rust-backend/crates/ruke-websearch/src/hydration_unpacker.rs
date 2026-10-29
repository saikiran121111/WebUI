//! Parity port of `lib/web-search/hydration-unpacker.ts` (owner: W3).
//!
//! Pure module — the TS imports `linkedom` only for the private, never-called
//! `docOf` helper; it is dead code and is NOT ported, so no DOM dependency is
//! needed here. TS exports `unpackHydration`, `walkGenericJsonForEntities`,
//! and the `WalkerOptions` interface — mirrored by [`unpack_hydration`],
//! [`walk_generic_json_for_entities`], and [`WalkerOptions`].
//!
//! # TS quirks kept verbatim (do not "fix")
//! - `nextDataUnpack`: `article = page?.article ?? page?.post ?? page?.content`
//!   picks the first NON-NULLISH value, but the following `if (article)` is a
//!   TRUTHINESS check — a falsy-but-present `article` (`0`, `""`, `false`)
//!   falls through to the `else if (page)` branch.
//! - The `__NEXT_DATA__` gate is `md.length >= 40` (UTF-16 units), so short
//!   articles are dropped entirely.
//! - `nuxtUnpack` returns the `__NUXT_DATA__` section as soon as the RAW
//!   harvest is non-empty — even when `summarizeStrings` returns `""` (e.g.
//!   every string is 8..10 chars) — and so never falls through to the legacy
//!   `window.__NUXT__` branch for such payloads.
//! - SvelteKit/Astro/Gatsby section headers are pushed whenever that site's
//!   raw harvest is non-empty, header + `"\n"` + `""` included.
//! - `walkGenericJsonForEntities` dedupe key:
//!   `keyParts.join("|") || matched.size > 0 ? stringify : "anon"` — JS `||`
//!   binds tighter than `?:`, so the condition is ALWAYS true (matchedFields
//!   ≥ 2 ⇒ matched.size ≥ 1): the `keyParts` computation is dead code and the
//!   dedupe key is always `JSON.stringify([...matched.entries()].sort())`.
//! - `matchedFields` counts matched KEYS, not distinct labels (the TS comment
//!   itself flags this): two keys mapping to the same label count 2 toward the
//!   `matchedFields >= 2` gate, while the Map keeps only the LAST value.
//! - `String(v).slice(0,300).replace(/\s+/g," ")` — card values SLICE first,
//!   THEN collapse whitespace (a whitespace run straddling position 300 is
//!   half-cut, not collapsed).
//! - Flight chunks are harvested as the PARSED string: `harvestStrings` is fed
//!   the chunk as one JS string, never re-parsed as JSON.
//! - Flight exec loop is capped at 40 matches; harvest caps: depth > 6, and
//!   entries are made when `budget.length > 200` (checked on ENTRY, so the
//!   201st string can still be pushed before later calls bail).
//! - `walkGenericJsonForEntities`: `SKIP_KEYS` and the `__`-prefix filter gate
//!   RECURSION only; field matching in `emit` ignores them (a key named `id`
//!   still feeds the `id` label).
//! - YouTube `if (vd.title)`-style TRUTHY gates; label lines built with `+`
//!   string concatenation ⇒ numbers/arrays coerce via JS `String(x)`
//!   (`viewCount: 123` number → "123"; `[a,b]` → "a,b").
//! - Empty-object skip in `emit` checks `typeof v === "object" && !Array.isArray(v)`
//!   — empty ARRAYS are not skipped.
//!
//! # Recorded divergences (unavoidable JS-vs-Rust)
//! - `vd.shortDescription.slice(0,2000)` throws a TypeError in TS when
//!   `shortDescription` is a non-string (crashing the WHOLE unpack call); Rust
//!   stringifies it instead. Likewise a non-array `chapters`: a STRING passes
//!   JS `chapters.length > 0` and `for…of chapters.slice(0,10)` then iterates
//!   its CHARACTERS (emitting `- ` lines); Rust requires a real JSON array.
//! - `JSON.parse` keeps lone-surrogate `\uXXXX` escapes; serde_json rejects
//!   them, so such payloads take the TS `catch` paths (flight chunk → the
//!   literal-escape fallback; nuxt/remix/svelte/gatsby → raw string).
//! - serde_json float display (`1.0` → `"1.0"`, `1e21` → `1e21`) differs from
//!   JS `String(x)` (`"1"`, `"1e+21"`) inside card values, harvested budget
//!   strings are unaffected (strings), and `JSON.stringify` fallbacks of
//!   non-string bodies keep serde's key insertion order — identical to JS
//!   parse order thanks to `preserve_order`.
//! - JS `s.length`/`.slice(0,n)` count UTF-16 code units and can SPLIT an
//!   astral surrogate pair, keeping the lone surrogate; Rust cuts BEFORE the
//!   pair (a Rust `String` cannot hold lone surrogates).
//! - The JS dedupe key sorts pair STRINGS (`"label,value"`), Rust sorts the
//!   `BTreeMap` by label. All labels are unique lowercase ASCII ⇒ identical
//!   serialization.
//! - JS `\s` vs the regex crate `\s` differ only for exotic Unicode space
//!   points (JS `\s` includes U+FEFF; the regex crate's does not).

use regex::Regex;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

/* ── JS-semantics helpers (module-local parity copies) ───────────────── */

fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// JS `s.slice(0, n)` on UTF-16 code units; cuts before an astral pair that
/// would be split (see module doc divergence note).
fn js_trunc(s: &str, n: usize) -> String {
    if utf16_len(s) <= n {
        return s.to_string();
    }
    let mut out = String::new();
    let mut units = 0usize;
    for ch in s.chars() {
        let ul = ch.len_utf16();
        if units + ul > n {
            break;
        }
        out.push(ch);
        units += ul;
    }
    out
}

fn ws_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}

fn four_alpha_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[a-zA-Z]{4}").unwrap())
}

/// TS `.replace(/\s+/g, " ")`.
fn ws_collapse(s: &str) -> String {
    ws_re().replace_all(s, " ").into_owned()
}

/// JS truthiness for the values JSON can hold (arrays/objects always truthy).
fn is_js_falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f == 0.0),
        Value::String(s) => s.is_empty(),
        _ => false,
    }
}

/// JS `String(x)`: null → "null", array → `join(",")` with null elements
/// rendering as `""` (Array.prototype.join semantics), object →
/// `"[object Object]"`.
fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .map(|e| if e.is_null() { String::new() } else { js_to_string(e) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `JSON.parse(x)` with the TS `catch { data = x }` raw-string fallback.
fn parse_or_raw(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

/* ── universal string harvest ────────────────────────────────────────── */

/// TS `harvestStrings(obj, depth = 0, budget = [])`.
fn harvest_strings(obj: &Value, depth: usize, budget: &mut Vec<String>) {
    if depth > 6 || budget.len() > 200 {
        return;
    }
    match obj {
        Value::String(s) => {
            let clean = ws_collapse(s).trim().to_string();
            if utf16_len(&clean) > 8 && four_alpha_re().is_match(&clean) {
                budget.push(clean);
            }
        }
        // TS recurses depth + 1 for array ELEMENTS as well (not a flattening
        // pass — verified against the source).
        Value::Array(items) => {
            for item in items {
                harvest_strings(item, depth + 1, budget);
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                if k == "id" || k == "key" || k == "component" || k.starts_with("__") {
                    continue;
                }
                harvest_strings(v, depth + 1, budget);
            }
        }
        // TS ignores numbers and booleans entirely.
        _ => {}
    }
}

fn harvest(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    harvest_strings(value, 0, &mut out);
    out
}

/// TS `summarizeStrings(strings)`.
fn summarize_strings(strings: &[String]) -> String {
    let mut seen: HashSet<String> = HashSet::new();
    let mut uniq: Vec<&String> = Vec::new();
    for s in strings {
        let key = s.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        let len = utf16_len(s);
        if (10..=1500).contains(&len) {
            uniq.push(s);
        }
    }
    if uniq.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = uniq
        .into_iter()
        .take(60)
        .map(|s| format!("- {}", js_trunc(s, 300)))
        .collect();
    "## Hydration text (universal harvest)\n".to_string() + &lines.join("\n")
}

/* ── Next.js ─────────────────────────────────────────────────────────── */

fn flight_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)"#).unwrap())
}

/// TS: `JSON.parse('"' + m[1] + '"')`, on SyntaxError →
/// `m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"')`.
fn unescape_flight_chunk(body: &str) -> String {
    match serde_json::from_str::<String>(&format!("\"{body}\"")) {
        Ok(s) => s,
        Err(_) => body.replace("\\n", "\n").replace("\\\"", "\""),
    }
}

fn next_flight_unpack(html: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for caps in flight_re().captures_iter(html).take(40) {
        let chunk = unescape_flight_chunk(&caps[1]);
        harvest_strings(&Value::String(chunk), 0, &mut out);
    }
    if out.is_empty() {
        return String::new();
    }
    "## Next.js RSC flight payload\n".to_string() + &summarize_strings(&out)
}

fn next_data_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>"#).unwrap())
}

fn tag_strip_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap())
}

fn next_data_unpack(html: &str) -> String {
    let Some(caps) = next_data_re().captures(html) else {
        return String::new();
    };
    let raw = &caps[1];
    if raw.is_empty() {
        return String::new();
    }
    // TS: JSON.parse(m[1].trim()) — parse failure returns "" outright.
    let Ok(data) = serde_json::from_str::<Value>(raw.trim()) else {
        return String::new();
    };
    let page = data.get("props").and_then(|p| p.get("pageProps"));
    let article =
        page.and_then(|p| ["article", "post", "content"].iter().find_map(|k| p.get(*k).filter(|v| !v.is_null())));

    let mut lines: Vec<String> = Vec::new();
    // NOTE (parity): `??` picks the first non-NULL article, but `if (article)`
    // is a truthiness check — a falsy present article falls through to page.
    if let Some(av) = article.filter(|v| !is_js_falsy(v)) {
        let tv = av.get("title").filter(|v| !v.is_null()).or_else(|| av.get("name").filter(|v| !v.is_null()));
        if let Some(t) = tv.filter(|v| !is_js_falsy(v)) {
            lines.push(format!("## {}", js_to_string(t)));
        }
        let bv = ["body", "content", "html"].iter().find_map(|k| av.get(*k).filter(|v| !v.is_null()));
        if let Some(b) = bv.filter(|v| !is_js_falsy(v)) {
            let s = match b {
                Value::String(st) => tag_strip_re().replace_all(st, " ").into_owned(),
                other => serde_json::to_string(other).unwrap_or_default(),
            };
            lines.push(js_trunc(&s, 4000));
        }
    } else if page.is_some_and(|p| !is_js_falsy(p)) {
        lines.push("## __NEXT_DATA__ pageProps".to_string());
        // TS pushes summarizeStrings(...) even when it is "" (join quirk).
        lines.push(summarize_strings(&harvest(page.unwrap())));
    }
    let md = lines.join("\n\n");
    if utf16_len(&md) >= 40 {
        md
    } else {
        String::new()
    }
}

/* ── Nuxt ────────────────────────────────────────────────────────────── */

fn nuxt_data_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>"#).unwrap())
}

fn nuxt_legacy_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)window\.__NUXT__\s*=\s*(\{.*?\})\s*;").unwrap())
}

fn nuxt_unpack(html: &str) -> String {
    if let Some(caps) = nuxt_data_re().captures(html) {
        let raw = &caps[1];
        if !raw.is_empty() {
            // TS: JSON.parse(m3[1].trim()); catch → the UNTRIMMED capture as
            // a raw string fed to harvestStrings.
            let data = match serde_json::from_str::<Value>(raw.trim()) {
                Ok(v) => v,
                Err(_) => Value::String(raw.to_string()),
            };
            let strs = harvest(&data);
            // Gate is the RAW harvest length — returns even if summarize() is
            // "" (never falls through to the legacy branch).
            if !strs.is_empty() {
                return "## Nuxt 3 hydration state\n".to_string() + &summarize_strings(&strs);
            }
        }
    }
    if let Some(caps) = nuxt_legacy_re().captures(html) {
        let strs = harvest(&parse_or_raw(&caps[1]));
        if !strs.is_empty() {
            return "## Nuxt hydration state\n".to_string() + &summarize_strings(&strs);
        }
    }
    String::new()
}

/* ── Remix / React Router ────────────────────────────────────────────── */

fn remix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)window\.__remixContext\s*=\s*(\{.*?\})\s*;").unwrap())
}

fn react_router_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)window\.__reactRouterContext\s*=\s*(\{.*?\})\s*;").unwrap())
}

fn remix_unpack(html: &str) -> String {
    let Some(caps) = remix_re().captures(html).or_else(|| react_router_re().captures(html)) else {
        return String::new();
    };
    let strs = harvest(&parse_or_raw(&caps[1]));
    if strs.is_empty() {
        return String::new();
    }
    "## Remix hydration state\n".to_string() + &summarize_strings(&strs)
}

/* ── SvelteKit / Astro / Gatsby ──────────────────────────────────────── */

fn sveltekit_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)window\.__sveltekit__\s*=\s*(\{.*?\})\s*;").unwrap())
}

fn astro_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<div[^>]*id="astro-islands"[^>]*>(.*?)</div>"#).unwrap())
}

fn gatsby_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)window\.___gatsby\s*=\s*(\{.*?\})\s*;").unwrap())
}

fn gatsby_script_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<script[^>]*id="gatsby-script"[^>]*>(.*?)</script>"#).unwrap())
}

fn sveltekit_astro_gatsby_unpack(html: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(caps) = sveltekit_re().captures(html) {
        let strs = harvest(&parse_or_raw(&caps[1]));
        if !strs.is_empty() {
            lines.push("## SvelteKit hydration\n".to_string() + &summarize_strings(&strs));
        }
    }
    if let Some(caps) = astro_re().captures(html) {
        // TS parses the TRIMMED astro capture (catch → raw untrimmed).
        let strs = harvest(&parse_or_raw(caps[1].trim()));
        if !strs.is_empty() {
            lines.push("## Astro islands data\n".to_string() + &summarize_strings(&strs));
        }
    }
    let gatsby = gatsby_re().captures(html).or_else(|| gatsby_script_re().captures(html));
    if let Some(caps) = gatsby {
        let strs = harvest(&parse_or_raw(&caps[1]));
        if !strs.is_empty() {
            lines.push("## Gatsby hydration\n".to_string() + &summarize_strings(&strs));
        }
    }
    lines.join("\n\n")
}

/* ── YouTube ─────────────────────────────────────────────────────────── */

fn player_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // "ytInitialPlayerResponse" does NOT contain the substring
    // "ytInitialData", so the two regexes never cross-match by accident.
    RE.get_or_init(|| Regex::new(r"(?s)ytInitialPlayerResponse\s*=\s*(\{.*?\});").unwrap())
}

fn initial_data_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)ytInitialData\s*=\s*(\{.*?\});").unwrap())
}

fn youtube_unpack(html: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    if let Some(caps) = player_re().captures(html) {
        let data = parse_or_raw(&caps[1]);
        if let Some(vd) = data.get("videoDetails").filter(|v| !is_js_falsy(v)) {
            if let Some(t) = vd.get("title").filter(|v| !is_js_falsy(v)) {
                out.push(format!("## YouTube video: {}", js_to_string(t)));
            }
            if let Some(a) = vd.get("author").filter(|v| !is_js_falsy(v)) {
                out.push(format!("Channel: {}", js_to_string(a)));
            }
            if let Some(vc) = vd.get("viewCount").filter(|v| !is_js_falsy(v)) {
                out.push(format!("Views: {}", js_to_string(vc)));
            }
            // TS `.slice(0,2000)` on a NON-string shortDescription throws a
            // TypeError and kills the whole unpack; Rust stringifies (see
            // module doc).
            if let Some(sd) = vd.get("shortDescription").filter(|v| !is_js_falsy(v)) {
                out.push(format!("Description: {}", js_trunc(&js_to_string(sd), 2000)));
            }
        }
        let chapters = data
            .get("macros")
            .and_then(|m| m.get("chapters"))
            .filter(|v| !v.is_null())
            .or_else(|| data.get("chapters").filter(|v| !v.is_null()));
        // JS `chapters.length > 0` also passes for STRINGS (which then iterate
        // as characters); Rust requires a real array — recorded divergence.
        if let Some(Value::Array(chs)) = chapters {
            if !chs.is_empty() {
                out.push("Chapters:".to_string());
                for ch in chs.iter().take(10) {
                    // (ch.title?.simpleText ?? ch.title ?? "")
                    let text = match ch.get("title").filter(|t| !t.is_null()) {
                        Some(t) => t
                            .get("simpleText")
                            .filter(|s| !s.is_null())
                            .map_or_else(|| js_to_string(t), js_to_string),
                        None => String::new(),
                    };
                    out.push(format!("- {text}"));
                }
            }
        }
    }
    if let Some(caps) = initial_data_re().captures(html) {
        let data = parse_or_raw(&caps[1]);
        let strs: Vec<String> = harvest(&data).into_iter().filter(|s| utf16_len(s) > 20).collect();
        if !strs.is_empty() {
            out.push("## YouTube data (ytInitialData)\n".to_string() + &summarize_strings(&strs));
        }
    }
    out.join("\n\n")
}

/* ── universal entity walker ─────────────────────────────────────────── */

/// TS `WalkerOptions` (`{ maxCards?, label?, maxDepth? }`, defaults via `??`
/// so an explicit `Some(0)` is honored exactly like a JS explicit `0`).
#[derive(Debug, Clone, Default)]
pub struct WalkerOptions {
    pub max_cards: Option<usize>,
    pub label: Option<String>,
    pub max_depth: Option<usize>,
}

/// The 18 ordered `/^(…)$/i` field patterns, FIRST match wins per key.
/// Duplicated alternation entries (`showtimes`, `shippableIn`) are kept
/// verbatim from the TS — they are no-ops but document the source's shape.
fn entity_patterns() -> &'static [(Regex, &'static str)] {
    static PATS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATS.get_or_init(|| {
        [
            (r"(?i)^(name|title|headline|heading|label|displayname|displayName)$", "name"),
            (
                r"(?i)^(description|desc|summary|synopsis|shortdescription|shortDescription|blurb|tagline)$",
                "desc",
            ),
            (
                r"(?i)^(price|mrp|offerprice|offerPrice|discountedprice|discountedPrice|sellingprice|sellingPrice|finalprice|finalPrice|listprice|listPrice|cost|rate|amount|salary|salaryrange|salaryRange|baseprice|basePrice|minprice|minPrice|maxprice|maxPrice)$",
                "price",
            ),
            (r"(?i)^(currency|pricecurrency|priceCurrency|ccy)$", "currency"),
            (
                r"(?i)^(rating|ratingvalue|ratingValue|stars|starrating|starRating|score|avgRating|avgrating|reviewcount|reviewCount|ratingscount|ratingsCount|voteCount|votes)$",
                "rating",
            ),
            (
                r"(?i)^(availability|instock|inStock|stockstatus|stockStatus|outofstock|outOfStock|soldout|soldOut)$",
                "availability",
            ),
            (
                r"(?i)^(address|location|locality|area|city|state|region|country|venue|venueid|venueId|geo|addressline|addressLine|fulladdress|fullAddress|postalcode|postalCode|pincode|pinCode|zip|zipcode|zipCode|nearby)$",
                "address",
            ),
            (
                r"(?i)^(cuisine|cuisines|category|subcategory|subCategory|genre|type|tag|tags|kind|domain|department|brand|vendor|company|organization|organisation|artist|author|director|producer|host|channel)$",
                "category",
            ),
            (
                r"(?i)^(showtime|showtimes|showTimes|showtimes|start|startTime|end|endTime|date|time|datetime|datePublished|eventdate|eventDate|schedule|session|sessions|slot|slots|day|dayofweek|dayOfWeek|weekday|weekend|morning|afternoon|evening|late)$",
                "time",
            ),
            (
                r"(?i)^(cast|castmembers|castMembers|crew|director|actors|actress|performer|performers|artist|artists|writer|writers)$",
                "cast",
            ),
            (
                r"(?i)^(url|link|href|path|permalink|slug|website|webpage|webPage|shareurl|shareUrl|canonical|id|identifier|sku|mpn|ean|upc|asin|isbn)$",
                "id",
            ),
            (
                r"(?i)^(ingredients|components|parts|features|highlights|benefits|specs|specifications|sizes|variants|flavors|flavours|colours|colors|options)$",
                "list",
            ),
            (
                r"(?i)^(review|reviews|testimonial|testimonials|feedback|comment|comments|pr|pros|cons|verdict|summary)$",
                "review",
            ),
            (
                r"(?i)^(phone|contact|contactnumber|contactNumber|customerCare|support|supportphone|supportPhone|email|helpdesk|helpDesk)$",
                "contact",
            ),
            (
                r"(?i)^(hours|openingHours|openhours|openHours|servicehours|serviceHours|availabilityhours|availabilityHours|operatinghours|operatingHours|schedule)$",
                "hours",
            ),
            (
                r"(?i)^(delivery|deliverytime|deliveryTime|deliverable|deliverablein|deliverableIn|shipping|shippable|shippablein|shippableIn|shippableIn|arrival|expectedarrival|expectedArrival|sla|warranty|guarantee|refund)$",
                "delivery",
            ),
            (
                r"(?i)^(image|imageurl|imageUrl|img|thumbnail|thumb|cover|banner|poster|hero|media|videourl|videoUrl|video|thumbnailurl|thumbnailUrl)$",
                "image",
            ),
            (
                r"(?i)^(quantity|qty|count|num|total|size|weight|dimension|dimensions|measure|measurements|capacity|volume|power|battery|screen|resolution|storage|ram|cpuspeed|cpuSpeed|memory|os|platform|architecture|bit)$",
                "spec",
            ),
        ]
        .into_iter()
        .map(|(p, l)| (Regex::new(p).unwrap(), l))
        .collect()
    })
    .as_slice()
}

/// TS `SKIP_KEYS` set (verbatim). Gates RECURSION only, never field matching.
const SKIP_KEYS: &[&str] = &[
    "@context", "@type", "@id", "@graph", "id", "key", "component", "children", "props", "scriptUrl", "css",
    "cssUrl", "style", "classId", "dataId", "hash", "nonce", "bundlePath", "entry", "manifest", "webpack",
    "webpackChunk", "webpackJsonp", "require", "module", "react", "webpackPreload", "_r", "_s", "url", "href",
    "src", "alt", "width", "height", "format", "mime", "contentType", "charset", "encoding", "cookie", "token",
    "auth", "apiKey", "session", "csrf", "sentry",
];

struct Walker {
    cards: Vec<String>,
    seen: HashSet<String>,
    max_cards: usize,
    max_depth: usize,
}

impl Walker {
    /// TS `emit(o)`: returns `cards.length >= maxCards` (stop-walk signal).
    fn emit(&mut self, obj: &Value) -> bool {
        let map = match obj.as_object() {
            Some(m) => m,
            None => return false,
        };
        let mut matched: BTreeMap<&'static str, String> = BTreeMap::new();
        let mut matched_fields = 0usize;
        for (k, v) in map {
            // TS: `v === undefined || v === null || v === ""` continue.
            if v.is_null() || v.as_str().is_some_and(|s| s.is_empty()) {
                continue;
            }
            // TS: empty non-array objects skipped; empty ARRAYS are kept.
            if v.is_object() && v.as_object().is_some_and(|o| o.is_empty()) {
                continue;
            }
            for (re, label) in entity_patterns() {
                if re.is_match(k) {
                    // slice(0,300) FIRST, then collapse (quirk, see doc).
                    matched.insert(*label, ws_collapse(&js_trunc(&js_to_string(v), 300)));
                    // Counts KEYS, not distinct labels — TS bug, kept.
                    matched_fields += 1;
                    break;
                }
            }
        }
        if matched_fields < 2 {
            return false;
        }
        // TS `keyParts.join("|") || matched.size > 0 ? stringify : "anon"`:
        // `||` binds tighter than `?:`, the condition is ALWAYS true here and
        // keyParts is dead — the key is always the stringified pair array.
        let pairs: Vec<[&str; 2]> = matched.iter().map(|(k, v)| [*k, v.as_str()]).collect();
        let dedupe_key = serde_json::to_string(&pairs).unwrap_or_default();
        if self.seen.contains(&dedupe_key) {
            return false;
        }
        self.seen.insert(dedupe_key);

        let mut lines: Vec<String> = Vec::new();
        let name_val = ["name", "title", "headline", "displayName", "label"]
            .iter()
            .find_map(|k| map.get(*k).filter(|v| !v.is_null()));
        if let Some(Value::String(s)) = name_val {
            if !s.is_empty() {
                lines.push(format!("### {}", js_trunc(s, 200)));
            }
        }
        for lbl in [
            "desc", "price", "currency", "rating", "availability", "address", "category", "time", "cast", "contact",
            "hours", "delivery", "list", "spec", "review",
        ] {
            if let Some(val) = matched.get(lbl) {
                lines.push(format!("- {lbl}: {val}"));
            }
        }
        // TS gate: ANY of url/link/href is a string; the value then follows
        // `??` (first PRESENT non-null — an object url renders as
        // "[object Object]", an empty-string url yields a bare "- link: ").
        if ["url", "link", "href"].iter().any(|k| map.get(*k).is_some_and(|v| v.is_string())) {
            if let Some(lv) = ["url", "link", "href"]
                .iter()
                .find_map(|k| map.get(*k).filter(|v| !v.is_null()))
            {
                lines.push(format!("- link: {}", js_trunc(&js_to_string(lv), 200)));
            }
        }
        self.cards.push(lines.join("\n"));
        self.cards.len() >= self.max_cards
    }

    /// TS `walk(node, depth)`: returns the stop-walk signal.
    fn walk(&mut self, node: &Value, depth: usize) -> bool {
        if depth > self.max_depth || self.cards.len() >= self.max_cards {
            return true;
        }
        if let Value::Array(items) = node {
            for item in items.iter().take(200) {
                if self.walk(item, depth + 1) {
                    break;
                }
            }
            return self.cards.len() >= self.max_cards;
        }
        if node.is_object() {
            if self.emit(node) {
                return true;
            }
            for (k, v) in node.as_object().expect("object checked above") {
                if SKIP_KEYS.contains(&k.as_str()) || k.starts_with("__") {
                    continue;
                }
                if v.is_null() {
                    continue;
                }
                if self.walk(v, depth + 1) {
                    break;
                }
            }
            return self.cards.len() >= self.max_cards;
        }
        false
    }
}

/// TS `walkGenericJsonForEntities(root, opts = {})`: emits
/// `## {label} — {n} entity card(s) (universal JSON walk)` (em dash U+2014)
/// or `""`.
pub fn walk_generic_json_for_entities(root: &Value, opts: &WalkerOptions) -> String {
    // TS defaults use `??`, so explicit Some(0) is honored like an explicit
    // JS `0` would be.
    let max_cards = opts.max_cards.unwrap_or(60);
    let max_depth = opts.max_depth.unwrap_or(14);
    let label = opts.label.clone().unwrap_or_else(|| "hydration".to_string());
    let mut walker = Walker {
        cards: Vec::new(),
        seen: HashSet::new(),
        max_cards,
        max_depth,
    };
    walker.walk(root, 0);
    if walker.cards.is_empty() {
        return String::new();
    }
    format!(
        "## {label} \u{2014} {} entity card(s) (universal JSON walk)\n{}",
        walker.cards.len(),
        walker.cards.join("\n\n")
    )
}

/* ── public entry ────────────────────────────────────────────────────── */

/// TS `unpackHydration(html)`: `"[SSR Hydration Unpack]\n\n"` + non-empty
/// parts joined by `\n\n`, or `""`.
pub fn unpack_hydration(html: &str) -> String {
    let parts = [
        next_flight_unpack(html),
        next_data_unpack(html),
        nuxt_unpack(html),
        remix_unpack(html),
        sveltekit_astro_gatsby_unpack(html),
        youtube_unpack(html),
    ];
    // TS filter: `p && p.length > 0` — both mean "non-empty".
    let combined: String = parts
        .iter()
        .filter(|p| !p.is_empty())
        .map(|p| p.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if combined.is_empty() {
        return String::new();
    }
    "[SSR Hydration Unpack]\n\n".to_string() + &combined
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn next_flight_chunk_harvested_as_string() {
        let html = r#"self.__next_f.push([1,"Hello world this is a flight chunk with some text"]);"#;
        let md = unpack_hydration(html);
        assert!(md.starts_with("[SSR Hydration Unpack]"), "{md}");
        assert!(md.contains("## Next.js RSC flight payload"), "{md}");
        assert!(md.contains("## Hydration text (universal harvest)"), "{md}");
        assert!(md.contains("- Hello world this is a flight chunk with some text"), "{md}");
    }

    #[test]
    fn next_data_article_tags_to_spaces_and_40char_gate() {
        let html = r#"<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"article":{"title":"My Post","body":"<p>Hello <b>world</b> paragraph text</p>"}}}}</script>"#;
        let md = unpack_hydration(html);
        assert!(md.contains("## My Post"), "{md}");
        // Every tag → a single " " (two adjacent tags ⇒ two spaces).
        assert!(md.contains("Hello  world"), "{md}");

        // Quirk: md.length (UTF-16) < 40 ⇒ the whole section is dropped.
        let short = r#"<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"article":{"title":"Hi","body":"short"}}}}</script>"#;
        assert_eq!(unpack_hydration(short), "");

        // Falsy-but-present article falls through to the page branch.
        let falsy = r#"<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"article":"","pageBodyTextHere":"some longer page text for the harvest branch"}}}</script>"#;
        let md = unpack_hydration(falsy);
        assert!(md.contains("## __NEXT_DATA__ pageProps"), "{md}");
    }

    #[test]
    fn youtube_player_response_fields_and_chapters_chain() {
        let html = r#"var ytInitialPlayerResponse = {"videoDetails":{"title":"Vid","author":"Chan","viewCount":"123","shortDescription":"Desc text"},"chapters":[{"title":{"simpleText":"Ch1"}},{"title":"Ch2"}]};"#;
        let md = unpack_hydration(html);
        assert!(md.contains("## YouTube video: Vid"), "{md}");
        assert!(md.contains("Channel: Chan"), "{md}");
        assert!(md.contains("Views: 123"), "{md}");
        assert!(md.contains("Description: Desc text"), "{md}");
        assert!(md.contains("Chapters:"), "{md}");
        // simpleText ?? title chain; an object title → "[object Object]" in
        // JS would also stringify via the ?? fallback — plain string Ch2 kept.
        assert!(md.contains("- Ch1"), "{md}");
        assert!(md.contains("- Ch2"), "{md}");
    }

    #[test]
    fn walk_generic_emits_entity_cards_and_drops_single_field() {
        let root = json!({"page": {"products": [{"name": "Widget Pro 3000", "price": 19.5, "currency": "USD", "rating": 4.2}]}});
        let md = walk_generic_json_for_entities(&root, &WalkerOptions::default());
        assert!(md.contains("\u{2014} 1 entity card(s) (universal JSON walk)"), "{md}");
        assert!(md.starts_with("## hydration \u{2014}"), "{md}");
        assert!(md.contains("### Widget Pro 3000"), "{md}");
        assert!(md.contains("- price: 19.5"), "{md}");
        assert!(md.contains("- currency: USD"), "{md}");
        assert!(md.contains("- rating: 4.2"), "{md}");

        // matchedFields < 2 ⇒ no card at all.
        let single = json!({"thing": {"name": "Solo"}});
        assert_eq!(walk_generic_json_for_entities(&single, &WalkerOptions::default()), "");
    }

    #[test]
    fn nuxt3_data_script_harvest() {
        let html = r#"<script id="__NUXT_DATA__" type="application/json">["DeferSession",null,"Hello from Nuxt payload"]</script>"#;
        let md = unpack_hydration(html);
        assert!(md.contains("## Nuxt 3 hydration state"), "{md}");
        assert!(md.contains("- DeferSession"), "{md}");
        assert!(md.contains("- Hello from Nuxt payload"), "{md}");
    }
}
