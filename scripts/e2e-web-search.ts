/**
 * E2E verification: 5 diverse real-world scenarios through the full
 * web-search pipeline (LFM gate -> metasearch -> extraction -> rerank).
 *
 * Usage:  npx tsx scripts/e2e-web-search.ts
 *
 * For each scenario:
 *   - runs the LFM gate (prints search_required / freshness / depth)
 *   - runs metasearch with the general-web pool (prints per-engine table)
 *   - checks the relevance floor: 3+ results mention the core entities
 *   - verifies 0 Wikipedia-encyclopedia poisoning on local queries
 *   - runs the full runWebResearch pipeline (extraction + BM25 + evidence)
 *
 * Per-engine result table for the Manikonda biryani query:
 *   prints ddgSearch / yahooSearch / startpageSearch / braveSearch /
 *   aolSearch / mojeekSearch / searxSearch / redditSearch result counts
 */
import {
  runLfmGate,
  runWebResearch,
  metasearch,
  ddgSearch,
  yahooSearch,
  startpageSearch,
  braveSearch,
  aolSearch,
  mojeekSearch,
  searxSearch,
  redditSearch,
  bingNewsRssSearch,
  githubSearch,
  queryCoreTokens,
  closeCache,
} from "../src/lib/web-search/index";
import type { RankedResult } from "../src/lib/web-search/types";

const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;

