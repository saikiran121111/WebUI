/**
 * PPTX engine (PHASE 4): INSANE-tier default decks (tier drops to "normal"
 * or "simple" ONLY when the user says so) built with PptxGenJS, then
 * post-processed by scripts/pptx_morph_injector.py which injects the OOXML
 * Morph transition (<p159:morph option="byObject"/>) inside
 * mc:AlternateContent, punches the moving-spotlight cutout geometry, applies
 * stat crop-fill srcRect pairs, strips empty placeholders and validates
 * every XML part. Morph pairing uses `!!`-prefixed shape names
 * (<p:cNvPr name="!!..."/>) on consecutive slides.
 *
 * The three viral patterns (tier "insane"):
 *  1. split-mask entry   — accent shape rotates 270° off-canvas → 0° on-canvas
 *  2. stat crop-fill     — paired image srcRect 100% → target (manifest)
 *  3. moving spotlight   — full-slide overlay with a punched window that
 *                          morphs to a 108% panned window on the next slide
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import PptxGenJS from "pptxgenjs";
import { normalizePptx, type PptxSpec, type PptxSlide } from "./schemas";
import { chartHtmlDocument } from "./chartHtml";
import { renderChartPng, safeName } from "./pdfEngine";

const execFileAsync = promisify(execFile);

const W = 13.333;
const H = 7.5;
const EMU = 914400; // inches -> EMU
const hex = (c: string) => c.replace(/^#/, "").toUpperCase();

interface Manifest {
  slideSize: { w: number; h: number };
  morphSlides: number[]; // 1-based slide indices receiving the morph transition
  namedShapes: { slide: number; name: string; rot?: number; srcRect?: { t: number; b: number; l: number; r: number } }[];
  spotlights: { slide: number; name: string; window: { x: number; y: number; w: number; h: number } }[];
  // pptxgenjs ignores the `name` option and emits "Text N"/"Shape N"/"Image N"
  // (Text+Shape share one per-slide counter, Image its own). The slide wrapper
  // records each `!!`-named add's generated name so the injector can rename it.
  renames: { slide: number; gen: string; name: string }[];
}

/** Wraps a pptxgenjs slide, mirroring its internal shape-naming counters. */
function wrapSlide(s: any) {
  let sh = 0, im = 0;
  const recorded: { gen: string; name: string }[] = [];
  const note = (gen: string, opts: any) => {
    const n = opts?.name;
    if (typeof n === "string" && n.startsWith("!!")) recorded.push({ gen, name: n });
  };
  return {
    raw: s,
    recorded,
    addText: (t: unknown, o: any) => { const r = s.addText(t, o); note("Text " + sh++, o); return r; },
    addShape: (k: unknown, o: any) => { const r = s.addShape(k as never, o); note("Shape " + sh++, o); return r; },
    addImage: (o: any) => { const r = s.addImage(o); note("Image " + im++, o); return r; },
    addTable: (rows: unknown, o: any) => s.addTable(rows as never, o),
  };
}

function gradientPngBase64(accent: string): Promise<string> {
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:#0D0D0D}</style></head><body><div id="chart-root" style="width:800px;height:450px;background:linear-gradient(135deg,${accent} 0%,${accent}55 45%,#0D0D0D 100%)"></div></body></html>`;
  return renderChartPng(html, { width: 800, height: 450, scale: 2 }).then((s) => "image/png;base64," + s.buffer.toString("base64"));
}

export interface PptxBuildResult { buffer: Buffer; filename: string; contentType: string; tier: string }

