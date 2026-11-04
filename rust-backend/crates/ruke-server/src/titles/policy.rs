//! Port of `lib/server/titles/policy.ts` — verbatim guard order:
//! manual titleSource NEVER overwritten; legacy auto titles recognised by
//! the first-message `slice(0, 40)` copy (UTF-16 units, whitespace-collapsed
//! variant included); refresh due at +4 messages; guarded write refuses a
//! job whose stored generation count is NEWER, and never bumps `updatedAt`
//! (a background refresh must not reorder the sidebar).
//!
//! RECORDED MICRO-DIVERGENCES for truthy non-object `meta`:
//! - PRIMITIVE meta (string/number/bool): the TS assignments
//!   `meta.title = title; …` throw a TypeError (ESM strict mode), which
//!   propagates out of writeTitle → runJob → the job promise rejects → the
//!   title route 500s. Rust cannot mutate a primitive, so
//!   `apply_title_to_doc` returns Err — callers propagate it to a 500 as
//!   well (status parity kept; the 500 body is `{error}` vs Next's generic
//!   error page — a shape difference already recorded for every 500 on
//!   this cut-over).
//! - ARRAY meta: JS arrays ARE objects — `meta.title = …` succeeds and
//!   applyTitleToDoc returns true; JSON.stringify then DROPS the non-index
//!   properties, so the persisted file is identical to the untouched
//!   array. Rust returns Ok(true) leaving the array byte-identical — the
//!   on-disk document matches TS exactly; only the in-memory doc (never
//!   observed across the HTTP boundary) differs.

use serde_json::{Number, Value};

use ruke_skills::jsstr;

/// A refresh is due once the conversation grew by this many messages.
pub const REFRESH_MESSAGE_DELTA: i64 = 4;

/// `firstUserText`: the first user message's typed text — a string content
/// returns RAW (untrimmed); a parts array returns the first part whose text
/// trims non-empty, also RAW. The first user message always TERMINATES the
/// scan (blank ⇒ "").
pub fn first_user_text(messages: &Value) -> String {
    let Some(arr) = messages.as_array() else {
        return String::new();
    };
    for m in arr {
        if m.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        match m.get("content") {
            Some(Value::String(s)) => return s.clone(),
            Some(Value::Array(parts)) => {
                for p in parts {
                    if let Some(Value::String(t)) = p.get("text") {
                        if !jsstr::js_trim(t).is_empty() {
                            return t.clone();
                        }
                    }
                }
            }
            _ => {}
        }
        return String::new();
    }
    String::new()
}

/// `looksAutoTitle`: placeholder titles are auto by definition; otherwise
/// the title must equal the first message's raw or whitespace-collapsed
/// 40-UTF-16-unit prefix.
pub fn looks_auto_title(title: &str, first_text: &str) -> bool {
    let t = jsstr::js_trim(title);
    if t.is_empty() || t == "New conversation" || t == "Untitled" {
        return true;
    }
    let first = jsstr::js_trim(first_text);
    if first.is_empty() {
        return false;
    }
    t == jsstr::js_slice_head(first, 40)
        || t == jsstr::js_slice_head(&jsstr::js_collapse(first), 40)
}

/// `shouldGenerate`. `meta` is the doc's meta value or Null (TS passes the
/// `{}` stand-in — a non-object reads None for every key, same result).
pub fn should_generate(meta: &Value, message_count: i64, force: bool) -> bool {
    if meta.get("titleSource").and_then(Value::as_str) == Some("manual") {
        return false;
    }
    if force {
        return true;
    }
    match meta.get("titleGenCount").and_then(Value::as_f64) {
        // Never generated: once a meaningful exchange exists (user + assistant).
        None => message_count >= 2,
        Some(g) => (message_count as f64) - g >= REFRESH_MESSAGE_DELTA as f64,
    }
}

