import type { Attachment } from "../types";

/**
 * B11 (2026-11-22): the composer's Send-gating law, as a pure decision.
 *
 * During the upload/handoff window (a file is being read; on scanned PDFs and
 * audio that read may run inside the exclusive Strata handoff — unload,
 * process, persist evidence, restore the model):
 *  - the chip appears IMMEDIATELY (validateAttachment is synchronous and its
 *    status starts at "pending"; from that moment the gate is closed on it),
 *  - the textarea stays EDITABLE — the gate never touches the draft: no state
 *    here disables typing, and a closed gate leaves the text untouched,
 *  - the chip SHOWS its phase (chipPhase),
 *  - Send is DISABLED while processing and ENABLES at evidence+restore done:
 *    an attachment is "ready" only when /api/files/extract has answered, and
 *    that response arrives only after the evidence was persisted AND the
 *    handoff completed the model restoration inside the request (B10) — the
 *    composer never polls the reload,
 *  - Enter NEVER queues: enterSends IS canSend; a closed gate means Enter is
 *    swallowed (preventDefault, zero requests, draft preserved),
 *  - every chip is REMOVABLE; a failed read is RETRYABLE.
 */

export interface ComposerState {
  /** The raw draft — never trimmed away by the gate. */
  text: string;
  attachments: readonly Attachment[];
  /** A chat turn is generating (the same composer gates a running turn too). */
  isLoading: boolean;
}

export type ComposerPhase = "idle" | "reading" | "generating";

function isReading(att: Attachment): boolean {
  return att.status === "pending" || att.status === "processing";
}

/** What the composer is doing right now; drives the chip title and the gate. */
export function composerPhase(state: ComposerState): ComposerPhase {
  if (state.attachments.some(isReading)) return "reading";
  if (state.isLoading) return "generating";
  return "idle";
}

/**
 * Send enables only with content, NO attachment still being read (evidence of
 * every attachment — and its window's restoration — must be done), and no turn
 * generating. An errored chip keeps the gate closed until it is Removed (or
 * Retried into readiness): half the tray's evidence failed, and shipping a
 * question over a file that was never read is the defect this gate exists for.
 */
export function canSend(state: ComposerState): boolean {
  if (state.text.trim().length === 0 && state.attachments.length === 0) return false;
  if (state.isLoading) return false;
  return state.attachments.every(a => a.status === "ready");
}

/** The Enter law: Enter's action is exactly canSend — never a queue. */
export function enterSends(state: ComposerState): boolean {
  return canSend(state);
}

/** Visible per-chip phase; "ready"/"error" show no spinner label (the error
 *  reason rides the chip's title). */
export function chipPhase(att: Attachment): { label: string | null } {
  switch (att.status) {
    case "pending": return { label: "Queued" };
    case "processing": return { label: "Reading…" };
    default: return { label: null };
  }
}

export function canRetry(att: Attachment): boolean {
  return att.status === "error";
}

export function canRemove(_att: Attachment): boolean {
  return true;
}
