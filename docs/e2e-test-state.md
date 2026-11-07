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

## 2026-10-22e — Recents Claude-desktop parity (§1 lock) [GREEN]
- Feature: filter-menu Delete row + icon swap; View-all modal
  (`components/ui/RecentsModal.tsx`, z-[200]; restyled 2026-10-22f to centered
  ~60% popup — specs re-ran 11/11 green, exit 0); meta fields `group`/`unread`;
  Groups flyout + chip bar; unread dots; bulk pin/unread/group/delete handlers.
- `npx playwright test tests/recents-controls.spec.ts` → **6 passed, PW_EXIT=0**
  (incl. new filter-Delete-row test + collapsed pill opens modal, chevron expands).
- NEW `tests/recents-modal.spec.ts` → **5 passed (first run), PW_EXIT=0**: tabs/search/
  relative-time labels; bulk pin → disk poll + sidebar pin icon; mark unread → disk
  poll + modal & sidebar dots, opening clears; move-to-group → chip + sidebar Groups
  filter narrows list; bulk delete → ConfirmDialog → API 404 + row gone.
- `tests/conversations-crud.spec.ts` → **7 passed (22.4 s), PW_EXIT=0**.
- `tests/multi-select-delete.spec.ts` → first run 1 failed at :45 (`Delete ${total}`
  after select-all): store empty + single seed → row-click pre-satisfied select-all,
  so the click deselected ("Cancel"). FIXED test-only: seed TWO chats, clean both →
  **2 passed (6.0 s), PW_EXIT=0**.
- All runs lock-protocol honored (`.ai-coordination/playwright.lock` created/cleared,
  foreground, `${PIPESTATUS[0]}` captured). vitest: 573 passed | 1 skipped.
  `tsc --noEmit`: EXIT=0. Gotchas: modal rows must be scoped
  (`recents-modal` container) — sidebar mirrors the same titles; filter flyout clicks
  work only with the aside keeping `z-50` (stacking fix, locked in Sidebar.tsx).

## 2026-10-22f — UX restyles: Recents 60% popup + sources popup replaces trail card [GREEN]
- RecentsModal restyle (full-screen → centered ~60% popup, rows in centered
  `max-w-2xl` column): `recents-controls` + `recents-modal` specs → **11 passed
  (27.9 s), PW_EXIT=0**. Visual geometry confirmed via one-shot headless
  screenshot (lock-held, model-free seeded row, cleaned up after).
- ResearchTrailCard DELETED; ProcessingStatus line gains the click-to-open
  sources popup (`web-search-toggle` → `research-trail-card` / `-gate-badge` /
  `-source`; outside click + Escape close). Spec contracts migrated:
  `search-gate.spec.ts` clicks the processing line during the search phase and
  reads the popup; dead `[data-domain]` locators fixed to `a[data-citation]`
  (the pill component never forwarded data-domain to the DOM).
- `npx playwright test tests/greeting.spec.ts` → **2 passed (51.0 s), PW_EXIT=0**.
- `npx playwright test tests/search-gate.spec.ts` → **3 passed (2.4 m, real model
  traffic), PW_EXIT=0** — popup flow exercised live: toggle visible, opened,
  badge "Model-gated", on-topic hrefs, keyword-form queries containing "nvidia".
- vitest: 595 passed | 1 skipped (52 files). `tsc --noEmit`: EXIT=0. Gotcha:
  the popup lives inside ProcessingStatus, which unmounts at the first answer
  token — popup assertions must run during the search phase, not after settle.

