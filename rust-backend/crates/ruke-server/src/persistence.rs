//! Part 7: `lib/persistence/disk.ts` + `lib/persistence/merge.ts` —
//! conversation JSON files on disk, the delete tombstone window, and the
//! title-ownership merge for whole-document saves.
//!
//! Parity notes:
//! - `file(id)` re-sanitizes EVERY id it is given (`[^a-zA-Z0-9_-]` → `_`).
//!   `listConversationsOnDisk` takes ids from RAW filenames and then calls
//!   `file(id)` again, so a file literally named `we!rd.json` lists as
//!   `we!rd` but stats/reads `we_rd.json` (missing ⇒ updatedAt 0, GET
//!   enrichment skips the item). Reproduced exactly, quirk included.
//!   (Micro: astral characters — the JS regex replaces each UTF-16
//!   SURROGATE (two underscores), Rust each codepoint (one); ids the UI
//!   actually writes are `conv_`-prefixed ASCII, so this is unreachable.)
//! - mtimeMs is a float (`as_secs_f64 * 1000`); responses serialize it as an
//!   integer-valued JSON number when the fraction is zero (JS
//!   `JSON.stringify` never prints `.0` where serde would).
//! - The tombstone map is keyed by the RAW id (TS `recentlyDeleted.set(id)`
//!   — no sanitization), and the save-guard compares it before writing the
//!   sanitized path. Same here.
//!
//! RECORDED MICRO-DIVERGENCES:
//! - `DATA_DIR` is computed at TS module load (`WEBUI_DATA_DIR ??
//!   join(HOME!, …)` — the `HOME!` non-null assertion CRASHES the TS process
//!   at import when HOME is unset). The Rust store takes an explicit dir;
//!   main.rs resolves WEBUI_DATA_DIR → HOME → USERPROFILE → repo-root join
//!   (with a warn), so a missing HOME degrades instead of crashing.
//! - Tombstone stamps use integer epoch ms (`Date.now()` is float ms — the
//!   5000 ms window comparison is unaffected).
//! - `mergeProtectedTitle` re-serializes the PARSED incoming doc, so
//!   numeric literals in it are serde-normalized (e.g. `1.0` stays `1.0`,
//!   but a literal `1e3` becomes `1000` — JSON.stringify normalizes the
//!   same way; only exotic spellings like leading-zero forms differ).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Number, Value};

pub struct ConversationStore {
    dir: PathBuf,
    /// `recentlyDeleted`: raw id → epoch-ms of the delete (Map).
    recently_deleted: Mutex<HashMap<String, i64>>,
}

pub struct ListedConversation {
    pub id: String,
    pub updated_at: f64,
}

pub(crate) fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0, // pre-1970 clock — TS Date.now would be negative here; unreachable
    }
}

