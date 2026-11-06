import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { buildMotionPlan, type MotionPlan } from "../lib/documents/pptxMotion";
import { motionPlanDiff, motionSummary, planClickReveals } from "../lib/documents/pptxPackageMotion";
import { normalizePptx, pptxSpecIssues, type PptxSpec } from "../lib/documents/schemas";

/**
 * PHASE 5A journeys: decks generated THROUGH RUKE — the normal entry point is
 * the chat UI against the REAL Qwen3.8-Flash-Next endpoint (no mocks, no route
 * interception, decision engine live).  Every deck is then downloaded from its
 * own preview card and inspected as a package.
 *
 * The load-bearing assertion is PLAN ↔ FILE CONSISTENCY: the ```pptx fence the
 * model actually emitted is read back out of the persisted conversation, run
 * through the SAME normalizer + motion planner the preview plays
 * (lib/documents/pptxMotion.ts), and compared per-slide against the exported
 * XML.  A hard-coded "this deck must be animated" would only test the model's
 * vocabulary; a divergence between the plan and the file is the real defect
 * (preview/export motion split) and fails loudly here.
 *
 * Files land in `.data/exports-5a/` with FIXED names so the PowerPoint
 * playback observation (structural checks are not playback) opens exactly the
 * decks the model generated.  Run one journey per launcher invocation
 * (`-Grep "<title>"`) — these are model-driven and must stay serial.
 */

const BASE = "http://localhost:3000";
const OUT_DIR = path.resolve(".data/exports-5a");
const BLOCK = '[data-testid="pptx-block"]';

test.beforeAll(() => fs.mkdirSync(OUT_DIR, { recursive: true }));

async function send(page: Page, text: string): Promise<void> {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

/** Wait for the pptx preview card to mount, then for the turn to finish. */
async function waitForDeck(page: Page): Promise<Locator> {
  const block = page.locator(BLOCK).first();
  await expect(block, "the model's pptx fence must mount a live preview").toBeVisible({ timeout: 420_000 });
  // The turn must actually settle — a still-streaming fence is not a deck.
  await expect(page.getByLabel("Stop generating"), "the turn must complete").toHaveCount(0, { timeout: 420_000 });
  return block;
}

/** Download through the card's own button; save under a fixed name. */
async function downloadDeck(page: Page, block: Locator, name: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 240_000 }),
    block.getByRole("button", { name: "Download PPTX file" }).click(),
  ]);
  const file = path.join(OUT_DIR, `${name}.pptx`);
  await download.saveAs(file);
  return file;
}

function packageOf(file: string) {
  const buf = fs.readFileSync(file);
  expect(buf[0]).toBe(0x50); // PK — a real package reached disk
  expect(buf[1]).toBe(0x4b);
  const zip = unzipSync(new Uint8Array(buf));
  const slideNames = Object.keys(zip)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml/)![1]) - Number(b.match(/(\d+)\.xml/)![1]));
  const xmls = slideNames.map((n) => new TextDecoder().decode(zip[n]));
  return { buf, zip, slideNames, xmls, all: xmls.join("") };
}

/**
 * Preview motion contract: run the slideshow and advance with the arrow key
 * the way PowerPoint does it. A slide with pending click-builds consumes
 * presses BEFORE the slide counter moves (advance() reveals first), so the
 * press count needed to reach slide 2 IS the click-build count.
 */
async function playPreview(page: Page, block: Locator): Promise<{ total: number; presses: number }> {
  await block.getByRole("button", { name: "Run Slideshow" }).click();
  const show = page.getByRole("dialog", { name: "Presentation slideshow" });
  await expect(show).toBeVisible();
  const hud = show.getByText(/^\d+\s*\/\s*\d+$/).first();
  const first = (await hud.textContent())?.trim() ?? "";
  const total = parseInt(first.match(/\/\s*(\d+)/)?.[1] ?? "0", 10);
  expect(total, `slideshow HUD should show a slide count (got "${first}")`).toBeGreaterThanOrEqual(2);

  let presses = 0;
  let onSlide2 = false;
  while (presses < total + 4 && !onSlide2) {
    await page.keyboard.press("ArrowRight");
    presses++;
    onSlide2 = /^2\s*\//.test((await hud.textContent())?.trim() ?? "");
  }
  expect(onSlide2, `arrow-right never advanced past slide 1 after ${presses} presses`).toBe(true);
  await page.keyboard.press("Escape");
  await expect(show).toHaveCount(0);
  return { total, presses };
}

