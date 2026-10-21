import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Rendering e2e: drives the real chat UI against a mocked SSE upstream so no
 * model is required. Verifies the release-blocking paths: colored code,
 * character-for-character copy fidelity, tables, charts, and streaming safety.
 * Interactive renderers are Decision Engine mode-gated: mocks carry
 * x-decision-mode, and renderers with no matching RendererMode (widget)
 * are skipped — their fences stay plain code by design. Mermaid mounts in
 * standard_chat (PART 3), so its tests are active again.
 *
 * Requires the dev server on http://localhost:3000 (npm run dev).
 */

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const ASSISTANT_DONE = '[data-testid="assistant-message"][data-state="complete"]';

/** Respond to every POST /api/chat with `content` streamed in small SSE frames.
 *  `decisionMode` carries the Decision Engine's x-decision-mode header: the UI
 *  mounts an interactive renderer ONLY when its kind matches that mode
 *  (```chart needs "chart"). Plain code/markdown paths are unaffected. */
async function mockStream(page: Page, content: string, decisionMode = "standard_chat", chunkSize = 14): Promise<void> {
  await page.route("**/api/chat", async (route) => {
    const frames: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "x-decision-mode": decisionMode },
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

test("markdown table with 4 rows still sorts on header click", async ({ page }) => {
  // Regression: sorting used to require 5+ rows, so the 4-row tables the
  // model streams constantly ignored header clicks while the footer hint
  // still advertised sorting.
  const table = [
    "| Region | Q1 (k$) |",
    "| --- | --- |",
    "| North | 42 |",
    "| South | 28 |",
    "| East | 31 |",
    "| West | 24 |",
  ].join("\n");
  await mockStream(page, table);
  await page.goto("http://localhost:3000/");
  await send(page, "regional table");

  const wrap = page.locator('[data-testid="md-table-wrap"]');
  await expect(wrap).toBeVisible();
  await expect(wrap.locator("table.md-table")).toHaveAttribute("data-sortable", "true");

  await wrap.locator("th").nth(1).click();
  await expect(wrap.locator("tbody tr").first().locator("td").nth(1)).toHaveText("24");
  await wrap.locator("th").nth(1).click();
  await expect(wrap.locator("tbody tr").first().locator("td").nth(1)).toHaveText("42");
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

  // Right-click header filter hides non-matching rows and reports the count.
  await wrap.locator("thead th").nth(1).click({ button: "right" });
  await expect(wrap.locator('[data-testid="table-filter-menu"]')).toBeVisible();
  await wrap.locator('[data-testid="filter-menu-search"]').fill("cobol");
  await wrap.locator('[data-testid="filter-menu-text"]').click();
  await expect(wrap.locator("tbody tr:visible")).toHaveCount(1);
  await expect(wrap.locator('[data-testid="table-row-count"]')).toHaveText("1 of 6 rows");
  // The term button toggles: clicking the active term removes that filter.
  await wrap.locator('[data-testid="filter-menu-text"]').click();
  await expect(wrap.locator("tbody tr:visible")).toHaveCount(6);
  // Clear unchecks every value (hides all rows); All re-checks them. They are
  // deliberately opposites now — Clear exists so you can tick one value after
  // unchecking the rest instead of unticking seven boxes one by one.
  await wrap.locator(".md-table-menu-foot button:has-text('Clear')").click();
  await expect(wrap.locator("tbody tr:visible")).toHaveCount(0);
  await expect(wrap.locator('[data-testid="table-row-count"]')).toHaveText("0 of 6 rows");
  await wrap.locator(".md-table-menu-foot button:has-text('All')").click();
  await expect(wrap.locator("tbody tr:visible")).toHaveCount(6);
  await page.keyboard.press("Escape");

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

  const scrollerW = () => wrap.locator(".md-table-scroller").evaluate(el => el.clientWidth);
  const drag = async (colIdx: number, dx: number) => {
    const box = await wrap.locator("thead th").nth(colIdx).locator(".md-col-resize").boundingBox();
    const y = box!.y + box!.height / 2;
    await page.mouse.move(box!.x + box!.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + dx, y, { steps: 6 });
    const mid = await geometry();
    await page.mouse.up();
    return { mid, after: await geometry() };
  };

  const before = await geometry();
  const containerW = await scrollerW();

  // The last visible column (Notes) is the flexible filler: widening Name
  // must shrink Notes by the same amount — the table never grows past its
  // container, and the middle columns never budge.
  const widen = await drag(0, 120);
  await page.screenshot({ path: "test-results/drag-mid.png" });
  console.log("before:", JSON.stringify(before));
  console.log("widen: ", JSON.stringify(widen.after));
  expect(widen.after.ths[0]).toBeGreaterThanOrEqual(before.ths[0] + 100);
  for (let i = 1; i < 5; i++) {
    expect(Math.abs(widen.after.ths[i] - before.ths[i]), `column ${i} width changed`).toBeLessThanOrEqual(2);
  }
  expect(widen.after.ths[5]).toBeLessThanOrEqual(before.ths[5] - 100); // Notes absorbed the slack
  expect(Math.abs(widen.after.tableW - containerW), "table overflowed its container").toBeLessThanOrEqual(2);
  for (let i = 0; i < widen.mid.trs.length; i++) {
    expect(Math.abs(widen.after.trs[i] - widen.mid.trs[i]), `row ${i} height changed`).toBeLessThanOrEqual(1);
  }

  // Runaway drag right must stop at the clamp (the "goes infinitely to the
  // right" complaint): the filler floors at ~56px and the table keeps
  // filling exactly the container — no endless horizontal growth.
  const runaway = await drag(0, 900);
  console.log("runaway:", JSON.stringify(runaway.after));
  expect(Math.abs(runaway.after.tableW - containerW), "table grew infinitely to the right").toBeLessThanOrEqual(2);
  expect(runaway.after.ths[5]).toBeGreaterThanOrEqual(54);

  // Shrink a middle column: Notes grows back to absorb the freed space —
  // no blank gutter on the right (the "blank in table on right" complaint),
  // and row heights never jump.
  const shrinkBase = await geometry();
  const shrink = await drag(1, -20);
  console.log("shrink:", JSON.stringify(shrink.after));
  expect(shrink.after.ths[1]).toBeLessThanOrEqual(shrinkBase.ths[1] - 18);
  for (const i of [0, 2, 3, 4]) {
    expect(Math.abs(shrink.after.ths[i] - shrinkBase.ths[i]), `column ${i} changed on shrink`).toBeLessThanOrEqual(2);
  }
  expect(shrink.after.ths[5]).toBeGreaterThanOrEqual(shrinkBase.ths[5] + 16);
  expect(Math.abs(shrink.after.tableW - containerW), "blank gutter appeared on the right").toBeLessThanOrEqual(2);
  for (let i = 0; i < shrink.mid.trs.length; i++) {
    expect(Math.abs(shrink.after.trs[i] - shrink.mid.trs[i]), `row ${i} height jumped on shrink`).toBeLessThanOrEqual(1);
  }

  // Fullscreen: same invariants at full viewport width. The last column has
  // no handle there either — its edge is the grid edge.
  await wrap.locator('[data-testid="table-fullscreen-btn"]').click();
  await expect(wrap).toHaveClass(/is-fullscreen/);
  await expect(wrap.locator("thead th").nth(5).locator(".md-col-resize")).toHaveCount(0);
  const fsContainerW = await scrollerW();
  const fsBase = await geometry();
  const fs = await drag(4, 300);
  await page.screenshot({ path: "test-results/drag-fullscreen.png" });
  console.log("fs base: ", JSON.stringify(fsBase));
  console.log("fs after:", JSON.stringify(fs.after));
  expect(fs.after.ths[4]).toBeGreaterThanOrEqual(fsBase.ths[4] + 280);
  expect(fs.after.ths[5]).toBeLessThanOrEqual(fsBase.ths[5] - 280);
  for (const i of [0, 1, 2, 3]) {
    expect(Math.abs(fs.after.ths[i] - fsBase.ths[i]), `fullscreen column ${i} changed`).toBeLessThanOrEqual(2);
  }
  expect(Math.abs(fs.after.tableW - fsContainerW), "fullscreen table overflowed its container").toBeLessThanOrEqual(2);
  for (let i = 0; i < fs.mid.trs.length; i++) {
    expect(Math.abs(fs.after.trs[i] - fs.mid.trs[i]), `fullscreen row ${i} height jumped`).toBeLessThanOrEqual(1);
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

test("a 20-column table stays readable collapsed and expanded", async ({ page }) => {
  const names = ["John", "María", "Yuki", "Patrick", "Sarah", "Takeshi", "Lucia", "Omar", "Freya", "Kwame"];
  const surnames = ["Smith", "García-López", "Tanaka", "O'Brien", "O'Connor", "Yamamoto", "Fernández", "Haddad", "Novak", "Mensah"];
  const cities = ["Berlin", "Madrid", "Tokyo", "Dublin", "Austin", "Osaka", "Lima", "Accra"];
  const cols = ["ID", "Full Name", "Email", "Phone", "Company", "Address", "City", "Country", "Job", "Industry",
    "Website", "Status", "Plan", "Score", "Usage", "Region", "Source", "Segment", "Renewal", "Notes"];
  const rows = Array.from({ length: 40 }, (_, i) => [
    String(i + 1),
    `${names[i % 10]} ${surnames[(i * 3) % 10]}`,
    `${names[i % 10].toLowerCase()}.${surnames[(i * 3) % 10].toLowerCase().replace(/[^a-z]/g, "")}${i}@example.com`,
    `+1-555-${1000 + i}`,
    `Acme Industries ${i}`,
    `${100 + i} Boulevard Avenue`,
    cities[i % 8],
    ["DE", "ES", "JP", "IE", "US", "JP", "PE", "GH"][i % 8],
    ["Engineer", "Analyst", "Designer", "Nurse", "Pilot", "Chef"][i % 6],
    ["Software", "Finance", "Health", "Retail", "Energy", "Media"][i % 6],
    `site-${i}.com`,
    i % 2 ? "Active" : "Inactive",
    ["Free", "Pro", "Enterprise"][i % 3],
    String(50 + (i % 50)),
    `${(i * 37) % 1000} GB`,
    ["NA", "EU", "APAC", "LATAM"][i % 4],
    ["Organic", "Paid Ads", "Referral"][i % 3],
    `Segment-${i % 7}`,
    `2026-0${(i % 9) + 1}-15`,
    `Note ${i}`,
  ]);
  const table = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`]
    .concat(rows.map(r => `| ${r.join(" | ")} |`))
    .join("\n");
  await mockStream(page, table);
  await page.goto("http://localhost:3000/");
  await send(page, "big table please");

  const wrap = page.locator('[data-testid="md-table-wrap"]');
  await wrap.hover();

  const geo = () => wrap.evaluate((el) => {
    const tableEl = el.querySelector("table") as HTMLElement;
    const scroller = el.querySelector(".md-table-scroller") as HTMLElement;
    const ths = Array.from(el.querySelectorAll("thead tr:not(.md-filter-row) th"))
      .filter(th => (th as HTMLElement).offsetWidth > 0)
      .map(th => Math.round((th as HTMLElement).getBoundingClientRect().width));
    const trs = Array.from(el.querySelectorAll("tbody tr")).slice(0, 5)
      .map(tr => Math.round((tr as HTMLElement).getBoundingClientRect().height));
    return {
      tableW: Math.round(tableEl.getBoundingClientRect().width),
      scrollerW: scroller.clientWidth,
      ths, trs,
    };
  });

  // Collapsed (4 visible columns): the table must fill the wrap — no blank
  // dead zone to the right of the grid.
  const collapsed = await geo();
  console.log("collapsed:", JSON.stringify(collapsed));
  expect(collapsed.ths).toHaveLength(4);
  expect(collapsed.tableW, "collapsed table leaves a blank gutter").toBeGreaterThanOrEqual(collapsed.scrollerW - 2);

  // Expanded (all 20 columns): columns must never squeeze into one-character
  // slivers — the scroller takes horizontal scroll instead, and rows stay short.
  await wrap.locator('[data-testid="table-cols-btn"]').click();
  const expanded = await geo();
  console.log("expanded:", JSON.stringify(expanded));
  expect(expanded.ths).toHaveLength(20);
  for (const w of expanded.ths) {
    expect(w, "column squeezed into an unreadable sliver").toBeGreaterThanOrEqual(90);
  }
  for (const h of expanded.trs) {
    expect(h, "row ballooned by one-character-per-line wrapping").toBeLessThanOrEqual(80);
  }

  // Expanded wide tables overflow the scroller: dragging a header edge must
  // still resize that column. It used to snap to the 56px floor because the
  // clamp measured the viewport instead of the table, so left/right drags
  // did nothing.
  const dragEdge = async (colIdx: number, dx: number) => {
    const box = (await wrap.locator("thead th").nth(colIdx).locator(".md-col-resize").boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 6 });
    await page.mouse.up();
    return geo();
  };
  const widened = await dragEdge(0, 150);
  console.log("expanded widened:", JSON.stringify(widened.ths.slice(0, 2)));
  expect(widened.ths[0], "drag right did nothing on an expanded overflowing table").toBeGreaterThanOrEqual(expanded.ths[0] + 130);
  expect(widened.tableW, "table did not grow with the drag").toBeGreaterThanOrEqual(expanded.tableW + 130);
  const shrunk = await dragEdge(0, -100);
  console.log("expanded shrunk:", JSON.stringify(shrunk.ths.slice(0, 2)));
  expect(shrunk.ths[0], "drag left did nothing").toBeLessThanOrEqual(widened.ths[0] - 80);
});

test("expanding a wide table keeps rows compact before any drag", async ({ page }) => {
  // One off-screen column carries long text: if cells wrap while the table
  // overflows the scroller, that invisible cell sets every row's height and
  // the visible rows fill with tall empty gaps until the first drag.
  const rows = [
    ["Python", "Multi-paradigm", "1991", "Dynamic", "~1.2M", "450K+ pkgs", "Easy", "ML and data science, web backends, automation, scripting glue"],
    ["Zig", "Multi-paradigm", "2016", "Static", "~115M", "8K+ pkgs", "Brutal", "Systems programming, embedded targets, game tooling, compilers"],
    ["C", "Procedural", "1972", "Static", "~120M", "12K+ libs", "Brutal", "Operating systems, embedded firmware, language runtimes, drivers"],
    ["TypeScript", "Multi-paradigm", "2012", "Static", "~45M", "2.1M+ pkgs", "Moderate", "Web frontends and backends, tooling, large shared codebases"],
    ["Kotlin", "OOP + FP", "2011", "Static", "~52M", "320K+ libs", "Moderate", "Android apps, JVM services, multiplatform shared logic"],
    ["Go", "Procedural", "2009", "Static", "~78M", "85K+ modules", "Easy", "Cloud services, CLIs, networking proxies, containers"],
    ["Rust", "Multi-paradigm", "2010", "Static", "~95M", "140K+ crates", "Brutal", "Systems software, WASM modules, CLI tools, game engines"],
  ];
  const cols = ["Language", "Paradigm", "Year", "Typing", "Speed", "Ecosystem", "Learning", "Best For"];
  const table = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`]
    .concat(rows.map(r => `| ${r.join(" | ")} |`))
    .join("\n");
  await mockStream(page, table);
  await page.goto("http://localhost:3000/");
  await send(page, "beefy table please");

  const wrap = page.locator('[data-testid="md-table-wrap"]');
  await wrap.hover();
  await wrap.locator('[data-testid="table-cols-btn"]').click(); // expand, no drag yet

  const state = await wrap.evaluate((el) => {
    const tableEl = el.querySelector("table") as HTMLElement;
    const scroller = el.querySelector(".md-table-scroller") as HTMLElement;
    return {
      overflowing: tableEl.getBoundingClientRect().width > scroller.clientWidth + 1,
      trs: Array.from(el.querySelectorAll("tbody tr")).slice(0, 5)
        .map(tr => Math.round((tr as HTMLElement).getBoundingClientRect().height)),
    };
  });
  console.log("expanded pre-drag:", JSON.stringify(state));
  expect(state.overflowing, "expanded table should overflow the scroller").toBe(true);
  for (const h of state.trs) {
    expect(h, "row ballooned by off-screen wrapped text before any drag").toBeLessThanOrEqual(48);
  }
});

test("a wide table stays collapsed while it is still generating", async ({ page }) => {
  const cols = ["ID", "First Name", "Last Name", "Email", "Age", "Salary", "Department", "Role",
    "Level", "City", "Country", "Start Date", "Status", "Manager", "Notes"];
  const rows = Array.from({ length: 30 }, (_, i) => [
    String(i + 1),
    ["John", "María", "Yuki", "Patrick", "Sarah"][i % 5],
    ["Smith", "García", "Tanaka", "O'Brien", "Haddad"][i % 5],
    `user${i}@example.com`,
    String(22 + (i % 30)),
    String(40000 + i * 1000),
    ["Support", "Engineering", "Sales", "Finance"][i % 4],
    ["Tier 2 Agent", "Junior Dev", "Senior Dev", "Lead"][i % 4],
    `L${1 + i % 5}`,
    ["Berlin", "Madrid", "Tokyo", "Dublin"][i % 4],
    ["DE", "ES", "JP", "IE"][i % 4],
    `202${3 + i % 4}-0${1 + i % 9}-15`,
    i % 2 ? "Active" : "Inactive",
    ["Dana", "Eli", "Fay"][i % 3],
    `Note ${i}`,
  ]);
  const table = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`]
    .concat(rows.map(r => `| ${r.join(" | ")} |`))
    .join("\n");
  // Paced SSE: route.fulfill delivers the whole body in one chunk, so the
  // table would only ever be observed complete. This server writes a frame
  // every 40ms (~4.5s of streaming) so the mid-generation state stays
  // observable even when the first paint lags behind the stream on a cold
  // dev-server compile — at 15ms the whole stream finished before the wrap
  // had rendered and the sampler only ever saw the completed message.
  const frames: string[] = [];
  for (let i = 0; i < table.length; i += 40) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: table.slice(i, i + 40) } }] })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let frameIndex = 0;
    const pump = setInterval(() => {
      if (frameIndex >= frames.length) { clearInterval(pump); res.end(); return; }
      res.write(frames[frameIndex++]);
    }, 40);
    req.on("close", () => clearInterval(pump));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route("**/api/chat", route => void route.continue({ url: `http://127.0.0.1:${port}/chat` }));

  await page.goto("http://localhost:3000/");
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill("big table streaming");
  await box.press("Enter");

  const wrap = page.locator('[data-testid="md-table-wrap"]');
  await wrap.waitFor({ timeout: 15_000 });
  await wrap.hover(); // the user's cursor was over the bubble mid-generation

  // Sample the live DOM while the message is still streaming: no row may
  // expose columns past the 4th (the streamed-rows leak), and the grid must
  // keep filling the wrap (no blank gutter).
  let samples = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const msg = document.querySelector('[data-testid="assistant-message"]');
      const el = document.querySelector('[data-testid="md-table-wrap"]');
      const tableEl = el?.querySelector("table");
      const header = el?.querySelector("thead tr:not(.md-filter-row)");
      if (!msg || !el || !tableEl || !header) return null;
      const visibleCells = (row: Element) =>
        Array.from(row.children).filter(c => (c as HTMLElement).offsetWidth > 0).length;
      const scroller = el.querySelector(".md-table-scroller") as HTMLElement;
      return {
        streaming: msg.getAttribute("data-state") === "streaming",
        headerVisible: visibleCells(header),
        leakedRows: Array.from(tableEl.querySelectorAll("tbody tr"))
          .map((r, i) => [i + 1, visibleCells(r)] as const)
          .filter(([, n]) => n > 4),
        tableW: Math.round(tableEl.getBoundingClientRect().width),
        scrollerW: scroller.clientWidth,
      };
    });
    if (!snap) { await page.waitForTimeout(100); continue; }
    expect(snap.headerVisible, "header exposed more than 4 columns mid-stream").toBeLessThanOrEqual(4);
    expect(snap.leakedRows, `rows leaked extra columns mid-stream: ${JSON.stringify(snap.leakedRows)}`).toHaveLength(0);
    expect(snap.tableW, "blank gutter to the right of the grid mid-stream").toBeGreaterThanOrEqual(snap.scrollerW - 2);
    samples++;
    if (!snap.streaming) break;
    await page.waitForTimeout(120);
  }
  expect(samples, "never observed a streaming table long enough to verify").toBeGreaterThanOrEqual(5);

  // Stream finished: collapse intact, expand toggle still works.
  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout: 15_000 });
  await expect(wrap.locator("thead th:visible")).toHaveCount(4);
  await expect(wrap.locator('[data-testid="table-cols-btn"]')).toBeVisible();
  await wrap.locator('[data-testid="table-cols-btn"]').click();
  await expect(wrap.locator("thead th:visible")).toHaveCount(15);
  server.close();
});

