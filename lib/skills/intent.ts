/**
 * Lightweight, dependency-free 3D intent detection (pure — no fs, no network,
 * safe on client and server). Decides whether the 3D subsystem activates and
 * which skill sub-aspects the request touches.
 *
 * Design rule: the bare word "model" (AI model, language model, model
 * endpoint, model config) is NEVER a 3D signal — activation requires an
 * explicit spatial/3D token or a spatial subject phrase.
 */

export type ThreeSubIntent =
  | "scene" | "geometry" | "materials" | "interaction" | "assetGen" | "export" | "performance";

export interface ThreeIntentResult {
  wants3D: boolean;
  subIntents: ThreeSubIntent[];
}

// Explicit 3D tokens. \b guards keep "2D"/"d3" from matching "3d".
const STRONG_3D = [
  /\b3\s*-?\s*d\b/i,
  /\bthree\.?js\b/i,
  /\bscene3d\b/i,
  /\bmesh(es)?\b/i,
  /\bglb\b/i,
  /\bgltf\b/i,
  /\bfbx\b/i,
  /\busdz\b/i,
  /\b3mf\b/i,
  /\btext\s*-?\s*to\s*-?\s*3d\b/i,
  /\bimage\s*-?\s*to\s*-?\s*3d\b/i,
  /\b3d\s*(print|scan|scan|model|scene|object|asset|viewer|export|render)\w*/i,
];

// Spatial subject phrases that mean 3D even without the token "3d".
const SPATIAL_SUBJECT = [
  /\b(solar|planetary)\s+system\b/i,
  /\borbit\s+controls?\b/i,
  /\bpitch\b[^.\n]*\broll\b[^.\n]*\byaw\b/i,
  /\battitude\s+(demo|controls?|indicators?)\b/i,
];

const SUB_INTENT_TRIGGERS: Array<[ThreeSubIntent, RegExp[]]> = [
  ["assetGen", [
    /\btext\s*-?\s*to\s*-?\s*3d\b/i,
    /\bimage\s*-?\s*to\s*-?\s*3d\b/i,
    /\bai[- ]generated\b/i,
    /\bgenerate\b[^.\n]*\b(mesh|3d model|3d asset|model file)s?\b/i,
    /\bdownloadable (3d )?model\b/i,
    /\bmeshy\b/i,
    /\b(sneaker|shoe|sneakers|character|creature|person|human|face|statue|bust|furniture|chair|sofa|sculpture|organic)\b/i,
  ]],
  ["export", [
    /\bexport\b/i, /\bdownload\b/i, /\bglb\b/i, /\bgltf\b/i, /\bfbx\b/i,
    /\bobj\b/i, /\bstl\b/i, /\busdz\b/i, /\b3mf\b/i,
    /\b(blender|maya|unity|unreal)\b/i, /\bimport\b[^.\n]*\b3d\b/i,
  ]],
  ["interaction", [
    /\binteractiv\w*/i, /\borbit\b/i, /\bcontrols?\b/i, /\bclick\b/i,
    /\binspect\b/i, /\bhover\b/i, /\banimat\w*/i, /\bmoving parts\b/i,
    /\bsliders?\b/i, /\bpitch\b/i, /\broll\b/i, /\byaw\b/i, /\battitude\b/i,
    /\bplay\b/i, /\bpause\b/i,
  ]],
  ["materials", [
    /\bmaterials?\b/i, /\btextures?\b/i, /\bmetal\w*/i, /\bgloss\w*/i,
    /\bshiny\b/i, /\broughness\b/i, /\bmatte\b/i, /\bglass\b/i, /\bchrome\b/i,
    /\b(paint|coating|finish)\b/i, /\brealistic\b/i, /\bphotoreal\w*/i,
  ]],
  ["geometry", [
    /\bdetailed\b/i, /\bproportion\w*/i, /\brealistic\b/i, /\bgeometry\b/i,
    /\bcurved?\b/i, /\bsmooth\b/i, /\blathe\b/i, /\bextrud\w*/i, /\bbevel\w*/i,
    /\btopolog\w*/i, /\blow[- ]poly\b/i,
  ]],
  ["scene", [
    /\b(create|build|make|design|render|show|visualize|model)\b/i,
    /\bscene\b/i, /\bobject\b/i, /\bmodel\b/i, /\bviewer\b/i, /\bdetail\w*/i,
  ]],
  ["performance", [
    /\b(fast|lag|slow|heavy|mobile|optimi\w*|fps|performance)\b/i,
    /\bhundreds?\b/i, /\bmany (parts|objects|meshes)\b/i,
  ]],
];

export function detectThreeIntent(text: string): ThreeIntentResult {
  if (!text) return { wants3D: false, subIntents: [] };

  const strong = STRONG_3D.some(re => re.test(text));
  const spatial = SPATIAL_SUBJECT.some(re => re.test(text));
  if (!strong && !spatial) return { wants3D: false, subIntents: [] };

  const subIntents: ThreeSubIntent[] = [];
  for (const [intent, patterns] of SUB_INTENT_TRIGGERS) {
    if (patterns.some(re => re.test(text))) subIntents.push(intent);
  }
  return { wants3D: true, subIntents };
}

/**
 * Extracts plain text from an OpenAI-style message content (string or the
 * parts array used for attachments) so intent detection sees user words only.
 */
export function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
  }
  return "";
}
