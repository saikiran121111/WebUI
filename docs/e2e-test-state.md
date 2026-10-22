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
- 2026-10-19 (large-upload fix, LOCKED): extraction-API block of
  tests/file-reading.spec.ts now posts RAW BYTES
  (`request.post('/api/files/extract?name=…', { data: fs.readFileSync(f),
  headers:{'content-type':'application/octet-stream'} })`) — multipart
  contract retired with the route rewrite (see ISSUES.md top entry).
  `npx playwright test tests/file-reading.spec.ts -g "extraction API"
  --headed --workers=1` → **106 passed (12.5 s) EXIT=0**. Live-browser
  check (playwright-cli, session closed after): 660 MB silent video via the
  real file input → `POST /api/files/extract` 200, chip
  `data-status="ready"` (poll `data-status`, NOT `data-state`), console
  only the known favicon.ico 404. Lock protocol honored both times
  (`.ai-coordination/playwright.lock` created/cleared). Layer-2
  model-echo half NOT re-run (only the upload transport changed;
  extraction-API proves the server text). vitest re-baseline: **449
  passed | 1 skipped** (was 434|1).
- 2026-10-19f (ALL LIMITS REMOVED, LOCKED): no byte cap (client gate +
  server 413 deleted) and no 180 s audio cut (whole-track decode).
  Re-verified under lock: extraction-API block **106 passed (10.9 s)
  EXIT=0**; live browser (playwright-cli session `up-fix`, closed after)
  660 MB video → chip `data-status="ready"`, console only favicon 404;
  curl 240 s wav → 200 (full-length whisper pass, 2.2 s). vitest
  re-baseline: **450 passed | 1 skipped** (NEW unit: 200 s decode whole).
  GOTCHA: playwright-cli run-code paths — use FORWARD SLASHES
  ('C:/Users/...'), backslash-escaping gets mangled through bash+JS.
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
- Unit gate: `npx vitest run` → **434 passed | 1 skipped (435)** (document
  engines: pdf/docx/xlsx/recalc/powerbi/pptx + cadRoomTags etc.; xlsxEngine
  500-row determinism + recalc 48-fn whitelist tests added 2026-10-19).
  `tsc --noEmit` clean. Counts re-baselined after the 2026-10-19
  progress-mascot revert (see below).
- 2026-10-19 (MASTER E2E run, LOCKED): full headed suite `npx playwright test`
  (313 tests, workers:1, ~1.4 h) — run it via `powershell Start-Process cmd`
  background + poll `.cache/pw-final.log` (foreground exceeds the 10-min Bash
  cap, exit 143). First full run: 46 failed → all root-caused + fixed (see
  ISSUES.md top 4 entries: instrumentation DCE guard, kindAllowed null-mode,
  attachment-turn verbatim forwarding, trivial-chat passthrough) → targeted
  re-runs green (demo batch 57 passed; file-reading+reasoning+chat-stream
  batch 218 passed / 0 failed; .py/.toml 4 passed). Run pw-final2 completed
  306|4 skipped|3 failed — all 3 = real-model PATIENCE family, fixed
  test-only: file-reading budgets sized for 2 attempts (text/image 150 s
  model / 380 s test; video 180/520; audio 180/600) + slow-turn timeout is
  now retryable once (never-finished-answering ≠ chat-failed), reasoning-test
  WINDOW 150 s + test 240 s (old WINDOW==TEST==60 s starved the assertion).
  PATIENCE RULE for real-model specs: per-test timeout MUST exceed
  (assertion window + overhead); never set window == test timeout.
  Run pw-final3 completed 308|4 skipped|1 failed — only reasoning-test:
  logs prove the decision was fast but `POST /api/chat 200 in 150536ms`:
  the model rambled in its thinking block the whole window (unterminated
  think → scrubber keeps the answer area empty; same prompt standalone
  finishes in ~1.4 s). FIXED test-only: journey retries ONCE on window
  expiry (fresh "New conversation", new UNIQUE token, test 420 s).
  Run pw-final4 completed 308|4 skipped|1 failed (36.4 m, exit 1) — the
  retry did NOT save reasoning-test (both attempts hit the 150 s window →
  systematic, not random). DEEPER ROOT CAUSE: ABANDONED UPSTREAM STREAMS.
  When a test navigates away mid-stream, the route's fetch to :8080 had no
  abort signal, so llama.cpp kept generating for the dead request (log
  proof: a chart decision with NO matching `POST /api/chat` completion
  line right before each victim run). APP FIX (app/api/chat/route.ts):
  `req.signal` is passed into forwardStream → upstream fetch aborts when
  the browser walks away; llama.cpp cancels on socket close. VERIFIED:
  abandon a chart stream at 6 s → next turn closes in 2.0 s (was starved);
  targeted neighborhood run (inspect-dup + interactive-ui +
  multi-select-delete + reasoning-test) **5 passed, exit 0** —
  reasoning-test passed FIRST attempt (turn closed in 125.6 s < 150 s).
  FINAL RUN pw-final5 (§1 lock protocol): **309 passed | 4 skipped |
  0 failed, exit 0** (30.0 m) — full headed suite 100% green. Post-fix
  vitest vs final code: 434 passed | 1 skipped.
