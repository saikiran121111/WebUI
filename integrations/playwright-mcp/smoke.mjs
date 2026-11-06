// Ruke integration smoke test for Microsoft Playwright MCP (see README.md).
//
// Proves, against the REAL upstream package (no mocks):
//   1. the pinned identity of @playwright/mcp in node_modules (version+license),
//   2. the CLI starts over stdio and completes the MCP handshake,
//   3. every tool the Ruke bridge (rust-backend/crates/ruke-browser/src/mcp.rs)
//      depends on exists with the pinned build,
//   4. an attach to Ruke's OWN launch mechanism (host.rs DevToolsActivePort
//      handshake) drives navigate/fill/click/press/tabs through MCP, and
//   5. an INDEPENDENT raw CDP read confirms MCP is driving that SAME browser.
//
// Run from anywhere:  node integrations/playwright-mcp/smoke.mjs
// Exit 0 = all checks passed. Model-free: uses no inference backend.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_VERSION = "0.0.84";
const PINNED_LICENSE = "Apache-2.0";
// Exact 0.0.84 names (captured live via tools/list — history is
// `browser_navigate_back`; there is no forward tool).
const REQUIRED_TOOLS = [
  "browser_navigate", "browser_navigate_back", "browser_find", "browser_press_key",
  "browser_click", "browser_type", "browser_fill_form", "browser_select_option",
  "browser_hover", "browser_drag", "browser_drop", "browser_snapshot", "browser_take_screenshot",
  "browser_mouse_move_xy", "browser_mouse_click_xy", "browser_mouse_drag_xy",
  "browser_mouse_down", "browser_mouse_up", "browser_mouse_wheel",
  "browser_wait_for", "browser_tabs", "browser_file_upload", "browser_handle_dialog",
];
const MARKER = "RUKE-MCP-SMOKE-9T4X";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const results = [];
let failed = false;
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) { failed = true; finish(1); }
}

let mcp = null, chrome = null, server = null, tmp = "";
function finish(code) {
  try { mcp?.kill(); } catch {}
  try { chrome?.kill(); } catch {}
  try { server?.close(); } catch {}
  try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  for (const line of results) console.log(line);
  console.log(failed ? "SMOKE: FAILED" : "SMOKE: ALL GREEN");
  setTimeout(() => process.exit(code), 250);
}
setTimeout(() => { results.push("FAIL watchdog timeout"); finish(2); }, 120_000).unref?.();

// 1. package identity --------------------------------------------------------
const pkgDir = path.join(ROOT, "node_modules", "@playwright", "mcp");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
check(`identity: @playwright/mcp@${PINNED_VERSION} in node_modules`,
  pkg.name === "@playwright/mcp" && pkg.version === PINNED_VERSION,
  `found ${pkg.name}@${pkg.version} (repo ${pkg.repository?.url ?? "?"})`);
check(`license: ${PINNED_LICENSE}`, pkg.license === PINNED_LICENSE
  && fs.readFileSync(path.join(pkgDir, "LICENSE"), "utf8").includes("Apache License"),
  `package.json license=${pkg.license}`);
const cli = path.join(pkgDir, pkg.bin && typeof pkg.bin === "object" ? (pkg.bin["mcp-server-playwright"] ?? pkg.bin["playwright-mcp"] ?? "cli.js") : "cli.js");
check("CLI entry resolves", fs.existsSync(cli), cli);

