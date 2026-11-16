import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * R6 (2026-11-15 brief §3.6) — the ONE platform-correct data-root resolver.
 *
 * The bug this replaces: two persistence modules computed
 * `path.join(process.env.HOME!, ...)` at MODULE LOAD. Native Windows
 * (PowerShell, codex-local) sets USERPROFILE but usually no HOME, so every
 * test collection / server start on Windows died with "Cannot read
 * properties of undefined" before a single conversation was read. WSL hid
 * this; the WSL-era code never noticed.
 *
 * The resolver's contract:
 *  1. `WEBUI_DATA_DIR` (explicit, any platform) always wins — exact
 *     override semantics, resolved to an absolute path.
 *  2. Otherwise the OS home directory via `os.homedir()`, which on POSIX
 *     already IS `$HOME` and on Windows IS `%USERPROFILE%`. Existing
 *     conversation locations therefore do not move on any platform.
 *  3. A missing home is an EXPLICIT, actionable failure at first use —
 *     never a silent fallback to some other directory that would "move"
 *     user data, and never a synthesized `HOME` that hides the defect.
 *
 * Nothing here creates, moves or deletes anything: it only answers "where".
 */

/** The OS home directory, defensively (os.homedir() can throw or be empty
 * inside hardened containers).
 *
 * The String(...) coercion AT THE READ SITE is load-bearing, not stylistic.
 * Next's production build traces server modules with @vercel/nft, whose
 * static evaluator keeps the RAW return value of `os.homedir()` (and of
 * `process.env.X`) marked as an unresolved filesystem root. Any path built
 * from that marked value becomes an "asset directory", and nft emits the
 * recursive glob `<home>/**\/*` — i.e. the whole user profile — which on
 * Windows dies on the protected "Application Data" junction:
 *   Failed to compile. Error: EPERM: operation not permitted,
 *   scandir 'C:\Users\<user>\Application Data'
 * Converting the value into a plain string (String(x ?? "") / x || "") at
 * the point of reading removes the marker, so the tracer no longer walks
 * the profile, while the runtime path stays byte-identical. Verified by
 * __tests__/persistence/data-root-tracer.test.ts and the traced-path probe
 * described in docs/overnight/FINDINGS.md. */
function homeRoot(): string {
  try {
    const home = String(os.homedir?.() ?? "");
    if (home.trim()) return home.trim();
  } catch {
    /* fall through to the explicit env spellings below */
  }
  return String(process.env.USERPROFILE ?? process.env.HOME ?? "").trim();
}

/** True when an explicit WEBUI_DATA_DIR is set (the test-isolation seam). */
export function hasDataDirOverride(): boolean {
  return Boolean(String(process.env.WEBUI_DATA_DIR ?? "").trim());
}

/**
 * The conversation store root. Throws ONLY when neither an override nor any
 * usable home exists — and the message names the fix instead of crashing
 * with a property-access TypeError.
 */
export function conversationsDir(): string {
  const override = String(process.env.WEBUI_DATA_DIR ?? "").trim();
  if (override) return path.resolve(override);
  const home = homeRoot();
  if (!home) {
    throw new Error(
      "Cannot locate a data directory: no WEBUI_DATA_DIR and no home directory " +
        "(set WEBUI_DATA_DIR, or USERPROFILE/HOME, to a writable folder).",
    );
  }
  return path.join(home, ".local-intelligence", "conversations");
}

/** Legacy location probe (Windows-native runs on a machine whose data lived
 * under an explicit override before): report, never migrate. */
export function conversationDirReport(): { dir: string; exists: boolean; source: "override" | "home" } {
  const dir = conversationsDir();
  return { dir, exists: fs.existsSync(dir), source: hasDataDirOverride() ? "override" : "home" };
}
