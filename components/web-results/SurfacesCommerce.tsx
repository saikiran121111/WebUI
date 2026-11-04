"use client";
/**
 * SurfacesCommerce.tsx — product, comparison, restaurant, reservation,
 * job, and event surfaces (§67). Every price, rating, slot time, salary,
 * or date shown here exists ONLY because the payload carries it (§3).
 * Reservation slots and comparison rows are ENTRY POINTS (§41/§42): the
 * UI shows structured availability and links out; it never books, never
 * claims a transaction, and never auto-executes anything.
 */
import { memo } from "react";
import type { RichResult } from "../../lib/web-search/rich-results";
import { RichResultFrame } from "./RichResultFrame";
import { ResultCard, ResultEmpty, ResultTable } from "./ResultPrimitives";
import { ResultCarousel } from "./ResultChrome";
import { dateLabel, hostOf, itemsOf, money, num, safeUrl, str } from "./resultHelpers";
import { useRichResultCtx } from "./richResultContext";

function productLines(it: Record<string, unknown>): string[] {
  const price = money(it.price, it.currency);
  const rating = num(it.rating);
  const reviews = num(it.reviews);
  return [
    price ? `Price: ${price}` : "",
    rating !== undefined ? `★ ${rating.toFixed(1)}${reviews !== undefined ? ` (${reviews})` : ""}` : "",
    str(it.availability, 60) ?? "",
  ].filter(Boolean);
}

