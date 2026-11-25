/**
 * F153 item 4 (2026-11-25) — video coverage independent of transcript length.
 *
 * The user law: "I upload a file once, ask about it naturally, and can ask a
 * follow-up about any page, figure, or time in the original." A three-hour
 * screen recording with ten spoken words has a SMALL transcript and a
 * THREE-HOUR visual record. The old small-transcript branch spread a few
 * keyframes inline, DELETED the extracted frames dir and built no index:
 * everything the keyframe pass paid ffmpeg for became unaddressable, and a
 * follow-up about any later moment had nothing to retrieve.
 *
 * The catch-path law: every path turning keyframe/timeline/publication
 * errors into null must carry coverage — "no event found" is not
 * "never inspected", and a silent null makes the rest of the source
 * unreachable without saying so.
 *
 * Pins (set before any production import): RUKE_LLM_AUTOMATIC_HANDOFF=0
 * RUKE_OCR_ALLOW_UNLOAD=0 — a test process never hands off to, probes,
 * unloads or restarts the shared :8080 model. RUKE_SPEECH_CAPABILITY=off is
 * CLEARED per seam row (the injected runJob replaces the transport, fully
 * hermetic; no endpoint in scope). The live-provider guard (setupFiles)
 * fails the run if anything reaches :8080.
 */
