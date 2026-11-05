/**
 * AUDIT 2026-11-05 (brief item 10 / WS10) — ONE admitted packet registry
 * for ALL waves.
 *
 * Audit repro (verbatim): "An absolute catalog link is fetched;
 * `topPassages` contains its actual model answer, but those source IDs are
 * absent from returned `bundle.packets`." Cause: "secondHopPackets
 * contributes to reranking, while the returned bundle retains the initial
 * packets. Both chat citation serialization and internal bridge
 * serialization enumerate `bundle.packets`. Fix a single admitted packet
 * registry for all waves; every emitted passage/source ID must have its
 * packet, URL, extraction status and metadata in the returned registry."
 *
 * The defect chain this fixture pins:
 *  - every consumer (chat citation map + maxSid continuation, internal
 *    bridge citations frame the Rust transport relays verbatim,
 *    /api/search + /api/search-more webCitations, evidenceBlock source
 *    lookups, research-journal sources for WS05 rehydration) enumerates
 *    bundle.packets — so a packet admitted by a recovery wave is cited by
 *    the evidence block yet has NO citation entry, no journal provenance
 *    and no URL/status/metadata anywhere downstream;
 *  - the tool-session citation seed continues "the pipeline's [S#]
 *    numbering" from that map, so a missing max S-id also invites minted
 *    tool IDs to collide with cited-but-unregistered source IDs.
 *
 * Controls (assertions NOT weakened): an initial-wave-only run returns the
 * identical registry bytes; no duplicate source IDs ever enter the
 * registry; the registry covers every emitted topPassages sourceId for
 * each wave type (gap hop, route-follow hop, deep demand wave); journal
 * sources keep the WS05 provenance contract. Fictional ArborWorks
 * fixtures only.
 */
import { it, expect, vi, beforeEach } from "vitest";

const PROMPT = "Which foundation models does ArborWorks support?";

const f = vi.hoisted(() => {
  const row = (path: string) => {
    const url = "https://docs.arborworks.example.com" + path;
    return {
      url,
      canonical: url,
      title: "ArborWorks page",
      snippet: "ArborWorks page.",
      domain: "docs.arborworks.example.com",
      engine: "audit",
      rrf: 1,
      engines: ["audit"],
      engineRanks: { audit: 1 },
      origin: "search",
    };
  };
  return {
    depth: "standard",
    metaQueue: [] as any[][],
    defaultRows: [] as any[],
    initialRows: [] as any[],
    overviewText: "",
    reads: [] as string[],
    row,
    plainOverview:
      "ArborWorks foundation models overview. The company documents its platform, hardware requirements and support pages. ",
    CATALOG: "https://docs.arborworks.example.com/reference/foundation-models",
  };
});

const ANSWER_TEXT =
  "The vendor catalog page lists support tiers for the ArborWorks platform. The complete supported foundation models list for ArborWorks is Boreal-X17 and Cedar-Y23.";

vi.mock("@/lib/web-search/search-gate", () => ({
  runSearchGate: async () => ({
    source: "rules",
    gateMs: 0,
    decision: {
      search_required: true,
      reason: "controlled lookup",
      depth: f.depth,
      freshness: "any",
      queries: [{ query: PROMPT, intent: "general" }],
    },
  }),
}));

vi.mock("@/lib/web-search/cache", () => ({
  getCachedQuery: () => null,
  putCachedQuery: () => {},
}));

vi.mock("@/lib/web-search/query-planner", async (o) => ({
  ...(await o<any>()),
  planQueries: () => [{ query: PROMPT, intent: "general", origin: "semantic" }],
}));

vi.mock("@/lib/web-search/metasearch", async (o) => ({
  ...(await o<any>()),
  metasearch: async () => {
    if (f.metaQueue.length > 0) return f.metaQueue.shift()!;
    return f.defaultRows;
  },
  metasearchWithFreshnessRecovery: async () => ({
    results: f.initialRows,
    freshnessRecoveryUsed: false,
  }),
  countLexicallyRelevant: () => 100,
}));

