/**
 * Brief §12 — TLS-unverified reads never masquerade as verified evidence.
 *
 * net.ts carries one deliberate retry path with certificate verification
 * disabled (broken cert chain) and marks the PageResponse with
 * insecureTls + a warn log. Until this fix the flag died at net.ts: the
 * extractor consumed the body as if the read were verified and even
 * cached it, so a later cache replay laundered the unverified read into
 * a plain SUCCESS row. The fix rides a TLS provenance note into the
 * passage (next to the redirect header) and refuses the cache write.
 *
 * Same mocked-network harness as extractor-provenance.test.ts.
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

const BODY =
  "<html><head><title>Official Price List</title></head><body><h1>Official Price List</h1>" +
  "<p>" +
  "Manufacturer price list with current model numbers and MSRP figures for the lineup. ".repeat(8) +
  "</p></body></html>";

beforeEach(() => {
  vi.mocked(getCachedPage).mockReturnValue(null);
  vi.mocked(putCachedPage).mockClear();
  vi.mocked(fetchPage).mockReset();
});

describe("TLS-unverified extraction evidence (brief §12)", () => {
  it("an insecureTls read carries a loud TLS provenance note and is never cached", async () => {
    vi.mocked(fetchPage).mockResolvedValue(
      page({ body: BODY, rawBytes: new TextEncoder().encode(BODY), insecureTls: true }) as never,
    );
    const packet = await extractUrl(result({}));
    // It still SUCCEEDS (the retry was a deliberate product decision)…
    expect(packet.classification).toBe("SUCCESS_DIRECT");
    const passage = packet.passages.at(-1)!;
    // …but the evidence never pretends the read was verified.
    expect(passage.passageText).toContain("TLS provenance");
    expect(passage.passageText).toContain("TLS-UNVERIFIED");
    expect(passage.passageText).toMatch(/never present it as a verified/i);
    // And the note-less cache row can never launder it later.
    expect(vi.mocked(putCachedPage)).not.toHaveBeenCalled();
  });

  it("control: a verified read gets NO note and keeps the cache write", async () => {
    vi.mocked(fetchPage).mockResolvedValue(
      page({ body: BODY, rawBytes: new TextEncoder().encode(BODY) }) as never,
    );
    const packet = await extractUrl(result({}));
    expect(packet.classification).toBe("SUCCESS_DIRECT");
    expect(packet.passages.at(-1)!.passageText).not.toContain("TLS provenance");
    expect(vi.mocked(putCachedPage)).toHaveBeenCalledTimes(1);
  });

  it("cross-site landing + TLS-unverified stack BOTH provenance headers", async () => {
    vi.mocked(fetchPage).mockResolvedValue(
      page({
        body: BODY,
        rawBytes: new TextEncoder().encode(BODY),
        resolvedUrl: "https://partner-retail.example/prices",
        insecureTls: true,
      }) as never,
    );
    const packet = await extractUrl(result({}));
    expect(packet.classification).toBe("SUCCESS_REDIRECTED");
    const passage = packet.passages.at(-1)!;
    expect(passage.passageText.startsWith("[Redirect provenance:")).toBe(true);
    expect(passage.passageText).toContain("TLS provenance");
    expect(vi.mocked(putCachedPage)).not.toHaveBeenCalled();
  });
});
