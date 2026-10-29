/**
 * SSRF guard — the single source of truth for "may we fetch this URL?"
 *
 * Shared by every network layer (lib/web-search/net.ts) and the headless
 * browser pool (lib/web-search/agentBrowser.ts) so a navigation can never
 * reach loopback / private / link-local ranges.
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
