/**
 * P4 planner-law parity suite (§11.25 suites B+F; ⇔ planner_law.rs
 * `mod tests`). Shared prompts/expectations with the Rust mirror — change
 * one side, change both in the same commit.
 */
import { describe, expect, it } from "vitest";
import {
  applyDomainControl,
  applyPlannerLaw,
  buildGapDemand,
  budgetForDepth,
  derivePlannerLaw,
  evaluateSufficiency,
  type SufficiencyReport,
} from "../../lib/web-search/planner-law";
import type { CoverageReport, PlannedQuery } from "../../lib/web-search/query-planner";
import type {
  EvidencePacket,
  EvidencePassage,
  RankedResult,
  SearchDecision,
} from "../../lib/web-search/types";

function dec(
  depth: SearchDecision["depth"],
  freshness: SearchDecision["freshness"],
  queries: SearchDecision["queries"] = [],
): SearchDecision {
  return { search_required: true, reason: "", freshness, depth, queries };
}
function pq(query: string): PlannedQuery {
  return { query, intent: "general", origin: "semantic" };
}
function rr(url: string, domain: string, origin?: RankedResult["origin"]): RankedResult {
  return {
    url,
    canonical: url,
    title: "t",
    snippet: "s",
    engine: "e",
    domain,
    rrf: 1.0,
    engines: ["e"],
    engineRanks: {},
    ...(origin ? { origin } : {}),
  };
}
function pk(sourceId: string, domain: string, extraction: EvidencePacket["extraction"]): EvidencePacket {
  return {
    sourceId,
    url: `https://${domain}/x`,
    title: "T",
    domain,
    extraction,
    passages: [],
    classification: "SUCCESS_OK",
  };
}
function ep(sourceId: string, domain: string, text: string): EvidencePassage {
  return {
    sourceId,
    url: `https://${domain}/x`,
    title: "T",
    domain,
    passageText: text,
    bm25Score: 0,
  };
}
const emptyLaw = (prompt: string, decision: SearchDecision) => derivePlannerLaw(prompt, decision);

