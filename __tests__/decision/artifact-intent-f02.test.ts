/**
 * F02 - artifact intent is a TYPED relation, not English grammar luck.
 *
 * Frozen BEFORE the implementation (SPEC section 5: held-out expectations are
 * fixed first). Every case below was reproduced against the pre-fix scanner;
 * the reproduction log lives in docs/overnight/logs/f02-repro-1.log.
 *
 * The law this suite pins (all general mechanisms, no example-specific rules):
 *   1. TUTORIAL FRAME  - "explain HOW TO create a PDF" asks about producing,
 *      it does not request a deliverable. A didactic marker EARLIER than the
 *      production cue reclassifies the whole clause.
 *   2. REPORTED PAST ACTION - an explicit subject + a past-tense production
 *      verb is a statement about an existing file ("I created a PDF
 *      yesterday"), never a request. Desire verbs (want/need) are exempt:
 *      politeness past tense ("I wanted a PDF") IS a request.
 *   3. NEGATION SCOPE - a negation governs its own phrase only; a production
 *      cue after the phrase boundary starts a new request
 *      ("Without using Excel, create a PDF" still requests the PDF).
 *   4. SOURCE vs DESTINATION ROLE - "from/based on/out of <format>" marks the
 *      word as the SOURCE material; "Make a Word document FROM this PDF" is
 *      one destination (docx) plus one source (pdf), not an ambiguity.
 *   5. CONTAINER ROLE - a container preposition ("summary IN PDF", "output
 *      AS a pptx") names the requested deliverable, so a content word in
 *      between ("summary") never vetoes it, while "summary OF the pdf"
 *      remains discussed material.
 *   6. POLYSEMY GUARDS - a lexeme with a strong competing sense ("deck")
 *      needs its own domain in reach: the partitive complement ("deck OF
 *      cards") and a same-segment sense frame ("GARDEN deck") suppress it;
 *      "deck of slides", "quarterly deck", "business deck" still route.
 *   7. QUOTATION ROLE - a quoted BARE format name in an explicit request is a
 *      label for the deliverable ('create a "PDF"'), a quoted INSTRUCTION or
 *      a metalinguistic mention ("the term \"presentation\"") stays masked.
 *   8. MULTIPLE DELIVERABLES are recorded explicitly (never an arbitrary
 *      winner, never silently dropped) and stay in standard_chat because one
 *      mode validator cannot own two fences.
 *   9. DESIRE PHRASING + COGNITIVE FRAME - "I would like a workbook" IS a
 *      request (the desire verb is a production cue), while "I would like to
 *      understand how a PDF stores fonts" is a question about the format (the
 *      cognitive verb sits between cue and word). Perception verbs
 *      ("looked like", "sounded like") never become cues: the consuming word
 *      class keeps the apostrophe-final word whole.
 */
import { describe, expect, it } from "vitest";
import { getDecisionSync } from "@/lib/decision/client";

const mode = (message: string) => getDecisionSync(message).active_mode;
const envelope = (message: string) => getDecisionSync(message);

describe("F02 1 - tutorial frame: discussing production is not requesting a deliverable", () => {
  it.each([
    "Explain how to create a PDF",
    "how do I create a PDF?",
    "Show me how to make a spreadsheet",
    "Teach me how to build a PowerPoint",
    "What are the steps to create a docx?",
    "Give me a tutorial on generating charts",
    "how can I export a deck",
    "explain how PDF pagination works",
  ])("didactic cue before the production cue => standard_chat: %s", (m) => {
    expect(mode(m)).toBe("standard_chat");
  });

  it("keeps the deliverable when the didactic phrase FOLLOWS the request", () => {
    expect(mode("Create a PDF that explains how spreadsheets work")).toBe("pdf");
  });
  it("control: a bare production request still routes", () => {
    expect(mode("Create a PDF")).toBe("pdf");
  });
});

describe("F02 2 - a reported past action is not a request", () => {
  it.each([
    "I created a PDF yesterday; explain compression",
    "We built a spreadsheet last week. What is a pivot table?",
    "They wrote a docx before the meeting, review it",
    "I generated a pptx earlier - what does Morph do?",
  ])("explicit subject + past-tense production verb => standard_chat: %s", (m) => {
    expect(mode(m)).toBe("standard_chat");
  });

  it("politeness past tense with a desire verb IS a request", () => {
    expect(mode("I wanted a PDF of that, please")).toBe("pdf");
    expect(mode("I need a spreadsheet for this")).toBe("excel");
  });
  it("imperative past-looking noun phrases are not cues: no subject => routes", () => {
    expect(mode("Create a PDF, I made one last week so compare format choices")).toBe("pdf");
  });
});

describe("F02 3 - negation scope is the negation's own phrase", () => {
  it("a negation in a preceding phrase does not veto a later request", () => {
    expect(mode("Without using Excel, create a PDF")).toBe("pdf");
    expect(mode("Skip the spreadsheet, just make a chart of these numbers")).toBe("chart");
  });
  it("a negation inside the request phrase still vetoes", () => {
    expect(mode("Do not create a PDF")).toBe("standard_chat");
    expect(mode("Don't make me an xlsx please")).toBe("standard_chat");
    expect(mode("Create a chart, not a spreadsheet")).toBe("chart");
  });
  it("no-cue noun negation never becomes a request either", () => {
    expect(mode("No Excel today")).toBe("standard_chat");
  });
});

