/**
 * F78-B — image pages/frames survive the server decoder, in the right colors.
 *
 * Repro (2026-11-13 audit, fixtures = 2-frame/2-page panels with opposite
 * colours per page):
 *  - animated WebP: ffmpeg refused the container outright
 *    ("image data not found") — decode failed;
 *  - multi-page TIFF: ffmpeg's demuxer returned ONLY page 1, page 2 vanished;
 *  - animated GIF: ffmpeg pages skipped disposal compositing (blank frames);
 *  - HEVC HEIC/HEIF: ffmpeg "moov atom not found" → "File read error" (422);
 *    libvips reads the container but its vendored libheif has no libde265
 *    HEVC plugin — the wasm libheif build (heic-decode) fills that gap.
 * The law under test: every page/frame arrives (bounded by MAX_IMAGE_PAGES),
 * `at` is a 1-based page number, the page colours are the real composited
 * pixels, and single-frame inputs get no fake frames.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { ffmpegPath, imageToDataUrlFromPath } from "../../lib/server/extract/ffmpeg";

const execFileP = promisify(execFile);
const FIX = path.join("docs", "overnight", "fixtures", "f78", "all-readers");
const SCRATCH = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f78img_"));
afterAll(() => {
  // Windows: ffmpeg/sharp handles can keep the dir locked after the last test
  // (EPERM). Scratch lives under .data/tmp — removal is best-effort, never a
  // test failure.
  try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* leave for the next sweep */ }
});

const pngOf = (dataUrl: string) => Buffer.from(dataUrl.split(",")[1] ?? "", "base64");

/** Sample the decoded page at a fractional position (0..1, 0..1). */
async function pixel(dataUrl: string, fx: number, fy: number): Promise<number[]> {
  const buf = pngOf(dataUrl);
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const o = (Math.floor(info.height * fy) * info.width + Math.floor(info.width * fx)) * info.channels;
  return [data[o], data[o + 1], data[o + 2]];
}
const isRed = (p: number[]) => p[0] > 180 && p[1] < 80 && p[2] < 80;
const isBlue = (p: number[]) => p[2] > 180 && p[0] < 80;

/**
 * The audit panels (g80 grid probe through the production chain): page 1 is
 * RED top-left / BLUE bottom-right, page 2 swapped; everything else white.
 */
async function expectOppositePages(name: string) {
  const r = await imageToDataUrlFromPath(path.join(FIX, name));
  expect(r.pages, `${name} page count`).toBe(2);
  expect(r.frames?.map(f => f.at), `${name} page ids`).toEqual([2]);
  // TL = (0.1,0.15), BR = (0.9,0.85) of the fixture layout.
  expect(await pixel(r.dataUrl, 0.1, 0.15), `${name} page 1 top-left`).toSatisfy(isRed);
  expect(await pixel(r.dataUrl, 0.9, 0.85), `${name} page 1 bottom-right`).toSatisfy(isBlue);
  expect(await pixel(r.frames![0].dataUrl, 0.1, 0.15), `${name} page 2 top-left`).toSatisfy(isBlue);
  expect(await pixel(r.frames![0].dataUrl, 0.9, 0.85), `${name} page 2 bottom-right`).toSatisfy(isRed);
}

describe("animated / multi-page containers (F78-B)", () => {
  it("animated GIF decodes BOTH frames with composited opposite colours", async () => {
    await expectOppositePages("panel.gif");
  }, 60_000);

  it("animated WebP decodes at all — the ffmpeg repro returned zero pages", async () => {
    await expectOppositePages("panel.webp");
  }, 60_000);

  it.each(["panel.tif", "panel.tiff"])("%s keeps every page — ffmpeg dropped page 2", async name => {
    await expectOppositePages(name);
  }, 60_000);
});

describe("HEVC HEIC/HEIF (wasm libheif fills libvips' missing libde265)", () => {
  it.each(["reference.heic", "reference.heif"])("%s decodes with real pixels, both pages declared", async name => {
    const r = await imageToDataUrlFromPath(path.join(FIX, name));
    expect(r.pages, `${name} page count`).toBe(2);
    const { data, info } = await sharp(pngOf(r.dataUrl)).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBeLessThanOrEqual(1280);
    expect(info.height).toBeLessThanOrEqual(1280);
    // A real photo, not a blank raster: the audit fixture is 1280x854 full-range.
    let min = 255, max = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(max - min, `${name} pixel range (HEVC pixels decoded)`).toBeGreaterThan(100);
  }, 120_000);
});

