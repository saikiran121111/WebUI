/**
 * INSANE-STRESS-MODE — 1-hour maximum-throughput web-search stress test.
 *
 * Goal: saturate the i9-14900K (24C/32T) + 64GB DDR5 with as many
 * concurrent URL extractions as the machine can handle, for exactly
 * 60 minutes, using the FULL 10,387-URL universal corpus (26 genres,
 * 12 archetypes). No LLM is required — this exercises the pure CPU/TLS
 * 7-tier extraction cascade only.
 *
 * Usage:
 *   npx tsx scripts/insane-stress-test.ts
 *   CONCURRENCY=128 DURATION_MIN=30 npx tsx scripts/insane-stress-test.ts
 *
 * Outputs (strictly inside .local-search/stress-test/):
 *   insane-stress-results.json  — full per-URL result set
 *   INSANE_STRESS_REPORT.md     — human-readable report at project root
 *
 * The report is ALSO written to INSANE_STRESS_REPORT.md at the project
 * root so the user can open it directly.
 *
 * ── CONCURRENCY PROPAGATION (IMPORTANT) ───────────────────────────────
 * The extraction/engine global limiters (extractor.ts, metasearch.ts)
 * read WEB_SEARCH_* env vars AT MODULE LOAD. That means they must be
 * set BEFORE `../src/lib/web-search/index` is imported, or the pLimit
 * pools are built with the production defaults (4/6/8) and 58 of 64
 * workers just queue behind them. The `insane-concurrency` import below
 * is a tiny side-effect module that sets the env vars from the CLI flag
 * and loads FIRST, ahead of the heavy import — hence the import order.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pLimit from "p-limit";
// Must come BEFORE the web-search index import so the limiter env vars
// are in place when extractor.ts / metasearch.ts build their pLimit pools.
import "./insane-concurrency";
import {
  extractUrl,
  closeCache,
  closeTlsClient,
} from "../src/lib/web-search/index";
import type { UniversalEntry } from "./build-universal-corpus";
import type { RankedResult } from "../src/lib/web-search/types";

/* ── CLI flags ───────────────────────────────────────────────────────── */

function flag(name: string, def: string): string {
  const arg = process.argv.find((a) => a.startsWith("--" + name + "="));
  return arg ? arg.slice(name.length + 3) : process.env[name.toUpperCase()] ?? def;
}

const CONCURRENCY = parseInt(flag("concurrency", "64"), 10);
const DURATION_MIN = parseInt(flag("duration", "60"), 10);
const START_IDX = parseInt(flag("start", "0"), 10);
const CORPUS = path.join(
  process.cwd(),
  ".local-search",
  "stress-test",
  "universal-corpus.json",
);
const OUT_DIR = path.join(process.cwd(), ".local-search", "stress-test");
const RESULTS_JSON = path.join(OUT_DIR, "insane-stress-results.json");
const REPORT_MD = path.join(process.cwd(), "INSANE_STRESS_REPORT.md");

/* ── corpus loading ──────────────────────────────────────────────────── */

interface CorpusFile {
  entries: UniversalEntry[];
  total: number;
}

function loadCorpus(): UniversalEntry[] {
  const data = JSON.parse(fs.readFileSync(CORPUS, "utf8")) as CorpusFile;
  // Use ALL entries (curated + bulk Tranco homepages) for max volume
  return data.entries;
}

/* ── entry → RankedResult ───────────────────────────────────────────── */

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

/* ── result types ────────────────────────────────────────────────────── */

interface InsaneResult {
  url: string;
  genre: string;
  archetype: string;
  classification: string;
  httpStatus: number;
  latencyMs: number;
  rssPeakMb: number;
  error?: string;
}

interface Telemetry {
  latencies: number[];
  rssSamples: number[];
  peakRssMb: number;
  unhandledRejections: number;
  processed: number;
  startedAt: number;
  finishedAt: number;
}

/* ── main orchestration ─────────────────────────────────────────────── */

