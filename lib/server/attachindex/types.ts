import type { FileCategory } from "../../files/extensions";

/** One Whisper segment with its position in the recording. */
export interface TranscriptSegment {
  text: string;
  start: number;
  end: number | null;
}

/** One indexed passage: text + its place in the recording + embedding. */
export interface IndexChunk {
  /** 0-based position in the document (== chronological order). */
  i: number;
  startSec: number | null;
  endSec: number | null;
  text: string;
  /** L2-normalized embedding — dot product == cosine similarity. */
  vec: number[];
}

/** A keyframe image stored on disk under the index dir. */
export interface FrameEntry {
  at: number;
  /** Path relative to the index dir (e.g. "frames/f_00012.jpg"). */
  file: string;
}

/** One block of the zero-LLM structural spine (table of contents). */
export interface SpineBlock {
  startSec: number | null;
  endSec: number | null;
  /** Inclusive chunk range this block covers — drives sequential retrieval. */
  chunkFrom: number;
  chunkTo: number;
  keywords: string[];
  opening: string;
  closing: string;
}

export interface IndexMeta {
  attId: string;
  name: string;
  category: FileCategory;
  createdAt: number;
  durationSec?: number;
  chunkCount: number;
  /** Compact table of contents — always injected for indexed attachments. */
  spine: string;
  spineBlocks: SpineBlock[];
  frames: FrameEntry[];
}

export interface LoadedIndex {
  meta: IndexMeta;
  chunks: IndexChunk[];
}
