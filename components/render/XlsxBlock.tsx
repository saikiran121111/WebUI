"use client";
/**
 * XLSX fence (PHASE 3): JSON spec → live-formula workbook. The preview shows
 * every sheet with its frozen header, number formats and the computed total
 * row (the same SUM ranges the server writes as live formulas — the fx chip
 * names the exact formula the cell will carry). Zero blank cells: empty
 * numeric cells render 0, empty text cells N/A, mirroring the engine's
 * no-null guarantee.
 */
import { useMemo, useState } from "react";
import { normalizeXlsx, safeName, XlsxColumn, XlsxSheet } from "../../lib/documents/schemas";
import { recalcWorkbook, idxToCol, type RecalcSheet } from "../../lib/documents/recalc";
import DocumentCard, { FenceBroken, FencePending } from "./DocumentCard";

const isFormulaStr = (v: unknown): boolean => typeof v === "string" && v.trim().startsWith("=");

/** Mirrors xlsxEngine.sanitizeValue so the preview model matches the workbook. */
function sanitizePreview(v: unknown, col: XlsxColumn): string | number {
  if (col.format === "text" || col.format === "date") {
    if (v == null || v === "") return "N/A";
    return String(v);
  }
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/[$,%\s]/g, ""));
  return isFinite(n) ? n : 0;
}

function fmtCell(v: unknown, col: XlsxColumn): string {
  if (v == null || v === "") return col.format === "text" ? "N/A" : "0";
  if (col.format === "currency") {
    const n = Number(v);
    return isFinite(n) ? "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
  }
  if (col.format === "percent") {
    const n = Number(v);
    return isFinite(n) ? (n <= 1.5 ? (n * 100).toFixed(1) : n.toFixed(1)) + "%" : String(v);
  }
  if (col.format === "integer") {
    const n = Number(v);
    return isFinite(n) ? Math.round(n).toLocaleString("en-US") : String(v);
  }
  if (col.format === "number") {
    const n = Number(v);
    return isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(v);
  }
  return String(v);
}

function totalFormula(sheet: XlsxSheet, col: XlsxColumn, idx: number): string {
  const letter = idxToCol(idx);
  return `=SUM(${letter}2:${letter}${sheet.rows.length + 1})`;
}

function totalFor(sheet: XlsxSheet, col: XlsxColumn, idx: number): { text: string; formula: string } {
  if (col.format === "text" || col.format === "date") return { text: "—", formula: "" };
  const formula = totalFormula(sheet, col, idx);
  const sum = sheet.rows.reduce((acc, r) => {
    const n = Number(r[col.key]);
    return acc + (isFinite(n) ? n : 0);
  }, 0);
  return { text: fmtCell(sum, col), formula };
}

export default function XlsxBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const spec = useMemo(() => {
    try {
      return normalizeXlsx(JSON.parse(source));
    } catch {
      return null;
    }
  }, [source]);
  const [active, setActive] = useState(0);

  // Behind-the-scenes validation: run the SAME pure-JS evaluator the server
  // gate uses (lib/documents/recalc) over a model of the workbook, so the
  // preview shows each formula's computed VALUE (fx chip names the formula)
  // instead of the raw "=SUM(...)" text. If any formula errors out, recalc is
  // null and the preview falls back to raw display — the download gate will
  // surface the exact error then, exactly as before.
  const recalc = useMemo(() => {
    if (!spec) return null;
    try {
      const sheets: RecalcSheet[] = spec.sheets.map((sh) => {
        const cells = new Map<string, { formula?: string; value?: string | number | boolean | null }>();
        const dataStart = 2;
        const dataEnd = dataStart + sh.rows.length - 1;
        const totalRowIdx = sh.totalRow ? dataEnd + 1 : null;
        const at = (ci: number, r: number) => idxToCol(ci) + r;
        sh.columns.forEach((c, ci) => cells.set(at(ci, 1), { value: c.label }));
        sh.rows.forEach((row, ri) => {
          const r = dataStart + ri;
          sh.columns.forEach((col, ci) => {
            const raw = row?.[col.key];
            if (isFormulaStr(raw)) cells.set(at(ci, r), { formula: String(raw).trim() });
            else cells.set(at(ci, r), { value: sanitizePreview(raw, col) });
          });
        });
        if (totalRowIdx && sh.rows.length) {
          sh.columns.forEach((col, ci) => {
            if (ci === 0) cells.set(at(ci, totalRowIdx), { value: "Total" });
            else if (col.format !== "text" && col.format !== "date")
              cells.set(at(ci, totalRowIdx), { formula: totalFormula(sh, col, ci) });
            else cells.set(at(ci, totalRowIdx), { value: "—" });
          });
        }
        return { name: sh.name, rowCount: Math.max(1, totalRowIdx ?? dataEnd), colCount: sh.columns.length, cells };
      });
      const res = recalcWorkbook(sheets);
      return res.errors.length === 0 ? res : null;
    } catch {
      return null;
    }
  }, [spec]);

  if (streaming) return <FencePending label="XLSX" />;
  if (!spec) return <FenceBroken label="xlsx" />;

  const sheet = spec.sheets[Math.min(active, spec.sheets.length - 1)];
  const filename = safeName(spec.filename) + ".xlsx";
  const computedAt = (ci: number, r1: number) =>
    recalc?.computed.get(sheet.name + "!" + idxToCol(ci) + r1);

  return (
    <DocumentCard badge="XLSX" filename={filename} endpoint="/api/documents/xlsx" spec={spec} testId="xlsx-block">
      <div className="xlsx-tabs" role="tablist" aria-label="Workbook sheets">
        {spec.sheets.map((sh, i) => (
          <button
            key={i}
            role="tab"
            type="button"
            aria-selected={i === active}
            className={"xlsx-tab" + (i === active ? " xlsx-tab--active" : "")}
            onClick={() => setActive(i)}
          >
            {sh.name}
          </button>
        ))}
      </div>
      <div className="xlsx-grid-wrap" data-testid="xlsx-preview">
        <table className="xlsx-grid">
          <thead>
            <tr>
              {sheet.columns.map((c, i) => (
                <th key={i} style={c.width ? { minWidth: Math.min(320, c.width * 8) } : undefined}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((r, ri) => (
              <tr key={ri}>
                {sheet.columns.map((c, ci) => {
                  const raw = r[c.key];
                  const isF = isFormulaStr(raw);
                  const cv = isF ? computedAt(ci, ri + 2) : undefined;
                  return (
                    <td key={ci} className={c.format === "text" ? "" : "xlsx-num"}>
                      {isF && <span className="xlsx-fx" title={String(raw).trim()}>fx</span>}
                      {isF && cv !== undefined ? fmtCell(cv, c) : fmtCell(raw, c)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {sheet.totalRow && (
              <tr className="xlsx-total">
                {sheet.columns.map((c, ci) => {
                  const t = totalFor(sheet, c, ci);
                  const cv = t.formula ? computedAt(ci, sheet.rows.length + 2) : undefined;
                  return (
                    <td key={ci} className={c.format === "text" ? "" : "xlsx-num"}>
                      {t.formula && <span className="xlsx-fx" title={t.formula}>fx</span>}
                      {t.formula && cv !== undefined ? fmtCell(cv, c) : t.text}
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DocumentCard>
  );
}
