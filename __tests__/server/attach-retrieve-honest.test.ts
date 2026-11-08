/**
 * Phase-4 retrieval honesty pins (I20/I21/I22/I23-side):
 *  - `dropped`: an exact count of passages the budget left out (the turn
 *    layer turns it into "[N more relevant passages exist…]").
 *  - `demote`: passages an earlier turn already served sink below fresh
 *    candidates; the held set is only served when NOTHING fresh fits.
 *  - `budget`: per-call override (the turn's shared budget, I05).
 *  - hasVec gate: with no query vector there is NO cosine channel at all —
 *    BM25 alone ranks (the old code fed an all-zeros cosine list into RRF
 *    and let insertion order outrank the real term hits).
 *  - exhaustive: the channel cap is the whole corpus, not 20.
 */
import { describe, expect, it } from "vitest";
import { retrieveEvidence } from "@/lib/server/attachindex/retrieve";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

function idx(texts: string[], vecs: number[][] = [], timed = false): { meta: IndexMeta; chunks: IndexChunk[] } {
  const chunks: IndexChunk[] = texts.map((text, i) => ({
    i,
    startSec: timed ? i * 600 : null,
    endSec: timed ? (i + 1) * 600 : null,
    text,
    vec: vecs[i] ?? [],
  }));
  return {
    meta: {
      attId: "att_unit0002", name: "fake", category: "text", createdAt: 0,
      chunkCount: chunks.length, spine: "", spineBlocks: [], frames: [],
    },
    chunks,
  };
}

describe("dropped count (exact, honest)", () => {
  it("counts candidates the budget refused", () => {
    const corpus = idx(Array.from({ length: 30 }, (_, i) => `mention of widget number ${i}`));
    const ev = retrieveEvidence(corpus, "widget", [], { mode: "exhaustive", budget: 100 });
    // ~30-char texts: 30, 62, 94 fit; 126 > 100 ⇒ 3 picked.
    expect(ev.chunkIdxs.length).toBe(3);
    expect(ev.dropped).toBe(27);
    expect(ev.truncated).toBe(true);
  });

  it("zero dropped when the whole selection fits", () => {
    const corpus = idx(Array.from({ length: 30 }, (_, i) => `mention of widget number ${i}`));
    const ev = retrieveEvidence(corpus, "widget", [], { mode: "exhaustive" });
    expect(ev.dropped).toBe(0);
    expect(ev.truncated).toBe(false);
    expect(ev.chunkIdxs.length).toBe(30);
  });
});

