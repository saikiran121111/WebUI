/**
 * AUDIT 2026-11-05 (brief item 7 / WS07) — "Fix ONE final-origin
 * packet-admission function for EVERY acquisition wave before reranking,
 * caching, citation creation or grounding. Apply user blocks/allows and
 * mandatory source identity consistently. Distinguish primary-site facts
 * from permitted discovery/corroboration."
 *
 * Audit repro (verbatim): "An allowed target redirects during the gap
 * wave; outside-domain content reaches topPassages despite the named-site
 * scope. The initial-wave and model-tool redirect controls pass."
 *
 * The initial wave rechecks final origins with applyScopeToPackets
 * (pipeline §7, pre-first-rerank); the GAP hop, the ROUTE-FOLLOW hop and
 * the DEEP DEMAND wave lawed only the SERP — a fetch crossing a
 * registrable boundary then laundered off-site content past the named-site
 * wall while the citation kept the on-scope identity.
 *
 * Positive controls (assertions strengthened, never weakened):
 *  - the UNSCOPED run of each identical scenario KEEPS the mirror content
 *    (the admission is a no-op with no armed boundary — the waves are not
 *    being disabled, only bounded);
 *  - in-scope wave evidence still flows (the catalog route still answers,
 *    the in-scope gap row still merges);
 *  - a wave's FAIL packet survives the boundary (an auth wall behind a
 *    redirect is an honest access state, not off-site content).
 * Fictional vendor (ArborWorks) and model IDs are test data only.
 */
import { it, expect, vi, beforeEach } from "vitest";

const PROMPT = "Which foundation models does ArborWorks support?";

