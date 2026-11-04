//! User-tier registry — the full `lib/skills/registry.ts` port EXCEPT the
//! debounced file watcher: safe names, scenario reading, bundle loading
//! (Part 3) plus the Part-7 install-request parsing, sync, delete,
//! scenario-update and description exports.
//!
//! RECORDED MICRO-DIVERGENCE: `startSkillWatcher` is not ported (and no
//! notify crate is added). The TS GET /api/skills calls it, but GET also
//! awaits a full sync on every request, so sync RESULTS are identical —
//! only "temp-dir changes noticed between requests without any GET"
//! disappears, which no request path observes. `runInstall` (the npx
//! subprocess) lives in ruke-server `skills_install.rs`, not here — this
//! crate stays dependency-light (parse only).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::frontmatter;
use crate::jsstr;
use crate::jspath;
use crate::modality;

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

/// `defaultScenario(skillName, sourceRepo = "")`. Field ORDER of the TS
/// object literal — preserved so a re-serialized scenario keeps identical
/// key order.
pub fn default_scenario(skill_name: &str, source_repo: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("skillName".to_string(), Value::String(skill_name.to_string()));
    m.insert("sourceRepo".to_string(), Value::String(source_repo.to_string()));
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
    let mut m = default_scenario(name, "");
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

// ---------------------------------------------------------------------------
// Part 7: install-request parsing, sync, delete, scenario update,
// description. Ported verbatim from registry.ts.
// ---------------------------------------------------------------------------

/// `TEMP_SKILL_DIRS` — the `npx skills` landing zones. Path::join tolerates
/// the embedded `/` on Windows (kernel-level normalization), matching
/// Node's `path.join` result for these two literals.
const TEMP_SKILL_DIRS: [&str; 2] = [".agents/skills", ".claude/skills"];

/// `SAFE_TOKEN = /^[A-Za-z0-9._:@/+-]+$/` — the npx token gate.
static SAFE_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._:@/+-]+$").unwrap());

/// `projectRoot()`: `process.env.WEBUI_SKILLS_ROOT ?? process.cwd()` —
/// NULLISH, not falsy: an empty-string env value counts as SET in Node
/// (root "" ⇒ path joins behave relative), and `var_os`'s `Some("")`
/// reproduces that exactly. Micro-divergence: if `current_dir()` fails
/// (deleted cwd) Node throws at call time; Rust falls back to "." —
/// unreachable inside the server process.
pub fn project_root() -> PathBuf {
    match std::env::var_os("WEBUI_SKILLS_ROOT") {
        Some(v) => PathBuf::from(v),
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

/// `pathExists`: `fs.access` ⇔ `Path::exists` (both false on any error).
fn path_exists(target: &Path) -> bool {
    target.exists()
}

/// `readdirSafe`: list names, `[]` on any error (ENOENT included).
fn readdir_safe(dir: &Path) -> Vec<String> {
    match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// `hasSkillMd(dir)` ⇔ `pathExists(path.join(dir, "SKILL.md"))`.
fn has_skill_md(dir: &Path) -> bool {
    dir.join("SKILL.md").exists()
}

/// `isBrokenLink`: lstat; NOT a symlink ⇒ false; stat (following) ok ⇒
/// false; ANY throw (lstat failure OR dangling stat) ⇒ true.
fn is_broken_link(target: &Path) -> bool {
    match fs::symlink_metadata(target) {
        Err(_) => true,
        Ok(md) => {
            if !md.file_type().is_symlink() {
                return false;
            }
            fs::metadata(target).is_err()
        }
    }
}

/// `fs.rm(p, { force: true })` — NON-recursive: unlinks files and
/// symlinks, suppresses only ENOENT; a real directory rejects (EISDIR),
/// as here.
fn remove_file_force(p: &Path) -> Result<(), String> {
    match fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// `fs.rm(p, { recursive: true, force: true })`. Symlinks are unlinked,
/// never followed (std and Node agree); missing ⇒ Ok.
fn remove_tree_force(p: &Path) -> Result<(), String> {
    let md = match fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if md.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// `fs.cp(src, dst, { recursive: true })` — the cross-volume fallback when
/// `rename` fails (Node catches and cp+rm's; the rm/cp rejections still
/// propagate out of sync ⇒ GET 500, mirrored via `?`).
///
/// RECORDED MICRO-DIVERGENCES: std has no recursive copy, so metadata
/// (mode/times) is not preserved — Node's defaults do not guarantee it
/// either on Windows; symlinks are re-created from their target string
/// (dir-ness probed through the link — Node reads the reparse tag; a
/// dangling link falls back to the file form, and Windows symlink
/// creation hits the same dev-mode privilege wall in both runtimes).
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    let md = fs::symlink_metadata(src)?;
    if md.file_type().is_symlink() {
        let target = fs::read_link(src)?;
        let is_dir = fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false);
        #[cfg(windows)]
        {
            if is_dir {
                std::os::windows::fs::symlink_dir(&target, dst)?;
            } else {
                std::os::windows::fs::symlink_file(&target, dst)?;
            }
        }
        #[cfg(unix)]
        {
            let _ = is_dir;
            std::os::unix::fs::symlink(&target, dst)?;
        }
        return Ok(());
    }
    if md.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p)?;
        }
        fs::copy(src, dst).map(|_| ())
    }
}

