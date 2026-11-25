/**
 * F153 (2026-11-24) — the settings/client STATUS law, brief §2.
 *
 * On HEAD saveSettings never inspected res.ok: a failed PUT committed the
 * optimistic patch to the session cache and RESOLVED, so SettingsMenu's
 * success flash ran and EnginesSettings' fire-and-forget radio displayed
 * an engine the server had refused — settings.json kept the old value.
 * The law: a non-2xx response is a FAILED save — throw SettingsSaveError
 * (carrying the status) BEFORE touching the cache; the caller's catch is
 * the honest outcome. DELETE follows the same law.
 *
 * Pure module, fetch stub — the session cache is stateful, so the tests
 * drive it through the public API in order, each scenario starting from a
 * known saved state.
 */
import { describe, it, expect, vi } from "vitest";
import {
  fetchSettings,
  saveSettings,
  clearSettingsRemote,
  SettingsSaveError,
} from "../lib/settings/client";

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("a failed settings save is a failure, not a success", () => {
  it("a saved state first: the 200 PUT resolves with the SERVER-merged settings", async () => {
    stubFetch(() => ({ status: 200, body: { settings: { ocr_engine: "paddle", llm_api_url: "http://served" } } }));
    const s = await saveSettings({ ocr_engine: "paddle" });
    expect(s).toEqual({ ocr_engine: "paddle", llm_api_url: "http://served" });
    expect(await fetchSettings()).toEqual({ ocr_engine: "paddle", llm_api_url: "http://served" });
  });

  it("a 500 PUT throws SettingsSaveError and does NOT commit the refused value", async () => {
    const calls = stubFetch(() => ({ status: 500, body: { error: "disk full" } }));
    await expect(saveSettings({ ocr_engine: "tesseract" })).rejects.toThrow(SettingsSaveError);
    expect(calls[0].init?.method).toBe("PUT");
    // The session cache must still show the SAVED engine, never the refused one.
    expect(await fetchSettings()).toEqual({ ocr_engine: "paddle", llm_api_url: "http://served" });
  });

  it("the thrown error carries the HTTP status", async () => {
    stubFetch(() => ({ status: 403 }));
    const err = await saveSettings({ ocr_engine: "tesseract" }).catch((e) => e);
    expect(err).toBeInstanceOf(SettingsSaveError);
    expect((err as SettingsSaveError).status).toBe(403);
    expect(await fetchSettings()).toEqual({ ocr_engine: "paddle", llm_api_url: "http://served" });
  });

  it("a 200 PUT whose body carries no settings falls back to the patch (legacy shape)", async () => {
    stubFetch(() => ({ status: 200, body: {} }));
    await saveSettings({ ocr_engine: "paddle" });
    expect(await fetchSettings()).toEqual({ ocr_engine: "paddle" });
  });

  it("a 500 DELETE throws and leaves the cache intact", async () => {
    stubFetch(() => ({ status: 500 }));
    await expect(clearSettingsRemote()).rejects.toThrow(SettingsSaveError);
    expect(await fetchSettings()).toEqual({ ocr_engine: "paddle" });
  });

  it("a 204 DELETE clears the cache", async () => {
    stubFetch(() => ({ status: 204 }));
    await clearSettingsRemote();
    expect(await fetchSettings()).toEqual({});
  });
});
