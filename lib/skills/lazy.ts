import { listInstalledSkillNames, loadSkillBundle, projectRoot, readScenario, skillExists } from "./registry";
import type { SkillScenario } from "./types";

/**
 * Strict lazy loading: a SKILL.md body costs ZERO tokens until it fires.
 *  - Mode 1: the message starts with "/<skill-name>" -> strip the prefix and
 *    inject that skill's full body as <active_skill> for this turn only.
 *  - Mode 2: autoUse skills get a lightweight routing block (name + whenToUse
 *    ONLY, never the body) plus a load_skill tool; a keyword pre-router covers
 *    local models that skip tool calls and loads the body directly.
 */

export interface SkillRoutingResult {
  usedSkill: string | null;
  toolLoopRequired: boolean;
}

const NO_ROUTING: SkillRoutingResult = { usedSkill: null, toolLoopRequired: false };

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

function lastUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

function injectSystemBefore(messages: any[], index: number, content: string): void {
  messages.splice(index, 0, { role: "system", content });
}

export function activeSkillBlock(skillName: string, skillBody: string): string {
  return (
    "<active_skill name=\"" + skillName + "\">\n" + skillBody + "\n</active_skill>\n" +
    "The skill above is active for this request only. Follow its instructions exactly."
  );
}

/** Remove the "/skill-name" prefix from the last user message in place. */
function stripSlashPrefix(message: any, fullText: string): void {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordMatches(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return false;
    return new RegExp("(?:^|[^a-z0-9])" + escapeRegExp(kw) + "(?:[^a-z0-9]|$)").test(lower);
  });
}

const STOPWORDS = new Set([
  "use", "this", "that", "with", "your", "when", "skill", "asks", "user", "make",
  "from", "into", "them", "they", "their", "what", "which", "about", "would",
  "could", "should", "than", "then", "there", "these", "those", "some", "such",
  "other", "more", "most", "also", "only", "just", "over", "under", "again",
]);

/** Fallback when a skill has no triggerKeywords: shared bigrams of content words. */
function whenToUseMatches(text: string, whenToUse: string): boolean {
  const contentWords = (value: string) =>
    (value.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => !STOPWORDS.has(word));
  const scenarioWords = contentWords(whenToUse);
  if (scenarioWords.length === 0) return false;
  const bigrams: string[] = [];
  for (let i = 0; i < scenarioWords.length - 1; i++) bigrams.push(scenarioWords[i] + " " + scenarioWords[i + 1]);
  const haystack = " " + contentWords(text).join(" ") + " ";
  return bigrams.some((bigram) => haystack.includes(bigram));
}

export function matchesScenario(text: string, scenario: SkillScenario): boolean {
  if (scenario.triggerKeywords.length > 0) return keywordMatches(text, scenario.triggerKeywords);
  return whenToUseMatches(text, scenario.whenToUse);
}

function routingBlock(scenarios: SkillScenario[]): string {
  const lines = scenarios.map((s) => "- " + s.skillName + ": " + s.whenToUse);
  return (
    "<skill_router>\n" +
    "These optional skills hold extra instructions that are NOT loaded yet. " +
    "If the user's latest request clearly matches a skill's scenario, call the load_skill tool " +
    "with that skill_name before answering. If no scenario matches, answer normally without tools.\n" +
    lines.join("\n") + "\n</skill_router>"
  );
}

export function loadSkillToolDef(skillNames: string[]): any {
  return {
    type: "function",
    function: {
      name: "load_skill",
      description: "Load the full instructions of a skill when the user's request matches its scenario.",
      parameters: {
        type: "object",
        properties: { skill_name: { type: "string", enum: skillNames } },
        required: ["skill_name"],
      },
    },
  };
}

/**
 * Mutates payload.messages (and payload.tools for the routing-block path)
 * according to the two trigger modes. Returns which skill fired, and whether
 * the caller must run a load_skill tool round against the model.
 */
export async function applySkillRouting(
  payload: any,
  root: string = projectRoot(),
): Promise<SkillRoutingResult> {
  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return NO_ROUTING;

  const lastUserIdx = lastUserIndex(messages);
  if (lastUserIdx === -1) return NO_ROUTING;
  const text = extractUserText(messages[lastUserIdx]?.content);
  if (!text.trim()) return NO_ROUTING;

  // ---- Mode 1: explicit /<skill-name> -------------------------------------
  const slash = SLASH_COMMAND.exec(text.trim());
  if (slash) {
    const skillName = slash[1];
    const scenario = await readScenario(root, skillName);
    if (!scenario || !scenario.enabled || !(await skillExists(root, skillName))) return NO_ROUTING;
    const bundle = await loadSkillBundle(root, skillName);
    if (!bundle) return NO_ROUTING;
    stripSlashPrefix(messages[lastUserIdx], text);
    injectSystemBefore(messages, lastUserIdx, activeSkillBlock(skillName, bundle));
    return { usedSkill: skillName, toolLoopRequired: false };
  }

  // ---- Mode 2: autoUse scenarios ------------------------------------------
  const autoScenarios: SkillScenario[] = [];
  for (const name of await listInstalledSkillNames(root)) {
    const scenario = await readScenario(root, name);
    if (!scenario || !scenario.enabled || !scenario.autoUse) continue;
    if (scenario.whenToUse.trim() === "") continue;
    autoScenarios.push(scenario);
  }
  if (autoScenarios.length === 0) return NO_ROUTING;

  // Pre-router fallback: strong keyword hit -> load the body right now.
  for (const scenario of autoScenarios) {
    if (!matchesScenario(text, scenario)) continue;
    const bundle = await loadSkillBundle(root, scenario.skillName);
    if (!bundle) continue;
    injectSystemBefore(messages, lastUserIdx, activeSkillBlock(scenario.skillName, bundle));
    return { usedSkill: scenario.skillName, toolLoopRequired: false };
  }

  // No keyword hit: offer the routing block + load_skill tool. Requests that
  // already carry tools (research mode) keep their own tool contract intact.
  if (Array.isArray(payload.tools) && payload.tools.length > 0) return NO_ROUTING;
  injectSystemBefore(messages, lastUserIdx, routingBlock(autoScenarios));
  payload.tools = [loadSkillToolDef(autoScenarios.map((s) => s.skillName))];
  return { usedSkill: null, toolLoopRequired: true };
}

/**
 * Resolve a load_skill tool call: validate the skill is installed + enabled,
 * then inject its body as <active_skill> before the last user message and
 * drop the tool contract for the follow-up round. Returns the skill name on
 * success, null when the call should be ignored.
 */
export async function activateSkillFromToolCall(
  payload: any,
  skillName: string,
  root: string = projectRoot(),
): Promise<string | null> {
  const scenario = await readScenario(root, skillName);
  if (!scenario || !scenario.enabled) return null;
  const bundle = await loadSkillBundle(root, skillName);
  if (!bundle) return null;
  const messages = payload.messages as any[];
  const lastUserIdx = lastUserIndex(messages);
  if (lastUserIdx === -1) return null;
  injectSystemBefore(messages, lastUserIdx, activeSkillBlock(skillName, bundle));
  delete payload.tools;
  delete payload.tool_choice;
  return skillName;
}
