/**
 * Cross-process LLM handoff lease: the TypeScript side of the SAME file that
 * `ruke-core::admission` (Rust) and `ruke_ml.handoff` (Python) consult
 * (2026-11-17 resource-aware handoff amendment, section 5 "coordinate all clients").
 *
 * The shared model endpoint is capacity 1 and its weights live ONCE. A
 * heavyweight OCR/ASR job parks the main model while it runs, and a semaphore
 * inside any single client cannot bound the others (Rust, Node and an
 * independent coding CLI are three different processes). The lease FILE is the
 * authority:
 *
 *   .ai-coordination/llm-handoff.lock
 *
 * Mirrored exactly from ruke-core/src/admission.rs and ruke_ml/handoff.py:
 *   * Fixed-width 512-byte JSON record padded with NULs, so a concurrent
 *     reader never sees a torn write. A writer NEVER truncates it: a record
 *     that does not fit is REFUSED, because a cut JSON document is
 *     indistinguishable from a broken one - and a broken one used to read as
 *     "unlocked".
 *   * Three answers, not one (mirrors ruke_ml.handoff.lease_state):
 *       absent               -> genuinely not held,
 *       unreadable / corrupt -> HELD-UNCERTAIN: a record exists but we cannot
 *                               prove nobody owns it, so we do not take the
 *                               model. The record's OWN file age is the only
 *                               evidence that it was abandoned, and an age
 *                               that cannot be read is UNKNOWN, never zero.
 *       ok                   -> held while its evidence is inside the window.
 *   * Fail-OPEN only on PROOF, and the window is bounded, so a crashed or
 *     broken supervisor can never park the app forever.
 *   * A reader NEVER creates, deletes or rewrites a lease it does not own.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LEASE_REL = ".ai-coordination/llm-handoff.lock";
export const LEASE_RECORD_BYTES = 512;
/** Same default as ruke-core admission::DEFAULT_LEASE_STALE. */
export const LEASE_STALE_MS = Number(process.env.RUKE_HANDOFF_STALE_MS ?? 60_000);

/** How a reader classified the record. "absent" is the only free answer. */
export type LeaseRecordState = "absent" | "unreadable" | "corrupt" | "ok";

/**
 * Raised when a record will not fit the fixed-width slot. Truncating it would
 * silently produce a corrupt record that every reader must then treat as
 * HELD-UNCERTAIN, so the writer fails loudly instead.
 */
export class LeaseRecordTooLarge extends Error {
  constructor(byteLength: number, capacity: number) {
    super(
      `a coordination record needs ${byteLength} bytes but the fixed slot is ` +
        `${capacity}; refusing to write a truncated (unparseable) record`,
    );
    this.name = "LeaseRecordTooLarge";
  }
}

/** Fields a lease needs to stay OWNABLE; everything else is optional payload. */
const CORE_RECORD_KEYS = ["token", "owner", "pid", "pid_created", "phase", "started", "heartbeat"];

export interface LeaseHolder {
  token?: string;
  owner?: string;
  pid?: number;
  phase?: string;
  started?: number;
  heartbeat?: number;
  [key: string]: unknown;
}

export interface LeaseState {
  path: string;
  /** How the record itself was classified (see LeaseRecordState). */
  state: LeaseRecordState;
  /** True while the endpoint is claimed - including when we cannot prove otherwise. */
  held: boolean;
  /** True when the evidence is past the window, i.e. provably abandoned. */
  stale: boolean;
  /** True when a record exists but its holder or age cannot be established. */
  uncertain: boolean;
  /** True when an unreadable/corrupt record is old enough to be abandoned. */
  abandoned: boolean;
  /** Why the answer is what it is - shown in logs and refusals, never a silent skip. */
  proof: string;
  holder: LeaseHolder | null;
  /** Age of the newest evidence in ms (null when it CANNOT be established). */
  ageMs: number | null;
}

export function leasePath(root = process.cwd()): string {
  return path.join(root, LEASE_REL);
}

function statMtimeMs(at: string): number | null {
  try {
    return fs.statSync(at).mtimeMs;
  } catch {
    // An unreadable mtime is an UNKNOWN age, not age zero and not age infinite.
    return null;
  }
}

interface RawRecord {
  state: LeaseRecordState;
  holder: LeaseHolder | null;
  detail: string;
  mtimeMs: number | null;
}

