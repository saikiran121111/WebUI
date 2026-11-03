/**
 * Task-scope planner regressions (audit 2026-11-02, brief #3/#4/#6).
 *
 * HISTORICAL SHARED VECTORS with the Rust inline counterparts that lived in
 * `rust-backend/crates/ruke-websearch/src/query_planner.rs` (crate removed
 * 2026-11-03; these TS regressions are the sole owner):
 *   no-fabrication .......... rust `planner_never_fabricates_domains_from_prompt`
 *   resolved site: companion  rust `plan_queries_scope_resolved_host_gets_site_companion`
 *   unresolved discovery .... rust `plan_queries_scope_unresolved_bare_phrase_discovery`
 *   companion survives cap .. rust `plan_queries_scope_companion_survives_query_cap`
 *   generic-word anchors .... rust `plan_queries_generic_words_never_anchor_targeted_operators`
 *
 * The old brand path (extractBrandTokens + inferBrandDomain + INDIAN_BRAND_
 * HINTS) fabricated `site:what.com`, `site:order.com`, `blinkitcom.com`, and
 * `foo.com` for `foo.community` — DELETED. These tests pin the replacement
 * law: only VERIFIED scope hosts ever produce a `site:` companion; unresolved
 * targets get bounded bare-phrase discovery, never a guessed domain.
 */
import { describe, it, expect } from "vitest";
import { planQueries } from "@/lib/web-search/query-planner";
import type { SearchDecision } from "@/lib/web-search/types";
import type { TaskScope } from "@/lib/decision/task-scope";

type GateQuery = SearchDecision["queries"][number];

const q = (query: string): GateQuery => ({ query, intent: "general" });

function scopeResolved(host: string): TaskScope {
  return {
    intent: "operate",
    targets: [
      {
        phrase: host,
        state: "resolved",
        host,
        url: "",
        candidates: [],
        provenance: "explicit_domain",
      },
    ],
    excludedPhrases: [],
    authorizedHosts: [],
  };
}

function scopeUnresolved(phrase: string): TaskScope {
  return {
    intent: "operate",
    targets: [
      { phrase, state: "unresolved", host: "", url: "", candidates: [], provenance: "none" },
    ],
    excludedPhrases: [],
    authorizedHosts: [],
  };
}

describe("task-scope planner regressions (⇔ rust query_planner audit tests)", () => {
  it("planner never fabricates domains from the prompt (⇔ planner_never_fabricates_domains_from_prompt)", () => {
    // The old path emitted site:what.com here (sentence-initial "What").
    // Without a VERIFIED scope host, NO plan may carry a site: operator at
    // all for a non-github/linkedin class.
    const plans = planQueries(
      "What is the price of kingfisher beer 650ml on the official site?",
      [],
      undefined,
      undefined,
    );
    for (const p of plans) expect(p.query).not.toContain("site:");
  });

  it("resolved scope host gets the site: companion spliced after the broad query (⇔ rust companion test)", () => {
    const plans = planQueries("order milk", [q("order milk groceries")], undefined, scopeResolved("zepto.com"));
    expect(plans[1].origin).toBe("scope");
    expect(plans[1].query).toBe("order milk groceries site:zepto.com");
    expect(plans[1].preferredDomains).toEqual(["zepto.com"]);
  });

  it("unresolved scope target gets bare quoted discovery, never a fabricated domain (⇔ rust discovery test)", () => {
    // "Order milk on Zepto": the old path fabricated site:order.com.
    const plans = planQueries("Order milk on Zepto", [], undefined, scopeUnresolved("Zepto"));
    const scopePlans = plans.filter((p) => p.origin === "scope");
    expect(scopePlans).toHaveLength(1);
    expect(scopePlans[0].query).toBe('"Zepto"');
    for (const p of plans) expect(p.query).not.toContain("site:");
  });

  it("explicit target survives the 4-query cap (⇔ rust survives-cap test)", () => {
    // Brief #6: scope companions splice in BEFORE the tail is dropped.
    const plans = planQueries(
      "read the documentation for rust tokio runtime",
      [q("q one"), q("q two"), q("q three"), q("q four")],
      undefined,
      scopeResolved("tokio.rs"),
    );
    expect(plans.length).toBeLessThanOrEqual(4);
    expect(
      plans.some((p) => p.origin === "scope" && p.query.endsWith(" site:tokio.rs")),
    ).toBe(true);
  });

  it("generic words never anchor targeted operators (⇔ rust generic-anchor test)", () => {
    // The old step-3 anchored on the first entity: `pricing "price"`.
    const plans = planQueries(
      "check the latest prices",
      [q("latest movie showtimes pvr")],
      ["price", "latest"],
      undefined,
    );
    expect(
      plans.some((p) => p.origin === "targeted" && p.query === "pricing latest movie showtimes pvr"),
    ).toBe(true);
  });

  it("compare_sites scope drives companions for every resolved target (cap 2)", () => {
    const scope: TaskScope = {
      intent: "compare_sites",
      targets: [
        { phrase: "a", state: "resolved", host: "site-a.com", url: "", candidates: [], provenance: "explicit_domain" },
        { phrase: "b", state: "resolved", host: "site-b.com", url: "", candidates: [], provenance: "explicit_domain" },
      ],
      excludedPhrases: [],
      authorizedHosts: [],
    };
    const plans = planQueries("compare prices", [q("compare prices")], undefined, scope);
    const scopePlans = plans.filter((p) => p.origin === "scope");
    expect(scopePlans).toHaveLength(2);
    expect(scopePlans[0].query).toBe("compare prices site:site-a.com");
    expect(scopePlans[1].query).toBe("compare prices site:site-b.com");
  });

  it("ambiguous targets get NO planner companion — clarification owns ambiguity", () => {
    const scope: TaskScope = {
      intent: "operate",
      targets: [
        {
          phrase: "apple",
          state: "ambiguous",
          host: "",
          url: "",
          candidates: ["apple.com", "apple.in"],
          provenance: "ambiguous",
        },
      ],
      excludedPhrases: [],
      authorizedHosts: [],
    };
    const plans = planQueries("order apples", [q("order apples")], undefined, scope);
    expect(plans.filter((p) => p.origin === "scope")).toHaveLength(0);
    for (const p of plans) expect(p.query).not.toContain("apple.com");
  });
});
