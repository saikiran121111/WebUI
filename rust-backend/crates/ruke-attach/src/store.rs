//! `lib/server/attachindex/store.ts` — the READ/notes half, ported for
//! parity; `writeIndex`/index-building stay in Node (frozen boundary §1).
//!
//! Same frozen disk format the Node writer produces under
//! `<root>/.data/attach-index/<attId>/` (TS root is `process.cwd()`; Rust
//! threads the project root through every call instead of a module global —
//! the only way the Rust replay tests can point at a fixture store without
//! polluting the live workspace).
//!
//! Throw boundaries mirrored EXACTLY:
//! - `indexDir` "throws" on a bad id (invalid `ATT_RE`); every TS public
//!   entry except `writeNotes` wraps its whole body in try/catch, so an
//!   invalid id reads as `null`. `writeNotes` is NOT wrapped — the throw
//!   propagates (its caller in `notes.ts` catches). Rust models the throw
//!   as `Result<(), String>` on `write_notes` and `Option` (None) on every
//!   reading function.
//! - `readNotes` returns the stored `notes` string; a missing file or bad
//!   JSON is `None`. An empty-string note value stays `Some("")` so the
//!   call sites can reproduce TS's `?? ` (nullish, NOT falsy) fallback vs.
//!   `if (notes)` (falsy) decision separately. The I24 versioned form
//!   (`readNotes(attId, expectedVersion)` ⇔ `read_notes_with_version`)
//!   additionally demands an exact `version` key: a pre-versioning file
//!   reads stale (`env?.version !== expected` ⇒ null in TS).
//! - Shown-ledger reads/writes (`readShown`/`writeShown`/`shownDelete`,
//!   I20) are try-wrapped on both sides in TS — every failure (bad id,
//!   corrupt aggregate, failed rename) collapses to empty/silent. Rust
//!   models that with NO error variant: `read_shown` returns an empty
//!   Vec and `write_shown` swallows every IO error.
//! - Atomic writes: `writeFileSync(f+".tmp") + renameSync` preserved —
//!   `std::fs::rename` replaces an existing target on Windows the same way
//!   Node's does. No locking is added (it would change Node-visible
//!   behavior, forbidden by the brief).
//!
//! LRU (3, insertion-order) is preserved. DOCUMENTED DEVIATION: the TS
//! cache is keyed by `attId` under a single module-global ROOT; the Rust
//! cache is keyed by the full index-dir path so a replay test pointed at a
//! temp root can never collide with the live workspace root in the same
//! process. Under the single-root production process the observable
//! behavior (hit refresh, LRU_MAX=3 eviction, no notes-write eviction) is
//! identical.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::types::{IndexChunk, IndexMeta, LoadedIndex};

/// `ATT_RE = /^att_[a-z0-9]{4,32}$/` (ASCII class, anchored both ends).
pub fn valid_att_id(s: &str) -> bool {
    let Some(tail) = s.strip_prefix("att_") else {
        return false;
    };
    (4..=32).contains(&tail.len())
        && tail
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn index_dir_checked(root: &Path, att_id: &str) -> Result<PathBuf, String> {
    if !valid_att_id(att_id) {
        return Err(format!("invalid attachment id: {att_id}"));
    }
    Ok(root.join(".data").join("attach-index").join(att_id))
}

/// The index dir for a VALID id; `None` is the TS `indexDir` throw. Public
/// so turn-injection (frames) and tests can resolve paths.
pub fn index_dir(root: &Path, att_id: &str) -> Option<PathBuf> {
    index_dir_checked(root, att_id).ok()
}

/// `hasIndex`: `existsSync(<dir>/meta.json)`; a bad id reads false.
pub fn has_index(root: &Path, att_id: &str) -> bool {
    match index_dir_checked(root, att_id) {
        Err(_) => false,
        Ok(dir) => dir.join("meta.json").exists(),
    }
}

/// `removeIndex` (Part 7, called by conversation DELETE): cache-delete +
/// `rmSync(dir, { recursive: true, force: true })`, tolerant of unknown and
/// malformed ids and NEVER throwing — the TS whole-body `try/catch` swallows
/// both the `indexDir` bad-id throw and any rm error (force only suppresses
/// ENOENT; the surviving try/catch covers the rest, so silently-continuing
/// is faithful, not a weakening). A bad id deletes nothing: only valid ids
/// can ever be cache keys, so skipping cacheDelete is equivalent.
pub fn remove_index(root: &Path, att_id: &str) {
    let Ok(dir) = index_dir_checked(root, att_id) else {
        return;
    };
    cache().lock().retain(|(d, _)| *d != dir); // cacheDelete (attId ⇔ dir key)
    shown_delete(root, att_id); // I20: a dropped index drops its ledger key too
    let _ = std::fs::remove_dir_all(&dir);
}

/// `atomicWrite`: tmp-suffix write + rename (rename replaces on Windows,
/// ⇔ Node `renameSync`).
fn atomic_write(file: &Path, data: &str) -> std::io::Result<()> {
    let tmp = format!("{}.tmp", file.to_string_lossy());
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, file)
}

