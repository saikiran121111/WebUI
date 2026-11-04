/**
 * §11.8 / §11.10 / §11.11 — retrieval-quality SHARED VECTOR SUITE.
 *
 * Every vector table here is byte-for-byte identical to its Rust inline
 * counterpart; change one side, change both in the same commit:
 *
 *   normalizeUrl vectors ........ TS-owned (ruke-websearch retired 2026-11-03)
 *   freshnessFit band vectors ... rust types.rs `freshness_fit_shared_vectors_*`
 *   time-scoped pins ............ rust types.rs `is_time_scoped_freshness_pins`
 *   retrieval-mode pins ......... rust types.rs `retrieval_mode_for_freshness_pins`
 *   realtime wire round-trip .... rust types.rs `realtime_freshness_wire_round_trip`
 *   vertical matrix ............. rust metasearch.rs `vertical_matrix_pins_time_scoped_wiki_drop`
 *   segment filter vectors ...... rust reranker.rs `segment_filter_shared_vectors`
 *   gate prompt parity .......... direct byte comparison of BOTH source files
 *
 * The gate-prompt parity test is the cross-language lock: it reads the TS
 * and Rust source files and asserts the shared prompt bytes appear exactly
 * once in each (a one-sided prompt edit fails here, not just in goldens).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

import {
  normalizeUrl,
  verticalsForIntent,
} from "../../lib/web-search/metasearch";
import {
  freshnessFit,
  isTimeScopedFreshness,
} from "../../lib/web-search/freshness";
import {
  retrievalModeForFreshness,
  SearchDecisionSchema,
  SearchDecisionSchemaCompat,
  type EvidencePacket,
} from "../../lib/web-search/types";
import { queryCacheKey } from "../../lib/web-search/cache";
import {
  FRESH_QUERY_TTL_MS,
  REALTIME_QUERY_TTL_MS,
} from "../../lib/web-search/cache";
import {
  filterPassageSegments,
  applySegmentFilter,
} from "../../lib/web-search/segment-filter";
import { junkPenalty } from "../../lib/web-search/reranker";

/* ── normalizeUrl (TS-owned since the 2026-11-03 Rust rollback) ───────── */

describe("normalizeUrl vectors (TS-owned after the 2026-11-03 Rust rollback)", () => {
  const VECTORS: Array<[string, string]> = [
    // tracking params dropped, non-tracking kept, fragment cleared
    [
      "https://en.wikipedia.org/wiki/Foo?utm_source=x&fbclid=y&ref=z&id=5#frag",
      "https://en.wikipedia.org/wiki/Foo?id=5",
    ],
    // empty pair list → query fully removed
    ["https://example.com/p?utm_medium=m", "https://example.com/p"],
    // trailing-slash strip only when path length > 1
    ["https://example.com//", "https://example.com/"],
    ["https://www.Example.com/A/", "https://example.com/A"],
    // default port collapses via the URL parser (both sides, pinned)
    ["http://example.com:80/", "http://example.com/"],
    // URLSearchParams round-trip: a `=`-less chunk becomes `k=`, space → `+`
    ["https://example.com/?a b", "https://example.com/?a+b="],
    // invalid URLs pass through verbatim (the catch)
    ["not a url", "not a url"],
    // §11.8: `utm_` prefix strip beyond the exact list
    [
      "https://example.com/p?utm_content=a&utm_id=b&id=5",
      "https://example.com/p?id=5",
    ],
    // §11.8: mobile-subdomain collapse (`mobile.` keeps its brand host)
    ["https://m.example.com/path", "https://example.com/path"],
    ["https://amp.example.com/path", "https://example.com/path"],
    ["https://wap.example.com/path", "https://example.com/path"],
    ["https://mobile.example.com/x", "https://mobile.example.com/x"],
    // §11.8: AMP path collapse, leading segment / trailing suffix, case
    ["https://example.com/amp/story", "https://example.com/story"],
    ["https://example.com/amp", "https://example.com/"],
    ["https://example.com/AMP/Story", "https://example.com/Story"],
    ["https://example.com/x/amp", "https://example.com/x"],
    // subdomain + AMP path + tracking params together
    [
      "https://m.example.com:8080/amp/p?utm_term=t&q=1",
      "https://example.com:8080/p?q=1",
    ],
    // §6 fragment-router carve-out: SPA hash routes are DISTINCT PAGES and
    // survive the key; plain in-page anchors still collapse (vector above).
    [
      "https://example.com/app#/products/42",
      "https://example.com/app#/products/42",
    ],
    [
      "https://example.com/app#!/legacy/route",
      "https://example.com/app#!/legacy/route",
    ],
    ["https://example.com/app#section-2", "https://example.com/app"],
  ];
  for (const [input, expected] of VECTORS) {
    it(`"${input}" → "${expected}"`, () => {
      expect(normalizeUrl(input)).toBe(expected);
    });
  }

  it("Unicode/IDNA: host punycodes; path escapes and semantic params survive (§6)", () => {
    // m. subdomain collapse + /amp/ path collapse + kept `src` (semantic);
    // the punycode host and percent escapes are stable through the
    // URLSearchParams round-trip.
    expect(
      normalizeUrl("https://m.münchen.de/amp/brötchen?preis=%E2%82%AC5&src=x"),
    ).toBe("https://xn--mnchen-3ya.de/br%C3%B6tchen?preis=%E2%82%AC5&src=x");
  });
});

