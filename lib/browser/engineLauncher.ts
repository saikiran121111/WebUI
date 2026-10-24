/**
 * OS-browser engine resolution — pure functions, zero side effects, so
 * discovery rules are unit-testable without launching anything.
 *
 * Policy (non-negotiable):
 *  - NEVER silently substitute: if the user picked "brave" and Brave is
 *    not found, we throw EngineUnavailableError — we do NOT launch the
 *    bundled Chromium and call it Brave.
 *  - NEVER read/repair a locked real user profile (SingletonLock held by
 *    a running browser): each OS engine gets its OWN dedicated automation
 *    profile under `.data/browser-profiles/<engine>/`, clearly NOT the
 *    user's daily profile — the agent must not claim it has the user's
 *    existing logins there.
 *  - CDP attach happens ONLY when the user explicitly sets
 *    RUKE_BROWSER_CDP_ENDPOINT, and ONLY after the endpoint's browser
 *    identity is verified to match the chosen engine.
 *  - Firefox is driven through Playwright's Firefox engine — never CDP.
 */
import fs from "node:fs";
import path from "node:path";
import type { BrowserEngine } from "./engineConfig";

export class EngineUnavailableError extends Error {
  engine: BrowserEngine;
  constructor(engine: BrowserEngine, found: string[]) {
    super(
      `${engine} browser was not found on this system. Checked: ` +
        found.slice(0, 4).join("; ") +
        ". Install it or set RUKE_BROWSER_PATH_" +
        engine.toUpperCase() +
        ". (No substitute browser will be launched.)",
    );
    this.name = "EngineUnavailableError";
    this.engine = engine;
  }
}

/** Dedicated persistent profile per OS engine — sibling of `default/`. */
export function engineProfileDir(engine: BrowserEngine): string {
  return path.join(process.cwd(), ".data", "browser-profiles", engine);
}

