/**
 * ml-job.ts - the TypeScript client for a Python capability JOB.
 *
 * Gap G1 (source-confirmed 2026-11-16): the capability supervisor exposes
 * POST /job and the Rust server published only /api/ruke/ml-status, i.e. the
 * Python video/document capabilities were readable from a status page and
 * reachable from nothing else. This module is the caller half of that seam:
 * the TS side asks the Rust server to run one job, and Rust owns the
 * endpoint, the per-run token and the path law (rust-backend/.../ml_job.rs).
 *
 * Why TS -> Rust -> Python rather than TS -> Python directly:
 *  - one authority for the capability backend (the same reason
 *    lib/server/upstream-bridge.ts routes TS completions through Rust: a
 *    second client would be a second, uncoordinated view of one resource);
 *  - the per-run supervisor token never enters a Node module that also serves
 *    browser code;
 *  - the file-path allowlist is enforced once, in Rust, so no TS call site
 *    can name an arbitrary path.
 *
 * Deliberate behaviour:
 *  - `rustEnabled()` false => returns null IMMEDIATELY and issues no network
 *    call. The TS-only mode (every vitest run, plain `next dev`) is therefore
 *    byte-for-byte unchanged by this module: "no capability backend" is a
 *    configuration fact, not a silent fallback.
 *  - capability state arrives as a TYPED ENVELOPE on HTTP 200 (Rust's law),
 *    so "not configured", "unreachable", "backend said failed" and "we built
 *    a bad request" stay distinguishable to the caller and to the UI.
 *  - a known-bad capability is remembered briefly (NEGATIVE cache) so a
 *    missing backend is not re-probed for every upload; the cached answer
 *    still carries `retryable: true` and the real human step.
 *  - a caller abort is NEVER turned into a backend failure or cached: it is
 *    reported as `cancelled`, the same outcome word the rest of the app uses.
 *  - timers and abort listeners are disposed on every path (R01 law).
 */

import { randomBytes } from "node:crypto";

import { internalSecretHeaders, rustBaseUrl, rustEnabled } from "./rustProxy";

export const ML_JOB_PATH = "/api/ruke/ml/job";
/** Wire contract version shared with ruke_ml/contracts.py and ml_job.rs. */
export const ML_JOB_SCHEMA_VERSION = 1;

/** Mirrors ml_job.rs DEFAULT/MIN/MAX_DEADLINE_SECS and CLIENT_GRACE_SECS. */
export const ML_JOB_DEFAULT_DEADLINE_MS = 120_000;
export const ML_JOB_MIN_DEADLINE_MS = 1_000;
export const ML_JOB_MAX_DEADLINE_MS = 600_000;
export const ML_JOB_GRACE_MS = 5_000;

/** How long a typed capability failure is remembered before asking again. */
export const ML_JOB_NEGATIVE_TTL_MS = 60_000;

export interface MlJobError {
  reason: string;
  message: string;
  retryable: boolean;
  capability: string;
  human_step: string;
}

/** The one envelope shape Rust uses for every capability-level outcome. */
export interface MlJobEnvelope {
  state: string;
  capability: string;
  job_id: string;
  run_id: string;
  request_id: string;
  deadline_s: number;
  source: string;
  error?: MlJobError;
  result?: unknown;
}

export interface MlJobOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
}

const idPart = (): string => randomBytes(9).toString("hex");
const newRunId = (): string => `run_${idPart()}`;

const NEGATIVE_TTL = ML_JOB_NEGATIVE_TTL_MS;
const negative = new Map<string, { at: number; envelope: MlJobEnvelope }>();

/** Test seam: forget remembered capability failures. */
export function resetMlJobNegativeCache(): void {
  negative.clear();
}

/** Reasons worth remembering: the backend/rendezvous is the problem, not us. */
const CACHEABLE_REASONS = new Set([
  "not_configured",
  "invalid_endpoint",
  "unreachable",
  "deadline_exceeded",
  "contract_mismatch",
  "capability_mismatch",
  "resource_busy",
]);

function clampDeadlineMs(ms: number | undefined): number {
  const raw = typeof ms === "number" && Number.isFinite(ms) ? ms : ML_JOB_DEFAULT_DEADLINE_MS;
  return Math.min(ML_JOB_MAX_DEADLINE_MS, Math.max(ML_JOB_MIN_DEADLINE_MS, Math.round(raw)));
}

/**
 * One lifecycle-managed cancellation for the WHOLE call: queue, transport and
 * response-body consumption all obey it, and the timer plus the external
 * listener are removed on every outcome (R01: a deadline that starts after
 * the request started, or a listener that outlives the request, is a leak).
 */
function combineCancellation(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean; abortedExternally: () => boolean } {
  const controller = new AbortController();
  let timeoutHit = false;
  let externalHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    controller.abort(new Error(`the capability job exceeded its ${timeoutMs} ms client deadline`));
  }, timeoutMs);
  timer.unref?.();

  const onExternal = () => {
    externalHit = true;
    const reason = (external as AbortSignal & { reason?: unknown })?.reason;
    controller.abort(reason ?? new Error("the caller cancelled the capability job"));
  };
  if (external) {
    if (external.aborted) onExternal();
    else external.addEventListener("abort", onExternal, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener("abort", onExternal);
    },
    timedOut: () => timeoutHit,
    abortedExternally: () => externalHit,
  };
}

