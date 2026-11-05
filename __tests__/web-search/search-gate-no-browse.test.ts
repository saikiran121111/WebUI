/**
 * WS02 (audit 2026-11-05, repair item 2 — "explicit no-network before
 * acquisition").  An EXPLICIT no-network instruction is parsed with its
 * instruction + polarity structure and honored BEFORE any acquisition:
 * prohibition + volatile question stays force-NO, the boundary-acknowledgment
 * tail ("state that you cannot verify it") is a CONSEQUENCE of the
 * prohibition — never an affirmative web frame — and quoted live-sounding
 * content is content, never an instruction.
 *
 * Mirrors the independent audit fixtures (audit-regate-decision-matrix /
 * audit-regate-policy-boundaries arms no-web-current-price, no-web-volatile,
 * no-web-url and the three policy-boundary prompts).  Deterministic verdicts
 * come from deterministicHardBypass — the same Stage-0 front door
 * runSearchGate consults BEFORE the model — so a non-null NO here
 * structurally proves zero gate-LLM calls and zero acquisition.  The
 * acquisition half is pinned directly: runWebResearch returns a NULL bundle
 * on a no-browse turn, and the web tool loop (route.ts ⇔ Rust web_loop.rs)
 * arms only when a bundle/depth exists — no bundle, no provider/page/render
 * tool on the turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deterministicHardBypass,
  runSearchGate,
} from "@/lib/web-search/search-gate";
import { runWebResearch } from "@/lib/web-search/pipeline";
import type { SearchGateContext } from "@/lib/web-search/types";

const ctx = (userPrompt: string): SearchGateContext => ({ userPrompt });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("explicit no-network instruction dominates the evidence boundary (WS02)", () => {
  it("prohibition + volatile question force-NOs with zero queries", () => {
    for (const prompt of [
      // Prohibition first, live ask second, boundary-acknowledgment tail —
      // the tail states the CONSEQUENCE of honoring the prohibition; it is
      // never an acquisition frame.
      "Do not browse. What is the current milk price? State if you cannot verify it.",
      "Do not search the web. Explain the concept of current price from memory.",
      // URL literal in the instruction does NOT re-arm: the user forbade
      // acquisition, and character counting is a local transform of the
      // literal itself.
      "Do not search the web. Count the characters in https://example.com.",
      "Do not browse. What is the latest version of Node.js? State that you cannot verify it.",
      "Do not search the web. What is the weather in Hyderabad now?",
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("local_task");
      expect(r!.decision.search_required, prompt).toBe(false);
      expect(r!.decision.reason, prompt).toBe("deterministic_self_contained");
      expect(r!.decision.queries, prompt).toEqual([]);
    }
  });

  it("quoted live-sounding text is content, never an instruction", () => {
    for (const prompt of [
      'Translate "What is the current weather?" into Hindi.',
      "Translate “What is the current weather?” into Hindi.",
      'Explain the phrase "current weather" into Hindi.',
      'Translate “What is the current price of milk?” into French.',
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      // Never force-YES on the quoted content: either undecided (model
      // gate decides) or a deterministic NO — never a search verdict.
      if (r) expect(r.decision.search_required, prompt).toBe(false);
    }
  });

  it("the NO survives the full gate with the model unreachable — and calls no fetch", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network is forbidden on a no-browse turn")));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
    vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");
    for (const prompt of [
      "Do not browse. What is the current milk price? State if you cannot verify it.",
      "Do not browse. What is the latest version of Node.js? State that you cannot verify it.",
      "Do not search the web. What is the weather in Hyderabad now?",
    ]) {
      const r = await runSearchGate(ctx(prompt));
      expect(r.decision.search_required, prompt).toBe(false);
      expect(r.decision.queries, prompt).toEqual([]);
    }
    // Deterministic NO is decided BEFORE the model: the gate never even
    // attempted the LLM call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a no-browse turn acquires nothing: runWebResearch returns a null bundle", async () => {
    // No bundle ⇔ no depth ⇔ route.ts / Rust web_loop.rs never arm the
    // web_search / read_page tool loop for the turn.
    for (const prompt of [
      "Do not browse. What is the current milk price? State if you cannot verify it.",
      "Do not search the web. Count the characters in https://example.com.",
    ]) {
      const bundle = await runWebResearch(ctx(prompt));
      expect(bundle, prompt).toBeNull();
    }
  });
});

describe("the prohibition never swallows an affirmative web frame elsewhere (positive controls)", () => {
  it("an unrelated local prohibition keeps the surviving search frame force-YES", () => {
    for (const prompt of [
      "Do not change the wording. Search the web for current salary benchmarks.",
      "Translate this paragraph; check the web for slang usage.",
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("web_intent");
      expect(r!.decision.search_required, prompt).toBe(true);
    }
  });

  it("the no-browse law never suppresses an unprefaced live ask", () => {
    const r = deterministicHardBypass(ctx("Find open backend engineering jobs in Hyderabad."));
    expect(r).not.toBeNull();
    expect(r!.decision.search_required).toBe(true);
  });
});
