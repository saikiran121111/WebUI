/**
 * Brief §10 — cache outage degradation vectors.
 *
 * The SQLite cache is an optimization, never a dependency: when the DB is
 * BUSY/corrupt (every prepare() throws below), a READ must degrade to a
 * miss (retrieval continues against the live engines), a WRITE must
 * degrade to no-write (the run's results still reach the caller), and the
 * purge that rides the hot read/write path must never escape into
 * retrieval. The degradation path never wipes user data (purges stay
 * DELETE-based).
 *
 * Hermetic: better-sqlite3 is replaced wholesale — no DB file is opened.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SearchPlan } from "@/lib/web-search/metasearch";

vi.mock("better-sqlite3", () => ({
  default: class BrokenDatabase {
    pragma(): void {}
    exec(): void {}
    prepare(): never {
      throw new Error("SQLITE_BUSY: database is locked");
    }
    close(): void {}
  },
}));

let mod: typeof import("@/lib/web-search/cache");
let warnSpy: ReturnType<typeof vi.spyOn>;

const PLANS = [
  { query: "acme price", freshness: "any", intent: "general", preferredDomains: [] },
] as unknown as SearchPlan[];

beforeEach(async () => {
  vi.resetModules(); // fresh module state per vector (_lastPurgeCheck included)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  mod = await import("@/lib/web-search/cache");
});

afterEach(() => {
  mod?.closeCache();
  vi.restoreAllMocks();
});

const warns = () => warnSpy.mock.calls.map((c) => String(c[0]));

describe("web-search cache outage degradation (brief §10)", () => {
  it("query read degrades to a miss, never rejects", () => {
    expect(mod.getCachedQuery(PLANS)).toBeNull();
    const w = warns();
    expect(w.some((m) => m.includes("query read failed"))).toBe(true);
    // The purge riding the hot path degrades inside maybePurge, before the
    // read even runs — it must not escape into the caller either.
    expect(w.some((m) => m.includes("purge failed"))).toBe(true);
  });

  it("query write degrades to no-write and never throws", () => {
    expect(() =>
      mod.putCachedQuery(
        PLANS,
        [{ url: "https://acme.example/x", title: "x", domain: "acme.example" } as never],
        "any",
      ),
    ).not.toThrow();
    expect(warns().some((m) => m.includes("query write failed"))).toBe(true);
  });

  it("page read degrades to a miss and page write never throws", () => {
    expect(mod.getCachedPage("https://acme.example/x")).toBeNull();
    expect(() =>
      mod.putCachedPage("https://acme.example/x", "signal ".repeat(200), "direct"),
    ).not.toThrow();
    expect(warns().some((m) => m.includes("page write failed"))).toBe(true);
  });

  it("startup purge degrades, but the primitive itself still throws (only wrapped paths degrade)", () => {
    // Boundary law: degradation lives in the wrappers, not in
    // purgeExpiredCache — direct callers keep the real error.
    expect(() => mod.purgeExpiredCache()).toThrow(/SQLITE_BUSY/);
    expect(() => mod.startPurgeSweep()).not.toThrow();
    expect(warns().some((m) => m.includes("startup purge failed"))).toBe(true);
  });
});