## Final wave 2026-10-29 (post §11.3-amendment)
- cargo workspace 580/0; clippy -D clean; tsc 0; vitest 731p/1skip (re-run after 3 transient load-flakes); golden serial 54/54 (one 51/54 cluster right after cargo rebuild).
- Universal post-amendment green: u1 BookMyShow+SO, u2 Zepto+Greenhouse, u3 HN+Gov, u6 cold Blinkit+Myntra+Zomato (all exit 0). tally lines logged per turn; 0 PAGE_BUDGET_TIMEOUT.
- search-gate 3/3 after citation-scope fixture fix; tier3b-live 1/1.
- 10k: 35-69 P, 70-99 P, 0-34 F (3/35 WAF: stackoverflow/swiggy/zepto homepages — environmental).
- CodeBlock mid-stream colors verified live (colored at 2545ms during streaming).
- Lifecycle: stack start 200/200, clean stop, ports free, orphans none (one stale playwright test-server killed).

## Internal-browser E2E final locked loop — leg 1 GREEN (2026-10-31)
- Working invocation (from repo root, bash): `powershell.exe -NoProfile -Command "& 'D:\Projects\WebUI\WebUI\scripts\run-browser-e2e-exclusive.ps1' -TestFiles 'tests/browser-easy.spec.ts','tests/browser-medium.spec.ts','tests/browser-hard.spec.ts'"`. NEVER `-File` with comma-array (binds as ONE string); always `-Command` + quoted array.
- Result: 11 passed (11.4 s), exit 0, lock released. Fixture :3210 + Next :3000 + Rust :3101 pre-warmed detached ⇒ launcher reused them (near-zero startup overhead).
- Launcher bugs found by first-ever execution, all fixed (2432dae + c034938 + 3196c56 era): PS 5.1 mis-parse of nested `ToString('o')` inside `GetBytes(...)` stranded the lock after the exclusive handle was held (build the string in its own statement; crash-handler Dispose+Remove-Item); 1-arg `Stream.Write(byte[])` unresolvable ⇒ always 3-arg; `FileMode CreateNew` = atomic acquire.
- Defect #6 found by leg-2 recon (committed 3196c56): NO user-facing way to open the Browser Panel — auto-open only fires on `browser:*` frames, which require `browser_session`, which requires the panel open (catch-22). Fixed: Globe toggle in TopBar (`Open/Close browser panel` aria-labels), conversation = `activeId ?? "default"`.
- Leg-2 contract pins: chat send carries `browser_session` ONLY while panel open (app/page.tsx getBrowserSession) ⇒ Rust handler routes marked turns into `browser_loop.run_tool_loop` with engine `session_id = browser_session`; fresh "/" chat ⇒ "default". Panel open BEFORE the send is mandatory. Policy pre-arm: `PUT /api/browser/policy {host:"127.0.0.1", facet:"access"|"uploads"|"downloads", decision:"never_ask"}` (IP hosts key WITHOUT port — `registrable_host` psl-falls-back to bare host).
- Journey invocations (one blocking each, full idle between — plan rows 19–24): `-TestFiles 'tests/browser-model-acceptance.spec.ts' -Grep 'EASY'` (then MEDIUM, then HARD). Spec asserts REAL state via turn-"ui" RPC only; in-suite retries 0, per-test `setTimeout` 480 000 ms, turn-completion (Stop-button-gone) window 420 s, action/navigationTimeout 30 000 ms.
- Note: the panel's screencast layer intercepts pointer events at the page center (defect #7) — chat send must use `fill()`+Enter on the hero ChatInput, never `click()` on coordinates.

