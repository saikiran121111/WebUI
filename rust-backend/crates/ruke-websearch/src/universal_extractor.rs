//! OWNER: W3 — parity port of `lib/web-search/universal-extractor.ts` (565 lines).
//!
//! PARITY notes — unavoidable Rust-vs-JS divergences (recorded, NOT fixed;
//! TS quirks are reproduced verbatim where the Rust runtime allows it):
//!
//! - **Mini-turndown**: the `turndown` npm package has no crates.io equivalent
//!   in the frozen manifest, so `turndown()` is re-implemented here directly
//!   from the internals of `turndown.cjs.js` (rules-array order,
//!   `collapseWhitespace`, `flankingWhitespace`/`edgeWhitespace` computed on
//!   `textContent`, `join()` newline math, `cleanAttribute`,
//!   `escapeLinkDestination`/`escapeLinkTitle`, the `markdownEscapes` reduce
//!   order, `isBlank`/`meaningfulWhenBlank`, setext headings, and the custom
//!   `code` + `table` rules). Under the default options the stock
//!   `indentedCodeBlock`, `fencedCodeBlock`, and `referenceLink` rules never
//!   fire; only reachable rules are ported.
//! - **No Readability**: `@mozilla/readability` is not ported, so the
//!   `extractArticle` Readability branch (and its `content.length >= 400`
//!   gate) always behaves like its `catch` path: Mode A ALWAYS runs
//!   `domTextFallback`. `tokio::task::yield_now()` models the dynamic-import
//!   seam. The TS async twins `extractStructural`/`extractDocs` are dead in TS
//!   (the exported entries call only the `*Sync` variants) and are not ported.
//! - **No unpdf**: `extractPdf` can never succeed here, so it always returns
//!   the TS catch string `"(PDF text extraction failed)\n" + html.slice(0,
//!   5000)` (UTF-16-unit slice). `PDF_OUTPUT_CAP` and the `pLimit(1)`
//!   singleton are unreachable in the Rust build and are not modeled.
//! - **scraper/html5ever vs linkedom `parseHTML`**: `Html::parse_document`
//!   never fails and the stripped-subtree set is skipped while building the
//!   arena, so the TS double round-trip `body.innerHTML` → re-parse inside
//!   `"<html><body>" + text + "</body></html>"` is NOT reproduced. The node
//!   sets are equivalent (turndown wraps its input in a synthetic
//!   `<x-turndown>` root, and html5ever drops re-parsed `<html>`/`<body>`
//!   tokens the same way, so the arena root stands in for the wrapper).
//! - Because parse/turndown never throw in Rust, EVERY TS `catch` fallback is
//!   unreachable (`domTextFallback`, `extractStructuralSync` outer/inner,
//!   `extractDocsSync`, `htmlTableToMarkdown`, the `linkedom` guard
//!   `body ? body.innerHTML : …` — html5ever always produces `<body>`); they
//!   are documented here, not implemented (same precedent as `engines.rs`).
//!   The JSON `catch` (`return html` on invalid JSON) IS reachable and ported.
//! - JS `\s` matches White_Space ∪ {U+FEFF} minus {U+0085}; Rust `\s` matches
//!   White_Space including U+0085 and excluding U+FEFF. The plain Unicode `\s`
//!   is kept everywhere and this U+0085/U+FEFF divergence is recorded once.
//!   JS `/m` line ends include `\r`; Rust `(?m)^`/`$` only anchor at `\n`
//!   (affects blockquote `> ` insertion and the `tableCount` line regex for
//!   markdown containing `\r` inside preserved `<pre>` content).
//! - `Number(start)` (the `<ol start>` attr) is ported for the common forms
//!   (decimal with optional sign/`.`/exponent, hex `0x`, exact `Infinity`);
//!   exotic JS literals may display `NaN.` differently.
//! - JSON pretty-print (`serde_json`, `preserve_order` workspace-wide): key
//!   order and duplicate-key semantics (first position, last value) match
//!   `JSON.parse` + `JSON.stringify(_, null, 2)`, but float re-rendering
//!   differs from JS (`1.0` stays `1.0`, `1e21` vs JS `1e+21`), and JS
//!   parses `1e400` as `Infinity` (stringifies as `null`) while serde errors
//!   out — the Rust port then returns the RAW body (the reachable `catch`).
//! - `to_ascii_uppercase` tags vs DOM `nodeName` uppercasing (SVG camelCase
//!   foreign-content names are lowercased by the HTML parser in both stacks).

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;

// Re-export for callers that need the charset normalizer directly (TS line
// 564: `export { detectCharset, normalizeBody } from "./charset-normalizer"`).
pub use crate::charset_normalizer::{detect_charset, normalize_body};

/* ── shared regex accessors (house OnceLock style, cf. engines.rs) ─── */

fn re_qhash() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[?#]").unwrap())
}
fn re_tag_pre() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)<pre[^>]*>").unwrap())
}
fn re_tag_code() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)<code[^>]*>").unwrap())
}
fn re_tag_table() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)<table[^>]*>").unwrap())
}
fn re_tag_section() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)<section[^>]*>").unwrap())
}
fn re_tag_dl() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)<dl[^>]*>").unwrap())
}
fn re_card() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"(?i)class="[^"]*card[^"]*""#).unwrap())
}
fn re_tag_p() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)<p[^>]*>").unwrap())
}
fn re_callout() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)warning|caution|note|tip|danger|important").unwrap())
}
fn re_n3() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\n{3,}").unwrap())
}
fn re_table_line() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?m)^\|.*\|$").unwrap())
}
fn re_fence() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new("```").unwrap())
}
fn re_ascii_ws() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[ \r\n\t]+").unwrap())
}
fn re_inline_nl() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\r?\n|\r").unwrap())
}
/// turndown's inline-code `extraSpace` test: `` /^`|^ .*?[^ ].* $|`$/ ``
fn re_code_extra() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\A`|\A .*?[^ ].* \z|`\z").unwrap())
}
fn re_bt_run() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"`+").unwrap())
}
fn re_ws_u() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\s+").unwrap())
}
fn re_crlf() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\r?\n").unwrap())
}
fn re_nl_ws_run() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(\n+\s*)+").unwrap())
}

/* ── JS UTF-16 / whitespace semantics helpers ─────────────────────── */

