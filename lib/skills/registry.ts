import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter";
import { detectBlockedReason } from "./modality";
import type { InstallRequestBody, SkillScenario } from "./types";

/**
 * Skill registry: ./skills/<name>/ holds REAL downloaded skills (SKILL.md +
 * reference files), ./skill-scenarios/<name>.json holds routing config.
 * The `npx skills` CLI drops installs into .agents/skills or .claude/skills;
 * syncInstalledSkills() moves them into ./skills/ (zero duplicates) and
 * auto-creates scenarios (never overwriting an existing one).
 */

const SKILLS_DIR = "skills";
const SCENARIOS_DIR = "skill-scenarios";
const TEMP_SKILL_DIRS = [".agents/skills", ".claude/skills"];

/** Skill names double as folder names: keep them path-safe. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
/** Tokens handed to the npx CLI: letters, digits and a few URL-safe marks only. */
const SAFE_TOKEN = /^[A-Za-z0-9._:@/+-]+$/;

const MAX_BUNDLE_BYTES = 160_000;
const INSTALL_TIMEOUT_MS = 300_000;

/** Overridable so tests can point the whole engine at a temp project root. */
export function projectRoot(): string {
  return process.env.WEBUI_SKILLS_ROOT ?? process.cwd();
}

export function isSafeSkillName(name: string): boolean {
  return SAFE_NAME.test(name);
}

function skillDir(root: string, name: string): string {
  return path.join(root, SKILLS_DIR, name);
}
function scenarioFile(root: string, name: string): string {
  return path.join(root, SCENARIOS_DIR, name + ".json");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function hasSkillMd(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, "SKILL.md"));
}

export async function skillExists(root: string, name: string): Promise<boolean> {
  if (!isSafeSkillName(name)) return false;
  return hasSkillMd(skillDir(root, name));
}

/** Installed skill folder names (those that actually contain a SKILL.md). */
export async function listInstalledSkillNames(root: string = projectRoot()): Promise<string[]> {
  const entries = await readdirSafe(path.join(root, SKILLS_DIR));
  const installed: string[] = [];
  for (const entry of entries) {
    if (!isSafeSkillName(entry)) continue;
    if (await hasSkillMd(path.join(root, SKILLS_DIR, entry))) installed.push(entry);
  }
  return installed.sort();
}

export function defaultScenario(skillName: string, sourceRepo = ""): SkillScenario {
  return {
    skillName,
    sourceRepo,
    enabled: true,
    autoUse: false,
    whenToUse: "",
    triggerKeywords: [],
    blockedReason: null,
  };
}

export async function readScenario(root: string, skillName: string): Promise<SkillScenario | null> {
  if (!isSafeSkillName(skillName)) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(scenarioFile(root, skillName), "utf8"));
    return {
      ...defaultScenario(skillName),
      ...parsed,
      skillName,
      triggerKeywords: Array.isArray(parsed?.triggerKeywords) ? parsed.triggerKeywords : [],
    };
  } catch {
    return null;
  }
}

/**
 * Create the scenario file when missing (autoUse:false, whenToUse:"").
 * NEVER overwrites an existing scenario — re-indexing only applies the
 * modality-block safety update (enabled:false + blockedReason) when a skill
 * that is currently enabled turns out to need an external media API.
 */
export async function ensureScenario(
  root: string,
  skillName: string,
  sourceRepo = "",
): Promise<SkillScenario> {
  const existing = await readScenario(root, skillName);
  if (existing) {
    if (existing.enabled && !existing.blockedReason) {
      const markdown = await readSkillMarkdown(root, skillName);
      const blocked = markdown ? detectBlockedReason(markdown) : null;
      if (blocked) {
        existing.enabled = false;
        existing.blockedReason = blocked;
        await writeScenario(root, existing);
      }
    }
    return existing;
  }
  const scenario = defaultScenario(skillName, sourceRepo);
  const markdown = await readSkillMarkdown(root, skillName);
  const blocked = markdown ? detectBlockedReason(markdown) : null;
  if (blocked) {
    scenario.enabled = false;
    scenario.blockedReason = blocked;
  }
  await writeScenario(root, scenario);
  return scenario;
}

async function writeScenario(root: string, scenario: SkillScenario): Promise<void> {
  await fs.mkdir(path.join(root, SCENARIOS_DIR), { recursive: true });
  const clean: SkillScenario = {
    skillName: scenario.skillName,
    sourceRepo: scenario.sourceRepo,
    enabled: scenario.enabled,
    autoUse: scenario.autoUse,
    whenToUse: scenario.whenToUse,
    triggerKeywords: scenario.triggerKeywords,
    blockedReason: scenario.blockedReason,
  };
  await fs.writeFile(scenarioFile(root, scenario.skillName), JSON.stringify(clean, null, 2) + "\n", "utf8");
}

