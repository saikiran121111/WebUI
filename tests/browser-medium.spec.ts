// Phase-18 MEDIUM journey (no model): every field kind — text fill, select,
// checkbox, radio — set through engine locator commands, verified LIVE on the
// page BEFORE submit, then the GET form submits for real and the fixture
// server's echo page must show the exact values round-tripped. Never model
// text, never command echoes: the source of truth is the live DOM and the
// server-parsed query string.

import { test, expect } from "@playwright/test";
import { BrowserE2E, assertFixtureServerUp } from "./browser-e2e-helpers";

test.beforeAll(async ({ request }) => {
  await assertFixtureServerUp(request);
});

test("medium: fill/select/check/radio → live pre-submit reads → exact echo", async ({
  request,
}) => {
  const e2e = new BrowserE2E(request, "e2e-medium");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/medium");

    await e2e.command("playwright_locator_fill", {
      tab_id: tab,
      selector: "#note-input",
      value: "hello world",
    });
    const sel = await e2e.command("playwright_locator_select_option", {
      tab_id: tab,
      selector: "#tier-select",
      option: "business",
    });
    expect(sel.selected_values).toEqual(["business"]);
    const chk = await e2e.command("playwright_locator_set_checked", {
      tab_id: tab,
      selector: "#subscribe-box",
      checked: true,
    });
    expect(chk.checked).toBe(true);
    await e2e.click(tab, "#plan-group input[name=plan][value=annual]");

    // REAL pre-submit state: the page itself reports what it holds.
    const live = await e2e.pwEvaluate(
      tab,
      "JSON.stringify({note: document.getElementById('note-input').value, " +
        "tier: document.getElementById('tier-select').value, " +
        "subscribe: document.getElementById('subscribe-box').checked, " +
        "plan: (document.querySelector('input[name=plan]:checked')||{}).value})",
    );
    expect(JSON.parse(String(live))).toEqual({
      note: "hello world",
      tier: "business",
      subscribe: true,
      plan: "annual",
    });

    await e2e.click(tab, "#submit-btn");
    await e2e.command("playwright_wait_for_url", {
      tab_id: tab,
      url: "**/medium/echo*",
    });
    const echo = await e2e.innerText(tab, "#echo-output");
    const lines = echo.split("\n");
    for (const want of ["note=hello world", "tier=business", "subscribe=yes", "plan=annual"]) {
      expect(lines, `echo: ${JSON.stringify(echo)}`).toContain(want);
    }
  } finally {
    await e2e.closeFixtureTabs();
  }
});
