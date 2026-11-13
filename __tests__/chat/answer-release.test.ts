/**
 * WS06 (audit 2026-11-05 item 6 — "grounded answer release") as amended by
 * the 2026-11-13 brief: the release audit enforces CITATION INTEGRITY ONLY
 * (a [S#] marker resolving to no server-minted source is a broken reference
 * — stripped with residue cleanup; research-claiming wording with no
 * retrieval gets the ledger-computed SERVER_CHECK_LINE). The diagnosis is
 * INTERNAL TELEMETRY ONLY — it rides the server log and never reaches the
 * human or the model. These tests pin the semantics on the vendored
 * cross-language matrix (rust-backend/fixtures/answer-release/matrix.json),
 * the ONE truth shared byte-for-byte with the Rust mirror (crates/
 * ruke-server/src/chat/answer_release.rs ⇔ web_loop.rs wiring).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  auditResearchAnswer,
  SERVER_CHECK_LINE,
  diagnoseResearchAnswer,
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
    expect(matrix.cases.length).toBeGreaterThanOrEqual(17);
    // The server-check line is byte-locked by the fixture, not by either
    // implementation drifting from the other.
    expect(SERVER_CHECK_LINE).toBe(matrix.serverCheckLine);
    // 2026-11-13 brief: the harness-feedback message is CLOSED. The matrix
    // carries no feedback contract in either language.
    expect(JSON.stringify(matrix)).not.toContain("Harness feedback");
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
    // are never qualified — semantic support is the model's job, and the
    // harness's diagnosis of it is log telemetry only.
    expect(auditResearchAnswer("Boreal costs $99 [S1].", ["S1"], true)).toBe("Boreal costs $99 [S1].");
    expect(auditResearchAnswer("Boreal costs $99 [S9].", ["S1"], true)).toBe("Boreal costs $99.");
  });

  it("no retrieval AND no citation map: every claim stays; only research-wording is flagged", () => {
    const out = auditResearchAnswer("The weather is nice.", [], false);
    expect(out).toBe("The weather is nice.");
  });
});

/* ── Answer diagnosis (MHR-D 2026-11-05; CLOSED to telemetry 2026-11-13):
 *    the SAME detectors, REPORT ONLY, written to the server log. No model-
 *    facing message, no retraction, no regeneration. The `diagnose` matrix
 *    section drives BOTH languages (Rust: answer_release.rs tests); the
 *    date law and hedge law are pinned there. ─────────────────────────── */

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
}

describe("answer diagnosis (telemetry-only) — vendored matrix (TS side)", () => {
  const cases = (matrix.diagnose?.cases ?? []) as DiagnoseCase[];

  it("the diagnose section exists and is non-trivial", () => {
    expect(Array.isArray(matrix.diagnose?.cases)).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(13);
  });

  for (const c of cases) {
    it(c.name, () => {
      const d = diagnoseResearchAnswer(c.text, c.citations, c.retrieved);
      expect(d).toEqual(c.expected);
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

/* ── MHR-F (WS26, 2026-11-06; 2026-11-13 amendment): citation-integrity vs
 *    semantic-support separation. The harness enforces INTEGRITY (a [S#]
 *    marker that resolves to no minted source is a broken reference —
 *    stripped) and NOTHING SEMANTIC (no "(unverified)" rewrites on release;
 *    minted citations are never removed). SEMANTIC SUPPORT is the model's;
 *    the harness's diagnosis is INTERNAL LOG TELEMETRY — it never reaches
 *    the model as a message and never changes a released byte. The
 *    `separation` matrix section drives BOTH languages byte-exactly. ──── */

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
}

describe("MHR-F release law — vendored matrix (TS side)", () => {
  const releaseCases = (matrix.separation?.releaseCases ?? []) as ReleaseCase[];
  const separationCases = (matrix.separation?.separationCases ?? []) as SeparationCase[];

  it("the separation section exists and is non-trivial", () => {
    expect(Array.isArray(matrix.separation?.releaseCases)).toBe(true);
    expect(releaseCases.length).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(matrix.separation?.separationCases)).toBe(true);
    expect(separationCases.length).toBeGreaterThanOrEqual(5);
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
  const separationCases = (matrix.separation?.separationCases ?? []) as SeparationCase[];

  for (const c of separationCases) {
    it(c.name, () => {
      // Release side: the harness's integrity layer ONLY.
      expect(auditResearchAnswer(c.text, c.citations, c.retrieved)).toBe(c.expectedRelease);
      // Telemetry side: the SAME input reports the full semantic state to
      // the log — yet zero bytes of the release differ. A diagnosis flag
      // decides nothing user-visible (false-positive volatile matches
      // included; the hedge law holds).
      const d = diagnoseResearchAnswer(c.text, c.citations, c.retrieved);
      expect(d).toEqual(c.expectedDiagnosis);
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
