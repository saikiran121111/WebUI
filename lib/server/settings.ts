import fs from "node:fs";
import path from "node:path";

/**
 * Project-root settings.json â€” the ONE source of truth for the custom model
 * API endpoint. Written by the Settings UI (top-right "Reasoning" menu) and
 * read by every server-side call that touches the LLM. Persists across
 * restarts until the user deletes it.
 *
 * Priority: settings.json > process.env.LLM_API_URL > hardcoded fallback.
 * Reads are stat-gated and only re-parse when the file's mtime changes.
 *
 * F44 (amendment 8 Â§B): the project's own `.env.local` is now a real layer in this
 * resolver, not a private Python source. Before this, TypeScript resolved
 * settings.json > env > fallback while the Python lifecycle resolver read
 * env/.env.local first â€” two resolvers over one setting, which let a chat request go to
 * the server named in settings.json while a handoff unloaded the server named in
 * .env.local. One chain, one order, in every language:
 *   settings.json > process.env > .env.local > fallback.
 * The lifecycle (unload/reload) URLs are DERIVED FROM THE CHAT URL'S ORIGIN unless they
 * are configured explicitly, so chat and lifecycle can no longer point apart.
 */

const SETTINGS_FILE = path.join(process.cwd(), "settings.json");
const DOTENV_FILE = path.join(process.cwd(), ".env.local");
const LLM_FALLBACK = "http://127.0.0.1:8080/v1/chat/completions";
const LLM_KEY_FALLBACK = "no-key";

/** Same names as python-backend/ruke_ml/models/provider_config.py. */
const ENV_CONTROL_ORIGIN = "RUKE_LLM_ENDPOINT";
const ENV_UNLOAD_URL = "LLM_UNLOAD_URL";
const ENV_RELOAD_URL = "LLM_RELOAD_URL";
/**
 * One lifecycle base whose PATH PREFIX is preserved verbatim: `<base>/unload`, `<base>/load`.
 * The default remains the control origin, because that is what is proven live on this host
 * (Strata serves POST /unload and POST /load at the root - F32 measured 51,079 MiB RAM plus
 * 9,483 MiB VRAM freed at http://127.0.0.1:8080). An origin-only derivation must not be the
 * only choice, because it drops the prefix a gateway mounts the API under. Mirrors
 * ENV_LIFECYCLE_BASE in python-backend/ruke_ml/models/provider_config.py.
 */
const ENV_LIFECYCLE_BASE = "RUKE_LIFECYCLE_BASE";
const ENV_PROVIDER = "RUKE_LLM_PROVIDER";
const ENV_MODEL = "RUKE_LLM_MODEL";
const ENV_AUTOMATIC_HANDOFF = "RUKE_LLM_AUTOMATIC_HANDOFF";
const ENV_LEGACY_ALLOW_UNLOAD = "RUKE_OCR_ALLOW_UNLOAD";