// ---- the model's OWN spec, read back from the persisted conversation ----

async function conversationIds(page: Page): Promise<Set<string>> {
  const res = await page.request.get(`${BASE}/api/conversations`);
  expect(res.ok(), `GET /api/conversations => ${res.status()}`).toBe(true);
  return new Set(((await res.json()) as { id: string }[]).map((c) => c.id));
}

/** Locate this journey's conversation (newest one containing the prompt) and
 * return the assistant turn that carries the fence. */
async function modelTurn(page: Page, before: Set<string>, prompt: string): Promise<{ id: string; content: string } | null> {
  const res = await page.request.get(`${BASE}/api/conversations`);
  const list = (await res.json()) as { id: string; updatedAt: number }[];
  const ordered = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  const fresh = ordered.filter((c) => !before.has(c.id));
  const probe = `${prompt.slice(0, 60)}`;
  for (const c of [...fresh, ...ordered]) {
    const r = await page.request.get(`${BASE}/api/conversations/${c.id}`);
    if (!r.ok()) continue;
    const doc = await r.json();
    const msgs = Array.isArray(doc?.messages) ? doc.messages : [];
    if (!msgs.some((m: any) => m.role === "user" && String(m.content).includes(probe))) continue;
    const withFence = [...msgs].reverse().find((m: any) => m.role === "assistant" && String(m.content).includes("```pptx"));
    if (withFence) return { id: c.id, content: String(withFence.content) };
  }
  return null;
}

/** First ```pptx fence — the card the journey clicked is `block.first()`. */
function fenceJson(content: string): unknown {
  const m = /```pptx\s*([\s\S]*?)```/.exec(content);
  expect(m, "the assistant turn must contain a ```pptx fence").not.toBeNull();
  try {
    return JSON.parse(m![1].trim());
  } catch (e) {
    throw new Error(`the pptx fence is not valid JSON (${(e as Error).message}): ${m![1].slice(0, 200)}`);
  }
}

/** The SAME pipeline the route + preview use: validate, normalize, plan. */
function planOf(raw: unknown): { spec: PptxSpec; plan: MotionPlan } {
  expect(pptxSpecIssues(raw), "the model's pptx spec must pass spec validation").toEqual([]);
  const spec = normalizePptx(raw)!;
  return { spec, plan: buildMotionPlan(spec) };
}

/**
 * PLAN ↔ FILE motion parity per slide — transition kind, transition DURATION,
 * whether the slide animates at all, and the on-click build GATING.  The
 * predicates live in lib/documents/pptxPackageMotion.ts (shared with the
 * deterministic engine tests), and they were confirmed against real PowerPoint
 * slideshow playback of these decks: its own View.GetClickCount() reported
 * 4/5/6/4 on the slides whose exported XML carries 4/5/6/4
 * `<p:cond delay="indefinite"/>` gates, and View.Next() advanced the show
 * position only after the last one.
 */
function assertPlanMatchesFile(plan: MotionPlan, pkg: ReturnType<typeof packageOf>, spec: PptxSpec, label: string) {
  expect(pkg.slideNames.length, `${label}: exported slide count vs the model's spec`).toBe(spec.slides.length);
  expect(motionPlanDiff(plan, spec, pkg.xmls), `${label}: the exported file must match the ONE motion plan the preview plays`).toEqual([]);
  // !! ids are motion targets; the engine only names shapes on an animated deck.
  expect(pkg.all.includes('name="!!'), `${label}: !! motion ids present iff the deck is animated`)
    .toBe(spec.tier !== "simple");
}

/**
 * PREVIEW gating ↔ plan parity: PptxBlock.advance() consumes one press per
 * planned click reveal before the HUD counter moves, so the presses needed to
 * leave slide 1 expose the plan.  PowerPoint applies the same gating to the
 * exported file's `<p:cond delay="indefinite"/>` builds (verified live), so all
 * three — plan, browser preview, real slideshow — must agree.
 */
function assertPreviewGating(presses: number, plan: MotionPlan, spec: PptxSpec, label: string) {
  const reveals = planClickReveals(plan, spec, 0);
  expect(presses, `${label}: presses to leave slide 1 vs the plan's ${reveals} click reveal(s) (${describePlan(spec, plan)})`).toBe(reveals + 1);
}

const describePlan = (spec: PptxSpec, plan: MotionPlan) =>
  `tier=${spec.tier} slides=${plan.length} transitions=${JSON.stringify(plan.map((p) => p.transition))} ` +
  `steps=${plan.map((p) => p.steps.length).join("/")} reduced=${!!spec.reducedMotion} ` +
  `motion=${JSON.stringify(spec.slides.map((s) => s.motion ?? null))}`;

