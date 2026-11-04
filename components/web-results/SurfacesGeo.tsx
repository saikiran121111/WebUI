"use client";
/**
 * SurfacesGeo.tsx — map + local-business surfaces (§11–§12).
 *
 * §11 law: coordinates come ONLY from a validated provider payload; an
 * invalid coordinate drops the pin — the map never "approximates" a place.
 * The OSM embed iframe mounts only once the surface is on-screen
 * (§63: no iframe until visible) using the repo's existing zero-dependency
 * iframe path — no Leaflet, no new packages. Pin selection (§12: a card
 * click selects the pin, it never fabricates detail rows) is state in the
 * frame, shared with the select_map_pin action through the context.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { RichResult } from "../../lib/web-search/rich-results";
import { RichResultFrame } from "./RichResultFrame";
import { ResultEmpty } from "./ResultPrimitives";
import { coord, itemsOf, num, safeUrl, str } from "./resultHelpers";
import { useRichResultCtx } from "./richResultContext";

interface Pin {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  address?: string;
  url?: string;
}

/** Validated pins only — §75 (invalid coordinates dropped, NaN dropped). */
export function readPins(payload: Record<string, unknown>): Pin[] {
  const out: Pin[] = [];
  for (const it of itemsOf(payload, "pins").slice(0, 25)) {
    const lat = coord(it.lat);
    const lng = coord(it.lng);
    if (lat === undefined || lng === undefined || (lat === 0 && lng === 0)) continue;
    const id = str(it.id, 80) ?? `pin${out.length + 1}`;
    out.push({
      id,
      lat,
      lng,
      label: str(it.label, 160) ?? str(it.name, 160),
      address: str(it.address, 200),
      url: safeUrl(it.url),
    });
  }
  return out;
}

function bboxOf(pins: Pin[], selected?: Pin): string {
  const focus = selected ? [selected] : pins;
  const lats = focus.map((p) => p.lat);
  const lngs = focus.map((p) => p.lng);
  const dLat = 0.01, dLng = 0.02;
  const minLat = Math.min(...lats) - dLat, maxLat = Math.max(...lats) + dLat;
  const minLng = Math.min(...lngs) - dLng, maxLng = Math.max(...lngs) + dLng;
  return [minLng, minLat, maxLng, maxLat].map((n) => n.toFixed(5)).join(",");
}

/** Lazy client-only mount (IntersectionObserver) — SSR/tests see the
 *  placeholder + pin list, a real browser sees the iframe once on-screen. */
function useVisibleOnce(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible, ref]);
  return visible;
}

export const MapResult = memo(function MapResult({ surface }: { surface: RichResult }) {
  const ctx = useRichResultCtx();
  const p = surface.payload as Record<string, unknown>;
  const pins = readPins(p);
  const selectedId = ctx?.getSelectedPin?.(surface.id);
  const [localSel, setLocalSel] = useState<string | undefined>(undefined);
  const selId = selectedId ?? localSel;
  const sel = pins.find((pt) => pt.id === selId) ?? pins[0];
  const holderRef = useRef<HTMLDivElement | null>(null);
  const onScreen = useVisibleOnce(holderRef);

  const embed = useMemo(() => {
    if (!pins.length || !sel) return undefined;
    const zoom = Math.round(Math.min(17, 5 + Math.log10(Math.max(1, pins.length)) * 3));
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bboxOf(pins, sel)}`
      + `&layer=mapnik&marker=${sel.lat.toFixed(5)},${sel.lng.toFixed(5)},${zoom}`;
  }, [pins, sel]);

  if (!pins.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No map coordinates available." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface} supportsFullscreen>
      <div className="wr-map" ref={holderRef}>
        {onScreen && embed ? (
          <iframe className="wr-map-frame" title="Map of retrieved locations"
            src={embed} loading="lazy"
            referrerPolicy="no-referrer" />
        ) : (
          <div className="wr-map-placeholder">
            <span>Map loads when visible.</span>
            <span>
              <a className="wr-src-link" href={`https://www.openstreetmap.org/?mlat=${sel?.lat.toFixed(5)}&mlon=${sel?.lng.toFixed(5)}#map=14/${sel?.lat.toFixed(5)}/${sel?.lng.toFixed(5)}`}
                target="_blank" rel="noopener noreferrer">Open map</a>
            </span>
          </div>
        )}
        <div role="listbox" aria-label="Map locations" className="wr-list">
          {pins.map((pt) => (
            <div key={pt.id} role="option" aria-selected={pt.id === sel?.id}
              className={`wr-pin-row${pt.id === sel?.id ? " wr-pin--active" : ""}`}>
              <button type="button" className="wr-pin-btn" onClick={() => {
                setLocalSel(pt.id);
                ctx?.selectPin?.(surface.id, pt.id);
              }}>
                {pt.label ?? `Pin ${pt.id}`}
                {pt.address ? <span className="wr-card-note"> · {pt.address}</span> : null}
              </button>
              {pt.url && <a className="wr-src-link" href={pt.url} target="_blank" rel="noopener noreferrer">Source</a>}
            </div>
          ))}
        </div>
        <div className="wr-credit">
          Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors
          {p.stale ? " · locations may have moved" : ""}
        </div>
      </div>
    </RichResultFrame>
  );
});

/** §12 LocalBusinessCard: NEVER a guessed rating/hours/price — every row
 *  exists only if the payload carries it; card click selects the pin and
 *  opens the detail sheet, it does not invent fields inside it. */
export const LocalBusinessSurface = memo(function LocalBusinessSurface({ surface }: { surface: RichResult }) {
  const ctx = useRichResultCtx();
  const p = surface.payload as Record<string, unknown>;
  const pins = readPins(p);
  const items = itemsOf(p).slice(0, 12);
  if (!items.length && !pins.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No businesses found." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface} supportsFullscreen>
      <div className="wr-grid wr-grid--2" role="list" aria-label="Local businesses">
        {items.map((it, i) => {
          const rating = num(it.rating);
          const reviews = num(it.reviews);
          const id = str(it.id, 80) ?? `biz${i + 1}`;
          return (
            <div key={i} className="wr-card wr-card--clickable" role="listitem"
              tabIndex={0}
              onClick={() => {
                if (pins.some((pt) => pt.id === id)) ctx?.selectPin?.(surface.id, id);
                ctx?.openOverlay({ surface, itemId: id, mode: "detail" });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (pins.some((pt) => pt.id === id)) ctx?.selectPin?.(surface.id, id);
                  ctx?.openOverlay({ surface, itemId: id, mode: "detail" });
                }
              }}>
              <span className="wr-card-title">{str(it.name, 160) ?? `Place ${i + 1}`}</span>
              {rating !== undefined && (
                <span className="wr-card-line" aria-label={`${rating} out of 5`}
                  data-testid="business-rating">★ {rating.toFixed(1)}{reviews !== undefined ? ` (${reviews})` : ""}</span>
              )}
              {str(it.cuisine, 80) && <span className="wr-card-line">{str(it.cuisine, 80)}</span>}
              {str(it.priceRange, 16) && <span className="wr-card-line">{str(it.priceRange, 16)}</span>}
              {str(it.address, 200) && <span className="wr-card-note">{str(it.address, 200)}</span>}
              {str(it.hours, 120) && <span className="wr-card-note">{str(it.hours, 120)}</span>}
              {str(it.sourceRef, 80) && <span className="wr-credit">{str(it.sourceRef, 80)}</span>}
            </div>
          );
        })}
      </div>
    </RichResultFrame>
  );
});
