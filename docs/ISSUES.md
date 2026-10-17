# ISSUES

## Confirmed and fixed
- Studio viewer "view anchored top-right, black gap left+bottom, right side
  stripped" + dead Fullscreen button (user screenshot 2026-10-18, pixel-
  forensics on the screenshot via PIL — NOT a dock-overlay issue; this
  DISPROVES finding (3) of the entry below, which had recorded the symptom
  as "did NOT reproduce"). ROOT CAUSE: `renderGizmo()` in
  `lib/three3d/studioEngine.ts` monkey-patched `renderer.setViewport` to a
  corner-offset transform so the ViewHelper gizmo drew top-right. But
  r186 `ViewHelper.render()` SAVES the viewport (`getViewport`) and
  RESTORES it via `setViewport(viewport.x,viewport.y,viewport.z,viewport.w)`
  — the patch mangled that restore too, leaving the renderer viewport at
  `(dw−dim, dh−dim, dim, dim)`; every subsequent frame the MAIN scene
  rendered into that top-right sub-viewport → pure-black (0,0,0) bands
  left/bottom, right edge cut. Measured on the screenshot: buffer 1309×563,
  rendered region exactly (330,14,979,549) = the patched-restore fixed
  point (self-perpetuating; only a container-resize `setSize` repaired it).
  Compounding bug: `new ViewHelper(camera, this.scene)` passed the SCENE as
  domElement → `offsetWidth/Height` undefined → NaN gizmo coords (why the
  patch seemed necessary). FIX (studioEngine.ts): pass
  `renderer.domElement` as ViewHelper domElement (constructor + projection
  switch), position the gizmo via the supported
  `viewHelper.location = { top:12, right:12, bottom:0, left:null }`, DELETE
  the setViewport monkey-patch, keep `autoClear=false`, and restore
  `setViewport(0,0,size.w,size.h)` in `finally` + before every main render
  in `tick()` (self-healing). FULLSCREEN: `void target.requestFullscreen()`
  swallowed rejections (insecure context / sandboxed iframe → silent no-op);
  ThreeStudioViewer.tsx now catches and falls back to a CSS maximized mode
  (`.scene3d-block.is-maximized` fixed-inset rules in globals.css, toggled
  by `isMaximized` state; button aria-pressed/label cover both modes).
  Gates: tsc clean, vitest 407 passed | 1 skipped. No Playwright (user
  constraint).
- Studio viewer "right side stripped / black space / stray TOP FRONT RIGHT
  text" + collapsible docks feature (user screenshot, 2026-10-18, browser-
  proven, app-dev session): THREE findings. (1) TOOLBAR CUTOFF — live probe
  showed `.scene3d-toolbar.cad-ribbon-bar` scrollWidth 1891 > clientWidth
  ≤1058 with `flex-wrap:nowrap` + `scrollbar-width:none`: the transform,
  overlays, FULLSCREEN and EXPORT groups were unreachable off-card. FIX:
  `.scene3d-toolbar.cad-ribbon-bar { flex-wrap: wrap; height: auto;
  min-height: 38px; overflow-x: visible }` in `app/cad-studio.css` — the
  studio ribbon wraps to 2 rows (h 94 px); the CAD ribbon stays nowrap and
  fits (its `scrollWidth−clientWidth ≤ 0` e2e guard is CAD-only, still 0).
  (2) STRAY VIEWCUBE TEXT — the HTML ViewCube buttons had NO styling at all,
  so they read as floating raw text over the viewport. FIX: chip chrome on
  `.cad-viewcube button` (20 px, mono 9 px, dark bg + subtle border, cyan
  hover); position unchanged (below the in-canvas ViewHelper gizmo, above
  the right dock) — all `scene3d-viewcube-*` / `cad-viewcube-*` testids
  intact. (3) "BLACK SPACE bottom/left, content top/right" did NOT
  reproduce as a render bug (canvas rect == stage rect == buffer, camera
  aspect 1.7778, at 1472×950 AND 1744×1225) — it is the OPAQUE dock
  overlays (left 190 px + right 224 px + bottom bar) covering the scene.
  FIX = the requested COLLAPSIBLE DOCKS feature: chevron in every dock
  header (`scene3d-dock-left-toggle`, `scene3d-dock-right-toggle`,
  `cad-dock-left-toggle`, `cad-dock-right-toggle`) unmounts the dock and
  shows a reopen chip (`scene3d-dock-left-open` "OUTLINER" top-left,
  `scene3d-dock-right-open` "SCENE" bottom-right, `cad-dock-left-open`
  "LAYERS" / `cad-dock-right-open` "CONTROLS" at top corners); default
  OPEN, selection state survives collapse. Files: ThreeStudioViewer.tsx,
  ArchitectureCadViewer.tsx (state + titlebars + conditional docks +
  reopen chips), app/cad-studio.css (ribbon wrap + viewcube chips +
  `.studio-dock-collapse`/`.cad-dock-collapse`/`*-dock-reopen` chrome).
  Verified live: ribbon scrollW==clientW 1056 with Fullscreen+Export
  visible; collapse→reopen round-trips in BOTH viewers; screenshots
  `%TEMP%\webui-recon\fixed-{open,collapsed}.png` + `cad-collapsed.png`.
  Gates: tsc clean, vitest 407|1, headed suite 6 passed run #10, then
  run #11 GREEN with new collapse guards in both coverage tests.
