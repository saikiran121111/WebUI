/**
 * F10 - the cancellation chain for attachment indexing.
 *
 * upload -> parse -> chunk -> embed -> commit must all obey the caller's
 * signal, and a cancelled or failed build must never damage an index that is
 * already published. Everything here is offline: ATTACH_EMBED=off selects the
 * documented lexical mode, so no weights are downloaded and no model runs.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexContent } from "@/lib/server/extract/index";
import {
  hasIndex,
  indexWriteInFlight,
  publishPaths,
  readIndex,
  removeIndex,
} from "@/lib/server/attachindex/store";

const ATT = "att_cancel01";
const PREV = process.env.ATTACH_EMBED;

function longText(marker: string, sentences = 90): string {
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    out.push(`${marker} sentence ${i} explains ${marker} behaviour in enough words to form a real chunk of text.`);
  }
  return out.join(" ");
}

function stagedFor(attId: string): string[] {
  const dir = path.join(publishPaths(attId).genRoot, attId);
  try { return fs.readdirSync(dir); } catch { return []; }
}

beforeAll(() => {
  process.env.ATTACH_EMBED = "off";
  removeIndex(ATT);
});

afterAll(() => {
  removeIndex(ATT);
  if (PREV === undefined) delete process.env.ATTACH_EMBED;
  else process.env.ATTACH_EMBED = PREV;
});

describe("indexing obeys cancellation (F10)", () => {
  it("a pre-aborted build publishes nothing and reports the lexical mode honestly", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await indexContent("doc.txt", "text", ATT, longText("fresh"), {}, ac.signal)
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.name).toBe("AbortError");
    expect(hasIndex(ATT)).toBe(false);
    expect(stagedFor(ATT)).toEqual([]);
  });

  it("a completed lexical build indexes, stamps no vectors, and says so", async () => {
    const res = await indexContent("doc.txt", "text", ATT, longText("first"), {});
    expect(res.indexed).toBe(true);
    expect(res.chunkCount).toBeGreaterThan(1);
    expect(res.embedNote).toMatch(/embeddings disabled/i);
    const idx = readIndex(ATT);
    expect(idx).not.toBeNull();
    const nChunks = res.chunkCount ?? 0;
    expect(nChunks).toBeGreaterThan(1);
    expect(idx!.chunks).toHaveLength(nChunks);
    expect(idx!.meta.embed).toBeUndefined();
    // F79: the build-time reason is PERSISTED, so every later turn quotes the
    // real cause of the degradation on disk, not a generic phrase.
    expect(idx!.meta.embedNote).toMatch(/embeddings disabled \(ATTACH_EMBED=off\)/);
    expect(idx!.vectors?.mode).toBe("lexical_only");
    expect(idx!.vectors?.reason).toMatch(/embeddings disabled \(ATTACH_EMBED=off\)/);
    expect(idx!.chunks.every(c => !c.vec?.length)).toBe(true);
  });

  it("an aborted re-index leaves the PREVIOUS index exactly as it was", async () => {
    const before = readIndex(ATT);
    expect(before).not.toBeNull();
    const ac = new AbortController();
    ac.abort();
    const err = await indexContent("doc.txt", "text", ATT, longText("replacement", 200), {}, ac.signal)
      .then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("AbortError");

    const after = readIndex(ATT);
    expect(after).not.toBeNull();
    expect(after!.chunks).toHaveLength(before!.chunks.length);
    expect(after!.chunks.map(c => c.text)).toEqual(before!.chunks.map(c => c.text));
    expect(after!.meta.chunkCount).toBe(before!.meta.chunkCount);
    expect(stagedFor(ATT)).toEqual([]);
  });

  it("one writer per attachment: a concurrent build waits instead of interleaving", async () => {
    const started: string[] = [];
    const a = indexContent("a.txt", "text", ATT, longText("alpha", 40), {})
      .then(r => { started.push("a"); return r; });
    expect(indexWriteInFlight(ATT)).toBe(true);
    const b = indexContent("b.txt", "text", ATT, longText("beta", 40), {})
      .then(r => { started.push("b"); return r; });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.indexed).toBe(true);
    expect(rb.indexed).toBe(true);
    expect(started).toEqual(["a", "b"]);
    expect(indexWriteInFlight(ATT)).toBe(false);
    // the published generation is whichever build committed LAST, and it is whole
    const idx = readIndex(ATT);
    expect(idx!.meta.chunkCount).toBe(idx!.chunks.length);
  });
});