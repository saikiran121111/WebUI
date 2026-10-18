import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { buildPowerbi } from "@/lib/documents/powerbiEngine";

const spec = {
  filename: "Sales_Analysis",
  dataset: {
    columns: [
      { name: "Date", type: "date" },
      { name: "Region", type: "string" },
      { name: "Revenue", type: "number" },
      { name: "Cost", type: "number" },
    ],
    rows: [
      ["2024-01-15", "NA", 120000, 80000],
      ["2024-02-10", "EMEA", 95000, null],
      ["2025-01-20", "APAC", 140000, 70000],
    ],
  },
  measures: [
    { name: "Total Revenue", dax: "SUM(Sales[Revenue])" },
    { name: "Margin %", dax: "DIVIDE(SUM(Sales[Revenue]) - SUM(Sales[Cost]), SUM(Sales[Revenue]))" },
    { name: "YoY Growth %", dax: "VAR curr = SUM(Sales[Revenue]) VAR prev = CALCULATE(SUM(Sales[Revenue]), DATEADD('Date'[Date], -1, YEAR)) RETURN DIVIDE(curr - prev, prev)" },
  ],
  visuals: [
    { type: "kpi", title: "Total Revenue", measure: "Total Revenue", format: "currency" },
    { type: "bar", title: "Revenue by Region", dimension: "Region", measure: "Total Revenue", format: "currency" },
    { type: "area", title: "Revenue Over Time", dimension: "Date", measure: "Total Revenue", format: "currency" },
    { type: "donut", title: "Region Share", dimension: "Region", measure: "Total Revenue", format: "currency" },
    { type: "waterfall", title: "Revenue Waterfall", dimension: "Region", measure: "Total Revenue", format: "currency" },
    { type: "table", title: "Detail", columns: ["Date", "Region", "Revenue", "Cost"] },
  ],
  slicers: [
    { field: "Region", type: "list" },
    { field: "Date", type: "date-range" },
  ],
};

describe("powerbi engine (PBIP + TMDL + PBIR)", () => {
  it("produces a valid .pbip zip with TMDL measures, PBIR report/pages/visuals, dark theme and embedded .pbit", async () => {
    const out = await buildPowerbi(spec);
    expect(out.filename).toBe("Sales_Analysis.pbip.zip");

    const zip = unzipSync(new Uint8Array(out.buffer));
    const names = Object.keys(zip);
    const read = (n: string) => new TextDecoder().decode(zip[n]);

    // PBIP entry
    const pbip = JSON.parse(read("Sales_Analysis/Sales_Analysis.pbip"));
    expect(pbip.format).toBe("PBIP");

    // Semantic model: TMDL table with columns + the three DAX measures
    const sales = read("Sales_Analysis/Sales_Analysis.SemanticModel/definition/tables/Sales.tmdl");
    expect(sales).toContain("table Sales");
    expect(sales).toContain('measure "Total Revenue" = SUM(Sales[Revenue])');
    expect(sales).toContain("DIVIDE(");
    expect(sales).toContain("DATEADD");
    expect(sales).toContain("dataType: dateTime");

    // Date table + relationship because a date column exists
    expect(names).toContain("Sales_Analysis/Sales_Analysis.SemanticModel/definition/tables/Date.tmdl");
    const rel = read("Sales_Analysis/Sales_Analysis.SemanticModel/definition/relationships.tmdl");
    expect(rel).toContain("fromColumn = Date");
    expect(rel).toContain("toTable = Date");

    // PBIR report definition
    const report = JSON.parse(read("Sales_Analysis/Sales_Analysis.Report/definition/report.json"));
    expect(report.sections[0].visualContainers.length).toBe(8); // 6 visuals + 2 slicers
    const types = report.sections[0].visualContainers.map((c: { config: string }) => JSON.parse(c.config).visual.visualType);
    expect(types).toContain("multiCard");
    expect(types).toContain("bar");
    expect(types).toContain("donutChart");
    expect(types).toContain("waterfall");
    expect(types).toContain("table");
    expect(types.filter((t: string) => t === "slicer").length).toBe(2);

    // PBIR pointer file
    const pbir = JSON.parse(read("Sales_Analysis/Sales_Analysis.Report/definition.pbir"));
    expect(pbir.version).toBe("5.4");
    expect(pbir.definition.path).toBe("definition");

    const pages = JSON.parse(read("Sales_Analysis/Sales_Analysis.Report/definition/pages.json"));
    expect(pages.pageOrder).toEqual(["overview"]);
    expect(names).toContain("Sales_Analysis/Sales_Analysis.Report/definition/pages/overview/page.json");
    const visualFiles = names.filter((n) => n.endsWith(".visual.json"));
    expect(visualFiles.length).toBe(6);

    // dark theme
    const theme = JSON.parse(read("Sales_Analysis/Sales_Analysis.Report/definition/themes/default.json"));
    expect(theme.background).toBe("#000000");
    expect(theme.dataColors[0]).toBe("#38E8FF");

    // sanitized CSV: null Cost → 0, no empty cells
    const csv = read("Sales_Analysis/Sales_Analysis.SemanticModel/Data/sales.csv");
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Date,Region,Revenue,Cost");
    expect(lines[1]).toBe("2024-01-15,NA,120000,80000");
    expect(lines[2]).toBe("2024-02-10,EMEA,95000,0");
    expect(csv).not.toContain(",,");

    // embedded .pbit is itself a valid zip with the model definition
    const pbitRaw = zip["Sales_Analysis/Sales_Analysis.pbit"];
    expect(pbitRaw).toBeTruthy();
    const pbit = unzipSync(pbitRaw);
    expect(Object.keys(pbit)).toContain("definition/tables/Sales.tmdl");
    expect(Object.keys(pbit)).toContain("Data/sales.csv");
    // the embedded table must be the real TMDL, not an undefined-stringified stub
    expect(new TextDecoder().decode(pbit["definition/tables/Sales.tmdl"])).toContain("table Sales");
  });

  it("synthesizes default measures/visuals when the model omits them", async () => {
    const out = await buildPowerbi({
      filename: "auto",
      dataset: { columns: [{ name: "Month", type: "string" }, { name: "Sales", type: "number" }], rows: [["Jan", 5], ["Feb", null]] },
    });
    const zip = unzipSync(new Uint8Array(out.buffer));
    const sales = new TextDecoder().decode(zip["auto/auto.SemanticModel/definition/tables/Sales.tmdl"]);
    expect(sales).toContain('measure "Total Sales" = SUM(Sales[Sales])');
    const report = JSON.parse(new TextDecoder().decode(zip["auto/auto.Report/definition/report.json"]));
    expect(report.sections[0].visualContainers.length).toBeGreaterThanOrEqual(2);
  });
});
