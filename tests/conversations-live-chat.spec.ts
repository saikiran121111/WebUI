import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:3000";

/**
 * Items are addressed by data-conversation-id, NOT by title text: the
 * background title job replaces the first-message copy with a semantic
 * title seconds after a chat's first exchange, so title-text locators are
 * inherently racy. The id is stable through renames (the feature under test).
 */
function itemById(page: Page, id: string) {
  return page.locator(`[data-testid="conversation-item"][data-conversation-id="${id}"]`);
}

/** The just-opened conversation sits first (sidebar sorts by updatedAt). */
async function newestConversationId(page: Page): Promise<string> {
  const id = await page
    .locator('[data-testid="conversation-item"]')
    .first()
    .getAttribute("data-conversation-id");
  expect(id).toBeTruthy();
  return id!;
}

async function openMenuForId(page: Page, id: string) {
  await itemById(page, id).hover();
  await itemById(page, id).getByLabel("More actions").click();
}

/** Wait until the composer is enabled again (stream finished). */
async function waitForStreamDone(page: Page) {
  await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: 60000 });
}

test.describe("live chat lifecycle", () => {
  // Real-model turns: every send pays the Decision Engine round trip (~2-3 s
  // LFM2.5 router) plus the local model's reasoning. The assertions here are
  // about CRUD correctness, not speed — grant the same patience the
  // file-reading journey gives its model turns.
  test.setTimeout(180_000);

  test("send → delete → reload leaves nothing behind", async ({ page }) => {
    const marker = "E2EMarker" + Date.now();

    await page.goto(BASE + "/");

    const box = page.locator("textarea").first();
    await box.click();
    await box.fill(marker);
    await box.press("Enter");

    await waitForStreamDone(page);

    const id = await newestConversationId(page);
    await expect(itemById(page, id)).toBeVisible();

    await openMenuForId(page, id);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByTestId("confirm-dialog-confirm").click(); // confirm dialog

    await expect(itemById(page, id)).toHaveCount(0);

    // The core of issue #1 + #2: nothing resurrects, and nothing clones.
    await page.waitForTimeout(1500);
    await expect(itemById(page, id)).toHaveCount(0);
    await page.reload();
    await expect(itemById(page, id)).toHaveCount(0);
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
    const idA = await newestConversationId(page);

    // Start a second chat from the sidebar.
    await page.locator("aside").getByRole("button", { name: "New conversation" }).click();
    box = page.locator("textarea").first();
    await box.click();
    await box.fill(b);
    await box.press("Enter");
    await waitForStreamDone(page);
    const idB = await newestConversationId(page);

    await expect(itemById(page, idA)).toHaveCount(1);
    await expect(itemById(page, idB)).toHaveCount(1);

    await page.reload();
    await expect(itemById(page, idA)).toHaveCount(1);
    await expect(itemById(page, idB)).toHaveCount(1);

    // Clean up.
    for (const id of [idA, idB]) {
      await openMenuForId(page, id);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByTestId("confirm-dialog-confirm").click();
      await expect(itemById(page, id)).toHaveCount(0);
    }
    await page.reload();
    await expect(itemById(page, idA)).toHaveCount(0);
    await expect(itemById(page, idB)).toHaveCount(0);
  });
});
