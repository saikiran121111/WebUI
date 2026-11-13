/**
 * §5f (2026-11-13 brief) — TIME-KIND SEPARATION:
 *   "Separate publication, update, observation, fetch, and
 *    claim-validity times."
 *
 * Before this law the retrieval model carried exactly ONE typed stamp
 * per document (`publishedAt`/`publishedDate`), and every temporal
 * decision — rank boost (§11.10), band satisfaction (WS19/§5a), the
 * journal — consumed that one ambiguous slot. The page's OWN declared
 * update time (JSON-LD dateModified, article:modified_time) was parsed
 * only into display facts and thrown away at the typed layer, so a
 * document republished last week under a years-old original date FAILED
 * a "this week" ask — or, on engines that index lastmod as the date,
 * the update masqueraded as publication with nobody the wiser.
 *
 * The law now in force (pins below):
 *  - each kind gets its own slot: publication = publishedAt,
 *    UPDATE = modifiedAt (new), observation/fetch = JournalSource.fetchedAt
 *    (already separate), claim-validity = the decision's freshness band;
 *  - extraction is metadata-only (JSON-LD datePublished/dateModified,
 *    article:published_time/modified_time), ISO-validated, never a
 *    guess — prose numbers ("line 31/39/40" in a compiler log pasted
 *    into page text) are NEVER stamps;
 *  - band satisfaction accepts EITHER kind under the same two-sided
 *    §5a future/lookback law, EXCEPT "realtime": a "price now" ask is
 *    evidenced only by freshly PUBLISHED content (an ancient page with
 *    a typo-fix edit is not a fresh quote);
 *  - rank stays publication-only (§11.10 vectors untouched).
 *
 * Fictional entities only (Vireo Ledger, Varela Island, Meridian
 * Ledger); test strings live in THIS file, never in production.
 */
import { describe, expect, it } from "vitest";

import { evaluateCoverage } from "../../lib/web-search/query-planner";
import { derivePlannerLaw, evaluateSufficiency } from "../../lib/web-search/planner-law";
import { parseDeclaredTimes } from "../../lib/web-search/schema-extract";
import type { EvidencePacket, EvidencePassage, SearchDecision } from "../../lib/web-search/types";

