/**
 * AUDIT 2026-11-05 (brief item 14 / WS14) — a tool-level realtime request
 * could still use the non-live read policy.
 *
 * Audit repro (verbatim): "`web_search` with a URL-shaped query and
 * `freshness: realtime` calls `extractUrl` with `liveRequired=false` if the
 * session began without live mode." Cause (verbatim): "execWebSearchTool
 * parses freshness but routes URL reads through the unchanged session
 * policy; readOneUrl consumes that policy." Fix (verbatim): "Fix effective
 * freshness per operation, monotonically strengthened within the turn when
 * required. Apply it consistently to direct URLs, engine lookup, page
 * cache, render fallback and archive fallback."
 *
 * Laws pinned here (no brand/site/time-specific rules — pure policy
 * grammar):
 *  - the tool call's freshness is an OPERATION-level read policy: a
 *    realtime op's URL read must reach extractUrl's liveRequired arg,
 *    which gates the SQLite page cache (Tier 0, incl. cached jina/browser
 *    render tiers) AND the Wayback archive tier — a 5h-old cached body or
 *    an archived snapshot can never answer "the price right now";
 *  - strengthening is MONOTONIC within the turn: once a realtime op has
 *    required live reads, every later read in the session stays live,
 *    even a later ANY-freshness op — stale bytes never re-open mid-turn;
 *  - the mapping is EXACT (retrievalModeForFreshness): only "realtime"
 *    escalates; "day"/"week" are live_PREFERRED — a query-cache write-TTL
 *    law that must NOT flip the tool-layer page-cache binary; timeless
 *    reads keep page-cache reads allowed (positive control);
 *  - engine lookup already carries the operation's freshness per call
 *    (positive control — consistency leg #2 of the audit fix).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metasearch: vi.fn(),
  extractUrl: vi.fn(),
  applySegmentFilter: vi.fn(),
  isSafeUrlWithDns: vi.fn(),
}));

vi.mock("@/lib/web-search/metasearch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web-search/metasearch")>()),
  metasearch: mocks.metasearch,
}));
vi.mock("@/lib/web-search/extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web-search/extractor")>()),
  extractUrl: mocks.extractUrl,
}));
vi.mock("@/lib/web-search/segment-filter", () => ({
  applySegmentFilter: mocks.applySegmentFilter,
}));
vi.mock("@/lib/web-search/ssrf", () => ({
  isSafeUrlWithDns: mocks.isSafeUrlWithDns,
}));

import {
  makeWebToolSession,
  execWebSearchTool,
  execReadPageTool,
  type WebToolSession,
} from "@/lib/web-search/tools";

function packet(over: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/a",
    title: "Page Title",
    domain: "example.com",
    extraction: "jina",
    passages: [{ passageText: "hello world passage" }],
    ...over,
  } as any;
}

/** Session as the gate would create it for a NON-live turn (freshness
 *  "any" ⇒ liveRequired=false — the audit's starting condition). */
function freshSession(): WebToolSession {
  return makeWebToolSession("standard", 1, "the price right now", null, false);
}

/** The 4th positional extractUrl arg IS the liveRequired policy. */
function liveArgFor(url: string): unknown {
  const call = mocks.extractUrl.mock.calls.find((c: any[]) => c[0]?.url === url);
  return call?.[3];
}

beforeEach(() => {
  mocks.metasearch.mockReset();
  mocks.metasearch.mockResolvedValue([]);
  mocks.extractUrl.mockReset();
  mocks.extractUrl.mockImplementation(async (r: any) => packet({ url: r.url, domain: r.domain }));
  mocks.applySegmentFilter.mockReset();
  mocks.isSafeUrlWithDns.mockReset();
  mocks.isSafeUrlWithDns.mockResolvedValue(true);
});

describe("WS14 — operation freshness binds the read path", () => {
  it("a realtime web_search's url-shaped query is read LIVE, not cached", async () => {
    const s = freshSession();
    await execWebSearchTool(
      s,
      { queries: ["https://prices.example/live"], missing_claims: ["the price right now"], freshness: "realtime" },
      [],
    );
    // THE DEFECT: freshness was parsed but only fed the engine leg; the
    // URL read rode the session's non-live policy, so a stale page-cache
    // body (or an archived snapshot) could answer "right now".
    expect(
      liveArgFor("https://prices.example/live"),
      "the operation's realtime freshness must reach extractUrl so Tier-0 page cache and the Wayback tier stay off",
    ).toBe(true);
  });

  it("strengthening is monotonic: a later read_page in the SAME turn stays live", async () => {
    const s = freshSession();
    await execWebSearchTool(
      s,
      { queries: ["https://prices.example/live"], missing_claims: ["m"], freshness: "realtime" },
      [],
    );
    await execReadPageTool(s, { urls: ["https://prices.example/followup"] }, []);
    expect(
      liveArgFor("https://prices.example/followup"),
      "once the turn has required live reads, every later read inherits the strengthened policy",
    ).toBe(true);
  });

  it("never downgraded: a later ANY-freshness op cannot re-open the page cache", async () => {
    const s = freshSession();
    await execWebSearchTool(
      s,
      { queries: ["https://prices.example/live"], missing_claims: ["m"], freshness: "realtime" },
      [],
    );
    await execWebSearchTool(
      s,
      { queries: ["https://prices.example/again"], missing_claims: ["m"], freshness: "any" },
      [],
    );
    expect(
      liveArgFor("https://prices.example/again"),
      "monotonic within the turn — a softer later op must not downgrade back to cached bytes",
    ).toBe(true);
  });

  it("the strengthening binds the TURN, not one call: a realtime keyword search forces later reads live", async () => {
    const s = freshSession();
    // No url-shaped query in the realtime op — this op performs NO read.
    await execWebSearchTool(
      s,
      { queries: ["arborworks live price today"], missing_claims: ["m"], freshness: "realtime" },
      [],
    );
    await execReadPageTool(s, { urls: ["https://arborworks.invalid/prices"] }, []);
    expect(
      liveArgFor("https://arborworks.invalid/prices"),
      "the turn has declared realtime facts; the follow-up read of the price page must be live",
    ).toBe(true);
  });
});

describe("WS14 — controls: the escalation is exact, not blanket", () => {
  it("control: the engine lookup already carries the operation's freshness", async () => {
    const s = freshSession();
    await execWebSearchTool(
      s,
      { queries: ["arborworks live price"], missing_claims: ["m"], freshness: "realtime" },
      [],
    );
    expect(mocks.metasearch).toHaveBeenCalledTimes(1);
    // Consistency leg (audit fix wording "engine lookup") — already true,
    // pinned so a refactor cannot silently drop it.
    expect(mocks.metasearch.mock.calls[0][0][0].freshness).toBe("realtime");
  });

  it("control: timeless and day/week ops never flip the page-cache binary", async () => {
    const s1 = freshSession();
    await execWebSearchTool(
      s1,
      { queries: ["https://docs.example/spec"], missing_claims: ["m"] },
      [],
    );
    expect(liveArgFor("https://docs.example/spec")).toBe(false);
    const s2 = freshSession();
    await execWebSearchTool(
      s2,
      { queries: ["https://news.example/story"], missing_claims: ["m"], freshness: "week" },
      [],
    );
    expect(
      liveArgFor("https://news.example/story"),
      "day/week is live_PREFERRED — a query-cache write-TTL law; it must not escalate the tool page-cache binary",
    ).toBe(false);
  });
});
