import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileP = promisify(execFile);

/** Scratch space for decode/encode jobs — always inside the codebase. */
const TMP_DIR = path.join(process.cwd(), ".data", "tmp");

/** Longest audio we transcribe (whisper on CPU is slow; longer clips get cut). */
export const MAX_AUDIO_SECONDS = 180;
/** Frames sampled out of every video clip. */
const VIDEO_FRAMES = 2;
/** Images/frames are downscaled to this before they reach the model. */
const MAX_IMAGE_SIDE = 1280;

let ffmpegPathPromise: Promise<string> | null = null;

/** Path to the ffmpeg binary shipped inside node_modules (never system-wide). */
export function ffmpegPath(): Promise<string> {
  if (!ffmpegPathPromise) {
    ffmpegPathPromise = (async () => {
      const mod: any = await import("ffmpeg-static");
      const p: string | null = typeof mod === "string" ? mod : mod?.default ?? null;
      if (!p || !fs.existsSync(p)) {
        throw new Error("Bundled ffmpeg binary is missing — run `npm install`");
      }
      return p;
    })().catch(err => {
      ffmpegPathPromise = null;
      throw err;
    });
  }
  return ffmpegPathPromise;
}

function tmpName(ext: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return path.join(TMP_DIR, "m_" + randomBytes(6).toString("hex") + ext);
}

function withTemp<T>(srcExt: string, fn: (src: string) => Promise<T>, extraFiles: string[] = []): Promise<T> {
  return (async () => {
    const src = tmpName(srcExt);
    try {
      return await fn(src);
    } finally {
      for (const f of [src, ...extraFiles]) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
    }
  })();
}

/** `ffmpeg -i src` fails on purpose; its stderr carries the stream info. */
async function probeInfo(src: string): Promise<string> {
  const ff = await ffmpegPath();
  try {
    const { stderr } = await execFileP(ff, ["-i", src], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return stderr;
  } catch (err: any) {
    return String(err?.stderr ?? err?.message ?? "");
  }
}

function parseDuration(stderr: string): number {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
}

async function runFFmpeg(args: string[], opts: { maxBuffer?: number } = {}): Promise<Buffer> {
  const ff = await ffmpegPath();
  const { stdout } = await execFileP(ff, args, {
    encoding: "buffer",
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
  });
  return stdout;
}

// The comma inside min() belongs to the expression, not to the filter chain, so
// it has to be escaped for ffmpeg's filtergraph parser.
const SCALE_FILTER = `scale=min(${MAX_IMAGE_SIDE}\\,iw):-2,format=rgb24`;

function toDataUrl(png: Buffer): string {
  return "data:image/png;base64," + png.toString("base64");
}

/**
 * Decode an image the browser could not (tif/heic/avif/ico/…) to a PNG data
 * URL. ffmpeg reads whatever the container actually holds and rescales it.
 */
export async function imageToDataUrl(buf: Buffer, ext: string): Promise<string> {
  const out = tmpName(".png");
  return withTemp("." + ext, async src => {
    fs.writeFileSync(src, buf);
    await runFFmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", src,
      "-frames:v", "1", "-vf", SCALE_FILTER, out]);
    return toDataUrl(fs.readFileSync(out));
  }, [out]);
}

/**
 * Sample still frames out of a video clip. Frames are taken at 20% and 70% of
 * the duration (title cards at the start, content in the middle).
 */
export async function videoFrames(
  buf: Buffer,
  ext: string,
): Promise<{ frames: { dataUrl: string; at: number }[]; durationSec: number }> {
  const out = tmpName(".png");
  return withTemp("." + ext, async src => {
    fs.writeFileSync(src, buf);
    const duration = parseDuration(await probeInfo(src));

    // Clips without a duration header (some mkv/webm) fall back to fixed marks.
    const marks = duration > 0
      ? [duration * 0.2, duration * 0.7].slice(0, VIDEO_FRAMES)
      : [0, 2, 5].slice(0, VIDEO_FRAMES);

    const frames: { dataUrl: string; at: number }[] = [];
    for (const at of marks) {
      try {
        await runFFmpeg(["-hide_banner", "-loglevel", "error", "-y",
          "-ss", at.toFixed(3), "-i", src, "-frames:v", "1", "-vf", SCALE_FILTER, out]);
        if (fs.existsSync(out) && fs.statSync(out).size > 0) {
          frames.push({ dataUrl: toDataUrl(fs.readFileSync(out)), at: Math.round(at * 100) / 100 });
          fs.rmSync(out, { force: true });
        }
      } catch { /* frame not seekable — skip it */ }
    }
    if (!frames.length) throw new Error("Could not read any frames from the video");
    return { frames, durationSec: duration };
  }, [out]);
}

/**
 * Decode audio to raw 32-bit float PCM (16 kHz mono) — the exact layout the
 * whisper pipeline expects.
 */
export async function audioPcm(buf: Buffer, ext: string): Promise<Float32Array> {
  return withTemp("." + ext, async src => {
    fs.writeFileSync(src, buf);
    const raw = await runFFmpeg(
      ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
        "-t", String(MAX_AUDIO_SECONDS),
        "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    if (!raw.length) throw new Error("Audio decoded to nothing");
    // The Buffer may reuse a pooled ArrayBuffer — copy into its own one.
    const pcm = new Float32Array(raw.length / 4);
    for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readFloatLE(i * 4);
    return pcm;
  });
}
