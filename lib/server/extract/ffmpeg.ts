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
   * 1-based PAGE NUMBER, NOT seconds — do not read it as a timestamp. When the
   * cap bites, `at` values are spread (F67: the LAST page is always kept).
   */
  frames?: { dataUrl: string; at: number }[];
  /** TRUE page/frame count of the file when the decoder can declare it. */
  pages: number;
  /**
   * F68: pixel dimensions of the PRIMARY (first) image as the file declares
   * them — the container/decoded source, NEVER the downscaled delivery raster
   * (a 1080×4000 portrait ships ≤1280 but is still 1080×4000) and never a
   * thumbnail. The answer path quotes these verbatim so "what are the pixel
   * dimensions?" is a fact, not a vision estimate (fr-I4 said 1250×612 of a
   * 1280×720 HEIC).
   */
  width?: number;
  height?: number;
}

/** Multi-page/animated decode cap — a 500-frame GIF is not worth 500 images. */
const MAX_IMAGE_PAGES = 8;

/**
 * F67: which page indices the cap keeps. Taking the FIRST `cap` pages hid the
 * end of every long animation (the live fr-I3 GIF has 24 frames — the last
 * frame's fact was undeliverable). An evenly spread subset ALWAYS includes the
 * first AND the last page, and every kept page carries its true 1-based
 * position, so "page N" / "the last frame" stay addressable.
 */
function pagePicks(n: number, cap: number): number[] {
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const idx = new Set<number>([0, n - 1]);
  for (let k = 1; k < cap - 1; k++) idx.add(Math.round((k * (n - 1)) / (cap - 1)));
  return [...idx].sort((a, b) => a - b);
}

/**
 * libvips (sharp) page decode — the F78-B primary image decoder.
 *
 * Measured against the audit fixtures (2026-11-21): ffmpeg's gif demuxer skips
 * disposal compositing (every page came back with a blank centre), its webp
 * demuxer cannot open animated WebP at all ("image data not found"), and its
 * tiff demuxer reads ONLY page 1 of a multi-page scan. libvips decodes all
 * three with correct per-frame/page pixels, caps, page ids and an honest page
 * count. Returns null when libvips cannot read the container at all (ico, …)
 * or when page 0's pixels fail (HEVC-in-HEIF without libde265) — the caller
 * falls through to the wasm HEIF decoder, then ffmpeg.
 */
async function decodePagesWithSharp(
  src: string,
  maxPages: number,
  signal?: AbortSignal,
): Promise<{ pages: Buffer[]; idxs: number[]; declared: number; width?: number; height?: number } | null> {
  let sharp: any;
  try {
    const mod: any = await import("sharp");
    sharp = mod.default ?? mod;
  } catch {
    return null; // native binding absent — ffmpeg stays the decoder
  }
  try {
    const meta = await sharp(src).metadata();
    const declared = Math.max(1, meta.pages ?? 1);
    const pages: Buffer[] = [];
    const idxs: number[] = [];
    for (const i of pagePicks(declared, maxPages)) {
      if (signal?.aborted) break;
      try {
        const png = await sharp(src, { page: i })
          .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .png()
          .toBuffer();
        pages.push(png);
        idxs.push(i);
      } catch {
        break; // page N undecodable — keep what came before it
      }
    }
    return pages.length
      ? { pages, idxs, declared, width: meta.width, height: meta.height }
      : null;
  } catch {
    return null; // container not readable by libvips
  }
}

/**
 * HEVC-in-HEIF (real phone HEIC/HEIF): the vendored libheif has no libde265
 * plugin, so libvips reads the container's metadata but not the pixels. The
 * wasm libheif build (heic-decode) ships the HEVC decoder and decodes every
 * image in the container. ABGR planes are rasterised to PNG through sharp.
 */
async function decodePagesWithHeic(
  src: string,
  maxPages: number,
): Promise<{ pages: Buffer[]; idxs: number[]; declared: number; width?: number; height?: number } | null> {
  let decode: any;
  try {
    const mod: any = await import("heic-decode");
    decode = mod.default ?? mod;
  } catch {
    return null;
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(src);
  } catch {
    return null;
  }
  try {
    // decode.all() returns LAZY handles {width, height, decode()} — the
    // pixels only exist after per-image decode(); the array carries dispose()
    // to free the wasm decoder. Reading .data directly yields undefined.
    const imgs: any = await decode.all({ buffer: buf });
    if (!imgs.length) return null;
    try {
      const sharpMod: any = await import("sharp");
      const s = sharpMod.default ?? sharpMod;
      const pages: Buffer[] = [];
      const idxs: number[] = [];
      let dims: { width: number; height: number } | undefined;
      for (const i of pagePicks(imgs.length, maxPages)) {
        const { width, height, data } = await imgs[i].decode();
        dims ??= { width, height }; // F68: the primary image's decoded raster
        pages.push(
          await s(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
            raw: { width, height, channels: 4 },
          })
            .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" })
            .png()
            .toBuffer(),
        );
        idxs.push(i);
      }
      return { pages, idxs, declared: imgs.length, ...dims };
    } finally {
      try { imgs.dispose?.(); } catch { /* wasm free is best-effort */ }
    }
  } catch {
    return null; // not a HEIF container, or the wasm decoder refused it
  }
}

function pagesToDecode(
  pages: Buffer[],
  idxs: number[],
  declared: number,
  dims?: { width?: number; height?: number },
): ImageDecode {
  const [first, ...rest] = pages;
  // `at` is the page's TRUE 1-based position — spread subsets stay addressable.
  const frames = rest.map((p, i) => ({ dataUrl: toDataUrl(p), at: idxs[i + 1] + 1 }));
  return {
    dataUrl: toDataUrl(first),
    ...(frames.length ? { frames } : {}),
    pages: declared,
    ...(dims?.width && dims?.height ? { width: dims.width, height: dims.height } : {}),
  };
}

