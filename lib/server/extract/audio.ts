import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childLogger } from "../logger";
import { llmApiUrl } from "../settings";
import { readPcmRange } from "./ffmpeg";

const execFileP = promisify(execFile);
const log = childLogger("extract/audio");

/**
 * Whisper speech-to-text. The model and its weights live under `.data/models`
 * inside this codebase — nothing is installed or cached outside the project.
 *
 * Three-stage VRAM lifecycle:
 *   Stage 1 — >= 1500 MB free VRAM: whisper runs on the GPU (cuda/fp16) with
 *             batched 30 s chunks.
 *   Stage 2 — GPU present but full (the local LLM holds it): ask the LLM to
 *             unload (LLM_UNLOAD_URL), re-probe, and use the GPU if it freed
 *             up. The LLM is ALWAYS restored afterwards (LLM_RELOAD_URL, or a
 *             1-token warmup on LLM_API_URL) — in a finally block, so a crash
 *             mid-transcription can't leave the chat backend out of VRAM.
 *   Stage 3 — no NVIDIA GPU, VRAM still tight, or ANY cuda/dtype failure:
 *             clean fallback to the CPU pipeline. Transcription never
 *             crashes on a machine without GPU support.
 * The GPU pipeline is disposed after every job — whisper never hogs VRAM
 * while you chat. Pure-silence 30 s windows are skipped via a fast RMS check,
 * which speeds up long recordings AND starves whisper's habit of inventing
 * text over silence. Segment timestamps are normalized onto one continuous
 * master timeline, so a 3 h recording never shows per-chunk 0..30 s resets.
 */
const MODEL_ID = process.env.WHISPER_MODEL ?? "Xenova/whisper-base.en";
const VRAM_FLOOR_MB = Number(process.env.WHISPER_VRAM_FLOOR_MB ?? 1500);
const SILENCE_RMS = Number(process.env.WHISPER_SILENCE_RMS ?? 0.004);
const SR = 16000;
const LLM_UNLOAD_URL = process.env.LLM_UNLOAD_URL ?? "";
const LLM_RELOAD_URL = process.env.LLM_RELOAD_URL ?? "";

let cpuAsrPromise: Promise<any> | null = null;
// One CUDA failure is enough for the whole process — don't re-pay the load
// cost on every upload when this machine's ONNX runtime has no CUDA provider.
let cudaBroken = false;

async function loadAsr(device?: "cuda" | "cpu", dtype?: "fp16" | "q8"): Promise<any> {
  const { pipeline, env } = await import("@huggingface/transformers");
  const cacheDir = path.join(process.cwd(), ".data", "models");
  fs.mkdirSync(cacheDir, { recursive: true });
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.cacheDir = cacheDir;
  // I12: chunk_length_s/stride_length_s must NEVER be passed here.
  // transformers 4.3.1 destructures them off the pipeline options without
  // wiring them into the ASR task, so a long recording silently came back as
  // its first 30 s only (a 61 s clip yielded ~30 s of text). Chunking belongs
  // on the per-CALL options, where the task honors them — see ASR_CHUNK_OPTS.
  return pipeline("automatic-speech-recognition", MODEL_ID, {
    ...(device ? { device } : {}),
    ...(dtype ? { dtype } : {}),
  } as any);
}

function getAsrCpu(): Promise<any> {
  if (!cpuAsrPromise) {
    cpuAsrPromise = loadAsr("cpu", "q8").catch(err => {
      cpuAsrPromise = null; // let a later request retry the download
      throw err;
    });
  }
  return cpuAsrPromise;
}

