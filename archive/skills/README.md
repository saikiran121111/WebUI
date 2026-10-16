# WebUI Application Skills

This directory holds **the WebUI application's own runtime skill documents**. They are
instruction packs that the WebUI's skill loader (`lib/skills/`) reads from disk and
injects into a Strata model request **only when the user's intent matches**.

These are **not** Claude Code skills. Nothing here is registered with, discovered by,
or required by Claude Code. The WebUI works with Claude Code completely closed:
the loader is plain Node `fs` code inside the Next.js server, and the instructions
travel to Strata as ordinary system-turn content.

## How it works

1. `manifest.json` lists every skill: id, file, purpose, activation mode, sub-intent,
   dependencies.
2. `lib/skills/intent.ts` (pure, no I/O) classifies the latest user message:
   is this a 3D request at all, and which sub-aspects does it touch?
3. `lib/skills/loader.ts` reads **only** the manifest + the selected `SKILL.md`
   files (cached by mtime) and concatenates them into one instruction block.
4. `app/api/chat/route.ts` injects that block as an extra system message for the
   matching request only. Ordinary chat never sees it.

## Layout

```text
skills/
  manifest.json                 machine-readable registry (ids, triggers, deps)
  3d/
    SKILL.md                    parent: shared rules + fence contract + mode routing
    scene-design/               object composition, proportions, domain templates
    geometry-and-topology/      lathe/extrude/tube/bevel, segments, normals, UVs
    materials-and-lighting/     PBR values, presets, tone mapping
    interaction-and-animation/  orbit/select, animation channels, sliders
    asset-generation/           genuine AI mesh generation (provider mode)
    export-and-interoperability GLB/glTF + provider formats, pivot/scale rules
    performance-and-quality-assurance budgets, cleanup, self-checks
```

## Rules for editing skills

- Each skill must stay independently maintainable: shared rules live in the parent
  `3d/SKILL.md`, children only add their specialization. No duplicated prompt text.
- The fence contract documented in `3d/SKILL.md` must stay in sync with
  `lib/three3d/sceneSchema.ts` — the schema is the source of truth; a spec that
  validates against the schema must be describable by the docs.
- Keep instructions actionable for a small local model: exact JSON shapes, numeric
  ranges, and checklists beat prose.
- If you adapt text from a reference project, keep its license notice in the file.
