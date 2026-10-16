# AI 3D design system: delivery report

Date: 2026-10-16. Everything below was implemented in this repo and run
against it; test counts and commands are the actual observed results.

## What was built

The old 3D output was primitive soup: boxes and cones standing in for real
objects. It is replaced by two genuine modes plus a skill pack that teaches
the local model how to produce both.

Mode A, procedural scenes. The model emits a `scene3d` fence: strict JSON
that a zod schema validates, then a deterministic builder turns it into real
three.js geometry. Lathe profiles, extruded polygons, tubes along curves,
and primitives, with PBR materials, studio lighting presets, HTML labels
that track their node through the render loop, parameter sliders bound to
rotation/position/scale channels, and yoyo animations built as quaternion
and vector keyframe tracks. No model output is ever executed as code.

Mode B, genuine AI meshes. An `asset3d` fence carries a text prompt to a
server-side provider adapter (Meshy v2 first, pluggable behind
`lib/three3d/providers/types.ts`). The job runs in two stages: an untextured
preview mesh, then an automatic PBR refine pass. The finished GLB previews
in the same viewer, and downloads appear only for formats that job actually
produced.

The viewer for both modes: orbit, right-drag pan, scroll zoom, grid/axes/
wireframe toggles, animation play/pause, reset view, fullscreen, live mesh/
vertex/triangle stats, click-to-inspect a part with an "Ask AI about this 3D
part" hand-off, and hover tooltips. three.js loads via dynamic import, so it
stays out of the initial bundle (verified: the BufferGeometry chunks are not
in the prerendered index.html script list; first load of `/` stayed 194 kB).

## The skill pack

Eight skills live in `skills/3d/**/SKILL.md` with `skills/manifest.json`
(domain root plus scene-design, geometry-and-topology, materials-and-
lighting, interaction-and-animation, asset-generation, export-and-
interoperability, performance-and-quality-assurance). They are WebUI
application files. Nothing was installed under `~/.claude/skills/` or
`.claude/skills/`, no plugins, hooks, or CLAUDE.md changes were made for
this feature, and the app works with Claude Code closed.

`lib/skills/intent.ts` detects 3D intent from the last user message with
strong signals (`3d`, `three.js`, `scene3d`, `mesh`, `glb`, `text-to-3d`,
etc.) and spatial subjects (solar system, pitch/roll/yaw attitude demo). A
bare "model" never triggers: "AI model", "language model", and "model
endpoint" are explicit unit-tested non-matches. `lib/skills/loader.ts`
resolves the matched sub-intents to skill ids with a dependency closure,
guards every path read against the skills root, and returns the instruction
text. `injectThreeSkills` in `app/api/chat/route.ts` parses the raw request
body, splices a system message with the selected skill text right before the
last user message, and re-serializes. If anything about the request is
unparseable it passes through untouched.

The system prompt (`lib/render/systemPrompt.ts`) carries the v2 scene3d
contract and the line "Loose primitive soup is a failure." The showcase
(`?demo=ui`) demonstrates both modes: a deep-space probe scene (lathe bus,
extruded solar arrays, lathed dish, tube boom, five labels, a yoyo antenna
sweep, pitch/roll/yaw sliders) and an `asset3d` fence for a stylized rocket.

## Credentials and the security boundary

`MESHY_API_KEY` is read only in `lib/three3d/providers/meshy.ts`, server-
side. `.env.example` ships the variable empty with honest comments. The
browser never sees the key: it holds an opaque job id (`meshy:pv:<id>` /
`meshy:rf:<id>`) and talks only to same-origin `/api/3d` routes. The
download route proxies the provider artifact bytes through our server, so
there is no CORS exposure and no signed-URL leakage to the client either.

Model-generated fence JSON is validated by zod (`scene3dSpecSchema`,
`asset3dSpecSchema`) with budgets (120 nodes, depth 6, 10 labels, 8 sliders,
12 animations), duplicate-id rejection, hex color checks, and animation
targets that must resolve to declared nodes. Invalid fences render as a
source code block with a note, never as executed content. The skill loader
refuses any path outside `skills/`.

API behavior when unconfigured: `POST /api/3d/assets` returns 503 with
"No 3D generation provider is configured on this server. Procedural scene3d
remains available." The block shows that message and points at procedural
mode. There is no fake generation fallback anywhere.

## Export and format honesty

Procedural scenes export GLB and GLTF through the official GLTFExporter,
including the animation clips. The GLB path proves itself: the exported
bytes are parsed chunk-by-chunk (`validateGlb`: magic, version 2, length,
JSON/BIN chunk types) and re-imported through GLTFLoader (`reimportGlb`);
the toolbar note reports how many meshes loaded back. The Playwright test
asserts that note appears.

Provider assets offer only formats the job actually produced. The format
list in the UI is filtered by `job.modelUrls`; requesting an absent format
gets 409 `this asset has no FBX output` rather than an empty file. OBJ is
packaged server-side as a zip containing the .obj, the .mtl with texture
references rewritten to local names, and the fetched textures; a texture
that fails to download is commented out of the MTL so the material file
stays valid. The zip is written by a dependency-free store-only writer
(`lib/three3d/zipWriter.ts`) whose CRC-32 and structure are unit-tested.
Meshy's six formats (glb, obj, fbx, stl, usdz, 3mf) are what the adapter
declares; nothing claims more.

