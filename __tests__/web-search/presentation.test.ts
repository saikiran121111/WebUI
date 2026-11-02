/**
 * P4 presentation-router parity suite (§55 addendum; ⇔ presentation.rs
 * `mod tests`). Shared prompts/expectations with the Rust mirror — change
 * one side, change both in the same commit.
 */
import { describe, expect, it } from "vitest";
import { planPresentation, type PresentationInput } from "../../lib/web-search/presentation";

/** ⇔ presentation.rs tests::input() — neutral default input. */
function input(userPrompt: string): PresentationInput {
  return {
    userPrompt,
    location: null,
    hasGeoEvidence: false,
    hasYouTubeVideo: false,
    intents: [],
    topDomains: [],
  };
}

describe("presentation router (⇔ presentation.rs)", () => {
  it("geo_evidence_wins_everything", () => {
    const plan = planPresentation({ ...input("who invented the telephone"), hasGeoEvidence: true });
    expect(plan).not.toBeNull();
    expect(plan!.primary).toBe("map");
    expect(plan!.layout).toBe("map_split");
    expect(plan!.reason).toBe("geocoded search evidence");
  });

  it("weather_intent_inline", () => {
    const plan = planPresentation(input("weather tomorrow morning"))!;
    expect(plan.primary).toBe("weather");
    expect(plan.layout).toBe("inline");
    expect(plan.reason).toBe("weather intent");
  });

  it("sports_standings_table_vs_match_inline", () => {
    const t = planPresentation(input("ipl points table standings"))!;
    expect(t.primary).toBe("sports");
    expect(t.layout).toBe("table");
    expect(t.reason).toBe("sports standings");
    const m = planPresentation(input("last night match score goal"))!;
    expect(m.primary).toBe("sports");
    expect(m.layout).toBe("inline");
    expect(m.reason).toBe("sports intent");
  });

  it("location_reason_is_quoted_coarse_phrase", () => {
    const plan = planPresentation({ ...input("good italian food"), location: "Pune" })!;
    expect(plan.primary).toBe("map");
    expect(plan.reason).toBe('coarse location "Pune"');
    expect(planPresentation(input("directions to the airport"))!.reason).toBe("map intent");
  });

  it("youtube_top_two_domains_become_video_carousel", () => {
    const plan = planPresentation({
      ...input("how does a combustion engine work"),
      topDomains: ["m.youtube.com", "youtu.be"],
    })!;
    expect(plan.primary).toBe("video");
    expect(plan.layout).toBe("carousel");
    expect(plan.reason).toBe("video results in evidence");
  });

  it("news_cluster_counts_top_five", () => {
    const plan = planPresentation({
      ...input("what happened at the summit"),
      topDomains: ["reuters.com", "cnn.com", "randomblog.io"],
    })!;
    expect(plan.primary).toBe("news");
    expect(plan.layout).toBe("grid");
    expect(plan.reason).toBe("2 news domains in top results");
    expect(
      planPresentation({ ...input("what happened at the summit"), intents: ["news"] })!.reason,
    ).toBe("news intent");
  });

  it("plain_factual_gets_no_surface", () => {
    // §53 no-spam law: the canonical "Who invented the telephone?"
    expect(planPresentation(input("Who invented the telephone?"))).toBeNull();
  });

  it("comparison_table_and_learning_and_app", () => {
    const t = planPresentation(input("compare rust vs go"))!;
    expect(t.primary).toBe("table");
    expect(t.layout).toBe("table");
    expect(t.reason).toBe("comparison intent");
    const l = planPresentation(input("how to learn async rust tutorial"))!;
    expect(l.primary).toBe("learning");
    expect(l.reason).toBe("learning intent");
    // No table-words ("best \\w+" WOULD win first), no chart/learning words;
    // app words (tool/library/download) fire the app rung.
    const a = planPresentation(input("pdf tool library download"))!;
    expect(a.primary).toBe("app");
    expect(a.reason).toBe("app intent");
  });

  it("vocabulary_matches_rust_serde_strings", () => {
    // ⇔ presentation.rs serde_vocabulary_matches_ts_strings — the TS object
    // literal key order is the Rust serde field order.
    const j = JSON.stringify(planPresentation(input("weather in the morning")));
    expect(j).toBe('{"primary":"weather","layout":"inline","reason":"weather intent"}');
    const j2 = JSON.stringify(planPresentation({ ...input("x"), hasGeoEvidence: true }));
    expect(j2).toContain('"layout":"map_split"');
  });
});
