import { describe, it, expect } from "vitest";
import {
  BUILD_CRAWL_TARGET,
  BUILD_STAGES,
  stagedPctAt,
  stageLabelFor,
} from "../../lib/ui/stagedProgress";

describe("stagedPctAt", () => {
  it("is 0 at (and before) the start", () => {
    expect(stagedPctAt(0)).toBe(0);
    expect(stagedPctAt(-100)).toBe(0);
  });

  it("hits the ramp breakpoints exactly", () => {
    expect(stagedPctAt(400)).toBe(30);
    expect(stagedPctAt(1500)).toBe(70);
    expect(stagedPctAt(4000)).toBe(90);
  });

  it("interpolates linearly between breakpoints", () => {
    expect(stagedPctAt(950)).toBe(50); // midpoint of 400→1500 (30→70)
  });

  it("is monotonic across the whole schedule", () => {
    let prev = -1;
    for (let t = 0; t <= 120_000; t += 250) {
      const pct = stagedPctAt(t);
      expect(pct).toBeGreaterThanOrEqual(prev);
      prev = pct;
    }
  });

  it("crawls up to the crawl target and never past it", () => {
    expect(stagedPctAt(10_000)).toBeGreaterThan(90);
    expect(stagedPctAt(10_000)).toBeLessThan(BUILD_CRAWL_TARGET);
    expect(stagedPctAt(1_000_000)).toBe(BUILD_CRAWL_TARGET);
  });
});

describe("stageLabelFor", () => {
  it("walks the stage list as the ramp crosses thresholds", () => {
    expect(stageLabelFor(0)).toBe("Starting the engine…");
    expect(stageLabelFor(29)).toBe("Starting the engine…");
    expect(stageLabelFor(30)).toBe("Laying out pages…");
    expect(stageLabelFor(70)).toBe("Rendering charts…");
    expect(stageLabelFor(90)).toBe("Finalizing file…");
    expect(stageLabelFor(100)).toBe("Finalizing file…");
  });

  it("every stage label is reachable by the ramp", () => {
    const seen = new Set<string>();
    for (let t = 0; t <= 60_000; t += 100) seen.add(stageLabelFor(stagedPctAt(t)));
    for (const s of BUILD_STAGES) expect(seen.has(s.label), s.label).toBe(true);
  });
});
