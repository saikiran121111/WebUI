/**
 * Polls GET /api/ruke/ml-status for the UI without ever lying about the backend.
 *
 * Ownership rules (all under test):
 *  - at most ONE request in flight; a response older than the newest request is
 *    DISCARDED, so a slow reply can never overwrite a newer one;
 *  - stop() aborts the in-flight request and clears the timer, and any response
 *    that still arrives afterwards is ignored (unmount safety);
 *  - repeated failures back off up to a ceiling instead of retrying in a tight
 *    loop, and a backend that is simply "not configured" is still a normal
 *    answer: it is reported, not retried harder;
 *  - the poller never fabricates a snapshot: on transport failure the last honest
 *    view is kept and the failure is reported separately.
 */
import { ML_STATUS_ENDPOINT, interpretMlStatus, type BackendView } from "./capabilityStatus";

export type FetchLike = (input: string, init?: { signal?: AbortSignal; cache?: "no-store" }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface MlStatusPollerOptions {
  url?: string;
  intervalMs?: number;
  /** Failure backoff ceiling; the first failure already waits intervalMs. */
  maxIntervalMs?: number;
  fetchImpl?: FetchLike;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  onView: (view: BackendView) => void;
  onTransportFailure?: (info: { attempts: number; message: string; nextDelayMs: number }) => void;
}

export class MlStatusPoller {
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly onView: (view: BackendView) => void;
  private readonly onTransportFailure?: MlStatusPollerOptions["onTransportFailure"];

  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private requestSeq = 0;
  private appliedSeq = -1;
  private attempts = 0;
  private stopped = true;
  private inFlight = false;

  constructor(options: MlStatusPollerOptions) {
    this.url = options.url ?? ML_STATUS_ENDPOINT;
    this.intervalMs = Math.max(250, options.intervalMs ?? 5000);
    this.maxIntervalMs = Math.max(this.intervalMs, options.maxIntervalMs ?? 30_000);
    const impl = options.fetchImpl ?? ((input, init) => fetch(input, init) as Promise<never>);
    this.fetchImpl = impl;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.onView = options.onView;
    this.onTransportFailure = options.onTransportFailure;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  /** Immediate refresh (a retry button), still respecting one-in-flight. */
  refreshNow(): void {
    if (this.stopped) return;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;
    this.inFlight = false;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /** Newest request number that was actually applied to the view. */
  appliedSequence(): number {
    return this.appliedSeq;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    const seq = ++this.requestSeq;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const res = await this.fetchImpl(this.url, { signal: controller.signal, cache: "no-store" });
      if (this.stopped || seq < this.appliedSeq || seq !== this.requestSeq) return; // stale answer
      if (!res.ok) {
        this.fail(`status endpoint answered HTTP ${res.status}`);
        return;
      }
      const body = await res.json();
      if (this.stopped || seq < this.appliedSeq || seq !== this.requestSeq) return;
      this.attempts = 0;
      this.appliedSeq = seq;
      this.onView(interpretMlStatus(body));
      this.schedule(this.intervalMs);
    } catch (err) {
      if (this.stopped) return;                       // our own abort - not a failure to report
      if ((err as { name?: string })?.name === "AbortError") return;
      this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight = false;
      if (this.controller === controller) this.controller = null;
    }
  }

  private fail(message: string): void {
    this.attempts += 1;
    const delay = Math.min(this.maxIntervalMs, this.intervalMs * Math.min(8, 2 ** (this.attempts - 1)));
    this.onTransportFailure?.({ attempts: this.attempts, message, nextDelayMs: delay });
    this.schedule(delay);
  }
}
