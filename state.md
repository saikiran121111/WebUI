# Codebase state — 2026-11-25

Snapshot of the Ruke WebUI repo at this moment. Written on request; implementation was stopped mid-task by the user. This file is a status record, not a plan of record — the overnight plan of record stays in `docs/overnight/STATE.md` (shared with external writers).

## 1. What this project is

Ruke: a local-first multimodal chat app.
- **Frontend/server:** Next.js (TypeScript) at repo root — `app/`, `components/`, `hooks/`, `lib/` (chat client, extract pipeline, attach-index retrieval, settings).
- **Rust backend:** `rust-backend/` (cargo workspace: `ruke-server`, `ruke-attach`, …). Rust owns active routes for chat/persistence/attachment retrieval and mirrors TS laws where it owns the live path (e.g. `retrieve.rs`).
- **Python ML:** `python-backend/ruke_ml/` — supervisor (`supervisor.py`) on loopback, job workers (`workers/speech_jobs.py`, `document_jobs.py`, `video_jobs.py`), engines (`speech/transformers_asr.py` = Parakeet TDT, `documents/` OCR cascade, `video/` frames).
- **One shared inference slot (Strata):** code work and live-model testing are exclusive; `.ai-coordination/playwright.lock` owns the workspace during live runs.
- **Live E2E:** Playwright specs in `tests/`, run ONLY through `scripts/run-browser-e2e-exclusive.ps1` (isolated app on :3000/:3101, e2e LLM proxy, handoff authorization).

## 2. Active assignment (overnight brief 2026-11-24/25, sent 7× verbatim)

One upload-to-answer repair assignment covering PDF, MP3, other audio, and video. User story: upload once, ask naturally, follow-up about any page/figure/time; Ruke reports precisely what could not be read; budgets/deadlines must never silently make source unreachable. Per defect: demonstrate through the production path with an isolated fixture, fix the owner, rerun the same case; mirror in Rust where Rust owns the active route. No commits (unauthorized by brief), no machine-setting changes, no model requests to probe availability, Strata slot yielded for live runs.

Item status (code shipped ⇒ gates green at ship time):
- **Item 1 — shared handoff failure, all media: SHIPPED (code).** Record-honesty, duplicate-render, waiting-turn, F142 worker-exit lease. Live rows ride item 6.
- **Item 2 — audio tail loss: SHIPPED (code).** Cap law head 20,000 + 200-segment tail; cappedSegments; fullTranscriptText/allSegments to chunker; RRF tie-break; strict-dominance shown ledger; Rust `retrieve.rs` mirror.
- **Item 3 — full-duration audio from a chat follow-up: SHIPPED (code), TS + Rust.**
- **Item 4 — video coverage independent of transcript length: PART 1 + 2 SHIPPED (code).** TS + python + Rust (cargo 795/0, contracts OK at ship).
- **Item 5 — engine-use proof + PDF/Office closure: SHIPPED (code) 2026-11-25, all gates green, records in.**
- **Item 6 — hard acceptance through production upload/chat paths: ACTIVE, BLOCKED** (see §3). 9-row live batch built, staged, gated; two live runs executed, both failed on row fr-F153f1 with the same root cause, now reproduced offline (§3).

## 3. THE LIVE BLOCKER — root cause found, fix not started

**Symptom (two f153b live runs, deterministic):** `POST /api/files/extract 422` — "au-1h.mp3: its spoken content could not be read. [speech backend: load_failed: Transformers could not load nvidia/parakeet-tdt-0.6b-v3: OSError: The paging file is too small for this operation to complete. (os error 1455)]". Run 2f483a0f and run 1ffc4c76 (1 worker, banner confirmed) failed identically (extractMs 103 s / 82 s). F153e (2026-11-24) failed the same way; this is the family behind F143's 14 recorded GPU-ASR failure rows ("C6 GREEN (conditional)").

**Reproduced offline** (`.data/tmp/file-regression/f153b-batch-1/injob-probe.log`, probe `C:\Users\Ruku\claude-tools\local-commands\f153-injob-probe.py`): process assigned to a real 16,000,000,000-byte Windows job object (the exact ruke-ml B8 mechanism) + production `transformers_asr.transcribe()` on the real 62-min fixture → **CUDA OOM: 19.31 GiB single allocation** in `modeling_parakeet.py:318` `matrix_bd = query_states_with_bias_v @ relative_key_states.permute(0,2,3,1)` (O(T²) relative attention; T≈18,000 tokens = 1440 s window × 12.5 tokens/s, h=16, fp32 → 4·h·T² ≈ 19.3 GiB). On Windows, GPU allocations beyond card capacity are WDDM system-memory-backed, so inside the 16 GB job the same attempt hits the job commit ceiling and surfaces as **os error 1455**, wrapped by `load_worker` as `load_failed`.

