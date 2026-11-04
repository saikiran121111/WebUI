/**
 * P4 evidence-gap recovery law — the serpCoversQuery predicate.
 *
 * The recovery wiring in runGeneralWebSearch / runGeneralWebSearchSharded
 * is three lines of "ask the next provider unless this SERP is grounded";
 * the decision itself lives entirely in serpCoversQuery, so that is what
 * gets pinned here. (Mocking the same module's googleSearch/braveSearch
 * from inside its own test is not possible with vi.mock semantics, and
 * stubbing net.ts to drive the wiring re-tests the fetch layer instead of
 * the law — skip: the wiring is typechecked and review-visible.)
 *
 * Law (mirrors query-planner.evaluateCoverage): grounded = at least HALF
 * of the query's content words (length > 2, stop-words excluded) appear
 * somewhere in the provider's title/snippet/URL text. Vocabulary
 * self-overlap only — no brand/domain table, no URL template, no genre
 * list, no magic phrase (universal-search law from the repair brief).
 */
import { describe, it, expect } from "vitest";
import { serpCoversQuery } from "@/lib/web-search/engines";
import type { RawSearchResult } from "@/lib/web-search/types";

function r(title: string, url: string, snippet: string): RawSearchResult {
  return { title, url, snippet, engine: "google", rank: 1 };
}

describe("serpCoversQuery — evidence-gap recovery predicate (P4)", () => {
  it("empty results never count as an answered query", () => {
    expect(serpCoversQuery("arborworks quarterly revenue report", [])).toBe(false);
  });

  it("a query with no content words is unjudgeable → benefit of the doubt", () => {
    // every token is a stop-word (GAP_STOPWORDS mirror) or ≤2 chars —
    // nothing to match against, so the provider gets the benefit of the
    // doubt instead of a forced fall-through
    const junk = [r("Accept cookies", "https://example.invalid/consent", "Continue to site")];
    expect(serpCoversQuery("who is it for", junk)).toBe(true);
    expect(serpCoversQuery("a an the of in on", junk)).toBe(true);
  });

  it("a fully grounded SERP answers (no recovery)", () => {
    const results = [
      r("ArborWorks — Investor Relations", "https://arborworks.invalid/ir", "quarterly revenue report downloads"),
      r("ArborWorks Q3 revenue report", "https://news.invalid/arborworks-q3", "the revenue report shows growth"),
    ];
    expect(serpCoversQuery("arborworks quarterly revenue report", results)).toBe(true);
  });

  it("a consent-wall junk SERP for the SAME query never answers (recovery fires)", () => {
    // same query as above, zero content-word overlap with the SERP text
    const wall = [
      r("Accept all cookies", "https://consent.example.invalid/", "Continue to website"),
      r("Sign in to continue", "https://login.example.invalid/", "Enter your credentials"),
    ];
    expect(serpCoversQuery("arborworks quarterly revenue report", wall)).toBe(false);
  });

  it("coverage boundary: exactly half grounds the answer, below half does not", () => {
    const query = "quarterly revenue report earnings"; // 4 content terms
    const half = [r("Quarterly Revenue overview", "https://a.invalid", "summary page")];
    expect(serpCoversQuery(query, half)).toBe(true); // 2/4 = 0.5 → grounded
    const below = [r("Quarterly snapshot", "https://a.invalid", "brief note")];
    expect(serpCoversQuery(query, below)).toBe(false); // 1/4 → gap
  });

  it("stop-words and short tokens never count toward coverage", () => {
    // content terms: price, acme, q900, now ("what", "is", "the", "of"
    // excluded — GAP_STOPWORDS mirror); acme + q900 hit → 2/4 = 0.5
    const results = [
      r("Acme Q900", "https://acme.invalid/q900", "official product page"),
    ];
    expect(serpCoversQuery("what is the price of acme q900 now", results)).toBe(true);
  });

  it("matching is case-insensitive and punctuation-tolerant on the query side", () => {
    const results = [r("Boreal Migration Study", "https://boreal.invalid/study", "full paper PDF")];
    expect(serpCoversQuery('"BOREAL" migration — study!', results)).toBe(true);
  });

  it("URL text counts toward grounding, not just title/snippet", () => {
    const results = [r("Home", "https://example.invalid/boreal-migration-study", "welcome")];
    expect(serpCoversQuery("boreal migration study", results)).toBe(true);
  });

  it("one grounded result in a mixed SERP is enough (any result may carry the fact)", () => {
    const results = [
      r("Unrelated navigation page", "https://x.invalid/nav", "links links links"),
      r("Boreal migration routes 2025", "https://y.invalid/routes", "map of the boreal migration"),
    ];
    expect(serpCoversQuery("boreal migration routes", results)).toBe(true);
  });
});
