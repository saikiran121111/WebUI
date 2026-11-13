/**
 * §5e (2026-11-13 brief) — shared language-aware normalization.
 *
 * Confirmed defects (read 2026-11-13): the QUERY-side splitters were
 * ASCII-only while the TEXT-side matcher (`mentionTokenSet`, WORD_SHAPE_RE
 * \p{L}\p{N}) and the reranker tokenizer (2026-11-04 audit) are Unicode-
 * aware. Every Telugu/Devanagari/Japanese/Cyrillic query therefore produced
 * an EMPTY core-token set, which the §5b law honestly converts into
 * "zero relevant results" — honest, but useless: the vertical engines
 * (Wikipedia/HN/arXiv/SE) rejected every one of their own results and the
 * recovery pass got an empty keyword query. Three loci:
 *   - metasearch.queryCoreTokens:  [^a-z0-9\s.] + length>2 + bare numerals
 *   - pipeline.stripFillers:       [^a-z0-9\s]  + length>2
 *   - query-planner gap-word path: [^a-z0-9\s]  + length>2
 *
 * Laws pinned here (generalizations, not per-example patches):
 *   1. Script erasure is not normalization: every script's letters, numbers
 *      and combining marks survive; the splitter matches the matcher.
 *   2. Raw code-unit length is not a word-likeness measure: "C"/"Go"/one
 *      Han char are real content; 2-letter English function words belong on
 *      the stop-list EXPLICITLY, not smuggled through an implicit length
 *      filter. (Counterexample to over-correction pinned: contraction
 *      artifacts must not resurrect as content tokens.)
 *   3. Numbers are content (identifiers/versions/quantities): a stop-list
 *      that drops "100" while retaining "101" is incoherent — both stay.
 *   4. §5b laws stay intact (positive controls): empty core set proves
 *      nothing, substring coincidence is not a mention, ASCII content
 *      tokens behave byte-identically.
 *   5. Cross-script ≠ mention: a Telugu query matches Telugu text, never a
 *      Latin transliteration or a Japanese passage. CJK runs are NOT word-
 *      segmented (documented limitation pinned honestly, same shortcut the
 *      reranker documents) — the char/phrase-level fallback beats an empty
 *      token set, it does not claim CJK word segmentation.
 *
 * Test strings live in THIS file only; no production exceptions. Novel
 * entities/scripts, not the brief's example strings.
 */
import { describe, it, expect } from "vitest";

import {
  queryCoreTokens,
  meetsLexicalThreshold,
  countLexicallyRelevant,
} from "../../lib/web-search/metasearch";
import { stripFillers } from "../../lib/web-search/pipeline";

const res = (title: string, snippet = "", url = "https://example.com/x") => ({
  title,
  snippet,
  url,
});

describe("law 1 — script erasure is not normalization: query-side splitter matches the text-side matcher", () => {
  it("Telugu query keeps its words (was: empty token set ⇒ every vertical result rejected)", () => {
    const toks = queryCoreTokens("ఉత్తమ ఐస్క్రీమ్ హైదరాబాద్");
    expect(toks).toContain("ఐస్క్రీమ్");
    expect(toks).toContain("హైదరాబాద్");
  });

  it("Devanagari combining marks stay INSIDE the token (matra must not split the word)", () => {
    const toks = queryCoreTokens("मुंबई में चाट स्टॉल");
    expect(toks).toContain("मुंबई");
    expect(toks).toContain("चाट");
  });

  it("Cyrillic query lowercases and survives (no stop-word smuggling: untranslated function words stay as content)", () => {
    const toks = queryCoreTokens("лучшие кофейни Казани");
    expect(toks).toContain("кофейни");
    expect(toks).toContain("казани");
  });

  it("CJK query yields char/phrase tokens instead of nothing (graceful fallback, not claimed word segmentation)", () => {
    const toks = queryCoreTokens("東京タワー 営業時間");
    expect(toks).toEqual(["東京タワー", "営業時間"]);
  });
});

describe("law 2 — short entities survive; function words die on the stop-list, not on length", () => {
  it('"Go" and "C" are real entities', () => {
    expect(queryCoreTokens("Go vs C concurrency")).toEqual(["go", "c", "concurrency"]);
  });

  it("counterexample to over-correction: contraction artifacts must not resurrect as content tokens", () => {
    // With no length filter, "don't → don"+"t" or "what's → what"+"s" would
    // inject junk. The apostrophe folds BEFORE splitting so contractions
    // land on the (extended) stop-list instead.
    expect(queryCoreTokens("what's it's don't")).toEqual([]);
    expect(queryCoreTokens("don’t you do it")).toEqual([]);
  });

  it("ASCII content tokens behave byte-identically (§5b control)", () => {
    expect(queryCoreTokens("rust memory")).toEqual(["rust", "memory"]);
    expect(queryCoreTokens("class diagram")).toEqual(["class", "diagram"]);
  });
});

