/**
 * SQLite-backed cache for normalized queries and extracted page content.
 *
 * Storage: .local-search/db/search-cache.sqlite  (better-sqlite3, zero-
 * footprint on startup — file is only opened on first cache read/write).
 *
 * Two tables:
 *   query_cache(query_hash, freshness, plan_json, hits, expires_at)
 *   page_cache(url_hash, url, extracted_md, tier, cached_at)
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { SearchPlan, RankedResult } from "./metasearch";
import type { EvidencePacket } from "./types";

const DB_PATH = join(
  process.cwd(),
  ".local-search",
  "db",
  "search-cache.sqlite",
);

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(join(process.cwd(), ".local-search", "db"), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
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
  `);
  return _db;
}

export function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/* TTLs in milliseconds — raised for the new 6-value freshness set.
   "any" freshness (time-irrelevant) gets the longest TTL; "day"
   (same-day news) the shortest. */
const QUERY_TTL: Record<string, number> = {
  day: 15 * 60 * 1000,           // 15 min — same-day news goes stale fast
  week: 4 * 60 * 60 * 1000,      // 4 h   — this-week updates
  month: 24 * 60 * 60 * 1000,    // 24 h  — recent releases / versioned facts
  year: 7 * 24 * 60 * 60 * 1000, // 7 d   — stable versioned product data
  any: 30 * 24 * 60 * 60 * 1000, // 30 d  — time-irrelevant (static knowledge)
  // Legacy values (still hit by old cache entries):
  current: 15 * 60 * 1000,
  recent: 4 * 60 * 60 * 1000,
  standard: 24 * 60 * 60 * 1000,
  quick: 15 * 60 * 1000,
};

const PAGE_TTL = 6 * 60 * 60 * 1000; // 6 h

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
  const key = queryCacheKey(plans);
  const ttl = QUERY_TTL[freshness] ?? QUERY_TTL.standard;
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
      Date.now(),
      Date.now() + ttl,
    );
}

/* ── page cache ──────────────────────────────────────────────────────── */

export function getCachedPage(url: string): {
  extracted: string;
  tier: string;
} | null {
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
 * Cache a full page extraction. Only called when Tier 1/1.5/2/3
 * produced a high-signal extraction (SUCCESS_DIRECT, SUCCESS_ADAPTER,
 * SUCCESS_METADATA, SUCCESS_JINA_FALLBACK, SUCCESS_WAYBACK).
 *
 * Never cache snippet-only fallbacks (SUCCESS_SNIPPET_FALLBACK) —
 * they are degraded partial evidence and would poison subsequent
 * cache reads.
 */
export function putCachedPage(
  url: string,
  extracted: string,
  tier: "direct" | "jina" | "adapter" | "metadata" | "wayback",
): void {
  // A snippet-only tier should never reach here (the extractor
  // classifies it before calling putCachedPage). Belt and suspenders:
  // refuse to write if the extracted content looks like a degraded
  // snippet (less than 200 chars of real content).
  const signal = extracted.replace(/\s+/g, " ").trim();
  if (signal.length < 200) return;

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
      extracted,
      tier,
      Date.now(),
      Date.now() + PAGE_TTL,
    );
}

/** Prune expired rows — call opportunistically on cache access. */
export function pruneExpired(): void {
  const now = Date.now();
  db().prepare(`DELETE FROM query_cache WHERE expires_at < ?`).run(now);
  db().prepare(`DELETE FROM page_cache WHERE expires_at < ?`).run(now);
}

/** Close the DB handle (used by tests / process exit). */
export function closeCache(): void {
  _db?.close();
  _db = null;
}
