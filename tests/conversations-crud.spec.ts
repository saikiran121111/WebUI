import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const BASE = "http://localhost:3000";

/** Create a conversation directly on disk so tests don't depend on the LLM. */
async function seedConversation(
  request: APIRequestContext,
  id: string,
  title: string,
  opts: { pinned?: boolean; archived?: boolean } = {},
) {
  const now = Date.now();
  const doc = {
    id,
    meta: {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      pinned: opts.pinned ?? false,
      archived: opts.archived ?? false,
      mode: "chat",
      preview: "hello",
      messageCount: 2,
    },
    messages: [
      {
        id: "u_" + id, conversationId: id, role: "user", content: title,
        reasoning: "", attachments: [], toolCalls: [], citations: [],
        createdAt: now, state: "complete", mode: "chat",
      },
      {
        id: "a_" + id, conversationId: id, role: "assistant", content: "hello",
        reasoning: "", attachments: [], toolCalls: [], citations: [],
        createdAt: now, state: "complete", mode: "chat",
      },
    ],
  };
  const res = await request.post(`${BASE}/api/conversations`, {
    data: { id, json: JSON.stringify(doc) },
  });
  expect(res.ok()).toBeTruthy();
}

async function cleanup(request: APIRequestContext, id: string) {
  await request.delete(`${BASE}/api/conversations/${id}`);
}

function itemByTitle(page: Page, title: string) {
  return page.locator('[data-testid="conversation-item"]', { hasText: title });
}

async function openMenuFor(page: Page, title: string) {
  await itemByTitle(page, title).hover();
  await itemByTitle(page, title).getByLabel("More actions").click();
}

test.describe("conversation CRUD", () => {
  test("delete removes the conversation permanently (survives reload)", async ({ page, request }) => {
    const id = "c_del_" + Date.now();
    const title = "DeleteMe " + Date.now();
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");
    await expect(itemByTitle(page, title)).toBeVisible();

    await openMenuFor(page, title);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByTestId("confirm-dialog-confirm").click(); // confirm dialog

    await expect(itemByTitle(page, title)).toHaveCount(0);

    // Issue #1: it must still be gone after a reload.
    await page.reload();
    await expect(itemByTitle(page, title)).toHaveCount(0);

    // And gone from the API too.
    const res = await request.get(`${BASE}/api/conversations/${id}`);
    expect(res.status()).toBe(404);
  });

  test("deleting the OPEN conversation does not clone it", async ({ page, request }) => {
    const id = "c_delactive_" + Date.now();
    const title = "DelActive " + Date.now();
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");

    // Open it — messages now live in client state.
    await itemByTitle(page, title).click();
    await expect(page.getByText("hello").first()).toBeVisible();

    await openMenuFor(page, title);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByTestId("confirm-dialog-confirm").click(); // confirm dialog

    // Issue #2: no clone may appear, immediately or after a reload.
    await expect(itemByTitle(page, title)).toHaveCount(0);
    await page.waitForTimeout(1000); // let any racing persist POST land
    await expect(itemByTitle(page, title)).toHaveCount(0);
    await page.reload();
    await expect(itemByTitle(page, title)).toHaveCount(0);

    const rows = await (await request.get(`${BASE}/api/conversations`)).json();
    const sameTitle = rows.filter((r: any) => r.meta.title === title);
    expect(sameTitle).toHaveLength(0);
  });

  test("New conversation does not clone the current one", async ({ page, request }) => {
    const id = "c_new_" + Date.now();
    const title = "NewSrc " + Date.now();
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");
    await itemByTitle(page, title).click();
    await expect(page.getByText("hello").first()).toBeVisible();

    await page.locator("aside").getByRole("button", { name: "New conversation" }).click();

    // No second copy of the source conversation may appear.
    await page.waitForTimeout(1000);
    await expect(itemByTitle(page, title)).toHaveCount(1);
    await page.reload();
    await expect(itemByTitle(page, title)).toHaveCount(1);

    await cleanup(request, id);
  });

  test("rename persists across reload", async ({ page, request }) => {
    const id = "c_ren_" + Date.now();
    const title = "RenOld " + Date.now();
    const renamed = "RenNew " + Date.now();
    await seedConversation(request, id, title);

    page.on("dialog", async d => {
      if (d.type() === "prompt") await d.accept(renamed);
      else await d.accept();
    });

    await page.goto(BASE + "/");
    await openMenuFor(page, title);
    await page.getByRole("button", { name: "Rename" }).click();
    await expect(itemByTitle(page, renamed)).toBeVisible();

    await page.reload();
    await expect(itemByTitle(page, renamed)).toBeVisible();
    await expect(itemByTitle(page, title)).toHaveCount(0);

    await cleanup(request, id);
  });

  test("pin persists across reload and moves to Pinned section", async ({ page, request }) => {
    const id = "c_pin_" + Date.now();
    const title = "PinMe " + Date.now();
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");
    await openMenuFor(page, title);
    await page.getByRole("button", { name: "Pin", exact: true }).click();

    await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
    await expect(itemByTitle(page, title)).toBeVisible();

    await page.reload();
    await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
    await expect(itemByTitle(page, title)).toBeVisible();

    // Unpin round-trips too.
    await openMenuFor(page, title);
    await page.getByRole("button", { name: "Unpin", exact: true }).click();
    await page.reload();
    await expect(page.getByText("Pinned", { exact: true })).toHaveCount(0);

    await cleanup(request, id);
  });

  test("archive hides from main list, persists, and unarchives", async ({ page, request }) => {
    const id = "c_arch_" + Date.now();
    const title = "ArchMe " + Date.now();
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");
    await openMenuFor(page, title);
    await page.getByRole("button", { name: "Archive", exact: true }).click();

    // Gone from the main list.
    await expect(itemByTitle(page, title)).toHaveCount(0);

    // Visible under the Archived section.
    await page.getByRole("button", { name: /Archived/ }).click();
    await expect(itemByTitle(page, title)).toBeVisible();

    // Survives reload.
    await page.reload();
    await page.getByRole("button", { name: /Archived/ }).click();
    await expect(itemByTitle(page, title)).toBeVisible();

    // Unarchive brings it back to the main list.
    await openMenuFor(page, title);
    await page.getByRole("button", { name: "Unarchive", exact: true }).click();
    await page.reload();
    await expect(itemByTitle(page, title)).toBeVisible();
    await expect(page.getByRole("button", { name: /Archived/ })).toHaveCount(0);

    await cleanup(request, id);
  });

  test("rename survives a new message in the open conversation", async ({ page, request }) => {
    const id = "c_renpersist_" + Date.now();
    const title = "RenPersistOld " + Date.now();
    const renamed = "RenPersistNew " + Date.now();
    await seedConversation(request, id, title);

    page.on("dialog", async d => {
      if (d.type() === "prompt") await d.accept(renamed);
      else await d.accept();
    });

    await page.goto(BASE + "/");
    await itemByTitle(page, title).click();
    await openMenuFor(page, title);
    await page.getByRole("button", { name: "Rename" }).click();
    await expect(itemByTitle(page, renamed)).toBeVisible();

    // The persist effect must not clobber the custom title back to the
    // first-message default.
    await page.reload();
    await expect(itemByTitle(page, renamed)).toBeVisible();
    await expect(itemByTitle(page, title)).toHaveCount(0);

    await cleanup(request, id);
  });
});
