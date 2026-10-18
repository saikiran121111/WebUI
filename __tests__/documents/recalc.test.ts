import { describe, it, expect } from "vitest";
import { recalcWorkbook, formulaLooksValid, type RecalcSheet } from "@/lib/documents/recalc";

function sheet(name: string, cells: Record<string, { formula?: string; value?: string | number | boolean | null }>, rows: number, cols: number): RecalcSheet {
  return { name, rowCount: rows, colCount: cols, cells: new Map(Object.entries(cells)) };
}

describe("headless formula recalculation", () => {
  it("evaluates SUM/AVERAGE/ROUND/IFERROR correctly", () => {
    const s = sheet("S1", {
      A1: { value: 10 }, A2: { value: 20 }, A3: { value: 30 },
      B1: { formula: "=SUM(A1:A3)" },
      B2: { formula: "=AVERAGE(A1:A3)" },
      B3: { formula: "=ROUND(A1/3, 2)" },
      B4: { formula: "=IFERROR(1/0, -1)" },
    }, 4, 2);
    const { errors, computed } = recalcWorkbook([s]);
    expect(errors).toEqual([]);
    expect(computed.get("S1!B1")).toBe(60);
    expect(computed.get("S1!B2")).toBe(20);
    expect(computed.get("S1!B4")).toBe(-1);
  });

  it("IF short-circuits so the false branch never raises #DIV/0!", () => {
    const s = sheet("S1", {
      A1: { value: 0 }, B1: { value: 5 },
      C1: { formula: "=IF(A1>0, B1/A1, 0)" },
    }, 1, 3);
    const { errors, computed } = recalcWorkbook([s]);
    expect(errors).toEqual([]);
    expect(computed.get("S1!C1")).toBe(0);
  });

  it("detects #DIV/0!, #NAME?, #REF! (circular) and #N/A (MATCH miss)", () => {
    const s = sheet("S1", {
      A1: { value: 0 },
      B1: { formula: "=5/A1" },
      B2: { formula: "=FOO(1)" },
      B3: { formula: "=B3+1" },
      B4: { formula: "=MATCH(\"nope\", A1:A1, 0)" },
    }, 4, 2);
    const { errors } = recalcWorkbook([s]);
    const codes = errors.map((e) => e.error).sort();
    expect(codes).toEqual(["#DIV/0!", "#N/A", "#NAME?", "#REF!"]);
  });

  it("INDEX/MATCH and cross-sheet references resolve", () => {
    const a = sheet("Data", { A1: { value: "widget" }, B1: { value: 42 } }, 1, 2);
    const b = sheet("Out", { A1: { formula: "=INDEX(Data!B1:B1, MATCH(\"widget\", Data!A1:A1, 0))" } }, 1, 1);
    const { errors, computed } = recalcWorkbook([a, b]);
    expect(errors).toEqual([]);
    expect(computed.get("Out!A1")).toBe(42);
  });

  it("_xlfn. prefixes are accepted (TEXTJOIN)", () => {
    const s = sheet("S1", { A1: { formula: '=_xlfn.TEXTJOIN(", ", TRUE, "a", "b")' } }, 1, 1);
    const { errors, computed } = recalcWorkbook([s]);
    expect(errors).toEqual([]);
    expect(computed.get("S1!A1")).toBe("a, b");
  });

  it("formulaLooksValid flags unbalanced parens and empty formulas", () => {
    expect(formulaLooksValid("=SUM(A1:A2)").ok).toBe(true);
    expect(formulaLooksValid("=SUM(A1:A2").ok).toBe(false);
    expect(formulaLooksValid("=").ok).toBe(false);
  });
});
