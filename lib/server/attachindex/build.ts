import { chunkSegments, chunkText } from "./chunk";
import { EMBED_MODEL_ID, EMBED_NORMALIZED, EMBED_POOLING, embedFingerprint, embedRevision, embedTexts } from "./embed";
import { buildSpine } from "./spine";
import { writeIndex } from "./store";
import type { FileCategory } from "../../files/extensions";
import type { EmbedStamp, FrameEntry, IndexMeta, TranscriptSegment } from "./types";
import type { TimelineSummary } from "./types";

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
  /**
   * F13: timeline evidence + media baseline for a media attachment, produced by
   * lib/server/attachindex/timeline.ts. Stored verbatim in meta.json so
   * retrieval, the coverage answer and the media-search-hint path all read the
   * SAME evidence instead of each re-deriving it.
   */
  observations?: Array<Record<string, unknown>>;
  timeline?: TimelineSummary;
  /**
   * F10: the upload request's own abort signal, carried all the way down the
   * chain (parse → chunk → embed → commit). A cancelled build never publishes a
   * generation, so readers keep the previous index instead of a partial one.
   */
  signal?: AbortSignal;
}

export interface BuildResult {
  chunkCount: number;
  spine: string;
  /** What retrieval will actually be able to do with the stored vectors. */
  embed: EmbedStamp | null;
  /** Honest note when embeddings were skipped or unusable. */
  embedNote?: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) throw reason;
  const e = new Error("The user aborted this request.");
  e.name = "AbortError";
  throw e;
}

/**
 * Chunk → embed → spine → persist. Runs once per oversized attachment at
 * extraction time; the chip stays "processing" while this works. Disk-full
 * (ENOSPC) surfaces as a normal extraction error, and a cancellation lands
 * before the commit — the previous index (if any) stays published (F09/F10).
 */
export async function buildAttachmentIndex(input: BuildInput): Promise<BuildResult> {
  throwIfAborted(input.signal);
  const chunks = input.segments?.length
    ? chunkSegments(input.segments)
    : chunkText(input.fullText);
  if (!chunks.length) throw new Error("Nothing to index — the content is empty.");

  throwIfAborted(input.signal);
  let embed: EmbedStamp | null = null;
  let embedNote: string | undefined;
  try {
    const vecs = await embedTexts(chunks.map(c => c.text), input.signal);
    chunks.forEach((c, i) => {
      c.vec = vecs[i] ?? [];
    });
    const dim = chunks.find(c => c.vec?.length)?.vec.length ?? 0;
    const missing = chunks.filter(c => !c.vec?.length).length;
    const wrongDim = chunks.filter(c => c.vec?.length && c.vec.length !== dim).length;
    if (dim > 0 && missing === 0 && wrongDim === 0) {
      embed = {
        model: EMBED_MODEL_ID,
        revision: embedRevision(),
        dim,
        normalized: EMBED_NORMALIZED,
        fingerprint: embedFingerprint(dim),
      };
    } else {
      // Mixed or absent vectors are not a usable hybrid index: record why, and
      // leave the stamp off so retrieval falls back to lexical honestly.
      embedNote = missing
        ? `${missing}/${chunks.length} chunks have no embedding`
        : `stored vector dimensions disagree (${dim} expected)`;
    }
  } catch (err: unknown) {
    if ((err as Error)?.name === "AbortError") throw err;
    // Embedding unavailable (offline / download blocked / model load failed):
    // the index still gets published, but as a LEXICAL index, honestly stamped
    // as such in the returned coverage rather than pretending to be hybrid.
    chunks.forEach(c => { c.vec = []; });
    embedNote = `embeddings unavailable (${(err as Error)?.message ?? String(err)})`;
  }

  // F10: abort lands before the commit. Nothing partial is ever published; the
  // staged attempt is discarded by the publisher's failure path.
  throwIfAborted(input.signal);

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
    ...(input.observations && input.observations.length ? { observations: input.observations } : {}),
    ...(input.timeline ? { timeline: input.timeline } : {}),
    ...(embed ? { embed } : {}),
  };
  writeIndex(input.attId, meta, chunks, input.fullText, input.signal);
  return { chunkCount: chunks.length, spine, embed, embedNote };
}
