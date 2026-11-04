/**
 * SINGLE SOURCE OF TRUTH for the golden attachment store seeds.
 *
 * `attachments.test.ts` records chat-replay fixtures 01–06 against these
 * indexes (via the production `writeIndex`), and `store-fixture.test.ts`
 * commits the resulting store BYTES under
 * `rust-backend/fixtures/attachments/store/` for the Rust replay. The two
 * MUST seed identically — if anything here changes, re-record the replay
 * fixtures AND re-record the store bytes together. Never hand-edit the
 * committed store bytes.
 */
import fs from "node:fs";
import path from "node:path";
import { indexDir, writeIndex } from "@/lib/server/attachindex/store";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

/** Deterministic embedding seam: the vector retrieval always sees this query vec. */
export const QUERY_VEC = [1, 0, 0.05];

/** 1x1 black JPEG (fixed constant — frame bytes are part of the data-url). */
export const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAAB" +
  "AAIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjV1dX" +
  "V1pnaGprbW5vb3Bxc3V3eHl6f4ABf/ZQ==";

/** att_golden1b is deliberately NEVER seeded -> missing-index honest block. */
export const ATT_IDS = ["att_golden1a", "att_golden1b", "att_golden1c", "att_golden1d"];

/** The ids that actually get store bytes (1b is the missing-index case). */
export const SEEDED_ATT_IDS = ["att_golden1a", "att_golden1c", "att_golden1d"];

function seededIndex(attId: string, name: string, category: string, chunks: IndexChunk[], frames: IndexMeta["frames"] = []): void {
  const meta: IndexMeta = {
    attId, name, category: category as IndexMeta["category"], createdAt: 0,
    chunkCount: chunks.length, spine: "", spineBlocks: [], frames,
  };
  writeIndex(attId, meta, chunks, chunks.map((c) => c.text).join("\n"));
  if (frames.length) {
    // FrameEntry.file is index-dir-relative (see nearestFrames in turn.ts).
    for (const f of frames) {
      const p = path.join(indexDir(attId), f.file);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(TINY_JPEG_B64, "base64"));
    }
  }
}

/** Seed the whole golden corpus (call AFTER removeIndex of every ATT_ID). */
export function seedAttachmentStore(): void {
  seededIndex("att_golden1a", "intro-biology.pdf", "text", [
    { i: 0, startSec: null, endSec: null, text: "Photosynthesis converts light into chemical energy in the chloroplast.", vec: [1, 0, 0] },
    { i: 1, startSec: null, endSec: null, text: "The Calvin cycle fixes carbon dioxide using ATP and NADPH.", vec: [0, 1, 0] },
    { i: 2, startSec: null, endSec: null, text: "Stomata regulate gas exchange on the underside of leaves.", vec: [0, 0, 1] },
  ]);
  seededIndex("att_golden1c", "empty-notes.txt", "text", []);
  seededIndex(
    "att_golden1d",
    "pivot-table-training.mp4",
    "video",
    [
      { i: 0, startSec: 60, endSec: 180, text: "Intro slide: course objectives.", vec: [0, 0, 1] },
      { i: 1, startSec: 6300, endSec: 6360, text: "Demo: rendering the pivot table.", vec: [0, 0, 1] },
      { i: 2, startSec: 7000, endSec: 7060, text: "Outro recap.", vec: [0, 0, 1] },
    ],
    // FrameEntry.file is resolved relative to indexDir (turn.ts nearestFrames), not framesDir.
    [{ at: 6310, file: "frames/f_golden1.jpg" }],
  );
}
