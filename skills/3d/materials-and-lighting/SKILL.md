# Materials & Lighting

Depends on: `3d` (fence contract).

## When this runs
The request mentions materials, textures, metal, gloss, realism, lighting,
shadows — or the subject's realism depends on surface separation (vehicle,
spacecraft, product, engine).

## Material schema (per object)
```json
"material": { "color": "#RRGGBB", "roughness": 0..1, "metalness": 0..1,
  "opacity": 0..1, "transparent": true, "emissive": "#RRGGBB",
  "emissiveIntensity": 0..5, "flatShading": false, "side": "front|back|double" }
```
The app renders these as `MeshStandardMaterial`/`MeshPhysicalMaterial` with
physically-based lighting — values below are calibrated for that pipeline.

## Believable surface values (use these, never defaults-everywhere)

| surface | color hint | roughness | metalness |
|---|---|---|---|
| brushed aluminum | #B8BCC2 | 0.35–0.45 | 0.9 |
| polished steel | #D8DADD | 0.12–0.2 | 1.0 |
| anodized panel (spacecraft) | #C9A227 gold / #38BDF8 | 0.3 | 0.8 |
| painted car body | subject color | 0.25–0.4 | 0.6 |
| rubber tire | #1A1A1C | 0.9 | 0.0 |
| matte plastic | #2A2D33 | 0.6–0.8 | 0.0 |
| glass canopy | #9FD3E8, opacity 0.35, transparent | 0.05 | 0.0 |
| fabric upper (procedural stand-in) | subject color | 0.85 | 0.0 |
| skin/wood/stone | warm hues | 0.6–0.9 | 0.0 |
| engine glow / thruster | emissive #FF6A3D, intensity 2–4 | 0.4 | 0.0 |
| solar cell | #1B2A5E | 0.25 | 0.6 |

Rules:
- **Material separation is the #1 quality lever.** A vehicle needs at least:
  body paint, glass, tire rubber, trim/metal, lights. Assign each part its
  own material row — never one material for the whole model.
- metalness is almost always 0 or ~0.6–1.0; intermediate values are for
  worn/composite surfaces only.
- Emissive is for actual light sources (lamps, thrusters, screens), not for
  "making a part visible".
- Dark scenes: raise `roughness` contrast between parts instead of adding
  random bright colors. Stay inside the app's Obsidian palette family —
  desaturated metals + one accent, not rainbow primitives.

## Lighting presets (`lighting.preset`)
- `studio` (default): soft key + fill + rim, gentle shadows — products, vehicles.
- `dramatic`: strong key, low fill, high rim — hero shots, engines.
- `blueprint`: even ambient, thin grid, low specular — technical explainers.
- `space`: near-zero ambient, one hard sun-like key, black background —
  spacecraft, planetary.

`shadows: true` for grounded subjects (contact shadow sells placement);
`false` in space scenes. `ambientIntensity` 0–3 tunes fill.

The app adds an image-based environment (studio reflections) automatically —
do not add your own light objects; tune the preset instead.

## Acceptance checklist
- [ ] Every distinct physical part has its own material entry.
- [ ] Roughness/metalness from the table, not 0.45/0.15 everywhere.
- [ ] Preset matches the subject's world (space vs grounded).
- [ ] Glass/emissive used only where physically justified.
