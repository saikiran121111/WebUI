import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * I16: when a video's speech could not be read, extractFileFromPath used to
 * discard the keyframes it had already sampled and return an error — the
 * model was told "no transcript" while the visuals sat unread in a folder.
 * This test builds a LONG video with a silent audio track and demands the
 * honest indexed outcome: an explicit coverage note naming what failed, the
 * keyframes KEPT and indexed, and the frames directory preserved.
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

const ATT = "att_silentcov1";

describe("video with unreadable speech keeps its visual evidence (I16)", () => {
  it("silent audio track → coverage note + indexed keyframes + frames dir kept", async () => {
    const dir = path.join(process.cwd(), ".data", "tmp", `vid_fail_${Date.now().toString(36)}`);
    const src = path.join(dir, "silent-cover.mp4");
    fs.mkdirSync(dir, { recursive: true });
    const bin = await ffmpegPath();
    try {
      // 16 s of scene cuts + an 84 s static tail, WITH a truly silent audio
      // track (anullsrc) so the ASR path runs, decodes, and finds nothing.
      const inputs: string[] = [];
      for (let i = 0; i < 8; i++) {
        inputs.push("-f", "lavfi", "-i", `color=c=${i % 2 ? "blue" : "red"}:s=32x32:d=2:r=5`);
      }
      inputs.push("-f", "lavfi", "-i", "color=c=red:s=32x32:d=84:r=5");
      inputs.push("-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono");
      const chains = Array.from({ length: 9 }, (_, i) => `[${i}:v]`).join("");
      await ffmpeg(bin, [
        ...inputs,
        "-filter_complex", `${chains}concat=n=9:v=1:a=0[v]`,
        "-map", "[v]", "-map", "9:a",
        "-t", "100",
        "-c:v", "libx264", "-preset", "veryfast",
        "-g", "10", "-keyint_min", "10",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        src,
      ]);

      const { extractFileFromPath } = await import("../../lib/server/extract");
      const res = await extractFileFromPath("silent-cover.mp4", src, ATT);

      // No hard error — the video was PARTLY readable and says so.
      expect(res.error).toBeUndefined();
      expect(res.indexed).toBeTruthy();

      const note = res.coverageNote ?? "";
      expect(note).toContain("no speech was detected in its audio track");
      expect(note).toContain("Its visual content WAS read");
      expect(note).toContain("(100s)");
      // The note doubles as the visible text for this outcome.
      expect(res.text ?? "").toContain("Its visual content WAS read");

      // Frames still ride along in the response…
      expect(res.frames?.length ?? 0).toBeGreaterThan(0);
      // …and the on-disk keyframes the INDEX points at are NOT deleted.
      const { framesDir } = await import("../../lib/server/attachindex/store");
      const kept = fs.readdirSync(framesDir(ATT));
      expect(kept.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        const { removeIndex } = await import("../../lib/server/attachindex/store");
        removeIndex(ATT);
      } catch {
        /* best-effort hygiene */
      }
    }
  }, 300_000);
});
