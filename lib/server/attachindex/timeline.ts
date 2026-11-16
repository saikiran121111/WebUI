/**
 * timeline.ts - the cheap, DURABLE media baseline for an indexed attachment.
 *
 * F13/P7 (brief section 8): a video used to be reduced to two sampled frames
 * plus an eager English-only transcript, and everything the extractor did not
 * think to compute at upload time was unrecoverable without a re-upload. The
 * fix is a timeline record: what the container ACTUALLY holds (streams, real
 * durations, per-stream start offsets, rotation, subtitle tracks) plus what has
 * ACTUALLY been examined (coverage), stored next to the index so a deeper
 * follow-up question starts from evidence instead of from zero.
 *
 * Division of labour, deliberately:
 *  - parsing the container report is deterministic TS work (no model, no
 *    download) - see parseMediaProbe();
 *  - the durable record + coverage arithmetic live in the capability backend
 *    (`video.timeline`), because that is where the same record is re-opened for
 *    deeper analysis; this module is only the caller (lib/server/ml-job.ts);
 *  - the scene-cut scan runs through `video.scenes`, which measures cut
 *    timestamps out of a real decode instead of dividing a frame index by a
 *    nominal fps.
 *
 * Honest-outcome rules enforced here:
 *  - no capability route (Rust backend not enabled) => null, and the index is
 *    built exactly as before: "no baseline" is a configuration fact, not a
 *    silently-degraded success;
 *  - every failure mode returns null or a typed sceneScan state, never a
 *    fabricated identity, duration, stream list or coverage claim;
 *  - a scene cut carries NO text, so its observation text stays empty: an
 *    interval is temporal evidence, not a search clue, and putting "scene 1
 *    12.3s-20.0s" into a web_search argument would be noise dressed as proof.
 *    Real textual clues (OCR/subtitle/speech observations) are what reach the
 *    search arguments, through media-hints.ts;
 *  - a truncated scan says so (coverage.skipped) instead of implying the rest
 *    of the video was inspected.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { mlJob, type MlJobEnvelope, type MlJobOptions } from "../ml-job";
import type { TimelineCoverage, TimelineStream, TimelineSummary } from "./types";

/** `ffmpeg -i` prints the whole container description; 64 KiB covers any real file. */
const PROBE_TEXT_CAP = 64 * 1024;
/** Hashing a multi-GB file during an upload request is not "cheap": the identity
 *  then says which cheap substitute was used instead of pretending to be a digest. */
const HASH_SKIP_BYTES = 8 * 1024 * 1024 * 1024;

/** Dir holding the durable timeline record, relative to the attachment index dir. */
export const TIMELINE_RECORD_DIRNAME = "timeline";

/** Bounded model-visible surface: a cut list can run into the thousands. */
export const TIMELINE_MAX_OBSERVATIONS = 200;
export const TIMELINE_MAX_SPANS = 32;
/** Threshold of the ffmpeg scene detector. Bounded scan wall-clock, in seconds. */
export const TIMELINE_CUT_THRESHOLD = 0.35;
export const TIMELINE_SCAN_TIMEOUT_SEC = 45;
export const TIMELINE_MAX_WINDOWS = 12;
/** Job deadlines: the backend enforces its own deadline and answers typed, so the
 *  client bound is only a ceiling on top of it (ml-job.ts grace law applies). */
export const TIMELINE_INIT_DEADLINE_MS = 30_000;
export const TIMELINE_SCENES_DEADLINE_MS = 90_000;

/* --------------------------------------------------------------------------
 * Reading the container report
 * ------------------------------------------------------------------------ */

export interface MediaProbeInfo {
  durationSec: number;
  streams: TimelineStream[];
  hasAudioTrack: boolean;
  subtitleTracks: string[];
  rotationDeg: number;
  /** Keyed "<type>:<streamIndex>"; only offsets the probe actually reported. */
  streamStartOffsets: Record<string, number>;
}

const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
/**
 * ffmpeg names each track as `Stream #<file>:<stream>[0xid](<tag>): <Type>: ...`.
 * The tag immediately after the id is the language the CONTAINER declared, so a
 * language is only ever reported when the file really declared one.
 */
const STREAM_RE =
  /Stream\s+#(\d+):(\d+)(?:\[[^\]]{1,16}\])?(?:\(([^)]{1,16})\))?\s*:\s*([A-Za-z][A-Za-z0-9]*)/g;
const STREAM_START_RE = /start:?\s+(-?\d+(?:\.\d+)?)/;
const ROTATION_DEG_RE = /rotation of\s+(-?\d+(?:\.\d+)?)\s*degrees/;
const ROTATION_TAG_RE = /\brotate\s*[:=]\s*(-?\d+)\b/;

