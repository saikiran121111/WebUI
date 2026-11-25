import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  SPEECH_ASR_CAPABILITY,
  speechCapabilityDisabled,
  speechEngineNote,
  transcribeViaCapability,
} from "../../lib/server/extract/speech-capability";
import { resetMlJobNegativeCache, type MlJobEnvelope } from "../../lib/server/ml-job";

/**
 * E (migration): the Python `speech.asr` backend must have a PRODUCTION CALLER.
 * These tests cover the caller and its routing law — the five facts the worker
 * keeps apart (no track / silence / no speech / failed / unsupported language)
 * must stay apart here too, because a caller that flattens them re-creates the
 * bug the worker was written to prevent.
 *
 * Mechanics only: every job here is a stubbed envelope. Real engine execution is
 * evidenced separately by docs/overnight/probes/e03_speech_probe.py (real
 * CTranslate2 CPU run, measured WER and peak RSS), and the two facts are never
 * merged in the report.
 */

const envelope = (
  result: unknown,
  over: Partial<MlJobEnvelope> = {},
): MlJobEnvelope => ({
  state: "ready",
  capability: SPEECH_ASR_CAPABILITY,
  job_id: "job_1",
  run_id: "run_1",
  request_id: "req_1",
  deadline_s: 240,
  source: "test",
  ...(over.state && over.state !== "ready" ? { state: over.state } : {}),
  ...(over.error ? { error: over.error } : {}),
  result,
});

const asrPayload = (over: Record<string, unknown> = {}) => ({
  state: "transcribed",
  text: "the depot inventory lists ninety nine crates",
  segments: [
    { start: 0.4, end: 3.2, text: "the depot inventory" },
    { start: 61.0, end: 64.5, text: "lists ninety nine crates" },
  ],
  segment_count: 2,
  language: "en",
  language_source: "detected",
  language_probability: 0.91,
  model: "Systran/faster-whisper-base",
  device: "cpu",
  compute_type: "int8",
  duration: 65.0,
  complete: true,
  asr_ran: true,
  examined: [[0, 65.0]],
  coverage: { skipped: [] },
  audio_level: { max_volume_db: -18.2, noise_floor_db: -45, ok: true },
  probe: { duration: 65.0, audio_state: "audio_stream", audio_streams: 1 },
  routing: { decision: "detect", quality_mode: "published", note: "language detected by the model" },
  ...over,
});

const failEnvelope = (
  reason: string,
  message: string,
  retryable = false,
  humanStep = "",
): MlJobEnvelope => ({
  state: "failed",
  capability: SPEECH_ASR_CAPABILITY,
  job_id: "job_2",
  run_id: "run_2",
  request_id: "req_2",
  deadline_s: 240,
  source: "test",
  error: { reason, message, retryable, capability: SPEECH_ASR_CAPABILITY, human_step: humanStep },
});

afterEach(() => {
  resetMlJobNegativeCache();
  delete process.env.RUKE_SPEECH_CAPABILITY;
  delete process.env.RUKE_SPEECH_LANGUAGE;
});

