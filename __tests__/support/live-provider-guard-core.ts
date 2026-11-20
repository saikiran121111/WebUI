/**
 * F48 - the DECISION half of the vitest hermeticity guard, kept apart from the
 * vitest wiring half so the decision can be tested directly. See
 * live-provider-guard.ts for why this guard exists at all, what it can and
 * cannot see, and why it deliberately did NOT become a production branch.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { resourceKey } from "../../lib/server/resource-identity";

/** Same fallback as lib/server/settings.ts; keep the two in step by hand. */
export const FALLBACK_CHAT_URL = "http://127.0.0.1:8080/v1/chat/completions";

export interface DiskEndpoint {
  url: string;
  source: string;
}

/**
 * settings.json, then .env.local, then fallback. NEVER process.env: tests set
 * LLM_API_URL in process.env to point at fakes, and a guard that read those
 * would name a fake as the operator and stop protecting the real server. What
 * is on disk is what the operator configured for production.
 */
export function operatorEndpointFromDisk(root = process.cwd()): DiskEndpoint {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(root, "settings.json"), "utf8"),
    ) as { llm_api_url?: unknown };
    const value = typeof parsed?.llm_api_url === "string" ? parsed.llm_api_url.trim() : "";
    if (value) return { url: value, source: "settings.json:llm_api_url" };
  } catch {
    /* absent or corrupt: fall through to the next layer */
  }
  try {
    for (const raw of readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      if (line.toLowerCase().startsWith("export ")) line = line.slice("export ".length).trim();
      const eq = line.indexOf("=");
      if (line.slice(0, eq).trim() !== "LLM_API_URL") continue;
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (value) return { url: value, source: ".env.local:LLM_API_URL" };
    }
  } catch {
    /* absent */
  }
  return {
    url: FALLBACK_CHAT_URL,
    source: "built-in fallback (nothing on disk names an endpoint)",
  };
}

/** Generation is any ".../completions" endpoint; lifecycle is Strata's own pair. */
export function protectedPath(pathname: string): string | null {
  const p = pathname.toLowerCase();
  if (p.includes("completions")) return "generation";
  if (p === "/unload") return "lifecycle-unload";
  if (p === "/load") return "lifecycle-reload";
  return null;
}

/** The URL as the guard sees it, from any fetch() argument shape. */
export function urlOfFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** The method as the guard sees it, from init or from a Request input. */
export function methodOfFetchInput(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof input === "object" && input !== null && !(input instanceof URL)) {
    return String((input as Request).method ?? "GET").toUpperCase();
  }
  return "GET";
}

/**
 * The one question the guard answers: is this POST a protected operation
 * against the operator's own inference server? A GET/health probe is not, and
 * anything on another origin (a mock on port 9, a fake on 1234, the Rust
 * control port) is not.
 */
export function isProtectedLiveCall(
  url: string,
  method: string,
  operatorResource: string,
): string | null {
  if (method !== "POST") return null;
  let pathname: string;
  try {
    pathname = new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
  const kind = protectedPath(pathname);
  if (!kind) return null;
  return resourceKey(url) === operatorResource ? kind : null;
}

/**
 * Whether fetch has ALREADY been replaced by a test double before this guard
 * installs. Wrapping a double would let canned responses that merely name port
 * 8080 be recorded as violations, so the guard declines to observe such a file
 * instead of producing false failures.
 */
export function looksLikeTestDouble(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  const f = fn as unknown as {
    _isMockFunction?: unknown;
    mock?: unknown;
    getMockName?: unknown;
  };
  // Checked against the installed vitest 2.1 rather than assumed: a mock or a
  // spy carries _isMockFunction === true, a `mock` STATS OBJECT (not a function)
  // and getMockName/mockRestore; a bare async function carries none of them.
  if (f._isMockFunction === true) return true;
  return typeof f.getMockName === "function" && typeof f.mock === "object";
}

/**
 * The observing wrapper. It NEVER changes the outcome: whatever the real
 * transport returns or throws is passed straight through, and a fault in the
 * observation itself is swallowed.
 */
export function makeObservingFetch(
  previous: typeof fetch,
  operatorResource: string,
  endpointSource: string,
  violations: string[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const rawUrl = urlOfFetchInput(input);
      const kind = isProtectedLiveCall(rawUrl, methodOfFetchInput(input, init), operatorResource);
      if (kind) {
        violations.push(
          `${kind} POST ${rawUrl} (operator resource ${operatorResource} from ${endpointSource})`,
        );
      }
    } catch {
      /* observing must never change the request's outcome */
    }
    return (previous as typeof fetch)(input as RequestInfo, init);
  }) as typeof fetch;
}