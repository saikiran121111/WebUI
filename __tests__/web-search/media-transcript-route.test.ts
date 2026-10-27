/**
 * Route tests for POST /api/internal/media-transcript (the UNIVERSAL
 * transcript RPC — app/api/internal/media-transcript/route.ts). The
 * provider-neutral engine is mocked at its boundary; what's under test
 * is auth, url validation, and the {ok,url,transcript} contract. The
 * route itself contains no domain/URL-shape logic — and that's the
 * contract this file pins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getBrowserTranscript: vi.fn() }));
vi.mock("@/lib/web-search/media-captions", () => ({
  getBrowserTranscript: mocks.getBrowserTranscript,
}));

import { POST } from "@/app/api/internal/media-transcript/route";

const SECRET = "test-bridge-secret";

function req(body: unknown, secret?: string): NextRequest {
  return new NextRequest("http://localhost/api/internal/media-transcript", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-ruke-internal-secret": secret } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.RUKE_BROWSER_BRIDGE_SECRET = SECRET;
  mocks.getBrowserTranscript.mockReset();
  mocks.getBrowserTranscript.mockResolvedValue("");
});
afterEach(() => {
  delete process.env.RUKE_BROWSER_BRIDGE_SECRET;
});

it("401 with the secret env unset; 401 on missing/wrong header", async () => {
  delete process.env.RUKE_BROWSER_BRIDGE_SECRET;
  expect((await POST(req({ url: "https://example.com/watch" }, SECRET))).status).toBe(401);
  expect((await POST(req({ url: "https://example.com/watch" }))).status).toBe(401);
  expect((await POST(req({ url: "https://example.com/watch" }, "n0pe-but-same-size"))).status).toBe(401);
});

it("400 on malformed JSON and on missing/empty url", async () => {
  expect((await POST(req("oops{{{", SECRET))).status).toBe(400);
  expect((await POST(req({}, SECRET))).status).toBe(400);
  expect((await POST(req({ url: "" }, SECRET))).status).toBe(400);
  expect(mocks.getBrowserTranscript).not.toHaveBeenCalled();
});

it("200: transcript flows through untouched, ok reflects non-emptiness", async () => {
  mocks.getBrowserTranscript.mockResolvedValue("[00:00] hello\n[01:00] world");
  const res = await POST(req({ url: "https://any.provider/embed/abc" }, SECRET));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    url: "https://any.provider/embed/abc",
    transcript: "[00:00] hello\n[01:00] world",
  });
  expect(mocks.getBrowserTranscript).toHaveBeenCalledWith("https://any.provider/embed/abc");
});

it("engine degradation (no captions / unsafe url) → ok:false with empty transcript, still 200", async () => {
  const res = await POST(req({ url: "https://provider.example/no-captions" }, SECRET));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: false,
    url: "https://provider.example/no-captions",
    transcript: "",
  });
});
