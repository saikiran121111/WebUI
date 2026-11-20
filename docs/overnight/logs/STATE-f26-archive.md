# STATE - Ruke generalization + Python migration (session F26 close, 2026-11-17 06:05)

Previous live copies: `logs/STATE-f12-archive.md` (verbatim, byte-identical to the file it replaced) and
`logs/STATE-f05-archive.md`, `logs/STATE-f11-archive.md`. Read TASKS.md ("Sessions F22-F26") and
DECISIONS.md through **D-055** alongside this file. Do not replay older patches.

## Verdict: **PARTIAL**, roughly 78-80% complete
Every unattended implementation and gate task in the brief is finished and re-verified today. What is
left is **attended evidence**: (a) the live primary PaddleOCR-VL run over the frozen d1 corpus, (b) the
live Strata unload/reload handoff scenarios, (c) browser/Playwright UI checks. Those were held by the
user's own instruction - "this requires user to stay and monitor the screen" - so their code is written,
unit-tested and operator-wrapped, but **not GREEN** and not executed. Diarization, GPU OCR, neural
reranking weights and Python artifact writers remain genuinely non-green for the documented reasons.

## Identity (measured at this checkpoint, before any further edit)
- Branch **local**, HEAD **abc988c208a99f4e224250166300f4ff7fb32549** - unchanged since the original
  audit checkpoint. **HEAD is NOT a usable baseline**: `git status --porcelain` now reports **333
  entries**, all deliberate, nothing committed by any session. Never commit, push, reset, stash,
  `checkout --` or clean.
- Deliberately dirty build debris: `tsconfig.tsbuildinfo`, `mcp-out/`, `python-backend/ruke_ml.egg-info/`.
  Root scratch `a.txt`, `lock-out.txt` and `__tests__/server/tmp-dbg.test.ts` are harness leftovers that
  the sandbox refused to delete; they are harmless but should not be mistaken for user work.
- Python 3.12.15 in `python-backend/.venv`; isolated OCR runtime `python-backend/.venv-ocr`; `uv 0.13.0`.

## Amendments in force (all recorded in SPEC/DECISIONS)
1. Model-led intent, code-led processing (SPEC 13, D-036) + `docs/overnight/DECISION-OWNERSHIP.md`.
2. PaddleOCR-VL 1.6 full pipeline as pinned primary, Tesseract recovery only, 4 GB target / 5 GB hard
   max excluding the main LLM (SPEC 14, D-038).
3. Complete-migration completion matrix (D-049..) and `MIGRATION-MATRIX.md` as the authoritative table.
4. OCR engine preparation and execution (verified download sources, project-local everything).
5. Resource-aware GPU/CPU choice + main-LLM unload/reload handoff through the shared coordinator
   (supersedes CPU-only, keeping the RAM budget and accounting VRAM separately).
6. **Final instruction (F26): finish everything except the OCR live run and the Strata load/unload hold -
   code it but do not run it - then shut the machine down.** Those two groups are HELD.
Deferred by instruction, still not started: HTML viewer, questionnaire, interactive browser features.

## Process state at this checkpoint
- **No owned job or dev tree is running.** No Next, no `ruke-server.exe`, no Python supervisor.
- No `.ai-coordination/llm-handoff.lock` and no `.data/python/handoff-journal.json` (both checked: absent).
- Alive and **never to be touched**: `strata.exe` **5272** (~48 GiB resident, the shared main LLM),
  pythons **3176/3180** (`D:\AI\Strata\serve\server.py`, capacity **1**), node **12008**, VS Code family
  **15080/16644**, this agent's shell. `http://127.0.0.1:8080/health` returned **200**.
- Never kill by image name, only PIDs this run started. Note for the user: a VS Code helper at pid 6088
  was terminated earlier by a lease-breaker bug that has since been removed outright (D-054); the editor
  itself kept working. If anything feels off in the editor, restart VS Code.

