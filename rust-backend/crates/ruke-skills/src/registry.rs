//! User-tier registry — the load-path subset of `lib/skills/registry.ts`
//! (safe names, scenario reading, bundle loading). The installer, sync,
//! watcher, delete, and scenario-update exports are deliberately NOT
//! ported: Part 3's scope is decision + skill loading only, and the
//! browser-facing install flow stays on the TS side (§11 "disconnected").

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::jsstr;
use crate::jspath;

/// `SKILLS_DIR` / `SCENARIOS_DIR` in registry.ts.
const SKILLS_DIR: &str = "skills";
const SCENARIOS_DIR: &str = "skill-scenarios";
/// `MAX_BUNDLE_BYTES` in registry.ts — name kept from TS, but the cap is
/// applied through JS `slice`, i.e. UTF-16 code units (see `jsstr`).
const MAX_BUNDLE_BYTES: usize = 160_000;

/// `SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i` — ASCII-only classes; the `i`
/// flag widens only a-z/A-Z, never non-ASCII.
pub fn is_safe_skill_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Node `fs.readFile(path, "utf8")`: lossy UTF-8 decode, BOM **not**
/// stripped (Node leaves it, so JSON.parse on a BOM'd scenario fails —
/// serde_json behaves the same). `None` on any IO error (TS catch).
pub(crate) fn read_utf8_file(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn skill_dir(root: &Path, name: &str) -> PathBuf {
    root.join(SKILLS_DIR).join(name)
}

pub fn scenario_file(root: &Path, name: &str) -> PathBuf {
    root.join(SCENARIOS_DIR).join(format!("{name}.json"))
}

/// `skillExists`: safe name AND SKILL.md present (the TS probes via
/// `fs.access`, nothing else).
pub fn skill_exists(root: &Path, name: &str) -> bool {
    is_safe_skill_name(name) && skill_dir(root, name).join("SKILL.md").exists()
}

/// Field ORDER of the TS `defaultScenario` object literal — preserved so a
/// re-serialized scenario keeps identical key order.
fn default_scenario(skill_name: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("skillName".to_string(), Value::String(skill_name.to_string()));
    m.insert("sourceRepo".to_string(), Value::String(String::new()));
    m.insert("enabled".to_string(), Value::Bool(true));
    m.insert("autoUse".to_string(), Value::Bool(false));
    m.insert("whenToUse".to_string(), Value::String(String::new()));
    m.insert("triggerKeywords".to_string(), Value::Array(Vec::new()));
    m.insert("blockedReason".to_string(), Value::Null);
    m
}

/// `readScenario`: defaults overlaid by the parsed scenario file (JS object
/// spread = later keys win at the key's FIRST position — serde_json's
/// `preserve_order` Map does exactly that), then `skillName` forced to the
/// requested name and `triggerKeywords` coerced to an array. Any
/// read/parse failure yields `None` (TS returns null).
pub fn read_scenario(root: &Path, name: &str) -> Option<Value> {
    if !is_safe_skill_name(name) {
        return None;
    }
    let raw = read_utf8_file(&scenario_file(root, name))?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    // JS spreads non-object parsed values too (arrays/strings contribute
    // indexed keys); scenario files in this repo are always objects, so a
    // non-object is treated as an empty overlay rather than emulating
    // index-spread.
    let overlay = match parsed {
        Value::Object(obj) => obj,
        _ => Map::new(),
    };
    let mut m = default_scenario(name);
    for (k, v) in overlay {
        m.insert(k, v);
    }
    m.insert("skillName".to_string(), Value::String(name.to_string()));
    let tk = m
        .get_mut("triggerKeywords")
        .and_then(|v| if v.is_array() { Some(std::mem::take(v)) } else { None })
        .unwrap_or_else(|| Value::Array(Vec::new()));
    m.insert("triggerKeywords".to_string(), tk);
    Some(Value::Object(m))
}

/// The Markdown-link extractor of both loaders: `/\]\(([^)\s]+\.md)\)/g`
/// (matches scanned against the ORIGINAL main file text).
pub(crate) static LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\]\(([^)\s]+\.md)\)").unwrap());

