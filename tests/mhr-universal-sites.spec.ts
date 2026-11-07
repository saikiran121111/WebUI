/**
 * MHR-G (WS27) LEVEL 3 — UNIVERSALITY journeys through the REAL browser UI.
 *
 * The user law: the web-search harness is universal — no site vocabulary,
 * no hardcoded retailers. These journeys exercise that law end-to-end in
 * the UI across retailers/locales the harness has never heard of (the
 * prompts are the same sentences the level-2 evals pin semantically; the
 * semantic fabrication law lives in __tests__/manual/mhr-g-model-eval.test.ts,
 * NOT duplicated here).
 *
 * What the browser proves (UI-surface harness truth):
 *   TOOL USE + EVIDENCE — the turn COMPLETES (data-state="complete") and
 *     either (a) real-href server-minted citation pills rendered (minting
 *     requires model-driven web rounds on this turn), or (b) the released
 *     answer HONESTLY names an access wall / evidence gap. Both outcomes
 *     are harness-correct; silent hallucinated "answers" with neither are
 *     the failure this spec kills.
 *   MULTI-PORTAL SPREAD — the job-roles journey additionally pins that
 *     when pills rendered, they span >= 2 distinct hosts (the model rode
 *     more than one portal), mirroring the eval-side host-spread law.
 *   RELEASE INTEGRITY — harness feedback text never reaches the DOM.
 *
 * Soft-gate rationale (mirrors tests/universal-websites.spec.ts
 * HONEST_WALL branch): WAF/anti-bot walls are an infra reality the harness
 * cannot delete; the harness law is honest reporting of what was actually
 * retrieved, not guaranteed retrieval from every site.
 *
 * RUN: one journey per exclusive launcher invocation (single-owner model
 * traffic):
 *   powershell -NoProfile -File scripts\run-browser-e2e-exclusive.ps1 `
 *       -TestFiles tests\mhr-universal-sites.spec.ts -Grep "MUNU-<n>"
 */
import { test, expect } from "@playwright/test";

const INPUT = "textarea[placeholder^='How can I help']";

/** MHR-D feedback contract text must NEVER surface in the human DOM. */
const FEEDBACK_SIGNATURE = "held back and NOT released";

/**
 * Honest access-wall / evidence-gap disclosure signatures. These are the
 * harness's instructed behavior (web-tool-loop guidance: report what was
 * actually retrieved), tested as a UI surface — NOT a harness semantic
 * exception (no such phrase logic exists in product code).
 */
const HONEST_WALL =
  /bot[- ]?(check|block|verification)|anti-?bot|blocked|wall|region|interstitial|could(?:n'?t| not)(?: (?:actually )?(?:retrieve|confirm|access|get|load|find|verify|see))?|was(?:n'?t| not) (?:able|retriev)|no (?:product )?listings|didn'?t (?:load|return)|came back blocked/i;

async function sendPrompt(
  page: import("@playwright/test").Page,
  text: string,
  opts: { freshChat?: boolean } = {},
): Promise<number> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
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

  const input = page.locator(INPUT);
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(text);
  const send = page.getByTestId("send-button");
  // Hydration race (universal-websites law): re-fill once if the composer
  // never saw the pre-hydration text.
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
  deadlineMs = 900_000, // sized to the 2026-11-07 budget re-tune (8-round standard)
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
 * Harness-truth assertions for ONE completed research turn against an
 * arbitrary (never-hardcoded) website: released answer + grounded pills
 * OR honest wall disclosure + zero feedback leakage. Returns the pill
 * hrefs (possibly empty in the honest-wall branch).
 */
async function expectGroundedOrHonestTurn(
  page: import("@playwright/test").Page,
  priorAssistant: number,
): Promise<string[]> {
  const bubble = page.locator('[data-testid="assistant-message"]').nth(priorAssistant);
  const answer = (await bubble.locator(".msg-content").first().innerText()).trim();
  console.log(`[mhr-uni] bubble=${priorAssistant} answer=${JSON.stringify(answer.slice(0, 300))}`);
  expect(answer.length, "released answer is empty/trivial").toBeGreaterThan(40);

  const pills = bubble.getByTestId("citation-pill").locator("a");
  const hrefs = await pills.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  const realHrefs = hrefs.filter((h) => /^https?:\/\//.test(h));

  if (realHrefs.length === 0) {
    // No minted citations on this turn — the ONLY harness-correct
    // alternative is an explicit honest wall/gap disclosure.
    expect(
      answer,
      "no citation pills AND no honest access-wall disclosure (unreported gap or ungrounded answer)",
    ).toMatch(HONEST_WALL);
  }

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
  return realHrefs;
}

test("MUNU-1 Amazon phones query grounds or honestly names the wall", async ({ page }) => {
  test.setTimeout(950_000);
  const prior = await sendPrompt(page, "best phones under 20k in amazon", { freshChat: true });
  await waitForAnswer(page, prior);
  await expectGroundedOrHonestTurn(page, prior);
});

test("MUNU-2 Best Buy cheapest-laptop query grounds or honestly names the wall", async ({ page }) => {
  test.setTimeout(950_000);
  const prior = await sendPrompt(page, "what is the cheapest laptop I can buy in bestbuy", {
    freshChat: true,
  });
  await waitForAnswer(page, prior);
  await expectGroundedOrHonestTurn(page, prior);
});

test("MUNU-3 local-area restaurant query reaches a grounded local outcome", async ({ page }) => {
  test.setTimeout(950_000);
  const prior = await sendPrompt(
    page,
    "find best restaurant near manikonda area in hyderabad",
    { freshChat: true },
  );
  await waitForAnswer(page, prior);
  await expectGroundedOrHonestTurn(page, prior);
});

test("MUNU-4 AI/ML job-roles query spans multiple portals", async ({ page }) => {
  test.setTimeout(950_000);
  const prior = await sendPrompt(
    page,
    "find the job roles for AI ML engineer and where I can apply them",
    { freshChat: true },
  );
  await waitForAnswer(page, prior);
  const hrefs = await expectGroundedOrHonestTurn(page, prior);
  if (hrefs.length > 0) {
    // Multi-portal law (mirrors the eval-side >=2-host rule) — only
    // enforceable when this turn actually minted citations.
    const hosts = new Set(
      hrefs.map((h) => new URL(h).hostname.replace(/^www\./, "")),
    );
    expect(
      hosts.size,
      `job-roles turn cited only ${[...hosts].join(", ")} — no portal spread`,
    ).toBeGreaterThanOrEqual(2);
  }
});