/** Free VRAM across NVIDIA GPUs (MB), or null when there is no NVIDIA GPU. */
export async function getFreeVramMb(): Promise<number | null> {
  try {
    const { stdout } = await execFileP(
      "nvidia-smi",
      ["--query-gpu=memory.free", "--format=csv,noheader,nounits"],
      { timeout: 2000, encoding: "utf8" },
    );
    const vals = stdout.split("\n").map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    return vals.length ? Math.max(...vals) : null;
  } catch {
    return null; // no nvidia-smi, no NVIDIA GPU, or the probe timed out
  }
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Ask the local LLM server to drop its weights from VRAM (optional hook). */
async function tryLlmUnload(): Promise<boolean> {
  return LLM_UNLOAD_URL ? postJson(LLM_UNLOAD_URL, {}, 10_000) : false;
}

/** Bring the LLM back: explicit reload hook, else a 1-token warmup request. */
async function tryLlmReload(): Promise<void> {
  if (LLM_RELOAD_URL) {
    await postJson(LLM_RELOAD_URL, {}, 120_000);
    return;
  }
  await postJson(
    llmApiUrl(),
    { model: "default", messages: [{ role: "user", content: "x" }], max_tokens: 1, stream: false },
    120_000,
  );
}

export interface AsrStageOpts {
  /** VRAM probe seam (tests inject deterministic values). */
  probe?: () => Promise<number | null>;
  /** LLM-unload hook seam. */
  unload?: () => Promise<boolean>;
  /** LLM-reload hook seam — always invoked when unload was attempted. */
  reload?: () => Promise<void>;
  /** I15: cancelling an upload must not leave whisper grinding through it. */
  signal?: AbortSignal;
}

export interface AsrSegment {
  text: string;
  start: number;
  end: number | null;
}

/** RMS energy of pcm[from..to) — the fast silence probe. */
export function rmsOf(pcm: Float32Array, from: number, to: number): number {
  let sum = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) {
    const v = pcm[i];
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

export interface WindowPlan {
  from: number; // sample index
  to: number;
  silent: boolean;
}

/** 30 s windows with an RMS silence flag (the tail window may be shorter). */
export function planWindows(
  pcm: Float32Array,
  winSec = 30,
  threshold = SILENCE_RMS,
): WindowPlan[] {
  const win = winSec * SR;
  const out: WindowPlan[] = [];
  for (let from = 0; from < pcm.length; from += win) {
    const to = Math.min(pcm.length, from + win);
    out.push({ from, to, silent: rmsOf(pcm, from, to) < threshold });
  }
  return out;
}

/** Shift window-local segments onto the recording's master timeline. */
export function offsetSegments(segs: AsrSegment[], offsetSec: number): AsrSegment[] {
  if (!offsetSec) return segs;
  return segs.map(s => ({
    ...s,
    start: s.start + offsetSec,
    end: s.end === null ? null : s.end + offsetSec,
  }));
}

/**
 * Guard against per-chunk timestamp resets: some ASR paths report every 30 s
 * chunk as 0..30 again instead of accumulating. A legitimate 5 s stride
 * overlap never starts more than ~6 s below the running end; a reset restarts
 * far below it, so the whole segment gets shifted up to the running end.
 * This keeps a 3 h recording on one continuous 0..10800 s timeline.
 */
export function normalizeSegmentTimeline(segs: AsrSegment[]): AsrSegment[] {
  let runningEnd = 0;
  const out: AsrSegment[] = [];
  for (const s of segs) {
    const shift = s.start < runningEnd - 6 ? runningEnd : 0;
    const fixed: AsrSegment = {
      ...s,
      start: s.start + shift,
      end: s.end === null ? null : s.end + shift,
    };
    runningEnd = Math.max(runningEnd, fixed.end ?? fixed.start);
    out.push(fixed);
  }
  return out;
}

/**
 * Whisper's 5 s stride makes chunked decodes say the overlap TWICE, and
 * window-per-window decoding repeats it at every seam. Drop a segment when it
 * (near-)exactly repeats the previous one INSIDE the previous one's time
 * range, keeping the longer text when one contains the other. Genuine repeats
 * (a chorus, a slide title read minutes apart) never overlap the previous
 * segment's range, so real content is never dropped.
 */
export function dedupeSeamSegments(segs: AsrSegment[]): AsrSegment[] {
  const out: AsrSegment[] = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && p.text && s.text && s.start < (p.end ?? p.start) - 2) {
      if (s.text === p.text || p.text.includes(s.text)) continue;
      if (s.text.includes(p.text)) { out[out.length - 1] = { ...s }; continue; }
    }
    out.push(s);
  }
  return out;
}

