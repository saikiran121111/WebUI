# Agent Instructions — Local AI WebUI

## STRICT SKILL MANAGEMENT RULES (MANDATORY)

1. **NEVER** author or fabricate custom `SKILL.md` files from scratch. Do not invent skills, their instructions, or their frontmatter.
2. **ALWAYS** download existing skills via `npx -y skills add <owner/repo> --skill <skill-name>` (or `npx -y skills add <owner/repo>`) and move them into `./skills/<skill-name>/`. The installer service (`POST /api/skills/install`) does this automatically; use it instead of running the command by hand.
3. **NEVER** edit a downloaded `SKILL.md` unless the user explicitly says: "change the implementation of the existing skill [skill-name]".
4. Routing logic for when a skill should fire lives **ONLY** in `./skill-scenarios/<skill-name>.json` — never inside a `SKILL.md`, never hardcoded in prompts or components.
5. **Strict lazy loading:** a `SKILL.md` body is NEVER placed in the system prompt unless the user types `/<skill-name>` OR the skill has `autoUse: true` + a non-empty `whenToUse` AND the user's prompt matches its scenario. On every other turn, skills cost zero tokens.

### Layout
- `./skills/<skill-name>/` — real downloaded skills only (SKILL.md + reference files). Never hand-written.
- `./skill-scenarios/<skill-name>.json` — per-skill routing: `{ skillName, sourceRepo, enabled, autoUse, whenToUse, triggerKeywords, blockedReason }`.
- Re-indexing never overwrites an existing scenario file; installs auto-create one with `autoUse: false` and `whenToUse: ""` when missing.
