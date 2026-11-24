/**
 * F21 lifecycle law: ONE heavyweight in-process resource (headless Chromium,
 * an ONNX embedder, a CPU speech pipeline), owned by this process, with a
 * single set of rules that the ad-hoc `let promise: Promise<T> | null`
 * singletons got wrong:
 *
 * 1. A resource that died is never handed out again. The old singletons kept
 *    a resolved promise forever, so after a browser crash or a disconnected
 *    pipeline every later render reused a dead handle.
 * 2. Weights/renders must not stay resident forever. An idle TTL releases the
 *    resource when nothing holds it; `0` means "release the moment it goes
 *    idle" (memory pressure), a negative TTL opts out.
 * 3. Releasing is only ever allowed while NOTHING is in flight, and a release
 *    mid-flight is deferred, never forced — a cancelled upload must not destroy
 *    the pipeline another upload is still using.
 * 4. Exactly-once destroy: create failure, idle release, external invalidation
 *    ("disconnected"), shutdown and a create that resolves after its
 *    generation was invalidated all take one and only one ownership path.
 * 5. Every transition is observable, so capability reporting states what is
 *    actually resident instead of claiming "zero heavy models at idle".
 *
 * The decision functions are pure and clock-injected so the law is testable
 * without timers or real models.
 */

/** Idle policy: ms; 0 = release as soon as it is idle; negative = never release. */
export type IdleTtl = number;

