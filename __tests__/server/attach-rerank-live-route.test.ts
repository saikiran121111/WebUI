/**
 * F66 - the neural rerank route EXECUTED for real, end to end (D-058 caller +
 * D-072 status correction + the F29 acceptance gap).
 *
 * The mocked suite (attach-rerank-neural.test.ts) proves the dispatch mechanics;
 * D-072 recorded that the TS caller was "production-wired but only ever mocked",
 * and F29's live evidence (f29-rerank-live-2.json) hit the supervisor DIRECTLY -
 * the Rust `POST /api/ruke/ml/job` route as the production caller reaches it was
 * never the probed path. This file closes exactly that: makeRerankStage +
 * retrieveEvidenceWithRerank (the same composition turn.ts runs) over the real
 * mlJob transport to a real ruke-server, which dispatches to a real supervisor
 * that spawns the real pinned MiniLM cross-encoder worker.
 *
 * GATING: runs ONLY when RUKE_LIVE_RERANK=1 is set alongside the backend
 * handoff vars (RUKE_RUST_BACKEND=1, RUKE_BACKEND_PORT) that the harness starts
 * the scoped topology with. Every ordinary vitest run SKIPS this file, so the
 * standing gates and their thresholds are untouched - same opt-in class as the
 * sanctioned re-record flags, not a relaxed acceptance bar.
 *
 * KEPT FAILURE (characterization, never weakened): the numeric-fact case from
 * g04/g05 - "how many crates arrived at the depot on Tuesday" - ranks the WRONG
 * number first for every engine (cross_encoder_rank=2, registry
 * `numeric_fact_case_fixed: False`, SPEC 23.3 "Numeric-fact misses stay recorded
 * as failures"). The test below asserts that this is STILL true through the live
 * route. If the engine one day ranks it correctly this test FAILS on purpose:
 * flipping it means the honest reporting (registry, DECISION-OWNERSHIP,
 * FINAL-REPORT "two numeric-fact misses") must be updated in the same change,
 * never silently.
 *
 * F75 ADDENDUM: the brief's "numeric-fact failures on UNSEEN examples" is
 * covered by the unseen pair authored below (new domain, numbers authored at
 * F75, used nowhere else). It characterizes the MECHANISM, not just the frozen
 * instance: two candidates identical except their number score within ~1e-06
 * of each other in the pinned engine's probabilities (measured at F75: margin
 * 2.98e-06), so the retrieval stage has no honest grounds to arbitrate - its
 * contract is to score both, keep both, and let the answer stage face the
 * conflict.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { mlJob, resetMlJobNegativeCache } from "@/lib/server/ml-job";
import { rustEnabled } from "@/lib/server/rustProxy";
import { retrieveEvidence, retrieveEvidenceWithRerank } from "@/lib/server/attachindex/retrieve";
import { RERANK_MODE, makeRerankStage, rerankWindow } from "@/lib/server/attachindex/rerank";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

const LIVE = process.env.RUKE_LIVE_RERANK === "1";

// The same four passages and expectation the frozen g05 set authored BEFORE any
// engine ran (EVAL[0]) and the g06 route probe reused: passage 1 ("99 crates")
// is the truth; the engines keep ranking passage 0 ("61 crates") first.
const QUERY = "How many crates arrived at the depot on Tuesday?";
const PASSAGES = [
  "On Tuesday, 61 crates arrived at the depot.",
  "On Tuesday, 99 crates arrived at the depot.",
  "The depot closed early on Friday because of a power outage.",
  "Crate deliveries are scheduled weekly by the regional planner.",
];
const TRUTH_IDX = 1;

// UNSEEN numeric-fact pair (F75): a different domain and numbers, authored when
// this test was written, never used by the g04/g05 frozen sets or any fixture.
// Same shape as the kept failure - ONE sentence template with only the number
// varying, so nothing but the number can drive the ranking (an earlier draft of
// this pair varied the year position and wording too; that confound made the
// engine appear to arbitrate when it was matching phrasing, not numbers).
// The 1,180 mm sentence is the designated truth (idx 3), deliberately listed
// AFTER the wrong candidate (940 mm, idx 1).
const UNSEEN_QUERY = "How many millimetres of rain did the Ridgemont station record in 2019?";
const UNSEEN_PASSAGES = [
  "Ridgemont station logged an average humidity of 71% during 2019.",
  "The Ridgemont station recorded 940 millimetres of rain in 2019.",
  "Rainfall at Ridgemont is measured by a tipping-bucket gauge maintained quarterly.",
  "The Ridgemont station recorded 1,180 millimetres of rain in 2019.",
];
const UNSEEN_TRUTH_IDX = 3;
const UNSEEN_WRONG_IDX = 1;

// Pinned identity mirrors ruke_ml/retrieval/nn_rerank.py; pinning it HERE is
// the point - "neural" through the live route must name the pinned asset and
// the CPU provider, or it is not the pinned engine.
const PINNED_MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";
const PINNED_REVISION = "sha256:c623d0bcb99f4622beb413eaef00cfbe5db20df9f1dd982da4b4f26022881870";
const PINNED_PROVIDER = "onnxruntime-cpu";

function idx(texts: string[]) {
  const chunks: IndexChunk[] = texts.map((text, i) => ({
    i,
    startSec: null,
    endSec: null,
    text,
    vec: [],
  }));
  const meta: IndexMeta = {
    attId: "att_live_rerank",
    name: "live-route-fixture",
    category: "text",
    createdAt: 0,
    chunkCount: chunks.length,
    spine: "",
    spineBlocks: [],
    frames: [],
  };
  return { meta, chunks } as never as Parameters<typeof retrieveEvidence>[0];
}

const corpus = idx(PASSAGES);
const opts = { mode: "exhaustive", budget: 400 } as const;

// Cold worker spawn (python start + onnx import + asset verify) happens inside
// the first live call; give every live case the stage's own 60 s bound plus the
// OS-side spawn slack, never more (the client deadline law stays in force).
const LIVE_TIMEOUT_MS = 90_000;

describe.skipIf(!LIVE)("F66 live rerank route: the production caller chain executes for real", () => {
  beforeAll(() => {
    if (!rustEnabled()) {
      throw new Error(
        "RUKE_LIVE_RERANK=1 without RUKE_RUST_BACKEND=1: the live topology must be started " +
          "with RUKE_RUST_BACKEND=1 + RUKE_BACKEND_PORT pointing at the scoped ruke-server",
      );
    }
    resetMlJobNegativeCache();
  });

  it(
    "the turn.ts composition reaches a REAL engine through POST /api/ruke/ml/job",
    async () => {
      const ev = await retrieveEvidenceWithRerank(
        corpus,
        QUERY,
        [],
        opts,
        makeRerankStage(),
        rerankWindow(),
      );
      // Anything but "neural" here means the route was skipped, refused or
      // failed - that IS the failure this file exists to make visible.
      expect(ev.rerank.mode, `rerank did not run: ${ev.rerank.reason ?? ""}`).toBe("neural");
      expect(ev.rerank.engine).toBe(RERANK_MODE);
      expect(ev.rerank.scored).toBe(PASSAGES.length);
      expect(ev.vectorMode).toBe("lexical_only");
      // Reading order law unchanged even through the live route.
      expect(ev.chunkIdxs).toEqual([...ev.chunkIdxs].sort((a, b) => a - b));
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "the live worker reports the PINNED identity and finite probabilities",
    async () => {
      const env = await mlJob(
        "rerank",
        {
          query: QUERY,
          mode: RERANK_MODE,
          top_k: PASSAGES.length,
          chunks: PASSAGES.map((text, i) => ({ chunk_id: `c${i}`, text })),
        },
        { deadlineMs: 60_000 },
      );
      expect(env, "no capability route at all").not.toBeNull();
      expect(env!.state, JSON.stringify(env!.error ?? {})).toBe("ready");
      const payload = (env!.result as { payload?: Record<string, unknown> } | undefined)?.payload ?? {};
      expect(payload.mode_actually_used).toBe(RERANK_MODE);
      const engine = (payload.engine ?? {}) as Record<string, string>;
      expect(engine.id).toBe(PINNED_MODEL_ID);
      expect(engine.revision).toBe(PINNED_REVISION);
      expect(engine.provider).toBe(PINNED_PROVIDER);
      const scores = (payload.scores ?? []) as Array<{ chunk_id: string; score: number; rank: number }>;
      expect(scores).toHaveLength(PASSAGES.length);
      for (const s of scores) {
        expect(Number.isFinite(s.score)).toBe(true);
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(1);
      }
      expect(scores.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "the kept numeric-fact failure: the WRONG number still ranks first (characterization)",
    async () => {
      const out = await makeRerankStage()(QUERY, PASSAGES.map((text, i) => ({ idx: i, text })));
      expect(out, "the live stage refused to run").not.toBeNull();
      expect(out!.engine).toBe(RERANK_MODE);
      expect(out!.order).toHaveLength(PASSAGES.length);
      // THE kept failure, asserted as a failure: the truth passage must NOT be
      // first, exactly as g04 (`cross_encoder_rank=2`), g05 (ranks [2,...],
      // probe exit 1) and f29-rerank-live-2.json ("expected c1, got c0") record
      // it. See the header comment for what must be updated if this ever flips.
      expect(
        out!.order[0].idx,
        "the pinned cross-encoder fixed the numeric-fact case: STOP - update the registry " +
          "(numeric_fact_case_fixed), DECISION-OWNERSHIP and FINAL-REPORT wording in the " +
          "same change instead of letting this characterization go green silently",
      ).not.toBe(TRUTH_IDX);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "unseen numeric-fact pair: the two numbers score within noise; the route's contract is score-both, keep-both (characterization)",
    async () => {
      const stage = makeRerankStage();
      const cands = UNSEEN_PASSAGES.map((text, i) => ({ idx: i, text }));
      const out = await stage(UNSEEN_QUERY, cands);
      expect(out, "the live stage refused to run").not.toBeNull();
      expect(out!.engine).toBe(RERANK_MODE);
      // Nothing is dropped: every candidate is scored and returned.
      expect(out!.order.map((c) => c.idx).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
      const scoreOf = (i: number) => out!.order.find((c) => c.idx === i)!.score;
      const truth = scoreOf(UNSEEN_TRUTH_IDX);
      const wrong = scoreOf(UNSEEN_WRONG_IDX);
      // THE mechanism behind the kept failure, on unseen data: measured on the
      // pinned asset directly at F75 (full precision, both candidate orders),
      // two candidates identical except the number score 0.9999770 vs
      // 0.9999740 - margin 2.98e-06. That ordering carries no information at
      // any sane precision, and it is demonstrably not content signal: the
      // same engine puts the WRONG number first on the crates pair (g05
      // cross_encoder_rank=2). Retrieval has no honest grounds to arbitrate
      // here. A margin beyond 0.01 would mean an engine day came when the pair
      // IS separable: STOP - update the registry (numeric_fact_case_fixed),
      // DECISION-OWNERSHIP and FINAL-REPORT wording in the same change, as
      // with the frozen case above - never let this characterization drift.
      const margin = Math.abs(truth - wrong);
      expect(
        margin,
        `the pinned engine separated the unseen numeric pair (margin ${margin}): STOP - update ` +
          "the registry (numeric_fact_case_fixed), DECISION-OWNERSHIP and FINAL-REPORT wording " +
          "in the same change instead of letting this characterization drift",
      ).toBeLessThanOrEqual(0.01);
      // What the engine DOES arbitrate honestly: the two numeric candidates
      // occupy ranks 1-2 and both topical distractors fall below them - the
      // pair is ambiguous only in its number. No rank order INSIDE the pair is
      // asserted: at a ~3e-06 margin that order is noise (the frozen crates
      // pair flips the other way).
      const rankOf = (i: number) => out!.order.findIndex((c) => c.idx === i) + 1;
      expect([rankOf(UNSEEN_TRUTH_IDX), rankOf(UNSEEN_WRONG_IDX)].sort((a, b) => a - b)).toEqual([1, 2]);
      // Deterministic repeat (worker is warm): order and scores reproduce.
      const again = await stage(UNSEEN_QUERY, cands);
      expect(again!.order.map((c) => c.idx)).toEqual(out!.order.map((c) => c.idx));
      expect(again!.order.map((c) => Math.round(c.score * 1e6))).toEqual(
        out!.order.map((c) => Math.round(c.score * 1e6)),
      );
      // Evidence-level contract: BOTH conflicting numbers survive into the
      // delivered evidence set - the conflict is surfaced to the answer stage,
      // never silently resolved by dropping a candidate.
      const ev = await retrieveEvidenceWithRerank(
        idx(UNSEEN_PASSAGES),
        UNSEEN_QUERY,
        [],
        opts,
        stage,
        rerankWindow(),
      );
      expect(ev.rerank.mode, `rerank did not run: ${ev.rerank.reason ?? ""}`).toBe("neural");
      expect(ev.chunkIdxs).toContain(UNSEEN_TRUTH_IDX);
      expect(ev.chunkIdxs).toContain(UNSEEN_WRONG_IDX);
      // Production-request evidence for the record (engine, candidates, scores).
      console.log(
        "[f75-unseen-numeric] engine=" + out!.engine,
        "order=[" + out!.order.map((c) => c.idx).join(",") + "]",
        "scores=[" + out!.order.map((c) => c.score.toFixed(4)).join(",") + "]",
        "tie_margin=" + margin.toFixed(6),
      );
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "a warm repeat through the live route reproduces the order",
    async () => {
      const stage = makeRerankStage();
      const cands = PASSAGES.map((text, i) => ({ idx: i, text }));
      const a = await stage(QUERY, cands);
      const b = await stage(QUERY, cands);
      expect(a && b).toBeTruthy();
      expect(a!.order.map((c) => c.idx)).toEqual(b!.order.map((c) => c.idx));
      expect(a!.order.map((c) => Math.round(c.score * 1e6))).toEqual(
        b!.order.map((c) => Math.round(c.score * 1e6)),
      );
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "an unknown mode is a typed refusal through the route, never a substitution",
    async () => {
      const env = await mlJob(
        "rerank",
        {
          query: QUERY,
          mode: "neural_gpt4_all_pro",
          top_k: PASSAGES.length,
          chunks: PASSAGES.map((text, i) => ({ chunk_id: `c${i}`, text })),
        },
        { deadlineMs: 60_000 },
      );
      expect(env, "no capability route at all").not.toBeNull();
      expect(env!.state).not.toBe("ready");
      const err = (env!.error ?? {}) as { reason?: string };
      expect(typeof err.reason).toBe("string");
      expect((err.reason ?? "").length).toBeGreaterThan(0);
      // Nothing may be served under a mode nobody asked for.
      const payload = (env!.result as { payload?: Record<string, unknown> } | undefined)?.payload;
      expect(payload?.scores ?? []).toEqual([]);
    },
    LIVE_TIMEOUT_MS,
  );
});
