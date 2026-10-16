"use client";
import { memo, useMemo, useState } from "react";
import { Table2, BarChart3, MessageSquarePlus } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { parseJsonFence, chartSpecSchema, type ChartSpec } from "../../lib/render/schemas";
import { OBSIDIAN_SERIES_COLORS } from "../../lib/render/themes";
import { useTweenedNumbers } from "../../hooks/useTweenedNumbers";

const PLOT = { left: 52, right: 16, top: 14, bottom: 44, width: 640, height: 360 };

const SWITCH_TYPES: { type: ChartSpec["type"]; label: string }[] = [
  { type: "bar", label: "Bar" },
  { type: "line", label: "Line" },
  { type: "area", label: "Area" },
  { type: "pie", label: "Pie" },
  { type: "donut", label: "Donut" },
];

interface ChartBlockProps {
  source: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
}

interface SelectedDatum {
  category: string;
  series: string;
  value: number;
  pct: number | null;
  note?: string;
}

/**
 * Renders ```chart fences (validated JSON, never invented data) as themed
 * interactive SVG charts: a type switcher re-renders the same dataset as
 * Bar/Line/Area/Pie/Donut/Table, legend pills toggle series and rescale the
 * axes, What-If sliders recalculate series live, and clicking any bar,
 * point or slice opens a synced explainer with exact metrics and an
 * "Ask AI about this" hand-off. Invalid specs fall back to the raw source.
 */