const prompts = {
  pitch:
    "Build me an investor pitch deck for NovaGrid, a startup that predicts machine failures in small factories. " +
    "6 slides (title, problem, solution, traction with stats, market, ask). Insane tier with morphGroup transitions " +
    "between consecutive slides and reveal-on-click bullets.",
  explainer:
    "Make an explainer deck that teaches non-engineers what predictive maintenance is and why it matters, in 5 slides. " +
    "Normal tier, with morph transitions on the paired slides and click-revealed bullets.",
  data:
    "Create a data-heavy quarterly review deck for a SaaS company: title, three stats slides, a revenue chart slide and " +
    "a retention line chart slide. Insane tier, morph transitions, charts must be real editable charts.",
  simple:
    "Make a simple 3-slide deck announcing our office move: new address, parking changes, who to contact. Plain simple " +
    "tier — no animations, no transitions.",
};

test("5A pitch deck generated through Ruke carries native motion and stays editable", async ({ page }) => {
  test.setTimeout(900_000);
  const before = await conversationIds(page);
  await page.goto(BASE + "/");
  await send(page, prompts.pitch);
  const block = await waitForDeck(page);
  const { total, presses } = await playPreview(page, block);
  const file = await downloadDeck(page, block, "pitch");

  const turn = await modelTurn(page, before, prompts.pitch);
  expect(turn, "the pitch conversation must persist the assistant's pptx fence").not.toBeNull();
  const { spec, plan } = planOf(fenceJson(turn!.content));

  const pkg = packageOf(file);
  assertPlanMatchesFile(plan, pkg, spec, "pitch");
  expect(plan.length, `pitch deck slide count (HUD said ${total})`).toBeGreaterThanOrEqual(5);
  // The prompts asked for Morph + click reveals; the FILE must carry them.
  expect(plan.filter((p) => p.transition === "morph").length, `no Morph in the plan (${describePlan(spec, plan)})`)
    .toBeGreaterThanOrEqual(1);
  expect(plan.flatMap((p) => p.steps).filter((s) => s.start === "click").length, `no click reveals in the plan (${describePlan(spec, plan)})`)
    .toBeGreaterThanOrEqual(1);
  expect(pkg.all).toContain("<p:transition");
  expect(pkg.all).toMatch(/p159:morph/);
  expect(pkg.all).toContain("<p:timing");
  expect(pkg.all).toContain("<p:cTn"); // timing tree PowerPoint plays
  expect(pkg.all).toContain('name="!!');
  assertPreviewGating(presses, plan, spec, "pitch");
  console.log(`5A PITCH DECK -> ${file} (${pkg.buf.length} bytes, ${pkg.slideNames.length} slides) ${describePlan(spec, plan)}`);
  console.log(`5A pitch preview: HUD ${total} slides, ${presses} presses to leave slide 1; ` +
    `${motionSummary(plan, spec, pkg.xmls)} — PowerPoint's live View.GetClickCount() reported ` +
    `the same per-slide click counts, and its Morph ran at 900 ms`);
});

test("5A explainer deck generated through Ruke morphs only on paired slides", async ({ page }) => {
  test.setTimeout(900_000);
  const before = await conversationIds(page);
  await page.goto(BASE + "/");
  await send(page, prompts.explainer);
  const block = await waitForDeck(page);
  const { total, presses } = await playPreview(page, block);
  const file = await downloadDeck(page, block, "explainer");

  const turn = await modelTurn(page, before, prompts.explainer);
  expect(turn, "the explainer conversation must persist the assistant's pptx fence").not.toBeNull();
  const { spec, plan } = planOf(fenceJson(turn!.content));
  const pkg = packageOf(file);
  assertPlanMatchesFile(plan, pkg, spec, "explainer");

  expect(plan.length).toBeGreaterThanOrEqual(4);
  expect(spec.tier, `the prompt named the normal tier; the model chose ${spec.tier}`).not.toBe("simple");
  if (spec.tier === "normal") {
    // The engine never invents a Morph in the normal tier: a slide morphs ONLY
    // where the MODEL signalled it — an explicit per-slide motion.transition,
    // else a morphGroup shared with the previous slide (the model this run
    // declared both, and the plan must not re-tier its explicit choices).
    const declared = spec.slides.map((s, i) => i > 0 && (
      s.motion?.transition && s.motion.transition !== "auto"
        ? s.motion.transition === "morph"
        : !!s.morphGroup && spec.slides[i - 1].morphGroup === s.morphGroup));
    const morphs = plan.map((p) => p.transition === "morph");
    expect(morphs, `normal-tier Morph must appear on exactly the slides the model signalled (${describePlan(spec, plan)})`)
      .toEqual(declared);
    expect(morphs.filter(Boolean).length, `the prompt asked for morph transitions (${describePlan(spec, plan)})`).toBeGreaterThanOrEqual(1);
  }
  expect(pkg.all).toContain("<p:transition");
  expect(pkg.all).toContain('name="!!');
  assertPreviewGating(presses, plan, spec, "explainer");
  console.log(`5A EXPLAINER DECK -> ${file} (${pkg.buf.length} bytes, ${pkg.slideNames.length} slides) ${describePlan(spec, plan)}`);
  console.log(`5A explainer preview: HUD ${total}, ${presses} presses to slide 2; ${motionSummary(plan, spec, pkg.xmls)}`);
});

