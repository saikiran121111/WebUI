/**
 * APPROVED PART-10 PARITY DEVIATION — UNIVERSAL deterministic search
 * pre-gate + runtime date-aware freshness awareness.
 * Mirrors the Rust unit tests in ruke-websearch/src/search_gate.rs
 * (bypass_freshness_forces_search / bypass_local_task_forces_no_search /
 *  bypass_local_task_escapes_on_external_intent /
 *  ambiguous_prompts_reach_the_model_gate / gate_messages_carry_the_current_date /
 *  universal_pre_gate_never_calls_the_llm) — identical prompt matrices,
 *  identical expected labels, reasons and query-shape guarantees.
 *
 * Three layers, NO attachment required (that is the universal part):
 *   FORCE_SEARCH — high-confidence freshness / time-sensitive shapes the
 *     model gate must never be allowed to veto;
 *   FORCE_SKIP — explicitly local-only turns and obviously self-contained
 *     tasks (supplied-content transforms, prompt-defined code-gen, pure
 *     math), deterministically answered with ZERO queries — an operational
 *     instruction can never become an engine query;
 *   UNDECIDED — the gray middle falls through to the (now date-aware)
 *     main-model gate.
 * All deterministic verdicts are proven LLM-free by construction: they
 * come from deterministicHardBypass — the same Stage-0 front door
 * runSearchGate consults BEFORE trivial/mainModelGate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMainGateMessagesForTest,
  deterministicHardBypass,
  runSearchGate,
} from "@/lib/web-search/search-gate";
import type { SearchGateContext } from "@/lib/web-search/types";

const ctx = (userPrompt: string): SearchGateContext => ({ userPrompt });

describe("universal freshness force-SEARCH (approved Part-10 deviation)", () => {
  it("staleness-shaped prompts search deterministically, never reach a model veto", () => {
    for (const prompt of [
      "Who is the CEO of Acme Corp?",
      "How much does the RTX 5090 cost?",
      "Is React 18 still maintained?",
      "What's the weather tonight?",
      "Update me on the most recent funding round.",
      "Is this package up to date?",
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("freshness");
      expect(r!.decision.search_required, prompt).toBe(true);
      expect(r!.decision.reason).toBe("deterministic_url_or_intent");
      // Force-YES flows into the shared keyword planner — queries exist.
      expect(r!.decision.queries.length, prompt).toBeGreaterThan(0);
    }
    // Freshness outranks the skip layers even in a task-shaped prompt
    // ("write a script" would otherwise code-gen-skip).
    const r = deterministicHardBypass(ctx("Write a script that reports the most recent release."));
    expect(r).not.toBeNull();
    expect(r!.hit.matched).toBe("freshness");
    expect(r!.decision.search_required).toBe(true);
  });
});

describe("universal local-task force-SKIP (approved Part-10 deviation)", () => {
  it("self-contained tasks skip deterministically with zero queries", () => {
    for (const prompt of [
      "Write Python code for binary search.",
      "Explain this supplied stack trace.",
      "Summarize this supplied text.",
      "Read this attachment and reply YES.",
      "Translate this paragraph.",
      "What is 15 * 17?",
      "Solve 25 * 47",
      "Create a regex for this pattern.",
      "Fix this code.",
      "Review this uploaded source file.",
      "Refactor this function.",
      "Do not search the web; answer from the pasted code only.",
      "What's wrong with this regex?",
      "Find the bug in this attached log.",
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("local_task");
      expect(r!.decision.search_required, prompt).toBe(false);
      expect(r!.decision.reason).toBe("deterministic_self_contained");
      expect(r!.decision.queries, prompt).toEqual([]);
    }
  });

  it("the escape hatch returns self-contained shapes to the model gate", () => {
    // Layer E2 is guarded by EXPLICIT_WEB_INTENT_RE like the attachment
    // rule: a self-contained shape that ALSO signals live-web intent
    // falls through to the model.
    expect(
      deterministicHardBypass(ctx("Translate this paragraph; check the web for slang usage.")),
    ).toBeNull();
    expect(
      deterministicHardBypass(ctx("Summarize this text and browse online sources.")),
    ).toBeNull();
    // Layer E1 (explicit local-only intent) deliberately has NO escape —
    // the phrase list contains "web" itself, so an escape test would
    // self-cancel the user's explicit instruction.
    const r = deterministicHardBypass(ctx("Don't browse; only from the attached document."));
    expect(r).not.toBeNull();
    expect(r!.hit.matched).toBe("local_task");
    expect(r!.decision.search_required).toBe(false);
  });
});

describe("the gray middle still belongs to the model gate", () => {
  it("ambiguous prompts abstain from every deterministic layer", () => {
    for (const prompt of [
      "Tell me about Rust async performance.",
      "Is PostgreSQL better than MongoDB for this architecture?",
      "Why does this GPU sometimes disappear?",
      "Explain recursion.",
      "What are some good books about systems thinking?",
    ]) {
      expect(deterministicHardBypass(ctx(prompt)), prompt).toBeNull();
    }
  });
});

describe("gate messages carry the runtime date (never hardcoded)", () => {
  it("an injected date makes the gate prompt date-dynamic", () => {
    const m = buildMainGateMessagesForTest({
      ...ctx("is python 2 still supported?"),
      currentDate: "2030-06-15",
    })[0];
    expect(m.content.startsWith("Current date: 2030-06-15 (year 2030).")).toBe(true);
    expect(m.content).toContain("parametric knowledge may be STALE");
  });

  it("unset date falls back to the REAL clock, never a frozen constant", () => {
    // Shape-only assertion so the suite never couples to the wall clock.
    const m = buildMainGateMessagesForTest(ctx("hello"))[0];
    expect(m.content).toMatch(/^Current date: \d{4}-\d{2}-\d{2} \(year \d{4}\)\./);
    expect(m.content).not.toContain("2030-06-15");
  });
});

describe("the universal pre-gate never calls the LLM", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("force-YES and force-SKIP both short-circuit before any model touch", async () => {
    // WEB_SEARCH_LLM_ENDPOINT points at an UNROUTABLE port: any model
    // touch would fall back to rulesBasedPlan (source=rules,
    // search_required=true, gateMs>0). source=deterministic + gateMs 0
    // proves ZERO gate-model calls in BOTH universal directions.
    vi.stubEnv("WEB_SEARCH_LLM_ENDPOINT", "http://127.0.0.1:9/chat/completions");
    vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
    vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");

    const yes = await runSearchGate(ctx("Who is the CEO of Acme Corp?"));
    expect(yes.source).toBe("deterministic");
    expect(yes.decision.search_required).toBe(true);
    expect(yes.decision.queries.length).toBeGreaterThan(0);
    expect(yes.gateMs).toBe(0);

    const no = await runSearchGate(ctx("Write Python code for binary search."));
    expect(no.source).toBe("deterministic");
    expect(no.decision.search_required).toBe(false);
    expect(no.decision.queries).toEqual([]);
    expect(no.gateMs).toBe(0);
  });
});