impl ConversationStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            recently_deleted: Mutex::new(HashMap::new()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// `file(id)`: `id.replace(/[^a-zA-Z0-9_-]/g, "_")` + ".json".
    fn file(&self, id: &str) -> PathBuf {
        let safe: String = id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.dir.join(format!("{safe}.json"))
    }

    /// `ensureDir()` — recursive mkdir; a failure THROWS out of
    /// `list`/`save` (the route 500s), so it returns Err here.
    fn ensure_dir(&self) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())
    }

    /// `listConversationsOnDisk`: ensureDir OUTSIDE the try (its failure
    /// rejects the GET ⇒ 500), readdir `.json` filter, stat-mtime per item
    /// (per-item failure ⇒ 0), whole-readdir failure ⇒ `[]`, then the
    /// stable `b.updatedAt - a.updatedAt` sort.
    pub fn list(&self) -> Result<Vec<ListedConversation>, String> {
        self.ensure_dir()?;
        let rd = match fs::read_dir(&self.dir) {
            Ok(rd) => rd,
            Err(_) => return Ok(Vec::new()), // outer catch
        };
        let mut items: Vec<ListedConversation> = rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".json"))
            .map(|name| {
                let id = name[..name.len() - ".json".len()].to_string();
                let mut updated_at = 0.0;
                if let Ok(md) = fs::metadata(self.file(&id)) {
                    if let Ok(t) = md.modified() {
                        if let Ok(d) = t.duration_since(UNIX_EPOCH) {
                            updated_at = d.as_secs_f64() * 1000.0;
                        }
                    }
                }
                ListedConversation { id, updated_at }
            })
            .collect();
        sort_by_updated_desc(&mut items);
        Ok(items)
    }

    /// `getConversationOnDisk`: utf-8 read (lossy, like Node's decoder) or
    /// null on ANY error.
    pub fn get(&self, id: &str) -> Option<String> {
        fs::read(self.file(id))
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    }

    /// `saveConversationOnDisk`.
    pub fn save(&self, id: &str, json: &str) -> Result<(), String> {
        self.save_at(id, json, now_ms())
    }

    /// Test-visible clock seam (the 5000 ms tombstone window otherwise
    /// forces a 5-second sleep test).
    fn save_at(&self, id: &str, json: &str, now: i64) -> Result<(), String> {
        {
            let mut tomb = self.recently_deleted.lock().unwrap();
            if let Some(deleted_at) = tomb.get(id).copied() {
                if now - deleted_at < 5000 {
                    return Ok(()); // racing a delete — DROP the write
                }
                tomb.remove(id);
            }
        }
        self.ensure_dir()?;
        fs::write(self.file(id), json).map_err(|e| e.to_string())
    }

    /// `deleteConversationOnDisk`: tombstone FIRST, then unlink — errors
    /// swallowed (a missing file, or a directory where a file was expected).
    pub fn delete(&self, id: &str) {
        self.delete_at(id, now_ms());
    }

    /// Test-visible clock seam for the tombstone STAMP (mirrors `save_at`;
    /// without it the window test races the ms boundary between the delete
    /// stamp and the fixture's base time).
    fn delete_at(&self, id: &str, at: i64) {
        self.recently_deleted
            .lock()
            .unwrap()
            .insert(id.to_string(), at);
        let _ = fs::remove_file(self.file(id));
    }
}

/// `(a, b) => b.updatedAt - a.updatedAt` — Rust's stable `sort_by` matches
/// V8's stable Array#sort for the comparator's ordering.
fn sort_by_updated_desc(items: &mut [ListedConversation]) {
    items.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));
}

/// JS `JSON.stringify` prints integer-valued numbers without `.0`; serde
/// prints `123.0`. Normalize so sidebar bytes match.
pub fn js_ms_number(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.2e18 {
        Value::Number(Number::from(f as i64))
    } else {
        Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null) // JS stringify: NaN/Inf → null
    }
}