/// JS `\s` membership: Unicode White_Space minus U+0085, plus U+FEFF.
fn is_js_ws(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

/// JS `String.prototype.trim` under the JS `\s` set.
fn js_trim(s: &str) -> &str {
    let start = s
        .char_indices()
        .find(|(_, c)| !is_js_ws(*c))
        .map_or(s.len(), |(i, _)| i);
    let end = s
        .char_indices()
        .rev()
        .find(|(_, c)| !is_js_ws(*c))
        .map_or(0, |(i, c)| i + c.len_utf8());
    &s[start.min(end)..end]
}

/// JS `.length` — UTF-16 code units.
fn js_len(s: &str) -> usize {
    s.chars().map(|c| if c.len_utf8() == 4 { 2 } else { 1 }).sum()
}

/// JS `s.slice(0, max_units)` on UTF-16 code units.
fn js_slice_max(s: &str, max_units: usize) -> &str {
    let mut units = 0usize;
    let mut idx = 0usize;
    for (i, c) in s.char_indices() {
        let u = if c.len_utf8() == 4 { 2 } else { 1 };
        if units + u > max_units {
            break;
        }
        units += u;
        idx = i + c.len_utf8();
    }
    &s[..idx]
}

fn trim_leading_newlines(s: &str) -> &str {
    let start = s.as_bytes().iter().take_while(|b| **b == b'\n').count();
    &s[start..]
}

fn trim_trailing_newlines(s: &str) -> &str {
    let end = s.len() - s.as_bytes().iter().rev().take_while(|b| **b == b'\n').count();
    &s[..end]
}

fn trim_newlines(s: &str) -> String {
    trim_trailing_newlines(trim_leading_newlines(s)).to_string()
}

// ─────────────────────────────────────────────────────────────────────
// TS lines 90–173: mode detection
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtractionMode {
    Article,
    Structural,
    Docs,
    Document,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeDetection {
    pub mode: ExtractionMode,
    /// Why this mode was chosen (for the stress-test report).
    pub reason: String,
}

/// TS `url.split(/[?#]/)[0].toLowerCase().split(".").pop() ?? ""` — quirk: a
/// path with no dot yields the WHOLE remainder as the "extension".
fn url_ext(url: &str) -> String {
    let base = re_qhash().split(url).next().unwrap_or("");
    base.to_lowercase().rsplit('.').next().unwrap_or("").to_string()
}

fn tag_count(re: &Regex, html: &str) -> usize {
    re.find_iter(html).count()
}

/// Pick the extraction mode from the page's HTML structure (TS `detectMode`).
/// Quirks kept: `<dl[^>]*>` also matches `<dlink>`, `<p[^>]*>` also matches
/// `<pre>`, the callout test only sees the first 4000 UTF-16 units, and the
/// card regex is double-quote-only.
pub fn detect_mode(html: &str, content_type: &str, url: &str) -> ModeDetection {
    let ct = content_type.to_lowercase();
    let ext = url_ext(url);
    if ct.contains("application/pdf") || ext == "pdf" {
        return ModeDetection {
            mode: ExtractionMode::Document,
            reason: "PDF (content-type or .pdf)".to_string(),
        };
    }
    if ct.contains("text/csv")
        || ct.contains("text/tab-separated")
        || ext == "csv"
        || ext == "tsv"
    {
        return ModeDetection {
            mode: ExtractionMode::Document,
            reason: "CSV/TSV (content-type or .csv/.tsv)".to_string(),
        };
    }
    if ct.contains("application/json") || ext == "json" {
        return ModeDetection {
            mode: ExtractionMode::Document,
            reason: "JSON (content-type or .json)".to_string(),
        };
    }
    if ct.contains("text/markdown") || ext == "md" || ext == "markdown" {
        return ModeDetection {
            mode: ExtractionMode::Document,
            reason: "Markdown (content-type or .md)".to_string(),
        };
    }
    if ct.contains("application/xml") || ct.contains("text/xml") {
        return ModeDetection {
            mode: ExtractionMode::Document,
            reason: "XML (content-type)".to_string(),
        };
    }

    // Not HTML at this point — the caller should have already routed to
    // document mode. Fall through to DOM modes for HTML.
    if !ct.contains("html") && !ct.contains("xhtml") {
        return ModeDetection {
            mode: ExtractionMode::Document,
            reason: "non-HTML content-type".to_string(),
        };
    }

    // Mode C — technical docs (lots of <pre><code> blocks)
    let pre_count = tag_count(re_tag_pre(), html);
    let code_count = tag_count(re_tag_code(), html);
    let has_callout = re_callout().is_match(js_slice_max(html, 4000));
    if pre_count + code_count > 15 && has_callout {
        return ModeDetection {
            mode: ExtractionMode::Docs,
            reason: "high <pre>/<code> density + callouts".to_string(),
        };
    }

    // Mode B — structural (tables, sections, dl, cards)
    let table_count = tag_count(re_tag_table(), html);
    let section_count = tag_count(re_tag_section(), html);
    let dl_count = tag_count(re_tag_dl(), html);
    let card_count = tag_count(re_card(), html);
    if table_count + section_count + dl_count + card_count > 4 {
        return ModeDetection {
            mode: ExtractionMode::Structural,
            reason: format!(
                "tables={table_count} sections={section_count} dl={dl_count} cards={card_count}"
            ),
        };
    }

    // Mode A — article (default: long-form prose)
    let para_count = tag_count(re_tag_p(), html);
    ModeDetection {
        mode: ExtractionMode::Article,
        reason: format!("low structural density, {para_count} paragraphs"),
    }
}

// ─────────────────────────────────────────────────────────────────────
// Mini-turndown internals (ported from `turndown.cjs.js` — rules-array
// order, collapseWhitespace, flankingWhitespace/edgeWhitespace, join,
// markdownEscapes, and the two TS-registered custom rules).
// ─────────────────────────────────────────────────────────────────────

/// `blockElements` (verbatim list; NOTE: includes PRE/HR/HTML; excludes
/// svg/script/style as inline).
const BLOCK_TAGS: &[&str] = &[
    "ADDRESS", "ARTICLE", "ASIDE", "AUDIO", "BLOCKQUOTE", "BODY", "CANVAS", "CENTER", "DD",
    "DIR", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "FRAMESET",
    "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "HTML", "ISINDEX", "LI",
    "MAIN", "MENU", "NAV", "NOFRAMES", "NOSCRIPT", "OL", "OUTPUT", "P", "PRE", "SECTION",
    "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
];
/// `voidElements`.
const VOID_TAGS: &[&str] = &[
    "AREA", "BASE", "BR", "COL", "COMMAND", "EMBED", "HR", "IMG", "INPUT", "KEYGEN", "LINK",
    "META", "PARAM", "SOURCE", "TRACK", "WBR",
];
/// `meaningfulWhenBlankElements`.
const MEANINGFUL_WHEN_BLANK_TAGS: &[&str] = &[
    "A", "TABLE", "THEAD", "TBODY", "TFOOT", "TH", "TD", "IFRAME", "SCRIPT", "AUDIO", "VIDEO",
];

fn is_block_tag(tag: &str) -> bool {
    BLOCK_TAGS.contains(&tag)
}
fn is_void_tag(tag: &str) -> bool {
    VOID_TAGS.contains(&tag)
}
fn is_meaningful_blank_tag(tag: &str) -> bool {
    MEANINGFUL_WHEN_BLANK_TAGS.contains(&tag)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Element,
    Comment,
}

#[derive(Debug)]
struct MNode {
    kind: Kind,
    /// Uppercased tagName (DOM `nodeName` parity).
    tag: String,
    attrs: Vec<(String, String)>,
    children: Vec<usize>,
    parent: Option<usize>,
    /// Text/comment data (Kind::Text / Kind::Comment).
    data: String,
    /// DOM removal (collapseWhitespace / stripped subtrees).
    removed: bool,
}

/// Arena DOM rooted at a synthetic node standing in for turndown's
/// `<x-turndown id="turndown-root">` wrapper (neither isBlock nor isVoid).
#[derive(Debug)]
struct Mini {
    nodes: Vec<MNode>,
    root: usize,
}

impl Mini {
    fn new() -> Self {
        let root = MNode {
            kind: Kind::Element,
            tag: "X-TURNDOWN".to_string(),
            attrs: Vec::new(),
            children: Vec::new(),
            parent: None,
            data: String::new(),
            removed: false,
        };
        Mini { nodes: vec![root], root: 0 }
    }

    fn push(&mut self, n: MNode) -> usize {
        self.nodes.push(n);
        self.nodes.len() - 1
    }

    /// Build the arena from `<body>`'s children, skipping every subtree that
    /// matched the TS `querySelectorAll(strip)` + `.remove()` pre-pass.
    fn build(&mut self, body: ElementRef<'_>, stripped: &[ElementRef<'_>]) {
        let r = self.root;
        let mut stack: Vec<_> = body.children().rev().map(|c| (c, r)).collect();
        while let Some((node, parent)) = stack.pop() {
            if let Some(er) = ElementRef::wrap(node) {
                if stripped.contains(&er) {
                    continue;
                }
                let el = er.value();
                let tag = el.name().to_ascii_uppercase();
                let attrs: Vec<(String, String)> =
                    el.attrs().map(|(k, v)| (k.to_string(), v.to_string())).collect();
                let idx = self.push(MNode {
                    kind: Kind::Element,
                    tag,
                    attrs,
                    children: Vec::new(),
                    parent: Some(parent),
                    data: String::new(),
                    removed: false,
                });
                self.nodes[parent].children.push(idx);
                for c in node.children().rev() {
                    stack.push((c, idx));
                }
            } else {
                let child = match node.value() {
                    Node::Text(t) => Some(MNode {
                        kind: Kind::Text,
                        tag: String::new(),
                        attrs: Vec::new(),
                        children: Vec::new(),
                        parent: Some(parent),
                        data: t.text.to_string(),
                        removed: false,
                    }),
                    Node::Comment(c) => Some(MNode {
                        kind: Kind::Comment,
                        tag: String::new(),
                        attrs: Vec::new(),
                        children: Vec::new(),
                        parent: Some(parent),
                        data: c.comment.to_string(),
                        removed: false,
                    }),
                    // Doctype/Fragment: collapseWhitespace removes those node
                    // types from the DOM before processing and the built-in
                    // `process` emits '' for them — omission is output-
                    // equivalent.
                    _ => None,
                };
                if let Some(child) = child {
                    let idx = self.push(child);
                    self.nodes[parent].children.push(idx);
                }
            }
        }
    }

    // ── live (post-removal) tree views ──────────────────────────────

    fn live_children(&self, i: usize) -> Vec<usize> {
        self.nodes[i]
            .children
            .iter()
            .copied()
            .filter(|c| !self.nodes[*c].removed)
            .collect()
    }

    fn first_child(&self, i: usize) -> Option<usize> {
        self.nodes[i].children.iter().copied().find(|c| !self.nodes[*c].removed)
    }

    fn next_sibling(&self, i: usize) -> Option<usize> {
        let p = self.nodes[i].parent?;
        let pos = self.nodes[p].children.iter().position(|c| *c == i)?;
        self.nodes[p].children[pos + 1..]
            .iter()
            .copied()
            .find(|c| !self.nodes[*c].removed)
    }

    fn prev_sibling(&self, i: usize) -> Option<usize> {
        let p = self.nodes[i].parent?;
        let pos = self.nodes[p].children.iter().position(|c| *c == i)?;
        if pos == 0 {
            return None;
        }
        self.nodes[p].children[..pos]
            .iter()
            .copied()
            .rev()
            .find(|c| !self.nodes[*c].removed)
    }

    /// `lastElementChild` (live element children only).
    fn last_element_child(&self, i: usize) -> Option<usize> {
        self.nodes[i]
            .children
            .iter()
            .copied()
            .rev()
            .find(|c| !self.nodes[*c].removed && self.nodes[*c].kind == Kind::Element)
    }

    /// `Array.prototype.indexOf.call(parent.children, node)` — live element
    /// children only, 0-based.
    fn element_index(&self, i: usize, parent: usize) -> usize {
        self.nodes[parent]
            .children
            .iter()
            .copied()
            .filter(|c| !self.nodes[*c].removed && self.nodes[*c].kind == Kind::Element)
            .position(|c| c == i)
            .unwrap_or(0)
    }

    fn parent_tag(&self, i: usize) -> Option<&str> {
        self.nodes[i].parent.map(|p| self.nodes[p].tag.as_str())
    }

    fn attr(&self, i: usize, name: &str) -> Option<&str> {
        self.nodes[i].attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn is_pre(&self, i: usize) -> bool {
        self.nodes[i].tag == "PRE"
    }

    /// turndown `next(prev, current, isPre)`.
    fn walk_next(&self, prev: Option<usize>, current: usize) -> Option<usize> {
        let prev_is_child_of_current = match prev {
            Some(p) => self.nodes[p].parent == Some(current),
            None => false,
        };
        if prev_is_child_of_current || self.is_pre(current) {
            self.next_sibling(current).or(self.nodes[current].parent)
        } else {
            self.first_child(current)
                .or_else(|| self.next_sibling(current))
                .or_else(|| self.nodes[current].parent)
        }
    }

    /// turndown `remove(node)` — successor computed BEFORE unlinking.
    fn remove_and_successor(&mut self, i: usize) -> Option<usize> {
        let s = self.next_sibling(i).or(self.nodes[i].parent);
        self.nodes[i].removed = true;
        s
    }

    /// JS `prevText.data.replace(/ $/, '')` — removes ONE trailing space.
    fn strip_one_trailing_space(&mut self, i: usize) {
        if self.nodes[i].data.ends_with(' ') {
            let end = self.nodes[i].data.len() - 1;
            self.nodes[i].data.truncate(end);
        }
    }

    /// `collapseWhitespace` (adapted from collapse-whitespace). Quirks kept:
    /// block/BR strips ONE trailing space from prevText but never removes an
    /// emptied prevText mid-loop (only the post-loop tail removal does);
    /// comments/other node types are removed outright; void/PRE set
    /// `keepLeadingWs = true`.
    fn collapse(&mut self) {
        let root = self.root;
        if self.first_child(root).is_none() {
            return;
        }
        let mut prev_text: Option<usize> = None;
        let mut keep_leading_ws = false;
        let mut prev: Option<usize> = None;
        let mut node = self.walk_next(None, root);
        while let Some(cur) = node {
            if cur == root {
                break;
            }
            let kind = self.nodes[cur].kind;
            match kind {
                Kind::Text => {
                    let mut t = re_ascii_ws().replace_all(&self.nodes[cur].data, " ").into_owned();
                    let prev_ok = match prev_text {
                        Some(p) => self.nodes[p].data.ends_with(' '),
                        None => true,
                    };
                    if prev_ok && !keep_leading_ws && t.starts_with(' ') {
                        t.remove(0);
                    }
                    if t.is_empty() {
                        node = self.remove_and_successor(cur);
                        continue;
                    }
                    self.nodes[cur].data = t;
                    prev_text = Some(cur);
                }
                Kind::Element => {
                    let tag = self.nodes[cur].tag.as_str();
                    if is_block_tag(tag) || tag == "BR" {
                        if let Some(pt) = prev_text {
                            self.strip_one_trailing_space(pt);
                        }
                        prev_text = None;
                        keep_leading_ws = false;
                    } else if is_void_tag(tag) || self.is_pre(cur) {
                        prev_text = None;
                        keep_leading_ws = true;
                    } else if prev_text.is_some() {
                        keep_leading_ws = false;
                    }
                }
                Kind::Comment => {
                    node = self.remove_and_successor(cur);
                    continue;
                }
            }
            // JS order matters: `var nextNode = next(prev, node); prev = node;
            // node = nextNode` — the successor is computed with the OLD prev
            // (the node visited before `cur`), then prev advances. Computing
            // walk_next with `prev = cur` first re-descends every element and
            // never terminates.
            let next_node = self.walk_next(prev, cur);
            prev = Some(cur);
            node = next_node;
        }
        if let Some(pt) = prev_text {
            self.strip_one_trailing_space(pt);
            if self.nodes[pt].data.is_empty() {
                self.nodes[pt].removed = true;
            }
        }
    }

    /// `textContent` — live text descendants only (comments excluded, per DOM).
    fn text_content(&self, i: usize) -> String {
        let mut out = String::new();
        self.collect_text(i, &mut out);
        out
    }

    fn collect_text(&self, i: usize, out: &mut String) {
        match self.nodes[i].kind {
            Kind::Text => out.push_str(&self.nodes[i].data),
            Kind::Element => {
                for c in self.nodes[i].children.iter().copied() {
                    if !self.nodes[c].removed {
                        self.collect_text(c, out);
                    }
                }
            }
            Kind::Comment => {}
        }
    }

    /// `querySelectorAll(...)`-style descendant collection, document order.
    fn collect_desc_tags(&self, i: usize, tags: &[&str], out: &mut Vec<usize>) {
        for c in self.nodes[i].children.iter().copied() {
            if self.nodes[c].removed || self.nodes[c].kind != Kind::Element {
                continue;
            }
            if tags.contains(&self.nodes[c].tag.as_str()) {
                out.push(c);
            }
            self.collect_desc_tags(c, tags, out);
        }
    }

    /// `querySelector(tag)`-style first descendant in document order.
    fn first_desc_with_tag(&self, i: usize, tag: &str) -> Option<usize> {
        for c in self.nodes[i].children.iter().copied() {
            if self.nodes[c].removed || self.nodes[c].kind != Kind::Element {
                continue;
            }
            if self.nodes[c].tag == tag {
                return Some(c);
            }
            if let Some(d) = self.first_desc_with_tag(c, tag) {
                return Some(d);
            }
        }
        None
    }

    /// `has(node, elements)` — any matching DESCENDANT.
    fn has_desc_tagset(&self, i: usize, set: &[&str]) -> bool {
        self.nodes[i].children.iter().copied().any(|c| {
            if self.nodes[c].removed || self.nodes[c].kind != Kind::Element {
                return false;
            }
            set.contains(&self.nodes[c].tag.as_str()) || self.has_desc_tagset(c, set)
        })
    }

    /// `isBlank(node)`.
    fn is_blank(&self, i: usize) -> bool {
        let tag = self.nodes[i].tag.as_str();
        if is_void_tag(tag) || is_meaningful_blank_tag(tag) {
            return false;
        }
        let t = self.text_content(i);
        if !t.chars().all(is_js_ws) {
            return false;
        }
        !self.has_desc_tagset(i, VOID_TAGS) && !self.has_desc_tagset(i, MEANINGFUL_WHEN_BLANK_TAGS)
    }
}

/// `edgeWhitespace` groups. All-whitespace strings: leading = WHOLE string,
/// trailing = "" (regex group semantics; kept verbatim).
#[derive(Debug)]
struct Edges {
    leading: String,
    leading_non_ascii: String,
    trailing: String,
    trailing_non_ascii: String,
    leading_ascii: bool,
    trailing_ascii: bool,
}

fn ascii_ws_run_prefix(s: &str) -> usize {
    s.bytes().take_while(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n')).count()
}

/// Port of `/^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$/`
/// decomposition (groups 1/2/3/4/5/6 → leading/leadingAscii/leadingNonAscii/
/// trailing/trailingNonAscii/trailingAscii; the crate regex is not needed —
/// the semantics are maximal leading/trailing whitespace regions).
fn edge_ws(s: &str) -> Edges {
    if !s.is_empty() && s.chars().all(is_js_ws) {
        let la = ascii_ws_run_prefix(s);
        return Edges {
            leading: s.to_string(),
            leading_non_ascii: s[la..].to_string(),
            trailing: String::new(),
            trailing_non_ascii: String::new(),
            leading_ascii: la > 0,
            trailing_ascii: false,
        };
    }
    let start = s.char_indices().find(|(_, c)| !is_js_ws(*c)).map_or(0, |(i, _)| i);
    let end = s
        .char_indices()
        .rev()
        .find(|(_, c)| !is_js_ws(*c))
        .map_or(0, |(i, c)| i + c.len_utf8());
    // Whitespace-only handled above; here start < end (there is a non-ws char).
    let leading = &s[..start];
    let trailing = &s[end..];
    let la = ascii_ws_run_prefix(leading);
    let ta = trailing.bytes().rev().take_while(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n')).count();
    Edges {
        leading: leading.to_string(),
        leading_non_ascii: leading[la..].to_string(),
        trailing: trailing.to_string(),
        trailing_non_ascii: trailing[..trailing.len() - ta].to_string(),
        leading_ascii: la > 0,
        trailing_ascii: ta > 0,
    }
}

impl Mini {
    /// `flankingWhitespace(node)` (options.preformattedCode is false, so the
    /// CODE exemption never applies). Computed on `textContent` like the JS.
    fn flanking(&self, i: usize) -> (String, String) {
        let tag = self.nodes[i].tag.as_str();
        if is_block_tag(tag) {
            return (String::new(), String::new());
        }
        let tc = self.text_content(i);
        let edges = edge_ws(&tc);
        let leading = if edges.leading_ascii && self.flanked(i, true) {
            edges.leading_non_ascii
        } else {
            edges.leading
        };
        let trailing = if edges.trailing_ascii && self.flanked(i, false) {
            edges.trailing_non_ascii
        } else {
            edges.trailing
        };
        (leading, trailing)
    }

    /// `isFlankedByWhitespace(side, node)` — text siblings test the ASCII
    /// space regex only; non-block elements test their textContent; comment
    /// or missing siblings are false.
    fn flanked(&self, i: usize, left: bool) -> bool {
        let Some(sib) = (if left { self.prev_sibling(i) } else { self.next_sibling(i) }) else {
            return false;
        };
        match self.nodes[sib].kind {
            Kind::Text => {
                let d = &self.nodes[sib].data;
                if left {
                    d.ends_with(' ')
                } else {
                    d.starts_with(' ')
                }
            }
            Kind::Element => {
                if is_block_tag(&self.nodes[sib].tag) {
                    false
                } else {
                    let tc = self.text_content(sib);
                    if left {
                        tc.ends_with(' ')
                    } else {
                        tc.starts_with(' ')
                    }
                }
            }
            Kind::Comment => false,
        }
    }

    /// `process(parent)` — escapes are applied to text nodes UNLESS any
    /// ancestor chain node is CODE (the DOM wrapper's `isCode` flag).
    fn process(&self, parent: usize, parent_is_code: bool) -> String {
        let mut out = String::new();
        for c in self.live_children(parent) {
            let replacement = match self.nodes[c].kind {
                Kind::Text => {
                    if parent_is_code {
                        self.nodes[c].data.clone()
                    } else {
                        escape_markdown(&self.nodes[c].data)
                    }
                }
                Kind::Element => self.replacement(c, parent_is_code),
                Kind::Comment => String::new(),
            };
            out = join(&out, &replacement);
        }
        out
    }

    /// `replacementForNode(node)`.
    fn replacement(&self, i: usize, in_code: bool) -> String {
        let node_is_code = in_code || self.nodes[i].tag == "CODE";
        let content = self.process(i, node_is_code);
        let (leading, trailing) = self.flanking(i);
        let content = if !leading.is_empty() || !trailing.is_empty() {
            js_trim(&content).to_string()
        } else {
            content
        };
        format!("{leading}{}{trailing}", self.apply_rule(i, &content))
    }

    /// `Rules.forNode` order: blankRule FIRST, then the array — which is
    /// `[table, code]` (the two TS `addRule` unshifts) followed by the
    /// built-ins P, BR, H1-H6, BLOCKQUOTE, UL/OL, LI, indentedCodeBlock
    /// (shadowed by the TS code rule for every PRE/CODE-under-PRE node),
    /// fencedCodeBlock (`codeBlockStyle` default keeps it out), HR, A
    /// (linkStyle inlined + truthy href), referenceLink (never), EM/I,
    /// STRONG/B, CODE (only outside PRE), IMG — then `defaultRule`.
    fn apply_rule(&self, i: usize, content: &str) -> String {
        let tag = self.nodes[i].tag.as_str();
        if self.is_blank(i) {
            return if is_block_tag(tag) { "\n\n".to_string() } else { String::new() };
        }
        if tag == "TABLE" {
            return self.table_markdown(i);
        }
        if tag == "PRE" || (tag == "CODE" && self.parent_tag(i) == Some("PRE")) {
            let pre = if tag == "PRE" { i } else { self.nodes[i].parent.unwrap_or(i) };
            let lang = self
                .first_desc_with_tag(pre, "CODE")
                .and_then(|c| self.attr(c, "data-language"))
                .unwrap_or("")
                .to_string();
            return format!("\n```{lang}\n{content}\n```\n");
        }
        match tag {
            "P" => return format!("\n\n{content}\n\n"),
            "BR" => return "  \n".to_string(),
            "H1" | "H2" | "H3" | "H4" | "H5" | "H6" => return self.heading(tag, content),
            "BLOCKQUOTE" => {
                let t = trim_newlines(content);
                return format!("\n\n{}\n\n", prefix_each_line_gt(&t));
            }
            "UL" | "OL" => {
                let parent = self.nodes[i].parent.unwrap_or(self.root);
                if self.nodes[parent].tag == "LI" && self.last_element_child(parent) == Some(i) {
                    return format!("\n{content}");
                }
                return format!("\n\n{content}\n\n");
            }
            "LI" => return self.list_item(i, content),
            "HR" => return "\n\n* * *\n\n".to_string(),
            "A" => {
                if let Some(href) = self.attr(i, "href") {
                    if !href.is_empty() {
                        return self.inline_link(i, content, href);
                    }
                }
            }
            "EM" | "I" => {
                return if js_trim(content).is_empty() {
                    String::new()
                } else {
                    format!("_{content}_")
                };
            }
            "STRONG" | "B" => {
                return if js_trim(content).is_empty() {
                    String::new()
                } else {
                    format!("**{content}**")
                };
            }
            "CODE" => return inline_code(content),
            "IMG" => return self.image(i),
            _ => {}
        }
        if is_block_tag(tag) {
            format!("\n\n{content}\n\n")
        } else {
            content.to_string()
        }
    }

    /// `rules.heading` with the default `headingStyle: 'setext'`.
    fn heading(&self, tag: &str, content: &str) -> String {
        let level = (tag.as_bytes()[1] - b'0') as usize;
        if level < 3 {
            let marker = if level == 1 { '=' } else { '-' };
            let underline: String = std::iter::repeat_n(marker, js_len(content)).collect();
            format!("\n\n{content}\n{underline}\n\n")
        } else {
            format!("\n\n{} {content}\n\n", "#".repeat(level))
        }
    }

    /// `rules.inlineLink` (href already verified truthy by `apply_rule`).
    fn inline_link(&self, i: usize, content: &str, href: &str) -> String {
        let href = escape_link_destination(href);
        let title = escape_link_title(&clean_attribute(self.attr(i, "title")));
        let title_part = if title.is_empty() {
            String::new()
        } else {
            format!(" \"{title}\"")
        };
        format!("[{content}]({href}{title_part})")
    }

    /// `rules.listItem` — prefix is computed BEFORE the paragraph test;
    /// indent repeats the prefix LENGTH; tail is only `nextSibling`.
    fn list_item(&self, i: usize, content: &str) -> String {
        let parent = self.nodes[i].parent.unwrap_or(self.root);
        let prefix = if self.nodes[parent].tag == "OL" {
            let index = self.element_index(i, parent);
            let start = self.attr(parent, "start").unwrap_or("");
            if start.is_empty() {
                format!("{}.  ", index + 1)
            } else {
                match js_number(start) {
                    Some(n) => format!("{}.  ", js_num_to_string(n + index as f64)),
                    None => "NaN.  ".to_string(),
                }
            }
        } else {
            "*   ".to_string()
        };
        let is_paragraph = content.ends_with('\n');
        let mut c = trim_newlines(content);
        if is_paragraph {
            c.push('\n');
        }
        let pad = " ".repeat(prefix.chars().count());
        c = c.replace('\n', &format!("\n{pad}"));
        let tail = if self.next_sibling(i).is_some() { "\n" } else { "" };
        format!("{prefix}{c}{tail}")
    }

    /// `rules.image`.
    fn image(&self, i: usize) -> String {
        let alt = escape_markdown(&clean_attribute(self.attr(i, "alt")));
        let src = escape_link_destination(self.attr(i, "src").unwrap_or(""));
        let title = clean_attribute(self.attr(i, "title"));
        let title_part = if title.is_empty() {
            String::new()
        } else {
            format!(" \"{}\"", escape_link_title(&title))
        };
        if src.is_empty() {
            String::new()
        } else {
            format!("![{alt}]({src}{title_part})")
        }
    }

    /// The TS custom `table` rule → `htmlTableToMarkdown`. Quirks kept:
    /// `querySelectorAll` is DESCENDANT-scoped (nested tables leak inner
    /// `tr`/`td` into the outer grid), header row is `grid[0]` whatever it
    /// is, body cells are NOT pipe-escaped.
    fn table_markdown(&self, i: usize) -> String {
        let mut rows: Vec<usize> = Vec::new();
        self.collect_desc_tags(i, &["TR"], &mut rows);
        if rows.is_empty() {
            return String::new();
        }
        let mut grid: Vec<Vec<String>> = Vec::new();
        for row in &rows {
            let mut cells: Vec<usize> = Vec::new();
            self.collect_desc_tags(*row, &["TH", "TD"], &mut cells);
            if cells.is_empty() {
                continue;
            }
            let r: Vec<String> = cells
                .iter()
                .map(|c| {
                    let t = self.text_content(*c);
                    js_trim(&re_ws_u().replace_all(&t, " ")).to_string()
                })
                .collect();
            grid.push(r);
        }
        if grid.is_empty() {
            return String::new();
        }
        let col_count = grid.iter().map(|r| r.len()).max().unwrap_or(0);
        for r in grid.iter_mut() {
            while r.len() < col_count {
                r.push(String::new());
            }
        }
        let mut lines = Vec::with_capacity(grid.len());
        lines.push(format!("| {} |", grid[0].join(" | ")));
        lines.push(format!("| {} |", vec!["---"; col_count].join(" | ")));
        for r in grid.iter().skip(1) {
            lines.push(format!("| {} |", r.join(" | ")));
        }
        format!("\n{}\n", lines.join("\n"))
    }
}

/// `join(output, replacement)` — newline-count separator, no empty guards.
fn join(output: &str, replacement: &str) -> String {
    let s1 = trim_trailing_newlines(output);
    let s2 = trim_leading_newlines(replacement);
    let nls = (output.len() - s1.len()).max(replacement.len() - s2.len());
    let separator = &"\n\n"[..nls.min(2)];
    format!("{s1}{separator}{s2}")
}

/// `trimNewlines(content).replace(/^/gm, '> ')` — divergence: JS `/m` `^`
/// also follows `\r` (recorded in the module header).
fn prefix_each_line_gt(s: &str) -> String {
    s.split('\n').map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n")
}

/// `rules.code.replacement` (inline CODE outside PRE).
fn inline_code(content: &str) -> String {
    if content.is_empty() {
        return String::new();
    }
    let c = re_inline_nl().replace_all(content, " ").into_owned();
    let extra_space = if re_code_extra().is_match(&c) { " " } else { "" };
    let runs: HashSet<&str> = re_bt_run().find_iter(&c).map(|m| m.as_str()).collect();
    let mut delimiter = String::from("`");
    while runs.contains(delimiter.as_str()) {
        delimiter.push('`');
    }
    format!("{delimiter}{extra_space}{c}{extra_space}{delimiter}")
}

/// `markdownEscapes.reduce` chain — verbatim order and single-replacement
/// semantics (each rule runs once, in order, over the WHOLE string for the
/// /g rules and only at position 0 for the anchored ones).
fn escape_markdown(s: &str) -> String {
    let mut s = s.replace('\\', "\\\\").replace('*', "\\*");
    if s.starts_with('-') {
        s.insert(0, '\\');
    }
    if s.starts_with("+ ") {
        s.insert(0, '\\');
    }
    if s.starts_with('=') {
        s.insert(0, '\\');
    }
    let hashes = s.chars().take_while(|c| *c == '#').count().min(6);
    if hashes > 0 && s[hashes..].starts_with(' ') {
        s.insert(0, '\\');
    }
    s = s.replace('`', "\\`");
    if s.starts_with("~~~") {
        s.insert(0, '\\');
    }
    s = s.replace('[', "\\[").replace(']', "\\]");
    if s.starts_with('>') {
        s.insert(0, '\\');
    }
    s = s.replace('_', "\\_");
    let digits = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits > 0 && s[digits..].starts_with(". ") {
        s.insert(digits, '\\');
    }
    s
}

/// `escapeLinkDestination`: backslash-escape `<>()`, then wrap in `<>` iff
/// the result contains a space.
fn escape_link_destination(destination: &str) -> String {
    let mut escaped = String::new();
    for c in destination.chars() {
        if matches!(c, '<' | '>' | '(' | ')') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    if escaped.contains(' ') {
        format!("<{escaped}>")
    } else {
        escaped
    }
}

fn escape_link_title(title: &str) -> String {
    title.replace('"', "\\\"")
}

/// `cleanAttribute(attribute)` — falsy (null/empty) → "".
fn clean_attribute(attribute: Option<&str>) -> String {
    match attribute {
        Some(v) if !v.is_empty() => re_nl_ws_run().replace_all(v, "\n").into_owned(),
        _ => String::new(),
    }
}

// ══ entry points: strip lists, sync twins, async document/article, ═════════
// ══ `structuralExtract` / `structuralExtractAsync`                     ══════

/// Verbatim `strip(...)` selector lists from each TS entry point. The comma
/// lists are valid CSS selector groups for `scraper`. `domTextFallback` uses
/// the article list; `extractDocs(Sync)` omits `header`; the structural list
/// adds `svg`. The TS async wrappers `extractStructural` / `extractDocs` are
/// unreachable from every TS export (`structuralExtract(Async)` routes to the
/// sync twins); Rust omits the dead wrappers — their bodies match the sync
/// twins below byte-for-byte minus the `await` surface.
const STRIP_STRUCTURAL: &str = "nav, footer, header, aside, script, style, noscript, iframe, svg";
const STRIP_DOCS: &str = "nav, footer, aside, script, style, noscript";
const STRIP_ARTICLE: &str = "nav, footer, header, aside, script, style, noscript, iframe";

/// `TurndownService.prototype.postProcess`: strip leading tab/CR/LF, then a
/// trailing whitespace run (JS `[\t\r\n\s]+$` set == `\s` set).
fn post_process(s: &str) -> String {
    let head = s.trim_start_matches(['\t', '\r', '\n']);
    let mut end = head.len();
    while end > 0 {
        let c = head[..end].chars().next_back().unwrap();
        if !is_js_ws(c) {
            break;
        }
        end -= c.len_utf8();
    }
    head[..end].to_string()
}

/// `md.replace(/\n{3,}/g, "\n\n").trim()` — the tail of every mode entry.
fn finish(md: &str) -> String {
    let collapsed = re_n3().replace_all(md, "\n\n");
    js_trim(&collapsed).to_string()
}

/// Parse `html`, remove every element matching `strip` (the TS `strip(sel)`
/// forEach + `el.remove()`), then run the mini-turndown over the `<body>`
/// subtree (turndown's root-node wrap ≡ `Mini::new`).
///
/// Parity notes (see the module header):
/// - TS serializes `body.innerHTML` and reparses it wrapped in
///   `<html><body>…</body></html>` before turndown; building the arena
///   directly from the body subtree is equivalent (no innerHTML round-trip).
/// - linkedom's `doc.body ? … : …` guard and the entries' `catch` fallbacks
///   (tag-strip collapse; 12,000-char slice) are unreachable here: html5ever
///   always emits a `<body>` and the mini-turndown cannot throw.
fn turndown_render(html: &str, strip: &str) -> String {
    let doc = Html::parse_document(html);
    let strip_sel = Selector::parse(strip).expect("static strip selector");
    let stripped: Vec<ElementRef<'_>> = doc.select(&strip_sel).collect();
    let body_sel = Selector::parse("body").expect("body selector");
    let body = doc
        .select(&body_sel)
        .next()
        .expect("html5ever always emits a <body>");
    let mut mini = Mini::new();
    mini.build(body, &stripped);
    mini.collapse();
    post_process(&mini.process(mini.root, false))
}

/// `domTextFallback` — the Mode-A article path (Readability is never present
/// in Rust, so `extractArticle` always lands here; see the header).
fn dom_text_fallback(html: &str) -> String {
    finish(&turndown_render(html, STRIP_ARTICLE))
}

fn extract_structural_sync(html: &str) -> String {
    finish(&turndown_render(html, STRIP_STRUCTURAL))
}

fn extract_docs_sync(html: &str) -> String {
    finish(&turndown_render(html, STRIP_DOCS))
}

fn extract_article_sync(html: &str) -> String {
    // TS body: `return domTextFallback(html);`
    dom_text_fallback(html)
}

/// `JSON.stringify(JSON.parse(html), null, 2)` inside a json fence, raw
/// `html` on parse failure (the `catch` stays reachable in Rust).
///
/// serde_json `preserve_order` matches JSON.parse key order (duplicates:
/// first position, last value). Divergences (header): `1e400` parses to JS
/// `Infinity` (stringifies as `null`) but errors in serde → raw passthrough;
/// integral floats print `1.0` (serde) vs `1` (JS).
fn json_to_markdown(html: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(html) {
        Ok(v) => match serde_json::to_string_pretty(&v) {
            Ok(pretty) => format!("```json\n{pretty}\n```"),
            Err(_) => html.to_string(),
        },
        Err(_) => html.to_string(),
    }
}

/// `csvToMarkdown`: header row kept RAW (the TS quirk — header cells are NOT
/// pipe-escaped or trimmed, body cells are both).
fn csv_to_markdown(csv: &str, is_tsv: bool) -> String {
    let rows: Vec<&str> = re_crlf()
        .split(csv)
        .filter(|r| !js_trim(r).is_empty())
        .collect();
    if rows.is_empty() {
        return "(empty CSV)".to_string();
    }
    let sep = if is_tsv { "\t" } else { "," };
    let mut grid: Vec<Vec<&str>> = rows.iter().map(|r| r.split(sep).collect()).collect();
    let col_count = grid.iter().map(|r| r.len()).max().unwrap_or(0);
    for r in grid.iter_mut() {
        while r.len() < col_count {
            r.push("");
        }
    }
    let mut out: Vec<String> = Vec::new();
    out.push(format!("| {} |", grid[0].join(" | ")));
    out.push(format!("| {} |", vec!["---"; col_count].join(" | ")));
    for r in grid.iter().skip(1) {
        let cells: Vec<String> = r
            .iter()
            .map(|c| js_trim(c).replace('|', "\\|"))
            .collect();
        out.push(format!("| {} |", cells.join(" | ")));
    }
    format!("## CSV/TSV data ({} rows)\n{}", rows.len(), out.join("\n"))
}

/// Sync document entry (`extractDocumentSync`): PDF becomes a sentinel
/// string. The TS sync markdown branch lacks the async branch's
/// `ct.includes("xml")` disjunct — an asymmetry in the source; both branches
/// return `html`, so it is unobservable. Reproduced verbatim.
pub fn extract_document_sync(html: &str, content_type: &str, url: &str) -> String {
    let ct = content_type.to_lowercase();
    let ext = url_ext(url);
    if ct.contains("application/pdf") || ext == "pdf" {
        return "(PDF requires structuralExtractAsync)".to_string();
    }
    if ct.contains("text/csv") || ct.contains("text/tab-separated") || ext == "csv" || ext == "tsv" {
        return csv_to_markdown(html, ext == "tsv" || ct.contains("tab-separated"));
    }
    if ct.contains("application/json") || ext == "json" {
        return json_to_markdown(html);
    }
    if ct.contains("text/markdown") || ext == "md" || ext == "markdown" {
        return html.to_string();
    }
    html.to_string()
}

/// `extractPdf`: unpdf has no Rust counterpart, so the TS `try` leg
/// (`"## PDF text extraction\n" + text.slice(0, PDF_OUTPUT_CAP)`) is
/// unreachable — extraction always fails and the catch string is the only
/// output (header divergence). The `yield_now` stands in for the TS dynamic
/// `import("unpdf")` / `pLimit(1)` serialization seam; the limiter singleton
/// and `PDF_OUTPUT_CAP` are unmodeled because the success leg never runs.
async fn extract_pdf(html: &str) -> String {
    tokio::task::yield_now().await;
    format!("(PDF text extraction failed)\n{}", js_slice_max(html, 5000))
}

/// Async document entry (`extractDocument`) — note the markdown branch here
/// DOES include `ct.includes("xml")` (unobservable pass-through either way).
async fn extract_document(html: &str, content_type: &str, url: &str) -> String {
    let ct = content_type.to_lowercase();
    let ext = url_ext(url);
    if ct.contains("application/pdf") || ext == "pdf" {
        return extract_pdf(html).await;
    }
    if ct.contains("text/csv") || ct.contains("text/tab-separated") || ext == "csv" || ext == "tsv" {
        return csv_to_markdown(html, ext == "tsv" || ct.contains("tab-separated"));
    }
    if ct.contains("application/json") || ext == "json" {
        return json_to_markdown(html);
    }
    if ct.contains("xml") || ext == "md" || ext == "markdown" || ct.contains("text/markdown") {
        return html.to_string();
    }
    html.to_string()
}

/// `extractArticle` — the `url` parameter is dead in the TS body (passed but
/// never read; kept for signature parity). Readability is never importable
/// here, so the `content.length >= 400` turndown leg is unreachable and the
/// function always returns `domTextFallback(html)` (header divergence).
async fn extract_article(html: &str, _url: &str) -> String {
    tokio::task::yield_now().await;
    dom_text_fallback(html)
}

/// JS `Number()` on the `<ol start>` attribute (`Number(start)` in
/// `rules.listItem`): empty → 0, `±Infinity` literals, signed hex via
/// `0x`/`0X`, decimal-literal gate, anything else NaN (`None`).
/// Divergence: hex beyond i64 range yields NaN here where JS gives a float.
fn js_number(s: &str) -> Option<f64> {
    let t = js_trim(s);
    if t.is_empty() {
        return Some(0.0);
    }
    if t == "Infinity" || t == "+Infinity" {
        return Some(f64::INFINITY);
    }
    if t == "-Infinity" {
        return Some(f64::NEG_INFINITY);
    }
    let (sign, rest) = if let Some(r) = t.strip_prefix('-') {
        (-1.0, r)
    } else if let Some(r) = t.strip_prefix('+') {
        (1.0, r)
    } else {
        (1.0, t)
    };
    if rest.starts_with("0x") || rest.starts_with("0X") {
        let v = i64::from_str_radix(&rest[2..], 16).ok()?;
        return Some(sign * v as f64);
    }
    if re_dec_literal().is_match(t) {
        return t.parse::<f64>().ok();
    }
    None
}

fn re_dec_literal() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?-u:\A[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\z)")
            .expect("static decimal-literal regex")
    })
}

/// `String(n)` for the `<ol>` prefix number: integral magnitudes below 1e15
/// print as integers (JS `Number.prototype.toString`); larger/integral
/// values fall through to Rust float formatting (JS exponent form differs —
/// unmodeled, same class as the header's JSON float note).
fn js_num_to_string(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        (n as i64).to_string()
    } else {
        n.to_string()
    }
}

/// `StructuredExtraction` — `tableCount`/`codeBlockCount` serialize as
/// `tableCount`/`codeBlockCount` (camelCase wire parity with the TS JSON).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredExtraction {
    pub markdown: String,
    pub mode: ExtractionMode,
    pub reason: String,
    pub table_count: usize,
    pub code_block_count: usize,
}