const f = vi.hoisted(() => {
  const row = (path: string) => {
    const url = "https://docs.arborworks.example.com" + path;
    return {
      url,
      canonical: url,
      title: "ArborWorks foundation models",
      snippet: "ArborWorks foundation models overview page.",
      domain: "docs.arborworks.example.com",
      engine: "audit",
      rrf: 1,
      engines: ["audit"],
      engineRanks: { audit: 1 },
      origin: "search",
    };
  };
  const plainOverview =
    "ArborWorks foundation models overview. The company documents its platform, hardware requirements and support pages. ";
  return {
    depth: "standard",
    metaCall: 0,
    metaQueue: [] as any[][],
    defaultRows: [] as any[],
    initialRows: [] as any[],
    overviewText: plainOverview,
    reads: [] as string[],
    row,
    plainOverview,
    // (literals inlined: the vi.hoisted factory runs before module consts)
    scopedScope: {
      intent: "site_info",
      targets: [
        {
          phrase: "arborworks.example.com",
          state: "resolved",
          host: "arborworks.example.com",
          url: "https://arborworks.example.com/",
          candidates: [],
          provenance: "explicit_domain",
        },
      ],
      excludedPhrases: [],
      authorizedHosts: [],
    },
  };
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
    f.metaCall += 1;
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
  // Every row here is ON-scope at the SERP level; these scripted packets
  // model what the fetch does AFTER the SERP law passes: the final origin
  // crosses a registrable boundary (redirect), and the packet still
  // carries the on-scope citation identity.
  const REDIRECTS: Record<
    string,
    { url: string; domain: string; text: string; cls: string }
  > = {
    "/redirect-mirror": {
      url: "https://media.counterfeit-host.example.net/redirect-mirror",
      domain: "counterfeit-host.example.net",
      text: "ArborWorks foundation models support: Zephyr-Q91. Mirrored copy of the vendor catalog.",
      cls: "SUCCESS_DIRECT",
    },
    "/redirect-wall": {
      url: "https://login.blocked-proxy.example.com/redirect-wall",
      domain: "blocked-proxy.example.com",
      text: "ArborWorks foundation models sign-in wall: OFFSITE-WALL-MARKER. Register on the vendor mirror to read the models page.",
      cls: "FAIL_SILENT_LOGIN_WALL",
    },
    "/redirect-deep": {
      url: "https://press.rewrite-echo.example.org/redirect-deep",
      domain: "rewrite-echo.example.org",
      text: "ArborWorks foundation models list: Quartz-V88. Off-site press republication of the vendor models page.",
      cls: "SUCCESS_DIRECT",
    },
    "/redirect-wave": {
      url: "https://cdn.offsite-demand.example.net/redirect-wave",
      domain: "offsite-demand.example.net",
      text: "Foundation models supported by ArborWorks: Iridium-W77. Off-site demand-wave mirror of the vendor page.",
      cls: "SUCCESS_DIRECT",
    },
  };
  const packet = (r: any) => {
    f.reads.push(r.url);
    const red = Object.entries(REDIRECTS).find(([path]) => r.url.includes(path));
    const finalUrl = red ? red[1].url : r.url;
    const domain = red ? red[1].domain : r.domain;
    const classification = red ? red[1].cls : "SUCCESS_DIRECT";
    const passageText = r.url.endsWith("model-catalog")
      ? "ArborWorks foundation models support: Boreal-X17 and Cedar-Y23."
      : red
        ? red[1].text
        : f.overviewText.repeat(4);
    return {
      sourceId: "",
      url: finalUrl,
      domain,
      title: r.title,
      extraction: red ? "direct" : "direct",
      classification,
      passages: [{ sourceId: "", url: finalUrl, domain, title: r.title, passageText, bm25Score: 0 }],
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

const scopedRun = () =>
  runWebResearch({ userPrompt: PROMPT, scope: f.scopedScope } as any);
const unscopedRun = () =>
  runWebResearch({ userPrompt: PROMPT, scope: undefined } as any);

const hasHost = (b: any, host: string) =>
  b!.topPassages.some((p: any) => p.url.includes(host));
const hasText = (b: any, text: string) =>
  b!.topPassages.some((p: any) => p.passageText.includes(text));

beforeEach(() => {
  f.depth = "standard";
  f.metaCall = 0;
  f.metaQueue = [];
  f.defaultRows = [];
  f.initialRows = [];
  f.overviewText = f.plainOverview;
  f.reads = [];
});

/* ── WAVE 1: gap hop ─────────────────────────────────────────────────────── */

it("named-site scope: an off-site redirect landed by the GAP wave never reaches topPassages (audit repro)", async () => {
  f.initialRows = [f.row("/overview-0")];
  f.metaQueue = [[f.row("/redirect-mirror"), f.row("/redirect-wall")]];

  const b = await scopedRun();
  expect(b).not.toBeNull();
  // The repro must actually exercise the gap wave.
  expect(b!.gapSearchFired).toBe(true);

  // THE DEFECT: the mirror crossed the boundary during the gap wave.
  expect(hasHost(b, "counterfeit-host.example.net")).toBe(false);
  expect(hasText(b, "Zephyr-Q91")).toBe(false);

  // Control — the wave's FAIL packet (honest auth-wall state) survives,
  // and its SERP identity was on-scope so the wall itself is reported evidence.
  expect(hasText(b, "OFFSITE-WALL-MARKER")).toBe(true);
});

it("control: the UNSCOPED run keeps the identical gap-wave mirror (no-op law, waves not disabled)", async () => {
  f.initialRows = [f.row("/overview-0")];
  f.metaQueue = [[f.row("/redirect-mirror"), f.row("/redirect-wall")]];

  const b = await unscopedRun();
  expect(b).not.toBeNull();
  expect(b!.gapSearchFired).toBe(true);
  expect(hasHost(b, "counterfeit-host.example.net")).toBe(true);
  expect(hasText(b, "Zephyr-Q91")).toBe(true);
});

/* ── WAVE 2: route-follow hop ────────────────────────────────────────────── */

it("named-site scope: an off-site redirect landed by the ROUTE-FOLLOW hop never reaches topPassages", async () => {
  // The overview NAMES a route to the answer; following it redirects off-site.
  f.overviewText =
    "ArborWorks foundation models overview. See the [supported model catalog](https://docs.arborworks.example.com/reference/model-catalog) and the [models mirror](https://docs.arborworks.example.com/redirect-deep). ";
  f.initialRows = [f.row("/overview-0")];
  f.metaQueue = [[]]; // gap SERP empty → route hop is the acquisition wave

  const b = await scopedRun();
  expect(b).not.toBeNull();
  // The route hop actually fetched both named routes.
  expect(f.reads).toContain("https://docs.arborworks.example.com/redirect-deep");

  // THE DEFECT: the followed route redirected across the boundary.
  expect(hasHost(b, "rewrite-echo.example.org")).toBe(false);
  expect(hasText(b, "Quartz-V88")).toBe(false);

  // Control: the on-scope catalog route still answers through the same hop.
  expect(hasText(b, "Boreal-X17")).toBe(true);
});

it("control: the UNSCOPED run keeps the identical route-follow mirror", async () => {
  f.overviewText =
    "ArborWorks foundation models overview. See the [supported model catalog](https://docs.arborworks.example.com/reference/model-catalog) and the [models mirror](https://docs.arborworks.example.com/redirect-deep). ";
  f.initialRows = [f.row("/overview-0")];
  f.metaQueue = [[]];

  const b = await unscopedRun();
  expect(b).not.toBeNull();
  expect(hasHost(b, "rewrite-echo.example.org")).toBe(true);
  expect(hasText(b, "Quartz-V88")).toBe(true);
});

/* ── WAVE 3: deep demand wave ────────────────────────────────────────────── */

it("named-site scope: an off-site redirect landed by the DEEP DEMAND wave never reaches topPassages", async () => {
  f.depth = "deep";
  f.initialRows = [f.row("/overview-0")];
  // Gap hop fires with an IN-SCOPE row only (proves on-scope wave evidence
  // is untouched); the demand wave's own queries then land off-site.
  f.metaQueue = [[f.row("/overview-1")]];
  f.defaultRows = [f.row("/redirect-wave")];

  const b = await scopedRun();
  expect(b).not.toBeNull();
  expect(b!.demandWaveFired).toBe(true);

  // THE DEFECT: the demand wave's row redirected across the boundary.
  expect(hasHost(b, "offsite-demand.example.net")).toBe(false);
  expect(hasText(b, "Iridium-W77")).toBe(false);

  // Control: the in-scope gap-wave row merged through the SAME admission.
  expect(f.reads).toContain("https://docs.arborworks.example.com/overview-1");
});

it("control: the UNSCOPED run keeps the identical deep-demand mirror", async () => {
  f.depth = "deep";
  f.initialRows = [f.row("/overview-0")];
  f.metaQueue = [[f.row("/overview-1")]];
  f.defaultRows = [f.row("/redirect-wave")];

  const b = await unscopedRun();
  expect(b).not.toBeNull();
  expect(b!.demandWaveFired).toBe(true);
  expect(hasHost(b, "offsite-demand.example.net")).toBe(true);
  expect(hasText(b, "Iridium-W77")).toBe(true);
});
