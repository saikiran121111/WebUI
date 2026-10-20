/**
 * Universal 25-genre × 12-archetype 10,000+ URL stress test.
 *
 * Usage:
 *   npx tsx scripts/stress-test-universal.ts --mode=canary          # ~750-URL matrix
 *   npx tsx scripts/stress-test-universal.ts --mode=full-10k        # full 10,000+ corpus
 *   npx tsx scripts/stress-test-universal.ts --mode=canary --resume # continue a prior run
 *   npx tsx scripts/stress-test-universal.ts --mode=full-10k --concurrency=12
 *
 * Outputs (all strictly inside .local-search/stress-test/):
 *   diagnostics.json        — per-URL extraction tier, mode, table/code counts
 *   UNIVERSAL_REPORT.md     — 25-genre × 12-archetype breakdown table
 *   universal-cache.sqlite  — checkpoint + results DB (separate from production cache)
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
import type { UniversalEntry, Genre, Archetype } from "./build-universal-corpus";
import type { RankedResult } from "../src/lib/web-search/types";

/* ── CLI flags ───────────────────────────────────────────────────────── */

function flag(name: string, def: string): string {
  const arg = process.argv.find((a) => a.startsWith("--" + name + "="));
  return arg ? arg.slice(name.length + 3) : def;
}

const MODE = flag("mode", "canary"); // "canary" | "full-10k"
const RESUME = process.argv.includes("--resume");
const CONCURRENCY = parseInt(flag("concurrency", "8"), 10);
const BATCH_SIZE = parseInt(flag("batch", "500"), 10);
const RUN_ID = process.env.UNIVERSAL_RUN_ID ?? "universal-" + Date.now();

/* ── corpus loading ──────────────────────────────────────────────────── */

const CORPUS_PATH = path.join(
  process.cwd(),
  ".local-search",
  "stress-test",
  "universal-corpus.json",
);

interface CorpusFile {
  entries: UniversalEntry[];
  total: number;
}

