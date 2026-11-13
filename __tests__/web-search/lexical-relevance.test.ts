/**
 * §5b (2026-11-13 brief) — lexical-relevance honesty laws (TS-only; the
 * ruke-websearch Rust mirror was retired 2026-11-03, no counterpart here):
 *
 *   1. Substring coincidence must NOT establish relevance: the current
 *      gate matched core tokens with `text.includes(token)`, so the query
 *      "rust memory" accepted a result whose ONLY overlap was "Trust"
 *      (it contains the substring "rust"). Matching must be
 *      whole-token (punctuation-join tolerant, substring blind).
 *   2. An empty core-token set must NOT report every result as relevant:
 *      zero comparison tokens proves nothing, so zero relevance is
 *      ESTABLISHED — "unknown" is not "relevant". (The metasearch fusion
 *      starvation guard separately keeps an unfiltered POOL when there
 *      are no anchors at all; keeping a pool under a guard is not a
 *      claim of relevance, and pipeline.ts's recovery pass is the
 *      honest response to an unverifiable anchor.)
 *   3. Counterexamples for every changed heuristic: whole-word mentions,
 *      dotted technical names ("next.js" ⇔ "nextjs"), and hyphenated
 *      compounds must still count — the fix is boundary matching, not
 *      stricter literalism.
 *
 * Brief reproduction strings live in THIS test file only, never in
 * production code (no production exceptions for brief examples).
 */
import { describe, it, expect } from "vitest";

import {
  queryCoreTokens,
  meetsLexicalThreshold,
  countLexicallyRelevant,
} from "../../lib/web-search/metasearch";

const res = (title: string, snippet = "", url = "https://example.com/x") => ({
  title,
  snippet,
  url,
});

describe("substring coincidence never establishes relevance", () => {
  it("brief reproduction: 'rust memory' does not accept 'Trust fund.'", () => {
    const toks = queryCoreTokens("rust memory");
    expect(toks).toEqual(["rust", "memory"]);
    expect(meetsLexicalThreshold("Trust fund.", toks)).toBe(false);
    expect(countLexicallyRelevant([res("Trust fund.")], "rust memory")).toBe(0);
  });

  it("the trap repeats in every field: snippet and URL path segments", () => {
    expect(
      countLexicallyRelevant(
        [res("Deposits", "a trust fund explainer", "https://trust.gov/funds")],
        "rust memory",
      ),
    ).toBe(0);
  });

  it("more substring traps: embedded words never count as mentions", () => {
    const toks = queryCoreTokens("class diagram");
    expect(toks).toEqual(["class", "diagram"]);
    // "classic" contains "class", "diagrammatic" contains "diagram" —
    // each is a substring coincidence, not a mention.
    expect(meetsLexicalThreshold("classic results", toks)).toBe(false);
    expect(meetsLexicalThreshold("diagrammatic overview", toks)).toBe(false);
  });
});

describe("counterexamples: real mentions still count (boundary matching, not literalism)", () => {
  it("whole-word mentions match, including inside URL host/paths", () => {
    const toks = queryCoreTokens("rust memory");
    expect(meetsLexicalThreshold("Rust memory allocation in rustc", toks)).toBe(true);
    expect(
      countLexicallyRelevant(
        [res("Rust memory allocation", "in rustc", "https://rust-lang.org")],
        "rust memory",
      ),
    ).toBe(1);
  });

  it("dotted technical names still join across the boundary", () => {
    const toks = queryCoreTokens("next.js routing");
    expect(toks).toEqual(["next.js", "routing"]);
    expect(meetsLexicalThreshold("NextJS routing for pages", toks)).toBe(true);
    expect(meetsLexicalThreshold("the next js router", toks)).toBe(false); // "next" alone ≠ "next.js"
  });

  it("hyphenated compounds count as their constituent words", () => {
    const toks = queryCoreTokens("app router");
    expect(toks).toEqual(["app", "router"]);
    expect(meetsLexicalThreshold("App-Router docs", toks)).toBe(true);
  });
});

describe("an empty core-token set establishes nothing", () => {
  it("no core tokens ⇒ zero results are RELEVANT (unknown ≠ relevant)", () => {
    // Every anchor token is a meta-stopword: there is no subject to
    // verify, so reporting "all relevant" (the old behavior) fabricated
    // confidence and silenced the pipeline's recovery pass.
    expect(queryCoreTokens("the best top new")).toEqual([]);
    expect(countLexicallyRelevant([res("Whatever"), res("Else")], "the best top new")).toBe(0);
  });

  it("an empty token list passed directly proves no relevance", () => {
    expect(meetsLexicalThreshold("anything at all", [])).toBe(false);
  });
});
