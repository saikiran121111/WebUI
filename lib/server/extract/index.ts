import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  classifyFile,
  fileExtension,
  sizeLimitLabel,
  TEXT_CHAR_LIMIT,
  type FileCategory,
} from "../../files/extensions";
import { officeText } from "./office";
import { rtfToText } from "./rtf";
import { notebookText } from "./notebook";
import { archiveText } from "./archives";
import { extractStrings } from "./strings";
import { pdfText } from "./pdf";
import {
  audioPcmFromPath,
  imageToDataUrlFromPath,
  videoFramesFromPath,
  videoKeyframesFromPath,
} from "./ffmpeg";
import { transcribePcmSegments, type AsrSegment } from "./audio";
import { buildAttachmentIndex } from "../attachindex/build";
import { framesDir, removeIndex } from "../attachindex/store";
import type { FrameEntry, TranscriptSegment } from "../attachindex/types";

export interface ExtractResult {
  name: string;
  category: FileCategory;
  /** Plain-text body for text-like formats (documents, code, archives…). */
  text?: string;
  truncated?: boolean;
  pages?: number;
  /** Whisper transcript for audio (and audio tracks we could read). */
  transcript?: string;
  /** Image as a PNG data URL — only when the browser could not decode it. */
  dataUrl?: string;
  /** Sampled video frames as PNG data URLs. */
  frames?: { dataUrl: string; at: number }[];
  durationSec?: number;
  error?: string;

  /**
   * Set when the content exceeded the prompt budget and was indexed instead
   * of truncated: the full text lives under .data/attach-index/<attId>/ and
   * relevant passages are retrieved per question. text/transcript then carry
   * only a small preview.
   */
  indexed?: boolean;
  chunkCount?: number;
  spine?: string;
}

/** Client-generated attachment ids — anything else falls back to the cap path. */
const ATT_ID_RE = /^att_[a-z0-9]{4,32}$/;

/** Head of the content shown inline for indexed attachments. */
const PREVIEW_CHARS = 4000;

function asSegments(segments: AsrSegment[]): TranscriptSegment[] {
  return segments.map(s => ({ text: s.text, start: s.start, end: s.end }));
}

/**
 * The classic cap path — or the index path when the parsed text overflows
 * the prompt budget and we have a valid attachment id to key the index by.
 */
async function cappedOrIndexed(
  name: string,
  category: FileCategory,
  att: string | undefined,
  raw: string,
): Promise<ExtractResult> {
  const clean = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (att && clean.length > TEXT_CHAR_LIMIT) {
    const indexed = await indexContent(name, category, att, clean);
    return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
  }
  return { name, category, ...cap(clean) };
}

/**
 * Index oversized content. Any failure (including a full disk) cleans up the
 * partial index and surfaces as a normal extraction error — the caller never
 * sees half-written state.
 */
async function indexContent(
  name: string,
  category: FileCategory,
  attId: string,
  fullText: string,
  extra: { segments?: TranscriptSegment[]; durationSec?: number; frames?: FrameEntry[] } = {},
): Promise<Pick<ExtractResult, "indexed" | "chunkCount" | "spine">> {
  try {
    const { chunkCount, spine } = await buildAttachmentIndex({
      attId,
      name,
      category,
      fullText,
      ...extra,
    });
    return { indexed: true, chunkCount, spine };
  } catch (err: unknown) {
    removeIndex(attId);
    if ((err as NodeJS.ErrnoException)?.code === "ENOSPC") {
      throw new Error(`Out of disk space while indexing ${name} — free some space and retry`);
    }
    throw err;
  }
}

function cap(text: string, limit = TEXT_CHAR_LIMIT): { text: string; truncated: boolean } {
  const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (clean.length <= limit) return { text: clean, truncated: false };
  return { text: clean.slice(0, limit), truncated: true };
}

/** Scratch space for the buffer wrapper — same dir ffmpeg uses. */
const TMP_DIR = path.join(process.cwd(), ".data", "tmp");

/**
 * Text-like files are read only up to this many bytes. The prompt caps at
 * TEXT_CHAR_LIMIT characters anyway, so a multi-GB .log never has to be
 * buffered whole — and 2 MB of bytes is always more than enough characters to
 * hit the cap, so the truncation flag stays honest.
 */
const TEXT_READ_BYTES = 2 * 1024 * 1024;

/**
 * Buffer-based parsers (pdf/office/archive/legacy) need the whole file in
 * memory; guard absurd sizes so a movie rip renamed .pdf can't OOM the
 * server. Real documents of these types are nowhere near this.
 */
const MAX_PARSED_BYTES = 512 * 1024 * 1024;

function readHead(srcPath: string, maxBytes: number): { buf: Buffer; partial: boolean } {
  const fd = fs.openSync(srcPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { buf, partial: size > len };
  } finally {
    fs.closeSync(fd);
  }
}

function textLikeResult(
  name: string,
  category: FileCategory,
  buf: Buffer,
  partial: boolean,
): ExtractResult {
  const utf8 = buf.toString("utf8");
  const raw =
    category === "rtf" ? rtfToText(utf8) :
    category === "notebook" ? notebookText(utf8) :
    utf8;
  const capped = cap(raw);
  return { name, category, ...capped, truncated: capped.truncated || partial };
}

/**
 * Server-side extraction for every attachment category the browser cannot
 * handle on its own (documents, archives, audio, video, exotic images).
 *
 * This is the path-based core: the upload has already been streamed to a
 * scratch file, and ffmpeg/whisper read the media straight from that path —
 * a multi-GB video is seeked inside the file, never buffered whole in RAM.
 */
