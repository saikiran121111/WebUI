# STATE

## Done (locked — do not re-read)
- [x] CAD "text too big / going out of its box" report (2026-10-17, LOCKED,
      browser-verified): kiosk room labels rendered as RAW model-sized text
      (fontSize = entity.height → scales with zoom, spills over walls)
      because the pill system required anchor "middle" + a room POLYGON and
      the kiosk spec has walls only. Fixed: (1) `raycastRoomRect()` in
      `lib/cad/cadBlocks.ts` derives a room rect by 4 axis-aligned rays from
      the label center against wall centerlines (inset half thickness; null
      if a ray misses or reach > plan maxDim — open zones merge truthfully,
      text outside the envelope stays plain). (2) Any-anchor centering
      (start/middle/end via approxW = len×h×0.62). (3) `layoutRoomTags`
      word-wraps long names to 2 lines (trailing space on line 1 keeps
      textContent intact for Playwright hasText), screen-constant 9px font
      (fontSize = 9×scale/pxPerModel), fontScale floor 0.8, pill contained
      in room (avail = room.w×ppm×0.86), ring-search anti-collision.
      (4) Plain text entities capped at 13 px screen
      (`Math.min(entity.height, 13/pxPerModel)`). Live proof: 4 pills at
      fit AND 400% zoom, nameFontPx 9.0 constant, pillW 102–138 px
      constant, textOverflowsPill false, plain [] — screenshots
      `.data/tmp/cad-tags-fit.png` / `cad-tags-200.png`. New unit tests
      `__tests__/cad/cadRoomTags.test.ts` (5). FOLLOW-ON REGRESSION FIXED
      (same day, browser-verified): wrapped 2-line pills showed a giant
      dark DISC + dropped first line at fit = Chromium mis-paints the
      `.cad-svg-canvas text` halo on tspan-wrapped labels (paint-only;
      computed style lies). Fix: `className="cad-room-tag"` on the tag
      group + CSS `.cad-svg-canvas g.cad-room-tag text { stroke: none; }`
      (presentation attr `stroke="none"` does NOT work — CSS wins; do not
      remove). LAB paint guard rewritten: asserts computed
      `stroke === "none"` on ALL room-tag texts. Clean proof
      `.data/tmp/disc-Q-fresh.png`. Gates: tsc clean, vitest **407
      passed | 1 skipped** (35 files), headed suite **6 passed run #9**.
      Details docs/ISSUES.md.
- [x] CAD "export sliced / right part cutting" report (2026-10-17, LOCKED,
      browser-verified): (A) ribbon overflowed the 768 px chat column
      (scrollWidth 1103 > 850, hidden scrollbar) burying Export off-card —
      fixed via shorter view-tab labels (2D/Iso/3D + titles), zoom "1×/2×/
      4×", removed "ARCHITECTURE CAD" ribbon span, tighter gaps + select
      max-width, nowrap. (B) `fitView` in ArchitectureCadViewer.tsx is now
      DOCK-AWARE (`{w,h,insetX:246}`; initial snap once via `initialFitDone`
      ref after first ResizeObserver) so no geometry hides under the 230 px
      absolute docks. Coverage test guards: ribbon no-overflow, Export
      inside shell, layer shapes within dock-clear band. Gates: tsc clean,
      vitest 402|1, headed suite 6/6 + guard run green. Details docs/ISSUES.md.
