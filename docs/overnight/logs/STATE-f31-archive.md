# STATE - Ruke generalization + Python migration (session F28, resumed 2026-11-17 13:07 Asia/Calcutta)

Previous live copies: `logs/STATE-f27-archive.md` (verbatim copy of the file this replaces), plus
`logs/STATE-f26-archive.md`, `logs/STATE-f12-archive.md`, `logs/STATE-f11-archive.md`,
`logs/STATE-f05-archive.md`. Read TASKS.md ("Session F28") and DECISIONS.md through **D-058** alongside
this file. Do not replay older patches.

## Verdict: **PARTIAL**
Every unattended implementation and gate task in the brief is finished and re-verified (F27). The user
returned at **13:07 +05:30** and lifted the attended hold: "Now you can start working on remaining
available work. I will be monitoring if something goes wrong - complete 100%." So the live groups that
were HELD (primary OCR over the frozen d1 corpus, Strata unload/reload handoff, browser/Playwright,
frame-OCR live, live held-out probe) are now **permitted, attended**. They stay ORANGE until actually run
with evidence. Independently non-green regardless: diarization (licence), GPU OCR (no CUDA wheel pinned),
neural-retrieval **production caller** (D-046, being closed this session), Python artifact writers
(retained TS owners).

## The shutdown that already happened (verified, and ended by the reboot)
- `cmd /c "shutdown.exe /s /t 0"` at **06:46:57 +05:30, exit code 0** - a shutdown *request*, logged as
  `shutdown_result` in the F27 copy of STATE (now `logs/STATE-f27-archive.md`).
- The machine **did** power off: `Win32_OperatingSystem.LastBootUpTime = 11/17/2026 13:04:24`.
- `shutdown.exe /a` at 13:07 returned **1116** ("no shutdown in progress"): nothing is pending. All F28
  work happens after a full reboot; the authorized end-of-run shutdown policy still applies at the end.

## Identity (measured at this checkpoint)
- Branch **local**, HEAD **abc988c208a99f4e224250166300f4ff7fb32549** - unchanged since the original audit
  checkpoint; `git status --porcelain` = **346 entries**, all deliberate, nothing committed by any session.
  Never commit, push, reset, stash, `checkout --` or clean.
- Python 3.12.15 in `python-backend/.venv`; isolated OCR runtime `python-backend/.venv-ocr`; `uv 0.13.0`.

## Owned processes RIGHT NOW (mine - must be stopped before shutdown)
- `cmd.exe` pid **8044** = `npm run dev` (pid file `logs/f28-dev.pid`, log `logs/f28-dev-1.log`), started
  13:12:56. Children: the dev supervisor node, **python supervisor 6760** on `127.0.0.1:54610`
  (limits `heavy_concurrency:1, idle_ttl_s:120, mem_budget_mib:4096`, `workers:{}` - lazy),
  `ruke-server.exe` **9868** on `:3101`, Next dev **4368** on `:3000`. Job Object ceiling active:
  "commit ceiling enforced: 5000000000 bytes via windows-job-object (ruke-runtime)".
- `/api/ruke/health` -> `{"ok":true,"user_turn_active":false,"handoff_held":false}`; ml-status snapshot
  in `logs/f28-mlstatus-1.json`.
- Stop policy: kill only this PID tree (`taskkill /PID 8044 /T /F`), never by image name.
- Alive and **never to be touched**: `strata.exe` **15560** (~49 GiB WS, shared main LLM), Strata pythons
  **6024/2692** (`D:\AI\Strata\serve\server.py --port 8080`, capacity **1**), the Codex artifact-host node
  and this CLI's node (PIDs change per session; re-check before touching anything), VS Code family.

## Measured resources at this checkpoint (main LLM resident, my dev tree up)
- RAM 65299 MiB total, **4566 MiB free**; commit 100115 MiB limit, ~27.9 GiB free. Free RAM is the binding
  constraint for the primary OCR run (provisional estimate 3300 MiB) - hence the memory valve
  (`-MaxFreeMib`) in `run-ocr-acceptance.ps1` and the still-**unproven** 5,000,000,000 B hard ceiling.
- VRAM: RTX 3060 **12288 total / ~9703 used / ~2413 free** (`nvidia-smi`; WMI `AdapterRAM`=4095 is a
  truncation artifact - do not use it). No compatible CUDA paddle wheel is pinned, so `allow_gpu=False`.

## OCR engine readiness (re-measured after reboot, `logs/f28-ocr-readiness-1.log`, exit 0)
- Primary `paddleocr-vl-1.6`: `ready=true`, `blockers=[]`.
  Snapshots present under `.data/ml-cache/huggingface/hub`: `PaddlePaddle/PaddleOCR-VL-1.6` @
  `132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd`, `PaddlePaddle/PP-DocLayoutV3` @
  `241f8bdfc77a7c7bee915a5057aaee58c235a8d3`.
  Pinned: `paddleocr 3.6.0`, `paddlepaddle 3.2.1` (wheel `compiled_with_cuda False`), `paddlex 3.6.1`,
  `opencv-contrib-python-headless 4.10.0.84`; `cpu_only_verified=true`, `allow_gpu=false`.
  Rasterizer `pypdfium2 5.15.2` in the OCR venv.
