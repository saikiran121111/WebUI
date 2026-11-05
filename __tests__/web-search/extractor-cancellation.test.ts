/**
 * AUDIT 2026-11-05 (brief item 16 / WS16) — cancellation must propagate
 * through the extractor cascade, the render tier and the queued work in
 * extractAll, and the provider fan-out in metasearch.
 *
 * Fix wording (verbatim): "Fix cancellation propagation and settlement
 * through direct reads, provider calls, render acquisition and queued
 * work. Do not leave abandoned work occupying inference/browser/network
 * capacity or writing late state."
 *
 * The REAL extractor/metasearch run with net + agentBrowser mocked:
 *  - net spies pin "no network work after cancellation" (direct reads,
 *    jina/wayback tiers, provider fan-out inside slug triangulation);
 *  - the agentBrowser spy pins "render acquisition never starts after
 *    cancellation" (extractPageInOnePass is the one-pass browser render
 *    path — nothing may be dispatched to the user's browser bridge);
 *  - positive controls prove the cascade ACTUALLY runs when the signal is
 *    live (net + browser spies are hit), so the abort pins are never
 *    vacuous.
 *
 * Pins (universal cancellation law — no site/brand rules):
 *  - extractUrl handed an aborted signal performs ZERO net/browser work
 *    and settles as a network-failure classification;
 *  - extractAll with an aborted signal starts no queued page tasks;
 *  - metasearch (provider fan-out) with an aborted signal fires no
 *    engine calls and returns empty, including the freshness-recovery
 *    second leg.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  fetchUrl: vi.fn(),
  fetchWithLinkPreviewBots: vi.fn(),
  extractPageInOnePass: vi.fn(),
}));

vi.mock("@/lib/web-search/net", async (o) => ({
  ...(await o<typeof import("@/lib/web-search/net")>()),
  fetchPage: f.fetchPage,
  fetchUrl: f.fetchUrl,
  fetchWithLinkPreviewBots: f.fetchWithLinkPreviewBots,
}));
vi.mock("@/lib/web-search/agentBrowser", async (o) => ({
  ...(await o<typeof import("@/lib/web-search/agentBrowser")>()),
  extractPageInOnePass: f.extractPageInOnePass,
}));

import { extractAll, extractUrl } from "@/lib/web-search/extractor";
import { metasearch, metasearchWithFreshnessRecovery } from "@/lib/web-search/metasearch";

function row(n: number) {
  const url = `https://queued.example/p${n}`;
  return {
    url,
    canonical: url,
    title: "queued page " + n,
    snippet: "snippet for queued page " + n,
    domain: "queued.example",
    engine: "fixture",
    rrf: 1,
    engines: ["fixture"],
    engineRanks: { fixture: 1 },
    origin: "search",
  } as any;
}

beforeEach(() => {
  f.fetchPage.mockReset();
  f.fetchPage.mockResolvedValue(null);
  f.fetchUrl.mockReset();
  f.fetchUrl.mockResolvedValue(null);
  f.fetchWithLinkPreviewBots.mockReset();
  f.fetchWithLinkPreviewBots.mockResolvedValue(null);
  f.extractPageInOnePass.mockReset();
  f.extractPageInOnePass.mockResolvedValue({
    ok: false,
    status: 0,
    error: "fixture: render disabled",
    bodyText: "",
    finalUrl: "",
    title: "",
    jsonLd: [],
    meta: {},
    windowState: {},
    ariaSnapshot: "",
  } as any);
});

const abortedSignal = () => {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
};
const liveSignal = () => new AbortController().signal;

describe("WS16 — the extractor cascade honors cancellation", () => {
  it("extractUrl with an aborted signal does zero network or render work", async () => {
    const pk = await extractUrl(row(1), undefined, 0, false, abortedSignal());
    // THE DEFECT: extractUrl's signature has no signal at all — an
    // aborted turn still opens direct reads, jina, wayback and the
    // browser render tier.
    expect(
      f.fetchPage,
      "direct/jina reads must not start once cancelled (no abandoned work occupying network capacity)",
    ).not.toHaveBeenCalled();
    expect(f.fetchUrl, "wayback/archive reads must not start once cancelled").not.toHaveBeenCalled();
    expect(
      f.extractPageInOnePass,
      "render acquisition must never be dispatched after cancellation",
    ).not.toHaveBeenCalled();
    expect(pk.classification).toBe("FAIL_NETWORK_OR_CRASH");
  });

  it("control: extractUrl with a LIVE signal still runs the cascade (abort pins are not vacuous)", async () => {
    const pk = await extractUrl(row(2), undefined, 0, false, liveSignal());
    // The mocked net returning null drives the cascade through direct →
    // render → jina → wayback → triangulation; every leg must have been
    // attempted, proving the spies intercept the REAL cascade.
    expect(f.fetchPage.mock.calls.length, "direct + jina + triangulation reads must run when not cancelled").toBeGreaterThan(0);
    expect(
      f.extractPageInOnePass.mock.calls.length,
      "the render tier must still launch for a live read",
    ).toBeGreaterThan(0);
    expect(typeof pk.classification).toBe("string");
  }, 30_000);

  it("extractAll with an aborted signal starts no queued page work", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    const out = await extractAll(rows, 10, undefined, undefined, 0, undefined, false, abortedSignal());
    // THE DEFECT: extractAll accepts no signal — the whole 10-page wave
    // launches even for a cancelled turn (queued work law).
    expect(out, "a cancelled wave returns nothing").toEqual([]);
    expect(
      f.fetchPage,
      "no queued page task may start after cancellation",
    ).not.toHaveBeenCalled();
  });

  it("control: extractAll with a LIVE signal still starts page tasks", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i + 1));
    const out = await extractAll(rows, 5, undefined, undefined, 0, undefined, false, liveSignal());
    expect(f.fetchPage.mock.calls.length, "wave pages must be read when not cancelled").toBeGreaterThan(0);
    expect(out.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("WS16 — the provider fan-out honors cancellation", () => {
  it("metasearch with an aborted signal fires no engine work and returns empty", async () => {
    const out = await metasearch(
      [{ query: "queued.example pages", intent: "general", freshness: "any" } as any],
      5,
      abortedSignal(),
    );
    // THE DEFECT: metasearch has no signal — engine dispatch runs for a
    // cancelled turn.
    expect(out).toEqual([]);
    expect(
      f.fetchPage.mock.calls.length + f.fetchUrl.mock.calls.length,
      "no provider/engine request may go out after cancellation",
    ).toBe(0);
  });

  it("freshness recovery never re-opens provider work after a cancelled first pass", async () => {
    const out = await metasearchWithFreshnessRecovery(
      [{ query: "queued.example latest news", intent: "general", freshness: "week" } as any],
      5,
      abortedSignal(),
    );
    expect(out.results).toEqual([]);
    expect(
      f.fetchPage.mock.calls.length + f.fetchUrl.mock.calls.length,
      "the recovery second leg is queued work too — it must never fire once cancelled",
    ).toBe(0);
  });

  it("control: metasearch with a LIVE signal still dispatches engines", async () => {
    const out = await metasearch(
      [{ query: "queued.example pages", intent: "general", freshness: "any" } as any],
      5,
      liveSignal(),
    );
    expect(Array.isArray(out)).toBe(true);
    expect(
      f.fetchPage.mock.calls.length + f.fetchUrl.mock.calls.length,
      "live lookups must still fan out to engines",
    ).toBeGreaterThan(0);
  }, 60_000);
});
