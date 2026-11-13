/**
 * 2026-11-13 brief L189/L190 — AMBIGUOUS-DOMAIN LAW:
 * "Rust 'pattern match' must not select sports" and "avoid domain-intent
 * decisions from ambiguous terms such as stock, package, or series".
 *
 * Defect (CONFIRMED by reading, live in the current tree): the
 * presentation ladder picked a whole surface from ONE bare keyword —
 *   /\b(match|score|...|series|...)\b/  -> sports  ("Rust pattern match")
 *   /\b(stock|stocks|...)\b/            -> finance ("stock photo")
 *   /\b(...|package|version)\b/         -> tracker ("npm package")
 * and metasearch's queryLooksLikeDev fired the github/stackexchange/devto
 * verticals off bare `rust|go|node|git|java|error` ("remove rust stains").
 *
 * Law (root-cause fix, generalizes): an AMBIGUOUS domain token never
 * decides alone — it needs one more distinct same-domain token to
 * co-occur. UNAMBIGUOUS tokens (proper-noun / code-shape forms) win
 * alone, so every measured positive behavior survives: multi-word sports
 * asks, "stock quote" (§7 smoke), "package tracking number", the sports
 * parity pins, and real dev queries (whose primary channel is the gate
 * model's "code"/"docs" intent anyway — pinned separately in the gate
 * suites). No production exceptions for the brief's example strings;
 * the strings are pinned HERE, in tests only.
 */
import { describe, expect, it } from "vitest";
import { planPresentation, type PresentationInput } from "@/lib/web-search/presentation";
import { queryLooksLikeDev } from "@/lib/web-search/metasearch";

function input(userPrompt: string): PresentationInput {
  return {
    userPrompt,
    location: null,
    hasYouTubeVideo: false,
    hasGeoEvidence: false,
    intents: [],
    topDomains: [],
  };
}

describe("presentation ladder — ambiguous terms must not decide a domain surface", () => {
  it("brief L189: 'pattern match' language never selects sports", () => {
    for (const p of [
      "rust pattern match explained",
      "pattern matching in functional programming",
      "regex match groups",
    ]) {
      expect(planPresentation(input(p))?.primary ?? "text").not.toBe("sports");
    }
  });

  it("brief L190: a lone 'series' or 'goal' or 'score' or 'fixture' never selects sports", () => {
    expect(planPresentation(input("best thriller tv series on netflix"))?.primary ?? "text").not.toBe("sports");
    expect(planPresentation(input("the goal of the marketing campaign"))?.primary ?? "text").not.toBe("sports");
    expect(planPresentation(input("what was the credit score on my loan application"))?.primary ?? "text").not.toBe("sports");
    expect(planPresentation(input("a test fixture for the valve repair"))?.primary ?? "text").not.toBe("sports");
  });

  it("POSITIVE CONTROL: real sports asks keep the sports surface (multi-signal or unambiguous)", () => {
    const m = planPresentation(input("last night match score"))!;
    expect(m.primary).toBe("sports");
    expect(m.layout).toBe("inline");
    expect(m.reason).toBe("sports intent");
    const t = planPresentation(input("ipl points table standings"))!;
    expect(t.primary).toBe("sports");
    expect(t.layout).toBe("table");
    expect(t.reason).toBe("sports standings");
  });

  it("brief L190: a lone 'stock' never selects finance", () => {
    expect(planPresentation(input("stock photo websites for blogs"))?.primary ?? "text").not.toBe("finance");
    expect(planPresentation(input("pantry stock list for the week"))?.primary ?? "text").not.toBe("finance");
  });

  it("POSITIVE CONTROLS: multi-signal finance asks survive", () => {
    const q = planPresentation(input("stock quote of acme industrial today"))!;
    expect(q.primary).toBe("finance");
    expect(q.reason).toBe("finance intent");
    expect(planPresentation(input("stock price of zenith motors"))!.primary).toBe("finance");
    expect(planPresentation(input("sensex nifty close today"))!.primary).toBe("finance");
  });

  it("brief L190: a lone 'package' or 'version' never selects tracker", () => {
    expect(planPresentation(input("npm package for parsing yaml files"))?.primary ?? "text").not.toBe("tracker");
    expect(planPresentation(input("what package should i use for http requests"))?.primary ?? "text").not.toBe("tracker");
    // 'version' alone: falls through to the comparison table rung, which is
    // the honest surface for a version-comparison ask (§7 smoke case).
    const v = planPresentation(input("compare redis version 7 and version 8"))!;
    expect(v.primary).toBe("table");
  });

  it("POSITIVE CONTROLS: real live-state asks survive", () => {
    expect(planPresentation(input("usps package tracking number status"))!.primary).toBe("tracker");
    expect(planPresentation(input("postgres 17 changelog release notes"))!.primary).toBe("tracker");
    expect(planPresentation(input("github status page outage"))!.primary).toBe("tracker");
  });
});

describe("queryLooksLikeDev — ambiguous language words never decide the dev vertical alone", () => {
  it("common-English meanings of language names stay general-web", () => {
    expect(queryLooksLikeDev("how to remove rust stains from white clothes")).toBe(false);
    expect(queryLooksLikeDev("best time of year to go to kyoto")).toBe(false);
    expect(queryLooksLikeDev("parenting by trial and error"))
      .toBe(false);
    expect(queryLooksLikeDev("vacation on java island indonesia")).toBe(false);
    expect(queryLooksLikeDev("swift bird migration patterns")).toBe(false);
    expect(queryLooksLikeDev("express shipping delivery time"))
      .toBe(false);
  });

  it("POSITIVE CONTROLS: unambiguous dev tokens still win alone", () => {
    expect(queryLooksLikeDev("pandas dataframe groupby in python")).toBe(true);
    expect(queryLooksLikeDev("node.js event loop memory leak")).toBe(true);
    expect(queryLooksLikeDev("kubernetes ingress controller config")).toBe(true);
    expect(queryLooksLikeDev("typescript generic constraints")).toBe(true);
    expect(queryLooksLikeDev("golang concurrency patterns")).toBe(true);
  });

  it("POSITIVE CONTROLS: ambiguous token + second dev signal fires", () => {
    expect(queryLooksLikeDev("rust borrow checker errors explained")).toBe(true);
    expect(queryLooksLikeDev("git merge conflict resolution")).toBe(true);
    expect(queryLooksLikeDev("java spring boot tutorial")).toBe(true);
    expect(queryLooksLikeDev("error: cannot find module node")).toBe(true);
  });
});
