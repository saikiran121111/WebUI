/**
 * D-058 (F28) - the neural rerank stage in the TypeScript retrieval owner.
 *
 * These tests deliberately stub the stage or the ml-job transport: they prove
 * the DISPATCH MECHANICS and the honesty of the report (a skipped, refused,
 * unreachable or throwing ranker must never change the order and must never be
 * reported as if it ran). Real engine quality is measured elsewhere, with the
 * pinned asset and a frozen answer key - a stub proves mechanics, not quality.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/ml-job", () => ({
  mlJob: vi.fn(),
}));

import { mlJob } from "@/lib/server/ml-job";
import {
  applyNeuralOrder,
  rankCandidates,
  retrieveEvidence,
  retrieveEvidenceWithRerank,
  type RerankStage,
} from "@/lib/server/attachindex/retrieve";
import {
  RERANK_MAX_CAND_CHARS,
  RERANK_MODE,
  RERANK_NO_ROUTE_REASON,
  makeRerankStage,
  rerankEnabled,
  rerankWindow,
} from "@/lib/server/attachindex/rerank";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

const mlJobMock = mlJob as unknown as ReturnType<typeof vi.fn>;

function idx(texts: string[], timed = false) {
  const chunks: IndexChunk[] = texts.map((text, i) => ({
    i,
    startSec: timed ? i * 600 : null,
    endSec: timed ? (i + 1) * 600 : null,
    text,
    vec: [],
  }));
  const meta: IndexMeta = {
    attId: "att_rerank1",
    name: "fake",
    category: "text",
    createdAt: 0,
    chunkCount: chunks.length,
    spine: "",
    spineBlocks: [],
    frames: [],
  };
  return { meta, chunks } as never as Parameters<typeof retrieveEvidence>[0];
}

const ENVELOPE_READY = (scores: Array<{ chunk_id: string; score: number; rank: number }>) => ({
  state: "ready",
  capability: "rerank",
  job_id: "job-1",
  run_id: "run-1",
  request_id: "req-1",
  deadline_s: 60,
  source: "rust-ml-job",
  result: {
    job_id: "job-1",
    capability: "rerank",
    state: "ready",
    payload: {
      scores,
      mode_actually_used: RERANK_MODE,
      candidate_count: scores.length,
      returned: scores.length,
      quality_note: "joint cross-encoder scoring",
    },
  },
});

beforeEach(() => {
  mlJobMock.mockReset();
});

describe("the neural order actually changes the packed selection", () => {
  const corpus = idx(["widget equal", "widget equal", "widget equal", "widget equal", "widget equal"]);

  it("without a neural order the fused order picks the first two the budget fits", async () => {
    const base = retrieveEvidence(corpus, "widget", [], { mode: "exhaustive", budget: 28 });
    const ev = await retrieveEvidenceWithRerank(
      corpus,
      "widget",
      [],
      { mode: "exhaustive", budget: 28 },
      async () => ({ order: [{ idx: 4, score: 3 }, { idx: 3, score: 2 }] }),
      5,
    );
    expect(base.chunkIdxs).toEqual([0, 1]);
    expect(ev.chunkIdxs).toEqual([3, 4]);
    expect(ev.rerank.mode).toBe("neural");
    expect(ev.rerank.scored).toBe(2);
    expect(ev.rerank.changed).toBeGreaterThan(0);
    // Output order is still chronological - reordering priority never scrambles
    // the reading order the model sees.
    expect(ev.chunkIdxs).toEqual([...ev.chunkIdxs].sort((a, b) => a - b));
  });

  it("the reranker may not invent a candidate the retrieval never ranked", async () => {
    const seen = new Set<number>();
    const stage: RerankStage = async (_q, cands) => {
      cands.forEach(c => seen.add(c.idx));
      // An out-of-field id must be ignored, not smuggled into the pack.
      return { order: [{ idx: 99, score: 9 }, { idx: 4, score: 1 }] };
    };
    const ev = await retrieveEvidenceWithRerank(
      corpus,
      "widget",
      [],
      { mode: "exhaustive", budget: 28 },
      stage,
      5,
    );
    expect(seen.size).toBeLessThanOrEqual(5);
    expect(ev.chunkIdxs).not.toContain(99);
    expect(ev.rerank.scored).toBe(1);
    expect(ev.rerank.unscored).toBe(4);
  });
});

describe("every failure path keeps the fused order and says why", () => {
  const corpus = idx(["widget one", "widget two", "widget three"]);
  const opts = { mode: "exhaustive", budget: 40 } as const;

  it("a null stage is not_attempted and changes nothing", async () => {
    const base = retrieveEvidence(corpus, "widget", [], opts);
    const ev = await retrieveEvidenceWithRerank(corpus, "widget", [], opts, async () => null, 5);
    expect(ev.rerank.mode).toBe("not_attempted");
    expect(ev.rerank.reason).toContain("no neural reranker");
    expect(ev.text).toBe(base.text);
    expect(ev.chunkIdxs).toEqual(base.chunkIdxs);
    expect(ev.dropped).toBe(base.dropped);
  });

  it("a skipped stage reports its own reason", async () => {
    const ev = await retrieveEvidenceWithRerank(
      corpus,
      "widget",
      [],
      opts,
      async () => ({ order: [], skipped: true, reason: "ATTACH_RERANK=off for this run" }),
      5,
    );
    expect(ev.rerank.mode).toBe("not_attempted");
    expect(ev.rerank.reason).toBe("ATTACH_RERANK=off for this run");
  });

  it("a throwing stage is engine_failed, not an outage", async () => {
    const base = retrieveEvidence(corpus, "widget", [], opts);
    const ev = await retrieveEvidenceWithRerank(
      corpus,
      "widget",
      [],
      opts,
      async () => {
        throw new Error("worker vanished");
      },
      5,
    );
    expect(ev.rerank.mode).toBe("engine_failed");
    expect(ev.rerank.reason).toBe("worker vanished");
    expect(ev.text).toBe(base.text);
  });

  it("an empty order is engine_refused with the engine's reason", async () => {
    const ev = await retrieveEvidenceWithRerank(
      corpus,
      "widget",
      [],
      opts,
      async () => ({ order: [], reason: "model_unavailable: pinned asset missing" }),
      5,
    );
    expect(ev.rerank.mode).toBe("engine_refused");
    expect(ev.rerank.reason).toContain("pinned asset missing");
  });

  it("a structural selection (time range) is never handed to a ranker", async () => {
    const timed = idx(["alpha widget", "beta widget", "gamma widget"], true);
    let called = 0;
    const ev = await retrieveEvidenceWithRerank(
      timed,
      "widget",
      [],
      { mode: "time_range", fromSec: 0, toSec: 1800, budget: 200 },
      async () => {
        called += 1;
        return { order: [{ idx: 2, score: 5 }] };
      },
      5,
    );
    expect(called).toBe(0);
    expect(ev.rerank.mode).toBe("structural_selection");
    expect(ev.chunkIdxs).toEqual([0, 1, 2]);
  });
});

describe("applyNeuralOrder", () => {
  it("unscored candidates keep their own relative order, below the scored ones", () => {
    // Every chunk must be matchable by the query, or the fused field is empty
    // and there is nothing to reorder (an empty field is a different test).
    const corpus = idx(["widget a", "widget b", "widget c", "widget d", "widget e"]);
    const ranked = rankCandidates(corpus, "widget", [], { mode: "exhaustive" });
    expect(ranked.priority.size).toBe(5);
    const applied = applyNeuralOrder(ranked, [{ idx: 3, score: 1 }], 5);
    const order = [...applied.ranked.priority.entries()].sort((x, y) => y[1] - x[1]).map(([i]) => i);
    expect(order[0]).toBe(3);
    expect(order.slice(1)).toEqual([0, 1, 2, 4]);
  });

  it("an empty or non-finite order changes nothing", () => {
    const corpus = idx(["a", "b"]);
    const ranked = rankCandidates(corpus, "widget", [], { mode: "exhaustive" });
    const before = [...ranked.priority.entries()].sort((x, y) => y[1] - x[1]);
    const applied = applyNeuralOrder(ranked, [{ idx: 1, score: Number.NaN }], 2);
    expect([...applied.ranked.priority.entries()].sort((x, y) => y[1] - x[1])).toEqual(before);
    expect(applied.changed).toBe(0);
  });
});

describe("makeRerankStage speaks the worker contract", () => {
  it("maps chunk ids back to chunk indices and reports the engine's OWN name", async () => {
    mlJobMock.mockImplementation(async () =>
      ENVELOPE_READY([
        { chunk_id: "c1", score: 2.5, rank: 1 },
        { chunk_id: "c77", score: 99, rank: 2 },
        { chunk_id: "c0", score: -1.5, rank: 2 },
      ]),
    );
    const stage = makeRerankStage();
    const out = await stage("what colour", [
      { idx: 7, text: "the red one" },
      { idx: 9, text: "the blue one" },
    ]);
    expect(mlJobMock).toHaveBeenCalledTimes(1);
    const [capability, payload, jobOpts] = mlJobMock.mock.calls[0];
    expect(capability).toBe("rerank");
    expect(payload.mode).toBe(RERANK_MODE);
    expect(payload.top_k).toBe(2);
    expect(payload.chunks.map((c: { chunk_id: string }) => c.chunk_id)).toEqual(["c0", "c1"]);
    // An id the caller never sent must not become a scored candidate.
    expect(out?.order.every(c => c.idx === 7 || c.idx === 9)).toBe(true);
    expect(jobOpts.deadlineMs).toBeGreaterThan(0);
    expect(out?.engine).toBe(RERANK_MODE);
    expect(out?.order).toEqual([
      { idx: 9, score: 2.5 },
      { idx: 7, score: -1.5 },
    ]);
    expect(out?.note).toContain("joint cross-encoder scoring");
  });

  it("a lexical answer to a cross-encoder request is REPORTED, not relabelled", async () => {
    mlJobMock.mockResolvedValue(ENVELOPE_READY([{ chunk_id: "c0", score: 1, rank: 1 }]));
    const stage = makeRerankStage();
    mlJobMock.mockClear();
    mlJobMock.mockResolvedValue({
      state: "ready",
      capability: "rerank",
      job_id: "j",
      run_id: "r",
      request_id: "q",
      deadline_s: 60,
      source: "rust-ml-job",
      result: {
        payload: {
          scores: [{ chunk_id: "c0", score: 4, rank: 1 }],
          mode_actually_used: "lexical",
          candidate_count: 2,
          returned: 1,
          quality_note: "lexical BM25 baseline reordering only",
        },
      },
    });
    const out = await stage("q", [
      { idx: 1, text: "a" },
      { idx: 2, text: "b" },
    ]);
    expect(out?.engine).toBe("lexical");
    expect(out?.note).toContain(`asked for ${RERANK_MODE}, the engine reported it ran lexical`);
    expect(out?.note).toContain("returned 1 of 2");
  });

  it("no capability route is a configuration fact, reported and skipped", async () => {
    mlJobMock.mockResolvedValue(null);
    const out = await makeRerankStage()("q", [
      { idx: 1, text: "a" },
      { idx: 2, text: "b" },
    ]);
    expect(out?.order).toEqual([]);
    expect(out?.skipped).toBe(true);
    // D-068: this reason is part of the attachment wire contract now. The Rust turn
    // owner emits the same sentence (crates/ruke-attach/src/turn.rs::NO_RERANK_ROUTE)
    // and the recorded golden fixtures carry it, so the test pins the shared constant
    // rather than a substring of the old deployment-specific wording. The OLD
    // assertion was the last thing still demanding that retired wording, which is why
    // it survived until a full vitest pass after the golden re-record.
    expect(out?.reason).toBe(RERANK_NO_ROUTE_REASON);
    expect(out?.reason).toContain("no neural rerank route");
  });

  it("a typed capability failure becomes the reason, not a silent success", async () => {
    mlJobMock.mockResolvedValue({
      state: "unavailable",
      capability: "rerank",
      job_id: "j",
      run_id: "r",
      request_id: "q",
      deadline_s: 60,
      source: "rust-ml-job",
      error: {
        reason: "model_unavailable",
        message: "the pinned cross-encoder asset is not prepared",
        retryable: false,
        capability: "rerank",
        human_step: "prepare the pinned asset",
      },
    });
    const out = await makeRerankStage()("q", [
      { idx: 1, text: "a" },
      { idx: 2, text: "b" },
    ]);
    expect(out?.order).toEqual([]);
    expect(out?.skipped).toBe(true);
    expect(out?.reason).toContain("model_unavailable");
  });

  it("a ready envelope with no usable scores is refused, never faked", async () => {
    mlJobMock.mockResolvedValue({
      state: "ready",
      capability: "rerank",
      job_id: "j",
      run_id: "r",
      request_id: "q",
      deadline_s: 60,
      source: "rust-ml-job",
      result: { payload: { scores: [{ chunk_id: "nope", score: 1 }] } },
    });
    const out = await makeRerankStage()("q", [
      { idx: 1, text: "a" },
      { idx: 2, text: "b" },
    ]);
    expect(out?.order).toEqual([]);
    expect(out?.skipped).toBeUndefined();
    expect(out?.reason).toContain("no usable score list");
  });

  it("candidate text is cut to the payload bound and that is REPORTED", async () => {
    mlJobMock.mockResolvedValue(ENVELOPE_READY([{ chunk_id: "c0", score: 1, rank: 1 }]));
    const long = "x".repeat(RERANK_MAX_CAND_CHARS + 500);
    const out = await makeRerankStage()("q", [
      { idx: 1, text: long },
      { idx: 2, text: "short" },
    ]);
    const sent = mlJobMock.mock.calls[0][1].chunks[0].text as string;
    expect(sent.length).toBe(RERANK_MAX_CAND_CHARS);
    expect(out?.note).toContain(`cut to ${RERANK_MAX_CAND_CHARS} characters`);
  });

  it("config knobs: window bound and the off switch", () => {
    delete process.env.ATTACH_RERANK_CANDIDATES;
    expect(rerankWindow()).toBe(24);
    process.env.ATTACH_RERANK_CANDIDATES = "500";
    expect(rerankWindow()).toBe(64);
    process.env.ATTACH_RERANK = "off";
    expect(rerankEnabled()).toBe(false);
    delete process.env.ATTACH_RERANK;
    delete process.env.ATTACH_RERANK_CANDIDATES;
    expect(rerankEnabled()).toBe(true);
  });

  it("a full turn-level retrieval with a working stub stage still reports the honest ranker line", async () => {
    const corpus = idx(["widget one", "widget two", "widget three", "widget four"]);
    mlJobMock.mockResolvedValue(
      ENVELOPE_READY([
        { chunk_id: "c3", score: 3, rank: 1 },
        { chunk_id: "c1", score: 2, rank: 2 },
        { chunk_id: "c0", score: 1, rank: 3 },
      ]),
    );
    const ev = await retrieveEvidenceWithRerank(
      corpus,
      "widget",
      [],
      { mode: "exhaustive", budget: 40 },
      makeRerankStage(),
      rerankWindow(),
    );
    expect(ev.rerank.engine).toBe(RERANK_MODE);
    expect(ev.rerank.mode).toBe("neural");
    expect(ev.vectorMode).toBe("lexical_only");
    expect(ev.chunkIdxs[0]).toBeLessThan(4);
  });
});
