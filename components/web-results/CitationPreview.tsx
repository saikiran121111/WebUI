"use client";
/**
 * CitationPreview.tsx — §67 CitationPill + CitationPreview. The pill is
 * the one that already exists in MarkdownRenderer; this component keeps
 * its exact DOM contract (data-testid="citation-pill", data-citation,
 * the anchor href) — existing vitest and Playwright locators still pass —
 * and adds a hover/focus popover (title · domain · published date) that
 * is pure CSS (:hover / :focus-within): no state, SSR-safe, keyboard
 * accessible, and invisible to reduced-motion users beyond an opacity
 * fade (motion law §50).
 */
import { memo } from "react";
import { hostOf, safeUrl, str } from "./resultHelpers";

export const CitationPill = memo(function CitationPill({
  sourceId,
  url,
  title,
  domain,
  publishedAt,
}: {
  sourceId: string;
  url: string;
  title?: string;
  domain?: string;
  publishedAt?: string;
}) {
  const href = safeUrl(url);
  const popId = `cite-pop-${sourceId}`;
  return (
    <span className="inline-flex items-center gap-1 align-super wr-cite" data-testid="citation-pill">
      <a
        href={href}
        target={href ? "_blank" : undefined}
        rel={href ? "noopener noreferrer" : undefined}
        title={title}
        data-citation={sourceId}
        aria-describedby={popId}
        className="inline-flex items-center gap-0.5 text-[11px] font-medium
          px-1.5 py-0.5 rounded-md
          bg-transparent text-[#38E8FF]
          outline-none
          transition-colors
          hover:text-[#6beeff] focus-visible:ring-1 focus-visible:ring-[#38E8FF]/40"
      >
        <span>{sourceId}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
          <path d="M7 17 17 7M7 7h10v10" />
        </svg>
      </a>
      <span className="wr-cite-pop" role="tooltip" id={popId} data-testid="citation-preview">
        <span className="wr-card-title">{str(title, 160) ?? (hostOf(url) || sourceId)}</span>
        <span className="wr-src-meta">
          {str(domain, 80) || (url ? hostOf(url) : "")}
          {publishedAt ? ` · ${str(publishedAt, 40)}` : ""}
        </span>
      </span>
    </span>
  );
});
