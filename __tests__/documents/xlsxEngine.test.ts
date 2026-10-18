import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildXlsx, XlsxRecalcError } from "@/lib/documents/xlsxEngine";

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