/* ── freshnessFit (⇔ rust types.rs shared band vectors) ────────────────── */

// 2026-06-15T00:00:00Z — the shared fixed clock (⇔ rust types.rs NOW_MS).
const NOW_MS = 1_781_481_600_000;

describe("freshnessFit shared band vectors (⇔ rust types.rs)", () => {
  const fit = (d: string, f: string) => freshnessFit(d, f, NOW_MS);

  it("week band: w=7d, boost 1.25 — tiers 1.0 / 0.7 (≤8w) / 0.5", () => {
    expect(fit("2026-06-12T00:00:00Z", "week")).toBeCloseTo(1.25, 12); //  3d, in band
    expect(fit("2026-06-08T00:00:00Z", "week")).toBeCloseTo(1.25, 12); //  exactly 7d (boundary)
    expect(fit("2026-06-20T00:00:00Z", "week")).toBeCloseTo(1.25, 12); //  future-dated
    expect(fit("2026-06-01T00:00:00Z", "week")).toBeCloseTo(1.0, 12); //   exactly 2w (boundary)
    expect(fit("2026-05-31T00:00:00Z", "week")).toBeCloseTo(0.7, 12); //  15d
    expect(fit("2026-04-20T00:00:00Z", "week")).toBeCloseTo(0.7, 12); //  exactly 8w (boundary)
    expect(fit("2026-04-19T00:00:00Z", "week")).toBeCloseTo(0.5, 12); //  57d
  });

  it("day band: w=2d, boost 1.3", () => {
    expect(fit("2026-06-14T12:00:00Z", "day")).toBeCloseTo(1.3, 12); //  0.5d
    expect(fit("2026-06-12T00:00:00Z", "day")).toBeCloseTo(1.0, 12); //  3d
    expect(fit("2026-06-10T00:00:00Z", "day")).toBeCloseTo(0.7, 12); //  5d
    expect(fit("2026-01-01T00:00:00Z", "day")).toBeCloseTo(0.5, 12); //  165d
  });

  it("realtime band: w=1d, boost 1.3 — date-only strings parse at UTC midnight", () => {
    // ⇔ rust chrono `%Y-%m-%d` fallback; V8 parses ISO date-only as UTC too.
    expect(freshnessFit("2026-06-14", "realtime", NOW_MS)).toBeCloseTo(1.3, 12); //  1d, date-only
    expect(fit("2026-06-13T00:00:00Z", "realtime")).toBeCloseTo(1.0, 12); //  exactly 2×w
    expect(fit("2026-06-11T00:00:00Z", "realtime")).toBeCloseTo(0.7, 12); //  4d
    expect(fit("2026-06-01T00:00:00Z", "realtime")).toBeCloseTo(0.5, 12); //  14d (>8×w)
  });

  it("month band: w=30d, boost 1.2", () => {
    expect(fit("2026-06-01T00:00:00Z", "month")).toBeCloseTo(1.2, 12); //   14d
    expect(fit("2026-05-01T00:00:00Z", "month")).toBeCloseTo(1.0, 12); //   45d
    expect(fit("2025-12-01T00:00:00Z", "month")).toBeCloseTo(0.7, 12); //  196d
    expect(fit("2025-06-01T00:00:00Z", "month")).toBeCloseTo(0.5, 12); //  379d
  });

  it("year band: w=365d, boost 1.1", () => {
    expect(fit("2026-01-01T00:00:00Z", "year")).toBeCloseTo(1.1, 12); //  165d
    expect(fit("2025-05-01T00:00:00Z", "year")).toBeCloseTo(1.0, 12); //  410d
    expect(fit("2024-01-01T00:00:00Z", "year")).toBeCloseTo(0.7, 12); //  896d (leap-aware)
    expect(fit("2015-01-01T00:00:00Z", "year")).toBeCloseTo(0.5, 12); // 4183d
  });

  it("neutrality: undated, unparseable, and non-time-scoped never decay", () => {
    expect(freshnessFit(undefined, "week", NOW_MS)).toBe(1.0);
    expect(freshnessFit("garbage", "week", NOW_MS)).toBe(1.0);
    const old = "2015-01-01T00:00:00Z";
    expect(freshnessFit(old, "any", NOW_MS)).toBe(1.0);
    expect(freshnessFit(old, "none", NOW_MS)).toBe(1.0);
    expect(freshnessFit(old, undefined, NOW_MS)).toBe(1.0);
    expect(freshnessFit(old, "bogus", NOW_MS)).toBe(1.0);
  });
});

