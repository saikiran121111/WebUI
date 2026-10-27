//! OWNER: W4 — parity port of `lib/web-search/youtube.ts`.
//!
//! YouTube deep evidence for ANY url format (youtu.be / watch / shorts /
//! embed / live / v / m. / music. / nocookie): video-id parse → InnerTube
//! info (title / channel / description / views / upload date / tags) →
//! transcript + top comments → oEmbed metadata fallback → assembled
//! evidence markdown, memoized per video id (TTL 10 min, clear at 64).
//!
//! ## APPROVED-BY-NECESSITY DIVERGENCE — the InnerTube TRANSPORT seam
//! The TS original drives `youtubei.js` (an npm InnerTube client with a
//! cached web session and an ANDROID consent-gate fallback). There is NO
//! Rust equivalent in-tree, and vendoring one is out of scope for a parity
//! port. The pure logic (URL parse, payload PARSERS over `serde_json::Value`
//! exactly as youtubei.js surfaces them, clock formatting, chapter scan,
//! markdown assembly, TTL evidence cache) is ported verbatim; the three
//! TRANSPORT calls sit behind [`InnerTubeClient`]. The seam now LANDS:
//! [`youtube_bridge::HttpInnerTube`] (crate::youtube_bridge) implements the
//! trait over the Next-hosted `POST /api/internal/youtube-evidence` RPC,
//! which drives youtubei.js plus the universal browser caption engine —
//! YouTube's Proof-of-Origin gating means no plain-HTTP client can fetch
//! caption tracks, so the transcript tier answers through the Node/
//! Playwright side. [`set_default_inner_tube`] wires it at server startup;
//! when the bridge env vars are absent, [`NoInnerTube`] remains the
//! fallback and evidence degrades exactly like TS source-3: the keyless
//! **oEmbed tier only** (title + channel + "no captions/comments" notice).
//! All other tiers are fully live.
//!
//! ## QUIRKS (kept verbatim)
//! - Host normalization strips `^www.` then `^m.` then `^music.` (each once,
//!   in that order): `music.youtube.com` → `youtube.com` (the `^m.` strip
//!   misses it — `mu` ≠ `m.`) but a bare `m.` host still works.
//! - `watch`/`watch_live` require the EXACT pathname (`/watching` fails);
//!   the path regex `/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/` is
//!   UNANCHORED at the end (trailing junk still yields the 11-char id).
//! - `bi.channel` object-vs-string: an OBJECT (or ARRAY — JS `typeof [] ===
//!   "object"`, null excluded by the truthiness guard) uses ONLY
//!   `.name ?? ""`; otherwise the chain is `channel_name ?? channel ??
//!   author`.
//! - `Number(String(view_count ?? "0").replace(/,/g,"")) || 0` — commas
//!   stripped BEFORE coercion; any NaN → 0.
//! - `upload_date.slice(0,10)`; tags `String()`-mapped then sliced to 12
//!   (`String(null)` → "null" inside the map).
//! - Transcript: CR/LF/formfeed/U+2028 runs → " " THEN `\s+` → " " THEN
//!   trim; ms chain s.start_ms → seg.start_ms → s.start → seg.start (null
//!   falls through each `??`); cap check is `lines.join("\n").length >=
//!   12_000` (last line INCLUDED, then the joined string is
//!   `.slice(0,12_000)`).
//! - `fmtClock` receives RAW (possibly fractional/NaN) seconds from
//!   `Duration:` facts — a fractional `lengthSeconds` yields e.g.
//!   `"00:9.5"` (padStart only pads SHORTER strings) — pinned.
//! - Comments: author block ONLY when author truthy; likes block only when
//!   Number truthy (0/NaN falsy); text sliced to 300 AFTER collapse+trim;
//!   max 10.
//! - `parts.filter(Boolean)` and `markdown.length < 60 → null` are both
//!   effectively DEAD (every collect that survives to assembly pushes the
//!   facts line with `Video ID:`) — ported verbatim anyway.
//! - oEmbed runs ONLY when title OR channel is still missing after InnerTube.
//! - Cache: `>= 64 → clear()` happens BEFORE `set` (the new entry survives
//!   a full cache); an explicit negative (dead video) is CACHED and
//!   returned without refetching for the TTL.
//!
//! ## RECORDED MICRO-DIVERGENCES (parity-relevant only)
//! - `String(value)` coercion (js_to_string): Object → `[object Object]`,
//!   Array → `,`-join with null/undefined elements rendered as "" (JS
//!   Array.prototype.join), standalone Null → "null" (JS ToString).
//! - `Number(string)` (js_number_from_str): supports trim/decimal/exp/
//!   Infinity/0x-hex; `0b`/`0o` prefixes (JS accepts) → NaN here; the
//!   exponential DISPLAY threshold in js_num_str differs at ≥1e21 marginally
//!   ("1e30" vs JS "1e+30") — unreachable for view/like counts.
//! - `toLocaleString("en-US")`: grouping + ≤3 fraction digits (half-expand
//!   rounding, matching ECMA-402 default; non-finite falls back to the
//!   plain number string; >1e21 magnitudes group the exponential string
//!   wrong — unreachable in practice).
//! - JS `\s` includes U+FEFF; Rust `\s` (Unicode mode) does not; JS `.`
//!   excludes `\r`/U+2028/U+2029, Rust `.` only excludes `\n` (chapter
//!   lines are `\n`-split + trimmed first, so mid-line cases need literal
//!   control chars inside one line).
//! - JS `Math.round(-0.4)` yields `-0`; here +0 (both render "0" via
//!   js_num_str — unobservable).
//! - The evidence-cache TTL uses a monotonic clock (`Date.now()` in TS);
//!   wall-clock adjustments could shift TS expiry, not ours.
//! - `new URL` accept-set differs marginally between Node's WHATWG URL and
//!   the `url` crate (same note as sibling modules); a `v` param carrying
//!   `+` decodes to " " (JS URLSearchParams) vs "+" (url crate) — both fail
//!   the 11-char id regex ⇒ same null outcome.

use futures_util::future::BoxFuture;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use url::Url;

use crate::net::{Net, UrlFetchOpts};

