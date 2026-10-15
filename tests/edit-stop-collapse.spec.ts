import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Regression e2e for the mid-generation edit/stop flow and the collapsible
 * user bubble. Drives the real UI against a paced SSE upstream (no model).
 *
 * Requires the dev server on http://localhost:3000 (npm run dev).
 */

const STREAMING = '[data-testid="assistant-message"][data-state="streaming"]';
const DONE = '[data-testid="assistant-message"][data-state="complete"]';
const ASSISTANT = '[data-testid="assistant-message"]';
const USER_BUBBLE = '[data-testid="user-message-bubble"]';
const STOP_BTN = '[aria-label="Stop generating"]';

/**
 * Paced SSE upstream: each successive POST /api/chat streams the next entry
 * of `contents` one frame every `frameMs`, so mid-generation state stays
 * observable for seconds (route.fulfill would deliver everything at once).
 * Connections are tracked so tests can prove an aborted stream closed.
 */
function startPacedUpstream(contents: string[], frameMs = 25, chunkSize = 30) {
  const connections: { closed: boolean }[] = [];
  let requestIndex = 0;
  const server = http.createServer((req, res) => {
    const conn = { closed: false };
    connections.push(conn);
    req.on("close", () => { conn.closed = true; });

    const content = contents[Math.min(requestIndex++, contents.length - 1)];
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const frames: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + chunkSize) } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    let fi = 0;
    const pump = setInterval(() => {
      if (fi >= frames.length) { clearInterval(pump); res.end(); return; }
      res.write(frames[fi++]);
    }, frameMs);
    req.on("close", () => clearInterval(pump));
  });
  return new Promise<{ port: number; connections: { closed: boolean }[]; close: () => void }>(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: (server.address() as AddressInfo).port,
      connections,
      close: () => server.close(),
    }));
  });
}

async function routeTo(page: Page, port: number) {
  await page.route("**/api/chat", route => void route.continue({ url: `http://127.0.0.1:${port}/chat` }));
}

/** Instant one-shot SSE reply (no pacing needed for the collapse tests). */
async function routeInstantReply(page: Page, content: string) {
  await page.route("**/api/chat", route => route.fulfill({
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
  }));
}

async function sendFromHero(page: Page, text: string) {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

test("stop button halts generation mid-stream and finalizes the partial reply", async ({ page }) => {
  const upstream = await startPacedUpstream(["FILLER_SEGMENT ".repeat(400)]); // ~5 s of stream
  await routeTo(page, upstream.port);
  await page.goto("http://localhost:3000/");
  await sendFromHero(page, "write me a very long essay");

  // Wait until tokens are actually flowing, then hit stop.
  await expect(page.locator(STREAMING)).toContainText("FILLER", { timeout: 10_000 });
  await page.locator(STOP_BTN).click();

  // The partial bubble is finalized — never left "streaming" forever.
  await expect(page.locator(DONE)).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(STREAMING)).toHaveCount(0);

  // No further tokens arrive after the stop.
  const len1 = await page.locator(DONE).first().evaluate(el => (el.textContent ?? "").length);
  expect(len1).toBeGreaterThan(0); // stopped mid-stream, not before it began
  await page.waitForTimeout(800);
  const len2 = await page.locator(DONE).first().evaluate(el => (el.textContent ?? "").length);
  expect(len2).toBe(len1);

  // Composer controls flip back to send.
  await expect(page.locator(STOP_BTN)).toHaveCount(0);
  await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
  upstream.close();
});

test("composer stays editable while a reply is generating", async ({ page }) => {
  const upstream = await startPacedUpstream(["FILLER_SEGMENT ".repeat(400)]);
  await routeTo(page, upstream.port);
  await page.goto("http://localhost:3000/");
  await sendFromHero(page, "first question");

  await expect(page.locator(STREAMING)).toBeVisible({ timeout: 10_000 });
  const composer = page.locator("textarea").last();
  await expect(composer).toBeEnabled();
  await composer.click();
  await composer.fill("drafting the next message while it writes");
  await expect(composer).toHaveValue("drafting the next message while it writes");

  // Enter mid-generation must not fire a second send.
  await composer.press("Enter");
  await expect(page.locator(USER_BUBBLE)).toHaveCount(1);

  await page.locator(STOP_BTN).click();
  await expect(page.locator(DONE)).toBeVisible({ timeout: 5_000 });
  upstream.close();
});

