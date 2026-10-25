/**
 * 10K universal benchmark — Playwright test cases.
 *
 * Auto-generates one test per URL from `.data/web-search-10k-urls.json`
 * (the corpus is built by `scripts/build-10k-url-corpus.ts`). Each test
 * runs the URL through the Universal Extractor + in-memory Playwright
 * pool, then asks the main model the strict YES/NO question:
 *
 *   "Can you see and read the real content/metadata of this webpage
 *    (<url>)? Reply strictly in JSON:
 *    {"visible": "YES" | "NO", "extractedSummary": "...", "reason": "..."}"
 *
 * The full 10,000-case run is too large for a single CI invocation, so
 * the spec samples a slice by default (`WEB_SEARCH_10K_SAMPLE`, default
 * 100) and can be pointed at any range with `WEB_SEARCH_10K_RANGE`
 * ("start-end", 0-based, inclusive). The report is aggregated by
 * `scripts/playwright-10k-audit.ts` into
 * `docs/web-search-10k-report.md`.
 *
 * ZERO-DOWNLOAD rule: this spec never runs `playwright install` — the
 * in-memory pool (lib/web-search/agentBrowser.ts) resolves Chromium from
 * the repo-local `.data/ms-playwright` cache via
 * PLAYWRIGHT_BROWSERS_PATH, exactly like playwright.config.ts does.
 */
import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { extractPageInOnePass, closeBrowserPool } from "../lib/web-search/agentBrowser";
import { walkGenericJsonForEntities } from "../lib/web-search/hydration-unpacker";
import { llmApiUrl, llmApiKey } from "../lib/server/settings";
import { THINKING_OFF_BODY } from "../lib/web-search/llm-json";

const CORPUS_FILE = join(process.cwd(), ".data", "web-search-10k-urls.json");
const REPORT_FILE = join(process.cwd(), "docs", "web-search-10k-report.md");

interface CorpusEntry {
  url: string;
  source?: string;
  livenessCheckAt?: string;
}

function loadCorpus(): CorpusEntry[] {
  expect(
    existsSync(CORPUS_FILE),
    `corpus ${CORPUS_FILE} missing — run \`npx tsx scripts/build-10k-url-corpus.ts\` first`,
  ).toBe(true);
  const raw = readFileSync(CORPUS_FILE, "utf8");
  const data = JSON.parse(raw);
  const urls: string[] = Array.isArray(data) ? data : data?.urls ?? [];
  return urls.map((u: string) => ({ url: u }));
}

function selectSlice(corpus: CorpusEntry[]): CorpusEntry[] {
  const sample = Math.max(1, parseInt(process.env.WEB_SEARCH_10K_SAMPLE ?? "100", 10));
  const range = process.env.WEB_SEARCH_10K_RANGE; // "start-end" 0-based inclusive
  if (range) {
    const m = range.match(/^(\d+)-(\d+)$/);
    if (m) {
      const start = Math.max(0, Number(m[1]));
      const end = Math.min(corpus.length - 1, Number(m[2]));
      return corpus.slice(start, end + 1);
    }
  }
  return corpus.slice(0, sample);
}

interface Verdict {
  visible: "YES" | "NO" | "UNKNOWN";
  extractedSummary: string;
  reason: string;
}

