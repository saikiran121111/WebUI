/**
 * Next.js startup hook.
 *
 * Since 2026-10-22 the Hybrid Decision Engine (:8790 + LFM llama-server
 * :8791) is gone — routing is in-process (lib/decision/client.ts), so
 * Next.js NEVER spawns Python or llama-server processes on boot. The
 * engine reaper and auto-spawn call that lived here are removed.
 *
 * What still runs on boot:
 *   - purge expired web-search cache rows (5-hour wall-clock TTL) +
 *     start the 15-minute background sweep, so stale data from earlier
 *     sessions is wiped even if the app was closed for >5 hours.
 *
 * The `process.env.NEXT_RUNTIME === "nodejs"` comparison MUST stay in this
 * exact literal form: Next replaces it at compile time so the edge bundle
 * dead-code-eliminates the import (the cache module pulls in Node
 * built-ins that the edge/instrumentation webpack bundle cannot resolve).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Purge expired web-search cache on startup + start the 15-min sweep
    try {
      const { startPurgeSweep } = await import(
        "./lib/web-search/cache"
      );
      startPurgeSweep();
    } catch {
      /* cache module unavailable — skip purge */
    }
    // No decision-engine auto-spawn: routing is in-process.
  }
}