/// TS `YouTubeEvidence`.
#[derive(Clone, Debug, PartialEq)]
pub struct YouTubeEvidence {
    pub video_id: String,
    pub canonical_url: String,
    pub title: String,
    pub channel: String,
    pub description: String,
    pub length_seconds: f64,
    pub view_count: f64,
    pub publish_date: String,
    pub chapters: Vec<String>,
    pub transcript: String,
    pub markdown: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedVideo {
    pub video_id: String,
    pub canonical_url: String,
}

/* ── JS-coercion helpers (per-module, mirrored from siblings) ─────────── */

fn js_num_str(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into(); // JS String(-0) === "0"
    }
    if x == x.trunc() && x.abs() < 1e21 {
        return (x as i128).to_string();
    }
    format!("{x}")
}

/// JS `String(value)` for JSON payloads (standalone Null → "null"; the
/// `,`-join renders null elements as "" per Array.prototype.join).
fn js_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.to_string(),
            None => match n.as_u64() {
                Some(u) => u.to_string(),
                None => js_num_str(n.as_f64().unwrap_or(f64::NAN)),
            },
        },
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a
            .iter()
            .map(|e| if e.is_null() { String::new() } else { js_to_string(e) })
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// `String(x ?? "")` — undefined OR null coalesce to "" before String().
fn js_str(v: Option<&Value>) -> String {
    match v {
        Some(x) if !x.is_null() => js_to_string(x),
        _ => String::new(),
    }
}

/// JS StringToNumber: trim; ""→0; "Infinity"→∞; "0x"→hex; else strict
/// decimal/scientific or NaN (`0b`/`0o` recorded).
fn js_number_from_str(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    for (lit, val) in
        [("Infinity", f64::INFINITY), ("-Infinity", f64::NEG_INFINITY), ("+Infinity", f64::INFINITY)]
    {
        if t == lit {
            return val;
        }
    }
    let (sign, rest) = match t.strip_prefix('-') {
        Some(r) => (-1.0, r),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    if let Some(hex) = rest.strip_prefix("0x").or_else(|| rest.strip_prefix("0X")) {
        return match u64::from_str_radix(hex, 16) {
            Ok(u) => sign * u as f64,
            Err(_) => f64::NAN,
        };
    }
    if rest.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) {
        match rest.parse::<f64>() {
            Ok(f) => sign * f,
            Err(_) => f64::NAN,
        }
    } else {
        f64::NAN
    }
}

/// JS `Number(value)` for JSON payloads.
fn js_number_v(v: &Value) -> f64 {
    match v {
        Value::Number(_) => v.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number_from_str(s),
        Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        Value::Null => 0.0, // Number(null) === 0
        _ => js_number_from_str(&js_to_string(v)),
    }
}

/// `Number(x)` where a missing key is `undefined` → NaN.
fn js_number_opt(v: Option<&Value>) -> f64 {
    match v {
        Some(x) => js_number_v(x),
        None => f64::NAN,
    }
}

fn js_math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    (x + 0.5).floor()
}

/// JS `.length` in UTF-16 code units.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `.slice(0, n)` (UTF-16 units, clamped).
fn js_slice_head(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// JS `encodeURIComponent` (bytes outside `A-Za-z0-9-_.!~*'()` → %XX).
fn js_encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// `toLocaleString("en-US")` for finite numbers: integer grouping plus up
/// to 3 (trailing-zero-stripped) fraction digits; non-finite → js_num_str.
fn to_locale_us(n: f64) -> String {
    if !n.is_finite() {
        return js_num_str(n);
    }
    let neg = n < 0.0 || (n == 0.0 && n.is_sign_negative());
    let a = n.abs();
    let milli = (a * 1000.0).round(); // half-expand = ECMA-402 default
    let ip = (milli / 1000.0).trunc();
    let fp = (milli % 1000.0) as u32;
    let digits = js_num_str(ip);
    let grouped: String = {
        let rev: Vec<char> = digits.chars().rev().collect();
        let mut g = String::new();
        for (i, c) in rev.iter().enumerate() {
            if i > 0 && i % 3 == 0 {
                g.push(',');
            }
            g.push(*c);
        }
        g.chars().rev().collect()
    };
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(&grouped);
    let mut frac = format!("{fp:03}");
    while frac.ends_with('0') {
        frac.pop();
    }
    if !frac.is_empty() {
        out.push('.');
        out.push_str(&frac);
    }
    out
}

fn regex_static(slot: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    slot.get_or_init(|| Regex::new(pat).unwrap())
}

static VALID_ID_RE: OnceLock<Regex> = OnceLock::new();
static PATH_ID_RE: OnceLock<Regex> = OnceLock::new();
static CR_LF_RE: OnceLock<Regex> = OnceLock::new();
static WS_RE: OnceLock<Regex> = OnceLock::new();
static CHAP_RE: OnceLock<Regex> = OnceLock::new();

fn valid_video_id(id: &str) -> bool {
    regex_static(&VALID_ID_RE, r"^[A-Za-z0-9_-]{11}$").is_match(id)
}

/* ── URL → video id (ALL formats) ─────────────────────────────────────── */

pub fn parse_youtube_video_id(url: &str) -> Option<ParsedVideo> {
    let u = Url::parse(url).ok()?;
    let host = u.host_str()?.to_lowercase();
    let host = {
        let h = host.strip_prefix("www.").unwrap_or(&host);
        let h = h.strip_prefix("m.").unwrap_or(h);
        h.strip_prefix("music.").unwrap_or(h).to_string()
    };
    let canonical = |id: &str| format!("https://www.youtube.com/watch?v={id}");

    if host == "youtu.be" {
        let id = u.path().split('/').find(|s| !s.is_empty()).unwrap_or("");
        return if valid_video_id(id) {
            Some(ParsedVideo { video_id: id.into(), canonical_url: canonical(id) })
        } else {
            None
        };
    }
    if host == "youtube.com" || host == "youtube-nocookie.com" {
        if u.path() == "/watch" || u.path() == "/watch_live" {
            let id =
                u.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.into_owned()).unwrap_or_default();
            return if valid_video_id(&id) {
                Some(ParsedVideo { video_id: id.clone(), canonical_url: canonical(&id) })
            } else {
                None
            };
        }
        if let Some(m) = regex_static(&PATH_ID_RE, r"^/(shorts|embed|live|v)/([A-Za-z0-9_-]{11})")
            .captures(u.path())
        {
            let id = &m[2];
            if valid_video_id(id) {
                return Some(ParsedVideo { video_id: id.into(), canonical_url: canonical(id) });
            }
        }
    }
    None
}

