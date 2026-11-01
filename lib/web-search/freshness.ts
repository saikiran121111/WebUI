/**
 * §11.10 freshness-fit helpers — pure, deterministic, model-free.
 *
 * Rust mirror: `is_time_scoped_freshness` + `freshness_fit` in
 * `rust-backend/crates/ruke-websearch/src/types.rs` (same bands, same
 * multipliers, same operation order — IEEE double parity). The test
 * vectors in `__tests__/web-search/retrieval-quality.test.ts` are shared
 * byte-for-byte with the Rust inline suite; change one side, change both
 * in the same commit.
 *
 * Law: a time-scoped run (day/week/month/year/realtime) ranks
 * correctly-dated PRIMARY content above undated content when the date
 * fits the band, and demotes content that is ancient relative to the
 * band. Undated results stay NEUTRAL (×1.0) — we never fabricate a date,
 * and we never punish a source for metadata we could not read.
 */

/** Freshness classes that carry a time band (⇔ Rust `is_time_scoped_freshness`). */
export function isTimeScopedFreshness(f: string | undefined): boolean {
  return (
    f === "realtime" || f === "day" || f === "week" ||
    f === "month" || f === "year"
  );
}

/** Band window in days (⇔ Rust match arms in `freshness_fit`). */
const BAND_WINDOW_DAYS: Record<string, number> = {
  realtime: 1,
  day: 2,
  week: 7,
  month: 30,
  year: 365,
};

/** In-band boost multiplier (⇔ Rust match arms in `freshness_fit`). */
const BAND_BOOST: Record<string, number> = {
  realtime: 1.3,
  day: 1.3,
  week: 1.25,
  month: 1.2,
  year: 1.1,
};

/**
 * Rank multiplier for a result/passage given the run's freshness band.
 *
 *   freshness not time-scoped ("any"/"none"/unknown) ......... 1.0
 *   publishedAt missing or unparseable ........................ 1.0 (neutral)
 *   age ≤ band window (or future-dated) ....................... band boost
 *   band window < age ≤ 2× band ............................... 1.0 (neutral)
 *   2× band < age ≤ 8× band ................................... 0.7
 *   age > 8× band ............................................. 0.5
 *
 * `nowMs` is injectable so tests never depend on wall-clock (Rust mirror
 * takes `now_ms: i64` for the same reason). Date parsing intentionally
 * uses `Date.parse` — the mirror's RFC-3339 parser is byte-identical for
 * every ISO-8601 instant we emit; exotic legacy strings that only V8
 * understands resolve to neutral (1.0) on the Rust side, and that
 * divergence is pinned in the shared vectors (never "fix" one side alone).
 */
export function freshnessFit(
  publishedAt: string | undefined,
  freshness: string | undefined,
  nowMs: number = Date.now(),
): number {
  if (!freshness) return 1.0;
  const w = BAND_WINDOW_DAYS[freshness];
  if (!w) return 1.0;
  const boost = BAND_BOOST[freshness];
  if (!publishedAt) return 1.0;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 1.0;
  const ageDays = (nowMs - t) / 86_400_000;
  if (ageDays <= w) return boost;
  if (ageDays <= 2 * w) return 1.0;
  if (ageDays <= 8 * w) return 0.7;
  return 0.5;
}