## Internal-browser E2E final locked loop — leg 2 GREEN (2026-10-31, real model)
- Defect #8 (the big one, fixed + committed 67d654d): the `actable_tab` executor floor refuses acts on human-opened tabs and its error text tells the agent to call `browser_user_claim_tab` — but that command sat in `NOT_MODEL_EXPOSED`, so a model turn on a human tab had NO exit; EASY stalled at the 12-round cap 3× (104 s burned each). Fix: expose the tool (`{tab_id}` required, turn-only claim, never closes the tab, grants no extra host access), `MAX_TOOL_ROUNDS` 12→20, `BROWSER_GUIDANCE` +tab-ownership law +cheap-text-tools bullets. Tool partition now 79 exposed / 4 hidden (`tab_cdp_call`, `tab_cdp_events`, `browser_user_open_tabs`, `browser_annotation_capture`).
- Census logging (temp, dev build) proved the refusal→claim→act sequence live: EASY post-fix rounds = `tabs` → `playwright_dom_snapshot` (ok — observe reads on human tabs are ALLOWED; only acts gate) → `locator_click` REFUSED → `browser_user_claim_tab {tab_id:"2"}` ok → click ok → `locator_inner_text #arrived-marker` ok → snapshot → `complete` finish="stop" ms=40998.
- Recorded green (each: launcher one blocking invocation, exit 0, lock cleanly released): **EASY 49.7 s** (8 rounds, claim at round 4), **MEDIUM 1.8 m** (four-field form fill+submit through the shared human tab, exact echo asserts), **HARD 59.7 s** (`tab_new` → popup adoption inherits opener ownership → `mark_deliverable` → child survives cleanup → `#popup-marker` exact).
- Post-change regression re-records: leg-1 trio via launcher `-TestFiles 'tests/browser-easy.spec.ts','tests/browser-medium.spec.ts','tests/browser-hard.spec.ts'` → **11 passed (6.7 s) exit 0**; ruke-browser lib 170/170; ruke-server lib 106/106 (golden-replay byte contracts NOT broken by guidance/rounds change); `fixture_journeys --ignored` 2/2 (11.78 s).
- Housekeeping notes: an early debug policy PUT left a stray `host:"0.1"` garbage rule in ruke-browser-policy.json (harmless — exact-match lookup never hits it; file is gitignored). Background-tab CDP screenshot once hit the 30 s CALL_TIMEOUT (guidance bullet now steers to text tools). `tests/conversations-live-chat.spec.ts` was NOT run this loop — pre-existing suspect against the hero/panel layout, unverified.

## 2026-11-04 — Web-search audit repair: THE ONE final locked Playwright loop [GREEN — loop CLOSED]
- Protocol: every leg via `powershell -NoProfile -File scripts/run-browser-e2e-exclusive.ps1 -TestFiles <spec> [-Grep "<regex>"]` — the launcher owns `.ai-coordination/playwright.lock` (created/cleared in `finally`), spawns the fixture server :3210 and REUSES the live dev app on :3000. LAW: never `npm run build` while that dev server runs — it clobbers `.next` and zeroes hydration.
- Scoreboard (each leg a real exit 0): government-portal leg **1/1**; Zepto leg **1/1**; `tests/browser-scope-matrix.spec.ts` leg A **4/4** + leg B **3/3** (7/7); `tests/search-gate.spec.ts` **3/3**; Decision Engine leg **1/1 (6.4 s)**.
- Honest failure history (all root-caused, none a product defect): two launcher `-Grep` runs exit 255 — zero tests matched because the regex had no SPACE (law: the -Grep regex must contain a space); Zepto runs 2/2b send-button failures — a concurrent `npm run build` clobbered `.next` of the reused dev server (env defect, legislated above); Decision Engine first live run — 120 s `assistant-message[data-state="complete"]` timeout while the turn was still streaming at 36.6 tk/s (test-design limit on a consumer laptop, NOT a product bug).
- Decision Engine fix (commit `40342ae`, test-only): the leg waits on the FORWARDED REQUEST, not on local generation. The dev chain was temporarily pointed at `scripts/e2e-llm-proxy.mjs` (:8099 capturing + passing through upstream SSE); the test sends with `waitComplete=false` then `expect.poll` (90 s) on `GET :8099/__captured` for bodies containing "quarterly revenue" AND "decision_skill". The capture PROVED the release-blocking guarantee live: exactly one `<decision_skill mode="pdf" decided_by="in-process-deliverable-match">` + one `<core_skill name="pdf">`, zero cross-contamination, verbatim lastUser prompt. Proxy + `LLM_API_URL` override REMOVED after the run — environment back to the plain chain (:3000 + :8080, :8099 closed, lock released).
- Gotchas learned: the supervisor's `taskkill /T /F` tree teardown also kills an externally attached proxy/dev chain when a supervised child exits; scratch helpers go in gitignored `.ai-coordination/` (node fs cannot open Git-Bash `/tmp`); `Test-NetConnection` can report a port open from TIME_WAIT residue — cross-check `netstat -ano`.
- Offline gates after the repair cycle: vitest **92 files / 1122 passed | 1 skipped | 0 failed**; `npx tsc --noEmit` exit 0; `npm run build` clean.

