import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const BASE = "http://localhost:3000";

/** Seed a conversation directly on disk (model-free), with optional
 *  archived/group/unread flags and an updatedAt backdate. */
async function seedConversation(
  request: APIRequestContext,
  id: string,
  title: string,
  opts: { archived?: boolean; group?: string; unread?: boolean; updatedAtDaysAgo?: number } = {},
) {
  const now = Date.now();
  const ts = now - (opts.updatedAtDaysAgo ?? 0) * 86_400_000;
  const meta: Record<string, unknown> = {
    id, title,
    createdAt: ts, updatedAt: ts,
    pinned: false, archived: opts.archived ?? false,
    mode: "chat", preview: "hello", messageCount: 2,
  };
  if (opts.group) meta.group = opts.group;
  if (opts.unread) meta.unread = true;
  const doc = {
    id, meta,
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

async function openModal(page: Page) {
  await page.getByTestId("recents-browse").click();
  await expect(page.getByTestId("recents-modal")).toBeVisible();
}

/** Rows inside the modal only (the sidebar shows the same conversations). */
function modalRows(page: Page, hasText?: string | RegExp) {
  const rows = page.getByTestId("recents-modal").getByTestId("recents-modal-row");
  return hasText === undefined ? rows : rows.filter({ hasText });
}

async function metaOf(request: APIRequestContext, id: string) {
  const doc = await (await request.get(`${BASE}/api/conversations/${id}`)).json();
  return doc.meta as Record<string, unknown>;
}

test.describe("Recents full-screen modal", () => {
  test("opens via browse; tabs and search scope the rows", async ({ page, request }) => {
    const uniq = "m1" + Date.now();
    const actId = "c_act" + uniq, archId = "c_arch" + uniq;
    const actTitle = "ModAct " + uniq, archTitle = "ModArch " + uniq;
    await seedConversation(request, actId, actTitle);
    await seedConversation(request, archId, archTitle, { archived: true });

    await page.goto(BASE + "/");
    await openModal(page);
    await expect(page.getByTestId("recents-modal").getByText("Recents", { exact: true })).toBeVisible();

    // Active tab: active chat visible, archived hidden. Relative-time label.
    await expect(modalRows(page, actTitle)).toBeVisible();
    await expect(modalRows(page, archTitle)).toHaveCount(0);
    await expect(modalRows(page, actTitle)).toContainText("Just now");

    await page.getByTestId("recents-tab-archived").click();
    await expect(modalRows(page, archTitle)).toBeVisible();
    await expect(modalRows(page, actTitle)).toHaveCount(0);

    // Search narrows to matching rows.
    await page.getByTestId("recents-tab-active").click();
    await page.getByTestId("recents-modal-search").fill(uniq);
    await expect(modalRows(page)).toHaveCount(1);
    await expect(modalRows(page, actTitle)).toBeVisible();

    await cleanup(request, [actId, archId]);
  });

  test("bulk pin from select mode persists to disk", async ({ page, request }) => {
    const uniq = "m2" + Date.now();
    const id = "c_pin" + uniq;
    const title = "ModPin " + uniq;
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");
    await openModal(page);
    await page.getByTestId("recents-modal-select").click();
    await modalRows(page, title).click();
    await expect(page.getByText("1 selected")).toBeVisible();

    await page.getByTestId("recents-modal-bulk-pin").click();
    await expect
      .poll(async () => (await metaOf(request, id)).pinned, { timeout: 10_000 })
      .toBe(true);

    // Sidebar row shows the pin indicator after the list refresh.
    await page.getByTestId("recents-modal-close").click();
    await expect(
      page.locator('[data-testid="conversation-item"]', { hasText: title }).locator("svg.lucide-pin"),
    ).toBeVisible();

    await cleanup(request, [id]);
  });

  test("mark unread shows sidebar dot; opening the chat clears it", async ({ page, request }) => {
    const uniq = "m3" + Date.now();
    const id = "c_unr" + uniq;
    const title = "ModUnread " + uniq;
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");
    await openModal(page);
    await page.getByTestId("recents-modal-select").click();
    await modalRows(page, title).click();
    await page.getByTestId("recents-modal-bulk-unread").click();
    await expect
      .poll(async () => (await metaOf(request, id)).unread, { timeout: 10_000 })
      .toBe(true);

    // Dot in the modal row + sidebar row (Claude parity).
    await expect(modalRows(page, title).getByTestId("recents-modal-unread-dot")).toBeVisible();
    await page.getByTestId("recents-modal-exit-select").click();
    await page.getByTestId("recents-modal-close").click();
    await expect(
      page.locator('[data-testid="conversation-item"]', { hasText: title }).getByTestId("unread-dot"),
    ).toBeVisible();

    // Reopen via the modal row: chat opens, modal closes, dot clears.
    await openModal(page);
    await modalRows(page, title).click();
    await expect(page.getByTestId("recents-modal")).toHaveCount(0);
    await expect
      .poll(async () => (await metaOf(request, id)).unread ?? false, { timeout: 10_000 })
      .toBe(false);
    await expect(
      page.locator('[data-testid="conversation-item"]', { hasText: title }).getByTestId("unread-dot"),
    ).toHaveCount(0);

    await cleanup(request, [id]);
  });

  test("move to group creates the chip bar and the sidebar Groups filter", async ({ page, request }) => {
    const uniq = "m4" + Date.now();
    const inId = "c_ing" + uniq, outId = "c_out" + uniq;
    const inTitle = "ModGrpIn " + uniq, outTitle = "ModGrpOut " + uniq;
    await seedConversation(request, inId, inTitle);
    await seedConversation(request, outId, outTitle);

    await page.goto(BASE + "/");
    await openModal(page);
    await page.getByTestId("recents-modal-select").click();
    await modalRows(page, inTitle).click();
    await page.getByTestId("recents-modal-bulk-group").click();
    await page.getByTestId("recents-modal-group-name").fill("Alpha " + uniq);
    await page.getByTestId("recents-modal-group-save").click();
    await expect
      .poll(async () => (await metaOf(request, inId)).group, { timeout: 10_000 })
      .toBe("Alpha " + uniq);
    expect((await metaOf(request, outId)).group).toBeUndefined();

    // The modal chip bar now offers the group.
    await expect(page.getByTestId(`recents-group-chip-Alpha ${uniq}`)).toBeVisible();

    // Sidebar filter popup gains the Groups row; picking the group filters
    // the sidebar list down to the grouped chat.
    await page.getByTestId("recents-modal-close").click();
    await page.getByTestId("recents-filter-toggle").click();
    await page.getByTestId("recents-filter-row-groups").hover();
    await expect(page.getByTestId("recents-filter-groups")).toBeVisible();
    await page.getByTestId("recents-filter-groups").getByText("Alpha " + uniq, { exact: true }).click();
    await expect(itemByTitle(page, inTitle)).toBeVisible();
    await expect(itemByTitle(page, outTitle)).toHaveCount(0);

    await cleanup(request, [inId, outId]);
  });

  test("bulk delete uses the ConfirmDialog and clears disk", async ({ page, request }) => {
    const uniq = "m5" + Date.now();
    const id = "c_del" + uniq;
    const title = "ModDel " + uniq;
    await seedConversation(request, id, title);

    await page.goto(BASE + "/");
    await openModal(page);
    await page.getByTestId("recents-modal-select").click();
    await modalRows(page, title).click();
    await page.getByTestId("recents-modal-bulk-delete").click();

    // ConfirmDialog (z-999) sits above the modal (z-200).
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect
      .poll(async () => (await request.get(`${BASE}/api/conversations/${id}`)).status(), { timeout: 10_000 })
      .toBe(404);
    await expect(modalRows(page, title)).toHaveCount(0);

    await cleanup(request, [id]);
  });
});

function itemByTitle(page: Page, title: string) {
  return page.locator('[data-testid="conversation-item"]', { hasText: title });
}
