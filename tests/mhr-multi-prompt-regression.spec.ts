/**
 * MPR (2026-11-07, user law): "regression test with multiple user prompts —
 * if you use once don't use the same again, try changing multiple prompts;
 * users sometimes ask deeper as well so query search goes deeper, give
 * response and CHECK THE RESPONSE as well of what it's provided."
 *
 * What this spec pins (all universal — prompts are ordinary user sentences,
 * no harness vocabulary rules anywhere):
 *  - PROMPT ROTATION: every launcher invocation consumes the NEXT prompt
 *    from a bank of distinct user phrasings across genres (shopping
 *    lineups, rentals, jobs, how-to, local). The cursor persists in the
 *    git-ignored .data/ store, so no prompt repeats until the whole bank
 *    has been used again — "used once" is remembered across runs.
 *  - DEEPER FOLLOW-UPS: the same chat is pressed with generic deepening
 *    turns (rank the actual lineup; then dig into the cheapest pick),
 *    which forces multi-round research and read_page into lineup pages —
 *    the exact starvation the 2026-11-07 budget unblock fixed.
 *  - RESPONSE CONTENT CHECK: the released answer itself is examined —
 *    non-trivial, and in the lineup turns it carries concrete retrieved
 *    detail (names/prices => digits) or honestly says what could not be
 *    retrieved. NO answer may confess harness budget starvation to the
 *    user ("ran out of tool budget" UX was the original complaint).
 *  - RELEASE INTEGRITY + WEB-SEARCH-ONLY law ride every turn (no
 *    harness-feedback text in the DOM; the interactive browser panel never
 *    opens on a web-search journey).
 *
 * Soft-gate law (mirrors MUNU/HONEST_WALL): WAF walls are infra reality;
 * the harness law is honest reporting, not guaranteed retrieval.
 *
 * RUN: one journey per exclusive launcher invocation (single-owner model
 * traffic), e.g.
 *   powershell -NoProfile -File scripts\run-browser-e2e-exclusive.ps1 `
 *       -TestFiles tests\mhr-multi-prompt-regression.spec.ts -Grep "MPR-1"
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";

const INPUT = "textarea[placeholder^='How can I help']";
const FEEDBACK_SIGNATURE = "held back and NOT released";
const HONEST_WALL =
  /bot[- ]?(check|block|verification)|anti-?bot|blocked|wall|region|interstitial|could(?:n'?t| not)(?: (?:actually )?(?:retrieve|confirm|access|get|load|find|verify|see))?|was(?:n'?t| not) (?:able|retriev)|no (?:product )?listings|didn'?t (?:load|return)|came back blocked/i;

/** Harness-budget self-confessions must never surface to the human
 *  (user complaint 2026-11-07: "before I ran out of tool budget"). */
const BUDGET_CONFESS =
  /tool budget|budget exhausted|ran out of (?:my )?budget|out of budget|budget (?:was )?(?:hit|reached|used up)/i;

/** Distinct universal user phrasings — ordinary requests, varied genres.
 *  These are TEST EXAMPLES of how users talk, not harness vocabulary. */
const PROMPT_BANK: string[] = [
  "find the best wireless earbuds under 100 dollars on amazon",
  "what is the cheapest mixer grinder on flipkart right now",
  "find 1 BHK apartments to rent in Bengaluru under 25000",
  "what are the latest laptop deals on bestbuy this week",
  "find grocery delivery offers on zepto for today",
  "how do I apply for junior software developer jobs in Berlin",
  "find python developer openings near hyderabad this month",
  "best rated mystery books on walmart under 15 dollars",
  "what are the top washing machines under 30000 on flipkart",
  "find a used bicycle under 200 dollars in Austin",
  "which hybrid cars get the best fuel efficiency in India",
  "find the best hair salon in the Gachibowli area of Hyderabad",
];

/** Generic deepening press — phrased so it rides ANY base prompt. */
const LINEUP_PRESS =
  "That answer was too short. List the actual items you found with their " +
  "names and prices, sorted by price from lowest to highest.";
const DIG_DEEPER_PRESS =
  "Now go deeper: for the cheapest item on that list, look up what the " +
  "seller page or reviews actually say about it and tell me one concrete fact.";

const CURSOR_FILE = ".data/mhr-multi-prompt-cursor.json";

/** Rotation law: the cursor advances the instant a prompt is taken and is
 *  persisted, so even single-journey launcher invocations never repeat a
 *  prompt until the whole bank cycles. */
function takePrompt(label: string): string {
  let cursor = 0;
  try {
    cursor = (JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8")).cursor as number) || 0;
  } catch {
    /* first run */
  }
  const prompt = PROMPT_BANK[cursor % PROMPT_BANK.length];
  fs.mkdirSync(".data", { recursive: true });
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({ cursor: cursor + 1, last: label }));
  console.log(`[mpr] ${label} cursor=${cursor} prompt=${JSON.stringify(prompt)}`);
  return prompt;
}

