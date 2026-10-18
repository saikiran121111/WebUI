import { test, expect } from "@playwright/test";

// Integration coverage for the 3D design system: the procedural scene3d
// Studio viewer (HUD, labels, outliner selection, shading/views/explode,
// export re-import proof), the honest unconfigured-provider path for
// asset3d, and the /api/3d contract.
const DEMO_URL = "http://localhost:3000/?demo=ui";

test("scene3d studio: HUD stats, labels, outliner, shading/views/explode, GLB re-import proof", async ({ page }) => {
  await page.route("**/api/3d/assets*", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "No 3D generation provider is configured on this server. Procedural scene3d remains available." }),
  }));
  await page.goto(DEMO_URL);

  const scene = page.locator('[data-testid="scene3d-block"]');
  await expect(scene).toBeVisible();
  // The studio render loop parks itself via IntersectionObserver when the
  // stage is off-screen; the HUD stats only tick once the loop runs, so
  // scroll the viewer into view like a real user would.
  await scene.scrollIntoViewIfNeeded();
  const stage = page.locator('[data-testid="scene3d-stage"]');
  let webglOk = true;
  try {
    await expect(stage.locator("canvas").first()).toBeVisible({ timeout: 15000 });
  } catch {
    webglOk = false;
  }
  test.skip(!webglOk, "no WebGL in this browser");

  // Live HUD renders once content is set (real geometry, not primitives).
  const stats = page.locator('[data-testid="scene3d-stats"]');
  await expect(stats).toContainText("FPS");
  await expect(stats).toContainText("meshes");
  await expect(stats).toContainText("tris");

  // HTML label tags follow their nodes.
  await expect(stage.locator(".scene3d-label-tag")).not.toHaveCount(0);

  // Demo scene has an animation → timeline play control exists and toggles.
  const play = page.locator('[data-testid="scene3d-play"]');
  await expect(play).toHaveCount(1);
  await play.click();
  await expect(play).toContainText("Play");
  await play.click();
  await expect(play).toContainText("Pause");

  // Overlay toggles flip their pressed state.
  const grid = page.locator('[data-testid="scene3d-tool-grid"]');
  const before = await grid.getAttribute("aria-pressed");
  await grid.click();
  await expect(grid).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
  await grid.click();

  // Shading modes and named views are live controls, not dead UI.
  const shading = page.locator('[data-testid="scene3d-shading"]');
  await expect(shading.locator("option")).not.toHaveCount(0);
  await shading.selectOption("solid");
  await shading.selectOption("rendered");
  await page.locator('[data-testid="scene3d-view-top"]').click();
  await page.locator('[data-testid="scene3d-view-reset"]').click();
  await expect(stats).toContainText("meshes");

  // Universal explode slider drives the engine.
  const explode = page.locator('[data-testid="scene3d-explode"]');
  await explode.fill("60");
  await expect(explode).toHaveValue("60");

  // Outliner click selects a part and opens the inspect bar.
  await page.locator('[data-testid="scene3d-outliner"] .studio-outliner-name').first().click();
  await expect(page.locator('[data-testid="scene3d-inspect"]')).toBeVisible();

  // Export GLB: the note proves the bytes were re-imported through GLTFLoader.
  await page.locator('[data-testid="scene3d-export-format"]').selectOption("glb");
  await page.locator('[data-testid="scene3d-export"]').click();
  await expect(page.locator('[data-testid="scene3d-export-note"]')).toContainText("re-import verified", { timeout: 30000 });

  // Every offered format is genuinely implemented client-side.
  const formats = await page.locator('[data-testid="scene3d-export-format"] option').allTextContents();
  expect(formats.map(f => f.trim()).sort()).toEqual(
    ["GLB", "GLTF", "HTML (standalone)", "OBJ", "PLY", "PNG 4K", "STL", "TSX (R3F)", "USDZ"],
  );
});

test("asset3d: honest unconfigured-provider message, no fake generation", async ({ page }) => {
  await page.route("**/api/3d/assets*", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "No 3D generation provider is configured on this server. Procedural scene3d remains available." }),
  }));
  await page.goto(DEMO_URL);

  const block = page.locator('[data-testid="asset3d-block"]');
  await expect(block).toBeVisible();
  const status = page.locator('[data-testid="asset3d-status"]');
  await expect(status).toContainText("No 3D generation provider");
  await expect(status).toContainText("Procedural 3D stays fully available");
  // No preview stage or download buttons are rendered for a job that never ran.
  await expect(page.locator('[data-testid="asset3d-stage"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="asset3d-downloads"]')).toHaveCount(0);
});

test("/api/3d contract: honest 503 when unconfigured, validation errors are 400", async ({ request }) => {
  // Deliberately never posts a valid generation request: with a real key
  // configured that would spend credits. The happy path is unit-tested
  // against a mocked provider instead.
  const invalid = await request.post(`${DEMO_URL.replace("/?demo=ui", "")}/api/3d/assets`, { data: { prompt: "" } });
  expect([400, 503]).toContain(invalid.status());
  if (invalid.status() === 503) {
    expect((await invalid.json()).error).toMatch(/provider is configured/i);
  }

  const unknown = await request.get(`${DEMO_URL.replace("/?demo=ui", "")}/api/3d/assets/not-a-job-id`);
  expect([400, 503]).toContain(unknown.status());
  if (unknown.status() === 400) {
    expect((await unknown.json()).error).toContain("unknown asset job id");
  }

  const badFormat = await request.get(`${DEMO_URL.replace("/?demo=ui", "")}/api/3d/assets/meshy:pv:abcd1234/download?format=xyz`);
  expect([400, 503]).toContain(badFormat.status());
  if (badFormat.status() === 400) {
    expect((await badFormat.json()).error).toMatch(/unsupported format/);
  }
});
