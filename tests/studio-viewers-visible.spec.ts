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
    await page.click('[data-testid="cad-tool-measure"]');
    // Clicking the ribbon tool button scrolled the page (the shell top sits above
    // the viewport), pushing the stage's bbox midpoint onto the chat composer.
    // Re-center the stage AFTER arming the tool, then read the box.
    await stage.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const box = (await stage.boundingBox())!;
    // The layer/controls docks are absolute overlays — click the clear band
    // between them (never the outer 30% of the stage width).
    await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.5);
    await page.mouse.click(box.x + box.width * 0.58, box.y + box.height * 0.5);
    await expect(page.locator(".cad-measure text").first()).toHaveText(/\d+(\.\d+)?\s*(m|mm|ft)/);

    await step(page, "🧪 TESTING: Area tool — four corners must display m²...");
    await page.click('[data-testid="cad-tool-clear"]');
    await page.click('[data-testid="cad-tool-area"]');
    // The clear/area ribbon clicks re-scroll the chat container (the stage bbox
    // jumps ~270px), so the old box is stale — re-center and re-read it.
    await stage.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const abox = (await stage.boundingBox())!;
    await page.mouse.click(abox.x + abox.width * 0.42, abox.y + abox.height * 0.35);
    await page.mouse.click(abox.x + abox.width * 0.58, abox.y + abox.height * 0.35);
    await page.mouse.click(abox.x + abox.width * 0.58, abox.y + abox.height * 0.65);
    await page.mouse.click(abox.x + abox.width * 0.42, abox.y + abox.height * 0.65);
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

// ── Stress case 1: high-fidelity Three.js contract (12–25 named sub-meshes) ──

const MECHA_PROMPT =
  "Create a high-detail 3D Mecha Strike Helmet & Arc Core Bust in Three.js with at least 16 named articulated " +
  "parts: Upper_Crown, Brow_Plate, Left_Cheek_Armor, Right_Cheek_Armor, Jaw_Guard, Chin_Vent, Left_Optic_Visor " +
  "(glowing cyan), Right_Optic_Visor (glowing cyan), Forehead_Crest, Left_Ear_Comms_Pod, Right_Ear_Comms_Pod, " +
  "Neck_Hydraulic_Piston_L, Neck_Hydraulic_Piston_R, Chest_Arc_Reactor_Ring, Chest_Arc_Core (pulsing emissive), " +
  "and Shoulder_Pauldron_L/R. Add idle breathing motion, visor glow pulse, and full support for the 0-100% " +
  "Explode slider.";

const MECHA_CODE = [
  "const armor = new THREE.MeshStandardMaterial({ color: 0x42506b, metalness: 0.9, roughness: 0.32 });",
  "const dark = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.75, roughness: 0.45 });",
  "const glow = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, emissive: 0x38bdf8, emissiveIntensity: 2.4 });",
  "const edgeMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.5 });",
  "function part(geo, mat, name, x, y, z) { const m = new THREE.Mesh(geo, mat); m.name = name; m.position.set(x, y, z); m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), edgeMat)); root.add(m); return m; }",
  "const crown = part(new THREE.SphereGeometry(1, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.58), armor, 'Upper_Crown', 0, 0.3, 0);",
  "crown.scale.set(0.95, 0.95, 1.05);",
  "part(new THREE.BoxGeometry(1.5, 0.16, 0.45), armor, 'Brow_Plate', 0, 0.26, 0.8);",
  "const cheekShape = new THREE.Shape(); cheekShape.moveTo(-0.3, 0); cheekShape.lineTo(0.3, 0); cheekShape.lineTo(0.22, -0.55); cheekShape.lineTo(-0.24, -0.42); cheekShape.closePath();",
  "const cheekGeo = new THREE.ExtrudeGeometry(cheekShape, { depth: 0.12, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03 });",
  "part(cheekGeo, armor, 'Left_Cheek_Armor', 0.52, 0.02, 0.5);",
  "part(cheekGeo, armor, 'Right_Cheek_Armor', -0.52, 0.02, 0.5);",
  "part(new THREE.BoxGeometry(1.1, 0.3, 0.5), armor, 'Jaw_Guard', 0, -0.35, 0.55);",
  "part(new THREE.CylinderGeometry(0.16, 0.16, 0.5, 12), dark, 'Chin_Vent', 0, -0.55, 0.35);",
  "part(new THREE.SphereGeometry(0.16, 20, 14), glow, 'Left_Optic_Visor', 0.34, 0.05, 0.86);",
  "part(new THREE.SphereGeometry(0.16, 20, 14), glow, 'Right_Optic_Visor', -0.34, 0.05, 0.86);",
  "const crestShape = new THREE.Shape(); crestShape.moveTo(0, 0.5); crestShape.lineTo(0.18, 0); crestShape.lineTo(-0.18, 0); crestShape.closePath();",
  "part(new THREE.ExtrudeGeometry(crestShape, { depth: 0.1, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02 }), armor, 'Forehead_Crest', 0, 0.62, 0.55);",
  "const podPts = [[0.04, 0], [0.13, 0.06], [0.15, 0.2], [0.05, 0.26]].map((p) => new THREE.Vector2(p[0], p[1]));",
  "part(new THREE.LatheGeometry(podPts, 18), dark, 'Left_Ear_Comms_Pod', 0.98, 0.05, 0);",
  "part(new THREE.LatheGeometry(podPts, 18), dark, 'Right_Ear_Comms_Pod', -0.98, 0.05, 0);",
  "part(new THREE.CylinderGeometry(0.09, 0.13, 0.7, 14), armor, 'Neck_Hydraulic_Piston_L', 0.28, -0.85, -0.1);",
  "part(new THREE.CylinderGeometry(0.09, 0.13, 0.7, 14), armor, 'Neck_Hydraulic_Piston_R', -0.28, -0.85, -0.1);",
  "part(new THREE.TorusGeometry(0.5, 0.09, 14, 36), armor, 'Chest_Arc_Reactor_Ring', 0, -1.35, 0.55);",
  "part(new THREE.SphereGeometry(0.3, 24, 16), glow, 'Chest_Arc_Core', 0, -1.35, 0.55);",
  "const pauldronGeo = new THREE.SphereGeometry(0.55, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5);",
  "part(pauldronGeo, armor, 'Shoulder_Pauldron_L', 1.35, -0.95, 0);",
  "part(pauldronGeo, armor, 'Shoulder_Pauldron_R', -1.35, -0.95, 0);",
  "part(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, -0.6, -0.35), new THREE.Vector3(0, -1.2, -0.5), new THREE.Vector3(0, -1.8, -0.35)]), 24, 0.12, 10, false), dark, 'Spine_Support', 0, 0, 0);",
  "function onUpdate(delta, elapsed) {",
  "  const breathe = 1 + Math.sin(elapsed * 1.6) * 0.02;",
  "  root.scale.set(breathe, breathe, breathe);",
  "  glow.emissiveIntensity = 2.0 + Math.sin(elapsed * 3.2) * 0.9;",
  "}",
].join("\n");

