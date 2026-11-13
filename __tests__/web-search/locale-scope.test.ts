/**
 * §5h (2026-11-13 brief) — LOCALE-SCOPE LAW: machine locale is a HINT,
 * never a hardcoded retrieval constant.
 *
 * Defect (CONFIRMED by reading): four loci baked the developer's en-IN
 * locale into constants —
 *   1. query-planner/pipeline: `site:in.linkedin.com` hardcoded first,
 *   2. engines Google News RSS: `hl=en-IN&gl=IN&ceid=IN:en` hardcoded,
 *   3. agentBrowser: navigator.language / locale / accept-language all
 *      pinned to "en-IN",
 * so on a machine that is NOT India, every generic retrieval was
 * India-ranked (and every browser identity claimed to be India-based).
 * "Explicit task region/platform wins; locale is only a context hint."
 *
 * Counterexample walls (anti-over-correction): the user's real machine
 * IS en-IN, so every derived value must be BYTE-IDENTICAL to the old
 * hardcoded strings under en-IN — the measured DDG (`in`-subdomain
 * first), WAF-fingerprint, and Google News laws stay exactly intact.
 * Test entities are invented (Arjun Mekhi, Priya Vantipudi); no brief
 * example strings.
 */
import { describe, it, expect, vi } from "vitest";
import {
  systemRegionCC,
  explicitRegionCc,
  browserLanguagesFor,
  acceptLanguageFor,
} from "@/lib/web-search/local-context";
import { linkedinSearchHosts, planQueries } from "@/lib/web-search/query-planner";
import { googleNewsRssUrl } from "@/lib/web-search/engines";

/* Intl stub (same pattern as destination-affinity.test.ts) — makes the
 * machine locale deterministic for integration pins. */
