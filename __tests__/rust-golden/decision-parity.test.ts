/**
 * Golden corpus — Part 3 decision-intent + core-skill contracts parity.
 *
 * Direct (non-HTTP) oracle calls: `getDecisionSync` from lib/decision/client
 * (the in-process regex router — zero network, deterministic) and
 * `MODE_CONTRACTS` from lib/decision/contracts. Recorded fixtures are
 * replayed byte-for-byte by `crates/ruke-decision/tests/fixture_replay.rs`.
 *
 * decision/06 pins the §4a intent law (re-recorded 2026-11-13): an artifact
 * WORD is not an artifact REQUEST. Production cues bind per clause, negation
 * vetoes, convert/export governs the SOURCE format, quoted/code spans are
 * masked, meta phrases mark discussed material, mixed deliverables are
 * ambiguous (never INTENT_ORDER precedence), and confidence is honest
 * (0.8 verb-bound / 0.5 uncertain — the old blanket 1 was false). The
 * Unicode consuming word classes REPLACE the retired ASCII-\b quirks
 * ("caféexcel"/"résumébuilder" no longer split; bare "résumé" matches and
 * "résumé2" honestly misses — §6: legacy defects, not contracts).
 * skills/06 pins the exact bytes of every mode contract via sha256 — the
 * Rust side regenerates its constants from THIS module (gen-mode-contracts)
 * and the replay proves the emitted literals survived round-trip.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { setGoldenEnv, writeJsonFixture } from "./support/golden";

setGoldenEnv();

// Static imports are safe here (ESM hoisting aside): the regex router module
// has no env-dependent logic beyond logger construction — unlike the route
// modules in sibling fixtures, which needed beforeAll dynamic import.
import { getDecisionSync } from "@/lib/decision/client";
import { MODE_CONTRACTS } from "@/lib/decision/contracts";
import type { RendererMode } from "@/lib/decision/types";

const HARNESS = "__tests__/rust-golden/decision-parity.test.ts";

// Prompts ONLY — the oracle's OUTPUT is recorded into the fixture; the Rust
// side must reproduce active_mode + skill_to_load + decided_by + trim +
// confidence for each one. Never hand-write expected outputs here: the
// oracle IS the spec.
const VECTORS: string[] = [
  // — §4a verb-bound positives (a production cue starts before the word) —
  "build me a spreadsheet now", "make a spreadsheet from these numbers", "create a pdf",
  "generate pdf report", "write a word document", "make a résumé for me", "create my résumé",
  "Create a résumé.", "make me a cv", "I need a deck of slides for Monday", "give me a presentation",
  "give me a chart of the sales", "make a chart of the revenue", "build me a landing page",
  "make an exploded diagram in html", "export as xlsx", "   make a deck \t",
  "Make Me A Spreadsheet", "CREATE A PDF", "create file.docx", "make a \"quarterly\" deck",
  // — §4a brief reproductions + graceful misses (a word is never a request) —
  "What is a PDF?", "Do not create Excel. Explain arrays.", "Explain a deck of cards.",
  "Create a résumé2.", "put these numbers into my spreadsheet", "an Excel file please",
  "open the .xlsx", "the workbook tab", "print this pdf", "update my resume today",
  "save the .pptx", "export pptx now", "the deck outline", "a powerpoint deck",
  "presentation in pdf format", "the interior of the pdf", "spreadsheet and a chart",
  "chart the revenue", "chart of this building's architecture",
  // — §4a negation / provenance / meta / transform-direction —
  "do not create excel", "don't create a pdf, just summarize", "I don't want a presentation, just notes",
  "explain the phrase \"make a deck\"", "write a summary of the pdf", "draft an outline of the deck",
  "write a word document about migratory birds", "convert the pdf to excel",
  "save the deck as a spreadsheet", "export the deck",
  // — §4a genuine mixed deliverables: ambiguity, never an arbitrary winner —
  "make a presentation in pdf format", "create a résumé and a spreadsheet", "make a chart and a deck",
  // — Unicode word classes (retired ASCII-\b quirks; §6 legacy defects) —
  "caféexcel", "résumébuilder", "résumé", "my résumé", "résumé2", "file.docx", "file.xlsx",
  "file.pptx", "the pdfx file", "what is excelent", "charts", "cvx", "htmlx dashboard",
  "word  document", "word-document", "power  point", "render\nscene",
  // — held-out non-Latin (§6): the cue vocabulary is ENGLISH-ONLY —
  "कृपया pdf बनाकर दो", "స్ప్రెడ్‌షీట్ సృష్టించండి", "hi make pdf",
  // — §6 \p{M} generalization: mark-joined Latin cues are GLUE (blocked),
  //   the spaced controls route — the English verb keeps the cue law live —
  "create కంప్యూటర్pdf", "create కంప్యూటర్ pdf",
  "create कंप्यूटर्resume", "create कंप्यूटर् resume",
  // — retired anatomy/3d/cad vocabulary (2026-11-06/07) stays standard_chat —
  "an exploded view of the reactor core", "cutaway of the marine engine", "anatomy of a jet turbine",
  "isometric illustration of the server rack", "cross-section of the pump housing",
  "What is the anatomy of the knee?", "What is an isometric exercise?", "what's anatomy?",
  "define isometric", "isometric exercises for beginners", "anatomy quiz questions",
  "I have an anatomy exam tomorrow, any tips?", "render scene", "3D building model",
  "an architectural sketch", "exploded isometric chart", "exploded diagram in html",
  "interior design with html", "a model of the city",
  // — misc misses / trim / case —
  "tell me a joke", "PDF REPORT", "Excel",
  // — F02 held-out corpus (fresh names/domains, NOT the brief's examples):
  //   polite desire phrasing is a request cue; a cognitive/report frame is not.
  "I would like a spreadsheet of the quarterly figures",
  "I would like to understand how a pdf stores fonts",
  "she'd like a pdf of the invoice",
  "it looked like a pdf but it is actually a scan",
  "walk me through how to generate a docx",
  "how should I build a chart from this csv",
  "she exported a pptx last Friday; what is a slide master",
  "we already made the xlsx - explain the formulas",
  "Convert the pdf into a slide deck",
  "Skip the docx, produce a PDF memo instead",
  "Create a plan for my terrace deck",
  "make me a deck for the poker night",
  "Give me the numbers as a workbook",
  "make a \"docx\" out of the meeting notes",
  "Write the summary into a pptx",
  "rebuild the corrupted xlsx",
  "Explain what a PDF and a DOCX are",
  "Create a PDF and an XLSX of these numbers",
  "Design a landing page for the bakery site",
  "generate a chart of the reaction rates",
  "please can you draft an invoice template as a pdf",
  "no pdf needed, just explain the tables",
  "export the table to csv and then build a pdf",
];

describe("golden: Part 3 decision-intent vectors (decision/06)", () => {
  it("records the intent-matcher corpus from the live oracle", () => {
    const vectors = VECTORS.map((prompt) => {
      const env = getDecisionSync(prompt, []);
      return {
        prompt,
        active_mode: env.active_mode,
        skill_to_load: env.skill_to_load,
        decided_by: env.decided_by,
        stripped_prompt: env.stripped_prompt,
        confidence: env.confidence,
        task_constraints: env.task_constraints,
      };
    });

    // Spot-checks that the recorded corpus actually captures the §4a law
    // (guards the fixture itself, not the Rust side).
    const at = (p: string) => vectors.find((v) => v.prompt === p)!;
    // The brief's four reproductions (§4):
    expect(at("What is a PDF?").active_mode).toBe("standard_chat"); // used to route pdf
    expect(at("Do not create Excel. Explain arrays.").active_mode).toBe("standard_chat"); // used to route excel
    expect(at("Explain a deck of cards.").active_mode).toBe("standard_chat"); // used to route ppt
    expect(at("Create a résumé.").active_mode).toBe("docs"); // used to MISS (é boundary quirk)
    expect(at("Create a résumé2.").active_mode).toBe("standard_chat"); // used to MATCH (é boundary quirk)
    // Cue law + provenance:
    expect(at("create a pdf").active_mode).toBe("pdf");
    expect(at("create a pdf").confidence).toBe(0.8); // honest verb-bound confidence
    expect(at("convert the pdf to excel").active_mode).toBe("excel"); // direction law: ONE intent
    expect(at("export as xlsx").active_mode).toBe("excel");
    expect(at("save the .pptx").active_mode).toBe("standard_chat"); // .pptx is the governed SOURCE
    expect(at("write a summary of the pdf").active_mode).toBe("standard_chat"); // meta phrase
    expect(at("explain the phrase \"make a deck\"").active_mode).toBe("standard_chat"); // masked quote
    expect(at("make a \"quarterly\" deck").active_mode).toBe("ppt"); // masking positive control
    // F02: two requested deliverables are recorded EXPLICITLY (never an
    // arbitrary winner, never a vague "ambiguous" that loses one of them).
    expect(at("make a presentation in pdf format").decided_by).toBe("in-process-deliverable-multiple");
    expect(at("make a presentation in pdf format").active_mode).toBe("standard_chat");
    expect(at("make a presentation in pdf format").confidence).toBe(0.5);
    expect(at("presentation in pdf format").active_mode).toBe("standard_chat"); // no cue at all: plain miss
    // F02 honest vocabulary: a miss never claims to be a match.
    expect(at("presentation in pdf format").decided_by).toBe("in-process-deliverable-none");
    expect(at("presentation in pdf format").task_constraints).toEqual([]);
    // Retired ASCII-\b quirks (§6 legacy defects) now behave correctly:
    expect(at("caféexcel").active_mode).toBe("standard_chat"); // é is a letter: no split
    expect(at("résumébuilder").active_mode).toBe("standard_chat"); // consuming-tail branch retired
    expect(at("résumé").active_mode).toBe("standard_chat"); // the word matches; a mention is not a request
    expect(at("file.docx").active_mode).toBe("standard_chat"); // cue-gated now
    expect(at("create file.docx").active_mode).toBe("docs");
    // Confidence table (§4a): uncertain outcomes never claim 1.
    expect(at("tell me a joke").confidence).toBe(0.5);
    expect(at("tell me a joke").decided_by).toBe("in-process-deliverable-none");
    // The retired-vocabulary guard (audit finding 5) still lands on standard_chat:
    expect(at("What is the anatomy of the knee?").active_mode).toBe("standard_chat");
    expect(at("a model of the city").active_mode).toBe("standard_chat");
    expect(at("exploded diagram in html").active_mode).toBe("standard_chat"); // no production cue
    expect(at("render\nscene").active_mode).toBe("standard_chat");
    // "design" is a §4a production cue, so this formerly-retired architecture
    // phrase is honestly a cue-bound request now (documented change):
    expect(at("interior design with html").active_mode).toBe("html_render");
    // The English-only cue vocabulary falls gracefully (§6 held-out non-Latin):
    expect(at("कृपया pdf बनाकर दो").active_mode).toBe("standard_chat");
    expect(at("hi make pdf").active_mode).toBe("pdf"); // control
    // §6 \p{M}: words ending in combining marks (virama) glue Latin cues,
    // exactly like Latin glue ("pdfx"); under the retired class the mark
    // looked like a boundary and these fired.
    expect(at("create కంప్యూటర్pdf").active_mode).toBe("standard_chat");
    expect(at("create కంప్యూటర్ pdf").active_mode).toBe("pdf");
    expect(at("create कंप्यूटर्resume").active_mode).toBe("standard_chat");
    expect(at("create कंप्यूटर् resume").active_mode).toBe("docs");
    // F02 held-out law: a REQUEST is a request whatever its politeness; a
    // cognitive/report frame around the format word is never a request.
    expect(at("I would like a spreadsheet of the quarterly figures").active_mode).toBe("excel");
    expect(at("I would like to understand how a pdf stores fonts").active_mode).toBe("standard_chat");
    expect(at("she'd like a pdf of the invoice").active_mode).toBe("pdf");
    expect(at("it looked like a pdf but it is actually a scan").active_mode).toBe("standard_chat");
    expect(at("walk me through how to generate a docx").active_mode).toBe("standard_chat");
    expect(at("how should I build a chart from this csv").active_mode).toBe("standard_chat");
    expect(at("she exported a pptx last Friday; what is a slide master").active_mode).toBe("standard_chat");
    expect(at("we already made the xlsx - explain the formulas").active_mode).toBe("standard_chat");
    expect(at("Explain what a PDF and a DOCX are").active_mode).toBe("standard_chat");
    expect(at("no pdf needed, just explain the tables").active_mode).toBe("standard_chat");
    expect(at("Create a plan for my terrace deck").active_mode).toBe("standard_chat"); // polysemy
    expect(at("make me a deck for the poker night").active_mode).toBe("standard_chat"); // polysemy
    expect(at("Give me the numbers as a workbook").active_mode).toBe("excel");
    expect(at("rebuild the corrupted xlsx").active_mode).toBe("excel");
    expect(at("Write the summary into a pptx").active_mode).toBe("ppt"); // container, not meta
    expect(at("Convert the pdf into a slide deck").active_mode).toBe("ppt"); // pdf = SOURCE
    expect(at("Skip the docx, produce a PDF memo instead").active_mode).toBe("pdf");
    expect(at("make a \"docx\" out of the meeting notes").active_mode).toBe("docs");
    expect(at("Design a landing page for the bakery site").active_mode).toBe("html_render");
    expect(at("generate a chart of the reaction rates").active_mode).toBe("chart");
    expect(at("please can you draft an invoice template as a pdf").active_mode).toBe("pdf");
    expect(at("export the table to csv and then build a pdf").active_mode).toBe("pdf");
    // Multiple deliverables are EXPLICIT, ordered, never silently merged:
    const multi = at("Create a PDF and an XLSX of these numbers");
    expect(multi.active_mode).toBe("standard_chat"); // no single winner is invented
    expect(multi.skill_to_load).toBeNull();
    expect(multi.task_constraints).toEqual(["deliverable-request=pdf", "deliverable-request=excel"]);
    expect(at("create a pdf").task_constraints).toEqual(["deliverable-request=pdf"]); // single intent also records
    // Trim contract unchanged:
    expect(at("   make a deck \t").stripped_prompt).toBe("make a deck");
    expect(at("   make a deck \t").active_mode).toBe("ppt");

    const blank = getDecisionSync("     \n", []);
    expect(blank.decided_by).toBe("in-process-fallback"); // internal-only path

    writeJsonFixture("decision/06-intent-matcher-vectors.json", {
      vectors,
      blankMessage: {
        prompt: "     \n",
        active_mode: blank.active_mode,
        decided_by: blank.decided_by,
        stripped_prompt: blank.stripped_prompt,
        skill_to_load: blank.skill_to_load,
      },
      trimProbe: "JS trim() set includes NBSP (U+00A0): the blank prompt above is whitespace-only for JS.",
    }, {
      scenario: "getDecisionSync §4a intent-law vectors + blank-message fallback envelope",
      semantics:
        "§4a intent law (re-recorded 2026-11-13; every pre-§4a pin below is a documented legacy-defect " +
        "change, not silent drift): an artifact WORD is not an artifact REQUEST. Quoted/code spans are " +
        "masked first; clauses split on [.!?\\n;]+ AFTER alnum-dot-alnum runs ('file.docx', 'v2.5') " +
        "become spaces (filename/version/decimal dots are not clause boundaries — 'create file.docx' " +
        "binds docs); an artifact word counts as requested only when a " +
        "production cue precedes it in the same clause — all cue/artifact/direction/negation/meta " +
        "relations compare MATCH STARTS by order only, never end-vs-start (adjacent matches share " +
        "their boundary character, so end-vs-start is off-by-one there; fixed in both engines " +
        "2026-11-13; this is why 'export as xlsx'/'generate pdf report' were misses before) " +
        "(cue vocabulary is ENGLISH-ONLY — a " +
        "non-Latin verb with a Latin artifact word falls gracefully to standard_chat); negation before " +
        "the word vetoes it; convert/export governs the word directly as the SOURCE format (the word " +
        "after a to/into/as direction word is the output); summary/outline-style meta phrases mark " +
        "discussed material; two+ requested intents are ambiguous ('in-process-deliverable-ambiguous') " +
        "— INTENT_ORDER precedence retired. Unicode \\p{L}/\\p{N}/\\p{M} consuming word classes in BOTH " +
        "engines: caféexcel/résumébuilder no longer split, bare résumé matches its own word, résumé2 " +
        "honestly misses. Honest confidence: 0.8 verb-bound, 0.5 miss/ambiguous — the retired blanket " +
        "1.0 was false certainty. Anatomy/3d/cad vocabulary stays standard_chat (retired 2026-11-06/07) " +
        "unless a §4a cue-bound request survives ('make an exploded diagram in html' -> html_render; " +
        "'interior design with html' -> html_render because 'design' is a production cue now). " + "F02 (re-recorded 2026-11-16, typed-relation law): a request is a request whatever its " + "politeness - 'would like'/\"'d like\" are production cues, so 'I would like a spreadsheet of the " + "figures' routes excel; a COGNITIVE or REPORT frame around the format word is never a request - " + "'I would like to understand how a pdf stores fonts', 'walk me through how to generate a docx', " + "'she exported a pptx last Friday', 'it looked like a pdf' and 'Explain what a PDF and a DOCX are' " + "all stay standard_chat. Polysemy stays polysemy ('deck' of cards / terrace deck / poker deck). " + "Honest decided_by vocabulary: -none (no deliverable found, never reported as a match), -match " + "(exactly one), -multiple (two or more requested deliverables, recorded in task_constraints as " + "'deliverable-request=<mode>' in first-appearance order; active_mode stays standard_chat because " + "the scan must not invent a winner and the injection layer arms every requested contract). " + "The retired -ambiguous label conflated 'several deliverables' with 'uncertain', which silently " + "lost one requested output.",
      comparison: "semantic",
      notes:
        "Field-for-field (mode/skill/decided_by/trim/confidence) — regex existence only, no span " +
        "capture. Re-recorded 2026-11-13 for the §4a intent law (brief §4): the OLD corpus pinned the " +
        "ASCII-\\b quirks, INTENT_ORDER precedence and confidence 1 as contracts; brief §6 reclassifies " +
        "those as legacy defects, so their pins moved to the OPPOSITE behavior. F02 2026-11-16 re-record adds the polite-desire cues, the " + "cognitive/report frame law and the explicit multi-deliverable record; the decided_by pin " + "vocabulary changed from -ambiguous to -multiple, and a plain miss now records -none instead of " + "claiming -match. Every changed pin is the intended new law, verified against the live oracle.",
      harness: HARNESS,
      env: {},
      normalization: "none — deterministic zero-network function",
    });
    expect(vectors.length).toBeGreaterThanOrEqual(55);
  });
});

describe("golden: Part 3 mode-contract byte hashes (skills/06)", () => {
  it("records sha256/bytes/utf16 for every MODE_CONTRACTS entry", () => {
    const entries = (Object.keys(MODE_CONTRACTS) as RendererMode[]).map((mode) => {
      const c = MODE_CONTRACTS[mode];
      if (c === null) return { mode, present: false as const };
      return {
        mode,
        present: true as const,
        sha256: createHash("sha256").update(c, "utf8").digest("hex"),
        bytes: Buffer.byteLength(c, "utf8"),
        utf16Length: c.length,
      };
    });
    expect(entries).toHaveLength(7); // 6 artifact modes + standard_chat(null) — 3d_asset/cad_blueprint retired 2026-11-06, anatomy 2026-11-07
    writeJsonFixture("skills/06-mode-contracts-hashes.json", { entries }, {
      scenario: "MODE_CONTRACTS content hashes — binds the generated Rust contract constants",
      semantics:
        "rust-backend/scripts/gen-mode-contracts.mjs imports this same module and emits escaped Rust " +
        "literals; the fixture's hashes prove the emitted bytes match the live TS contracts exactly.",
      comparison: "byte-exact",
      harness: HARNESS,
      env: {},
      normalization: "none",
    });
  });
});
