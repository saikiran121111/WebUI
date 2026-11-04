/**
 * Vectors for the 2026-11-04 pivot (user: "zepto should search zepto...
 * nothing hard coded, it should be universal... take the current location/
 * time from the user system... send all these current things to ai").
 *
 * Three universal mechanisms, all evidence-driven — no brand table, no
 * website list, no TLD guessing anywhere in this file's law:
 *   1. corroborated DESTINATION verification (planner-law): a target the
 *      equality-only TaskScope law leaves unresolved is verified only when
 *      title-lead AND label-family agree (both signals, one family).
 *   2. hostname↔query-token AFFINITY boost (metasearch fusion): order-only,
 *      rarity-gated (df over the fused pool substitutes for any stopword
 *      or brand list).
 *   3. system local context: country/time/zone read from the local Intl
 *      runtime, fed to the planner law (location fallback) and the gate
 *      prompt (line added after the date — existing prefix pins hold).
 */
import { describe, expect, it, vi } from "vitest";
import { corroborateDestinations, derivePlannerLaw } from "../../lib/web-search/planner-law";
import { reciprocalRankFuse } from "../../lib/web-search/metasearch";
import { localContextLine, systemRegionName } from "../../lib/web-search/local-context";
import {
  applyVerifiedDestinations,
  scopeHosts,
  type TaskScope,
} from "../../lib/decision/task-scope";
import type { RawSearchResult, SearchDecision } from "../../lib/web-search/types";

function unresolvedScope(phrase: string): TaskScope {
  return {
    intent: "operate",
    targets: [{ phrase, state: "unresolved", host: "", url: "", candidates: [], provenance: "none" }],
    excludedPhrases: [],
    authorizedHosts: [],
  };
}

const row = (url: string, title: string) => ({ url, title });

describe("corroborated destination verification (audit items 3/5)", () => {
  it("brand≠domain identity verifies when title AND label family agree", () => {
    // Zepto/zeptonow.com: the brand word is not the domain word, yet the
    // sites speak for themselves (leading title + label prefix). The two
    // zeptonow hosts share ONE label family, so identity is unambiguous.
    const v = corroborateDestinations(unresolvedScope("zepto"), [
      row("https://zeptonow.com/instant-grocery", "Zepto - India's Fastest Grocery Delivery"),
      row("https://zeptonow.in/", "Zepto | Quick Grocery in Minutes"),
    ]);
    expect(v).toEqual([{ phrase: "zepto", host: "zeptonow.com" }]);
  });

  it("title-leading coverage from an unrelated label NEVER verifies", () => {
    // timesofindia/economictimes TITLES lead with the brand — third-party
    // coverage, not the destination itself.
    const v = corroborateDestinations(unresolvedScope("zepto"), [
      row("https://timesofindia.indiatimes.com/zepto-expands", "Zepto expands to 100 new cities"),
      row("https://economictimes.com/zepto-raises", "Zepto raises Series H round"),
    ]);
    expect(v).toEqual([]);
  });

  it("label-prefix resemblance without a self-claiming title NEVER verifies", () => {
    const v = corroborateDestinations(unresolvedScope("zepto"), [
      row("https://zeptodiscounts.com/", "Save 50% on groceries near you"),
      row("https://zepto-sale.info/", "Best grocery coupons online"),
    ]);
    expect(v).toEqual([]);
  });

  it("two self-claiming label families = honest ambiguity = nothing verified", () => {
    // A squatter loudly titling itself "Zepto..." earns exactly the
    // ambiguity that protects the real destination from a wrong guess.
    const v = corroborateDestinations(unresolvedScope("zepto"), [
      row("https://zeptonow.com/", "Zepto - Quick Delivery"),
      row("https://zeptodiscounts.com/", "Zepto Discounts - Daily Deals"),
    ]);
    expect(v).toEqual([]);
  });

  it("§7 credibility: a LONE padded-label self-claim verifies nothing", () => {
    // Anyone can title-pad a lookalike domain ("Zepto Discounts"); one
    // self-claiming padded host is exactly the squatter shape. Without a
    // second distinct in-family host to corroborate, the target stays
    // honestly unresolved — no promotion, no boundary.
    expect(
      corroborateDestinations(unresolvedScope("zepto"), [
        row("https://zeptodiscounts.com/", "Zepto Discounts - Save 50% on Groceries"),
      ]),
    ).toEqual([]);
    expect(
      corroborateDestinations(unresolvedScope("examplemart"), [
        row("https://examplemartdiscounts.com/", "ExampleMart Discounts"),
      ]),
    ).toEqual([]);
  });

  it("§7 credibility: the EXACT brand label self-claims alone (unsquattable)", () => {
    // examplemart.com is the label itself, not a padded lookalike — the
    // title self-claim stands on its own, no second host required.
    expect(
      corroborateDestinations(unresolvedScope("examplemart"), [
        row("https://examplemart.com/deals", "ExampleMart - Official Deals Page"),
      ]),
    ).toEqual([{ phrase: "examplemart", host: "examplemart.com" }]);
  });

  it("§7 credibility: a padded family corroborated by 2+ hosts verifies", () => {
    // zeptonow.com + zeptonow.in (padded family, distinct registrable
    // hosts) is real multi-site identity — mirrors the first vector above.
    expect(
      corroborateDestinations(unresolvedScope("examplemart"), [
        row("https://examplemartnow.com/", "ExampleMart - Groceries in Minutes"),
        row("https://examplemartnow.in/", "ExampleMart | Quick Delivery"),
      ]),
    ).toEqual([{ phrase: "examplemart", host: "examplemartnow.com" }]);
  });

  it("multi-word brand verifies through the spaced title boundary", () => {
    const v = corroborateDestinations(unresolvedScope("the north face"), [
      row("https://www.thenorthface.com/en-in", "The North Face® Official Site | India"),
    ]);
    expect(v).toEqual([{ phrase: "the north face", host: "thenorthface.com" }]);
  });

  it("targets the law already resolved are never re-decided here", () => {
    const scope: TaskScope = {
      intent: "operate",
      targets: [
        { phrase: "amazon.in", state: "resolved", host: "amazon.in", url: "", candidates: [], provenance: "explicit_domain" },
      ],
      excludedPhrases: [],
      authorizedHosts: [],
    };
    expect(corroborateDestinations(scope, [row("https://amazon.in/dp/1", "Amazon.in: Buy Online")])).toEqual([]);
  });
});