function toSegments(out: any): AsrSegment[] {
  return Array.isArray(out?.chunks)
    ? out.chunks
        .map((c: any) => ({
          text: String(c?.text ?? "").trim(),
          start: Number(c?.timestamp?.[0] ?? 0),
          end: c?.timestamp?.[1] ?? null,
        }))
        .filter((s: AsrSegment) => s.text)
    : [];
}

/**
 * I12: the REAL chunking knobs for transformers 4.3.1 — they must ride on
 * every pipeline CALL, where the ASR task actually honors them (the pipeline
 * LOAD silently drops them). Harmless for inputs under one 30 s window.
 */
const ASR_CHUNK_OPTS = { chunk_length_s: 30, stride_length_s: 5 } as const;

async function asrOnce(
  asr: any,
  pcm: Float32Array,
  extra: Record<string, unknown>,
): Promise<{ text: string; segments: AsrSegment[] }> {
  const out = await asr(pcm, { return_timestamps: true, ...extra, ...ASR_CHUNK_OPTS });
  return {
    text: String(typeof out === "string" ? out : out?.text ?? "").trim(),
    segments: dedupeSeamSegments(normalizeSegmentTimeline(toSegments(out))),
  };
}

/**
 * Silence-aware transcription. Short clips go through in one call. Long ones
 * are windowed: when pure-silence windows exist in meaningful number (>= 20%)
 * each live window is decoded separately and shifted onto the master
 * timeline; otherwise a single pipeline call handles the whole track (its own
 * 5 s stride keeps words off the chunk seams).
 */
async function transcribeWith(
  asr: any,
  pcm: Float32Array,
  extra: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ text: string; segments: AsrSegment[] }> {
  if (pcm.length <= 30 * SR) return asrOnce(asr, pcm, extra);
  const plan = planWindows(pcm);
  const silent = plan.filter(w => w.silent).length;
  if (!silent || silent < plan.length * 0.2) return asrOnce(asr, pcm, extra);

  const texts: string[] = [];
  const segments: AsrSegment[] = [];
  for (const w of plan) {
    if (signal?.aborted) throw new Error("Transcription cancelled");
    if (w.silent) continue;
    const r = await asrOnce(asr, pcm.subarray(w.from, w.to), extra);
    if (r.text) texts.push(r.text);
    segments.push(...offsetSegments(r.segments, w.from / SR));
  }
  return { text: texts.join(" ").replace(/\s+/g, " ").trim(), segments };
}

/**
 * I13: the three-stage VRAM lifecycle (see the header comment) wrapped around
 * one decode task. EVERY probe/unload/reload is guarded: the stage decision
 * used to sit OUTSIDE the try block, so a throwing nvidia-smi probe or a hung
 * LLM-unload hook crashed the whole upload with no CPU fallback — and left the
 * LLM unloaded. Now any stage-machinery failure still answers from the CPU
 * pipeline, and the LLM always comes back when we asked it to step aside.
 */
async function withAsrStage<R>(
  opts: AsrStageOpts,
  task: (asr: any, extra: Record<string, unknown>) => Promise<R>,
): Promise<R> {
  const probe = opts.probe ?? getFreeVramMb;
  const unload = opts.unload ?? tryLlmUnload;
  const reload = opts.reload ?? tryLlmReload;

  let useCuda = false;
  let unloaded = false;
  let gpuAsr: any = null;
  try {
    if (!cudaBroken) {
      let free: number | null;
      try { free = await probe(); } catch { free = null; }
      if (free !== null) {
        if (free >= VRAM_FLOOR_MB) {
          useCuda = true; // stage 1
        } else {
          // stage 2: make room, then re-probe
          try { unloaded = await unload(); } catch { unloaded = true; }
          const re = unloaded ? await probe().catch(() => null) : null;
          if ((re ?? free) >= VRAM_FLOOR_MB) useCuda = true;
        }
      }
    }

    if (useCuda) {
      try {
        gpuAsr = await loadAsr("cuda", "fp16");
        return await task(gpuAsr, { batch_size: 8 });
      } catch (err: unknown) {
        cudaBroken = true;
        log.warn({ err: (err as Error)?.message }, "GPU whisper unavailable — falling back to CPU");
      }
    }
    // Stage 3: CPU — works on every machine, transcription never crashes.
    const asr = await getAsrCpu();
    return await task(asr, {});
  } finally {
    // Whisper must never hold VRAM once the job is done, and the LLM always
    // comes back if we asked it to step aside — even on a failed attempt.
    if (gpuAsr) {
      try { await gpuAsr.dispose?.(); } catch { /* already gone */ }
    }
    if (unloaded) {
      try {
        await reload();
      } catch (err: unknown) {
        log.warn({ err: (err as Error)?.message }, "LLM reload hook failed — chat may need to warm the model back up");
      }
    }
  }
}

