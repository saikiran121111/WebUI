import { describe, expect, it } from "vitest";
import { detectPromptUrls, detectUrlsAndDomains } from "../../lib/web-search/url-detector";

describe("url-detector: bare domains (tldts, all IANA TLDs)", () => {
  it("detects skiran.dev in the exact user-report sentence", () => {
    const out = detectUrlsAndDomains(
      "Here is the thing skiran.dev can you search this portfolio and tell me about him",
    );
    expect(out).toHaveLength(1);
    expect(out[0].domain).toBe("skiran.dev");
    expect(out[0].url).toBe("https://skiran.dev");
    expect(out[0].hasScheme).toBe(false);
  });

  it("detects a wide spread of TLDs and multi-part public suffixes", () => {
    const cases = [
      "blinkit.com",
      "zepto.co.in",
      "rbi.org.in",
      "lite.ego.app",
      "openai.com",
      "site.gg",
      "site.sh",
      "netlify.dev",
    ];
    for (const token of cases) {
      const out = detectUrlsAndDomains(`look at ${token} quickly`);
      expect(out.map((d) => d.domain), token).toContain(token);
    }
  });

  it("detects wildcard-suffix subdomains (vercel.app / github.io)", () => {
    const out = detectUrlsAndDomains("my deploy lives on my-site.vercel.app and repo.github.io");
    const domains = out.map((d) => d.domain);
    expect(domains).toContain("my-site.vercel.app");
    expect(domains).toContain("repo.github.io");
  });

  it("keeps scheme URLs with their path, and dedupes repeats", () => {
    const out = detectUrlsAndDomains(
      "compare https://skiran.dev/projects and skiran.dev plus www.example.co.uk",
    );
    const urls = out.map((d) => d.url);
    expect(urls).toContain("https://skiran.dev/projects");
    // bare repeat of an already-detected host is skipped
    expect(urls.filter((u) => u === "https://skiran.dev")).toHaveLength(0);
    expect(urls).toContain("https://www.example.co.uk");
  });

  it("code-filename guard: file tokens are NOT domains", () => {
    for (const token of ["app.ts", "report.pdf", "main.rs", "index.html", "weights.gguf", "config.json"]) {
      expect(detectUrlsAndDomains(`read ${token} now`), token).toHaveLength(0);
    }
  });

  it("guard exempts http(s):// and www.-prefixed file URLs", () => {
    const urls = detectPromptUrls("fetch https://example.com/app.ts and www.example.com/index.html");
    expect(urls.some((u) => u.startsWith("https://example.com/app.ts"))).toBe(true);
    expect(urls.some((u) => u.startsWith("https://www.example.com/index.html"))).toBe(true);
  });

  it("skips version numbers and short dotted noise", () => {
    expect(detectUrlsAndDomains("v1.2.3 of the v2.11.0 release, e.g. this, i.e. that")).toHaveLength(0);
  });

  it("no false positive on ordinary prose", () => {
    expect(detectUrlsAndDomains("tell me about recursion in plain English, no web needed")).toHaveLength(0);
  });
});
