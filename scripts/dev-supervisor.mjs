#!/usr/bin/env node
/**
 * scripts/dev-supervisor.mjs — the unified `npm run dev` lifecycle
 * (Part 8, MIGRATION-MAP §7, incl. the Part-8 LIFECYCLE CORRECTION:
 * `npm run dev` now builds the Rust backend itself — no manual
 * `cargo build` step is ever required for the default workflow).
 *
 * Deterministic lifecycle:
 *   1. resolve repo root, PORT / RUKE_BACKEND_PORT, config
 *   2. fail-fast WILDCARD-bind port pre-check. Next must never silently
 *      move 3000→3001: the proxy/bridge contracts pin both ports.
 *   3. `cargo build --manifest-path rust-backend/Cargo.toml` — ALWAYS run
 *      before anything starts (cargo's own incremental fingerprinting
 *      makes an unchanged build cheap, and a stale binary can never be
 *      launched). A build failure aborts the supervisor non-zero BEFORE
 *      any child exists — Next never starts, no stale exe runs.
 *      The cargo process (and its rustc/linker descendants) is a
 *      supervised child: Ctrl+C during the build kills exactly the tree
 *      this supervisor created — never any other project's cargo.
 *   4. locate the built executable: CARGO_TARGET_DIR (if set, resolved
 *      against the repo root) else rust-backend/target, debug profile.
 *      RUKE_SERVER_BIN is an ADVANCED override: when set it is used
 *      verbatim and the cargo build is SKIPPED (the contract for pointing
 *      at a pre-built/custom exe; the default UX is still only
 *      `npm run dev`).
 *   5. spawn ruke-server as a DIRECT child (Rule 12 — never detached,
 *      never via shell wrappers whose PIDs we cannot supervise), then
 *      WAIT for `GET /api/ruke/health` → 200 on the loopback backend
 *      port (bounded timeout; if the child exits while waiting, that is
 *      a startup failure, not a success).
 *   6. spawn `next dev` as a DIRECT child, then wait until the Next port
 *      accepts TCP connections (pre-spawn ownership guarantees it is OUR
 *      listener binding the requested port).
 *   7. print the ready banner ONLY once both services are actually up,
 *      then supervise both children.
 *
 * Environment handoff (unchanged since Part 8):
 *   - rust child: RUKE_PROJECT_ROOT (repo root, so settings/conversations
 *     resolve exactly like the TS chain), RUKE_BACKEND_PORT, and the
 *     Tier-3b bridge pair (RUKE_BROWSER_BRIDGE_BASE_URL = the Next
 *     origin + RUKE_BROWSER_BRIDGE_SECRET = a random per-run secret).
 *   - next child: RUKE_RUST_BACKEND=1 — the ONLY switch that arms the
 *     thin-proxy branches in app/api/** (lib/server/rustProxy.ts) —
 *     plus RUKE_BACKEND_PORT and the SAME bridge secret so the
 *     /api/internal/browser-read RPC can authorize the Rust→Next hop.
 *
 * Teardown (Windows process supervision): on SIGINT/SIGBREAK/SIGTERM, on this
 * process exiting, or when EITHER child exits first, we kill every
 * still-live supervised tree (cargo during build, ruke-server, next)
 * with `taskkill /PID <pid> /T /F` on Windows (next dev spawns its own
 * workers; a bare child.kill() leaves them orphaned and they hold ports
 * 3000/3101 against the next `npm run dev`). Cleanup is strictly
 * PID/tree-scoped to processes THIS supervisor spawned — never by image
 * name. The first child's exit code is propagated (an unexpected clean
 * 0 exit is still a failure ⇒ exit 1).
 *
 * The supervisor never issues model requests itself — it only builds,
 * starts, wires, and stops processes.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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

// ---------------------------------------------------------------- config
const exeName = isWin ? "ruke-server.exe" : "ruke-server";
const overrideBin = (process.env.RUKE_SERVER_BIN || "").trim() || null;
// Cargo resolves a relative CARGO_TARGET_DIR against the process cwd —
// which for us is always the repo root — so resolve the same way.
const targetDir = (process.env.CARGO_TARGET_DIR || "").trim()
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, "rust-backend", "target");
const defaultRustBin = path.join(targetDir, "debug", exeName);
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
// the listeners themselves bind catches the clash pre-spawn instead —
// BEFORE the cargo build, so a held port fails fast, not after minutes
// of compilation.
// The BACKEND port additionally gets a 127.0.0.1-exact probe, because
// that is exactly how ruke-server binds: the realistic stale holder is a
// leftover ruke-server.exe, and on Windows a wildcard probe does NOT see
// a loopback-only holder (and ruke-server would happily bind alongside
// it, leaving two servers competing for the bridge contract).
function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    if (host) srv.listen(Number(port), host);
    else srv.listen(Number(port));
  });
}

for (const [label, port, hosts] of [
  ["next dev (PORT)", nextPort, [null]],
  ["ruke-server (RUKE_BACKEND_PORT)", backendPort, [null, "127.0.0.1"]],
]) {
  for (const host of hosts) {
    if (!(await portFree(port, host))) {
      die(`port ${port} is already in use (${label}). Stop the stale process or pick another port.`);
    }
  }
}

// ---------------------------------------------------------------- teardown
// Every child this supervisor ever spawns (cargo during the build,
// ruke-server, next dev) lives in this set; teardown kills exactly these
// process trees, and nothing else. PID-scoped `taskkill /T /F` on
// Windows reaches the grandchildren (next workers, rustc/linker) that a
// bare kill() would orphan.
const children = new Set();

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
  for (const child of children) killTree(child);
  process.exit(code);
}

// Registered BEFORE the cargo build so Ctrl+C at any lifecycle stage
// (including mid-compile) tears down whatever tree exists at that moment.
process.on("SIGINT", () => teardown(130));
// Windows console CTRL_BREAK_EVENT (Ctrl+Break) arrives as SIGBREAK. The
// Rust child's tokio ctrl_c already answers CTRL_BREAK; the supervisor
// must tear its tree down on the same event or the break leaves orphans.
process.on("SIGBREAK", () => teardown(130));
process.on("SIGTERM", () => teardown(143));
process.on("exit", () => {
  for (const child of children) killTree(child);
});

// ---------------------------------------------------------------- cargo build
if (overrideBin) {
  if (!fs.existsSync(overrideBin)) {
    die(`RUKE_SERVER_BIN is set but no executable exists at: ${overrideBin}`);
  }
  console.log(
    `[dev-supervisor] RUKE_SERVER_BIN override → ${overrideBin} — cargo build SKIPPED (advanced contract: keep that binary up to date yourself).`,
  );
} else {
  console.log("[dev-supervisor] Building Rust backend (cargo build)...");
  const buildCode = await new Promise((resolve) => {
    const cargo = spawn(
      "cargo",
      ["build", "--manifest-path", path.join(root, "rust-backend", "Cargo.toml")],
      { cwd: root, stdio: "inherit" },
    );
    children.add(cargo);
    cargo.on("error", (err) => {
      console.error("[dev-supervisor] failed to spawn cargo — is the Rust toolchain on PATH?", err);
      resolve(127);
    });
    cargo.on("exit", (code, signal) => {
      children.delete(cargo);
      resolve(signal ? 128 : (code ?? 1));
    });
  });
  if (tearingDown) process.exit(process.exitCode); // Ctrl+C hit during the build
  if (buildCode !== 0) {
    die(
      `Rust backend build failed (cargo exit ${buildCode}; compiler diagnostics above). ` +
        `Next and ruke-server were NOT started and no stale binary was launched.`,
    );
  }
  console.log("[dev-supervisor] Rust backend build OK.");
}

const rustBin = overrideBin ?? defaultRustBin;
if (!fs.existsSync(rustBin)) {
  die(
    `build reported success but no executable at ${rustBin} — ` +
      `check CARGO_TARGET_DIR / cargo config.toml overrides.`,
  );
}

// ---------------------------------------------------------------- bridge secret
const bridgeSecret = crypto.randomBytes(24).toString("hex");

// ---------------------------------------------------------------- readiness
async function waitFor(probe, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function healthOk(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: Number(port), path: "/api/ruke/health", timeout: 1000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect(Number(port), "127.0.0.1");
    sock.setTimeout(1000);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------- spawn: rust
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
children.add(rust);
rust.on("error", (err) => {
  console.error("[dev-supervisor] failed to spawn ruke-server:", err);
  teardown(1);
});
rust.on("exit", (code, signal) => {
  if (tearingDown) return;
  // An unexpected clean 0 exit here is still a broken topology: exit 1.
  const c = signal ? 128 : (code || 1);
  console.error(`[dev-supervisor] ruke-server exited (${signal ?? code}); stopping next dev.`);
  teardown(c);
});
console.log(`[dev-supervisor] starting ruke-server ${path.relative(root, rustBin)} (pid ${rust.pid}) on 127.0.0.1:${backendPort}...`);
if (!(await waitFor(() => healthOk(backendPort), 30_000))) {
  die(`ruke-server did not answer GET /api/ruke/health on :${backendPort} within 30 s — startup failed.`);
}
console.log("[dev-supervisor] Rust backend ready.");

// ---------------------------------------------------------------- spawn: next
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
children.add(next);
next.on("error", (err) => {
  console.error("[dev-supervisor] failed to spawn next dev:", err);
  teardown(1);
});
next.on("exit", (code, signal) => {
  if (tearingDown) return;
  const c = signal ? 128 : (code || 1);
  console.error(`[dev-supervisor] next dev exited (${signal ?? code}); stopping ruke-server.`);
  teardown(c);
});
console.log(`[dev-supervisor] starting next dev (pid ${next.pid}) on 127.0.0.1:${nextPort}...`);
// The port pre-check proved the port free pre-spawn, so a live listener
// here is OUR next dev. (Note: next dev binds early and compiles
// on-request; "listening" means the origin is reachable, not that every
// route has finished compiling.)
if (!(await waitFor(() => portOpen(nextPort), 60_000))) {
  die(`next dev did not start listening on :${nextPort} within 60 s — startup failed.`);
}
console.log("[dev-supervisor] Next.js ready (listening).");

// ---------------------------------------------------------------- banner
console.log(
  "[dev-supervisor] Ready\n" +
    `  UI:      http://localhost:${nextPort}\n` +
    `  Backend: http://127.0.0.1:${backendPort}\n` +
    "  proxy delegation ON · bridge secret armed\n" +
    "Press Ctrl+C to stop RUKE.",
);

// First child out wins: whatever died (crash or Ctrl+C cascade) tears the
// other down too, so `npm run dev` never leaves a half-up backend.