test.describe("Stress: ThreeStudioViewer mecha bust fidelity (visible)", () => {
  test("17 named articulated parts, emissive visors, explode slider, ViewCube", async ({ page }) => {
    test.setTimeout(240000);
    await mockChat(page, "threejs", MECHA_CODE);
    await page.goto("http://localhost:3000/");
    await step(page, "🧪 STRESS: Submitting the Mecha Strike Helmet & Arc Core Bust prompt...");
    await sendPrompt(page, MECHA_PROMPT);
    await expect(page.locator('[data-testid="scene3d-stage"]')).toBeVisible({ timeout: 40000 });
    await expect(page.locator('[data-testid="threejs-code-error"]')).toHaveCount(0);

    await step(page, "🧪 STRESS: Counting named sub-meshes — the 3D contract demands 12–25 distinct parts...");
    const named = await page.evaluate(() => {
      const set = new Set<string>();
      (window as any).__studioViewer.scene.traverse((o: any) => { if (o.isMesh && o.name) set.add(o.name); });
      return [...set];
    });
    expect(named.length, "3D contract: at least 16 named meshes, no lazy 4-primitive toy").toBeGreaterThanOrEqual(16);
    for (const p of ["Upper_Crown", "Brow_Plate", "Left_Optic_Visor", "Right_Optic_Visor", "Chest_Arc_Core", "Shoulder_Pauldron_L", "Shoulder_Pauldron_R", "Neck_Hydraulic_Piston_L"]) {
      expect(named, `missing contract part ${p}`).toContain(p);
    }
    const geoTypes = await page.evaluate(() => {
      const s = new Set<string>();
      (window as any).__studioViewer.scene.traverse((o: any) => { if (o.isMesh && o.geometry?.type) s.add(o.geometry.type); });
      return [...s];
    });
    expect(geoTypes.length, "contract: real assets mix Extrude/Lathe/Tube/Torus/Cylinder geometries").toBeGreaterThanOrEqual(4);

    await step(page, "🧪 STRESS: Verifying emissive visor materials (glow pulse)...");
    const visorMat = await page.evaluate(() => {
      let m: any = null;
      (window as any).__studioViewer.scene.traverse((o: any) => { if (o.name === "Left_Optic_Visor") m = o.material; });
      return m ? { emissive: m.emissive?.getHex?.() ?? 0, emissiveIntensity: m.emissiveIntensity ?? 0 } : null;
    });
    expect(visorMat, "Left_Optic_Visor mesh must exist").not.toBeNull();
    expect(visorMat!.emissive, "visor must carry an emissive color").not.toBe(0);
    expect(visorMat!.emissiveIntensity, "visor emissiveIntensity >= 1.5").toBeGreaterThanOrEqual(1.5);

    await step(page, "🧪 STRESS: Canvas pixel probe — emissive bust must render real lit pixels...");
    await page.waitForTimeout(1200);
    expectRealRender(await canvasProbe(page, ".scene3d-stage canvas"), "mecha bust render");

    await step(page, "🧪 STRESS: Explode slider 0 → 100% → 0% pushes pauldrons away from the crown...");
    const partDist = () => page.evaluate(() => {
      const V = (window as any).__studioViewer.activeCamera.position.constructor;
      const p: Record<string, any> = {};
      (window as any).__studioViewer.scene.traverse((o: any) => {
        if (o.name === "Shoulder_Pauldron_L" || o.name === "Upper_Crown") p[o.name] = o.getWorldPosition(new V());
      });
      return Math.hypot(p.Shoulder_Pauldron_L.x - p.Upper_Crown.x, p.Shoulder_Pauldron_L.y - p.Upper_Crown.y, p.Shoulder_Pauldron_L.z - p.Upper_Crown.z);
    });
    const baseDist = await partDist();
    await setRange(page, "scene3d-explode", "100");
    await page.waitForTimeout(500);
    const explodedDist = await partDist();
    expect(explodedDist, "explode 100% must separate pauldron from crown").toBeGreaterThan(baseDist + 0.5);
    await setRange(page, "scene3d-explode", "0");
    await page.waitForTimeout(500);
    expect(Math.abs((await partDist()) - baseDist), "explode 0% must restore the bust").toBeLessThan(0.2);

    await step(page, "🧪 STRESS: ViewCube TOP / FRONT / RIGHT / ISO NE / ISO SW reposition the live camera...");
    const camPos = () => page.evaluate(() => { const c = (window as any).__studioViewer.activeCamera.position; return [c.x, c.y, c.z]; });
    let prev = await camPos();
    for (const dir of ["top", "front", "right", "iso-ne", "iso-sw"]) {
      await page.click(`[data-testid="scene3d-viewcube-${dir}"]`);
      await page.waitForTimeout(450);
      const now = await camPos();
      const moved = Math.hypot(now[0] - prev[0], now[1] - prev[1], now[2] - prev[2]);
      expect(moved, `ViewCube ${dir} must move the live camera`).toBeGreaterThan(0.5);
      prev = now;
    }
    expectRealRender(await canvasProbe(page, ".scene3d-stage canvas"), "mecha bust after ViewCube");
    await expect(page.locator('[data-testid="scene3d-stats"]')).toContainText("meshes");
  });
});

