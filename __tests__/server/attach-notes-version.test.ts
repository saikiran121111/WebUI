/**
 * I24 (2026-11-08): the course-notes cache is keyed to a content+model
 * fingerprint. Pins:
 *  - notesVersion is deterministic, integer-only (float timestamps must
 *    never enter it — the Rust mirror formats them differently), and
 *    changes with the model, the chunk set, or the spine-block boundaries;
 *  - notes.json carries `version` AFTER `createdAt` (the existing
 *    `{"notes":…,"createdAt":…}` prefix bytes stay);
 *  - readNotes with an expectedVersion refuses a stale stamp; versionless
 *    reads stay notes-route-verbatim (version-agnostic);
 *  - generateNotes NEVER caches a degraded run (any block fell back to the
 *    spine opening/closing line) — but still returns it for this turn, and
 *    the next clean run caches normally.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { notesVersion, generateNotes } from "@/lib/server/attachindex/notes";
import { indexDir, readNotes, removeIndex, writeIndex, writeNotes } from "@/lib/server/attachindex/store";
import type { LoadedIndex } from "@/lib/server/attachindex/types";

vi.mock("@/lib/server/settings", () => ({
  llmApiUrl: () => "http://127.0.0.1:9/v1/chat/completions",
  llmApiKey: () => "test-key",
}));

function loaded(nChunks = 2, extra = "", blocks: { chunkFrom: number; chunkTo: number }[] = [{ chunkFrom: 0, chunkTo: 1 }]): LoadedIndex {
  const chunks = Array.from({ length: nChunks }, (_, i) => ({
    i, startSec: i * 60, endSec: (i + 1) * 60, text: `chunk body ${i}${extra}`, vec: [],
  }));
  return {
    meta: {
      attId: "att_notesver1", name: "v.mp4", category: "video", createdAt: 0,
      durationSec: 120, chunkCount: chunks.length, spine: "",
      spineBlocks: blocks.map((b) => ({
        startSec: b.chunkFrom * 60, endSec: (b.chunkTo + 1) * 60, chunkFrom: b.chunkFrom, chunkTo: b.chunkTo,
        keywords: ["cell cycle"], opening: "we begin with the membrane", closing: "and the cycle closes",
      })),
      frames: [],
    },
    chunks,
  };
}

describe("notesVersion fingerprint", () => {
  it("exact deterministic format (integer-only fields)", () => {
    const v = notesVersion(loaded(), "default");
    // chunks: "chunk body 0"(12) + "chunk body 1"(12) = 24 chars.
    expect(v).toBe("v1|default|2|24|1:0-1");
  });
  it("model switch, chunk-set change, and block-boundary shift each invalidate", () => {
    const base = notesVersion(loaded(), "default");
    expect(notesVersion(loaded(), "qwen2.5-7b")).not.toBe(base);
    expect(notesVersion(loaded(3), "default")).not.toBe(base);
    expect(notesVersion(loaded(2, "X"), "default")).not.toBe(base);
    expect(notesVersion(loaded(2, "", [{ chunkFrom: 0, chunkTo: 0 }, { chunkFrom: 1, chunkTo: 1 }]), "default")).not.toBe(base);
  });
});

describe("notes envelope (store, version-after-createdAt)", () => {
  const attId = "att_notesver1";
  afterAll(() => removeIndex(attId));

  it("raw JSON keeps the pinned prefix and appends version last", () => {
    writeIndex(attId, {
      attId, name: "v.mp4", category: "video", createdAt: 0, chunkCount: 0,
      spine: "", spineBlocks: [], frames: [],
    }, [], "");
    writeNotes(attId, "cached body", "v1|default|2|24|1:0-1");
    const raw = fs.readFileSync(path.join(indexDir(attId), "notes.json"), "utf8");
    expect(raw).toMatch(/^\{"notes":"cached body","createdAt":\d+,"version":"v1\|default\|2\|24\|1:0-1"\}$/);
    expect(readNotes(attId, "v1|default|2|24|1:0-1")).toBe("cached body");
    expect(readNotes(attId, "v1|othermodel|2|24|1:0-1")).toBeNull(); // model switch ⇒ stale
    expect(readNotes(attId)).toBe("cached body"); // versionless: verbatim, as before
    removeIndex(attId);
    expect(readNotes(attId, "v1|default|2|24|1:0-1")).toBeNull();
  });
});

describe("generateNotes caching honesty", () => {
  const attId = "att_notesgen1";
  afterAll(() => {
    removeIndex(attId);
    vi.unstubAllGlobals();
  });

  it("a degraded run is returned but NEVER cached; a clean run caches", async () => {
    const index = loaded();
    writeIndex(attId, index.meta, index.chunks, index.chunks.map((c) => c.text).join("\n"));

    // Model down (HTTP 500): the fallback text must still answer THIS turn…
    vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => null }));
    const degraded = await generateNotes(attId, index, undefined, "m-a");
    expect(degraded).toContain("we begin with the membrane ... and the cycle closes");
    // …but nothing was written — not version-keyed, not even versionless.
    expect(readNotes(attId, notesVersion(index, "m-a"))).toBeNull();
    expect(readNotes(attId)).toBeNull();

    // Model up: the same call now distills and caches under (index, model).
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: `NOTES FOR ${body.model}` } }] }) };
    });
    const clean = await generateNotes(attId, index, undefined, "m-a");
    expect(clean).toContain("NOTES FOR m-a");
    expect(readNotes(attId, notesVersion(index, "m-a"))).toBe(clean);
    // A different model must NOT inherit that cache.
    expect(readNotes(attId, notesVersion(index, "m-b"))).toBeNull();
  });
});
