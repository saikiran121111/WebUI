"use client";
import { memo, useMemo, useState } from "react";
import { Table2, BarChart3 } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { parseJsonFence, chartSpecSchema, type ChartSpec } from "../../lib/render/schemas";

const SERIES_COLORS = ["#6ea8e0", "#94c67a", "#d9a05f", "#b8a1e3", "#58c0c8", "#e0a3a3", "#7fb2e5", "#9db4d0"];
const PLOT = { left: 52, right: 16, top: 14, bottom: 44, width: 640, height: 360 };

interface ChartBlockProps {
  source: string;
  streaming?: boolean;
}

/**
 * Renders ```chart fences (validated JSON, never invented data) as themed
 * SVG charts with tooltips, legend, and a "view data" table so every mark
 * is traceable back to its underlying values. Invalid specs fall back to
 * the raw source instead of guessing.
 */
export default memo(function ChartBlock({ source, streaming = false }: ChartBlockProps) {
  const parsed = useMemo(() => parseJsonFence(source, chartSpecSchema), [source]);

  if (!parsed.ok) {
    if (streaming) return null; // partial JSON mid-stream: render nothing yet
    return (
      <div className="chart-block" data-testid="chart-error">
        <div className="diagram-error-note">Chart data did not validate — showing the source instead.</div>
        <CodeBlock code={source} lang="json" />
      </div>
    );
  }
  return <ChartView spec={parsed.value} />;
});

function formatNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return trimZero(n / 1_000_000) + "M";
  if (abs >= 10_000) return trimZero(n / 1000) + "k";
  return trimZero(n);
}
function trimZero(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function niceScale(min: number, max: number, tickCount = 5) {
  if (min === max) { max = min + 1; if (min > 0) min = 0; }
  const span = max - min;
  const base = Math.pow(10, Math.floor(Math.log10(span / tickCount)));
  const err = span / tickCount / base;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const step = base * mult;
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step };
}

function ChartView({ spec }: { spec: ChartSpec }) {
  const [showData, setShowData] = useState(false);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  const series = spec.series ?? [];
  const categories = spec.categories ?? [];
  const isPie = spec.type === "pie" || spec.type === "donut";
  const isScatter = spec.type === "scatter";

  const summary = `${spec.title ?? spec.type} chart, ${
    isScatter ? `${spec.points?.length ?? 0} points` : `${categories.length} categories, ${series.length} series`
  }`;

  return (
    <div className="chart-block" data-testid="chart-block" data-chart-type={spec.type}>
      <div className="code-block-header">
        <span className="code-block-lang">{spec.title ?? "Chart"}</span>
        <div className="code-block-controls">
          <button className={"code-block-ctl" + (showData ? " is-active" : "")}
            onClick={() => setShowData(v => !v)} aria-pressed={showData}
            aria-label={showData ? "Hide underlying data" : "View underlying data"} title="View data">
            {showData ? <BarChart3 className="w-3.5 h-3.5" /> : <Table2 className="w-3.5 h-3.5" />}
            <span className="text-xs">Data</span>
          </button>
        </div>
      </div>
      <div className="chart-stage">
        <svg viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} role="img" aria-label={summary}
          className="chart-svg" preserveAspectRatio="xMidYMid meet">
          {isPie
            ? <PieMarks spec={spec} onTip={setTooltip} />
            : isScatter
              ? <ScatterMarks spec={spec} onTip={setTooltip} />
              : <AxisMarks spec={spec} onTip={setTooltip} />}
        </svg>
        {tooltip && (
          <div className="chart-tooltip" style={{ left: `${(tooltip.x / PLOT.width) * 100}%`, top: `${(tooltip.y / PLOT.height) * 100}%` }}>
            {tooltip.text}
          </div>
        )}
        {!isPie && !isScatter && series.some(s => s.name) && (
          <div className="chart-legend" aria-hidden="true">
            {series.map((s, i) => (
              <span key={s.name} className="chart-legend-item">
                <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />{s.name}
              </span>
            ))}
          </div>
        )}
      </div>
      {showData && <DataTable spec={spec} />}
    </div>
  );
}

