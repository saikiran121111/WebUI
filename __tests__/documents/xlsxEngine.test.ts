import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildXlsx, XlsxRecalcError } from "@/lib/documents/xlsxEngine";
import { normalizeXlsx } from "@/lib/documents/schemas";

const spec = {
  filename: "Q4 Financial Model",
  sheets: [
    {
      name: "Revenue",
      columns: [
        { key: "month", label: "Month", format: "text" },
        { key: "region", label: "Region", format: "text", validation: { type: "list", values: ["NA", "EMEA", "APAC"] } },
        { key: "revenue", label: "Revenue", format: "currency" },
        { key: "cost", label: "Cost", format: "currency" },
        { key: "margin", label: "Margin %", format: "percent", validation: { type: "decimal", min: -1, max: 1 } },
      ],
      rows: [
        { month: "2025-01", region: "NA", revenue: 120000, cost: 80000, margin: "=IF(C2=0,0,(C2-D2)/C2)" },
        { month: "2025-02", region: "EMEA", revenue: 95000, cost: null, margin: "=IF(C3=0,0,(C3-D3)/C3)" },
        { month: "2025-03", region: "APAC", revenue: null, cost: 40000, margin: "=IF(C4=0,0,(C4-D4)/C4)" },
      ],
      freezeHeader: true,
      totalRow: true,
    },
    {
      name: "Summary",
      columns: [
        { key: "metric", label: "Metric", format: "text" },
        { key: "value", label: "Value", format: "currency" },
      ],
      rows: [
        { metric: "Total Revenue", value: "=SUM(Revenue!C2:C4)" },
        { metric: "Average Margin", value: "=AVERAGE(Revenue!E2:E4)" },
      ],
      freezeHeader: true,
      totalRow: false,
    },
  ],
};

describe("xlsx engine", () => {
  it("builds a multi-sheet workbook with zero null cells, live formulas, freeze panes and validations", async () => {
    const out = await buildXlsx(spec);
    expect(out.recalcErrors).toBe(0);
    expect(out.filename).toBe("Q4_Financial_Model.xlsx");

    const wb = new ExcelJS.Workbook();
    // ExcelJS's .d.ts references an older Buffer shape than Node 24's
    // Buffer<ArrayBufferLike> — target the exact parameter type.
    await wb.xlsx.load(out.buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Revenue", "Summary"]);

    const ws = wb.getWorksheet("Revenue")!;
    // freeze_panes A2
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });

    // zero null/blank cells across the used range (nulls sanitized to 0 / "N/A")
    let nulls = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v == null || (typeof v === "string" && v.trim() === "")) nulls++;
      });
    });
    expect(nulls).toBe(0);
    expect(ws.getCell("C4").value).toBe(0); // numeric null → 0

    // 100% live formulas: margin + total row are formula cells
    expect(String((ws.getCell("E2").value as { formula: string }).formula)).toMatch(/^IF\(/);
    const totalRow = ws.getRow(5);
    expect(String((totalRow.getCell(3).value as { formula: string }).formula)).toBe("SUM(C2:C4)");

    // data validations present
    expect(ws.getCell("B2").dataValidation?.type).toBe("list");
    expect(ws.getCell("E2").dataValidation?.type).toBe("decimal");

    // number formats
    expect(ws.getCell("C2").numFmt).toBe("$#,##0.00");
    expect(ws.getCell("E2").numFmt).toBe("0.0%");

    // cross-sheet formulas recalc clean
    const sum = wb.getWorksheet("Summary")!;
    expect(String((sum.getCell("B2").value as { formula: string }).formula)).toBe("SUM(Revenue!C2:C4)");
  }, 30000);

  it("refuses to emit a workbook whose formulas produce any error", async () => {
    await expect(buildXlsx({
      filename: "bad",
      sheets: [{
        name: "S", columns: [{ key: "a", label: "A", format: "number" }],
        rows: [{ a: "=1/0" }], freezeHeader: true, totalRow: false,
      }],
    })).rejects.toBeInstanceOf(XlsxRecalcError);
  }, 30000);
});

// ================= PART 2 stress: the exact refused prompt, executed =================
// "Create and execute a Python script using openpyxl to generate a downloadable
//  Excel file named UI_Stress_Test.xlsx. Include 6 sheets: Dashboard,
//  Transactions (500 rows), Budget, Inventory (30 products), Scenarios, and QA...
//  bar/line/pie charts." — the engine must build it, not describe it.

