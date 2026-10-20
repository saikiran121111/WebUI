/**
 * SQLite-backed cache for normalized queries and extracted page content.
 *
 * Storage: .local-search/db/search-cache.sqlite  (better-sqlite3, zero-
 * footprint on startup — file is only opened on first cache read/write).
 *
 * Two tables:
 *   query_cache(query_hash, freshness, plan_json, hits, created_at, expires_at)
 *   page_cache (url_hash, url, extracted, tier, cached_at, expires_at)
 *
 * Wall-clock TTL (5 hours real-world time, NOT process uptime):
 *   - Every row stores `created_at` and `expires_at` as Unix epoch
 *     milliseconds (Date.now()), so the expiry survives app restarts.
 *   - `purgeExpiredCache()` deletes expired rows on startup, on every
 *     read/write, and via a 15-minute background sweep.
 *   - After each purge, `PRAGMA incremental_vacuum` + `wal_checkpoint`
 *     physically shrink the .db and .db-wal files on disk.
 *   - Configurable via WEB_SEARCH_CACHE_TTL_MS (default 5 * 60 * 60 * 1000).
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { SearchPlan, RankedResult } from "./metasearch";

const DB_PATH = join(
  process.cwd(),
  ".local-search",
  "db",
  "search-cache.sqlite",
);

/**
 * Wall-clock TTL: 5 hours of real-world time (not process uptime).
 * Override with WEB_SEARCH_CACHE_TTL_MS if a different retention is needed.
 */
export const CACHE_TTL_MS: number = (() => {
  const raw = process.env.WEB_SEARCH_CACHE_TTL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 60 * 1000;
})();

let _db: Database.Database | null = null;
let _purgeSweepStarted = false;
let _lastPurgeCheck = 0; // ms timestamp of last non-blocking purge check

/** 15-minute non-blocking background sweep (unref'd so it never keeps the process alive). */
const PURGE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(join(process.cwd(), ".local-search", "db"), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("auto_vacuum = INCREMENTAL"); // required for incremental_vacuum
  _db.exec(`
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
  `);
  // Enable auto_vacuum on existing DBs that predate this change
  _db.pragma("auto_vacuum = INCREMENTAL");
  return _db;
}

/**
 * Delete all expired rows from both cache tables, then run
 * `PRAGMA incremental_vacuum` + `PRAGMA wal_checkpoint(TRUNCATE)` so
 * the .db and .db-wal files on disk physically shrink.
 *
 * Called automatically on:
 *   1. Module init (first cache access) — wipes stale data from earlier sessions
 *   2. Every read/write (throttled to at most once per 60 seconds)
 *   3. 15-minute background sweep (setInterval, unref'd)
 */
