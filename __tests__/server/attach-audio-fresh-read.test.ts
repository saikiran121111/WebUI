/**
 * F153 item 3 — a time-range follow-up reaches the WHOLE recording.
 *
 * The law under test: "What did she say around 58:40?" over audio whose saved
 * transcript carries no passage for that window must get an ANSWER (a bounded
 * fresh decode of the ORIGINAL, served in the SAME turn), a MEASURED fact (a
 * fully-decoded recording's timed gap is an absence the engine listened to),
 * or an honest failure that names its kind — never silence, and never a
 * re-digest of the whole file. The fresh decode is durable: the timed passage
 * becomes a searchable chunk and the window joins meta.speech.examined, so
 * the next follow-up CONTINUES at the boundary (no gap, no double decode).
 * Every seam here is a fake provider against an isolated store — the live
 * matrix rides item 6's exclusive run.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

// One 200-char pick per turn: the fresh decode is the ONLY evidence for the
// asked window — no "the whole transcript fit in the budget" shortcuts.
vi.hoisted(() => {
  process.env.ATTACH_TURN_BUDGET_CHARS = "200";
});

// embedOne ships a non-empty vector so the fresh passage persists durably;
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
import {
  makeFreshAsrReader, planFreshWindows, subtractSpans, windowForCue, type TranscribeSeam,
} from "@/lib/server/attachindex/audio-reread";
import type { AsrOutcome, CapabilityAsr, SpeechCapabilityOptions } from "@/lib/server/extract/speech-capability";
import type { IndexChunk, IndexMeta, LoadedIndex } from "@/lib/server/attachindex/types";

const FACT = "she names the closing sponsor VOLTAGE-240";

/** Seed an audio index: one timed chunk far from the asked window, so the
 *  time-range retrieval for "around 58:40" comes up EMPTY (the reproduced
 *  failure state), plus the durable upload the fresh decode reads from. */
