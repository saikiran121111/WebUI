/**
 * Live token meter for the composer footer ("Speed: 56.45 tk/s ·
 * Context: 3456/131072").
 *
 * Every number is real server data — nothing is hardcoded:
 *   • max context  = llama.cpp n_ctx, read server-side from /props
 *     (see app/api/model-stats/route.ts).
 *   • context used = the last completed turn's usage.promptTokens +
 *     usage.completionTokens (exact, measured by the inference server and
 *     already persisted on assistant messages), or — while a turn streams —
 *     the slot's live n_prompt_tokens (exact) plus a char-based estimate of
 *     the output still arriving (this llama.cpp build exposes no live
 *     generated-token counter; /slots only reports the prompt size).
 *   • speed = timings.predicted_per_second from the server's final usage
 *     frame (exact), or, mid-stream, real tokens ÷ real wall-clock since the
 *     first delta.
 *
 * `source` labels which kind of number the user is looking at so the UI can
 * be honest about precision:
 *   "exact"    — server-measured (usage frames, /slots, /props)
 *   "measured" — live mid-stream merge (exact prompt + measured output rate)
 *   "estimate" — char heuristic fallback (same ~4 chars/token as tokens.ts)
 */

import type { Message } from "../types";
import { CHARS_PER_TOKEN } from "./tokens";

export type MeterSource = "exact" | "measured" | "estimate" | null;

export interface TokenMeterSnapshot {
  /** Model context window (llama.cpp n_ctx); null until /props is read. */
  maxContext: number | null;
  /** Tokens currently filling the model-side context for this chat. */
  contextUsed: number | null;
  /** Output tokens/second. */
  speedTps: number | null;
  /** How the displayed numbers were obtained (see header). */
  source: MeterSource;
  /** False when the model server's /props was unreachable. */
  backendOk: boolean;
}

/** The most recent REAL usage in the conversation (model-side numbers). */
export function latestRealUsage(messages: Message[]): { used: number; tps: number | null } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const u = m.usage;
    if (!u || typeof u.promptTokens !== "number") continue;
    const completion = typeof u.completionTokens === "number" ? u.completionTokens : 0;
    return {
      used: u.promptTokens + completion,
      tps: typeof u.tokensPerSecond === "number" && u.tokensPerSecond > 0
        ? u.tokensPerSecond
        : null,
    };
  }
  return null;
}

/** Tokens represented by `chars` of streamed text (same heuristic as tokens.ts). */
export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil((chars || 0) / CHARS_PER_TOKEN));
}

/**
 * Real output rate: estimated tokens of everything received ÷ REAL elapsed
 * wall-clock since the first delta. Null until there is something to measure.
 */
export function measureLiveSpeed(charsReceived: number, elapsedMs: number): number | null {
  if (charsReceived <= 0 || elapsedMs < 100) return null;
  const tokens = charsReceived / CHARS_PER_TOKEN;
  return tokens / (elapsedMs / 1000);
}

/** "56.45" — always two decimals so the footer never jitters width. */
export function formatSpeedTps(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  return n.toFixed(2);
}

/** Raw token count ("3456"); null → em dash. */
export function formatTokenCount(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(Math.max(0, Math.round(n)));
}

export function meterText(s: TokenMeterSnapshot): string {
  return (
    `Speed: ${formatSpeedTps(s.speedTps)} tk/s · ` +
    `Context: ${formatTokenCount(s.contextUsed)}/${formatTokenCount(s.maxContext)}`
  );
}

/** Honest provenance tooltip — how each displayed number was obtained. */
export function meterTooltip(s: TokenMeterSnapshot): string {
  if (!s.backendOk) return "Model server unreachable — live token stats unavailable.";
  switch (s.source) {
    case "measured":
      return "Live stats: context = prompt tokens measured by the server + the arriving output measured from the stream; speed = tokens ÷ real elapsed time. Exact server numbers appear the moment the turn completes.";
    case "exact":
      return "Server-measured: tokens/sec and context size come from the inference server's own usage report for this chat.";
    case "estimate":
      return "Estimated from the conversation text (~4 chars/token); exact server numbers appear after the next completed turn.";
    default:
      return "Live token stats.";
  }
}