vi.mock("@/lib/web-search/extractor", () => {
  const bodyFor = (url: string): string =>
    url.includes("/answer-catalog") || url.includes("/reference/foundation-models")
      ? ANSWER_TEXT
      : f.overviewText;
  const packet = (r: any) => {
    f.reads.push(r.url);
    return {
      sourceId: "",
      url: r.url,
      domain: r.domain,
      title: r.title,
      extraction: "direct",
      classification: "SUCCESS_DIRECT",
      passages: [{ sourceId: "", url: r.url, domain: r.domain, title: r.title, passageText: bodyFor(r.url), bm25Score: 0 }],
    };
  };
  return {
    extractUrl: async (r: any) => packet(r),
    extractAll: async (rs: any[]) => rs.map(packet),
    renumberPackets: (ps: any[], n = 1) => {
      for (const p of ps) {
        p.sourceId = "S" + n++;
        for (const x of p.passages) x.sourceId = p.sourceId;
      }
    },
    nextSourceIndex: (ps: any[]) => ps.length + 1,
    baselinePacketsFor: () => [],
  };
});

import { runWebResearch } from "@/lib/web-search/pipeline";
import { journalTurnFromBundle } from "@/lib/persistence/research-journal";

const run = () => runWebResearch({ userPrompt: PROMPT, scope: undefined } as any);

/** Registry completeness invariant: EVERY emitted passage sourceId must
 *  have its packet (URL, extraction status, metadata) in bundle.packets. */
const registryGaps = (b: any): string[] => {
  const registered = new Set(b.packets.map((p: any) => p.sourceId));
  return [...new Set<string>(b.topPassages.map((p: any) => p.sourceId))].filter((sid) => !registered.has(sid));
};
const noDuplicateSourceIds = (b: any) =>
  new Set(b.packets.map((p: any) => p.sourceId)).size === b.packets.length;

beforeEach(() => {
  f.depth = "standard";
  f.metaQueue = [];
  f.defaultRows = [];
  f.initialRows = [];
  f.reads = [];
  f.overviewText = f.plainOverview;
});

/* ── 1. the audit repro: absolute catalog link fetched via the route hop ── */

it("a route-follow hop's packet is in the returned registry with URL, extraction status and metadata", async () => {
  f.initialRows = [f.row("/overview-0")];
  f.metaQueue = [[]]; // gap SERP empty → the route-follow hop is the acquisition wave
  f.overviewText =
    f.plainOverview +
    "See the [foundation models catalog](" + f.CATALOG + ") for the vendor list.";

  const b = await run();
  expect(b).not.toBeNull();

  // The scenario really runs the hop: the absolute catalog link was fetched
  // and topPassages DOES contain the model answer (the audit repro).
  expect(f.reads).toContain(f.CATALOG);
  expect(b!.topPassages.some((p: any) => p.passageText.includes("Boreal-X17"))).toBe(true);

  // THE DEFECT: those source IDs are absent from returned bundle.packets.
  expect(registryGaps(b), "every emitted sourceId must have its packet registered").toEqual([]);

  // The hop packet itself, with the full citation metadata every consumer
  // (chat citation map, bridge citations frame, journal) enumerates.
  const hop = b!.packets.find((p: any) => p.url === f.CATALOG);
  const hopMeta = hop as { title: string; domain: string; extraction: string } | undefined;
  expect(hopMeta, "the fetched catalog's packet must be in the admitted registry").toBeTruthy();
  // Route-follow packets carry the ANCHOR as their title (the pipeline
  // builds the route row from the in-content link) — real metadata, not a
  // placeholder: the citation pill gets the text the reader followed.
  expect(hopMeta!.title).toBe("foundation models catalog");
  expect(hopMeta!.domain).toBe("docs.arborworks.example.com");
  expect(hopMeta!.extraction).toBe("direct");
  expect(noDuplicateSourceIds(b)).toBe(true);
});