export interface SettingsShape {
  llm_api_url?: string;
  llm_api_key?: string;
  /**
   * Auto-compact threshold + on/off flag, written by the SettingsMenu "Context"
   * tab (see lib/chat/compactConfig.ts). The chat UI is the sole reader â€” the
   * server only persists it; it never touches the LLM endpoint.
   */
  compact_thresholds?: { auto: 0 | 1; tokens: number };
  /**
   * The ASR preference. The final decision (2026-11-22) froze ONE engine —
   * the pinned Parakeet — so the key now exists only to migrate an obsolete
   * stored selection VISIBLY to the fixed id (app/api/settings/route.ts,
   * settings_routes.rs). Model IDs, never paths.
   */
  speech_model?: string;
  /** The named OCR engine; unset means the PaddleOCR default. */
  ocr_engine?: "paddle" | "tesseract" | "";
  // `model_mirror` and `hf_token` are REMOVED (final-decision addendum
  // 2026-11-22): the model-manager surface that read them (supervisor
  // /models, ml_models.rs, the Settings picker) is gone, and the settings
  // routes purge any stored value on read.
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

let dotenvMtimeMs: number | null = null;
let dotenvData: Record<string, string> = {};

/** KEY=VALUE lines of the gitignored local overrides. Corrupt stays as the last parse. */
function readDotenv(): Record<string, string> {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(DOTENV_FILE).mtimeMs;
  } catch {
    if (dotenvMtimeMs !== null) {
      dotenvMtimeMs = null;
      dotenvData = {};
    }
    return dotenvData;
  }
  if (mtimeMs !== dotenvMtimeMs) {
    try {
      const parsed: Record<string, string> = {};
      for (const raw of fs.readFileSync(DOTENV_FILE, "utf8").split(/\r?\n/)) {
        let line = raw.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) continue;
        if (line.toLowerCase().startsWith("export ")) line = line.slice("export ".length).trim();
        const eq = line.indexOf("=");
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
          value = value.slice(1, -1).trim();
        }
        if (key && value) parsed[key] = value;
      }
      dotenvData = parsed;
    } catch {
      // Unreadable/corrupt: keep the previous parse and do not accept the mtime.
      return dotenvData;
    }
    dotenvMtimeMs = mtimeMs;
  }
  return dotenvData;
}

