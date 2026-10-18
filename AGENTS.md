# Agent Instructions — Local AI WebUI

## STRICT SKILL MANAGEMENT RULES (MANDATORY)

### Two-Tier Skill Architecture
- **User Skills (visible tier):** `./skills/<skill-name>/` + `./skill-scenarios/<skill-name>.json`. Installed from the browser (Skills Modal → `POST /api/skills/install`) or by hand. These appear in `GET /api/skills`, the Skills Modal, and `/` slash autocomplete.
- **Core Hidden Skills (invisible tier):** `./.cskills/<skill-name>/` + `./.cskills-scenarios/<skill-name>.json`. Installed ONLY by the developer from a terminal via `npm run cskill:add -- <owner/repo> [--skill <name>]` (script: `scripts/install-core-skill.mjs`). The browser can NEVER install into, list, edit, or delete this tier.

### Strict Invisibility of Core Skills
Core skills in `./.cskills/` are NEVER listed by `GET /api/skills`, NEVER shown in the Skills Modal, NEVER offered in `/` slash autocomplete, and NEVER installable or deletable from the browser. They fire ONLY through the Hybrid Decision Engine (`.decision-engine/` worker + `lib/decision/`): when its Stage-1/Stage-2 classification maps the user's prompt to a RendererMode, the mode's `skill_to_load` names exactly one core skill. The mode→skill table is `MODE_MAP` (`.decision-engine/worker/schemas.py`) mirrored by `MODE_SKILL` (`lib/decision/types.ts`).

1. **NEVER** author or fabricate custom `SKILL.md` files from scratch. Do not invent skills, their instructions, or their frontmatter.
2. **ALWAYS** download existing skills via `npx -y skills add <owner/repo> --skill <skill-name>` (or `npx -y skills add <owner/repo>`): user tier through the installer service (`POST /api/skills/install`, lands in `./skills/` ONLY), core tier through `npm run cskill:add` (lands in `./.cskills/` ONLY). The installer service must reject any attempt to touch `./.cskills/`.
3. **NEVER** edit a downloaded `SKILL.md` unless the user explicitly says: "change the implementation of the existing skill [skill-name]".
4. Routing logic for when a skill should fire lives **ONLY** in `./skill-scenarios/<skill-name>.json` (user tier) and `./.cskills-scenarios/<skill-name>.json` (core tier) — never inside a `SKILL.md`, never hardcoded in prompts or components.
5. **Strict lazy loading:** a `SKILL.md` body is NEVER placed in the system prompt unless the user types `/<skill-name>` (user tier only — core skills have no slash entry) OR the skill has `autoUse: true` + a non-empty `whenToUse` AND the user's prompt matches its scenario. A core skill loads ONLY when the Hybrid Decision Engine's `active_mode` maps to it via `skill_to_load` (injected by `lib/decision/skill-loader.ts` as a single `<decision_skill>` block). On every other turn, skills cost zero tokens.

### Layout
- `./skills/<skill-name>/` — real downloaded user skills only (SKILL.md + reference files). Never hand-written.
- `./skill-scenarios/<skill-name>.json` — per-user-skill routing: `{ skillName, sourceRepo, enabled, autoUse, whenToUse, triggerKeywords, blockedReason }`.
- `./.cskills/<skill-name>/` — real downloaded core skills only (SKILL.md + reference files). Never hand-written, never browser-visible.
- `./.cskills-scenarios/<skill-name>.json` — per-core-skill metadata, same shape as user scenarios; maintained by `scripts/install-core-skill.mjs`. Runtime firing is owned by the Hybrid Decision Engine's mode→skill table, not by scenario keyword matching (the legacy `lib/skills/coreRouter.ts` keyword router was removed 2026-10-18).
- Re-indexing never overwrites an existing scenario file; installs auto-create one with `autoUse: false` and `whenToUse: ""` when missing.
