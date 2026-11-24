/**
 * B5 FINAL DECISION (addendum 2026-11-22) — the retired model-manager keys
 * and the frozen engines on the settings surface.
 *
 * Seam: app/api/settings/route.ts (the TS arm; the Rust arm /api/ruke/settings
 * carries the parity tests in settings_routes.rs — shared contract, both
 * sides). The laws pinned here:
 *  * RETIRED KEYS ARE PURGED, not hidden: a stored hf_token/model_mirror is
 *    DELETED from the store on the first read (replaceSettings persisted),
 *    and a PUT writing them is IGNORED — the surface is not resurretable.
 *    No response carries hf_token, model_mirror or the hf_token_set shadow.
 *  * OBSOLETE SELECTIONS MIGRATE VISIBLY: a speech_model stored with any
 *    other value is rewritten to the fixed Parakeet id, once, persisted, and
 *    the migrating response names the old value (speech_model_migrated).
 *    Clean reads stay silent.
 *  * ocr_engine is a NAMED engine: "paddle"/"tesseract"/"" persist; junk is
 *    not; an explicit Tesseract-only choice is PRESERVED by migration.
 */
import { describe, expect, it, vi } from "vitest";

const store: Record<string, unknown> = {};
const replaces: Record<string, unknown>[] = [];

vi.mock("@/lib/server/settings", () => ({
  getSettings: () => ({ ...store }),
  updateSettings: (patch: Record<string, unknown>) => {
    Object.assign(store, JSON.parse(JSON.stringify(patch)));
    return { ...store };
  },
  replaceSettings: (next: Record<string, unknown>) => {
    replaces.push(JSON.parse(JSON.stringify(next)));
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, JSON.parse(JSON.stringify(next)));
    return { ...store };
  },
  clearSettings: () => { for (const k of Object.keys(store)) delete store[k]; },
}));

// vi.mock is hoisted above this import, so the route runs against the
// in-memory store.
import { GET, PUT } from "@/app/api/settings/route";
import { FIXED_SPEECH_MODEL } from "@/lib/settings/client";

function put(body: Record<string, unknown>) {
  return PUT(new Request("http://next.local/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function json(res: Response) {
  return (await res.json()) as {
    settings: Record<string, unknown>;
    speech_model_migrated?: string;
  };
}

describe("retired marketplace keys purge on the first read", () => {
  it("a legacy store is purged in the STORE and the Parakeet migration is visible", async () => {
    Object.assign(store, {
      speech_model: "Systran/faster-whisper-base",
      ocr_engine: "tesseract",
      model_mirror: "https://mirror.example",
      hf_token: "hf_serverSideSecret",
      hf_token_set: true,
    });
    const body = await json(await GET());

    // Migration PERSISTED through a whole-store replace, not just the view.
    expect(store.hf_token).toBeUndefined();
    expect(store.model_mirror).toBeUndefined();
    expect(store.speech_model).toBe(FIXED_SPEECH_MODEL);
    expect(store.ocr_engine).toBe("tesseract"); // Tesseract-only is PRESERVED

    expect(body.settings.speech_model).toBe(FIXED_SPEECH_MODEL);
    expect(body.settings.ocr_engine).toBe("tesseract");
    expect(body.settings.hf_token).toBeUndefined();
    expect(body.settings.model_mirror).toBeUndefined();
    expect(body.settings.hf_token_set).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("hf_serverSideSecret");
    // The migration is VISIBLE: the response names the obsolete preference.
    expect(body.speech_model_migrated).toBe("Systran/faster-whisper-base");
    expect(replaces).toHaveLength(1);
  });

  it("a clean store gets no migration write and no notice", async () => {
    for (const k of Object.keys(store)) delete store[k];
    store.llm_api_key = "k";
    store.ocr_engine = "paddle";
    const before = replaces.length;
    const body = await json(await GET());
    expect(replaces).toHaveLength(before); // idempotent, silent
    expect(body.speech_model_migrated).toBeUndefined();
  });

  it("a retired-key WRITE is ignored: it cannot resurrect the surface", async () => {
    const body = await json(await put({
      hf_token: "hf_new",
      model_mirror: "https://evil.example",
    }));
    expect(store.hf_token).toBeUndefined();
    expect(store.model_mirror).toBeUndefined();
    expect(body.settings.hf_token).toBeUndefined();
    expect(body.settings.model_mirror).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("hf_new");
    expect(JSON.stringify(body)).not.toContain("evil.example");
  });
});

describe("the obsolete ASR preference migrates visibly to Parakeet", () => {
  it("a legacy speech_model written through PUT comes back as Parakeet, named", async () => {
    const body = await json(await put({ speech_model: "OpenAI/whisper-large" }));
    expect(body.settings.speech_model).toBe(FIXED_SPEECH_MODEL);
    expect(body.speech_model_migrated).toBe("OpenAI/whisper-large");
    expect(store.speech_model).toBe(FIXED_SPEECH_MODEL);
  });

  it("the fixed engine writes and reads back with no notice", async () => {
    const body = await json(await put({ speech_model: FIXED_SPEECH_MODEL }));
    expect(body.settings.speech_model).toBe(FIXED_SPEECH_MODEL);
    expect(body.speech_model_migrated).toBeUndefined();
  });

  it("a non-string speech_model write is ignored, not stringified", async () => {
    await put({ speech_model: { path: "C:/models" } });
    expect(store.speech_model).toBe(FIXED_SPEECH_MODEL);
  });
});

describe("ocr_engine stays a named engine", () => {
  it("an ocr_engine outside the named engines is not persisted", async () => {
    const before = store.ocr_engine;
    await put({ ocr_engine: "make-me-a-sandwich" });
    expect(store.ocr_engine).toBe(before);
  });

  it("an empty ocr_engine write is the PaddleOCR-default selection", async () => {
    const body = await json(await put({ ocr_engine: "" }));
    expect(body.settings.ocr_engine).toBe("");
    expect(store.ocr_engine).toBe("");
  });

  it("the chat provider keys still ride every response untouched", async () => {
    await put({ llm_api_url: "http://127.0.0.1:8080/v1/chat/completions", llm_api_key: "endpoint-key" });
    const body = await json(await GET());
    expect(body.settings.llm_api_url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(body.settings.llm_api_key).toBe("endpoint-key");
  });
});
