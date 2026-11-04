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

/// Run `op` against the LIVE profile History db with an acquired
/// write. A missing profile db is a clean no-op.
///
/// Phase 26 [adapted] — the gap battery proved the concurrency law
/// exactly: while a Chromium session is alive, its history service
/// holds the profile History db at an exclusive grade for the whole
/// session — even a read-only external connection stays SQLITE_BUSY
/// past 20 s (rows live in the WAL; the main db file never grows).
/// NO external live write can ever win that race, so the live-host
/// clear path goes through Chromium's own "Clear browsing data"
/// dialog instead (executor's `clear_history_via_settings_ui`; the
/// reference product likewise clears in-process through
/// `browserSession.clearData`, never through SQLite). This writer
/// remains the host-DOWN path — with no session holding the db it
/// succeeds immediately — and keeps its bounded busy retry purely so
/// a stray checkpoint or a half-exited process can't wedge an honest
/// clear. Retries never fake success: the clear answers Ok only
/// after the DELETEs actually ran, and still fails closed past the
/// deadline.
fn live_history_write(
    root: &Path,
    op: impl Fn(&Connection) -> rusqlite::Result<()>,
) -> Result<(), BrowserError> {
    let live = profile_history_db(root);
    if !live.exists() {
        return Ok(());
    }
    // ~2 s of waiting per attempt plus a pause; eight attempts ≈ 18 s
    // ceiling — long enough for Chromium's visit flush to commit,
    // short enough to fail an honestly wedged database promptly.
    const ATTEMPTS: u32 = 8;
    const PER_ATTEMPT: std::time::Duration = std::time::Duration::from_secs(2);
    const PAUSE: std::time::Duration = std::time::Duration::from_millis(250);
    // SQLITE_BUSY (5) / SQLITE_LOCKED (6) base codes; extended
    // variants (e.g. SQLITE_BUSY_SNAPSHOT) share the low byte.
    const SQLITE_BUSY: i32 = 5;
    const SQLITE_LOCKED: i32 = 6;
    let mut last_detail = String::from("database is locked");
    for _ in 0..ATTEMPTS {
        let conn = Connection::open(&live).map_err(internal)?;
        conn.busy_timeout(PER_ATTEMPT).map_err(internal)?;
        match op(&conn) {
            Ok(()) => return Ok(()),
            Err(e @ rusqlite::Error::SqliteFailure(f, _))
                if f.extended_code & 0xFF == SQLITE_BUSY
                    || f.extended_code & 0xFF == SQLITE_LOCKED =>
            {
                last_detail = e.to_string();
                std::thread::sleep(PAUSE);
            }
            Err(e) => return Err(internal(e)),
        }
    }
    Err(internal(format!(
        "{last_detail} after {ATTEMPTS} clear attempts"
    )))
}

/// Clear the browse-history tables (the omnibox rows) — the
/// host-DOWN path (see [`live_history_write`]; with the Chromium
/// session running, the executor routes the clear through the
/// browser's own settings dialog instead). `downloads` lives in the
/// same database and is cleared by its own call (the reference
/// download store clears `dataTypes: ['downloads']` separately —
/// MAIN-A8-4).
pub(crate) fn clear_history_db(root: &Path) -> Result<(), BrowserError> {
    live_history_write(root, |conn| {
        for table in ["visit_time_to_visit_transit", "visits", "urls"] {
            if table_exists(conn, table)? {
                conn.execute(&format!("DELETE FROM {table}"), [])?;
            }
        }
        if table_exists(conn, "sqlite_sequence")? {
            // Ids restart for a fresh history the same way Chromium's
            // own clear leaves them; best-effort bookkeeping, never a
            // failure (each attempt reopens, so this runs again on
            // every try).
            let _ = conn.execute(
                "DELETE FROM sqlite_sequence WHERE name IN ('urls','visits')",
                [],
            );
        }
        Ok(())
    })
}

/// Clear the download-history rows (Chromium's `downloads` table in
/// the same History database; missing on a fresh profile ⇒ no-op).
pub(crate) fn clear_downloads_db(root: &Path) -> Result<(), BrowserError> {
    live_history_write(root, |conn| {
        if table_exists(conn, "downloads")? {
            conn.execute("DELETE FROM downloads", [])?;
        }
        Ok(())
    })
}

