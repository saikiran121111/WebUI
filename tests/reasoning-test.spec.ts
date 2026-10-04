import { test, expect } from "@playwright/test";

const WINDOW_TIMEOUT = 60000;

test("reasoning: UI shows reasoning content and 'View reasoning' button", async ({ page }) => {
  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(1500);

  const UNIQUE = "reasoning-" + Date.now().toString(36);
  const input = page.locator("textarea").first();
  await input.click();
  await input.fill(`Reply with exactly: ${UNIQUE}`);
  await input.press("Enter");

  // Wait for generation to finish
  await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: WINDOW_TIMEOUT });
  await page.waitForTimeout(2000);

  // Check reasoning UI is present — use text-based selector
  const viewReasoningBtn = page.locator('button:has-text("View reasoning")');
  await expect(viewReasoningBtn).toHaveCount(1, { timeout: 30000 });

  // Click to expand reasoning
  await viewReasoningBtn.click();
  await page.waitForTimeout(500);

  // Expanded reasoning text should be visible
  const expanded = page.locator(".thinking-expanded");
  await expect(expanded).toHaveCount(1, { timeout: 10000 });

  const expandedText = await expanded.innerText();
  expect(expandedText.length).toBeGreaterThan(5);

  // Final answer contains the unique token
  const body = await page.evaluate(() => document.body.innerText);
  expect(body).toContain(UNIQUE);
});
