import { describe, it, expect } from "vitest";
import { recalcWorkbook, formulaLooksValid, idxToCol, type RecalcSheet } from "@/lib/documents/recalc";

// The calculation path is xlcalc@0.84.0 (see lib/documents/recalc.ts).
// These tests pin the PUBLIC contract (computed keyed "Sheet!A1", errors
// flagged by sheet+address, cycles never cached) plus the focused regressions
// the P5B-xlcalc brief demands: whole-column SUMIFS, XLOOKUP, LET, FILTER,
// MAP with LAMBDA, cross-sheet refs, invalid formulas, circular references.

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

  it("detects #DIV/0!, #NAME?, #CYCLE! (circular, flagged not cached) and #N/A (MATCH miss)", () => {
    const s = sheet("S1", {
      A1: { value: 0 },
      B1: { formula: "=5/A1" },
      B2: { formula: "=FOO(1)" },
      B3: { formula: "=B3+1" },
      B4: { formula: "=MATCH(\"nope\", A1:A1, 0)" },
    }, 4, 2);
    const { errors, computed } = recalcWorkbook([s]);
    const codes = errors.map((e) => e.error).sort();
    expect(codes).toEqual(["#CYCLE!", "#DIV/0!", "#N/A", "#NAME?"]);
    // The exact trap: a cycle can return 0 alongside its diagnostic. The cell
    // must be flagged BY SHEET AND ADDRESS and never cached as verified.
    const cycle = errors.find((e) => e.error === "#CYCLE!");
    expect(cycle).toMatchObject({ sheet: "S1", cell: "B3", formula: "=B3+1" });
    expect(cycle?.reason).toMatch(/circular/i);
    expect(computed.has("S1!B3")).toBe(false);
  });

  it("mutual circular references are all flagged and none cached", () => {
    const s = sheet("S1", {
      A1: { formula: "=B1+1" }, B1: { formula: "=A1+1" },
    }, 1, 2);
    const { errors, computed } = recalcWorkbook([s]);
    expect(errors.map((e) => e.error)).toEqual(["#CYCLE!", "#CYCLE!"]);
    expect(computed.size).toBe(0);
  });

  it("INDEX/MATCH and cross-sheet references resolve (bare and quoted sheet names)", () => {
    const a = sheet("Data", { A1: { value: "widget" }, B1: { value: 42 } }, 1, 2);
    const b = sheet("Out", {
      A1: { formula: "=INDEX(Data!B1:B1, MATCH(\"widget\", Data!A1:A1, 0))" },
      B1: { formula: "='Out'!C1+Data!B1*10" },
      C1: { value: 4 },
    }, 1, 3);
    const { errors, computed } = recalcWorkbook([a, b]);
    expect(errors).toEqual([]);
    expect(computed.get("Out!A1")).toBe(42);
    expect(computed.get("Out!B1")).toBe(424); // 4 + 42*10
  });

  it("_xlfn. prefixes are accepted (TEXTJOIN)", () => {
    const s = sheet("S1", { A1: { formula: '=_xlfn.TEXTJOIN(", ", TRUE, "a", "b")' } }, 1, 1);
    const { errors, computed } = recalcWorkbook([s]);
    expect(errors).toEqual([]);
    expect(computed.get("S1!A1")).toBe("a, b");
  });

  it("a malformed book reports per-cell #ERROR! instead of throwing", () => {
    const s = sheet("S1", { A1: { formula: "=SUM(1,2)" } }, 1, 1);
    // Illegal A1-style address in the model (the pre-xlcalc evaluator accepted
    // any key; xlcalc validates — the adapter must report, never crash).
    (s.cells as Map<string, unknown>).set("NOPE1", { formula: "=1+1" });
    const { errors, computed } = recalcWorkbook([s]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.error === "#ERROR!")).toBe(true);
    expect(computed.size).toBe(0);
  });

  it("fixed clock makes TODAY deterministic", () => {
    const s = sheet("S1", { A1: { formula: "=YEAR(TODAY())" } }, 1, 1);
    const { errors, computed } = recalcWorkbook([s], { clock: { now: "2026-11-06T00:00:00Z", seed: 7 } });
    expect(errors).toEqual([]);
    expect(computed.get("S1!A1")).toBe(2026);
  });

  it("formulaLooksValid flags unbalanced parens, empty formulas and unknown functions", () => {
    expect(formulaLooksValid("=SUM(A1:A2)").ok).toBe(true);
    expect(formulaLooksValid("=SUM(A1:A2").ok).toBe(false);
    expect(formulaLooksValid("=").ok).toBe(false);
    expect(formulaLooksValid("=FOO(1)").ok).toBe(false);
    expect(formulaLooksValid("=LET(x,1,x)").ok).toBe(true);
  });
});

