/**
 * Decision-driven skill loader: loads the ONE core skill named by the
 * DecisionEnvelope (from ./.cskills/ — invisible tier) plus the single output
 * contract for active_mode. No keyword scoring, no bundles of several skills:
 * exactly one skill block per turn, or none.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isSafeSkillName, projectRoot } from "../skills/registry";
import { MODE_CONTRACTS } from "./contracts";
import type { DecisionEnvelope } from "./types";

const CORE_SKILLS_DIR = ".cskills";
const MAX_SKILL_BUNDLE_BYTES = 9_000;

/** SKILL.md + linked .md files from the core tier, capped per skill. */
export async function loadCoreSkillBundle(root: string, skillName: string): Promise<string | null> {
  if (!isSafeSkillName(skillName)) return null;
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

/**
 * The single system block for this turn: matched core skill + active_mode's
 * output contract. Returns null for modes with neither (standard_chat).
 */
export async function buildDecisionSkillBlock(
  env: DecisionEnvelope,
  root: string = projectRoot(),
): Promise<string | null> {
  const parts: string[] = [];
  const skill = env.skill_to_load;
  if (skill) {
    const bundle = await loadCoreSkillBundle(root, skill);
    if (bundle) parts.push(`<core_skill name="${skill}">\n${bundle}\n</core_skill>`);
  }
  const contract = MODE_CONTRACTS[env.active_mode];
  if (contract) parts.push(contract);
  if (!parts.length) return null;
  return (
    `<decision_skill mode="${env.active_mode}" decided_by="${env.decided_by}">\n` +
    parts.join("\n\n") +
    "\nFollow the skill and output contract above exactly for this request. " +
    "Emit only the fence type named in the contract (if any); never emit other renderer fences.\n" +
    "</decision_skill>"
  );
}
