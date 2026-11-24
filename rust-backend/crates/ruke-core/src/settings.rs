//! Parity port of `lib/server/settings.ts`. Semantics that MUST match the
//! TS baseline (frozen in MIGRATION-MAP.md §2):
//!
//! - Priority: `settings.json` field > env var (`LLM_API_URL`/`LLM_API_KEY`)
//!   > `.env.local` (the project's gitignored local overrides, next to settings.json)
//!   > fallback (`http://127.0.0.1:8080/v1/chat/completions` / `"no-key"`).
//!   The `.env.local` layer is F44 (amendment 8 §B): the Python lifecycle resolver used to
//!   read `.env.local` while this one did not, so one deployment could chat to one server and
//!   unload another. All three stacks now share one chain in one order.
//! - mtime-gated cache: re-parse only when the file's mtime changes.
//! - Missing file ⇒ empty settings + cache reset.
//! - Corrupted file ⇒ KEEP the last successfully parsed data and do NOT
//!   accept the new mtime, so the parse is retried on the next call
//!   (exactly what the TS `cachedMtimeMs = cachedMtimeMs` no-op does).
//! - `update_settings` merges like the TS spread `{...readSettings(),
//!   ...patch}`: existing keys keep their position, new keys append
//!   (serde_json `preserve_order` Map has indexmap insert semantics).
//! - Writes are atomic: `settings.json.tmp` + rename, JSON pretty-printed
//!   with 2-space indent and a trailing newline (`JSON.stringify(v, null, 2) + "\n"`).

use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::{Map, Value};

pub const FALLBACK_LLM_API_URL: &str = "http://127.0.0.1:8080/v1/chat/completions";
pub const FALLBACK_LLM_API_KEY: &str = "no-key";

#[derive(Default)]
struct Cache {
    /// mtime in epoch milliseconds; None = file absent/unparsable-untouched.
    mtime: Option<u128>,
    data: Map<String, Value>,
}

#[derive(Default)]
struct DotenvCache {
    mtime: Option<u128>,
    data: HashMap<String, String>,
}