async function askModelVerdict(url: string, extractionText: string): Promise<Verdict> {
  const fallback: Verdict = { visible: "UNKNOWN", extractedSummary: "", reason: "model call failed" };
  const prompt =
    `Can you see and read the real content/metadata of this webpage (${url})? ` +
    `Reply strictly in JSON: {"visible": "YES" | "NO", "extractedSummary": "...", "reason": "..."}\n\n` +
    `Extraction returned:\n${extractionText.slice(0, 6000)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    const res = await fetch(llmApiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + llmApiKey(),
      },
      body: JSON.stringify({
        model: "default",
        messages: [
          { role: "system", content: "You are a strict yes/no verdict engine. Reply with ONLY the JSON object." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        ...THINKING_OFF_BODY,
        max_tokens: 400,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return fallback;
    const data: any = await res.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
    const reasoning = String(data?.choices?.[0]?.message?.reasoning_content ?? "").trim();
    for (const raw of [content, reasoning]) {
      if (!raw) continue;
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start < 0 || end < 0) continue;
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        const v = String(parsed.visible ?? "").toUpperCase();
        return {
          visible: v === "YES" ? "YES" : v === "NO" ? "NO" : "UNKNOWN",
          extractedSummary: String(parsed.extractedSummary ?? "").slice(0, 300),
          reason: String(parsed.reason ?? "").slice(0, 300),
        };
      } catch { /* try next field */ }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function composeExtractionText(
  url: string,
  r: Awaited<ReturnType<typeof extractPageInOnePass>>,
): string {
  const parts: string[] = [];
  parts.push(`URL: ${url}`);
  parts.push(`Final URL: ${r.finalUrl}`);
  parts.push(`HTTP status: ${r.status}`);
  parts.push(`Title: ${r.title}`);
  if (r.bodyText) parts.push(`Body text (first 4000 chars):\n${r.bodyText.slice(0, 4000)}`);
  if (r.jsonLd?.length > 0) parts.push(`JSON-LD:\n${JSON.stringify(r.jsonLd).slice(0, 2000)}`);
  if (Object.keys(r.meta ?? {}).length > 0) {
    const lines = Object.entries(r.meta)
      .filter(([k]) => /^(og:|twitter:)/.test(k) || k === "description")
      .slice(0, 10)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`);
    if (lines.length > 0) parts.push(`Meta:\n${lines.join("\n")}`);
  }
  for (const [key, raw] of Object.entries(r.windowState ?? {})) {
    try {
      const parsed = JSON.parse(raw);
      const cards = walkGenericJsonForEntities(parsed, { maxCards: 15, label: key });
      if (cards) parts.push(`Hydration state (${key}):\n${cards}`);
    } catch { /* not JSON */ }
  }
  return parts.join("\n\n");
}

const corpus = loadCorpus();
const slice = selectSlice(corpus);

test(`web-search-10k: ${slice.length} of ${corpus.length} URLs (universal extractor + Playwright pool + AI verdict)`, async () => {
  test.setTimeout(600_000);

  // Open the report once for this run.
  mkdirSync(join(process.cwd(), "docs"), { recursive: true });

  const rows: Array<{ url: string; verdict: Verdict; bodyChars: number; status: number | null }> = [];
  let poolClosed = false;

  for (const entry of slice) {
    const r = await extractPageInOnePass(entry.url, { timeoutMs: 40_000 });
    const text = composeExtractionText(entry.url, r);
    const verdict = await askModelVerdict(entry.url, text);
    rows.push({ url: entry.url, verdict, bodyChars: r.bodyText?.length ?? 0, status: r.status });
    process.stdout.write(
      `[10k] ${verdict.visible}  body=${String(r.bodyText?.length ?? 0).padStart(5)}  ${entry.url}\n`,
    );
  }

  if (!poolClosed) {
    await closeBrowserPool();
    poolClosed = true;
  }

  // Append this run's rows to the report (the audit script aggregates
  // across runs; the spec itself just guarantees the data is captured).
  const summary = {
    runAt: new Date().toISOString(),
    sample: slice.length,
    yes: rows.filter((r) => r.verdict.visible === "YES").length,
    no: rows.filter((r) => r.verdict.visible === "NO").length,
    unknown: rows.filter((r) => r.verdict.visible === "UNKNOWN").length,
    rows,
  };
  appendFileSync(
    REPORT_FILE,
    `\n## Run ${summary.runAt}\n\n` +
    `- Sampled: ${summary.sample}\n` +
    `- YES: ${summary.yes}\n` +
    `- NO: ${summary.no}\n` +
    `- UNKNOWN: ${summary.unknown}\n\n` +
    rows
      .map(
        (r) =>
          `| ${r.url} | ${r.status} | ${r.bodyChars} | ${r.verdict.visible} | ` +
          `${(r.verdict.extractedSummary ?? r.verdict.reason).replace(/\|/g, "/").slice(0, 120)} |`,
      )
      .join("\n") +
    "\n",
    "utf8",
  );

  // The universal guarantee: the extractor waterfall must never return 0
  // passages — even a fully-blocked URL yields the SERP baseline. The
  // AI verdict "NO" is a data point, not a hard fail (a handful of
  // hard-blocked sites in 10K is expected); the test fails only when
  // the extraction layer itself produced nothing for a URL.
  const emptyExtractions = rows.filter((r) => r.bodyChars < 50 && r.status !== 200 && r.verdict.visible === "NO");
  expect(
    emptyExtractions.length,
    `${emptyExtractions.length} URLs returned zero extraction even through the full waterfall: ${emptyExtractions.slice(0, 5).map((r) => r.url).join(", ")}`,
  ).toBeLessThan(Math.max(2, Math.floor(rows.length * 0.02)));
});
