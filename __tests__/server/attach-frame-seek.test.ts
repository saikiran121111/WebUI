/**
 * F153 item 4 (2026-11-25) — a time-range follow-up over VIDEO reaches the
 * PICTURE at the asked instant.
 *
 * The law under test: "What was on screen at 2:10?" over a recording whose
 * saved keyframes do not reach that instant must get the frame itself
 * (a bounded on-demand decode of the ORIGINAL, pixels in the SAME turn), a
 * MEASURED on-screen reading, or an honest named failure — never the golden
 * sentence "never captured" while the original sits on disk. The delivered
 * frame is durable (a saved frame + recognised text as a timed chunk), so the
 * next follow-up answers from the record and never re-decodes that instant.
 * Every seam here is a fake capability provider against an isolated store —
 * the live matrix rides item 6's exclusive run.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

// One small pick per turn: the seek's lines are the ONLY evidence for the
// asked moment — no "the whole record fit in the budget" shortcuts.
// The F17 law needs the language UNSET for the pixels-only rows.
vi.hoisted(() => {
  process.env.ATTACH_TURN_BUDGET_CHARS = "200";
  // FRAME_OCR_LANGUAGE_ENV === DOCUMENT_OCR_LANGUAGE_ENV (timeline.ts:92).
  delete process.env.RUKE_DOCUMENT_OCR_LANGUAGE;
});

// embedOne ships a non-empty vector so the on-screen words persist durably;
// retrieval itself stays lexical (empty question vectors), as in the pairing
// law spec.
vi.mock("@/lib/server/attachindex/embed", () => ({
  embedOne: async () => [0.5, 0.25],
  embedTexts: async (texts: string[]) => texts.map(() => []),
}));

import fs from "node:fs";
import path from "node:path";

import { buildAttachmentTurn } from "@/lib/server/attachindex/turn";
import {
  indexDir, readIndex, removeIndex, removeUpload, storeUpload, writeIndex,
} from "@/lib/server/attachindex/store";
import { makeFrameSeeker } from "@/lib/server/attachindex/frame-seek";
import { FRAME_OCR_CAPABILITY } from "@/lib/server/attachindex/timeline";
import type { MlJobEnvelope, MlJobOptions } from "@/lib/server/ml-job";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

// A real 1x1 PNG — the durable-frame law reads the bytes back from disk.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const scratchDirs: string[] = [];
/** Seed a video index: one timed passage FAR from the asked cue (so the
 *  time-range retrieval for "at 2:10" comes up EMPTY — the reproduced
 *  failure state) with NO saved frames, plus the durable upload the seek
 *  decodes from. */