/** ONE reader rule for three very different situations. Never repairs anything. */
function readRecord(at: string): RawRecord {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(at);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { state: "absent", holder: null, detail: "no lease record exists", mtimeMs: null };
    }
    // EISDIR / EPERM / EBUSY / a file that vanished mid-race: as far as this
    // reader can tell a record exists and it cannot read it. That is NOT free.
    return {
      state: "unreadable",
      holder: null,
      mtimeMs: statMtimeMs(at),
      detail:
        `the lease record at ${at} could not be read: ` +
        `${code ?? (error as Error)?.name ?? "error"}: ${(error as Error)?.message ?? String(error)}`,
    };
  }
  const mtimeMs = statMtimeMs(at);
  const end = raw.indexOf(0);
  const text = (end === -1 ? raw : raw.subarray(0, end)).toString("utf8").trim();
  if (!text) {
    return {
      state: "corrupt",
      holder: null,
      mtimeMs,
      detail: "the lease record is blank: a writer created the file and never got a parseable record into it",
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      state: "corrupt",
      holder: null,
      mtimeMs,
      detail: `the lease record is not parseable JSON: ${(error as Error)?.name ?? "error"}`,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      state: "corrupt",
      holder: null,
      mtimeMs,
      detail: `the lease record is ${Array.isArray(value) ? "an array" : typeof value}, not an object`,
    };
  }
  const holder = value as LeaseHolder;
  if (!holder.token && !holder.owner) {
    return {
      state: "corrupt",
      holder,
      mtimeMs,
      detail: "the lease record carries neither a token nor an owner, so no holder can be identified or ruled out",
    };
  }
  return { state: "ok", holder, detail: "record parsed", mtimeMs };
}

/** Read-only inspection. Never creates, never removes. */
export function leaseState(at: string = leasePath()): LeaseState {
  const record = readRecord(at);
  if (record.state === "absent") {
    return {
      path: at, state: "absent", held: false, stale: false, uncertain: false, abandoned: false,
      proof: record.detail, holder: null, ageMs: null,
    };
  }
  const holder = record.holder;
  if (record.state === "unreadable" || record.state === "corrupt") {
    // We know nothing, so we do NOT take the model. The record's own file age
    // is the only evidence that could prove it was abandoned.
    const ageMs = record.mtimeMs === null ? null : Math.max(0, Date.now() - record.mtimeMs);
    const abandoned = ageMs !== null && ageMs > LEASE_STALE_MS;
    const secs = (value: number) => `${Math.round(value / 1000)}s`;
    const proof =
      ageMs === null
        ? `${record.detail}, and its age cannot be established, so no holder can be ` +
          "ruled out and it cannot be aged out"
        : abandoned
          ? `${record.detail} and the file itself is ${secs(ageMs)} old, past the ` +
            `${secs(LEASE_STALE_MS)} window, so it is abandoned`
          : `${record.detail}, so no holder can be ruled out (record age ${secs(ageMs)})`;
    return {
      path: at, state: record.state, held: !abandoned, stale: abandoned, uncertain: true, abandoned,
      proof, holder, ageMs,
    };
  }
  const heartbeat = typeof holder?.heartbeat === "number" ? holder.heartbeat * 1000 : 0;
  const newest = Math.max(heartbeat, record.mtimeMs ?? 0);
  if (!Number.isFinite(newest) || newest <= 0) {
    return {
      path: at, state: "ok", held: true, stale: false, uncertain: true, abandoned: false,
      proof: "the lease record carries no timestamp at all, so no holder can be ruled out and it cannot be aged out",
      holder, ageMs: null,
    };
  }
  const ageMs = Math.max(0, Date.now() - newest);
  if (ageMs > LEASE_STALE_MS) {
    return {
      path: at, state: "ok", held: false, stale: true, uncertain: false, abandoned: true,
      proof: `the newest lease evidence is ${Math.round(ageMs / 1000)}s old, past the ${Math.round(LEASE_STALE_MS / 1000)}s window, so the holder is gone`,
      holder, ageMs,
    };
  }
  return {
    path: at, state: "ok", held: true, stale: false, uncertain: false, abandoned: false,
    proof: `${holder?.owner ?? "unknown"} holds the lease (pid ${holder?.pid ?? "?"}, phase ${holder?.phase ?? "?"}, heartbeat ${Math.round(ageMs / 1000)}s ago)`,
    holder, ageMs,
  };
}

/** Serialize to exactly LEASE_RECORD_BYTES, padding with NULs, NEVER cutting. */
function packRecord(payload: Record<string, unknown>): Buffer {
  const keys = Object.keys(payload).sort();
  const data = Buffer.from(JSON.stringify(payload, keys), "utf8");
  if (data.byteLength > LEASE_RECORD_BYTES) {
    throw new LeaseRecordTooLarge(data.byteLength, LEASE_RECORD_BYTES);
  }
  const out = Buffer.alloc(LEASE_RECORD_BYTES, 0);
  out.set(data, 0);
  return out;
}

