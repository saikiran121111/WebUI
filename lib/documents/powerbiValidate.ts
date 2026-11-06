/**
 * Structural PBIP/PBIR validation (P5B "Power BI export validity").
 *
 * Power BI Desktop is NOT installed on these machines (and will not be
 * installed without explicit user approval), so "opens in Desktop" cannot be
 * asserted locally. What CAN be enforced — and is, as a MANDATORY gate inside
 * buildPowerbi before any download is returned, mirroring the xlsx recalc
 * zero-error law — is the PBIP package contract itself:
 *
 *  - the `<Name>/<Name>.pbip` project file with format "PBIP";
 *  - SemanticModel + Report folders each with a `.platform`, the TMDL
 *    definition tree, and the PBIR `definition.pbir` pointer (v5.4, Local);
 *  - every TMDL brace-balanced, with parseable table/column/measure lines;
 *  - PBIR JSON parseable, globalIds unique, pages.json consistent with the
 *    per-page files;
 *  - every PBIR projection/measure reference resolvable against the model
 *    (dangling field = the #1 real-world "won't open" cause);
 *  - the embedded .pbit is a real zip carrying the SAME model + data;
 *  - the CSV is rectangular with zero empty cells, and the M section's
 *    Columns= declaration matches the actual column count.
 */
import { unzipSync } from "fflate";

export interface PbipIssue { path: string; message: string }

const dec = (u: Uint8Array | undefined): string | null => (u ? new TextDecoder().decode(u) : null);