/** Parse an operator-set idle TTL. Unset/invalid keeps the caller's default. */
export function parseIdleTtl(raw: string | undefined | null, fallback: IdleTtl): IdleTtl {
  if (raw === undefined || raw === null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "off" || v === "none" || v === "never" || v === "-1") return -1;
  if (v === "0" || v === "now" || v === "immediate") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export interface IdleDecision {
  action: "none" | "release" | "arm";
  delayMs: number;
}

/**
 * The pure law. `resident` means the resource is held right now; in-flight
 * work always beats the TTL; force overrides the TTL (explicit shutdown) but
 * never overrides in-flight work.
 */
export function idleReleaseDecision(args: {
  now: number;
  lastUsed: number;
  inFlight: number;
  idleTtlMs: IdleTtl;
  resident: boolean;
  force?: boolean;
}): IdleDecision {
  const { now, lastUsed, inFlight, idleTtlMs, resident, force } = args;
  if (!resident) return { action: "none", delayMs: 0 };
  if (inFlight > 0) return { action: "none", delayMs: 0 };
  if (force) return { action: "release", delayMs: 0 };
  if (idleTtlMs < 0) return { action: "none", delayMs: 0 };
  const due = lastUsed + idleTtlMs;
  if (now >= due) return { action: "release", delayMs: 0 };
  return { action: "arm", delayMs: due - now };
}

export type OwnedResourceEventKind =
  | "created"
  | "create_failed"
  | "released"
  | "discarded"
  | "destroy_failed"
  | "no_destroy_api";

export interface OwnedResourceEvent {
  name: string;
  kind: OwnedResourceEventKind;
  /** Consecutive create failures right now (0 after a success). */
  failures: number;
  reason?: string;
}

export interface TimerHandle {
  cancel(): void;
}

export interface OwnedResourceOptions<T> {
  name: string;
  create: () => Promise<T>;
  /**
   * Best-effort teardown. Absent means the loaded object exposes nothing we
   * can call to reclaim it — recorded as `no_destroy_api` rather than silently
   * pretending the memory came back.
   */
  destroy?: (value: T) => unknown | Promise<unknown>;
  idleTtlMs: IdleTtl;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  /** Called once per successful create, e.g. to wire a "disconnected" event. */
  onCreated?: (value: T) => void;
  onEvent?: (event: OwnedResourceEvent) => void;
}

export interface OwnedResourceState {
  name: string;
  resident: boolean;
  starting: boolean;
  held: number;
  failures: number;
  idleTtlMs: IdleTtl;
  closed: boolean;
}

function defaultSetTimer(cb: () => void, ms: number): TimerHandle {
  const t = setTimeout(cb, ms) as unknown as TimerHandle & { unref?: () => void };
  // Never keep the process alive just to reclaim memory.
  try {
    (t as { unref?: () => void }).unref?.();
  } catch {
    /* not a Node timer (browser/test shim) — nothing to unref */
  }
  return { cancel: () => clearTimeout(t as unknown as ReturnType<typeof setTimeout>) };
}

function reasonOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * A resource the process owns. `use()` is the ONLY way to touch it, which is
 * what makes the idle rule enforceable: the lease is held across the whole
 * operation, so a TTL can never fire mid-render.
 */
export class OwnedResource<T> {
  private value: T | null = null;
  private hasValue = false;
  private creating: Promise<T> | null = null;
  private releasing: Promise<void> | null = null;
  private inFlight = 0;
  private lastUsed = 0;
  private failures = 0;
  private closed = false;
  private timer: TimerHandle | null = null;
  private generation = 0;
  /** Shutdown happened while a lease was live; the last lease out tears down. */
  private pendingClose = false;

  constructor(private readonly opts: OwnedResourceOptions<T>) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private emit(kind: OwnedResourceEventKind, reason?: string): void {
    try {
      this.opts.onEvent?.({ name: this.opts.name, kind, failures: this.failures, reason });
    } catch {
      /* telemetry must never break the owner */
    }
  }

  private clearTimer(): void {
    if (!this.timer) return;
    try {
      this.timer.cancel();
    } catch {
      /* already fired */
    }
    this.timer = null;
  }

  /** Run `fn` with the resource, holding one lease for its whole duration. */
  async use<R>(fn: (value: T) => Promise<R> | R): Promise<R> {
    if (this.closed) throw new Error(`${this.opts.name}: resource has been shut down`);
    this.inFlight++;
    this.lastUsed = this.now();
    this.clearTimer();
    try {
      const value = await this.ensure();
      this.lastUsed = this.now();
      return await fn(value);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastUsed = this.now();
      if (this.closed && this.inFlight === 0) {
        // Shutdown raced this lease: it owns the teardown, because nothing else
        // may destroy a resource that was still in use a moment ago.
        void this.teardown("closed during lease").catch(() => {
          /* best-effort */
        });
      } else {
        this.schedule();
      }
    }
  }

  private async ensure(): Promise<T> {
    // Sequential with any in-progress teardown: never create while destroying.
    while (this.releasing) {
      try {
        await this.releasing;
      } catch {
        /* release is best-effort */
      }
    }
    if (this.hasValue) return this.value as T;
    if (this.creating) return this.creating;

    const generation = this.generation;
    const pending = (async (): Promise<T> => {
      try {
        const created = await this.opts.create();
        if (generation !== this.generation || this.closed) {
          // Invalidated while starting (disconnect, shutdown, forced release):
          // destroy what we just loaded instead of publishing a dead handle.
          await this.destroyQuietly(created, "invalidated while starting");
          throw new Error(`${this.opts.name}: invalidated while starting`);
        }
        this.value = created;
        this.hasValue = true;
        this.failures = 0;
        this.emit("created");
        try {
          this.opts.onCreated?.(created);
        } catch {
          /* event wiring is best-effort; a later discard recovers the slot */
        }
        return created;
      } catch (e) {
        if (generation === this.generation && !this.closed) {
          this.failures++;
          this.emit("create_failed", reasonOf(e));
        }
        throw e;
      } finally {
        if (generation === this.generation) this.creating = null;
      }
    })();
    this.creating = pending;
    return pending;
  }

  /** Returns true only when a teardown actually ran and did not throw. */
  private async destroyQuietly(value: T, reason: string): Promise<boolean> {
    if (typeof this.opts.destroy === "function") {
      try {
        await this.opts.destroy(value);
        return true;
      } catch (e) {
        this.emit("destroy_failed", `${reason}: ${reasonOf(e)}`);
      }
    } else {
      this.emit("no_destroy_api", reason);
    }
    return false;
  }

  /** Destroy whatever is held, exactly once. Returns false if nothing was held. */
  private async teardown(reason: string): Promise<boolean> {
    if (!this.hasValue) return false;
    this.generation++;
    const victim = this.value as T;
    this.value = null;
    this.hasValue = false;
    this.creating = null;
    const run = (async () => {
      // "released" is only reported when a teardown really ran. A failed or
      // unavailable destroy is a real gap, and calling it released would be a lie.
      if (await this.destroyQuietly(victim, reason)) this.emit("released", reason);
    })();
    this.releasing = run;
    try {
      await run;
    } finally {
      if (this.releasing === run) this.releasing = null;
    }
    return true;
  }

  /**
   * External invalidation: the resource died on its own (Chromium's
   * "disconnected", an ONNX session that errored out). The slot drops
   * immediately so the NEXT use creates a fresh one; the dead object is not
   * destroyed (it is already gone).
   */
  discard(reason = "invalidated"): void {
    this.generation++;
    this.value = null;
    this.hasValue = false;
    this.creating = null;
    this.clearTimer();
    // Bumping the generation is what makes a create that finishes AFTER this
    // call destroy itself instead of publishing a handle that is already dead.
    // A holder whose work is still in flight is not torn down here: their
    // operation fails on its own (a disconnected page errors), and their lease
    // end performs whatever teardown is owed.
    this.emit("discarded", reason + (this.inFlight > 0 ? " (held)" : ""));
  }

  /**
   * Reclaim the resource if the law allows it. Returns true only when this call
   * actually owned and destroyed it. `force` (explicit shutdown/pressure) skips
   * the TTL but still never destroys a resource that is in use.
   */
  async releaseIdle(opts: { now?: number; force?: boolean } = {}): Promise<boolean> {
    const now = opts.now ?? this.now();
    const decision = idleReleaseDecision({
      now,
      lastUsed: this.lastUsed,
      inFlight: this.inFlight,
      idleTtlMs: this.opts.idleTtlMs,
      resident: this.hasValue,
      force: opts.force,
    });
    if (decision.action !== "release") return false;
    this.clearTimer();
    return this.teardown("idle release");
  }

  private schedule(): void {
    const decision = idleReleaseDecision({
      now: this.now(),
      lastUsed: this.lastUsed,
      inFlight: this.inFlight,
      idleTtlMs: this.opts.idleTtlMs,
      resident: this.hasValue,
    });
    if (decision.action === "none") {
      this.clearTimer();
      return;
    }
    if (decision.action === "release") {
      this.clearTimer();
      void this.releaseIdle().catch(() => {
        /* best-effort reclaim; the next use/release retries */
      });
      return;
    }
    this.clearTimer();
    const setTimer = this.opts.setTimer ?? defaultSetTimer;
    this.timer = setTimer(() => {
      this.timer = null;
      void this.releaseIdle().catch(() => {
        /* retry on the next transition */
      });
    }, decision.delayMs);
  }

  /** Explicit shutdown. Idempotent; later use() calls fail fast. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.clearTimer();
    while (this.releasing) {
      try {
        await this.releasing;
      } catch {
        /* ignore */
      }
    }
    if (this.inFlight > 0) {
      // A shutdown while work is in flight: the lease is still live, so the
      // owner's finally-block teardown performs the destroy. Never destroy
      // something still in use.
      this.pendingClose = true;
      return;
    }
    await this.teardown("closed");
  }

  state(): OwnedResourceState {
    return {
      name: this.opts.name,
      resident: this.hasValue,
      starting: this.creating !== null,
      held: this.inFlight,
      failures: this.failures,
      idleTtlMs: this.opts.idleTtlMs,
      closed: this.closed,
    };
  }

  get resident(): boolean {
    return this.hasValue;
  }
}
