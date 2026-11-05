/**
 * AUDIT 2026-11-05 (brief item 16 / WS16) — cancellation does not settle
 * the initial direct-target wait promptly.
 *
 * Audit repro (verbatim): "Controlled fake-timer reproduction. Aborting
 * while the direct-target extractor is pending leaves research waiting. A
 * wall-clock deadline exists now, so this is not an infinite-wait claim.
 * Cause: directFut/directDeadline races the deadline/completion but not
 * the combined abort signal. Its extractor call does not receive that
 * signal." Fix (verbatim): "Fix cancellation propagation and settlement
 * through direct reads, provider calls, render acquisition and queued
 * work. Do not leave abandoned work occupying inference/browser/network
 * capacity or writing late state."
 *
 * Hermetic pipeline-level repro on the research-depth-pipeline.test.ts
 * harness shape (gate/cache/planner/metasearch/extractor mocked wholesale
 * — zero engine/reader/browser/model traffic possible): a prompt-URL turn
 * enters the Stage-0 direct hop; the direct extractor promise stays
 * PENDING; the caller aborts; the whole research call must settle
 * PROMPTLY — fake-timer advance stays far below DIRECT_TARGET_CAP_MS
 * (90_000) and PIPELINE_CEILING_MS (240_000), so only honoring the abort
 * can settle it.
 *
 * Pins (universal cancellation law — no brand/site rules):
 *  - SETTLEMENT: abort while the direct read is pending resolves the
 *    pipeline promptly (the defect: the direct wait races only its cap);
 *  - PROPAGATION: the direct-target extractUrl call receives the
 *    combined cancellation signal (and sees aborted=true after abort);
 *  - NO LATE STATE: cancelled research never writes the query cache;
 *  - QUEUED WORK: an aborted turn fires no broad-recovery metasearch,
 *    no gap waves and no extraction waves (no abandoned work occupying
 *    provider/network capacity).
 * Transport- and extractor-level propagation pins live in
 * net-cancellation.test.ts and extractor-cancellation.test.ts.
 */
import { beforeEach, describe, expect, it, afterEach, vi } from "vitest";

import { runWebResearch } from "@/lib/web-search/pipeline";

const m = vi.hoisted(() => ({
  runSearchGate: vi.fn(),
  metasearch: vi.fn(),
  metasearchWithFreshnessRecovery: vi.fn(),
  countLexicallyRelevant: vi.fn(),
  extractUrl: vi.fn(),
  extractAll: vi.fn(),
  getCachedQuery: vi.fn(),
  putCachedQuery: vi.fn(),
  planQueries: vi.fn(),
}));

vi.mock("@/lib/web-search/search-gate", () => ({
  runSearchGate: m.runSearchGate,
}));
vi.mock("@/lib/web-search/cache", () => ({
  getCachedQuery: m.getCachedQuery,
  putCachedQuery: m.putCachedQuery,
}));
vi.mock("@/lib/web-search/query-planner", async (o) => ({
  ...(await o<any>()),
  planQueries: m.planQueries,
}));
vi.mock("@/lib/web-search/metasearch", async (o) => ({
  ...(await o<any>()),
  metasearch: m.metasearch,
  metasearchWithFreshnessRecovery: m.metasearchWithFreshnessRecovery,
  countLexicallyRelevant: m.countLexicallyRelevant,
}));
vi.mock("@/lib/web-search/extractor", () => ({
  extractUrl: m.extractUrl,
  extractAll: m.extractAll,
  renumberPackets: (ps: any[], n = 1) => {
    for (const p of ps) {
      p.sourceId = "S" + n++;
      for (const x of p.passages) x.sourceId = p.sourceId;
    }
  },
  nextSourceIndex: (ps: any[]) => ps.length + 1,
  baselinePacketsFor: () => [],
}));

/** Prompt with a literal URL ⇒ detectUrlsAndDomains seeds the Stage-0
 *  direct-target hop with exactly one target. */
const PROMPT = "https://portfolio.example/a what is on this page?";

function serpRow(domain: string) {
  return {
    url: "https://" + domain + "/page",
    canonical: "https://" + domain + "/page",
    title: "portfolio page",
    snippet: "portfolio of the example site",
    domain,
    engine: "fixture",
    rrf: 1,
    engines: ["fixture"],
    engineRanks: { fixture: 1 },
    origin: "search",
  } as any;
}

