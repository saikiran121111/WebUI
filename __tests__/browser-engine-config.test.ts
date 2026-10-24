import { describe, it, expect } from "vitest";
import {
  BROWSER_ENGINES,
  DEFAULT_BROWSER_ENGINE,
  ENGINE_LABELS,
  parseEngineValue,
} from "@/lib/browser/engineConfig";

describe("BrowserEngine setting contract", () => {
  it("exact engine set: the user's own OS browsers, chrome default", () => {
    expect(BROWSER_ENGINES).toEqual(["chrome", "brave", "edge", "firefox"]);
    expect(DEFAULT_BROWSER_ENGINE).toBe("chrome");
  });

  it("settings-UI labels are exact (dropdown contract)", () => {
    expect(ENGINE_LABELS.chrome).toBe("Chrome Browser (User's Own Browser)");
    expect(ENGINE_LABELS.brave).toBe("Brave Browser (User's Own Browser)");
    expect(ENGINE_LABELS.edge).toBe("Edge Browser (User's Own Browser)");
    expect(ENGINE_LABELS.firefox).toBe("Firefox Browser (User's Own Browser)");
  });

  it("there is no built-in WebUI engine value anymore", () => {
    // Old settings files may still say "internal"; it must NOT parse —
    // the settings loader then falls back to the chrome default.
    expect(parseEngineValue("internal")).toBeUndefined();
    expect(parseEngineValue("Internal")).toBeUndefined();
  });

  it("parseEngineValue accepts only exact values (API validation)", () => {
    for (const e of BROWSER_ENGINES) expect(parseEngineValue(e)).toBe(e);
    expect(parseEngineValue("safari")).toBeUndefined();
    expect(parseEngineValue("chromium")).toBeUndefined();
    expect(parseEngineValue("")).toBeUndefined();
    expect(parseEngineValue(undefined)).toBeUndefined();
    expect(parseEngineValue(42)).toBeUndefined();
  });
});