test("a streaming table renders as a table immediately, never as raw pipe text", async ({ page }) => {
  const cols = Array.from({ length: 22 }, (_, i) => `Column ${i + 1} With A Longish Header Name`);
  const rows = Array.from({ length: 6 }, (_, i) => cols.map((_, c) => `r${i}c${c}`));
  const table = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`]
    .concat(rows.map(r => `| ${r.join(" | ")} |`)).join("\n");
  // Paced SSE at 10 chars/frame: the header line alone takes ~2s to arrive —
  // exactly the window where the raw-pipe paragraph used to render instead
  // of the table (remark-gfm needs the full `| --- |` row to parse a table).
  const frames: string[] = [];
  for (let i = 0; i < table.length; i += 10) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: table.slice(i, i + 10) } }] })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let frameIndex = 0;
    const pump = setInterval(() => {
      if (frameIndex >= frames.length) { clearInterval(pump); res.end(); return; }
      res.write(frames[frameIndex++]);
    }, 25);
    req.on("close", () => clearInterval(pump));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await page.route("**/api/chat", route => void route.continue({ url: `http://127.0.0.1:${port}/chat` }));

  await page.goto("http://localhost:3000/");
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill("raw pipe flash");
  await box.press("Enter");

  // Sample the live DOM: no paragraph may ever contain pipe text, and the
  // table wrap must appear while the message is still streaming.
  let sawTableWhileStreaming = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const msg = document.querySelector('[data-testid="assistant-message"]');
      if (!msg) return null;
      const rawPipe = Array.from(msg.querySelectorAll("p"))
        .some(p => /\|\s/.test(p.textContent ?? ""));
      return {
        streaming: msg.getAttribute("data-state") === "streaming",
        rawPipe,
        hasWrap: !!msg.querySelector('[data-testid="md-table-wrap"]'),
      };
    });
    if (!snap) { await page.waitForTimeout(100); continue; }
    expect(snap.rawPipe, "raw pipe text rendered as a paragraph mid-stream").toBe(false);
    if (snap.hasWrap && snap.streaming) sawTableWhileStreaming = true;
    if (!snap.streaming) break;
    await page.waitForTimeout(80);
  }
  expect(sawTableWhileStreaming, "the table never rendered while the message was still streaming").toBe(true);

  // Stream finished: the real delimiter row took over, collapse is intact.
  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout: 20_000 });
  const wrap = page.locator('[data-testid="md-table-wrap"]');
  await expect(wrap.locator("thead th:visible")).toHaveCount(4);
  await expect(wrap.locator("tbody tr")).toHaveCount(6);
  server.close();
});

