"use client";
/**
 * Power BI fence (PHASE 5): the download is a real .pbip package (TMDL
 * semantic model + PBIR report + embedded .pbit); the preview is a live
 * 60fps dashboard over the same dataset — KPI count-up (useTweenedNumbers)
 * with sparklines, interactive bar/donut cross-filtering, slicers (list +
 * date range) and a sortable drill-down table. DAX measures are evaluated
 * client-side by the mini evaluator below over the sanitized dataset, so
 * every tile reacts to filters instantly with zero round-trips.
 */
import { useCallback, useMemo, useState } from "react";
import { BiVisual, normalizePowerbi, PowerbiSpec, safeName } from "../../lib/documents/schemas";
import { chartSvg } from "../../lib/documents/chartHtml";
import { useTweenedNumbers } from "../../hooks/useTweenedNumbers";
import DocumentCard, { FenceBroken, FencePending } from "./DocumentCard";

// ---------- mini DAX evaluator (SUM/AVERAGE/MIN/MAX/COUNT/DIVIDE + column refs) ----------
function colRef(expr: string): string | null {
  const m = /(?:[A-Za-z_][\w]*\s*\[\s*([^\]]+)\s*\]|\[\s*([^\]]+)\s*\])/.exec(expr);
  return m ? (m[1] ?? m[2]).trim() : null;
}

function findAggFn(expr: string): { fn: string; arg: string } | null {
  const m = /^([A-Z][A-Z0-9]*)\s*\(/i.exec(expr.trim());
  if (!m) return null;
  const open = expr.indexOf("(", m.index + m[1].length);
  let depth = 0;
  for (let i = open; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") {
      depth--;
      if (depth === 0) return { fn: m[1].toUpperCase(), arg: expr.slice(open + 1, i) };
    }
  }
  return null;
}

function splitArgs(arg: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of arg) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function numericValues(rows: (string | number | null)[][], colIdx: number): number[] {
  return rows.map((r) => {
    const v = r[colIdx];
    if (typeof v === "number") return v;
    const n = Number(String(v ?? "").replace(/[$,%\s]/g, ""));
    return isFinite(n) ? n : 0;
  });
}

function evalDax(expr: string, rows: (string | number | null)[][], columns: { name: string }[]): number {
  const e = expr.trim();
  const num = /^-?\d+(?:\.\d+)?$/.exec(e);
  if (num) return Number(e);
  const agg = findAggFn(e);
  if (agg) {
    if (agg.fn === "DIVIDE") {
      const parts = splitArgs(agg.arg);
      const a = evalDax(parts[0] ?? "0", rows, columns);
      const b = parts[1] ? evalDax(parts[1], rows, columns) : 0;
      const alt = parts[2] ? evalDax(parts[2], rows, columns) : 0;
      return b === 0 ? alt : a / b;
    }
    const name = colRef(agg.arg);
    const ci = columns.findIndex((c) => c.name === name);
    if (ci < 0) return 0;
    const vals = numericValues(rows, ci);
    switch (agg.fn) {
      case "SUM": return vals.reduce((a, b) => a + b, 0);
      case "AVERAGE": case "AVERAGEX": return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      case "MIN": return vals.length ? Math.min(...vals) : 0;
      case "MAX": return vals.length ? Math.max(...vals) : 0;
      case "COUNT": case "COUNTA": return rows.length;
      case "DISTINCTCOUNT": return new Set(rows.map((r) => String(r[ci] ?? ""))).size;
      default: break;
    }
  }
  // CALCULATE(SUM(x), ...) and unknown wrappers: evaluate the inner aggregate.
  const inner = e.replace(/^[A-Z][A-Z0-9]*\s*\(/i, "").replace(/\)\s*$/, "");
  return inner !== e ? evalDax(inner, rows, columns) : 0;
}