const KNOWN_STREAM_TYPES = new Set(["video", "audio", "subtitle", "data"]);

/**
 * Parse `ffmpeg -i` stderr (ffmpeg-static ships no ffprobe, and the existing
 * probeInfo already returns this text). Pure, bounded and total: malformed or
 * truncated input yields an empty/zero description rather than a guess.
 */
export function parseMediaProbe(probeText: string): MediaProbeInfo {
  const text = (probeText ?? "").slice(0, PROBE_TEXT_CAP);

  const dur = DURATION_RE.exec(text);
  const durationSec = dur
    ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + parseFloat(dur[3])
    : 0;

  interface Head {
    index: number;
    end: number;
    fileIndex: number;
    streamIndex: number;
    tag: string;
    type: string;
  }
  const heads: Head[] = [];
  // A fresh regex object per call: a module-level /g carries lastIndex across calls.
  const re = new RegExp(STREAM_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    heads.push({
      index: m.index,
      end: re.lastIndex,
      fileIndex: Number(m[1]),
      streamIndex: Number(m[2]),
      tag: (m[3] ?? "").trim(),
      type: (m[4] ?? "").toLowerCase(),
    });
  }

  const streams: TimelineStream[] = [];
  const subtitleTracks: string[] = [];
  const streamStartOffsets: Record<string, number> = {};
  heads.forEach((h, i) => {
    // The stream's own text ends where the NEXT stream declaration begins, so a
    // per-stream number can never be read off a neighbouring track's line.
    const tailEnd = i + 1 < heads.length ? heads[i + 1].index : Math.min(text.length, h.end + 4000);
    const tail = text.slice(h.end, tailEnd);

    const language = /^[a-z]{3}$/i.test(h.tag) ? h.tag.toLowerCase() : "";
    const type = KNOWN_STREAM_TYPES.has(h.type) ? h.type : "other";
    let startSec: number | null = null;
    const startMatch = STREAM_START_RE.exec(tail);
    if (startMatch) {
      const value = Number(startMatch[1]);
      if (Number.isFinite(value)) {
        startSec = value;
        streamStartOffsets[`${type}:${h.streamIndex}`] = value;
      }
    }
    streams.push({ fileIndex: h.fileIndex, streamIndex: h.streamIndex, type, language, startSec });
    if (type === "subtitle") {
      subtitleTracks.push(language || `stream ${h.fileIndex}:${h.streamIndex}`);
    }
  });

  let rotationDeg = 0;
  const rot = ROTATION_DEG_RE.exec(text) ?? ROTATION_TAG_RE.exec(text);
  if (rot) {
    const value = Number(rot[1]);
    if (Number.isFinite(value)) rotationDeg = value;
  }

  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    streams,
    hasAudioTrack: streams.some((s) => s.type === "audio"),
    subtitleTracks,
    rotationDeg,
    streamStartOffsets,
  };
}

/* --------------------------------------------------------------------------
 * Source identity
 * ------------------------------------------------------------------------ */

export interface FileIdentity {
  hash: string;
  algorithm: "sha256" | "size+mtime";
}

function abortError(signal?: AbortSignal): Error {
  const reason = (signal as (AbortSignal & { reason?: unknown }) | undefined)?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("the caller cancelled the media baseline");
  err.name = "AbortError";
  return err;
}

/**
 * Streaming digest: a 4 GB lecture must never be buffered whole to name it.
 * The fallback identity is explicit about being a substitute, so a later deeper
 * pass can tell the difference between "hashed" and "not hashed".
 */
export async function sha256File(
  filePath: string,
  opts: { signal?: AbortSignal } = {},
): Promise<FileIdentity> {
  if (opts.signal?.aborted) throw abortError(opts.signal);
  const stat = fs.statSync(filePath);
  const fallback = `size${stat.size}m${Math.round(stat.mtimeMs)}`;
  if (!stat.isFile() || stat.size > HASH_SKIP_BYTES) return { hash: fallback, algorithm: "size+mtime" };

  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      if (opts.signal?.aborted) {
        stream.destroy();
        reject(abortError(opts.signal));
        return;
      }
      hash.update(chunk as Buffer);
    });
    stream.on("error", (err) => reject(err));
    stream.on("close", () => resolve());
  });
  if (opts.signal?.aborted) throw abortError(opts.signal);
  return { hash: hash.digest("hex"), algorithm: "sha256" };
}

