import {
  transcribeViaCapability,
  type AsrOutcome,
  type SpeechCapabilityOptions,
} from "../extract/speech-capability";
import { embedOne } from "./embed";
import { fmtStamp } from "./format";
import { appendTimedChunks, uploadPath, type TimedChunkUpdate } from "./store";
import type { LoadedIndex } from "./types";

/**
 * F153 item 3 (2026-11-25): the bounded fresh audio read behind a time-range
 * follow-up. "What did she say around 58:40?" over an hour of audio must get
 * an ANSWER, a MEASURED fact, or an honest failure — never silence, and never
 * a re-digest of the whole recording. The law:
 *  - the routed cue window ([cue±180 s, clipped to the duration — the
 *    router's own geometry) is the bound; never the whole file;
 *  - a window the durable record already covers (meta.speech.examined, or a
 *    timed chunk) is NEVER re-decoded: the record (and the Python span cache
 *    keyed on source bytes + interval + engine settings) is the authority;
 *  - a fully-decoded recording (speech.complete) answers a timed gap as a
 *    MEASURED absence — the engine listened there and found no words;
 *  - an unexamined window schedules ONE bounded decode of the ORIGINAL
 *    through the selected-engine path (speech_jobs dispatch law; Parakeet
 *    for English and the configured language policy are that path's own);
 *  - a completed decode is durable: the timed passage becomes a searchable
 *    chunk and the window merges into meta.speech.examined, so adjacent
 *    follow-ups continue across the boundary without loss or duplication
 *    and a timeout keeps every interval it finished;
 *  - every failure names its kind (timeout, cancelled, GPU refusal, decode
 *    failure, unsupported language, no backend, original gone) with the
 *    worker's own reason and whether it is retryable — "no speech found"
 *    and "this window was never listened to" are different sentences.
 * The transcribe seam is injectable so the acceptance fixtures can force each
 * failure deterministically (reread.ts RegionInspector precedent, ⇔ Rust).
 */

/** The router's cue geometry (router.ts [c-180, c+180]); one law, not a copy that can drift. */
export const FRESH_ASR_WINDOW_SEC = 180;
/** Per-ask decode bound: a multi-cue question decodes at most this many windows. */
const MAX_FRESH_WINDOWS = 3;
/** Sub-windows decoded per cue at most (continuation covers the rest on the next ask). */
const MAX_SUB_WINDOWS = 2;

export interface FreshAsrOutcome {
  /** Per-window lines for this turn's evidence block (empty = nothing ran). */
  lines: string[];
  /** Windows this turn's decode actually covered — the invocation proof. */
  spans: Array<[number, number]>;
}

export type TranscribeSeam = (srcPath: string, opts: SpeechCapabilityOptions) => Promise<AsrOutcome>;

/** Merge overlapping/adjacent spans into a sorted disjoint list. */
function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const sorted = spans
    .filter(s => Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0])
    .slice()
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 0.001) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/** win minus spans: the parts of the window the record has NOT listened to. */
export function subtractSpans(win: [number, number], spans: Array<[number, number]>): Array<[number, number]> {
  const merged = mergeSpans(spans);
  const out: Array<[number, number]> = [];
  let cursor = win[0];
  for (const [lo, hi] of merged) {
    if (hi <= cursor + 0.001) continue;
    if (lo > cursor + 0.001) out.push([Math.max(win[0], cursor), Math.min(win[1], lo)]);
    cursor = Math.max(cursor, hi);
    if (cursor >= win[1]) break;
  }
  if (win[1] - cursor > 0.001) out.push([Math.max(win[0], cursor), win[1]]);
  return out.filter(s => s[1] > s[0]);
}

/** The cue window, clipped to the recording — the router's geometry exactly. */
export function windowForCue(cue: number, dur: number): [number, number] | null {
  const lo = Math.max(0, cue - FRESH_ASR_WINDOW_SEC);
  const hi = Math.min(dur, cue + FRESH_ASR_WINDOW_SEC);
  return hi > lo ? [lo, hi] : null;
}

