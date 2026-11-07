// Real-model acceptance journeys (plan rows 19–24) — leg 2 of the final
// locked loop. These are the ONLY specs in tests/ that touch the shared
// inference backend: run them through scripts/run-browser-e2e-exclusive.ps1
// (one journey per invocation via -Grep, full idle between — CLAUDE.md §1).
//
// Each journey: the human arms the browser turn through the REAL UI (TopBar
// "Open browser panel" toggle ⇒ the send carries `browser_armed` — the
// explicit "open browser" action, user rescope 2026-11-07; the server
// combines it with the Operate scope and the prompt's own instrument words
// via task_scope::browser_activates; `browser_session` rides every send as
// identity only; the composer sends the prompt; the Rust tool loop drives
// the model's tool calls against the engine). Assertions read REAL
// engine/page state over the human-turn RPC — never command echoes, never
// model prose.
//
// Policy is pre-armed to "always allow" for the fixture host (access +
// uploads) — equivalent to the human clicking "Always allow" once — so
// approval cards (120 s window) never race the test clock. The gate itself
// is already exercised by smoke_lifecycle (Rust) and the approval-card UX
// by the panel; what this leg verifies is END-TO-END model→tool→page.
//
// PATIENCE RULE (docs/e2e-test-state.md): per-test timeout must exceed the
// assertion window plus model overflow. ONE attempt per invocation (retries
// off): two attempts cannot fit under the launcher window, and a doubled
// attempt is what killed the first run at the harness cap (2026-10-31).
//
// Defect #7 post-mortem (first EASY run): home "/" renders ChatInput
// (variant "hero"), and the old sendPrompt hung on `locator("textarea")`
// actionability until the whole 300 s test timeout burned with no error.
// The send is now anchored to the composer's real accessible name and the
// test FAST-FAILS if the send doesn't land (user bubble asserted visible),
// plus actionTimeout converts any blocked locator action into a precise
// actionable error instead of a silent 300 s stall.

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  BrowserE2E, assertFixtureServerUp,
  FIXTURE_BASE, EASY_ARRIVED, POPUP_CHILD_MARKER,
} from "./browser-e2e-helpers";

const BASE = "http://localhost:3000";
// Fresh chat ⇒ activeId null ⇒ panel session + `browser_session` marker are
// both "default" (app/page.tsx: activeId ?? "default"). Every attempt starts
// at "/" (a brand-new chat), so "default" is the stable session per journey.
const SESSION = "default";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll real engine state until the condition holds or the window closes. */
async function until(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
}

async function tabUrl(e2e: BrowserE2E, tabId: string): Promise<string> {
  const t = (await e2e.listTabs()).find((row) => row.tab_id === tabId);
  return t?.url ?? "";
}

/** Arm the policy, open the panel through its real TopBar toggle, and hand
 *  back the human-turn RPC bound to this conversation's session. */
async function arm(page: Page, request: APIRequestContext): Promise<BrowserE2E> {
  for (const facet of ["access", "uploads", "downloads"]) {
    const res = await request.put("/api/browser/policy", {
      data: { host: "127.0.0.1", facet, decision: "never_ask" },
    });
    expect(res.ok(), `policy PUT ${facet} failed: HTTP ${res.status()}`).toBe(true);
  }
  await page.goto(BASE + "/");
  await assertFixtureServerUp(request);
  const panel = page.getByRole("complementary", { name: "Browser panel" });
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open browser panel" }).click();
  }
  await expect(panel).toBeVisible({ timeout: 10000 });
  return new BrowserE2E(request, SESSION);
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  // Home hero composer: ChatInput variant "hero" (app/page.tsx). Enter sends
  // unless the slash-skill menu is open, which these prompts never trigger.
  // No click(): with the Browser Panel open its screencast overlay intercepts
  // pointer events over the composer's center (the panel floats — intended
  // ChatGPT-style UX; a human clicks an uncovered edge). fill() focuses the
  // textarea directly and checks editable/visible — no hit-target check.
  const box = page.getByLabel("Message Ruke");
  await box.fill(text);
  await box.press("Enter");
}

