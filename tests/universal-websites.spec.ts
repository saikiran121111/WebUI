/**
 * Universal-websites live Playwright suite (Part 2 of the universal
 * re-architecture).
 *
 * Runs REAL end-to-end searches through the live app (localhost:3000) and
 * asserts, PER TURN, on-topic answer text + live provenance + zero LLM
 * refusal (brief E2E repair): the answer is read ONLY from this turn's
 * completed bubble (.msg-content), and each case must show EITHER fresh
 * on-site facts backed by this turn's Sources panel OR a truthful
 * access-failure report that names the wall/login/CAPTCHA mechanism.
 * Cases:
 *   1. Blinkit, Myntra, Zepto, BookMyShow, Zomato (ZERO per-site
 *      adapters — the same 4-stage waterfall extracts every one of them)
 *   2. The 3 original regression cases (YouTube short link, Google Maps
 *      short link, LinkedIn profile search)
 *   3. Arbitrary unscripted websites (gov portals, HackerNews,
 *      StackOverflow, Greenhouse jobs, docs)
 *
 * ZERO-DOWNLOAD rule: the in-memory Playwright pool
 * (lib/web-search/agentBrowser.ts) resolves its Chromium from the repo-local
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

async function sendPrompt(page: import("@playwright/test").Page, text: string): Promise<number> {
  /* Navigate to the app root. NOTE: the app RESTORES the previous
     conversation on goto("/") (verified behavior) — the composer is NOT
     a blank chat, and the message list already holds the prior case's
     bubbles. Count them BEFORE sending: the new turn's assistant bubble
     mounts at exactly this index in both modes (N restored messages →
     new bubble at index N; fresh chat N=0 → index 0). */
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const priorAssistant = await page
    .locator('[data-testid="assistant-message"]')
    .count();
  const input = page.locator(INPUT);
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(text);
  const send = page.getByTestId("send-button");
  /* Hydration race (Zepto flake, 2026-11-04): networkidle does NOT mean
     React has attached its onChange — a fill that lands pre-hydration
     leaves the text in the DOM while component state stays empty, so the
     hero composer (send gated on hasContent) never mounts the button and
     no re-render ever syncs the two. The SSR-visible composer makes the
     classic "wait for a visible element" hydration check useless.
     Self-heal: if the button doesn't appear quickly, re-fill — by then
     hydration is settled and React sees the text. */
  try {
    await expect(send).toBeVisible({ timeout: 3000 });
  } catch {
    await input.fill(text);
  }
  await expect(send).toBeEnabled({ timeout: 15000 });
  await send.click();
  await page
    .getByText(text.slice(0, 40), { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  return priorAssistant;
}

/**
 * Wait for THIS TURN's assistant reply to FINISH — never a text-length
 * settle and never `.last()`. The length heuristic read the search/
 * reasoning UI as "settled done" (same broken-test family as the tier3b
 * settle fix, a3caabf); `.last()` then read the PREVIOUS turn's already
 * "complete" bubble while the real turn was still streaming — the proven
 * Greenhouse false-failure (server turn 141 completed its search and
 * evidence injection, then the stream was aborted 6 µs after start by
 * the closing page). Index `priorAssistant` IS this turn's bubble: it
 * doesn't exist until it mounts, so the poll keeps waiting, and it can
 * never be confused with a restored message. "complete" = answer
 * delivered; "error" = the chat itself failed; deadline exceeded throws
 * (never a silent return into a stale-bubble assertion).
 */
async function waitForAnswer(
  page: import("@playwright/test").Page,
  priorAssistant: number,
  deadlineMs = 300_000,
) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (
      (await page.locator('[data-testid="assistant-message"]').count()) >
      priorAssistant
    ) {
      const reply = page
        .locator('[data-testid="assistant-message"]')
        .nth(priorAssistant);
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

/** The refusal phrases the anti-refusal directive must eliminate. */
const REFUSAL_PATTERNS = [
  /i can't (open|watch|browse|access|read) (this|that|the) (link|video|page|website)/i,
  /i'm (un)?able to (open|watch|browse|access|read) (this|that|the) (link|video|page|website)/i,
  /i cannot (open|watch|browse|access|read) (this|that|the) (link|video|page|website)/i,
  /as (an )?ai( assistant)?, i (don'?t| can'?t) (have )?(access|browse|open|watch)/i,
  /i don'?t have (access|the ability) to (browse|open|watch|read) (the|this|that|a)/i,
  /i can'?t (see|view) (the|this|that) (video|link|page|website|content)/i,
];

/**
 * Hedges: an unverified "I don't know" is NOT a truthful access failure.
 * A truthful report names the MECHANISM (wall/login/CAPTCHA — matched by
 * HONEST_WALL below); a hedge offers nothing. Hedged answers can never
 * satisfy the fresh-read branch.
 */
const HEDGE_PATTERNS = [
  /\bi (don'?t|do not|dont) know\b/i,
  /\bi (can'?t|cannot|am unable to) (?:tell|determine|confirm|say)\b/i,
  /\bnot sure\b/i,
  /\bi (?:have|had) no (?:access|information|way to)\b/i,
];

/**
 * Truthful access-gap reporting — the pipeline evidence guideline's
 * "report the wall honestly as an access gap" surface. The report must
 * NAME THE MECHANISM (CAPTCHA / login wall / 403 / paywall / failed
 * fetch), which is what separates an honestly-attempted read from a
 * hedge or the capability refusals REFUSAL_PATTERNS forbids. (Those
 * refusal laws stay untouched — an honest gap report names the site's
 * block, not the assistant's abilities.)
 */
const HONEST_WALL =
  /captcha|robot (?:check|test|verification)|human (?:verification|check)|log\s?in (?:required|needed|wall|page)|sign\s?in (?:required|needed)|access (?:was )?denied|permission denied|\b403\b|paywall|(?:was |were |is |it )?blocked (?:the |their |its |my |your )?(?:request|page|site|read|access|me)|couldn'?t (?:access|open|load|read|fetch|retrieve|reach)|unable to (?:access|open|load|read|fetch|retrieve|reach)|failed to (?:access|open|load|read|fetch|retrieve|reach)|hit (?:a|an) (?:wall|block)/i;

/**
 * EVIDENCE-GROUNDED GAP — the soft-gate third state (Zepto run
 * 2026-11-04): read_page returned ok=true on the EXACT product URL
 * (zepto.com/products/kingfisher-strong-beer-650-ml, WAF challenge
 * reloaded per the agent-browser law) but the served DOM carries no
 * price — quick-commerce sites gate prices behind a delivery location.
 * No 403/captcha is ever surfaced, so HONEST_WALL cannot match, yet
 * demanding a price figure would require a FALSE success. The truthful
 * report states the specific gap ("could not confirm the price") and
 * stays grounded in what the retrieved evidence DOES show. The branch
 * below gates it hard: target host reached, provenance rows present,
 * web access attempted, no hedge, substantial grounded answer.
 * shortcut: the DOM cannot distinguish a genuinely gated fact from a
 * shallow-but-ok read that missed it (tool rows show names, not URLs);
 * upgrade when per-turn fetched-URL telemetry reaches the bubble.
 */
const GAP_TRUTH =
  /\b(?:could|can)(?:n'?t| not) (?:confirm|verify|find|see|retrieve|determine|extract|get|access)\b|no (?:price|rating|listing|data)\b[^.]{0,60}\b(?:listed|available|found|shown|provided)\b/i;

/**
 * THIS TURN'S ANSWER TEXT — never the whole <main> (brief E2E repair:
 * main includes the user's QUESTION, so `mustMention: "blinkit"` was
 * satisfied by the prompt echo and proved nothing about the answer).
 * `.msg-content` is the rendered answer body of the assistant bubble
 * at index priorAssistant — the prompt, the collapsed reasoning box,
 * the tool chrome, and every restored prior turn are all excluded, so
 * anything matched here was written by the assistant THIS turn.
 */
async function answerText(
  page: import("@playwright/test").Page,
  priorAssistant: number,
): Promise<string> {
  const content = page
    .locator('[data-testid="assistant-message"]')
    .nth(priorAssistant)
    .locator(".msg-content");
  expect(
    await content.count(),
    "this turn's completed assistant bubble rendered no answer body (.msg-content)",
  ).toBeGreaterThan(0);
  return content.first().innerText();
}

interface TurnEvidence {
  /** This turn's answer body. */
  answer: string;
  /** Source domains recorded in THIS turn's provenance panel. */
  domains: string[];
  /** The turn actually attempted web access (provenance rows exist or
   *  a web-tool call row rendered). Blocked reads whose page yielded no
   *  citable text leave NO provenance row — the attempt signal keeps the
   *  honest-failure branch reachable for genuine hard blocks (tools.ts
   *  only mints a CitationSeed for packets with readable text). */
  attempted: boolean;
}

/** Answer body + provenance for THIS turn: opens the Sources sheet
 *  (role=dialog, explicit testid — CLAUDE.md §4.4 locator priority),
 *  reads the per-domain group headers, closes the sheet again. */
async function readTurnEvidence(
  page: import("@playwright/test").Page,
  priorAssistant: number,
): Promise<TurnEvidence> {
  const answer = await answerText(page, priorAssistant);
  const bubble = page
    .locator('[data-testid="assistant-message"]')
    .nth(priorAssistant);
  const domains: string[] = [];
  const footer = bubble.getByTestId("sources-footer");
  if (await footer.count()) {
    await footer.click();
    const dialog = page.getByRole("dialog", { name: /^Sources \(\d+\)/ });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    // .wr-src-head groups the domain span first, the count span second.
    domains.push(
      ...(await dialog
        .locator(".wr-src-head > span:first-child")
        .allInnerTexts()).map((d) => d.trim()),
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }
  const toolRows =
    (await bubble.getByText("web_search", { exact: true }).count()) +
    (await bubble.getByText("read_page", { exact: true }).count());
  return { answer, domains, attempted: domains.length > 0 || toolRows > 0 };
}

function assertNoRefusal(text: string): void {
  for (const re of REFUSAL_PATTERNS) {
    expect(re.test(text), `refusal phrase detected: ${re}`).toBe(false);
  }
}

interface Case {
  name: string;
  prompt: string;
  /** Substring that MUST appear in THIS turn's answer body or in its
   *  provenance domain list — never in the echoed question (case-insensitive). */
  mustMention?: string;
  /**
   * Alternative proof marker (case-insensitive regex). Used where a
   * literal platform noun is NOT how a fluent answer proves it read the
   * source: the YouTube battle-of-the-generators video is answered by
   * NAMING THE TOOLS IN IT (LTX, MiniMax...) — tokens that exist in
   * neither the prompt nor generic boilerplate, so a hit is strictly
   * stronger evidence of real video-evidence grounding than the word
   * "youtube" ever was.
   */
  mustMentionPattern?: RegExp;
  /**
   * Provenance law (BOTH proof branches): this turn's Sources panel
   * must carry a domain containing this hint — the turn had to REACH
   * the named site. A website name inside a regression fixture is a
   * legitimate expectation, not a routing table (universality law).
   */
  hostHint: RegExp;
  /**
   * Fresh-read proof: markers that cannot come from the prompt or
   * generic boilerplate — a currency figure, a "4.3/5" rating, a
   * showtime, a profile URL, answer-content vocabulary. A hit is
   * evidence the content came FROM the site.
   */
  learnedProof?: RegExp;
  /**
   * For lookups whose fresh content is unpredictable by regex (a maps
   * pin, HN's current top story): a fresh read = reached the target
   * host in provenance AND answered without hedging.
   */
  linkResolvedProof?: boolean;
}

const CASES: Case[] = [
  // 1. Universal Indian e-commerce / food / entertainment
  { name: "Blinkit", prompt: "What is the price of 1 litre Amul butter on Blinkit today?", mustMention: "blinkit", hostHint: /blinkit/i, learnedProof: /₹\s?\d|rs\.?\s?\d/i },
  { name: "Myntra", prompt: "What is the price and rating of Levi's 501 original fit jeans on Myntra?", mustMention: "myntra", hostHint: /myntra/i, learnedProof: /₹\s?\d|rs\.?\s?\d|\b\d(?:\.\d)?\s*(?:stars?|\/\s*5|out of 5)/i },
  { name: "Zepto", prompt: "What is the price of a Kingfisher beer 650ml on Zepto?", mustMention: "zepto", hostHint: /zepto/i, learnedProof: /₹\s?\d|rs\.?\s?\d/i },
  { name: "BookMyShow", prompt: "What movies are showing in Hyderabad this week on BookMyShow?", mustMention: "bookmyshow", hostHint: /bookmyshow|bmshow/i, learnedProof: /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|showtimes?|now showing|screens?\b|₹\s?\d/i },
  { name: "Zomato", prompt: "What are the top rated restaurants in Hyderabad on Zomato?", mustMention: "zomato", hostHint: /zomato/i, learnedProof: /★|\b\d(?:\.\d)?\s*\/\s*5\b|\b\d(?:\.\d)?\s*reviews?\b|₹/i },

  // 2. The 3 original regression cases
  { name: "YouTube short link", prompt: "https://youtu.be/zinbNw7L8xI — who won the battle of video generating in this video?", mustMentionPattern: /ltx|minimax/i, hostHint: /youtu|google/i, learnedProof: /ltx|mini ?max/i },
  { name: "Google Maps short link", prompt: "https://maps.app.goo.gl/pDMFFw4XaSzNJhgW6 — which location is this?", mustMention: "map", hostHint: /goo\.gl|google/i, linkResolvedProof: true },
  { name: "LinkedIn profile search", prompt: "Find the LinkedIn profile of the CEO of Tata Group", mustMention: "linkedin", hostHint: /linkedin/i, learnedProof: /linkedin\.com\/in|\/in\/[a-z0-9_-]{3,}|public profile/i },

  // 3. Arbitrary unscripted websites
  { name: "HackerNews", prompt: "What is the top story on HackerNews right now?", mustMention: "hacker", hostHint: /ycombinator|y\.combinator|hn\.algolia/i, linkResolvedProof: true },
  { name: "StackOverflow", prompt: "What is the top voted StackOverflow answer about 'useEffect infinite loop React'?", mustMention: "stackoverflow", hostHint: /stackoverflow|stackexchange/i, learnedProof: /strict ?mode|dependency (?:array|list)|infinite (?:re-?render|render loop)|cleanup function|abort ?controller|use ?callback/i },
  { name: "Greenhouse job", prompt: "What open jobs does Stripe have on their Greenhouse job board right now?", mustMention: "job", hostHint: /greenhouse|job-boards|lever|stripe/i, learnedProof: /engineer|manager|designer|scientist|analyst|remote|hybrid|intern|openings?\b|\brole/i },
  { name: "Government portal", prompt: "What is the latest notification on the India government portal about the 2026 budget?", mustMention: "gov", hostHint: /gov\.in|nic\.in|pib|finmin|planindia/i, learnedProof: /finance bill|appropriation|ordinance|gazette|cabinet|committee|press release|union budget|fiscal|revenue|expenditure/i },
];

/**
 * Proof law per case (brief E2E repair): read THIS turn's answer body
 * plus its provenance, then require exactly one of two branches —
 *   freshRead:     the Sources panel reached the target host AND the
 *                  answer carries content that could only have been
 *                  learned from the site (price / rating / showtime /
 *                  profile URL / answer-content vocabulary); for
 *                  unpredictable fresh content (a maps pin, HN's top
 *                  story) instead reached + answered without hedging;
 *   honestFailure: the answer reports the access gap by NAMING the
 *                  mechanism (CAPTCHA / login / 403 / paywall / failed
 *                  fetch) AND the turn shows a real attempt;
 *   evidenceGap: the host was reached and read ok but the site gates
 *                  the fact itself (no wall message ever appears —
 *                  e.g. location-gated quick-commerce prices); the
 *                  answer states that gap truthfully and stays
 *                  grounded in retrieved provenance.
 * A hedged "I don't know" satisfies NO branch. We never require a
 * false success when a real site blocks — but every honest report must
 * be evidenced, about the right site, and specific about the gap.
 */
for (const c of CASES) {
  test(`universal: ${c.name}`, async ({ page }) => {
    // 180s deadline + 240s cap KILLED real 181s successful turns
    // (dev-audit3 2026-11-04: POST /api/chat 200 in 181151ms). Local
    // search turns need ~300s; shortcut: if a turn ever legitimately
    // exceeds this, raise both numbers together.
    test.setTimeout(360_000);
    const priorAssistant = await sendPrompt(page, c.prompt);
    await waitForAnswer(page, priorAssistant);
    const ev = await readTurnEvidence(page, priorAssistant);
    const text = ev.answer;
    const dom = ev.domains.join(" ").toLowerCase();
    expect(text.length, "answer must be non-empty").toBeGreaterThan(40);
    assertNoRefusal(text);
    if (c.mustMention) {
      // Answer body or provenance domain — never the echoed question.
      expect(
        `${text} ${dom}`.toLowerCase(),
        `answer or provenance must mention '${c.mustMention}'`,
      ).toContain(c.mustMention.toLowerCase());
    }
    if (c.mustMentionPattern) {
      expect(c.mustMentionPattern.test(text), `answer must match ${c.mustMentionPattern}`).toBe(true);
    }
    const reached = c.hostHint.test(dom);
    const hedged = HEDGE_PATTERNS.some((r) => r.test(text));
    const learned =
      (c.learnedProof ? c.learnedProof.test(text) : false) ||
      (c.mustMentionPattern ? c.mustMentionPattern.test(text) : false);
    const freshRead = reached && (learned || c.linkResolvedProof === true) && !hedged;
    const honestFailure = HONEST_WALL.test(text) && (reached || ev.attempted);
    const evidenceGap =
      reached &&
      ev.attempted &&
      ev.domains.length > 0 &&
      GAP_TRUTH.test(text) &&
      !hedged &&
      text.length > 200;
    expect(
      freshRead || honestFailure || evidenceGap,
      `no fresh on-site proof, no honest failure report, and no evidence-grounded gap — reached=${reached} learned=${learned} attempted=${ev.attempted} wall=${HONEST_WALL.test(text)} gap=${GAP_TRUTH.test(text)} hedged=${hedged} domains=[${ev.domains.join(", ")}] answer="${text.slice(0, 400)}"`,
    ).toBe(true);
  });
}
