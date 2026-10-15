"use client";
import { memo, useCallback, useRef, useState } from "react";
import { Check, Copy, ArrowUpDown } from "lucide-react";
import { copyText } from "../../lib/render/clipboard";

/**
 * Table wrapper used as the react-markdown `table` override: horizontal
 * scroll without page overflow, row sorting (only when it genuinely helps,
 * i.e. 5+ body rows), and CSV copy built from the actual cell text.
 * Sorting reorders DOM rows imperatively — no React state churn on big
 * tables and no re-render of the markdown tree.
 */
export default memo(function MarkdownTable({ children }: { children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<{ col: number; dir: 1 | -1 } | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [sortable, setSortable] = useState<boolean | null>(null);

  const measure = useCallback(() => {
    if (sortable !== null) return;
    const rows = wrapRef.current?.querySelectorAll("tbody tr").length ?? 0;
    setSortable(rows >= 5);
  }, [sortable]);

  const handleHeaderClick = useCallback((e: React.MouseEvent) => {
    const th = (e.target as Element).closest("th");
    if (!th) return;
    const table = th.closest("table");
    if (!table) return;
    const headers = Array.from(th.parentElement?.children ?? []);
    const col = headers.indexOf(th);
    if (col < 0) return;
    const tbody = table.querySelector("tbody");
    if (!tbody) return;
    const dir: 1 | -1 = sortRef.current?.col === col ? (sortRef.current.dir === 1 ? -1 : 1) : 1;
    sortRef.current = { col, dir };
    const rows = Array.from(tbody.querySelectorAll("tr"));
    rows.sort((a, b) => {
      const av = a.children[col]?.textContent ?? "";
      const bv = b.children[col]?.textContent ?? "";
      const an = parseFloat(av.replace(/,/g, ""));
      const bn = parseFloat(bv.replace(/,/g, ""));
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
      return av.localeCompare(bv) * dir;
    });
    for (const row of rows) tbody.appendChild(row);
    headers.forEach((h, i) => {
      h.classList.toggle("sort-asc", i === col && dir === 1);
      h.classList.toggle("sort-desc", i === col && dir === -1);
    });
  }, []);

  const handleCopyCsv = useCallback(async () => {
    const table = wrapRef.current?.querySelector("table");
    if (!table) return;
    const lines: string[] = [];
    for (const row of table.querySelectorAll("tr")) {
      const cells = Array.from(row.children).map(cell => csvEscape(cell.textContent ?? ""));
      lines.push(cells.join(","));
    }
    const ok = await copyText(lines.join("\r\n"));
    setCopyStatus(ok ? "copied" : "failed");
    setTimeout(() => setCopyStatus("idle"), 2000);
  }, []);

  return (
    <div className="md-table-wrap" ref={wrapRef} onPointerEnter={measure} data-testid="md-table-wrap">
      <table className="md-table" onClick={sortable ? handleHeaderClick : undefined}
        data-sortable={sortable ? "true" : undefined}>
        {children}
      </table>
      <div className="md-table-tools">
        {sortable && (
          <span className="md-table-sort-hint" aria-hidden="true">
            <ArrowUpDown className="w-3 h-3" /> click headers to sort
          </span>
        )}
        <button type="button" className="md-table-csv" onClick={handleCopyCsv}
          aria-label="Copy table as CSV" data-testid="table-csv-btn">
          {copyStatus === "copied" ? <Check className="w-3.5 h-3.5 text-emerald-400" />
            : copyStatus === "failed" ? <span className="text-xs">Failed</span>
              : <Copy className="w-3.5 h-3.5" />}
          <span className="text-xs">{copyStatus === "copied" ? "CSV copied" : "CSV"}</span>
        </button>
      </div>
    </div>
  );
});

function csvEscape(value: string): string {
  const flat = value.replace(/\r?\n/g, " ").trim();
  if (/[",]/.test(flat)) return `"${flat.replace(/"/g, '""')}"`;
  return flat;
}
