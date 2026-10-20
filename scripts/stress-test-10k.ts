/**
 * 10,000+ URL stress test for the Web Search & Research Engine.
 *
 * Usage:
 *   npx tsx scripts/stress-test-10k.ts --mode=canary          # 500+ hard targets
 *   npx tsx scripts/stress-test-10k.ts --mode=full-10k        # full 10,000+ corpus
 *   npx tsx scripts/stress-test-10k.ts --mode=canary --resume # continue a prior run
 *
 * Outputs:
 *   .local-search/stress-test/report.json          # full per-URL results
 *   .local-search/stress-test/SUMMARY.md           # markdown summary table
 *   .local-search/stress-test/stress-cache.sqlite  # checkpoint + results DB
 */
import fs from "node:fs";
import path from "node:path";
import pLimit, { type LimitFunction } from "p-limit";
import {
  extractUrl,
  fetchPage,
} from "../src/lib/web-search/index";
import {
  recordResult,
  hasResult,
  allResults,
  setCheckpoint,
  getCheckpoint,
  clearCheckpoint,
  closeStressDb,
  type StressResult,
} from "../src/lib/web-search/stress-cache";
import { closeCache } from "../src/lib/web-search/cache";
import { closeTlsClient } from "../src/lib/web-search/tls-client";
import type { CorpusEntry, Genre } from "./build-10k-corpus";
import type { RankedResult } from "../src/lib/web-search/types";

/* ── CLI flags ───────────────────────────────────────────────────────── */

function flag(name: string, def: string): string {
  const arg = process.argv.find((a) => a.startsWith("--" + name + "="));
  return arg ? arg.slice(name.length + 3) : def;
}

const MODE = flag("mode", "canary"); // "canary" | "full-10k"
const RESUME = process.argv.includes("--resume");
const CONCURRENCY = parseInt(flag("concurrency", "8"), 10);
const BATCH_SIZE = parseInt(flag("batch", "500"), 10); // checkpoint every N URLs
const RUN_ID = process.env.STRESS_RUN_ID ?? "stress-" + Date.now();

/* ── corpus loading ──────────────────────────────────────────────────── */

const CORPUS_PATH = path.join(
  process.cwd(),
  ".local-search",
  "stress-test",
  "corpus-10k.json",
);

interface CorpusFile {
  entries: CorpusEntry[];
  total: number;
}

