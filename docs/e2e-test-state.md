# E2E TEST STATE (Playwright)

- Dev server: `npm run dev` (:3000). Dies with the shell that started it —
  restart one-liner: `nohup npm run dev > /tmp/webui-dev.log 2>&1 & for i in $(seq 1 40); do code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:3000/ 2>/dev/null); [ "$code" = "200" ] && break; sleep 2; done; echo "server:$code"`
- `playwright.config.ts`: `headless:false`, `slowMo:300`, project
  `chromium-visible`, browsers in `.data/ms-playwright`. NEVER run headless
  (user mandate). Each run wipes `test-results/` — view artifacts immediately.
- Green suite (headed, watched): `npx playwright test
  tests/studio-viewers-visible.spec.ts --headed --workers=1 --reporter=list`
  → **6 passed (1.6 m, run 2026-10-18 #11, after collapsible-dock guards +
  studio ribbon wrap + viewcube chip fix — see ISSUES.md; run #9, after
  room-tag halo opt-out —
  `.cad-svg-canvas g.cad-room-tag text { stroke:none }` kills the
  Chromium tspan-halo mis-paint (dark disc + dropped line at fit);
  run #8 also green after the text-sizing fix — wall-raycast rooms +
  word-wrapped 9px pills + 13px plain-text cap; zone `hasText`
  assertions still pass because a wrapped label's <text> textContent
  retains the full name via tspans)**. Run #9 CHANGED guard (LAB
  stress): room-tag paint guard now asserts computed `stroke === "none"`
  on ALL `[data-testid="cad-room-tag"] text` (≥16 texts) — the old
  vectorEffect/stroke-width assertion PASSED while the blob painted,
  so it is banned as a guard; pixel screenshots are the only reliable
  blob check. Run #7 NEW guards (CAD
  coverage test): `.cad-ribbon-bar` scrollWidth−clientWidth ≤ 0 (chat column
  is ~768 px — ribbon must FIT, `scrollbar-width:none` hides overflow);
  `cad-export` boundingBox inside `.cad-workstation-shell`; every
  `g[data-layer]` shape's screen-CTM x within [stage.x+238, stage.right−238]
  (docks are absolute 230 px overlays — `fitView(bbox,{w,h,insetX:246})` is
  dock-aware, initial view snaps once via `initialFitDone` ref). Grid lines
  are NOT in `g[data-layer]` so the band guard is safe. Ribbon labels are
  now 2D/Iso/3D/Split + zoom 1×/2×/4× (testids unchanged). NEW guards in run #5: LAB stress paint assertion — room-tag
  `text` computed `vectorEffect === "non-scaling-stroke"` + stroke-width ≤5
  (catches the ~126 px user-unit halo blob regression that geometry-only
  checks missed); coverage test — `cad-dock-hint` visible + `cad-explode`
  disabled with `/Iso \/ 3D \/ Split/` title in 2D, hint count 0 + explode
  enabled in 3D. Tests 1-2 as below; NEW:
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
- **IntersectionObserver parking family (root-caused 2026-10-18):** both the
  ThreeStudio render loop (studioEngine `parked`) and the anatomy liveEngine
  loop (`inView`) park when the element is off-viewport; Playwright
  `toBeVisible()` ≠ viewport intersection. Any assertion on animation-driven
  state (scene3d HUD stats, anatomy readouts/explode transforms, canvas pixel
  probes) MUST be preceded by `locator.scrollIntoViewIfNeeded()`. Applied in
  three3d.spec, anatomy.spec (slider+explode), mecha stress. Anatomy also
  exposes `data-anatomy-live="1"` on the block root once the async engine
  mount attaches listeners — wait for it before dispatching slider events.
- **`__studioViewer` publish race:** ThreeStudioViewer assigns
  `window.__studioViewer` BEFORE the async codeRunner import applies fence
  content — under full-suite load a post-visibility `page.evaluate` can see
  `undefined`. Gate with `page.waitForFunction` on scene + named-mesh count
  (mecha stress does this now).
- **waitForResponse race:** register the promise BEFORE the click that
  triggers it — a local GET+POST round trip (~20 ms) can complete inside the
  `click()` await (conversations unarchive).
- **Zero-height collapsed wrappers read as "hidden":** `.tree-children.is-collapsed`
  uses `minmax(0,0fr)` → legitimately 0 px tall. Assert the end-state contract
  (`toHaveCount(1)` + `toHaveCSS("grid-template-rows","0px")` + boundingBox
  height < 2), not visibility.
- **Streaming-timing flakes:** the streaming-table test pumps SSE chunks at
  40 ms (~4.5 s stream); at 15 ms the stream finished before the wrap
  rendered and the sampler only saw the completed message.
- **Real-model nondeterminism (file-reading):** llama.cpp occasionally
  truncates a reply tail ("…RTF-7Q" for "…RTF-7QX9"). The extraction-API
  test proves server text is exact; the model-echo test now retries the
  journey once on marker miss. Windows display scaling 125% multiplies
  Playwright wheel deltaY ×1.25 — assert zoom direction, not exact factor.
- Dev-server port conflicts: stale hung Next servers squat :3000/:3001/:3002
  (curl times out, exit 28) — `taskkill //PID <pid> //F //T` each, restart.
- Unit gate: `npx vitest run` → 44 files, **445 passed | 1 skipped** (document
  engines: pdf/docx/xlsx/recalc/powerbi/pptx + cadRoomTags + ui/prefillCalibration
  + ui/stagedProgress). `tsc --noEmit` clean.
- 2026-10-18 (progress-mascot feature, LOCKED): NEW spec
  `tests/progress-status.spec.ts` → 2/2 (prefill status line via 1500 ms
  delayed SSE mock; DOCX toast lifecycle via /api/documents/docx mock).
  Full headed suite re-run in batches (10-min Bash cap — split, do NOT run
  all 20 specs in one command): chat-stream/reasoning/edit-stop-collapse/
  conversations-live-chat/regression_modalities/render → 37 passed + 1 skip;
  cad/three3d/studio-viewers-visible/anatomy×3 → 43/43; file-reading/
  interactive-ui/inspect-dup → 217 passed (file-reading is the slow file,
  ~9 min alone); multi-select-delete/skills/conversations-crud → 13/13.
  KNOWN FLAKE: conversations-live-chat "New does not duplicate" timed out
  once inside a 6-spec batch (sidebar row vanished after toHaveCount(1) —
  load-induced re-render under slowMo-300 batch pressure); passes solo.
- playwright-cli `app-dev` browser verification (2026-10-18): use
  **project-local `npx playwright cli`** — the globally installed CLI expects
  chromium-1247 while the repo cache has chromium-1243. GOTCHAS: the
  `run-code` sandbox has NO `setTimeout` (use `page.waitForTimeout`);
  routes registered via `run-code` do NOT persist across CLI commands
  (`route-list` shows empty) — register mocks AND drive the flow inside ONE
  run-code call, or a crashed handler leaves the request hanging forever.
