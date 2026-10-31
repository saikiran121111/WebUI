//! history.rs — browsing history + browsing-data clearing over the
//! NATIVE Chromium History database (Browser Use, Phase 13).
//!
//! [adapted] the reference reads history through its patched-Electron
//! native verbs (`searchHistory`, `getDownloadHistory`) and clears via
//! `browserSession.clearData` — none of which exist over plain CDP.
//! Ruke instead drives the Chromium profile's own SQLite `History`
//! database (the omnibox's source of truth: clearing it clears the
//! real browser's history, and reading it answers from real visits,
//! including the panel human's own navigation).
//!
//! Concurrency law: Chromium owns this database while it runs.
//! - READS never touch the live file: the `History` file plus its
//!   sidecar `History-wal` (when present) are copied to a private temp
//!   directory and queried there, so a running Chromium is never
//!   blocked and uncommitted WAL frames still come through (SQLite
//!   replays the copied WAL on open).
//! - WRITES (clear-data) open the live file with a busy timeout —
//!   WAL mode is multi-process by design — and never fight Chromium's
//!   own writes indefinitely.
//!
//! Time bases: Chromium stamps visit times in microseconds since
//! 1601-01-01 (Windows/WebKit epoch); the wire contract (schemas.rs
//! `HistoryQueryPayload`) speaks Unix milliseconds, and answers carry
//! ISO 8601 UTC timestamps — the recovered `BrowserHistoryEntry`
//! shape (`{url, title?, dateVisited}`, schemas-and-ipc §history)
//! with Ruke's snake_case wire convention.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::engine::BROWSER_ID;
use crate::errors::BrowserError;
use crate::host::PROFILE_DIR_NAME;
use crate::schemas::HistoryQueryPayload;

/// Microseconds between the Chromium epoch (1601-01-01) and the Unix
/// epoch (1970-01-01) — the constant Chromium itself stamps with.
pub const EPOCH_DIFF_MICROS: i64 = 11_644_473_600_000_000;

/// The default + hard-cap for returned entries. The reference
/// history-search service paginates with maxResults default 100
/// (Appendix G-4); Ruke caps the model-facing surface so one focused
/// call can never balloon the tool result.
const DEFAULT_LIMIT: u64 = 100;
const MAX_LIMIT: u64 = 500;

/// The clear-data category set. [adapted] the reference clear-data
/// dialog's exact dataTypes strings were not recovered; these four
/// cover what Ruke can honestly implement over the profile (cookies
/// and cache via CDP, history and downloads via the same History
/// database — the download store itself clears `dataTypes:
/// ['downloads']` against the native history, MAIN-A8-4).
pub const CLEAR_DATA_TYPES: [&str; 4] = ["cookies", "cache", "history", "downloads"];

fn payload_invalid(command: &str, reason: impl Into<String>) -> BrowserError {
    BrowserError::PayloadInvalid {
        command: command.into(),
        reason: reason.into(),
    }
}

fn internal(detail: impl std::fmt::Display) -> BrowserError {
    BrowserError::Internal {
        detail: format!("history db: {detail}"),
    }
}

/// Where the live profile keeps its History database: exactly where
/// Chromium put it (`--user-data-dir=<root>/.data/<PROFILE_DIR_NAME>`),
/// so a Ruke clear is indistinguishable from the omnibox "Clear
/// browsing data" on the real browser.
pub fn profile_history_db(root: &Path) -> PathBuf {
    root.join(".data")
        .join(PROFILE_DIR_NAME)
        .join("Default")
        .join("History")
}

/// Unix milliseconds → Chromium microsecond visit-time stamps.
pub fn ms_to_chrome_us(ms: i64) -> i64 {
    ms.saturating_mul(1_000) + EPOCH_DIFF_MICROS
}

