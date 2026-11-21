/**
 * XLSX engine (PHASE 3): openpyxl-style standards enforced in code —
 * zero null/blank cells (defaults 0 / "N/A"), 100% live formulas, list +
 * decimal data validations, freeze_panes A2, auto-fit widths (no ###),
 * number formats ($#,##0.00 / 0.0% / yyyy-mm-dd) and a MANDATORY headless
 * recalculation that must find ZERO errors (#REF!, #DIV/0!, #VALUE!,
 * #NAME?, #N/A) before the workbook is returned.
 */
import ExcelJS from "exceljs";
import { normalizeXlsx, cfColors, type XlsxSpec, type XlsxColumn, type XlsxConditionalFormat } from "./schemas";
import { recalcWorkbook, type RecalcSheet } from "./recalc";
import { safeName, renderChartPng } from "./pdfEngine";
import { chartHtmlDocument } from "./chartHtml";
import {
  parseCellValue, displayValue, columnNumFmt, parseStrictNumber, resolvePercentScale,
  type ColumnSemantics, type ParsedValue, type ScaleSource, type ValueIssue,
} from "./valueModel";

const NUMFMT: Record<string, string> = {
  currency: '$#,##0.00',
  percent: "0.0%",
  date: "yyyy-mm-dd",
  number: "#,##0.00",
  integer: "#,##0",
  text: "@",
};

const isFormula = (v: unknown): boolean => typeof v === "string" && v.trim().startsWith("=");

/** F11: a spec column expressed in the shared value model's terms. */
function sem(col: XlsxColumn): ColumnSemantics {
  return { format: col.format, nullPolicy: col.nullPolicy, currency: col.currency, percentScale: col.percentScale };
}

/** Back-compat shim for callers that only need the materialized value.
 *  Prefer parseCellValue: it also reports WHY a value changed shape. */
function sanitizeValue(v: unknown, colSem: ColumnSemantics): string | number | boolean | null {
  return parseCellValue(v, colSem).value;
}

/** Number format for one cell: the value's own detected/declared semantics win. */
function numFmtFor(parsed: ParsedValue, colSem: ColumnSemantics): string {
  return parsed.numFmt ?? columnNumFmt(colSem);
}

/**
 * F11: the column's value semantics, with the percent scale resolved from
 * declarations only (percentScale, else the column's own decimal bounds).
 * Resolved once per column so literals AND formulas in the same column
 * render under one unit convention â€” a derived margin is still a margin.
 */
function colSemantics(col: XlsxColumn): { sem: ColumnSemantics; scaleSource: ScaleSource } {
  const base = sem(col);
  const v = col.validation as { type?: string; min?: number; max?: number } | undefined;
  const r = resolvePercentScale(base, v && v.type === "decimal" ? { min: v.min, max: v.max } : undefined);
  if (!r.scale) return { sem: base, scaleSource: "none" };
  return { sem: { ...base, percentScale: r.scale }, scaleSource: r.source };
}

/** F11: one recorded value decision, addressable to a sheet/cell. */
export interface XlsxValueIssue extends ValueIssue {
  sheet: string;
  /** A1 address, or "" when the decision is not cell-specific. */
  cell: string;
  column: string;
  /** The literal from the request, verbatim ("" when the key was absent). */
  raw: string;
}

/**
 * Approximate on-screen text for width fitting (mirrors the client preview).
 * F11: no scale guessed from magnitude — an undeclared percent renders as a
 * plain number, and a blank cell has no display text at all.
 */
function previewText(v: unknown, colSem: ColumnSemantics): string {
  if (v == null || v === "") return "";
  return displayValue(v, colSem);
}

export interface XlsxBuildResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
  recalcErrors: number;
  /** F11: every value the engine could not measure as given, and what it did
   *  instead. Never empty when the engine declined to invent a measurement. */
  valueIssues: XlsxValueIssue[];
  /**
   * F77: every chart whose PNG render failed, so an incomplete export can
   * NEVER report success silently. The workbook still builds (the preview's
   * inline-SVG fallback covers a missing image), but the caller and the route
   * header state exactly which chart images are absent and why.
   */
  chartFailures: { title: string; reason: string }[];
}

export class XlsxRecalcError extends Error {
  constructor(public details: { sheet: string; cell: string; formula: string; error: string; reason?: string }[]) {
    // The diagnostic reason (e.g. "unknown function FOO (unknown_function)" or
    // "circular reference") rides along so the model can actually fix the formula.
    super("XLSX recalculation found " + details.length + " formula error(s): " + details.map((d) => `${d.sheet}!${d.cell} ${d.error} [${d.formula}]${d.reason ? " (" + d.reason + ")" : ""}`).join("; "));
  }
}

