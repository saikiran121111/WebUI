import fs from "node:fs";
import path from "node:path";
import {
  type BrowserEngine,
  DEFAULT_BROWSER_ENGINE,
  parseEngineValue,
} from "@/lib/browser/engineConfig";

/**
 * Project-root settings.json — the ONE source of truth for the custom model
 * API endpoint. Written by the Settings UI (top-right "Reasoning" menu) and
 * read by every server-side call that touches the LLM. Persists across
 * restarts until the user deletes it.
 *
 * Priority: settings.json > process.env.LLM_API_URL > hardcoded fallback.
 * Reads are stat-gated and only re-parse when the file's mtime changes.
 */

const SETTINGS_FILE = path.join(process.cwd(), "settings.json");
const LLM_FALLBACK = "http://127.0.0.1:8080/v1/chat/completions";
const LLM_KEY_FALLBACK = "no-key";

interface SettingsShape {
  llm_api_url?: string;
  llm_api_key?: string;
  /**
   * Auto-compact threshold + on/off flag, written by the SettingsMenu "Context"
   * tab (see lib/chat/compactConfig.ts). The chat UI is the sole reader — the
   * server only persists it; it never touches the LLM endpoint.
   */
  compact_thresholds?: { auto: 0 | 1; tokens: number };
  /**
   * Which browser drives the agent session. The SERVER value is
   * authoritative — the client's setting is only a view of this. The
   * engine is always one of the user's own OS browsers (chrome/brave/
   * edge/firefox), launched visibly. There is no built-in WebUI browser
   * (no mirror, no screencast).
   */
  browser_engine?: BrowserEngine;
}

let cachedMtimeMs: number | null = null;
let cachedData: SettingsShape = {};

function readSettings(): SettingsShape {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    // Absent: nothing on disk can be more authoritative than env/fallback.
    if (cachedMtimeMs !== null) {
      cachedMtimeMs = null;
      cachedData = {};
    }
    return cachedData;
  }
  if (mtimeMs !== cachedMtimeMs) {
    try {
      cachedData = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as SettingsShape;
    } catch {
      // Corrupt file: keep whatever we last parsed and retry next call.
      mtimeMs = cachedMtimeMs as number;
    }
    cachedMtimeMs = mtimeMs;
  }
  return cachedData;
}

/**
 * The live model server URL. settings.json wins, env is next-best,
 * the hardcoded fallback is last.
 */
export function llmApiUrl(): string {
  return readSettings().llm_api_url ?? process.env.LLM_API_URL ?? LLM_FALLBACK;
}

/** The authoritative browser engine (settings.json > default). */
export function browserEngine(): BrowserEngine {
  return parseEngineValue(readSettings().browser_engine) ?? DEFAULT_BROWSER_ENGINE;
}

export function llmApiKey(): string {
  return readSettings().llm_api_key ?? process.env.LLM_API_KEY ?? LLM_KEY_FALLBACK;
}

/**
 * Reads settings.json (used by the settings API routes). Returns {} when
 * the file does not exist yet.
 */
export function getSettings(): SettingsShape {
  return readSettings();
}

/**
 * Merges a patch into settings.json atomically (write-tmp + rename),
 * preserving every field not mentioned. Invalidates the read cache so
 * this process sees the new value on its next call.
 */
export function updateSettings(patch: Partial<SettingsShape>): SettingsShape {
  const next = { ...readSettings(), ...patch };
  const tmp = SETTINGS_FILE + ".tmp";
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, SETTINGS_FILE);
  cachedMtimeMs = null; // force a re-stat on the next read
  cachedData = next;
  return next;
}

/** Removes the file (user deleted settings — back to env/fallback). */
export function clearSettings(): void {
  cachedMtimeMs = null;
  cachedData = {};
  try {
    fs.rmSync(SETTINGS_FILE, { force: true });
  } catch {
    // nothing to clear
  }
}
