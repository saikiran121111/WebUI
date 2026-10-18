import { loadSkillBundle, projectRoot, readScenario, skillExists } from "./registry";

/**
 * Strict lazy loading for the USER tier (./skills/): a SKILL.md body costs
 * ZERO tokens until it fires. The ONLY user-tier trigger is the explicit
 * "/<skill-name>" slash command — the autoUse keyword pre-router, the
 * <skill_router> block and the load_skill tool loop are retired. All
 * intent-based routing now belongs to the Hybrid Decision Engine
 * (lib/decision), which loads core-tier skills from the DecisionEnvelope.
 */

const SLASH_COMMAND = /^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i;

export function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

export function lastUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

export function injectSystemBefore(messages: any[], index: number, content: string): void {
  messages.splice(index, 0, { role: "system", content });
}

export function activeSkillBlock(skillName: string, skillBody: string): string {
  return (
    "<active_skill name=\"" + skillName + "\">\n" + skillBody + "\n</active_skill>\n" +
    "The skill above is active for this request only. Follow its instructions exactly."
  );
}

/** Explicit slash skill name for this turn's text, or null. */
export function slashSkillName(text: string): string | null {
  return SLASH_COMMAND.exec(text.trim())?.[1] ?? null;
}

/** Remove the "/skill-name" prefix from the last user message in place. */
export function stripSlashPrefix(message: any, fullText: string): void {
  const match = SLASH_COMMAND.exec(fullText.trim());
  const remainder = (match?.[2] ?? "").trim();
  if (typeof message.content === "string") {
    message.content = remainder;
    return;
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (typeof part?.text !== "string") continue;
      part.text = part.text.replace(SLASH_COMMAND, remainder);
      break;
    }
  }
}

/**
 * Mode 1 only: if the last user message starts with "/<skill-name>" and that
 * USER-tier skill is installed + enabled, strip the prefix and inject its
 * full body as <active_skill> for this turn. Returns the fired skill name.
 */
export async function applySlashSkillRouting(
  payload: any,
  root: string = projectRoot(),
): Promise<string | null> {
  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const lastUserIdx = lastUserIndex(messages);
  if (lastUserIdx === -1) return null;
  const text = extractUserText(messages[lastUserIdx]?.content);
  if (!text.trim()) return null;

  const skillName = slashSkillName(text);
  if (!skillName) return null;
  const scenario = await readScenario(root, skillName);
  if (!scenario || !scenario.enabled || !(await skillExists(root, skillName))) return null;
  const bundle = await loadSkillBundle(root, skillName);
  if (!bundle) return null;

  stripSlashPrefix(messages[lastUserIdx], text);
  injectSystemBefore(messages, lastUserIdx, activeSkillBlock(skillName, bundle));
  return skillName;
}
