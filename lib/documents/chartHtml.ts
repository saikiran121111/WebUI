/**
 * Deterministic inline-SVG chart generator shared by the DOCX/PPTX engines
 * (screenshotted at 2x for embedding) and the client preview viewers.
 * No external libs — offline-safe, crisp at any DPI.
 */

export interface ChartSeries { name: string; data: number[] }
export interface ChartSpec {
  type: "bar" | "line" | "area" | "pie" | "donut" | "waterfall";
  title?: string;
  categories: string[];
  series: ChartSeries[];
}

export type ChartTheme = "light" | "dark";

const PALETTE = ["#38E8FF", "#22C55E", "#A78BFA", "#F59E0B", "#EF4444", "#64748B"];

function themeColors(theme: ChartTheme) {
  return theme === "dark"
    ? { bg: "#0D0D0D", grid: "#262626", text: "#A1A1AA", strong: "#FFFFFF" }
    : { bg: "#FFFFFF", grid: "#E5E7EB", text: "#6B7280", strong: "#111827" };
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const step = [1, 2, 2.5, 5, 10].find((s) => v / pow <= s) ?? 10;
  return step * pow;
}

/** Render a chart as an SVG string sized width×height (px, viewBox units). */
export function chartSvg(spec: ChartSpec, opts: { width?: number; height?: number; theme?: ChartTheme } = {}): string {
  const width = opts.width ?? 640;
  const height = opts.height ?? 360;
  const theme = themeColors(opts.theme ?? "light");
  const cats = spec.categories ?? [];
  const series = (spec.series ?? []).filter((s) => Array.isArray(s.data));
  const title = spec.title ? `<text x="${width / 2}" y="24" text-anchor="middle" font-size="15" font-weight="700" fill="${theme.strong}">${esc(spec.title)}</text>` : "";
  const top = spec.title ? 40 : 16;
  const left = 52;
  const right = width - 16;
  const bottom = height - 34;
  const plotW = right - left;
  const plotH = bottom - top;

  if (spec.type === "pie" || spec.type === "donut") {
    const data = series[0]?.data ?? [];
    const total = data.reduce((s, v) => s + Math.abs(v || 0), 0) || 1;
    const cx = width / 2, cy = top + plotH / 2;
    const r = Math.min(plotW, plotH) / 2 - 8;
    const inner = spec.type === "donut" ? r * 0.58 : 0;
    let angle = -Math.PI / 2;
    const slices = data.map((v, i) => {
      const frac = Math.abs(v || 0) / total;
      const a0 = angle, a1 = angle + frac * Math.PI * 2;
      angle = a1;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const color = PALETTE[i % PALETTE.length];
      if (inner > 0) {
        const ix0 = cx + inner * Math.cos(a1), iy0 = cy + inner * Math.sin(a1);
        const ix1 = cx + inner * Math.cos(a0), iy1 = cy + inner * Math.sin(a0);
        return `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${ix0.toFixed(1)},${iy0.toFixed(1)} A${inner},${inner} 0 ${large} 0 ${ix1.toFixed(1)},${iy1.toFixed(1)} Z" fill="${color}" stroke="${theme.bg}" stroke-width="1.5"/>`;
      }
      return `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${color}" stroke="${theme.bg}" stroke-width="1.5"/>`;
    });
    const legend = cats.map((c, i) => {
      const lx = 16 + (i % 3) * (width / 3);
      const ly = height - 22 + Math.floor(i / 3) * 0; // single row legend
      return `<rect x="${lx}" y="${ly - 9}" width="9" height="9" rx="2" fill="${PALETTE[i % PALETTE.length]}"/><text x="${lx + 13}" y="${ly}" font-size="10" fill="${theme.text}">${esc(c)} ${fmtNum(data[i] ?? 0)}</text>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${theme.bg}"/>${title}${slices.join("")}${legend}</svg>`;
  }

  // Cartesian types: bar / line / area / waterfall
  const isWaterfall = spec.type === "waterfall";
  const values = series.flatMap((s) => s.data.map((v) => v || 0));
  let min = Math.min(0, ...values);
  let max = Math.max(...values, 0);
  if (isWaterfall) {
    // running totals define the vertical extent
    let run = 0;
    let lo = 0, hi = 0;
    for (const v of series[0]?.data ?? []) {
      const from = run; run += v || 0;
      lo = Math.min(lo, from, run); hi = Math.max(hi, from, run);
    }
    min = lo; max = hi;
  }
  max = niceMax(Math.abs(max)) * Math.sign(max || 1);
  min = min < 0 ? -niceMax(Math.abs(min)) : 0;
  const span = max - min || 1;
  const y = (v: number) => bottom - ((v - min) / span) * plotH;

  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = min + (span * i) / ticks;
    const gy = y(v);
    return `<line x1="${left}" y1="${gy.toFixed(1)}" x2="${right}" y2="${gy.toFixed(1)}" stroke="${theme.grid}" stroke-width="1"/>` +
      `<text x="${left - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="${theme.text}">${fmtNum(v)}</text>`;
  }).join("");

  const n = Math.max(cats.length, 1);
  const slot = plotW / n;
  const xCenter = (i: number) => left + slot * (i + 0.5);

  let body = "";
  if (isWaterfall) {
    let run = 0;
    const data = series[0]?.data ?? [];
    body = data.map((v, i) => {
      const from = run; run += v || 0;
      const y0 = y(Math.max(from, run)), y1 = y(Math.min(from, run));
      const color = i === data.length - 1 ? "#38E8FF" : (v >= 0 ? "#22C55E" : "#EF4444");
      const bx = left + slot * i + slot * 0.22;
      return `<rect x="${bx.toFixed(1)}" y="${y0.toFixed(1)}" width="${(slot * 0.56).toFixed(1)}" height="${Math.max(1, y1 - y0).toFixed(1)}" fill="${color}" rx="2"/>` +
        `<line x1="${(bx + slot * 0.56).toFixed(1)}" y1="${y(run).toFixed(1)}" x2="${(left + slot * (i + 1)).toFixed(1)}" y2="${y(run).toFixed(1)}" stroke="${theme.grid}" stroke-dasharray="3 3"/>`;
    }).join("");
  } else if (spec.type === "bar") {
    const m = Math.max(series.length, 1);
    const barW = (slot * 0.7) / m;
    body = series.flatMap((s, si) => s.data.map((v, i) => {
      const vy = y(Math.max(0, v || 0)), v0 = y(Math.min(0, v || 0));
      const bx = left + slot * i + slot * 0.15 + barW * si;
      return `<rect x="${bx.toFixed(1)}" y="${vy.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, Math.abs(v0 - vy)).toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}" rx="2"/>`;
    })).join("");
  } else {
    body = series.map((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      const pts = s.data.map((v, i) => `${xCenter(i).toFixed(1)},${y(v || 0).toFixed(1)}`).join(" ");
      const line = `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`;
      const area = spec.type === "area"
        ? `<polygon points="${left},${y(Math.max(0, min))} ${pts} ${right - 0},${y(Math.max(0, min))}" fill="${color}" opacity="0.18"/>`
        : "";
      const dots = s.data.map((v, i) => `<circle cx="${xCenter(i).toFixed(1)}" cy="${y(v || 0).toFixed(1)}" r="3" fill="${color}"/>`).join("");
      return area + line + dots;
    }).join("");
  }

  const labels = cats.map((c, i) => {
    const short = String(c).length > 12 ? String(c).slice(0, 11) + "…" : String(c);
    return `<text x="${xCenter(i).toFixed(1)}" y="${bottom + 14}" text-anchor="middle" font-size="9" fill="${theme.text}">${esc(short)}</text>`;
  }).join("");

  const legend = series.length > 1
    ? series.map((s, si) => `<rect x="${left + si * 90}" y="${height - 14}" width="9" height="9" rx="2" fill="${PALETTE[si % PALETTE.length]}"/><text x="${left + si * 90 + 13}" y="${height - 6}" font-size="9" fill="${theme.text}">${esc(s.name)}</text>`).join("")
    : "";

  const zero = min < 0 ? `<line x1="${left}" y1="${y(0).toFixed(1)}" x2="${right}" y2="${y(0).toFixed(1)}" stroke="${theme.text}" stroke-width="1"/>` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${theme.bg}"/>${title}${grid}${zero}${body}${labels}${legend}</svg>`;
}

/** Self-contained HTML page hosting one chart (for 2x screenshot embedding). */
export function chartHtmlDocument(spec: ChartSpec, opts: { width?: number; height?: number; theme?: ChartTheme } = {}): string {
  const w = opts.width ?? 640;
  const h = opts.height ?? 360;
  return `<!doctype html>\n<html><head><meta charset="utf-8"/><style>html,body{margin:0;padding:0;background:${opts.theme === "dark" ? "#0D0D0D" : "#FFFFFF"}}</style></head><body><div id="chart-root" style="width:${w}px;height:${h}px">${chartSvg(spec, opts)}</div></body></html>`;
}
