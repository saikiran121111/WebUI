/**
 * §5g cache-key honesty (2026-11-13 brief): "Include actual retrieval-
 * affecting settings in cache keys."
 *
 * The §9 audit (2026-11-04) put query/freshness/intent/preferredDomains in
 * the query key, but the SERP that gets WRITTEN under that key is produced
 * by a pipeline whose surviving pool also depends on inputs that were not
 * part of the key:
 *
 *  - SearchPlan.relevanceAnchor feeds the fused-pool relevance floor in
 *    metasearch (per-anchor token sets decide which results reach the
 *    cached results_json; the user's original prompt is an anchor). Two
 *    turns with identical rewritten plans but different anchors would
 *    share one row: the second turn replays the FIRST turn's anchor-filtered
 *    pool and silently loses pages its own anchor would have kept.
 *  - Google's ranking region (systemGl, derived from the machine Intl
 *    locale) changes what Google contributes to the pool; the SQLite DB
 *    persists across OS-locale changes, so the region belongs in the key.
 *  - page_cache keys on bare URL today, while the stored BODY depends on
 *    the kill-switch settings: WEB_SEARCH_ADBLOCK_DISABLED (ad-ridden vs
 *    clean body) and WEB_SEARCH_BROWSER_DISABLED/AGENT_BROWSER_DISABLED
 *    (JS-rendered vs raw-DOM body). A row written under one setting must
 *    not be replayed under the other.
 *
 * Laws pinned here (and the walls against over-correction):
 *  - deterministic for identical inputs (caching still works);
 *  - plan ORDER invariance preserved; domain case/order invariance stays;
 *  - anchor case/whitespace equivalence (same normalization as queries);
 *  - fingerprints are SCOPED: adblock/browser switches change the PAGE key
 *    only (SERP unaffected); the gl region changes the QUERY key only
 *    (page bodies unaffected).
 * Novel fictional entities only; no brief example strings in tests or prod.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { SearchPlan } from "@/lib/web-search/metasearch";
import { queryCacheKey, pageCacheKey } from "@/lib/web-search/cache";

const plan = (over: Partial<SearchPlan> = {}): SearchPlan =>
  ({
    query: "vireo ledger quarterly filings",
    freshness: "any",
    intent: "general",
    preferredDomains: [],
    ...over,
  }) as SearchPlan;

const ENV_KEYS = [
  "WEB_SEARCH_ADBLOCK_DISABLED",
  "WEB_SEARCH_BROWSER_DISABLED",
  "AGENT_BROWSER_DISABLED",
] as const;

const saved: Record<string, string | undefined> = {};
beforeEnv();
function beforeEnv() {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
}
function withEnv(k: (typeof ENV_KEYS)[number], v: string | undefined, fn: () => void) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  try {
    fn();
  } finally {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("query cache key carries the plan-level relevance anchor (the §5g defect)", () => {
  it("identical plan tuples with DIFFERENT anchors get different keys", () => {
    const a = queryCacheKey([plan({ relevanceAnchor: "when did Varela Island lighthouse museum reopen" })]);
    const b = queryCacheKey([plan({ relevanceAnchor: "telugu review of the Vireo Ledger documentary" })]);
    expect(a).not.toBe(b);
  });

  it("anchored vs unanchored runs are different retrievals", () => {
    expect(queryCacheKey([plan({ relevanceAnchor: "corvus ferry tide schedule" })])).not.toBe(
      queryCacheKey([plan()]),
    );
  });

  it("anchor case/whitespace equivalence mirrors the query normalization", () => {
    const a = queryCacheKey([plan({ relevanceAnchor: "Corvus   Ferry  Tide Schedule" })]);
    const b = queryCacheKey([plan({ relevanceAnchor: "corvus ferry tide schedule" })]);
    expect(a).toBe(b);
  });

  it("identical inputs stay identical keys — caching still works (positive control)", () => {
    const plans = [
      plan({ relevanceAnchor: "vireo ledger" }),
      plan({ query: "vireo ledger auditors", relevanceAnchor: "vireo ledger auditors opinion" }),
    ];
    expect(queryCacheKey(plans)).toBe(queryCacheKey(plans.map((p) => ({ ...p }))));
  });

  it("plan ORDER invariance is preserved", () => {
    const a = queryCacheKey([
      plan({ query: "vireo ledger filings" }),
      plan({ query: "varela island museum hours" }),
    ]);
    const b = queryCacheKey([
      plan({ query: "varela island museum hours" }),
      plan({ query: "vireo ledger filings" }),
    ]);
    expect(a).toBe(b);
  });
});

describe("query cache key carries the ranking region (gl), page key must not", () => {
  it("different gl regions are different retrievals", () => {
    expect(queryCacheKey([plan()], "in")).not.toBe(queryCacheKey([plan()], "us"));
  });

  it("the default gl is deterministic within a process", () => {
    expect(queryCacheKey([plan()])).toBe(queryCacheKey([plan()]));
  });

  it("adblock/browser kill-switches do NOT poison the SERP key (scoped fingerprint)", () => {
    const base = queryCacheKey([plan()]);
    withEnv("WEB_SEARCH_ADBLOCK_DISABLED", "1", () => {
      withEnv("WEB_SEARCH_BROWSER_DISABLED", "1", () => {
        expect(queryCacheKey([plan()])).toBe(base);
      });
    });
  });
});

describe("page cache key carries the body-affecting extraction settings", () => {
  it("same URL under the same settings is a stable key (positive control)", () => {
    expect(pageCacheKey("https://varela.example/museum/visit")).toBe(
      pageCacheKey("https://varela.example/museum/visit"),
    );
  });

  it("different URLs get different keys", () => {
    expect(pageCacheKey("https://varela.example/a")).not.toBe(
      pageCacheKey("https://varela.example/b"),
    );
  });

  it("adblock kill-switch flip changes the page key (body content differs)", () => {
    const off = pageCacheKey("https://varela.example/museum/visit");
    withEnv("WEB_SEARCH_ADBLOCK_DISABLED", "1", () => {
      expect(pageCacheKey("https://varela.example/museum/visit")).not.toBe(off);
    });
  });

  it("browser pool kill-switch flip changes the page key (rendered vs raw body)", () => {
    const off = pageCacheKey("https://vireo.example/live");
    withEnv("WEB_SEARCH_BROWSER_DISABLED", "1", () => {
      expect(pageCacheKey("https://vireo.example/live")).not.toBe(off);
    });
    // the AGENT_BROWSER_DISABLED alias must be honored identically
    const alias = pageCacheKey("https://vireo.example/live");
    withEnv("AGENT_BROWSER_DISABLED", "1", () => {
      expect(pageCacheKey("https://vireo.example/live")).not.toBe(alias);
    });
  });

  it("the gl region does NOT leak into the page key (bodies are region-independent)", () => {
    // pageCacheKey takes no region argument by design; pin stability across
    // the SERP-region injection keeps the two fingerprints scoped.
    const k = pageCacheKey("https://corvus.example/ferry");
    expect(queryCacheKey([plan()], "in")).not.toBe(queryCacheKey([plan()], "zz"));
    expect(k).toBe(pageCacheKey("https://corvus.example/ferry"));
  });
});
