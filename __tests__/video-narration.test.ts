import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractFile } from "../lib/server/extract";
import { attachmentParts } from "../lib/chat/client";
import type { Attachment } from "../lib/types";

const execFileP = promisify(execFile);

/** The spoken-codeword wav from the fixture set — reused as the video's audio track. */
const SPOKEN_WAV = path.join(process.cwd(), "tests", "fixtures", "fixture-audio.wav");

async function ffmpegPath(): Promise<string> {
  const mod: any = await import("ffmpeg-static");
  return typeof mod === "string" ? mod : mod?.default;
}

/** Burn-in-free clip with the spoken wav muxed in as its audio track. */
async function narratedVideoMp4(): Promise<Buffer> {
  const ff = await ffmpegPath();
  const out = path.join(process.cwd(), ".data", "tmp", "narration_repro.mp4");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    await execFileP(ff, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:duration=6:rate=10",
      "-i", SPOKEN_WAV, "-shortest",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
      "-c:a", "aac", out,
    ]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Same clip with the audio stream dropped (-an). */
async function silentVideoMp4(): Promise<Buffer> {
  const ff = await ffmpegPath();
  const out = path.join(process.cwd(), ".data", "tmp", "silent_repro.mp4");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    await execFileP(ff, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:duration=4:rate=10", "-an",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", out,
    ]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

describe("video extraction keeps the audio track", () => {
  it(
    "narrated video yields frames AND a whisper transcript of the speech",
    async () => {
      const buf = await narratedVideoMp4();
      const res = await extractFile("narrated-video.mp4", buf);

      expect(res.frames?.length, "video produced no frames").toBeGreaterThan(0);
      expect(res.transcript, "video produced no transcript").toBeTruthy();
      expect(String(res.transcript).toLowerCase()).toContain("zephyr");
    },
    300_000,
  );

  it("silent video still extracts frames and reports no transcript", async () => {
    const buf = await silentVideoMp4();
    const res = await extractFile("silent-video.mp4", buf);

    expect(res.error, "silent video should not error").toBeUndefined();
    expect(res.frames?.length, "video produced no frames").toBeGreaterThan(0);
    expect(res.transcript || "").toBe("");
  }, 120_000);
});

function videoAtt(extra: Partial<Attachment>): Attachment {
  return {
    id: "att_1", name: "clip.mp4", kind: "video", mime: "video/mp4", size: 1024,
    status: "ready", category: "video",
    frames: [{ dataUrl: "data:image/png;base64,AAAA", at: 1.2 }],
    ...extra,
  } as Attachment;
}

describe("video prompt parts", () => {
  it("puts the transcript in front of the model alongside the frames", () => {
    const parts = attachmentParts(videoAtt({ transcript: "the codeword is zephyr" }));
    const texts = parts.filter(p => p.type === "text").map(p => p.text as string);
    expect(texts.some(t => t.includes("Audio track") && t.includes("zephyr"))).toBe(true);
    expect(parts.some(p => p.type === "image_url")).toBe(true);
  });

  it("silent video prompt carries no transcript section", () => {
    const texts = attachmentParts(videoAtt({}))
      .filter(p => p.type === "text")
      .map(p => p.text as string);
    expect(texts.some(t => t.includes("Audio track"))).toBe(false);
  });
});

function audioAtt(extra: Partial<Attachment>): Attachment {
  return {
    id: "att_2", name: "clip.mp3", kind: "audio", mime: "audio/mpeg", size: 1024,
    status: "ready", category: "audio",
    ...extra,
  } as Attachment;
}

describe("audio prompt parts", () => {
  it("frames the transcript as audio the model heard, never as a transcript", () => {
    const texts = attachmentParts(audioAtt({ transcript: "the codeword is zephyr" }))
      .filter(p => p.type === "text")
      .map(p => p.text as string);
    const joined = texts.join("\n");
    expect(joined).toContain("zephyr");
    expect(joined).toContain("you have listened");
    expect(joined).toContain("[spoken content begins]");
    expect(joined).not.toContain("Transcript");
    expect(joined).toContain("never tell the user you cannot hear audio");
  });

  it("silent audio reports no speech without a transcript section", () => {
    const texts = attachmentParts(audioAtt({}))
      .filter(p => p.type === "text")
      .map(p => p.text as string);
    expect(texts.some(t => t.includes("no speech"))).toBe(true);
    expect(texts.some(t => t.includes("spoken content begins"))).toBe(false);
  });
});