/// `removeDirIfEmpty`: readdirSafe (missing ⇒ `[]`) then `rm` recursive+
/// force — so a MISSING dir is removed "again" (ENOENT suppressed), which
/// is the same no-op as TS.
fn remove_dir_if_empty(dir: &Path) -> Result<(), String> {
    if readdir_safe(dir).is_empty() {
        remove_tree_force(dir)
    } else {
        Ok(())
    }
}

/// `listInstalledSkillNames`: safe names that hold a SKILL.md, `.sort()`.
/// JS default sort is UTF-16 code-unit order; every surviving name is
/// ASCII (SAFE_NAME), so Rust's byte sort is identical.
pub fn list_installed_skill_names(root: &Path) -> Vec<String> {
    let skills_root = root.join(SKILLS_DIR);
    let mut installed: Vec<String> = readdir_safe(&skills_root)
        .into_iter()
        .filter(|entry| is_safe_skill_name(entry) && has_skill_md(&skills_root.join(entry)))
        .collect();
    installed.sort();
    installed
}

/// `writeScenario`: recursive mkdir + the 7-key clean object literal
/// (literal ORDER preserved; keys missing from the input would stringify
/// to `undefined` and DROP — unreachable here, mirrored as omit-if-
/// absent) + `JSON.stringify(clean, null, 2) + "\n"` ⇔ to_string_pretty.
/// The path uses `scenario.skillName` (TS does too), NOT a validated
/// caller name — every real caller carries a scenario whose skillName was
/// already forced/constructed.
fn write_scenario(root: &Path, scenario: &Map<String, Value>) -> Result<(), String> {
    fs::create_dir_all(root.join(SCENARIOS_DIR)).map_err(|e| e.to_string())?;
    let mut clean = Map::new();
    for key in [
        "skillName",
        "sourceRepo",
        "enabled",
        "autoUse",
        "whenToUse",
        "triggerKeywords",
        "blockedReason",
    ] {
        if let Some(v) = scenario.get(key) {
            clean.insert(key.to_string(), v.clone());
        }
    }
    let name = scenario
        .get("skillName")
        .and_then(Value::as_str)
        .unwrap_or("undefined"); // TS would `path.join(…, undefined)` ⇒ reject ⇒ same 500 shape
    let body = serde_json::to_string_pretty(&Value::Object(clean)).map_err(|e| e.to_string())?;
    fs::write(scenario_file(root, name), format!("{body}\n")).map_err(|e| e.to_string())
}