## 2026-11-07 — P7 final loop: pre-removal batch ledger + anatomy removal mid-loop (41 → 38 specs) [RUNNING]
- Every leg via `powershell -NoProfile -Command "& scripts\run-browser-e2e-exclusive.ps1 -TestFiles '…','…'"` — foreground, §1 lock, real exit codes. Ledger below recovered verbatim from the session transcript (never recorded before).
- First 5-spec attempt (conversations-crud, multi-select-delete, recents-controls, recents-modal, edit-stop-collapse) → **launcher death PW_EXIT=1 at ~2 s: "fixture server missing: tests\fixtures\browser\server.mjs"** — the fixture file had been permanently deleted from disk; recovered from transcripts (STATE.md 2026-11-07 fixture section), launcher ~line-108 pre-validation law re-proven.
- B1 `conversations-crud`,`multi-select-delete`,`edit-stop-collapse` → **14 passed (48.2 s), PW_EXIT=0**.
- B2 `recents-controls`,`recents-modal`,`chat-stream`,`token-meter`,`progress-panel`,`reasoning-test`,`auto-compact` → **26 passed (2.2 m), PW_EXIT=0**.
- B3 `greeting`,`conversation-title`,`conversations-live-chat`,`decision-routing`,`retired-fences`,`render`,`inspect-dup` → 33 passed / 1 skipped / **2 failed** (PW_EXIT=1). Both failures were the two live-chat turn tests' wall-clock budgets (measured 30 tk/s CPU latency at 11.4k ctx), NOT behavior. Fixes: `a3b4a78` (patience raised to measured latency) + `92f32bc` (turn prompts bounded "reply with exactly: <token>" — the IQ3_S open-ended CoT runaway class: 240 s still reasoning, ctx 11.4k→20.3k). First rerun of the two specs after `a3b4a78` alone: 2 failed / 5 passed (PW_EXIT=1); after `92f32bc`: **7 passed (47.4 s), PW_EXIT=0 → B3 fully green.**
- B4 `anatomy`,`anatomy-export`,`regression_modalities`,`html-isolation`,`pdf-egress` → **35 passed / 3 pre-existing skips (1.4 m), PW_EXIT=0**.
- B5 `anatomy-repair` → **2 passed (6.4 s), PW_EXIT=0**.
- Pause tally: **23 of 41 specs green**. Then the user amendment landed: anatomy REMOVED entirely (CHANGELOG + STATE.md 2026-11-07) — `anatomy`/`anatomy-export`/`anatomy-repair` specs deleted above are MOOT (inventory now 38); their greens predate removal.
- Post-removal resumption ledger (38 specs): **re-run required** — `decision-routing`, `render` (routing + fence surfaces changed after their pre-removal green), `interactive-ui` (rewritten to the two-retired-cards contract; NEVER run). **Never run** — `abort-family`, `search-gate`, `skills`, `settings-stats`, `web-search-10k`, `file-reading`, `long-doc-retrieval`, `pptx-5a`, `youtube-captions`, `universal-websites`, `tier3b-live`, `form-probe`, `interactive-ui`, `browser-easy`, `browser-medium`, `browser-hard`, `browser-model-acceptance` (only the finding-3 CAPPED leg + the 2026-10-31 journey legs ran green — full suite inside this loop), `browser-scope-matrix` (legs A/B green 2026-11-04; full suite inside this loop).
- Offline gates after removal (all real): tsc 0; `cargo build -p ruke-server` 0 → **ruke-server.exe FRESH, stale-exe precondition CLOSED**; `cargo test --workspace` 0 failed; `npm run contracts:check` 0 (now **7 modes**); full vitest **116 files / 1,559 passed | 9 skipped** exit 0; `npm run build` 0 + 0 anatomy chunks in `.next` (clean — done BEFORE any loop batch; LAW: never build while a reused dev server is live).
- Batch 1 queued: `-TestFiles 'tests/decision-routing.spec.ts','tests/render.spec.ts','tests/interactive-ui.spec.ts'`.

