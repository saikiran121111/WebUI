import { test, expect } from "@playwright/test";

// This test deliberately keeps reasoning ON — under full-suite load the local
// model streams its thinking for well over a minute. The old 60 s window was
// identical to the default test timeout, so the assertion could never get its
// full patience.
const WINDOW_TIMEOUT = 150_000;

test("reasoning: UI shows reasoning content and 'View reasoning' button", async ({ page }) => {
  // Two attempts × the 150 s window + assertion slack.
  test.setTimeout(420_000);

  // Observed in-suite (pw-final3): the model rambled inside its thinking block
  // for the whole 150 s window — the stream stayed open (POST /api/chat 200 in
  // 150536ms) and the unterminated-think scrubber kept the answer area empty.
  // The same prompt standalone completes in ~1.5 s. That is the same
  // real-model nondeterminism family file-reading already retries once for,
  // so give this journey one bounded retry on a guaranteed-fresh conversation.
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto("http://localhost:3000/");
    await page.waitForTimeout(1500);
    if (attempt === 2) {
      // Never resume the hung conversation — start clean.
      await page.locator("aside").getByRole("button", { name: "New conversation" }).click();
      await page.waitForTimeout(800);
    }

    const UNIQUE = "reasoning-" + Date.now().toString(36) + (attempt === 2 ? "-r2" : "");
    const input = page.locator("textarea").first();
    await input.click();
    await input.fill(`Reply with exactly: ${UNIQUE}`);
    await input.press("Enter");

    // Wait for generation to finish
    try {
      await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: WINDOW_TIMEOUT });
    } catch (err) {
      if (attempt < 2) {
        console.log("  reasoning-test: turn exceeded the window, retrying once");
        continue;
      }
      throw err;
    }
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
    return;
  }
});
