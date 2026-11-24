/**
 * C5 (2026-11-22, F79/B11) — typing-during-upload journey, LIVE (exclusive
 * Playwright; run ONLY via scripts/run-browser-e2e-exclusive.ps1).
 *
 * The DOM half of the B11 Send-gating law (the decision half is pinned
 * model-free in __tests__/ui/composer-send-gate.test.ts):
 *   upload -> chip appears IMMEDIATELY with its visible phase label,
 *   the textarea stays EDITABLE while the file is read,
 *   SEND is DISABLED while processing,
 *   ENTER PRESSED WHILE PROCESSING -> 0 chat requests, draft PRESERVED,
 *   1 chat request after the click once the chip is ready (evidence persisted
 *   and the window's Strata restoration done — the extract response IS that
 *   completion, B10), never a queue.
 *
 * Fixture: doc-a.pdf (3.3 MB, server-side pdf.js read — a real multi-second
 * processing window with NO exclusive handoff, keeping the row off the model
 * slot until the ONE send). After the send is counted, the turn is stopped:
 * the row grades the GATE, not the answer.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const LIVE = path.join(
  process.cwd(), ".data", "tmp", "file-regression", "fr-20261122a", "dl", "live",
);
const FIXTURE = path.join(LIVE, "doc-a.pdf");

const FILE_INPUT = '[data-testid="file-input"]';
const CHIP = '[data-testid="attachment-chip"]';
const CHIP_PHASE = '[data-testid="chip-phase"]';
const SEND = '[data-testid="send-button"]';
const DRAFT = "B11 gate probe: type during upload, send after ready.";

test.beforeAll(() => {
  if (!fs.existsSync(FIXTURE)) throw new Error(`C5 fixture missing: ${FIXTURE}`);
});

test("C5 typing during upload: Enter while processing sends 0, draft preserved; 1 send after ready", async ({ page }) => {
  test.setTimeout(300_000);

  const chatRequests: string[] = [];
  page.on("request", r => {
    const u = new URL(r.url());
    if (u.pathname === "/api/chat") chatRequests.push(r.url());
  });

  await page.goto("/");
  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  if ((await effort.getAttribute("aria-label")) !== "Reasoning effort: Off") {
    await effort.click();
    await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect(effort).toHaveAttribute("aria-label", "Reasoning effort: Off");
  }

  // Chip immediate: the chip exists the moment the picker fires, and it
  // SHOWS its phase (Queued / Reading…) while the gate is closed.
  await page.setInputFiles(FILE_INPUT, FIXTURE);
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  await expect(page.locator(CHIP_PHASE).last()).toHaveText(/Queued|Reading…/);

  const textarea = page.locator("textarea").first();
  await textarea.fill(DRAFT);
  await expect(textarea).toHaveValue(DRAFT);

  // Send disabled while processing, Enter is swallowed: ZERO chat requests,
  // the draft is untouched.
  await expect(page.locator(SEND)).toBeDisabled();
  await textarea.press("Enter");
  await expect(page.locator(SEND)).toBeDisabled();
  await expect(textarea).toHaveValue(DRAFT);
  await page.waitForTimeout(3_000); // still mid-read: Enter again, still silent
  await textarea.press("Enter");
  await expect(textarea).toHaveValue(DRAFT);
  expect(chatRequests, "Enter while processing must fire 0 chat requests").toHaveLength(0);
  expect(await chip.getAttribute("data-status")).toMatch(/pending|processing/);

  // Enable at evidence+restore done: the extract response lands "ready"
  // (evidence persisted + restoration completed inside the request, B10),
  // the gate opens, ONE click sends exactly ONE request.
  await expect(chip).toHaveAttribute("data-status", "ready", { timeout: 180_000 });
  await expect(page.locator(SEND)).toBeEnabled();
  await page.locator(SEND).click();
  await expect.poll(() => chatRequests.length, { timeout: 15_000 }).toBe(1);
  expect(chatRequests.length, "one click = one request, never a queue").toBe(1);

  // Draft consumed by the send (it became the message, not a leftover queue).
  await expect(textarea).toHaveValue("");

  // The row grades the gate, not the answer — stop the turn to free the slot.
  const stop = page.getByRole("button", { name: "Stop generating" });
  if (await stop.isVisible().catch(() => false)) await stop.click();
});