const CATS = ["Groceries", "Utilities", "Rent", "Transport", "Dining"];

const inventoryRows = Array.from({ length: 30 }, (_, i) => ({
  sku: `SKU-${100 + i}`,
  name: `Product ${i + 1}`,
  stock: (i * 7) % 50,
  reorder: 10 + (i % 5) * 2,
  unit_cost: 5 + i * 1.5,
  order_qty: `=IF(C${2 + i}<=D${2 + i},ROUNDUP((D${2 + i}*2-C${2 + i})/10,0)*10,0)`,
  status: `=IF(C${2 + i}<=D${2 + i},"REORDER","OK")`,
}));

// 22 live formula tests — every whitelisted family exercised against the
// 500-row Transactions sheet and the Scenarios cash flows.
const qaRows = [
  { test: "SUM≡SUMIF(>0)", expected: "=SUM(Transactions!H2:H501)", actual: "=SUMIF(Transactions!H2:H501,\">0\")", verdict: "=IF(C2=B2,\"PASS\",\"FAIL\")" },
  { test: "AVERAGE≡AVERAGEIF(>0)", expected: "=AVERAGE(Transactions!H2:H501)", actual: "=AVERAGEIF(Transactions!H2:H501,\">0\")", verdict: "=IF(C3=B3,\"PASS\",\"FAIL\")" },
  { test: "COUNT≡COUNTIF(>0)", expected: "=COUNT(Transactions!H2:H501)", actual: "=COUNTIF(Transactions!H2:H501,\">0\")", verdict: "=IF(C4=B4,\"PASS\",\"FAIL\")" },
  { test: "COUNTA≡COUNT", expected: "=COUNT(Transactions!H2:H501)", actual: "=COUNTA(Transactions!A2:A501)", verdict: "=IF(C5=B5,\"PASS\",\"FAIL\")" },
  { test: "MIN/MAX sanity", expected: "OK", actual: "=IF(AND(MIN(Transactions!H2:H501)>0,MAX(Transactions!H2:H501)>MIN(Transactions!H2:H501)),\"OK\",\"BAD\")", verdict: "=IF(C6=B6,\"PASS\",\"FAIL\")" },
  { test: "PRODUCT", expected: 24, actual: "=PRODUCT(2,3,4)", verdict: "=IF(C7=B7,\"PASS\",\"FAIL\")" },
  { test: "ROUND", expected: 3, actual: "=ROUND(2.5,0)", verdict: "=IF(C8=B8,\"PASS\",\"FAIL\")" },
  { test: "ROUNDUP", expected: 1.12, actual: "=ROUNDUP(1.111,2)", verdict: "=IF(C9=B9,\"PASS\",\"FAIL\")" },
  { test: "ROUNDDOWN", expected: 1.99, actual: "=ROUNDDOWN(1.999,2)", verdict: "=IF(C10=B10,\"PASS\",\"FAIL\")" },
  { test: "INT", expected: -3, actual: "=INT(-2.5)", verdict: "=IF(C11=B11,\"PASS\",\"FAIL\")" },
  { test: "ABS", expected: 7, actual: "=ABS(-7)", verdict: "=IF(C12=B12,\"PASS\",\"FAIL\")" },
  { test: "MOD", expected: 1, actual: "=MOD(10,3)", verdict: "=IF(C13=B13,\"PASS\",\"FAIL\")" },
  { test: "POWER", expected: 81, actual: "=POWER(3,4)", verdict: "=IF(C14=B14,\"PASS\",\"FAIL\")" },
  { test: "SQRT", expected: 12, actual: "=SQRT(144)", verdict: "=IF(C15=B15,\"PASS\",\"FAIL\")" },
  { test: "IF+AND+OR+NOT", expected: "TRUE", actual: "=IF(AND(1=1,OR(1>2,2>1)),NOT(1>2),\"no\")", verdict: "=IF(C16,\"PASS\",\"FAIL\")" },
  { test: "IFS", expected: "b", actual: "=IFS(1>2,\"a\",1=1,\"b\",TRUE,\"c\")", verdict: "=IF(C17=B17,\"PASS\",\"FAIL\")" },
  { test: "IFERROR", expected: "caught", actual: "=IFERROR(1/0,\"caught\")", verdict: "=IF(C18=B18,\"PASS\",\"FAIL\")" },
  { test: "IFNA", expected: "na", actual: "=IFNA(VLOOKUP(\"zzz\",A1:A1,1),\"na\")", verdict: "=IF(C19=B19,\"PASS\",\"FAIL\")" },
  { test: "INDEX/MATCH≡VLOOKUP", expected: "=VLOOKUP(Transactions!A2,Transactions!A2:H501,8,FALSE)", actual: "=INDEX(Transactions!H2:H501,MATCH(Transactions!A2,Transactions!A2:A501,0))", verdict: "=IF(C20=B20,\"PASS\",\"FAIL\")" },
  { test: "XLOOKUP≡VLOOKUP", expected: "=VLOOKUP(Transactions!A2,Transactions!A2:H501,8,FALSE)", actual: "=XLOOKUP(Transactions!A2,Transactions!A2:A501,Transactions!H2:H501)", verdict: "=IF(C21=B21,\"PASS\",\"FAIL\")" },
  { test: "NPV", expected: "=100/1.1+200/1.1^2", actual: "=NPV(0.1,100,200)", verdict: "=IF(C22=B22,\"PASS\",\"FAIL\")" },
  { test: "IRR (NPV@IRR≈0)", expected: "≈0", actual: "=IRR(Scenarios!B2:F2)", verdict: "=IF(ABS(NPV(IRR(Scenarios!B2:F2),Scenarios!B2:F2))<0.0001,\"PASS\",\"FAIL\")" },
];

