/**
 * F48: tests for the guard that tests cannot ignore.
 *
 * A harness guard that is never itself tested is a rumour. These cases pin the
 * three things the guard must get right: which endpoint counts as the operator's
 * (and that a test cannot move that target by setting process.env), which
 * operations count as touching the model, and that the observing wrapper changes
 * nothing about the request it watches.
 *
 * Note what is NOT asserted here: the live server itself is never contacted.
 * Every transport below is a local stub.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_CHAT_URL,
  isProtectedLiveCall,
  looksLikeTestDouble,
  makeObservingFetch,
  methodOfFetchInput,
  operatorEndpointFromDisk,
  protectedPath,
  urlOfFetchInput,
} from "./live-provider-guard-core";
import { resourceKey } from "../../lib/server/resource-identity";

const OPERATOR = resourceKey("http://127.0.0.1:8080/v1/chat/completions");

const tempDirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ruke-operator-res-"));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("resolving WHICH server is the operator's", () => {
  it("settings.json wins over .env.local, exactly like lib/server/settings.ts", () => {
    const dir = fixture({
      "settings.json": JSON.stringify({ llm_api_url: "http://127.0.0.1:9090/v1/chat/completions" }),
      ".env.local": "LLM_API_URL=http://127.0.0.1:8080/v1/chat/completions\n",
    });
    const got = operatorEndpointFromDisk(dir);
    expect(got.source).toBe("settings.json:llm_api_url");
    expect(resourceKey(got.url)).toBe("http://127.0.0.1:9090");
  });

  it("falls through to .env.local when settings.json names no endpoint", () => {
    const dir = fixture({
      "settings.json": JSON.stringify({ compact_thresholds: { auto: 0, tokens: 0 } }),
      ".env.local": "LLM_API_KEY=no-key\nLLM_API_URL=http://127.0.0.1:8080/v1/chat/completions\n",
    });
    const got = operatorEndpointFromDisk(dir);
    expect(got.source).toBe(".env.local:LLM_API_URL");
    expect(resourceKey(got.url)).toBe(OPERATOR);
  });

  it("understands quoted and export-prefixed dotenv lines, and ignores unrelated keys", () => {
    const dir = fixture({
      ".env.local":
        "# comment\nOTHER=1\nexport LLM_API_URL=\"http://127.0.0.1:7777/v1/chat/completions\"\n",
    });
    expect(resourceKey(operatorEndpointFromDisk(dir).url)).toBe("http://127.0.0.1:7777");
  });

  it("uses the built-in fallback only when nothing on disk names an endpoint", () => {
    const dir = fixture({ "readme.txt": "nothing here" });
    const got = operatorEndpointFromDisk(dir);
    expect(got.url).toBe(FALLBACK_CHAT_URL);
    expect(got.source).toContain("fallback");
  });

  it("a test CANNOT move the target by setting process.env.LLM_API_URL", () => {
    // The whole reason this resolver reads disk only: suites set LLM_API_URL in
    // process.env to point at fakes, and a guard that read that would protect
    // the fake and leave the operator's server unguarded.
    const dir = fixture({ ".env.local": "LLM_API_URL=http://127.0.0.1:8080/v1/chat/completions\n" });
    const before = operatorEndpointFromDisk(dir);
    process.env.LLM_API_URL = "http://127.0.0.1:9/v1/chat/completions";
    try {
      const after = operatorEndpointFromDisk(dir);
      expect(resourceKey(after.url)).toBe(resourceKey(before.url));
      expect(after.source).toBe(".env.local:LLM_API_URL");
    } finally {
      delete process.env.LLM_API_URL;
    }
  });

  it("resolving the real repository's endpoint is immune to process.env too", () => {
    const before = operatorEndpointFromDisk(process.cwd());
    process.env.LLM_API_URL = "http://127.0.0.1:19999/v1/chat/completions";
    try {
      expect(operatorEndpointFromDisk(process.cwd())).toEqual(before);
    } finally {
      delete process.env.LLM_API_URL;
    }
  });
});

describe("protectedPath / isProtectedLiveCall", () => {
  it("classifies generation and the two lifecycle endpoints", () => {
    expect(protectedPath("/v1/chat/completions")).toBe("generation");
    expect(protectedPath("/v1/completions")).toBe("generation");
    expect(protectedPath("/V1/CHAT/COMPLETIONS/")).toBe("generation");
    expect(protectedPath("/unload")).toBe("lifecycle-unload");
    expect(protectedPath("/load")).toBe("lifecycle-reload");
    expect(protectedPath("/health")).toBeNull();
    expect(protectedPath("/api/chat")).toBeNull();
  });

  it("flags a generation POST aimed at the operator, whatever its loopback spelling", () => {
    for (const url of [
      "http://127.0.0.1:8080/v1/chat/completions",
      "http://localhost:8080/v1/chat/completions",
      "http://[::1]:8080/v1/completions",
      "http://127.0.0.1:8080/v1/chat/completions?x=1",
    ]) {
      expect(isProtectedLiveCall(url, "POST", OPERATOR), url).toBe("generation");
    }
  });

  it("flags the lifecycle pair on the operator origin", () => {
    expect(isProtectedLiveCall("http://127.0.0.1:8080/unload", "POST", OPERATOR)).toBe(
      "lifecycle-unload",
    );
    expect(isProtectedLiveCall("http://localhost:8080/load", "POST", OPERATOR)).toBe(
      "lifecycle-reload",
    );
  });

  it("leaves every mock origin alone", () => {
    // The mock endpoints the suite actually uses: the golden harness on :9, the
    // upstream-admission fake on :1234, and the Rust control port.
    for (const url of [
      "http://127.0.0.1:9/v1/chat/completions",
      "http://127.0.0.1:1234/v1/chat/completions",
      "http://127.0.0.1:8081/v1/chat/completions",
      "http://127.0.0.1:8787/api/attach/search",
      "https://example.invalid/v1/chat/completions",
    ]) {
      expect(isProtectedLiveCall(url, "POST", OPERATOR), url).toBeNull();
    }
  });

  it("does not flag a read-only probe or a non-POST verb on the operator origin", () => {
    expect(isProtectedLiveCall("http://127.0.0.1:8080/health", "GET", OPERATOR)).toBeNull();
    expect(isProtectedLiveCall("http://127.0.0.1:8080/unload", "GET", OPERATOR)).toBeNull();
    expect(isProtectedLiveCall("http://127.0.0.1:8080/v1/chat/completions", "HEAD", OPERATOR)).toBeNull();
  });
});

describe("reading the fetch arguments", () => {
  it("takes the URL from a string, a URL or a Request-like input", () => {
    expect(urlOfFetchInput("http://a.test/x")).toBe("http://a.test/x");
    expect(urlOfFetchInput(new URL("http://a.test/y"))).toBe("http://a.test/y");
    expect(urlOfFetchInput({ url: "http://a.test/z" } as unknown as Request)).toBe("http://a.test/z");
  });

  it("takes the method from init first, then from the Request, defaulting to GET", () => {
    expect(methodOfFetchInput("http://a.test/x", { method: "post" })).toBe("POST");
    expect(methodOfFetchInput({ url: "http://a.test/z", method: "POST" } as unknown as Request)).toBe(
      "POST",
    );
    expect(methodOfFetchInput({ url: "http://a.test/z" } as unknown as Request)).toBe("GET");
    expect(methodOfFetchInput("http://a.test/x")).toBe("GET");
  });
});

describe("the observing wrapper", () => {
  it("records the protected call and passes the response straight through", async () => {
    const violations: string[] = [];
    const previous = vi.fn(async () => new Response("ok", { status: 200 }));
    const wrapped = makeObservingFetch(
      previous as unknown as typeof fetch,
      OPERATOR,
      "fixture",
      violations,
    );
    const res = await wrapped("http://127.0.0.1:8080/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("generation POST http://127.0.0.1:8080/v1/chat/completions");
  });

  it("re-throws the transport error unchanged and records it too", async () => {
    const violations: string[] = [];
    const boom = new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:8080");
    const previous = vi.fn(async () => {
      throw boom;
    });
    const wrapped = makeObservingFetch(
      previous as unknown as typeof fetch,
      OPERATOR,
      "fixture",
      violations,
    );
    await expect(
      wrapped("http://127.0.0.1:8080/unload", { method: "POST" }),
    ).rejects.toBe(boom);
    expect(violations[0]).toContain("lifecycle-unload");
  });

  it("stays silent about a mock-targeted POST", async () => {
    const violations: string[] = [];
    const previous = vi.fn(async () => new Response("ok"));
    const wrapped = makeObservingFetch(
      previous as unknown as typeof fetch,
      OPERATOR,
      "fixture",
      violations,
    );
    await wrapped("http://127.0.0.1:9/v1/chat/completions", { method: "POST" });
    await wrapped("http://127.0.0.1:8080/health");
    expect(violations).toEqual([]);
  });

  it("catches a Request-shaped POST as well", async () => {
    const violations: string[] = [];
    const previous = vi.fn(async () => new Response("ok"));
    const wrapped = makeObservingFetch(
      previous as unknown as typeof fetch,
      OPERATOR,
      "fixture",
      violations,
    );
    const request = { url: "http://127.0.0.1:8080/v1/chat/completions", method: "POST" };
    await wrapped(request as unknown as Request);
    expect(violations.length).toBe(1);
  });

  it("never changes the outcome even if the observation itself throws", async () => {
    const previous = vi.fn(async () => new Response("fine"));
    // A malformed URL is the realistic fault here: parsing it must not become an
    // error the caller never would have seen.
    const wrapped = makeObservingFetch(previous as unknown as typeof fetch, OPERATOR, "fixture", []);
    const res = await wrapped("not a url at all" as unknown as string, { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("recognising an already-faked transport", () => {
  it("treats a vitest double as unobservable and a plain function as observable", () => {
    expect(looksLikeTestDouble(vi.fn(async () => new Response("x")))).toBe(true);
    expect(looksLikeTestDouble(vi.spyOn({ f: async () => 1 }, "f").mockResolvedValue(1))).toBe(true);
    expect(looksLikeTestDouble(async () => new Response("x"))).toBe(false);
    expect(looksLikeTestDouble(undefined)).toBe(false);
    expect(looksLikeTestDouble(globalThis.fetch)).toBe(false);
  });
});