- 2026-10-19 NEW COORDINATION PROTOCOL (project CLAUDE.md §1 — supersedes
  the "Start-Process background + poll" pattern above): CODE/TEST/ANALYZE
  mutually exclusive; `.ai-coordination/playwright.lock` created before
  launch and removed in `finally`; while the lock exists the agent waits in
  the §1.2 FOREGROUND loop and does NOTHING else; the run's real exit code
  is preserved; never kill a run, never edit app code mid-run. The 10-min
  Bash foreground cap < 33-45 m suite is bridged by a launcher script that
  owns the lock (§1.3 contemplates separate launchers); between wait-loop
  calls the agent performs no other work and no polling reasoning turns.
  Decision-engine CLI suites
  (all hit live worker :8790): `node tests/test-decision-router.mjs` 11/11,
  `node tests/audit-decision-table.mjs` 12/12 + ALL 10 hard tokens,
  `node tests/test-decision-extreme-edge-cases.mjs` **50/50**,
  `.decision-engine/.venv/Scripts/python.exe -I tests/test-decision-fallback.py`
  PASS. Worker restarts MUST use the venv python (system python →
  ModuleNotFoundError: needle). Auto-boot: `npm run dev` now warms the engine
  itself ("[decision] engine warm on http://127.0.0.1:8790") — no manual
  worker launch needed after a Next restart.
- 2026-10-19 (REVERT): progress-mascot feature (commit 5b94540) reverted —
  Mascot/RobotProgress/usePrefillProgress/prefillCalibration/stagedProgress,
  its unit tests and `tests/progress-status.spec.ts` removed. To be
  re-architected later; do NOT treat any mascot/progress-bar UI as existing.
- 2026-10-18 (sticky select toolbar fix, LOCKED): `multi-select-delete.spec.ts`
  extended with scroll-visibility guard (scroll `conversation-list` to bottom →
  `select-mode-toggle` + `select-all` MUST stay visible) → 2/2 (9.4s). Toolbar
  now lives outside the scroll container in `components/ui/Sidebar.tsx`.
- 2026-10-18 (document-modality fix batch, LOCKED): dark-preview/native-FS/
  pagination/xlsx-recalc/CAD-layout fixes (see CHANGELOG top entry).
  `regression_modalities.spec.ts` extended: resume preview `body`
  toHaveCSS rgb(20,20,20) via `contentFrame()` — the iframe is `sandbox=""`
  so the parent's `contentDocument` is NULL (never `locator.evaluate` into
  it; FrameLocator + toHaveCSS is the way); xlsx Summary tab shows computed
  "$215,000.00"/"$0.44" (the value column is CURRENCY format — the margin
  average renders "$0.44", NOT "44.4%") and zero "=SUM(" td text; pptx card
  has no Fullscreen button (slideshow itself is native FS); NEW test: html
  invert class + `scrolling="yes"` when content > MAX_H. NATIVE FULLSCREEN
  works HEADED: Escape exits via `fullscreenchange` (the headless Escape
  quirk does NOT apply headed). Full headed suite: **314 passed / 0 failed**
  across 9 batches — 6-spec batches TIME OUT the 10-min Bash cap
  (file-reading alone is ~10 min: pair it only with reasoning-test).
  Unit gate 445 | 1 skipped; `tsc --noEmit` clean.
