//! content_api.rs — Phase 15: the page-content surface (`tab_content_*`,
//! `tab_clipboard_*`, `tab_page_assets_*`, and the dev-log text
//! helpers).
//!
//! Every capability here runs INSIDE the tab through `Runtime.evaluate`
//! and round-trips plain JSON: the Rust side never touches the page's
//! bytes, only relays strings the page itself produced. That keeps the
//! security law intact — exported content, clipboard text, transcripts,
//! and asset bytes are PAGE DATA: evidence, never instructions, never
//! permission. There is deliberately no base64 crate in this workspace:
//! binary payloads become base64 inside the page (`btoa`, chunked), and
//! Rust moves the string.
//!
//! Honest-failure rule shared by every builder: when the page API
//! refuses (clipboard focus/permission, missing caption tracks, a
//! non-gsuite tab), the answer names what actually happened — never a
//! fabricated success shape.

use serde_json::{json, Value};
use url::Url;

use crate::cdp::CdpConn;
use crate::errors::BrowserError;
use crate::schemas::GsuiteDocType;

/// Evaluate `expression` in the tab's CDP session with the result
/// serialized back by value (promises awaited). A page-side throw
/// becomes a `CdpFailed` carrying the real exception description —
/// never a silently-empty JSON.
pub(crate) async fn eval_json(
    conn: &CdpConn,
    cdp_session_id: &str,
    expression: &str,
) -> Result<Value, BrowserError> {
    let res = conn
        .call(
            "Runtime.evaluate",
            Some(json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
            })),
            Some(cdp_session_id),
        )
        .await?;
    if let Some(exc) = res.get("exceptionDetails") {
        let reason = exc
            .pointer("/exception/description")
            .and_then(Value::as_str)
            .or_else(|| exc.pointer("/exception/value").and_then(Value::as_str))
            .or_else(|| exc.get("text").and_then(Value::as_str))
            .unwrap_or("page script raised an exception")
            .to_string();
        return Err(BrowserError::CdpFailed {
            method: "Runtime.evaluate".into(),
            reason,
        });
    }
    // `call` already stripped the outer result envelope; the evaluate
    // payload nests once more under /result/value.
    Ok(res.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

// ── Dev-log text helpers (shared with the engine pump mirror) ────────

/// CDP console call type → the four wire levels `tab_dev_logs`
/// filters on. `log`/`info`/`table`/`dir`/… all land on "info": the
/// mirror reports what a console showed, with the coarse level the
/// payload grammar can actually ask about.
pub(crate) fn console_level_of(cdp_type: &str) -> &'static str {
    match cdp_type {
        "error" | "assert" => "error",
        "warning" => "warning",
        "debug" | "trace" => "verbose",
        _ => "info",
    }
}

