/**
 * P4 presentation-router parity suite (§55 addendum; ⇔ presentation.rs
 * `mod tests`). Shared prompts/expectations with the Rust mirror — change
 * one side, change both in the same commit.
 */
import { describe, expect, it } from "vitest";
import {
  derivePresentation,
  planPresentation,
  type PresentationInput,
} from "../../lib/web-search/presentation";
import { derivePlannerLaw } from "../../lib/web-search/planner-law";
import type { EvidencePacket, RankedResult, SearchDecision } from "../../lib/web-search/types";

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

// ── derivePresentation (⇔ presentation.rs derive_presentation tests) ────
function dec(): SearchDecision {
  return { search_required: true, reason: "", freshness: "none", depth: "standard", queries: [] };
}
function law(prompt: string) {
  return derivePlannerLaw(prompt, dec());
}
function rr(url: string, domain: string): RankedResult {
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
function pk(sourceId: string, domain: string): EvidencePacket {
  return {
    sourceId,
    url: `https://${domain}/x`,
    title: "T",
    domain,
    extraction: "direct",
    passages: [],
    classification: "SUCCESS_OK",
  };
}

describe("derivePresentation signal helper (⇔ presentation.rs)", () => {
  it("derive_video_from_youtube_results", () => {
    const rs = [
      rr("https://www.youtube.com/watch?v=x", "youtube.com"),
      rr("https://youtu.be/y", "youtu.be"),
    ];
    const prompt = "how does a combustion engine work";
    const plan = derivePresentation(prompt, law(prompt), [], rs, [], false)!;
    expect(plan.primary).toBe("video");
    expect(plan.layout).toBe("carousel");
    expect(plan.reason).toBe("video results in evidence");
  });

  it("derive_youtube_packet_sets_has_youtube_video", () => {
    const rs = [rr("https://example.com/a", "example.com")];
    const ps = [pk("s1", "youtu.be")];
    const prompt = "who invented the telephone";
    expect(derivePresentation(prompt, law(prompt), [], rs, ps, false)!.primary).toBe("video");
  });

  it("derive_domains_dedupe_first_seen", () => {
    const rs = [
      rr("https://reuters.com/1", "reuters.com"),
      rr("https://reuters.com/2", "reuters.com"),
      rr("https://example.com/3", "example.com"),
    ];
    // Deduped top = [reuters, example] → ONE news hit → §53 null.
    // Without first-seen dedupe, two reuters rows would fake a cluster.
    const prompt = "what happened at the summit";
    expect(derivePresentation(prompt, law(prompt), [], rs, [], false)).toBeNull();
  });

  it("derive_top_domains_cap_is_five", () => {
    const rs = ["x.com", "y.com", "z.com", "w.com", "v.com", "reuters.com", "cnn.com"].map((d) =>
      rr(`https://${d}/1`, d),
    );
    // The cap keeps the top five at x/y/z/w/v; reuters+cnn (positions 6–7)
    // never reach the news rung, so §53 returns plain text.
    const prompt = "what happened at the summit";
    expect(derivePresentation(prompt, law(prompt), [], rs, [], false)).toBeNull();
  });

  it("derive_gate_intent_and_geo_signals", () => {
    const prompt = "what happened at the summit";
    const plan = derivePresentation(
      prompt,
      law(prompt),
      [{ query: "q one", intent: "news" }],
      [],
      [],
      false,
    )!;
    expect(plan.primary).toBe("news");
    expect(plan.reason).toBe("news intent");

    const telephone = "who invented the telephone";
    const geo = derivePresentation(telephone, law(telephone), [], [], [], true)!;
    expect(geo.primary).toBe("map");
    expect(geo.reason).toBe("geocoded search evidence");

    const loc = "best restaurants near New York City";
    const plan2 = derivePresentation(loc, law(loc), [], [], [], false)!;
    expect(plan2.primary).toBe("map");
    expect(plan2.layout).toBe("map_split");
    expect(plan2.reason).toBe('coarse location "New York City"');
  });
});
