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
//     list; on the fixture /hard/delayed tab read the LIVE DOM through
//     the engine. The marker node is only appended 1.5 s after load by
//     client JS — an engine-side marker read proves JS rendered, not a
//     text fetch.
//   SIGNAL 2 (conversation): the answer quotes the marker and contains
//     no access refusal.
//
// JOURNEY SWAP 2026-11-07 (P7 loop), two measured lessons:
//  1. quotes.toscrape.com/js ("first quote = Albert Einstein") was
//     PARAMETRICALLY GUESSABLE — the model answered "Einstein" in ~15 s
//     without ever arming a browser turn, and the two-signal law
//     correctly failed that run.
//  2. A prompt telling the model to OPEN a fixture URL failed the honest
//     way: the SSRF guard rejects model-issued loopback navigation
//     (`unsafe_destination`) and "localhost" falls outside the armed
//     scope — product security working as designed, NOT a bug to route
//     around. The fixture journey the product DOES support is the
//     human-authority pre-open (newTab+navigate RPC), exactly the
//     browser-model-acceptance EASY/MEDIUM pattern.
// So: the HUMAN opens /hard/delayed (JS-only marker node, appended by
// client JS 1.5 s after load); the model must READ the already-open tab
// through its browser tools — the token is unguessable, so SIGNAL 2 can
// only pass by reading the live rendered DOM. SIGNAL 1 (engine innerText
// carries the marker) is the Tier-3b claim itself: the engine executed
// the page's JavaScript.
//
// Model-backed: run only under the Playwright lock, workers:1, ONE
// attempt (PATIENCE RULE: single attempt sized under the launcher cap).

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  BrowserE2E,
  assertFixtureServerUp,
  FIXTURE_BASE,
  LATE_MARKER as MARKER,
} from "./browser-e2e-helpers";

const INPUT = "textarea[placeholder^='How can I help']";
// Session string on test-issued engine commands is turn/authority
// bookkeeping only: the "tabs" query is BROWSER-scoped (contract.rs
// TabListQuery{browser_id}), so the model turn's tabs are visible from any
// session string — independent of the chat-scoped id the app now sends
// since the journal fix (cfea00e mints a c_ uid per chat).
const SESSION = "default";

// Policy keys are registrable hosts (authority.rs); for the fixture IP the
// engine arms the literal "127.0.0.1" — same convention as
// browser-model-acceptance.spec.ts.
const POLICY_HOST = "127.0.0.1";

test.describe.configure({ retries: 0 }); // PATIENCE RULE: one attempt per invocation

test.beforeAll(async ({ request }) => {
  await assertFixtureServerUp(request);
});

// The human-owned fixture tab survives turn cleanup; sweep it anyway so a
// failure can't leak it into the next spec's tab list.
test.afterEach(async ({ request }) => {
  await new BrowserE2E(request, SESSION).closeFixtureTabs().catch(() => {});
});

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
  test.setTimeout(380_000); // measured 49.3 tk/s era; stays clear of the 600 s shell ceiling

  // Arm the policy BEFORE the turn: the human's "always allow" equivalent.
  // `access` gates page observation (authority.rs facet law); uploads +
  // downloads armed alongside per the acceptance-suite convention.
  for (const facet of ["access", "uploads", "downloads"]) {
    const res = await request.put("/api/browser/policy", {
      data: { host: POLICY_HOST, facet, decision: "never_ask" },
    });
    expect(res.ok(), `policy PUT ${facet} failed: HTTP ${res.status()}`).toBe(true);
  }

  // Human-authority pre-open — the fixture journey the product supports
  // (model-issued loopback navigation is blocked by the SSRF guard, by
  // design). newTab/navigate are engine RPC calls, so the ENGINE renders
  // the page: the marker node appears in the tab's DOM only after the
  // page's client JS runs 1.5 s in (SIGNAL 1's Tier-3b claim). The
  // human-owned tab (created_by_turn none) survives turn cleanup.
  const e2e = new BrowserE2E(request, SESSION);
  const tab = await e2e.newTab();
  await e2e.navigate(tab, "/hard/delayed");

  const prompt =
    `Use the browser tools on the already-open tab at ${FIXTURE_BASE}/hard/delayed ` +
    "(do not open new tabs): wait for it to finish loading, then read the page and " +
    "tell me the exact text of the node that appears below the intro line. " +
    "Reply with exactly: marker=<text>";

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

  // Both signals are polled in one window. SIGNAL 1 can latch early (the
  // engine rendered the human-opened tab's JS); that is still the Tier-3b
  // claim — the engine executed the page's JavaScript. SIGNAL 2 is the
  // model-tool-use proof: the token is unguessable, so quoting it in the
  // conversation is only possible by reading the live rendered DOM.
  let engineRendered = false;
  await expect
    .poll(
      async () => {
        if (!engineRendered) {
          const tabs = await e2e.listTabs().catch(() => []);
          const tab = tabs.find((t) => (t.url ?? "").includes("3210/hard/delayed"));
          if (tab?.tab_id) {
            const dom = await e2e.innerText(tab.tab_id, "body").catch(() => "");
            if (dom.includes(MARKER)) engineRendered = true;
          }
        }
        const t = await page.locator("main").first().innerText().catch(() => "");
        return t.includes(MARKER);
      },
      {
        timeout: 300_000,
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
  // REAL engine proof, not model prose: the JS-only page's marker text was
  // read from the live DOM through the browser engine while the turn was
  // still open. That node only exists after client-side JS ran.
  expect(engineRendered, "engine never rendered the JS-only page's marker node").toBe(true);
  expect(text, "the answer must quote the unguessable fixture marker").toContain(MARKER);
});
