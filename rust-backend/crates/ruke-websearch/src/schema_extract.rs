//! Parity port of `lib/web-search/schema-extract.ts` (owner: W3).
//!
//! Pure module — cheerio on the TS side, [`scraper`] here; nothing local is
//! imported by either.
//!
//! # TS quirks kept verbatim (do not "fix")
//! - `schemaExtract`'s `title`/`out` path is DEAD code: `out` never reaches
//!   the return value (`schemaLines` does). Not ported — the page `<title>`
//!   must NOT appear in output (pinned by test).
//! - `formatGeneric`'s `v(val) || (typeof val === "object" ?
//!   JSON.stringify(val) : "")`: `typeof null === "object"`, so a null value
//!   emits `- key: null` (pinned by test).
//! - The generic fallback caps AFTER pushing (`if (lines.length >= 14)
//!   break;` outside the push guard) → up to 14 lines can appear.
//! - `if (lines.length < 2) return "";` — one-line generics are dropped.
//! - `Person`/`ProfilePage`: the Email slice is on the VALUE (120), but the
//!   Description `fmt(...)?.slice(0, 500)` slice is on the WHOLE line — the
//!   label counts against the 500.
//! - `Recipe` / `Person` "Same as: " / Organization "Same as: " lines are
//!   always truthy (bare concatenation, even with zero values) → the section
//!   is never empty for those types.
//! - FAQ answer `(aa?.text ?? v(aa) ?? "").toString()`: an `acceptedAnswer`
//!   object with a `text` key wins VERBATIM (including when the whole
//!   acceptedAnswer is a bare string → `v(aa)` fallback).
//! - `offersLines`: `avail.replace(/^https:\/\/schema.org\//, "")` is
//!   anchored (prefix strip only); the `Offer: <url>` fallback fires only
//!   when `parts` is empty; values joined with " · " (U+00B7).
//! - Microdata cap `micro.length >= 4` counts EMITTED groups, not scanned
//!   elements; `val = text().trim() || attr("content")` — the content
//!   attribute is NOT trimmed.
//! - OpenGraph/Twitter meta keys are an EXACT-match set (no prefix magic);
//!   empty `content=""` is falsy → line skipped; `property` checked before
//!   `name` (`??`, not `||`).
//! - JS `.length`/`.slice` are UTF-16 code units → `js_trunc`.
//!
//! # Recorded divergences (unavoidable JS-vs-Rust)
//! - `cheerio.load` can throw (try/catch dead path); `Html::parse_document`
//!   is infallible, so the catch is unreachable in both runtimes.
//! - `JSON.parse` keeps lone-surrogate `\uD800`-style escapes; serde_json
//!   rejects them → such a JSON-LD block is skipped here where JS formats it.
//! - Number→String: serde prints integral JSON floats as written (`1.0` →
//!   "1.0") where JS `String(1.0)` is "1"; `1e21` renders "1e21" vs JS
//!   "1e+21". Typical JSON-LD (bare ints/decimals) matches exactly.
//! - `js_trunc` never cuts between surrogate halves; JS `.slice` can leave a
//!   lone surrogate (output is a Rust `String` either way).
//! - JS `\s` and regex-crate `\s` differ for a handful of exotic code points
//!   (e.g. classification changes across Unicode versions).
//! - cheerio's `.text()` == scraper `ElementRef::text()` (descendant text
//!   nodes, pre-order, comments excluded); `.find()` ==
//!   `descendent_elements()` (excludes self — nested itemprop scopes stay
//!   inside the parent group, TS quirk kept).

use regex::Regex;
use scraper::{Html, Selector};
use serde_json::Value;
use std::sync::OnceLock;

const NULL: Value = Value::Null;

/* ── public API ─────────────────────────────────────────────────────── */

