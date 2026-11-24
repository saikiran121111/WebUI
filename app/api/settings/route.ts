import { NextRequest, NextResponse } from "next/server";
import {
  getSettings,
  updateSettings,
  replaceSettings,
  clearSettings,
  type SettingsShape,
} from "../../../lib/server/settings";
import { rustEnabled, rustProxy } from "../../../lib/server/rustProxy";
import { FIXED_SPEECH_MODEL } from "../../../lib/settings/client";

/**
 * FINAL DECISION addendum 2026-11-22: the Hugging Face model-manager surface
 * (search / picker / token / mirror / download) is REMOVED, and Parakeet is
 * the sole audio/video transcription engine. Two laws live here, with exact
 * parity in rust-backend/crates/ruke-server/src/settings_routes.rs:
 *
 *  1. RETIRED KEYS ARE PURGED, not hidden. `hf_token` and `model_mirror`
 *     belonged to the removed surface; a stored value is deleted from
 *     settings.json on the first read, and a PUT writing them is ignored —
 *     the only write that cannot resurrect a dead surface. The old
 *     `hf_token_set` shadow view is gone from every response.
 *  2. OBSOLETE SELECTIONS MIGRATE VISIBLY. A `speech_model` stored with any
 *     value other than the fixed Parakeet id is rewritten to it, once, and
 *     persisted. An explicit Tesseract-only `ocr_engine` is PRESERVED.
 */
const RETIRED_KEYS = ["hf_token", "model_mirror", "hf_token_set"] as const;

/** Purge + normalize, persisted through one atomic replace when anything changed.
 *  The second element is the OBSOLETE speech_model value when it was rewritten —
 *  the response names it (`speech_model_migrated`) so the Settings UI can show
 *  the migration, as the directive requires. */
function migrateEngines(settings: Record<string, unknown>): [Record<string, unknown>, string | null] {
  const next = { ...settings };
  let changed = false;
  let migratedFrom: string | null = null;
  for (const k of RETIRED_KEYS) {
    if (k in next) {
      delete next[k];
      changed = true;
    }
  }
  if ("speech_model" in next && next.speech_model !== FIXED_SPEECH_MODEL) {
    migratedFrom = String(next.speech_model);
    next.speech_model = FIXED_SPEECH_MODEL;
    changed = true;
  }
  const out = changed ? (replaceSettings(next as SettingsShape) as Record<string, unknown>) : next;
  return [out, migratedFrom];
}

function settingsResponse(settings: Record<string, unknown>, migratedFrom: string | null) {
  return NextResponse.json({
    settings: publicSettings(settings),
    ...(migratedFrom ? { speech_model_migrated: migratedFrom } : {}),
  });
}

function publicSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out = { ...settings };
  for (const k of RETIRED_KEYS) delete out[k];
  return out;
}

// GET/DELETE gained an optional `req` purely for the Part-8 proxy branch;
// direct in-process callers (vitest goldens) keep working argument-less.
export async function GET(req?: NextRequest) {
  if (rustEnabled() && req) return rustProxy(req, "/api/ruke/settings");
  const [settings, migratedFrom] = migrateEngines(getSettings() as Record<string, unknown>);
  return settingsResponse(settings, migratedFrom);
}

export async function PUT(req: Request) {
  if (rustEnabled()) return rustProxy(req, "/api/ruke/settings");
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const patch: Parameters<typeof updateSettings>[0] = {};
  if (typeof body.llm_api_url === "string" && body.llm_api_url.trim()) {
    patch.llm_api_url = body.llm_api_url.trim();
  }
  if (typeof body.llm_api_key === "string") {
    patch.llm_api_key = body.llm_api_key;
  }
  // Auto-compact threshold (the chat UI's own setting — server persists it,
  // never reads it into the LLM path).
  const ct = body.compact_thresholds;
  if (ct && typeof ct === "object" && "auto" in ct && "tokens" in ct) {
    const auto = (ct as { auto?: unknown }).auto;
    const tokens = (ct as { tokens?: unknown }).tokens;
    patch.compact_thresholds = {
      auto: auto === 1 ? 1 : 0,
      tokens: typeof tokens === "number" && Number.isFinite(tokens)
        ? Math.max(0, Math.round(tokens))
        : 0,
    };
  }
  // Engine keys (the Settings→Engines tab). Parity gates with
  // settings_routes.rs: speech_model is a string the migration normalizes,
  // ocr_engine is a NAMED engine, and the retired hf_token/model_mirror
  // writes are IGNORED here — they never reach the store.
  if (typeof body.speech_model === "string") {
    patch.speech_model = body.speech_model;
  }
  if (body.ocr_engine === "paddle" || body.ocr_engine === "tesseract" || body.ocr_engine === "") {
    patch.ocr_engine = body.ocr_engine;
  }
  updateSettings(patch);
  const [settings, migratedFrom] = migrateEngines(getSettings() as Record<string, unknown>);
  return settingsResponse(settings, migratedFrom);
}

export async function DELETE(req?: NextRequest) {
  if (rustEnabled() && req) return rustProxy(req, "/api/ruke/settings");
  clearSettings();
  return NextResponse.json({ ok: true });
}
