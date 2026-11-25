import path from "node:path";
import { mlJob, type MlJobEnvelope, type MlJobOptions } from "../ml-job";
import { FRAME_OCR_CAPABILITY, FRAME_OCR_LANGUAGE_ENV } from "./timeline";
import { appendFrames, appendTimedChunks, uploadPath, type SeekedFrameUpdate } from "./store";
import { embedOne } from "./embed";
import { fmtStamp } from "./format";
import type { LoadedIndex } from "./types";

/**
 * F153 item 4 (2026-11-25): the on-demand visual seek behind a time-range
 * follow-up. "What was on screen at 02:10?" over a recording whose saved
 * keyframes do not reach that instant must get the PICTURE at that instant,
 * a MEASURED fact, or an honest named failure — never the golden sentence
 * "never captured" while the original sits on disk two directories away.
 * The law:
 *  - the asked cue moments (the router's own geometry, ≤ 4 of them, the same
 *    MAX_FRAMES budget a saved-frame turn serves) are the bound; each decodes
 *    ONE frame of the ORIGINAL through the video.frame_ocr capability with
 *    include_image — the worker's keyframe-accurate `-ss` seek, aligned to
 *    the media's own presentation timeline, never a re-digest of the video;
 *  - a configured text language rides the request (the F17 law: never
 *    defaulted); with no language configured the seek is pixels-only and the
 *    worker states on every frame that the text was NOT read — a color has no
 *    glyphs, so pixels must never be held hostage to an OCR language;
 *  - a delivered frame is durable: the picture becomes a saved frame
 *    (store.appendFrames) so the next follow-up answers from the record and
 *    never re-decodes that instant, and recognised on-screen text becomes a
 *    timed searchable chunk (the F153 item-3 appendTimedChunks law);
 *  - every non-delivery names its kind (no capability route, backend
 *    refusal, transport-bound omission, decode failure, out-of-range,
 *    cancelled, original gone) with the worker's own reason and whether it is
 *    retryable — a seek failure never voids the frames that DID arrive.
 * The runJob seam (⇔ timeline.ts) lets the acceptance fixtures force each
 * failure deterministically; no production caller passes one.
 */

/** ⇔ MAX_FRAMES in turn.ts (and ruke-attach turn.rs): one turn shows at most this many moments. */
export const SEEK_MAX_CUES = 4;
/**
 * Chat-time bound. Half the upload-time FRAME_OCR_DEADLINE_MS (180 s): a
 * follow-up is an interactive turn, and the ML job clamps this into its own
 * transport window. The worker bounds the PIXEL budget itself (≤ 8 frames).
 */
export const SEEK_DEADLINE_MS = 90_000;

export interface FrameSeekOutcome {
  /** Pixels delivered to THIS turn (data URLs, aligned to the asked instants). */
  images: { url: string; at: number }[];
  /** Per-instant sentences for the evidence block: what ran, what was read, what failed. */
  lines: string[];
  /** Instants this turn's seek decoded and delivered — the invocation proof. */
  spans: number[];
  /** Frames persisted to the durable record this turn (coverage-marker count). */
  durable: number;
}

export type SeekFramesReader = (
  attId: string,
  index: LoadedIndex,
  cues: number[],
  signal?: AbortSignal,
) => Promise<FrameSeekOutcome>;

export interface FrameSeekOptions {
  runJob?: (
    capability: string,
    payload: Record<string, unknown>,
    opts?: MlJobOptions,
  ) => Promise<MlJobEnvelope | null>;
  frameLanguage?: string;
  signal?: AbortSignal;
}

