/**
 * BRIEF §6 — EXACT-URL PRESERVATION END TO END (2026-11-04).
 *
 * Pins the §6 url/canonical split as one continuous chain:
 *   engine result → reciprocalRankFuse (dedupe by canonical, KEEP the raw)
 *   → extractUrl (FETCHES the raw; cache keys + packets carry the raw)
 *   → browser tier (navigates the raw)
 *   → baselinePacketsFor (emits the raw; skips by canonical).
 *
 * The audit defect this file exists for: the fuse used to overwrite
 * `url: norm`, silently rewriting every downstream request (case-folded
 * paths, stripped `ref`, collapsed fragments) while the emit comment
 * claimed the raw survived. Normalization stays a COMPARISON KEY only.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { extractUrl, baselinePacketsFor, resetExtractionHealth } from "@/lib/web-search/extractor";
import { reciprocalRankFuse, normalizeUrl } from "@/lib/web-search/metasearch";
import { getCachedPage, putCachedPage } from "@/lib/web-search/cache";
import { fetchPage } from "@/lib/web-search/net";
import { extractPageInOnePass } from "@/lib/web-search/agentBrowser";
import type { RawSearchResult, RankedResult } from "@/lib/web-search/types";

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

/** Mixed case + trailing slash + `ref` (a stripped KEY on the comparison
 *  side) + signed `sig` + SPA-route hash — every §6 hazard in one URL. */
const RAW = "https://Shop.Example.com/WidgET/?ref=aff&sig=xyz#/products/42";
const CANON = "https://shop.example.com/WidgET?sig=xyz#/products/42";

const raw = (over: Partial<RawSearchResult> & { url: string }): RawSearchResult => ({
  title: "Widget Listing",
  snippet: "Engine-indexed snippet text.",
  engine: "test",
  rank: 1,
  ...over,
});

const result = (over: Partial<RankedResult> & { url?: string; canonical?: string }): RankedResult =>
  ({
    url: RAW,
    canonical: CANON,
    title: "WidegET Product Page",
    snippet: "Exact widget listing with price.",
    domain: "shop.example.com",
    publishedDate: "",
    engine: "test",
    rrf: 1,
    engines: ["test"],
    engineRanks: {},
    origin: "search",
    ...over,
  }) as unknown as RankedResult;

const page = (over: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  contentType: "text/html; charset=utf-8",
  resolvedUrl: "",
  ...over,
});

const longBody = () =>
  "<html><head><title>WidegET</title></head><body><h1>WidegET Store</h1>" +
  "<p>" + "Exact product page with current stock and shipping details. ".repeat(8) +
  "</p></body></html>";

beforeEach(() => {
  vi.mocked(getCachedPage).mockReturnValue(null);
  vi.mocked(putCachedPage).mockClear();
  vi.mocked(fetchPage).mockReset();
  vi.mocked(extractPageInOnePass).mockClear();
  resetExtractionHealth();
});

