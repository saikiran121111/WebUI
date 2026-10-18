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
import DocumentCard, { FenceBroken, FencePending } from "./DocumentCard";

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

function totalFor(sheet: XlsxSheet, col: XlsxColumn, idx: number): { text: string; formula: string } {
  if (col.format === "text") return { text: "—", formula: "" };
  const letter = String.fromCharCode(65 + (idx % 26));
  const last = sheet.rows.length; // data occupies rows 2..last+1
  const formula = `=SUM(${letter}2:${letter}${last + 1})`;
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

  if (streaming) return <FencePending label="XLSX" chars={source.length} />;
  if (!spec) return <FenceBroken label="xlsx" />;

  const sheet = spec.sheets[Math.min(active, spec.sheets.length - 1)];
  const filename = safeName(spec.filename) + ".xlsx";

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
                {sheet.columns.map((c, ci) => (
                  <td key={ci} className={c.format === "text" ? "" : "xlsx-num"}>{fmtCell(r[c.key], c)}</td>
                ))}
              </tr>
            ))}
            {sheet.totalRow && (
              <tr className="xlsx-total">
                {sheet.columns.map((c, ci) => {
                  const t = totalFor(sheet, c, ci);
                  return (
                    <td key={ci} className={c.format === "text" ? "" : "xlsx-num"}>
                      {t.formula && <span className="xlsx-fx" title={t.formula}>fx</span>}
                      {t.text}
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
