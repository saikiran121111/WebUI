"use client";
/**
 * SurfacesInfo.tsx — factual live-data surfaces (§67 core list): weather,
 * finance, sports, news, entity, tracker, metrics. §3 law governs every
 * value on this page: a temperature, a price, a score, or a date that the
 * payload does not carry is NOT rendered — the card shows less rather than
 * inventing more. §43 stale/updatedAt badges come from the frame.
 */
import { memo } from "react";
import type { RichResult } from "../../lib/web-search/rich-results";
import { RichResultFrame } from "./RichResultFrame";
import { ResultCard, ResultEmpty, ResultMetric } from "./ResultPrimitives";
import { ResultCarousel, ResultGrid } from "./ResultChrome";
import { dateLabel, hostOf, itemsOf, money, num, obj, safeUrl, str } from "./resultHelpers";

/* ── WeatherResult: current + forecast rows; unit is data, not design ─── */
export const WeatherResult = memo(function WeatherResult({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const cur = obj(p.current);
  const temp = num(cur?.temp);
  const unit = str(cur?.unit, 8) ?? (num(cur?.temp) !== undefined ? "°" : "");
  const days = itemsOf(p).slice(0, 7);
  if (temp === undefined && !days.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No weather data." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface}>
      {temp !== undefined && (
        <div className="wr-metrics">
          <div className="wr-metric" data-testid="weather-current">
            <span className="wr-metric-value">{temp}{unit}</span>
            <span className="wr-metric-label">{str(cur?.desc, 80) ?? str(p.location, 80) ?? "Now"}</span>
          </div>
        </div>
      )}
      {days.length > 0 && (
        <div className="wr-list" role="list" aria-label="Forecast">
          {days.map((d, i) => {
            const hi = num(d.hi), lo = num(d.lo);
            return (
              <div key={i} className="wr-pin-row" role="listitem">
                <span>{dateLabel(d.date) ?? str(d.label, 40) ?? `Day ${i + 1}`}</span>
                <span className="wr-card-note">
                  {str(d.desc, 60)}
                  {hi !== undefined ? ` ${hi}${unit}` : ""}{hi !== undefined && lo !== undefined ? "/" : ""}{lo !== undefined ? `${lo}${unit}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </RichResultFrame>
  );
});

/* ── FinanceQuote: price + signed change; delta color is semantic ─────── */
export const FinanceQuote = memo(function FinanceQuote({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const price = num(p.price);
  if (price === undefined) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No quote available." /></RichResultFrame>;
  }
  const change = num(p.change);
  const pct = num(p.changePct);
  const dir = change !== undefined ? (change > 0 ? "up" : change < 0 ? "down" : undefined) : undefined;
  return (
    <RichResultFrame surface={surface}>
      <div className="wr-metrics">
        <div className="wr-metric" data-testid="finance-price">
          <span className="wr-metric-value">{money(price, str(p.currency, 8))}</span>
          <span className="wr-metric-label">{str(p.name, 120) ?? str(p.symbol, 16) ?? "Quote"}</span>
          {(change !== undefined || pct !== undefined) && (
            <span className={`wr-metric-delta${dir ? ` wr-metric-delta--${dir}` : ""}`}>
              {change !== undefined ? `${change > 0 ? "+" : ""}${change.toFixed(2)}` : ""}
              {pct !== undefined ? ` (${pct > 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}
            </span>
          )}
        </div>
      </div>
    </RichResultFrame>
  );
});

/* ── SportsResult: score line straight from the payload ───────────────── */
export const SportsResult = memo(function SportsResult({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const home = obj(p.home), away = obj(p.away);
  const hName = str(home?.name, 80), aName = str(away?.name, 80);
  if (!hName || !aName) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No game data." /></RichResultFrame>;
  }
  const hScore = num(home?.score), aScore = num(away?.score);
  return (
    <RichResultFrame surface={surface}>
      <div className="wr-metrics" data-testid="sports-scoreline">
        <div className="wr-metric">
          <span className="wr-metric-value">{hScore !== undefined ? hScore : "—"}</span>
          <span className="wr-metric-label">{hName}</span>
        </div>
        <div className="wr-metric">
          <span className="wr-metric-value">{aScore !== undefined ? aScore : "—"}</span>
          <span className="wr-metric-label">{aName}</span>
        </div>
      </div>
      <div className="wr-credit">
        {str(p.status, 40) ?? "Game"}{str(p.league, 60) ? ` · ${str(p.league, 60)}` : ""}{dateLabel(p.date) ? ` · ${dateLabel(p.date)}` : ""}
      </div>
    </RichResultFrame>
  );
});

/* ── NewsResult: headline cards; layout follows the plan (grid default,
 *  carousel when the plan preferred a carousel) ────────────────────────── */
export const NewsResult = memo(function NewsResult({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const items = itemsOf(p).slice(0, 12);
  const cards = items.map((it, i) => {
    const url = safeUrl(it.url);
    return (
      <ResultCard key={i}
        title={str(it.title, 200) ?? "Untitled"}
        lines={[str(it.domain, 100) ?? (url ? hostOf(url) : ""), dateLabel(it.publishedAt)].filter((x): x is string => !!x)}
        href={url} />
    );
  });
  if (!cards.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No stories found." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface} supportsFullscreen>
      {surface.presentation?.preferred === "carousel"
        ? <ResultCarousel label="News">{cards}</ResultCarousel>
        : <ResultGrid label="News">{cards}</ResultGrid>}
    </RichResultFrame>
  );
});

/* ── EntityCard: subject card + key facts as a definition list ────────── */
export const EntityCard = memo(function EntityCard({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const url = safeUrl(p.url);
  const facts = itemsOf(p).slice(0, 12);
  return (
    <RichResultFrame surface={surface}>
      {str(p.description, 1000) && <p className="wr-card-line" style={{ margin: 0 }}>{str(p.description, 1000)}</p>}
      {facts.length > 0 && (
        <dl className="wr-kv">
          {facts.map((f, i) => (
            <div key={i} style={{ display: "contents" }}>
              <dt>{str(f.label, 80) ?? `Fact ${i + 1}`}</dt>
              <dd>{str(f.value, 200) ?? ""}</dd>
            </div>
          ))}
        </dl>
      )}
      {url && <div className="wr-credit"><a className="wr-src-link" href={url} target="_blank" rel="noopener noreferrer">{hostOf(url)}</a></div>}
    </RichResultFrame>
  );
});

/* ── TrackerResult: status/value/countdown + progress rows when present ─ */
export const TrackerResult = memo(function TrackerResult({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const value = num(p.value);
  const items = itemsOf(p).slice(0, 12);
  const hasAny = value !== undefined || str(p.status, 60) || str(p.countdownAt, 40) || items.length;
  if (!hasAny) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No tracker data." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface}>
      <div className="wr-metrics">
        {str(p.status, 60) && (
          <div className="wr-metric"><span className="wr-metric-value" style={{ fontSize: "1.05rem" }}>{str(p.status, 60)}</span><span className="wr-metric-label">Status</span></div>
        )}
        {value !== undefined && (
          <div className="wr-metric"><span className="wr-metric-value">{value}</span><span className="wr-metric-label">{str(p.unit, 24) ?? "Value"}</span></div>
        )}
        {dateLabel(p.countdownAt) && (
          <div className="wr-metric"><span className="wr-metric-value" style={{ fontSize: "1.05rem" }}>{dateLabel(p.countdownAt)}</span><span className="wr-metric-label">Next update</span></div>
        )}
      </div>
      {items.length > 0 && (
        <div className="wr-list" role="list" aria-label="Tracker updates">
          {items.map((it, i) => (
            <div key={i} className="wr-pin-row" role="listitem">
              <span>{str(it.label, 120) ?? str(it.title, 120) ?? `Update ${i + 1}`}</span>
              <span className="wr-card-note">{str(it.value, 60) ?? dateLabel(it.date)}</span>
            </div>
          ))}
        </div>
      )}
    </RichResultFrame>
  );
});

/* ── MetricCard (metrics kind): a row of neutral stat tiles ───────────── */
export const MetricSurface = memo(function MetricSurface({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const items = itemsOf(p).slice(0, 8);
  if (!items.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No metrics." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface}>
      <div className="wr-metrics">
        {items.map((m, i) => {
          const v = m.value;
          return (
            <ResultMetric key={i}
              value={typeof v === "number" ? String(v) : str(v, 40) ?? "—"}
              label={str(m.label, 80) ?? `Metric ${i + 1}`}
              delta={num(m.delta)}
              sourceNote={str(m.unit, 24)} />
          );
        })}
      </div>
    </RichResultFrame>
  );
});