/* ── ProductCard (product kind: one item) + ProductCarousel (items) ───── */
export const ProductSurface = memo(function ProductSurface({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const items = itemsOf(p).slice(0, 12);
  const single = !items.length && (num(p.price) !== undefined || str(p.title, 200)) ? [p] : items;
  if (!single.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No products found." /></RichResultFrame>;
  }
  const cards = single.map((it, i) => {
    const url = safeUrl(it.url);
    return (
      <ResultCard key={i}
        title={str(it.title, 200) ?? `Product ${i + 1}`}
        lines={productLines(it)}
        note={str(it.sourceRef, 80)}
        href={url} />
    );
  });
  return (
    <RichResultFrame surface={surface} supportsFullscreen>
      {cards.length === 1 ? cards[0] : <ResultCarousel label="Products">{cards}</ResultCarousel>}
    </RichResultFrame>
  );
});

/* ── ProductComparison: product headers × attribute rows → one table.
 *  Rows come from the payload; a product missing a cell shows "—", never
 *  a guessed value (§3). ───────────────────────────────────────────────── */
export const ProductComparison = memo(function ProductComparison({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const products = itemsOf(p, "products").slice(0, 6);
  const rows = itemsOf(p, "rows").slice(0, 24);
  if (!products.length || !rows.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="Nothing to compare." /></RichResultFrame>;
  }
  const columns = ["Attribute", ...products.map((pr, i) => str(pr.name, 80) ?? str(pr.title, 80) ?? `Product ${i + 1}`)];
  const grid = rows.map((r) => {
    const attr = str(r.attribute, 80) ?? "";
    const vals = Array.isArray(r.values) ? r.values : [];
    return [attr, ...products.map((_, i) => {
      const v = vals[i];
      if (typeof v === "number") return String(v);
      if (typeof v === "boolean") return v ? "Yes" : "No";
      return str(v, 120) ?? "—";
    })];
  });
  return (
    <RichResultFrame surface={surface} supportsFullscreen>
      <ResultTable columns={columns} rows={grid} caption={surface.title} />
      <div className="wr-src-row" style={{ marginTop: 6 }}>
        {products.map((pr, i) => {
          const u = safeUrl(pr.url);
          return u ? <a key={i} className="wr-src-link" href={u} target="_blank" rel="noopener noreferrer">{hostOf(u)}</a> : null;
        })}
      </div>
    </RichResultFrame>
  );
});

/* ── RestaurantCard (restaurant kind) — structured fields only ────────── */
export const RestaurantSurface = memo(function RestaurantSurface({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const items = itemsOf(p).slice(0, 8);
  const list = items.length ? items : [p];
  return (
    <RichResultFrame surface={surface}>
      <div className="wr-list">
        {list.map((it, i) => {
          const rating = num(it.rating);
          const reviews = num(it.reviews);
          return (
            <ResultCard key={i}
              title={str(it.name, 160) ?? `Restaurant ${i + 1}`}
              lines={[
                str(it.cuisine, 80) ?? "",
                rating !== undefined ? `★ ${rating.toFixed(1)}${reviews !== undefined ? ` (${reviews})` : ""}` : "",
                str(it.priceRange, 16) ?? "",
                str(it.address, 200) ?? "",
              ].filter(Boolean)}
              note={str(it.sourceRef, 80)}
              href={safeUrl(it.url)} />
          );
        })}
      </div>
    </RichResultFrame>
  );
});

/* ── ReservationSlots (§41 entry-point law): showing a slot time is NOT
 *  booking; a click hands the structured slot to a follow-up prompt. ───── */
export const ReservationSlots = memo(function ReservationSlots({ surface }: { surface: RichResult }) {
  const ctx = useRichResultCtx();
  const p = surface.payload as Record<string, unknown>;
  const slots = itemsOf(p, "items").slice(0, 24);
  if (!slots.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No published availability." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface}>
      <div className="wr-grid wr-grid--2" role="group" aria-label="Reservation times from source">
        {slots.map((s, i) => {
          const time = str(s.time, 40) ?? str(s.label, 40) ?? `Slot ${i + 1}`;
          const available = s.available === true;
          return (
            <button key={i} type="button" className={`wr-card wr-card--row${available ? " wr-card--clickable" : ""}`}
              disabled={!available}
              aria-label={`Reservation slot ${time}${available ? "" : " (unavailable)"}`}
              onClick={() => {
                if (!available) return;
                const party = num(p.partySize);
                const who = str(p.name, 80);
                ctx?.onFollowUp?.(
                  `I'd like to reserve${who ? ` at ${who}` : ""}${party ? ` for ${party}` : ""} at ${time}. `
                  + "Use the source link to continue — do not complete any transaction for me.",
                );
              }}>
              <span className="wr-card-title">{time}</span>
              <span className="wr-card-note">{available ? "Available at source" : "Unavailable"}</span>
            </button>
          );
        })}
      </div>
    </RichResultFrame>
  );
});

/* ── JobCard / EventCard ──────────────────────────────────────────────── */
export const JobSurface = memo(function JobSurface({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const items = itemsOf(p).slice(0, 12);
  if (!items.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No jobs found." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface} supportsFullscreen>
      <div className="wr-list">
        {items.map((it, i) => (
          <ResultCard key={i}
            title={str(it.title, 200) ?? `Listing ${i + 1}`}
            lines={[
              str(it.company, 120) ?? "",
              str(it.location, 120) ?? "",
              str(it.salary, 80) ?? "",
              dateLabel(it.postedAt) ? `Posted ${dateLabel(it.postedAt)}` : "",
            ].filter(Boolean)}
            note={str(it.sourceRef, 80)}
            href={safeUrl(it.url)} />
        ))}
      </div>
    </RichResultFrame>
  );
});

export const EventSurface = memo(function EventSurface({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const items = itemsOf(p).slice(0, 12);
  if (!items.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No events found." /></RichResultFrame>;
  }
  const cards = items.map((it, i) => (
    <ResultCard key={i}
      title={str(it.title, 200) ?? `Event ${i + 1}`}
      lines={[
        dateLabel(it.date) ?? "",
        str(it.venue, 120) ?? "",
        str(it.location, 120) ?? "",
      ].filter(Boolean)}
      note={str(it.sourceRef, 80)}
      href={safeUrl(it.url)} />
  ));
  return (
    <RichResultFrame surface={surface} supportsFullscreen>
      {surface.presentation?.preferred === "grid"
        ? <div className="wr-grid" role="group" aria-label="Events">{cards}</div>
        : <ResultCarousel label="Events">{cards}</ResultCarousel>}
    </RichResultFrame>
  );
});
