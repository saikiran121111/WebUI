/**
 * AUDIT 2026-11-04 (universal research-depth brief) — when retrieved pages
 * confirm the TOPIC but not the REQUESTED fact, and a real linked route to the
 * answer exists in retrieved content, the pipeline must follow that route at
 * STANDARD and DEEP depth alike (one requirement-driven research flow, depth
 * = budget, not a quality toggle).
 */
import { it, expect, vi, beforeEach } from "vitest";

const f = vi.hoisted(() => {
  const overview =
    "ArborWorks foundation models support overview. See the [supported model catalog](https://docs.arborworks.example/reference/model-catalog) for the actual supported identifiers. ";
  const domains = ["docs.arborworks.example", "industry.example.org", "press.example.net"];
  const rows = domains.map((domain, i) => ({
    url: "https://" + domain + "/overview-" + i,
    canonical: "https://" + domain + "/overview-" + i,
    title: "ArborWorks models support",
    snippet: overview,
    domain,
    engine: "audit",
    rrf: 1,
    engines: ["audit"],
    engineRanks: { audit: 1 },
    origin: "search",
  }));
  return { depth: "standard", reads: [] as string[], rows, overview };
});

vi.mock("@/lib/web-search/search-gate", () => ({
  runSearchGate: async () => ({
    source: "rules",
    gateMs: 0,
    decision: {
      search_required: true,
      reason: "controlled lookup",
      depth: f.depth,
      freshness: "any",
      queries: [{ query: "ArborWorks foundation models support", intent: "docs" }],
    },
  }),
}));

vi.mock("@/lib/web-search/cache", () => ({
  getCachedQuery: () => null,
  putCachedQuery: () => {},
}));

vi.mock("@/lib/web-search/query-planner", async (o) => ({
  ...(await o<any>()),
  planQueries: () => [{ query: "ArborWorks foundation models support", intent: "docs", origin: "semantic" }],
}));

vi.mock("@/lib/web-search/metasearch", async (o) => ({
  ...(await o<any>()),
  metasearch: async () => f.rows,
  metasearchWithFreshnessRecovery: async () => ({ results: f.rows, freshnessRecoveryUsed: false }),
  countLexicallyRelevant: () => 100,
}));

vi.mock("@/lib/web-search/extractor", () => {
  const packet = (r: any) => {
    f.reads.push(r.url);
    return {
      sourceId: "",
      url: r.url,
      domain: r.domain,
      title: r.title,
      extraction: "direct",
      classification: "SUCCESS_DIRECT",
      passages: [
        {
          sourceId: "",
          url: r.url,
          domain: r.domain,
          title: r.title,
          passageText: r.url.endsWith("model-catalog")
            ? "ArborWorks foundation models support: Boreal-X17 and Cedar-Y23."
            : f.overview.repeat(6),
          bm25Score: 0,
        },
      ],
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

beforeEach(() => {
  f.reads = [];
});

for (const depth of ["standard", "deep"]) {
  it(depth + ": follows a provided catalog route when overview pages do not answer the model-list question", async () => {
    f.depth = depth;
    const b = await runWebResearch({
      userPrompt: "Which foundation models does ArborWorks support?",
      scope: { intent: "site_info", targets: [], excludedPhrases: [], authorizedHosts: [] },
    } as any);
    expect(b).not.toBeNull();
    expect(f.reads.length).toBeGreaterThan(0);
    console.log(
      "PIPELINE_DEPTH_TRACE",
      JSON.stringify({
        depth,
        reads: f.reads,
        coverage: b!.coverage,
        sufficiency: b!.sufficiency,
        gapSearchFired: b!.gapSearchFired,
        demandWaveFired: b!.demandWaveFired,
      }),
    );
    expect(f.reads).toContain("https://docs.arborworks.example/reference/model-catalog");
  });
}
