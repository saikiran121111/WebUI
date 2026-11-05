/**
 * AUDIT 2026-11-05 (brief item 12 / WS12) — provider recovery accepts
 * generic matches and mishandles non-Latin queries.
 *
 * Audit repro (verbatim): "An unrelated 'price guide' passes `ArborWorks
 * price` coverage. Unrelated English gardening results pass a Hindi
 * scholarship query. `focusTokens` yields no Hindi tokens." Cause:
 * "serpCoversQuery strips non-ASCII characters and accepts empty term
 * sets; 50% generic overlap also lets an absent distinguishing entity
 * pass. focusTokens has the same script limitation. The main gate
 * tokenizer is Unicode-aware already; downstream code is inconsistent."
 * Fix (verbatim): "Fix multilingual relevance and entity/relation
 * preservation across the whole path. Empty/unjudgeable tokenization is
 * unknown relevance, not success. Low-quality nonempty results must not
 * suppress another provider solely through generic-word overlap."
 *
 * Universal laws pinned here (script-structure and query-length grammar
 * only — NO language tables, NO brand/generic word lists; the Hindi
 * fixture word is a fictional entity):
 *  - tokenization is script-complete (keeps every script's letters,
 *    numbers and combining marks, mirroring the gate tokenizer): a
 *    non-Latin query gets REAL content terms so the coverage law can
 *    actually judge it — and judges its own script's SERP the same way;
 *  - empty/unjudgeable tokenization is UNKNOWN → the predicate is not
 *    success, so a junk SERP no longer suppresses the next provider
 *    (deliberate evolution of the P4 benefit-of-the-doubt expectation,
 *    see the same-run update in engines-gap-recovery.test.ts);
 *  - a query whose content terms number ≤ 3 must be FULLY covered:
 *    half of two short generic fragments is exactly the audit's
 *    "absent distinguishing entity" hole (longer queries keep the
 *    established 0.5 boundary — unchanged, pinned in the sibling file).
 */
import { describe, it, expect } from "vitest";
import { serpCoversQuery } from "@/lib/web-search/engines";
import { focusTokens } from "@/lib/web-search/route-links";
import type { RawSearchResult } from "@/lib/web-search/types";

function r(title: string, url: string, snippet: string): RawSearchResult {
  return { title, url, snippet, engine: "google", rank: 1 };
}

/* Devanagari fixture: fictional entity बोरियांक ("Boriyank") + scholarship
 * application terms — test data only, never a real brand. */
const HINDI_QUERY = "बोरियारंक छात्रवृत्ति आवेदन";

describe("WS12 — non-Latin queries are tokenized, not stripped to nothing", () => {
  it("unrelated English gardening results never pass a Hindi scholarship query", () => {
    const gardening = [
      r("Growing Tomatoes at Home", "https://garden.invalid/tomatoes", "kitchen gardening tips for vegetables and herbs"),
      r("Best Herbs for Windowsills", "https://garden.invalid/herbs", "container gardening guide for balconies"),
    ];
    // THE DEFECT: every Hindi token was stripped, terms came out EMPTY, and
    // the empty set auto-answered for the provider.
    expect(
      serpCoversQuery(HINDI_QUERY, gardening),
      "a SERP sharing zero content terms with a non-Latin query must trigger recovery, not suppress it",
    ).toBe(false);
  });

  it("control: the SAME query is covered by its own script's SERP (no language table — pure script parity)", () => {
    const hindiSerp = [
      r("बोरियारंक छात्रवृत्ति आवेदन 2026 — पात्रता", "https://scholarship.invalid/yojana", "आवेदन की अंतिम तिथि और पात्रता विवरण"),
    ];
    expect(serpCoversQuery(HINDI_QUERY, hindiSerp)).toBe(true);
  });

  it("focusTokens yields the non-Latin content words (route/pipeline/read_page path)", () => {
    const tokens = focusTokens(HINDI_QUERY + " scholarship application");
    // THE DEFECT: the ASCII-only split produced NO Hindi token at all, so
    // route ranking and read_page focus had nothing to match for.
    // (BMP range check, not \p{Devanagari}: this Node build ships without
    // ICU script properties — only general-category escapes like the
    // production \p{L}\p{N}\p{M} classes are available at runtime.)
    expect(
      tokens.some((t) => [...t].some((ch) => ch.charCodeAt(0) >= 0x0900 && ch.charCodeAt(0) <= 0x097f)),
      "Devanagari content words must survive",
    ).toBe(true);
    // Latin words keep their established length > 3 rule (noise guard).
    expect(tokens).toContain("application");
    expect(tokens).not.toContain("for");
  });
});

describe("WS12 — generic overlap cannot substitute for the distinguishing entity", () => {
  it("an unrelated price guide does not answer an entity+generic-term query", () => {
    // The generic term must appear LITERALLY ("price" is not a substring
    // of "pricing") so the fixture reproduces the audit's one-generic-hit
    // half-boundary pass rather than a vacuous zero-hit miss.
    const priceGuide = [
      r("The Ultimate Price Guide", "https://plans.invalid/price-guide", "every price tier and plan explained"),
      r("How to Compare Plans", "https://plans.invalid/compare", "which price plan suits a small team"),
    ];
    // THE DEFECT: terms = [arborworks, price]; the generic "price" hit is
    // 1/2 = the old half boundary → recovery suppressed by generic overlap.
    expect(
      serpCoversQuery("arborworks price", priceGuide),
      "an absent distinguishing entity must fire recovery",
    ).toBe(false);
  });

  it("control: the entity's own price page answers", () => {
    const answers = [
      r("ArborWorks — official price list", "https://arborworks.invalid/pricing", "current price list and tiers"),
    ];
    expect(serpCoversQuery("arborworks price", answers)).toBe(true);
  });
});

describe("WS12 — unjudgeable tokenization is unknown relevance, not success", () => {
  it("a stop-word-only query with a junk SERP no longer auto-grounds the provider", () => {
    const junk = [r("Accept cookies", "https://example.invalid/consent", "Continue to site")];
    // Deliberate law evolution (audit WS12): the P4 "benefit of the doubt"
    // TRUE on an empty term set was exactly how stripped non-Latin queries
    // passed; unknown must fall through to recovery, and the never-lose law
    // in runGeneralWebSearch still returns the priority provider's
    // non-empty results when recovery finds nothing better.
    expect(serpCoversQuery("who is it for", junk)).toBe(false);
    expect(serpCoversQuery("a an the of in on", junk)).toBe(false);
  });
});
