import { describe, it, expect } from "vitest";
import { recalcWorkbook, formulaLooksValid, FORMULA_FUNCTIONS, type RecalcSheet } from "@/lib/documents/recalc";

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

// ---------- PART 2: expanded function whitelist, one unit test per function ----------
const DATA: Record<string, { value: string | number | boolean | null }> = {
  A1: { value: 10 }, A2: { value: 20 }, A3: { value: 30 },
  B1: { value: "apple" }, B2: { value: "banana" }, B3: { value: "apple" },
  C1: { value: 100 }, C2: { value: 200 }, C3: { value: 300 },
  D1: { value: "2026-01-15" }, D2: { value: "2026-02-20" }, D3: { value: "2025-03-10" },
  E1: { value: -100 }, E2: { value: 110 },
};

/** Evaluate one formula against the shared DATA grid; throws on any error. */
function calc(formula: string): string | number | boolean {
  const cells = { ...DATA, F1: { formula } } as Record<string, { formula?: string; value?: string | number | boolean | null }>;
  const { errors, computed } = recalcWorkbook([sheet("S1", cells, 3, 6)]);
  if (errors.length) throw new Error(`${errors[0].error} for ${errors[0].formula}`);
  return computed.get("S1!F1") as string | number | boolean;
}

describe("expanded formula whitelist (PART 2)", () => {
  it("whitelist pins every documented function", () => {
    expect(FORMULA_FUNCTIONS).toEqual(expect.arrayContaining([
      "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "PRODUCT",
      "ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "ABS", "MOD", "POWER", "SQRT",
      "IF", "IFS", "IFERROR", "IFNA", "AND", "OR", "NOT",
      "SUMIF", "SUMIFS", "COUNTIF", "COUNTIFS", "AVERAGEIF", "AVERAGEIFS", "SUMPRODUCT",
      "INDEX", "MATCH", "VLOOKUP", "XLOOKUP", "NPV", "IRR",
      "DATE", "YEAR", "MONTH", "DAY", "EDATE", "EOMONTH", "TODAY",
      "LEN", "TRIM", "UPPER", "LOWER", "CONCAT", "CONCATENATE", "TEXTJOIN",
    ]));
  });

  it("SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/PRODUCT", () => {
    expect(calc("=SUM(A1:A3)")).toBe(60);
    expect(calc("=AVERAGE(A1:A3)")).toBe(20);
    expect(calc("=MIN(A1:A3)")).toBe(10);
    expect(calc("=MAX(A1:A3)")).toBe(30);
    expect(calc("=COUNT(A1:A3)")).toBe(3);
    expect(calc("=COUNTA(B1:B3)")).toBe(3);
    expect(calc("=PRODUCT(A1:A2)")).toBe(200);
  });

  it("ROUND/ROUNDUP/ROUNDDOWN/INT/ABS/MOD/POWER/SQRT (sign-aware)", () => {
    expect(calc("=ROUND(2.5,0)")).toBe(3);
    expect(calc("=ROUNDUP(1.111,2)")).toBe(1.12);
    expect(calc("=ROUNDUP(-1.111,2)")).toBe(-1.12);
    expect(calc("=ROUNDDOWN(1.999,2)")).toBe(1.99);
    expect(calc("=INT(-2.5)")).toBe(-3);
    expect(calc("=ABS(-7)")).toBe(7);
    expect(calc("=MOD(10,3)")).toBe(1);
    expect(calc("=MOD(-10,3)")).toBe(2); // Excel semantics: sign follows divisor
    expect(calc("=POWER(3,4)")).toBe(81);
    expect(calc("=SQRT(144)")).toBe(12);
  });

  it("IF/IFS/IFERROR/IFNA/AND/OR/NOT short-circuit correctly", () => {
    expect(calc("=IF(A1>15,\"big\",\"small\")")).toBe("small");
    expect(calc("=IFS(A1>15,\"x\",A1<15,\"y\")")).toBe("y");
    expect(calc("=IFERROR(1/0,\"caught\")")).toBe("caught");
    expect(calc("=IFNA(MATCH(\"zzz\",B1:B3,0),\"na\")")).toBe("na");
    expect(calc("=AND(A1>5,A2>15)")).toBe(true);
    expect(calc("=OR(A1>15,A2>15)")).toBe(true);
    expect(calc("=NOT(A1>15)")).toBe(true);
    // text-vs-text equality must NOT raise #VALUE! (regression: eager toNum)
    expect(calc("=IF(B1=\"apple\",\"PASS\",\"FAIL\")")).toBe("PASS");
    expect(calc("=IF(B1=\"Apple\",\"PASS\",\"FAIL\")")).toBe("PASS"); // case-insensitive
    expect(calc("=IF(B1<>\"banana\",\"PASS\",\"FAIL\")")).toBe("PASS");
  });

  it("SUMIF/SUMIFS/COUNTIF/COUNTIFS/AVERAGEIF/AVERAGEIFS with criteria strings", () => {
    expect(calc("=SUMIF(A1:A3,\">15\")")).toBe(50);
    expect(calc("=SUMIF(A1:A3,\">=20\",C1:C3)")).toBe(500);
    expect(calc("=SUMIFS(C1:C3,A1:A3,\">=20\",B1:B3,\"apple\")")).toBe(300);
    expect(calc("=COUNTIF(B1:B3,\"apple\")")).toBe(2);
    expect(calc("=COUNTIFS(A1:A3,\">=20\",B1:B3,\"apple\")")).toBe(1);
    expect(calc("=AVERAGEIF(A1:A3,\">=20\")")).toBe(25);
    expect(calc("=AVERAGEIF(A1:A3,\">=20\",C1:C3)")).toBe(250);
    expect(calc("=AVERAGEIFS(C1:C3,A1:A3,\">=20\")")).toBe(250);
  });

  it("INDEX/MATCH/VLOOKUP/XLOOKUP resolve lookups", () => {
    expect(calc("=INDEX(C1:C3,2)")).toBe(200);
    expect(calc("=INDEX(C1:C3,MATCH(\"banana\",B1:B3,0))")).toBe(200);
    expect(calc("=VLOOKUP(\"banana\",B1:C3,2,FALSE)")).toBe(200);
    expect(calc("=XLOOKUP(\"apple\",B1:B3,C1:C3)")).toBe(100);
    expect(calc("=XLOOKUP(\"zzz\",B1:B3,C1:C3,\"none\")")).toBe("none");
  });

  it("NPV discounts each cash flow; IRR bisects to the zero-NPV rate", () => {
    expect(calc("=NPV(0.1,100,200)")).toBeCloseTo(100 / 1.1 + 200 / 1.21, 6);
    expect(calc("=IRR(E1:E2)")).toBeCloseTo(0.1, 6); // -100 → +110 ⇒ exactly 10%
  });

  it("DATE/YEAR/MONTH/DAY/EDATE/EOMONTH/TODAY use Excel serials", () => {
    expect(calc("=YEAR(DATE(2026,1,15))")).toBe(2026);
    expect(calc("=MONTH(DATE(2026,1,15))")).toBe(1);
    expect(calc("=DAY(DATE(2026,1,15))")).toBe(15);
    expect(calc("=EDATE(DATE(2026,1,31),1)")).toBe(calc("=DATE(2026,2,28)")); // day clamps to month end
    expect(calc("=EOMONTH(DATE(2026,2,5),0)")).toBe(calc("=DATE(2026,2,28)"));
    expect(calc("=YEAR(TODAY())")).toBe(new Date().getFullYear());
  });

  it("LEN/TRIM/UPPER/LOWER/CONCAT/CONCATENATE/TEXTJOIN text functions", () => {
    expect(calc("=LEN(\"hello\")")).toBe(5);
    expect(calc("=TRIM(\"  a  b  \")")).toBe("a b");
    expect(calc("=UPPER(\"ab\")")).toBe("AB");
    expect(calc("=LOWER(\"AB\")")).toBe("ab");
    expect(calc("=CONCAT(\"a\",\"b\",1)")).toBe("ab1");
    expect(calc("=CONCATENATE(\"x\",2)")).toBe("x2");
    expect(calc("=_xlfn.TEXTJOIN(\", \",TRUE,\"a\",\"\",\"b\")")).toBe("a, b");
  });

  it("SUMPRODUCT handles arrays, boolean masks and scalar mapping (YEAR/MONTH over ranges)", () => {
    expect(calc("=SUMPRODUCT(A1:A3,C1:C3)")).toBe(14000);
    expect(calc("=SUMPRODUCT((A1:A3>15)*1)")).toBe(2);
    // The exact Scenarios-sheet expression: date strings → YEAR/MONTH map
    // element-wise, comparisons yield boolean arrays, * is element-wise.
    expect(calc("=SUMPRODUCT((YEAR(D1:D3)=2026)*(MONTH(D1:D3)=1)*A1:A3)")).toBe(10);
  });

  it("new error codes: #NUM! (SQRT/IRR), #DIV/0! (MOD/AVERAGEIF), IFNA rethrows non-#N/A", () => {
    const s = sheet("E1", {
      A1: { value: 1 },
      B1: { formula: "=SQRT(-1)" },
      B2: { formula: "=MOD(5,0)" },
      B3: { formula: "=IRR(A1:A1)" },
      B4: { formula: "=IFNA(1/0,\"x\")" },
      B5: { formula: "=AVERAGEIF(A1:A1,\">5\")" },
    }, 1, 2);
    const { errors } = recalcWorkbook([s]);
    expect(errors.map((e) => e.error).sort()).toEqual(["#DIV/0!", "#DIV/0!", "#DIV/0!", "#NUM!", "#NUM!"]);
  });
});