**Calibration** (`calibrate.log`, GPU 12.0 GiB total / 8.6 GiB free, dtype float32, outside any job):
| window | wall | CUDA peak |
|---|---|---|
| 300 s | 10.0 s | 4.22 GiB |
| 600 s | 83.9 s | 9.48 GiB |
| 900 s | 633.0 s | 18.11 GiB |
| 1440 s | — | ~97 GiB demand → 19.31 GiB matmul = hard OOM |

Both memory AND wall time are quadratic. Only ~300 s windows are safe on this GPU; the 1440 s window law guarantees failure on audio > ~600 s.

**Ceiling anatomy:** `job_limits.install_process_job` (B8 law): default measures the exclusive-window budget = `min(configured exclusive max, free commit − 2 GiB reserve)`; `EXCLUSIVE_LIMIT_BYTES_DEFAULT = EXCLUSIVE_LIMIT_CONFIG_MAX = 16 GB` — the measured window is HARD-CLAMPED at 16 GB, operator env `RUKE_EXCLUSIVE_LIMIT_BYTES` cannot exceed it. The documented operator path with NO clamp is `RUKE_ML_MEM_CEILING_BYTES` (supervisor.py:242 → `install_process_job` honours an explicit value as given, "an explicit value supplied by the caller"). Standalone worker peak commit (load + cuda placement) = 4.4 GB (measured, `K32GetProcessMemoryInfo`).

**Fix direction (decided, NOT implemented):** make the window law memory/time-aware in the owner (`transformers_asr.py`): cap the window by measured free VRAM (sqrt of O(T²) budget; ~240–300 s on this card), keeping MAX_FULL_ATTENTION_S as the upper bound, preserving F152 interval/coverage-gap/complete=False contracts. Also suspect: `TOKENS_PER_SECOND_BUDGET = 6.0` vs measured 12.5 tokens/s — the generate budget truncates every window's back half (root of item-2 tail loss at the engine level). No Rust mirror needed (transcription is python-owned; Rust only calls /job).

## 4. Live-batch harness (item 6) — current state