const scratchDirs: string[] = [];
function seed(att: string, dur: number, withUpload = true, speech?: IndexMeta["speech"]): void {
  removeIndex(att);
  const chunks: IndexChunk[] = [
    { i: 0, startSec: 300, endSec: 600, vec: [], text: "### 00:05:00 the hosts greet the audience and open the show." },
  ];
  const meta: IndexMeta = {
    attId: att, name: "podcast.mp3", category: "audio", createdAt: 0,
    chunkCount: 1, spine: "", spineBlocks: [], frames: [], durationSec: dur,
    ...(speech ? { speech } : {}),
  };
  writeIndex(att, meta, chunks, chunks.map(c => c.text).join("\n"));
  if (withUpload) {
    const dir2 = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "fr_"));
    scratchDirs.push(dir2);
    fs.writeFileSync(path.join(dir2, "podcast.mp3"), Buffer.from("mp3 bytes — the fresh decode reads the original"));
    storeUpload(path.join(dir2, "podcast.mp3"), att, "mp3");
  }
}
function unseed(att: string): void {
  removeIndex(att);
  removeUpload(att);
}
afterAll(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Every CapabilityAsr field filled — a fake worker payload, not a shortcut. */
function asrBase(over: Partial<CapabilityAsr> = {}): CapabilityAsr {
  return {
    state: "transcribed", text: "", segments: [], segmentCount: 0, droppedSegments: 0,
    cappedSegments: 0, fullTranscriptText: "", allSegments: [], language: "en",
    languageSource: "model", languageProbability: 1, model: "parakeet", device: "cuda",
    computeType: "gpu", durationSec: 0, complete: true, asrRan: true, note: "",
    examined: [], unexamined: [], audioLevel: {}, probe: {}, routing: {},
    vadFilter: false, vadState: "", supersededFragments: 0, superseded: [],
    truncatedSegments: 0, cacheState: "", cacheSpan: [],
    recognition: { engine: "", device: "", startedAt: "", finishedAt: "", wallS: null }, ...over,
  };
}
function ready(over: Partial<CapabilityAsr> = {}): AsrOutcome {
  return { state: "ready", asr: asrBase(over) };
}

/** A seam that records every invocation (src + span) and pops the scripted outcome. */
function scriptedSeam(calls: { src: string; opts: SpeechCapabilityOptions }[], ...outcomes: AsrOutcome[]): TranscribeSeam {
  return async (src, opts) => {
    calls.push({ src, opts });
    const out = outcomes.shift();
    if (!out) throw new Error("seam called more times than scripted");
    return out;
  };
}

const ask = (q: string, att: string): any[] => [{
  role: "user",
  content: [
    { type: "text", text: q },
    { type: "attachment_ref", att_id: att, name: "podcast.mp3", category: "audio" },
  ],
}];
const sysText = (msgs: any[]) => msgs.filter(m => m.role === "system").map(m => String(m.content)).join("\n");

describe("time-range follow-up over audio: bounded fresh reads of the original (F153 item 3)", () => {
  const Q = "what did she say around 58:40?";

  describe("fresh decode of an unexamined window", () => {
    const ATT = "att_fresh1";
    const calls: { src: string; opts: SpeechCapabilityOptions }[] = [];
    const reader = makeFreshAsrReader({
      transcribe: scriptedSeam(calls, ready({
        text: FACT,
        segments: [{ start: 3541, end: 3547, text: FACT }],
        segmentCount: 1,
      })),
    });
    afterAll(() => unseed(ATT));

    it("the SAME turn decodes the cue window of the ORIGINAL, bounded by the router geometry", async () => {
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, reader);
      expect(blocks).toBe(1);

      // Invocation proof: EXACTLY one bounded decode — the cue window
      // [58:40±180 s] clipped to the 3600 s duration, through the original
      // upload, never the whole file.
      expect(calls.length).toBe(1);
      expect(calls[0].opts.startSec).toBe(3340);
      expect(calls[0].opts.endSec).toBe(3600);
      expect(calls[0].src).toContain(ATT);

      // The recovered fact rides THIS turn's evidence block with its real
      // timestamps, the cue it answers, and the engine that produced it.
      const sys = sysText(msgs);
      expect(sys).toContain("ran ONE bounded decode of the original");
      expect(sys).toContain("fresh decode of 00:55:40–01:00:00 around 00:58:40");
      expect(sys).toContain("[00:59:01 - 00:59:07] " + FACT);
      expect(sys).toContain("parakeet on cuda");

      // Durable continuation: the passage is a searchable timed chunk and
      // the window joined meta.speech.examined (the rest stays unexamined).
      const loaded = readIndex(ATT)!;
      expect(loaded.chunks.length).toBe(2);
      const fresh = loaded.chunks[1];
      expect(fresh.startSec).toBe(3340);
      expect(fresh.endSec).toBe(3600);
      expect(fresh.text).toContain(FACT);
      expect(fresh.vec.length).toBeGreaterThan(0);
      expect(loaded.meta.speech).toEqual({
        durationSec: 3600,
        examined: [[3340, 3600]],
        unexamined: [[0, 3340]],
        complete: false,
      });
    });

    it("a second ask on the covered window runs ZERO decodes — retrieval serves the fresh passage", async () => {
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, reader);
      expect(blocks).toBe(1);
      expect(calls.length).toBe(1); // no new seam call — the record is the authority
      // Continuation through the searchable record: the durable fresh
      // passage IS this turn's retrieved evidence, like every other chunk.
      expect(sysText(msgs)).toContain(FACT);
      const loaded = readIndex(ATT)!;
      expect(loaded.chunks.length).toBe(2); // nothing re-appended
    });

    it("a covered window with no chunk (coverage from the record) answers with the covers line, zero decodes", async () => {
      const ATT2 = "att_fresh1b";
      const calls2: { src: string; opts: SpeechCapabilityOptions }[] = [];
      const reader2 = makeFreshAsrReader({ transcribe: scriptedSeam(calls2) });
      seed(ATT2, 3600, true, {
        durationSec: 3600, complete: false, examined: [[3340, 3600]], unexamined: [[0, 3340]],
      });
      const fresh = await reader2(ATT2, readIndex(ATT2)!, [3520]);
      expect(calls2.length).toBe(0);
      // Partial decode: the window sits in the examined span, so the
      // absence is MEASURED — and the wording says what really covers it,
      // never claiming an end-to-end decode that never happened.
      const line = fresh.lines.join("\n");
      expect(line).toContain("this window lies inside the span the record has already decoded");
      expect(line).toContain("MEASURED, not an unexamined gap");
      expect(line).not.toContain("decoded end-to-end");
      unseed(ATT2);
    });
  });

  describe("adjacent follow-ups continue across the boundary", () => {
    const ATT = "att_fresh2";
    const calls: { src: string; opts: SpeechCapabilityOptions }[] = [];
    const reader = makeFreshAsrReader({
      transcribe: scriptedSeam(
        calls,
        ready({ text: "first fact", segments: [{ start: 3400, end: 3410, text: "first fact" }], segmentCount: 1 }),
        ready({ text: "second fact", segments: [{ start: 3800, end: 3810, text: "second fact" }], segmentCount: 1 }),
      ),
    });
    afterAll(() => unseed(ATT));

    it("the next cue's decode starts exactly where the last one ended", async () => {
      seed(ATT, 4200);
      await buildAttachmentTurn(ask(Q, ATT), 0, Q, undefined, undefined, undefined, undefined, reader);
      expect(calls[0].opts.startSec).toBe(3340);
      expect(calls[0].opts.endSec).toBe(3700);

      // The next cue's routed window [3880,4200] holds NO saved passage
      // (the fresh chunk ends at 3700), so the seam runs again: the record's
      // examined coverage extends past the first window, and the ask
      // continues beyond the covered edge — no re-digest of [3340,3700].
      await buildAttachmentTurn(ask("and around 1:07:40?", ATT), 0, "and around 1:07:40?", undefined, undefined, undefined, undefined, reader);
      expect(calls.length).toBe(2);
      expect(calls[1].opts.startSec).toBe(3880);
      expect(calls[1].opts.endSec).toBe(4200); // clipped to the duration
      const loaded = readIndex(ATT)!;
      expect(loaded.meta.speech!.examined).toEqual([[3340, 3700], [3880, 4200]]);
      expect(loaded.meta.speech!.unexamined).toEqual([[0, 3340], [3700, 3880]]);
      expect(loaded.chunks.length).toBe(3);
    });
  });

  describe("the record decides; the engine runs only where it never listened", () => {
    it("a fully-decoded recording answers a timed gap as MEASURED absence — zero decodes", async () => {
      const ATT = "att_fresh3";
      const calls: { src: string; opts: SpeechCapabilityOptions }[] = [];
      const reader = makeFreshAsrReader({ transcribe: scriptedSeam(calls) });
      seed(ATT, 3600, true, {
        durationSec: 3600, complete: true, examined: [[0, 600]], unexamined: [[600, 3600]],
      });
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, reader);
      expect(blocks).toBe(1);
      expect(calls.length).toBe(0);
      const sys = sysText(msgs);
      expect(sys).toContain("decoded end-to-end");
      expect(sys).toContain("MEASURED, not an unexamined gap");
      unseed(ATT);
    });

    it("a measured-silent window persists as examined: the silence is durable, no chunk needed", async () => {
      const ATT = "att_fresh4";
      const calls: { src: string; opts: SpeechCapabilityOptions }[] = [];
      const reader = makeFreshAsrReader({
        transcribe: scriptedSeam(calls, {
          state: "silence",
          asr: { ...asrBase(), state: "silence", audioLevel: { max_volume_db: -95.2 } },
        }),
      });
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, reader);
      expect(calls.length).toBe(1);
      const sys = sysText(msgs);
      expect(sys).toContain("-95.2 dBFS peak");
      expect(sys).toContain("MEASURED fact, not an unexamined gap");
      const loaded = readIndex(ATT)!;
      expect(loaded.chunks.length).toBe(1); // silence adds coverage, not a passage
      expect(loaded.meta.speech!.examined).toEqual([[3340, 3600]]);
      unseed(ATT);
    });
  });

  describe("every failure names its kind", () => {
    it("GPU refusal: the worker's own reason, retryable, and NO durable claim", async () => {
      const ATT = "att_fresh5";
      const calls: { src: string; opts: SpeechCapabilityOptions }[] = [];
      const reader = makeFreshAsrReader({
        transcribe: scriptedSeam(calls, {
          state: "unavailable", reason: "gpu_refused", message: "GPU busy",
          humanStep: "", retryable: true, structural: false,
        }),
      });
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, reader);
      const sys = sysText(msgs);
      expect(sys).toContain("reason gpu_refused (GPU busy)");
      expect(sys).toContain("this is retryable: ask again");
      const loaded = readIndex(ATT)!;
      expect(loaded.chunks.length).toBe(1);
      expect(loaded.meta.speech).toBeUndefined(); // a failed read claims nothing
      unseed(ATT);
    });

    it("no backend at all: the deployment sentence, no engine blamed", async () => {
      const ATT = "att_fresh6";
      const calls: { src: string; opts: SpeechCapabilityOptions }[] = [];
      const reader = makeFreshAsrReader({ transcribe: scriptedSeam(calls, { state: "none" }) });
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, reader);
      expect(calls.length).toBe(1);
      expect(sysText(msgs)).toContain("no speech backend is configured in this deployment");
      unseed(ATT);
    });

    it("original gone: the on-disk sentence, and the seam never runs", async () => {
      const ATT = "att_fresh7";
      const calls: { src: string; opts: SpeechCapabilityOptions }[] = [];
      const reader = makeFreshAsrReader({ transcribe: scriptedSeam(calls) });
      seed(ATT, 3600, false);
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, reader);
      expect(blocks).toBe(1);
      expect(calls.length).toBe(0);
      expect(sysText(msgs)).toContain("the original recording is no longer on disk");
      unseed(ATT);
    });

    it("a throwing seam: the window stays unexamined and says so, retryable", async () => {
      const ATT = "att_fresh8";
      const reader = makeFreshAsrReader({
        transcribe: async () => { throw new Error("worker pipe closed"); },
      });
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, undefined, reader);
      expect(blocks).toBe(1);
      const sys = sysText(msgs);
      expect(sys).toContain("the decode call itself failed (worker pipe closed)");
      expect(sys).toContain("the window stays unexamined");
      const loaded = readIndex(ATT)!;
      expect(loaded.meta.speech).toBeUndefined();
      unseed(ATT);
    });
  });

  describe("the pure plan (window geometry, adjacency)", () => {
    const idx = (dur: number, speech?: IndexMeta["speech"], chunks: IndexChunk[] = []): LoadedIndex =>
      ({ meta: { durationSec: dur, ...(speech ? { speech } : {}) } as IndexMeta, chunks });

    it("the cue window is the router's ±180 s clipped to the duration", () => {
      expect(windowForCue(3520, 3600)).toEqual([3340, 3600]);
      expect(windowForCue(45, 3600)).toEqual([0, 225]);
      expect(windowForCue(3540, 3600)).toEqual([3360, 3600]);
      // A cue past the recording's end has NO window — nothing to decode.
      expect(windowForCue(5940, 3600)).toBeNull();
      // A clip shorter than the window is covered whole.
      expect(windowForCue(10, 15)).toEqual([0, 15]);
    });

    it("subtraction is exact at the edges — adjacency leaves no gap and no overlap", () => {
      expect(subtractSpans([100, 200], [[150, 250]])).toEqual([[100, 150]]);
      expect(subtractSpans([100, 200], [[100, 200]])).toEqual([]);
      expect(subtractSpans([100, 200], [[100, 150], [150, 200]])).toEqual([]);
      expect(subtractSpans([100, 200], [[50, 100], [200, 250]])).toEqual([[100, 200]]);
    });

    it("planFreshWindows: covered / measured-decoded / read, decided from meta + chunks only", () => {
      const timed: IndexChunk = { i: 0, startSec: 3300, endSec: 3600, vec: [], text: "x" };
      expect(planFreshWindows([3520], idx(3600, undefined, [timed]))[0].kind).toBe("covered");
      expect(planFreshWindows([3520], idx(3600, {
        durationSec: 3600, complete: true, examined: [[0, 600]], unexamined: [[600, 3600]],
      }))[0].kind).toBe("decoded");
      const read = planFreshWindows([3520], idx(3600))[0];
      expect(read.kind).toBe("read");
      expect(read.need).toEqual([[3340, 3600]]);
      // Examined adjacency prunes the need exactly.
      expect(planFreshWindows([3520], idx(3600, {
        durationSec: 3600, complete: false, examined: [[0, 3500]], unexamined: [[3500, 3600]],
      }))[0].need).toEqual([[3500, 3600]]);
      // Boundary continuation: a cue whose window reaches past the last
      // examined edge needs EXACTLY the remainder — no gap, no overlap.
      expect(planFreshWindows([3880], idx(4200, {
        durationSec: 4200, complete: false, examined: [[3340, 3700]], unexamined: [[0, 3340], [3700, 4200]],
      }))[0].need).toEqual([[3700, 4060]]);
      expect(planFreshWindows([3520], idx(0))).toEqual([]);
    });
  });

  describe("the golden path stays byte-identical", () => {
    it("with NO freshAsr wired, the same failing turn assembles NO block (opt-in seam)", async () => {
      const ATT = "att_fresh9";
      seed(ATT, 3600);
      const msgs = ask(Q, ATT);
      const blocks = await buildAttachmentTurn(msgs, 0, Q);
      expect(blocks).toBe(0);
      unseed(ATT);
    });
  });
});
