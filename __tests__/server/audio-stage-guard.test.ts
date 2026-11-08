import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * I13: the three-stage VRAM lifecycle used to make its stage decision
 * OUTSIDE the try — a throwing nvidia-smi probe or a hung LLM-unload hook
 * crashed the whole upload with no CPU fallback and left the LLM unloaded.
 * These tests drive the seams adversarially: probes that THROW, unload
 * hooks that THROW, and prove transcription still answers from CPU and the
 * LLM always comes back. I15: cancelling must stop the window loop.
 * Mock pattern follows __tests__/hardening-audio.test.ts (CUDA attempts
 * throw; fresh module singletons per test).
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
      chunks: [{ text: "the turbine hums", timestamp: [0, 1.5] }],
    });
    asr.dispose = async () => {};
    return asr;
  },
  env: {},
}));

const SR = 16000;

beforeEach(() => {
  hcalls.pipeline.length = 0;
  vi.resetModules(); // fresh cudaBroken / cpuAsrPromise per test
});

const load = () => import("../../lib/server/extract/audio");

describe("stage machinery can never crash the upload (I13)", () => {
  it("VRAM probe THROWS (nvidia-smi exploded) → CPU answers, no CUDA attempt", async () => {
    const audio = await load();
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => {
        throw new Error("nvidia-smi exploded");
      },
    });
    expect(r.text).toContain("turbine");
    expect(hcalls.pipeline.some(o => o?.device === "cuda")).toBe(false);
    expect(hcalls.pipeline.some(o => o?.device === "cpu")).toBe(true);
  });

  it("LLM-unload hook THROWS → still counts as attempted, VRAM re-probed, reload fires once, CPU answers", async () => {
    const audio = await load();
    let reloads = 0;
    const probes = [500, 500]; // before + after the (failed) unload
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => probes.shift() ?? 500,
      unload: async () => {
        throw new Error("unload endpoint hung up");
      },
      reload: async () => {
        reloads++;
      },
    });
    expect(r.text).toBeTruthy();
    expect(hcalls.pipeline.some(o => o?.device === "cuda")).toBe(false);
    expect(reloads).toBe(1); // the LLM ALWAYS comes back, even on machinery failure
  });

  it("RELOAD hook also THROWS → transcription result still stands (finally swallows)", async () => {
    const audio = await load();
    const r = await audio.transcribePcmSegments(new Float32Array(10 * SR), {
      probe: async () => 500,
      unload: async () => true,
      reload: async () => {
        throw new Error("reload hook down");
      },
    });
    expect(r.text).toContain("turbine");
  });

  it("file-window loop aborts promptly on cancel (I15)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const audio = await load();
    // 60 s worth of samples in a tiny stand-in file: the abort check runs at
    // each window head BEFORE any read, so the bogus file is never parsed.
    const tmp = path.join(process.cwd(), ".data", "tmp", "cancel_probe.f32");
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, Buffer.alloc(4));
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      await expect(
        audio.transcribePcmFile(tmp, 60 * SR, {
          probe: async () => null,
          signal: ctrl.signal,
        }),
      ).rejects.toThrow(/cancelled/i);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
