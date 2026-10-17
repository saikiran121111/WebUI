import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

// ── Visible (--headed) end-to-end proof for the two studio viewers ──────────
// Case 1: ThreeStudioViewer from a ```threejs chat fence — canvas must render
// real multi-colored pixels and every toolbar control must mutate the LIVE
// Three.js scene (read through window.__studioViewer, never React state).
// Case 2: ArchitectureCadViewer from a ```cad chat fence — layers, themes,
// view modes, drafting tools and real downloads.

const DRONE_PROMPT =
  "Create a 3D Cyberpunk Hover Drone in Three.js with 4 named parts: a central fuselage body ('Drone_Body'), " +
  "a glowing front scanner eye ('Scanner_Eye'), a left thruster ring ('Left_Thruster'), and a right thruster " +
  "ring ('Right_Thruster'). Add gentle hover bobbing and spinning thrusters.";

const DRONE_CODE = [
  "const bodyMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.85, roughness: 0.3 });",
  "const body = new THREE.Mesh(new THREE.SphereGeometry(0.9, 32, 24), bodyMat);",
  "body.name = 'Drone_Body'; body.scale.set(1.5, 0.55, 1.0); root.add(body);",
  "const eye = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), new THREE.MeshStandardMaterial({ color: 0x0ea5e9, emissive: 0x38bdf8, emissiveIntensity: 2.4, metalness: 0.2, roughness: 0.25 }));",
  "eye.name = 'Scanner_Eye'; eye.position.set(1.3, 0.15, 0); root.add(eye);",
  "const ringMat = new THREE.MeshStandardMaterial({ color: 0xf97316, metalness: 0.55, roughness: 0.4, emissive: 0x9a3412, emissiveIntensity: 0.5 });",
  "const leftRing = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.15, 16, 40), ringMat);",
  "leftRing.name = 'Left_Thruster'; leftRing.position.set(0.1, 0, 1.25); root.add(leftRing);",
  "const rightRing = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.15, 16, 40), ringMat.clone());",
  "rightRing.name = 'Right_Thruster'; rightRing.position.set(0.1, 0, -1.25); root.add(rightRing);",
  "const armGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.3, 12);",
  "const armMat = new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.9, roughness: 0.35 });",
  "const armL = new THREE.Mesh(armGeo, armMat); armL.rotation.x = Math.PI / 2; armL.position.set(0.1, 0, 0.65); root.add(armL);",
  "const armR = new THREE.Mesh(armGeo, armMat); armR.rotation.x = Math.PI / 2; armR.position.set(0.1, 0, -0.65); root.add(armR);",
  "function onUpdate(delta, elapsed) {",
  "  body.position.y = Math.sin(elapsed * 2) * 0.15;",
  "  leftRing.rotation.z += delta * 6;",
  "  rightRing.rotation.z -= delta * 6;",
  "}",
].join("\n");

const KIOSK_PROMPT =
  "Create a 2D architectural CAD blueprint for a Modern Tech Coffee Kiosk (8m x 6m) with 4 zones: Espresso Bar, " +
  "Customer Seating Area, Pastry Display Counter, and Storage Room. Include semantic CAD layers for structural " +
  "walls, doors/windows, furniture/counters, MEP plumbing, and dimension lines.";

