/**
 * SSRF guard — the single source of truth for "may we fetch this URL?"
 *
 * Shared by every network layer (lib/web-search/net.ts) and the browser
 * layer (lib/browser/agentBrowser.ts) so a navigation can never reach
 * loopback / private / link-local ranges.
 */

const PRIVATE_HOST_RE =
  /^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc|fd)/i;

/**
 * Block file://, data:, and any URL whose hostname is loopback / private /
 * link-local. Returns true only for http(s) URLs with a public hostname.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !PRIVATE_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Deterministic fallback fixtures are served by this very app under
 * `/fixtures/browser-fallback/` on loopback — an EXACT allow-list, enabled
 * only when RUKE_TEST_FIXTURES=1. Never a general loopback hole: any other
 * localhost/private URL stays blocked by isSafeUrl.
 */
const FIXTURE_PREFIX = "http://localhost:3000/fixtures/browser-fallback/";

export function isFixtureAllowed(url: string): boolean {
  if (process.env.RUKE_TEST_FIXTURES !== "1") return false;
  try {
    const u = new URL(url);
    if (u.hostname !== "localhost" || u.port !== "3000") return false;
    // Reject traversal/encoding tricks; only a flat .html path under the prefix.
    const p = decodeURIComponent(u.pathname);
    if (!p.startsWith("/fixtures/browser-fallback/")) return false;
    if (p.slice(FIXTURE_PREFIX.length - 1).includes("/")) return false;
    return /^[\w.-]+\.html$/.test(p.slice("/fixtures/browser-fallback/".length));
  } catch {
    return false;
  }
}