const LRU_MAX: usize = 3;

type CacheEntry = (PathBuf, Arc<LoadedIndex>);
static CACHE: OnceLock<Mutex<Vec<CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<Vec<CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Test-only serialization gate for the process-global LRU (production
/// builds: zero cost, zero effect). CACHE ⇔ the TS module-level Map, but
/// the cargo harness runs a crate's tests as THREADS in ONE process while
/// vitest isolates files into separate worker processes — so concurrent
/// tests interleave insert/evict here where TS never could. Tests that
/// assert cache internals (lru_three_entries…) hold this across their
/// whole sequence; `read_index` takes it per call so no other test can
/// interleave mid-sequence. Reentrant: the holder re-enters via its own
/// `read_index` calls.
#[cfg(test)]
fn cache_gate() -> &'static parking_lot::ReentrantMutex<()> {
    static G: OnceLock<parking_lot::ReentrantMutex<()>> = OnceLock::new();
    G.get_or_init(|| parking_lot::ReentrantMutex::new(()))
}

/// `readIndex`: every failure mode (bad id, missing meta, unreadable,
/// bad JSON, BAD JSONL LINE, unreadable chunks) collapses to `None` with
/// the cache untouched — exactly the TS whole-body `try/catch`.
pub fn read_index(root: &Path, att_id: &str) -> Option<Arc<LoadedIndex>> {
    #[cfg(test)]
    let _gate = cache_gate().lock();
    let dir = index_dir_checked(root, att_id).ok()?;
    {
        let mut c = cache().lock();
        if let Some(pos) = c.iter().position(|(d, _)| *d == dir) {
            let e = c.remove(pos); // refresh recency (Map delete+set)
            c.push(e);
            return Some(c.last()?.1.clone());
        }
    }
    let meta_path = dir.join("meta.json");
    if !meta_path.exists() {
        return None;
    }
    let meta: IndexMeta = serde_json::from_str(&std::fs::read_to_string(meta_path).ok()?).ok()?;
    let chunks_text = std::fs::read_to_string(dir.join("chunks.jsonl")).ok()?;
    let mut chunks: Vec<IndexChunk> = Vec::new();
    for line in chunks_text.split('\n') {
        if line.trim().is_empty() {
            continue; // `.filter(l => l.trim())`
        }
        chunks.push(serde_json::from_str::<IndexChunk>(line).ok()?); // one bad line ⇒ whole read null
    }
    let loaded = Arc::new(LoadedIndex { meta, chunks });
    let mut c = cache().lock();
    c.push((dir, loaded.clone()));
    while c.len() > LRU_MAX {
        c.remove(0); // Map.keys().next() == oldest insertion
    }
    Some(loaded)
}