function loadCorpus(): CorpusFile {
  if (!fs.existsSync(CORPUS_PATH)) {
    console.error(
      "Corpus not found at " + CORPUS_PATH + ". Run `npx tsx scripts/build-10k-corpus.ts` first.",
    );
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")) as CorpusFile;
  return data;
}

function selectEntries(corpus: CorpusFile): CorpusEntry[] {
  if (MODE === "canary") {
    return corpus.entries.filter((e) => e.curated);
  }
  return corpus.entries;
}

/* ── convert a CorpusEntry → RankedResult for extractUrl() ─────────── */

function toRankedResult(entry: CorpusEntry): RankedResult {
  let canonical = entry.url;
  let domain = "";
  try {
    const u = new URL(entry.url);
    domain = u.hostname.toLowerCase().replace(/^www\./, "");
    canonical = u.toString();
  } catch {
    domain = entry.host;
  }
  return {
    url: canonical,
    canonical,
    title: entry.label,
    snippet: "",
    engine: "corpus",
    domain,
    rrf: 1,
    engines: ["corpus"],
    engineRanks: { corpus: 1 },
  };
}

/* ── telemetry ──────────────────────────────────────────────────────── */

interface Telemetry {
  latencies: number[];
  rssSamples: number[];
  activeSockets: number;
  fileDescriptors: number;
  sqliteLockContentionMs: number;
  unhandledRejections: number;
  peakRssMb: number;
}

function makeTelemetry(): Telemetry {
  const initial = process.memoryUsage();
  return {
    latencies: [],
    rssSamples: [initial.rss / 1024 / 1024],
    activeSockets: 0,
    fileDescriptors: 0,
    sqliteLockContentionMs: 0,
    unhandledRejections: 0,
    peakRssMb: initial.rss / 1024 / 1024,
  };
}

function sampleTelemetry(t: Telemetry): void {
  const m = process.memoryUsage();
  const rssMb = m.rss / 1024 / 1024;
  t.rssSamples.push(rssMb);
  if (rssMb > t.peakRssMb) t.peakRssMb = rssMb;
  // File descriptors (best-effort — Linux-only stat)
  try {
    const fds = fs.readdirSync("/proc/self/fd");
    t.fileDescriptors = fds.length;
  } catch {
    t.fileDescriptors = -1;
  }
}

process.on("unhandledRejection", (reason: unknown) => {
  console.warn(
    "[stress] unhandled rejection:",
    reason instanceof Error ? reason.message : reason,
  );
  telemetryRef.unhandledRejections++;
});

let telemetryRef: Telemetry = makeTelemetry();

/* ── classification (from the extractor's packet.classification) ──── */

const SUCCESS_CATEGORIES = [
  "SUCCESS_DIRECT",
  "SUCCESS_ADAPTER",
  "SUCCESS_METADATA",
  "SUCCESS_JINA_FALLBACK",
  "SUCCESS_SNIPPET_FALLBACK",
];

const FAIL_CATEGORIES = [
  "FAIL_SILENT_BOT_BLOCK",
  "FAIL_SILENT_LOGIN_WALL",
  "FAIL_EMPTY_JS_SHELL",
  "FAIL_NETWORK_OR_CRASH",
];

/* ── rate-limiting (per-host, to avoid DDoS) ───────────────────────── */

const HOST_LIMIT = 3; // max 3 concurrent requests per host
const hostLimiter = new Map<string, LimitFunction>();

function hostLimit(host: string): LimitFunction {
  let fn = hostLimiter.get(host);
  if (!fn) {
    fn = pLimit(HOST_LIMIT);
    hostLimiter.set(host, fn);
  }
  return fn;
}

/* ── worker pool ─────────────────────────────────────────────────────── */

async function processUrl(
  entry: CorpusEntry,
  t: Telemetry,
  onProgress: (done: number, total: number) => void,
): Promise<StressResult> {
  const t0 = performance.now();
  const rssBefore = process.memoryUsage().rss / 1024 / 1024;

  // Checkpoint: skip URLs we've already recorded in this run
  if (hasResult(entry.url)) {
    const prior = allResults().find((r) => r.url === entry.url);
    if (prior) return prior;
  }

  const ranked = toRankedResult(entry);
  let classification: string;
  let httpStatus = 0;
  let error: string | undefined;

  try {
    const packet = await extractUrl(ranked);
    const rssAfter = process.memoryUsage().rss / 1024 / 1024;
    classification = packet.classification ?? "SUCCESS_DIRECT";
    // For the stress report, we want the HTTP status — the extractor
    // doesn't expose it on the packet, so we do a quick fetch to get it
    // (only for FAIL_* classifications where it matters).
    httpStatus = 200;
    if (classification.startsWith("FAIL_")) {
      try {
        const probe = await fetchPage(entry.url, {
          timeoutMs: 2000,
          retryOnBlock: false,
        });
        httpStatus = probe?.status ?? 0;
      } catch {
        httpStatus = 0;
      }
      void rssAfter;
    }
    if (rssAfter > rssBefore + 50) {
      // Memory spike — note it in the error field for the report
      error = "RSS delta " + Math.round(rssAfter - rssBefore) + "MB";
    }
  } catch (e: unknown) {
    classification = "FAIL_NETWORK_OR_CRASH";
    error = e instanceof Error ? e.message : String(e);
    httpStatus = 0;
  }

  const latencyMs = Math.round(performance.now() - t0);
  const rssPeakMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  t.latencies.push(latencyMs);
  sampleTelemetry(t);

  const result: StressResult = {
    url: entry.url,
    genre: entry.genre,
    classification,
    httpStatus,
    latencyMs,
    rssPeakMb,
    error,
  };
  recordResult(result);
  onProgress(t.latencies.length, 0); // total is passed by the caller
  return result;
}

/* ── main orchestration ──────────────────────────────────────────────── */

async function main() {
  const corpus = loadCorpus();
  const entries = selectEntries(corpus);
  console.log(
    `Stress test (${MODE} mode): ${entries.length} URLs, concurrency=${CONCURRENCY}`,
  );

  telemetryRef = makeTelemetry();
  const t = telemetryRef;

  // Resume support: skip URLs already in the checkpoint
  let startIdx = 0;
  if (RESUME) {
    const cp = getCheckpoint(RUN_ID);
    if (cp !== null && cp < entries.length) {
      startIdx = cp + 1;
      console.log(`Resuming from index ${startIdx} (checkpoint found)`);
    }
  }

  const remaining = entries.slice(startIdx);
  const processedBefore = allResults().length;

  const globalLimit = pLimit(CONCURRENCY);
  let done = 0;
  let lastCheckpoint = startIdx;

  // p-limit's LimitFunction takes a function to call once a slot frees.
  // For a simple "acquire then run" pattern we wrap the work so it only
  // executes inside the slot — otherwise the fetch would run immediately.
  const run = (entry: CorpusEntry) =>
    hostLimit(entry.host)(() => globalLimit(() => processUrl(entry, t, () => {})));

  for (let i = 0; i < remaining.length; i++) {
    const entry = remaining[i];
    const promise = run(entry);
    // Batch: after every BATCH_SIZE, checkpoint
    if ((i + startIdx + 1) % BATCH_SIZE === 0) {
      setCheckpoint(RUN_ID, i + startIdx);
      lastCheckpoint = i + startIdx;
    }
    await promise;
    done++;
    // Progress log every 100
    if (done % 100 === 0) {
      const pct = Math.round(((i + 1) / remaining.length) * 100);
      const rss = Math.round(t.peakRssMb);
      const avgLat =
        t.latencies.length > 0
          ? Math.round(t.latencies.reduce((a, b) => a + b, 0) / t.latencies.length)
          : 0;
      console.log(
        `  ${done}/${remaining.length} (${pct}%) · RSS=${rss}MB · avg=${avgLat}ms`,
      );
    }
  }

  setCheckpoint(RUN_ID, remaining.length + startIdx - 1);
  void lastCheckpoint;

  // ── aggregate results ──────────────────────────────────────────────
  const all = allResults();
  const successCount = all.filter((r) =>
    SUCCESS_CATEGORIES.includes(r.classification),
  ).length;
  const failCount = all.length - successCount;

  const byGenre: Record<string, Record<string, number>> = {};
  for (const r of all) {
    const g = r.genre;
    if (!byGenre[g]) byGenre[g] = {};
    byGenre[g][r.classification] = (byGenre[g][r.classification] ?? 0) + 1;
  }

  const latencies = t.latencies.sort((a, b) => a - b);
  const p = (pct: number): number => {
    if (latencies.length === 0) return 0;
    const idx = Math.ceil(pct * latencies.length) - 1;
    return latencies[Math.max(0, Math.min(idx, latencies.length - 1))];
  };

  const failSilentBotBlock = all.filter(
    (r) => r.classification === "FAIL_SILENT_BOT_BLOCK",
  ).length;
  const failSilentLoginWall = all.filter(
    (r) => r.classification === "FAIL_SILENT_LOGIN_WALL",
  ).length;
  const failNetworkOrCrash = all.filter(
    (r) => r.classification === "FAIL_NETWORK_OR_CRASH",
  ).length;

  // ── write report.json ─────────────────────────────────────────────
  const report = {
    runId: RUN_ID,
    mode: MODE,
    totalUrls: entries.length,
    processed: all.length,
    successCount,
    failCount,
    successRate: all.length > 0 ? (successCount / all.length) * 100 : 0,
    byGenre,
    failCategories: {
      FAIL_SILENT_BOT_BLOCK: failSilentBotBlock,
      FAIL_SILENT_LOGIN_WALL: failSilentLoginWall,
      FAIL_EMPTY_JS_SHELL: all.filter(
        (r) => r.classification === "FAIL_EMPTY_JS_SHELL",
      ).length,
      FAIL_NETWORK_OR_CRASH: failNetworkOrCrash,
    },
    latency: {
      p50: p(50),
      p95: p(95),
      p99: p(99),
      max: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
      avg:
        latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : 0,
    },
    telemetry: {
      peakRssMb: Math.round(t.peakRssMb),
      unhandledRejections: t.unhandledRejections,
      fileDescriptors: t.fileDescriptors,
    },
    timestamp: new Date().toISOString(),
    results: all,
  };

  fs.mkdirSync(path.dirname(CORPUS_PATH), { recursive: true });
  const reportPath = path.join(path.dirname(CORPUS_PATH), "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log("\nWrote report: " + reportPath);

  // ── write SUMMARY.md ─────────────────────────────────────────────
  const mdLines: string[] = [
    "# Web Search Engine Stress Test Summary",
    "",
    `**Run ID:** ${RUN_ID}`,
    `**Mode:** ${MODE}`,
    `**Total URLs:** ${entries.length}`,
    `**Processed:** ${all.length}`,
    `**Success rate:** ${report.successRate.toFixed(1)}%`,
    `**Timestamp:** ${report.timestamp}`,
    "",
    "## Per-Genre Classification Breakdown",
    "",
    "| Genre | Total | DIRECT | ADAPTER | METADATA | JINA | SNIPPET | BOT_BLOCK | LOGIN_WALL | EMPTY | CRASH |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];

  for (const [genre, counts] of Object.entries(byGenre)) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const c = (cat: string) => (counts[cat] ?? 0).toString();
    mdLines.push(
      `| ${genre} | ${total} | ${c("SUCCESS_DIRECT")} | ${c("SUCCESS_ADAPTER")} | ${c("SUCCESS_METADATA")} | ${c("SUCCESS_JINA_FALLBACK")} | ${c("SUCCESS_SNIPPET_FALLBACK")} | ${c("FAIL_SILENT_BOT_BLOCK")} | ${c("FAIL_SILENT_LOGIN_WALL")} | ${c("FAIL_EMPTY_JS_SHELL")} | ${c("FAIL_NETWORK_OR_CRASH")} |`,
    );
  }

  mdLines.push(
    "",
    "## Latency",
    "",
    `| p50 | p95 | p99 | avg | max |`,
    `|---|---|---|---|---|`,
    `| ${report.latency.p50}ms | ${report.latency.p95}ms | ${report.latency.p99}ms | ${report.latency.avg}ms | ${report.latency.max}ms |`,
    "",
    "## Memory & Telemetry",
    "",
    `- Peak RSS: ${report.telemetry.peakRssMb}MB`,
    `- Unhandled rejections: ${report.telemetry.unhandledRejections}`,
    `- File descriptors: ${report.telemetry.fileDescriptors}`,
    "",
  );

  const summaryPath = path.join(path.dirname(CORPUS_PATH), "SUMMARY.md");
  fs.writeFileSync(summaryPath, mdLines.join("\n"));
  console.log("Wrote summary: " + summaryPath);

  // ── exit code: 0 if all PASS criteria met, 1 otherwise ─────────
  const passCriteriaMet =
    failSilentBotBlock === 0 &&
    failSilentLoginWall === 0 &&
    failNetworkOrCrash === 0;
  console.log(
    `\n${passCriteriaMet ? "PASS" : "FAIL"} — bot_block=${failSilentBotBlock}, login_wall=${failSilentLoginWall}, crash=${failNetworkOrCrash}`,
  );

  clearCheckpoint(RUN_ID);
  closeStressDb();
  closeCache();
  closeTlsClient();
  process.exit(passCriteriaMet ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