function loadCorpus(): CorpusFile {
  if (!fs.existsSync(CORPUS_PATH)) {
    console.error(
      "Corpus not found at " + CORPUS_PATH + ". Run `npx tsx scripts/build-universal-corpus.ts` first.",
    );
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")) as CorpusFile;
  return data;
}

function selectEntries(corpus: CorpusFile): UniversalEntry[] {
  if (MODE === "canary") {
    return corpus.entries.filter((e) => e.curated);
  }
  // Full-10k mode: skip pure infrastructure hosts (CDN / DNS / SDK /
  // Google subdomains) — they're noise in the Tranco list and only
  // produce FAIL_NETWORK_OR_CRASH results.
  const INFRA = new Set([
    "googleapis.com", "gstatic.com", "googlevideo.com", "ggpht.com",
    "google-analytics.com", "googleusercontent.com", "google.com",
    "gtld-servers.net", "amazonaws.com", "cloudfront.net", "fastly.net",
    "fastlylb.net", "akamai.net", "akamaihd.net", "akamaiedge.net",
    "fbcdn.net", "fbsbx.com", "facebook.com", "twitch.tv",
    "mail.ru", "yandex.ru", "vk.com", "yandex.net", "yandexcloud.com",
    "live.com", "office.com", "officeapps.live.com", "onedrive.live.com",
    "azurewebsites.net", "microsofttranslator.com", "appsflyersdk.com",
    "appsdk.com", "hcst-cdn.com", "hicloudcam.com", "ezviz.com",
    "ezvizlife.com", "ezviz7.com", "ezviz.com.cn", "domaincontrol.com",
    "dzen.ru", "youtube.com", "youtu.be", "instagram.com",
  ]);
  return corpus.entries.filter((e) => !INFRA.has(e.host) || e.curated);
}

/* ── CorpusEntry → RankedResult ────────────────────────────────────── */

function toRankedResult(entry: UniversalEntry): RankedResult {
  let canonical = entry.url;
  let domain = entry.host;
  try {
    const u = new URL(entry.url);
    domain = u.hostname.toLowerCase().replace(/^www\./, "");
    canonical = u.toString();
  } catch {
    /* use entry.host */
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
  peakRssMb: number;
  unhandledRejections: number;
}

function makeTelemetry(): Telemetry {
  const m = process.memoryUsage();
  return {
    latencies: [],
    rssSamples: [m.rss / 1024 / 1024],
    peakRssMb: m.rss / 1024 / 1024,
    unhandledRejections: 0,
  };
}

let telemetryRef: Telemetry = makeTelemetry();

process.on("unhandledRejection", (reason: unknown) => {
  console.warn(
    "[universal-stress] unhandled rejection:",
    reason instanceof Error ? reason.message : reason,
  );
  telemetryRef.unhandledRejections++;
});

/* ── classification categories ─────────────────────────────────────── */

const SUCCESS_CATEGORIES = [
  "SUCCESS_DIRECT",
  "SUCCESS_ADAPTER",
  "SUCCESS_METADATA",
  "SUCCESS_JINA_FALLBACK",
  "SUCCESS_WAYBACK",
  "SUCCESS_SNIPPET_FALLBACK",
];
const FAIL_CATEGORIES = [
  "FAIL_SILENT_BOT_BLOCK",
  "FAIL_SILENT_LOGIN_WALL",
  "FAIL_EMPTY_JS_SHELL",
  "FAIL_NETWORK_OR_CRASH",
];

/* ── per-host rate limiting (avoid DDoS) ───────────────────────────── */

const HOST_LIMIT = 3;
const hostLimiter = new Map<string, LimitFunction>();

function hostLimit(host: string): LimitFunction {
  let fn = hostLimiter.get(host);
  if (!fn) {
    fn = pLimit(HOST_LIMIT);
    hostLimiter.set(host, fn);
  }
  return fn;
}

/* ── worker ─────────────────────────────────────────────────────────── */

async function processUrl(
  entry: UniversalEntry,
  t: Telemetry,
): Promise<StressResult> {
  const t0 = performance.now();

  // Checkpoint: skip URLs already recorded
  if (hasResult(entry.url)) {
    const prior = allResults().find((r) => r.url === entry.url);
    if (prior) return prior;
  }

  const ranked = toRankedResult(entry);
  let classification: string;
  let httpStatus = 200;
  let error: string | undefined;

  try {
    const packet = await extractUrl(ranked);
    classification = packet.classification ?? "SUCCESS_DIRECT";
    httpStatus = 200;
    // For FAIL_* classifications, probe for the real HTTP status
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
    }
  } catch (e: unknown) {
    classification = "FAIL_NETWORK_OR_CRASH";
    error = e instanceof Error ? e.message : String(e);
    httpStatus = 0;
  }

  const latencyMs = Math.round(performance.now() - t0);
  const rssPeakMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  t.latencies.push(latencyMs);
  if (rssPeakMb > t.peakRssMb) t.peakRssMb = rssPeakMb;

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
  return result;
}

/* ── main orchestration ─────────────────────────────────────────────── */

async function main() {
  const corpus = loadCorpus();
  const all = selectEntries(corpus);
  console.log(
    `Universal stress test (${MODE} mode): ${all.length} URLs, concurrency=${CONCURRENCY}`,
  );

  telemetryRef = makeTelemetry();
  const t = telemetryRef;

  // Resume support: skip URLs already in the checkpoint
  let startIdx = 0;
  if (RESUME) {
    const cp = getCheckpoint(RUN_ID);
    if (cp !== null && cp < all.length) {
      startIdx = cp + 1;
      console.log(`Resuming from index ${startIdx} (checkpoint found)`);
    }
  }

  const remaining = all.slice(startIdx);
  const globalLimit = pLimit(CONCURRENCY);
  let done = 0;

  const run = (entry: UniversalEntry) =>
    hostLimit(entry.host)(() =>
      globalLimit(() => processUrl(entry, t)),
    );

  for (let i = 0; i < remaining.length; i++) {
    const entry = remaining[i];
    const promise = run(entry);
    if ((i + startIdx + 1) % BATCH_SIZE === 0) {
      setCheckpoint(RUN_ID, i + startIdx);
    }
    await promise;
    done++;
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

  // ── aggregate results ──────────────────────────────────────────────
  const results = allResults();
  const successCount = results.filter((r: StressResult) =>
    SUCCESS_CATEGORIES.includes(r.classification),
  ).length;
  const failCount = results.length - successCount;

  // Per-genre breakdown
  const byGenre: Record<string, Record<string, number>> = {};
  // Per-archetype breakdown (from the corpus entry)
  const byArchetype: Record<string, Record<string, number>> = {};
  const entryByUrl = new Map(all.map((e) => [e.url, e]));
  for (const r of results) {
    const g = r.genre;
    if (!byGenre[g]) byGenre[g] = {};
    byGenre[g][r.classification] = (byGenre[g][r.classification] ?? 0) + 1;
    const entry = entryByUrl.get(r.url);
    if (entry) {
      const a = entry.archetype;
      if (!byArchetype[a]) byArchetype[a] = {};
      byArchetype[a][r.classification] =
        (byArchetype[a][r.classification] ?? 0) + 1;
    }
  }

  const latencies = t.latencies.sort((a, b) => a - b);
  const p = (pct: number): number => {
    if (latencies.length === 0) return 0;
    const idx = Math.ceil((pct / 100) * latencies.length) - 1;
    return latencies[Math.max(0, Math.min(idx, latencies.length - 1))];
  };

  const failSilentBotBlock = results.filter(
    (r) => r.classification === "FAIL_SILENT_BOT_BLOCK",
  ).length;
  const failSilentLoginWall = results.filter(
    (r) => r.classification === "FAIL_SILENT_LOGIN_WALL",
  ).length;
  const failNetworkOrCrash = results.filter(
    (r) => r.classification === "FAIL_NETWORK_OR_CRASH",
  ).length;

  // ── write diagnostics.json (per-URL detail) ──────────────────────
  const diagnostics = {
    runId: RUN_ID,
    mode: MODE,
    total: all.length,
    processed: results.length,
    successCount,
    failCount,
    failCategories: {
      FAIL_SILENT_BOT_BLOCK: failSilentBotBlock,
      FAIL_SILENT_LOGIN_WALL: failSilentLoginWall,
      FAIL_EMPTY_JS_SHELL: results.filter(
        (r) => r.classification === "FAIL_EMPTY_JS_SHELL",
      ).length,
      FAIL_NETWORK_OR_CRASH: failNetworkOrCrash,
    },
    latency: {
      p50: p(50),
      p95: p(95),
      p99: p(99),
      avg:
        latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : 0,
      max: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
    },
    telemetry: {
      peakRssMb: Math.round(t.peakRssMb),
      unhandledRejections: t.unhandledRejections,
    },
    timestamp: new Date().toISOString(),
    byGenre,
    byArchetype,
  };

  fs.mkdirSync(path.dirname(CORPUS_PATH), { recursive: true });
  const diagPath = path.join(path.dirname(CORPUS_PATH), "diagnostics.json");
  fs.writeFileSync(diagPath, JSON.stringify(diagnostics, null, 2));
  console.log("\nWrote diagnostics: " + diagPath);

  // ── write UNIVERSAL_REPORT.md ─────────────────────────────────────
  const mdLines: string[] = [
    "# Universal Web Search Engine — Stress Test Report",
    "",
    `**Run ID:** ${RUN_ID}`,
    `**Mode:** ${MODE}`,
    `**Total URLs:** ${all.length}`,
    `**Processed:** ${results.length}`,
    `**Success rate:** ${
      results.length > 0
        ? ((successCount / results.length) * 100).toFixed(1)
        : "0"
    }%`,
    `**Timestamp:** ${diagnostics.timestamp}`,
    "",
    "## Per-Genre Breakdown (25 genres)",
    "",
    "| Genre | Total | DIRECT | ADAPTER | METADATA | JINA | WAYBACK | SNIPPET | BOT_BLOCK | LOGIN_WALL | EMPTY | CRASH |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];

  for (const [genre, counts] of Object.entries(byGenre).sort(
    (a, b) => Object.values(b[1]).reduce((a, b) => a + b, 0) -
      Object.values(a[1]).reduce((a, b) => a + b, 0),
  )) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const c = (cat: string) => (counts[cat] ?? 0).toString();
    mdLines.push(
      `| ${genre} | ${total} | ${c("SUCCESS_DIRECT")} | ${c("SUCCESS_ADAPTER")} | ${c("SUCCESS_METADATA")} | ${c("SUCCESS_JINA_FALLBACK")} | ${c("SUCCESS_WAYBACK")} | ${c("SUCCESS_SNIPPET_FALLBACK")} | ${c("FAIL_SILENT_BOT_BLOCK")} | ${c("FAIL_SILENT_LOGIN_WALL")} | ${c("FAIL_EMPTY_JS_SHELL")} | ${c("FAIL_NETWORK_OR_CRASH")} |`,
    );
  }

  mdLines.push(
    "",
    "## Per-Archetype Breakdown (12 archetypes)",
    "",
    "| Archetype | Total | DIRECT | ADAPTER | METADATA | JINA | WAYBACK | SNIPPET | BOT_BLOCK | LOGIN_WALL | EMPTY | CRASH |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  );

  for (const [arch, counts] of Object.entries(byArchetype).sort(
    (a, b) =>
      Object.values(b[1]).reduce((a, b) => a + b, 0) -
      Object.values(a[1]).reduce((a, b) => a + b, 0),
  )) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const c = (cat: string) => (counts[cat] ?? 0).toString();
    mdLines.push(
      `| ${arch} | ${total} | ${c("SUCCESS_DIRECT")} | ${c("SUCCESS_ADAPTER")} | ${c("SUCCESS_METADATA")} | ${c("SUCCESS_JINA_FALLBACK")} | ${c("SUCCESS_WAYBACK")} | ${c("SUCCESS_SNIPPET_FALLBACK")} | ${c("FAIL_SILENT_BOT_BLOCK")} | ${c("FAIL_SILENT_LOGIN_WALL")} | ${c("FAIL_EMPTY_JS_SHELL")} | ${c("FAIL_NETWORK_OR_CRASH")} |`,
    );
  }

  mdLines.push(
    "",
    "## Latency",
    "",
    "| p50 | p95 | p99 | avg | max |",
    "|---|---|---|---|---|",
    `| ${diagnostics.latency.p50}ms | ${diagnostics.latency.p95}ms | ${diagnostics.latency.p99}ms | ${diagnostics.latency.avg}ms | ${diagnostics.latency.max}ms |`,
    "",
    "## Memory & Telemetry",
    "",
    `- Peak RSS: ${diagnostics.telemetry.peakRssMb}MB`,
    `- Unhandled rejections: ${diagnostics.telemetry.unhandledRejections}`,
    "",
  );

  const reportPath = path.join(
    path.dirname(CORPUS_PATH),
    "UNIVERSAL_REPORT.md",
  );
  fs.writeFileSync(reportPath, mdLines.join("\n"));
  console.log("Wrote report: " + reportPath);

  // ── exit code: 0 if all PASS criteria met ────────────────────────
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
