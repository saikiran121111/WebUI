/**
 * Brief §12 — headless-reader hop validation vectors.
 *
 * The agentBrowser pool reads the whole page with real Chromium: before
 * this fix only the FIRST URL was vetted (isSafeUrl at the entry), while
 * Playwright re-fires the page-route handler for EVERY navigation
 * redirect and EVERY subresource. A page could therefore aim an
 * iframe/fetch/redirect hop at a link-local or private address
 (cloud metadata, localhost services) and the browser itself would dial
 * it. The exported routeDecision law is the enforcement point; these
 * vectors pin it — plus the entry rejection, which returns before the
 * pool is ever touched (so no browser launch can happen here).
 *
 * The security law is pinned AGAINST WEAKENING: the SSRF line runs even
 * while the WAF-challenge allowance is open. Tests use the real
 * isSafeUrl (never mocked) — the shared TS⇔Rust vectors in
 * security.test.ts own its classification table.
 */
import { describe, expect, it } from "vitest";
import { routeDecision, extractUrlBrowser } from "@/lib/web-search/agentBrowser";

describe("page-route SSRF hop gate (routeDecision, brief §12)", () => {
  const unsafe = [
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://127.0.0.1:8080/admin", // loopback service
    "http://localhost/redis", // loopback by name
    "http://10.0.0.5/", // private range
    "http://192.168.1.1/router", // private range
    "http://[::1]/", // IPv6 loopback literal
    "http://fd00::1/internal", // IPv6 ULA literal
  ];

  it("refuses every private/link-local hop, whatever the resource type", () => {
    for (const u of unsafe) {
      for (const rt of ["document", "xhr", "fetch", "image", "font", "media"]) {
        expect(routeDecision(u, rt, false), `${u} (${rt})`).toBe("ssrf-abort");
      }
    }
  });

  it("the WAF-challenge allowance NEVER opens the internal range", () => {
    for (const u of unsafe) {
      expect(routeDecision(u, "image", true), u).toBe("ssrf-abort");
      expect(routeDecision(u, "script", true), u).toBe("ssrf-abort");
    }
    // Control: the allowance genuinely opens ordinary public resources.
    expect(routeDecision("https://public.example/challenge.js", "script", true)).toBe("continue");
    expect(routeDecision("https://public.example/t.woff2", "font", true)).toBe("continue");
    expect(routeDecision("https://public.example/clip.mp4", "media", true)).toBe("continue");
  });

  it("public hosts keep the pre-existing fast-load laws byte-for-byte", () => {
    expect(routeDecision("https://shop.example/product", "document", false)).toBe("continue");
    expect(routeDecision("https://shop.example/thumb.jpg", "image", false)).toBe("continue");
    expect(routeDecision("https://shop.example/track.js", "font", false)).toBe("fastload-abort");
    expect(routeDecision("https://shop.example/bg.mp4", "media", false)).toBe("fastload-abort");
    expect(routeDecision("https://shop.example/ws", "websocket", false)).toBe("fastload-abort");
    // Generic ad-family rules stay (ad-abort checked before the WAF pass).
    expect(routeDecision("https://www.google-analytics.com/collect", "script", false)).toBe("ad-abort");
    expect(routeDecision("https://www.google-analytics.com/collect", "script", true)).toBe("ad-abort");
  });
});

describe("entry rejection returns before the pool exists", () => {
  it("an unsafe first URL gets the honest unsafe outcome, no browser touched", async () => {
    const res = await extractUrlBrowser("http://169.254.169.254/latest/meta-data/");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unsafe URL");
    expect(res.bodyText).toBe("");
    expect(res.finalUrl).toBe("");
  });
});
