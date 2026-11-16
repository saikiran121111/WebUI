# Ruke — Codex working guide

Use this guide for `codex-local` work in this repository. Follow the current user request and `AGENTS.md`; read the relevant sections of `CLAUDE.md` for the project's architecture and browser-test coordination rules. This guide does not authorize unfinished work mentioned in older notes.

## Autonomy and project boundary

`codex-local` runs with `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`: execute the requested work without routine permission prompts or preference questions. Make reasonable implementation choices from the repository and current task. If a required action is blocked by the OS or an unavailable service, report the concrete blocker; this mode does not grant administrator rights or bypass external service restrictions.

Treat the current project's root as the working boundary. Keep inspection, edits, commands, and outputs inside it by default. Go outside only for temporary files or when necessary to complete the current task, such as reading installed tools/skills, using dependency caches, or updating explicitly relevant local configuration. Keep each exception narrow and preserve unrelated files. Prefer project-local temporary files or the OS temporary directory. Full filesystem access does not authorize unrelated work.

This project boundary is an instruction to the agent, not an enforced filesystem sandbox. Respect existing test locks and other agents' files even when full access would allow changing them.

## Start with a narrow inspection

1. Check `git status --short` and the diff before editing. Preserve unrelated changes, test artifacts, and untracked files.
2. Check `.ai-coordination/playwright.lock` before using the shared model or launching browser tests. Respect its owner; never remove a foreign lock to make progress.
3. Find the relevant route, service, component, and tests with `rg`. Read their local instructions and direct dependencies. Avoid loading entire directories or large state documents.
4. For a multi-step task, keep a short plan with a concrete validation target. For a small change, implement directly.

`docs/STATE.md`, `docs/ISSUES.md`, `docs/CHANGELOG.md`, `handover/`, and `plan/` contain project context. Search for the relevant topic and read a bounded section; historical pass counts and closed-task notes are not current verification. The existing `graphify-out/` map can help navigation, but its October snapshot is incomplete for the newer Rust backend. Confirm claims against current source; do not rebuild the entire graph for a small edit.

## Architecture and ownership

| Area | Starting points | Responsibilities |
| --- | --- | --- |
| Frontend | `app/`, `components/`, `hooks/`, `styles/` | Next.js 14 App Router, React 18, TypeScript, Tailwind, streaming chat and rich viewers |
| API boundary | `app/api/`, `lib/server/rustProxy.ts` | Browser-facing Next.js routes and selected delegation to Rust |
| TypeScript services | `lib/chat/`, `lib/stream/`, `lib/web-search/`, `lib/decision/`, `lib/skills/`, `lib/documents/` | Transport helpers, retrieval, decisions, skills, attachment/document processing |
| Backend | `rust-backend/crates/` | Rust 2021, axum 0.8, tokio; shared contracts and runtime services |
| Lifecycle | `scripts/dev-supervisor.mjs` | Builds Rust, starts and supervises the Rust backend and Next.js together |
| Tests | `__tests__/`, `tests/`, Rust crate tests | Vitest unit/contract tests, Playwright journeys, Rust unit/integration tests |

Rust crates: `ruke-server` owns HTTP routes and application state; `ruke-core` owns shared configuration, settings and inference admission; `ruke-contracts` owns shared contracts; `ruke-skills`, `ruke-decision`, `ruke-attach`, and `ruke-browser` own their respective domains. Inspect each crate's current modules before choosing where a change belongs.

Normal development uses `npm run dev`. The supervisor builds Rust before starting services, waits for readiness, and manages its own child processes. Default user-facing origin is `http://localhost:3000`; the Rust backend defaults to loopback port `3101`. `RUKE_RUST_BACKEND=1` controls the Next-to-Rust delegation. Use the existing lifecycle instead of starting competing instances or killing processes by image name. `npm run dev:next` starts only Next.js and is not equivalent to the full development stack.

Library code belongs in `lib/`; do not introduce `src/lib/`. Keep styles in the existing `styles/` and Tailwind structure. Python currently appears in helper scripts; inspect actual service code before proposing a Python service or a migration. Preserve existing Node-owned attachment/document processing and bridges unless the requested task changes them.

## Behaviors to preserve

- Keep Rust and TypeScript implementations consistent where both implement the same contract. Inspect the relevant parity tests, fixtures, generated contracts, and migration notes before changing either side. Classify a fixture mismatch as a protocol, semantic, or legacy-compatibility issue before re-recording it.
- Preserve streaming order, cancellation, usage/metadata handling, and the single terminal completion marker. Do not patch incomplete SSE fragments as if they were complete JSON or completed answers.
- Preserve rAF-batched React stream updates, memoized completed messages, and stream-aware highlighting. Avoid a state update for each token.
- Heavy viewers in `components/render/` stay behind `next/dynamic` with `ssr: false` through `FenceRouter.tsx`. Do not bring 3D/CAD/rendering libraries into the initial page bundle. Pause off-screen animation and dispose resources on unmount.
- Keep model access serialized through the established admission/slot paths. Do not add secondary always-loaded models, prompt-rewriting middleware, or unbounded queues/buffers to work around a defect.
- Keep browser bridge credentials server-side and out of logs, prompts, browser responses, and exported artifacts. Inspect `.env.example` and named configuration code instead of printing private `.env.local` contents.
- Improve general rules rather than adding production exceptions for one test string, locale, query, or website. Put adversarial examples in tests and preserve Unicode behavior.

## Skill boundaries

There are two separate skill systems:

