/**
 * Validator proof harness for the two fences that broke in the UI:
 *   1. "3D scene data did not validate — showing the source instead."
 *   2. "entities.12.content: Required (+115 more)"
 *
 * Feeds the EXACT model-emitted fixtures into the real normalizers the
 * viewer blocks mount with (normalizeScene3d / normalizeCad) and proves
 * both return ok:true with zero errors.
 *
 * Run: npx -y tsx scripts/test-validators.mjs
 */
import { normalizeScene3d } from "../lib/three3d/normalizeScene.ts";
import { normalizeCad } from "../lib/cad/normalizeCad.ts";

/* ── Fixture A: exact "Sci-Fi Energy Core Logo" ```scene3d fence ───────── */
const SCENE_FIXTURE = `{
  "title": "Sci-Fi Energy Core Logo",
  "lighting": { "preset": "dramatic" },
  "objects": [
    {
      "id": "Core_Sphere",
      "label": "Core_Sphere",
      "geometry": { "kind": "sphere", "radius": 1, "widthSegments": 48, "heightSegments": 48 },
      "material": { "color": "#38e8ff", "emissive": "#00c8ff", "metalness": 0.1, "roughness": 0.2 },
      "position": [0, 0, 0]
    },
    {
      "id": "Corner_Nodes",
      "label": "Corner_Nodes",
      "geometry": { "kind": "sphere", "radius": 0.22, "widthSegments": 24, "heightSegments": 24 },
      "material": { "color": "#7df9ff", "emissive": "#20d8ff", "metalness": 0.2, "roughness": 0.15 },
      "position": [0, 0, 0],
      "children": [
        {
          "id": "Corner_Node_TR",
          "label": "Corner_Node_TR",
          "geometry": { "kind": "sphere", "radius": 0.22 },
          "material": { "color": "#7df9ff", "emissive": "#20d8ff" },
          "position": [1.9, 1.9, 0]
        }
      ]
    }
  ],
  "labels": [
    { "target": "Core_Sphere", "text": "Core_Sphere" }
  ],
  "animations": [
    { "id": "spin_outer", "target": "Outer_Ring", "channel": "rotation", "axis": "x", "from": 1.5708, "to": 7.854, "duration": 12, "loop": true, "yoyo": false }
  ],
  "sliders": [
    { "id": "coreGlow", "label": "Core glow intensity", "min": 0, "max": 2, "step": 0.05, "defaultValue": 1, "target": "Core_Sphere", "binding": "position", "axis": "y" }
  ],
  "export": { "filename": "energy-core-logo" }
}`;

