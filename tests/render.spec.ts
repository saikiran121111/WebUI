import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

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

test("markdown table collapses wide columns, filters rows and opens fullscreen", async ({ page }) => {
  const rows = [
    ["Ada", "C", "90", "12", "MIT", "first programmer"],
    ["Grace", "COBOL", "10", "8", "Apache", "compiler pioneer"],
    ["Linus", "C", "50", "20", "GPL", "kernel maintainer"],
    ["Ken", "Go", "30", "15", "BSD", "unix co-author"],
    ["Barbara", "Smalltalk", "70", "5", "MIT", "oop researcher"],
    ["Alan", "Prolog", "20", "3", "MIT", "computability"],
  ];
  const table = ["| Name | Lang | Score | Stars | License | Notes |", "| --- | --- | --- | --- | --- | --- |"]
    .concat(rows.map(r => `| ${r.join(" | ")} |`))
    .join("\n");
  await mockStream(page, table);
  await page.goto("http://localhost:3000/");
  await send(page, "wide table please");

  const wrap = page.locator('[data-testid="md-table-wrap"]');
  await wrap.hover();

  // Wide table (6 cols): columns past the 4th collapse behind an expand toggle.
  await expect(wrap.locator('[data-testid="table-cols-btn"]')).toBeVisible();
  await expect(wrap.locator("tbody tr").first().locator("td").nth(5)).toBeHidden();
  await wrap.locator('[data-testid="table-cols-btn"]').click();
  await expect(wrap.locator("tbody tr").first().locator("td").nth(5)).toBeVisible();

  // Per-column filter row hides non-matching rows and reports the count.
  await wrap.locator('[data-testid="table-filter-btn"]').click();
  await expect(wrap.locator(".md-filter-row input")).toHaveCount(6);
  await wrap.locator(".md-filter-row input").nth(1).fill("cobol");
  await expect(wrap.locator("tbody tr:visible")).toHaveCount(1);
  await expect(wrap.locator('[data-testid="table-row-count"]')).toHaveText("1 of 6 rows");
  await wrap.locator('[data-testid="table-filter-btn"]').click();
  await expect(wrap.locator("tbody tr:visible")).toHaveCount(6);

  // Fullscreen overlay: fixed inset-0, Escape closes it.
  await wrap.locator('[data-testid="table-fullscreen-btn"]').click();
  await expect(wrap).toHaveClass(/is-fullscreen/);
  await expect(wrap.locator("table.md-table")).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(wrap).not.toHaveClass(/is-fullscreen/);
});

