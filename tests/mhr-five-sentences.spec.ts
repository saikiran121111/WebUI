/**
 * MHR-G (WS27) LEVEL 3 — the five user-reported failing sentences through
 * the REAL browser UI on the current build (MHR acceptance surface).
 *
 * What this proves (harness truth, never canned text):
 *   TOOL USE + EVIDENCE — released answers carry [S#] citation pills whose
 *     anchors have real hrefs; pills can only exist for SERVER-MINTED
 *     citations, and minting requires the model to have driven web tool
 *     rounds on this turn.
 *   RELEASE INTEGRITY — the turn COMPLETES (data-state="complete" per the
 *     b4f9db0 honest-endings contract) and no harness feedback text ever
 *     reaches the human-visible DOM (MHR-D/FEEDBACK_HEADER law).
 *   JOURNAL LAW (sentence 5) — an informational follow-up inside the same
 *     chat still rides the prior turn's minted aliases (fresh-chat journal
 *     key + priorCitations restore, cfea00e surface).
 *
 * These are the exact user sentences (acceptance targets, not vocabulary —
 * the harness may not special-case them; the harness-side law itself is
 * unit-covered in __tests__/chat/**, the model-quality half in
 * __tests__/manual/mhr-g-model-eval.test.ts level 2).
 *
 * Helpers mirror tests/search-gate.spec.ts (fresh-chat law, hydration
 * self-heal) and tests/universal-websites.spec.ts (bubble-scoped reads,
 * data-state completion wait — never a length heuristic, never `.last()`).
 *
 * RUN: one journey per exclusive launcher invocation (model traffic is
 * single-owner):
 *   powershell -NoProfile -File scripts\run-browser-e2e-exclusive.ps1 `
 *       -TestFiles tests\mhr-five-sentences.spec.ts -Grep "MHR-<n>"
 */
import { test, expect } from "@playwright/test";

const INPUT = "textarea[placeholder^='How can I help']";

/** MHR-D feedback contract text must NEVER surface in the human DOM. */
const FEEDBACK_SIGNATURE = "held back and NOT released";

