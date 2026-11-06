/**
 * PPTX engine (PHASE 5A): editable content built with PptxGenJS (native
 * charts via addChart, stable semantic object ids via the public
 * `objectName` option), then a NATIVE motion pass by @office-kit/pptx that
 * applies the ONE plan from lib/documents/pptxMotion — the same plan the
 * in-chat preview runs. No temp files, no Python, no shape-name guessing.
 *
 * The three viral patterns (tier "insane") map onto supported primitives:
 *  1. split-mask entry   — identically-named accent rects, rotate 270°
 *                          off-canvas → 0° on-canvas (Morph interpolates rot)
 *  2. stat crop-fill     — the SAME image paired across slides, cropped
 *                          100% → 0% with setShapeImageCrop (srcRect morph)
 *  3. moving spotlight   — identically-named full-slide overlays whose
 *                          punched cutout (outer + reversed-inner custGeom
 *                          subpaths) morphs to a 108% panned window
 * morphGroup pairs carry an explicit shared accent band so the model's
 * morphGroup promise is honored by the export, not just the preview.
 */
import PptxGenJS from "pptxgenjs";
import {
  loadPresentation, savePresentation, validatePresentation, getSlides,
  setSlideTransition, setShapeAnimation, setShapeImageCrop, setShapeCustomGeometry,
  findShapeByName,
  type CustomGeometryInput,
} from "@office-kit/pptx";
import { normalizePptx, pptxSpecIssues, type PptxSpec, type PptxSlide } from "./schemas";
import { renderChartPng, safeName } from "./pdfEngine";
import { buildMotionPlan, OBJ, TRANSITION_MS, type MotionPlan } from "./pptxMotion";

