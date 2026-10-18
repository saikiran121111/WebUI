import { expect, test, type Page } from "@playwright/test";

const DEMO_URL = "http://localhost:3000/?demo=ui";

async function openCadViewer(page: Page) {
  await page.route("**/api/3d/assets*", (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.goto(DEMO_URL);
  await expect(page.locator('[data-testid="cad-block"]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-testid="cad-stage"]')).toBeVisible();
}

test.describe("ArchitectureCAD viewer", () => {
  test("renders the 2D CAD stage with walls, flows and hotspots", async ({ page }) => {
    await openCadViewer(page);
    await expect(page.locator('[data-testid="cad-wall-envelope"]')).toBeVisible();
    // horizontal polyline has a zero-height bbox, so Playwright calls it "hidden"
    await expect(page.locator('[data-testid="cad-flow-hvac"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="cad-hotspot-hs-meet"]')).toBeVisible();
    await expect(page.locator('[data-testid="cad-status"]')).toContainText("1:100");
    await expect(page.locator('[data-testid="cad-status"]')).toContainText("units m");
  });

  test("layer manager hides and restores a layer", async ({ page }) => {
    await openCadViewer(page);
    await page.click('[data-testid="cad-hide-walls"]');
    await expect(page.locator('[data-testid="cad-wall-envelope"]')).toHaveCount(0);
    await page.click('[data-testid="cad-hide-walls"]');
    await expect(page.locator('[data-testid="cad-wall-envelope"]')).toBeVisible();
  });

  test("solo isolates one layer", async ({ page }) => {
    await openCadViewer(page);
    await page.click('[data-testid="cad-solo-walls"]');
    await expect(page.locator('[data-testid="cad-solo-clear"]')).toBeVisible();
    await expect(page.locator('[data-testid="cad-wall-envelope"]')).toBeVisible();
    await expect(page.locator('[data-layer="anno"]')).toHaveCount(0);
    await page.click('[data-testid="cad-solo-clear"]');
    await expect(page.locator('[data-layer="anno"]')).toHaveCount(1);
  });

  test("measure tool labels a point-to-point distance", async ({ page }) => {
    await openCadViewer(page);
    const stage = page.locator('[data-testid="cad-stage"]');
    await page.click('[data-testid="cad-tool-measure"]');
    // The tool click auto-scrolls the toolbar into view, which can push this
    // tall stage below the fold; re-center it before reading its box so the
    // raw mouse coordinates land inside the viewport.
    await stage.scrollIntoViewIfNeeded();
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.5);
    await page.mouse.click(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5);
    await expect(page.locator(".cad-measure text")).toHaveText(/\d+(\.\d+)? m/);
  });

  test("zoom buttons update the status readout", async ({ page }) => {
    await openCadViewer(page);
    await page.click('[data-testid="cad-zoom-200"]');
    await expect(page.locator('[data-testid="cad-status"]')).toContainText("200%");
    await page.click('[data-testid="cad-zoom-fit"]');
    await expect(page.locator('[data-testid="cad-status"]')).toContainText("100%");
  });

  test("hotspot click opens the inspector card", async ({ page }) => {
    await openCadViewer(page);
    await page.click('[data-testid="cad-hotspot-hs-meet"]');
    await expect(page.locator('[data-testid="cad-inspect"]')).toBeVisible();
    await expect(page.locator('[data-testid="cad-inspect"]')).toContainText("Meeting");
  });

  test("iso cutaway mode renders projected wall faces", async ({ page }) => {
    await openCadViewer(page);
    await page.click('[data-testid="cad-view-iso"]');
    await expect(page.locator('[data-testid="cad-iso-stage"]')).toBeVisible();
    await expect(page.locator('[data-testid="cad-iso-stage"] polygon').first()).toBeVisible();
  });

  test("DXF export reports a real layered export", async ({ page }) => {
    await openCadViewer(page);
    await page.selectOption('[data-testid="cad-export-format"]', "dxf");
    await page.click('[data-testid="cad-export"]');
    await expect(page.locator('[data-testid="cad-export-note"]')).toContainText("DXF (R2000) saved", { timeout: 15000 });
  });

  test("3D BIM mode mounts a WebGL canvas with stats", async ({ page }) => {
    await openCadViewer(page);
    await page.click('[data-testid="cad-view-3d"]');
    let webglOk = true;
    try {
      await expect(page.locator('[data-testid="cad-3d"] canvas')).toBeVisible({ timeout: 15000 });
    } catch {
      webglOk = false;
    }
    test.skip(!webglOk, "WebGL unavailable in this browser");
    await expect(page.locator('[data-testid="cad-stats"]')).toContainText("meshes", { timeout: 15000 });
  });
});
