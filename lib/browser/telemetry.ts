/**
 * Sanitized, bounded browser-agent telemetry (disk-backed).
 *
 * Only action KIND + latency + ok/fail + environment label are recorded —
 * never URLs, page text, ref maps, form values, or anything the user
 * typed. Samples stay in a fixed-size ring per kind so both memory and
 * the on-disk file are bounded no matter how long the session runs.
 *
 * Why disk (.data/browser-telemetry.json, same pattern as taskState):
 * in dev, Next compiles each API route into its own server bundle, so an
 * in-memory singleton written by POST /api/browser would read as zero
 * from GET /api/browser/telemetry. Every mutation is a tiny
 * read-modify-write; the agent performs one action at a time, so no
 * lost-update window opens.
 *
 * Exposed via GET /api/browser/telemetry for benchmarks/tests; benchmark
 * numbers are always labeled by environment (local_fixture / mock /
 * real_browser) so fixture timings are never mistaken for public-web
 * timings.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type BenchEnv = "local_fixture" | "mock" | "real_browser";

interface Sample {
  kind: string;
  ms: number;
  ok: boolean;
  env: BenchEnv;
}

interface TelemetryCounters {
  actions: number;
  screenshotsTaken: number;
  snapshotsTaken: number;
  humanHandoffs: number;
  challengesSeen: number;
  fallbacksUsed: number;
  consequentialBlocked: number;
  consequentialGranted: number;
  byStrategy: Record<string, number>;
}

interface PersistedTelemetry {
  counters: TelemetryCounters;
  kinds: Record<string, Sample[]>;
}

const MAX_SAMPLES_PER_KIND = 100;
const STORE = path.join(process.cwd(), ".data", "browser-telemetry.json");

function emptyCounters(): TelemetryCounters {
  return {
    actions: 0,
    screenshotsTaken: 0,
    snapshotsTaken: 0,
    humanHandoffs: 0,
    challengesSeen: 0,
    fallbacksUsed: 0,
    consequentialBlocked: 0,
    consequentialGranted: 0,
    byStrategy: {},
  };
}

function emptyStore(): PersistedTelemetry {
  return { counters: emptyCounters(), kinds: {} };
}

function loadStore(): PersistedTelemetry {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, "utf8")) as Partial<PersistedTelemetry>;
    return {
      counters: { ...emptyCounters(), ...(j.counters ?? {}), byStrategy: { ...(j.counters?.byStrategy ?? {}) } },
      kinds: j.kinds ?? {},
    };
  } catch {
    return emptyStore();
  }
}

function saveStore(p: PersistedTelemetry): void {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(p));
  } catch {
    /* telemetry must never fail the action it describes */
  }
}

export function recordBrowserMetric(
  kind: string,
  ms: number,
  ok: boolean,
  env: BenchEnv,
): void {
  const p = loadStore();
  const list = p.kinds[kind] ?? [];
  list.push({ kind, ms: Math.max(0, Math.round(ms)), ok, env });
  if (list.length > MAX_SAMPLES_PER_KIND) list.splice(0, list.length - MAX_SAMPLES_PER_KIND);
  p.kinds[kind] = list;
  if (kind.startsWith("action:")) p.counters.actions++;
  saveStore(p);
}

export function incrementBrowserCounter(
  key: keyof Omit<TelemetryCounters, "byStrategy">,
  n = 1,
): void {
  const p = loadStore();
  p.counters[key] += n;
  saveStore(p);
}

export function recordStrategyUse(strategy: string): void {
  const p = loadStore();
  p.counters.byStrategy[strategy] = (p.counters.byStrategy[strategy] ?? 0) + 1;
  p.counters.fallbacksUsed++;
  saveStore(p);
}

export interface KindStats {
  kind: string;
  n: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  envs: BenchEnv[];
}

export interface BrowserTelemetrySnapshot {
  kinds: KindStats[];
  counters: TelemetryCounters;
  when: number;
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

export function browserTelemetrySnapshot(): BrowserTelemetrySnapshot {
  const { counters, kinds: kindsMap } = loadStore();
  const kinds: KindStats[] = [];
  for (const [kind, list] of Object.entries(kindsMap)) {
    const sorted = list.map((s) => s.ms).sort((a, b) => a - b);
    kinds.push({
      kind,
      n: list.length,
      errors: list.filter((s) => !s.ok).length,
      p50: pct(sorted, 0.5),
      p95: pct(sorted, 0.95),
      max: sorted[sorted.length - 1] ?? 0,
      envs: [...new Set(list.map((s) => s.env))],
    });
  }
  kinds.sort((a, b) => a.kind.localeCompare(b.kind));
  return { kinds, counters: { ...counters, byStrategy: { ...counters.byStrategy } }, when: Date.now() };
}

export function resetBrowserTelemetry(): void {
  try {
    fs.rmSync(STORE, { force: true });
  } catch {
    /* nothing on disk — already reset */
  }
}
