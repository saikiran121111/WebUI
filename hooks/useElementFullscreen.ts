"use client";
/**
 * Fullscreen for a card-like element, shared by the artifact viewers
 * (DocumentCard, HtmlArtifactBlock). Two modes, one contract:
 *
 *  - native Fullscreen API whenever the grant succeeds (browser chrome hidden);
 *  - the caller's `--fullscreen` CSS class otherwise. That fallback used to be
 *    dead code in both viewers: a DENIED request left `fullscreen` false so the
 *    class was never applied, and when the API is absent `el.requestFullscreen?.()`
 *    returned `undefined`, so the chained `.then(...)` threw a TypeError and the
 *    button did nothing at all (2026-11-06 audit, finding 6).
 *
 * `fullscreen` now tracks BOTH modes, which also fixes the layout half of the
 * bug: the class carries `flex:1; height:auto` for the inner frame, and without
 * it a NATIVE-fullscreen card kept its auto-sized pixel height instead of
 * filling the screen. Esc exits the CSS mode; in native mode the browser owns
 * Esc and `fullscreenchange` syncs us back.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface ElementFullscreen {
  /** True while the card is fullscreen in EITHER mode. */
  fullscreen: boolean;
  /** Enter/exit toggle wired to the card's Fullscreen button. */
  toggleFullscreen: () => void;
}

export function useElementFullscreen(ref: RefObject<HTMLElement | null>): ElementFullscreen {
  const [fullscreen, setFullscreen] = useState(false);
  // True only while the native API actually owns the element — then the
  // browser (not our Esc handler) handles exit, and fullscreenchange syncs us.
  const nativeFsRef = useRef(false);

  const toggleFullscreen = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen();
      return;
    }
    // CSS-fallback mode is active: a second click must EXIT the overlay rather
    // than ask for native fullscreen again on top of it.
    if (fullscreen && !nativeFsRef.current) {
      setFullscreen(false);
      return;
    }
    if (document.fullscreenElement) return; // another element owns fullscreen

    let request: Promise<void> | undefined;
    try {
      request = el.requestFullscreen?.();
    } catch {
      request = undefined; // some browsers throw synchronously instead of rejecting
    }
    if (!request || typeof request.then !== "function") {
      // No API here (insecure context, policy-disabled, older engine): CSS mode.
      nativeFsRef.current = false;
      setFullscreen(true);
      return;
    }
    request
      .then(() => {
        nativeFsRef.current = true;
        setFullscreen(true);
      })
      .catch(() => {
        // Grant refused (subframe, user gesture lost, policy): fall back to CSS
        // instead of silently doing nothing.
        nativeFsRef.current = false;
        setFullscreen(true);
      });
  }, [ref, fullscreen]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && nativeFsRef.current) {
        nativeFsRef.current = false;
        setFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    if (!fullscreen || nativeFsRef.current) return;
    // Native fullscreen consumes Esc (browser exits FS → fullscreenchange
    // syncs state); this handler only covers the CSS-fallback mode.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  return { fullscreen, toggleFullscreen };
}