export async function buildXlsx(rawSpec: unknown): Promise<XlsxBuildResult> {
  // Always normalize: rowGenerator expansion + chart/CF parsing happen there.
  // normalizeXlsx is idempotent (generator cleared post-expansion), so an
  // already-normalized spec passes through unchanged.
  const spec: XlsxSpec | null = normalizeXlsx(rawSpec) ?? ((rawSpec as XlsxSpec)?.sheets ? (rawSpec as XlsxSpec) : null);
  if (!spec) throw new Error("Invalid xlsx spec");

  const wb = new ExcelJS.Workbook();
  wb.creator = "Local AI WebUI";
  const recalcSheets: RecalcSheet[] = [];
  // Per-sheet geometry kept for the post-recalc width pass; formula cells are
  // tracked so the recalc RESULT can be cached into them (Excel/preview then
  // shows values immediately instead of blank "###" placeholders).
  interface SheetCtx { ws: ExcelJS.Worksheet; sheet: (typeof spec.sheets)[number]; dataStart: number; dataEnd: number; totalRowIdx: number | null; colSem: ColumnSemantics[]; scaleSource: ScaleSource[] }
  const sheetCtx: SheetCtx[] = [];
  const formulaCells: { cell: ExcelJS.Cell; key: string; f: string }[] = [];
  const valueIssues: XlsxValueIssue[] = [];
  const chartFailures: { title: string; reason: string }[] = [];

  for (const sheet of spec.sheets) {
    const ws = wb.addWorksheet(sheet.name);
    const sems = sheet.columns.map((c) => colSemantics(c));
    const seenScaleIssue = new Set<number>();
    const scaleIssue = (ci: number, cellRef: string, raw: string) => {
      if (sems[ci].scaleSource !== "bounds" || seenScaleIssue.has(ci)) return;
      seenScaleIssue.add(ci);
      const b = sheet.columns[ci].validation as { min?: number; max?: number } | undefined;
      valueIssues.push({
        sheet: sheet.name, cell: cellRef, column: sheet.columns[ci].key, raw,
        reason: "percent_scale_undeclared",
        detail: `column declares a ${b?.min}-${b?.max} range, so its numbers are ratios`,
        action: "scaled with the 0-1 range this column declares; add percentScale (\"fraction\"|\"points\") to make that explicit",
      });
    };
    const cells = new Map<string, { formula?: string; value?: string | number | boolean | null }>();
    const colCount = sheet.columns.length;
    const dataStart = 2; // 1-based: header row is 1
    const dataEnd = dataStart + sheet.rows.length - 1;
    const totalRowIdx = sheet.totalRow ? dataEnd + 1 : null;
    const rowCount = Math.max(1, (totalRowIdx ?? dataEnd));

    // Header row
    sheet.columns.forEach((col, ci) => {
      const cell = ws.getCell(1, ci + 1);
      cell.value = col.label;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111827" } };
      cell.alignment = { vertical: "middle" };
      cell.border = { bottom: { style: "thin", color: { argb: "FF262626" } } };
      cells.set(addr(ci + 1, 1), { value: col.label });
    });

    // Data rows — zero null/blank cells
    sheet.rows.forEach((row, ri) => {
      const r = dataStart + ri;
      sheet.columns.forEach((col, ci) => {
        const cell = ws.getCell(r, ci + 1);
        const cs = sems[ci].sem;
        const raw = row?.[col.key];
        if (isFormula(raw)) {
          const f = String(raw).trim().slice(1);
          cell.value = { formula: f };
          formulaCells.push({ cell, key: sheet.name + "!" + addr(ci + 1, r), f });
          cells.set(addr(ci + 1, r), { formula: "=" + f });
          // F11: a formula inherits the COLUMN unit convention. Omitting it left
          // a derived percentage printing as a bare ratio.
          cell.numFmt = columnNumFmt(cs);
          if (cs.format === "percent" && !cs.percentScale) {
            valueIssues.push({
              sheet: sheet.name, cell: addr(ci + 1, r), column: col.key, raw: String(raw),
              reason: "percent_scale_undeclared",
              detail: "formula in a percent column with no declared scale",
              action: "formatted as a plain number â€” declare percentScale so a derived ratio is not shown un-scaled",
            });
          } else {
            scaleIssue(ci, addr(ci + 1, r), String(raw));
          }
        } else {
          const parsed = parseCellValue(raw, cs);
          cell.value = parsed.value as unknown as ExcelJS.CellValue;
          cells.set(addr(ci + 1, r), { value: parsed.value ?? null });
          if (parsed.issue) {
            valueIssues.push({
              sheet: sheet.name, cell: addr(ci + 1, r), column: col.key,
              raw: raw === undefined ? "" : String(raw), ...parsed.issue,
            });
          }
          cell.numFmt = numFmtFor(parsed, cs);
          if (parsed.issue?.reason === "percent_scale_undeclared" || cs.percentScale) {
            if (sems[ci].scaleSource === "bounds") scaleIssue(ci, addr(ci + 1, r), String(raw ?? ""));
          }
        }
        cell.border = { bottom: { style: "hair", color: { argb: "FFE5E7EB" } } };
        if (col.validation) {
          cell.dataValidation = col.validation.type === "list"
            ? { type: "list", formulae: ['"' + col.validation.values.join(",") + '"'], allowBlank: true, error: "Pick a listed value", errorTitle: "Invalid value" }
            : { type: "decimal", operator: "between", formulae: [col.validation.min ?? -1e12, col.validation.max ?? 1e12], allowBlank: true, error: "Out of range", errorTitle: "Invalid value" };
        }
      });
    });

    // Mandatory total row with live SUM formulas
    if (totalRowIdx && sheet.rows.length) {
      sheet.columns.forEach((col, ci) => {
        const cell = ws.getCell(totalRowIdx, ci + 1);
        const letter = colLetter(ci + 1);
        if (ci === 0) {
          cell.value = "Total";
          cells.set(addr(ci + 1, totalRowIdx), { value: "Total" });
        } else if (col.format !== "text" && col.format !== "date") {
          const f = `SUM(${letter}${dataStart}:${letter}${dataEnd})`;
          cell.value = { formula: f };
          formulaCells.push({ cell, key: sheet.name + "!" + addr(ci + 1, totalRowIdx), f });
          cells.set(addr(ci + 1, totalRowIdx), { formula: "=" + f });
          cell.numFmt = columnNumFmt(sems[ci].sem);
        } else {
          cell.value = "—"; // zero-blank-cell mandate: never leave a total-row cell empty
          cells.set(addr(ci + 1, totalRowIdx), { value: "—" });
        }
        cell.font = { bold: true };
        cell.border = { top: { style: "thin", color: { argb: "FF262626" } } };
      });
    }

    // AutoFilter on every header row.
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, dataEnd), column: colCount } };

    // Conditional formatting: explicit colors win; status words
    // (OVERSPEND/REORDER/FAIL/OK/PASS) get the default red/amber/green.
    for (const cf of sheet.conditionalFormatting ?? []) {
      const ref = resolveCfRange(cf, sheet.columns, dataStart, dataEnd);
      if (!ref) continue;
      try { ws.addConditionalFormatting({ ref, rules: [cfRuleToExcel(cf)] }); } catch { /* malformed range from a local model — skip the rule, never the workbook */ }
    }

    // Native charts: headless-Chromium PNG embed (primary). If Chromium is
    // unavailable the workbook still builds — the interactive XlsxBlock
    // preview renders the same spec as inline SVG.
    let chartRow = dataEnd + 2;
    for (const chart of sheet.charts ?? []) {
      try {
        const html = chartHtmlDocument({ type: chart.type, title: chart.title || undefined, categories: chart.categories, series: chart.series }, { width: 640, height: 360, theme: "light" });
        const shot = await renderChartPng(html, { width: 640, height: 360, scale: 2 });
        // Casts: exceljs's bundled Buffer/range typings lag Node 24 (same
        // pattern as the test suite's wb.xlsx.load(buffer) cast).
        const id = wb.addImage({ buffer: shot.buffer, extension: "png" } as unknown as Parameters<typeof wb.addImage>[0]);
        const cell = chart.anchor ? /^([A-Za-z]{1,3})([1-9][0-9]*)$/.exec(chart.anchor.toUpperCase()) : null;
        ws.addImage(id, {
          type: "oneCell",
          tl: cell ? { col: colToIdx0(cell[1]), row: parseInt(cell[2], 10) - 1 } : { col: 0, row: chartRow - 1 },
          ext: { width: 640, height: 360 },
        } as unknown as Parameters<typeof ws.addImage>[1]);
        if (!cell) chartRow += 20;
      } catch (err) {
        // The workbook still builds and the preview SVG fallback covers it,
        // but the failure is RECORDED, not swallowed: an export missing chart
        // images must be able to say so (result field + response header).
        chartFailures.push({
          title: chart.title || chart.type,
          reason: err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err).slice(0, 200),
        });
      }
    }

    // freeze_panes = "A2"
    if (sheet.freezeHeader) ws.views = [{ state: "frozen", ySplit: 1, xSplit: 0 }];

    recalcSheets.push({ name: sheet.name, rowCount, colCount, cells });
    sheetCtx.push({ ws, sheet, dataStart, dataEnd, totalRowIdx, colSem: sems.map((s) => s.sem), scaleSource: sems.map((s) => s.scaleSource) });
  }

  // MANDATORY headless recalculation: errors_found must equal 0.
  const recalc = recalcWorkbook(recalcSheets);
  if (recalc.errors.length > 0) throw new XlsxRecalcError(recalc.errors);

  // Cache each formula's computed result into the cell: Excel, LibreOffice
  // and viewers show the VALUE immediately — no blank/error placeholders and
  // no "###" until the app recalculates on open. The live formula is kept.
  for (const fc of formulaCells) {
    const r = recalc.computed.get(fc.key);
    fc.cell.value = r === undefined || r === null
      ? { formula: fc.f }
      : { formula: fc.f, result: r as string | number | boolean | Date };
  }

  // Auto-fit widths (no ###): measured on the FORMATTED display text — for
  // formula cells that is the recalc result ("$12,345.67"), never the raw
  // formula source length, which is what produced the too-narrow columns.
  for (const ctx of sheetCtx) {
    ctx.sheet.columns.forEach((col, ci) => {
      const cs = ctx.colSem[ci];
      let maxLen = String(col.label).length;
      ctx.sheet.rows.slice(0, 200).forEach((row, ri) => {
        const raw = row?.[col.key];
        const text = isFormula(raw)
          ? previewText(recalc.computed.get(ctx.sheet.name + "!" + addr(ci + 1, ctx.dataStart + ri)), cs)
          : previewText(sanitizeValue(raw, cs), cs);
        if (text.length > maxLen) maxLen = text.length;
      });
      if (ctx.totalRowIdx) {
        const cv = recalc.computed.get(ctx.sheet.name + "!" + addr(ci + 1, ctx.totalRowIdx));
        maxLen = Math.max(maxLen, cv === undefined ? 5 : previewText(cv, cs).length);
      }
      ctx.ws.getColumn(ci + 1).width = col.width ?? Math.min(48, Math.max(10, Math.round(maxLen * 1.15) + 3));
    });
  }

  const out = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(out),
    filename: safeName(spec.filename) + ".xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    recalcErrors: 0,
    valueIssues,
    chartFailures,
  };
}

