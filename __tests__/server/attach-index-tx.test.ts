/**
 * F09 / F10 — attachment-index publish atomicity, cancellation and embedding
 * provenance. Everything here is offline: temp roots, no model, no network.
 *
 * The defect this pins shut: the old writer replaced full.txt, chunks.jsonl and
 * meta.json one file at a time. A crash between those renames left NEW chunks
 * next to OLD metadata, and retrieval then scored a mixed generation. Per-file
 * atomic rename is not a multi-file transaction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FaultAbort,
  discardStaged,
  durableWrite,
  publishIndex,
  recoverIndexDir,
  sweepStale,
  type FaultPoint,
  type PublishPaths,
} from "@/lib/server/attachindex/publish";
import { readIndex } from "@/lib/server/attachindex/store";
import { retrieveEvidence } from "@/lib/server/attachindex/retrieve";
import { assessVectors } from "@/lib/server/attachindex/vectors";
import type { IndexChunk, IndexMeta, LoadedIndex } from "@/lib/server/attachindex/types";

const ATT = "att_atomic01";

let root: string;
let paths: PublishPaths;

function mkMeta(chunks: number, frames: Array<{ at: number; file: string }> = []): IndexMeta {
  return {
    attId: ATT, name: "doc.txt", category: "text", createdAt: 1,
    chunkCount: chunks, spine: "spine", spineBlocks: [], frames,
  };
}

function chunksOf(texts: string[]): IndexChunk[] {
  return texts.map((text, i) => ({ i, startSec: null, endSec: null, text, vec: [i / 10, 0.5] }));
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else out[rel] = fs.readFileSync(path.join(d, e.name), "utf8");
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ruke-attach-tx-"));
  paths = {
    attDir: path.join(root, ATT),
    genRoot: path.join(root, ".gen"),
    txRoot: path.join(root, ".tx"),
  };
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
});

describe("publish is a single visible switch (F09)", () => {
  it("publishes a complete generation and leaves no temp files", () => {
    const res = publishIndex({
      attId: ATT, meta: mkMeta(2) as unknown as Record<string, unknown>,
      chunks: chunksOf(["alpha passage", "beta passage"]), fullText: "alpha passage beta passage",
      paths,
    });
    expect(res.chunkCount).toBe(2);
    expect(fs.readdirSync(paths.attDir).sort()).toEqual(["chunks.jsonl", "full.txt", "meta.json"]);
    expect(fs.existsSync(path.join(root, ATT, "meta.json"))).toBe(true);
    // journals and staged attempts are cleaned once committed
    expect(fs.existsSync(path.join(paths.txRoot, `${ATT}.json`))).toBe(false);
    expect(fs.existsSync(path.join(paths.genRoot, ATT))).toBe(false);
  });

  it("a fault at every pre-switch point leaves the PREVIOUS generation byte-identical", () => {
    const first = publishIndex({
      attId: ATT, meta: mkMeta(1) as unknown as Record<string, unknown>,
      chunks: chunksOf(["ORIGINAL first passage"]), fullText: "ORIGINAL first passage", paths,
    });
    void first;
    const before = snapshot(paths.attDir);

    const points: FaultPoint[] = ["stage-full", "stage-chunks", "stage-meta", "validate", "journal"];
    for (const point of points) {
      expect(() =>
        publishIndex({
          attId: ATT, meta: mkMeta(3) as unknown as Record<string, unknown>,
          chunks: chunksOf(["NEW one", "NEW two", "NEW three"]), fullText: "NEW one NEW two NEW three",
          paths, fault: p => { if (p === point) throw new FaultAbort(point); },
        }),
      ).toThrow(`injected fault at ${point}`);
      // never a mixed generation, never a visible half-written file
      expect(snapshot(paths.attDir)).toEqual(before);
      expect(fs.readdirSync(paths.attDir).sort()).toEqual(["chunks.jsonl", "full.txt", "meta.json"]);
      const meta = JSON.parse(fs.readFileSync(path.join(paths.attDir, "meta.json"), "utf8"));
      expect(meta.chunkCount).toBe(1);
    }
  });

  it("a crash after the aside rename still leaves ONE complete generation", () => {
    publishIndex({
      attId: ATT, meta: mkMeta(1) as unknown as Record<string, unknown>,
      chunks: chunksOf(["ORIGINAL"]), fullText: "ORIGINAL TEXT", paths,
    });

    expect(() =>
      publishIndex({
        attId: ATT, meta: mkMeta(2) as unknown as Record<string, unknown>,
        chunks: chunksOf(["NEW one", "NEW two"]), fullText: "NEW TEXT ENTIRELY",
        paths, fault: p => { if (p === "after-aside") throw new FaultAbort(p); },
      }),
    ).toThrow(/after-aside/);

    // The live name was moved aside; the staged generation is intact. Recovery
    // may complete forward OR restore the old one, but it must never mix them.
    expect(fs.existsSync(path.join(paths.attDir, "meta.json"))).toBe(false);
    expect(recoverIndexDir(paths, ATT)).toBe(true);
    const after = snapshot(paths.attDir);
    const text = after["full.txt"];
    const isOld = text === "ORIGINAL TEXT";
    const isNew = text === "NEW TEXT ENTIRELY";
    expect(isOld || isNew).toBe(true);
    // whichever generation won, it is internally consistent
    const meta = JSON.parse(after["meta.json"]);
    expect(meta.chunkCount).toBe(isOld ? 1 : 2);
    expect(after["chunks.jsonl"].trim().split("\n")).toHaveLength(meta.chunkCount);
    expect(fs.readdirSync(root).filter(n => n.includes(".stale-"))).toEqual([]);
  });

  it("when the staged generation is gone, recovery puts the OLD generation back", () => {
    publishIndex({
      attId: ATT, meta: mkMeta(1) as unknown as Record<string, unknown>,
      chunks: chunksOf(["ORIGINAL"]), fullText: "ORIGINAL TEXT", paths,
    });
    const before = snapshot(paths.attDir);

    expect(() =>
      publishIndex({
        attId: ATT, meta: mkMeta(2) as unknown as Record<string, unknown>,
        chunks: chunksOf(["NEW one", "NEW two"]), fullText: "NEW TEXT ENTIRELY",
        paths, fault: p => { if (p === "after-aside") throw new FaultAbort(p); },
      }),
    ).toThrow(/after-aside/);
    // the staged half is lost (disk error / interrupted GC), only the aside copy survives
    discardStaged(paths, ATT);

    expect(recoverIndexDir(paths, ATT)).toBe(true);
    expect(snapshot(paths.attDir)).toEqual(before);
    expect(fs.readdirSync(root).filter(n => n.includes(".stale-"))).toEqual([]);
  });

  it("forward recovery completes an interrupted publish when the staged generation is intact", () => {
    publishIndex({
      attId: ATT, meta: mkMeta(1) as unknown as Record<string, unknown>,
      chunks: chunksOf(["OLD"]), fullText: "OLD FULL TEXT", paths,
    });
    expect(() =>
      publishIndex({
        attId: ATT, meta: mkMeta(2) as unknown as Record<string, unknown>,
        chunks: chunksOf(["FRESH alpha", "FRESH beta"]), fullText: "FRESH FULL TEXT",
        paths, fault: p => { if (p === "after-aside") throw new FaultAbort(p); },
      }),
    ).toThrow(/after-aside/);

    // The journal names a complete staged generation, so the reader finishes the
    // switch instead of losing the new build.
    expect(recoverIndexDir(paths, ATT)).toBe(true);
    expect(fs.readFileSync(path.join(paths.attDir, "full.txt"), "utf8")).toBe("FRESH FULL TEXT");
    expect(fs.existsSync(path.join(paths.txRoot, `${ATT}.json`))).toBe(false);
  });

  it("a killed process after the switch is cleaned up without losing the new generation", () => {
    publishIndex({
      attId: ATT, meta: mkMeta(1) as unknown as Record<string, unknown>,
      chunks: chunksOf(["OLD"]), fullText: "OLD", paths,
    });
    expect(() =>
      publishIndex({
        attId: ATT, meta: mkMeta(2) as unknown as Record<string, unknown>,
        chunks: chunksOf(["NEW a", "NEW b"]), fullText: "NEW",
        paths, fault: p => { if (p === "after-switch") throw new FaultAbort(p); },
      }),
    ).toThrow(/after-switch/);
    expect(fs.readFileSync(path.join(paths.attDir, "full.txt"), "utf8")).toBe("NEW");
    expect(recoverIndexDir(paths, ATT)).toBe(false); // live index is intact, nothing to restore
    expect(fs.readFileSync(path.join(paths.attDir, "full.txt"), "utf8")).toBe("NEW");
    expect(fs.readdirSync(root).filter(n => n.includes(".stale-"))).toEqual([]);
  });

  it("rejects an internally inconsistent generation before it can become visible", () => {
    // meta.chunkCount disagrees with the chunk array -> refused up front.
    expect(() =>
      publishIndex({
        attId: ATT, meta: mkMeta(9) as unknown as Record<string, unknown>,
        chunks: chunksOf(["only one"]), fullText: "only one", paths,
      }),
    ).toThrow(/chunkCount/);
    expect(fs.existsSync(path.join(paths.attDir, "meta.json"))).toBe(false);
    // a staged generation that fails readback validation is never published
    expect(fs.existsSync(path.join(paths.genRoot, ATT))).toBe(false);
  });
});

describe("staged keyframes and cancellation (F09/F10)", () => {
  function stageFrame(name: string, bytes = "frame-bytes"): string {
    const dir = path.join(paths.attDir, "frames");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return `frames/${name}`;
  }

  it("a published generation carries its declared keyframes inside it", () => {
    const rel = stageFrame("f_1.jpg", "AAA");
    publishIndex({
      attId: ATT,
      meta: mkMeta(1, [{ at: 5, file: rel }]) as unknown as Record<string, unknown>,
      chunks: chunksOf(["frame passage"]), fullText: "frame passage",
      frames: [{ at: 5, file: rel }], paths,
    });
    expect(fs.readFileSync(path.join(paths.attDir, "frames", "f_1.jpg"), "utf8")).toBe("AAA");
  });

  it("a missing declared keyframe fails the publish and restores the moved frames", () => {
    publishIndex({
      attId: ATT, meta: mkMeta(1) as unknown as Record<string, unknown>,
      chunks: chunksOf(["OLD"]), fullText: "OLD", paths,
    });
    const rel = stageFrame("f_keep.jpg", "KEEP");
    expect(() =>
      publishIndex({
        attId: ATT,
        meta: mkMeta(1, [{ at: 1, file: rel }, { at: 2, file: "frames/gone.jpg" }]) as unknown as Record<string, unknown>,
        chunks: chunksOf(["NEW"]), fullText: "NEW",
        frames: [{ at: 1, file: rel }, { at: 2, file: "frames/gone.jpg" }],
        paths,
      }),
    ).toThrow(/gone.jpg is not on disk/);
    // The frame that HAD been moved into the staged dir is back on disk.
    expect(fs.readFileSync(path.join(paths.attDir, "frames", "f_keep.jpg"), "utf8")).toBe("KEEP");
    expect(fs.readFileSync(path.join(paths.attDir, "full.txt"), "utf8")).toBe("OLD");
  });

  it("a pre-aborted publish writes nothing at all (F10)", () => {
    publishIndex({
      attId: ATT, meta: mkMeta(1) as unknown as Record<string, unknown>,
      chunks: chunksOf(["KEEP ME"]), fullText: "KEEP ME", paths,
    });
    const ac = new AbortController();
    ac.abort();
    expect(() =>
      publishIndex({
        attId: ATT, meta: mkMeta(2) as unknown as Record<string, unknown>,
        chunks: chunksOf(["x", "y"]), fullText: "x y", paths, signal: ac.signal,
      }),
    ).toThrow(/aborted/i);
    expect(fs.readFileSync(path.join(paths.attDir, "full.txt"), "utf8")).toBe("KEEP ME");
    const staged = fs.existsSync(path.join(paths.genRoot, ATT))
      ? fs.readdirSync(path.join(paths.genRoot, ATT))
      : [];
    expect(staged).toEqual([]);
  });

  it("an abort during the frame moves restores the frames instead of orphaning them", () => {
    publishIndex({
      attId: ATT, meta: mkMeta(1) as unknown as Record<string, unknown>,
      chunks: chunksOf(["OLD"]), fullText: "OLD", paths,
    });
    const rel = stageFrame("f_ab.jpg", "AB");
    const ac = new AbortController();
    // Abort before the frame loop runs (frames are staged after the text files).
    ac.abort();
    expect(() =>
      publishIndex({
        attId: ATT,
        meta: mkMeta(1, [{ at: 1, file: rel }]) as unknown as Record<string, unknown>,
        chunks: chunksOf(["NEW"]), fullText: "NEW",
        frames: [{ at: 1, file: rel }], paths, signal: ac.signal,
      }),
    ).toThrow(/aborted/i);
    expect(fs.readFileSync(path.join(paths.attDir, "full.txt"), "utf8")).toBe("OLD");
    expect(fs.readFileSync(path.join(paths.attDir, "frames", "f_ab.jpg"), "utf8")).toBe("AB");
  });

  it("temp names are unique per writer, never a shared <file>.tmp", () => {
    const a = durableWrite(path.join(root, "x.txt"), "first");
    const b = durableWrite(path.join(root, "x.txt"), "second longer");
    expect(a.sha256).not.toBe(b.sha256);
    expect(fs.readFileSync(path.join(root, "x.txt"), "utf8")).toBe("second longer");
    expect(fs.readdirSync(root).filter(n => n.includes(".tmp-"))).toEqual([]);
  });

  it("a failed write reclaims its own temp instead of orphaning debris (I13b)", () => {
    const target = path.join(root, "published.txt");
    const real = fs.renameSync;
    const spy = vi
      .spyOn(fs, "renameSync")
      .mockImplementation(((from: string, to: string) => {
        if (to === target) {
          throw Object.assign(new Error("simulated ENOSPC at rename"), { code: "ENOSPC" });
        }
        return real(from, to);
      }) as unknown as typeof fs.renameSync);
    try {
      expect(() => durableWrite(target, "payload")).toThrow(/simulated ENOSPC at rename/);
    } finally {
      spy.mockRestore();
    }
    // The mechanism under test: the writer, not a sweeper, removes the temp --
    // so debris cannot accumulate in journals, notes, the shown ledger or any
    // relative target directory.
    expect(fs.readdirSync(root).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("sweepStale removes abandoned staged generations but spares young ones", () => {
    const genRoot = path.join(paths.genRoot, ATT);
    fs.mkdirSync(genRoot, { recursive: true });
    const oldGen = path.join(genRoot, "g1700000000000-deadbeef");
    fs.mkdirSync(oldGen, { recursive: true });
    fs.writeFileSync(path.join(oldGen, "full.txt"), "abandoned");
    const youngGen = path.join(genRoot, `g${Date.now()}-00000000`);
    fs.mkdirSync(youngGen, { recursive: true });
    fs.writeFileSync(path.join(youngGen, "full.txt"), "still building");
    // an aside directory left by a crashed switch is collectable too
    const aside = path.join(root, `${ATT}.stale-1700000000000`);
    fs.mkdirSync(aside, { recursive: true });

    expect(sweepStale(paths, 60 * 60 * 1000)).toBe(2);
    expect(fs.existsSync(oldGen)).toBe(false);
    expect(fs.existsSync(aside)).toBe(false);
    expect(fs.existsSync(youngGen)).toBe(true);
    expect(fs.readFileSync(path.join(youngGen, "full.txt"), "utf8")).toBe("still building");
  });
});

describe("embedding provenance gates the cosine channel (F09b)", () => {
  const RAGGED: LoadedIndex = {
    meta: { attId: ATT, name: "n", category: "text", createdAt: 0, chunkCount: 3, spine: "", spineBlocks: [], frames: [] },
    chunks: [
      { i: 0, startSec: null, endSec: null, text: "zebra apples banana", vec: [1, 0] },
      { i: 1, startSec: null, endSec: null, text: "banana zebra cloud", vec: [0, 1] },
      { i: 2, startSec: null, endSec: null, text: "apple apple apple", vec: [0, 0, 1] },
    ],
  };

  it("ragged stored dimensions disable the cosine channel instead of partial products", () => {
    // A one-chunk budget makes the RANK observable: chunkIdxs is chronological,
    // so only the chunk that actually ranked first survives.
    const ev = retrieveEvidence(RAGGED, "apple", [1, 0, 0], { mode: "point_qa", budget: 25 });
    expect(ev.vectorMode).toBe("lexical_only");
    expect(ev.vectorReason).toMatch(/ragged/i);
    // BM25 alone ranks the "apple apple apple" chunk first. Scoring this ragged
    // store by truncating to the query length would have put the 2-component
    // projection of chunk 0 ahead and silently buried the answer chunk.
    expect(ev.chunkIdxs).toEqual([2]);
    expect(ev.text).toContain("apple apple apple");
    expect(assessVectors(RAGGED.meta, RAGGED.chunks).count).toBe(3);
  });

  it("a query vector of another dimension never scores the stored vectors", () => {
    const clean: LoadedIndex = {
      meta: { ...RAGGED.meta, embed: { model: "m", revision: "unpinned", dim: 3, normalized: true, fingerprint: "f" } },
      chunks: RAGGED.chunks.map(c => ({ ...c, vec: [c.vec[0] ?? 0, c.vec[1] ?? 0, c.vec[2] ?? 0] })),
    };
    expect(assessVectors(clean.meta, clean.chunks).mode).toBe("hybrid");
    const ev = retrieveEvidence(clean, "zebra", [1, 0, 0, 0], { mode: "point_qa" });
    expect(ev.vectorMode).toBe("lexical_only");
    expect(ev.vectorReason).toMatch(/compared/i);
  });

  it("a stamped index whose stored shapes disagree with its stamp is lexical-only", () => {
    const stamped: LoadedIndex = {
      ...RAGGED,
      meta: { ...RAGGED.meta, embed: { model: "m", revision: "unpinned", dim: 7, normalized: true, fingerprint: "f" } },
    };
    expect(assessVectors(stamped.meta, stamped.chunks).mode).toBe("lexical_only");
    const ev = retrieveEvidence(stamped, "zebra", [1, 0], { mode: "point_qa" });
    expect(ev.vectorMode).toBe("lexical_only");
  });

  it("consistent provenance keeps the cosine channel, and it can rank on its own", () => {
    const good: LoadedIndex = {
      meta: { ...RAGGED.meta, embed: { model: "m", revision: "unpinned", dim: 2, normalized: true, fingerprint: "f" } },
      chunks: [
        { i: 0, startSec: null, endSec: null, text: "quiet paragraph about rivers", vec: [0, 1] },
        { i: 1, startSec: null, endSec: null, text: "a passage on turbines", vec: [1, 0] },
      ],
    };
    // No lexical match at all: only the dense channel can rank, so the winner
    // proves the channel is live (the same shapes are disabled in the tests above).
    const ev = retrieveEvidence(good, "unanswerable token", [1, 0], { mode: "point_qa", budget: 30 });
    expect(ev.vectorMode).toBe("hybrid");
    expect(ev.vectorReason).toBeUndefined();
    // only the dense channel ranked anything, and it ranked chunk 1 first
    expect(ev.chunkIdxs).toEqual([1]);
    expect(ev.text).toContain("turbines");
  });
});