function withSystemIntl(locale: string, fn: () => void): void {
  const spy = vi
    .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
    .mockReturnValue({ locale, timeZone: "UTC", calendar: "gregory", numberingSystem: "latn" } as Intl.ResolvedDateTimeFormatOptions);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

describe("systemRegionCC — machine locale region subtag", () => {
  it("extracts the country subtag generically", () => {
    expect(systemRegionCC("en-IN")).toBe("IN");
    expect(systemRegionCC("en-US")).toBe("US");
    expect(systemRegionCC("te-IN")).toBe("IN");
    expect(systemRegionCC("zh-Hans-CN")).toBe("CN"); // script subtag skipped
  });
  it("a locale with no region subtag yields null (hint absent, never invented)", () => {
    expect(systemRegionCC("en")).toBeNull();
    expect(systemRegionCC("hi")).toBeNull();
  });
});

describe("explicitRegionCc — explicit task region wins over the hint", () => {
  it("matches multi-word region names and unambiguous abbreviations", () => {
    expect(explicitRegionCc("find the uk linkedin profile of Priya Vantipudi")).toBe("GB");
    expect(explicitRegionCc("contact her on her united kingdom linkedin")).toBe("GB");
    expect(explicitRegionCc("the united states linkedin page")).toBe("US");
    expect(explicitRegionCc("a uae based candidate")).toBe("AE");
  });
  it("counterexample: single-word country names NEVER match — these prompts are PERSON lookups and country==given-name (Jordan, India, Georgia) is unavoidable ambiguity", () => {
    expect(explicitRegionCc("find jordan merriweather's linkedin profile")).toBeNull();
    expect(explicitRegionCc("find india williams's linkedin profile")).toBeNull();
  });
  it("no region vocabulary => null", () => {
    expect(explicitRegionCc("who won the varela island regatta last weekend")).toBeNull();
  });
});

describe("browser identity locale — derived, never hardcoded (agentBrowser consumes these)", () => {
  it("COUNTEREXAMPLE WALL: en-IN byte-identity preserves the measured WAF fingerprint", () => {
    expect(browserLanguagesFor("en-IN")).toEqual(["en-IN", "en-US", "en"]);
    expect(acceptLanguageFor("en-IN")).toBe("en-IN,en-US;q=0.9,en;q=0.8");
  });
  it("other machines get their own identity, not India", () => {
    expect(browserLanguagesFor("en-US")).toEqual(["en-US", "en"]);
    expect(acceptLanguageFor("en-US")).toBe("en-US,en;q=0.9");
    expect(browserLanguagesFor("te-IN")).toEqual(["te-IN", "te", "en"]);
    expect(acceptLanguageFor("te-IN")).toBe("te-IN,te;q=0.9,en;q=0.8");
    expect(browserLanguagesFor("de")).toEqual(["de", "en"]);
  });
});

describe("linkedinSearchHosts — no forced India hosts", () => {
  it("COUNTEREXAMPLE WALL: en-IN machine keeps the measured regional-first form byte-identically", () => {
    expect(linkedinSearchHosts("find the profile of Arjun Mekhi on linkedin", "en-IN")).toEqual([
      "in.linkedin.com",
      "linkedin.com/in/",
    ]);
  });
  it("an en-US machine gets the generic permalink form — site:in.linkedin.com is GONE", () => {
    const hosts = linkedinSearchHosts("find the profile of Arjun Mekhi on linkedin", "en-US");
    expect(hosts).toEqual(["linkedin.com/in/", "linkedin.com"]);
  });
  it("a locale with no region subtag is not India either", () => {
    expect(linkedinSearchHosts("linkedin profile of Arjun Mekhi", "en")).toEqual([
      "linkedin.com/in/",
      "linkedin.com",
    ]);
  });
  it("explicit task region wins over the machine hint", () => {
    // en-IN machine, but the user explicitly asked for the US profile:
    // the India host must not be forced first.
    expect(
      linkedinSearchHosts("find the united states linkedin profile of Arjun Mekhi", "en-IN"),
    ).toEqual(["linkedin.com/in/", "linkedin.com"]);
    // Explicit region that is neither US nor a LinkedIn regional host stays generic.
    expect(
      linkedinSearchHosts("find the uk linkedin profile of Arjun Mekhi", "en-US"),
    ).toEqual(["linkedin.com/in/", "linkedin.com"]);
  });
});

describe("googleNewsRssUrl — hl/gl/ceid ride the locale, not a constant", () => {
  it("COUNTEREXAMPLE WALL: en-IN reproduces the old hardcoded URL byte-for-byte", () => {
    expect(googleNewsRssUrl("varelo island ferry schedule", "en-IN")).toBe(
      "https://news.google.com/rss/search?q=" +
        encodeURIComponent("varelo island ferry schedule") +
        "&hl=en-IN&gl=IN&ceid=IN:en",
    );
  });
  it("en-US machine gets US ranking", () => {
    expect(googleNewsRssUrl("senate vote count", "en-US")).toContain("&hl=en-US&gl=US&ceid=US:en");
  });
  it("the language subtag rides through (Telugu reader gets te, not en)", () => {
    expect(googleNewsRssUrl("cinema release news", "te-IN")).toContain("&hl=te-IN&gl=IN&ceid=IN:te");
  });
  it("a regionless locale falls back like systemGl (US), never a fake region", () => {
    expect(googleNewsRssUrl("kernel changelog", "en")).toContain("&hl=en&gl=US&ceid=US:en");
  });
});

describe("planQueries integration — the linkedin case rides the derived hosts", () => {
  const prompt = "can you find this profile name Arjun Mekhi in linkedIN";
  const sitePlans = (locale: string): string[] => {
    let out: string[] = [];
    withSystemIntl(locale, () => {
      out = planQueries(prompt, [])
        .map((p) => p.query)
        .filter((q) => /site:/.test(q));
    });
    return out;
  };

  it("en-IN machine: both measured operator forms still go out, regional form present (pin unchanged)", () => {
    const qs = sitePlans("en-IN");
    expect(qs.some((q) => /site:in\.linkedin\.com$/.test(q))).toBe(true);
    expect(qs.some((q) => /site:linkedin\.com\/in\/$/.test(q))).toBe(true);
  });
  it("en-US machine: the India host is never emitted", () => {
    const qs = sitePlans("en-US");
    expect(qs.some((q) => /in\.linkedin\.com/.test(q))).toBe(false);
    expect(qs.some((q) => /site:linkedin\.com\/in\/$/.test(q))).toBe(true);
    expect(qs.length).toBeGreaterThanOrEqual(2); // two operator forms still go out
  });
});
