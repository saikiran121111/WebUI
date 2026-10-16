# CHANGELOG

## 2026-10-16 — Fix: Anatomy routing honors explicit "Anatomy skill" invocation
- `lib/skills/anatomyIntent.ts`: an explicit invocation ("use the Anatomy
  skill/runtime/…") now overrides the mode-D subject exclusion (a user
  knowingly asking for a building cutaway gets Anatomy) and neutralizes
  weak mesh wording ("not a genuine 3D mesh" disclaimers); a NAMED mesh
  format (GLB/GLTF/FBX/USDZ/3MF/STL) still routes to the 3D pack.
  Implicit architecture/C4/chart requests stay excluded (mode D intact).
- `__tests__/anatomy/intent.test.ts`: +3 tests (explicit-over-exclusion,
  disclaimer wording, named-format-wins). anatomy vitest 44/44, tsc clean.

## 2026-10-16 — Feat: Anatomy isometric technical-illustration skill (WebUI-only)
- New `lib/anatomy/`: upstream kit vendored verbatim (MIT v1.1.0, commit
  e9488296…, `LICENSE` + `NOTICE.md`), `anatomySchema.ts` (strict zod
  `anatomy` fence contract: 11 part kinds, budgets, formula whitelist,
  dup-id/parent/slide/accent validation), `anatomyBuilder.ts` (spec → SVG
  plate + liveSpec, painter's-order depth sort, fit projection),
  `liveEngine.mjs` (zero-import vanilla runtime: rAF gated by
  IntersectionObserver, sliders/explode/needle/readouts from one state
  model, reduced-motion stillness, destroy() cleanup).
- New `components/render/AnatomyBlock.tsx` (lazy builder+engine import,
  light/dark theme, part-click → refinement send, honest "SVG vector
  illustration — not a 3D mesh" badge, SVG/PNG/HTML/TSX downloads) +
  `app/api/anatomy/export/route.ts` (standalone HTML with the engine
  inlined, self-contained React component; zod-strict request).
- Skill pack `skills/anatomy/**` (3 SKILL.md) added to `skills/manifest.json`;
  `lib/skills/anatomyIntent.ts` + domain-gated `lib/skills/loader.ts`;
  anatomy instructions replace the 3D pack in `app/api/chat/route.ts`.
  `lib/render/registry.ts` + `MarkdownRenderer.tsx` route ```anatomy fences;
  `lib/render/systemPrompt.ts` router rules updated (anatomy vs scene3d vs
  asset3d vs "not for architecture/C4/charts").
- Showcase: `/demo-anatomy` + `?demo=anatomy`
  (`lib/render/anatomyDemoShowcase.ts`, 4 figures: single-cyl head, dial
  indicator, hydraulic pump, connection pool).
- Tests: `__tests__/anatomy/` 5 files 41/41; `tests/anatomy.spec.ts` 7/7
  (slider→readout 30.0→42.0 + piston transform, explode, theme, downloads,
  mobile 390px, reduced-motion). Fixed `tests/conversations-crud.spec.ts`
  unarchive reload race (see ISSUES.md). No new npm deps.

## 2026-10-16 — Feat: AI 3D design system (procedural scenes + genuine AI meshes)
- New `lib/three3d/`: `sceneSchema.ts` (strict zod v2 `scene3d` + `asset3d`
  contracts, budgets), `geometryKit.ts` (lathe/extrude/tube/primitives),
  `materials.ts`, `lighting.ts`, `camera.ts`, `sceneBuilder.ts` (deterministic
  spec→Object3D + animation clips + stats + dispose), `exporters.ts`
  (GLTFExporter GLB/GLTF + `validateGlb` + `reimportGlb` proof), `zipWriter.ts`
  (store-only zip, no new dep), `viewerCore.ts` (orbit/pan/zoom, grid/axes/
  wireframe/playback/reset/fullscreen/stats/pick), `providers/{types,meshy}.ts`
  (Meshy v2 text-to-3d, preview→PBR refine, OBJ+MTL+textures→zip).
- New `app/api/3d/assets/{,[id],[id]/download}` routes: key stays server-side,
  honest 503 when unconfigured, 409 on not-ready/absent format; the browser
  only ever sees opaque `meshy:pv|rf:<id>` job ids and same-origin URLs.
- New `components/render/Asset3DBlock.tsx`; `Scene3DBlock.tsx` rewritten to
  the v2 contract; `components/MarkdownRenderer.tsx` routes `asset3d` fences;
  `lib/render/{registry,systemPrompt,demoShowcase}.ts` updated; `.env.example`
  gains `MESHY_API_KEY=` (empty).
- New WebUI-local skill pack: `skills/manifest.json` + 8 `skills/3d/**/SKILL.md`
  served by `lib/skills/{intent,loader}.ts`; `injectThreeSkills` in
  `app/api/chat/route.ts` splices matched skill text before the last user
  message. Never registered as Claude Code skills.
- Tests: `__tests__/three3d/` 7 files 49/49; `tests/three3d.spec.ts` 3/3
  (viewer tools, export re-import proof, honest 503 path, credit-safe API
  probes via route mocks). Full regression 45/45 across 10 specs.
- Fixed `tests/conversations-crud.spec.ts` archive test (see ISSUES.md).

## 2026-10-16 — Feat: 60fps smooth motion for all chart interactions
- New `hooks/useTweenedNumbers.ts`: rAF easeOutCubic tween of numeric vectors;
  snaps instantly on vector-shape change or `prefers-reduced-motion`.
- `components/render/ChartBlock.tsx`: AxisMarks/BarMarks/ScatterMarks/PieMarks
  now render from tweened values, axis scales, and bar layout scalars —
  slider drags, legend toggles, rescales and pie sweeps glide at native
  refresh rate; chart-type switch crossfades (`chart-marks-enter`).
- `app/globals.css`: opacity-only enter fades (marks, ticks, tooltip),
  `.chart-mark:hover` fill-opacity lift, reduced-motion disables all fades.
- Proven: frame-sampling shows 21 distinct height+width frames per legend
  toggle (~320ms ease-out); reduced-motion browser context snaps instantly.
  Chart e2e 3/3 green, `tsc --noEmit` clean.

## 2026-10-16 — Fix: header-click sorting dead on tables under 5 rows
- `components/render/MarkdownTable.tsx`: sort gate `rows >= 5` → `rows >= 2`
  (the footer hint always advertised sorting; 4-row tables silently ignored
  header clicks). New e2e "markdown table with 4 rows still sorts on header
  click" in `tests/render.spec.ts`; markdown-table specs 3/3 green.

## 2026-10-16 — Task 7: Live KPI value cards & formula calculators
- `lib/render/schemas.ts`: `kpiSliderSchema` + `kpiCardSchema` joined the
  `widgetSpecSchema` union as `kind:"kpi"` (sliders max 8, cards 1–12; value/
  unit/prefix/delta/trend/sparkline/formula/detail/bindSlider/operation).
- `components/render/WidgetBlock.tsx`: `KpiWidget` — responsive Obsidian grid
  (#0d0d12 cards, `rgba(255,255,255,0.08)` border, tabular-nums), trend badges
  (up #34D399 / down #FB7185 / neutral #38BDF8), inline SVG sparkline
  (viewBox 0 0 100 30, `.toFixed(2)` coords), sliders recompute bound card
  values and scale sparklines live (multiply/add/percent), card click →
  #38BDF8 border + formula/detail callout + "Ask AI about this metric" → onSend.
- `lib/render/systemPrompt.ts`: kpi fence instructions; `lib/render/demoShowcase.ts`:
  KPI showcase (growth/extra sliders; mrr/cogs/margin/forecast cards);
  `app/globals.css`: `.kpi-*` chunk with reduced-motion guard.
- `components/render/MarkdownTable.tsx`: rolled back to `308188f` per the user
  (row-ask bar gone); `.md-row-ask-bar` CSS left in place.
- Verified: `tests/interactive-ui.spec.ts` 1/1 (4.5 s) — slider recalc
  ($52k→$104k, forecast +10k→$62k), callout text, `is-selected`, ask →
  message appended, zero NaN SVG attrs, zero console/page errors. Test clicks
  "Stop generating" before the 2nd ask (useChat `sendBusyRef` allows one send
  at a time) and whitelists the `[PARSER] AbortError` stop diagnostic.

## 2026-10-16 — Fix: orphaned mermaid error boxes at page bottom
- `components/render/MermaidBlock.tsx`: added `suppressErrorRendering: true` to
  `mermaid.initialize`. Mermaid 12.2.0 injected its "Syntax error in text" SVG into
  `document.body` on parse failure and threw before removing the temp `div#d<id>`,
  leaving error boxes stuck at the page bottom (one per failed render attempt).
  Our own error fallback (source code block) already covers the failure.
  Verified: `npx tsc --noEmit` clean, `npx vitest run tests/render.spec.ts __tests__/render`
  → 189/189 pass.

## 2026-10-16 — Open Intelligent UI + Gemini Interactive UI upgrade
- New interactive render layer + showcase, all verified by
  `tests/interactive-ui.spec.ts` (1/1, zero console errors, zero NaN SVG attrs):
  chart type switcher + mark-click explainer + Ask AI hand-off + legend switches +
  param sliders (`components/render/ChartBlock.tsx`), mermaid `%%step:` playback
  with synced node/edge glow + click-to-inspect (`components/render/MermaidBlock.tsx`),
  lazy three.js scene with attitude sliders + raycast inspect
  (`components/render/Scene3DBlock.tsx`, three + @types/three installed locally),
  table row-click → "Ask AI about this row" bar (`components/render/MarkdownTable.tsx`).
- `lib/render/themes.ts`: `OBSIDIAN_SERIES_COLORS` + `OBSIDIAN_MERMAID_THEME`
  (pure-black `#050507`/`#0d0d12`, luminous accents); `app/globals.css`:
  `.viz-active-node`/`.viz-dimmed-node`/`.viz-active-edge` glow classes +
  `viz-edge-flow` under `prefers-reduced-motion: no-preference`.
- `lib/render/systemPrompt.ts`: `VISUAL_ROUTER_SYSTEM_PROMPT` (when/how to emit
  chart/mermaid/scene3d/table blocks + `%%step:` comments) prepended to every
  request in `lib/chat/client.ts` `buildBody()`.
- `/demo-ui` page + `?demo=ui` query (`app/page.tsx`, `lib/render/demoShowcase.ts`)
  exercise every interaction client-side — no model server needed.
- MermaidBlock fixes (see ISSUES.md): mermaid-12 node/edge id parsing
  (`normalizeNodeId`, `edgeEndpoints`) and imperative `stage.innerHTML = svg`
  replacing `dangerouslySetInnerHTML` so highlight classes + listeners survive
  React re-renders. Typecheck clean.

## 2026-10-16 — filter menu All/Clear redundancy fixed
- User: in the right-click filter dropdown, "Clear" and "All" do the same
  thing. True: `clearColumnFilter` deleted the value filter AND re-checked
  every box — identical to All unless a text term happened to be set.
- `components/render/MarkdownTable.tsx`: Clear now unchecks every value
  (`commitMenuChecked(new Set())`) so you can tick one value without
  unticking the rest; `clearColumnFilter` deleted. The "contains" term
  button toggles off when its term is active. `updateFilterMarks` keys on
  `has(col)` not `size > 0` — an empty selection hides all rows and must
  still mark the header filter-active.
- `tests/render.spec.ts`: filter test extended (term toggle off → 6 rows,
  Clear → 0 rows + "0 of 6 rows" chip, All → 6 rows). Suite 9/9, tsc clean.

## 2026-10-16 — expanded-table tall-row gaps fixed
- User: right after expanding a wide table, every row is ~120px of empty
  space; it only compacts after the first drag. Root cause: in auto layout
  cells wrap, and the row's tallest cell was an OFF-screen column's long
  text (Best For/Community) wrapping to 4-5 lines — invisible, yet it set
  every visible row's height. `cols-resized` (drag) sets td nowrap, which is
  why dragging "fixed" it.
- `components/render/MarkdownTable.tsx`: `syncOverflowClass` toggles
  `cols-nowrap` on the table whenever it overflows the scroller; runs in the
  resync effect, on drag pointerup and on dblclick reset.
- `app/globals.css`: `cols-nowrap td` = nowrap + ellipsis (same one-line
  grid look as hand-sized columns, from the first moment).
- Regression: new e2e "expanding a wide table keeps rows compact before any
  drag" (overflow true, rows 37px ≤48). Table+drag suite 9/9, typecheck clean.

## 2026-10-16 — expanded-table column drag fixed
- User: on an expanded (wide) table, dragging header edges left/right does
  nothing and columns snap to ~56px with headers overlapping. Root cause:
  `startResize`'s clamp computed available width from `scroller.clientWidth`
  — valid only while the table fits the scroller. Expanded tables overflow
  it, so `availW` went ≈0/negative and every drag pinned the column to
  MIN_COL_WIDTH; the last column (no explicit width) also collapsed to 0.
- `components/render/MarkdownTable.tsx`: two regimes — fits scroller: old
  filler/clamp behavior kept; overflows scroller: every visible column
  (last included) gets a fixed width and the drag grows/shrinks the table
  itself (scroller scrolls further), floor stays MIN_COL_WIDTH.
- `app/globals.css`: `cols-resized th` gets `overflow: clip` +
  `overflow-clip-margin: 8px` so narrow headers clip instead of bleeding
  over the neighbour (clip-margin keeps the -6px resize handle grabbable).
- Regression: `tests/render.spec.ts` 20-col test now drags expanded edges
  (+150 → 96→246px, −100 → 246→146px). Table suite 6/6 + drag specs 3/3,
  typecheck clean. (Earlier red runs were a stale/cold dev server, not code.)

## 2026-10-16 — mid-stream edit/stop fixed + collapsible user bubble
- User: editing the input while generating "redirects to homepage" and the
  generation can't be stopped. Root cause: `edit()` never aborted the
  in-flight stream — slicing to `slice(0, idx)` could empty `messages` (hero
  EmptyState returns), and the orphaned send held `sendBusyRef`, swallowing
  the regeneration; `stop()` never finalized the partial bubble (cursor
  blinked forever); the composer textarea was `disabled` mid-generation.
- `hooks/useChat.ts`: `edit()` aborts first, then `setTimeout(() => send(...), 0)`
  (the old send's finally is pure microtasks, so the guard is released before
  the macrotask); `stop()` and send's aborted branch flip the bubble to
  `complete`; send guard uses `sendBusyRef` (the old `status === "streaming"`
  check read a stale closure value).
- `components/ChatInput.tsx`: textarea no longer disabled while streaming
  (send button already swaps to the stop button; `handleSend` still guards).
- `components/ChatMessage.tsx` + `app/globals.css`: user messages ≥600 chars
  or ≥12 lines render clamped (6-line `-webkit-line-clamp` + fade mask) with
  a Show more/less toggle — collapsed the moment the message is sent.
- `tests/edit-stop-collapse.spec.ts` (new, 5/5): stop mid-stream finalizes +
  content stops growing; composer editable mid-generation, Enter doesn't
  double-send; edit mid-stream → no hero, old upstream connection closed,
  only the SECOND_REPLY survives; long bubble collapses/expands/re-collapses
  (scrollHeight vs clientHeight); short messages get no toggle. Regression:
  chat-stream + conversations-live-chat + render + reasoning specs 24/24.

## 2026-10-15 — table round 8: funnel filter button removed
- User: right-click already does filtering, the funnel icon is dead weight.
- `components/render/MarkdownTable.tsx`: deleted the funnel button, `filtering`
  state, `toggleFilter`, `buildFilterRow`, `syncFilterRow`, every
  `.md-filter-row` guard/skip, and simplified `thead tr:not(.md-filter-row)`
  → `thead tr`. Row-count chip now shows when a right-click filter is active
  (`filterMenu || visibleRows < rowCount`). `app/globals.css`: filter-row
  block + reduced-motion entry removed. Test rewritten to the right-click
  flow (menu search → contains term → Clear).

## 2026-10-15 — table round 7: no raw-pipe flash before the table appears
- User screenshot: for ~1s the header line of a 22-col table shows as plain
  pipe text before becoming a table. Root cause: remark-gfm only recognizes a
  GFM table once the whole `| --- | … |` delimiter row has streamed in.
- `components/MarkdownRenderer.tsx`: `stabilizeStreamingTables(content)` runs
  only while `streaming` (finished messages parse exactly as written; open
  code fences skipped). If the tail is the header line → append a synthesized
  delimiter; if the tail is delimiter-ish (`|`, `-`, `:`, spaces only) →
  replace it with a full one sized to the header above. First test run still
  failed: a short `| --- | --- |` is syntactically complete but mismatches a
  22-cell header, so the guard must be cell count, not syntax.
- New paced-SSE e2e "a streaming table renders as a table immediately, never
  as raw pipe text": 10 chars/frame, DOM sampled every 80ms — no paragraph
  ever contains pipe text, wrap appears while `data-state="streaming"`.
  Render spec 19/19, tsc clean.

## 2026-10-15 — table round 6: wide tables stay collapsed while generating
- User screenshot mid-generation: 15-col table showed rows 1–3 collapsed to
  4 columns but rows 4–5 exposing columns 5–8 with no headers. Root cause:
  `measure` (one-shot, on pointer-enter) + `applyColHidden` toggled
  `col-hidden` only on rows that existed at that moment — rows React
  streamed in afterwards got none of the component's imperative state.
- `components/render/MarkdownTable.tsx`: deleted `measure`/`onPointerEnter`;
  added a `useLayoutEffect` resync (no dep array) that after every render
  recomputes counts/sortable, re-applies collapse (widths reset only when
  the hide flag flips), re-applies active filters, re-syncs resize handles,
  and grows/shrinks the filter row (`syncFilterRow`) when columns drift.
  `useLayoutEffect` not `useEffect`: passive effects run after paint, so a
  streamed row would flash full-width for one frame before collapsing —
  the first test run proved exactly that (`row 12 leaked 15 columns`).
  `toggleCols`/`toggleFullscreen` simplified to flipping `expanded` only.
- New e2e "a wide table stays collapsed while it is still generating":
  paced SSE server streams a 15×30 table at 15ms/frame; the DOM is sampled
  every 120ms while `data-state="streaming"` — header ≤4 visible columns,
  zero rows past 4 visible cells, table fills the wrap (no blank gutter);
  after DONE, expand toggle still reaches 15. Render spec 18/18, tsc clean.

## 2026-10-15 — table round 5: 20-column stress table stays readable
- User screenshot of a 20-col × 40-row table: expanded columns squeezed into
  41–88px one-character-per-line slivers with 138–158px rows. The blank
  gutter in the collapsed shot did NOT reproduce — round 4's flex filler
  already fills the wrap (probe: tableW == scrollerW).
- `app/globals.css`: `table.md-table:not(.cols-resized) th/td { min-width: 6rem }`
  — columns keep a readable floor and the scroller takes horizontal scroll
  instead of crushing them; skipped while hand-resizing (drag clamp owns the
  56px floor there).
- New e2e "a 20-column table stays readable collapsed and expanded": collapsed
  fills the wrap, expanded every column ≥90px, rows ≤80px (734px wrap →
  1920px scrollable grid). Render spec 17/17, tsc clean.

## 2026-10-15 — table round 4: last column absorbs slack, no blank gutter / infinite drag
- Reproduced with e2e: dragging the last column's handle left left a blank
  gutter (table narrower than the wrap) and right grew the table without
  bound — the round-3 width pinning made the grid a fixed block inside a
  scrollable wrap.
- `components/render/MarkdownTable.tsx`: Excel rule — the last visible column
  is the flexible filler: no explicit width (fixed layout hands it the
  container's leftover, so the table always fills it) and no resize handle
  (its edge is the grid edge). Middle drags are clamped so the filler never
  drops below `MIN_COL_WIDTH` (56px). `addResizeHandles` → `syncResizeHandles`
  (adds/removes handles when the visible set changes; called from
  `applyColHidden` + `measure`). Bug caught by the test: capture must measure
  widths *before* adding `.cols-resized` (fixed layout equalizes auto columns
  first — captured 122px instead of 78/61/57/71).
- Test rewritten: widen/runaway(+900px clamp)/shrink/fullscreen phases assert
  `tableW == scroller.clientWidth` after every drag, filler absorbs the delta,
  last column has no handle in fullscreen. Render spec 16/16, tsc clean.

## 2026-10-15 — table round 3: spreadsheet-grade column dragging (Playwright-proven)
- Reproduced the complaint with e2e geometry sampling: shrinking a column made
  row heights jump 57/37 → 77px (fullscreen: whole table reflowed) because
  `width:100%` + `table-layout:fixed` redistributed the freed space across every
  column, re-wrapping text mid-drag.
- `components/render/MarkdownTable.tsx` `startResize`: pins `table.style.width`
  to the exact sum of column widths at drag start and on every move — freed
  space stays freed, other columns never budge.
- `app/globals.css`: once `.cols-resized` is active, tbody cells clip with
  `nowrap + text-overflow: ellipsis` (Excel semantics) — row heights are
  constant while dragging; widening a column reveals the text again.
- Grab ergonomics: handle widened 8→12px (`right:-6px`), faint grip line on
  header hover, solid accent guide on the active edge, `body.md-col-dragging`
  keeps the col-resize cursor and blocks text selection across the whole page.
- A drag no longer fires a phantom sort on release (`suppressSortAfterDragRef`);
  manual widths are reset when columns expand/collapse (hidden cells were
  captured at 0px) and on double-click reset (`resetColWidths`).
- Test extended: widen + shrink + fullscreen drag phases, asserting other
  columns ±2px and row heights ±1px throughout. Render spec 16/16, `tsc` clean.

## 2026-10-15 — table round 2: drag-resize columns, right-click value filters, sticky fullscreen header
- Column resizing: drag handle on each header's right edge (`.md-col-resize`); first
  drag switches the table to `table-layout: fixed` with captured widths; double-click
  resets. Excel-like per-column sizing.
- Right-click a header → filter dropdown: checkbox list of unique values (sorted,
  capped 200) + search box that doubles as a custom "contains" text term; All/Clear
  footer; filtered headers get a `.filter-active` accent mark; state survives menu
  re-open. Left-click still sorts; bottom hint now spells out all three gestures.
- Fullscreen: sticky `thead` with opaque background while scrolling rows.
- Bug found by e2e: `applyFilter` only looped columns that had filter-row inputs, so
  dropdown filters did nothing while the funnel row was closed — now loops all header
  columns. Proven by new spec "right-click header filter and drag column resize
  work like a spreadsheet" — render spec 15/15 green.

## 2026-10-15 — table toolbar: filters, column collapse, fullscreen, grid lines
- `components/render/MarkdownTable.tsx`: top toolbar (row count + filter/columns/
  fullscreen icon buttons, fullscreen at top right). Per-column filter row injected
  into `thead` imperatively (`.md-filter-row`), live substring filtering with
  "x of y rows" count. Tables with 5+ columns collapse columns past the 4th behind
  a "+N" expand toggle (`.col-hidden`). Fullscreen = `is-fullscreen` fixed overlay
  on the wrap (Esc closes, body scroll locked, columns auto-expand while open).
  CSV now exports visible (unfiltered) rows and skips the filter row.
- `app/globals.css`: column partition lines (`th+th`/`td+td` border-left), topbar/
  ctl/filter-row styles, `.col-hidden`, `.md-table-wrap.is-fullscreen` overlay,
  reduced-motion guards.
- `tests/render.spec.ts`: new e2e "collapses wide columns, filters rows and opens
  fullscreen" — render spec 14/14 green.

## 2026-10-15 — crash on math messages + free scrolling during stream
- "Expected usable value but received an empty preset" (unified): `lib/render/math.ts`
  returned `rehypePlugins` as a flat `[plugin, options]` pair and `MarkdownRenderer`
  spread both as separate entries → unified received the KaTeX options object as a
  standalone preset (no plugins/settings) and threw. Now a proper `[[plugin, options]]`
  tuple passed through untouched. Proven by `__tests__/render/mathPlugins.test.ts`.
- Unable to scroll up mid-generation (`app/page.tsx`): the 120px dead zone re-pinned
  any upward scroll closer than 120px to the bottom, and wheel-up unpin raced a
  same-frame rAF pin (React state flushes after the rAF). Now direction-aware
  hysteresis (any upward move unpins; re-pin only within 8px of bottom) + synchronous
  `stickToBottomRef` clear in the wheel handler.

## 2026-10-15 — six rendering fixes from user screenshots + all-139-language proof
- No colors/indentation for html/css/most languages: TextMate grammars embed others
  (cpp→regexp…, vue→vue-directives…, typst→tex…) and only the requested one loaded →
  "Missing languages"; one failed load poisoned every later one. `loadGrammarTree` in
  `lib/render/highlight.ts` loads embeddedLangs recursively (canonical names, new
  `grammarDependencyLoader` map in `lib/render/languages.ts`) and resets the highlighter
  on any load failure. Re-keying a grammar to its registry key now strips that key from
  its own aliases (proto→protobuf, lean→lean4 threw "Circular alias"). Proven by
  `__tests__/render/allLanguages.test.ts`: all 139 keys load and emit line spans.
- Double line spacing in code: Shiki emits "\n" text nodes between block-level .line
  spans → extra anonymous line boxes. `stripLineNewlines` transformer removes them.
- Dull colors: vivid dark/light palettes in `lib/render/themes.ts`.
- Folder-structure fences → interactive IDE tree: `lib/render/treeParse.ts` parses
  box-drawing/ASCII trees; `components/render/TreeBlock.tsx` adds icons, CSS guide rails,
  click-to-collapse (grid `minmax(0,1fr)`→`minmax(0,0fr)` — a bare `0fr` keeps the
  track's auto minimum and left a 15.6px gap), collapse-all, exact-source copy.
- List markers invisible: Tailwind preflight strips list-style → globals.css restores
  disc/decimal in markdown prose. Heading inline code now scales 0.85em (the stray "5."
  next to a tiny chip).
- Highlighting only appeared when the fence closed: debounce → throttle-with-trailing
  (200ms) in `components/render/CodeBlock.tsx`; the `seq === highlightSeq` guard also
  discarded every result resolving during a fast stream — replaced with monotonic
  `appliedSeq` so the newest-resolving highlight always paints.
- Verified: `tsc --noEmit` clean; `__tests__/render` 187/187; `tests/render.spec.ts`
  13/13 (mid-stream test uses a paced SSE server — `route.fulfill` delivers in one chunk).

## 2026-10-15 — project-wide rendering upgrade (Shiki, tables, mermaid, charts, widgets)
- Root cause of white code: Prism emitted token spans but no theme CSS existed anywhere.
  Replaced with Shiki core + JS regex engine, dual dark/light themes (`lib/render/themes.ts`),
  ~110-language lazy registry with aliases + honest "Plain text" fallback (`lib/render/languages.ts`).
- New `lib/render/` (highlight LRU cache, clipboard helper, fence registry, math detection,
  zod chart/widget schemas) and `components/render/` (CodeBlock with line numbers/wrap/
  collapse/download + exact-source copy; MermaidBlock with pan/zoom/inspect/fullscreen/SVG
  export + source-preserving invalid fallback; ChartBlock hand-built SVG + data table;
  WidgetBlock form/tabs/accordion with validation + follow-up send; MarkdownTable with
  sorting + CSV).
- `components/MarkdownRenderer.tsx` rewritten: fences route through the registry (fixes
  language-less fences rendering as inline code), lazy KaTeX gated by `mathDetect`.
  `ChatMessage.tsx`/`app/page.tsx` pass streaming + onSend, copy via `copyText`.
- `app/globals.css` chunks 1–4: Shiki dual-theme override, gutter/diff/wrap, tables,
  diagram stage, charts, widgets, prose typography, KaTeX.
- Tests: 5 vitest files under `__tests__/render/` + `tests/render.spec.ts` (8 e2e).
- Deps installed (user ran npm install). Grammar ids audited against the installed
  @shikijs/langs dist: fortran→fortran-free-form, postgresql key now loads the `sql`
  grammar, sshconfig→ssh-config, systemverilog→system-verilog; removed 9 languages with
  no grammar in the pack (meson, prql, antlr4, gitignore, svg, mustache, sed, reason,
  purebasic) plus their aliases/labels. Prism dropped from package.json.
- Verified: `tsc --noEmit` clean; vitest 57/57; `npm run build` clean;
  `tests/render.spec.ts` 8/8 green (dev server :3000 + mocked SSE, no model).
  Test fixes along the way: wait for the first colored token before counting
  (async grammar chunk load) and normalize LF→CRLF before the clipboard
  fidelity compare (Windows rewrites line endings at the OS layer).
  `types/prismjs.d.ts` deleted. Full suite not run — file-reading layer 2
  needs a live model on :8080.

## 2026-10-14 — videos now carry their audio (Whisper transcript) into the prompt
- `lib/server/extract/index.ts` — the `video` case only sampled frames; the audio track was
  dropped entirely. It now also runs `audioPcm()` + `transcribePcm()` when the clip has a
  decodable audio stream (try/catch keeps silent videos frames-only), capping the transcript
  to `TEXT_CHAR_LIMIT`.
- `lib/chat/client.ts` — the `video` prompt branch ignored `transcript` even when present;
  it now appends an "Audio transcript:" part. Exported `attachmentParts` for testing.
- `__tests__/video-narration.test.ts` — 4 new unit tests: narrated mp4 (muxed with the
  spoken-codeword fixture wav via bundled ffmpeg) yields frames + a transcript containing
  "zephyr"; silent mp4 stays frames-only with no error; prompt parts include/omit the
  transcript accordingly. 19/19 unit tests + typecheck pass.

## 2026-10-14 — fixed stream scroll jitter (top/bottom oscillation during generation)
- `app/page.tsx` — replaced the per-chunk `messagesEndRef.scrollIntoView()` auto-scroll with a
  single rAF-coalesced bottom pin (`pinToBottom` + `stickToBottomRef`), a scroll listener that
  disengages past 120px, and a wheel-up listener that disengages immediately on scroll-up.
  "Jump to latest" re-engages the pin. `messagesEndRef` removed entirely; added
  `data-testid="messages-scroll"` to the scroll container.
- `scripts/scroll-verify/{mock-upstream,check}.mjs` — SSE mock (:8081, 350 chunks @8ms) +
  Playwright sampler (40ms): FAILs on >120px drift, visible pill, or upward scrollTop jumps.
  Before/after proof: old code FAIL (2311px drift, pill 157/164 frames), fixed PASS
  (maxDist 24px, 0 pill frames, 0 up jumps). Kept as regression tooling.

## 2026-10-14 — sidebar multi-select delete
- `components/ui/Sidebar.tsx` — "Select" button enters select mode (checkboxes on every
  row, "Select all" toggle); once ≥1 selected the button becomes "Delete N". Selection
  state self-prunes when conversations disappear. Removed unused imports.
- `app/page.tsx` — `confirmDeleteIds` state + `confirmDeleteMany` (parallel DELETEs,
  deletedRef tombstones, clears open chat if it was among them) + second ConfirmDialog.
- `tests/multi-select-delete.spec.ts` — 2 tests: full UI flow (cancel path) and a real
  seeded delete verified via API 404.
- Note: the dev server's compiler worker had crashed ("Jest worker encountered 2 child
  process exceptions") making all API routes 500 — restarted; all 7 CRUD tests pass again.

## 2026-10-14 — file reading verified end to end
- `playwright.config.ts` — pins `PLAYWRIGHT_BROWSERS_PATH` to `.data/ms-playwright` so the
  Chromium download stays inside the codebase instead of the user profile.
- `.data/ms-playwright/` — Chromium 153 + headless shell + winldd downloaded (gitignored).
- Ran the suite headed, in four slices, while the user watched:
  - Layer 1 `extraction API`: 106/106 (12.3 s).
  - Layer 2 `the model reads the file`: 22 + 13 + 58 + 13 = 106/106.
  - Layer 3 `formats that cannot be tested`: 3/3 (documents the .rar/.heic/.heif skips).
- `docs/STATE.md`, `docs/ISSUES.md` — created (neither existed before).

## Earlier this task (already verified, kept for the record)
- Added `lib/server/extract/` (office, rtf, notebook, archives, strings, pdf, ffmpeg,
  audio) behind `app/api/files/extract/route.ts`; deleted `app/api/files/extract-pdf/route.ts`.
- Added `lib/files/extensions.ts` (extension-first classification for the full format list)
  and rewired the client pipeline + attachment chips.
- In-repo deps only: `ffmpeg-static`, `@huggingface/transformers` (whisper), `7zip-bin`,
  `node-unrar-js`, `unpdf`. Nothing installed globally.
- `scripts/make-fixtures.mjs` — 106 fixtures + manifest; `tests/file-reading.spec.ts` — the suite.
- `.gitignore` += `.data/`, `tests/fixtures/`; `tsconfig.json` excludes `.next`, `tests/fixtures`.
