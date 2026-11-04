//! User-tier slash-command routing — verbatim port of `lib/skills/lazy.ts`
//! (§11: ported into Rust but kept DISCONNECTED from live chat routes; the
//! TS side still owns live traffic in Part 3).
//!
//! Parity subtlety: JS `String.replace(re, replacementString)` interprets
//! `$`-patterns in the replacement. The user's own remainder text becomes
//! the replacement string, so a prompt like `/alpha beta $1` really does
//! expand `$1` to capture #1 in the ARRAY-content branch (string-content
//! branch assigns the remainder directly — no expansion). [`js_expand`]
//! reproduces that quirk instead of "fixing" it.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::jsstr::js_truthy;
use crate::jsstr::js_trim;
use crate::registry::{load_skill_bundle, read_scenario, skill_exists};

/// `SLASH_COMMAND` in lazy.ts: `/^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i`.
/// ASCII-only classes; the capture keeps the user's original case.
static SLASH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$").unwrap()
});

/// `extractUserText`: string content passes through; array content joins
/// its per-part `text` fields (non-string/non-text parts contribute "")
/// with "\n"; anything else is "".
pub fn extract_user_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|p| match p {
                Value::String(s) => s.clone(),
                _ => p.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `lastUserIndex`: reverse scan for role == "user"; missing entries and
/// non-objects have role undefined and are skipped (`messages[i]?.role`).
pub fn last_user_index(messages: &[Value]) -> Option<usize> {
    (0..messages.len())
        .rev()
        .find(|&i| messages[i].get("role").and_then(Value::as_str) == Some("user"))
}

/// `injectSystemBefore`: JS `splice(index, 0, {role:"system", content})` —
/// in-place insertion. `index` is always in-bounds at the call sites; the
/// clamp keeps the function total.
pub fn inject_system_before(messages: &mut Vec<Value>, index: usize, content: String) {
    messages.insert(index.min(messages.len()), json!({ "role": "system", "content": content }));
}

/// `activeSkillBlock(skillName, skillBody)`.
pub fn active_skill_block(skill_name: &str, skill_body: &str) -> String {
    format!(
        "<active_skill name=\"{skill_name}\">\n{skill_body}\n</active_skill>\nThe skill above is active for this request only. Follow its instructions exactly."
    )
}

/// `slashSkillName(text)`: `SLASH_COMMAND.exec(text.trim())?.[1] ?? null` —
/// case preserved from the input.
pub fn slash_skill_name(text: &str) -> Option<&str> {
    // get(1).as_str() ties the returned slice to the haystack's lifetime
    // (an indexed `&caps[1]` would instead borrow the Captures temporary).
    SLASH_RE
        .captures(js_trim(text))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
}

/// JS `String.prototype.replace(re, replacement)` for a single anchored
/// first match, with the replacement's `$`-patterns expanded per ECMA
/// GetSubstitution: `$$`, `$&`, `` $` ``, `$'`, and `$n` (the two-digit
/// group form is tried first, falling back to the one-digit form; a
/// non-participating/absent group leaves the text literal). Group 0 is NOT
/// special (`$0` stays literal, matching V8).
fn js_replace_first(re: &Regex, haystack: &str, replacement: &str) -> String {
    let Some(caps) = re.captures(haystack) else {
        return haystack.to_string();
    };
    let whole = caps.get(0).expect("capture 0 always present");
    let mut out = String::with_capacity(haystack.len());
    out.push_str(&haystack[..whole.start()]);

    let mut it = replacement.chars().peekable();
    while let Some(c) = it.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match it.peek().copied() {
            Some('$') => {
                it.next();
                out.push('$');
            }
            Some('&') => {
                it.next();
                out.push_str(whole.as_str());
            }
            Some('`') => {
                it.next();
                out.push_str(&haystack[..whole.start()]);
            }
            Some('\'') => {
                it.next();
                out.push_str(&haystack[whole.end()..]);
            }
            Some(d) if d.is_ascii_digit() => {
                it.next(); // consume the first digit
                let d1 = d.to_digit(10).expect("ascii digit") as usize;
                // ECMA GetSubstitution: up to two digits form the group
                // ref; the two-digit ref wins ONLY when that group
                // participated, otherwise the one-digit ref, otherwise the
                // text stays literal ("$12" with 2 groups -> cap1 + "2").
                let two = match it.peek().copied() {
                    Some(c2) if c2.is_ascii_digit() => {
                        let cand = d1 * 10 + c2.to_digit(10).expect("ascii digit") as usize;
                        (cand >= 1 && caps.get(cand).is_some()).then_some(cand)
                    }
                    _ => None,
                };
                if let Some(n) = two {
                    it.next(); // consume the second digit
                    out.push_str(caps.get(n).expect("checked above").as_str());
                } else if d1 >= 1 && caps.get(d1).is_some() {
                    out.push_str(caps.get(d1).expect("checked above").as_str());
                } else {
                    out.push('$');
                    out.push(d);
                }
            }
            Some(_) | None => out.push('$'), // lone `$` or `$x` stays literal
        }
    }
    out.push_str(&haystack[whole.end()..]);
    out
}

