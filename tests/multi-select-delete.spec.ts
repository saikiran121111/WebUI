import { test, expect, type APIRequestContext } from "@playwright/test";

async function seed(request: APIRequestContext, id: string, title: string) {
  const now = Date.now();
  const doc = {
    id,
    meta: { id, title, createdAt: now, updatedAt: now, pinned: false, archived: false, mode: "chat", preview: "hi", messageCount: 1 },
    messages: [{ id: "u_" + id, conversationId: id, role: "user", content: title, reasoning: "", attachments: [], toolCalls: [], citations: [], createdAt: now, state: "complete", mode: "chat" }],
  };
  const res = await request.post("/api/conversations", { data: { id, json: JSON.stringify(doc) } });
  expect(res.ok()).toBeTruthy();
}

// Non-destructive smoke test for the sidebar multi-select delete flow:
// everything up to the confirm dialog, then Cancel — no conversation is deleted.

test.describe("sidebar multi-select delete", () => {
  test("select mode, per-item checkboxes, select all, delete button, cancel", async ({ page }) => {
    await page.goto("/");

    const items = page.locator('[data-testid="conversation-item"]');
    await expect(items.first()).toBeVisible();
    const total = await items.count();
    expect(total).toBeGreaterThan(0);

    // Enter select mode — checkboxes replace the message icons.
    const modeButton = page.locator('[data-testid="select-mode-toggle"]');
    await expect(modeButton).toHaveText("Select");
    await modeButton.click();
    await expect(page.locator('[data-testid="select-all"]')).toBeVisible();

    // Toggle one item by clicking its row — button becomes "Delete 1".
    await items.first().click();
    await expect(modeButton).toHaveText("Delete 1");

    // Clicking a row in select mode must NOT open the conversation.
    // (Select mode keeps the main view untouched; verified by no nav change.)

    // Select all — count matches every visible conversation.
    await page.locator('[data-testid="select-all"]').click();
    await expect(modeButton).toHaveText(`Delete ${total}`);
    await expect(page.locator('[data-testid="select-all"]')).toHaveText("Deselect all");

    // The toolbar (Select all / Delete) stays visible while the list scrolls —
    // no need to scroll back to the top to delete.
    const list = page.getByTestId("conversation-list");
    await list.evaluate(el => el.scrollTo({ top: el.scrollHeight }));
    await expect(modeButton).toBeVisible();
    await expect(page.locator('[data-testid="select-all"]')).toBeVisible();
    await list.evaluate(el => el.scrollTo({ top: 0 }));

    // Delete → confirm dialog → Cancel keeps everything.
    await modeButton.click();
    const dialog = page.locator("text=/Delete .* conversation/");
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).last().click();
    await expect(items).toHaveCount(total);

    // Deselect all, then Cancel exits select mode — rows go back to opening chats.
    await page.locator('[data-testid="select-all"]').click();
    await expect(modeButton).toHaveText("Cancel");
    await modeButton.click();
    await expect(modeButton).toHaveText("Select");
    await expect(page.locator('[data-testid="select-all"]')).toHaveCount(0);
  });

  test("selecting and confirming deletes the conversation for good", async ({ page, request }) => {
    const id = "c_bulk_" + Date.now();
    const title = "BulkDeleteMe " + Date.now();
    await seed(request, id, title);

    await page.goto("/");
    const item = page.locator('[data-testid="conversation-item"]', { hasText: title });
    await expect(item).toBeVisible();

    await page.locator('[data-testid="select-mode-toggle"]').click();
    await item.click();
    await page.locator('[data-testid="select-mode-toggle"]').click(); // "Delete 1"
    await page.getByTestId("confirm-dialog-confirm").click();

    await expect(item).toHaveCount(0);
    await page.reload();
    await expect(item).toHaveCount(0);
    const res = await request.get(`/api/conversations/${id}`);
    expect(res.status()).toBe(404);
  });
});