/// Flatten a `Runtime.consoleAPICalled` arg list into the single line
/// a developer would have read. Primitives render by value; objects
/// render their CDP-provided description (the console's own preview
/// text), never a raw RemoteObject tree.
pub(crate) fn console_args_text(args: Option<&Vec<Value>>) -> String {
    let Some(args) = args else {
        return String::new();
    };
    args.iter()
        .map(|a| {
            if let Some(v) = a.get("value") {
                if let Some(s) = v.as_str() {
                    return s.to_string();
                }
                if let Some(n) = v.as_i64() {
                    return n.to_string();
                }
                if let Some(n) = v.as_f64() {
                    return n.to_string();
                }
                if let Some(b) = v.as_bool() {
                    return b.to_string();
                }
                if v.is_null() {
                    return "null".to_string();
                }
            }
            match a.get("type").and_then(Value::as_str) {
                Some("null") => "null".to_string(),
                Some("undefined") => "undefined".to_string(),
                _ => a
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("<object>")
                    .to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── gsuite export plan (URL-level: where the export comes from) ──────

/// A resolved gsuite export: which kind doc, the exact export URL, and
/// the MIME Google serves for it. The fetch itself runs in-page (the
/// signed-in tab session carries the credentials), so Rust only ever
/// plans and relays.
#[derive(Debug)]
pub(crate) struct GsuitePlan {
    pub(crate) kind: &'static str,
    pub(crate) export_url: String,
    pub(crate) mime: &'static str,
}

/// Wire name of a payload doc-type (kept next to the availability
/// table so the two stay pinned).
fn doc_type_name(doc: GsuiteDocType) -> &'static str {
    match doc {
        GsuiteDocType::Pdf => "pdf",
        GsuiteDocType::Md => "md",
        GsuiteDocType::Xlsx => "xlsx",
        GsuiteDocType::Csv => "csv",
        GsuiteDocType::Docx => "docx",
        GsuiteDocType::Pptx => "pptx",
    }
}

/// Path/availability grammar for Google export URLs. Returns the
/// typed-error message (the executor tags it `PayloadInvalid`) when
/// the tab isn't a gsuite doc url or the requested type isn't
/// exported by that kind. `md` is in the payload enum (the reference
/// grammar) but no Google kind exports it — an honest refusal naming
/// what that kind CAN export, never a fabricated conversion.
pub(crate) fn gsuite_export_plan(url: &Url, doc: GsuiteDocType) -> Result<GsuitePlan, String> {
    if url.host_str() != Some("docs.google.com") {
        return Err(
            "tab is not on docs.google.com: gsuite export only serves Google \
             Docs/Sheets/Slides tabs"
                .into(),
        );
    }
    let segs: Vec<&str> = url
        .path_segments()
        .map(Iterator::collect)
        .unwrap_or_default();
    let kind = match segs.first().copied() {
        Some("document") => "document",
        Some("spreadsheets") => "spreadsheets",
        Some("presentation") => "presentation",
        _ => {
            return Err("url is not a /document|/spreadsheets|/presentation /d/<id> doc url".into())
        }
    };
    if segs.get(1).copied() != Some("d") {
        return Err("url is not a /document|/spreadsheets|/presentation /d/<id> doc url".into());
    }
    let got = doc_type_name(doc);
    let (allowed, ok_formats): (&str, &[&str]) = match kind {
        "document" => ("pdf/docx", &["pdf", "docx"]),
        "spreadsheets" => ("pdf/csv/xlsx", &["pdf", "csv", "xlsx"]),
        _ => ("pdf/pptx", &["pdf", "pptx"]),
    };
    if !ok_formats.contains(&got) {
        return Err(format!(
            "a {kind} exports as {allowed} only (requested type \"{got}\")"
        ));
    }
    let id = segs.get(2).copied().unwrap_or("");
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("could not read a document id from the url".into());
    }
    let mime = match got {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "csv" => "text/csv",
        _ => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    Ok(GsuitePlan {
        kind,
        export_url: format!("https://docs.google.com/{kind}/d/{id}/export?format={got}"),
        mime,
    })
}

// ── In-page JS builders (placeholders substituted with JSON) ─────────

/// `navigator.clipboard.readText()` with the honest failure branch —
/// a document without focus or a denied permission reads as an error,
/// never an empty-string success.
pub(crate) const CLIPBOARD_READ_JS: &str = r#"(async () => {
  try {
    const t = await navigator.clipboard.readText();
    return { ok: true, text: t };
  } catch (err) {
    return { ok: false, text: null, error: String((err && err.message) || err) };
  }
})()"#;

/// Clipboard WRITE: each entry is text or base64+mime. Binary entries
/// go through `ClipboardItem` exactly like a real paste source.
/// `items_json` is the payload's `items` array re-serialized — page
/// data in, JSON string out; the builder never interprets it.
pub(crate) fn clipboard_write_js(items_json: &str) -> String {
    r#"(async () => {
  const items = __ITEMS__;
  let written = 0;
  const failed = [];
  for (const item of items) {
    const entries = Array.isArray(item && item.entries) ? item.entries : [];
    for (const e of entries) {
      try {
        if (typeof e.text === 'string') {
          await navigator.clipboard.writeText(e.text);
          written++;
        } else if (typeof e.base64 === 'string' && typeof e.mime_type === 'string') {
          const bin = atob(e.base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: e.mime_type });
          await navigator.clipboard.write([new ClipboardItem({ [e.mime_type]: blob })]);
          written++;
        } else {
          failed.push({ reason: 'entry has neither text nor base64+mime_type' });
        }
      } catch (err) {
        failed.push({ reason: String((err && err.message) || err) });
      }
    }
  }
  return { ok: failed.length === 0, written, failed };
})()"#
        .replace("__ITEMS__", items_json)
}

