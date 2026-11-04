"use client";
/**
 * ResultChrome.tsx — carousel / grid containers (§5/§67), the §59 error
 * surface, and the §43 stale badge. The carousel keeps §52 honesty:
 * labelled buttons, slide roles, and it never auto-scrolls (a carousel
 * that moves on its own is layout spam under §53).
 */
import { useRef, type ReactNode } from "react";
import { safeUrl } from "./resultHelpers";

export function ResultCarousel({ label, children }: { label: string; children: ReactNode[] }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scroll = (dir: 1 | -1) => {
    trackRef.current?.scrollBy({ left: dir * Math.max(240, (trackRef.current.clientWidth ?? 320) * 0.8), behavior: "smooth" });
  };
  const n = children.length;
  return (
    <div className="wr-carousel" role="region" aria-roledescription="carousel" aria-label={label}>
      <div className="wr-carousel-track" ref={trackRef}>
        {children.map((c, i) => (
          <div key={i} role="group" aria-roledescription="slide" aria-label={`Item ${i + 1} of ${n}`}>{c}</div>
        ))}
      </div>
      {n > 1 && (
        <>
          <button type="button" className="wr-carousel-btn wr-carousel-btn--prev" aria-label="Previous item"
            onClick={() => scroll(-1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <button type="button" className="wr-carousel-btn wr-carousel-btn--next" aria-label="Next item"
            onClick={() => scroll(1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        </>
      )}
    </div>
  );
}

export function ResultGrid({ label, children, two }: { label: string; children: ReactNode[]; two?: boolean }) {
  return (
    <div className={`wr-grid${two ? " wr-grid--2" : ""}`} role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** §59: "Couldn't load interactive view / Open source" — one broken widget
 * never destroys the response; the source escape hatch is always present. */
export function ResultError({ url, text }: { url?: string; text?: string }) {
  const href = safeUrl(url);
  return (
    <div className="wr-error" role="status">
      <span className="wr-error-text">{text ?? "Couldn’t load interactive view."}</span>
      {href && (
        <a className="wr-src-link" href={href} target="_blank" rel="noopener noreferrer">Open source</a>
      )}
    </div>
  );
}

/** §43: freshness is a label, not a decoration. */
export function StaleBadge({ stale, updatedAt }: { stale?: boolean; updatedAt?: string }) {
  if (!stale && !updatedAt) return null;
  return (
    <span className={`wr-badge${stale ? " wr-badge--stale" : ""}`} aria-live="polite">
      {stale ? "Possibly outdated" : updatedAt ? `As of ${updatedAt}` : "Snapshot"}
    </span>
  );
}
