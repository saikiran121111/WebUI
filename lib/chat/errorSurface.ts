import type { Message } from "../types";

/**
 * F153 (2026-11-25): the single-visible-status law for turn failures.
 *
 * When a turn settles in error, useChat records the reason on TWO surfaces:
 * the global `error` state (the banner under the message list, the Retry
 * carrier) and the assistant bubble's own `error` field (ChatMessage renders
 * it inside the turn). The live parked-handoff screenshot showed the same
 * refusal TWICE — bubble + banner — which reads as two failures, not one.
 *
 * Law: a terminal turn error shows ONE visible status. The bubble is that
 * status (it carries the reason in the turn's place in the conversation).
 * The banner shows only when the reason is NOT already displayed by the
 * latest assistant message — the banner-only outcomes: truncation, a
 * mid-stream failure, a preflight/refusal before any assistant bubble
 * settled, or a reason from an older turn surfacing after navigation. The
 * banner keeps its Retry affordance for exactly those cases; the bubble has
 * none.
 */
export function showRetryBanner(error: string | null, messages: readonly Message[]): boolean {
  if (!error) return false;
  const last = messages[messages.length - 1];
  return !(
    last
    && last.role === "assistant"
    && last.state === "error"
    && last.error === error
  );
}