/// Page content in the three recovered export formats. `html` is the
/// live outer HTML, `text` prefers the semantic article/main/body
/// innerText, and `domSnapshot` is a bounded indented structural walk
/// (the cheap read the reference product used for "what's on this
/// page" without shipping the whole DOM). All are capped at 200k
/// chars and say so via `truncated`.
pub(crate) fn content_extract_js(format: &str) -> String {
    r#"(() => {
  const CAP = 200000;
  const capStr = (s) => (s.length > CAP
    ? { content: s.slice(0, CAP), truncated: true }
    : { content: s, truncated: false });
  const fmt = "__FMT__";
  if (fmt === 'html') return capStr(document.documentElement.outerHTML);
  if (fmt === 'text') {
    const root = document.querySelector('article') || document.querySelector('main') || document.body;
    const t = root ? (root.innerText || root.textContent || '') : '';
    return capStr(t);
  }
  const lines = [];
  let nodes = 0;
  let walkTruncated = false;
  const walk = (n, depth) => {
    if (walkTruncated) return;
    if (n.nodeType === 3) {
      const t = (n.textContent || '').trim();
      if (t) lines.push('  '.repeat(depth) + t.slice(0, 160));
      return;
    }
    if (n.nodeType !== 1) return;
    nodes++;
    if (nodes > 4000 || depth > 30) { walkTruncated = true; return; }
    let label = n.tagName.toLowerCase();
    if (n.id) label += '#' + n.id;
    const cls = Array.from(n.classList).slice(0, 3);
    if (cls.length) label += '.' + cls.join('.');
    lines.push('  '.repeat(depth) + '<' + label + '>');
    for (const c of n.childNodes) walk(c, depth + 1);
  };
  walk(document.documentElement, 0);
  const r = capStr(lines.join('\n'));
  return { content: r.content, truncated: r.truncated || walkTruncated };
})()"#
        .replace("__FMT__", format)
}

/// The page's asset inventory: every referenced URL the static
/// markup exposes, resolved absolute and deduped. Reads the DOM, not
/// the network — same-source honesty as every other content read.
pub(crate) const ASSET_COLLECT_JS: &str = r#"(() => {
  const CAP = 500;
  const seen = new Set();
  const assets = [];
  let overflow = false;
  const add = (u, type) => {
    if (!u) return;
    let abs;
    try { abs = new URL(u, location.href).href; } catch (e) { return; }
    if (seen.has(abs)) return;
    if (seen.size >= CAP) { overflow = true; return; }
    seen.add(abs);
    assets.push({ url: abs, type });
  };
  document.querySelectorAll('img').forEach((el) => add(el.currentSrc || el.getAttribute('src'), 'image'));
  document.querySelectorAll('script[src]').forEach((el) => add(el.getAttribute('src'), 'script'));
  document.querySelectorAll('link[href]').forEach((el) => {
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    if (rel === 'stylesheet' || rel === 'icon' || rel === 'preload' || rel === 'manifest') {
      add(el.getAttribute('href'), rel);
    }
  });
  document.querySelectorAll('source[src]').forEach((el) => add(el.getAttribute('src'), 'media'));
  document.querySelectorAll('video[src], audio[src]').forEach((el) => add(el.getAttribute('src'), 'media'));
  return { assets, count: assets.length, truncated: overflow };
})()"#;

