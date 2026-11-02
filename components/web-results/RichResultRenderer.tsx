"use client";
/**
 * RichResultRenderer.tsx — the root of the rich-results UI (the parallel
 * home to FenceRouter per §4: artifacts stay in FenceRouter, retrieved
 * web surfaces live here). It owns everything surfaces must SHARE and a
 * per-surface component must never re-implement:
 *   • the §42 citation map + §40 action context (one RichResultCtxValue),
 *   • §8 display-mode hosts (detail sheet, fullscreen, PiP, lightbox),
 *   • §54 ONE primary surface inline, the rest behind secondary chips,
 *   • §59 error containment (RichResultErrorBoundary per surface),
 *   • map pin selection + media-seek channels (cross-component actions).
 * The stylesheet is imported HERE so it only ever rides with the lazy
 * rich-results chunk (styles law: lazy CSS travels with its owner).
 */
import "../../styles/web-results.css";
import {
  useCallback, useMemo, useRef, useState,
} from "react";
import type { RichResult } from "../../lib/web-search/rich-results";
import { RichResultCtx, type CitationEntryLite, type LightboxMedia, type OverlayRequest } from "./richResultContext";
import { RichResultErrorBoundary } from "./RichResultErrorBoundary";
import { renderSurface } from "./RichResultRegistry";
import { Lightbox, OverlayPanel, Sheet } from "./ResultOverlays";
import { findItemById, num, safeUrl, str } from "./resultHelpers";

/* Detail view for one structured item (open_detail / compare). Scalar
 * fields become definition rows; nested content is NOT rebuilt into
 * prose (§56) — unknown shapes simply do not render. */
function DetailView({ surface, targetIds }: { surface: RichResult; targetIds: string[] }) {
  const p = (surface.payload && typeof surface.payload === "object" ? surface.payload : {}) as Record<string, unknown>;
  const items = targetIds
    .map((id) => findItemById(p, id))
    .filter((x): x is Record<string, unknown> => x !== null);
  if (!items.length) return renderSurface(surface);
  return (
    <div className="wr-list">
      {items.map((it, i) => {
        const url = safeUrl(it.url);
        const entries = Object.entries(it)
          .filter(([k]) => k !== "id" && k !== "url")
          .slice(0, 16)
          .map(([k, v]) => {
            const label = k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
            if (typeof v === "boolean") return [label, v ? "Yes" : "No"] as const;
            if (typeof v === "number") return [label, String(v)] as const;
            if (typeof v === "string") return [label, str(v, 240) ?? ""] as const;
            return null;
          })
          .filter((x): x is readonly [string, string] => x !== null && !!x[1]);
        return (
          <div key={i} className="wr-card">
            <span className="wr-card-title">{str(it.name, 160) ?? str(it.title, 160) ?? `Entry ${i + 1}`}</span>
            {entries.length > 0 && (
              <dl className="wr-kv">
                {entries.map(([k, v], j) => <div key={j} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
            )}
            {url && <a className="wr-src-link" href={url} target="_blank" rel="noopener noreferrer">Open source</a>}
          </div>
        );
      })}
    </div>
  );
}

export function RichResultsBlock({
  surfaces,
  citationMap,
  onFollowUp,
}: {
  surfaces: RichResult[];
  citationMap?: Record<string, CitationEntryLite>;
  onFollowUp?: (prompt: string) => void;
}) {
  const [overlay, setOverlay] = useState<OverlayRequest | null>(null);
  const [lightbox, setLightbox] = useState<{ items: LightboxMedia[]; index: number } | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const seekersRef = useRef<Map<string, (s: number) => void>>(new Map());

  const openOverlay = useCallback((req: OverlayRequest) => setOverlay(req), []);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const openLightbox = useCallback((items: LightboxMedia[], index: number) => setLightbox({ items, index }), []);
  const getSelectedPin = useCallback((surfaceId: string) => pins[surfaceId], [pins]);
  const selectPin = useCallback((surfaceId: string, pinId: string) => setPins((s) => ({ ...s, [surfaceId]: pinId })), []);
  const registerSeeker = useCallback((surfaceId: string, seek: (s: number) => void) => {
    seekersRef.current.set(surfaceId, seek);
    return () => { seekersRef.current.delete(surfaceId); };
  }, []);
  const seekMedia = useCallback((surfaceId: string, seconds: number) => {
    const s = num(seconds);
    if (s !== undefined && s >= 0) seekersRef.current.get(surfaceId)?.(s);
  }, []);

  const ctx = useMemo(() => ({
    citationMap,
    onFollowUp,
    openOverlay,
    openLightbox,
    getSelectedPin,
    selectPin,
    registerSeeker,
    seekMedia,
  }), [citationMap, onFollowUp, openOverlay, openLightbox, getSelectedPin, selectPin, registerSeeker, seekMedia]);

  if (!surfaces.length) return null;
  const [primary, ...rest] = surfaces;

  return (
    <RichResultCtx.Provider value={ctx}>
      <div className="wr-list" data-testid="rich-results">
        <RichResultErrorBoundary key={primary.id} surface={primary}>
          {renderSurface(primary)}
        </RichResultErrorBoundary>

        {/* §54: secondary surfaces never spam the page — chips open them
            in a sheet on the reader's request. */}
        {rest.length > 0 && (
          <div className="wr-secondary" role="group" aria-label="More results">
            {rest.map((s) => (
              <button key={s.id} type="button" className="wr-action"
                aria-label={`Open ${s.title ?? s.kind} result`}
                onClick={() => openOverlay({ surface: s, mode: "detail" })}>
                {s.title ?? s.kind}
              </button>
            ))}
          </div>
        )}
      </div>

      {overlay && (
        overlay.mode === "fullscreen" || overlay.mode === "pip" ? (
          <div className="wr-overlay wr-fade" onClick={(e) => { if (e.target === e.currentTarget) closeOverlay(); }}>
            <OverlayPanel title={overlay.surface.title ?? `${overlay.surface.kind} (fullscreen)`}
              onClose={closeOverlay} wide={overlay.mode === "fullscreen"}>
              <RichResultErrorBoundary surface={overlay.surface}>
                {overlay.itemId
                  ? <DetailView surface={overlay.surface} targetIds={overlay.itemId.split(",")} />
                  : renderSurface(overlay.surface)}
              </RichResultErrorBoundary>
            </OverlayPanel>
          </div>
        ) : (
          <Sheet title={overlay.surface.title ?? `${overlay.surface.kind} details`} onClose={closeOverlay}>
            <RichResultErrorBoundary surface={overlay.surface}>
              {overlay.itemId
                ? <DetailView surface={overlay.surface} targetIds={overlay.itemId.split(",")} />
                : renderSurface(overlay.surface)}
            </RichResultErrorBoundary>
          </Sheet>
        )
      )}

      {lightbox && (
        <Lightbox items={lightbox.items} index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox((s) => (s ? { ...s, index: i } : s))} />
      )}
    </RichResultCtx.Provider>
  );
}