/* ── §7 propagation: verified destination → ENFORCEABLE boundary ──────── */

describe("applyVerifiedDestinations folds credibility into the scope law", () => {
  it("a credible verified host resolves the target and arms the boundary", () => {
    const scope = unresolvedScope("zepto");
    const out = applyVerifiedDestinations(scope, [{ phrase: "zepto", host: "zeptonow.com" }]);
    expect(out).not.toBe(scope);
    expect(out.targets[0]).toEqual({
      phrase: "zepto",
      state: "resolved",
      host: "zeptonow.com",
      url: "",
      candidates: [],
      provenance: "resolved_search",
    });
    expect(scopeHosts(out)).toEqual(["zeptonow.com"]); // applyScopeToLaw will arm this
    expect(scope.targets[0].state).toBe("unresolved"); // input scope untouched
  });

  it("research intent is NEVER promoted (scope law stays ordering-only)", () => {
    const scope: TaskScope = {
      intent: "research",
      targets: [{ phrase: "zepto", state: "unresolved", host: "", url: "", candidates: [], provenance: "none" }],
      excludedPhrases: [],
      authorizedHosts: [],
    };
    expect(applyVerifiedDestinations(scope, [{ phrase: "zepto", host: "zeptonow.com" }])).toBe(scope);
  });

  it("an already-resolved target is never re-decided by search evidence", () => {
    const scope: TaskScope = {
      intent: "operate",
      targets: [
        { phrase: "amazon.in", state: "resolved", host: "amazon.in", url: "", candidates: [], provenance: "explicit_domain" },
      ],
      excludedPhrases: [],
      authorizedHosts: [],
    };
    expect(applyVerifiedDestinations(scope, [{ phrase: "amazon.in", host: "hijacked.example" }])).toBe(scope);
  });
});

/* ── affinity (fusion order boost) ─────────────────────────────────────── */

function raw(url: string, engine: string, rank: number): RawSearchResult {
  return { title: "t", url, snippet: "s", engine, rank };
}

function fusedOrder(flat: RawSearchResult[], queries?: string[]): string[] {
  return reciprocalRankFuse(flat, undefined, "general", undefined, queries).map((r) => r.domain);
}