**Codex development skills** live in `C:\Users\Ruku\.codex-local\skills`. Load only the skill body relevant to the current task. Existing shared installations and Claude Code originals are not application skills.

**Ruke's application skills** follow `AGENTS.md`: visible skills live in `skills/` with `skill-scenarios/`; hidden core skills live in `.cskills/` with `.cskills-scenarios/`. Preserve downloaded `SKILL.md` files. Use the project's approved installer for application skills, including `npm run cskill:add` for the hidden tier. Never expose hidden skills through listing, browser installation/deletion, or slash autocomplete. Preserve lazy loading and the decision engine's single selected core-skill block. Check both TypeScript and Rust behavior when changing this boundary.

## Validation commands

Run from the repository root. Choose checks based on the files and behavior changed; do not run every command for a documentation edit.

| Change | Available check |
| --- | --- |
| TypeScript types | `npm run typecheck` |
| Targeted TS behavior | `npm test -- __tests__/relevant.test.ts` — substitute a real existing test path |
| Full Vitest suite when warranted | `npm test` |
| Shared/generated contracts | `npm run contracts:check`; use `npm run contracts:generate` only when regeneration is intended |
| Rust compilation | `cargo check --manifest-path rust-backend/Cargo.toml -p ruke-server` — select the affected crate |
| Rust behavior | `cargo test --manifest-path rust-backend/Cargo.toml -p ruke-server --lib` — narrow to the affected crate/test |
| Rust formatting | `cargo fmt --manifest-path rust-backend/Cargo.toml --all -- --check` |
| Production frontend build | `npm run build` when bundle/build behavior matters |

Inspect `package.json` and test configs if commands change. Vitest currently discovers `__tests__/**/*.test.ts`; Playwright uses `tests/`, the local `.data/ms-playwright` browser store, and a visible Chromium project. There is no `test:e2e` npm script in the inspected manifest.

For the browser suites supported by the existing exclusive launcher:

```powershell
& scripts\run-browser-e2e-exclusive.ps1 -TestFiles 'tests\browser-easy.spec.ts'
```

Select actual test files for the requested behavior. The launcher owns lock acquisition, readiness, foreground execution, and cleanup. Read its parameters before using other suites. Keep CODE → TEST → ANALYZE phases separate: while a model-driven Playwright run owns the backend, do not edit project files, generate competing model requests, or run parallel coding agents. Wait for the complete exit status; analyze final evidence before fixing anything. Never call a live model just to validate an offline code path.

## Quality, latency, and finishing work

Prefer the smallest complete change and the existing abstraction. Use medium reasoning by default; escalate only for a concrete unresolved problem. After a failure, inspect its evidence and change the hypothesis or implementation before repeating a check. Avoid broad rereads and repeated full-suite runs after a relevant check has passed.

For long tasks, save a short checkpoint in the relevant `handover/` document before compaction or handoff: objective, completed changes, remaining work, decisions, exact checks/results, and blockers. Resume from that checkpoint after confirming the live diff. Do not launch subagents unless requested.

Keep inference on the configured Strata/Qwen provider. If unavailable, report the endpoint failure rather than switching provider or model. Use the installed search/browser CLIs for external research when needed; model inference and external web retrieval are separate operations.

Finish with what changed, why, the checks actually completed and their results, and any remaining limitation. For a review, lead with concrete defects and locations. Do not claim tests, commits, pushes, deployment, or performance gains without evidence. Commit and push only when requested.


## Shared-endpoint exclusivity (MANDATORY, added 2026-11-15)

Strata (http://127.0.0.1:8080/v1, provider `strata`) serves exactly ONE concurrent
inference request, and Codex (this agent) and Ruke share it. Any Ruke run that performs
model inference - the Playwright / browser end-to-end suite above all - therefore competes
directly with Codex's own inference turns, and interleaving them corrupts both.

Law (no exceptions):
1. Playwright / browser e2e validation is the FINAL stage of a long implementation run:
   it starts only after every deterministic gate (typecheck, vitest, cargo test, contracts,
   python tests, production build) has passed and the tree is documented.
2. Before starting it, take the atomic dev lock: run `scripts/run-browser-e2e-exclusive.ps1`
   (CreateNew ownership + owner token + PID plus process-start identity + heartbeat,
   `.ai-coordination/playwright.lock`). Never delete or overwrite a live foreign lock;
   handle a stale one only with proof.
3. WHILE THAT RUNNER IS ACTIVE CODEX MUST BE COMPLETELY IDLE: no file edits, no document
   appends, no git writes, no test/build/cargo/npm/vitest/python invocations, no polling of
   the running suite, no progress narration, no new reasoning turns, no subagents. The
   correct behaviour is ONE blocking wait that itself generates no inference turn. If the
   client cannot wait without emitting new reasoning turns, the suite must be run by a
   native foreground runner that returns only after the suite exited, cleanup finished and
   the owned lock was released.
4. Codex may resume analysis, diagnosis or edits only after the runner exits (with its exit
   code captured), upstream requests have drained, owned processes are stopped, and the
   lock was released by its owner. Then read the final artifacts/logs once - no re-polling.
5. A Ruke-only mutex does not govern Codex, and a lock file read by only one client is not
   enough: exclusivity is a PHASE rule (CODE -> TEST -> ANALYZE), not merely a semaphore.
   Never run model-driven Ruke tests while Codex inference is active, and never take a
   Codex inference turn while the Ruke suite owns the endpoint.
6. Live validation is recorded "passed" only for a run that actually executed under this
   lock; otherwise it is "blocked", with the exact human step written down.