describe("F02 4 - source role vs destination role", () => {
  it("one destination + one source is not an ambiguity", () => {
    expect(envelope("Make a Word document from this PDF").active_mode).toBe("docs");
    expect(envelope("Make a Word document from this PDF").decided_by).toContain("deliverable");
  });
  it.each([
    ["Create a chart from this spreadsheet", "chart"],
    ["Build a deck based on the existing xlsx", "ppt"],
    ["Write a docx out of the old pdf", "docs"],
  ])("%s => %s", (m, expected) => {
    expect(mode(m)).toBe(expected);
  });
  it("the transform direction law still holds", () => {
    expect(mode("Convert the PDF to Excel")).toBe("excel");
    expect(mode("Export the deck as a PDF")).toBe("pdf");
  });
  it("a source that is ALSO the ask still routes once", () => {
    expect(mode("Rebuild this PDF, keep the source PDF numbering")).toBe("pdf");
  });
});

describe("F02 5 - container role: the format is the deliverable", () => {
  it("content word + container preposition => the container routes", () => {
    expect(mode("Create a summary in PDF")).toBe("pdf");
    expect(mode("Create the summary as a docx")).toBe("docs");
    expect(mode("Write the numbers in xlsx format")).toBe("excel");
  });
  it("a content-of relation keeps the format as discussed material", () => {
    expect(mode("Write a summary of the PDF")).toBe("standard_chat");
    expect(mode("Draft an outline of the deck")).toBe("standard_chat");
  });
  it("positive control: the adjacent compound still routes", () => {
    expect(mode("Create a PDF summary")).toBe("pdf");
  });
});

describe("F02 6 - polysemous lexemes need their own domain in reach", () => {
  it.each([
    "Create a deck of cards",
    "Create a plan for my garden deck",
    "Build me a deck for the back patio",
  ])("competing sense => standard_chat: %s", (m) => {
    expect(mode(m)).toBe("standard_chat");
  });
  it("the presentation-domain controls keep routing", () => {
    expect(mode("I need a deck of slides for Monday")).toBe("ppt");
    expect(mode('make a "quarterly" deck')).toBe("ppt");
    expect(mode("Create a business deck")).toBe("ppt");
    expect(mode("give me a presentation")).toBe("ppt");
  });
});

describe("F02 7 - quotation role: label versus mention", () => {
  it("a quoted bare format name in an explicit request still routes", () => {
    expect(mode('Create a "PDF" of this report')).toBe("pdf");
    expect(mode("make an \u201Cxlsx\u201D from these rows")).toBe("excel");
  });
  it("a quoted instruction or a metalinguistic mention stays masked", () => {
    expect(mode('explain the phrase "make a deck"')).toBe("standard_chat");
    expect(mode("what does the term \u201Cpresentation\u201D mean")).toBe("standard_chat");
    expect(mode('he said "create a PDF" and then left')).toBe("standard_chat");
  });
});

describe("F02 8 - multiple deliverables are explicit, never an arbitrary winner", () => {
  it("two destinations are recorded, and no mode validator is armed", () => {
    const env = envelope("Create a PDF and an XLSX of these numbers");
    expect(env.active_mode).toBe("standard_chat");
    expect(env.decided_by).toBe("in-process-deliverable-multiple");
    expect(env.task_constraints).toEqual(["deliverable-request=pdf", "deliverable-request=excel"]);
    expect(env.skill_to_load).toBe(null);
    expect(env.confidence).toBe(0.5);
  });
  it("a single destination records its own constraint", () => {
    const env = envelope("Create a PDF of these numbers");
    expect(env.active_mode).toBe("pdf");
    expect(env.task_constraints).toEqual(["deliverable-request=pdf"]);
  });
  it("the same format named twice is one deliverable", () => {
    expect(envelope("Create a PDF, then create a second PDF").active_mode).toBe("pdf");
  });
});

describe("F02 9 - honest uncertainty vocabulary", () => {
  it("a miss names itself as none, not as a match", () => {
    expect(envelope("What is a PDF?").decided_by).toBe("in-process-deliverable-none");
    expect(envelope("").decided_by).toBe("in-process-fallback");
  });
  it("a bound single intent names itself as match with honest confidence", () => {
    const env = envelope("Create a PDF");
    expect(env.decided_by).toBe("in-process-deliverable-match");
    expect(env.confidence).toBe(0.8);
  });
});

describe("F02 10 - desire phrasing is a cue; a cognitive frame is not a request", () => {
  it.each([
    ["I would like a spreadsheet of the quarterly figures", "excel"],
    ["we would like the numbers as a workbook please", "excel"],
    ["she'd like a pdf of the invoice", "pdf"],
    ["I would like a word document of the interview notes", "docs"],
  ])("polite desire + format => %s routes: %s", (m, want) => {
    expect(mode(m)).toBe(want);
  });
  it.each([
    "I would like to understand how a pdf stores fonts",
    "she'd like to know what a spreadsheet pivot is",
    "it looked like a pdf but it is actually a scan",
    "that sounded like a spreadsheet idea",
    "how would you like the data?",
  ])("no deliverable requested => standard_chat: %s", (m) => {
    expect(mode(m)).toBe("standard_chat");
  });
  it("a cognitive verb AFTER the format never suppresses the request", () => {
    expect(mode("Create a PDF so I can understand the invoice")).toBe("pdf");
  });
});