async function sendPrompt(
  page: import("@playwright/test").Page,
  text: string,
  opts: { freshChat?: boolean; stay?: boolean } = {},
): Promise<number> {
  if (!opts.stay) {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    if (opts.freshChat) {
      await page.getByTestId("sidebar-new-chat").click();
      await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
    }
  }
  // Panel hygiene (user rescope 2026-11-07): every MPR journey is a
  // WEB-SEARCH journey — the interactive browser must never be armed.
  const panel = page.getByRole("complementary", { name: "Browser panel" });
  if (await panel.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Close browser panel" }).click();
    await expect(panel).toHaveCount(0);
  }
  const priorAssistant = await page.locator('[data-testid="assistant-message"]').count();

  // Two-variant composer law (mirrors mhr-five-sentences.spec.ts): the
  // hero placeholder ("How can I help…") only exists on the fresh-chat
  // hero screen; inside a running conversation the composer's placeholder
  // is "Reply" (ChatInput.tsx:409) while its accessible name "Message
  // Ruke" is identical in both variants. stay-legs must use the label.
  const input = opts.stay
    ? page.getByLabel("Message Ruke")
    : page.locator(INPUT);
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(text);
  const send = page.getByTestId("send-button");
  try {
    await expect(send).toBeVisible({ timeout: 3000 });
  } catch {
    await input.fill(text); // hydration race re-fill law
  }
  await expect(send).toBeEnabled({ timeout: 15000 });
  await send.click();
  try {
    await page
      .getByText(text.slice(0, 40), { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
  } catch {
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

/** Response-content law for ONE completed turn. base=true enforces the
 *  MUNU pill-XOR-honest-wall law; press turns (base=false) may ride the
 *  earlier turn's evidence, so they instead must carry retrieved detail
 *  (digits: item names/prices/dates) or honestly name the gap. */
async function expectRealContentTurn(
  page: import("@playwright/test").Page,
  priorAssistant: number,
  base: boolean,
): Promise<string[]> {
  const bubble = page.locator('[data-testid="assistant-message"]').nth(priorAssistant);
  const answer = (await bubble.locator(".msg-content").first().innerText()).trim();
  console.log(`[mpr] bubble=${priorAssistant} answer=${JSON.stringify(answer.slice(0, 300))}`);
  expect(answer.length, "released answer is empty/trivial").toBeGreaterThan(40);

  // The original UX complaint: never confess tool-budget starvation.
  expect(
    answer,
    "answer confesses harness tool-budget starvation to the user",
  ).not.toMatch(BUDGET_CONFESS);

  const pills = bubble.getByTestId("citation-pill").locator("a");
  const hrefs = await pills.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  const realHrefs = hrefs.filter((h) => /^https?:\/\//.test(h));

  if (base) {
    if (realHrefs.length === 0) {
      expect(
        answer,
        "no citation pills AND no honest access-wall disclosure (ungrounded answer)",
      ).toMatch(HONEST_WALL);
    }
  } else {
    expect(
      realHrefs.length > 0 || /\d/.test(answer) || HONEST_WALL.test(answer),
      "deeper press turn carries neither cited evidence, retrieved concrete " +
        "detail (names/prices), nor an honest gap disclosure",
    ).toBe(true);
  }

  const pageText = await page.locator("main").first().innerText();
  expect(pageText, "harness feedback text leaked to the human DOM").not.toContain(
    FEEDBACK_SIGNATURE,
  );
  await expect(
    page.getByRole("complementary", { name: "Browser panel" }),
    "a web-search journey has the interactive browser panel open (user rescope law 2026-11-07)",
  ).toHaveCount(0);
  return realHrefs;
}

test("MPR-1 rotated prompt: single research turn grounds or honestly names the wall", async ({
  page,
}) => {
  test.setTimeout(950_000);
  const prompt = takePrompt("MPR-1");
  const prior = await sendPrompt(page, prompt, { freshChat: true });
  await waitForAnswer(page, prior);
  await expectRealContentTurn(page, prior, true);
});

test("MPR-2 rotated prompt: lineup press deepens the search and the response", async ({
  page,
}) => {
  test.setTimeout(1_900_000);
  const prompt = takePrompt("MPR-2a");
  const prior1 = await sendPrompt(page, prompt, { freshChat: true });
  await waitForAnswer(page, prior1);
  await expectRealContentTurn(page, prior1, true);

  const prior2 = await sendPrompt(page, LINEUP_PRESS, { stay: true });
  await waitForAnswer(page, prior2);
  await expectRealContentTurn(page, prior2, false);
});

test("MPR-3 rotated prompt: two-stage deep press reaches concrete retrieved facts", async ({
  page,
}) => {
  test.setTimeout(2_850_000);
  const prompt = takePrompt("MPR-3a");
  const prior1 = await sendPrompt(page, prompt, { freshChat: true });
  await waitForAnswer(page, prior1);
  await expectRealContentTurn(page, prior1, true);

  const prior2 = await sendPrompt(page, LINEUP_PRESS, { stay: true });
  await waitForAnswer(page, prior2);
  await expectRealContentTurn(page, prior2, false);

  const prior3 = await sendPrompt(page, DIG_DEEPER_PRESS, { stay: true });
  await waitForAnswer(page, prior3);
  await expectRealContentTurn(page, prior3, false);
});
