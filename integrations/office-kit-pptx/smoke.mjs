// Ruke integration smoke test for the Office Kit PPTX library (see README.md).
//
// Proves, against the REAL upstream package (no mocks, no model, no Python):
//   1. the pinned identity of @office-kit/pptx in node_modules (version+license+integrity),
//   2. the package's own engine gate (Node >= 22.18) is satisfied by this runtime,
//   3. a deck built by PptxGenJS (Ruke's editable-content writer) loads BACK through
//      the upstream API, and
//   4. Ruke's actual production motion primitives — Morph (byObject) slide
//      transition, a shape animation keyed by stable objectName, image crop-fill
//      and custom geometry — round-trip through savePresentation and the saved
//      package re-validates with zero errors.
//
// Run from anywhere:  node integrations/office-kit-pptx/smoke.mjs
// Exit 0 = all checks passed.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

const PINNED_VERSION = "0.28.0";
const PINNED_LICENSE = "MIT";
const PINNED_INTEGRITY_PREFIX = "sha512-fKdzDu2KszBYskW7JTIC9EH6d1s8Z2BQosbieu5boggmWJQWBhPyl";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const results = [];
let failed = false;
let finished = false;
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) { failed = true; finish(1); }
}
function finish(code) {
  if (finished) return;
  finished = true;
  for (const line of results) console.log(line);
  console.log(failed ? "SMOKE: FAILED" : "SMOKE: ALL GREEN");
  setTimeout(() => process.exit(code), 100);
}
setTimeout(() => { results.push("FAIL watchdog timeout"); finish(2); }, 90_000).unref?.();

// 1. package identity --------------------------------------------------------
const pkgDir = path.join(ROOT, "node_modules", "@office-kit", "pptx");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
check(`identity: @office-kit/pptx@${PINNED_VERSION} in node_modules`,
  pkg.name === "@office-kit/pptx" && pkg.version === PINNED_VERSION,
  `found ${pkg.name}@${pkg.version} (repo ${pkg.repository?.url ?? "?"})`);
check(`license: ${PINNED_LICENSE}`, pkg.license === PINNED_LICENSE
  && fs.readFileSync(path.join(pkgDir, "LICENSE"), "utf8").includes("MIT License"),
  `package.json license=${pkg.license}`);
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const locked = lock.packages?.["node_modules/@office-kit/pptx"];
check("lockfile pins the same version + integrity",
  locked?.version === PINNED_VERSION && (locked?.integrity ?? "").startsWith(PINNED_INTEGRITY_PREFIX),
  `${locked?.version} ${String(locked?.integrity).slice(0, 24)}…`);
check("sole runtime dep is fflate (Ruke already uses it)",
  Object.keys(pkg.dependencies ?? {}).length === 1 && pkg.dependencies.fflate === "^0.8.3",
  JSON.stringify(pkg.dependencies));

// 2. engine gate ------------------------------------------------------------
const [maj, min] = process.versions.node.split(".").map(Number);
const need = (pkg.engines?.node ?? ">=22.18.0").match(/(\d+)\.(\d+)/);
check(`Node engine gate (${pkg.engines?.node})`, maj > +need[1] || (maj === +need[1] && min >= +need[2]),
  `running ${process.version}`);

// 3. PptxGenJS deck -> upstream load ----------------------------------------
const require_ = createRequire(import.meta.url);
const PptxGenJS = require_("pptxgenjs");
const pptx = new PptxGenJS();
pptx.defineLayout({ name: "W", width: 13.333, height: 7.5 });
pptx.layout = "W";
const s0 = pptx.addSlide();
s0.addText("Slate One", { x: 0.7, y: 3.1, w: 11, h: 1.2, fontSize: 40, color: "FFFFFF", objectName: "!!Title_s0" });
s0.addShape(pptx.ShapeType.rect, { x: 0.9, y: 4.95, w: 3.2, h: 0.09, fill: { color: "38E8FF" }, objectName: "!!MorphBand_smoke" });
const s1 = pptx.addSlide();
s1.addText("Slate Two", { x: 0.7, y: 3.1, w: 11, h: 1.2, fontSize: 40, color: "FFFFFF", objectName: "!!Title_s1" });
s1.addShape(pptx.ShapeType.rect, { x: 0.7, y: 7.08, w: 2.6, h: 0.06, fill: { color: "38E8FF" }, objectName: "!!MorphBand_smoke" });
s1.addChart(pptx.ChartType.line, [{ name: "DAU", labels: ["Jul", "Aug"], values: [1, 3] }], { x: 1.6, y: 2, w: 10, h: 4.9 });
// The Ruke crop-fill pair: the SAME image objectName on both slides; the entry
// instance gets a 100% crop so Morph "fills" it as the slide arrives.
const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
for (const sl of [s0, s1]) sl.addImage({ data: "image/png;base64," + PNG1, x: 9.2, y: 0.9, w: 3.4, h: 1.6, objectName: "!!StatFill_smoke" });
const built = Buffer.from(await pptx.write({ outputType: "nodebuffer" }));

