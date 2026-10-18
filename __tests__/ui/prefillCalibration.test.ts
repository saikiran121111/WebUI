import { describe, it, expect } from "vitest";
import {
  PREFILL_PCT_CAP,
  PREFILL_TPS_DEFAULT,
  PREFILL_TPS_MAX,
  PREFILL_TPS_MIN,
  calibratePrefillTps,
  estimatePrefillPct,
  estimatePromptTokens,
  readPrefillTps,
} from "../../lib/ui/prefillCalibration";

describe("estimatePromptTokens", () => {
  it("counts ~4 chars per token with a floor of 1", () => {
    expect(estimatePromptTokens("")).toBe(1);
    expect(estimatePromptTokens("abcd")).toBe(1);
    expect(estimatePromptTokens("a".repeat(400))).toBe(100);
  });
});

describe("estimatePrefillPct", () => {
  it("starts at 0 and never reaches 100", () => {
    expect(estimatePrefillPct(0, 500, 200)).toBe(0);
    expect(estimatePrefillPct(10_000_000, 500, 200)).toBeLessThanOrEqual(PREFILL_PCT_CAP);
    expect(estimatePrefillPct(10_000_000, 500, 200)).toBeLessThan(100);
  });

  it("returns 0 for unknown prompt size or rate", () => {
    expect(estimatePrefillPct(5000, 0, 200)).toBe(0);
    expect(estimatePrefillPct(5000, 500, 0)).toBe(0);
  });

  it("is monotonic in elapsed time", () => {
    let prev = -1;
    for (let t = 0; t <= 30_000; t += 250) {
      const pct = estimatePrefillPct(t, 800, 200);
      expect(pct).toBeGreaterThanOrEqual(prev);
      prev = pct;
    }
  });

  it("clamps negative elapsed time to 0", () => {
    expect(estimatePrefillPct(-5000, 500, 200)).toBe(0);
  });
});

describe("calibratePrefillTps", () => {
  it("EMA-blends the observed rate (alpha 0.3)", () => {
    // observed = 100 tokens / 1s = 100 tok/s → 0.7*200 + 0.3*100 = 170
    expect(calibratePrefillTps(200, 100, 1000)).toBeCloseTo(170);
  });

  it("clamps the blended rate into the sane range", () => {
    expect(calibratePrefillTps(200, 1_000_000, 10)).toBe(PREFILL_TPS_MAX);
    // One absurdly slow sample drags the EMA down but smoothing keeps it
    // from slamming to the floor in a single step.
    const slow = calibratePrefillTps(200, 1, 60_000);
    expect(slow).toBeGreaterThanOrEqual(PREFILL_TPS_MIN);
    expect(slow).toBeLessThan(200);
    // Sustained slow samples converge and clamp at the floor.
    let tps = 200;
    for (let i = 0; i < 40; i++) tps = calibratePrefillTps(tps, 1, 60_000);
    expect(tps).toBe(PREFILL_TPS_MIN);
  });

  it("keeps the previous rate on garbage input", () => {
    expect(calibratePrefillTps(200, 0, 1000)).toBe(200);
    expect(calibratePrefillTps(200, 100, 0)).toBe(200);
    expect(calibratePrefillTps(200, -5, 1000)).toBe(200);
  });
});

describe("readPrefillTps", () => {
  it("falls back to the default when storage is unavailable (node env)", () => {
    expect(readPrefillTps()).toBe(PREFILL_TPS_DEFAULT);
  });
});