/**
 * Decode an image the browser could not (tif/heic/avif/ico/…) to a PNG data
 * URL. Reads from a path on disk — the upload never round-trips through memory.
 *
 * I07: the old `-frames:v 1` threw away EVERY page after the first —
 * multi-page TIFFs (scanned documents!) and animated GIF/APNG reached the
 * model as a single frame with no announcement. Every page now comes back as
 * extra frames (bounded by MAX_IMAGE_PAGES; `pages` reports how many decoded,
 * so hitting the cap is visible rather than silent).
 *
 * F78-B decoder order: libvips first (correct animated-gif/animated-webp/
 * multi-page-tiff pixels), then the wasm HEIF decoder for HEVC pixels, then
 * ffmpeg for containers libvips cannot read (ico, …).
 */
export async function imageToDataUrlFromPath(
  src: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ImageDecode> {
  const sharpPages = await decodePagesWithSharp(src, MAX_IMAGE_PAGES, opts.signal);
  if (sharpPages)
    return pagesToDecode(sharpPages.pages, sharpPages.idxs, sharpPages.declared, sharpPages);
  const heicPages = await decodePagesWithHeic(src, MAX_IMAGE_PAGES);
  if (heicPages)
    return pagesToDecode(heicPages.pages, heicPages.idxs, heicPages.declared, heicPages);
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
    const first = fs.readFileSync(written[0]);
    const dataUrl = toDataUrl(first);
    const frames = written.slice(1).map((p, i) => ({
      dataUrl: toDataUrl(fs.readFileSync(p)),
      at: i + 2, // page number of this frame (page 1 is `dataUrl`)
    }));
    // F68: the ffmpeg fallback targets containers libvips cannot open (ico…)
    // whose SCALE_FILTER never downscales in practice — the decoded primary
    // PNG's own dimensions are the file's. Read them from the raster; omit
    // the claim when they cannot be established (never invent).
    let dims: { width?: number; height?: number } = {};
    try {
      const sharpMod: any = await import("sharp");
      const s = sharpMod.default ?? sharpMod;
      const m = await s(first).metadata();
      if (m.width && m.height) dims = { width: m.width, height: m.height };
    } catch { /* dimensions unknown — omit */ }
    return { dataUrl, ...(frames.length ? { frames } : {}), pages: written.length, ...dims };
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
  // F153 §4: the step ADAPTS to the remaining slot budget. The fixed 120 s
  // step spent the whole cap at duration/120 samples, so any video longer
  // than cap*120 s ran out of slots mid-timeline — at the production cap of
  // 150 that is every lecture past ~5 h — and the tail anchor below, gated
  // on a FREE slot, never fired. A bounded budget buys COVERAGE: spread the
  // free slots across the uncovered stretch (short videos keep the 120 s
  // cadence, so the I17 law and its fixture are untouched).
  const step = Math.max(120, Math.ceil((duration - 60) / Math.max(1, cap - frames.length)));
  for (let t = 60; t < duration && frames.length < cap; t += step) {
    if (opts.signal?.aborted) break;
    // I17: the skip radius widens 30 s → 60 s — a scene frame at 150 s makes
    // a seek at 180 s pointless, and the freed slot buys coverage further out.
    if (frames.some(f => Math.abs(f.at - t) < 60)) continue;
    await grab(t);
  }
  // Tail anchor: the end of the timeline is the most-asked-about spot in a
  // lecture ("what was the summary?") — it must never be frame-less.
  // F153 §4: this is a LAW, not a leftover-slot luxury. When the budget is
  // spent, evict the most redundant interior frame (the one whose neighbours
  // sit closest — its removal loses the least coverage; with no interior
  // frame the old tail frame yields, and the new anchor reaches further)
  // and buy the tail with that slot. The cap itself never grows.
  if (duration > 0 && frames.length && frames[frames.length - 1].at < duration - 90) {
    if (frames.length >= cap) {
      let drop = frames.length - 1;
      if (frames.length >= 3) {
        let best = Infinity;
        for (let i = 1; i < frames.length - 1; i++) {
          const gap = frames[i + 1].at - frames[i - 1].at;
          if (gap < best) { best = gap; drop = i; }
        }
      }
      try { fs.rmSync(path.join(outDir, frames[drop].name), { force: true }); } catch { /* ignore */ }
      frames.splice(drop, 1);
    }
    await grab(Math.max(0, duration - 30));
  }
  return frames;
}

/**
 * Decode audio to raw 32-bit float PCM (16 kHz mono) — the layout ASR engines
 * consume. Reads from a path on disk and decodes the WHOLE track (no duration
 * cap): ffmpeg writes the PCM to a scratch file instead of piping it through a
 * RAM buffer, so hour-long recordings cost disk, not a maxBuffer ceiling. The
 * file is then mapped into a Float32Array with a zero-copy view (f32le on disk
 * == native little-endian float32). F123: the remaining caller is video
 * narration (the short-track path); the removed TypeScript whisper pipeline
 * is gone.
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

// F123 (2026-11-23): the I15 scratch-file decoders (decodeAudioPcmFile,
// decodeAudioPcmFileChannel, probeAudioChannels, parseAudioChannelCount,
// readPcmRange) are removed with lib/server/extract/audio.ts. They existed to
// feed the TypeScript whisper pipeline window-by-window from disk; the pinned
// Python speech job decodes the selected stream itself, so no caller remains
// (verified by search across src and tests). audioPcmFromPath/audioPcm stay —
// video narration still decodes whole short tracks here.
