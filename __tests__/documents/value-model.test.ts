/**
 * F11 value model — the rules that stop the engines from inventing measurements.
 * Pinned here so every consumer (xlsx engine, Power BI dataset, preview, width
 * fitting) is held to one authority instead of four local coercions.
 */
import { describe, it, expect } from "vitest";
import {
  parseCellValue, parseNumericLiteral, looksMissing, displayValue,
  columnNumFmt, parseStrictNumber,
} from "@/lib/documents/valueModel";

describe("valueModel: literal reading", () => {
  it("reads thousands separators, accounting negatives and signs", () => {
    expect(parseNumericLiteral("1,234.50")).toEqual({ num: 1234.5, percent: false, currency: undefined });
    expect(parseNumericLiteral("(2,000)")).toEqual({ num: -2000, percent: false, currency: undefined });
    expect(parseNumericLiteral("-$1,200")).toEqual({ num: -1200, percent: false, currency: "$" });
    expect(parseNumericLiteral("12%")).toEqual({ num: 12, percent: true, currency: undefined });
    expect(parseNumericLiteral("1.5e3")).toEqual({ num: 1500, percent: false, currency: undefined });
  });

  it("keeps non-$ currency and ISO codes as provenance instead of becoming NaN", () => {
    expect(parseNumericLiteral("\u20B91,200")).toEqual({ num: 1200, percent: false, currency: "\u20B9" });
    expect(parseNumericLiteral("USD 1,200")).toEqual({ num: 1200, percent: false, currency: "USD" });
    expect(parseNumericLiteral("\u00A39.99")).toEqual({ num: 9.99, percent: false, currency: "\u00A3" });
  });

  it("REFUSES to strip units: text with a trailing unit is not a number", () => {
    expect(parseNumericLiteral("12 kg")).toBeNull();
    expect(parseNumericLiteral("12.5 m/s")).toBeNull();
    expect(parseNumericLiteral("Q1 2025")).toBeNull();
    expect(parseNumericLiteral("unknown")).toBeNull();
    expect(parseNumericLiteral("12abc")).toBeNull();
  });

  it("recognizes absence without touching text content", () => {
    expect(looksMissing(null)).toBe(true);
    expect(looksMissing("   ")).toBe(true);
    expect(looksMissing("N/A")).toBe(true);
    expect(looksMissing("-")).toBe(true);
    expect(looksMissing("-4")).toBe(false);
    expect(looksMissing("none of the above")).toBe(false);
  });

  it("parseStrictNumber never turns a word into 0", () => {
    expect(parseStrictNumber("OVERSPEND")).toBeNull();
    expect(parseStrictNumber("12%")).toBeNull();
    expect(parseStrictNumber("12")).toBe(12);
    expect(parseStrictNumber(0)).toBe(0);
    expect(parseStrictNumber(null)).toBeNull();
  });
});

describe("valueModel: numeric formats never fabricate", () => {
  it("leaves a missing numeric cell empty by default", () => {
    const r = parseCellValue(null, { format: "currency" });
    expect(r.value).toBeNull();
    expect(r.issue?.reason).toBe("missing_value");
    expect(r.issue?.action).toMatch(/invent/);
    expect(parseCellValue("", { format: "number" }).value).toBeNull();
    expect(parseCellValue("N/A", { format: "integer" }).value).toBeNull();
  });

  it("keeps unparseable text verbatim instead of inventing 0", () => {
    const r = parseCellValue("unknown", { format: "number" });
    expect(r.value).toBe("unknown");
    expect(r.numFmt).toBe("@");
    expect(r.issue?.reason).toBe("not_a_number");
  });

  it("honours an explicit imputation decision", () => {
    expect(parseCellValue(null, { format: "number", nullPolicy: "zero" })).toMatchObject({ value: 0 });
    expect(parseCellValue(null, { format: "number", nullPolicy: "zero" }).issue?.reason).toBe("imputed_zero");
    expect(parseCellValue(null, { format: "number", nullPolicy: "text" })).toMatchObject({ value: "N/A" });
  });

  it("non-finite input is absence, not a measurement", () => {
    const r = parseCellValue(Number.NaN, { format: "number" });
    expect(r.value).toBeNull();
    expect(r.issue?.reason).toBe("non_finite");
  });

  it("text/date columns keep their content (and their N/A placeholder)", () => {
    expect(parseCellValue(null, { format: "text" })).toMatchObject({ value: "N/A" });
    expect(parseCellValue("-", { format: "text" })).toMatchObject({ value: "-" });
    expect(parseCellValue("2025-01-31", { format: "date" })).toMatchObject({ value: "2025-01-31" });
  });
});

describe("valueModel: percent scale is declared, never guessed", () => {
  it("a literal % declares points and becomes a fraction", () => {
    expect(parseCellValue("12%", { format: "percent" })).toMatchObject({ value: 0.12, numFmt: "0.0%" });
    expect(parseCellValue(12, { format: "percent", percentScale: "points" })).toMatchObject({ value: 0.12, numFmt: "0.0%" });
    expect(parseCellValue(0.12, { format: "percent", percentScale: "fraction" })).toMatchObject({ value: 0.12, numFmt: "0.0%" });
  });

  it("a bare number in a percent column is left un-scaled and reported", () => {
    for (const v of [12, 0.12]) {
      const r = parseCellValue(v, { format: "percent" });
      expect(r.value).toBe(v);
      expect(r.numFmt).toBe("#,##0.00");
      expect(r.issue?.reason).toBe("percent_scale_undeclared");
      expect(displayValue(r.value, { format: "percent" })).not.toMatch(/%/);
    }
  });

  it("the % in a non-percent column is reported, not silently absorbed", () => {
    const r = parseCellValue("12%", { format: "currency" });
    expect(r.value).toBe(12);
    expect(r.issue?.reason).toBe("percent_in_non_percent_column");
  });
});

describe("valueModel: currency and units", () => {
  it("formats the declared currency instead of hardcoding $", () => {
    expect(parseCellValue(1200, { format: "currency", currency: "\u20B9" })).toMatchObject({ numFmt: '"\u20B9"#,##0.00' });
    expect(displayValue(1200, { format: "currency", currency: "\u20AC" })).toBe("\u20AC1,200.00");
    expect(columnNumFmt({ format: "currency" })).toBe("$#,##0.00");
  });

  it("a literal currency that contradicts the column keeps the literal and reports it", () => {
    const r = parseCellValue("\u20B91,200", { format: "currency", currency: "$" });
    expect(r.value).toBe(1200);
    expect(r.numFmt).toBe('"\u20B9"#,##0.00');
    expect(r.issue?.reason).toBe("currency_mismatch");
  });

  it("a symbol in a plain number column is reported as dropped", () => {
    const r = parseCellValue("\u20B91,200", { format: "number" });
    expect(r.value).toBe(1200);
    expect(r.issue?.reason).toBe("currency_dropped");
  });

  it("booleans stay booleans", () => {
    const r = parseCellValue(true, { format: "number" });
    expect(r.value).toBe(true);
    expect(r.issue?.reason).toBe("boolean_value");
  });

  it("blank cells have no display text (no phantom 0 in the preview)", () => {
    expect(displayValue(null, { format: "currency" })).toBe("");
  });
});