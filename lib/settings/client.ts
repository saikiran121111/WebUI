/**
 * Client-side settings bridge. Reads the shared settings.json values that the
 * server has already merged (via /api/settings) and exposes an optimistic
 * update() so the Settings UI feels instant.
 */

import type { CompactThresholds } from "../chat/compactConfig";

export interface LlmSettings {
  llm_api_url?: string;
  llm_api_key?: string;
  /** Auto-compact threshold + on/off flag (see lib/chat/compactConfig.ts). */
  compact_thresholds?: CompactThresholds;
  /**
   * The ASR preference. The final decision (2026-11-22) froze ONE engine —
   * the pinned Parakeet below — so the UI shows it fixed and the server
   * migrates any obsolete stored value to it VISIBLY (app/api/settings/
   * route.ts, settings_routes.rs). Model IDs, never paths.
   */
  speech_model?: string;
  /** The named OCR engine; unset/"" means the PaddleOCR default. */
  ocr_engine?: "paddle" | "tesseract" | "";
}

/**
 * The frozen English ASR engine. Parity: PARAKEET_ID in
 * python-backend/ruke_ml/models/registry.py and FIXED_SPEECH_MODEL in
 * rust-backend/crates/ruke-server/src/settings_routes.rs.
 */
export const FIXED_SPEECH_MODEL = "nvidia/parakeet-tdt-0.6b-v3";

let cached: LlmSettings | null = null;
let inFlight: Promise<LlmSettings> | null = null;
/**
 * The retired ASR preference the server migrated to the fixed engine on the
 * LAST settings read, when one was migrated ("migrate an obsolete ASR
 * preference VISIBLY to Parakeet"). Null when nothing was migrated.
 */
let engineMigrationNotice: string | null = null;

export function getEngineMigrationNotice(): string | null {
  return engineMigrationNotice;
}

/** Returns the current settings (fetched once, cached for the session). */
export function fetchSettings(force = false): Promise<LlmSettings> {
  if (!force && cached) return Promise.resolve(cached);
  if (!force && inFlight) return inFlight;
  inFlight = fetch("/api/settings")
    .then((r) => r.json())
    .then((data: any) => {
      cached = (data?.settings ?? {}) as LlmSettings;
      engineMigrationNotice =
        typeof data?.speech_model_migrated === "string" && data.speech_model_migrated
          ? data.speech_model_migrated
          : null;
      inFlight = null;
      return cached;
    })
    .catch(() => {
      cached = {};
      inFlight = null;
      return {} as LlmSettings;
    });
  return inFlight;
}

/**
 * F153 (2026-11-24) — the settings/client STATUS law. On HEAD saveSettings
 * never looked at `res.ok`: a failed PUT committed the optimistic patch to
 * the session cache and RESOLVED, so every caller's success path ran (and
 * EnginesSettings' fire-and-forget radio showed the engine as selected)
 * while settings.json kept the old value. A non-2xx response is a FAILED
 * save: throw before touching any cache state; the caller's catch is the
 * honest outcome.
 */
export class SettingsSaveError extends Error {
  constructor(public readonly status: number) {
    super(`Settings save failed: HTTP ${status}`);
    this.name = "SettingsSaveError";
  }
}

/**
 * Saves settings (PUT) and updates the in-memory cache immediately so the UI
 * reflects the change without re-fetching. Throws SettingsSaveError on a
 * non-2xx response WITHOUT committing the cache (F153 status law).
 */
export async function saveSettings(patch: LlmSettings): Promise<LlmSettings> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SettingsSaveError(res.status);
  cached = (data?.settings ?? patch) as LlmSettings;
  engineMigrationNotice =
    typeof data?.speech_model_migrated === "string" && data.speech_model_migrated
      ? data.speech_model_migrated
      : null;
  return cached;
}

/** Deletes settings.json and clears the local cache. Same status law. */
export async function clearSettingsRemote(): Promise<void> {
  const res = await fetch("/api/settings", { method: "DELETE" });
  if (!res.ok) throw new SettingsSaveError(res.status);
  cached = {};
}
