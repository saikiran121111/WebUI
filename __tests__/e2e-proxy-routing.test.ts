// F121 routing law for scripts/e2e-llm-proxy.mjs, verified against a RECORDING
// MOCK upstream — zero real model inference. The law: only a genuine
// POST /v1/chat/completions with a non-empty messages array may reach the chat
// endpoint; stats/health/control traffic must never become inference; malformed
// chat is refused locally; an aborted stream must not kill the proxy; a port
// collision rebinds to a run-owned ephemeral port published through the port
// file. Every upstream request is recorded server-side (method + path), so
// "zero upstream chat requests" is a property of the recording, not of the
// proxy's self-report.
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PROXY = fileURLToPath(new URL("../scripts/e2e-llm-proxy.mjs", import.meta.url));

type Hit = { method: string; path: string; body: string };

interface Fixture {
  base: string; // proxy origin, e.g. http://127.0.0.1:PORT
  hits: Hit[];
  portFile: string;
  proxy: ChildProcess;
  upstream: http.Server;
}

const fixtures: Fixture[] = [];

function req(port: number, path: string, method = "GET", body = "", headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: d }));
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

async function startUpstream(overrides: Record<string, (res: http.ServerResponse, body: string) => void> = {}) {
  const hits: Hit[] = [];
  const server = http.createServer((rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({ method: rq.method ?? "", path: rq.url ?? "", body });
      const custom = overrides[rq.url ?? ""];
      if (custom) return custom(rs, body);
      if (rq.url === "/v1/chat/completions") {
        rs.writeHead(200, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ id: "mock", choices: [{ message: { role: "assistant", content: "ok" } }] }));
      } else if (rq.url === "/health") {
        rs.writeHead(200, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ status: "ok", loaded: true, service: "strata" }));
      } else if (rq.url === "/slots") {
        rs.writeHead(200, { "Content-Type": "application/json" });
        rs.end(JSON.stringify([{ id: 0, is_processing: false, n_prompt_tokens: 10, n_ctx: 4096 }]));
      } else if (rq.url === "/props") {
        rs.writeHead(200, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ model_alias: "mock", total_slots: 1 }));
      } else if (rq.url === "/load" || rq.url === "/unload") {
        rs.writeHead(200, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ status: rq.url === "/load" ? "loaded" : "unloaded" }));
      } else {
        rs.writeHead(404, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ error: "mock: no route" }));
      }
    });
  });
  const port = await listen(server);
  return { hits, server, origin: `http://127.0.0.1:${port}` };
}

async function startProxy(upstreamOrigin: string, port: number, portFile: string): Promise<ChildProcess> {
  const p = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      E2E_LLM_UPSTREAM: `${upstreamOrigin}/v1/chat/completions`,
      E2E_LLM_PROXY_PORT: String(port),
      E2E_LLM_PROXY_PORT_FILE: portFile,
    },
    stdio: "ignore",
  });
  return p;
}

async function fixture(opts: { port?: number; overrides?: Record<string, (res: http.ServerResponse, body: string) => void> } = {}): Promise<Fixture> {
  const up = await startUpstream(opts.overrides);
  const portFile = `${process.env.TEMP ?? "/tmp"}\\e2e-proxy-test-${Math.random().toString(36).slice(2)}.json`;
  if (existsSync(portFile)) rmSync(portFile);
  const proxy = await startProxy(up.origin, opts.port ?? 0, portFile);
  // Read the port file — the ONLY supported way to learn the bound port.
  let port = 0;
  for (let i = 0; i < 60 && !port; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(portFile)) {
      try {
        port = JSON.parse(readFileSync(portFile, "utf8")).port;
      } catch { /* partial write */ }
    }
  }
  if (!port) throw new Error("proxy never published a port file");
  // Identity check: the responding proxy is the one we spawned.
  const id = await req(port, "/__identity");
  expect(id.status).toBe(200);
  expect(JSON.parse(id.text).pid).toBe(proxy.pid);
  const f: Fixture = { base: `http://127.0.0.1:${port}`, hits: up.hits, portFile, proxy, upstream: up.server };
  fixtures.push(f);
  return f;
}

function portOf(f: Fixture): number {
  return Number(new URL(f.base).port);
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.proxy.kill();
    await new Promise<void>((r) => f.upstream.close(() => r()));
    if (existsSync(f.portFile)) rmSync(f.portFile);
  }
});