/// Shared helpers for the two "Clear browsing data" dialog scripts
/// below. The settings UI is a mix of cr-lit shadow hosts and Polymer
/// elements (proven on chromium-1243/1247): Polymer stamps its
/// template into a shadow root that is NOT exposed on `.shadowRoot`
/// but IS reachable on the instance's `.root` property, so the walk
/// crosses both (every candidate is validated by `sr.host`, the one
/// shape both kinds share, and deduped so a double-exposed root is
/// visited once). These run as one-shot evaluates — the executor's
/// wait loops live on the Rust side so no single CDP call ever runs
/// near `cdp::CALL_TIMEOUT`.
const CLEAR_DIALOG_HELPERS_JS: &str = "
  const rootList = () => {
    const seen = new Set([document]), q = [document], out = [];
    while (q.length) {
      const r = q.shift();
      out.push(r);
      const all = r.querySelectorAll ? r.querySelectorAll('*') : [];
      for (const n of all) {
        for (const sr of [n.shadowRoot, n.root]) {
          if (sr && sr.host && !seen.has(sr)) { seen.add(sr); q.push(sr); }
        }
      }
    }
    return out;
  };
  const deep = (sel) => { for (const r of rootList()) { const el = r.querySelector(sel); if (el) return el; } return null; };
  const deepAll = (sel) => { const out = []; for (const r of rootList()) out.push(...r.querySelectorAll(sel)); return out; };
";

/// Probe script for the transient `chrome://settings/clearBrowserData`
/// tab (live-host clear path — see [`live_history_write`] for why an
/// external SQLite write can never win there, and the executor's
/// `clear_history_via_settings_ui` for the drive). The deep link
/// lands the tab on the settings page and stamps the
/// `settings-clear-browsing-data-dialog` element; its confirm
/// control is VISIBLE exactly while the dialog is up —
/// `$.deleteButton` ("Delete from this device") on the
/// chromium-1243/1247 Sectional-Experience build (the dialog's
/// template sits behind a Polymer root `querySelector` chains cannot
/// cross, and the id that build ships on is `deleteButton`, not the
/// historical `#clearBrowsingDataConfirm`), with the older
/// id-lookup kept as fallback. Visibility (`offsetWidth`) is the
/// state, not mere element existence: the element is mounted from
/// page boot. Returns 'present' while visible and 'absent'
/// before/after; the same probe serves the appear-wait and the
/// close-wait.
pub(crate) fn clear_probe_js() -> String {
    format!(
        "(() => {{ {CLEAR_DIALOG_HELPERS_JS}
          const d = deep('settings-clear-browsing-data-dialog');
          if (d) {{
            const btn = (d.$ && d.$.deleteButton) || deep('#clearBrowsingDataConfirm');
            return (btn && btn.offsetWidth > 0 && btn.offsetHeight > 0) ? 'present' : 'absent';
          }}
          return deep('#clearBrowsingDataConfirm') ? 'present' : 'absent';
        }})()"
    )
}

