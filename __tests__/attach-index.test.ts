import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chunkSegments, chunkText } from "../lib/server/attachindex/chunk";
import { bm25Scores, tokenize } from "../lib/server/attachindex/bm25";
import { routeQuery } from "../lib/server/attachindex/router";
import { buildSpine } from "../lib/server/attachindex/spine";
import { retrieveEvidence } from "../lib/server/attachindex/retrieve";
import {
  hasIndex,
  indexDir,
  readIndex,
  readNotes,
  removeIndex,
  writeIndex,
  writeNotes,
} from "../lib/server/attachindex/store";
import { fmtStamp } from "../lib/server/attachindex/format";
import type { IndexChunk, IndexMeta } from "../lib/server/attachindex/types";

// ---------------------------------------------------------------- chunking

const SIZE = 1200;
const OVERLAP = 150;

function sentences(n: number, tag = "s"): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`This is sentence number ${i} about ${tag} topic and it has some length to it.`);
  return out.join(" ");
}

describe("chunkText", () => {
  it("keeps every chunk within the size budget", () => {
    const chunks = chunkText(sentences(120), SIZE, OVERLAP);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(SIZE);
    chunks.forEach((c, i) => expect(c.i).toBe(i));
    for (const c of chunks) {
      expect(c.startSec).toBeNull();
      expect(c.endSec).toBeNull();
    }
  });

  it("carries ~overlap chars from the end of one chunk into the next", () => {
    const chunks = chunkText(sentences(60), SIZE, OVERLAP);
    let overlaps = 0;
    for (let i = 0; i + 1 < chunks.length; i++) {
      const firstSentenceOfNext = chunks[i + 1].text.split(". ")[0] + ".";
      if (chunks[i].text.includes(firstSentenceOfNext)) overlaps++;
    }
    expect(overlaps).toBe(chunks.length - 1); // every boundary carries over
  });

  it("hard-splits a giant unbroken paragraph", () => {
    const blob = "word ".repeat(1000); // ~5000 chars, no sentence ends
    const chunks = chunkText(blob, SIZE, OVERLAP);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(SIZE);
  });

  it("never loops forever when a single unit exceeds the overlap cap", () => {
    const huge = "x".repeat(1100); // fits under SIZE but exceeds OVERLAP
    const chunks = chunkText(`${huge}\n${sentences(10)}`, SIZE, OVERLAP);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("chunkSegments", () => {
  it("propagates contiguous timestamps onto chunks", () => {
    const segs = Array.from({ length: 80 }, (_, i) => ({
      text: `Segment ${i} spoken content with a few extra words to fill space.`,
      start: i * 10,
      end: i * 10 + 10,
    }));
    const chunks = chunkSegments(segs, SIZE, OVERLAP);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.startSec).not.toBeNull();
      expect(c.endSec).not.toBeNull();
      expect(c.endSec!).toBeGreaterThan(c.startSec!);
    }
    // Chronological and non-decreasing across boundaries.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startSec!).toBeLessThanOrEqual(chunks[i - 1].endSec! + 0.001);
    }
    expect(chunks[0].startSec).toBe(0);
  });
});

// -------------------------------------------------------------------- bm25

describe("bm25", () => {
  it("ranks term frequency and prefers rare terms", () => {
    const docs = ["the cat sat on the mat", "the dog barked loudly", "cat cat cat everywhere"].map(tokenize);
    const catScores = bm25Scores("cat", docs);
    expect(catScores[2]).toBeGreaterThan(catScores[0]);
    expect(catScores[0]).toBeGreaterThan(catScores[1]);
    expect(bm25Scores("zebra", docs)).toEqual([0, 0, 0]);
  });

  it("scores a multi-term query above single-term docs", () => {
    const docs = ["photosynthesis converts light into sugar", "a lecture about light bulbs"].map(tokenize);
    const s = bm25Scores("photosynthesis light sugar", docs);
    expect(s[0]).toBeGreaterThan(s[1]);
  });
});

// ------------------------------------------------------------------ router

describe("routeQuery", () => {
  it("detects explicit time ranges", () => {
    expect(routeQuery("what happened from 1:00:00 to 1:30:00?")).toEqual({
      mode: "time_range",
      fromSec: 3600,
      toSec: 5400,
    });
  });

  it("widens a single timestamp into a ±3 minute window", () => {
    const r = routeQuery("explain the part around 12:30");
    expect(r.mode).toBe("time_range");
    expect(r.fromSec).toBe(750 - 180);
    expect(r.toSec).toBe(750 + 180);
  });

  it("handles minute phrasings", () => {
    expect(routeQuery("summarize the first 10 minutes")).toEqual({ mode: "time_range", fromSec: 0, toSec: 600 });
    const r = routeQuery("what did he say at minute 42");
    expect(r.mode).toBe("time_range");
    expect(r.fromSec).toBe(42 * 60 - 180);
  });

  it("maps module references to sequential blocks", () => {
    expect(routeQuery("teach me module 2 again")).toEqual({ mode: "sequential", blockIndex: 1 });
    expect(routeQuery("explain chapter 5").blockIndex).toBe(4);
  });

  it("detects exhaustive mention queries", () => {
    expect(routeQuery("list every time the author mentions entropy").mode).toBe("exhaustive");
    expect(routeQuery("how many times does she say basically").mode).toBe("exhaustive");
  });

  it("detects whole-content summary queries", () => {
    expect(routeQuery("summarize the whole video").mode).toBe("whole_video");
    expect(routeQuery("give me course notes for the entire course").mode).toBe("whole_video");
  });

  it("defaults to point Q&A", () => {
    expect(routeQuery("what is gradient descent?").mode).toBe("point_qa");
  });
});

// ------------------------------------------------------------------- spine

function timedChunks(n: number, stepSec: number): IndexChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    i,
    startSec: i * stepSec,
    endSec: (i + 1) * stepSec,
    text: `Chunk ${i} talks about topic-${Math.floor(i / 10)} and filler words here.`,
    vec: [],
  }));
}

