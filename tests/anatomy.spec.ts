import { test, expect } from "@playwright/test";

// Deterministic Anatomy showcase — renders entirely client-side, no model
// server required (same mechanism as the three3d demo specs).
const ANATOMY_URL = "http://localhost:3000/?demo=anatomy";

test.describe("Anatomy illustration blocks", () => {
  test("renders five SVG plates with honest non-mesh labeling", async ({ page }) => {
    await page.goto(ANATOMY_URL);
    const blocks = page.locator('[data-testid="anatomy-block"]');
    await expect(blocks).toHaveCount(5, { timeout: 20000 });
    await expect(page.locator("svg.anatomy-svg")).toHaveCount(5);
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
    // The live engine attaches via an async dynamic import; wait for its
    // readiness marker before dispatching input events at the slider.
    await expect(first).toHaveAttribute("data-anatomy-live", "1", { timeout: 20000 });
    // The engine's animation loop (which drives the readout) parks itself
    // via IntersectionObserver when the plate is off-viewport — scroll it in
    // view like a real user before expecting slider input to animate.
    await first.scrollIntoViewIfNeeded();
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
    await expect(first).toHaveAttribute("data-anatomy-live", "1", { timeout: 20000 });
    await first.scrollIntoViewIfNeeded();
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
    await expect(page.locator("svg.anatomy-svg")).toHaveCount(5);
  });
});