export async function extractFileFromPath(
  name: string,
  srcPath: string,
  attId?: string,
): Promise<ExtractResult> {
  const category = classifyFile(name);
  const ext = fileExtension(name).toLowerCase();
  const att = attId && ATT_ID_RE.test(attId) ? attId : undefined;

  switch (category) {
    case "text":
    case "rtf":
    case "notebook": {
      // Indexing needs the WHOLE file; the 2 MB head read only ever existed to
      // fill the prompt cap, which indexed content no longer uses.
      const size = fs.statSync(srcPath).size;
      if (att && size > TEXT_READ_BYTES) {
        const raw = fs.readFileSync(srcPath, "utf8");
        const clean = (category === "rtf" ? rtfToText(raw) : category === "notebook" ? notebookText(raw) : raw)
          .replace(/\r\n/g, "\n")
          .trim();
        if (!clean) return { name, category, text: "", truncated: false };
        const indexed = await indexContent(name, category, att, clean);
        return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
      }
      const { buf, partial } = readHead(srcPath, TEXT_READ_BYTES);
      if (att && !partial) {
        // Fully in hand but over the prompt budget (multi-byte text): index
        // the WHOLE decoded text, not the capped one textLikeResult would cut.
        const utf8 = buf.toString("utf8");
        const raw =
          category === "rtf" ? rtfToText(utf8) :
          category === "notebook" ? notebookText(utf8) :
          utf8;
        const clean = raw.replace(/\r\n/g, "\n").trim();
        if (clean.length > TEXT_CHAR_LIMIT) {
          const indexed = await indexContent(name, category, att, clean);
          return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
        }
      }
      return textLikeResult(name, category, buf, partial);
    }

    case "pdf":
    case "office":
    case "archive":
    case "legacy": {
      const size = fs.statSync(srcPath).size;
      if (size > MAX_PARSED_BYTES) {
        throw new Error(
          `${name} is too large to read as a ${category} document ` +
          `(limit ${sizeLimitLabel(MAX_PARSED_BYTES)})`,
        );
      }
      const buf = fs.readFileSync(srcPath);

      if (category === "pdf") {
        const { text, pages } = await pdfText(buf);
        const r = await cappedOrIndexed(name, category, att, text);
        return { ...r, pages };
      }
      if (category === "office") {
        const text = officeText(buf, ext);
        if (!text.trim()) throw new Error("No readable text found in this document");
        return await cappedOrIndexed(name, category, att, text);
      }
      if (category === "archive") {
        // The uploaded name is passed along because bare .bz2/.xz streams store
        // no filenames — the inner name only exists in the file name itself.
        return await cappedOrIndexed(name, category, att, await archiveText(buf, ext, name));
      }
      // Legacy .doc/.xls/.ppt/.mat have no public parser here — recover the
      // printable runs, which is what those formats store text as anyway.
      const text = extractStrings(buf);
      if (!text.trim()) throw new Error("No readable text found in this file");
      return await cappedOrIndexed(name, category, att, text);
    }

    case "image":
      return { name, category, dataUrl: await imageToDataUrlFromPath(srcPath) };

    case "audio": {
      const pcm = await audioPcmFromPath(srcPath);
      const { text: transcript, segments } = await transcribePcmSegments(pcm);
      if (!transcript) throw new Error("No speech detected in this audio file");
      if (att && transcript.length > TEXT_CHAR_LIMIT) {
        const indexed = await indexContent(name, category, att, transcript, {
          segments: asSegments(segments),
          durationSec: pcm.length / 16000,
        });
        return {
          name, category, ...indexed,
          transcript: transcript.slice(0, PREVIEW_CHARS),
          truncated: true,
          durationSec: pcm.length / 16000,
        };
      }
      return { name, category, transcript, ...cap(transcript) };
    }

    case "video": {
      const { frames, durationSec } = await videoFramesFromPath(srcPath);
      // The audio track carries narration — transcribe it when the clip has
      // one so the model hears the video, not just its sampled frames.
      let transcript: string | undefined;
      let segments: AsrSegment[] = [];
      try {
        const r = await transcribePcmSegments(await audioPcmFromPath(srcPath));
        transcript = r.text || undefined;
        segments = r.segments;
      } catch { /* no (decodable) audio track — frames only */ }
      if (!transcript) return { name, category, frames, durationSec };

      if (att && transcript.length > TEXT_CHAR_LIMIT) {
        // Long lecture: keep scene-change keyframes on disk next to the index
        // so visual questions about a time window can pull the right frame.
        let keyframes: FrameEntry[] = [];
        try {
          keyframes = (await videoKeyframesFromPath(srcPath, framesDir(att))).map(
            f => ({ at: f.at, file: "frames/" + f.name }),
          );
        } catch { /* keyframes are best-effort — the transcript index still works */ }
        const indexed = await indexContent(name, category, att, transcript, {
          segments: asSegments(segments),
          durationSec,
          frames: keyframes,
        });
        return {
          name, category, ...indexed, frames, durationSec,
          transcript: transcript.slice(0, PREVIEW_CHARS),
          truncated: true,
        };
      }
      const capped = cap(transcript);
      return { name, category, frames, durationSec, transcript: capped.text, truncated: capped.truncated };
    }

    default:
      throw new Error("Unsupported file type: " + (ext ? "." + ext : name));
  }
}

/**
 * Buffer convenience wrapper around the path-based core — keeps the original
 * contract for tests and any caller that already holds the bytes.
 */
export async function extractFile(name: string, buf: Buffer): Promise<ExtractResult> {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const ext = fileExtension(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  const src = path.join(TMP_DIR, "b_" + randomBytes(6).toString("hex") + (ext ? "." + ext : ""));
  try {
    fs.writeFileSync(src, buf);
    return await extractFileFromPath(name, src);
  } finally {
    try { fs.rmSync(src, { force: true }); } catch { /* ignore */ }
  }
}
