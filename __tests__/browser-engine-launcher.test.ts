import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  EngineUnavailableError,
  engineProfileDir,
  engineBrowserType,
  engineExecutableCandidates,
  buildEngineLaunchPlan,
  cdpEndpointForEngine,
  cdpIdentityMatches,
} from "@/lib/browser/engineLauncher";

const ENV_KEYS = [
  "RUKE_BROWSER_PATH_BRAVE",
  "RUKE_BROWSER_PATH_CHROME",
  "RUKE_BROWSER_PATH_EDGE",
  "RUKE_BROWSER_PATH_FIREFOX",
  "RUKE_BROWSER_CDP_ENDPOINT",
];
const saved: Record<string, string | undefined> = {};

function stubEnv() {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

describe("engine launcher — explicit availability, never a silent substitute", () => {
  afterEach(() => restoreEnv());

  it("each OS engine gets its OWN automation profile (never the user's real profile)", () => {
    for (const e of ["brave", "chrome", "edge", "firefox"] as const) {
      const dir = engineProfileDir(e);
      expect(path.isAbsolute(dir)).toBe(true);
      expect(dir.replace(/\\/g, "/")).toContain(`.data/browser-profiles/${e}`);
    }
  });

  it("firefox drives through Playwright's own engine, not CDP", () => {
    expect(engineBrowserType("firefox")).toBe("firefox");
    expect(engineBrowserType("brave")).toBe("chromium");
    expect(engineBrowserType("edge")).toBe("chromium");
  });

  it("env override RUKE_BROWSER_PATH_<ENGINE> is tried first", () => {
    stubEnv();
    process.env.RUKE_BROWSER_PATH_EDGE = "Z:/custom/edge.exe";
    expect(engineExecutableCandidates("edge")[0]).toBe("Z:/custom/edge.exe");
  });

  it("an existing env-override exe wins and produces a visible, profiled plan", () => {
    stubEnv();
    const dummy = path.join(".data", "test-dummy-brave.exe");
    fs.mkdirSync(".data", { recursive: true });
    fs.writeFileSync(dummy, "");
    try {
      process.env.RUKE_BROWSER_PATH_BRAVE = path.resolve(dummy);
      const plan = buildEngineLaunchPlan("brave");
      expect(plan.executablePath).toBe(path.resolve(dummy));
      expect(plan.browserType).toBe("chromium");
      expect(plan.headless).toBe(false);
      expect(plan.profileDir.replace(/\\/g, "/")).toContain(".data/browser-profiles/brave");
    } finally {
      fs.rmSync(dummy, { force: true });
    }
  });

  it("the unavailable-browser error promises NO silent substitute", () => {
    // The throw itself is environment-dependent (this box may have Brave
    // installed); the ERROR CONTRACT is what the user-facing policy is.
    const err = new EngineUnavailableError("brave", ["C:/a/brave.exe", "C:/b/brave.exe"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.engine).toBe("brave");
    expect(err.name).toBe("EngineUnavailableError");
    expect(err.message).toMatch(/brave browser was not found on this system/);
    expect(err.message).toMatch(/No substitute browser will be launched/);
    expect(err.message).toMatch(/RUKE_BROWSER_PATH_BRAVE/);
    // A bogus env override must be first in the checked list (so the
    // message tells the user what they just set).
    stubEnv();
    process.env.RUKE_BROWSER_PATH_BRAVE = "Z:/definitely/not/here/brave.exe";
    expect(engineExecutableCandidates("brave")[0]).toBe("Z:/definitely/not/here/brave.exe");
  });

  it("OS launch plans force headless:false (the user must SEE the window)", () => {
    // Windows dev box: Chrome/Edge are commonly installed — if one resolves,
    // its plan must be visible + profiled; if not, the honest error fires.
    stubEnv();
    let plan;
    try {
      plan = buildEngineLaunchPlan("chrome");
    } catch (e) {
      expect(e).toBeInstanceOf(EngineUnavailableError);
      return;
    }
    expect(plan!.headless).toBe(false);
    expect(plan!.executablePath).toBeTruthy();
    expect(plan!.profileDir.replace(/\\/g, "/")).toContain(".data/browser-profiles/chrome");
  });

  it("CDP attach is explicit-endpoint-only, loopback-only, never for firefox", () => {
    stubEnv();
    expect(cdpEndpointForEngine("firefox")).toBeUndefined();

    process.env.RUKE_BROWSER_CDP_ENDPOINT = "http://127.0.0.1:9222/";
    expect(cdpEndpointForEngine("chrome")).toBe("http://127.0.0.1:9222");
    expect(cdpEndpointForEngine("edge")).toBe("http://127.0.0.1:9222");
    expect(cdpEndpointForEngine("firefox")).toBeUndefined();

    process.env.RUKE_BROWSER_CDP_ENDPOINT = "http://evil.example.com:9222";
    expect(cdpEndpointForEngine("chrome")).toBeUndefined(); // remote CDP refused
    process.env.RUKE_BROWSER_CDP_ENDPOINT = "ws://127.0.0.1:9222";
    expect(cdpEndpointForEngine("chrome")).toBeUndefined(); // non-http scheme
    restoreEnv();
  });

  it("visible launches keep the real Chromium sandbox (no --no-sandbox infobar)", () => {
    // Playwright's chromiumSandbox defaults to FALSE and injects
    // --no-sandbox — Chrome then shows "You are using an unsupported
    // command-line flag" in the user's automation window (2026-10-25).
    // Both VISIBLE launch sites (interactive session + pipeline read)
    // must opt into the sandbox; the headless pool is not user-visible
    // and stays as-is.
    const src = fs.readFileSync(
      path.resolve("lib/browser/interactiveBrowser.ts"),
      "utf8",
    );
    expect(src.match(/chromiumSandbox: true/g)?.length).toBe(2);
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("--no-sandbox");
  });

  it("identity probe refuses to drive the WRONG browser", () => {
    expect(cdpIdentityMatches("edge", { Browser: "Edg/139.0.3405.100" }).matches).toBe(true);
    expect(cdpIdentityMatches("chrome", { Browser: "Chrome/139.0.0.0" }).matches).toBe(true);
    expect(cdpIdentityMatches("chrome", { Browser: "Edg/139.0.0.0" }).matches).toBe(false);
    expect(cdpIdentityMatches("chrome", { Browser: "OPR/110 Chrome/120" }).matches).toBe(false);
    expect(cdpIdentityMatches("brave", { Browser: "Chrome/139.0.0.0" }).matches).toBe(true); // deep isBrave check runs post-attach
    expect(cdpIdentityMatches("edge", { Browser: "Chrome/139" }).matches).toBe(false);
    expect(cdpIdentityMatches("edge", null).browserField).toBe("");
  });
});
