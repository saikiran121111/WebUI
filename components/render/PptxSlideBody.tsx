"use client";
/**
 * Slide content for the PPTX preview (split out of PptxBlock per the <300
 * line rule). PHASE 5A: motion here is PLAN-DRIVEN — it consumes the same
 * MotionPlan (lib/documents/pptxMotion) that the export writes natively:
 * entrance effects/delays come from stepSchedule, bullet click-builds gate
 * on `revealed`, and reduced-motion collapses everything to a fade.
 */
import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { PptxSpec, PptxSlide } from "../../lib/documents/schemas";
import { chartSvg } from "../../lib/documents/chartHtml";
import { useTweenedNumbers } from "../../hooks/useTweenedNumbers";
import { OBJ, type MotionPlan, type MotionStep } from "../../lib/documents/pptxMotion";

const EASE = [0.22, 1, 0.36, 1] as const;

export default function PptxSlideBody({
  slide, idx, theme, plan, revealed, clickBuilt,
}: {
  slide: PptxSlide;
  idx: number;
  theme: PptxSpec["theme"];
  plan: MotionPlan;
  /** How many click-build paragraphs are visible (ignored when !clickBuilt). */
  revealed: number;
  /** true = slideshow mode (click builds gated); false = mini stage (auto-full). */
  clickBuilt: boolean;
}) {
  const reduced = useReducedMotion();
  const statTargets = useMemo(
    () => slide.stats.map((st) => { const n = parseFloat(st.value.replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; }),
    [slide.stats],
  );
  const tweened = useTweenedNumbers(statTargets, reduced ? 0 : 700);

  const steps = plan[idx]?.steps ?? [];
  const schedule = useMemo(() => {
    const delays = new Map<string, number>();
    let t = 0;
    for (const st of steps) {
      if (st.start === "click") continue;
      if (st.start === "afterPrevious") t += delays.size ? 80 : 0;
      delays.set(st.objectName, t);
      t += st.durationMs;
    }
    return delays;
  }, [steps]);

  /** Preview approximation of a native step: hidden state by effect kind,
   * delay from the shared schedule. Click-build steps are gated manually. */
  const motionFor = (name: string) => {
    const st = steps.find((s) => s.objectName === name && s.start !== "click");
    if (!st) return {};
    const hidden = hiddenFor(st);
    const animate = st.effect === "pulse"
      ? { opacity: 1, scale: [1, 1 + ((st.scalePercent ?? 120) - 100) / 200, 1] }
      : { opacity: 1, ...("y" in hidden ? { y: 0 } : {}), ...("scale" in hidden ? { scale: 1 } : {}) };
    return reduced ? {} : {
      initial: hidden,
      animate,
      transition: { duration: st.durationMs / 1000, delay: (schedule.get(name) ?? 0) / 1000, ease: EASE },
    };
  };

  const title = (cls: string, color?: string) => (
    <motion.h2 {...motionFor(OBJ.title(idx))} className={cls} style={color ? { color } : undefined}>{slide.title}</motion.h2>
  );
  const bullets = (cls: string) => {
    const clickStep = steps.find((s) => s.objectName === OBJ.bullets(idx) && s.start === "click" && s.build === "byParagraph");
    return (
      <motion.ul {...motionFor(OBJ.bullets(idx))} className={cls}>
        {slide.bullets.map((b, i) => {
          if (!clickStep || !clickBuilt) return <li key={i}>{b}</li>;
          return (
            <motion.li
              key={i}
              initial={{ opacity: 0, y: 12 }}
              animate={i < revealed ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
              transition={{ duration: reduced ? 0.01 : 0.4, ease: EASE }}
            >
              {b}
            </motion.li>
          );
        })}
      </motion.ul>
    );
  };

  return (
    <div className={"pptx-slide pptx-slide--" + slide.layout} style={{ background: theme.bg }}>
      {(slide.layout === "title" || slide.layout === "hero" || slide.layout === "spotlight") && (
        <div className="pptx-hero">
          {slide.subtitle && <div className="pptx-kicker" style={{ color: theme.accent }}>{slide.subtitle}</div>}
          {title("pptx-big", slide.layout === "spotlight" ? theme.accent : undefined)}
          {slide.layout === "hero" && slide.stats[0] && (
            <div className="pptx-big" style={{ color: theme.accent }} {...motionFor(OBJ.heroNumber(idx))}>
              {slide.stats[0].value}{slide.stats[0].suffix ?? ""}
            </div>
          )}
          {slide.bullets.length > 0 && bullets("pptx-bullets")}
        </div>
      )}
      {slide.layout === "stats" && (
        <div className="pptx-stats">
          <motion.h3 {...motionFor(OBJ.title(idx))} className="pptx-h">{slide.title}</motion.h3>
          <div className="pptx-stat-row">
            {slide.stats.map((st, i) => {
              const prefix = /^[$€£₹]/.test(st.value) ? st.value[0] : "";
              const suffix = (st.suffix ?? "") + (/[%x+]/.test(st.value.trim().slice(-1)) ? st.value.trim().slice(-1) : "");
              return (
                <motion.div key={i} {...motionFor(OBJ.statCard(idx, i))} className="pptx-stat-card">
                  <motion.div {...motionFor(OBJ.statValue(idx, i))} className="pptx-stat-value" style={{ color: theme.positive }}>
                    {prefix}{(tweened[i] ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}{suffix}
                  </motion.div>
                  <div className="pptx-stat-label">{st.label}</div>
                </motion.div>
              );
            })}
          </div>
          {slide.subtitle && <p className="pptx-sub">{slide.subtitle}</p>}
        </div>
      )}
      {slide.layout === "split" && (
        <div className="pptx-split">
          <div>
            {title("pptx-h")}
            {slide.subtitle && <p className="pptx-sub">{slide.subtitle}</p>}
            {slide.bullets.length > 0 && bullets("pptx-bullets")}
          </div>
          {slide.chart && (
            <div className="pptx-chart" dangerouslySetInnerHTML={{ __html: chartSvg(slide.chart, { width: 460, height: 300, theme: "dark" }) }} />
          )}
        </div>
      )}
      {slide.layout === "chart" && (
        <div className="pptx-chart-slide">
          {title("pptx-h")}
          {slide.subtitle && <p className="pptx-sub">{slide.subtitle}</p>}
          {slide.chart && (
            <div className="pptx-chart" dangerouslySetInnerHTML={{ __html: chartSvg(slide.chart, { width: 640, height: 340, theme: "dark" }) }} />
          )}
        </div>
      )}
      {slide.layout === "table" && (
        <div className="pptx-table-slide">
          {title("pptx-h")}
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
          {title("pptx-h")}
          {slide.subtitle && <p className="pptx-sub">{slide.subtitle}</p>}
          {slide.bullets.length > 0 && bullets("pptx-bullets")}
        </div>
      )}
    </div>
  );
}

function hiddenFor(st: MotionStep) {
  switch (st.effect) {
    case "flyIn": return { opacity: 0, y: 28 };
    case "riseUpIn": return { opacity: 0, y: 44 };
    case "zoomIn": return { opacity: 0, scale: 0.6 };
    case "growShrink": return { opacity: 0, scale: 0.5 };
    case "pulse": return { opacity: 0 };
    default: return { opacity: 0 };
  }
}
