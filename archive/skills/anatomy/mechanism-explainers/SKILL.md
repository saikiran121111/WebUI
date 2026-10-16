# Mechanism & instrument explainers (Anatomy sub-skill)

How to build figures that actually explain a working system.

## One live state model — the core rule
Every number the reader sees must come from the SAME controls that drive
the drawing:
- A slider's value drives `slide` travel and `dial` needle angles.
- `readouts` formulas recompute from those slider values (`"18 + 24 *
  stroke"`, `"clamp(0, 100 * load, 100)"`). Never type a display number
  that contradicts the motion.
- `oscillate:{"period":s}` gives continuous cyclic motion (crankshafts,
  rocking levers) without a control; pair it with a readout on a slider
  that scales the cycle (e.g. rpm) only when the value truly tracks.

## Engines & linkages
- Model the frame/bed as `base`, block/head/crankcase as `structure`,
  pistons/valves/crank as `subject` — the eye follows the motion.
- Pistons: `slide` along the bore axis, parented to the case; crank throws
  as `rod` paths; cam/valve trains as `rod` + short `cylinder` tappets.
- `explode` vectors along each part's assembly axis (head up, pistons up,
  bearings outward) so the exploded view teaches build order.

## Instruments & gauges
- `dial` part: `ticks` (count/every/from/span) + `needle` bound to a
  slider `state`; `faceLabel` for units and the dial name.
- Bind the needle's `from`/`to` degrees to the physical range the slider
  represents; the readout formula converts the same slider to engineering
  units (e.g. `"0.01 * plunger_travel"` for a dial indicator).
- Rulers/`ruler` parts for travel scales next to the moving element.

## Fluid & pneumatic systems
- Pipes/ports are `rod` runs with real radius; route them with 90° bends
  at manifold centers, not spaghetti.
- Valves: `cylinder` body + `slide` spool or `knob` handle; actuators:
  `cylinder` bore + `slide` piston rod (`rod` kind) parented correctly.
- A `toggle` control can gate which subsystem you describe in `note`s —
  visual gating of pipes is not rendered, so use notes/readouts to carry
  the on/off meaning.

## Explainer honesty
- If the user's concept has no physical mechanism (a software pipeline, a
  statistics idea), do NOT invent gears around it — answer with prose, a
  chart, or a mermaid diagram instead. Anatomy is for real hardware only.
- Hover `note`s must state what a part DOES, not filler.
