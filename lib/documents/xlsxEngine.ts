/**
 * XLSX engine (PHASE 3): openpyxl-style standards enforced in code —
 * zero null/blank cells (defaults 0 / "N/A"), 100% live formulas, list +
 * decimal data validations, freeze_panes A2, auto-fit widths (no ###),
 * number formats ($#,##0.00 / 0.0% / yyyy-mm-dd) and a MANDATORY headless
 * recalculation that must find ZERO errors (#REF!, #DIV/0!, #VALUE!,
 * #NAME?, #N/A) before the workbook is returned.
 */
import ExcelJS from "exceljs";
import { normalizeXlsx, type XlsxSpec, type XlsxColumn } from "./schemas";
import { recalcWorkbook, type RecalcSheet } from "./recalc";
import { safeName } from "./pdfEngine";

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
  const spec: XlsxSpec = (rawSpec as XlsxSpec)?.sheets ? (rawSpec as XlsxSpec) : normalizeXlsx(rawSpec)!;
  if (!spec) throw new Error("Invalid xlsx spec");

  const wb = new ExcelJS.Workbook();
  wb.creator = "Local AI WebUI";
  const recalcSheets: RecalcSheet[] = [];

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

    // Auto-fit widths (no ###): label + sample content, clamped
    sheet.columns.forEach((col, ci) => {
      let maxLen = String(col.label).length;
      for (const row of sheet.rows.slice(0, 200)) {
        const v = row?.[col.key];
        const len = isFormula(v) ? 12 : String(v ?? "").length;
        if (len > maxLen) maxLen = len;
      }
      ws.getColumn(ci + 1).width = col.width ?? Math.min(48, Math.max(10, Math.round(maxLen * 1.15) + 3));
    });

    // freeze_panes = "A2"
    if (sheet.freezeHeader) ws.views = [{ state: "frozen", ySplit: 1, xSplit: 0 }];

    recalcSheets.push({ name: sheet.name, rowCount, colCount, cells });
  }

  // MANDATORY headless recalculation: errors_found must equal 0.
  const recalc = recalcWorkbook(recalcSheets);
  if (recalc.errors.length > 0) throw new XlsxRecalcError(recalc.errors);

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
