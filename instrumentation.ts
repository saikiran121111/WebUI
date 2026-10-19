/**
 * Next.js startup hook (PART 3 auto-boot): warms the Hybrid Decision Engine
 * (worker :8790 + its llama-server :8791) when the web server comes up, so
 * the first heavy prompt never pays the cold-start cost mid-stream.
 * Set DECISION_ENGINE_AUTOSPAWN=0 to disable (the client then stays lazy).
 *
 * The `process.env.NEXT_RUNTIME === "nodejs"` comparison MUST stay in this
 * exact literal form: Next replaces it at compile time so the edge bundle
 * dead-code-eliminates the import (lib/decision/client.ts pulls in Node
 * built-ins that the edge/instrumentation webpack bundle cannot resolve).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.DECISION_ENGINE_AUTOSPAWN !== "0") {
    const { warmupDecisionEngine } = await import("./lib/decision/client");
    warmupDecisionEngine();
  }
}