/**
 * Transcribe with per-chunk timestamps (the attachment index needs them to
 * cite [HH:MM:SS] positions). Runs the three-stage VRAM lifecycle around the
 * actual decode. Never throws for GPU reasons — stage 3 always answers.
 */
export async function transcribePcmSegments(
  pcm: Float32Array,
  opts: AsrStageOpts = {},
): Promise<{ text: string; segments: AsrSegment[] }> {
  return withAsrStage(opts, (asr, extra) => transcribeWith(asr, pcm, extra, opts.signal));
}

/**
 * I15: file-based decode for long media. Reads one 30 s window at a time from
 * the decoded PCM file instead of holding the whole recording in RAM (3 h of
 * 16 kHz float PCM ≈ 1.15 GB). The CALLER owns pcmFile and must delete it.
 * RMS-silent windows are skipped without padding (starving whisper's habit of
 * inventing text over silence); window-local segments ride onto the master
 * timeline, and seam duplicates are collapsed by dedupeSeamSegments.
 */
export async function transcribePcmFile(
  pcmFile: string,
  samples: number,
  opts: AsrStageOpts = {},
): Promise<{ text: string; segments: AsrSegment[] }> {
  return withAsrStage(opts, async (asr, extra) => {
    const win = 30 * SR;
    const segments: AsrSegment[] = [];
    for (let from = 0; from < samples; from += win) {
      if (opts.signal?.aborted) throw new Error("Transcription cancelled");
      const to = Math.min(samples, from + win);
      const core = readPcmRange(pcmFile, from, to);
      if (rmsOf(core, 0, core.length) < SILENCE_RMS) continue;
      const r = await asrOnce(asr, core, extra);
      segments.push(...offsetSegments(r.segments, from / SR));
    }
    const merged = dedupeSeamSegments(normalizeSegmentTimeline(segments));
    return {
      text: merged.map(s => s.text).join(" ").replace(/\s+/g, " ").trim(),
      segments: merged,
    };
  });
}

/** The checkpoint actually in use (visible to users, not guessed). */
export function asrModelLabel(): string {
  return MODEL_ID;
}

/**
 * I14: the default whisper checkpoint is English-only (".en"). Speech in other
 * languages comes back missing or wrong, and a Hindi recording used to look
 * like "no speech" with no hint why. This note rides on transcripts (and on
 * the no-speech error) so the limitation is honest instead of silent. Empty
 * string for multilingual checkpoints, where the caveat doesn't apply.
 */
export function asrCapabilityNote(): string {
  if (!/\.en\b/.test(MODEL_ID)) return "";
  return `[transcribed with the English-only speech model "${MODEL_ID}" — speech in other languages may be missing or wrong; set WHISPER_MODEL to a multilingual checkpoint (e.g. "Xenova/whisper-base") to change this]`;
}

/** Transcribe 16 kHz mono float PCM to text. */
export async function transcribePcm(pcm: Float32Array): Promise<string> {
  const asr = await getAsrCpu();
  // I12: the chunk knobs ride on the CALL (the pipeline load silently drops
  // them) — a bare call returned only the first 30 s of a long recording.
  const out = await asr(pcm, { ...ASR_CHUNK_OPTS });
  const text = typeof out === "string" ? out : out?.text ?? "";
  return String(text).trim();
}