describe("buildSpine", () => {
  it("groups timed chunks into 10-minute blocks", () => {
    const { blocks, text } = buildSpine(timedChunks(36, 50)); // 36 × 50 s = 30 min
    expect(blocks.length).toBe(3);
    expect(blocks[0].chunkFrom).toBe(0);
    expect(blocks[1].chunkFrom).toBeGreaterThan(0);
    expect(text).toContain("[00:00:00 - ");
    expect(text.split("\n").length).toBe(3);
  });

  it("picks distinctive keywords per block", () => {
    const chunks = Array.from({ length: 24 }, (_, i) => ({
      i,
      startSec: i * 60,
      endSec: (i + 1) * 60,
      text: i < 12 ? `gradient descent step ${i}` : `backpropagation chain rule ${i}`,
      vec: [],
    }));
    const { blocks } = buildSpine(chunks);
    expect(blocks[0].keywords).toContain("gradient");
    expect(blocks[1].keywords).toContain("backpropagation");
  });

  it("caps untimed text blocks at the configured maximum", () => {
    const chunks = Array.from({ length: 500 }, (_, i) => ({
      i,
      startSec: null,
      endSec: null,
      text: `sentence ${i}`,
      vec: [],
    }));
    const { blocks } = buildSpine(chunks);
    expect(blocks.length).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------- retrieve

function fakeIndex(specs: { text: string; vec: number[]; startSec?: number | null }[]): {
  meta: IndexMeta;
  chunks: IndexChunk[];
} {
  const chunks: IndexChunk[] = specs.map((s, i) => ({
    i,
    startSec: s.startSec === undefined ? i * 600 : s.startSec,
    endSec: (s.startSec === undefined ? i * 600 : s.startSec ?? 0) + 600,
    text: s.text,
    vec: s.vec,
  }));
  return {
    meta: {
      attId: "att_unit0001",
      name: "fake",
      category: "text",
      createdAt: 0,
      chunkCount: chunks.length,
      spine: "",
      spineBlocks: [],
      frames: [],
    },
    chunks,
  };
}

describe("retrieveEvidence", () => {
  const idx = fakeIndex([
    { text: "intro to neural networks", vec: [1, 0, 0] },
    { text: "unrelated filler passage about cooking", vec: [0, 1, 0] },
    { text: "gradient descent minimizes the loss function", vec: [0, 0, 1] },
    { text: "learning rate schedules for gradient methods", vec: [0, 0.9, 0.4] },
    { text: "closing remarks and homework", vec: [1, 1, 0] },
  ]);

  it("hybrid search finds the semantic match and expands neighbors", () => {
    const ev = retrieveEvidence(idx, "how does gradient descent work", [0, 0, 1], { mode: "point_qa" });
    expect(ev.chunkIdxs).toContain(2);
    expect(ev.chunkIdxs).toContain(1); // neighbor
    expect(ev.chunkIdxs).toContain(3); // neighbor
    const sorted = [...ev.chunkIdxs].sort((a, b) => a - b);
    expect(ev.chunkIdxs).toEqual(sorted); // chronological output
    expect(ev.text).toContain("[00:20:00 - 00:30:00]");
  });

  it("time_range mode selects the overlapping window chronologically", () => {
    const ev = retrieveEvidence(idx, "", [0, 0, 0], { mode: "time_range", fromSec: 700, toSec: 1900 });
    expect(ev.chunkIdxs).toEqual([1, 2, 3]);
  });

  it("sequential mode walks a chunk range", () => {
    const ev = retrieveEvidence(idx, "", [0, 0, 0], { mode: "sequential", range: { from: 3, to: 4 } });
    expect(ev.chunkIdxs).toEqual([3, 4]);
  });

  it("truncates by budget and flags it", () => {
    const big = fakeIndex(
      Array.from({ length: 6 }, (_, i) => ({
        text: "y".repeat(9000) + ` marker${i}`,
        vec: [i === 0 ? 1 : 0],
      })),
    );
    const ev = retrieveEvidence(big, "marker0", [1], { mode: "point_qa" });
    expect(ev.truncated).toBe(true);
    expect(ev.text.length).toBeLessThanOrEqual(24000);
  });

  it("exhaustive mode has no top-K cutoff", () => {
    const many = fakeIndex(
      Array.from({ length: 30 }, (_, i) => ({ text: `mention of widget number ${i}`, vec: [0] })),
    );
    const ev = retrieveEvidence(many, "widget", [0], { mode: "exhaustive" });
    expect(ev.chunkIdxs.length).toBeGreaterThan(8); // beyond ATTACH_TOP_K default
  });
});

// ------------------------------------------------------------------- store

describe("store", () => {
  const attId = "att_storetest1";
  const meta: IndexMeta = {
    attId,
    name: "big.txt",
    category: "text",
    createdAt: 1,
    chunkCount: 2,
    spine: "spine text",
    spineBlocks: [],
    frames: [{ at: 120, file: "frames/f_00001.jpg" }],
  };
  const chunks: IndexChunk[] = [
    { i: 0, startSec: null, endSec: null, text: "first chunk", vec: [0.1, 0.2] },
    { i: 1, startSec: 60, endSec: 120, text: "second chunk", vec: [0.3] },
  ];

  afterAll(() => removeIndex(attId));

  it("rejects malformed attachment ids", () => {
    expect(() => indexDir("../evil")).toThrow(/invalid attachment id/);
    expect(() => indexDir("att_ab")).toThrow(/invalid/);
    expect(() => indexDir("att_good1234")).not.toThrow();
  });

  it("round-trips meta, chunks and notes", () => {
    writeIndex(attId, meta, chunks, "first chunksecond chunk");
    expect(hasIndex(attId)).toBe(true);
    const loaded = readIndex(attId)!;
    expect(loaded.meta.spine).toBe("spine text");
    expect(loaded.chunks.length).toBe(2);
    expect(loaded.chunks[1].vec).toEqual([0.3]);
    expect(fs.readFileSync(path.join(indexDir(attId), "full.txt"), "utf8")).toBe(
      "first chunksecond chunk",
    );

    expect(readNotes(attId)).toBeNull();
    writeNotes(attId, "course notes here");
    expect(readNotes(attId)).toBe("course notes here");

    removeIndex(attId);
    expect(hasIndex(attId)).toBe(false);
    expect(readIndex(attId)).toBeNull();
  });

  it("removeIndex tolerates unknown ids", () => {
    expect(() => removeIndex("bogus id")).not.toThrow();
    expect(() => removeIndex("att_neverexists99")).not.toThrow();
  });
});

// ------------------------------------------------------------------ format

describe("fmtStamp", () => {
  it("pads to HH:MM:SS", () => {
    expect(fmtStamp(0)).toBe("00:00:00");
    expect(fmtStamp(75)).toBe("00:01:15");
    expect(fmtStamp(3661)).toBe("01:01:01");
    expect(fmtStamp(36000)).toBe("10:00:00");
  });
});
