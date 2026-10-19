# Project Instructions — Local AI WebUI

## 1. MANDATORY: Single-Owner Coding and Playwright Coordination

### Purpose

This project uses a shared local inference backend for development and WebUI testing. Concurrent coding-agent activity and Playwright-driven model interactions can create unnecessary inference load, interfere with testing, and make debugging harder.

**The agent MUST treat coding and Playwright testing as mutually exclusive phases.** Only one phase may own the shared inference workload at a time.

### 1.1 Three Exclusive Phases

**PHASE A — CODE**

- Implement the user's requested changes, inspect the repository, and run lightweight checks that do not compete for the shared inference backend.
- Do not launch model-driven Playwright tests concurrently with code generation.
- Before starting a Playwright run, finish the current edit, save the files, and establish a clear test checkpoint.
- Do not start another coding task, delegate overlapping work, or launch another agent that can modify the same files during testing.

**PHASE B — TEST (Playwright has priority)**

Once Playwright testing begins, testing exclusively owns the shared inference workload.

- Stop all code generation, implementation, refactoring, and unrelated investigation.
- Do not edit, create, delete, or format project files while the test run is active.
- Do not submit prompts to Strata through another session, start another model-driven test, or run another task that competes for the same inference backend.
- Do not repeatedly poll screenshots, inspect partial reports, interpret intermediate model responses, or interrupt the test to continue development.
- Run the Playwright command in the foreground and wait for its complete exit status and final results.
- Do not launch Playwright through detached background processes or jobs.
- Do not start another agent or parallel task to continue coding while Playwright is running.
- Do not emit progress messages or initiate new reasoning turns just to check whether the tests have finished.

**The active Playwright run is the only authorized source of test traffic to the WebUI's shared inference backend during this phase.** Its normal browser-to-application model requests must continue working.

**PHASE C — ANALYZE**

Enter this phase only after the Playwright process has exited and its lock has been cleared.

- Read the completed Playwright report, console errors, failed assertions, screenshots, traces, and relevant application logs.
- Distinguish real application defects from test-script failures, timeouts, infrastructure problems, and model-generated content variations.
- Summarize the findings before proposing or making fixes.
- Do not resume coding while another Playwright run is still active.
- When the findings have been analyzed, return to CODE only when the existing user task requires implementation or further debugging. Any subsequent Playwright run starts a new TEST phase.

Never mix these phases.

### 1.2 Playwright Lock Protocol

Use the following lock file to identify an active test session:

`.ai-coordination/playwright.lock`

Before launching Playwright, create the `.ai-coordination` directory and lock file. The test-launching process must remove the lock in a `finally` block after the complete test process exits, including when the test command fails.

If the lock file already exists, assume that another test session owns the shared inference workload.

**When the lock exists, the agent MUST WAIT rather than continue working.**

In Windows PowerShell, execute this as one foreground terminal operation:

```powershell
$lock = ".ai-coordination\playwright.lock"
$deadline = (Get-Date).AddHours(3)

while (Test-Path $lock) {
    if ((Get-Date) -ge $deadline) {
        throw "Timed out waiting for Playwright. Check the test runner before continuing."
    }
    Start-Sleep -Seconds 5
}

Write-Output "Playwright has finished. The lock is cleared."
```

During this wait:

- Do not run other commands in parallel.
- Do not create a background polling task.
- Do not delete an existing lock to bypass the wait.
- Do not resume work merely because no new test output has appeared.
- If the wait times out, stop and ask the user to verify the test runner and lock state. Never assume the tests completed successfully.

The waiting command must remain in the foreground until the lock clears or the timeout occurs. Do not repeatedly terminate and restart the wait command.

### 1.3 Launch Tests Synchronously

Before selecting a test command, inspect `package.json` and the existing Playwright configuration to identify the actual test script. Never assume that a script named `test:e2e` exists.

Use this PowerShell pattern, replacing the example test command with the project's actual command:

```powershell
$ErrorActionPreference = "Stop"

$lockDir = ".ai-coordination"
$lockPath = Join-Path $lockDir "playwright.lock"

New-Item -ItemType Directory -Force -Path $lockDir |
    Out-Null

if (Test-Path $lockPath) {
    throw "Another Playwright session owns the test lock."
}

Set-Content -Path $lockPath `
    -Value "PID=$PID`nStarted=$(Get-Date -Format o)" `
    -Encoding utf8

$testExitCode = 1

try {
    # Replace this with the existing Playwright command.
    npm run test:e2e
    $testExitCode = $LASTEXITCODE
}
finally {
    Remove-Item -Path $lockPath `
        -Force `
        -ErrorAction SilentlyContinue
}

exit $testExitCode
```

Do not run the example command literally unless that script actually exists.

The test process must remain in the foreground. Do not return to code generation while the command is running. Once it exits, preserve the real exit code, collect the complete test results, and proceed to ANALYZE.

If the test launcher is maintained separately from this agent, that launcher must create and clear the same lock file. A lock that another launcher does not create cannot coordinate the agent.

### 1.4 Test Result Integrity

- Do not report a test as passed until the test process has completed and its actual exit status and results are available.
- Do not treat a loading indicator, an incomplete report, or an apparently idle terminal as proof of completion.
- Preserve the existing test output, screenshots, and traces where the project's scripts support them.
- Never modify application code during a test run to make the current test appear successful.
- If a test hangs, wait for the configured timeout or report the verified blocker. Do not silently kill the process and claim success.
- After a failure, analyze the evidence first and make the smallest targeted fix during the next CODE phase.
- Repeat testing only after the prior run has fully stopped and released its lock.

