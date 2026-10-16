# Vendored Anatomy kit — attribution

Every file in this directory is copied **verbatim** (no edits) from the Anatomy skill, MIT licensed:

- Upstream repository: https://github.com/wheresryan22/anatomy
- Upstream version: 1.1.0
- Upstream commit: `e9488296a44211c42701ff71705b7901470ec78f`
- Copyright (c) 2026 Ryan — full MIT text in `./LICENSE` (kept alongside).

Vendored files: `iso-kit.ts`, `iso-kit.mjs`, `iso.css`, `lathe.mjs`, `tube.mjs`, `audit.mjs`, `gl.mjs`, `react/draw.tsx`, `react/live.tsx`.
Vendored on 2026-10-16.

Scope: this kit is used only by the WebUI Anatomy illustration system (`lib/anatomy/*`, `skills/anatomy/*`, `components/render/AnatomyBlock.tsx`). It is a project-local runtime dependency of the WebUI app — it is **not** registered as a Claude Code skill, plugin, or command, and nothing here depends on Claude Code being installed.

Not vendored (deliberately): `turn*.mjs` + `canvas-painter.mjs` + `gl-shared.mjs` (experimental true-3D beta, evaluated separately — not part of this integration), `scripts/`, `examples/`, `references/` (the WebUI skill docs under `skills/anatomy/` are written for the fence contract instead).
