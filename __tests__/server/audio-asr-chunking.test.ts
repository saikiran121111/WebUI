import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * I12: transformers 4.3.1 destructures chunk_length_s/stride_length_s off
 * the pipeline LOAD options but never wires them into the ASR task — a long
 * recording came back as its FIRST 30 SECONDS ONLY, silently. The real knobs
 * must ride on every pipeline CALL. The mock records both opt sites so the
 * contract is proven, not assumed. Also pins the seam-duplicate collapse
 * (dedupeSeamSegments) that window-per-window decoding depends on.
 */

const SR = 16000;

const hcalls = vi.hoisted(() => ({ load: [] as any[], call: [] as any[] }));

vi.mock("@huggingface/transformers", () => ({
  pipeline: async (_task: string, _model: string, opts: any) => {
    hcalls.load.push(opts);
    const asr: any = async (_pcm: Float32Array, callOpts: any) => {
      hcalls.call.push(callOpts);
      return {
        text: "alpha beta",
        chunks: [
          { text: "alpha beta", timestamp: [0, 4] },
          { text: "alpha beta", timestamp: [1.5, 4.5] }, // the stride seam says it twice
        ],
      };
    };
    asr.dispose = async () => {};
    return asr;
  },
  env: {},
}));

beforeEach(() => {
  hcalls.load.length = 0;
  hcalls.call.length = 0;
  vi.resetModules();
});

const load = () => import("../../lib/server/extract/audio");

describe("ASR chunk options ride on the CALL, never on the load (I12)", () => {
  it("transcribePcmSegments: call opts carry chunk_length_s/stride_length_s; load opts must NOT", async () => {
    const audio = await load();
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => null,
    });
    expect(r.text).toBeTruthy();
    expect(hcalls.call.length).toBe(1);
    expect(hcalls.call[0].chunk_length_s).toBe(30);
    expect(hcalls.call[0].stride_length_s).toBe(5);
    expect(hcalls.call[0].return_timestamps).toBe(true);
    // The bug was passing them ONLY here — prove the load site is clean.
    expect(hcalls.load.length).toBeGreaterThan(0);
    for (const o of hcalls.load) {
      expect(o?.chunk_length_s, "chunk knobs must never move back to the pipeline load").toBeUndefined();
      expect(o?.stride_length_s).toBeUndefined();
    }
  });

  it("transcribePcm keeps the same call-site contract", async () => {
    const audio = await load();
    const text = await audio.transcribePcm(new Float32Array(10 * SR));
    expect(text).toBe("alpha beta");
    expect(hcalls.call.length).toBe(1);
    expect(hcalls.call[0].chunk_length_s).toBe(30);
    expect(hcalls.call[0].stride_length_s).toBe(5);
  });

  it("seam duplicates (same words, overlapping range) collapse to one segment", async () => {
    const audio = await load();
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => null,
    });
    // The mock emits the seam repeat ([0,4] then [1.5,4.5]) — the pipeline
    // must hand the caller ONE segment, not the audience the stutter twice.
    expect(r.segments.length).toBe(1);
    expect(r.segments[0].text).toBe("alpha beta");
  });

  it("dedupeSeamSegments never drops genuine repeats minutes apart", async () => {
    const audio = await load();
    const chorus = [
      { text: "sing along", start: 10, end: 12 },
      { text: "sing along", start: 95, end: 97 }, // same words, NO overlap → keep
    ];
    expect(audio.dedupeSeamSegments(chorus)).toEqual(chorus);
  });
});
