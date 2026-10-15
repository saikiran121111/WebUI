import { test, expect, type Page } from "@playwright/test";

// The ?demo=ui showcase is fully client-side (no model server needed):
// interactive chart + mermaid step playback + scene3d + table row ask.
const DEMO_URL = "http://localhost:3000/?demo=ui";

// Network-level logs from the intentional "Ask AI" send (the llama.cpp
// server may be down) are not UI defects; uncaught exceptions never are.
const IGNORED_CONSOLE_ERRORS = [/Failed to load resource/i, /net::ERR_/i];

function watchConsole(page: Page, errors: string[]) {
  page.on("console", msg => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE_ERRORS.some(re => re.test(text))) return;
    errors.push(text);
  });
  page.on("pageerror", err => errors.push(err.message));
}

test("interactive UI showcase: chart, mermaid, scene3d, table row ask", async ({ page }) => {
  const consoleErrors: string[] = [];
  watchConsole(page, consoleErrors);

  await page.goto(DEMO_URL);

  // --- Chart: switcher, mark click explainer, Ask AI hand-off, legend, slider ---
  const chart = page.locator('[data-testid="chart-block"]');
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute("data-chart-type", "bar");
  await expect(page.getByRole("radiogroup", { name: "Chart type" }).getByRole("radio")).toHaveCount(6);

  await chart.locator(".chart-mark").first().click();
  const explainer = page.locator('[data-testid="chart-explainer"]');
  await expect(explainer).toContainText("of total");
  await expect(explainer.locator(".viz-ask-btn")).toBeVisible();

  await explainer.locator(".viz-ask-btn").click();
  await expect(page.locator('[data-testid="messages-scroll"]'))
    .toContainText("What does this data point tell us?");

  const q1Switch = chart.locator(".chart-legend-switch").filter({ hasText: "Q1" });
  await expect(q1Switch).toHaveAttribute("aria-checked", "true");
  await q1Switch.click();
  await expect(q1Switch).toHaveAttribute("aria-checked", "false");
  await q1Switch.click();

  await page.locator('[data-testid="chart-slider-growth"]').fill("2");
  await expect(chart.locator(".chart-slider-value")).toHaveText("2");

  await page.getByRole("radio", { name: "Donut", exact: true }).click();
  await expect(chart).toHaveAttribute("data-chart-type", "donut");
  await page.getByRole("radio", { name: "Bar", exact: true }).click();
  await expect(chart).toHaveAttribute("data-chart-type", "bar");

  // --- Mermaid: step playback bar, synced highlight, callout ---
  const mermaid = page.locator('[data-testid="mermaid-block"]');
  await expect(mermaid).toBeVisible({ timeout: 15000 });
  const stepCount = page.locator('[data-testid="mermaid-step-count"]');
  await expect(stepCount).toHaveText("Step 0/4");

  await page.getByRole("button", { name: "Next step" }).click();
  await expect(stepCount).toHaveText("Step 1/4");
  await expect(page.locator('[data-testid="mermaid-callout"]')).toContainText("Receive request");
  await expect(mermaid.locator(".viz-active-node")).toHaveCount(1);
  await expect(mermaid.locator(".viz-dimmed-node")).toHaveCount(3);
  await expect(mermaid.locator(".viz-active-edge")).toHaveCount(1);
  // Imperative highlight classes must survive later React re-renders of the
  // block (dangerouslySetInnerHTML re-injection used to wipe them).
  await page.waitForTimeout(800);
  await expect(mermaid.locator(".viz-active-node")).toHaveCount(1);
  await expect(mermaid.locator(".viz-dimmed-node")).toHaveCount(3);

  await page.getByRole("button", { name: "Play steps" }).click();
  await expect(stepCount).toHaveText(/Step [2-4]\/4/, { timeout: 10000 });
  await page.getByRole("button", { name: "Reset playback" }).click();
  await expect(stepCount).toHaveText("Step 0/4");

  // --- Scene3D: lazy three.js canvas, attitude sliders, click-to-inspect ---
  const scene = page.locator('[data-testid="scene3d-block"]');
  await expect(scene).toBeVisible();
  const stage = page.locator('[data-testid="scene3d-stage"]');
  const canvas = stage.locator("canvas");
  let webglOk = true;
  try {
    await expect(canvas.first()).toBeVisible({ timeout: 15000 });
  } catch {
    webglOk = false;
  }

  if (webglOk) {
    await page.locator('[data-testid="scene3d-slider-pitch"]').fill("0.5");
    await expect(scene.locator(".chart-slider-value").first()).toHaveText("0.5");
    await stage.click({ position: { x: 10, y: 10 } }); // orbit drag, must not select
    await expect(page.locator('[data-testid="scene3d-inspect"]')).toHaveCount(0);
    await stage.click(); // center raycast hits the lander body
    await expect(page.locator('[data-testid="scene3d-inspect"]')).toContainText("Lander body");
  } else {
    await expect(stage).toContainText("WebGL is unavailable");
  }

  // --- Markdown table: row click → "Ask AI about this row" bar ---
  const tableWrap = page.locator('[data-testid="md-table-wrap"]').first();
  await tableWrap.locator("tbody tr").first().click();
  const rowAskBar = page.locator('[data-testid="row-ask-bar"]');
  await expect(rowAskBar).toBeVisible();
  await expect(rowAskBar).toContainText("Region: North");
  await expect(rowAskBar.locator(".viz-ask-btn")).toBeVisible();

  // --- Zero NaN in any SVG attribute (charts + mermaid) ---
  const nanAttrs = await page.$$eval("svg, svg *", els =>
    els.flatMap(el =>
      Array.from(el.attributes).map(a => `${el.tagName}.${a.name}=${a.value}`),
    ).filter(v => v.includes("NaN")),
  );
  expect(nanAttrs).toEqual([]);

  // --- Zero console errors / uncaught exceptions ---
  expect(consoleErrors).toEqual([]);
});
