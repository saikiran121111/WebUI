//! OWNER: W4 — parity port of `lib/web-search/platform-api.ts`.
//!
//! Keyless platform JSON APIs — the "adapter" tier of the extractor.
//! [`platform_adapter`] dispatches hard-target hosts (reddit / github /
//! youtube / google-maps / openstreetmap) to keyless JSON rewrites;
//! short links are unwrapped FIRST (via `redirect_unwrap`) and dispatch
//! re-runs on the DESTINATION, bounded at depth 2.
//!
//! ## SEAM (WIRING NOTE for the W3b extractor + sibling W4 modules)
//! The TS file imports `isGoogleMapsUrl` / `getGoogleMapsEvidence`
//! (google-maps.ts) and `getYouTubeEvidence` (youtube.ts). Those two TS
//! modules are SIBLING W4 placeholders (`google_maps.rs` / `youtube.rs`
//! are still empty stubs owned by other W4 workers), so this port routes
//! them through the injectable [`Verticals`] trait instead of hard module
//! imports. The TS evidence objects carry more than `markdown`, but this
//! adapter only READS `.markdown` — so the seam returns `Option<String>`
//! (the markdown). Once `google_maps.rs`/`youtube.rs` ship, the Part-6
//! pipeline wires a real [`Verticals`] impl over them; [`NoVerticals`]
//! keeps the maps/youtube branches inert meanwhile (recorded divergence:
//! a TS build always has the real modules; a Rust unit of work in
//! isolation does not).
//! All HTTP goes through the [`Net`] seam (never reqwest directly), so
//! every test here is ScriptedNet-only.
//!
//! ## QUIRKS / DIVERGENCES (kept, not fixed)
//! - **GitHub blob off-by-one destructure (real TS bug, verbatim):**
//!   `const [, owner, repo, branch] = segs` skips segs[0], so with the
//!   `segs[2] === "blob"` gate the raw URL is built as
//!   `raw.githubusercontent.com/<repo>/<"blob">/<branch>/<path>` — a 404
//!   in production for both languages (branch returns null there). The
//!   test scripts the BUGGY url to pin the behavior. Intended-but-unshipped
//!   form would have been `[owner, repo, , branch]`.
//! - Host dispatch strips `www.` THEN `m.`/`music.` (chained replaces —
//!   `www.m.reddit.com` → `reddit.com`); `isGoogleMapsUrl` and the
//!   short-link check run on the RAW url string, not the parsed one.
//! - Reddit listing pick: `Array.isArray(data) ? data : data?.[0] ?? data`
//!   — an ARRAY payload (reddit's real wire shape `[{listing}]`) takes the
//!   Array arm and `array?.data` is undefined ⇒ zero children ⇒ markdown
//!   "" ⇒ `null` — the adapter is dead for live reddit JSON in BOTH
//!   languages (pinned by `reddit_array_payload_zero_children_quirk`).
//!   Non-array objects fall back to `data` itself (the only shape that
//!   renders); strings/numbers/bools end with zero children either way.
//!   `children` being a non-array
//!   OBJECT makes TS throw (for..of TypeError → the async adapter
//!   REJECTS); here it yields no children → `null` (deviation recorded —
//!   callers treat both as "no adapter evidence").
//! - `old.reddit.com` base picked via `hostname.startsWith("old.reddit.com")`
//!   (prefix, not exact-equals — kept; the dispatch switch already limits
//!   the host, so the prefix quirk is only reachable via hand-built URLs).
//! - Truthiness is JS-style (empty string / 0 falsy, objects/arrays truthy);
//!   string concat uses [`js_display`] — non-string JSON values stringify
//!   JS-ish (numbers via integer-shortest form; JS exponential notation for
//!   huge/small floats and `[object Object]` fidelity are micro-divergences
//!   noted in the helper).
//! - `.slice(0, N)` budgets (selftext 2000, body 500, raw 8000, README
//!   6000, `text.length > 50`, `markdown.trim().length >= 100`) count
//!   UTF-16 UNITS like JS `.length`/`.slice` (encode_utf16 helpers).
//! - JS `String.prototype.trim` also strips U+FEFF; Rust `trim` doesn't —
//!   micro-divergence on the `>= 100` threshold only.
//! - JS `for..of`/`Object.entries` order: serde_json `Map` (preserve_order,
//!   already enabled crate-wide) replays document order for the OSM tag
//!   table.
//! - `lat`/`lon` are spliced RAW into the Nominatim URL (no re-encoding) —
//!   TS template literal parity.
//! - **No `process.env` reads** anywhere in this TS module (no API keys;
//!   every endpoint is keyless) — the port reads none at call time or
//!   module load.

use futures_util::future::BoxFuture;
use regex::Regex;
use serde_json::{Number, Value};
use std::sync::OnceLock;
use url::Url;

use crate::net::{Net, UrlFetchOpts};
use crate::redirect_unwrap::{is_short_link_url, unwrap_short_link};

/// TS `AdapterResult`. `kind` is the literal `"adapter"` (TS union
/// `"adapter"`); kept a &'static str so downstream code can assert on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterResult {
    /// Clean markdown for this URL (prepend to extraction).
    pub markdown: String,
    /// How we got it: "adapter" (keyless JSON rewrite).
    pub kind: &'static str,
    /// True when the adapter produced the primary evidence (no DOM needed).
    pub is_primary: bool,
}

