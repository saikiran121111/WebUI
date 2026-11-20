# STATE - Ruke generalization + Python migration (session F27 close, 2026-11-17 06:43 Asia/Calcutta)

Previous live copies: `logs/STATE-f26-archive.md` (verbatim copy of the file this replaces), plus
`logs/STATE-f12-archive.md`, `logs/STATE-f11-archive.md`, `logs/STATE-f05-archive.md`. Read TASKS.md
("Session F27") and DECISIONS.md through **D-057** alongside this file. Do not replay older patches.

## Verdict: **PARTIAL**, about 80% complete
Every unattended implementation and gate task in the brief is finished and re-verified, most recently at
F27. What remains is **attended evidence** that the user explicitly told me to hold: (a) the live primary
PaddleOCR-VL run over the frozen d1 corpus, (b) the live Strata unload/reload handoff scenarios,
(c) browser/Playwright UI checks, (d) live frame-OCR evidence, (e) live model-led-routing checks. Those
paths are **coded, unit-tested and operator-wrapped but NOT executed**, so they stay ORANGE - HELD is
never GREEN. Independently non-green: diarization (licence), GPU OCR (no CUDA wheel), neural retrieval
**production caller** (D-046), Python artifact writers (retained TS owners).

## Identity (measured at this checkpoint, after the last edit)
- Branch **local**, HEAD **abc988c208a99f4e224250166300f4ff7fb32549** - unchanged since the original audit
  checkpoint. **HEAD is NOT a usable baseline**: `git status --porcelain` reports **341 entries** (measured
  06:43), all deliberate, nothing committed by any session. Never commit, push, reset, stash,
  `checkout --` or clean.
- Deliberate dirty build debris: `tsconfig.tsbuildinfo`, `mcp-out/`, `python-backend/ruke_ml.egg-info/`.
  Root scratch `a.txt`, `lock-out.txt`, `__tests__/server/tmp-dbg.test.ts` are harness leftovers the
  sandbox refused to delete; harmless, not user work.
- Python 3.12.15 in `python-backend/.venv`; isolated OCR runtime `python-backend/.venv-ocr`; `uv 0.13.0`.

## Amendments in force (all recorded in SPEC/DECISIONS)
1. Model-led intent, code-led processing (SPEC 13, D-036) + `docs/overnight/DECISION-OWNERSHIP.md`.
2. PaddleOCR-VL 1.6 full pipeline as pinned primary, Tesseract recovery only (SPEC 14, D-038).
3. Complete-migration completion matrix (D-049..) with `MIGRATION-MATRIX.md` authoritative; its F27 delta
   section supersedes the G3/J2/C6 rows above it.
4. OCR engine preparation/execution: verified sources, project-local assets, no system Tesseract.
5. Resource-aware GPU/CPU choice + main-LLM unload/reload handoff via the shared coordinator
   (supersedes CPU-only; RAM budget kept, VRAM accounted separately).
6. **Final instruction (F26, still in force at F27): finish everything except the live OCR run and the
   Strata load/unload test - code it, do not run it - report status, then shut the machine down.**
Deferred by instruction, not started: HTML viewer, questionnaire, interactive browser features.

## F27 delta (what changed since the F26 copy)
- **G3 reranking RED -> ORANGE**: a real neural cross-encoder now exists and executes.
  `python-backend/ruke_ml/retrieval/nn_rerank.py` (digest-pinned, CPU-only ONNX, joint (query,passage)
  scoring, 256-token window with reported truncation), asset
  `Xenova/ms-marco-MiniLM-L-6-v2` @ commit `a09144355adeed5f58c8ed011d209bf8ee5a1fec`,
  `.data/models/Xenova/ms-marco-MiniLM-L-6-v2/onnx/model.onnx` 90,992,115 B sha256
  `c623d0bcb99f4622beb413eaef00cfbe5db20df9f1dd982da4b4f26022881870`, re-verified at every load.
  Wired into `retrieval/reranker.py` mode routing and `workers/runner.py` payload
  (`engine`, `quality_note`, `truncation_note`); the registry `rerank` row names the same ids and records
  the negatives too (`beats_dense_biencoder_on_g05_set: False`, `numeric_fact_case_fixed: False`,
  `production_caller_wired: False`, `languages: []`).
