/**
 * In-process title job queue.
 *
 * - One job at a time GLOBALLY (a serial chain): a background title call must
 *   never compete with the user's active inference on the single shared slot.
 * - One job per conversation, with coalescing: a request that lands mid-job
 *   sets `pending` and the job loops once more on the freshest history.
 * - Bounded retries (2 attempts), then the last valid title simply stays.
 * - The guarded write (policy.applyTitleToDoc) makes an older job losing the
 *   race against a newer one impossible, even across queued generations.
 *
 * Jobs are deliberately NOT tied to any HTTP request's abort signal: the
 * title job is background work that must survive the client navigating away.
 * They ARE tied to the shared inference-slot registry (lib/server/
 * inference-busy): a job waits while a user turn is active, and a user turn
 * that starts mid-call aborts the in-flight title fetch — the user always
 * owns the single llama.cpp slot (observed: an unbounded title call held
 * the slot and starved the next user stream for minutes).
 */

import { childLogger } from "../logger";
import { getConversationOnDisk, saveConversationOnDisk } from "../../persistence/disk";
import { registerTitleCall, unregisterTitleCall, waitForUserIdle } from "../inference-busy";
import { applyTitleToDoc, looksAutoTitle, firstUserText, shouldGenerate } from "./policy";
import { planTitle, type CallModel } from "./generate";

const log = childLogger("titles/queue");

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 3000;
/** How long a job waits for the user's slot to free up before giving up
 * (the next user turn re-requests the title anyway). */
const IDLE_WAIT_MS = 30_000;

export interface TitleJobResult {
  ok: boolean;
  title?: string;
  reason?: string;
}

export interface TitleRequestOutcome {
  status: "queued" | "coalesced" | "skipped";
  reason?: string;
  done?: Promise<TitleJobResult>;
}

interface Entry {
  running: boolean;
  pending: boolean;
  done: Promise<TitleJobResult> | null;
}

const entries = new Map<string, Entry>();

/** Serial chain: title calls never overlap each other or pile up. */
let chain: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseDoc(raw: string | null): any | null {
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

/** Read-modify-write the stored doc under the policy guard. */
function writeTitle(id: string, title: string, genCount: number): boolean {
  const doc = parseDoc(getConversationOnDisk(id));
  if (!doc) return false;
  if (!applyTitleToDoc(doc, title, genCount)) return false;
  saveConversationOnDisk(id, JSON.stringify(doc));
  return true;
}

async function runJob(id: string, model?: string, callModel?: CallModel): Promise<TitleJobResult> {
  const doc = parseDoc(getConversationOnDisk(id));
  if (!doc) return { ok: false, reason: "not-found" };
  const msgs = Array.isArray(doc.messages) ? doc.messages : [];
  const genCount = msgs.length;

  // Initial title only once a meaningful assistant reply exists.
  if (!msgs.some((m: any) => m?.role === "assistant" && String(m?.content ?? "").trim())) {
    return { ok: false, reason: "no-assistant-reply" };
  }

  // The user's conversation always owns the shared inference slot: wait for
  // an idle window, and yield instantly if a turn starts mid-call.
  if (!(await waitForUserIdle(IDLE_WAIT_MS))) {
    return { ok: false, reason: "user-inference-busy" };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    registerTitleCall(ctrl);
    let title: string | null;
    try {
      title = await planTitle(msgs, { model, callModel, signal: ctrl.signal });
    } finally {
      unregisterTitleCall(ctrl);
    }
    if (ctrl.signal.aborted) {
      // A real user turn claimed the slot mid-call. Never retry into the
      // user's traffic — the next turn's request re-runs this job.
      log.info({ id }, "title job yielded to user inference");
      return { ok: false, reason: "yielded-to-user" };
    }
    if (title) {
      if (writeTitle(id, title, genCount)) {
        log.info({ id, title, genCount, attempt }, "title generated");
        return { ok: true, title };
      }
      // Guard rejected: manual rename or a newer generation already landed.
      return { ok: false, reason: "stale-or-manual" };
    }
    log.warn({ id, attempt }, "title generation produced nothing usable");
    if (attempt + 1 < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return { ok: false, reason: "generation-failed" };
}

function startJob(id: string, model?: string, callModel?: CallModel): Promise<TitleJobResult> {
  const e = entries.get(id)!;
  const task = chain.then(async (): Promise<TitleJobResult> => {
    let result: TitleJobResult = { ok: false, reason: "gone" };
    do {
      e.pending = false;
      result = await runJob(id, model, callModel);
    } while (e.pending); // a newer request landed mid-job — rerun on fresh history
    e.running = false;
    entries.delete(id);
    return result;
  });
  chain = task.catch(() => {});
  e.done = task;
  return task;
}

/**
 * Ask for a title refresh. Eligibility is decided from the STORED document
 * (the server owns titles; the client cannot smuggle state). `force` (the
 * backfill path) additionally requires the current title to be auto or
 * legacy-auto — a title that looks user-authored is never touched.
 */
export function requestTitleGeneration(
  id: string,
  opts: { model?: string; force?: boolean; callModel?: CallModel } = {},
): TitleRequestOutcome {
  const doc = parseDoc(getConversationOnDisk(id));
  if (!doc) return { status: "skipped", reason: "not-found" };
  const meta = doc.meta ?? {};
  if (meta.titleSource === "manual") return { status: "skipped", reason: "manual" };

  const msgs = Array.isArray(doc.messages) ? doc.messages : [];
  if (opts.force) {
    const auto =
      meta.titleSource === "auto" || looksAutoTitle(String(meta.title ?? ""), firstUserText(msgs));
    if (!auto) return { status: "skipped", reason: "not-auto-title" };
  } else if (!shouldGenerate(meta, msgs.length, false)) {
    return { status: "skipped", reason: "fresh" };
  }

  let e = entries.get(id);
  if (e?.running) {
    e.pending = true;
    return { status: "coalesced", done: e.done ?? undefined };
  }
  if (!e) {
    e = { running: true, pending: false, done: null };
    entries.set(id, e);
  } else {
    e.running = true;
  }
  return { status: "queued", done: startJob(id, opts.model, opts.callModel) };
}

/** Test seam: drop all queue state. */
export function resetTitleQueue(): void {
  entries.clear();
  chain = Promise.resolve();
}