function formatValue(v: number, format?: string): string {
  if (format === "currency") return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (format === "percent") return v.toFixed(1) + "%";
  return Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ---------- component ----------
type Cross = { dim: string; value: string } | null;

export default function PowerBiBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const spec = useMemo<PowerbiSpec | null>(() => {
    try {
      return normalizePowerbi(JSON.parse(source));
    } catch {
      return null;
    }
  }, [source]);

  const [slices, setSlices] = useState<Record<string, Set<string>>>({});
  const [dateRange, setDateRange] = useState<{ min: string; max: string } | null>(null);
  const [cross, setCross] = useState<Cross>(null);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const toggleSlice = useCallback((field: string, value: string) => {
    setSlices((prev) => {
      const next = { ...prev };
      const set = new Set(next[field] ?? []);
      if (set.has(value)) set.delete(value); else set.add(value);
      next[field] = set;
      return next;
    });
  }, []);

  const rows = useMemo(() => {
    if (!spec) return [];
    const colIdx = (f: string) => spec.dataset.columns.findIndex((c) => c.name === f);
    return spec.dataset.rows.filter((r) => {
      for (const [field, set] of Object.entries(slices)) {
        if (set.size && !set.has(String(r[colIdx(field)] ?? ""))) return false;
      }
      if (dateRange) {
        for (const c of spec.dataset.columns) {
          if (c.type !== "date") continue;
          const d = String(r[spec.dataset.columns.indexOf(c)] ?? "");
          if (dateRange.min && d < dateRange.min) return false;
          if (dateRange.max && d > dateRange.max) return false;
          break;
        }
      }
      if (cross) {
        const i = colIdx(cross.dim);
        if (i >= 0 && String(r[i] ?? "") !== cross.value) return false;
      }
      return true;
    });
  }, [spec, slices, dateRange, cross]);

  if (streaming) return <FencePending label="Power BI report" chars={source.length} />;
  if (!spec) return <FenceBroken label="powerbi" />;

  const measureDax = (name?: string) =>
    spec.measures.find((m) => m.name === name)?.dax ?? spec.measures[0]?.dax ?? "SUM(Sales[Value])";

  const aggBy = (dim: string, dax: string): { label: string; value: number }[] => {
    const di = spec.dataset.columns.findIndex((c) => c.name === dim);
    if (di < 0) return [];
    const groups = new Map<string, (string | number | null)[][]>();
    for (const r of rows) {
      const k = String(r[di] ?? "N/A");
      const g = groups.get(k) ?? [];
      g.push(r);
      groups.set(k, g);
    }
    return [...groups.entries()].map(([label, g]) => ({ label, value: evalDax(dax, g, spec.dataset.columns) }));
  };

  const dateCol = spec.dataset.columns.find((c) => c.type === "date");
  const sparkline = (dax: string): number[] => {
    if (!dateCol) return rows.map((_, i) => evalDax(dax, [rows[i]], spec.dataset.columns));
    const di = spec.dataset.columns.indexOf(dateCol);
    const buckets = new Map<string, (string | number | null)[][]>();
    for (const r of rows) {
      const k = String(r[di] ?? "").slice(0, 7);
      const g = buckets.get(k) ?? [];
      g.push(r);
      buckets.set(k, g);
    }
    return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, g]) => evalDax(dax, g, spec.dataset.columns));
  };

  const kpiTargets = spec.visuals.filter((v) => v.type === "kpi").map((v) => evalDax(measureDax(v.measure), rows, spec.dataset.columns));
  const kpiValues = useTweenedNumbers(kpiTargets, 650);

  const toggleCross = (dim: string, value: string) =>
    setCross((c) => (c && c.dim === dim && c.value === value ? null : { dim, value }));

  const filename = safeName(spec.filename) + ".pbip.zip";

  const renderVisual = (v: BiVisual, i: number) => {
    const dax = measureDax(v.measure);
    if (v.type === "kpi") {
      const kpiIdx = spec.visuals.slice(0, i).filter((x) => x.type === "kpi").length;
      const val = kpiValues[kpiIdx] ?? 0;
      const spark = sparkline(dax);
      const max = Math.max(...spark.map(Math.abs), 1);
      return (
        <div key={i} className="bi-kpi" data-testid={"bi-kpi-" + i}>
          <div className="bi-kpi-title">{v.title}</div>
          <div className="bi-kpi-value">{formatValue(val, v.format)}</div>
          {spark.length > 1 && (
            <svg className="bi-spark" viewBox={`0 0 ${spark.length * 10} 40`} preserveAspectRatio="none" aria-hidden="true">
              <polyline
                points={spark.map((s, j) => `${j * 10 + 5},${34 - (s / max) * 30 + (s < 0 ? 6 : 0)}`).join(" ")}
                fill="none" stroke="#38E8FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      );
    }
    if (v.type === "bar" || v.type === "waterfall") {
      const data = v.dimension ? aggBy(v.dimension, dax) : [];
      const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
      return (
        <div key={i} className="bi-card" data-testid={"bi-bar-" + i}>
          <div className="bi-card-title">{v.title}</div>
          <div className="bi-bars">
            {data.map((d, j) => {
              const active = !cross || (cross.dim === v.dimension && cross.value === d.label);
              return (
                <button
                  key={j}
                  type="button"
                  className={"bi-bar-row" + (active ? "" : " bi-bar-row--dim")}
                  onClick={() => v.dimension && toggleCross(v.dimension, d.label)}
                  aria-label={`Filter ${v.dimension}: ${d.label}`}
                >
                  <span className="bi-bar-label">{d.label}</span>
                  <span className="bi-bar-track">
                    <span
                      className="bi-bar-fill"
                      style={{ width: `${(Math.abs(d.value) / max) * 100}%`, background: d.value < 0 ? "#EF4444" : "#38E8FF" }}
                    />
                  </span>
                  <span className="bi-bar-value">{formatValue(d.value, v.format)}</span>
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    if (v.type === "donut") {
      const data = v.dimension ? aggBy(v.dimension, dax) : [];
      const total = data.reduce((a, b) => a + Math.abs(b.value), 0) || 1;
      let acc = 0;
      const R = 54, C = 2 * Math.PI * R;
      return (
        <div key={i} className="bi-card" data-testid={"bi-donut-" + i}>
          <div className="bi-card-title">{v.title}</div>
          <div className="bi-donut-wrap">
            <svg viewBox="0 0 140 140" className="bi-donut" role="img" aria-label={v.title}>
              {data.map((d, j) => {
                const frac = Math.abs(d.value) / total;
                const dash = `${frac * C} ${C - frac * C}`;
                const off = -acc * C;
                acc += frac;
                const active = !cross || (cross.dim === v.dimension && cross.value === d.label);
                return (
                  <circle
                    key={j}
                    cx="70" cy="70" r={R} fill="none"
                    stroke={["#38E8FF", "#22C55E", "#A78BFA", "#F59E0B", "#EF4444", "#64748B"][j % 6]}
                    strokeWidth={active ? 18 : 10}
                    strokeDasharray={dash} strokeDashoffset={off}
                    transform="rotate(-90 70 70)"
                    opacity={active ? 1 : 0.35}
                    style={{ cursor: "pointer", transition: "stroke-width .25s ease, opacity .25s ease" }}
                    onClick={() => v.dimension && toggleCross(v.dimension, d.label)}
                  />
                );
              })}
              <text x="70" y="75" textAnchor="middle" fill="#FFFFFF" fontSize="16">{formatValue(evalDax(dax, rows, spec.dataset.columns), v.format)}</text>
            </svg>
            <div className="bi-legend">
              {data.map((d, j) => (
                <span key={j}>
                  <i style={{ background: ["#38E8FF", "#22C55E", "#A78BFA", "#F59E0B", "#EF4444", "#64748B"][j % 6] }} />
                  {d.label} · {formatValue(d.value, v.format)}
                </span>
              ))}
            </div>
          </div>
        </div>
      );
    }
    if (v.type === "area") {
      const groups = v.dimension ? aggBy(v.dimension, dax) : null;
      const spark = groups ? null : sparkline(dax);
      const chart = {
        type: "area" as const,
        categories: groups ? groups.map((d) => d.label) : (spark ?? []).map((_, j) => String(j + 1)),
        series: [{ name: v.title, data: groups ? groups.map((d) => d.value) : (spark ?? []) }],
      };
      return (
        <div key={i} className="bi-card" data-testid={"bi-area-" + i}>
          <div className="bi-card-title">{v.title}</div>
          <div className="bi-chart" dangerouslySetInnerHTML={{ __html: chartSvg(chart, { width: 560, height: 260, theme: "dark" }) }} />
        </div>
      );
    }
    // table visual: sortable drill-down
    const cols = v.columns?.length ? v.columns : spec.dataset.columns.map((c) => c.name);
    const sorted = sortCol
      ? [...rows].sort((a, b) => {
          const ci = spec.dataset.columns.findIndex((c) => c.name === sortCol);
          const av = a[ci], bv = b[ci];
          const an = Number(av), bn = Number(bv);
          const cmp = isFinite(an) && isFinite(bn) ? an - bn : String(av).localeCompare(String(bv));
          return cmp * sortDir;
        })
      : rows;
    return (
      <div key={i} className="bi-card bi-card--wide" data-testid={"bi-table-" + i}>
        <div className="bi-card-title">{v.title}</div>
        <div className="bi-table-wrap">
          <table className="bi-table">
            <thead>
              <tr>
                {cols.map((cName) => (
                  <th key={cName}>
                    <button
                      type="button"
                      onClick={() => { setSortCol(cName); setSortDir(sortCol === cName ? (sortDir === 1 ? -1 : 1) : 1); }}
                      aria-label={`Sort by ${cName}`}
                    >
                      {cName}{sortCol === cName ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 50).map((r, ri) => (
                <tr key={ri}>
                  {cols.map((cName) => {
                    const ci = spec.dataset.columns.findIndex((c) => c.name === cName);
                    const col = spec.dataset.columns[ci];
                    return <td key={cName}>{col?.type === "number" ? formatValue(Number(r[ci] ?? 0), v.format) : String(r[ci] ?? "")}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <DocumentCard badge="POWER BI" filename={filename} endpoint="/api/documents/powerbi" spec={spec} testId="powerbi-block">
      <div className="bi-report" data-testid="bi-preview">
        <div className="bi-slicers">
          {spec.slicers.map((s, i) => {
            if (s.type === "date-range") {
              return (
                <div key={i} className="bi-slicer" data-testid={"bi-slicer-date-" + i}>
                  <div className="bi-slicer-title">{s.field}</div>
                  <input
                    type="date" aria-label={s.field + " from"}
                    value={dateRange?.min ?? ""}
                    onChange={(e) => setDateRange((d) => ({ min: e.target.value, max: d?.max ?? "" }))}
                  />
                  <input
                    type="date" aria-label={s.field + " to"}
                    value={dateRange?.max ?? ""}
                    onChange={(e) => setDateRange((d) => ({ min: d?.min ?? "", max: e.target.value }))}
                  />
                </div>
              );
            }
            const ci = spec.dataset.columns.findIndex((c) => c.name === s.field);
            const values = [...new Set(spec.dataset.rows.map((r) => String(r[ci] ?? "")))].sort();
            const sel = slices[s.field] ?? new Set<string>();
            return (
              <div key={i} className="bi-slicer" data-testid={"bi-slicer-" + i}>
                <div className="bi-slicer-title">{s.field}</div>
                <div className="bi-chips">
                  {values.map((val) => (
                    <button
                      key={val}
                      type="button"
                      className={"bi-chip" + (sel.has(val) ? " bi-chip--on" : "")}
                      aria-pressed={sel.has(val)}
                      onClick={() => toggleSlice(s.field, val)}
                    >
                      {val}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {cross && (
            <button type="button" className="bi-chip bi-chip--cross" onClick={() => setCross(null)} aria-label="Clear cross-filter">
              {cross.dim}: {cross.value} ✕
            </button>
          )}
        </div>
        <div className="bi-grid">{spec.visuals.map(renderVisual)}</div>
      </div>
    </DocumentCard>
  );
}