impl AdapterResult {
    fn adapter(markdown: String) -> AdapterResult {
        AdapterResult { markdown, kind: "adapter", is_primary: true }
    }
}

/// Seam over the sibling W4 verticals (google-maps.ts / youtube.ts) that
/// `platform-api.ts` imports directly. `net` is threaded so implementations
/// fetch through the same mock boundary. Evidence reduced to `.markdown`
/// (the ONLY field this adapter reads) — see module doc.
pub trait Verticals: Send + Sync {
    /// TS `isGoogleMapsUrl(url)`.
    fn is_google_maps_url(&self, url: &str) -> bool;
    /// TS `getGoogleMapsEvidence(url)` → the evidence's `markdown`.
    fn get_google_maps_evidence<'a>(&'a self, net: &'a dyn Net, url: &str) -> BoxFuture<'a, Option<String>>;
    /// TS `getYouTubeEvidence(url)` → the evidence's `markdown`.
    fn get_youtube_evidence<'a>(&'a self, net: &'a dyn Net, url: &str) -> BoxFuture<'a, Option<String>>;
}

/// Test / verticals-disabled stand-in: maps/youtube dispatch simply finds
/// nothing (module-doc SEAM note). Production wires [`RealVerticals`] — the
/// W4 sibling modules have landed.
pub struct NoVerticals;

impl Verticals for NoVerticals {
    fn is_google_maps_url(&self, _url: &str) -> bool {
        false
    }
    fn get_google_maps_evidence<'a>(&'a self, _net: &'a dyn Net, _url: &str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
    fn get_youtube_evidence<'a>(&'a self, _net: &'a dyn Net, _url: &str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
}

/// Production `Verticals`: delegates to the live W4 sibling modules
/// (`google_maps` / `youtube`), projecting their evidence structs down to
/// the `markdown` field — the ONLY field the TS `platform_adapter` call
/// sites read (`getGoogleMapsEvidence(url)?.markdown` /
/// `getYouTubeEvidence(url)?.markdown`).
pub struct RealVerticals;

impl Verticals for RealVerticals {
    fn is_google_maps_url(&self, url: &str) -> bool {
        crate::google_maps::is_google_maps_url(url)
    }
    fn get_google_maps_evidence<'a>(
        &'a self,
        net: &'a dyn Net,
        url: &str,
    ) -> BoxFuture<'a, Option<String>> {
        // The trait's `url` borrows shorter than `'a` (object-safety shape
        // of `&dyn Net` methods); capture an owned String for the boxed
        // future — content-identical to the TS direct call.
        let url = url.to_string();
        Box::pin(async move {
            crate::google_maps::get_google_maps_evidence(net, &url)
                .await
                .map(|e| e.markdown)
        })
    }
    fn get_youtube_evidence<'a>(
        &'a self,
        net: &'a dyn Net,
        url: &str,
    ) -> BoxFuture<'a, Option<String>> {
        let url = url.to_string();
        Box::pin(async move {
            crate::youtube::get_youtube_evidence(net, &url)
                .await
                .map(|e| e.markdown)
        })
    }
}

// ── JS-semantics helpers ─────────────────────────────────────────────────

/// JS truthiness for JSON values (empty string / 0 / NaN / false / null are
/// falsy; arrays/objects truthy even when empty).
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JS `Number → String` for template/`+` concat: integers print without a
/// trailing `.0` (serde_json keeps the raw token, e.g. `45.0` — JS says
/// `45`). Micro-divergence recorded: exponential formatting for |x| ≥ 1e21
/// / very small floats is Rust-style, not ECMA-style.
fn js_number_str(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f == f.trunc() && f.abs() < 9_007_199_254_740_992f64 {
        return (f as i64).to_string();
    }
    f.to_string()
}

