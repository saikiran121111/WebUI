---
name: ruke-qa
description: Use whenever deciding which Ruke test or command to run, validating a fix, planning a manual check, or recording a reproducible issue. Includes Vitest, Rust, Python and exclusive browser runs.
---

Read testing/ISSUES.md, then search docs/overnight/FINDINGS.md by component or ID. Reuse the original issue and link evidence. Use disposable fixture data for persistence tests.

| Change | First check |
| --- | --- |
| TS logic or renderer | From root run `npm test -- <affected.test.ts>`. For changed interfaces run `npx --no-install tsc --noEmit --incremental false`. |
| Rust | From rust-backend run `cargo test -p <actual-crate> <test-filter>`. Check the result includes the intended tests. Format only touched code. |
| Python worker | From python-backend run `.\.venv\Scripts\python.exe -m unittest tests.<module> -v`. Check resource refusal and cancellation as relevant. |
| Cross-runtime contract | Run relevant producer and consumer tests and __tests__/rust-golden vectors. Run `npm run contracts:check` for generated contracts. Broaden to affected suites for runtime changes. |
| UI or final live journey | From PowerShell at root run `.\scripts\run-browser-e2e-exclusive.ps1 -TestFiles 'tests/<affected>.spec.ts'` in foreground. Check the launcher and active brief for prerequisites. It owns the lock and cleanup. |

For manual inspection exercise the changed user journey and one likely failure. For streaming observe submitted, first visible content, progress, abort, error, completion and reload as relevant. For search/browser check denial, timeout and cleanup. For lifecycle inspect concurrent admission, release, peak memory and post-restore continuation using permitted fixtures or an attended live gate. Exercise Windows paths and platform-specific behavior where the change reaches them.

Record reproducible failures, severity, component, steps, evidence, status and fix verification. Mark a blocked live check as unverified. Report the commands and actual exit results. Keep earlier baselines dated. Run wider suites at a milestone when the affected surface justifies them.