// 2. launch Chromium exactly like host.rs (port 0 + DevToolsActivePort) -----
function findChromium() {
  if (process.env.RUKE_MCP_SMOKE_CHROME) return process.env.RUKE_MCP_SMOKE_CHROME;
  const ms = path.join(ROOT, ".data", "ms-playwright");
  if (!fs.existsSync(ms)) return null;
  const mac = (d) => ["Chromium.app/Contents/MacOS/Chromium", "mac/Chromium.app/Contents/MacOS/Chromium",
    "mac-x64/Chromium.app/Contents/MacOS/Chromium", "mac-arm64/Chromium.app/Contents/MacOS/Chromium"]
    .map((p) => path.join(d, p)).find((p) => fs.existsSync(p));
  for (const dir of fs.readdirSync(ms).filter((d) => d.startsWith("chromium-")).sort()) {
    const base = path.join(ms, dir);
    const hit = ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome",
      "chrome-linux64/chrome"].map((p) => path.join(base, p)).find((p) => fs.existsSync(p))
      ?? (process.platform === "darwin" ? mac(base) : null);
    if (hit) return hit;
  }
  return null;
}
const exe = findChromium();
check("vendored Chromium found (Ruke's authorized browser)", !!exe, exe ?? "run `npx playwright install chromium` at the project root");
tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruke-mcp-smoke-"));
const profile = path.join(tmp, "profile"), outDir = path.join(tmp, "out");
fs.mkdirSync(profile); fs.mkdirSync(outDir);
chrome = spawn(exe, [
  "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });
let port = 0;
const dap = path.join(profile, "DevToolsActivePort");
for (let i = 0; i < 60 && !port; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (fs.existsSync(dap)) port = parseInt(fs.readFileSync(dap, "utf8").split("\n")[0].trim(), 10);
}
check("DevToolsActivePort handshake (host.rs mechanism)", port > 0, `port=${port}`);

// tiny marker fixture (self-contained; never touches the app's :3210) -------
const inputs = { form: `<form id="f" method="get"><input id="a" name="a"><input id="b" name="b"><button id="go" type="submit">Go</button></form>` };
server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/form") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><head><title>${MARKER}-FORM</title></head><body><h1>${MARKER}</h1>${inputs.form}<p id="echo">${u.searchParams.get("a") ? "DONE " + MARKER : ""}</p></body></html>`);
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><h1>${MARKER}-HOME</h1><a id="link" href="/form?done=1">to form</a></body></html>`);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// 3. MCP stdio client (line-delimited JSON-RPC — the MCP stdio framing) -----
mcp = spawn(process.execPath, [cli,
  `--cdp-endpoint=http://127.0.0.1:${port}`,
  "--caps", "vision", "--no-webmcp", "--image-responses", "allow",
  `--output-dir=${outDir}`, "--timeout-action", "10000", "--timeout-navigation", "30000",
  "--timeout-settle", "500", "--headless",
], { stdio: ["pipe", "pipe", "pipe"] });
mcp.stderr.on("data", (d) => process.stderr.write(`[mcp] ${d}`));
let buf = "";
const pending = new Map();
let nextId = 1;
mcp.stdin.on("error", () => {}); // post-exit EPIPE during teardown: expected
const send = (method, params) => {
  const id = nextId++;
  try {
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  } catch {}
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
mcp.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  }
});
const init = await send("initialize", {
  protocolVersion: "2025-06-18",
  clientInfo: { name: "ruke-mcp-smoke", version: "1.0.0" },
  capabilities: {},
});
check("MCP initialize over stdio", init.serverInfo?.name === "Playwright",
  JSON.stringify(init.serverInfo));
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

const listed = await send("tools/list", {});
const names = new Set((listed.tools ?? []).map((t) => t.name));
const missing = REQUIRED_TOOLS.filter((t) => !names.has(t));
check(`tool inventory (${names.size} tools; bridge subset)`, missing.length === 0,
  missing.length ? `missing: ${missing.join(", ")}` : "all bridge tools present");

const call = (name, args) => send("tools/call", { name, arguments: args });
const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

// 4. drive the SAME Chromium through the bridge's exact tool vocabulary -----
const nav = await call("browser_navigate", { url: `${base}/` });
check("browser_navigate", !nav.isError, text(nav).split("\n")[0]);
const tabs1 = await call("browser_tabs", { action: "new" });
check("browser_tabs new", !tabs1.isError, text(tabs1).split("\n")[0]);
await call("browser_navigate", { url: `${base}/form` });
const fill = await call("browser_fill_form", {
  fields: [
    { target: "#a", name: "a", type: "textbox", value: `${MARKER}-A` },
    { target: "#b", name: "b", type: "textbox", value: `${MARKER}-B` },
  ],
});
check("browser_fill_form (batch)", !fill.isError, text(fill).split("\n").pop());
const click = await call("browser_click", { element: "to form link", target: "#go" });
check("browser_click", !click.isError, text(click).split("\n")[0]);
const snap = await call("browser_snapshot", {});
const snapText = text(snap);
check(`page readback contains submit echo + both fills`,
  snapText.includes(`DONE ${MARKER}`) && snapText.includes(`${MARKER}-A`) && snapText.includes(`${MARKER}-B`),
  snapText.slice(0, 500).replace(/\n/g, " ⏎ "));
await call("browser_press_key", { key: "Enter" });
const tabs2 = await call("browser_tabs", { action: "list" });
check("browser_tabs list", !tabs2.isError && text(tabs2).includes(`${base}/form`), text(tabs2).replace(/\n/g, " ⏎ ").slice(0, 200));
const sel = await call("browser_tabs", { action: "select", index: 0 });
check("browser_tabs select", !sel.isError, text(sel).split("\n")[0]);
const shot = await call("browser_take_screenshot", { scale: "css", type: "jpeg" });
const img = (shot.content ?? []).find((c) => c.type === "image");
check("vision screenshot returns image block", !!img && (img.data ?? "").startsWith("/9j/"),
  img ? `${img.data.length} b64 chars` : "no image part");
const wf = await call("browser_wait_for", { text: MARKER });
check("browser_wait_for(text)", !wf.isError, text(wf).split("\n")[0]);

// 5. independent proof: raw CDP sees the MCP-driven pages in THIS Chromium --
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const urls = targets.filter((t) => t.type === "page").map((t) => t.url);
check("same browser: raw CDP shows MCP-driven targets",
  urls.some((u) => u.startsWith(base)), urls.join(" | "));

finish(0);
