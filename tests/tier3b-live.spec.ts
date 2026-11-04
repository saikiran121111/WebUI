// Tier-3b validation, current-law era (rewritten 2026-11-03 after the TS
// rollback + task-scope/browser-activation laws).
//
// The ORIGINAL premise (Part 10: the TS agentBrowser tier inside the
// web-research pipeline renders a JS-only page reached through the
// /api/internal/browser-read RPC) is obsolete for an `Open <url>` prompt:
// the task-scope law routes site-bound work to the INTERACTIVE BROWSER
// turn ("general web research skipped: operational task scope — the
// browser turn owns the site-bound work"). Prompt-engineering around that
// law is forbidden, so this spec now exercises the journey the product
// actually takes: the human pre-arms the host policy (the same
// never_ask arming as browser-model-acceptance — the 120 s approval-card
// window must never race the test clock), the browser turn drives
// ruke-browser to the JS-only page, the JS renders, and the model quotes
// it back.
//
// Proof is two-signal, per the acceptance-suite law (read REAL engine
// state, never just model prose):
//   SIGNAL 1 (engine): while the turn is live, poll the real engine tab
//     list; on the quotes.toscrape.com tab read the LIVE DOM through the
//     engine. That page ships an EMPTY body — ".quote .author" text can
//     only exist after client-side JS ran — so an engine-side Einstein
//     read proves Tier-3b rendering, not a memory recall.
//   SIGNAL 2 (conversation): the answer quotes the author and contains
//     no access refusal.
//
// The page is a scraping-practice sandbox: no CAPTCHA, stable seeded
// content, first quote authored by Albert Einstein.
//
// Model-backed: run only under the Playwright lock, workers:1, ONE
// attempt (PATIENCE RULE: single attempt sized under the launcher cap).

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { BrowserE2E } from "./browser-e2e-helpers";

const INPUT = "textarea[placeholder^='How can I help']";
// Fresh chat at "/" ⇒ activeId null ⇒ browser session "default"
// (app/page.tsx: activeId ?? "default") — same law as browser-model-acceptance.
const SESSION = "default";

// Policy keys are REGISTRABLE domains (authority.rs: registrable_host →
// psl::domain_str), so quotes.toscrape.com is armed as toscrape.com.
const POLICY_HOST = "toscrape.com";

test.describe.configure({ retries: 0 }); // PATIENCE RULE: one attempt per invocation

const REFUSAL_PATTERNS = [
  /i can'?t (open|watch|browse|access|read|visit) (this|that|the) (link|video|page|website|url|site)/i,
  /i'?m (un)?able to (open|watch|browse|access|read|visit) (this|that|the) (link|video|page|website|url|site)/i,
  /i cannot (open|watch|browse|access|read|visit) (this|that|the) (link|video|page|website|url|site)/i,
  /as (an )?ai( assistant)?, i (don'?t| can'?t) (have )?(access|browse|open|watch)/i,
  /i don'?t have (access|the ability) to (browse|open|watch|read|visit) (the|this|that|a)/i,
];

test("the browser turn renders a JS-only page and the answer quotes it", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);

  // Arm the policy BEFORE the turn: the human's "always allow" equivalent.
  // `access` gates page observation (authority.rs facet law); uploads +
  // downloads armed alongside per the acceptance-suite convention.
  for (const facet of ["access", "uploads", "downloads"]) {
    const res = await request.put("/api/browser/policy", {
      data: { host: POLICY_HOST, facet, decision: "never_ask" },
    });
    expect(res.ok(), `policy PUT ${facet} failed: HTTP ${res.status()}`).toBe(true);
  }

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

  const e2e = new BrowserE2E(request, SESSION);

  // The model-owned tab is swept by turn cleanup, so the engine signal
  // must be captured WHILE the turn runs. Both signals are polled in one
  // window; the captured flag survives after the tab closes.
  let engineRendered = false;
  await expect
    .poll(
      async () => {
        if (!engineRendered) {
          const tabs = await e2e.listTabs().catch(() => []);
          const tab = tabs.find((t) => (t.url ?? "").includes("quotes.toscrape.com"));
          if (tab?.tab_id) {
            const dom = await e2e.innerText(tab.tab_id, "body").catch(() => "");
            if (/einstein/i.test(dom)) engineRendered = true;
          }
        }
        const t = await page.locator("main").first().innerText().catch(() => "");
        return /einstein/i.test(t);
      },
      {
        timeout: 240_000,
        intervals: [2_000],
        message: "tier-3b answer never rendered in the conversation",
      },
    )
    .toBe(true);

  const text = await page.locator("main").first().innerText();
  expect(text.length, "answer must be non-empty").toBeGreaterThan(40);
  for (const re of REFUSAL_PATTERNS) {
    expect(re.test(text), `access-refusal detected: ${re}`).toBe(false);
  }
  // REAL engine proof, not model prose: the JS-only page's author text was
  // read from the live DOM through the browser engine while the turn was
  // still open. That markup only exists after client-side JS ran.
  expect(engineRendered, "engine never rendered the JS-only page's quote markup").toBe(true);
  expect(text.toLowerCase(), "Einstein = the seeded first-quote author").toContain("einstein");
});
