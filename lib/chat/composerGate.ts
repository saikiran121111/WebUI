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

/**
 * F153 (2026-11-24): the SEND-ACCEPTANCE law, shared by every send OWNER.
 * canSend gates the COMPOSER; acceptance is what the owner that starts the
 * turn (hooks/useChat.send) enforces: a turn exists when there is text OR
 * ready evidence — a ready file with no typed text is a complete request
 * ("read this"). The two must AGREE: the 2026-11-24 audit found the gate
 * opening for attachment-only sends while send() silently returned, the tray
 * already emptied by ChatInput — the ready file vanished and nothing was
 * asked. A pending/processing/failed attachment is NOT evidence: acceptance
 * counts ready only, exactly the set ChatInput forwards.
 */
export function acceptsTurn(state: { text: string; attachments: readonly Attachment[] }): boolean {
  return state.text.trim().length > 0 || state.attachments.some(a => a.status === "ready");
}

/**
 * F153 (2026-11-24): the EDIT-ACCEPTANCE law. An edit REWRITES a user turn's
 * text, so an empty (whitespace-only) edit is not an edit: hooks/useChat.edit
 * validates with this BEFORE touching history — previously an empty edit
 * truncated both histories and the resend was refused, destroying the
 * conversation with nothing sent in its place.
 */
export function acceptsEdit(newContent: string): boolean {
  return newContent.trim().length > 0;
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