/// Chromium microsecond stamp → ISO 8601 UTC (the recovered
/// `dateVisited` form). Days conversion is the standard
/// civil-from-days algorithm (Hinnant) — no calendar crate needed.
pub fn iso8601_from_chrome_us(us: i64) -> String {
    // Units are load-bearing: subtracting the µs epoch difference
    // leaves UNIX MICROSECONDS, so day boundaries sit at
    // 86_400_000_000 µs, not the ms constant.
    let unix_us = us - EPOCH_DIFF_MICROS;
    let days = unix_us.div_euclid(86_400_000_000);
    let secs_of_day = unix_us.rem_euclid(86_400_000_000) / 1_000_000;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    // Parens are load-bearing: without them the `/` parses into the
    // else-block tail and positive days never get an era division.
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097; // [0, 146_096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Validate + normalize the requested clear categories. Empty/absent
/// ⇒ all categories (payload contract); unknown names are typed
/// refusals listing the allowed set.
pub(crate) fn normalize_clear_types(
    data_types: Option<&Vec<String>>,
) -> Result<Vec<&'static str>, String> {
    let Some(list) = data_types else {
        return Ok(CLEAR_DATA_TYPES.to_vec());
    };
    if list.is_empty() {
        return Ok(CLEAR_DATA_TYPES.to_vec());
    }
    let mut out: Vec<&'static str> = Vec::new();
    for t in list {
        let Some(canonical) = CLEAR_DATA_TYPES.iter().copied().find(|c| *c == t.as_str()) else {
            return Err(format!(
                "unknown data type {t:?}: expected one of {}",
                CLEAR_DATA_TYPES.join(" | ")
            ));
        };
        if !out.contains(&canonical) {
            out.push(canonical);
        }
    }
    Ok(out)
}

/// LIKE-pattern escape so a user query's `%`/`_`/`\` match literally
/// (paired with `ESCAPE '\'` in every query here).
fn like_escape(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 8);
    for ch in term.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Copy the live History db (+ WAL sidecar when present) into a
/// private temp directory and run the history query against the copy.
/// Reading history while Chromium runs must never take the browser's
/// lock, and must still see visits Chromium has only in its WAL.
pub(crate) fn read_history_json(
    root: &Path,
    p: &HistoryQueryPayload,
) -> Result<Value, BrowserError> {
    // Filters validate FIRST (even a read against an empty profile
    // must not launder an oversized query surface into an "ok").
    // Bounded, sanitized filters (see module header for the "one
    // focused call" rule the tool description carries to the model).
    let queries: Vec<String> = match p.queries.as_deref() {
        None => Vec::new(),
        Some(qs) if qs.len() > 8 => {
            return Err(payload_invalid(
                "browser_history",
                "at most 8 history queries per call",
            ))
        }
        Some(qs) => {
            for q in qs {
                if q.chars().count() > 128 {
                    return Err(payload_invalid(
                        "browser_history",
                        "each query is at most 128 characters",
                    ));
                }
            }
            qs.iter().map(|q| q.trim().to_string()).collect()
        }
    };
    let limit = p.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let live = profile_history_db(root);
    if !live.exists() {
        // No profile has launched yet: an honest empty listing, not an
        // error — there is genuinely nothing visited.
        return Ok(json!({
            "browser_id": BROWSER_ID,
            "entries": [],
            "count": 0,
        }));
    }

    let tag = format!(
        "ruke-hist-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    let tmp_dir = std::env::temp_dir().join(&tag);
    std::fs::create_dir_all(&tmp_dir).map_err(internal)?;
    // The -shm sidecar is deliberately NOT copied: a fresh SQLite
    // open without a wal-index replays the -wal by checksum, which is
    // exactly crash-recovery semantics and immune to a torn shm copy.
    let copy_result = (|| -> Result<Vec<(String, String, i64)>, BrowserError> {
        std::fs::copy(&live, tmp_dir.join("History")).map_err(internal)?;
        let wal = live.with_file_name("History-wal");
        if wal.exists() {
            std::fs::copy(&wal, tmp_dir.join("History-wal")).map_err(internal)?;
        }
        let conn = Connection::open(tmp_dir.join("History")).map_err(internal)?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).ok();

        let mut sql = String::from(
            "SELECT u.url, IFNULL(u.title, ''), v.visit_time FROM visits v \
             JOIN urls u ON u.id = v.url WHERE 1=1",
        );
        let mut args: Vec<String> = Vec::new();
        if let Some(from) = p.from_ms {
            sql.push_str(" AND v.visit_time >= ?");
            args.push(ms_to_chrome_us(from).to_string());
        }
        if let Some(to) = p.to_ms {
            sql.push_str(" AND v.visit_time <= ?");
            args.push(ms_to_chrome_us(to).to_string());
        }
        for q in &queries {
            if q.is_empty() {
                continue;
            }
            sql.push_str(
                " AND (u.url LIKE ? ESCAPE '\\' OR IFNULL(u.title, '') LIKE ? ESCAPE '\\')",
            );
        }
        sql.push_str(" ORDER BY v.visit_time DESC, v.id DESC LIMIT ?");

        let mut stmt = conn.prepare_cached(&sql).map_err(internal)?;
        // Bound params in SQL order: from, to, then (pattern, pattern)
        // per query, then limit. rusqlite takes them positionally.
        let mut idx: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        for a in &args {
            idx.push(Box::new(a.clone()));
        }
        for q in &queries {
            if q.is_empty() {
                continue;
            }
            let pattern = format!("%{}%", like_escape(q));
            idx.push(Box::new(pattern.clone()));
            idx.push(Box::new(pattern));
        }
        idx.push(Box::new(limit));
        let refs: Vec<&dyn rusqlite::types::ToSql> = idx.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(internal)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(internal)?);
        }
        Ok(out)
    })();
    let rows = match copy_result {
        Ok(rows) => rows,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(e);
        }
    };
    let _ = std::fs::remove_dir_all(&tmp_dir);

    let entries: Vec<Value> = rows
        .into_iter()
        .map(|(url, title, visit_time)| {
            let mut e = json!({
                "url": url,
                "date_visited": iso8601_from_chrome_us(visit_time),
            });
            if !title.is_empty() {
                e["title"] = json!(title);
            }
            e
        })
        .collect();
    let count = entries.len() as u64;
    Ok(json!({
        "browser_id": BROWSER_ID,
        "entries": entries,
        "count": count,
        "limit": limit,
    }))
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        params![name],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .map(|c| matches!(c, Some(n) if n > 0))
}