/// `readNotes`: never throws (a bad id reads `None`). See module docs for
/// the `Some("")` nuance and the typed-`notes` deviation on hand-corrupted
/// files (TS would surface the raw non-string value; Rust reads `None`).
pub fn read_notes(root: &Path, att_id: &str) -> Option<String> {
    let dir = index_dir_checked(root, att_id).ok()?;
    let f = dir.join("notes.json");
    if !f.exists() {
        return None;
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok()?;
    match v.get("notes") {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `readNotes(attId, expectedVersion)` (I24): a versioned read. The file
/// must carry a `version` string EXACTLY equal to `expected` — a file
/// written before versioning reads stale, ⇔ TS `env?.version !==
/// expectedVersion ⇒ null` (a missing key is `undefined`, never equal).
/// Same never-throws boundary as `read_notes`.
pub fn read_notes_with_version(root: &Path, att_id: &str, expected: &str) -> Option<String> {
    let dir = index_dir_checked(root, att_id).ok()?;
    let f = dir.join("notes.json");
    if !f.exists() {
        return None;
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok()?;
    if v.get("version").and_then(Value::as_str) != Some(expected) {
        return None;
    }
    match v.get("notes") {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `writeNotes(attId, notes, version?)`: NOT try-wrapped in TS — a bad id
/// is an `Err` here and the caller (`notes.ts::generateNotes`) swallows
/// it, exactly as the TS `try { writeNotes } catch {}` does. File shape
/// `{notes, createdAt}` — plus `version` LAST and ONLY when provided
/// (I24) — is written COMPACT (no indent) like `JSON.stringify(obj)`,
/// with the key order preserved.
pub fn write_notes(
    root: &Path,
    att_id: &str,
    notes: &str,
    version: Option<&str>,
) -> Result<(), String> {
    let dir = index_dir_checked(root, att_id)?;
    // `Date.now()` — integer epoch millis.
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut map = serde_json::Map::new();
    map.insert("notes".to_string(), json!(notes));
    map.insert("createdAt".to_string(), json!(created_at));
    if let Some(v) = version {
        map.insert("version".to_string(), json!(v));
    }
    let body = serde_json::to_string(&Value::Object(map)).map_err(|e| e.to_string())?;
    atomic_write(&dir.join("notes.json"), &body).map_err(|e| e.to_string())
}

// ─── I20: the shown ledger ───────────────────────────────────────────────
// Deliberately ONE aggregate file per root (`<root>/.data/attach-index/
// .shown.json`, a map attId → number[]) instead of a per-attachment file
// inside the index dir: (a) the golden store fixture pins the EXACT
// per-attachment file set (`chunks.jsonl`/`full.txt`/`meta.json` only), so
// a new per-dir file would drift it, and (b) the TS side runs parallel
// vitest workers sharing one root where per-dir rewrites would race.
// Mirror of the I20 comment in `store.ts`.

fn shown_file(root: &Path) -> PathBuf {
    root.join(".data").join("attach-index").join(".shown.json")
}

/// `readShownMap`: missing/corrupt/non-object (an array counts as
/// non-object here) ⇒ empty map, ⇔ TS `try { JSON.parse } catch {}` plus
/// `raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}`.
fn read_shown_map(root: &Path) -> serde_json::Map<String, Value> {
    let parsed = std::fs::read_to_string(shown_file(root))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    match parsed {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    }
}

/// `readShown`: bad id ⇒ `[]`; missing/corrupt ⇒ `[]`; entries filtered to
/// integers (`Number.isInteger` ⇔ serde `as_i64`, which accepts integral
/// floats and rejects fractions/strings, exactly like JS).
pub fn read_shown(root: &Path, att_id: &str) -> Vec<i64> {
    if !valid_att_id(att_id) {
        return Vec::new();
    }
    match read_shown_map(root).get(att_id).and_then(Value::as_array) {
        Some(arr) => arr.iter().filter_map(Value::as_i64).collect(),
        None => Vec::new(),
    }
}

/// `writeShown`: bad id is a silent no-op (TS `ATT_RE` guard), then a
/// read-modify-write of the aggregate map, atomic-rename. The ledger is an
/// OPTIMIZATION — losing it must never break a turn, so every IO error is
/// swallowed (TS whole-body `try/catch {}`).
pub fn write_shown(root: &Path, att_id: &str, ids: &[i64]) {
    if !valid_att_id(att_id) {
        return;
    }
    let mut map = read_shown_map(root);
    map.insert(
        att_id.to_string(),
        Value::Array(ids.iter().map(|n| json!(*n)).collect()),
    );
    if let Ok(body) = serde_json::to_string(&Value::Object(map)) {
        let _ = atomic_write(&shown_file(root), &body);
    }
}

/// `shownDelete` (private in TS): early-exit when the key is absent so a
/// GC path never rewrites a clean file; never throws.
fn shown_delete(root: &Path, att_id: &str) {
    let mut map = read_shown_map(root);
    if !map.contains_key(att_id) {
        return;
    }
    map.remove(att_id);
    if let Ok(body) = serde_json::to_string(&Value::Object(map)) {
        let _ = atomic_write(&shown_file(root), &body);
    }
}

/// Monotonic-ish source for tests needing a fake clock without touching
/// this module's time source (not used in production paths).
#[allow(dead_code)]
fn now_ms() -> u64 {
    static FAKE: AtomicU64 = AtomicU64::new(0);
    FAKE.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_store(root: &Path, att: &str, meta_json: &str, jsonl: &str) {
        let dir = root.join(".data").join("attach-index").join(att);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("meta.json"), meta_json).unwrap();
        std::fs::write(dir.join("chunks.jsonl"), jsonl).unwrap();
    }

    fn uniq_root(tag: &str) -> PathBuf {
        // Isolated roots so the global LRU never leaks between tests
        // (per-root keying — the documented deviation).
        let p = std::env::temp_dir().join(format!(
            "ruke-attach-store-{}-{}-{}",
            tag,
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn att_id_validation_matches_att_re() {
        assert!(valid_att_id("att_golden1a"));
        assert!(valid_att_id("att_abcd")); // tail len 4
        assert!(valid_att_id(&format!("att_{}", "a".repeat(32))));
        assert!(!valid_att_id(&format!("att_{}", "a".repeat(33))));
        assert!(!valid_att_id("att_abc")); // tail len 3
        assert!(!valid_att_id("ATT_abcd"));
        assert!(!valid_att_id("att_abcd_")); // underscore not in [a-z0-9]
        assert!(!valid_att_id("att_abcd/../evil"));
        assert!(!valid_att_id("evil"));
    }

    #[test]
    fn bad_id_reads_null_everywhere_but_write_notes_throws() {
        let root = uniq_root("badid");
        assert!(!has_index(&root, "bad"));
        assert!(read_index(&root, "bad").is_none());
        assert!(read_notes(&root, "bad").is_none());
        // TS writeNotes is not try-wrapped: the throw surfaces.
        assert!(write_notes(&root, "bad", "x", None).is_err());
    }

    #[test]
    fn read_index_tolerates_blank_lines_and_fails_on_bad_line() {
        let root = uniq_root("jsonl");
        let meta = r#"{"attId":"att_ok01","name":"n","category":"text","createdAt":0,"chunkCount":2,"spine":"","spineBlocks":[],"frames":[]}"#;
        seed_store(
            &root,
            "att_ok01",
            meta,
            "{\"i\":0,\"startSec\":null,\"endSec\":null,\"text\":\"a\",\"vec\":[]}\n\n",
        );
        let idx = read_index(&root, "att_ok01").expect("trailing newline ok");
        assert_eq!(idx.chunks.len(), 1);

        // Fresh att id (AND ≥4-char ATT_RE tail) ⇒ cold cache: the
        // bad-line read must not be served from the hot LRU entry.
        let meta2 = r#"{"attId":"att_bad01","name":"n","category":"text","createdAt":0,"chunkCount":2,"spine":"","spineBlocks":[],"frames":[]}"#;
        seed_store(
            &root,
            "att_bad01",
            meta2,
            "{\"i\":0,\"text\":\"a\"}\ngarbage line\n",
        );
        assert!(
            read_index(&root, "att_bad01").is_none(),
            "one bad JSONL line ⇒ whole read null"
        );
    }

    #[test]
    fn missing_meta_or_chunks_reads_null() {
        let root = uniq_root("missing");
        assert!(!has_index(&root, "att_gone1"));
        assert!(read_index(&root, "att_gone1").is_none());
        let dir = root.join(".data").join("attach-index").join("att_half1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("chunks.jsonl"), "").unwrap(); // meta missing
        assert!(!has_index(&root, "att_half1"));
        assert!(read_index(&root, "att_half1").is_none());
    }

    #[test]
    fn notes_roundtrip_empty_string_and_missing() {
        let root = uniq_root("notes");
        assert!(read_notes(&root, "att_note1").is_none());
        std::fs::create_dir_all(root.join(".data").join("attach-index").join("att_note1")).unwrap();
        write_notes(&root, "att_note1", "hello", None).unwrap();
        assert_eq!(read_notes(&root, "att_note1").as_deref(), Some("hello"));
        write_notes(&root, "att_note1", "", None).unwrap();
        // Empty string survives as Some("") — the ?? vs falsy split lives
        // at the call sites, not here.
        assert_eq!(read_notes(&root, "att_note1").as_deref(), Some(""));
        // Compact shape, notes first, integer createdAt (⇔ JSON.stringify).
        let raw = std::fs::read_to_string(
            root.join(".data")
                .join("attach-index")
                .join("att_note1")
                .join("notes.json"),
        )
        .unwrap();
        assert!(raw.starts_with("{\"notes\":\"\",\"createdAt\":"), "{raw}");
        assert!(raw.ends_with('}') && !raw.contains('\n'));
    }

    #[test]
    fn notes_version_envelope_and_versioned_reads_i24() {
        let root = uniq_root("nver");
        let att = "att_nver01";
        let dir = root.join(".data").join("attach-index").join(att);
        std::fs::create_dir_all(&dir).unwrap();
        let ver = "v1|default|2|24|1:0-1";

        write_notes(&root, att, "body", Some(ver)).unwrap();
        let raw = std::fs::read_to_string(dir.join("notes.json")).unwrap();
        // Key order ⇔ `JSON.stringify({notes, createdAt, version})`:
        // version LAST and ONLY when provided; compact; no trailing newline.
        assert!(
            raw.starts_with("{\"notes\":\"body\",\"createdAt\":"),
            "{raw}"
        );
        assert!(raw.ends_with(&format!(",\"version\":\"{ver}\"}}")), "{raw}");
        assert!(!raw.contains('\n'));

        assert_eq!(
            read_notes_with_version(&root, att, ver).as_deref(),
            Some("body")
        );
        assert_eq!(
            read_notes_with_version(&root, att, "v1|other|2|24|1:0-1"),
            None
        );
        assert_eq!(read_notes(&root, att).as_deref(), Some("body")); // version-agnostic

        // A pre-versioning file (no key) reads STALE under a versioned
        // read (TS `undefined !== expected`) but plain-reads fine.
        let att2 = "att_nver02";
        std::fs::create_dir_all(root.join(".data").join("attach-index").join(att2)).unwrap();
        write_notes(&root, att2, "old", None).unwrap();
        let raw2 = std::fs::read_to_string(
            root.join(".data")
                .join("attach-index")
                .join(att2)
                .join("notes.json"),
        )
        .unwrap();
        assert!(!raw2.contains("version"), "{raw2}");
        assert_eq!(read_notes_with_version(&root, att2, ver), None);
        assert_eq!(read_notes(&root, att2).as_deref(), Some("old"));
    }

    #[test]
    fn shown_ledger_roundtrip_filters_and_remove_index_i20() {
        let root = uniq_root("shown");
        // TS realistically writes the ledger only while an index dir
        // exists; mirror that precondition here.
        let idx_root = root.join(".data").join("attach-index");
        std::fs::create_dir_all(&idx_root).unwrap();
        assert_eq!(read_shown(&root, "att_shw01"), Vec::<i64>::new()); // no file yet

        write_shown(&root, "att_shw01", &[0, 1]);
        write_shown(&root, "att_shw02", &[5]);
        assert_eq!(read_shown(&root, "att_shw01"), vec![0, 1]); // RMW keeps the sibling key
        assert_eq!(read_shown(&root, "att_shw02"), vec![5]);

        // Bad id: write no-ops, read is empty (⇔ ATT_RE guard both sides).
        write_shown(&root, "bad", &[1]);
        assert_eq!(read_shown(&root, "bad"), Vec::<i64>::new());
        let shown = idx_root.join(".shown.json");
        assert!(!std::fs::read_to_string(&shown).unwrap().contains("bad"));

        // Corrupt aggregate ⇒ every read falls back to empty (⇔ parse
        // catch ⇒ `{}`); the NEXT good write restarts from `{}` — entries
        // that could not be read are discarded, exactly like TS.
        std::fs::write(&shown, "not json").unwrap();
        assert_eq!(read_shown(&root, "att_shw01"), Vec::<i64>::new());
        write_shown(&root, "att_shw03", &[7]);
        assert_eq!(read_shown(&root, "att_shw03"), vec![7]);
        assert_eq!(read_shown(&root, "att_shw02"), Vec::<i64>::new());

        // Non-integer entries are filtered (JS Number.isInteger ⇔ as_i64).
        std::fs::write(&shown, "{\"att_shw01\":[1,2.5,\"x\",3],\"att_shw03\":[7]}").unwrap();
        assert_eq!(read_shown(&root, "att_shw01"), vec![1, 3]);
        assert_eq!(read_shown(&root, "att_shw03"), vec![7]);

        // remove_index drops the index's ledger key (I20: a rebuilt index
        // has NEW chunk ids — a stale ledger would demote wrong chunks
        // forever) and leaves siblings alone; an absent key is an
        // early-exit that never rewrites the file (TS `in` guard).
        let meta = "{\"attId\":\"att_shw01\",\"name\":\"n\",\"category\":\"text\",\"createdAt\":0,\"chunkCount\":0,\"spine\":\"\",\"spineBlocks\":[],\"frames\":[]}";
        seed_store(&root, "att_shw01", meta, "");
        remove_index(&root, "att_shw01");
        assert!(!idx_root.join("att_shw01").exists());
        assert_eq!(read_shown(&root, "att_shw01"), Vec::<i64>::new());
        assert_eq!(read_shown(&root, "att_shw03"), vec![7]);
        remove_index(&root, "att_gone99"); // absent key AND no dir: silent
        assert_eq!(read_shown(&root, "att_shw03"), vec![7]);
    }

    #[test]
    fn lru_three_entries_evict_oldest_hit_refreshes() {
        // Holds the whole multi-step cache sequence (see cache_gate docs).
        let _gate = cache_gate().lock();
        let root = uniq_root("lru");
        let meta = |att: &str| {
            format!(
                "{{\"attId\":\"{att}\",\"name\":\"n\",\"category\":\"text\",\"createdAt\":0,\"chunkCount\":0,\"spine\":\"\",\"spineBlocks\":[],\"frames\":[]}}"
            )
        };
        for att in ["att_lruaa", "att_lrubb", "att_lrucc", "att_lrudd"] {
            seed_store(&root, att, &meta(att), "");
        }
        assert!(read_index(&root, "att_lruaa").is_some());
        assert!(read_index(&root, "att_lrubb").is_some());
        assert!(read_index(&root, "att_lruaa").is_some()); // refresh a
        assert!(read_index(&root, "att_lrucc").is_some()); // cache: [b, a, c]
        assert_eq!(cache().lock().len(), 3);
        assert!(read_index(&root, "att_lrudd").is_some()); // evicts b
        let held: Vec<PathBuf> = cache().lock().iter().map(|(d, _)| d.clone()).collect();
        assert!(
            !held.iter().any(|d| d.ends_with("att_lrubb")),
            "oldest (b) must be evicted"
        );
        assert!(
            held.iter().any(|d| d.ends_with("att_lruaa")),
            "hit-refresh must keep a"
        );
        // Eviction is invisible to callers: reads re-load from disk.
        assert!(read_index(&root, "att_lrubb").is_some());
    }

    #[test]
    fn remove_index_deletes_dir_and_evicts_cache_entry() {
        let root = uniq_root("rmidx");
        let meta =
            "{\"attId\":\"att_rm001\",\"name\":\"n\",\"category\":\"text\",\"createdAt\":0,\"chunkCount\":0,\"spine\":\"\",\"spineBlocks\":[],\"frames\":[]}";
        seed_store(&root, "att_rm001", meta, "");
        assert!(read_index(&root, "att_rm001").is_some()); // warm the global LRU

        remove_index(&root, "att_rm001");
        assert!(!root
            .join(".data")
            .join("attach-index")
            .join("att_rm001")
            .exists());
        assert!(!has_index(&root, "att_rm001"));
        // The cache entry must have been evicted, not served after delete
        // (a stale hit would return Some here).
        assert!(read_index(&root, "att_rm001").is_none());

        // Malformed and unknown ids: never throw, never create anything
        // (TS whole-body try/catch parity).
        remove_index(&root, "bad");
        remove_index(&root, "att_none1");
        assert!(!root
            .join(".data")
            .join("attach-index")
            .join("att_none1")
            .exists());
    }
}
