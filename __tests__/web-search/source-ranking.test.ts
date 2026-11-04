/**
 * P4 soft source-ranking parity suite (§11.25; ⇔ reranker.rs `mod tests`).
 * Search-policy correction 2026-11-02: weak sources (reddit/quora/wikipedia/
 * forums) are a RANKING problem, never a blocking problem. Shared prompts and
 * expectations with the Rust mirror — change one side, change both in the
 * same commit.
 */
import { describe, expect, it } from "vitest";
import {
  authorityMultiplier,
  classifySearchIntent,
  rerank,
  sourceAuthorityTier,
  type SearchIntent,
} from "../../lib/web-search/reranker";
import type { EvidencePacket } from "../../lib/web-search/types";

/** ⇔ reranker.rs tests::packet() — snippet-only seed packets. */
function packet(sourceId: string, domain: string, texts: string[]): EvidencePacket {
  return {
    sourceId,
    url: `https://${domain}/page`,
    title: `${sourceId} title`,
    domain,
    extraction: "snippet-only",
    passages: texts.map((t) => ({
      sourceId,
      url: `https://${domain}/page`,
      title: `${sourceId} title`,
      domain,
      passageText: t,
      bm25Score: 1,
    })),
  };
}

describe("soft source ranking (⇔ reranker.rs)", () => {
  it("source_tier_ladder_and_suffix_rule", () => {
    expect(sourceAuthorityTier("whitehouse.gov")).toBe("primary");
    expect(sourceAuthorityTier("defense.mil")).toBe("primary");
    expect(sourceAuthorityTier("mit.edu")).toBe("specialist");
    expect(sourceAuthorityTier("www.cam.ac.uk")).toBe("specialist"); // ".ac."
    expect(sourceAuthorityTier("arxiv.org")).toBe("specialist");
    expect(sourceAuthorityTier("docs.github.com")).toBe("specialist"); // suffix rule
    expect(sourceAuthorityTier("reuters.com")).toBe("journalism");
    expect(sourceAuthorityTier("www.bbc.co.uk")).toBe("journalism");
    // SOFT-labeled — never excluded.
    expect(sourceAuthorityTier("reddit.com")).toBe("community");
    expect(sourceAuthorityTier("old.reddit.com")).toBe("community");
    // Never banned, never auto-dominant.
    expect(sourceAuthorityTier("en.wikipedia.org")).toBe("general");
    expect(sourceAuthorityTier("example.com")).toBe("general");
    // Designated (planner-law allowed+preferred) always reads as primary.
    expect(sourceAuthorityTier("example.com", ["example.com"])).toBe("primary");
    expect(sourceAuthorityTier("de.wikipedia.org", ["wikipedia.org"])).toBe("primary");
  });

  it("intent_ladder_first_match_wins", () => {
    expect(classifySearchIntent("how do i fix this borrow error")).toBe("exp");
    // "study" outranks "history" — ladder order is the contract.
    expect(classifySearchIntent("study on the history of the transistor")).toBe("sci");
    expect(classifySearchIntent("what is a closure definition")).toBe("bkg");
    expect(classifySearchIntent("latest gdp numbers")).toBe("cur");
    expect(classifySearchIntent("gdp numbers 2024")).toBe("cur");
    expect(classifySearchIntent("gdp numbers", "week")).toBe("cur"); // band alone
    expect(classifySearchIntent("rust async runtime")).toBe("none");
    // Bare "meta" must NOT fire the game-meta intent ("metadata" FP).
    expect(classifySearchIntent("rust metadata handling")).toBe("none");
  });

  it("authority_multiplier_is_intent_aware_and_never_zero", () => {
    // Community: demoted for objective facts, promoted for experience.
    expect(authorityMultiplier("reddit.com", "none")).toBeCloseTo(0.92, 10);
    expect(authorityMultiplier("reddit.com", "exp")).toBeCloseTo(1.12, 10);
    expect(authorityMultiplier("reddit.com", "sci")).toBeCloseTo(0.8, 10);
    expect(authorityMultiplier("reddit.com", "bkg")).toBeCloseTo(1.0, 10);
    // Wikipedia: de-biased for current/disputed claims, never banned.
    expect(authorityMultiplier("en.wikipedia.org", "none")).toBeCloseTo(1.0, 10);
    expect(authorityMultiplier("en.wikipedia.org", "exp")).toBeCloseTo(1.0, 10);
    expect(authorityMultiplier("en.wikipedia.org", "sci")).toBeCloseTo(0.8, 10);
    expect(authorityMultiplier("en.wikipedia.org", "cur")).toBeCloseTo(0.85, 10);
    expect(authorityMultiplier("example.com", "sci")).toBeCloseTo(1.0, 10);
    expect(authorityMultiplier("reuters.com", "none")).toBeCloseTo(1.03, 10);
    expect(authorityMultiplier("reuters.com", "cur")).toBeCloseTo(1.08, 10);
    // Explicit user preference always wins the ladder.
    expect(authorityMultiplier("en.wikipedia.org", "sci", ["wikipedia.org"])).toBeCloseTo(1.15, 10);
    // FALLBACK LAW: every multiplier stays > 0 — nothing is ever dropped.
    const intents: SearchIntent[] = ["exp", "sci", "bkg", "cur", "none"];
    for (const d of ["reddit.com", "quora.com", "en.wikipedia.org", "arxiv.org", "reuters.com", "example.com"]) {
      for (const i of intents) {
        expect(authorityMultiplier(d, i)).toBeGreaterThan(0);
      }
    }
  });

  it("soft_ranking_moves_order_never_drops_evidence", () => {
    const txt = "the nimbus drone ships with a 40 minute battery";
    const pkts = [packet("s1", "reddit.com", [txt]), packet("s2", "arxiv.org", [txt])];

    const neutral = rerank(pkts, "nimbus drone battery", [], 15, {
      freshness: "any",
      preferredDomains: [],
    });
    // Fallback law: weak tiers are NEVER dropped.
    expect(neutral.length).toBe(2);
    expect(neutral[0].domain).toBe("arxiv.org");
    // ORDER-ONLY prior: stored bm25 bytes never shift.
    expect(neutral[0].bm25Score).toBe(neutral[1].bm25Score);

    const expOut = rerank(pkts, "anyone have real world experience with nimbus drone battery", [], 15, {
      freshness: "any",
      preferredDomains: [],
    });
    expect(expOut[0].domain).toBe("reddit.com"); // experiential intent promotes community

    const wikiPkts = [packet("s1", "en.wikipedia.org", [txt]), packet("s2", "example.com", [txt])];
    const cur = rerank(wikiPkts, "latest nimbus drone battery numbers", [], 15, {
      freshness: "any",
      preferredDomains: [],
    });
    expect(cur.length).toBe(2); // de-bias NEVER removes
    expect(cur[0].domain).toBe("example.com"); // not auto-dominant

    const designated = rerank(wikiPkts, "latest nimbus drone battery numbers", [], 15, {
      freshness: "any",
      preferredDomains: ["wikipedia.org"],
    });
    expect(designated[0].domain).toBe("en.wikipedia.org"); // explicit preference wins
  });
});
