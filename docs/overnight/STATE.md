# Overnight Run State — 2026-11-15 (resumable)

Verbatim brief: `docs/overnight/SPEC.md`. On resume: read STATE → TASKS → DECISIONS → FINDINGS first.

## Current
- Branch: `local` · Starting HEAD: `ec256bd726f5dda15e3af9fc3fa3d3d7fa47e3a6` · uncommitted P1 work preserved (never push/reset/discard).
- Phase: **P1 complete offline except P1.6 (P1.1–P1.4 passed, P1.5 blocked-documented). Next: P1.6 Strata unload/reload probe, then commit P1, then P2 (F16–F19, F01).**
- Playwright lock: NOT present. Live Playwright gate = BLOCKED (Claude Code shares the one-capacity Strata endpoint; D-003/P1.5).

## P1 shipped (uncommitted, gates green)
- Rust: `ruke_core::admission::UpstreamAdmission` (capacity-1 FIFO, max 4 waiters, cancel-safe, WaiterGuard) wired at all six ruke-server loci; `/api/ruke/internal/completion` bridge route (non-stream-only, timeout_ms, honest 503/504/502).
- TS: `lib/server/upstream-bridge.ts` = ONE door; 6 completion + 2 stream sites rewired; LocalUpstreamAdmission mirrors Rust in TS-only mode. Golden header order content-type→authorization→accept byte-locked.
- Gates: typecheck 0 · vitest full 1866/0 fail exit 0 · cargo (core+attach+server) exit 0 all binaries · contracts:check 0 · next build exit 0 (`docs/overnight/logs/next-build-1.log`).
- Lock protocol (`scripts/playwright-lock.psm1` + `-heartbeat.ps1` + launcher + `test-playwright-lock.ps1` 16/16 green): fixed-width 512-byte record; no-FileShare.Delete handle; owner-token release; proof-only stale break. `.ai-coordination/playwright.lock` NOT present right now.

## Gotchas (do not relearn the hard way)
- cargo MUST run from `rust-backend/` with `--target-dir /d/Projects/WebUI/target-ci` (dev supervisor PIDs 6136/8816 lock target/debug; NEVER kill it — no respawn; it may be running the user's dev stack).
- Never `cargo fmt --all`. Background pattern: `nohup bash -c '… > docs/overnight/logs/X.log 2>&1; echo "EXIT=$?" >> …' &` — ensure logs/ exists first.
- vitest mocks settings via `@/lib/server/settings`; bridge imports rustProxy (RUKE_RUST_BACKEND unset in tests → local path — correct).
- PowerShell laws: all four scripts/*.ps1|psm1 need UTF-8 BOM (BOM-less = ANSI mojibake kills string literals); PS 5.1 has NO FileAlreadyExistsException — CreateNew clash = IOException HResult -2147024816; functions returning $true/$false must use Write-Host/Write-Warning (never Write-Output) for info lines; Write-only FileStream throws on .Read(); PID-reuse proof = proc start clearly AFTER lock start.

## Next concrete commands
1. P1.4: harden `scripts/run-browser-e2e-exclusive.ps1` lock (runId/owner/PID/phase/heartbeat; owner-only release in finally; stale = prove PID dead) + tests.
2. P1.6: probe Strata unload/reload support (LLM_UNLOAD_URL/LLM_RELOAD_URL config + actual endpoint behavior) → pass or honest blocked.
3. P2 fixes (F16–F19, F01) per FINDINGS priority; gates after each batch (targeted vitest → full vitest + typecheck; cargo batch at phase end).
4. P3 (F02–F07), P4 (F08–F12,F14,F15,F20,F21), P5–P9 python-backend (`uv`), P10 diff inspection + FINAL-REPORT.md, P11 `shutdown.exe /s /t 0` FINAL, zero questions.
5. Append next-build-1.log result to TEST-RESULTS.md when it exits.

## Report paths
- docs/overnight/{STATE,TASKS,FINDINGS,DECISIONS,TEST-RESULTS,FINAL-REPORT}.md; logs in docs/overnight/logs/.