describe("speech.asr capability caller", () => {
  it("sends the file and its allowed root, and never a bare name", async () => {
    const seen: { capability: string; payload: Record<string, unknown> }[] = [];
    const out = await transcribeViaCapability(path.join(".data", "tmp", "clip.wav"), {
      runJob: async (capability, payload) => {
        seen.push({ capability, payload });
        return envelope(asrPayload());
      },
    });
    expect(out.state).toBe("ready");
    expect(seen[0].capability).toBe(SPEECH_ASR_CAPABILITY);
    expect(path.isAbsolute(seen[0].payload.path as string)).toBe(true);
    expect(seen[0].payload.root).toBe(path.dirname(seen[0].payload.path as string));
  });

  it("no backend at all is state none, so the caller keeps its own engine", async () => {
    const out = await transcribeViaCapability("clip.wav", { runJob: async () => null });
    expect(out.state).toBe("none");
  });

  it("an explicit operator switch disables the path before any job is sent", async () => {
    process.env.RUKE_SPEECH_CAPABILITY = "off";
    let sent = 0;
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () => {
        sent++;
        return envelope(asrPayload());
      },
    });
    expect(speechCapabilityDisabled()).toBe(true);
    expect(out.state).toBe("none");
    expect(sent).toBe(0);
  });

  it("measured silence is a RESULT, not a failure, and says ASR never ran", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () =>
        envelope({
          ...asrPayload(),
          state: "silence",
          text: "",
          segments: [],
          segment_count: 0,
          asr_ran: false,
          note: "measured at -60.0 dBFS peak, at or below the -45 dBFS floor",
        }),
    });
    expect(out.state).toBe("silence");
    if (out.state !== "silence") return;
    expect(out.asr.asrRan).toBe(false);
    expect(out.asr.audioLevel.max_volume_db).toBeDefined();
  });

  it("a structural refusal is marked structural so the caller does not re-run another engine", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () =>
        failEnvelope(
          "unsupported_input",
          "the container carries no decodable audio track: ffprobe found 0 audio streams",
          false,
          "attach a file with an audio track",
        ),
    });
    expect(out.state).toBe("unavailable");
    if (out.state !== "unavailable") return;
    expect(out.structural).toBe(true);
    expect(out.retryable).toBe(false);
    expect(out.humanStep).toContain("audio track");
  });

  it("an unprepared model is NOT structural: another engine may legitimately answer", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () =>
        failEnvelope("model_unavailable", "Systran/faster-whisper-base is not executable on this host", true, "prepare it"),
    });
    expect(out.state).toBe("unavailable");
    if (out.state !== "unavailable") return;
    expect(out.structural).toBe(false);
    expect(out.retryable).toBe(true);
  });

  it("cancellation is reported as cancellation, never as a media defect", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () => ({
        ...failEnvelope("cancelled", "the job was cancelled"),
        state: "cancelled",
      }),
    });
    expect(out.state).toBe("unavailable");
    if (out.state !== "unavailable") return;
    expect(out.reason).toBe("cancelled");
    expect(out.structural).toBe(false);
  });

  it("a ready run with nothing inspectable is refused, not treated as an empty recording", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () => envelope({ state: "transcribed", text: "", segments: [] }),
    });
    expect(out.state).toBe("unavailable");
    if (out.state !== "unavailable") return;
    expect(out.reason).toBe("contract_mismatch");
  });

  it("keeps chunk-offset timestamps source-relative and counts unusable segments", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () =>
        envelope(
          asrPayload({
            segments: [
              { start: 120.5, end: 123.0, text: "late evidence at the end of a long recording" },
              { start: 130.0, end: 128.0, text: "backwards timing cannot be a citation" },
              { start: 140.0, end: 141.0, text: "   " },
            ],
            segment_count: 3,
            complete: false,
            coverage: { skipped: [[150.0, 300.0]] },
          }),
        ),
    });
    expect(out.state).toBe("ready");
    if (out.state !== "ready") return;
    expect(out.asr.segments[0].start).toBe(120.5);
    expect(out.asr.segments).toHaveLength(1);
    expect(out.asr.droppedSegments).toBe(2);
    expect(out.asr.segmentCount).toBe(3);
    expect(out.asr.complete).toBe(false);
    // Unexamined audio is named, because absence there is unproven.
    expect(out.asr.unexamined).toEqual([[150, 300]]);
  });

  it("the engine note states model, device, compute type, language source and timing kind", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () =>
        envelope(
          asrPayload({
            segments: [{ start: 1, end: 2, text: "hindi line", words: [{ word: " hindi", start: 1, end: 1.4, probability: 0.8 }]}],
            language: "hi",
            language_source: "explicit",
            model: "Systran/faster-whisper-base",
          }),
        ),
    });
    expect(out.state).toBe("ready");
    if (out.state !== "ready") return;
    const note = speechEngineNote(out.asr);
    expect(note).toContain("Systran/faster-whisper-base");
    expect(note).toContain("cpu/int8");
    expect(note).toContain("language hi (as specified)");
    expect(note).toContain("word timing supplied by the provider");
    expect(speechEngineNote({...out.asr, segments: out.asr.segments.map(s => ({...s, words: undefined}))}))
      .toContain("segment-level timing only");
  });

  // The window-boundary honesty fields from the Python merge (see the note in
  // python-backend/ruke_ml/speech/whisper_ct2.py::_merge_windows). A fragment that was
  // CUT BY OUR OWN CHUNKING must never be presented as a finished sentence, and a
  // dropped fragment must stay visible instead of vanishing.
  it("carries the merge's window-boundary honesty fields through to the note", async () => {
    const out = await transcribeViaCapability("long.wav", {
      runJob: async () =>
        envelope(
          asrPayload({
            text: "the depot inventory lists ninety nine crates",
            segments: [
              { start: 0.0, end: 6.0, text: "the depot inventory" },
              { start: 16.26, end: 21.26, text: "lists ninety nine crates" },
              { start: 21.3, end: 24.0, text: "and a maroon bicycle behind", window_truncated: true },
            ],
            segment_count: 3,
            vad_filter: true,
            vad_state: "applied",
            superseded_fragments: 1,
            superseded: [
              {
                start: 16.3,
                end: 19.3,
                text: "lists ninety",
                window: [7.0, 19.0],
                cut_at: "end",
                superseded_by: { start: 16.26, end: 21.26 },
                reason: "the span reaches the end of its decode window",
              },
              { start: null, end: 1.0, text: "malformed fragment cannot be cited", cut_at: "end" },
            ],
          }),
        ),
    });
    expect(out.state).toBe("ready");
    if (out.state !== "ready") return;
    // The truncated reading survives - partial evidence beats none - but is flagged.
    expect(out.asr.segments).toHaveLength(3);
    expect(out.asr.segments[2].windowTruncated).toBe(true);
    expect(out.asr.segments[0].windowTruncated).toBeUndefined();
    expect(out.asr.truncatedSegments).toBe(1);
    expect(out.asr.vadFilter).toBe(true);
    expect(out.asr.vadState).toBe("applied");
    // The malformed fragment is dropped, so the reported count is the worker's, not ours.
    expect(out.asr.supersededFragments).toBe(1);
    expect(out.asr.superseded).toHaveLength(1);
    expect(out.asr.superseded[0].cutAt).toBe("end");
    expect(out.asr.superseded[0].window).toEqual([7, 19]);
    expect(out.asr.superseded[0].supersededBy).toEqual({ start: 16.26, end: 21.26 });
    // A superseded fragment is not part of the transcript: no segment carries its span.
    expect(out.asr.segments.some((s) => s.start === 16.3 && s.end === 19.3)).toBe(false);
    expect(out.asr.segments.some((s) => s.start === 16.26)).toBe(true);
    const note = speechEngineNote(out.asr);
    expect(note).toContain("speech-activity gating applied per window");
    expect(note).toContain("1 segment(s) cut at a decode-window boundary");
    expect(note).toContain("1 window-boundary fragment(s) replaced by a complete reading");
  });

  it("states honestly when speech gating could NOT run, and never claims it did", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () =>
        envelope(asrPayload({ vad_filter: false, vad_state: "asset_missing" })),
    });
    expect(out.state).toBe("ready");
    if (out.state !== "ready") return;
    expect(out.asr.vadFilter).toBe(false);
    const note = speechEngineNote(out.asr);
    expect(note).toContain("speech-activity gating asset_missing");
    expect(note).not.toContain("gating applied");
    // A payload with none of the new fields stays as it was: nothing is invented.
    const plain = await transcribeViaCapability("clip.wav", {
      runJob: async () => envelope(asrPayload()),
    });
    if (plain.state !== "ready") throw new Error("expected ready");
    expect(plain.asr.vadState).toBe("");
    expect(plain.asr.supersededFragments).toBe(0);
    expect(plain.asr.superseded).toEqual([]);
    expect(plain.asr.truncatedSegments).toBe(0);
    expect(speechEngineNote(plain.asr)).not.toContain("gating");
  });
});

