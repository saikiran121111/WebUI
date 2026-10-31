// Phase-18 EASY journey (no model): one trusted click drives a real
// navigation; the engine's own wait_for_url confirms the landed URL and the
// arrived page's marker is read back from the live DOM. This exercises the
// full product HTTP surface: Next proxy → Rust RPC → engine → Chromium.

import { test, expect } from "@playwright/test";
import {
  BrowserE2E,
  assertFixtureServerUp,
  EASY_ARRIVED,
} from "./browser-e2e-helpers";

test.beforeAll(async ({ request }) => {
  await assertFixtureServerUp(request);
});

test("easy: click → real navigation → wait_for_url → marker", async ({ request }) => {
  const e2e = new BrowserE2E(request, "e2e-easy");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/easy");
    await e2e.click(tab, "#go-arrived");
    const r = await e2e.command("playwright_wait_for_url", {
      tab_id: tab,
      url: "**/easy/arrived",
    });
    expect(String(r.url)).toMatch(/\/easy\/arrived$/);
    expect(await e2e.innerText(tab, "#arrived-marker")).toBe(EASY_ARRIVED);

    // The landed title/URL are authoritative reads, not payload echoes.
    const g = await e2e.getTab(tab);
    expect(String(g.url)).toMatch(/\/easy\/arrived$/);
    expect(typeof g.title).toBe("string");
  } finally {
    await e2e.closeFixtureTabs();
  }
});
