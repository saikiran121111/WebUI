"use client";
/**
 * ResultPrimitives.tsx — the §5 primitive kit every rich surface composes.
 * One file because these are small, pure, and shared by every domain
 * surface; §45 style law applies: neutral chrome via styles/web-results.css.
 */
import { memo, useMemo, useState } from "react";
import { itemsOf, num, safeUrl, str, itemProvenance, hostOf } from "./resultHelpers";
import { useRichResultCtx, type LightboxMedia } from "./richResultContext";

/* ── Card: the unit of every list / grid / carousel ───────────────────── */
export const ResultCard = memo(function ResultCard({
  title,
  lines,
  note,
  onClick,
  row,
  href,
  ariaLabel,
}: {
  title?: string;
  lines?: string[];
  note?: string;
  onClick?: () => void;
  row?: boolean;
  href?: string;
  ariaLabel?: string;
}) {
  const cls = `wr-card${onClick || href ? " wr-card--clickable" : ""}${row ? " wr-card--row" : ""}`;
  const inner = (
    <>
      {title && <span className="wr-card-title">{title}</span>}
      {lines?.map((l, i) => <span key={i} className="wr-card-line">{l}</span>)}
      {note && <span className="wr-card-note">{note}</span>}
    </>
  );
  if (href) {
    return (
      <a className={cls} href={href} target="_blank" rel="noopener noreferrer" aria-label={ariaLabel ?? title}>
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <div className={cls} role="button" tabIndex={0} aria-label={ariaLabel ?? title}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}>
        {inner}
      </div>
    );
  }
  return <div className={cls}>{inner}</div>;
});