/* ── Fixture B: exact "Compact 1BHK Studio Apartment — Level 01" ```cad ── */
const CAD_FIXTURE = `{
  "title": "Compact 1BHK Studio Apartment — Level 01",
  "units": "m",
  "layers": [
    { "id": "layer-structural", "name": "Structural Walls", "color": "#F87171" },
    { "id": "layer-architectural", "name": "Openings", "color": "#38BDF8" },
    { "id": "layer-furniture", "name": "Furniture", "color": "#34D399" },
    { "id": "layer-annotations", "name": "Annotations", "color": "#C084FC" }
  ],
  "entities": [
    { "kind": "line", "layer": "layer-structural", "from": [0, 0], "to": [10, 0] },
    { "kind": "line", "layer": "layer-structural", "from": [10, 0], "to": [10, 6] },
    { "kind": "line", "layer": "layer-structural", "x1": 10, "y1": 6, "x2": 0, "y2": 6 },
    { "kind": "line", "layer": "layer-structural", "x1": 0, "y1": 6, "x2": 0, "y2": 0 },
    { "kind": "rect", "layer": "layer-structural", "x": 0, "y": 0, "width": 10, "height": 6 },
    { "kind": "rect", "layer": "layer-furniture", "x": 0.3, "y": 3.4, "w": 2.0, "h": 1.9 },
    { "kind": "rect", "layer": "layer-furniture", "x": 3.2, "y": 0.3, "w": 2.4, "h": 0.9 },
    { "kind": "rect", "layer": "layer-furniture", "x": 7.6, "y": 0.3, "w": 2.1, "h": 0.6 },
    { "kind": "circle", "layer": "layer-furniture", "x": 6.0, "y": 4.2, "radius": 0.45 },
    { "kind": "polyline", "layer": "layer-architectural", "points": [[6.5, 0], [6.5, 2.2]] },
    { "kind": "polygon", "layer": "layer-architectural", "points": [[7.8, 4.2], [9.8, 4.2], [9.8, 5.8], [7.8, 5.8]] },
    { "kind": "arc", "layer": "layer-architectural", "cx": 6.5, "cy": 2.2, "r": 0.9, "startDeg": 0, "endDeg": 90 },
    { "kind": "text", "layer": "layer-annotations", "x": 6, "y": 4.2, "text": "Living / Sleeping 24 m²" },
    { "kind": "text", "layer": "layer-annotations", "x": 8.8, "y": 5.0, "label": "Bath 3.6 m²" },
    { "kind": "circle", "": "layer-dimensions", "cx": -1.25, "cy": 8, "r": 0.25 },
    { "kind": "circle", "layer": "layer-dimensions", "cx": 5, "cy": 8, "r": 0.25 }
  ],
  "rooms": [
    { "name": "Living / Sleeping", "x": 0, "y": 0, "w": 6.5, "h": 6 },
    { "name": "Kitchenette", "x": 6.5, "y": 0, "w": 3.5, "h": 2.2 },
    { "name": "Bath", "x": 7.8, "y": 4.2, "w": 2, "h": 1.6 }
  ],
  "walls": [
    { "id": "w-envelope", "layer": "layer-structural", "path": [[0, 0], [10, 0], [10, 6], [0, 6]], "closed": true, "height": 3, "thickness": 0.2, "z": 0 }
  ],
  "slabs": [
    { "id": "slab-l01", "layer": "layer-structural", "outline": [[0, 0], [10, 0], [10, 6], [0, 6]], "z": 0, "thickness": 0.2 }
  ],
  "floors": ["Level 01"],
  "defaultView": "2d",
  "export": { "filename": "plan-level-01" }
}`;

/* ── Run both through the REAL normalizers the UI components call ──────── */
let failed = 0;

const scene = normalizeScene3d(SCENE_FIXTURE);
if (scene.ok) {
  console.log("[scene3d] valid: true, errors: 0");
  console.log("  objects:", scene.spec.objects.length,
    "| animations kept:", scene.spec.animations?.length ?? 0,
    "| sliders:", scene.spec.sliders?.length ?? 0);
  if (scene.warnings.length) console.log("  warnings (not errors):", scene.warnings);
} else {
  failed++;
  console.error("[scene3d] valid: false, error:", scene.error);
}

const cad = normalizeCad(CAD_FIXTURE);
if (cad.ok) {
  console.log("[cad] valid: true, errors: 0");
  console.log("  entities:", cad.spec.entities.length, "| walls:", cad.spec.walls.length,
    "| rooms->entities added:", cad.spec.entities.length - 16);
  const e12 = cad.spec.entities[12];
  console.log("  entities[12].content:", JSON.stringify(e12?.content));
  if (!e12 || typeof e12.content !== "string" || e12.content.length === 0) {
    failed++;
    console.error("[cad] FAIL: entities[12].content is not a non-empty string");
  }
  const typo = cad.spec.entities.find(e => e.layer === "layer-dimensions" && Math.abs((e.cx ?? 0) + 1.25) < 1e-9);
  console.log("  empty-key layer typo repaired -> layer:", JSON.stringify(typo?.layer));
  if (!typo) { failed++; console.error("[cad] FAIL: \"\"-key circle not normalized to layer-dimensions"); }
  if (cad.warnings.length) console.log("  warnings (not errors):", cad.warnings);
} else {
  failed++;
  console.error("[cad] valid: false, error:", cad.error);
}

console.log(failed === 0 ? "\nRESULT: both fixtures load with 0 errors." : "\nRESULT: FAILURES=" + failed);
process.exit(failed === 0 ? 0 : 1);