/** One key through the shared chain. Returns undefined when nothing sets it. */
function resolveLayer(settingsValue: string | undefined, envName: string): {
  value: string;
  source: string;
} | null {
  if (typeof settingsValue === "string" && settingsValue.trim()) {
    return { value: settingsValue.trim(), source: `settings.json(${envName})` };
  }
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return { value: fromEnv.trim(), source: `process.env(${envName})` };
  }
  const fromFile = readDotenv()[envName];
  if (typeof fromFile === "string" && fromFile.trim()) {
    return { value: fromFile.trim(), source: `.env.local(${envName})` };
  }
  return null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function readBool(name: string): boolean | null {
  const got = resolveLayer(undefined, name);
  if (!got) return null;
  const raw = got.value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

/**
 * The live model server URL. settings.json wins, env is next-best,
 * then the project's own .env.local, then the hardcoded fallback.
 */
export function llmApiUrl(): string {
  return (
    resolveLayer(readSettings().llm_api_url, "LLM_API_URL")?.value ?? LLM_FALLBACK
  );
}

export function llmApiKey(): string {
  return resolveLayer(readSettings().llm_api_key, "LLM_API_KEY")?.value ?? LLM_KEY_FALLBACK;
}

export interface ProviderConfig {
  chatUrl: string;
  apiKey: string;
  /** Origin of the chat URL (or an explicit RUKE_LLM_ENDPOINT override). */
  controlOrigin: string;
  /** Configured RUKE_LIFECYCLE_BASE with its path prefix preserved; "" when the origin is used. */
  lifecycleBase: string;
  /** Always the same origin as chatUrl unless configured otherwise. */
  unloadUrl: string;
  reloadUrl: string;
  /** True when the lifecycle URLs were configured rather than derived. */
  lifecycleExplicit: boolean;
  providerHint: string;
  modelId: string;
  /** Whether a heavy job MAY take the coordinated unload/load window by configuration. */
  automaticHandoff: boolean;
  handoffSource: string;
  configSource: Record<string, string>;
}

/**
 * The ONE provider configuration for this process. Any code that talks to the main model â€”
 * chat, titles, compaction, or the unload/reload lifecycle â€” resolves it here so they can
 * never disagree about which server is being controlled.
 */
export function providerConfig(): ProviderConfig {
  const settings = readSettings();
  const source: Record<string, string> = {};

  const chat = resolveLayer(settings.llm_api_url, "LLM_API_URL");
  const chatUrl = chat?.value ?? LLM_FALLBACK;
  source.chatUrl = chat?.source ?? "fallback(LLM_API_URL)";

  const key = resolveLayer(settings.llm_api_key, "LLM_API_KEY");
  const apiKey = key?.value ?? LLM_KEY_FALLBACK;
  source.apiKey = key?.source ?? "fallback(LLM_API_KEY)";

  const pinned = resolveLayer(undefined, ENV_CONTROL_ORIGIN);
  const derived = originOf(chatUrl);
  const controlOrigin = pinned
    ? pinned.value.replace(/\/+$/, "")
    : derived ?? (originOf(LLM_FALLBACK) ?? "http://127.0.0.1:8080");
  source.controlOrigin = pinned
    ? pinned.source
    : derived
      ? `derived-from-chatUrl(${source.chatUrl})`
      : "fallback(chat url is not an absolute URL)";

  const unload = resolveLayer(undefined, ENV_UNLOAD_URL);
  const reload = resolveLayer(undefined, ENV_RELOAD_URL);
  // One anchor for BOTH lifecycle paths, so the pair can never be built from two bases.
  // RUKE_LIFECYCLE_BASE preserves whatever path prefix it names; the default is the control
  // origin, which keeps the root-mounted endpoints this deployment actually serves.
  const base = resolveLayer(undefined, ENV_LIFECYCLE_BASE);
  const lifecycleBase = base ? base.value.replace(/\/+$/, "") : "";
  const anchor = lifecycleBase || controlOrigin;
  source.lifecycleBase = base
    ? `${base.source} (path prefix preserved)`
    : "unset(append to the control origin, which preserves the root-mounted lifecycle " +
      "endpoints this deployment serves)";
  const anchorSource = lifecycleBase ? source.lifecycleBase : source.controlOrigin;
  const unloadUrl = unload?.value ?? `${anchor}/unload`;
  const reloadUrl = reload?.value ?? `${anchor}/load`; // Strata serves POST /load
  source.unloadUrl = unload?.source ?? `derived(${anchorSource})`;
  source.reloadUrl = reload?.source ?? `derived(${anchorSource})`;

  const providerHint = resolveLayer(undefined, ENV_PROVIDER)?.value ?? "";
  const modelId = resolveLayer(undefined, ENV_MODEL)?.value ?? "";

  const configured = readBool(ENV_AUTOMATIC_HANDOFF);
  const legacy = readBool(ENV_LEGACY_ALLOW_UNLOAD);
  const automaticHandoff = configured ?? legacy ?? true;
  source.automaticHandoff =
    (configured !== null
      ? resolveLayer(undefined, ENV_AUTOMATIC_HANDOFF)?.source
      : legacy !== null
        ? resolveLayer(undefined, ENV_LEGACY_ALLOW_UNLOAD)?.source
        : undefined) ??
    "default(true: only ever used when the job does not fit and the provider supports lifecycle calls)";

  return {
    chatUrl,
    apiKey,
    controlOrigin,
    lifecycleBase,
    unloadUrl,
    reloadUrl,
    lifecycleExplicit: Boolean(unload || reload),
    providerHint,
    modelId,
    automaticHandoff,
    handoffSource: source.automaticHandoff,
    configSource: source,
  };
}

/** Lifecycle URLs that follow whatever chat is using. Never a second endpoint choice. */
export function llmLifecycleUrls(): { unloadUrl: string; reloadUrl: string } {
  const cfg = providerConfig();
  return { unloadUrl: cfg.unloadUrl, reloadUrl: cfg.reloadUrl };
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

/**
 * Replaces the whole stored object. The engine-preference migration purges
 * retired keys, which a merge-patch cannot express. Atomic, with the same
 * cache invalidation as updateSettings. Parity: SettingsStore::replace_settings
 * in rust-backend/crates/ruke-core/src/settings.rs.
 */
export function replaceSettings(next: SettingsShape): SettingsShape {
  const tmp = SETTINGS_FILE + ".tmp";
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, SETTINGS_FILE);
  cachedMtimeMs = null; // force a re-stat on the next read
  cachedData = next;
  return next;
}

/** Removes the file (user deleted settings â€” back to env/fallback). */
export function clearSettings(): void {
  cachedMtimeMs = null;
  cachedData = {};
  try {
    fs.rmSync(SETTINGS_FILE, { force: true });
  } catch {
    // nothing to clear
  }
}
