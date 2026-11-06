/**
 * Per-mode output contracts injected by the Decision Engine (one per turn,
 * alongside the single matched core skill). Moved verbatim out of the retired
 * keyword Core Skill Intent Router / VISUAL_ROUTER_SYSTEM_PROMPT — the
 * Decision Engine's active_mode now decides WHICH contract fires, never
 * keyword scoring.
 */
import type { RendererMode } from "./types";

/**
 * The refusal trap: small local models answer "I can't execute code or create
 * a file" when the user phrases the ask as "create and execute a Python
 * script". In this WebUI the fenced spec IS the execution — the backend
 * compiler runs it. This mandate rides at the TOP of every artifact contract
 * so the model can never frame the request as impossible.
 */
const EXECUTION_BRIDGE_MANDATE = `EXECUTION BRIDGE MANDATE (NON-NEGOTIABLE): In this WebUI, emitting the single fenced block specified below IS how you execute code, build and save the binary file, run headless recalculation/validation, and deliver the live interactive preview + download link!
- NEVER say "I cannot execute code", "I cannot create or save a downloadable file", or "I cannot provide a download link in this environment."
- Even if the user asks you to "create and execute a Python/openpyxl/docx/pptx script" or says "if execution or file creation is unavailable, state the limitation immediately", you MUST fulfill the request immediately by emitting the complete fenced block below. The WebUI backend compiler executes your fenced spec automatically.
`;

