/**
 * Per-mode output contracts injected by the Decision Engine (one per turn,
 * alongside the single matched core skill). Moved verbatim out of the retired
 * keyword Core Skill Intent Router / VISUAL_ROUTER_SYSTEM_PROMPT — the
 * Decision Engine's active_mode now decides WHICH contract fires, never
 * keyword scoring.
 */
import type { RendererMode } from "./types";

const THREE_CONTRACT = `<output_contract_3d>
Produce a Three.js visual for this chat: one short intro sentence, then ONE fenced block — either \`\`\`threejs (executable code) or \`\`\`scene3d (JSON). Never emit both.

\`\`\`threejs — executable Three.js, PREFERRED for organic or complex subjects (helmets, faces, characters, footwear, extruded logos, anything rigid JSON primitives cannot express):
- Plain Three.js: NO imports, NO module/export syntax. THREE, root and api are already in scope — add meshes to root directly, or define function build(THREE, root, api).
- Use any Three.js API: THREE.Group/Mesh, ExtrudeGeometry+Shape, LatheGeometry, TubeGeometry+CatmullRomCurve3, TorusKnotGeometry, custom BufferGeometry, MeshStandardMaterial/MeshPhysicalMaterial/ShaderMaterial, custom lights.
- Name every meaningful part (helmet_shell, eyes_emissive, sole_tread, logo_extrude...) — named THREE.Group/Mesh objects are auto-indexed into the Outliner, Part Inspector, Explode slider and every exporter (.glb/.gltf/.obj/.stl/.ply/.usdz).
- Optional function onUpdate(delta, elapsed) runs in the render loop for animation.

MODEL FIDELITY — NON-NEGOTIABLE (Blender-grade procedural detail, never a lazy toy):
- Every asset MUST be 12-25 distinct named sub-meshes/groups (articulated parts, panels, trims), never 4 basic primitive blobs. A subject described with N named parts must actually build all N as separate named meshes.
- Build real geometry: ExtrudeGeometry with bevelEnabled bevels for armor plates / shells / treads, LatheGeometry for barrels / pistons / vessels, TubeGeometry+CatmullRomCurve3 for hoses / cables / wiring, CylinderGeometry for pistons / bolts / actuators, TorusGeometry for rings / seals / gimbals.
- Layer on the detail passes: armor plates over a base shell, panel-line trims (thin inset boxes/toruses), emissive vents and optic visors (MeshStandardMaterial emissive + emissiveIntensity 1.5-3 so Bloom picks them up), bolts/rivets (small instanced or looped cylinders/spheres along seams), procedural canvas bump/grid textures (document.createElement("canvas") → CanvasTexture) for surface micro-detail, and THREE.EdgesGeometry accents (LineSegments, cyan #38bdf8) on hard-surface meshes for the CAD/BIM silhouette.
- Animate what was asked (idle breathing, glow pulse, rotation) inside onUpdate(delta, elapsed) using elapsed for phase.

\`\`\`scene3d — one JSON object for primitive-composable subjects (all parameters optional — sensible defaults apply, never fail on missing fields):
- kinds: box/sphere/cylinder/cone/torus/torusKnot/capsule/lathe/extrude/tube/ring/icosahedron/octahedron/dodecahedron/tetrahedron/plane/grid/arrow/group; 12-25 distinct named parts (up to 80 for large assemblies) parented into logical sub-assemblies — never fewer than 12 for any real subject.
- Prefer extrude/lathe/tube/group compositions over bare box/sphere stacks; add trim rings, greebles, vents and emissive accents as their own named parts.
- PBR materials (color/metalness/roughness/emissive/emissiveIntensity/wireframe/opacity) matching the requested look; emissive + bloom-friendly colors for glow/aura/arc-reactor/hologram parts.
- labels/animations/sliders optional; sliders may bind rotation|position|scale|material.emissiveIntensity|material.roughness|material.metalness|material.opacity.
Put every detail in the block, not in prose.
</output_contract_3d>`;

