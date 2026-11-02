"use client";
/**
 * RichResultFrame.tsx — the one chrome every surface wears: title/subtitle,
 * body slot, §42 provenance footer (sourceRefs are ALWAYS rendered), the
 * §40 action row, §43 stale badge, and the §8 fullscreen affordance for
 * surfaces that opt in. Surfaces never draw their own provenance footer —
 * keeping it here is what makes provenance unskippable.
 */
import type { ReactNode } from "react";
import type { RichResult } from "../../lib/web-search/rich-results";
import { resolveSource, str } from "./resultHelpers";
import { useRichResultCtx } from "./richResultContext";
import { RichResultActions } from "./RichResultActions";
import { StaleBadge } from "./ResultChrome";

export function RichResultFrame({
  surface,
  children,
  compact,
  supportsFullscreen,
}: {
  surface: RichResult;
  children: ReactNode;
  compact?: boolean;
  supportsFullscreen?: boolean;
}) {
  const ctx = useRichResultCtx();
  const refs = Array.isArray(surface.sourceRefs) ? surface.sourceRefs.filter((r): r is string => typeof r === "string") : [];
  const stale = typeof surface.payload === "object" && surface.payload !== null
    ? Boolean((surface.payload as Record<string, unknown>).stale)
    : false;
  const updatedAt = typeof surface.payload === "object" && surface.payload !== null
    ? str((surface.payload as Record<string, unknown>).updatedAt, 40)
    : undefined;

  return (
    <section className={`wr-frame${compact ? " wr-frame--compact" : ""}`} aria-label={surface.title ?? `${surface.kind} results`}>
      {(surface.title || supportsFullscreen || refs.length > 0) && (
        <header className="wr-head">
          <div>
            {surface.title && <h4 className="wr-title">{surface.title}</h4>}
            {surface.subtitle && <div className="wr-sub">{surface.subtitle}</div>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StaleBadge stale={stale} updatedAt={updatedAt} />
            {supportsFullscreen && (
              <button type="button" className="wr-action" aria-label="Open fullscreen view"
                onClick={() => ctx?.openOverlay({ surface, mode: "fullscreen" })}>
                Fullscreen
              </button>
            )}
          </div>
        </header>
      )}
      <div className="wr-body">{children}</div>
      {(refs.length > 0 || (surface.actions?.length ?? 0) > 0) && (
        <footer className="wr-foot wr-foot--split">
          <div className="wr-src-row" aria-label="Sources">
            {refs.map((ref, i) => {
              const s = resolveSource(ref, ctx?.citationMap);
              return s.url
                ? <a key={i} className="wr-src-link" href={s.url} target="_blank" rel="noopener noreferrer">{s.label}</a>
                : <span key={i} className="wr-src-link">{s.label}</span>;
            })}
          </div>
          <RichResultActions surface={surface} />
        </footer>
      )}
    </section>
  );
}