const KIOSK_SPEC = {
  title: "Modern Tech Coffee Kiosk",
  units: "m",
  scale: { ratio: 100 },
  layers: [
    { id: "layer-structural", name: "Structural Walls", color: "#f87171", group: "shell" },
    { id: "layer-architectural", name: "Doors / Windows", color: "#fbbf24", group: "shell", lineType: "dashed" },
    { id: "layer-furniture", name: "Furniture / Counters", color: "#34d399" },
    { id: "layer-mep", name: "MEP Plumbing", color: "#38bdf8", lineType: "dotted" },
    { id: "layer-dimensions", name: "Dimension Lines", color: "#94a3b8" },
    { id: "layer-annotations", name: "Annotations", color: "#e2e8f0" },
  ],
  entities: [
    { kind: "line", layer: "layer-architectural", from: [3.2, 0], to: [4.8, 0] },
    { kind: "line", layer: "layer-architectural", from: [8, 2.2], to: [8, 3.8] },
    { kind: "rect", layer: "layer-furniture", x: 1, y: 3.6, w: 2.4, h: 0.8, filled: true },
    { kind: "rect", layer: "layer-furniture", x: 4.6, y: 3.4, w: 2.2, h: 1.6, filled: true },
    { kind: "rect", layer: "layer-furniture", x: 1, y: 0.8, w: 2, h: 0.7, filled: true },
    { kind: "rect", layer: "layer-furniture", x: 5.6, y: 0.6, w: 1.8, h: 1.4, filled: true },
    { kind: "line", layer: "layer-mep", from: [1.4, 4.4], to: [1.4, 1.2] },
    { kind: "line", layer: "layer-mep", from: [1.4, 1.2], to: [3.6, 1.2] },
    { kind: "line", layer: "layer-dimensions", from: [0, -0.6], to: [8, -0.6] },
    { kind: "line", layer: "layer-dimensions", from: [-0.6, 0], to: [-0.6, 6] },
    { kind: "text", layer: "layer-annotations", x: 2.2, y: 4.6, content: "ESPRESSO BAR", height: 0.3, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 5.7, y: 4.6, content: "CUSTOMER SEATING AREA", height: 0.3, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 2, y: 1.9, content: "PASTRY DISPLAY COUNTER", height: 0.3, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 6.5, y: 1.9, content: "STORAGE ROOM", height: 0.3, anchor: "middle" },
    { kind: "text", layer: "layer-dimensions", x: 4, y: -0.9, content: "8.00 m", height: 0.28, anchor: "middle" },
  ],
  walls: [
    { id: "wall-envelope", layer: "layer-structural", path: [[0, 0], [8, 0], [8, 6], [0, 6]], closed: true, height: 3, thickness: 0.2 },
    { id: "wall-partition-a", layer: "layer-structural", path: [[4.2, 6], [4.2, 3]], height: 3, thickness: 0.15 },
    { id: "wall-partition-b", layer: "layer-structural", path: [[0, 2.8], [8, 2.8]], height: 3, thickness: 0.15 },
  ],
  slabs: [{ id: "slab-floor", layer: "layer-structural", outline: [[0, 0], [8, 0], [8, 6], [0, 6]], z: 0, thickness: 0.15 }],
  titleBlock: { projectName: "Modern Tech Coffee Kiosk", sheetTitle: "Floor Plan", scaleLabel: "1:100", date: "2026-10-17", author: "WebUI Studio", sheetNumber: "A-101" },
  defaultView: "2d",
  export: { filename: "coffee-kiosk" },
};

// ── helpers ──────────────────────────────────────────────────────────────────

function sseFrames(content: string): string {
  const chunks = content.match(/[\s\S]{1,400}/g) ?? [];
  let frames = "";
  for (const chunk of chunks) frames += `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
  frames += `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;
  frames += "data: [DONE]\n\n";
  return frames;
}

async function mockChat(page: Page, fenceLang: string, body: string) {
  const content = `Here is your build.\n\n\`\`\`${fenceLang}\n${body}\n\`\`\`\n\nEvery control in the viewer is wired live into the scene.`;
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: sseFrames(content) }),
  );
}

async function step(page: Page, text: string) {
  await page.evaluate((t) => {
    let banner = document.querySelector("#pw-live-step-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "pw-live-step-banner";
      banner.setAttribute(
        "style",
        "position:fixed;top:0;left:0;right:0;z-index:999999;background:#0b1020;color:#38BDF8;" +
          "font:700 16px/1.5 system-ui;padding:10px 18px;border-bottom:2px solid #38BDF8;pointer-events:none;",
      );
      document.body.appendChild(banner);
    }
    banner.textContent = t;
  }, text);
  await page.waitForTimeout(300);
}

async function sendPrompt(page: Page, prompt: string) {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(prompt);
  await page.locator('[data-testid="send-button"]').click();
}

async function setRange(page: Page, testId: string, value: string) {
  await page.locator(`[data-testid="${testId}"]`).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

interface Probe { w: number; h: number; colors: number; litRatio: number; variedRatio: number }

async function canvasProbe(page: Page, selector: string): Promise<Probe> {
  return page.evaluate(async (sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas) throw new Error(`no canvas for ${sel}`);
    // Force a synchronous render right before the readback: the rAF loop already
    // renders every frame, but the GL backbuffer may be cleared between composites.
    const studio = (window as any).__studioViewer;
    if (studio && studio.renderer?.domElement === canvas) studio.renderer.render(studio.scene, studio.activeCamera);
    const url = canvas.toDataURL("image/png");
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("decode")); img.src = url; });
    const w = canvas.width, h = canvas.height;
    const scratch = document.createElement("canvas");
    scratch.width = w; scratch.height = h;
    const ctx = scratch.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const buckets = new Set<string>();
    let lit = 0, varied = 0, samples = 0;
    const firstR = data[0], firstG = data[1], firstB = data[2];
    for (let i = 0; i < data.length; i += 4 * 53) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      buckets.add(`${r >> 4}-${g >> 4}-${b >> 4}`);
      if (r + g + b > 120) lit++; // #0b1020 bg sums to 59, so this counts lit scene pixels only
      if (Math.abs(r - firstR) + Math.abs(g - firstG) + Math.abs(b - firstB) > 24) varied++;
      samples++;
    }
    return { w, h, colors: buckets.size, litRatio: lit / samples, variedRatio: varied / samples };
  }, selector);
}

