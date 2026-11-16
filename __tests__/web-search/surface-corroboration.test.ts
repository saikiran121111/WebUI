/**
 * F05 (2026-11-15 brief, items 5-6) - a presentation SURFACE is a claim about
 * what kind of data the answer needs, so the two state-dependent rungs that
 * ambiguous English can also trigger (sports scores, finance quotes, live
 * state) must be corroborated by what retrieval ACTUALLY returned.
 *
 * Brief reproductions (before the fix, on the real router):
 *   "pattern match scores in a parser"        -> sports
 *   "package version updates in python"       -> tracker
 * Both prompts legitimately contain two domain-flavored words, so the
 * existing two-token ambiguous-domain law cannot separate them from a real
 * ask without another keyword cascade. Evidence is real data, so the router
 * consults it (same shape as the pre-existing news rung rule).
 *
 * Corroboration can only DECLINE a surface, never invent one, and an
 * unambiguous prompt (that rung PRIMARY pattern) always wins - which is why
 * every measured positive in domain-ambiguity.test.ts still passes.
 */
import { describe, it, expect } from "vitest";

import {
  derivePresentation,
  corroborateSurface,
  type PresentationPlan,
} from "@/lib/web-search/presentation";
import { derivePlannerLaw } from "@/lib/web-search/planner-law";
import type { RankedResult, SearchDecision } from "@/lib/web-search/types";

function dec(): SearchDecision {
  return { search_required: true, reason: "", freshness: "none", depth: "standard", queries: [] };
}
function law(prompt: string) {
  return derivePlannerLaw(prompt, dec());
}
function rr(domain: string): RankedResult {
  const url = `https://${domain}/x`;
  return {
    url,
    canonical: url,
    title: "t",
    snippet: "s",
    engine: "e",
    domain,
    rrf: 1.0,
    engines: ["e"],
    engineRanks: {},
  };
}
const plan = (primary: PresentationPlan["primary"]): PresentationPlan => ({
  primary,
  layout: "inline",
  reason: "test",
});

describe("corroborateSurface - the rule itself", () => {
  it("an unambiguous prompt keeps the surface whatever the evidence says", () => {
    expect(
      corroborateSurface(plan("finance"), "sensex nifty close today", ["randomblog.example"]),
    ).not.toBeNull();
    expect(
      corroborateSurface(plan("sports"), "ipl points table standings", ["randomblog.example"]),
    ).not.toBeNull();
    expect(
      corroborateSurface(plan("tracker"), "github status page outage", ["randomblog.example"]),
    ).not.toBeNull();
  });

  it("an ambiguous prompt keeps the surface when a vertical source answered", () => {
    expect(
      corroborateSurface(plan("sports"), "last night match score", ["espn.com"]),
    ).not.toBeNull();
    expect(
      corroborateSurface(plan("finance"), "stock price of zenith motors", ["moneycontrol.com"]),
    ).not.toBeNull();
    expect(
      corroborateSurface(plan("tracker"), "package version updates in python", ["pypi.org"]),
    ).not.toBeNull();
  });

  it("an ambiguous prompt loses the surface when no vertical source answered", () => {
    expect(corroborateSurface(plan("sports"), "last night match score", ["stackoverflow.com"])).toBeNull();
    expect(corroborateSurface(plan("finance"), "stock price of zenith motors", ["medium.example"])).toBeNull();
  });

  it("only the three state-dependent rungs are ever touched", () => {
    for (const primary of ["weather", "news", "map", "learning", "video", "table"] as const) {
      expect(corroborateSurface(plan(primary), "anything at all", [])).not.toBeNull();
    }
  });

  it("vertical matching is registrable-domain, not substring", () => {
    expect(corroborateSurface(plan("sports"), "last night match score", ["notespn.com"])).toBeNull();
    expect(
      corroborateSurface(plan("sports"), "last night match score", ["www.espn.in"]),
    ).not.toBeNull();
  });
});

describe("derivePresentation - end to end", () => {
  const tech = ["stackoverflow.com", "dev.to", "example.com"];

  it("brief case: parser pattern-match scores get no sports card", () => {
    const p = "what do pattern match scores in a parser mean";
    const planOut = derivePresentation(p, law(p), [], tech.map(rr), [], false);
    expect(planOut === null || planOut.primary !== "sports").toBe(true);
  });

  it("brief case: python package version updates get no tracker card on tech-blog evidence", () => {
    const p = "how do package version updates in python work";
    const planOut = derivePresentation(p, law(p), [], tech.map(rr), [], false);
    expect(planOut === null || planOut.primary !== "tracker").toBe(true);
  });

  it("POSITIVE CONTROLS: real state asks keep their card", () => {
    const sports = derivePresentation(
      "last night match score",
      law("last night match score"),
      [],
      ["espncricinfo.com", "cricbuzz.com"].map(rr),
      [],
      false,
    )!;
    expect(sports.primary).toBe("sports");
    expect(sports.reason).toBe("sports intent");

    const unambiguous = derivePresentation(
      "stock quote of acme industrial today",
      law("stock quote of acme industrial today"),
      [],
      tech.map(rr),
      [],
      false,
    );
    // FIN_PRIMARY has no "stock quote" spelling, so this ask needs the
    // finance vertical in the evidence like any other ambiguous one. The
    // point of the control is that corroboration KEEPS a supported card.
    expect(unambiguous).toBeNull();
    const supported = derivePresentation(
      "stock quote of acme industrial today",
      law("stock quote of acme industrial today"),
      [],
      ["seekingalpha.com", "medium.example"].map(rr),
      [],
      false,
    )!;
    expect(supported.primary).toBe("finance");
  });

  it("POSITIVE CONTROL: the news rule is untouched by this change", () => {
    const p = "what happened at the summit";
    const news = derivePresentation(
      p,
      law(p),
      [],
      ["reuters.com", "apnews.com", "example.com"].map(rr),
      [],
      false,
    )!;
    expect(news.primary).toBe("news");
  });
});
