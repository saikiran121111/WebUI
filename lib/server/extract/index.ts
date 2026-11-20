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
  readDocumentViaCapability,
  mergePdfUnits,
  mergeOfficeText,
  capabilityBlockerLine,
  type RunJob,
} from "./document-capability";
import { sniffMagic } from "./sniff";
import { decodeText, type DecodedText } from "../../files/encoding";
import {
  decodeAudioPcmFile,
  imageToDataUrlFromPath,
  probeInfo,
  readPcmRange,
  videoFramesFromPath,
  videoKeyframesFromPath,
} from "./ffmpeg";
import {
  asrCapabilityNote,
  transcribePcmFile,
  transcribePcmSegments,
  type AsrSegment,
} from "./audio";
// E (migration): the Python speech backend gets the first attempt on an audio or
// video upload, because it is the multilingual engine with a published language
// table, a measured loudness probe and prepared CPU weights. The TypeScript
// whisper owner below stays as the retained fallback for a RETRYABLE capability
// failure only — never for a structural verdict about the file itself.
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
import type { FrameEntry, TranscriptSegment, TimelineSummary } from "../attachindex/types";

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
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const clean = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (att && clean.length > TEXT_CHAR_LIMIT) {
    const indexed = await indexContent(name, category, att, clean, {}, signal);
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
  const transcript = `${note}\n${asr.text}${coverage}`;
  const durationSec = asr.durationSec;
  if (att && transcript.length > TEXT_CHAR_LIMIT) {
    const indexed = await indexContent(
      name,
      category,
      att,
      transcript,
      { segments: asSegments(asr.segments), ...(durationSec > 0 ? { durationSec } : {}) },
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
 *
 * I15: `signal` (the upload request's own abort signal) cancels the heavy
 * ffmpeg/whisper work mid-extraction when the client goes away, instead of
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
        const indexed = await indexContent(name, category, att, clean, {}, signal);
        return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
      }
      const { buf, partial } = readHead(srcPath, TEXT_READ_BYTES);
      const dec = decodeText(buf);
      if (att && !partial) {
        // Fully in hand but over the prompt budget (multi-byte text): index
        // the WHOLE decoded text, not the capped one textLikeResult would cut.
        const clean = encodingNote(dec) + transformText(category, dec.text).replace(/\r\n/g, "\n").trim();
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
          const mergedResult = await cappedOrIndexed(name, category, att, merged.text, signal);
          return { ...mergedResult, pages: merged.pages, coverageNote: merged.coverageNote };
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
        const r = await cappedOrIndexed(name, category, att, full, signal);
        return {
          ...r,
          pages,
          ...(cap.state === "unavailable" ? { coverageNote: capabilityBlockerLine(cap) } : {}),
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
          const mergedResult = await cappedOrIndexed(name, category, att, merged.text, signal);
          return { ...mergedResult, ...(merged.pages ? { pages: merged.pages } : {}), coverageNote: merged.coverageNote };
        }
        if (officeFail !== null) {
          // cap.state is narrowed to "none" | "unavailable" here: the "ready" case returned above.
          if (cap.state === "none") throw officeFail;
          throw new Error(
            `${name}: ${officeFail instanceof Error ? officeFail.message : String(officeFail)} ` +
            capabilityBlockerLine(cap),
          );
        }
        if (!tsOffice.trim()) {
          throw new Error(
            "No readable text found in this document" +
            (cap.state === "unavailable" ? ` ${capabilityBlockerLine(cap)}` : ""),
          );
        }
        return await cappedOrIndexed(name, category, att, tsOffice, signal);
      }
      if (category === "archive") {
        // The uploaded name is passed along because bare .bz2/.xz streams store
        // no filenames — the inner name only exists in the file name itself.
        // A weak PK sniff can rescue a zip renamed .txt/.dat; the extension
        // then LIES about the container, so the sniffed magic decides instead.
        const arcExt = sniffed && sniffed.category === "archive" ? "zip" : ext;
        return await cappedOrIndexed(name, category, att, await archiveText(buf, arcExt, name), signal);
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
      const img = await imageToDataUrlFromPath(srcPath, { signal });
      return {
        name, category, dataUrl: img.dataUrl,
        pages: img.pages,
        ...(img.frames ? { frames: img.frames } : {}),
      };
    }

    case "audio": {
      // I15: the decode lands in a scratch FILE and whisper reads 30 s
      // windows from it — a 3 h recording used to be buffered whole in RAM
      // (~1.15 GB of float PCM), and neither the decode nor the grind could
      // be cancelled when the user removed the upload mid-way.
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
        // pinned backend's published table). A second engine cannot un-measure it,
        // and re-decoding a silent track is how whisper invents words over nothing.
        throw new Error(`${name}: ${sp.message}`);
      }
      if (sp.state === "unavailable" && sp.reason === "cancelled") {
        throw new Error("The user aborted this request.");
      }
      // Retained TypeScript speech owner (NOT a completed Python migration): used
      // when the capability backend is absent, unprepared or failed for a retryable
      // reason. The blocker line is surfaced so the user knows which engine answered.
      try {
        const dec = await decodeAudioPcmFile(srcPath, { signal });
        try {
          const durationSec = dec.samples / 16000;
          // Short clips still go through in one call; only long recordings
          // pay the windowed file-based path.
          const { text, segments } = durationSec <= 90
            ? await transcribePcmSegments(readPcmRange(dec.file, 0, dec.samples), { signal })
            : await transcribePcmFile(dec.file, dec.samples, { signal });
          // I14: the default whisper checkpoint is English-only — a Hindi
          // recording used to read as "no speech" with no hint why. The note
          // rides on the transcript AND on the no-speech error.
          const note = asrCapabilityNote();
          const blocker =
            sp.state === "unavailable" ? speechBlockerLine(sp) + " " : "";
          if (!text) {
            // The outer catch appends the primary backend's typed reason, so it is
            // not repeated here.
            throw new Error(
              "No speech detected in this audio file" + (note ? ` ${note}` : ""),
            );
          }
          const transcript = [blocker, note, text].filter(Boolean).join("\n");
          if (att && transcript.length > TEXT_CHAR_LIMIT) {
            const indexed = await indexContent(name, category, att, transcript, {
              segments: asSegments(segments),
              durationSec,
            }, signal);
            return {
              name, category, ...indexed,
              transcript: transcript.slice(0, PREVIEW_CHARS),
              truncated: true,
              durationSec,
            };
          }
          return { name, category, transcript, ...cap(transcript), durationSec };
        } finally {
          try { fs.rmSync(dec.file, { force: true }); } catch { /* ignore */ }
        }
      } catch (err: unknown) {
        if (signal?.aborted) throw err as Error; // cancellation is not a media defect
        // The retained engine's own failure stays the headline, but the primary
        // backend's typed reason is appended: "the fallback could not read it
        // either" and "the multilingual engine refused because its weights were
        // never prepared" are different sentences for the user.
        if (sp.state === "unavailable") {
          throw new Error(
            `${err instanceof Error ? err.message : String(err)} ${speechBlockerLine(sp)}`,
          );
        }
        throw err;
      }
    }

    case "video": {
      const { frames, durationSec } = await videoFramesFromPath(srcPath, { signal });
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
        } catch {
          return null; // a missing baseline never fails the upload
        }
      };
      const publishBaseline = async (attId: string, baseline: TimelineEvidence): Promise<void> => {
        try {
          await withIndexWriteLock(attId, async () => {
            if (!attachTimelineDir(indexDir(attId), baseline.scratchDir)) {
              discardTimelineScratch(baseline.scratchDir);
            }
          });
        } catch {
          discardTimelineScratch(baseline.scratchDir);
        }
      };
      // The audio track carries narration — transcribe it when the clip has
      // one so the model hears the video, not just its sampled frames.
      // Keyframes run CONCURRENTLY with audio decode + transcription: on a
      // multi-hour lecture the keyframe pass is pure wall-clock we would
      // otherwise pay after whisper finishes. It is only started when an
      // index could actually use the frames (att present), and it is cleaned
      // up below whenever the transcript turns out not to need an index.
      const kfPromise: Promise<{ at: number; name: string }[] | null> = att
        ? videoKeyframesFromPath(srcPath, framesDir(att), { signal }).catch(() => null)
        : Promise.resolve(null);
      let transcript: string | undefined;
      let segments: AsrSegment[] = [];
      // I16: the old bare catch labelled EVERY audio failure "no decodable
      // audio track" and then deleted the keyframes the video branch had
      // already paid ffmpeg for. The failure reason is kept so the honest
      // outcome states exactly what could and could not be read.
      let speechIssue: string | null = null;
      // E (migration): the Python speech backend answers first when a capability
      // route exists. Its verdicts about the FILE are final and are NOT re-run
      // through the TypeScript whisper path: "ffprobe found 0 audio streams" and
      // "the track was measured silent" are measurements, and a second engine gets
      // the retryable failures only (no backend, unprepared weights, admission
      // refusal, backend crash).
      const sp = await transcribeViaCapability(srcPath, {
        ...(opts?.runJob ? { runJob: opts.runJob } : {}),
        ...(signal ? { signal } : {}),
      });
      let speechEngine: "python" | "typescript" | null = null;
      let pythonAsr: CapabilityAsr | null = null;
      if (sp.state === "ready") {
        transcript = sp.asr.text || undefined;
        segments = sp.asr.segments.map((s) => ({ text: s.text, start: s.start, end: s.end }));
        pythonAsr = sp.asr;
        speechEngine = "python";
        if (!transcript) speechIssue = "the speech backend decoded its audio track and found no speech in it";
      } else if (sp.state === "silence") {
        const level = sp.asr.audioLevel as { max_volume_db?: number };
        speechIssue =
          `no speech was detected in its audio track, which was decoded and measured at ` +
          `${typeof level.max_volume_db === "number" ? level.max_volume_db.toFixed(1) + " dBFS" : "the noise floor"} ` +
          `(a measured verdict, not an inference)`;
        speechEngine = "python";
      } else if (sp.state === "unavailable" && sp.reason === "cancelled") {
        throw new Error("The user aborted this request.");
      } else if (sp.state === "unavailable" && sp.structural) {
        // A zero-audio-stream probe is the same structural fact the TS path reports,
        // just measured: keep the frozen wording and add the evidence behind it.
        speechIssue = /0 audio streams/i.test(sp.message)
          ? "it has no audio track (ffprobe found 0 audio streams)"
          : sp.message;
        speechEngine = "python";
      } else try {
        // Retained TypeScript speech owner for a retryable capability failure.
        speechEngine = "typescript";
        const dec = await decodeAudioPcmFile(srcPath, { signal });
        try {
          const spokenDur = dec.samples / 16000;
          const r = spokenDur <= 90
            ? await transcribePcmSegments(readPcmRange(dec.file, 0, dec.samples), { signal })
            : await transcribePcmFile(dec.file, dec.samples, { signal });
          transcript = r.text || undefined;
          segments = r.segments;
          if (!transcript) speechIssue = "no speech was detected in its audio track";
        } finally {
          try { fs.rmSync(dec.file, { force: true }); } catch { /* ignore */ }
        }
      } catch (err: unknown) {
        if (signal?.aborted) throw err as Error; // cancellation is not an audio defect
        // A failed probe answers in milliseconds, so classifying the
        // failure here can never hang the request.
        const info = await probeOnce();
        speechIssue = /^\s*Stream\s+#\d+:\d+[^\r\n]*Audio/m.test(info)
          ? `its audio track could not be read (${(err as Error)?.message ?? "decode failed"})`
          : "it has no audio track";
      }
      const key = await kfPromise;
      // The English-only warning describes the TypeScript checkpoint, so it is only
      // allowed on a transcript that engine actually produced. Attaching it to a
      // multilingual backend's transcript would be a false claim about the evidence.
      const note = speechEngine === "typescript" ? asrCapabilityNote() : "";
      if (transcript && note) transcript = `${note}\n${transcript}`;
      if (transcript && pythonAsr) {
        transcript = `${speechEngineNote(pythonAsr)}\n${transcript}`;
      }

      if (!transcript) {
        // I16: speech could not be read but the keyframes survived AND an
        // index can carry them → KEEP the frames and build a frames-only
        // knowledge index with an honest coverage note. A silent video is
        // still not an "error"; without an att (no index possible) or
        // without keyframes, the old frames-inline path stands unchanged.
        if (att && key && key.length > 0) {
          const keyframes: FrameEntry[] = key.map(f => ({ at: f.at, file: "frames/" + f.name }));
          const coverageNote =
            `Video "${name}"${durationSec > 0 ? ` (${Math.round(durationSec)}s)` : ""}: ${speechIssue ?? "its spoken content could not be read"}. ` +
            `Its visual content WAS read: keyframes were sampled at ${keyframes.length} moment(s) across its timeline, each carrying its video timestamp, ` +
            `so questions about what is ON SCREEN at a given time can be answered from them; questions about what is SPOKEN cannot.`;
          const baseline = await buildBaseline();
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
        return { name, category, frames, durationSec };
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
          segments: asSegments(segments),
          durationSec,
          frames: keyframes,
          ...(baseline ? { observations: baseline.observations, timeline: baseline.summary } : {}),
        }, signal);
        if (baseline) await publishBaseline(att, baseline);
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
