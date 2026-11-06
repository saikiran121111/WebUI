import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * RETIRED-FENCE COMPATIBILITY (Phase 4 gate, re-pinned by the 2026-11-06 audit —
 * finding 4).  The Phase 4 evidence only ever exercised the client-side
 * `?demo=ui` fixture, and `tests/cad.spec.ts` was left on disk asserting the
 * deleted CAD viewer.  These journeys use the REAL entry point for old saves:
 * a conversation seeded through `POST /api/conversations` (no model involved),
 * opened from the sidebar, reloaded, and its card's Download action clicked.
 *
 * Determinism law: no LLM traffic — the conversations are written straight to
 * the store, exactly like conversations-crud.spec.ts does.  What is asserted is
 * what the audit found unproven: the PERSISTED history path renders the honest
 * read-only card, never executes the retired renderer, and really downloads the
 * saved source.
 */

const BASE = "http://localhost:3000";
const EXPORT_DIR = path.join(process.cwd(), ".data", "exports");

const FENCES = {
  scene3d: {
    title: "Retired scene3d seed",
    marker: "SEED-SCENE-3D",
    card: "3D scene viewer retired",
    file: "retired-scene3d.json",
    body: '{"marker":"SEED-SCENE-3D","mesh":"THREE.Mesh","camera":{"position":[0,2,5]}}',
  },
  cad: {
    title: "Retired cad seed",
    marker: "SEED-CAD-PLAN",
    card: "CAD blueprint viewer retired",
    file: "retired-cad.json",
    body: '{"marker":"SEED-CAD-PLAN","scale":"1:100","walls":[{"id":"w1"}],"units":"m"}',
  },
} as const;

type RetiredKind = keyof typeof FENCES;

test.beforeAll(() => fs.mkdirSync(EXPORT_DIR, { recursive: true }));

/** Write a conversation straight to the store so no model is needed. */
async function seedFence(request: APIRequestContext, kind: RetiredKind, id: string) {
  const f = FENCES[kind];
  const title = `${f.title} ${id}`;
  const now = Date.now();
  const doc = {
    id,
    meta: {
      id, title, createdAt: now, updatedAt: now, pinned: false, archived: false,
      mode: "chat", preview: title, messageCount: 2,
    },
    messages: [
      {
        id: "u_" + id, conversationId: id, role: "user", content: title,
        reasoning: "", attachments: [], toolCalls: [], citations: [], createdAt: now,
        state: "complete", mode: "chat",
      },
      {
        id: "a_" + id, conversationId: id, role: "assistant",
        content: `Here is your saved ${kind}:\n\n\`\`\`${kind}\n${f.body}\n\`\`\`\n`,
        reasoning: "", attachments: [], toolCalls: [], citations: [], createdAt: now + 1,
        state: "complete", mode: "chat",
      },
    ],
  };
  const res = await request.post(`${BASE}/api/conversations`, { data: { id, json: JSON.stringify(doc) } });
  expect(res.ok(), `seed ${kind} conversation => ${res.status()}`).toBeTruthy();
  return title;
}

const itemByTitle = (page: Page, title: string) =>
  page.locator('[data-testid="conversation-item"]', { hasText: title });

/** Assert the honest read-only card, and that nothing retired ever executes. */
async function expectCompatCard(page: Page, kind: RetiredKind, label: string) {
  const f = FENCES[kind];
  const card = page.locator('[data-testid="retired-fence"]').first();
  await expect(card, `${label}: compat card must render for the saved ${kind} fence`).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText(f.card);
  await expect(card).toContainText("never executed");

  // The retired renderers are GONE: no viewer chrome, no canvas, no runtime.
  for (const gone of ["cad-block", "cad-stage", "cad-3d", "scene3d-block", "asset3d-block", "threejs-block"]) {
    await expect(card.page().locator(`[data-testid="${gone}"]`), `${label}: ${gone} must not exist`).toHaveCount(0);
  }
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(await page.evaluate(() => typeof (window as unknown as { THREE?: unknown }).THREE)).toBe("undefined");
  // The model is not asked to redraw anything: the card is static text.
  await expect(card.getByRole("button", { name: "Copy source" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Download source" })).toBeVisible();
}

async function downloadSource(page: Page, kind: RetiredKind, prefix: string) {
  const f = FENCES[kind];
  const card = page.locator('[data-testid="retired-fence"]').first();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    card.getByRole("button", { name: "Download source" }).click(),
  ]);
  expect(download.suggestedFilename(), `${prefix}: download name`).toBe(f.file);
  const file = path.join(EXPORT_DIR, `${prefix}-${download.suggestedFilename()}`);
  await download.saveAs(file);
  const text = fs.readFileSync(file, "utf8");
  // The saved source survives verbatim — that is the whole point of the card.
  expect(text, `${prefix}: downloaded file must be the saved fence source`).toContain(f.marker);
  expect(text).toContain(f.body);
}

for (const kind of Object.keys(FENCES) as RetiredKind[]) {
  test(`retired ${kind} fence from a saved conversation renders the compat card and never executes`, async ({ page, request }) => {
    const id = `c_retired_${kind}_${Date.now()}`;
    const title = await seedFence(request, kind, id);
    try {
      await page.goto(BASE + "/");
      await expect(itemByTitle(page, title)).toBeVisible({ timeout: 20000 });
      await itemByTitle(page, title).click();

      await expectCompatCard(page, kind, `${kind} first open`);
      await downloadSource(page, kind, `${kind}-open`);

      // Source is viewable on the history path too.
      const card = page.locator('[data-testid="retired-fence"]').first();
      await card.locator("summary").click();
      await expect(card.locator(".retired-fence-source")).toContainText(FENCES[kind].marker);

      // The persisted path, not just the demo fixture: a fresh load of the
      // saved conversation must render the same card.
      await page.reload();
      await expect(itemByTitle(page, title)).toBeVisible({ timeout: 20000 });
      await itemByTitle(page, title).click();
      await expectCompatCard(page, kind, `${kind} after reload`);
      await downloadSource(page, kind, `${kind}-reload`);
    } finally {
      await request.delete(`${BASE}/api/conversations/${id}`);
    }
  });
}
