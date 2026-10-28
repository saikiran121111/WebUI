import { test, expect } from "@playwright/test";

/**
 * PART 10: explicit YouTube caption journey (regression candidate B —
 * captions RPC, fixed in b4b5e94). Asks for the SPOKEN content of the same
 * video the universal suite links (youtu.be/zinbNw7L8xI), so a correct
 * answer requires the transcript path: Rust youtube_bridge → POST
 * /api/internal/youtube-evidence (loopback secret, 90 s deadline) → Node
 * caption fetch → evidence → main model.
 *
 * Honesty rules baked into the assertions:
 * - We assert the model does NOT refuse access and that any citation pills
 *   point at the video itself. We deliberately do NOT pin specific spoken
 *   words: model phrasing is nondeterministic, and if YouTube genuinely
 *   serves no caption track for this video the honest answer is "no
 *   captions" — that outcome must be reported as a future-enhancement
 *   finding, never faked and never treated as an app regression.
 * - One attempt only. No hammering: if Google/YouTube rate-limits this IP,
 *   the run records that as the finding (CAPTCHA cooldown policy).
 *
 * Model-backed: run only under the Playwright lock, workers:1.
 */

const INPUT = "textarea[placeholder^='How can I help']";

const REFUSAL_PATTERNS = [
  /i can'?t (open|watch|browse|access|read|view) (this|that|the|your) (link|video|page|url)/i,
  /i'?m (un)?able to (open|watch|browse|access|read|view) (this|that|the|your) (link|video|page|url)/i,
  /i cannot (open|watch|browse|access|read|view) (this|that|the|your) (link|video|page|url)/i,
  /as (an )?ai( assistant)?, i (don'?t| can'?t) (have )?(access|browse|watch)/i,
  /i don'?t have (access|the ability) to (browse|watch|view|read) (the|this|that|a|your)/i,
];

test("spoken-content question about a YouTube video is answered from evidence, not refused", async ({ page }) => {
  test.setTimeout(240_000);

  const prompt =
    "For this video — https://youtu.be/zinbNw7L8xI — what does the speaker actually say in the first minute? Quote or paraphrase his own words.";

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

  // Access-refusal (as opposed to an honest "this video has no captions" —
  // which is a legitimately different sentence) must not appear.
  for (const re of REFUSAL_PATTERNS) {
    expect(re.test(text), `access-refusal detected: ${re}`).toBe(false);
  }

  // If the answer cites, every pill must point at the video (evidence came
  // from this URL — the youtube-evidence RPC response), never a junk pool.
  const pills = page.getByTestId("citation-pill").locator("a");
  if ((await pills.count()) > 0) {
    const hrefs = await pills.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    const offVideo = hrefs.filter((h) => !/youtu\.?be/i.test(h));
    expect(offVideo, `citations for a YouTube question must reference the video: ${offVideo.join(", ")}`).toEqual([]);
  }
});
