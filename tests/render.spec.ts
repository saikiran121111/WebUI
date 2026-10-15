import { test, expect, type Page } from "@playwright/test";

/**
 * Rendering e2e: drives the real chat UI against a mocked SSE upstream so no
 * model is required. Verifies the release-blocking paths: colored code,
 * character-for-character copy fidelity, tables, diagrams, charts, widgets,
 * and streaming safety.
 *
 * Requires the dev server on http://localhost:3000 (npm run dev).
 */

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const ASSISTANT_DONE = '[data-testid="assistant-message"][data-state="complete"]';

/** Respond to every POST /api/chat with `content` streamed in small SSE frames. */
async function mockStream(page: Page, content: string, chunkSize = 14): Promise<void> {
  await page.route("**/api/chat", async (route) => {
    const frames: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: frames.join(""),
    });
  });
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout: 15_000 });
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test("python fence renders colored tokens and copy is character-for-character exact", async ({ page }) => {
  const source = "def greet():\n\tprint('café 🚀')   # tab-indented, unicode";
  await mockStream(page, "```python\n" + source + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "show me python");

  const block = page.locator('[data-testid="code-block"]');
  await expect(block).toBeVisible();
  await expect(block).toHaveAttribute("data-lang", "Python");

  // Real grammar tokens must be colored, not inherited white. Highlighting
  // is async by design (grammar chunk loads on demand), so wait for the
  // first colored token before counting.
  await expect(block.locator(".shiki span[style]").first()).toBeVisible({ timeout: 10_000 });
  const tokenSpans = block.locator(".shiki span[style]");
  expect(await tokenSpans.count()).toBeGreaterThan(3);

  // Release-blocking copy fidelity: paste must equal the source exactly.
  // The Windows system clipboard normalizes LF to CRLF at the OS layer
  // (the app writes the exact string via the Clipboard API), so compare
  // after line-ending normalization — tabs, spaces, unicode and emoji must
  // still match character-for-character.
  await page.locator('[data-testid="code-copy-btn"]').click();
  await expect(block.getByText("Copied")).toBeVisible();
  expect((await readClipboard(page)).replace(/\r\n/g, "\n")).toBe(source);
});

test("markdown table supports header sorting and CSV copy", async ({ page }) => {
  const rows = [
    ["Ada", "90"], ["Grace", "10"], ["Linus", "50"],
    ["Ken", "30"], ["Barbara", "70"], ["Alan", "20"],
  ];
  const table = ["| Name | Score |", "| --- | --- |"]
    .concat(rows.map(([n, s]) => `| ${n} | ${s} |`))
    .join("\n");
  await mockStream(page, table);
  await page.goto("http://localhost:3000/");
  await send(page, "table please");

  const wrap = page.locator('[data-testid="md-table-wrap"]');
  await expect(wrap).toBeVisible();

  // Sorting activates only after hover measures the row count.
  await wrap.hover();
  await wrap.locator("th").nth(1).click();
  await expect(wrap.locator("tbody tr").first().locator("td").nth(1)).toHaveText("10");
  await wrap.locator("th").nth(1).click();
  await expect(wrap.locator("tbody tr").first().locator("td").nth(1)).toHaveText("90");

  await page.locator('[data-testid="table-csv-btn"]').click();
  const csv = await readClipboard(page);
  expect(csv).toContain("Name,Score");
  expect(csv).toContain("Barbara,70");
});

test("valid mermaid renders an interactive diagram stage", async ({ page }) => {
  const diagram = "graph TD\n  A[Start] --> B{Check}\n  B -->|yes| C[Done]\n  B -->|no| A";
  await mockStream(page, "```mermaid\n" + diagram + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "diagram this");

  const stage = page.locator('[data-testid="diagram-stage"]');
  await expect(stage).toBeVisible({ timeout: 15_000 });
  await expect(stage.locator("svg")).toBeVisible();

  // Keyboard pan must not throw and keeps focus on the stage.
  await stage.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("0");
  await expect(stage.locator("svg")).toBeVisible();
});

test("invalid mermaid falls back to preserved source without crashing", async ({ page }) => {
  const broken = "```mermaid\nthis is %%% not a valid diagram (((\n```";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await mockStream(page, broken);
  await page.goto("http://localhost:3000/");
  await send(page, "bad diagram");

  await expect(page.locator('[data-testid="mermaid-error"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="code-block"]')).toContainText("not a valid diagram");
  expect(errors).toEqual([]);
});

test("chart fence renders an svg chart with a data table toggle", async ({ page }) => {
  const spec = JSON.stringify({
    type: "bar",
    title: "Rainfall",
    unit: "mm",
    categories: ["Jan", "Feb", "Mar"],
    series: [{ name: "2025", data: [10, 20, 30] }],
  });
  await mockStream(page, "```chart\n" + spec + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "chart this");

  await expect(page.locator(".chart-svg")).toBeVisible();
  await expect(page.locator(".chart-legend")).toContainText("2025");

  // Underlying values must be viewable (data traceability).
  await page.locator(".chart-block button[aria-pressed]").first().click();
  await expect(page.locator(".chart-data-table")).toContainText("30");
});

test("invalid chart fence shows a readable fallback, never invented data", async ({ page }) => {
  await mockStream(page, "```chart\n{ not valid json\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "bad chart");
  await expect(page.locator('[data-testid="chart-error"]')).toBeVisible();
  await expect(page.locator('[data-testid="code-block"]')).toContainText("not valid json");
});

test("widget form validates and sends only the submitted values", async ({ page }) => {
  const spec = JSON.stringify({
    kind: "form",
    title: "Booking",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "guests", label: "Guests", type: "number", min: 1, max: 10 },
    ],
    submitLabel: "Book",
  });
  await mockStream(page, "```widget\n" + spec + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "booking form");

  const nameInput = page.locator("#widget-field-name");
  await expect(nameInput).toBeVisible();

  // Empty required field must block submission with visible feedback.
  await page.locator(".widget-submit").click();
  await expect(page.locator(".widget-field-error").first()).toBeVisible();

  await nameInput.fill("Ada");
  await page.locator("#widget-field-guests").fill("3");
  await page.locator(".widget-submit").click();

  // The follow-up user message carries exactly the validated input, and the
  // mocked upstream answers it (second assistant message = round-trip proof).
  await expect(page.locator("body")).toContainText("Name: Ada");
  await expect(page.locator("body")).toContainText("Guests: 3");
  await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(2);
});

test("streaming a partial fence never crashes and settles into a highlighted block", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const full = "Here:\n\n```js\nconst x = [1, 2, 3];\nconsole.log(x);\n```\n\nDone.";
  await mockStream(page, full, 5); // tiny chunks split fences mid-token
  await page.goto("http://localhost:3000/");

  const box = page.locator("textarea").first();
  await box.click();
  await box.fill("stream code");
  await box.press("Enter");

  // No crash while fences are incomplete.
  await page.waitForTimeout(600);
  expect(errors).toEqual([]);

  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout: 15_000 });
  const block = page.locator('[data-testid="code-block"]');
  await expect(block).toHaveAttribute("data-lang", "JavaScript");
  await expect(block.locator(".shiki span[style]").first()).toBeVisible();
});
