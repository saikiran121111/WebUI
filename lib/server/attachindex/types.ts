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

/**
 * Provenance of the vectors stored in an index (F09b). A vector is only
 * comparable with vectors from the same model/pooling/normalization pipeline,
 * so the stamp is part of the durable format: readers reject a mismatch
 * instead of scoring a partial dot product over two unrelated bases.
 * `revision` is "unpinned" when the runtime does not report one — never a
 * fabricated hash.
 */
export interface EmbedStamp {
  model: string;
  revision: string;
  dim: number;
  normalized: boolean;
  /** Pipeline fingerprint (model + pooling + normalization + chunking). */
  fingerprint: string;
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
  /**
   * F13/P7: timeline evidence produced by the capability backend for a media
   * attachment (scene anchors, and later OCR/visual/audio observations). Each
   * entry is the Python Observation shape (start, end, kind, text, provider,
   * frame_ref, audio_state, searchable). Absent = no evidence beyond the
   * transcript/keyframes the TS extractor produced on its own.
   */
  observations?: Array<Record<string, unknown>>;
  /**
   * What the media container ACTUALLY holds plus what has ACTUALLY been
   * examined. The pointer to the durable timeline record is `recordDir`,
   * relative to this index dir; it is a pointer, not a promise -- use
   * timeline.timelineRecordPath() to confirm the record is really there.
   */
  timeline?: TimelineSummary;
  /** Embedding provenance; absent for indexes written before the stamp existed. */
  embed?: EmbedStamp;
}

/** One container stream as the probe actually reported it (never a guess). */
export interface TimelineStream {
  fileIndex: number;
  streamIndex: number;
  /** video | audio | subtitle | data | other */
  type: string;
  /** ISO-639-2 tag the CONTAINER declared, "" when it declared none. */
  language: string;
  /** Per-stream start offset in seconds, null when the probe reported none. */
  startSec: number | null;
}

/** Bounded mirror of the Python Coverage record (units stay honest). */
export interface TimelineCoverage {
  units: string;
  totalSec: number | null;
  /** Seconds actually examined, summed from the merged spans. */
  examinedSec: number;
  complete: boolean;
  examined: Array<[number, number]>;
  unexamined: Array<[number, number]>;
  note: string;
}

/**
 * Durable media baseline for one attachment: identity, real stream facts, and
 * the coverage of what has been examined so far. This is what lets a deeper
 * follow-up question reuse the work instead of re-uploading.
 */
export interface TimelineSummary {
  sourceHash: string;
  /** How the identity was computed -- never a fabricated sha256. */
  hashAlgorithm: "sha256" | "size+mtime";
  durationSec: number;
  streams: TimelineStream[];
  rotationDeg: number;
  hasAudioTrack: boolean;
  subtitleTracks: string[];
  streamStartOffsets: Record<string, number>;
  coverage: TimelineCoverage;
  /** Capability + job state that produced the record, for honest reporting. */
  capability: string;
  jobState: string;
  /** Result of the scene-cut scan, or why it did not run. */
  sceneScan: { state: string; reason: string; scannedSec: number; truncated: boolean };
  /** Relative dir holding timeline.json inside this index dir. */
  recordDir: string;
  updatedAt: number;
}

/** What retrieval may actually do with the stored vectors. */
export interface VectorAssessment {
  mode: "hybrid" | "lexical_only";
  reason?: string;
  count: number;
  dim: number | null;
  declaredDim: number | null;
  model: string | null;
  fingerprint: string | null;
}

export interface LoadedIndex {
  meta: IndexMeta;
  chunks: IndexChunk[];
  /** Computed at read time from meta + chunk shapes (never trusted from disk). */
  vectors?: VectorAssessment;
}
