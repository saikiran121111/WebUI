/**
 * F82 + F84 scorer law, model-free (no inference slot, no lock).
 *
 * F82 — the unanswerable-row refusal detector (tests/helpers/refusal.ts).
 * C3 evidence: fr-P9 answered correctly ("The report names no chief
 * engineer — it is signed only as 'Prepared by the basin engineering
 * group.'") and the OLD regex called that a name answer. The negative
 * control pinned here is the brief's demand: an answer that ASSERTS a
 * name must score as not-a-refusal, so a real hallucinated name can never
 * pass an unanswerable row.
 *
 * F84 — the answer reader must read the semantic answer body
 * (div.msg-content, pinned by data-testid="answer-body"), never the
 * assistant card, whose chrome ("Thought for Xs", "View reasoning",
 * "Copy") polluted fr-X4 into scoring "0" against chrome text. Pin:
 *  * ChatMessage.tsx puts data-testid="answer-body" on the msg-content div;
 *  * fr-live-regression.spec.ts reads ANSWER_BODY for both the first-token
 *    detection and the completion `said`, with card text only as fallback;
 *  * the spec never strips English UI words by regex (the brief's law:
 *    NO regex-stripping of "Thought for"/"View reasoning"/"Copy").
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRefusal } from "../tests/helpers/refusal";

describe("F82 refusal scorer: absence statements pass", () => {
  const refusals = [
    // The exact C3 fr-P9 answer that the old regex failed.
    "The report names no chief engineer — it is signed only as 'Prepared by the basin engineering group.'",
    "The file does not contain the approval date.",
    "I cannot find that figure in the document.",
    "No such person is mentioned in the deck.",
    // F147 (2026-11-24): the exact f93-long-1 fr-P9 answer shape the
    // pre-F147 lexicon missed (adjective between "no" and the role noun).
    "No chief engineer is named anywhere in the report.",
    "No signing engineer was identified in the file.",
    "The author isn't named on these pages.",
    "There is nothing about a budget in the report.",
    "The signing engineer is not attributed in the file.",
  ];
  for (const r of refusals) {
    it(`scores an absence statement as a refusal: ${r.slice(0, 40)}…`, () => {
      expect(isRefusal(r)).toBe(true);
    });
  }
});

describe("F82 refusal scorer: NEGATIVE CONTROL — asserted facts are not refusals", () => {
  const answers = [
    // The brief's required control: a concrete asserted name must FAIL an
    // unanswerable row, so the scorer can never bless a hallucination.
    "The chief engineer is John Smith (signed 1897).",
    "The approval date is 8 August 1897.",
    "The yield is 440.125 and the margin is 98.75.",
    "Signed by Joseph Harper, chief engineer.",
    // A real answer that merely MENTIONS absent-tense wording about a
    // different thing still asserts its own fact — kept as a named-entity
    // answer, not a refusal.
    "The value is 0; note the table lists no second series.",
  ];
  for (const a of answers) {
    it(`scores an asserted-fact answer as NOT a refusal: ${a.slice(0, 40)}…`, () => {
      expect(isRefusal(a)).toBe(false);
    });
  }
});

describe("F84 answer-body reader contract (source pins)", () => {
  const chat = readFileSync(path.resolve(__dirname, "..", "components", "ChatMessage.tsx"), "utf8");
  const spec = readFileSync(path.resolve(__dirname, "..", "tests", "fr-live-regression.spec.ts"), "utf8");

  it("ChatMessage puts data-testid=answer-body on the semantic msg-content div", () => {
    expect(chat).toMatch(/<div className="msg-content select-text" data-testid="answer-body">/);
  });

  it("the spec defines the ANSWER_BODY locator", () => {
    expect(spec).toMatch(/const ANSWER_BODY = '\[data-testid="answer-body"\]';/);
  });

  it("the first-token detection reads the answer body, not the card", () => {
    const hits = spec.match(/reply\.locator\(ANSWER_BODY\)\.first\(\)\.innerText\(\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2); // send() and followUp()
  });

  it("the completion reader scores the body with card text only as fallback", () => {
    const hits =
      spec.match(/const said = \(await \(await body\.count\(\)\s*\n?\s*\?\s*body\.first\(\)\.innerText\(\)\s*\n?\s*: reply\.innerText\(\)\)\.catch\(\(\) => ""\)\)\.trim\(\);/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2); // send() and followUp()
  });

  it("no regex-stripping of English UI chrome words in the spec's code", () => {
    // The brief's law: fix the reader to the semantic element; never scrub
    // "Thought for" / "View reasoning" / "Copy" out of card text with regex.
    // Comments MAY name the chrome (they document why); CODE may not strip it.
    const code = spec.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // A .replace() whose regex pattern names a chrome word is the strip
    // signature. Selectors that TOGGLE the reasoning control are legal.
    expect(code).not.toMatch(/replace\(\s*\/[^/]*?(Thought|reasoning|copy)/i);
    expect(code).not.toMatch(/replace\(\s*new RegExp\([^)]*(Thought|reasoning|copy)/i);
  });
});