test("editing the user message mid-stream aborts the old reply and regenerates — no redirect to the empty home", async ({ page }) => {
  const upstream = await startPacedUpstream(["FIRST_REPLY ".repeat(300), "SECOND_REPLY done"]);
  await routeTo(page, upstream.port);
  await page.goto("http://localhost:3000/");
  await sendFromHero(page, "original question");

  await expect(page.locator(STREAMING)).toContainText("FIRST_REPLY", { timeout: 10_000 });

  await page.locator(USER_BUBBLE).hover();
  await page.locator('[aria-label="Edit message"]').click();
  const modalBox = page.getByPlaceholder("Edit message…");
  await expect(modalBox).toBeVisible();
  await modalBox.fill("edited question");
  await page.getByRole("button", { name: "Save & regenerate" }).click();

  // The chat view survives — no flip back to the "Local Intelligence" hero.
  await expect(page.getByText("Local Intelligence")).toHaveCount(0);
  await expect(page.locator(USER_BUBBLE)).toHaveCount(1);
  await expect(page.locator(USER_BUBBLE)).toHaveText("edited question");

  // The old stream's connection was really closed, and its content is gone.
  await expect.poll(() => upstream.connections[0].closed, { timeout: 5_000 }).toBe(true);
  await expect(page.locator(DONE)).toBeVisible({ timeout: 15_000 });
  const replies = (await page.locator(ASSISTANT).allTextContents()).join(" ");
  expect(replies).toContain("SECOND_REPLY");
  expect(replies).not.toContain("FIRST_REPLY");
  await expect(page.locator(ASSISTANT)).toHaveCount(1);
  upstream.close();
});

test("a long pasted user message collapses to a few lines and expands on demand", async ({ page }) => {
  await routeInstantReply(page, "short reply");
  await page.goto("http://localhost:3000/");

  const longText = Array.from(
    { length: 40 },
    (_, i) => `Line ${i + 1} of the pasted wall of text for the prompt.`,
  ).join("\n");
  await sendFromHero(page, longText);

  const bubble = page.locator(USER_BUBBLE);
  const toggle = page.locator('[data-testid="user-msg-toggle"]');

  // Collapsed the instant it is sent — no re-read wall of text.
  await expect(toggle).toHaveText(/Show more/);
  const collapsed = await bubble.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(collapsed.scroll).toBeGreaterThan(collapsed.client * 2);
  const collapsedBox = await bubble.boundingBox();
  expect(collapsedBox!.height).toBeLessThan(200);

  // Expand: full text visible, nothing clamped.
  await toggle.click();
  await expect(toggle).toHaveText(/Show less/);
  const expanded = await bubble.evaluate(el => ({
    client: el.clientHeight, scroll: el.scrollHeight, tail: (el.textContent ?? "").slice(-7),
  }));
  expect(expanded.scroll).toBeLessThanOrEqual(expanded.client + 2);
  expect(expanded.tail).toBe("prompt.");

  // Collapse again.
  await toggle.click();
  await expect(toggle).toHaveText(/Show more/);
  const reclamped = await bubble.evaluate(el => el.scrollHeight > el.clientHeight * 2);
  expect(reclamped).toBe(true);
});

test("short user messages get no collapse toggle", async ({ page }) => {
  await routeInstantReply(page, "short reply");
  await page.goto("http://localhost:3000/");
  await sendFromHero(page, "hello there, quick question");
  await expect(page.locator(USER_BUBBLE)).toHaveText("hello there, quick question");
  await expect(page.locator('[data-testid="user-msg-toggle"]')).toHaveCount(0);
});
