//! OWNER: W4 — parity port of `lib/web-search/google-maps.ts`.
//!
//! Google Maps deep evidence: unwrap the Firebase short-link chain, decode
//! place / address / @lat,lng from the RESOLVED URL, scrape the place page
//! (og tags / <title> / APP_INITIALIZATION_STATE), and reverse-geocode bare
//! coordinates through Nominatim.
//!
//! ## QUIRKS (kept verbatim)
//! - `isGoogleMapsUrl`: exact-match hosts `maps.google.com` /
//!   `maps.app.goo.gl` / `g.page` (single `www.` strip), OR host matching the
//!   UNANCHORED regex `/google\.[a-z.]{2,7}$/` (so `mygoogle.com` also
//!   matches) plus `pathname.startsWith("/maps")`.
//! - The short-link test in `getGoogleMapsEvidence` runs on the RAW url
//!   string: `/google(\.[a-z.]{2,7})?\/maps/` — a substring test, not host
//!   parsing (a path segment literally containing `google/maps` counts).
//! - `parseMapsUrl` place segment `/\/maps\/(?:place|search)\/([^/?]+)/`
//!   happily captures `@lat,lng` for a `/maps/place/@27.17,78.04` URL — the
//!   captured "@…" string becomes a truthy `place` and OG tags are never
//!   consulted for the name. Verbatim.
//! - `decodeSegment`: `+`→space BEFORE `decodeURIComponent`, then a literal
//!   `%2C`→"," replace (case-insensitive) AFTER decoding (only reachable via
//!   double-encoding), then trim. The `/maps/dir/` branch applies an EXTRA
//!   `+`→space replace after decoding (decoded `%2B` becomes a space there,
//!   but stays "+" in the place/search branches — asymmetric, verbatim).
//! - Query params: TS `searchParams.get` decodes `+`→space BEFORE
//!   percent-decoding; the raw `+` handling is replicated in
//!   [`search_param_get`] + [`decode_segment`] ordering. `%2B`→"+" then
//!   `decodeSegment` flips it to a space in every branch (matching TS —
//!   URLSearchParams already removed raw `+`s).
//! - Coordinates re-enter URLs/markdown via JS `String(number)`
//!   shortest-form ([`js_num_str`]). Micro-divergences recorded: JS goes
//!   exponential below 1e-7 (`1e-9`); the Rust `{}` never does — impossible
//!   for real lat/lng ranges, pinned for `-0` (`String(-0)=="0"`, Rust
//!   would print `-0`).
//! - `scanAppState` bracket-scan bounds (`800_000` code units from `[`) and
//!   the quoted-string window `{6,180}` count JS UTF-16 UNITS; the scan here
//!   walks Unicode chars. Micro-divergence only on astral-plane content.
//!   `\uXXXX` unescaping uses `String.fromCharCode` per code unit in JS;
//!   lone/unpaired surrogates are left as the literal `\uXXXX` text here
//!   (astral pairs inside APP_INITIALIZATION_STATE are vanishingly rare in
//!   place names — recorded).
//! - Filters: skip `https?://`, "machine-looking" strings
//!   (`^[0-9a-zA-Z_\-\[\]{}:.,/+?&=%|@ ]{0,180}$` with NO `[A-Za-z]{4}` run)
//!   and 5+ digit runs without a 4-letter run; dedupe case-insensitively;
//!   cap 40. `seen`/skip order matters (a dup counts neither twice nor for
//!   the cap? it does NOT count — `continue` before push). Verbatim.
//! - `facts.length <= 1` (only the Final-URL fact) → null.
//! - Slice budgets (`blurb.slice(0,600)`, `markdown.slice(0,4000)`,
//!   companion `.slice(0,200)`) count UTF-16 UNITS (js helpers).
//!
//! ## DEVIATIONS (recorded)
//! - A `decodeURIComponent` URIError (bad `%` escape) makes the TS async
//!   function REJECT (parseMapsUrl / grab / pageTitle run outside any
//!   try/catch), propagating out of `platformAdapter`. The Rust port returns
//!   `None` at the same point — callers already treat rejection as "no
//!   adapter evidence" (same deviation as platform_api's non-array
//!   `children`). Net calls up to the throw are identical.
//! - TS `reverseGeocode` merges `{...apiHeaders(), "User-Agent": "LocalAI…"}`
//!   — Node's header store collapses the duplicate case-insensitively, so
//!   the custom UA wins; the port passes the UA through `UrlFetchOpts.headers`
//!   and net.rs's `header_merge` produces the same effective request.
//! - `page.body` truthiness: TS `page && page.ok && page.body` skips empty
//!   bodies; `is_some_and(|p| p.ok && !p.body.is_empty())` replicates it.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use url::Url;

