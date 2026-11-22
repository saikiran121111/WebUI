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

  it("a 12-frame GIF is bounded at the 8-page cap, page ids included", async () => {
    const ff = await ffmpegPath();
    const src = path.join(SCRATCH, "many.gif");
    await execFileP(ff, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:duration=1.2:rate=10", src], { timeout: 60_000 });
    const r = await imageToDataUrlFromPath(src);
    expect(r.pages).toBe(8);
    expect(r.frames?.map(f => f.at)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  }, 120_000);

  it("single-frame inputs get one page and NO fake frames", async () => {
    for (const name of ["panel.png", "panel.jpg"]) {
      const r = await imageToDataUrlFromPath(path.join(FIX, name));
      expect(r.pages, name).toBe(1);
      expect(r.frames, name).toBeUndefined();
    }
  }, 60_000);

  it("ICO — a container libvips cannot read — still decodes via the ffmpeg fallback", async () => {
    const r = await imageToDataUrlFromPath(path.join(FIX, "panel.ico"));
    expect(r.pages).toBe(1);
    expect(r.dataUrl).toMatch(/^data:image\/png/);
  }, 60_000);
});