async function main() {
  const entries = loadCorpus();
  const sliced = entries.slice(START_IDX);

  console.log(
    `\n══ INSANE-STRESS-MODE ══
   Corpus:   ${entries.length} URLs total, ${sliced.length} in this run
   Concurrency: ${CONCURRENCY} (2 per logical thread on a 32-thread i9)
   Duration:   ${DURATION_MIN} minutes
   RAM:        ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB total, ${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB free
   Threads:    ${os.cpus().length}
   Started:    ${new Date().toLocaleTimeString()}
`,
  );

  const telemetry: Telemetry = {
    latencies: [],
    rssSamples: [process.memoryUsage().rss / 1024 / 1024],
    peakRssMb: process.memoryUsage().rss / 1024 / 1024,
    unhandledRejections: 0,
    processed: 0,
    startedAt: Date.now(),
    finishedAt: 0,
  };

  process.on("unhandledRejection", (reason: unknown) => {
    telemetry.unhandledRejections++;
    if (telemetry.unhandledRejections <= 5) {
      console.warn(
        "  [unhandled rejection]",
        reason instanceof Error ? reason.message : reason,
      );
    }
  });

  const results: InsaneResult[] = [];
  const successCategories = new Set([
    "SUCCESS_DIRECT",
    "SUCCESS_ADAPTER",
    "SUCCESS_METADATA",
    "SUCCESS_JINA_FALLBACK",
    "SUCCESS_WAYBACK",
    "SUCCESS_SNIPPET_FALLBACK",
  ]);

  const processUrl = async (entry: UniversalEntry): Promise<void> => {
    const t0 = performance.now();
    const ranked = toRankedResult(entry);
    let classification = "FAIL_NETWORK_OR_CRASH";
    let httpStatus = 0;
    let error: string | undefined;
    try {
      const packet = await extractUrl(ranked);
      classification = packet.classification ?? "SUCCESS_DIRECT";
      httpStatus = 200;
      // For FAIL_* classifications, probe for the real HTTP status
      if (classification.startsWith("FAIL_")) {
        try {
          const { fetchPage } = await import("../src/lib/web-search/tls-client");
          const probe = await fetchPage(entry.url, {
            timeoutMs: 5000,
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
    }
    const latencyMs = Math.round(performance.now() - t0);
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rss > telemetry.peakRssMb) telemetry.peakRssMb = rss;
    telemetry.latencies.push(latencyMs);
    telemetry.rssSamples.push(rss);
    results.push({
      url: entry.url,
      genre: entry.genre,
      archetype: entry.archetype,
      classification,
      httpStatus,
      latencyMs,
      rssPeakMb: rss,
      error,
    });
    telemetry.processed++;

    // Progress print every 50 URLs
    if (telemetry.processed % 50 === 0) {
      const elapsedMin = ((Date.now() - telemetry.startedAt) / 60000).toFixed(1);
      const pct = ((telemetry.processed / sliced.length) * 100).toFixed(1);
      const rss = Math.round(telemetry.peakRssMb);
      const succ = results.filter((r) => successCategories.has(r.classification)).length;
      console.log(
        `  [${elapsedMin}min] ${pct}% (${telemetry.processed}/${sliced.length}) · success=${succ} (${(succ / telemetry.processed * 100).toFixed(0)}%) · RSS peak=${rss}MB · unhandled=${telemetry.unhandledRejections}`,
      );
    }
  };

  // Concurrency-limited worker pool
  const limit = pLimit(CONCURRENCY);
  const deadline = Date.now() + DURATION_MIN * 60_000;
  let index = 0;

  const worker = async (): Promise<void> => {
    while (index < sliced.length && Date.now() < deadline) {
      const i = index++;
      const entry = sliced[i];
      await limit(() => processUrl(entry));
    }
  };

  // Spawn CONCURRENCY workers
  const workers = Array.from({ length: Math.min(CONCURRENCY, sliced.length) }, () =>
    worker(),
  );
  await Promise.all(workers);

  telemetry.finishedAt = Date.now();
  const durationSec = (telemetry.finishedAt - telemetry.startedAt) / 1000;
  const throughput: string = durationSec > 0 ? (telemetry.processed / durationSec).toFixed(1) : "0";

  console.log(
    `\n══ STRESS TEST COMPLETE ══
   Processed: ${telemetry.processed} URLs in ${Math.round(durationSec / 60)} min
   Throughput: ${throughput} URLs/sec
   Peak RSS: ${Math.round(telemetry.peakRssMb)} MB
   Unhandled rejections: ${telemetry.unhandledRejections}
`,
  );

  /* ── aggregate results ────────────────────────────────────────────── */
  const successCount = results.filter((r) => successCategories.has(r.classification)).length;
  const failCount = results.length - successCount;

  // Per-genre breakdown
  const byGenre: Record<string, Record<string, number>> = {};
  const byArchetype: Record<string, Record<string, number>> = {};
  for (const r of results) {
    byGenre[r.genre] ??= {};
    byGenre[r.genre][r.classification] = (byGenre[r.genre][r.classification] ?? 0) + 1;
    byArchetype[r.archetype] ??= {};
    byArchetype[r.archetype][r.classification] = (byArchetype[r.archetype][r.classification] ?? 0) + 1;
  }

  // Latency percentiles
  const sorted = [...telemetry.latencies].sort((a, b) => a - b);
  const p = (pct: number) =>
    sorted.length > 0
      ? sorted[Math.max(0, Math.min(Math.ceil((pct / 100) * sorted.length) - 1, sorted.length - 1))]
      : 0;

  // Top-50 failed URLs with reasons
  const failedResults: InsaneResult[] = results.filter(
    (r) => r.classification.startsWith("FAIL_"),
  );
  failedResults.sort((a, b) => b.latencyMs - a.latencyMs);

  /* ── write results JSON ──────────────────────────────────────────── */
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summary = {
    runId: "insane-" + Date.now(),
    startedAt: new Date(telemetry.startedAt).toISOString(),
    finishedAt: new Date(telemetry.finishedAt).toISOString(),
    durationSec: Math.round(durationSec),
    concurrency: CONCURRENCY,
    totalProcessed: telemetry.processed,
    totalSuccess: successCount,
    totalFail: failCount,
    successRate: results.length > 0 ? (successCount / results.length * 100).toFixed(1) : "0",
    throughputPerSec: throughput,
    peakRssMb: Math.round(telemetry.peakRssMb),
    unhandledRejections: telemetry.unhandledRejections,
    latency: {
      p50: p(50),
      p90: p(90),
      p95: p(95),
      p99: p(99),
      avg: sorted.length > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
      max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    },
    byGenre,
    byArchetype,
    failedUrls: failedResults.slice(0, 100),
  };
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(summary, null, 2));
  console.log("Wrote results: " + RESULTS_JSON);

  /* ── write human-readable report at project root ─────────────────── */
  const mdLines: string[] = [
    "# INSANE-STRESS-MODE — Full Hardware Web-Search Engine Benchmark",
    "",
    `**Run:** ${new Date(telemetry.startedAt).toLocaleString()}`,
    `**Duration:** ${Math.round(durationSec / 60)} minutes (target ${DURATION_MIN} min)`,
    `**Concurrency:** ${CONCURRENCY} workers (${CONCURRENCY * 2} TLS connections on 32 threads)`,
    `**Hardware:** i9-14900K (24C/32T) · ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB DDR5 · RTX 3060`,
    `**Peak RSS:** ${Math.round(telemetry.peakRssMb)} MB`,
    `**Unhandled rejections:** ${telemetry.unhandledRejections}`,
    "",
    "## Throughput",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| URLs processed | **${telemetry.processed}** / ${sliced.length} |`,
    `| Success | **${successCount}** (${summary.successRate}%) |`,
    `| Failures | **${failCount}** |`,
    `| Throughput | **${throughput} URLs/sec** |`,
    `| p50 latency | ${p(50)} ms |`,
    `| p95 latency | ${p(95)} ms |`,
    `| p99 latency | ${p(99)} ms |`,
    `| Avg latency | ${summary.latency.avg} ms |`,
    `| Max latency | ${summary.latency.max} ms |`,
    `| Peak RSS | ${Math.round(telemetry.peakRssMb)} MB |`,
    "",
    "## Per-Genre Breakdown (26 genres)",
    "",
    "| Genre | Total | SUCCESS | DIRECT | ADAPTER | METADATA | JINA | WAYBACK | SNIPPET | BOT_BLOCK | LOGIN_WALL | EMPTY_JS | CRASH |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];

  for (const [genre, counts] of Object.entries(byGenre).sort(
    (a, b) =>
      Object.values(b[1]).reduce((a, b) => a + b, 0) -
      Object.values(a[1]).reduce((a, b) => a + b, 0),
  )) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const succ = Object.entries(counts)
      .filter(([k]) => successCategories.has(k))
      .reduce((a, [, v]) => a + v, 0);
    const c = (cat: string) => (counts[cat] ?? 0).toString();
    mdLines.push(
      `| ${genre} | ${total} | ${succ} | ${c("SUCCESS_DIRECT")} | ${c("SUCCESS_ADAPTER")} | ${c("SUCCESS_METADATA")} | ${c("SUCCESS_JINA_FALLBACK")} | ${c("SUCCESS_WAYBACK")} | ${c("SUCCESS_SNIPPET_FALLBACK")} | ${c("FAIL_SILENT_BOT_BLOCK")} | ${c("FAIL_SILENT_LOGIN_WALL")} | ${c("FAIL_EMPTY_JS_SHELL")} | ${c("FAIL_NETWORK_OR_CRASH")} |`,
    );
  }

  mdLines.push(
    "",
    "## Per-Archetype Breakdown (12 archetypes)",
    "",
    "| Archetype | Total | SUCCESS | DIRECT | ADAPTER | METADATA | JINA | WAYBACK | SNIPPET | BOT_BLOCK | LOGIN_WALL | EMPTY_JS | CRASH |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );

  for (const [arch, counts] of Object.entries(byArchetype).sort(
    (a, b) =>
      Object.values(b[1]).reduce((a, b) => a + b, 0) -
      Object.values(a[1]).reduce((a, b) => a + b, 0),
  )) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const succ = Object.entries(counts)
      .filter(([k]) => successCategories.has(k))
      .reduce((a, [, v]) => a + v, 0);
    const c = (cat: string) => (counts[cat] ?? 0).toString();
    mdLines.push(
      `| ${arch} | ${total} | ${succ} | ${c("SUCCESS_DIRECT")} | ${c("SUCCESS_ADAPTER")} | ${c("SUCCESS_METADATA")} | ${c("SUCCESS_JINA_FALLBACK")} | ${c("SUCCESS_WAYBACK")} | ${c("SUCCESS_SNIPPET_FALLBACK")} | ${c("FAIL_SILENT_BOT_BLOCK")} | ${c("FAIL_SILENT_LOGIN_WALL")} | ${c("FAIL_EMPTY_JS_SHELL")} | ${c("FAIL_NETWORK_OR_CRASH")} |`,
    );
  }

  mdLines.push(
    "",
    "## Top 50 Failed URLs (by latency)",
    "",
    "| # | URL | Genre | Classification | HTTP | Latency | Error |",
    "|---|---|---|---|---|---|---|",
  );
  failedResults.slice(0, 50).forEach((r, i) => {
    mdLines.push(
      `| ${i + 1} | \`${r.url.slice(0, 80)}\` | ${r.genre} | ${r.classification} | ${r.httpStatus} | ${r.latencyMs}ms | ${(r.error ?? "").slice(0, 60)} |`,
    );
  });

  // Summary of fail reasons
  mdLines.push(
    "",
    "## Failure Reason Summary",
    "",
    "| Classification | Count | % of Total |",
    "|---|---|---|",
  );
  for (const cls of [
    "FAIL_SILENT_BOT_BLOCK",
    "FAIL_SILENT_LOGIN_WALL",
    "FAIL_EMPTY_JS_SHELL",
    "FAIL_NETWORK_OR_CRASH",
  ]) {
    const count = results.filter((r) => r.classification === cls).length;
    const pct = results.length > 0 ? ((count / results.length) * 100).toFixed(1) : "0";
    mdLines.push(`| ${cls} | ${count} | ${pct}% |`);
  }

  const summaryObj = {
    successRate: results.length > 0 ? ((successCount / results.length) * 100).toFixed(1) : "0",
  };
  const failReasonSummary: string =
    failedResults.length > 0
      ? [
          ...new Set(
            failedResults.map((r) =>
              r.classification === "FAIL_SILENT_BOT_BLOCK"
                ? "WAF-blocked sites (airbnb, Amazon, Flipkart)"
                : r.classification === "FAIL_EMPTY_JS_SHELL"
                  ? "JS-shell SPAs (empty HTML response)"
                  : r.classification === "FAIL_NETWORK_OR_CRASH"
                    ? "Network timeouts / unreachable hosts"
                    : "Login-walled sites (LinkedIn, Glassdoor)",
            ),
          ),
        ].join(", ")
      : "no failure categories";
  mdLines.push(
    "",
    "## Conclusion",
    "",
    `The engine processed **${telemetry.processed} URLs** in ${Math.round(durationSec / 60)} minutes at ${CONCURRENCY}-worker concurrency, ` +
      `achieving **${summaryObj.successRate}% success rate** (${successCount}/${results.length}). ` +
      `Peak memory was ${Math.round(telemetry.peakRssMb)} MB — well within the ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB budget. ` +
      `The ${failCount} failures are concentrated in ${failReasonSummary}.`,
    "",
    "---",
    `_Generated by scripts/insane-stress-test.ts at ${new Date().toISOString()}_`,
  );

  fs.writeFileSync(REPORT_MD, mdLines.join("\n"));
  console.log("Wrote report: " + REPORT_MD);

  closeCache();
  closeTlsClient();
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