describe("caps and honesty", () => {
  it("an extreme portrait is capped <=1280 BOTH sides, aspect intact", async () => {
    const ff = await ffmpegPath();
    const src = path.join(SCRATCH, "tall.png");
    await execFileP(ff, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=1080x4000", "-frames:v", "1", src], { timeout: 60_000 });
    const r = await imageToDataUrlFromPath(src);
    const { info } = await sharp(pngOf(r.dataUrl)).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBeLessThanOrEqual(1280);
    expect(info.height).toBeLessThanOrEqual(1280);
    expect(info.height).toBe(1280);
    expect(info.width / info.height).toBeCloseTo(1080 / 4000, 1);
    expect(r.pages).toBe(1);
    expect(r.frames).toBeUndefined();
  }, 120_000);

  it("a 12-frame GIF ships a bounded spread — `pages` is the TRUE total and the LAST frame is included (F67)", async () => {
    const ff = await ffmpegPath();
    const src = path.join(SCRATCH, "many.gif");
    await execFileP(ff, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:duration=1.2:rate=10", src], { timeout: 60_000 });
    const r = await imageToDataUrlFromPath(src);
    expect(r.pages, "honest total, not the cap").toBe(12);
    const ats = r.frames?.map(f => f.at) ?? [];
    expect(ats.length).toBe(7); // 8 shown = dataUrl + 7
    expect(ats[ats.length - 1], "final frame reaches the model").toBe(12);
    expect(ats, "ascending true 1-based positions").toEqual([...ats].sort((a, b) => a - b));
    expect(new Set(ats).size, "no duplicate positions").toBe(ats.length);
  }, 120_000);

  it("a 24-frame GIF (live fr-I3 fixture size) delivers the LAST frame at position 24", async () => {
    const ff = await ffmpegPath();
    const src = path.join(SCRATCH, "many24.gif");
    await execFileP(ff, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:duration=2.4:rate=10", src], { timeout: 60_000 });
    const r = await imageToDataUrlFromPath(src);
    expect(r.pages).toBe(24);
    const ats = r.frames?.map(f => f.at) ?? [];
    expect(ats.length).toBe(7);
    expect(ats[ats.length - 1]).toBe(24);
  }, 120_000);

  it("single-frame inputs get one page and NO fake frames", async () => {
    for (const name of ["panel.png", "panel.jpg"]) {
      const r = await imageToDataUrlFromPath(path.join(FIX, name));
      expect(r.pages, name).toBe(1);
      expect(r.frames, name).toBeUndefined();
    }
  }, 60_000);

describe("declared pixel dimensions (F68)", () => {
  /**
   * Independent ground truth for HEIC: parse every ispe box straight out of
   * the ISO-BMFF container. The PRIMARY image is the largest (thumbnails are
   * smaller); the decoder must declare exactly those dimensions, never the
   * downscaled delivery raster and never a thumbnail.
   */
  function ispeDims(buf: Buffer): { w: number; h: number }[] {
    const out: { w: number; h: number }[] = [];
    const walk = (off: number, end: number) => {
      let p = off;
      while (p + 8 <= end) {
        let size = buf.readUInt32BE(p);
        const type = buf.toString("ascii", p + 4, p + 8);
        let hdr = 8;
        if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
        if (size < 8 || p + size > end) break;
        if (type === "ispe") out.push({ w: buf.readUInt32BE(p + hdr + 4), h: buf.readUInt32BE(p + hdr + 8) });
        else if (type === "meta" || type === "iprp" || type === "ipco" || type === "iinf")
          walk(p + hdr + (type === "meta" || type === "iinf" ? 4 : 0), p + size);
        p += size;
      }
    };
    walk(0, buf.length);
    return out;
  }

  it.each(["reference.heic", "reference.heif"])("%s declares the container's primary ispe dimensions", async name => {
    const buf = fs.readFileSync(path.join(FIX, name));
    const primary = ispeDims(buf).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    expect(primary.w * primary.h, `${name} has a primary ispe`).toBeGreaterThan(0);
    const r = await imageToDataUrlFromPath(path.join(FIX, name));
    expect([r.width, r.height], `${name} = primary ispe, not the delivery raster`).toEqual([primary.w, primary.h]);
  }, 120_000);

  it("flat fixtures declare their file dimensions; the oversized portrait declares the SOURCE, not the capped raster", async () => {
    for (const name of ["panel.png", "panel.jpg"]) {
      const meta = await sharp(fs.readFileSync(path.join(FIX, name))).metadata();
      const r = await imageToDataUrlFromPath(path.join(FIX, name));
      expect([r.width, r.height], name).toEqual([meta.width, meta.height]);
    }
    const ff = await ffmpegPath();
    const src = path.join(SCRATCH, "tall-dims.png");
    await execFileP(ff, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=1080x4000", "-frames:v", "1", src], { timeout: 60_000 });
    const r = await imageToDataUrlFromPath(src);
    expect([r.width, r.height], "source dims survive the <=1280 delivery cap").toEqual([1080, 4000]);
  }, 120_000);
});
});

describe("ffmpeg fallback", () => {
  it("ICO — a container libvips cannot read — still decodes via the ffmpeg fallback", async () => {
    const r = await imageToDataUrlFromPath(path.join(FIX, "panel.ico"));
    expect(r.pages).toBe(1);
    expect(r.dataUrl).toMatch(/^data:image\/png/);
  }, 60_000);
});
