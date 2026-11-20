/**
 * attach-timeline-f04.test.ts - the measured-prefix contract on the CONSUMER side
 * (brief 3-D, TS half). Frozen answer key: written before the implementation, and
 * the numeric cases come from the shared fixture that the Python producer also
 * binds to (rust-backend/fixtures/media/measured-prefix-v1.json), so neither side
 * can quietly redefine "how far the decoder got".
 *
 * The defect class being pinned: a truncated scan used to fall back to the clip
 * DURATION, which turned a plan into inspected-content coverage (a 120 s file
 * reported 46 s examined, or worse, 120 s examined, when the decoder had proven
 * nothing of the sort). Unknown progress must stay unknown, and a partial cut list
 * stays POINT evidence rather than becoming an interval to the end of the file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildTimeline,
  measuredPrefixEnd,
  sceneObservations,
} from "../lib/server/attachindex/timeline";
import type { MlJobEnvelope } from "../lib/server/ml-job";

const FIXTURE = path.join(
  process.cwd(),
  "rust-backend",
  "fixtures",
  "media",
  "measured-prefix-v1.json",
);

interface PrefixCase {
  id: string;
  value: unknown;
  duration: number;
  measured: boolean;
  expected: number;
}

describe("measuredPrefixEnd (shared fixture ruke-measured-prefix/v1)", () => {
  const cases: PrefixCase[] = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).cases;

  it("the fixture is present and non-trivial", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const c of cases) {
    it(`${c.id} -> ${c.expected}`, () => {
      expect(measuredPrefixEnd(c.value, c.duration, c.measured)).toBe(c.expected);
    });
  }

  it("rejects a duration-shaped lie for an unmeasured scan (the 46/120 s case)", () => {
    expect(measuredPrefixEnd(46, 120, false)).toBe(0);
  });

  it("keeps a measured prefix that the decoder actually reported", () => {
    expect(measuredPrefixEnd(46, 120, true)).toBe(46);
  });
});

describe("sceneObservations boundary honesty", () => {
  it("with a measured boundary it still builds intervals", () => {
    expect(
      sceneObservations([12.5, 30], 40, 0.35, { boundaryMeasured: true }).map((o) => [o.start, o.end]),
    ).toEqual([[12.5, 30], [30, 40]]);
  });

  it("with NO measured boundary every cut stays a point, never an interval", () => {
    const obs = sceneObservations([12.5, 30], 120, 0.35, { boundaryMeasured: false });
    expect(obs.map((o) => [o.start, o.end])).toEqual([[12.5, 12.5], [30, 30]]);
    for (const o of obs) {
      expect(o.kind).toBe("scene");
      expect(o.text).toBe("");
    }
  });

  it("no measured boundary and no cuts claims nothing at all", () => {
    expect(sceneObservations([], 120, 0.35, { boundaryMeasured: false })).toEqual([]);
  });

  it("a static source with a measured boundary is still evidence", () => {
    expect(sceneObservations([], 60, 0.35, { boundaryMeasured: true }).map((o) => [o.start, o.end]))
      .toEqual([[0, 60]]);
  });
});

// ------------------------------------------------- the caller that publishes it

const PROBE = [
  "ffmpeg version 6.1.1",
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
  "  Duration: 00:02:00.00, start: 0.000000, bitrate: 812 kb/s",
  "  Stream #0:0[0x1](eng): Video: h264 (High), 1280x720, 29.97 fps",
  "  Stream #0:1[0x2](eng): Audio: aac (LC), 48000 Hz, stereo",
  "",
].join("\n");

describe("buildTimeline coverage arithmetic", () => {
  let workspace = "";
  let srcPath = "";
  let scratchRoot = "";

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ruke-f04-"));
    srcPath = path.join(workspace, "lecture.mp4");
    fs.writeFileSync(srcPath, Buffer.from("container stand-in"));
    scratchRoot = path.join(workspace, "scratch");
  });
  afterAll(() => {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const okEnvelope = (capability: string, payload: unknown): MlJobEnvelope => ({
    state: "done", capability, job_id: "j", run_id: "r", request_id: "q", deadline_s: 30,
    source: "rust-ml-job",
    result: { job_id: "j", capability, state: "done", payload, schema_version: 1 },
  });

  function stub(scenesPayload: unknown) {
    const calls: Array<{ capability: string; payload: Record<string, unknown> }> = [];
    const record = { meta: { coverage: { units: "seconds", examined: [], skipped: [], complete: false } } };
    const runJob = async (capability: string, payload: Record<string, unknown>) => {
      calls.push({ capability, payload });
      if (capability === "video.scenes") return okEnvelope("video.scenes", scenesPayload);
      return okEnvelope("video.timeline", { record, reply: "recorded" });
    };
    return { calls, runJob };
  }

  async function build(scenesPayload: unknown, durationSec = 120) {
    const { calls, runJob } = stub(scenesPayload);
    const baseline = await buildTimeline({
      attId: `att_f04_${Math.random().toString(36).slice(2)}`,
      srcPath, probeText: PROBE, durationSec, scratchRoot, runJob,
    });
    expect(baseline).not.toBeNull();
    const observe = calls.filter((c) => c.capability === "video.timeline" && c.payload.op === "observe").pop();
    return { baseline: baseline!, observe };
  }

  it("a truncated scan with NO measured prefix never claims an examined span", async () => {
    const { baseline, observe } = await build({
      cut_scan: {
        ok: true, cuts: [12.5, 30], truncated: true, prefix_measured: false,
        scanned_seconds: 0, threshold: 0.35,
      },
    });
    const cov = observe?.payload.coverage as { examined: unknown[]; skipped: unknown[]; note: string };
    expect(cov.examined).toEqual([]);
    expect(cov.skipped).toEqual([[0, 120]]);
    expect(cov.note).toMatch(/unmeasured|unknown/i);
    expect(baseline.observations.map((o) => [o.start, o.end])).toEqual([[12.5, 12.5], [30, 30]]);
    expect(baseline.summary.sceneScan.prefixMeasured).toBe(false);
    expect(baseline.summary.sceneScan.scannedSec).toBe(0);
  });

  it("an unmeasured scan that REPORTS a duration-shaped prefix is still unknown", async () => {
    // Exactly the reproduced defect: a 120 s source, no progress ticks, scanned_seconds
    // filled in from the clip length. The consumer must not launder it into coverage.
    const { observe } = await build({
      cut_scan: {
        ok: true, cuts: [12.5, 30], truncated: true, prefix_measured: false,
        scanned_seconds: 46, threshold: 0.35,
      },
    });
    const cov = observe?.payload.coverage as { examined: unknown[]; skipped: unknown[] };
    expect(cov.examined).toEqual([]);
    expect(cov.skipped).toEqual([[0, 120]]);
  });

  it("a truncated scan with a MEASURED prefix reports that prefix and the rest as unexamined", async () => {
    const { baseline, observe } = await build({
      cut_scan: {
        ok: true, cuts: [12.5, 30], truncated: true, prefix_measured: true,
        scanned_seconds: 40, threshold: 0.35,
      },
    });
    const cov = observe?.payload.coverage as { examined: unknown[][]; skipped: unknown[][] };
    expect(cov.examined).toEqual([[0, 40]]);
    expect(cov.skipped).toEqual([[40, 120]]);
    expect(baseline.observations.map((o) => [o.start, o.end])).toEqual([[12.5, 30], [30, 40]]);
    expect(baseline.summary.sceneScan).toEqual({
      state: "ok_recorded", reason: "", scannedSec: 40, truncated: true, prefixMeasured: true,
    });
  });

  it("a scan that ran to the end of the stream may claim the whole duration", async () => {
    const { baseline, observe } = await build({
      cut_scan: {
        ok: true, cuts: [12.5, 30], truncated: false, prefix_measured: true,
        scanned_seconds: 120, threshold: 0.35,
      },
    });
    const cov = observe?.payload.coverage as { examined: unknown[][]; skipped: unknown[][] };
    expect(cov.examined).toEqual([[0, 120]]);
    expect(cov.skipped).toEqual([]);
    expect(baseline.observations.map((o) => [o.start, o.end])).toEqual([[12.5, 30], [30, 120]]);
  });

  it("a malformed prefix field cannot smuggle a claim", async () => {
    const { observe } = await build({
      cut_scan: {
        ok: true, cuts: [], truncated: true, prefix_measured: true,
        scanned_seconds: "the whole thing", threshold: 0.35,
      },
    });
    const cov = observe?.payload.coverage as { examined: unknown[]; skipped: unknown[] };
    expect(cov.examined).toEqual([]);
    expect(cov.skipped).toEqual([[0, 120]]);
  });
});