const ARCH_CONTRACT = `<output_contract_architecture>
Produce an architecture / CAD visual for this chat: one short intro sentence, then a fenced block — \`\`\`anatomy JSON for exploded isometric cutaways, or \`\`\`cad / layered SVG for 2D plans, elevations and schematics:
- Group every element into semantic CAD layers with these ids: layer-structural (walls/frames), layer-architectural (doors/windows/openings), layer-furniture, layer-mep (ducts/pipes/wiring), layer-dimensions (gridlines/dimensions), layer-annotations (labels/title block), layer-flow (flow paths).
- Carry real-world scale metadata on the root: data-scale-meters-per-unit (e.g. "0.01"), data-floor-level and data-height per part/room — the Layer Manager, Ruler, 3D Massing Extruder and .dxf exporter depend on these.
- Floor plans: real room dimensions in meters; walls are DOUBLE-LINED with real thickness (0.1-0.3 m exterior, 0.1 m partitions) and height (2.6-3 m) on the walls array — the viewer offsets them into double lines + 45° poché hatch in 2D and extrudes them in 3D. Never draw walls as single fat lines.
- Emit explicit openings: "doors" array [{id, layer, hinge:[x,y], width, angleDeg (wall direction the leaf points along), swingDeg (90 typical)}] and "windows" array [{id, layer, from:[x,y], to:[x,y], sillHeight (0.9), headHeight (2.4), mullions (2-4)}] — the viewer auto-draws door leaf + 90° swing arc, triple-line glazing + mullions, and cuts real openings in the 3D walls.
- Emit "furniture" array [{id, layer, category, x, y, w, h, rotation, label}] with category from: sofa, table, dining_table, coffee_table, counter, sink, bed, wardrobe, toilet, shower, desk, chair, shelving, stairs, plant, server_rack, appliance, generic — the viewer renders authentic CAD block symbols (sofa back/arms, counter w/ double-basin sink + 4-burner cooktop, bed w/ pillows + blanket fold, WC + vanity + shower cross, stair treads + arrow) in 2D and extruded 3D BIM furniture.
- Emit "grid" array {columns:[{label:"A",position:x}], rows:[{label:"1",position:y}]} for structural column grids — the viewer draws dashed grid axes ending in lettered/numbered bubbles outside the footprint.
- Dimension chains on layer-dimensions (the viewer adds 45° slash ticks + haloed "8.00 m" text); label every room with name + area via annotation text entities at room centroids (the viewer renders collision-checked room tag pills).
- Boxed labels (schematics/flowcharts/equipment tags): place each box's text entity at the box CENTER with anchor:"middle", and size the rect to FIT the text (width ≈ 0.6 × font height per character + padding; height ≥ 2 × font height). Never let text overflow its box or sit off-center.
- Connectors and flows must start/end at BOX EDGES, never at box centers (endpoints buried inside a labeled box get trimmed to the edge, but author them edge-to-edge); hotspot markers belong in box CORNERS, not on top of the label.
- The CAD viewer auto-normalizes common drift (text/label→content, missing layer→layer-architectural, rect w/h or width/height, line from/to or x1y1x2y2, circle cx/cy/r or x/y/radius) — emit the documented shape anyway.
- Cutaway/anatomy: exploded layer stack with callouts and connections between layers.
Keep prose to one short sentence; all geometry and metadata inside the fenced block.
</output_contract_architecture>`;

const PDF_CONTRACT = `<output_contract_pdf>
Produce a printable PDF document: one short intro sentence, then ONE \`\`\`html fence containing a complete self-contained HTML document (inline CSS, inline SVG charts; no external CDN unless a chart library truly needs it).
- Semantic structure: <h1> title, <h2>/<h3> sections, .card blocks, .chart-container wrappers, real <table> with <thead>.
- The engine injects mandatory A4 print CSS (@page size A4 margin 14mm; break-inside:avoid on .card/.chart-container/table/tr/blockquote/pre; break-after:avoid on h1-h4; thead table-header-group) — never fight page breaks with fixed heights or absolute positioning.
- Charts: inline SVG sized in %/viewBox inside .chart-container so they never clip or orphan.
- The viewer shows the document live; Download renders A4 PDF via headless Chromium. On an edit request re-emit the whole corrected \`\`\`html fence.
</output_contract_pdf>`;

const DOCX_CONTRACT = `<output_contract_docx>
Produce a Word (.docx) deliverable: one short intro sentence, then ONE \`\`\`docx fence with ONE JSON object:
{"filename","title","author","sections":[{"type":"heading","level":1,"text"},{"type":"paragraph","text"},{"type":"bullets","items":[...]},{"type":"table","headers":[...],"rows":[[...]]},{"type":"chart","title","chart":{"type":"bar|line|pie|donut|area","categories":[...],"series":[{"name","data":[...]}]}}]}
- Real HeadingLevel hierarchy; table header shading (ShadingType.CLEAR); charts become high-res 2x images with keepLines/keepNext so captions never orphan from them.
- The engine enforces 1440 DXA/inch page geometry and explicit cell padding. On an edit request re-emit the whole corrected \`\`\`docx fence.
</output_contract_docx>`;

