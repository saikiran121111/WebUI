/**
 * attach-timeline-s60.test.ts -- the media baseline seam (F13/P7/G1).
 *
 * Three layers are covered, because the defect class here was "a backup field
 * nobody reads":
 *   1. the deterministic container reader (parseMediaProbe) -- what the file
 *      ACTUALLY declares, with negative controls for invented values;
 *   2. the capability client (mlJob) -- no route means null, and a null route
 *      must provably never touch the network;
 *   3. the durable record + its consumer -- observations survive an index
 *      round-trip and reach the REAL search-tool arguments through
 *      media-hints, while a text-less scene interval never becomes a query.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  attachTimelineDir,
  buildTimeline,
  discardTimelineScratch,
  parseMediaProbe,
  sceneObservations,
  sha256File,
  timelineRecordPath,
  type MediaProbeInfo,
} from "../lib/server/attachindex/timeline";
import {
  ML_JOB_PATH,
  mlJob,
  resetMlJobNegativeCache,
  type MlJobEnvelope,
} from "../lib/server/ml-job";
import { indexDir, readIndex, removeIndex, writeIndex } from "../lib/server/attachindex/store";
import { buildMediaHints, mediaHintQueries } from "../lib/server/attachindex/media-hints";
import type { IndexChunk, IndexMeta, TimelineSummary } from "../lib/server/attachindex/types";

// ---------------------------------------------------------------- container

const MP4_PROBE = [
  "ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers",
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
  "  Metadata:",
  "    major_brand     : isom",
  "    creation_time   : 2026-01-02T10:00:00.000000Z",
  "  Duration: 00:01:23.45, start: 0.000000, bitrate: 812 kb/s",
  "  Stream #0:0[0x1](eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1280x720 [SAR 1:1 DAR 16:9], 700 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)",
  "    Metadata:",
  "      handler_name    : VideoHandler",
  "      encoder         : Lavc60.31.102 libx264",
  "    Side data:",
  "      displaymatrix: rotation of -90.00 degrees",
  "  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)",
  "    Metadata:",
  "      handler_name    : SoundHandler",
  "  Stream #0:2[0x3](spa): Subtitle: subrip",
  "",
].join("\n");

describe("parseMediaProbe", () => {
  const info: MediaProbeInfo = parseMediaProbe(MP4_PROBE);

  it("reads the declared duration", () => {
    expect(info.durationSec).toBeCloseTo(83.45, 2);
  });

  it("lists the streams with the language the container declared", () => {
    expect(info.streams.map((s) => `${s.fileIndex}:${s.streamIndex}:${s.type}:${s.language}`)).toEqual([
      "0:0:video:eng",
      "0:1:audio:eng",
      "0:2:subtitle:spa",
    ]);
    expect(info.hasAudioTrack).toBe(true);
    expect(info.subtitleTracks).toEqual(["spa"]);
  });

  it("reads the rotation the container actually reported", () => {
    expect(info.rotationDeg).toBe(-90);
  });

  it("does not invent per-stream offsets the probe never printed", () => {
    // The only `start:` in this report is the container-level Duration line,
    // which belongs to no stream. Reporting it as a stream offset would be a
    // fabrication, and a wrong timebase is exactly what corrupts subtitles.
    expect(info.streamStartOffsets).toEqual({});
    expect(info.streams.every((s) => s.startSec === null)).toBe(true);
  });

  it("reads per-stream start offsets without crossing into a neighbour", () => {
    const info2 = parseMediaProbe([
      "Input #0, matroska,webm, from 'rec.mkv':",
      "  Duration: 00:00:30.02, start: 1.400000, bitrate: 5000 kb/s",
      "  Stream #0:0(eng): Video: h264 (Main), yuv420p, 1920x1080, start 0.023000, 25 fps, 25 tbr",
      "  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, start: 0.5",
      "  Stream #0:2: Audio: opus, 48000 Hz, stereo, start 1.250 (forcedcaption)",
    ].join("\n"));
    expect(info2.streamStartOffsets).toEqual({ "video:0": 0.023, "audio:1": 0.5, "audio:2": 1.25 });
    // `(forcedcaption)` is not a 3-letter language tag: no language is claimed.
    expect(info2.streams[2].language).toBe("");
    expect(info2.hasAudioTrack).toBe(true);
  });

  it("falls back to a stream label, not a fake language, for an untagged subtitle", () => {
    const info3 = parseMediaProbe([
      "Input #0, mp4, from 'a.mp4':",
      "  Duration: 00:00:05.00, start: 0.000000,",
      "  Stream #0:0: Video: vp9, yuv420p, 640x360",
      "  Stream #0:1(eng): Subtitle: mov_text",
      "  Stream #0:2: Subtitle: mov_text",
    ].join("\n"));
    expect(info3.subtitleTracks).toEqual(["eng", "stream 0:2"]);
    expect(info3.rotationDeg).toBe(0);
    expect(info3.hasAudioTrack).toBe(false);
  });

  it("reads the rotate=-90 tag spelling as well", () => {
    const info4 = parseMediaProbe(
      "Input #0, mp4, from 'b.mp4':\n  Duration: 00:00:02.00, start: 0.0,\n  Stream #0:0: Video: hevc\n    rotate         = -90\n",
    );
    expect(info4.rotationDeg).toBe(-90);
  });

  it("answers an unusable report with an empty description", () => {
    const info5 = parseMediaProbe("at least one input file must be specified");
    expect(info5.durationSec).toBe(0);
    expect(info5.streams).toEqual([]);
    expect(info5.hasAudioTrack).toBe(false);
    expect(info5.subtitleTracks).toEqual([]);
    expect(parseMediaProbe("Duration: 99:99")).toEqual(expect.objectContaining({ durationSec: 0 }));
    expect(parseMediaProbe("").durationSec).toBe(0);
  });

  it("bounds the probe text it reads", () => {
    const huge = MP4_PROBE + "x".repeat(200_000);
    const info6 = parseMediaProbe(huge);
    expect(info6.streams.length).toBe(3);
    expect(info6.durationSec).toBeGreaterThan(0);
  });
});

describe("sceneObservations", () => {
  it("turns cut timestamps into bounded intervals, never text", () => {
    const obs = sceneObservations([8, 2, 5, 2, 999], 10, 0.35);
    expect(obs.map((o) => [o.start, o.end])).toEqual([[2, 5], [5, 8], [8, 10]]);
    for (const o of obs) {
      expect(o.kind).toBe("scene");
      expect(o.text).toBe("");
      expect(o.audio_state).toBe("unknown");
      expect(String(o.provider)).toContain("ffmpeg:scene-threshold");
    }
  });

  it("keeps one interval when nothing cut, and clips a cut past the end", () => {
    expect(sceneObservations([], 6, 0.35).map((o) => [o.start, o.end])).toEqual([[0, 6]]);
    const clipped = sceneObservations([4, 30], 6, 0.35);
    expect(clipped.map((o) => [o.start, o.end])).toEqual([[4, 6]]);
  });
});

// ------------------------------------------------------------------- client

describe("mlJob capability route", () => {
  const savedBackend = process.env.RUKE_RUST_BACKEND;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    resetMlJobNegativeCache();
    globalThis.fetch = realFetch;
    if (savedBackend === undefined) delete process.env.RUKE_RUST_BACKEND;
    else process.env.RUKE_RUST_BACKEND = savedBackend;
  });

  it("returns null, and provably never touches the network, with no route", async () => {
    delete process.env.RUKE_RUST_BACKEND;
    const spy = vi.fn(() => {
      throw new Error("a deployment with no capability route must not open a socket");
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(mlJob("video.timeline", { op: "init" })).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes a typed failure through instead of inventing a result", async () => {
    process.env.RUKE_RUST_BACKEND = "1";
    const envelope = {
      state: "failed",
      capability: "video.scenes",
      job_id: "job_x",
      run_id: "run_x",
      request_id: "req_x",
      deadline_s: 90,
      source: "rust-ml-job",
      error: { reason: "not_configured", message: "no supervisor", retryable: false, capability: "video.scenes", human_step: "start npm run dev" },
    };
    const spy = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(envelope), { status: 552 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    const got = await mlJob("video.scenes", { duration: 12 });
    expect(got).not.toBeNull();
    expect(got?.error?.reason).toBe("not_configured");
    expect(got?.result).toBeUndefined();
    // Correct path + bridge headers on the real request, not just a parsed mock.
    const init = spy.mock.calls[0][1];
    expect(String(spy.mock.calls[0][0])).toContain(ML_JOB_PATH);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("remembers a capability-level failure, and forgets it on request", async () => {
    process.env.RUKE_RUST_BACKEND = "1";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        state: "unavailable",
        capability: "video.timeline",
        job_id: "j", run_id: "r", request_id: "q", deadline_s: 30, source: "rust-ml-job",
        error: { reason: "unreachable", message: "supervisor down", retryable: true, capability: "video.timeline", human_step: "" },
      }), { status: 503 });
    }) as unknown as typeof fetch;
    await mlJob("video.timeline", {});
    await mlJob("video.timeline", {});
    expect(calls).toBe(1); // negative cache: no hammering a dead supervisor
    resetMlJobNegativeCache();
    await mlJob("video.timeline", {});
    expect(calls).toBe(2);
  });

  it("never caches a caller cancellation", async () => {
    process.env.RUKE_RUST_BACKEND = "1";
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      calls += 1;
      if (calls > 1) {
        return new Response(JSON.stringify({
          state: "done", capability: "video.timeline",
          job_id: "j", run_id: "r", request_id: "q", deadline_s: 30, source: "rust-ml-job",
          result: { payload: { record: { meta: {} } } },
        }), { status: 200 });
      }
      await new Promise<void>((resolve, reject) => {
        const signal = init.signal as AbortSignal;
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = mlJob("video.timeline", {}, { signal: controller.signal });
    controller.abort();
    const got = await pending;
    expect(got?.error?.reason).toBe("cancelled");
    resetMlJobNegativeCache();
    // A cancel is our action, not a capability verdict: the next call asks again.
    await expect(mlJob("video.timeline", {})).resolves.not.toBeNull();
    expect(calls).toBe(2);
  });
});

// -------------------------------------------------------------- durable store

describe("durable timeline record", () => {
  const attId = "att_timeline60";
  let scratch = "";
  const summary: TimelineSummary = {
    sourceHash: "ab".repeat(32),
    hashAlgorithm: "sha256",
    durationSec: 83.45,
    streams: [{ fileIndex: 0, streamIndex: 0, type: "video", language: "eng", startSec: null }],
    rotationDeg: -90,
    hasAudioTrack: true,
    subtitleTracks: ["spa"],
    streamStartOffsets: {},
    coverage: {
      units: "seconds", totalSec: 83.45, examinedSec: 60, complete: false,
      examined: [[0, 60]], unexamined: [[60, 83.45]], note: "scan stopped at its wall-clock bound",
    },
    capability: "video.timeline",
    jobState: "done",
    sceneScan: { state: "ok_recorded", reason: "", scannedSec: 60, truncated: true },
    recordDir: "timeline",
    updatedAt: 1730000000000,
  };
  const observations = [
    { start: 2, end: 5, kind: "scene", text: "", frame_ref: "", audio_state: "unknown", provider: "ffmpeg:scene-threshold-0.35" },
    { start: 5, end: 8, kind: "ocr", text: "Invoice 4711 total 1,200 EUR", provider: "paddle:pending" },
  ];

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ruke-s60-"));
  });

  afterAll(() => {
    removeIndex(attId);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("survives the index round-trip that a later turn actually reads", () => {
    const meta: IndexMeta = {
      attId, name: "clip.mp4", category: "video", createdAt: 1, chunkCount: 2,
      spine: "clip spine", spineBlocks: [], frames: [], observations, timeline: summary,
    };
    const chunks: IndexChunk[] = [
      { i: 0, startSec: 2, endSec: 5, text: "scene from 2s to 5s", vec: [] },
      { i: 1, startSec: 5, endSec: 8, text: "Invoice 4711 total 1,200 EUR", vec: [] },
    ];
    writeIndex(attId, meta, chunks, "clip full text");
    const loaded = readIndex(attId);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.observations?.length).toBe(2);
    expect(loaded!.meta.timeline?.coverage.unexamined).toEqual([[60, 83.45]]);
    expect(loaded!.meta.timeline?.hashAlgorithm).toBe("sha256");
    // F09: a pointer is only useful if the bytes it names can be verified.
    expect(timelineRecordPath(indexDir(attId), summary.sourceHash)).toBeNull();
  });

  it("publishes the staged record inside the index dir, then finds it", () => {
    const hashDir = path.join(scratch, summary.sourceHash.slice(0, 32));
    fs.mkdirSync(hashDir, { recursive: true });
    fs.writeFileSync(path.join(hashDir, "timeline.json"), JSON.stringify({ schema_version: 1 }));
    expect(attachTimelineDir(indexDir(attId), scratch)).toBe(true);
    const found = timelineRecordPath(indexDir(attId), summary.sourceHash);
    expect(found).not.toBeNull();
    expect(fs.existsSync(found as string)).toBe(true);
    expect(timelineRecordPath(indexDir(attId), "no-such-source")).toBeNull();
  });

  it("discards a staged baseline that never published", () => {
    const dir = path.join(scratch, "staged-drop");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.json"), "{}");
    discardTimelineScratch(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("hashes a real file, and says when it used a substitute", async () => {
    const file = path.join(scratch, "sample.bin");
    fs.writeFileSync(file, Buffer.from("ruke media bytes"));
    const identity = await sha256File(file);
    expect(identity.algorithm).toBe("sha256");
    expect(identity.hash).toMatch(/^[0-9a-f]{64}$/);
    const again = await sha256File(file);
    expect(again.hash).toBe(identity.hash); // stable identity across re-opens
    const controller = new AbortController();
    controller.abort();
    await expect(sha256File(file, { signal: controller.signal })).rejects.toThrow();
  });
});

// ------------------------------------------------- evidence reaches the tools

describe("timeline evidence into real search arguments", () => {
  const index = {
    meta: {
      attId: "att_hints60", name: "clip.mp4", category: "video", createdAt: 1,
      chunkCount: 1, spine: "", spineBlocks: [], frames: [],
      observations: [
        { start: 2, end: 5, kind: "scene", text: "", provider: "ffmpeg:scene-threshold-0.35" },
        { start: 5, end: 8, kind: "ocr", text: "Acme Robotics quarterly launch", provider: "ocr:test" },
        { start: 9, end: 11, kind: "speech", text: "the Acme Robotics launch date", provider: "asr:test" },
      ],
    } as unknown as IndexMeta,
    chunks: [{ i: 0, startSec: 2, endSec: 11, text: "captions here", vec: [] }],
  };

  it("sends the textual clues, and never the bare intervals", () => {
    const hints = buildMediaHints(index, 12);
    const queries = mediaHintQueries(hints, 6);
    expect(queries.some((q) => q.includes("Acme Robotics quarterly launch"))).toBe(true);
    const joined = queries.join("|");
    expect(joined).not.toContain("scene");
    expect(joined).not.toContain("ffmpeg");
    expect(joined).not.toMatch(/0\.35/);
    for (const h of hints) expect(h.value.trim()).not.toBe("");
    expect(hints.every((h) => h.startSec !== null)).toBe(true);
  });
});

// ------------------------------------------------------------- baseline build

describe("buildTimeline", () => {
  let workspace = "";
  let srcPath = "";
  let scratchRoot = "";

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ruke-s60-build-"));
    srcPath = path.join(workspace, "lecture.mp4");
    fs.writeFileSync(srcPath, Buffer.from("a lecture container stand-in"));
    scratchRoot = path.join(workspace, "scratch");
  });
  afterAll(() => {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const okEnvelope = (capability: string, payload: unknown): MlJobEnvelope => ({
    state: "done", capability, job_id: "j", run_id: "r", request_id: "q", deadline_s: 30,
    source: "rust-ml-job", result: { job_id: "j", capability, state: "done", payload, schema_version: 1 },
  });
  const failEnvelope = (capability: string, reason: string, message: string): MlJobEnvelope => ({
    state: "failed", capability, job_id: "j", run_id: "r", request_id: "q", deadline_s: 30, source: "rust-ml-job",
    error: { reason, message, retryable: false, capability, human_step: "" },
  });

  function stub(envelopes: Record<string, MlJobEnvelope | null>) {
    const calls: Array<{ capability: string; payload: Record<string, unknown> }> = [];
    const runJob = async (capability: string, payload: Record<string, unknown>) => {
      calls.push({ capability, payload });
      if (capability === "video.scenes") return envelopes.scenes ?? null;
      const op = String(payload.op ?? "");
      if (op === "init") return envelopes.init ?? null;
      return envelopes.observe ?? null;
    };
    return { calls, runJob };
  }

  it("builds identity + streams + scene anchors + measured coverage", async () => {
    const record = { meta: { coverage: { units: "seconds", examined: [[0, 40]], skipped: [[40, 60]], total_source: 60, complete: false, note: "bounded scan" } } };
    const { calls, runJob } = stub({
      init: okEnvelope("video.timeline", { record, reply: "40 s examined" }),
      scenes: okEnvelope("video.scenes", { cut_scan: { ok: true, cuts: [12.5, 30], scanned_seconds: 40, truncated: true, threshold: 0.35 } }),
      observe: okEnvelope("video.timeline", { record, reply: "recorded" }),
    });
    const baseline = await buildTimeline({
      attId: "att_build60", srcPath, probeText: MP4_PROBE, durationSec: 60,
      scratchRoot, runJob,
    });
    expect(baseline).not.toBeNull();
    const b = baseline!;
    expect(calls.map((c) => c.capability)).toEqual(["video.timeline", "video.scenes", "video.timeline"]);
    const meta = calls[0].payload.meta as Record<string, unknown>;
    expect(meta.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.has_audio_track).toBe(true);
    expect(meta.subtitle_tracks).toEqual(["spa"]);
    expect(meta.rotation_deg).toBe(-90);
    // The scenes job gets a real source path and the container's own offset.
    expect(calls[1].payload.source).toBe(path.resolve(srcPath));
    expect(calls[1].payload.stream_start_offset).toBe(0);
    expect(calls[2].payload.stage).toBe("scene-cuts");
    expect(b.observations.map((o) => [o.start, o.end])).toEqual([[12.5, 30], [30, 40]]);
    expect(b.summary.sceneScan).toEqual({ state: "ok_recorded", reason: "", scannedSec: 40, truncated: true });
    expect(b.summary.coverage.unexamined).toEqual([[40, 60]]);
    expect(b.summary.coverage.examinedSec).toBe(40);
    expect(b.summary.rotationDeg).toBe(-90);
    expect(fs.existsSync(b.scratchDir)).toBe(true);
  });

  it("publishes nothing when the init job fails", async () => {
    const { calls, runJob } = stub({ init: failEnvelope("video.timeline", "supervisor_failed", "runner exited") });
    const baseline = await buildTimeline({ attId: "att_fail60", srcPath, probeText: MP4_PROBE, durationSec: 60, scratchRoot, runJob });
    expect(baseline).toBeNull();
    expect(calls.length).toBe(1); // no scene scan behind a dead record
  });

  it("keeps the true record and labels a failed scan when scenes fail", async () => {
    const record = { meta: { coverage: { units: "seconds", examined: [], skipped: [], complete: false } } };
    const { calls, runJob } = stub({
      init: okEnvelope("video.timeline", { record, reply: "streams recorded" }),
      scenes: failEnvelope("video.scenes", "tool_unavailable", "ffmpeg missing"),
      observe: okEnvelope("video.timeline", { record, reply: "unused" }),
    });
    const baseline = await buildTimeline({ attId: "att_scanfail60", srcPath, probeText: MP4_PROBE, durationSec: 60, scratchRoot, runJob });
    expect(baseline).not.toBeNull();
    expect(baseline!.summary.sceneScan.state).toBe("failed");
    expect(baseline!.summary.sceneScan.reason).toContain("tool_unavailable");
    expect(baseline!.observations).toEqual([]);
    expect(calls.map((c) => c.capability)).toEqual(["video.timeline", "video.scenes"]);
  });

  it("returns null, without inventing a route, when the deployment has none", async () => {
    const { calls, runJob } = stub({});
    const baseline = await buildTimeline({ attId: "att_noroute60", srcPath, probeText: MP4_PROBE, durationSec: 60, scratchRoot, runJob });
    expect(baseline).toBeNull();
    expect(calls.length).toBe(1);
  });

  it("obeys cancellation before and during the build", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, runJob } = stub({ init: okEnvelope("video.timeline", { record: { meta: {} }, reply: "" }) });
    const baseline = await buildTimeline({ attId: "att_cancel60", srcPath, probeText: MP4_PROBE, durationSec: 60, scratchRoot, runJob, signal: controller.signal });
    expect(baseline).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("records a cut-free scan as examined evidence, not as a guess", async () => {
    const record = { meta: { coverage: { units: "seconds", examined: [[0, 60]], skipped: [], complete: true } } };
    const { calls, runJob } = stub({
      init: okEnvelope("video.timeline", { record, reply: "ok" }),
      scenes: okEnvelope("video.scenes", { cut_scan: { ok: true, cuts: [], scanned_seconds: 60, truncated: false, threshold: 0.35 } }),
      observe: okEnvelope("video.timeline", { record, reply: "static span examined" }),
    });
    const baseline = await buildTimeline({ attId: "att_static60", srcPath, probeText: MP4_PROBE, durationSec: 60, scratchRoot, runJob });
    expect(baseline).not.toBeNull();
    expect(baseline!.summary.sceneScan.state).toBe("ok_recorded");
    // No cut is itself a finding: the whole scanned span is one static interval,
    // so a later pass knows this range WAS looked at (and what was not).
    expect(baseline!.observations.map((o) => [o.start, o.end])).toEqual([[0, 60]]);
    for (const o of baseline!.observations) expect(o.text).toBe("");
    const cov = calls[2].payload.coverage as { examined: unknown; skipped: unknown };
    expect(cov.examined).toEqual([[0, 60]]);
    expect(cov.skipped).toEqual([]);
    expect(baseline!.coverageReply).toBe("static span examined");
  });
});