const stressSpec = {
  filename: "UI_Stress_Test",
  // workbook-level charts → normalizeXlsx merges them into sheets[0] (Dashboard)
  charts: [
    { type: "bar", title: "Budget vs Actual", categories: CATS, series: [{ name: "Budget", data: [1000, 1500, 2000, 2500, 3000] }] },
    { type: "line", title: "Monthly Spend", categories: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], series: [{ name: "Spend", data: [820, 932, 901, 934, 1290, 1330, 1320, 1100, 980, 1040, 1210, 1450] }] },
    { type: "pie", title: "Category Mix", categories: CATS, series: [{ name: "Share", data: [30, 20, 25, 15, 10] }] },
  ],
  sheets: [
    {
      name: "Dashboard",
      columns: [
        { key: "kpi", label: "KPI", format: "text" },
        { key: "value", label: "Value", format: "number" },
      ],
      rows: [
        { kpi: "Total Spend", value: "=SUM(Transactions!H2:H501)" },
        { kpi: "Tx Count", value: "=COUNT(Transactions!H2:H501)" },
        { kpi: "Avg Tx", value: "=AVERAGE(Transactions!H2:H501)" },
        { kpi: "Inventory Value", value: "=SUMPRODUCT(Inventory!C2:C31,Inventory!E2:E31)" },
        { kpi: "Jan 2026 Spend", value: "=SUMPRODUCT((YEAR(Transactions!B2:B501)=2026)*(MONTH(Transactions!B2:B501)=1)*Transactions!H2:H501)" },
      ],
      freezeHeader: true, totalRow: false,
    },
    {
      name: "Transactions",
      columns: [
        { key: "tx_id", label: "Tx ID", format: "text" },
        { key: "date", label: "Date", format: "date" },
        { key: "category", label: "Category", format: "text", validation: { type: "list", values: CATS } },
        { key: "qty", label: "Qty", format: "integer", validation: { type: "decimal", min: 1, max: 20 } },
        { key: "price", label: "Unit Price", format: "currency" },
        { key: "discount", label: "Discount", format: "percent" },
        { key: "tax", label: "Tax", format: "percent" },
        { key: "total", label: "Total", format: "currency" },
      ],
      rows: [],
      rowGenerator: {
        count: 500,
        columns: [
          { key: "tx_id", pattern: "TXN-{1001..1500}" },
          { key: "date", dateRange: { start: "2026-01-01", end: "2026-12-31" } },
          { key: "category", cycle: CATS },
          { key: "qty", numberRange: { min: 1, max: 20, decimals: 0 } },
          { key: "price", numberRange: { min: 5, max: 500, decimals: 2 } },
          { key: "discount", numberRange: { min: 0, max: 0.3, decimals: 2 } },
          { key: "tax", numberRange: { min: 0.05, max: 0.15, decimals: 3 } },
          { key: "total", formulaTemplate: "=ROUND(D{row}*E{row}*(1-F{row})*(1+G{row}),2)" },
        ],
      },
      freezeHeader: true, totalRow: true,
    },
    {
      name: "Budget",
      columns: [
        { key: "category", label: "Category", format: "text" },
        { key: "budget", label: "Budget", format: "currency" },
        { key: "actual", label: "Actual", format: "currency" },
        { key: "variance", label: "Variance", format: "currency" },
        { key: "status", label: "Status", format: "text" },
      ],
      rows: CATS.map((c, i) => ({
        category: c,
        budget: 1000 + i * 500,
        actual: `=SUMIFS(Transactions!H2:H501,Transactions!C2:C501,A${2 + i})`,
        variance: `=C${2 + i}-B${2 + i}`,
        status: `=_xlfn.IFS(C${2 + i}>B${2 + i}*1.1,"OVERSPEND",C${2 + i}>B${2 + i},"REORDER",TRUE,"OK")`,
      })),
      conditionalFormatting: [
        { columnKey: "status", rule: "equal", value: "OVERSPEND" },
        { columnKey: "status", rule: "equal", value: "REORDER" },
        { columnKey: "status", rule: "equal", value: "OK" },
      ],
      freezeHeader: true, totalRow: true,
    },
    {
      name: "Inventory",
      columns: [
        { key: "sku", label: "SKU", format: "text" },
        { key: "name", label: "Product", format: "text" },
        { key: "stock", label: "Stock", format: "integer" },
        { key: "reorder", label: "Reorder Pt", format: "integer" },
        { key: "unit_cost", label: "Unit Cost", format: "currency" },
        { key: "order_qty", label: "Order Qty", format: "integer" },
        { key: "status", label: "Status", format: "text" },
      ],
      rows: inventoryRows,
      conditionalFormatting: [{ columnKey: "status", rule: "containsText", value: "REORDER" }],
      freezeHeader: true, totalRow: true,
    },
    {
      name: "Scenarios",
      columns: [
        { key: "scenario", label: "Scenario", format: "text" },
        { key: "cf0", label: "CF0", format: "currency" },
        { key: "cf1", label: "CF1", format: "currency" },
        { key: "cf2", label: "CF2", format: "currency" },
        { key: "cf3", label: "CF3", format: "currency" },
        { key: "cf4", label: "CF4", format: "currency" },
        { key: "npv", label: "NPV @10%", format: "currency" },
        { key: "irr", label: "IRR", format: "percent" },
        { key: "jan", label: "Jan-2026 Spend", format: "currency" },
      ],
      rows: [
        { scenario: "Base", cf0: -1000, cf1: 300, cf2: 420, cf3: 500, cf4: 610, npv: "=NPV(0.1,B2:F2)", irr: "=IRR(B2:F2)", jan: "=SUMPRODUCT((YEAR(Transactions!B2:B501)=2026)*(MONTH(Transactions!B2:B501)=1)*Transactions!H2:H501)" },
        { scenario: "Downside", cf0: -800, cf1: 150, cf2: 200, cf3: 260, cf4: 300, npv: "=NPV(0.1,B3:F3)", irr: "=IRR(B3:F3)", jan: "=SUMPRODUCT((YEAR(Transactions!B2:B501)=2026)*(MONTH(Transactions!B2:B501)=2)*Transactions!H2:H501)" },
      ],
      freezeHeader: true, totalRow: false,
    },
    {
      name: "QA",
      columns: [
        { key: "test", label: "Test", format: "text" },
        { key: "expected", label: "Expected", format: "text" },
        { key: "actual", label: "Actual (live formula)", format: "text" },
        { key: "verdict", label: "Verdict", format: "text" },
      ],
      rows: qaRows,
      conditionalFormatting: [{ columnKey: "verdict", rule: "equal", value: "PASS" }],
      freezeHeader: true, totalRow: false,
    },
  ],
};