/* ── InnerTube transport seam (see module header) ─────────────────────── */

/// The three youtubei.js round-trips. Implementations MUST apply the TS
/// validity gate inside `get_info` — `if (info?.basic_info?.title ??
/// info?.title) return info` — including the web→ANDROID client retry, and
/// must honor the `??`-chain quirk where an EMPTY-STRING `basic_info.title`
/// (non-nullish) blocks the `title` fallback and fails the gate. Return
/// `None` where youtubei.js would THROW (the callers then behave exactly
/// like the TS `catch` arms: transcript "" / comments [] / info null).
pub trait InnerTubeClient: Send + Sync {
    fn get_info<'a>(&'a self, video_id: &str) -> BoxFuture<'a, Option<Value>>;
    fn get_transcript<'a>(&'a self, info: &'a Value) -> BoxFuture<'a, Option<Value>>;
    fn get_comments<'a>(&'a self, info: &'a Value) -> BoxFuture<'a, Option<Value>>;
}

/// Production default: no InnerTube ⇒ oEmbed-only evidence tier (TS source-3).
pub struct NoInnerTube;

impl InnerTubeClient for NoInnerTube {
    fn get_info<'a>(&'a self, _video_id: &str) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async { None })
    }
    fn get_transcript<'a>(&'a self, _info: &'a Value) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async { None })
    }
    fn get_comments<'a>(&'a self, _info: &'a Value) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async { None })
    }
}

/// Process-wide InnerTube client: ruke-server wires
/// [`crate::youtube_bridge::HttpInnerTube`] via [`set_default_inner_tube`]
/// at startup (same env-gated pattern as the Tier-3b browser bridge);
/// unset ⇒ [`NoInnerTube`] (oEmbed-only degradation).
static DEFAULT_INNERTUBE: OnceLock<Arc<dyn InnerTubeClient>> = OnceLock::new();

pub fn set_default_inner_tube(client: Arc<dyn InnerTubeClient>) {
    let _ = DEFAULT_INNERTUBE.set(client);
}

fn default_inner_tube() -> Arc<dyn InnerTubeClient> {
    DEFAULT_INNERTUBE
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoInnerTube))
}

/* ── payload parsers (verbatim youtubei.js payload shapes) ────────────── */

/// `tr?.segments ?? tr?.transcript?.body?.initial_segments ?? []`.
fn transcript_segments(tr: Option<&Value>) -> Vec<Value> {
    if let Some(t) = tr {
        if let Some(a) = t.get("segments").and_then(Value::as_array) {
            return a.clone();
        }
        let v =
            t.get("transcript").and_then(|x| x.get("body")).and_then(|b| b.get("initial_segments"));
        if let Some(a) = v.and_then(Value::as_array) {
            return a.clone();
        }
    }
    Vec::new()
}

/// TS `transcriptFromInfo` over the resolved transcript payload.
fn transcript_lines(tr: Option<&Value>) -> String {
    let crlf = regex_static(&CR_LF_RE, r"[\r\n\x0c\u{2028}]+");
    let ws = regex_static(&WS_RE, r"\s+");
    let mut lines: Vec<String> = Vec::new();
    let mut joined_len = 0usize;
    for s in transcript_segments(tr) {
        // s?.segment?.transcript_segment ?? s
        let seg: &Value =
            s.get("segment").and_then(|x| x.get("transcript_segment")).unwrap_or(&s);
        // String(seg?.text?.content ?? seg?.text ?? "")
        let text = seg
            .get("text")
            .and_then(|t| t.get("content").filter(|v| !v.is_null()))
            .or_else(|| seg.get("text").filter(|v| !v.is_null()))
            .map(js_to_string)
            .unwrap_or_default();
        let text = ws.replace_all(&crlf.replace_all(&text, " "), " ").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let ms = s
            .get("start_ms")
            .filter(|v| !v.is_null())
            .or_else(|| seg.get("start_ms").filter(|v| !v.is_null()))
            .or_else(|| s.get("start").filter(|v| !v.is_null()))
            .or_else(|| seg.get("start").filter(|v| !v.is_null()))
            .map(js_number_v)
            .unwrap_or(0.0);
        let line = format!("[{}] {}", fmt_clock(js_math_round(ms / 1000.0)), text);
        let line_len = js_len(&line);
        joined_len += line_len + usize::from(!lines.is_empty()); // join("\n")
        lines.push(line);
        if joined_len >= 12_000 {
            break;
        }
    }
    js_slice_head(&lines.join("\n"), 12_000)
}

/// TS `topComments(info, n=10)` over the resolved comments payload.
fn comment_lines(res: Option<&Value>) -> Vec<String> {
    let arr: Vec<Value> = match res {
        Some(Value::Array(a)) => a.clone(),
        Some(o) => o.get("comments").and_then(Value::as_array).cloned().unwrap_or_default(),
        None => Vec::new(),
    };
    let ws = regex_static(&WS_RE, r"\s+");
    let mut out: Vec<String> = Vec::new();
    for c in arr {
        // String(c?.comment?.content ?? c?.text?.content ?? c?.text ?? "")
        let text = c
            .get("comment")
            .and_then(|cm| cm.get("content").filter(|v| !v.is_null()))
            .or_else(|| c.get("text").and_then(|t| t.get("content").filter(|v| !v.is_null())))
            .or_else(|| c.get("text").filter(|v| !v.is_null()))
            .map(js_to_string)
            .unwrap_or_default();
        let text = js_slice_head(ws.replace_all(&text, " ").trim(), 300);
        if text.is_empty() {
            continue;
        }
        let author = c
            .get("comment")
            .and_then(|cm| cm.get("author").filter(|v| !v.is_null()))
            .or_else(|| c.get("author").filter(|v| !v.is_null()))
            .map(js_to_string)
            .unwrap_or_default()
            .trim()
            .to_string();
        let likes = c
            .get("comment")
            .and_then(|cm| cm.get("like_count").filter(|v| !v.is_null()))
            .or_else(|| c.get("like_count").filter(|v| !v.is_null()))
            .map(js_number_v)
            .unwrap_or(0.0);
        let prefix = if author.is_empty() {
            String::new()
        } else if likes != 0.0 && !likes.is_nan() {
            format!("{} ({}👍): ", author, to_locale_us(likes))
        } else {
            format!("{author}: ")
        };
        out.push(format!("{prefix}{text}"));
        if out.len() >= 10 {
            break;
        }
    }
    out
}