test("dragging one column must not reflow other columns or row heights", async ({ page }) => {
  const rows = [
    ["Ada", "C", "90", "12", "MIT", "first programmer of all, wrote the analytic engine notes in the 1840s"],
    ["Grace", "COBOL", "10", "8", "Apache", "pioneered compilers and taught the navy to program in English"],
    ["Linus", "C", "50", "20", "GPL", "maintains the largest collaborative software project ever attempted"],
    ["Ken", "Go", "30", "15", "BSD", "co-created Unix and Plan 9, later designed the Go language"],
    ["Barbara", "Smalltalk", "70", "5", "MIT", "invented OOP at Xerox PARC with the Dynabago vision"],
    ["Alan", "Prolog", "20", "3", "MIT", "formalized computability and later worked on morphology"],
  ];
  const table = ["| Name | Lang | Score | Stars | License | Notes |", "| --- | --- | --- | --- | --- | --- |"]
    .concat(rows.map(r => `| ${r.join(" | ")} |`))
    .join("\n");
  await mockStream(page, table);
  await page.goto("http://localhost:3000/");
  await send(page, "wide table please");

  const wrap = page.locator('[data-testid="md-table-wrap"]');
  await wrap.hover();
  await wrap.locator('[data-testid="table-cols-btn"]').click(); // expand so long Notes text is visible

  const geometry = () => wrap.evaluate((el) => {
    const ths = Array.from(el.querySelectorAll("thead tr:not(.md-filter-row) th"))
      .map(th => Math.round((th as HTMLElement).getBoundingClientRect().width));
    const trs = Array.from(el.querySelectorAll("tbody tr"))
      .map(tr => Math.round((tr as HTMLElement).getBoundingClientRect().height));
    const tableW = Math.round((el.querySelector("table") as HTMLElement).getBoundingClientRect().width);
    return { ths, trs, tableW };
  });

  const before = await geometry();
  const handleBox = await wrap.locator("thead th").nth(0).locator(".md-col-resize").boundingBox();
  const y = handleBox!.y + handleBox!.height / 2;
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + 60, y, { steps: 4 });
  const mid = await geometry();
  await page.screenshot({ path: "test-results/drag-mid.png" });
  await page.mouse.move(handleBox!.x + 120, y, { steps: 4 });
  const after = await geometry();
  await page.screenshot({ path: "test-results/drag-end.png" });
  await page.mouse.up();

  console.log("before:", JSON.stringify(before));
  console.log("mid:   ", JSON.stringify(mid));
  console.log("after: ", JSON.stringify(after));

  // Dragged column grew by ~120px.
  expect(after.ths[0]).toBeGreaterThanOrEqual(before.ths[0] + 100);
  // Every other column must keep its width (±2px) — no squeeze-reflow.
  for (let i = 1; i < before.ths.length; i++) {
    expect(Math.abs(after.ths[i] - before.ths[i]), `column ${i} width changed`).toBeLessThanOrEqual(2);
  }
  // Row heights must not change while dragging (mid → after, both inside the
  // drag: spreadsheet mode clips cell text instead of re-wrapping it).
  for (let i = 0; i < mid.trs.length; i++) {
    expect(Math.abs(after.trs[i] - mid.trs[i]), `row ${i} height changed`).toBeLessThanOrEqual(1);
  }

  // Shrink phase: dragging a wide column narrower must not let the browser
  // redistribute the freed space across the other columns (that re-wrapped
  // text and made rows jump — the "row increase while dragging" complaint).
  const shrinkBefore = await geometry();
  await wrap.locator(".md-table-scroller").evaluate(el => { el.scrollLeft = el.scrollWidth; });
  const notesHandle = await wrap.locator("thead th").nth(5).locator(".md-col-resize").boundingBox();
  const ny = notesHandle!.y + notesHandle!.height / 2;
  await page.mouse.move(notesHandle!.x + notesHandle!.width / 2, ny);
  await page.mouse.down();
  await page.mouse.move(notesHandle!.x - 200, ny, { steps: 6 });
  const shrunk = await geometry();
  await page.mouse.up();
  console.log("shrunk:", JSON.stringify(shrunk));

  expect(shrunk.ths[5]).toBeLessThanOrEqual(shrinkBefore.ths[5] - 180);
  for (let i = 0; i < 5; i++) {
    expect(Math.abs(shrunk.ths[i] - shrinkBefore.ths[i]), `column ${i} grew when Notes shrank`).toBeLessThanOrEqual(2);
  }
  for (let i = 0; i < shrinkBefore.trs.length; i++) {
    expect(Math.abs(shrunk.trs[i] - shrinkBefore.trs[i]), `row ${i} height jumped on shrink`).toBeLessThanOrEqual(1);
  }

  // Fullscreen: the wide viewport is where redistribution was worst.
  await wrap.locator('[data-testid="table-fullscreen-btn"]').click();
  await expect(wrap).toHaveClass(/is-fullscreen/);
  const fsBefore = await geometry();
  const fsHandle = await wrap.locator("thead th").nth(5).locator(".md-col-resize").boundingBox();
  const fy = fsHandle!.y + fsHandle!.height / 2;
  // grab the inner half of the handle — the outer half is clipped at the
  // viewport edge, exactly like a spreadsheet's last column border
  await page.mouse.move(fsHandle!.x + 2, fy);
  await page.mouse.down();
  await page.mouse.move(fsHandle!.x - 300, fy, { steps: 6 });
  const fsAfter = await geometry();
  await page.screenshot({ path: "test-results/drag-fullscreen.png" });
  await page.mouse.up();
  console.log("fs before:", JSON.stringify(fsBefore));
  console.log("fs after: ", JSON.stringify(fsAfter));

  expect(fsAfter.ths[5]).toBeLessThanOrEqual(fsBefore.ths[5] - 280);
  for (let i = 0; i < 5; i++) {
    expect(Math.abs(fsAfter.ths[i] - fsBefore.ths[i]), `fullscreen column ${i} changed`).toBeLessThanOrEqual(2);
  }
  for (let i = 0; i < fsBefore.trs.length; i++) {
    expect(Math.abs(fsAfter.trs[i] - fsBefore.trs[i]), `fullscreen row ${i} height jumped`).toBeLessThanOrEqual(1);
  }
  await page.keyboard.press("Escape");
});

