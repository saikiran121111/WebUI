/**
 * Prefill progress calibration (pure, unit-testable).
 *
 * The OpenAI-compatible backend exposes no prefill ("reading the prompt")
 * progress events, so the UI estimates it client-side: elapsed time × a
 * self-calibrating tokens/s rate over an estimated prompt size. The rate is
 * an EMA updated from ground truth at the END of every stream — the `usage`
 * SSE event carries the real `promptTokens`, and we measured the exact
 * time-to-first-token — persisted in localStorage so the estimate tightens
 * with every conversation.
 */

export const PREFILL_TPS_KEY = "webui.prefillTpsV1";
export const PREFILL_TPS_DEFAULT = 200;
export const PREFILL_TPS_MIN = 10;
export const PREFILL_TPS_MAX = 5000;
export const PREFILL_EMA_ALPHA = 0.3;
/** The bar never shows 100% before the first token actually lands. */
export const PREFILL_PCT_CAP = 95;

function clampTps(v: number): number {
  return Math.min(PREFILL_TPS_MAX, Math.max(PREFILL_TPS_MIN, v));
}

export function readPrefillTps(): number {
  try {
    const raw = globalThis.localStorage?.getItem(PREFILL_TPS_KEY);
    if (!raw) return PREFILL_TPS_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? clampTps(v) : PREFILL_TPS_DEFAULT;
  } catch {
    return PREFILL_TPS_DEFAULT; // SSR / storage disabled
  }
}

export function writePrefillTps(tps: number): void {
  try {
    globalThis.localStorage?.setItem(PREFILL_TPS_KEY, String(clampTps(tps)));
  } catch { /* SSR / storage disabled — estimate just stays at the default */ }
}

/** EMA blend of the previous rate with the freshly measured one. */
export function calibratePrefillTps(prevTps: number, promptTokens: number, prefillMs: number): number {
  if (!(promptTokens > 0) || !(prefillMs > 0)) return prevTps;
  const observed = promptTokens / (prefillMs / 1000);
  if (!Number.isFinite(observed) || observed <= 0) return prevTps;
  return clampTps(prevTps * (1 - PREFILL_EMA_ALPHA) + observed * PREFILL_EMA_ALPHA);
}

/**
 * Saturating 0–95% estimate: linear early, easing toward the cap so the bar
 * keeps visibly moving even when the token estimate was too low.
 */
export function estimatePrefillPct(elapsedMs: number, estTokens: number, tps: number): number {
  if (!(estTokens > 0) || !(tps > 0)) return 0;
  const raw = ((Math.max(0, elapsedMs) / 1000) * tps) / estTokens;
  return Math.round(PREFILL_PCT_CAP * (1 - Math.exp(-1.5 * raw)));
}

/** Rough token count for the outgoing prompt (~4 chars/token). */
export function estimatePromptTokens(text: string): number {
  return Math.max(1, Math.round((text ?? "").length / 4));
}
