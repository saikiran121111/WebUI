/**
 * AUDIT 2026-11-05 (brief item 17 / WS17) — distinct scheme-less `www`
 * paths must not collapse.
 *
 * Audit repro (verbatim): "`Compare www.example.com/product/A and
 * www.example.com/product/B` loses a product path. Full HTTPS and
 * SPA-route controls pass."
 * Cause (verbatim): "detectUrlsAndDomains Pass 2 deduplicates by host.
 * Pass 1 was fixed to use full URL; the equivalent fix did not reach
 * Pass 2."
 * Fix (verbatim): "Fix consistent full-page identity across URL forms,
 * retaining host suppression only where it avoids a duplicate bare-domain
 * interpretation."
 *
 * Pins (universal page-identity law — example.com/test data only, no
 * brand/site rules):
 *  - scheme-less www tokens with DISTINCT paths are DISTINCT targets;
 *  - host+path case and query survive identity checks (case-sensitive
 *    product paths);
 *  - the SAME page written twice (any form pair: www/www, https/www)
 *    dedupes to ONE entry — the identity fix never duplicates detection;
 *  - the same law already pinned for `https://` forms (full-URL dedupe,
 *    SPA routes, anchor collapse) keeps passing;
 *  - bare-domain suppression SURVIVES: a path-less repeat of an
 *    already-detected host stays suppressed (that is the one place the
 *    audit says host suppression belongs).
 */
import { describe, expect, it } from "vitest";

import { detectPromptUrls } from "@/lib/web-search/url-detector";

describe("WS17 — scheme-less www paths keep full page identity", () => {
  it("two distinct www paths on one host both survive (audit repro)", () => {
    const urls = detectPromptUrls(
      "Compare www.example.com/product/A and www.example.com/product/B",
    );
    // THE DEFECT: Pass 2 dedupes by host — the second path is lost.
    expect(urls).toContain("https://www.example.com/product/A");
    expect(urls).toContain("https://www.example.com/product/B");
  });

  it("host is case-folded but path/query case survives as page identity", () => {
    const urls = detectPromptUrls(
      "open www.Example.COM/Product/A?ref=1 and www.example.com/product/a?ref=2",
    );
    expect(urls).toContain("https://www.example.com/Product/A?ref=1");
    expect(urls).toContain("https://www.example.com/product/a?ref=2");
  });

  it("the SAME scheme-less www page twice still dedupes to one entry", () => {
    const urls = detectPromptUrls(
      "see www.example.com/product/A again www.example.com/product/A",
    );
    expect(
      urls.filter((u) => u === "https://www.example.com/product/A"),
      "identity-based dedupe must not duplicate detection",
    ).toHaveLength(1);
  });

  it("the same page in https form and scheme-less www form is ONE detection", () => {
    const urls = detectPromptUrls(
      "https://www.example.com/product/A and also www.example.com/product/A",
    );
    expect(
      urls.filter((u) => u === "https://www.example.com/product/A").length,
      "cross-form identity: Pass 2 must key on the same full page URL Pass 1 uses",
    ).toBe(1);
  });

  it("bare-with-path form obeys the same page-identity law (consistent across forms)", () => {
    const urls = detectPromptUrls(
      "Compare example.com/product/A and example.com/product/B",
    );
    expect(urls).toContain("https://example.com/product/A");
    expect(urls).toContain("https://example.com/product/B");
  });

  it("host suppression REMAINS for the path-less bare-domain form", () => {
    const urls = detectPromptUrls("visit skiran.dev again skiran.dev and once more skiran.dev");
    expect(
      urls.filter((u) => u === "https://skiran.dev"),
      "the bare-domain duplicate interpretation must stay suppressed",
    ).toHaveLength(1);

    const urls2 = detectPromptUrls("read https://shop.example.com/x then just shop.example.com");
    expect(
      urls2.filter((u) => u === "https://shop.example.com"),
      "a bare host token after a full URL of the same host stays suppressed",
    ).toHaveLength(0);
  });

  it("control: the already-fixed full-https + SPA-route identities keep passing", () => {
    const urls = detectPromptUrls(
      "compare https://shop.example.com/product/A and https://shop.example.com/product/B",
    );
    expect(urls).toContain("https://shop.example.com/product/A");
    expect(urls).toContain("https://shop.example.com/product/B");
    const routes = detectPromptUrls(
      "compare https://shop.example.com/app#/products/1 and https://shop.example.com/app#/products/2",
    );
    expect(routes).toHaveLength(2);
  });
});
