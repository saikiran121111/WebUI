import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

const BASE = "http://localhost:3000";

/**
 * Auto-compact context: verifies the Settings → Context tab UI (preset +
 * custom threshold, 8k–1M validation), the settings.json round-trip, the
 * composer /compact command + the "Context compacted" divider badge, and the
 * pre-send auto-compact gate (fold → replacement history shipped to the
 * model → NO re-compaction on the following turn).
 *
 * The three mocked tests intercept POST /api/chat so the compaction request
 * (which carries the COMPACTION system prompt) returns a canned
 * <compacted_context> block. But interception BYPASSES the real chat route —
 * and the real 2026-10-22 bug lived exactly there: the route re-ran the
 * Decision Engine + web gate over the compaction payload, injected a
 * renderer skill block mid-history, and destroyed the <compacted_context>
 * contract. So the last two tests hit the REAL route against the REAL
 * shared inference backend (Section-1 lock protocol applies when running):
 *   - route contract: a `purpose:"compact"` request carries NO ruke_stage
 *     progress frames (decision pipeline skipped), while an identical plain
 *     request does;
 *   - full manual /compact with zero interception: real model folds a small
 *     seeded history and the divider lands `data-state="done"`.
 *
 * Requires the dev server on http://localhost:3000 (npm run dev) and the
 * inference backend for the last two tests.
 */

const SETTINGS_TAB = '[data-testid="settings-tab-context"]';
const CONTEXT_TAB = '[data-testid="settings-context-tab"]';
const COMPACT_TOGGLE = '[data-testid="compact-toggle"]';
const COMPACT_SAVE = '[data-testid="compact-save"]';
const COMPACT_STATUS = '[data-testid="compact-status"]';
const COMPACT_CUSTOM = '[data-testid="compact-custom-input"]';
const COMPACT_PRESET = (label: string) => `[data-testid="compact-preset-${label}"]`;
const DIVIDER = '[data-testid="compact-divider"]';
const ASSISTANT = '[data-testid="assistant-message"]';

/** Marker planted in the OLDEST seeded turns; must NOT survive into the
 *  post-compaction request (it was folded), unlike the recent tail. */
const OLD_MARKER = "OLDEST-TURN-MARKER";

const COMPACTION_BLOCK =
  "<analysis>Chronological walk: exploratory chatter removed, final state kept.</analysis>\n\n" +
  "<compacted_context>\n## 1. User Rules & Preferences\n- keep answers terse\n\n" +
  "## 2. Current Architecture & Exact State\n- seeded multi-turn conversation state captured\n\n" +
  "## 5. Active Context & Next Steps\n- **Last Completed Action:** compaction\n" +
  "- **Immediate Open Task:** answer the new user question\n</compacted_context>";

const NORMAL_REPLY = "MODEL-SAW-THE-COMPACTED-BLOCK";

/* ── Mocked chat upstream (paced SSE, /hits counters) ─────────────────── */

interface UpstreamState {
  compactions: number;   // requests carrying the compaction system prompt
  normal: number;        // real user turns
  lastNormalCount: number;
  lastNormalHadBlock: boolean;     // shipped a <compacted_context> message
  lastNormalHadOldMarker: boolean; // shipped a folded-away old turn
}

/**
 * Paced SSE upstream: compaction requests (system content contains the
 * Context Compaction Engine marker) stream the canned block; everything else
 * streams a short reply. GET /hits exposes the counters for assertions.
 */