/// `ensureScenario(root, skillName, sourceRepo = "")`: NEVER overwrites
/// an existing scenario; the only existing-scenario mutation is the
/// modality-block safety update when `enabled` is truthy AND
/// `blockedReason` is falsy.
pub fn ensure_scenario(
    root: &Path,
    skill_name: &str,
    source_repo: &str,
) -> Result<Value, String> {
    if let Some(Value::Object(mut existing)) = read_scenario(root, skill_name) {
        let needs_check = jsstr::js_truthy(existing.get("enabled").unwrap_or(&Value::Null))
            && !jsstr::js_truthy(existing.get("blockedReason").unwrap_or(&Value::Null));
        if needs_check {
            if let Some(blocked) = read_skill_markdown(root, skill_name)
                .as_deref()
                .and_then(modality::detect_blocked_reason)
            {
                existing.insert("enabled".to_string(), Value::Bool(false));
                existing.insert(
                    "blockedReason".to_string(),
                    Value::String(blocked.to_string()),
                );
                write_scenario(root, &existing)?;
            }
        }
        return Ok(Value::Object(existing));
    }
    let mut scenario = default_scenario(skill_name, source_repo);
    if let Some(blocked) = read_skill_markdown(root, skill_name)
        .as_deref()
        .and_then(modality::detect_blocked_reason)
    {
        scenario.insert("enabled".to_string(), Value::Bool(false));
        scenario.insert(
            "blockedReason".to_string(),
            Value::String(blocked.to_string()),
        );
    }
    write_scenario(root, &scenario)?;
    Ok(Value::Object(scenario))
}

/// `updateScenario(root, skillName, patch)`: per-field `typeof` gates —
/// wrong types are IGNORED (not rejected); `triggerKeywords.map(String)`
/// runs JS `String()` on every element (null ⇒ "null");
/// `blockedReason ?? null` accepts null and strings only.
pub fn update_scenario(
    root: &Path,
    skill_name: &str,
    patch: &Map<String, Value>,
) -> Result<Option<Value>, String> {
    let Some(Value::Object(mut merged)) = read_scenario(root, skill_name) else {
        return Ok(None);
    };
    if let Some(Value::Bool(b)) = patch.get("enabled") {
        merged.insert("enabled".to_string(), Value::Bool(*b));
    }
    if let Some(Value::Bool(b)) = patch.get("autoUse") {
        merged.insert("autoUse".to_string(), Value::Bool(*b));
    }
    if let Some(Value::String(s)) = patch.get("whenToUse") {
        merged.insert("whenToUse".to_string(), Value::String(s.clone()));
    }
    if let Some(Value::Array(arr)) = patch.get("triggerKeywords") {
        merged.insert(
            "triggerKeywords".to_string(),
            Value::Array(arr.iter().map(|v| Value::String(jsstr::js_to_string(v))).collect()),
        );
    }
    if let Some(Value::String(s)) = patch.get("sourceRepo") {
        merged.insert("sourceRepo".to_string(), Value::String(s.clone()));
    }
    match patch.get("blockedReason") {
        Some(Value::Null) => {
            merged.insert("blockedReason".to_string(), Value::Null);
        }
        Some(Value::String(s)) => {
            merged.insert("blockedReason".to_string(), Value::String(s.clone()));
        }
        _ => {}
    }
    write_scenario(root, &merged)?;
    Ok(Some(Value::Object(merged)))
}

/// `deleteSkill`: unsafe ⇒ false (no fs touched). `removed` = (skill
/// exists || scenario file exists) probed BEFORE any rm; then
/// rm recursive+force on the dir and rm force on the scenario file —
/// rejections propagate (TS `await` on both; a failed rm rejects the
/// route ⇒ 500, mirrored by `?`).
pub fn delete_skill(root: &Path, skill_name: &str) -> Result<bool, String> {
    if !is_safe_skill_name(skill_name) {
        return Ok(false);
    }
    let removed = skill_exists(root, skill_name) || path_exists(&scenario_file(root, skill_name));
    remove_tree_force(&skill_dir(root, skill_name))?;
    remove_file_force(&scenario_file(root, skill_name))?;
    Ok(removed)
}

/// `syncInstalledSkills(root)`: move temp installs into ./skills/, drop
/// broken links, clean duplicates (target-exists removes the SOURCE but
/// the entry still counts as discovered — `discovered.push` is OUTSIDE
/// the if/else), prune empty temp dirs, then ensure scenarios for every
/// installed name (sourceRepo default "").
pub fn sync_installed_skills(root: &Path) -> Result<Vec<String>, String> {
    let mut discovered: Vec<String> = Vec::new();
    for temp_rel in TEMP_SKILL_DIRS {
        let temp_abs = root.join(temp_rel);
        for entry in readdir_safe(&temp_abs) {
            let source = temp_abs.join(&entry);
            if !is_safe_skill_name(&entry) {
                continue;
            }
            if is_broken_link(&source) {
                remove_file_force(&source)?; // fs.rm(source, { force: true })
                continue;
            }
            if !has_skill_md(&source) {
                continue;
            }
            let target = skill_dir(root, &entry);
            if path_exists(&target) {
                remove_tree_force(&source)?;
            } else {
                fs::create_dir_all(root.join(SKILLS_DIR)).map_err(|e| e.to_string())?;
                if fs::rename(&source, &target).is_err() {
                    // EXDEV (different volume, e.g. temp dir on C: app on D:)
                    // ⇔ Node's try/catch cp + rm fallback.
                    copy_dir_all(&source, &target).map_err(|e| e.to_string())?;
                    remove_tree_force(&source)?;
                }
            }
            discovered.push(entry);
        }
        remove_dir_if_empty(&temp_abs)?;
    }
    for name in list_installed_skill_names(root) {
        ensure_scenario(root, &name, "")?;
    }
    Ok(discovered)
}

