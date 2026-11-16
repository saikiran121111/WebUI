/**
 * F05 (2026-11-15 brief, items 1 and 2) - symbol-bearing identifiers are
 * IDENTITY, not noise that normalizes away.
 *
 * Reproduced on the code as it stood before this fix:
 *   queryCoreTokens("C++ vs C")                        -> ["c"]
 *   meetsLexicalThreshold("The C programming language",
 *       queryCoreTokens("C++ memory model"))           -> true
 * i.e. C++ and C# both collapsed to the bare stem "c", so C-language text
 * "confirmed" a C++ question (and vice versa). That is a lexical coincidence
 * presented as topical support, which is exactly what the brief calls
 * "lexical signals mistaken for semantics".
 *
 * The law now encoded in lib/web-search/normalization.ts: a "+"/"#" modifier
 * run belongs to the identifier, and only the NEUTRAL separators . _ - and
 * the apostrophe generate alternate spellings. The earned tolerance survives
 * ("next.js" <-> "nextjs", "O'Brien" <-> "obrien"), while "c"
 * and "c++" can no longer answer for one another in either direction.
 *
 * Positive controls at the bottom keep the pre-existing SS5b/SS5e laws
 * (substring coincidences, empty core sets, dotted names, non-Latin scripts
 * with combining marks) pinned.
 */
import { describe, it, expect } from "vitest";

import {
  identityShapes,
  identityForms,
  foldIdentityToken,
  wordIdentityForms,
  splitCoreWords,
} from "../../lib/web-search/normalization";
import {
  queryCoreTokens,
  meetsLexicalThreshold,
  countLexicallyRelevant,
} from "../../lib/web-search/metasearch";
import { tokenize } from "../../lib/web-search/reranker";

const res = (title: string, snippet = "", url = "https://example.com/x") => ({
  title,
  snippet,
  url,
});

describe("identifier shapes keep their symbols", () => {
  it("C++, C# and C are three different identifiers", () => {
    expect(identityShapes("C++", "none")).toEqual(["c++"]);
    expect(identityShapes("C#", "none")).toEqual(["c#"]);
    expect(identityShapes("C", "none")).toEqual(["c"]);
    expect(identityShapes("C++ and F# code", "none")).toEqual([
      "c++",
      "and",
      "f#",
      "code",
    ]);
  });

  it("the query side keeps the modifier run", () => {
    expect(queryCoreTokens("C++ versus C# versus C")).toEqual(["c++", "c#", "c"]);
    expect(queryCoreTokens("F# and f#")).toEqual(["f#"]);
  });

  it("keepDots still decides whether a dotted name stays one token", () => {
    expect(splitCoreWords("next.js 15", { keepDots: true })).toEqual(["next.js", "15"]);
    expect(splitCoreWords("next.js 15", { keepDots: false })).toEqual(["next", "js", "15"]);
  });
});

describe("cross-identity matching is impossible in either direction", () => {
  it("C-language prose cannot confirm a C++ question", () => {
    const core = queryCoreTokens("C++ memory model");
    expect(core).toEqual(["c++", "memory", "model"]);
    expect(meetsLexicalThreshold("The C programming language is small", core)).toBe(false);
    expect(
      countLexicallyRelevant([res("The C programming language")], "C++ memory model"),
    ).toBe(0);
  });

  it("and a C++ page is not evidence about bare C either", () => {
    expect(meetsLexicalThreshold("C++ templates and RAII", ["c"])).toBe(false);
  });

  it("the mention set keeps every addressable spelling and drops only neutral punctuation", () => {
    expect([...wordIdentityForms("next.js app")]).toEqual(
      expect.arrayContaining(["next.js", "nextjs", "next", "js", "app"]),
    );
    expect(wordIdentityForms("C++")).toContain("c++");
    expect(wordIdentityForms("C++")).not.toContain("c");
    expect(identityForms("o-brien")).toEqual(
      expect.arrayContaining(["o-brien", "obrien", "o", "brien"]),
    );
    expect(foldIdentityToken("next.js")).toBe("nextjs");
    expect(foldIdentityToken("c++")).toBe("c++");
  });

  it("apostrophe/hyphen tolerance survives WITHOUT becoming substring matching", () => {
    const core = queryCoreTokens("obrien app-router");
    const name = "O" + String.fromCharCode(39) + "Brien";
    expect(core).toEqual(["obrien", "app", "router"]);
    expect(meetsLexicalThreshold(name + " App-Router docs", core)).toBe(true);
    expect(meetsLexicalThreshold("trust router only", core)).toBe(false);
  });

  it("shapes are not aliases: cpp is not c++ (documented limitation)", () => {
    expect(meetsLexicalThreshold("cpp reference", ["c++"])).toBe(false);
  });
});

describe("the BM25 reranker tokenizer sees the same identifiers", () => {
  it("C++ and F# survive instead of shattering into dropped single letters", () => {
    const t = tokenize("C++ and F# code");
    expect(t).toEqual(expect.arrayContaining(["c++", "f#", "code"]));
    expect(t).not.toContain("c");
    expect(t).not.toContain("f");
  });

  it("dotted names still fall to their parts at the length filter", () => {
    expect(tokenize("next.js routing")).toEqual(expect.arrayContaining(["js", "routing"]));
  });
});

describe("positive controls - the pre-existing language laws still hold", () => {
  it("substring coincidence never establishes relevance", () => {
    expect(meetsLexicalThreshold("Trust fund.", queryCoreTokens("rust memory"))).toBe(false);
    expect(countLexicallyRelevant([res("Trust fund.")], "rust memory")).toBe(0);
  });

  it("an empty core set establishes nothing", () => {
    expect(queryCoreTokens("the best top new")).toEqual([]);
    expect(meetsLexicalThreshold("anything", [])).toBe(false);
    expect(countLexicallyRelevant([res("Whatever"), res("Else")], "the best top new")).toBe(0);
  });

  it("combining marks stay inside their word on both sides", () => {
    const toks = queryCoreTokens("मुंबई चाट");
    expect(toks).toEqual(["मुंबई", "चाट"]);
    expect(meetsLexicalThreshold("मुंबई स्ट्रीट चाट", toks)).toBe(true);
  });

  it("dotted technical names still join across the boundary", () => {
    const toks = queryCoreTokens("next.js routing");
    expect(toks).toEqual(["next.js", "routing"]);
    expect(meetsLexicalThreshold("NextJS routing for pages", toks)).toBe(true);
    expect(meetsLexicalThreshold("the next js router", toks)).toBe(false);
  });
});
