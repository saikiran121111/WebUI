/**
 * Client-side settings bridge. Reads the shared settings.json values that the
 * server has already merged (via /api/settings) and exposes an optimistic
 * update() so the Settings UI feels instant.
 */

import type { CompactThresholds } from "../chat/compactConfig";
import type { BrowserEngine } from "../browser/engineConfig";

export interface LlmSettings {
  llm_api_url?: string;
  llm_api_key?: string;
  /** Auto-compact threshold + on/off flag (see lib/chat/compactConfig.ts). */
  compact_thresholds?: CompactThresholds;
  /**
   * Which browser drives the agent session (server-authoritative — this is
   * only the UI's view of it). Always one of the user's own OS browsers,
   * launched visibly in its own window (no built-in WebUI browser).
   */
  browser_engine?: BrowserEngine;
}

let cached: LlmSettings | null = null;
let inFlight: Promise<LlmSettings> | null = null;

/** Returns the current settings (fetched once, cached for the session). */
export function fetchSettings(force = false): Promise<LlmSettings> {
  if (!force && cached) return Promise.resolve(cached);
  if (!force && inFlight) return inFlight;
  inFlight = fetch("/api/settings")
    .then((r) => r.json())
    .then((data: any) => {
      cached = (data?.settings ?? {}) as LlmSettings;
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
 * Saves settings (PUT) and updates the in-memory cache immediately so the UI
 * reflects the change without re-fetching.
 */
export async function saveSettings(patch: LlmSettings): Promise<LlmSettings> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  cached = (data?.settings ?? patch) as LlmSettings;
  return cached;
}

/** Deletes settings.json and clears the local cache. */
export async function clearSettingsRemote(): Promise<void> {
  await fetch("/api/settings", { method: "DELETE" });
  cached = {};
}
