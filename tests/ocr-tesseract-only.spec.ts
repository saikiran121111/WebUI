/**
 * F90 / C4(d) (2026-11-23) — Tesseract-only ZERO-probe journey, LIVE
 * (exclusive Playwright; run ONLY via scripts/run-browser-e2e-exclusive.ps1
 * with an isolated WEBUI_DATA_DIR=.data/e2e-store).
 *
 * C3's coverage map (F90) proved no live row ever ran the Tesseract-only
 * configuration: P10's C3 answer came from Tesseract under the DEFAULT
 * cascade (Paddle probed, fell back) and was graded BLOCKED per key line
 * 245. This row is the configuration row the checklist C4 demands — the
 * browser path that selects Tesseract-only and proves the Paddle pipeline
 * is never probed, never downloaded, never launched.
 *
 * Laws proven here, in ONE journey:
 *  1. Settings→Engines UI law: exactly TWO OCR radios, fixed Parakeet
 *     speech block, no retired-marketplace controls (C4(a) UI half).
 *  2. The radio writes ocr_engine via /api/settings (server persistence,
 *     python reads the same key — SETTINGS_OCR_KEY in ocr_cascade.py).
 *  3. A scanned PDF is ANSWERED under Tesseract-only (keyed page-1 facts,
 *     the F81 key), with per-page provenance recorded in the delivered
 *     attachment text.
 *  4. ZERO Paddle probes: the engine map names ONLY tesseract, and the
 *     primary-not-ready recovery narrative is present (the Tesseract-only
 *     selection marks primary probed=False — ocr_cascade.py line 158 —
 *     so recovery wording without a paddle engine entry IS the zero-probe
 *     signature; a paddle probe under this selection is a product bug).
 *  5. Native text is PRESERVED: a native PDF under the same selection
 *     routes ZERO pages to OCR (pdf.js text layer, no OCR narrative).
 *  6. The setting restores to PaddleOCR at the end — settings.json is
 *     shared project state; the Paddle-primary matrix rows must not be
 *     poisoned by this row.
 *
 * Mixed-document cascade law (native pages + primary/fallback recovery)
 * stays pinned model-free at the cascade layer (py cascade vectors, B
 * sweep); replicating a forced single-page Paddle failure in the browser
 * would need a fault-injection env the exclusive launcher does not set.
 *
 * Key: scan-1.pdf page-1 facts are the F81 frozen key (independently
 * authored d1 answer-key: "14 million cubic metres" yield, "31 ppt"
 * salinity, "Kandla" gauge) — never derived from any model run.
 */
import { test, expect, Locator, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const LIVE = path.join(
  process.cwd(), ".data", "tmp", "file-regression", "fr-20261122a", "dl", "live",
);
const RESULTS = path.join(
  process.cwd(), "docs", "overnight", "file-regression-fr-20261122a", "results-ocr-tesseract.jsonl",
);
const STORE = path.join(process.cwd(), ".data", "e2e-store");

const FILE_INPUT = '[data-testid="file-input"]';
const CHIP = '[data-testid="attachment-chip"]';
const SEND = '[data-testid="send-button"]';
const ASSISTANT = '[data-testid="assistant-message"]';
const ANSWER_BODY = '[data-testid="answer-body"]';

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function record(row: string, obj: Record<string, unknown>): void {
  fs.appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), row, ...obj }) + "\n");
}

const FIX = (name: string): string => {
  const p = path.join(LIVE, name);
  if (!fs.existsSync(p)) throw new Error(`F90 fixture missing: ${p}`);
  return p;
};

async function waitChipFinal(chip: Locator, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await chip.getAttribute("data-status").catch(() => null);
    if (status === "ready" || status === "error") return status;
    await new Promise(r => setTimeout(r, 250));
  }
  return "timeout";
}

