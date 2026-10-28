import { test, expect } from "@playwright/test";

/**
 * PART 10: REAL Tier-3b validation — the new cross-language RPC hop
 * (Rust web-search pipeline → POST /api/internal/browser-read with the
 * loopback secret → the live lib/web-search/agentBrowser Playwright pool
 * inside the Next server → evidence back into the Rust ranking). Mocks and
 * scripted bridges are no longer sufficient; this exercises the hop over
 * the wire, end to end, through the real chat UI.
 *
 * The target is deliberately JavaScript-only: https://quotes.toscrape.com/js
 * ships an empty body — the quote text only exists after client-side JS
 * runs — so the HTTP tiers of the waterfall cannot extract it and the
 * extraction necessarily falls through to the Tier-3b browser tier. The
 * page is a scraping-practice sandbox: no CAPTCHA, stable seeded content,
 * first quote authored by Albert Einstein.
 *
 * Model-backed: run only under the Playwright lock, workers:1. The
 * companion PHASE C check confirms browser-read RPC activity in the
 * supervisor log.
 */

const INPUT = "textarea[placeholder^='How can I help']";

const REFUSAL_PATTERNS = [
  /i can'?t (open|watch|browse|access|read|visit) (this|that|the) (link|video|page|website|url|site)/i,
  /i'?m (un)?able to (open|watch|browse|access|read|visit) (this|that|the) (link|video|page|website|url|site)/i,
  /i cannot (open|watch|browse|access|read|visit) (this|that|the) (link|video|page|website|url|site)/i,
  /as (an )?ai( assistant)?, i (don'?t| can'?t) (have )?(access|browse|open|watch)/i,
  /i don'?t have (access|the ability) to (browse|open|watch|read|visit) (the|this|that|a)/i,
];

test("Tier-3b browser-read renders a JS-only page and the answer quotes it", async ({ page }) => {
  test.setTimeout(240_000);

  const prompt =
    "Open https://quotes.toscrape.com/js/ and tell me the author of the first quote on that page.";

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const input = page.locator(INPUT);
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(prompt);
  const send = page.getByTestId("send-button");
  await expect(send).toBeEnabled({ timeout: 15000 });
  await send.click();
  await page
    .getByText(prompt.slice(0, 40), { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 15000 });

  // Dynamic settle (same patience idiom as universal-websites).
  const t0 = Date.now();
  let lastLen = 0;
  let stable = 0;
  while (Date.now() - t0 < 180_000) {
    const text = await page.locator("main").first().innerText().catch(() => "");
    if (text.length > 40 && text.length === lastLen) {
      if (++stable >= 3) break;
    } else stable = 0;
    lastLen = text.length;
    await page.waitForTimeout(2_000);
  }

  const text = await page.locator("main").first().innerText();
  expect(text.length, "answer must be non-empty").toBeGreaterThan(40);
  for (const re of REFUSAL_PATTERNS) {
    expect(re.test(text), `access-refusal detected: ${re}`).toBe(false);
  }
  // JS-rendered content could only have come through the browser tier: the
  // seeded first quote on that page is Einstein's.
  expect(text.toLowerCase(), "Einstein = proof the JS-only page was rendered by Tier-3b").toContain("einstein");
});
