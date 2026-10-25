/**
 * Playwright 10K universal extraction audit.
 *
 * Reads `.data/web-search-10k-urls.json` (built by
 * `scripts/build-10k-url-corpus.ts`) and runs each URL through the
 * Universal Extractor + in-memory Playwright pool. For each URL the
 * main model is asked:
 *
 *   "Can you see and read the real content/metadata of this webpage
 *    (<url>)? Reply strictly in JSON:
 *    {"visible": "YES"|"NO", "extractedSummary": "...", "reason": "..."}"
 *
 * The verdicts are written to `docs/web-search-10k-report.md`.
 *
 * Usage:
 *   npx tsx scripts/playwright-10k-audit.ts [startIdx] [count]
 *     startIdx — resume from this 0-based index (default 0)
 *     count    — audit this many URLs (default: all remaining)
 *
 * ZERO-DOWNLOAD rule: no `playwright install` — the pool resolves its
 * Chromium from the repo-local `.data/ms-playwright` cache via
 * PLAYWRIGHT_BROWSERS_PATH (see lib/web-search/agentBrowser.ts).
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractPageInOnePass, closeBrowserPool } from "../lib/web-search/agentBrowser";
import { walkGenericJsonForEntities } from "../lib/web-search/hydration-unpacker";
import { llmApiUrl, llmApiKey } from "../lib/server/settings";
import { THINKING_OFF_BODY } from "../lib/web-search/llm-json";

const CORPUS_FILE = join(process.cwd(), ".data", "web-search-10k-urls.json");
const REPORT_FILE = join(process.cwd(), "docs", "web-search-10k-report.md");

interface Verdict {
  visible: "YES" | "NO" | "UNKNOWN";
  extractedSummary: string;
  reason: string;
}

async function askModel(url: string, extractionText: string, verdictBudgetMs = 30_000): Promise<Verdict | null> {
  const prompt =
    `Can you see and read the real content/metadata of this webpage (${url})? ` +
    `The extraction engine returned the text below. Reply strictly in JSON: ` +
    '{"visible": "YES" | "NO", "extractedSummary": "...", "reason": "..."}\n\n' +
    `--- EXTRACTION (first 4,000 chars) ---\n` +
    extractionText.slice(0, 4000);

  const body: Record<string, unknown> = {
    model: "default",
    messages: [
      {
        role: "system",
        content:
          "You verify whether a web-page extraction produced real, readable " +
          "content. Answer ONLY valid JSON with the exact three keys. " +
          '"visible" is "YES" when the extraction contains a real page ' +
          "(title + ≥100 chars of human-readable body, or structured facts " +
          "like price/rating/URLs), " +
          '"NO" when it is empty, a CAPTCHA/challenge page, a login wall, ' +
          "or a redirect stub with no destination content.",
      },
      { role: "user", content: prompt },
      { role: "user", content: "Reply now." },
    ],
    temperature: 0,
    ...THINKING_OFF_BODY,
    max_tokens: 300,
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), verdictBudgetMs);
    const res = await fetch(llmApiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + llmApiKey(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
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
        const visible = String(parsed.visible ?? "").toUpperCase() === "YES"
          ? "YES"
          : String(parsed.visible ?? "").toUpperCase() === "NO"
            ? "NO"
            : "UNKNOWN";
        return {
          visible,
          extractedSummary: String(parsed.extractedSummary ?? "").slice(0, 300),
          reason: String(parsed.reason ?? "").slice(0, 300),
        };
      } catch { /* try next field */ }
    }
    return null;
  } catch {
    return null;
  }
}

