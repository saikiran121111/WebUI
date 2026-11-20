# STATE - Ruke generalization + Python migration (session F32, resumed 2026-11-17 ~15:35 Asia/Calcutta)

Previous live copies: `logs/STATE-f31-archive.md`, `logs/STATE-f27-archive.md`,
`logs/STATE-f26-archive.md`, `logs/STATE-f12-archive.md`, `logs/STATE-f11-archive.md`,
`logs/STATE-f05-archive.md`. Read TASKS.md (sections F28-F32) and DECISIONS.md through **D-061**.
Do not replay older patches. F29/F30/F31 ran without being documented; this file documents them.

## Verdict: **PARTIAL** (no status is raised without evidence)
Every unattended implementation and gate task in the brief is finished and re-verified. The user
rebooted the machine at **15:16:17** and said: "Now you can start working on remaining available work.
I will be monitoring if something goes wrong - complete 100%." So the attended live groups (primary
OCR over the frozen d1 corpus, the Strata unload/reload handoff, production upload->worker OCR with
Tesseract fallback, frame-OCR, the browser stage, the live held-out probe) are permitted. Each stays
ORANGE until a real log exists. Independently non-green regardless: diarization (licence), GPU OCR
(no CUDA wheel pinned), Python artifact writers (retained TS owners), and the 5 GB ceiling proof for
the primary OCR path.

## Identity (re-measured at this checkpoint)
- Branch **local**, HEAD **abc988c208a99f4e224250166300f4ff7fb32549** (unchanged since the original
  audit). `git status --porcelain` = **366 entries**, all deliberate; nothing is ever committed,
  pushed, reset, stashed or cleaned by any session.
- Python 3.12.15 in `python-backend/.venv`; isolated CPU OCR runtime `python-backend/.venv-ocr`; uv 0.13.0.

## Owned processes RIGHT NOW: none.
The F28 dev tree (cmd 8044, python supervisor 6760, ruke-server 9868, Next 4368) is gone - the user
reboot killed it; nothing of mine is running. `http://127.0.0.1:3101/api/ruke/health` is therefore
unreachable; `http://127.0.0.1:8080/health` answers 200. Restart with
`cmd /c "npm run dev > docs\overnight\logs\f32-dev-1.log 2>&1"` and record the pid in
`docs/overnight/logs/f32-dev.pid`; stop only that pid tree (`taskkill /PID <cmdpid> /T /F`), never by
image name. Never touch: `strata.exe` **12112** (WS 50.3 GiB, commit 61.3 GiB,
`qwen3.8-flash-next-iq3_s`, started 15:18:15), Strata python **5696**
(`D:\AI\Strata\serve\server.py --port 8080`, capacity **1**), the Codex CLI/artifact-host node,
VS Code (7472/13108/12508), brave, ChatGPT, explorer, dwm.

## Measured resources at this checkpoint (main LLM resident, no tree of mine running)
- RAM 65299 MiB total, free physical **2921-3197 MiB** (before the reboot it was 8.1 GiB; the reboot
  left Strata plus ~12 GiB of user apps resident). Commit limit 100115 MiB, ~25.9 GiB available.
- VRAM RTX 3060 **12288 total / 9680 used / 2436 free** (nvidia-smi). `allow_gpu=False` because the
  pinned `paddlepaddle 3.2.1` wheel reports `compiled_with_cuda False`, so the GPU branch is never taken.
- Runtime budget excluding the main LLM: 4,000,000,000 B target / 5,000,000,000 B hard maximum.