export type ScenarioPatch = Partial<
  Pick<SkillScenario, "enabled" | "autoUse" | "whenToUse" | "triggerKeywords" | "blockedReason" | "sourceRepo">
>;

export async function updateScenario(root: string, skillName: string, patch: ScenarioPatch): Promise<SkillScenario | null> {
  const current = await readScenario(root, skillName);
  if (!current) return null;
  const merged: SkillScenario = { ...current };
  if (typeof patch.enabled === "boolean") merged.enabled = patch.enabled;
  if (typeof patch.autoUse === "boolean") merged.autoUse = patch.autoUse;
  if (typeof patch.whenToUse === "string") merged.whenToUse = patch.whenToUse;
  if (Array.isArray(patch.triggerKeywords)) merged.triggerKeywords = patch.triggerKeywords.map(String);
  if (typeof patch.sourceRepo === "string") merged.sourceRepo = patch.sourceRepo;
  if (patch.blockedReason === null || typeof patch.blockedReason === "string") merged.blockedReason = patch.blockedReason ?? null;
  await writeScenario(root, merged);
  return merged;
}

export async function deleteSkill(root: string, skillName: string): Promise<boolean> {
  if (!isSafeSkillName(skillName)) return false;
  const removed = (await skillExists(root, skillName)) || (await pathExists(scenarioFile(root, skillName)));
  await fs.rm(skillDir(root, skillName), { recursive: true, force: true });
  await fs.rm(scenarioFile(root, skillName), { force: true });
  return removed;
}

/**
 * Move freshly installed skills out of .agents/skills / .claude/skills into
 * ./skills/<name>/, clean the temp copies (zero duplicates) and create any
 * missing scenario files. Returns the skill names discovered this pass.
 */
export async function syncInstalledSkills(root: string = projectRoot()): Promise<string[]> {
  const discovered: string[] = [];
  for (const tempRel of TEMP_SKILL_DIRS) {
    const tempAbs = path.join(root, tempRel);
    for (const entry of await readdirSafe(tempAbs)) {
      const source = path.join(tempAbs, entry);
      if (!isSafeSkillName(entry)) continue;
      if (await isBrokenLink(source)) { await fs.rm(source, { force: true }); continue; }
      if (!(await hasSkillMd(source))) continue;
      const target = path.join(root, SKILLS_DIR, entry);
      if (await pathExists(target)) {
        await fs.rm(source, { recursive: true, force: true });
      } else {
        await fs.mkdir(path.join(root, SKILLS_DIR), { recursive: true });
        try {
          await fs.rename(source, target);
        } catch {
          await fs.cp(source, target, { recursive: true });
          await fs.rm(source, { recursive: true, force: true });
        }
      }
      discovered.push(entry);
    }
    await removeDirIfEmpty(tempAbs);
  }
  for (const name of await listInstalledSkillNames(root)) await ensureScenario(root, name);
  return discovered;
}

async function removeDirIfEmpty(dir: string): Promise<void> {
  const entries = await readdirSafe(dir);
  if (entries.length === 0) await fs.rm(dir, { recursive: true, force: true });
}

/**
 * The `npx skills` CLI symlinks its Claude Code copy into .claude/skills;
 * once the real directory is moved away that link dangles and stat-based
 * checks miss it, so lstat it and drop the dangling entry.
 */
async function isBrokenLink(target: string): Promise<boolean> {
  try {
    if (!(await fs.lstat(target)).isSymbolicLink()) return false;
    await fs.stat(target);
    return false;
  } catch {
    return true;
  }
}

/** Debounced fs.watch on the temp install dirs; idempotent across HMR reloads. */
const WATCHER_FLAG = "__webuiSkillWatcherStarted" as const;
export function startSkillWatcher(root: string = projectRoot()): void {
  const g = globalThis as Record<string, unknown>;
  if (g[WATCHER_FLAG]) return;
  g[WATCHER_FLAG] = true;
  let timer: NodeJS.Timeout | null = null;
  for (const tempRel of TEMP_SKILL_DIRS) {
    try {
      fsSync.mkdirSync(path.join(root, tempRel), { recursive: true });
      fsSync.watch(path.join(root, tempRel), () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void syncInstalledSkills(root).catch(() => {}), 500);
      });
    } catch {
      // Watcher is a convenience; GET /api/skills also syncs on every call.
    }
  }
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

export interface ParsedInstall {
  repo: string;
  skillName: string | null;
}

/**
 * Accepts the three input forms from the spec:
 *   "blader/humanizer"
 *   "wheresryan22/anatomy --skill anatomy"
 *   "npx skills add https://github.com/blader/humanizer --skill humanizer"
 * Rejects anything that is not a github slug/URL or contains unsafe tokens.
 */
