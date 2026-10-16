# Geometry & Topology

Depends on: `3d` (fence contract).

## When this runs
The request needs real shape-building: curved surfaces, profiles, wings,
pipes, rounded forms, "detailed", "smooth", "proportionate".

## Geometry kinds — exact parameter names

| kind | params | use for |
|---|---|---|
| `box` | `width, height, depth` | panels, blocks, frames |
| `sphere` | `radius, widthSegments?, heightSegments?` | planets, tanks, hubs |
| `cylinder` | `radiusTop, radiusBottom, height, radialSegments?, openEnded?` | struts, wheels, nacelles |
| `cone` | `radius, height, radialSegments?` | nose cones, nozzles (prefer lathe for bells) |
| `torus` | `radius, tube, radialSegments?, tubularSegments?` | tires, rings, orbit paths |
| `capsule` | `radius, length, capSegments?, radialSegments?` | rounded rods, piston barrels |
| `lathe` | `points: [[x,y],...], segments?` | **revolved profiles: fuselage, dishes, bottles, engine bells** |
| `extrude` | `shape: [[x,y],...], depth, bevelEnabled?, bevelSize?, bevelThickness?, bevelSegments?` | **wings, panels, brackets, body side-profiles** |
| `tube` | `path: [[x,y,z],...], radius, radialSegments?, tubularSegments?, closed?` | pipes, wiring, struts along curves |
| `plane` | `width, height` | backdrops, decals |
| `grid` | `size, divisions` | ground reference |
| `arrow` | `length, shaftRadius, headRadius, headLength` | axes, force vectors |

Rules:
- `lathe.points`: x ≥ 0 (radius), y = axis; first/last point should sit on
  the axis (x=0) to close the solid; 4–12 points for a clean profile;
  `segments` 24–32 for visible curves, 12–16 for hidden parts.
- `extrude.shape`: closed polygon ring (do not repeat the first point),
  3–40 points; enable bevel (`bevelEnabled: true`, `bevelSize`/`bevelThickness`
  ≈ 2–5% of thickness) on any edge the user can see — bevels catch highlights
  and kill the "cheap" look.
- `tube.path`: 2–64 points; add midpoints to bend smoothly (a 3-point path
  with a shared tangent direction reads as a curve).
- Segment budgets: radialSegments ≤ 32 visible / 12 hidden; tubularSegments
  ≤ 64; sphere widthSegments ≤ 32. Total nodes ≤ 120 including children.

## Topology quality rules
- Match curvature to visibility: a wheel seen at distance needs 16 radial
  segments, a close-up hero cylinder needs 32.
- Smooth normals everywhere except deliberate faceting (low-poly style →
  `flatShading: true` in the material, and then keep segments low on purpose).
- Symmetric objects: build one side, mirror by transform (`scale: [-1,1,1]`
  on a mirrored child group, or place both with mirrored positions) — do not
  hand-place lopsided parts.
- Wall thickness for hollow-looking parts: use two lathes (outer/inner) or
  `openEnded` cylinders with a rim torus, not a single paper-thin plane.
- UVs: lathe/extrude/tube get automatic UVs from the app; keep texture-ish
  detail in material values (roughness/metalness breaks), not fake image maps.

## Anti-patterns (reject these in your own draft)
- A "spacecraft" that is one box + one cone.
- Spheres for wheels. Cones for wings. Boxes for fuselages longer than 3 m
  without a lathe profile.
- Same segment count everywhere (either all 8 or all 64).
- Parts scaled non-uniformly to fake shape (`scale: [3, 0.1, 2]` on a sphere)
  when a proper profile exists — non-uniform scale is for panels/flat things only.

## Acceptance checklist
- [ ] Curved subjects use lathe/extrude/tube, not scaled primitives.
- [ ] Visible edges have bevels; hidden parts use low segments.
- [ ] Profiles close on the axis; shapes are watertight-looking.
- [ ] Within segment/node budgets.
