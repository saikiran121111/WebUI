/**
 * AUDIT ITEM 8 + 10 VECTORS (2026-11-04) — the extractor cascade against a
 * mocked network layer, pinning two contracts the audit found broken:
 *
 *  8. A fetch whose redirects land on a DIFFERENT registrable site must
 *     carry the final URL/domain through packet + passage + provenance
 *     header, classify SUCCESS_REDIRECTED (never SUCCESS_DIRECT of the
 *     requested site), and must NOT write the page cache (a later hit
 *     would launder the provenance back to SUCCESS_DIRECT).
 * 10. An HTTP 401 is an auth-required access outcome, not a SUCCESS —
 *     it classifies FAIL_SILENT_LOGIN_WALL.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { extractUrl } from "@/lib/web-search/extractor";
import { getCachedPage, putCachedPage } from "@/lib/web-search/cache";
import { fetchPage } from "@/lib/web-search/net";
import type { RankedResult } from "@/lib/web-search/types";

vi.mock("@/lib/web-search/net", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    fetchPage: vi.fn(),
    fetchWithLinkPreviewBots: vi.fn(async () => null),
    fetchUrl: vi.fn(async () => null),
  };
});
vi.mock("@/lib/web-search/cache", () => ({
  getCachedPage: vi.fn(() => null),
  putCachedPage: vi.fn(),
}));
vi.mock("@/lib/web-search/agentBrowser", () => ({
  extractPageInOnePass: vi.fn(async () => ({
    ok: false,
    status: 0,
    error: "test pool disabled",
  })),
}));

const page = (over: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  contentType: "text/html; charset=utf-8",
  resolvedUrl: "",
  ...over,
});

const result = (over: Partial<RankedResult>): RankedResult =>
  ({
    canonical: "https://shop-a.example/p/item-42",
    title: "Shop A Product Page",
    snippet: "",
    domain: "shop-a.example",
    publishedDate: "",
    engine: "test",
    rrf: 1,
    engines: ["test"],
    engineRanks: {},
    origin: "serp",
    ...over,
  }) as unknown as RankedResult;

beforeEach(() => {
  vi.mocked(getCachedPage).mockReturnValue(null);
  vi.mocked(putCachedPage).mockClear();
  vi.mocked(fetchPage).mockReset();
});

describe("cross-registrable-domain provenance (audit item 8)", () => {
  it("redirect to another registrable site: honest URL, domain, header, label — no cache write", async () => {
    const body =
      "<html><head><title>Weekly Sale</title></head><body><h1>Weekly Sale Event</h1>" +
      "<p>" + "Great deals across groceries and daily essentials this week. ".repeat(8) +
      "</p></body></html>";
    vi.mocked(fetchPage).mockResolvedValue(
      page({
        body,
        rawBytes: new TextEncoder().encode(body),
        resolvedUrl: "https://partner-retail.example/sale/x",
      }) as never,
    );

    const packet = await extractUrl(result({}));
    expect(packet.classification).toBe("SUCCESS_REDIRECTED");
    expect(packet.url).toBe("https://partner-retail.example/sale/x");
    expect(packet.domain).toBe("partner-retail.example");
    const landed = packet.passages.at(-1)!;
    expect(landed.url).toBe("https://partner-retail.example/sale/x");
    expect(landed.passageText.startsWith("[Redirect provenance:")).toBe(true);
    expect(landed.passageText).toContain("https://partner-retail.example/sale/x");
    // The cross-site body must never be cached under the requested URL.
    expect(vi.mocked(putCachedPage)).not.toHaveBeenCalled();
  });

  it("same-site redirect keeps SUCCESS_DIRECT and the cache write", async () => {
    const body =
      "<html><body><h1>Product</h1><p>" +
      "Same site, different path — a normal redirect that must not trip " +
      "the cross-site rule at all. ".repeat(6) +
      "</p></body></html>";
    vi.mocked(fetchPage).mockResolvedValue(
      page({
        body,
        rawBytes: new TextEncoder().encode(body),
        resolvedUrl: "https://shop-a.example/p/item-42?mk=redirect",
      }) as never,
    );
    const packet = await extractUrl(result({}));
    expect(packet.classification).toBe("SUCCESS_DIRECT");
    expect(packet.url).toBe("https://shop-a.example/p/item-42");
    expect(vi.mocked(putCachedPage)).toHaveBeenCalledTimes(1);
  });
});

describe("HTTP 401 access-outcome classification (audit item 10)", () => {
  it("401 through the cascade folds to FAIL_SILENT_LOGIN_WALL, not a SUCCESS label", async () => {
    vi.mocked(fetchPage).mockResolvedValue(
      page({
        ok: false,
        status: 401,
        body: "<html><body>Authorization required to view this resource.</body></html>",
      }) as never,
    );
    const packet = await extractUrl(
      result({ snippet: "Members-only pricing page behind a login wall." }),
    );
    expect(packet.classification).toBe("FAIL_SILENT_LOGIN_WALL");
    // The SERP baseline is still carried honestly; nothing claims a direct read.
    expect(
      packet.passages.every((p) => !p.passageText.includes("Authorization required to view")),
    ).toBe(true);
  });
});
