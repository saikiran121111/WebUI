"use client";
/**
 * PPTX fence (PHASE 5A): the downloaded file carries NATIVE PowerPoint
 * motion (Morph transitions, entrance/emphasis animations, click builds —
 * see lib/documents/pptxEngine.ts). The in-chat preview is driven by the
 * SAME MotionPlan from lib/documents/pptxMotion: identical transitions,
 * entrance schedule and per-paragraph click reveals, so what you watch in
 * the browser is what PowerPoint plays. Run Slideshow opens a fullscreen
 * player (arrows advance builds then slides / Esc exits).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { normalizePptx, safeName } from "../../lib/documents/schemas";
import { buildMotionPlan, clickRevealCount } from "../../lib/documents/pptxMotion";
import PptxSlideBody from "./PptxSlideBody";
import DocumentCard, { FenceBroken, FencePending } from "./DocumentCard";

const EASE = [0.22, 1, 0.36, 1] as const;

export default function PptxBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const reduced = useReducedMotion();
  const spec = useMemo(() => {
    try {
      return normalizePptx(JSON.parse(source));
    } catch {
      return null;
    }
  }, [source]);
  const plan = useMemo(() => (spec ? buildMotionPlan(spec) : []), [spec]);

  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState(1);
  const [show, setShow] = useState(false);
  const [revealed, setRevealed] = useState(0); // slideshow click-build progress
  const showRef = useRef<HTMLDivElement>(null);

  const go = useCallback((d: number, n: number) => {
    setDir(d);
    setIdx((i) => Math.max(0, Math.min(n - 1, d === 0 ? n : i + d)));
  }, []);

  // PowerPoint semantics: while a slide has pending click-builds, a click /
  // → / space reveals the next paragraph before it advances the slide.
  const advance = useCallback(() => {
    const n = spec?.slides.length ?? 0;
    if (!spec || !n) return;
    const sd = spec.slides[Math.min(idx, n - 1)];
    const total = clickRevealCount(plan, idx, sd);
    if (show && revealed < total) {
      setRevealed((r) => r + 1);
      return;
    }
    go(1, n);
  }, [spec, plan, idx, show, revealed, go]);

  useEffect(() => setRevealed(0), [idx]);

  // True fullscreen: the slideshow layer takes the whole screen via the
  // native Fullscreen API. If the grant fails, the fixed-inset CSS layer
  // (.pptx-show) is the fallback — and it must NOT be torn down by a
  // fullscreenchange that never belonged to us (exit only when native FS
  // was actually granted and then left; Esc in CSS mode is handled by keys).
  useEffect(() => {
    if (!show) return;
    const el = showRef.current;
    let native = false;
    if (el && !document.fullscreenElement) {
      Promise.resolve(el.requestFullscreen?.()).then(() => { native = true; }).catch(() => { /* CSS fallback */ });
    }
    const onFsChange = () => { if (native && !document.fullscreenElement) setShow(false); };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [show]);

  useEffect(() => {
    if (!show) return;
    const n = spec?.slides.length ?? 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShow(false);
      else if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") advance();
      else if (e.key === "ArrowLeft") go(-1, n);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, spec, advance, go]);

  if (streaming) return <FencePending label="PPTX" />;
  if (!spec) return <FenceBroken label="pptx" />;

  const n = spec.slides.length;
  const i = Math.min(idx, n - 1);
  const slide = spec.slides[i];
  const prev = i > 0 ? spec.slides[i - 1] : null;
  // Shared-element morph only where the plan actually morphs AND the pair
  // shares a morphGroup — exactly what the export renders as a band object.
  const morphing = !reduced && plan[i]?.transition === "morph" && !!slide.morphGroup && prev?.morphGroup === slide.morphGroup;
  const showDur = reduced ? 0.2 : plan[i]?.transition === "morph" ? 0.9 : plan[i]?.transition === "fade" ? 0.45 : 0.25;
  const filename = safeName(spec.filename) + ".pptx";

  const slideshow = (
    <AnimatePresence>
      {show && (
        <motion.div
          ref={showRef}
          className="pptx-show"
          data-testid="pptx-slideshow"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          onClick={advance}
          role="dialog"
          aria-label="Presentation slideshow"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={i}
              className="pptx-show-stage"
              initial={{ x: dir >= 0 ? "6%" : "-6%", opacity: 0, scale: 0.985 }}
              animate={{ x: 0, opacity: 1, scale: 1 }}
              exit={{ x: dir >= 0 ? "-6%" : "6%", opacity: 0, scale: 0.985 }}
              transition={{ duration: morphing ? 0.9 : showDur, ease: EASE }}
            >
              {morphing && (
                <motion.div layoutId={"pptx-morph-" + slide.morphGroup} className="pptx-morph-accent" style={{ background: spec.theme.accent }} />
              )}
              <PptxSlideBody slide={slide} idx={i} theme={spec.theme} plan={plan} revealed={revealed} clickBuilt />
            </motion.div>
          </AnimatePresence>
          <div className="pptx-show-hud">
            <span>{i + 1} / {n}</span>
            <span>← → navigate · Esc exit</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <DocumentCard
      badge="PPTX"
      filename={filename}
      endpoint="/api/documents/pptx"
      spec={spec}
      testId="pptx-block"
      hideFullscreen
      actions={
        <button type="button" className="doc-card-btn" onClick={() => { setIdx(0); setRevealed(0); setShow(true); }} aria-label="Run Slideshow">
          Run Slideshow
        </button>
      }
    >
      <div className="pptx-stage-wrap" data-testid="pptx-preview">
        {/* Clip box: fast next/prev clicks make the exiting slide slide past
            the stage edge — without this clip its text flickers outside. */}
        <div className="pptx-stage-clip">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={i}
              className="pptx-stage"
              initial={{ x: dir >= 0 ? 48 : -48, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: dir >= 0 ? -48 : 48, opacity: 0 }}
              transition={{ duration: reduced ? 0.15 : 0.35, ease: EASE }}
            >
              <PptxSlideBody slide={slide} idx={i} theme={spec.theme} plan={plan} revealed={slide.bullets.length} clickBuilt={false} />
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="pptx-nav">
          <button type="button" onClick={() => go(-1, n)} disabled={i === 0} aria-label="Previous slide">‹</button>
          <span className="pptx-dots" role="tablist" aria-label="Slides">
            {spec.slides.map((_, k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={k === i}
                aria-label={"Slide " + (k + 1)}
                className={"pptx-dot" + (k === i ? " pptx-dot--active" : "")}
                onClick={() => { setDir(k > i ? 1 : -1); setIdx(k); }}
              />
            ))}
          </span>
          <button type="button" onClick={() => go(1, n)} disabled={i >= n - 1} aria-label="Next slide">›</button>
        </div>
      </div>
      {slideshow}
    </DocumentCard>
  );
}
