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
import { isRendererMode, type DecisionEnvelope, type RendererMode } from "./types";

const CORE_SKILLS_DIR = ".cskills";
const MAX_SKILL_BUNDLE_BYTES = 9_000;

/**
 * F02 (2026-11-16): a turn that requests SEVERAL deliverables stays in
 * standard_chat — one mode validator cannot own two fences — but the prompt
 * must still arm EVERY requested output contract, otherwise the model is
 * silently told to produce nothing and the user loses a file. The request
 * list comes from the envelope's OWN typed task_constraints (provenance: the
 * scanner wrote it), never from re-parsing or re-classifying the prompt.
 */
const DELIVERABLE_REQUEST_PREFIX = "deliverable-request=";
/** Bounded injection: two extra contracts is already a large prompt. */
export const MAX_EXTRA_DELIVERABLE_CONTRACTS = 2;

/** Requested deliverable modes other than the active one, in request order. */
export function requestedDeliverables(env: DecisionEnvelope): RendererMode[] {
  const out: RendererMode[] = [];
  for (const constraint of env.task_constraints ?? []) {
    if (typeof constraint !== "string" || !constraint.startsWith(DELIVERABLE_REQUEST_PREFIX)) continue;
    const value = constraint.slice(DELIVERABLE_REQUEST_PREFIX.length);
    if (value === "standard_chat" || value === env.active_mode) continue;
    if (!isRendererMode(value) || out.includes(value)) continue;
    out.push(value);
    if (out.length >= MAX_EXTRA_DELIVERABLE_CONTRACTS) break;
  }
  return out;
}

/** Byte-identical to the Rust `MULTI_DELIVERABLE_NOTE` (golden-replay class). */
export const MULTI_DELIVERABLE_NOTE =
  "MULTI-DELIVERABLE TURN: the request asks for more than one deliverable. " +
  "Emit one fenced block per contract above, in the order requested. " +
  "Do not merge them and do not drop one.";

/**
 * Skills whose downloaded SKILL.md tells the model to run Python/CLI scripts
 * (openpyxl, `python scripts/recalc.py`, LibreOffice...). In this WebUI the
 * model NEVER runs scripts — it emits a fenced spec the backend compiler
 * executes. Those script-execution sections directly contradict MODE_CONTRACTS
 * and re-arm the refusal trap ("if you cannot run scripts, say so"), so they
 * are filtered out of the injected bundle; the prose best-practices survive
 * and the enriched contract stays authoritative.
 */
// "archify" dropped 2026-11-06 (Ruke plan Phase 4): the archify core skill was
// retired with the CAD blueprint route, so no script contract may name it.
const SCRIPT_CONTRACT_SKILLS = new Set(["xlsx", "docx", "pdf", "pptx"]);

/** YAML frontmatter (name/description/license) is router metadata, never prompt content. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/** Drop fenced shell/python blocks + bare CLI command lines. */
function stripExecutableSections(bundle: string): string {
  let out = bundle.replace(/^```(?:bash|sh|shell|console|powershell|ps1|cmd|bat|python|py)\b[\s\S]*?^```[ \t]*$/gim, "");
  out = out.replace(/^[ \t]*(?:\$[ \t]|pip[3]? install|python[3]? \S*\.py|libreoffice |--headless|markitdown |uv run |npm install )[^\n]*$/gim, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

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
  let bundle = stripFrontmatter(main);
  if (SCRIPT_CONTRACT_SKILLS.has(skillName)) bundle = stripExecutableSections(bundle);
  for (const match of main.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
    if (bundle.length >= MAX_SKILL_BUNDLE_BYTES) break;
    const rel = match[1];
    if (rel.startsWith("http") || rel.startsWith("/")) continue;
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) continue;
    try {
      let linked = await fs.readFile(abs, "utf8");
      if (SCRIPT_CONTRACT_SKILLS.has(skillName)) linked = stripExecutableSections(linked);
      bundle += "\n\n" + linked;
    } catch {
      // Missing linked file: the SKILL.md body alone still routes the skill.
    }
  }
  // Truncate at a newline boundary — a mid-word slice ("openpyxl wor…")
  // confuses the model more than a slightly shorter clean bundle.
  if (bundle.length <= MAX_SKILL_BUNDLE_BYTES) return bundle;
  const cut = bundle.lastIndexOf("\n", MAX_SKILL_BUNDLE_BYTES);
  return cut > MAX_SKILL_BUNDLE_BYTES * 0.5 ? bundle.slice(0, cut) : bundle.slice(0, MAX_SKILL_BUNDLE_BYTES);
}

/**
 * The single system block for this turn: matched core skill + active_mode's
 * output contract (artifact modes) or the fence catalogue (standard_chat,
 * D-070 - knowledge, not a keyword rule). No mode is contract-less anymore,
 * so the block exists for every turn; null stays only as the type's honest
 * out for a MODE_CONTRACTS entry someone sets back to null.
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
  const extras = requestedDeliverables(env)
    .map((mode) => MODE_CONTRACTS[mode])
    .filter((c): c is string => Boolean(c));
  parts.push(...extras);
  if (extras.length > 1) parts.push(MULTI_DELIVERABLE_NOTE);
  if (!parts.length) return null;
  return (
    `<decision_skill mode="${env.active_mode}" decided_by="${env.decided_by}">\n` +
    parts.join("\n\n") +
    "\nFollow the skill and output contract above exactly for this request. " +
    "Emit only the fence type named in the contract (if any); where none names one, emit a renderer " +
    "fence only from the catalogue above and only when the request clearly calls for one.\n" +
    "</decision_skill>"
  );
}