// ---------- modern functions / dynamic arrays (the brief's cited cases) ----------
describe("dynamic arrays and modern functions (xlcalc)", () => {
  it("whole-column SUMIFS/COUNTIFS", () => {
    const s = sheet("Data", {
      A1: { value: "apple" }, A2: { value: "orange" }, A3: { value: "apple" },
      B1: { value: 1 }, B2: { value: 5 }, B3: { value: 10 },
      C1: { value: 100 }, C2: { value: 200 }, C3: { value: 300 },
      D1: { formula: 'SUMIFS(C:C,A:A,"apple",B:B,">=5")' },
      D2: { formula: 'COUNTIFS(A:A,"apple")' },
    }, 3, 4);
    const { errors, computed } = recalcWorkbook([s]);
    expect(errors).toEqual([]);
    expect(computed.get("Data!D1")).toBe(300); // only the apple row with B>=5
    expect(computed.get("Data!D2")).toBe(2);
  });

  it("XLOOKUP resolves exact matches, defaults, and #N/A without one", () => {
    const s = sheet("Data", {
      A1: { value: "apple" }, A2: { value: "orange" }, A3: { value: "apple" },
      C1: { value: 100 }, C2: { value: 200 }, C3: { value: 300 },
      X1: { formula: 'XLOOKUP("apple",A1:A3,C1:C3)' },
      X2: { formula: 'XLOOKUP("kiwi",A1:A3,C1:C3,"nf")' },
      X3: { formula: 'XLOOKUP("kiwi",A1:A3,C1:C3)' },
    }, 3, 3);
    const { errors, computed } = recalcWorkbook([s]);
    expect(computed.get("Data!X1")).toBe(100);
    expect(computed.get("Data!X2")).toBe("nf");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ sheet: "Data", cell: "X3", error: "#N/A" });
  });

  it("LET names intermediate values; MAP maps LAMBDA over a range and spills", () => {
    const s = sheet("L", {
      A1: { value: 2 },
      B1: { formula: "LET(x,A1*10,x+1)" },
      C1: { value: 2 }, C2: { value: 4 }, C3: { value: 6 },
      E1: { formula: "MAP(C1:C3,LAMBDA(v,v*2))" },
    }, 3, 5);
    const { errors, computed } = recalcWorkbook([s]);
    expect(errors).toEqual([]);
    expect(computed.get("L!B1")).toBe(21);
    // dynamic-array spill lands in blank cells — the preview map carries them
    expect(computed.get("L!E1")).toBe(4);
    expect(computed.get("L!E2")).toBe(8);
    expect(computed.get("L!E3")).toBe(12);
  });

  it("FILTER spills across blank cells and the spilled values land in the preview map", () => {
    const s = sheet("F", {
      A1: { value: "apple" }, A2: { value: "orange" }, A3: { value: "apple" },
      B1: { value: 1 }, B2: { value: 5 }, B3: { value: 10 },
      C1: { value: 100 }, C2: { value: 200 }, C3: { value: 300 },
      E1: { formula: 'FILTER(A1:C3,B1:B3>4)' },
    }, 3, 3);
    const { errors, computed } = recalcWorkbook([s]);
    expect(errors).toEqual([]);
    expect(computed.get("F!E1")).toBe("orange");
    expect(computed.get("F!E2")).toBe("apple");
    expect(computed.get("F!F1")).toBe(5);
    expect(computed.get("F!G2")).toBe(300);
  });

  it("a blocked spill and an empty FILTER are reported, not swallowed", () => {
    const s = sheet("B", {
      A1: { value: 1 }, A2: { value: 2 }, A3: { value: 3 },
      B2: { value: "wall" },
      B1: { formula: "A1:A3" }, // wants B1:B3 but B2 is occupied
      D1: { formula: 'FILTER(A1:A3,A1:A3=99)' },
    }, 3, 4);
    const { errors, computed } = recalcWorkbook([s]);
    const codes = Object.fromEntries(errors.map((e) => [e.cell, e.error]));
    expect(codes["B1"]).toBe("#SPILL!");
    expect(codes["D1"]).toBe("#CALC!");
    expect(computed.has("B!B1")).toBe(false);
  });

  it("invalid formulas are flagged by sheet+address with a reason (parse and unknown function)", () => {
    const s = sheet("S1", {
      A1: { value: 1 }, A2: { value: 2 },
      B1: { formula: "=SUM(" },          // does not parse
      B2: { formula: "=FOOBAR(1)" },     // unknown function
    }, 2, 2);
    const { errors, computed } = recalcWorkbook([s]);
    const byCell = new Map(errors.map((e) => [e.cell, e]));
    expect(byCell.get("B1")?.error).toMatch(/^#/);
    expect(byCell.get("B2")).toMatchObject({ sheet: "S1", cell: "B2", error: "#NAME?" });
    expect(byCell.get("B2")?.reason).toContain("unknown_function");
    expect(byCell.get("B2")?.reason).toContain("FOOBAR");
    expect(computed.has("S1!B1")).toBe(false);
    expect(computed.has("S1!B2")).toBe(false);
  });

  it("IFERROR/IFNA guard real errors; IFNA rethrows non-#N/A errors", () => {
    const s = sheet("S1", {
      A1: { formula: '=IFERROR(1/0,"caught")' },
      A2: { formula: '=IFNA(MATCH("zz",A3:A3,0),"na")' },
      A3: { value: 1 },
      A4: { formula: '=IFNA(1/0,"x")' },
    }, 4, 1);
    const { errors, computed } = recalcWorkbook([s]);
    expect(computed.get("S1!A1")).toBe("caught");
    expect(computed.get("S1!A2")).toBe("na");
    expect(errors).toEqual([{ sheet: "S1", cell: "A4", formula: '=IFNA(1/0,"x")', error: "#DIV/0!", reason: "division by zero" }]);
    expect(computed.has("S1!A4")).toBe(false);
  });
});