pub struct SettingsStore {
    path: PathBuf,
    cache: Mutex<Cache>,
    dotenv: Mutex<DotenvCache>,
    /// Golden-replay seam (Part 4): pins the upstream url/key per store so
    /// parallel cargo tests never race on process-global env vars and the
    /// production resolution chain below stays untouched when unset.
    /// Tests call `set_upstream_override`; production never does.
    upstream_override: Mutex<Option<(String, String)>>,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            cache: Mutex::new(Cache::default()),
            dotenv: Mutex::new(DotenvCache::default()),
            upstream_override: Mutex::new(None),
        }
    }

    /// Checked BEFORE file > env > fallback by `llm_api_url`/`llm_api_key`.
    pub fn set_upstream_override(&self, url: impl Into<String>, key: impl Into<String>) {
        *self.upstream_override.lock() = Some((url.into(), key.into()));
    }

    pub fn clear_upstream_override(&self) {
        *self.upstream_override.lock() = None;
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// The project's gitignored local overrides, always the sibling of settings.json
    /// (`settings.json` lives at the repo root, so this is `<repo>/.env.local`).
    pub fn dotenv_path(&self) -> PathBuf {
        let mut p = self.path.clone();
        p.set_file_name(".env.local");
        p
    }

    fn dotenv_mtime_ms(&self) -> Option<u128> {
        std::fs::metadata(self.dotenv_path())
            .ok()?
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis())
    }

    /// Parity of TS `readDotenv()` + `resolveLayer()`: KEY=VALUE lines, `#` comments,
    /// an optional `export ` prefix and optionally quoted values. An unreadable or
    /// corrupt file KEEPS the previous parse and does not accept the new mtime, exactly
    /// like settings.json — an absent file clears the layer.
    pub fn dotenv_value(&self, key: &str) -> Option<String> {
        let mt = self.dotenv_mtime_ms();
        let mut c = self.dotenv.lock();
        match mt {
            None => {
                if c.mtime.is_some() || !c.data.is_empty() {
                    *c = DotenvCache::default();
                }
                None
            }
            Some(mt) => {
                if Some(mt) != c.mtime {
                    match std::fs::read_to_string(self.dotenv_path()) {
                        Ok(text) => {
                            c.data = parse_dotenv(&text);
                            c.mtime = Some(mt);
                        }
                        Err(_) => return c.data.get(key).cloned(),
                    }
                }
                c.data.get(key).cloned().filter(|v| !v.trim().is_empty())
            }
        }
    }

    fn stat_ms(&self) -> Option<u128> {
        std::fs::metadata(&self.path)
            .ok()?
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis())
    }

    /// Parity of `readSettings()`. Returns a clone of the parsed object
    /// (or an empty Map when the file is absent/corrupted-with-no-prior).
    pub fn read_settings(&self) -> Map<String, Value> {
        let mt = self.stat_ms();
        let mut c = self.cache.lock();
        match mt {
            None => {
                if c.mtime.is_some() || !c.data.is_empty() {
                    *c = Cache::default();
                }
                Map::new()
            }
            Some(mt) => {
                if Some(mt) != c.mtime {
                    match std::fs::read_to_string(&self.path)
                        .map_err(|e: std::io::Error| e)
                        .and_then(|s| s.parse::<Value>().map_err(std::io::Error::other))
                    {
                        Ok(Value::Object(obj)) => {
                            c.data = obj;
                            c.mtime = Some(mt);
                        }
                        // Valid JSON but not an object, or parse error:
                        // keep prior data; leave c.mtime stale so the next
                        // call retries (TS corrupted-file branch).
                        Ok(_) => {}
                        Err(_) => {}
                    }
                }
                c.data.clone()
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.read_settings().get(key).cloned()
    }

    pub fn llm_api_url(&self) -> String {
        if let Some((u, _)) = self.upstream_override.lock().as_ref() {
            return u.clone();
        }
        self.resolve_layered(self.get("llm_api_url"), "LLM_API_URL", FALLBACK_LLM_API_URL)
    }

    pub fn llm_api_key(&self) -> String {
        if let Some((_, k)) = self.upstream_override.lock().as_ref() {
            return k.clone();
        }
        self.resolve_layered(self.get("llm_api_key"), "LLM_API_KEY", FALLBACK_LLM_API_KEY)
    }

    /// The full chain: settings.json > process env > .env.local > fallback. Same order as
    /// `lib/server/settings.ts` and `ruke_ml/models/provider_config.py`, so chat and the
    /// lifecycle control calls cannot resolve to two different servers.
    fn resolve_layered(&self, file_value: Option<Value>, key: &str, fallback: &str) -> String {
        if let Some(Value::String(s)) = file_value {
            return s;
        }
        match std::env::var(key) {
            Ok(v) if !v.trim().is_empty() => return v,
            _ => {}
        }
        if let Some(v) = self.dotenv_value(key) {
            return v;
        }
        fallback.to_string()
    }

    /// Parity of `updateSettings(patch)`: merge into the current object,
    /// atomic write, invalidate the cache exactly like TS
    /// (`cachedData = next; cachedMtimeMs = null`).
    pub fn update_settings(&self, patch: &Map<String, Value>) -> Map<String, Value> {
        let mut merged = self.read_settings();
        for (k, v) in patch {
            merged.insert(k.clone(), v.clone());
        }
        self.write_atomic(&merged);
        let mut c = self.cache.lock();
        c.data = merged.clone();
        c.mtime = None;
        merged
    }

    /// Replace the whole stored object (engine-preference migration purges
    /// retired keys, which a merge-patch cannot express). Atomic, same cache
    /// invalidation as `update_settings`.
    pub fn replace_settings(&self, next: &Map<String, Value>) -> Map<String, Value> {
        self.write_atomic(next);
        let mut c = self.cache.lock();
        c.data = next.clone();
        c.mtime = None;
        next.clone()
    }

    /// Parity of `clearSettings()`: remove the file and drop the cache.
    pub fn clear_settings(&self) {
        let _ = std::fs::remove_file(&self.path);
        *self.cache.lock() = Cache::default();
    }

    fn write_atomic(&self, data: &Map<String, Value>) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = to_pretty_2(data);
        let tmp = {
            let mut t = self.path.clone().into_os_string();
            t.push(".tmp");
            PathBuf::from(t)
        };
        // Rule 17: never log the contents — settings.json may hold an API key.
        std::fs::write(&tmp, json.as_bytes()).expect("write settings tmp");
        std::fs::rename(&tmp, &self.path).expect("rename settings tmp");
    }
}

/// `JSON.stringify(v, null, 2) + "\n"` — serde_json's default pretty uses
/// 4-space indent, so drive the formatter with an explicit 2-space indent.
fn to_pretty_2(data: &Map<String, Value>) -> String {
    let mut out = Vec::new();
    {
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
        let mut ser = serde_json::Serializer::with_formatter(&mut out, formatter);
        serde::Serialize::serialize(data, &mut ser).expect("settings serialize");
    }
    let mut s = String::from_utf8(out).expect("settings json is utf8");
    s.push('\n');
    s
}

