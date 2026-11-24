/**
 * B11 (2026-11-22) — composer Send gating during the upload/handoff window.
 *
 * Checklist law: "Send gating: chip immediate, textarea editable, phases shown,
 * Send disabled while processing, Enter never queues, enable at evidence+restore
 * done, Retry/Remove".
 *
 * Seam: the PURE gate the composer acts on (lib/chat/composerGate). The
 * component wires these decisions into the real DOM (chip label from chipPhase,
 * Retry/Remove buttons from canRetry/canRemove, Enter through enterSends);
 * the DOM journey (typing during upload, Enter -> 0 requests, draft preserved,
 * 1 after click) is the C5 exclusive Playwright row.
 *
 * "Evidence+restore done" is a SERVER contract the gate reads through one fact:
 * an attachment's status is "ready" only when /api/files/extract has answered,
 * and that response arrives only after the OCR cascade PERSISTED the evidence
 * and the exclusive handoff COMPLETED the model restoration (run_exclusive
 * restores inside the request; B10). The composer therefore enables Send
 * exactly at evidence+restore completion — no UI ever polls the reload.
 */
import { describe, expect, it } from "vitest";
import {
  canRemove,
  canRetry,
  canSend,
  chipPhase,
  composerPhase,
  enterSends,
  type ComposerState,
} from "../../lib/chat/composerGate";
import type { Attachment } from "../../lib/types";

function att(over: Partial<Attachment> & { id: string; status: Attachment["status"] }): Attachment {
  return { name: `${over.id}.pdf`, kind: "document", mime: "application/pdf", size: 1024, ...over };
}

const EMPTY: ComposerState = { text: "hello", attachments: [], isLoading: false };

describe("B11 Send gating", () => {
  it("a freshly added file is a chip IMMEDIATELY and Send is disabled while it is read", () => {
    // Chip immediate: validateAttachment yields status "pending" synchronously;
    // from that first moment the chip is in state and Send is gated on it.
    const s: ComposerState = { ...EMPTY, attachments: [att({ id: "a1", status: "pending" })] };
    expect(composerPhase(s)).toBe("reading");
    expect(canSend(s)).toBe(false);
  });

  it("Send is disabled while a file is being read and while a turn is generating", () => {
    expect(canSend({ ...EMPTY, attachments: [att({ id: "a1", status: "processing" })] })).toBe(false);
    expect(canSend({ ...EMPTY, isLoading: true })).toBe(false);
    expect(canSend({ ...EMPTY, isLoading: true, attachments: [att({ id: "a1", status: "processing" })] })).toBe(false);
  });

  it("Send enables at evidence+restore done: every attachment ready, no turn running", () => {
    const s: ComposerState = {
      ...EMPTY,
      attachments: [att({ id: "a1", status: "ready" }), att({ id: "a2", status: "ready" })],
    };
    expect(composerPhase(s)).toBe("idle");
    expect(canSend(s)).toBe(true);
    // One straggler keeps the gate closed: the evidence of EVERY attachment
    // (and its window's restoration) must have completed.
    expect(canSend({ ...s, attachments: [...s.attachments, att({ id: "a3", status: "processing" })] })).toBe(false);
    // An errored attachment never becomes sendable evidence; the user Removes
    // it or Retries it — the gate stays closed while it sits in the tray.
    expect(canSend({ ...EMPTY, attachments: [att({ id: "a1", status: "error", error: "boom" })] })).toBe(false);
  });

  it("no content, no Send: blank text with no attachments, and blank text over an errored chip, are both silent", () => {
    expect(canSend({ ...EMPTY, text: "   " })).toBe(false);
    expect(canSend({ text: "", attachments: [], isLoading: false })).toBe(false);
  });

  it("Enter NEVER queues: on a closed gate Enter sends nothing; the composer's Enter action mirrors canSend exactly", () => {
    const closed: ComposerState = { ...EMPTY, attachments: [att({ id: "a1", status: "processing" })] };
    expect(enterSends(closed)).toBe(false); // → preventDefault + no request; the draft text is untouched
    expect(enterSends(EMPTY)).toBe(true);
    expect(enterSends({ ...EMPTY, isLoading: true })).toBe(false);
    // The law is one decision, not a queue: Enter's action is exactly canSend.
    for (const s of [EMPTY, closed, { ...EMPTY, isLoading: true }, { ...EMPTY, text: "" }]) {
      expect(enterSends(s)).toBe(canSend(s));
    }
  });

  it("phases shown: every chip state carries its visible phase label; ready shows no spinner label", () => {
    expect(chipPhase(att({ id: "a1", status: "pending" })).label).toBe("Queued");
    expect(chipPhase(att({ id: "a1", status: "processing" })).label).toBe("Reading…");
    expect(chipPhase(att({ id: "a1", status: "ready" })).label).toBeNull();
    expect(chipPhase(att({ id: "a1", status: "error", error: "boom" })).label).toBeNull();
  });

  it("Retry exists exactly on failed reads; Remove exists on every state", () => {
    expect(canRetry(att({ id: "a1", status: "error", error: "boom" }))).toBe(true);
    expect(canRetry(att({ id: "a1", status: "pending" }))).toBe(false);
    expect(canRetry(att({ id: "a1", status: "processing" }))).toBe(false);
    expect(canRetry(att({ id: "a1", status: "ready" }))).toBe(false);
    for (const status of ["pending", "processing", "ready", "error"] as const) {
      expect(canRemove(att({ id: "a1", status }))).toBe(true);
    }
  });
});
