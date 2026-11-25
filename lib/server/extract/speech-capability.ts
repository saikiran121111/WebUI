/**
 * speech-capability.ts - the PRODUCTION CALLER for the Python `speech.asr` job.
 *
 * Why this module exists: the Python ASR adapter (`ruke_ml.speech.whisper_ct2`,
 * CTranslate2/faster-whisper, CPU int8, weights prepared inside the project) was
 * implemented, asset-pinned and executed for real by the E03 probe, but the
 * upload path still only knew about the TypeScript transformers.js whisper
 * checkpoint. That is a capability the user could not reach, and it is the one
 * asymmetry that matters here: the Python backend is MULTILINGUAL and publishes a
 * language table plus a measured loudness probe, while the TS default checkpoint
 * is English-only. Wiring it is a routing change, not a status-string change -
 * nothing in the Python worker reports itself as available unless its readiness
 * gate says so, and this module refuses any "success" it cannot inspect.
 *
 * The five facts the Python worker keeps apart are preserved here in the same
 * order the worker states them, because collapsing them is how a missing audio
 * track becomes a false transcript:
 *   NO AUDIO TRACK (structural probe) | SILENCE (measured, no ASR ran) |
 *   NO SPEECH (ASR ran, produced nothing) | FAILED (decode/model/backend) |
 *   UNSUPPORTED LANGUAGE (published table verdict).
 *
 * F123 (2026-11-23): the Python job's pinned Parakeet row is the SOLE transcription
 * engine for uploaded audio AND video audio tracks. The old TypeScript whisper
 * substitution is removed - "no endpoint", "weights not prepared", "resource
 * admission refused" and "backend crash" are no longer reasons to run a different
 * model; they are ACTIONABLE admission states this module reports (message,
 * human_step, retryable) and the upload path propagates them to the user, who
 * retries the SAME engine once the condition clears. A structural verdict
 * (zero audio streams, corrupt container, unsupported language) is final for the
 * file and never retried with any engine: a container with zero audio streams does
 * not get a second chance from a different decoder, and a MEASURED silent track
 * does not get re-decoded by an engine that will invent words over silence.
 */
import path from "node:path";

import {
  mlJob,
  type MlJobEnvelope,
  type MlJobOptions,
} from "../ml-job";

import { fmtStamp } from "../attachindex/format";

export const SPEECH_ASR_CAPABILITY = "speech.asr";

/**
 * Bounded deliberately: this runs inside an upload request. The worker's own
 * deadline law lives in ml_job.rs (1s..600s), so the client bound stays inside it
 * and the transport grace is added by ml-job.ts itself.
 */
export const SPEECH_ASR_DEADLINE_MS = 240_000;

/** Explicit operator switch, never defaulted and never guessed per file. */
export const SPEECH_LANGUAGE_ENV = "RUKE_SPEECH_LANGUAGE";
/** Set to "off" to disable the Python speech job (F123: with it off, speech
 *  uploads report the actionable "no engine available" admission state - the
 *  removed TypeScript whisper substitution never returns through this switch). */
export const SPEECH_CAPABILITY_ENV = "RUKE_SPEECH_CAPABILITY";

/** Segments on the wire are bounded by the adapter (MAX_RETAINED_SEGMENTS). */
const MAX_SEGMENTS = 20_000;

/**
 * F153 (2026-11-24): the cap must never silently eat the TAIL. On overflow the
 * adapter serializes the head PLUS this bounded tail window, so the final fact rides
 * with its timestamp into every consumer; the skipped MIDDLE is counted
 * (cappedSegments), forces complete=false, and survives in the full timed
 * transcript the index keeps durably.
 */
const MAX_TAIL_SEGMENTS = 200;

/** The injectable job seam, identical in shape to the document/timeline modules. */
export type RunAsrJob = (
  capability: string,
  payload: Record<string, unknown>,
  opts?: MlJobOptions,
) => Promise<MlJobEnvelope | null>;

export interface SpeechCapabilityOptions {
  runJob?: RunAsrJob;
  signal?: AbortSignal;
  deadlineMs?: number;
  /** "" / "auto" mean "let the backend detect"; an explicit tag is validated there. */
  language?: string;
  /** Word timing is demand-driven: it costs a second pass and is never automatic. */
  wordTimestamps?: boolean;
  /** Bounds a long recording's decode windows; the worker clamps to >= 2 s. */
  windowSec?: number;
  /**
   * F152 (question-driven interval): bound the DECODED span — "what is said around
   * 12:40?" decodes that span, not the whole track. Geometry and the 3-hour bound are
   * the WORKER's law (it refuses a span that does not fit the measured duration);
   * this seam only refuses to serialize numbers that are not numbers.
   */
  startSec?: number;
  endSec?: number;
}

