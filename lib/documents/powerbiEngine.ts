/**
 * Power BI engine (PHASE 5): dataset → a real PBIP project zip
 * (<Name>/<Name>.pbip + <Name>.SemanticModel TMDL tables/columns/measures +
 * <Name>.Report PBIR definition with report.json, pages.json and per-visual
 * visual.json + dark theme + sanitized Data/sales.csv) plus a companion
 * .pbit inner zip. DAX measures follow the canonical patterns
 * (Total Revenue = SUM(Sales[Revenue]), Margin % via DIVIDE,
 * YoY Growth % via CALCULATE + DATEADD).
 */
import crypto from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { normalizePowerbi, type PowerbiSpec, type BiVisual } from "./schemas";
import { safeName } from "./pdfEngine";

const guid = () => crypto.randomUUID();

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(spec: PowerbiSpec): string {
  const head = spec.dataset.columns.map((c) => csvEscape(c.name)).join(",");
  const body = spec.dataset.rows.map((r) => r.map((v) => csvEscape(v ?? "N/A")).join(","));
  return [head, ...body].join("\r\n");
}

const TMDL_TYPE: Record<string, string> = { date: "dateTime", number: "double", string: "string" };
const FORMAT: Record<string, string> = { currency: "#,##0.00", percent: "0.0%", number: "#,##0.00" };

function measureFormat(dax: string, name: string): string {
  if (/%/.test(name) || /DIVIDE/.test(dax)) return "0.0%";
  if (/SUM|AVERAGE|MIN|MAX|COUNT/.test(dax)) return "#,##0.00";
  return "0.00";
}

function salesTableTmdl(spec: PowerbiSpec): string {
  const cols = spec.dataset.columns
    .map((c) => `    column ${c.name}\n    {\n        dataType: ${TMDL_TYPE[c.type]}\n${c.type === "number" ? "        formatString: \"#,##0.00\"\n" : ""}    }`)
    .join("\n");
  const measures = spec.measures
    .map((m) => `    measure "${m.name}" = ${m.dax}\n    {\n        formatString: "${measureFormat(m.dax, m.name)}"\n    }`)
    .join("\n");
  return `table Sales
{
${cols}
${measures}
    partition Sales = inlineQuery
    {
        mode: import
        source = inlineQuery
        data = m
${mExpression()}
    }
}
`;
}

function mExpression(): string {
  return `        expression SectionConstant1
        {
            name: m
            data: 5:section m;
[Version = "5.4"]
Sales = let
    Source = Csv.Document(File.Contents("Data/sales.csv"),[Delimiter=",", Columns=1, Encoding=65001, QuoteStyle=QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(Source, [PromoteAllScalars=true])
in
    Promoted

        }
`;
}

function dateTableTmdl(spec: PowerbiSpec): { tmdl: string; dateCol: string } | null {
  const dateCol = spec.dataset.columns.find((c) => c.type === "date")?.name;
  if (!dateCol) return null;
  const years = new Set<string>();
  const di = spec.dataset.columns.findIndex((c) => c.name === dateCol);
  for (const r of spec.dataset.rows) {
    const m = /^(\d{4})/.exec(String(r[di] ?? ""));
    if (m) years.add(m[1]);
  }
  if (!years.size) return null;
  const ys = [...years].sort();
  const tmdl = `table Date
{
    column Date
    {
        dataType: dateTime
        formatString: "yyyy-MM-dd"
        isKey: true
    }
    column Year
    {
        dataType: int64
    }
    partition Date = calculated
    {
        mode: import
        source = calculatedTable
        data = "
            ADDCOLUMNS(
                GENERATESERIES(DATE(${ys[0]},1,1), DATE(${ys[ys.length - 1]},12,31), 1),
                \"Year\", YEAR([Value])
            )
        "
    }
}
`;
  return { tmdl, dateCol };
}

function relationshipsTmdl(dateCol: string): string {
  return `relationship SalesDate
{
    fromTable = Sales
    fromColumn = ${dateCol}
    toTable = Date
    toColumn = Date
    active: true
    crossFilteringBehavior: single
    securityFilteringBehavior: single
    cardinality: manyToEnd
    relyDefinedValues: false
    queryModeOnly: false
}
`;
}

