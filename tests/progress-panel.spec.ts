import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Progress chip + panel (Claude-desktop style, white variant) driven by real
 * `ruke_stage` SSE frames — model-free. A paced local upstream streams the
 * exact frame envelope app/api/chat/route.ts emits (stage frames before the
 * first byte, then content deltas, then [DONE]), so mid-turn progress stays
 * observable for seconds (route.fulfill would deliver everything at once).
 *
 * Requires the dev server on http://localhost:3000 (npm run dev).
 */

const CHIP = '[data-testid="progress-chip"]';
const PANEL = '[data-testid="progress-panel"]';
const DONE = '[data-testid="assistant-message"][data-state="complete"]';

const PPTX_BODY =
  '{"filename":"q3.pptx","title":"Q3 Review","tier":"simple","slides":[' +
  '{"layout":"title","title":"Q3 Review","subtitle":"Progress panel e2e"},' +
  '{"layout":"bullets","title":"Wins","bullets":["Shipping","Testing"]}]}';
const REPLY = `Here is the quarterly deck.\n\n\`\`\`pptx\n${PPTX_BODY}\n\`\`\`\nDone.`;

interface StageFrame {
  json: object;
  /** ms to wait BEFORE writing this frame (lets intermediate states be observed). */
  delay: number;
}

/**
 * Paced SSE upstream: ruke_stage frames with real counters, then REPLY in
 * small content deltas, then [DONE]. x-decision-mode is set so the UI mounts
 * the ppt renderer (zero-collision rule) and useChat learns the mode.
 */
function startProgressUpstream(overrides: Partial<{ readingDelay: number }> = {}) {
  const readingDelay = overrides.readingDelay ?? 450;
  const stageFrames: StageFrame[] = [
    { json: { ruke_stage: { stage: "decision_done", mode: "ppt", ms: 421 } }, delay: 150 },
    { json: { ruke_stage: { stage: "web:gate" } }, delay: 300 },
    { json: { ruke_stage: { stage: "web:searching", total: 2 } }, delay: 450 },
    { json: { ruke_stage: { stage: "web:reading", total: 3 } }, delay: 450 },
    { json: { ruke_stage: { stage: "web:reading", done: 1, total: 3 } }, delay: readingDelay },
    { json: { ruke_stage: { stage: "web:reading", done: 2, total: 3 } }, delay: readingDelay },
    { json: { ruke_stage: { stage: "web:reading", done: 3, total: 3 } }, delay: readingDelay },
    { json: { ruke_stage: { stage: "web:reranking" } }, delay: 450 },
    { json: { ruke_stage: { stage: "web:done", total: 12 } }, delay: 450 },
    { json: { ruke_stage: { stage: "web_meta", webCitations: {} } }, delay: 200 },
  ];

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-decision-mode": "ppt",
    });

    const timers: NodeJS.Timeout[] = [];
    let wait = 0;
    let fi = 0;
    const writeFrames: string[] = [];
    for (let i = 0; i < REPLY.length; i += 28) {
      writeFrames.push(
        `data: ${JSON.stringify({ choices: [{ delta: { content: REPLY.slice(i, i + 28) } }] })}\n\n`,
      );
    }
    writeFrames.push("data: [DONE]\n\n");

    for (const f of stageFrames) {
      wait += f.delay;
      timers.push(setTimeout(() => res.write(`data: ${JSON.stringify(f.json)}\n\n`), wait));
    }
    // Content: ~30 ms per frame once the stage phase is over (~3.7 s in).
    wait += 300;
    for (const frame of writeFrames) {
      wait += 30;
      timers.push(setTimeout(() => res.write(frame), wait));
    }
    timers.push(setTimeout(() => res.end(), wait + 50));
    req.on("close", () => timers.forEach(clearTimeout));
  });

  return new Promise<{ port: number; close: () => void }>(resolve => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => server.close(),
      }),
    );
  });
}

async function openWithMock(page: Page, port: number): Promise<void> {
  await page.route("**/api/chat", route => void route.continue({ url: `http://127.0.0.1:${port}/chat` }));
  await page.goto("http://localhost:3000/");
}

async function sendFromHero(page: Page, text: string): Promise<void> {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

/** The panel opens only on chip click (no auto-open — the popup must never
 *  cover chat controls unsolicited). Waits for the chip and opens the panel. */
async function openPanel(page: Page): Promise<void> {
  const chip = page.locator(CHIP);
  await expect(chip).toBeVisible({ timeout: 3_000 });
  await chip.click();
}

/** Overall percent: the FIRST tabular-nums in the panel (the bar row precedes the timeline). */
async function panelPercent(page: Page): Promise<number> {
  const txt = await page.locator(`${PANEL} span.tabular-nums`).first().textContent();
  return parseInt(txt?.replace("%", "") ?? "0", 10);
}

test("chip mounts with white treatment and Step counter; chip click opens the panel", async ({ page }) => {
  const up = await startProgressUpstream();
  await openWithMock(page, up.port);
  try {
    await sendFromHero(page, "make me a quarterly review deck");
    const chip = page.locator(CHIP);
    await expect(chip).toBeVisible({ timeout: 3_000 });
    await expect(chip).toContainText(/^Step \d+ of \d+$/);

    // White deviation (explicit user requirement): white border, white text — no blue.
    const styles = await chip.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderTopColor, color: cs.color };
    });
    expect(styles.border).toBe("rgba(255, 255, 255, 0.55)");
    expect(styles.color).toBe("rgb(255, 255, 255)");

    // Clicking the chip opens the panel (it must never cover chat controls on its own).
    await openPanel(page);
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Progress", { exact: true })).toBeVisible();

    // Honest running state: between 1 and 99 — never a fake 100.
    const pct = await panelPercent(page);
    expect(pct).toBeGreaterThanOrEqual(1);
    expect(pct).toBeLessThanOrEqual(99);
  } finally {
    up.close();
  }
});

