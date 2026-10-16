import { test, expect } from "@playwright/test";

// Deterministic Anatomy showcase — renders entirely client-side, no model
// server required (same mechanism as the three3d demo specs).
const ANATOMY_URL = "http://localhost:3000/?demo=anatomy";

test.describe("Anatomy illustration blocks", () => {
  test("renders four SVG plates with honest non-mesh labeling", async ({ page }) => {
    await page.goto(ANATOMY_URL);
    const blocks = page.locator('[data-testid="anatomy-block"]');
    await expect(blocks).toHaveCount(4, { timeout: 20000 });
    await expect(page.locator("svg.anatomy-svg")).toHaveCount(4);
    await expect(page.locator('[data-testid="anatomy-badge"]').first()).toContainText("not a 3D mesh");
    // No fake mesh-format options anywhere in the anatomy toolbars.
    const toolbarText = await page.locator(".anatomy-toolbar").first().innerText();
    expect(toolbarText.toLowerCase()).not.toContain("glb");
    expect(toolbarText.toLowerCase()).not.toContain("stl");
  });

  test("controls drive the live state model: slider moves piston and readout", async ({ page }) => {
    await page.goto(ANATOMY_URL);
    const first = page.locator('[data-testid="anatomy-block"]').first();
    await expect(first).toBeVisible({ timeout: 20000 });
    const readout = first.locator('[data-anatomy-readout="pos"]');
    await expect(readout).toHaveText("30.0", { timeout: 10000 });
    const slider = first.locator('input[type="range"]').first();
    await expect(slider).toBeVisible();
    await slider.evaluate((el) => {
      (el as HTMLInputElement).value = "1";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(readout).toHaveText("42.0");
    await expect(first.locator('[data-part="piston"]')).toHaveAttribute("transform", /translate\(/);
  });

  test("explode toggle separates parts and flips aria-pressed", async ({ page }) => {
    await page.goto(ANATOMY_URL);
    const first = page.locator('[data-testid="anatomy-block"]').first();
    await expect(first).toBeVisible({ timeout: 20000 });
    const explode = first.locator('[data-testid="anatomy-explode"]');
    await expect(explode).toHaveAttribute("aria-pressed", "false");
    await explode.click();
    await expect(explode).toHaveAttribute("aria-pressed", "true");
    await expect(first.locator('[data-part="barrel"]')).toHaveAttribute("transform", /translate\(/);
  });

  test("theme toggle flips the plate palette", async ({ page }) => {
    await page.goto(ANATOMY_URL);
    const first = page.locator('[data-testid="anatomy-block"]').first();
    await expect(first).toBeVisible({ timeout: 20000 });
    await expect(first).toHaveAttribute("data-theme", "dark");
    await first.locator('[data-testid="anatomy-theme"]').click();
    await expect(first).toHaveAttribute("data-theme", "light");
  });

  test("downloads: standalone SVG, PNG, and interactive HTML all work", async ({ page }) => {
    await page.goto(ANATOMY_URL);
    const first = page.locator('[data-testid="anatomy-block"]').first();
    await expect(first).toBeVisible({ timeout: 20000 });

    const svgDownload = await Promise.all([
      page.waitForEvent("download"),
      first.locator('[data-testid="anatomy-download-svg"]').click(),
    ]).then(([d]) => d);
    expect(svgDownload.suggestedFilename()).toBe("single-cyl-head.svg");

    const pngDownload = await Promise.all([
      page.waitForEvent("download"),
      first.locator('[data-testid="anatomy-download-png"]').click(),
    ]).then(([d]) => d);
    expect(pngDownload.suggestedFilename()).toBe("single-cyl-head.png");

    const htmlDownload = await Promise.all([
      page.waitForEvent("download"),
      first.locator('[data-testid="anatomy-download-html"]').click(),
    ]).then(([d]) => d);
    expect(htmlDownload.suggestedFilename()).toBe("single-cyl-head.html");
  });

  test("mobile width keeps the plate inside the block", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ANATOMY_URL);
    const first = page.locator('[data-testid="anatomy-block"]').first();
    await expect(first).toBeVisible({ timeout: 20000 });
    const box = await first.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(390);
  });

  test("reduced motion still renders every figure", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(ANATOMY_URL);
    await expect(page.locator('[data-testid="anatomy-block"]').first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator("svg.anatomy-svg")).toHaveCount(4);
  });
});
