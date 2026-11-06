/**
 * PHASE 5A engine tests: the export path is PptxGenJS (editable content,
 * native charts, objectName ids) + @office-kit/pptx native motion. Tests
 * load the produced package BACK through office-kit and assert the same
 * MotionPlan semantics the preview consumes — transitions, animations,
 * structural Morph pairs and crop/geometry state — plus boundary validation
 * (finding 8) and a guard that the retired Python injector never returns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { unzipSync } from "fflate";
import {
  loadPresentation, validatePresentation, getSlides, getSlideTransition, getSlideAnimations,
  findShapeByName, getShapeImageCrop, getShapeCustomGeometry,
} from "@office-kit/pptx";
import { buildPptx } from "@/lib/documents/pptxEngine";
import { normalizePptx, pptxSpecIssues } from "@/lib/documents/schemas";
import { buildMotionPlan, TRANSITION_MS } from "@/lib/documents/pptxMotion";
import { inspectPackageSlides, motionPlanDiff, planClickReveals } from "@/lib/documents/pptxPackageMotion";

const spec = {
  filename: "Q4 Product Launch",
  title: "Q4 Product Launch",
  tier: "insane",
  theme: { bg: "#0A0A0A", accent: "#38E8FF", positive: "#22C55E" },
  slides: [
    { layout: "title", title: "Q4 Product Launch", subtitle: "Ship the future", bullets: [], stats: [] },
    { layout: "stats", title: "Momentum", subtitle: "", bullets: [], stats: [
      { label: "Revenue", value: "$4.2M" }, { label: "Growth", value: "38%", suffix: " YoY" }, { label: "NPS", value: "72" },
    ] },
    { layout: "spotlight", title: "Flagship Feature", subtitle: "", bullets: ["Realtime sync", "Offline first"], stats: [] },
    { layout: "chart", title: "Adoption", subtitle: "", bullets: [], stats: [], chart: { type: "line", categories: ["Jul", "Aug", "Sep"], series: [{ name: "DAU", data: [120, 340, 890] }] } },
    { layout: "bullets", title: "Roadmap", subtitle: "", bullets: ["Mobile", "API", "Enterprise"], stats: [] },
  ],
};

const slideXmls = (buffer: Buffer) => {
  const zip = unzipSync(new Uint8Array(buffer));
  const names = Object.keys(zip)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  return { zip, xmls: names.map((n) => new TextDecoder().decode(zip[n])) };
};

describe("pptx engine (PHASE 5A: native motion via @office-kit/pptx)", () => {
  it("emits native Morph transitions + animations + structural pairs, and the package re-validates", async () => {
    const out = await buildPptx(spec);
    expect(out.filename).toBe("Q4_Product_Launch.pptx");
    expect(out.tier).toBe("insane");

    const pres = await loadPresentation(new Uint8Array(out.buffer));
    const pSlides = getSlides(pres);
    expect(pSlides.length).toBe(5);
    expect(validatePresentation(pres).filter((v) => v.severity === "error")).toEqual([]);

    // Slide 0 never transitions; every incoming INSANE slide enters with Morph.
    expect(getSlideTransition(pSlides[0])?.effect ?? "none").not.toBe("morph");
    for (let i = 1; i < pSlides.length; i++) {
      expect(getSlideTransition(pSlides[i])?.effect).toBe("morph");
    }

    // Animations come from the ONE plan: entrances, emphasis, click reveals.
    const effects = (i: number) => getSlideAnimations(pSlides[i]).map((a) => a.effect);
    expect(effects(0)).toContain("fadeIn");           // title entrance
    expect(effects(1)).toEqual(expect.arrayContaining(["fadeIn", "flyIn", "growShrink"])); // cards + values
    expect(effects(2)).toContain("fadeIn");           // title + bullets (click build)
    expect(getSlideAnimations(pSlides[4]).some((a) => a.start === "click")).toBe(true);

    // Stable objectName ids (no counter mirroring).
    expect(findShapeByName(pSlides[0], "!!Title_s0")).not.toBeNull();
    expect(findShapeByName(pSlides[1], "!!StatCard_s1_0")).not.toBeNull();
    expect(findShapeByName(pSlides[1], "!!StatValue_s1_2")).not.toBeNull();
    expect(findShapeByName(pSlides[2], "!!Bullets_s2")).not.toBeNull();
    expect(findShapeByName(pSlides[2], "!!SpotlightCard_s2")).not.toBeNull();

    // Structural Morph pairs: identical names on BOTH slides of each pair.
    for (let i = 1; i < 5; i++) {
      expect(findShapeByName(pSlides[i - 1], `!!SplitMask_s${i}`)).not.toBeNull();
      expect(findShapeByName(pSlides[i], `!!SplitMask_s${i}`)).not.toBeNull();
    }
    const statEntry = findShapeByName(pSlides[0], "!!StatFill_s1");
    const statTarget = findShapeByName(pSlides[1], "!!StatFill_s1");
    expect(statEntry).not.toBeNull();
    expect(statTarget).not.toBeNull();
    // Crop-fill: 100% crop on the entry instance, full image on the target.
    expect(getShapeImageCrop(statEntry!)).toEqual({ left: 1, top: 1, right: 1, bottom: 1 });
    expect(getShapeImageCrop(statTarget!)).toBeNull();

    const spot2 = findShapeByName(pSlides[2], "!!SpotlightOverlay_s2");
    const spot3 = findShapeByName(pSlides[3], "!!SpotlightOverlay_s2");
    expect(spot2).not.toBeNull();
    expect(spot3).not.toBeNull();
    expect(getShapeCustomGeometry(spot2!)?.paths[0].commands.length).toBe(10); // punched: 5+5 (close x2)

    // split-mask entry rotation 270° lives on the previous slide.
    const { zip, xmls } = slideXmls(out.buffer);
    expect(xmls[0]).toContain('rot="16200000"');
    expect(xmls[0]).toContain("16200000"); // entry split-mask rotation
    expect(xmls[2]).toContain("<a:custGeom");
    expect((xmls[2].match(/<a:close\s*\/?>/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(xmls[0]).toMatch(/srcRect[^>]*100000/); // crop entry in the XML

    // Charts are NATIVE (editable) — a chart part, not a rasterized picture.
    expect(Object.keys(zip).some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true);
    const media = Object.keys(zip).filter((n) => n.startsWith("ppt/media/"));
    expect(media.length).toBeGreaterThanOrEqual(1); // gradient artwork; NO chart raster
  }, 120000);

  it("normal tier: Morph only on morphGroup pairs + a shared band shape; fade elsewhere", async () => {
    const out = await buildPptx({
      title: "Group demo", tier: "normal",
      theme: { bg: "#0A0A0A", accent: "#38E8FF", positive: "#22C55E" },
      slides: [
        { layout: "title", title: "One", morphGroup: "heroX" },
        { layout: "hero", title: "Two", morphGroup: "heroX", stats: [{ label: "X", value: "9" }] },
        { layout: "bullets", title: "Three", bullets: ["a"] },
      ],
    });
    const pres = await loadPresentation(new Uint8Array(out.buffer));
    const pSlides = getSlides(pres);
    expect(getSlideTransition(pSlides[1])?.effect).toBe("morph");
    expect(getSlideTransition(pSlides[2])?.effect).toBe("fade");
    // The model's morphGroup promise is honored by an actual shared object.
    expect(findShapeByName(pSlides[0], "!!MorphBand_heroX")).not.toBeNull();
    expect(findShapeByName(pSlides[1], "!!MorphBand_heroX")).not.toBeNull();
    expect(findShapeByName(pSlides[2], "!!MorphBand_heroX")).toBeNull();
    // No INSANE structural machinery in normal tier.
    expect(findShapeByName(pSlides[1], "!!StatFill_s1")).toBeNull();
    expect(findShapeByName(pSlides[0], "!!SplitMask_s1")).toBeNull();
  }, 60000);

  it("reducedMotion: Morph is replaced by fade and every step/structural pair is dropped", async () => {
    const out = await buildPptx({ ...spec, reducedMotion: true });
    const pres = await loadPresentation(new Uint8Array(out.buffer));
    const pSlides = getSlides(pres);
    for (let i = 1; i < pSlides.length; i++) {
      expect(getSlideTransition(pSlides[i])?.effect).toBe("fade");
    }
    for (let i = 0; i < pSlides.length; i++) {
      expect(getSlideAnimations(pSlides[i])).toEqual([]);
    }
    expect(findShapeByName(pSlides[0], "!!SplitMask_s1")).toBeNull();
    expect(findShapeByName(pSlides[0], "!!StatFill_s1")).toBeNull();
    expect(findShapeByName(pSlides[2], "!!SpotlightOverlay_s2")).toBeNull();
  }, 60000);

  it('motion.reveal:"none" drops every entrance animation while the transition survives', async () => {
    const out = await buildPptx({ ...spec, slides: spec.slides.map((s) => ({ ...s, motion: { reveal: "none" } })) });
    const pres = await loadPresentation(new Uint8Array(out.buffer));
    const pSlides = getSlides(pres);
    expect(validatePresentation(pres).filter((v) => v.severity === "error")).toEqual([]);
    for (let i = 1; i < pSlides.length; i++) {
      expect(getSlideTransition(pSlides[i])?.effect).toBe("morph"); // transition is not a reveal
      expect(getSlideAnimations(pSlides[i])).toEqual([]);
    }
    expect(getSlideAnimations(pSlides[0])).toEqual([]);
    const { xmls } = slideXmls(out.buffer);
    expect(xmls.join("")).not.toContain("<p:timing");
    // Structural Morph art belongs to the TRANSITION, so it stays on purpose.
    expect(findShapeByName(pSlides[0], "!!SplitMask_s1")).not.toBeNull();
  }, 90000);

  it("transition+reveal overrides on every slide make a non-simple deck motion-free", async () => {
    // The live journey exposed this gap: the model asked for a static deck via
    // motion overrides (tier stayed "normal"). The export must then carry no
    // motion XML at all — "no motion" has to be expressible without re-tiering.
    const out = await buildPptx({
      title: "Office move", tier: "normal",
      theme: { bg: "#0A0A0A", accent: "#38E8FF", positive: "#22C55E" },
      slides: [
        { layout: "title", title: "We are moving", motion: { transition: "none", reveal: "none" } },
        { layout: "bullets", title: "Parking", bullets: ["a", "b"], motion: { transition: "none", reveal: "none" } },
        { layout: "bullets", title: "Contacts", bullets: ["c"], motion: { transition: "none", reveal: "none" } },
      ],
    });
    const { xmls } = slideXmls(out.buffer);
    const all = xmls.join("");
    expect(all).not.toContain("<p:transition");
    expect(all).not.toContain("<p:timing");
    // Inert !! ids remain (they are only motion targets); a simple tier strips them.
    expect(all).toContain('name="!!');
    const pres = await loadPresentation(new Uint8Array(out.buffer));
    expect(validatePresentation(pres).filter((v) => v.severity === "error")).toEqual([]);
    for (const s of getSlides(pres)) expect(getSlideTransition(s)?.effect ?? "none").toBe("none");
  }, 60000);

  it("the exported file carries EXACTLY the plan the preview plays (durations + click gates)", async () => {
    // The preview/export motion split was the 5A defect.  The predicates below
    // are the same ones the live journeys apply, and they were confirmed
    // against real PowerPoint slideshow playback of decks generated through
    // Ruke: EntryEffect 3954 (Morph) at p14:dur="900", 3849 (Fade) at "450",
    // and per-slide `<p:cond delay="indefinite"/>` counts equal to
    // View.GetClickCount() and consumed by View.Next() before the show moved.
    const s = normalizePptx(spec)!;
    const plan = buildMotionPlan(s);
    const out = await buildPptx(spec);
    const { xmls } = slideXmls(out.buffer);

    expect(motionPlanDiff(plan, s, xmls)).toEqual([]);

    const file = inspectPackageSlides(xmls);
    expect(file.map((f) => f.transition)).toEqual(["none", "morph", "morph", "morph", "morph"]);
    expect(file.map((f) => f.transitionMs)).toEqual([0, 900, 900, 900, 900]); // TRANSITION_MS.morph
    // One click build per planned byParagraph reveal, and only where bullets exist.
    expect(file.map((f) => f.clickBuilds)).toEqual(s.slides.map((_, i) => planClickReveals(plan, s, i)));
    expect(file.map((f) => f.clickBuilds)).toEqual([0, 0, 2, 0, 3]); // spotlight 2 bullets, roadmap 3
    expect(file.map((f) => f.animated)).toEqual(plan.map((m) => m.steps.length > 0));

    // reducedMotion replaces Morph with fade everywhere and drops every step, so
    // the fade duration must survive and no click gate may remain.
    const reduced = normalizePptx({ ...spec, reducedMotion: true })!;
    const redPlan = buildMotionPlan(reduced);
    const redOut = await buildPptx({ ...spec, reducedMotion: true });
    const { xmls: redXmls } = slideXmls(redOut.buffer);
    const redFile = inspectPackageSlides(redXmls);
    expect(motionPlanDiff(redPlan, reduced, redXmls)).toEqual([]);
    expect(redFile.map((f) => f.transition)).toEqual(["none", "fade", "fade", "fade", "fade"]);
    expect(redFile.map((f) => f.transitionMs)).toEqual([0, 450, 450, 450, 450]); // TRANSITION_MS.fade
    expect(redFile.every((f) => !f.animated && f.clickBuilds === 0)).toBe(true);
    expect(TRANSITION_MS).toEqual({ morph: 900, fade: 450 });
  }, 120000);

  it("simple tier emits no transitions, no animations and no !! names", async () => {
    const out = await buildPptx({ ...spec, tier: "simple" });
    const { xmls, zip } = slideXmls(out.buffer);
    const all = xmls.join("");
    expect(all).not.toContain("<p:transition");
    expect(all).not.toContain("<p:timing");
    expect(all).not.toContain('delay="indefinite"'); // no on-click build to gate
    expect(all).not.toContain('name="!!');
    expect(motionPlanDiff(buildMotionPlan(normalizePptx({ ...spec, tier: "simple" })!), normalizePptx({ ...spec, tier: "simple" })!, xmls))
      .toEqual([]);
    // Still a valid package with native content.
    const pres = await loadPresentation(new Uint8Array(out.buffer));
    const pSlides = getSlides(pres);
    expect(validatePresentation(pres).filter((v) => v.severity === "error")).toEqual([]);
    expect(Object.keys(zip).some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true);
  }, 60000);
});

describe("pptx spec boundary validation (finding 8)", () => {
  it("pptxSpecIssues rejects unusable specs with clear messages", () => {
    expect(pptxSpecIssues({})).toEqual(expect.arrayContaining([expect.stringContaining("slides")]));
    expect(pptxSpecIssues({ slides: "nope" }).length).toBeGreaterThan(0);
    expect(pptxSpecIssues({ slides: [] }).length).toBeGreaterThan(0);
    expect(pptxSpecIssues({ slides: [{}], theme: { bg: "not-a-color" } })
      .some((i) => i.includes("bg"))).toBe(true);
    expect(pptxSpecIssues({ slides: [{ motion: { transition: "explode" } }] })
      .some((i) => i.includes("motion.transition"))).toBe(true);
    expect(pptxSpecIssues({ slides: [{ motion: { reveal: "sometimes" } }] })
      .some((i) => i.includes("motion.reveal"))).toBe(true);
    expect(pptxSpecIssues({ slides: [{ layout: "bullets", bullets: ["x"], motion: { transition: "none", reveal: "none" } }] }))
      .toEqual([]);
    expect(pptxSpecIssues({ slides: Array.from({ length: 61 }, () => ({ layout: "bullets" })) })
      .some((i) => /slide/i.test(i))).toBe(true);
    expect(pptxSpecIssues({ slides: [{ layout: "bullets", bullets: Array(61).fill("x") }] }).length).toBeGreaterThan(0);
    expect(pptxSpecIssues(spec)).toEqual([]);
  });

  it("buildPptx refuses an unvalidated spec instead of trusting a truthy slides array", async () => {
    await expect(buildPptx({ slides: "nope" })).rejects.toThrow(/did not validate/);
    await expect(buildPptx({ theme: { bg: "#GGGGGG" }, slides: [{ layout: "bullets", bullets: ["x"] }] }))
      .rejects.toThrow(/did not validate/);
  });

  it("the retired Python injector is gone and the engine spawns nothing", () => {
    const src = readFileSync(join(process.cwd(), "lib", "documents", "pptxEngine.ts"), "utf8");
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("pptx_morph_injector");
    expect(src).not.toContain("execFile");
  });
});
