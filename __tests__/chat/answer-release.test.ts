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

import { auditResearchAnswer, SERVER_CHECK_LINE } from "@/lib/chat/answer-release";

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
    // check keys on the citation MAP, never on marker shape.
    expect(auditResearchAnswer("Boreal costs $99 [S1].", ["S1"], true)).toBe("Boreal costs $99 [S1].");
    expect(auditResearchAnswer("Boreal costs $99 [S9].", ["S1"], true)).toBe(
      "Boreal costs $99 (unverified).",
    );
  });

  it("no retrieval AND no citation map: every claim stays; only research-wording is flagged", () => {
    const out = auditResearchAnswer("The weather is nice.", [], false);
    expect(out).toBe("The weather is nice.");
  });
});