// ── Stress case 2: full architectural blueprint + BIM cutaway ────────────────

const LAB_PROMPT =
  "Create a complete architectural CAD blueprint and 3D isometric BIM cutaway for a 2-Level Sustainable " +
  "Innovation Lab & Executive Hub (18m x 12m) with 8 detailed zones: Double-Height Atrium Lobby, Glass " +
  "Conference Boardroom, Open AI Engineering Studio (with 8 desks), Espresso & Lounge Bar, Server & Quantum " +
  "Cooling Vault, Prototyping Workshop, Restroom Core, and Rooftop Solar Terrace with Staircase. Include full " +
  "structural column grids (A-D, 1-4), double-lined hatched walls, door swings, window mullions, detailed " +
  "furniture CAD blocks, MEP routing, and dimension chains.";

const LAB_SPEC = {
  title: "Sustainable Innovation Lab & Executive Hub",
  units: "m",
  scale: { ratio: 100 },
  layers: [
    { id: "layer-structural", name: "Structural Walls", color: "#e2e8f0", group: "shell" },
    { id: "layer-architectural", name: "Doors / Windows", color: "#38bdf8", group: "shell", lineType: "dashed" },
    { id: "layer-furniture", name: "Furniture / Equipment", color: "#94a3b8" },
    { id: "layer-mep", name: "MEP Routing", color: "#f59e0b", lineType: "dotted" },
    { id: "layer-dimensions", name: "Dimension Chains", color: "#64748b" },
    { id: "layer-annotations", name: "Annotations / Room Tags", color: "#cbd5e1" },
  ],
  entities: [
    // Room boundary polygons (drive room-tag pill placement)
    { kind: "polygon", layer: "layer-annotations", points: [[0, 8], [6, 8], [6, 12], [0, 12]] },
    { kind: "polygon", layer: "layer-annotations", points: [[6, 8], [12, 8], [12, 12], [6, 12]] },
    { kind: "polygon", layer: "layer-annotations", points: [[12, 8], [18, 8], [18, 12], [12, 12]] },
    { kind: "polygon", layer: "layer-annotations", points: [[0, 4], [6, 4], [6, 8], [0, 8]] },
    { kind: "polygon", layer: "layer-annotations", points: [[6, 4], [12, 4], [12, 8], [6, 8]] },
    { kind: "polygon", layer: "layer-annotations", points: [[12, 4], [18, 4], [18, 8], [12, 8]] },
    { kind: "polygon", layer: "layer-annotations", points: [[0, 0], [6, 0], [6, 4], [0, 4]] },
    { kind: "polygon", layer: "layer-annotations", points: [[13, 0], [18, 0], [18, 4], [13, 4]] },
    // Zone labels (middle-anchored → become anti-collision room-tag pills)
    { kind: "text", layer: "layer-annotations", x: 3, y: 10, content: "DOUBLE-HEIGHT ATRIUM LOBBY", height: 0.35, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 9, y: 10, content: "GLASS CONFERENCE BOARDROOM", height: 0.35, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 15, y: 10, content: "ROOFTOP SOLAR TERRACE", height: 0.35, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 3, y: 6, content: "OPEN AI ENGINEERING STUDIO", height: 0.35, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 9, y: 6, content: "ESPRESSO & LOUNGE BAR", height: 0.35, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 15, y: 6, content: "PROTOTYPING WORKSHOP", height: 0.35, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 3, y: 2, content: "SERVER & QUANTUM COOLING VAULT", height: 0.35, anchor: "middle" },
    { kind: "text", layer: "layer-annotations", x: 15.5, y: 2, content: "RESTROOM CORE", height: 0.35, anchor: "middle" },
    // Dimension chains (45° slash ticks are drawn by the viewer)
    { kind: "line", layer: "layer-dimensions", from: [0, -1], to: [18, -1] },
    { kind: "line", layer: "layer-dimensions", from: [-1, 0], to: [-1, 12] },
    { kind: "line", layer: "layer-dimensions", from: [0, 13], to: [18, 13] },
    { kind: "line", layer: "layer-dimensions", from: [19, 0], to: [19, 12] },
    { kind: "text", layer: "layer-dimensions", x: 9, y: -1.4, content: "18.00 m", height: 0.3, anchor: "middle" },
    { kind: "text", layer: "layer-dimensions", x: -1.4, y: 6, content: "12.00 m", height: 0.3, anchor: "middle" },
    // MEP routing (dashed amber + junction nodes)
    { kind: "line", layer: "layer-mep", from: [10.7, 6.7], to: [10.7, 4.2] },
    { kind: "line", layer: "layer-mep", from: [10.7, 4.2], to: [16.9, 4.2] },
    { kind: "line", layer: "layer-mep", from: [16.9, 4.2], to: [16.9, 1.4] },
  ],
  walls: [
    { id: "wall-envelope", layer: "layer-structural", path: [[0, 0], [18, 0], [18, 12], [0, 12]], closed: true, height: 3, thickness: 0.25 },
    { id: "wall-part-a", layer: "layer-structural", path: [[6, 8], [6, 12]], height: 3, thickness: 0.15 },
    { id: "wall-part-b", layer: "layer-structural", path: [[12, 8], [12, 12]], height: 3, thickness: 0.15 },
    { id: "wall-part-c1", layer: "layer-structural", path: [[0, 8], [5.5, 8]], height: 3, thickness: 0.15 },
    { id: "wall-part-c2", layer: "layer-structural", path: [[6.5, 8], [11.5, 8]], height: 3, thickness: 0.15 },
    { id: "wall-part-c3", layer: "layer-structural", path: [[12.5, 8], [18, 8]], height: 3, thickness: 0.15 },
    { id: "wall-part-f1", layer: "layer-structural", path: [[0, 4], [5.5, 4]], height: 3, thickness: 0.15 },
    { id: "wall-part-f2", layer: "layer-structural", path: [[6.5, 4], [12.5, 4]], height: 3, thickness: 0.15 },
    { id: "wall-part-h", layer: "layer-structural", path: [[13, 0], [13, 4]], height: 3, thickness: 0.15 },
    { id: "wall-part-i", layer: "layer-structural", path: [[13, 4], [18, 4]], height: 3, thickness: 0.15 },
  ],
  doors: [
    { id: "door-entry", layer: "layer-architectural", hinge: [8.5, 0], width: 1.8, angleDeg: 90, swingDeg: 90, wall: "wall-envelope" },
    { id: "door-conf", layer: "layer-architectural", hinge: [6, 9], width: 1.1, angleDeg: 0, swingDeg: 90, wall: "wall-part-a" },
    { id: "door-studio", layer: "layer-architectural", hinge: [5.5, 8], width: 1, angleDeg: -90, swingDeg: 90, wall: "wall-part-c1" },
    { id: "door-vault", layer: "layer-architectural", hinge: [4, 4], width: 1, angleDeg: 90, swingDeg: -90, wall: "wall-part-f1" },
    { id: "door-rest", layer: "layer-architectural", hinge: [13, 1.2], width: 0.9, angleDeg: 0, swingDeg: 90, wall: "wall-part-h" },
  ],
  windows: [
    { id: "win-s1", layer: "layer-architectural", from: [1.5, 0], to: [4.5, 0], mullions: 3, wall: "wall-envelope" },
    { id: "win-s2", layer: "layer-architectural", from: [12, 0], to: [15, 0], mullions: 3, wall: "wall-envelope" },
    { id: "win-n1", layer: "layer-architectural", from: [7, 12], to: [11, 12], mullions: 3, wall: "wall-envelope" },
    { id: "win-n2", layer: "layer-architectural", from: [14, 12], to: [17, 12], mullions: 2, wall: "wall-envelope" },
    { id: "win-e1", layer: "layer-architectural", from: [18, 5], to: [18, 7], mullions: 2, wall: "wall-envelope" },
    { id: "win-w1", layer: "layer-architectural", from: [0, 9], to: [0, 11], mullions: 2, wall: "wall-envelope" },
  ],
  furniture: [
    { id: "f-desk-1", layer: "layer-furniture", category: "desk", x: 0.8, y: 6.6, w: 1.4, h: 0.7, label: "Desk 1" },
    { id: "f-desk-2", layer: "layer-furniture", category: "desk", x: 2.6, y: 6.6, w: 1.4, h: 0.7, label: "Desk 2" },
    { id: "f-desk-3", layer: "layer-furniture", category: "desk", x: 4.2, y: 6.6, w: 1.4, h: 0.7, label: "Desk 3" },
    { id: "f-desk-4", layer: "layer-furniture", category: "desk", x: 0.8, y: 5.2, w: 1.4, h: 0.7, label: "Desk 4" },
    { id: "f-chair-1", layer: "layer-furniture", category: "chair", x: 1.4, y: 5.9, w: 0.5, h: 0.5 },
    { id: "f-plant-1", layer: "layer-furniture", category: "plant", x: 5.4, y: 7.2, w: 0.5, h: 0.5 },
    { id: "f-counter", layer: "layer-furniture", category: "counter", x: 7, y: 6.6, w: 3, h: 0.8, label: "Espresso Counter" },
    { id: "f-sink", layer: "layer-furniture", category: "sink", x: 10.4, y: 6.7, w: 0.6, h: 0.6 },
    { id: "f-sofa", layer: "layer-furniture", category: "sofa", x: 7, y: 4.6, w: 2.4, h: 0.9 },
    { id: "f-coffee", layer: "layer-furniture", category: "coffee_table", x: 7.7, y: 5.8, w: 1.2, h: 0.7 },
    { id: "f-shelving", layer: "layer-furniture", category: "shelving", x: 13, y: 7.2, w: 2, h: 0.5 },
    { id: "f-appliance", layer: "layer-furniture", category: "appliance", x: 16.8, y: 6.4, w: 0.8, h: 0.8 },
    { id: "f-plant-2", layer: "layer-furniture", category: "plant", x: 17.4, y: 7.4, w: 0.5, h: 0.5 },
    { id: "f-rack-1", layer: "layer-furniture", category: "server_rack", x: 1, y: 1, w: 0.8, h: 1.2, label: "Quantum Rack A" },
    { id: "f-rack-2", layer: "layer-furniture", category: "server_rack", x: 2.4, y: 1, w: 0.8, h: 1.2, label: "Quantum Rack B" },
    { id: "f-toilet", layer: "layer-furniture", category: "toilet", x: 16.8, y: 0.5, w: 0.6, h: 0.9 },
    { id: "f-shower", layer: "layer-furniture", category: "shower", x: 13.5, y: 0.4, w: 1.2, h: 1.2 },
    { id: "f-stairs", layer: "layer-furniture", category: "stairs", x: 16.4, y: 2.2, w: 1.4, h: 1.6, label: "Core Stair" },
  ],
  grid: {
    columns: [{ label: "A", position: 0 }, { label: "B", position: 6 }, { label: "C", position: 12 }, { label: "D", position: 18 }],
    rows: [{ label: "1", position: 0 }, { label: "2", position: 4 }, { label: "3", position: 8 }, { label: "4", position: 12 }],
  },
  slabs: [{ id: "slab-floor", layer: "layer-structural", outline: [[0, 0], [18, 0], [18, 12], [0, 12]], z: 0, thickness: 0.15 }],
  titleBlock: { projectName: "Sustainable Innovation Lab & Executive Hub", sheetTitle: "Level 1 Plan + BIM Cutaway", scaleLabel: "1:100", date: "2026-10-17", author: "WebUI Studio", sheetNumber: "A-201" },
  defaultView: "2d",
  export: { filename: "innovation-lab" },
};

