# Isometric drawing craft (Anatomy sub-skill)

Rules that separate a drafted illustration from primitive soup.

## Solids, always
- Every part has thickness: `slab`/`cylinder`/`prism` for bodies and
  frames, `rod` (with radius) for pipes, pushrods, con-rods, wiring runs,
  `coil` for springs and windings, `knob` for controls, `screws` for
  fastener clusters. A part drawn as a flat outline reads as a failure.
- Use `bevel` on slabs/cylinders for cast or machined edges; `r` in plans
  for rounded corners; `steps` only as high as the silhouette needs.
- `prism` with `convex:false` for L-brackets and non-convex plates.

## Tone hierarchy (the renderer's shading IS your tone field)
- `base`: ground, bed plates, mounting surface — darkest, gets a halo.
- `structure`: frames, housings, bores — mid tone.
- `subject`: the hero parts that move or carry the idea — brightest.
- `accent`: exactly ONE part max, rendered lit — the single thing the
  reader should look at (an ignition source, a crack, a seal). Two accents
  fail validation.
- If a part is not one of those roles, it should not be in the figure.

## Line discipline
- Hidden/coil-back lines and knurling render faint automatically — do not
  fight them with extra parts.
- `callout` leaders are straight wire runs with a tone; keep text ≤40
  chars, place with `dx`/`dy` away from busy geometry. Callouts are static:
  they do not follow exploded parts.
- `faceLabel` prints on a solid's top face — use it for engraved names,
  scale numbers, "IN"/"OUT". Keep ≤24 chars.
- `ruler` parts give a real graduated edge (stroke bores, travel scales).

## Depth & hierarchy
- Parent with `on`: children inherit position AND motion (a piston child of
  a sliding carrier moves with it). Nesting is the depth contract; the
  renderer sorts by camera depth.
- `offset` is relative to the parent's anchor — dimension parts off their
  parents, not the world origin.

## Composition budgets
- The camera auto-fits all solids (callout `at` points included). Fill
  ~55–65% of the frame: if the figure reads tiny, your parts are too small
  relative to each other or you added junk parts — fix extents, not width.
- The plate must read at 390px wide: prefer 4–12 substantial parts over
  40 tiny ones; labels ≤60 chars; hover `note` ≤140 chars.
- Legend ≤8 keys; use it only when tone/mark meaning is genuinely coded.

## Junk-part ban
No decorative parts that carry no structural or explanatory meaning.
Every solid must appear in the parts list's story. Budgets: ≤90 parts,
≤24 rod path points, ≤40 outline points.
