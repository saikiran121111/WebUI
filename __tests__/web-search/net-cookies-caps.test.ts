/**
 * §8 (brief 2026-11-04) transport regressions against the ACTUAL INSTALLED
 * clients — got-scraping 4.2.2 / got 14.6.6 against a real local 302
 * server, not stubs:
 *   1. Redirect chains carry cookies: got 14.6.6 invokes beforeRedirect as
 *      `hook(updatedOptions, typedResponse)` (core/index.js:702). The old
 *      three-parameter hook read `response` from an always-undefined third
 *      slot, so the brief's controlled 302 repro produced NO_COOKIE. The
 *      server below asserts what each hop ACTUALLY received; a hook
 *      regression makes the reflected body fail the pin.
 *   2. Byte caps hold during consumption AND after decompression, for body
 *      AND rawBytes (old got kept the FULL rawBody: limitBytes:32 retained
 *      5,000 raw bytes) and are byte-accurate, not char-accurate.
 *   3. Cookie jar scope: Domain=/Path=/Secure/expiry honored; a Domain=
 *      grant can never cross the registrable domain (no cross-account
 *      leakage); account-path cookies never ride to unrelated paths.
 *   4. Gzip: decode-exactly-once kept; genuinely corrupt/truncated gzip
 *      (magic present) is a clean failure, never mojibake.
 *
 * The SSRF guard is vi.mocked to pass so the stack runs against loopback —
 * ssrf.ts has its own suite; these pins are about cookie/byte plumbing.
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/web-search/ssrf", () => ({
  isSafeUrl: () => true,
  isSafeUrlWithDns: async () => true,
  firstUnsafeRedirectHop: () => null,
}));

import { fetchPage, newCookieJar, readBounded } from "../../lib/web-search/net";

/* ── live 302-chain server (installed-client cookies + caps) ───────────── */

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
    if (path === "/big") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("x".repeat(5000));
      return;
    }
    if (path === "/uni") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("é".repeat(100)); // 100 chars, 200 BYTES
      return;
    }
    if (path === "/gz") {
      const gz = gzipSync(Buffer.from("y".repeat(5000)));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gz);
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

describe("installed got chain carries cookies (brief §8 NO_COOKIE repro)", () => {
  it("302→302→200: every hop replays the cookies earned upstream", async () => {
    const res = await fetchPage(`${base}/start`, { timeoutMs: 8000 });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    // The SERVER'S OWN reflection of the Cookie header each hop received:
    // a hook-arity regression leaves /mid and /final cookieless.
    expect(seen["/mid"]).toContain("s=1");
    expect(seen["/final"]).toContain("s=1");
    expect(seen["/final"]).toContain("t=2");
    expect(res!.body).toContain("s=1");
    expect(res!.body).toContain("t=2");
    // Final hop + resolved chain
    expect(res!.resolvedUrl).toBe(`${base}/final`);
    expect(res!.cookies.join(";")).toContain("f=3");
  });

  it("POST → 303 → GET transition keeps the session cookie alive", async () => {
    const res = await fetchPage(`${base}/postp`, { method: "POST", timeoutMs: 8000 });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(seen["/postg"]).toContain("p=1");
    expect(res!.body).toContain("p=1");
  });
});

describe("byte caps: during consumption, after decompression, body AND rawBytes", () => {
  it("limitBytes:32 caps BOTH body and rawBytes (brief repro: 5,000 raw bytes retained)", async () => {
    const res = await fetchPage(`${base}/big`, { limitBytes: 32, timeoutMs: 8000 });
    expect(res).not.toBeNull();
    expect(res!.body.length).toBeLessThanOrEqual(32);
    expect(res!.rawBytes).toBeDefined();
    expect(res!.rawBytes!.byteLength).toBeLessThanOrEqual(32);
  });

  it("multibyte caps are BYTE-accurate, not char-accurate", async () => {
    const res = await fetchPage(`${base}/uni`, { limitBytes: 50, timeoutMs: 8000 });
    expect(res).not.toBeNull();
    // Old char-slice would keep 50 chars = 100 bytes; the cap is 50 BYTES.
    expect(Buffer.byteLength(res!.body, "utf8")).toBeLessThanOrEqual(50);
    expect(res!.rawBytes!.byteLength).toBeLessThanOrEqual(50);
  });

  it("gzip bodies cap AFTER decompression (decompress:true stream chunks are true bytes)", async () => {
    const res = await fetchPage(`${base}/gz`, { limitBytes: 32, timeoutMs: 8000 });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.body.length).toBeLessThanOrEqual(32);
    // The retained raw bytes are DECOMPRESSED and capped — 5,000 'y's never
    // survive as raw, decompressed or otherwise.
    expect(Buffer.from(res!.rawBytes!).toString("utf8")).toBe("y".repeat(32));
    expect(res!.rawBytes!.byteLength).toBeLessThanOrEqual(32);
  });
});

/* ── cookie jar scope law (units, no sockets) ──────────────────────────── */

