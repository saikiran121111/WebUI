# Performance & Quality Assurance

Depends on: `3d` (fence contract).

## When this runs
Large scenes (many parts, long paths, high segments), repeated iterations,
or when the user mentions lag, mobile, or "heavy".

## Hard budgets (the validator rejects violations — design inside them)
- ≤ 120 nodes total (objects + nested children), hierarchy depth ≤ 6.
- Segment caps: radial ≤ 64, tubular ≤ 128, sphere widthSegments ≤ 64,
  lathe points ≤ 64, extrude shape points ≤ 40, tube path points ≤ 64.
- ≤ 10 labels, ≤ 8 sliders, ≤ 12 animations.
- Keep the whole scene under ~150k triangles: a 32-segment lathe is ~2k
  tris, so 12 hero parts is fine; 60 high-segment spheres is not.

## Where the app already spends its budget (don't duplicate it)
- Image-based environment + 3 lights + optional shadow map — you don't add
  lights.
- Pixel ratio capped at 2, rAF parked at 0% when the canvas scrolls off,
  full dispose of geometries/materials/textures/renderer on unmount — you
  don't manage cleanup.
- Three.js + addons load only when a 3D fence actually renders.

## Self-validation before you emit (do this every time)
1. Re-read your JSON: valid JSON, no comments/trailing commas, all ids unique.
2. Every `sliders.target`, `animations.target`, `labels.target` references an
   existing `id` (including nested children ids).
3. Geometry params inside the caps above; colors are `#RRGGBB`.
4. Mental render: what does the default camera see? Are the hero parts
   within the 10-unit box, facing the camera at [6,4,8]?
5. Count nodes — if over ~120, group small details into fewer parts.

## Common failure modes to fix in your draft
- Rejected spec (viewer falls back to raw JSON): almost always a bad param
  name, unknown geometry kind, or a target id typo.
- Subject off-screen: keep the model centered near origin, camera auto-fits
  but a wildly off-center hierarchy defeats it.
- Z-fighting: two coplanar surfaces — offset one by ≥0.01 or merge.
- Muddy dark render: wrong lighting preset for the world (see
  `materials-and-lighting`).

## Acceptance checklist
- [ ] Inside all budgets; ids unique; targets resolve.
- [ ] JSON re-validated mentally line by line before emitting.
- [ ] Hero parts face the default camera inside the 10-unit box.
- [ ] No duplicate lighting/cleanup concerns taken on by the spec.
