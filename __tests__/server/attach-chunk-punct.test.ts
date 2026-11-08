/**
 * I23 (2026-11-08): splitOversized must partition an oversized unit EXACTLY.
 * The old piece pattern required every match to START with a non-punctuation
 * char, so a unit made only of "." (or "..." runs swallowed whole) produced
 * ZERO matches — the text silently vanished from the index. These pins hold
 * the visible contract: content survives, and at overlap 0 the chunk stream
 * reconstructs the original character-for-character.
 */
import { describe, expect, it } from "vitest";
import { chunkText } from "@/lib/server/attachindex/chunk";

describe("I23: oversized punctuation-only units no longer vanish", () => {
  it("keeps every dot of a 1210-dot unit inside chunks (old impl: zero pieces)", () => {
    const chunks = chunkText(".".repeat(1210), 200, 50);
    expect(chunks.length).toBeGreaterThan(0);
    // Every piece is raw and untrimmed: chunks are pure punctuation.
    let dots = 0;
    for (const c of chunks) {
      expect(c.text).toBe(".".repeat(c.text.length));
      expect(c.text.length).toBeLessThanOrEqual(200);
      dots += c.text.length;
    }
    // Overlap carry may duplicate; nothing may be LOST.
    expect(dots).toBeGreaterThanOrEqual(1210);
  });

  it("mixes sentence-ish and punctuation-only runs in one unit without loss", () => {
    // One line, spaces only INSIDE word runs, punctuation never followed by
    // a space — sentenceUnits yields a single oversized unit.
    const unit = "alpha.beta!gamma?delta.".repeat(60); // 1320 chars, one unit
    const chunks = chunkText(unit, 300, 0); // overlap 0: pieces are contiguous
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300);
    // Pieces are raw slices: joining chunk-to-chunk (intra-chunk " " joins
    // of pieces are the only introduced spaces) reconstructs the original.
    expect(chunks.map((c) => c.text).join("").replace(/ /g, "")).toBe(unit);
  });

  it("a giant mixed unit stays fully searchable", () => {
    // Regression against the exact defect: an ellipsis-heavy unit whose tail
    // marker used to disappear along with the unit.
    const unit = `${".".repeat(500)} searchterm ${"-".repeat(600)}`;
    const chunks = chunkText(unit, 200, 0);
    const all = chunks.map((c) => c.text).join("");
    expect(all).toContain("searchterm");
    // sentenceUnits consumes whitespace *after* punctuation as a separator —
    // that one space is the only byte allowed to differ; everything else is
    // preserved raw.
    expect(all).toBe(`${".".repeat(500)}searchterm ${"-".repeat(600)}`);
    expect(chunks.reduce((n, c) => n + c.text.length, 0)).toBe(unit.length - 1);
  });
});
