// E2E helper: logging pass-through proxy between the Next dev server and the
// real llama.cpp upstream. Start the dev server with
//   LLM_API_URL=http://127.0.0.1:<port>/v1/chat/completions
// so every /api/chat round-trip is recorded verbatim while the real model
// still answers (live-chat suites keep working). The lazy-load regression in
// tests/regression_modalities.spec.ts reads the recorded payloads via
//   GET /__captured   -> JSON array of recent upstream request bodies
//   GET /__reset      -> clears the recording
// SSE responses are piped through untouched.
//
// F121 (2026-11-23) ROUTING LAW — replaces the old catch-all. The catch-all
// forwarded EVERY unhandled request as a POST to the chat URL, so the Rust
// model-stats polls (GET /slots, GET /props) arrived at Strata as empty-body
// chat POSTs ("400 invalid request: messages must be a non-empty list",
// spamming even between valid turns), and an upstream pipe into a client
// socket that had already closed (aborted stream) was an uncaught EPIPE that
// KILLED the proxy — the Python planner then saw its control endpoint
// connection-refused (status 0 on /health, /api/tags AND /props), concluded
// "the main model is not loaded, so there is nothing to reclaim", and refused
// the GPU handoff window (F91.1 fell to Tesseract twice). Rules, in order:
//   * local:   GET /__captured, GET /__reset, GET /__identity
//   * GET  passthrough (same method+path upstream): /health /slots /props
//   * POST passthrough (lifecycle switches):        /load /unload
//   * POST /v1/chat/completions ONLY with valid JSON carrying a non-empty
//     messages array reaches the chat upstream (streaming preserved);
//     malformed chat -> local 400, NEVER forwarded (no dummy user message is
//     ever inserted; Strata's logs are never papered over).
//   * known path + wrong method -> 405; unknown path -> 404.
// No stats/health/control request can become inference. Every socket gets an
// error handler so an aborted chat cannot take the proxy down.
//
// Verifiable startup: the proxy binds E2E_LLM_PROXY_PORT (default 8099); on a
// port collision it binds an EPHEMERAL run-owned port instead and publishes
// {pid, port, upstream, upstream_chat} to E2E_LLM_PROXY_PORT_FILE. The
// wrapper must read that file, point LLM_API_URL at the ACTUAL port, and
// probe GET /__identity (which answers with this same identity) — so a batch
// can never run under a dead or foreign proxy, and no listener is killed.
import http from "node:http";
import { writeFileSync } from "node:fs";

const UPSTREAM = process.env.E2E_LLM_UPSTREAM ?? "http://127.0.0.1:8080/v1/chat/completions";
const PREFERRED_PORT = Number(process.env.E2E_LLM_PROXY_PORT ?? 8099);
const PORT_FILE = process.env.E2E_LLM_PROXY_PORT_FILE ?? "";
const captured = [];

const UP = new URL(UPSTREAM);
const UP_ORIGIN = UP.origin;
const CHAT_PATH = UP.pathname; // e.g. /v1/chat/completions

const GET_ROUTES = new Set(["/health", "/slots", "/props"]);
const POST_ROUTES = new Set(["/load", "/unload"]);

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// Pipe src -> dst so a closed peer on EITHER side tears the pair down quietly.
// Without these handlers an EPIPE/ECONNRESET mid-stream is an UNCAUGHT
// exception and the whole proxy process dies (F121 cause B).
function pipeSafe(src, dst) {
  src.pipe(dst);
  src.on("error", () => src.destroy());
  dst.on("error", () => src.destroy());
}

// Forward one fully-buffered request to the upstream origin, preserving
// method + path + body. The response is piped through untouched (SSE-safe).
function forward(res, method, targetPath, body, extraHeaders) {
  const up = http.request(
    UP_ORIGIN + targetPath,
    { method, headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders) },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, {
        "Content-Type": upRes.headers["content-type"] ?? "application/json",
        ...(method === "POST" && targetPath === CHAT_PATH
          ? { "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" }
          : {}),
      });
      pipeSafe(upRes, res);
    },
  );
  up.on("error", (err) => {
    if (!res.headersSent) {
      json(res, 502, { error: `e2e proxy: upstream unreachable (${err.code || err.message})` });
    } else {
      res.destroy();
    }
  });
  up.end(body);
}

