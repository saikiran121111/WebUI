/**
 * Next.js startup hook: warms the Hybrid Decision Engine
 * (worker :8790 + its llama-server :8791) when the web server comes up,
 * so the first heavy prompt never pays the cold-start cost mid-stream.
 * Set DECISION_ENGINE_AUTOSPAWN=0 to disable (the client then stays lazy).
 *
 * Also purges expired web-search cache rows (5-hour wall-clock TTL) on
 * boot and starts the 15-minute background sweep, so stale data from
 * earlier sessions is wiped even if the app was closed for >5 hours.
 *
 * The `process.env.NEXT_RUNTIME === "nodejs"` comparison MUST stay in this
 * exact literal form: Next replaces it at compile time so the edge bundle
 * dead-code-eliminates the import (lib/decision/client.ts pulls in Node
 * built-ins that the edge/instrumentation webpack bundle cannot resolve).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Purge expired web-search cache on startup + start the 15-min sweep
    try {
      const { startPurgeSweep } = await import(
        "./src/lib/web-search/cache"
      );
      startPurgeSweep();
    } catch {
      /* cache module unavailable — skip purge */
    }

    if (process.env.DECISION_ENGINE_AUTOSPAWN !== "0") {
      const { warmupDecisionEngine } = await import("./lib/decision/client");
      warmupDecisionEngine();
    }
  }
}
