# STATE - Ruke generalization + Python migration (session F62 live copy, 2026-11-20 Asia/Calcutta)

**To resume after compaction, read in this order:** (1) `docs/overnight/HANDOVER-2026-11-20.md` - the dated
checkpoint with the line-level seams; (2) `docs/overnight/TASKS.md` ending at the **F65 "Next action (single,
exact)"** line; (3) `docs/overnight/SPEC.md` through **amendment 15 (25.1-25.5)**; (4) `docs/overnight/DECISIONS.md`
through **D-081**. Do not re-derive anything below: every number here came from a named log, a line in a file, or a
measurement taken 2026-11-20 and labelled as such.

Previous live copies, archived verbatim: `logs/STATE-f58c-archive.md` (the F58c body as it stood at F62, including
the supersession banner that pointed here - the F52-F58c detail lives there and in TASKS F52-F58c + D-072..D-078),
`logs/STATE-f51-archive.md`, `logs/STATE-f48-archive.md`, `logs/STATE-f45-archive.md`, `logs/STATE-f32-archive.md`,
`logs/STATE-f31-archive.md`, `logs/STATE-f27-archive.md`, `logs/STATE-f26-archive.md`, `logs/STATE-f12-archive.md`,
`logs/STATE-f11-archive.md`, `logs/STATE-f05-archive.md`. Sessions that left no evidence block of their own: **F49**
(nothing at all) and **F57** (files changed, no `f57-*` log; that work is the unknown-not-zero sweep under D-076).
Stated, not back-filled.

## Verdict: **PARTIAL**
Done-states kept separate everywhere: **implemented / production-wired / actually-executed / acceptance-passed**.
Never green from an install, a readiness manifest, a dry run, a mock, fallback-only success, or an endpoint
returning 200. Progress against the task list, honestly labelled as progress and not as quality: about **77 %** of
the unattended code work and about **64 %** of the full acceptance list.

## Identity and resources (re-measured 2026-11-20)
- Branch **local**, HEAD **abc988c**, `git status --porcelain` = **510 entries** at the checkpoint before this
  file was rewritten, and the count only ever moves by the new scratch helpers and the archive file this rewrite
  added (it measured 514 a few minutes later, after the g49-g52 integrity checks). Nothing is ever
  committed, pushed, reset, stashed or cleaned - the entire migration exists only in the working tree.
- Host: 65,299 MiB physical, **1,659 MiB free physical** at the 21:06 g56 re-measure (3,632 earlier on 2026-11-20,
  5,358 at F58c), **23,968 MiB free commit** (`logs/f63-ocr-window-1.log`).
- Main model engine pid **19400** `strata` **WS 49,673 MiB / private 61,301 MiB**; :8080 listener pid **20332**
  `python` (262 MiB, started 2026-11-20 12:49:47). Re-list at 21:14 the chain had **restarted itself** - two
  `D:\AI\Strata\.venv\Scripts\python.exe serve\server.py --engine strata --port 8080` processes, pids **20956 /
  17528**; the old pids are dead. Drift noted, not a finding (D-081). Capacity **1**, one shared inference lock, automatic reload on
  the next request (the operator's console: 46.84 GiB of experts at 5.75 GiB/s, then a 777-expert / 1.50 GiB GPU
  cache refill). **Do not touch that endpoint from inside a turn**: no `GET /health`, no restart, no provider
  change. The main LLM's configuration and GPU allocation were not changed by any work in this migration.
- No `.ai-coordination/playwright.lock` held on 2026-11-20. Check it before any browser work.
- Interpreters: `python-backend/.venv` (3.12.15, no Paddle) and `python-backend/.venv-ocr` (paddleocr 3.6.0,
  paddlepaddle 3.2.1 `compiled_with_cuda False`, paddlex 3.6.1, protobuf 7.36.2, numpy 2.3.5, pillow 12.1.0;
  **no pip** - `uv pip list -p <exe> --format freeze`; manifest `.data\models\ocr\ocr-runtime.json`).
  Pins/revisions: PaddlePaddle from the CPU index; `PaddlePaddle/PaddleOCR-VL-1.6 @ 132c45f52c0a...` (recognition,
  1,930,469,491 B; `model.safetensors` 1,917,255,968 B **bf16**, which on CPU the pinned build materialises as
  **float32 ~3.8 GiB**) and `PaddlePaddle/PP-DocLayoutV3 @ 241f8bdfc77a...` (130,806,572 B pdiparams).
  Tesseract project-local **v5.5.3.20260724**, `eng` + `osd` only, manifest `.data/tools/tesseract/ocr-assets.json`,
  verify with `scripts\prepare-tesseract-runtime.ps1 -VerifyOnly`. Binaries via `ruke_ml/models/binaries.py::path_for`.