export function purgeExpiredCache(): number {
  const d = db();
  const now = Date.now();
  const q = d.prepare(`DELETE FROM query_cache WHERE expires_at <= ?`);
  const p = d.prepare(`DELETE FROM page_cache WHERE expires_at <= ?`);
  const qInfo = q.run(now);
  const pInfo = p.run(now);
  // Physically reclaim the freed pages — safe to run on every purge
  // (a no-op when there is nothing to reclaim).
  try {
    d.pragma("incremental_vacuum");
    d.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* vacuum can fail on a locked WAL — non-fatal */
  }
  const total = qInfo.changes + pInfo.changes;
  if (total > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[web-search/cache] purged ${total} expired rows (${qInfo.changes} query, ${pInfo.changes} page) and re-vacuumed DB`,
    );
  }
  return total;
}

/**
 * Throttled non-blocking purge: call on every cache read/write.
 * At most one purge runs per 60 seconds to avoid overhead on hot paths.
 */
function maybePurge(): void {
  const now = Date.now();
  if (now - _lastPurgeCheck < 60_000) return;
  _lastPurgeCheck = now;
  purgeExpiredCache();
}

/**
 * Start the 15-minute background sweep (idempotent — safe to call
 * multiple times). The timer is unref'd so it never prevents the
 * process from exiting.
 */
export function startPurgeSweep(): void {
  if (_purgeSweepStarted) return;
  _purgeSweepStarted = true;
  const timer = setInterval(() => {
    try {
      purgeExpiredCache();
    } catch {
      /* DB may be closed — ignore */
    }
  }, PURGE_SWEEP_INTERVAL_MS);
  timer.unref(); // don't keep the event loop alive
  // Purge immediately on startup (handles the "closed app, reopened 6h later" case)
  purgeExpiredCache();
}

export function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/* ── query cache ───────────────────────────────────────────────────────── */

export function queryCacheKey(plans: SearchPlan[]): string {
  const normalized = plans
    .map((p) => p.query.toLowerCase().trim())
    .sort()
    .join("|");
  return hash(normalized);
}

export function getCachedQuery(
  plans: SearchPlan[],
): { results: RankedResult[]; freshness: string } | null {
  maybePurge();
  const key = queryCacheKey(plans);
  const row = db()
    .prepare(
      `SELECT results_json, freshness, expires_at FROM query_cache
       WHERE query_hash = ? AND expires_at > ?`,
    )
    .get(key, Date.now()) as
    | { results_json: string; freshness: string; expires_at: number }
    | undefined;
  if (!row) return null;
  try {
    return {
      results: JSON.parse(row.results_json) as RankedResult[],
      freshness: row.freshness,
    };
  } catch {
    return null;
  }
}

export function putCachedQuery(
  plans: SearchPlan[],
  results: RankedResult[],
  freshness: string,
): void {
  maybePurge();
  const key = queryCacheKey(plans);
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO query_cache (query_hash, freshness, plan_json, results_json, hits, created_at, expires_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(query_hash) DO UPDATE SET
         freshness = excluded.freshness,
         results_json = excluded.results_json,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         hits = query_cache.hits + 1`,
    )
    .run(
      key,
      freshness,
      JSON.stringify(plans),
      JSON.stringify(results),
      now,
      now + CACHE_TTL_MS,
    );
}

/* ── page cache ──────────────────────────────────────────────────────── */

export function getCachedPage(url: string): {
  extracted: string;
  tier: string;
} | null {
  maybePurge();
  const key = hash(url);
  const row = db()
    .prepare(
      `SELECT extracted, tier, expires_at FROM page_cache
       WHERE url_hash = ? AND expires_at > ?`,
    )
    .get(key, Date.now()) as
    | { extracted: string; tier: string; expires_at: number }
    | undefined;
  if (!row) return null;
  return { extracted: row.extracted, tier: row.tier };
}

/**
 * Cache a full page extraction. Only called when a high-signal tier
 * (direct / adapter / metadata / jina / wayback) produced a real
 * extraction with ≥200 chars of meaningful content.
 *
 * Never cache snippet-only fallbacks, WAF challenge pages, or any
 * degraded / empty content — those would poison subsequent reads.
 */
export function putCachedPage(
  url: string,
  extracted: string,
  tier: "direct" | "jina" | "adapter" | "metadata" | "wayback",
): void {
  // Refuse to write if the extracted content is a degraded snippet
  // (<200 chars of signal) or contains WAF challenge boilerplate.
  const signal = extracted.replace(/\s+/g, " ").trim();
  if (signal.length < 200) return;

  maybePurge();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO page_cache (url_hash, url, extracted, tier, cached_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url_hash) DO UPDATE SET
         extracted = excluded.extracted,
         tier = excluded.tier,
         cached_at = excluded.cached_at,
         expires_at = excluded.expires_at`,
    )
    .run(
      hash(url),
      url,
      extracted, // full text — no truncation
      tier,
      now,
      now + CACHE_TTL_MS,
    );
}

/** Close the DB handle (used by tests / process exit). */
export function closeCache(): void {
  _db?.close();
  _db = null;
}
