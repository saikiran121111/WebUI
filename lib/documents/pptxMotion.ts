/**
 * PPTX motion plan (PHASE 5A): the ONE normalizer whose output drives BOTH
 * the in-chat Framer preview (components/render/PptxSlideBody.tsx) and the
 * native .pptx motion pass (lib/documents/pptxEngine.ts) — identical
 * transitions, sequence and targets for preview and export.
 *
 * Object names are stable semantic ids (`!!` prefix; the `_sN` suffix is a
 * PAIR id for cross-slide Morph pairs and the owning slide index for
 * singletons). Identical names on consecutive slides become PowerPoint
 * Morph pairs; the preview consumes the same ids for shared elements.
 */
import type { PptxSpec, PptxSlide } from "./schemas";

export type MotionTransition = "morph" | "fade" | "none";
export type MotionStart = "click" | "withPrevious" | "afterPrevious";
/** Strict subset of the @office-kit/pptx AnimationEffect tokens we support. */
export type MotionEffect = "fadeIn" | "flyIn" | "zoomIn" | "riseUpIn" | "growShrink" | "pulse";

export interface MotionStep {
  objectName: string;
  effect: MotionEffect;
  start: MotionStart;
  durationMs: number;
  /** byParagraph = one reveal per paragraph (PowerPoint click builds). */
  build?: "byParagraph";
  /** growShrink emphasis scale (percent). */
  scalePercent?: number;
}

export interface SlideMotion {
  /** How this slide is entered (slide 0 is always "none"). */
  transition: MotionTransition;
  morphOption?: "byObject";
  steps: MotionStep[];
}
export type MotionPlan = SlideMotion[];

/** Transition durations (ms) written into the file and replayed by the preview.
 * ONE definition: lib/documents/pptxEngine.ts writes them, lib/documents/
 * pptxPackageMotion.ts asserts they survived export (PowerPoint read back
 * p14:dur="900" on Morph slides and "450" on fade slides). */
export const TRANSITION_MS = { morph: 900, fade: 450 } as const;

// ---- Stable object names (written by PptxGenJS `objectName`; resolved by
// the office-kit motion pass via findShapeByName and by the preview). ----
export const OBJ = {
  title: (i: number) => `!!Title_s${i}`,
  subtitle: (i: number) => `!!Sub_s${i}`,
  bullets: (i: number) => `!!Bullets_s${i}`,
  heroNumber: (i: number) => `!!HeroNumber_s${i}`,
  statCard: (i: number, j: number) => `!!StatCard_s${i}_${j}`,
  statValue: (i: number, j: number) => `!!StatValue_s${i}_${j}`,
  spotlightCard: (i: number) => `!!SpotlightCard_s${i}`,
  // Pair names repeat verbatim on BOTH slides of the pair — that is the
  // Morph pairing mechanism (proven against the installed PowerPoint).
  splitMask: (pair: number) => `!!SplitMask_s${pair}`,
  statFill: (pair: number) => `!!StatFill_s${pair}`,
  spotlightOverlay: (pair: number) => `!!SpotlightOverlay_s${pair}`,
  morphBand: (group: string) => `!!MorphBand_${group.replace(/[^A-Za-z0-9_-]/g, "")}`,
};

const BULLET_LAYOUTS = new Set(["bullets", "spotlight", "split"]);

const groupPair = (prev: PptxSlide, cur: PptxSlide) =>
  !!cur.morphGroup && prev.morphGroup === cur.morphGroup;

/**
 * One validated plan for the whole deck. Rules:
 *  - tier "simple": no transitions, no steps;
 *  - reducedMotion: Morph is replaced by fade (the deliberate compatible
 *    transition) and every step is dropped;
 *  - tier "normal": Morph only on consecutive-slide morphGroup pairs,
 *    fade elsewhere;
 *  - tier "insane": Morph on every incoming slide (the deck's signature),
 *    entrance stagger + emphasis + click reveals;
 *  - a per-slide `motion.transition` override replaces the tier default;
 *  - a per-slide `motion.reveal:"none"` drops that slide's entrance/emphasis
 *    steps (so "this slide must be completely static" is expressible without
 *    re-tiering the whole deck — the failure the live journey exposed).
 */
