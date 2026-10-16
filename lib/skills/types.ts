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
