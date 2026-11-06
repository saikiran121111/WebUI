/**
 * PPTX motion INSPECTION (PHASE 5A): reads motion back OUT of exported slide
 * XML so the ONE motion plan the preview plays (lib/documents/pptxMotion.ts)
 * can be compared against what the exported package actually declares.  The
 * deterministic engine tests (__tests__/documents/pptxEngine.test.ts) and the
 * model-driven journeys (tests/pptx-5a.spec.ts) share these predicates, so
 * "what counts as a click build" has one definition instead of two regex copies.
 *
 * Facts verified against the installed PowerPoint by driving real slideshow
 * playback of decks generated through Ruke (observer: mcp-out/pptx-playback.ps1;
 * a file that merely OPENS or exposes transition metadata is only a structural
 * check, which is why these predicates come from observed behaviour):
 *  - Morph lives inside an mc:Choice/p159:morph block whose mc:Fallback ALSO
 *    contains a `<p:fade/>`, so a plain fade search cannot tell them apart.
 *    PowerPoint reported SlideShowTransition.EntryEffect 3954 for Morph and
 *    3849 for Fade, per slide, matching the plan.
 *  - Animations require a `<p:timing>` tree; transitions never create one.
 *  - A by-paragraph click build is gated by `<p:cond delay="indefinite"/>`. The
 *    count per slide equalled PowerPoint's own `View.GetClickCount()` (4/5/6/4
 *    on the pitch/explainer/data-heavy slides), and `View.Next()` consumed
 *    exactly that many presses before the show position advanced — the same
 *    gating the preview performs. There is no literal `evt="onClick"` attribute.
 *  - Effect durations and the after-previous stagger survive export (400 ms
 *    entrance, 300 ms fly-in staggered at 400/700/1000/1300 ms, 600 ms
 *    grow/shrink at 1600/2200/2800/3400 ms), which is what makes the timed
 *    cascade in the real slideshow match the preview schedule.
 */
import { clickRevealCount, TRANSITION_MS, type MotionPlan } from "./pptxMotion";
import type { PptxSpec } from "./schemas";

export interface SlideMotionFile {
  transition: "morph" | "fade" | "none";
  /** p14:dur written on the slide's <p:transition>; 0 when there is none. */
  transitionMs: number;
  /** True when the slide carries a <p:timing> tree (i.e. real animations). */
  animated: boolean;
  /** On-click build gates PowerPoint will consume as presses on this slide. */
  clickBuilds: number;
}

export function inspectSlideMotion(xml: string): SlideMotionFile {
  return {
    transition: /<p159:morph/.test(xml) ? "morph" : xml.includes("<p:transition") ? "fade" : "none",
    transitionMs: Number(/<p:transition\b[^>]*p14:dur="(\d+)"/.exec(xml)?.[1] ?? 0),
    animated: xml.includes("<p:timing"),
    clickBuilds: (xml.match(/<p:cond[^>]*delay="indefinite"/g) ?? []).length,
  };
}

export const inspectPackageSlides = (slideXmls: string[]): SlideMotionFile[] => slideXmls.map(inspectSlideMotion);

/** On-click reveals the PREVIEW gates for slide `i` (same source of truth). */
export const planClickReveals = (plan: MotionPlan, spec: PptxSpec, i: number): number => clickRevealCount(plan, i, spec.slides[i]);

/**
 * Plan ↔ file diffs (empty array == the exported deck is exactly the motion the
 * preview plays).  Every divergence names the slide and both sides, because the
 * preview/export motion split was the 5A defect and a bare boolean would hide
 * which half drifted.
 */
export function motionPlanDiff(plan: MotionPlan, spec: PptxSpec, slideXmls: string[]): string[] {
  const file = inspectPackageSlides(slideXmls);
  const diffs: string[] = [];
  if (plan.length !== file.length) {
    diffs.push(`package carries ${file.length} slide(s), plan has ${plan.length}`);
    return diffs;
  }
  plan.forEach((m, i) => {
    const f = file[i];
    if (f.transition !== m.transition) diffs.push(`slide ${i + 1}: plan transition "${m.transition}" vs file "${f.transition}"`);
    if (f.animated !== m.steps.length > 0) diffs.push(`slide ${i + 1}: plan has ${m.steps.length} animation step(s), file animated=${f.animated}`);
    const plannedMs = m.transition === "none" ? 0 : TRANSITION_MS[m.transition];
    if (f.transitionMs !== plannedMs) diffs.push(`slide ${i + 1}: planned ${m.transition} transition ${plannedMs}ms, file declares p14:dur="${f.transitionMs}"`);
    const reveals = planClickReveals(plan, spec, i);
    if (f.clickBuilds !== reveals) diffs.push(`slide ${i + 1}: preview gates ${reveals} click reveal(s), file carries ${f.clickBuilds} on-click build(s) (<p:cond delay="indefinite"/>)`);
  });
  return diffs;
}

/** One-line human-readable summary of plan vs file (journey/test logs). */
export function motionSummary(plan: MotionPlan, spec: PptxSpec, slideXmls: string[]): string {
  const file = inspectPackageSlides(slideXmls);
  return `plan transitions=[${plan.map((p) => p.transition).join(",")}] steps=${plan.map((p) => p.steps.length).join("/")} ` +
    `clicks preview=${plan.map((_, i) => planClickReveals(plan, spec, i)).join("/")} file=${file.map((f) => f.clickBuilds).join("/")} ` +
    `file durs=${file.map((f) => f.transitionMs).join("/")}`;
}