const server = http.createServer((req, res) => {
  let path;
  try {
    path = new URL(req.url, "http://127.0.0.1").pathname;
  } catch {
    json(res, 400, { error: "e2e proxy: malformed request target" });
    return;
  }
  const query = req.url.length > path.length ? req.url.slice(path.length) : "";

  const chunks = [];
  req.on("error", () => req.destroy());
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    if (req.method === "GET" && path === "/__captured") {
      json(res, 200, captured);
      return;
    }
    if (req.method === "GET" && path === "/__reset") {
      captured.length = 0;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && path === "/__identity") {
      json(res, 200, {
        pid: process.pid,
        port: server.address()?.port ?? null,
        upstream: UPSTREAM,
        upstream_chat: CHAT_PATH,
      });
      return;
    }

    if (GET_ROUTES.has(path)) {
      if (req.method !== "GET") {
        json(res, 405, { error: `e2e proxy: ${req.method} ${path} not allowed; use GET` });
        return;
      }
      forward(res, "GET", path + query, Buffer.alloc(0));
      return;
    }
    if (POST_ROUTES.has(path)) {
      if (req.method !== "POST") {
        json(res, 405, { error: `e2e proxy: ${req.method} ${path} not allowed; use POST` });
        return;
      }
      forward(res, "POST", path + query, body);
      return;
    }
    if (path === CHAT_PATH) {
      if (req.method !== "POST") {
        json(res, 405, { error: `e2e proxy: ${req.method} ${path} not allowed; use POST` });
        return;
      }
      // Only a genuine chat completion may reach the chat endpoint. The
      // validation is the proxy's own: empty body, broken JSON, a missing
      // messages list, or an EMPTY messages list are refused HERE (local 400)
      // so Strata never logs phantom "messages must be a non-empty list" 400s
      // from non-chat traffic, and a malformed real request is not laundered
      // into the model with a dummy message.
      let payload = null;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch { /* malformed -> refused below */ }
      const validChat =
        payload !== null && typeof payload === "object" &&
        Array.isArray(payload.messages) && payload.messages.length > 0;
      if (!validChat) {
        json(res, 400, {
          error: "e2e proxy: only chat completions with a non-empty messages array are forwarded; request NOT sent upstream",
        });
        return;
      }
      captured.push(body.toString("utf8"));
      if (captured.length > 200) captured.shift();
      forward(res, "POST", CHAT_PATH + query, body, {
        Authorization: "Bearer no-key",
        Accept: "text/event-stream",
      });
      return;
    }

    json(res, 404, { error: `e2e proxy: no route for ${req.method} ${path}` });
  });
});

function publishPort(port) {
  if (!PORT_FILE) return;
  try {
    writeFileSync(PORT_FILE, JSON.stringify({ pid: process.pid, port, upstream: UPSTREAM, upstream_chat: CHAT_PATH }));
  } catch { /* preflight probe will catch a dead proxy */ }
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && PREFERRED_PORT !== 0) {
    // Run-owned fallback: bind an ephemeral port and publish it. The wrapper
    // reads the port file and points the app at the ACTUAL port; a foreign
    // listener on the preferred port is left completely untouched.
    console.log(`port ${PREFERRED_PORT} busy; binding an ephemeral run-owned port`);
    server.listen(0, "127.0.0.1");
    return;
  }
  console.error("e2e proxy listen failed:", err.code || err.message);
  process.exit(97);
});

server.listen(PREFERRED_PORT, "127.0.0.1", () => {
  const port = server.address().port;
  publishPort(port);
  console.log(`e2e llm proxy listening on 127.0.0.1:${port} ->`, UPSTREAM);
});