function startCompactUpstream(): Promise<{ port: number; close: () => void }> {
  const state: UpstreamState = {
    compactions: 0, normal: 0, lastNormalCount: 0,
    lastNormalHadBlock: false, lastNormalHadOldMarker: false,
  };

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/hits")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      let payload: any = {};
      try { payload = JSON.parse(body); } catch { /* keep empty */ }
      const msgs: any[] = Array.isArray(payload.messages) ? payload.messages : [];
      const textOf = (m: any) => (typeof m?.content === "string" ? m.content : "");

      const isCompaction = msgs.some((m) => textOf(m).includes("Context Compaction Engine"));
      if (isCompaction) {
        state.compactions++;
      } else {
        state.normal++;
        state.lastNormalCount = msgs.length;
        state.lastNormalHadBlock = msgs.some((m) => textOf(m).includes("<compacted_context>"));
        state.lastNormalHadOldMarker = msgs.some((m) => textOf(m).includes(OLD_MARKER));
      }

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const text = isCompaction ? COMPACTION_BLOCK : NORMAL_REPLY;
      // Frames via setTimeout with liveness checks — NOT req.on("close")
      // cleanup: registering a close listener inside req.on("end") fires
      // immediately (the body stream is already closed) and would wipe every
      // scheduled frame, hanging the fetch forever.
      const timers: NodeJS.Timeout[] = [];
      const alive = () => !res.writableEnded && !res.destroyed;
      let wait = 60;
      for (let i = 0; i < text.length; i += 64) {
        const chunk = text.slice(i, i + 64);
        timers.push(setTimeout(() => {
          if (alive()) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        }, wait));
        wait += isCompaction ? 15 : 40;
      }
      timers.push(setTimeout(() => {
        if (alive()) { res.write("data: [DONE]\n\n"); res.end(); }
      }, wait + 50));
      res.on("close", () => timers.forEach(clearTimeout));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => server.close(),
      }),
    );
  });
}

const readHits = async (request: APIRequestContext, port: number): Promise<UpstreamState> =>
  await (await request.get(`http://127.0.0.1:${port}/hits`)).json();

/* ── App-side helpers ──────────────────────────────────────────────────── */

async function setCompactSettings(request: APIRequestContext, t: { auto: 0 | 1; tokens: number }) {
  const res = await request.put(`${BASE}/api/settings`, { data: { compact_thresholds: t } });
  expect(res.ok()).toBeTruthy();
}

/**
 * Open the Settings menu (gear icon, aria-label "Settings") and land on the
 * Context tab.
 */
async function openContextTab(page: Page) {
  await page.locator('header [aria-label="Settings"]').click();
  await page.locator(SETTINGS_TAB).click();
  await expect(page.locator(CONTEXT_TAB)).toBeVisible();
}

/**
 * Seed a multi-turn conversation on disk so there is history to compact.
 * `chars` = content length per message (token pressure for the auto gate);
 * `markerTurns` = oldest turns that carry OLD_MARKER (these MUST be folded).
 */
async function seedConversation(
  request: APIRequestContext, id: string, turns: number,
  opts: { chars?: number; markerTurns?: number } = {},
) {
  const now = Date.now();
  const chars = opts.chars ?? 40;
  const pad = (n: number) =>
    ` filler${n} ` + "x".repeat(Math.max(0, chars - 12)) + (n < (opts.markerTurns ?? 0) ? ` ${OLD_MARKER}` : "");
  const msgs = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({
      id: "u_" + id + "_" + i, conversationId: id, role: "user", content: `Q${i}${pad(i)}`,
      reasoning: "", attachments: [], toolCalls: [], citations: [], createdAt: now, state: "complete", mode: "chat",
    });
    msgs.push({
      id: "a_" + id + "_" + i, conversationId: id, role: "assistant", content: `A${i}${pad(i)}`,
      reasoning: "", attachments: [], toolCalls: [], citations: [], createdAt: now, state: "complete", mode: "chat",
    });
  }
  const doc = {
    id,
    meta: { id, title: "compact-seed-" + id, createdAt: now, updatedAt: now, pinned: false, archived: false, mode: "chat", preview: "seed", messageCount: msgs.length },
    messages: msgs,
  };
  const res = await request.post(`${BASE}/api/conversations`, { data: { id, json: JSON.stringify(doc) } });
  expect(res.ok()).toBeTruthy();
}

