# Interaction & Animation

Depends on: `3d` (fence contract).

## When this runs
The request says interactive, orbit, click, inspect, animate, moving parts,
pitch/roll/yaw, sliders, "show me how X works".

## Interaction flags (`interactions`)
`{ "orbit": true, "pan": true, "select": true, "hover": true }` — all default
true. Turn `pan`/`hover` off only when the app's toolbar would get cluttered
for a tiny inline scene. `select` gives click-to-inspect + "Ask AI about this
part"; keep it on for educational scenes.

## Animations (`animations[]`)
```json
{ "id": "prop-spin", "target": "propeller", "channel": "rotation",
  "axis": "z", "from": 0, "to": 6.283, "duration": 1.2, "loop": true, "yoyo": false }
```
- `channel`: `rotation | position | scale`; `axis`: `x | y | z`.
- `duration` seconds (0.1–60). `loop: true` repeats; `yoyo: true` ping-pongs
  (use for pistons, solar sweeps, pendulums).
- Animate **pivot groups**, not leaf meshes: put the propeller blades in a
  group whose origin is the hub, animate the group. A piston's group origin
  sits at its wrist pin.
- Mechanically-linked motion: give linked channels the **same duration** and
  aligned from/to so the relationship reads correctly (crank 360° ↔ piston
  one full yoyo).
- Planetary orbits: parent each planet to an empty pivot group at the sun,
  rotation animation on the pivot, different durations per planet (Kepler-ish
  ordering: inner = shorter).
- The viewer has a play/pause/reset toolbar — you only declare channels.

## Sliders (`sliders[]`)
```json
{ "id": "pitch", "label": "Pitch", "min": -1.2, "max": 1.2, "step": 0.01,
  "defaultValue": 0, "target": "attitude", "binding": "rotation", "axis": "x" }
```
- `binding`: `rotation | position | scale`. Slider overrides the object's
  base transform on that axis.
- Add sliders when the user can meaningfully explore: attitude (pitch/roll/
  yaw on a dedicated parent group), deployment angle (solar arrays), gear
  extension, piston speed via scale of nothing — instead expose the parameter
  that drives the story.
- ≤8 sliders. Give each a real unit-bearing label ("Solar sweep (rad)").
- Attitude controls: create an `attitude` parent group wrapping the model,
  put all three sliders on it (x/y/z) so rotations compose predictably.

## Labels
`labels[]` render as HTML callouts projected onto the part — one short phrase,
`offset` moves them clear of geometry. Pair a label with each slider'd part so
the user sees what they're tuning.

## Acceptance checklist
- [ ] Moving parts animate their pivot group, correct axis.
- [ ] Linked mechanisms share durations.
- [ ] Sliders drive the story-critical parameters, ≤8, labeled with units.
- [ ] Hover/select left on for anything educational.
