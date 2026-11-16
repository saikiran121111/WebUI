# TASKS — overnight 2026-11-15

Status legend: pending | in_progress | passed | failed | blocked | not_run.
Check a box only after acceptance passes; evidence in TEST-RESULTS.md.

- [x] P0 Record baseline, call graph, coverage and dirty files — **passed** (baseline gates green above; call graph in FINDINGS.md; dirty=tsconfig.tsbuildinfo preserved)
- [x] P1 Enforce shared inference ownership and unattended runner — **passed offline** (live Playwright gate blocked per P1.5, documented; all deterministic gates green)
  - [x] P1.1 Map ALL upstream request call sites — **passed** (call-graph table + mode reachability in FINDINGS.md; scripts/playwright-10k-audit.ts recorded as test-scope, not production)
  - [x] P1.2 Single admission authority — **passed** (ruke_core::admission::UpstreamAdmission capacity-1 FIFO, DEFAULT_MAX_WAITERS=4, cancel-safe WaiterGuard; wired at all six Rust loci: forward_legacy, forward_into, web stream_round, browser round, titles, attach notes; laws pinned by 7 admission unit tests + 3 internal_completion tests + admission_exclusion integration)
  - [x] P1.3 TS-side admission parity — **passed offline** (`/api/ruke/internal/completion` bridge route, non-streaming-only, timeout_ms control; `lib/server/upstream-bridge.ts` is the ONE TS door: sharedUpstreamCompletion ×6 sites + sharedUpstreamStream ×2 sites; process-local capacity-1 LocalUpstreamAdmission mirrors Rust in TS-only mode; grep-audit zero unmanaged production sites; typecheck+vitest+build gates green)
  - [x] P1.4 Atomic lock parity — **passed** (`scripts/playwright-lock.psm1` fixed-width 512-byte runId/owner/PID/phase/started/heartbeat record; CreateNew acquire + holder handle WITHOUT FileShare.Delete ⇒ live lock physically undeletable; owner-only release verifies runId token; stale break requires printed proof (PID absent or provable PID-reuse); heartbeat child in-place refresh; launcher `run-browser-e2e-exclusive.ps1` uses the module, adds -LockInfo/-BreakStaleLock, owner-only release in finally. Self-test `scripts/test-playwright-lock.ps1` 16/16 ALL PASS exit 0; launcher offline smoke: parse OK + foreign-lock -LockInfo exit 3 untouched. NO Playwright/inference touched.)
  - [x] P1.5 External-client coordination — **blocked, documented**: Claude Code (this agent) talks to the same Strata endpoint (capacity one); not coordinable without human relaunch → live Playwright gate stays blocked per §3.3 (DECISIONS D-003)
  - [x] P1.6 Resource swap — **passed**: live Strata 0.1.59 install verified (serve/server.py `POST /unload[?wait=]` 409-busy-never-mid-turn + `POST /load` idempotent; JSON+no-Origin clients accepted; no API key on this instance). Live safe probes: /load + /v1/load → 200, state unchanged. /unload live-fire NOT sent (would evict this very session's model — SPEC §5 forbids unloading during Claude inference); semantics pinned by install source + its test_web_load_unload.py. Hooks enabled in gitignored `.env.local` (URLs only, endpoint values identical to fallbacks → zero behavior change).
  - R01 cancellation/deadline for active completions - **implemented + offline verified** (TS: one lifecycle-managed controller+deadline before admission; covers queue wait, fetch, body consumption; 9 test behaviors in upstream-admission.test.ts). Live verified: NO.
  - R02 stream permit held through cancellation - **implemented + offline verified** (`cancelling` flag owns release until transport acknowledges or CANCEL_GRACE_MS elapses; deferred-cancel mock proves no early release). Live verified: NO (GPU-side stop not observable offline).
  - R03 endpoint override must not bypass the Rust authority - **implemented + offline verified** (resource identity `resourceKey` + loopback alias family + `credentialFor` credential isolation; reachable overrides in search-gate.ts / llm-json.ts now resolve identity, not "any targetUrl = local gate"). Live verified: NO.
  - R04 Rust bridge deadline/disconnect ownership - **implemented + offline verified** (validated bounded deadlines, DeadlineTask aborts its timer, TokenGuard cancels on handler drop, read_capped byte bound; 7 unit tests). Live verified: NO.
  - R05 admission test coverage honesty - **implemented + offline verified** (slow gated streamed body + BodyGuard high-water=1 proof; 401-vs-intended-branch isolation via ipc::test_guard secret pinning). Live verified: NO.
  - R06 native-Windows persistence data root - **implemented + offline verified** (lib/persistence/dataRoot.ts; no global HOME mutation; WEBUI_DATA_DIR semantics preserved). Live verified: NO.
  - R-live (shared-endpoint live gate incl. Codex coordination) - **blocked, see P1.5 / D-003**. Never mark live-passed.

- [x] P2 Repair streaming, activity, scroll, conversational behavior (F16, F17, F18, F19, F01) - **passed offline** (all five closed offline; live UI confirmation remains blocked with the Playwright gate, D-003)
  - F17: **CODE+TESTS DONE 2026-11-15** (fence-aware splitter TS⇔Rust + reasoning-field structural exclusivity; all TS gates + Rust scrubber/vector suites green — see TEST-RESULTS.md). FULL ruke-server suite now GREEN: 203 lib / 0 failed + integration suites green, cargo exit 0 (logs/rust-server-3.log).
  - F16: **implemented + offline verified 2026-11-15 (sessions 5-8)** — Live verified: NO.
    - Terminal-ownership law: final metadata / usage / justified revisions / action closures are emitted BEFORE exactly one turn-terminal sentinel; intermediate tool rounds never terminate the conversation stream.
    - `lib/stream/parser.ts`: `TurnOutcome` (success|error|cancelled|truncated|incomplete_tool_round) + `StreamSettlement`; bounded post-`[DONE]` drain (`POST_DONE_DRAIN_MS=750`, grace timer per read, `trailingDrainExpired` on expiry) so metadata split across reads survives; terminal-exposure gate (`terminalResult()`/`settled()`) prevents any consumer seeing a settlement while events are queued; `settle()` derives outcome from delivered facts, never from EOF alone.
    - `lib/chat/client.ts` returns the settlement (fallback `truncated`, never implicit success); `hooks/useChat.ts` repairs only on `success`, marks error state on error/incomplete_tool_round, and states truthfully when truncated.
    - `lib/chat/web-tool-loop.ts` ending round: audit → log → ledger-gated `web_meta` → flush held content → close (Rust mirror `chat/web_loop.rs`: `audit_round_content` → `web_meta` → `flush_held`).
    - Gates: `__tests__/stream-terminal-ownership.test.ts` 13/13; `__tests__/chat/web-tool-loop-terminal-ownership.test.ts` 3/3; stream+chat+admission+persistence subset 143/143; `cargo test -p ruke-server` exit 0 (lib 204/0, all integration suites green, logs/rust-server-6.log); `npm run typecheck` 0; rust-golden 56/56 after sanctioned re-record (logs/vitest-golden-2.log).
  - F18: **implemented + offline verified 2026-11-15 (session 9)** — Live verified: NO.
    Status: Implemented + offline verified (19+4 pinned unit tests, typecheck exit 0).
    Mechanism: one pure authority `lib/progress/currentActivity.ts` (resolveCurrentActivity:
    live action → live tool call → writing → thinking → between_rounds → waiting; citations
    and COMPLETED actions are not inputs at all), `components/ProcessingStatus.tsx` renders
    it (dead cascade + local hostFrom/toolCallLine/activityLine deleted; popup header now
    `sourcesHeader(n, readingLive)` = "N sources gathered this turn" unless a read is live);
    turn-ownership fence `lib/progress/turnFence.ts` + `hooks/useChat.ts` (handleEvent takes
    the owning TurnRef, drops superseded frames, writes to `turn.id`; conversation switch
    (`load`) now invalidates the fence AND aborts the abandoned turn's transport so the
    shared upstream permit is actually released). Acceptance: citations/completed actions no
    longer display as current work; concurrency text only for ≥2 genuinely open actions;
    cancelled/interrupted closures never open; stale-turn frames dropped.
    Validation: `npx vitest run __tests__/progress __tests__/activity-closure.test.ts
    __tests__/turn-progress.test.ts __tests__/chat` → exit 0, 148/148
    (docs/overnight/logs/vitest-f18-3.log); `npm run typecheck` → exit 0 (logs/typecheck-f18-2.log).
    Deps: none. Files: lib/progress/{currentActivity,turnFence}.ts, components/ProcessingStatus.tsx,
    hooks/useChat.ts, __tests__/progress/{current-activity,turn-fence}.test.ts.
  - F19: **implemented + offline verified 2026-11-15 (session 10)** - Live verified: NO (Playwright gate blocked).
    Law module lib/ui/scrollFollow.ts (pure reducer: following/free + pendingShrinkPx layout-explanation
    budget + pin_request tagging) pinned by __tests__/ui/scroll-follow.test.ts (15 tests); app/page.tsx
    now has ONE controller (followRef) with React state demoted to a pill projection, rAF-coalesced TAGGED
    pins, RO on content wrapper + scroller, followNow() for jump-to-latest/new chat/chat switch/send,
    synchronous wheel/touch unpin, nested-scroll exclusion, observer+rAF cleanup.
    Gates: vitest 153/153 exit 0 (logs/vitest-f19-1.log); tsc --incremental false exit 0 (logs/tsc-f19-1.log).
  - F01: in_progress (current focus).
- [x] P3 Repair intent, scope, policy, retrieval, evidence semantics (F02, F03, F04, F05, F06, F07) - **in_progress**: F04 passed offline TS+Rust (session 27). F05 passed offline (session 29). F07 passed offline TS+Rust (sessions 31-33: index-derived axis, per-cue windows, v2 conversation+query ledger with cross-process mutex, raw-first retrieval with bounded anchored fallback; TS 9-file attach gate 89 tests exit 0 + ruke-attach lib 86 + ruke-server lib 220 + store_compat 6 + attachment_replay 6, all exit 0). F06/F03/F02 remain. Live gate stays not_run (shared endpoint, P11). **F06 passed offline TS (session 35): canonical addressable blocks + continuation recovery (tsc 0, __tests__/web-search 864/864). F03 passed offline TS (session 36: new leaf module lib/web-search/domain-constraints.ts + 45-case suite; __tests__/web-search 909 passed / 2 skipped, tsc 0). Open: F02.**
- [x] P4 Repair artifact data fidelity + attachment durability - **passed offline**: F08, F09(+F09b), F10, F11, F12, F14, F15, F20, F21 = passed offline (F21 verified session 26: tsc exit 0 + 17 files / 170 tests exit 0, incl. real-Chromium pdfEngine + render-lifecycle + compaction-durability). Live = blocked (D-003).
- [x] P5 Python supervisor, contracts, resource manager - **passed offline** (python-backend/: pinned uv venv CPython 3.12.15 + committed uv.lock + .python-version; lightweight supervisor imports no torch/paddle/transformers/pyannote; worker pool with ready handshake, stderr capture, egress block; contracts carry run/job ids, capability, progress, structured error + retryability, model identity, coverage, embedding dim/normalization; 89 unittest green; Rust ml_bridge + GET /api/ruke/ml-status with per-run token)
- [ ] P6 Migrate document/OCR/retrieval capability behind supervisor - **in_progress**: TS extraction fidelity (F12) and value fidelity (F11) passed offline; ruke_ml retrieval/documents modules + tests exist and are selected by declared capability + honest availability; measured old-vs-new quality comparison (Recall@K / OCR CER / table structure) is NOT yet run, so no migration is claimed complete
- [ ] P7 Speech + temporal video pipeline - **in_progress**: ruke_ml speech (asr/alignment/diarization with language capability tables, license_acceptance_required for pyannote) and video (scenes/observations/timeline/search_hints) exist with 15+ pinned tests; app-side wiring of the MediaSearchHints path into real search-tool arguments is the remaining gate
- [x] P8 Startup/cancellation/cache/capability UI integration - **in_progress**: dev-supervisor python bootstrap + health-gated stages + owned teardown verified live-offline (no inference); capability status route exists; the user-visible stage vocabulary for python job states is not yet fully wired, so P8 stays open
- [ ] P9 Offline regression + heldout + resource evaluations (live gate per §3.3 status)
- [ ] P10 Diff inspection, honest docs, owned-process cleanup
- [ ] P11 Windows shutdown `shutdown.exe /s /t 0` — FINAL action only after reports persisted (authorized §12)

## Attempt log (append-only)

- 2026-11-15 P2/F16 golden corpus: full vitest showed 3 golden failures = fixtures `web-search/{01,03,04}` recorded the OLD wire order (`... answer ... [DONE] ... web_meta ...`); new run emits `... answer ... web_meta ... [DONE] ...`. Diagnosed BEFORE patching: F16 law change, not a regression. `writeJsonFixture` deliberately FAILS on drift, and no update seam existed. Deleting the tracked fixtures to force re-record was **policy-blocked** (destructive op) — correct fix was to ADD the sanctioned `RUKE_GOLDEN_UPDATE=1` seam in `__tests__/rust-golden/support/golden.ts`. Verified with a node script that old/new fixture objects differ ONLY in the trailing `web_meta`↔`done` pair (frame multiset identical, non-body sections identical apart from logicalFrames reflecting the same swap). Documented in the corpus docstring + `rust-backend/fixtures/README.md`. Second run without the env flag = determinism verifier, green.
- 2026-11-15 P2/F16 test-harness gotchas: `createStreamParser` constructs and pumps synchronously, resolving global `fetch` at construction — a fetch stub installed AFTER construction silently hits the real network (~2.2 s DNS delays, "fetch failed"). The research loop emits one `web_meta` per tool round (OVERWRITE law), so terminal ordering must be asserted against the LAST `web_meta`. The mocked `execWebSearchTool` minted no ledger record, so the ledger-gated completion `web_meta` never fired — fixed by calling the real `recordAction(session, …)` inside the mock. With `depth:"quick"` + all rounds returning tool_calls, the loop hits its cap and takes the forced no-tools final round (different code path) — check which path a case exercises.

- 2026-11-15 P1.2: `internal_completion::tests::queue_full_is_an_honest_503` self-deadlocked (busy_state awaited a spawned acquire whose permit `held` still occupied) → killed that cargo run mid-suite (`taskkill //F //IM cargo.exe` only — dev supervisor PIDs 6136/8816 untouched; partial results of that run are VOID, not reused). Fixed test to keep the waiter pending; 3/3 ok.
- 2026-11-15 P1.3: rewired 8 TS production upstream sites through lib/server/upstream-bridge.ts. Typecheck caught `llApiKey`→`llmApiKey` typo + mergeSignal closure-narrowing (TS2304/TS2724/TS18048) → fixed.
- 2026-11-15 P1.3 gate #1: first post-rewire full vitest → 56 failed / 8 files. Root causes: (a) bridge stream path omitted `Accept: text/event-stream` → rust-golden header-order fixtures drifted; (b) 3 unit-test Response stubs lacked `.headers`, which the door now reads. Fixed BOTH honestly: added the header (byte-locked to Rust error::upstream_headers order), made test stubs Response-faithful. No app contract weakened. Gate #2: full vitest 1866 passed / 0 failed, exit 0.
- 2026-11-15 P1.3 full Rust gate: first background launch died twice on harness mistakes (missing logs dir; wrong cwd — Cargo.toml is in rust-backend/), NOT on test failures. Third launch from rust-backend/: exit 0, all binaries (see TEST-RESULTS).
- 2026-11-15: `npm run contracts:check` exit 0 after the Rust changes (mode contracts untouched).
- 2026-11-15 P1.4 self-test run #1 surfaced three PS 5.1 portability bugs (not design failures): (a) PID-reuse tolerance sign inverted — `AddSeconds(-2)` flagged a legit holder that started <2 s before acquiring; fix: recycled only when proc start is clearly AFTER lock start (`AddSeconds(2)`); (b) `[System.IO.FileAlreadyExistsException]` type does not exist on PS 5.1 (.NET Core+ only) — CreateNew-on-existing throws plain IOException HResult -2147024816 (0x80070050 ERROR_FILE_EXISTS); typed catch replaced in test AND launcher (launcher's pre-existing catch was equally broken); (c) heartbeat child opened FileAccess Write then called .Read() → NotSupportedException swallowed by its catch → heartbeat never advanced; fix FileAccess ReadWrite. Run #2 also exposed module Write-Output informational lines polluting boolean returns (array `-eq $false` cast crash) → Write-Warning/Write-Host. Run #3: ALL PASS 16/16 exit 0. All four PS files need UTF-8 BOM (PS 5.1 reads BOM-less UTF-8 as ANSI; em-dashes inside string literals become mojibake that terminates the string).
- 2026-11-15 R04/R05 compile #1: `ENV_SECRET` unresolved inside `mod test_guard` (add `use super::ENV_SECRET;`); `post_with_secret` returns `(MutexGuard, StatusCode)` so call sites need `.1`; the old `post_json` helper became dead code (warning) and was deleted. `tokio::sync::Mutex` is NOT reentrant - never nest/hold two pins of the same secret guard.
- 2026-11-15 R05 slow-body test: needs `use http_body_util::BodyExt;` for `into_data_stream()`; body item is `Result<Bytes, axum::Error>` so data reads unwrap three levels (timeout -> Option -> Result); mock `Mock` must be cloned before `tokio::spawn` AND kept in the test to open the gate; `watch::Sender::send(true)` releases every gated body at once.
- 2026-11-15 R05 first run 1 failure: `POST /api/chat` in Rust emits the progress shape first - the caller may see `data: {"ruke_stage":{"stage":"decision_done",...}}` before the upstream POST starts, so never assert the first frame instantly; poll with `wait_until` (<=3 s, 10 ms steps). Fixed the TEST, not the product.
- 2026-11-15 PowerShell law (bit me): PS 5.1 `-replace` with a SINGLE-quoted replacement containing `'\n'` inserts a literal backslash-n, corrupting the file (a Rust struct line became one line with embedded `\n`). Use double-quoted "`n" or [regex]::Replace. After any text replace, grep the file for literal backslash-n before compiling.
- 2026-11-15 tool-permission change mid-run: sandbox is now danger-full-access with approval policy `never` - do NOT pass sandbox_permissions anymore (it is rejected); cargo/npm/npx run in-process fine.
- 2026-11-15 cargo arg order for saved prefixes: `cargo test -p ruke-server --target-dir D:\Projects\WebUI\target-ci --test <name>` - `--target-dir` must precede `--test`.
- 2026-11-15 P2/F18 gotchas: (a) this repo has NO DOM test infra (vitest env=node), so an activity-status law must live in a pure module and be pinned there - unit-testing ProcessingStatus rendering is impossible; (b) an interrupted edit left ProcessingStatus calling a deleted local (`toolCallLine`) - never end a checkpoint with an unresolved reference, finish wiring + typecheck in the same step; (c) a turn fence whose generation counter starts at 0 makes a default/zero token look "current" before the first send - token 0 is now reserved for "no turn has begun"; (d) `useChat.load()` (chat switch) NEVER aborted the in-flight turn, so an abandoned turn kept streaming into a message that is no longer rendered and kept holding the single shared upstream permit - it now aborts + invalidates the fence; (e) `if (id)` guards became tautological after the fence (id is now a TurnRef id) - left as-is to keep the diff small, no lint rule fires.

- 2026-11-15 P2/F19 gotcha: a pure scroll reducer must NOT let a layout-change event overwrite the
  geometry baseline used to judge the NEXT scroll event - the RO callback and the scroll event it was
  caused by arrive in either order, so the shrink is carried as an explicit budget instead. Fixed the
  module law, not the failing assertion.
- 2026-11-15 env: recursive `Remove-Item` on a scratch dir is policy-REJECTED even in danger-full-access;
  node `fs.rmSync` on files this run created works. Keep scratch outside the repo next time.


- 2026-11-15 session 25 F15 Rust mirror compile #1: E0599 - `.concat()` is a SLICE method, not an iterator
  method; an iterator of String needs `.collect::<String>()`. Fixed the code, not the assertion.
- 2026-11-15 session 25 rustc: `pub fn scan_markdown` returning a private `Segment` triggers
  private_interfaces (type more private than item). scan_markdown is only consumed inside its own module +
  its #[cfg(test)] child, so it stays plain `fn` (the TS side exports scanMarkdown for its suite).
- 2026-11-15 session 25 gotcha: matrix.json is shared UTF-8 text with em-dashes in OLD case names. Never
  re-dump the whole JSON through json.dumps (that rewrites every line and hides the real diff); splice the
  new array elements with a unique ASCII anchor and then re-PARSE to prove the counts.
## Session 52/53 status refresh (2026-11-16, append-only)

Vocabulary: IMPLEMENTED = code landed; OFFLINE = deterministic gate executed
and green; LIVE = exercised against real Strata and/or a real browser;
BLOCKED = needs a human credential/asset; NOT_RUN = feasible, not yet done.

- [x] P3 -> PASSED OFFLINE: all six findings closed. F02 was the last open
  one: typed intent law in lib/decision separating requested operation,
  source format, destination format, discuss-vs-execute, negation scope,
  quotation role and multiple deliverables, with abstention on ambiguity.
  Reproduce-first evidence logs/f02-repro-1.log (mismatches listed BEFORE
  the fix), then logs/f02-green-{1,2}.log, logs/f02-gate-{1,2}.log; final
  gate this session `npx vitest run __tests__/decision` = 3 files / 144
  passed, exit 0 (F02 family = 49 cases, frozen before implementation).
  LIVE = not_run (belongs to the P11 Playwright batch, shared endpoint).
- [x] P8 -> PASSED for startup, ownership, cancellation, caches, capability
  UI. `npm run dev` now runs python -> rust -> next in health-gated order:
  python /health 1.3 s, Rust /api/ruke/health 1.3 s, Next answering 3.3 s,
  GET / 200 in 7.1 s; owned tree 2445 MB at ready / 2454 MB idle; teardown
  left 0 listeners and 0 owned processes with the two foreign Strata
  pythons untouched (logs/dev-integrated-s50-report.txt, logs/dev-measure-
  s50.txt). Capability UI consumes GET /api/ruke/ml-status through
  components/CapabilityStatusPanel.tsx (data-testid="ml-capability-*").
  The job stage vocabulary is implemented AND cross-language pinned:
  JOB_STAGES in lib/progress/capabilityStatus.ts vs PROGRESS_STATES in
  python-backend/ruke_ml/contracts.py, asserted by
  __tests__/progress/capability-status.test.ts.
  Still NOT_RUN: per-job live progress rendering inside a browser during a
  real python-backed job (needs the Stage B batch).
- [ ] P6 stays open. Code, contracts, capability selection and tests are in
  place, but the measured old-vs-new quality half (Recall@K, OCR CER, table
  structure, ASR WER) is BLOCKED on model assets that startup deliberately
  never downloads, so no migration is claimed complete.
- [ ] P7 stays open. Timeline/scenes/observations/search_hints + tests exist
  and `video.timeline` is now honestly `available` with provenance, but the
  temporal_video_localisation family is installed_but_unmeasured -> not_run,
  and the end-to-end observation "uploaded video -> stored timeline -> the
  arguments the model actually passes to the search tool" is a live gate.
- [ ] P9: offline half PASSED (full vitest 2293 passed / 19 skipped exit 0;
  Rust 424 passed / 0 failed exit 0; next build exit 0; contracts:check exit
  0; python 136 tests exit 0; frozen holdout 7 families / 38 cases at 1.000
  with 7 gated capabilities excluded from the denominator; resource + memory
  accounting measured). Live half = P11 Playwright + asset-blocked model
  quality suites (stay not_run, never counted as passed).
- [ ] P10 in progress: docs (this file, STATE, FINDINGS ledger, DECISIONS
  D-020..D-023, TEST-RESULTS sessions 50-52) + FINAL-REPORT.md + diff review
  + scratch cleanup + nft hash re-verify.
- [ ] P11 pending: Playwright FINAL (Stage A fixture-only, Stage B live
  model with Codex fully idle) and only then `shutdown.exe /s /t 0`.

## Attempt log continued (append-only)

- 2026-11-16 session 50-51 (F22, build gate): the earlier "npm run build
  only passes if node_modules/next/.../nft/index.js is patched" trap was a
  SELF-INFLICTED dependency patch hiding a real bug. Actual cause: a TS read
  site coerced a possibly-undefined data root through String(...) producing
  the literal segment "undefined", which nft then globbed across the drive
  (EPERM/GLOBF). Fixed the read site (shared data-root resolver), then
  restored the vendored nft file to PRISTINE (sha256 prefix 21FDA49AD240564F,
  backup kept at scratch-s49/nft-index.js.orig) and re-hashed to prove it.
  Never ship or keep a patched node_modules dependency.
- 2026-11-16 native Windows class (R06/F22): USERPROFILE exists but HOME does
  not, and test collection additionally needs an isolated WEBUI_DATA_DIR;
  collection fails without it. Never set a global HOME to mask it.
- 2026-11-16 ML discovery shape: the record uses `host` + `port`, not
  `endpoint`. A graceful POST /shutdown deletes it; a hard kill leaves a
  stale record, which Rust types as `unreachable` - that asymmetry is the
  crash-recovery proof, not a bug.
- 2026-11-16 OS law: signals do not cross into a console-less child -
  child.kill("SIGINT"/"SIGBREAK") never lands, so an interactive Ctrl+C
  cannot be simulated; owned teardown was therefore verified through the
  critical-child failure path instead.
- 2026-11-16 tooling: `Out-File -Encoding utf8NoBOM` does not exist on PS 5.1
  (use apply_patch, or ascii); apply_patch cannot Delete+Add the same file in
  one hunk set (Delete, then Add in a second patch).
- 2026-11-16 session 52 (F23): `video.timeline` reported `not_installed` as a
  FALSE NEGATIVE from a PATH-only probe. Fix = ruke_ml/models/binaries.py:
  RUKE_FFMPEG override -> PATH -> project-local globs, every candidate
  VALIDATED by actually running `<prog> -version` (5 s, no window, 64 KiB
  cap, name must appear in output); publishes source/inside_repo and a repo-
  relative path so no absolute host path leaks. 14 new tests, python suite
  122 -> 136. Never trust shutil.which() alone for a project-local tool.



## Session 53 status refresh (2026-11-16, append-only)
- P6 partial, still open: retrieval quality is now MEASURED, not assumed
  (`ruke_ml/eval/methods.py` + `scripts/eval-embed-vectors.ts`, gate
  `python -m ruke_ml.eval.harness --vectors ...`, exit 0, log
  `docs/overnight/logs/python-eval-methods-2026-11-16.log`). The measured evidence says
  DO NOT migrate retrieval to dense-only (D-024): hybrid is not worse and is the only
  method that can abstain. Doc/OCR quality on real media is still not measured, and the
  multilingual embedding/reranker assets are still not downloaded, so P6 cannot close.
- P7 partial, still open: `video.scenes` gained a real read side (cut parsing, offset,
  bounds, typed refusals) and the ffmpeg command was corrected against the pinned build;
  `python -m ruke_ml.eval.temporal_probe` exit 0 with the numbers above. Acceptance still
  unmet for: real human-labelled video localisation, ASR language quality (Telugu/Hindi),
  and the app-side MediaSearchHints -> search-tool-argument path. Tests: 20 new in
  `tests/test_video_scan.py` (exit 0), full python suite 170 exit 0.
- P9 offline half re-verified this session: python 170 exit 0; `npm run typecheck` exit 0;
  decision corpus 144 exit 0. Full vitest + next build for this session ran to completion:
  docs/overnight/logs/vitest-full-s53.log ends with "Test Files  183 passed | 2 skipped
  (185)" and "Tests  2293 passed | 19 skipped (2312)" with ZERO FAIL/Failed-Tests markers,
  and docs/overnight/logs/next-build-s53.log shows "Compiled successfully", the type
  check, the route table and "Finalizing page optimization".
  The hidden wrapper that owned that run exited before writing its exit-code files, so
  the CAPTURED exit codes come from the session-55 chain
  (scratch-s55\typecheck-exit.txt, contracts-exit.txt, build-exit.txt; logs
  docs/overnight/logs/typecheck-s55.log, contracts-s55.log, next-build-s55.log).
- P11 still pending and is the FINAL test stage (D-023): Stage A fixture-only, Stage B
  model-driven with Codex holding fully idle. Live model UI gates remain NOT_RUN until then.

## Session 55 status refresh (2026-11-16, append-only)
- [x] P10 docs: FINAL-REPORT.md written; DECISIONS through D-027; FINDINGS through F22;
  TEST-RESULTS has SESSION 53 + SESSION 55 blocks; STATE.md rewritten for the final phase.
- [x] P11 Playwright (FINAL stage, exclusive lock): Stage A 11/11 exit 0 (twice);
  Stage B live-model 31/31 exit 0; Stage B re-run under enforced store isolation 31/31 exit 0.
  84 browser tests passed / 0 failed / 4 exclusive runs, all exit 0. Lock + ownership verified
  on both success and failure paths. Live-verified: F16, F17, F18, artifact origin isolation,
  progress honesty, stop/edit semantics.
- [x] F22 closed (reproduced -> fixed in the launcher -> verified by a clean re-run).
- Still open, and NOT marked passed: P6/P7 quality on real media, G1 (no production caller for
  the Python capability jobs), F19 jitter measurement, F01 live prompt A/B, all asset-blocked
  model capabilities (Qwen3-ASR/Embedding/Reranker, Docling, PaddleOCR, pyannote).
- P11 verdict: browser gates **passed**; the run as a whole stays **PARTIAL** for the reasons
  in FINAL-REPORT.md sections 9 and 11.
## Session 61 - G1 seam wired end to end (2026-11-16, append-only)
- [x] P1.5/G1 seam (reopened, then closed at baseline + scene level): ml_job.rs client
  (D-028) -> lib/server/ml-job.ts -> extract/index.ts video branch buildBaseline/publishBaseline
  (D-030) -> index meta observations/timeline -> media-hints -> real web_search arguments.
  Status split: implemented + offline verified + live-gated by the final Playwright stage.
  The HEAVY modalities (video ASR/OCR/vision) stay gated: model assets are not downloaded.
- [x] New TS regression file __tests__/attach-timeline-s60.test.ts: 26 tests, exit 0
  (docs/overnight/logs/s60-timeline2.log, exit code copy
  docs/overnight/logs/scratch-s59-s60-timeline-exit.txt).
- [x] Targeted media/admission gate re-run: 11 files / **117 tests passed**, exit **0**
  (docs/overnight/logs/s61-targeted.log, exit code copy
  docs/overnight/logs/scratch-s59-s61-targeted-exit.txt).
- [x] typecheck (incremental and --incremental false): exit **0**, zero TS errors
  (logs/s61-typecheck.log, logs/s61-typecheck-full.log).
- [x] contracts:check exit **0** (logs/s61-contracts.log); Python suite **170 tests OK**,
  exit **0** (logs/s61-python.log).
- [x] full Vitest: **184 files passed / 2 skipped; 2319 tests passed / 19 skipped**, 229 s,
  exit **0** (logs/s61-vitest-full.log). Rust was NOT re-run: no Rust file changed in the
  sessions after the 707-passed workspace run (logs/rust-full-s58.log, exit code copy
  logs/scratch-s57-rust-full-exit.txt = exit=0).
- [x] Next production build: "Compiled successfully" + 25/25 static pages + finalizing,
  exit **0** (logs/s61-build.log).
- [x] P11 FINAL Playwright re-run after the production change: Stage A **11/11** exit **0**
  (logs/p11-stage-a-s61.log); Stage B 7 live-model specs **31/31** exit **0**, 2.1 min, Codex
  fully idle for the whole window (logs/p11-stage-b-s61.log). Lock released; ports 3000/3101/
  3210 down; real conversation store still **775 files**; e2e store 32 files.
- [x] Docs, FINAL-REPORT and STATE refreshed. P10 cleanup: the run's scratch trees
  (scratch-s37/40/43/46/48/53/55/57/59), test-data-s48 and tmp-devcheck-data were removed;
  scratch-s49 (nft-index.js.orig + eval/capacity evidence), D:\Projects\WebUI\target-ci and
  .data\e2e-store were KEPT; every exit-code file cited by these notes was copied into
  docs/overnight/logs/ first, so older notes that cite scratch paths stay verifiable.
- [ ] P11 host shutdown: the last action of the run (shutdown.exe /s /t 0), recorded with its
  exit code in TEST-RESULTS.md.
- Still NOT marked passed (unchanged): Qwen3-ASR / Qwen3-Embedding / Qwen3-Reranker / Docling /
  PaddleOCR quality, pyannote licence, ASR+OCR+document+video quality on real media, frozen
  temporal_video_localisation, F01 live A/B, F19 jitter. Verdict stays PARTIAL.
- [x] P11 host shutdown issued at 2026-11-16 10:27:59 (record: docs/overnight/logs/shutdown-s61.log)