describe("planner law (⇔ planner_law.rs)", () => {
  it("derive_only_scope_allowed_and_blocked_names", () => {
    // Fixture law (search-policy correction 2026-11-02): reddit and quora
    // land in blockedDomains ONLY because the USER explicitly wrote
    // "Don't use reddit or quora." — this fixture proves the EXPLICIT-user
    // hard-block semantics, it is NOT default policy. Merely-weak sources
    // are softly de-prioritized in reranker.ts and NEVER blocked by default.
    const law = emptyLaw(
      "Only search arxiv.org for the paper. Don't use reddit or quora.",
      dec("standard", "none"),
    );
    expect(law.allowedDomains).toEqual(["arxiv.org"]);
    expect(law.blockedDomains).toEqual(["reddit.com", "quora.com"]);
    expect(law.preferredDomains).toEqual([]);
    expect(law.location).toBeNull();
  });

  it("derive_blocked_names_are_plural_tolerant", () => {
    // USER-explicit block ("avoid reddits") — not a default block-list
    // (policy correction 2026-11-02; weak sources ride reranker.ts's soft
    // prior, they are never auto-blocked).
    const law = emptyLaw("avoid reddits at all costs", dec("standard", "none"));
    expect(law.blockedDomains).toEqual(["reddit.com"]);
  });

  it("derive_prompt_site_operator_is_allowed", () => {
    const law = emptyLaw("site:react.dev examples please", dec("standard", "none"));
    expect(law.allowedDomains).toEqual(["react.dev"]);
    expect(law.blockedDomains).toEqual([]);
  });

  it("derive_official_demand_prefers_without_fabricating_allowlist", () => {
    const law = emptyLaw("use official documentation only", dec("standard", "none"));
    expect(law.allowedDomains).toEqual([]); // Preferred ≠ allowed (§11.17)
    expect(law.preferredDomains).toEqual([]);
    expect(law.expectedSourceTypes).toContain("official_docs");
  });

  it("derive_brand_docs_pattern_prefers_brand_domain", () => {
    const law = emptyLaw("search kubernetes docs please", dec("standard", "none"));
    expect(law.preferredDomains).toEqual(["kubernetes.com"]);
    // A stopword token must never fabricate a brand domain.
    const none = emptyLaw("search the docs please", dec("standard", "none"));
    expect(none.preferredDomains).toEqual([]);
  });

  it("derive_merges_gate_preferred_and_block_wins", () => {
    const q = {
      query: "docs",
      intent: "docs" as const,
      preferred_domains: ["reddit.com", "docs.rs"],
    };
    // The gate suggested reddit.com as PREFERENCE; the user's explicit
    // block ("don't use reddit") is the only hard-exclusion trigger here
    // (policy correction 2026-11-02) and contradictions drop preference.
    const law = emptyLaw("don't use reddit", dec("standard", "none", [q]));
    expect(law.blockedDomains).toEqual(["reddit.com"]);
    expect(law.preferredDomains).toEqual(["docs.rs"]);
  });

  it("derive_location_is_coarse_and_gated_by_local_intent", () => {
    const std = dec("standard", "none");
    expect(emptyLaw("weather in Pune", std).location).toBe("Pune");
    expect(emptyLaw("how do exceptions work in Kubernetes", std).location).toBeNull();
    expect(emptyLaw("best restaurants near New York City", std).location).toBe("New York City");
  });

  it("budget_depths", () => {
    const deep = budgetForDepth("deep");
    expect(deep.demandWaveQueries).toBe(2);
    for (const d of ["quick", "standard"] as const) {
      expect(budgetForDepth(d).demandWaveQueries).toBe(0);
    }
    expect(deep.maxPageFetches).toBe(10);
    expect(deep.maxGapPageFetches).toBe(3);
    expect(deep.maxPassages).toBe(15);
  });

  it("apply_planner_law_adds_scoped_companions_and_respects_cover", () => {
    const std = dec("standard", "none");
    const law = emptyLaw("only search arxiv.org", std);
    const out = applyPlannerLaw([pq("rust async runtime")], law);
    expect(out.length).toBe(2);
    expect(out[1].query).toBe("rust async runtime site:arxiv.org");
    expect(out[1].origin).toBe("preferred"); // ⇔ PlanOrigin::Preferred wire label
    expect(out[1].preferredDomains).toEqual(["arxiv.org"]);
    // Already scoped → nothing added.
    expect(applyPlannerLaw([pq("rust async runtime site:arxiv.org")], law).length).toBe(1);
    // The 4-wave cap holds against a 4-target law.
    const wide = emptyLaw("only search a.com, b.com, c.com, d.com", std);
    expect(wide.allowedDomains.length).toBe(4);
    expect(applyPlannerLaw([pq("base query")], wide).length).toBe(4);
  });

  it("apply_domain_control_blocks_allows_and_exempts_user_links", () => {
    const std = dec("standard", "none");
    const law = emptyLaw("Only search arxiv.org. Don't use reddit.", std);
    const kept = applyDomainControl(
      [
        rr("https://reddit.com/r/x", "reddit.com"), // blocked (USER-explicit only)
        rr("https://arxiv.org/abs/1", "arxiv.org"), // allowed
        rr("https://example.com/x", "example.com"), // outside allowlist
        rr("https://example.com/mine", "example.com", "user"), // user-directed exempt
        rr("https://www.arxiv.org/x", ""), // host-from-url + www
      ],
      law,
    ).map((r) => r.url);
    expect(kept).toEqual([
      "https://arxiv.org/abs/1",
      "https://example.com/mine",
      "https://www.arxiv.org/x",
    ]);
    // No lists → strict no-op identity.
    const plain = emptyLaw("hello there", std);
    const input = [rr("https://reddit.com/r/x", "reddit.com")];
    expect(applyDomainControl(input, plain)).toEqual(input);
  });

  it("sufficiency_gates_snippet_only_and_contradiction", () => {
    const std = dec("standard", "week");
    const law = emptyLaw("", std);
    const packets = [
      pk("s1", "a.com", "direct"),
      pk("s2", "b.com", "direct"),
      pk("s3", "z.com", "snippet-only"), // §11.14: never counts
    ];
    const passages = [
      ep("s1", "a.com", "The price is 10.50 dollars"),
      ep("s2", "b.com", "The price jumped to 12.00"),
      ep("s3", "z.com", "The price is 9.99"), // filtered out with its source
    ];
    const coverage: CoverageReport = {
      coverage: 0.8,
      missingEntities: [],
      needsGapSearch: false,
      gapQuery: null,
    };
    const report = evaluateSufficiency(packets, passages, coverage, std, law);
    expect(report.sourceDomains).toEqual(["a.com", "b.com"]); // z.com excluded
    expect(report.enoughSources).toBe(false); // 2 < 3
    expect(report.independentDomains).toBe(true);
    expect(report.keyClaimsSupported).toBe(true);
    expect(report.freshnessOk).toBe(false); // "week" band, no dated kept passage
    expect(report.primaryPresent).toBe(true);
    expect(report.contradictionSuspected).toBe(true);
    expect(report.contradictionMetrics).toEqual(["price"]);
    expect(report.pagesUseful).toBe(true);
    expect(report.stopEarly).toBe(false);
  });

  it("gap_demand_variants_never_repeat_a_used_query", () => {
    const deep = dec("deep", "year");
    const prompt = "rust performance price report analysis final extra";
    const law = emptyLaw(prompt, deep);
    expect(law.budget.demandWaveQueries).toBe(2);
    const coverage: CoverageReport = {
      coverage: 0.9,
      missingEntities: [],
      needsGapSearch: false,
      gapQuery: null,
    };
    const suff: SufficiencyReport = {
      enoughSources: false,
      keyClaimsSupported: true,
      freshnessOk: true,
      primaryPresent: true,
      independentDomains: true,
      contradictionSuspected: true,
      pagesUseful: true,
      stopEarly: false,
      sourceDomains: ["a.com", "b.com"],
      contradictionMetrics: ["price"],
    };
    const entity = "rust performance price report analysis final";
    const base1 = `price ${entity} official`;
    const demand = buildGapDemand(prompt, coverage, suff, deep, law, [base1])!;
    expect(demand.missing_claims).toEqual([
      "conflicting price across sources",
      "additional independent sources",
    ]);
    expect(demand.desired_source_types).toEqual(["reviews", "official_docs", "news"]);
    expect(demand.reason).toBe("conflicting values across sources; too few independent domains");
    expect(demand.queries.length).toBe(2);
    // Never-repeat law: the collided base climbed the suffix ladder.
    expect(demand.queries[0]).not.toBe(base1);
    expect(demand.queries[0].endsWith("official official")).toBe(true);
    expect(demand.queries[1].endsWith(" extra review")).toBe(true);
    expect(demand.remaining_budget).toBe(0);
    // §11.6 wire shape (snake_case) + key order ⇔ Rust serde string.
    expect(JSON.stringify(demand)).toBe(
      '{"missing_claims":["conflicting price across sources","additional independent sources"],"queries":[' +
        JSON.stringify(demand.queries[0]) +
        "," +
        JSON.stringify(demand.queries[1]) +
        '],"desired_source_types":["reviews","official_docs","news"],"freshness":"year","reason":"conflicting values across sources; too few independent domains","remaining_budget":0}',
    );
  });

  it("gap_demand_drops_fully_colliding_bases_and_nulls_clean_cases", () => {
    const deep = dec("deep", "year");
    const prompt = "rust performance price report analysis final extra";
    const law = emptyLaw(prompt, deep);
    const coverage: CoverageReport = {
      coverage: 0.9,
      missingEntities: [],
      needsGapSearch: false,
      gapQuery: null,
    };
    const suff: SufficiencyReport = {
      enoughSources: false,
      keyClaimsSupported: true,
      freshnessOk: true,
      primaryPresent: true,
      independentDomains: true,
      contradictionSuspected: true,
      pagesUseful: true,
      stopEarly: false,
      sourceDomains: ["a.com", "b.com"],
      contradictionMetrics: ["price"],
    };
    // Whole ladder collides for BOTH bases → no query may repeat → null.
    const year = String(new Date().getUTCFullYear());
    const entity = "rust performance price report analysis final";
    const b1 = `price ${entity} official`;
    const b2 = `${prompt} review`;
    const used = [b1, `${b1} official`, `${b1} review`, `${b1} ${year}`, b2, `${b2} official`, `${b2} review`, `${b2} ${year}`];
    expect(buildGapDemand(prompt, coverage, suff, deep, law, used)).toBeNull();
    // Nothing missing → null (stop-early case; no demand at all).
    const good: SufficiencyReport = {
      enoughSources: true,
      keyClaimsSupported: true,
      freshnessOk: true,
      primaryPresent: true,
      independentDomains: true,
      contradictionSuspected: false,
      pagesUseful: true,
      stopEarly: true,
      sourceDomains: ["a.com", "b.com", "c.com"],
      contradictionMetrics: [],
    };
    expect(buildGapDemand(prompt, coverage, good, deep, law, [])).toBeNull();
    // Non-deep depths carry a zero demand-wave budget (§11.21) → null.
    const quick = dec("quick", "year");
    const lawQ = emptyLaw(prompt, quick);
    expect(buildGapDemand(prompt, coverage, suff, quick, lawQ, [])).toBeNull();
  });

  it("serde_field_order_and_vocabulary_match_ts", () => {
    // PlannerLaw camelCase key ORDER ⇔ TS object literal ⇔ Rust serde. The
    // blockedDomains values here are FIXTURE INPUTS proving serialization of
    // an EXPLICIT user block (the prompt says "Don't use reddit or quora.")
    // — NOT default policy (policy correction 2026-11-02: weak sources are
    // softly ranked in reranker.ts, never blocked by default).
    const std = dec("standard", "none");
    const law = emptyLaw(
      "Only search arxiv.org for the paper. Don't use reddit or quora.",
      std,
    );
    // "paper" maps through sourceClass to the pdf class — the SAME classMap
    // runs on both sides, so Rust yields ["pdf"] too.
    expect(JSON.stringify(law)).toBe(
      '{"allowedDomains":["arxiv.org"],"blockedDomains":["reddit.com","quora.com"],"preferredDomains":[],"location":null,"expectedSourceTypes":["pdf"],"budget":{"maxQueryWaves":4,"maxPageFetches":10,"maxGapPageFetches":3,"demandWaveQueries":0,"maxPassages":15}}',
    );
  });
});
