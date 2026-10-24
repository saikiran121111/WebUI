/**
 * Browser-engine setting ⇄ OS-only contract.
 *
 * The NON-NEGOTIABLE invariant after the OS-only pivot: there is NO
 * built-in WebUI browser anywhere — no right panel, no toggle button, no
 * mirror canvas, no screencast endpoints. The Settings dropdown offers
 * exactly the user's four own browsers (Chrome first, the default), each
 * label naming the user's OWN browser. Legacy values ("internal") are
 * rejected by the API. The `browser-panel:open` event is dead: nothing in
 * the app listens anymore, so the DOM must stay panel-free even when it
 * is dispatched.
 *
 * Deliberately never POSTs a browser ACTION here — this spec verifies the
 * UI/API surface; the real Chrome driving flow is browser-fallback.spec.ts.
 */
import { test, expect, Page } from "@playwright/test";

const BASE = "http://localhost:3000";

const LABELS: Record<string, string> = {
  chrome: "Chrome Browser (User's Own Browser)",
  brave: "Brave Browser (User's Own Browser)",
  edge: "Edge Browser (User's Own Browser)",
  firefox: "Firefox Browser (User's Own Browser)",
};

async function setEngine(engine: string): Promise<void> {
  const res = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browser_engine: engine }),
  });
  expect(res.ok, `setting engine=${engine}`).toBe(true);
}

async function serverEngine(): Promise<string> {
  const j = await (await fetch(`${BASE}/api/settings`)).json();
  return String((j.settings ?? j).browser_engine ?? "");
}

/** Load the app and settle until the client has mirrored the server engine. */
async function loadApp(page: Page): Promise<void> {
  const settled = page.waitForResponse((r) => r.url().includes("/api/settings"), {
    timeout: 15_000,
  }).catch(() => null);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await settled;
}

async function openEngineTab(page: Page): Promise<void> {
  // exact:true + topbar scope: getByRole name matching is substring-based,
  // and TopBar also carries a disabled "Voice settings" button.
  await page.getByTestId("topbar").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-tab-browser").click();
}

test.describe("browser engine ⇄ OS-only contract", () => {
  test.afterAll(async () => {
    await setEngine("chrome"); // always leave the OS default engine in place
  });

  test("Settings exposes exactly the four own browsers, Chrome first; save is immediate", async ({
    page,
  }: { page: Page }) => {
    await setEngine("chrome");
    await loadApp(page);
    await openEngineTab(page);

    const select = page.getByTestId("settings-browser-engine");
    await expect(select).toBeVisible();
    const options = await select.locator("option").allTextContents();
    // Exact labels, exact order — the user must see THEIR browser named,
    // and Chrome (the validated default) leads the list.
    expect(options).toEqual([LABELS.chrome, LABELS.brave, LABELS.edge, LABELS.firefox]);
    expect(await select.inputValue()).toBe("chrome");

    await select.selectOption({ label: LABELS.brave });
    await expect(page.getByTestId("browser-engine-status")).toHaveText("Saved ✓");
    expect(await serverEngine()).toBe("brave");

    await select.selectOption({ label: LABELS.chrome });
    await expect(page.getByTestId("browser-engine-status")).toHaveText("Saved ✓");
    expect(await serverEngine()).toBe("chrome");
  });

  test("invalid engine values are rejected server-side (validation contract)", async () => {
    for (const bad of ["safari", "internal", "Built-in WebUI"]) {
      const res = await fetch(`${BASE}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browser_engine: bad }),
      });
      expect(res.status, `engine=${bad} must be rejected`).toBe(400);
    }
    // The stored value must be untouched by the rejected writes.
    expect(await serverEngine()).not.toBe("safari");
    expect(await serverEngine()).not.toBe("internal");
  });

  test("no built-in panel anywhere: no testid, no toggle, no mirror, dead events", async ({
    page,
  }: { page: Page }) => {
    for (const engine of ["chrome", "brave"] as const) {
      await test.step(`engine=${engine}`, async () => {
        await setEngine(engine);
        await loadApp(page);

        // The built-in panel is GONE from the product, not just hidden:
        // no panel testid in the DOM, no toggle button, no mirror canvas.
        await expect(page.locator('[data-testid="browser-panel"]')).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Browser" })).toHaveCount(0);
        await expect(
          page.locator('canvas[aria-label="Mirrored browser viewport"]'),
        ).toHaveCount(0);

        // The old fence auto-open event is dead — nothing listens, so the
        // DOM must stay panel-free even when something dispatches it.
        await page.evaluate(() => {
          window.dispatchEvent(
            new CustomEvent("browser-panel:open", { detail: { url: "https://example.com" } }),
          );
        });
        await page.waitForTimeout(500);
        await expect(page.locator('[data-testid="browser-panel"]')).toHaveCount(0);
      });
    }
  });

  test("mirror endpoints no longer exist at all (404, not a refusal)", async () => {
    // The screencast/mirror routes were deleted outright — there is no
    // code path that could ever serve a JPEG of any browser.
    const post = await fetch(`${BASE}/api/browser/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(post.status).toBe(404);
    const get = await fetch(`${BASE}/api/browser/stream`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(get.status).toBe(404);
    const lf = await fetch(`${BASE}/api/browser/last-frame`);
    expect(lf.status).toBe(404);
  });
});
