# STATE

## Done (locked — do not re-read)
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
- [x] Screenshot bug fixes (2026-10-15): grammar-dependency cascade + circular-alias
      filter (`lib/render/highlight.ts`, `grammarDependencyLoader` in languages.ts),
      `stripLineNewlines`, vivid `themes.ts`, tree renderer (`lib/render/treeParse.ts`,
      `components/render/TreeBlock.tsx`, globals.css tree chunk with minmax(0,0fr)
      collapse), list-marker restore + heading-code 0.85em, CodeBlock throttle-with-
      trailing + monotonic `appliedSeq` for mid-stream color.

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
- [ ] Full `npx playwright test` not run: `tests/file-reading.spec.ts` layer 2
      needs a live llama.cpp model on :8080; the 6 other regression specs were
      left un-run at the user's stop — awaiting direction.

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
