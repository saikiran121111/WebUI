/**
 * §6 (brief 2026-11-13 L200-220) — Unicode word-boundary law + independently
 * generated HELD-OUT set for the attach query router and the follow-up
 * pronoun guard.
 *
 * The retired defect: JS `\b` is ASCII-only, so EVERY non-ASCII letter counted
 * as a word BOUNDARY — "café1:45"/"cafélast" fired timestamp/phrase rules
 * while the ASCII-identical "this1:45" did not. Which glue cases fired then
 * depended on the script, exactly the fixture-overfitting family the brief
 * names. The law now treats `[\p{L}\p{N}\p{M}_]` uniformly in BOTH runtimes
 * (⇔ ruke-attach router.rs is_word_char): glue is glue in every script, and
 * combining marks (Telugu vowel signs, Devanagari matras/virama, Thai sara)
 * belong to their word, never to a boundary.
 *
 * Held-out strings are new here and NEVER appear in production sources.
 * Positive controls (spaced boundary) and counterexamples (ASCII glue, which
 * already behaved correctly under the retired law) bracket every flipped
 * rule; casing/whitespace/paraphrase invariance is asserted across the law
 * change (brief L212).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/attachindex/embed", () => ({
  embedOne: async () => [],
  embedTexts: async (texts: string[]) => texts.map(() => []),
}));

import { routeQuery } from "@/lib/server/attachindex/router";
import { anchorQuery } from "@/lib/server/attachindex/turn";

describe("glue is glue in every script: timestamp rules (§6 counterexamples)", () => {
  it("non-ASCII-glued timestamps no longer route (retired ASCII-\\b quirk)", () => {
    for (const q of [
      "café1:45", // é was a boundary; now a letter — same as "this1:45"
      "ప్రిస్టూడియో2:30", // ends in a combining vowel sign (\\p{M})
      "दृश्य3:20", // Devanagari, ends in a base letter
      "कंप्यूटर्3:20", // ends in virama (halant, \\p{M})
      "片段1:05", // Han: no Latin-style boundaries at all
      "วิดีโอ4:45", // Thai: combining sara vowels INSIDE; ends in a base letter (อ)
    ]) {
      expect(routeQuery(q).mode, q).toBe("point_qa");
    }
  });

  it("positive controls: spaced boundaries route exactly like the ASCII case", () => {
    expect(routeQuery("café 1:45")).toEqual({ mode: "time_range", fromSec: 0, toSec: 285 });
    expect(routeQuery("ప్రిస్టూడియో 2:30 నుండి 4:15 వరకు")).toEqual({
      mode: "time_range",
      fromSec: 150,
      toSec: 255,
    });
    expect(routeQuery("दृश्य 3:20")).toEqual({ mode: "time_range", fromSec: 20, toSec: 380 });
    expect(routeQuery("片段 1:05")).toEqual({ mode: "time_range", fromSec: 0, toSec: 245 });
    expect(routeQuery("วิดีโอ 4:45")).toEqual({ mode: "time_range", fromSec: 105, toSec: 465 });
    expect(routeQuery("this1:45").mode).toBe("point_qa"); // ASCII glue unchanged
    expect(routeQuery("12:34:567")).toEqual({ mode: "time_range", fromSec: 574, toSec: 934 });
  });

  it("non-ASCII-glued phrase rules no longer fire; the remainder routes on its own", () => {
    // "cafélast" used to satisfy lastMin (é split). Dead candidate ⇒ the rest
    // routes independently — same machinery the ASCII pin "minutesx summary"
    // already used, now generalized to every script.
    expect(routeQuery("cafélast 10 minutes summary")).toEqual({ mode: "whole_video" });
    // Glued whole-video cue after Telugu (mark-final word) vs spaced control:
    expect(routeQuery("జాప్తంsummarize").mode).toBe("point_qa");
    expect(routeQuery("జాప్తం summarize").mode).toBe("whole_video");
  });

  it("invariance across the law change: casing and whitespace change nothing (brief L212)", () => {
    expect(routeQuery("WALK me THROUGH   the ENTIRE video")).toEqual(
      routeQuery("walk me through the entire video"),
    );
    expect(routeQuery("First  90M in")).toEqual(routeQuery("first 90m in"));
    expect(routeQuery("from 10:00 BACK to 5:00")).toEqual(routeQuery("from 10:00 back to 5:00"));
  });

  it("entity renaming preserves routing (brief L214): block keywords carry the constraint, not the label", () => {
    for (const kw of ["module", "section", "chapter", "part", "lesson", "unit"]) {
      expect(routeQuery(`explain ${kw} 4 in depth`).mode).toBe("sequential");
      expect(routeQuery(`explain ${kw} 4 in depth`).blockIndex).toBe(3);
    }
    // Novel number: two-digit block index still resolves 0-based.
    expect(routeQuery("unit 11 walkthrough").blockIndex).toBe(10);
  });
});

describe("pronoun guard uses the same Unicode class (§6)", () => {
  const msgs = [{ role: "user", content: "the shader occlusion notes" }];

  it("pronouns glued inside non-ASCII words are not counted (counterexample)", () => {
    const q =
      "caféit and caféthey explain how the rendering pipeline handles occlusion culling in deferred shaders for this scene";
    expect(q.length).toBeGreaterThanOrEqual(60);
    expect(q.length).toBeLessThan(140);
    // Retired law counted the glued "it"/"they" (+ "this") ⇒ anchored.
    // Unicode law counts only the real "this" ⇒ the query carries its own
    // subject and is used verbatim.
    expect(anchorQuery(q, msgs, 1)).toBe(q);
  });

  it("positive control: spaced pronouns still anchor pronoun-heavy follow-ups", () => {
    const q =
      "why does it look wrong when they bake that into the lightmap during this pass here";
    expect(q.length).toBeGreaterThanOrEqual(60);
    expect(q.length).toBeLessThan(140);
    const out = anchorQuery(q, msgs, 1);
    expect(out.startsWith("the shader occlusion notes ")).toBe(true);
    expect(out.endsWith(q)).toBe(true);
  });
});