function expectRealRender(probe: Probe, label: string, minSize = 300) {
  expect(probe.w, `${label}: canvas width`).toBeGreaterThan(minSize);
  expect(probe.h, `${label}: canvas height`).toBeGreaterThan(minSize);
  expect(probe.colors, `${label}: canvas is solid black / uniform — expected multi-colored pixels`).toBeGreaterThanOrEqual(6);
  // A wide 520px stage frames the model with margin, so lit geometry covering >1.5%
  // of pixels (plus >=6 color buckets) proves a real render; solid black gives 0.
  expect(probe.variedRatio, `${label}: canvas is uniform background — scene not rendering`).toBeGreaterThan(0.015);
}

async function downloadText(page: Page, formatTestId: string, format: string, exportTestId: string): Promise<string> {
  await page.selectOption(`[data-testid="${formatTestId}"]`, format);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click(`[data-testid="${exportTestId}"]`)]);
  const path = await download.path();
  expect(path, `download ${format} produced a file`).not.toBeNull();
  expect(fs.statSync(path!).size, `${format} file is not empty`).toBeGreaterThan(100);
  return fs.readFileSync(path!, "utf8");
}

// ── Case 1: ThreeStudioViewer ────────────────────────────────────────────────

test.describe("ThreeStudioViewer live scene (visible)", () => {
  test("cyberpunk hover drone renders pixels and every control mutates the live scene", async ({ page }) => {
    test.setTimeout(180000);
    await mockChat(page, "threejs", DRONE_CODE);
    await page.goto("http://localhost:3000/");
    await step(page, "🧪 TESTING: Submitting the Cyberpunk Hover Drone prompt to the chat...");
    await sendPrompt(page, DRONE_PROMPT);
    await expect(page.locator('[data-testid="scene3d-stage"]')).toBeVisible({ timeout: 40000 });
    await expect(page.locator('[data-testid="threejs-code-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scene3d-stats"]')).toContainText("meshes");

    await step(page, "🧪 TESTING: Inspecting live canvas pixels — canvas must NOT be solid black...");
    await page.waitForTimeout(1200); // let a few frames render
    const firstProbe = await canvasProbe(page, ".scene3d-stage canvas");
    expectRealRender(firstProbe, "initial render");
    await page.locator(".scene3d-stage canvas").screenshot({ path: "test-results/canvas-proof.png" });

    await step(page, "🧪 TESTING: Switching 3D Viewport shading Wireframe → Normals → Solid → X-Ray → Rendered...");
    const shadingSignatures: string[] = [JSON.stringify(firstProbe)];
    for (const mode of ["wireframe", "normals", "solid", "xray", "rendered"]) {
      await page.selectOption('[data-testid="scene3d-shading"]', mode);
      await page.waitForTimeout(700);
      const probe = await canvasProbe(page, ".scene3d-stage canvas");
      expectRealRender(probe, `shading=${mode}`);
      const signature = JSON.stringify([probe.colors, probe.litRatio, probe.variedRatio]);
      expect(signature, `shading=${mode} must visibly change the pixels`).not.toBe(shadingSignatures[shadingSignatures.length - 1]);
      shadingSignatures.push(signature);
    }

    await step(page, "🧪 TESTING: Clicking view presets Front / Top / Iso / Frame(F) and dragging the FOV slider...");
    for (const view of ["front", "top", "iso"]) {
      await page.click(`[data-testid="scene3d-view-${view}"]`);
      await page.waitForTimeout(400);
    }
    await page.click('[data-testid="scene3d-view-frame"]');
    await setRange(page, "scene3d-fov", "70");
    const fovNow = await page.evaluate(() => (window as any).__studioViewer.activeCamera.fov);
    expect(Math.round(fovNow)).toBe(70);
    await page.selectOption('[data-testid="scene3d-projection"]', "orthographic");
    const camType = await page.evaluate(() => (window as any).__studioViewer.activeCamera.type);
    expect(camType).toBe("OrthographicCamera");
    await page.selectOption('[data-testid="scene3d-projection"]', "perspective");

    await step(page, "🧪 TESTING: Selecting Drone_Body in the Outliner, attaching Move / Rotate / Scale gizmos...");
    await page.click('[data-testid="scene3d-outliner-Drone_Body"]');
    await page.click('[data-testid="scene3d-transform-translate"]');
    let gizmo: { mode: string | null; attached?: string | null; selected?: string | null } = await page.evaluate(() => {
      const v = (window as any).__studioViewer;
      return { mode: v.getTransformMode(), attached: v.transformControls.object?.name ?? null, selected: v.getSelected() };
    });
    expect(gizmo.mode).toBe("translate");
    expect(gizmo.selected).toBe("Drone_Body");
    expect(gizmo.attached, "gizmo must be attached to the selected mesh in the live scene").toBe("Drone_Body");
    await page.click('[data-testid="scene3d-transform-rotate"]');
    gizmo = await page.evaluate(() => ({ mode: (window as any).__studioViewer.getTransformMode() }));
    expect(gizmo.mode).toBe("rotate");
    await page.click('[data-testid="scene3d-transform-scale"]');
    gizmo = await page.evaluate(() => ({ mode: (window as any).__studioViewer.getTransformMode() }));
    expect(gizmo.mode).toBe("scale");
    await page.click('[data-testid="scene3d-transform-scale"]'); // click active again → toggle OFF
    gizmo = await page.evaluate(() => ({ mode: (window as any).__studioViewer.getTransformMode(), attached: (window as any).__studioViewer.transformControls.object?.name ?? null }));
    expect(gizmo.mode, "clicking the active transform mode again must detach the gizmo").toBeNull();
    expect(gizmo.attached).toBeNull();

    await step(page, "🧪 TESTING: Toggling Grid / Axes / Bounding box / Cage / Turntable overlays...");
    // The engine hides overlays via .visible (standard three.js practice), so
    // count only VISIBLE helpers — that proves the live scene really changed.
    const helperCount = (type: string) => page.evaluate((t) => {
      let n = 0;
      (window as any).__studioViewer.scene.traverse((o: any) => { if (o.type === t && o.visible) n++; });
      return n;
    }, type);
    expect(await helperCount("GridHelper"), "grid overlay ON").toBeGreaterThanOrEqual(1);
    await page.click('[data-testid="scene3d-tool-grid"]');
    expect(await helperCount("GridHelper"), "grid overlay OFF").toBe(0);
    await page.click('[data-testid="scene3d-tool-grid"]');
    await page.click('[data-testid="scene3d-tool-axes"]');
    expect(await helperCount("AxesHelper"), "axes overlay ON").toBeGreaterThanOrEqual(1);
    await page.click('[data-testid="scene3d-tool-axes"]');
    await page.click('[data-testid="scene3d-tool-bbox"]');
    await page.click('[data-testid="scene3d-tool-cage"]');
    await page.click('[data-testid="scene3d-autorotate"]');
    const autoRotateOn = await page.evaluate(() => (window as any).__studioViewer.controls.autoRotate);
    expect(autoRotateOn, "turntable must drive the live OrbitControls").toBe(true);
    await page.click('[data-testid="scene3d-autorotate"]');
    await page.click('[data-testid="scene3d-tool-bbox"]');
    await page.click('[data-testid="scene3d-tool-cage"]');

    await step(page, "🧪 TESTING: Toggling the Outliner Eye on Drone_Body and Solo-isolating it...");
    await page.click('[data-testid="scene3d-hide-Drone_Body"]');
    let hidden = await page.evaluate(() => {
      let mesh: any = null;
      (window as any).__studioViewer.scene.traverse((o: any) => { if (o.name === "Drone_Body") mesh = o; });
      return mesh?.visible ?? null;
    });
    expect(hidden, "Eye toggle must set mesh.visible=false in the live scene").toBe(false);
    await page.click('[data-testid="scene3d-hide-Drone_Body"]');
    hidden = await page.evaluate(() => {
      let mesh: any = null;
      (window as any).__studioViewer.scene.traverse((o: any) => { if (o.name === "Drone_Body") mesh = o; });
      return mesh?.visible ?? null;
    });
    expect(hidden).toBe(true);
    await page.click('[aria-label="Solo Drone_Body"]');
    const soloState = await page.evaluate(() => {
      const vis: Record<string, boolean> = {};
      (window as any).__studioViewer.scene.traverse((o: any) => { if (o.name && o.isMesh) vis[o.name] = o.visible; });
      return vis;
    });
    expect(soloState["Left_Thruster"], "Solo must hide the other meshes in the live scene").toBe(false);
    expect(soloState["Drone_Body"]).toBe(true);
    await page.click('[aria-label="Solo Drone_Body"]'); // un-solo
    const unsoloState = await page.evaluate(() => {
      const vis: Record<string, boolean> = {};
      (window as any).__studioViewer.scene.traverse((o: any) => { if (o.name && o.isMesh) vis[o.name] = o.visible; });
      return vis;
    });
    expect(unsoloState["Left_Thruster"]).toBe(true);

    await step(page, "🧪 TESTING: Driving Material Inspector sliders — live material updates on the mesh...");
    await page.locator('[data-testid="scene3d-material-metalness"]').evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "0.1"); el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator('[data-testid="scene3d-material-roughness"]').evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "0.9"); el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.check('[data-testid="scene3d-material-wireframe"]');
    const mat = await page.evaluate(() => (window as any).__studioViewer.getMaterial("Drone_Body"));
    expect(mat.metalness).toBeCloseTo(0.1, 2);
    expect(mat.roughness).toBeCloseTo(0.9, 2);
    expect(mat.wireframe, "wireframe checkbox must flip the live material").toBe(true);
    await page.uncheck('[data-testid="scene3d-material-wireframe"]');

    await step(page, "🧪 TESTING: Dragging Explode Slider to 80% and back to 0%...");
    const ringZ = () => page.evaluate(() => {
      const pos: Record<string, number> = {};
      (window as any).__studioViewer.scene.traverse((o: any) => {
        if (o.name === "Left_Thruster" || o.name === "Right_Thruster") pos[o.name] = o.getWorldPosition(new (window as any).__studioViewer.activeCamera.position.constructor()).z;
      });
      return pos;
    });
    const baseZ = await ringZ();
    await setRange(page, "scene3d-explode", "80");
    await page.waitForTimeout(400);
    const explodedZ = await ringZ();
    expect(Math.abs(explodedZ["Left_Thruster"]), "explode 80% must push Left_Thruster outward in the live scene")
      .toBeGreaterThan(Math.abs(baseZ["Left_Thruster"]) + 0.3);
    expect(Math.sign(explodedZ["Left_Thruster"])).toBe(Math.sign(baseZ["Left_Thruster"]));
    expect(Math.abs(explodedZ["Right_Thruster"])).toBeGreaterThan(Math.abs(baseZ["Right_Thruster"]) + 0.3);
    await setRange(page, "scene3d-explode", "0");
    await page.waitForTimeout(400);
    const restoredZ = await ringZ();
    expect(Math.abs(restoredZ["Left_Thruster"] - baseZ["Left_Thruster"]), "explode 0% must restore part positions").toBeLessThan(0.05);
    expect(Math.abs(restoredZ["Right_Thruster"] - baseZ["Right_Thruster"])).toBeLessThan(0.05);

    await step(page, "🧪 TESTING: Exporting GLB and OBJ — real non-empty downloads...");
    const glbText = await downloadText(page, "scene3d-export-format", "glb", "scene3d-export");
    expect(glbText.slice(0, 4)).toBe("glTF");
    await downloadText(page, "scene3d-export-format", "obj", "scene3d-export");
  });
});

