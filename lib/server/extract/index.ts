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
import { sniffMagic } from "./sniff";
import { decodeText, type DecodedText } from "../../files/encoding";
import {
  audioPcmFromPath,
  imageToDataUrlFromPath,
  videoFramesFromPath,
  videoKeyframesFromPath,
} from "./ffmpeg";
import { transcribePcmSegments, type AsrSegment } from "./audio";
import { buildAttachmentIndex } from "../attachindex/build";
import { framesDir, hasIndex, removeIndex } from "../attachindex/store";
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
  /**
   * Sampled video frames as PNG data URLs.
   * CAUTION — `at` is unit-polymorphic: SECONDS for video frames, but the
   * 1-based PAGE NUMBER for extra pages of multi-page images (tiff/gif). Any
   * consumer pairing frames with time windows must check `category` first.
   */
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
 * Index oversized content; any failure surfaces as a normal extraction error.
 *
 * I26: a FAILED re-index of an attachment that already has a good index must
 * not destroy it. The build only lands its files at the very end (every file
 * written atomically), so an interrupted build leaves the previous consistent
 * index untouched — cleaning unconditionally here would delete healthy state
 * the failure never touched. Only an attachment that had no index before this
 * run gets its partial debris cleaned up.
 */
async function indexContent(
  name: string,
  category: FileCategory,
  attId: string,
  fullText: string,
  extra: { segments?: TranscriptSegment[]; durationSec?: number; frames?: FrameEntry[] } = {},
): Promise<Pick<ExtractResult, "indexed" | "chunkCount" | "spine">> {
  const hadIndex = hasIndex(attId);
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
    if (!hadIndex) removeIndex(attId);
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

/** RTF/notebook bodies need a text transform before they read as prose. */
function transformText(category: FileCategory, text: string): string {
  return category === "rtf" ? rtfToText(text)
    : category === "notebook" ? notebookText(text)
    : text;
}

/**
 * I10: a best-guess decode is a claim, not a fact — say it inside the text
 * itself so the model never treats guessed characters as ground truth.
 */
function encodingNote(dec: DecodedText): string {
  return dec.lossy
    ? `[encoding: this file is not valid UTF-8 — decoded as ${dec.encoding}, so some characters may be wrong]\n\n`
    : "";
}

function textLikeResult(
  name: string,
  category: FileCategory,
  dec: DecodedText,
  partial: boolean,
): ExtractResult {
  const capped = cap(transformText(category, dec.text));
  return {
    name,
    category,
    text: capped.text ? encodingNote(dec) + capped.text : capped.text,
    truncated: capped.truncated || partial,
  };
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
  mime?: string,
): Promise<ExtractResult> {
  let category = classifyFile(name, mime);
  const ext = fileExtension(name).toLowerCase();
  const att = attId && ATT_ID_RE.test(attId) ? attId : undefined;

  // I09: extensions lie — a PNG renamed .pdf reached the PDF reader and an
  // "No readable text" error followed, silently losing vision-readable
  // content. Strong magic (unambiguous signatures) overrides the extension;
  // weak container magic only rescues names that told us nothing ("unknown")
  // or a .txt that is really a ZIP. Office extensions already mean "ZIP
  // container", so weak PK never overrides them.
  const sniffed = sniffMagic(readHead(srcPath, 64).buf);
  if (sniffed && sniffed.category !== category) {
    if (
      sniffed.strong ||
      category === "unknown" ||
      (category === "text" && !sniffed.strong && sniffed.category === "archive")
    ) {
      category = sniffed.category;
    }
  }

  switch (category) {
    case "text":
    case "rtf":
    case "notebook": {
      // I10: decode by content (BOM / UTF-16 heuristic / cp1252 fallback),
      // never `toString("utf8")` — a UTF-16 or cp1252 file used to arrive as
      // NUL-corrupted or mojibake'd text with no warning.
      // Indexing needs the WHOLE file; the 2 MB head read only ever existed to
      // fill the prompt cap, which indexed content no longer uses.
      const size = fs.statSync(srcPath).size;
      if (att && size > TEXT_READ_BYTES) {
        const dec = decodeText(fs.readFileSync(srcPath));
        const body = transformText(category, dec.text).replace(/\r\n/g, "\n").trim();
        if (!body) return { name, category, text: "", truncated: false };
        const clean = encodingNote(dec) + body;
        const indexed = await indexContent(name, category, att, clean);
        return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
      }
      const { buf, partial } = readHead(srcPath, TEXT_READ_BYTES);
      const dec = decodeText(buf);
      if (att && !partial) {
        // Fully in hand but over the prompt budget (multi-byte text): index
        // the WHOLE decoded text, not the capped one textLikeResult would cut.
        const clean = encodingNote(dec) + transformText(category, dec.text).replace(/\r\n/g, "\n").trim();
        if (clean.length > TEXT_CHAR_LIMIT) {
          const indexed = await indexContent(name, category, att, clean);
          return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
        }
      }
      return textLikeResult(name, category, dec, partial);
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
        // I06: a scanned page has no text layer. Silently returning an empty
        // extraction claimed a completed read that never happened. Coverage is
        // stated up front, an all-scan PDF raises an honest error naming the
        // real option (send the page as an image), and partial coverage goes
        // INTO the indexed text so retrieved passages carry the caveat too.
        const { text, pages, pagesWithoutText } = await pdfText(buf);
        if (!text.trim()) {
          if (pages > 0) {
            throw new Error(
              `${name} has no text layer — all ${pages} page(s) are scanned images. ` +
              `No OCR engine is installed, so their contents cannot be read as text; ` +
              `send the page you care about as an image and the vision model can read it.`,
            );
          }
          throw new Error("No readable text found in this PDF");
        }
        let full = text;
        if (pagesWithoutText.length) {
          const listed = pagesWithoutText.length <= 15
            ? pagesWithoutText.join(", ")
            : pagesWithoutText.length + " pages";
          full =
            `[PDF coverage: ${pages - pagesWithoutText.length} of ${pages} page(s) carry a text layer; ` +
            `image-only (scanned) pages: ${listed} — those pages are NOT readable here (no OCR engine)]\n\n` +
            text;
        }
        const r = await cappedOrIndexed(name, category, att, full);
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
        // A weak PK sniff can rescue a zip renamed .txt/.dat; the extension
        // then LIES about the container, so the sniffed magic decides instead.
        const arcExt = sniffed && sniffed.category === "archive" ? "zip" : ext;
        return await cappedOrIndexed(name, category, att, await archiveText(buf, arcExt, name));
      }
      // Legacy .doc/.xls/.ppt/.mat have no public parser here — recover the
      // printable runs, which is what those formats store text as anyway.
      // I10: byte-scanning is a LOSSY recovery; the label says so inside the
      // text so neither the model nor the user reads it as a faithful extract.
      const text = extractStrings(buf);
      if (!text.trim()) throw new Error("No readable text found in this file");
      return await cappedOrIndexed(
        name, category, att,
        "[legacy binary format: text recovered by scanning raw bytes for printable runs — layout, formatting, and non-printable-encoded characters are lost; treat as a partial recovery]\n\n" +
        text,
      );
    }

    case "image": {
      // I07: extra pages (multi-page TIFF / animated GIF) ride along as
      // `frames` with `at` = page number — not seconds.
      const img = await imageToDataUrlFromPath(srcPath);
      return {
        name, category, dataUrl: img.dataUrl,
        pages: img.pages,
        ...(img.frames ? { frames: img.frames } : {}),
      };
    }

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
      // Keyframes run CONCURRENTLY with audio decode + transcription: on a
      // multi-hour lecture the keyframe pass is pure wall-clock we would
      // otherwise pay after whisper finishes. It is only started when an
      // index could actually use the frames (att present), and it is cleaned
      // up below whenever the transcript turns out not to need an index.
      const kfPromise: Promise<{ at: number; name: string }[] | null> = att
        ? videoKeyframesFromPath(srcPath, framesDir(att)).catch(() => null)
        : Promise.resolve(null);
      let transcript: string | undefined;
      let segments: AsrSegment[] = [];
      try {
        const r = await transcribePcmSegments(await audioPcmFromPath(srcPath));
        transcript = r.text || undefined;
        segments = r.segments;
      } catch { /* no (decodable) audio track — frames only */ }
      const key = await kfPromise;
      if (!transcript) {
        if (att) try { fs.rmSync(framesDir(att), { recursive: true, force: true }); } catch { /* ignore */ }
        return { name, category, frames, durationSec };
      }

      if (att && transcript.length > TEXT_CHAR_LIMIT) {
        // Long lecture: the scene-change keyframes already extracted next to
        // the index let visual questions about a time window pull the right
        // frame. Best-effort: a null key result still yields a working index.
        const keyframes: FrameEntry[] = (key ?? []).map(
          f => ({ at: f.at, file: "frames/" + f.name }),
        );
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
      // Small transcript: the eagerly-extracted keyframes are not needed.
      if (att) try { fs.rmSync(framesDir(att), { recursive: true, force: true }); } catch { /* ignore */ }
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
