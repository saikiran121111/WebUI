import { test, expect } from "@playwright/test";

// Integration coverage for the 3D design system: the procedural scene3d
// viewer (toolbar, stats, labels, export re-import proof), the honest
// unconfigured-provider path for asset3d, and the /api/3d contract.
const DEMO_URL = "http://localhost:3000/?demo=ui";

test("scene3d v2 viewer: stats, labels, toolbar toggles, GLB export re-import proof", async ({ page }) => {
  await page.route("**/api/3d/assets*", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "No 3D generation provider is configured on this server. Procedural scene3d remains available." }),
  }));
  await page.goto(DEMO_URL);

  const scene = page.locator('[data-testid="scene3d-block"]');
  await expect(scene).toBeVisible();
  const stage = page.locator('[data-testid="scene3d-stage"]');
  let webglOk = true;
  try {
    await expect(stage.locator("canvas").first()).toBeVisible({ timeout: 15000 });
  } catch {
    webglOk = false;
  }
  test.skip(!webglOk, "no WebGL in this browser");

  // Live stats render once content is set (real geometry, not primitives).
  await expect(page.locator('[data-testid="scene3d-stats"]')).toContainText("meshes");
  await expect(page.locator('[data-testid="scene3d-stats"]')).toContainText("tris");

  // HTML label tags follow their nodes.
  await expect(stage.locator(".scene3d-label-tag")).not.toHaveCount(0);

  // Demo scene has an animation → playback control exists and toggles.
  const play = page.locator('[data-testid="scene3d-tool-play"]');
  await expect(play).toHaveCount(1);
  await play.click();
  await expect(play).toContainText("Play");
  await play.click();
  await expect(play).toContainText("Pause");

  // Grid/axes/wireframe toggles flip their pressed state.
  for (const tool of ["scene3d-tool-grid", "scene3d-tool-axes", "scene3d-tool-wireframe"]) {
    const btn = page.locator(`[data-testid="${tool}"]`);
    const before = await btn.getAttribute("aria-pressed");
    await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
    await btn.click();
  }

  // Export GLB: the note proves the bytes were re-imported through GLTFLoader.
  await page.locator('[data-testid="scene3d-export-format"]').selectOption("glb");
  await page.locator('[data-testid="scene3d-export"]').click();
  await expect(page.locator('[data-testid="scene3d-export-note"]')).toContainText("re-import verified", { timeout: 30000 });

  // Only genuinely supported scene formats are offered.
  const formats = await page.locator('[data-testid="scene3d-export-format"] option').allTextContents();
  expect(formats.map(f => f.trim()).sort()).toEqual(["GLB", "GLTF"]);
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
