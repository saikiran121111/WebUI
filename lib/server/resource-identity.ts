/**
 * Resource identity for inference endpoints (R03).
 *
 * F48: this moved VERBATIM out of lib/server/upstream-bridge.ts so that a
 * test-support guard can answer "does this URL name the operator's live
 * model server?" without importing the whole upstream admission machinery
 * (which owns process-local capacity and would otherwise be re-entered by
 * the guard's own bookkeeping). upstream-bridge still re-exports resourceKey,
 * so every existing importer is unaffected.
 *
 * A RESOURCE is an origin, never a path or a spelling.
 */

/** Hostnames that all name THIS machine's inference server. */
export const LOOPBACK_ALIASES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "ip6-localhost",
  "ip6-loopback",
  "host.docker.internal",
]);

/**
 * Identity of an inference RESOURCE = origin (scheme + canonical host +
 * effective port). Capacity is a property of the SERVER, not of a path or
 * a spelling, so "/v1/chat/completions" and "/v1/completions" on one origin
 * are the same resource, and localhost/127.0.0.1/::1 are one alias family.
 * Unparseable strings degrade to a trimmed lowercase spelling.
 */
export function resourceKey(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "raw:" + rawUrl.trim().toLowerCase();
  }
  const scheme = u.protocol === "https:" ? "https" : "http";
  let host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (LOOPBACK_ALIASES.has(host)) host = "127.0.0.1";
  const implicitPort = scheme === "http" ? "80" : "443";
  const port = u.port && u.port !== implicitPort ? `:${u.port}` : "";
  return `${scheme}://${host}${port}`;
}