async function sendPrompt(
  page: import("@playwright/test").Page,
  text: string,
  opts: { freshChat?: boolean; stay?: boolean } = {},
): Promise<number> {
  // `stay`: continue inside the CURRENT conversation. Home "/" ALWAYS
  // spawns a fresh chat — the trap that once sent MHR-5's follow-up into
  // its own conversation where the model honestly (and correctly) found
  // no prior research. Same-chat continuity is the journal-law premise.
  if (!opts.stay) {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  }
  if (opts.freshChat) {
    await page.getByTestId("sidebar-new-chat").click();
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
  }
  // Panel hygiene (user rescope 2026-11-07): every MHR journey is a
  // WEB-SEARCH journey — the interactive browser must never be armed.
  const panel = page.getByRole("complementary", { name: "Browser panel" });
  if (await panel.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Close browser panel" }).click();
    await expect(panel).toHaveCount(0);
  }
  const priorAssistant = await page.locator('[data-testid="assistant-message"]').count();

  // Conversation-view composer: placeholder differs ("Reply") but the
  // accessible name is identical in both variants (ChatInput.tsx:390).
  const input = opts.stay
    ? page.getByLabel("Message Ruke")
    : page.locator(INPUT);
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(text);
  const send = page.getByTestId("send-button");
  // Hydration race (universal-websites law): a pre-hydration fill leaves
  // React state empty; re-fill once so the composer sees the text.
  try {
    await expect(send).toBeVisible({ timeout: 3000 });
  } catch {
    await input.fill(text);
  }
  await expect(send).toBeEnabled({ timeout: 15000 });
  await send.click();
  try {
    await page
      .getByText(text.slice(0, 40), { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
  } catch {
    // Dead-click race: the click landed pre-hydration while React state
    // was still empty, so nothing was sent. Refill and click once more.
    await input.fill(text);
    await expect(send).toBeEnabled({ timeout: 15000 });
    await send.click();
    await page
      .getByText(text.slice(0, 40), { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
  }
  return priorAssistant;
}

/** This turn's bubble (universal-websites completion contract). */
async function waitForAnswer(
  page: import("@playwright/test").Page,
  priorAssistant: number,
  deadlineMs = 400_000,
) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if ((await page.locator('[data-testid="assistant-message"]').count()) > priorAssistant) {
      const reply = page.locator('[data-testid="assistant-message"]').nth(priorAssistant);
      const state = await reply.getAttribute("data-state").catch(() => null);
      if (state === "error")
        throw new Error(`chat failed: ${await reply.innerText().catch(() => "")}`);
      if (state === "complete") return;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `this turn's assistant reply never reached "complete" within ${deadlineMs}ms`,
  );
}

/**
 * Harness-truth assertions for ONE completed research turn: released
 * answer text (bubble-scoped), at least one real-href citation pill (this
 * is the tool-use + evidence + grounding proof in one: pills render only
 * for server-minted citations), and zero feedback-contract leakage.
 */
async function expectGroundedTurn(
  page: import("@playwright/test").Page,
  priorAssistant: number,
) {
  const bubble = page.locator('[data-testid="assistant-message"]').nth(priorAssistant);
  const answer = (await bubble.locator(".msg-content").first().innerText()).trim();
  console.log(`[mhr-five] bubble=${priorAssistant} answer=${JSON.stringify(answer.slice(0, 300))}`);
  expect(answer.length, "released answer is empty/trivial").toBeGreaterThan(40);

  const pills = bubble.getByTestId("citation-pill").locator("a");
  const hrefs = await pills.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(
    hrefs.filter((h) => /^https?:\/\//.test(h)).length,
    "no server-minted citation pill on this turn (model drove no web round, or the answer cites nothing)",
  ).toBeGreaterThan(0);

  const pageText = await page.locator("main").first().innerText();
  expect(pageText, "harness feedback text leaked to the human DOM").not.toContain(
    FEEDBACK_SIGNATURE,
  );

  // Web-search-only law (user rescope 2026-11-07): the interactive browser
  // must NEVER ride an MHR web-search journey — the panel never opened.
  await expect(
    page.getByRole("complementary", { name: "Browser panel" }),
    "a web-search journey has the interactive browser panel open (user rescope law 2026-11-07)",
  ).toHaveCount(0);
  return answer;
}

test("MHR-1 Find jobs in Hyderabad reaches a grounded outcome", async ({ page }) => {
  test.setTimeout(420_000);
  const prior = await sendPrompt(page, "Find jobs in Hyderabad", { freshChat: true });
  await waitForAnswer(page, prior);
  await expectGroundedTurn(page, prior);
});

test("MHR-2 Find apartments to rent in Tallinn reaches a grounded outcome", async ({ page }) => {
  test.setTimeout(420_000);
  const prior = await sendPrompt(page, "Find apartments to rent in Tallinn", { freshChat: true });
  await waitForAnswer(page, prior);
  await expectGroundedTurn(page, prior);
});

test("MHR-3 Research how to apply for jobs in Nairobi reaches a grounded outcome", async ({ page }) => {
  test.setTimeout(420_000);
  const prior = await sendPrompt(page, "Research how to apply for jobs in Nairobi", {
    freshChat: true,
  });
  await waitForAnswer(page, prior);
  await expectGroundedTurn(page, prior);
});

test("MHR-4 Find Amul Gold milk in Zepto reaches a grounded outcome", async ({ page }) => {
  test.setTimeout(420_000);
  const prior = await sendPrompt(page, "Find Amul Gold milk in Zepto", { freshChat: true });
  await waitForAnswer(page, prior);
  await expectGroundedTurn(page, prior);
});

test("MHR-5 purchase request then informational follow-up keeps journal aliases", async ({ page }) => {
  test.setTimeout(420_000);
  // Turn 1: the purchase request (user example 5's first turn).
  const t1Text = "Buy me the cheapest 65 inch TV under 40000 rupees with delivery in Hyderabad";
  const t1Prior = await sendPrompt(page, t1Text, { freshChat: true });
  await waitForAnswer(page, t1Prior);
  await expectGroundedTurn(page, t1Prior);

  // Turn 2: the informational follow-up in the SAME chat — the journal law
  // (cfea00e) must carry the prior turn's minted [S#] aliases into it.
  const t2Text = "What refresh rate does the best pick you found have?";
  const t2Prior = await sendPrompt(page, t2Text, { stay: true });
  await waitForAnswer(page, t2Prior);
  await expectGroundedTurn(page, t2Prior);
});
