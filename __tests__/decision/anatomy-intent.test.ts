/**
 * Audit finding 5 (2026-11-06): the anatomy route over-triggers.
 *
 * The deliverable matcher used to fire on ONE bare keyword
 * ("anatomy" / "cutaway" / "cross-section" / "isometric" / "exploded"), so a
 * conversational question that merely mentions the vocabulary as its TOPIC was
 * routed into the anatomy renderer + skill block:
 *
 *   "What is the anatomy of the knee?"   -> anatomy  (wrong: a definition ask)
 *   "What is an isometric exercise?"     -> anatomy  (wrong: fitness domain)
 *
 * The anatomy route now requires the keyword WITHOUT a definitional /
 * explanatory frame around it. Illustration requests — bare noun phrases,
 * imperative "draw me a cutaway" — keep routing to anatomy, because that is
 * what the studio exists for.
 *
 * Parity law: `crates/ruke-decision/src/engine.rs` mirrors these frames
 * pattern-for-pattern (no lookahead exists in the Rust `regex` crate, so the
 * rule is a plain match-then-reject pair), the golden corpus
 * `rust-backend/fixtures/decision/06-intent-matcher-vectors.json` replays the
 * same prompts against both engines, and `engine.rs`'s own #[cfg(test)] suite
 * pins the same expectations independently.
 */
import { describe, expect, it } from "vitest";
import { getDecisionSync } from "../../lib/decision/client";

const modeFor = (prompt: string) => getDecisionSync(prompt, []).active_mode;
const skillFor = (prompt: string) => getDecisionSync(prompt, []).skill_to_load;

describe("finding 5 — conversational questions stay standard_chat", () => {
  it("the two audit examples never reach the anatomy renderer", () => {
    for (const prompt of [
      "What is the anatomy of the knee?",
      "What is an isometric exercise?",
    ]) {
      expect(modeFor(prompt), prompt).toBe("standard_chat");
      expect(skillFor(prompt), prompt).toBeNull();
    }
  });

  it("definition and explanation frames around the vocabulary are topic mentions", () => {
    for (const prompt of [
      "what is the anatomy of the knee",
      "what's anatomy?",
      "what does anatomy mean?",
      "what is the meaning of cutaway?",
      "define isometric",
      "definition of a cross-section",
      "how does an exploded view work?",
      "tell me about the anatomy of the knee",
      "explain the anatomy of a knee",
      "isometric exercises for beginners",
      "anatomy quiz questions",
      "I have an anatomy exam tomorrow, any tips?",
    ]) {
      expect(modeFor(prompt), prompt).toBe("standard_chat");
    }
  });

  // Deliberately NOT asserted: a bare noun phrase with no frame at all
  // ("knee anatomy") cannot be told apart from the golden corpus positive
  // "anatomy of a jet turbine", which IS an illustration request. The rule
  // therefore keys off the conversational FRAMES, not off a positive ask verb
  // — and a false negative is cheap: the UI never hard-gates fences, so the
  // model can still emit an ```anatomy block in a standard_chat turn.
});

describe("finding 5 — illustration requests keep the anatomy route", () => {
  const POSITIVES = [
    "an exploded view of the reactor core",
    "cutaway of the marine engine",
    "anatomy of a jet turbine",
    "isometric illustration of the server rack",
    "cross-section of the pump housing",
    "a building cutaway diagram",
    "exploded diagram in html",
    "draw me a cutaway of a jet engine",
    "can you draw an exploded view of a car engine?",
    "how do I get an isometric diagram of the rack?",
    "show the anatomy of a jet turbine as a diagram",
  ];

  it.each(POSITIVES)("%s -> anatomy", (prompt) => {
    expect(modeFor(prompt)).toBe("anatomy");
    expect(skillFor(prompt)).toBe("anatomy");
  });

  it("precedence is untouched: chart still beats anatomy, anatomy beats html", () => {
    expect(modeFor("exploded isometric chart")).toBe("chart");
    expect(modeFor("chart of this building's architecture")).toBe("chart");
    expect(modeFor("exploded diagram in html")).toBe("anatomy");
  });

  it("the other deliverable routes are unaffected", () => {
    expect(modeFor("make me a spreadsheet of the results")).toBe("excel");
    expect(modeFor("print this pdf")).toBe("pdf");
    expect(modeFor("what is an isometric exercise?")).toBe("standard_chat");
  });
});
