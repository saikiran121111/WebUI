"use client";
/**
 * The robot mascot — a vendored, sanitized Fluent Emoji "Robot" (Flat) SVG
 * (MIT, microsoft/fluentui-emoji — license kept at public/mascot/LICENSE-mascot.txt).
 * Inlined as JSX so each part (arms / antenna / eyes) is a real DOM node the
 * CSS state classes can animate. The source file contained no scripts or
 * event handlers; it was reviewed and vendored as-is (only class names added).
 *
 * States: idle (bob + blink) · thinking (antenna pulse) · working (arm
 * welding) · done (hop + sparkles) · error (droop + red eyes). The eyes
 * follow the cursor (clamped, disabled under prefers-reduced-motion) and a
 * click makes the right arm wave.
 */
import { useEffect, useRef, useState } from "react";

export type MascotState = "idle" | "thinking" | "working" | "done" | "error";

interface MascotProps {
  state?: MascotState;
  size?: number;
  /** Cursor-tracking eyes + click-to-wave. Off for purely decorative spots. */
  interactive?: boolean;
  className?: string;
}

export default function Mascot({ state = "idle", size = 32, interactive = true, className }: MascotProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const [waving, setWaving] = useState(false);

  useEffect(() => {
    if (!interactive || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      const el = svgRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      // Normalize by a generous radius so far-away cursors still read as a
      // glance direction; clamp to ±1 unit of the 32-unit viewBox.
      const dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width * 2 + 120)));
      const dy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height * 2 + 120)));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (eyesRef.current) {
          eyesRef.current.style.transform = `translate(${(dx * 1.1).toFixed(2)}px, ${(dy * 0.8).toFixed(2)}px)`;
        }
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, [interactive]);

  const onClick = interactive
    ? () => {
        if (waving) return;
        setWaving(true);
        setTimeout(() => setWaving(false), 1000);
      }
    : undefined;

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Robot mascot"
      onClick={onClick}
      className={[
        `mascot mascot--${state}`,
        interactive ? "mascot--interactive" : "",
        waving ? "mascot--wave" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
    >
      <path className="mascot-arm mascot-arm--left" d="M5 3.5C5 4.15311 4.5826 4.70873 4 4.91465V12L6.16075 17.4867L4 23C2.9 23 2 22.1008 2 21.0018V13.9982C2 13.2625 2.40334 12.6163 3 12.2695V4.91465C2.4174 4.70873 2 4.15311 2 3.5C2 2.67157 2.67157 2 3.5 2C4.32843 2 5 2.67157 5 3.5Z" fill="#F8312F" />
      <path className="mascot-arm mascot-arm--right" d="M30.0499 3.55C30.0499 4.23107 29.6107 4.80955 29 5.01757V12.1998C29.5967 12.5469 30 13.1937 30 13.9301V20.9401C30 22.0401 29.1 22.9401 28 22.9401L25.0595 17.2609L28 11.9301L28 5.0176C27.3893 4.80961 26.95 4.23111 26.95 3.55C26.95 2.69396 27.6439 2 28.5 2C29.356 2 30.0499 2.69396 30.0499 3.55Z" fill="#F8312F" />
      <path className="mascot-antenna" d="M11 4.5C11 3.67157 11.6716 3 12.5 3H19.5C20.3284 3 21 3.67157 21 4.5C21 5.17932 20.5484 5.75317 19.9291 5.93774C19.6526 6.02012 19.3595 6.04161 19.0829 6.12355L16.0299 7.02792L12.9108 6.11964C12.6383 6.04028 12.3501 6.01951 12.0777 5.93974C11.4549 5.75736 11 5.1818 11 4.5Z" fill="#FFB02E" />
      <path className="mascot-body" d="M22.05 30H9.95C6.66 30 4 27.34 4 24.05V12.03C4 8.7 6.7 6 10.03 6H21.98C25.3 6 28 8.7 28 12.03V24.06C28 27.34 25.34 30 22.05 30Z" fill="#CDC4D6" />
      <path className="mascot-face" d="M9.24738 18.5H22.7526C25.0822 18.5 27 16.581 27 14.25C27 11.909 25.0922 10 22.7526 10H9.24738C6.9078 10 5 11.909 5 14.25C5 16.591 6.9078 18.5 9.24738 18.5Z" fill="#212121" />
      <path className="mascot-mouth" d="M13.4718 26H18.5282C19.3392 26 20 25.3265 20 24.5C20 23.6735 19.3392 23 18.5282 23H13.4718C12.6608 23 12 23.6735 12 24.5C12 25.3265 12.6608 26 13.4718 26Z" fill="#212121" />
      <g className="mascot-eyes" ref={eyesRef}>
        <path className="mascot-eye" d="M10.25 12C9.55964 12 9 12.5596 9 13.25V15.75C9 16.4404 9.55964 17 10.25 17C10.9404 17 11.5 16.4404 11.5 15.75V13.25C11.5 12.5596 10.9404 12 10.25 12Z" fill="#00A6ED" />
        <path className="mascot-eye" d="M21.75 12C21.0596 12 20.5 12.5596 20.5 13.25V15.75C20.5 16.4404 21.0596 17 21.75 17C22.4404 17 23 16.4404 23 15.75V13.25C23 12.5596 22.4404 12 21.75 12Z" fill="#00A6ED" />
      </g>
      <g className="mascot-sparkles" aria-hidden="true">
        <circle cx="6" cy="6" r="1.2" fill="#FFB02E" />
        <circle cx="26.5" cy="5" r="1" fill="#38E8FF" />
        <circle cx="27.5" cy="27" r="1.1" fill="#FFB02E" />
      </g>
    </svg>
  );
}
