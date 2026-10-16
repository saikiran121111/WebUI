/**
 * Anatomy fence auto-repair helpers (pure, client-safe).
 *
 * A broken ```anatomy fence is the model's mistake, and only the model can
 * fix it. These helpers locate the broken fence inside an assistant message,
 * phrase its exact validation error as a repair request, and splice the
 * corrected fence back into the same bubble — so the user sees the finished
 * illustration instead of a validation error they cannot act on.
 */
import { anatomySpecSchema } from "../anatomy/anatomySchema";
import { parseJsonFence } from "./schemas";

/** Silent repair rounds per message before the honest error fallback stays. */
export const MAX_FENCE_REPAIRS = 2;

export interface BrokenFence {
  /** Exact validation message to feed back to the model. */
  error: string;
  /** Index in the message content where the fence body starts. */
  bodyStart: number;
  /** Index just past the fence body (at the closing ``` or content end). */
  bodyEnd: number;
  /** False when the fence was cut off mid-stream (no closing ```). */
  closed: boolean;
}

// Fence opener: ```anatomy (plus any attrs) up to its newline — or end of
// content, covering a stream truncated right after the language tag.
const FENCE_OPEN = /```anatomy[^\n]*(?:\n|$)/g;

/** Every ```anatomy fence in `content` that the renderer would reject. */
export function findBrokenAnatomyFences(content: string): BrokenFence[] {
  const broken: BrokenFence[] = [];
  FENCE_OPEN.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = FENCE_OPEN.exec(content))) {
    const bodyStart = open.index + open[0].length;
    const close = content.indexOf("```", bodyStart);
    const closed = close >= 0;
    const bodyEnd = closed ? close : content.length;
    const parsed = parseJsonFence(content.slice(bodyStart, bodyEnd).trim(), anatomySpecSchema);
    if (!parsed.ok) broken.push({ error: parsed.error, bodyStart, bodyEnd, closed });
    if (!closed) break; // an unclosed anatomy fence runs to the end of content
    FENCE_OPEN.lastIndex = close + 3;
  }
  return broken;
}

/**
 * The user turn that shows the model its own exact error. Wording matters:
 * "anatomy illustration" keeps EXPLICIT_INVOCATION firing so the Anatomy
 * skill pack (the JSON contract) is re-injected for the repair turn too.
 */
export function fenceRepairRequest(broken: BrokenFence): string {
  return (
    "Your previous anatomy illustration fence failed validation: " + broken.error +
    " — fix that exact problem and re-emit the COMPLETE corrected fence now. " +
    "Output ONLY the corrected fence in one ```anatomy block: no prose, no explanation, no other changes."
  );
}

/**
 * The first ```anatomy fence body in a repair reply, or null when the model
 * answered with prose — a description of the fix is not a fix.
 */
export function extractAnatomyFenceBody(reply: string): string | null {
  const match = /```anatomy[^\n]*\n([\s\S]*?)(?:```|$)/.exec(reply);
  if (!match) return null;
  const body = match[1].trim();
  return body.length > 0 ? body : null;
}

/** Replace the broken fence's body in `content` with the corrected one. */
export function applyFenceRepair(content: string, broken: BrokenFence, correctedBody: string): string {
  const prefix = content.slice(0, broken.bodyStart);
  if (broken.closed) return prefix + correctedBody + "\n" + content.slice(broken.bodyEnd);
  // The original fence never closed (stream truncated): close the repaired one.
  return prefix + correctedBody + "\n```";
}