/* ── 2. the gap hop wave ─────────────────────────────────────────────────── */

it("a gap-hop packet is in the returned registry (not just in reranking)", async () => {
  f.initialRows = [f.row("/overview-0")];
  f.metaQueue = [[f.row("/answer-catalog")]];

  const b = await run();
  expect(b).not.toBeNull();
  expect(b!.gapSearchFired).toBe(true);
  expect(b!.topPassages.some((p: any) => p.passageText.includes("Boreal-X17"))).toBe(true);

  // THE DEFECT: secondHopPackets contributes to reranking while the
  // returned bundle retains only the initial packets.
  expect(registryGaps(b)).toEqual([]);
  expect(b!.packets.some((p: any) => p.url.includes("/answer-catalog"))).toBe(true);
  expect(noDuplicateSourceIds(b)).toBe(true);
});

/* ── 3. the deep demand wave ─────────────────────────────────────────────── */

it("a deep demand-wave packet is in the returned registry alongside every other wave's packets", async () => {
  f.depth = "deep";
  f.initialRows = [f.row("/overview-0")];
  f.metaQueue = [[f.row("/overview-1")]]; // gap wave fires (topic, no answer)
  f.defaultRows = [f.row("/answer-catalog")]; // demand wave's queries land the answer

  const b = await run();
  expect(b).not.toBeNull();
  expect(b!.gapSearchFired).toBe(true);
  expect(b!.demandWaveFired).toBe(true);
  expect(b!.topPassages.some((p: any) => p.passageText.includes("Boreal-X17"))).toBe(true);

  // THE DEFECT: ALL THREE wave pools (gap + demand) were invisible to the
  // returned registry.
  expect(registryGaps(b)).toEqual([]);
  expect(b!.packets.some((p: any) => p.url.includes("/answer-catalog"))).toBe(true);
  expect(b!.packets.some((p: any) => p.url.includes("/overview-1"))).toBe(true);
  expect(noDuplicateSourceIds(b)).toBe(true);
});

/* ── 4. controls (byte-stability, no wave fired) ─────────────────────────── */

it("control: an initial-wave-only run returns the identical registry bytes", async () => {
  f.initialRows = [f.row("/answer-catalog-1"), f.row("/answer-catalog-2")];

  const b = await run();
  expect(b).not.toBeNull();
  expect(b!.gapSearchFired).toBe(false);
  expect(b!.demandWaveFired).toBe(false);

  // The initial wave's registry is untouched: same packets, same order,
  // same S# numbering as before this fix.
  expect(b!.packets.map((p: any) => p.sourceId)).toEqual(["S1", "S2"]);
  expect(b!.packets.map((p: any) => p.url)).toEqual([
    "https://docs.arborworks.example.com/answer-catalog-1",
    "https://docs.arborworks.example.com/answer-catalog-2",
  ]);
  expect(registryGaps(b)).toEqual([]);
  expect(noDuplicateSourceIds(b)).toBe(true);
});

it("control: the research journal records every registered source (WS05 rehydration contract)", async () => {
  f.initialRows = [f.row("/overview-0")];
  f.metaQueue = [[]];
  f.overviewText =
    f.plainOverview +
    "See the [foundation models catalog](" + f.CATALOG + ") for the vendor list.";

  const b = await run();
  expect(b).not.toBeNull();
  expect(registryGaps(b)).toEqual([]);

  // journalTurnFromBundle maps bundle.packets → sources: the WS05 journal
  // round-trip must now carry the hop source's provenance too, so a
  // follow-up turn rehydrates the page that actually answered.
  const turn = journalTurnFromBundle(b as any);
  expect(turn.sources.map((s: any) => s.url)).toContain(f.CATALOG);
  expect(turn.sources.some((s: any) => s.excerpt.includes("Boreal-X17"))).toBe(true);
});
