/**
 * Shared skill-engine types. Client-safe (no Node imports): the WebUI modal
 * and the server registry both consume these.
 */

/** On-disk shape of ./skill-scenarios/<skill-name>.json. */
export interface SkillScenario {
  skillName: string;
  sourceRepo: string;
  enabled: boolean;
  autoUse: boolean;
  whenToUse: string;
  triggerKeywords: string[];
  blockedReason: string | null;
  /**
   * Application-owned capability declaration (F20). The ONLY supported way for
   * a skill to state a hard capability requirement; the modality filter reads
   * it before any text heuristics. Absent means "infer from protocol evidence".
   */
  requiredCapabilities?: string[];
}

/** GET /api/skills response row: scenario merged with install state. */
export interface SkillRecord extends SkillScenario {
  installed: boolean;
  description: string;
}

/** POST /api/skills/install request body. */
export interface InstallRequestBody {
  /** "owner/repo", "owner/repo --skill name", or a full "npx skills add ..." command. */
  repoOrCommand: string;
  skillName?: string;
  autoUse?: boolean;
  whenToUse?: string;
  triggerKeywords?: string[];
}

export const BLOCKED_REASON = "Unsupported media generation skill";