export interface AsrCapabilitySegment {
  /** Source-relative seconds. Chunk offsets are the adapter's job, not ours. */
  start: number;
  end: number | null;
  text: string;
  /** Present only when the provider really supplied word timing. */
  words?: { word: string; start: number; end: number; probability: number | null }[];
  /**
   * The adapter set this when the reading was CUT OFF at the edge of one of our own
   * decode windows and no complete reading of the same span exists. The last word is
   * then not the end of the sentence, and a caller must not present it as one.
   */
  windowTruncated?: boolean;
}

/**
 * A reading the adapter removed from the transcript because a COMPLETE reading of the
 * same span exists. Kept on the wire so "we dropped a fragment" is auditable: the text,
 * the window that cut it, which edge was cut, and which reading replaced it.
 */
export interface AsrCapabilityFragment {
  start: number;
  end: number | null;
  text: string;
  /** The decode window this reading came from, [start, end] in source seconds. */
  window: number[];
  /** Which edge of the window truncated it: "end" | "start" | "" if unstated. */
  cutAt: string;
  /** The complete reading that covers it. */
  supersededBy?: { start: number; end: number | null };
  reason: string;
}

export interface CapabilityAsr {
  /** "transcribed" or "silence" - both are RESULTS, and only one ran ASR. */
  state: string;
  text: string;
  segments: AsrCapabilitySegment[];
  /** What the worker says it produced, kept separate from what survived validation. */
  segmentCount: number;
  droppedSegments: number;
  /** F153: valid segments beyond the serialized head+tail window - the skipped middle. */
  cappedSegments: number;
  /**
   * F153: the FULL timed transcript ([HH:MM:SS - HH:MM:SS] per validated segment,
   * middle included) for the durable index; "" when nothing was skipped, because
   * then the serialized segments already carry everything.
   */
  fullTranscriptText: string;
  /**
   * F153: EVERY validated segment (head + skipped middle + tail). The durable
   * index must CHUNK the whole timeline, not just the delivery window - chunking
   * from the window alone left the skipped middle in full.txt with NO searchable
   * chunk, so the time-range retrieval the cap note promises found nothing.
   */
  allSegments: AsrCapabilitySegment[];
  language: string;
  languageSource: string;
  languageProbability: number | null;
  model: string;
  device: string;
  computeType: string;
  durationSec: number;
  complete: boolean;
  asrRan: boolean;
  note: string;
  /** Seconds this run actually decoded. */
  examined: [number, number][];
  /** Seconds it never decoded - absence there is unproven, not established. */
  unexamined: [number, number][];
  audioLevel: Record<string, unknown>;
  probe: Record<string, unknown>;
  routing: Record<string, unknown>;
  /** Did a window ACTUALLY run speech-gated? Not whether gating was merely requested. */
  vadFilter: boolean;
  /** What the speech-activity filter really did, incl. the cases where it could not. */
  vadState: string;
  /** Readings dropped because a complete reading of the same span already exists. */
  supersededFragments: number;
  /** The dropped fragments themselves, bounded by the adapter. Never empty-with-count. */
  superseded: AsrCapabilityFragment[];
  /** How many segments carry `windowTruncated`. */
  truncatedSegments: number;
  /**
   * F152 durable-record state as the worker reported it: "hit" (served from the
   * durable record: zero engine invocations), "stored", "not_stored", "" (worker
   * predates the record). "hit" is provenance: the answer is the recorded one for
   * these exact bytes, span and engine.
   */
  cacheState: string;
  /** The span the record is keyed on, [start, end] source seconds (""-list unstated). */
  cacheSpan: number[];
  /**
   * Item 5 (user brief 2026-11-24): wall clock the recognition engine ran, stamped by
   * the worker at the adapter call's boundaries. "" / null = a worker that recorded no
   * clock. On a durable-record hit this is the ORIGINAL run's clock — no engine ran for
   * this request, and the recorded span is the only honest timestamp.
   */
  recognition: { engine: string; device: string; startedAt: string; finishedAt: string; wallS: number | null };
}