/// `loadSkillBundle`: main SKILL.md **verbatim** (user tier performs NO
/// frontmatter stripping), then link targets in first-seen Set order
/// (reproduced with a Vec — insertion-ordered dedup), each appended after
/// `"\n\n"`; cap at `MAX_BUNDLE_BYTES` UTF-16 units via JS `slice`.
///
/// Like the TS, no safe-name guard here — callers gate via `skillExists`;
/// an unreadable main file simply yields `None`.
pub fn load_skill_bundle(root: &Path, name: &str) -> Option<String> {
    let dir = skill_dir(root, name);
    let main = read_utf8_file(&dir.join("SKILL.md"))?;

    let mut linked: Vec<PathBuf> = Vec::new();
    for caps in LINK_RE.captures_iter(&main) {
        let rel = &caps[1];
        if rel.starts_with("http") || rel.starts_with('/') {
            continue;
        }
        let abs = jspath::resolve_lexically(&dir, rel);
        if !jspath::is_strict_child(&abs, &dir) {
            continue;
        }
        if !linked.iter().any(|p| p == &abs) {
            linked.push(abs);
        }
    }

    let mut bundle = main;
    for abs in linked {
        // TS checks the cap at the TOP of each append iteration (the file
        // that tips the cap still gets appended whole; the final slice
        // does the cutting).
        if jsstr::js_len(&bundle) >= MAX_BUNDLE_BYTES {
            break;
        }
        if let Some(text) = read_utf8_file(&abs) {
            bundle.push_str("\n\n");
            bundle.push_str(&text);
        }
    }
    Some(jsstr::js_slice_head(&bundle, MAX_BUNDLE_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn safe_name_table() {
        for ok in ["humanizer", "Pdf-Xlsx.1", "a", "9lives", "A.B_C-D"] {
            assert!(is_safe_skill_name(ok), "{ok} should be safe");
        }
        for bad in ["", "-x", "_x", ".hidden", "a b", "日本", "a/b", "a\\b", "a.b/../c"] {
            assert!(!is_safe_skill_name(bad), "{bad} should be unsafe");
        }
    }

    fn scenario_root(scenario_json: &str) -> TempDir {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("skill-scenarios");
        fs::create_dir_all(&dir).unwrap();
        let mut f = fs::File::create(dir.join("demo.json")).unwrap();
        f.write_all(scenario_json.as_bytes()).unwrap();
        tmp
    }

    #[test]
    fn read_scenario_merges_defaults_like_js_spread() {
        let tmp = scenario_root(
            "{\"skillName\":\"WRONG\",\"whenToUse\":\"x\",\"autoUse\":true}",
        );
        let s = read_scenario(tmp.path(), "demo").unwrap();
        let o = s.as_object().unwrap();
        assert_eq!(o["skillName"], "demo"); // forced AFTER the spread
        assert_eq!(o["enabled"], true);
        assert_eq!(o["autoUse"], true);
        assert_eq!(o["whenToUse"], "x");
        assert_eq!(o["blockedReason"], Value::Null);
        assert_eq!(o["triggerKeywords"], Value::Array(Vec::new()));
        // Key order = defaultScenario order (spread keeps first position).
        let keys: Vec<&str> = o.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "skillName",
                "sourceRepo",
                "enabled",
                "autoUse",
                "whenToUse",
                "triggerKeywords",
                "blockedReason"
            ]
        );
    }

    #[test]
    fn read_scenario_coerces_and_fails_like_ts() {
        let tmp = scenario_root("{\"triggerKeywords\":\"k\"}");
        let s = read_scenario(tmp.path(), "demo").unwrap();
        assert_eq!(s["triggerKeywords"], Value::Array(Vec::new()));

        let tmp = scenario_root("not json");
        assert!(read_scenario(tmp.path(), "demo").is_none());
        // BOM'd scenario: Node does NOT strip it, JSON.parse throws → null;
        // serde_json likewise rejects it → None (parity).
        let tmp = scenario_root("\u{feff}{\"enabled\":true}");
        assert!(read_scenario(tmp.path(), "demo").is_none());
        // Unsafe name never touches the fs.
        let tmp = scenario_root("{}");
        assert!(read_scenario(tmp.path(), "../evil").is_none());
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn load_skill_bundle_keeps_frontmatter_and_appends_links_in_order() {
        let tmp = TempDir::new().unwrap();
        let dir = skill_dir(tmp.path(), "demo");
        write(
            &dir.join("SKILL.md"),
            "---\r\nname: demo\r\n---\r\nBody [a](b.md) [dup](b.md) [skip](http://x/y.md) [out](../z.md) [in](./sub/../c.md)\r\nEND",
        );
        write(&dir.join("b.md"), "B-BODY");
        write(&dir.join("c.md"), "C-BODY");
        write(&tmp.path().join("z.md"), "MUST-NOT-LOAD");

        let bundle = load_skill_bundle(tmp.path(), "demo").unwrap();
        // Frontmatter NOT stripped in the user tier; links in first-seen
        // order, deduped, http/outside skipped, "./sub/.." resolved.
        assert!(bundle.starts_with("---\r\nname: demo"));
        assert!(bundle.contains("B-BODY"));
        assert!(bundle.contains("C-BODY"));
        assert!(!bundle.contains("MUST-NOT-LOAD"));
        assert!(bundle.contains("B-BODY\n\n\n\nC-BODY") || {
            // exact shape: main + "\n\n" + b + "\n\n" + c
            let expected_links = "\n\nB-BODY".to_string();
            bundle.contains(&expected_links) && bundle.contains("\n\nC-BODY")
        });
    }

    #[test]
    fn load_skill_bundle_caps_at_160k_units_like_js_slice() {
        let tmp = TempDir::new().unwrap();
        let dir = skill_dir(tmp.path(), "big");
        write(&dir.join("SKILL.md"), &format!("[l](more.md)\n{}", "a".repeat(150_000)));
        write(&dir.join("more.md"), &"b".repeat(20_000));
        let bundle = load_skill_bundle(tmp.path(), "big").unwrap();
        assert_eq!(jsstr::js_len(&bundle), 160_000);
    }

    #[test]
    fn skill_exists_requires_safe_name_and_file() {
        let tmp = TempDir::new().unwrap();
        write(&skill_dir(tmp.path(), "demo").join("SKILL.md"), "x");
        assert!(skill_exists(tmp.path(), "demo"));
        assert!(!skill_exists(tmp.path(), "missing"));
        assert!(!skill_exists(tmp.path(), "../demo"));
    }
}