/** Minimal CSV cell splitter honoring quoted fields (our writer emits RFC-4180 quoting). */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function balancedBraces(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

export function validatePbipPackage(buffer: Uint8Array): PbipIssue[] {
  const issues: PbipIssue[] = [];
  const bad = (path: string, message: string) => issues.push({ path, message });
  const textOf = (name: string): string | null => dec(zip[name]);
  const jsonOf = (name: string): unknown | undefined => {
    const t = textOf(name);
    if (t === null) return undefined;
    try { return JSON.parse(t); } catch { bad(name, "not parseable JSON"); return undefined; }
  };

  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(buffer);
  } catch (err) {
    return [{ path: "(package)", message: "zip unreadable: " + (err instanceof Error ? err.message : String(err)) }];
  }
  const names = Object.keys(zip);

  // ---- root folder + .pbip project file ----
  const pbipName = names.find((n) => /^[^/]+\/[^/]+\.pbip$/.test(n));
  if (!pbipName) return [{ path: "(package)", message: "no <Name>/<Name>.pbip project file" }];
  const root = pbipName.slice(0, pbipName.indexOf("/"));
  const pbip = jsonOf(pbipName) as { format?: string; metadata?: { item?: { itemType?: string } } } | undefined;
  if (pbip && pbip.format !== "PBIP") bad(pbipName, `format is "${pbip.format}", expected "PBIP"`);
  if (pbip && pbip.metadata?.item?.itemType !== "Report") bad(pbipName, "metadata.item.itemType must be \"Report\"");

  const sm = `${root}/${root}.SemanticModel`;
  const rp = `${root}/${root}.Report`;

  // ---- required files ----
  const required = [
    `${sm}/.platform`, `${sm}/definition/semanticModel.tmdl`, `${sm}/definition/expressions.tmdl`,
    `${sm}/Data/sales.csv`, `${rp}/.platform`, `${rp}/definition.pbir`,
    `${rp}/definition/report.json`, `${rp}/definition/pages.json`,
  ];
  for (const f of required) if (!(f in zip)) bad(f, "required PBIP file missing");
  const tableFiles = names.filter((n) => n.startsWith(`${sm}/definition/tables/`) && n.endsWith(".tmdl"));
  if (!tableFiles.length) bad(`${sm}/definition/tables`, "no table .tmdl files");

  // ---- .platform + pbir pointers ----
  const platSm = jsonOf(`${sm}/.platform`) as { type?: string } | undefined;
  if (platSm && platSm.type !== "SemanticModel") bad(`${sm}/.platform`, `type "${platSm.type}" != "SemanticModel"`);
  const platRp = jsonOf(`${rp}/.platform`) as { type?: string } | undefined;
  if (platRp && platRp.type !== "Report") bad(`${rp}/.platform`, `type "${platRp.type}" != "Report"`);
  const pbir = jsonOf(`${rp}/definition.pbir`) as { version?: string; definition?: { type?: string; path?: string } } | undefined;
  if (pbir) {
    if (!/^5\./.test(String(pbir.version))) bad(`${rp}/definition.pbir`, `PBIR version "${pbir.version}" not 5.x`);
    if (pbir.definition?.type !== "Local") bad(`${rp}/definition.pbir`, "definition.type must be \"Local\"");
    if (pbir.definition?.path !== "definition") bad(`${rp}/definition.pbir`, "definition.path must be \"definition\"");
  }

  // ---- TMDL: balanced, tables, columns + measures collected for ref checks ----
  const modelColumns = new Set<string>();
  const modelMeasures = new Set<string>(); // raw names (with spaces)
  const measureFieldNames = new Set<string>(); // PBIR projections spell measures with spaces removed
  const tmdlFiles = names.filter((n) => n.endsWith(".tmdl"));
  let salesTmdl: string | null = null;
  for (const f of tmdlFiles) {
    const t = textOf(f) ?? "";
    if (!t) { bad(f, "empty file"); continue; }
    if (t.includes("undefined")) bad(f, "contains the literal \"undefined\" (stringified missing value)");
    if (!balancedBraces(t)) bad(f, "TMDL braces not balanced (truncated or malformed block)");
    if (f.endsWith("/Sales.tmdl")) salesTmdl = t;
    for (const m of t.matchAll(/^\s*column\s+([A-Za-z_][\w]*)\s*$/gm)) if (f.includes("/tables/")) modelColumns.add(m[1]);
    for (const m of t.matchAll(/^\s*measure\s+"([^"]+)"\s*=\s*(\S.*)$/gm)) {
      modelMeasures.add(m[1]);
      measureFieldNames.add(m[1].replace(/ /g, ""));
      if (!m[2].trim()) bad(f, `measure "${m[1]}" has no DAX expression`);
    }
  }
  if (salesTmdl !== null && !/^\s*table\s+Sales\b/m.test(salesTmdl)) bad(`${sm}/definition/tables/Sales.tmdl`, "no `table Sales` header");

  // ---- CSV: rectangular, no empty cells; M section Columns= must match ----
  const csv = textOf(`${sm}/Data/sales.csv`);
  let csvCols = 0;
  if (csv !== null) {
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    if (!lines.length) bad(`${sm}/Data/sales.csv`, "empty CSV");
    else {
      csvCols = csvCells(lines[0]).length;
      if (!csvCols) bad(`${sm}/Data/sales.csv`, "header has no columns");
      lines.forEach((line, ri) => {
        const cells = csvCells(line);
        if (cells.length !== csvCols) bad(`${sm}/Data/sales.csv`, `row ${ri + 1} has ${cells.length} cells, header has ${csvCols}`);
        if (cells.some((c) => c === "")) bad(`${sm}/Data/sales.csv`, `row ${ri + 1} contains an empty cell`);
      });
    }
    if (salesTmdl) {
      const m = /Columns\s*=\s*(\d+)/.exec(salesTmdl);
      if (csvCols && m && Number(m[1]) !== csvCols) bad(`${sm}/definition/tables/Sales.tmdl`, `M section declares Columns=${m[1]} but sales.csv has ${csvCols}`);
    }
  }

  // ---- PBIR report/pages/pages-files + referential integrity ----
  const report = jsonOf(`${rp}/definition/report.json`) as { sections?: { name?: string; visualContainers?: { globalId?: string; layoutPosition?: string; config?: string }[] }[] } | undefined;
  const pages = jsonOf(`${rp}/definition/pages.json`) as { pageOrder?: string[]; sections?: { name?: string }[] } | undefined;
  const globalIds = new Set<string>();
  if (report?.sections?.length) {
    for (const sec of report.sections) {
      const name = String(sec.name);
      if (!names.some((n) => n.includes(`/pages/${name}/`))) bad(`${rp}/definition/report.json`, `section "${name}" has no page folder`);
      for (const vc of sec.visualContainers ?? []) {
        if (!vc.globalId) bad(`${rp}/definition/report.json`, `visualContainer in "${name}" has no globalId`);
        else if (globalIds.has(vc.globalId)) bad(`${rp}/definition/report.json`, `duplicate globalId ${vc.globalId}`);
        else globalIds.add(vc.globalId);
        if (!vc.config) { bad(`${rp}/definition/report.json`, `container ${vc.globalId ?? "?"} has no config`); continue; }
        let cfg: { visual?: { visualType?: string; projections?: Record<string, { field?: string }[]>; queryOptions?: { measure?: string } } };
        try { cfg = JSON.parse(vc.config); } catch { bad(`${rp}/definition/report.json`, `container ${vc.globalId} config is not JSON`); continue; }
        const vis = cfg.visual;
        if (!vis?.visualType) bad(`${rp}/definition/report.json`, `container ${vc.globalId} has no visualType`);
        for (const arr of Object.values(vis?.projections ?? {})) {
          for (const p of arr ?? []) {
            const f = p?.field;
            if (!f) continue;
            const dot = f.indexOf(".");
            if (dot < 0) { bad(`${rp}/definition/report.json`, `projection field "${f}" is not qualified as Table.column`); continue; }
            const [table, col] = [f.slice(0, dot), f.slice(dot + 1)];
            if (table === "Sales" && !modelColumns.has(col) && !measureFieldNames.has(col) && !modelMeasures.has(col)) {
              bad(`${rp}/definition/report.json`, `dangling model reference "${f}" (no such column or measure in Sales)`);
            }
          }
        }
        const qm = vis?.queryOptions?.measure;
        if (qm !== undefined && !modelMeasures.has(qm) && !modelColumns.has(qm)) {
          bad(`${rp}/definition/report.json`, `queryOptions.measure "${qm}" does not exist in the model`);
        }
      }
    }
  } else if (report) bad(`${rp}/definition/report.json`, "no sections");
  for (const pn of pages?.pageOrder ?? []) {
    if (!names.some((n) => n.includes(`/pages/${pn}/page.json`))) bad(`${rp}/definition/pages.json`, `page "${pn}" listed but no page.json`);
  }
  for (const vf of names.filter((n) => n.endsWith(".visual.json"))) {
    const v = jsonOf(vf) as { visual?: { visualType?: string } } | undefined;
    if (v && !v.visual?.visualType) bad(vf, "no visual.visualType");
  }

  // ---- embedded .pbit: a real zip carrying the SAME model + data ----
  const pbitName = `${root}/${root}.pbit`;
  const pbitRaw = zip[pbitName];
  if (!pbitRaw) bad(pbitName, "embedded .pbit companion missing");
  else {
    try {
      const pbit = unzipSync(pbitRaw);
      for (const f of ["definition/semanticModel.tmdl", "definition/tables/Sales.tmdl", "Data/sales.csv"]) {
        if (!(f in pbit)) bad(pbitName, `.pbit missing ${f}`);
      }
      if (csv !== null && f("Data/sales.csv", pbit) !== csv) bad(pbitName, ".pbit CSV differs from the project CSV");
    } catch (err) {
      bad(pbitName, "embedded .pbit is not a readable zip: " + (err instanceof Error ? err.message : String(err)));
    }
  }
  function f(name: string, z: Record<string, Uint8Array>): string { return dec(z[name]) ?? ""; }

  return issues;
}

/**
 * Thrown by the buildPowerbi gate: the package failed its own structural
 * contract, so no download may be returned. The message carries "invalid"
 * to match the shared engineError → 422 mapping; `details` rides along as
 * `structureErrors` in the API body (like xlsx `formulaErrors`).
 */
export class PowerbiValidationError extends Error {
  details: PbipIssue[];
  constructor(issues: PbipIssue[]) {
    super(`Power BI export invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "PowerbiValidationError";
    this.details = issues;
  }
}
