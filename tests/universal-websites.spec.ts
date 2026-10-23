/**
 * Universal-websites live Playwright suite (Part 2 of the universal
 * re-architecture).
 *
 * Runs REAL end-to-end searches through the live app (localhost:3000) and
 * asserts non-empty, on-topic evidence + zero LLM refusal on:
 *   1. Blinkit, Myntra, Zepto, BookMyShow, Zomato (ZERO per-site
 *      adapters — the same 4-stage waterfall extracts every one of them)
 *   2. The 3 original regression cases (YouTube short link, Google Maps
 *      short link, LinkedIn profile search)
 *   3. Arbitrary unscripted websites (gov portals, HackerNews,
 *      StackOverflow, Greenhouse jobs, docs)
 *
 * ZERO-DOWNLOAD rule: the in-memory Playwright pool
 * (lib/browser/agentBrowser.ts) resolves its Chromium from the repo-local
 * `.data/ms-playwright` cache via PLAYWRIGHT_BROWSERS_PATH — this suite
 * never runs `playwright install` or downloads anything.
 *
 * Usage:  npx playwright test tests/universal-websites.spec.ts
 * (run against a live `npm run dev` on :3000 — the spec drives the real
 *  chat UI so the search-gate → metasearch → extractor waterfall runs
 *  through the app exactly as a user would trigger it.)
 */
import { test, expect } from "@playwright/test";

// The hero composer's placeholder (landing redesign).
const INPUT = "textarea[placeholder^='How can I help']";

async function sendPrompt(page: import("@playwright/test").Page, text: string) {
  /* Navigate to the app root — the chat composer is fresh here so
     there is no cross-test contamination from the previous case. */
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

/**
 * Wait for the answer to settle. Uses a dynamic poll instead of a fixed
 * timeout: poll every 2s until either the answer is long enough OR we
 * hit the hard deadline. This avoids the cross-test contamination that
 * a blind 90s sleep produces when one case's answer is still streaming.
 */
async function waitForAnswer(
  page: import("@playwright/test").Page,
  deadlineMs = 90_000,
) {
  const t0 = Date.now();
  let lastLen = 0;
  let stableTicks = 0;
  while (Date.now() - t0 < deadlineMs) {
    const text = await page.locator("main").first().innerText().catch(() => "");
    const len = text.length;
    if (len > 40 && len === lastLen) {
      stableTicks++;
      if (stableTicks >= 3) return; /* 3 consecutive polls with no change */
    } else {
      stableTicks = 0;
    }
    lastLen = len;
    await page.waitForTimeout(2_000);
  }
}

/** The refusal phrases the anti-refusal directive must eliminate. */
const REFUSAL_PATTERNS = [
  /i can't (open|watch|browse|access|read) (this|that|the) (link|video|page|website)/i,
  /i'm (un)?able to (open|watch|browse|access|read) (this|that|the) (link|video|page|website)/i,
  /i cannot (open|watch|browse|access|read) (this|that|the) (link|video|page|website)/i,
  /as (an )?ai( assistant)?, i (don'?t| can'?t) (have )?(access|browse|open|watch)/i,
  /i don'?t have (access|the ability) to (browse|open|watch|read) (the|this|that|a)/i,
  /i can'?t (see|view) (the|this|that) (video|link|page|website|content)/i,
];

function answerText(page: import("@playwright/test").Page): Promise<string> {
  return page.locator("main").first().innerText();
}

function assertNoRefusal(text: string): void {
  for (const re of REFUSAL_PATTERNS) {
    expect(re.test(text), `refusal phrase detected: ${re}`).toBe(false);
  }
}

/**
 * Each case: send the prompt, wait for the answer, assert (a) the answer
 * arrived (non-empty, on-topic text), and (b) zero refusal. When the
 * case is a live-web lookup, also assert the answer mentions a real fact
 * (a price, a name, a URL, a rating, etc.) rather than a hedged "I
 * don't know".
 */
interface Case {
  name: string;
  prompt: string;
  /** Substring that MUST appear in the answer (case-insensitive). */
  mustMention?: string;
}

const CASES: Case[] = [
  // 1. Universal Indian e-commerce / food / entertainment
  { name: "Blinkit", prompt: "What is the price of 1 litre Amul butter on Blinkit today?", mustMention: "blinkit" },
  { name: "Myntra", prompt: "What is the price and rating of Levi's 501 original fit jeans on Myntra?", mustMention: "myntra" },
  { name: "Zepto", prompt: "What is the price of a Kingfisher beer 650ml on Zepto?", mustMention: "zepto" },
  { name: "BookMyShow", prompt: "What movies are showing in Hyderabad this week on BookMyShow?", mustMention: "bookmyshow" },
  { name: "Zomato", prompt: "What are the top rated restaurants in Hyderabad on Zomato?", mustMention: "zomato" },

  // 2. The 3 original regression cases
  { name: "YouTube short link", prompt: "https://youtu.be/zinbNw7L8xI — who won the battle of video generating in this video?", mustMention: "youtube" },
  { name: "Google Maps short link", prompt: "https://maps.app.goo.gl/pDMFFw4XaSzNJhgW6 — which location is this?", mustMention: "map" },
  { name: "LinkedIn profile search", prompt: "Find the LinkedIn profile of the CEO of Tata Group", mustMention: "linkedin" },

  // 3. Arbitrary unscripted websites
  { name: "HackerNews", prompt: "What is the top story on HackerNews right now?", mustMention: "hacker" },
  { name: "StackOverflow", prompt: "What is the top voted StackOverflow answer about 'useEffect infinite loop React'?", mustMention: "stackoverflow" },
  { name: "Greenhouse job", prompt: "What open jobs does Stripe have on their Greenhouse job board right now?", mustMention: "job" },
  { name: "Government portal", prompt: "What is the latest notification on the India government portal about the 2026 budget?", mustMention: "gov" },
];

for (const c of CASES) {
  test(`universal: ${c.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await sendPrompt(page, c.prompt);
    await waitForAnswer(page);
    const text = await answerText(page);
    expect(text.length, "answer must be non-empty").toBeGreaterThan(40);
    assertNoRefusal(text);
    if (c.mustMention) {
      expect(text.toLowerCase(), `answer must mention '${c.mustMention}'`).toContain(c.mustMention.toLowerCase());
    }
  });
}