/** Minimal send: reasoning off, one upload, one prompt, completed answer body. */
async function send(page: Page, file: string, prompt: string, t: { extract: number; model: number }): Promise<string> {
  await page.goto("/");
  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  if ((await effort.getAttribute("aria-label")) !== "Reasoning effort: Off") {
    await effort.click();
    await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect(effort).toHaveAttribute("aria-label", "Reasoning effort: Off");
  }
  await page.setInputFiles(FILE_INPUT, file);
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const status = await waitChipFinal(chip, t.extract);
  if (status !== "ready") throw new Error(`extraction not ready: ${status} (${await chip.getAttribute("title")})`);
  record("milestone", { phase: "ready", file: path.basename(file) });

  await page.locator("textarea").first().fill(prompt);
  await expect(page.locator(SEND)).toBeEnabled();
  const tAsk = Date.now();
  await page.locator(SEND).click();
  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + t.model;
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    if (state === "complete") {
      const body = reply.locator(ANSWER_BODY);
      const said = (await (await body.count() ? body.first().innerText() : reply.innerText()).catch(() => "")).trim();
      record("milestone", { phase: "complete", file: path.basename(file), ms: Date.now() - tAsk, said: said.slice(0, 160) });
      return said;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

/** Same reader the F81 provenance law uses: the store persists the EXACT
 *  delivered attachment text, so engine attribution is graded model-free. */
function storeAttachmentText(fixtureName: string): string {
  const recs = fs
    .readdirSync(STORE)
    .filter((f) => /^c_.*\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(STORE, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of recs) {
    let j: any;
    try { j = JSON.parse(fs.readFileSync(path.join(STORE, f), "utf8")); } catch { continue; }
    for (const msg of j.messages ?? [])
      for (const a of msg.attachments ?? [])
        if (String(a.name ?? "").includes(fixtureName) && typeof a.text === "string" && a.text.length)
          return a.text as string;
  }
  return "";
}

async function openEnginesTab(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-tab-engines").click();
  await expect(page.getByTestId("engines-panel")).toBeVisible();
}

async function pickOcr(page: Page, engine: "paddle" | "tesseract"): Promise<void> {
  const testid = engine === "tesseract" ? "engines-ocr-tesseract" : "engines-ocr-paddle";
  const resp = page.waitForResponse(r => new URL(r.url()).pathname === "/api/settings" && r.status() === 200);
  await page.getByTestId(testid).click();
  await resp;
  await expect(page.getByTestId(testid)).toHaveAttribute("aria-checked", "true");
}

test("F90.1 Engines UI law: two OCR radios, fixed Parakeet, no marketplace controls; Tesseract-only persists", async ({ page }) => {
  test.setTimeout(120_000);
  await openEnginesTab(page);
  // Exactly the two fixed engine choices — the retired HF marketplace left
  // no radio, search box, download control or delete row (C4 retirement).
  await expect(page.getByTestId("engines-ocr-paddle")).toBeVisible();
  await expect(page.getByTestId("engines-ocr-tesseract")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "OCR engine" })).toBeVisible();
  await expect(page.getByTestId("engines-speech-fixed")).toContainText("nvidia/parakeet-tdt-0.6b-v3");
  const panel = page.getByTestId("engines-panel");
  const text = (await panel.innerText()).toLowerCase();
  for (const retired of ["search models", "download", "delete model", "hugging", "mirror"])
    expect(text, `retired marketplace control leaked: ${retired}`).not.toContain(retired);

  await pickOcr(page, "tesseract");
  await expect(page.getByTestId("engines-ocr-paddle")).toHaveAttribute("aria-checked", "false");
  // Server persistence is immediate (saveSettings POST); reload proves it.
  await page.reload();
  await openEnginesTab(page);
  await expect(page.getByTestId("engines-ocr-tesseract")).toHaveAttribute("aria-checked", "true");
});

test("F90.2 scanned PDF answered under Tesseract-only; zero Paddle probes in the recorded provenance", async ({ page }) => {
  test.setTimeout(900_000);
  const said = await send(page, FIX("scan-1.pdf"),
    "Page 1 of the attached PDF is a scan — its words exist only as pixels. What aquifer yield (with units) and what downstream salinity (with units and gauge location) appear on that page? Reply with them exactly as printed. Nothing else.",
    { extract: 420_000, model: 240_000 });
  const n = normalize(said);
  expect(n, `yield fact missing: ${said.slice(0, 200)}`).toContain("14millioncubicmetres");
  expect(n, `salinity fact missing: ${said.slice(0, 200)}`).toContain("31ppt");
  expect(n, `gauge location missing: ${said.slice(0, 200)}`).toContain("kandla");

  const prov = storeAttachmentText("scan-1.pdf");
  expect(prov, "scan-1 delivered text not found in the store: provenance UNVERIFIED").not.toBe("");
  const readers = [...prov.matchAll(/\[page (\d+) \| read by: ([^\]]+)\]/g)];
  expect(readers.length, `per-page provenance headers incomplete (${readers.length}/6)`).toBeGreaterThanOrEqual(6);
  expect(prov, "OCR never ran on the image-only fixture").toContain("recognised by OCR");
  // ZERO-PADDLE signature: the engine map names ONLY tesseract…
  const engines = prov.match(/recognised per engine: \{[^}]*\}/)?.[0] ?? "recognised per engine: {}";
  expect(engines.toLowerCase(), `tesseract did not read pages: ${engines}`).toContain("tesseract");
  expect(engines.toLowerCase(), `PADDLE PROBED under Tesseract-only selection: ${engines}`).not.toContain("paddle");
  const consulted = prov.match(/engines consulted: [^;]+/)?.[0] ?? "engines consulted: (none)";
  expect(consulted.toLowerCase(), `PADDLE CONSULTED under Tesseract-only selection: ${consulted}`).not.toContain("paddle");
  // …and the primary was marked not-ready WITHOUT a probe (ocr_cascade
  // probed=False ⇒ recovery wording; the wording alone is not the proof —
  // the absent paddle engine entry is).
  expect(prov.toLowerCase(),
    "primary-not-ready recovery narrative missing (Tesseract-only marks primary probed=False)")
    .toContain("the primary ocr engine was not ready");
  record("F90.2", { engines, consulted, answerOk: true });
});

test("F90.3 native PDF under the same selection: native text preserved, zero OCR launches", async ({ page }) => {
  test.setTimeout(600_000);
  await send(page, FIX("scan-2.pdf"),
    "Reply with the single word READY. Nothing else.",
    { extract: 120_000, model: 120_000 });
  const prov = storeAttachmentText("scan-2.pdf");
  expect(prov, "scan-2 delivered text not found in the store").not.toBe("");
  expect(prov, "native pages must keep their text layer under Tesseract-only")
    .toContain("read by: pdf.js text layer");
  expect(prov.toLowerCase(), "OCR launch narrative present on a native PDF under Tesseract-only")
    .toContain("ocr did not run");
  expect(prov.toLowerCase(), "OCR LAUNCHED on a native PDF under Tesseract-only")
    .not.toContain("recognised by ocr");
  record("F90.3", { nativeControl: true });
});

test("F90.4 restore PaddleOCR default (shared settings.json must not stay flipped)", async ({ page }) => {
  test.setTimeout(120_000);
  await openEnginesTab(page);
  await pickOcr(page, "paddle");
  await page.reload();
  await openEnginesTab(page);
  await expect(page.getByTestId("engines-ocr-paddle")).toHaveAttribute("aria-checked", "true");
});
