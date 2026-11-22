/**
 * F78 file-reading release — live-browser acceptance rows (exclusive Playwright).
 *
 * One live browser question per distinct production reader on the F78 audit
 * fixtures, through the real UI path (picker upload → extraction chip →
 * real model reply), each with a CONTENT assertion on the reply:
 *   1. large BOM/UTF-16 text (all-readers/sample.csv) → FINAL-681
 *      + the stage-indicator/answer-once/no-retry/scroll-anchor laws
 *   2. office complex (review-complex-1121/book.xlsx) → D799 pair 1596 + 3990
 *   3. scanned PDF page (mixed.pdf p92 via the OCR cascade) → 4,18,25,000
 *   4. notebook exact integer (native/exact.ipynb) → 9007199254740993
 *   5. exact-time video question (three-hours.mp4 @01:31:00) → COBALT VALVE
 *
 * A successful upload, a "ready" badge or a mock response cannot pass a row:
 * every row requires the fact bytes inside the model's completed reply.
 * Run ONLY under the exclusive launcher (scripts/run-browser-e2e-exclusive.ps1).
 */
import { test, expect, Locator, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const F78 = path.join(process.cwd(), "docs", "overnight", "fixtures", "f78");
const ALL = path.join(F78, "all-readers");
const COMPLEX = path.join(F78, "review-complex-1121");

const FILE_INPUT = '[data-testid="file-input"]';
const CHIP = '[data-testid="attachment-chip"]';
const SEND = '[data-testid="send-button"]';
const ASSISTANT = '[data-testid="assistant-message"]';
const PROGRESS = '[data-testid="progress-chip"]';
const ERRORS = '[data-testid="error"]';
const SCROLL = '[data-testid="messages-scroll"]';

/** Marker strings survive lowercasing and punctuation drift. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
const digits = (s: string) => s.replace(/\D/g, "");

async function waitChipReady(chip: Locator, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    const status = await chip.getAttribute("data-status").catch(() => null);
    last = status ?? "(no chip)";
    if (status === "ready") return;
    if (status === "error") {
      throw new Error(`extraction failed: ${await chip.getAttribute("title")}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`attachment never became ready (last status: ${last})`);
}

interface Turn { reply: Locator; said: string; chipLabel: string; driving: number; bottomGap: number; newReplies: number }

/** Fresh page, reasoning off, upload → ready → prompt → completed reply. */
async function sendWithAttachment(
  page: Page,
  file: string,
  prompt: string,
  t: { extract: number; model: number },
): Promise<Turn> {
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
  await waitChipReady(chip, t.extract);

  const before = await page.locator(ASSISTANT).count();
  await page.locator("textarea").first().fill(prompt);
  await expect(page.locator(SEND)).toBeEnabled();
  await page.locator(SEND).click();

  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + t.model;
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    if (state === "complete") {
      // F77 stage-indicator law: the chip persists after the turn (it is
      // dismissable, click-to-close) but must stop CLAIMING a running turn:
      // the label flips off "Step N of M" and the "working" indicator
      // ("RUKE is driving") count is 0 (browser-model-acceptance law).
      const chipLabel = (await page.locator(PROGRESS).first().innerText().catch(() => "")).trim();
      const driving = await page.getByText("RUKE is driving").count();
      const bottomGap = await page.locator(SCROLL).evaluate((el: Element) => {
        const e = el as HTMLElement;
        return e.scrollHeight - e.scrollTop - e.clientHeight;
      });
      const said = (await reply.innerText()).trim();
      const newReplies = (await page.locator(ASSISTANT).count()) - before;
      return { reply, said, chipLabel, driving, bottomGap, newReplies };
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

/** One bounded retry for local-model nondeterminism (truncated tail, slow
 *  turn) — same law as tests/file-reading.spec.ts; real failures still throw. */
async function ask(page: Page, file: string, prompt: string, t: { extract: number; model: number }): Promise<Turn> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await sendWithAttachment(page, file, prompt, t);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "the assistant never finished answering" && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error("unreachable");
}

const FIX = (...parts: string[]) => {
  const p = path.join(...parts);
  if (!fs.existsSync(p)) throw new Error(`F78 fixture missing: ${p}`);
  return p;
};

test("row 1 — large BOM text via picker: FINAL-681 + stage/answer-once/scroll laws", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await ask(
    page,
    FIX(ALL, "sample.csv"),
    "Read the attached file and reply with exactly YES followed by the code FINAL-681 exactly as it appears in the file, or NO if you cannot find it. Nothing else.",
    { extract: 120_000, model: 180_000 },
  );
  console.log(`  sample.csv → ${t.said.replace(/\s+/g, " ").slice(0, 90)}`);
  expect(normalize(t.said), `reply: ${t.said.slice(0, 300)}`).toContain("final681");

  // Stage indicators no longer claim a running turn (chip label is the real
  // ending, and the "working" indicator is gone — F77 honesty law).
  expect(t.chipLabel, `progress chip still claims a running turn: ${t.chipLabel}`).not.toMatch(/Step \d+ of \d+/);
  expect(t.driving, "working indicator hung after completion").toBe(0);
  // Answer-once: exactly one new assistant message for one send.
  expect(t.newReplies, "more than one assistant reply for one send").toBe(1);
  // No retry/error chrome; the answer carries no retry text.
  await expect(page.locator(ERRORS)).toHaveCount(0);
  expect(t.said.toLowerCase(), "reply carries retry text").not.toMatch(/retry|try again/);
  // Scroll lock: the message viewport is anchored at the bottom at completion.
  expect(t.bottomGap, `viewport not anchored to bottom (gap ${t.bottomGap}px)`).toBeLessThan(160);
});

test("row 2 — office complex: book.xlsx D799 pair through the normal upload", async ({ page }) => {
  test.setTimeout(700_000);
  const t = await ask(
    page,
    FIX(COMPLEX, "book.xlsx"),
    "The attached spreadsheet has worksheets named \"Ledger 2\" and \"Ledger 5\". What number is stored in cell D799 on Ledger 2, and what number is stored in cell D799 on Ledger 5? State each number with its sheet name.",
    { extract: 300_000, model: 240_000 },
  );
  console.log(`  book.xlsx → ${t.said.replace(/\s+/g, " ").slice(0, 120)}`);
  expect(t.said).toContain("1596");
  expect(t.said).toContain("3990");
});

test("row 3 — scanned PDF: mixed.pdf p92 amount via the OCR cascade", async ({ page }) => {
  test.setTimeout(900_000);
  const t = await ask(
    page,
    FIX(COMPLEX, "mixed.pdf"),
    "Page 92 of the attached PDF is a scanned page — its words exist only as pixels, readable by OCR. It states a rupee amount. What is that amount? Reply with the amount exactly as printed.",
    { extract: 420_000, model: 240_000 },
  );
  console.log(`  mixed.pdf → ${t.said.replace(/\s+/g, " ").slice(0, 120)}`);
  expect(digits(t.said), `OCR fact not in reply: ${t.said.slice(0, 300)}`).toContain("41825000");
});

test("row 4 — notebook exact integer: exact.ipynb exact_id", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await ask(
    page,
    FIX(ALL, "native", "exact.ipynb"),
    "The attached notebook records a field named exact_id. Reply with the full integer value of exact_id exactly as recorded in the file. Nothing else.",
    { extract: 120_000, model: 180_000 },
  );
  console.log(`  exact.ipynb → ${t.said.replace(/\s+/g, " ").slice(0, 90)}`);
  expect(digits(t.said), `exact_id not in reply: ${t.said.slice(0, 300)}`).toContain("9007199254740993");
});

test("row 5 — exact-time video: three-hours.mp4 at 01:31:00", async ({ page }) => {
  test.setTimeout(1_200_000);
  const t = await ask(
    page,
    FIX(COMPLEX, "three-hours.mp4"),
    "What is on screen at 01:31:00 in the attached video? Reply with the exact words shown at that time, or NO if that moment was not supplied. Nothing else.",
    { extract: 900_000, model: 240_000 },
  );
  console.log(`  three-hours.mp4 → ${t.said.replace(/\s+/g, " ").slice(0, 120)}`);
  expect(normalize(t.said), `01:31:00 card not in reply: ${t.said.slice(0, 300)}`).toContain("cobaltvalve");
});
