/**
 * Persisted browser-task state — the agent's resumable memory.
 *
 * A multi-step browser task survives session/idle closes: the objective,
 * the step log, the completed NON-IDEMPOTENT operations (so a resume
 * never double-submits), the last url/title, the engine, and the waiting
 * state + reason. Persisted at `.data/browser-task.json`.
 *
 * SECURITY: only the whitelisted, non-sensitive shape below is ever
 * written — never passwords, MFA codes, cookies, tokens, or form values.
 * The type system plus the sanitizer in saveTask() enforce this.
 */
import fs from "node:fs";
import path from "node:path";
import { defaultProfileDir } from "./profiles";
import type { BrowserEngine } from "./engineConfig";

const log = (() => {
  try {
    // Optional dep — task persistence must never crash on logging.
    const { childLogger } = require("@/lib/server/logger");
    return childLogger("browser/task-state");
  } catch {
    return { warn: () => {}, info: () => {} };
  }
})();

export type TaskState =
  | "running"
  | "waiting_for_user_action"
  | "waiting_for_login"
  | "waiting_for_confirmation"
  | "recovering"
  | "completed"
  | "failed";

/** Reasons surfaced to the user when the task is waiting. */
export type WaitingReason =
  | "private_account_access_consent"
  | "captcha_or_anti_bot"
  | "mfa_or_passkey"
  | "login_required"
  | "consequential_action_consent"
  | "access_denied"
  | "manual_intervention";

export interface TaskStep {
  /** The action kind only (never its params — no sensitive values). */
  action: string;
  ok: boolean;
  at: number;
}

export interface BrowserTask {
  id: string;
  objective: string;
  state: TaskState;
  steps: TaskStep[];
  /** Signatures of completed non-idempotent ops; resume must not repeat them. */
  completedNonIdempotent: string[];
  url?: string;
  title?: string;
  engine?: BrowserEngine;
  reason?: WaitingReason;
  snapshotId?: number;
  updatedAt: number;
}

const MAX_STEPS = 60;

/**
 * A persisted task only has resume value for a bounded window. Without a
 * TTL, an abandoned flow — or a Playwright fixture run — hijacks every
 * later live session: the standing block keeps telling the model to
 * resume_task a park that belongs to a different page entirely (observed
 * 2026-10-25: fixture `exhausted.html` parked state steered a real
 * "play this song" request into about:blank). Expired = gone, everywhere:
 * loadTask enforces it so stale completed-non-idempotent sigs can never
 * poison skip-if-done either.
 */
export const TASK_TTL_MS = 2 * 60 * 60_000;

/** Same page identity: origin + pathname (query/hash ignored). */
export function sameFlowPage(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.origin !== ub.origin) return false;
    return (
      ua.pathname.replace(/\/+$/, "") === ub.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

/**
 * True when the task demonstrably belongs to a DIFFERENT page than the
 * live tab (or the URL the user just asked for). Absent evidence is NOT a
 * mismatch: a closed browser (no live tab) must never erase a legitimate
 * park waiting on the user.
 */
export function taskFlowMismatch(
  t: BrowserTask,
  liveUrl?: string,
  targetUrl?: string,
): boolean {
  if (!t.url) return false;
  if (liveUrl && !sameFlowPage(t.url, liveUrl)) return true;
  if (!liveUrl && targetUrl && !sameFlowPage(t.url, targetUrl)) return true;
  return false;
}

/** Directive-level staleness for the standing "## Browser agent" block. */
export function isStaleTask(t: BrowserTask, liveUrl?: string): boolean {
  if (Date.now() - t.updatedAt > TASK_TTL_MS) return true;
  if (!t.state.startsWith("waiting_for")) return false;
  if (!liveUrl || !t.url) return false;
  return !sameFlowPage(t.url, liveUrl);
}

function taskFile(): string {
  return path.join(defaultProfileDir(), "..", "browser-task.json");
}

/** Persist fields are whitelisted — nothing else can ever reach disk. */
function sanitize(t: BrowserTask): BrowserTask {
  return {
    id: String(t.id).slice(0, 64),
    objective: String(t.objective).slice(0, 500),
    state: t.state,
    steps: t.steps.slice(-MAX_STEPS).map((s) => ({
      action: String(s.action).slice(0, 40),
      ok: !!s.ok,
      at: s.at,
    })),
    completedNonIdempotent: t.completedNonIdempotent
      .slice(0, 40)
      .map((s) => String(s).slice(0, 160)),
    ...(t.url ? { url: String(t.url).slice(0, 2048) } : {}),
    ...(t.title ? { title: String(t.title).slice(0, 200) } : {}),
    ...(t.engine ? { engine: t.engine } : {}),
    ...(t.reason ? { reason: t.reason } : {}),
    ...(t.snapshotId ? { snapshotId: t.snapshotId } : {}),
    updatedAt: Date.now(),
  };
}

let current: BrowserTask | null = null;
let loaded = false;

export function loadTask(): BrowserTask | null {
  if (loaded) {
    // TTL also applies to the cached copy: a long-lived dev server must
    // not keep serving a day-old task without ever re-reading disk.
    if (current && Date.now() - current.updatedAt > TASK_TTL_MS) {
      current = null;
      try {
        fs.rmSync(taskFile(), { force: true });
      } catch {
        /* best effort */
      }
    }
    return current;
  }
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(taskFile(), "utf8"));
    if (raw && typeof raw === "object" && typeof raw.id === "string") {
      const age = Number(raw.updatedAt) || 0;
      if (age && Date.now() - age > TASK_TTL_MS) {
        current = null; // expired — an old flow must not hijack a new session
        try {
          fs.rmSync(taskFile(), { force: true });
        } catch {
          /* best effort */
        }
      } else {
        current = sanitize(raw as BrowserTask);
      }
    }
  } catch {
    current = null; // absent / corrupt — no resumable task
  }
  return current;
}

