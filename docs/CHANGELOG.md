# CHANGELOG

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
