/**
 * attach-timeline-frameocr.test.ts - the frame reader inside the media baseline
 * (amendment 3 section F: "reuse the same CPU OCR worker for relevant video
 * frames"). Every envelope here is a MOCK: this file proves the CALLER's
 * dispatch, rejection and bookkeeping rules, and proves nothing about whether a
 * recogniser can actually read a slide. It is not OCR quality evidence - that
 * run is held because it needs a watched screen.
 *
 * The law under test: PLANNED != DECODED != RECOGNISED != INTERPRETED, and no
 * caller may upgrade one stage into the next.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildTimeline,
  interpretFrameOcr,
  FRAME_OCR_CAPABILITY,
  FRAME_OCR_LANGUAGE_ENV,
  FRAME_OCR_MAX_FRAMES,
  FRAME_OCR_TEXT_CAP,
} from "../lib/server/attachindex/timeline";
import { buildMediaHints, mediaHintQueries } from "../lib/server/attachindex/media-hints";
import type { IndexMeta } from "../lib/server/attachindex/types";
import type { MlJobEnvelope } from "../lib/server/ml-job";

// Rust forwards the worker's own terminal state, and a good ruke job says
// "ready" (contracts.PROGRESS_STATES), so that is what a success looks like here.
const ready = (capability: string, payload: unknown): MlJobEnvelope => ({
  state: "ready", capability, job_id: "j", run_id: "r", request_id: "q", deadline_s: 30,
  source: "rust-ml-job",
  result: { job_id: "j", capability, state: "ready", payload, schema_version: 1 },
});
const failed = (capability: string, reason: string, message: string): MlJobEnvelope => ({
  state: "failed", capability, job_id: "j", run_id: "r", request_id: "q", deadline_s: 30,
  source: "rust-ml-job",
  error: { reason, message, retryable: false, capability, human_step: "" },
});

const goodPayload = {
  stage_counts: { planned: 12, decoded: 9, recognised: 1, glyph_free: 6, unresolved: 2, duplicates: 1 },
  ocr: { engine: "5.5.3.20260724", note: "tesseract 5.5.3.20260724, cpu" },
  language: "eng",
  blocks: [{
    start: 12.5, end: 12.5, text: "Halcyon Grid quarterly results", engine: "5.5.3.20260724",
    language_code: "eng", frame_digest: "aa11bb", confidence: 91.5,
  }],
};

describe("interpretFrameOcr refuses instead of inventing", () => {
  it("says not_configured when the deployment has no capability route", () => {
    const got = interpretFrameOcr(null, "eng");
    expect(got.state).toBe("not_configured");
    expect(got.observations).toEqual([]);
    expect(got.readAt).toEqual([]);
    expect(got.reason).toContain("no capability route");
  });

  it("passes a typed failure through, and keeps a cancel a cancel", () => {
    const got = interpretFrameOcr(
      failed(FRAME_OCR_CAPABILITY, "not_ready", "the project-local tessdata has no eng.traineddata"),
      "eng",
    );
    expect(got.state).toBe("failed");
    expect(got.reason).toContain("not_ready");
    expect(got.reason).toContain("eng.traineddata");
    expect(got.observations).toEqual([]);

    const cancelled: MlJobEnvelope = { ...failed(FRAME_OCR_CAPABILITY, "cancelled", "the upload request was aborted"), state: "cancelled" };
    expect(interpretFrameOcr(cancelled, "eng").state).toBe("cancelled");
  });

  it("calls a success that reports no stage counts a contract mismatch, not a text-free video", () => {
    const got = interpretFrameOcr(ready(FRAME_OCR_CAPABILITY, { blocks: [], note: "all good" }), "eng");
    expect(got.state).toBe("failed");
    expect(got.reason).toContain("contract_mismatch");
    // Refusing is what keeps "we never read a frame" out of the coverage record.
    expect(got.readAt).toEqual([]);
    expect(got.planned).toBe(0);
  });

  it("takes the stage counts from the worker and never upgrades them from its own rows", () => {
    const got = interpretFrameOcr(ready(FRAME_OCR_CAPABILITY, goodPayload), "und");
    expect(got.state).toBe("ok");
    expect([got.planned, got.decoded, got.recognised, got.glyphFree, got.unresolved])
      .toEqual([12, 9, 1, 6, 2]);
    // readAt lists only the instants the recogniser RAN on, so one text row can
    // never present a 12-instant sample as 12 examined points.
    expect(got.readAt).toEqual([12.5]);
    // The engine names its own language; the caller's placeholder is overridden.
    expect(got.language).toBe("eng");
    expect(got.engine).toBe("5.5.3.20260724");
    expect(got.observations[0]).toMatchObject({
      kind: "ocr", start: 12.5, end: 12.5,
      provider: "tesseract@5.5.3.20260724/eng",
      frame_ref: "frame:aa11bb",
      confidence: 91.5,
    });
  });

  it("drops rows whose timestamp or text cannot survive, without touching the counts", () => {
    const got = interpretFrameOcr(ready(FRAME_OCR_CAPABILITY, {
      stage_counts: { planned: 5, decoded: 5, recognised: 5, glyph_free: 0, unresolved: 0, duplicates: 0 },
      ocr: { engine: "5.5.3.20260724" },
      language: "eng",
      blocks: [
        { start: null, text: "no stamp at all" },
        { start: Number.NaN, text: "nan stamp" },
        { start: -3, text: "before the source starts" },
        { start: 7, text: "     " },
        { start: "8", text: "a string timestamp" },
        { start: 9.5, text: "Halcyon Grid total 4,180 units" },
      ],
    }), "eng");
    expect(got.observations.map((o) => o.text)).toEqual(["Halcyon Grid total 4,180 units"]);
    expect(got.readAt).toEqual([9.5]);
    // Five frames really were read; dropping an unusable ROW does not rewrite that.
    expect(got.recognised).toBe(5);
  });

  it("states the truncation on the row instead of silently shrinking it", () => {
    const got = interpretFrameOcr(ready(FRAME_OCR_CAPABILITY, {
      stage_counts: { planned: 1, decoded: 1, recognised: 1, glyph_free: 0, unresolved: 0, duplicates: 0 },
      ocr: { engine: "5.5.3.20260724" },
      language: "eng",
      blocks: [{ start: 3, end: 3, text: "transcript-sized frame dump ".repeat(400) }],
    }), "eng");
    expect(got.observations).toHaveLength(1);
    expect(got.observations[0].text).toHaveLength(FRAME_OCR_TEXT_CAP);
    expect(String(got.observations[0].provider)).toContain(`:truncated@${FRAME_OCR_TEXT_CAP}`);
  });

  it("bounds how many rows one video contributes, while the counts stay the worker's", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({ start: i + 0.5, end: i + 0.5, text: `slide line ${i}` }));
    const got = interpretFrameOcr(ready(FRAME_OCR_CAPABILITY, {
      stage_counts: { planned: 6, decoded: 6, recognised: 6, glyph_free: 0, unresolved: 0, duplicates: 0 },
      language: "eng",
      blocks,
    }), "eng", 2);
    expect(got.observations).toHaveLength(2);
    expect(got.readAt).toEqual([0.5, 1.5]);
    expect(got.recognised).toBe(6);
  });

  it("reports a glyph-free sample honestly: zero text rows, but an actual measurement", () => {
    const got = interpretFrameOcr(ready(FRAME_OCR_CAPABILITY, {
      stage_counts: { planned: 8, decoded: 8, recognised: 0, glyph_free: 8, unresolved: 0, duplicates: 0 },
      ocr: { engine: "5.5.3.20260724" },
      language: "eng",
      blocks: [],
    }), "eng");
    expect(got.state).toBe("ok");
    expect(got.observations).toEqual([]);
    expect(got.glyphFree).toBe(8);
    expect(got.engine).toBe("5.5.3.20260724");
  });

  it("names an unmeasured engine rather than a version it never saw", () => {
    const got = interpretFrameOcr(ready(FRAME_OCR_CAPABILITY, {
      stage_counts: { planned: 1, decoded: 1, recognised: 1, glyph_free: 0, unresolved: 0, duplicates: 0 },
      language: "eng",
      blocks: [{ start: 1, end: 1, text: "a slide title", language_code: "" }],
    }), "fra");
    expect(got.engine).toBe("");
    // No engine version, no `@`; the language falls back to the one REQUESTED.
    expect(got.observations[0].provider).toBe("tesseract/fra");
  });
});

// ------------------------------------------------- the production caller seam

const MP4_PROBE = [
  "Input #0, mov,mp4,m4a, from 'clip.mp4':",
  "  Duration: 00:01:00.00, start: 0.000000, bitrate: 800 kb/s",
  "  Stream #0:0[0x1](eng): Video: h264 (High), yuv420p, 1280x720, 25 fps, 25 tbr, 25k tbn",
  "  Stream #0:1[0x2](eng): Audio: aac (LC), 48000 Hz, stereo, fltp",
  "",
].join("\n");

describe("buildTimeline runs the frame reader through the job seam", () => {
  let workspace = "";
  let srcPath = "";
  let scratchRoot = "";

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ruke-frameocr-"));
    srcPath = path.join(workspace, "briefing.mp4");
    fs.writeFileSync(srcPath, Buffer.from("a slide-heavy briefing stand-in"));
    scratchRoot = path.join(workspace, "scratch");
  });
  afterAll(() => {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function stub(frames: MlJobEnvelope | null) {
    const record = { meta: { coverage: { units: "seconds", examined: [[0, 60]], skipped: [], total_source: 60, complete: true, note: "full scan" } } };
    const calls: Array<{ capability: string; payload: Record<string, unknown> }> = [];
    const runJob = async (capability: string, payload: Record<string, unknown>) => {
      calls.push({ capability, payload });
      if (capability === FRAME_OCR_CAPABILITY) return frames;
      if (capability === "video.scenes") {
        return ready("video.scenes", { cut_scan: { ok: true, cuts: [12.5, 30], scanned_seconds: 60, prefix_measured: true, truncated: false, threshold: 0.35 } });
      }
      return ready("video.timeline", { record, reply: "recorded" });
    };
    return { calls, runJob };
  }

  it("reads frames only when a language is configured, then records what it read", async () => {
    const { calls, runJob } = stub(ready(FRAME_OCR_CAPABILITY, goodPayload));
    const built = await buildTimeline({
      attId: "att_frameocr_ok", srcPath, probeText: MP4_PROBE, durationSec: 60,
      scratchRoot, runJob, frameLanguage: "eng",
    });
    expect(built).not.toBeNull();
    const b = built!;
    expect(calls.map((c) => c.capability)).toEqual([
      "video.timeline", "video.scenes", "video.timeline", FRAME_OCR_CAPABILITY, "video.timeline",
    ]);
    // The sampler is the backend's: the caller hands it the measured cuts and a
    // bound, and asks for a plan instead of inventing its own times.
    const frameCall = calls[3].payload;
    expect(frameCall).toMatchObject({
      language: "eng", plan: true, max_frames: FRAME_OCR_MAX_FRAMES, duration: 60,
      cuts: [12.5, 30],
    });
    expect(String(frameCall.path)).toBe(path.resolve(srcPath));
    expect(String(frameCall.root)).toBe(path.dirname(path.resolve(srcPath)));
    // The second observe is a separate stage, and its coverage says POINTS.
    const observe = calls[4].payload;
    expect(observe).toMatchObject({ op: "observe", stage: "frame-ocr" });
    const coverage = observe.coverage as Record<string, unknown>;
    expect(coverage.units).toBe("seconds");
    expect(coverage.complete).toBe(false);
    expect(coverage.examined).toEqual([[12.5, 12.5]]);
    expect(String(coverage.note)).toContain("point evidence");

    expect(b.summary.frameRead).toMatchObject({
      state: "ok_recorded", language: "eng", planned: 12, decoded: 9, recognised: 1,
      glyphFree: 6, unresolved: 2, engine: "5.5.3.20260724",
    });
    expect(b.summary.frameRead.readAt).toEqual([12.5]);
    // The slide text joins the published observations with its timestamp intact.
    const ocrRow = b.observations.find((o) => o.kind === "ocr");
    expect(ocrRow).toMatchObject({ start: 12.5, text: "Halcyon Grid quarterly results" });

    // ...and that timestamp survives into the arguments a search tool is given.
    // (The store's index shape: the observations live on `meta`.)
    const index = {
      meta: {
        attId: "att_frameocr_ok", name: "briefing.mp4", category: "video", createdAt: 1,
        chunkCount: 1, spine: "", spineBlocks: [], frames: [],
        observations: b.observations as IndexMeta["observations"],
      } as unknown as IndexMeta,
      chunks: [{ i: 0, startSec: 12.5, endSec: 20, text: "slide text stand-in", vec: [] }],
    };
    const hints = buildMediaHints(index, 12);
    const textHints = hints.filter((h) => h.kind === "visible_text");
    expect(textHints.some((h) => h.value.includes("Halcyon Grid quarterly results"))).toBe(true);
    expect(textHints.every((h) => h.startSec !== null)).toBe(true);
    expect(mediaHintQueries(hints, 6).some((q) => q.includes("Halcyon Grid quarterly results"))).toBe(true);
  });

  it("does not run the recogniser without a language, and says which switch is missing", async () => {
    const { calls, runJob } = stub(ready(FRAME_OCR_CAPABILITY, goodPayload));
    const built = await buildTimeline({
      attId: "att_frameocr_nolang", srcPath, probeText: MP4_PROBE, durationSec: 60,
      scratchRoot, runJob, frameLanguage: "",
    });
    expect(built).not.toBeNull();
    const b = built!;
    // Guessing a language is how non-Latin slides come back as Latin noise, so the
    // stage must not run at all.
    expect(calls.some((c) => c.capability === FRAME_OCR_CAPABILITY)).toBe(false);
    expect(b.summary.frameRead.state).toBe("no_language");
    expect(b.summary.frameRead.reason).toContain(FRAME_OCR_LANGUAGE_ENV);
    expect(b.observations.every((o) => o.kind !== "ocr")).toBe(true);
    // The baseline (streams, duration, scene anchors) is still true evidence.
    expect(b.summary.sceneScan.state).toBe("ok_recorded");
  });

  it("keeps a failed frame read out of the record without invalidating the baseline", async () => {
    const { calls, runJob } = stub(failed(FRAME_OCR_CAPABILITY, "not_ready", "no eng.traineddata in .data/tools/tesseract/tessdata"));
    const built = await buildTimeline({
      attId: "att_frameocr_fail", srcPath, probeText: MP4_PROBE, durationSec: 60,
      scratchRoot, runJob, frameLanguage: "eng",
    });
    expect(built).not.toBeNull();
    const b = built!;
    expect(b.summary.frameRead.state).toBe("failed");
    expect(b.summary.frameRead.reason).toContain("eng.traineddata");
    // No evidence, so no second observe and no ocr row in the observations.
    expect(calls.map((c) => c.capability)).toEqual(["video.timeline", "video.scenes", "video.timeline", FRAME_OCR_CAPABILITY]);
    expect(b.observations.every((o) => o.kind !== "ocr")).toBe(true);
    expect(b.summary.sceneScan.state).toBe("ok_recorded");
  });

  it("records not_configured when this deployment has no frame-OCR route", async () => {
    const { calls, runJob } = stub(null);
    const built = await buildTimeline({
      attId: "att_frameocr_noroute", srcPath, probeText: MP4_PROBE, durationSec: 60,
      scratchRoot, runJob, frameLanguage: "eng",
    });
    expect(built).not.toBeNull();
    const b = built!;
    expect(b.summary.frameRead.state).toBe("not_configured");
    expect(b.summary.frameRead.recognised).toBe(0);
    expect(calls.map((c) => c.capability)).toEqual(["video.timeline", "video.scenes", "video.timeline", FRAME_OCR_CAPABILITY]);
  });

  it("keeps an all-unresolved sample as an unresolved sample, not as no text on screen", async () => {
    const { calls, runJob } = stub(ready(FRAME_OCR_CAPABILITY, {
      stage_counts: { planned: 4, decoded: 4, recognised: 0, glyph_free: 0, unresolved: 4, duplicates: 0 },
      ocr: { engine: "5.5.3.20260724" },
      language: "eng",
      blocks: [],
    }));
    const built = await buildTimeline({
      attId: "att_frameocr_unresolved", srcPath, probeText: MP4_PROBE, durationSec: 60,
      scratchRoot, runJob, frameLanguage: "eng",
    });
    expect(built).not.toBeNull();
    const b = built!;
    // Zero text AND zero glyph-free frames proves nothing, so nothing is recorded
    // as an observation and no observe call is made.
    expect(b.summary.frameRead.state).toBe("ok");
    expect(b.summary.frameRead.unresolved).toBe(4);
    expect(calls.some((c) => c.capability === FRAME_OCR_CAPABILITY)).toBe(true);
    expect(calls.filter((c) => (c.payload as Record<string, unknown>).stage === "frame-ocr")).toEqual([]);
    // `readFrames: false` is the operator's off switch, and it names itself.
    const off = await buildTimeline({
      attId: "att_frameocr_off", srcPath, probeText: MP4_PROBE, durationSec: 60,
      scratchRoot, runJob: stub(null).runJob, frameLanguage: "eng", readFrames: false,
    });
    expect(off!.summary.frameRead.state).toBe("not_attempted");
  });
});
