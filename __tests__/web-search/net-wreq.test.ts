/**
 * Pinned wreq-js API contract (rollback restoration manifest §A.1).
 *
 * The historical Pass C transport passed timeout in SECONDS (timeoutMs/1000)
 * under the wrong option name (`emulate`, hidden by `as any`).  Pinned
 * wreq-js 3.2.0 takes `timeout` in MILLISECONDS and names the client option
 * `browser`.  User-verified reproduction, now pinned against the real native
 * binding: a 120 ms loopback response times out with timeout:30 and succeeds
 * with timeout:30000.
 *
 * Loopback is fine here: wreqFetch itself carries no SSRF guard — the Pass C
 * caller revalidates the entry URL and the final URL (net.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { wreqFetch } from "@/lib/web-search/net";

let srv: http.Server;
let base = "";
const delays = new Map<string, number>();

beforeAll(async () => {
  srv = http.createServer((req, res) => {
    const ms = delays.get(new URL(req.url ?? "/", base).pathname) ?? 0;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("delayed-ok");
    }, ms);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());

describe("wreq-js Pass C transport (⇔ manifest deviation 1)", () => {
  it("succeeds on a 120 ms response when timeout is in MILLISECONDS (regression: the old seconds bug)", async () => {
    delays.set("/slow", 120);
    const res = await wreqFetch(`${base}/slow`, { timeoutMs: 5_000 });
    // Under the old bug this call carried timeout:5 (ms) and returned null —
    // silent degradation away from the wreq TLS path.
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(true);
    expect(res!.status).toBe(200);
    expect(res!.body).toBe("delayed-ok");
    expect(res!.contentType).toContain("text/plain");
    // Final URL must be surfaced for the caller's SSRF revalidation.
    expect(res!.url).toBe(`${base}/slow`);
  });

  it("timeoutMs actually bounds the request (proves the option reaches wreq)", async () => {
    delays.set("/very-slow", 300);
    // 100 ms has huge headroom over a loopback round trip but is far below
    // the 300 ms server delay: proves a bounded timeout is enforced, not ignored.
    const res = await wreqFetch(`${base}/very-slow`, { timeoutMs: 100 });
    expect(res).toBeNull();
  });

  it("default timeout applies when timeoutMs is omitted", async () => {
    delays.set("/slow2", 120);
    const res = await wreqFetch(`${base}/slow2`);
    expect(res?.ok).toBe(true);
  });
});