export function parseInstallRequest(input: string): ParsedInstall {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new Error("Install input is empty");

  const tokens = trimmed.split(/\s+/);
  while (tokens.length > 0 && (/^(npx|skills|add)$/i.test(tokens[0]) || tokens[0] === "-y")) tokens.shift();

  let skillName: string | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--skill" || token === "-s") {
      skillName = tokens[++i] ?? null;
      continue;
    }
    if (token === "-y" || token === "--yes" || token === "--copy" || token === "--no-copy") continue;
    if (token.startsWith("-")) throw new Error("Unsupported install flag: " + token);
    positionals.push(token);
  }
  if (positionals.length === 0) throw new Error("No repository given in install input");

  const repo = normalizeRepo(positionals[0]);
  if (!repo) throw new Error("Repository must be an owner/repo slug or a github URL");
  for (const token of [positionals[0], ...(skillName ? [skillName] : [])]) {
    if (!SAFE_TOKEN.test(token)) throw new Error("Unsafe character in install token: " + token);
  }
  if (skillName && !isSafeSkillName(skillName)) throw new Error("Unsafe skill name: " + skillName);
  return { repo, skillName };
}

function normalizeRepo(raw: string): string | null {
  let candidate = raw;
  const url = /^https?:\/\/(?:www\.)?github\.com\/(.+)$/i.exec(raw);
  if (url) candidate = url[1];
  candidate = candidate.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(candidate)) return null;
  return candidate;
}

export interface InstallResult {
  installedSkillNames: string[];
  commandOutput: string;
}

export async function installSkill(request: InstallRequestBody, root: string = projectRoot()): Promise<InstallResult> {
  const parsed = parseInstallRequest(request.repoOrCommand);
  const npxArgs = [
    "-y", "skills", "add", parsed.repo,
    ...(parsed.skillName ? ["--skill", parsed.skillName] : []),
    "-y",
  ];
  const commandOutput = await runInstall(npxArgs, root);
  await syncInstalledSkills(root);

  const targets = parsed.skillName
    ? [parsed.skillName]
    : await listInstalledSkillNames(root);
  for (const name of targets) {
    if (!await skillExists(root, name)) continue;
    await ensureScenario(root, name, parsed.repo);
    const patch: ScenarioPatch = { sourceRepo: parsed.repo };
    if (request.autoUse !== undefined) patch.autoUse = request.autoUse;
    if (request.whenToUse !== undefined) patch.whenToUse = request.whenToUse;
    if (request.triggerKeywords !== undefined) patch.triggerKeywords = request.triggerKeywords;
    await updateScenario(root, name, patch);
  }
  return { installedSkillNames: targets.filter((n) => n), commandOutput };
}

function runInstall(npxArgs: string[], root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onWindows = process.platform === "win32";
    const child = spawn(
      onWindows ? "cmd.exe" : "npx",
      onWindows ? ["/d", "/s", "/c", "npx", ...npxArgs] : npxArgs,
      { cwd: root, windowsHide: true, shell: false },
    );
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < 200_000) output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Skill install timed out after " + INSTALL_TIMEOUT_MS / 1000 + "s"));
    }, INSTALL_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error("Skill install failed (exit " + code + "): " + output.slice(-500)));
    });
  });
}

// ---------------------------------------------------------------------------
// Skill content loading (lazy: only read from disk when a skill fires)
// ---------------------------------------------------------------------------

async function readSkillMarkdown(root: string, skillName: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(skillDir(root, skillName), "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/**
 * SKILL.md plus every markdown file it links to (relative links only, path
 * guarded to stay inside the skill folder). Returns null when not installed.
 */
export async function loadSkillBundle(root: string, skillName: string): Promise<string | null> {
  const main = await readSkillMarkdown(root, skillName);
  if (main === null) return null;

  const dir = skillDir(root, skillName);
  const linked = new Set<string>();
  for (const match of main.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
    const rel = match[1];
    if (rel.startsWith("http") || rel.startsWith("/")) continue;
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) continue;
    linked.add(abs);
  }

  let bundle = main;
  for (const abs of linked) {
    if (bundle.length >= MAX_BUNDLE_BYTES) break;
    try {
      bundle += "\n\n" + await fs.readFile(abs, "utf8");
    } catch {
      // Referenced file missing: the SKILL.md body alone still routes the skill.
    }
  }
  return bundle.slice(0, MAX_BUNDLE_BYTES);
}

/** Frontmatter description for the UI list (falls back to first heading). */
export async function skillDescription(root: string, skillName: string): Promise<string> {
  const markdown = await readSkillMarkdown(root, skillName);
  if (!markdown) return "";
  const front = parseFrontmatter(markdown);
  if (front?.description) return front.description;
  const heading = /^#\s+(.+)$/m.exec(markdown);
  return heading ? heading[1].trim() : "";
}