/// JS `String(v)` for concat. Arrays join with `,` and objects render
/// `[object Object]` like JS; strings/numbers/bools/null are direct.
fn js_display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_number_str(n),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(a) => a.iter().map(js_display).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS `s.length` (UTF-16 units).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(0, n)` counting UTF-16 units (surrogate-straddle → U+FFFD,
/// same micro-divergence as net.rs's private copy).
fn js_slice_head(s: &str, n: usize) -> String {
    if js_len(s) <= n {
        return s.to_string();
    }
    let mut acc = String::new();
    let mut u = 0usize;
    for c in s.chars() {
        let clen = c.len_utf16();
        if u + clen > n {
            if clen == 2 {
                acc.push('\u{FFFD}');
            }
            break;
        }
        acc.push(c);
        u += clen;
        if u >= n {
            break;
        }
    }
    acc
}

/// JS `obj?.[k]` then `?? fallback` chain piece: missing OR JSON null both
/// behave as nullish (that is what `?.` + `??` compose to here).
fn opt_get<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.get(k).filter(|x| !x.is_null())
}

// ── dispatcher ───────────────────────────────────────────────────────────

/// TS `platformAdapter(url, depth = 0)`. Returns `None` when the host is
/// not in the table — the caller's DOM extraction then proceeds as usual.
pub async fn platform_adapter(
    net: &dyn Net,
    verticals: &dyn Verticals,
    url: &str,
    depth: u32,
) -> Option<AdapterResult> {
    let u = Url::parse(url).ok()?;
    let raw_host = u.host_str().unwrap_or("");
    let host = raw_host.to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    // strip leading m. OR music. (JS /^(?:m|music)\./)
    let host = host.strip_prefix("m.").or_else(|| host.strip_prefix("music.")).unwrap_or(host);

    // Short links: unwrap the redirect chain FIRST, then dispatch on the
    // resolved destination.
    if depth < 2 && is_short_link_url(url) {
        let resolved = unwrap_short_link(net, url).await;
        if let Some(r) = resolved {
            if r != url {
                return Box::pin(platform_adapter(net, verticals, &r, depth + 1)).await;
            }
        }
        return None;
    }

    // Google Maps (place page, /maps?q=, or a Maps short link — the
    // evidence module follows the chain itself).
    if verticals.is_google_maps_url(url) {
        return maps_adapter(net, verticals, url).await;
    }

    match host {
        "reddit.com" | "old.reddit.com" => reddit_adapter(net, &u).await,
        "github.com" => github_adapter(net, &u).await,
        "youtube.com" | "youtu.be" | "youtube-nocookie.com" => youtube_adapter(net, verticals, url).await,
        "openstreetmap.org" => osm_adapter(net, &u).await,
        _ => None,
    }
}

/// TS Reddit UA — MISSING "(KHTML, like Gecko)" vs the net.ts fingerprint;
/// verbatim string, do not "correct".
const REDDIT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

// ── reddit ───────────────────────────────────────────────────────────────

/// Reddit: rewrite `reddit.com/r/<sub>/...` to the keyless `.json`
/// endpoint for a clean post + top-comments tree without HTML bloat.
/// Subreddit-only URLs (no comment depth) hit the listing endpoint.
async fn reddit_adapter(net: &dyn Net, u: &Url) -> Option<AdapterResult> {
    let hostname = u.host_str().unwrap_or("");
    // startsWith (TS quirk: also matches "old.reddit.com.evil.dev" —
    // unreachable via the dispatch switch which pins exact hosts).
    let is_old = hostname.starts_with("old.reddit.com");
    let base = if is_old { "https://old.reddit.com" } else { "https://www.reddit.com" };

    let json_url = match comment_re().captures(u.path()) {
        Some(m) => format!("{base}/{}.json", &m[1]),
        None => format!("{base}{}.json", u.path()),
    };

    let res = net
        .fetch_url(
            &json_url,
            &UrlFetchOpts {
                timeout_ms: Some(45_000),
                headers: vec![("user-agent".into(), REDDIT_UA.into())],
                ..Default::default()
            },
        )
        .await;
    let res = match res {
        Some(r) if r.ok => r,
        _ => return None,
    };
    let data: Value = serde_json::from_str(&res.text).ok()?;

    // Array.isArray(data) ? data : data?.[0] ?? data  — see module doc.
    let listing: Option<&Value> = match &data {
        Value::Array(_) | Value::Object(_) => Some(&data),
        _ => None,
    };
    let children: &[Value] = listing
        .and_then(|l| l.get("data"))
        .and_then(|d| d.get("children"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let mut lines: Vec<String> = Vec::new();
    for child in children {
        // child?.data — non-object child ⇒ undefined (Value::get → None).
        let d = match child.get("data") {
            Some(d) if js_truthy(d) => d,
            _ => continue,
        };
        let author = d.get("author").filter(|a| js_truthy(a));
        let selftext = d.get("selftext").filter(|s| js_truthy(s));
        let title = d.get("title").filter(|t| js_truthy(t));
        let is_post = author.is_some() && (selftext.is_some() || title.is_some());
        if let (true, Some(t)) = (is_post, title) {
            lines.push(format!("# {}", js_display(t)));
            let sub = d.get("subreddit").filter(|s| js_truthy(s));
            lines.push(format!(
                "By u/{} · {}",
                js_display(author.unwrap()),
                match sub {
                    Some(s) => format!("r/{}", js_display(s)),
                    None => String::new(),
                }
            ));
            if let Some(s) = selftext {
                lines.push(js_slice_head(&js_display(s), 2000));
            }
            if let Some(link) = d.get("url").filter(|x| js_truthy(x)) {
                let link_s = js_display(link);
                if !reddit_com_re().is_match(&link_s) {
                    lines.push(format!("Link: {link_s}"));
                }
            }
        }
        if let Some(body) = d.get("body").filter(|b| js_truthy(b)) {
            lines.push(format!("- {}", js_slice_head(&js_display(body), 500)));
        }
    }
    let markdown = lines.join("\n\n");
    if js_len(markdown.trim()) >= 100 {
        Some(AdapterResult::adapter(markdown))
    } else {
        None
    }
}

fn comment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/(r/[^/]+/comments/[^/]+)").unwrap())
}

fn reddit_com_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"reddit\.com").unwrap())
}

// ── github ───────────────────────────────────────────────────────────────

/// GitHub: rewrite `github.com/<owner>/<repo>/blob/<branch>/<path>` to
/// `raw.githubusercontent.com` for the clean file content. For repo roots,
/// fetch the README via the keyless api.github.com endpoint.
async fn github_adapter(net: &dyn Net, u: &Url) -> Option<AdapterResult> {
    // pathname.split("/").filter(Boolean)
    let segs: Vec<&str> = u.path().split('/').filter(|s| !s.is_empty()).collect();
    // /owner/repo/blob/branch/path → raw
    if segs.len() >= 5 && segs[2] == "blob" {
        // QUIRK VERBATIM: TS `const [, owner, repo, branch] = segs` skips
        // segs[0] → owner=segs[1], repo=segs[2] (the literal "blob"),
        // branch=segs[3]. The TS intent was [owner, repo, , branch]; the
        // shipped off-by-one 404s in BOTH languages — pinned by test.
        let owner = segs[1];
        let repo = segs[2];
        let branch = segs[3];
        let path = segs[4..].join("/");
        let raw_url = format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}");
        let res = net
            .fetch_url(
                &raw_url,
                &UrlFetchOpts {
                    timeout_ms: Some(45_000),
                    ..Default::default()
                },
            )
            .await;
        if let Some(r) = res {
            if r.ok && js_len(&r.text) > 50 {
                return Some(AdapterResult::adapter(format!(
                    "## GitHub file: {path}\n```\n{}\n```",
                    js_slice_head(&r.text, 8000)
                )));
            }
        }
        return None;
    }
    // /owner/repo (root) → README
    if segs.len() == 2 {
        let (owner, repo) = (segs[0], segs[1]);
        let res = net
            .fetch_url(
                &format!("https://api.github.com/repos/{owner}/{repo}/readme"),
                &UrlFetchOpts {
                    timeout_ms: Some(2500),
                    headers: vec![
                        ("user-agent".into(), "Mozilla/5.0".into()),
                        ("accept".into(), "application/vnd.github.v3.raw".into()),
                    ],
                    ..Default::default()
                },
            )
            .await;
        if let Some(r) = res {
            if r.ok && js_len(&r.text) > 50 {
                return Some(AdapterResult::adapter(format!(
                    "## GitHub repo: {owner}/{repo}\n{}",
                    js_slice_head(&r.text, 6000)
                )));
            }
        }
        return None;
    }
    // /owner/repo/issues/N or /pull/N — no rewrite, caller's DOM
    // extraction + JSON-LD (if present) handles these.
    None
}

// ── youtube / maps (verticals seam) ──────────────────────────────────────

/// YouTube: the youtubei.js evidence module parses EVERY URL format and
/// returns title/channel/description + transcript + top comments as
/// primary adapter evidence.
async fn youtube_adapter(net: &dyn Net, verticals: &dyn Verticals, original_url: &str) -> Option<AdapterResult> {
    let ev = verticals.get_youtube_evidence(net, original_url).await?;
    Some(AdapterResult::adapter(ev))
}

/// Google Maps: unwrap the Firebase dynamic short link, decode the place
/// name / address / @lat,lng from the RESOLVED URL, scrape the place page,
/// and fall back to Nominatim reverse geocoding when the page is a bare
/// JS shell.
async fn maps_adapter(net: &dyn Net, verticals: &dyn Verticals, original_url: &str) -> Option<AdapterResult> {
    let ev = verticals.get_google_maps_evidence(net, original_url).await?
;
    Some(AdapterResult::adapter(ev))
}

// ── openstreetmap ────────────────────────────────────────────────────────

/// OpenStreetMap: `map.html?mlat=...&mlon=...` → Nominatim reverse
/// geocode; `/node/N`, `/way/N`, `/relation/N` → the OSM element API —
/// clean data instead of the empty WebGL canvas the DOM returns.
async fn osm_adapter(net: &dyn Net, u: &Url) -> Option<AdapterResult> {
    let lat = u.query_pairs().find(|(k, _)| k == "mlat").map(|(_, v)| v.into_owned());
    let lon = u.query_pairs().find(|(k, _)| k == "mlon").map(|(_, v)| v.into_owned());
    if let (Some(lat), Some(lon)) = (lat.filter(|s| !s.is_empty()), lon.filter(|s| !s.is_empty())) {
        let res = net
            .fetch_url(
                // lat/lon spliced RAW into the query (TS template parity).
                &format!("https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=jsonv2&zoom=14"),
                &UrlFetchOpts {
                    timeout_ms: Some(45_000),
                    ..Default::default()
                },
            )
            .await;
        if let Some(r) = res {
            if r.ok {
                if let Ok(data) = serde_json::from_str::<Value>(&r.text) {
                    if data.is_null() {
                        // `null.display_name` TypeError in JS → inner catch
                        // → fall through (deviation recorded: Rust no-throw).
                    } else {
                        let display = opt_get(&data, "display_name").map(js_display).unwrap_or_else(|| "unknown".into());
                        let mut lines: Vec<String> = vec![
                            "## OpenStreetMap location".into(),
                            format!("Coordinates: {lat}, {lon}"),
                            format!("Address: {display}"),
                        ];
                        // data.address ?? {}
                        let address = data.get("address").filter(|a| !a.is_null()).cloned().unwrap_or(Value::Object(Default::default()));
                        for k in ["country", "state", "city", "town", "hamlet", "road"] {
                            if let Some(v) = address.get(k).filter(|v| js_truthy(v)) {
                                lines.push(format!("{k}: {}", js_display(v)));
                            }
                        }
                        return Some(AdapterResult::adapter(lines.join("\n")));
                    }
                }
                // JSON.parse throw → fall through (TS comment: /* fall through */)
            }
        }
    }
    if let Some(m) = element_re().captures(u.path()) {
        let (kind, id) = (&m[1], &m[2]);
        let res = net
            .fetch_url(
                &format!("https://api.openstreetmap.org/api/0.6/{kind}/{id}.json"),
                &UrlFetchOpts {
                    timeout_ms: Some(45_000),
                    ..Default::default()
                },
            )
            .await;
        if let Some(r) = res {
            if r.ok {
                if let Ok(data) = serde_json::from_str::<Value>(&r.text) {
                    if !data.is_null() {
                        // data[m[1]]?.tags ?? data?.tags ?? {}
                        let tags = opt_get(&data, kind)
                            .and_then(|c| opt_get(c, "tags"))
                            .or_else(|| opt_get(&data, "tags"))
                            .cloned()
                            .unwrap_or(Value::Object(Default::default()));
                        // `${data[m[1]]?.lat ?? data.lat}, … — missing on both
                        // sides renders JS "undefined".
                        let coord = |key: &str| -> String {
                            match opt_get(&data, kind)
                                .and_then(|c| opt_get(c, key))
                                .or_else(|| opt_get(&data, key))
                            {
                                Some(v) => js_display(v),
                                None => "undefined".into(),
                            }
                        };
                        let mut lines: Vec<String> = vec![
                            format!("## OSM {kind} {id}"),
                            format!("Lat/Lon: {}, {}", coord("lat"), coord("lon")),
                        ];
                        if let Value::Object(map) = &tags {
                            for (k, v) in map {
                                lines.push(format!("{k}: {}", js_display(v)));
                            }
                        }
                        return Some(AdapterResult::adapter(lines.join("\n")));
                    }
                }
            }
        }
    }
    None
}