// Re-enabled by PART 3: standard_chat's MODE_RENDER_KINDS includes "mermaid",
// so the diagram stage mounts again on chat turns (mockStream defaults to
// standard_chat).
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

// Re-enabled with the valid-mermaid test: the mermaid-error fallback branch
// runs again under standard_chat.
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
  await mockStream(page, "```chart\n" + spec + "\n```", "chart");
  await page.goto("http://localhost:3000/");
  await send(page, "chart this");

  await expect(page.locator(".chart-svg")).toBeVisible();
  await expect(page.locator(".chart-legend")).toContainText("2025");

  // Underlying values must be viewable (data traceability).
  await page.locator(".chart-block button[aria-pressed]").first().click();
  await expect(page.locator(".chart-data-table")).toContainText("30");
});

test("invalid chart fence shows a readable fallback, never invented data", async ({ page }) => {
  await mockStream(page, "```chart\n{ not valid json\n```", "chart");
  await page.goto("http://localhost:3000/");
  await send(page, "bad chart");
  await expect(page.locator('[data-testid="chart-error"]')).toBeVisible();
  await expect(page.locator('[data-testid="code-block"]')).toContainText("not valid json");
});

// Retired by the Hybrid Decision Engine (2026-10-18): the 9-mode contract has
// no widget mode, so MODE_RENDER_KINDS never allows the "widget" kind — the
// form fence stays plain code and WidgetBlock can never mount by design.
test.skip("widget form validates and sends only the submitted values", async ({ page }) => {
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
  await mockStream(page, full, "standard_chat", 5); // tiny chunks split fences mid-token
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
  // A collapsed wrapper is legitimately zero-height (minmax(0, 0fr)), which
  // Playwright reports as "hidden" — assert the stable end-state contract
  // instead of visibility (the 250ms transition window is not observable).
  await expect(collapsedWrap).toHaveCount(1);
  // Computed grid tracks are always reported in used px, so the collapsed
  // target minmax(0, 0fr) reads as "0px".
  await expect(collapsedWrap).toHaveCSS("grid-template-rows", "0px");
  const collapsedBox = await collapsedWrap.boundingBox();
  expect(collapsedBox?.height).toBeLessThan(2);

  await appRow.click();
  const leafBox = await treeBlock.getByText("base.html").boundingBox();
  expect(leafBox).not.toBeNull();
  expect(leafBox!.height).toBeGreaterThan(5);
});

