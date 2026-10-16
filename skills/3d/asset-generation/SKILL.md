# AI Asset Generation (Mode B)

Depends on: `3d` (fence contract, `asset3d`).

## When this runs — and when it must not
Run when the user wants a **genuine generated mesh asset**: organic or
complex forms (sneakers, clothing, characters, animals, furniture, sculpted
props), "AI-generated 3D model", "text-to-3D", "image-to-3D", or explicitly
downloadable production model files of such an object.

Do NOT run for: technical/explainer scenes, mechanisms with named tunable
parts, planetary systems, diagrams — those belong in `scene3d` where parts
are inspectable and slider-driven. Do NOT run when the user only mentions an
"AI model" or "model endpoint" — that is not a 3D asset request.

## What you emit
One `asset3d` fence (see parent contract). The app owns the whole job:
provider call, polling, progress UI, error handling, cancellation, downloads.
You never call the provider yourself and never mention keys or providers'
internal URLs.

Prompt-writing rules (this is your main job — the mesh quality follows it):
- Describe ONE physical object in product-scan language: parts, materials,
  construction, style, topology intent.
  Good: `"detailed running sneaker, layered foam midsole, woven fabric upper,
  flat laces, visible stitching seams, game-ready low-poly, clean quad flow"`.
  Bad: `"a cool shoe in a room"` — no scenes, no backgrounds, no verbs.
- Add topology intent when the user will edit/animate it: "clean quad
  topology", "low-poly game asset", "high detail sculpt".
- `quality: "detailed"` only when the user asks for realism/high detail —
  it is slower and costs more credits.
- `formats`: mirror what the user asked to download (default `["glb"]`).

## After the job
The viewer shows the generated asset with its real supported download formats
(the provider decides availability — typically glb/obj/fbx/stl/usdz, 3mf on
request). Tell the user in prose what was generated and what they can
download. If the app reports the provider is not configured, relay that
honestly and offer a `scene3d` procedural approximation **labeled as such**.

## Iteration
"Make it more worn", "regenerate with thicker sole" → emit a new `asset3d`
fence with the refined prompt (keep the same `title`). Generation is not
incremental; do not claim a re-roll edits the previous mesh.

## Acceptance checklist
- [ ] Subject is genuinely organic/complex enough to warrant a generated mesh.
- [ ] Prompt is one object, physical, with topology intent.
- [ ] Formats match the user's download ask.
- [ ] No provider internals (keys, URLs, credits) in your text.
