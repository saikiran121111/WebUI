/**
 * AUDIT 2026-11-05 (brief item 8 / WS08) — bounded requirement-driven
 * expansion of the route-follow hop.
 *
 * Audit repro (verbatim): "Root-relative, parent-relative, protocol-
 * relative and SPA fragment links are not harvested. Overview -> docs ->
 * catalog stops at docs in standard and deep modes. A relevant 13th link
 * loses to 12 earlier navigation links."
 *
 * Three separate defects, three fixtures:
 *  1. collectRouteLinks only matched http(s) hrefs even though it already
 *     resolved every raw through new URL(raw, base) — every relative link
 *     form (and the in-page-anchor distinction) was invisible.
 *  2. The harvest cap (12) cut candidates BEFORE the pipeline scored them,
 *     so position decided what got fetched, not relevance.
 *  3. The hop fired exactly once, so a navigation chain (overview ->
 *     docs-hub -> catalog) died at the first nav page.
 *
 * Bounds (this is NOT a crawl): harvest cap is a generous safety bound;
 * ranking-then-fetch-cap stays at budget.maxGapPageFetches per hop; hop
 * count bounded by depth (standard 2, deep 3, quick 1); a hop fires ONLY
 * while evaluateCoverage still reports the answer unit missing, so the
 * chain halts the instant an identifier-shaped answer lands.
 * Controls: read_page's 12-link inventory default stays untouched;
 * absolute-link behavior byte-identical; in-page anchors and javascript:/
 * mailto: hrefs never become routes. Fictional ArborWorks fixtures only.
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
    // The catalog page body: WITH the identifier-shaped answer vs WITHOUT
    // (prose-only) — switched per fixture to test coverage-halt vs hop-cap.
    answerText: "",
    reads: [] as string[],
    row,
    CATALOG: "https://docs.arborworks.example.com/reference/foundation-models",
    DOCS_HUB: "https://docs.arborworks.example.com/guide/docs-hub",
    BEYOND: "https://docs.arborworks.example.com/reference/beyond-catalog",
    catalogLink: (target: string) =>
      ` See the [foundation models catalog](${target}) for the vendor list.`,
  };
});

// Catalog bodies for the two chain regimes. The no-answer variant keeps
// needsGapSearch armed (no novel identifier) so the hop CAP, not coverage,
// must end the chain; the answer variant carries Boreal-X17 so coverage
// must halt the chain BEFORE the cap.
const CATALOG_NO_ANSWER =
  "This catalog page lists model categories, support tiers and naming conventions for the ArborWorks platform in prose.";
const CATALOG_WITH_ANSWER =
  "Vendor naming conventions page: current generation models are Boreal-X17 and Cedar-Y23. This catalog page also lists support tiers for the ArborWorks platform.";
const BEYOND_TEXT =
  "Legacy categories and archival material about the ArborWorks platform and its support pages.";
const DOCS_HUB_TEXT =
  "Structured guides for the ArborWorks platform: setup walkthroughs, support pages and release notes.";

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
  const bodyFor = (url: string): string => {
    if (url.includes("/reference/foundation-models")) return f.answerText + f.catalogLink(f.BEYOND);
    if (url.includes("/guide/docs-hub")) return DOCS_HUB_TEXT + f.catalogLink(f.CATALOG);
    if (url.includes("/reference/beyond-catalog")) return BEYOND_TEXT;
    if (url.includes("/nav/")) return "Navigation section page for the ArborWorks site. ";
    return f.overviewText;
  };
  const packet = (r: any) => {
    f.reads.push(r.url);
    const passageText = bodyFor(r.url);
    return {
      sourceId: "",
      url: r.url,
      domain: r.domain,
      title: r.title,
      extraction: "direct",
      classification: "SUCCESS_DIRECT",
      passages: [{ sourceId: "", url: r.url, domain: r.domain, title: r.title, passageText, bm25Score: 0 }],
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
import { collectRouteLinks } from "@/lib/web-search/route-links";

const run = () => runWebResearch({ userPrompt: PROMPT, scope: undefined } as any);

beforeEach(() => {
  f.depth = "standard";
  f.metaQueue = [[]]; // gap-hop SERP empty: route-follow is the acquisition wave
  f.defaultRows = [];
  f.initialRows = [f.row("/overview-0")];
  f.overviewText =
    "ArborWorks company overview: office locations, hiring pages and general platform information. ";
  f.answerText = CATALOG_WITH_ANSWER;
  f.reads = [];
});

/* ── 1. link-FORM harvesting (unit on the shared harvester) ─────────────── */