describe("F152 question-driven interval + durable record", () => {
  it("a named span travels to the worker as its own payload keys", async () => {
    const seen: Record<string, unknown>[] = [];
    const out = await transcribeViaCapability("clip.wav", {
      startSec: 760,
      endSec: 790,
      runJob: async (_capability, payload) => {
        seen.push(payload);
        return envelope(asrPayload({
          cache: { state: "stored", key: "k1", span: [760, 790] },
          complete: false,
          coverage: { skipped: [[0, 760], [790, 65.0]] },
        }));
      },
    });
    expect(out.state).toBe("ready");
    expect(seen[0].start_s).toBe(760);
    expect(seen[0].end_s).toBe(790);
    if (out.state !== "ready") return;
    expect(out.asr.cacheState).toBe("stored");
    expect(out.asr.cacheSpan).toEqual([760, 790]);
    // A partial pass says so in the attribution, never reads as a whole-track verdict.
    expect(speechEngineNote(out.asr)).toContain("coverage was partial");
  });

  it("a half-named or unserializable span is never sent", async () => {
    for (const over of [
      { startSec: 10 },                        // no end
      { endSec: 20 },                          // no start
      { startSec: Number.NaN, endSec: 20 },    // not a number
      { startSec: 20, endSec: 20 },            // degenerate
      { startSec: -1, endSec: 20 },            // negative
    ]) {
      let sent: Record<string, unknown> = {};
      await transcribeViaCapability("clip.wav", {
        ...over,
        runJob: async (_capability, payload) => {
          sent = payload;
          return envelope(asrPayload());
        },
      });
      expect(sent.start_s).toBeUndefined();
      expect(sent.end_s).toBeUndefined();
    }
  });

  it("a record hit is stated as provenance, from the worker's own cache state", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () =>
        envelope(asrPayload({ cache: { state: "hit", key: "k1", span: [760, 790] } })),
    });
    expect(out.state).toBe("ready");
    if (out.state !== "ready") return;
    expect(out.asr.cacheState).toBe("hit");
    expect(speechEngineNote(out.asr)).toContain("durable record");
    // A run with no cache field at all invents nothing.
    const plain = await transcribeViaCapability("clip.wav", {
      runJob: async () => envelope(asrPayload()),
    });
    if (plain.state !== "ready") throw new Error("expected ready");
    expect(plain.asr.cacheState).toBe("");
    expect(plain.asr.cacheSpan).toEqual([]);
    expect(speechEngineNote(plain.asr)).not.toContain("durable record");
  });

  it("the recognition clock reaches the adapter surface and the attribution line", async () => {
    // Item 5 (user brief 2026-11-24): "record selected engine, actual backend/device,
    // recognition start/finish". The worker stamps the adapter call's wall clock; the
    // adapter surface must carry it, and the attribution line must state it to the user.
    const out = await transcribeViaCapability("clip.wav", {
      runJob: async () =>
        envelope(asrPayload({
          recognition: {
            engine: "ruke_ml.speech.parakeet", device: "cuda",
            started_utc: "2026-11-25T04:12:03Z", finished_utc: "2026-11-25T04:12:41Z",
            wall_s: 38.2,
          },
        })),
    });
    expect(out.state).toBe("ready");
    if (out.state !== "ready") return;
    expect(out.asr.recognition).toEqual({
      engine: "ruke_ml.speech.parakeet", device: "cuda",
      startedAt: "2026-11-25T04:12:03Z", finishedAt: "2026-11-25T04:12:41Z", wallS: 38.2,
    });
    const note = speechEngineNote(out.asr);
    expect(note).toContain("recognised 2026-11-25T04:12:03Z by ruke_ml.speech.parakeet (38.2s wall)");
    // A worker that predates the clock invents nothing.
    const plain = await transcribeViaCapability("clip.wav", {
      runJob: async () => envelope(asrPayload()),
    });
    if (plain.state !== "ready") throw new Error("expected ready");
    expect(plain.asr.recognition).toEqual({
      engine: "", device: "", startedAt: "", finishedAt: "", wallS: null,
    });
    expect(speechEngineNote(plain.asr)).not.toContain("recognised");
  });

  it("the worker's geometry refusal surfaces as a structural verdict, not a crash", async () => {
    const out = await transcribeViaCapability("clip.wav", {
      startSec: 70,
      endSec: 90,
      runJob: async () =>
        failEnvelope(
          "input_rejected",
          "the requested span 70.0-90.0s does not fit the track (65.0s): the start must sit inside the audio and the end must come after it",
        ),
    });
    expect(out.state).toBe("unavailable");
    if (out.state !== "unavailable") return;
    expect(out.structural).toBe(true);
    expect(out.reason).toBe("input_rejected");
  });
});