### 1.5 Priority Order

When work overlaps, apply this priority order:

1. An active Playwright run retains exclusive ownership of the shared inference workload.
2. Claude Code waits without coding, launching competing requests, or performing unrelated work.
3. Once the test has completed, Claude Code analyzes the complete results.
4. Required fixes are implemented only after the test phase has ended.
5. A new test run is started only after the next code checkpoint is ready.

These rules take precedence over normal implementation workflow whenever the shared inference backend is involved.

---

## 2. STRICT SKILL MANAGEMENT RULES (MANDATORY)

### 2.1 Two-Tier Skill Architecture

- **User Skills (visible tier):** `./skills/<skill-name>/` and `./skill-scenarios/<skill-name>.json`. Installed through the browser using Skills Modal → `POST /api/skills/install`, or managed through the approved installation workflow.
- **Core Hidden Skills (invisible tier):** `./.cskills/<skill-name>/` and `./.cskills-scenarios/<skill-name>.json`. Installed only by the developer from a terminal using `npm run cskill:add -- <owner/repo> [--skill <name>]`, implemented by `scripts/install-core-skill.mjs`.

### 2.2 Strict Invisibility of Core Skills

Core skills under `./.cskills/` must never be:

- Listed by `GET /api/skills`.
- Displayed in the Skills Modal.
- Offered in `/` slash autocomplete.
- Installed, edited, or deleted through the browser.

Core skills are activated only through the Hybrid Decision Engine (`.decision-engine/` worker and `lib/decision/`). When the LFM2.5-1.2B single-model router determines a `RendererMode`, that mode's `skill_to_load` specifies the appropriate core skill.

The mode-to-skill table is `MODE_MAP` in `.decision-engine/worker/schemas.py`, mirrored by `MODE_SKILL` in `lib/decision/types.ts`.

### 2.3 Mandatory Installation and Routing Rules

1. **Never author or fabricate custom `SKILL.md` files from scratch.** Obtain existing skills through the approved skill installation workflow.
2. **Always use the approved installation process.** Use `npx -y skills add <owner/repo> --skill <skill-name>` (or the repository-level equivalent) through the user-skill installer or `npm run cskill:add` for core skills. The installer service must reject attempts to access `./.cskills/`.
3. **Never modify a downloaded `SKILL.md`** unless the user explicitly says: "change the implementation of the existing skill [skill-name]".
4. Routing logic belongs exclusively in `./skill-scenarios/<skill-name>.json` for user skills and `./.cskills-scenarios/<skill-name>.json` for core skills. Never embed routing logic in a skill's `SKILL.md`, prompts, or UI components.
5. **Strict lazy loading is mandatory.** A skill body must not be injected into the system prompt unless the user invokes a user skill through `/<skill-name>`, or the configured `autoUse: true` and non-empty `whenToUse` conditions match the user's request.

Core skills are loaded only when the Hybrid Decision Engine's `active_mode` maps to them through `skill_to_load`. The loader is `lib/decision/skill-loader.ts`, which injects a single `<decision_skill>` block. Core skills must not gain slash commands.

On turns where no skill applies, skill bodies must consume zero prompt tokens.

### 2.4 Skill Directory Layout

- `./skills/<skill-name>/` — downloaded user skills containing their original `SKILL.md` and reference files.
- `./skill-scenarios/<skill-name>.json` — user-skill routing metadata.
- `./.cskills/<skill-name>/` — downloaded core skills and their reference files; never browser-visible.
- `./.cskills-scenarios/<skill-name>.json` — core-skill metadata, maintained by `scripts/install-core-skill.mjs`.

Scenario metadata follows the established shape:

`{ skillName, sourceRepo, enabled, autoUse, whenToUse, triggerKeywords, blockedReason }`

For core skills, runtime activation is controlled by the Hybrid Decision Engine's mode-to-skill mapping, not legacy keyword-based routing. The legacy `lib/skills/coreRouter.ts` keyword router was removed on 2026-10-18.

Re-indexing must never overwrite an existing scenario file. New installations must create a missing scenario with `autoUse: false` and `whenToUse: ""`.

---

## 3. General Project Safety and Change Management

- Inspect existing implementations before changing them. Prefer targeted fixes over broad rewrites.
- Preserve existing features, APIs, architecture, UI behavior, and runtime integrations unless the user explicitly requests changes.
- Do not invent repository files, scripts, commands, environment variables, or test results. Verify them first.
- Use the project's existing Windows-compatible development and testing workflows.
- Avoid unnecessary dependencies, unnecessary background processes, and duplicated model requests.
- Do not run multiple agents against the same files concurrently unless their work is demonstrably isolated.
- Do not claim that a change or test succeeded without inspecting the actual result.
- Report the files changed, the reason for each change, the tests actually executed, and any remaining failures or limitations.
- For tasks involving the shared inference backend, always follow Section 1 before using other workflows.

## 4. Required Completion Report

At the end of an implementation and testing cycle, report:

1. **Changes made:** A concise description of the relevant implementation changes.
2. **Playwright results:** The actual test command, pass/fail counts when available, and the real process exit status.
3. **Failures:** A short summary of reproducible errors and their evidence.
4. **Remaining work:** Any unverified behavior, infrastructure issues, or unresolved failures.

Never mark an incomplete or interrupted test run as successful.