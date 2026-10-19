import { chunkSegments, chunkText } from "./chunk";
import { embedTexts } from "./embed";
import { buildSpine } from "./spine";
import { writeIndex } from "./store";
import type { FileCategory } from "../../files/extensions";
import type { FrameEntry, IndexMeta, TranscriptSegment } from "./types";

export interface BuildInput {
  attId: string;
  name: string;
  category: FileCategory;
  /** Complete text — stored verbatim in full.txt, never truncated. */
  fullText: string;
  /** Whisper segments when the source is audio/video (enables timestamps). */
  segments?: TranscriptSegment[];
  durationSec?: number;
  /** Keyframes already written into <index>/frames by the extract branch. */
  frames?: FrameEntry[];
}

export interface BuildResult {
  chunkCount: number;
  spine: string;
}

/**
 * Chunk → embed → spine → persist. Runs once per oversized attachment at
 * extraction time; the chip stays "processing" while this works. Disk-full
 * (ENOSPC) surfaces as a normal extraction error and the route cleans up.
 */
export async function buildAttachmentIndex(input: BuildInput): Promise<BuildResult> {
  const chunks = input.segments?.length
    ? chunkSegments(input.segments)
    : chunkText(input.fullText);
  if (!chunks.length) throw new Error("Nothing to index — the content is empty.");

  const vecs = await embedTexts(chunks.map(c => c.text));
  chunks.forEach((c, i) => {
    c.vec = vecs[i] ?? [];
  });

  const { blocks, text: spine } = buildSpine(chunks);
  const meta: IndexMeta = {
    attId: input.attId,
    name: input.name,
    category: input.category,
    createdAt: Date.now(),
    durationSec: input.durationSec,
    chunkCount: chunks.length,
    spine,
    spineBlocks: blocks,
    frames: input.frames ?? [],
  };
  writeIndex(input.attId, meta, chunks, input.fullText);
  return { chunkCount: chunks.length, spine };
}
