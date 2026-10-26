//! Parity port of `lib/web-search/cache.ts` — SQLite-backed cache for
//! normalized queries and extracted page content.
//!
//! Same file, same schema, same keys, same TTL semantics, same WAL/
//! vacuum behavior: the file lives at `<root>/.local-search/db/
//! search-cache.sqlite` (TS: `join(process.cwd(), ".local-search", "db",
//! "search-cache.sqlite")` — callers pass `ruke_core::config::project_root()`,
//! which equals the Next dev-server cwd). Cross-language compatibility:
//! the Rust backend and the TS app may share ONE database file.
//!
//! Parity notes:
//! - `WEB_SEARCH_CACHE_TTL_MS` parsed TS-style (`parseInt(x, 10)` leading
//!   integer prefix; NaN/non-positive → 5 h default). TS resolves it ONCE
//!   at module load; here it is read when the cache instance is built —
//!   `with_ttl_ms` exists so unit tests never race a process env.
//! - The 60 s purge throttle is a MODULE-GLOBAL timestamp in TS
//!   (`_lastPurgeCheck`) — replicated as a process-global static, NOT
//!   per-instance (two caches share one throttle, TS same).
//! - The 15-minute sweep (`startPurgePurgeSweep` equivalent) uses an
//!   unref'd `setInterval` in TS; the Rust port spawns a tokio task —
//!   "unref" has no equivalent, so the returned `JoinHandle` is how a
//!   embedder stops it. The immediate startup purge IS kept.
//! - **Decoupling (contract for W2):** TS `queryCacheKey`/`putCachedQuery`
//!   take metasearch `SearchPlan[]`; the Rust cache takes the plan
//!   QUERIES (`&[String]`, key-normalization input, `.query` values) +
//!   `plan_json: &Value` (what W2's `serde_json::to_value(&plans)`
//!   produces) so this module does not depend on W2's types. Key + row
//!   bytes are identical.
//! - Zero-result rows are treated as misses on read AND never written —
//!   a starved run must not poison the plan set for the whole TTL.
//! - Page writes require ≥200 JS-chars of whitespace-collapsed signal
//!   (UTF-16 length — emoji count 2, exactly like TS).

use parking_lot::Mutex;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::types::RankedResult;

/// Wall-clock TTL default: 5 hours of real-world time (not uptime).
pub const DEFAULT_TTL_MS: i64 = 5 * 60 * 60 * 1000;
/// Throttle window for the read/write-adjacent purge (TS `60_000`).
pub const PURGE_THROTTLE_MS: i64 = 60_000;
/// Background sweep period (TS `PURGE_SWEEP_INTERVAL_MS`).
pub const PURGE_SWEEP_INTERVAL_MS: u64 = 15 * 60 * 1000;

pub const ENV_TTL: &str = "WEB_SEARCH_CACHE_TTL_MS";

/// Page-cache tier union from `putCachedPage`'s parameter type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageTier {
    Direct,
    Jina,
    Adapter,
    Metadata,
    Wayback,
    Browser,
}