test.describe("Stress: ArchitectureCadViewer full lab blueprint + BIM (visible)", () => {
  test("hatched double walls, door swings, mullions, furniture blocks, room-tag pills, grid axes, BIM cutaway", async ({ page }) => {
    test.setTimeout(300000);
    await mockChat(page, "cad", JSON.stringify(LAB_SPEC, null, 2));
    await page.goto("http://localhost:3000/");
    await step(page, "🧪 STRESS: Submitting the 18m×12m Innovation Lab blueprint prompt...");
    await sendPrompt(page, LAB_PROMPT);
    await expect(page.locator('[data-testid="cad-viewer"]')).toBeVisible({ timeout: 40000 });
    await expect(page.locator('[data-testid="cad-stage"]')).toBeVisible();

    await step(page, "🧪 STRESS: AutoCAD poché hatch pattern + double-lined walls...");
    await expect(page.locator("#cad-wall-hatch"), "wall hatch <pattern> must be defined in <defs>").toHaveCount(1);
    await expect(page.locator('[data-testid="cad-wall-wall-envelope"] polyline'), "envelope must render OUTER + INNER lines")
      .toHaveCount(2);
    await expect(page.locator('[data-testid="cad-wall-wall-envelope"] path').first(), "envelope poché fill path").toBeVisible();

    await step(page, "🧪 STRESS: Door leaves + 90° dashed swing arcs...");
    await expect(page.locator('[data-testid^="cad-door-"]')).toHaveCount(5);
    const doorArcs = await page.locator('[data-testid^="cad-door-"] path').count();
    expect(doorArcs, "each door must draw its swing arc").toBeGreaterThanOrEqual(5);

    await step(page, "🧪 STRESS: Window mullions (triple-line glazing)...");
    await expect(page.locator('[data-testid^="cad-window-"]')).toHaveCount(6);
    const winLines = await page.locator('[data-testid="cad-window-win-s1"] line').count();
    expect(winLines, "3 mullions → glazing + mullion line bundle").toBeGreaterThanOrEqual(5);

    await step(page, "🧪 STRESS: Procedural furniture CAD blocks (desks, counters, racks, sanitary)...");
    await expect(page.locator('[data-testid^="cad-furniture-"]')).toHaveCount(18);
    const deskPrims = await page.locator('[data-testid="cad-furniture-f-desk-1"] line, [data-testid="cad-furniture-f-desk-1"] rect').count();
    expect(deskPrims, "desk block must be multi-stroke, not an empty rectangle").toBeGreaterThanOrEqual(3);
    const rackPrims = await page.locator('[data-testid="cad-furniture-f-rack-1"] line, [data-testid="cad-furniture-f-rack-1"] rect').count();
    expect(rackPrims, "server rack block must show rails/vents").toBeGreaterThanOrEqual(3);

    await step(page, "🧪 STRESS: Dimension chains with 45° slash ticks...");
    const dimLines = await page.locator('[data-testid="cad-stage"] [data-layer="layer-dimensions"] line').count();
    expect(dimLines, "4 dimension chains + 8 slash ticks").toBeGreaterThanOrEqual(10);

    await step(page, "🧪 STRESS: Room-tag pills — 8 zones, zero bounding-box collisions...");
    const pillCount = await page.locator('[data-testid="cad-room-tag"]').count();
    expect(pillCount, "every middle-anchored zone label becomes a pill").toBeGreaterThanOrEqual(8);
    for (const zone of ["GLASS CONFERENCE BOARDROOM", "SERVER & QUANTUM COOLING VAULT", "ROOFTOP SOLAR TERRACE"]) {
      await expect(page.locator('[data-testid="cad-room-tag"] text').filter({ hasText: zone }).first()).toBeVisible();
    }
    const pillOverlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('[data-testid="cad-room-tag"]')].map((g) => (g as unknown as SVGGraphicsElement).getBBox());
      let n = 0;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1) n++;
        }
      }
      return n;
    });
    expect(pillOverlaps, "room-tag pills must never overlap each other").toBe(0);

    // Paint guard (blob regression 2026-10-17): the CSS text halo is 3.5 SVG
    // USER units — without non-scaling-stroke that is ~126 px of round-capped
    // stroke per glyph, merging into giant dark blobs behind every room tag.
    const halo = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="cad-room-tag"] text');
      const cs = getComputedStyle(t as Element);
      return { vectorEffect: cs.vectorEffect || (t as SVGGraphicsElement).style?.vectorEffect || "", strokeWidth: cs.strokeWidth };
    });
    expect(halo.vectorEffect, "text halo must be device-pixel (non-scaling-stroke)").toBe("non-scaling-stroke");
    expect(parseFloat(halo.strokeWidth), "halo stroke-width must stay in px range").toBeLessThanOrEqual(5);

    await step(page, "🧪 STRESS: Structural column grid axes A–D / 1–4 with bubble bubbles...");
    await expect(page.locator('[data-testid="cad-grid-axes"]')).toHaveCount(1);
    for (const label of ["A", "B", "C", "D", "1", "2", "3", "4"]) {
      await expect(page.locator('[data-testid="cad-grid-axes"] text').filter({ hasText: new RegExp(`^${label}$`) }).first(), `grid axis ${label}`).toBeVisible();
    }

    await step(page, "🧪 STRESS: 3D BIM cutaway — extruded walls, openings, furniture, edge shader...");
    await page.click('[data-testid="cad-view-3d"]');
    await expect(page.locator('[data-testid="cad-3d"] canvas')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1500);
    const statsText = await page.locator('[data-testid="cad-stats"]').textContent();
    const meshCount = Number((statsText ?? "").match(/(\d+)\s+meshes/)?.[1] ?? 0);
    expect(meshCount, "BIM extruder: walls split by openings + doors + windows + furniture").toBeGreaterThanOrEqual(40);
    const bimProbe = await canvasProbe(page, '[data-testid="cad-3d"] canvas');
    expectRealRender(bimProbe, "lab BIM cutaway", 240);

    await step(page, "🧪 STRESS: BIM ViewCube TOP / FRONT / RIGHT / ISO NE / ISO SW...");
    for (const dir of ["top", "front", "right", "iso-ne", "iso-sw"]) {
      await page.click(`[data-testid="cad-viewcube-${dir}"]`);
      await page.waitForTimeout(400);
      expectRealRender(await canvasProbe(page, '[data-testid="cad-3d"] canvas'), `lab viewcube ${dir}`, 240);
    }

    await step(page, "🧪 STRESS: Wall Height slider (0.6 m cut) must visibly change the BIM scene...");
    const fullSig = JSON.stringify([bimProbe.colors, bimProbe.litRatio, bimProbe.variedRatio]);
    await setRange(page, "cad-wall-height", "0.6");
    await page.waitForTimeout(700);
    const cutProbe = await canvasProbe(page, '[data-testid="cad-3d"] canvas');
    expectRealRender(cutProbe, "lab walls cut to 0.6 m", 240);
    expect(JSON.stringify([cutProbe.colors, cutProbe.litRatio, cutProbe.variedRatio]), "wall-height slider must change the live BIM render")
      .not.toBe(fullSig);
    await setRange(page, "cad-wall-height", "2.8");

    await step(page, "🧪 STRESS: Section clipping X must slice the model without errors...");
    await page.check('[data-testid="cad-section-x"]');
    await setRange(page, "cad-section-val-x", "9");
    await page.waitForTimeout(700);
    expectRealRender(await canvasProbe(page, '[data-testid="cad-3d"] canvas'), "lab section X", 240);
    await page.uncheck('[data-testid="cad-section-x"]');
  });
});