describe("the upload path actually calls the Python speech engine", () => {
  const scratch = (name: string) => path.join(".data", "tmp", `speech_wire_${Date.now().toString(36)}_${name}`);

  it("an audio upload is transcribed by the capability job when one answers", async () => {
    const dir = scratch("audio");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, "clip.wav");
    // Deliberately NOT decodable audio: reaching the stub proves the capability
    // verdict is what was delivered, and that no decode was paid for it.
    fs.writeFileSync(src, "not really a wav, and it never had to be decoded");
    try {
      const { extractFileFromPath } = await import("../../lib/server/extract");
      const res = await extractFileFromPath("clip.wav", src, undefined, undefined, undefined, {
        runJob: async (capability) =>
          capability === SPEECH_ASR_CAPABILITY ? envelope(asrPayload()) : null,
      });
      expect(res.error).toBeUndefined();
      expect(res.transcript).toContain("depot inventory");
      expect(res.transcript).toContain("Systran/faster-whisper-base");
      expect(res.transcript).toContain("cpu/int8");
      // The TypeScript checkpoint's English-only warning must NOT ride on a
      // multilingual engine's transcript.
      expect(res.transcript).not.toContain("English-only speech model");
      expect(res.durationSec).toBe(65);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a retryable capability failure still reaches the retained TypeScript engine", async () => {
    const dir = scratch("fallback");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, "clip2.wav");
    fs.writeFileSync(src, "still not decodable audio, which is the point");
    try {
      const { extractFileFromPath } = await import("../../lib/server/extract");
      // Reaching the retained engine is proved by its OWN failure: the undecodable
      // file makes the TypeScript decode throw, and the primary backend's typed
      // reason is appended so the user sees both facts, not one merged sentence.
      await expect(
        extractFileFromPath("clip2.wav", src, undefined, undefined, undefined, {
          runJob: async (capability) =>
            capability === SPEECH_ASR_CAPABILITY
              ? failEnvelope(
                  "model_unavailable",
                  "weights were not prepared on this host",
                  true,
                  "python -m ruke_ml.models.prepare --model Systran/faster-whisper-base",
                )
              : null,
        }),
      ).rejects.toThrow(
        /weights were not prepared on this host[\s\S]*python -m ruke_ml\.models\.prepare/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a measured no-audio-track verdict is final: no second engine is attempted", async () => {
    const dir = scratch("notrack");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, "silentish.mp3");
    fs.writeFileSync(src, "an mp3-shaped file whose audio streams were already probed as zero");
    let calls = 0;
    try {
      const { extractFileFromPath } = await import("../../lib/server/extract");
      await expect(
        extractFileFromPath("silentish.mp3", src, undefined, undefined, undefined, {
          runJob: async (capability) => {
            calls++;
            if (capability === SPEECH_ASR_CAPABILITY) {
              return failEnvelope(
                "unsupported_input",
                "the container carries no decodable audio track: ffprobe found 0 audio streams (probe state no_audio_track), so nothing could be decoded and no audio property was measured",
                false,
                "attach a file with an audio track",
              );
            }
            return null;
          },
        }),
      ).rejects.toThrow(/no decodable audio track/);
      expect(calls).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * F153 item 2 (2026-11-24): the MAX_SEGMENTS cap must never eat the tail
 * silently. Repro from the brief: 20,001 VALID segments with a unique fact
 * in the LAST one — the old adapter returned 20,000, segmentCount=20001,
 * droppedSegments=0, complete=true, and index.ts's
 * `timedTranscriptText(asr.segments) || asr.text` precedence meant the final
 * fact reached NO consumer: not the delivered evidence, not the index, not
 * the cache, not reload/compaction. The law now: inspect every slice the cap
 * touches — keep the head plus a bounded TAIL window so the final fact rides
 * with its timestamp, and when a middle is skipped, SAY so (cappedSegments
 * counted, complete forced false, the full timed transcript kept durably).
 * ------------------------------------------------------------------ */
describe("F153: the segment cap keeps the tail and reports what it skips", () => {
  const longPayload = (n: number, over: Record<string, unknown> = {}) => {
    const segments = Array.from({ length: n }, (_, i) => ({
      start: i * 0.15,
      end: i * 0.15 + 0.14,
      text: `filler reading number ${i}`,
    }));
    if (n > 20_100) segments[20_100] = { start: 3015.0, end: 3015.14, text: "middle marker five five alpha" };
    segments[n - 1] = {
      start: 3599.4,
      end: 3600.25,
      text: "the final ledger entry is sealed on March third",
    };
    return asrPayload({
      segments,
      segment_count: n,
      duration: 3600,
      complete: true,
      text: "filler opening ... the final ledger entry is sealed on March third",
      ...over,
    });
  };
  const runWith = (n: number, over: Record<string, unknown> = {}) =>
    transcribeViaCapability("long.wav", { runJob: async () => envelope(longPayload(n, over)) });

  it("20,001 valid segments: the final fact survives with its timestamp; counts agree", async () => {
    const out = await runWith(20_001);
    expect(out.state).toBe("ready");
    if (out.state !== "ready") return;
    const asr = out.asr;
    const tail = asr.segments.find((s) => s.text.includes("final ledger entry"));
    expect(tail, "the final segment vanished from the adapter output").toBeTruthy();
    expect(tail!.start).toBe(3599.4);
    expect(tail!.end).toBe(3600.25);
    expect(asr.segmentCount).toBe(20_001);
    expect(asr.droppedSegments).toBe(0);
    expect(asr.cappedSegments).toBe(0);
    // The worker said complete and the adapter dropped NOTHING: the claim is true.
    expect(asr.complete).toBe(true);
  });

  it("20,500 segments: the skipped middle is REPORTED, the tail rides, the full timed transcript is durable", async () => {
    const out = await runWith(20_500);
    expect(out.state).toBe("ready");
    if (out.state !== "ready") return;
    const asr = out.asr;
    const tail = asr.segments.find((s) => s.text.includes("final ledger entry"));
    expect(tail, "the final segment vanished from the adapter output").toBeTruthy();
    expect(asr.segments.some((s) => s.text.includes("middle marker"))).toBe(false);
    expect(asr.cappedSegments).toBe(300); // 20,500 - 20,000 head - 200 tail window
    // The worker's complete=true must NOT survive a real cap drop.
    expect(asr.complete).toBe(false);
    expect(asr.segmentCount).toBe(20_500);
    // The full timestamped transcript is preserved durably (bounded pages live
    // in the index layer; the adapter hands over the timed text it builds from
    // EVERY validated segment, middle included).
    expect(asr.fullTranscriptText).toContain("middle marker five five alpha");
    expect(asr.fullTranscriptText).toContain("the final ledger entry is sealed on March third");
    expect(asr.fullTranscriptText).toContain("[00:59:59 - 01:00:00] the final ledger entry");
  });

  it("superseded-fragment slice audit: the worker count stays honest when the audit list caps", async () => {
    const frags = Array.from({ length: 20_001 }, (_, i) => ({
      start: i,
      end: i + 0.5,
      text: `fragment ${i}`,
      window: [0, 60],
      cut_at: "end",
      superseded_by: { start: i, end: i + 0.4 },
      reason: "superseded",
    }));
    const out = await runWith(2, { superseded: frags, superseded_fragments: 25_000 });
    expect(out.state).toBe("ready");
    if (out.state !== "ready") return;
    // Fragments are audit-only evidence (never part of `text`): the worker's own
    // count is preserved, the serialized list is capped — auditable, not hidden.
    expect(out.asr.supersededFragments).toBe(25_000);
    expect(out.asr.superseded.length).toBe(20_000);
  });
});