fn element_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // JS /^\/(node|way|relation)\/(\d+)/ — un-anchored tail (TS parity).
    RE.get_or_init(|| Regex::new(r"^/(node|way|relation)/(\d+)").unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{PageResponse, ScriptedNet, UrlFetchResult};

    fn json_ok(text: &str) -> UrlFetchResult {
        UrlFetchResult { status: 200, ok: true, text: text.into() }
    }

    fn page(_url: &str, resolved: &str) -> PageResponse {
        PageResponse {
            status: 200,
            ok: true,
            body: String::new(),
            content_type: "text/html".into(),
            elapsed_ms: 1,
            fingerprint: "chrome".into(),
            cookies: vec![],
            resolved_url: resolved.into(),
            bot_name: None,
        }
    }

    struct TestVerticals {
        maps: bool,
        maps_md: Option<&'static str>,
        yt_md: Option<&'static str>,
    }

    impl Verticals for TestVerticals {
        fn is_google_maps_url(&self, url: &str) -> bool {
            self.maps && url.contains("maps-marker")
        }
        fn get_google_maps_evidence<'a>(&'a self, _net: &'a dyn Net, url: &str) -> BoxFuture<'a, Option<String>> {
            let md = self.maps_md.map(|s| format!("{s} for {url}"));
            Box::pin(async move { md })
        }
        fn get_youtube_evidence<'a>(&'a self, _net: &'a dyn Net, url: &str) -> BoxFuture<'a, Option<String>> {
            let md = self.yt_md.map(|s| format!("{s} for {url}"));
            Box::pin(async move { md })
        }
    }

    fn tv() -> TestVerticals {
        TestVerticals { maps: true, maps_md: Some("MAPS"), yt_md: Some("YT") }
    }

    fn no_calls(net: &ScriptedNet) {
        assert!(net.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dispatch_table_negatives() {
        let net = ScriptedNet::default();
        let v = tv();
        assert!(platform_adapter(&net, &v, "not a url", 0).await.is_none());
        assert!(platform_adapter(&net, &v, "https://whatever.dev/x", 0).await.is_none());
        // near-miss hosts are NOT in the table (switch, not prefix):
        assert!(platform_adapter(&net, &v, "https://notreddit.com/x", 0).await.is_none());
        assert!(platform_adapter(&net, &v, "https://tile.openstreetmap.org/x", 0).await.is_none());
        no_calls(&net);
    }

    // Bare OBJECT payload — the only shape that renders (the Array arm is
    // quirk-dead; see reddit_array_payload_zero_children_quirk). Joined
    // markdown below is ~81 UTF-16 units → null by the >=100 threshold.
    const REDDIT_JSON: &str = r#"{"kind":"Listing","data":{"children":[
        {"kind":"t3","data":{"author":"poster","title":"Big Post","selftext":"S","subreddit":"rust","url":"https://external.dev/x"}},
        {"kind":"t1","data":{"body":"comment text"}},
        {"kind":"t1","data":{}}
    ]}}"#;

    #[tokio::test]
    async fn reddit_comment_flow_and_threshold() {
        // Object payload (non-array → `data?.[0] ?? data` → data itself).
        let long_post = "x".repeat(120);
        let body = format!(
            r#"{{"kind":"Listing","data":{{"children":[
            {{"kind":"t3","data":{{"author":"poster","title":"Big Post","selftext":"{long_post}","subreddit":"rust","url":"https://external.dev/x"}}}},
            {{"kind":"t1","data":{{"body":"comment text"}}}}
        ]}}}}"#
        );
        // www + comment path → comments/<id>.json (capture stops at the id —
        // the slug is NOT in the .json path) on www.reddit.com base
        let net = ScriptedNet::default().with_url(
            "https://www.reddit.com/r/rust/comments/abc.json",
            json_ok(&body),
        );
        let r = platform_adapter(&net, &tv(), "https://www.reddit.com/r/rust/comments/abc/title-slug/", 0)
            .await
            .expect("adapter evidence");
        assert_eq!(r.kind, "adapter");
        assert!(r.is_primary);
        assert!(r.markdown.contains("# Big Post"));
        assert!(r.markdown.contains("By u/poster · r/rust"));
        assert!(r.markdown.contains(&long_post));
        assert!(r.markdown.contains("Link: https://external.dev/x"));
        assert!(r.markdown.contains("- comment text"));
        assert_eq!(net.calls.lock().unwrap()[0], ("https://www.reddit.com/r/rust/comments/abc.json".into(), "fetch_url"));
        // below the 100-char trim threshold → null (short selftext version)
        let net2 = ScriptedNet::default().with_url(
            "https://www.reddit.com/r/rust/comments/abc.json",
            json_ok(REDDIT_JSON),
        );
        assert!(platform_adapter(&net2, &tv(), "https://reddit.com/r/rust/comments/abc/title-slug", 0).await.is_none());
    }

    #[tokio::test]
    async fn reddit_array_payload_zero_children_quirk() {
        // TS parity: `Array.isArray(data) ? data : data?.[0] ?? data` — the
        // array payload takes the ARRAY arm, then `listing?.data?.children`
        // is undefined on an array → `?? []` → ZERO children → markdown ""
        // → `trim().length >= 100` false → null, even though the SAME
        // content renders as an object payload. Reddit's live wire shape is
        // `[{listing}]`, so this adapter never fires in production —
        // TS quirk kept verbatim (the old REDDIT_JSON-array tests asserting
        // rendered evidence were asserting intended-but-unshipped behavior).
        let long_post = "x".repeat(120);
        let arr_body = format!(
            r#"[{{"kind":"Listing","data":{{"children":[
            {{"kind":"t3","data":{{"author":"poster","title":"Big Post","selftext":"{long_post}","subreddit":"rust","url":"https://external.dev/x"}}}},
            {{"kind":"t1","data":{{"body":"comment text"}}}}
        ]}}}}]"#
        );
        let net = ScriptedNet::default().with_url(
            "https://www.reddit.com/r/rust/comments/abc.json",
            json_ok(&arr_body),
        );
        assert!(
            platform_adapter(&net, &tv(), "https://www.reddit.com/r/rust/comments/abc/title-slug", 0)
                .await
                .is_none()
        );
        // the null came from the quirk, not a missing fetch:
        assert_eq!(net.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn reddit_old_base_listing_object_and_failures() {
        // old.reddit.com → OLD base; non-array listing payload → `data`
        // itself (data?.[0] ?? data on an object).
        let long = "z".repeat(130);
        let body = format!(r#"{{"data":{{"children":[{{"data":{{"author":"a","title":"T","selftext":"{long}","url":"https://old.reddit.com/r/x"}}}}]}}}}"#);
        let net = ScriptedNet::default().with_url(
            "https://old.reddit.com/r/rust/comments/q9.json",
            json_ok(&body),
        );
        let r = platform_adapter(&net, &tv(), "https://old.reddit.com/r/rust/comments/q9/zz", 0)
            .await
            .expect("old base evidence");
        // d.url CONTAINS "reddit.com" → NO Link line (/reddit\.com/ test):
        assert!(!r.markdown.contains("Link:"));
        // no subreddit → "By u/a · " with trailing separator (JS concat parity)
        assert!(r.markdown.contains("By u/a · \n\n"));
        assert_eq!(net.calls.lock().unwrap()[0].0, "https://old.reddit.com/r/rust/comments/q9.json");
        // m.reddit.com dispatches (m. stripped) but isOld checks the ORIGINAL
        // hostname → WWW base (startsWith("old.reddit.com") quirk):
        let net6 = ScriptedNet::default().with_url(
            "https://www.reddit.com/r/rust/comments/q9.json",
            json_ok(&body),
        );
        let r6 = platform_adapter(&net6, &tv(), "https://m.reddit.com/r/rust/comments/q9/zz", 0)
            .await
            .expect("m. prefix dispatches to reddit.com");
        assert_eq!(net6.calls.lock().unwrap()[0].0, "https://www.reddit.com/r/rust/comments/q9.json");
        assert!(r6.markdown.contains("# T"));
        // fetch failure → null
        let net2 = ScriptedNet::default();
        assert!(platform_adapter(&net2, &tv(), "https://reddit.com/r/x/comments/1/y", 0).await.is_none());
        // non-ok → null
        let net3 = ScriptedNet::default().with_url(
            "https://www.reddit.com/r/x/comments/1.json",
            UrlFetchResult { status: 403, ok: false, text: "blocked".into() },
        );
        assert!(platform_adapter(&net3, &tv(), "https://reddit.com/r/x/comments/1/y", 0).await.is_none());
        // bad JSON → null
        let net4 = ScriptedNet::default().with_url(
            "https://www.reddit.com/r/x/comments/1.json",
            json_ok("<html>not json</html>"),
        );
        assert!(platform_adapter(&net4, &tv(), "https://reddit.com/r/x/comments/1/y", 0).await.is_none());
        // subreddit-only (no comment path) → pathname + .json
        // Object payload (the Array arm is quirk-dead — see
        // reddit_array_payload_zero_children_quirk).
        let net5 = ScriptedNet::default().with_url("https://www.reddit.com/r/rust/top.json", json_ok(&format!(r#"{{"kind":"Listing","data":{{"children":[{{"kind":"t1","data":{{"body":"{long}"}}}}]}}}}"#)));
        let r5 = platform_adapter(&net5, &tv(), "https://www.reddit.com/r/rust/top", 0).await.expect("listing");
        assert_eq!(net5.calls.lock().unwrap()[0].0, "https://www.reddit.com/r/rust/top.json");
        assert!(r5.markdown.starts_with("- "));
    }

    #[tokio::test]
    async fn github_blob_offbyone_quirk_verbatim() {
        // The shipped TS destructure `[, owner, repo, branch]` produces the
        // BUGGY raw URL (owner=segs[1], repo="blob"). Pin exactly that.
        let long = "c".repeat(100);
        let net = ScriptedNet::default()
            .with_url("https://raw.githubusercontent.com/vscode/blob/main/package.json", json_ok(&long))
            .with_url("https://raw.githubusercontent.com/Microsoft/vscode/main/package.json", json_ok("CORRECT-URL-NOT-REQUESTED"));
        let r = platform_adapter(&net, &tv(), "https://github.com/Microsoft/vscode/blob/main/package.json", 0)
            .await
            .expect("quirk URL scripted");
        assert_eq!(r.markdown, format!("## GitHub file: package.json\n```\n{long}\n```"));
        let urls: Vec<String> = net.calls.lock().unwrap().iter().map(|(u, _)| u.clone()).collect();
        assert_eq!(urls, vec!["https://raw.githubusercontent.com/vscode/blob/main/package.json".to_string()]);
        // short content (<=50 UTF-16 units) → null
        let net2 = ScriptedNet::default().with_url(
            "https://raw.githubusercontent.com/vscode/blob/main/package.json",
            json_ok("tiny"),
        );
        assert!(platform_adapter(&net2, &tv(), "https://github.com/Microsoft/vscode/blob/main/package.json", 0).await.is_none());
    }

    #[tokio::test]
    async fn github_repo_root_readme_and_passthrough() {
        let long = "r".repeat(80);
        let net = ScriptedNet::default().with_url("https://api.github.com/repos/tokio-rs/tokio/readme", json_ok(&long));
        let r = platform_adapter(&net, &tv(), "https://github.com/tokio-rs/tokio", 0).await.expect("readme");
        assert_eq!(r.markdown, format!("## GitHub repo: tokio-rs/tokio\n{long}"));
        // issues/pull paths → no rewrite, zero fetches
        let net2 = ScriptedNet::default();
        assert!(platform_adapter(&net2, &tv(), "https://github.com/tokio-rs/tokio/issues/42", 0).await.is_none());
        no_calls(&net2);
        assert!(platform_adapter(&net2, &tv(), "https://github.com/one", 0).await.is_none()); // 1 seg
        no_calls(&net2);
    }

    #[tokio::test]
    async fn youtube_hosts_dispatch_original_url() {
        let net = ScriptedNet::default();
        let v = tv();
        for url in [
            "https://youtu.be/dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQ",
            "https://m.youtube.com/shorts/abc",
            "https://music.youtube.com/watch?v=x",
            "https://www.youtube-nocookie.com/embed/abc",
        ] {
            let r = platform_adapter(&net, &v, url, 0).await.expect("yt evidence");
            assert_eq!(r.markdown, format!("YT for {url}"), "original URL passed verbatim: {url}");
        }
        no_calls(&net); // evidence itself lives behind the seam
        // NoVerticals (module-doc SEAM): youtube branch inert.
        assert!(platform_adapter(&net, &NoVerticals, "https://youtu.be/dQ", 0).await.is_none());
    }

    #[tokio::test]
    async fn maps_shortlink_unwraps_first_then_dispatches() {
        // maps.app.goo.gl is a shortlink → unwrap BEFORE the maps check;
        // dispatch re-runs on the resolved destination (depth+1).
        let target = "https://www.google.com/maps/place/maps-marker/12";
        let net = ScriptedNet::default().with_page("https://maps.app.goo.gl/abc123", page("https://maps.app.goo.gl/abc123", target));
        let r = platform_adapter(&net, &tv(), "https://maps.app.goo.gl/abc123", 0).await.expect("maps after unwrap");
        assert_eq!(r.markdown, format!("MAPS for {target}"));
        // non-maps shortlink resolving to a table host:
        let net2 = ScriptedNet::default().with_page(
            "https://redd.it/xyz",
            page("https://redd.it/xyz", "https://youtu.be/dQ"),
        );
        let r2 = platform_adapter(&net2, &tv(), "https://redd.it/xyz", 0).await.unwrap();
        assert_eq!(r2.markdown, "YT for https://youtu.be/dQ");
        // chain break (no scripted page) → null, NOT the maps fallthrough.
        let net3 = ScriptedNet::default();
        assert!(platform_adapter(&net3, &tv(), "https://bit.ly/xyz", 0).await.is_none());
        // resolved === url → settled stub → null even for a maps short link.
        let net4 = ScriptedNet::default().with_page(
            "https://maps.app.goo.gl/stub",
            page("https://maps.app.goo.gl/stub", "https://maps.app.goo.gl/stub"),
        );
        assert!(platform_adapter(&net4, &tv(), "https://maps.app.goo.gl/stub", 0).await.is_none());
        // depth guard: at depth 2 the shortlink branch is skipped → host
        // switch default null.
        assert!(platform_adapter(&net4, &tv(), "https://maps.app.goo.gl/stub", 2).await.is_none());
    }

    #[tokio::test]
    async fn osm_coords_reverse_geocode() {
        let nom = "https://nominatim.openstreetmap.org/reverse?lat=47.6062&lon=-122.3321&format=jsonv2&zoom=14";
        let body = r#"{"display_name":"Seattle, WA","address":{"country":"USA","state":"Washington","city":"Seattle","hamlet":"","road":"4th Ave"}}"#;
        let net = ScriptedNet::default().with_url(nom, json_ok(body));
        let r = platform_adapter(&net, &tv(), "https://www.openstreetmap.org/?mlat=47.6062&mlon=-122.3321#map=14", 0)
            .await
            .expect("reverse geocode");
        assert_eq!(
            r.markdown,
            "## OpenStreetMap location\nCoordinates: 47.6062, -122.3321\nAddress: Seattle, WA\ncountry: USA\nstate: Washington\ncity: Seattle\nroad: 4th Ave"
        );
        // bad Nominatim JSON → fall through to the element regex (path "/"
        // doesn't match) → null.
        let net2 = ScriptedNet::default().with_url(nom, json_ok("not json"));
        assert!(platform_adapter(&net2, &tv(), "https://openstreetmap.org/?mlat=1&mlon=2", 0).await.is_none());
        // empty mlat= → falsy → element branch → null, no Nominatim call.
        let net3 = ScriptedNet::default();
        assert!(platform_adapter(&net3, &tv(), "https://openstreetmap.org/?mlat=&mlon=2", 0).await.is_none());
        no_calls(&net3);
    }

    #[tokio::test]
    async fn osm_element_api_tags_and_coords() {
        // child lat/lon win; tags from child; insertion order preserved.
        let body = r#"{"version":0.6,"elements":[{"id":1}],"node":{"id":2945512361,"lat":47.6,"lon":-122.33,"tags":{"amenity":"cafe","name":"Üz café","building":"yes"}}}"#;
        let net = ScriptedNet::default().with_url("https://api.openstreetmap.org/api/0.6/node/2945512361.json", json_ok(body));
        let r = platform_adapter(&net, &tv(), "https://www.openstreetmap.org/node/2945512361#map=19", 0)
            .await
            .expect("element");
        assert!(r.markdown.starts_with("## OSM node 2945512361\nLat/Lon: 47.6, -122.33\n"));
        // document order (preserve_order Map): amenity, name, building
        let tail = r.markdown.splitn(3, '\n').nth(2).unwrap().to_string();
        assert_eq!(tail, "amenity: cafe\nname: Üz café\nbuilding: yes");
        // data-level fallback coords + missing → "undefined" (JS concat parity)
        let body2 = r#"{"lat":48.0,"lon":16.0}"#;
        let net2 = ScriptedNet::default().with_url("https://api.openstreetmap.org/api/0.6/way/42.json", json_ok(body2));
        let r2 = platform_adapter(&net2, &tv(), "https://www.openstreetmap.org/way/42", 0).await.unwrap();
        assert_eq!(r2.markdown, "## OSM way 42\nLat/Lon: 48, 16");
        // integer-shortest: 48.0 → JS "48" (serde raw token "48.0" divergence
        // guarded by js_number_str)
        let body3 = r#"{"node":{"id":7}}"#;
        let net3 = ScriptedNet::default().with_url("https://api.openstreetmap.org/api/0.6/relation/7.json", json_ok(body3));
        let r3 = platform_adapter(&net3, &tv(), "https://www.openstreetmap.org/relation/7", 0).await.unwrap();
        assert_eq!(r3.markdown, "## OSM relation 7\nLat/Lon: undefined, undefined");
        // path regex un-anchored tail: /node/9x still matches /node/9
        let net4 = ScriptedNet::default().with_url("https://api.openstreetmap.org/api/0.6/node/9.json", json_ok(r#"{"node":{"id":9,"lat":1,"lon":2,"tags":{}}}"#));
        let r4 = platform_adapter(&net4, &tv(), "https://www.openstreetmap.org/node/9x", 0).await.unwrap();
        assert_eq!(r4.markdown, "## OSM node 9\nLat/Lon: 1, 2");
    }
}
