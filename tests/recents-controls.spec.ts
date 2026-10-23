import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const BASE = "http://localhost:3000";

/** Seed a conversation directly on disk (model-free), with optional
 *  pinned/archived flags and an updatedAt backdate for activity tests. */
async function seedConversation(
  request: APIRequestContext,
  id: string,
  title: string,
  opts: { pinned?: boolean; archived?: boolean; updatedAtDaysAgo?: number } = {},
) {
  const now = Date.now();
  const ts = now - (opts.updatedAtDaysAgo ?? 0) * 86_400_000;
  const doc = {
    id,
    meta: {
      id,
      title,
      createdAt: ts,
      updatedAt: ts,
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
        createdAt: ts, state: "complete", mode: "chat",
      },
      {
        id: "a_" + id, conversationId: id, role: "assistant", content: "hello",
        reasoning: "", attachments: [], toolCalls: [], citations: [],
        createdAt: ts, state: "complete", mode: "chat",
      },
    ],
  };
  const res = await request.post(`${BASE}/api/conversations`, {
    data: { id, json: JSON.stringify(doc) },
  });
  expect(res.ok()).toBeTruthy();
}

async function cleanup(request: APIRequestContext, ids: string[]) {
  for (const id of ids) await request.delete(`${BASE}/api/conversations/${id}`);
}

function itemByTitle(page: Page, title: string) {
  return page.locator('[data-testid="conversation-item"]', { hasText: title });
}

/** Open the filter popover and pick an option in one row's flyout. */
async function pickFilter(page: Page, row: "status" | "activity" | "group" | "sort", label: RegExp | string) {
  await page.keyboard.press("Escape"); // close any still-open popover
  await page.getByTestId("recents-filter-toggle").click();
  await expect(page.getByTestId("recents-filter-menu")).toBeVisible();
  await page.getByTestId(`recents-filter-row-${row}`).hover();
  await expect(page.getByTestId(`recents-filter-${row}`)).toBeVisible();
  await page.getByTestId(`recents-filter-${row}`).getByText(label, { exact: typeof label === "string" }).click();
}

test.describe("Recents collapse / View all / filters", () => {
  test("collapse hides the list and View all expands it back", async ({ page, request }) => {
    const uniq = "rc" + Date.now();
    const id = "c_" + uniq;
    const title = "RecCollapse " + uniq;
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");
    await expect(itemByTitle(page, title)).toBeVisible();

    await page.getByTestId("recents-toggle").click();
    await expect(page.getByTestId("conversation-list")).toHaveCount(0);
    await expect(page.getByTestId("recents-view-all")).toBeVisible();

    // Collapsed parity: the pill opens the full-screen browser modal; the
    // chevron expands the inline list again.
    await page.getByTestId("recents-view-all").click();
    await expect(page.getByTestId("recents-modal")).toBeVisible();
    await page.getByTestId("recents-modal-close").click();
    await expect(page.getByTestId("recents-modal")).toHaveCount(0);

    await page.getByTestId("recents-expand").click();
    await expect(itemByTitle(page, title)).toBeVisible();

    await cleanup(request, [id]);
  });

  test("filter menu Delete row enters select mode", async ({ page, request }) => {
    const uniq = "rd" + Date.now();
    const id = "c_" + uniq;
    const title = "RecDel " + uniq;
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");
    await expect(itemByTitle(page, title)).toBeVisible();

    await page.getByTestId("recents-filter-toggle").click();
    await expect(page.getByTestId("recents-filter-menu")).toBeVisible();
    await page.getByTestId("recents-filter-delete").click();

    // Popover closed; the sidebar select strip appeared.
    await expect(page.getByTestId("recents-filter-menu")).toHaveCount(0);
    await expect(page.getByTestId("select-all")).toBeVisible();

    await cleanup(request, [id]);
  });

  test("status filter: Active hides archived, Archived shows only archived", async ({ page, request }) => {
    const uniq = "rs" + Date.now();
    const archId = "c_arch" + uniq, actId = "c_act" + uniq;
    const archTitle = "RecArch " + uniq, actTitle = "RecAct " + uniq;
    await seedConversation(request, archId, archTitle, { archived: true });
    await seedConversation(request, actId, actTitle);

    await page.goto(BASE + "/");
    // Default status "All": archived sits behind the disclosure.
    await page.getByRole("button", { name: /Archived/ }).click();
    await expect(itemByTitle(page, archTitle)).toBeVisible();

    await pickFilter(page, "status", "Active");
    await expect(itemByTitle(page, archTitle)).toHaveCount(0);
    await expect(itemByTitle(page, actTitle)).toBeVisible();

    await pickFilter(page, "status", "Archived");
    await expect(itemByTitle(page, archTitle)).toBeVisible();
    await expect(itemByTitle(page, actTitle)).toHaveCount(0);

    await cleanup(request, [archId, actId]);
  });

  test("sort by Title reorders the seeded pair", async ({ page, request }) => {
    const uniq = "rt" + Date.now();
    const aId = "c_a" + uniq, zId = "c_z" + uniq;
    // Same uniq token → the locator pair below matches ONLY these two chats,
    // so nth() order is deterministic regardless of other store contents.
    // RecZzz gets the NEWER updatedAt so the default "Last activity" sort
    // must put it first; Title sort must then flip the pair.
    await seedConversation(request, aId, "RecAaa " + uniq, { updatedAtDaysAgo: 2 });
    await seedConversation(request, zId, "RecZzz " + uniq, { updatedAtDaysAgo: 0 });

    await page.goto(BASE + "/");
    const pair = page.locator('[data-testid="conversation-item"]', { hasText: uniq });
    await expect(pair).toHaveCount(2);
    await expect(pair.nth(0)).toContainText("RecZzz"); // default: last activity

    await pickFilter(page, "sort", /Title/);
    await expect(pair.nth(0)).toContainText("RecAaa");

    await cleanup(request, [aId, zId]);
  });

  test("last activity: Today hides a 40-day-old chat", async ({ page, request }) => {
    const uniq = "ra" + Date.now();
    const oldId = "c_old" + uniq, newId = "c_new" + uniq;
    const oldTitle = "RecOld " + uniq, newTitle = "RecNew " + uniq;
    await seedConversation(request, oldId, oldTitle, { updatedAtDaysAgo: 40 });
    await seedConversation(request, newId, newTitle);

    await page.goto(BASE + "/");
    await expect(itemByTitle(page, oldTitle)).toBeVisible();

    await pickFilter(page, "activity", "Today");
    await expect(itemByTitle(page, oldTitle)).toHaveCount(0);
    await expect(itemByTitle(page, newTitle)).toBeVisible();

    await cleanup(request, [oldId, newId]);
  });

  test("group by None removes the Pinned section header", async ({ page, request }) => {
    const uniq = "rg" + Date.now();
    const pinId = "c_pin" + uniq;
    const pinTitle = "RecPin " + uniq;
    await seedConversation(request, pinId, pinTitle, { pinned: true });

    await page.goto(BASE + "/");
    await expect(itemByTitle(page, pinTitle)).toBeVisible();
    await expect(page.getByText("Pinned", { exact: true })).toBeVisible();

    await pickFilter(page, "group", "None");
    await expect(page.getByText("Pinned", { exact: true })).toHaveCount(0);
    await expect(itemByTitle(page, pinTitle)).toBeVisible();

    await cleanup(request, [pinId]);
  });
});