/// `readSkillMarkdown`: SKILL.md or null — NO safe-name gate here (TS
/// none either; `ensureScenario`/`skillDescription` feed it directly).
fn read_skill_markdown(root: &Path, skill_name: &str) -> Option<String> {
    read_utf8_file(&skill_dir(root, skill_name).join("SKILL.md"))
}

/// `/^#\s+(.+)$/m` — first markdown heading. `(?m)$` sits before `\n` in
/// both engines; a CRLF body leaves `\r` in the capture, and `.trim()`
/// strips it on both sides.
static HEADING_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#\s+(.+)$").unwrap());

/// `skillDescription`: "" ⇔ no markdown; frontmatter description when
/// truthy; else first heading trimmed; else "".
pub fn skill_description(root: &Path, name: &str) -> String {
    let markdown = match read_skill_markdown(root, name) {
        Some(m) => m,
        None => return String::new(),
    };
    if let Some(front) = frontmatter::parse_frontmatter(&markdown) {
        if !front.description.is_empty() {
            return front.description;
        }
    }
    match HEADING_RE.captures(&markdown) {
        Some(caps) => caps[1].trim().to_string(),
        None => String::new(),
    }
}

/// `ParsedInstall { repo, skillName }`.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedInstall {
    pub repo: String,
    pub skill_name: Option<String>,
}

/// `parseInstallRequest` — EXACT error strings and consumption order:
/// `(input ?? "").trim()`, strip leading `npx|skills|add` (`/^…$/i`) or
/// `-y`, then per-token flags. Micro-divergence (unreachable from this
/// UI's inputs): JS `split(/\s+/)` splits U+FEFF but keeps U+0085 inside
/// a token; Rust `split_whitespace` does the opposite.
pub fn parse_install_request(input: &str) -> Result<ParsedInstall, String> {
    let trimmed = jsstr::js_trim(input);
    if trimmed.is_empty() {
        return Err("Install input is empty".to_string());
    }
    let all: Vec<&str> = trimmed.split_whitespace().collect();
    let mut start = 0usize;
    while start < all.len()
        && (all[start] == "-y"
            || all[start].eq_ignore_ascii_case("npx")
            || all[start].eq_ignore_ascii_case("skills")
            || all[start].eq_ignore_ascii_case("add"))
    {
        start += 1;
    }
    let tokens = &all[start..];

    let mut skill_name: Option<String> = None;
    let mut positionals: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < tokens.len() {
        let token = tokens[i];
        if token == "--skill" || token == "-s" {
            // `tokens[++i] ?? null` — the next token is CONSUMED (skipped
            // as positional), missing ⇒ null.
            skill_name = tokens.get(i + 1).map(|t| t.to_string());
            i += 2;
            continue;
        }
        if matches!(token, "-y" | "--yes" | "--copy" | "--no-copy") {
            i += 1;
            continue;
        }
        if token.starts_with('-') {
            return Err(format!("Unsupported install flag: {token}"));
        }
        positionals.push(token.to_string());
        i += 1;
    }
    if positionals.is_empty() {
        return Err("No repository given in install input".to_string());
    }
    let repo = match normalize_repo(&positionals[0]) {
        Some(r) => r,
        None => {
            return Err("Repository must be an owner/repo slug or a github URL".to_string());
        }
    };
    // TS tests the RAW first positional (pre-normalization) plus the
    // skill name when truthy (split can never yield "" so truthy ⇔ Some).
    let mut to_check: Vec<&str> = vec![positionals[0].as_str()];
    if let Some(s) = skill_name.as_deref() {
        if !s.is_empty() {
            to_check.push(s);
        }
    }
    for t in to_check {
        if !SAFE_TOKEN_RE.is_match(t) {
            return Err(format!("Unsafe character in install token: {t}"));
        }
    }
    if let Some(s) = &skill_name {
        if !s.is_empty() && !is_safe_skill_name(s) {
            return Err(format!("Unsafe skill name: {s}"));
        }
    }
    Ok(ParsedInstall { repo, skill_name })
}

