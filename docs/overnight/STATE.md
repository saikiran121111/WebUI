# Overnight Run State — 2026-11-15 (resumable)

Verbatim brief: `docs/overnight/SPEC.md`. On resume: read STATE → TASKS → DECISIONS → FINDINGS first.

## Current (USER-REQUESTED CHECKPOINT STOP 2026-11-15 ~11:50 — resume here first)
- Branch: `local` · Starting HEAD: `ec256bd726f5dda15e3af9fc3fa3d3d7fa47e3a6` · uncommitted P1 work preserved (never push/reset/discard).
- Phase: **P1 committed `face1f7`. P2 (F16–F19, F01) in progress: F17 CODE+TESTS COMPLETE and gate-green, checkpoint-committed; F16/F18/F19/F01 still pending.**
- Playwright lock: NOT present. Live Playwright gate = BLOCKED (Claude Code shares the one-capacity Strata endpoint; D-003/P1.5).

## F17 COMPLETE (2026-11-15) — what was done (do NOT re-do, only verify at final gates)
- `lib/stream/thinkTags.ts`: fence-aware `createThinkSplitter` (CommonMark fence subset: ``` / ~~~, ≤3-space indent, info-string-no-backtick rule; fence-candidate lines PARK whole until newline/EOS → chunking invariance; fences also shield tags inside reasoning blocks; nothing ever deleted, flush releases held tail literal).
- `lib/stream/parser.ts`: reasoning fields STRUCTURALLY exclusive per delta — `reasoning_details` text preferred when non-empty, else `reasoning_content`; never string-matching dedupe.
- Rust port `chat/scrubber.rs` `ThinkFieldSplitter` behaviorally identical; FIXED a real bug found in the port: `scan_to_buffer_end` restarted scanning at byte 0 instead of the caller's cursor (re-emitted already-emitted lines when entering mid-line with i>0). Now takes `i`.
- Tests: `__tests__/think-splitter.test.ts` +13 fence cases (mirror of 13 new Rust unit tests; Rust lib scrubber total 24/24); `sse-stage-events.test.ts` +4 reasoning-exclusivity tests; `rust-golden/sse-vectors.test.ts` fixture-02 TEXTS +3 fence texts (`texts[0]` FIRST kept — Rust drift assertion depends on it), harness re-recorded `rust-backend/fixtures/sse/02-think-split-matrix.json` (delete-then-regenerate law for intentional shape changes); `tests/scrubber_vectors.rs` leak assertion now scoped to fence-free texts.
- Gates ACTUALLY RUN: targeted vitest 62/62 · full vitest 1883 pass/0 fail/19 skip · tsc 0 err · Rust `--lib scrubber` 24/24 · `--test scrubber_vectors` 3/3 (target-ci). Details in TEST-RESULTS.md.
- NOT run at stop: full `ruke-server` cargo test suite → first resume action: `cd rust-backend && cargo test -p ruke-server --target-dir /d/Projects/WebUI/target-ci` (plus browser_loop relay tests touch the same splitter).

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

## Next concrete commands (on resume)
1. Close F17: `cd rust-backend && cargo test -p ruke-server --target-dir /d/Projects/WebUI/target-ci` (full suite incl. browser_loop) → append result to TEST-RESULTS.md → mark TASKS P2 F17 item green.
2. P2 fixes (F16, F18, F19, F01) per FINDINGS priority; gates after each batch (targeted vitest → full vitest + typecheck; cargo batch at phase end).
4. P3 (F02–F07), P4 (F08–F12,F14,F15,F20,F21), P5–P9 python-backend (`uv`), P10 diff inspection + FINAL-REPORT.md, P11 `shutdown.exe /s /t 0` FINAL, zero questions.
5. Append next-build-1.log result to TEST-RESULTS.md when it exits.

## Report paths
- docs/overnight/{STATE,TASKS,FINDINGS,DECISIONS,TEST-RESULTS,FINAL-REPORT}.md; logs in docs/overnight/logs/.