const VISUAL_TYPE: Record<BiVisual["type"], string> = {
  kpi: "multiCard", bar: "bar", area: "area", donut: "donutChart", waterfall: "waterfall", table: "table",
};

function visualLayout(i: number): { x: number; y: number; width: number; height: number } {
  const col = i % 3;
  const row = Math.floor(i / 3);
  return { x: col * 420, y: row * 280, width: 400, height: 260 };
}

function visualConfig(v: BiVisual, spec: PowerbiSpec): string {
  const measure = v.measure ?? spec.measures[0]?.name ?? "";
  const dim = v.dimension ?? "";
  const proj: Record<string, unknown> = {};
  if (v.type === "table") {
    proj.values = (v.columns?.length ? v.columns : spec.dataset.columns.map((c) => c.name)).map((c) => ({ field: `Sales.${c}` }));
  } else if (v.type === "kpi") {
    proj.values = [{ field: `Sales.${measure.replace(/ /g, "")}`, format: { formatString: FORMAT[v.format ?? "number"] } }];
  } else {
    proj.category = [{ field: `Sales.${dim}` }];
    proj.values = [{ field: `Sales.${measure.replace(/ /g, "")}` }];
  }
  return JSON.stringify({
    semanticQueryKind: "Basic",
    visual: {
      visualType: VISUAL_TYPE[v.type],
      projections: proj,
      queryOptions: { "measure": measure },
      objects: {
        general: [{ properties: { resizable: true } }],
        title: [{ properties: { text: v.title, show: true, fontSize: 12, words: [{ text: v.title }] } }],
      },
    },
  });
}

function reportJson(spec: PowerbiSpec): string {
  const containers = spec.visuals.map((v, i) => {
    const l = visualLayout(i);
    return {
      x: l.x, y: l.y, width: l.width, height: l.height,
      globalId: guid(), layoutPosition: String(i + 1), zorder: i,
      config: visualConfig(v, spec),
    };
  });
  for (const s of spec.slicers) {
    containers.push({
      x: 0, y: 600 + (containers.length - spec.visuals.length) * 120, width: 400, height: 110,
      globalId: guid(), layoutPosition: String(containers.length + 1), zorder: containers.length,
      config: JSON.stringify({
        semanticQueryKind: "Basic",
        visual: {
          visualType: "slicer",
          projections: { field: [{ field: `Sales.${s.field}` }] },
          objects: { general: [{ properties: { resizable: true } }], title: [{ properties: { text: s.field, show: true } }] },
        },
      }),
    });
  }
  return JSON.stringify({
    name: "report",
    type: "Report",
    theme: "default",
    sections: [{ displayName: "Overview", name: "overview", order: 0, visualContainers: containers }],
  }, null, 2);
}

function pagesJson(): string {
  return JSON.stringify({
    pageOrder: ["overview"],
    sections: [{ displayName: "Overview", name: "overview", order: 0, navigationSourceName: "overview", displayOption: "FitToPage" }],
  }, null, 2);
}

function pageJson(): string {
  return JSON.stringify({ name: "overview", displayOption: "FitToPage", sizeType: 1 }, null, 2);
}

function darkThemeJson(): string {
  return JSON.stringify({
    name: "WebUI Dark",
    dataColors: ["#38E8FF", "#22C55E", "#A78BFA", "#F59E0B", "#EF4444", "#64748B"],
    foreground: "#FFFFFF",
    foregroundNeutralSecondary: "#A1A1AA",
    foregroundNeutralTertiary: "#71717A",
    background: "#000000",
    surface: "#141414",
    borderColor: "#262626",
    textColor: "#FFFFFF",
    good: "#22C55E",
    bad: "#EF4444",
    neutral: "#A1A1AA",
  }, null, 2);
}

export interface PowerbiBuildResult { buffer: Buffer; filename: string; contentType: string }

