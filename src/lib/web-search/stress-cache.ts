/**
 * SQLite-backed checkpoint + telemetry store for the stress test.
 *
 * Separate from the production search-cache (which lives in
 * .local-search/db/). All stress-test state lives in
 * .local-search/stress-test/stress-cache.sqlite so the production
 * cache is never polluted by test-run data.
 *
 * Two tables:
 *   stress_results(url_hash, url, genre, classification, status,
 *                   latency_ms, rss_peak_mb, error)
 *   stress_checkpoint(run_id, last_url_index, started_at)
 *
 * The checkpoint lets a long 10k run resume after a crash without
 * re-doing the URLs it already finished.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const DB_PATH = join(
  process.cwd(),
  ".local-search",
  "stress-test",
  "stress-cache.sqlite",
);

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(join(process.cwd(), ".local-search", "stress-test"), {
    recursive: true,
  });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS stress_results (
      url_hash      TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      genre         TEXT NOT NULL,
      classification TEXT NOT NULL,
      http_status   INTEGER NOT NULL,
      latency_ms    INTEGER NOT NULL,
      rss_peak_mb   INTEGER NOT NULL,
      error         TEXT,
      finished_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stress_checkpoint (
      run_id           TEXT PRIMARY KEY,
      last_url_index   INTEGER NOT NULL,
      started_at       INTEGER NOT NULL
    );
  `);
  return _db;
}

export function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

/* ── results ─────────────────────────────────────────────────────────── */

export interface StressResult {
  url: string;
  genre: string;
  classification: string;
  httpStatus: number;
  latencyMs: number;
  rssPeakMb: number;
  error?: string;
}

export function recordResult(r: StressResult): void {
  db()
    .prepare(
      `INSERT INTO stress_results
         (url_hash, url, genre, classification, http_status, latency_ms, rss_peak_mb, error, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url_hash) DO UPDATE SET
         classification = excluded.classification,
         http_status = excluded.http_status,
         latency_ms = excluded.latency_ms,
         rss_peak_mb = excluded.rss_peak_mb,
         error = excluded.error,
         finished_at = excluded.finished_at`,
    )
    .run(
      urlHash(r.url),
      r.url,
      r.genre,
      r.classification,
      r.httpStatus,
      r.latencyMs,
      r.rssPeakMb,
      r.error ?? null,
      Date.now(),
    );
}

export function hasResult(url: string): boolean {
  const row = db()
    .prepare("SELECT 1 FROM stress_results WHERE url_hash = ?")
    .get(urlHash(url));
  return !!row;
}

export function allResults(): StressResult[] {
  const rows = db()
    .prepare(
      `SELECT url, genre, classification, http_status, latency_ms, rss_peak_mb, error
       FROM stress_results ORDER BY finished_at`,
    )
    .all() as any[];
  return rows.map((r) => ({
    url: r.url,
    genre: r.genre,
    classification: r.classification,
    httpStatus: r.http_status,
    latencyMs: r.latency_ms,
    rssPeakMb: r.rss_peak_mb,
    error: r.error ?? undefined,
  }));
}

/* ── checkpoint ──────────────────────────────────────────────────────── */

export function setCheckpoint(runId: string, lastUrlIndex: number): void {
  db()
    .prepare(
      `INSERT INTO stress_checkpoint (run_id, last_url_index, started_at)
       VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         last_url_index = excluded.last_url_index`,
    )
    .run(runId, lastUrlIndex, Date.now());
}

export function getCheckpoint(runId: string): number | null {
  const row = db()
    .prepare("SELECT last_url_index FROM stress_checkpoint WHERE run_id = ?")
    .get(runId) as any;
  return row ? (row.last_url_index as number) : null;
}

export function clearCheckpoint(runId: string): void {
  db().prepare("DELETE FROM stress_checkpoint WHERE run_id = ?").run(runId);
}

/* ── close ──────────────────────────────────────────────────────────── */

export function closeStressDb(): void {
  _db?.close();
  _db = null;
}