describe("law 3 — numbers are content: dropping 100 while retaining 101 is incoherent", () => {
  it("bare numerals all survive, consistently", () => {
    expect(queryCoreTokens("ios 100 vs ios 101")).toEqual(["ios", "100", "101"]);
  });

  it("version numbers are query identity, not meta-noise", () => {
    expect(queryCoreTokens("next.js 15 app router")).toEqual([
      "next.js",
      "15",
      "app",
      "router",
    ]);
  });
});

describe("law 4 — end-to-end symmetry: a non-Latin query can actually pass its own gate", () => {
  it("Telugu query matches Telugu text; Latin transliteration and foreign-script passages never count as mentions", () => {
    const toks = queryCoreTokens("హైదరాబాద్ ఐస్క్రీమ్");
    expect(toks.length).toBeGreaterThan(0);
    expect(meetsLexicalThreshold("ఐస్క్రీమ్ హైదరాబాద్ లో ఉంది", toks)).toBe(true);
    // Honest limitation pin: translation is NOT matching.
    expect(meetsLexicalThreshold("ice cream in Hyderabad city", toks)).toBe(false);
    expect(meetsLexicalThreshold("アイスクリーム 東京", toks)).toBe(false);
    expect(countLexicallyRelevant([res("ఐస్క్రీమ్ హైదరాబాద్")], "హైదరాబాద్ ఐస్క్రీమ్")).toBe(1);
  });

  it("the TEXT side must keep combining marks inside mention tokens too (WORD_SHAPE_RE lacked \\p{M} — the reranker's 2026-11-04 matra lesson, applied to the §5b matcher)", () => {
    const toks = queryCoreTokens("मुंबई चाट");
    expect(toks).toEqual(["मुंबई", "चाट"]);
    // Without \\p{M} in WORD_SHAPE_RE, "मुंबई" shatters into partial runs
    // at the matras and NOTHING matches — the matcher must survive the
    // same marks the splitter survives.
    expect(meetsLexicalThreshold("मुंबई स्ट्रीट चाट", toks)).toBe(true);
  });

  it("documented CJK limitation: unsegmented Han runs are single mention tokens (same shortcut the reranker documents)", () => {
    const toks = queryCoreTokens("東京 タワー");
    expect(toks).toEqual(["東京", "タワー"]);
    expect(meetsLexicalThreshold("東京 タワー 情報", toks)).toBe(true);
    // "東京タワー" without spaces is ONE mention token — no claim of CJK
    // word segmentation. Over-claiming it would be the next brittle rule.
    expect(meetsLexicalThreshold("東京タワー情報", toks)).toBe(false);
  });
});

describe("law 5 — recovery-pass keyword builder (pipeline.stripFillers) stays language-aware", () => {
  it("control: English filler stripping behavior is preserved", () => {
    expect(
      stripFillers("Tell me what is the best biryani in Manikonda Hyderabad"),
    ).toBe("biryani manikonda hyderabad");
  });

  it("Telugu prompt is not erased into an empty recovery query", () => {
    const q = stripFillers("మంచి బిర్యానీ హైదరాబాద్ లో");
    expect(q).toContain("బిర్యానీ");
    expect(q).toContain("హైదరాబాద్");
  });

  it("mixed-script prompt keeps the non-Latin content words", () => {
    expect(stripFillers("మంచి biryani in hyderabad")).toBe("మంచి biryani hyderabad");
  });

  it("empty stays empty", () => {
    expect(stripFillers("")).toBe("");
  });
});

describe("positive controls — §5b honesty laws survive the widening", () => {
  it("stop-word-only query still yields an EMPTY core set (empty proves nothing, never 'all relevant')", () => {
    expect(queryCoreTokens("the best top new")).toEqual([]);
    expect(queryCoreTokens("!!! ??? ~~")).toEqual([]);
    expect(meetsLexicalThreshold("anything at all", [])).toBe(false);
    expect(countLexicallyRelevant([res("Whatever"), res("Else")], "the best top new")).toBe(0);
  });

  it("substring coincidence still never establishes relevance", () => {
    expect(meetsLexicalThreshold("Trust fund.", queryCoreTokens("rust memory"))).toBe(false);
    expect(countLexicallyRelevant([res("Trust fund.")], "rust memory")).toBe(0);
  });

  it("dotted technical names still join across the boundary", () => {
    const toks = queryCoreTokens("next.js routing");
    expect(toks).toEqual(["next.js", "routing"]);
    expect(meetsLexicalThreshold("NextJS routing for pages", toks)).toBe(true);
  });
});