export async function buildPowerbi(rawSpec: unknown): Promise<PowerbiBuildResult> {
  // Always normalize: sanitizes nulls (numeric → 0, text → "N/A") and synthesizes
  // default measures/visuals. Normalizing an already-normalized spec is idempotent.
  const spec: PowerbiSpec | null = normalizePowerbi(rawSpec);
  if (!spec) throw new Error("Invalid powerbi spec");

  const name = safeName(spec.filename);
  const sm = `${name}.SemanticModel`;
  const rp = `${name}.Report`;
  const csv = toCsv(spec);
  const dateInfo = dateTableTmdl(spec);

  const tables: Record<string, string> = { [`${name}/${sm}/definition/tables/Sales.tmdl`]: salesTableTmdl(spec) };
  if (dateInfo) {
    tables[`${name}/${sm}/definition/tables/Date.tmdl`] = dateInfo.tmdl;
    tables[`${name}/${sm}/definition/relationships.tmdl`] = relationshipsTmdl(dateInfo.dateCol);
  }

  const pbip = JSON.stringify({
    format: "PBIP",
    metadata: { version: { series: "1.0", major: 1, minor: 0 }, item: { itemType: "Report", report: {} }, template: {} },
    versions: { PBI_Formatter: "1.0", PBIDesktop_Version: "2.130.825.0", PBIP_EditorType: "VS", Definition_Version: "1.0", TemplateSchema_Version: "1.0" },
    settings: { useDynamicTemplateFiles: false },
  }, null, 2);

  const platformSm = JSON.stringify({ type: "SemanticModel", version: "1.0", language: "en-US", platformVersion: { pbiPVersion: "1.0" }, extensions: {} }, null, 2);
  const platformRp = JSON.stringify({ type: "Report", version: "1.0", language: "en-US", platformVersion: { pbiPVersion: "1.0" }, extensions: {} }, null, 2);

  const visualFiles: Record<string, string> = {};
  spec.visuals.forEach((v, i) => {
    visualFiles[`${name}/${rp}/definition/pages/overview/visuals/visual${i + 1}.visual.json`] = JSON.stringify({
      visual: {
        visualType: VISUAL_TYPE[v.type],
        projections: JSON.parse(visualConfig(v, spec)).visual.projections,
        queryOperators: {},
      },
    }, null, 2);
  });

  const entries: Record<string, string> = {
    [`${name}/${name}.pbip`]: pbip,
    [`${name}/${sm}/.platform`]: platformSm,
    [`${name}/${sm}/definition/semanticModel.tmdl`]: `model model\n{\n    culture: en-US\n    defaultName = "${name}"\n}\n`,
    [`${name}/${sm}/definition/expressions.tmdl`]: `expression SectionConstant1\n{\n    name: m\n    data: 5:section m;\n[Version = "5.4"]\n\n`,
    [`${name}/${sm}/Data/sales.csv`]: csv,
    [`${name}/${rp}/.platform`]: platformRp,
    // PBIR pointer: real PBIP report folders carry definition.pbir next to
    // the definition/ tree, linking the report to its semantic model.
    [`${name}/${rp}/definition.pbir`]: JSON.stringify(
      { version: "5.4", definition: { type: "Local", path: "definition" }, culture: "en-US" },
      null, 2,
    ),
    [`${name}/${rp}/definition/report.json`]: reportJson(spec),
    [`${name}/${rp}/definition/pages.json`]: pagesJson(),
    [`${name}/${rp}/definition/pages/overview/page.json`]: pageJson(),
    [`${name}/${rp}/definition/themes/default.json`]: darkThemeJson(),
    ...tables,
    ...visualFiles,
  };

  const zip = zipSync(toU8(entries));

  // Companion .pbit: inner zip with the model definition + sanitized data.
  const pbit = zipSync(toU8({
    "definition/semanticModel.tmdl": entries[`${name}/${sm}/definition/semanticModel.tmdl`],
    "definition/tables/Sales.tmdl": tables[`${name}/${sm}/definition/tables/Sales.tmdl`],
    ...(dateInfo ? { "definition/tables/Date.tmdl": tables[`${name}/${sm}/definition/tables/Date.tmdl`] } : {}),
    "Data/sales.csv": csv,
  }));
  void zip;
  // Embed the .pbit inside the PBIP package so one download carries both.
  const withPbit = zipSync({
    ...toU8(entries),
    [`${name}/${name}.pbit`]: pbit,
  });

  return {
    buffer: Buffer.from(withPbit),
    filename: name + ".pbip.zip",
    contentType: "application/zip",
  };
}

function toU8(obj: Record<string, string>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = strToU8(v);
  return out;
}
