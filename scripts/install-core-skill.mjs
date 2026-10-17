import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Core Hidden Skill installer — developer-terminal ONLY.
 *
 *   npm run cskill:add -- <owner/repo> [--skill <skill-name>]
 *
 * Downloads REAL skills (never fabricates) into ./.cskills/<skill-name>/ and
 * ensures a routing file at ./.cskills-scenarios/<skill-name>.json.
 * NEVER installs into ./skills/ (the browser-visible user tier).
 *
 * Flow:
 *  1. `npx -y skills add <repo> [--skill name] -y` (the real `skills` CLI).
 *  2. On failure / rate-limit: `git clone --depth 1` into a temp dir and copy
 *     every folder that contains a SKILL.md (honoring --skill as a filter)
 *     into ./.cskills/.
 *  3. Whatever the CLI dropped into .agents/skills or .claude/skills is MOVED
 *     into ./.cskills/ immediately (before the dev-server watcher's 500 ms
 *     debounce can move it into ./skills/), and any leaked copy that already
 *     landed in ./skills/ is moved back out (self-healing).
 *  4. Temp dirs are cleaned; a default scenario is created when missing.
 */

const CORE_SKILLS_DIR = ".cskills";
const CORE_SCENARIOS_DIR = ".cskills-scenarios";
const USER_SKILLS_DIR = "skills";
const TEMP_SKILL_DIRS = [".agents/skills", ".claude/skills"];

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const SAFE_TOKEN = /^[A-Za-z0-9._:@/+-]+$/;
const INSTALL_TIMEOUT_MS = 300_000;

const root = process.cwd();

function usageError(message) {
  console.error("cskill:add — " + message);
  console.error("usage: npm run cskill:add -- <owner/repo> [--skill <skill-name>]");
  process.exit(1);
}

/** Same input grammar as lib/skills/registry.ts parseInstallRequest. */
function parseArgs(argv) {
  const tokens = argv.filter((t) => t && t !== "--");
  while (tokens.length > 0 && (/^(npx|skills|add)$/i.test(tokens[0]) || tokens[0] === "-y")) tokens.shift();

  let skillName = null;
  const positionals = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--skill" || token === "-s") {
      skillName = tokens[++i] ?? null;
      continue;
    }
    if (token === "-y" || token === "--yes" || token === "--copy" || token === "--no-copy") continue;
    if (token.startsWith("-")) usageError("unsupported flag: " + token);
    positionals.push(token);
  }
  if (positionals.length === 0) usageError("no repository given");

  let repo = positionals[0];
  const url = /^https?:\/\/(?:www\.)?github\.com\/(.+)$/i.exec(repo);
  if (url) repo = url[1];
  repo = repo.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) usageError("repository must be an owner/repo slug or github URL");
  for (const token of [positionals[0], ...(skillName ? [skillName] : [])]) {
    if (!SAFE_TOKEN.test(token)) usageError("unsafe character in token: " + token);
  }
  if (skillName && !SAFE_NAME.test(skillName)) usageError("unsafe skill name: " + skillName);
  if (repo.includes(".cskills")) usageError("the core tier cannot be targeted by repo path tricks");
  return { repo, skillName };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const onWindows = process.platform === "win32";
    const child = spawn(
      onWindows ? "cmd.exe" : cmd,
      onWindows ? ["/d", "/s", "/c", cmd, ...args] : args,
      { cwd: opts.cwd ?? root, windowsHide: true, shell: false, stdio: opts.quiet ? "pipe" : "inherit" },
    );
    let output = "";
    if (opts.quiet) {
      child.stdout?.on("data", (c) => { if (output.length < 100_000) output += c; });
      child.stderr?.on("data", (c) => { if (output.length < 100_000) output += c; });
    }
    const timer = setTimeout(() => { child.kill(); reject(new Error(cmd + " timed out")); }, INSTALL_TIMEOUT_MS);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(cmd + " exited " + code + (output ? ": " + output.slice(-400) : "")));
    });
  });
}

async function pathExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function readdirSafe(dir) {
  try { return await fs.readdir(dir); } catch { return []; }
}

async function hasSkillMd(dir) {
  return pathExists(path.join(dir, "SKILL.md"));
}

/** Move a skill folder (with references/, scripts/, assets/) into ./.cskills/. */
async function moveToCore(source, skillName) {
  const target = path.join(root, CORE_SKILLS_DIR, skillName);
  if (!SAFE_NAME.test(skillName)) throw new Error("unsafe skill folder name: " + skillName);
  await fs.mkdir(path.join(root, CORE_SKILLS_DIR), { recursive: true });
  if (await pathExists(target)) {
    await fs.rm(target, { recursive: true, force: true }); // refresh: re-download wins
  }
  try {
    await fs.rename(source, target);
  } catch {
    await fs.cp(source, target, { recursive: true });
    await fs.rm(source, { recursive: true, force: true });
  }
  return target;
}

