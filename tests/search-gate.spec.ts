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
 * MHR UPDATE (2026-11-05, 6321251 — supersedes the gate mechanics above
 * for CHAT turns; the gate still serves the app/api/search surfaces and
 * stays unit-covered there): every chat turn arms the model's web-tool
 * loop and the MODEL decides whether to search. The pre-model gate, its
 * prefetched evidence, and the authority badge + query lines are GONE
 * from the chat path — searchGateMeta is pinned null in
 * app/api/chat/route.ts, so a fresh chat turn renders NO badge; the
 * badge/Q-line UI persists only for turns saved by gate-era sessions.
 * The live-fact test therefore pins: the model searches (toggle appears),
 * the trail records sources, no badge appears on this turn, and no source
 * carries the documented off-topic/journal-contamination signatures (host
 * relevance itself is structurally floored in metasearch, unit-covered).
 * The model loop also receives
 * the app-restored conversation as context, so this suite starts a
 * FRESH chat — otherwise the restored chat's research replays into this
 * turn (2026-11-07 run: a restored browser-journey chat's GSRTC /
 * MakeMyTrip travel source set surfaced as "18 sources" for the
 * GPU-price query, zero NVIDIA hits).
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

/**
 * Count this page's assistant bubbles BEFORE sending. The app RESTORES the
 * previous conversation on goto("/") (verified behavior), so restored turns
 * can carry inline [S#] citation pills (a[data-citation]) from EARLIER
 * sessions. A "no search happened" assertion must therefore be scoped to
 * THIS turn's bubble (index = prior count), never the whole page — same
 * race family as the universal-websites helper fix. Returns the prior count.
 */
async function sendPrompt(
  page: import("@playwright/test").Page,
  text: string,
  opts: { freshChat?: boolean } = {},
): Promise<number> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  if (opts.freshChat) {
    // Drop the restored conversation (if any) so the model's tool loop
    // and the no-search assertions see ONLY this turn's prompt.
    await page.getByTestId("sidebar-new-chat").click();
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
  }
  const priorAssistant = await page
    .locator('[data-testid="assistant-message"]')
    .count();

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
  return priorAssistant;
}

/**
 * Locator for the bubble this turn mounted (index = pre-send count in both
 * fresh-chat and restored-chat modes). Falls back to the page scope if the
 * bubble never appeared (then the global assertion still fails loudly).
 */
function turnScope(page: import("@playwright/test").Page, priorAssistant: number) {
  return page.locator('[data-testid="assistant-message"]').nth(priorAssistant);
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

  const priorAssistant = await sendPrompt(page, PALINDROME_PROMPT, { freshChat: true });

  // The gate answers in a few seconds; give the whole turn time to settle.
  await page.waitForTimeout(60000);

  // 1) No clickable search line, no sources popup, no gate badge, no
  // citation pills. (Located by testid/data-attr, not visible text.)
  // The toggle/popup/badge are per-turn ephemeral processing UI and were
  // never restored by prior sessions, so a page-global zero is valid for
  // them; the inline citation pills ARE persisted in restored history, so
  // the pill assertion is scoped to this turn's own bubble.
  await expect(page.getByTestId("web-search-toggle")).toHaveCount(0);
  await expect(page.getByTestId("research-trail-card")).toHaveCount(0);
  await expect(page.getByTestId("research-trail-gate-badge")).toHaveCount(0);
  await expect(turnScope(page, priorAssistant).locator("a[data-citation]")).toHaveCount(0);

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

  const priorAssistant = await sendPrompt(page, "Can you give me rust code for leetcode problem 23. Merge k sorted lists", { freshChat: true });
  await page.waitForTimeout(60000);

  // A search is only acceptable if the cited sources are on-topic; the
  // garbage pool (messaging apps / help centers / mapping sites) is not.
  // After the answer streams, the cited sources are the [S#] citation
  // pills — scoped to THIS turn's bubble so restored history can't pollute.
  const pills = turnScope(page, priorAssistant).getByTestId("citation-pill").locator("a");
  if ((await pills.count()) > 0) {
    const hrefs = await pills
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    expect(hrefs.length).toBeGreaterThan(0);
    const junk = hrefs.filter((h) => /whatsapp|waze\.com|output\.com|youtu\.?be/i.test(h));
    expect(junk, `off-topic sources cited for a LeetCode query: ${junk.join(", ")}`).toEqual([]);
  }
});

test("live-fact question triggers model-directed search with on-topic sources", async ({ page }) => {
  test.setTimeout(200000);

  await sendPrompt(page, "What is the NVIDIA RTX 5090 graphics card price in India right now?", {
    freshChat: true,
  });

  // While the model's web tool loop is running (before the first answer
  // token) the RUKE processing line becomes clickable; open the sources popup.
  const toggle = page.getByTestId("web-search-toggle").first();
  await expect(toggle).toBeVisible({ timeout: 170000 });
  await toggle.click();

  const popup = page.getByTestId("research-trail-card").first();
  await expect(popup).toBeVisible();

  // MHR pin: a chat turn never emits gate meta (app/api/chat/route.ts pins
  // searchGateMeta null), so NO authority badge may appear on a fresh turn.
  // The badge component remains only for turns persisted by gate-era
  // sessions; gate decision semantics stay unit-covered on the
  // app/api/search surfaces (__tests__/web-search/**).
  await expect(page.getByTestId("research-trail-gate-badge")).toHaveCount(0);

  // Every source in the popup must be plausibly on-topic. Under MHR the
  // popup renders ONLY hostnames (gate queries/badge are gate-era only), so
  // a positive subject match ("nvidia|rtx" in a host) is impossible even for
  // a perfect run (sclgaming.in, serverbasket.com, techspot.com...). The
  // subject anchor is enforced STRUCTURALLY by the metasearch per-result
  // relevance floor (unit-covered, __tests__/web-search/**); this pin guards
  // the two documented failure signatures instead:
  //   • the original garbage pool (WhatsApp / Waze / Output.com), and
  //   • the 2026-11-07 journal-contamination replay — travel sources from a
  //     stale conversation surfacing for a GPU query (GSRTC / MakeMyTrip).
  const hrefs = await popup
    .locator("a[href]")
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.length).toBeGreaterThan(0);
  const junk = hrefs.filter((h) =>
    /whatsapp|waze\.com|output\.com|gsrtc|makemytrip|redbus|cleartrip|yatra|irctc|abhibus/i.test(h),
  );
  expect(junk, `off-topic sources cited for a GPU-price query: ${junk.join(", ")}`).toEqual([]);

  // Same negative guard on the rendered popup text (hosts): no travel
  // contamination signature may appear.
  const popupText = await popup.innerText();
  expect(
    popupText.toLowerCase(),
    "journal-contamination signature (travel sources) in the trail popup",
  ).not.toMatch(/gsrtc|makemytrip|redbus|udaipur|modasa|irctc/);
});