## Tests, exactly as run

Unit (vitest, `__tests__/three3d/`, 7 files, 49/49 passed):
- `intent.test.ts` 8: strong signals, spatial subjects, the "AI model" /
  "language model" / "model endpoint" non-triggers, sub-intent ordering.
- `skillLoader.test.ts` 4: dependency closure order, path guard, manifest
  resolution.
- `sceneSchema.test.ts` 11: schema rejects (dup ids, bad hex, unresolvable
  targets, budget overruns) and the demo fence parsing.
- `sceneBuilder.test.ts` 7: node hierarchy, pickables exclude the grid,
  yoyo animation tracks get three keyframes, stats.
- `glbExport.test.ts` 4: export → validate → re-import round trip.
- `zip.test.ts` 3: known CRC (`crc32("hello") = 0x3610a686`), entry
  structure, EOCD offsets.
- `meshyProvider.test.ts` 12: preview body shape, 401/402/429 error text,
  status mapping, refine hand-off, refine-failure honesty, cancel endpoint,
  absent-format refusal, OBJ zip packaging with the `map_Bump` case.

Full unit suite: `npx vitest run` 259/259 across 18 files. `npx tsc --noEmit`
clean. `npm run build` succeeded.

E2E (Playwright, chromium-headless, workers=1):
- `tests/three3d.spec.ts` 3/3: viewer renders the demo scene with stats and
  labels, play toggle, aria-pressed toggle loop for grid/axes/wireframe,
  GLB export produces the "re-import verified" note, format options are
  exactly GLB/GLTF; the `asset3d` block with a mocked 503 shows the honest
  unconfigured message and renders no stage and no download buttons; the
  `/api/3d` contract probes (empty prompt, bad job id, bogus format) return
  only 400/503-class codes, so a test run can never burn provider credits.
- Full regression: 10 specs, 45/45 passed (chat-stream, conversations-crud,
  conversations-live-chat, inspect-dup, reasoning-test, multi-select-delete,
  edit-stop-collapse, render, interactive-ui, three3d).
- `tests/file-reading.spec.ts` was excluded from the regression run: its
  layer 2 needs a live llama.cpp model on :8080. That exclusion predates
  this work and is documented in `docs/STATE.md`; the 3D changes do not
  touch that pipeline.

One pre-existing test needed a fix during the regression: the CRUD archive
test asserted a global "Archived" button count and broke on a leftover
archived conversation from a killed earlier run. The assertion is now
scoped to the seeded conversation and the stale row was removed through the
app's own DELETE API. Root cause and fix are recorded in `docs/ISSUES.md`.
This was test fragility, not an app bug.

## Honest limitations

- The Meshy live path is unit-tested against a mocked fetch. No real API
  key was exercised end to end during this delivery, so the wire format is
  verified against the documented v2 API and mocks, not against a live job.
  With `MESHY_API_KEY` set, the `?demo=ui` asset3d fence starts a real,
  billable generation. The Playwright specs mock `/api/3d/assets*` to 503
  precisely so tests never spend credits.
- The Node-side GLB round-trip test installs a small FileReader shim
  because GLTFExporter's binary path expects one; the browser path needs no
  shim and is proven by the Playwright export test.
- TRELLIS is not wired up. The provider interface (`providers/types.ts`) is
  what a second provider implements; Meshy is the one implemented.
- OBJ packaging ships textures that the provider exposes as downloadable
  URLs. A texture the provider does not expose is commented out of the MTL
  rather than silently dropped.
- The zip writer is store-only (no compression). Files are slightly larger
  than a compressed archive; validity is what was tested.

## Running and verifying

```
npm run dev                          # app on :3000, model on :8080
npx vitest run __tests__/three3d/    # 49 unit tests
npx vitest run                       # 259 unit tests
npx tsc --noEmit                     # typecheck
npx playwright test tests/three3d.spec.ts --workers=1 --reporter=list
```

Playwright needs the dev server up (the config has no webServer block).
Browsers are cached in-repo at `.data/ms-playwright`.

## Files

Created: `skills/README.md`, `skills/manifest.json`, 8 `skills/3d/**/SKILL.md`,
`lib/skills/{intent,loader}.ts`, `lib/three3d/{sceneSchema,geometryKit,
materials,lighting,camera,sceneBuilder,exporters,zipWriter,viewerCore}.ts`,
`lib/three3d/providers/{types,meshy}.ts`, `app/api/3d/assets/route.ts`,
`app/api/3d/assets/[id]/route.ts`, `app/api/3d/assets/[id]/download/route.ts`,
`components/render/Asset3DBlock.tsx`, `.env.example`, 7 test files under
`__tests__/three3d/`, `tests/three3d.spec.ts`.

Modified: `app/api/chat/route.ts` (skill injection), `components/
MarkdownRenderer.tsx` (asset3d routing), `components/render/Scene3DBlock.tsx`
(v2 rewrite), `lib/render/{registry,systemPrompt,schemas,demoShowcase}.ts`,
`app/globals.css` (3D + asset3d chunks), `tests/conversations-crud.spec.ts`
(archive assertion scoping), `docs/{STATE,CHANGELOG,ISSUES}.md`.