impl PageTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Jina => "jina",
            Self::Adapter => "adapter",
            Self::Metadata => "metadata",
            Self::Wayback => "wayback",
            Self::Browser => "browser",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueryCacheHit {
    pub results: Vec<RankedResult>,
    pub freshness: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CachedPage {
    pub extracted: String,
    pub tier: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("sqlite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("scripted cache failure injected by fixture")]
    Scripted,
}

/// The fixture mock boundary for the cache seam (fixtures README:
/// "deterministic miss, injectable throw"). Part-6 pipeline code must
/// depend on this trait, never on [`SqliteSearchCache`] directly.
pub trait SearchCache: Send + Sync {
    fn get_cached_query(&self, queries: &[String]) -> Result<Option<QueryCacheHit>, CacheError>;
    fn put_cached_query(
        &self,
        queries: &[String],
        plan_json: &Value,
        results: &[RankedResult],
        freshness: &str,
    ) -> Result<(), CacheError>;
    fn get_cached_page(&self, url: &str) -> Result<Option<CachedPage>, CacheError>;
    fn put_cached_page(&self, url: &str, extracted: &str, tier: PageTier) -> Result<(), CacheError>;
    fn purge_expired(&self) -> Result<usize, CacheError>;
    fn close(&self) -> Result<(), CacheError>;
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// TS `parseInt(raw, 10)` semantics: leading optional sign + digit prefix,
/// everything else NaN → default.
pub fn parse_ttl_ms(raw: Option<&str>) -> i64 {
    let Some(raw) = raw else { return DEFAULT_TTL_MS };
    let s = raw.trim_start();
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => (-1i64, r),
        None => (1i64, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    match digits.parse::<i64>() {
        Ok(v) => {
            let v = sign.saturating_mul(v);
            if v > 0 {
                v
            } else {
                DEFAULT_TTL_MS
            }
        }
        Err(_) => DEFAULT_TTL_MS,
    }
}

/// TS `hash()` — sha256 hex, first 32 chars.
pub fn hash(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let full = format!("{:x}", h.finalize());
    full.chars().take(32).collect()
}

fn ws_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}

/// Query-cache key for a plan set (TS `queryCacheKey`, but taking the
/// plan `.query` strings — see module docs).
///
/// Note: TS `Array.sort()` compares UTF-16 code units; Rust sorts UTF-8
/// bytes (= code-point order). Identical for everything except astral
/// characters vs. lone surrogates — recorded, not fixed.
pub fn query_cache_key(queries: &[String]) -> String {
    let mut normalized: Vec<String> = queries
        .iter()
        .map(|q| q.to_lowercase().trim().to_string())
        .collect();
    normalized.sort();
    hash(&normalized.join("|"))
}

// TS module-global: `_lastPurgeCheck` shared by the whole process.
static LAST_PURGE_CHECK: AtomicI64 = AtomicI64::new(0);
// TS module-global: `_purgeSweepStarted`.
static SWEEP_STARTED: AtomicBool = AtomicBool::new(false);

/// SQLite-backed cache (TS module singleton; here an instance, so unit
/// tests can point it at a tempfile — NEVER the real store).
pub struct SqliteSearchCache {
    path: PathBuf,
    ttl_ms: i64,
    conn: Mutex<Option<Connection>>,
}

impl SqliteSearchCache {
    /// `<root>/.local-search/db/search-cache.sqlite` — same relative path
    /// TS derives from `process.cwd()`.
    pub fn db_path_for(root: &Path) -> PathBuf {
        root.join(".local-search").join("db").join("search-cache.sqlite")
    }

    /// Zero-footprint on construction — the file is opened on first use
    /// (TS `db()` lazy singleton), matching the module comment.
    pub fn new(root: &Path) -> Self {
        let ttl = parse_ttl_ms(std::env::var(ENV_TTL).ok().as_deref());
        Self::with_ttl_ms(root, ttl)
    }

    /// Explicit TTL (unit tests; also handy for embedders that resolve
    /// env themselves).
    pub fn with_ttl_ms(root: &Path, ttl_ms: i64) -> Self {
        Self {
            path: Self::db_path_for(root),
            ttl_ms,
            conn: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn ttl_ms(&self) -> i64 {
        self.ttl_ms
    }

    fn ensure_open(&self) -> Result<(), CacheError> {
        let mut guard = self.conn.lock();
        if guard.is_some() {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(&self.path)?;
        // journal_mode = WAL (returns a row → query_row)
        let mode: String = db.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        tracing::debug!("[web-search/cache] journal_mode={mode}");
        db.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?; // required for incremental_vacuum
        db.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS query_cache (
              query_hash  TEXT PRIMARY KEY,
              freshness   TEXT NOT NULL DEFAULT 'standard',
              plan_json   TEXT NOT NULL,
              results_json TEXT NOT NULL,
              hits        INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL,
              expires_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS page_cache (
              url_hash   TEXT PRIMARY KEY,
              url        TEXT NOT NULL,
              extracted  TEXT NOT NULL,
              tier       TEXT NOT NULL DEFAULT 'direct',
              cached_at  INTEGER NOT NULL,
              expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_page_expires ON page_cache(expires_at);
            CREATE INDEX IF NOT EXISTS idx_query_expires ON query_cache(expires_at);
            "#,
        )?;
        // Enable auto_vacuum on existing DBs that predate this change (TS
        // re-runs the pragma AFTER schema creation — verbatim quirk).
        db.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?;
        *guard = Some(db);
        Ok(())
    }

    fn with_db<T>(&self, f: impl FnOnce(&Connection) -> Result<T, CacheError>) -> Result<T, CacheError> {
        self.ensure_open()?;
        let guard = self.conn.lock();
        f(guard.as_ref().expect("opened above"))
    }

    /// TS `maybePurge()` — throttled (process-global), non-fatal failures
    /// still surface to the caller like TS (an exception there breaks the
    /// cache read → the route's web-failure catch swallows it).
    fn maybe_purge(&self) -> Result<(), CacheError> {
        let now = now_ms();
        let last = LAST_PURGE_CHECK.load(Ordering::Relaxed);
        if now - last < PURGE_THROTTLE_MS {
            return Ok(());
        }
        LAST_PURGE_CHECK.store(now, Ordering::Relaxed);
        self.purge_expired()?;
        Ok(())
    }
}

impl SearchCache for SqliteSearchCache {
    fn purge_expired(&self) -> Result<usize, CacheError> {
        self.with_db(|db| {
            let now = now_ms();
            let q = db.execute("DELETE FROM query_cache WHERE expires_at <= ?", params![now])?;
            let p = db.execute("DELETE FROM page_cache WHERE expires_at <= ?", params![now])?;
            // Physically reclaim the freed pages — safe on every purge
            // (no-op when nothing to reclaim). vacuum can fail on a locked
            // WAL — non-fatal, TS swallows.
            let _ = db.execute_batch("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);");
            let total = q + p;
            if total > 0 {
                tracing::info!(
                    "[web-search/cache] purged {} expired rows ({} query, {} page) and re-vacuumed DB",
                    total,
                    q,
                    p
                );
            }
            Ok(total)
        })
    }

    fn get_cached_query(&self, queries: &[String]) -> Result<Option<QueryCacheHit>, CacheError> {
        self.maybe_purge()?;
        let key = query_cache_key(queries);
        self.with_db(|db| {
            let row: Option<(String, String)> = db
                .query_row(
                    "SELECT results_json, freshness FROM query_cache
                     WHERE query_hash = ?1 AND expires_at > ?2",
                    params![key, now_ms()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((results_json, freshness)) = row else {
                return Ok(None);
            };
            // JSON.parse failure → miss (TS catch).
            let Ok(results) = serde_json::from_str::<Vec<RankedResult>>(&results_json) else {
                return Ok(None);
            };
            // Zero-result row = a starved run, not an empty web — miss.
            if results.is_empty() {
                return Ok(None);
            }
            Ok(Some(QueryCacheHit { results, freshness }))
        })
    }

    fn put_cached_query(
        &self,
        queries: &[String],
        plan_json: &Value,
        results: &[RankedResult],
        freshness: &str,
    ) -> Result<(), CacheError> {
        self.maybe_purge()?;
        // Never persist a zero-result SERP (poisoning guard — TS).
        if results.is_empty() {
            return Ok(());
        }
        let key = query_cache_key(queries);
        let now = now_ms();
        let plan_json = serde_json::to_string(plan_json).map_err(CacheError::from_to_string)?;
        let results_json = serde_json::to_string(results).map_err(CacheError::from_to_string)?;
        self.with_db(|db| {
            db.execute(
                r#"INSERT INTO query_cache (query_hash, freshness, plan_json, results_json, hits, created_at, expires_at)
                   VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
                   ON CONFLICT(query_hash) DO UPDATE SET
                     freshness = excluded.freshness,
                     results_json = excluded.results_json,
                     created_at = excluded.created_at,
                     expires_at = excluded.expires_at,
                     hits = query_cache.hits + 1"#,
                params![key, freshness, plan_json, results_json, now, now + self.ttl_ms],
            )?;
            Ok(())
        })
    }

    fn get_cached_page(&self, url: &str) -> Result<Option<CachedPage>, CacheError> {
        self.maybe_purge()?;
        let key = hash(url);
        self.with_db(|db| {
            let row = db
                .query_row(
                    "SELECT extracted, tier FROM page_cache
                     WHERE url_hash = ?1 AND expires_at > ?2",
                    params![key, now_ms()],
                    |r| Ok(CachedPage { extracted: r.get(0)?, tier: r.get(1)? }),
                )
                .optional()?;
            Ok(row)
        })
    }

    /// Refuse degraded writes: <200 JS-chars of whitespace-collapsed
    /// signal (UTF-16 `.length`, parity with TS).
    fn put_cached_page(&self, url: &str, extracted: &str, tier: PageTier) -> Result<(), CacheError> {
        let signal = ws_re().replace_all(extracted, " ");
        let signal = signal.trim();
        if signal.encode_utf16().count() < 200 {
            return Ok(());
        }
        self.maybe_purge()?;
        let now = now_ms();
        self.with_db(|db| {
            db.execute(
                r#"INSERT INTO page_cache (url_hash, url, extracted, tier, cached_at, expires_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                   ON CONFLICT(url_hash) DO UPDATE SET
                     extracted = excluded.extracted,
                     tier = excluded.tier,
                     cached_at = excluded.cached_at,
                     expires_at = excluded.expires_at"#,
                params![hash(url), url, extracted, tier.as_str(), now, now + self.ttl_ms],
            )?;
            Ok(())
        })
    }

    /// TS `closeCache()` — idempotent.
    fn close(&self) -> Result<(), CacheError> {
        let mut guard = self.conn.lock();
        if let Some(db) = guard.take() {
            let _ = db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            drop(db); // rusqlite closes on drop
        }
        Ok(())
    }
}

/// Serialize errors from serde (no SQL involved) into CacheError.
impl CacheError {
    fn from_to_string(e: serde_json::Error) -> Self {
        CacheError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }
}

/// TS `startPurgeSweep()` — idempotent, purges immediately, then every
/// 15 minutes. The TS timer is unref'd; the Rust sweep is a tokio task —
/// abort the returned handle to stop it (first caller wins, later calls
/// are no-ops, TS `_purgeSweepStarted` parity).
pub fn start_purge_sweep(cache: std::sync::Arc<SqliteSearchCache>) -> tokio::task::JoinHandle<()> {
    if SWEEP_STARTED.swap(true, Ordering::SeqCst) {
        // Already started (module-singleton parity): do nothing.
        return tokio::spawn(async {});
    }
    tokio::spawn(async move {
        loop {
            // try/catch in TS (DB may be closed — ignore)
            let _ = cache.purge_expired();
            tokio::time::sleep(Duration::from_millis(PURGE_SWEEP_INTERVAL_MS)).await;
        }
    })
}

// ── fixture seam ─────────────────────────────────────────────────────────

/// Scripted cache for fixture replays (README mock boundary):
/// deterministic MISS by default, injectable THROW, writes recorded for
/// assertions. NEVER touches any SQLite file.
#[derive(Default)]
pub struct ScriptedCache {
    fail: AtomicBool,
    /// Log of `put_*` calls: "q:<key>" / "p:<url>" for replay assertions.
    pub writes: Mutex<Vec<String>>,
}

impl ScriptedCache {
    pub fn set_throw(&self, fail: bool) {
        self.fail.store(fail, Ordering::Relaxed);
    }
    fn check(&self) -> Result<(), CacheError> {
        if self.fail.load(Ordering::Relaxed) {
            Err(CacheError::Scripted)
        } else {
            Ok(())
        }
    }
}

impl SearchCache for ScriptedCache {
    fn get_cached_query(&self, queries: &[String]) -> Result<Option<QueryCacheHit>, CacheError> {
        self.check()?;
        let _ = query_cache_key(queries); // deterministic path, but always a miss
        Ok(None)
    }
    fn put_cached_query(
        &self,
        queries: &[String],
        _plan_json: &Value,
        _results: &[RankedResult],
        _freshness: &str,
    ) -> Result<(), CacheError> {
        self.check()?;
        self.writes.lock().push(format!("q:{}", query_cache_key(queries)));
        Ok(())
    }
    fn get_cached_page(&self, url: &str) -> Result<Option<CachedPage>, CacheError> {
        self.check()?;
        let _ = url;
        Ok(None)
    }
    fn put_cached_page(&self, url: &str, _extracted: &str, _tier: PageTier) -> Result<(), CacheError> {
        self.check()?;
        self.writes.lock().push(format!("p:{url}"));
        Ok(())
    }
    fn purge_expired(&self) -> Result<usize, CacheError> {
        self.check()?;
        Ok(0)
    }
    fn close(&self) -> Result<(), CacheError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{js_number, EngineRanks, RankedResult};
    use serde_json::json;

    fn rr(url: &str) -> RankedResult {
        RankedResult {
            url: url.into(),
            canonical: url.into(),
            title: "t".into(),
            snippet: "s".into(),
            engine: "ddg".into(),
            published_date: None,
            domain: "x.dev".into(),
            rrf: 1.0,
            engines: vec!["ddg".into()],
            engine_ranks: {
                let mut m = EngineRanks::new();
                m.insert("ddg".into(), js_number(1.0));
                m
            },
        }
    }

    fn q(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn tmp_cache(ttl_ms: i64) -> (tempfile::TempDir, SqliteSearchCache) {
        let dir = tempfile::tempdir().expect("tempdir");
        // Sanity: the cache file must NOT be the real store path.
        let c = SqliteSearchCache::with_ttl_ms(dir.path(), ttl_ms);
        assert!(c.path().ends_with(".local-search/db/search-cache.sqlite")
            || c.path().ends_with(std::path::Path::new(".local-search").join("db").join("search-cache.sqlite")));
        (dir, c)
    }

    #[test]
    fn query_roundtrip_hit() {
        let (_d, c) = tmp_cache(DEFAULT_TTL_MS);
        c.put_cached_query(&q(&["rust webui"]), &json!([{"query":"rust webui"}]), &[rr("https://x.dev")], "any")
            .unwrap();
        let hit = c.get_cached_query(&q(&["rust webui"])).unwrap().expect("hit");
        assert_eq!(hit.results.len(), 1);
        assert_eq!(hit.freshness, "any");
        c.close().unwrap();
    }

    #[test]
    fn zero_results_never_written_and_poison_rows_are_misses() {
        let (_d, c) = tmp_cache(DEFAULT_TTL_MS);
        // put-side guard:
        c.put_cached_query(&q(&["starved"]), &json!([]), &[], "any").unwrap();
        assert!(c.get_cached_query(&q(&["starved"])).unwrap().is_none());
        // read-side guard: hand-write a poisoned zero-result row (an old
        // writer's legacy row) and confirm it reads as a MISS.
        c.get_cached_page("about:blank").unwrap(); // force open + schema
        {
            let conn = Connection::open(c.path()).unwrap();
            conn.execute(
                "INSERT INTO query_cache (query_hash, freshness, plan_json, results_json, hits, created_at, expires_at)
                 VALUES (?1,'any','[]','[]',0,?2,?3)",
                params![query_cache_key(&q(&["poisoned"])), now_ms(), now_ms() + 10_000],
            )
            .unwrap();
        }
        assert!(c.get_cached_query(&q(&["poisoned"])).unwrap().is_none());
        c.close().unwrap();
    }

    #[test]
    fn ttl_expiry_and_purge() {
        let (_d, c) = tmp_cache(0); // ttl 0 ⇒ immediately expired
        c.put_cached_query(&q(&["gone"]), &json!([]), &[rr("https://x.dev")], "any")
            .unwrap();
        assert!(c.get_cached_query(&q(&["gone"])).unwrap().is_none());
        let n = c.purge_expired().unwrap();
        assert!(n >= 1, "expired row purged: {n}");
        assert_eq!(c.purge_expired().unwrap(), 0);
        c.close().unwrap();
    }

    #[test]
    fn rewrite_bumps_hits() {
        let (_d, c) = tmp_cache(DEFAULT_TTL_MS);
        c.put_cached_query(&q(&["twice"]), &json!([]), &[rr("https://a.dev")], "any")
            .unwrap();
        c.put_cached_query(&q(&["twice"]), &json!([]), &[rr("https://b.dev")], "week")
            .unwrap();
        let conn = Connection::open(c.path()).unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT hits FROM query_cache WHERE query_hash = ?1",
                params![query_cache_key(&q(&["twice"]))],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "ON CONFLICT bumps hits (TS `hits = query_cache.hits + 1`)");
        let freshness: String = conn
            .query_row(
                "SELECT freshness FROM query_cache WHERE query_hash = ?1",
                params![query_cache_key(&q(&["twice"]))],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(freshness, "week");
        drop(conn);
        c.close().unwrap();
    }

    #[test]
    fn page_signal_guard_uses_js_length() {
        let (_d, c) = tmp_cache(DEFAULT_TTL_MS);
        let small = "a".repeat(199);
        c.put_cached_page("https://x.dev/small", &small, PageTier::Direct).unwrap();
        assert!(c.get_cached_page("https://x.dev/small").unwrap().is_none());

        let ok = "word ".repeat(60); // 300 chars
        c.put_cached_page("https://x.dev/ok", &ok, PageTier::Jina).unwrap();
        let page = c.get_cached_page("https://x.dev/ok").unwrap().expect("hit");
        assert_eq!(page.extracted, ok); // full text — no truncation
        assert_eq!(page.tier, "jina");

        // whitespace collapse: 250 chars of mostly-newlines collapses under
        // 200 ⇒ rejected.
        let mostly_ws = "a".repeat(50) + &"\n".repeat(250);
        c.put_cached_page("https://x.dev/ws", &mostly_ws, PageTier::Direct).unwrap();
        assert!(c.get_cached_page("https://x.dev/ws").unwrap().is_none());

        // UTF-16 parity: 100 emoji = 200 JS-chars ⇒ stored.
        let emoji = "👍".repeat(100);
        c.put_cached_page("https://x.dev/emoji", &emoji, PageTier::Wayback).unwrap();
        assert!(c.get_cached_page("https://x.dev/emoji").unwrap().is_some());
        c.close().unwrap();
    }

    #[test]
    fn key_normalization_and_hash_shape() {
        let a = query_cache_key(&q(&["Foo Bar", "baz"]));
        let b = query_cache_key(&q(&["baz", " FOO BAR  "]));
        assert_eq!(a, b, "lowercase+trim+sort");
        assert_eq!(hash("x").chars().count(), 32);
        assert_eq!(hash("x").chars().next(), Some(hash("x").chars().next().unwrap()));
        assert_ne!(hash("x"), hash("y"));
    }

    #[test]
    fn wal_mode_and_schema_match_ts() {
        let (_d, c) = tmp_cache(DEFAULT_TTL_MS);
        c.get_cached_page("https://x.dev/open").unwrap(); // opens DB
        let conn = Connection::open(c.path()).unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        // both tables + both expires indexes exist
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for want in ["idx_page_expires", "idx_query_expires", "page_cache", "query_cache"] {
            assert!(names.iter().any(|n| n == want), "missing {want} in {names:?}");
        }
        drop(conn);
        c.close().unwrap();
    }

    #[test]
    fn ttl_env_parsing_ts_parity() {
        assert_eq!(parse_ttl_ms(None), DEFAULT_TTL_MS);
        assert_eq!(parse_ttl_ms(Some("")), DEFAULT_TTL_MS); // parseInt("")=NaN
        assert_eq!(parse_ttl_ms(Some("abc")), DEFAULT_TTL_MS);
        assert_eq!(parse_ttl_ms(Some("0")), DEFAULT_TTL_MS);
        assert_eq!(parse_ttl_ms(Some("-5")), DEFAULT_TTL_MS);
        assert_eq!(parse_ttl_ms(Some("1000")), 1000);
        assert_eq!(parse_ttl_ms(Some("100abc")), 100); // parseInt prefix
        assert_eq!(parse_ttl_ms(Some(" 250 ")), 250);
    }

    #[tokio::test]
    async fn sweep_purges_expired_rows() {
        let (_d, c) = tmp_cache(0);
        c.put_cached_query(&q(&["swept"]), &json!([]), &[rr("https://x.dev")], "any")
            .unwrap();
        let arc = std::sync::Arc::new(
            SqliteSearchCache::with_ttl_ms(_d.path(), 0),
        );
        let handle = start_purge_sweep(std::sync::Arc::clone(&arc));
        tokio::time::sleep(Duration::from_millis(50)).await;
        handle.abort(); // stop the sweep (the "unref" equivalent)
        assert_eq!(c.purge_expired().unwrap(), 0, "sweep already took the row");
        c.close().unwrap();
    }

    #[test]
    fn scripted_cache_fixture_seam_behaves_like_the_mock_boundary() {
        let sc = ScriptedCache::default();
        assert!(sc.get_cached_query(&q(&["anything"])).unwrap().is_none());
        sc.put_cached_query(&q(&["w"]), &json!([]), &[rr("https://x.dev")], "any").unwrap();
        sc.put_cached_page("https://p.dev", &"x".repeat(300), PageTier::Direct).unwrap();
        assert_eq!(sc.writes.lock().len(), 2);
        sc.set_throw(true);
        assert!(sc.get_cached_query(&q(&["x"])).is_err());
        assert!(matches!(
            sc.purge_expired(),
            Err(CacheError::Scripted)
        ));
    }
}