- [x] CAD blob + "buttons not working" report (2026-10-17, LOCKED,
      browser-verified): (1) Giant dark circles behind room-tag text =
      `.cad-svg-canvas text` CSS halo painted in SVG USER UNITS (3.5 units
      ≈ 126 px round-capped stroke/glyph, color #060a12). Fixed in
      `app/cad-studio.css` with `vector-effect: non-scaling-stroke` (+
      explanatory comment — do NOT remove). (2) Full live control audit
      (playwright-cli `cadfix`, 28 checks): every ribbon/dock/export/view/
      tool control functional, 0 page errors — perceived breakage was the
      2D-disabled right-dock 3D controls with no affordance. Fixed in
      `components/render/ArchitectureCadViewer.tsx`: `cad-dock-hint` banner
      (2D only, styled in cad-studio.css) + `title` tooltips on Explode/
      Wall Height/Sections/Sun/section-value sliders. (3) New E2E guards:
      paint assertion (vectorEffect/stroke-width) in LAB stress, hint+
      tooltip assertions in CAD coverage test. Gates: vitest 402|1 skip,
      tsc clean, headed suite **6 passed run #5**. Details docs/ISSUES.md.
- [x] 2000x studio upgrade vs Revit/AutoCAD Architecture 2026 (2026-10-17,
      ALL 5 PARTS LOCKED, browser-verified):
      PART 1 `app/cad-studio.css` — Autodesk/Blender workstation chrome:
      `:root` tokens (--cad-bg-canvas #060a12 … --cad-accent-cyan #38bdf8,
      mono font stack), `.cad-workstation-shell` (680px, radial gradient,
      shadow), `.cad-ribbon-bar` 38px, `.cad-dock-left/-right` (absolute
      top:46px bottom:42px w:230px, backdrop-blur 12px), `.cad-status-bar`,
      mono SVG text w/ 3.5px #060a12 halo, `.cad-viewcube-cad/-studio`,
      `.cad-pane-3d/.cad-bim-host` positioning.
      PART 2 ArchitectureCadViewer dual engine — 2D AutoCAD blueprint:
      double-lined walls + `<pattern id="cad-wall-hatch">` 45° poché,
      door leaf + 90° dashed swing arc, triple-line glazing + mullions,
      procedural furniture CAD blocks (#94a3b8, never neon), MEP dashed +
      junction nodes, dimension chains w/ 45° slash ticks, structural grid
      axes A–D/1–4 + bubbles, anti-collision room-tag pills (name +
      `m² · W×Hm` row). New `lib/cad/cadBlocks.ts` (452 lines:
      offsetPolyline/hatchFillPath/doorSymbol/windowLines/furnitureBlock/
      gridAxes/layoutRoomTags). Revit 3D BIM cutaway: extruded walls
      (2.8m/0.2m), openings, 3D furniture, circulation tubes,
      EdgesGeometry(geo,15) cyan LineSegments on every mesh, ViewCube
      TOP/FRONT/RIGHT/ISO NE/ISO SW, Wall Height slider, X/Y/Z section
      clipping.
      PART 3 ThreeStudioViewer — compact single-row ribbon (Shading/Camera/
      Transform/Overlays/Export) + ViewCube; grid at y=box.min.y; dark
      ground + contact shadow; Bloom auto-on when emissive (HalfFloatType
      composer); 3D contract forbidding lazy 4-primitive scenes (12–25
      named sub-meshes, Extrude bevels, Lathe, Tube, emissive vents,
      EdgesGeometry accents).
      PART 4 `lib/skills/coreRouter.ts` ARCH_CONTRACT — double-lined walls,
      explicit doors (hinge/width/swing) + windows (sill/mullions), rich
      furniture categories, column grids, dimension chains.
      PART 5 tests — `playwright.config.ts` slowMo:300;
      `tests/studio-viewers-visible.spec.ts` (885 lines) 6 tests: drone,
      kiosk, MECHA stress (17 named meshes, emissive visors, explode,
      ViewCube), LAB stress (hatch, 5 doors, 6 windows, 18 furniture,
      grid, pill non-overlap, BIM ≥40 meshes), CAD + studio button-coverage
      checklists. HEADED run #4: **6 passed (1.6 m)** — 100% pass rate.
      Unit gate `npx vitest run` 402 passed | 1 skipped; `tsc --noEmit`
      clean. GOTCHAS (see docs/e2e-test-state.md): ribbon `cad-tool-*`
      clicks re-scroll the chat container (~270px) → ALWAYS
      `stage.scrollIntoViewIfNeeded()` + re-read `boundingBox()` AFTER
      arming each tool; render-gated testids (timeline needs
      `spec.animations`, sliders need `spec.sliders`, `cad-toggle-flows`
      needs non-empty `spec.flows`, material inspector needs a selected
      outliner row) → assert count 0 for code scenes.
- [x] Viewer size + 16:9 + fullscreen (2026-10-17): both studio viewers were
      width-capped by the 768px chat column. `app/globals.css`: `.chat-messages-scroll`
      gets `container-type: inline-size`; `.scene3d-block, .cad-block` break out
      to `--render-wide-w: min((100cqi - 2rem) * 0.882, 1058px)` (sidebar-aware, centered
      via negative margin); `.scene3d-stage` + `.cad-body` get `aspect-ratio:
      16/9` with `min-height: 420px` / `max-height: calc(100vh - 13rem|16rem)`
      caps; `:fullscreen` rules override aspect in FS (`.scene3d-block:fullscreen`
      is flex column, toolbar `flex:none`, stage `flex:1`; `.cad-viewer:fullscreen`
      height 100vh, `.cad-body` `flex:1`). `app/page.tsx`: scroller gets
      `chat-messages-scroll` class. `ThreeStudioViewer.tsx`: React fullscreen
      state via `fullscreenchange` listener, `toggleStageFullscreen()` targets
      the whole `.scene3d-block` (toolbar stays usable in FS), button icon/label
      + `aria-pressed` sync (Minimize2/Exit fullscreen). `ArchitectureCadViewer.tsx`:
      new `cad-fullscreen` toolbar button (Expand/Shrink, `aria-pressed`) +
      `rootRef` on `.cad-viewer`. ResizeObservers already handle FS resize —
      no engine changes. Proven: measured 1440×900 headless run — CAD block
      736→1136px wide, CAD body + 3D stage ratio 1.78 (16:9), FS stage fills
      viewport (CAD 990×821, 3D 1440×778), screenshots in
      `test-results/size-check/` (chat + FS, both viewers, docks/toolbar/status
      intact); `tests/studio-viewers-visible.spec.ts` 2/2; `tsc --noEmit` clean.
      Headless quirk: `Escape` does NOT exit FS — scripts must call
      `document.exitFullscreen()` (real browsers honor Esc).
      FOLLOW-UP FIX (2026-10-17, user screenshot at 1920px): blocks overflowed
      the right edge uncentered — the base `.scene3d-block`/`.cad-block` rules
      used the `margin: 0.75rem 0` SHORTHAND after the breakout rule (same
      specificity, later wins) → `margin-left` clobbered to 0. Fixed: base rules
      now use `margin-block: 0.75rem` longhand; cap lowered 1600→1200px, gutter
      1.5→2rem; then user asked −2% then −10% → `min((100cqi - 2rem) * 0.882,
      1058px)` (1058 @1920, 995 @1440). Re-proven headless probe at 1920+1440: centerDelta 0, fits
      scroller, zero h-scroll, stage ratio 1.78; visible suite 2/2. GOTCHA:
      never use `margin` shorthand on breakout blocks — longhands only.
- [x] Black-canvas + live-control fix (2026-10-17): 3D viewport rendered
      solid black and dock/toolbar buttons "only toggled React state". Root
      causes + fixes: r186 ViewHelper full-canvas autoClear wipe →
      `renderGizmo()` depth-cleared overlay with `autoClear=false`
      (`lib/three3d/studioEngine.ts`); stage-bubbled pointerup deselected →
      `e.target !== canvasEl` guards (`components/render/ThreeStudioViewer.tsx`);
      normalizeCad always emits layer visible/opacity/locked defaults
      (`lib/cad/normalizeCad.ts`); `axes.visible=false`; stage 520px #0b1020
      wrapper + canvas inset:0 z:1 + docks z:10 + preserveDrawingBuffer +
      scene.background + permanent light rig + frameCameraToScene (all prior).
      Proven: `tests/studio-viewers-visible.spec.ts` 2/2 HEADED (drone pixels
      non-black, shading/presets/FOV/projection/gizmos/overlays/Eye/Solo/
      Material sliders/Explode/GLB+OBJ; kiosk CAD layers/themes/view modes/
      Tape/Area/.dxf/.svg), `test-results/canvas-proof.png` visual proof,
      `tsc --noEmit` clean, `npx vitest run` 402 passed | 1 skipped. Debug
      probe files (`tests/_debug-probe.spec.ts`, `__tests__/tmp-cadnorm.test.ts`)
      deleted. See docs/e2e-test-state.md + ISSUES.md.
- [x] Step 8 fault-tolerant 3D/CAD pipeline (2026-10-17): the two UI failures
      ("3D scene data did not validate", "entities.12.content: Required
      (+115 more)") fixed at the root — strict all-or-nothing zod replaced by
      lenient normalizers. New `lib/three3d/normalizeScene.ts` +
      `lib/cad/normalizeCad.ts` (kind aliases, every param optional w/
      defaults, sphere segs ≤64, unknown animation targets dropped+warned,
      cad text/label→content, `""`-key→layer, layer default, w/h +
      from/to + cx/cy aliases, malformed entity skipped). New
      `lib/three3d/codeRunner.ts` + `components/render/ThreeCodeBlock.tsx`:
      ```threejs (and ```js that looks like Three.js) runs model code with
      THREE/root/api bound, build()/main()/onUpdate(delta,elapsed), named
      parts auto-indexed into Outliner/pick/gizmos/explode/exporters — same
      ThreeStudioViewer handles both code and scene3d JSON. Frontend
      auto-heal: post-stream `findBrokenRenderFences` + runtime-error report
      → ≤2 repair rounds, "🔄 Auto-repairing 3D/CAD model…" note +
      "🔧 Fix with AI" buttons (useChat `requestFenceRepair`, fenceRepair.ts
      rewrite, ChatMessage/page/globals.css). Proven:
      `scripts/test-validators.mjs` both exact fixtures valid:true/0 errors,
      full vitest 402/402, tsc + build clean.
- [x] Step 6 ArchitectureCadViewer (2026-10-17): AutoCAD/BIM-grade CAD
      module. New `lib/cad/`: `cadSchema.ts` (strict zod `cad` fence +
      CAD_BUDGETS), `cad2d.ts` (bbox/shoelace area/angle/iso projection/
      sun position/thermal color + metric+imperial formatting), `svgToDxf.ts`
      (real DXF R2000: LINE/LWPOLYLINE/CIRCLE/ARC/TEXT on L-* layers),
      `pdfExport.ts` (hand-built vector PDF, spec-correct xref entries),
      `cadStandalone.ts` (offline interactive HTML). New
      `components/render/ArchitectureCadViewer.tsx` (2D/iso/3D/split views,
      4 themes, layer dock eye/lock/color/opacity/Solo, pan/zoom/wheel,
      Zoom Fit/100/200/400%, measure/area/protractor, snap grid/vertex,
      crosshair + live X/Y, north arrow, scale bar, explode, X/Y/Z sections,
      sun 06:00–20:00 + compass, hotspot inspector; exports DXF/SVG/PDF/PNG/
      HTML/GLB/OBJ all real client-side) + `CadBlock.tsx`; `cad` fence kind
      wired into registry/MarkdownRenderer/systemPrompt/demoShowcase/
      globals.css. Fixed cad2d imperial length math (2.5 ft → 2'-6").
      Proven: `__tests__/cad/` 5 files 31/31, `tests/cad.spec.ts` 9/9,
      tsc clean.
- [x] Step 7 final verification (2026-10-17): `.cskills/` = 27 core skills,
      `.cskills-scenarios/` = 27 scenario JSONs, `./skills/` = humanizer
      only; `tests/skills.spec.ts` 4/4 — core tier invisible in
      GET /api/skills, Skills Modal and slash autocomplete.
- [x] Step 5 ThreeStudioViewer (2026-10-17): the basic Scene3D viewer was
      replaced by a Blender/Maya-grade studio. New `lib/three3d/studioEngine.ts`
      (StudioViewer: 8 shading modes, persp/ortho + FOV 20–110 + named views +
      ViewCube gizmo, outliner/hide/solo, TransformControls Q/G/R/S, material +
      3-point-light + env-preset + postFX (bloom/SSAO/vignette/tonemap) docks,
      timeline + universal Explode, HUD stats, 4K PNG capture) +
      `lib/three3d/studioEnv.ts` (6 PMREM env presets) +
      `lib/three3d/standaloneExport.ts` (standalone .html + R3F .tsx). New
      `components/render/ThreeStudioViewer.tsx` + `Scene3DBlock.tsx` thin
      wrapper. Export hub all real client-side: glb/gltf (GLB re-import
      proven) + obj/stl/ply/usdz (official three/addons exporters) + html/
      tsx/4K-png. Proven: `__tests__/three3d/{meshExporters,standaloneExport}.
      test.ts` 10/10, `tests/three3d.spec.ts` 3/3, tsc clean.
- [x] Two-tier skill architecture + Core Skill Intent Router (2026-10-17):
      `CLAUDE.md`+`AGENTS.md` STRICT rules rewritten for two tiers — user tier
      `./skills/`+`./skill-scenarios/` (humanizer only) visible in UI; core
      hidden tier `./.cskills/`+`./.cskills-scenarios/` (27 real downloads:
      11 threejs-*, 11 r3f-*, archify, anatomy, architecture-diagram,
      diagram-design — every folder has a genuine SKILL.md) installable ONLY
      via `npm run cskill:add` (`scripts/install-core-skill.mjs`);
      `app/api/skills/install` rejects `.cskills` tampering (400). Core is
      never in GET /api/skills, SkillsModal, slash autocomplete or the
      load_skill enum (those read `./skills/` only). New
      `lib/skills/coreRouter.ts` — the ONLY reader of the core tier: pure
      `selectCoreSkills` (3d base/conditional bundles, R3F swap + twins,
      image→blender-glb-pipeline, arch per-keyword) + `applyCoreSkillRouting`
      injects one `<core_skill_routing>` system block (9 KB/skill, 56 KB
      total) + `<output_contract_3d>`/`<output_contract_architecture>`;
      wired into `app/api/chat/route.ts` (X-Used-Skill joined). All 27
      scenario JSONs autoUse:true + whenToUse + triggerKeywords. Proven:
      `__tests__/skills/coreRouter.test.ts` 13/13, tsc clean. NOTE:
      `openai/plugins --skill three-webgl-game` does not exist upstream —
      not installed, not fabricated.
- [x] Universal Skill Installation & Lazy-Loading Engine (2026-10-17): fake
      packs archived to `archive/skills/**`, old `lib/skills/{intent,loader,
      anatomyIntent}.ts` + their 4 tests deleted. Engine `lib/skills/{types,
      frontmatter,modality,registry,lazy}.ts` (all registry fns async); routes
      GET `/api/skills`, POST `/api/skills/install` (sanitized `npx -y skills
      add`), PATCH `…/[skillName]/scenario`, DELETE `…/[skillName]`; auto-move
      from `.agents/skills`+`.claude/skills` + debounced watcher; modality
      filter blocks external image/video-gen services, code-viz allowed.
      Chat lazy routing: Mode 1 `/name` intercept, Mode 2 `<skill_router>` +
      `load_skill` tool + keyword pre-router; `X-Used-Skill` → pill in
      ChatMessage. UI: `components/SkillsModal.tsx` + ChatInput skills button
      + slash autocomplete. Root `CLAUDE.md`+`AGENTS.md` strict rules. Fixed
      dangling-symlink cleanup in `syncInstalledSkills` (isBrokenLink).
      Proven: `__tests__/skills/` 29 tests (1 skipped: no Windows symlink
      privilege), full vitest 348/348, tsc clean, live install of
      blader/humanizer (real SKILL.md + exact 7-field scenario JSON),
      `tests/skills.spec.ts` 4/4.
- [x] Anatomy fence auto-repair loop (2026-10-16): a broken ```anatomy
      fence never reaches the user first. `lib/render/fenceRepair.ts`:
      findBrokenAnatomyFences (offset-precise fence scan + schema check),
      fenceRepairRequest (feeds the exact V8/zod error back — wording must
      keep "anatomy illustration" so SKILL.md re-injects), extractAnatomy-
      FenceBody + applyFenceRepair (splice corrected fence into the same
      bubble), MAX_FENCE_REPAIRS=2. `hooks/useChat.ts`: repairAnatomyFences
      runs post-stream pre-finalize on the SAME AbortController (stop()
      cancels repair rounds); repair turns never enter visible/persisted
      state; AnatomyBlock error note stays as honest last resort. SKILL.md:
      top-level `title`+`label` marked REQUIRED (anatomySchema.ts:385/388).
      Proven: fenceRepair.test 11/11 (incl. detector guard), render+anatomy
      vitest 277/277, tsc clean, Playwright anatomy-repair.spec 2/2
      (broken→corrected renders `svg.anatomy-svg` with zero `anatomy-error`;
      always-broken = exactly 3 chat calls then honest fallback).
- [x] Anatomy advanced architectural runtime (2026-10-16): v2 schema
      `profile` standard|advanced + `budgetsFor` (advanced ≤240 logical /
      ≤700 rendered parts, ≤100 floors, ≤8 modules, ≤48 connections+flows);
      `groups`/`floors`/`modules` (one module reused by many floors via
      `lib/anatomy/floorModules.ts`, ids `floor__part`), part
      `group`/`floor`/`visibleWhen`/`info`, control `toggle.group` /
      `button.action` / `select.target`, `connections`+`flows`. Builder
      throws on over-cap rendered parts (never silently truncated) and
      aggregates explode warnings. liveEngine v2: layer toggles, floor
      select dims (context preserved), system isolation, flow
      play/pause/reset, click info panel, zoom/pan/reset/fullscreen.
      Fixed `standaloneSvgMarkup` grabbing a lucide icon svg (SVG+PNG
      exports were exporting the icon). Showcase FIG 5 cutaway (advanced).
      AETHERION stress (`tests/helpers/aetherion.ts`): 80 floors, 497
      rendered parts, 44.9 ms build. Proven: anatomy vitest 74/74, tsc +
      build clean, Playwright anatomy.spec 18/18 + anatomy-export.spec 5/5
      (HTML/SVG/PNG/TSX verified standalone via file://, incl. AETHERION).
- [x] Anatomy routing fix (2026-10-16): explicit "Anatomy skill" invocation
      overrides mode-D exclusion + weak "mesh" disclaimer wording in
      `lib/skills/anatomyIntent.ts`; named formats (GLB/STL/…) still win.
      Intent 9/9, anatomy vitest 44/44, tsc clean.
- [x] Anatomy illustration skill (2026-10-16): WebUI-only, never a Claude Code
      skill. Pack `skills/anatomy/**` (3 SKILL.md) registered in
      `skills/manifest.json`; routing `lib/skills/anatomyIntent.ts` +
      domain-gated `lib/skills/loader.ts`; the anatomy pack REPLACES the 3D
      pack in `injectSkillPacks` (`app/api/chat/route.ts`). Kit vendored
      verbatim from upstream v1.1.0 (MIT, commit e9488296…, `LICENSE` +
      `NOTICE.md`) at `lib/anatomy/kit/`. Model emits ```anatomy fence JSON →
      strict zod (`lib/anatomy/anatomySchema.ts`: 11 part kinds, budgets,
      formula whitelist, dup-id/parent/slide/accent checks) → deterministic
      builder (`lib/anatomy/anatomyBuilder.ts`: SVG plate + declarative
      liveSpec, painter depth sort, fit projection) →
      `components/render/AnatomyBlock.tsx` lazy-mounts plate + zero-import
      `lib/anatomy/liveEngine.mjs` (rAF gated by IntersectionObserver,
      sliders/explode/needle/readouts from ONE state model, reduced-motion,
      destroy cleanup). Honest badge "SVG vector illustration — not a 3D
      mesh"; downloads SVG/PNG/standalone-HTML/TSX via
      `app/api/anatomy/export/route.ts`; GLB/FBX/etc. stay with scene3d/
      asset3d. Showcase `/demo-anatomy` + `?demo=anatomy`
      (`lib/render/anatomyDemoShowcase.ts`, 4 figures). Proven: vitest
      300/300 (41 anatomy), tsc + build clean, lazy chunks proven,
      Playwright anatomy 7/7 + regression 158/158 (file-reading layer 2
      not run to completion — see ISSUES.md).

- [x] AI 3D design system (2026-10-16): two modes. Mode A procedural
      ```scene3d v2: strict zod contract (`lib/three3d/sceneSchema.ts`) →
      deterministic builder (`lib/three3d/sceneBuilder.ts`: lathe/extrude/
      tube/primitives, PBR, studio lighting, labels, sliders, yoyo anims,
      budgets) rendered by `components/render/Scene3DBlock.tsx` (orbit/pan/
      zoom, grid/axes/wireframe/playback/reset/fullscreen/stats, GLB+GLTF
      export — the GLB is re-imported via GLTFLoader to prove validity).
      Mode B genuine AI mesh ```asset3d: server-only Meshy v2 adapter
      (`lib/three3d/providers/{types,meshy}.ts`, preview→PBR refine, OBJ
      shipped as textured zip via `lib/three3d/zipWriter.ts`), routes
      `app/api/3d/assets/**`, `components/render/Asset3DBlock.tsx`. Key
      never leaves the server (opaque job ids, same-origin downloads);
      unconfigured → honest 503 + procedural fallback. WebUI-local skill
      pack `skills/3d/**` (8 SKILL.md + manifest.json) served by
      `lib/skills/{intent,loader}.ts` and spliced into chat requests by
      `injectThreeSkills` in `app/api/chat/route.ts` — never Claude Code
      skills. three stays lazy. Proven: `__tests__/three3d/` 49/49,
      `npx vitest run` 259/259, tsc clean, `npm run build` clean,
      Playwright 45/45 across 10 specs (file-reading excluded: layer 2
      needs live llama.cpp :8080).
- [x] Chart 60fps motion (2026-10-16): new `hooks/useTweenedNumbers.ts`
      (rAF easeOutCubic vector tween, snaps on shape change / reduced-motion).
      `ChartBlock.tsx`: AxisMarks tweens series values + axis lo/hi (bars,
      lines, areas, stacked, histogram glide on slider/legend/rescale; ticks
      fade in and slide), BarMarks tweens groupW/barW (legend-toggle widths
      no longer snap), ScatterMarks tweens coords + both scales, PieMarks
      tweens slice values (sweeps rotate smoothly); type switch crossfades
      via `<g key={type} className="chart-marks-enter">`. CSS fades only
      (opacity/GPU-safe) + `prefers-reduced-motion` kill switch in
      globals.css chart chunk. Proven by frame sampling: legend toggle =
      21 distinct height AND width frames over ~320ms; reduced-motion
      context snaps instantly. Chart specs 3/3, tsc clean.
- [x] Table sort threshold fix (2026-10-16): header-click sorting was gated on
      `rows >= 5` while the hint always advertised it — 4-row tables ignored
      clicks. `MarkdownTable.tsx` gate now `rows >= 2`; new 4-row e2e in
      `tests/render.spec.ts`; markdown-table specs 3/3 green.
- [x] Task 7 KPI widget + MarkdownTable rollback (2026-10-16): per the user the
      table row-ask bar was rolled back — `components/render/MarkdownTable.tsx`
      restored to `308188f` (`.md-row-ask-bar` CSS left in place). New
      `kind:"kpi"` widget: `lib/render/schemas.ts` (`kpiSliderSchema`/
      `kpiCardSchema`, sliders ≤8 + cards 1–12 with value/unit/prefix/delta/
      trend/sparkline/formula/detail/bindSlider/operation), `components/render/
      WidgetBlock.tsx` (`KpiWidget`: Obsidian #0d0d12 grid, tabular-nums, trend
      badges #34D399/#FB7185/#38BDF8, inline SVG sparkline, sliders recompute
      bound cards + sparklines live via multiply/add/percent, card click →
      #38BDF8 selection + formula/detail callout + "Ask AI about this metric"
      → onSend), kpi lines in `lib/render/systemPrompt.ts`, KPI block in
      `lib/render/demoShowcase.ts`, `.kpi-*` chunk in `app/globals.css`. Proven
      by `tests/interactive-ui.spec.ts` 1/1 (slider recalc $52k→$104k/$62k,
      callout, ask→send, zero NaN SVG attrs, zero console errors; test clicks
      Stop before the 2nd ask — useChat `sendBusyRef` one-send-at-a-time — and
      whitelists the parser's `[PARSER] AbortError` diagnostic). schemas.test.ts
      17/17 (incl. 2 new kpi tests), tsc clean.
- [x] Open Intelligent UI + Gemini Interactive UI upgrade (2026-10-16):
      Obsidian luminous-black theme (`lib/render/themes.ts` `OBSIDIAN_SERIES_COLORS`/
      `OBSIDIAN_MERMAID_THEME`, `.viz-active-node`/`.viz-dimmed-node`/`.viz-active-edge`
      glow classes in globals.css), `VISUAL_ROUTER_SYSTEM_PROMPT`
      (`lib/render/systemPrompt.ts`) prepended in `lib/chat/client.ts` `buildBody()`,
      interactive ChartBlock (type switcher, mark-click explainer + Ask AI, legend
      toggles, param sliders), interactive MermaidBlock (`%%step:` playback bar,
      synced node/edge highlight, click-to-inspect), three.js Scene3DBlock (lazy
      import, attitude sliders, raycast inspect) + MarkdownTable row-ask bar,
      `/demo-ui` + `?demo=ui` showcase (`lib/render/demoShowcase.ts`, page.tsx
      trigger). three + @types/three installed locally. Proven by
      `tests/interactive-ui.spec.ts` 1/1 (zero console errors, zero NaN SVG attrs,
      highlight classes persist across re-renders); typecheck clean.
- [x] Filter menu All/Clear redundancy fix (2026-10-16): Clear was a
      duplicate of All; now unchecks all values (empty selection hides all
      rows, header marked via `has(col)`), term button toggles off,
      `clearColumnFilter` deleted. Filter e2e extended; suite 9/9, tsc clean.
- [x] Expanded-table tall-row gap fix (2026-10-16): off-screen wrapped cell
      text ballooned row heights until first drag; `syncOverflowClass` now
      toggles `cols-nowrap` (nowrap+ellipsis td) whenever the table overflows
      the scroller. Proven by new compact-rows e2e; table+drag suite 9/9.
- [x] Expanded-table column drag fix (2026-10-16): `MarkdownTable.tsx`
      `startResize` now has fit vs overflow regimes (overflowing tables give
      every column a fixed width, drag grows the table itself); `cols-resized
      th` clipped in globals.css. Proven by 20-col drag assertions + table
      suite 6/6.
- [x] Attachment reading pipeline: `lib/files/extensions.ts`, `lib/server/extract/*`,
      `app/api/files/extract/route.ts` (replaces the old `extract-pdf` route).
- [x] Client wiring: `lib/files/docProcessor.ts`, `lib/files/index.ts`, `lib/types.ts`,
      `lib/chat/{types,client}.ts`, `components/{ChatInput,ChatMessage}.tsx`,
      `app/page.tsx`, `hooks/useChat.ts`.
- [x] Fixtures: `scripts/make-fixtures.mjs` → 106 files + `tests/fixtures/manifest.json`.
- [x] Suite: `tests/file-reading.spec.ts` (3 layers, 106+106+3 tests).
- [x] Playwright browsers cached in-repo at `.data/ms-playwright` (set in
      `playwright.config.ts` via `PLAYWRIGHT_BROWSERS_PATH`) — nothing in the user profile.
- [x] Sidebar multi-select delete: Select/Select all/Delete N flow (`components/ui/Sidebar.tsx`,
      `app/page.tsx`), covered by `tests/multi-select-delete.spec.ts` (2/2) + CRUD suite (7/7).
- [x] Stream scroll jitter fix: rAF-coalesced bottom pin + wheel-up disengage in `app/page.tsx`
      (`stickToBottomRef`/`pinToBottom`, `messagesEndRef` removed). Proven by
      `scripts/scroll-verify/` (old code FAIL: 2311px drift, pill up 157/164 frames;
      fixed PASS: maxDist 24px, 0 pill frames, 0 upward jumps).

- [x] Edit/stop fix + collapsible user bubble (2026-10-16): editing a user
      message mid-stream aborted nothing → sliced bubbles emptied the screen
      back to the hero ("redirects to homepage") and the orphaned stream's
      `sendBusyRef` blocked the regeneration; stop left the bubble
      "streaming" forever; composer was disabled mid-generation.
      `hooks/useChat.ts`: `edit()` aborts first + `setTimeout(send,0)` after
      the finally's microtasks; `stop()` + send's aborted branch finalize the
      partial bubble; send guard now `sendBusyRef` (stale `status` closure
      removed). `components/ChatInput.tsx`: textarea never disabled.
      `components/ChatMessage.tsx`: ≥600 chars or ≥12 lines → clamped bubble
      + Show more/less; `.user-msg-collapsed` in globals.css. Proven by
      `tests/edit-stop-collapse.spec.ts` 5/5 (paced-SSE upstream proves the
      old connection really closes); chat-stream+live-chat+render+reasoning
      regression run 24/24, tsc clean.

- [x] Video audio path: `lib/server/extract/index.ts` (video case transcribes the audio
      track via `audioPcm`+`transcribePcm`, silent clips stay frames-only) +
      `lib/chat/client.ts` (`attachmentParts` appends "Audio transcript:" for videos).
      Covered by `__tests__/video-narration.test.ts` (4 tests).
- [x] UI rendering upgrade (code/tables/diagrams/charts/widgets): full `lib/render/`
      layer (themes, languages ~110 grammars, highlight, clipboard, registry, mathDetect,
      math, schemas), `components/render/` (CodeBlock, MermaidBlock, ChartBlock,
      WidgetBlock, MarkdownTable), MarkdownRenderer rewrite (fence routing + lazy KaTeX),
      ChatMessage/page.tsx wiring (streaming + onSend + copyText), globals.css chunks 1–4
      (Shiki dual-theme, tables, diagrams, charts, widgets, prose, KaTeX).
- [x] Render unit tests: `__tests__/render/{languages,registry,mathDetect,highlight,schemas}.test.ts`.
- [x] Render e2e spec: `tests/render.spec.ts` (13 tests: copy fidelity, table sort/CSV,
      mermaid valid+invalid, chart+data toggle, widget form, streaming partial fence,
      line spacing, list markers, heading inline-code scale, IDE tree, mid-stream color).
- [x] Table round 8 (2026-10-15): funnel filter button removed (right-click
      covers filtering) — `filtering` state, `toggleFilter`, `buildFilterRow`,
      `syncFilterRow`, the `.md-filter-row` DOM/CSS and its guards all deleted
      from `MarkdownTable.tsx` + globals.css; row-count chip now shows only
      while a filter is active. Render spec 19/19, tsc clean.
- [x] Table round 7 (2026-10-15): raw-pipe flash before table parse fixed —
      remark-gfm only parses a table once the full `| --- |` row arrives, so
      the header line rendered as a plain paragraph for ~1s. `MarkdownRenderer.tsx`
      now runs `stabilizeStreamingTables` on streaming content only: synthesizes
      the missing/half-typed tail delimiter row sized to the header line
      (fence-guarded). Bug found by the new e2e: a short `| --- | --- |` is
      syntactically complete but cell-mismatched — the rewrite keys on cell
      count, not syntax. Proven by paced-SSE e2e "renders as a table
      immediately, never as raw pipe text".
- [x] Table round 6 (2026-10-15): mid-generation table breakage fixed —
      collapse/filters/counts/handles were applied once on hover (`measure`),
      so rows streamed in later rendered unhidden (image: rows 4–5 exposing
      columns 5–8 mid-stream). `MarkdownTable.tsx`: `measure` deleted; a
      `useLayoutEffect` resync (no dep array) re-applies every imperative
      state after each render — layout (not passive) so streamed rows never
      flash uncollapsed for one frame; `syncFilterRow` grows the filter row
      when columns stream in; `toggleCols`/`toggleFullscreen` now only flip
      `expanded`. Proven by new paced-SSE e2e "a wide table stays collapsed
      while it is still generating" (DOM sampled every 120ms during stream:
      ≤4 visible cells per row, no blank gutter) — render spec 18/18, tsc clean.
- [x] Table round 5 (2026-10-15): 20-col × 40-row stress table readable —
      `min-width: 6rem` on th/td unless `.cols-resized` (scroller scrolls
      instead of crushing columns into slivers; rows 138px → 77px). Blank
      gutter in the collapsed screenshot did not reproduce (round 4 already
      fills the wrap). New e2e "a 20-column table stays readable collapsed
      and expanded" — render spec 17/17, tsc clean.
- [x] Table round 4 (2026-10-15): infinite-drag/blank-gutter fixed — last
      visible column is the flexible filler (no explicit width, no resize
      handle; fixed layout gives it the container's leftover so the table
      always fills it), middle drags clamped to keep the filler ≥56px,
      `syncResizeHandles` re-syncs handles on collapse/expand. Proven by the
      rewritten reflow e2e (widen/runaway-clamp/shrink/fullscreen, tableW ==
      scroller width after every drag) — render spec 16/16, tsc clean.
- [x] Table round 3 (2026-10-15): drag UX fixed — table width pinned to the
      column-width sum during resize (kills the width:100%+fixed redistribution
      that re-wrapped text), `.cols-resized` cells clip with ellipsis instead of
      re-wrapping (row heights never change mid-drag), 12px grab zone with hover
      grip line + accent drag guide, body `col-resize` cursor + no text
      selection while dragging, drag no longer triggers a phantom sort click,
      manual widths reset when columns expand/collapse. Proven by extended
      e2e "dragging one column must not reflow other columns or row heights"
      (widen + shrink + fullscreen phases) — render spec 16/16, tsc clean.
- [x] Table round 2 (2026-10-15): drag-resize columns (fixed layout + handles),
      right-click header filter dropdown (unique values + custom text term),
      sticky fullscreen header. `tests/render.spec.ts` 15/15.

- [x] Table toolbar upgrade (2026-10-15): `components/render/MarkdownTable.tsx` +
      globals.css table chunk — filter row per column, 5+ column collapse (+N expand),
      fullscreen overlay (Esc, top-right icon), column partition lines, CSV = visible rows.
      Proven by `tests/render.spec.ts` (14/14).

- [x] Screenshot bug fixes (2026-10-15): grammar-dependency cascade + circular-alias
      filter (`lib/render/highlight.ts`, `grammarDependencyLoader` in languages.ts),
      `stripLineNewlines`, vivid `themes.ts`, tree renderer (`lib/render/treeParse.ts`,
      `components/render/TreeBlock.tsx`, globals.css tree chunk with minmax(0,0fr)
      collapse), list-marker restore + heading-code 0.85em, CodeBlock throttle-with-
      trailing + monotonic `appliedSeq` for mid-stream color.

- [x] Math crash + scroll fixes (2026-10-15): `lib/render/math.ts` rehypePlugins now
      `[[plugin, options]]` tuples (flat pair made unified throw "empty preset" on any
      TeX message), `MarkdownRenderer` passes them through; `app/page.tsx` scroll is
      direction-aware (any upward move unpins, re-pin within 8px) + synchronous wheel
      unpin. `__tests__/render/mathPlugins.test.ts` 2/2; `tsc --noEmit` clean.
      Live proof: `scripts/scroll-verify/check.mjs` PASS (maxDist 49, 0 pill frames,
      0 up-jumps) + new `check-upscroll.mjs` PASS (60px wheel-up mid-stream stays
      free: 0 down-yanks, minDist 231px, pill shown).

- [x] MASTER MODALITY UPGRADE (2026-10-18, all 6 phases locked): Core document,
      presentation, Power BI & interactive-HTML engine.
      - Phase 1: core-tier skills in `./.cskills/` (pdf, docx, xlsx, pptx,
        frontend-design, web-artifacts-builder, resume-builder,
        d3-js-visualization, mermaid-diagram-builder, 22× motherduck-*) via
        `npm run cskill:add`; user-ordered composites `./.cskills/powerbi/` +
        `./.cskills/html-viewer/` (only hand-authored exceptions). Modality
        isolation via `./.cskills-scenarios/` — zero cross-contamination,
        router `lib/skills/coreRouter.ts`.
      - Phase 2: `components/HtmlArtifactBlock.tsx` + auto-sizing dark
        `<HtmlArtifactViewer/>` (1px rgba(255,255,255,.12) border, 16px radius,
        #000 bg, zero chrome, sandboxed iframe + ResizeObserver
        `HTML_VIEWER_RESIZE` postMessage). html-viewer palette enforced.
      - Phase 3: `lib/documents/` — pdfEngine (semantic HTML+inline SVG →
        Playwright page.pdf A4 + printCss), resumeHtml (resume-builder JSON →
        ATS 1–2 page), docxEngine (docx-js + Playwright 2× chart screenshots,
        temp cleanup), xlsxEngine + pure-JS `recalc.ts` (LibreOffice absent;
        zero blank cells, live formulas, dropdowns, freeze A2, errors_found 0),
        http + schemas + 6 API routes under /api/documents.
      - Phase 4: INSANE-tier PPTX default — pptxgenjs + OOXML Morph
        `<p159:morph option="byObject"/>` in mc:AlternateContent, `!!`-paired
        shape names, 3 viral patterns, tiers insane/normal/simple,
        `scripts/pptx_morph_injector.py`.
      - Phase 5: Power BI CSV → .pbip zip (TMDL + PBIR + dark theme) + .pbit,
        60fps WebUI preview; unified Preview-Before-Download viewers for every
        modality (`components/render/DocumentCard.tsx`).
      - Phase 6: `tests/regression_modalities.spec.ts` 8/8 green; full
        Playwright suite hardened to 100% (see e2e-test-state.md gotchas:
        IntersectionObserver parking, `__studioViewer` publish race,
        waitForResponse-before-click, zero-height collapsed wrappers,
        streaming pump timing, real-model marker retry).
      - Unit gate now `npx vitest run` 42 files, 429 passed | 1 skipped;
        `tsc --noEmit` clean. Playwright pinned 1.63.0.

## Rendering upgrade verification (2026-10-15)
- [x] Deps installed (user ran npm install). Prism fully removed: package.json +
      `types/prismjs.d.ts` deleted.
- [x] @shikijs/langs subpath ids audited: 4 renamed (fortran-free-form, sql,
      ssh-config, system-verilog), 9 dead entries removed + aliases/labels.
- [x] `npx tsc --noEmit` clean. `npx vitest run` 57/57 green (8 files).
      `npm run build` clean (route / 173 kB, first load 264 kB, shared 91.2 kB).
- [x] `tests/render.spec.ts` 13/13 green (dev server :3000 + mocked SSE, no model).
      Test-side fixes: wait for the first colored token before counting (grammar
      chunks load async), compare the clipboard after LF→CRLF normalization (Windows
      rewrites line endings), mid-stream test drives a paced SSE server because
      `route.fulfill` delivers the whole body in one chunk.
- [x] All 139 registry languages load their grammar + embedded dependencies and emit
      line spans (`__tests__/render/allLanguages.test.ts`); `__tests__/render` 187/187;
      `tsc --noEmit` clean.
- [x] Playwright regression (2026-10-16): 10 specs / 45 tests green
      (chat-stream, conversations-crud, conversations-live-chat, inspect-dup,
      reasoning-test, multi-select-delete, edit-stop-collapse, render,
      interactive-ui, three3d). `tests/file-reading.spec.ts` stays excluded:
      layer 2 needs a live llama.cpp model on :8080.

## Verified
- [x] `npm run typecheck` clean; `npm test` 57/57 (was 19/19 before the render
      unit tests; incl. narrated-mp4 → "zephyr" transcript).
- [x] Layer 1 extraction API: 106/106 passed (12.3 s).
- [x] Layer 2 real model turns (headed, watched live): 106/106 passed
      — docs/archives 22, images+Dockerfile/Makefile 13, text/code 58, audio+video 13.
      Audio replies were `YES Zephyr` (whisper heard the spoken codeword); images/video
      replies quoted the burned-in text, so the vision path is genuinely reading pixels.
- [x] Layer 3: 3 documented skips recorded as passing tests (.rar, .heic, .heif).

## Not testable (honest limits, not app bugs)
- [ ] `.rar` — no writer exists anywhere (proprietary); the unrar reader ships but no
      generated file can exercise it.
- [ ] `.heic` / `.heif` — bundled ffmpeg has neither a HEIF encoder nor a HEIF demuxer;
      the app routes them to ffmpeg and surfaces the failure in the chip.

## Next
- [ ] Regenerate `graphify-out/` when asked (still references the deleted extract-pdf route).
- [ ] Optional: real-world corpus pass (user's own files) beyond generated fixtures.

## Run
- Dev server: `npm run dev` (:3000) · model: llama.cpp :8080 · fixtures: `node scripts/make-fixtures.mjs`
- Watch the suite: `npx playwright test tests/file-reading.spec.ts --headed --reporter=list`
- Scroll regression check: `node scripts/scroll-verify/mock-upstream.mjs` (:8081) +
  `LLM_API_URL=http://127.0.0.1:8081/v1/chat/completions npx next dev -p 3001`, then
  `PLAYWRIGHT_BROWSERS_PATH=.data/ms-playwright node scripts/scroll-verify/check.mjs`