/// `normalizeRepo`: URL capture (`(?i)^https?://(?:www\.)?github\.com/(.+)$`),
/// then `.replace(/\.git$/, "")` ONCE, then `.replace(/\/+$/, "")`, then
/// the slug gate. Pinned quirk: for "owner/repo.git/" the `.git$` strip
/// misses (trailing slash), the slash strip exposes ".git", and the slug
/// regex ACCEPTS "owner/repo.git".
fn normalize_repo(raw: &str) -> Option<String> {
    static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^https?://(?:www\.)?github\.com/(.+)$").unwrap()
    });
    static SLUG_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$").unwrap());
    let mut candidate = match URL_RE.captures(raw) {
        Some(c) => c[1].to_string(),
        None => raw.to_string(),
    };
    if let Some(c) = candidate.strip_suffix(".git") {
        candidate = c.to_string();
    }
    while candidate.ends_with('/') {
        candidate.pop();
    }
    if !SLUG_RE.is_match(&candidate) {
        return None;
    }
    Some(candidate)
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

    // ---- Part 7: parseInstallRequest / normalizeRepo --------------------

    #[test]
    fn parse_install_accepts_plain_prefixed_and_flag_forms() {
        let p = parse_install_request("owner/repo").unwrap();
        assert_eq!(p.repo, "owner/repo");
        assert_eq!(p.skill_name, None);

        let p = parse_install_request("npx skills add owner/repo --skill foo -y").unwrap();
        assert_eq!(p.repo, "owner/repo");
        assert_eq!(p.skill_name.as_deref(), Some("foo"));

        // The strip regex is /^(npx|skills|add)$/i ⇒ case-insensitive.
        let p = parse_install_request("Npx SKILLS ADD o/r -s s1 --no-copy").unwrap();
        assert_eq!(p.repo, "o/r");
        assert_eq!(p.skill_name.as_deref(), Some("s1"));

        // `--skill` at end: tokens[++i] ?? null ⇒ None.
        let p = parse_install_request("o/r --skill").unwrap();
        assert_eq!(p.skill_name, None);
    }

    #[test]
    fn parse_install_rejects_with_exact_ts_messages() {
        assert_eq!(parse_install_request("").unwrap_err(), "Install input is empty");
        assert_eq!(parse_install_request(" \u{feff} ").unwrap_err(), "Install input is empty");
        assert_eq!(
            parse_install_request("--yes -y").unwrap_err(),
            "No repository given in install input"
        );
        assert_eq!(
            parse_install_request("--prune o/r").unwrap_err(),
            "Unsupported install flag: --prune"
        );
        // --skill consumes the NEXT token as the name; "--yes" passes
        // SAFE_TOKEN ('-' is in the class) then fails isSafeSkillName.
        assert_eq!(
            parse_install_request("--skill --yes o/r").unwrap_err(),
            "Unsafe skill name: --yes"
        );
        assert_eq!(
            parse_install_request("--skill fe;o o/r").unwrap_err(),
            "Unsafe character in install token: fe;o"
        );
        // normalizeRepo gate fires BEFORE the token/skill gates (TS order).
        assert_eq!(
            parse_install_request("--skill o/r badrepo").unwrap_err(),
            "Repository must be an owner/repo slug or a github URL"
        );
        assert_eq!(
            parse_install_request("o/r/../evil").unwrap_err(),
            "Repository must be an owner/repo slug or a github URL"
        );
    }

    #[test]
    fn normalize_repo_urls_and_dotgit_strip_order_quirk() {
        let n = |s: &str| normalize_repo(s);
        assert_eq!(n("owner/repo").as_deref(), Some("owner/repo"));
        assert_eq!(n("https://www.github.com/owner/repo").as_deref(), Some("owner/repo"));
        assert_eq!(n("http://github.com/owner/repo.git").as_deref(), Some("owner/repo"));
        // QUIRK PIN: `.git$` strips BEFORE `/+$`, so "….git///" keeps ".git".
        assert_eq!(n("https://github.com/owner/repo.git///").as_deref(), Some("owner/repo.git"));
        assert_eq!(n("owner/repo/"), Some("owner/repo".to_string()));
        assert_eq!(n("o/r/tree/main"), None);
        assert_eq!(n("justowner"), None);
    }

    // ---- Part 7: sync / scenarios / delete / description ----------------

    #[test]
    fn sync_moves_skills_counts_discovered_and_prunes_empty_temp() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(&root.join(".agents/skills/good/SKILL.md"), "# good");
        write(&root.join(".agents/skills/-bad/SKILL.md"), "unsafe name");
        write(&root.join(".agents/skills/nomd/readme.md"), "no SKILL.md");
        fs::create_dir_all(root.join(".claude/skills")).unwrap();
        // Target-exists: source removed, target untouched, still discovered.
        write(&skill_dir(root, "dup").join("SKILL.md"), "TARGET");
        write(&root.join(".agents/skills/dup/SKILL.md"), "SOURCE");

        let discovered = sync_installed_skills(root).unwrap();
        let mut d = discovered.clone();
        d.sort();
        assert_eq!(d, ["dup", "good"]); // push happens in BOTH branches
        assert_eq!(
            fs::read_to_string(skill_dir(root, "dup").join("SKILL.md")).unwrap(),
            "TARGET"
        );
        assert!(!root.join(".agents/skills/dup").exists());
        assert_eq!(
            fs::read_to_string(skill_dir(root, "good").join("SKILL.md")).unwrap(),
            "# good"
        );
        assert!(root.join(".agents/skills/-bad").exists()); // unsafe: untouched
        assert!(root.join(".agents/skills/nomd").exists()); // no md: untouched
        assert!(root.join(".agents/skills").exists()); // not empty ⇒ kept
        assert!(!root.join(".claude/skills").exists()); // empty ⇒ pruned
        // ensureScenario ran for every installed name.
        let scen = read_scenario(root, "good").unwrap();
        assert_eq!(scen["sourceRepo"], serde_json::json!(""));
        assert_eq!(scen["enabled"], serde_json::json!(true));
        assert!(read_scenario(root, "dup").is_some());
    }

    #[test]
    fn ensure_scenario_writes_pretty_json_never_overwrites() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(&skill_dir(root, "demo").join("SKILL.md"), "# demo");
        let s = ensure_scenario(root, "demo", "some/repo").unwrap();
        assert_eq!(s["sourceRepo"], serde_json::json!("some/repo"));
        let raw = fs::read_to_string(scenario_file(root, "demo")).unwrap();
        assert!(raw.ends_with("\n"));
        assert!(raw.contains("\n  \"skillName\": \"demo\","), "pretty-2 + key order");

        // Existing scenario is NEVER overwritten (sourceRepo stays "").
        fs::write(scenario_file(root, "demo"), "{\"skillName\":\"demo\",\"sourceRepo\":\"keep\",\"enabled\":true,\"autoUse\":false,\"whenToUse\":\"mine\",\"triggerKeywords\":[],\"blockedReason\":null}").unwrap();
        let s = ensure_scenario(root, "demo", "other/repo").unwrap();
        assert_eq!(s["sourceRepo"], serde_json::json!("keep"));
        assert_eq!(s["whenToUse"], serde_json::json!("mine"));
    }

    #[test]
    fn ensure_scenario_blocks_enabled_skill_that_turns_media() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(&skill_dir(root, "demo").join("SKILL.md"), "uses Midjourney for art");
        // New install with blocked content ⇒ created already blocked.
        let s = ensure_scenario(root, "demo", "").unwrap();
        assert_eq!(s["enabled"], serde_json::json!(false));
        assert_eq!(
            s["blockedReason"],
            serde_json::json!(crate::modality::BLOCKED_REASON)
        );

        // Existing enabled scenario + newly media-flavored md ⇒ updated once.
        write(&skill_dir(root, "live").join("SKILL.md"), "plain body");
        ensure_scenario(root, "live", "").unwrap();
        write(&skill_dir(root, "live").join("SKILL.md"), "now stable diffusion");
        let s = ensure_scenario(root, "live", "").unwrap();
        assert_eq!(s["enabled"], serde_json::json!(false));
        // Already blocked ⇒ md edits don't re-touch it.
        write(&skill_dir(root, "live").join("SKILL.md"), "back to plain");
        let s = ensure_scenario(root, "live", "").unwrap();
        assert_eq!(s["enabled"], serde_json::json!(false));
    }

    #[test]
    fn update_scenario_type_gates_and_string_keywords() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        assert_eq!(update_scenario(root, "gone", &serde_json::Map::new()).unwrap(), None);

        ensure_scenario(root, "demo", "").unwrap();
        let patch = serde_json::json!({
            "enabled": "yes",          // wrong type ⇒ ignored
            "autoUse": true,           // applied
            "whenToUse": 123,          // wrong type ⇒ ignored
            "triggerKeywords": [1, "two", null, true], // map(String)
            "sourceRepo": "a/b",       // applied
            "blockedReason": null,     // null ⇔ ?? null ⇒ applied
        })
        .as_object()
        .unwrap()
        .clone();
        let s = update_scenario(root, "demo", &patch).unwrap().unwrap();
        assert_eq!(s["enabled"], serde_json::json!(true)); // untouched (string ignored)
        assert_eq!(s["autoUse"], serde_json::json!(true));
        assert_eq!(s["whenToUse"], serde_json::json!(""));
        assert_eq!(
            s["triggerKeywords"],
            serde_json::json!(["1", "two", "null", "true"]) // map(String): null ⇒ "null"
        );
        assert_eq!(s["sourceRepo"], serde_json::json!("a/b"));
        assert_eq!(s["blockedReason"], serde_json::json!(null));
        // Persisted.
        let again = read_scenario(root, "demo").unwrap();
        assert_eq!(again["triggerKeywords"], serde_json::json!(["1", "two", "null", "true"]));
    }

    #[test]
    fn delete_skill_table() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        assert!(!delete_skill(root, "../x").unwrap()); // unsafe ⇒ no fs touch
        assert!(!delete_skill(root, "nothere").unwrap()); // removed=false, no error

        write(&skill_dir(root, "doomed").join("SKILL.md"), "x");
        ensure_scenario(root, "doomed", "").unwrap();
        assert!(delete_skill(root, "doomed").unwrap());
        assert!(!skill_dir(root, "doomed").exists());
        assert!(!scenario_file(root, "doomed").exists());
        // scenario-only deletion still counts as removed
        fs::create_dir_all(root.join(SCENARIOS_DIR)).unwrap();
        fs::write(scenario_file(root, "ghost"), "{}").unwrap();
        assert!(delete_skill(root, "ghost").unwrap());
    }

    #[test]
    fn skill_description_prefers_frontmatter_then_heading() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        assert_eq!(skill_description(root, "nothing"), "");
        write(&skill_dir(root, "front").join("SKILL.md"), "---\ndescription: FD\n---\n# H1");
        assert_eq!(skill_description(root, "front"), "FD");
        write(&skill_dir(root, "head").join("SKILL.md"), "junk\n#  Head Two \nbody");
        assert_eq!(skill_description(root, "head"), "Head Two");
        write(&skill_dir(root, "bare").join("SKILL.md"), "no heading here");
        assert_eq!(skill_description(root, "bare"), "");
    }

    #[test]
    fn broken_links_detected_when_symlinks_are_permitted() {
        let tmp = TempDir::new().unwrap();
        let link = tmp.path().join("dangling");
        // Unprivileged Windows refuses symlink creation (no Developer
        // Mode): skip honestly rather than fake the assertion.
        if std::os::windows::fs::symlink_file(tmp.path().join("nowhere-target"), &link).is_err() {
            eprintln!("skipping: symlink creation not permitted");
            return;
        }
        assert!(is_broken_link(&link));
        let target = tmp.path().join("real");
        write(&target, "x");
        assert!(!is_broken_link(&target)); // regular file, not a symlink
        let good = tmp.path().join("good-link");
        if std::os::windows::fs::symlink_file(&target, &good).is_ok() {
            assert!(!is_broken_link(&good));
        }
    }
}
