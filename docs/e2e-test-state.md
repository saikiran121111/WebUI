# E2E TEST STATE (Playwright)

- Dev server: `npm run dev` (:3000). Dies with the shell that started it —
  restart one-liner: `nohup npm run dev > /tmp/webui-dev.log 2>&1 & for i in $(seq 1 40); do code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:3000/ 2>/dev/null); [ "$code" = "200" ] && break; sleep 2; done; echo "server:$code"`
- `playwright.config.ts`: `headless:false`, `slowMo:350`, project
  `chromium-visible`, browsers in `.data/ms-playwright`. NEVER run headless
  (user mandate). Each run wipes `test-results/` — view artifacts immediately.
- Green suite (headed, watched): `npx playwright test
  tests/studio-viewers-visible.spec.ts --headed --workers=1 --reporter=list`
  → 2 passed (44.1 s). Test 1 cyberpunk hover drone (4 named parts
  Drone_Body/Scanner_Eye/Left_Thruster/Right_Thruster): canvas pixel probe
  (all-black MUST fail), shading cycle, presets/FOV/projection, gizmos,
  overlays, Eye/Solo, live Material sliders, Explode 0→80→0, GLB+OBJ >100 B.
  Test 2 coffee kiosk 8m×6m CAD: SVG bbox+zone names, layer Eye/Solo,
  2D/iso/3D-BIM/split (BIM canvas non-black, minSize 240), themes, Tape
  Measure, Area, .dxf SECTION/ENTITIES/LAYER + .svg.
- Probes: `canvasProbe` forces `studio.renderer.render(studio.scene,
  studio.activeCamera)` before `toDataURL`; `expectRealRender` minSize 300
  (BIM 240). Visual proof: `test-results/canvas-proof.png` (drone visible).
- Known gotchas: r186 removed `renderer.viewport` (use `getViewport()`);
  async IIFE inside `page.evaluate` return serializes to `{}`; Playwright
  `CI=true` enables retries:2; `route.fulfill` delivers SSE in one chunk.
- Unit gate: `npx vitest run` → 34 files, 402 passed | 1 skipped. `tsc --noEmit` clean.