/* ── time-scoped + retrieval-mode pins (⇔ rust types.rs) ───────────────── */

describe("isTimeScopedFreshness pins (⇔ rust types.rs)", () => {
  it("realtime/day/week/month/year are time-scoped", () => {
    for (const f of ["realtime", "day", "week", "month", "year"]) {
      expect(isTimeScopedFreshness(f), `${f} time-scoped`).toBe(true);
    }
  });
  it("any/none/empty/bogus are not time-scoped", () => {
    for (const f of ["any", "none", "", "bogus"]) {
      expect(isTimeScopedFreshness(f), `${f} not time-scoped`).toBe(false);
    }
    expect(isTimeScopedFreshness(undefined)).toBe(false);
  });
});

describe("retrievalModeForFreshness pins (⇔ rust types.rs)", () => {
  it("realtime ⇒ live_required; day/week ⇒ live_preferred; rest ⇒ cached_preferred", () => {
    expect(retrievalModeForFreshness("realtime")).toBe("live_required");
    expect(retrievalModeForFreshness("day")).toBe("live_preferred");
    expect(retrievalModeForFreshness("week")).toBe("live_preferred");
    for (const f of ["month", "year", "any", "none"]) {
      expect(retrievalModeForFreshness(f), f).toBe("cached_preferred");
    }
  });
});

/* ── §9 (audit 2026-11-04): query cache identity — retrieval-affecting intent/scope ─ */