use crate::net::{FetchPageOpts, Net, UrlFetchOpts};
use crate::redirect_unwrap::unwrap_short_link;

/// TS `MapsEvidence`.
#[derive(Debug, Clone, PartialEq)]
pub struct MapsEvidence {
    pub resolved_url: String,
    pub place: String,
    pub address: String,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub blurb: String,
    pub markdown: String,
}

/// TS `isGoogleMapsUrl(url)` — invalid URL ⇒ false.
pub fn is_google_maps_url(url: &str) -> bool {
    let u = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let host = match u.host_str() {
        Some(h) => h.to_lowercase(),
        None => return false,
    };
    let host = match host.strip_prefix("www.") {
        Some(h) => h.to_string(),
        None => host,
    };
    if host == "maps.google.com" || host == "maps.app.goo.gl" || host == "g.page" {
        return true;
    }
    // google.com OR unanchored /google\.[a-z.]{2,7}$/ + /maps path prefix.
    let google_host = host == "google.com" || {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| Regex::new(r"google\.[a-z.]{2,7}$").unwrap()).is_match(&host)
    };
    google_host && u.path().starts_with("/maps")
}

/// JS `decodeURIComponent` parity (throws ⇒ `None`).
fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// JS `.slice(0, n)` (UTF-16 units, clamped).
fn js_slice_head(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// TS `decodeSegment`: `+`→space, decodeURIComponent, `%2C`→"," (ci), trim.
fn decode_segment(seg: &str) -> Option<String> {
    let plus_free = seg.replace('+', " ");
    let decoded = decode_uri_component(&plus_free)?;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)%2C").unwrap());
    let commas = re.replace_all(&decoded, ",");
    Some(commas.trim().to_string())
}

/// JS `URLSearchParams.get(key)` — pairs split on `&`, first `=` splits
/// key/value, `+`→space THEN percent-decode, both applied to the key too;
/// first match wins; missing ⇒ None. Percent-decode failures use U+FFFD
/// (URLSearchParams semantics) rather than the URIError of
/// [`decode_uri_component`] — micro-divergence vs that helper only.
fn usp_decode(s: &str) -> String {
    let plus_free = s.replace('+', " ");
    let bytes = plus_free.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn search_param_get(u: &Url, key: &str) -> Option<String> {
    let query = u.query()?;
    for pair in query.split('&') {
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        if usp_decode(k) == key {
            return Some(usp_decode(v));
        }
    }
    None
}

/// JS `String(number)` shortest form; `-0` collapses to "0" (JS parity).
/// Exponential thresholds differ from V8 for |x| < 1e-7 (recorded — real
/// lat/lng never reach that range).
fn js_num_str(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    format!("{x}")
}

fn at_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // (JS \d ASCII.)
    RE.get_or_init(|| Regex::new(r"@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)").unwrap())
}

fn place_seg_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/maps/(?:place|search)/([^/?]+)").unwrap())
}

fn dir_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/maps/dir/([^/?]+)").unwrap())
}

/// TS module-scope `/google(\.[a-z.]{2,7})?\/maps/` substring test.
fn raw_maps_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"google(\.[a-z.]{2,7})?/maps").unwrap())
}

/// Scrape gate `/\/maps(\/|$|\?)/` on `pathname + search`.
fn maps_path_q_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/maps(/|$|\?)").unwrap())
}

fn title_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<title[^>]*>([^<]{4,220})</title>").unwrap())
}

/// `<meta …property="og:P"…content="V">` form and its reversed twin.
fn og_meta_re(prop: &str, content_first: bool) -> &'static Regex {
    static T1: OnceLock<Regex> = OnceLock::new();
    static T2: OnceLock<Regex> = OnceLock::new();
    static D1: OnceLock<Regex> = OnceLock::new();
    static D2: OnceLock<Regex> = OnceLock::new();
    let init = |slot: &'static OnceLock<Regex>, prop: &str, reversed: bool| slot.get_or_init(|| {
        let pat = if reversed {
            format!(r#"(?i)<meta[^>]+content=["']([^"']{{4,300}})["'][^>]+property=["']og:{prop}["']"#)
        } else {
            format!(r#"(?i)<meta[^>]+property=["']og:{prop}["'][^>]+content=["']([^"']{{4,300}})["']"#)
        };
        Regex::new(&pat).unwrap()
    });
    match (prop, content_first) {
        ("title", false) => init(&T1, "title", false),
        ("title", true) => init(&T2, "title", true),
        ("description", false) => init(&D1, "description", false),
        _ => init(&D2, "description", true),
    }
}