- Spec: `tests/fr-f153-live.spec.ts` — 9 rows f1/f2/f3/f4/g/h1/h2/i/j; **`test.describe.configure({ mode: "serial" })`** at line ~214 (reasons: f2–f4 reopen f1's chat; Strata-slot exclusivity; comment explicitly notes serial is required but is NOT the 1455 fix — run 1ffc4c76 evidence). Rows assert `identity().handoffAuthorized`.
- Submit kit: `.data/tmp/file-regression/f153b-batch-1/f153b-submit.ps1` — proxy identity (/__identity, /health), pre-lock --list gate (ExpectTotal 9, EXIT 88), handoff-lease precheck (EXIT 89), :3000/:3101 release-wait (owners printed, never killed), `-RequireIsolation -AuthorizeHandoff` (pin inverted per-run, recorded in launcher-identity.json), RUKE_OCR_ALLOW_UNLOAD=0, DONE sentinel, ASCII. Launch detached with -RedirectStandardOutput → `f153b-submit.out.log` (captures "Running 9 tests using 1 worker" banner).
- Sampler: `f153b-sampler.ps1` (NEW; watches `f153b-running`; host freeCommit/freePhys, per-process PrivateMemorySize64 top-12, supervisor /health) — created after batch-1's sampler watched the wrong sentinel (zero samples).
- Ledger: `docs/overnight/file-regression-fr-20261122a/results-live-f153.jsonl` — has both failed f1 runs (batch.identity, milestone, per-row records).
- 5-worker anomaly (run 2f483a0f): full mechanism never explained; config workers:1 demonstrably respected in batch-1 and relaunch; submit transcript froze at the Playwright banner (stdout backpressure suspected). Neutralized by serial mode + redirected stdout.
- Fixtures staged in `.data/tmp/file-regression/fr-20261122a/dl/live/` via `stage-f153b.ps1`: au-1h.mp3 (62:13.21), au-clip.{wav,m4a,aac,ogg,flac}, vid-sparse.mp4 (32:00.05), vid-quiet.mp4 (10:00, no audio). Answer keys (SEMANTIC grading law): `docs/overnight/fixtures/f153/au-1h-key.json`, `vid-sparse-key.json`.

## 5. Gates and baselines (all GREEN before this live batch)

From `python-backend/`: `.venv/Scripts/python.exe -m unittest discover -s tests -t .` → **py 831/0** (skipped=1). Vitest: `node node_modules/vitest/vitest.mjs run <file>` → **2868/0** (25 skipped). `npx --no-install tsc --noEmit --incremental false` → **0** (redirect to file; npm notices pollute the tail). `npm run contracts:check` → OK. Cargo: `CARGO_TARGET_DIR=D:/Projects/WebUI/WebUI/.data/tmp/cargo-f78 cargo test --workspace` → **795/0**; NEVER `cargo fmt --all`. Frozen matrix: **105/119** with 14 F143-recorded GPU-ASR failure rows (kept SEPARATE from F153 rows).

## 6. Working tree (branch `local`, main = `main`, NO commits authorized)

~90 uncommitted files from the F152/F153 line: TS (chat route, page, ChatInput, EnginesSettings, DocumentCard, useChat, chat client/compact/composerGate, dataQuality, docProcessor, disk persistence, attachindex build/retrieve/store/turn/types, extract document-capability/ffmpeg/index/speech-capability, settings client, types), python (documents legacy/ocr/ocr_cascade/ocr_tesseract/parser/pdf, speech levels/transformers_asr, video frame_ocr, workers document/speech/video jobs, 6 test files), Rust (ruke-attach lib/retrieve/store/turn/types, ruke-server chat mod/pipeline/persistence, store_compat, 4 attachment fixtures), tests/__tests__ (9 files), `scripts/run-browser-e2e-exclusive.ps1`, `styles/document-viewers.css`, docs (STATE.md, results-live.jsonl, f50 probe).
Last commits: `7334563` F79–F151, `83bbce3` F78, `3295f43` F77.

## 7. Standing constraints (inherited, verbatim law)

No commits (this brief); web search/browser/machine settings/paused follow-up untouched; foreign port listeners printed, never killed; Strata slot exclusive, never remove another session's lease, never unload/restart the coding model mid-turn; live tests foreground via the exclusive launcher only; active `.ai-coordination/playwright.lock` = wait; never `git checkout --` a dirty file; CRLF-tolerant edits (STATE.md has external writers — grep -n verify entries landed); ASK before any system-wide install (repo-scoped only); "A plausible answer alone does not pass"; keep the 105/119 frozen matrix, the earlier exact-time video pass, the MP3 admission refusal, and the F153 retries SEPARATE; on a failure, keep going across the feature list, then return to recorded failures.

## 8. Next unfinished actions (in order, for the next session)

1. Implement the memory-aware window cap in `python-backend/ruke_ml/speech/transformers_asr.py` (owner): derive the window bound from measured free VRAM (O(T²) law, calibration §3: ~300 s safe on this 12 GB card) + fix `TOKENS_PER_SECOND_BUDGET` (6.0 → measured 12.5 + margin) so generate covers the whole window; keep MAX_FULL_ATTENTION_S as upper bound; preserve coverage-gap / complete / F152-interval contracts.
2. Add a pure window-size math unit test (no GPU); run py gate; rerun the 16 GB in-job probe on au-1h.mp3 → must complete with complete=True.
3. Relaunch `f153b-submit.ps1` (9 serial rows), verify the 1-worker banner + single batch.identity, watch `results-live-f153.jsonl` row by row, collect f153b-mem/host CSVs.
4. Records: ISSUES.md row for the 1455/OOM root cause + STATE.md entry (grep -n verify) + update the media-brief checkpoint (`memory/checkpoint-media-upload-answer-f153.md`).
5. Then the 7-point-brief queue (tasks #6–12: history loss/deleted-chat resurrection, send/edit/stream ownership, settings commit validation, compaction promotion, fenceRepair complete-replacement, reread targeting, grader strictness + baseline regressions for the six passing fixes). "A passing test group supports only the behavior it exercised."
6. Tell the user: the **ghidra MCP server failed to connect** (ECONNREFUSED — connection failure, not unconfigured).

## 9. Loose ends / watch-list

- Calibration heads/layers read `None` from `model.config` (attribute names differ on the Parakeet config object) — the fix must read heads from the real config path when computing the cap.
- shown-ledger flake: watch for recurrence.
- 5-worker parallelism mechanism: unexplained, neutralized.
- ctypes commit-measurement law: use `kernel32.K32GetProcessMemoryInfo` with argtypes/restype set (psapi GetProcessMemoryInfo via bare ctypes silently returns zeros).
