# Provider integration: Office Kit PPTX (`@office-kit/pptx`)

Ruke's `.pptx` export writes NATIVE PowerPoint motion (Morph transitions,
entrance/emphasis animations, click builds, crop/geometry Morph pairs) with the
**official `@office-kit/pptx` library** — the Python injector (`scripts/pptx_morph_injector.py`,
retired 2026-11-06) is gone, so a simple export needs no Python at all.

## Upstream reference (verified live, not hand-copied)

| Item | Value |
| --- | --- |
| Source | https://github.com/office-kit/pptx |
| npm package | `@office-kit/pptx` |
| Pinned version | **`0.28.0`** (exact pin in root `package.json` dependencies; lockfile-enforced) |
| Tarball integrity | `sha512-fKdzDu2KszBYskW7JTIC9EH6d1s8Z2BQosbieu5boggmWJQWBhPylQbeTtl+HXDSyvJuJ6OJgr0+mJNS0kWjrQ==` (read from `package-lock.json`) |
| License | **MIT** (`LICENSE` shipped in the package; header verified: "MIT License"); `THIRD_PARTY_NOTICES.md` shipped alongside |
| Runtime deps | **one**: `fflate ^0.8.3` (already a Ruke dependency — no new footprint) |
| Module format | ESM only (`"type":"module"`, `exports.import` → `dist/index.js`, plus a `./node` subpath); pre-1.0 API |
| Engine gate | `engines.node: ">=22.18.0"` — Ruke runs Node v26.12.1 |
| Platforms | Windows x64, Linux x64, macOS (arm64/x64) — pure JS, no native addons, no OS-specific binaries |

## Where Ruke uses it (production)

- `lib/documents/pptxEngine.ts` — builds editable content with **PptxGenJS**
  (native `addChart` charts, stable semantic ids through the public `objectName`
  option), then runs the office-kit motion pass over the in-memory package:
  `loadPresentation` → `getSlides` → `setSlideTransition` (Morph `byObject` / fade)
  → `setShapeAnimation` (per `MotionStep`) → `setShapeImageCrop` (stat crop-fill)
  → `setShapeCustomGeometry` (spotlight cutout) → `validatePresentation`
  (errors abort the build) → `savePresentation`. No temp files, no subprocesses.
- `lib/documents/pptxMotion.ts` — the ONE motion plan; the Framer preview
  (`components/render/PptxBlock.tsx` + `PptxSlideBody.tsx`) plays the same plan,
  so preview and exported file agree.
- The normal entry point stays `POST /api/documents/pptx` (the fence in chat), and
  spec validation happens before any building (`pptxSpecIssues` → 422 at the route,
  same throw at the engine boundary).

## Setup (commands that were actually run on this machine)

```bash
npm i @office-kit/pptx                 # pinned 0.28.0 (MIT) — written into package.json + package-lock.json
npm ls @office-kit/pptx                # webui-chat@0.2.0 └── @office-kit/pptx@0.28.0
node integrations/office-kit-pptx/smoke.mjs
```

No install-time binary download, no postinstall script, no subscription, no
per-use fee, no system service. Nothing is fetched at runtime.

## Smoke test — `smoke.mjs`

`node integrations/office-kit-pptx/smoke.mjs` (exit 0 = green). Model-free,
Python-free, no mocks; it exercises the real upstream package:

1. package identity in `node_modules` (name/version/repo), **MIT license text**,
   lockfile version + integrity prefix, sole-dep check (`fflate ^0.8.3`);
2. Node `engines` gate (`>=22.18.0`) satisfied by the running runtime;
3. a deck built by **PptxGenJS** (Ruke's writer) loads back through
   `loadPresentation`/`getSlides`, and its chart stays a **native chart part**
   (`ppt/charts/chartN.xml`) rather than a raster;
4. Ruke's production primitives round-trip through `savePresentation`:
   Morph `byObject` transition, a timed shape animation, 100 %-crop fill on the
   entry instance of a named image pair (target left untouched), and a
   `custGeom` path set; `validatePresentation` reports **zero errors** on the
   re-loaded saved package;
5. OOXML proof that the motion is what PowerPoint reads: `<p:transition …morph` +
   `<p:timing>/<p:cTn>` present, and the animation's `<p:spTgt spid>` resolves to
   the `cNvPr id` of the shape named `!!Title_s1` (animation keyed to the stable id).

Latest run: **17/17 PASS, `SMOKE: ALL GREEN`, exit 0** (2026-11-06, Node v26.12.1,
Windows 11 x64).

## API surface Ruke depends on (0.28.0, captured from the shipped d.ts + live)

`loadPresentation(Uint8Array)`, `savePresentation`, `validatePresentation`,
`getSlides` / `getSlideCount` (handles are opaque — there is **no** `pres.slides`),
`findShapeByName`, `getSlideTransition` / `setSlideTransition`,
`getSlideAnimations` / `setShapeAnimation`, `setShapeImageCrop` / `getShapeImageCrop`,
`setShapeCustomGeometry` / `getShapeCustomGeometry`.

Notes learned live (guardrails for future edits):

- `setShapeAnimation` direction tokens are full words (`bottom`, `topLeft`, …) —
  `"b"` throws. `build:"byParagraph"` yields one click reveal per paragraph.
- `setShapeCustomGeometry` commands use `kind: "moveTo" | "lnTo" | "close"` with
  `pt:{x,y}` in EMU, and each path must start with `moveTo`.
- Morph is written inside `mc:AlternateContent` with a fade fallback, so a
  PowerPoint version without Morph degrades gracefully instead of erroring.
- `getSlideAnimations().target` is an opaque `{kind:"shape",shapeId}` ref, not a
  name — assert name-keyed targeting through the OOXML (`p:spTgt spid` ↔
  `cNvPr id`) or by re-resolving with `findShapeByName`.

## Compatibility / honesty notes

- Pre-1.0 library: the version is **exact-pinned** (no caret) and the engine tests
  (`__tests__/documents/pptxEngine.test.ts`) re-load every exported package through
  the same library, so an upgrade that changes behaviour fails loudly.
- Structural Morph pairs rely on identical `objectName` values on consecutive
  slides; a missing name is treated as "skip this step", never a hard export
  failure, so a spec quirk can't break a download.
- `reducedMotion:true` in the spec substitutes fade for Morph and drops every
  step — the deliberate accessible fallback, asserted in tests.
- Real-deck playback (PowerPoint slideshow, Morph interpolation, click builds,
  editability) is verified separately against the installed PowerPoint; opening a
  file or reading transition metadata alone is treated as a structural check only.

## Troubleshooting

- `ERR_MODULE_NOT_FOUND` / named-export errors in a CommonJS context → the package
  is ESM-only; import it from ESM (production code is bundled by Next/Vitest, the
  smoke resolves `dist/index.js` via `pathToFileURL` because Windows absolute
  paths are not valid ESM specifiers).
- Version-mismatch fears → `npm ls @office-kit/pptx` must print `0.28.0`; the
  lockfile integrity line above is the exact bytes Ruke was built and tested with.
