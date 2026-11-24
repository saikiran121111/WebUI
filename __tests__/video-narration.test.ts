import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractFile, extractFileFromPath } from "../lib/server/extract";
import { audioPcm } from "../lib/server/extract/ffmpeg";
import { attachmentParts } from "../lib/chat/client";
import type { Attachment } from "../lib/types";

// F123 (2026-11-23): the pinned Python Parakeet job is the SOLE speech engine.
// "off" keeps this hermetic file off the ML endpoint (the operator switch gates
// before ANY job is sent - a pinned law). The one seam row below CLEARS the
// switch for its own scope: an injected runJob REPLACES the transport, so that
// row has no endpoint in scope either.
process.env.RUKE_SPEECH_CAPABILITY = "off";

const execFileP = promisify(execFile);

/** The spoken-codeword wav from the fixture set — reused as the video's audio track. */
const SPOKEN_WAV = path.join(process.cwd(), "tests", "fixtures", "fixture-audio.wav");

async function ffmpegPath(): Promise<string> {
  const mod: any = await import("ffmpeg-static");
  return typeof mod === "string" ? mod : mod?.default;
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
    "F123: a narrated video's audio track is routed to the pinned speech job, and the delivered transcript carries segment times + engine provenance",
    async () => {
      // F123 moved transcription from the removed TypeScript whisper path to the
      // pinned Python Parakeet job. The real-inference content row (the spoken
      // "zephyr" word decoded from this clip) runs in the exclusive LIVE batch;
      // what vitest proves deterministically is the ROUTING + DELIVERY law: the
      // video path hands its clip to the speech.asr job, and a ready run comes
      // back as a timed transcript attributed to the engine the run reported.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruke-narr-"));
      const clip = path.join(dir, "narrated-video.mp4");
      delete process.env.RUKE_SPEECH_CAPABILITY; // seam row: the runJob REPLACES the transport
      try {
        const ff = await ffmpegPath();
        await execFileP(ff, [
          "-hide_banner", "-loglevel", "error", "-y",
          "-f", "lavfi", "-i", "testsrc=size=320x240:duration=6:rate=10",
          "-i", SPOKEN_WAV, "-shortest",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
          "-c:a", "aac", clip,
        ]);
        const seen: { capability: string; payload: Record<string, unknown> }[] = [];
        const runJob = async (capability: string, payload: Record<string, unknown>) => {
          seen.push({ capability, payload });
          return {
            state: "ready",
            capability: "speech.asr",
            job_id: "job-narr", run_id: "run-narr", request_id: "req-narr",
            deadline_s: 240, source: "test-seam",
            result: {
              state: "transcribed",
              text: "the codeword is zephyr",
              segments: [{ text: "the codeword is zephyr", start: 1.2, end: 3.4 }],
              segment_count: 1,
              language: "en", language_source: "explicit",
              model: "nvidia/parakeet-tdt-0.6b-v3",
              device: "cuda", compute_type: "auto",
              duration: 6, complete: true, asr_ran: true, note: "",
              examined: [[0, 6]], coverage: { skipped: [] },
              audio_level: {}, probe: {}, routing: {},
              vad_filter: false, vad_state: "unsupported_by_backend",
              superseded_fragments: 0, superseded: [],
            },
          };
        };
        const res = await extractFileFromPath("narrated-video.mp4", clip, undefined, "video/mp4", undefined, { runJob } as any);

        expect(seen.length, "the video path never reached the speech.asr job").toBe(1);
        expect(seen[0].capability).toBe("speech.asr");
        expect(String(seen[0].payload.path)).toBe(clip);

        expect(res.frames?.length, "video produced no frames").toBeGreaterThan(0);
        const t = String(res.transcript ?? "");
        expect(t, "video produced no transcript").toBeTruthy();
        expect(t.toLowerCase()).toContain("zephyr");
        expect(t).toMatch(/\[\d\d:\d\d:\d\d - \d\d:\d\d:\d\d\]/); // segment times ride the delivery
        expect(t).toContain("nvidia/parakeet-tdt-0.6b-v3"); // the RUN's reported engine, not a label
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
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

describe("audio decode has no duration cap", () => {
  it("decodes a 200 s track whole — past the old 180 s ceiling", async () => {
    const ff = await ffmpegPath();
    const out = path.join(process.cwd(), ".data", "tmp", "long_tone.wav");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    try {
      await execFileP(ff, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=200",
        "-ar", "16000", "-ac", "1", out,
      ]);
      const pcm = await audioPcm(fs.readFileSync(out), "wav");
      // 200 s at 16 kHz mono: the old cap would have stopped at 180 * 16000.
      expect(pcm.length).toBeGreaterThanOrEqual(199 * 16000);
      expect(pcm.length).toBeLessThanOrEqual(201 * 16000);
    } finally {
      fs.rmSync(out, { force: true });
    }
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
  it("frames the video as one complete saved record: spoken content rides with the images, never as a separate audio track", () => {
    const parts = attachmentParts(videoAtt({ transcript: "the codeword is zephyr" }));
    const texts = parts.filter(p => p.type === "text").map(p => p.text as string);
    const joined = texts.join("\n");
    expect(joined).toContain("zephyr");
    expect(joined).toContain("[spoken content begins]");
    expect(joined).toContain("complete saved record");
    // Record-honesty law (P3a): no claimed perception channel — the model is
    // never told it "watched" anything.
    expect(joined).not.toContain("you have watched");
    expect(joined).not.toContain("exactly as heard");
    expect(joined).toContain("never attribute content to");
    // The old split-perception wording must be gone.
    expect(joined).not.toContain("Audio track");
    expect(joined).not.toContain("sampled frames");
    expect(parts.some(p => p.type === "image_url")).toBe(true);
  });

  it("silent video prompt carries no spoken-content section", () => {
    const texts = attachmentParts(videoAtt({}))
      .filter(p => p.type === "text")
      .map(p => p.text as string);
    expect(texts.some(t => t.includes("spoken content begins"))).toBe(false);
    expect(texts.some(t => t.includes("complete saved record"))).toBe(true);
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
  it("frames the spoken content as the recording's own record, never as a transcript", () => {
    const texts = attachmentParts(audioAtt({ transcript: "the codeword is zephyr" }))
      .filter(p => p.type === "text")
      .map(p => p.text as string);
    const joined = texts.join("\n");
    expect(joined).toContain("zephyr");
    expect(joined).toContain("taken directly from the recording");
    // Record-honesty law (P3a): no "you have listened / exactly as heard" claim.
    expect(joined).not.toContain("you have listened");
    expect(joined).not.toContain("exactly as heard");
    expect(joined).toContain("[spoken content begins]");
    expect(joined).not.toContain("Transcript");
    expect(joined).toContain("never tell the user you cannot access its spoken content");
  });

  it("silent audio reports no speech without a transcript section", () => {
    const texts = attachmentParts(audioAtt({}))
      .filter(p => p.type === "text")
      .map(p => p.text as string);
    expect(texts.some(t => t.includes("no speech"))).toBe(true);
    expect(texts.some(t => t.includes("spoken content begins"))).toBe(false);
  });
});
