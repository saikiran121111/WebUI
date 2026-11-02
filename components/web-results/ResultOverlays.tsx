"use client";
/**
 * ResultOverlays.tsx — §8 display-mode hosts (sheet, lightbox, fullscreen,
 * PiP) with the §52 keyboard law: Esc closes, Tab stays inside the panel
 * (focus trap), focus returns to the opener on close. The overlays are
 * fixed-position hosts owned by RichResultRenderer, one per message.
 */
import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ResultSkeleton } from "./ResultPrimitives";

/** Esc-close + Tab-trap + focus-restore. Returns a ref to attach to the panel. */
export function useOverlayA11y(
  open: boolean,
  onClose: () => void,
  label: string,
): RefObject<HTMLDivElement> {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    const focusables = () => Array.from(
      panel?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    (focusables()[0] ?? panel)?.focus?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const prev = restoreRef.current as HTMLElement | null;
      prev?.focus?.();
    };
  }, [open, onClose]);

  return panelRef;
}

/** A generic labelled dialog panel (caller wraps in .wr-sheet/.wr-overlay). */
export function OverlayPanel({
  title, onClose, children, wide,
}: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useOverlayA11y(true, onClose, title);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className={`wr-overlay-panel wr-fade${wide ? " wr-overlay-panel--wide" : ""}`}
    >
      <button type="button" className="wr-overlay-close" aria-label="Close" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
      {children}
    </div>
  );
}

export function Sheet({ title, onClose, children }: {
  title: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useOverlayA11y(true, onClose, title);
  return (
    <div className="wr-sheet wr-fade" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="wr-sheet-panel">
        <button type="button" className="wr-overlay-close" aria-label="Close" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        {children}
      </div>
    </div>
  );
}

/** §6 lightbox: image + visible provenance credit + prev/next keyboard. */
export function Lightbox({
  items, index, onClose, onIndex,
}: {
  items: { url: string; alt?: string; creditDomain?: string; creditUrl?: string }[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const step = useCallback((d: number) => {
    onIndex((index + d + items.length) % items.length);
  }, [index, items.length, onIndex]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step]);
  const item = items[index];
  if (!item) return null;
  return (
    <div className="wr-overlay wr-fade" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <OverlayPanel title={item.alt ?? `Image ${index + 1} of ${items.length}`} onClose={onClose} wide>
        <div className="wr-fade" role="group" aria-label={`Image ${index + 1} of ${items.length}`}>
          {/* §6 lazy even inside the lightbox; native img, no gradient frame */}
          <img src={item.url} alt={item.alt ?? ""} loading="lazy"
            style={{ maxWidth: "100%", maxHeight: "70vh", display: "block", margin: "0 auto" }} />
          <div className="wr-src-row" style={{ marginTop: 8, justifyContent: "center" }}>
            {items.length > 1 && (
              <button type="button" className="wr-action" aria-label="Previous image" onClick={() => step(-1)}>Prev</button>
            )}
            <span className="wr-credit">
              {index + 1} / {items.length}
              {item.creditDomain && (item.creditUrl
                ? <> · <a href={item.creditUrl} target="_blank" rel="noopener noreferrer">{item.creditDomain}</a></>
                : <> · {item.creditDomain}</>)}
            </span>
            {items.length > 1 && (
              <button type="button" className="wr-action" aria-label="Next image" onClick={() => step(1)}>Next</button>
            )}
          </div>
        </div>
      </OverlayPanel>
    </div>
  );
}

/** Loading placeholder for dynamically-imported heavy surfaces (§62). */
export function OverlayFallback() {
  return <ResultSkeleton height={240} />;
}