- Fallback Tesseract: project-local `.data/tools/tesseract/tesseract.exe`, version **5.5.3.20260724**,
  installed languages **eng, osd only** - report that coverage honestly, never "all languages".
- Peak 3300 MiB RAM / 6000 MiB VRAM is an **estimate**, not a measurement. Not GREEN until a real complex
  document has run through the full pipeline.

## Package reality (scratch probe `.data/tmp/pkg_probe.py`)
- `.venv`: onnxruntime 1.32.0, faster-whisper 1.2.1, pypdfium2 5.6.0, numpy 2.5.5, pypdf 7.1.0.
  **Missing**: openpyxl, python-docx, python-pptx, reportlab, pillow, pytesseract.
- `.venv-ocr`: paddle stack + openpyxl 3.1.5 + pillow 12.1.0 + pypdfium2 5.15.2.
  **Missing**: onnxruntime, faster-whisper, python-docx, python-pptx, reportlab.
- Consequence: `artifacts.xlsx/docx/pptx` are `not_configured` ("typescript-* names have no importable
  adapter") -> area H stays **retained-TS, migration explicitly incomplete** unless pinned writer deps
  are added deliberately.

## F28 work in progress
1. This STATE/TASKS/DECISIONS checkpoint (D-058 = the D-046 owner decision being implemented now).
2. **D-046 closure (part)**: put `embeddings` and `rerank` on the Rust ml-job allowlist and give the pinned
   cross-encoder a real production caller inside `lib/server/attachindex` (an async rerank stage before
   budget packing), with honest `rerankMode`/`rerankReason` reporting plus a live ONNX job through
   `POST /api/ruke/ml/job`. No relabeling, no fake success.
3. Then the attended live groups in TASKS order: OCR engine + production passes, frame-OCR, held-out probe
   refresh, browser stage, then the unload windows.

## Gates standing from the last actual runs (scope stated, not re-run since)
- Python **383 tests OK** exit 0 (`f27-python-2.log`); vitest **2477 passed / 19 skipped** exit 0
  (`f26-vitest-2.log`); `npm run typecheck` exit 0 (`f26-typecheck-1.log`); `npm run contracts:check` exit
  0 (`f26-contracts-1.log`); Rust **351 passed** (`f23-cargo-4.log`); production build exit 0
  (`f23-build-1.log`). The j4 handoff **SAFE** suite (no unload) passed **14 scenarios / 0 misses**
  (`j4-handoff-20261117-052759.json`, 05:27). The `ho-h` held-out probe "8/0" figure is **stale**.
- F27 gotcha for anyone re-running probes: the typed error field is **`.error.reason`**, not `.error.code`.

## Next action (exact resume point)
Continue step 2: edit `rust-backend/crates/ruke-server/src/ml_job.rs` `ALLOWED_CAPABILITIES`, add
`lib/server/attachindex/rerank.ts`, refactor `retrieve.ts` into rank + pack so an async stage can reorder
before `pack()`, then run `cargo test -p ruke-server`, attachindex vitest, typecheck, `contracts:check`,
and a real cross-encoder job over HTTP on the live tree (`logs/f28-rerank-live-*`).
After that: the TASKS F28 live-OCR sequence, frame-OCR, probe refresh, browser, unload windows, final
gates, FINAL-REPORT, then stop pid 8044 and `cmd /c "shutdown.exe /s /t 0"` (never `/f`, record exit code).

## Open blockers / non-green items (with real reasons)
- pyannote diarization: gated model, licence not accepted. Never accept terms on the user's behalf.
- GPU OCR: no compatible CUDA paddle build pinned; `allow_gpu=False`. CPU is the only device ever run.
- 5 GB ceiling: the ml runtime is inside a Job Object with a **5,000,000,000 B commit ceiling**, but the
  measured peak of the primary OCR path is still missing -> an acceptance gap, not a satisfied gate.
- `speech.diarize` = `license_acceptance_required`; `artifacts.*` = `not_configured`.
- Legacy DOC/PPT: D-057, needs explicit authorisation plus a frozen fixture set (Office COM `Quit()` can
  discard the user's unsaved documents).
- `scripts\strata-low-ram.ps1 --ram-keep-gib` unapplied: needs a Strata restart (unauthorised), D-048.
- Numeric-fact rerank regression ("99 crates" vs "61 crates") fails under cross-encoder, bi-encoder and
  lexical. Kept failing on purpose and recorded.
- `Qwen3-*` assets unpinned and not executable by design.