/** Compose the extraction text fed to the model for one URL. */
function composeExtractionText(
  url: string,
  r: Awaited<ReturnType<typeof extractPageInOnePass>>,
): string {
  const parts: string[] = [];
  parts.push(`URL: ${url}`);
  parts.push(`Final URL: ${r.finalUrl}`);
  parts.push(`HTTP status: ${r.status}`);
  parts.push(`Title: ${r.title}`);
  if (r.bodyText) parts.push(`Body (first 3000 chars):\n${r.bodyText.slice(0, 3000)}`);
  if (r.jsonLd?.length > 0) {
    parts.push(`JSON-LD:\n${JSON.stringify(r.jsonLd).slice(0, 2000)}`);
  }
  const metaLines = Object.entries(r.meta ?? {})
    .filter(([k]) => /^(og:|twitter:|description)/.test(k))
    .map(([k, v]) => `- ${k}: ${String(v).slice(0, 200)}`);
  if (metaLines.length > 0) parts.push(`OpenGraph/Twitter meta:\n${metaLines.join("\n")}`);
  for (const [key, raw] of Object.entries(r.windowState ?? {})) {
    try {
      const parsed = JSON.parse(raw);
      const cards = walkGenericJsonForEntities(parsed, { maxCards: 12, label: key });
      if (cards) parts.push(`Hydration state (${key}):\n${cards}`);
    } catch { /* not JSON */ }
  }
  return parts.join("\n\n");
}

async function main() {
  const startIdx = Math.max(0, parseInt(process.argv[2] ?? "0", 10) || 0);
  const count = Math.max(0, parseInt(process.argv[3] ?? "0", 10) || 0);

  if (!existsSync(CORPUS_FILE)) {
    console.error(
      `[10k-audit] corpus not found at ${CORPUS_FILE}.\n` +
      `Run \`npx tsx scripts/build-10k-url-corpus.ts\` first (zero-download rule: ` +
      `the builder uses the project's own general-web engine SERPs, not Tranco).`,
    );
    process.exit(1);
  }
  const corpus: { urls?: string[]; verified?: number; generatedAt?: string } =
    JSON.parse(readFileSync(CORPUS_FILE, "utf8"));
  const urls: string[] = corpus.urls ?? [];
  const total = urls.length;
  const end = count > 0 ? Math.min(startIdx + count, total) : total;
  if (startIdx >= total) {
    console.log(`[10k-audit] start index ${startIdx} is past the end (${total}); nothing to do.`);
    return;
  }
  console.log(`[10k-audit] auditing URLs ${startIdx}..${end - 1} of ${total}`);

  // Open (or extend) the report header.
  if (!existsSync(REPORT_FILE)) {
    mkdirSync(join(process.cwd(), "docs"), { recursive: true });
    writeFileSync(
      REPORT_FILE,
      `# Web-Search 10K Universal Benchmark Report\n\n` +
      `Generated: ${new Date().toISOString()}\n` +
      `Corpus: .data/web-search-10k-urls.json (${corpus.verified ?? total} verified URLs)\n\n` +
      `## Results\n`,
      "utf8",
    );
  }

  let pass = 0;
  let fail = 0;
  let unknown = 0;

  for (let i = startIdx; i < end; i++) {
    const url = urls[i];
    const t0 = Date.now();
    const r = await extractPageInOnePass(url, { timeoutMs: 40_000 });
    const text = composeExtractionText(url, r);
    const verdict = await askModel(url, text);

    const visible = verdict?.visible ?? "UNKNOWN";
    const ok = visible === "YES";
    if (ok) pass++;
    else if (visible === "NO") fail++;
    else unknown++;

    const line =
      `| ${i} | ${url} | ${r.status} | ${ok ? "PASS" : visible === "NO" ? "FAIL" : "UNKNOWN"} | ` +
      `${(r.bodyText?.length ?? 0)} | ${verdict?.extractedSummary?.replace(/\|/g, "/") ?? ""} | ` +
      `${Math.round((Date.now() - t0) / 1000)}s |`;
    console.log(line);
    // Append to the report body (a table; the header was written above).
    appendFileSync(REPORT_FILE, line + "\n", "utf8");

    // Progress checkpoint every 100.
    if ((i - startIdx + 1) % 100 === 0) {
      console.log(`[10k-audit] ${i - startIdx + 1} done  pass=${pass} fail=${fail} unknown=${unknown}`);
    }
  }

  await closeBrowserPool();

  // Summary block at the end of the report.
  appendFileSync(
    REPORT_FILE,
    `\n\n## Summary\n\n- Pass: ${pass}\n- Fail: ${fail}\n- Unknown: ${unknown}\n- Total: ${pass + fail + unknown}\n`,
    "utf8",
  );
  console.log(`[10k-audit] done. pass=${pass} fail=${fail} unknown=${unknown} → ${REPORT_FILE}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