describe("UI_Stress_Test.xlsx (PART 2 extreme workbook)", () => {
  it("normalizeXlsx expands the 500-row generator deterministically and is idempotent", () => {
    const once = normalizeXlsx(JSON.parse(JSON.stringify(stressSpec)))!;
    expect(once.sheets.map((s) => s.name)).toEqual(["Dashboard", "Transactions", "Budget", "Inventory", "Scenarios", "QA"]);
    const tx = once.sheets[1];
    expect(tx.rows.length).toBe(500);
    expect(tx.rowGenerator).toBeUndefined(); // cleared: re-normalizing must not duplicate
    expect(tx.rows[0].tx_id).toBe("TXN-1001");
    expect(tx.rows[499].tx_id).toBe("TXN-1500");
    expect(tx.rows[0].total).toBe("=ROUND(D2*E2*(1-F2)*(1+G2),2)");
    expect(String(tx.rows[499].date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(once.sheets[0].charts?.length).toBe(3); // workbook-level charts merged into Dashboard
    const twice = normalizeXlsx(once)!;
    expect(twice.sheets[1].rows.length).toBe(500);
    expect(JSON.stringify(twice.sheets[1].rows)).toBe(JSON.stringify(tx.rows));
  });

  it("builds the 6-sheet workbook: 500 rows, 0 nulls, 0 recalc errors, validations, CF, 3 chart images", async () => {
    const out = await buildXlsx(JSON.parse(JSON.stringify(stressSpec)));
    expect(out.filename).toBe("UI_Stress_Test.xlsx");
    expect(out.recalcErrors).toBe(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Dashboard", "Transactions", "Budget", "Inventory", "Scenarios", "QA"]);

    // zero null/blank cells across the ENTIRE workbook
    let nulls = 0;
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v == null || (typeof v === "string" && v.trim() === "")) nulls++;
      }));
    }
    expect(nulls).toBe(0);

    const tx = wb.getWorksheet("Transactions")!;
    expect(tx.getCell("A2").value).toBe("TXN-1001");
    expect(tx.getCell("A501").value).toBe("TXN-1500");
    expect(String((tx.getCell("H2").value as { formula: string }).formula)).toBe("ROUND(D2*E2*(1-F2)*(1+G2),2)");
    // formula cells carry cached results (no blank placeholders on open)
    expect(typeof (tx.getCell("H2").value as { result?: unknown }).result).toBe("number");
    // autoFilter + validations
    expect(tx.autoFilter).toBeTruthy();
    expect(tx.getCell("C2").dataValidation?.type).toBe("list");
    expect(tx.getCell("D2").dataValidation?.type).toBe("decimal");

    // conditional formatting round-trips (conditionalFormattings exists at
    // runtime on load but is missing from exceljs's Worksheet d.ts)
    const cfCount = (name: string) => ((wb.getWorksheet(name) as unknown as { conditionalFormattings?: unknown[] }).conditionalFormattings ?? []).length;
    expect(cfCount("Budget")).toBe(3);
    expect(cfCount("Inventory")).toBe(1);
    expect(cfCount("QA")).toBe(1);

    // 3 embedded chart PNGs on Dashboard
    expect(wb.getWorksheet("Dashboard")!.getImages().length).toBe(3);

    // all 22 QA verdicts PASS (cached results prove the live formulas evaluated)
    const qa = wb.getWorksheet("QA")!;
    for (let r = 2; r <= 23; r++) {
      const v = (qa.getCell(`D${r}`).value as { result?: string }).result;
      expect(v, `QA row ${r}`).toBe("PASS");
    }

    // Scenarios NPV/IRR/SUMPRODUCT produced real numbers
    const sc = wb.getWorksheet("Scenarios")!;
    expect(typeof (sc.getCell("G2").value as { result?: unknown }).result).toBe("number");
    expect(typeof (sc.getCell("H2").value as { result?: unknown }).result).toBe("number");
    expect(typeof (sc.getCell("I2").value as { result?: unknown }).result).toBe("number");
  }, 120000);

  it("deterministic generator: two builds produce identical Transactions data", async () => {
    const a = await buildXlsx(JSON.parse(JSON.stringify(stressSpec)));
    const b = await buildXlsx(JSON.parse(JSON.stringify(stressSpec)));
    const load = async (buf: Buffer) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
      return wb.getWorksheet("Transactions")!;
    };
    const wa = await load(a.buffer), wbx = await load(b.buffer);
    for (const ref of ["B2", "C2", "D2", "E2", "H2", "D250", "H250", "B501", "H501"]) {
      const va = wa.getCell(ref).value, vb = wbx.getCell(ref).value;
      const norm = (v: unknown) => typeof v === "object" && v !== null ? (v as { result?: unknown }).result ?? null : v;
      expect(norm(va), ref).toEqual(norm(vb));
    }
  }, 120000);
});
