import { test, expect, type APIRequestContext } from "@playwright/test";

const BASE = "http://localhost:3000";

/**
 * Conversation titles: the sidebar must show a semantic full-conversation
 * title, not the legacy first-message copy. Merge-protection tests need no
 * model; the title-job and live-journey tests use the shared local model
 * (same as conversations-live-chat) and get the same patience.
 */

interface SeedOpts {
  title: string;
  titleSource?: "auto" | "manual";
  firstContent?: string;
  assistantContent?: string;
}

async function seedConversation(request: APIRequestContext, id: string, opts: SeedOpts) {
  const now = Date.now();
  const first = opts.firstContent ?? opts.title;
  const doc = {
    id,
    meta: {
      id,
      title: opts.title,
      ...(opts.titleSource ? { titleSource: opts.titleSource } : {}),
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      mode: "chat",
      preview: "hello",
      messageCount: 2,
    },
    messages: [
      {
        id: "u_" + id, conversationId: id, role: "user", content: first,
        reasoning: "", attachments: [], toolCalls: [], citations: [],
        createdAt: now, state: "complete", mode: "chat",
      },
      {
        id: "a_" + id, conversationId: id, role: "assistant",
        content: opts.assistantContent ?? "hello",
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

async function fetchMeta(request: APIRequestContext, id: string) {
  const res = await request.get(`${BASE}/api/conversations/${id}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).meta;
}

async function cleanup(request: APIRequestContext, id: string) {
  await request.delete(`${BASE}/api/conversations/${id}`);
}

/**
 * Warm the shared llama.cpp slot once. The first model call of a run pays
 * the cold model load (observed: it blew a 120s test budget and the orphaned
 * bounded call then starved the next test). A tiny chat turn absorbs that
 * cost inside a test that already budgets for it.
 */
async function warmModel(request: APIRequestContext) {
  const res = await request.post(`${BASE}/api/chat`, {
    data: {
      model: "default",
      stream: false,
      messages: [{ role: "user", content: "Reply with exactly one word: ok" }],
    },
    timeout: 240_000,
  });
  expect(res.ok()).toBeTruthy();
}

test.describe("conversation titles", () => {
  test("a stale client save cannot clobber the server-owned auto title", async ({ request }) => {
    const id = "c_ttlmerge_" + Date.now();
    await seedConversation(request, id, {
      title: "Server Owned Title",
      titleSource: "auto",
      firstContent: "the user's original question text",
    });

    // Simulate the sidebar persisting with a list snapshot taken BEFORE the
    // title job landed: same doc, old title, no title bookkeeping fields.
    const staleDoc = await (await request.get(`${BASE}/api/conversations/${id}`)).json();
    staleDoc.meta.title = "Stale Client Title";
    delete staleDoc.meta.titleSource;
    delete staleDoc.meta.titleGenCount;
    delete staleDoc.meta.titleGenAt;
    const res = await request.post(`${BASE}/api/conversations`, {
      data: { id, json: JSON.stringify(staleDoc) },
    });
    expect(res.ok()).toBeTruthy();

    const meta = await fetchMeta(request, id);
    expect(meta.title).toBe("Server Owned Title");
    expect(meta.titleSource).toBe("auto");
    await cleanup(request, id);
  });

  test("a manual rename save wins over the stored title", async ({ request }) => {
    const id = "c_ttlman_" + Date.now();
    await seedConversation(request, id, { title: "Keep Me", titleSource: "manual" });

    const renamed = await (await request.get(`${BASE}/api/conversations/${id}`)).json();
    renamed.meta.title = "Renamed By User";
    renamed.meta.titleSource = "manual";
    const res = await request.post(`${BASE}/api/conversations`, {
      data: { id, json: JSON.stringify(renamed) },
    });
    expect(res.ok()).toBeTruthy();

    const meta = await fetchMeta(request, id);
    expect(meta.title).toBe("Renamed By User");
    expect(meta.titleSource).toBe("manual");
    await cleanup(request, id);
  });

  test("force title job regenerates a legacy first-message title from the full conversation", async ({ request }) => {
    test.setTimeout(300_000); // model warm-up (cold load) + one bounded title call
    await warmModel(request);
    const id = "c_ttlgen_" + Date.now();
    const first =
      "My whisper transcriptions have audio timestamps that drift later and later on long recordings, how can I fix this?";
    await seedConversation(request, id, {
      title: first.slice(0, 40), // the legacy auto-copy
      firstContent: first,
      assistantContent: "Variable frame rate audio is the usual cause; re-encode to CFR before running whisper.",
    });

    const res = await request.post(`${BASE}/api/conversations/${id}/title?force=1`, {
      data: { model: "default" },
    });
    expect(res.ok()).toBeTruthy();
    const out = await res.json();
    expect(out.queued).toBe(true);
    expect(out.ok).toBe(true);
    expect(typeof out.title).toBe("string");
    expect(out.title.length).toBeGreaterThan(1);
    expect(out.title.length).toBeLessThanOrEqual(60);
    expect(out.title).not.toBe(first.slice(0, 40));

    const meta = await fetchMeta(request, id);
    expect(meta.title).toBe(out.title);
    expect(meta.titleSource).toBe("auto");
    expect(meta.titleGenCount).toBe(2);
    await cleanup(request, id);
  });

  test("force title job never touches a manual title", async ({ request }) => {
    const id = "c_ttlkeep_" + Date.now();
    await seedConversation(request, id, { title: "User Chose This", titleSource: "manual" });

    const res = await request.post(`${BASE}/api/conversations/${id}/title?force=1`, {
      data: { model: "default" },
    });
    expect(res.ok()).toBeTruthy();
    const out = await res.json();
    expect(out.queued).toBe(false);
    expect(out.reason).toBe("manual");

    const meta = await fetchMeta(request, id);
    expect(meta.title).toBe("User Chose This");
    await cleanup(request, id);
  });

  test("live chat: the sidebar title stops being the first-message copy", async ({ page, request }) => {
    test.setTimeout(300_000); // model warm-up + real-model turn + router + title call
    await warmModel(request);

    const prompt =
      "Can you help me debug why my GPU stopped being detected after I replaced the thermal interface on my PC? " +
      "lspci lists the card but nvidia-smi cannot initialize the driver.";
    const placeholder = prompt.slice(0, 40);

    await page.goto(BASE + "/");
    const box = page.locator("textarea").first();
    await box.click();
    await box.fill(prompt);
    await box.press("Enter");

    // Stream settles → one save lands → the legacy placeholder title shows.
    await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: 120000 });
    const item = page.locator('[data-testid="conversation-item"]').first();
    await expect(item).toContainText(placeholder, { timeout: 30000 });
    const convId = await item.getAttribute("data-conversation-id");

    // The background title job (full-history, main model) replaces it without
    // a page reload.
    await expect
      .poll(async () => (await item.innerText()).includes(placeholder), { timeout: 120000 })
      .toBe(false);

    const title = (await item.innerText()).trim();
    expect(title.length).toBeGreaterThan(1);
    expect(title.length).toBeLessThanOrEqual(60);

    // And it persists across a reload.
    await page.reload();
    await expect(page.locator('[data-testid="conversation-item"]').first()).toContainText(title.slice(0, 20));

    if (convId) await cleanup(request, convId);
  });
});