/// TS `schemaExtract(html)`: `[Structured Page Facts]` markdown from a full
/// HTML document (JSON-LD + Microdata + OpenGraph/Twitter meta).
pub fn schema_extract(html_str: &str) -> String {
    // JS guard: `!html || html.length < 200` — html.length is UTF-16 units.
    if html_str.is_empty() || utf16_len(html_str) < 200 {
        return String::new();
    }
    // cheerio.load's throw path is dead here: Html::parse_document never
    // fails. The dead `title`/`out` push is NOT ported (never output — see
    // module doc).
    let doc = Html::parse_document(html_str);
    let mut schema_lines: Vec<String> = Vec::new();

    // ── JSON-LD ──
    let mut blocks: Vec<Value> = Vec::new();
    for el in doc.select(ld_selector()) {
        let raw: String = el.text().collect();
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(&sanitize_ld_json(raw)) {
            blocks.push(parsed);
        }
        /* malformed block — skip */
    }
    schema_lines.extend(schema_extract_from_blocks(&blocks));

    // ── Microdata (itemtype= / itemprop=) ──
    let mut micro: Vec<String> = Vec::new();
    for el in doc.select(itemtype_selector()) {
        if micro.len() >= 4 {
            continue;
        }
        let item_type = el.attr("itemtype");
        let mut props: Vec<String> = Vec::new();
        for p in el.descendent_elements() {
            let prop = match p.attr("itemprop") {
                Some(pr) if !pr.is_empty() => pr,
                _ => continue, // JS `prop &&` — missing attr skips
            };
            let text: String = p.text().collect();
            let text = text.trim();
            let val: &str = if !text.is_empty() {
                text
            } else {
                p.attr("content").unwrap_or("")
            };
            if !val.is_empty() {
                props.push(format!("- {prop}: {}", js_trunc(val, 200)));
            }
        }
        if !props.is_empty() {
            micro.push(format!(
                "## Microdata: {}\n{}",
                item_type.unwrap_or("unknown"),
                props.iter().take(12).map(String::as_str).collect::<Vec<_>>().join("\n")
            ));
        }
    }
    schema_lines.extend(micro);

    // ── OpenGraph / Twitter meta ──
    let mut meta_lines: Vec<String> = Vec::new();
    for el in doc.select(meta_selector()) {
        let prop = match el.attr("property") {
            Some(p) => p,
            None => match el.attr("name") {
                Some(n) => n,
                None => continue,
            },
        };
        if !META_PROPS.contains(&prop) {
            continue;
        }
        if let Some(content) = el.attr("content") {
            if !content.is_empty() {
                meta_lines.push(format!("{prop}: {}", js_trunc(content, 300)));
            }
        }
    }
    if !meta_lines.is_empty() {
        schema_lines.push(format!(
            "## Page Metadata (OpenGraph)\n{}",
            meta_lines.join("\n")
        ));
    }

    if schema_lines.is_empty() {
        return String::new();
    }
    format!("[Structured Page Facts]\n\n{}", schema_lines.join("\n\n").trim())
}

/// TS `schemaExtractFromBlocks(blocks: unknown[])`: format already-parsed
/// JSON-LD values → markdown sections. (`&[Value]` stands in for
/// `unknown[]`; everything the TS callers pass is JSON-parsed input.)
pub fn schema_extract_from_blocks(blocks: &[Value]) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for block in blocks {
        for item in flatten_schema(block) {
            let md = format_schema_item(&item);
            if !md.is_empty() {
                lines.push(md);
            }
        }
    }
    lines
}

/* ── internals ──────────────────────────────────────────────────────── */

const META_PROPS: &[&str] = &[
    "og:title",
    "og:description",
    "og:site_name",
    "og:url",
    "og:image",
    "og:video",
    "og:type",
    "og:price:amount",
    "og:price:currency",
    "twitter:title",
    "twitter:description",
    "twitter:card",
    "twitter:site",
    "twitter:creator",
    "twitter:data1",
    "twitter:label1",
    "twitter:data2",
    "twitter:label2",
];