test("large folder tree with │ spacers renders interactive and never flickers to plain code mid-stream", async ({ page }) => {
  // Regression: trees with several `│`-only spacer lines failed content
  // detection (spacers counted as non-tree lines), so big trees rendered as
  // a plain CodeBlock — and mid-stream the counts crossed the threshold
  // back and forth, remounting TreeBlock/CodeBlock (visible flicker).
  const tree = [
    "my-app/",
    "├── public/                 # Static assets (images, fonts, favicons)",
    "│   ├── images/",
    "│   └── fonts/",
    "│",
    "├── src/",
    "│   ├── app/                # App Router (file-based routing)",
    "│   │   ├── (auth)/         # Route group (no URL segment)",
    "│   │   │   ├── login/",
    "│   │   │   │   └── page.tsx",
    "│   │   │   └── register/",
    "│   │   │       └── page.tsx",
    "│   │   ├── (dashboard)/    # Route group",
    "│   │   │   ├── layout.tsx  # Shared layout for dashboard",
    "│   │   │   └── page.tsx    # /dashboard",
    "│   │   ├── settings/",
    "│   │   │   └── page.tsx",
    "│   │   └── users/",
    "│   │       ├── page.tsx    # /users (list)",
    "│   │       └── [id]/",
    "│   │           └── page.tsx # /users/:id (dynamic)",
    "│   ",
    "│   ├── api/",
    "│   │   ├── auth/",
    "│   │   │   └── route.ts",
    "│   │   ",
    "│   └── components/",
    "│       ├── ui/",
    "│       └── forms/",
    "│",
    "├── tests/",
    "│   └── e2e/",
    "│",
    "└── package.json",
  ].join("\n");

  // Paced SSE (not route.fulfill) so the stream stays open long enough to
  // observe the mid-stream renderer state.
  const fullSource = "```\n" + tree + "\n```";
  const frames: string[] = [];
  for (let i = 0; i < fullSource.length; i += 14) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: fullSource.slice(i, i + 14) } }] })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-decision-mode": "standard_chat",
    });
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

  // Watch every DOM mutation while streaming: the tree must appear while the
  // message is still streaming, must never vanish, and a plain code block
  // for the fence must never appear after it (the flicker signature).
  await page.addInitScript(() => {
    // `treeNow` / `frames` are merged in on the Node side at read time
    // (page.evaluate); they must exist in the type here so the spread at
    // the read site type-checks.
    const state: {
      installed: boolean; mutations: number; error: string;
      treeSeen: boolean; treeSeenWhileStreaming: boolean;
      treeVanished: boolean; codeBlockAfterTree: boolean;
      treeNow?: number; frames?: number;
    } = {
      installed: false, mutations: 0, error: "", treeSeen: false,
      treeSeenWhileStreaming: false, treeVanished: false, codeBlockAfterTree: false,
    };
    (window as unknown as { __treeWatch: typeof state }).__treeWatch = state;
    try {
      const scan = () => {
        const streaming = document.querySelector('[data-testid="assistant-message"][data-state="streaming"]');
        const tree = document.querySelector('[data-testid="tree-block"]');
        if (tree) {
          if (!state.treeSeen) {
            state.treeSeen = true;
            state.treeSeenWhileStreaming = streaming !== null;
          }
        } else if (state.treeSeen && streaming) {
          state.treeVanished = true;
        }
        if (state.treeSeen && streaming && streaming.querySelector('[data-testid="code-block"]')) {
          state.codeBlockAfterTree = true;
        }
      };
      // Observe `document` itself: init scripts run before documentElement
      // exists, and observing the document node covers everything added later.
      new MutationObserver(() => { (state.mutations as number)++; scan(); })
        .observe(document, { subtree: true, childList: true, characterData: true });
      state.installed = true;
    } catch (e) {
      state.error = String(e);
    }
  });

  await page.goto("http://localhost:3000/");
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill("show the big tree");
  await box.press("Enter");

  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout: 30_000 });
  server.close();

  // `treeNow` / `frames` are added on the Node side; the watcher state
  // keys are widened via a cast so the spread yields a single object type
  // that carries both the watcher fields and the DOM counts.
  type TreeWatch = {
    treeSeen: boolean; treeSeenWhileStreaming: boolean;
    treeVanished: boolean; codeBlockAfterTree: boolean;
    treeNow: number; frames: number;
  };
  const watch = (await page.evaluate(() => {
    const state = (window as unknown as { __treeWatch: Record<string, unknown> }).__treeWatch;
    return {
      ...state,
      treeNow: document.querySelectorAll('[data-testid="tree-block"]').length,
      frames: document.querySelectorAll('[data-testid="assistant-message"]').length,
    };
  })) as unknown as TreeWatch;
  expect(watch.treeSeen, `tree never rendered — watcher: ${JSON.stringify(watch)}`).toBe(true);
  expect(watch.treeSeenWhileStreaming, "tree only appeared after the stream ended").toBe(true);
  expect(watch.treeVanished, "tree block vanished mid-stream (flicker to plain text)").toBe(false);
  expect(watch.codeBlockAfterTree, "plain code block appeared after the tree (flicker)").toBe(false);

  // Completed message: interactive tree, not a plain fence.
  const treeBlock = page.locator('[data-testid="tree-block"]');
  await expect(treeBlock).toBeVisible();
  await expect(treeBlock.locator(".code-block-lang")).toHaveText("Structure");
  await expect(treeBlock.getByText("package.json")).toBeVisible();
  expect(await treeBlock.locator(".tree-icon-dir").count()).toBeGreaterThanOrEqual(10);
  await expect(page.locator('[data-testid="code-block"]')).toHaveCount(0);

  // Collapse-all keeps the interactive tree (the reported bug: big trees
  // were plain CodeBlocks whose collapsed body was raw text).
  await treeBlock.locator('button[aria-label="Collapse all folders"]').click();
  await expect(treeBlock.locator(".tree-children.is-collapsed").first()).toHaveCount(1);
  await expect(treeBlock.locator(".tree-icon-dir").first()).toBeVisible();
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
