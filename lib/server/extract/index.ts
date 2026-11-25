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
import { pdfText, type PdfText } from "./pdf";
// F05: the Python `documents.parse` capability job as a production caller of the
// document path. The TS engines (unpdf/pdf.js, the OOXML reader) stay in charge of
// every unit they already read; the capability engine only FILLS units they could
// not read (plus the per-page OCR cascade the TS engines do not have). When this
// deployment has no capability route (`state: "none"`), behaviour is byte-for-byte
// the pre-F05 path, which is what __tests__/server/extract-pdf-coverage.test.ts locks.
import {
  DOCUMENT_PARSE_CAPABILITY,
  readDocumentViaCapability,
  mergePdfUnits,
  mergeOfficeText,
  capabilityBlockerLine,
  type RunJob,
} from "./document-capability";
import { sniffMagic } from "./sniff";
import { decodeText, type DecodedText } from "../../files/encoding";
import { annotateCsvRecords, isTabularName } from "../../files/csv-records";
import {
  imageToDataUrlFromPath,
  probeInfo,
  videoFramesFromPath,
  videoKeyframesFromPath,
} from "./ffmpeg";
import { fmtStamp } from "../attachindex/format";
// F123 (2026-11-23): the Python speech job's pinned Parakeet row is the SOLE
// transcription engine for audio uploads and video audio tracks. The TypeScript
// whisper substitution (lib/server/extract/audio.ts) is removed: "no endpoint",
// "weights not prepared", "admission refused" and "backend crash" are actionable,
// retryable admission states the user is told about - never a second engine.
// Structural verdicts about the FILE (zero audio streams, corrupt container,
// unsupported language) stay final: no engine re-runs them.
import {
  speechBlockerLine,
  speechEngineNote,
  transcribeViaCapability,
  type AsrOutcome,
  type CapabilityAsr,
} from "./speech-capability";
import { buildAttachmentIndex } from "../attachindex/build";
import { framesDir, hasIndex, indexDir, publishPaths, removeIndex, withIndexWriteLock } from "../attachindex/store";
import { discardStaged } from "../attachindex/publish";
import {
  attachTimelineDir,
  buildTimeline,
  discardTimelineScratch,
  type TimelineEvidence,
} from "../attachindex/timeline";
import type { FrameEntry, SpeechCoverage, TranscriptSegment, TimelineSummary } from "../attachindex/types";