/// JS `%` (RemainderOp — sign follows the dividend; Rust f64 `%` matches).
fn rem_js(a: f64, b: f64) -> f64 {
    a % b
}

fn fmt_clock(total_sec: f64) -> String {
    let h = (total_sec / 3600.0).floor();
    let m = (rem_js(total_sec, 3600.0) / 60.0).floor();
    let s = rem_js(total_sec, 60.0);
    let pad = |x: f64| {
        let t = js_num_str(x);
        if t.encode_utf16().count() < 2 {
            format!("0{t}")
        } else {
            t
        }
    };
    let mm = pad(m);
    let ss = pad(s);
    if h > 0.0 {
        format!("{}:{mm}:{ss}", js_num_str(h))
    } else {
        format!("{mm}:{ss}")
    }
}

/// TS CHAPTER_LINE_RE — `\d` pinned ASCII ([0-9]); `\s`/`\S` stay Unicode.
fn chapters_from_description(desc: &str) -> Vec<String> {
    let re = regex_static(
        &CHAP_RE,
        r"^\s*(?:[0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2}\s*[-–—:.]?\s*\S.{0,90}$",
    );
    desc.split('\n')
        .map(|l| l.trim().to_string())
        .filter(|l| re.is_match(l))
        .take(20)
        .collect()
}

/* ── oEmbed (keyless, over the Net seam) ──────────────────────────────── */

async fn oembed(net: &dyn Net, video_id: &str) -> Option<(String, String)> {
    let canonical = format!("https://www.youtube.com/watch?v={video_id}");
    let url = format!(
        "https://www.youtube.com/oembed?url={}&format=json",
        js_encode_uri_component(&canonical)
    );
    let res = net
        .fetch_url(
            &url,
            &UrlFetchOpts {
                timeout_ms: Some(12_000),
                ..Default::default()
            },
        )
        .await?;
    if !res.ok {
        return None;
    }
    let j: Value = serde_json::from_str(&res.text).ok()?;
    Some((js_str(j.get("title")), js_str(j.get("author_name"))))
}

/* ── top level ────────────────────────────────────────────────────────── */

const EVIDENCE_TTL: Duration = Duration::from_secs(10 * 60);

type EvidenceCacheEntry = (Instant, Option<YouTubeEvidence>);

fn evidence_cache() -> &'static Mutex<HashMap<String, EvidenceCacheEntry>> {
    static C: OnceLock<Mutex<HashMap<String, EvidenceCacheEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Test/pipeline-integration hook: drop all memoized evidence.
#[allow(dead_code)] // used by W4c pipeline integration tests
pub(crate) fn reset_evidence_cache_for_tests() {
    evidence_cache().lock().unwrap().clear();
}

pub async fn get_youtube_evidence(net: &dyn Net, url: &str) -> Option<YouTubeEvidence> {
    get_youtube_evidence_with(net, url, default_inner_tube().as_ref()).await
}

pub async fn get_youtube_evidence_with(
    net: &dyn Net,
    url: &str,
    client: &dyn InnerTubeClient,
) -> Option<YouTubeEvidence> {
    let parsed = parse_youtube_video_id(url)?;
    // Clone the entry then DROP the guard before any await (Send-safe future).
    let hit = evidence_cache().lock().unwrap().get(&parsed.video_id).cloned();
    if let Some((at, val)) = hit {
        if at.elapsed() < EVIDENCE_TTL {
            return val;
        }
    }
    let value = collect_youtube_evidence(net, url, &parsed, client).await;
    let mut c = evidence_cache().lock().unwrap();
    if c.len() >= 64 {
        c.clear();
    }
    c.insert(parsed.video_id.clone(), (Instant::now(), value.clone()));
    value
}

