import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The ?demo=ui showcase is fully client-side (no model server needed):
// interactive chart + mermaid step playback + SVG anatomy figure + KPI
// widget + table + a retired scene3d fence proving the read-only
// compatibility card (3D/CAD viewers retired 2026-11-06 — Phase 4).
const DEMO_URL = "http://localhost:3000/?demo=ui";
// Downloaded artifacts land here (same convention as anatomy-export.spec.ts).
const EXPORT_DIR = path.join(process.cwd(), ".data", "exports");

// Network-level logs from the intentional "Ask AI" send (the llama.cpp
// server may be down) are not UI defects; uncaught exceptions never are.
// The [PARSER] AbortError log is the stream parser's diagnostic for the
// deliberate Stop click that releases the one-send-at-a-time guard.
const IGNORED_CONSOLE_ERRORS = [/Failed to load resource/i, /net::ERR_/i, /AbortError/];

test.beforeAll(() => fs.mkdirSync(EXPORT_DIR, { recursive: true }));

function watchConsole(page: Page, errors: string[]) {
  page.on("console", msg => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE_ERRORS.some(re => re.test(text))) return;
    errors.push(text);
  });
  page.on("pageerror", err => errors.push(err.message));
}

test("interactive UI showcase: chart, mermaid, anatomy figure, kpi widget, table, retired 3D card", async ({ page }) => {
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

  // --- Anatomy: lazy SVG figure, engine readout, explode toggle ----------
  const anatomy = page.locator('[data-testid="anatomy-block"]');
  await expect(anatomy).toBeVisible({ timeout: 15000 });
  await anatomy.scrollIntoViewIfNeeded();
  await expect(anatomy.locator("svg.anatomy-svg").first()).toBeVisible({ timeout: 15000 });
  await expect(anatomy.locator('[data-testid="anatomy-badge"]'))
    .toContainText("SVG vector illustration — not a 3D mesh");
  // The engine parks its animation loop off-screen (IntersectionObserver),
  // so the readout only animates once the figure is in the viewport — same
  // readiness pattern tests/anatomy.spec.ts pins.
  const readout = anatomy.locator('[data-anatomy-readout="pos"]');
  await expect(readout).toHaveText("30.0", { timeout: 10000 });
  const explode = anatomy.locator('[data-testid="anatomy-explode"]');
  await expect(explode).toHaveAttribute("aria-pressed", "false");
  await explode.click();
  await expect(explode).toHaveAttribute("aria-pressed", "true");

  // --- KPI widget: sliders recompute bound cards live, card click opens callout ---
  const kpi = page.locator('[data-testid="kpi-block"]');
  await expect(kpi).toBeVisible();
  await expect(kpi.locator(".kpi-card")).toHaveCount(4);
  await expect(kpi.locator(".kpi-spark")).toHaveCount(4);
  await expect(kpi.locator(".kpi-trend-up")).toHaveCount(2);
  await expect(kpi.locator(".kpi-trend-down")).toHaveCount(1);

  await page.locator('[data-testid="kpi-slider-growth"]').fill("2");
  await expect(page.locator('[data-testid="kpi-value-mrr"]')).toHaveText("$104k");
  await expect(page.locator('[data-testid="kpi-value-forecast"]')).toHaveText("$52k");
  await page.locator('[data-testid="kpi-slider-extra"]').fill("10");
  await expect(page.locator('[data-testid="kpi-value-forecast"]')).toHaveText("$62k");

  await page.locator('[data-testid="kpi-card-margin"]').click();
  const kpiCallout = page.locator('[data-testid="kpi-callout"]');
  await expect(kpiCallout).toContainText("revenue - cost of goods");
  await expect(kpiCallout).toContainText("engine of the P&L");
  await expect(page.locator('[data-testid="kpi-card-margin"]')).toHaveClass(/is-selected/);
  // useChat allows one send at a time (sendBusyRef guard): the chart-ask
  // send may still be in flight, so stop it before the KPI ask send fires,
  // otherwise the guard silently drops it.
  const stopBtn = page.getByRole("button", { name: "Stop generating" });
  if (await stopBtn.isVisible().catch(() => false)) await stopBtn.click();
  await kpiCallout.locator('[data-testid="kpi-ask-btn"]').click();
  await expect(page.locator('[data-testid="messages-scroll"]')).toContainText("About this metric");

  // --- Markdown table (original build): renders, and has no row-ask bar ---
  const tableWrap = page.locator('[data-testid="md-table-wrap"]').first();
  await expect(tableWrap.locator("tbody tr")).toHaveCount(4);
  await expect(page.locator('[data-testid="row-ask-bar"]')).toHaveCount(0);

  // --- Retired scene3d fence: read-only compatibility card, never run ----
  const retired = page.locator('[data-testid="retired-fence"]');
  await expect(retired).toBeVisible();
  await expect(retired).toContainText("3D scene viewer retired");
  await expect(retired).toContainText("never executed");
  await expect(retired.getByRole("button", { name: "Copy source" })).toBeVisible();
  await retired.locator("summary").click();
  await expect(retired.locator(".retired-fence-source")).toContainText("THREE.Mesh");

  // The download is REAL, not merely present (audit finding 4): clicking it must
  // produce a file whose contents are the saved fence source verbatim. The name
  // says "Download source" because the artifact is text, never a runnable scene.
  const downloadBtn = retired.getByRole("button", { name: "Download source" });
  await expect(downloadBtn).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), downloadBtn.click()]);
  expect(download.suggestedFilename()).toBe("retired-scene3d.json");
  const outFile = path.join(EXPORT_DIR, `demo-${download.suggestedFilename()}`);
  await download.saveAs(outFile);
  expect(fs.readFileSync(outFile, "utf8")).toContain("THREE.Mesh");

  // Proof it never executes: no viewer canvas anywhere, THREE never on page.
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(
    await page.evaluate(() => typeof (window as unknown as { THREE?: unknown }).THREE),
  ).toBe("undefined");

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