/* ── Tables (§67 MarkdownTable untouched; this is the payload-driven one) ─ */
export const ResultTable = memo(function ResultTable({
  columns,
  rows,
  sortable,
  caption,
}: {
  columns: string[];
  rows: unknown[][];
  sortable?: boolean;
  caption?: string;
}) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const copy = rows.slice();
    copy.sort((a, b) => {
      const av = a[sort.col], bv = b[sort.col];
      const an = typeof av === "number" ? av : Number.NaN;
      const bn = typeof bv === "number" ? bv : Number.NaN;
      if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * sort.dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * sort.dir;
    });
    return copy;
  }, [rows, sort]);
  return (
    <div className="wr-table-wrap">
      <table className={`wr-table${sortable ? " wr-table--sortable" : ""}`}>
        {caption && <caption className="wr-card-note" style={{ textAlign: "left", padding: "4px 0" }}>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} scope="col" aria-sort={sort?.col === i ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                {sortable
                  ? <button type="button" onClick={() => setSort((s) => (s?.col === i ? { col: i, dir: s.dir === 1 ? -1 : 1 } : { col: i, dir: 1 }))}>{c}</button>
                  : c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, ri) => (
            <tr key={ri}>{r.map((cell, ci) => <td key={ci}>{String(cell ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/** payload {columns, rows} → sortable table; anything malformed → empty. */
export function InteractiveTable({ payload }: { payload: Record<string, unknown> }) {
  const columns = (Array.isArray(payload.columns) ? payload.columns : []).map((c) => str(c, 80) ?? "").filter(Boolean);
  const rows = (Array.isArray(payload.rows) ? payload.rows : [])
    .filter((r): r is unknown[] => Array.isArray(r))
    .slice(0, 200)
    .map((r) => r.slice(0, Math.max(1, columns.length)));
  if (!columns.length || !rows.length) return <ResultEmpty text="No table data." />;
  return <ResultTable columns={columns} rows={rows} sortable caption={str(payload.caption, 160)} />;
}

/* ── Chart (§67: local SVG from validated rows — retrieved code never
 * runs, §60; dataviz palette stays token-driven, §45) ──────────────────── */
export function InteractiveChart({ payload }: { payload: Record<string, unknown> }) {
  const type = str(payload.type, 16) ?? "bar";
  const series = itemsOf(payload, "series").slice(0, 6);
  const labels = (Array.isArray(payload.labels) ? payload.labels : []).map((l) => str(l, 24) ?? "").slice(0, 60);
  const first = series[0];
  const values = first && Array.isArray(first.values)
    ? (first.values as unknown[]).map(num).slice(0, 60)
    : [];
  if (!values.length || values.some((v) => v === undefined)) {
    return <ResultEmpty text="No chart data." />;
  }
  const vals = values as number[];
  const w = 480, h = 180, pad = 24;
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (w - pad * 2)) / Math.max(1, vals.length - (type === "bar" ? vals.length : vals.length - 1));
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const bw = type === "bar" ? Math.max(4, (w - pad * 2) / vals.length - 4) : 0;
  return (
    <div role="img" aria-label={str(payload.caption, 160) ?? "Chart"}>
      <svg className="wr-chart" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
        <line className="wr-chart-axis" x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} />
        {type === "line" ? (
          <polyline className="wr-chart-line" points={vals.map((v, i) => `${x(i) + bw / 2},${y(v)}`).join(" ")} />
        ) : null}
        {vals.map((v, i) => type === "bar"
          ? <rect key={i} className="wr-chart-bar" x={x(i)} y={y(v)} width={bw} height={Math.max(1, h - pad - y(v))} />
          : <circle key={i} className="wr-chart-dot" cx={x(i)} cy={y(v)} r={2.5} />)}
        {labels.slice(0, 6).map((l, i) => (
          <text key={i} className="wr-chart-label" x={x(i)} y={h - 6} textAnchor="middle">{l}</text>
        ))}
      </svg>
      {series.length > 1 && (
        <div className="wr-legend" aria-hidden="true">
          {series.map((s, i) => <span key={i}>{str(s.name, 40) ?? `Series ${i + 1}`}</span>)}
        </div>
      )}
    </div>
  );
}

/* ── Timeline / metrics ───────────────────────────────────────────────── */
export function ResultTimeline({ payload }: { payload: Record<string, unknown> }) {
  const events = itemsOf(payload, "events").slice(0, 50);
  if (!events.length) return <ResultEmpty text="No timeline data." />;
  return (
    <ol className="wr-timeline">
      {events.map((e, i) => (
        <li key={i} className="wr-timeline-item">
          <strong>{str(e.label, 160) ?? str(e.title, 160) ?? `#${i + 1}`}</strong>
          {str(e.date, 40) && <span className="wr-card-note"> · {str(e.date, 40)}</span>}
          {str(e.description, 300) && <div className="wr-card-line">{str(e.description, 300)}</div>}
        </li>
      ))}
    </ol>
  );
}

export function ResultMetric({ value, label, delta, sourceNote }: {
  value?: string; label?: string; delta?: number; sourceNote?: string;
}) {
  const dir = delta !== undefined && delta > 0 ? "up" : delta !== undefined && delta < 0 ? "down" : undefined;
  return (
    <div className="wr-metric">
      <div className="wr-metric-value">{value ?? "—"}</div>
      {label && <div className="wr-metric-label">{label}</div>}
      {dir && <div className={`wr-metric-delta wr-metric-delta--${dir}`}>{delta! > 0 ? "+" : ""}{new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(delta!)}</div>}
      {sourceNote && <div className="wr-card-note">{sourceNote}</div>}
    </div>
  );
}

/* ── Gallery (§6: provenance always; lightbox on demand) ──────────────── */
export function ResultGallery({ images }: {
  images: { url: string; alt?: string; creditDomain?: string; creditUrl?: string }[];
}) {
  const ctx = useRichResultCtx();
  const list = images.slice(0, 24);
  if (!list.length) return <ResultEmpty text="No images." />;
  const media: LightboxMedia[] = list.map((im) => ({ url: im.url, alt: im.alt, creditDomain: im.creditDomain, creditUrl: im.creditUrl }));
  return (
    <div className="wr-gallery" role="group" aria-label="Image gallery">
      {list.map((im, i) => (
        <button key={i} type="button" aria-label={`Open image ${i + 1}${im.alt ? `: ${im.alt}` : ""}`}
          onClick={() => ctx?.openLightbox(media, i)}>
          <img src={im.url} alt={im.alt ?? `Image ${i + 1}`} loading="lazy" />
          {im.creditDomain && (
            <span className="wr-credit" style={{ display: "block", marginTop: 2 }}>
              {im.creditUrl
                ? <a href={im.creditUrl} target="_blank" rel="noopener noreferrer">{im.creditDomain}</a>
                : im.creditDomain}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Shared image collection reader: payload images → validated gallery rows. */
export function galleryImages(payload: Record<string, unknown>) {
  return itemsOf(payload, "images").slice(0, 24)
    .map((im) => {
      const url = safeUrl(im.url);
      if (!url) return null;
      const credit = itemProvenance(im);
      return {
        url,
        alt: str(im.alt, 200) ?? str(im.title, 200),
        creditDomain: credit ?? (hostOf(url) || undefined),
        creditUrl: safeUrl(im.sourceUrl) ?? safeUrl(im.pageUrl),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

/* ── Skeleton (§44: single-color opacity pulse, NO gradient sweep) ────── */
export function ResultSkeleton({ height = 120 }: { height?: number }) {
  return <div className="wr-skeleton" style={{ height }} aria-hidden="true" />;
}

export function ResultEmpty({ text }: { text: string }) {
  return <div className="wr-empty">{text}</div>;
}
