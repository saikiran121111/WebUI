/**
 * Anatomy routing intent (pure, dependency-free): decides when a request wants
 * an isometric technical illustration (the Anatomy subsystem) versus the
 * existing 3D mesh pipelines versus plain diagram/chart territory.
 *
 * Routing modes:
 *  A) Anatomy  — crafted isometric machine/instrument explainers (this detector).
 *  B) scene3d  — spatial 3D scenes (handled by detectThreeIntent).
 *  C) asset3d  — genuine AI-generated meshes (meshRequest flag).
 *  D) neither  — architecture/C4/schema diagrams, charts, wireframes.
 */

export type AnatomySubIntent = "craft" | "mechanism";

export interface AnatomyIntentResult {
  wantsAnatomy: boolean;
  /** True when the user explicitly wants a real 3D model/mesh file — routes to the 3D pack. */
  wantsMesh: boolean;
  subIntents: AnatomySubIntent[];
}

// Explicit mesh/download requests always win over illustration routing.
const MESH_REQUEST = [
  /\bglb\b/i, /\bgltf\b/i, /\bfbx\b/i, /\busdz\b/i, /\b3mf\b/i, /\bstl\b/i,
  /\bmesh(es)?\b/i,
  /\b3\s*-?\s*d\s*(model|print|file|asset|mesh)\w*/i,
  /\b(text|image)\s*-?\s*to\s*-?\s*3d\b/i,
  /\bdownloadable (3d )?model\b/i,
  /\b(genuine|real|actual|true)\s+3d\b/i,
];

// Mode D: subjects the Anatomy system must never draw.
const EXCLUDED_DOMAIN = [
  /\b(architect|architectural|architecture|building|floor\s*plan|interior\s*design|city\s*(plan|model))\b/i,
  /\bc4\b[^.\n]*\b(diagram|model)\b/i,
  /\b(schema|er|data\s*model)\s*(diagram|chart)\b/i, /\b\d(?:\.\d)?\s*tier\s*(architecture|diagram)\b/i,
  /\b(wireframe|mockup|ui\s*(design|sketch|layout))\b/i,
  /\b(flow\s*chart|flowchart|process\s*flow|org\s*chart|uml|sequence\s*diagram|use\s*case\s*diagram)\b/i,
  /\b(bar|line|pie|area|scatter|stacked)\s*chart\b/i, /\bchart of\b/i, /\bdashboard\b/i,
  /\b(circuit|schematic|wiring|pcb)\s*(diagram|schematic)\b/i,
];

// The user names the Anatomy system itself ("use the Anatomy skill"). This
// overrides the mode-D subject exclusion: knowingly asking for an isometric
// illustration of a normally-excluded subject (e.g. a building cutaway) is a
// legitimate request. A NAMED mesh file format still wins over any explicit
// invocation — Anatomy can never deliver a GLB/STL, so those keep routing
// to the 3D pack. Bare "mesh" wording does NOT beat an explicit invocation:
// prompts often mention "not a genuine 3D mesh" as a disclaimer.
const EXPLICIT_INVOCATION = /\banatomy\b[^.\n]{0,30}\b(skill|pack|system|runtime|mode|implementation|illustration|drawing|figure)\b|\b(use|using|via|with|through)\s+(the\s+)?anatomy\b/i;
const NAMED_MESH_FORMAT = /\b(glb|gltf|fbx|usdz|3mf|stl)\b/i;

// Unambiguous Anatomy signals.
const ANATOMY_STRONG = [
  /\bisometric\b/i,
  /\biso[- ](view|projection|drawing|figure|illustration|diagram)\b/i,
  /\btechnical\s*(illustration|drawing|rendering)\b/i,
  /\bexploded\s*view\b/i,
  /\bcutaway\b/i,
  /\bexplainer\b/i,
  /\binteractive\s*(machine|mechanism|device|diagram|illustration|figure)\b/i,
  /\bmoving[- ]parts\s*(diagram|illustration|figure|drawing)\b/i,
];

// Physical subjects that justify a mechanical explainer.
const MECHANISM_SUBJECT = [
  /\b(engine|motor|pump|turbine|compressor|carburetor|transmission|generator)\b/i,
  /\b(gear|gearbox|piston|crank|crankshaft|cam|camshaft|flywheel|governor)\b/i,
  /\b(valve|linkage|lever|pulley|clutch|brake|bearing|spring|actuator|solenoid)\b/i,
  /\b(dial indicator|caliper|micrometer|gauge|manometer|thermostat|barometer)\b/i,
  /\b(hydraulic|pneumatic|fluid)\b[^.\n]*\b(system|circuit|ram|cylinder|flow)\b/i,
  /\b(mechanism|machine|assembly|apparatus|device|contraption)\b/i,
];

const EXPLAIN_VERB = [
  /\b(draw|illustrate|diagram|visuali[sz]e|sketch|render)\b/i,
  /\b(explain|show|demonstrate|walk me through|break down)\b/i,
  /\b(build|make|create|design)\b/i,
];

const HOW_WORKS = /\bhow\s+(does|do|did)\b[^.\n]{0,80}?\b(work|works|operate[sd]?|functions?)\b/i;

export function detectAnatomyIntent(text: string): AnatomyIntentResult {
  if (!text) return { wantsAnatomy: false, wantsMesh: false, subIntents: [] };

  const explicit = EXPLICIT_INVOCATION.test(text);
  const wantsMesh = MESH_REQUEST.some((re) => re.test(text)) && (!explicit || NAMED_MESH_FORMAT.test(text));
  const excluded = EXCLUDED_DOMAIN.some((re) => re.test(text));
  if (wantsMesh || (excluded && !explicit)) return { wantsAnatomy: false, wantsMesh, subIntents: [] };

  const strong = ANATOMY_STRONG.some((re) => re.test(text));
  const subject = MECHANISM_SUBJECT.some((re) => re.test(text));
  const verb = EXPLAIN_VERB.some((re) => re.test(text));
  const howWorks = HOW_WORKS.test(text);

  const wantsAnatomy = explicit || strong || (subject && (verb || howWorks));
  if (!wantsAnatomy) return { wantsAnatomy: false, wantsMesh: false, subIntents: [] };

  const subIntents: AnatomySubIntent[] = ["craft"];
  if (subject || /\b(mechanism|engine|assembly|hydraulic|pneumatic)\b/i.test(text)) subIntents.push("mechanism");
  return { wantsAnatomy, wantsMesh, subIntents };
}
