/**
 * Explicit browser-intent detection — used in the REAL routing path
 * (app/api/chat/route.ts step 5b → the standing browser block).
 *
 * When the user EXPLICITLY asks for the browser ("open X in the browser",
 * "use the browser to log in to…", "navigate to…", a bare "open <url>"),
 * the agent must EXECUTE immediately — no "would you like me to open the
 * browser?" clarification round-trips. Pure regex heuristics: no model
 * call, no site-specific rules.
 */

const BROWSER_MENTION = /\b(browser|new tab|web ?page|web ?site|website|webapp)\b/i;

const BROWSER_VERB =
  /\b(open|navigate|navigat\w*|go to|goto|visit|load|browse|search in|log ?in|sign ?in|click|fill|submit|scroll|watch|play)\b/i;

/** A bare URL token counts as an explicit web target. */
const URL_TOKEN = /\bhttps?:\/\/\S+/i;

const STRONG_PHRASES: RegExp[] = [
  /\b(in|through|using|via|on)\s+(the\s+)?(built-?in\s+)?browser\b/i,
  /\buse\s+(the\s+)?(built-?in\s+)?browser\b/i,
  /\bbrowser\s+(tab|window)\b/i,
  // "navigate to X" also counts — the verb may carry its own "to".
  /\b(navigate(?:\s+to)?|open|visit|go to|load)\s+(https?:\/\/\S+|\S+\.(com|org|net|io|dev|ai|in|co)\b)/i,
  /\b(log ?in|sign ?in)\s+(to|into|for|at|on)\s+\S+/i,
];

/**
 * True when the prompt explicitly asks for browser action. Errs toward
 * false: ordinary research questions never trip it (the 7-tier search
 * pipeline keeps its normal precedence); only clear browser requests do.
 */
/**
 * The FIRST web url in the message, normalized to absolute — handed to the
 * standing block so navigation copies it VERBATIM. Observed failure mode:
 * the model re-typed "https://youtu.be/oJMfhZ6QvaY" as "youtu.be" and the
 * browser opened the bare domain. Bare but url-shaped tokens (youtu.be/x)
 * are accepted ONLY when they carry a path (or www.), so prose like
 * "the site .com" never matches.
 */
export function extractBrowserUrl(prompt: string): string | null {
  const p = prompt ?? "";
  const full = p.match(/\bhttps?:\/\/[^\s<>"'`()\[\]]+/i);
  if (full) return trimUrl(full[0]);
  const bare = p.match(
    /\b(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|be|io|org|net|dev|ai|co|tv|gg|me|xyz|app|so|to)(?:\/[^\s<>"'`()\[\]]*)?/i,
  );
  if (bare && (bare[0].includes("/") || bare[0].toLowerCase().startsWith("www."))) {
    return "https://" + trimUrl(bare[0]);
  }
  return null;
}

/** Strip sentence punctuation a regex tail can swallow. */
function trimUrl(u: string): string {
  return u.replace(/[.,;:!?]+$/, "");
}

export function hasExplicitBrowserIntent(prompt: string): boolean {
  const p = prompt ?? "";
  if (STRONG_PHRASES.some((re) => re.test(p))) return true;
  // "open https://…" with no other context is still explicit.
  if (URL_TOKEN.test(p) && /\b(open|navigate|visit|go to|load)\b/i.test(p)) return true;
  // Verb + web-target noun together: "click the sign-in button on the site".
  if (BROWSER_MENTION.test(p) && BROWSER_VERB.test(p)) return true;
  return false;
}