/** Open a seeded conversation from the sidebar (after goto). */
async function openSeed(page: Page, id: string) {
  const row = page.locator('[data-testid="conversation-item"]').filter({ hasText: "compact-seed-" + id }).first();
  await expect(row).toBeVisible();
  await row.click();
}

async function sendFromBar(page: Page, text: string) {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

/* ── Tests ─────────────────────────────────────────────────────────────── */

test.afterEach(async ({ request }) => {
  // Auto-compact off so other specs never trip the gate.
  await setCompactSettings(request, { auto: 0, tokens: 0 });
});

test("Context tab: presets, custom validation, save round-trip and reload", async ({ page, request }) => {
  await setCompactSettings(request, { auto: 0, tokens: 0 });
  await page.goto(BASE + "/");
  await openContextTab(page);

  await expect(page.locator(COMPACT_TOGGLE)).toHaveAttribute("data-state", "off");
  await expect(page.locator(COMPACT_STATUS)).toHaveText("Off");

  // No phantom validator error on a fresh/cleared state: the custom input is
  // empty (not "0"), so Save is clickable and hovers as a normal button.
  await expect(page.locator(COMPACT_CUSTOM)).toHaveValue("");
  await expect(page.locator('[data-testid="compact-custom-error"]')).toHaveCount(0);
  await expect(page.locator(COMPACT_SAVE)).toBeEnabled();

  // Toggle-on with no threshold arms the default preset instead of writing a
  // dead "On · 0k" state the send gate would ignore.
  await page.locator(COMPACT_TOGGLE).click();
  await expect(page.locator(COMPACT_STATUS)).toHaveText("On · 32k");
  await expect(page.locator(COMPACT_CUSTOM)).toHaveValue("32000");
  await page.locator(COMPACT_TOGGLE).click();
  await expect(page.locator(COMPACT_STATUS)).toHaveText("Off");

  // Preset click arms auto-compact, syncs the custom input (no stale "0"
  // blocking Save), and the preset-only save persists across a reopen.
  // (No settle wait:
  // the menu-open settings fetch must not clobber a just-clicked preset — the
  // dirty-guard in SettingsMenu keeps the user's choice even when the fetch
  // resolves after the click on a cold dev server.)
  await page.locator(COMPACT_PRESET("32k")).click();
  await expect(page.locator(COMPACT_PRESET("32k"))).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(COMPACT_STATUS)).toHaveText("On · 32k");
  await expect(page.locator(COMPACT_CUSTOM)).toHaveValue("32000");
  await expect(page.locator(COMPACT_SAVE)).toBeEnabled();

  // Preset-only save (no custom input typed) must actually hit the server —
  // the original bug: a stale out-of-range input silently blocked Save, so
  // the choice reset to Off on the next open.
  await page.locator(COMPACT_SAVE).click();
  const gotPreset = await (await request.get(`${BASE}/api/settings`)).json();
  expect(gotPreset.settings?.compact_thresholds).toEqual({ auto: 1, tokens: 32000 });

  // Out-of-range custom value: inline error + Save disabled (8,000–1,000,000).
  await page.locator(COMPACT_CUSTOM).fill("5000");
  await expect(page.locator('[data-testid="compact-custom-error"]')).toBeVisible();
  await expect(page.locator(COMPACT_SAVE)).toBeDisabled();

  // In-range custom value: error clears, Save re-arms and wins.
  await page.locator(COMPACT_CUSTOM).fill("12000");
  await page.locator(COMPACT_CUSTOM).press("Enter");
  await expect(page.locator('[data-testid="compact-custom-error"]')).toHaveCount(0);
  await expect(page.locator(COMPACT_SAVE)).toBeEnabled();
  await expect(page.locator(COMPACT_STATUS)).toHaveText("On · 12k");

  await page.locator(COMPACT_SAVE).click();
  await expect(page.locator(COMPACT_STATUS)).toHaveText("On · 12k");

  // settings.json round-trip.
  const got = await (await request.get(`${BASE}/api/settings`)).json();
  expect(got.settings?.compact_thresholds).toEqual({ auto: 1, tokens: 12000 });

  // Reload: the choice comes back from disk, not from component state.
  await page.reload();
  await openContextTab(page);
  await expect(page.locator(COMPACT_TOGGLE)).toHaveAttribute("data-state", "on");
  await expect(page.locator(COMPACT_CUSTOM)).toHaveValue("12000");
});

