"use client";
/**
 * PPTX fence (PHASE 4): the downloaded file carries OOXML Morph transitions
 * + viral motion patterns; the in-chat preview mirrors that motion with
 * Framer Motion — directional slide transitions, shared-element morphing for
 * slides that share a morphGroup (layoutId), and count-up stats. Run
 * Slideshow opens a 60fps fullscreen player (arrow keys / click / Esc).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { normalizePptx, PptxSlide, safeName } from "../../lib/documents/schemas";
import { chartSvg } from "../../lib/documents/chartHtml";
import { useTweenedNumbers } from "../../hooks/useTweenedNumbers";
import DocumentCard, { FenceBroken, FencePending } from "./DocumentCard";

const EASE = [0.22, 1, 0.36, 1] as const;

function SlideBody({ slide, theme }: { slide: PptxSlide; theme: { bg: string; accent: string; positive: string } }) {
  const statTargets = useMemo(
    () => slide.stats.map((st) => { const n = parseFloat(st.value.replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; }),
    [slide.stats],
  );
  const tweened = useTweenedNumbers(statTargets, 700);

  return (
    <div className={"pptx-slide pptx-slide--" + slide.layout} style={{ background: theme.bg }}>
      {(slide.layout === "title" || slide.layout === "hero" || slide.layout === "spotlight") && (
        <div className="pptx-hero">
          {slide.subtitle && <div className="pptx-kicker" style={{ color: theme.accent }}>{slide.subtitle}</div>}
          <h2 className="pptx-big" style={slide.layout === "spotlight" ? { color: theme.accent } : undefined}>{slide.title}</h2>
          {slide.bullets.length > 0 && (
            <ul className="pptx-bullets">
              {slide.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}
        </div>
      )}
      {slide.layout === "stats" && (
        <div className="pptx-stats">
          <h3 className="pptx-h">{slide.title}</h3>
          <div className="pptx-stat-row">
            {slide.stats.map((st, i) => {
              const prefix = /^[$€£₹]/.test(st.value) ? st.value[0] : "";
              const suffix = (st.suffix ?? "") + (/[%x+]/.test(st.value.trim().slice(-1)) ? st.value.trim().slice(-1) : "");
              return (
                <div key={i} className="pptx-stat-card">
                  <div className="pptx-stat-value" style={{ color: theme.positive }}>
                    {prefix}{(tweened[i] ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}{suffix}
                  </div>
                  <div className="pptx-stat-label">{st.label}</div>
                </div>
              );
            })}
          </div>
          {slide.subtitle && <p className="pptx-sub">{slide.subtitle}</p>}
        </div>
      )}
      {slide.layout === "split" && (
        <div className="pptx-split">
          <div>
            <h3 className="pptx-h">{slide.title}</h3>
            {slide.subtitle && <p className="pptx-sub">{slide.subtitle}</p>}
            <ul className="pptx-bullets">
              {slide.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
          {slide.chart && (
            <div
              className="pptx-chart"
              dangerouslySetInnerHTML={{ __html: chartSvg(slide.chart, { width: 460, height: 300, theme: "dark" }) }}
            />
          )}
        </div>
      )}
      {slide.layout === "chart" && (
        <div className="pptx-chart-slide">
          <h3 className="pptx-h">{slide.title}</h3>
          {slide.subtitle && <p className="pptx-sub">{slide.subtitle}</p>}
          {slide.chart && (
            <div
              className="pptx-chart"
              dangerouslySetInnerHTML={{ __html: chartSvg(slide.chart, { width: 640, height: 340, theme: "dark" }) }}
            />
          )}
        </div>
      )}
      {slide.layout === "table" && (
        <div className="pptx-table-slide">
          <h3 className="pptx-h">{slide.title}</h3>
          {slide.table && (
            <table className="pptx-table">
              <thead><tr>{slide.table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>{slide.table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          )}
        </div>
      )}
      {slide.layout === "bullets" && (
        <div className="pptx-bullets-slide">
          <h3 className="pptx-h">{slide.title}</h3>
          {slide.subtitle && <p className="pptx-sub">{slide.subtitle}</p>}
          <ul className="pptx-bullets">
            {slide.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function PptxBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const spec = useMemo(() => {
    try {
      return normalizePptx(JSON.parse(source));
    } catch {
      return null;
    }
  }, [source]);
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState(1);
  const [show, setShow] = useState(false);

  const go = useCallback((d: number, n: number) => {
    setDir(d);
    setIdx((i) => Math.max(0, Math.min(n - 1, d === 0 ? n : i + d)));
  }, []);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      const n = spec?.slides.length ?? 0;
      if (e.key === "Escape") setShow(false);
      else if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") go(1, n);
      else if (e.key === "ArrowLeft") go(-1, n);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, spec, go]);

  if (streaming) return <FencePending label="PPTX" chars={source.length} />;
  if (!spec) return <FenceBroken label="pptx" />;

  const n = spec.slides.length;
  const slide = spec.slides[Math.min(idx, n - 1)];
  const prev = idx > 0 ? spec.slides[idx - 1] : null;
  const morphing = !!(slide.morphGroup && prev && prev.morphGroup === slide.morphGroup);
  const filename = safeName(spec.filename) + ".pptx";

  const slideshow = (
    <AnimatePresence>
      {show && (
        <motion.div
          className="pptx-show"
          data-testid="pptx-slideshow"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          onClick={() => go(1, n)}
          role="dialog"
          aria-label="Presentation slideshow"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={idx}
              className="pptx-show-stage"
              initial={{ x: dir >= 0 ? "6%" : "-6%", opacity: 0, scale: 0.985 }}
              animate={{ x: 0, opacity: 1, scale: 1 }}
              exit={{ x: dir >= 0 ? "-6%" : "6%", opacity: 0, scale: 0.985 }}
              transition={{ duration: morphing ? 0.9 : 0.45, ease: EASE }}
            >
              {morphing && (
                <motion.div layoutId={"pptx-morph-" + slide.morphGroup} className="pptx-morph-accent" style={{ background: spec.theme.accent }} />
              )}
              <SlideBody slide={slide} theme={spec.theme} />
            </motion.div>
          </AnimatePresence>
          <div className="pptx-show-hud">
            <span>{idx + 1} / {n}</span>
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
      actions={
        <button type="button" className="doc-card-btn" onClick={() => { setIdx(0); setShow(true); }} aria-label="Run Slideshow">
          Run Slideshow
        </button>
      }
    >
      <div className="pptx-stage-wrap" data-testid="pptx-preview">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={idx}
            className="pptx-stage"
            initial={{ x: dir >= 0 ? 48 : -48, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: dir >= 0 ? -48 : 48, opacity: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
          >
            <SlideBody slide={slide} theme={spec.theme} />
          </motion.div>
        </AnimatePresence>
        <div className="pptx-nav">
          <button type="button" onClick={() => go(-1, n)} disabled={idx === 0} aria-label="Previous slide">‹</button>
          <span className="pptx-dots" role="tablist" aria-label="Slides">
            {spec.slides.map((_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === idx}
                aria-label={"Slide " + (i + 1)}
                className={"pptx-dot" + (i === idx ? " pptx-dot--active" : "")}
                onClick={() => { setDir(i > idx ? 1 : -1); setIdx(i); }}
              />
            ))}
          </span>
          <button type="button" onClick={() => go(1, n)} disabled={idx >= n - 1} aria-label="Next slide">›</button>
        </div>
      </div>
      {slideshow}
    </DocumentCard>
  );
}