function DataTable({ spec }: { spec: ChartSpec }) {
  const unit = spec.unit ? ` (${spec.unit})` : "";
  if (spec.type === "scatter") {
    return (
      <div className="md-table-wrap">
        <table className="md-table chart-data-table">
          <thead><tr><th>x</th><th>y{unit}</th></tr></thead>
          <tbody>
            {(spec.points ?? []).map((p, i) => (
              <tr key={i}><td>{String(p.x)}</td><td className="num">{trimZero(p.y)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="md-table-wrap">
      <table className="md-table chart-data-table">
        <thead>
          <tr>
            <th>{spec.xLabel ?? ""}</th>
            {(spec.series ?? []).map(s => <th key={s.name}>{s.name}{unit}</th>)}
          </tr>
        </thead>
        <tbody>
          {(spec.categories ?? []).map((cat, ci) => (
            <tr key={ci}>
              <td>{cat}</td>
              {(spec.series ?? []).map(s => <td key={s.name} className="num">{trimZero(s.data[ci] ?? 0)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type TipHandler = (t: { x: number; y: number; text: string } | null) => void;

function AxisMarks({ spec, onTip }: { spec: ChartSpec; onTip: TipHandler }) {
  const series = spec.series ?? [];
  const categories = spec.categories ?? [];
  const stacked = spec.type === "stacked-bar";
  const values = series.flatMap(s => s.data);
  const totals = stacked
    ? categories.map((_, ci) => series.reduce((sum, s) => sum + (s.data[ci] ?? 0), 0))
    : values;
  const scale = niceScale(Math.min(0, ...totals), Math.max(...totals));
  const plotW = PLOT.width - PLOT.left - PLOT.right;
  const plotH = PLOT.height - PLOT.top - PLOT.bottom;
  const y = (v: number) => PLOT.top + plotH - ((v - scale.lo) / (scale.hi - scale.lo)) * plotH;
  const band = plotW / Math.max(categories.length, 1);
  const unit = spec.unit ? ` ${spec.unit}` : "";

  const ticks: number[] = [];
  for (let v = scale.lo; v <= scale.hi + scale.step / 2; v += scale.step) ticks.push(v);

  return (
    <g>
      {ticks.map(v => (
        <g key={v}>
          <line x1={PLOT.left} x2={PLOT.width - PLOT.right} y1={y(v)} y2={y(v)} className="chart-grid" />
          <text x={PLOT.left - 8} y={y(v) + 4} textAnchor="end" className="chart-tick">{formatNumber(v)}</text>
        </g>
      ))}
      {categories.map((cat, ci) => (
        <text key={ci} x={PLOT.left + band * (ci + 0.5)} y={PLOT.height - PLOT.bottom + 18}
          textAnchor="middle" className="chart-tick chart-xlabel">
          {cat.length > 12 ? cat.slice(0, 11) + "…" : cat}
        </text>
      ))}
      {spec.yLabel && (
        <text x={14} y={PLOT.top + plotH / 2} className="chart-axis-label"
          transform={`rotate(-90 14 ${PLOT.top + plotH / 2})`} textAnchor="middle">{spec.yLabel}</text>
      )}

      {spec.type === "bar" || spec.type === "grouped-bar" || spec.type === "stacked-bar" || spec.type === "histogram"
        ? <BarMarks spec={spec} y={y} band={band} stacked={stacked} onTip={onTip} unit={unit} />
        : <LineMarks spec={spec} y={y} band={band} area={spec.type === "area"} onTip={onTip} unit={unit} />}
    </g>
  );
}

function BarMarks({ spec, y, band, stacked, onTip, unit }: {
  spec: ChartSpec; y: (v: number) => number; band: number; stacked: boolean; onTip: TipHandler; unit: string;
}) {
  const series = spec.series ?? [];
  const categories = spec.categories ?? [];
  const gap = spec.type === "histogram" ? 0.08 : 0.25;
  const groupW = band * (1 - gap);
  const barW = stacked || spec.type === "histogram" ? groupW : groupW / series.length;
  const zeroY = y(0);
  return (
    <g>
      {categories.map((cat, ci) => {
        const groupX = PLOT.left + band * ci + (band - groupW) / 2;
        let stackTop = zeroY;
        return series.map((s, si) => {
          const v = s.data[ci] ?? 0;
          const color = SERIES_COLORS[si % SERIES_COLORS.length];
          let x = groupX + barW * si;
          let top: number;
          let height: number;
          if (stacked) {
            const next = stackTop - (zeroY - y(v));
            top = Math.min(stackTop, next);
            height = Math.abs(zeroY - y(v));
            stackTop = next;
            x = groupX;
          } else {
            top = Math.min(y(v), zeroY);
            height = Math.abs(zeroY - y(v));
          }
          return (
            <rect key={si} x={x} y={top} width={Math.max(barW - 1, 1)} height={Math.max(height, 0)}
              fill={color} fillOpacity={0.85} rx={2}
              onMouseEnter={() => onTip({ x: x + barW / 2, y: top, text: `${cat} · ${s.name}: ${trimZero(v)}${unit}` })}
              onMouseLeave={() => onTip(null)} />
          );
        });
      })}
    </g>
  );
}

function LineMarks({ spec, y, band, area, onTip, unit }: {
  spec: ChartSpec; y: (v: number) => number; band: number; area: boolean; onTip: TipHandler; unit: string;
}) {
  const series = spec.series ?? [];
  const categories = spec.categories ?? [];
  const px = (ci: number) => PLOT.left + band * (ci + 0.5);
  return (
    <g>
      {series.map((s, si) => {
        const color = SERIES_COLORS[si % SERIES_COLORS.length];
        const pts = s.data.map((v, ci) => `${px(ci)},${y(v)}`).join(" ");
        return (
          <g key={s.name}>
            {area && (
              <polygon
                points={`${PLOT.left + band * 0.5},${y(Math.min(0, ...s.data))} ${pts} ${px(s.data.length - 1)},${y(Math.min(0, ...s.data))}`}
                fill={color} fillOpacity={0.12} stroke="none" />
            )}
            <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75}
              strokeLinejoin="round" strokeLinecap="round" />
            {s.data.map((v, ci) => (
              <circle key={ci} cx={px(ci)} cy={y(v)} r={3.5} fill="transparent"
                onMouseEnter={() => onTip({ x: px(ci), y: y(v), text: `${categories[ci] ?? ci} · ${s.name}: ${trimZero(v)}${unit}` })}
                onMouseLeave={() => onTip(null)} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

function ScatterMarks({ spec, onTip }: { spec: ChartSpec; onTip: TipHandler }) {
  const points = spec.points ?? [];
  const xs = points.map(p => (typeof p.x === "number" ? p.x : NaN));
  const numericX = xs.every(v => !Number.isNaN(v));
  const xScale = numericX
    ? niceScale(Math.min(...(xs as number[])), Math.max(...(xs as number[])))
    : { lo: 0, hi: Math.max(points.length - 1, 1), step: 1 };
  const ys = points.map(p => p.y);
  const yScale = niceScale(Math.min(...ys), Math.max(...ys));
  const plotW = PLOT.width - PLOT.left - PLOT.right;
  const plotH = PLOT.height - PLOT.top - PLOT.bottom;
  const x = (v: number) => PLOT.left + ((v - xScale.lo) / (xScale.hi - xScale.lo)) * plotW;
  const y = (v: number) => PLOT.top + plotH - ((v - yScale.lo) / (yScale.hi - yScale.lo)) * plotH;
  const unit = spec.unit ? ` ${spec.unit}` : "";
  const ticks: number[] = [];
  for (let v = yScale.lo; v <= yScale.hi + yScale.step / 2; v += yScale.step) ticks.push(v);
  return (
    <g>
      {ticks.map(v => (
        <g key={v}>
          <line x1={PLOT.left} x2={PLOT.width - PLOT.right} y1={y(v)} y2={y(v)} className="chart-grid" />
          <text x={PLOT.left - 8} y={y(v) + 4} textAnchor="end" className="chart-tick">{formatNumber(v)}</text>
        </g>
      ))}
      {points.map((p, i) => {
        const cx = numericX ? x(p.x as number) : x(i);
        return (
          <circle key={i} cx={cx} cy={y(p.y)} r={4} fill="#6ea8e0" fillOpacity={0.75}
            onMouseEnter={() => onTip({ x: cx, y: y(p.y), text: `${p.label ?? `(${String(p.x)}, ${trimZero(p.y)})`}${unit}` })}
            onMouseLeave={() => onTip(null)} />
        );
      })}
    </g>
  );
}

function PieMarks({ spec, onTip }: { spec: ChartSpec; onTip: TipHandler }) {
  const values = (spec.series?.[0]?.data ?? []).map(v => Math.max(v, 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = PLOT.width / 2;
  const cy = (PLOT.top + PLOT.height - PLOT.bottom) / 2;
  const r = Math.min(PLOT.width, PLOT.height - PLOT.top - PLOT.bottom) / 2 - 12;
  const inner = spec.type === "donut" ? r * 0.55 : 0;
  const unit = spec.unit ? ` ${spec.unit}` : "";
  let angle = -Math.PI / 2;
  return (
    <g>
      {values.map((v, i) => {
        const sweep = (v / total) * Math.PI * 2;
        const path = arcPath(cx, cy, r, inner, angle, angle + sweep);
        angle += sweep;
        const cat = spec.categories?.[i] ?? `#${i + 1}`;
        const mid = angle - sweep / 2;
        return (
          <g key={i}>
            <path d={path} fill={SERIES_COLORS[i % SERIES_COLORS.length]} fillOpacity={0.85}
              stroke="#0a0a0c" strokeWidth={1}
              onMouseEnter={() => onTip({ x: cx + Math.cos(mid) * r * 0.7, y: cy + Math.sin(mid) * r * 0.7, text: `${cat}: ${trimZero(v)}${unit} (${trimZero((v / total) * 100)}%)` })}
              onMouseLeave={() => onTip(null)} />
            {sweep > 0.35 && (
              <text x={cx + Math.cos(mid) * (r + 10)} y={cy + Math.sin(mid) * (r + 10)}
                className="chart-tick" textAnchor="middle">{cat.length > 10 ? cat.slice(0, 9) + "…" : cat}</text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function arcPath(cx: number, cy: number, r: number, inner: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r;
  const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
  if (inner <= 0) return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
  const ix0 = cx + Math.cos(a1) * inner, iy0 = cy + Math.sin(a1) * inner;
  const ix1 = cx + Math.cos(a0) * inner, iy1 = cy + Math.sin(a0) * inner;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${ix0} ${iy0} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`;
}