## 2026-11-07 — P7 post-removal loop: batches 1-2 + search-gate root-cause stack (three layers) [search-gate GREEN]
- Launcher invocation (proven 3x): `time powershell -NoProfile -ExecutionPolicy Bypass -Command "& scriptsun-browser-e2e-exclusive.ps1 -TestFiles 'tests/x.spec.ts' -AppWaitSeconds 300"`. Supervisor acquires/releases the lock itself; fixture :3210 REUSED.
- B1 `decision-routing`,`render`,`interactive-ui` → **24 passed / 1 skipped (1.8 m), PW_EXIT=0** (skip = pre-existing render.spec.ts:710 design skip).
- B2 `settings-stats`,`skills`,`search-gate`,`form-probe`,`abort-family` → 15 passed / **1 FAILED** (2.6 m, PW_EXIT=1); sole failure: search-gate test 3.
- Layer 1 (dead contract): spec asserted the gate-era "Model-gated" badge — GONE from the chat path since MHR (6321251). Spec updated WITHOUT weakening: badge-ABSENCE pin added (`research-trail-gate-badge` count 0) + fresh-chat law (model loop receives the app-restored conversation).
- Layer 2 (REAL PRODUCT BUG, fixed app/page.tsx): `getBrowserSession` fallback `"default"` keyed turn 1 of EVERY new chat into the shared `default.research.json` journal (24 polluted turns observed) → cross-chat rehydration injected foreign travel queries (GSRTC/Udaipur→Modasa) into fresh GPU-price turns. Fix: lazily mint a real `c_` uid on first send (ref sync + setActiveId); deleted poisoned `default.research.json`. Re-run proved per-chat journals + subject-anchored queries.
- Layer 3 (REAL UI-TRAIL DEFECT, fixed components/ChatMessage.tsx:294-305 mount gate): `ProcessingStatus` mounted only `streaming && !content && !reasoning`. Under MHR the CoT reasoning streams BEFORE web rounds AND narration content releases before `web:tools` (web_loop.rs WS06 relay :58/:685), so citations can NEVER coincide with the old gate — `web-search-toggle`/`research-trail-card` unreachable on every fresh model-directed chat (throwaway SSE probe: web_meta cit=6 frames arrived, pills rendered, toggle never mounted). Fix: mount while `streaming && (webCitations present || (!content && !reasoning))` — line stays clickable alongside streamed text; memo law (§5.3) untouched (default shallow `memo()` already re-renders on webCitations). ProcessingStatus.tsx header comment corrected.
- Spec pin honesty: popup renders hostnames ONLY under MHR (query lines are gate-only) → positive /nvidia|rtx/ host match impossible for perfect runs; replaced with negative guards for the two documented signatures (original junk pool + travel contamination); subject anchor is structurally enforced by the metasearch relevance floor (unit-covered).
- search-gate re-runs: run A (after page.tsx fix) failed at toggle :171; run B (after mount fix) failed ONLY at the dead positive-host pin :195; run C after pin fix → **3 passed (2.7 m), PW_EXIT=0. Batch 2 fully green.** tsc 0 at each step.
- Note: greeting.spec (guards the same toggle contract) was green pre-fix; the mount change only ADDS mounts when citations exist — re-run it with a later batch for coverage.
