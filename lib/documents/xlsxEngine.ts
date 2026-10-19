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

const NUMFMT: Record<string, string> = {
  currency: '$#,##0.00',
  percent: "0.0%",
  date: "yyyy-mm-dd",
  number: "#,##0.00",
  integer: "#,##0",
  text: "@",
};

const isFormula = (v: unknown): boolean => typeof v === "string" && v.trim().startsWith("=");

function sanitizeValue(v: unknown, col: XlsxColumn): string | number {
  if (col.format === "text" || col.format === "date") {
    if (v == null || v === "") return "N/A";
    return String(v);
  }
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/[$,%\s]/g, ""));
  return isFinite(n) ? n : 0;
}

/** Approximate on-screen text for width fitting (mirrors the client preview). */
function previewText(v: unknown, col: XlsxColumn): string {
  if (v == null || v === "") return col.format === "text" || col.format === "date" ? "N/A" : "0";
  if (col.format === "text" || col.format === "date") return String(v);
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  if (!isFinite(n)) return String(v);
  switch (col.format) {
    case "currency": return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "percent": return (n <= 1.5 ? (n * 100).toFixed(1) : n.toFixed(1)) + "%";
    case "integer": return Math.round(n).toLocaleString("en-US");
    case "number": return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    default: return String(n);
  }
}

export interface XlsxBuildResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
  recalcErrors: number;
}

export class XlsxRecalcError extends Error {
  constructor(public details: { sheet: string; cell: string; formula: string; error: string }[]) {
    super("XLSX recalculation found " + details.length + " formula error(s): " + details.map((d) => `${d.sheet}!${d.cell} ${d.error} [${d.formula}]`).join("; "));
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
  interface SheetCtx { ws: ExcelJS.Worksheet; sheet: (typeof spec.sheets)[number]; dataStart: number; dataEnd: number; totalRowIdx: number | null }
  const sheetCtx: SheetCtx[] = [];
  const formulaCells: { cell: ExcelJS.Cell; key: string; f: string }[] = [];

  for (const sheet of spec.sheets) {
    const ws = wb.addWorksheet(sheet.name);
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
        const raw = row?.[col.key];
        if (isFormula(raw)) {
          const f = String(raw).trim().slice(1);
          cell.value = { formula: f };
          formulaCells.push({ cell, key: sheet.name + "!" + addr(ci + 1, r), f });
          cells.set(addr(ci + 1, r), { formula: "=" + f });
        } else {
          const v = sanitizeValue(raw, col);
          cell.value = v;
          cells.set(addr(ci + 1, r), { value: v });
        }
        cell.numFmt = NUMFMT[col.format] ?? NUMFMT.text;
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
          cell.numFmt = NUMFMT[col.format] ?? NUMFMT.number;
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
      } catch { /* skip embed; preview SVG fallback covers it */ }
    }

    // freeze_panes = "A2"
    if (sheet.freezeHeader) ws.views = [{ state: "frozen", ySplit: 1, xSplit: 0 }];

    recalcSheets.push({ name: sheet.name, rowCount, colCount, cells });
    sheetCtx.push({ ws, sheet, dataStart, dataEnd, totalRowIdx });
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
      let maxLen = String(col.label).length;
      ctx.sheet.rows.slice(0, 200).forEach((row, ri) => {
        const raw = row?.[col.key];
        const text = isFormula(raw)
          ? previewText(recalc.computed.get(ctx.sheet.name + "!" + addr(ci + 1, ctx.dataStart + ri)), col)
          : previewText(sanitizeValue(raw, col), col);
        if (text.length > maxLen) maxLen = text.length;
      });
      if (ctx.totalRowIdx) {
        const cv = recalc.computed.get(ctx.sheet.name + "!" + addr(ci + 1, ctx.totalRowIdx));
        maxLen = Math.max(maxLen, cv === undefined ? 5 : previewText(cv, col).length);
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
      case "greaterThan": return { type: "cellIs", operator: "greaterThan", formulae: [Number(cf.value) || 0], style };
      case "lessThan": return { type: "cellIs", operator: "lessThan", formulae: [Number(cf.value) || 0], style };
      case "equal": return { type: "cellIs", operator: "equal", formulae: [typeof cf.value === "number" ? cf.value : `"${String(cf.value ?? "")}"`], style };
      case "between": return { type: "cellIs", operator: "between", formulae: [cf.min ?? -1e12, cf.max ?? 1e12], style };
      case "containsText": return { type: "containsText", operator: "containsText", text: String(cf.value ?? ""), style };
    }
  })();
  return rule as unknown as ExcelJS.ConditionalFormattingRule;
}