/// Bundle the listed assets: fetch each from INSIDE the tab (so the
/// page's own origin/credentials apply — same-origin reads, never a
/// Rust-side crawler), 512 KiB per asset, 4 MiB total, base64 in-page.
/// `assets_json` is the ASSET_COLLECT_JS answer re-serialized.
pub(crate) fn assets_bundle_js(assets_json: &str) -> String {
    r#"(async () => {
  const assets = __ASSETS__;
  const PER_CAP = 524288;
  const TOTAL_CAP = 4194304;
  const CH = 0x8000;
  const toB64 = async (blob) => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += CH) {
      s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    }
    return btoa(s);
  };
  let total = 0;
  let truncated = false;
  const out = [];
  for (const a of assets.slice(0, 80)) {
    try {
      const res = await fetch(a.url, { credentials: 'same-origin' });
      if (!res.ok) { out.push({ url: a.url, type: a.type, ok: false, error: 'HTTP ' + res.status }); continue; }
      let blob = await res.blob();
      let bytes = blob.size;
      if (bytes > PER_CAP) { blob = blob.slice(0, PER_CAP); bytes = PER_CAP; truncated = true; }
      if (total + bytes > TOTAL_CAP) { truncated = true; break; }
      total += bytes;
      out.push({ url: a.url, type: a.type, ok: true, mime: blob.type || 'application/octet-stream', bytes, base64: await toB64(blob) });
    } catch (err) {
      out.push({ url: a.url, type: a.type, ok: false, error: String((err && err.message) || err) });
    }
  }
  return { assets: out, total_bytes: total, truncated };
})()"#
        .replace("__ASSETS__", assets_json)
}

/// Fetch a planned gsuite export URL from inside the signed-in tab
/// (the session's cookies ride along), base64 in-page, capped at
/// 8 MiB. Non-2xx and oversize exports answer an honest error.
pub(crate) fn gsuite_fetch_js(export_url: &str) -> String {
    r#"(async (url) => {
  const MAX = 8388608;
  const CH = 0x8000;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const blob = await res.blob();
    if (blob.size > MAX) return { ok: false, error: 'export larger than 8 MiB' };
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += CH) {
      s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    }
    return { ok: true, bytes: blob.size, base64: btoa(s) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})("__URL__")"#
        .replace("__URL__", &json!(export_url).to_string())
}