/** Drop optional payload, keep the fields that make the lease ownable. */
function coreRecord(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CORE_RECORD_KEYS) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

export interface AcquireResult {
  acquired: boolean;
  /** Empty on success; otherwise why the model is not ours to park. */
  refusal: string;
  state: LeaseState;
  token: string;
}

/**
 * Liveness of a recorded pid. `signal 0` performs the existence check without
 * touching the process: ESRCH means gone, EPERM/EACCES means it exists but is
 * not ours. Anything unprovable counts as ALIVE (fail-safe).
 */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code !== "ESRCH";
  }
}

/**
 * Take exclusive ownership of a parked-model window. Refuses when another
 * client holds a live lease: a foreign lock is never stolen. An abandoned
 * record is only ever removed on PROOF (evidence past the stale window AND a
 * pid that no longer exists), because a crashed supervisor must not lock the
 * product out of the coordinated path forever.
 */
export function acquireLease(owner: string, phase = "waiting", at: string = leasePath()): AcquireResult {
  const token = crypto.randomBytes(16).toString("hex");
  const existing = leaseState(at);
  if (existing.held) {
    return { acquired: false, refusal: `the main model is already parked: ${existing.proof}`, state: existing, token };
  }
  // An abandoned record must not lock the app out forever, but it may only be
  // removed on PROOF that its owner is gone: evidence past the window AND a
  // pid that no longer exists. A live pid stays untouched however quiet it is.
  if (existing.stale && existing.holder) {
    const pid = existing.holder.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      // An old record that never named a pid cannot be aged out by US: the only
      // honest reading is "we cannot prove anybody ever owned it, and we cannot
      // prove nobody does". Only an operator's bounded break-stale may clear it.
      return {
        acquired: false,
        refusal: "the lease record is old but names no pid, so its holder cannot be proven gone",
        state: existing,
        token,
      };
    }
    if (pidAlive(pid)) {
      return {
        acquired: false,
        refusal: `the lease evidence is old but pid ${pid} is still running, so the holder is not provably gone`,
        state: existing,
        token,
      };
    }
    try {
      fs.rmSync(at, { force: true });
    } catch {
      return { acquired: false, refusal: `the abandoned lease record at ${existing.path} could not be removed`, state: existing, token };
    }
  }
  // Pack BEFORE creating anything: an oversized record must never leave a blank
  // or half-written file behind for the next reader to classify as corrupt.
  const now = Date.now() / 1000;
  let record: Buffer;
  try {
    record = packRecord({ token, owner, pid: process.pid, phase, started: now, heartbeat: now });
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    return { acquired: false, refusal: `the lease record cannot be written: ${message}`, state: existing, token };
  }
  try {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    // "wx" = exclusive create: a race loser gets EEXIST instead of a takeover.
    const fd = fs.openSync(at, "wx");
    try {
      fs.writeFileSync(fd, record);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const again = leaseState(at);
    if (again.held) {
      return { acquired: false, refusal: `another client took the lease first: ${again.proof}`, state: again, token };
    }
    if (again.stale) {
      return {
        acquired: false,
        refusal: `a stale lease record exists and this client is not allowed to break it: ${again.proof}`,
        state: again, token,
      };
    }
    const message = (error as Error)?.message ?? String(error);
    return { acquired: false, refusal: `the lease record could not be created: ${message}`, state: again, token };
  }
  return { acquired: true, refusal: "", state: leaseState(at), token };
}

/** Owner-only heartbeat. False when the file is gone or a different token owns it. */
export function heartbeatLease(
  at: string,
  token: string,
  phase?: string,
  extra?: Record<string, unknown>,
): boolean {
  const current = leaseState(at);
  if (!current.holder || current.holder.token !== token) return false;
  const merged = { ...current.holder, ...(extra ?? {}), heartbeat: Date.now() / 1000 } as Record<string, unknown>;
  if (phase) merged.phase = phase;
  try {
    fs.writeFileSync(at, packRecord(merged));
    return true;
  } catch (error) {
    if (error instanceof LeaseRecordTooLarge) {
      // Losing optional progress payload is survivable; losing the record is
      // not. Retry with just the identity fields so the lease stays ownable.
      try {
        fs.writeFileSync(at, packRecord(coreRecord(merged)));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/** Owner-only release. A foreign token is never deleted. */
export function releaseLease(at: string, token: string): boolean {
  const current = leaseState(at);
  if (!current.holder || current.holder.token !== token) return false;
  try {
    fs.rmSync(at, { force: true });
    return true;
  } catch {
    return false;
  }
}
