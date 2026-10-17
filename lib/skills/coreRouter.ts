import { promises as fs } from "node:fs";
import path from "node:path";
import { isSafeSkillName, projectRoot } from "./registry";
import type { SkillScenario } from "./types";

/**
 * Core Skill Intent Router — the ONLY thing that reads ./.cskills/ and
 * ./.cskills-scenarios/. Core hidden skills never appear in GET /api/skills,
 * the Skills Modal, slash autocomplete or the load_skill tool enum; they fire
 * lazily here when the last user message matches their scenario keywords.
 *
 * Smart sub-skill selection (never all 27 at once):
 *  - 3D: base = threejs-fundamentals/geometry/materials/lighting (fallback:
 *    threejs-skills), + animation / shaders+postprocessing / interaction /
 *    textures / loaders / blender-glb-pipeline only when their own scenario
 *    keywords match (blender-glb-pipeline also fires when an image is
 *    attached — image-to-3D). R3F bundle replaces the base when the user
 *    asks for React Three Fiber.
 *  - Architecture: archify / anatomy / architecture-diagram / diagram-design
 *    each fire only on their own scenario keywords.
 *
 * Matched SKILL.md bundles are injected as one system block plus the matching
 * output contract, under hard byte budgets so a heavy 3D turn still fits the
 * local model's context window.
 */

const CORE_SKILLS_DIR = ".cskills";
const CORE_SCENARIOS_DIR = ".cskills-scenarios";

/** Per-skill and total injection caps (~14k tokens worst case). */
const MAX_SKILL_BUNDLE_BYTES = 9_000;
const MAX_TOTAL_BUNDLE_BYTES = 56_000;

const THREE_BASE = ["threejs-fundamentals", "threejs-geometry", "threejs-materials", "threejs-lighting"];
const THREE_CONDITIONAL = [
  "threejs-animation", "threejs-shaders", "threejs-postprocessing", "threejs-interaction",
  "threejs-textures", "threejs-loaders", "threejs-blender-glb-pipeline",
];
const THREE_UMBRELLA = "threejs-skills";
const R3F_BASE = ["r3f-fundamentals", "r3f-materials", "r3f-lighting"];
const R3F_CONDITIONAL = [
  "r3f-geometry", "r3f-animation", "r3f-shaders", "r3f-postprocessing",
  "r3f-interaction", "r3f-physics", "r3f-textures", "r3f-loaders",
];
/** When an R3F turn also matches a threejs conditional cue, pull its R3F twin. */
const R3F_TWIN: Record<string, string> = {
  "threejs-animation": "r3f-animation", "threejs-shaders": "r3f-shaders",
  "threejs-postprocessing": "r3f-postprocessing", "threejs-interaction": "r3f-interaction",
  "threejs-textures": "r3f-textures", "threejs-loaders": "r3f-loaders",
  "threejs-geometry": "r3f-geometry",
};
const ARCH_SKILLS = ["archify", "anatomy", "architecture-diagram", "diagram-design"];

const THREE_CONTRACT = `<output_contract_3d>
Produce a Three.js visual for this chat: one short intro sentence, then ONE fenced block — either \`\`\`threejs (executable code) or \`\`\`scene3d (JSON). Never emit both.

\`\`\`threejs — executable Three.js, PREFERRED for organic or complex subjects (helmets, faces, characters, footwear, extruded logos, anything rigid JSON primitives cannot express):
- Plain Three.js: NO imports, NO module/export syntax. THREE, root and api are already in scope — add meshes to root directly, or define function build(THREE, root, api).
- Use any Three.js API: THREE.Group/Mesh, ExtrudeGeometry+Shape, LatheGeometry, TubeGeometry+CatmullRomCurve3, TorusKnotGeometry, custom BufferGeometry, MeshStandardMaterial/MeshPhysicalMaterial/ShaderMaterial, custom lights.
- Name every meaningful part (helmet_shell, eyes_emissive, sole_tread, logo_extrude...) — named THREE.Group/Mesh objects are auto-indexed into the Outliner, Part Inspector, Explode slider and every exporter (.glb/.gltf/.obj/.stl/.ply/.usdz).
- Optional function onUpdate(delta, elapsed) runs in the render loop for animation.

\`\`\`scene3d — one JSON object for primitive-composable subjects (all parameters optional — sensible defaults apply, never fail on missing fields):
- kinds: box/sphere/cylinder/cone/torus/torusKnot/capsule/lathe/extrude/tube/ring/icosahedron/octahedron/dodecahedron/tetrahedron/plane/grid/arrow/group; 15-80 named parts parented into logical sub-assemblies.
- PBR materials (color/metalness/roughness/emissive/emissiveIntensity/wireframe/opacity) matching the requested look; emissive + bloom-friendly colors for glow/aura/arc-reactor/hologram parts.
- labels/animations/sliders optional; sliders may bind rotation|position|scale|material.emissiveIntensity|material.roughness|material.metalness|material.opacity.
Put every detail in the block, not in prose.
</output_contract_3d>`;