/** Timed spans the searchable record already carries (a point chunk keeps width). */
function chunkSpans(index: LoadedIndex): Array<[number, number]> {
  return index.chunks
    .filter(c => c.startSec != null)
    .map(c => [c.startSec as number, Math.max((c.endSec ?? c.startSec) as number, (c.startSec as number) + 0.5)]);
}

export interface FreshAsrPlan {
  cue: number;
  win: [number, number];
  kind: "read" | "decoded" | "covered";
  /** Un-listened sub-windows of `win` (non-empty only for kind "read"). */
  need: Array<[number, number]>;
}

/**
 * The pure decision, deterministic and content-free (meta + chunks only):
 * for each asked moment, is the window covered by the searchable record,
 * measured-and-silent by a complete decode, or unexamined (fresh read)?
 */
export function planFreshWindows(cues: number[], index: LoadedIndex): FreshAsrPlan[] {
  const dur = index.meta.durationSec ?? 0;
  if (!(dur > 0)) return [];
  const speech = index.meta.speech;
  const spans = chunkSpans(index);
  const out: FreshAsrPlan[] = [];
  for (const cue of [...cues].sort((a, b) => a - b).slice(0, MAX_FRESH_WINDOWS)) {
    const win = windowForCue(cue, dur);
    if (!win) continue;
    const overlap = spans.some(([lo, hi]) => lo < win[1] && hi > win[0]);
    if (speech?.complete) {
      out.push({ cue, win, kind: overlap ? "covered" : "decoded", need: [] });
      continue;
    }
    const examined = speech ? speech.examined : spans;
    const need = subtractSpans(win, mergeSpans(examined));
    out.push({ cue, win, kind: need.length ? "read" : overlap ? "covered" : "decoded", need });
  }
  return out;
}

/** One timed line, the citation form every per-turn rule knows. */
function timedLine(text: string, start: number, end: number | null): string {
  return `[${fmtStamp(start)} - ${fmtStamp(end ?? start)}] ${text.trim()}`;
}

