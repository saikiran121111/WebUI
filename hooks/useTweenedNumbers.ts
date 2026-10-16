"use client";
import { useEffect, useRef, useState } from "react";

const DEFAULT_TWEEN_MS = 320;

/**
 * rAF value tween: eases a numeric vector toward its target at the display's
 * native refresh rate (easeOutCubic), so chart geometry glides instead of
 * snapping when sliders, legend toggles or rescales change the data.
 * Snaps instantly when the vector length changes or the user prefers
 * reduced motion; a no-op (no re-render) when values are already equal.
 */
export function useTweenedNumbers(targets: number[], duration = DEFAULT_TWEEN_MS): number[] {
  const [display, setDisplay] = useState<number[]>(targets);
  const displayRef = useRef<number[]>(targets);
  const targetsRef = useRef<number[]>(targets);
  targetsRef.current = targets;
  const targetKey = targets.join("\u0000");

  useEffect(() => {
    const to = targetsRef.current;
    const from = displayRef.current;
    const sameShape = from.length === to.length;
    if (sameShape && from.every((v, i) => v === to[i])) return; // no change: no re-render
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !sameShape) {
      displayRef.current = to;
      setDisplay(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = to.map((v, i) => from[i] + (v - from[i]) * eased);
      displayRef.current = next;
      setDisplay(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [targetKey, duration]);

  return display;
}