/** Playwright browser family per engine (firefox ≠ chromium family). */
export function engineBrowserType(engine: BrowserEngine): "chromium" | "firefox" {
  return engine === "firefox" ? "firefox" : "chromium";
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

const PROGRAM_FILES = [
  process.env.PROGRAMFILES ?? "C:\\Program Files",
  process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
  process.env.LOCALAPPDATA ?? "",
].filter(Boolean);

/**
 * Candidate executable paths per engine, Windows priority (this project
 * targets a Windows consumer laptop first), mac/linux for portability.
 * Env override `RUKE_BROWSER_PATH_<ENGINE>` is tried FIRST.
 */
export function engineExecutableCandidates(engine: BrowserEngine): string[] {
  const envKey = "RUKE_BROWSER_PATH_" + engine.toUpperCase();
  const envPath = process.env[envKey];
  const out: string[] = [];
  if (envPath) out.push(envPath);

  switch (engine) {
    case "brave":
      if (WIN) {
        for (const pf of PROGRAM_FILES) {
          out.push(path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
        }
      } else if (MAC) {
        out.push("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
      } else {
        out.push("/usr/bin/brave", "/usr/bin/brave-browser", "/snap/bin/brave");
      }
      break;
    case "chrome":
      if (WIN) {
        for (const pf of PROGRAM_FILES) out.push(path.join(pf, "Google", "Chrome", "Application", "chrome.exe"));
      } else if (MAC) {
        out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
      } else {
        out.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable");
      }
      break;
    case "edge":
      if (WIN) {
        for (const pf of PROGRAM_FILES) out.push(path.join(pf, "Microsoft", "EdgeCore", "*", "msedge.exe"));
        for (const pf of PROGRAM_FILES) out.push(path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
      } else if (MAC) {
        out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
      } else {
        out.push("/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable");
      }
      break;
    case "firefox":
      if (WIN) {
        for (const pf of PROGRAM_FILES) out.push(path.join(pf, "Mozilla Firefox", "firefox.exe"));
      } else if (MAC) {
        out.push("/Applications/Firefox.app/Contents/MacOS/firefox");
      } else {
        out.push("/usr/bin/firefox", "/snap/bin/firefox");
      }
      break;
  }
  return out;
}

/** Edge's EdgeCore layout uses a versioned dir — glob the first match. */
function resolveEdgeCore(candidate: string): string | undefined {
  if (!candidate.includes("*")) return exists(candidate) ? candidate : undefined;
  const [dir, tail] = candidate.split("*");
  try {
    const versions = fs.readdirSync(dir).sort().reverse();
    for (const v of versions) {
      const p = path.join(dir, v, tail);
      if (exists(p)) return p;
    }
  } catch {
    /* dir absent */
  }
  return undefined;
}

/** The resolved absolute executable for an OS engine, or undefined. */
export function resolveEngineExecutable(engine: BrowserEngine): string | undefined {
  for (const c of engineExecutableCandidates(engine)) {
    const hit = resolveEdgeCore(c);
    if (hit) return hit;
  }
  return undefined;
}

export interface EngineLaunchPlan {
  browserType: "chromium" | "firefox";
  /** Absolute path to the user's installed browser (required — every
   *  engine is an OS browser; a missing one throws, never substitutes). */
  executablePath: string;
  /** Always false: the user must SEE the window. */
  headless: false;
  profileDir: string;
}

/**
 * Build the launch plan, throwing EngineUnavailableError (never a
 * silent fallback) when the selected OS browser is missing.
 */
export function buildEngineLaunchPlan(engine: BrowserEngine): EngineLaunchPlan {
  const exe = resolveEngineExecutable(engine);
  if (!exe) throw new EngineUnavailableError(engine, engineExecutableCandidates(engine));
  return {
    browserType: engineBrowserType(engine),
    executablePath: exe,
    headless: false,
    profileDir: engineProfileDir(engine),
  };
}

/* ── CDP attach (explicit endpoint only, identity-verified) ─────────────── */

/**
 * The user may point Ruke at an ALREADY-RUNNING browser's DevTools
 * endpoint by setting RUKE_BROWSER_CDP_ENDPOINT (e.g.
 * http://127.0.0.1:9222). We then fetch /json/version and verify the
 * browser's identity matches the selected engine before attaching — a
 * mismatch means "not the browser you selected", so we refuse rather
 * than drive the wrong browser. (Brave's /json/version string looks
 * Chrome-ish; the deep check navigator.brave.isBrave() runs post-attach
 * in interactiveBrowser, and a failing check tears the attach down.)
 */
export function cdpEndpointForEngine(engine: BrowserEngine): string | undefined {
  if (engine === "firefox") return undefined; // never CDP for firefox
  const raw = process.env.RUKE_BROWSER_CDP_ENDPOINT?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    // Only loopback DevTools endpoints — never a remote CDP.
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return undefined;
    return raw.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export interface CdpIdentityProbe {
  /** /json/version `Browser` field, e.g. "Edg/131.0.2903.86". */
  browserField: string;
  matches: boolean;
}

/** Pure identity-matching so the rules are unit-testable. */
export function cdpIdentityMatches(engine: BrowserEngine, versionJson: unknown): CdpIdentityProbe {
  const field = String(
    (versionJson as Record<string, unknown> | null)?.Browser ??
      (versionJson as Record<string, unknown> | null)?.["browser"] ??
      "",
  );
  let matches = false;
  if (engine === "edge") matches = /\bEdg\//.test(field);
  else if (engine === "chrome") matches = /\bChrome\/\d/.test(field) && !/Edg\/|OPR\//.test(field);
  else if (engine === "brave") {
    // Chromium-family identity; the definitive navigator.brave.isBrave()
    // check runs after attach (deep probe). Field-level acceptance is
    // Chrome-family without Edge/Opera markers.
    matches = /\bChrome\/\d/.test(field) && !/Edg\/|OPR\//.test(field);
  }
  return { browserField: field.slice(0, 120), matches };
}