/* --------------------------------------------------------------------------
 * Building the baseline
 * ------------------------------------------------------------------------ */

function envelopePayload(envelope: MlJobEnvelope): Record<string, unknown> | null {
  const result = envelope.result as { payload?: unknown } | undefined;
  const payload = result?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function toSpans(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[number, number]> = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const a = Number(item[0]);
    const b = Number(item[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push([a, b]);
    if (out.length >= TIMELINE_MAX_SPANS) break;
  }
  return out;
}

/** Bounded mirror of the backend Coverage record - the arithmetic stays there. */
function toCoverage(raw: unknown): TimelineCoverage {
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const examined = toSpans(c.examined);
  const total = c.total_source === undefined || c.total_source === null ? null : Number(c.total_source);
  return {
    units: typeof c.units === "string" ? c.units.slice(0, 32) : "seconds",
    totalSec: total !== null && Number.isFinite(total) ? total : null,
    examinedSec:
      Math.round(examined.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0) * 100) / 100,
    complete: c.complete === true,
    examined,
    unexamined: toSpans(c.skipped),
    note: typeof c.note === "string" ? c.note.slice(0, 400) : "",
  };
}

/**
 * Scene cuts -> temporal evidence, nothing more.
 *
 * `text` is deliberately empty: the detector measured WHEN the picture changed,
 * not WHAT it shows. media-hints.ts and the backend's build_hints() both skip an
 * observation with no text, which is exactly the point - the interval is used to
 * choose frames and to state coverage, and it never becomes a search phrase.
 */
export function sceneObservations(
  cuts: number[],
  durationSec: number,
  threshold: number,
): Array<Record<string, unknown>> {
  const sorted = [...new Set(
    cuts
      .map((c) => Number(c))
      .filter((c) => Number.isFinite(c) && c >= 0 && (durationSec <= 0 || c <= durationSec))
      .map((c) => Math.round(c * 1000) / 1000),
  )].sort((a, b) => a - b);

  const starts = sorted.length ? sorted : [0];
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < starts.length && out.length < TIMELINE_MAX_OBSERVATIONS; i++) {
    const start = starts[i];
    const end =
      i + 1 < starts.length
        ? starts[i + 1]
        : durationSec > 0
          ? Math.round(durationSec * 1000) / 1000
          : start;
    if (end < start) continue;
    out.push({
      start,
      end,
      kind: "scene",
      text: "",
      frame_ref: "",
      audio_state: "unknown",
      provider: `ffmpeg:scene-threshold-${threshold}`,
    });
  }
  return out;
}

export interface BuildTimelineInput {
  attId: string;
  /** Absolute path of the stored original (the file the timeline describes). */
  srcPath: string;
  /** `ffmpeg -i` stderr for that file (probeInfo output). */
  probeText: string;
  durationSec: number;
  signal?: AbortSignal;
  /** Test seams: no production caller passes these. */
  detectCuts?: boolean;
  cutThreshold?: number;
  scanTimeoutSec?: number;
  maxWindows?: number;
  runJob?: (
    capability: string,
    payload: Record<string, unknown>,
    opts?: MlJobOptions,
  ) => Promise<MlJobEnvelope | null>;
  scratchRoot?: string;
}

export interface TimelineEvidence {
  /** Staging dir holding `<hash>/timeline.json`; the caller moves it into the index. */
  scratchDir: string;
  observations: Array<Record<string, unknown>>;
  /** The backend's own sentence about what has been examined. */
  coverageReply: string;
  summary: TimelineSummary;
}

/**
 * Build the baseline for one media attachment. NEVER throws: every failure is
 * either null ("no evidence was produced, and nothing was published") or an
 * evidence object whose sceneScan field states what could not be measured.
 */