/// YouTube transcript via the page's own caption track metadata
/// (`ytInitialPlayerResponse` → json3 caption fetch). No captions, a
/// failed fetch, or a non-YouTube tab all answer `ok:true` with a
/// null transcript plus a note — a missing transcript is a fact, not
/// a command failure.
pub(crate) const YT_TRANSCRIPT_JS: &str = r#"(async () => {
  const CAP = 100000;
  try {
    const pr = window.ytInitialPlayerResponse
      || (window.ytcfg && window.ytcfg.get && window.ytcfg.get('ytInitialPlayerResponse'));
    const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer
      && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!tracks || !tracks.length) {
      return { ok: true, transcript: null, language: null, lines: 0, truncated: false,
        note: 'this video exposes no caption tracks (or the player data has not loaded yet)' };
    }
    const t = tracks[0];
    let url = t.baseUrl;
    if (!/[?&]fmt=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'fmt=json3';
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      return { ok: true, transcript: null, language: t.languageCode || null, lines: 0, truncated: false,
        note: 'the caption track fetch failed: HTTP ' + res.status };
    }
    const j = await res.json();
    const lines = [];
    for (const ev of (j.events || [])) {
      const segs = ev.segs || [];
      const text = segs.map((s) => (s.Utf8 || '')).join('').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    }
    const transcript = lines.join('\n');
    return {
      ok: true,
      transcript: transcript.length > CAP ? transcript.slice(0, CAP) : transcript,
      truncated: transcript.length > CAP,
      language: t.languageCode || null,
      kind: t.kind || null,
      lines: lines.length,
    };
  } catch (err) {
    return { ok: true, transcript: null, language: null, lines: 0, truncated: false,
      note: 'transcript unavailable: ' + String((err && err.message) || err) };
  }
})()"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn url_of(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn console_levels_map_to_the_four_wire_names() {
        assert_eq!(console_level_of("error"), "error");
        assert_eq!(console_level_of("assert"), "error");
        assert_eq!(console_level_of("warning"), "warning");
        assert_eq!(console_level_of("debug"), "verbose");
        assert_eq!(console_level_of("trace"), "verbose");
        assert_eq!(console_level_of("log"), "info");
        assert_eq!(console_level_of("table"), "info");
    }

    #[test]
    fn console_args_flatten_like_a_developer_reads_them() {
        let args: Vec<Value> = serde_json::from_str(
            r#"[
              {"type":"string","value":"hello"},
              {"type":"number","value":42},
              {"type":"number","value":1.5},
              {"type":"boolean","value":true},
              {"type":"null"},
              {"type":"undefined"},
              {"type":"object","subtype":"array","description":"Array(3)"},
              {"type":"object"}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            console_args_text(Some(&args)),
            "hello 42 1.5 true null undefined Array(3) <object>"
        );
        assert_eq!(console_args_text(None), "");
        let empty: Vec<Value> = Vec::new();
        assert_eq!(console_args_text(Some(&empty)), "");
    }

    #[test]
    fn gsuite_plans_resolve_the_reference_export_urls() {
        let p = gsuite_export_plan(
            &url_of("https://docs.google.com/document/d/abc-1_2X/edit"),
            GsuiteDocType::Pdf,
        )
        .unwrap();
        assert_eq!(p.kind, "document");
        assert_eq!(
            p.export_url,
            "https://docs.google.com/document/d/abc-1_2X/export?format=pdf"
        );
        assert_eq!(p.mime, "application/pdf");

        let p = gsuite_export_plan(
            &url_of("https://docs.google.com/spreadsheets/d/id1/view"),
            GsuiteDocType::Csv,
        )
        .unwrap();
        assert_eq!(
            p.export_url,
            "https://docs.google.com/spreadsheets/d/id1/export?format=csv"
        );
        assert_eq!(p.mime, "text/csv");

        let p = gsuite_export_plan(
            &url_of("https://docs.google.com/presentation/d/id2"),
            GsuiteDocType::Pptx,
        )
        .unwrap();
        assert_eq!(
            p.export_url,
            "https://docs.google.com/presentation/d/id2/export?format=pptx"
        );
        assert_eq!(
            p.mime,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        );

        assert!(gsuite_export_plan(
            &url_of("https://docs.google.com/document/d/id3"),
            GsuiteDocType::Docx
        )
        .is_ok());
    }

    #[test]
    fn gsuite_refusals_name_what_actually_failed() {
        // `md` is in the payload grammar but no kind exports it.
        let e = gsuite_export_plan(
            &url_of("https://docs.google.com/document/d/id"),
            GsuiteDocType::Md,
        )
        .expect_err("docs never export md");
        assert!(e.contains("pdf/docx"), "got {e}");
        let e = gsuite_export_plan(
            &url_of("https://docs.google.com/document/d/id"),
            GsuiteDocType::Pptx,
        )
        .expect_err("docs never export pptx");
        assert!(e.contains("pdf/docx"), "got {e}");
        let e = gsuite_export_plan(
            &url_of("https://docs.example.com/document/d/id"),
            GsuiteDocType::Pdf,
        )
        .expect_err("lookalike host must refuse");
        assert!(e.contains("docs.google.com"), "got {e}");
        let e = gsuite_export_plan(
            &url_of("https://docs.google.com/forms/d/id"),
            GsuiteDocType::Pdf,
        )
        .expect_err("forms are not a doc kind");
        assert!(e.contains("/d/<id>"), "got {e}");
        let e = gsuite_export_plan(
            &url_of("https://docs.google.com/document/d/id%20bad"),
            GsuiteDocType::Pdf,
        )
        .expect_err("ids are [A-Za-z0-9-_] only");
        assert!(e.contains("document id"), "got {e}");
    }

    #[test]
    fn builders_substitute_fully_and_never_leave_a_placeholder() {
        let js = content_extract_js("text");
        assert!(js.contains("const fmt = \"text\""), "{js}");
        assert!(!js.contains("__FMT__"));
        let js = clipboard_write_js(r#"[{"entries":[{"text":"hi"}]}]"#);
        assert!(js.contains(r#"[{"entries":[{"text":"hi"}]}]"#));
        assert!(!js.contains("__ITEMS__"));
        let js = assets_bundle_js(r#"[{"url":"https://x.dev/a.png","type":"image"}]"#);
        assert!(js.contains("https://x.dev/a.png"));
        assert!(!js.contains("__ASSETS__"));
        let js = gsuite_fetch_js("https://docs.google.com/document/d/id/export?format=pdf");
        assert!(js.contains("https://docs.google.com/document/d/id/export?format=pdf"));
        assert!(!js.contains("__URL__"));
    }
}