## What F29 / F30 / F31 actually did (undocumented when they ran; recorded now with their logs)
- **F29 - D-046 closure (the rerank production caller)**: `embeddings` + `rerank` added to the Rust
  ml-job allowlist (`rust-backend/crates/ruke-server/src/ml_job.rs`), new
  `lib/server/attachindex/rerank.ts` async rank stage before `pack()`, honest
  `rerankMode`/`rerankReason` in the turn marker. Gates: vitest rerank 17/17
  (`f29-vitest-rerank-2.log`), attachindex 26/26 (`f29-vitest-attach-1.log`), typecheck
  (`f29-typecheck-1.log`), contracts (`f29-contracts-1.log`), `cargo test -p ruke-server --lib` 263
  passed (`f29-cargo-3.log`), plus one **live ONNX cross-encoder job through the running tree**
  (`f29-rerank-live-2.json/.log`, 9/10 with the known numeric-fact regression still failing).
  `rust-backend/crates/ruke-attach/src/turn.rs` was left byte-identical: the Rust turn path has no
  rerank stage, which is a recorded ownership divergence, not a hidden gap.
- **F30**: prelude regression test
  `test_the_neural_retrieval_workers_also_prelude_import_their_native_graph` in
  `python-backend/tests/test_supervisor_workers.py`; **python suite 384 tests OK exit 0**
  (`f30-python-1.log`) carrying the F29 `_PRELUDE` fix in `ruke_ml/workers/runner.py`
  (`rerank`/`embeddings` pre-import `numpy,onnxruntime,tokenizers`), which removed the measured
  95-155 s native-init hang that had turned every neural rerank into HTTP 552 `deadline_exceeded`.
  `parents[2]` -> `parents[3]` fixed in `docs/overnight/probes/g04_neural_embed_probe.py` and
  `g05_cross_encoder_probe.py`.
- **F31**: `scripts\run-ocr-acceptance.ps1 -Pass content -MaxFreeMib 2048` ran and the engine pass
  ended as an **honest typed `resource_limit`** (`d1-engine-content-20261117-095639.json`): free
  2596 MiB vs required 3556 MiB (provisional est peak 3300 + 256 margin), GPU disabled, main model
  resident -> `needs_handoff: true`, lease released cleanly, watchdog `free_min 2607 tripped 0`.
  **No page was processed - the primary pipeline has still never executed.** The production sub-pass
  died on ConnectionRefusedError because the tree was down (the reboot).

## F32 work completed before the attended OCR run
1. Two real bugs fixed in `scripts/run-ocr-acceptance.ps1` (both measured in F31):
   - `Run-EnginePass` / `Run-ProductionPass` leaked the child's stdout into their return value, so
     `$results[...]` became `System.Object[]` and the final `exit` threw
     `ConvertToFinalInvalidCastException`. Child output is now streamed to the host and each function
     returns one int; ErrorActionPreference is relaxed only around the child call because PS 5.1 turns
     native stderr records into terminating errors under Stop - the exit code is the real signal.
   - A production pass with no tree answering is now a recorded `code 3 (precondition_not_met)` after
     an explicit reachability probe, instead of a traceback that looks like a script crash.
   Verified: `-Pass content -DryRun` exits 0 and prints scalars in the summary.
2. `ruke_ml.models.binaries` confirmed to resolve the project-local `ffmpeg.exe`
   (`node_modules/ffmpeg-static`) and `ffprobe.exe` (`node_modules/@ffprobe-installer/win32-x64`);
   the `ffmpeg_not_installed` line in the python log is the mocked case at `test_video_scan.py:375`,
   not a product defect.
3. This STATE checkpoint, written before the attended run so the recovery path is on disk.

## THE ATTENDED OCR RUN (recovery first if this is read after a break)
Frozen d1 corpus page counts: `d1_scanned.pdf` 6, `d1_scan_nolang.pdf` 6, `d1_native.pdf` 6,
`d1_mixed.pdf` 3, `d1_rotated_scan.pdf` 1. Staged so the blind window is bounded by measured cost:
- **Stage A, one page (worst case ~17 min: unload wait 60 + load 420 + page 240 + ready 300)** through
  `scripts\run-ocr-acceptance.ps1 -Pass content -AllowUnload -ConfirmUnload UNLOAD` with the handoff
  argument `--pages 1`. While the lease is held the coding agent must issue **no** inference request:
  Strata loads the model again on the next request, and its 61.3 GiB commit cannot coexist with the
  OCR worker under the 100115 MiB commit limit.