describe("F121 proxy routing law", () => {
  it("repeated stats/health polls produce ZERO upstream chat requests", async () => {
    const f = await fixture();
    const p = portOf(f);
    for (let i = 0; i < 3; i++) {
      expect((await req(p, "/slots")).status).toBe(200);
      expect((await req(p, "/props")).status).toBe(200);
      expect((await req(p, "/health")).status).toBe(200);
    }
    const chatHits = f.hits.filter((h) => h.path === "/v1/chat/completions");
    expect(chatHits.length).toBe(0);
    // ...and they really were GETs to the same paths upstream (Rust model-stats contract).
    const stats = f.hits.filter((h) => ["/slots", "/props", "/health"].includes(h.path));
    expect(stats.length).toBe(9);
    expect(stats.every((h) => h.method === "GET")).toBe(true);
  });

  it("one valid streaming chat produces exactly one upstream POST, piped untouched", async () => {
    const f = await fixture({
      overrides: {
        "/v1/chat/completions": (res) => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
        },
      },
    });
    const r = await req(portOf(f), "/v1/chat/completions", "POST", JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(r.status).toBe(200);
    expect(r.text).toContain("[DONE]");
    const chatHits = f.hits.filter((h) => h.path === "/v1/chat/completions" && h.method === "POST");
    expect(chatHits.length).toBe(1);
    expect(JSON.parse(chatHits[0].body).messages[0].content).toBe("hi");
  });

  it("malformed JSON and empty-messages chats get a LOCAL 400 and never reach upstream", async () => {
    const f = await fixture();
    const p = portOf(f);
    expect((await req(p, "/v1/chat/completions", "POST", "")).status).toBe(400);
    expect((await req(p, "/v1/chat/completions", "POST", "{nope")).status).toBe(400);
    expect((await req(p, "/v1/chat/completions", "POST", JSON.stringify({ messages: [] }))).status).toBe(400);
    expect((await req(p, "/v1/chat/completions", "POST", JSON.stringify({ messages: "notalist" }))).status).toBe(400);
    expect(f.hits.filter((h) => h.path === "/v1/chat/completions").length).toBe(0);
  });

  it("unknown routes get 404 and wrong methods get 405", async () => {
    const f = await fixture();
    const p = portOf(f);
    expect((await req(p, "/nope")).status).toBe(404);
    expect((await req(p, "/nope", "POST", "{}")).status).toBe(404);
    expect((await req(p, "/v1/chat/completions")).status).toBe(405); // GET chat
    expect((await req(p, "/health", "POST", "{}")).status).toBe(405);
    expect((await req(p, "/slots", "POST", "{}")).status).toBe(405);
    expect((await req(p, "/load", "GET")).status).toBe(405);
    expect(f.hits.filter((h) => h.path === "/v1/chat/completions").length).toBe(0);
  });

  it("lifecycle POSTs and stats GETs forward to their own upstream paths", async () => {
    const f = await fixture();
    const p = portOf(f);
    const load = await req(p, "/load", "POST", "{}");
    expect(load.status).toBe(200);
    expect(JSON.parse(load.text).status).toBe("loaded");
    const unload = await req(p, "/unload", "POST", "{}");
    expect(unload.status).toBe(200);
    expect(JSON.parse(unload.text).status).toBe("unloaded");
    expect((await req(p, "/health")).text).toContain("loaded");
    expect(f.hits.map((h) => h.path)).toEqual(expect.arrayContaining(["/load", "/unload", "/health"]));
    expect(f.hits.find((h) => h.path === "/load")?.method).toBe("POST");
    expect(f.hits.find((h) => h.path === "/health")?.method).toBe("GET");
    expect(f.hits.filter((h) => h.path === "/v1/chat/completions").length).toBe(0);
  });

  it("an occupied proxy port rebinding: fresh run-owned port, foreign listener untouched", async () => {
    // Foreign listener on a fixed port — the proxy must NOT kill it and NOT use it.
    const foreign = http.createServer((_rq, rs) => { rs.writeHead(500); rs.end("foreign"); });
    const foreignPort = await listen(foreign);
    const f = await fixture({ port: foreignPort });
    const bound = portOf(f);
    expect(bound).not.toBe(foreignPort);
    // The port file's identity answers on the NEW port, and it is OUR proxy.
    const id = JSON.parse((await req(bound, "/__identity")).text);
    expect(id.pid).toBe(f.proxy.pid);
    expect(id.upstream).toContain("v1/chat/completions");
    // The foreign listener is alive, answering as itself (untouched).
    expect((await req(foreignPort, "/__identity")).status).toBe(500);
    // Our proxy answers its own routes on the fresh port.
    expect((await req(bound, "/health")).status).toBe(200);
    await new Promise<void>((r) => foreign.close(() => r()));
  });

  it("an aborted streaming chat cannot kill the proxy", async () => {
    const f = await fixture({
      overrides: {
        "/v1/chat/completions": (res) => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n");
          // keep it open; the client below aborts mid-stream
        },
      },
    });
    const p = portOf(f);
    await new Promise<void>((resolve) => {
      const r = http.request(
        { host: "127.0.0.1", port: p, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => { res.on("data", () => { /* first chunk arrived; abort now */ res.destroy(); resolve(); }); },
      );
      r.on("error", () => resolve());
      r.end(JSON.stringify({ stream: true, messages: [{ role: "user", content: "abort me" }] }));
    });
    // The proxy process must be ALIVE to answer afterwards.
    expect((await req(p, "/__identity")).status).toBe(200);
    expect((await req(p, "/health")).status).toBe(200);
  });

  it("/__captured records only valid chat bodies; /__reset clears", async () => {
    const f = await fixture();
    const p = portOf(f);
    await req(p, "/slots");
    await req(p, "/v1/chat/completions", "POST", "{bad");
    expect(JSON.parse((await req(p, "/__captured")).text).length).toBe(0);
    await req(p, "/v1/chat/completions", "POST", JSON.stringify({ messages: [{ role: "user", content: "real" }] }));
    expect(JSON.parse((await req(p, "/__captured")).text).length).toBe(1);
    await req(p, "/__reset");
    expect(JSON.parse((await req(p, "/__captured")).text).length).toBe(0);
  });
});
