"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// The rail drags no narrower than the width where a collapse used to trigger
// (the old 280 minimum minus the 48px collapse slack). Open/close belongs
// solely to the top-bar toggle now; the drag never collapses or reveals.
export const SIDEBAR_MIN = 232;
export const SIDEBAR_DEFAULT = 316;
const WIDTH_KEY = "sidebar-width";

/** Hard user ceiling: one quarter of the viewport. */
const maxWidth = () => Math.floor(window.innerWidth / 4);
// The floor wins when a very narrow window pushes the ceiling under it —
// mirrors the CSS min-width, which also overrides max-width, so the drag
// handle always sits exactly on the rail's border.
const clampW = (w: number) => Math.max(SIDEBAR_MIN, Math.min(maxWidth(), w));

/**
 * Pointer-drag width for the desktop sidebar. Grab the open rail's right
 * border; left/right dragging resizes between SIDEBAR_MIN and the 1/4
 * viewport ceiling — it never closes the rail. The width survives reloads
 * via localStorage; the component also clamps rendering with CSS min/max so
 * window resizes can never exceed the ceiling.
 */
export function useSidebarResize() {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT);
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  // Restore the last dragged width once on the client (SSR-safe default).
  useEffect(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN) setWidth(clampW(saved));
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isDragging]);

  const beginDrag = useCallback((clientX: number) => {
    const startX = clientX;
    const startW = widthRef.current;
    let live = startW;
    setIsDragging(true);

    const onMove = (e: PointerEvent) => {
      live = clampW(startW + (e.clientX - startX));
      setWidth(live);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setIsDragging(false);
      localStorage.setItem(WIDTH_KEY, String(live));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // Re-clamp the width when the window crosses either bound.
  useEffect(() => {
    const onResize = () => setWidth(w => (w === clampW(w) ? w : clampW(w)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, isDragging, beginDrag };
}
