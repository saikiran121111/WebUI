import { describe, it, expect } from "vitest";
import { validateGrounding } from "@/lib/browser/visualGrounding";

describe("visual grounding validation — refuse ambiguity, never invent coordinates", () => {
  it("model refusal passes through as a refusal (ambiguous target)", () => {
    const r = validateGrounding({ refused: true }, 1280, 800);
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.error).toBe("model refused (ambiguous)");
  });

  it("non-numeric coordinates are refused", () => {
    const r = validateGrounding({ x: "left", y: 10, width: 50, height: 20, confidence: 0.9 }, 1280, 800);
    expect(r.refused).toBe(true);
    expect(r.error).toBe("non-numeric coordinates");
  });

  it("out-of-bounds boxes are refused (the image bounds are truth)", () => {
    const r = validateGrounding({ x: 0, y: 0, width: 2000, height: 20, confidence: 0.9 }, 1280, 800);
    expect(r.refused).toBe(true);
    expect(r.error).toBe("coordinates outside image bounds");
    expect(validateGrounding({ x: -5, y: 0, width: 10, height: 10, confidence: 0.9 }, 1280, 800).refused).toBe(true);
    expect(validateGrounding({ x: 10, y: 10, width: 0, height: 10, confidence: 0.9 }, 1280, 800).refused).toBe(true);
    // Two-pixel tolerance for rounding is allowed.
    expect(validateGrounding({ x: 0, y: 0, width: 1282, height: 802, confidence: 0.9 }, 1280, 800).ok).toBe(true);
  });

  it("low or missing confidence is refused (threshold 0.55)", () => {
    const r = validateGrounding({ x: 10, y: 10, width: 50, height: 20, confidence: 0.4 }, 1280, 800);
    expect(r.refused).toBe(true);
    expect(r.error).toContain("below threshold");
    expect(validateGrounding({ x: 10, y: 10, width: 50, height: 20 }, 1280, 800).refused).toBe(true);
  });

  it("a valid grounded box passes with label + confidence", () => {
    const r = validateGrounding(
      { x: 100, y: 100, width: 200, height: 60, label: "Canvas play button", confidence: 0.9 },
      1280,
      800,
    );
    expect(r.ok).toBe(true);
    expect(r.target).toEqual({ x: 100, y: 100, width: 200, height: 60 });
    expect(r.label).toBe("Canvas play button");
    expect(r.confidence).toBe(0.9);
  });

  it("labels are bounded to 120 chars", () => {
    const r = validateGrounding(
      { x: 0, y: 0, width: 10, height: 10, label: "L".repeat(300), confidence: 0.8 },
      1280,
      800,
    );
    expect(r.label!.length).toBe(120);
  });
});