describe("queryCacheKey carries every retrieval-affecting field (brief §9)", () => {
  const plan = (over: Record<string, unknown> = {}) =>
    ({ query: "zepto bread price", intent: "general", freshness: "any", ...over }) as any;

  it("same query+freshness, different INTENT ⇒ different key (different vertical sources)", () => {
    expect(queryCacheKey([plan()])).not.toBe(
      queryCacheKey([plan({ intent: "shopping" })]),
    );
  });

  it("different preferredDomains ⇒ different key; set ORDER does not matter", () => {
    const a = queryCacheKey([plan({ preferredDomains: ["acme.com", "beta.com"] })]);
    const b = queryCacheKey([plan({ preferredDomains: ["beta.com", "acme.com"] })]);
    const c = queryCacheKey([plan({ preferredDomains: ["other.com"] })]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(queryCacheKey([plan()])); // explicit scope ≠ unscoped
  });

  it("domain CASE folds into identity (keys are normalized, like queries)", () => {
    expect(queryCacheKey([plan({ preferredDomains: ["ACME.com"] })])).toBe(
      queryCacheKey([plan({ preferredDomains: ["acme.com"] })]),
    );
  });

  it("multi-plan SET order is irrelevant; a different plan SET is a different key", () => {
    const p1 = plan({ query: "alpha" });
    const p2 = plan({ query: "beta", intent: "news" });
    expect(queryCacheKey([p1, p2])).toBe(queryCacheKey([p2, p1]));
    expect(queryCacheKey([p1, p2])).not.toBe(queryCacheKey([p1]));
  });

  it("freshness stays in the key (pre-existing §11.11 law, unpinned regression wall)", () => {
    expect(queryCacheKey([plan()])).not.toBe(queryCacheKey([plan({ freshness: "realtime" })]));
  });
});

describe("freshness TTL constants (⇔ rust cache.rs)", () => {
  it("realtime rows expire in 5 minutes, fresh rows in 15", () => {
    expect(REALTIME_QUERY_TTL_MS).toBe(300_000);
    expect(FRESH_QUERY_TTL_MS).toBe(900_000);
    expect(REALTIME_QUERY_TTL_MS).toBeLessThan(FRESH_QUERY_TTL_MS);
  });
});

/* ── realtime wire round-trip (⇔ rust realtime_freshness_wire_round_trip) ─ */

describe("freshness wire enum accepts realtime (⇔ rust Freshness)", () => {
  const decision = (freshness: string) => ({
    search_required: true,
    reason: "test",
    freshness,
    depth: "quick" as const,
    queries: [{ query: "q", intent: "general" as const }],
  });

  it("strict schema accepts the new realtime class", () => {
    expect(SearchDecisionSchema.parse(decision("realtime")).freshness).toBe(
      "realtime",
    );
  });

  it("compat schema passes realtime through and still normalizes legacy values", () => {
    expect(SearchDecisionSchemaCompat.parse(decision("realtime")).freshness).toBe(
      "realtime",
    );
    expect(SearchDecisionSchemaCompat.parse(decision("current")).freshness).toBe(
      "day",
    );
    expect(SearchDecisionSchemaCompat.parse(decision("recent")).freshness).toBe(
      "month",
    );
  });
});

/* ── vertical matrix (⇔ rust vertical_matrix_pins_time_scoped_wiki_drop) ─ */

describe("verticalsForIntent matrix (⇔ rust metasearch.rs)", () => {
  const hasWiki = (fns: Array<{ name: string }>) =>
    fns.some((f) => f.name === "wikipediaSearch");

  // Rust additionally pins Other("x"), true ⇒ empty; the TS Intent union has
  // no free-form arm (the gate coerces to the canonical six), so that leg
  // lives only in the Rust matrix.
  it("time-scoped general drops the wiki vertical (wiki is its only engine)", () => {
    expect(verticalsForIntent("general", true)).toHaveLength(0);
  });
  it("unscoped general keeps the wiki vertical", () => {
    const v = verticalsForIntent("general", false);
    expect(v).toHaveLength(1);
    expect(hasWiki(v)).toBe(true);
  });
  it("academic/docs keep the wiki vertical even when time-scoped", () => {
    const a = verticalsForIntent("academic", true);
    expect(a).toHaveLength(2);
    expect(hasWiki(a)).toBe(true);
    const d = verticalsForIntent("docs", true);
    expect(d).toHaveLength(3);
    expect(hasWiki(d)).toBe(true);
  });
  it("code/forum/news arms never contain the wiki vertical", () => {
    for (const intent of ["code", "forum", "news"] as const) {
      const v = verticalsForIntent(intent, true);
      expect(v.length, intent).toBeGreaterThan(0);
      expect(hasWiki(v), intent).toBe(false);
    }
  });
});

/* ── §11.12 segment filter (⇔ rust reranker.rs segment_filter_*) ────────── */

describe("segment filter shared vectors (⇔ rust reranker.rs)", () => {
  // Byte-identical fixture strings (⇔ rust reranker.rs test consts). The
  // conservative drop law itself is documented in lib/web-search/
  // segment-filter.ts; these vectors pin every guard + rule path.
  const LONG_IRRELEVANT =
    "Completely unrelated prose about gardening techniques and soil composition that continues well past two hundred characters to trigger the length rule for dropping zero-coverage prose blocks from a covered page entirely here now yes.";
  const JUNK_BLOCK =
    "We use cookies to improve your experience. By continuing you agree to our privacy policy and terms of service.";
  const SHORT_IRRELEVANT = "It also comes in blue and green colors.";
  const COVERED = "The Nimbus 3 launch date was announced yesterday.";

  const DROP_INPUT = [
    COVERED,
    LONG_IRRELEVANT,
    SHORT_IRRELEVANT,
    "### Shipping and returns policy",
    "| Size | Material |\n| M | Cotton |",
    "```python\nprint(1)\n```",
    JUNK_BLOCK,
  ].join("\n\n");
  const DROP_OUTPUT = [
    COVERED,
    SHORT_IRRELEVANT,
    "### Shipping and returns policy",
    "| Size | Material |\n| M | Cotton |",
    "```python\nprint(1)\n```",
  ].join("\n\n");

  it("fixture preconditions: length + junk pins", () => {
    expect(LONG_IRRELEVANT.length).toBeGreaterThanOrEqual(200);
    expect(SHORT_IRRELEVANT.length).toBeLessThan(200);
    expect(junkPenalty(JUNK_BLOCK)).toBeGreaterThanOrEqual(0.8);
  });

  it("drops long zero-coverage prose + boilerplate; keeps covered/short/heading/table/code", () => {
    expect(filterPassageSegments(DROP_INPUT, "nimbus launch")).toBe(DROP_OUTPUT);
  });

  it("no query terms (stop-words only) ⇒ identity", () => {
    expect(filterPassageSegments(DROP_INPUT, "what is the")).toBe(DROP_INPUT);
  });

  it("tiny page (<=2 blocks) ⇒ identity", () => {
    const tiny = "Alpha beta gamma delta.\n\nEcho foxtrot golf hotel.";
    expect(filterPassageSegments(tiny, "alpha")).toBe(tiny);
  });

  it("page with no covered block ⇒ identity (never gut a page)", () => {
    const uncovered = [LONG_IRRELEVANT, SHORT_IRRELEVANT, JUNK_BLOCK].join("\n\n");
    expect(filterPassageSegments(uncovered, "quantum tunneling")).toBe(uncovered);
  });

  it("[Structured Page Facts] passage ⇒ identity (P5 metadata law)", () => {
    const facts = `[Structured Page Facts]\n\nPrice: $9\n\n${LONG_IRRELEVANT}`;
    expect(filterPassageSegments(facts, "price")).toBe(facts);
  });

  it("CRLF input with drops ⇒ joined with LF; kept blocks trimmed", () => {
    const crlf = [
      "The Nimbus 3 ships in June.",
      LONG_IRRELEVANT,
      JUNK_BLOCK,
    ].join("\r\n\r\n");
    expect(filterPassageSegments(crlf, "nimbus")).toBe(
      "The Nimbus 3 ships in June.",
    );
  });

  it("nothing droppable ⇒ ORIGINAL bytes verbatim", () => {
    const allKept = [
      COVERED,
      SHORT_IRRELEVANT,
      "### Colors and pricing",
    ].join("\n\n");
    expect(filterPassageSegments(allKept, "nimbus launch")).toBe(allKept);
  });

  it("query-covered boilerplate survives the junk rule", () => {
    const input = [COVERED, JUNK_BLOCK, LONG_IRRELEVANT].join("\n\n");
    expect(filterPassageSegments(input, "nimbus launch cookies")).toBe(
      [COVERED, JUNK_BLOCK].join("\n\n"),
    );
  });

  it("applySegmentFilter mutates passageText in place; stop-word query inert", () => {
    const packet: EvidencePacket = {
      sourceId: "S1",
      url: "https://a.com/page",
      title: "s1 title",
      domain: "a.com",
      extraction: "snippet-only",
      passages: [
        {
          sourceId: "S1",
          url: "https://a.com/page",
          title: "s1 title",
          domain: "a.com",
          passageText: DROP_INPUT,
          bm25Score: 0,
        },
      ],
    };
    const packets = [packet];
    applySegmentFilter(packets, "nimbus launch");
    expect(packets[0].passages[0].passageText).toBe(DROP_OUTPUT);
    applySegmentFilter(packets, "what is the");
    expect(packets[0].passages[0].passageText).toBe(DROP_OUTPUT);
  });
});

/* ── gate-prompt byte pins (TS sole owner since the 2026-11-03 rollback) ── */

describe("gate prompt byte pins (TS sole owner since the 2026-11-03 rollback)", () => {
  const TS_GATE = path.join(process.cwd(), "lib", "web-search", "search-gate.ts");

  // The exact gate-prompt bytes (§11.10 enum + guidance). The Rust mirror
  // (crates/ruke-websearch/src/search_gate.rs) was removed with the crate;
  // these probes keep the prompt shape pinned on the sole owner.
  const PROBES: string[] = [
    '"freshness": "none"|"day"|"week"|"month"|"year"|"realtime"|"any",',
    [
      '- freshness: "day" for same-day facts, "realtime" when the fact changes',
      '  minute-to-minute (prices, scores, status pages, "right now" state),',
      '  "week"/"month"/"year" when the fact is time-scoped, "any" otherwise;',
      '  "none" only with search_required = false.',
    ].join("\n"),
  ];

  for (const probe of PROBES) {
    const label = probe.slice(0, 48);
    it(`the gate source contains the realtime probe exactly once: ${label}…`, () => {
      // CRLF-normalize: the pins are about the prompt TEXT bytes regardless
      // of the checkout line-ending policy.
      const src = fs.readFileSync(TS_GATE, "utf8").replace(/\r\n/g, "\n");
      const occurrences = src.split(probe).length - 1;
      expect(
        occurrences,
        `${path.basename(TS_GATE)} must contain the probe exactly once (found ${occurrences})`,
      ).toBe(1);
    });
  }

  it("the gate source no longer carries the pre-realtime enum line", () => {
    const stale = '"freshness": "none"|"day"|"week"|"month"|"year"|"any",';
    const src = fs.readFileSync(TS_GATE, "utf8").replace(/\r\n/g, "\n");
    expect(src, `${path.basename(TS_GATE)} still has the stale enum line`).not.toContain(
      stale,
    );
  });
});
