# Export & Interoperability

Depends on: `3d` (fence contract).

## When this runs
The user asks to export, download, "open in Blender/Maya/Unity/Unreal",
GLB/glTF/FBX/OBJ/STL/USDZ/3MF, or wants model files of the scene.

## What the app actually exports (do not promise more)

| source | formats the app can deliver |
|---|---|
| `scene3d` procedural scene | **GLB** (official three.js GLTFExporter), **glTF** (embedded buffers) |
| `asset3d` provider asset | whatever the provider generated — typically **glb, obj (+mtl), fbx, stl, usdz**, and **3mf** when requested |

The viewer's format selector shows only formats genuinely available for the
current artifact. Never claim FBX/STL/USDZ for a procedural scene — the app
has no such exporter. If the user needs FBX from a procedural scene, say the
app exports GLB and GLB imports cleanly into Blender/Maya/Unity/Unreal, where
they can convert to FBX.

## Scene conventions that make exports usable
- **Y-up, meters-ish scale** — the app's scenes already follow this.
- **Origin at the subject's natural pivot**: vehicles sit on the ground plane
  with origin at wheel-contact center; spacecraft origin at the bus center;
  characters (provider assets) at the feet (`origin_at: bottom` is the
  provider default).
- `export.filename`: lowercase-kebab slug of the subject (`spacecraft`,
  `sneaker-01`) — no spaces, no punctuation beyond `-`.
- Named parts survive export: the exporter writes node names from `id`/`label`,
  so keep ids meaningful — they become the names users see in Blender's outliner.
- Animations declared in `animations[]` export as glTF animation channels
  (loop/yoyo baked over one duration). Sliders do NOT export — they are
  viewer state.

## For the user (put in prose when relevant)
- GLB = single file, geometry + PBR materials + animations; the universal
  interchange for Blender/Maya/Unity/Unreal.
- OBJ = geometry + MTL + textures as sidecars (provider assets only); the
  app packages them together on download.
- STL = mesh only, no materials — fine for printing, loses everything else.
- USDZ = Apple AR; FBX = Autodesk pipeline; 3MF = slicers.
- After import, expected scale: 1 unit = 1 m.

## Acceptance checklist
- [ ] Only genuinely-available formats offered for the artifact type.
- [ ] Filename slug set in `export.filename`.
- [ ] Pivot/orientation follow the conventions above.
- [ ] Prose states format limits honestly.