/// The TS count math: `(md.match(/^\|.*\|$/gm) ?? []).length` and
/// `Math.round(fences / 2)` — for an integer fence count JS rounds .5 up,
/// which is exactly `(fences + 1) / 2` in integer arithmetic.
fn markdown_counts(md: &str) -> (usize, usize) {
    let table_count = re_table_line().find_iter(md).count();
    let fences = re_fence().find_iter(md).count();
    (table_count, fences.div_ceil(2))
}

/// `structuralExtract` — sync entry. `default:` in the TS switch covers
/// `article` and any future mode.
pub fn structural_extract(html: &str, content_type: &str, url: &str) -> StructuredExtraction {
    let det = detect_mode(html, content_type, url);
    let md = match det.mode {
        // Document mode is async in TS (PDF/CSV/JSON); the sync entry
        // handles the synchronous cases (PDF → sentinel string).
        ExtractionMode::Document => extract_document_sync(html, content_type, url),
        ExtractionMode::Structural => extract_structural_sync(html),
        ExtractionMode::Docs => extract_docs_sync(html),
        _ => extract_article_sync(html),
    };
    let (table_count, code_block_count) = markdown_counts(&md);
    StructuredExtraction {
        markdown: md,
        mode: det.mode,
        reason: det.reason,
        table_count,
        code_block_count,
    }
}

