/**
 * Vectors for the 2026-11-04 pivot (user: "zepto should search zepto...
 * nothing hard coded, it should be universal... take the current location/
 * time from the user system... send all these current things to ai").
 *
 * Three universal mechanisms, all evidence-driven — no brand table, no
 * website list, no TLD guessing anywhere in this file's law:
 *   1. destination AFFINITY (planner-law, §4c 2026-11-13 re-anchoring): a
 *      target the equality-only TaskScope law leaves unresolved STAYS
 *      unresolved — self-claiming titles only ever ORDER results (the
 *      preferredDomains boost). Title-lead + ONE label family earns the
 *      boost; it never proves identity, and a lone self-claim is one
 *      voice, not corroboration (the old two-signal "verified
 *      destination" fold retired with applyVerifiedDestinations).
 *   2. hostname↔query-token AFFINITY boost (metasearch fusion): order-only,
 *      rarity-gated (df over the fused pool substitutes for any stopword
 *      or brand list).
 *   3. system local context: country/time/zone read from the local Intl
 *      runtime, fed to the planner law (location fallback) and the gate
 *      prompt (line added after the date — existing prefix pins hold).
 */
import { describe, expect, it, vi } from "vitest";
import { destinationAffinities, derivePlannerLaw } from "../../lib/web-search/planner-law";
import { reciprocalRankFuse } from "../../lib/web-search/metasearch";
import { localContextLine, systemRegionName } from "../../lib/web-search/local-context";
import { type TaskScope } from "../../lib/decision/task-scope";
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

describe("destination affinity from self-claiming title evidence (audit items 3/5, §4c: ORDERING ONLY — never resolves)", () => {
  it("brand≠domain earns the ordering boost when title AND label family agree", () => {
    // Zepto/zeptonow.com: the brand word is not the domain word, yet the
    // sites speak for themselves (leading title + label prefix). The two
    // zeptonow hosts share ONE label family, so the boost is unambiguous.
    // §4c: this orders zeptonow.com up via preferredDomains; the target
    // itself stays unresolved unless resolveTarget's URL-equality law
    // matches it against real retrieval candidates.
    const v = destinationAffinities(unresolvedScope("zepto"), [
      row("https://zeptonow.com/instant-grocery", "Zepto - India's Fastest Grocery Delivery"),
      row("https://zeptonow.in/", "Zepto | Quick Grocery in Minutes"),
    ]);
    expect(v).toEqual([{ phrase: "zepto", host: "zeptonow.com" }]);
  });

  it("title-leading coverage from an unrelated label NEVER verifies", () => {
    // timesofindia/economictimes TITLES lead with the brand — third-party
    // coverage, not the destination itself.
    const v = destinationAffinities(unresolvedScope("zepto"), [
      row("https://timesofindia.indiatimes.com/zepto-expands", "Zepto expands to 100 new cities"),
      row("https://economictimes.com/zepto-raises", "Zepto raises Series H round"),
    ]);
    expect(v).toEqual([]);
  });

  it("label-prefix resemblance without a self-claiming title NEVER verifies", () => {
    const v = destinationAffinities(unresolvedScope("zepto"), [
      row("https://zeptodiscounts.com/", "Save 50% on groceries near you"),
      row("https://zepto-sale.info/", "Best grocery coupons online"),
    ]);
    expect(v).toEqual([]);
  });

  it("two self-claiming label families = honest ambiguity = nothing verified", () => {
    // A squatter loudly titling itself "Zepto..." earns exactly the
    // ambiguity that protects the real destination from a wrong guess.
    const v = destinationAffinities(unresolvedScope("zepto"), [
      row("https://zeptonow.com/", "Zepto - Quick Delivery"),
      row("https://zeptodiscounts.com/", "Zepto Discounts - Daily Deals"),
    ]);
    expect(v).toEqual([]);
  });

  it("§4c: a LONE padded-label self-claim earns ORDERING, same as an exact claim", () => {
    // DOCUMENTED FLIP of the 2026-11-05 "§7 credibility" pin. The old law
    // treated a lone padded family as too weak to VERIFY identity — but §4c
    // retired identity-by-title entirely: a title self-claim is ONE VOICE
    // whoever the label is (the one-voice fallacy the mutual-corroboration
    // gate rested on). Padded and exact labels are therefore treated the
    // SAME for ordering, and neither ever resolves or walls off outside
    // sources — an ambiguous or squatter label just gets a boost that
    // retrieval still outranks.
    expect(
      destinationAffinities(unresolvedScope("zepto"), [
        row("https://zeptodiscounts.com/", "Zepto Discounts - Save 50% on Groceries"),
      ]),
    ).toEqual([{ phrase: "zepto", host: "zeptodiscounts.com" }]);
    expect(
      destinationAffinities(unresolvedScope("examplemart"), [
        row("https://examplemartdiscounts.com/", "ExampleMart Discounts"),
      ]),
    ).toEqual([{ phrase: "examplemart", host: "examplemartdiscounts.com" }]);
  });

  it("§7 credibility: the EXACT brand label self-claims alone (unsquattable)", () => {
    // examplemart.com is the label itself, not a padded lookalike — the
    // title self-claim stands on its own, no second host required.
    expect(
      destinationAffinities(unresolvedScope("examplemart"), [
        row("https://examplemart.com/deals", "ExampleMart - Official Deals Page"),
      ]),
    ).toEqual([{ phrase: "examplemart", host: "examplemart.com" }]);
  });

  it("§7 credibility: a padded family corroborated by 2+ hosts verifies", () => {
    // zeptonow.com + zeptonow.in (padded family, distinct registrable
    // hosts) is real multi-site identity — mirrors the first vector above.
    expect(
      destinationAffinities(unresolvedScope("examplemart"), [
        row("https://examplemartnow.com/", "ExampleMart - Groceries in Minutes"),
        row("https://examplemartnow.in/", "ExampleMart | Quick Delivery"),
      ]),
    ).toEqual([{ phrase: "examplemart", host: "examplemartnow.com" }]);
  });

  it("multi-word brand verifies through the spaced title boundary", () => {
    const v = destinationAffinities(unresolvedScope("the north face"), [
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
    expect(destinationAffinities(scope, [row("https://amazon.in/dp/1", "Amazon.in: Buy Online")])).toEqual([]);
  });
});

/* ── §4c (2026-11-13): applyVerifiedDestinations RETIRED ──────────────────
 * The fold that promoted a "verified destination" into a RESOLVED target
 * (and thereby armed the mandatory boundary) is deleted: title evidence
 * never proves identity, and the mutual-corroboration gate it leaned on
 * was the one-voice fallacy (two pages from one label family are one
 * voice). destinationAffinities output is consumed ONLY as preferredDomains
 * ordering in the pipeline; an unresolved target stays unresolved unless
 * resolveTarget's URL-equality law matches a real retrieval candidate.
 * "Already-resolved targets are never re-decided by search evidence" stays
 * pinned above via the destinationAffinities amazon.in leg (returns []).
 */

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
