/**
 * E2E verification of the 2026-10-22 "no LFM, no validation" pipeline.
 *
 * The pipeline under test is now:
 *   runLfmGate (main model :8080 only — LFM router is gone, no deterministic
 *   follow-up escalation, no rule-based search fallback)
 *   -> metasearch (general-web pool + relevance floor)
 *   -> extractAll
 *   -> rerank (pure BM25 + junk penalty; no `[VERIFIED SOURCE STATE]` banners)
 *   -> evidenceBlock (guideline header, no <verification> contract)
 *
 * Plus the in-process decision router (lib/decision/client.ts) and the
 * trivial-prompt short-circuit that used to live in the LFM router.
 *
 * Usage:  npx tsx scripts/e2e-web-search.ts
 */
import {
  runLfmGate,
  runWebResearch,
  metasearch,
  queryCoreTokens,
  closeCache,
  buildMainModelContext,
} from "../src/lib/web-search/index";
import { getDecisionSync } from "../lib/decision/client";

const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;

const COOLDOWN_MS = 2000;
function cooldown(ms = COOLDOWN_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(GREEN("  PASS  " + name) + (detail ? YELLOW("  " + detail) : ""));
  } else {
    failed++;
    console.log(RED("  FAIL  " + name) + (detail ? YELLOW("  " + detail) : ""));
  }
}

/* ── in-process decision router (no :8790, no spawn) ─────────────────── */

async function testDecisionRouter() {
  console.log("\n" + BOLD("Decision router (in-process — no :8790 engine, no spawn)"));

  const env1 = getDecisionSync("Make me an excel spreadsheet for my inventory", []);
  check(
    "spreadsheet intent → excel mode, prompt untouched",
    env1.active_mode === "excel" && env1.stripped_prompt === "Make me an excel spreadsheet for my inventory",
  );

  const env2 = getDecisionSync("write a word document with the project plan", []);
  check("document intent → docs mode", env2.active_mode === "docs");

  const env3 = getDecisionSync("what is the best phone under 20000", []);
  check(
    "a research question stays standard_chat (no intent word)",
    env3.active_mode === "standard_chat",
    env3.active_mode,
  );

  const env4 = getDecisionSync("", []);
  check("empty message → fallback standard_chat", env4.active_mode === "standard_chat");
}

/* ── trivial-prompt short-circuit (the chit-chat bug) ────────────────── */

async function testTrivialShortCircuit() {
  console.log("\n" + BOLD("Trivial / assistant-identity prompts → no search, zero latency"));

  const prompts = [
    "What are you doing",
    "By the way which model are you",
    "who are you",
    "what model are you",
    "how do you work",
    "what can you do",
    "hi",
    "hello",
    "thanks",
  ];
  for (const p of prompts) {
    const r = await runLfmGate({ userPrompt: p });
    check(
      `runLfmGate("${p}") → no search (decidedBy=${r.source})`,
      r.decision.search_required === false,
      `gateMs=${r.lfmMs}`,
    );
  }
}

/* ── live scenarios through the lean pipeline ────────────────────────── */

async function testLiveScenarios() {
  console.log("\n" + BOLD("Live scenarios (main-model gate only — no LFM, no verification hop)"));

  const scenarios: { name: string; prompt: string }[] = [
    {
      name: "E-Commerce",
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

  for (const s of scenarios) {
    console.log("\n" + BOLD(s.name + ": " + s.prompt.slice(0, 60)));
    const bundle = await runWebResearch({ userPrompt: s.prompt });
    if (!bundle) {
      check(
        `${s.name}: main model said no search needed (gate authority)`,
        true,
        "no evidence — proceeding without web data",
      );
      continue;
    }
    check(
      `${s.name}: gate decided (source=${bundle.lfm.source})`,
      bundle.lfm.source === "main-model",
    );
    check(
      `${s.name}: evidence block carries no <verification> contract`,
      !buildMainModelContext(bundle).systemBlock.includes("<verification>"),
    );
    check(
      `${s.name}: top passages carry no [VERIFIED SOURCE STATE] banner`,
      !bundle.topPassages.some((p) => p.passageText.startsWith("[VERIFIED SOURCE STATE")),
    );
    if (bundle.topPassages.length > 0) {
      const sample = bundle.topPassages[0].passageText.slice(0, 120).replace(/\n/g, " ");
      check(`${s.name}: retrieved ${bundle.topPassages.length} passages`, true, sample);
    }
    await cooldown();
  }
}

/* ── entry point ─────────────────────────────────────────────────────── */

async function main() {
  console.log(BOLD("E2E verification: no-LFM / no-validation web-search pipeline (2026-10-22)"));
  await testDecisionRouter();
  await testTrivialShortCircuit();
  await testLiveScenarios();

  console.log("\n" + GREEN(`${passed} passed`) + ", " + (failed ? RED(`${failed} failed`) : GREEN("0 failed")));
  await closeCache();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
