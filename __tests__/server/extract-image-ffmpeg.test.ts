/**
 * I07 (server half) — image decode caps & multi-page expansion.
 *
 * ffmpeg-generated fixtures (bundled lavfi sources) stand in for the two real
 * failure shapes: an extreme-portrait screenshot that used to be crushed to an
 * unreadable 72px-wide sliver, and a multi-frame GIF whose frames were simply
 * dropped. The client canvas strip path (encodeImage) is DOM-only and stays
 * browser-verified in the final Playwright loop; this file locks the server
 * side: dimensions are capped while ASPECT SURVIVES, page counts are honest,
 * and `at` on image frames is a 1-based PAGE NUMBER (never seconds).
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffmpegPath, imageToDataUrlFromPath } from "../../lib/server/extract/ffmpeg";

const execFileP = promisify(execFile);
const SCRATCH = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "img_"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** PNG IHDR is big-endian: width at byte 16, height at 20. */
const pngDims = (buf: Buffer): { width: number; height: number } => ({
  width: buf.readUInt32BE(16),
  height: buf.readUInt32BE(20),
});
const dimsOfDataUrl = (dataUrl: string) =>
  pngDims(Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));

describe("ffmpeg image decode — I07", () => {
  it("an extreme portrait image is capped to <=1280 BOTH sides, aspect intact", async () => {
    const ff = await ffmpegPath();
    const src = path.join(SCRATCH, "tall.png");
    await execFileP(ff, [
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=1080x4000",
      "-frames:v", "1", src,
    ], { timeout: 60_000 });
    const input = pngDims(fs.readFileSync(src));
    expect(input).toEqual({ width: 1080, height: 4000 }); // proves the fixture is what we think

    const r = await imageToDataUrlFromPath(src);
    const out = dimsOfDataUrl(r.dataUrl);
    expect(out.width).toBeLessThanOrEqual(1280);
    expect(out.height).toBeLessThanOrEqual(1280);
    expect(out.height).toBe(1280); // the constraint side saturates the cap
    expect(out.width / out.height).toBeCloseTo(1080 / 4000, 1); // aspect survived — no sliver
    expect(r.pages).toBe(1);
    expect(r.frames).toBeUndefined(); // single-frame input gets no fake frames
  }, 120_000);

  it("a multi-frame GIF reports its page count and carries frames with 1-BASED PAGE numbers", async () => {
    const ff = await ffmpegPath();
    const src = path.join(SCRATCH, "anim.gif");
    await execFileP(ff, [
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=64x64:duration=2:rate=10",
      src,
    ], { timeout: 60_000 }); // ~20 frames

    const r = await imageToDataUrlFromPath(src);
    expect(r.pages).toBe(8); // MAX_IMAGE_PAGES cap, declared honestly
    expect(r.frames?.length).toBe(7); // overview + 7 extras
    expect(r.frames?.map((f) => f.at)).toEqual([2, 3, 4, 5, 6, 7, 8]); // PAGE numbers, not seconds
    for (const f of r.frames ?? []) expect(f.dataUrl).toMatch(/^data:image\/png/);
  }, 120_000);
});