/// Template for the one-shot drive script (an ASYNC body — the
/// executor's evaluate passes `awaitPromise`): it first forces the
/// time range to ALL time (a command that says "clear" means clear,
/// not "clear the last hour"). On the chromium-1243/1247 build the
/// range renders as `cr-chip`s inside the dialog's `$.timePicker`
/// with "All time" hidden until `#moreButton` opens a
/// `cr-action-menu` of `button[role=menuitem]` entries (clicking
/// More stamps it into the picker's root; the script waits one
/// settle tick before re-finding the entry) — with the older
/// `#timeRange` select kept as fallback. It then scopes the row
/// search to the dialog's own subtree (the settings page mounts
/// more checkboxes than the dialog's four) and sets every row to
/// EXACTLY the requested selection: rows are
/// `settings-checkbox`/`cr-check-box` hosts matched by their visible
/// label text (stable across the settings refactor churn that moves
/// element ids). Toggling goes through the `checked` PROPERTY: this
/// build's `settings-checkbox` has no native input (its `$` map
/// exposes a `checkbox` DIV) and is Polymer-gesture driven, so a
/// synthetic host click is inert, while the property set is exactly
/// what the element's own change handler performs and flows through
/// the same notify binding; each row is read back. Every row the
/// caller did not authorize is explicitly UNCHECKED so the dialog's
/// default all-checked state can never delete more than the command
/// allowed.
/// A row that fails to reach its requested state after toggling
/// aborts the drive ('rows-not-set') instead of clicking confirm on
/// a wrong selection. The confirm click only CLOSES the dialog when
/// Chromium itself accepted the deletion, so the executor's
/// post-click probe loop, not this script, is what establishes
/// 'cleared'.
const CLEAR_SETUP_JS_BODY: &str = "
  const d = deep('settings-clear-browsing-data-dialog');
  if (!d) return { status: 'dialog-not-found' };
  const confirmBtn = (d.$ && d.$.deleteButton) || deep('#clearBrowsingDataConfirm');
  if (!confirmBtn) return { status: 'confirm-not-found' };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let timeRange = 'unchanged';
  const tp = d.$ && d.$.timePicker;
  if (tp) {
    const findEntry = () => {
      const roots = [tp, tp.root];
      if (tp.$) for (const k of Object.keys(tp.$)) { roots.push(tp.$[k]); roots.push(tp.$[k] && tp.$[k].root); }
      for (const r of roots) {
        const items = r && r.querySelectorAll
          ? r.querySelectorAll('cr-chip, cr-menu-item, button[role=\"menuitem\"], .dropdown-item')
          : [];
        for (const c of items) if ((c.textContent || '').trim().toLowerCase() === 'all time') return c;
      }
      return null;
    };
    let entry = findEntry();
    if (!entry && tp.$ && tp.$.moreButton) { tp.$.moreButton.click(); await sleep(500); entry = findEntry(); }
    if (entry) { entry.click(); timeRange = 'allTime-' + (entry.tagName === 'CR-CHIP' ? 'chip' : 'menu'); }
  }
  if (timeRange === 'unchanged') {
    const range = deep('#timeRange');
    if (range) {
      try {
        range.value = 'allTime';
        range.dispatchEvent(new Event('change', { bubbles: true }));
        timeRange = range.value === 'allTime' ? 'allTime' : 'stuck:' + range.value;
      } catch (e) { timeRange = 'error:' + e; }
    }
  }
  const inDialog = (el) => {
    for (let n = el, i = 0; n && i < 40; i += 1) {
      if (n === d) return true;
      n = n.parentElement || (n.getRootNode && n.getRootNode().host);
    }
    return false;
  };
  let rowsSeen = 0, rowsSet = 0;
  for (const box of deepAll('settings-checkbox, cr-check-box, cr-checkbox').filter(inDialog)) {
    rowsSeen += 1;
    const label = (box.getAttribute('label') || box.textContent || '').toLowerCase();
    let want = false;
    if (label.includes('browsing history')) want = @@WANT_HISTORY@@;
    else if (label.includes('download history')) want = @@WANT_DOWNLOADS@@;
    if (box.checked !== want) box.checked = want;
    if (box.checked === want) rowsSet += 1;
  }
  if (rowsSeen === 0) return { status: 'no-checkbox-rows', timeRange };
  if (rowsSet !== rowsSeen) return { status: 'rows-not-set', timeRange, rowsSeen, rowsSet };
  confirmBtn.click();
  return { status: 'clicked', timeRange, rowsSeen, rowsSet };
";

/// Wrap [`CLEAR_SETUP_JS_BODY`] (plus the shared shadow-root helpers)
/// into one async IIFE, instantiating it for one requested selection
/// (history and/or download history; every other row is explicitly
/// left unchecked).
pub(crate) fn clear_setup_js(want_history: bool, want_downloads: bool) -> String {
    // format!'s brace escaping and the JS bodies do not mix: both
    // stay byte-exact as arguments; the two sentinels inject the
    // authorization flags.
    format!("(async () => {{ {CLEAR_DIALOG_HELPERS_JS} {CLEAR_SETUP_JS_BODY} }})()")
        .replace(
            "@@WANT_HISTORY@@",
            if want_history { "true" } else { "false" },
        )
        .replace(
            "@@WANT_DOWNLOADS@@",
            if want_downloads { "true" } else { "false" },
        )
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