fn ld_selector() -> &'static Selector {
    static S: OnceLock<Selector> = OnceLock::new();
    S.get_or_init(|| Selector::parse(r#"script[type="application/ld+json"]"#).unwrap())
}

fn itemtype_selector() -> &'static Selector {
    static S: OnceLock<Selector> = OnceLock::new();
    S.get_or_init(|| Selector::parse("[itemtype]").unwrap())
}

fn meta_selector() -> &'static Selector {
    static S: OnceLock<Selector> = OnceLock::new();
    S.get_or_init(|| Selector::parse("meta").unwrap())
}

fn ws_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}

/// UTF-16 code-unit length (JS `string.length`).
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// JS `s.slice(0, max_utf16)` at UTF-16 granularity. Divergence: never cuts
/// between surrogate halves (JS can leave a lone surrogate).
fn js_trunc(s: &str, max_utf16: usize) -> &str {
    let mut acc = 0usize;
    let mut end = 0usize;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if acc + w > max_utf16 {
            break;
        }
        acc += w;
        end = i + c.len_utf8();
    }
    &s[..end]
}

fn ws_collapse(s: &str) -> String {
    ws_re().replace_all(s, " ").into_owned()
}

/// JS `String(x)` for JSON values (arrays join with ",", objects become
/// "[object Object]").
fn js_to_string(x: &Value) -> String {
    match x {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_to_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JS falsiness for JSON values (undefined ⇒ Null by construction).
fn is_js_falsy(x: &Value) -> bool {
    match x {
        Value::Null => true,
        Value::Bool(b) => !*b,
        Value::Number(n) => n.as_f64().map(|f| f == 0.0).unwrap_or(false),
        Value::String(s) => s.is_empty(),
        _ => false, // arrays/objects are truthy in JS
    }
}

/// Property access with `?.` semantics: missing/non-object ⇒ JS undefined.
fn g<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&NULL)
}

/// `v(item.key)` where a missing key is JS `undefined` → v ⇒ "".
fn vs(item: &Value, k: &str) -> String {
    v(g(item, k))
}

/// `v(item.a?.b?.c)` chains.
fn vchain(item: &Value, keys: &[&str]) -> String {
    let mut cur = item;
    for k in keys {
        match cur.get(*k) {
            Some(x) => cur = x,
            None => return String::new(),
        }
    }
    v(cur)
}

fn first_nonempty(cands: impl IntoIterator<Item = String>) -> String {
    cands.into_iter().find(|s| !s.is_empty()).unwrap_or_default()
}

/// TS `sanitizeLdJson`.
fn sanitize_ld_json(raw: &str) -> String {
    raw.replace("<!--", "").replace("-->", "").trim().to_string()
}

/// TS `flattenSchema`: expand arrays + `@graph` into a flat item list.
fn flatten_schema(node: &Value) -> Vec<Value> {
    // JS `!node`: null/false/0/"" are falsy; [] is truthy.
    if is_js_falsy(node) {
        return Vec::new();
    }
    if let Value::Array(arr) = node {
        return arr.iter().flat_map(flatten_schema).collect();
    }
    if node.is_object() {
        if let Some(graph) = node.get("@graph").filter(|x| x.is_array()) {
            let mut out = vec![strip_context(node)];
            out.extend(graph.as_array().unwrap().iter().flat_map(flatten_schema));
            return out;
        }
    }
    vec![strip_context(node)]
}

/// TS `stripContext`.
fn strip_context(item: &Value) -> Value {
    match item {
        Value::Object(_) => {
            let mut obj = item.as_object().unwrap().clone();
            obj.remove("@context");
            Value::Object(obj)
        }
        other => other.clone(),
    }
}

/// TS `typeOf`.
fn type_of(item: &Value) -> String {
    match g(item, "@type") {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join(","),
        _ => String::new(),
    }
}

/// TS `v`: primitives, {name}, {value}, {telephone}, {text}, and arrays of
/// either → plain string.
fn v(x: &Value) -> String {
    match x {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(arr) => arr
            .iter()
            .map(v)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        Value::Object(_) => {
            for k in ["name", "value", "telephone", "text"] {
                if let Some(x) = x.get(k) {
                    if !x.is_null() {
                        return v(x);
                    }
                }
            }
            String::new()
        }
    }
}