beforeEach(() => {
  m.runSearchGate.mockReset();
  m.runSearchGate.mockResolvedValue({
    source: "rules",
    gateMs: 0,
    decision: {
      search_required: true,
      reason: "controlled lookup",
      depth: "standard",
      freshness: "any",
      queries: [{ query: "portfolio example page", intent: "general" }],
    },
  });
  m.planQueries.mockReset();
  m.planQueries.mockReturnValue([
    { query: "portfolio example page", intent: "general", origin: "semantic" },
  ]);
  m.getCachedQuery.mockReset();
  m.getCachedQuery.mockReturnValue(null);
  m.putCachedQuery.mockReset();
  m.metasearch.mockReset();
  m.metasearch.mockResolvedValue([]);
  m.metasearchWithFreshnessRecovery.mockReset();
  m.metasearchWithFreshnessRecovery.mockResolvedValue({
    results: [serpRow("serp.example")],
    freshnessRecoveryUsed: false,
  });
  m.countLexicallyRelevant.mockReset();
  m.countLexicallyRelevant.mockReturnValue(100);
  m.extractUrl.mockReset();
  // THE DEFECT SEED: the direct-target extractor PENDING forever — the
  // only thing that may settle the wait after an abort is the abort
  // itself (the 90s cap fake time never reaches).
  m.extractUrl.mockReturnValue(new Promise(() => {}));
  m.extractAll.mockReset();
  m.extractAll.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Start research WITHOUT awaiting; drain to the direct hop; abort;
 *  advance (still far below both caps); report whether it settled. */
async function runThenAbort(abortAfterDrainMs = 50, advanceAfterAbortMs = 5_000) {
  vi.useFakeTimers();
  const ac = new AbortController();
  const state = { settled: false, outcome: "PENDING" as any, threw: false };
  const p = runWebResearch({ userPrompt: PROMPT } as any, undefined, ac.signal);
  p.then(
    (b) => {
      state.settled = true;
      state.outcome = b;
    },
    () => {
      state.settled = true;
      state.threw = true;
    },
  );
  // Let the preamble (gate → planning → direct-hop launch) run to the
  // pending extractor await. All fake-time advances here are microtask
  // drains; no real 90s/240s timer is ever reached.
  await vi.advanceTimersByTimeAsync(abortAfterDrainMs);
  ac.abort();
  await vi.advanceTimersByTimeAsync(advanceAfterAbortMs); // ≪ 90_000 cap
  return state;
}

describe("WS16 — abort settles the Stage-0 direct-target wait", () => {
  it("aborting while the direct-target extractor is pending settles research promptly", async () => {
    const state = await runThenAbort();
    // Precondition: the repro actually reached the direct hop with the
    // extractor still pending (a vacuous fixture would settle instantly
    // for the wrong reason).
    expect(m.extractUrl, "the Stage-0 direct hop must have started").toHaveBeenCalledTimes(1);
    // THE DEFECT: directDeadline races only the 90s cap + directFut — an
    // abort while the extractor is pending leaves research WAITING.
    expect(
      state.settled,
      "aborted research must settle without waiting for the 90s direct-target cap — the direct wait ignores the combined abort signal",
    ).toBe(true);
    expect(state.threw, "cancellation settles as a result, never a rejection").toBe(false);
  });

  it("the direct-target extractor call receives the cancellation signal", async () => {
    const state = await runThenAbort();
    expect(state.settled, "settlement must precede propagation (same law, sequenced)").toBe(true);
    const call = m.extractUrl.mock.calls[0] as any[];
    const sig = call[4];
    expect(
      sig instanceof AbortSignal,
      "extractUrl's direct read must be handed the pipeline's cancellation signal (propagation into direct reads)",
    ).toBe(true);
    expect(sig.aborted, "the handed signal is the combined one — aborted after abort()").toBe(true);
  });

  it("cancelled research never writes the query cache with late state", async () => {
    const state = await runThenAbort();
    expect(state.settled).toBe(true);
    // "Do not leave abandoned work ... writing late state": the SERP leg
    // resolving around the abort must not land a cache write for a turn
    // nobody will use.
    expect(
      m.putCachedQuery,
      "the post-first-hop query-cache write must be skipped once the turn is cancelled",
    ).not.toHaveBeenCalled();
  });

  it("an aborted turn fires no broad recovery, gap waves or extraction waves", async () => {
    const state = await runThenAbort();
    expect(state.settled).toBe(true);
    // Queued work law: post-cancel provider calls (broad relevance
    // recovery, gap waves) and extraction waves must never fire — no
    // abandoned work occupying inference/browser/network capacity.
    expect(
      m.metasearch,
      "broad-recovery / gap-wave metasearch must not fire after cancellation",
    ).not.toHaveBeenCalled();
    expect(
      m.extractAll,
      "extraction waves must not fire after cancellation",
    ).not.toHaveBeenCalled();
  });
});
