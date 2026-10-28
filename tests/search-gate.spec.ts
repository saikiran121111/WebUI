import { test, expect } from "@playwright/test";

/**
 * Search-gate regression suite for the two reported bugs:
 *
 * 1) GARBAGE SEARCH on a pure algorithm prompt. The LeetCode
 *    palindrome-partitioning prompt (plus a Rust stub) used to trigger a
 *    web search whose sources were WhatsApp Web, YouTube Help, Waze,
 *    Output.com and a ChatGPT GitHub topic page. Root causes fixed:
 *      • the LFM2.5-1.2B router (measured 55% on
 *        scripts/eval-search-gate.mjs) is no longer the authority — the
 *        main model decides (measured 100%);
 *      • the main model writes keyword-form, entity-anchored queries
 *        instead of echoing the whole prompt;
 *      • metasearch() now applies a per-result lexical relevance floor to
 *        the fused general-web pool, so a page that shares no core
 *        subject token with the queries can never be cited.
 *
 * 2) A live-fact question refused by the router. The main model's "yes"
 *    can never be vetoed by the router again, and the sources popup badge
 *    names the authority that actually decided ("Model-gated").
 *
 * UI contract (2026-10-22f): the cyan gradient ResearchTrailCard bar was
 * removed. During the pre-first-token search phase the RUKE processing
 * line becomes clickable (`web-search-toggle`) and opens a popup
 * (`research-trail-card`) with the queries + source links; clicking
 * outside closes it. After the answer streams, sources stay reachable
 * through the [S#] citation pills (`a[data-citation]`).
 */

// Selector migrated with the landing redesign: the hero composer's
// placeholder is now "How can I help you today?".
const INPUT = "textarea[placeholder^='How can I help']";

async function sendPrompt(page: import("@playwright/test").Page, text: string) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const input = page.locator(INPUT);
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(text);

  const send = page.getByTestId("send-button");
  await expect(send).toBeEnabled({ timeout: 15000 });
  await send.click();

  await page
    .getByText(text.slice(0, 40), { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
}

/** The exact prompt from the bug report (algorithm + Rust stub). */
const PALINDROME_PROMPT = `Given a string s, partition s such that every substring of the partition is a palindrome. Return the minimum cuts needed for a palindrome partitioning of s.

impl Solution {
    pub fn min_cut(s: String) -> i32 {

    }
}`;

test("pure LeetCode algorithm prompt triggers NO web search", async ({ page }) => {
  test.setTimeout(150000);
  const unhandledErrors: string[] = [];
  page.on("pageerror", (err) => unhandledErrors.push(err.message));

  await sendPrompt(page, PALINDROME_PROMPT);

  // The gate answers in a few seconds; give the whole turn time to settle.
  await page.waitForTimeout(60000);

  // 1) No clickable search line, no sources popup, no gate badge, no
  // citation pills. (Located by testid/data-attr, not visible text.)
  await expect(page.getByTestId("web-search-toggle")).toHaveCount(0);
  await expect(page.getByTestId("research-trail-card")).toHaveCount(0);
  await expect(page.getByTestId("research-trail-gate-badge")).toHaveCount(0);
  await expect(page.locator("a[data-citation]")).toHaveCount(0);

  // 2) The answer itself arrived (an algorithm answer is long + has code).
  const mainText = await page.locator("main").first().innerText();
  expect(mainText.length).toBeGreaterThan(200);
  expect(mainText.toLowerCase()).toContain("palindrome");

  // 3) No runtime crash.
  const crashes = unhandledErrors.filter((m) => /Cannot read properties of undefined/.test(m));
  expect(crashes).toEqual([]);
});

test("named LeetCode problem the model knows needs no search", async ({ page }) => {
  test.setTimeout(150000);

  await sendPrompt(page, "Can you give me rust code for leetcode problem 23. Merge k sorted lists");
  await page.waitForTimeout(60000);

  // A search is only acceptable if the cited sources are on-topic; the
  // garbage pool (messaging apps / help centers / mapping sites) is not.
  // After the answer streams, the cited sources are the [S#] citation pills.
  const pills = page.getByTestId("citation-pill").locator("a");
  if ((await pills.count()) > 0) {
    const hrefs = await pills
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    expect(hrefs.length).toBeGreaterThan(0);
    const junk = hrefs.filter((h) => /whatsapp|waze\.com|output\.com|youtu\.?be/i.test(h));
    expect(junk, `off-topic sources cited for a LeetCode query: ${junk.join(", ")}`).toEqual([]);
  }
});

test("live-fact question searches and is labelled Auto-gated with on-topic sources", async ({ page }) => {
  test.setTimeout(200000);

  await sendPrompt(page, "What is the NVIDIA RTX 5090 graphics card price in India right now?");

  // While the gated search is running (before the first answer token) the
  // RUKE processing line becomes clickable; open the sources popup.
  const toggle = page.getByTestId("web-search-toggle").first();
  await expect(toggle).toBeVisible({ timeout: 170000 });
  await toggle.click();

  const popup = page.getByTestId("research-trail-card").first();
  await expect(popup).toBeVisible();

  // The badge names the AUTHORITY. Since the approved universal pre-gate
  // deviation (MIGRATION-MAP §11.1), the live-intent word "price" in this
  // prompt is force-YESed by the deterministic Stage-0 web-intent rule
  // BEFORE the model is ever consulted — the authority for THIS prompt is
  // now the pre-gate, so the badge must read "Auto-gated". The assertion
  // still names the authority that actually decided (never weakened); the
  // model-gated path itself is exercised by the gray-middle unit matrix in
  // __tests__/web-search/search-gate-universal.test.ts.
  const badge = page.getByTestId("research-trail-gate-badge").first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Auto-gated");

  // Every cited source in the popup must be plausibly on-topic.
  const hrefs = await popup
    .locator("a[href]")
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.length).toBeGreaterThan(0);
  const junk = hrefs.filter((h) => /whatsapp|waze\.com|output\.com/i.test(h));
  expect(junk, `off-topic sources cited for a GPU-price query: ${junk.join(", ")}`).toEqual([]);

  // The queries shown in the popup must be keyword-form, not the raw prompt.
  const popupText = await popup.innerText();
  expect(popupText.toLowerCase()).toContain("nvidia");
});