describe("fuse: dedupe by canonical, KEEP the engine's raw URL (§6)", () => {
  it("same page under two param orderings → one result carrying the FIRST raw verbatim", () => {
    const first = "https://Shop.Example.com/WidgET/?ref=aff&sig=abc123#/products/42";
    const second = "https://shop.example.com/WidgET?sig=abc123&ref=aff#/products/42";
    const out = reciprocalRankFuse([
      raw({ url: first, engine: "ddg" }),
      raw({ url: second, engine: "brave", rank: 2 }),
    ]);
    expect(out).toHaveLength(1);
    // The audit defect: this used to be the normalized key.
    expect(out[0].url).toBe(first);
    expect(out[0].canonical).toBe("https://shop.example.com/WidgET?sig=abc123#/products/42");
    expect(out[0].domain).toBe("shop.example.com");
  });

  it("AMP/mobile shapes dedupe but the first-seen raw shape is what gets fetched", () => {
    const mobile = "https://m.shop.example.com/WidgET?utm_source=newsletter";
    const amp = "https://shop.example.com/amp/WidgET";
    const out = reciprocalRankFuse([
      raw({ url: mobile, engine: "ddg" }),
      raw({ url: amp, engine: "brave", rank: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].canonical).toBe("https://shop.example.com/WidgET");
    expect(out[0].url).toBe(mobile); // never rewritten onto the desktop form
  });

  it("two SPA hash-route pages on one host stay DISTINCT", () => {
    const out = reciprocalRankFuse([
      raw({ url: "https://app.example.com/#!/products/1", engine: "ddg" }),
      raw({ url: "https://app.example.com/#!/products/2", engine: "brave", rank: 2 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.url)).toEqual([
      "https://app.example.com/#!/products/1",
      "https://app.example.com/#!/products/2",
    ]);
  });

  it("plain in-page anchors still collapse onto the same page", () => {
    const out = reciprocalRankFuse([
      raw({ url: "https://docs.example.com/guide#intro", engine: "ddg" }),
      raw({ url: "https://docs.example.com/guide#setup", engine: "brave", rank: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://docs.example.com/guide#intro");
  });

  it("Unicode/IDNA: the raw survives verbatim; the KEY punycodes", () => {
    const unicode = "https://münchen.example.de/brötchen?preis=%E2%82%AC5";
    const out = reciprocalRankFuse([raw({ url: unicode, engine: "ddg" })]);
    expect(out[0].url).toBe(unicode);
    expect(new URL(out[0].canonical).hostname).toBe("xn--mnchen-3ya.example.de");
    expect(out[0].canonical).toContain("/br%C3%B6tchen");
    expect(out[0].canonical).toContain("preis=%E2%82%AC5");
  });
});

describe("extractUrl cascade: the ACTUAL requested URL is the raw (§6)", () => {
  it("direct hit: fetch arg, cache get/put key, packet and passages all carry RAW", async () => {
    const body = longBody();
    vi.mocked(fetchPage).mockResolvedValue(
      page({ body, rawBytes: new TextEncoder().encode(body) }) as never,
    );

    const packet = await extractUrl(result({}));

    expect(vi.mocked(fetchPage).mock.calls[0][0]).toBe(RAW);
    expect(vi.mocked(getCachedPage).mock.calls[0][0]).toBe(RAW);
    expect(vi.mocked(putCachedPage).mock.calls[0][0]).toBe(RAW);
    expect(packet.classification).toBe("SUCCESS_DIRECT");
    expect(packet.url).toBe(RAW);
    expect(packet.passages[0].url).toBe(RAW); // SERP baseline citation
    expect(packet.passages.at(-1)!.url).toBe(RAW); // extracted-body passage
    expect(vi.mocked(extractPageInOnePass)).not.toHaveBeenCalled();
  });

  it("403-blocked page: the browser tier NAVIGATES the raw, not the key", async () => {
    vi.mocked(fetchPage).mockResolvedValue(
      page({ ok: false, status: 403, body: "<html><body>Access denied.</body></html>" }) as never,
    );

    const packet = await extractUrl(result({}));

    expect(vi.mocked(extractPageInOnePass).mock.calls[0][0]).toBe(RAW);
    expect(packet.url).toBe(RAW);
  });
});

describe("baselinePacketsFor: skip by canonical, emit the raw (§6)", () => {
  it("an already-extracted raw URL is recognized via its canonical key", () => {
    const ranked = [result({})];
    // The pipeline stores packet.url (raw) — normalizeUrl bridges to the key.
    expect(baselinePacketsFor(ranked, new Set([normalizeUrl(RAW)]))).toHaveLength(0);
  });

  it("an unextracted result emits its RAW url on the snippet packet", () => {
    const out = baselinePacketsFor([result({})], new Set());
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe(RAW);
    expect(out[0].passages[0].url).toBe(RAW);
  });
});