it("harvests every in-content link FORM resolved against the serving page, not just absolute hrefs", () => {
  const base = "https://docs.arborworks.example.com/guide/models-overview";
  const text =
    "Read the [foundation models catalog](/reference/foundation-models), the " +
    "[glossary](../appendix/glossary), the [assets manifest](//cdn.arborworks.example.com/models/manifest) " +
    "and the [SPA models view](#/foundation-models). " +
    "Skip the [footnote](#footnote-3), the [script](javascript:void(0)), the " +
    "[mail](mailto:hi@arborworks.example.com) and the [same page](https://docs.arborworks.example.com/guide/models-overview). " +
    "And the classic [absolute link](https://docs.arborworks.example.com/reference/absolute-still-works).";
  const urls = collectRouteLinks(base, [{ passageText: text }]).map((l) => l.url);

  // THE DEFECT: every relative form was invisible.
  expect(urls).toContain("https://docs.arborworks.example.com/reference/foundation-models");
  expect(urls).toContain("https://docs.arborworks.example.com/appendix/glossary");
  expect(urls).toContain("https://cdn.arborworks.example.com/models/manifest");
  expect(urls.some((u) => u.includes("#/foundation-models"))).toBe(true);

  // Controls: forms already harvested keep working; junk never becomes a route.
  expect(urls).toContain("https://docs.arborworks.example.com/reference/absolute-still-works");
  expect(urls.some((u) => u.includes("footnote-3"))).toBe(false);
  expect(urls.some((u) => u.includes("void"))).toBe(false);
  expect(urls.some((u) => u.startsWith("mailto"))).toBe(false);
  expect(urls).not.toContain(base); // a route back onto the page just read
});

/* ── 2. cap AFTER ranking: the relevant 13th link wins ──────────────────── */

it("a relevant 13th content link beats the 12 earlier navigation links (rank-then-cap, not position)", async () => {
  const navs = [
    ["Home page", "/home"], ["About us", "/about"], ["Blog posts", "/blog"],
    ["Careers info", "/careers"], ["Contact us", "/contact"], ["Privacy policy", "/privacy"],
    ["Terms page", "/terms"], ["Help desk", "/help"], ["Docs hub", "/docs"],
    ["News posts", "/news"], ["Team page", "/team"], ["Partner list", "/partners"],
  ]
    .map(([a, p]) => `[${a}](https://docs.arborworks.example.com/nav${p})`)
    .join(" ");
  f.overviewText =
    "ArborWorks company overview: office locations, hiring pages and general platform information. " +
    navs +
    ` [foundation models catalog](${f.CATALOG})`;

  const b = await run();
  expect(b).not.toBeNull();
  // THE DEFECT: harvest cap 12 cut the 13th link before anything scored it.
  expect(f.reads).toContain(f.CATALOG);
  expect(f.reads.filter((u) => u.includes("/nav/")).length).toBeLessThanOrEqual(2);
  expect(f.reads).not.toContain("https://docs.arborworks.example.com/nav/privacy");

  // Control: the answer arrives THROUGH the ranked hop.
  expect(b!.topPassages.some((p: any) => p.passageText.includes("Boreal-X17"))).toBe(true);
});

/* ── 3. the chain survives the nav layer (overview -> docs -> catalog) ──── */

it("overview -> docs-hub -> catalog chain answers in DEEP mode and HALTS at the answer (requirement-driven, not a crawl)", async () => {
  f.depth = "deep";
  f.overviewText =
    "ArborWorks company overview: office locations, hiring pages and general platform information. " +
    ` See the [documentation hub](${f.DOCS_HUB}) for structured guides.`;

  const b = await run();
  expect(b).not.toBeNull();
  // THE DEFECT (audit repro): the single-shot hop stopped at the docs hub.
  expect(f.reads).toContain(f.DOCS_HUB);
  expect(f.reads).toContain(f.CATALOG);
  expect(b!.topPassages.some((p: any) => p.passageText.includes("Boreal-X17"))).toBe(true);

  // Bound control: the answer merged at hop 2 -> coverage no longer needs
  // the gap -> the third hop (the beyond-catalog link named inside the
  // catalog page) is never fetched even though DEEP allows 3 hops.
  expect(f.reads).not.toContain(f.BEYOND);
});

it("chain hop CAPS at 2 in standard mode: the third-page link is never fetched even with no answer yet", async () => {
  f.depth = "standard";
  f.answerText = CATALOG_NO_ANSWER; // prose-only catalog: coverage stays hungry
  f.overviewText =
    "ArborWorks company overview: office locations, hiring pages and general platform information. " +
    ` See the [documentation hub](${f.DOCS_HUB}) for structured guides.`;

  const b = await run();
  expect(b).not.toBeNull();
  expect(f.reads).toContain(f.DOCS_HUB);
  expect(f.reads).toContain(f.CATALOG); // hop 2 fires — the audit repro fixed
  expect(f.reads).not.toContain(f.BEYOND); // but the hop count is bounded

  // Control: with the SAME chain, DEEP's bound (3 hops) does fetch page 3.
  f.depth = "deep";
  f.reads = [];
  const d = await run();
  expect(d).not.toBeNull();
  expect(f.reads).toContain(f.BEYOND);
});