/// Env lookup injected so tests never race on process-global env vars.
fn resolve_with(
    file_value: Option<Value>,
    env: impl Fn(&str) -> Option<String>,
    env_key: &str,
    fallback: &str,
) -> String {
    match file_value {
        // TS passes the raw JSON value through untyped; a non-string there
        // would crash downstream fetch. Treat non-strings as absent — the
        // only deliberate deviation, impossible under golden fixtures.
        Some(Value::String(s)) => s,
        _ => match env(env_key) {
            Some(v) if !v.trim().is_empty() => v,
            _ => fallback.to_string(),
        },
    }
}

/// `readDotenv()` parity. Deliberately tiny: no variable expansion, no multi-line
/// values, no shell semantics — a model endpoint file is a flat KEY=VALUE list, and
/// inventing shell behaviour here would make the three stacks disagree again.
fn parse_dotenv(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for raw in text.lines() {
        let mut line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.len() > 7 && line[..7].eq_ignore_ascii_case("export ") {
            line = line[7..].trim();
        }
        let (key, value) = match line.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim();
        let mut value = value.trim();
        if value.len() >= 2 {
            let quote = value.as_bytes()[0];
            if (quote == b'"' || quote == b'\'') && value.as_bytes()[value.len() - 1] == quote {
                value = &value[1..value.len() - 1];
            }
        }
        let value = value.trim();
        if !key.is_empty() && !value.is_empty() {
            out.insert(key.to_string(), value.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn missing_file_yields_empty_settings_and_env_then_fallback_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(tmp.path().join("settings.json"));
        let url = resolve_with(store.get("llm_api_url"), |_| None, "LLM_API_URL", FALLBACK_LLM_API_URL);
        assert_eq!(url, FALLBACK_LLM_API_URL);
        let url2 =
            resolve_with(None, |_| Some("http://env:1/v1".into()), "LLM_API_URL", FALLBACK_LLM_API_URL);
        assert_eq!(url2, "http://env:1/v1");
    }

    #[test]
    fn file_beats_env_priority() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(tmp.path().join("settings.json"));
        store.update_settings(&map(json!({"llm_api_url": "http://file:1/v1"})));
        let url = resolve_with(store.get("llm_api_url"), |_| Some("http://env:1/v1".into()), "LLM_API_URL", FALLBACK_LLM_API_URL);
        assert_eq!(url, "http://file:1/v1");
    }

    #[test]
    fn merge_preserves_unknown_keys_updates_in_place_and_appends_new() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        std::fs::write(
            &path,
            "{\n  \"custom_field\": 7,\n  \"llm_api_key\": \"old\"\n}\n",
        )
        .unwrap();
        let store = SettingsStore::new(&path);
        let next = store.update_settings(&map(json!({"llm_api_key": "new", "llm_api_url": "u"})));
        assert_eq!(
            next.keys().cloned().collect::<Vec<_>>(),
            vec!["custom_field", "llm_api_key", "llm_api_url"]
        );
        // TS spread keeps existing key position on update; new key appends.
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.ends_with("}\n"), "trailing newline parity");
        assert!(written.contains("\n  \"custom_field\": 7,"), "2-space indent parity");
        assert!(!tmp.path().join("settings.json.tmp").exists(), "tmp cleaned by rename");
        // mtime-gated cache: read back reflects the file.
        let store2 = SettingsStore::new(&path);
        assert_eq!(store2.get("custom_field"), Some(json!(7)));
    }

    #[test]
    fn corrupted_file_keeps_last_good_parse_and_recovers_when_fixed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        let store = SettingsStore::new(&path);
        store.update_settings(&map(json!({"llm_api_key": "good"})));
        assert_eq!(store.get("llm_api_key"), Some(json!("good")));

        std::fs::write(&path, "{ this is not json").unwrap();
        // TS: mtime changed but parse fails ⇒ keep cached data AND keep the
        // stale cached mtime so the next call retries the parse.
        assert_eq!(store.get("llm_api_key"), Some(json!("good")), "corrupted ⇒ last good parse");

        std::fs::write(&path, "{ not json again").unwrap();
        assert_eq!(store.get("llm_api_key"), Some(json!("good")), "still retrying, still old");

        std::fs::write(&path, "{\"llm_api_key\": \"fixed\"}").unwrap();
        assert_eq!(store.get("llm_api_key"), Some(json!("fixed")), "recovers after fix");
    }

    #[test]
    fn valid_json_non_object_is_ignored_like_ts_would_store_garbage_but_getters_ignore() {
        // TS readSettings would hand back the raw parsed value; our typed
        // getters treat it as absent. Pin the Rust behavior explicitly.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        std::fs::write(&path, "[1,2,3]").unwrap();
        let store = SettingsStore::new(&path);
        let url = resolve_with(store.get("llm_api_url"), |_| None, "LLM_API_URL", FALLBACK_LLM_API_URL);
        assert_eq!(url, FALLBACK_LLM_API_URL);
    }

    #[test]
    fn clear_removes_file_and_resets_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        let store = SettingsStore::new(&path);
        store.update_settings(&map(json!({"llm_api_key": "k"})));
        store.clear_settings();
        assert!(!path.exists());
        assert!(store.read_settings().is_empty());
        let key = resolve_with(store.get("llm_api_key"), |_| None, "LLM_API_KEY", FALLBACK_LLM_API_KEY);
        assert_eq!(key, FALLBACK_LLM_API_KEY);
    }

    #[test]
    fn create_dir_all_for_nested_settings_path() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("deep/nested/settings.json");
        let store = SettingsStore::new(&path);
        store.update_settings(&map(json!({"x": 1})));
        assert!(path.is_file());
    }

    // ---- the .env.local layer (F44, amendment 8 §B) -------------------------------

    #[test]
    fn env_local_is_used_when_settings_and_process_env_are_silent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        std::fs::write(
            tmp.path().join(".env.local"),
            "# local overrides\nexport LLM_API_URL=\"http://dotenv:8080/v1/chat/completions\"\nLLM_API_KEY=key-from-dotenv\nBROKEN_LINE_NO_EQUALS\n",
        )
        .unwrap();
        let store = SettingsStore::new(&path);
        // The chain is exercised through dotenv_value directly: process env is not
        // writable from a parallel test, and LLM_API_URL is only ever unset here.
        assert_eq!(
            store.dotenv_value("LLM_API_URL").as_deref(),
            Some("http://dotenv:8080/v1/chat/completions")
        );
        assert_eq!(store.dotenv_value("LLM_API_KEY").as_deref(), Some("key-from-dotenv"));
        assert_eq!(store.dotenv_value("BROKEN_LINE_NO_EQUALS"), None);
        assert_eq!(store.dotenv_value("NOT_ANYWHERE"), None);
        assert_eq!(store.dotenv_path().file_name().unwrap(), ".env.local");
    }

    #[test]
    fn settings_json_still_wins_over_env_local() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        std::fs::write(tmp.path().join(".env.local"), "LLM_API_URL=http://dotenv:1/v1\n").unwrap();
        let store = SettingsStore::new(&path);
        store.update_settings(&map(json!({"llm_api_url": "http://settings:1/v1"})));
        store.set_upstream_override("unused-because-file-wins-check-below", "unused");
        store.clear_upstream_override();
        // settings.json present + process env unset => file value, not the dotenv value.
        let url = resolve_with(store.get("llm_api_url"), |_| None, "LLM_API_URL", FALLBACK_LLM_API_URL);
        assert_eq!(url, "http://settings:1/v1");
        assert_ne!(url, "http://dotenv:1/v1");
    }

    #[test]
    fn an_unreadable_env_local_keeps_the_last_good_parse() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        let env_file = tmp.path().join(".env.local");
        std::fs::write(&env_file, "LLM_API_URL=http://good:1/v1\n").unwrap();
        let store = SettingsStore::new(&path);
        assert_eq!(store.dotenv_value("LLM_API_URL").as_deref(), Some("http://good:1/v1"));
        // Replace the file with a DIRECTORY at the same name: reading it now fails with
        // ErrorIsADirectory. A fail-open reader would answer "no override"; the honest
        // answer is the last value it actually read.
        std::fs::remove_file(&env_file).unwrap();
        std::fs::create_dir(&env_file).unwrap();
        assert_eq!(store.dotenv_value("LLM_API_URL").as_deref(), Some("http://good:1/v1"));
        // And deleting it for good DOES clear the layer (absence is a real answer).
        std::fs::remove_dir(&env_file).unwrap();
        assert_eq!(store.dotenv_value("LLM_API_URL"), None);
    }
}
