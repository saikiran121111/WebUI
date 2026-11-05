/**
 * AUDIT 2026-11-05 (brief item 9 / WS09) — answer support vs identifier SHAPE.
 *
 * Audit repro (verbatim): "Footer tokens WebKit, OpenAPI, HTTP2 or Page-2026
 * suppress missing-model recovery. One explicitly partial example also marks
 * the catalog complete. Conversely, a complete plain country list triggers a
 * false gap." Cause: "evaluateCoverage / hasNovelIdentifier treats any novel
 * identifier-shaped token as an enumerative answer. The pattern excludes many
 * pronoun and 'use' phrasings and has no relation/completeness proof. Fix
 * answer-unit support: require that a passage answers the requested
 * entity/relation and establish the scope of a claimed complete list. Topical
 * overlap, token shape and one example are retrieval/ranking signals only."
 *
 * The fix must stay UNIVERSAL: grammar + position + morphology only — no
 * brand tables, no footer-text lists, no site rules. Fictional ArborWorks
 * fixtures only. Controls: a genuine identifier-in-answer sentence still
 * closes coverage (byte-stable with research-depth-policy.test.ts), a fully
 * supported answer with one un-hedged list sentence closes even alongside a
 * hedged example, and topical repetition alone never counted before and
 * still never counts.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { evaluateCoverage } from "@/lib/web-search/query-planner";

const PROMPT = "Which foundation models does ArborWorks support?";

/* ── 1. false completeness: identifier SHAPE without relation ───────────── */

it("footer-shaped identifier tokens never fake answer support (recovery must not be suppressed)", () => {
  const r = evaluateCoverage(PROMPT, [
    // The audited repro: identifier-SHAPED junk tokens (WebKit, HTTP2,
    // Page-2026 — same shapes as real product IDs) sitting in footer
    // sentences that carry NO relation to the requested entity.
    "ArborWorks company overview page. This site is powered by WebKit. HTTP2 enabled. Page-2026 archive. All rights reserved.",
    // Topically complete (every query word matches) but answers nothing:
    "ArborWorks foundation models support overview with orchestration details and platform news.",
  ]);
  // THE DEFECT: today the novel identifier-shaped tokens count as "an
  // enumerative answer arrived", so recovery is suppressed.
  expect(r.needsGapSearch, "token shape outside an answer sentence is a ranking signal, not support").toBe(true);
});

it("one explicitly partial example never marks a complete enumerative ask answered", () => {
  const r = evaluateCoverage(PROMPT, [
    "For example, Boreal-X17 is a supported ArborWorks foundation model.",
    "ArborWorks foundation models support overview with orchestration details and platform news.",
  ]);
  // THE DEFECT: today the identifier closes coverage even though the ONLY
  // support sentence is explicitly partial ("For example").
  expect(r.needsGapSearch, "an explicitly hedged example does not establish the scope of a complete list").toBe(true);
});

/* ── 2. false gaps: plain-name answers were invisible to the shape law ──── */

it("a complete plain proper-name list in the relation sentence answers the ask (no false gap)", () => {
  const r = evaluateCoverage(PROMPT, [
    "ArborWorks supports operations in India, Brazil, Japan and Germany.",
    "Foundation models support at ArborWorks is organized by region.",
  ]);
  // THE DEFECT: the answer exists as plain capitalized names; the old
  // shape-only detector never saw an identifier, so recovery kept firing.
  expect(r.needsGapSearch, "a plain enumerated list answer is support even without identifier shape").toBe(false);
});

it("single-name answers phrased with pronoun + 'use' count as support", () => {
  const r = evaluateCoverage(PROMPT, [
    "It uses Opus.",
    "Foundation models support at ArborWorks is documented centrally.",
  ]);
  // THE DEFECT (audit: "excludes many pronoun and 'use' phrasings"):
  // "Opus" is a plain proper name — the shape law missed it and kept a
  // supported ask searching.
  expect(r.needsGapSearch, "a named answer in a use-sentence supports the ask even without identifier shape").toBe(false);
});

/* ── 3. positive controls (assertions NOT weakened) ─────────────────────── */

it("control: an un-hedged list sentence alongside a hedged example closes coverage", () => {
  const r = evaluateCoverage(PROMPT, [
    "For example, Boreal-X17 is a supported model.",
    "The full supported foundation models list for ArborWorks is Boreal-X17 and Cedar-Y23.",
    "ArborWorks foundation models support overview with orchestration details.",
  ]);
  expect(r.needsGapSearch).toBe(false);
});

it("control: topical repetition alone never supported the ask and still does not", () => {
  const overview =
    "ArborWorks foundation models support overview. The platform provides model orchestration. " +
    "The actual supported identifiers are on a linked catalog page. ";
  const r = evaluateCoverage(PROMPT, [overview, overview]);
  expect(r.needsGapSearch).toBe(true);
});

it("control: a question-echo identifier (token from the prompt) is never novel support", () => {
  const r = evaluateCoverage(PROMPT, [
    "Foundation models support at ArborWorks is documented centrally.",
    "Foundation models support pages for ArborWorks describe the foundation models support process.",
  ]);
  expect(r.needsGapSearch).toBe(true);
});

/* ── 4. pipeline repro: footer-shaped junk must not suppress the gap wave ─ */

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
    metaQueue: [] as any[][],
    defaultRows: [] as any[],
    initialRows: [] as any[],
    overviewText: "",
    reads: [] as string[],
    row,
  };
});

vi.mock("@/lib/web-search/search-gate", () => ({
  runSearchGate: async () => ({
    source: "rules",
    gateMs: 0,
    decision: {
      search_required: true,
      reason: "controlled lookup",
      depth: "standard",
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
    url.includes("/answer-catalog")
      ? "ArborWorks foundation models support: Boreal-X17 and Cedar-Y23. The complete supported models list is Boreal-X17 and Cedar-Y23."
      : f.overviewText;
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

beforeEach(() => {
  f.metaQueue = [];
  f.defaultRows = [];
  f.initialRows = [];
  f.reads = [];
  f.overviewText =
    "ArborWorks company overview: foundation models support hub, office locations, hiring pages and general platform information. ";
});

it("pipeline: footer-shaped tokens on fully-covered initial pages must NOT suppress the gap recovery wave", async () => {
  // Two on-topic initial rows (>= 2 passages, full entity coverage) whose
  // text carries identifier-SHAPED footer junk. The audit repro:
  // "Footer tokens WebKit, OpenAPI, HTTP2 or Page-2026 suppress
  // missing-model recovery."
  f.overviewText +=
    "This site is powered by WebKit. HTTP2 enabled. Page-2026 archive. All rights reserved.";
  f.initialRows = [f.row("/overview-0"), f.row("/overview-1")];
  f.metaQueue = [[f.row("/answer-catalog")]];

  const b = await runWebResearch({ userPrompt: PROMPT, scope: undefined } as any);
  expect(b).not.toBeNull();
  // THE DEFECT: the old shape-only detector declared the ask answered, so
  // no recovery wave was ever dispatched.
  expect(b!.gapSearchFired, "footer token shape is not answer support — recovery must fire").toBe(true);
  // Control: the fired recovery actually answers through the real pipeline.
  expect(b!.topPassages.some((p: any) => p.passageText.includes("Boreal-X17"))).toBe(true);
});