function colLetter(idx1: number): string {
  let s = "";
  let n = idx1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function addr(col1: number, row1: number): string { return colLetter(col1) + row1; }
function colToIdx0(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function hexArgb(hex: string): string {
  const h = String(hex).replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(h) ? "FF" + h.toUpperCase() : "FF000000";
}
function resolveCfRange(cf: XlsxConditionalFormat, columns: XlsxColumn[], dataStart: number, dataEnd: number): string | null {
  if (cf.range && /^[A-Za-z]{1,3}[1-9][0-9]*:[A-Za-z]{1,3}[1-9][0-9]*$/.test(cf.range)) return cf.range.toUpperCase();
  if (cf.columnKey) {
    const ci = columns.findIndex((c) => c.key === cf.columnKey);
    if (ci >= 0) return `${colLetter(ci + 1)}${dataStart}:${colLetter(ci + 1)}${Math.max(dataStart, dataEnd)}`;
  }
  return null;
}
/** F11: a conditional-format comparison value is a number or a quoted text
 *  literal, never "Number(value) || 0" (which turns "OVERSPEND" into 0). */
function cfCompareValue(v: unknown): number | string {
  const n = parseStrictNumber(v);
  if (n !== null) return n;
  return '"' + String(v ?? "").replace(/["\\]/g, "") + '"';
}

function cfRuleToExcel(cf: XlsxConditionalFormat): ExcelJS.ConditionalFormattingRule {
  const c = cfColors(cf);
  // Partial style/rule objects: exceljs's full Style type demands numFmt/
  // alignment/protection/border and every rule demands priority, but the
  // runtime writer happily emits partial styles (verified by round-trip test).
  const style = {
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: hexArgb(c.fill) } },
    font: { color: { argb: hexArgb(c.fontColor) } },
  } as unknown as ExcelJS.Style;
  const rule = ((): object => {
    switch (cf.rule) {
      case "greaterThan": return { type: "cellIs", operator: "greaterThan", formulae: [cfCompareValue(cf.value)], style };
      case "lessThan": return { type: "cellIs", operator: "lessThan", formulae: [cfCompareValue(cf.value)], style };
      case "equal": return { type: "cellIs", operator: "equal", formulae: [typeof cf.value === "number" ? cf.value : `"${String(cf.value ?? "")}"`], style };
      case "between": return { type: "cellIs", operator: "between", formulae: [cf.min ?? -1e12, cf.max ?? 1e12], style };
      case "containsText": return { type: "containsText", operator: "containsText", text: String(cf.value ?? ""), style };
    }
  })();
  return rule as unknown as ExcelJS.ConditionalFormattingRule;
}
