import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { buildPowerbi } from "@/lib/documents/powerbiEngine";
import { validatePbipPackage } from "@/lib/documents/powerbiValidate";

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

describe("PBIP structural validator (export validity gate)", () => {
  // buildPowerbi itself refuses on any issue, so a successful build is
  // already gate-clean; these call validatePbipPackage directly so the
  // empty result and each tamper are asserted explicitly.
  const enc = new TextDecoder();

  it("accepts the engine output for both the full spec and the synthesized-defaults spec", async () => {
    expect(validatePbipPackage(new Uint8Array((await buildPowerbi(spec)).buffer))).toEqual([]);
    const auto = await buildPowerbi({
      filename: "auto",
      dataset: { columns: [{ name: "Month", type: "string" }, { name: "Sales", type: "number" }], rows: [["Jan", 5], ["Feb", null]] },
    });
    expect(validatePbipPackage(new Uint8Array(auto.buffer))).toEqual([]);
  });

  /** Re-zip tamper helper: unzip, mutate RAW entries (binary-safe), re-zip. */
  function tamper(buffer: Buffer, mutate: (files: Record<string, Uint8Array>) => void): Uint8Array {
    const files = unzipSync(new Uint8Array(buffer));
    mutate(files);
    return zipSync(files);
  }
  /** Decode → edit text → re-encode one entry. */
  function editText(files: Record<string, Uint8Array>, key: string, fn: (text: string) => string): void {
    files[key] = strToU8(fn(enc.decode(files[key])));
  }

  it("refuses a package with no readable zip / no .pbip root", () => {
    expect(validatePbipPackage(strToU8("this is not a zip"))[0].message).toMatch(/zip unreadable/);
  });

  it("flags a missing definition.pbir pointer", async () => {
    const buf = (await buildPowerbi(spec)).buffer;
    const issues = validatePbipPackage(tamper(buf, (f) => { delete f["Sales_Analysis/Sales_Analysis.Report/definition.pbir"]; }));
    expect(issues.some((i) => i.path.endsWith("definition.pbir") && /required PBIP file missing/.test(i.message))).toBe(true);
  });

  it("flags unparseable report.json", async () => {
    const buf = (await buildPowerbi(spec)).buffer;
    const issues = validatePbipPackage(tamper(buf, (f) => { f["Sales_Analysis/Sales_Analysis.Report/definition/report.json"] = strToU8("{ broken"); }));
    expect(issues.some((i) => i.path.endsWith("report.json") && /not parseable JSON/.test(i.message))).toBe(true);
  });

  it("flags a PBIR projection that dangles against the model", async () => {
    const buf = (await buildPowerbi(spec)).buffer;
    const issues = validatePbipPackage(tamper(buf, (f) => {
      editText(f, "Sales_Analysis/Sales_Analysis.Report/definition/report.json", (t) => t.replace(/Sales\.Region/g, "Sales.NotAThing"));
    }));
    expect(issues.some((i) => /dangling model reference "Sales\.NotAThing"/.test(i.message))).toBe(true);
  });

  it("flags a removed Sales table (every Sales.* reference dangles)", async () => {
    const buf = (await buildPowerbi(spec)).buffer;
    const issues = validatePbipPackage(tamper(buf, (f) => {
      delete f["Sales_Analysis/Sales_Analysis.SemanticModel/definition/tables/Sales.tmdl"];
    }));
    expect(issues.some((i) => /dangling model reference/.test(i.message))).toBe(true);
  });

  it("flags an empty CSV cell", async () => {
    const buf = (await buildPowerbi(spec)).buffer;
    const issues = validatePbipPackage(tamper(buf, (f) => {
      f["Sales_Analysis/Sales_Analysis.SemanticModel/Data/sales.csv"] = strToU8("Date,Region,Revenue,Cost\r\n2024-01-15,,120000,80000");
    }));
    expect(issues.some((i) => i.path.endsWith("sales.csv") && /empty cell/.test(i.message))).toBe(true);
  });

  it("flags an M section whose Columns= disagrees with the CSV", async () => {
    const buf = (await buildPowerbi(spec)).buffer;
    const issues = validatePbipPackage(tamper(buf, (f) => {
      editText(f, "Sales_Analysis/Sales_Analysis.SemanticModel/definition/tables/Sales.tmdl", (t) => t.replace(/Columns=4/, "Columns=1"));
    }));
    expect(issues.some((i) => /Columns=1 but sales\.csv has 4/.test(i.message))).toBe(true);
  });

  it("flags a corrupt embedded .pbit companion", async () => {
    const buf = (await buildPowerbi(spec)).buffer;
    const issues = validatePbipPackage(tamper(buf, (f) => { f["Sales_Analysis/Sales_Analysis.pbit"] = strToU8("not a zip"); }));
    expect(issues.some((i) => i.path.endsWith(".pbit") && /not a readable zip/.test(i.message))).toBe(true);
  });

  it("the engine emits Columns= matching the dataset width (the hard-coded 1 defect)", async () => {
    const zip = unzipSync(new Uint8Array((await buildPowerbi(spec)).buffer));
    const sales = enc.decode(zip["Sales_Analysis/Sales_Analysis.SemanticModel/definition/tables/Sales.tmdl"]);
    expect(sales).toContain("Columns=4");
    expect(sales).not.toMatch(/Columns=1[,\s]/);
  });
});
