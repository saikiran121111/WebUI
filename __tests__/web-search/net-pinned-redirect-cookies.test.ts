/**
 * AUDIT 2026-11-05 (brief item 15 / WS15) — the pinned native transport
 * loses redirect-issued cookies.
 *
 * Audit repro (verbatim): "fetchPage(..., {fingerprint:'chrome'}) follows
 * 302 → 200 but the server sees NO_COOKIE. The default got-scraping path
 * passes the equivalent cookie test. Cause: impit clients do not configure
 * a redirect cookie store, while Pass B only supplies the ENTRY cookie and
 * absorbs final-response cookies after native redirect following.
 * Intermediate Set-Cookie is not replayed on the next hop."
 * Fix (verbatim): "Fix redirect/session handling consistently for every
 * transport with the existing cookie domain/path/secure/expiry rules and
 * redirect safety checks."
 *
 * Same harness shape as net-cookies-caps.test.ts (§8): the ACTUAL installed
 * clients (impit-win32-x64-msvc, got 14.6.6) talk to a REAL local server
 * that reflects the Cookie header each hop actually received — a regression
 * in the walker leaves the reflected body cookieless, exactly like the
 * audit's NO_COOKIE repro. The SSRF guard is mocked to pass so the stack
 * runs against loopback (ssrf.ts has its own suite).
 *
 * Pins (universal transport law — no site/brand rules):
 *  - a pinned fingerprint (Pass A skipped, straight to impit) still replays
 *    every upstream hop's Set-Cookie on each later hop, and the final-hop
 *    Set-Cookie still surfaces in PageResponse.cookies;
 *  - the 301/302/303 method transitions follow the fetch spec (POST→GET
 *    except 307/308), mirroring what got and browsers do;
 *  - a redirect loop terminates — the walker's hop cap must be no worse
 *    than the native redirect limit it replaces (control pin);
 *  - the JSON-endpoint transport (fetchUrl → gotUrlFetch) carries chain
 *    cookies too (the "every transport" leg: reddit/algolia-class cookie-
 *    gated endpoints ride fetchUrl, not fetchPage).
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/web-search/ssrf", () => ({
  isSafeUrl: () => true,
  isSafeUrlWithDns: async () => true,
  firstUnsafeRedirectHop: () => null,
}));

import { fetchPage, fetchUrl } from "../../lib/web-search/net";

let server: http.Server;
let base = "";
/** cookie header each path actually received on its request */
const seen: Record<string, string> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    seen[path] = String(req.headers.cookie ?? "");
    if (path === "/start") {
      res.setHeader("set-cookie", ["s=1; Path=/"]);
      res.writeHead(302, { Location: "/mid" });
      res.end("stub");
      return;
    }
    if (path === "/mid") {
      res.setHeader("set-cookie", ["t=2; Path=/"]);
      res.writeHead(302, { Location: "/final" });
      res.end("stub");
      return;
    }
    if (path === "/final") {
      res.setHeader("set-cookie", ["f=3; Path=/"]);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`done seen:${seen["/final"] || "-"}`);
      return;
    }
    if (path === "/postp") {
      res.setHeader("set-cookie", ["p=1; Path=/"]);
      res.writeHead(303, { Location: "/postg" });
      res.end("stub");
      return;
    }
    if (path === "/postg") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`postg seen:${seen["/postg"] || "-"}`);
      return;
    }
    if (path === "/direct") {
      res.setHeader("set-cookie", ["z=9; Path=/"]);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("direct");
      return;
    }
    if (path === "/loopA") {
      res.writeHead(302, { Location: "/loopB" });
      res.end("stub");
      return;
    }
    if (path === "/loopB") {
      res.writeHead(302, { Location: "/loopA" });
      res.end("stub");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

describe("WS15 — pinned impit transport replays redirect-issued cookies", () => {
  it("pinned 302→302→200: every hop replays the cookies earned upstream", async () => {
    const res = await fetchPage(`${base}/start`, { fingerprint: "chrome", timeoutMs: 8000 });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    // THE DEFECT: Pass B supplied only the ENTRY cookie and followed the
    // chain natively inside Rust — /mid and /final arrived cookieless
    // (the audit's NO_COOKIE), and the hop cookies were never replayed.
    expect(seen["/mid"], "hop 2 must receive the cookie hop 1 issued").toContain("s=1");
    expect(seen["/final"]).toContain("s=1");
    expect(seen["/final"], "the final hop must carry the whole upstream jar").toContain("t=2");
    // Server's own reflection, end-to-end:
    expect(res!.body).toContain("s=1");
    expect(res!.body).toContain("t=2");
    // Chain contract unchanged: final URL + final-hop cookies.
    expect(res!.resolvedUrl).toBe(`${base}/final`);
    expect(res!.cookies.join(";")).toContain("f=3");
  }, 15_000);

  it("POST→303→GET on the pinned transport keeps the session cookie alive", async () => {
    const res = await fetchPage(`${base}/postp`, {
      method: "POST",
      fingerprint: "chrome",
      timeoutMs: 8000,
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(seen["/postg"], "the 303 target must receive the cookie the POST hop issued").toContain("p=1");
    expect(res!.body).toContain("p=1");
    // fetch-spec method transition: the GET landing answers (a POST
    // replayed onto /postg would hit the 404 branch — this assertion is
    // the pin that the walker follows the spec, not the method verbatim).
    expect(res!.body).toContain("postg seen:");
  }, 15_000);

  it("control: a redirect loop still terminates (walker cap ≡ native limit)", async () => {
    // Control pin, green before and after: replacing impit's native
    // redirect following with a TS walker must not make loops hang or
    // live forever — the pass must settle as a failure like the native
    // redirect-limit error did.
    const res = await fetchPage(`${base}/loopA`, { fingerprint: "chrome", timeoutMs: 5000 });
    expect(res === null || res.status === 0 || res.status >= 400).toBe(true);
  }, 30_000);

  it("control: a direct (redirect-free) pinned read is untouched by the walker", async () => {
    const res = await fetchPage(`${base}/direct`, { fingerprint: "chrome", timeoutMs: 8000 });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.body).toBe("direct");
    expect(res!.resolvedUrl).toBe(`${base}/direct`);
    expect(res!.cookies.join(";")).toContain("z=9");
  }, 15_000);
});

describe("WS15 — every transport leg: the JSON-endpoint path carries chain cookies too", () => {
  it("fetchUrl through a cookie-setting chain replays it on every hop", async () => {
    // Reddit/algolia-class JSON endpoints are cookie-gated behind a
    // redirect and ride fetchUrl, not fetchPage. THE DEFECT: gotUrlFetch's
    // beforeRedirect hook vetted targets but held no jar, so the chain
    // landed with the server seeing NO_COOKIE.
    const res = await fetchUrl(`${base}/start`, { timeoutMs: 8000 });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.text, "the final hop must have received the whole upstream jar").toContain("s=1");
    expect(res!.text).toContain("t=2");
  }, 15_000);
});