export async function freshAsrForWindows(
  attId: string,
  index: LoadedIndex,
  cues: number[],
  opts: { transcribe?: TranscribeSeam; signal?: AbortSignal } = {},
): Promise<FreshAsrOutcome> {
  const plan = planFreshWindows(cues, index);
  if (!plan.length) return { lines: [], spans: [] };
  const transcribe: TranscribeSeam = opts.transcribe ?? (p => transcribeViaCapability(p, {}));
  const src = uploadPath(attId);
  const lines: string[] = [];
  const spans: Array<[number, number]> = [];
  const updates: TimedChunkUpdate[] = [];

  for (const p of plan) {
    const [lo, hi] = p.win;
    const spanTxt = `${fmtStamp(lo)}–${fmtStamp(hi)}`;
    if (p.kind === "decoded") {
      // Honest scope: only a COMPLETE decode says "end-to-end"; a window
      // inside a PARTIAL decode's examined coverage says what really covers it.
      const why = index.meta.speech?.complete
        ? "this recording was decoded end-to-end when it was indexed"
        : "this window lies inside the span the record has already decoded";
      lines.push(
        `[around ${fmtStamp(p.cue)}: ${why}. ` +
        `The timed transcript carries NO speech in ${spanTxt} — the engine listened there and found no words, ` +
        `so the absence of speech in that window is MEASURED, not an unexamined gap.]`,
      );
      continue;
    }
    if (p.kind === "covered") {
      lines.push(
        `[around ${fmtStamp(p.cue)}: the saved timed transcript covers ${spanTxt}; ` +
        `its passages are searchable — ask the question and they are retrieved.]`,
      );
      continue;
    }
    for (const [sLo, sHi] of p.need.slice(0, MAX_SUB_WINDOWS)) {
      const subTxt = `${fmtStamp(sLo)}–${fmtStamp(sHi)}`;
      if (!src) {
        lines.push(
          `[fresh read of ${subTxt} (around ${fmtStamp(p.cue)}): the original recording is no longer ` +
          `on disk, so this unexamined window cannot be decoded. Everything the recording DID yield is in the saved record.]`,
        );
        continue;
      }
      let out: AsrOutcome;
      try {
        out = await transcribe(src, {
          startSec: sLo,
          endSec: sHi,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (err) {
        lines.push(
          `[fresh read of ${subTxt} (around ${fmtStamp(p.cue)}): the decode call itself failed ` +
          `(${(err as Error)?.message ?? "unknown error"}) — the window stays unexamined; this is retryable.]`,
        );
        continue;
      }
      if (out.state === "ready") {
        const asr = out.asr;
        const eng = `${asr.model || "the selected engine"}${asr.device ? ` on ${asr.device}` : ""}`;
        const body =
          asr.segments
            .map(s => (s.text.trim() ? timedLine(s.text, s.start, s.end) : ""))
            .filter(Boolean)
            .join("\n") || asr.text;
        lines.push(`[fresh decode of ${subTxt} around ${fmtStamp(p.cue)} on this turn's request (${eng}):\n${body}]`);
        if (asr.cappedSegments > 0) {
          lines.push(
            `[decode cap: ${asr.segmentCount} segments produced and ${asr.cappedSegments} middle segment(s) ` +
            `exceeded the delivery window — the full timed decode was indexed.]`,
          );
        }
        const chunkText = `[fresh decode ${subTxt} by ${eng}]\n${body}`;
        let vec: number[] = [];
        try {
          vec = await embedOne(chunkText, opts.signal);
        } catch {
          vec = []; // embed unavailable: lexical-only chunk — the text stays searchable
        }
        updates.push({ text: chunkText, startSec: sLo, endSec: sHi, vec });
        spans.push([sLo, sHi]);
      } else if (out.state === "silence") {
        const level = out.asr.audioLevel as { max_volume_db?: number; noise_floor_db?: number };
        const measured =
          typeof level.max_volume_db === "number"
            ? `decoded and measured at ${level.max_volume_db.toFixed(1)} dBFS peak, at or below the noise floor`
            : "decoded with no speech detected";
        lines.push(
          `[fresh decode of ${subTxt} around ${fmtStamp(p.cue)}: the window was ${measured}. ` +
          `No speech exists in that window — a MEASURED fact, not an unexamined gap.]`,
        );
        spans.push([sLo, sHi]); // the silence verdict is durable: never re-decode this span
      } else if (out.state === "unavailable") {
        lines.push(
          `[fresh decode of ${subTxt} around ${fmtStamp(p.cue)} produced no speech: ` +
          `reason ${out.reason}${out.message ? ` (${out.message})` : ""} — ` +
          `${out.retryable ? "this is retryable: ask again" : (out.humanStep || "not retryable")}.]`,
        );
      } else {
        lines.push(
          `[no speech backend is configured in this deployment, so ${subTxt} ` +
          `(around ${fmtStamp(p.cue)}) cannot be decoded on demand.]`,
        );
      }
    }
  }

  if (updates.length || spans.length) await appendTimedChunks(attId, updates, spans);
  return { lines, spans };
}

/**
 * The production FreshAsrReader shape used by buildAttachmentTurn (see turn.ts).
 * ⇔ makeRegionReader: injectable seams, one law, the golden path never wires one.
 */
export type FreshAsrReader = (
  attId: string,
  index: LoadedIndex,
  cues: number[],
  signal?: AbortSignal,
) => Promise<FreshAsrOutcome>;

export function makeFreshAsrReader(
  opts: { transcribe?: TranscribeSeam; signal?: AbortSignal } = {},
): FreshAsrReader {
  return (attId, index, cues, signal) =>
    freshAsrForWindows(attId, index, cues, {
      ...(opts.transcribe ? { transcribe: opts.transcribe } : {}),
      signal: signal ?? opts.signal,
    });
}