const DAY = 86_400_000;
const agoISO = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const aheadISO = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const dec = (freshness: SearchDecision["freshness"]): SearchDecision => ({
  search_required: true,
  reason: "",
  freshness,
  depth: "deep",
  queries: [],
});
const pk = (sourceId: string, domain: string): EvidencePacket => ({
  sourceId,
  url: `https://${domain}/x`,
  title: "T",
  domain,
  extraction: "direct",
  passages: [],
  classification: "SUCCESS_OK",
});
const ep = (
  sourceId: string,
  domain: string,
  times: { publishedAt?: string; modifiedAt?: string },
): EvidencePassage => ({
  sourceId,
  url: `https://${domain}/x`,
  title: "T",
  domain,
  ...(times.publishedAt !== undefined ? { publishedAt: times.publishedAt } : {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...(("modifiedAt" in times ? { modifiedAt: times.modifiedAt } : {}) as any),
  passageText:
    "The Varela Island lighthouse museum closed for structural renovation and later reopened with a new exhibition hall.",
  bm25Score: 0,
});

const ASK = "When did the Varela Island lighthouse museum reopen after its renovation?";

const sufficiencyWith = (
  freshness: SearchDecision["freshness"],
  passageTimes: Array<{ publishedAt?: string; modifiedAt?: string }>,
) => {
  const passagesTexts = passageTimes.map(() => "lighthouse museum renovation reopened exhibition hall Varela Island");
  const coverage = evaluateCoverage(ASK, passagesTexts);
  const dd = dec(freshness);
  const packets = passageTimes.map((_, i) => pk(`S${i + 1}`, `src${i + 1}.example.net`));
  const passages = passageTimes.map((t, i) => ep(`S${i + 1}`, `src${i + 1}.example.net`, t));
  return evaluateSufficiency(packets, passages, coverage, dd, derivePlannerLaw(ASK, dd));
};

describe("the band law separates publication from update — but not into a wider gate", () => {
  it("a document UPDATED inside the band evidences a banded ask even when its original publication predates it", () => {
    // The conflation defect, inverted: an ancient publishedAt used to be
    // the ONLY signal, so a genuinely re-published guide failed "this
    // week" and the planner demanded a needless gap search while holding
    // the freshest possible source.
    const r = sufficiencyWith("week", [{ publishedAt: agoISO(730), modifiedAt: agoISO(2) }]);
    expect(r.freshnessOk).toBe(true);
  });

  it("an undated document with an in-band UPDATE still evidences temporal applicability", () => {
    const r = sufficiencyWith("month", [{ modifiedAt: agoISO(5) }]);
    expect(r.freshnessOk).toBe(true);
  });

  it("COUNTEREXAMPLE — a realtime ask is NEVER evidenced by an update stamp (ancient page + fresh edit ≠ a fresh quote)", () => {
    const r = sufficiencyWith("realtime", [{ publishedAt: agoISO(730), modifiedAt: agoISO(0.01) }]);
    expect(r.freshnessOk).toBe(false);
  });

  it("the two-sided §5a law rides the update stamp too: a future modifiedAt cannot evidence the band", () => {
    const r = sufficiencyWith("week", [{ publishedAt: agoISO(730), modifiedAt: aheadISO(400) }]);
    expect(r.freshnessOk).toBe(false);
  });

  it("POSITIVE CONTROL — publication AND update both stale ⇒ still fails the band (no relaxation)", () => {
    const r = sufficiencyWith("week", [{ publishedAt: agoISO(730), modifiedAt: agoISO(400) }]);
    expect(r.freshnessOk).toBe(false);
  });

  it("POSITIVE CONTROL — an undated passage never evidences a banded ask (WS19 law untouched)", () => {
    const r = sufficiencyWith("week", [{ publishedAt: agoISO(1) }]); // no modifiedAt slot at all
    expect(r.freshnessOk).toBe(true); // published inside band — unchanged
    const r2 = sufficiencyWith("week", [{}]);
    expect(r2.freshnessOk).toBe(false);
  });

  it("POSITIVE CONTROL — an un-banded ask ignores stamps entirely", () => {
    const r = sufficiencyWith("any", [{ publishedAt: agoISO(3000), modifiedAt: agoISO(3000) }]);
    expect(r.freshnessOk).toBe(true);
  });
});

describe("declared page times are parsed from metadata only, never from prose", () => {
  it("JSON-LD datePublished + dateModified yield BOTH kinds in their own slots", () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context":"https://schema.org","@type":"NewsArticle",
       "headline":"Vireo Ledger covers the Varela Island ferry schedule",
       "datePublished":"2019-03-01T08:00:00Z","dateModified":"2026-11-08T10:30:00Z"}
      </script></head><body>text</body></html>`;
    expect(parseDeclaredTimes(html)).toEqual({
      publishedAt: "2019-03-01T08:00:00Z",
      modifiedAt: "2026-11-08T10:30:00Z",
    });
  });

  it("datePublished alone yields ONLY the publication kind — the update kind stays absent, never copied", () => {
    const html = `<script type="application/ld+json">
      {"@type":"BlogPosting","datePublished":"2024-07-04"}
      </script>`;
    expect(parseDeclaredTimes(html)).toEqual({ publishedAt: "2024-07-04" });
  });

  it("OpenGraph article:published_time / article:modified_time meta tags are honored (either attribute order)", () => {
    const html = `
      <meta property="article:modified_time" content="2026-10-30T12:00:00Z">
      <meta name="article:published_time" content="2021-01-02T03:04:05Z">`;
    expect(parseDeclaredTimes(html)).toEqual({
      publishedAt: "2021-01-02T03:04:05Z",
      modifiedAt: "2026-10-30T12:00:00Z",
    });
  });

  it("a nested dateModified under a deeper JSON-LD object is still found (bounded walker, not top-level-only)", () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"CreativeWork","about":{"@type":"Thing"}},
                 {"@type":"WebPage","speakable":{"@type":"SpeakableSpecification"},
                  "interactionStatistic":{"@type":"InteractionCounter"},
                  "meta":{"deep":{"dateModified":"2026-11-01"}}}]}
      </script>`;
    expect(parseDeclaredTimes(html).modifiedAt).toBe("2026-11-01");
  });

  it("POSITIVE CONTROLS — junk, non-ISO, and prose numbers are never stamps", () => {
    // Bogus month (13) fails ISO validation:
    expect(parseDeclaredTimes(`<script type="application/ld+json">
      {"datePublished":"2026-13-45","dateModified":"Garbage"}
      </script>`)).toEqual({});
    // A compiler-log style number pair sitting in PAGE TEXT (the audited
    // "31/39/40 in line numbers" conflation shape) is prose, not metadata:
    expect(parseDeclaredTimes(`<body>error at line 31/39/40 column 7
      src/compiler/pass.c</body>`)).toEqual({});
    // Non-ISO human dates (V8 could parse these) are deliberately NOT
    // accepted — absence beats guessing, and the downstream
    // unparseable-date-passes law handles the absence honestly:
    expect(parseDeclaredTimes(
      `<meta property="article:modified_time" content="November 8, 2026">`,
    )).toEqual({});
    // Malformed JSON-LD must not throw:
    expect(parseDeclaredTimes(
      `<script type="application/ld+json">{oops</script><meta property="article:published_time" content="2020-02-02">`,
    )).toEqual({ publishedAt: "2020-02-02" });
  });
});