// ── Case 2: ArchitectureCadViewer ────────────────────────────────────────────

test.describe("ArchitectureCadViewer live sheet (visible)", () => {
  test("coffee kiosk blueprint: layers, themes, view modes, drafting tools, exports", async ({ page }) => {
    test.setTimeout(180000);
    await mockChat(page, "cad", JSON.stringify(KIOSK_SPEC, null, 2));
    await page.goto("http://localhost:3000/");
    await step(page, "🧪 TESTING: Submitting the Modern Tech Coffee Kiosk CAD prompt to the chat...");
    await sendPrompt(page, KIOSK_PROMPT);
    await expect(page.locator('[data-testid="cad-viewer"]')).toBeVisible({ timeout: 40000 });
    await expect(page.locator('[data-testid="cad-stage"]')).toBeVisible();

    await step(page, "🧪 TESTING: Verifying the CAD canvas bbox and all 4 zone labels...");
    const stageBox = await page.locator('[data-testid="cad-stage"]').boundingBox();
    expect(stageBox && stageBox.width > 100 && stageBox.height > 100, "CAD canvas has a non-zero bbox").toBeTruthy();
    for (const zone of ["ESPRESSO BAR", "CUSTOMER SEATING AREA", "PASTRY DISPLAY COUNTER", "STORAGE ROOM"]) {
      await expect(page.locator('[data-testid="cad-stage"] text').filter({ hasText: zone }).first()).toBeVisible();
    }

    await step(page, "🧪 TESTING: Toggling AutoCAD Layer 'layer-furniture' OFF...");
    for (const layer of ["layer-furniture", "layer-mep", "layer-dimensions"]) {
      await page.click(`[data-testid="cad-hide-${layer}"]`);
      await expect(page.locator(`[data-testid="cad-stage"] [data-layer="${layer}"]`)).toHaveCount(0);
      await page.click(`[data-testid="cad-hide-${layer}"]`);
      await expect(page.locator(`[data-testid="cad-stage"] [data-layer="${layer}"]`)).toHaveCount(1);
    }
    await page.click('[data-testid="cad-solo-layer-structural"]');
    await expect(page.locator('[data-testid="cad-solo-clear"]')).toBeVisible();
    await expect(page.locator('[data-testid="cad-stage"] [data-layer="layer-furniture"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cad-stage"] [data-layer="layer-structural"]')).toHaveCount(1);
    await page.click('[data-testid="cad-solo-clear"]');

    await step(page, "🧪 TESTING: Switching view modes 2D → Isometric → 3D BIM → Split...");
    await page.click('[data-testid="cad-view-iso"]');
    await expect(page.locator('[data-testid="cad-iso-stage"] polygon').first()).toBeVisible();
    await page.click('[data-testid="cad-view-3d"]');
    await expect(page.locator('[data-testid="cad-3d"] canvas')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1200);
    const bimProbe = await canvasProbe(page, '[data-testid="cad-3d"] canvas');
    // The BIM pane sits between the layer dock and the controls dock, so its
    // width is ~284px at a 1280px viewport — still a real render, just smaller.
    expectRealRender(bimProbe, "CAD 3D BIM canvas", 240);
    await page.click('[data-testid="cad-view-split"]');
    await expect(page.locator('[data-testid="cad-stage"]')).toBeVisible();
    await expect(page.locator('[data-testid="cad-3d"] canvas')).toBeVisible();
    await page.click('[data-testid="cad-view-2d"]');

    await step(page, "🧪 TESTING: Applying sheet themes Cyanotype → White Plot Sheet → AutoCAD Dark...");
    const sheetBg = () => page.locator('[data-testid="cad-viewer"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.selectOption('[data-testid="cad-theme"]', "cyanotype");
    expect(await sheetBg()).toBe("rgb(10, 37, 64)");
    await page.selectOption('[data-testid="cad-theme"]', "white-plot");
    expect(await sheetBg()).toBe("rgb(255, 255, 255)");
    await page.selectOption('[data-testid="cad-theme"]', "autocad-dark");
    expect(await sheetBg()).toBe("rgb(9, 13, 22)");

    await step(page, "🧪 TESTING: Tape Measure — two clicks must draw a live dimension readout...");
    const stage = page.locator('[data-testid="cad-stage"]');
    await stage.scrollIntoViewIfNeeded();
    await page.click('[data-testid="cad-tool-measure"]');
    const box = (await stage.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.5);
    await expect(page.locator(".cad-measure text").first()).toHaveText(/\d+(\.\d+)?\s*(m|mm|ft)/);

    await step(page, "🧪 TESTING: Area tool — four corners must display m²...");
    await page.click('[data-testid="cad-tool-clear"]');
    await page.click('[data-testid="cad-tool-area"]');
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.7);
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7);
    await expect(page.locator('[data-testid="cad-area-finish"]')).toBeVisible({ timeout: 5000 });
    await page.click('[data-testid="cad-area-finish"]');
    await expect(page.locator(".cad-area text").first()).toContainText("m²");

    await step(page, "🧪 TESTING: Exporting .dxf and .svg — real non-empty downloads...");
    const dxf = await downloadText(page, "cad-export-format", "dxf", "cad-export");
    expect(dxf).toContain("SECTION");
    expect(dxf).toContain("ENTITIES");
    expect(dxf).toContain("LAYER");
    const svg = await downloadText(page, "cad-export-format", "svg", "cad-export");
    expect(svg).toContain("<svg");
  });
});