export async function buildPptx(rawSpec: unknown): Promise<PptxBuildResult> {
  const spec: PptxSpec = (rawSpec as PptxSpec)?.slides ? (rawSpec as PptxSpec) : normalizePptx(rawSpec)!;
  if (!spec) throw new Error("Invalid pptx spec");

  const animated = spec.tier !== "simple";
  const insane = spec.tier === "insane";
  const bg = hex(spec.theme.bg);
  const accent = hex(spec.theme.accent);
  const positive = hex(spec.theme.positive);

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WEBUI169", width: W, height: H });
  pptx.layout = "WEBUI169";
  pptx.author = "Local AI WebUI";
  pptx.title = spec.title;

  const manifest: Manifest = { slideSize: { w: Math.round(W * EMU), h: Math.round(H * EMU) }, morphSlides: [], namedShapes: [], spotlights: [], renames: [] };

  const slides = spec.slides.map((sd) => {
    const s = pptx.addSlide();
    s.background = { color: bg };
    return wrapSlide(s);
  });

  const titleBar = (i: number, sd: PptxSlide) => {
    if (!sd.title) return;
    slides[i].addText(sd.title, { x: 0.7, y: 0.55, w: W - 1.4, h: 1.0, fontSize: 30, bold: true, color: "FFFFFF", fontFace: "Segoe UI" });
    if (sd.subtitle) slides[i].addText(sd.subtitle, { x: 0.7, y: 1.45, w: W - 1.4, h: 0.5, fontSize: 15, color: "A1A1AA", fontFace: "Segoe UI" });
  };

  // Pre-render shared media
  const chartPngs = new Map<number, string>();
  for (let i = 0; i < spec.slides.length; i++) {
    const sd = spec.slides[i];
    if (sd.layout === "chart" && sd.chart) {
      const shot = await renderChartPng(chartHtmlDocument({ ...sd.chart, title: undefined }, { width: 800, height: 450, theme: "dark" }), { width: 800, height: 450, scale: 2 });
      chartPngs.set(i, "image/png;base64," + shot.buffer.toString("base64"));
    }
  }
  const gradientData = insane && spec.slides.some((s) => s.stats.length) ? await gradientPngBase64("#" + accent) : null;

  // ---- render each slide's content ----
  spec.slides.forEach((sd, i) => {
    const s = slides[i];
    switch (sd.layout) {
      case "title": {
        s.addText(sd.title || spec.title, { x: 0.9, y: 2.5, w: W - 1.8, h: 1.6, fontSize: 44, bold: true, color: "FFFFFF", fontFace: "Segoe UI" });
        if (sd.subtitle) s.addText(sd.subtitle, { x: 0.9, y: 4.1, w: W - 1.8, h: 0.8, fontSize: 18, color: "A1A1AA", fontFace: "Segoe UI" });
        s.addShape(pptx.ShapeType.rect, { x: 0.9, y: 4.95, w: 3.2, h: 0.09, fill: { color: accent }, line: { type: "none" }, ...(animated ? { name: "!!TitleAccent_s" + i } : {}) });
        break;
      }
      case "hero": {
        titleBar(i, sd);
        const big = sd.stats[0];
        s.addText((big?.value ?? sd.title) + (big?.suffix ?? ""), { x: 0.7, y: 2.2, w: W - 1.4, h: 2.2, fontSize: 96, bold: true, color: accent, align: "center", fontFace: "Segoe UI", ...(animated ? { name: "!!HeroNumber_s" + i } : {}) });
        if (big?.label) s.addText(big.label, { x: 0.7, y: 4.6, w: W - 1.4, h: 0.6, fontSize: 18, color: "A1A1AA", align: "center" });
        break;
      }
      case "stats": {
        titleBar(i, sd);
        const n = Math.max(1, sd.stats.length);
        const cardW = (W - 1.4 - 0.3 * (n - 1)) / n;
        if (insane && gradientData && n) {
          const name = "!!StatFill_s" + i;
          s.addImage({ data: gradientData, x: 0.7, y: 1.9, w: W - 1.4, h: 4.9, name });
          manifest.namedShapes.push({ slide: i + 1, name, srcRect: { t: 0, b: 0, l: 0, r: 0 } });
          if (i > 0) {
            slides[i - 1].addImage({ data: gradientData, x: 0.7, y: 1.9, w: W - 1.4, h: 4.9, name });
            manifest.namedShapes.push({ slide: i, name, srcRect: { t: 100000, b: 100000, l: 100000, r: 100000 } }); // fully cropped → invisible entry
          }
        }
        sd.stats.forEach((st, j) => {
          const x = 0.7 + j * (cardW + 0.3);
          s.addShape(pptx.ShapeType.roundRect, { x, y: 2.1, w: cardW, h: 3.4, rectRadius: 0.12, fill: { color: "141414" }, line: { color: "262626", width: 1 }, ...(animated ? { name: "!!StatCard_s" + i + "_" + j } : {}) });
          s.addText(st.value + (st.suffix ?? ""), { x: x + 0.2, y: 2.6, w: cardW - 0.4, h: 1.4, fontSize: 34, bold: true, color: j % 2 ? positive : accent, fontFace: "Segoe UI", ...(animated ? { name: "!!StatValue_s" + i + "_" + j } : {}) });
          s.addText(st.label, { x: x + 0.2, y: 4.2, w: cardW - 0.4, h: 0.9, fontSize: 13, color: "A1A1AA" });
        });
        break;
      }
      case "split": {
        titleBar(i, sd);
        s.addText(sd.title || "", { x: 0.7, y: 2.2, w: 5.4, h: 4.4, fontSize: 20, color: "FFFFFF", fontFace: "Segoe UI", valign: "top" });
        s.addText((sd.bullets.length ? sd.bullets : [sd.subtitle]).map((t) => ({ text: t, options: { bullet: { code: "25AA" }, color: "A1A1AA", breakLine: true } })), { x: 6.6, y: 2.2, w: W - 7.3, h: 4.4, fontSize: 15, valign: "top", lineSpacingMultiple: 1.4 });
        break;
      }
      case "spotlight": {
        titleBar(i, sd);
        s.addText((sd.bullets.length ? sd.bullets : [sd.subtitle]).map((t) => ({ text: t, options: { bullet: { code: "25AA" }, color: "A1A1AA", breakLine: true } })), { x: 0.7, y: 2.0, w: 5.2, h: 4.6, fontSize: 15, valign: "top", lineSpacingMultiple: 1.4 });
        s.addShape(pptx.ShapeType.roundRect, { x: 6.5, y: 1.9, w: 6.1, h: 4.7, rectRadius: 0.14, fill: { color: "141414" }, line: { color: accent, width: 1.5 }, ...(animated ? { name: "!!SpotlightCard_s" + i } : {}) });
        break;
      }
      case "chart": {
        titleBar(i, sd);
        const data = chartPngs.get(i);
        if (data) s.addImage({ data, x: 1.6, y: 2.0, w: W - 3.2, h: 4.9, ...(animated ? { name: "!!Chart_s" + i } : {}) });
        break;
      }
      case "table": {
        titleBar(i, sd);
        const t = sd.table ?? { headers: [], rows: [] };
        const rows: (string | { text: string; options: Record<string, unknown> })[][] = [];
        if (t.headers.length) rows.push(t.headers.map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: { color: "1F2937" } } })));
        for (const r of t.rows) rows.push(r.map((c) => ({ text: c, options: { color: "E5E7EB", fill: { color: "141414" } } })));
        if (rows.length) s.addTable(rows, { x: 0.7, y: 2.0, w: W - 1.4, fontSize: 12, fontFace: "Segoe UI", border: { type: "solid", color: "262626", pt: 0.5 }, rowH: 0.42, margin: 0.08, ...(animated ? { name: "!!Table_s" + i } : {}) });
        break;
      }
      case "bullets": {
        titleBar(i, sd);
        s.addText((sd.bullets.length ? sd.bullets : [sd.subtitle]).map((t) => ({ text: t, options: { bullet: { code: "25AA" }, color: "E5E7EB", breakLine: true } })), { x: 0.9, y: 2.0, w: W - 1.8, h: 4.8, fontSize: 17, valign: "top", lineSpacingMultiple: 1.5 });
        break;
      }
    }
  });

  // ---- viral pattern wiring (consecutive-slide `!!` pairs) ----
  if (animated) {
    for (let i = 1; i < slides.length; i++) {
      manifest.morphSlides.push(i + 1); // morph transition lives on the incoming slide
      if (insane || spec.slides[i].title) {
        // 1. split-mask entry: rot 270° off-canvas on slide i-1 → rot 0 on-canvas on slide i
        const name = "!!SplitMask_s" + i;
        slides[i - 1].addShape(pptx.ShapeType.rect, { x: -3.2, y: 3.69, w: 6, h: 0.12, fill: { color: accent }, line: { type: "none" }, rotate: 270, name });
        slides[i].addShape(pptx.ShapeType.rect, { x: 0.7, y: 7.08, w: 6, h: 0.12, fill: { color: accent }, line: { type: "none" }, rotate: 0, name });
        manifest.namedShapes.push({ slide: i, name, rot: 270 }, { slide: i + 1, name, rot: 0 });
      }
    }
    if (insane) {
      // 3. moving spotlight: punched overlay window morphs to a 108% panned window
      spec.slides.forEach((sd, i) => {
        if (sd.layout !== "spotlight" || i + 1 >= slides.length) return;
        const name = "!!SpotlightOverlay_s" + i;
        const win = { x: Math.round(6.5 * EMU), y: Math.round(1.9 * EMU), w: Math.round(6.1 * EMU), h: Math.round(4.7 * EMU) };
        const cx = win.x + win.w / 2, cy = win.y + win.h / 2;
        const win2 = { x: Math.round(cx - (win.w * 1.08) / 2), y: Math.round(cy - (win.h * 1.08) / 2), w: Math.round(win.w * 1.08), h: Math.round(win.h * 1.08) };
        for (const [idx, window] of [[i, win], [i + 1, win2]] as const) {
          slides[idx].addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: "000000", transparency: 60 }, line: { type: "none" }, name });
          manifest.spotlights.push({ slide: idx + 1, name, window });
        }
      });
    }
  }

  // ---- write, post-process with the morph injector, clean temps ----
  const id = crypto.randomUUID();
  const inPptx = path.join(os.tmpdir(), `deck_in_${id}.pptx`);
  const outPptx = path.join(os.tmpdir(), `deck_out_${id}.pptx`);
  const manifestPath = path.join(os.tmpdir(), `deck_manifest_${id}.json`);
  slides.forEach((s, i) => s.recorded.forEach((r) => manifest.renames.push({ slide: i + 1, gen: r.gen, name: r.name })));

  try {
    const raw = (await pptx.write({ outputType: "nodebuffer" })) as unknown as Buffer;
    await fs.writeFile(inPptx, raw);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const script = path.join(process.cwd(), "scripts", "pptx_morph_injector.py");
    try {
      await execFileAsync("python", [script, inPptx, outPptx, manifestPath], { windowsHide: true });
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      throw new Error("PPTX morph injection failed: " + ((e.stderr || "") + (e.stdout || "") || e.message || String(err)).trim());
    }
    const buffer = await fs.readFile(outPptx);
    return {
      buffer,
      filename: safeName(spec.filename) + ".pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      tier: spec.tier,
    };
  } finally {
    await Promise.all([fs.rm(inPptx, { force: true }), fs.rm(outPptx, { force: true }), fs.rm(manifestPath, { force: true })]);
  }
}
