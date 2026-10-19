import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Production hardening for the Whisper path:
 *  (a) segment timestamps stay on ONE continuous master timeline across
 *      multi-chunk recordings past 180 s (never reset to 0..30 per chunk);
 *  (b) the three-stage VRAM lifecycle ALWAYS lands on a working CPU
 *      pipeline when the GPU is absent, full, or its CUDA provider is
 *      missing — transcription never crashes — and the LLM reload hook
 *      fires in the finally block even when the GPU attempt failed.
 * The transformers pipeline is mocked (CUDA attempts throw); the VRAM probe
 * is injected through the documented stage-option seams, so no nvidia-smi
 * dependency and no real model download in these tests.
 */

const hcalls = vi.hoisted(() => ({ pipeline: [] as any[] }));

vi.mock("@huggingface/transformers", () => ({
  pipeline: async (_task: string, _model: string, opts: any) => {
    hcalls.pipeline.push(opts);
    if (opts?.device === "cuda") {
      throw new Error("CUDAExecutionProvider is not available in this ONNX build");
    }
    const asr: any = async () => ({
      text: "the turbine hums at ninety one hertz",
      chunks: [
        { text: "the turbine hums", timestamp: [0, 1.5] },
        { text: "at ninety one hertz", timestamp: [1.5, 3.2] },
      ],
    });
    asr.dispose = async () => {};
    return asr;
  },
  env: {},
}));

const SR = 16000;

beforeEach(() => {
  hcalls.pipeline.length = 0;
  vi.resetModules(); // fresh module singletons (cudaBroken, cpuAsrPromise) per test
});

const load = () => import("../lib/server/extract/audio");

describe("continuous timestamp guard (multi-chunk offsets past 180 s)", () => {
  it("keeps a 7-chunk recording continuous when every chunk resets to 0..30", async () => {
    const { normalizeSegmentTimeline } = await load();
    const reset = Array.from({ length: 7 }, (_, k) => ({
      text: `chunk ${k}`,
      start: 0,
      end: 30,
    }));
    const fixed = normalizeSegmentTimeline(reset);
    expect(fixed[0].start).toBe(0);
    expect(fixed[6].start).toBe(180);
    expect(fixed[6].end).toBe(210);
    for (let k = 1; k < fixed.length; k++) {
      expect(fixed[k].start).toBeGreaterThanOrEqual(fixed[k - 1].start);
      expect(fixed[k].start).toBeLessThanOrEqual(fixed[k - 1].end! + 6);
    }
  });

  it("leaves legitimate stride overlaps and already-continuous timelines untouched", async () => {
    const { normalizeSegmentTimeline } = await load();
    const legit = [
      { text: "a", start: 0, end: 35 },
      { text: "b", start: 30, end: 65 }, // 5 s stride overlap — legitimate
      { text: "c", start: 60, end: 95 },
      { text: "d", start: 180, end: 210 },
    ];
    expect(normalizeSegmentTimeline(legit)).toEqual(legit);
  });

  it("planWindows flags pure-silence 30 s windows; rmsOf measures energy", async () => {
    const { planWindows, rmsOf } = await load();
    const pcm = new Float32Array(200 * SR);
    for (let w = 0; w < 200; w += 60) {
      // 30 s of tone, then 30 s of silence, alternating
      const base = w * SR;
      for (let i = base; i < base + 30 * SR; i++) pcm[i] = 0.05 * Math.sin(i * 0.1);
    }
    const plan = planWindows(pcm);
    expect(plan.length).toBe(7); // ceil(200 / 30)
    // 180-200 s is a 20 s tone tail (the w=180 tone is clipped by the buffer).
    expect(plan.map(p => p.silent)).toEqual([false, true, false, true, false, true, false]);
    expect(rmsOf(pcm, 0, 30 * SR)).toBeGreaterThan(0.01);
    expect(rmsOf(pcm, 30 * SR, 60 * SR)).toBe(0);
  });

  it("offsetSegments accumulates window offsets onto the master timeline", async () => {
    const { offsetSegments } = await load();
    const segs = [{ text: "x", start: 1, end: 2.5 }];
    const shifted = [0, 30, 60, 90, 120, 150, 180].map(o => offsetSegments(segs, o)[0]);
    expect(shifted.map(s => s.start)).toEqual([1, 31, 61, 91, 121, 151, 181]);
    expect(offsetSegments([{ text: "n", start: 5, end: null }], 120)[0].end).toBeNull();
  });
});

describe("three-stage VRAM lifecycle: automatic CPU fallback", () => {
  it("no NVIDIA GPU (probe null) → CPU pipeline answers, never throws", async () => {
    const audio = await load();
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => null,
    });
    expect(r.text).toContain("ninety one hertz");
    expect(hcalls.pipeline.some(o => o?.device === "cpu")).toBe(true);
    expect(hcalls.pipeline.some(o => o?.device === "cuda")).toBe(false);
  });

  it("GPU present but busy and no unload hook → stays on CPU", async () => {
    const audio = await load();
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => 500,
      unload: async () => false,
    });
    expect(r.text).toBeTruthy();
    expect(hcalls.pipeline.every(o => o?.device !== "cuda")).toBe(true);
  });

  it("9 GB free but CUDA provider missing → clean fallback to CPU (stage 3)", async () => {
    const audio = await load();
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => 9000,
    });
    // GPU was attempted with the requested cuda/fp16 config…
    expect(hcalls.pipeline.some(o => o?.device === "cuda" && o?.dtype === "fp16")).toBe(true);
    // …and the failure was caught, not thrown: CPU answered instead.
    expect(r.text).toContain("turbine");
    expect(r.segments.length).toBe(2);
  });

  it("unload frees VRAM → GPU attempted; reload fires in finally even when GPU fails", async () => {
    const audio = await load();
    let reloads = 0;
    const probes = [500, 2000];
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => probes.shift() ?? 500,
      unload: async () => true,
      reload: async () => { reloads++; },
    });
    expect(hcalls.pipeline.some(o => o?.device === "cuda")).toBe(true);
    expect(r.text).toBeTruthy(); // CPU caught the failed GPU attempt
    expect(reloads).toBe(1); // the LLM always comes back
  });

  it("unload attempted but VRAM still tight → CPU used, LLM still reloaded", async () => {
    const audio = await load();
    let reloads = 0;
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => 500,
      unload: async () => true,
      reload: async () => { reloads++; },
    });
    expect(hcalls.pipeline.every(o => o?.device !== "cuda")).toBe(true);
    expect(reloads).toBe(1);
    expect(r.text).toBeTruthy();
  });
});