- Recovery if the session was cut mid-window:
  `python-backend\.venv\Scripts\python.exe -m ruke_ml.handoff --recover`
  (journal `.data\python\handoff-journal.json`, lease `.ai-coordination\llm-handoff.lock`). The runner
  restores the model before it exits unless the process itself died; a leftover lease is broken only
  with pid evidence, and this module has no process-killing path at all.
- Stage B: the remaining pages of `d1_scanned.pdf` with a window budget computed from Stage A's
  measured per-page cost, then the `fault=unavailable`, `fault=crash` and `no_language` passes, then
  the production pass (`-StartDev` plus `--inject-primary-failure-page 3`) and frame-OCR.

## Gates standing from the last ACTUAL runs (scope stated; not cited as re-run)
- Python **384 tests OK** exit 0 (`f30-python-1.log`). vitest full **2477 passed / 19 skipped** exit 0
  (`f26-vitest-2.log`); rerank 17/17 and attachindex 26/26 (`f29-*`). `npm run typecheck` exit 0
  (`f29-typecheck-1.log`); `npm run contracts:check` exit 0 (`f29-contracts-1.log`). Rust
  `cargo test -p ruke-server --lib` 263 passed (`f29-cargo-3.log`); whole-target 351 is older
  (`f23-cargo-4.log`). Production build exit 0 (`f23-build-1.log`).
- j4 handoff **SAFE** suite (no unload): 14 scenarios / 0 misses (`j4-handoff-20261117-052759.json`).
- The `ho-h` held-out probe "8/0" figure is **stale** (F15/F16). The typed error field is
  `.error.reason`, not `.error.code`.

## Next action after the OCR stages
Frame-OCR live (`RUKE_DOCUMENT_OCR_LANGUAGE=eng`, expect `frameRead.recognised > 0`) -> refresh
`docs/overnight/probes/f09_heldout_http_probe.mjs` -> the F29-F32 docs pass (TEST-RESULTS,
MIGRATION-MATRIX, DECISION-OWNERSHIP, DECISIONS D-059 onward, FINAL-REPORT) -> final gates (python,
vitest, cargo, typecheck, contracts, build) -> stop only my own tree, confirm no lease/journal, then
the authorized `cmd /c "shutdown.exe /s /t 0"` (never `/f`, record the exit code, no retries).

## Open blockers / non-green items (with real reasons)
- pyannote diarization: gated model, licence not accepted; never accepted on the user's behalf.
- GPU OCR: no CUDA-enabled pinned paddle build; `allow_gpu=False`; CPU is the only device ever run.
- 5 GB hard ceiling: the ml runtime is inside a Job Object with a 5,000,000,000 B commit ceiling, but
  the primary OCR cold-load/processing peak has never been measured - an acceptance gap, not a gate met.
- `est_peak_mib 3300` and `est_peak_vram_mib 6000` are still **provisional** (1966 MiB pinned weights +
  allowance); they must be replaced with measured values once a real run exists.
- `speech.diarize` = `license_acceptance_required`; `artifacts.xlsx/docx/pptx` = `not_configured`
  (retained TypeScript writers; `openpyxl` exists only inside `.venv-ocr`).
- Legacy DOC/PPT not built (D-057: no frozen legacy ground truth, and Office COM `Quit()` can discard
  the user's unsaved documents); typed `unsupported_input` stays in place.
- `scripts\strata-low-ram.ps1 --ram-keep-gib` unapplied: it needs a Strata restart (unauthorised), D-048.
- Numeric-fact rerank regression ("99 crates" vs "61 crates"): cross-encoder, bi-encoder and lexical
  all rank it wrong; left failing on purpose and recorded.
- `Qwen3-*`, `openai/whisper-large-v3` and `docling` are unpinned and therefore deliberately
  `not_configured`.