export async function seekFramesForCues(
  attId: string,
  index: LoadedIndex,
  cues: number[],
  opts: FrameSeekOptions = {},
): Promise<FrameSeekOutcome> {
  const run = opts.runJob ?? mlJob;
  const out: FrameSeekOutcome = { images: [], lines: [], spans: [], durable: 0 };
  const dur = index.meta.durationSec ?? 0;
  const moments = [...new Set(cues.filter(c => Number.isFinite(c) && c >= 0))].slice(0, SEEK_MAX_CUES);
  if (!moments.length) return out;
  const asked = moments.map(m => fmtStamp(m)).join(", ");
  const src = uploadPath(attId);
  if (!src) {
    out.lines.push(
      `[visual seek of ${asked}: the original recording is no longer on disk, so these ` +
      `moments cannot be decoded on demand. Everything the record DID capture is in the saved frames.]`,
    );
    return out;
  }
  if (opts.signal?.aborted) {
    out.lines.push(
      `[visual seek of ${asked}: the request was cancelled before any frame was decoded; ` +
      `the moments stay unviewed and this is retryable: ask again.]`,
    );
    return out;
  }
  // The F17 law: the language is the operator's switch, never a default.
  // Empty = pixels-only (the worker states on every frame that text was not read).
  const language = (opts.frameLanguage ?? process.env[FRAME_OCR_LANGUAGE_ENV] ?? "").trim();

  let envelope: MlJobEnvelope | null;
  try {
    const media = path.resolve(src);
    envelope = await run(
      FRAME_OCR_CAPABILITY,
      {
        path: media,
        root: path.dirname(media),
        language,
        duration: dur,
        times: moments,
        max_frames: moments.length,
        include_image: true,
      },
      { deadlineMs: SEEK_DEADLINE_MS, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
  } catch (err) {
    out.lines.push(
      `[visual seek of ${asked}: the decode call itself failed ` +
      `(${(err as Error)?.message ?? "unknown error"}) — these moments stay unviewed; ` +
      `this is retryable: ask again.]`,
    );
    return out;
  }
  if (envelope === null) {
    out.lines.push(
      `[visual seek of ${asked}: this deployment has no capability route, so the frames ` +
      `behind these moments cannot be decoded on demand.]`,
    );
    return out;
  }
  if (envelope.state !== "ready") {
    const reason = envelope.error?.reason ?? envelope.state;
    const message = envelope.error?.message ?? `the seek ended in state ${envelope.state}`;
    const retry = envelope.error?.retryable
      ? "this is retryable: ask again"
      : (envelope.error?.human_step || "not retryable");
    out.lines.push(
      `[visual seek of ${asked}: ${reason}: ${message} — ${retry}]`,
    );
    return out;
  }
  const result = envelope.result && typeof envelope.result === "object"
    ? (envelope.result as Record<string, unknown>)
    : null;
  const frames = Array.isArray(result?.frames) ? (result.frames as unknown[]) : null;
  if (!frames) {
    out.lines.push(
      `[visual seek of ${asked}: contract_mismatch: the seek reported success with no ` +
      `per-frame records, so nothing is credited and the moments stay unviewed.]`,
    );
    return out;
  }
  const engine = result?.ocr && typeof result.ocr === "object"
    && typeof (result.ocr as Record<string, unknown>).engine === "string"
    ? String((result.ocr as Record<string, unknown>).engine)
    : "";

  const updates: SeekedFrameUpdate[] = [];
  const readText: Array<{ at: number; text: string }> = [];
  for (const entry of frames) {
    const f = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const t = typeof f.time_s === "number" && Number.isFinite(f.time_s) ? f.time_s : NaN;
    if (!(t >= 0)) continue; // an unusable timestamp is no evidence in front of the model
    if (!moments.some(m => Math.abs(m - t) < 0.5)) continue; // only the asked instants
    const stamp = fmtStamp(t);
    const state = typeof f.state === "string" ? f.state : "unknown";
    const detail = typeof f.detail === "string" ? f.detail : "";
    const eng = engine ? ` (recogniser ${engine})` : "";
    let buf: Buffer | null = null;
    if (typeof f.image_b64 === "string" && f.image_b64) {
      const b = Buffer.from(f.image_b64, "base64");
      if (b.length) buf = b;
    }
    const text = state === "recognised" && typeof f.text === "string" ? f.text.trim() : "";
    if (buf && (state === "recognised" || state === "pixels" || state === "duplicate" || state === "empty")) {
      updates.push({ at: t, bytes: buf, state });
      out.images.push({ url: `data:image/png;base64,${buf.toString("base64")}`, at: t });
      out.spans.push(t);
      const scope =
        state === "recognised" ? `the recogniser read this on-screen text: "${text}"${eng}`
        : state === "pixels" ? "on-screen text was NOT read (no text language is configured), so the picture is the whole evidence"
        : state === "duplicate"
          ? `the picture is byte-identical to the frame at ${fmtStamp(typeof f.copy_of_time === "number" ? f.copy_of_time : t)}${detail.includes("pixels omitted") ? `; ${detail}` : ""}`
          : "the recogniser ran on this frame and found no glyphs";
      out.lines.push(
        `[asked ${stamp}: the seek decoded the frame at ${stamp} from the original recording ` +
        `and delivered its pixels; ${scope}]`,
      );
      if (text) readText.push({ at: t, text });
      continue;
    }
    if (state === "recognised" || state === "pixels" || state === "duplicate" || state === "empty") {
      // Decoded, pixels NOT delivered (over the transport bound): the omission
      // is the worker's own detail, never a silent gap. The instant is NOT
      // claimed durable — the next follow-up re-seeks.
      out.lines.push(
        `[asked ${stamp}: the frame at ${stamp} decoded but its pixels were not delivered ` +
        `(${detail || "no pixels in the response"})${text ? `; the recogniser read: "${text}"` : ""} — ` +
        `the picture at that moment stays unviewed; this is retryable: ask again.]`,
      );
      if (text) readText.push({ at: t, text });
      continue;
    }
    // out_of_range, frame_failed, ocr_failed, skipped, not_run: named per instant.
    out.lines.push(
      `[asked ${stamp}: the frame at ${stamp} was not decoded (${state}${detail ? `: ${detail}` : ""}) — ` +
      `what is on screen at that time was not seen this turn; this is retryable: ask again.]`,
    );
  }

  if (opts.signal?.aborted && (updates.length || out.images.length)) {
    // Cancelled mid-seek: a dead turn gets nothing (the picture may be torn,
    // and a cancelled ask claims no spans). Keep the per-instant naming.
    out.lines.push(
      `[visual seek: the request was cancelled during the decode; the frames decoded so far ` +
      `were not saved; this is retryable: ask again.]`,
    );
    updates.length = 0;
    readText.length = 0;
    out.images.length = 0;
    out.spans.length = 0;
  }

  if (updates.length) {
    try {
      out.durable = await appendFrames(attId, updates);
    } catch (err) {
      out.lines.push(
        `[visual seek: the decoded frame(s) could not be saved to the record ` +
        `(${(err as Error)?.message ?? "unknown error"}) — this turn still shows them; ` +
        `a later follow-up may decode the same moment again.]`,
      );
    }
  }
  for (const rt of readText) {
    const chunkText = `[on-screen text decoded at ${fmtStamp(rt.at)} by on-demand visual seek]\n${rt.text}`;
    let vec: number[] = [];
    try {
      vec = await embedOne(chunkText, opts.signal);
    } catch {
      vec = []; // embed unavailable: lexical-only chunk — the words stay searchable
    }
    try {
      await appendTimedChunks(attId, [{ text: chunkText, startSec: rt.at, endSec: rt.at, vec }]);
    } catch {
      // The words ride THIS turn's lines regardless; persistence is best effort.
    }
  }
  return out;
}

/**
 * The production SeekFramesReader shape used by buildAttachmentTurn (see turn.ts).
 * ⇔ makeFreshAsrReader: injectable seams, one law, the golden path never wires one.
 */
export function makeFrameSeeker(opts: FrameSeekOptions = {}): SeekFramesReader {
  return (attId, index, cues, signal) =>
    seekFramesForCues(attId, index, cues, {
      ...(opts.runJob ? { runJob: opts.runJob } : {}),
      ...(opts.frameLanguage ? { frameLanguage: opts.frameLanguage } : {}),
      signal: signal ?? opts.signal,
    });
}