/// `mergeProtectedTitle(storedRaw, incomingJson)` — merge.ts verbatim:
/// falsy stored ⇒ incoming verbatim; unparseable stored OR incoming ⇒
/// incoming verbatim (the catch); no truthy incoming `.meta` ⇒ verbatim;
/// manual incoming ⇒ verbatim; otherwise the STORED title wins and the
/// document is re-serialized.
pub fn merge_protected_title(stored_raw: Option<&str>, incoming_json: &str) -> String {
    // `if (!storedRaw)` — null AND "" are falsy.
    let stored_raw = match stored_raw {
        Some(s) if !s.is_empty() => s,
        _ => return incoming_json.to_string(),
    };
    let stored: Value = match serde_json::from_str(stored_raw) {
        Ok(v) => v,
        Err(_) => return incoming_json.to_string(), // stored unparseable ⇒ catch
    };
    let mut incoming: Value = match serde_json::from_str(incoming_json) {
        Ok(v) => v,
        Err(_) => return incoming_json.to_string(), // incoming unparseable ⇒ catch
    };
    // `!incoming?.meta` — missing OR null.
    match incoming.get("meta") {
        Some(m) if !m.is_null() => {
            // `incoming.meta.titleSource === "manual"` — a user rename wins.
            if m.get("titleSource").and_then(Value::as_str) == Some("manual") {
                return incoming_json.to_string();
            }
            // The stored title survives only when truthy.
            let stored_title = stored.get("meta").and_then(|sm| sm.get("title"));
            let title_survives = match stored_title {
                Some(t) => !t.is_null() && t.as_str().is_none_or(|s| !s.is_empty()),
                None => false,
            };
            if title_survives {
                // JS SETS: assigning to a property of a non-object primitive
                // (ESM strict mode) THROWS → caught → incoming verbatim.
                if incoming["meta"].is_object() {
                    let title = stored_title.cloned().unwrap();
                    incoming["meta"]
                        .as_object_mut()
                        .unwrap()
                        .insert("title".into(), title);
                    for k in ["titleSource", "titleGenCount", "titleGenAt"] {
                        // `stored.meta[k] !== undefined` — an explicit null
                        // IS copied; a missing key is not.
                        if let Some(v) = stored.get("meta").and_then(|sm| sm.get(k)) {
                            let v = v.clone();
                            incoming["meta"]
                                .as_object_mut()
                                .unwrap()
                                .insert(k.into(), v);
                        }
                    }
                } else {
                    return incoming_json.to_string(); // strict-mode throw ⇒ catch path
                }
            }
        }
        _ => return incoming_json.to_string(),
    }
    // ALWAYS re-serializes on this path (the TS `JSON.stringify(incoming)`).
    serde_json::to_string(&incoming).unwrap_or_else(|_| incoming_json.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (ConversationStore, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        (
            ConversationStore::new(tmp.path().join("conversations")),
            tmp,
        )
    }

    #[test]
    fn save_get_delete_roundtrip_sanitizes_ids() {
        let (s, _t) = store();
        s.save("conv_01", "{\"id\":\"conv_01\"}").unwrap();
        assert_eq!(s.get("conv_01").unwrap(), "{\"id\":\"conv_01\"}");
        // An id with unsafe chars round-trips through the SAME sanitized
        // file (TS `file(id)` sanitizes for save and read alike).
        s.save("we!rd/../x", "{}").unwrap();
        assert_eq!(s.get("we!rd/../x").unwrap(), "{}");
        // Per-char `[^a-zA-Z0-9_-]` → "_": w e ! r d / . . / x ⇒ 10 chars
        // ⇒ "we_rd____x" (the "!" run is ONE underscore, "/../" is four).
        assert!(s.dir().join("we_rd____x.json").exists());
        s.delete("conv_01");
        assert!(s.get("conv_01").is_none());
    }

    #[test]
    fn tombstone_drops_racing_save_then_expires() {
        let (s, _t) = store();
        s.save("conv_x", "{\"v\":1}").unwrap();
        // Both clock sides pinned to ONE base instant (delete_at + save_at
        // seams) — the 4999/5000 boundary is asserted deterministically.
        let base = now_ms();
        s.delete_at("conv_x", base);
        // A save in flight BEFORE the delete lands must not resurrect —
        // 4999 ms later is still inside the window.
        s.save_at("conv_x", "{\"v\":2}", base + 4999).unwrap();
        assert!(s.get("conv_x").is_none());
        // Exactly 5000 ms later the guard clears and the tombstone goes.
        s.save_at("conv_x", "{\"v\":3}", base + 5000).unwrap();
        assert_eq!(s.get("conv_x").unwrap(), "{\"v\":3}");
        s.save("conv_x", "{\"v\":4}").unwrap(); // no tombstone now
        assert_eq!(s.get("conv_x").unwrap(), "{\"v\":4}");
    }

    #[test]
    fn list_reads_raw_names_then_restats_sanitized_path() {
        let (s, tmp) = store();
        s.save("bbb", "{}").unwrap();
        s.save("aaa", "{}").unwrap();
        // QUIRK PIN: a literal weird filename lists under the RAW id but
        // stats/reads the sanitized path — updatedAt 0, get None.
        fs::create_dir_all(tmp.path().join("conversations")).unwrap();
        fs::write(
            tmp.path().join("conversations").join("we!rd.json"),
            "{\"meta\":{}}",
        )
        .unwrap();
        let items = s.list().unwrap();
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"aaa") && ids.contains(&"bbb") && ids.contains(&"we!rd"));
        let weird = items.iter().find(|i| i.id == "we!rd").unwrap();
        assert_eq!(weird.updated_at, 0.0);
        assert!(s.get("we!rd").is_none()); // reads we_rd.json — missing
    }

    #[test]
    fn list_sort_is_desc_and_stable() {
        let mut items = vec![
            ListedConversation {
                id: "a".into(),
                updated_at: 1.0,
            },
            ListedConversation {
                id: "b".into(),
                updated_at: 3.0,
            },
            ListedConversation {
                id: "c".into(),
                updated_at: 2.0,
            },
            ListedConversation {
                id: "d".into(),
                updated_at: 3.0,
            },
        ];
        sort_by_updated_desc(&mut items);
        assert_eq!(
            items
                .iter()
                .map(|i| (i.id.as_str(), i.updated_at))
                .collect::<Vec<_>>(),
            vec![("b", 3.0), ("d", 3.0), ("c", 2.0), ("a", 1.0)]
        );
    }

    #[test]
    fn list_empty_dir_after_ensure_and_missing_entries_ok() {
        let (s, tmp) = store();
        let items = s.list().unwrap(); // creates the dir, [] contents
        assert!(items.is_empty());
        assert!(tmp.path().join("conversations").is_dir());
    }

    #[test]
    fn js_ms_number_prints_like_json_stringify() {
        assert_eq!(
            js_ms_number(1761534562345.0),
            Value::Number(Number::from(1761534562345i64))
        );
        assert_eq!(
            serde_json::to_string(&js_ms_number(1761534562345.0)).unwrap(),
            "1761534562345"
        );
        let frac = js_ms_number(123.5);
        assert_eq!(serde_json::to_string(&frac).unwrap(), "123.5");
    }

    // ---- merge.ts --------------------------------------------------------

    const INC: &str = "{\"meta\":{\"title\":\"new\",\"titleSource\":\"auto\"},\"messages\":[]}";

    #[test]
    fn merge_passthroughs() {
        assert_eq!(merge_protected_title(None, INC), INC);
        assert_eq!(merge_protected_title(Some(""), INC), INC); // falsy stored
        assert_eq!(merge_protected_title(Some("{{{bad"), INC), INC); // stored unparseable
        assert_eq!(
            merge_protected_title(Some("{\"meta\":{\"title\":\"old\"}}"), "{{bad"),
            "{{bad"
        );
        let manual = "{\"meta\":{\"title\":\"mine\",\"titleSource\":\"manual\"}}";
        assert_eq!(
            merge_protected_title(Some("{\"meta\":{\"title\":\"old\"}}"), manual),
            manual
        );
        let no_meta = "{\"messages\":[]}";
        assert_eq!(
            merge_protected_title(Some("{\"meta\":{\"title\":\"old\"}}"), no_meta),
            no_meta
        );
        // meta: null is falsy ⇒ verbatim, NOT re-serialized.
        let meta_null = "{\"meta\":null}";
        assert_eq!(
            merge_protected_title(Some("{\"meta\":{\"title\":\"old\"}}"), meta_null),
            meta_null
        );
    }

    #[test]
    fn merge_keeps_stored_title_and_copies_meta_keys() {
        let stored = "{\"meta\":{\"title\":\"Server Title\",\"titleGenCount\":7,\"titleGenAt\":1,\"titleSource\":null}}";
        let merged = merge_protected_title(Some(stored), INC);
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["meta"]["title"], Value::String("Server Title".into()));
        assert_eq!(v["meta"]["titleGenCount"], Value::from(7));
        assert_eq!(v["meta"]["titleGenAt"], Value::from(1));
        assert_eq!(v["meta"]["titleSource"], Value::Null); // an explicit null IS copied
                                                           // Parsed-path always re-serializes: the incoming string had no
                                                           // stored title? it did — but even with nothing copied the output is
                                                           // compact stringify, never the original spelling.
        assert_ne!(merged, INC);
    }

    #[test]
    fn merge_stored_title_falsy_reserializes_unchanged_value() {
        let stored = "{\"meta\":{\"title\":\"\"}}"; // falsy stored title ⇒ no copy
        let merged = merge_protected_title(Some(stored), INC);
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["meta"]["title"], Value::String("new".into())); // incoming survives
        assert_eq!(
            merged,
            "{\"meta\":{\"title\":\"new\",\"titleSource\":\"auto\"},\"messages\":[]}"
        );
    }

    #[test]
    fn merge_non_object_meta_setting_throws_like_strict_mode() {
        // stored title truthy + incoming meta is a STRING ⇒ JS `incoming.meta.title = …`
        // throws in strict mode ⇒ catch ⇒ incoming verbatim.
        let incoming = "{\"meta\":\"oops\"}";
        assert_eq!(
            merge_protected_title(Some("{\"meta\":{\"title\":\"old\"}}"), incoming),
            incoming
        );
    }
}
