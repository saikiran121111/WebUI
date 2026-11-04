// E2E helper: logging pass-through proxy between the Next dev server and the
// real llama.cpp upstream. Start the dev server with
//   LLM_API_URL=http://127.0.0.1:8099/v1/chat/completions
// so every /api/chat round-trip is recorded verbatim while the real model
// still answers (live-chat suites keep working). The lazy-load regression in
// tests/regression_modalities.spec.ts reads the recorded payloads via
//   GET /__captured   -> JSON array of recent upstream request bodies
//   GET /__reset      -> clears the recording
// SSE responses are piped through untouched.
import http from "node:http";

const UPSTREAM = process.env.E2E_LLM_UPSTREAM ?? "http://127.0.0.1:8080/v1/chat/completions";
const captured = [];

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__captured") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(captured));
    return;
  }
  if (req.method === "GET" && req.url === "/__reset") {
    captured.length = 0;
    res.writeHead(204);
    res.end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    // Only record real chat completions POSTs. Under the Rust backend the
    // stats/probe paths hit the proxy base URL with GETs (empty bodies), and
    // that noise used to flood the ring and shift out the real capture.
    if (req.method === "POST" && body.length > 0) {
      captured.push(body.toString("utf8"));
      if (captured.length > 200) captured.shift();
    }
    const up = http.request(
      UPSTREAM,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer no-key",
          Accept: "text/event-stream",
        },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 200, {
          "Content-Type": upRes.headers["content-type"] ?? "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        upRes.pipe(res);
      },
    );
    up.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "e2e proxy: upstream unreachable" }));
    });
    up.end(body);
  });
});

server.listen(8099, "127.0.0.1", () => console.log("e2e llm proxy listening on 127.0.0.1:8099 ->", UPSTREAM));