test("manual /compact: folds history, badges the divider, sends no user bubble", async ({ page, request }) => {
  await setCompactSettings(request, { auto: 0, tokens: 0 }); // gate OFF: only the command compacts
  const id = "cc-manual-" + Date.now();
  await seedConversation(request, id, 3); // 6 messages: 2 folded + 4 raw tail

  const up = await startCompactUpstream();
  await page.route("**/api/chat", (route) => void route.continue({ url: `http://127.0.0.1:${up.port}/chat` }));
  try {
    await page.goto(BASE + "/");
    await openSeed(page, id);

    await sendFromBar(page, "/compact");

    const divider = page.locator(DIVIDER);
    await expect(divider).toBeVisible({ timeout: 15_000 });
    await expect(divider).toHaveAttribute("data-state", "done");
    await expect(divider).toContainText(/Context compacted \(.* -> .* tokens\)/);

    const hits = await readHits(request, up.port);
    expect(hits.compactions).toBe(1);
    expect(hits.normal).toBe(0); // the command never reaches the model as a chat turn

    // No "/compact" user bubble in the chat.
    await expect(page.getByText("/compact", { exact: true })).toHaveCount(0);

    // The full original history survives in the UI: the oldest seeded message
    // is still rendered (the replacement touched only the model-facing array).
    await expect(page.getByText(/^Q0 filler0/).first()).toBeVisible();
  } finally {
    up.close();
    await request.delete(`${BASE}/api/conversations/${id}`);
  }
});

test("auto gate: compacts once past the threshold, ships the replacement, never re-compacts", async ({ page, request }) => {
  // 8k threshold; the seeded chat sits at ~8.2k estimated tokens.
  await setCompactSettings(request, { auto: 1, tokens: 8000 });
  const id = "cc-auto-" + Date.now();
  // 5 turns × ~3,300 chars = ~8.2k tokens; oldest 3 turns carry OLD_MARKER
  // (they will be the folded half — RECENT_TAIL keeps the last 4 messages).
  await seedConversation(request, id, 5, { chars: 3300, markerTurns: 3 });

  const up = await startCompactUpstream();
  await page.route("**/api/chat", (route) => void route.continue({ url: `http://127.0.0.1:${up.port}/chat` }));
  try {
    await page.goto(BASE + "/");
    await openSeed(page, id);

    await sendFromBar(page, "what did we decide about the seed topic?");

    // Divider badge appears BEFORE the new turn resolves...
    const divider = page.locator(DIVIDER);
    await expect(divider).toBeVisible({ timeout: 15_000 });
    await expect(divider).toContainText(/Context compacted \(.* -> .* tokens\)/);

    // ...and the reply streams normally afterwards.
    await expect(page.locator(`${ASSISTANT}[data-state="complete"]`).last())
      .toContainText(NORMAL_REPLY, { timeout: 15_000 });

    const hits = await readHits(request, up.port);
    expect(hits.compactions).toBe(1);
    expect(hits.normal).toBe(1);

    // The turn the model actually received: [compacted block, ...4 tail, new
    // user] — small, block-bearing, and WITHOUT the folded-away old turns.
    expect(hits.lastNormalCount).toBe(6);
    expect(hits.lastNormalHadBlock).toBe(true);
    expect(hits.lastNormalHadOldMarker).toBe(false);

    // Second send past a compacted history: the rebuild must NOT undo the
    // compaction (no mirror-to-full-UI regression) → no second compaction.
    await sendFromBar(page, "thanks — anything else to add?");
    await expect(page.locator(`${ASSISTANT}[data-state="complete"]`).last())
      .toContainText(NORMAL_REPLY, { timeout: 15_000 });

    const hits2 = await readHits(request, up.port);
    expect(hits2.normal).toBe(2);
    expect(hits2.compactions).toBe(1); // exactly ONE compaction for the whole session
    expect(hits2.lastNormalHadOldMarker).toBe(false);

    // The UI keeps the FULL original conversation — scrollable history.
    await expect(page.getByText(/^Q0 filler0/).first()).toBeVisible();
  } finally {
    up.close();
    await request.delete(`${BASE}/api/conversations/${id}`);
  }
});