## Measured resources (2026-11-17, main LLM resident, Ruke tree down)
- RAM 65299 MiB total, **7308 MiB free**; commit charge ~75774 of 100115 MiB. Headroom is thin.
- VRAM RTX 3060 12288 MiB total, 9483 used, **2633 free** -> GPU OCR cannot fit now, and the pinned
  `paddlepaddle 3.2.1` wheel reports `compiled_with_cuda False` anyway, so the policy is honestly
  `allow_gpu = False`.
- Ruke tree with the main LLM excluded, last whole-tree sample: 1568 MiB working set / 2126 MiB private
  at idle (`f18-tree-1.log`). The primary-OCR peak (est. 3300 MiB RAM / 6000 MiB VRAM) is **provisional,
  never measured** - the 5 GB hard ceiling is therefore an open acceptance gap, not a satisfied gate.

## Gates as of this checkpoint (all re-run today unless noted)
Python 375 tests OK exit 0 (`f26-python-1.log`) - vitest 2477 passed / 19 skipped exit 0
(`f26-vitest-2.log`; run 1 `f26-vitest-1.log` had exactly one load-sensitive failure, isolated pass 9/9
in `f26-vitest-audio-isolated.log`) - `npm run typecheck` exit 0 (`f26-typecheck-1.log`) -
`npm run contracts:check` exit 0 (`f26-contracts-1.log`) - J4 probe SAFE set 14 scenarios 0 misses
(`j4-safe-console-2.txt`) - Tesseract runtime verify exit 0 with a real image-to-text run 20/20 key
words (`f26-tess-verify-5.log`) - pinned Tesseract asset digests re-verified (`f26-tess-pin-recheck-1.log`).
Rust 351 passed is from `f23-cargo-4.log` (no Rust change since); production build exit 0 from
`f23-build-1.log`; `ho-h` held-out HTTP probe 8 fixtures 0 misses is from the F15/F16 dev-tree window
and has **not** been refreshed since, because the tree has been down.

## What is HELD, and the exact attended commands
1. Primary OCR over d1 (engine path + production upload path + fault injection + memory valve):
   `scripts\run-ocr-acceptance.ps1 -AllowUnload -ConfirmUnload UNLOAD`, then the same with `-StartDev`.
   Readiness first: `python-backend\.venv-ocr\Scripts\python.exe -m ruke_ml.documents.ocr_cascade`.
2. Handoff unload/reload scenarios (needs an idle coding agent):
   `scripts\run-handoff-acceptance.ps1 -Attended -ConfirmUnload UNLOAD`.
3. Frame-OCR live evidence on a slide-heavy video (`RUKE_DOCUMENT_OCR_LANGUAGE=eng`, expect
   `frameRead.recognised > 0`).
4. Browser stage: `scripts\run-browser-e2e-exclusive.ps1` after checking the shared Playwright lock.
Both wrappers refuse to unload unattended (they exit 2 with a reason) and were only DryRun/parse-checked.

## Next action (resume point for tomorrow)
`npm run dev` -> refresh `node docs/overnight/probes/f09_heldout_http_probe.mjs` -> check
`http://127.0.0.1:3101/api/ruke/health` (it now exposes `handoff_held`) and `/api/ruke/ml-status` ->
then item 1 above, item 2 above, then frame-OCR, then Playwright, then the G2 retrieval owner decision
(D-046) and retiring the `lib/web-search/search-gate.ts` phrase rules with a real-model run.
Full detail: `docs/overnight/FINAL-REPORT.md` "Resumable next action".

## Shutdown record
Authorized policy: finish feasible work, flush docs, drain owned jobs, release owned locks, then request
a normal Windows shutdown without forcing applications closed. Nothing was owned at this checkpoint and
no lease/journal exists. `shutdown.exe /s /t 0`, never `/f`; an accepted request proves a shutdown
**request**, not a physical power-off, and it is never retried endlessly.
shutdown_requested: NO - not yet issued (see the line below this one when it is).
