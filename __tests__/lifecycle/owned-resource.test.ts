import { describe, expect, it, vi } from "vitest";
import {
  OwnedResource,
  idleReleaseDecision,
  parseIdleTtl,
  type OwnedResourceEvent,
} from "@/lib/lifecycle/ownedResource";

/**
 * F21 — the lifecycle law every heavyweight singleton in this repo used to
 * break (bare `let promise: Promise<T> | null`): a dead handle handed out
 * forever, weights resident forever, and teardown racing a live user.
 * Everything here is offline: the "resource" is a counter.
 */

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
  };
}

describe("parseIdleTtl - operator switch", () => {
  it("keeps the fallback when unset or unparseable", () => {
    expect(parseIdleTtl(undefined, 60_000)).toBe(60_000);
    expect(parseIdleTtl("", 60_000)).toBe(60_000);
    expect(parseIdleTtl("soon", 60_000)).toBe(60_000);
    expect(parseIdleTtl("-40", 60_000)).toBe(60_000);
    expect(parseIdleTtl(null, 5)).toBe(5);
  });
  it("understands never / immediate / plain ms", () => {
    expect(parseIdleTtl("never", 60_000)).toBe(-1);
    expect(parseIdleTtl("off", 60_000)).toBe(-1);
    expect(parseIdleTtl("0", 60_000)).toBe(0);
    expect(parseIdleTtl("immediate", 60_000)).toBe(0);
    expect(parseIdleTtl("2500", 60_000)).toBe(2500);
    expect(parseIdleTtl("2500.9", 60_000)).toBe(2500);
  });
});

describe("idleReleaseDecision - the pure law", () => {
  it("never releases what is not resident or what is in use", () => {
    expect(
      idleReleaseDecision({ now: 1000, lastUsed: 0, inFlight: 0, idleTtlMs: 10, resident: false }),
    ).toEqual({ action: "none", delayMs: 0 });
    expect(
      idleReleaseDecision({ now: 10_000, lastUsed: 0, inFlight: 2, idleTtlMs: 10, resident: true }),
    ).toEqual({ action: "none", delayMs: 0 });
  });
  it("a negative TTL opts out of auto-release, force does not opt out of in-flight", () => {
    expect(
      idleReleaseDecision({ now: 10_000, lastUsed: 0, inFlight: 0, idleTtlMs: -1, resident: true }),
    ).toEqual({ action: "none", delayMs: 0 });
    expect(
      idleReleaseDecision({ now: 0, lastUsed: 0, inFlight: 0, idleTtlMs: -1, resident: true, force: true }),
    ).toEqual({ action: "release", delayMs: 0 });
    expect(
      idleReleaseDecision({ now: 0, lastUsed: 0, inFlight: 1, idleTtlMs: -1, resident: true, force: true }),
    ).toEqual({ action: "none", delayMs: 0 });
  });
  it("arms when not yet due, releases when due", () => {
    expect(
      idleReleaseDecision({ now: 50, lastUsed: 0, inFlight: 0, idleTtlMs: 100, resident: true }),
    ).toEqual({ action: "arm", delayMs: 50 });
    expect(
      idleReleaseDecision({ now: 100, lastUsed: 0, inFlight: 0, idleTtlMs: 100, resident: true }),
    ).toEqual({ action: "release", delayMs: 0 });
  });
});

function makeResource(opts: {
  create?: () => Promise<number>;
  destroy?: (v: number) => unknown;
  idleTtlMs?: number;
  clock?: ReturnType<typeof makeClock>;
  events?: OwnedResourceEvent[];
  setTimer?: (cb: () => void, ms: number) => { cancel(): void };
} = {}) {
  const clock = opts.clock ?? makeClock();
  const events = opts.events ?? [];
  let created = 0;
  const res = new OwnedResource<number>({
    name: "probe",
    idleTtlMs: opts.idleTtlMs ?? -1,
    now: clock.now,
    setTimer: opts.setTimer,
    create:
      opts.create ??
      (async (): Promise<number> => {
        created++;
        return created;
      }),
    destroy: opts.destroy,
    onEvent: (e) => events.push(e),
  });
  return { res, clock, events, createdCount: () => created };
}

