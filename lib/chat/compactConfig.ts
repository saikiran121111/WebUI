/**
 * Auto-compact configuration — one module so the SettingsMenu UI, the chat
 * hook, and the compaction pipeline can never drift apart on thresholds,
 * presets, or validation.
 *
 * The user's choice lives in settings.json like llm_api_url — the server owns
 * the file (lib/server/settings.ts), the client mirrors it with an in-memory
 * cache so the chat hook can read the threshold on every send() without a
 * network round-trip.
 */

export interface CompactThresholds {
  /** 1 = auto-compact ON at `tokens` tokens; 0 = auto-compact OFF. */
  auto: 0 | 1;
  /** Token threshold that triggers auto-compaction (0 disables it). */
  tokens: number;
}

/** Pre-validated presets surfaced in the Settings UI (token counts). */
export const COMPACT_PRESETS: number[] = [32_000, 64_000, 128_000, 256_000];

/** Bound for a user-entered custom threshold. */
export const COMPACT_CUSTOM_MIN = 8_000;
export const COMPACT_CUSTOM_MAX = 1_000_000;

const SETTINGS_KEY = "compact_thresholds";

/**
 * In-memory mirror of the user's threshold choice. Set on save; refreshed
 * from the server on first use. Unset = off ({auto:0,tokens:0}) — the user
 * has not enabled auto-compact yet.
 */
let cache: CompactThresholds | null = null;

export function loadCompactThresholds(): CompactThresholds {
  return cache ?? { auto: 0, tokens: 0 };
}

export async function fetchCompactThresholds(): Promise<CompactThresholds> {
  if (cache) return cache;
  try {
    const r = await fetch("/api/settings");
    const data = (await r.json()) as { settings?: Record<string, unknown> };
    cache = compactThresholdsFromSettings(data.settings ?? {});
  } catch {
    cache = { auto: 0, tokens: 0 };
  }
  return cache;
}

/**
 * Push a freshly-saved value into the module cache immediately. Without this
 * the chat hook's gate (fetchCompactThresholds returns the cache once
* primed) could keep using stale thresholds after a mid-session save.
 */
export function primeCompactThresholds(t: CompactThresholds): void {
  cache = { auto: t.auto === 1 ? 1 : 0, tokens: Math.max(0, Math.round(t.tokens || 0)) };
}

export async function saveCompactThresholds(t: CompactThresholds): Promise<CompactThresholds> {
  cache = t;
  try {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [SETTINGS_KEY]: t }),
    });
  } catch {
    // The in-memory value still applies for this session; next fetch
    // re-reads from disk.
  }
  return t;
}

/**
 * Read the stored thresholds out of a raw settings object (as returned by
 * /api/settings). The chat UI's sole source of truth for the user's choice.
 */
export function compactThresholdsFromSettings(settings: Record<string, unknown>): CompactThresholds {
  const v = settings[SETTINGS_KEY];
  if (v && typeof v === "object" && "auto" in v && "tokens" in v) {
    const o = v as Partial<CompactThresholds>;
    return {
      auto: o.auto === 1 ? 1 : 0,
      tokens: typeof o.tokens === "number" ? Math.max(0, Math.round(o.tokens)) : 0,
    };
  }
  return { auto: 0, tokens: 0 };
}

/** Clamp a user-entered custom value into the [8k, 1M] window. */
export function clampCustom(tokens: number): number {
  const n = Math.round(Number(tokens));
  if (!Number.isFinite(n)) return COMPACT_CUSTOM_MIN;
  return Math.min(Math.max(n, COMPACT_CUSTOM_MIN), COMPACT_CUSTOM_MAX);
}

/** Validate a free-form entry; false = out of the custom range. */
export function isValidCustom(tokens: number): boolean {
  const n = Math.round(Number(tokens));
  return Number.isFinite(n) && n >= COMPACT_CUSTOM_MIN && n <= COMPACT_CUSTOM_MAX;
}