test("right-click header filter and drag column resize work like a spreadsheet", async ({ page }) => {
  const rows = [
    ["Ada", "C", "90", "12", "MIT", "first programmer"],
    ["Grace", "COBOL", "10", "8", "Apache", "compiler pioneer"],
    ["Linus", "C", "50", "20", "GPL", "kernel maintainer"],
    ["Ken", "Go", "30", "15", "BSD", "unix co-author"],
    ["Barbara", "Smalltalk", "70", "5", "MIT", "oop researcher"],
    ["Alan", "Prolog", "20", "3", "MIT", "computability"],
  ];
  const table = ["| Name | Lang | Score | Stars | License | Notes |", "| --- | --- | --- | --- | --- | --- |"]
    .concat(rows.map(r => `| ${r.join(" | ")} |`))
    .join("\n");
  await mockStream(page, table);
  await page.goto("http://localhost:3000/");
  await send(page, "wide table please");

  const wrap = page.locator('[data-testid="md-table-wrap"]');
  await wrap.hover();

  // Right-click on a header opens the unique-values filter dropdown.
  await wrap.locator("thead th").nth(1).click({ button: "right" });
  const menu = page.locator('[data-testid="table-filter-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator(".md-table-menu-list label")).toHaveCount(5); // unique langs (C twice)
  await menu.locator(".md-table-menu-list label").nth(0).click(); // uncheck "C"
  await expect(wrap.locator("tbody tr:visible")).toHaveCount(4);
  await expect(wrap.locator('[data-testid="table-row-count"]')).toHaveText("4 of 6 rows");

  // Custom text term from the search box combines with the value selection.
  await menu.locator('[data-testid="filter-menu-search"]').fill("small");
  await menu.locator('[data-testid="filter-menu-text"]').click();
  await expect(wrap.locator("tbody tr:visible")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(wrap.locator("thead th").nth(1)).toHaveClass(/filter-active/);

  // Dragging the header's right edge resizes the column like a spreadsheet.
  const nameTh = wrap.locator("thead th").nth(0);
  const before = await nameTh.evaluate(el => el.getBoundingClientRect().width);
  const handleBox = await nameTh.locator(".md-col-resize").boundingBox();
  await page.mouse.move(handleBox!.x + 3, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + 120, handleBox!.y + handleBox!.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = await nameTh.evaluate(el => el.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before + 60);
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

test("code lines are single-spaced, not double-spaced", async ({ page }) => {
  const source = "def greet():\n    print('one')\n    print('two')\n    print('three')";
  await mockStream(page, "```python\n" + source + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "spacing check");

  const block = page.locator('[data-testid="code-block"]');
  await expect(block.locator(".shiki span[style]").first()).toBeVisible({ timeout: 10_000 });

  const boxes = await block.locator(".code-block-body .line").evaluateAll(rows =>
    rows.map(row => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    }));
  expect(boxes.length).toBe(4);
  for (const box of boxes) expect(box.height).toBeGreaterThan(15);
  // One line-height at 13px font × 1.65 ≈ 21.5px; the old double-spacing
  // bug (raw \n between line spans) put the gap at ~43px.
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].top - boxes[i - 1].top).toBeLessThan(30);
  }
});

test("lists render real bullet and number markers", async ({ page }) => {
  await mockStream(page, "Points:\n\n- first point\n- second point\n\nSteps:\n\n1. step one\n2. step two");
  await page.goto("http://localhost:3000/");
  await send(page, "list please");

  await expect(page.locator(".msg-content ul").first()).toHaveCSS("list-style-type", "disc");
  await expect(page.locator(".msg-content ol").first()).toHaveCSS("list-style-type", "decimal");
});

test("inline code inside a heading scales with the heading", async ({ page }) => {
  await mockStream(page, "## 5. `app/templates/base.html`");
  await page.goto("http://localhost:3000/");
  await send(page, "heading code");

  const heading = page.locator(".msg-content h2").first();
  await expect(heading).toBeVisible();
  const sizes = await heading.evaluate(h => {
    const code = h.querySelector("code");
    return {
      heading: parseFloat(getComputedStyle(h).fontSize),
      code: code ? parseFloat(getComputedStyle(code).fontSize) : 0,
    };
  });
  // The chip must track the heading size (0.85em), not sit at a fixed 13px.
  expect(sizes.code).toBeGreaterThan(sizes.heading * 0.75);
  expect(sizes.code).toBeLessThan(sizes.heading);
});

test("folder-structure fence renders an interactive IDE-style tree", async ({ page }) => {
  const tree = [
    "my_flask_app/",
    "├── app/",
    "│   ├── __init__.py",
    "│   └── templates/",
    "│       └── base.html",
    "└── run.py",
  ].join("\n");
  await mockStream(page, "```\n" + tree + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "show the tree");

  const treeBlock = page.locator('[data-testid="tree-block"]');
  await expect(treeBlock).toBeVisible();
  await expect(treeBlock).toContainText("base.html");
  expect(await treeBlock.locator(".tree-icon-dir").count()).toBeGreaterThanOrEqual(3);

  // Collapse "app" (exact name match so the root row is not targeted):
  // its children animate to zero height, then restore on re-expand.
  const appRow = treeBlock
    .locator(".tree-row.is-dir")
    .filter({ has: page.locator(".tree-name", { hasText: /^app$/ }) })
    .first();
  await appRow.click();
  const collapsedWrap = treeBlock.locator(".tree-children.is-collapsed").first();
  await expect(collapsedWrap).toBeVisible();
  // Computed grid tracks are always reported in used px, so the collapsed
  // target minmax(0, 0fr) reads as "0px".
  await expect(collapsedWrap).toHaveCSS("grid-template-rows", "0px");

  await appRow.click();
  const leafBox = await treeBlock.getByText("base.html").boundingBox();
  expect(leafBox).not.toBeNull();
  expect(leafBox!.height).toBeGreaterThan(5);
});

test("highlighting and indentation apply mid-stream, not only when the fence closes", async ({ page }) => {
  const blockSource = Array.from(
    { length: 80 },
    (_, i) => `def handler_${String(i).padStart(2, "0")}():\n    result = compute(${i})  # work\n    return result`,
  ).join("\n");
  // Paced SSE, not route.fulfill: fulfill delivers the whole body in one
  // chunk, so the message flips to "complete" before the async highlight can
  // ever paint mid-stream. This server writes one frame every 20ms, keeping
  // data-state="streaming" alive long enough to observe colors landing.
  const fullSource = "```python\n" + blockSource + "\n```";
  const frames: string[] = [];
  for (let i = 0; i < fullSource.length; i += 40) {
    const chunk = fullSource.slice(i, i + 40);
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let frameIndex = 0;
    const pump = setInterval(() => {
      if (frameIndex >= frames.length) {
        clearInterval(pump);
        res.end();
        return;
      }
      res.write(frames[frameIndex++]);
    }, 20);
    req.on("close", () => clearInterval(pump));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route("**/api/chat", route => void route.continue({ url: `http://127.0.0.1:${port}/chat` }));

  await page.goto("http://localhost:3000/");

  const box = page.locator("textarea").first();
  await box.click();
  await box.fill("stream python");
  await box.press("Enter");

  // While the message is still streaming, colored tokens must already exist.
  // The old pure-debounce highlight never fired until the stream ended.
  const streamingColored = page.locator(
    '[data-testid="assistant-message"][data-state="streaming"] .shiki span[style]',
  );
  await expect(streamingColored.first()).toBeVisible({ timeout: 10_000 });

  // Leading indentation is preserved mid-stream inside the highlighted body.
  const hasIndent = await page
    .locator('[data-testid="assistant-message"][data-state="streaming"] .code-block-body')
    .first()
    .evaluate(body => (body.textContent ?? "").includes("    result = compute"));
  expect(hasIndent).toBe(true);

  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout: 30_000 });
  server.close();
});