const W = 13.333;
const H = 7.5;
const EMU = 914400; // inches -> EMU
const hex = (c: string) => c.replace(/^#/, "").toUpperCase();

export interface PptxBuildResult { buffer: Buffer; filename: string; contentType: string; tier: string }

function gradientPngBase64(accent: string): Promise<string> {
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:#0D0D0D}</style></head><body><div id="chart-root" style="width:800px;height:450px;background:linear-gradient(135deg,${accent} 0%,${accent}55 45%,#0D0D0D 100%)"></div></body></html>`;
  return renderChartPng(html, { width: 800, height: 450, scale: 2 }).then((s) => "image/png;base64," + s.buffer.toString("base64"));
}

/** Full-slide overlay with a punched window: outer CW subpath + inner
 * CCW subpath (the winding-hole technique the old injector used, now
 * written through the library's custom-geometry API). */
function punchedGeometry(win: { x: number; y: number; w: number; h: number }): CustomGeometryInput {
  const pw = Math.round(W * EMU);
  const ph = Math.round(H * EMU);
  return {
    paths: [{
      w: pw, h: ph, stroke: false,
      commands: [
        { kind: "moveTo", pt: { x: 0, y: 0 } }, { kind: "lnTo", pt: { x: pw, y: 0 } },
        { kind: "lnTo", pt: { x: pw, y: ph } }, { kind: "lnTo", pt: { x: 0, y: ph } }, { kind: "close" },
        { kind: "moveTo", pt: { x: win.x, y: win.y + win.h } }, { kind: "lnTo", pt: { x: win.x + win.w, y: win.y + win.h } },
        { kind: "lnTo", pt: { x: win.x + win.w, y: win.y } }, { kind: "lnTo", pt: { x: win.x, y: win.y } }, { kind: "close" },
      ],
    }],
  };
}

const spotlightWin = (x: number, y: number, w: number, h: number) => ({
  x: Math.round(x * EMU), y: Math.round(y * EMU), w: Math.round(w * EMU), h: Math.round(h * EMU),
});

export async function buildPptx(rawSpec: unknown): Promise<PptxBuildResult> {
  // Normalize at the engine boundary too (finding 8): never trust a truthy
  // `slides` array; validate colors/motion/bounds and fail with a clear 4xx.
  const issues = pptxSpecIssues(rawSpec);
  if (issues.length) throw new Error("PPTX spec did not validate: " + issues.slice(0, 4).join("; "));
  const spec: PptxSpec = normalizePptx(rawSpec)!;

  const animated = spec.tier !== "simple";
  // simple tier: no internal !! ids at all (plain selection-pane names).
  const nm = (n: string) => (animated ? n : undefined);
  const insane = spec.tier === "insane" && !spec.reducedMotion;
  const bg = hex(spec.theme.bg);
  const accent = hex(spec.theme.accent);
  const positive = hex(spec.theme.positive);

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WEBUI169", width: W, height: H });
  pptx.layout = "WEBUI169";
  pptx.author = "Local AI WebUI";
  pptx.title = spec.title;

  const plan: MotionPlan = buildMotionPlan(spec);
  const morphIn = (i: number) => i > 0 && plan[i].transition === "morph";
  const groupPair = (i: number) => !!spec.slides[i]?.morphGroup && spec.slides[i - 1]?.morphGroup === spec.slides[i]?.morphGroup;

  const slides = spec.slides.map((sd) => {
    const s = pptx.addSlide();
    s.background = { color: bg };
    return s;
  });
  const S = (i: number) => slides[i];

  const titleBar = (i: number, sd: PptxSlide) => {
    if (!sd.title) return;
    S(i).addText(sd.title, { x: 0.7, y: 0.55, w: W - 1.4, h: 1.0, fontSize: 30, bold: true, color: "FFFFFF", fontFace: "Segoe UI", objectName: nm(OBJ.title(i)) });
    if (sd.subtitle) S(i).addText(sd.subtitle, { x: 0.7, y: 1.45, w: W - 1.4, h: 0.5, fontSize: 15, color: "A1A1AA", fontFace: "Segoe UI", objectName: nm(OBJ.subtitle(i)) });
  };

  const chartData = (c: NonNullable<PptxSlide["chart"]>) =>
    c.series.map((s) => ({ name: s.name, labels: c.categories, values: c.categories.map((_, k) => Number(s.data[k]) || 0) }));

  const addNativeChart = (i: number, sd: PptxSlide) => {
    const c = sd.chart!;
    const type = c.type === "line" ? pptx.ChartType.line : c.type === "pie" ? pptx.ChartType.pie : c.type === "donut" ? pptx.ChartType.doughnut : c.type === "area" ? pptx.ChartType.area : pptx.ChartType.bar;
    S(i).addChart(type, chartData(c) as never, {
      x: 1.6, y: 2.0, w: W - 3.2, h: 4.9,
      chartColors: [accent, positive, "F59E0B", "EF4444", "A78BFA"],
      chartArea: { fill: { color: bg } },
      catAxisLabelColor: "A1A1AA", valAxisLabelColor: "A1A1AA",
      catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
      valGridLine: { color: "262626", size: 0.5 }, catGridLine: { style: "none" },
      showLegend: c.series.length > 1 && c.type !== "pie" && c.type !== "donut",
      legendPos: "b", legendColor: "A1A1AA", legendFontSize: 11,
      barDir: "col", barGapWidthPct: 60,
      dataLabelColor: "E5E7EB", dataLabelFontSize: 10, showValue: c.type === "bar" && c.series.length === 1,
    } as never);
  };

  // Pre-render the shared gradient artwork (stat crop-fill only — charts are native now).
  const gradientData = insane && spec.slides.some((s) => s.stats.length) ? await gradientPngBase64("#" + accent) : null;

  // ---- render each slide's editable content ----
  spec.slides.forEach((sd, i) => {
    const s = S(i);
    switch (sd.layout) {
      case "title": {
        s.addText(sd.title || spec.title, { x: 0.9, y: 2.5, w: W - 1.8, h: 1.6, fontSize: 44, bold: true, color: "FFFFFF", fontFace: "Segoe UI", objectName: nm(OBJ.title(i)) });
        if (sd.subtitle) s.addText(sd.subtitle, { x: 0.9, y: 4.1, w: W - 1.8, h: 0.8, fontSize: 18, color: "A1A1AA", fontFace: "Segoe UI", objectName: nm(OBJ.subtitle(i)) });
        s.addShape(pptx.ShapeType.rect, { x: 0.9, y: 4.95, w: 3.2, h: 0.09, fill: { color: accent }, line: { type: "none" } });
        break;
      }
      case "hero": {
        titleBar(i, sd);
        const big = sd.stats[0];
        s.addText((big?.value ?? sd.title) + (big?.suffix ?? ""), { x: 0.7, y: 2.2, w: W - 1.4, h: 2.2, fontSize: 96, bold: true, color: accent, align: "center", fontFace: "Segoe UI", objectName: nm(OBJ.heroNumber(i)) });
        if (big?.label) s.addText(big.label, { x: 0.7, y: 4.6, w: W - 1.4, h: 0.6, fontSize: 18, color: "A1A1AA", align: "center" });
        break;
      }
      case "stats": {
        titleBar(i, sd);
        const n = Math.max(1, sd.stats.length);
        const cardW = (W - 1.4 - 0.3 * (n - 1)) / n;
        if (insane && gradientData && n && morphIn(i)) {
          const name = OBJ.statFill(i);
          s.addImage({ data: gradientData, x: 0.7, y: 1.9, w: W - 1.4, h: 4.9, objectName: name });
          // Entry instance on the previous slide: fully cropped (invisible),
          // the Morph interpolates srcRect 100% -> 0 during the transition.
          S(i - 1).addImage({ data: gradientData, x: 0.7, y: 1.9, w: W - 1.4, h: 4.9, objectName: name });
        }
        sd.stats.forEach((st, j) => {
          const x = 0.7 + j * (cardW + 0.3);
          s.addShape(pptx.ShapeType.roundRect, { x, y: 2.1, w: cardW, h: 3.4, rectRadius: 0.12, fill: { color: "141414" }, line: { color: "262626", width: 1 }, objectName: nm(OBJ.statCard(i, j)) });
          s.addText(st.value + (st.suffix ?? ""), { x: x + 0.2, y: 2.6, w: cardW - 0.4, h: 1.4, fontSize: 34, bold: true, color: j % 2 ? positive : accent, fontFace: "Segoe UI", objectName: nm(OBJ.statValue(i, j)) });
          s.addText(st.label, { x: x + 0.2, y: 4.2, w: cardW - 0.4, h: 0.9, fontSize: 13, color: "A1A1AA" });
        });
        break;
      }
      case "split": {
        titleBar(i, sd);
        s.addText(sd.title || "", { x: 0.7, y: 2.2, w: 5.4, h: 4.4, fontSize: 20, color: "FFFFFF", fontFace: "Segoe UI", valign: "top" });
        s.addText((sd.bullets.length ? sd.bullets : [sd.subtitle]).map((t) => ({ text: t, options: { bullet: { code: "25AA" }, color: "A1A1AA", breakLine: true } })), { x: 6.6, y: 2.2, w: W - 7.3, h: 4.4, fontSize: 15, valign: "top", lineSpacingMultiple: 1.4, objectName: nm(OBJ.bullets(i)) });
        break;
      }
      case "spotlight": {
        titleBar(i, sd);
        s.addText((sd.bullets.length ? sd.bullets : [sd.subtitle]).map((t) => ({ text: t, options: { bullet: { code: "25AA" }, color: "A1A1AA", breakLine: true } })), { x: 0.7, y: 2.0, w: 5.2, h: 4.6, fontSize: 15, valign: "top", lineSpacingMultiple: 1.4, objectName: nm(OBJ.bullets(i)) });
        s.addShape(pptx.ShapeType.roundRect, { x: 6.5, y: 1.9, w: 6.1, h: 4.7, rectRadius: 0.14, fill: { color: "141414" }, line: { color: accent, width: 1.5 }, objectName: nm(OBJ.spotlightCard(i)) });
        break;
      }
      case "chart": {
        titleBar(i, sd);
        if (sd.chart) addNativeChart(i, sd);
        break;
      }
      case "table": {
        titleBar(i, sd);
        const t = sd.table ?? { headers: [], rows: [] };
        const rows: (string | { text: string; options: Record<string, unknown> })[][] = [];
        if (t.headers.length) rows.push(t.headers.map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: { color: "1F2937" } } })));
        for (const r of t.rows) rows.push(r.map((c) => ({ text: c, options: { color: "E5E7EB", fill: { color: "141414" } } })));
        if (rows.length) s.addTable(rows as never, { x: 0.7, y: 2.0, w: W - 1.4, fontSize: 12, fontFace: "Segoe UI", border: { type: "solid", color: "262626", pt: 0.5 }, rowH: 0.42, margin: 0.08 });
        break;
      }
      case "bullets": {
        titleBar(i, sd);
        s.addText((sd.bullets.length ? sd.bullets : [sd.subtitle]).map((t) => ({ text: t, options: { bullet: { code: "25AA" }, color: "E5E7EB", breakLine: true } })), { x: 0.9, y: 2.0, w: W - 1.8, h: 4.8, fontSize: 17, valign: "top", lineSpacingMultiple: 1.5, objectName: nm(OBJ.bullets(i)) });
        break;
      }
    }
  });

  // ---- structural Morph pairs ----
  type Win = { x: number; y: number; w: number; h: number };
  const spotlightWins = new Map<string, [Win, Win]>();
  const bandsAdded = new Set<string>();
  if (animated && !spec.reducedMotion) {
    for (let i = 1; i < slides.length; i++) {
      // Explicit morphGroup pairing: one shared accent band, position varies
      // per slide so Morph visibly carries it (the preview mirrors it).
      if (morphIn(i) && groupPair(i)) {
        const name = OBJ.morphBand(spec.slides[i].morphGroup!);
        for (const idx of [i - 1, i]) {
          const key = idx + ":" + name;
          if (bandsAdded.has(key)) continue;
          bandsAdded.add(key);
          const atHead = spec.slides[idx].layout === "title" || spec.slides[idx].layout === "hero";
          slides[idx].addShape(pptx.ShapeType.rect, {
            x: atHead ? 0.9 : 0.7, y: atHead ? 4.95 : 7.08, w: atHead ? 3.2 : 2.6, h: atHead ? 0.09 : 0.06,
            fill: { color: accent }, line: { type: "none" }, objectName: name,
          });
        }
      }
      if (insane && morphIn(i)) {
        // 1. split-mask entry: rot 270° off-canvas on slide i-1 → 0° on-canvas on slide i.
        const name = OBJ.splitMask(i);
        S(i - 1).addShape(pptx.ShapeType.rect, { x: -3.2, y: 3.69, w: 6, h: 0.12, fill: { color: accent }, line: { type: "none" }, rotate: 270, objectName: name });
        S(i).addShape(pptx.ShapeType.rect, { x: 0.7, y: 7.08, w: 6, h: 0.12, fill: { color: accent }, line: { type: "none" }, rotate: 0, objectName: name });
      }
    }
    if (insane) {
      // 3. moving spotlight: punched window morphs to a 108% panned window.
      spec.slides.forEach((sd, i) => {
        if (sd.layout !== "spotlight" || i + 1 >= slides.length || !morphIn(i + 1)) return;
        const name = OBJ.spotlightOverlay(i);
        const win = spotlightWin(6.5, 1.9, 6.1, 4.7);
        const win2 = (() => {
          const cx = win.x + win.w / 2, cy = win.y + win.h / 2;
          return { x: Math.round(cx - (win.w * 1.08) / 2), y: Math.round(cy - (win.h * 1.08) / 2), w: Math.round(win.w * 1.08), h: Math.round(win.h * 1.08) };
        })();
        for (const idx of [i, i + 1]) {
          S(idx).addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: "000000", transparency: 60 }, line: { type: "none" }, objectName: name });
        }
        spotlightWins.set(name, [win, win2]);
      });
    }
  }

  // ---- write content, then the native motion pass ----
  const raw = (await pptx.write({ outputType: "nodebuffer" })) as unknown as Buffer;
  const needsMotion = animated && (plan.some((m) => m.transition !== "none" || m.steps.length > 0) || spotlightWins.size > 0);
  let buffer = raw;
  if (needsMotion) {
    const pres = await loadPresentation(raw);
    const pSlides = getSlides(pres);
    for (let i = 0; i < pSlides.length; i++) {
      const m = plan[i];
      const slide = pSlides[i];
      if (i > 0 && m.transition !== "none") {
        setSlideTransition(slide, m.transition === "morph"
          ? { effect: "morph", morphOption: "byObject", durationMs: TRANSITION_MS.morph }
          : { effect: "fade", durationMs: TRANSITION_MS.fade });
      }
      for (const st of m.steps) {
        const shape = findShapeByName(slide, st.objectName);
        if (!shape) continue; // graceful degrade if PptxGenJS did not name the shape
        setShapeAnimation(shape, {
          effect: st.effect,
          start: st.start,
          durationMs: st.durationMs,
          ...(st.build ? { build: st.build } : {}),
          ...(st.scalePercent ? { scalePercent: st.scalePercent } : {}),
          ...(st.effect === "flyIn" ? { direction: "bottom" } : {}),
        } as Parameters<typeof setShapeAnimation>[1]);
      }
    }
    // 2. stat crop-fill: the entry instance carries a 100% srcRect crop.
    spec.slides.forEach((sd, i) => {
      if (!insane || !sd.stats.length || !gradientData || !morphIn(i)) return;
      const entry = findShapeByName(pSlides[i - 1], OBJ.statFill(i));
      if (entry) setShapeImageCrop(entry, { left: 1, top: 1, right: 1, bottom: 1 });
    });
    // 3. punched spotlight cutouts.
    for (const [name, [win, win2]] of spotlightWins) {
      for (let i = 0; i < pSlides.length; i++) {
        const shape = findShapeByName(pSlides[i], name);
        if (!shape) continue;
        setShapeCustomGeometry(shape, punchedGeometry(i === spotIdxOf(name) ? win : win2));
      }
    }
    const problems = validatePresentation(pres).filter((v) => v.severity === "error");
    if (problems.length) throw new Error("PPTX package validation failed: " + problems.slice(0, 3).map((p) => p.message).join("; "));
    buffer = Buffer.from(await savePresentation(pres));
  }

  function spotIdxOf(name: string): number {
    const m = /_s(\d+)$/.exec(name);
    return m ? Number(m[1]) : -1;
  }

  return {
    buffer,
    filename: safeName(spec.filename) + ".pptx",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    tier: spec.tier,
  };
}