export async function buildTimeline(input: BuildTimelineInput): Promise<TimelineEvidence | null> {
  const run = input.runJob ?? mlJob;
  const probe = parseMediaProbe(input.probeText);
  const durationSec = input.durationSec > 0 ? input.durationSec : probe.durationSec;
  if (input.signal?.aborted) return null;

  let identity: FileIdentity;
  try {
    identity = await sha256File(input.srcPath, { signal: input.signal });
  } catch {
    // Unreadable original: no baseline, and never an invented identity.
    return null;
  }

  const scratchRoot = input.scratchRoot ?? path.join(process.cwd(), ".data", "tmp", "timelines");
  const scratchDir = path.join(scratchRoot, `${input.attId}-${crypto.randomBytes(4).toString("hex")}`);
  const dropScratch = () => {
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  try {
    fs.mkdirSync(scratchDir, { recursive: true });
  } catch {
    return null;
  }

  const meta = {
    source_id: input.attId,
    source_hash: identity.hash,
    duration: durationSec,
    streams: probe.streams.map((s) => ({
      file: s.fileIndex,
      stream: s.streamIndex,
      type: s.type,
      language: s.language,
      start: s.startSec,
    })),
    rotation_deg: probe.rotationDeg,
    has_audio_track: probe.hasAudioTrack,
    subtitle_tracks: probe.subtitleTracks,
    stream_start_offsets: probe.streamStartOffsets,
  };
  const init = await run(
    "video.timeline",
    { root: scratchDir, op: "init", meta },
    { deadlineMs: TIMELINE_INIT_DEADLINE_MS, signal: input.signal },
  );
  if (!init) return (dropScratch(), null);
  const initPayload = init.error ? null : envelopePayload(init);
  let record = initPayload && initPayload.record && typeof initPayload.record === "object"
    ? (initPayload.record as Record<string, unknown>)
    : null;
  let reply = initPayload && typeof initPayload.reply === "string" ? initPayload.reply : "";
  if (!record) return (dropScratch(), null);

  const sceneScan = { state: "not_attempted", reason: "", scannedSec: 0, truncated: false };
  let observations: Array<Record<string, unknown>> = [];
  if (input.detectCuts !== false && durationSec > 0) {
    if (input.signal?.aborted) return (dropScratch(), null);
    const threshold = input.cutThreshold ?? TIMELINE_CUT_THRESHOLD;
    const videoOffset = Object.entries(probe.streamStartOffsets)
      .find(([key]) => key.startsWith("video:"))?.[1] ?? 0;
    const scenes = await run(
      "video.scenes",
      {
        duration: durationSec,
        source: path.resolve(input.srcPath),
        detect_cuts: true,
        cut_threshold: threshold,
        scan_timeout_s: input.scanTimeoutSec ?? TIMELINE_SCAN_TIMEOUT_SEC,
        max_windows: input.maxWindows ?? TIMELINE_MAX_WINDOWS,
        stream_start_offset: Number.isFinite(videoOffset) ? videoOffset : 0,
      },
      { deadlineMs: TIMELINE_SCENES_DEADLINE_MS, signal: input.signal },
    );
    if (scenes === null) {
      sceneScan.state = "not_configured";
      sceneScan.reason = "this deployment has no capability route";
    } else if (scenes.error) {
      sceneScan.state = "failed";
      sceneScan.reason = `${scenes.error.reason}: ${scenes.error.message}`.slice(0, 240);
    } else {
      const payload = envelopePayload(scenes);
      const scan = payload?.cut_scan && typeof payload.cut_scan === "object"
        ? (payload.cut_scan as Record<string, unknown>)
        : null;
      if (!scan) {
        sceneScan.state = "no_scan";
        sceneScan.reason = "the scenes job returned no cut_scan";
      } else {
        sceneScan.state = scan.ok === true ? "ok" : "failed";
        sceneScan.reason = scan.ok === true ? "" : String(scan.error ?? "the cut scan failed").slice(0, 240);
        sceneScan.scannedSec = Number(scan.scanned_seconds) || 0;
        sceneScan.truncated = scan.truncated === true;
        // A scan that hit its wall-clock bound examined LESS than the whole
        // source, so its last interval may not be drawn out to the end of the
        // file: an interval is a claim about what was inspected.
        const horizonSec = sceneScan.truncated && sceneScan.scannedSec > 0
          ? Math.min(sceneScan.scannedSec, durationSec)
          : durationSec;
        observations = sceneObservations(
          Array.isArray(scan.cuts) ? (scan.cuts as number[]) : [],
          horizonSec,
          Number(scan.threshold) || threshold,
        );
      }
    }
  }

  // Persist the evidence + the measured coverage in the durable record. A scan
  // that found NO cuts still examined its span, and that is worth recording:
  // "static for 300 s" is evidence, while "we never looked" is not. A failed
  // scan claims nothing at all.
  const scanHappened = sceneScan.state === "ok";
  if (scanHappened || observations.length > 0) {
    if (input.signal?.aborted) return (dropScratch(), null);
    const examinedUntil = sceneScan.truncated && sceneScan.scannedSec > 0
      ? Math.min(sceneScan.scannedSec, durationSec)
      : durationSec;
    const coverage = {
      examined: examinedUntil > 0 ? [[0, examinedUntil]] : [],
      // What the scan never read, stated as a span instead of hidden by an
      // empty list: the next, deeper pass starts from here.
      skipped: examinedUntil > 0 && durationSec > examinedUntil
        ? [[Math.round(examinedUntil * 1000) / 1000, Math.round(durationSec * 1000) / 1000]]
        : ([] as number[][]),
      units: "seconds",
      total_source: durationSec > 0 ? durationSec : null,
      complete: false,
      note:
        "scene-cut scan of the video track; transcript and keyframe coverage is " +
        "recorded by the extractor, and a scan that ended early lists what it never read",
    };
    const observe = await run(
      "video.timeline",
      {
        root: scratchDir,
        op: "observe",
        source_hash: identity.hash,
        stage: "scene-cuts",
        observations,
        coverage,
      },
      { deadlineMs: TIMELINE_INIT_DEADLINE_MS, signal: input.signal },
    );
    // An observe failure keeps the baseline record (streams/duration/streams are
    // still true); it never upgrades a real failure into a success.
    const observePayload = observe && !observe.error ? envelopePayload(observe) : null;
    if (observePayload?.record && typeof observePayload.record === "object") {
      record = observePayload.record as Record<string, unknown>;
      if (typeof observePayload.reply === "string") reply = observePayload.reply;
      sceneScan.state = sceneScan.state === "ok" ? "ok_recorded" : sceneScan.state;
    }
  }

  const recordMeta = record.meta && typeof record.meta === "object"
    ? (record.meta as Record<string, unknown>)
    : {};
  const summary: TimelineSummary = {
    sourceHash: identity.hash,
    hashAlgorithm: identity.algorithm,
    durationSec,
    streams: probe.streams,
    rotationDeg: probe.rotationDeg,
    hasAudioTrack: probe.hasAudioTrack,
    subtitleTracks: probe.subtitleTracks,
    streamStartOffsets: probe.streamStartOffsets,
    coverage: toCoverage(recordMeta.coverage),
    capability: "video.timeline",
    jobState: init.state,
    sceneScan,
    recordDir: TIMELINE_RECORD_DIRNAME,
    updatedAt: Date.now(),
  };
  return { scratchDir, observations, coverageReply: reply, summary };
}

/* --------------------------------------------------------------------------
 * Publishing / reading the durable record
 * ------------------------------------------------------------------------ */

/**
 * Move a staged timeline into the published index dir. Called AFTER the index
 * generation switched, because the switch renames the previous attachment dir
 * aside and would otherwise take a pre-existing timeline with it.
 * Returns false (and leaves the staged dir alone) when the move is not possible.
 */
export function attachTimelineDir(attDir: string, scratchDir: string): boolean {
  const target = path.join(attDir, TIMELINE_RECORD_DIRNAME);
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(attDir, { recursive: true });
    fs.renameSync(scratchDir, target);
    return true;
  } catch {
    // A rename fails across volumes (EXDEV), and an index root moved by
    // WEBUI_DATA_DIR is not guaranteed to share a volume with the scratch tree.
    // Staging INSIDE the destination dir keeps the publish itself atomic.
    const staged = `${target}.staged-${crypto.randomBytes(3).toString("hex")}`;
    try {
      copyRecordTree(scratchDir, staged);
      fs.renameSync(staged, target);
      fs.rmSync(scratchDir, { recursive: true, force: true });
      return true;
    } catch {
      try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* best effort */ }
      return false;
    }
  }
}

/** Bounded copy of a small staged record tree (JSON + optional frame refs). */
const RECORD_COPY_MAX_ENTRIES = 4096;
const RECORD_COPY_MAX_DEPTH = 6;

function copyRecordTree(from: string, to: string, depth = 0): void {
  if (depth > RECORD_COPY_MAX_DEPTH) throw new Error("timeline record tree is too deep");
  const entries = fs.readdirSync(from, { withFileTypes: true });
  if (entries.length > RECORD_COPY_MAX_ENTRIES) throw new Error("timeline record tree is too wide");
  fs.mkdirSync(to, { recursive: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error("timeline record must not contain links");
    if (entry.isDirectory()) copyRecordTree(src, dst, depth + 1);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * Where the durable record ACTUALLY is. meta.timeline names a dir; this is the
 * check that turns the pointer into a fact (and back into null after a crash).
 */
export function timelineRecordPath(attDir: string, sourceHash: string): string | null {
  if (!sourceHash) return null;
  const file = path.join(attDir, TIMELINE_RECORD_DIRNAME, sourceHash.slice(0, 32), "timeline.json");
  try {
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** Remove a staged baseline that never got published (failure/cancel path). */
export function discardTimelineScratch(scratchDir: string): void {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