export function currentTask(): BrowserTask | null {
  return loadTask();
}

export function startTask(objective: string, engine?: BrowserEngine): BrowserTask {
  const t = sanitize({
    id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    objective: objective || "browser task",
    state: "running",
    steps: [],
    completedNonIdempotent: [],
    ...(engine ? { engine } : {}),
    updatedAt: Date.now(),
  });
  current = t;
  loaded = true;
  persist();
  return t;
}

export function updateTask(patch: Partial<BrowserTask>): BrowserTask | null {
  const t = loadTask();
  if (!t) return null;
  current = sanitize({ ...t, ...patch });
  persist();
  return current;
}

export function logStep(action: string, ok: boolean): void {
  const t = loadTask();
  if (!t) return;
  current = sanitize({ ...t, steps: [...t.steps, { action: action.slice(0, 40), ok, at: Date.now() }] });
  persist();
}

export function markNonIdempotentDone(signature: string): void {
  const t = loadTask();
  if (!t) return;
  const sig = signature.slice(0, 160);
  if (t.completedNonIdempotent.includes(sig)) return;
  current = sanitize({ ...t, completedNonIdempotent: [...t.completedNonIdempotent, sig] });
  persist();
}

export function hasDoneNonIdempotent(signature: string): boolean {
  const t = loadTask();
  return !!t && t.completedNonIdempotent.includes(signature.slice(0, 160));
}

export function clearTask(): void {
  current = null;
  loaded = true;
  try {
    fs.rmSync(taskFile(), { force: true });
  } catch {
    /* nothing to clear */
  }
}

function persist(): void {
  if (!current) return;
  try {
    const file = taskFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n", "utf8");
  } catch (e) {
    log.warn({ err: String(e).slice(0, 120) }, "task-state persist failed (best effort)");
  }
}

/* ── server-side consequential-action authorization ─────────────────────── */
/**
 * A model-issued `authorize_browser_access` fence grants a SHORT-LIVED,
 * single-use authorization token held HERE, on the server. Consequential
 * operations (final submits, payments, sending messages, destructive
 * changes) execute ONLY while a grant is live — a client payload flag
 * (`confirmConsequential:true`) is never sufficient on its own. This is
 * real state the model cannot fabricate from its side of the fence.
 */

const GRANT_TTL_MS = 10 * 60_000;
let grantExpiresAt = 0;

export function grantConsequentialAuthorization(): void {
  grantExpiresAt = Date.now() + GRANT_TTL_MS;
  current = (() => {
    const t = loadTask();
    if (!t) return current;
    return sanitize({ ...t, state: "running", reason: undefined });
  })();
  persist();
}

export function hasConsequentialGrant(): boolean {
  return grantExpiresAt > Date.now();
}

/** Consume a live grant (single-use). Returns false when none is live. */
export function consumeConsequentialGrant(): boolean {
  if (!hasConsequentialGrant()) return false;
  grantExpiresAt = 0;
  return true;
}

export function revokeConsequentialGrant(): void {
  grantExpiresAt = 0;
}

export function requestConfirmation(reason: WaitingReason): void {
  updateTask({ state: "waiting_for_confirmation", reason });
  revokeConsequentialGrant();
}