async fn collect_youtube_evidence(
    net: &dyn Net,
    url: &str,
    parsed: &ParsedVideo,
    client: &dyn InnerTubeClient,
) -> Option<YouTubeEvidence> {
    let ParsedVideo { video_id, canonical_url } = parsed;

    // 1) InnerTube getInfo (client-side web → ANDROID fallback + gate).
    let info = client.get_info(video_id).await;

    // const bi = info?.basic_info ?? info ?? {};
    let empty = Value::Null;
    let bi: &Value = match &info {
        Some(i) => match i.get("basic_info") {
            Some(b) if !b.is_null() => b,
            _ => i,
        },
        None => &empty,
    };

    let mut title = js_str(bi.get("title"));
    // channel: OBJECT (or array — JS typeof; Null excluded by pattern) uses
    // .name only; TS truthiness guard excludes falsy values from the object
    // arm, but a falsy non-object ("" / 0) falls into the else branch and
    // resolves through the ?? chain to the same "" — same outcome.
    let mut channel = match bi.get("channel") {
        Some(v @ (Value::Object(_) | Value::Array(_))) => js_str(v.get("name")),
        _ => {
            let ch = bi
                .get("channel_name")
                .filter(|x| !x.is_null())
                .or_else(|| bi.get("channel").filter(|x| !x.is_null()))
                .or_else(|| bi.get("author").filter(|x| !x.is_null()));
            ch.map(js_to_string).unwrap_or_default()
        }
    };

    // 2) oEmbed last-resort metadata (only while title OR channel missing).
    if title.is_empty() || channel.is_empty() {
        if let Some(oe) = oembed(net, video_id).await {
            if title.is_empty() {
                title = oe.0;
            }
            if channel.is_empty() {
                channel = oe.1;
            }
        }
    }
    if title.is_empty() {
        return None; // nothing real to report
    }

    let description = js_str(
        bi.get("short_description")
            .filter(|x| !x.is_null())
            .or_else(|| bi.get("description").filter(|x| !x.is_null())),
    );
    let length_seconds = {
        let n = js_number_opt(bi.get("duration"));
        if n == 0.0 || n.is_nan() {
            0.0
        } else {
            n
        }
    };
    let view_count = {
        // String(bi?.view_count ?? "0").replace(/,/g,"") → Number → ||0
        let s = bi
            .get("view_count")
            .filter(|x| !x.is_null())
            .map(js_to_string)
            .unwrap_or_else(|| "0".into());
        let n = js_number_from_str(&s.replace(',', ""));
        if n == 0.0 || n.is_nan() {
            0.0
        } else {
            n
        }
    };
    let publish_date = js_slice_head(&js_str(bi.get("upload_date")), 10);
    let tags: Vec<String> = match bi.get("tags") {
        Some(Value::Array(a)) => a.iter().take(12).map(js_to_string).collect(),
        _ => Vec::new(),
    };

    // 3) transcript (real captions first) + top comments.
    let transcript = match &info {
        Some(i) => transcript_lines(client.get_transcript(i).await.as_ref()),
        None => String::new(),
    };
    let comments = match &info {
        Some(i) => comment_lines(client.get_comments(i).await.as_ref()),
        None => Vec::new(),
    };

    let chapters = chapters_from_description(&description);

    /* ── assemble the evidence markdown ── */
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("## YouTube video: \"{title}\""));
    let mut facts: Vec<String> = Vec::new();
    if !channel.is_empty() {
        facts.push(format!("Channel: {channel}"));
    }
    if length_seconds > 0.0 {
        facts.push(format!("Duration: {}", fmt_clock(length_seconds)));
    }
    if view_count > 0.0 {
        facts.push(format!("Views: {}", to_locale_us(view_count)));
    }
    if !publish_date.is_empty() {
        facts.push(format!("Published: {publish_date}"));
    }
    facts.push(format!("Video ID: {video_id}"));
    facts.push(format!("Watch URL: {canonical_url}"));
    if url != canonical_url {
        facts.push(format!("Original link: {url}"));
    }
    parts.push(facts.join(" | "));
    if !tags.is_empty() {
        parts.push(format!("Tags: {}", tags.join(", ")));
    }
    if !description.is_empty() {
        parts.push("### Video description".into());
        parts.push(js_slice_head(&description, 1500));
    }
    if !chapters.is_empty() {
        parts.push("### Chapters / timestamps".into());
        parts.push(chapters.join("\n"));
    }
    if !transcript.is_empty() {
        parts.push("### Video transcript (captions, timestamped)".into());
        parts.push(transcript.clone());
    } else if !comments.is_empty() {
        parts.push("### Transcript".into());
        parts.push(
            "(No caption track available — metadata, description and top community comments below are the full retrievable content for this video.)"
                .into(),
        );
    } else {
        parts.push("### Transcript".into());
        parts.push(
            "(No caption track and no comments available for this video — the description + metadata above are the full retrievable content.)"
                .into(),
        );
    }
    if !comments.is_empty() {
        parts.push("### Top comments".into());
        parts.push(
            comments
                .iter()
                .map(|c| format!("- {c}"))
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    // parts.filter(Boolean) — inert (no part is ever pushed empty); kept for
    // structural parity.
    parts.retain(|p| !p.is_empty());
    let markdown = js_slice_head(&parts.join("\n\n"), 18_000);
    // markdown.length < 60 — effectively dead: the facts line always carries
    // "Video ID:" (pinned by the full-stack test); ported verbatim.
    if js_len(&markdown) < 60 {
        return None;
    }

    Some(YouTubeEvidence {
        video_id: video_id.clone(),
        canonical_url: canonical_url.clone(),
        title,
        channel,
        description,
        length_seconds,
        view_count,
        publish_date,
        chapters,
        transcript,
        markdown,
    })
}

/* ── companion metasearch query ───────────────────────────────────────── */

pub fn you_tube_companion_query(ev: &YouTubeEvidence) -> Option<String> {
    let t = ev.title.trim().to_string();
    if t.is_empty() {
        return None;
    }
    let c = ev.channel.trim().to_string();
    let q = if c.is_empty() {
        format!("\"{t}\" youtube")
    } else {
        format!("\"{t}\" \"{c}\"")
    };
    Some(js_slice_head(&q, 200))
}

/* ── tests ────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{ScriptedNet, UrlFetchResult};
    use serde_json::json;

    fn v(s: &str) -> Value {
        serde_json::from_str(s).expect("fixture json")
    }

    struct MockInnerTube {
        info: Option<Value>,
        transcript: Option<Value>,
        comments: Option<Value>,
    }

    impl MockInnerTube {
        fn new(info: &str, transcript: &str, comments: &str) -> Self {
            Self {
                info: Some(v(info)),
                transcript: Some(v(transcript)),
                comments: Some(v(comments)),
            }
        }
    }

    impl InnerTubeClient for MockInnerTube {
        fn get_info<'a>(&'a self, _video_id: &str) -> BoxFuture<'a, Option<Value>> {
            Box::pin(async move { self.info.clone() })
        }
        fn get_transcript<'a>(&'a self, _info: &'a Value) -> BoxFuture<'a, Option<Value>> {
            Box::pin(async move { self.transcript.clone() })
        }
        fn get_comments<'a>(&'a self, _info: &'a Value) -> BoxFuture<'a, Option<Value>> {
            Box::pin(async move { self.comments.clone() })
        }
    }

    #[test]
    fn parse_id_matrix() {
        let p = parse_youtube_video_id("https://youtu.be/dQw4w9WgXcQ?si=x").unwrap();
        assert_eq!(p.video_id, "dQw4w9WgXcQ");
        assert_eq!(p.canonical_url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        // extra path segments: first non-empty wins
        assert_eq!(
            parse_youtube_video_id("https://youtu.be/abcDEF_-123/extra").unwrap().video_id,
            "abcDEF_-123"
        );
        assert!(parse_youtube_video_id("https://youtu.be/tooshort1").is_none());
        assert!(parse_youtube_video_id("https://youtu.be/").is_none());
        // exact watch path + v param
        assert_eq!(
            parse_youtube_video_id("https://www.youtube.com/watch?v=12345678901&t=1")
                .unwrap()
                .video_id,
            "12345678901"
        );
        assert_eq!(
            parse_youtube_video_id("https://m.youtube.com/watch?v=12345678901").unwrap().video_id,
            "12345678901"
        );
        // music. strip works because ^m. misses first (mu… ≠ m.)
        assert_eq!(
            parse_youtube_video_id("https://music.youtube.com/watch?v=12345678901")
                .unwrap()
                .video_id,
            "12345678901"
        );
        // EXACT pathname: /watching is NOT /watch (quirk)
        assert!(parse_youtube_video_id("https://www.youtube.com/watching?v=12345678901").is_none());
        assert_eq!(
            parse_youtube_video_id("https://www.youtube.com/watch_live?v=12345678901")
                .unwrap()
                .video_id,
            "12345678901"
        );
        // missing v
        assert!(parse_youtube_video_id("https://www.youtube.com/watch").is_none());
        // path forms; UNANCHORED at end — trailing junk still yields the id
        for form in ["shorts", "embed", "live", "v"] {
            assert_eq!(
                parse_youtube_video_id(&format!(
                    "https://www.youtube.com/{form}/abcdefghijkEXTRA"
                ))
                .unwrap()
                .video_id,
                "abcdefghijk"
            );
        }
        assert_eq!(
            parse_youtube_video_id("https://www.youtube-nocookie.com/embed/abcdefghijk")
                .unwrap()
                .video_id,
            "abcdefghijk"
        );
        // 10-char ids fail the {11} path regex
        assert!(parse_youtube_video_id("https://www.youtube.com/shorts/abcdefghij").is_none());
        // other hosts / invalid urls
        assert!(parse_youtube_video_id("https://example.com/watch?v=12345678901").is_none());
        assert!(parse_youtube_video_id("not a url").is_none());
    }

    #[test]
    fn fmt_clock_parity() {
        assert_eq!(fmt_clock(0.0), "00:00");
        assert_eq!(fmt_clock(65.0), "01:05");
        assert_eq!(fmt_clock(3599.0), "59:59");
        assert_eq!(fmt_clock(3600.0), "1:00:00");
        assert_eq!(fmt_clock(45678.0), "12:41:18");
        // quirk: fractional SECONDS (Duration facts pass raw numbers):
        assert_eq!(fmt_clock(9.5), "00:9.5");
        assert_eq!(fmt_clock(f64::NAN), "NaN:NaN");
        // negative totals (JS % follows the dividend; Math.floor goes down):
        // h = floor(-63/3600) = -1, m = floor(-63/60) = -2, s = -63%60 = -3;
        // h>0 false, "-2"/"-3" are ≥2 chars so padStart no-ops. PINNED:
        assert_eq!(fmt_clock(-63.0), "-2:-3");
        assert_eq!(rem_js(-63.0, 60.0), -3.0);
        assert_eq!(((-63.0f64 % 3600.0) / 60.0).floor(), -2.0);
    }

    #[test]
    fn locale_us_parity() {
        assert_eq!(to_locale_us(1_234_567.0), "1,234,567");
        assert_eq!(to_locale_us(12.5), "12.5");
        assert_eq!(to_locale_us(1_000.0), "1,000");
        assert_eq!(to_locale_us(999.0), "999");
        assert_eq!(to_locale_us(0.5), "0.5");
        assert_eq!(to_locale_us(-1_234.0), "-1,234");
        assert_eq!(to_locale_us(f64::NAN), "NaN");
        // 3-fraction-digit half-expand cap (matches ECMA-402 default):
        assert_eq!(to_locale_us(1234.5678), "1,234.568");
        // sub-milli carry:
        assert_eq!(to_locale_us(0.9999), "1");
    }

    #[test]
    fn js_coercions_parity() {
        assert_eq!(js_to_string(&json!({"a":1})), "[object Object]");
        assert_eq!(js_to_string(&json!([1, null, "x"])), "1,,x"); // join: null → ""
        assert_eq!(js_to_string(&json!(5.0)), "5"); // not "5.0"
        assert_eq!(js_to_string(&json!(null)), "null"); // standalone String(null)
        assert_eq!(js_str(None), "");
        assert_eq!(js_str(Some(&Value::Null)), ""); // ?? "" coalesces null
        assert_eq!(js_number_from_str(""), 0.0);
        assert_eq!(js_number_from_str(" 42 "), 42.0);
        assert!(js_number_from_str("1,234").is_nan()); // commas NOT stripped here
        assert!(js_number_from_str("12abc").is_nan());
        assert!(js_number_from_str(".").is_nan());
        assert_eq!(js_number_from_str("0x10"), 16.0);
        assert_eq!(js_number_from_str("Infinity"), f64::INFINITY);
        assert_eq!(js_number_from_str("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_number_from_str("5e3"), 5000.0);
        assert_eq!(js_number_v(&json!(true)), 1.0);
        assert_eq!(js_number_v(&json!(null)), 0.0); // Number(null) === 0
        assert_eq!(js_number_v(&json!([5])), 5.0);
        assert!(js_number_v(&json!({})).is_nan());
        assert!(js_number_opt(None).is_nan()); // Number(undefined)
        assert_eq!(js_math_round(2.5), 3.0);
        assert_eq!(js_math_round(-2.5), -2.0);
        assert_eq!(
            js_encode_uri_component("https://a.b/c?d=e&f=é"),
            "https%3A%2F%2Fa.b%2Fc%3Fd%3De%26f%3D%C3%A9"
        );
        assert_eq!(js_slice_head("a€bc", 2), "a€");
        assert_eq!(js_len("a€"), 2);
    }

    #[test]
    fn chapters_parity() {
        let desc = "intro text\n  0:00 Intro  \n5:30 – Middle\n1:02:03 Third hour\n1234:56 bad\n0:10\njust text\n01:02:03 -- padded";
        let got = chapters_from_description(desc);
        assert_eq!(
            got,
            vec![
                "0:00 Intro",
                "5:30 – Middle",      // en-dash separator class
                "1:02:03 Third hour", // (hh:)? prefix
                // "1234:56 bad": prefix needs "NN:" — "12:" fails on '3' at
                // pos 2; no-prefix arm needs "N:NN" or "NN:NN" — "12:" then
                // '3' isn't ':' ; "1:" then '2' isn't ':' ⇒ NO MATCH. PINNED.
                // "0:10": mm:ss needs a \S TAIL after \d{2} — end-of-string ⇒
                // NO MATCH. PINNED.
                "01:02:03 -- padded", // hh prefix + one-char "-" separator,
                                      // 2nd "-" is the \S tail
            ]
        );
        // 20-line cap:
        let many = vec!["0:01 x".to_string(); 30].join("\n");
        assert_eq!(chapters_from_description(&many).len(), 20);
    }

    #[test]
    fn transcript_lines_parity() {
        // both payload shapes + segment nesting + whitespace collapse +
        // string ms + null fall-through + skip-empty + join-cap semantics.
        let tr = v(
            r#"{
            "segments": [
              {"segment":{"transcript_segment":{"text":{"content":"hello   world"},"start_ms":0}}},
              {"text":"line\ttwo","start":2500},
              {"text":"   ","start_ms":3000},
              {"text":{"content":"third\r\nline"},"start_ms":"5500"},
              {"start_ms":6000}
            ]
        }"#,
        );
        let got = transcript_lines(Some(&tr));
        assert_eq!(got, "[00:00] hello world\n[00:03] line two\n[00:06] third line");
        // start=2500 → Number 2500 → round(2.5)=3 → "00:03"; start_ms as
        // STRING "5500" → 5500 → 5.5 → round → 6.
        let alt = v(r#"{"transcript":{"body":{"initial_segments":[{"simpleText":"x","text":"seg one","start_ms":61000}]}}}"#);
        assert_eq!(transcript_lines(Some(&alt)), "[01:01] seg one");
        // null start_ms falls through ?? to start (quirk):
        let nul = v(r#"{"segments":[{"text":"n","start_ms":null,"start":9000,"startMs":1,"startms":2}]}"#);
        assert_eq!(transcript_lines(Some(&nul)), "[00:09] n");
        assert_eq!(transcript_lines(None), "");
        // 12k cap: 1000-char texts ⇒ ~1008-unit lines; break fires when
        // joined >= 12000 (12th line), then slice to exactly 12000.
        let big: Vec<Value> =
            (0..20u32).map(|i| json!({"text": "x".repeat(1000), "start_ms": i * 1000})).collect();
        let got = transcript_lines(Some(&json!({"segments": big})));
        assert_eq!(js_len(&got), 12_000);
        assert!(got.starts_with("[00:00] "));
    }

    #[test]
    fn comments_parity() {
        let res = v(
            r#"{ "comments": [
            {"comment":{"content":"  great  video ","author":"Alice","like_count":1234567}},
            {"text":"no author here","like_count":12.5},
            {"comment":{"content":"zero likes","author":"Bob","like_count":0}},
            {"text":"   "},
            {"comment":{"content":"array text","author":["Obj","ect"],"like_count":null}}
        ]}"#,
        );
        let got = comment_lines(Some(&res));
        assert_eq!(
            got,
            vec![
                "Alice (1,234,567👍): great video",
                "no author here", // empty author ⇒ NO prefix/colon at all
                "Bob: zero likes", // likes falsy ⇒ no (N👍)
                "Obj,ect: array text", // String(["Obj","ect"]) = "Obj,ect";
                                       // like_count null falls through ?? to
                                       // missing ⇒ Number(0) falsy
            ]
        );
        // res as a bare ARRAY + 300-unit slice AFTER collapse+trim:
        let arr = json!([{"text": format!("  {}  ", "x".repeat(350))}]);
        let got = comment_lines(Some(&arr));
        assert_eq!(js_len(&got[0]), 300);
        assert!(got[0].starts_with('x') && got[0].ends_with('x'));
        // n=10 cap:
        let many = Value::Array((0..25).map(|i| json!({"text": format!("c{i}")})).collect());
        assert_eq!(comment_lines(Some(&many)).len(), 10);
        assert_eq!(comment_lines(None), Vec::<String>::new());
        assert_eq!(comment_lines(Some(&json!(null))), Vec::<String>::new());
    }

    #[tokio::test]
    async fn oembed_url_and_parsing() {
        let net = ScriptedNet::default().with_url(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Daaaaaaaaaaa&format=json",
            UrlFetchResult { status: 200, ok: true, text: r#"{"title":"T","author_name":"A"}"#.into() },
        );
        let oe = oembed(&net, "aaaaaaaaaaa").await.unwrap();
        assert_eq!(oe, ("T".into(), "A".into()));
        // non-ok ⇒ None; garbage ⇒ None
        let net2 = ScriptedNet::default().with_url(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dbbbbbbbbbbb&format=json",
            UrlFetchResult { status: 404, ok: false, text: String::new() },
        );
        assert!(oembed(&net2, "bbbbbbbbbbb").await.is_none());
        let net3 = ScriptedNet::default().with_url(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dccccccccccc&format=json",
            UrlFetchResult { status: 200, ok: true, text: "not json".into() },
        );
        assert!(oembed(&net3, "ccccccccccc").await.is_none());
        // unscripted ⇒ None (fetch_url None mirrors TS stage skip)
        assert!(oembed(&ScriptedNet::default(), "ddddddddddd").await.is_none());
    }

    #[tokio::test]
    async fn full_stack_with_inner_tube() {
        let client = MockInnerTube::new(
            r#"{"basic_info": {
                "title": "Some Video",
                "channel": {"id": "UCx", "name": "SomeChannel", "url": "u"},
                "short_description": "desc head\n0:00 intro\n5:30 - middle\njust prose",
                "duration": 3725,
                "view_count": "1,234,567",
                "upload_date": "2024-05-01T12:00:00+00:00",
                "tags": ["t1","t2","t3","t4","t5","t6","t7","t8","t9","t10","t11","t12","t13"]
            }}"#,
            r#"{"segments":[{"text":{"content":"first caption"},"start_ms":1500}]}"#,
            r#"{"comments":[{"comment":{"content":"nice","author":"Zed","like_count":3}}]}"#,
        );
        let net = ScriptedNet::default(); // NOTHING scripted: no oEmbed may run
        let ev = get_youtube_evidence_with(&net, "https://youtu.be/eeeeeeeeeee", &client)
            .await
            .expect("evidence");
        assert_eq!(ev.video_id, "eeeeeeeeeee");
        assert_eq!(ev.title, "Some Video");
        assert_eq!(ev.channel, "SomeChannel"); // OBJECT branch → .name
        assert_eq!(ev.length_seconds, 3725.0);
        assert_eq!(ev.view_count, 1_234_567.0); // commas stripped before Number
        assert_eq!(ev.publish_date, "2024-05-01");
        assert_eq!(ev.description, "desc head\n0:00 intro\n5:30 - middle\njust prose");
        assert!(ev.markdown.contains("## YouTube video: \"Some Video\""));
        assert!(ev.markdown.contains("Channel: SomeChannel"));
        assert!(ev.markdown.contains("Duration: 1:02:05"));
        assert!(ev.markdown.contains("Views: 1,234,567"));
        assert!(ev.markdown.contains("Published: 2024-05-01"));
        assert!(ev.markdown.contains("Video ID: eeeeeeeeeee"));
        assert!(ev.markdown.contains("Original link: https://youtu.be/eeeeeeeeeee"));
        // tags sliced to 12 — t13 must be absent:
        assert!(ev.markdown.contains("Tags: t1, t2"));
        assert!(ev.markdown.contains("t11, t12"));
        assert!(!ev.markdown.contains("t13"));
        // chapters from description (trimmed lines):
        assert_eq!(ev.chapters, vec!["0:00 intro", "5:30 - middle"]);
        assert!(ev.markdown.contains("### Video description"));
        assert!(ev.markdown.contains("### Chapters / timestamps"));
        assert!(ev.markdown.contains("### Video transcript (captions, timestamped)"));
        assert!(ev.markdown.contains("[00:02] first caption")); // round(1.5)=2
        assert!(ev.markdown.contains("- Zed (3👍): nice"));
        assert!(ev.markdown.contains("### Top comments"));
        // title+channel resolved ⇒ oEmbed NEVER fetched (net.calls empty):
        assert!(net.calls.lock().unwrap().is_empty());
        // <60 null guard is dead because the facts line is always present:
        assert!(ev.markdown.contains("Video ID:"));
    }

    #[tokio::test]
    async fn oembed_only_degradation_and_cache() {
        // NoInnerTube ⇒ oEmbed tier only (production shape). Unique video id.
        let net = ScriptedNet::default().with_url(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dfffffffffff&format=json",
            UrlFetchResult { status: 200, ok: true, text: r#"{"title":"oe Title","author_name":"oe Channel"}"#.into() },
        );
        let ev = get_youtube_evidence(&net, "https://www.youtube.com/watch?v=fffffffffff&list=x")
            .await
            .expect("evidence");
        assert_eq!(ev.title, "oe Title");
        assert_eq!(ev.channel, "oe Channel");
        assert_eq!(ev.length_seconds, 0.0);
        assert!(!ev.markdown.contains("Duration:"));
        assert!(ev
            .markdown
            .contains("No caption track and no comments available for this video"));
        // input URL had &list= junk ⇒ differs from canonical ⇒ Original link:
        assert!(ev.markdown.contains("Original link: https://www.youtube.com/watch?v=fffffffffff&list=x"));
        assert!(ev.markdown.contains("Watch URL: https://www.youtube.com/watch?v=fffffffffff"));
        // MEMOIZATION: second call hits the cache — oEmbed NOT re-fetched.
        let ev2 = get_youtube_evidence(&net, "https://www.youtube.com/watch?v=fffffffffff").await;
        assert_eq!(ev2.unwrap().title, "oe Title");
        assert_eq!(net.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn dead_video_negative_is_cached() {
        let net = ScriptedNet::default().with_url(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dggggggggggg&format=json",
            UrlFetchResult { status: 404, ok: false, text: String::new() },
        );
        assert!(get_youtube_evidence(&net, "https://youtu.be/ggggggggggg").await.is_none());
        assert!(get_youtube_evidence(&net, "https://youtu.be/ggggggggggg").await.is_none());
        // TTL hit returns the cached negative WITHOUT a second fetch:
        assert_eq!(net.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn inner_tube_info_without_basic_info() {
        // `bi = info?.basic_info ?? info ?? {}` — FLAT payload works; null
        // transcript/comments payloads behave like a youtubei.js throw
        // (catch ⇒ "" / []).
        let client = MockInnerTube::new(
            r#"{"title":"Flat Title","channel_name":"FlatChan","description":"plain desc","view_count":42}"#,
            "null",
            "null",
        );
        let net = ScriptedNet::default();
        let ev = get_youtube_evidence_with(&net, "https://youtu.be/hhhhhhhhhhh", &client)
            .await
            .expect("evidence");
        assert_eq!(ev.title, "Flat Title");
        assert_eq!(ev.channel, "FlatChan"); // channel_name branch
        assert_eq!(ev.view_count, 42.0);    // Number path (no comma strip)
        assert_eq!(ev.description, "plain desc");
        assert_eq!(ev.length_seconds, 0.0); // duration missing → NaN → 0
        assert!(ev.transcript.is_empty());
        assert!(ev.markdown.contains("No caption track and no comments"));
        // channel OBJECT with missing name ⇒ String(name ?? "") = "" ⇒ the
        // EMPTY channel still triggers oEmbed (title present) — quirk:
        let client2 = MockInnerTube::new(r#"{"title":"OT","channel":{}}"#, "null", "null");
        let net2 = ScriptedNet::default().with_url(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Diiiiiiiiiii&format=json",
            UrlFetchResult { status: 200, ok: true, text: r#"{"title":"X","author_name":"oe filled"}"#.into() },
        );
        let ev2 = get_youtube_evidence_with(&net2, "https://youtu.be/iiiiiiiiiii", &client2)
            .await
            .expect("evidence");
        assert_eq!(ev2.channel, "oe filled");
        assert_eq!(net2.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn companion_query_parity() {
        let base = YouTubeEvidence {
            video_id: "x".into(),
            canonical_url: "c".into(),
            title: "  My Title  ".into(),
            channel: "  ".into(),
            description: String::new(),
            length_seconds: 0.0,
            view_count: 0.0,
            publish_date: String::new(),
            chapters: vec![],
            transcript: String::new(),
            markdown: String::new(),
        };
        assert_eq!(you_tube_companion_query(&base).as_deref(), Some("\"My Title\" youtube"));
        let with_ch = YouTubeEvidence { channel: "Chan Name".into(), ..base.clone() };
        assert_eq!(
            you_tube_companion_query(&with_ch).as_deref(),
            Some("\"My Title\" \"Chan Name\"")
        );
        let empty = YouTubeEvidence { title: "   ".into(), ..base };
        assert_eq!(you_tube_companion_query(&empty), None);
        let long = YouTubeEvidence { title: "y".repeat(300), ..with_ch };
        assert_eq!(js_len(&you_tube_companion_query(&long).unwrap()), 200);
    }
}
