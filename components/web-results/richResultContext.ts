"use client";
/**
 * richResultContext.ts — shared plumbing for the P5 rich-result platform.
 *
 * Every surface needs the same three things the message owns: the [S#]
 * citation map (provenance resolution, §42), the follow-up sender
 * (issue_followup, §40), and the overlay host (sheet / lightbox /
 * fullscreen / PiP, §8). Threading all of those through props would
 * re-appear in every one of the 33+ components; one context keeps the
 * surface components pure-prop and the dispatcher in one place.
 */
import { createContext, useContext } from "react";
import type { RichResult } from "../../lib/web-search/rich-results";

/** One entry of the message web-citation map (server CitationMap shape). */
export interface CitationEntryLite {
  sourceId?: string;
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
}

export interface LightboxMedia {
  url: string;
  alt?: string;
  creditDomain?: string;
  creditUrl?: string;
}

export interface OverlayRequest {
  surface: RichResult;
  /** When set, the overlay shows one payload item instead of the surface. */
  itemId?: string;
  mode: "detail" | "fullscreen" | "pip";
}

export interface RichResultCtxValue {
  citationMap?: Record<string, CitationEntryLite>;
  onFollowUp?: (prompt: string) => void;
  openOverlay: (req: OverlayRequest) => void;
  openLightbox: (items: LightboxMedia[], index: number) => void;
  /** MapResult selected-pin channel (select_map_pin action, §40). */
  getSelectedPin?: (surfaceId: string) => string | undefined;
  selectPin?: (surfaceId: string, pinId: string) => void;
  /** Media components register a seeker; seek_media drives it (§40). */
  registerSeeker?: (surfaceId: string, seek: (seconds: number) => void) => () => void;
  seekMedia?: (surfaceId: string, seconds: number) => void;
}

export const RichResultCtx = createContext<RichResultCtxValue | null>(null);

/** Null-safe read: surfaces may render outside a renderer (tests). */
export function useRichResultCtx(): RichResultCtxValue | null {
  return useContext(RichResultCtx);
}