const XLSX_CONTRACT = `<output_contract_xlsx>
Produce an Excel (.xlsx) workbook: one short intro sentence, then ONE \`\`\`xlsx fence with ONE JSON object:
{"filename","sheets":[{"name","freezeHeader":true,"totalRow":true,"columns":[{"key","label","width","format":"currency|percent|date|number|integer|text","validation":{"type":"list","values":[...]}},{"key","label","format":"number","validation":{"type":"decimal","min":0,"max":1}}],"rows":[{"<key>":value}]}]}
- ZERO null/blank cells: numeric columns default 0, text defaults "N/A".
- 100% live formulas: every computed cell MUST be a formula string starting with "=" (SUM/AVERAGE/IF/IFERROR/ROUND/INDEX/MATCH/SUMIF...); never hardcode a result. Post-2007 functions need the _xlfn. prefix (e.g. _xlfn.IFS).
- The engine adds freeze panes A2, auto-fit column widths, number formats ($#,##0.00 / 0.0% / yyyy-mm-dd) and runs a headless recalculation: any #REF!/#DIV/0!/#VALUE!/#NAME?/#N/A fails the build — keep ranges and refs correct the first time.
</output_contract_xlsx>`;

const PPTX_CONTRACT = `<output_contract_pptx>
Produce a PowerPoint (.pptx) deck at the INSANE animation tier BY DEFAULT — only use "normal" or "simple" if the user explicitly says simple / low animations / more text. One short intro sentence, then ONE \`\`\`pptx fence with ONE JSON object:
{"filename","title","tier":"insane","theme":{"bg":"#0A0A0A","accent":"#38E8FF","positive":"#22C55E"},"slides":[{"layout":"title|hero|stats|split|spotlight|chart|table|bullets","title","subtitle","bullets":[...],"stats":[{"label","value","suffix"}],"chart":{"type":"bar|line|area|donut","categories":[...],"series":[{"name","data":[...]}]},"table":{"headers":[...],"rows":[[...]]},"morphGroup":"hero"}]}
- 8-14 slides, one big idea per slide, huge type, dark executive theme, real numbers from the conversation.
- Tag shapes that should morph across consecutive slides with the SAME "morphGroup" value; the engine injects <p159:morph option="byObject"/> transitions, !!-paired shape names and the signature patterns: split-mask entry (rot 270→0), stat crop-fill (srcRect 100%→target), moving spotlight cutout + camera pan 100%→108%.
</output_contract_pptx>`;

const HTML_CONTRACT = `<output_contract_html>
Produce ONE interactive HTML artifact: one short intro sentence, then ONE \`\`\`html fence — a complete self-contained document following the html-viewer skill (page #000000, cards #0D0D0D-#141414 with 1px #262626 borders, text #FFFFFF/#A1A1AA, positive #22C55E, highlight #38E8FF; body margin 0; NO fixed height on html/body; animate ONLY transform/opacity at 60fps — Framer Motion ESM CDN or hardware-accelerated CSS springs; zero layout shift).
- The artifact renders in a chrome-less auto-sizing dark viewer with full pass-through interactivity; Download offers HTML + PDF.
- On an edit request re-emit the whole corrected \`\`\`html fence so the preview regenerates in place.
</output_contract_html>`;

const CHART_CONTRACT = `<output_contract_chart>
Produce a data chart: one short intro sentence, then ONE \`\`\`chart fence with ONE JSON object:
{"type":"line|bar|grouped-bar|stacked-bar|area|pie|donut|scatter|histogram","title":"...","subtitle":"...","insight":"one-line takeaway","unit":"...","categories":["..."],"series":[{"name":"...","data":[1,2]}],"points":[{"x":1,"y":2}],"notes":["per-category annotation"],"sliders":[{"id":"s1","label":"Growth","min":0.5,"max":2,"step":0.05,"defaultValue":1,"targetSeries":"name","operation":"multiply|add"}]}
- Add "sliders" when the user benefits from What-If tuning, "insight" when a real takeaway exists, "notes" to annotate categories.
- Never invent data; every number finite; valid JSON (no comments, no trailing commas). The chart viewer renders it live with Download as PNG.
</output_contract_chart>`;

/** active_mode -> the ONE output contract injected with the matched skill. */
export const MODE_CONTRACTS: Record<RendererMode, string | null> = {
  excel: XLSX_CONTRACT,
  docs: DOCX_CONTRACT,
  pdf: PDF_CONTRACT,
  ppt: PPTX_CONTRACT,
  "3d_asset": THREE_CONTRACT,
  cad_blueprint: ARCH_CONTRACT,
  chart: CHART_CONTRACT,
  html_render: HTML_CONTRACT,
  standard_chat: null,
};