/// `stripSlashPrefix(message, fullText)`: string content is set to the
/// (trimmed) remainder directly; for array content the FIRST part whose
/// `text` is a string is rewritten with
/// `part.text.replace(SLASH_COMMAND, remainder)` (JS `$`-expansion) and
/// the loop then breaks — even when the regex did not match that part.
pub fn strip_slash_prefix(message: &mut Value, full_text: &str) {
    let caps = SLASH_RE.captures(js_trim(full_text));
    // JS: (match?.[2] ?? "").trim()
    let remainder = js_trim(caps.as_ref().and_then(|c| c.get(2)).map_or("", |m| m.as_str()));

    match message.get_mut("content") {
        Some(Value::String(_)) => {
            message["content"] = Value::String(remainder.to_string());
        }
        Some(Value::Array(_)) => {
            let parts = message["content"].as_array_mut().expect("checked above");
            for part in parts.iter_mut() {
                match part.get_mut("text") {
                    Some(Value::String(text)) => {
                        *text = js_replace_first(&SLASH_RE, text, remainder);
                        break;
                    }
                    _ => continue, // typeof part?.text !== "string" -> continue
                }
            }
        }
        _ => {}
    }
}

/// `applySlashSkillRouting(payload, root)`: every TS guard is ported
/// one-for-one; on success the payload is mutated IN PLACE (system message
/// injected before the last user message + slash prefix stripped) and the
/// skill name is returned. `None` everywhere the TS returns null.
pub fn apply_slash_skill_routing(payload: &mut Value, root: &Path) -> Option<String> {
    // `payload?.messages`; !Array.isArray(messages) || messages.length === 0
    let messages = payload.get("messages")?.as_array()?;
    if messages.is_empty() {
        return None;
    }
    let last_idx = last_user_index(messages)?; // -1 -> null

    // extractUserText(messages[lastUserIdx].content) — a missing content
    // behaves like undefined -> "".
    let content = messages
        .get(last_idx)
        .and_then(|m| m.get("content"))
        .cloned()
        .unwrap_or(Value::Null);
    let text = extract_user_text(&content);
    if js_trim(&text).is_empty() {
        return None;
    }
    let skill_name = slash_skill_name(&text)?.to_string();

    let scenario = read_scenario(root, &skill_name)?;
    let enabled = scenario.get("enabled").map(js_truthy).unwrap_or(false);
    if !enabled {
        return None;
    }
    if !skill_exists(root, &skill_name) {
        return None;
    }
    let bundle = load_skill_bundle(root, &skill_name)?;
    if bundle.is_empty() {
        return None; // JS `!bundle` — "" is falsy
    }

    let messages = payload.get_mut("messages")?.as_array_mut()?;
    strip_slash_prefix(&mut messages[last_idx], &text);
    inject_system_before(messages, last_idx, active_skill_block(&skill_name, &bundle));
    Some(skill_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn extract_user_text_table() {
        assert_eq!(extract_user_text(&json!("plain")), "plain");
        assert_eq!(
            extract_user_text(&json!([
                "head",
                { "type": "text", "text": "mid" },
                { "type": "image" },
                null,
                42
            ])),
            "head\nmid\n\n\n"
        );
        assert_eq!(extract_user_text(&json!(42)), "");
        assert_eq!(extract_user_text(&Value::Null), "");
    }

    #[test]
    fn slash_name_keeps_case_and_class_ascii() {
        assert_eq!(slash_skill_name("/Humanizer-2.x do it"), Some("Humanizer-2.x"));
        assert_eq!(slash_skill_name("  /skill\n\nbody  "), Some("skill"));
        assert_eq!(slash_skill_name("no slash"), None);
        assert_eq!(slash_skill_name("/2skill ok"), Some("2skill"));
        assert_eq!(slash_skill_name("/ skill x"), None); // name must be [a-z0-9]
        assert_eq!(slash_skill_name("/日本 x"), None);
    }

    #[test]
    fn strip_prefix_string_content_assigns_remainder_directly() {
        // NOTE: no $-expansion for the string branch (direct assignment).
        let mut msg = json!({ "role": "user", "content": "/alpha b $1 c" });
        strip_slash_prefix(&mut msg, "/alpha b $1 c");
        assert_eq!(msg["content"], "b $1 c");

        // Array branch: JS replace EXPANDS $1 -> capture 1 ("alpha").
        let mut msg = json!({ "role": "user", "content": [{ "type": "text", "text": "/alpha beta $1" }] });
        strip_slash_prefix(&mut msg, "/alpha beta $1");
        assert_eq!(msg["content"][0]["text"], "beta alpha");

        // Array branch skips non-text parts, breaks after first string part.
        let mut msg = json!({ "role": "user", "content": [
            { "type": "image" },
            { "type": "text", "text": "/alpha rest" },
            { "type": "text", "text": "/alpha second" }
        ] });
        strip_slash_prefix(&mut msg, "/alpha rest");
        assert_eq!(msg["content"][0]["type"], "image");
        assert_eq!(msg["content"][1]["text"], "rest");
        assert_eq!(msg["content"][2]["text"], "/alpha second"); // untouched

        // No-slash text with array content: replace no-op, still breaks.
        let mut msg = json!({ "role": "user", "content": [{ "text": "keep $& me" }] });
        strip_slash_prefix(&mut msg, "keep $& me");
        assert_eq!(msg["content"][0]["text"], "keep $& me");
    }

    #[test]
    fn js_replace_dollar_patterns_follow_ecma_getsubstitution() {
        let r = |re: &str, hay: &str, rep: &str| {
            js_replace_first(&Regex::new(re).unwrap(), hay, rep)
        };
        assert_eq!(r(r"(?i)^/([a-z0-9]+)(?:\s+([\s\S]*))?$", "/ab cd $1 x", "cd $1x"), "cd abx");
        assert_eq!(r(r"(a)(b)", "ab", "$2$1"), "ba");
        // $12: two-digit form falls back to $1, second digit stays literal.
        assert_eq!(r(r"(a)(b)", "ab", "$12"), "a2");
        // $0 and missing group references stay literal.
        assert_eq!(r(r"(a)", "a", "$0"), "$0");
        assert_eq!(r(r"(a)(b)", "ab", "$9"), "$9");
        assert_eq!(r(r"(a)", "a", "$$"), "$");
        // $` = text BEFORE the match: whole-string match -> empty prefix.
        assert_eq!(r(r"(a)(b)", "ab", "$`"), "");
        assert_eq!(r(r"(a)(b)", "xaby", "$`"), "xxy");
        // $' = text AFTER the match; the trailing text also survives as
        // the unmatched tail, so it appears twice in the output.
        assert_eq!(r(r"(a)(b)", "abx", "$'"), "xx");
        assert_eq!(r(r"(a)(b)", "xaby", "$'"), "xyy");
    }

    fn routing_root(scenario: &str, skill_md: &str) -> tempfile::TempDir {
        let tmp = tempfile::TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("skill-scenarios")).unwrap();
        fs::write(tmp.path().join("skill-scenarios/demo.json"), scenario).unwrap();
        fs::create_dir_all(tmp.path().join("skills/demo")).unwrap();
        fs::write(tmp.path().join("skills/demo/SKILL.md"), skill_md).unwrap();
        tmp
    }

    #[test]
    fn apply_success_mutates_payload_exactly_like_ts() {
        let tmp = routing_root(
            "{\"skillName\":\"demo\",\"enabled\":true}",
            "Body text here",
        );
        let mut payload = json!({
            "model": "m",
            "messages": [{ "role": "user", "content": "/demo  do the thing " }]
        });
        let applied = apply_slash_skill_routing(&mut payload, tmp.path());
        assert_eq!(applied.as_deref(), Some("demo"));
        let msgs = payload["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(
            msgs[0]["content"],
            "<active_skill name=\"demo\">\nBody text here\n</active_skill>\nThe skill above is active for this request only. Follow its instructions exactly."
        );
        assert_eq!(msgs[1]["content"], "do the thing"); // trimmed remainder
    }

    #[test]
    fn apply_guards_return_null_without_mutating() {
        // scenario disabled
        let tmp = routing_root("{\"enabled\":false}", "B");
        let mut payload = json!({ "messages": [{ "role": "user", "content": "/demo x" }] });
        let before = payload.clone();
        assert_eq!(apply_slash_skill_routing(&mut payload, tmp.path()), None);
        assert_eq!(payload, before);

        // enabled null -> falsy
        let tmp = routing_root("{\"enabled\":null}", "B");
        let mut payload = json!({ "messages": [{ "role": "user", "content": "/demo x" }] });
        assert_eq!(apply_slash_skill_routing(&mut payload, tmp.path()), None);

        // scenario missing / skill file missing / empty bundle
        let tmp = tempfile::TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("skills/demo")).unwrap();
        fs::write(tmp.path().join("skills/demo/SKILL.md"), "").unwrap();
        let mut payload = json!({ "messages": [{ "role": "user", "content": "/demo x" }] });
        assert_eq!(apply_slash_skill_routing(&mut payload, tmp.path()), None);

        let tmp = routing_root("{\"enabled\":true}", "B");
        let mut payload = json!({ "messages": [{ "role": "user", "content": "/ghost x" }] });
        assert_eq!(apply_slash_skill_routing(&mut payload, tmp.path()), None);

        // no user message / empty messages / no messages
        let mut payload = json!({ "messages": [{ "role": "assistant", "content": "a" }] });
        assert_eq!(apply_slash_skill_routing(&mut payload, tmp.path()), None);
        let mut payload = json!({ "messages": [] });
        assert_eq!(apply_slash_skill_routing(&mut payload, tmp.path()), None);
        let mut payload = json!({ "model": "m" });
        assert_eq!(apply_slash_skill_routing(&mut payload, tmp.path()), None);
    }

    #[test]
    fn apply_injects_before_last_user_not_first() {
        let tmp = routing_root("{\"enabled\":true}", "B");
        let mut payload = json!({ "messages": [
            { "role": "user", "content": "old turn" },
            { "role": "assistant", "content": "reply" },
            { "role": "user", "content": "/demo new" }
        ] });
        assert_eq!(apply_slash_skill_routing(&mut payload, tmp.path()).as_deref(), Some("demo"));
        let msgs = payload["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["content"], "old turn");
        assert_eq!(msgs[2]["role"], "system"); // index 2 = last user position
        assert_eq!(msgs[3]["content"], "new");
    }
}
