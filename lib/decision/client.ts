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
import { spawn, spawnSync } from "child_process";
import fsSync from "fs";
import path from "path";
import { projectRoot } from "../skills/registry";
import { childLogger } from "../server/logger";
import { RENDERER_MODES, isRendererMode, type DecisionEnvelope, type RendererMode } from "./types";

const log = childLogger("decision");

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

// ── Ownership kill-switch + reaper (Windows teardown guarantee) ────────
// In-process shutdown hooks are NOT reliable here: closing the dev window
// (taskkill w/o /F, console destroy) TerminateProcess()es the whole console
// tree — probes verified Node 'exit'/SIGINT markers AND the worker's atexit /
// watchdog / ctrl-handler NEVER run on that path; llama-server was left
// LISTENING on :8791 holding ~500MB. Two layers, neither needs the dying
// process to cooperate beyond dying:
//   1. This kill-switch: process.on('exit') runs taskkill /F /T on the
//      launcher subtree. Covers process.exit()/uncaught-exception/Ctrl+C-
//      via-Next teardown (the paths where Node DOES reach JS handlers).
//   2. engine_reaper.ps1 (spawned hidden next to the worker): kernel-waits on
//      THIS process's PID and kills the subtree when it dies — covers abrupt
//      Terminate/console-destroy where no JS ever runs.
// The worker's own watchdog + atexit remain the graceful (and the POSIX) path.
let ownedWorkerPid = 0;
let killSwitchInstalled = false;

function ownedWorkerKill(): void {
  if (!ownedWorkerPid) return;
  const pid = ownedWorkerPid;
  ownedWorkerPid = 0;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
        timeout: 10_000,
        stdio: "ignore",
      });
    } else {
      // POSIX: the worker's DECISION_ENGINE_PARENT_PID watchdog shuts llama
      // down gracefully the moment this process dies; SIGKILL is the backstop.
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // already gone or no rights — nothing left to reclaim
  }
}

