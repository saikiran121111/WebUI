import { describe, it, expect, beforeEach } from "vitest";
import {
  recordBrowserMetric,
  incrementBrowserCounter,
  recordStrategyUse,
  browserTelemetrySnapshot,
  resetBrowserTelemetry,
} from "@/lib/browser/telemetry";

describe("browser telemetry — sanitized, bounded, env-labeled", () => {
  beforeEach(() => resetBrowserTelemetry());

  it("records latency per kind with error counts and percentiles", () => {
    recordBrowserMetric("action:click", 100, true, "local_fixture");
    recordBrowserMetric("action:click", 300, false, "real_browser");
    const s = browserTelemetrySnapshot();
    const k = s.kinds.find((x) => x.kind === "action:click")!;
    expect(k.n).toBe(2);
    expect(k.errors).toBe(1);
    expect(k.max).toBe(300);
    expect(k.p50).toBe(300); // pct(floor(0.5*2)) on [100,300]
    expect(new Set(k.envs)).toEqual(new Set(["local_fixture", "real_browser"]));
    expect(s.counters.actions).toBe(2);
  });

  it("non-action kinds do not inflate the action counter", () => {
    recordBrowserMetric("snapshot", 12, true, "local_fixture");
    expect(browserTelemetrySnapshot().counters.actions).toBe(0);
  });

  it("sample ring is bounded at 100 per kind", () => {
    for (let i = 0; i < 150; i++) recordBrowserMetric("slow", i, true, "mock");
    const k = browserTelemetrySnapshot().kinds.find((x) => x.kind === "slow")!;
    expect(k.n).toBe(100);
    expect(k.max).toBe(149); // oldest samples were dropped
    expect(k.p50).toBeGreaterThanOrEqual(50);
  });

  it("strategy use feeds byStrategy and fallbacksUsed", () => {
    recordStrategyUse("keyboard");
    recordStrategyUse("keyboard");
    recordStrategyUse("visual_grounding");
    const s = browserTelemetrySnapshot();
    expect(s.counters.byStrategy.keyboard).toBe(2);
    expect(s.counters.byStrategy.visual_grounding).toBe(1);
    expect(s.counters.fallbacksUsed).toBe(3);
  });

  it("counters increment (screenshots stay at zero for DOM-only journeys)", () => {
    incrementBrowserCounter("snapshotsTaken", 4);
    incrementBrowserCounter("humanHandoffs");
    incrementBrowserCounter("consequentialBlocked");
    incrementBrowserCounter("consequentialGranted");
    const c = browserTelemetrySnapshot().counters;
    expect(c.snapshotsTaken).toBe(4);
    expect(c.humanHandoffs).toBe(1);
    expect(c.consequentialBlocked).toBe(1);
    expect(c.consequentialGranted).toBe(1);
    expect(c.screenshotsTaken).toBe(0);
  });

  it("negative/float latency is normalized (no bogus stats)", () => {
    recordBrowserMetric("action:navigate", -50, true, "local_fixture");
    recordBrowserMetric("action:navigate", 99.6, true, "local_fixture");
    const k = browserTelemetrySnapshot().kinds.find((x) => x.kind === "action:navigate")!;
    expect(k.max).toBe(100);
  });
});
