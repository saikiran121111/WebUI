/**
 * WS06 (audit 2026-11-05 item 6 — "grounded answer release"): the web tool
 * loop may not release a research answer before a SERVER-enforced
 * action/citation/claim check. A prompt or an attached ledger is not
 * enforcement — these tests pin the deterministic repair semantics on the
 * vendored cross-language matrix
 * (rust-backend/fixtures/answer-release/matrix.json), the ONE truth shared
 * byte-for-byte with the Rust mirror (crates/ruke-server/src/chat/
 * answer_release.rs ⇔ web_loop.rs wiring).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  auditResearchAnswer,
  SERVER_CHECK_LINE,
  diagnoseResearchAnswer,
  answerFeedbackNeeded,
  buildAnswerFeedback,
} from "@/lib/chat/answer-release";

const matrixPath = path.join(process.cwd(), "rust-backend", "fixtures", "answer-release", "matrix.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf-8"));

interface MatrixCase {
  name: string;
  text: string;
  citations: string[];
  retrieved: boolean;
  expected: string;
}

describe("answer release audit — vendored matrix (WS06, TS side)", () => {
  it("the matrix is present and non-trivial", () => {
    expect(Array.isArray(matrix.cases)).toBe(true);
    expect(matrix.cases.length).toBeGreaterThanOrEqual(15);
    // The server-check line is byte-locked by the fixture, not by either
    // implementation drifting from the other.
    expect(SERVER_CHECK_LINE).toBe(matrix.serverCheckLine);
  });

  for (const c of matrix.cases as MatrixCase[]) {
    it(c.name, () => {
      expect(auditResearchAnswer(c.text, c.citations, c.retrieved)).toBe(c.expected);
    });
  }

  it("the audit is idempotent — re-releasing a released answer changes nothing", () => {
    for (const c of matrix.cases as MatrixCase[]) {
      const once = auditResearchAnswer(c.text, c.citations, c.retrieved);
      // Idempotency law: persisted/replayed text never accumulates
      // qualifiers or duplicated server-check lines.
      expect(auditResearchAnswer(once, c.citations, c.retrieved)).toBe(once);
    }
  });

  it("the server-check line appears at most once and only at the start", () => {
    const out = auditResearchAnswer(
      "According to my searches, X leads. As my research shows, X is the best.",
      [],
      false,
    );
    const occurrences = out.split(SERVER_CHECK_LINE).length - 1;
    expect(occurrences).toBe(1);
    expect(out.startsWith(SERVER_CHECK_LINE + "\n")).toBe(true);
  });

  it("positive control: a fabricated-invalid citation cannot pass by being well-formed", () => {
    // [S1] is VALID here; the defect fixture deliberately uses [S9]. The
    // check keys on the citation MAP, never on marker shape. MHR-F law:
    // the broken REFERENCE is stripped (integrity); the sentence's words
    // are never qualified (semantics is the model's job via feedback).
    expect(auditResearchAnswer("Boreal costs $99 [S1].", ["S1"], true)).toBe("Boreal costs $99 [S1].");
    expect(auditResearchAnswer("Boreal costs $99 [S9].", ["S1"], true)).toBe("Boreal costs $99.");
  });

  it("no retrieval AND no citation map: every claim stays; only research-wording is flagged", () => {
    const out = auditResearchAnswer("The weather is nice.", [], false);
    expect(out).toBe("The weather is nice.");
  });
});

/* ── MHR-D (brief 2026-11-05): non-destructive diagnosis + one byte-locked
 *    harness-feedback message. The SAME mhrD matrix section drives BOTH
 *    languages (Rust: answer_release.rs tests). Diagnosis REPORTS the actual
 *    server state; it rewrites nothing. MHR-F (WS26) closed the half-state:
 *    the `cases` release audit now enforces CITATION INTEGRITY ONLY, and
 *    semantic support rides the diagnosis→feedback channel alone. ──────── */

interface Diagnosis {
  unresolved: string[];
  available: string[];
  unsupported: string[];
  claimsResearch: boolean;
}

interface DiagnoseCase {
  name: string;
  text: string;
  citations: string[];
  retrieved: boolean;
  expected: Diagnosis;
  feedback: string;
}