describe("host↔query-token affinity (bare brand queries, order-only)", () => {
  const zeptoPool = [
    raw("https://timesofindia.indiatimes.com/zepto/news", "ddg", 1),
    raw("https://economictimes.com/zepto/funding", "ddg", 2),
    raw("https://en.wikipedia.org/wiki/Zepto", "ddg", 3),
    raw("https://www.business-standard.com/zepto", "ddg", 4),
    raw("https://www.moneycontrol.com/news/zepto", "ddg", 5),
    raw("https://zeptonow.com/", "ddg", 6),
    raw("https://zeptonow.in/", "ddg", 7),
  ];

  it("without affinity, bare-brand SERP order puts news first", () => {
    const before = fusedOrder(zeptoPool);
    expect(before[0]).toBe("timesofindia.indiatimes.com");
    expect(before.indexOf("zeptonow.com")).toBeGreaterThan(2);
  });

  it("with affinityQueries, the brand's own site lands first (df-rare token)", () => {
    const after = fusedOrder(zeptoPool, ["zepto prices"]);
    expect(after[0]).toBe("zeptonow.com");
  });

  it("media-amazon.com leads with 'media', so it never absorbs an 'amazon' query", () => {
    const pool = [
      raw("https://www.media-amazon.com/", "ddg", 1),
      raw("https://www.timesofindia.com/amazon", "ddg", 2),
      raw("https://economictimes.com/amazon", "ddg", 3),
      raw("https://en.wikipedia.org/wiki/Amazon", "ddg", 4),
      raw("https://www.myntra.com/", "ddg", 5),
      raw("https://www.amazon.in/", "ddg", 6),
    ];
    expect(fusedOrder(pool)[0]).toBe("media-amazon.com");
    expect(fusedOrder(pool, ["amazon delivery offers"])[0]).toBe("amazon.in");
  });

  it("generic words from the query never fire the boost (df gate + guard)", () => {
    const pool = [
      raw("https://topmart.com/deals", "ddg", 1),
      raw("https://brightcart.com/", "ddg", 2),
      raw("https://freshbasket.com/", "ddg", 3),
      raw("https://quickkart.com/", "ddg", 4),
      raw("https://dailyneeds.com/", "ddg", 5),
      raw("https://topdealsbazaar.com/", "ddg", 6), // lead starts with the generic "top"
    ];
    // "top" is a guard word AND heads multiple pool domains (high df):
    // excluded either way — order must be untouched.
    expect(fusedOrder(pool, ["top deals"])).toEqual(fusedOrder(pool));
  });
});

/* ── system local context (user's machine IS the user's context) ──────── */

function withSystemIntl(locale: string, timeZone: string, fn: () => void): void {
  const spy = vi
    .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
    .mockReturnValue({ locale, timeZone, calendar: "gregory", numberingSystem: "latn" } as Intl.ResolvedDateTimeFormatOptions);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

const decision: SearchDecision = {
  search_required: true,
  reason: "",
  freshness: "any",
  depth: "standard",
  queries: [],
};

describe("system local context (local-context + planner-law fallback)", () => {
  it("coarse region name and local date-time line come from the system Intl", () => {
    withSystemIntl("en-IN", "Asia/Kolkata", () => {
      expect(systemRegionName()).toBe("India");
      const line = localContextLine(new Date("2026-11-04T06:00:00Z"));
      expect(line).toContain("Asia/Kolkata");
      expect(line).toContain("en-IN");
      expect(line).toContain("2026-11-04"); // local en-CA calendar date
    });
  });

  it("a LOCAL-intent prompt naming no place falls back to the system country", () => {
    withSystemIntl("en-IN", "Asia/Kolkata", () => {
      expect(derivePlannerLaw("best restaurants nearby", decision).location).toBe("India");
      // non-local prompts stay place-less — the fallback is intent-gated
      expect(derivePlannerLaw("how do exceptions work in Kubernetes", decision).location).toBeNull();
    });
  });

  it("an explicit place in the prompt always wins over the system fallback", () => {
    withSystemIntl("en-IN", "Asia/Kolkata", () => {
      expect(derivePlannerLaw("weather in Pune", decision).location).toBe("Pune");
    });
  });
});