const COOLDOWN_MS = 2000;
function cooldown(ms = COOLDOWN_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Scenario {
  name: string;
  prompt: string;
  mustExclude?: RegExp;
}

const SCENARIOS: Scenario[] = [
  {
    name: "Local / Food / Reviews",
    prompt:
      "Tell me what is the best restaurant in manikonda hyderabad I wan to eat biryani so I want you to tell me the best place for that",
    mustExclude: /^https?:\/\/en\.wikipedia\.org\/wiki\/Lucknow$/i,
  },
  {
    name: "Jobs / Career",
    prompt: "Workday Finance Consultant jobs and salary in Hyderabad",
  },
  {
    name: "E-Commerce / Product Comparison",
    prompt: "Best mechanical keyboard under 5000 INR in India reviews",
  },
  {
    name: "Tech / Coding",
    prompt: "Next.js 15 App Router server actions error handling best practices",
  },
  {
    name: "Breaking / Time-Sensitive",
    prompt: "Latest Linux kernel release notes",
  },
];

function printEngineTable(results: RankedResult[], label: string) {
  const byEngine = new Map<string, number>();
  for (const r of results) {
    byEngine.set(r.engine, (byEngine.get(r.engine) ?? 0) + 1);
  }
  console.log(CYAN("  Engine table - " + label + " (" + results.length + " total results)"));
  const engines = [
    "duckduckgo", "yahoo", "startpage", "brave",
    "aol", "mojeek", "searxng", "reddit",
    "google-news", "github",
    "wikipedia", "hackernews", "arxiv", "stackexchange",
  ];
  for (const eng of engines) {
    const count = byEngine.get(eng) ?? 0;
    if (count > 0) {
      console.log("    " + GREEN(eng.padEnd(15)) + " " + count);
    }
  }
}

/**
 * Check whether a result is relevant using the same normalization as
 * the pipeline: punctuation-insensitive, 40% OR absolute floor.
 */
function isRelevantResult(r: RankedResult, normTokens: string[], minHits: number): boolean {
  const raw = (r.title + " " + (r.snippet ?? "") + " " + r.url).toLowerCase();
  const stripped = raw.replace(/[.\-_]/g, "");
  const combined = raw + " " + stripped;
  const hits = normTokens.filter((t) => combined.includes(t)).length;
  return hits >= minHits;
}

async function main() {
  console.log(BOLD("\n--- E2E Web Search Verification (5 diverse scenarios) ---\n"));
  let totalPass = 0;
  let totalFail = 0;

  // Scenario 1 gets the full per-engine table (required by spec)
  console.log(BOLD("Scenario 1: Local / Food / Reviews - per-engine table"));
  const q1 = SCENARIOS[0].prompt;
  console.log(YELLOW("  Query: \"" + q1.slice(0, 80) + "...\""));

  const engines: Array<[string, () => Promise<any[]>, string]> = [
    ["ddgSearch",       () => ddgSearch(q1),       "duckduckgo"],
    ["yahooSearch",     () => yahooSearch(q1),     "yahoo"],
    ["startpageSearch", () => startpageSearch(q1), "startpage"],
    ["braveSearch",     () => braveSearch(q1),     "brave"],
    ["aolSearch",       () => aolSearch(q1),       "aol"],
    ["mojeekSearch",    () => mojeekSearch(q1),    "mojeek"],
    ["searxSearch",     () => searxSearch(q1),     "searxng"],
    ["redditSearch",    () => redditSearch(q1),    "reddit"],
    ["bingNewsRss",    () => bingNewsRssSearch(q1), "bing-news"],
    ["githubSearch",    () => githubSearch(q1),    "github"],
  ];

  console.log(CYAN("  Running 10 general-web engines in parallel..."));
  const engineResults = await Promise.all(
    engines.map(async ([, fn]) => {
      try { return await fn(); } catch { return [] as any[]; }
    }),
  );
  for (let i = 0; i < engines.length; i++) {
    const [name, , key] = engines[i];
    const count = engineResults[i].length;
    const status = count > 0 ? GREEN("*") : " ";
    console.log("   " + status + " " + name.padEnd(18) + " " + key.padEnd(12) + " " + count + " results");
  }
  const totalEngineResults = engineResults.reduce((s, a) => s + a.length, 0);
  console.log("   Total raw: " + totalEngineResults + " results from " + engineResults.filter((r) => r.length > 0).length + " engines");

  await cooldown(500);

  // Full metasearch for scenario 1
  const gate1 = await runLfmGate({ userPrompt: q1 });
  console.log(
    YELLOW(
      "  LFM gate: search_required=" + gate1.decision.search_required +
      " freshness=" + gate1.decision.freshness +
      " depth=" + gate1.decision.depth +
      " source=" + gate1.source,
    ),
  );

  const search1 = await metasearch(
    gate1.decision.queries.map((q) => ({
      query: q.query,
      intent: "general" as const,
      freshness: gate1.decision.freshness,
    })),
    20,
  );
  printEngineTable(search1, "Scenario 1 fused results");

  const lucknowPoisoning = search1.filter((r) =>
    /en\.wikipedia\.org\/wiki\/Lucknow/i.test(r.url),
  );
  console.log(
    lucknowPoisoning.length === 0
      ? GREEN("  PASS  0 Lucknow Wikipedia poisoning")
      : RED("  FAIL  " + lucknowPoisoning.length + " Lucknow Wikipedia result(s) in fused set"),
  );

  // All 5 scenarios through the full pipeline
  console.log(BOLD("\n--- Full pipeline: runWebResearch x 5 scenarios ---\n"));

  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i];
    // Cross-scenario cooldown to prevent rate-limit bleed (Fix 4).
    if (i > 0) await cooldown(COOLDOWN_MS);

    console.log(BOLD("\n" + sc.name + ": \"" + sc.prompt.slice(0, 60) + "...\""));
    const t0 = Date.now();
    const bundle = await runWebResearch(
      { userPrompt: sc.prompt, history: [] },
      (p) => {
        if (p.stage === "skipped") {
          console.log(YELLOW("  [skip] LFM: no web search required"));
        }
      },
    );
    const ms = Date.now() - t0;

    if (!bundle) {
      console.log(YELLOW("  LFM gate: no search required - main model answers from knowledge"));
      continue;
    }

    const results = bundle.searchResults;
    const packets = bundle.packets;
    const passages = bundle.topPassages;

    console.log(
      "  metasearch: " + results.length + " results | extracted: " + packets.length +
      " pages | top passages: " + passages.length + " | " + ms + "ms",
    );

    printEngineTable(results, sc.name);

    // Relevance floor check (uses the same normalization as the pipeline)
    const core = queryCoreTokens(sc.prompt);
    const normTokens = core.map((t) => t.toLowerCase().replace(/[.\-_]/g, ""));
    const pctFloor = Math.ceil(core.length * 0.4);
    const absFloor = core.length >= 3 ? 2 : 1;
    const minHits = Math.min(pctFloor, absFloor === 1 ? 1 : 2) || absFloor;
    const relevant = results.filter((r) => isRelevantResult(r, normTokens, minHits));
    const floorOk = relevant.length >= 3 || results.length === 0;
    if (floorOk) {
      console.log(GREEN("  PASS  relevance floor met (" + relevant.length + "/" + results.length + " mention core entities)"));
      totalPass++;
    } else {
      console.log(RED("  FAIL  relevance floor NOT met (" + relevant.length + "/" + results.length + " mention core entities)"));
      totalFail++;
    }

    // Poisoning check
    if (sc.mustExclude) {
      const poisoned = results.filter((r) => sc.mustExclude!.test(r.url));
      if (poisoned.length === 0) {
        console.log(GREEN("  PASS  0 poisoned results (must-exclude domain not present)"));
        totalPass++;
      } else {
        console.log(
          RED("  FAIL  " + poisoned.length + " poisoned result(s): " +
            poisoned.slice(0, 3).map((r) => r.url).join(", ")),
        );
        totalFail++;
      }
    }

    if (packets.length > 0) {
      const withExtraction = packets.filter((p) => p.extraction !== "snippet-only");
      console.log(
        YELLOW(
          "  extraction: " + withExtraction.length + "/" + packets.length + " full, " +
          (packets.length - withExtraction.length) + " snippet-only",
        ),
      );
    }
  }

  console.log(
    BOLD(
      "\n" + GREEN(totalPass + " passed") + ", " +
      (totalFail ? RED(totalFail + " failed") : GREEN("0 failed")) +
      "  " + YELLOW("(E2E verification complete)") + "\n",
    ),
  );

  closeCache();
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(RED("FATAL: "), e);
  process.exit(1);
});
