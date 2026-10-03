import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:3000";

function itemByTitle(page: Page, title: string) {
  return page.locator('[data-testid="conversation-item"]', { hasText: title });
}

async function openMenuFor(page: Page, title: string) {
  await itemByTitle(page, title).hover();
  await itemByTitle(page, title).getByLabel("More actions").click();
}

/** Wait until the composer is enabled again (stream finished). */
async function waitForStreamDone(page: Page) {
  await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: 60000 });
}

test.describe("live chat lifecycle", () => {
  test("send → delete → reload leaves nothing behind", async ({ page }) => {
    const marker = "E2EMarker" + Date.now();

    await page.goto(BASE + "/");

    const box = page.locator("textarea").first();
    await box.click();
    await box.fill(marker);
    await box.press("Enter");

    await waitForStreamDone(page);

    await expect(itemByTitle(page, marker)).toBeVisible();

    await openMenuFor(page, marker);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByTestId("confirm-dialog-confirm").click(); // confirm dialog

    await expect(itemByTitle(page, marker)).toHaveCount(0);

    // The core of issue #1 + #2: nothing resurrects, and nothing clones.
    await page.waitForTimeout(1500);
    await expect(itemByTitle(page, marker)).toHaveCount(0);
    await page.reload();
    await expect(itemByTitle(page, marker)).toHaveCount(0);
  });

  test("two chats then New does not duplicate either", async ({ page }) => {
    const a = "E2EChatA" + Date.now();
    const b = "E2EChatB" + Date.now();

    await page.goto(BASE + "/");
    let box = page.locator("textarea").first();
    await box.click();
    await box.fill(a);
    await box.press("Enter");
    await waitForStreamDone(page);

    // Start a second chat from the sidebar.
    await page.locator("aside").getByRole("button", { name: "New conversation" }).click();
    box = page.locator("textarea").first();
    await box.click();
    await box.fill(b);
    await box.press("Enter");
    await waitForStreamDone(page);

    await expect(itemByTitle(page, a)).toHaveCount(1);
    await expect(itemByTitle(page, b)).toHaveCount(1);

    await page.reload();
    await expect(itemByTitle(page, a)).toHaveCount(1);
    await expect(itemByTitle(page, b)).toHaveCount(1);

    // Clean up.
    for (const t of [a, b]) {
      await openMenuFor(page, t);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByTestId("confirm-dialog-confirm").click();
      await expect(itemByTitle(page, t)).toHaveCount(0);
    }
    await page.reload();
    await expect(itemByTitle(page, a)).toHaveCount(0);
    await expect(itemByTitle(page, b)).toHaveCount(0);
  });
});