/// Open the LIVE profile History db for writing (clear-data path).
/// Ok(None) when no profile has ever launched (nothing to clear).
fn open_live_for_write(root: &Path) -> Result<Option<Connection>, BrowserError> {
    let live = profile_history_db(root);
    if !live.exists() {
        return Ok(None);
    }
    let conn = Connection::open(&live).map_err(internal)?;
    // Chromium writes its own history through the same WAL; five
    // seconds of retry beats failing the clear on a transient lock.
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(internal)?;
    Ok(Some(conn))
}

/// Clear the browse-history tables (the omnibox rows). `downloads`
/// lives in the same database and is cleared by its own call (the
/// reference download store clears `dataTypes: ['downloads']`
/// separately — MAIN-A8-4).
pub(crate) fn clear_history_db(root: &Path) -> Result<(), BrowserError> {
    let Some(conn) = open_live_for_write(root)? else {
        return Ok(());
    };
    for table in ["visit_time_to_visit_transit", "visits", "urls"] {
        if table_exists(&conn, table).map_err(internal)? {
            conn.execute(&format!("DELETE FROM {table}"), [])
                .map_err(internal)?;
        }
    }
    if table_exists(&conn, "sqlite_sequence").map_err(internal)? {
        // Ids restart for a fresh history the same way Chromium's own
        // clear leaves them; best-effort bookkeeping, never a failure.
        let _ = conn.execute(
            "DELETE FROM sqlite_sequence WHERE name IN ('urls','visits')",
            [],
        );
    }
    Ok(())
}