const { loadPresentation, savePresentation, validatePresentation, getSlides, getSlideCount,
  getSlideTransition, setSlideTransition, setShapeAnimation, getSlideAnimations,
  findShapeByName, setShapeImageCrop, getShapeImageCrop, setShapeCustomGeometry,
  getShapeCustomGeometry } = await import(pathToFileURL(path.join(pkgDir, "dist", "index.js")).href);

const pres = await loadPresentation(new Uint8Array(built));
check("loadPresentation + getSlides on a PptxGenJS package", getSlideCount(pres) === 2 && getSlides(pres).length === 2,
  `${getSlideCount(pres)} slides`);
check("native chart part survives (charts stay editable)",
  Object.keys(unzipSync(new Uint8Array(built))).some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)));

// 4. Ruke's production motion primitives, round-tripped ----------------------
const slides = getSlides(pres);
setSlideTransition(slides[1], { effect: "morph", morphOption: "byObject", durationMs: 900 });
const title = findShapeByName(slides[1], "!!Title_s1");
check("findShapeByName resolves the stable objectName Ruke writes", !!title, title ? "" : "no shape named !!Title_s1");
setShapeAnimation(title, { effect: "fadeIn", start: "withPrevious", durationMs: 400 });
const band = findShapeByName(slides[1], "!!MorphBand_smoke");
check("morph pair uses ONE name on both slides", !!findShapeByName(slides[0], "!!MorphBand_smoke") && !!band);
const entryFill = findShapeByName(slides[0], "!!StatFill_smoke");
check("crop-fill pair image present on the entry slide", !!entryFill);
setShapeImageCrop(entryFill, { left: 1, top: 1, right: 1, bottom: 1 });
setShapeCustomGeometry(band, {
  paths: [{ w: 12192000, h: 6858000, stroke: false, commands: [
    { kind: "moveTo", pt: { x: 0, y: 0 } }, { kind: "lnTo", pt: { x: 800000, y: 0 } },
    { kind: "lnTo", pt: { x: 800000, y: 800000 } }, { kind: "lnTo", pt: { x: 0, y: 800000 } },
    { kind: "close" }] }],
});

const saved = Buffer.from(await savePresentation(pres));
const pres2 = await loadPresentation(new Uint8Array(saved));
const s2 = getSlides(pres2);
check("morph (byObject) transition round-trips",
  getSlideTransition(s2[1])?.effect === "morph" && getSlideTransition(s2[1])?.morphOption === "byObject",
  JSON.stringify(getSlideTransition(s2[1])));
const rawAnims = getSlideAnimations(s2[1]);
check("shape animation round-trips (effect/start/duration survive save)",
  rawAnims.some((a) => a.effect === "fadeIn" && a.start === "withPrevious" && a.durationMs === 400),
  JSON.stringify(rawAnims.map((a) => `${a.effect}/${a.start}/${a.durationMs}ms/${JSON.stringify(a.target)}`)));
check("image crop-fill round-trips (entry cropped, target untouched)",
  JSON.stringify(getShapeImageCrop(findShapeByName(s2[0], "!!StatFill_smoke"))) === JSON.stringify({ left: 1, top: 1, right: 1, bottom: 1 })
  && getShapeImageCrop(findShapeByName(s2[1], "!!StatFill_smoke")) === null,
  `entry=${JSON.stringify(getShapeImageCrop(findShapeByName(s2[0], "!!StatFill_smoke")))} target=${JSON.stringify(getShapeImageCrop(findShapeByName(s2[1], "!!StatFill_smoke")))}`);
check("custom geometry round-trips",
  getShapeCustomGeometry(findShapeByName(s2[1], "!!MorphBand_smoke"))?.paths?.[0]?.commands?.length === 5,
  String(getShapeCustomGeometry(findShapeByName(s2[1], "!!MorphBand_smoke"))?.paths?.[0]?.commands?.length));
const errors = validatePresentation(pres2).filter((v) => v.severity === "error");
check("saved package: zero validation errors", errors.length === 0, errors.map((e) => e.message).join(" | "));

const xml = new TextDecoder().decode(unzipSync(new Uint8Array(saved))["ppt/slides/slide2.xml"]);
check("Motion lives in the OOXML PowerPoint reads (<p:transition>/<p:timing>)",
  /<p:transition[\s\S]*?morph/.test(xml) && /<p:timing[\s\S]*?<p:cTn/.test(xml), `${saved.length} bytes saved`);
// The animation must be keyed to the shape PowerPoint shows under that name.
const named = /<p:cNvPr\b[^>]*name="!!Title_s1"[^>]*>/.exec(xml);
const namedId = named ? /id="(\d+)"/.exec(named[0])?.[1] : null;
check("the timed effect targets the NAMED shape (p:spTgt spid matches cNvPr id)",
  !!namedId && new RegExp(`<p:spTgt[^>]*spid="${namedId}"`).test(xml),
  namedId ? `spid=${namedId}; spTgt count=${(xml.match(/<p:spTgt/g) ?? []).length}` : "no cNvPr named !!Title_s1 in slide2.xml");

finish(0);
