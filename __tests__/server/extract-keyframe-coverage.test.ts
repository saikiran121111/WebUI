import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * I17: keyframe sampling used to stop at the scene-change pass, so a 4-hour
 * lecture whose cuts all happen early produced keyframes ONLY from the first
 * minutes — asking "what's on screen at 3:20:00" was unanswerable even
 * though the file was right there. The seek top-up + tail anchor must make
 * coverage span the WHOLE timeline under a small frame cap.
 */

async function ffmpegPath(): Promise<string> {
  const mod: any = await import("ffmpeg-static");
  return typeof mod === "string" ? mod : mod?.default;
}

async function ffmpeg(bin: string, args: string[]): Promise<void> {
  try {
    await execFileP(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 240_000,
    });
  } catch (e: any) {
    throw new Error(`ffmpeg failed: ${e?.stderr ?? e?.message}`);
  }
}

const TOTAL_SEC = 220; // ten 2-second cut segments + a 200-second static tail

describe("keyframe coverage spans the whole timeline (I17)", () => {
  it("long video with early cuts still yields keyframes near its end under a 6-frame cap", async () => {
    const dir = path.join(process.cwd(), ".data", "tmp", `kf_cov_${Date.now().toString(36)}`);
    const src = path.join(dir, "long.mp4");
    const outDir = path.join(dir, "frames");
    fs.mkdirSync(outDir, { recursive: true });
    const bin = await ffmpegPath();
    try {
      // 10 alternating red/blue 2 s segments (scene cuts at 2,4,...,20 s)
      // then one 200 s red segment: after ~20 s the video NEVER changes.
      const inputs: string[] = [];
      for (let i = 0; i < 10; i++) {
        inputs.push("-f", "lavfi", "-i", `color=c=${i % 2 ? "blue" : "red"}:s=32x32:d=2:r=5`);
      }
      inputs.push("-f", "lavfi", "-i", "color=c=red:s=32x32:d=200:r=5");
      const chains = Array.from({ length: 11 }, (_, i) => `[${i}:v]`).join("");
      await ffmpeg(bin, [
        ...inputs,
        "-filter_complex", `${chains}concat=n=11:v=1:a=0[v]`,
        "-map", "[v]",
        "-c:v", "libx264", "-preset", "veryfast",
        "-g", "10", "-keyint_min", "10",
        "-pix_fmt", "yuv420p",
        src,
      ]);

      const { videoKeyframesFromPath } = await import("../../lib/server/extract/ffmpeg");
      const frames = await videoKeyframesFromPath(src, outDir, { maxFrames: 6 });

      const ats = frames.map(f => f.at);
      expect(ats.length).toBeGreaterThanOrEqual(2);
      expect(ats.length).toBeLessThanOrEqual(6);

      // The regression this guards: every sampled moment sitting in the
      // first minutes of a 3.5-minute-plus video. Coverage must reach the
      // tail (within 90 s of the end) and spread across the timeline.
      const maxAt = Math.max(...ats);
      const minAt = Math.min(...ats);
      expect(maxAt, `keyframes only reached ${maxAt.toFixed(0)}s of a ${TOTAL_SEC}s video — the tail was never sampled`)
        .toBeGreaterThanOrEqual(TOTAL_SEC - 90);
      expect(maxAt - minAt).toBeGreaterThanOrEqual(TOTAL_SEC / 3);

      // On-disk contract: every entry names a real file in outDir, and
      // nothing else litters the directory (index.ts maps "frames/"+name).
      const names = fs.readdirSync(outDir);
      expect(names.length).toBe(frames.length);
      for (const f of frames) {
        expect(f.name).toMatch(/^f_\d{5}\.jpg$/);
        expect(names, `missing ${f.name}`).toContain(f.name);
        expect(fs.statSync(path.join(outDir, f.name)).size).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