/// `structuralExtractAsync` — the async entry; structural/docs still take
/// the sync twins, article takes the async `extractArticle(html, url)`.
pub async fn structural_extract_async(
    html: &str,
    content_type: &str,
    url: &str,
) -> StructuredExtraction {
    let det = detect_mode(html, content_type, url);
    let md = match det.mode {
        ExtractionMode::Document => extract_document(html, content_type, url).await,
        ExtractionMode::Structural => extract_structural_sync(html),
        ExtractionMode::Docs => extract_docs_sync(html),
        _ => extract_article(html, url).await,
    };
    let (table_count, code_block_count) = markdown_counts(&md);
    StructuredExtraction {
        markdown: md,
        mode: det.mode,
        reason: det.reason,
        table_count,
        code_block_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://example.com/page";

    #[test]
    fn detect_mode_document_bridges() {
        // .pdf URL (query stripped first).
        let d = detect_mode("x", "", "https://x.com/a.pdf?v=1");
        assert_eq!((d.mode, d.reason.as_str()), (ExtractionMode::Document, "PDF (content-type or .pdf)"));
        let d = detect_mode("x", "text/csv; charset=utf-8", URL);
        assert_eq!((d.mode, d.reason.as_str()), (ExtractionMode::Document, "CSV/TSV (content-type or .csv/.tsv)"));
        let d = detect_mode("x", "", "https://x.com/a.json");
        assert_eq!((d.mode, d.reason.as_str()), (ExtractionMode::Document, "JSON (content-type or .json)"));
        // No-dot-extension quirk: the "extension" of ".../json" is the WHOLE
        // final dot-segment "com/json" ≠ "json" — the JSON bridge misses and
        // the non-HTML guard fires instead.
        let d = detect_mode("x", "", "https://x.com/json");
        assert_eq!((d.mode, d.reason.as_str()), (ExtractionMode::Document, "non-HTML content-type"));
        let d = detect_mode("x", "text/XML", URL);
        assert_eq!((d.mode, d.reason.as_str()), (ExtractionMode::Document, "XML (content-type)"));
        let d = detect_mode("x", "image/png", URL);
        assert_eq!((d.mode, d.reason.as_str()), (ExtractionMode::Document, "non-HTML content-type"));
        let d = detect_mode("x", "", "http://x/f.MD");
        assert_eq!((d.mode, d.reason.as_str()), (ExtractionMode::Document, "Markdown (content-type or .md)"));
    }

    #[test]
    fn detect_mode_structural_count_quirks() {
        // `<dl[^>]*>` also matches <dlink>; the card regex is double-quote-only
        // so class='card' counts 0. 2+2+1+0 = 5 > 4 → structural.
        let html = "<table></table><table></table><section></section>\
                    <section></section><dlink></dlink><div class='card'></div>";
        let d = detect_mode(html, "text/html", URL);
        assert_eq!(d.mode, ExtractionMode::Structural);
        assert_eq!(d.reason, "tables=2 sections=2 dl=1 cards=0");
    }

    #[test]
    fn detect_mode_article_paragraph_quirk() {
        // `<p[^>]*>` also matches `<pre>` → 2 "paragraphs".
        let d = detect_mode("<p>a</p><pre>x</pre>", "text/html", URL);
        assert_eq!(d.mode, ExtractionMode::Article);
        assert_eq!(d.reason, "low structural density, 2 paragraphs");
    }

    #[test]
    fn detect_mode_callout_4000_unit_window() {
        // 16 <pre> (pre+code = 16 > 15) + padding so "note" ends exactly at
        // unit 4000 (inside) vs 4004 (outside).
        let pre16 = "<pre></pre>".repeat(16); // 176 units
        let inside = format!("{pre16}{}note", "x".repeat(3820));
        let d = detect_mode(&inside, "text/html", URL);
        assert_eq!((d.mode, d.reason.as_str()), (ExtractionMode::Docs, "high <pre>/<code> density + callouts"));
        let outside = format!("{pre16}{}note", "x".repeat(3824));
        let d = detect_mode(&outside, "text/html", URL);
        assert_eq!(d.mode, ExtractionMode::Article);
        assert_eq!(d.reason, "low structural density, 16 paragraphs");
    }

    #[test]
    fn nested_table_flattens_rows_and_cells() {
        // rows = ALL descendant <tr> of the table; cells = ALL descendant
        // th/td of each row — the inner table's row/cells leak into the outer
        // grid (header row keeps the leaked cells RAW; body rows pad to width).
        let html = "<table><tbody><tr><td>a</td><td>b<table><tbody><tr><td>c</td></tr></tbody></table></td></tr></tbody></table>";
        let out = structural_extract(html, "text/html", URL);
        assert_eq!(out.mode, ExtractionMode::Article);
        assert_eq!(out.markdown, "| a | bc | c |\n| --- | --- | --- |\n| c |  |  |");
        assert_eq!(out.table_count, 3);
    }

    #[test]
    fn csv_table_cells_escapes_pipes_in_body_only() {
        let out = structural_extract("<table><tbody><tr><td>x|y</td></tr></tbody></table>", "text/html", URL);
        assert!(out.markdown.contains("| x|y |"), "header row stays raw: {out:?}", out = out.markdown);
        assert_eq!(out.table_count, 2);
    }

    #[test]
    fn docs_mode_fenced_code_nests_rules() {
        // The custom CODE rule shadows the built-in one even INSIDE the custom
        // PRE rule's content → 4 fence tokens per <pre><code> pair.
        let mut html = String::from(
            "<header>HDR</header><nav>NAX</nav><aside>ASTD</aside><footer>FTR</footer>caution",
        );
        html.push_str(&"<pre><code>p1</code></pre>".repeat(9));
        html.push_str("<pre><code data-language=\"go\">x</code></pre>");
        let out = structural_extract(&html, "text/html", URL);
        assert_eq!((out.mode, out.reason.as_str()), (ExtractionMode::Docs, "high <pre>/<code> density + callouts"));
        assert!(out.markdown.contains("```\n\n```\np1\n```\n\n```"));
        assert!(out.markdown.contains("```go\n\n```go\nx\n```\n\n```"));
        assert!(out.markdown.contains("HDR")); // docs strip keeps <header>
        assert!(!out.markdown.contains("NAX"));
        assert!(!out.markdown.contains("ASTD"));
        assert!(!out.markdown.contains("FTR"));
        assert_eq!(out.code_block_count, 20); // 10 pairs × 4 fences / 2
        assert_eq!(out.table_count, 0);
    }

    #[test]
    fn article_mode_keeps_svg_strips_nav_and_script() {
        let out = structural_extract("<nav>x</nav><p>a</p><svg>SVGT</svg><script>s</script>", "text/html", URL);
        assert_eq!(out.mode, ExtractionMode::Article);
        assert_eq!(out.reason, "low structural density, 1 paragraphs");
        assert_eq!(out.markdown, "a\n\nSVGT");
    }

    #[test]
    fn list_rules_prefix_indent_and_start() {
        let one = structural_extract("<ul><li>one</li><li>two</li></ul>", "text/html", URL);
        assert_eq!(one.markdown, "*   one\n*   two");
        let deep = structural_extract("<ul><li>a<ul><li>b</li></ul></li></ul>", "text/html", URL);
        assert_eq!(deep.markdown, "*   a\n    *   b");
        let ol = structural_extract("<ol start=\"2\"><li>x</li><li>y</li></ol>", "text/html", URL);
        assert_eq!(ol.markdown, "2.  x\n3.  y");
    }

    #[test]
    fn br_blockquote_headings_shapes() {
        let br = structural_extract("<p>a<br>b</p>", "text/html", URL);
        assert_eq!(br.markdown, "a  \nb");
        let bq = structural_extract("<blockquote>q1<br>q2</blockquote>", "text/html", URL);
        assert_eq!(bq.markdown, "> q1  \n> q2");
        let h = structural_extract("<h1>Title</h1><h2>T2</h2><h3>Third</h3>", "text/html", URL);
        assert_eq!(h.markdown, "Title\n=====\n\nT2\n--\n\n### Third");
    }

    #[test]
    fn link_rule_escapes_title_and_falls_through_without_href() {
        let out = structural_extract("<p><a href=\"/x\" title='say \"hi\"'>L</a><a>L2</a></p>", "text/html", URL);
        assert_eq!(out.markdown, "[L](/x \"say \\\"hi\\\"\")L2");
    }

    #[test]
    fn inline_code_delimiter_grows_and_pads() {
        let one = structural_extract("<p><code>a`b</code></p>", "text/html", URL);
        assert_eq!(one.markdown, "``a`b``");
        let two = structural_extract("<p><code>`a</code></p>", "text/html", URL);
        assert_eq!(two.markdown, "`` `a ``");
    }

    #[test]
    fn emphasis_and_strong_both_guard_on_blank_content() {
        // NO asymmetry: rules.emphasis AND rules.strong return '' when the
        // content trims to empty (the BR contributes "\n"-ish whitespace only).
        let blank = structural_extract("<p><strong><br></strong><em><br></em></p>", "text/html", URL);
        assert_eq!(blank.markdown, "");
        let mixed = structural_extract("<p><em>a</em>-<strong>b</strong></p>", "text/html", URL);
        assert_eq!(mixed.markdown, "_a_\\-**b**");
    }

    #[test]
    fn markdown_escapes_spot_checks() {
        let out = structural_extract("<p>a*b_c</p><p>1. x</p>", "text/html", URL);
        assert!(out.markdown.contains("a\\*b\\_c"));
        assert!(out.markdown.contains("1\\. x"));
    }

    #[test]
    fn json_bridge_preserves_key_order_with_last_dup_winning() {
        let out = structural_extract("{\"b\":1,\"a\":{\"z\":[1,2],\"y\":\"s\"},\"b\":2}", "application/json", URL);
        assert_eq!(out.reason, "JSON (content-type or .json)");
        assert_eq!(
            out.markdown,
            "```json\n{\n  \"b\": 2,\n  \"a\": {\n    \"z\": [\n      1,\n      2\n    ],\n    \"y\": \"s\"\n  }\n}\n```"
        );
        assert_eq!(out.code_block_count, 1);
        let raw = structural_extract("not json", "application/json", URL);
        assert_eq!(raw.markdown, "not json");
    }

    #[test]
    fn csv_tsv_bridge_shapes() {
        let out = structural_extract("h1,h2\nv1,v2|z\n\n", "text/csv", URL);
        assert_eq!(
            out.markdown,
            "## CSV/TSV data (2 rows)\n| h1 | h2 |\n| --- | --- |\n| v1 | v2\\|z |"
        );
        assert_eq!(out.code_block_count, 0);
        let empty = structural_extract("", "text/csv", URL);
        assert_eq!(empty.markdown, "(empty CSV)");
        let tsv = structural_extract("a\tb\nc\td", "", "https://x.com/f.tsv");
        assert_eq!(tsv.reason, "CSV/TSV (content-type or .csv/.tsv)");
        assert!(tsv.markdown.contains("| c | d |"));
    }

    #[test]
    fn pdf_sync_bridge_is_the_sentinel_string() {
        let out = structural_extract("RAW", "application/pdf", URL);
        assert_eq!(out.mode, ExtractionMode::Document);
        assert_eq!(out.reason, "PDF (content-type or .pdf)");
        assert_eq!(out.markdown, "(PDF requires structuralExtractAsync)");
    }

    #[tokio::test]
    async fn pdf_async_bridge_always_fails_to_raw_slice() {
        let out = structural_extract_async("RAW", "application/pdf", URL).await;
        assert!(out.markdown.starts_with("(PDF text extraction failed)\nRAW"));
        let big = structural_extract_async(&"x".repeat(6000), "application/pdf", URL).await;
        // UTF-16 slice cap 5000 units after the 29-char sentinel.
        assert_eq!(big.markdown.len(), "(PDF text extraction failed)\n".len() + 5000);
    }

    #[test]
    fn structural_mode_strips_svg_and_header() {
        let mut html = "<table><tbody><tr><td>t</td></tr></tbody></table>".repeat(5);
        html.push_str("<header>HDR</header><svg>SVGCONTENT</svg>");
        let out = structural_extract(&html, "text/html", URL);
        assert_eq!((out.mode, out.reason.as_str()), (ExtractionMode::Structural, "tables=5 sections=0 dl=0 cards=0"));
        assert!(out.markdown.contains("| t |"));
        assert!(!out.markdown.contains("HDR"));
        assert!(!out.markdown.contains("SVGCONTENT"));
    }

    #[tokio::test]
    async fn async_article_entry_matches_sync_and_charset_reexport_works() {
        let a = structural_extract_async("<p>a</p>", "text/html", URL).await;
        let b = structural_extract("<p>a</p>", "text/html", URL);
        assert_eq!(a, b);
        assert_eq!(a.markdown, "a");
        assert_eq!(normalize_body("héllo".as_bytes(), "text/html; charset=utf-8"), "héllo");
        assert!(!detect_charset("text/html; charset=utf-8", "héllo".as_bytes()).is_empty());
        let empty = structural_extract("", "text/html", URL);
        assert_eq!(empty.markdown, "");
        assert_eq!(empty.reason, "low structural density, 0 paragraphs");
    }
}