describe("OwnedResource - one create shared, one owner", () => {
  it("two concurrent uses create exactly once", async () => {
    let slowRelease: (() => void) | null = null;
    let invocations = 0;
    const r = makeResource({
      create: () => {
        invocations++;
        return new Promise((resolve) => {
          slowRelease = () => resolve(1);
        });
      },
    });
    const a = r.res.use(async () => 10);
    const b = r.res.use(async () => 20);
    await Promise.resolve();
    slowRelease!();
    expect(await a).toBe(10);
    expect(await b).toBe(20);
    expect(invocations).toBe(1);
  });

  it("a create failure is retryable and counted, never cached", async () => {
    let attempt = 0;
    const events: OwnedResourceEvent[] = [];
    const r = makeResource({
      events,
      create: async () => {
        attempt++;
        if (attempt === 1) throw new Error("download failed");
        return attempt;
      },
    });
    await expect(r.res.use(async () => 0)).rejects.toThrow("download failed");
    expect(r.res.state().failures).toBe(1);
    expect(r.res.state().resident).toBe(false);
    await expect(r.res.use(async (v) => v)).resolves.toBe(2);
    expect(r.res.state().failures).toBe(0);
    expect(events.filter((e) => e.kind === "create_failed")).toHaveLength(1);
  });

  it("the lease spans the whole operation, so a TTL can never fire underneath it", async () => {
    const clock = makeClock();
    const destroyed: number[] = [];
    const r = makeResource({
      clock,
      idleTtlMs: 10,
      destroy: (v) => {
        destroyed.push(v);
      },
    });
    let insideReleaseTried = false;
    await r.res.use(async () => {
      clock.advance(10_000); // longer than the TTL, still inside the lease
      insideReleaseTried = await r.res.releaseIdle({ now: clock.now(), force: true });
      return 1;
    });
    expect(insideReleaseTried).toBe(false);
    expect(destroyed).toEqual([]);
    // ...and it does get reclaimed the moment the lease ends.
    expect(await r.res.releaseIdle({ now: clock.now(), force: true })).toBe(true);
    expect(destroyed).toEqual([1]);
  });

  it("TTL 0 releases as soon as the work ends (memory pressure)", async () => {
    const events: OwnedResourceEvent[] = [];
    const destroyed: number[] = [];
    const r = makeResource({
      events,
      idleTtlMs: 0,
      destroy: (v) => {
        destroyed.push(v);
      },
    });
    await r.res.use(async () => 7);
    await vi.waitFor(() => {
      expect(destroyed).toEqual([1]);
    });
    expect(r.res.state().resident).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(["created", "released"]);
  });

  it("arms an idle timer instead of busy-releasing", async () => {
    const armed: number[] = [];
    let fired: (() => void) | null = null;
    const destroyed: number[] = [];
    const r = makeResource({
      idleTtlMs: 500,
      destroy: (v) => {
        destroyed.push(v);
      },
      setTimer: (cb, ms) => {
        armed.push(ms);
        fired = cb;
        return { cancel: () => {} };
      },
    });
    await r.res.use(async () => 1);
    expect(armed).toEqual([500]);
    expect(destroyed).toEqual([]);
    // The law is time-based: firing the timer before it is due must NOT release.
    fired!();
    expect(destroyed).toEqual([]);
    r.clock.advance(500);
    fired!();
    await vi.waitFor(() => {
      expect(destroyed).toEqual([1]);
    });
  });

  it("a discarded (dead) resource is never handed out again", async () => {
    const r = makeResource();
    await r.res.use(async (v) => v);
    expect(r.res.state().resident).toBe(true);
    r.res.discard("browser disconnected");
    expect(r.res.state().resident).toBe(false);
    await r.res.use(async (v) => v);
    expect(r.createdCount()).toBe(2);
  });

  it("a create that resolves AFTER invalidation is destroyed, not published", async () => {
    const destroyed: number[] = [];
    let release: ((v: number) => void) | null = null;
    const r = makeResource({
      create: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      destroy: (v) => {
        destroyed.push(v);
      },
    });
    const use = r.res.use(async (v) => v).catch((e: unknown) => (e as Error).message);
    await Promise.resolve();
    r.res.discard("died while starting");
    release!(42);
    expect(await use).toContain("invalidated while starting");
    expect(destroyed).toEqual([42]);
    expect(r.res.state().resident).toBe(false);
    expect(r.res.state().failures).toBe(0); // an invalidation is not a model failure
  });

  it("close() destroys once, is idempotent, and refuses later use", async () => {
    let destroyCalls = 0;
    const r = makeResource({
      idleTtlMs: 0,
      destroy: () => {
        destroyCalls++;
      },
    });
    await r.res.use(async () => 1);
    await r.res.close();
    await r.res.close();
    expect(destroyCalls).toBe(1);
    expect(r.res.state().closed).toBe(true);
    await expect(r.res.use(async () => 1)).rejects.toThrow("has been shut down");
  });

  it("close() with work in flight never destroys what is still in use", async () => {
    let destroyCalls = 0;
    const r = makeResource({
      idleTtlMs: 0,
      destroy: () => {
        destroyCalls++;
      },
    });
    let markInnerDone: (() => void) | null = null;
    const inner = r.res.use(
      () =>
        new Promise<number>((resolve) => {
          markInnerDone = () => resolve(1);
        }),
    );
    // Let the create finish first: closing while a resource is merely STARTING
    // is a different (already pinned) case where the launch is destroyed.
    await vi.waitFor(() => expect(r.res.state().resident).toBe(true));
    await r.res.close();
    expect(destroyCalls).toBe(0);
    markInnerDone!();
    await inner;
    // The still-live lease performed the teardown on its way out.
    expect(destroyCalls).toBe(1);
  });

  it("a teardown with no destroy API is reported, not faked", async () => {
    const events: OwnedResourceEvent[] = [];
    const r = makeResource({ idleTtlMs: 0, events });
    await r.res.use(async () => 1);
    await vi.waitFor(() => {
      expect(events.map((e) => e.kind)).toEqual(["created", "no_destroy_api"]);
    });
  });

  it("a throwing teardown is recorded as destroy_failed and still drops the slot", async () => {
    const events: OwnedResourceEvent[] = [];
    const r = makeResource({
      events,
      idleTtlMs: 0,
      destroy: () => {
        throw new Error("dispose exploded");
      },
    });
    await r.res.use(async () => 1);
    await vi.waitFor(async () => {
      expect(events.map((e) => e.kind)).toEqual(["created", "destroy_failed"]);
    });
    expect(r.res.state().resident).toBe(false);
  });
});