export function buildMotionPlan(spec: PptxSpec): MotionPlan {
  const simple = spec.tier === "simple";
  const insane = spec.tier === "insane";
  const reduced = !!spec.reducedMotion;

  return spec.slides.map((sd, i) => {
    const override = sd.motion?.transition && sd.motion.transition !== "auto" ? sd.motion.transition : undefined;
    const noReveal = sd.motion?.reveal === "none";
    let transition: MotionTransition = "none";
    if (i > 0) {
      if (simple) transition = "none";
      else if (reduced) transition = "fade";
      else if (override) transition = override;
      else if (insane) transition = "morph";
      else transition = groupPair(spec.slides[i - 1], sd) ? "morph" : "fade";
    }

    const steps: MotionStep[] = [];
    if (!simple && !reduced && !noReveal) {
      const hasBullets = BULLET_LAYOUTS.has(sd.layout) && sd.bullets.length > 0;
      // Shared across tiers: entrance of the heading + click reveal on bullets.
      if (sd.title) steps.push({ objectName: OBJ.title(i), effect: "fadeIn", start: i === 0 ? "withPrevious" : "withPrevious", durationMs: i === 0 ? 500 : 400 });
      if (hasBullets) steps.push({ objectName: OBJ.bullets(i), effect: "fadeIn", start: "click", durationMs: 400, build: "byParagraph" });
      if (insane) {
        if (sd.layout === "hero") steps.push({ objectName: OBJ.heroNumber(i), effect: "zoomIn", start: "withPrevious", durationMs: 500 });
        if (sd.layout === "stats") {
          sd.stats.slice(0, 6).forEach((_, j) =>
            steps.push({ objectName: OBJ.statCard(i, j), effect: "flyIn", start: "afterPrevious", durationMs: 300 }));
          sd.stats.slice(0, 6).forEach((_, j) =>
            steps.push({ objectName: OBJ.statValue(i, j), effect: "growShrink", start: "afterPrevious", durationMs: 600, scalePercent: 150 }));
        }
        if (sd.layout === "spotlight") steps.push({ objectName: OBJ.spotlightCard(i), effect: "zoomIn", start: "withPrevious", durationMs: 500 });
      }
    }
    return { transition, ...(transition === "morph" ? { morphOption: "byObject" as const } : {}), steps };
  });
}

/** Count of staged click-reveals the preview must gate for one slide
 * (byParagraph click builds = one reveal per bullet). */
export function clickRevealCount(plan: MotionPlan, slideIdx: number, sd: PptxSlide): number {
  const step = plan[slideIdx]?.steps.find((st) => st.start === "click");
  return step?.build === "byParagraph" ? sd.bullets.length : 0;
}

export function stepFor(plan: MotionPlan, slideIdx: number, objectName: string): MotionStep | undefined {
  return plan[slideIdx]?.steps.find((st) => st.objectName === objectName);
}

/** Preview timeline: start offset (ms) per objectName. withPrevious shares
 * the previous slot; afterPrevious queues after it; click steps are gated
 * manually and excluded. Mirrors PowerPoint's main-sequence semantics. */
export function stepSchedule(steps: MotionStep[]): Map<string, number> {
  const delays = new Map<string, number>();
  let t = 0;
  let lastStart = 0;
  for (const st of steps) {
    if (st.start === "click") continue;
    if (st.start === "afterPrevious") {
      t += delays.size ? 80 : 0; // small inter-effect gap
      delays.set(st.objectName, t);
      lastStart = t;
      t += st.durationMs;
    } else if (delays.size === 0) {
      delays.set(st.objectName, 0);
      lastStart = 0;
      t += st.durationMs;
    } else {
      delays.set(st.objectName, lastStart); // withPrevious: parallel with the previous effect
    }
  }
  return delays;
}
