# 3D Domain — Parent Skill (shared rules)

## Purpose & activation
This skill is active **only** when the user's request clearly asks for spatial/3D
output: a 3D scene, a 3D object or model, a mesh, 3D rendering, orbit/attitude
controls, or an operation (export, re-texture, resize) on an existing 3D artifact.
It is never active for ordinary chat, and never merely because the words
"model", "AI model", "language model" or "endpoint" appear — those alone are not
3D signals.

## Two generation modes — choose deliberately

1. **`scene3d` fence — procedural interactive scene.** You emit one JSON object;
   the app validates it and builds real three.js geometry deterministically.
   Use for: explainers, diagrams, mechanisms, product-style viewers, planetary
   systems, vehicles/spacecraft built from named parts, anything the user will
   want to orbit, tune with sliders, or export to GLB.
2. **`asset3d` fence — genuine AI-generated mesh.** You emit a prompt card; the
   app runs a text-to-3D provider job and shows the real generated asset with
   downloads. Use when the subject exceeds procedural modeling: organic shapes,
   characters, clothing (sneakers, apparel), furniture with soft forms, "make it
   look like a real scanned/photoreal asset", or when the user explicitly asks
   for an AI-generated/downloadable model file of a complex object.

Never present a primitive approximation as if it were an AI-generated asset. If
the subject is organic/complex and the provider is unavailable, say so plainly
and offer the procedural scene as an explicitly-labeled approximation.

## `scene3d` fence contract (v2)

One JSON object, valid JSON only (no comments, no trailing commas):

```json
{
  "title": "Short scene title",
  "camera": { "position": [6, 4, 8], "target": [0, 0, 0], "fov": 45 },
  "lighting": { "preset": "studio", "shadows": true, "ambientIntensity": 0.5 },
  "objects": [
    {
      "id": "hull", "label": "Main hull",
      "geometry": { "kind": "lathe", "points": [[0,1.6],[0.55,1.2],[0.72,0.4],[0.72,-0.8],[0.4,-1.4],[0,-1.6]], "segments": 32 },
      "material": { "color": "#C9CCD1", "metalness": 0.85, "roughness": 0.35 },
      "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1],
      "children": [ /* nested nodes, same shape */ ]
    }
  ],
  "labels": [ { "target": "hull", "text": "Main bus", "offset": [0,1.8,0] } ],
  "animations": [ { "id": "solar-swing", "target": "panelL", "channel": "rotation", "axis": "y", "from": -0.4, "to": 0.4, "duration": 6, "loop": true, "yoyo": true } ],
  "sliders": [ { "id": "solar", "label": "Solar sweep", "min": -0.4, "max": 0.4, "step": 0.01, "defaultValue": 0, "target": "panelL", "binding": "rotation", "axis": "y" } ],
  "interactions": { "orbit": true, "pan": true, "select": true, "hover": true },
  "export": { "filename": "spacecraft", "formats": ["glb"] }
}
```

Geometry kinds and exact parameter names are in `3d/geometry-and-topology`.
Materials/lighting values are in `3d/materials-and-lighting`. The app enforces
hard budgets (≤120 nodes, segment caps); specs outside them are rejected —
the viewer then shows the raw source, so get it right the first time.

## `asset3d` fence contract

```json
{ "title": "Detailed sneaker", "prompt": "detailed low-poly sneaker, layered sole, fabric upper, laces, seams, game-ready", "formats": ["glb","fbx"], "quality": "standard" }
```

- `prompt`: 1–800 chars, describe the object physically (parts, materials, style),
  not the scene around it. One object per job.
- `formats`: optional subset of `glb, obj, fbx, stl, usdz, 3mf` (what the user
  wants to download; the provider returns what it supports).
- `quality`: `"standard"` (fast) or `"detailed"` (higher polycount/texture res).
- The app handles the job lifecycle, progress, errors and downloads. Never
  mention API keys. If the provider is not configured the app tells the user —
  do not fabricate a result.

## Quality bar (applies to every 3D answer)

- Real three.js geometry — never CSS/2D tricks, never a pile of unlabeled boxes.
- Named, parented parts in a coherent hierarchy; recognizable silhouette from
  the default camera; consistent real-world-ish scale.
- No floating parts, no accidental interpenetration, no flat-shaded blobs, no
  random colors. Every component gets a purposeful material.
- The default camera frames the subject immediately — no user repair needed.
- Prefer 3–6 well-placed, detailed components over 30 sloppy ones.

## Iteration rules

When the user asks to change an existing scene (enlarge a wing, change a
material, rotate a part), re-emit the **full updated fence** keeping every
unchanged part's `id` identical — the app diffs by id and preserves camera,
slider values and selection where possible. Do not restart the design from
scratch unless asked.

## Sub-skills (loaded with this one when relevant)
`scene-design` (composition & domain templates), `geometry-and-topology`,
`materials-and-lighting`, `interaction-and-animation`, `asset-generation`,
`export-and-interoperability`, `performance-and-quality-assurance`.