export default memo(function ChartBlock({ source, streaming = false, onSend }: ChartBlockProps) {
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
  return <ChartView spec={parsed.value} onSend={onSend} />;
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

/** What-If sliders: multiply/add the targeted series' values. */
function applySliders(spec: ChartSpec, values: Record<string, number>): ChartSpec {
  const sliders = spec.sliders ?? [];
  if (!sliders.length || !spec.series) return spec;
  const series = spec.series.map(s => {
    let data = s.data;
    for (const sl of sliders) {
      if (sl.targetSeries && sl.targetSeries !== s.name) continue;
      const v = Number.isFinite(values[sl.id]) ? values[sl.id]! : sl.defaultValue;
      const op = sl.operation ?? "multiply";
      data = data.map(x => {
        const r = op === "multiply" ? x * v : x + v;
        return Number.isFinite(r) ? r : x;
      });
    }
    return { ...s, data };
  });
  return { ...spec, series };
}

function ChartView({ spec, onSend }: { spec: ChartSpec; onSend?: (text: string) => void }) {
  const [showData, setShowData] = useState(false);
  const [activeType, setActiveType] = useState<ChartSpec["type"]>(spec.type);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [sliderValues, setSliderValues] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<SelectedDatum | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  // scatter/histogram data shapes don't survive a type switch — no switcher.
  const switchable = spec.type !== "scatter" && spec.type !== "histogram";
  const type = switchable ? activeType : spec.type;

  const tuned = useMemo(() => applySliders(spec, sliderValues), [spec, sliderValues]);
  const visibleSeries = (tuned.series ?? []).filter(s => !hidden.has(s.name));
  const viewSpec: ChartSpec = { ...tuned, type, series: visibleSeries };

  const isPie = type === "pie" || type === "donut";
  const isScatter = type === "scatter";
  const allSeries = spec.series ?? [];
  const categories = spec.categories ?? [];

  const summary = `${spec.title ?? spec.type} chart, ${
    isScatter ? `${spec.points?.length ?? 0} points` : `${categories.length} categories, ${visibleSeries.length} series`
  }`;

  const toggleSeries = (name: string) => {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setSelected(null);
  };

  const unit = spec.unit ? ` ${spec.unit}` : "";
  const askPrompt = selected
    ? `In the chart "${spec.title ?? "untitled"}": ${selected.category}` +
      `${selected.series ? ` — ${selected.series}` : ""} = ${trimZero(selected.value)}${unit}` +
      `${selected.pct != null ? ` (${trimZero(selected.pct)}% of total)` : ""}.` +
      `${selected.note ? ` Note: ${selected.note}.` : ""} What does this data point tell us?`
    : "";

  const explainerText = spec.insight ?? spec.subtitle ?? null;

  return (
    <div className="chart-block" data-testid="chart-block" data-chart-type={type}>
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

      {switchable && (
        <div className="chart-switcher" role="radiogroup" aria-label="Chart type" data-testid="chart-switcher">
          {SWITCH_TYPES.map(t => (
            <button key={t.type} type="button" role="radio" aria-checked={type === t.type && !showData}
              className={"chart-switch-pill" + (type === t.type && !showData ? " is-active" : "")}
              onClick={() => { setActiveType(t.type); setShowData(false); setSelected(null); }}>
              {t.label}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={showData}
            className={"chart-switch-pill" + (showData ? " is-active" : "")}
            onClick={() => { setShowData(true); setSelected(null); }}>
            Table
          </button>
        </div>
      )}

      {!showData && (
        <div className="chart-stage">
          <svg viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} role="img" aria-label={summary}
            className="chart-svg" preserveAspectRatio="xMidYMid meet">
            <g key={type} className="chart-marks-enter">
              {isPie
                ? <PieMarks spec={viewSpec} onTip={setTooltip} onSelect={setSelected} />
                : isScatter
                  ? <ScatterMarks spec={viewSpec} onTip={setTooltip} onSelect={setSelected} />
                  : <AxisMarks spec={viewSpec} onTip={setTooltip} onSelect={setSelected} />}
            </g>
          </svg>
          {tooltip && (
            <div className="chart-tooltip" style={{ left: `${(tooltip.x / PLOT.width) * 100}%`, top: `${(tooltip.y / PLOT.height) * 100}%` }}>
              {tooltip.text}
            </div>
          )}
          {!isScatter && allSeries.some(s => s.name) && (
            <div className="chart-legend">
              {allSeries.map((s, i) => (
                <button key={s.name} type="button" role="switch" aria-checked={!hidden.has(s.name)}
                  className="chart-legend-switch" title={`Toggle series ${s.name}`}
                  onClick={() => toggleSeries(s.name)}>
                  <i className="chart-legend-swatch" style={{ background: OBSIDIAN_SERIES_COLORS[i % OBSIDIAN_SERIES_COLORS.length] }} />
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {spec.sliders && spec.sliders.length > 0 && (
        <div className="chart-sliders" data-testid="chart-sliders">
          {spec.sliders.map(sl => {
            const v = Number.isFinite(sliderValues[sl.id]) ? sliderValues[sl.id]! : sl.defaultValue;
            return (
              <label key={sl.id} className="chart-slider-row">
                <span className="chart-slider-label">{sl.label}</span>
                <input type="range" min={sl.min} max={sl.max} step={sl.step} value={v}
                  data-testid={`chart-slider-${sl.id}`} aria-label={sl.label}
                  onChange={e => setSliderValues(prev => ({ ...prev, [sl.id]: Number(e.target.value) }))} />
                <span className="chart-slider-value">{trimZero(v)}</span>
              </label>
            );
          })}
        </div>
      )}

      {(selected || explainerText) && (
        <div className="chart-explainer" data-testid="chart-explainer" aria-live="polite">
          {selected ? (
            <>
              <span className="chart-explainer-metrics">
                {selected.category}
                {selected.series ? ` · ${selected.series}` : ""}: {trimZero(selected.value)}{unit}
                {selected.pct != null ? ` · ${trimZero(selected.pct)}% of total` : ""}
              </span>
              {selected.note && <span className="chart-explainer-note">{selected.note}</span>}
              {onSend && (
                <button type="button" className="viz-ask-btn" onClick={() => onSend(askPrompt)}>
                  <MessageSquarePlus className="w-3 h-3" /> Ask AI about this
                </button>
              )}
            </>
          ) : (
            <span>{explainerText}</span>
          )}
        </div>
      )}

      {showData && <DataTable spec={tuned} />}
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
type SelectHandler = (d: SelectedDatum) => void;

function AxisMarks({ spec, onTip, onSelect }: { spec: ChartSpec; onTip: TipHandler; onSelect: SelectHandler }) {
  const series = spec.series ?? [];
  const categories = spec.categories ?? [];
  const stacked = spec.type === "stacked-bar";
  const values = series.flatMap(s => s.data);

  // rAF-tweened geometry: series values and the axis scale ease toward their
  // targets, so slider drags, legend toggles and rescales glide at native
  // refresh rate instead of snapping.
  const displayValues = useTweenedNumbers(values);
  let cursor = 0;
  const displaySeries = series.map(s => {
    const data = displayValues.slice(cursor, cursor + s.data.length);
    cursor += s.data.length;
    return { ...s, data };
  });

  const totals = stacked
    ? categories.map((_, ci) => series.reduce((sum, s) => sum + (s.data[ci] ?? 0), 0))
    : values;
  const scale = values.length
    ? niceScale(Math.min(0, ...totals), Math.max(...totals))
    : { lo: 0, hi: 1, step: 1 };
  const [lo, hi] = useTweenedNumbers([scale.lo, scale.hi]);

  if (values.length === 0) return null; // every series hidden — empty plot
  const plotW = PLOT.width - PLOT.left - PLOT.right;
  const plotH = PLOT.height - PLOT.top - PLOT.bottom;
  const y = (v: number) => PLOT.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const band = plotW / Math.max(categories.length, 1);
  const unit = spec.unit ? ` ${spec.unit}` : "";

  const ticks: number[] = [];
  for (let v = scale.lo; v <= scale.hi + scale.step / 2; v += scale.step) ticks.push(v);

  return (
    <g>
      {ticks.filter(v => v >= lo - 1e-9 && v <= hi + 1e-9).map(v => (
        <g key={v} className="chart-tick-in">
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
        ? <BarMarks spec={{ ...spec, series: displaySeries }} y={y} band={band} stacked={stacked} onTip={onTip} onSelect={onSelect} unit={unit} />
        : <LineMarks spec={{ ...spec, series: displaySeries }} y={y} band={band} area={spec.type === "area"} onTip={onTip} onSelect={onSelect} unit={unit} />}
    </g>
  );
}

function BarMarks({ spec, y, band, stacked, onTip, onSelect, unit }: {
  spec: ChartSpec; y: (v: number) => number; band: number; stacked: boolean;
  onTip: TipHandler; onSelect: SelectHandler; unit: string;
}) {
  const series = spec.series ?? [];
  const categories = spec.categories ?? [];
  const gap = spec.type === "histogram" ? 0.08 : 0.25;
  // rAF-tweened layout scalars (see AxisMarks): when a series is toggled the
  // remaining bars widen/slide smoothly instead of snapping to new widths.
  const [groupW, barW] = useTweenedNumbers([
    band * (1 - gap),
    (stacked || spec.type === "histogram") ? band * (1 - gap) : band * (1 - gap) / Math.max(series.length, 1),
  ]);
  const zeroY = y(0);
  return (
    <g>
      {categories.map((cat, ci) => {
        const groupX = PLOT.left + band * ci + (band - groupW) / 2;
        const catTotal = series.reduce((sum, s) => sum + Math.abs(s.data[ci] ?? 0), 0);
        let stackTop = zeroY;
        return series.map((s, si) => {
          const v = s.data[ci] ?? 0;
          const color = OBSIDIAN_SERIES_COLORS[si % OBSIDIAN_SERIES_COLORS.length];
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
          if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(x)) return null;
          const tipText = `${cat} · ${s.name}: ${trimZero(v)}${unit}`;
          return (
            <rect key={si} className="chart-mark" x={x} y={top} width={Math.max(barW - 1, 1)} height={Math.max(height, 0)}
              fill={color} fillOpacity={0.85} rx={2}
              onMouseEnter={() => onTip({ x: x + barW / 2, y: top, text: tipText })}
              onMouseLeave={() => onTip(null)}
              onClick={() => onSelect({
                category: cat, series: s.name, value: v,
                pct: catTotal > 0 ? (Math.abs(v) / catTotal) * 100 : null,
                note: spec.notes?.[ci],
              })} />
          );
        });
      })}
    </g>
  );
}

function LineMarks({ spec, y, band, area, onTip, onSelect, unit }: {
  spec: ChartSpec; y: (v: number) => number; band: number; area: boolean;
  onTip: TipHandler; onSelect: SelectHandler; unit: string;
}) {
  const series = spec.series ?? [];
  const categories = spec.categories ?? [];
  const px = (ci: number) => PLOT.left + band * (ci + 0.5);
  return (
    <g>
      {series.map((s, si) => {
        const color = OBSIDIAN_SERIES_COLORS[si % OBSIDIAN_SERIES_COLORS.length];
        const pts = s.data
          .map((v, ci) => ({ v, x: px(ci), y: y(v) }))
          .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
          .map(p => `${p.x},${p.y}`)
          .join(" ");
        if (!pts) return null;
        const catTotalAt = (ci: number) => series.reduce((sum, o) => sum + Math.abs(o.data[ci] ?? 0), 0);
        return (
          <g key={s.name}>
            {area && (
              <polygon
                points={`${PLOT.left + band * 0.5},${y(Math.min(0, ...s.data))} ${pts} ${px(s.data.length - 1)},${y(Math.min(0, ...s.data))}`}
                fill={color} fillOpacity={0.12} stroke="none" />
            )}
            <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75}
              strokeLinejoin="round" strokeLinecap="round" />
            {s.data.map((v, ci) => {
              const cy = y(v);
              if (!Number.isFinite(cy)) return null;
              return (
                <circle key={ci} className="chart-mark" cx={px(ci)} cy={cy} r={3.5} fill="transparent"
                  onMouseEnter={() => onTip({ x: px(ci), y: cy, text: `${categories[ci] ?? ci} · ${s.name}: ${trimZero(v)}${unit}` })}
                  onMouseLeave={() => onTip(null)}
                  onClick={() => {
                    const total = catTotalAt(ci);
                    onSelect({
                      category: categories[ci] ?? String(ci), series: s.name, value: v,
                      pct: total > 0 ? (Math.abs(v) / total) * 100 : null,
                      note: spec.notes?.[ci],
                    });
                  }} />
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

function ScatterMarks({ spec, onTip, onSelect }: { spec: ChartSpec; onTip: TipHandler; onSelect: SelectHandler }) {
  const points = spec.points ?? [];
  const xs = points.map(p => (typeof p.x === "number" ? p.x : NaN));
  const numericX = points.length > 0 && xs.every(v => !Number.isNaN(v));
  const ys = points.map(p => p.y);

  // rAF-tweened point coordinates and both axis scales (see AxisMarks).
  const displayFlat = useTweenedNumbers(numericX ? points.flatMap(p => [p.x as number, p.y]) : ys);
  const displayXs = numericX ? displayFlat.filter((_, i) => i % 2 === 0) : null;
  const displayYs = numericX ? displayFlat.filter((_, i) => i % 2 === 1) : displayFlat;

  const xScale = numericX
    ? niceScale(Math.min(...(xs as number[])), Math.max(...(xs as number[])))
    : { lo: 0, hi: Math.max(points.length - 1, 1), step: 1 };
  const yScale = points.length
    ? niceScale(Math.min(...ys), Math.max(...ys))
    : { lo: 0, hi: 1, step: 1 };
  const [xLo, xHi] = useTweenedNumbers([xScale.lo, xScale.hi]);
  const [yLo, yHi] = useTweenedNumbers([yScale.lo, yScale.hi]);

  if (points.length === 0) return null;
  const plotW = PLOT.width - PLOT.left - PLOT.right;
  const plotH = PLOT.height - PLOT.top - PLOT.bottom;
  const x = (v: number) => PLOT.left + ((v - xLo) / (xHi - xLo)) * plotW;
  const y = (v: number) => PLOT.top + plotH - ((v - yLo) / (yHi - yLo)) * plotH;
  const unit = spec.unit ? ` ${spec.unit}` : "";
  const ticks: number[] = [];
  for (let v = yScale.lo; v <= yScale.hi + yScale.step / 2; v += yScale.step) ticks.push(v);
  return (
    <g>
      {ticks.filter(v => v >= yLo - 1e-9 && v <= yHi + 1e-9).map(v => (
        <g key={v} className="chart-tick-in">
          <line x1={PLOT.left} x2={PLOT.width - PLOT.right} y1={y(v)} y2={y(v)} className="chart-grid" />
          <text x={PLOT.left - 8} y={y(v) + 4} textAnchor="end" className="chart-tick">{formatNumber(v)}</text>
        </g>
      ))}
      {points.map((p, i) => {
        const cx = displayXs ? x(displayXs[i]) : x(i);
        const cy = y(displayYs[i]);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
        const label = p.label ?? `(${String(p.x)}, ${trimZero(p.y)})`;
        return (
          <circle key={i} className="chart-mark" cx={cx} cy={cy} r={4} fill={OBSIDIAN_SERIES_COLORS[0]} fillOpacity={0.75}
            onMouseEnter={() => onTip({ x: cx, y: cy, text: `${label}${unit}` })}
            onMouseLeave={() => onTip(null)}
            onClick={() => onSelect({ category: label, series: "", value: p.y, pct: null })} />
        );
      })}
    </g>
  );
}

function PieMarks({ spec, onTip, onSelect }: { spec: ChartSpec; onTip: TipHandler; onSelect: SelectHandler }) {
  const values = (spec.series?.[0]?.data ?? []).map(v => Math.max(v, 0));
  // rAF-tweened slice values: sweeps and label positions rotate smoothly
  // toward the target shares (see AxisMarks).
  const displayValues = useTweenedNumbers(values);
  if (values.length === 0) return null;
  const displayTotal = displayValues.reduce((a, b) => a + b, 0) || 1;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = PLOT.width / 2;
  const cy = (PLOT.top + PLOT.height - PLOT.bottom) / 2;
  const r = Math.min(PLOT.width, PLOT.height - PLOT.top - PLOT.bottom) / 2 - 12;
  const inner = spec.type === "donut" ? r * 0.55 : 0;
  const unit = spec.unit ? ` ${spec.unit}` : "";
  let angle = -Math.PI / 2;
  return (
    <g>
      {displayValues.map((dv, i) => {
        const sweep = (dv / displayTotal) * Math.PI * 2;
        const path = arcPath(cx, cy, r, inner, angle, angle + sweep);
        angle += sweep;
        if (!path) return null;
        const cat = spec.categories?.[i] ?? `#${i + 1}`;
        const mid = angle - sweep / 2;
        const v = values[i];
        const pct = (v / total) * 100;
        return (
          <g key={i}>
            <path className="chart-mark" d={path} fill={OBSIDIAN_SERIES_COLORS[i % OBSIDIAN_SERIES_COLORS.length]} fillOpacity={0.85}
              stroke="#050507" strokeWidth={1}
              onMouseEnter={() => onTip({ x: cx + Math.cos(mid) * r * 0.7, y: cy + Math.sin(mid) * r * 0.7, text: `${cat}: ${trimZero(v)}${unit} (${trimZero(pct)}%)` })}
              onMouseLeave={() => onTip(null)}
              onClick={() => onSelect({ category: cat, series: spec.series?.[0]?.name ?? "", value: spec.series?.[0]?.data[i] ?? v, pct })} />
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

function arcPath(cx: number, cy: number, r: number, inner: number, a0: number, a1: number): string | null {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r;
  const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  if (inner <= 0) return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
  const ix0 = cx + Math.cos(a1) * inner, iy0 = cy + Math.sin(a1) * inner;
  const ix1 = cx + Math.cos(a0) * inner, iy1 = cy + Math.sin(a0) * inner;
  if (![ix0, iy0, ix1, iy1].every(Number.isFinite)) return null;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${ix0} ${iy0} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`;
}
