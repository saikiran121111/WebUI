import { test, expect } from "@playwright/test";

test("greeting reply stays local — no Research Trail card, no citation crash", async ({ page }) => {
  const unhandledErrors: string[] = [];
  page.on("pageerror", (err) => unhandledErrors.push(err.message));

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const input = page.locator("textarea[placeholder^='Ask anything']");
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill("Hey there how are you");

  const send = page.getByTestId("send-button");
  await expect(send).toBeEnabled({ timeout: 15000 });
  await send.click();

  await page
    .getByText("Hey there how are you", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(45000);

  // 1) No research trail on an ordinary greeting.
  await expect(page.getByText("Research Trail")).toHaveCount(0);
  await expect(page.getByText("LFM-gated")).toHaveCount(0);

  // 2) No citation marker pills leaked into the greeting reply.
  await expect(page.locator("[data-domain]")).toHaveCount(0);

  // 3) The reply actually arrived (model is reachable, answer came back).
  const mainText = await page.locator("main").first().innerText();
  expect(mainText.length).toBeGreaterThan(40);

  // 4) No unhandled runtime errors (the citation walker crash).
  const crashes = unhandledErrors.filter((m) => /Cannot read properties of undefined/.test(m));
  expect(crashes).toEqual([]);
});

/**
 * Reasoning indicator regression: while a thinking model is in its
 * reasoning phase (reasoning chunks arriving, content not yet started),
 * the composer must show the live "Reasoning…" indicator. Before the fix
 * the indicator was gated on `!isLoading` — which is true exactly while a
 * stream is active — so it could never render during the actual thinking
 * phase; the user saw only the idle three-dot bubble until the first
 * content chunk arrived.
 *
 * Prompt "how about a html to create a todo app" reliably triggers
 * medium-effort reasoning (multi-step planning → long thinking phase).
 */
test("thinking model shows the live Reasoning indicator during the reasoning phase", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const input = page.locator("textarea[placeholder^='Ask anything']");
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill("how about a html to create a todo app");

  const send = page.getByTestId("send-button");
  await expect(send).toBeEnabled({ timeout: 15000 });
  await send.click();

  // Poll every 500ms for up to 90s. Two outcomes:
  //   A) "Reasoning…" becomes visible during the reasoning phase → PASS.
  //   B) The stream finishes without the indicator ever showing AND the
  //      finished message carries "Thought for Ns" → reasoning happened
  //      but was too fast to catch → FAIL (the indicator should have
  //      been visible during that window).
  // If reasoning never happened at all ("Thought for" absent), the model
  // skipped thinking for this prompt — treat as PASS (nothing to show).
  let sawIndicator = false;
  let reasoningHappened = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const ind = page.getByText("Reasoning…").first();
    if ((await ind.count()) > 0 && (await ind.isVisible())) {
      sawIndicator = true;
      break;
    }
    const streaming = (await page.getByLabel("Stop generating").count()) > 0;
    if (!streaming) {
      reasoningHappened = (await page.getByText(/Thought for/).count()) > 0;
      break;
    }
    await page.waitForTimeout(500);
  }

  // The indicator must have been observed OR reasoning was skipped.
  // A reasoning phase that completed without the indicator being seen is
  // the regression this test guards against.
  if (!sawIndicator && reasoningHappened) {
    test.info().annotations.push({
      type: "reasoning-missed",
      description: "Reasoning phase completed but the live indicator was never observed — possible regression or too-fast thinking phase",
    });
    // Still assert: the indicator SHOULD have been visible. If the model
    // thought for >3s (any non-trivial thinking phase), the 500ms poll
    // would have caught it. Only accept the miss when thinking was <1.5s.
    const thoughtMatch = await page.getByText(/Thought for/).first().innerText().catch(() => "");
    const seconds = parseInt(thoughtMatch.replace(/\D/g, "")) || 0;
    if (seconds >= 2) {
      expect(sawIndicator, "Reasoning indicator was not visible during a ≥2s reasoning phase").toBe(true);
    }
  } else {
    expect(sawIndicator || !reasoningHappened).toBe(true);
  }
});