export interface ExtractResult {
  name: string;
  category: FileCategory;
  /** Plain-text body for text-like formats (documents, code, archives…). */
  text?: string;
  truncated?: boolean;
  pages?: number;
  /** Transcript from the pinned Python speech job for audio (and video audio tracks we could read). */
  transcript?: string;
  /** Image as a PNG data URL — only when the browser could not decode it. */
  dataUrl?: string;
  /**
   * Sampled video frames as PNG data URLs.
   * CAUTION — `at` is unit-polymorphic: SECONDS for video frames, but the
   * 1-based PAGE NUMBER for extra pages of multi-page images (tiff/gif) and
   * the 1-based UNIT ordinal (slide / sheet / body-paragraph) for document
   * visual frames. Any consumer pairing frames with time windows must check
   * `category` first.
   * F152: document frames carry `label` (the reader's unit name, e.g.
   * "slide 1") and the stable `region` id so the visual keeps its source
   * location through chat assembly.
   */
  frames?: { dataUrl: string; at: number; label?: string; region?: string; region_state?: string }[];
  /**
   * F68: the primary image's TRUE pixel dimensions (container/decoded source,
   * not the downscaled delivery raster). The model is told these verbatim so
   * "what are the pixel dimensions?" never becomes a vision estimate.
   */
  width?: number;
  height?: number;
  durationSec?: number;
  error?: string;
  /**
   * I16: an honest statement of what could NOT be read — e.g. a silent or
   * un-decodable video whose keyframes still produced a frames-only index.
   * Present whenever the delivered content is partial by nature, never when
   * extraction fully succeeded.
   */
  coverageNote?: string;

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

/** One transcript segment with its position in the recording. The Python
 *  verdict mapping produces this shape (F123: the only producer left). */
export interface AsrSegment {
  text: string;
  start: number;
  end: number | null;
}

function asSegments(segments: AsrSegment[]): TranscriptSegment[] {
  return segments.map(s => ({ text: s.text, start: s.start, end: s.end }));
}

/**
 * F78 (2026-11-22): the short-transcript deliveries used to hand back the
 * merged whisper text, dropping every segment time the ASR produced — "when
 * is 47 kg said?" became unanswerable from the evidence the model can
 * actually see. The indexed path cites `[HH:MM:SS - HH:MM:SS]` headers (the
 * form the per-turn rules tell the model to cite); the same law rides the
 * inline transcript. Returns "" when there are no usable segments.
 */
export function timedTranscriptText(segments: AsrSegment[]): string {
  return segments
    .map(s => {
      const t = s.text.trim();
      return t ? `[${fmtStamp(s.start)} - ${fmtStamp(s.end ?? s.start)}] ${t}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * F153 item 2 (2026-11-24): the cap statement, at the TOP of the delivered
 * record. A run whose middle segments exceed the adapter's serialized window
 * says so with the numbers the worker, the adapter and this delivery agree on,
 * and points at the durable full timed transcript (the index) so a time-range
 * question can still be answered. Silent completeness was the defect: the
 * 20,001-segment repro dropped the final fact while reporting complete=true.
 */
function transcriptCapNote(asr: CapabilityAsr): string {
  return asr.cappedSegments > 0
    ? `\n[transcript cap: ${asr.segmentCount} segments produced; ${asr.cappedSegments} middle segment(s) exceed this delivery's window - the complete timed transcript is kept in the index: ask for the time range to read them]`
    : "";
}

/**
 * F78 (2026-11-22): the short-video path deleted the eagerly-extracted
 * keyframes and shipped only the 20%/70% previews — a spoken fact at 61 s
 * and the saved moment showing the screen at 60 s never reached the same
 * turn, so the A/V alignment question could not be answered. The keyframes
 * were paid for; ship a TIME-SPREAD of them inline (greedily maximizing the
 * gap to what is already shown, bounded by INLINE_FRAME_CAP), then keep the
 * directory cleanup. Generic law: spacing + cap, no content inspection.
 */
const INLINE_FRAME_CAP = 6;

function spreadKeyframes(
  existingAts: number[],
  key: { at: number; name: string }[],
  dir: string,
  cap: number,
): { dataUrl: string; at: number }[] {
  const out: { dataUrl: string; at: number }[] = [];
  const ats = [...existingAts];
  const pool = key.slice().sort((a, b) => a.at - b.at);
  while (out.length < cap && pool.length) {
    let bi = -1;
    let bd = -1;
    pool.forEach((f, i) => {
      const d = ats.length ? Math.min(...ats.map(a => Math.abs(a - f.at))) : 0;
      if (d > bd) { bd = d; bi = i; }
    });
    if (bi < 0) break;
    const f = pool.splice(bi, 1)[0];
    if (bd < 15) break; // every remaining keyframe duplicates a shown moment
    try {
      const buf = fs.readFileSync(path.join(dir, f.name));
      if (!buf.length) continue;
      out.push({ dataUrl: "data:image/jpeg;base64," + buf.toString("base64"), at: f.at });
      ats.push(f.at);
    } catch { /* unreadable spot — skip */ }
  }
  return out;
}

/**
 * F152: persist a document's visual frames into the knowledge index when the
 * text is oversized. The pixels were rendered once (PDF drawn pages, embedded
 * rasters of office documents); an indexed document must not lose them — the
 * brief's law is that document pixels survive chat assembly for SHORT *and*
 * INDEXED attachments. They are written into framesDir exactly like the ffmpeg
 * keyframes (before the build, moved into the generation by the publisher)
 * and referenced by meta.frames, `at` = unit ordinal, label/region keep the
 * source location. Inline frames ride only the cap path: the client's indexed
 * branch sends zero pixels, and the retrieval layer serves the relevant crop
 * per question.
 */
const MAX_INDEXED_DOC_FRAMES = 16;

function persistDocFrames(
  attId: string,
  frames: NonNullable<ExtractResult["frames"]>,
): FrameEntry[] {
  const out: FrameEntry[] = [];
  try {
    fs.mkdirSync(framesDir(attId), { recursive: true });
  } catch { /* publish creates it too; writes below report real failures */ }
  for (const f of frames.slice(0, MAX_INDEXED_DOC_FRAMES)) {
    const m = /^data:image\/(png|jpeg);base64,([\s\S]+)$/.exec(f.dataUrl);
    if (!m) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(m[2], "base64");
    } catch {
      continue;
    }
    if (!buf.length) continue;
    const name = `d_${String(out.length + 1).padStart(3, "0")}.${m[1] === "png" ? "png" : "jpg"}`;
    try {
      // meta.frames entries are indexDir-relative ("frames/…", the ffmpeg keyframe
      // shape); the bytes land in framesDir = indexDir/frames — never a nested
      // frames/frames (a double join here silently wrote every frame to a missing
      // directory and the index shipped zero pixels).
      fs.writeFileSync(path.join(framesDir(attId), name), buf);
    } catch {
      continue; // one unwritable frame must not fail the whole indexing
    }
    const file = `frames/${name}`;
    out.push({
      at: f.at, file,
      ...(f.label ? { label: f.label } : {}),
      ...(f.region ? { region: f.region } : {}),
      ...(f.region_state ? { state: f.region_state } : {}),
    });
  }
  return out;
}

/**
 * The classic cap path — or the index path when the parsed text overflows
 * the prompt budget and we have a valid attachment id to key the index by.
 * F152: `frames` (the document's rendered pages/regions) persist into the
 * index on the index path; the caller ships them inline only for the cap path.
 */
async function cappedOrIndexed(
  name: string,
  category: FileCategory,
  att: string | undefined,
  raw: string,
  frames?: NonNullable<ExtractResult["frames"]>,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const clean = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (att && clean.length > TEXT_CHAR_LIMIT) {
    const extra: { frames?: FrameEntry[] } = {};
    if (frames?.length) {
      const persisted = persistDocFrames(att, frames);
      if (persisted.length) extra.frames = persisted;
    }
    const indexed = await indexContent(name, category, att, clean, extra, signal);
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
export async function indexContent(
  name: string,
  category: FileCategory,
  attId: string,
  fullText: string,
  extra: {
    segments?: TranscriptSegment[];
    durationSec?: number;
    frames?: FrameEntry[];
    /** F13: durable media baseline for a video/audio attachment. */
    observations?: Array<Record<string, unknown>>;
    timeline?: TimelineSummary;
    /** F153 item 3: the audio run's decode coverage (meta.speech). */
    speech?: SpeechCoverage;
  } = {},
  signal?: AbortSignal,
): Promise<Pick<ExtractResult, "indexed" | "chunkCount" | "spine"> & { embedNote?: string }> {
  const hadIndex = hasIndex(attId);
  try {
    // F10: one writer per attachment (a retried upload must not interleave with
    // an older build) and the caller's signal reaches chunk, embed and commit.
    const built = await withIndexWriteLock(attId, () =>
      buildAttachmentIndex({
        attId,
        name,
        category,
        fullText,
        ...extra,
        signal,
      }),
    );
    return {
      indexed: true,
      chunkCount: built.chunkCount,
      spine: built.spine,
      ...(built.embedNote ? { embedNote: built.embedNote } : {}),
    };
  } catch (err: unknown) {
    const aborted = (err as Error)?.name === "AbortError";
    if (aborted) {
      // F10: cancellation is not a defect and never destroys a good index.
      // Only the staged attempt is thrown away.
      try { discardStaged(publishPaths(attId), attId); } catch { /* best effort */ }
      throw err;
    }
    if (!hadIndex) removeIndex(attId);
    else { try { discardStaged(publishPaths(attId), attId); } catch { /* staged only */ } }
    if ((err as NodeJS.ErrnoException)?.code === "ENOSPC") {
      const msg = (err as Error).message ?? "";
      throw new Error(`Out of disk space while indexing ${name} - free some space and retry (${msg})`);
    }
    throw err;
  }
}

/**
 * Deliver a transcript produced by the Python speech backend (E migration).
 *
 * Two things are stated inside the text itself, because a transcript without its
 * provenance is indistinguishable from a guess: WHICH engine answered (model,
 * device, compute type, language verdict as the run reported it) and WHICH parts
 * of the timeline were never decoded. Segments keep source-relative timestamps,
 * so an attachment-index time citation stays valid for a chunked 3-hour recording.
 */
async function deliverSpoken(
  name: string,
  category: FileCategory,
  att: string | undefined,
  outcome: Extract<AsrOutcome, { state: "ready" | "silence" }>,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const asr = outcome.asr;
  if (!asr.text) {
    // A pure audio upload with MEASURED silence is still a refusal — there is no
    // visual content to fall back to — but the sentence now states the measurement
    // instead of the model's opinion about nothing.
    const level = asr.audioLevel as { max_volume_db?: number; noise_floor_db?: number };
    const measured =
      typeof level.max_volume_db === "number"
        ? `the track was decoded and measured at ${level.max_volume_db.toFixed(1)} dBFS peak, at or below the ${
            typeof level.noise_floor_db === "number" ? level.noise_floor_db.toFixed(0) : "configured"
          } dBFS noise floor, so no speech could exist in it`
        : (asr.note || "no audible speech was present");
    throw new Error(`No speech detected in ${name}: ${measured}`);
  }
  const note = speechEngineNote(asr);
  const coverage = asr.complete
    ? ""
    : `\n[speech coverage: ${asr.examined.length} decoded span(s) over ${
        asr.durationSec.toFixed(1)
      }s; ${asr.unexamined.length} interval(s) were never decoded, so the absence of speech there is unproven]`;
  // F78: segments keep their times on the inline transcript too, not only in
  // the index — the timed header is the citation law the per-turn rules use.
  // F153 (2026-11-24): when the adapter's cap skipped a middle, the FULL timed
  // transcript (middle included) is the durable body — the window's head+tail
  // ride the preview, and the skipped count is stated up top, never hidden.
  const body =
    (asr.cappedSegments > 0
      ? asr.fullTranscriptText
      : timedTranscriptText(asr.segments as AsrSegment[])) || asr.text;
  const transcript = `${note}${transcriptCapNote(asr)}\n${body}${coverage}`;
  const durationSec = asr.durationSec;
  if (att && transcript.length > TEXT_CHAR_LIMIT) {
    const indexed = await indexContent(
      name,
      category,
      att,
      transcript,
      {
        // F153: on a cap drop the INDEX chunks the FULL validated set - the
        // searchable index must cover the whole timeline, not just the delivery
        // window (the cap note promises the time range is readable).
        segments: asSegments(asr.cappedSegments > 0 ? asr.allSegments : asr.segments),
        // F153 item 3: the decode coverage rides the durable record too, so a
        // follow-up about an UNCOVERED time can tell measured absence from an
        // unexamined gap and schedule a bounded fresh read of the original.
        ...(durationSec > 0
          ? {
              durationSec,
              speech: {
                durationSec,
                complete: asr.complete,
                examined: asr.examined,
                unexamined: asr.unexamined,
              } as SpeechCoverage,
            }
          : {}),
      },
      signal,
    );
    return {
      name,
      category,
      ...indexed,
      transcript: transcript.slice(0, PREVIEW_CHARS),
      truncated: true,
      ...(durationSec > 0 ? { durationSec } : {}),
    };
  }
  const capped = cap(transcript);
  return {
    name,
    category,
    transcript: capped.text,
    truncated: capped.truncated,
    ...(durationSec > 0 ? { durationSec } : {}),
  };
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
function transformText(category: FileCategory, text: string, name: string): string {
  return category === "rtf" ? rtfToText(text)
    : category === "notebook" ? notebookText(text)
    : isTabularName(name) ? annotateCsvRecords(text, name) // F63: logical CSV rows
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
  const capped = cap(transformText(category, dec.text, name));
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
 * scratch file, and ffmpeg and the Python speech job read the media straight
 * from that path — a multi-GB video is seeked inside the file, never buffered
 * whole in RAM.
 *
 * I15: `signal` (the upload request's own abort signal) cancels the heavy
 * ffmpeg/speech-job work mid-extraction when the client goes away, instead of
 * letting it run to completion for an upload nobody is waiting for anymore.
 */
export async function extractFileFromPath(
  name: string,
  srcPath: string,
  attId?: string,
  mime?: string,
  signal?: AbortSignal,
  opts?: { runJob?: RunJob },
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
  // 2 KB head: MP3 frame validation (F78-A) must reach the SECOND frame header,
  // which sits ~0.4–1.1 KB in for legal CBR bitrates — 64 bytes never could.
  const sniffed = sniffMagic(readHead(srcPath, 2048).buf);
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
        const body = transformText(category, dec.text, name).replace(/\r\n/g, "\n").trim();
        if (!body) return { name, category, text: "", truncated: false };
        const clean = encodingNote(dec) + body;
        const indexed = await indexContent(name, category, att, clean, {}, signal);
        return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
      }
      const { buf, partial } = readHead(srcPath, TEXT_READ_BYTES);
      const dec = decodeText(buf);
      if (att && !partial) {
        // Fully in hand but over the prompt budget (multi-byte text): index
        // the WHOLE decoded text, not the capped one textLikeResult would cut.
        const clean = encodingNote(dec) + transformText(category, dec.text, name).replace(/\r\n/g, "\n").trim();
        if (clean.length > TEXT_CHAR_LIMIT) {
          const indexed = await indexContent(name, category, att, clean, {}, signal);
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
        // F05: BOTH readers run. pdf.js owns the pages it already read; the
        // capability reader only fills the pages it did not, and a second reader's
        // materially larger text for a shared page is kept as a LABELED VARIANT
        // (never a silent swap), because a page where two readers disagree carries
        // evidence either engine alone would hide.
        let ts: PdfText | null = null;
        let tsFail: unknown = null;
        try {
          ts = await pdfText(buf);
        } catch (err) {
          tsFail = err;
        }
        const cap = await readDocumentViaCapability(srcPath, {
          ...(opts?.runJob ? { runJob: opts.runJob } : {}),
          ...(signal ? { signal } : {}),
        });
        if (cap.state === "ready") {
          const merged = mergePdfUnits(ts ?? { pages: 0, perPage: [], pagesWithoutText: [] }, cap.doc);
          if (merged.refusal) throw new Error(`${name}: ${merged.refusal}`);
          // Pages whose CONTENT is drawn (vector chart/diagram marks) ride to the model
          // as page-image frames: the text layer of a chart page carries only its labels,
          // so a chart question needs the rendered page. `at` is the 1-based PDF page
          // number here (frames' `at` is polymorphic by design - consumers pair frames
          // with time windows only for media categories, checked before use).
          const visual = cap.doc.visualPages;
          // The reader names PDF page renders "Page {page}" client-side; the
          // label is stamped explicitly so an INDEXED frame (served from
          // meta.frames, where no client fallback exists) is self-describing
          // and marked page-axis for the retrieval pairing.
          const visualFrames = visual.map((v) => ({
            dataUrl: v.dataUrl, at: v.page, label: `page ${v.page}`,
            ...(v.region ? { region: v.region } : {}),
            ...(v.region_state ? { region_state: v.region_state } : {}),
          }));
          const mergedResult = await cappedOrIndexed(name, category, att, merged.text, visualFrames, signal);
          return {
            ...mergedResult,
            pages: merged.pages,
            coverageNote: merged.coverageNote,
            // F152: inline pixels ride the cap path; an indexed PDF's frames
            // persisted into the index, and retrieval serves the relevant page.
            ...(visualFrames.length && !mergedResult.indexed ? { frames: visualFrames } : {}),
          };
        }
        if (!ts) {
          // pdf.js could not open the file and the capability engine gave no usable
          // document either: name both facts instead of only the TS one.
          if (cap.state === "none") throw tsFail;
          throw new Error(
            `${name}: ${tsFail instanceof Error ? tsFail.message : String(tsFail)} ` +
            capabilityBlockerLine(cap),
          );
        }
        const { text, pages, pagesWithoutText } = ts;
        if (!text.trim()) {
          if (pages > 0) {
            // F05: the sentence naming WHY the scanned pages stayed unread now comes
            // from the capability backend when one exists, so the human step it
            // reports (install/point RUKE_TESSERACT, set a document language, accept
            // a licence) reaches the user instead of a stale "no OCR engine".
            const capOcrSentence = cap.state === "unavailable"
              ? `${capabilityBlockerLine(cap)} `
              : "No OCR engine is installed, so their contents cannot be read as text; ";
            throw new Error(
              `${name} has no text layer — all ${pages} page(s) are scanned images. ` +
              capOcrSentence +
              `send the page you care about as an image and the vision model can read it.`,
            );
          }
          throw new Error("No readable text found in this PDF");
        }
        // F153: a capability failure over a working TS read is an honest
        // PARTIAL, never a completed record. pdf.js alone says "there is
        // text"; it cannot see figures. The pages the visual/OCR pass never
        // rendered are NAMED — and the sentence rides the INDEXED text (the
        // I06 law: retrieved passages must carry the caveat), not only the
        // side field. A zero-frame survey PDF whose visual pass hit its parse
        // deadline shipped READY-as-complete and every figure question
        // answered from chunks that claimed a full read.
        const capGap = cap.state === "unavailable"
          ? `[PDF coverage: the visual/OCR reader did not complete (${cap.reason}) — ` +
            `${pages <= 15 ? `page(s) ${Array.from({ length: pages }, (_, i) => i + 1).join(", ")}` : `all ${pages} pages`} ` +
            `were NOT inspected as images; figures, charts and scanned content are ` +
            `unreachable from this record. This read is retryable: ask about the document again. ` +
            `${capabilityBlockerLine(cap)}]`
          : "";
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
        if (capGap) full = `${capGap}\n\n${full}`;
        const r = await cappedOrIndexed(name, category, att, full, undefined, signal);
        return {
          ...r,
          pages,
          ...(capGap ? { coverageNote: capGap } : {}),
        };
      }
      if (category === "office") {
        // F05: same rule as PDF. The TS OOXML reader keeps the body unless the
        // capability reader can be MEASURED to carry materially more content
        // (mergeOfficeText's >=20% non-whitespace bar), and the note records both
        // engines plus every unit id the capability reader failed. A Python engine
        // is not better by default, and a TS engine is not protected by default.
        let tsOffice = "";
        let officeFail: unknown = null;
        try {
          tsOffice = officeText(buf, ext);
        } catch (err) {
          officeFail = err;
        }
        const cap = await readDocumentViaCapability(srcPath, {
          ...(opts?.runJob ? { runJob: opts.runJob } : {}),
          ...(signal ? { signal } : {}),
        });
        if (cap.state === "ready") {
          const merged = mergeOfficeText(tsOffice, cap.doc);
          if (merged.refusal) throw new Error(`${name}: ${merged.refusal}`);
          // The merge always carries its coverage statement, so an Office read that produced
          // nothing readable still reaches the user as an honest empty extraction with the
          // per-unit reasons rather than a bare "no readable text" error (F12-2/F12-4).
          // F152: embedded-raster regions (the PPTX legend, the DOCX screenshot, the
          // XLSX chart image) render through the capability reader's region
          // inspection. The recovered text lands in the body as an ocr_text block,
          // but the PIXELS of every rendered region — photos included — ride as
          // labelled frames so a visual question ("which line crosses the
          // threshold?") reaches the multimodal request with its unit identity.
          const officeVisual = cap.doc.visualPages;
          const officeFrames = officeVisual.map((v) => ({
            dataUrl: v.dataUrl, at: v.page,
            ...(v.label ? { label: v.label } : {}),
            ...(v.region ? { region: v.region } : {}),
            ...(v.region_state ? { region_state: v.region_state } : {}),
          }));
          const mergedResult = await cappedOrIndexed(name, category, att, merged.text, officeFrames, signal);
          return {
            ...mergedResult,
            ...(merged.pages ? { pages: merged.pages } : {}),
            coverageNote: merged.coverageNote,
            // F152: inline pixels ride the cap path; an indexed office doc's
            // frames persisted into the index with their region ids.
            ...(officeFrames.length && !mergedResult.indexed ? { frames: officeFrames } : {}),
          };
        }
        if (officeFail !== null) {
          // cap.state is narrowed to "none" | "unavailable" here: the "ready" case returned above.
          if (cap.state === "none") throw officeFail;
          throw new Error(
            `${name}: ${officeFail instanceof Error ? officeFail.message : String(officeFail)} ` +
            capabilityBlockerLine(cap),
          );
        }
        // F153: same law as PDF. A capability timeout leaves the TS OOXML body
        // readable, but every embedded picture, chart image and diagram was
        // never rendered — the deck.f153 lesson (zero regions, no statement).
        // The gap is named in the delivered text and on the record, retryable.
        const officeGap = cap.state === "unavailable"
          ? `[Office coverage: the capability reader did not complete (${cap.reason}) — ` +
            `embedded images, charts and diagrams were NOT rendered and their content is ` +
            `unreachable from this record. This read is retryable: ask about the document again. ` +
            `${capabilityBlockerLine(cap)}]`
          : "";
        if (!tsOffice.trim()) {
          throw new Error(
            "No readable text found in this document" +
            (cap.state === "unavailable" ? ` ${capabilityBlockerLine(cap)}` : ""),
          );
        }
        const r = await cappedOrIndexed(
          name, category, att,
          officeGap ? `${officeGap}\n\n${tsOffice}` : tsOffice,
          undefined, signal,
        );
        return { ...r, ...(officeGap ? { coverageNote: officeGap } : {}) };
      }
      if (category === "archive") {
        // The uploaded name is passed along because bare .bz2/.xz streams store
        // no filenames — the inner name only exists in the file name itself.
        // A weak PK sniff can rescue a zip renamed .txt/.dat; the extension
        // then LIES about the container, so the sniffed magic decides instead.
        const arcExt = sniffed && sniffed.category === "archive" ? "zip" : ext;
        return await cappedOrIndexed(name, category, att, await archiveText(buf, arcExt, name), undefined, signal);
      }
      // Legacy .doc/.xls/.ppt/.mat: the capability backend carries the real
      // structured readers (Word97 WordDocument, PPT atom walk, BIFF8, MAT v4).
      // A real structured parse always serves over a printable-run scan: this is
      // deliberately NOT mergeOfficeText's measurement - the byte scan is not a
      // comparable reader body, and its junk tokens would register as "lost
      // content" and permanently protect the weaker reader (the F12-3 lesson,
      // reversed). The scan stays as the labeled fallback for a typed refusal
      // (malformed OLE -> normalizeDocument null -> state "unavailable") or an
      // offline backend (state "none").
      // I10: byte-scanning is a LOSSY recovery; the label says so inside the
      // text so neither the model nor the user reads it as a faithful extract.
      const cap = await readDocumentViaCapability(srcPath, {
        ...(opts?.runJob ? { runJob: opts.runJob } : {}),
        ...(signal ? { signal } : {}),
      });
      if (cap.state === "ready") {
        const source = cap.doc.rendered.length ? cap.doc.rendered : cap.doc.units;
        const capText = source
          .slice()
          .sort((a, b) => a.unit - b.unit)
          .map((u) => u.text.trim())
          .filter(Boolean)
          .join("\n\n");
        if (capText.trim()) {
          const note =
            `[document capability ${DOCUMENT_PARSE_CAPABILITY} (${cap.doc.engine}) reads the legacy ` +
            `binary structure; body_source: capability:${cap.doc.engine}; units: ` +
            `${cap.doc.unitsSucceeded.length} of ${cap.doc.unitsTotal} read]`;
          return await cappedOrIndexed(name, category, att, `${note}\n\n${capText}`, undefined, signal);
        }
      }
      const text = extractStrings(buf);
      if (!text.trim()) {
        // The scan found nothing AND the structured reader declined: name both
        // facts, as every other family does, instead of a bare "no readable text".
        throw new Error(
          "No readable text found in this file" +
          (cap.state === "unavailable" ? ` ${capabilityBlockerLine(cap)}` : ""),
        );
      }
      return await cappedOrIndexed(
        name, category, att,
        "[legacy binary format: text recovered by scanning raw bytes for printable runs — layout, formatting, and non-printable-encoded characters are lost; treat as a partial recovery]\n\n" +
        text,
      );
    }

    case "image": {
      // I07: extra pages (multi-page TIFF / animated GIF) ride along as
      // `frames` with `at` = page number — not seconds.
      const img = await imageToDataUrlFromPath(srcPath, { signal });
      const out: ExtractResult = {
        name, category, dataUrl: img.dataUrl,
        pages: img.pages,
        ...(img.frames ? { frames: img.frames } : {}),
        ...(img.width && img.height ? { width: img.width, height: img.height } : {}),
      };
      // F152: a standalone raster answers to the SAME region-decision law as an
      // embedded image — the pixels ARE the content and ride to the model
      // unchanged (direct image uploads are preserved); the same cheap region
      // inspection (python documents/region_ocr.py) honestly decides whether an
      // engine runs: a screenshot's label is OCR-recovered and attached to the
      // image and its region id, a photo pays zero engine calls and keeps its
      // pixels for visual questions. The engine POLICY (Paddle-first /
      // Tesseract-only) is the cascade's, never this seam's.
      const cap = await readDocumentViaCapability(srcPath, {
        ...(opts?.runJob ? { runJob: opts.runJob } : {}),
        ...(signal ? { signal } : {}),
      });
      if (cap.state === "ready") {
        const recognized = cap.doc.units.filter((u) => u.provenance === "ocr");
        if (recognized.length) {
          out.text = recognized
            .map((u) => {
              // The region frame names the same unit: bind the recovered text
              // to its label + stable region id (the source-location law).
              const where = cap.doc.visualPages.find((v) => v.page === u.unit && v.region);
              const eng = [u.engine, u.language].filter(Boolean).join(" / ");
              const from = where?.label ? ` from ${where.label}` : "";
              const region = where?.region ? `, region ${where.region}` : "";
              return `[text recovered by OCR${eng ? ` (${eng})` : ""}${from}${region}]\n${u.text}`;
            })
            .join("\n\n");
        }
        // The reader's own note states the region outcome (inspection ran /
        // engine calls / why a region was skipped) — evidence, never silence.
        if (cap.doc.note) out.coverageNote = cap.doc.note;
      }
      return out;
    }

    case "audio": {
      // F123 (2026-11-23): the Python speech job (pinned Parakeet, GPU-first with
      // the measured handoff law, CPU recovery on the SAME model) is the SOLE
      // transcription engine. The old TypeScript whisper substitution — the
      // scratch-file decode, the three-stage VRAM ladder, the per-channel grind —
      // is removed, and no replacement for it exists: a blocked run is an
      // ACTIONABLE admission state the user is told about, retried with the SAME
      // engine once the blocker clears.
      const sp = await transcribeViaCapability(srcPath, {
        ...(opts?.runJob ? { runJob: opts.runJob } : {}),
        ...(signal ? { signal } : {}),
      });
      if (sp.state === "ready" || sp.state === "silence") {
        return await deliverSpoken(name, category, att, sp, signal);
      }
      if (sp.state === "unavailable" && sp.structural) {
        // The refusal is a measured fact about THIS file (ffprobe found zero audio
        // streams, the container is corrupt, or the named language is outside the
        // pinned backend's published table). No engine can un-measure it, and
        // re-decoding a silent track is how a model invents words over nothing.
        throw new Error(`${name}: ${sp.message}`);
      }
      if (sp.state === "unavailable" && sp.reason === "cancelled") {
        throw new Error("The user aborted this request.");
      }
      if (sp.state === "none") {
        throw new Error(
          `${name}: its spoken content could not be read: the pinned speech backend is not ` +
          `available on this host (no Python ML endpoint, or speech is switched off). ` +
          `Start the app's ML backend (Settings shows the speech engine status) and send the ` +
          `upload again; the same pinned engine (Parakeet) will run. This is a retryable ` +
          `admission state.`,
        );
      }
      // Retryable-unavailable (weights not prepared, resource admission refused,
      // resource pressure, backend crash) and the remaining non-retryable states
      // (policy refusal) propagate with the worker's OWN reason and human step.
      throw new Error(
        `${name}: its spoken content could not be read. ${speechBlockerLine(sp)}` +
        (sp.retryable
          ? " This is a retryable admission state: send the upload again once the blocker " +
            "clears; the same pinned engine (Parakeet) runs."
          : ""),
      );
    }

    case "video": {
      // F152: the visual channel and the speech channel are INDEPENDENTLY
      // recoverable evidence. The decoder throws when it obtains no frames;
      // that failure used to take the whole upload down BEFORE ASR ever ran,
      // so valid speech died with the frames it never needed. A frame-decode
      // failure is RECORDED here — the outcome states exactly what could and
      // could not be read — and the speech path runs regardless.
      let frames: { dataUrl: string; at: number }[] = [];
      let durationSec = 0;
      let frameIssue: string | null = null;
      try {
        const sampled = await videoFramesFromPath(srcPath, { signal });
        frames = sampled.frames;
        durationSec = sampled.durationSec;
      } catch (err) {
        if (signal?.aborted) throw new Error("The user aborted this request.");
        frameIssue = `its visual content could not be decoded (${err instanceof Error ? err.message : String(err)})`;
      }
      // F13/S60: one probe per upload, reused by the audio-failure classifier
      // and by the durable media baseline. Lazy: the frames-only path with no
      // attachment never pays for it.
      let probeText: string | null = null;
      const probeOnce = async (): Promise<string> => {
        if (probeText === null) probeText = await probeInfo(srcPath, { signal });
        return probeText;
      };
      // F13/S60: the cheap upload baseline (media identity, streams, duration,
      // scene anchors, coverage). Built before the index because the index is
      // the durable home for the record; null means nothing was published.
      // F153 item 4 (2026-11-25): every catch that turns media evidence into
      // null must CARRY COVERAGE. A silent null made the rest of the source
      // unreachable without saying so — "no event found" must never read as
      // "never inspected", and "never inspected" must be stated out loud.
      let baselineIssue: string | null = null;
      const buildBaseline = async (): Promise<TimelineEvidence | null> => {
        if (!att) return null;
        try {
          return await buildTimeline({
            attId: att,
            srcPath,
            probeText: await probeOnce(),
            durationSec,
            signal,
          });
        } catch (err) {
          // A missing baseline never fails the upload — but it is reported:
          // the durable media record (streams, real durations, scene anchors)
          // is ABSENT and follow-ups know it.
          baselineIssue = `the durable media baseline (container streams, real durations, scene anchors) could not be built (${err instanceof Error ? err.message : String(err)})`;
          return null;
        }
      };
      const publishBaseline = async (attId: string, baseline: TimelineEvidence): Promise<void> => {
        try {
          await withIndexWriteLock(attId, async () => {
            if (!attachTimelineDir(indexDir(attId), baseline.scratchDir)) {
              discardTimelineScratch(baseline.scratchDir);
              baselineIssue = "the durable media baseline was built but could not be stored in the index";
            }
          });
        } catch (err) {
          discardTimelineScratch(baseline.scratchDir);
          baselineIssue = `the durable media baseline was built but could not be stored in the index (${err instanceof Error ? err.message : String(err)})`;
        }
      };
      // The audio track carries narration — transcribe it when the clip has
      // one so the model hears the video, not just its sampled frames.
      // Keyframes run CONCURRENTLY with audio decode + transcription: on a
      // multi-hour lecture the keyframe pass is pure wall-clock we would
      // otherwise pay after transcription finishes. It is only started when an
      // index could actually use the frames (att present), and it is cleaned
      // up below whenever the transcript turns out not to need an index.
      let keyIssue: string | null = null;
      const kfPromise: Promise<{ at: number; name: string }[] | null> = att
        ? videoKeyframesFromPath(srcPath, framesDir(att), { signal }).catch((err) => {
            // F153 item 4: the null carries its reason. The old silent null
            // left the visual record unreachable with no word about it.
            keyIssue = `the scene-change keyframe pass ended with no visual record (${err instanceof Error ? err.message : String(err)})`;
            return null;
          })
        : Promise.resolve(null);
      let transcript: string | undefined;
      let segments: AsrSegment[] = [];
      // I16: the old bare catch labelled EVERY audio failure "no decodable
      // audio track" and then deleted the keyframes the video branch had
      // already paid ffmpeg for. The failure reason is kept so the honest
      // outcome states exactly what could and could not be read.
      let speechIssue: string | null = null;
      // F123 (2026-11-23): the Python speech job (pinned Parakeet) is the SOLE
      // engine for the video's audio track. Its verdicts about the FILE are final
      // ("ffprobe found 0 audio streams" and "the track was measured silent" are
      // measurements no engine can un-measure), and its blocked states are
      // reported, never retried with a substitute model.
      const sp = await transcribeViaCapability(srcPath, {
        ...(opts?.runJob ? { runJob: opts.runJob } : {}),
        ...(signal ? { signal } : {}),
      });
      let pythonAsr: CapabilityAsr | null = null;
      if (sp.state === "ready") {
        transcript = sp.asr.text || undefined;
        segments = sp.asr.segments.map((s) => ({ text: s.text, start: s.start, end: s.end }));
        pythonAsr = sp.asr;
        if (!transcript) speechIssue = "the speech backend decoded its audio track and found no speech in it";
      } else if (sp.state === "silence") {
        const level = sp.asr.audioLevel as { max_volume_db?: number };
        speechIssue =
          `no speech was detected in its audio track, which was decoded and measured at ` +
          `${typeof level.max_volume_db === "number" ? level.max_volume_db.toFixed(1) + " dBFS" : "the noise floor"} ` +
          `(a measured verdict, not an inference)`;
      } else if (sp.state === "unavailable" && sp.reason === "cancelled") {
        throw new Error("The user aborted this request.");
      } else if (sp.state === "unavailable" && sp.structural) {
        // A zero-audio-stream probe is the same structural fact the old TS path
        // reported, just measured: keep the frozen wording and the evidence.
        speechIssue = /0 audio streams/i.test(sp.message)
          ? "it has no audio track (ffprobe found 0 audio streams)"
          : sp.message;
      } else {
        // F123 (2026-11-23): the pinned Parakeet job is the SOLE engine - the
        // TypeScript whisper substitution is gone. A blocked run (no endpoint,
        // weights not prepared, admission refused, backend crash) leaves the
        // video's FRAMES intact: they were paid for and they are honest visual
        // evidence. The spoken fact is reported as blocked with the worker's OWN
        // reason and human step, so the user can clear the blocker and resend -
        // the same pinned engine runs then, never a substitute model.
        speechIssue = sp.state === "none"
          ? "its spoken content could not be read: the pinned speech backend is not available " +
            "on this host (no Python ML endpoint, or speech is switched off); start the app's " +
            "ML backend and send the upload again (retryable; the same pinned engine runs)"
          : `its spoken content could not be read. ${speechBlockerLine(sp)}` +
            (sp.retryable
              ? " (retryable: send the upload again once the blocker clears; the same pinned " +
                "engine runs)"
              : "");
      }
      const key = await kfPromise;
      // F78 (2026-11-22): the inline/preview transcript keeps the segment
      // times the ASR produced (the merged text alone cannot answer "when",
      // and the indexed path already cites [HH:MM:SS - HH:MM:SS] headers).
      const timed = timedTranscriptText(segments);
      if (transcript && timed) transcript = timed;
      if (transcript && pythonAsr) {
        // F153 (2026-11-24): on a cap drop the video's durable text is the
        // FULL timed transcript (middle included) and the drop is STATED —
        // the same law as the pure-audio delivery, on the video's audio track.
        if (pythonAsr.cappedSegments > 0 && pythonAsr.fullTranscriptText)
          transcript = pythonAsr.fullTranscriptText;
        transcript = `${speechEngineNote(pythonAsr)}${transcriptCapNote(pythonAsr)}\n${transcript}`;
      }

      if (!transcript) {
        // I16: speech could not be read but the keyframes survived AND an
        // index can carry them → KEEP the frames and build a frames-only
        // knowledge index with an honest coverage note. A silent video is
        // still not an "error"; without an att (no index possible) or
        // without keyframes, the old frames-inline path stands unchanged.
        if (att && key && key.length > 0) {
          const keyframes: FrameEntry[] = key.map(f => ({ at: f.at, file: "frames/" + f.name }));
          // F76 (2026-11-21): the old wording ("ON SCREEN at a given time")
          // INVITED the model to generalize the sample to the whole timeline —
          // the exact over-claim seen in the live UI. Same point-evidence law
          // the timeline layer states for frame OCR, phrased for the record.
          const baseline = await buildBaseline();
          const coverageNote =
            `Video "${name}"${durationSec > 0 ? ` (${Math.round(durationSec)}s)` : ""}: ${speechIssue ?? "its spoken content could not be read"}. ` +
            (frameIssue ? `${frameIssue}; its scene-change keyframes decoded separately and ARE readable. ` : "") +
            `Its visual content WAS read: keyframes were sampled at ${keyframes.length} moment(s) across its timeline, each carrying its video timestamp, ` +
            `so questions about what is ON SCREEN at one of those moments can be answered from them; what happens between, ` +
            `before or after the sampled moments was never examined and cannot be claimed. Questions about what is SPOKEN cannot.` +
            (baselineIssue ? ` ${baselineIssue}: follow-ups start from the saved keyframes alone.` : "");
          const indexed = await indexContent(name, category, att, coverageNote, {
            durationSec,
            frames: keyframes,
            ...(baseline ? { observations: baseline.observations, timeline: baseline.summary } : {}),
          }, signal);
          // The record lives INSIDE the published attachment dir, so it moves
          // only after the generation switch (which renames the old dir aside).
          if (baseline) await publishBaseline(att, baseline);
          return {
            name, category, ...indexed,
            frames, durationSec,
            text: coverageNote, truncated: false,
            coverageNote,
          };
        }
        if (att) try { fs.rmSync(framesDir(att), { recursive: true, force: true }); } catch { /* ignore */ }
        // F152 (Part 3-D): the typed SPEECH verdict must be named on this plain
        // return too. The old shape wove the note ONLY when the decoder failed,
        // so a short single-scene clip — zero scene-change keyframes by the
        // sampler's own law, no decoder throw — with blocked speech delivered
        // its previews with NO explanation at all: the pinned-backend admission
        // was swallowed (the mechanism behind the dual.* matrix reds' silent
        // records). Frame-fail-only, speech-fail-only and both-fail all state
        // every failure that happened, in the frozen wording, never more.
        const blockBits = [
          frameIssue,
          keyIssue,
          speechIssue ?? (frameIssue ? "and its spoken content could not be read" : ""),
        ].filter((s): s is string => !!s);
        const blockNote = blockBits.join("; ");
        return {
          name, category, frames, durationSec,
          ...(blockNote ? { coverageNote: `${blockNote}.` } : {}),
        };
      }

      if (att && transcript.length > TEXT_CHAR_LIMIT) {
        // Long lecture: the scene-change keyframes already extracted next to
        // the index let visual questions about a time window pull the right
        // frame. Best-effort: a null key result still yields a working index.
        const keyframes: FrameEntry[] = (key ?? []).map(
          f => ({ at: f.at, file: "frames/" + f.name }),
        );
        const baseline = await buildBaseline();
        const indexed = await indexContent(name, category, att, transcript, {
          // F153: cap drop on the video's audio track - index the FULL validated
          // set so the skipped middle is retrievable; same law as pure audio.
          segments: asSegments(
            pythonAsr && pythonAsr.cappedSegments > 0 ? pythonAsr.allSegments : segments,
          ),
          durationSec,
          frames: keyframes,
          ...(baseline ? { observations: baseline.observations, timeline: baseline.summary } : {}),
        }, signal);
        if (baseline) await publishBaseline(att, baseline);
        const longBits = [frameIssue, keyIssue,
          ...(baselineIssue ? [`${baselineIssue}: follow-ups start from the passages and saved keyframes alone`] : [])]
          .filter((s): s is string => !!s);
        return {
          name, category, ...indexed, frames, durationSec,
          transcript: transcript.slice(0, PREVIEW_CHARS),
          truncated: true,
          ...(longBits.length ? { coverageNote: `${longBits.join("; ")} — the spoken content below WAS read.` } : {}),
        };
      }
      // F153 item 4 (2026-11-25): a SMALL transcript is NOT a short recording.
      // A three-hour screen capture with ten spoken words has a small
      // transcript and a THREE-HOUR visual record. The old path spread a few
      // keyframes inline, DELETED the frames dir and built no index: every
      // follow-up about a later moment had nothing to retrieve (the F78
      // inline-spread law stands for the FIRST answer; it was never meant to
      // be the whole record). The durable record — passages, keyframes,
      // baseline — is built for every video with an attachment; nothing on
      // disk is deleted.
      if (att) {
        if (key && key.length) {
          try {
            frames = [...frames, ...spreadKeyframes(frames.map(f => f.at), key, framesDir(att),
              Math.max(0, INLINE_FRAME_CAP - frames.length))];
          } catch { /* inline merge is best-effort; the transcript stands */ }
        }
        const keyframes: FrameEntry[] = (key ?? []).map(f => ({ at: f.at, file: "frames/" + f.name }));
        const baseline = await buildBaseline();
        const indexed = await indexContent(name, category, att, transcript, {
          // F153: cap drop on the video's audio track - index the FULL validated
          // set so the skipped middle is retrievable; same law as pure audio.
          segments: asSegments(
            pythonAsr && pythonAsr.cappedSegments > 0 ? pythonAsr.allSegments : segments,
          ),
          durationSec,
          frames: keyframes,
          ...(baseline ? { observations: baseline.observations, timeline: baseline.summary } : {}),
        }, signal);
        if (baseline) await publishBaseline(att, baseline);
        const capped = cap(transcript);
        // Sampling-coverage law (F76 wording): state WHAT was sampled and that
        // the space between samples was never examined — no silent reachability
        // claim, and every catch (frame decode, keyframe pass, baseline) named.
        const visBits = [
          frameIssue,
          keyIssue,
          keyframes.length
            ? `Its visual content WAS read: keyframes were sampled at ${keyframes.length} moment(s) across its timeline, each carrying its video timestamp, so questions about what is ON SCREEN at one of those moments can be answered from them; what happens between, before or after the sampled moments was never examined and cannot be claimed`
            : keyIssue
              ? "the on-screen content was NOT examined: asking about a visual moment has no saved picture to serve"
              : "no scene-change keyframe was sampled (the scene pass found no cut and the seek budget produced no frame), so the on-screen content was NOT examined",
          ...(baselineIssue ? [`${baselineIssue}: follow-ups start from the passages and saved keyframes alone`] : []),
        ].filter((s): s is string => !!s);
        return {
          name, category, ...indexed, frames, durationSec,
          transcript: capped.text, truncated: capped.truncated,
          // The F152 assurance law: naming a visual failure must also state
          // that the audio channel succeeded, in the frozen wording.
          ...(visBits.length ? { coverageNote: `${visBits.join("; ")} — the spoken content WAS read.` } : {}),
        };
      }
      // No attachment: no index is possible, and no frames dir was ever
      // created (the keyframe pass only runs with an att). The inline
      // previews and the plain transcript stand unchanged.
      const capped = cap(transcript);
      return {
        name, category, frames, durationSec, transcript: capped.text, truncated: capped.truncated,
        ...(frameIssue ? { coverageNote: `${frameIssue} — the spoken content WAS read.` } : {}),
      };
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
