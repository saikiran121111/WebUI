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
export async function probeInfo(
  src: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const ff = await ffmpegPath();
  try {
    const { stderr } = await execFileP(ff, ["-i", src], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      // I15: NO ffmpeg call may hang forever — a wedged probe used to pin an
      // upload (and its client request) indefinitely. The probe answers in
      // milliseconds even when it fails; 20 s is generous for a locked file.
      timeout: opts.timeoutMs ?? 20_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
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

async function runFFmpeg(
  args: string[],
  opts: { maxBuffer?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const ff = await ffmpegPath();
  const { stdout } = await execFileP(ff, args, {
    encoding: "buffer",
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    // I15: bounded + abortable like every other ffmpeg invocation.
    timeout: opts.timeoutMs ?? 120_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return stdout;
}

// The comma inside min() belongs to the expression, not to the filter chain, so
// it has to be escaped for ffmpeg's filtergraph parser.
// I07: BOTH sides get capped. The old `min(1280,iw):-2` capped only the width,
// so a tall phone screenshot (or a full-frame lecture still) came through at its
// original enormous height — decode, memory, and base64 were all paid in full
// before the model downscaled it anyway. `force_original_aspect_ratio=decrease`
// shrinks only (never upscales small images). NO `force_divisible_by=2`: it
// rounds a 1px (or otherwise odd-and-tiny) image DOWN to 0, and ffmpeg fails
// the whole decode with "Picture size 0x0 is invalid"; PNG output has no
// even-dimension requirement.
const SCALE_FILTER =
  `scale=w=min(iw\\,${MAX_IMAGE_SIDE}):h=min(ih\\,${MAX_IMAGE_SIDE}):force_original_aspect_ratio=decrease,format=rgb24`;

function toDataUrl(png: Buffer): string {
  return "data:image/png;base64," + png.toString("base64");
}

export interface ImageDecode {
  dataUrl: string;
  /**
   * Extra pages/frames beyond the first. For images the `at` value is the
   * 1-based PAGE NUMBER, NOT seconds — do not read it as a timestamp.
   */
  frames?: { dataUrl: string; at: number }[];
  pages: number;
}

/** Multi-page/animated decode cap — a 500-frame GIF is not worth 500 images. */
const MAX_IMAGE_PAGES = 8;

/**
 * Decode an image the browser could not (tif/heic/avif/ico/…) to a PNG data
 * URL. ffmpeg reads whatever the container actually holds and rescales it.
 * Reads from a path on disk — the upload never round-trips through memory.
 *
 * I07: the old `-frames:v 1` threw away EVERY page after the first —
 * multi-page TIFFs (scanned documents!) and animated GIF/APNG reached the
 * model as a single frame with no announcement. Every page now comes back as
 * extra frames (bounded by MAX_IMAGE_PAGES; `pages` reports how many decoded,
 * so hitting the cap is visible rather than silent).
 */
export async function imageToDataUrlFromPath(
  src: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ImageDecode> {
  const base = tmpName("");
  const pattern = base + "_%03d.png";
  const written: string[] = [];
  try {
    await runFFmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", src,
      "-frames:v", String(MAX_IMAGE_PAGES), "-vf", SCALE_FILTER, "-vsync", "vfr", pattern],
      { timeoutMs: 60_000, ...(opts.signal ? { signal: opts.signal } : {}) });
    for (let i = 1; i <= MAX_IMAGE_PAGES; i++) {
      const p = `${base}_${String(i).padStart(3, "0")}.png`;
      if (fs.existsSync(p) && fs.statSync(p).size > 0) written.push(p);
      else break;
    }
    if (!written.length) throw new Error("Could not decode this image");
    const dataUrl = toDataUrl(fs.readFileSync(written[0]));
    const frames = written.slice(1).map((p, i) => ({
      dataUrl: toDataUrl(fs.readFileSync(p)),
      at: i + 2, // page number of this frame (page 1 is `dataUrl`)
    }));
    return { dataUrl, ...(frames.length ? { frames } : {}), pages: written.length };
  } finally {
    try {
      const dir = path.dirname(base);
      const stem = path.basename(base);
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(stem)) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch { /* ignore */ }
  }
}

/** Buffer convenience wrapper (tests, small callers). */
export async function imageToDataUrl(buf: Buffer, ext: string): Promise<ImageDecode> {
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
  opts: { signal?: AbortSignal } = {},
): Promise<{ frames: { dataUrl: string; at: number }[]; durationSec: number }> {
  const out = tmpName(".png");
  try {
    const duration = parseDuration(await probeInfo(src, opts));

    // Clips without a duration header (some mkv/webm) fall back to fixed marks.
    const marks = duration > 0
      ? [duration * 0.2, duration * 0.7].slice(0, VIDEO_FRAMES)
      : [0, 2, 5].slice(0, VIDEO_FRAMES);

    const frames: { dataUrl: string; at: number }[] = [];
    for (const at of marks) {
      if (opts.signal?.aborted) break;
      try {
        await runFFmpeg(["-hide_banner", "-loglevel", "error", "-y",
          "-ss", at.toFixed(3), "-i", src, "-frames:v", "1", "-vf", SCALE_FILTER, out],
          { timeoutMs: 60_000, ...(opts.signal ? { signal: opts.signal } : {}) });
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

/** Default keyframe budget for one video (I17: also the thinning anchor). */
const MAX_KEYFRAMES = 150;

/**
 * Scene-change keyframes for the attachment index: one JPEG per visual cut
 * (slide changes in lectures), written straight into the index's frames dir.
 * If the scene pass is sparse (static webcam lectures), top up with seek
 * samples along the timeline. A hard cap keeps a 6-hour course bounded.
 * Returns frames with their timestamp and file name inside `outDir`.
 *
 * I17: the old cap simply CUT the scene list at 150 and the top-up loop only
 * ran while the frame count was below a small `duration/120` target — a
 * lecture whose cuts all happen in its first minutes produced frames covering
 * ONLY those minutes, and the rest of the timeline was silently unrepresented
 * for every visual follow-up. TIMELINE COVERAGE now beats scene detail: when
 * the scene frames stop short of the end they are evenly thinned (the last
 * one is always kept) to reserve seek slots, the discarded scene files are
 * DELETED so the index never cites an image it does not have, and seek
 * samples fill the uncovered stretch — including a tail anchor near the
 * final seconds so the end of the video is never frame-less.
 */
export async function videoKeyframesFromPath(
  src: string,
  outDir: string,
  opts: { maxFrames?: number; signal?: AbortSignal } = {},
): Promise<{ at: number; name: string }[]> {
  const cap = Math.max(2, opts.maxFrames ?? MAX_KEYFRAMES);
  fs.mkdirSync(outDir, { recursive: true });
  const ff = await ffmpegPath();
  const duration = parseDuration(await probeInfo(src, opts));
  const frames: { at: number; name: string }[] = [];

  // Scene pass: select fires on each cut; showinfo prints pts_time per frame
  // on stderr, which is how we learn WHEN each saved image was taken.
  // Fast-decode chain: -skip_frame nokey decodes ONLY container I-frames, so
  // a 3-6 h 60 fps lecture costs a fraction of a full decode; -hwaccel auto
  // uses the GPU when one is available. Both are tried before the classic
  // full-decode pass, which stays as the last resort for odd containers.
  const frameName = (n: number) => `f_${String(n).padStart(5, "0")}.jpg`;
  let stderr = "";
  if (!opts.signal?.aborted) {
    for (const pre of [
      ["-hwaccel", "auto", "-skip_frame", "nokey"],
      ["-skip_frame", "nokey"],
      [],
    ] as string[][]) {
      try {
        const r = await execFileP(
          ff,
          ["-hide_banner", "-y", ...pre, "-i", src,
            "-vf", `select='gt(scene,0.3)',showinfo,${SCALE_FILTER}`,
            "-vsync", "vfr", "-frames:v", String(cap), "-f", "image2",
            path.join(outDir, "f_%05d.jpg")],
          {
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            // I15: the full-decode fallback on a 6 h video can legitimately
            // run long, but it must never hang forever: 20 min bounds a
            // wedged pass, and an aborted caller kills the process instead.
            timeout: 1_200_000,
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
        );
        stderr = r.stderr;
        break;
      } catch (err: any) {
        if (opts.signal?.aborted) break;
        stderr = String(err?.stderr ?? "");
        // A failed variant may have written partial frames — clear them so the
        // next attempt's f_%05d.jpg numbering never mixes with stale output.
        try {
          for (const f of fs.readdirSync(outDir)) {
            if (/^f_\d+\.jpg$/.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
          }
        } catch { /* ignore */ }
      }
    }
  }
  const times = [...stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
  for (let i = 0; i < times.length; i++) {
    const name = frameName(i + 1);
    if (fs.existsSync(path.join(outDir, name))) frames.push({ at: times[i], name });
  }

  // I17: coverage beats scene detail. If the scene frames stop short of the
  // end of the timeline, thin them evenly — always keeping the LAST one —
  // so the cap's remaining slots can buy coverage of the untouched stretch.
  const coveredUntil = frames.reduce((m, f) => Math.max(m, f.at), 0);
  if (duration > 0 && frames.length && coveredUntil < duration - 90) {
    const seekBudget = Math.min(cap, Math.ceil(duration / 120));
    const keepScenes = Math.max(2, Math.min(frames.length, cap - seekBudget));
    if (keepScenes < frames.length) {
      const step = Math.ceil(frames.length / keepScenes);
      const kept = frames.filter((_, i) => i % step === 0 || i === frames.length - 1);
      for (const f of frames) {
        if (kept.includes(f)) continue;
        try { fs.rmSync(path.join(outDir, f.name), { force: true }); } catch { /* ignore */ }
      }
      // Compact the numbering so seek grabs never collide with kept scene
      // names. New numbers are always ≤ old ones, and the loop runs in
      // ascending order, so a rename target is always free.
      kept.forEach((f, i) => {
        const nn = frameName(i + 1);
        if (f.name !== nn) {
          try { fs.renameSync(path.join(outDir, f.name), path.join(outDir, nn)); } catch { /* ignore */ }
          f.name = nn;
        }
      });
      frames.length = 0;
      frames.push(...kept);
    }
  }

  // Sparse scene detection (lectures barely cut) or thinned coverage: fill
  // toward the END, driven by what is actually covered rather than a count.
  let seq = frames.length;
  const grab = async (t: number): Promise<void> => {
    const name = frameName(seq + 1);
    try {
      await execFileP(ff, ["-hide_banner", "-loglevel", "error", "-y",
        "-ss", t.toFixed(3), "-i", src, "-frames:v", "1", "-vf", SCALE_FILTER,
        path.join(outDir, name)],
        { encoding: "utf8", timeout: 60_000, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (fs.existsSync(path.join(outDir, name)) && fs.statSync(path.join(outDir, name)).size > 0) {
        frames.push({ at: t, name });
        seq++;
      }
    } catch { /* unseekable spot (or cancelled) — skip */ }
  };
  for (let t = 60; t < duration && frames.length < cap; t += 120) {
    if (opts.signal?.aborted) break;
    // I17: the skip radius widens 30 s → 60 s — a scene frame at 150 s makes
    // a seek at 180 s pointless, and the freed slot buys coverage further out.
    if (frames.some(f => Math.abs(f.at - t) < 60)) continue;
    await grab(t);
  }
  // Tail anchor: the end of the timeline is the most-asked-about spot in a
  // lecture ("what was the summary?") — it must never be frame-less.
  if (duration > 0 && frames.length && frames[frames.length - 1].at < duration - 90 && frames.length < cap) {
    await grab(Math.max(0, duration - 30));
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
export async function audioPcmFromPath(
  src: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Float32Array> {
  const out = tmpName(".f32");
  try {
    const ff = await ffmpegPath();
    await execFileP(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
      "-f", "f32le", "-ac", "1", "-ar", "16000", out],
      { timeout: 600_000, ...(opts.signal ? { signal: opts.signal } : {}) });
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

/**
 * I15 (RAM law): decode a media file's audio track to a raw f32le scratch
 * file WITHOUT holding the whole track in RAM. audioPcmFromPath's Float32Array
 * costs 8 bytes per sample: a 3-hour track is ~690 MB of float, on top of the
 * source file itself — enough to sink a consumer laptop while whisper churns.
 * The decode lands on disk; the caller reads 30 s windows with readPcmRange
 * (or the whole thing only when the track is short) and deletes the file.
 * The caller OWNS the returned file — whoever decodes must remove it.
 */
export async function decodeAudioPcmFile(
  src: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ file: string; samples: number }> {
  const out = tmpName(".f32");
  try {
    const ff = await ffmpegPath();
    await execFileP(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
      "-f", "f32le", "-ac", "1", "-ar", "16000", out],
      { timeout: 600_000, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
      throw new Error("Audio decoded to nothing");
    }
    return { file: out, samples: Math.floor(fs.statSync(out).size / 4) };
  } catch (err) {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Read pcm[fromSample..toSample) out of a decodeAudioPcmFile scratch file —
 * a positional pread, so only the requested window is ever in memory.
 */
export function readPcmRange(file: string, fromSample: number, toSample: number): Float32Array {
  const b0 = Math.max(0, Math.floor(fromSample)) * 4;
  const size = fs.statSync(file).size;
  const b1 = Math.min(size, Math.max(b0, Math.floor(toSample) * 4));
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(b1 - b0);
    let off = 0;
    while (off < buf.length) off += fs.readSync(fd, buf, off, buf.length - off, b0 + off);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  } finally {
    fs.closeSync(fd);
  }
}