/** Move anything the npx CLI dropped into the temp dirs into ./.cskills/. */
async function harvestTempDirs(filter) {
  const harvested = [];
  for (const tempRel of TEMP_SKILL_DIRS) {
    const tempAbs = path.join(root, tempRel);
    for (const entry of await readdirSafe(tempAbs)) {
      const source = path.join(tempAbs, entry);
      if (!SAFE_NAME.test(entry)) continue;
      if (filter && entry !== filter) continue;
      if (!(await hasSkillMd(source))) continue;
      await moveToCore(source, entry);
      harvested.push(entry);
      console.log("[cskill] moved " + tempRel + "/" + entry + " -> " + CORE_SKILLS_DIR + "/" + entry);
    }
    // Drop leftovers (broken links, non-skill entries) so the dev-server
    // watcher can never move them into ./skills/.
    for (const leftover of await readdirSafe(tempAbs)) {
      if (filter && leftover !== filter) continue;
      await fs.rm(path.join(tempAbs, leftover), { recursive: true, force: true });
    }
  }
  return harvested;
}

/** Self-healing: if the watcher beat us and leaked a core skill into ./skills/, move it back out. */
async function reclaimFromUserTier(names) {
  for (const name of names) {
    const leaked = path.join(root, USER_SKILLS_DIR, name);
    if (!(await hasSkillMd(leaked))) continue;
    console.warn("[cskill] core skill \"" + name + "\" leaked into ./" + USER_SKILLS_DIR + "/ — moving to ./" + CORE_SKILLS_DIR + "/");
    await moveToCore(leaked, name);
    await fs.rm(path.join(root, "skill-scenarios", name + ".json"), { force: true });
  }
}

/** Fallback: shallow-clone the repo and copy SKILL.md folders into ./.cskills/. */
async function cloneFallback(repo, skillName) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cskill-clone-"));
  try {
    console.log("[cskill] npx failed — falling back to git clone --depth 1 " + repo);
    await run("git", ["clone", "--depth", "1", "https://github.com/" + repo + ".git", "repo"], { cwd: temp, quiet: true });

    const repoDir = path.join(temp, "repo");
    const candidates = [];
    if (await hasSkillMd(repoDir)) {
      candidates.push({ dir: repoDir, name: skillName ?? repo.split("/")[1] });
    }
    // Skills usually live one or two levels down (skills/<name>/SKILL.md).
    for (const entry of await readdirSafe(repoDir)) {
      const first = path.join(repoDir, entry);
      if (!(await (await fs.stat(first)).isDirectory())) continue;
      const scanLevel = async (dir, depth) => {
        for (const sub of await readdirSafe(dir)) {
          const subAbs = path.join(dir, sub);
          let stat;
          try { stat = await fs.stat(subAbs); } catch { continue; }
          if (!stat.isDirectory()) continue;
          if (await hasSkillMd(subAbs)) {
            if (!skillName || sub === skillName) candidates.push({ dir: subAbs, name: sub });
          } else if (depth < 2) {
            await scanLevel(subAbs, depth + 1);
          }
        }
      };
      await scanLevel(first, 1);
    }
    if (candidates.length === 0) throw new Error("no SKILL.md found in clone of " + repo);

    const installed = [];
    for (const { dir, name } of candidates) {
      if (!SAFE_NAME.test(name)) continue;
      await moveToCore(dir, name);
      installed.push(name);
      console.log("[cskill] cloned " + CORE_SKILLS_DIR + "/" + name);
    }
    return installed;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/** Default core scenario (autoUse:false, whenToUse:"") — never overwrites. */
async function ensureCoreScenario(skillName, sourceRepo) {
  const file = path.join(root, CORE_SCENARIOS_DIR, skillName + ".json");
  if (await pathExists(file)) return;
  await fs.mkdir(path.join(root, CORE_SCENARIOS_DIR), { recursive: true });
  const scenario = {
    skillName,
    sourceRepo,
    enabled: true,
    autoUse: false,
    whenToUse: "",
    triggerKeywords: [],
    blockedReason: null,
  };
  await fs.writeFile(file, JSON.stringify(scenario, null, 2) + "\n", "utf8");
}

async function main() {
  const { repo, skillName } = parseArgs(process.argv.slice(2));
  console.log("[cskill] installing core skill(s) from " + repo + (skillName ? " --skill " + skillName : ""));

  let installed = [];
  try {
    await run("npx", ["-y", "skills", "add", repo, ...(skillName ? ["--skill", skillName] : []), "-y"]);
    installed = await harvestTempDirs(skillName);
    if (installed.length === 0 && skillName) {
      // CLI reported success but nothing landed in the temp dirs: it may have
      // written straight into .claude/skills elsewhere or skipped — verify.
      if (await pathExists(path.join(root, CORE_SKILLS_DIR, skillName))) installed = [skillName];
    }
    if (installed.length === 0) throw new Error("npx skills add succeeded but no skill folders were found");
  } catch (err) {
    console.warn("[cskill] npx path failed: " + (err instanceof Error ? err.message : err));
    installed = await cloneFallback(repo, skillName);
  }

  // Belt and braces: clean temp dirs again and reclaim any watcher leaks.
  await harvestTempDirs(skillName);
  await reclaimFromUserTier(installed.length > 0 ? installed : (skillName ? [skillName] : []));

  for (const name of installed) await ensureCoreScenario(name, repo);

  console.log("[cskill] done. " + installed.length + " core skill(s) in ./" + CORE_SKILLS_DIR + "/: " + installed.join(", "));
}

main().catch((err) => {
  console.error("[cskill] FAILED: " + (err instanceof Error ? err.message : err));
  process.exit(1);
});
