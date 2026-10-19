import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileP = promisify(execFile);

/** Scratch space for decode/encode jobs — always inside the codebase. */
const TMP_DIR = path.join(process.cwd(), ".data", "tmp");

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
 * Reads from a path on disk — the upload never round-trips through memory.
 */
export async function imageToDataUrlFromPath(src: string): Promise<string> {
  const out = tmpName(".png");
  try {
    await runFFmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", src,
      "-frames:v", "1", "-vf", SCALE_FILTER, out]);
    return toDataUrl(fs.readFileSync(out));
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  }
}

/** Buffer convenience wrapper (tests, small callers). */
export async function imageToDataUrl(buf: Buffer, ext: string): Promise<string> {
  return withTemp("." + ext, async src => {
    fs.writeFileSync(src, buf);
    return imageToDataUrlFromPath(src);
  });
}

/**
 * Sample still frames out of a video clip. Frames are taken at 20% and 70% of
 * the duration (title cards at the start, content in the middle).
 * Reads the clip straight from its path on disk — a multi-GB video never
 * sits in memory; ffmpeg just seeks inside the file.
 */
export async function videoFramesFromPath(
  src: string,
): Promise<{ frames: { dataUrl: string; at: number }[]; durationSec: number }> {
  const out = tmpName(".png");
  try {
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
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  }
}

/** Buffer convenience wrapper (tests, small callers). */
export async function videoFrames(
  buf: Buffer,
  ext: string,
): Promise<{ frames: { dataUrl: string; at: number }[]; durationSec: number }> {
  return withTemp("." + ext, async src => {
    fs.writeFileSync(src, buf);
    return videoFramesFromPath(src);
  });
}

/**
 * Scene-change keyframes for the attachment index: one JPEG per visual cut
 * (slide changes in lectures), written straight into the index's frames dir.
 * If the scene pass is sparse (static webcam lectures), top up with a seek
 * sample every 120 s. Hard cap 150 frames so a 6-hour course stays bounded.
 * Returns frames with their timestamp and file name inside `outDir`.
 */
export async function videoKeyframesFromPath(
  src: string,
  outDir: string,
): Promise<{ at: number; name: string }[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const ff = await ffmpegPath();
  const duration = parseDuration(await probeInfo(src));
  const frames: { at: number; name: string }[] = [];

  // Scene pass: select fires on each cut; showinfo prints pts_time per frame
  // on stderr, which is how we learn WHEN each saved image was taken.
  const pattern = path.join(outDir, "f_%05d.jpg");
  let stderr = "";
  try {
    const r = await execFileP(
      ff,
      ["-hide_banner", "-y", "-i", src,
        "-vf", `select='gt(scene,0.3)',showinfo,${SCALE_FILTER}`,
        "-vsync", "vfr", "-frames:v", "150", "-f", "image2", pattern],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    stderr = r.stderr;
  } catch (err: any) {
    stderr = String(err?.stderr ?? "");
  }
  const times = [...stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
  for (let i = 0; i < times.length; i++) {
    const name = `f_${String(i + 1).padStart(5, "0")}.jpg`;
    if (fs.existsSync(path.join(outDir, name))) frames.push({ at: times[i], name });
  }

  // Sparse scene detection (lectures barely cut): fill with fixed-interval seeks.
  const target = Math.min(150, Math.max(2, Math.ceil(duration / 120)));
  let seq = frames.length;
  for (let t = 60; frames.length < target && t < duration; t += 120) {
    if (frames.some(f => Math.abs(f.at - t) < 30)) continue;
    const name = `f_${String(seq + 1).padStart(5, "0")}.jpg`;
    try {
      await execFileP(ff, ["-hide_banner", "-loglevel", "error", "-y",
        "-ss", t.toFixed(3), "-i", src, "-frames:v", "1", "-vf", SCALE_FILTER,
        path.join(outDir, name)], { encoding: "utf8" });
      if (fs.existsSync(path.join(outDir, name)) && fs.statSync(path.join(outDir, name)).size > 0) {
        frames.push({ at: t, name });
        seq++;
      }
    } catch { /* unseekable spot — skip */ }
  }
  return frames;
}

/**
 * Decode audio to raw 32-bit float PCM (16 kHz mono) — the exact layout the
 * whisper pipeline expects. Reads from a path on disk and decodes the WHOLE
 * track (no duration cap): ffmpeg writes the PCM to a scratch file instead of
 * piping it through a RAM buffer, so hour-long recordings cost disk, not a
 * maxBuffer ceiling. The file is then mapped into a Float32Array with a
 * zero-copy view (f32le on disk == native little-endian float32).
 * Whisper itself processes the PCM in 30 s chunks, so transcription time
 * scales with the recording's length — long audio just takes longer.
 */
export async function audioPcmFromPath(src: string): Promise<Float32Array> {
  const out = tmpName(".f32");
  try {
    const ff = await ffmpegPath();
    await execFileP(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
      "-f", "f32le", "-ac", "1", "-ar", "16000", out]);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
      throw new Error("Audio decoded to nothing");
    }
    const raw = fs.readFileSync(out);
    return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  }
}

/** Buffer convenience wrapper (tests, small callers). */
export async function audioPcm(buf: Buffer, ext: string): Promise<Float32Array> {
  return withTemp("." + ext, async src => {
    fs.writeFileSync(src, buf);
    return audioPcmFromPath(src);
  });
}