/// TS `ratingLine`.
fn rating_line(agg: &Value, label: &str) -> String {
    if !agg.is_object() {
        return String::new();
    }
    let rv = v(g(agg, "ratingValue"));
    if rv.is_empty() {
        return String::new();
    }
    let mut parts = vec![format!("{label}: {rv}")];
    let best = v(g(agg, "bestRating"));
    if !best.is_empty() {
        parts.push(format!("of {best}"));
    }
    let count = first_nonempty([
        v(g(agg, "ratingCount")),
        v(g(agg, "reviewCount")),
        v(g(agg, "userRatingCount")),
    ]);
    if !count.is_empty() {
        parts.push(format!("({count} ratings)"));
    }
    parts.join(" ")
}

/// TS `asList`.
fn as_list(x: &Value) -> Vec<&Value> {
    match x {
        Value::Array(arr) => arr.iter().collect(),
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

/// TS `fmt`.
fn fmt(label: &str, value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        format!("{label}: {value}")
    }
}

/// TS `section`.
fn section(header: &str, lines: Vec<String>) -> String {
    let body: Vec<&str> = lines.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
    if body.is_empty() {
        String::new()
    } else {
        format!("{header}\n{}", body.join("\n"))
    }
}

/// TS `formatSchemaItem`.
fn format_schema_item(item: &Value) -> String {
    if !item.is_object() {
        return String::new();
    }
    let t = type_of(item);
    let t1 = t.split(',').next().unwrap_or("");

    match t1 {
        "JobPosting" => section(
            &format!(
                "## Job Posting: {}",
                first_nonempty([vs(item, "title"), vs(item, "name"), "posting".to_string()])
            ),
            vec![
                fmt("Company", &vs(item, "hiringOrganization")),
                fmt(
                    "Location",
                    &first_nonempty([vchain(item, &["jobLocation", "address"]), vs(item, "jobLocation")]),
                ),
                fmt("Employment type", &vs(item, "employmentType")),
                fmt("Posted", &vs(item, "datePosted")),
                fmt("Valid through", &vs(item, "validThrough")),
                fmt("Direct apply", &vs(item, "apply")),
                {
                    let d = vs(item, "description");
                    if d.is_empty() {
                        String::new()
                    } else {
                        format!("Description: {}", js_trunc(&ws_collapse(&d), 800))
                    }
                },
                fmt("Salary", &vs(item, "baseSalary")),
            ],
        ),
        "Product" => {
            let mut lines = offers_lines(g(item, "offers"));
            lines.push(rating_line(g(item, "aggregateRating"), "Rating"));
            lines.push(fmt("Description", js_trunc(&vs(item, "description"), 500)));
            lines.push(fmt("Brand", &vs(item, "brand")));
            lines.push(fmt(
                "SKU",
                &first_nonempty([vs(item, "sku"), vs(item, "mpn"), vs(item, "gtin13")]),
            ));
            lines.push(fmt("Availability", &vs(item, "availability")));
            section(
                &format!("## Product: {}", first_nonempty([vs(item, "name"), "unnamed".to_string()])),
                lines,
            )
        }
        "Article" | "NewsArticle" | "BlogPosting" | "TechArticle" | "ReportageNewsArticle" => {
            let body_line = {
                let ab = vs(item, "articleBody");
                if !ab.is_empty() {
                    format!("Body: {}", js_trunc(&ab, 1500))
                } else {
                    let d = vs(item, "description");
                    if !d.is_empty() {
                        format!("Description: {}", js_trunc(&d, 600))
                    } else {
                        String::new()
                    }
                }
            };
            section(
                &format!(
                    "## Article: {}",
                    first_nonempty([vs(item, "headline"), vs(item, "name"), "untitled".to_string()])
                ),
                vec![
                    fmt("Author", &vs(item, "author")),
                    fmt("Publisher", &vs(item, "publisher")),
                    fmt("Published", &vs(item, "datePublished")),
                    fmt("Modified", &vs(item, "dateModified")),
                    fmt("Section", &vs(item, "articleSection")),
                    rating_line(g(item, "aggregateRating"), "Rating"),
                    body_line,
                ],
            )
        }
        "Movie" | "TVSeries" | "TVEpisode" | "MovieSeries" | "VideoObject" => section(
            &format!(
                "## {}: {}",
                t1,
                first_nonempty([vs(item, "name"), vs(item, "headline"), "untitled".to_string()])
            ),
            vec![
                fmt("Type", &t),
                fmt("Description", js_trunc(&ws_collapse(&vs(item, "description")), 600)),
                fmt("Duration", &vs(item, "duration")),
                fmt("Content rating", &vs(item, "contentRating")),
                fmt("Genre", &vs(item, "genre")),
                fmt("Released", &first_nonempty([vs(item, "datePublished"), vs(item, "uploadDate")])),
                fmt("Director", &vs(item, "director")),
                fmt("Cast", js_trunc(&vs(item, "actor"), 400)),
                rating_line(g(item, "aggregateRating"), "IMDb-style rating"),
                fmt("Uploader", &vs(item, "uploadedBy")),
            ],
        ),
        "FAQPage" => {
            let qas: Vec<String> = as_list(g(item, "mainEntity"))
                .into_iter()
                .take(8)
                .enumerate()
                .map(|(i, q)| {
                    let name = v(g(q, "name"));
                    let aa = q.get("acceptedAnswer").filter(|a| !a.is_null());
                    let answer = match aa.and_then(|a| a.get("text")).filter(|t| !t.is_null()) {
                        Some(t) => js_to_string(t),
                        None => aa.map(v).unwrap_or_default(),
                    };
                    if name.is_empty() {
                        String::new()
                    } else {
                        format!(
                            "Q{}: {}\nA{}: {}",
                            i + 1,
                            name,
                            i + 1,
                            js_trunc(&answer, 600)
                        )
                    }
                })
                .collect();
            let kept: Vec<&str> = qas.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
            if kept.is_empty() {
                String::new()
            } else {
                format!("## FAQ\n{}", kept.join("\n\n"))
            }
        }
        "HowTo" => {
            let steps: Vec<String> = as_list(g(item, "step"))
                .into_iter()
                .take(8)
                .map(|s| {
                    let n = first_nonempty([v(g(s, "name")), v(g(s, "itemListElement"))]);
                    let txt = first_nonempty([v(g(s, "text")), v(s)]);
                    if !n.is_empty() {
                        let tail = if !txt.is_empty() && txt != n {
                            format!(": {}", js_trunc(&txt, 300))
                        } else {
                            String::new()
                        };
                        format!("- {n}{tail}")
                    } else if !txt.is_empty() {
                        format!("- {}", js_trunc(&txt, 300))
                    } else {
                        String::new()
                    }
                })
                .collect();
            let kept: Vec<&str> = steps.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
            if kept.is_empty() {
                String::new()
            } else {
                format!("## How-To: {}\n{}", vs(item, "name"), kept.join("\n"))
            }
        }
        "Recipe" => {
            let ingredients: String = as_list(g(item, "recipeIngredient"))
                .into_iter()
                .take(12)
                .map(v)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            section(
                &format!("## Recipe: {}", vs(item, "name")),
                vec![
                    fmt("Description", js_trunc(&vs(item, "description"), 400)),
                    fmt("Prep time", &vs(item, "prepTime")),
                    // always-truthy line (bare concat) — TS quirk kept
                    format!("Ingredients: {ingredients}"),
                    fmt("Yield", &vs(item, "recipeYield")),
                    rating_line(g(item, "aggregateRating"), "Rating"),
                ],
            )
        }
        "Event" => {
            let mut lines = vec![
                fmt("Starts", &vs(item, "startDate")),
                fmt("Ends", &vs(item, "endDate")),
                fmt(
                    "Location",
                    &first_nonempty([vchain(item, &["location", "name"]), vs(item, "location")]),
                ),
                fmt("Organizer", &vs(item, "organizer")),
            ];
            lines.extend(offers_lines(g(item, "offers")));
            lines.push(fmt("Description", js_trunc(&vs(item, "description"), 400)));
            section(&format!("## Event: {}", vs(item, "name")), lines)
        }
        "LocalBusiness" | "Restaurant" | "Store" | "FoodEstablishment" | "GovernmentOrganization"
        | "GovernmentService" => section(
            &format!("## {}: {}", t1, vs(item, "name")),
            vec![
                fmt(
                    "Address",
                    &first_nonempty([vs(item, "address"), vchain(item, &["address", "streetAddress"])]),
                ),
                fmt("Phone", &vs(item, "telephone")),
                fmt("Opening hours", js_trunc(&vs(item, "openingHours"), 300)),
                fmt("Price range", &vs(item, "priceRange")),
                rating_line(g(item, "aggregateRating"), "Rating"),
                fmt("Description", js_trunc(&vs(item, "description"), 400)),
            ],
        ),
        "Person" | "ProfilePage" => {
            let header_name = first_nonempty([
                vs(item, "name"),
                if t1 == "ProfilePage" {
                    vchain(item, &["mainEntity", "name"])
                } else {
                    String::new()
                },
            ]);
            let same_as: Option<&Value> = item
                .get("sameAs")
                .filter(|x| !x.is_null())
                .or_else(|| item.get("mainEntity").and_then(|m| m.get("sameAs")));
            let same_line: String = match same_as {
                Some(x) => as_list(x),
                None => Vec::new(),
            }
            .into_iter()
            .take(5)
            .map(v)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
            // Whole-line slice at 500 for Description (label counts — TS
            // parenthesization quirk kept).
            let desc_line = fmt(
                "Description",
                &first_nonempty([vs(item, "description"), vchain(item, &["mainEntity", "description"])]),
            );
            section(
                &format!("## Person: {header_name}"),
                vec![
                    fmt(
                        "Job title",
                        &first_nonempty([vs(item, "jobTitle"), vchain(item, &["mainEntity", "jobTitle"])]),
                    ),
                    fmt(
                        "Works for",
                        &first_nonempty([vs(item, "worksFor"), vchain(item, &["mainEntity", "worksFor"])]),
                    ),
                    fmt("Email", js_trunc(&vs(item, "email"), 120)),
                    fmt("Address", &vs(item, "address")),
                    format!("Same as: {same_line}"),
                    js_trunc(&desc_line, 500).to_string(),
                ],
            )
        }
        "Organization" => {
            let same_line: String = as_list(g(item, "sameAs"))
                .into_iter()
                .take(5)
                .map(v)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            section(
                &format!("## Organization: {}", vs(item, "name")),
                vec![
                    fmt("URL", &vs(item, "url")),
                    fmt("Description", js_trunc(&vs(item, "description"), 400)),
                    fmt("Founded", &vs(item, "foundingDate")),
                    format!("Same as: {same_line}"),
                ],
            )
        }
        "WebSite" | "WebPage" | "ImageObject" | "BreadcrumbList" | "SearchAction" | "Audience"
        | "DefinativeDescription" => String::new(),
        "SoftwareApplication" | "WebApplication" => {
            let mut lines = vec![
                fmt("Operating system", &vs(item, "operatingSystem")),
                fmt("Version", &vs(item, "softwareVersion")),
            ];
            lines.extend(offers_lines(g(item, "offers")));
            lines.push(rating_line(g(item, "aggregateRating"), "Rating"));
            lines.push(fmt("Description", js_trunc(&vs(item, "description"), 400)));
            section(&format!("## {}: {}", t1, vs(item, "name")), lines)
        }
        "Dataset" => section(
            &format!("## Dataset: {}", vs(item, "name")),
            vec![
                fmt("Creator", &vs(item, "creator")),
                fmt("Published", &vs(item, "datePublished")),
                fmt("Description", js_trunc(&vs(item, "description"), 500)),
            ],
        ),
        _ => format_generic(item, &t),
    }
}

/// TS `offersLines`.
fn offers_lines(offers: &Value) -> Vec<String> {
    if is_js_falsy(offers) {
        return Vec::new();
    }
    as_list(offers)
        .into_iter()
        .take(4)
        .map(|o| {
            let price = first_nonempty([v(g(o, "price")), v(g(o, "lowPrice")), v(g(o, "minPrice"))]);
            let cur = v(g(o, "priceCurrency"));
            let mut parts: Vec<String> = Vec::new();
            if !price.is_empty() {
                let suffix = if cur.is_empty() { String::new() } else { format!(" {cur}") };
                parts.push(format!("Price: {price}{suffix}"));
            }
            let avail = v(g(o, "availability"));
            if !avail.is_empty() {
                // anchored ^https://schema.org/ strip ⇒ prefix-only
                let stripped = avail.strip_prefix("https://schema.org/").unwrap_or(&avail);
                parts.push(format!("Availability: {stripped}"));
            }
            let url = o.get("url").filter(|x| !is_js_falsy(x));
            if let Some(u) = url.filter(|_| parts.is_empty()) {
                parts.push(format!("Offer: {}", js_trunc(&js_to_string(u), 200)));
            }
            parts.join(" \u{b7} ")
        })
        .collect()
}

/// TS `formatGeneric`: unknown `@type` → compact key/value fallback.
fn format_generic(item: &Value, t: &str) -> String {
    const SKIP: &[&str] = &[
        "@type",
        "@id",
        "@context",
        "@graph",
        "image",
        "logo",
        "potentialAction",
        "mainEntityOfPage",
        "dateModified",
        "inLanguage",
        "keywords",
    ];
    let obj = match item.as_object() {
        Some(o) => o, // serde_json preserve_order ⇒ JS insertion order
        None => return String::new(),
    };
    let mut lines: Vec<String> = Vec::new();
    for (k, val) in obj {
        if SKIP.contains(&k.as_str()) {
            continue;
        }
        let mut s = v(val);
        if s.is_empty() && (val.is_object() || val.is_array() || val.is_null()) {
            // JS `typeof val === "object"` includes null → "null" line.
            s = serde_json::to_string(val).unwrap_or_default();
        }
        if !s.is_empty() {
            lines.push(format!("- {k}: {}", js_trunc(&s, 400)));
        }
        // break AFTER the length check counts the just-pushed line (TS)
        if lines.len() >= 14 {
            break;
        }
    }
    if lines.len() < 2 {
        return String::new();
    }
    let name = first_nonempty([vs(item, "name"), vs(item, "headline"), vs(item, "title"), t.to_string()]);
    let header = format!(
        "## {}{}",
        if t.is_empty() { "Schema" } else { t },
        if name.is_empty() { String::new() } else { format!(": {name}") }
    );
    section(&header, lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn product_jsonld_offers_rating_and_schema_wrapper() {
        let html = r#"<html><head><title>PIN THE DEAD TITLE PATH - NOT IN OUTPUT - padding padding</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget",
"offers":{"@type":"Offer","price":"19.5","priceCurrency":"USD","availability":"https://schema.org/InStock"},
"aggregateRating":{"@type":"AggregateRating","ratingValue":4.5,"bestRating":5,"ratingCount":1234},
"brand":{"name":"Acme"},"sku":"SKU-1","description":null}</script></head><body>x</body></html>"#;
        let out = schema_extract(html);
        assert!(out.starts_with("[Structured Page Facts]\n\n## Product: Widget\n"));
        assert!(out.contains("Price: 19.5 USD \u{b7} Availability: InStock")); // prefix strip
        assert!(out.contains("Rating: 4.5 of 5 (1234 ratings)"));
        assert!(out.contains("Brand: Acme"));
        assert!(out.contains("SKU: SKU-1"));
        // dead TS title path: never reaches the output
        assert!(!out.contains("# PIN"));
        // description null → fmt("") → line dropped
        assert!(!out.contains("Description"));
    }

    #[test]
    fn graph_flatten_and_faq_answer_chain() {
        let block = json!({
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@graph": [{
                "@type": "FAQPage",
                "mainEntity": [
                    {"@type": "Question", "name": "Q1?", "acceptedAnswer": {"@type": "Answer", "text": "A1."}},
                    {"@type": "Question", "name": "Q2?", "acceptedAnswer": "A2 bare string"},
                    {"@type": "Question", "acceptedAnswer": {"text": "no question name"}}
                ]
            }]
        });
        let lines = schema_extract_from_blocks(std::slice::from_ref(&block));
        assert_eq!(lines.len(), 1); // WebPage → ""
        assert_eq!(
            lines[0],
            "## FAQ\nQ1: Q1?\nA1: A1.\n\nQ2: Q2?\nA2: A2 bare string"
        );
    }

    #[test]
    fn microdata_content_fallback_and_meta_exact_set() {
        let html = r#"<html><head>
<meta property="og:title" content="OG Title">
<meta name="twitter:site" content="@acct">
<meta property="og:description" content="">
<meta name="irrelevant" content="skip me">
</head><body>
<div itemtype="http://schema.org/Product"><span itemprop="name">Mic Prod</span><span itemprop="price" content=" 9.99 "></span></div>
pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad
</body></html>"#;
        let out = schema_extract(html);
        assert!(out.contains("## Microdata: http://schema.org/Product\n- name: Mic Prod\n- price:  9.99 "));
        // content attr NOT trimmed (TS parity). The meta block is the LAST
        // schema line — join("\n\n").trim() ends output at "@acct" with no
        // trailing newline (JS-identical), so no "\n" in the expectation.
        assert!(out.contains("## Page Metadata (OpenGraph)\nog:title: OG Title\ntwitter:site: @acct"));
        assert!(!out.contains("irrelevant"));
        assert!(!out.contains("og:description")); // empty content falsy
    }

    #[test]
    fn generic_null_values_json_stringify_and_lt2_drop() {
        let weird = json!({"@type": "WeirdThing", "name": "X", "note": null, "meta": {"a": 1}});
        let lines = schema_extract_from_blocks(std::slice::from_ref(&weird));
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0],
            "## WeirdThing: X\n- name: X\n- note: null\n- meta: {\"a\":1}"
        );
        // one line → dropped (lines.length < 2)
        let single = json!({"@type": "WeirdThing", "note": null});
        assert!(schema_extract_from_blocks(&[single]).is_empty());
        // malformed ld+json block skipped + html <200 guard
        let html = "<html><body><script type=\"application/ld+json\">{ this is not json }</script>\
                    padding padding padding padding padding padding padding padding padding padding\
                    padding padding padding padding padding padding padding padding padding padding</body></html>";
        assert_eq!(schema_extract(html), "");
        assert_eq!(schema_extract("<p>too short</p>"), "");
    }

    #[test]
    fn recipe_always_truthy_ingredients_line_and_howto() {
        let recipe = json!({"@type": "Recipe", "prepTime": "PT10M"});
        let lines = schema_extract_from_blocks(std::slice::from_ref(&recipe));
        // "Ingredients: " bare concat is always truthy → section emitted
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "## Recipe: \nPrep time: PT10M\nIngredients: ");

        let howto = json!({"@type": "HowTo", "name": "Make Tea", "step": [
            {"name": "Boil water", "text": "Boil water"},           // txt == n → no suffix
            {"text": "Pour cup of tea carefully"},                    // no name → "- txt"
            {"itemListElement": "Steep", "text": "Steep 3 minutes"}
        ]});
        let lines = schema_extract_from_blocks(std::slice::from_ref(&howto));
        assert_eq!(
            lines[0],
            "## How-To: Make Tea\n- Boil water\n- Pour cup of tea carefully\n- Steep: Steep 3 minutes"
        );
    }
}