describe("cookie jar scope: Domain/Path/Secure/expiry, registrable-domain confinement", () => {
  it("host-only cookies stay on the exact host", () => {
    const jar = newCookieJar();
    jar.absorb("https://www.example.com/", ["h=1"]);
    expect(jar.cookieFor("https://www.example.com/x")).toBe("h=1");
    expect(jar.cookieFor("https://example.com/x")).toBeNull();
  });

  it("Domain=-scoped cookies ride subdomains of the SAME registrable domain", () => {
    const jar = newCookieJar();
    jar.absorb("https://www.example.com/", ["d=1; Domain=example.com"]);
    expect(jar.cookieFor("https://shop.example.com/")).toBe("d=1");
    expect(jar.cookieFor("https://example.com/")).toBe("d=1");
    expect(jar.cookieFor("https://notexample.com/")).toBeNull();
  });

  it("a Domain= grant NEVER crosses the registrable domain (cross-account boundary)", () => {
    const jar = newCookieJar();
    // Hostile grants from evil.com: unrelated site and public-suffix.
    jar.absorb("https://evil.com/", ["x=1; Domain=example.com"]);
    jar.absorb("https://evil.com/", ["y=1; Domain=.co"]);
    expect(jar.cookieFor("https://example.com/")).toBeNull();
    expect(jar.cookieFor("https://shop.co/")).toBeNull();
  });

  it("Path-scoped account cookies never ride to unrelated paths", () => {
    const jar = newCookieJar();
    jar.absorb("https://acme.com/account/settings", ["acct=1; Path=/account"]);
    expect(jar.cookieFor("https://acme.com/account/orders")).toBe("acct=1");
    expect(jar.cookieFor("https://acme.com/public/share")).toBeNull();
  });

  it("default-path follows the setting URL's directory (RFC 6265 §5.1.4)", () => {
    const jar = newCookieJar();
    jar.absorb("https://acme.com/checkout/cart", ["dp=1"]);
    expect(jar.cookieFor("https://acme.com/checkout/pay")).toBe("dp=1");
    expect(jar.cookieFor("https://acme.com/other")).toBeNull();
  });

  it("Secure cookies are withheld from http: URLs", () => {
    const jar = newCookieJar();
    jar.absorb("https://sec.example.com/", ["s=1; Secure"]);
    expect(jar.cookieFor("https://sec.example.com/")).toBe("s=1");
    expect(jar.cookieFor("http://sec.example.com/")).toBeNull();
  });

  it("expiry deletes: empty value, Max-Age<=0, past Expires", () => {
    const jar = newCookieJar();
    jar.absorb("https://x.example.com/", ["k=v"]);
    expect(jar.cookieFor("https://x.example.com/")).toBe("k=v");
    jar.absorb("https://x.example.com/", ["k=; Max-Age=0"]);
    expect(jar.cookieFor("https://x.example.com/")).toBeNull();
    jar.absorb("https://x.example.com/", ["k=v"]);
    jar.absorb("https://x.example.com/", ["k=v; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
    expect(jar.cookieFor("https://x.example.com/")).toBeNull();
  });

  it("same name in different scopes coexists; most specific path orders first", () => {
    const jar = newCookieJar();
    jar.absorb("https://y.example.com/", ["k=global; Path=/"]);
    jar.absorb("https://y.example.com/admin/", ["k=admin; Path=/admin"]);
    expect(jar.cookieFor("https://y.example.com/admin/x")).toBe("k=admin; k=global");
    expect(jar.cookieFor("https://y.example.com/public")).toBe("k=global");
  });
});

/* ── decode vs corruption (readBounded law) ────────────────────────────── */

describe("gzip: decode-exactly-once vs corrupt, clean text never mojibake", () => {
  it("clean gzip decodes exactly once (wire bytes in, text out)", async () => {
    const wire = gzipSync(Buffer.from("hello gzip"));
    const out = await readBounded(wire, 1 << 20, true);
    expect(out).toBe("hello gzip");
  });

  it("already-decoded bytes labeled plain pass through untouched", async () => {
    const out = await readBounded(Buffer.from("hello plain"), 1 << 20, false);
    expect(out).toBe("hello plain");
  });

  it("mislabeled clean text (header echoes gzip, bytes already decoded) survives", async () => {
    const sink: { bytes?: Uint8Array } = {};
    const out = await readBounded(Buffer.from("plain hello"), 1 << 20, true, sink);
    expect(out).toBe("plain hello");
    expect(Buffer.from(sink.bytes!).toString("utf8")).toBe("plain hello");
  });

  it("corrupt gzip (magic present, decode fails) is a clean failure, not mojibake", async () => {
    const sink: { bytes?: Uint8Array } = {};
    const broken = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("garbage-not-deflate")]);
    const out = await readBounded(broken, 1 << 20, true, sink);
    expect(out).toBe("");
    // Byte consumers still get the truncated truth for their own honest failure.
    expect(sink.bytes!.length).toBeGreaterThan(0);
  });

  it("truncated real gzip stream fails clean at the stream layer too", async () => {
    const full = gzipSync(Buffer.from("z".repeat(4000)));
    const truncated = full.subarray(0, Math.floor(full.length / 2));
    const out = await readBounded(truncated, 1 << 20, true);
    expect(out).toBe("");
  });

  it("web-stream body path decompresses once", async () => {
    const gz = gzipSync(Buffer.from("stream hello"));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(gz);
        c.close();
      },
    });
    const out = await readBounded(stream, 1 << 20, true);
    expect(out).toBe("stream hello");
  });
});