- playwright-cli `app-dev` browser verification (2026-10-18): use
  **project-local `npx playwright cli`** — the globally installed CLI expects
  chromium-1247 while the repo cache has chromium-1243. GOTCHAS: the
  `run-code` sandbox has NO `setTimeout` (use `page.waitForTimeout`);
  routes registered via `run-code` do NOT persist across CLI commands
  (`route-list` shows empty) — register mocks AND drive the flow inside ONE
  run-code call, or a crashed handler leaves the request hanging forever.

## 2026-10-20 — Knowledge-index specs (headed, §1 lock) [GREEN]
- `npx playwright test tests/file-reading.spec.ts -g "extraction API" --headed
  --workers=1` → **106 passed (12.4 s) EXIT=0** (regression after extract wiring).
- NEW `tests/long-doc-retrieval.spec.ts` → **3 passed (32.1 s) EXIT=0**:
  1. oversized text + att id → indexed:true, chunkCount>20, spine, preview ≤4.1k
     WITHOUT the deep marker, full.txt byte-identical (marker at ~58k/60k chars);
  2. no att id → classic cap path untouched (truncated:true, ≤48k, no indexed);
  3. real UI + Strata: chip ready + indexed-badge visible → marker question answered
     turn 1 ("YES Verdanthill-42") → answered AGAIN turn 2 with NO re-attach
     (history attachment_ref rebuilds retrieval; evidence is per-turn).
  Timeouts: test 660k, chip-ready 180k, model 150k/turn. Fixture doc generated into
  `.data/tmp/` (NOT /tmp — git-bash /tmp ≠ curl/node /tmp gotcha); index dirs cleaned
  by the spec itself.
- Lock protocol honored: `.ai-coordination/playwright.lock` created before each run,
  removed on exit (trap), foreground, no polling.

## 2026-10-20 — Hardening pass verification (headed, §1 lock) [GREEN]
- `npx playwright test tests/file-reading.spec.ts -g "extraction API" --workers=1`
  → 106 passed (13.1 s), EXIT=0. Exercises the changed transcription stack on
  real fixtures (q8 CPU whisper + nvidia-smi stage probe; live log showed the
  stage-3 WARN fallback firing: "GPU whisper unavailable — falling back to CPU").
- vitest: 497 passed | 1 skipped (46 files) — +16 hardening tests, zero regressions.
- tsc --noEmit: EXIT=2, only the 4 pre-existing tests/render.spec.ts:977-980 errors.
- Lock created before the run, removed via trap on exit; foreground, no polling.

## 2026-10-22d — Progress chip/panel feature verification (§1 lock) [GREEN]
- NEW `tests/progress-panel.spec.ts` (6 tests, model-free paced `ruke_stage` SSE
  upstream via route.continue to a local Node http server — route.fulfill delivers
  all at once, unusable mid-stream): `npx playwright test tests/progress-panel.spec.ts`
  → 6 passed (35.6 s), PW_EXIT=0.
- Regression guard: `npx playwright test tests/edit-stop-collapse.spec.ts`
  → 5 passed (18.2 s), PW_EXIT=0. (First run after the feature: test at :124 timed
  out 60 s — root cause: the panel AUTO-OPENED as a 300 px z-50 popup under the top
  bar and occluded the fresh-thread user bubble's "Edit message" button, so the
  click hung. FIX: panel opens only on chip click (ProgressChip.tsx auto-open effect
  removed). Re-run green, that test 4.1 s.)
- Route-restructure guard: `npx playwright test tests/search-gate.spec.ts`
  → 3 passed (2.4 m, real model traffic), PW_EXIT=0 — decision headers + web_meta
  migration intact.
- vitest: 573 passed | 1 skipped (51 files). `tsc --noEmit`: EXIT=0.