/* ── REAL-ROUTE tests (no interception; real shared inference backend) ─── */

test("route contract: purpose=compact skips the decision pipeline; a plain turn does not", async ({ request }) => {
  test.setTimeout(240_000);
  const tiny = (purpose?: string) => ({
    model: "",
    stream: true,
    max_tokens: 32,
    ...(purpose ? { purpose } : {}),
    messages: [
      { role: "system", content: "Reply with exactly one short word." },
      { role: "user", content: "ping" },
    ],
  });

  // Compaction passthrough: the route must forward WITHOUT the early-open
  // progress stream — zero ruke_stage frames means no router, no skill
  // injection, no web gate touched the payload.
  const compactRes = await request.post(`${BASE}/api/chat`, { data: tiny("compact") });
  expect(compactRes.status()).toBe(200);
  const compactSse = await compactRes.text();
  expect(compactSse).toContain("data:");
  expect(compactSse).not.toContain("ruke_stage");

  // Contrast: the IDENTICAL payload without the marker goes through the full
  // per-turn pipeline, which always opens early with progress frames. If
  // this assertion ever sees no frames, the route's progress contract moved
  // and the bypass assertion above stopped proving anything — re-check both.
  const normalRes = await request.post(`${BASE}/api/chat`, { data: tiny() });
  expect(normalRes.status()).toBe(200);
  const normalSse = await normalRes.text();
  expect(normalSse).toContain("ruke_stage");
});

test("manual /compact end-to-end through the REAL chat route (no interception)", async ({ page, request }) => {
  test.setTimeout(420_000);
  await setCompactSettings(request, { auto: 0, tokens: 0 }); // only the command compacts
  const id = "cc-real-" + Date.now();
  await seedConversation(request, id, 3); // 6 SHORT messages: 2 folded + 4 tail

  try {
    await page.goto(BASE + "/");
    await openSeed(page, id);

    await sendFromBar(page, "/compact");

    const divider = page.locator(DIVIDER);
    // badgeAt now publishes WITH isCompacting, so the in-flight spinner must
    // actually mount (it was invisible while the real call ran for minutes).
    await expect(divider).toBeVisible({ timeout: 10_000 });

    // Settle against the REAL model (small history: seconds, not minutes).
    await expect
      .poll(async () => divider.getAttribute("data-state"), {
        timeout: 360_000,
        message: "real-model compaction never settled into a terminal state",
      })
      .toMatch(/^(done|failed|noop)$/);

    // The whole point of the purpose=compact bypass: the compaction system
    // prompt reaches the model verbatim, so it honors the block contract.
    // A "failed" state here would mean the real route STILL corrupts the
    // payload — exactly the reported bug — and the failure is now at least
    // visible instead of silent.
    await expect(divider).toHaveAttribute("data-state", "done");
    await expect(divider).toContainText(/Context compacted \(.* -> .* tokens\)/);

    // The full original conversation survives in the UI.
    await expect(page.getByText(/^Q0 filler0/).first()).toBeVisible();

    // And the compacted history actually works: a follow-up turn replies.
    await sendFromBar(page, "Reply with just: OK");
    await expect(page.locator(`${ASSISTANT}[data-state="complete"]`).last())
      .toBeVisible({ timeout: 240_000 });
  } finally {
    await request.delete(`${BASE}/api/conversations/${id}`);
  }
});