- Commands: python `-m unittest tests.NAME -v` (**no pytest**), TS `npx vitest run`, types
  `npx tsc --noEmit -p tsconfig.json --incremental false`. PowerShell 5.1: `;` not `&&`; `rg` takes `--glob`/`-g`,
  never `-r`; scratch helpers `.data\tmp\gN.py`/`.sh`/**`.mjs`** (**g59 used - next free g60**, re-listed 2026-11-20 at F66; the
   Bash harness cannot evaluate multi-line single-quoted one-liners — write a scratch `.sh` and `bash` it); real exit codes via
  `cmd //c "prog > log 2>&1"; $LASTEXITCODE` (**a bare `/c` under MSYS bash gets path-mangled - cmd then idles
  at stdin EOF and exits 0 VACUOUSLY without running anything, caught 2026-11-20 at F67; never trust EXIT=0
  without the log file existing**); `apply_patch` needs `*** Begin Patch` / `*** End Patch`.
- Gate baseline **re-run 2026-11-20 21:09-21:13 at F63 - all four green on current source**: python discover
  **532 OK** in 55.6 s (`logs/f63-py-discover-1.log`), TS typecheck exit 0 (`logs/f63-ts-types-1.log`), full Vitest
  **196 files passed / 2 skipped, 2,535 tests passed / 19 skipped** (`logs/f63-vitest-full-1.log`), cargo workspace
  exit 0 with zero failed tests and the F48 counts **263 / 40 / 4** reproduced (`logs/f63-rust-test-1.log`).
  Historical baselines kept for reference (F58c: python 503, TS 196/2,534/19): the +29 python / +1 TS deltas are
  exactly the F60/F61 additions. Open item 3 is closed for the gates half; its measured-registry half stays
  blocked (registry `est_peak_*` still **estimated**).
- Gate **FINAL run 2026-11-21 ~00:25-01:10 at F71 on final source - all four green, item 6 DONE**: vitest
  **196 files / 3 skipped, 2,535 tests / 24 skipped** (`logs/f71-vitest-full-2.log`; the first capture
  `f71-vitest-full-1.log` failed on **2 stale-premise files** - lazyLoad + chatEngine "standard_chat injects
  nothing" still encoded the pre-D-070 zero-injection law that F65's catalogue replaced - repaired to the
  F65-precedent shape "block exists, catalogue ONLY, no core_skill/output_contract"; every other assertion
  kept; targeted proof `logs/f71-vitest-d070fix-1.log`), python discover **532 OK**
  (`logs/f71-py-discover-1.log`), cargo full workspace **27 binaries ok, 739 passed 0 failed**
  (`logs/f71-rust-test-1.log`), tsc **exit 0** (`logs/f71-tsc-1.log`), plus `contracts:check` OK re-confirming
  the F65 sha-pin (`logs/f70-contracts-check-1.log`). The +1 skipped file / +5 skipped tests vs F63 is the
  F66 env-gated rerank route - expected, unattended skip.

## Closed since the last live STATE copy (F59-F62), with evidence
- **The six amendment-15 findings re-verified, not replayed** (SPEC 25.2): 1 and 2 closed this cycle, 3 at
  amendment 8B, 4/5 at amendment 12, 6 at D-076/F57.
- **One resource-window lifecycle** (D-079, D-080): `models/job_limits.py` holds the normal 4 GB target / 5 GB hard
  tree ceiling (`normal_ceiling_bytes()` :357) **and** a separately configured bounded exclusive ceiling
  (`RUKE_EXCLUSIVE_LIMIT_BYTES` default 7 GB clamped by free commit - 2 GiB `RUKE_SYSTEM_RESERVE_BYTES`, :371);
  `worker_ceiling_bytes(...)` returns a bounded ceiling or a typed refusal with its arithmetic; the OCR adapter
  refuses **before spawning** when the offerable ceiling is under the declared demand
  (`ocr_paddle.py`:436, `RESOURCE_LIMIT_STEP` :169); one `classify_worker_death` (:95) at all three observation
  sites (:638, :657, :825); one allocation-marker authority (`ruke_ml/allocations.py`, note: **not** under
  `models/`) shared into the child; `workers/jobs.py`:87 maps `resource_limit -> memory_pressure`, retryable;
  `ocr_cascade._operation` is the single windowed body (primary -> per-unit Tesseract recovery -> durable
  `ruke.ocr-result.v1` write) used by the lease path, the no-lease path and `handoff.py`.
- The suspected TS `memory_pressure` passthrough gap was **investigated and is not a defect**, then pinned.
- Records brought up to date: SPEC amendment 15, D-079/D-080, TEST-RESULTS F60/F61 rows, MIGRATION-MATRIX and
  DECISION-OWNERSHIP deltas, FINAL-REPORT F59-F61 section, TASKS F59/F60/F61/F62 blocks (four F60 boxes ticked,
  two deliberately left open), `HANDOVER-2026-11-20.md`, and this STATE rewrite with the F58c body archived verbatim.

## Open, in order (the only list that matters)
1. ~~`docs/overnight/probes/d1_engine_scoring_probe.py` - the engine-level scorer~~ **CLOSED at F63** (written,
   40,983 B / 757 lines; `--self-check` **17 controls, broken 0, exit 0** - 5 key-shaped positives 0 fails, 12
   named sabotages each >= 1 fail; `logs/f62-engine-selfcheck-3.log`, JSON
   `logs/d1-engine-selfcheck-20261120-205650.json`; live three-state distinction pinned outside self-check).
   The scorer green proves **only the scorer** - primary PaddleOCR-VL-1.6 has still recognised **zero pages**, so
   acceptance still needs a real engine run. Key `d1-ocr-1`, WER **0.1** primary / **0.15** fallback, coverage
   fraction **1.0** - never loosened.
1b. ~~The bounded measurement decision~~ **CLOSED at F63** (g56 ran 21:06, exit 0, `logs/f63-ocr-window-1.log`):
   at 1,659 MiB free physical / 23,968 MiB free commit the production adapter answers **pre-spawn** with a typed
   `resource_limit` (normal window 4,768 MiB < 6,264,193,024 B minimum viable; no spawn, no :8080 contact, no
   unload switch); the exclusive-window row (7,000,000,000 B > 6,264,193,024 B) is **arithmetic only**. Correct
   behaviour, not a pass. The cold-load **peak** measurement stays **blocked behind the attended window**.
2. The bounded exclusive-window measurement run (cold load + at most 2 pages, explicit `per_worker_limit_bytes`,
   main LLM NOT released, recorded as an **exclusive-window** number above the 4 GB normal target). Paging stall
   likely at 3,632 MiB free physical, so it runs only after code, tests and docs are on disk.
3. ~~Standing gates re-run~~ **DONE at F63** (all four green, logs above). Its registry half stays **blocked behind
   the attended window**: `models/registry.py` `est_peak_mib` / `est_peak_vram_mib` get **measured** values only when
   the attended cold-load run produces them (the basis string must literally start "measured" -
   `resources.estimate_is_measured` tests the prefix), then re-read the admission decision with `.data/tmp/g42_plan.py`.
4. ~~Enforcement parity for tesseract / ffmpeg / frame OCR~~ **RECORDED at F63 (D-081)**: the D-080 "no OS
   job-object ceiling" sentence is wrong as an absolute - grandchildren of job members join the job at create
   time (`job_limits.py`:191-199; supervisor self-install at `supervisor.py`:230, live line `f28-dev-1.log`:11;
   worker attach at `lifecycle.py`:316-334). Parity = **contained, not separately capped**; ffmpeg's row carries
   the no-validated-copy host reason; live re-proof of enforcement is sandbox-blocked here (one job per process,
   `in_a_job` True for this session's pythons) and stays scheduled for the attended run.
5. Then the rest of the finite checklist: ~~chat-continuation-after-handoff traced end to end~~ **traced at F64**
   (TASKS F64 block; the seams are `lib/server/coordination/llm-lease.ts` - NOT `lib/server/llm-handoff*`, which
   never existed - Rust `admission.rs`/`ml_job.rs`, python `handoff.py`/`ocr_cascade.py`; the live half stays
   **attended** with the OCR cold load, and the 90 s parse-deadline-vs-300 s reload flag is recorded there for
   that run); ~~the D-070
   fence-catalogue gap~~ **DONE at F65** (catalogue rides every non-slash turn through `MODE_CONTRACTS.standard_chat`
   sha d4f2910b833ecf05… 1309 B; both runtimes byte-identical; sanctioned fixture re-record + stale-premise repairs;
   targeted gates 11/65 TS + 38+9 ruke-decision + 19+6 ruke-server + tsc 0 + contracts:check OK —
   `logs/f65-d070-verification.log`; the live "model actually picks the right fence" proof rides the attended window);
   ~~neural embed/rerank production callers~~ **DONE at F66, two honest halves** (rerank: production-wired since
   D-058 AND executed end-to-end through the live `POST /api/ruke/ml/job` route with the supervisor tree's peak
   RSS recorded - 204 MiB working set, `logs/f66-rss.json`; embeds: the Python `nn_embed` adapter was **never
   wired**, TS `attachindex/embed.ts` stays the production owner - reported like the retained-TS artifact writers.
   The two numeric-fact misses stay failures, now pinned by the env-gated live characterization test
   `__tests__/server/attach-rerank-live-route.test.ts`; registry `production_caller_wired` moved to True with its
   test; acceptance-passed = NO for quality);
   ~~artifact reopen/render~~ **audited clean at F67, no code change needed** (writers **retained TypeScript**,
   verified as the only writers - the four TS engines behind `app/api/documents/*` are the sole generation
   callers, no Python/Rust writer exists, and the surface is honest BY CONSTRUCTION via registry
   `revision="not-migrated"` rows + the runner's typed `not_configured` refusal with the migration precondition
   as human_step; reopen re-executed live on the current tree **4/4 green** `logs/f67-reopen-parity-1.log`;
   render rules intact: all six FenceRouter viewers stay lazy `next/dynamic ssr:false`, iframe-sandbox /
   observer / revocation hygiene present, and there is **no live WebGL renderer in the tree** (the only THREE
   text is a `demoShowcase.ts:115` string); migration stays **RED by definition**, reported honestly; the
   in-browser viewers half rides the final Playwright pass); ~~ASR/alignment/diarization honesty~~
   **audited clean at F68, zero changes needed** (`LICENSE_REQUIRED = "license_acceptance_required"` is the one
   vocabulary; BOTH entry points refuse without trying - `runner.py:247` + `speech_jobs.py:263`; blocker order
   licence-first in `jobs.py:133-150` is the anti-lie mechanism; Rust admits `speech.diarize` so the refusal is
   nameable with its real blocker, not hidden; no components/app surface names diarization; alignment returns
   provider word times or an explicit `segment_span_only` verdict, never invented timing; the F58c tokens
   `vad_state`/`window_truncated`/`superseded` are still real worker tokens producer->consumer->note;
   executed pinned today **70 py OK** `logs/f68-py-speech-1.log` + **31 vitest** `logs/f68-ts-capability-1.log`);
   ~~streaming/reasoning separation, activity states, scroll stability~~ **audited clean at F69, zero changes**
   (fence-aware splitter `lib/stream/thinkTags.ts` <-> `chat/scrubber.rs::ThinkFieldSplitter` with the
   mechanical parity loop executed today - TS `sse-vectors` re-records `fixtures/sse/02` (already M; replay is
   the judge), cargo `scrubber_vectors` replay **3/3**, lib `scrubber` **36**, TS `think-splitter` **34**
   `logs/f69-rust-scrubber-1.log` + `logs/f69-ts-stream-split-1.log`; `parser.ts` keeps reasoning fields
   **structurally exclusive** per delta; `currentActivity.ts` is the single authority `ProcessingStatus` renders
   from (15 tests); `turnProgress` percents derive only from real data incl. `capped` != Done (27); the
   `scrollFollow` pure reducer + tagged programmatic pins + height-innocence budget wired in `app/page.tsx`,
   nested scrollers behind `data-nested-scroll` (15); rAF-batched deltas + turn fence + `memo()` ChatMessage
   intact; `logs/f69-ts-follow-progress-1.log`; the splitter checkpoint is commit **002b969**, face1f7 is
   admission - earlier notes mislabeled it);
   ~~fresh-clone portability~~ **audited green at F70, one doc fix** (1,660 tracked files with **zero tracked
   model/binary weights**, no venv/node_modules/target tracked, lockfiles + `.python-version` all committed;
   gitignore law holds incl. uv self-ignoring venv `.gitignore` verified via check-ignore, and the root
   `tests/fixtures/` rule is anchored so it never eats the tracked golden `rust-backend/fixtures` corpus which
   `.gitattributes` pins LF; **no absolute machine paths in source** (only a doc-comment anti-pattern);
   every `RUKE_*` read outside `.env.example` has a code default or is a supervisor-internal/advanced override
   so no unset switch blocks a fresh clone; honest Python-env degradation ladder read verbatim in
   dev-supervisor:216-290; `npm run contracts:check` **EXIT=0** re-confirming the F65 sha-pin,
   `logs/f70-contracts-check-1.log`; the only fix: SETUP.md's over-broad ".env.example lists every name" claim
   re-scoped to provider/lifecycle names; **no physical clone-install run** - a HEAD-only clone lacks the 588
   pending tree entries, honestly stated; root junk `a.txt`/`lock-out.txt`/`mcp-out/` flagged for the user's
   commit sweep, not deleted). Item 5 is now **complete** for unattended scope. `detectDeliverableIntent` and the `search-gate.ts` phrase rules stay live until a
   live-model-selection run proves the replacement, and live-model runs are blocked because capacity-1 hosts this
   coding session. HTML viewer / questionnaire / interactive-browser work stays **deferred**.

## The blocker that is not a code gap
**Primary PaddleOCR-VL-1.6 has recognised zero pages, ever.** Root cause is the CPU memory floor, not protobuf
(`logs/f59-pb-import-1.log` shows the import fix holds): `logs/f59-ocr-coldload-1.log` +
`.data/python/tmp/ocr-paddle-15388/worker-1794943495.log` show the worker dying at exit `None` while reading
`model.safetensors` under a 3,814 MiB job-object ceiling. `device_plan("documents.ocr", 3300, 6000)` =
`device:none, fits:false, needs_handoff:true`; GPU OCR impossible (`compiled_with_cuda False`, ~2.8 GiB free VRAM
vs 9,256 MiB wanted). Production now refuses pre-spawn with a typed `resource_limit`, which is **correct
behaviour, not a pass**. The only route to green is the **attended** window, because it unloads the model this
coding session runs on, in this order:
`scripts\run-ocr-acceptance.ps1 -Pass content -AllowUnload -ConfirmUnload UNLOAD -MaxFreeMib 2000` ->
`docs\overnight\probes\d1_ocr_acceptance_probe.py --pass content` -> `-Pass fallback_primary|fallback_crash|no_language`
-> `-ResumeResults` -> `-StartDev -InjectPrimaryFailurePage 3` -> frame OCR with `RUKE_DOCUMENT_OCR_LANGUAGE=eng`
-> `node docs\overnight\probes\f09_heldout_http_probe.mjs` (its "8/8/0/0" line is stale; re-read it from a fresh run).
Run it as the **last** action of a session, with the user watching. Env switches:
`RUKE_LLM_AUTOMATIC_HANDOFF`, `RUKE_OCR_ALLOW_UNLOAD`, `RUKE_OCR_ALLOW_GPU` (off), `RUKE_OCR_RESUME`,
`RUKE_OCR_FAULT=unavailable|crash`, `RUKE_OCR_WORKER_FAULT`, `RUKE_OCR_INJECT_FAILURE_PAGE`, `RUKE_OCR_PRIMARY`,
`RUKE_OCR_RESULT_DIR`, `RUKE_DOCUMENT_OCR_LANGUAGE`, `RUKE_EXCLUSIVE_LIMIT_BYTES`, `RUKE_SYSTEM_RESERVE_BYTES`.

## Next action (single, exact) - the UNATTENDED run is COMPLETE (item 6 DONE at F71; final report written)
The four standing gates ran ONCE on final source, all green (logs `f71-tsc-1` / `f71-rust-test-1` /
`f71-py-discover-1` / `f71-vitest-full-2`; thresholds intact, the +1 skipped file / +5 skipped tests vs
F63 is the F66 env-gated rerank route). The first vitest capture (`f71-vitest-full-1`) FAILED on 2
stale-premise files (pre-D-070 "standard_chat injects zero" asserted in `lazyLoad.test.ts` +
`chatEngine.test.ts` - F65's targeted capture missed them); repaired to the F65-precedent
catalogue-only shape with no assertion weakened, then green. The FINAL REPORT now exists:
**FINAL-REPORT.md section "# F62 - F71"** with the four states (implemented / exercised-through-
production / acceptance-passed / blocked), every blocker with observed reason + smallest clearing
action. Remaining work is ONLY the attended list below - nothing unattended is left open.

The video / PDF-live / chat-continuation-live / OCR cold-load peak / fence-selection-live proofs stay
**attended** (STATE "The blocker that is not a code gap" section, run in that order last, with the
reload timed before any deadline raise; env switches listed there). Two flags for the user's commit
sweep: exclude root debris `a.txt`, `lock-out.txt`, `mcp-out/`; and an empty harness artifact
`D:\overnight-placeholder-check` (drive root) could not be deleted - `rm` is blocked by the current
permission policy - remove it by hand.

## What this file does not claim
No OCR quality claim (zero pages), no "best OCR", no "99 % of overfitting removed", no cross-client safety beyond
the cooperative pause actually tested, no measurement where none exists, and no suggestion that any attended gate
has passed. No shutdown was requested: the earlier end-of-run shutdown authorization was superseded by the user's
later "I will be monitoring ... complete 100 %" instruction, and the remaining gates need a human at the screen.
