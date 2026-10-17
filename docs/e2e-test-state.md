# E2E TEST STATE (Playwright)

- Dev server: `npm run dev` (:3000). Dies with the shell that started it —
  restart one-liner: `nohup npm run dev > /tmp/webui-dev.log 2>&1 & for i in $(seq 1 40); do code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:3000/ 2>/dev/null); [ "$code" = "200" ] && break; sleep 2; done; echo "server:$code"`
- `playwright.config.ts`: `headless:false`, `slowMo:300`, project
  `chromium-visible`, browsers in `.data/ms-playwright`. NEVER run headless
  (user mandate). Each run wipes `test-results/` — view artifacts immediately.
- Green suite (headed, watched): `npx playwright test
  tests/studio-viewers-visible.spec.ts --headed --workers=1 --reporter=list`
  → **6 passed (1.6 m, run 2026-10-17 #4)**. Tests 1-2 as below; NEW:
  MECHA stress (17 named parts, ≥4 geo types, emissive visors ≥1.5,
  explode 100% part-distance, ViewCube 5 faces move camera >0.5),
  LAB stress (`#cad-wall-hatch` poché, 5 door arcs, 6 windows ×6 lines,
  18 furniture blocks, ≥10 dimension lines, ≥8 room-tag pills with
  pairwise getBBox overlap==0, grid bubbles A-D/1-4, BIM ≥40 meshes,
  ViewCube ×5, wall-height + section-X change probe signature),
  CAD coverage checklist (all ribbon/dock/3D testids; `cad-toggle-flows`
  count 0 when spec.flows empty), studio coverage checklist (7 views,
  ViewCube camera >0.3, material inspector requires selecting an
  outliner row first). Test 1 cyberpunk hover drone (4 named parts
  Drone_Body/Scanner_Eye/Left_Thruster/Right_Thruster): canvas pixel probe
  (all-black MUST fail), shading cycle, presets/FOV/projection, gizmos,
  overlays, Eye/Solo, live Material sliders, Explode 0→80→0, GLB+OBJ >100 B.
  Test 2 coffee kiosk 8m×6m CAD: SVG bbox+zone names, layer Eye/Solo,
  2D/iso/3D-BIM/split (BIM canvas non-black, minSize 240), themes, Tape
  Measure, Area, .dxf SECTION/ENTITIES/LAYER + .svg.
- Probes: `canvasProbe` forces `studio.renderer.render(studio.scene,
  studio.activeCamera)` before `toDataURL`; `expectRealRender` minSize 300
  (BIM 240). Visual proof: `test-results/canvas-proof.png` (drone visible).
- Size/16:9/fullscreen verification (2026-10-17): temp headless script mocked
  ```cad + ```threejs fences, measured boxes + clicked both FS buttons — CAD
  block 736→1136px, `.cad-body` and `.scene3d-stage` ratio 1.78, FS stages
  990×821 / 1440×778; screenshots `test-results/size-check/` (kept). Script
  deleted after use. Headless quirk: `Escape` does not exit fullscreen —
  call `document.exitFullscreen()` from `page.evaluate`.
- Known gotchas: r186 removed `renderer.viewport` (use `getViewport()`);
  async IIFE inside `page.evaluate` return serializes to `{}`; Playwright
  `CI=true` enables retries:2; `route.fulfill` delivers SSE in one chunk.
- **Stage-click bbox gotcha (root-caused 2026-10-17):** clicking any ribbon
  tool button (`cad-tool-*`) re-scrolls the chat container — the stage bbox
  jumps ~270 px, and a stale bbox sends `page.mouse.click` onto the chat
  composer TEXTAREA or the sticky `code-block-header` (cursor readout stays
  `X: — Y: —` in `cad-status` = pointer events missed the SVG). ALWAYS
  `stage.scrollIntoViewIfNeeded()` + re-read `boundingBox()` AFTER arming
  each tool, immediately before the stage clicks. The docks
  (`.cad-dock-left/-right`, 230 px absolute overlays) never blocked the
  center band — the scroll was the real culprit.
- **Render-gated controls (assert count 0 for code scenes):** the studio
  bottom-dock timeline (`scene3d-play/restart/scrub/speed/clip`) renders
  only when `spec.animations` exists (ThreeStudioViewer `hasAnimations`
  gate) — code scenes animate via `onUpdate`, so those testids are absent;
  `scene3d-sliders` likewise requires `spec.sliders`; `cad-toggle-flows`
  requires non-empty `spec.flows`; the `scene3d-material-*` inspector
  requires a selected mesh (click the outliner row first).
- Dev-server port conflicts: stale hung Next servers squat :3000/:3001/:3002
  (curl times out, exit 28) — `taskkill //PID <pid> //F //T` each, restart.
- Unit gate: `npx vitest run` → 34 files, 402 passed | 1 skipped. `tsc --noEmit` clean.