// The advanced-profile architectural cutaway (FIG 5) exercises the v2 runtime:
// layer toggles, floor/system inspection, flows, info panels and zoom/pan.
test.describe("Architectural cutaway runtime (advanced profile)", () => {
  async function openCutaway(page: import("@playwright/test").Page) {
    await page.goto(ANATOMY_URL);
    const arch = page.locator('[data-testid="anatomy-block"]').nth(4);
    await expect(arch).toBeVisible({ timeout: 20000 });
    await expect(arch.locator('[data-part="f6__plate"]')).toBeVisible();
    return arch;
  }

  test("layer toggle hides its group's parts and connections", async ({ page }) => {
    const arch = await openCutaway(page);
    await expect(arch.locator('[data-part="col1"]')).toBeVisible();
    await arch.locator("button.anatomy-toggle", { hasText: "Facade" }).click();
    await expect(arch.locator('[data-part="col1"]')).toBeHidden();
    await expect(arch.locator('[data-part="canopy"]')).toBeHidden();
    await arch.locator("button.anatomy-toggle", { hasText: "Water" }).click();
    await expect(arch.locator('g[data-connection="conn-water"]')).toBeHidden();
    // other layers stay untouched — independent visibility per group
    await expect(arch.locator('[data-part="core-shaft"]')).toBeVisible();
  });

  test("PV visibility toggle hides the gated part only", async ({ page }) => {
    const arch = await openCutaway(page);
    await expect(arch.locator('[data-part="pv-array"]')).toBeVisible();
    await arch.locator("button.anatomy-toggle", { hasText: "PV array" }).click();
    await expect(arch.locator('[data-part="pv-array"]')).toBeHidden();
    await expect(arch.locator('[data-part="energy-riser"]')).toBeVisible();
  });

  test("floor select dims other floors but preserves overall building context", async ({ page }) => {
    const arch = await openCutaway(page);
    await arch.locator("select").first().selectOption("f3");
    await expect(arch.locator('[data-part="f1__plate"]')).toHaveAttribute("opacity", "0.12");
    await expect(arch.locator('[data-part="f3__plate"]')).not.toHaveAttribute("opacity");
    // untagged context (core, foundation) is never dimmed
    await expect(arch.locator('[data-part="core-shaft"]')).not.toHaveAttribute("opacity");
  });

  test("system select isolates one service system", async ({ page }) => {
    const arch = await openCutaway(page);
    await arch.locator("select").nth(1).selectOption("hvac");
    await expect(arch.locator('[data-part="water-riser"]')).toHaveAttribute("opacity", "0.12");
    await expect(arch.locator('[data-part="hvac-trunk"]')).not.toHaveAttribute("opacity");
    await expect(arch.locator('g[data-connection="conn-water"]')).toHaveAttribute("opacity", "0.12");
  });

  test("flow play animates dashoffset along the route; pause freezes; reset zeroes", async ({ page }) => {
    const arch = await openCutaway(page);
    const flow = arch.locator('[data-flow="flow-energy"]');
    await expect(flow).toHaveAttribute("stroke-dashoffset", "0");
    await arch.locator("button.anatomy-button", { hasText: "Play flows" }).click();
    await page.waitForTimeout(350);
    const first = Number(await flow.getAttribute("stroke-dashoffset"));
    await page.waitForTimeout(350);
    const second = Number(await flow.getAttribute("stroke-dashoffset"));
    expect(second).toBeLessThan(first); // dashes travel along the connection path
    await arch.locator("button.anatomy-button", { hasText: "Pause" }).click();
    await page.waitForTimeout(250);
    const paused = Number(await flow.getAttribute("stroke-dashoffset"));
    await page.waitForTimeout(250);
    expect(Number(await flow.getAttribute("stroke-dashoffset"))).toBe(paused);
    await arch.locator("button.anatomy-button", { hasText: "Reset" }).click();
    await expect(flow).toHaveAttribute("stroke-dashoffset", "0");
  });

  test("clicking a part opens the info panel with group, floor and description", async ({ page }) => {
    const arch = await openCutaway(page);
    // The near-side office cluster overlaps other parts on screen (stacked
    // floors, its own faces), so find a point that actually hit-tests to it
    // and send a real mouse click there — exactly what a user would do.
    await arch.locator('[data-part="f4__office-b"]').scrollIntoViewIfNeeded();
    const point = await arch.evaluate((el) => {
      const office = el.querySelector('[data-part="f4__office-b"]');
      if (!office) return null;
      const box = office.getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.85], [0.5, 0.7], [0.3, 0.8], [0.7, 0.8], [0.5, 0.5], [0.5, 0.3]] as const) {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest("[data-part]")?.getAttribute("data-part") === "f4__office-b") return { x, y };
      }
      return null;
    });
    if (!point) throw new Error("no visible office-b surface found to click");
    await page.mouse.click(point.x, point.y);
    const panel = arch.locator("[data-anatomy-info]");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Office cluster B");
    await expect(panel).toContainText("Level 4");
    await expect(panel).toContainText("authored once, instantiated per level");
    await expect(panel.locator("button", { hasText: "refine" })).toBeVisible();
    await page.mouse.click(5, 5); // click outside clears the selection
    await expect(panel).toBeHidden();
  });

  test("wheel zooms the viewport and reset restores the original view", async ({ page }) => {
    const arch = await openCutaway(page);
    const viewport = arch.locator("[data-viewport]");
    await expect(viewport).not.toHaveAttribute("transform");
    await arch.locator("svg.anatomy-svg").hover();
    await page.mouse.wheel(0, -400);
    // Zoom-in factor is exp(0.0015 × effective deltaY); Windows display
    // scaling (125% on this machine) multiplies the wheel delta, so the
    // factor can exceed 2 — assert direction (k ≥ 1), not the exact decade.
    await expect(viewport).toHaveAttribute("transform", /scale\([1-9]/);
    await arch.locator("button.anatomy-button", { hasText: "Reset" }).click();
    await expect(viewport).not.toHaveAttribute("transform");
  });

  test("engine buttons explode the roof and restore collapses it back", async ({ page }) => {
    const arch = await openCutaway(page);
    await expect(arch.locator('[data-part="chiller"]')).not.toHaveAttribute("transform");
    await arch.locator("button.anatomy-button", { hasText: "Explode" }).click();
    await expect(arch.locator('[data-part="chiller"]')).toHaveAttribute("transform", /translate\(/);
    await arch.locator("button.anatomy-button", { hasText: "Restore" }).click();
    await expect(arch.locator('[data-part="chiller"]')).not.toHaveAttribute("transform");
  });

  test("collapsible layer sections group the toggles", async ({ page }) => {
    const arch = await openCutaway(page);
    await expect(arch.locator("details.anatomy-section summary", { hasText: "Services" })).toBeVisible();
    await expect(arch.locator("details.anatomy-section", { hasText: "HVAC" }).locator("button.anatomy-toggle")).toHaveCount(3);
  });

  test("fullscreen control is offered on the toolbar", async ({ page }) => {
    const arch = await openCutaway(page);
    await expect(arch.locator('[data-testid="anatomy-fullscreen"]')).toBeVisible();
  });

  test("reduced motion keeps the cutaway static but fully usable", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const arch = await openCutaway(page);
    const flow = arch.locator('[data-flow="flow-energy"]');
    await arch.locator("button.anatomy-button", { hasText: "Play flows" }).click();
    await page.waitForTimeout(300);
    await expect(flow).toHaveAttribute("stroke-dashoffset", "0"); // no motion under reduced-motion
    await arch.locator("select").first().selectOption("f2");
    await expect(arch.locator('[data-part="f5__plate"]')).toHaveAttribute("opacity", "0.12");
  });
});