const ARCH_CONTRACT = `<output_contract_architecture>
Produce an architecture / CAD visual for this chat: one short intro sentence, then a fenced block — \`\`\`anatomy JSON for exploded isometric cutaways, or \`\`\`cad / layered SVG for 2D plans, elevations and schematics:
- Group every element into semantic CAD layers with these ids: layer-structural (walls/frames), layer-architectural (doors/windows/openings), layer-furniture, layer-mep (ducts/pipes/wiring), layer-dimensions (gridlines/dimensions), layer-annotations (labels/title block), layer-flow (flow paths).
- Carry real-world scale metadata on the root: data-scale-meters-per-unit (e.g. "0.01"), data-floor-level and data-height per part/room — the Layer Manager, Ruler, 3D Massing Extruder and .dxf exporter depend on these.
- Floor plans: real room dimensions in meters, wall thicknesses, door swings; label every room with name + area.
- The CAD viewer auto-normalizes common drift (text/label→content, missing layer→layer-architectural, rect w/h or width/height, line from/to or x1y1x2y2, circle cx/cy/r or x/y/radius) — emit the documented shape anyway.
- Cutaway/anatomy: exploded layer stack with callouts and connections between layers.
Keep prose to one short sentence; all geometry and metadata inside the fenced block.
</output_contract_architecture>`;

export type CoreCategory = "3d" | "architecture" | null;

export interface CoreRoutingResult {
  usedSkills: string[];
  category: CoreCategory;
}

/**
 * Word-boundary keyword test, tolerant of multi-word keywords, regex marks and
 * common inflections ("orbiting" matches "orbit", "plans" matches "floor plan")
 * while still rejecting mid-word false hits ("cad" vs "cadillac").
 */
function keywordMatches(lowerText: string, keyword: string): boolean {
  const escaped = keyword.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  if (!escaped) return false;
  return new RegExp("(^|[^a-z0-9])" + escaped + "(s|es|ed|ing|er|ers|ly)?([^a-z0-9]|$)").test(lowerText);
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join(" ");
}

function contentHasImage(content: unknown): boolean {
  if (Array.isArray(content)) {
    return content.some((part: any) => part?.type === "image_url" || part?.type === "image" || part?.type === "input_image");
  }
  return false;
}

interface LastUserTurn {
  text: string;
  hasImage: boolean;
}

function lastUserTurn(payload: any): LastUserTurn {
  const messages: any[] = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    return {
      text: textOfContent(msg.content) + " " + textOfContent(msg.contentParts),
      hasImage: contentHasImage(msg.content) || (Array.isArray(msg.images) && msg.images.length > 0),
    };
  }
  return { text: "", hasImage: false };
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** Routing configs from ./.cskills-scenarios/ that are enabled + autoUse. */
async function readCoreScenarios(root: string): Promise<SkillScenario[]> {
  const dir = path.join(root, CORE_SCENARIOS_DIR);
  const scenarios: SkillScenario[] = [];
  for (const entry of await readdirSafe(dir)) {
    if (!entry.endsWith(".json")) continue;
    const skillName = entry.slice(0, -".json".length);
    if (!isSafeSkillName(skillName)) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8"));
      if (parsed?.enabled === true && parsed?.autoUse === true && typeof parsed.whenToUse === "string" && parsed.whenToUse.trim()) {
        scenarios.push({
          skillName,
          sourceRepo: typeof parsed.sourceRepo === "string" ? parsed.sourceRepo : "",
          enabled: true,
          autoUse: true,
          whenToUse: parsed.whenToUse,
          triggerKeywords: Array.isArray(parsed.triggerKeywords) ? parsed.triggerKeywords.map(String) : [],
          blockedReason: null,
        });
      }
    } catch {
      // Malformed scenario file: skip this skill, never crash the chat route.
    }
  }
  return scenarios;
}

async function installedCoreNames(root: string): Promise<Set<string>> {
  const dir = path.join(root, CORE_SKILLS_DIR);
  const names = new Set<string>();
  for (const entry of await readdirSafe(dir)) {
    if (!isSafeSkillName(entry)) continue;
    try {
      await fs.access(path.join(dir, entry, "SKILL.md"));
      names.add(entry);
    } catch {
      // Folder without a real SKILL.md is not a skill.
    }
  }
  return names;
}

/** SKILL.md + linked .md files, core-tier variant, capped per skill. */
async function loadCoreBundle(root: string, skillName: string): Promise<string | null> {
  const dir = path.join(root, CORE_SKILLS_DIR, skillName);
  let main: string;
  try {
    main = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  let bundle = main;
  for (const match of main.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
    if (bundle.length >= MAX_SKILL_BUNDLE_BYTES) break;
    const rel = match[1];
    if (rel.startsWith("http") || rel.startsWith("/")) continue;
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) continue;
    try {
      bundle += "\n\n" + (await fs.readFile(abs, "utf8"));
    } catch {
      // Missing linked file: the SKILL.md body alone still routes the skill.
    }
  }
  return bundle.slice(0, MAX_SKILL_BUNDLE_BYTES);
}