test("step labels advance in real time as stage events arrive", async ({ page }) => {
  const up = await startProgressUpstream({ readingDelay: 700 });
  await openWithMock(page, up.port);
  try {
    await sendFromHero(page, "make me a quarterly review deck");
    await openPanel(page);
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();

    // Real query-pool count from the searching stage event.
    await expect(panel).toContainText("Searching the web — 2 query pool(s)", { timeout: 5_000 });
    // Real per-page counts subdivide the reading band.
    await expect(panel).toContainText("Reading web sources — page 1 of 3", { timeout: 5_000 });
    // Mid-reading the turn is genuinely on its 2nd known step.
    await expect(page.locator(CHIP)).toContainText("Step 2 of 2");
    // Mode-labeled writing step appears on first content…
    await expect(panel).toContainText("Building your presentation (PPTX)…", { timeout: 15_000 });
    // …and by the end the chip has advanced to 3 steps or finished.
    await expect(page.locator(CHIP)).toContainText(/Step 3 of 3|Done/);
  } finally {
    up.close();
  }
});

test("overall percent is monotonic and honest while the turn runs", async ({ page }) => {
  const up = await startProgressUpstream();
  await openWithMock(page, up.port);
  try {
    await sendFromHero(page, "make me a quarterly review deck");
    await openPanel(page);
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();

    // Sample only while the turn is still running (chip still shows a Step counter).
    const samples: number[] = [];
    const deadline = Date.now() + 9_000;
    while (Date.now() < deadline) {
      const chipTxt = await page.locator(CHIP).textContent();
      if (!chipTxt?.includes("Step")) break;
      samples.push(await panelPercent(page));
      await page.waitForTimeout(250);
    }
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i], `progress walked backwards: ${samples.join(" → ")}`).toBeGreaterThanOrEqual(samples[i - 1]);
    }
    expect(samples[samples.length - 1]).toBeGreaterThan(samples[0]); // actually advances
    expect(Math.max(...samples)).toBeLessThanOrEqual(99); // never claims done while running
  } finally {
    up.close();
  }
});

test("finished turn: chip 'Done', 100%, and a real Presentation/PPTX output row", async ({ page }) => {
  const up = await startProgressUpstream();
  await openWithMock(page, up.port);
  try {
    await sendFromHero(page, "make me a quarterly review deck");
    await page.locator(DONE).waitFor({ timeout: 25_000 });

    await expect(page.locator(CHIP)).toContainText("Done", { timeout: 3_000 });
    await openPanel(page);
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible(); // reviewable after the turn ends
    await expect(panel).toContainText("100%");
    await expect(panel.getByText("Outputs", { exact: true })).toBeVisible();
    await expect(panel).toContainText("Presentation");
    await expect(panel).toContainText("PPTX");
    // Every timeline step is dim/complete now — no live % counter remains.
    await expect(panel.locator("span.tabular-nums")).toHaveCount(1); // only the overall 100%
  } finally {
    up.close();
  }
});

test("closing the panel mid-turn keeps the chip; clicking the chip reopens it", async ({ page }) => {
  const up = await startProgressUpstream({ readingDelay: 900 });
  await openWithMock(page, up.port);
  try {
    await sendFromHero(page, "make me a quarterly review deck");
    const chip = page.locator(CHIP);
    await openPanel(page);
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();

    await panel.getByRole("button", { name: "Close progress" }).click();
    await expect(panel).toBeHidden({ timeout: 2_000 });
    await expect(chip).toBeVisible(); // turn still running: chip persists

    await chip.click();
    await expect(panel).toBeVisible({ timeout: 2_000 });
    await expect(chip).toHaveAttribute("aria-expanded", "true");
  } finally {
    up.close();
  }
});

test("X after completion dismisses the whole progress chip", async ({ page }) => {
  const up = await startProgressUpstream();
  await openWithMock(page, up.port);
  try {
    await sendFromHero(page, "make me a quarterly review deck");
    await page.locator(DONE).waitFor({ timeout: 25_000 });
    await expect(page.locator(CHIP)).toContainText("Done");

    await openPanel(page);
    await page.locator(PANEL).getByRole("button", { name: "Close progress" }).click();
    await expect(page.locator(PANEL)).toBeHidden({ timeout: 2_000 });
    await expect(page.locator(CHIP)).toBeHidden({ timeout: 2_000 });
  } finally {
    up.close();
  }
});