/// Clear the download-history rows (Chromium's `downloads` table in
/// the same History database; missing on a fresh profile ⇒ no-op).
pub(crate) fn clear_downloads_db(root: &Path) -> Result<(), BrowserError> {
    let Some(conn) = open_live_for_write(root)? else {
        return Ok(());
    };
    if table_exists(&conn, "downloads").map_err(internal)? {
        conn.execute("DELETE FROM downloads", [])
            .map_err(internal)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(over: Value) -> HistoryQueryPayload {
        // json! has no spread operator — merge into the base envelope.
        let mut base = serde_json::Map::new();
        base.insert("browser_id".into(), json!("default"));
        if let Value::Object(m) = over {
            for (k, v) in m {
                base.insert(k, v);
            }
        }
        serde_json::from_value(Value::Object(base)).unwrap()
    }

    /// Build a fixture History db with the recovered Chromium table
    /// shapes at the live profile path under `root`.
    fn fixture(root: &Path) -> Connection {
        let dir = root.join(".data").join(PROFILE_DIR_NAME).join("Default");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("History")).unwrap();
        conn.execute_batch(
            "CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT,
                visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0,
                last_visit_time INTEGER, hidden INTEGER DEFAULT 0);
             CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER,
                visit_time INTEGER, from_visit INTEGER DEFAULT 0,
                transition INTEGER DEFAULT 0, visit_duration INTEGER DEFAULT 0);",
        )
        .unwrap();
        conn
    }

    const T_2025_01_01: i64 = 13_380_163_200_000_000; // 2025-01-01T00:00:00Z

    fn insert(conn: &Connection, id: i64, url: &str, title: &str, visit_time: i64) {
        conn.execute(
            "INSERT INTO urls(id, url, title, last_visit_time) VALUES (?1,?2,?3,?4)",
            params![id, url, title, visit_time],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO visits(id, url, visit_time) VALUES (?1,?2,?3)",
            params![id, id, visit_time],
        )
        .unwrap();
    }

    #[test]
    fn epoch_and_iso_pins_the_recovered_datevisited_form() {
        // The wire says Unix ms; Chromium stamps microseconds at the
        // 1601 epoch — the pin below is the 2025 new-year instant in
        // both bases (ms_to_chrome_us(1735689600000) == T_2025_01_01).
        assert_eq!(ms_to_chrome_us(1_735_689_600_000), T_2025_01_01);
        assert_eq!(iso8601_from_chrome_us(T_2025_01_01), "2025-01-01T00:00:00Z");
        assert_eq!(
            iso8601_from_chrome_us(ms_to_chrome_us(1_709_200_000_000)),
            "2024-02-29T09:46:40Z" // leap day must survive civil_from_days
        );
        assert_eq!(iso8601_from_chrome_us(0), "1601-01-01T00:00:00Z");
    }

    #[test]
    fn missing_profile_db_is_an_honest_empty_listing() {
        let tmp = tempfile::tempdir().unwrap();
        let v = read_history_json(tmp.path(), &payload(json!({}))).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn reads_newest_first_and_omits_blank_titles() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = fixture(tmp.path());
            insert(&conn, 1, "https://old.example/", "Old Page", T_2025_01_01);
            insert(
                &conn,
                2,
                "https://new.example/",
                "New Page",
                T_2025_01_01 + 1_000_000,
            );
            insert(
                &conn,
                3,
                "https://untitled.example/",
                "",
                T_2025_01_01 + 2_000_000,
            );
        }
        let v = read_history_json(tmp.path(), &payload(json!({}))).unwrap();
        let entries = v["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["url"], "https://untitled.example/");
        assert!(
            entries[0].get("title").is_none(),
            "blank titles never cross"
        );
        assert_eq!(entries[1]["url"], "https://new.example/");
        assert_eq!(entries[2]["url"], "https://old.example/");
        assert_eq!(entries[2]["date_visited"], "2025-01-01T00:00:00Z");
    }

    #[test]
    fn filters_urls_and_titles_case_insensitively_with_literal_wildcards() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = fixture(tmp.path());
            insert(
                &conn,
                1,
                "https://shop.example/deal50%off",
                "Beta Deal",
                T_2025_01_01,
            );
            insert(
                &conn,
                2,
                "https://docs.example/rust",
                "RUST guide",
                T_2025_01_01 + 1,
            );
            insert(
                &conn,
                3,
                "https://blog.example/x",
                "Unrelated",
                T_2025_01_01 + 2,
            );
        }
        // url substring (case-insensitive on titles):
        let v = read_history_json(tmp.path(), &payload(json!({"queries": ["rust"]}))).unwrap();
        let entries = v["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["url"], "https://docs.example/rust");
        // a literal % in the query matches a literal %, not a glob:
        let v = read_history_json(tmp.path(), &payload(json!({"queries": ["50%"]}))).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 1);
        let v = read_history_json(tmp.path(), &payload(json!({"queries": ["5%off"]}))).unwrap();
        assert_eq!(
            v["entries"].as_array().unwrap().len(),
            0,
            "escaped LIKE must not glob"
        );
        // no match ⇒ empty, not an error:
        let v = read_history_json(tmp.path(), &payload(json!({"queries": ["nothing"]}))).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn bounds_are_inclusive_milliseconds_and_limit_caps() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = fixture(tmp.path());
            for (id, ms) in [(1, 0_i64), (2, 1000), (3, 2000), (4, 3000), (5, 4000)] {
                insert(
                    &conn,
                    id,
                    &format!("https://x{id}/"),
                    "",
                    ms_to_chrome_us(1_735_689_600_000_i64 + ms),
                );
            }
        }
        let base = 1_735_689_600_000_i64;
        let v = read_history_json(
            tmp.path(),
            &payload(json!({"from_ms": base + 1000, "to_ms": base + 3000})),
        )
        .unwrap();
        let urls: Vec<&str> = v["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["url"].as_str().unwrap())
            .collect();
        assert_eq!(urls, ["https://x4/", "https://x3/", "https://x2/"]);
        let v = read_history_json(tmp.path(), &payload(json!({"limit": 2}))).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 2);
        assert_eq!(v["limit"], 2);
    }

    #[test]
    fn reads_a_chromium_wal_sidecar_while_the_writer_holds_the_live_db() {
        // Simulate a RUNNING Chromium: WAL journal, an open source
        // connection, uncheckpointed rows — the copy read must still
        // see them, and the source connection must stay usable.
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path());
        conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        insert(
            &conn,
            1,
            "https://live.example/",
            "Live Visit",
            T_2025_01_01,
        );
        assert!(tmp
            .path()
            .join(".data")
            .join(PROFILE_DIR_NAME)
            .join("Default")
            .join("History-wal")
            .exists());
        let v = read_history_json(tmp.path(), &payload(json!({}))).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 1);
        // the live writer is unbothered:
        insert(
            &conn,
            2,
            "https://still.example/",
            "Still Open",
            T_2025_01_01 + 1,
        );
    }

    #[test]
    fn clear_history_db_empties_omnibox_tables_and_tolerates_fresh_profiles() {
        let tmp = tempfile::tempdir().unwrap();
        // fresh profile: no db at all — honest no-op, not an error.
        clear_history_db(tmp.path()).unwrap();
        {
            let conn = fixture(tmp.path());
            insert(&conn, 1, "https://a/", "A", T_2025_01_01);
            conn.execute(
                "CREATE TABLE visit_time_to_visit_transit(url INTEGER, transition INTEGER, counts TEXT)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO visit_time_to_visit_transit VALUES (1, 1, '[]')",
                [],
            )
            .unwrap();
        }
        clear_history_db(tmp.path()).unwrap();
        let v = read_history_json(tmp.path(), &payload(json!({}))).unwrap();
        assert_eq!(v["entries"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn clear_downloads_db_clears_only_when_the_table_exists() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let conn = fixture(tmp.path());
            conn.execute(
                "CREATE TABLE downloads(id INTEGER PRIMARY KEY, current_path TEXT, target_path TEXT,
                   site_url TEXT, start_time INTEGER, state INTEGER, guid TEXT)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO downloads(id, target_path, start_time, state) VALUES (1,'C:/x/y.zip',1,1)",
                [],
            )
            .unwrap();
        }
        clear_downloads_db(tmp.path()).unwrap();
        let conn = Connection::open(
            tmp.path()
                .join(".data")
                .join(PROFILE_DIR_NAME)
                .join("Default")
                .join("History"),
        )
        .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM downloads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        // fresh profile without the table at all:
        let tmp2 = tempfile::tempdir().unwrap();
        {
            let _ = fixture(tmp2.path()); // no downloads table
        }
        clear_downloads_db(tmp2.path()).unwrap();
    }

    #[test]
    fn over_large_query_surfaces_are_refused_not_globbed() {
        let tmp = tempfile::tempdir().unwrap();
        let too_many: Vec<String> = (0..9).map(|i| format!("q{i}")).collect();
        let err =
            read_history_json(tmp.path(), &payload(json!({"queries": too_many}))).unwrap_err();
        assert!(matches!(err, BrowserError::PayloadInvalid { .. }));
        let long = "x".repeat(129);
        let err = read_history_json(tmp.path(), &payload(json!({"queries": [long]}))).unwrap_err();
        assert!(matches!(err, BrowserError::PayloadInvalid { .. }));
    }

    #[test]
    fn clear_categories_default_all_validate_and_dedupe() {
        assert_eq!(
            normalize_clear_types(None).unwrap(),
            CLEAR_DATA_TYPES.to_vec()
        );
        assert_eq!(
            normalize_clear_types(Some(&vec![])).unwrap(),
            CLEAR_DATA_TYPES.to_vec()
        );
        assert_eq!(
            normalize_clear_types(Some(&vec![
                "history".into(),
                "history".into(),
                "cookies".into()
            ]))
            .unwrap(),
            vec!["history", "cookies"]
        );
        let err = normalize_clear_types(Some(&vec!["wallet".into()])).unwrap_err();
        assert!(err.contains("wallet") && err.contains("cookies"), "{err}");
    }

    #[test]
    fn live_profile_path_tracks_the_host_launcher() {
        // mirrors host.rs: root/.data/<PROFILE_DIR_NAME>/Default/History
        let p = profile_history_db(Path::new("/r"));
        assert_eq!(
            p,
            PathBuf::from("/r")
                .join(".data")
                .join(PROFILE_DIR_NAME)
                .join("Default")
                .join("History")
        );
    }
}
