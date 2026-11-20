# Ruke development

For new or resumed work check open entries in `testing/ISSUES.md` and the working-tree diff for the affected paths. For an ongoing overnight task resume from `docs/overnight/STATE.md`, then consult the corresponding TASKS and DECISIONS entries. Keep unrelated work intact. The current overnight scope leaves the PC on.

For architecture questions start with `graphify query "symbol or flow" --budget 600`. Confirm edges and active routes in source. The source watcher refreshes the graph after saves. During a rebuild check newly edited symbols directly in source. Select ruke-runtime automatically for cross-stack ownership and ruke-qa for validation.

Strata has one shared inference slot. Keep code and live-model testing exclusive. An active `.ai-coordination/playwright.lock` owns the workspace. Wait for release before edits or competing work. Run live tests in the foreground with the exclusive launcher. Resume analysis after exit and lock release. Never remove another session's lease or probe, unload or restart the coding model during a turn.

Preserve Ruke's two application skill tiers and installer rules in AGENTS.md. User skills live in skills/ and skill-scenarios/. Core skills in .cskills/ and .cskills-scenarios/ stay invisible to browser listing, installation, deletion and slash completion. Resolve runtime routing from current code and contracts. Development skills live in .claude/skills/.

Keep shared UI libraries in lib/, styles in styles/, and heavy studio viewers lazy-loaded from FenceRouter. Keep code readable and components focused. Preserve frame-batched streaming, memoized completed messages, deferred highlighting, offscreen animation pause and WebGL disposal. Keep exact results, accessibility, error reporting and model quality when optimizing. Preserve the single main model and existing prompt contracts.