function localEnvelope(
  capability: string,
  runId: string,
  jobId: string,
  requestId: string,
  deadlineS: number,
  reason: string,
  message: string,
  retryable: boolean,
  humanStep: string,
): MlJobEnvelope {
  return {
    state: "unavailable",
    capability,
    job_id: jobId,
    run_id: runId,
    request_id: requestId,
    deadline_s: deadlineS,
    source: "ts-ml-job-client",
    error: { reason, message, retryable, capability, human_step: humanStep },
  };
}

function asEnvelope(value: unknown): MlJobEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== "string" || typeof raw.capability !== "string") return null;
  const error = raw.error && typeof raw.error === "object" ? (raw.error as Record<string, unknown>) : undefined;
  return {
    state: raw.state,
    capability: raw.capability,
    job_id: typeof raw.job_id === "string" ? raw.job_id : "",
    run_id: typeof raw.run_id === "string" ? raw.run_id : "",
    request_id: typeof raw.request_id === "string" ? raw.request_id : "",
    deadline_s: Number.isFinite(Number(raw.deadline_s)) ? Number(raw.deadline_s) : 0,
    source: typeof raw.source === "string" ? raw.source : "rust-ml-job",
    ...(error
      ? {
          error: {
            reason: typeof error.reason === "string" ? error.reason : "internal",
            message: typeof error.message === "string" ? error.message : "the capability job did not complete",
            retryable: error.retryable === true,
            capability: typeof error.capability === "string" ? error.capability : raw.capability,
            human_step: typeof error.human_step === "string" ? error.human_step : "",
          },
        }
      : {}),
    ...("result" in raw ? { result: raw.result } : {}),
  };
}

/**
 * Run one capability job. Returns null ONLY when no capability route exists in
 * this deployment (Rust backend not enabled): the caller then behaves exactly
 * as it did before this seam existed and says so in its own coverage note.
 * Any other outcome is an envelope with a typed reason.
 */
export async function mlJob(
  capability: string,
  payload: Record<string, unknown> = {},
  opts: MlJobOptions = {},
): Promise<MlJobEnvelope | null> {
  if (!rustEnabled()) return null;
  if (typeof capability !== "string" || capability.length === 0) return null;

  const cached = negative.get(capability);
  const now = Date.now();
  if (cached && now - cached.at < NEGATIVE_TTL) return { ...cached.envelope };
  if (cached) negative.delete(capability);

  const deadlineMs = clampDeadlineMs(opts.deadlineMs);
  const deadlineS = Math.round(deadlineMs / 1000);
  const requestId = `req_${idPart()}`;
  const runId = newRunId();
  const jobId = `job_${idPart()}`;

  const cancellation = combineCancellation(opts.signal, deadlineMs + ML_JOB_GRACE_MS);
  try {
    const response = await fetch(`${rustBaseUrl()}${ML_JOB_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...internalSecretHeaders(),
      },
      body: JSON.stringify({
        request_id: requestId,
        run_id: runId,
        job_id: jobId,
        capability,
        payload,
        deadline_s: deadlineS,
        schema_version: ML_JOB_SCHEMA_VERSION,
      }),
      signal: cancellation.signal,
    });

    const text = await response.text();
    if (response.status === 401) {
      // A configuration fault on our side, not a capability verdict: do not
      // cache it, and do not pretend the backend is unavailable.
      return localEnvelope(
        capability, runId, jobId, requestId, deadlineS,
        "unauthorized",
        "the Rust backend refused this internal call (bridge secret mismatch)",
        false,
        "restart `npm run dev` so the supervisor and the backend share one bridge secret",
      );
    }
    const parsed = asEnvelope(JSON.parse(text));
    if (parsed) {
      if (parsed.error && CACHEABLE_REASONS.has(parsed.error.reason)) {
        negative.set(capability, { at: Date.now(), envelope: parsed });
      }
      return parsed;
    }
    // HTTP status + unparsable body: the gate refused us (400/413) or the
    // response is not the agreed contract. Both are named, never swallowed.
    const gate = response.status === 400 || response.status === 413;
    const envelope = localEnvelope(
      capability, runId, jobId, requestId, deadlineS,
      gate ? "input_rejected" : "contract_mismatch",
      gate
        ? `the capability gate refused this request with HTTP ${response.status}: ${text.slice(0, 300)}`
        : `the capability route answered HTTP ${response.status} with a body that is not the job envelope`,
      !gate,
      gate
        ? "this is a programming fault in the caller: report it, do not retry blindly"
        : "check that the Rust backend and this UI were started by the same `npm run dev`",
    );
    if (!gate) negative.set(capability, { at: Date.now(), envelope });
    return envelope;
  } catch (err: unknown) {
    if (cancellation.abortedExternally() || opts.signal?.aborted) {
      return localEnvelope(
        capability, runId, jobId, requestId, deadlineS,
        "cancelled", "the caller cancelled the capability job", false,
        "no action needed: nothing was published",
      );
    }
    if (cancellation.timedOut()) {
      const envelope = localEnvelope(
        capability, runId, jobId, requestId, deadlineS,
        "deadline_exceeded",
        `the capability backend did not answer within ${deadlineMs + ML_JOB_GRACE_MS} ms`,
        true,
        "retry, or ask for a narrower range",
      );
      negative.set(capability, { at: Date.now(), envelope });
      return envelope;
    }
    const envelope = localEnvelope(
      capability, runId, jobId, requestId, deadlineS,
      "unreachable",
      `the Rust backend could not be reached for this job (${(err as Error)?.message ?? "transport error"})`,
      true,
      "restart `npm run dev`; the capability route lives in the Rust server",
    );
    negative.set(capability, { at: Date.now(), envelope });
    return envelope;
  } finally {
    cancellation.dispose();
  }
}