/// `applyTitleToDoc` — the guarded in-memory title write. `now_ms` is
/// injected for test determinism (`Date.now()` at the TS call site).
pub fn apply_title_to_doc(
    doc: &mut Value,
    title: &str,
    gen_count: i64,
    now_ms: i64,
) -> Result<bool, String> {
    // `if (!meta || !title)` — falsy meta (missing/null/0/""/false) or "".
    let meta_truthy = doc.get("meta").map(jsstr::js_truthy).unwrap_or(false);
    if !meta_truthy || title.is_empty() {
        return Ok(false);
    }
    if doc
        .get("meta")
        .and_then(|m| m.get("titleSource"))
        .and_then(Value::as_str)
        == Some("manual")
    {
        return Ok(false);
    }
    if let Some(g) = doc
        .get("meta")
        .and_then(|m| m.get("titleGenCount"))
        .and_then(Value::as_f64)
    {
        if g > gen_count as f64 {
            return Ok(false);
        }
    }
    let Some(meta_map) = doc.get_mut("meta").and_then(Value::as_object_mut) else {
        // Truthy ARRAY meta: TS assigns the props ONTO the array (arrays
        // are objects — no throw, returns true) and JSON.stringify drops
        // them at write time ⇒ persisted doc unchanged. Rust mirrors the
        // observable outcome: Ok(true), array untouched (see header).
        if doc.get("meta").is_some_and(|m| m.is_array()) {
            return Ok(true);
        }
        // Primitive meta ⇒ TS strict-mode TypeError (see header).
        return Err(
            "applyTitleToDoc: title assignment on primitive meta (strict-mode TypeError parity)"
                .into(),
        );
    };
    meta_map.insert("title".into(), Value::String(title.to_string()));
    meta_map.insert("titleSource".into(), Value::String("auto".into()));
    meta_map.insert(
        "titleGenCount".into(),
        Value::Number(Number::from(gen_count)),
    );
    meta_map.insert("titleGenAt".into(), Value::Number(Number::from(now_ms)));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn first_user_text_table() {
        assert_eq!(first_user_text(&v("[]")), "");
        assert_eq!(first_user_text(&v("[{\"role\":\"system\",\"content\":\"s\"},{\"role\":\"user\",\"content\":\"  hi  \"}]")), "  hi  "); // RAW, untrimmed
                                                                                                                                           // First user message TERMINATES: a blank one yields "" even if a
                                                                                                                                           // later user message has text.
        assert_eq!(
            first_user_text(&v(
                "[{\"role\":\"user\",\"content\":\"\"},{\"role\":\"user\",\"content\":\"later\"}]"
            )),
            ""
        );
        // Parts array: first part with non-blank trimmed text wins, RAW.
        assert_eq!(
            first_user_text(&v("[{\"role\":\"user\",\"content\":[{\"text\":\"  \"},{\"text\":\" P2 \"},{\"text\":\"p3\"}]}]")),
            " P2 "
        );
        assert_eq!(
            first_user_text(&v("[{\"role\":\"user\",\"content\":[{\"nope\":1}]}]")),
            ""
        );
        assert_eq!(
            first_user_text(&v("[{\"role\":\"user\",\"content\":null}]")),
            ""
        );
        // FEFF counts as JS ws ⇒ parts with only FEFF are blank. (JSON
        // escape form — serde rejects the JS `\u{…}` spelling.)
        assert_eq!(
            first_user_text(&v(
                "[{\"role\":\"user\",\"content\":[{\"text\":\"\\ufeff\"},{\"text\":\"next\"}]}]"
            )),
            "next"
        );
    }

    #[test]
    fn looks_auto_title_table() {
        assert!(looks_auto_title("", "anything"));
        assert!(looks_auto_title("  ", "anything")); // trimmed blank
        assert!(looks_auto_title("New conversation", "anything"));
        assert!(looks_auto_title("Untitled", "anything"));
        // Exact 40-unit raw prefix.
        let first = "a quick brown fox jumps over the lazy dog repeatedly";
        let prefix = jsstr::js_slice_head(first, 40); // "a quick brown fox jumps over the lazy dog " → 40 units
        assert!(looks_auto_title(&prefix, first));
        // Collapsed variant: a long double-spaced first text only matches
        // its COLLAPSED 40-unit prefix (the raw prefix keeps the double
        // space); TS `first.replace(/\s+/g," ").slice(0,40)` verbatim.
        let spaced = "a  quick brown";
        let full = format!("{spaced} tail never included here at all ever not at all");
        let collapsed_prefix = jsstr::js_slice_head(&jsstr::js_collapse(full.trim()), 40);
        assert!(looks_auto_title(&collapsed_prefix, &full));
        assert_ne!(jsstr::js_slice_head(full.trim(), 40), collapsed_prefix);
        // RAW arm with the double space intact (first text ≤ 40 units —
        // interior whitespace is NOT normalized by trim).
        assert!(looks_auto_title(spaced, spaced));
        // Not a prefix ⇒ user-authored.
        assert!(!looks_auto_title("Some other subject entirely", first));
        // No first text ⇒ only placeholders are auto.
        assert!(!looks_auto_title("Whatever", ""));
        // slice(0,40) counts UTF-16 units, not chars: a 25-char astral
        // text (50 units) has a 40-unit prefix of exactly 20 astral chars.
        let units = "\u{1D54F}".repeat(25);
        let head40 = jsstr::js_slice_head(&units, 40);
        assert_eq!(head40.chars().count(), 20);
        assert!(looks_auto_title(&head40, &units));
        assert!(!looks_auto_title(&"\u{1D54F}".repeat(21), &units));
    }

    #[test]
    fn should_generate_table() {
        assert!(!should_generate(
            &v("{\"titleSource\":\"manual\"}"),
            100,
            true
        )); // manual beats force
        assert!(should_generate(&v("{}"), 1, true));
        assert!(!should_generate(&v("{}"), 1, false));
        assert!(should_generate(&v("{}"), 2, false)); // never generated, full exchange
        assert!(!should_generate(&v("{\"titleGenCount\":10}"), 13, false)); // 3 < 4
        assert!(should_generate(&v("{\"titleGenCount\":10}"), 14, false)); // 4 >= 4
        assert!(!should_generate(&v("{\"titleGenCount\":10}"), 9, false)); // shrink-guard
                                                                           // titleGenCount as a STRING is not a number ⇒ first-time rule.
        assert!(should_generate(&v("{\"titleGenCount\":\"10\"}"), 2, false));
        // Null meta (no meta key) ⇒ first-time rule.
        assert!(should_generate(&Value::Null, 5, false));
        // Float counts (JS typeof number): 14 - 10.5 = 3.5 < 4; 15 - 10.5 = 4.5 >= 4.
        assert!(!should_generate(&v("{\"titleGenCount\":10.5}"), 14, false));
        assert!(should_generate(&v("{\"titleGenCount\":10.5}"), 15, false));
    }

    #[test]
    fn apply_guards_and_writes() {
        let mut d = v("{\"id\":\"c\",\"meta\":{\"titleSource\":\"manual\",\"title\":\"keep\"},\"messages\":[]}");
        assert_eq!(apply_title_to_doc(&mut d, "new", 9, 123), Ok(false)); // manual
        let mut d = v("{\"meta\":{\"titleGenCount\":9}}");
        assert_eq!(apply_title_to_doc(&mut d, "new", 8, 123), Ok(false)); // newer stored generation
        let mut d = v("{\"meta\":null}");
        assert_eq!(apply_title_to_doc(&mut d, "new", 8, 123), Ok(false)); // falsy meta
        let mut d = v("{\"meta\":{}}");
        assert_eq!(apply_title_to_doc(&mut d, "", 8, 123), Ok(false)); // falsy title
        let mut d = v("[]");
        assert_eq!(apply_title_to_doc(&mut d, "t", 8, 123), Ok(false)); // array doc: no meta

        let mut d =
            v("{\"id\":\"c\",\"meta\":{\"title\":\"old\"},\"updatedAt\":55,\"messages\":[]}");
        assert_eq!(
            apply_title_to_doc(&mut d, "Fresh Title", 7, 1761534562345),
            Ok(true)
        );
        assert_eq!(d["meta"]["title"], v("\"Fresh Title\""));
        assert_eq!(d["meta"]["titleSource"], v("\"auto\""));
        assert_eq!(d["meta"]["titleGenCount"], v("7"));
        assert_eq!(d["meta"]["titleGenAt"], v("1761534562345"));
        // updatedAt deliberately NOT bumped (sidebar order preserved).
        assert_eq!(d["updatedAt"], v("55"));
        // Equal count is allowed (not newer).
        let mut d = v("{\"meta\":{\"titleGenCount\":7}}");
        assert_eq!(apply_title_to_doc(&mut d, "again", 7, 1), Ok(true));

        // Truthy NON-object meta ⇒ strict-mode TypeError parity ⇒ Err.
        let mut d = v("{\"meta\":\"weird\"}");
        assert!(apply_title_to_doc(&mut d, "t", 1, 1).is_err());
        let mut d = v("{\"meta\":[1,2]}"); // array meta: truthy; TS would set props ON the array (allowed!) — arrays ARE objects
        assert_eq!(apply_title_to_doc(&mut d, "t", 1, 1), Ok(true)); // arrays take properties fine in JS
        assert_eq!(d["meta"][0], v("1")); // elements intact
    }
}
