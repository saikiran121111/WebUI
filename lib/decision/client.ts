/**
 * HTTP client for the contained Hybrid Decision Engine worker
 * (.decision-engine/worker/decision_server.py on 127.0.0.1:8790).
 * Auto-spawns the worker (and its llama-server child) from project-local
 * paths when it is not already warm; every binary/weight stays inside
 * ./.decision-engine/. If the engine cannot come up, returns a
 * standard_chat fallback envelope so chat keeps working with ALL renderer
 * validators disabled (zero-collision default).
 */
// NOTE: bare built-in specifiers (not "node:…") — Next 14's experimental
// instrumentationHook webpack bundle does not externalize the node: scheme
// and fails the whole server build with UnhandledSchemeError.
import { spawn } from "child_process";
import fsSync from "fs";
import path from "path";
import { projectRoot } from "../skills/registry";
import { RENDERER_MODES, isRendererMode, type DecisionEnvelope, type RendererMode } from "./types";

const DEFAULT_URL = "http://127.0.0.1:8790";

export function decisionEngineUrl(): string {
  return process.env.DECISION_ENGINE_URL ?? DEFAULT_URL;
}

function autoSpawnEnabled(): boolean {
  return process.env.DECISION_ENGINE_AUTOSPAWN !== "0";
}

function workerPython(): string {
  const venv = path.join(projectRoot(), ".decision-engine", ".venv");
  const exe = process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
  return fsSync.existsSync(exe) ? exe : "";
}

async function health(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(decisionEngineUrl() + "/health", { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

let spawnPromise: Promise<boolean> | null = null;

/** Start the contained worker once and wait for /health (up to ~4 min). */
async function ensureWorker(): Promise<boolean> {
  if (await health()) return true;
  if (!autoSpawnEnabled()) return false;
  if (!spawnPromise) {
    const attempt = (async () => {
      const py = workerPython();
      const script = path.join(projectRoot(), ".decision-engine", "worker", "decision_server.py");
      if (!py || !fsSync.existsSync(script)) return false;
      try {
        const child = spawn(py, [script], {
          cwd: projectRoot(), // never run from inside the engine dir
          detached: true,
          windowsHide: true,
          stdio: "ignore",
          // DECISION_ENGINE_PARENT_PID: the worker runs a watchdog on THIS
          // process's PID and shuts itself + llama-server down when we exit
          // (Ctrl+C, terminal closed, crash) — stopping `npm run dev` stops
          // the engine. Do NOT child.kill() from here: that would orphan
          // llama-server; the watchdog shuts the whole tree down gracefully.
          env: { ...process.env, DECISION_ENGINE_SPAWNED_BY: "webui", DECISION_ENGINE_PARENT_PID: String(process.pid) },
        });
        child.unref();
      } catch {
        return false;
      }
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await health(3000)) return true;
      }
      return false;
    })();
    spawnPromise = attempt;
    // Reset on failure so a later turn (or a restarted worker) can retry —
    // a one-time cold-start failure must not poison the whole server process.
    void attempt.then((ok) => { if (!ok && spawnPromise === attempt) spawnPromise = null; });
  }
  return spawnPromise;
}

/**
 * Fire-and-forget engine warmup (called from instrumentation.ts on server
 * boot): spawns the worker if cold and waits for /health in the background.
 */
export function warmupDecisionEngine(): void {
  if (!autoSpawnEnabled()) return;
  void ensureWorker().then((ok) => {
    console.log(ok ? "[decision] engine warm on " + decisionEngineUrl() : "[decision] warmup did not reach /health");
  });
}

/** Engine unreachable: keep chat alive, standard_chat with every renderer off. */
export function fallbackEnvelope(message: string): DecisionEnvelope {
  return {
    active_mode: "standard_chat",
    confidence: 0,
    decided_by: "fallback",
    stripped_prompt: message,
    skill_to_load: null,
    allowed_code_fence: null,
    disable_validators: RENDERER_MODES.filter((m) => m !== "standard_chat") as RendererMode[],
    enable_validator: "standard_chat",
    task_constraints: [],
    extracted_entities: [],
    needle_latency_ms: 0,
    lfm_latency_ms: 0,
  };
}

export async function getDecision(
  message: string,
  conversationHistory: { role: string; content: string }[] = [],
): Promise<DecisionEnvelope> {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return fallbackEnvelope("");
  try {
    if (!(await ensureWorker())) throw new Error("decision engine unreachable");
    const res = await fetch(decisionEngineUrl() + "/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: trimmed, conversationHistory }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`decision engine HTTP ${res.status}`);
    const env = (await res.json()) as DecisionEnvelope;
    if (!isRendererMode(env.active_mode)) throw new Error(`bad active_mode: ${env.active_mode}`);
    return env;
  } catch (err) {
    console.warn("[decision] engine unavailable, falling back to standard_chat:", (err as Error).message);
    return fallbackEnvelope(trimmed);
  }
}