- Giant dark DISC behind the wrapped "CUSTOMER SEATING AREA" pill at fit
  zoom (found during live verification of the text-sizing fix below,
  2026-10-17, browser-proven): a ~150 px round dark blob + the first
  wrapped line ("CUSTOMER ") not painted, ONLY on the one tag whose name
  wraps to 2 lines via `<tspan>`; gone after any zoom-out/zoom-back.
  DOM geometry was correct (rect 102×34, tspans normal) — it is a
  Chromium PAINT bug: the `.cad-svg-canvas text` halo (stroke #060a12,
  3.5px, round caps, `paint-order: stroke`, `vector-effect:
  non-scaling-stroke`) is mis-rasterized for tspan-wrapped text — the
  halo paints at ~3.5 USER units (≈142 px disc) and drops a line.
  Single-line tags are unaffected (non-scaling-stroke works there).
  FIX: room-tag pill text opts out of the halo entirely — new CSS rule
  `.cad-svg-canvas g.cad-room-tag text { stroke: none; }` + `className=
  "cad-room-tag"` on the tag group (`app/cad-studio.css`,
  ArchitectureCadViewer.tsx). Presentation attr `stroke="none"` does
  NOT work (CSS rule wins specificity) — must be a CSS rule or inline
  style. The opaque pill fill (#0b101b / #ffffff) carries legibility.
  LAB-stress paint guard rewritten: asserts EVERY room-tag text has
  computed `stroke === "none"` (was: vectorEffect+stroke-width check,
  which passed while the blob painted — computed style lies here, only
  pixels told the truth). Verified: fresh-load fit screenshot clean
  (`.data/tmp/disc-Q-fresh.png`), both lines + sub crisp, no disc at
  fit/200/400. Gates: tsc clean, vitest 407|1, headed suite **6 passed
  run #9**.
- CAD sheet "text is a little big and going out of the space … make it
  professional and neat" (user screenshot, Modern Tech Coffee Kiosk): zone
  labels rendered as RAW text entities at `fontSize={entity.height}` (model
  units → ~12-16 px at fit, huge when zoomed) and wider than their rooms.
  ROOT CAUSE: room-tag pills only seeded from MIDDLE-anchored texts inside
  room POLYGON entities — the kiosk spec has no room polys (walls only), so
  all 4 labels stayed oversized plain text spilling over walls. FIX (three
  layers): (1) `raycastRoomRect()` in `lib/cad/cadBlocks.ts` derives the
  interior room rect by 4 axis rays against wall centerline segments (inset
  half-thickness; maxReach = plan maxDim so open zones merge truthfully,
  text outside the envelope still misses a ray → stays plain); any-anchor
  annotation texts inside a poly OR a raycast room become pills (label
  center approximated for start/end anchors). (2) `layoutRoomTags` now
  WRAPS long names to 2 balanced lines at a word boundary (trailing space
  keeps textContent == full name for e2e `hasText`), shrinks font only as
  last resort (floor 0.8, was 0.6 → 5.4 px unreadable), grows pill h to
  34·s, and constrains placement INSIDE the room rect (ring search +
  room-center clamp). (3) leftover plain text entities capped at 13 px on
  screen (`Math.min(entity.height, 13/pxPerModel)`). Live verification
  (cadfix session, kiosk conv): all 4 labels → pills, nameFontPx 9 at fit
  AND at 400% zoom (scale 40.7→162.9, pill 102-138 px constant),
  textOverflowsPill false everywhere, 0 plain annotation texts left;
  CUSTOMER SEATING AREA wraps 2 lines. New unit tests
  `__tests__/cad/cadRoomTags.test.ts` (5): raycast enclosure/reach-null,
  wrap+textContent intact, single-line wide room + containment, obstacle
  ring nudge.
- CAD sheet "export sliced to half / right part cutting" (user screenshot,
  Modern Tech Coffee Kiosk): TWO stacked layout defects, both measured live
  (playwright-cli `cadfix`): (A) RIBBON OVERFLOW — `.cad-ribbon-bar`
  scrollWidth 1103 > clientWidth 850 (chat column ~768 px) with
  `scrollbar-width:none`, so the Export select+button sat at x=1372, off the
  852 px card — literally sliced. FIX: view-tab labels "2D CAD/Iso Cutaway/
  3D BIM" → "2D/Iso/3D" (+title tooltips), zoom "100%" → "1×", removed the
  decorative "ARCHITECTURE CAD" ribbon span, tightened ribbon gaps/padding +
  select max-width 128 px, `white-space:nowrap` on ribbon buttons →
  scrollWidth == clientWidth == 850, Export fully on-card. (B) DOCK-HIDDEN
  DRAWING — the docks are absolute 230 px overlays; `fitView` fit the bbox
  against the FULL stage width, so ~127 px of the plan (right exterior wall)
  sat under the near-opaque right dock. FIX: `fitView(bbox, {w,h,insetX})`
  is now DOCK-AWARE (scale chosen against the visible band, viewBox sized to
  stage/s so `meet` centering lands content between the docks); component
  snaps the initial view to it once via `initialFitDone` ref after the first
  ResizeObserver measurement (user pan/zoom untouched afterwards); zoom-fit +
  100% reuse the same `fit`. Guards added to the CAD coverage test:
  ribbon scrollWidth-clientWidth ≤ 0, Export box inside `.cad-workstation-
  shell`, and every `g[data-layer]` shape's screen CTM within
  [stage.x+238, stage.right-238].
- CAD sheet "big circles around the text" (user screenshot, Sustainable
  Innovation Lab): giant ~270-300 px dark blobs merging behind every room-tag
  pill. ROOT CAUSE: `app/cad-studio.css` `.cad-svg-canvas text` halo rule
  (`paint-order: stroke fill; stroke: #060a12; stroke-width: 3.5px;
  stroke-linecap: round`) — SVG `stroke-width` is in USER UNITS, and the
  viewBox is ~24 model units across an ~850 px stage (1 unit ≈ 36 px), so
  "3.5px" painted as ~126 px of round-capped stroke per glyph; adjacent glyphs
  fused into blobs (blob pixel = exactly #060a12, the stroke color). The SVG
  DOM was 100% clean (pills w=4.48 h=0.72) which is why the geometry-based
  e2e suite stayed green — bug was paint-only, found by pixel-sampling the
  screenshot PNG. FIX: `vector-effect: non-scaling-stroke` on the text rule
  (stroke-width then means device px, like the shapes' `vectorEffect` attr).
  Regression guard added: paint assertion in the LAB stress test checks
  `getComputedStyle(text).vectorEffect === "non-scaling-stroke"` + stroke ≤5.
- User-reported "a lot of buttons and components are not working at all":
  full live click-through audit (playwright-cli session `cadfix`, 28 checks)
  → ALL controls functional, zero page/console errors (zoom fit/200/400
  viewBox math, tool arm/disarm aria-pressed, snaps, theme select → inline
  bg, layer hide/opacity 0.4/solo/lock-disables-opacity, DXF+SVG downloads,
  2d/iso/3d/split stages, fullscreen, cursor readout `X: 8.8 Y: 5.8`).
  Perceived breakage = right-dock 3D controls (Explode/Wall Height/Sections/
  Sun) disabled by design in the default 2D view with NO explanation. FIX:
  `cad-dock-hint` banner in the right dock (2D only) + `title` tooltips on
  every disabled control; coverage test asserts hint visible+explode disabled
  in 2D, hint gone+enabled in 3D. Audit false-fails were test artifacts:
  `snapGrid` defaults ON (`useState(true)`), default theme is
  `CAD_THEMES[0]` = autocad-dark, not thermal.
- 3D canvas SOLID BLACK though HUD reported 180 FPS · 8 meshes: two stacked
  causes. (A) r186 `ViewHelper` (now `three/examples/jsm/helpers/ViewHelper.js`)
  `render()` has no scissor/clear guard — its inner `renderer.render()`
  autoCleared the WHOLE canvas (black, no scene.background) each frame and
  wiped the main pass. Fixed: `renderGizmo()` renders the gizmo as a
  depth-cleared top-right overlay with `renderer.autoClear=false` (ViewHelper
  clears depth itself; r186 never calls setScissor — an earlier setScissor
  patch was dead code). (B) Selection deselected by dock clicks: pointerup
  was on the stage WRAPPER, dock button clicks bubbled → pick → null. Fixed:
  `e.target !== canvasEl` guards in ThreeStudioViewer onPointerUp/onPointerMove.
  Proven headed: `tests/studio-viewers-visible.spec.ts` 2/2 +
  `test-results/canvas-proof.png` shows the drone visibly rendered.
- r186 API drift gotchas: `renderer.viewport` property REMOVED (use
  `getViewport()`); a Promise/async-IIFE inside a `page.evaluate` return
  object serializes to `{}` — keep evaluate returns synchronous.
- CAD stage rendered empty: `lib/cad/normalizeCad.ts` omitted layer
  `visible`/`opacity`/`locked` when the model didn't write them; the viewer
  then treated layers as hidden. Fixed: always emit the defaults.
- `this.axes.visible=false` in studioEngine (grid/axes default mismatch).
- Model-authored COMPACT fences still hit random syntax holes (user's 2nd
  Aetherion attempt: "Expected ':' after property name in JSON at position
  17084") — emission discipline reduces but cannot guarantee error-free
  20 KB JSON. Fixed at the app level: silent repair loop (see CHANGELOG)
  feeds the exact error back to the model and splices the corrected fence
  into the same bubble; the user only ever sees the error note if BOTH
  repair rounds fail. Gotchas: the repair request must contain "anatomy
  illustration" or `detectAnatomyIntent` won't re-inject SKILL.md for the
  repair turn (`injectSkillPacks` only inspects the LAST user message) —
  unit test guards this; top-level `label` is REQUIRED (anatomySchema.ts:
  388) — a test fixture without it failed zod before the intended error.
- User-reported "Anatomy illustration data did not validate" on a model-authored
  Aetherion fence: NOT a runtime bug — the model's 45 KB JSON was malformed.
  Extracted from `~/.local-intelligence/conversations`: one JSON syntax hole
  (rod `col4` path `[,-55,240]` — missing first coordinate, char 21819) and,
  after repairing it, 42 zod issues `parts.N.r Required`. ROOT CAUSE OF THE
  ZOD WAVE WAS OUR DOCS: `rodPart` requires `r` (anatomySchema.ts:142) but
  SKILL.md's rod line never documented it — the model followed the docs and
  all 37 rods failed. Fixed: rod line now names `r`, plus a "JSON emission
  discipline" section (compact single-line JSON, never `...` skeletons,
  fixed-length coordinate arrays, required-field cheat sheet, ≤20k-char size
  rule). A later message emitted a `...`-elided skeleton instead of the real
  fence — also covered by the new rules. Fallback-to-source is correct
  behavior; the error note now shows the exact first issue (`parseJsonFence`
  returns V8's parse message / `path: message (+N more)`).
- Anatomy SVG/PNG downloads exported a lucide icon, not the figure:
  `standaloneSvgMarkup` used `querySelector("svg")` and the download-button
  icon svg came first in DOM order. Fixed: `querySelector("svg.anatomy-svg")`
  (same trap as the `svg` selector matching lucide elsewhere). PNG test now
  asserts IHDR dims 1280×1040 so a stray icon can never pass again.
- TS narrowing lost on zod `safeParse`: replacing a narrowing `throw` with
  `console.log` + `expect(parsed.success).toBe(true)` left `parsed.data`
  possibly-undefined (TS18048/TS2345 in `stress.test.ts`). Keep a `throw`
  branch before using `parsed.data`.
- Anatomy builder warned per part ("no explode offset") — 493 warning lines
  at AETHERION scale flooded the block's warning strip. Fixed: aggregated
  into one line with the first offender named.
- Explicit "Use the Anatomy skill" prompt fell back to `scene3d`: the
  detector's early return `if (wantsMesh || excluded)` fired on BOTH the
  mode-D exclusion ("architectural"/"building") and `MESH_REQUEST`
  (`/\bmesh(es)?\b/i` matched the prompt's own "not a genuine 3D mesh"
  disclaimer). Fixed: `EXPLICIT_INVOCATION` override — naming the Anatomy
  system beats the exclusion and weak mesh wording; only a NAMED format
  (GLB/STL/…) still wins. Proven: intent tests 9/9.
- `conversations-crud` unarchive test failed after `page.reload()`:
  `handleToggleArchive` is GET→POST→refresh, and the immediate reload
  aborted the in-flight POST, so the reload read back `archived:true` and
  the item stayed hidden in the collapsed Archived section. Pre-existing
  test race, not an app bug. Fixed: `waitForResponse` for the OK POST to
  `/api/conversations` before reloading. CRUD spec 7/7 deterministic.
- Anatomy demo figure 2 (dial indicator) failed zod: `planSchema` requires
  `r` (no default) and the jewel's plan omitted it → only 3 of 4 figures
  rendered. Fixed: `r: 0`. `__tests__/anatomy/demo.test.ts` now validates
  every showcase fence through the builder, so a bad fixture fails vitest
  instead of silently dropping a figure.
- Full `tests/file-reading.spec.ts` runs exceed the 9-minute Bash cap on
  this machine: every "the model reads the file" fixture does a real
  llama.cpp :8080 inference turn (~5 s × 106). Pre-existing, unrelated to
  current changes. For regression run `--grep "reaches the server"`
  (layer 1: 106/106 in ~12 s).

## Confirmed and fixed (earlier)
- `conversations-crud` "archive hides from main list" failed reproducibly
  after a killed full-suite run: the seeded `c_arch_*` conversation stayed on
  disk (`~/.local-intelligence/conversations`) with `archived:true`, and the
  Sidebar shows the "Archived · N" button whenever ANY archived conversation
  exists, so the test's global `toHaveCount(0)` on that button broke even
  though its own conversation unarchived correctly. Not an app bug. Fixed:
  stale row removed via `DELETE /api/conversations/{id}`; the assertion is
  now scoped to the seeded conversation (open the Archived section if
  present, assert the title is absent there). CRUD spec 7/7.
- "Syntax error in text / mermaid version 12.2.0" boxes stuck at the bottom of the
  page (from an AI-generated diagram with unescaped quotes: `cartEmpty[Display "Cart
  is empty"]`). Mermaid 12.2.0's `renderDiagram` draws the error SVG into a temp
  `div#d<id>` appended to `document.body`, then throws *before* `removeTempElements()`
  runs — the box is never cleaned up (one per failed attempt, hence duplicates during
  streaming). Fixed: `suppressErrorRendering: true` in `mermaid.initialize`
  (mermaid `config.type.d.ts:346`) — mermaid removes the temp elements and throws;
  `MermaidBlock`'s existing catch shows the source fallback.
- Mermaid step playback highlighted nothing (mermaid 12.2.0): node DOM ids nest
  the render id — `mmd-1-flowchart-intake-0`, not `flowchart-intake`. The old
  `^flowchart-` anchor never matched. Fixed: `normalizeNodeId` splits on
  `lastIndexOf("flowchart-")` + strips the trailing `-\d+`.
- Mermaid edge glow never matched: `data-edge` is just `"true"` in mermaid 12 —
  endpoints live only in the path id `mmd-1-L_<src>_<tgt>_<n>`, and node ids can
  contain underscores. Fixed: `edgeEndpoints(edgeId, nodeIds)` splits the joined
  pair against the known node-id set instead of a naive `_` split.
- Highlight classes + node click listeners vanished ~1s after being applied:
  `dangerouslySetInnerHTML` on the diagram canvas makes React re-set innerHTML on
  every re-render (new `{__html}` object identity), wiping all imperative DOM
  state. Fixed: the interactivity effect injects `stage.innerHTML = svg` itself.
  Proven: persistence probe (active 1 / dimmed 3 / edge 1 after 900ms) + spec
  re-asserts counts after an 800ms wait.
- Most languages rendered colorless: grammars embed others (cpp→regexp, vue→vue-directives,
  typst→tex…) and deps were never loaded; the first failure (cpp) left unresolved imports
  that made every later `loadLanguage` throw with an accumulated missing-list (python
  passed in isolation but failed in the 139-key run). Fixed: recursive `loadGrammarTree`
  + highlighter reset on any load failure. Do not rely on `embeddedLangsLazy` — those are
  deliberately not auto-loaded.
- Re-keying a grammar to its registry key (postgresql→sql, protobuf→proto, lean4→lean)
  must strip the new key from the old grammar's `aliases`, or Shiki throws
  "Circular alias X -> X" and the bad alias leaks into later loads (coq/docker failed
  with lean4/protobuf's errors).
- Mid-stream highlighting never painted: the `seq === highlightSeq` guard discarded every
  in-flight result while chunks kept arriving (seq advanced every 200ms; highlighting took
  longer). Fixed with monotonic `appliedSeq` — paint unless older than what already painted.
- Tree collapse left a 15.6px gap: Chrome floors a bare `0fr` track at the content's min
  contribution; `min-height:0` on the item does not lift the track's auto minimum. Use
  `minmax(0, 1fr)` → `minmax(0, 0fr)`.
- Model said "I can't hear the spoken narration" on uploaded videos. Root cause: the
  `video` case in `lib/server/extract/index.ts` never touched the audio track (only
  `videoFrames()`), and the `video` branch of `attachmentParts()` in `lib/chat/client.ts`
  ignored `transcript`. Fixed: videos get Whisper-transcribed audio when they have an
  audio stream, and the transcript rides into the prompt beside the frames. Proven by
  `__tests__/video-narration.test.ts` (narrated mp4 → transcript contains "zephyr").
  Note: narration is capped at `MAX_AUDIO_SECONDS` (180 s) like audio files.
- Scroll jitter during generation (view bounced top/bottom, "Jump to latest" appeared).
  Root cause: a smooth `scrollIntoView` per streamed chunk cancelled the previous animation
  and lagged growing content past the 120px threshold, flipping `hasScrolledUp` and
  oscillating. Fixed with an rAF-coalesced instant `scrollTop` pin + wheel-up disengage in
  `app/page.tsx`. Proven by `scripts/scroll-verify/check.mjs` (old FAIL / fixed PASS).
- Model said "I don't see any image attached" → attachments never reached the prompt.
  Fixed by the extract route + `attachmentParts()` in `lib/chat/client.ts`. Verified by
  106 headed model turns.
- `Unsupported file type: fixture-dockerfile / fixture-makefile` — **fixture naming bug**,
  not a classifier bug. Fixtures are now `fixture.Dockerfile` / `fixture.Makefile`.
  Do not "fix" `classifyFile` for this; `NAME_CATEGORY` already handles bare names.
- Hand-written tar header was invalid (checksum summed with the field zeroed, and a 9-byte
  field overwrote the typeflag at byte 156). Fixed: space-fill 148..156 before summing,
  write `padStart(6,"0") + "\0 "`.
- Nested archives lost their members → `flattenMembers()` in `lib/server/extract/archives.ts`.
  Bare `.bz2`/`.xz` streams store no filenames → `nameBareStream()` recovers the inner name
  from the uploaded file name.

## Dead ends — do not retry
- Anatomy schema coords are capped ±600 and solid `height` ≤300: an 80-floor
  tower needs a 7-unit floor pitch (not 24) and tall cores/columns/risers
  must be split into stacked segments.
- Advanced toggle ids derived from group ids use the FULL capitalized group
  id (`tCirculation`, not `tCirc`) — readout formulas referencing a short
  name fail superRefine.
- TSX export embeds the plate as a JS string literal: assert the ESCAPED
  form `data-part=\"...\"` in the downloaded file, not raw `data-part="..."`.
- Over-budget rendered count = top-level + Σ floors×module parts
  (anchor + 8×100 = 801, not 800).
- Mermaid wipe debug theories disproven (do not re-investigate): component
  remount (dataset probes survived), render-effect re-run (step count stayed
  "Step 1/4"), svg string change (render id stayed `mmd-1`). The wipe was
  `dangerouslySetInnerHTML` re-injection — see Confirmed and fixed.
- Playwright `CI=true` here enables `retries: 2` and triples the run time.
- Playwright `route.fulfill` delivers the whole SSE body in one chunk — the message flips
  to "complete" before async highlighting can paint. Mid-stream tests need a real paced
  http server + `route.continue({ url })`.
- `getComputedStyle().gridTemplateRows` always reports used px — asserting `"0fr"` can
  never match; assert `"0px"`.
- `7za a -tbz2` → "Unsupported archive type" (7za reads bz2, cannot write it). Use `bzip2`.
- `drawtext` with `fontfile=` before `textfile=` → "Both text and text file provided".
- `System.Speech...SetWavOutputFile` → method not found. Use COM `SAPI.SpFileStream` +
  `SAPI.SpVoice`; do not set `Format.Type`, do not call `.Dispose()`.
- `scale=min(1280,iw):-2` unescaped → "No such filter: 'iw):-2'". The comma needs `\,`.
- ICO via png codec → "PNG in ico requires pixel format to be rgba"; `-update 1` produced a
  4-byte file. Use `-vf scale=256:256,format=rgba`.
- `execSync("pdftotext …")` depended on PATH. Use `unpdf`.
- `require("7zip-bin")` under ESM → use `await import("7zip-bin")` + `.default?.path7za`.
- Relative `node_modules/ffmpeg-static/ffmpeg.exe` paths break when the shell cwd drifts —
  always absolute.
- Playwright `fill()` on the controlled hero textarea reports success but React state never
  syncs → Enter early-returns and the DOM value reverts. Use `pressSequentially` instead.
- `[aria-label="Send message"]` exists only on the unused `HeroComposer`; `ChatInput`'s send
  button is `[data-testid="send-button"]`.

## Untestable by construction
- `.rar` (no writer exists), `.heic`/`.heif` (bundled ffmpeg has no HEIF encoder or demuxer).
  The app still routes them; the failure surfaces on the attachment chip.

## Environment notes
- The dev server dies with the shell that started it — restart `npm run dev` and wait for
  `Ready` before running the suite, or every Layer 2 test fails with `ERR_CONNECTION_REFUSED`.
- Next dev server hot-reloads route/server modules; no restart needed for `lib/**` edits.
- Playwright `--headed` works because no project pins `headless` in `playwright.config.ts`.
- `npx next start & … kill $SRV` kills only the npx wrapper; the next-server
  child keeps port 3000 → the next run dies EADDRINUSE and Playwright
  silently tests the STALE build. After every run kill by port:
  `PID=$(netstat -ano | grep -E ":3000 .*LISTENING" | head -1 | awk '{print $NF}'); taskkill //PID $PID //F`.
- Each `?demo=anatomy` (or `?demo=ui`) page load persists a NEW `c_*`
  conversation to `~/.local-intelligence/conversations` (page.tsx persist
  effect). Clean test artifacts by id prefix (`c_arch_`, `c_del_`,
  `c_new_`, `c_pin_`, `c_ren_`, …) and by content `demo-anatomy`.
