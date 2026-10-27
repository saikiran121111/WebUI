#!/usr/bin/env node
/**
 * scripts/dev-supervisor.mjs — the unified `npm run dev` lifecycle
 * (Part 8, MIGRATION-MAP §7).
 *
 * Spawns BOTH backends as DIRECT child processes of this Node process
 * (Rule 12 — never detached, never via shell wrappers whose PIDs we
 * cannot supervise):
 *
 *   1. `ruke-server` (the Rust backend, loopback :RUKE_BACKEND_PORT,
 *      default 3101)
 *   2. `next dev` (loopback :PORT, default 3000 — the authoritative
 *      user-facing origin)
 *
 * Environment handoff:
 *   - rust child: RUKE_PROJECT_ROOT (repo root, so settings/conversations
 *     resolve exactly like the TS chain), RUKE_BACKEND_PORT, and the
 *     Tier-3b bridge pair (RUKE_BROWSER_BRIDGE_BASE_URL = the Next
 *     origin + RUKE_BROWSER_BRIDGE_SECRET = a random per-run secret).
 *   - next child: RUKE_RUST_BACKEND=1 — the ONLY switch that arms the
 *     thin-proxy branches in app/api/** (lib/server/rustProxy.ts) —
 *     plus RUKE_BACKEND_PORT and the SAME bridge secret so the
 *     /api/internal/browser-read RPC can authorize the Rust→Next hop.
 *
 * Teardown (Windows process supervision): on SIGINT/SIGTERM, on this
 * process exiting, or when EITHER child exits first, we kill both
 * process trees with `taskkill /PID <pid> /T /F` on Windows (next dev
 * spawns its own workers; a bare child.kill() leaves them orphaned and
 * they hold ports 3000/3101 against the next `npm run dev`). The first
 * child's exit code is propagated.
 *
 * The supervisor never issues model requests itself — it only starts,
 * wires, and stops processes.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

function die(msg) {
  console.error(`[dev-supervisor] ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- binaries
const exeName = isWin ? "ruke-server.exe" : "ruke-server";
const rustCandidates = process.env.RUKE_SERVER_BIN
  ? [process.env.RUKE_SERVER_BIN]
  : ["debug", "release"].map((profile) =>
      path.join(root, "rust-backend", "target", profile, exeName),
    );
const rustBin = rustCandidates.find((p) => fs.existsSync(p));
if (!rustBin) {
  die(
    `ruke-server binary not found. Build it first:\n` +
      `  cargo build --manifest-path rust-backend/Cargo.toml\n` +
      `(looked in: ${rustCandidates.join(", ")})`,
  );
}
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
if (!fs.existsSync(nextBin)) {
  die(`next binary not found at ${nextBin} — run npm install first.`);
}

// ---------------------------------------------------------------- ports
const backendPort = (process.env.RUKE_BACKEND_PORT || "3101").trim();
const nextPort = (process.env.PORT || "3000").trim();

// Wildcard (dual-stack) probe: a 127.0.0.1-only bind can SUCCEED on
// Windows even while a 0.0.0.0/[::] listener holds the port (specific-IP
// binds are allowed next to a wildcard holder), which let `next dev`
// discover the clash only after spawn and silently fall back to 3001 —
// breaking the bridge base URL and proxy port contract. Probing the way
// the listeners themselves bind catches the clash pre-spawn instead.
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(Number(port));
  });
}

for (const [label, port] of [
  ["next dev (PORT)", nextPort],
  ["ruke-server (RUKE_BACKEND_PORT)", backendPort],
]) {
  if (!(await portFree(port))) {
    die(`port ${port} is already in use (${label}). Stop the stale process or pick another port.`);
  }
}

// ---------------------------------------------------------------- bridge secret
const bridgeSecret = crypto.randomBytes(24).toString("hex");

// ---------------------------------------------------------------- spawn
const rust = spawn(rustBin, [], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    RUKE_PROJECT_ROOT: root,
    RUKE_BACKEND_PORT: backendPort,
    RUKE_BROWSER_BRIDGE_BASE_URL: `http://127.0.0.1:${nextPort}`,
    RUKE_BROWSER_BRIDGE_SECRET: bridgeSecret,
  },
});
const next = spawn(process.execPath, [nextBin, "dev"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    RUKE_RUST_BACKEND: "1",
    RUKE_BACKEND_PORT: backendPort,
    RUKE_BROWSER_BRIDGE_SECRET: bridgeSecret,
  },
});

console.log(
  `[dev-supervisor] rust ${path.relative(root, rustBin)} (pid ${rust.pid}) on :${backendPort} · ` +
    `next dev (pid ${next.pid}) on :${nextPort} · proxy delegation ON`,
);

// ---------------------------------------------------------------- teardown
function killTree(child) {
  if (!child || child.pid == null || child.exitCode !== null || child.signalCode) return;
  try {
    if (isWin) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

let tearingDown = false;
function teardown(code) {
  if (tearingDown) return;
  tearingDown = true;
  killTree(rust);
  killTree(next);
  process.exit(code);
}

// First child out wins: whatever died (crash or Ctrl+C cascade) tears the
// other down too, so `npm run dev` never leaves a half-up backend.
rust.on("error", (err) => {
  console.error(`[dev-supervisor] failed to spawn ruke-server:`, err);
  teardown(1);
});
next.on("error", (err) => {
  console.error(`[dev-supervisor] failed to spawn next dev:`, err);
  teardown(1);
});
rust.on("exit", (code, signal) => {
  if (tearingDown) return;
  const c = signal ? 128 : (code ?? 0);
  console.error(`[dev-supervisor] ruke-server exited (${signal ?? code}); stopping next dev.`);
  teardown(c);
});
next.on("exit", (code, signal) => {
  if (tearingDown) return;
  const c = signal ? 128 : (code ?? 0);
  console.error(`[dev-supervisor] next dev exited (${signal ?? code}); stopping ruke-server.`);
  teardown(c);
});

process.on("SIGINT", () => teardown(130));
process.on("SIGTERM", () => teardown(143));
process.on("exit", () => {
  killTree(rust);
  killTree(next);
});