function trackOwnedWorker(pid: number | undefined): void {
  if (!pid) return;
  ownedWorkerPid = pid;
  if (!killSwitchInstalled) {
    killSwitchInstalled = true;
    process.on("exit", ownedWorkerKill);
  }
}

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
          // NOT detached, on purpose: DETACHED_PROCESS makes Windows IGNORE
          // CREATE_NO_WINDOW, so python (a console-subsystem exe) gets its own
          // NEW VISIBLE console — the black popup window (title = the venv
          // python.exe path) users saw at `npm run dev`. Non-detached creates
          // NO new window. Do NOT count on Ctrl+C/window-close reaching the
          // worker itself — delivery is unreliable (see the kill-switch:
          // trackOwnedWorker + taskkill /F /T from Node's 'exit').
          detached: false,
          windowsHide: true,
          // Pipe (not ignore) so the worker's own [decision] / [decision-engine]
          // lines — engine warm-up, LFM2.5 failures, routing guards — surface
          // in the `npm run dev` terminal through pino instead of vanishing.
          stdio: ["ignore", "pipe", "pipe"],
          // DECISION_ENGINE_PARENT_PID: the worker runs a watchdog on THIS
          // process's PID and shuts itself + llama-server down gracefully
          // when we die. It is the backstop, not the guarantee — see
          // trackOwnedWorker(child.pid) below for the deterministic kill.
          // Do NOT bare child.kill() anywhere: that only signals the launcher
          // and would orphan llama-server; taskkill /T walks the full subtree.
          env: { ...process.env, DECISION_ENGINE_SPAWNED_BY: "webui", DECISION_ENGINE_PARENT_PID: String(process.pid) },
        });
        child.unref();
        // Deterministic teardown for the paths where JS still runs
        // (process.exit(), uncaught exceptions, Next's Ctrl+C shutdown):
        // Node's 'exit' runs a synchronous taskkill /F /T over launcher →
        // worker → llama-server even if the worker never executed a line of
        // its own shutdown code. It does NOT fire on console window-destroy
        // (probes wrote no marker on that path) — the reaper below covers it.
        // Cleared once the worker exits on its own so a recycled PID is never
        // killed.
        trackOwnedWorker(child.pid);
        child.on("exit", () => {
          if (ownedWorkerPid === child.pid) ownedWorkerPid = 0;
        });
        // Layer 2 (Windows): hidden reaper kernel-waits on OUR pid and
        // reclaims the engine the instant we die — including console-destroy
        // deaths where NO JS/Python shutdown code runs at all. It reaps the
        // launcher tree AND llama-server straight from its pidfile (llama.cpp
        // detaches its own console at startup, so llama escapes every
        // console-teardown group; that orphan was the user's 500MB leak).
        // The reaper is launched through a throwaway PowerShell running
        // Start-Process -WindowStyle Hidden so its console lives OUTSIDE our
        // console's destroy group — a directly-spawned reaper was itself
        // TerminateProcess()ed mid-wait in testing (2026-10-20). Recycled-PID
        // (StartTime) + cmdline guards keep unrelated processes (e.g. Strata's
        // llama-server) untouchable; the reaper self-exits after.
        if (process.platform === "win32" && child.pid) {
          const reaper = path.join(projectRoot(), ".decision-engine", "worker", "engine_reaper.ps1");
          const llamaPidfile = path.join(projectRoot(), ".decision-engine", ".cache", "llama_server.pid");
          if (fsSync.existsSync(reaper)) {
            try {
              const inner = `& '${reaper.replace(/'/g, "''")}' ${process.pid} ${child.pid} '${llamaPidfile.replace(/'/g, "''")}'`;
              const b64 = Buffer.from(inner, "utf16le").toString("base64");
              const r = spawn(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command",
                 `Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${b64}' | Out-Null`],
                { cwd: projectRoot(), detached: false, windowsHide: true, stdio: "ignore" },
              );
              r.unref();
            } catch {
              // reaper failed to start; boot-reclaim remains the backstop
            }
          }
        }
        // Relay worker output line-by-line into the dev terminal. unref() the
        // pipes so a long-lived worker can never hold the web server's event
        // loop open on shutdown.
        const relay = (stream: NodeJS.ReadableStream | null, level: "info" | "warn") => {
          if (!stream) return;
          (stream as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
          let buf = "";
          stream.setEncoding("utf8");
          stream.on("data", (chunk: string) => {
            buf += chunk;
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim()) log[level](line.trim());
            }
          });
          stream.on("end", () => { if (buf.trim()) log[level](buf.trim()); buf = ""; });
        };
        relay(child.stdout, "info");
        relay(child.stderr, "warn");
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
 * Boot reclaim: without this, a worker left behind by a crashed/killed older
 * dev session (or a manual launch) answers /health, ensureWorker() ADOPTS it,
 * and `npm run dev` never owns the engine — so stopping dev can never stop it
 * (the exact orphan the user hit). At server boot we therefore kill whatever
 * holds our contained decision-port (:8790) BEFORE deciding to spawn. The
 * whole launcher→worker→llama subtree goes (/T), which frees :8791 too;
 * the worker's own _reclaim_orphan_llama() is the backstop. Command-line
 * matching ("decision_server.py" / the contained .venv) means NOTHING outside
 * ./.decision-engine is ever touched — Strata on :8080 is never in range.
 */
function killStaleEngine(): void {
  if (process.platform !== "win32") return; // port-scraping recipe is Windows-specific
  const port = new URL(decisionEngineUrl()).port || "8790";
  try {
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], {
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    }).stdout ?? "";
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      // TCP  127.0.0.1:8790  0.0.0.0:0  LISTENING  <pid>
      if (parts.length >= 5 && parts[0].toUpperCase() === "TCP"
          && parts[1].endsWith(`:${port}`) && parts[3].toUpperCase() === "LISTENING") {
        pids.add(Number(parts[4]));
      }
    }
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 4) continue;
      const cl = spawnSync("powershell", ["-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], {
        encoding: "utf8", windowsHide: true, timeout: 15_000,
      }).stdout ?? "";
      if (/decision_server\.py|\.decision-engine[\\/]\.venv/.test(cl)) {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
          windowsHide: true, timeout: 15_000,
        });
        log.info(`reclaimed stale decision engine (pid ${pid}) from a previous session`);
      }
    }
  } catch {
    // best-effort: a failed reclaim just falls back to adopting/waiting as before
  }
}

/**
 * Fire-and-forget engine warmup (called from instrumentation.ts on server
 * boot): reclaims any stale engine from a previous session, then spawns ours
 * (watchdog-owned) and waits for /health in the background.
 */
export function warmupDecisionEngine(): void {
  if (!autoSpawnEnabled()) return;
  killStaleEngine();
  void ensureWorker().then((ok) => {
    if (ok) log.info(`engine warm on ${decisionEngineUrl()}`);
    else log.warn("warmup did not reach /health");
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
    log.warn({ err: (err as Error).message }, "engine unavailable — falling back to standard_chat");
    return fallbackEnvelope(trimmed);
  }
}
