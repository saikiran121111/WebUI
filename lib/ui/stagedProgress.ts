/**
 * Staged progress schedule (pure, unit-testable) for slow blob POSTs
 * (/api/documents/*, CAD/Studio exports) that have NO server-side progress
 * channel. The ramp is an honest visual estimate, not a server report:
 * fast to 30%, steady to 70% by ~1.5s and 90% by ~4s (the typical engine
 * window — headless Chromium chart screenshots included), then a slow crawl
 * that never crosses 97% until the real response snaps it to 100.
 */

export interface RampPoint { atMs: number; pct: number }

export const BUILD_RAMP: RampPoint[] = [
  { atMs: 0, pct: 0 },
  { atMs: 400, pct: 30 },
  { atMs: 1500, pct: 70 },
  { atMs: 4000, pct: 90 },
];
export const BUILD_CRAWL_TARGET = 97;
export const BUILD_CRAWL_TAU_MS = 8000;
export const BUILD_COMPLETE_PCT = 100;

export function stagedPctAt(elapsedMs: number): number {
  if (!(elapsedMs > 0)) return 0;
  const last = BUILD_RAMP[BUILD_RAMP.length - 1];
  if (elapsedMs >= last.atMs) {
    return Math.min(
      BUILD_CRAWL_TARGET,
      last.pct + (BUILD_CRAWL_TARGET - last.pct) * (1 - Math.exp(-(elapsedMs - last.atMs) / BUILD_CRAWL_TAU_MS)),
    );
  }
  for (let i = 1; i < BUILD_RAMP.length; i++) {
    const a = BUILD_RAMP[i - 1];
    const b = BUILD_RAMP[i];
    if (elapsedMs <= b.atMs) return a.pct + ((b.pct - a.pct) * (elapsedMs - a.atMs)) / (b.atMs - a.atMs);
  }
  return last.pct;
}

export interface StageLabel { fromPct: number; label: string }

export const BUILD_STAGES: StageLabel[] = [
  { fromPct: 0, label: "Starting the engine…" },
  { fromPct: 30, label: "Laying out pages…" },
  { fromPct: 62, label: "Rendering charts…" },
  { fromPct: 88, label: "Finalizing file…" },
];

export function stageLabelFor(pct: number): string {
  let label = BUILD_STAGES[0].label;
  for (const s of BUILD_STAGES) if (pct >= s.fromPct) label = s.label;
  return label;
}
