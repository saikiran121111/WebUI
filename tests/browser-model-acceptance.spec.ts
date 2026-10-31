// Real-model acceptance journeys (plan rows 19–24) — leg 2 of the final
// locked loop. These are the ONLY specs in tests/ that touch the shared
// inference backend: run them through scripts/run-browser-e2e-exclusive.ps1
// (one journey per invocation via -Grep, full idle between — CLAUDE.md §1).
//
// Each journey: the human arms the browser turn through the REAL UI (TopBar
// "Open browser panel" toggle arms `browser_session`; the composer sends the
// prompt; the Rust tool loop drives the model's tool calls against the
// engine). Assertions read REAL engine/page state over the human-turn RPC —
// never command echoes, never model prose.
//
// Policy is pre-armed to "always allow" for the fixture host (access +
// uploads) — equivalent to the human clicking "Always allow" once — so
// approval cards (120 s window) never race the test clock. The gate itself
// is already exercised by smoke_lifecycle (Rust) and the approval-card UX
// by the panel; what this leg verifies is END-TO-END model→tool→page.
//
// PATIENCE RULE (docs/e2e-test-state.md): per-test timeout must exceed the
// assertion window plus model overflow. Marker-miss retries ONCE per plan.

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
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

/** Composer send + full model turn: wait until the stream (Stop button) ends. */
async function runTurn(page: Page, text: string): Promise<void> {
  await sendPrompt(page, text);
  await expect(page.getByLabel("Stop generating"), "model stream never finished").toHaveCount(0, { timeout: 240_000 });
  // The SSE closes when the loop emits its final answer; the engine-side
  // turn end (cleanup) lands within a moment of it.
  await sleep(1500);
}

test.describe("browser real-model acceptance (leg 2, one journey per locked invocation)", () => {
  test.describe.configure({ mode: "serial", retries: 1 });
  test.setTimeout(300_000);

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
        `type RUKE-MEDIUM-42X into the input with CSS selector "#note-input"; select the option value "business" ` +
        `in the select "#tier-select"; tick the checkbox "#subscribe-box"; check the radio button with CSS selector ` +
        `input[name="plan"][value="annual"]; then click the button "#submit-btn". Finally read the page and list ` +
        `the echoed lines you see.`,
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
});
