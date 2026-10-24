/**
 * BrowserEngine — which browser actually executes the agent's actions.
 *
 * OS-only by design: the user's OWN installed browser (brave/chrome/edge/
 * firefox), launched visibly on their desktop (or attached to an explicitly
 * provided automation endpoint with identity verification). There is NO
 * built-in WebUI browser and NO right-panel mirror anywhere — the agent
 * drives a real window the user can watch and intervene in.
 *
 * Default is "chrome" (the most common installed browser); every engine
 * gets its own dedicated automation profile under
 * `.data/browser-profiles/<engine>/`.
 *
 * Pure module: no server/client-only imports, safe on both sides of the
 * wire (settings UI, API validation, and the server session all share it).
 */

export type BrowserEngine = "brave" | "chrome" | "edge" | "firefox";

export const BROWSER_ENGINES: readonly BrowserEngine[] = [
  "chrome", "brave", "edge", "firefox",
];

export const DEFAULT_BROWSER_ENGINE: BrowserEngine = "chrome";

/** Exact Settings-menu labels (UI contract — tests assert these strings). */
export const ENGINE_LABELS: Record<BrowserEngine, string> = {
  chrome: "Chrome Browser (User's Own Browser)",
  brave: "Brave Browser (User's Own Browser)",
  edge: "Edge Browser (User's Own Browser)",
  firefox: "Firefox Browser (User's Own Browser)",
};

/** Validate a raw settings value; undefined when not a known engine. */
export function parseEngineValue(value: unknown): BrowserEngine | undefined {
  return BROWSER_ENGINES.find((e) => e === value);
}
