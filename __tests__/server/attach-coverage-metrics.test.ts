/**
 * F14 - the coverage line the model actually reads.
 *
 * Every indexed attachment block must state, in machine-readable form, WHAT
 * THIS TURN ACTUALLY SAW: how many of the indexed passages were served, how
 * many matched but were withheld by the turn budget, whether ranking used a
 * dense channel or lexical matching only, and how many keyframes were served.
 * A file existing on disk is not evidence that any given part of it was read.
 *
 * ASCII-only law: the coverage sentence is mirrored BYTE-IDENTICALLY by
 * ruke-attach turn.rs (store_compat fixture_01 pins that equality), so this
 * pin also checks that the emitted sentence contains no non-ASCII character.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Tiny evidence budget so budget pressure (the withheld clause) is real and
// deterministic instead of dependent on fixture size.
vi.hoisted(() => {
  process.env.ATTACH_RETRIEVE_CHARS = "600";
});

// Offline embedder: returns no vector for a plain query and a 3-dim vector for
// the HYBRID probe, so both ranking modes are exercised without weights.
vi.mock("@/lib/server/attachindex/embed", () => ({
  embedOne: async (text: string) => (text.includes("HYBRIDPROBE") ? [1, 0, 0] : []),
  embedTexts: async (texts: string[]) =>
    texts.map(() => (texts[0].includes("HYBRIDPROBE") ? [1, 0, 0] : [])),
}));

import { buildAttachmentTurn } from "@/lib/server/attachindex/turn";
import { indexDir, readIndex, removeIndex, writeIndex } from "@/lib/server/attachindex/store";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

const LEX = "att_covm1";
const HYB = "att_covm2";
const VID = "att_covm3";
const SMALL = "att_covm4";

function pad(text: string, len: number): string {
  return text.length >= len ? text.slice(0, len) : text + "x".repeat(len - text.length);
}

function seed(
  attId: string,
  name: string,
  category: IndexMeta["category"],
  opts: { n: number; marker: string; vec: number[] | null; timed: boolean; stamp?: boolean; frames?: number; len?: number },
) {
  const chunks: IndexChunk[] = Array.from({ length: opts.n }, (_, i) => ({
    i,
    startSec: opts.timed ? i * 30 : null,
    endSec: opts.timed ? i * 30 + 30 : null,
    text: pad(`${opts.marker} passage ${i} about the zephyr widget design`, opts.len ?? 300),
    vec: opts.vec ?? [],
  }));
  const meta: IndexMeta = {
    attId,
    name,
    category,
    createdAt: 0,
    chunkCount: opts.n,
    durationSec: opts.timed ? opts.n * 30 : undefined,
    spine: "",
    spineBlocks: [],
    frames: Array.from({ length: opts.frames ?? 0 }, (_, k) => ({
      at: k * 30 + 15,
      file: `frames/f_${k}.jpg`,
    })),
  };
  if (opts.stamp) {
    meta.embed = {
      model: "test-embed",
      revision: "unpinned",
      dim: 3,
      normalized: true,
      fingerprint: "test-fingerprint",
    };
  }
  for (const f of meta.frames) {
    const abs = path.join(indexDir(attId), f.file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  writeIndex(attId, meta, chunks, chunks.map((c) => c.text).join("\n"));
}

async function blockFor(attId: string, name: string, category: IndexMeta["category"], query: string): Promise<string> {
  const msgs = [
    {
      role: "user",
      content: [
        { type: "text", text: query },
        { type: "attachment_ref", att_id: attId, name, category },
      ],
    },
  ];
  const n = await buildAttachmentTurn(msgs as never[], 0, query);
  expect(n).toBeGreaterThan(0);
  const sys = (msgs as { role: string; content: unknown }[])
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .join("\n");
  expect(sys).toContain(`<knowledge_index name="${name}">`);
  return sys;
}

const coverageLine = (text: string): string => {
  const m = text.match(/\[coverage:[^\]]*\]/);
  expect(m, "the block must carry a [coverage: ...] line").not.toBeNull();
  return String(m && m[0]);
};

beforeAll(() => {
  for (const id of [LEX, HYB, VID, SMALL]) removeIndex(id);
  seed(LEX, "covm-a.txt", "text", { n: 8, marker: "zephyr", vec: null, timed: false });
  seed(HYB, "covm-b.txt", "text", { n: 8, marker: "HYBRIDPROBE zephyr", vec: [1, 0, 0], timed: false, stamp: true });
  seed(VID, "covm-c.mp4", "video", { n: 8, marker: "zephyr", vec: null, timed: true, frames: 3 });
  seed(SMALL, "covm-d.txt", "text", { n: 2, marker: "zephyr", vec: null, timed: false, len: 120 });
});

afterAll(() => {
  for (const id of [LEX, HYB, VID, SMALL]) removeIndex(id);
  delete process.env.ATTACH_RETRIEVE_CHARS;
});

describe("coverage line: what this turn actually read (F14)", async () => {
  it("counts served passages against the indexed total and names the withheld ones", async () => {
    const line = coverageLine(await blockFor(LEX, "covm-a.txt", "text", "everything about the zephyr widget design"));
    const m = line.match(/^\[coverage: (\d+) of (\d+) indexed passages of "covm-a\.txt" were shown this turn/);
    expect(m, line).not.toBeNull();
    const shown = Number(m && m[1]);
    expect(Number(m && m[2])).toBe(8);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(8);
    expect(line).toContain("further matched passages were withheld by this turn");
    expect(line).toContain("ask to continue and a different set is served");
    expect(line).toContain("-- anything outside this selection was NOT read this turn]");
  });

  it("a lexical-only pass is reported as lexical only, with its real reason", async () => {
    const line = coverageLine(await blockFor(LEX, "covm-a.txt", "text", "everything about the zephyr widget design"));
    expect(line).toContain("; ranking mode: lexical only (no vectors stored)");
    expect(line).not.toContain("semantic");
  });

  it("a stamped, consistent vector store reports the semantic channel honestly", async () => {
    const line = coverageLine(await blockFor(HYB, "covm-b.txt", "text", "HYBRIDPROBE zephyr widget design"));
    expect(line).toContain("; ranking mode: semantic + lexical");
    expect(line).not.toContain("lexical only");
  });

  it("served keyframes are counted against the saved keyframes", async () => {
    const line = coverageLine(await blockFor(VID, "covm-c.mp4", "video", "what does the zephyr widget passage cover"));
    expect(line).toMatch(/; \d of 3 saved keyframes shown/);
    const idx = readIndex(VID);
    expect(idx && idx.meta.frames).toHaveLength(3);
  });

  it("when the budget withheld nothing, the line says so instead of inventing a gap", async () => {
    const line = coverageLine(await blockFor(SMALL, "covm-d.txt", "text", "the zephyr widget design"));
    expect(line).toContain("no matched passage was withheld from this turn");
    expect(line).toContain("of 2 indexed passages");
  });

  it("the coverage sentence stays ASCII so the Rust mirror stays byte-exact", async () => {
    for (const [attId, name, category, q] of [
      [LEX, "covm-a.txt", "text", "everything about the zephyr widget design"],
      [VID, "covm-c.mp4", "video", "what does the zephyr widget passage cover"],
    ] as [string, string, IndexMeta["category"], string][]) {
      const line = coverageLine(await blockFor(attId, name, category, q));
      expect(line.match(/[^\x20-\x7e]/), "non-ASCII in coverage line: " + line).toBeNull();
    }
  });
});
