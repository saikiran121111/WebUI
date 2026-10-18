import { test, expect, type Page } from "@playwright/test";

/**
 * Stage-aware progress UI: the in-bubble "Analysing the prompt…" status line
 * during prefill, and the robot toast lifecycle around a DOCX download
 * (appears while building → celebrates → disappears on its own).
 *
 * Follows the regression_modalities conventions: dev server on
 * http://localhost:3000 with the /api/chat upstream mocked via page.route.
 */

const ASSISTANT_DONE = '[data-testid="assistant-message"][data-state="complete"]';

/** Respond to POST /api/chat with `content` in SSE frames, optionally held
 *  back for `delayMs` first so the prefill status line is observable.
 *  `decisionMode` carries the Decision Engine's x-decision-mode header: the UI
 *  mounts/validates renderers ONLY for that mode, so fence-based assertions
 *  need the matching mode or the preview never appears. */
async function mockStream(page: Page, content: string, decisionMode = "standard_chat", delayMs = 0, chunkSize = 64): Promise<void> {
  await page.route("**/api/chat", async (route) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const frames: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + chunkSize) } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "x-decision-mode": decisionMode },
      body: frames.join(""),
    });
  });
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

test.describe("stage-aware progress", () => {
  test("prefill status line shows before the first token, then clears", async ({ page }) => {
    await mockStream(page, "Here is the answer you asked for.", "standard_chat", 1500);
    await page.goto("http://localhost:3000/");
    await send(page, "slow hello");

    const status = page.getByTestId("generation-status");
    await expect(status).toBeVisible({ timeout: 3000 });
    await expect(page.getByText("Analysing the prompt…")).toBeVisible();

    await expect(page.locator(ASSISTANT_DONE).first()).toBeVisible({ timeout: 20_000 });
    await expect(status).toBeHidden();
  });

  test("DOCX download raises the robot toast, then it celebrates and goes away", async ({ page }) => {
    const docx = JSON.stringify({
      filename: "toast-test",
      sections: [
        { type: "heading", level: 1, text: "Toast Test" },
        { type: "paragraph", text: "Progress toast regression." },
      ],
    });
    await mockStream(page, "```docx\n" + docx + "\n```", "docs");
    await page.route("**/api/documents/docx", (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": 'attachment; filename="toast-test.docx"',
        },
        body: Buffer.from("PKmock-docx"),
      }),
    );

    await page.goto("http://localhost:3000/");
    await send(page, "make a word doc");
    await page.locator(ASSISTANT_DONE).first().waitFor({ timeout: 20_000 });
    await expect(page.getByTestId("docx-preview")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.getByRole("button", { name: "Download DOCX file" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("toast-test.docx");

    const toast = page.getByTestId("robot-toast");
    await expect(toast).toBeVisible();
    await expect(toast.getByText("Building DOCX")).toBeVisible();

    // Success: bar snaps to 100%, robot celebrates, toast auto-dismisses.
    await expect(toast).toBeHidden({ timeout: 10_000 });
  });
});