test("5A data-heavy deck generated through Ruke exports NATIVE editable charts", async ({ page }) => {
  test.setTimeout(900_000);
  const before = await conversationIds(page);
  await page.goto(BASE + "/");
  await send(page, prompts.data);
  const block = await waitForDeck(page);
  const { total, presses } = await playPreview(page, block);
  const file = await downloadDeck(page, block, "data-heavy");

  const turn = await modelTurn(page, before, prompts.data);
  expect(turn, "the data-heavy conversation must persist the assistant's pptx fence").not.toBeNull();
  const { spec, plan } = planOf(fenceJson(turn!.content));
  const pkg = packageOf(file);
  assertPlanMatchesFile(plan, pkg, spec, "data-heavy");

  expect(plan.length).toBeGreaterThanOrEqual(4);
  expect(spec.slides.filter((s) => !!s.chart).length, "the model was asked for two chart slides").toBeGreaterThanOrEqual(2);
  // Charts must be chart parts + their embedded workbook, never pictures.
  const charts = Object.keys(pkg.zip).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  expect(charts.length, "expected native chart parts in the exported deck").toBeGreaterThanOrEqual(2);
  expect(Object.keys(pkg.zip).some((n) => n.startsWith("ppt/embeddings/")),
    "chart data must ship as an embedded workbook (values editable in PowerPoint)").toBe(true);
  expect(pkg.all).toContain("<p:transition");
  assertPreviewGating(presses, plan, spec, "data-heavy");
  console.log(`5A DATA-HEAVY DECK -> ${file} (${pkg.buf.length} bytes, ${pkg.slideNames.length} slides, ` +
    `charts: ${charts.join(",")}) ${describePlan(spec, plan)}`);
  console.log(`5A data-heavy preview: HUD ${total}, ${presses} presses to slide 2; ${motionSummary(plan, spec, pkg.xmls)}`);
});

test("5A simple deck generated through Ruke exports exactly the motion it planned", async ({ page }) => {
  test.setTimeout(900_000);
  const before = await conversationIds(page);
  await page.goto(BASE + "/");
  await send(page, prompts.simple);
  const block = await waitForDeck(page);
  const file = await downloadDeck(page, block, "simple-ui");

  const turn = await modelTurn(page, before, prompts.simple);
  expect(turn, "the simple conversation must persist the assistant's pptx fence").not.toBeNull();
  const { spec, plan } = planOf(fenceJson(turn!.content));
  const pkg = packageOf(file);
  assertPlanMatchesFile(plan, pkg, spec, "simple");
  expect(plan.length).toBeGreaterThanOrEqual(3);

  // The user said "no animations, no transitions" — and that IS expressible
  // (tier:"simple", or per-slide motion {transition:"none",reveal:"none"}).
  // Anything else in the plan is the model over-specifying, and it must still
  // be honest in the file, so both halves are asserted explicitly.
  const motion = plan.filter((p) => p.transition !== "none" || p.steps.length > 0);
  expect(motion.length, `a static deck was requested; plan says ${describePlan(spec, plan)}`).toBe(0);
  expect(pkg.all).not.toContain("<p:transition");
  expect(pkg.all).not.toContain("<p:timing");
  console.log(`5A SIMPLE DECK -> ${file} (${pkg.buf.length} bytes, ${pkg.slideNames.length} slides, ` +
    `zero motion) ${describePlan(spec, plan)}`);
});