function seed(
  att: string, dur: number, withUpload = true,
  frames: IndexMeta["frames"] = [],
  // The publish law: meta-named keyframes must be on disk in the index dir
  // BEFORE writeIndex (the generation MOVES them in), as production does.
  frameFiles: Array<{ file: string; bytes: Buffer }> = [],
): void {
  removeIndex(att);
  const chunks: IndexChunk[] = [
    { i: 0, startSec: 3300, endSec: 3600, vec: [], text: "### 00:55:00 far-away narration, no help for 2:10." },
  ];
  const meta: IndexMeta = {
    attId: att, name: "clip.mp4", category: "video", createdAt: 0,
    chunkCount: chunks.length, spine: "", spineBlocks: [], frames, durationSec: dur,
  };
  if (frameFiles.length) {
    fs.mkdirSync(path.join(indexDir(att), "frames"), { recursive: true });
    for (const ff of frameFiles) fs.writeFileSync(path.join(indexDir(att), "frames", ff.file), ff.bytes);
  }
  writeIndex(att, meta, chunks, chunks.map(c => c.text).join("\n"));
  if (withUpload) {
    const dir2 = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "fs_"));
    scratchDirs.push(dir2);
    fs.writeFileSync(path.join(dir2, "clip.mp4"), Buffer.from("mp4 bytes — the seek decodes the original"));
    storeUpload(path.join(dir2, "clip.mp4"), att, "mp4");
  }
}
function unseed(att: string): void {
  removeIndex(att);
  removeUpload(att);
}
afterAll(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

function env(over: Partial<MlJobEnvelope> = {}): MlJobEnvelope {
  return {
    state: "ready", capability: FRAME_OCR_CAPABILITY, job_id: "j1", run_id: "r1",
    request_id: "q1", deadline_s: 90, source: "fake", ...over,
  };
}
/** Frame rows shaped exactly like the worker's FrameReading.to_dict. */
const frameRow = (time_s: number, state: string, over: Record<string, unknown> = {}) => ({
  time_s, state, detail: "", confidence: 0, lines: [], width: 1, height: 1,
  frame_digest: "d" + time_s, engine: state === "recognised" ? "tesseract-ocr" : "",
  language_code: "", copy_of_time: null, provenance: "decoded", timebase: "media",
  image_b64: PNG.toString("base64"), ...over,
});
const readyFrames = (...rows: unknown[]) =>
  env({ result: { frames: rows, ocr: { engine: "tesseract-ocr", text_pass: true }, note: "fake" } });

/** Records every capability call and pops the scripted envelope. */
function scriptedRunJob(
  calls: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[],
  ...envelopes: (MlJobEnvelope | null)[]
) {
  return async (
    capability: string,
    payload: Record<string, unknown>,
    opts?: MlJobOptions,
  ): Promise<MlJobEnvelope | null> => {
    calls.push({ capability, payload, opts });
    if (!envelopes.length) throw new Error("seam called more times than scripted");
    return envelopes.shift()!;
  };
}

const ask = (q: string, att: string): any[] => [{
  role: "user",
  content: [
    { type: "text", text: q },
    { type: "attachment_ref", att_id: att, name: "clip.mp4", category: "video" },
  ],
}];
const sysText = (msgs: any[]) => msgs.filter(m => m.role === "system").map(m => String(m.content)).join("\n");

describe("time-range follow-up over video: on-demand frame seek of the original (F153 item 4)", () => {
  const Q = "what was on screen at 2:10?";

  describe("the seek delivers the picture, durably", () => {
    const ATT = "att_seek1";
    const calls: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
    const seeker = makeFrameSeeker({
      runJob: scriptedRunJob(calls, readyFrames(frameRow(130, "pixels"))),
    });
    afterAll(() => unseed(ATT));

    it("the SAME turn decodes the asked instant of the ORIGINAL and ships its pixels", async () => {
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, undefined, seeker);
      expect(blocks).toBe(1);

      // Invocation proof: EXACTLY one capability call — the asked instant,
      // pixels requested, the original upload path, never a re-digest.
      expect(calls.length).toBe(1);
      expect(calls[0].capability).toBe(FRAME_OCR_CAPABILITY);
      expect(calls[0].payload.times).toEqual([130]);
      expect(calls[0].payload.max_frames).toBe(1);
      expect(calls[0].payload.include_image).toBe(true);
      expect(calls[0].payload.language).toBe(""); // F17: never defaulted — pixels-only is legal
      expect(String(calls[0].payload.path)).toContain(`att_seek1.mp4`); // the durable upload, by its stored name

      // The frame rides THIS turn: its pixels as a PNG data URL, its line
      // naming what ran and what the picture can and cannot prove.
      const sys = sysText(msgs);
      expect(sys).toContain("the seek decoded the frame at 00:02:10 from the original recording");
      expect(sys).toContain("on-screen text was NOT read");
      expect(JSON.stringify(msgs)).toContain("data:image/png;base64,");

      // The marker counts the seek's frame as part of the record (invocation
      // proof in the coverage line, not a silent extra).
      expect(sys).toContain("1 of 1 saved keyframes shown");

      // Durable: the PNG is a saved frame at its real timestamp.
      const loaded = readIndex(ATT)!;
      expect(loaded.meta.frames).toEqual([{ at: 130, file: "frames/s_00000.png", state: "pixels" }]);
      expect(fs.readFileSync(path.join(indexDir(ATT), "frames/s_00000.png"))).toEqual(PNG);
    });

    it("the next turn answers from the record: golden saved-moment block, PNG mime, ZERO re-seeks", async () => {
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q); // NO seam wired — the goldens
      expect(blocks).toBe(1);
      expect(calls.length).toBe(1); // no new capability call
      const sys = sysText(msgs);
      expect(sys).toContain("the saved moment nearest 00:02:10 is at 00:02:10");
      expect(sys).not.toContain("visual seek");
      expect(JSON.stringify(msgs)).toContain("data:image/png;base64,"); // nearestFrames serves PNG by extension
    });

    it("recognised on-screen text becomes a timed searchable chunk", async () => {
      const ATT2 = "att_seek1b";
      const calls2: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
      const seeker2 = makeFrameSeeker({
        runJob: scriptedRunJob(calls2, readyFrames(frameRow(130, "recognised", { text: "SALE ENDS FRIDAY", confidence: 0.91 }))),
      });
      seed(ATT2, 3600);
      const msgs = ask(Q, ATT2);
      expect(await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, undefined, seeker2)).toBe(1);
      const sys = sysText(msgs);
      expect(sys).toContain('the recogniser read this on-screen text: "SALE ENDS FRIDAY"');
      expect(sys).toContain("recogniser tesseract-ocr");
      const loaded = readIndex(ATT2)!;
      const fresh = loaded.chunks.find(c => c.startSec === 130);
      expect(fresh).toBeTruthy();
      expect(fresh!.text).toContain("[on-screen text decoded at 00:02:10 by on-demand visual seek]");
      expect(fresh!.text).toContain("SALE ENDS FRIDAY");
      expect(fresh!.vec.length).toBeGreaterThan(0);
      unseed(ATT2);
    });

    it("a configured language rides the request (frameLanguage seam)", async () => {
      const ATT3 = "att_seek1c";
      const calls3: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
      const seeker3 = makeFrameSeeker({
        runJob: scriptedRunJob(calls3, readyFrames(frameRow(130, "recognised", { text: "label" }))),
        frameLanguage: "eng",
      });
      seed(ATT3, 3600);
      await seeker3(ATT3, readIndex(ATT3)!, [130]);
      expect(calls3[0].payload.language).toBe("eng");
      unseed(ATT3);
    });
  });

  describe("every failure names its kind and claims nothing durable", () => {
    it("no capability route: the deployment sentence, golden cue line, NO frame saved", async () => {
      const ATT = "att_seek2";
      const calls: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
      const seeker = makeFrameSeeker({ runJob: scriptedRunJob(calls, null) });
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, undefined, seeker);
      expect(blocks).toBe(1); // the golden "never captured" line rides WITH the named failure
      const sys = sysText(msgs);
      expect(sys).toContain("NO saved moment lies within this turn's time window");
      expect(sys).toContain("no capability route");
      expect(sys).not.toContain("saved keyframes shown"); // zero frames: the marker says zero
      expect(readIndex(ATT)!.meta.frames).toEqual([]);
      unseed(ATT);
    });

    it("backend refusal: the worker's own reason, retryability, and no durable claim", async () => {
      const ATT = "att_seek3";
      const calls4: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
      const seeker = makeFrameSeeker({
        runJob: scriptedRunJob(calls4, env({
          state: "unavailable", result: null,
          error: { reason: "gpu_refused", message: "GPU busy", retryable: true, capability: FRAME_OCR_CAPABILITY, human_step: "" },
        })),
      });
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      expect(await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, undefined, seeker)).toBe(1);
      const sys = sysText(msgs);
      expect(sys).toContain("gpu_refused: GPU busy — this is retryable: ask again");
      expect(readIndex(ATT)!.meta.frames).toEqual([]);
      unseed(ATT);
    });

    it("contract_mismatch: success with no per-frame records credits nothing", async () => {
      const ATT = "att_seek4";
      const calls: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
      const seeker = makeFrameSeeker({ runJob: scriptedRunJob(calls, env({ result: { note: "fake" } })) });
      seed(ATT, 3600);
      const out = await seeker(ATT, readIndex(ATT)!, [130]);
      expect(out.images).toEqual([]);
      expect(out.durable).toBe(0);
      expect(out.lines.join("\n")).toContain("contract_mismatch");
      expect(readIndex(ATT)!.meta.frames).toEqual([]);
      unseed(ATT);
    });

    it("decode failure at the instant: named per-instant, retryable, nothing saved", async () => {
      const ATT = "att_seek5";
      const calls: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
      const seeker = makeFrameSeeker({
        runJob: scriptedRunJob(calls, readyFrames(frameRow(130, "frame_failed", { image_b64: null, detail: "seek past last packet" }))),
      });
      seed(ATT, 3600);
      const out = await seeker(ATT, readIndex(ATT)!, [130]);
      expect(out.lines.join("\n")).toContain("the frame at 00:02:10 was not decoded (frame_failed: seek past last packet)");
      expect(out.lines.join("\n")).toContain("this is retryable: ask again");
      expect(out.durable).toBe(0);
      expect(readIndex(ATT)!.meta.frames).toEqual([]);
      unseed(ATT);
    });

    it("pixels over the transport bound: the omission is named, the instant is NOT claimed durable", async () => {
      const ATT = "att_seek6";
      const calls: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
      const seeker = makeFrameSeeker({
        runJob: scriptedRunJob(calls, readyFrames(
          frameRow(130, "pixels", { image_b64: null, detail: "pixels omitted: 4.1 MB over the transport bound" }),
        )),
      });
      seed(ATT, 3600);
      const out = await seeker(ATT, readIndex(ATT)!, [130]);
      expect(out.images).toEqual([]);
      expect(out.lines.join("\n")).toContain("pixels were not delivered (pixels omitted: 4.1 MB over the transport bound)");
      expect(out.lines.join("\n")).toContain("stays unviewed; this is retryable: ask again");
      expect(out.durable).toBe(0);
      expect(readIndex(ATT)!.meta.frames).toEqual([]);
      unseed(ATT);
    });

    it("original gone: the on-disk sentence, and the capability never runs", async () => {
      const ATT = "att_seek7";
      const calls: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
      const seeker = makeFrameSeeker({ runJob: scriptedRunJob(calls) });
      seed(ATT, 3600, false);
      const out = await seeker(ATT, readIndex(ATT)!, [130]);
      expect(calls.length).toBe(0);
      expect(out.lines.join("\n")).toContain("the original recording is no longer on disk");
      unseed(ATT);
    });

    it("a throwing transport: the call failure is named with its message, retryable", async () => {
      const ATT = "att_seek8";
      const seeker = makeFrameSeeker({
        runJob: async () => { throw new Error("worker pipe closed"); },
      });
      seed(ATT, 3600);
      const out = await seeker(ATT, readIndex(ATT)!, [130]);
      expect(out.lines.join("\n")).toContain("the decode call itself failed (worker pipe closed)");
      expect(readIndex(ATT)!.meta.frames).toEqual([]);
      unseed(ATT);
    });
  });

  describe("cancellation writes nothing durable", () => {
    it("cancelled before the decode: named, zero calls", async () => {
      const ATT = "att_seek9";
      const calls: { capability: string; payload: Record<string, unknown>; opts?: MlJobOptions }[] = [];
      const seeker = makeFrameSeeker({ runJob: scriptedRunJob(calls) });
      seed(ATT, 3600);
      const controller = new AbortController();
      controller.abort();
      const out = await seeker(ATT, readIndex(ATT)!, [130], controller.signal);
      expect(calls.length).toBe(0);
      expect(out.lines.join("\n")).toContain("cancelled before any frame was decoded");
      unseed(ATT);
    });

    it("cancelled mid-seek: decoded frames are NOT saved, the words are NOT appended", async () => {
      const ATT = "att_seek10";
      const controller = new AbortController();
      const seeker = makeFrameSeeker({
        runJob: async () => {
          const out = readyFrames(frameRow(130, "recognised", { text: "HALF-READ" }));
          controller.abort(); // the user stopped the turn while the frame decoded
          return out;
        },
      });
      seed(ATT, 3600);
      const out = await seeker(ATT, readIndex(ATT)!, [130], controller.signal);
      expect(out.images).toEqual([]);
      expect(out.durable).toBe(0);
      expect(out.lines.join("\n")).toContain("were not saved");
      const loaded = readIndex(ATT)!;
      expect(loaded.meta.frames).toEqual([]);
      expect(loaded.chunks.length).toBe(1); // the seed chunk only — no torn passage
      unseed(ATT);
    });
  });

  describe("the golden path stays byte-identical", () => {
    it("saved frames with NO seam: the golden saved-moment block, no seek wording", async () => {
      const ATT = "att_seek11";
      seed(ATT, 3600, true, [{ at: 130, file: "frames/f_00000.jpg", state: "recognised" }],
        [{ file: "f_00000.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }]);
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q);
      expect(blocks).toBe(1);
      const sys = sysText(msgs);
      expect(sys).toContain("the saved moment nearest 00:02:10 is at 00:02:10");
      expect(sys).not.toContain("visual seek");
      expect(JSON.stringify(msgs)).toContain("data:image/jpeg;base64,"); // jpeg keyframe stays jpeg
      unseed(ATT);
    });

    it("frames too far from the cue with NO seam: NO block, exactly as before", async () => {
      const ATT = "att_seek12";
      seed(ATT, 3600, true, [{ at: 3300, file: "frames/f_00000.jpg", state: "recognised" }],
        [{ file: "f_00000.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }]);
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q);
      expect(blocks).toBe(0);
      unseed(ATT);
    });

    it("no frames and NO seam: NO block (the opt-in seam law)", async () => {
      const ATT = "att_seek13";
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q);
      expect(blocks).toBe(0);
      unseed(ATT);
    });
  });
});