describe("exhaustive ranking cap is the whole corpus", () => {
  it("surfaces all 30 hits with no vector (old by_bm.truncate(20) capped at 20)", () => {
    const corpus = idx(Array.from({ length: 30 }, (_, i) => `mention of widget number ${i}`));
    const ev = retrieveEvidence(corpus, "widget", [], { mode: "exhaustive" });
    expect(ev.chunkIdxs).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it("non-exhaustive modes still stop at TOP_K seeds (default 8)", () => {
    const corpus = idx(Array.from({ length: 30 }, (_, i) => `mention of widget number ${i}`));
    const ev = retrieveEvidence(corpus, "widget", [], { mode: "sequential", range: { from: 0, to: 29 } });
    // sequential ignores ranking entirely — budget-bound, all 30 fit: use
    // point_qa instead for the TOP_K pin:
    const pt = retrieveEvidence(corpus, "widget", [], { mode: "point_qa" });
    // TOP_K seeds 8 (+ neighbor expansion); budget is generous, so the
    // picked count stays far below 30 (the exhaustive pin above).
    expect(pt.chunkIdxs.length).toBeLessThan(30);
    expect(ev.chunkIdxs.length).toBe(30);
  });
});

describe("demote (shown ledger, I20)", () => {
  it("fresh candidates outrank already-shown passages", () => {
    const corpus = idx(["widget first", "widget second", "widget third"]);
    const ev = retrieveEvidence(corpus, "widget", [], { mode: "point_qa", demote: [0] });
    expect(ev.chunkIdxs).toEqual([1, 2]);
    expect(ev.dropped).toBe(1);
  });

  it("when EVERYTHING is demoted the held set is served anyway (never empty)", () => {
    const corpus = idx(["widget first", "widget second", "widget third"]);
    const ev = retrieveEvidence(corpus, "widget", [], { mode: "point_qa", demote: [0, 1, 2] });
    expect(ev.chunkIdxs.length).toBeGreaterThan(0);
    expect(ev.text).toContain("widget");
  });

  it("holds are NOT served when fresh candidates already fill the budget", () => {
    const corpus = idx(["widget aaa", "widget bbb", "widget ccc"]);
    const ev = retrieveEvidence(corpus, "widget", [], { mode: "point_qa", demote: [0], budget: 10 });
    // fresh: [1,2]; only id1 fits (10 cost); id2 overflows; held id0 must
    // NOT substitute (budget, not availability, is the constraint).
    expect(ev.chunkIdxs).toEqual([1]);
  });

  it("time_range passes demote through pack too", () => {
    const corpus = idx(["widget a", "widget b", "widget c"], [], true);
    const ev = retrieveEvidence(corpus, "", [], { mode: "time_range", fromSec: 0, toSec: 1e9, demote: [1] });
    expect(ev.chunkIdxs).toEqual([0, 2]);
  });
});

describe("hasVec gate: no cosine channel without a query vector", () => {
  it("empty queryVec ranks on BM25 alone — the term hit wins outright", () => {
    const corpus = idx(
      ["filler words nothing relevant here", "also irrelevant prose", "zeta zeta zeta ZETA term"],
      [[1, 0], [0, 1], [0, 0]], // cosine (if consulted) would crown chunk 0
    );
    const ev = retrieveEvidence(corpus, "zeta", [], { mode: "point_qa", budget: 33 });
    // budget 33: only ONE 31-char chunk fits (next costs 33 exactly? no —
    // second costs 31+2=33 ⇒ 31+33 > 33 ⇒ single pick).
    expect(ev.chunkIdxs).toEqual([2]);
    expect(ev.text).toContain("ZETA");
  });

  it("non-empty queryVec keeps the cosine channel (it flips the RRF winner)", () => {
    // Both term hits carry "zeta": BM25 crowns chunk 2 (higher tf), cosine
    // crowns chunk 0. With the cosine channel the two RRF lists tie-score
    // chunk 0 and chunk 2 (1/61+1/62 each) and the cosine list is inserted
    // FIRST, so chunk 0 wins; with NO vector, BM25 alone crowns chunk 2.
    const corpus = idx(
      ["zeta filler text aaaaaaaaaaaaaaaa", "irrelevant prose bbbbbbbbbbbbbbbbbb", "zeta zeta text cccccccccccccccccc"],
      [[1, 0], [0, 1], [0, 0]], // 31-char texts: budget 33 serves exactly one
    );
    const withVec = retrieveEvidence(corpus, "zeta", [1, 0], { mode: "point_qa", budget: 33 });
    expect(withVec.chunkIdxs).toEqual([0]);
    const noVec = retrieveEvidence(corpus, "zeta", [], { mode: "point_qa", budget: 33 });
    expect(noVec.chunkIdxs).toEqual([2]);
  });
});

describe("budget override (turn budget, I05)", () => {
  it("opts.budget replaces the env default", () => {
    const corpus = idx(["y".repeat(500) + " marker 0", "y".repeat(500) + " marker 1", "y".repeat(500) + " marker 2"]);
    const ev = retrieveEvidence(corpus, "marker", [], { mode: "exhaustive", budget: 1024 });
    // 509-char texts, no headers: 509 fits; 509+511=1020 ≤ 1024 fits; +511 > 1024 ⇒ 2 picked.
    expect(ev.chunkIdxs.length).toBe(2);
    expect(ev.dropped).toBe(1);
    expect(ev.text.length).toBeLessThanOrEqual(1024);
  });
});