export type AsrOutcome =
  | { state: "ready"; asr: CapabilityAsr }
  /** Measured silence: a result, not a failure, and no inference ran. */
  | { state: "silence"; asr: CapabilityAsr }
  /** No capability backend at all (no endpoint configured): caller keeps its own path. */
  | { state: "none" }
  | {
      state: "unavailable";
      reason: string;
      message: string;
      humanStep: string;
      retryable: boolean;
      /** True when the refusal is a fact about the FILE, so another engine cannot help. */
      structural: boolean;
    };

/** Reasons that describe the input, not the backend - a second engine cannot fix them. */
const STRUCTURAL_REASONS = new Set([
  "unsupported_input",
  "input_rejected",
  "corrupt_input",
  "unsupported_language",
]);

export function speechCapabilityDisabled(): boolean {
  return (process.env[SPEECH_CAPABILITY_ENV] ?? "").trim().toLowerCase() === "off";
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function spanList(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  const out: [number, number][] = [];
  for (const item of value) {
    if (!Array.isArray(item)) continue;
    const a = num(item[0]);
    const b = num(item[1]);
    if (a !== null && b !== null && b >= a) out.push([a, b]);
  }
  return out;
}

/**
 * Validate the worker's own payload instead of trusting that it is well shaped.
 * A segment with no usable text or non-monotonic timing is DROPPED AND COUNTED:
 * dropping silently would hide a broken backend, and keeping it would put an
 * unusable timestamp in front of the model.
 */
function normalizeAsr(result: unknown): CapabilityAsr | null {
  const raw = obj(result);
  const state = str(raw.state);
  const segmentsIn = Array.isArray(raw.segments) ? raw.segments : [];
  // F153 (2026-11-24): inspect EVERY slice the cap touches. The old
  // `segmentsIn.slice(0, MAX_SEGMENTS)` kept the first 20k and walked away: with
  // 20,001 valid segments and a unique fact in the last one, the final fact was
  // gone from the delivered evidence, the index, the cache and reload/compaction
  // while the record claimed segmentCount=20001, droppedSegments=0, complete=true.
  // Now: head + a bounded tail window serialize (the final fact keeps its
  // timestamp); the middle is validated, counted, and preserved in the full timed
  // transcript the index keeps durably.
  const headEnd = Math.min(segmentsIn.length, MAX_SEGMENTS);
  const tailStart =
    segmentsIn.length > headEnd
      ? Math.max(headEnd, segmentsIn.length - MAX_TAIL_SEGMENTS)
      : segmentsIn.length;
  const segments: AsrCapabilitySegment[] = [];
  const validated: AsrCapabilitySegment[] = [];
  let dropped = 0;
  segmentsIn.forEach((entry, idx) => {
    const seg = obj(entry);
    const text = str(seg.text).trim();
    const start = num(seg.start);
    const end = num(seg.end);
    if (!text || start === null || start < 0) {
      dropped++;
      return;
    }
    if (end !== null && end < start) {
      dropped++;
      return;
    }
    const words = Array.isArray(seg.words)
      ? seg.words
          .map((w) => {
            const word = obj(w);
            const ws = num(word.start);
            const we = num(word.end);
            const text = str(word.word).trim();
            if (!text || ws === null) return null;
            return {
              word: text,
              start: ws,
              end: we ?? ws,
              probability: num(word.probability),
            };
          })
          .filter((w): w is NonNullable<typeof w> => w !== null)
      : undefined;
    const kept: AsrCapabilitySegment = {
      start,
      end,
      text,
      ...(words && words.length ? { words } : {}),
      // Only ever set from the adapter's own provenance; never inferred from text.
      ...(seg.window_truncated === true ? { windowTruncated: true } : {}),
    };
    validated.push(kept);
    if (idx < headEnd || idx >= tailStart) segments.push(kept);
  });
  const cappedSegments = tailStart - headEnd;
  // A fragment is only ever evidence that a window was cut: it is NOT part of `text`,
  // and a caller that flattens these into an answer would be inventing sentence ends.
  const superseded: AsrCapabilityFragment[] = (
    Array.isArray(raw.superseded) ? raw.superseded : []
  )
    .slice(0, MAX_SEGMENTS)
    .map((entry) => {
      const frag = obj(entry);
      const start = num(frag.start);
      const end = num(frag.end);
      const text = str(frag.text).trim();
      if (!text || start === null) return null;
      const by = obj(frag.superseded_by);
      const byStart = num(by.start);
      return {
        start,
        end,
        text,
        window: (Array.isArray(frag.window) ? frag.window : [])
          .map((v) => num(v))
          .filter((v): v is number => v !== null),
        cutAt: str(frag.cut_at),
        ...(byStart === null ? {} : { supersededBy: { start: byStart, end: num(by.end) } }),
        reason: str(frag.reason),
      };
    })
    .filter((f): f is AsrCapabilityFragment => f !== null);
  const asrRan = typeof raw.asr_ran === "boolean" ? raw.asr_ran : state !== "silence";
  const truncatedSegments = segments.filter((s) => s.windowTruncated).length;
  const cacheObj = obj(raw.cache);
  const cacheSpan: number[] = Array.isArray(cacheObj.span)
    ? (cacheObj.span as unknown[]).map((v) => num(v)).filter((v): v is number => v !== null)
    : [];
  const asr: CapabilityAsr = {
    state: state || (asrRan ? "transcribed" : "silence"),
    text: str(raw.text).trim(),
    segments,
    segmentCount: num(raw.segment_count) ?? segmentsIn.length,
    droppedSegments: dropped,
    cappedSegments,
    fullTranscriptText:
      cappedSegments > 0
        ? validated
            .map((s) => `[${fmtStamp(s.start)} - ${fmtStamp(s.end ?? s.start)}] ${s.text}`)
            .join("\n")
        : "",
    allSegments: validated,
    language: str(raw.language),
    languageSource: str(raw.language_source),
    languageProbability: num(raw.language_probability),
    model: str(raw.model),
    device: str(raw.device),
    computeType: str(raw.compute_type),
    durationSec: num(raw.duration) ?? 0,
    // A run whose middle the cap skipped is NOT complete, whatever the worker said.
    complete: raw.complete === true && cappedSegments === 0,
    asrRan,
    note: str(raw.note),
    examined: spanList(raw.examined),
    unexamined: spanList(obj(raw.coverage).skipped),
    audioLevel: obj(raw.audio_level),
    probe: obj(raw.probe),
    routing: obj(raw.routing),
    vadFilter: raw.vad_filter === true,
    vadState: str(raw.vad_state),
    // Count and list are kept apart on purpose: the adapter caps the list, so a larger
    // count is honest reporting, not a mismatch to hide.
    supersededFragments: num(raw.superseded_fragments) ?? superseded.length,
    superseded,
    truncatedSegments,
    cacheState: str(cacheObj.state),
    cacheSpan,
    recognition: (() => {
      const rec = obj(raw.recognition);
      return {
        engine: str(rec.engine),
        device: str(rec.device),
        startedAt: str(rec.started_utc),
        finishedAt: str(rec.finished_utc),
        wallS: num(rec.wall_s),
      };
    })(),
  };
  // A "ready" result must carry SOMETHING inspectable. Empty text plus zero counted
  // segments is only honest when the worker says why (silence / measured level),
  // and `state`/`audio_level` are what carry that claim.
  if (!asr.text && !segments.length && asr.state !== "silence" && !Object.keys(asr.audioLevel).length) {
    return null;
  }
  return asr;
}

/** One line naming what the Python speech backend could not do, for the user's note. */
export function speechBlockerLine(outcome: Extract<AsrOutcome, { state: "unavailable" }>): string {
  const step = outcome.humanStep ? ` Next step: ${outcome.humanStep}.` : "";
  return `[speech backend: ${outcome.message}]${step}`;
}

/**
 * Attribution for a transcript produced by the Python backend. It names the
 * checkpoint, the device, the compute type and the language verdict as they were
 * REPORTED BY THE RUN, so a multilingual claim is auditable instead of implied.
 */
export function speechEngineNote(asr: CapabilityAsr): string {
  const bits: string[] = [];
  if (asr.model) bits.push(`speech model "${asr.model}"`);
  if (asr.device) bits.push(`${asr.device}${asr.computeType ? `/${asr.computeType}` : ""}`);
  if (asr.language) {
    bits.push(
      `language ${asr.language}${asr.languageSource === "detected" ? " (detected)" : asr.languageSource === "explicit" ? " (as specified)" : ""}`,
    );
  }
  if (asr.segments.some((s) => s.words?.length)) bits.push("word timing supplied by the provider");
  else bits.push("segment-level timing only (no word timing was requested or provided)");
  // Speech gating is reported as what the run DID, using the worker's own state token.
  // "requested" is never written as "applied", and a missing asset is stated out loud.
  if (asr.vadState === "applied") bits.push("speech-activity gating applied per window");
  else if (asr.vadState) bits.push(`speech-activity gating ${asr.vadState}`);
  // Window-cut honesty: a truncated reading is in the transcript, and the model must
  // know its last word may not be the end of the sentence.
  if (asr.truncatedSegments)
    bits.push(`${asr.truncatedSegments} segment(s) cut at a decode-window boundary`);
  if (asr.supersededFragments)
    bits.push(`${asr.supersededFragments} window-boundary fragment(s) replaced by a complete reading`);
  // F152: a record hit is provenance, stated from the worker's own cache state -
  // the words are the recorded ones for these exact bytes, span and engine.
  if (asr.cacheState === "hit")
    bits.push("served from the durable record of these exact bytes, span and engine (zero inference runs this request)");
  // Item 5: the recognition clock, from the worker's own stamps — the user-visible
  // proof of WHEN the named engine ran. Absent = a predating worker, stated plainly.
  if (asr.recognition.startedAt)
    bits.push(
      `recognised ${asr.recognition.startedAt}${asr.recognition.engine ? ` by ${asr.recognition.engine}` : ""}` +
        (asr.recognition.wallS != null ? ` (${asr.recognition.wallS}s wall)` : ""),
    );
  if (!asr.complete) bits.push("coverage was partial: unexamined audio cannot prove absence");
  return `[${bits.join("; ")}]`;
}

/**
 * Run one speech.asr job. Never throws: every failure is a typed state, and
 * cancellation is reported as cancellation rather than as a media defect.
 */
export async function transcribeViaCapability(
  srcPath: string,
  opts: SpeechCapabilityOptions = {},
): Promise<AsrOutcome> {
  if (speechCapabilityDisabled()) return { state: "none" };
  const run: RunAsrJob = opts.runJob ?? mlJob;
  const resolved = path.resolve(srcPath);
  const language = (opts.language ?? process.env[SPEECH_LANGUAGE_ENV] ?? "").trim();

  const payload: Record<string, unknown> = { path: resolved, root: path.dirname(resolved) };
  if (language) payload.language = language;
  if (opts.wordTimestamps) payload.word_timestamps = true;
  if (opts.windowSec) payload.window_s = opts.windowSec;
  // F152: the interval travels as the worker's own payload keys. Only a real pair of
  // finite numbers is serialized; a half-named span is NOT sent (a lone bound would
  // make the worker treat the run as an inspection with an open edge, and the caller
  // asking for "around 12:40" must mean a named range). Geometry refusals and the
  // 3-hour bound stay the worker's typed law - this seam does not second-guess the
  // probe's duration it does not have.
  if (
    typeof opts.startSec === "number" && Number.isFinite(opts.startSec) && opts.startSec >= 0 &&
    typeof opts.endSec === "number" && Number.isFinite(opts.endSec) && opts.endSec > opts.startSec
  ) {
    payload.start_s = opts.startSec;
    payload.end_s = opts.endSec;
  }

  const envelope = await run(SPEECH_ASR_CAPABILITY, payload, {
    deadlineMs: opts.deadlineMs ?? SPEECH_ASR_DEADLINE_MS,
    signal: opts.signal,
  });
  if (envelope === null) return { state: "none" };

  if (envelope.state === "cancelled") {
    return {
      state: "unavailable",
      reason: "cancelled",
      message: "the speech job was cancelled before it produced a transcript",
      humanStep: "",
      retryable: false,
      structural: false,
    };
  }

  if (envelope.state === "ready") {
    const asr = normalizeAsr(envelope.result);
    if (!asr) {
      return {
        state: "unavailable",
        reason: "contract_mismatch",
        message:
          "the speech backend reported a successful run that carries no inspectable transcript and no measured audio verdict, which is refused rather than reported as an empty recording",
        humanStep: "report this: the payload shape and the backend version must match",
        retryable: false,
        structural: false,
      };
    }
    return asr.state === "silence" ? { state: "silence", asr } : { state: "ready", asr };
  }

  const error = envelope.error;
  const reason = error?.reason || (envelope.state === "cancelled" ? "cancelled" : "internal");
  return {
    state: "unavailable",
    reason,
    message: error?.message || `the speech job ended in state ${envelope.state}`,
    humanStep: error?.human_step || "",
    retryable: error?.retryable === true,
    structural: STRUCTURAL_REASONS.has(reason),
  };
}