import { test, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.RUKE_LLM_AUTOMATIC_HANDOFF = "0";
process.env.RUKE_OCR_ALLOW_UNLOAD = "0";
process.env.RUKE_SPEECH_CAPABILITY = "off"; // seam rows clear this per test

/**
 * Control-gated partial mocks for the catch-path row. The production triggers
 * for these catches are deployment-grade failures (the keyframe pass THROWS
 * on an fs/ffmpeg failure; probeInfo itself never throws, and synthetic
 * files never make it throw), so the seam throws ON DEMAND through the real
 * production chain: the catch, the coverage sentence and the return shape
 * stay the owner's real code. Flags default off — the durable-record row
 * runs entirely on real ffmpeg.
 */
vi.mock("@/lib/server/extract/ffmpeg", async (orig) => {
  const real = (await (orig as () => Promise<Record<string, any>>)());
  return {
    ...real,
    videoKeyframesFromPath: async (...args: unknown[]) => {
      if ((globalThis as any).__F153_KF_FAIL) {
        throw new Error("simulated deployment failure: ffmpeg exited mid keyframe pass (exit 137)");
      }
      return real.videoKeyframesFromPath(...args);
    },
  };
});

vi.mock("@/lib/server/attachindex/timeline", async (orig) => {
  const real = (await (orig as () => Promise<Record<string, any>>)());
  return {
    ...real,
    buildTimeline: async (...args: unknown[]) => {
      if ((globalThis as any).__F153_BL_FAIL) {
        throw new Error("simulated baseline failure: scratch write failed (ENOSPC)");
      }
      return real.buildTimeline(...args);
    },
  };
});

const ATT = {
  small: "att_f153vid1", // small transcript, real keyframes + seek coverage
  broken: "att_f153vid2", // keyframe pass and baseline pass THROW — coverage must name them
} as const;

let extractFileFromPath: typeof import("@/lib/server/extract").extractFileFromPath;
let store: typeof import("@/lib/server/attachindex/store");

beforeAll(async () => {
  ({ extractFileFromPath } = await import("@/lib/server/extract"));
  store = await import("@/lib/server/attachindex/store");
  for (const a of Object.values(ATT)) store.removeIndex(a);
});

afterAll(() => {
  for (const a of Object.values(ATT)) store.removeIndex(a);
});

/** The speech verdict rides the job seam (same shape the media-delivery
 *  rows pin): a SHORT transcript — that is the whole point of the defect. */
const envelope = (state: string, extra: Record<string, unknown> = {}) => ({
  state,
  ...(state === "ready" ? {} : { error: { reason: "unreachable", message: "stub" } }),
  ...extra,
});

const speechEnvelope = (words: Array<{ t: string; at: number }>, duration: number) =>
  envelope("ready", {
    result: {
      state: "transcribed",
      text: words.map(w => w.t).join(" "),
      segments: words.map(w => ({ text: w.t, start: w.at, end: w.at + 1.8 })),
      segment_count: words.length,
      language: "en",
      language_source: "explicit",
      model: "nvidia/parakeet-tdt-0.6b-v3",
      device: "cuda",
      compute_type: "auto",
      duration,
      complete: true,
      asr_ran: true,
      note: "",
      examined: [[0, duration]],
      coverage: { skipped: [] },
      audio_level: {},
      probe: {},
      routing: {},
      vad_filter: false,
      vad_state: "unsupported_by_backend",
      superseded_fragments: 0,
      superseded: [],
    },
  });

/**
 * Five 2 s alternating black/white segments plus a long static tail. The
 * length is the law, not decoration: the seek top-up (the long-video
 * coverage law) only buys the uncovered stretch once
 * `coveredUntil < duration - 90`, so a screen recording shaped like the
 * user's — cuts in the opening minutes, hours of static screen — MUST be
 * past that bound to be representative. On synthetic flat files the
 * decoder's scene side-data is sparse (verified: `gt(scene,0)` fires once
 * on this container), so the timeline samples from the seek loop are the
 * addressable visual record — exactly the production regime the brief
 * names ("a three-hour screen recording with ten spoken words").
 */
async function sparseSpeechVideo(dir: string): Promise<string> {
  const { ffmpegPath } = await import("@/lib/server/extract/ffmpeg");
  const ffmpeg = await ffmpegPath();
  const src = path.join(dir, "screen.mp4");
  const inputs: string[] = [];
  for (let i = 0; i < 5; i++) {
    inputs.push("-f", "lavfi", "-i", `color=c=${i % 2 ? "white" : "black"}:s=64x64:d=2:r=15`);
  }
  inputs.push("-f", "lavfi", "-i", "color=c=black:s=64x64:d=370:r=15");
  const chains = Array.from({ length: 6 }, (_, i) => `[${i}:v]`).join("");
  const mk = spawnSync(ffmpeg, [
    "-y", ...inputs,
    "-filter_complex", `${chains}concat=n=6:v=1:a=0[v]`,
    "-map", "[v]",
    "-c:v", "libx264", "-preset", "veryfast",
    "-g", "30", "-keyint_min", "30",
    "-pix_fmt", "yuv420p",
    src,
  ], { encoding: "buffer" });
  if (mk.status !== 0) throw new Error(`ffmpeg fixture failed: ${mk.stderr}`);
  return src;
}

test(
  "F153-i4: a SHORT transcript on a real video still yields a DURABLE visual record — no deletion, no silent no-index",
  async () => {
    delete process.env.RUKE_SPEECH_CAPABILITY; // seam row: runJob replaces the transport
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f153vid_"));
    try {
      const src = await sparseSpeechVideo(dir); // ~380 s, cuts only in the first 10 s
      const runJob = async () =>
        speechEnvelope([{ t: "opening slide", at: 1.2 }, { t: "closing slide", at: 312.4 }], 380);
      const r = await extractFileFromPath("screen.mp4", src, ATT.small, undefined, undefined, { runJob } as any);
      // THE law: a small transcript does NOT demote the recording to a few
      // inline previews — the keyframes the pass paid for stay on disk and
      // ride the published index, addressable by every later follow-up.
      expect(r.indexed, "small-transcript video built no durable index").toBe(true);
      expect(fs.existsSync(store.framesDir(ATT.small)),
        "the frames dir was deleted: the visual record became unaddressable").toBe(true);
      const idx = store.readIndex(ATT.small);
      expect(idx, "no index for the small-transcript video").not.toBeNull();
      const saved = idx!.meta.frames ?? [];
      // Scene frame at the opening cut + seek samples down the static tail
      // (the 120 s cadence) — the whole timeline becomes addressable, not
      // just the minutes that happened to speak.
      expect(saved.length, "the published index carries no keyframes").toBeGreaterThanOrEqual(3);
      for (const f of saved) {
        expect(fs.existsSync(path.join(store.indexDir(ATT.small), f.file)),
          `keyframe ${f.file} is not on disk`).toBe(true);
      }
      // Coverage beats transcript length: a late saved moment exists, so a
      // follow-up about the end of the recording has a saved picture.
      const latest = saved.reduce((m, f) => Math.max(m, f.at), 0);
      expect(latest, "no saved moment covers the second half of the recording").toBeGreaterThanOrEqual(120);
      // The inline spread law (F78) stands: the first answer still sees the
      // time-spread moments without a retrieval.
      expect((r as any).frames.length).toBeGreaterThanOrEqual(1);
      // Delivery: the spoken facts arrive timed.
      const t = String((r as any).transcript ?? "");
      expect(t).toContain("opening slide");
      expect(t).toContain("closing slide");
      // The sampling-coverage law: the note states WHAT was sampled and that
      // the space between samples was never examined — no silent reachability.
      const note = String((r as any).coverageNote ?? "");
      expect(note).toContain("sampled at");
      expect(note).toContain("never examined");
      // The baseline law: a MISSING baseline with no capability route is a
      // stated configuration fact (timeline.ts law), not a silent degradation;
      // the THROW path is pinned on the broken-fixture row below.
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  600_000,
);

test(
  "F153-i4: a keyframe pass that throws and a baseline pass that throws are REPORTED — silent nulls must not hide the missing visual record",
  async () => {
    delete process.env.RUKE_SPEECH_CAPABILITY; // seam row: runJob replaces the transport
    (globalThis as any).__F153_KF_FAIL = true;
    (globalThis as any).__F153_BL_FAIL = true;
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f153brok_"));
    try {
      // An .mp4 name over bytes ffprobe cannot open: the frame-decode path
      // reports the failure itself (F152). The keyframe pass and the
      // baseline pass hit their production catches (fs/ffmpeg-grade
      // failures — probeInfo itself never throws, so a file cannot drive
      // them): the control-gated seam throws through the REAL catch.
      const src = path.join(dir, "broken.mp4");
      fs.writeFileSync(src, Buffer.from(fs.readFileSync(path.join(process.cwd(), "package.json")).subarray(0, 4096)));
      const runJob = async () =>
        speechEnvelope([{ t: "surviving spoken fact", at: 3.0 }], 42);
      const r = await extractFileFromPath("broken.mp4", src, ATT.broken, undefined, undefined, { runJob } as any);
      const note = String((r as any).coverageNote ?? "");
      // The frame-decode failure was already named (F152); the KEYFRAME pass
      // failure used to be swallowed by `.catch(() => null)` — the visual
      // record was silently unreachable.
      expect(note).toContain("visual content could not be decoded");
      expect(note, "the keyframe pass failure was swallowed").toContain("keyframe pass");
      expect(note).toContain("no visual record");
      // The baseline build THREW: its null used to be silent too. Every
      // catch that turns evidence into null carries coverage, and the
      // follow-up guidance names what remains.
      expect(note, "the baseline build failure was swallowed").toContain("durable media baseline");
      expect(note).toContain("follow-ups start from");
      // The spoken fact STILL ships: a visual-record failure never voids the
      // audio evidence, and the recording stays indexed and addressable.
      expect(r.indexed, "a visual failure dropped the durable index").toBe(true);
      expect(String((r as any).transcript ?? "")).toContain("surviving spoken fact");
    } finally {
      delete (globalThis as any).__F153_KF_FAIL;
      delete (globalThis as any).__F153_BL_FAIL;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  600_000,
);
