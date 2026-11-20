/**
 * F02b (2026-11-16 brief, section 4): the eight diagnostic probes are ANSWER
 * KEYS, not production phrase rules. Each expectation below was frozen BEFORE
 * the repair and first run as a reproduction (docs/overnight/logs/f02b-repro-1.log).
 *
 * The axes these probes expose, and the general law each one pins:
 *   ACTION vs DISCUSSION   a didactic noun phrase ("the steps for making") puts the
 *                          whole clause in tutorial frame, exactly like "how to".
 *   SOURCE vs SUBJECT      "using the <format> data" names MATERIAL; "the history of
 *                          <format>" names a TOPIC. Neither is a second deliverable.
 *   TRANSFORM PARTICLE     a transform verb and its direction word may be separated
 *                          by the source itself ("turn this PDF into a DOCX"), so the
 *                          cue is a discontinuous verb+oblique, not a bigram.
 *   HYPOTHETICAL FRAME     a conditional antecedent plus an interrogative main clause
 *                          discusses producing the file; it does not request one.
 *                          The affirmative control ("If you want, create a PDF") keeps
 *                          its deliverable, so the rule is about the FRAME, not "if".
 * Nothing here keys on a domain, a format name, a site or a user phrase.
 */
import { describe, expect, it } from "vitest";
import { getDecisionSync } from "@/lib/decision/client";

const mode = (message: string) => getDecisionSync(message).active_mode;
const envelope = (message: string) => getDecisionSync(message);

describe("F02b probe 1 - 'Show me the steps for making an Excel workbook.'", () => {
  it("a didactic noun phrase is a tutorial frame, not a deliverable request", () => {
    expect(mode("Show me the steps for making an Excel workbook.")).toBe("standard_chat");
  });
  it("the frame law generalises across format words and step phrasings", () => {
    expect(mode("Show me the steps for creating a PDF.")).toBe("standard_chat");
    expect(mode("what are the steps for building a presentation?")).toBe("standard_chat");
    expect(mode("walk me through the steps for writing a docx")).toBe("standard_chat");
  });
  it("control: the same format word without a didactic frame still routes", () => {
    expect(mode("Make me an Excel workbook of these figures")).toBe("excel");
  });
});

describe("F02b probe 2 - 'Create a PDF using the Excel data.'", () => {
  it("one destination plus one material, never two deliverables", () => {
    const env = envelope("Create a PDF using the Excel data.");
    expect(env.active_mode).toBe("pdf");
    expect(env.task_constraints).toEqual(["deliverable-request=pdf"]);
    expect(env.decided_by).toBe("in-process-deliverable-match");
  });
  it("the material role generalises: no format word in the ask survives as a second output", () => {
    expect(envelope("Write a PDF using the docx template wording").active_mode).toBe("pdf");
    expect(envelope("Make a chart using our spreadsheet figures").active_mode).toBe("chart");
  });
  it("control: a material named AFTER the ask still leaves one deliverable", () => {
    expect(mode("Create a PDF, using the Excel data as the appendix")).toBe("pdf");
  });
});

describe("F02b probe 3 - 'Create a presentation on the history of Excel.'", () => {
  it("the subject of the deliverable is not a second deliverable", () => {
    const env = envelope("Create a presentation on the history of Excel.");
    expect(env.active_mode).toBe("ppt");
    expect(env.task_constraints).toEqual(["deliverable-request=ppt"]);
  });
  it("topic nouns generalise across domains", () => {
    expect(envelope("Create a docx on the background of our pdf pipeline").active_mode).toBe("docs");
    expect(envelope("Write a PDF about the history of spreadsheets").active_mode).toBe("pdf");
  });
  it("control: a topic noun that IS the deliverable still routes", () => {
    expect(mode("Create a PDF of the presentation history")).toBe("pdf");
  });
});

describe("F02b probe 4 - 'Could you turn this PDF into a DOCX file?'", () => {
  it("the destination survives a source between verb and particle", () => {
    const env = envelope("Could you turn this PDF into a DOCX file?");
    expect(env.active_mode).toBe("docs");
    expect(env.task_constraints).toEqual(["deliverable-request=docs"]);
    expect(env.decided_by).toBe("in-process-deliverable-match");
  });
  it("the discontinuous transform law is direction-governed, not phrase-matched", () => {
    expect(mode("Turn the deck into a PDF")).toBe("pdf");
    expect(mode("Can you change these numbers into a workbook?")).toBe("excel");
    expect(mode("Please translate that PDF into a Word document")).toBe("docs");
  });
  it("control: the source side of the same law never becomes an ask", () => {
    expect(envelope("Turn this workbook into a chart").task_constraints).toEqual([
      "deliverable-request=chart",
    ]);
  });
});

describe("F02b probe 5 - 'If I wanted a PDF, how would I make it?'", () => {
  it("a conditional antecedent around an interrogative frame discusses production", () => {
    expect(mode("If I wanted a PDF, how would I make it?")).toBe("standard_chat");
  });
  it("the frame law generalises", () => {
    expect(mode("If we needed a workbook, what would the steps be?")).toBe("standard_chat");
    expect(mode("Suppose you wanted a deck - how would you build one?")).toBe("standard_chat");
  });
  it("control: a conditional that does NOT sit inside an interrogative frame keeps its deliverable", () => {
    expect(mode("If you want, create a PDF of this report")).toBe("pdf");
    expect(mode("If the data is ready, make the workbook")).toBe("excel");
  });
});

describe("F02b - an ambiguous polyseme is never forced into one reading", () => {
  it("'deck' with a competing sense in reach is left unrouted, not guessed", () => {
    expect(mode("Create a deck explaining the cards")).toBe("standard_chat");
    expect(mode("Create a deck of cards for the game night")).toBe("standard_chat");
  });
  it("control: the presentation-domain reading still routes", () => {
    expect(mode("Create a deck explaining the quarterly results")).toBe("ppt");
  });
});

describe("F02b - the multiple-deliverable record still means two REQUESTED outputs", () => {
  it("two asks in one turn stay explicit", () => {
    expect(envelope("Create a PDF and a workbook from these figures").active_mode).toBe(
      "standard_chat",
    );
  });
  it("a material mention never inflates the record", () => {
    expect(envelope("Create a PDF using the workbook").task_constraints).toEqual([
      "deliverable-request=pdf",
    ]);
  });
});
