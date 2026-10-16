import { test, expect, type Download, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildAetherionSpec } from "./helpers/aetherion";

// Export correctness (milestone requirement 7): the downloaded standalone
// artifacts must keep the interactive runtime alive, and the static ones must
// be honest, useful files. Everything runs against the built `next start`.
const ANATOMY_URL = "http://localhost:3000/?demo=anatomy";
const EXPORT_DIR = path.join(process.cwd(), ".data", "exports");

async function downloadFor(block: import("@playwright/test").Locator, testId: string): Promise<Download> {
  return Promise.all([block.page().waitForEvent("download"), block.locator(`[data-testid="${testId}"]`).click()]).then(([d]) => d);
}

async function openCutaway(page: Page) {
  await page.goto(ANATOMY_URL);
  const arch = page.locator('[data-testid="anatomy-block"]').nth(4);
  await expect(arch.locator('[data-part="f6__plate"]')).toBeVisible({ timeout: 20000 });
  return arch;
}

test.describe("Anatomy export correctness", () => {
  test.beforeAll(() => fs.mkdirSync(EXPORT_DIR, { recursive: true }));

  test("standalone HTML export keeps layers, floors, flows and inspection live", async ({ page }) => {
    const arch = await openCutaway(page);
    const download = await downloadFor(arch, "anatomy-download-html");
    expect(download.suggestedFilename()).toBe("service-core-cutaway.html");
    const file = path.join(EXPORT_DIR, download.suggestedFilename());
    await download.saveAs(file);

    await page.goto(pathToFileURL(file).href);
    await expect(page.locator("svg.anatomy-svg")).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-part="f6__plate"]')).toBeVisible();

    // layer toggle
    await expect(page.locator('[data-part="col1"]')).toBeVisible();
    await page.locator("button.anatomy-toggle", { hasText: "Facade" }).click();
    await expect(page.locator('[data-part="col1"]')).toBeHidden();
    // floor navigation
    await page.locator("select").first().selectOption("f3");
    await expect(page.locator('[data-part="f1__plate"]')).toHaveAttribute("opacity", "0.12");
    // flow animation along the connection route
    const flow = page.locator('[data-flow="flow-energy"]');
    await page.locator("button.anatomy-button", { hasText: "Play flows" }).click();
    await page.waitForTimeout(350);
    const first = Number(await flow.getAttribute("stroke-dashoffset"));
    await page.waitForTimeout(350);
    expect(Number(await flow.getAttribute("stroke-dashoffset"))).toBeLessThan(first);
    // component inspection: click the chiller plant on the open roof
    const point = await page.evaluate(() => {
      const part = document.querySelector('[data-part="chiller"]');
      if (!part) return null;
      const box = part.getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.3], [0.3, 0.5], [0.7, 0.5], [0.5, 0.7]] as const) {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        if (document.elementFromPoint(x, y)?.closest("[data-part]")?.getAttribute("data-part") === "chiller") return { x, y };
      }
      return null;
    });
    if (!point) throw new Error("no clickable chiller surface in the exported page");
    await page.mouse.click(point.x, point.y);
    await expect(page.locator("[data-anatomy-info]")).toContainText("Chiller plant");
  });

  test("SVG export is a useful static illustration, not a dead fragment", async ({ page }) => {
    const arch = await openCutaway(page);
    const download = await downloadFor(arch, "anatomy-download-svg");
    const file = path.join(EXPORT_DIR, download.suggestedFilename());
    await download.saveAs(file);
    const svg = fs.readFileSync(file, "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("<style"); // kit stylesheet embedded: renders standalone
    expect(svg).toContain('data-part="f6__plate"');
    expect(svg).toContain("anatomy-connection"); // flow routes visible statically
    expect(svg).not.toContain("<script"); // static by design — no fake interactivity
  });

  test("PNG export rasterizes a real 2x preview", async ({ page }) => {
    const arch = await openCutaway(page);
    const download = await downloadFor(arch, "anatomy-download-png");
    const file = path.join(EXPORT_DIR, download.suggestedFilename());
    await download.saveAs(file);
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(bytes.length).toBeGreaterThan(20000);
    // IHDR dimensions: the figure itself rasterized at 2x, not a stray icon svg.
    expect(bytes.readUInt32BE(16)).toBe(1280);
    expect(bytes.readUInt32BE(20)).toBe(1040);
  });

  test("TSX export is a functional component wired to the live engine", async ({ page }) => {
    const arch = await openCutaway(page);
    const download = await downloadFor(arch, "anatomy-download-tsx");
    const file = path.join(EXPORT_DIR, download.suggestedFilename());
    await download.saveAs(file);
    const tsx = fs.readFileSync(file, "utf8");
    expect(tsx).toContain('"use client"');
    expect(tsx).toContain("mountAnatomyLive");
    expect(tsx).toContain("PLATE_HTML");
    // The plate HTML is embedded as a JS string literal, so its quotes are escaped.
    expect(tsx).toContain('data-part=\\"f6__plate\\"');
    expect(tsx).toContain("LIVE_SPEC");
  });

  test("AETHERION-scale figure exports through the API and runs standalone", async ({ page, request }) => {
    const res = await request.post("http://localhost:3000/api/anatomy/export", {
      data: { spec: buildAetherionSpec(), theme: "dark", kind: "html" },
    });
    expect(res.ok()).toBe(true);
    const file = path.join(EXPORT_DIR, "aetherion-stress.html");
    fs.writeFileSync(file, await res.text());

    await page.goto(pathToFileURL(file).href);
    await expect(page.locator("svg.anatomy-svg")).toBeVisible({ timeout: 20000 });
    expect(await page.locator("[data-part]").count()).toBe(497);

    // layer toggle over 117 repeated facade fins
    await expect(page.locator('[data-part="fin1"]')).toBeVisible();
    await page.locator("button.anatomy-toggle", { hasText: "Facade" }).click();
    await expect(page.locator('[data-part="fin1"]')).toBeHidden();
    // system isolation across module instances
    await page.locator("select").nth(1).selectOption("water");
    await expect(page.locator('[data-part="hvac-trunk-a"]')).toHaveAttribute("opacity", "0.12");
    await expect(page.locator('[data-part="water-riser-a"]')).not.toHaveAttribute("opacity");
    // flows animate on a 497-part page
    const flow = page.locator('[data-flow="flow-energy-a"]');
    await page.locator("button.anatomy-button", { hasText: "Play flows" }).click();
    await page.waitForTimeout(350);
    const first = Number(await flow.getAttribute("stroke-dashoffset"));
    await page.waitForTimeout(350);
    expect(Number(await flow.getAttribute("stroke-dashoffset"))).toBeLessThan(first);
    // exploded transition on the crown
    await page.locator("button.anatomy-button", { hasText: "Explode" }).click();
    await expect(page.locator('[data-part="chiller"]')).toHaveAttribute("transform", /translate\(/);
  });
});
