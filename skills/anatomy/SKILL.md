# Anatomy — isometric technical illustration (WebUI skill pack)

You draw ONE kind of artifact: a crafted, interactive **isometric technical
illustration** of a real mechanism or instrument, emitted as an `anatomy`
fence. The renderer projects your JSON into an SVG plate with a live state
model — you never write SVG, HTML, or JavaScript.

## Routing boundaries (strict)

- **Use `anatomy`** for: machines, engines, pumps, valves, gear trains,
  linkages, gauges/dial indicators, hydraulic/pneumatic systems, "how X
  works" explainers with moving parts, exploded views, cutaways, isometric
  technical illustrations.
- **Do NOT use `anatomy`** for: building/architecture design, C4 or schema
  or ER diagrams, flowcharts/org charts/UML, bar/line/pie charts (use
  `chart`), wireframes/UI mockups, circuit schematics.
- **Never present an illustration as a 3D mesh.** If the user wants a
  genuine 3D model, mesh, or GLB/FBX/OBJ/STL/USDZ/3MF file, use `scene3d`
  (procedural scene) or `asset3d` (AI-generated mesh) instead — never the
  anatomy fence, and never claim an SVG is a mesh.
- If a request mixes both ("isometric engine diagram I can also export as
  GLB"), emit the anatomy fence AND a scene3d fence, and say plainly which
  is which.

## The fence contract

Emit exactly one JSON object in a ```anatomy fence. Valid JSON only — no
comments, no trailing commas. Unknown keys fail validation.

Top level:
```
{"title":"Four-stroke cylinder head","fig":"FIG 1","label":"aria label for the figure",
 "caption":"one-line takeaway under the plate","hint":"hover parts for notes",
 "width":650,"height":420,"camera":{"azimuth":45,"elevation":30},
 "parts":[...],"controls":[...],"readouts":[...],"legend":[...],
 "explode":{"label":"Explode"},"export":{"filename":"four-stroke-head"}}
```
- `width` 320–900 (default 650), `height` 240–720 (default 420). The figure
  auto-fits the camera to your parts — never fight framing by hand.
- Budgets (standard profile): ≤90 parts, ≤6 controls, ≤6 readouts, ≤8 legend
  keys, rod paths ≤24 points, prism outlines ≤40 points. For architectural
  cutaways set `"profile":"advanced"` — see "Architectural cutaways" below.

Every part has: `id` (unique), `kind`, `tone`
(`base` = ground/bedding, `structure` = frames/housings, `subject` = the
moving/hero parts, `accent` = exactly ONE highlight, max one per figure),
optional `label` (≤60), `note` (≤140, shown on hover), `on` (parent part id
— child inherits the parent's position and moves with it), `offset`
`[x,y,z]`, `explode` `[x,y,z]` (displacement when exploded), `slide`
`{"axis":"x|y|z","from":n,"to":n,"state":"sliderId"}` or
`"oscillate":{"period":seconds}` for continuous motion.

Part kinds (coordinates are model units; z is up):
- `slab`: `plan {"x","y","w","d","r"}`, `z`, `height`, optional `steps` 3–24, `bevel` 0–8
- `cylinder`: `center [x,y]`, `r`, `z`, `height`, optional `steps`, `bevel`
- `prism`: `outline [[x,y],...]` (3–40 pts), `z`, `height`, `convex` (default true)
- `rod`: `path [[x,y,z],...]` (2–24 pts), `r` (rod radius, REQUIRED, ≤40) — pipes, pushrods, crank throws, wiring runs, columns, mullions
- `coil`: `from [x,y,z]`, `to [x,y,z]`, `center [x,y]`, `r`, `turns` 1–40, `axis "x"|"y"`
- `dial`: `center [x,y]`, `z`, `r`, optional `ticks {"count","every","minor","major","from","span"}`,
  optional `needle {"from":deg,"to":deg,"state":"sliderId","length":0.3–1}`, optional `face` text
- `ruler`: `axis "x"|"y"`, `from`, `to`, `step`, `every`, `edge`, `z`, `lengths [minor,major]`
- `knob`: `center [x,y]`, `r`, `z`, `height`, `knurl` 4–60
- `screws`: `plan {"x","y","w","d","r"}`, `z`, `inset`, `size` — corner fasteners
- `callout`: `at [x,y,z]`, `text` (≤40), `dx`, `dy`, `leader "hi"|"mid"|"lo"|"lit"|"red"|"green"|"blue"`, `dashed`
- `faceLabel`: `target` (part id), `text` (≤24), `size`, `along "x"|"y"`, `faceTone` — text printed on a solid's top face

Controls (drive the live state model):
- `{"id":"stroke","kind":"slider","label":"Piston travel","min":0,"max":1,"step":0.01,"value":0.5}`
- `{"id":"flow","kind":"toggle","label":"Gas flow","value":true}`

Readouts (values are COMPUTED, never typed):
`{"id":"pos","label":"Piston height","unit":"mm","decimals":1,"formula":"18 + 26 * stroke"}`
Formulas may use control ids and `min,max,abs,clamp,floor,ceil,round,sqrt`
with `+ - * / ( )`. A readout's number must come from the SAME control
values that drive the drawing's motion — never hardcode a "display" number
that contradicts the animation.

Legend keys: `{"mark":"raised|flat|lit|edge|dim|dotted|dashed|red|green|blue","label":"..."}`.

## Architectural cutaways (advanced profile)

Set `"profile":"advanced"` for buildings. Budgets rise to ≤240 logical parts,
≤14 controls, ≤8 readouts, ≤12 legend keys, ≤12 groups, ≤100 floors, ≤8
modules, ≤48 connections, ≤48 flows, ≤700 RENDERED parts. Over-budget specs
are rejected with a precise count in the error — never silently truncated.

- `groups`: `{"id","label","color":"gray|green|blue|amber|red|violet|cyan","section"}`
  — independent visibility layers; `section` collapses them into one UI group
  without losing per-layer control.
- `floors`: `{"id","z","height"≤300,"label","module"}` — stable ids; the floor
  select highlights one floor and dims (not hides) the rest, preserving the
  whole-building context.
- `modules`: `{"id","anchorZ","parts"}` — one authored floor module reused by
  many floors; instance ids become `floor__part`. Module furniture must attach
  with `on` to the module's own plate so it rides its floor.
- Parts gain: `group`, `floor`, `visibleWhen` (a toggle control id — the part
  shows only while that toggle is on), `info` (≤240 chars, shown in the
  click-to-inspect panel).
- Controls gain: `toggle` with `group` (layer visibility),
  `{"kind":"button","action":"explode|restore|play|pause|reset|resetView"}`,
  `{"kind":"select","target":"floor"|"system"}`.
- `connections`: `{"id","system","from","to","label","path":[[x,y,z],...]}` —
  service routes (HVAC/water/energy/circulation) as data, separate from the
  drawing geometry. `flows`: `{"id","connection","speed" 0–4}` animate along
  the route with play/pause/reset — never free-floating particles.
- Geometry limits still apply: coordinates ±600, solid `height` ≤300 — split
  tall cores/columns/risers into stacked segments.

## JSON emission discipline (strict)

The renderer accepts ONLY a complete, syntactically exact fence. Three
failure modes break generation — never commit them:

1. **Compact, single-line JSON.** No newlines or indentation inside the
   fence. Pretty-printing doubles the tokens you must generate error-free
   and risks mid-generation truncation.
2. **Never abbreviate.** No `...` placeholders, no "skeleton + prose
   explanation", no "keep the rest as before". Every fence you emit is the
   COMPLETE object, every time.
3. **Fixed-length coordinate arrays.** `[x,y]` has exactly 2 numbers,
   `[x,y,z]` exactly 3 — never `[,...]`, never a dropped slot. Count the
   numbers before closing each bracket.

Required fields per kind (every part also needs `id`, `kind`, `tone`):
slab → `plan{x,y,w,d,r}` (`r:0` = square corners), `z`, `height` ·
cylinder → `center,r,z,height` · prism → `outline,z,height` ·
rod → `path,r` · coil → `from,to,center,r,turns` · dial → `center,z,r` ·
ruler → `axis,from,to,step,every,edge,z,lengths` ·
knob → `center,r,z,height,knurl` · screws → `plan,z` ·
callout → `at,text,dx,dy` · faceLabel → `target,text`.

Size discipline: keep the whole fence under ~20,000 characters. Repeated
floor furniture belongs in ONE module referenced by many floors; full-height
repeats (columns, mullions, risers) get a representative few parts, not
dozens of near-identical rods.

## Worked mini-example

```anatomy
{"title":"Single-cylinder head","fig":"FIG 1","label":"Cutaway single-cylinder head with a sliding piston","width":560,"height":420,"parts":[{"id":"deck","tone":"base","kind":"slab","plan":{"x":-40,"y":-30,"w":80,"d":60,"r":6},"z":0,"height":14,"label":"Deck","note":"Crankcase deck"},{"id":"barrel","tone":"structure","kind":"cylinder","center":[0,0],"r":22,"z":14,"height":46,"label":"Cylinder barrel","on":"deck","explode":[0,0,18]},{"id":"piston","tone":"subject","kind":"cylinder","center":[0,0],"r":20,"z":18,"height":16,"label":"Piston","on":"deck","slide":{"axis":"z","from":2,"to":26,"state":"stroke"},"note":"Runs in the bore"},{"id":"plug","tone":"accent","kind":"cylinder","center":[0,0],"r":3,"z":60,"height":8,"label":"Spark plug","on":"deck"}],"controls":[{"id":"stroke","kind":"slider","label":"Piston position","min":0,"max":1,"step":0.01,"value":0.5}],"readouts":[{"id":"pos","label":"Piston height","unit":"mm","decimals":1,"formula":"18 + 24 * stroke"}],"explode":{"label":"Explode"},"export":{"filename":"single-cyl-head"}}
```

## The quality workflow (follow it, don't skip steps)

1. **Concept first.** Name the real mechanism and what the reader must
   understand from it. If the concept has no physical mechanism, do NOT
   force a machine analogy — answer in prose or a chart/diagram instead.
2. **Relationships.** List the parts as an assembly tree: what mounts on
   what (`on`), what moves against what (`slide`), what reads a value
   (`dial` needle).
3. **Physical representation.** Every part is a solid with thickness —
   slabs, cylinders, prisms, rods with radius. Wireframe outlines are a
   failure.
4. **Parts list → dimensions.** Give every solid real extents relative to
   its neighbors; clearances and wall thicknesses should read as designed,
   not random.
5. **Depth order** is handled by the renderer (painter order from the
   camera). Nest children under parents; do not fake depth with z alone.
6. **Shading** comes from tone hierarchy: `base` darkest, `structure`
   mid, `subject` brightest, at most ONE `accent` (lit) part.
7. **Card framing** is automatic (auto-fit + plate corners); keep the
   composition filling ~55–65% of the frame by choosing sensible extents,
   not by inflating the canvas.
8. **Interactions must mean something.** Sliders drive real travel;
   needles track the same slider; readouts compute from the same values;
   `oscillate` for continuous cycles; `explode` vectors along assembly
   axes. Hover `note`s teach.
9. **Inspect before sending:** every id unique, every `on`/`state`/`target`
   references an existing id, ≤1 accent, budgets respected, fences closed.

## Iteration rules

- For follow-up edits ("make the piston red", "add a flywheel"), emit the
  FULL updated fence but change ONLY what was asked — keep every other
  part, id, control value, and camera as they were.
- Callouts and face labels are static overlays: they do not travel with
  exploded parts. Place them on the assembled view.
- If a figure fails to render, the error note names the exact problem —
  either the bad JSON token + position (`invalid JSON — Unexpected token
  ',' … [,-55,240]`) or the missing field (`parts.21.r: Required`). Fix
  THAT exact problem and re-emit the full fence; never simplify the whole
  figure or answer with a description of the fix instead of the fence.
