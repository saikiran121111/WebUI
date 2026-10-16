/**
 * Server-side skill registry + loader for the WebUI's own `skills/` directory.
 * Reads the manifest once, then loads ONLY the SKILL.md files selected by the
 * detected intent (mtime-cached). This is plain Node fs inside the Next.js
 * server — it has zero dependency on Claude Code or any external agent runtime.
 *
 * The manifest carries one shared skill list for every WebUI skill domain
 * ("3d", "anatomy", ...); each skill declares its domain (default "3d") so a
 * request only ever loads the pack it activated.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ThreeSubIntent } from "./intent";

export interface SkillMeta {
  id: string;
  file: string;
  title: string;
  purpose: string;
  activation: "domain" | "intent";
  subIntent: string | null;
  dependsOn: string[];
  domain?: "3d" | "anatomy";
}

interface SkillManifest { version: number; domain: string; skills: SkillMeta[]; }

const SKILLS_ROOT = path.join(process.cwd(), "skills");
const MANIFEST_PATH = path.join(SKILLS_ROOT, "manifest.json");

let manifestPromise: Promise<SkillManifest> | null = null;
const fileCache = new Map<string, { mtimeMs: number; text: string }>();

async function getManifest(): Promise<SkillManifest> {
  if (!manifestPromise) {
    manifestPromise = fs.readFile(MANIFEST_PATH, "utf8")
      .then(raw => JSON.parse(raw) as SkillManifest)
      .catch(err => {
        manifestPromise = null; // let a later request retry after a fix
        throw err;
      });
  }
  return manifestPromise;
}

/** Skill ids selected for one domain pack + sub-intents, with dependency closure. */
async function selectPackIds(domain: "3d" | "anatomy", subIntents: string[]): Promise<string[]> {
  const manifest = await getManifest();
  const wanted = new Set<string>();
  for (const skill of manifest.skills) {
    if ((skill.domain ?? "3d") !== domain) continue;
    if (skill.activation === "domain") wanted.add(skill.id);
    else if (skill.subIntent && subIntents.includes(skill.subIntent)) wanted.add(skill.id);
  }
  // Dependency closure (deps load before dependents).
  const ordered: string[] = [];
  const visit = (id: string, stack: Set<string>) => {
    if (ordered.includes(id) || stack.has(id)) return;
    stack.add(id);
    const skill = manifest.skills.find(s => s.id === id);
    if (!skill) return;
    for (const dep of skill.dependsOn) visit(dep, stack);
    ordered.push(id);
  };
  for (const id of wanted) visit(id, new Set());
  return ordered;
}

/** 3D pack ids (kept as the public entry point the chat route and tests use). */
export async function selectSkillIds(subIntents: ThreeSubIntent[]): Promise<string[]> {
  return selectPackIds("3d", subIntents);
}

/** Anatomy pack ids for the given anatomy sub-intents. */
export async function selectAnatomySkillIds(subIntents: string[]): Promise<string[]> {
  return selectPackIds("anatomy", subIntents);
}

async function readSkillFile(relFile: string): Promise<string | null> {
  const abs = path.resolve(SKILLS_ROOT, relFile);
  // Path guard: never read outside the skills/ tree.
  if (!abs.startsWith(SKILLS_ROOT + path.sep)) return null;
  try {
    const stat = await fs.stat(abs);
    const cached = fileCache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = await fs.readFile(abs, "utf8");
    fileCache.set(abs, { mtimeMs: stat.mtimeMs, text });
    return text;
  } catch {
    return null;
  }
}

async function loadPackInstructions(domain: "3d" | "anatomy", subIntents: string[]): Promise<string> {
  try {
    const ids = await selectPackIds(domain, subIntents);
    const manifest = await getManifest();
    const blocks: string[] = [];
    for (const id of ids) {
      const meta = manifest.skills.find(s => s.id === id);
      if (!meta) continue;
      const text = await readSkillFile(meta.file);
      if (text) blocks.push(`<!-- skill: ${meta.id} -->\n${text.trim()}`);
    }
    return blocks.join("\n\n");
  } catch {
    return ""; // skill subsystem must never break chat
  }
}

/**
 * The 3D instruction block to inject into a qualifying Strata request.
 * Returns "" when nothing applies, so unrelated chat is untouched.
 */
export async function loadSkillInstructions(subIntents: ThreeSubIntent[]): Promise<string> {
  return loadPackInstructions("3d", subIntents);
}

/** The Anatomy instruction block (same guarantees as loadSkillInstructions). */
export async function loadAnatomyInstructions(subIntents: string[]): Promise<string> {
  return loadPackInstructions("anatomy", subIntents);
}

/** Diagnostics/test surface: the catalog without file contents. */
export async function getSkillCatalog(): Promise<SkillMeta[]> {
  return (await getManifest()).skills;
}
