# Rendering Upgrade — Engineering Report (2026-10-15)

## Why code was white

The old pipeline used Prism: it emitted token `<span>` elements with classes
like `token keyword`, but no Prism theme stylesheet was imported anywhere in
the app. The classes had zero CSS behind them, so every token inherited the
plain foreground color. Highlighting was running and completely invisible.

## The pipeline now

Model text → react-markdown 9 + remark-gfm + remark-math/rehype-katex →
component overrides in `components/MarkdownRenderer.tsx`. A `pre` override
recognizes fenced blocks and routes them through a small registry
(`lib/render/registry.ts`, `fenceKind`) to exactly one renderer per kind:
Mermaid, chart, widget, or code. There is no conditional chain inside
`ChatMessage.tsx`, and adding a new fence kind means adding one registry
entry plus one component.

## Syntax highlighting

Shiki 4 core (`createHighlighterCore`) with the JavaScript regex engine — no
WASM, runs cleanly in the browser bundle. Shiki was evaluated first as
requested; it won on real TextMate grammars, dual-theme output, and
per-language chunking.

- `lib/render/languages.ts`: ~150 literal `import("@shikijs/langs/<id>")`
  entries so webpack emits one small chunk per grammar. A language's grammar
  downloads on first use, then stays cached. Only languages actually used
  ever ship bytes.
- Aliases resolve centrally (py→Python, js→JavaScript, yml→YAML). An unknown
  or missing language never gets a fake label — the header reads "Plain
  text" and the body renders verbatim.
- Dual theme via `themes: {dark, light}` + `defaultColor: false`; one CSS
  override in `globals.css` flips the same HTML between themes with no
  re-highlighting. Custom themes in `lib/render/themes.ts`: lavender
  keywords, green strings, blue functions, cyan types, amber numbers, gray
  italic comments, with light-theme parity.
- LRU cache (60 entries) keyed by language + source. During streaming,
  highlighting is debounced 150 ms and skipped above 10k characters until
  the stream settles.

## Source fidelity and copy

The source string from react-markdown is kept verbatim (only the fence's
single trailing newline is trimmed). `pre`/`code` use `white-space: pre` and
`tab-size: 4`; nothing re-wraps or re-formats. Tabs, blank lines, unicode
and emoji survive exactly.

Copy always writes that canonical string through `copyText` (Clipboard API
with an execCommand fallback) — never scraped from the DOM — so line
numbers (CSS counters, not text) and header labels cannot leak in. The
release-blocking e2e test pastes back and compares character-for-character.
One environment note: the Windows clipboard layer rewrites LF to CRLF even
when the app writes the exact string, so the test normalizes line endings
before comparing. Tabs, unicode and emoji still match exactly.

## Tables

`MarkdownTable.tsx`: semantic markup, numeric columns right-aligned with
tabular-nums, subtle dividers, row hover, horizontal scroll wrapper (no
page overflow), long identifiers break instead of blow out the layout.
Sorting activates on hover for tables with ≥5 rows; CSV copy goes through
the same exact-source clipboard path. Both are opt-in-by-presence controls,
not always-on chrome.

## Diagrams

Mermaid 12 with `securityLevel: "strict"`, imported lazily. A custom stage
wraps the rendered SVG: pan/zoom/fit, node click → inspect panel, keyboard
navigation, fullscreen, SVG download, source view + copy. Invalid diagrams
show an error note plus the original source in a normal code block — the
chat never crashes.

`@xyflow/react` was evaluated and not added: Mermaid already covers the
diagram types models emit (flowchart, sequence, class, ER, state, gantt,
pie, journey), and the custom stage provides the pan/zoom/inspect behavior.
One fewer heavy dependency for the same user-visible capability.

## Charts

No chart library. `ChartBlock.tsx` renders a zod-validated JSON spec
(```chart fence) as hand-built SVG: line, bar, grouped bar, area, pie,
donut, scatter. Titles, axis labels, units, hover tooltips, legend,
theme-aware restrained palette, `role="img"` with a text summary, and a
data-table toggle so every mark traces back to its underlying values.
Invalid specs fall back to the raw JSON in a code block — no invented data,
ever.

## Generative UI

`WidgetBlock.tsx` renders a zod-constrained schema (form / tabs / accordion;
text, number, date, checkbox, select, slider). Every control actually
works, state survives streaming re-renders, validation blocks submission
with visible field errors, and the follow-up message contains only the
validated values.

Arbitrary model HTML/JS is never rendered: react-markdown skips raw HTML by
default, Shiki output is escaped, Mermaid runs strict. The sandbox posture
is isolation by not executing, rather than sanitizing and then executing —
smaller attack surface, no DOMPurify dependency.

## Streaming

Partial fences render as plain blocks until they close (no layout jump).
Mermaid waits for complete source (500 ms settle). Charts show nothing until
the JSON parses. Copy always reads the settled canonical string. Widget
state lives in React state keyed per block, so re-renders don't reset it.
The scroll pinning fix from earlier is untouched and still verified.

## Performance

Per-grammar chunks, no WASM boot, LRU highlight cache, 150 ms stream
debounce, >10k-char highlight skip, lazy KaTeX gated by a cheap
`containsMath` check, lazy Mermaid import. Build output: route `/` 173 kB,
first load 264 kB, shared 91.2 kB. Motion is transform/opacity only with
reduced-motion guards; no gradients, glass, or AI imagery anywhere.

## Verification (actual results)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 57/57 green (8 files): language registry + aliases,
  fence routing, math detection, highlight output (dual theme, diff line
  classes, cache identity, tabs/unicode), chart/widget schemas.
- `npm run build` — clean.
- `npx playwright test tests/render.spec.ts` — 8/8 green: Python token
  colors + exact copy, table sort/CSV, Mermaid valid + invalid fallback,
  chart + data toggle, invalid chart fallback, widget validation round-trip,
  streaming partial fence with zero page errors.
- Full Playwright suite not run: `tests/file-reading.spec.ts` layer 2 needs
  a live llama.cpp model on :8080, and the 6 other regression specs were
  left un-run at the user's stop.

## Known limitations

- `lib/stream/parser.ts` `pump()` keeps `buf = tail` while the SSE parser
  also buffers internally — latent double-buffering of incomplete frames.
  Harmless with single-read bodies (the existing parser tests pass); worth a
  small follow-up fix.
- Windows clipboard LF→CRLF normalization is OS behavior, not an app bug;
  tests account for it.
- Charts support the listed spec types; anything outside the schema falls
  back to source.
- No custom-HTML sandbox by design — model HTML is never executed.

## Migration notes

- Removed: `prismjs`, `@types/prismjs`, `types/prismjs.d.ts`.
- Added (all project-local): `shiki`, `@shikijs/langs`, `@shikijs/themes`,
  `mermaid`, `katex`, `remark-math`, `rehype-katex`, `zod`.
- Render e2e needs `npm run dev` on :3000; Playwright browsers live in
  `.data/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH` set in
  `playwright.config.ts`).

## Key files

- `lib/render/`: `languages.ts`, `themes.ts`, `highlight.ts`,
  `clipboard.ts`, `registry.ts`, `mathDetect.ts`, `math.ts`, `schemas.ts`
- `components/render/`: `CodeBlock.tsx`, `MermaidBlock.tsx`,
  `ChartBlock.tsx`, `WidgetBlock.tsx`, `MarkdownTable.tsx`
- `components/MarkdownRenderer.tsx`, `components/ChatMessage.tsx`,
  `app/page.tsx`, `app/globals.css`
- Tests: `__tests__/render/` (5 files), `tests/render.spec.ts`