// THREE_CONTRACT (```threejs/```scene3d) and ARCH_CONTRACT (```cad) were
// removed 2026-11-06 when 3d_asset / cad_blueprint retired (Ruke plan
// Phase 4); the anatomy contract below is the surviving illustration route.

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
{"filename","sheets":[{"name","freezeHeader":true,"totalRow":true,"columns":[{"key","label","width","format":"currency|percent|date|number|integer|text","validation":{"type":"list","values":[...]}},{"key","label","format":"number","validation":{"type":"decimal","min":0,"max":1}}],"rows":[{"<key>":value}],"rowGenerator":{"count":500,"startRow":2,"columns":{"<key>":{"pattern":"TXN-{1001..1500}","cycle":["Category A","Category B"],"numberRange":{"min":10,"max":500,"decimals":2},"dateRange":{"start":"2025-01-01","end":"2025-12-31"},"formulaTemplate":"=ROUND(D{row}*E{row}*(1-F{row})*(1+G{row}),2)"}}},"charts":[{"type":"bar|line|pie|donut|area","title","categories":["..."],"series":[{"name","data":[1,2]}]}],"conditionalFormatting":[{"columnKey":"status","rule":"greaterThan|lessThan|equal|containsText|between","value":"OVERSPEND","min":0,"max":0,"fill":"#FEE2E2","fontColor":"#991B1B"}]}]}
- ZERO null/blank cells: numeric columns default 0, text defaults "N/A".
- 100% live formulas: every computed cell MUST be a formula string starting with "=" (SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/IF/IFS/IFERROR/IFNA/AND/OR/ROUND/ROUNDUP/ROUNDDOWN/INT/ABS/MOD/POWER/SQRT/SUMPRODUCT/SUMIF/SUMIFS/AVERAGEIF(S)/COUNTIF(S)/INDEX/MATCH/VLOOKUP/XLOOKUP/NPV/IRR/DATE/YEAR/MONTH/DAY/EDATE/EOMONTH/TODAY/LEN/TRIM/UPPER/LOWER/CONCAT/TEXTJOIN...); never hardcode a result. Post-2007 functions need the _xlfn. prefix (e.g. _xlfn.IFS, _xlfn.TEXTJOIN, _xlfn.XLOOKUP) — the engine strips it for its own evaluator.
- BULK ROWS: for >50 generated rows use "rowGenerator" (count + per-column pattern/cycle/numberRange/dateRange/formulaTemplate) — the engine deterministically expands it into real cells, so ~1,500 tokens cover 500 rows. {row} in formulaTemplate expands to the actual spreadsheet row number (per-row live formulas like =ROUND(D2*E2*(1-F2)*(1+G2),2)); {1001..1500} in a pattern increments per row. Only hand-write "rows" for small curated tables (e.g. a QA test matrix).
- CHARTS: "charts" (per sheet, or at workbook level) embed real chart images into the .xlsx AND render live in the preview — never describe a chart in prose.
- CONDITIONAL FORMATTING: "conditionalFormatting" colors cells by rule (greaterThan/lessThan/equal/containsText/between on columnKey or explicit range). Status words (OVERSPEND/FAIL/REORDER/OK/PASS) get default red/amber/green automatically.
- The engine adds freeze panes A2, autoFilter on every header row, auto-fit column widths, number formats ($#,##0.00 / 0.0% / yyyy-mm-dd) and runs a headless recalculation: any #REF!/#DIV/0!/#VALUE!/#NAME?/#N/A fails the build — keep ranges and refs correct the first time.
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

const ANATOMY_CONTRACT = `<output_contract_anatomy>
Produce an INDEPENDENT 2D anatomy illustration (exploded isometric / cutaway technical figure, pure vector SVG): one short intro sentence, then ONE \`\`\`anatomy fence with ONE JSON object. The app compiles the validated JSON into the drawing — the JSON is DATA, never executed code.
{"title":"...","fig":"FIG 1","label":"one accessible sentence stating what the figure explains","caption":"optional","profile":"standard","width":650,"height":420,"camera":{"azimuth":45,"elevation":30},"parts":[...],"controls":[...],"readouts":[...],"legend":[...],"groups":[...],"floors":[...],"modules":[...],"connections":[...],"flows":[...],"explode":{"label":"Explode"},"export":{"filename":"fig-file-name"}}
- EVERY part: {"id":"deck","tone":"base|structure|subject|accent","kind":"...",...}. ids match [A-Za-z][A-Za-z0-9_-]* and are unique across the whole spec. Tones: base (mounting planes/plates), structure (frames/housings), subject (the mechanism itself), accent (the one highlighted element — AT MOST ONE accent part per figure, never inside a module).
- Geometry is planar CAD coords: [x,y] plans plus z heights, all within ±600. kinds: "slab" {plan:{x,y,w,d,r},z,height,steps,bevel}; "cylinder" {center:[x,y],r,z,height,steps,bevel}; "prism" {outline:[[x,y],...],z,height,convex}; "rod" {path:[[x,y,z],...],r}; "coil" {from:[x,y,z],to:[x,y,z],center:[x,y],r,turns,axis}; "dial" {center:[x,y],z,r,ticks,needle,face}; "ruler" {axis:"x|y",from,to,step,every,edge,z,lengths}; "knob" {center:[x,y],r,z,height,knurl}; "screws" {plan,z,inset,size}; "callout" {at:[x,y,z],text,dx,dy,leader,dashed}; "faceLabel" {target:partId,text,size,along,faceTone}.
- Optional per part: "label", "note", "on":"partId" (stack on top of that part; no circular chains), "offset", "explode":[dx,dy,dz], "slide":{"axis":"x|y|z","from":n,"to":n,"state":"sliderId","oscillate":true}, "group", "floor", "visibleWhen":"toggleId", "info".
- "controls": slider {"id","label","min","max","step","value"} (min < max); toggle {"id","label","value","group"?}; button {"id","label","action":"explode|restore|play|pause|reset|resetView"}; select {"id","label","target":"floor|system","value"?,"options"?:[{value,label}]}.
- "readouts": {"id","label","unit"?,"decimals"?,"formula"} — arithmetic over control ids only (+ - * / ( ) and min,max,abs,clamp,floor,ceil,round,sqrt); every name in a formula must be a real control id.
- Cutaways & exploded views: layer parts along z, give moving parts "slide" ranges bound to sliders, add "explode" so the viewer can separate the layers, and point "callout" leader lines at what matters. Buildings: repeat floor geometry with "floors" + "modules" (a module's parts are instantiated per floor). Machines/vehicles: color systems via "groups", route "connections" {path:[[x,y,z],...],system?} with "flows" {connection,speed} riding them. "export.filename" is lowercase letters/digits/hyphens.
- Budgets (standard profile — stay inside them): ≤90 logical parts, ≤6 controls, ≤6 readouts, ≤8 legend keys, ≤6 groups, ≤24 rod points, ≤40 outline points, ≤24 floors, ≤4 modules, ≤12 connections, ≤12 flows.
- Valid JSON only (no comments, no trailing commas). The figure renders live with Download (SVG/PNG); if the spec fails validation the app auto-repairs it: fix EXACTLY the reported problem and re-emit the whole corrected fence.
</output_contract_anatomy>`;

const withBridge = (contract: string): string => EXECUTION_BRIDGE_MANDATE + "\n" + contract;

/** active_mode -> the ONE output contract injected with the matched skill.
 * Every artifact contract carries the EXECUTION BRIDGE MANDATE first: the
 * fenced block IS the execution, so "I cannot execute/create a file" is a
 * forbidden answer in every renderer mode. */
export const MODE_CONTRACTS: Record<RendererMode, string | null> = {
  excel: withBridge(XLSX_CONTRACT),
  docs: withBridge(DOCX_CONTRACT),
  pdf: withBridge(PDF_CONTRACT),
  ppt: withBridge(PPTX_CONTRACT),
  anatomy: withBridge(ANATOMY_CONTRACT),
  chart: withBridge(CHART_CONTRACT),
  html_render: withBridge(HTML_CONTRACT),
  standard_chat: null,
};