// ── Coverage: every control in both viewers exists and toggles cleanly ───────

test.describe("Coverage: ArchitectureCadViewer controls (visible)", () => {
  test("full ribbon, layer dock, tools and 3D control checklist", async ({ page }) => {
    test.setTimeout(240000);
    await mockChat(page, "cad", JSON.stringify(KIOSK_SPEC, null, 2));
    await page.goto("http://localhost:3000/");
    await step(page, "🧪 CHECKLIST: Loading the Coffee Kiosk for the CAD control sweep...");
    await sendPrompt(page, KIOSK_PROMPT);
    await expect(page.locator('[data-testid="cad-viewer"]')).toBeVisible({ timeout: 40000 });

    // Slice regression guards (2026-10-17): (a) the ribbon must FIT the chat
    // column — overflow-x silently buries the Export controls off-card;
    // (b) the initial fit is dock-aware, so no drawing geometry may sit
    // under the absolute 230 px docks.
    const ribbon = page.locator(".cad-ribbon-bar");
    expect(await ribbon.evaluate((el) => el.scrollWidth - el.clientWidth), "ribbon must not overflow").toBeLessThanOrEqual(0);
    const exportBox = await page.locator('[data-testid="cad-export"]').boundingBox();
    const shellBox = await page.locator(".cad-workstation-shell").boundingBox();
    expect(exportBox!.x + exportBox!.width, "Export button inside the card").toBeLessThanOrEqual(shellBox!.x + shellBox!.width + 1);
    const bandCheck = await page.evaluate(() => {
      const svg = document.querySelector('[data-testid="cad-stage"]')!;
      const r = svg.getBoundingClientRect();
      const inset = 238; // dock 230 px + 8 px offset
      let minX = Infinity, maxX = -Infinity;
      for (const g of document.querySelectorAll("g[data-layer]")) {
        for (const sh of g.querySelectorAll("line,rect,path,polyline,polygon,circle")) {
          try {
            const bb = (sh as SVGGraphicsElement).getBBox();
            const ctm = sh.getScreenCTM()!;
            for (const [px, py] of [[bb.x, bb.y], [bb.x + bb.width, bb.y + bb.height]]) {
              const sx = ctm.a * px + ctm.c * py + ctm.e;
              minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
            }
          } catch { /* zero-size shapes */ }
        }
      }
      return { minX, maxX, left: r.x + inset, right: r.right - inset };
    });
    expect(bandCheck.minX, "drawing left edge clear of left dock").toBeGreaterThanOrEqual(bandCheck.left - 2);
    expect(bandCheck.maxX, "drawing right edge clear of right dock").toBeLessThanOrEqual(bandCheck.right + 2);

    await step(page, "🧪 CHECKLIST: Ribbon — view modes, themes, zoom, tools, fullscreen, exports...");
    for (const mode of ["2d", "iso", "3d", "split"]) {
      await expect(page.locator(`[data-testid="cad-view-${mode}"]`), `view mode ${mode}`).toHaveCount(1);
    }
    await expect(page.locator('[data-testid="cad-theme"] option')).not.toHaveCount(0);
    await expect(page.locator('[data-testid^="cad-zoom-"]')).not.toHaveCount(0);
    for (const tool of ["measure", "area", "protractor", "snap-grid", "snap-vertex"]) {
      await expect(page.locator(`[data-testid="cad-tool-${tool}"]`), `tool ${tool}`).toHaveCount(1);
    }
    await page.click('[data-testid="cad-tool-protractor"]');
    await expect(page.locator('[data-testid="cad-tool-clear"]'), "clear appears while a tool is armed").toBeVisible();
    await page.click('[data-testid="cad-tool-clear"]');
    await expect(page.locator('[data-testid="cad-fullscreen"]')).toHaveCount(1);
    const cadFormats = await page.locator('[data-testid="cad-export-format"] option').allTextContents();
    expect(cadFormats.length, "export formats").toBeGreaterThanOrEqual(7);
    for (const f of ["DXF", "SVG", "PDF", "PNG", "HTML", "GLB", "OBJ"]) {
      expect(cadFormats.some((t) => t.startsWith(f)), `export format ${f}`).toBe(true);
    }

    await step(page, "🧪 CHECKLIST: Layer dock — Eye / Lock / Opacity / Solo for every layer...");
    for (const layer of ["layer-structural", "layer-architectural", "layer-furniture", "layer-mep", "layer-dimensions", "layer-annotations"]) {
      for (const ctl of ["hide", "lock", "opacity", "solo"]) {
        await expect(page.locator(`[data-testid="cad-${ctl}-${layer}"]`), `${ctl} ${layer}`).toHaveCount(1);
      }
      await page.click(`[data-testid="cad-lock-${layer}"]`);
      await page.click(`[data-testid="cad-lock-${layer}"]`);
    }
    await page.click('[data-testid="cad-solo-layer-mep"]');
    await expect(page.locator('[data-testid="cad-solo-clear"]')).toBeVisible();
    await expect(page.locator('[data-testid="cad-stage"] [data-layer="layer-structural"]')).toHaveCount(0);
    await page.click('[data-testid="cad-solo-clear"]');
    // cad-toggle-flows renders only when the spec contains flow entities — the
    // kiosk has none, so assert its absence instead of a false positive.
    await expect(page.locator('[data-testid="cad-toggle-flows"]')).toHaveCount(0);

    await step(page, "🧪 CHECKLIST: 3D controls — explode, wall height, sections, sun, ViewCube, stats...");
    // In 2D the 3D controls are disabled BY DESIGN — they must explain why
    // (hint banner + tooltip), otherwise users read them as broken buttons.
    await expect(page.locator('[data-testid="cad-dock-hint"]')).toBeVisible();
    await expect(page.locator('[data-testid="cad-explode"]')).toBeDisabled();
    await expect(page.locator('[data-testid="cad-explode"]')).toHaveAttribute("title", /Iso \/ 3D \/ Split/);
    await page.click('[data-testid="cad-view-3d"]');
    await expect(page.locator('[data-testid="cad-3d"] canvas')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-testid="cad-dock-hint"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cad-explode"]')).toBeEnabled();
    await expect(page.locator('[data-testid="cad-wall-height"]')).toBeEnabled();
    await expect(page.locator('[data-testid="cad-sun"]')).toBeEnabled();
    for (const axis of ["x", "y", "z"]) {
      await expect(page.locator(`[data-testid="cad-section-${axis}"]`), `section ${axis}`).toHaveCount(1);
      await expect(page.locator(`[data-testid="cad-section-val-${axis}"]`), `section ${axis} value`).toHaveCount(1);
    }
    await page.check('[data-testid="cad-section-y"]');
    await setRange(page, "cad-section-val-y", "3");
    await page.uncheck('[data-testid="cad-section-y"]');
    for (const dir of ["top", "front", "right", "iso-ne", "iso-sw"]) {
      await expect(page.locator(`[data-testid="cad-viewcube-${dir}"]`), `viewcube ${dir}`).toHaveCount(1);
      await page.click(`[data-testid="cad-viewcube-${dir}"]`);
    }
    await expect(page.locator('[data-testid="cad-stats"]')).toContainText("meshes");
    await page.click('[data-testid="cad-view-2d"]');
    await expect(page.locator('[data-testid="cad-stage"]')).toBeVisible();
  });
});

test.describe("Coverage: ThreeStudioViewer controls (visible)", () => {
  test("full ribbon, outliner, material inspector, post-fx and ViewCube checklist", async ({ page }) => {
    test.setTimeout(240000);
    await mockChat(page, "threejs", DRONE_CODE);
    await page.goto("http://localhost:3000/");
    await step(page, "🧪 CHECKLIST: Loading the Hover Drone for the studio control sweep...");
    await sendPrompt(page, DRONE_PROMPT);
    await expect(page.locator('[data-testid="scene3d-stage"]')).toBeVisible({ timeout: 40000 });
    await expect(page.locator('[data-testid="threejs-code-error"]')).toHaveCount(0);

    await step(page, "🧪 CHECKLIST: Ribbon — shading, projection, FOV, 7 views, transforms, overlays...");
    await expect(page.locator('[data-testid="scene3d-shading"] option')).not.toHaveCount(0);
    await expect(page.locator('[data-testid="scene3d-projection"] option')).toHaveCount(2);
    await expect(page.locator('[data-testid="scene3d-fov"]')).toHaveCount(1);
    for (const v of ["front", "back", "left", "right", "top", "bottom", "iso"]) {
      await expect(page.locator(`[data-testid="scene3d-view-${v}"]`), `view ${v}`).toHaveCount(1);
      await page.click(`[data-testid="scene3d-view-${v}"]`);
    }
    for (const b of ["frame", "reset"]) await expect(page.locator(`[data-testid="scene3d-view-${b}"]`)).toHaveCount(1);
    for (const t of ["translate", "rotate", "scale", "space"]) await expect(page.locator(`[data-testid="scene3d-transform-${t}"]`)).toHaveCount(1);
    for (const o of ["grid", "axes", "bbox", "cage", "lights"]) {
      await expect(page.locator(`[data-testid="scene3d-tool-${o}"]`), `overlay ${o}`).toHaveCount(1);
      await page.click(`[data-testid="scene3d-tool-${o}"]`);
      await page.click(`[data-testid="scene3d-tool-${o}"]`);
    }
    await expect(page.locator('[data-testid="scene3d-fullscreen"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="scene3d-export-format"] option')).not.toHaveCount(0);

    await step(page, "🧪 CHECKLIST: ViewCube — 5 faces reposition the live camera...");
    const camPos = () => page.evaluate(() => { const c = (window as any).__studioViewer.activeCamera.position; return [c.x, c.y, c.z]; });
    let prev = await camPos();
    for (const dir of ["top", "front", "right", "iso-ne", "iso-sw"]) {
      await expect(page.locator(`[data-testid="scene3d-viewcube-${dir}"]`), `viewcube ${dir}`).toHaveCount(1);
      await page.click(`[data-testid="scene3d-viewcube-${dir}"]`);
      await page.waitForTimeout(350);
      const now = await camPos();
      expect(Math.hypot(now[0] - prev[0], now[1] - prev[1], now[2] - prev[2]), `viewcube ${dir} moves camera`).toBeGreaterThan(0.3);
      prev = now;
    }

    await step(page, "🧪 CHECKLIST: Outliner rows with Eye + Solo for every named part...");
    await expect(page.locator('[data-testid^="scene3d-outliner-"]')).not.toHaveCount(0);
    await expect(page.locator('[data-testid^="scene3d-hide-"]')).not.toHaveCount(0);
    await expect(page.locator('[aria-label^="Solo "]')).not.toHaveCount(0);

    await step(page, "🧪 CHECKLIST: Material inspector + environment + post-processing controls...");
    // The material inspector renders only for a SELECTED mesh — select first.
    await page.click('[data-testid="scene3d-outliner-Drone_Body"]');
    for (const m of ["color", "metalness", "roughness", "emissive", "emissiveIntensity", "opacity", "flatShading", "wireframe"]) {
      await expect(page.locator(`[data-testid="scene3d-material-${m}"]`), `material ${m}`).toHaveCount(1);
    }
    for (const fx of ["bloom", "ssao", "vignette"]) {
      await expect(page.locator(`[data-testid="scene3d-${fx}"]`), `post-fx ${fx}`).toHaveCount(1);
      await page.click(`[data-testid="scene3d-${fx}"]`);
      await page.click(`[data-testid="scene3d-${fx}"]`);
    }
    for (const env of ["env", "bg", "tonemap"]) await expect(page.locator(`[data-testid="scene3d-${env}"]`)).toHaveCount(1);
    await expect(page.locator('[data-testid^="scene3d-light-"]')).not.toHaveCount(0);
    await expect(page.locator('[data-testid="scene3d-explode"]')).toHaveCount(1);
    // The bottom-dock timeline (play/restart/scrub/speed/clip) and the custom
    // slider dock render ONLY for declarative spec scenes (spec.animations /
    // spec.sliders — ThreeStudioViewer hasAnimations gate). The drone is a
    // code scene driving motion via onUpdate, so both docks must be absent.
    await expect(page.locator('[data-testid="scene3d-play"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scene3d-restart"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scene3d-clip"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scene3d-sliders"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scene3d-stats"]')).toContainText("meshes");
  });
});