/// TS `[-–] Google Maps.*$` removal (first-only `String.replace`; `.` stops
/// at newlines, `$` is end-of-string without the `m` flag — regex crate
/// defaults match).
fn strip_gmaps_suffix(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)[-–] Google Maps.*$").unwrap());
    re.replace(s, "").into_owned()
}

/// TS `scanAppState(html)` — bracket-scan then collect human strings.
fn scan_app_state(html: &str) -> Vec<String> {
    let idx = match html.find("APP_INITIALIZATION_STATE=") {
        Some(i) => i,
        None => return vec![],
    };
    let rel = match html[idx..].find('[') {
        Some(r) => r,
        None => return vec![],
    };
    let start = idx + rel;
    let mut depth = 0i64;
    let mut in_str = false;
    let mut esc = false;
    let mut end: Option<usize> = None;
    // JS scans ≤ 800_000 UTF-16 units; char scan is the Unicode analog
    // (recorded micro-divergence).
    for (k, ch) in html[start..].char_indices().take(800_000) {
        if in_str {
            if esc {
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        if ch == '"' {
            in_str = true;
        } else if ch == '[' || ch == '{' {
            depth += 1;
        } else if ch == ']' || ch == '}' {
            depth -= 1;
            if depth == 0 {
                end = Some(start + k + ch.len_utf8() - 1);
                break;
            }
        }
    }
    let end = match end {
        Some(e) => e,
        None => return vec![],
    };
    let blob = &html[start..=end];
    static STR_RE: OnceLock<Regex> = OnceLock::new();
    static U_RE: OnceLock<Regex> = OnceLock::new();
    static MACHINE_RE: OnceLock<Regex> = OnceLock::new();
    static LET4_RE: OnceLock<Regex> = OnceLock::new();
    static DIG5_RE: OnceLock<Regex> = OnceLock::new();
    static LET4I_RE: OnceLock<Regex> = OnceLock::new();
    let str_re = STR_RE.get_or_init(|| Regex::new(r#""([^"\\]{6,180})""#).unwrap());
    let u_re = U_RE.get_or_init(|| Regex::new(r"\\u([0-9a-fA-F]{4})").unwrap());
    let machine_re =
        MACHINE_RE.get_or_init(|| Regex::new(r"^[0-9a-zA-Z_\-\[\]{}:.,/+?&=%|@ ]{0,180}$").unwrap());
    let let4 = LET4_RE.get_or_init(|| Regex::new(r"[A-Za-z]{4}").unwrap());
    let dig5 = DIG5_RE.get_or_init(|| Regex::new(r"(?-u:\d{5,})").unwrap());
    let let4i = LET4I_RE.get_or_init(|| Regex::new(r"(?i)[a-z]{4}").unwrap());
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for cap in str_re.captures_iter(blob) {
        if out.len() >= 40 {
            break;
        }
        let raw = &cap[1];
        // \uXXXX → char; lone surrogates keep the literal escape (recorded).
        let unescaped = u_re.replace_all(raw, |c: &regex::Captures| match c[1].to_lowercase().parse::<u32>() {
            // JS parses the hex case-insensitively via parseInt.
            Ok(v) if (0xD800..0xE000).contains(&v) => c[0].to_string(),
            Ok(v) => char::from_u32(v).map(|ch| ch.to_string()).unwrap_or_else(|| c[0].to_string()),
            Err(_) => c[0].to_string(),
        });
        let s = unescaped.trim().to_string();
        if s.is_empty() || seen.contains(&s.to_lowercase()) {
            continue;
        }
        if s.starts_with("http://") || s.starts_with("https://") {
            continue;
        }
        if machine_re.is_match(&s) && !let4.is_match(&s) {
            continue;
        }
        if dig5.is_match(&s) && !let4i.is_match(&s) {
            continue;
        }
        seen.insert(s.to_lowercase());
        out.push(s);
    }
    out
}

/// TS `reverseGeocode(lat, lng)` — Nominatim reverse geocode.
async fn reverse_geocode(net: &dyn Net, lat: f64, lng: f64) -> (String, String) {
    let url = format!(
        "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={}&lon={}&zoom=17&addressdetails=1",
        js_num_str(lat),
        js_num_str(lng)
    );
    let res = net
        .fetch_url(
            &url,
            &UrlFetchOpts {
                timeout_ms: Some(15_000),
                headers: vec![(
                    "User-Agent".into(),
                    "LocalAIWebUI/1.0 (personal research assistant)".into(),
                )],
                ..Default::default()
            },
        )
        .await;
    let res = match res {
        Some(r) if r.ok => r,
        _ => return (String::new(), String::new()),
    };
    let j: Value = match serde_json::from_str(&res.text) {
        Ok(v) => v,
        Err(_) => return (String::new(), String::new()),
    };
    // String(j?.name ?? j?.display_name ?? "").split(",")[0]
    let name = js_to_string(j.get("name").filter(|v| !v.is_null()))
        .or_else(|| js_to_string(j.get("display_name").filter(|v| !v.is_null())))
        .unwrap_or_default();
    let address = js_to_string(j.get("display_name").filter(|v| !v.is_null())).unwrap_or_default();
    // JS split(",")[0] always exists (even for "").
    let first = name.split(',').next().unwrap_or("");
    (first.to_string(), address)
}

/// JS `String(value)` for JSON scalars (objects ⇒ "[object Object]" —
/// exponential-notation thresholds micro-diverge from V8, recorded).
fn js_to_string(v: Option<&Value>) -> Option<String> {
    let v = match v {
        Some(v) if !v.is_null() => v,
        _ => return None,
    };
    Some(match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(_) => v.to_string(), // JS Array→String joins with ","; serde prints JSON — micro-divergence recorded
        Value::Object(_) => "[object Object]".into(),
        Value::Null => unreachable!(),
    })
}

/// TS `getGoogleMapsEvidence(url)`.
pub async fn get_google_maps_evidence(net: &dyn Net, url: &str) -> Option<MapsEvidence> {
    let mut resolved_url = url.to_string();
    if is_google_maps_url(url) && !raw_maps_re().is_match(url) {
        // short link → follow the redirect chain first
        if let Some(r) = unwrap_short_link(net, url).await {
            resolved_url = r;
        }
    }

    let u = Url::parse(&resolved_url).ok()?;

    // ── parseMapsUrl ────────────────────────────────────────────────
    let path = u.path().to_string();
    let at = at_re().captures(&path);
    let lat = at.as_ref().and_then(|c| c[1].parse::<f64>().ok());
    let lng = at.as_ref().and_then(|c| c[2].parse::<f64>().ok());
    let mut place = match place_seg_re().captures(&path) {
        Some(m) => decode_segment(&m[1])?,
        None => String::new(),
    };
    let q = search_param_get(&u, "q")
        .or_else(|| search_param_get(&u, "query"))
        .or_else(|| search_param_get(&u, "destination"))
        .unwrap_or_default();
    let query = if !q.is_empty() { decode_segment(&q)? } else { String::new() };
    if place.is_empty() && query.is_empty() {
        if let Some(d) = dir_re().captures(&path) {
            place = decode_segment(&d[1])?.replace('+', " ");
        }
    }

    let mut address = String::new();
    let mut blurb = String::new();

    // ── place-page scrape ───────────────────────────────────────────
    let path_q = match u.query() {
        Some(q) => format!("{path}?{q}"),
        None => path.clone(),
    };
    if maps_path_q_re().is_match(&path_q) {
        let page = net
            .fetch_page(
                &resolved_url,
                &FetchPageOpts {
                    timeout_ms: Some(25_000),
                    headers: vec![
                        ("cookie".into(), "CONSENT=YES+cb".into()),
                        ("accept-language".into(), "en-US,en;q=0.9".into()),
                    ],
                    ..Default::default()
                },
            )
            .await;
        if let Some(p) = page.filter(|p| p.ok && !p.body.is_empty()) {
            let html = p.body.as_str();
            let title_m = title_re().captures(html).map(|c| c[1].to_string());
            // No og match ⇒ "" (m ? decodeSegment(m[1]) : ""); only a decode
            // THROW leaves the function (Option None ⇒ None — deviation).
            let grab = |prop: &str| -> Option<String> {
                match og_meta_re(prop, false)
                    .captures(html)
                    .or_else(|| og_meta_re(prop, true).captures(html))
                {
                    Some(m) => Some(decode_segment(&m[1])?),
                    None => Some(String::new()),
                }
            };
            let og_title = grab("title")?;
            blurb = grab("description")?;
            let page_title = match &title_m {
                Some(t) => decode_segment(&strip_gmaps_suffix(t))?,
                None => String::new(),
            };
            if place.is_empty() {
                place = if !og_title.is_empty() { og_title } else { page_title };
            }
            if address.is_empty() && !blurb.is_empty() && blurb.contains(',') {
                address = blurb.clone();
            }
            if place.is_empty() || address.is_empty() {
                let state_strings = scan_app_state(html);
                if place.is_empty() && !state_strings.is_empty() {
                    place = state_strings[0].clone();
                }
                if address.is_empty() && state_strings.len() > 1 {
                    // stateStrings.slice(1, 3).join(" · ")
                    address = state_strings[1..3.min(state_strings.len())].join(" · ");
                }
            }
        }
    }

    // ── bare shell / bare coordinates → reverse geocode ─────────────
    if (place.is_empty() || address.is_empty()) && lat.is_some() && lng.is_some() {
        let (name, geo_address) = reverse_geocode(net, lat?, lng?).await;
        if place.is_empty() && !name.is_empty() {
            place = name;
        }
        if address.is_empty() && !geo_address.is_empty() {
            address = geo_address;
        }
    }
    if place.is_empty() && !query.is_empty() {
        place = query;
    }

    let mut parts: Vec<String> = vec!["## Google Maps location".into()];
    let mut facts: Vec<String> = Vec::new();
    if !place.is_empty() {
        facts.push(format!("Place: {place}"));
    }
    if !address.is_empty() {
        facts.push(format!("Address: {address}"));
    }
    if let (Some(la), Some(lo)) = (lat, lng) {
        facts.push(format!(
            "Coordinates: {}, {}",
            js_num_str(la),
            js_num_str(lo)
        ));
    }
    facts.push(format!("Final URL (redirect chain followed): {resolved_url}"));
    if resolved_url != url {
        facts.push(format!("Original short link: {url}"));
    }
    parts.push(facts.join("\n"));
    if !blurb.is_empty() && blurb != address {
        parts.push(js_slice_head(&blurb, 600));
    }
    if facts.len() <= 1 {
        return None; // nothing real decoded
    }
    let markdown = js_slice_head(&parts.join("\n\n"), 4000);
    Some(MapsEvidence {
        resolved_url,
        place,
        address,
        lat,
        lng,
        blurb,
        markdown,
    })
}

/// TS `mapsCompanionQuery(ev)`.
pub fn maps_companion_query(ev: &MapsEvidence) -> Option<String> {
    if !ev.place.is_empty() {
        return Some(js_slice_head(&format!("\"{}\" location map", ev.place), 200));
    }
    if let (Some(lat), Some(lng)) = (ev.lat, ev.lng) {
        return Some(js_slice_head(
            &format!("{}, {} location", js_num_str(lat), js_num_str(lng)),
            200,
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{PageResponse, ScriptedNet, UrlFetchResult};

    fn page(body: &str) -> PageResponse {
        PageResponse {
            status: 200,
            ok: true,
            body: body.into(),
            content_type: "text/html".into(),
            elapsed_ms: 1,
            fingerprint: "chrome".into(),
            cookies: vec![],
            resolved_url: String::new(),
            bot_name: None,
        }
    }

    fn json_ok(text: &str) -> UrlFetchResult {
        UrlFetchResult { status: 200, ok: true, text: text.into() }
    }

    #[test]
    fn is_google_maps_url_parity() {
        assert!(is_google_maps_url("https://maps.google.com/?q=x"));
        assert!(is_google_maps_url("https://maps.app.goo.gl/abc"));
        assert!(is_google_maps_url("https://g.page/abc"));
        assert!(is_google_maps_url("https://www.google.com/maps/place/x"));
        // google.<tld> via the unanchored suffix regex (quirk: any host
        // ENDING in google.xx counts — mygoogle.com included).
        assert!(is_google_maps_url("https://accounts.google.com.au/maps/x"));
        assert!(is_google_maps_url("https://mygoogle.com/maps/x"));
        // host ok but path not /maps:
        assert!(!is_google_maps_url("https://www.google.com/search?q=x"));
        // Quirk: the suffix regex is UNANCHORED — a host merely CONTAINING
        // "google." + 2-7 [a-z.] chars to end-of-string matches (JS true):
        assert!(is_google_maps_url("https://notgoogle.dev/maps/x"));
        assert!(is_google_maps_url("https://www.google.comX/maps/x"));
        // TRUE negatives: suffix part >7 chars or non-[a-z.], or host has no
        // "google." at all:
        assert!(!is_google_maps_url("https://mygoogle.photography/maps/x"));
        assert!(!is_google_maps_url("https://maps.example.com/x"));
        assert!(!is_google_maps_url("not a url"));
    }

    #[test]
    fn decode_segment_parity() {
        assert_eq!(decode_segment("Taj+Mahal").as_deref(), Some("Taj Mahal"));
        assert_eq!(decode_segment("a%20b").as_deref(), Some("a b"));
        // double-encoded comma: %252C → %2C after decode → "," after the
        // post-decode replace (verbatim order).
        assert_eq!(decode_segment("a%252Cb").as_deref(), Some("a,b"));
        // a LITERAL %2C in input survives decoding unchanged → replaced:
        // (decode leaves it, the ci replace fires)
        assert_eq!(decode_segment("A%2cB").as_deref(), Some("A,B"));
        // URIError ⇒ None
        assert_eq!(decode_segment("95%"), None);
    }

    #[test]
    fn search_param_get_parity() {
        let u = Url::parse("https://www.google.com/maps?q=ice+cream,%20st&q2=x&query=later").unwrap();
        // USP: + → space, percent decode; first match wins
        assert_eq!(search_param_get(&u, "q").as_deref(), Some("ice cream, st"));
        assert_eq!(search_param_get(&u, "query").as_deref(), Some("later"));
        assert_eq!(search_param_get(&u, "destination"), None);
        // %2B survives USP as "+" (the later decodeSegment flips it — tested
        // through the pipeline tests below)
        let u2 = Url::parse("https://x/maps?q=a%2Bb").unwrap();
        assert_eq!(search_param_get(&u2, "q").as_deref(), Some("a+b"));
    }

    #[test]
    fn scan_app_state_filters_and_cap() {
        // ONE-LINE blob, exactly like the real single-line APP_INITIALIZATION_
        // STATE payload: with pretty-printed indents, str_re's `[^"\\]{6,180}`
        // pairs the `,\n<indent>` BETWEEN quotes as a junk match (≥6 chars)
        // and desynchronizes the quote pairing (same in JS — pinned below).
        let html = r#"other junk window.APP_INITIALIZATION_STATE=[["Simplename One","Simplename One","https://skip.example/path/to/whatever","short","Aaaa place street 42","123456789012","Abcdefgh 55555 something","plain_digits_123456"],[]];more"#;
        let got = scan_app_state(html);
        assert_eq!(
            got,
            vec![
                "Simplename One",
                "Aaaa place street 42",
                // \d{5,} but has [a-z]{4} ⇒ kept:
                "Abcdefgh 55555 something",
                // machine class matches BUT has a [A-Za-z]{4} run, AND the
                // 5-digit run has an [a-z]{4} (ci) ⇒ NEITHER skip arm fires
                // ⇒ kept (verbatim TS outcome):
                "plain_digits_123456",
            ],
            "dedupe, https skip, <6 skip, machine-no-LET4 skip, bare-digits skip"
        );
    }

    // str_re `[^"\\]{6,180}` EXCLUDES backslashes, so a quoted string
    // carrying a literal backslash-uXXXX escape is never captured — the TS
    // .replace arm can never fire on captured text (dead code, mirrored
    // verbatim). Pinned by this test.
    #[test]
    fn scan_app_state_u_escape_arm_is_dead_quirk() {
        let html = r#"APP_INITIALIZATION_STATE=[["Caf\u00e9 Uppercut"]]"#;
        let got = scan_app_state(html);
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn place_url_decodes_coords_and_name() {
        let net = ScriptedNet::default()
            .with_page("https://www.google.com/maps/place/Taj+Mahal/@27.17517,78.04214,17z", page("<html>shell</html>"));
        let ev = get_google_maps_evidence(
            &net,
            "https://www.google.com/maps/place/Taj+Mahal/@27.17517,78.04214,17z",
        )
        .await
        .expect("evidence");
        assert_eq!(ev.place, "Taj Mahal");
        assert_eq!(ev.lat, Some(27.17517));
        assert_eq!(ev.lng, Some(78.04214));
        assert!(ev.markdown.contains("## Google Maps location"));
        assert!(ev.markdown.contains("Place: Taj Mahal"));
        assert!(ev.markdown.contains("Coordinates: 27.17517, 78.04214"));
        assert!(ev.markdown.contains("Final URL (redirect chain followed): https://www.google.com/maps/place/Taj+Mahal/@27.17517,78.04214,17z"));
        assert!(!ev.markdown.contains("Original short link"));
    }

    #[tokio::test]
    async fn place_segment_captures_at_coords_quirk() {
        // /maps/place/@27.17,78.04 → the ([^/?]+) capture grabs "@27.17,78.04"
        // as a TRUTHY place, so og:title is never used for the name.
        let html = r#"<html><title>Some Place - Google Maps</title>
<meta property="og:title" content="Real Og Name"><meta property="og:description" content="Aligarh, Uttar Pradesh"></html>"#;
        let net = ScriptedNet::default().with_page("https://www.google.com/maps/place/@27.17,78.04", page(html));
        let ev = get_google_maps_evidence(&net, "https://www.google.com/maps/place/@27.17,78.04")
            .await
            .expect("evidence");
        assert_eq!(ev.place, "@27.17,78.04");
        // address comes from the blurb (comma) since place was already set:
        assert_eq!(ev.address, "Aligarh, Uttar Pradesh");
        assert!(ev.markdown.contains("## Google Maps location"));
    }

    #[tokio::test]
    async fn q_url_og_tags_and_blurb_address() {
        let html = r#"<html><title>Coffee Corner — Google Maps extra</title>
<meta property="og:title" content="Coffee Corner Ltd"><meta property="og:description" content="12 MG Road, Bengaluru"></html>"#;
        let net = ScriptedNet::default().with_page("https://www.google.com/maps?q=Coffee+Corner", page(html));
        let ev = get_google_maps_evidence(&net, "https://www.google.com/maps?q=Coffee+Corner")
            .await
            .expect("evidence");
        assert_eq!(ev.place, "Coffee Corner Ltd"); // ogTitle wins when place empty
        assert_eq!(ev.address, "12 MG Road, Bengaluru");
        assert_eq!(ev.blurb, "12 MG Road, Bengaluru");
        // blurb == address ⇒ NOT repeated as a trailing part:
        assert!(!ev.markdown.ends_with(&ev.blurb));
    }

    #[tokio::test]
    async fn title_suffix_strip_and_app_state_fallback() {
        // No og tags; title carries "- Google Maps…" suffix; APP state
        // supplies place + joined address candidates.
        let html = r#"<html><title>The Leela Palace - Google Maps</title>window.APP_INITIALIZATION_STATE=[[null,"The Leela Palace","Karnataka India","https://www.google.com/maps/x","abc","Narnaul Haryana"]]"#;
        let net = ScriptedNet::default().with_page("https://www.google.com/maps?q=Leela", page(html));
        let ev = get_google_maps_evidence(&net, "https://www.google.com/maps?q=Leela")
            .await
            .expect("evidence");
        assert_eq!(ev.place, "The Leela Palace"); // from pageTitle (og absent), suffix stripped
        assert_eq!(ev.address, "Karnataka India · Narnaul Haryana"); // slice(1,3)
    }

    #[tokio::test]
    async fn bare_coords_shell_triggers_nominatim() {
        let shell = "<html><body>js shell only</body></html>";
        let net = ScriptedNet::default()
            .with_page("https://www.google.com/maps/place/@19.1136,72.9683", page(shell))
            .with_url(
                "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=19.1136&lon=72.9683&zoom=17&addressdetails=1",
                json_ok(r#"{"name":"Gateway of India","display_name":"Gateway of India, Apollo Bandar, Mumbai, India"}"#),
            );
        // The place segment capture quirk grabs "@19.1136,72.9683" ⇒ place is
        // truthy; address stays empty ⇒ geocode still runs (address leg),
        // filling ONLY the address.
        let ev = get_google_maps_evidence(&net, "https://www.google.com/maps/place/@19.1136,72.9683")
            .await
            .expect("evidence");
        assert_eq!(ev.address, "Gateway of India, Apollo Bandar, Mumbai, India");
        assert_eq!(ev.place, "@19.1136,72.9683");
        let urls: Vec<String> = net.calls.lock().unwrap().iter().map(|(u, _)| u.clone()).collect();
        assert!(urls.iter().any(|u| u.contains("nominatim.openstreetmap.org/reverse")));
    }

    #[tokio::test]
    async fn coords_without_place_fill_from_geocode() {
        // No place capture possible (no /maps/place), q is the coords string,
        // no og/title, shell body → geocode fills place+address; then the
        // query fallback sits behind it.
        let net = ScriptedNet::default()
            .with_page("https://www.google.com/maps?q=19.1136,72.9683&foo=1", page("<html>shell</html>"))
            .with_url(
                "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=19.1136&lon=72.9683&zoom=17&addressdetails=1",
                json_ok(r#"{"display_name":"Colaba, Mumbai, Maharashtra, India"}"#),
            );
        let ev = get_google_maps_evidence(&net, "https://www.google.com/maps?q=19.1136,72.9683&foo=1")
            .await
            .expect("evidence");
        // parseMapsUrl only extracts @lat,lng from the PATH, not the q=
        // value ⇒ lat/lng are None here and NO geocode fires; place falls
        // back to the parsed query (verbatim TS behavior).
        assert_eq!(ev.lat, None);
        assert_eq!(ev.place, "19.1136,72.9683");
        assert!(!net.calls.lock().unwrap().iter().any(|(u, _)| u.contains("nominatim")));
    }

    #[tokio::test]
    async fn short_link_chain_then_scrape() {
        let net = ScriptedNet::default()
            .with_page("https://maps.app.goo.gl/xyz", PageResponse {
                status: 200, ok: true, body: String::new(), content_type: "text/html".into(),
                elapsed_ms: 1, fingerprint: "chrome".into(), cookies: vec![],
                resolved_url: "https://www.google.com/maps/place/Hawa+Mahal/@26.9239,75.8267".into(),
                bot_name: None,
            })
            .with_page(
                "https://www.google.com/maps/place/Hawa+Mahal/@26.9239,75.8267",
                page(r#"<html><title>Hawa Mahal - Google Maps</title><meta property="og:description" content="Hawa Mahal Rd, Badi Choupad, Jaipur"></html>"#),
            );
        let ev = get_google_maps_evidence(&net, "https://maps.app.goo.gl/xyz")
            .await
            .expect("evidence");
        assert_eq!(ev.place, "Hawa Mahal");
        assert_eq!(ev.address, "Hawa Mahal Rd, Badi Choupad, Jaipur");
        assert!(ev.markdown.contains("Original short link: https://maps.app.goo.gl/xyz"));
    }

    #[tokio::test]
    async fn dead_short_link_facts_le_one_null() {
        // Unwrap fails (unscripted) → resolved stays the stub URL, no maps
        // path, no coords, no scrape → only the Final-URL fact → null.
        let net = ScriptedNet::default();
        assert!(get_google_maps_evidence(&net, "https://maps.app.goo.gl/dead").await.is_none());
    }

    #[tokio::test]
    async fn decode_throw_returns_none_deviation() {
        // TS: URIError inside parseMapsUrl REJECTS the evidence promise;
        // Rust returns None (recorded deviation).
        let net = ScriptedNet::default();
        assert!(get_google_maps_evidence(&net, "https://www.google.com/maps/place/%zz").await.is_none());
    }

    #[test]
    fn companion_query_parity() {
        let mut ev = MapsEvidence {
            resolved_url: "u".into(), place: "".into(), address: "".into(),
            lat: None, lng: None, blurb: "".into(), markdown: "".into(),
        };
        assert_eq!(maps_companion_query(&ev), None);
        ev.lat = Some(19.1136);
        ev.lng = Some(72.9683);
        assert_eq!(maps_companion_query(&ev).as_deref(), Some("19.1136, 72.9683 location"));
        ev.place = "Taj Mahal".into();
        assert_eq!(maps_companion_query(&ev).as_deref(), Some("\"Taj Mahal\" location map"));
        ev.place = "x".repeat(300);
        assert_eq!(maps_companion_query(&ev).unwrap().chars().count(), 200);
    }
}