// ---------- PART 2: every function family the original whitelist covered ----------
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

describe("the original 43-function whitelist families (regression parity)", () => {
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

  it("NPV discounts each cash flow; IRR finds the zero-NPV rate", () => {
    expect(calc("=NPV(0.1,100,200)")).toBeCloseTo(100 / 1.1 + 200 / 1.21, 6);
    expect(calc("=IRR(E1:E2)")).toBeCloseTo(0.1, 6); // -100 → +110 ⇒ exactly 10%
  });

  it("DATE/YEAR/MONTH/DAY/EDATE/EOMONTH/TODAY use Excel serials", () => {
    expect(calc("=YEAR(DATE(2026,1,15))")).toBe(2026);
    expect(calc("=MONTH(DATE(2026,1,15))")).toBe(1);
    expect(calc("=DAY(DATE(2026,1,15))")).toBe(15);
    expect(calc("=EDATE(DATE(2026,1,31),1)")).toBe(calc("=DATE(2026,2,28)")); // day clamps to month end
    expect(calc("=EOMONTH(DATE(2026,2,5),0)")).toBe(calc("=DATE(2026,2,28)"));
    const s = sheet("T", { A1: { formula: "=YEAR(TODAY())" } }, 1, 1);
    const { computed } = recalcWorkbook([s]);
    expect(computed.get("T!A1")).toBe(new Date().getFullYear());
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

  it("address helpers round-trip", () => {
    expect(idxToCol(0)).toBe("A");
    expect(idxToCol(26)).toBe("AA");
    const s = sheet("S1", { AA1: { formula: "=1+1" } }, 1, 27);
    const { computed } = recalcWorkbook([s]);
    expect(computed.get("S1!AA1")).toBe(2);
  });
});
