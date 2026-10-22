/**
 * Token accounting for the auto-compact pipeline.
 *
 * The shared inference backend reports real `usage` on assistant messages
 * (prompt_tokens / completion_tokens), but a conversation's FIRST turn has no
 * usage yet and a user turn never carries one. So the count of "how many
 * tokens is this conversation" is a hybrid:
 *
 *   1. Real usage when the server reported it (assistant messages).
 *   2. A character heuristic for everything else (~4 chars/token, the same
 *      ratio the progress engine uses for its ETA baselines).
 *
 * The heuristic is an ESTIMATE and is labelled as one in the UI badge. It
 * only has to be good enough to answer "has this conversation grown past the
 * user's threshold" — the compaction itself is a real LLM call.
 */

import type { Message } from "../types";

/** Average characters per token for mixed prose + code. */
export const CHARS_PER_TOKEN = 4;

/** Estimate the token cost of one message's text. */
export function estimateMessageTokens(message: {
  role: string;
  content: string;
  reasoning?: string;
  attachments?: Array<{ text?: string; transcript?: string; spine?: string; name?: string }>;
}): number {
  let chars = message.content?.length ?? 0;
  chars += message.reasoning?.length ?? 0;
  for (const att of message.attachments ?? []) {
    chars += att.text?.length ?? 0;
    chars += att.transcript?.length ?? 0;
    chars += att.spine?.length ?? 0;
    chars += att.name?.length ?? 0;
  }
  // Every message carries role + framing overhead on the wire.
  return Math.ceil(chars / CHARS_PER_TOKEN) + 4;
}

/**
 * The token cost of a whole conversation.
 *
 * `usage.promptTokens` is the real prompt size the server measured for that
 * turn — but it counts the WHOLE prompt (including the tail and the system
 * block), so summing it across turns double-counts. It is therefore only
 * consulted as a sanity floor for the most recent turn; the running total
 * itself is built from per-message estimates so it stays monotonic and
 * comparable to the threshold the user picked.
 */
export function estimateConversationTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateMessageTokens({
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      attachments: m.attachments,
    });
  }
  return total;
}

/** Format a token count the way the UI badge shows it: 128.4k, 5.2k, 940. */
export function formatTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1000) return String(n);
  // One decimal place, drop a trailing .0 (10000 -> "10k", 128400 -> "128.4k").
  const k = (n / 1000).toFixed(1);
  return (k.endsWith(".0") ? k.slice(0, -2) : k) + "k";
}
