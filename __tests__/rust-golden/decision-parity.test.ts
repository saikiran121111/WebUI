/**
 * Golden corpus — Part 3 decision-intent + core-skill contracts parity.
 *
 * Direct (non-HTTP) oracle calls: `getDecisionSync` from lib/decision/client
 * (the in-process regex router — zero network, deterministic) and
 * `MODE_CONTRACTS` from lib/decision/contracts. Recorded fixtures are
 * replayed byte-for-byte by `crates/ruke-decision/tests/fixture_replay.rs`.
 *
 * decision/06 pins the regex word-boundary quirks JS exhibits (ASCII-only
 * \b: "caféexcel" matches, "pdfx" does not; "résumé" ends on a NON-word
 * char so its trailing boundary demands a WORD char next; the dotted
 * \.docx alternatives are dominated by their bare siblings; INTENT_ORDER
 * precedence pins).
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
// side must reproduce active_mode + skill_to_load + decided_by + trim for
// each one. Never hand-write expected outputs here: the oracle IS the spec.
const VECTORS: string[] = [
  // — positives, one cluster per matcher —
  "put these numbers into my spreadsheet", "an Excel file please", "open the .xlsx", "the workbook tab", "export as xlsx",
  "write a word document", "a worddocument template", "attach the .docx", "generate docx output", "update my resume today", "make me a cv",
  "print this pdf",
  "build a power point", "a powerpoint deck", "give me a presentation", "save the .pptx", "export pptx now", "the deck outline",
  "chart the revenue",
  "a 3D model viewer", "three.js demo", "threejs scene", "render scene", "model the scene", "visualize mesh parts",
  "draw a floor plan", "floorplan of the attic", "an architect's sketch", "an architectural drawing", "the blueprint sheet", "the building section", "room layout v2", "interior elevations",
  "a web page mock", "the webpage header", "landing page copy", "landingpage hero", "pure html please", "interactive ui", "interactive page demo", "interactive prototype", "an interactive demo",
  // — ASCII \b quirks the Rust port must share —
  "caféexcel", "the pdfx file", "what is excelent", "charts", "cvx", "htmlx dashboard", "threejss", "3 d",
  "render\nscene", "word  document", "word-document", "power  point",
  "résumé", "my résumé", "résumé2", "résumébuilder",
  "file.docx", "file.xlsx", "file.pptx",
  // — INTENT_ORDER precedence —
  "presentation in pdf format", "the interior of the pdf", "3d chart", "chart of this building's architecture",
  "spreadsheet and a chart", "3D building model", "interior design with html", "an architectural sketch",
  "tell me a joke", "a model of the city",
  // — trim / case behavior —
  "   make a deck \t", "PDF REPORT", "Excel",
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
      };
    });

    // Spot-checks that the recorded corpus actually captures the quirks
    // (guards the fixture itself, not the Rust side).
    const at = (p: string) => vectors.find((v) => v.prompt === p)!;
    expect(at("résumébuilder").active_mode).toBe("docs");
    expect(at("résumé").active_mode).toBe("standard_chat"); // no trailing boundary after é
    expect(at("my résumé").active_mode).toBe("standard_chat");
    expect(at("résumé2").active_mode).toBe("docs");
    expect(at("file.docx").active_mode).toBe("docs");
    expect(at("caféexcel").active_mode).toBe("excel");
    expect(at("3d chart").active_mode).toBe("chart");
    expect(at("render\nscene").active_mode).toBe("standard_chat");
    expect(at("render scene").active_mode).toBe("3d_asset");
    expect(at("   make a deck \t").stripped_prompt).toBe("make a deck");
    expect(at("tell me a joke").decided_by).toBe("in-process-deliverable-match");

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
      scenario: "getDecisionSync intent-matcher vectors + blank-message fallback envelope",
      semantics:
        "Pure in-process regex router: ASCII \\b semantics (café boundaries, é-ending résumé demands a " +
        "word char next, dotted \\.docx dominated by bare docx), JS '.' never crosses \\n (render\\nscene " +
        "misses), INTENT_ORDER first-match precedence, JS trim() for stripped_prompt, internal-only " +
        "fallbackEnvelope for blank input.",
      comparison: "semantic",
      notes:
        "Field-for-field (mode/skill/decided_by/trim) — regex existence only, no span capture.",
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
    expect(entries).toHaveLength(9); // 8 artifact modes + standard_chat(null)
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
