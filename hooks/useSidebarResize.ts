"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export const SIDEBAR_MIN = 280;
export const SIDEBAR_DEFAULT = 316;
// Dragging this far past the minimum collapses the rail (Claude-style).
const COLLAPSE_SLACK = 48;
const WIDTH_KEY = "sidebar-width";

/** Hard user ceiling: one quarter of the viewport. */
const maxWidth = () => Math.floor(window.innerWidth / 4);
const clampW = (w: number) => Math.min(maxWidth(), Math.max(SIDEBAR_MIN, w));

interface ResizeOptions {
  onClose: () => void;
  onOpen: () => void;
}

/**
 * Pointer-drag width for the desktop sidebar. Two entry points:
 * - "edge": grab the open rail's right border; width follows the drag delta.
 *   Pushing well past SIDEBAR_MIN collapses the rail and restores the
 *   pre-drag width, so a later toggle-reopen is not stuck at the minimum.
 * - "reveal": grab the collapsed screen-edge strip; the rail reopens and its
 *   width tracks the pointer x directly.
 * The width survives reloads via localStorage; the component also clamps
 * rendering with min/max CSS so window resizes can never exceed the ceiling.
 */
export function useSidebarResize({ onClose, onOpen }: ResizeOptions) {
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

  const beginDrag = useCallback((clientX: number, mode: "edge" | "reveal") => {
    if (mode === "reveal") {
      onOpen();
      // Reveal starts pinned to the minimum at the left edge, then follows
      // the pointer — no jump to the previous width mid-drag.
      setWidth(clampW(clientX));
    }
    const startX = clientX;
    const startW = mode === "reveal" ? SIDEBAR_MIN : widthRef.current;
    let live = startW;
    let collapsed = false;
    setIsDragging(true);

    const onMove = (e: PointerEvent) => {
      if (collapsed) return;
      const raw = mode === "reveal" ? e.clientX : startW + (e.clientX - startX);
      if (mode === "edge" && raw < SIDEBAR_MIN - COLLAPSE_SLACK) {
        collapsed = true;
        setWidth(startW);
        onClose();
        return;
      }
      live = clampW(raw);
      setWidth(live);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setIsDragging(false);
      if (!collapsed) localStorage.setItem(WIDTH_KEY, String(live));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [onClose, onOpen]);

  // Re-clamp the stored width when the window shrinks under the ceiling.
  useEffect(() => {
    const onResize = () => setWidth(w => (w > maxWidth() ? maxWidth() : w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, isDragging, beginDrag };
}