describe("MHR-D answer diagnosis — vendored matrix (TS side)", () => {
  const cases = (matrix.mhrD?.diagnoseCases ?? []) as DiagnoseCase[];

  it("the mhrD section exists and is non-trivial", () => {
    expect(Array.isArray(matrix.mhrD?.diagnoseCases)).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const c of cases) {
    it(c.name, () => {
      const d = diagnoseResearchAnswer(c.text, c.citations, c.retrieved);
      expect(d).toEqual(c.expected);
      expect(answerFeedbackNeeded(d)).toBe(c.feedback !== "");
      if (c.feedback !== "") expect(buildAnswerFeedback(d)).toBe(c.feedback);
    });
  }

  it("diagnosis is non-destructive — the same text is REPORTED verbatim, integrity-only release", () => {
    const d = diagnoseResearchAnswer("Boreal costs $99 [S9] per seat.", ["S1"], true);
    expect(d.unsupported).toEqual(["Boreal costs $99 [S9] per seat."]); // verbatim original
    expect(auditResearchAnswer("Boreal costs $99 [S9] per seat.", ["S1"], true)).toBe(
      "Boreal costs $99 per seat.",
    );
  });
});

/* ── MHR-F (WS26, 2026-11-06): citation-integrity vs semantic-support
 *    separation. The harness enforces INTEGRITY (a [S#] marker that
 *    resolves to no minted source is a broken reference — stripped) and
 *    NOTHING SEMANTIC (no "(unverified)" rewrites on release; minted
 *    citations are never removed). SEMANTIC SUPPORT is reported to the
 *    model once via the mhrD diagnosis/feedback. The mhrF matrix section
 *    drives BOTH languages byte-exactly (Rust: answer_release.rs tests). ── */

interface ReleaseCase {
  name: string;
  text: string;
  citations: string[];
  retrieved: boolean;
  expected: string;
}

interface SeparationCase {
  name: string;
  text: string;
  citations: string[];
  retrieved: boolean;
  expectedRelease: string;
  expectedDiagnosis: Diagnosis;
  feedback: string;
}

describe("MHR-F release law — vendored matrix (TS side)", () => {
  const releaseCases = (matrix.mhrF?.releaseCases ?? []) as ReleaseCase[];
  const separationCases = (matrix.mhrF?.separationCases ?? []) as SeparationCase[];

  it("the mhrF section exists and is non-trivial", () => {
    expect(Array.isArray(matrix.mhrF?.releaseCases)).toBe(true);
    expect(releaseCases.length).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(matrix.mhrF?.separationCases)).toBe(true);
    expect(separationCases.length).toBeGreaterThanOrEqual(3);
  });

  for (const c of releaseCases) {
    it(c.name, () => {
      const out = auditResearchAnswer(c.text, c.citations, c.retrieved);
      expect(out).toBe(c.expected);
      // Idempotency law survives the separation: re-release changes nothing.
      expect(auditResearchAnswer(out, c.citations, c.retrieved)).toBe(out);
    });
  }
});

describe("MHR-F integrity/semantics separation — vendored matrix (TS side)", () => {
  const separationCases = (matrix.mhrF?.separationCases ?? []) as SeparationCase[];

  for (const c of separationCases) {
    it(c.name, () => {
      // Release side: the harness's integrity layer ONLY.
      expect(auditResearchAnswer(c.text, c.citations, c.retrieved)).toBe(c.expectedRelease);
      // Model side: the SAME input still reports the full semantic state —
      // the feedback contract is byte-locked and unchanged from MHR-D.
      const d = diagnoseResearchAnswer(c.text, c.citations, c.retrieved);
      expect(d).toEqual(c.expectedDiagnosis);
      expect(answerFeedbackNeeded(d)).toBe(c.feedback !== "");
      if (c.feedback !== "") expect(buildAnswerFeedback(d)).toBe(c.feedback);
    });
  }

  it("a minted citation is NEVER removed by any release check (anti-silent-removal law)", () => {
    // Every case under MHR-F keeps every resolvable [S#] byte-intact:
    // removal happens ONLY for markers that resolve to nothing.
    const cases: Array<[string, string[]]> = [
      ["Boreal costs $99 [S1] per seat.", ["S1"]],
      ["Boreal supports SAML [S1] and SCIM [S7].", ["S1", "S7"]],
      ["See [S1], [S2] and [S3].", ["S1", "S2", "S3"]],
      ["Mixed [S1] real and [S9] fake in one [S2].", ["S1", "S2"]],
    ];
    for (const [text, ids] of cases) {
      const out = auditResearchAnswer(text, ids, true);
      for (const id of ids) expect(out).toContain(`[${id}]`);
    }
  });
});