- Measured (`f27-g05-rerank-2.log`, frozen n=10, key fixed before the run): mechanics 7/7 PASS,
  top-1 **9/10**, top-3 10/10, MRR 0.950 - **ties** the dense bi-encoder, beats lexical (7/10, 0.850).
  Cold load 0.29 s, 30 reranks 481 ms, **peak working set 267.7 MiB** for the whole probe.
- **Kept failure, not excused**: the numeric-fact case ("99 crates" vs "61 crates") ranks wrong under
  the cross-encoder, the bi-encoder AND lexical. Documented regression in DECISIONS/TEST-RESULTS.
- `g04` embed probe re-run after fixing its stale expectation (it now refuses an *unpinned* mode):
  7/9, both numeric failures kept (`f27-g04-rerun-1.log`).
- Asset **provenance mechanism**: `models/assets.prepare_local()` + `models/prepare.py --local` write
  `asset-manifest.json` (commit, retrieval time, staging cache, per-file sha256) next to the asset
  (`f27-rerank-prepare-2.log` exit 0). Closes the older provenance gap for the MiniLM embedder too.
- Probe bug fixed: missing ctypes `argtypes` made `K32GetProcessMemoryInfo` raise and hide the peak;
  g05 now reports a real `peak_working_set_mib`.
- **D-057**: legacy DOC/PPT conversion deliberately NOT built - the acceptance corpus is frozen with no
  legacy ground truth, and Office COM `Quit()` can discard the user's unsaved documents. The reader
  returns typed `unsupported_input`. Needs explicit authorisation plus a frozen fixture set.

## Process state at this checkpoint (measured 06:43)
- **No owned job or dev tree running**: no Next, no `ruke-server.exe`, no Ruke Python supervisor.
- No `.ai-coordination/llm-handoff.lock`, no `.data/python/handoff-journal.json` (both re-checked: absent).
- The `@playwright/test` `test-server` node (pid 5528) noted at F26 is **no longer present** - it exited
  on its own. Nothing was killed by image name at any point.
- Alive and **never to be touched**: `strata.exe` **5272** (shared main LLM, ~48 GiB resident),
  pythons **3176/3180** (`D:\AI\Strata\serve\server.py --port 8080`, capacity **1**), node **12008**
  (Codex artifact host daemon), node **15164** (this Codex CLI), VS Code family.
- `http://127.0.0.1:8080/health` returned **200** at the F26 check; endpoint left running and untouched.

## Measured resources (2026-11-17 06:43, main LLM resident, Ruke tree down)
- RAM 65299 MiB total, **8313 MiB free**. Commit charge 73953 of 100115 MiB (26162 available). Headroom
  is thin; this is exactly why the primary-OCR peak must be measured, not assumed.
- VRAM: NVIDIA RTX 3060 12288 MiB total, 9483 used, **2633 free** (nvidia-smi, F26). Note
  `Win32_VideoController.AdapterRAM` reports only 4095 for this card - a truncation artifact, do not use
  it. Intel UHD 770 also present.
- Pinned `paddlepaddle 3.2.1` wheel reports `compiled_with_cuda False`, so the honest device policy for
  the pinned runtime remains `allow_gpu = False` until a compatible GPU build exists.
- Ruke tree with the main LLM excluded: 1568 MiB working set / 2126 MiB private at idle (`f18-tree-1.log`).
  The primary-OCR peak (est. 3300 MiB RAM) is **provisional, never measured** - the 5,000,000,000 B hard
  ceiling is an **open acceptance gap**, not a satisfied gate. Weight size was never used as a peak proxy.

## Gates (all re-run today unless noted; no gate was weakened to pass)
- Python: **Ran 383 tests, OK, exit 0** (`logs/f27-python-2.log`). The first attempt exited 1 because of my
  own wrong attribute (`error.code` vs `error.reason`) - fixed, not excused (`f27-python-1.log`).