export interface CoreSelection {
  skillNames: string[];
  categories: Exclude<CoreCategory, null>[];
}

/**
 * Pure selection core (exported for tests): decides WHICH core skills fire.
 * All trigger vocabulary lives in the scenario JSON — this only orders
 * priorities, gates categories and applies the image-to-3D rule.
 */
export function selectCoreSkills(
  userText: string,
  hasImage: boolean,
  scenarios: SkillScenario[],
  installed: Set<string>,
): CoreSelection {
  const lower = userText.toLowerCase();
  const byName = new Map(scenarios.map((s) => [s.skillName, s]));
  const matchCount = (name: string): number => {
    const scenario = byName.get(name);
    if (!scenario || !installed.has(name)) return 0;
    return scenario.triggerKeywords.filter((k) => keywordMatches(lower, k)).length;
  };

  const threeScore = [...installed].filter((n) => n.startsWith("threejs-") && n !== THREE_UMBRELLA)
    .reduce((sum, n) => sum + matchCount(n), 0);
  const r3fScore = [...installed].filter((n) => n.startsWith("r3f-")).reduce((sum, n) => sum + matchCount(n), 0);
  const archScore = ARCH_SKILLS.reduce((sum, n) => sum + matchCount(n), 0);

  const categories: Exclude<CoreCategory, null>[] = [];
  const skillNames: string[] = [];
  const push = (name: string) => {
    if (installed.has(name) && !skillNames.includes(name)) skillNames.push(name);
  };

  if (r3fScore > 0 || threeScore > 0) {
    categories.push("3d");
    if (r3fScore > 0) {
      R3F_BASE.forEach(push);
      for (const name of R3F_CONDITIONAL) {
        if (matchCount(name) > 0) push(name);
      }
    }
    if (threeScore > 0) {
      const baseInstalled = THREE_BASE.every((n) => installed.has(n));
      if (baseInstalled) THREE_BASE.forEach(push);
      else push(THREE_UMBRELLA);
      for (const name of THREE_CONDITIONAL) {
        const fires = matchCount(name) > 0 || (name === "threejs-blender-glb-pipeline" && hasImage);
        if (!fires) continue;
        push(name);
        const twin = R3F_TWIN[name];
        if (twin && r3fScore > 0) push(twin);
      }
      if (hasImage) push("threejs-blender-glb-pipeline");
    }
  }

  if (archScore > 0) {
    categories.push("architecture");
    for (const name of ARCH_SKILLS) {
      if (matchCount(name) > 0) push(name);
    }
  }

  return { skillNames, categories };
}

/** Insert after the leading run of system messages so chat templates keep it. */
function insertSystemMessage(payload: any, content: string): void {
  const messages: any[] = payload.messages;
  let index = 0;
  while (index < messages.length && messages[index]?.role === "system") index++;
  messages.splice(index, 0, { role: "system", content });
}

/**
 * Entry point used by POST /api/chat. Injects the matched core-skill bundles +
 * output contract into the payload as one system message and returns the fired
 * skill names (for the X-Used-Skill header). Zero tokens when nothing matches.
 */
export async function applyCoreSkillRouting(
  payload: any,
  root: string = projectRoot(),
): Promise<CoreRoutingResult> {
  if (!payload || !Array.isArray(payload.messages)) return { usedSkills: [], category: null };

  const turn = lastUserTurn(payload);
  if (!turn.text.trim()) return { usedSkills: [], category: null };

  const [scenarios, installed] = await Promise.all([readCoreScenarios(root), installedCoreNames(root)]);
  if (scenarios.length === 0 || installed.size === 0) return { usedSkills: [], category: null };

  const selection = selectCoreSkills(turn.text, turn.hasImage, scenarios, installed);
  if (selection.skillNames.length === 0) return { usedSkills: [], category: null };

  const blocks: string[] = [];
  const usedSkills: string[] = [];
  let total = 0;
  for (const name of selection.skillNames) {
    if (total >= MAX_TOTAL_BUNDLE_BYTES) break;
    const bundle = await loadCoreBundle(root, name);
    if (!bundle) continue;
    const room = MAX_TOTAL_BUNDLE_BYTES - total;
    const clipped = bundle.slice(0, Math.min(MAX_SKILL_BUNDLE_BYTES, room));
    blocks.push('<core_skill name="' + name + '">\n' + clipped + "\n</core_skill>");
    total += clipped.length;
    usedSkills.push(name);
  }
  if (usedSkills.length === 0) return { usedSkills: [], category: null };

  for (const category of selection.categories) {
    blocks.push(category === "3d" ? THREE_CONTRACT : ARCH_CONTRACT);
  }
  const categoryLabel = selection.categories.join("+");
  insertSystemMessage(payload, '<core_skill_routing category="' + categoryLabel + '" lazy="true">\n' + blocks.join("\n\n") + "\n</core_skill_routing>");

  return { usedSkills, category: selection.categories[0] ?? null };
}