/** Composer send + full model turn: wait until the stream (Stop button) ends. */
async function runTurn(page: Page, text: string): Promise<void> {
  await sendPrompt(page, text);
  // Fast-fail contract: the user bubble must land in the transcript, which
  // also proves the conversation view took over from the hero.
  await expect(
    page.getByText(text.slice(0, 20)).first(),
    "composer send never reached the transcript",
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Stop generating"), "model stream never finished").toHaveCount(0, { timeout: 420_000 });
  // The SSE closes when the loop emits its final answer; the engine-side
  // turn end (cleanup) lands within a moment of it.
  await sleep(1500);
}

test.describe("browser real-model acceptance (leg 2, one journey per locked invocation)", () => {
  test.describe.configure({ mode: "serial", retries: 0 });
  // Single attempt sized for the PATIENCE RULE while staying clear of the
  // outer launcher window.
  test.setTimeout(480_000);
  test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 });

  test.afterEach(async ({ request }) => {
    // Sweep fixture tabs so the next journey starts from a clean tab list;
    // leave non-fixture (user) tabs alone.
    await new BrowserE2E(request, SESSION).closeFixtureTabs().catch(() => {});
  });

  test("EASY: human-armed browser turn; model clicks the open tab to the marker page", async ({ page, request }) => {
    const e2e = await arm(page, request);
    // Pre-open the tab as the HUMAN (turn "ui"): human-owned tabs survive
    // turn cleanup, so the post-turn assertion window is safe.
    const tab = await e2e.newTab();
    await e2e.navigate(tab, "/easy");

    await runTurn(
      page,
      `Use the browser tools. A browser tab is already open at ${FIXTURE_BASE}/easy. ` +
        `On that SAME tab (do not open new tabs), click the link with CSS selector "#go-arrived", ` +
        `then read the page text and tell me the exact marker text shown in the "#arrived-marker" element.`,
    );

    await until(async () => (await tabUrl(e2e, tab)).endsWith("/easy/arrived"), 30_000, "navigation to /easy/arrived");
    expect(await e2e.innerText(tab, "#arrived-marker")).toBe(EASY_ARRIVED);
  });

  test("MEDIUM: model fills the four-field fixture form and submits; exact server echo", async ({ page, request }) => {
    const e2e = await arm(page, request);
    const tab = await e2e.newTab();
    await e2e.navigate(tab, "/medium");

    await runTurn(
      page,
      `Use the browser tools on the already-open tab at ${FIXTURE_BASE}/medium (do not open new tabs): ` +
        `type RUKE-MEDIUM-42X into the input with CSS selector "#note-input"; select the option whose value ` +
        `is "business" (its visible text is "Business") in the select "#tier-select"; tick the checkbox ` +
        `"#subscribe-box"; check the radio button with CSS selector input[name="plan"][value="annual"]. ` +
        `If one tool can set several of these fields in a single call, prefer that. Then click the button ` +
        `"#submit-btn". Finally read the page and list the echoed lines you see.`,
    );

    await until(async () => (await tabUrl(e2e, tab)).includes("/medium/echo"), 30_000, "form submission to /medium/echo");
    const echo = await e2e.innerText(tab, "#echo-output");
    for (const want of ["note=RUKE-MEDIUM-42X", "tier=business", "subscribe=yes", "plan=annual"]) {
      expect(echo, `echo: ${JSON.stringify(echo)}`).toContain(want);
    }
  });

  test("HARD: model opens a new tab, adopts the popup child, and marks it deliverable so it survives", async ({ page, request }) => {
    const e2e = await arm(page, request);

    await runTurn(
      page,
      `Use the browser tools. Step 1: open a NEW tab at ${FIXTURE_BASE}/hard/popup. ` +
        `Step 2: on that page click the button with CSS selector "#open-popup" — it opens a popup, which appears ` +
        `as another browser tab. Step 3: list the browser tabs, find the child tab whose URL ends with ` +
        `"/hard/popup-child", and call the "tab_mark_deliverable" tool on that child tab so it is kept. ` +
        `Step 4: read the child page and tell me the marker text shown.`,
    );

    // Surviving a marked child is end-to-end proof: popup adoption (engine),
    // mark_deliverable (tool + session law), turn cleanup leaving it alone,
    // and the real model driving all of it.
    await until(
      async () => (await e2e.listTabs()).some((t) => (t.url ?? "").endsWith("/hard/popup-child")),
      30_000,
      "marked popup-child tab surviving turn cleanup",
    );
    const child = (await e2e.listTabs()).find((t) => (t.url ?? "").endsWith("/hard/popup-child"));
    expect(child?.tab_id, "popup child tab missing").toBeTruthy();
    expect(await e2e.innerText(child!.tab_id as string, "#popup-marker")).toBe(POPUP_CHILD_MARKER);
  });

  // Phase-1 vision gate (screenshot transport, multimodal tool messages):
  // the swatch color exists ONLY in rendered pixels — no color name appears
  // anywhere in the page text, hrefs, or attributes, and the want index is
  // opaque. A pass means the model saw the screenshot pixels the Rust loop
  // delivered as an image in the tool message (probe C proved the endpoint
  // accepts tool-role images; this journey proves it end-to-end through the
  // real product). ANALYZE cross-checks the `images=` census in
  // .ai-coordination/dev-supervisor.err.log. Blind guessing caps luck at
  // 1/4 (four buttons); the `want=` name in the server's verdict pins the
  // fixture side.
  const VISION_PALETTE = [
    "Crimson", "Amber", "Sea Green", "Slate Blue", "Magenta", "Teal",
    "Olive", "Coral", "Indigo", "Lime", "Violet", "Cyan",
  ];

  test("VISION: model reads screenshot pixels to name the swatch color and clicks the matching button", async ({ page, request }) => {
    const e2e = await arm(page, request);
    const want = 1 + Math.floor(Math.random() * VISION_PALETTE.length);
    const wantName = VISION_PALETTE[want - 1];
    const tab = await e2e.newTab();
    await e2e.navigate(tab, `/vision?want=${want}`);

    await runTurn(
      page,
      `Use the browser tools on the already-open tab at ${FIXTURE_BASE}/vision?want=${want} (do not open new tabs). ` +
        `The page shows one large color swatch. You MUST look at the page with the "tab_screenshot" tool ` +
        `(use format "jpeg", quality 60, max_dim 900) and judge the swatch color from the screenshot image itself. ` +
        `Do NOT use playwright_evaluate, dom snapshots, or page text to determine the color — it is only visible ` +
        `in the pixels. Then click the button whose label names that color.`,
    );

    await until(
      async () => (await tabUrl(e2e, tab)).includes("/vision/echo"),
      30_000,
      "click navigating to /vision/echo",
    );
    const verdict = await e2e.innerText(tab, "#vision-verdict");
    expect(verdict, `verdict: ${JSON.stringify(verdict)}`).toContain(`want=${wantName}`);
    expect(verdict, `verdict: ${JSON.stringify(verdict)}`).toContain("match=yes");
  });

  /**
   * AUDIT FINDING 3 — the last open gate: a browser turn that runs OUT of its
   * round budget must say so. The loop used to end silently with no final
   * answer and no [DONE] marker, and the raw tool arguments leaked into the
   * transcript; the repair made the ending explicit (`browser:capped` /
   * `browser:failed`). This journey proves the cap is what actually stopped the
   * work AND that the UI reports it honestly.
   *
   * ENV REQUIREMENT: the launcher's app must run with
   * `RUKE_BROWSER_MAX_TOOL_ROUNDS=3` (ruke-server chat/browser_loop.rs,
   * bounded_env, range 3..=64, read per turn so no rebuild is needed). The
   * dev supervisor forwards `...process.env` to ruke-server
   * (scripts/dev-supervisor.mjs), and the launcher's `Start-Process cmd.exe
   * /c "npm run dev"` inherits the invoking shell's environment, so the ONLY
   * thing that has to be right is how the variable reaches PowerShell.
   *
   * VERIFIED COMMAND (this repo's shell is Git Bash — see the post-mortem):
   *   powershell -NoProfile -Command '$env:RUKE_BROWSER_MAX_TOOL_ROUNDS="3"; & "scripts\run-browser-e2e-exclusive.ps1" -TestFiles "tests\browser-model-acceptance.spec.ts" -Grep "CAPPED" -AppWaitSeconds 300'
   *
   * POST-MORTEM (2026-11-06, first attempt): the same command was written with
   * DOUBLE quotes around the -Command body. Bash then expanded `$env` to the
   * empty string before PowerShell ever saw it, so the cap silently never
   * applied. The tell is in the launcher's captured dev-supervisor log — the
   * turn ran to `round=20` (the compiled default) and "browser tool loop
   * complete ... finish=stop", i.e. the model genuinely finished all seven
   * steps. A journey that finishes every step means the cap never applied and
   * this test measured NOTHING, so ALWAYS confirm the round count in that log
   * before trusting a CAPPED pass or blaming the app for a CAPPED failure:
   *   grep -n "browser tool loop complete\|round=" .ai-coordination/dev-supervisor.out.log
   * The chain itself is sound: PS → cmd → node all see the variable when the
   * -Command body is single-quoted in bash.
   *
   * The task below deliberately chains SEVEN separate page actions across three
   * fixture pages: even if the model batches some of them, three rounds cannot
   * complete it, and the final marker (/hard/success) is the objective tell that
   * the cap — not the model — ended the turn.
   */
  test("CAPPED: a turn that exhausts its round budget says 'Stopped early' and stops claiming the agent is driving", async ({ page, request }) => {
    test.info().annotations.push({ type: "env", description: "requires RUKE_BROWSER_MAX_TOOL_ROUNDS=3" });
    const e2e = await arm(page, request);
    const tab = await e2e.newTab();
    await e2e.navigate(tab, "/easy");

    await runTurn(
      page,
      `Use the browser tools on the already-open tab at ${FIXTURE_BASE}/easy (do not open new tabs). ` +
        `Do these steps one at a time, in this exact order, using a separate tool call for each: ` +
        `STEP 1 click the link with CSS selector "#go-arrived". ` +
        `STEP 2 navigate the same tab to ${FIXTURE_BASE}/medium. ` +
        `STEP 3 type CAPPED-PROBE-7Z into the input with CSS selector "#note-input". ` +
        `STEP 4 click the button with CSS selector "#submit-btn". ` +
        `STEP 5 navigate the same tab to ${FIXTURE_BASE}/hard/form. ` +
        `STEP 6 fill that form's fields and submit it. ` +
        `STEP 7 navigate the same tab to ${FIXTURE_BASE}/hard/success and read the marker shown there.`,
    );

    // Honesty gate 1: the progress chip names the real ending. "Stopped early"
    // comes from turnProgress.ts only for a turn the server marked capped — it
    // is never derived from the model's prose or from a timeout.
    const chip = page.getByTestId("progress-chip");
    await expect(chip, "the progress chip is missing after a capped turn").toBeVisible({ timeout: 15_000 });
    await expect(chip.getByText("Stopped early"), "the turn did not report its real ending")
      .toBeVisible({ timeout: 15_000 });

    // Honesty gate 2: the panel stops claiming the agent is still driving —
    // `browser:capped` clears agentActive, so the "working" indicator cannot
    // hang forever on a turn that has actually stopped.
    await expect(page.getByText("RUKE is driving")).toHaveCount(0, { timeout: 15_000 });

    // Objective proof the cap is what ended the turn: the last step's page was
    // never reached, while the earlier work really happened.
    const url = await tabUrl(e2e, tab);
    expect(url, `the turn completed despite the round cap: ${url}`).not.toContain("/hard/success");
  });
});