- `npm run typecheck` exit 0 (`f26-typecheck-1.log`), `npm run contracts:check` exit 0
  (`f26-contracts-1.log`), vitest **2477 passed / 19 skipped** exit 0 (`f26-vitest-2.log`; the single
  failure in run 1 was load-sensitive and passes 9/9 in isolation, `f26-vitest-audio-isolated.log`).
- Rust: 351 tests passed (`f23-cargo-4.log`), production build exit 0 (`f23-build-1.log`).
- **Why TS/Rust were not re-run at F27**: that session changed no `.ts/.tsx/.rs`, and `rerank` is not in
  `rust-backend/crates/ruke-server/src/ml_job.rs::ALLOWED_CAPABILITIES`, so no Rust consumer exists for it.
  Those logs stand as the last run of those surfaces and are cited with that scope stated.
- The `ho-h` held-out HTTP probe "8 fixtures / 0 misses" is **stale** from the F15/F16 dev-tree window and
  must be refreshed against a live dev tree before it is quoted again.

## HELD to tomorrow (attended) - exact commands, each stays ORANGE until run
1. Readiness: `python-backend\.venv-ocr\Scripts\python.exe -m ruke_ml.documents.ocr_cascade`
2. Primary OCR over d1 (engine path, fault injection, memory valve):
   `scripts\run-ocr-acceptance.ps1 -AllowUnload -ConfirmUnload UNLOAD`, then the same with `-StartDev`
   (plus `--inject-primary-failure-page 3` to force the Tesseract recovery path).
3. Handoff unload/reload scenarios, coding agent idle:
   `scripts\run-handoff-acceptance.ps1 -Attended -ConfirmUnload UNLOAD`
4. Frame-OCR live evidence on a slide-heavy video (`RUKE_DOCUMENT_OCR_LANGUAGE=eng`, expect
   `frameRead.recognised > 0`).
5. Browser stage: `scripts\run-browser-e2e-exclusive.ps1` **after** checking the shared Playwright lock.
6. Refresh `node docs/overnight/probes/f09_heldout_http_probe.mjs` against the live tree (8/0 is stale).
Both wrappers refuse to unload unattended (exit 2 with a reason) and have only ever been DryRun and
parse-checked. Running them unattended is prohibited: the user must watch the screen.

## Next action (resume point for tomorrow, in order)
`npm run dev` -> `:3101/api/ruke/health` (exposes `handoff_held`) and `/api/ruke/ml-status` -> item 1 ->
item 2 -> item 3 -> item 4 -> item 5/6 -> then the **D-046 retrieval-owner decision**: Python `rerank`
and `embeddings` now execute but have **no production caller**, while TS
`lib/server/attachindex/{retrieve,embed}.ts` still owns live retrieval; only then retire the
`lib/web-search/search-gate.ts` phrase rules with a real-model run.

## Open blockers / non-green items (each with its real reason)
- pyannote diarization: gated model, licence not accepted. Never accept terms on the user's behalf.
- GPU OCR: no compatible CUDA paddle build pinned; `allow_gpu=False`.
- 5 GB runtime ceiling: **unproven** for the primary OCR path (attended measurement).
- Neural retrieval production caller: blocked on the D-046 owner decision, not on implementation.
- Python artifact writers: TS owners retained by design; their migration status stays incomplete.
- Legacy DOC/PPT: D-057, needs authorisation plus a frozen fixture set.
- `scripts\strata-low-ram.ps1 --ram-keep-gib` unapplied: needs a Strata restart (unauthorised), D-048.

## Shutdown record
Policy: finish feasible work, flush docs and artifacts, drain owned jobs, release owned locks, stop owned
services, preserve unrelated processes and unsaved user work, record status and the resumable next
action, then request a normal Windows shutdown without forcing applications closed. Nothing was owned at
this checkpoint; no lease and no journal exist; the processes listed above are not mine and stay alive.
Command `cmd /c "shutdown.exe /s /t 0"` - **never `/f`**. An accepted request proves a shutdown
**request**, not a physical power-off. Not retried endlessly, no OS refusal bypassed.
No coding, tests or inference after the request is accepted.
shutdown_requested: see the final line of FINAL-REPORT.md, appended immediately after the call.
shutdown_result: exit_code=0 at 2026-11-17 06:46:57 +05:30 (request only, not observed power-off)
