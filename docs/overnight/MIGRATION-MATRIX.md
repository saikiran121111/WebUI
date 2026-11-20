# MIGRATION-MATRIX - authoritative completion matrix (F21 rewrite of the F12 matrix)

One row per required capability. **Migration status and functional status are separate**: a working
retained TypeScript implementation is NOT a completed Python migration. Status changes only on
evidence of real production execution plus acceptance - never because a package installed, a model
downloaded, an endpoint returned 200, or mocked tests passed.

Status vocabulary: **GREEN** required implementation + acceptance checks passed; **ORANGE** partially
implemented or insufficiently validated; **RED** missing, broken or unusable; **BLOCKED** a concrete
external constraint (credential, licence, hardware, policy) prevents completion. **HELD** = the
acceptance run is deliberately deferred to an attended session (amendment 6 / D-052); a HELD item is
never GREEN.

## Evidence keys (all files under `docs/overnight/logs/` unless noted)

| key | command | result |
|---|---|---|
| `tsc0` | `npx tsc --noEmit --incremental false` | 0 errors, exit 0 - f20-tsc-1.log |
| `cargo351` | `cargo test -p ruke-server -p ruke-decision --target-dir D:\Projects\WebUI\target-ci` | 351 passed, 0 failed, exit 0 - f20-cargo-1.log |
| `py339` | `python-backend\.venv\Scripts\python.exe -m unittest discover -s tests -t .` | 339 tests OK, exit 0 - f20-python-full-1.log |
| `contracts0` | `npm run contracts:check` | generated == committed, exit 0 - f20-contracts-1.log |
| `build0` | `npm run build` | exit 0 - f20-build-1.log |
| `vit2461` | `npx vitest run` | 2461 passed / 19 skipped / 0 failed, 244.7 s, exit 0 - f20-vitest-full-2.log |
| `ho-h` | `node docs/overnight/probes/f09_heldout_http_probe.mjs` (production upload -> extract -> answer, scored against `docs/overnight/fixtures/f09/answer-key.json`, key `f10-heldout-1`) | **8 fixtures, 0 misses** - f09-heldout-2026-11-16T142705900Z.json; scored while the dev tree was up (F15/F16 window) and **not refreshed** in F20/F21, when the tree was down |
| `f06-h` | F06 HTTP probe set - f06-http-*.json | pdf/xlsx/docx/pptx extraction truths |
| `e03` | live CPU ASR probe (real audio, real CT2 weights) | ok, failures [], WER 0.0769 / 0.0, peak WS 388.0 MiB, gpu_violations null - f18-e03-1.log + e03-speech-20261116T16564630343.json |
| `tess-exec` | real Tesseract run over 2 rasterised pages | v5.5.3.20260724, langs eng+osd, **WER 0.0 both pages**, conf 0.9631 - f19-tesseract-exec-20261116T223657.json |
| `ocr-assets` | `python -m ruke_ml.models.prepare --pipeline PaddleOCR-VL-1.6` | ok:true, both revisions complete on disk - f21-ocr-assets-1.out.log |
| `ocr-ready` | readiness probe through the runtime manifest | ready:true, blockers [], est_peak_mib 3300 (provisional), est_peak_vram_mib 6000, cpu_only_verified:false - f21-ocr-readiness-1.log |
| `paddle-dev` | static paddle device probe | `{"paddle":"3.2.1","compiled_with_cuda":false,"device":"cpu","mkl-dnn":false}` - f19-paddle-device-1.log |
| `g04` | neural embedding probe (real ONNX MiniLM) | 384-d, CPUExecutionProvider, peak RSS 164 MiB, **7/9 checks, numeric failure kept** - g04-neural-embed-1.log, g04-neural-embed-2.log |
| `memtree` | whole-tree memory sample, main LLM excluded | idle RSS 1568 MiB / PRIV 2126 MiB - f18-tree-1.log |

## Delta since the F12 matrix (what actually moved, and what did not)

- `ho-h` went from **13 misses across 6 fixtures** to **0 misses**; the failing checks were delivery-layer
  defects (promotion law treating honest corruption reports as lost content, empty-delivery paths), fixed
  in `lib/server/extract/index.ts`, `office.ts` and the Python readers - not fixture edits.
- "No OCR/ASR/neural has ever executed" is no longer true: ASR executed live with real weights (`e03`),
  Tesseract executed on real rasterised pages (`tess-exec`), the neural embedder executed on real ONNX
  weights (`g04`), and the OCR asset set prepared successfully (`ocr-assets`).
- **Still not executed: the PaddleOCR-VL primary pipeline and the Strata load/unload handoff.** Both are
  code-complete and unit-tested, and both runs are HELD (D-052) because they need an attended screen and
  would page the machine at the current free-RAM level.
- There was no memory ceiling mechanism at F12; there is now a Windows job object plus `memory_pressure`
  admission and a commit-charge clamp (D-048), unit-tested but with no measured cold-load peak.
- There was no cross-client handoff at F12; the lease now exists in Rust, TS and Python (D-049), untested live.

## Matrix

| # | Capability | Current implementation | Intended owner | Production caller | Deps/assets | Tests | Integration evidence | CPU/RAM | Remaining work | Migration status | Functional status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | Model-led intent (task/tool/output selection) | chat tool loop `lib/chat/web-tool-loop.ts` with `web_search`/`read_page`; Hybrid Decision Engine `lib/decision/*` + `rust-backend/crates/ruke-decision`; **`lib/web-search/search-gate.ts` still gates availability on `WEB_INTENT_RE`/`FRESHNESS_RE`/code-task regex** | main model for semantics, code for structure | chat turn -> tool loop -> search gate | Strata capacity-1 | `__tests__/decision/generalization-f02b.test.ts`, decision fixtures | tool loop is live in production; no validated end-to-end model-chosen output plan | n/a | retire the availability regexes once the model-selected path is proven live; keep explicit UI export deterministic | **ORANGE** - replacement path live, phrase rules NOT retired | ORANGE - works, but availability is still keyword-gated |
| B | Code-led upload processing (container/track inspection, reader registry, native-first) | `lib/server/extract/{index,sniff,document-capability}.ts` + Python `documents/parser.py` kind dispatch | code (structure) | `POST /api/files/extract`, attach upload | pypdf, OOXML zip | `py339`, ho-r | **`ho-h` 8 fixtures / 0 misses**; signature-vs-extension and corrupt handling reported honestly | `memtree` idle | audio-only container probes, per-unit escalation live | **GREEN** for tested scope | ORANGE |
| C1 | PDF native reading | `ruke_ml/documents/pdf.py` (pypdf 7.1.0, per-page units, rotation, column order, page_failures) | Python | documents.parse -> ml_job -> supervisor | pypdf==7.1.0 | `py339`, ho-r | `f06-h` late evidence / rotated / two-column / honest "page 3 not read"; `ho-h` formula page + code page + page-7 late evidence all pass | per-worker RSS not measured | ToUnicode CMap fixture gap remains an explicit gap | **GREEN** for native scope | GREEN for native/mixed with recorded gaps |
| C2 | Scanned/mixed PDF OCR through production | reader + rasterizer + escalation ladder coded; production path never run | Python PaddleOCR-VL (primary) + Tesseract (recovery) | documents.ocr capability | assets **prepared** (`ocr-assets`) | routing tests only | **none** - never run end to end | not measured | run 16.6 (HELD) | **ORANGE / HELD** | **RED** (no OCR has ever run inside a job) |
| C3 | DOCX reading | `parser._docx` (paragraphs, named-style headings, `table_no`, `not_extracted`) | Python | documents.parse | stdlib zip/XML | `py339`, ho-r | `ho-h` ho-catalog: 6/6 must + coverage; pipe-in-cell survived | not yet | embedded images, nested/merged tables, relationships | **GREEN** for tested scope | GREEN tested / ORANGE full fidelity |
| C4 | PPTX reading | `parser._pptx` (slide order by part, notes parts, `not_extracted`) | Python | documents.parse | none | `py339`, ho-r | `ho-h` ho-slides: 4/4 must + coverage incl. Japanese + accented speaker note | not yet | slide images, relationships | **GREEN** for tested scope | GREEN for tested scope |
| C5 | XLSX reading | `parser._xlsx` cellwise: merged geometry both directions, types, formula vs cached value, empty/corrupt cells, sheet_failures | Python | documents.parse | none | `py339`, ho-r | `ho-h` inventory/corrupt/badxml now **pass** (was 8 misses at F12); promotion law fixed per D-045 | not yet | none required for tested scope | **GREEN** reader + production | GREEN for tested scope |
| C6 | Legacy DOC/PPT | none | tested CPU conversion, else honest unsupported | documents.parse dispatch | external converter (absent) | none | none | none | converter is not present in-project; typed `unsupported_input` returned | **RED** for conversion | ORANGE - honest refusal works, conversion does not exist |
| D1 | OCR engine: PaddleOCR-VL 1.6 full pipeline | implemented: layout (PP-DocLayoutV3) + recognition + structured assembly, CPU device pinning, worker interp wiring | Python | documents.ocr via worker launcher | **prepared**: PaddleOCR-VL-1.6 @ `132c45f5...` (model.safetensors 1,917,255,968 B); PP-DocLayoutV3 @ `241f8bdf...` (inference.pdiparams 130,806,572 B); `.venv-ocr` with paddlepaddle 3.2.1 / paddleocr 3.6.0 / paddlex 3.6.1 / opencv-contrib 4.10.0.84 | `py339` manifest/contract tests | **pipeline never executed** (HELD, D-052) | `est_peak_mib 3300` **provisional**, `est_peak_vram_mib 6000`, zero GPU observed | run the real complex document (16.6) then measure cold/processing peaks | **ORANGE / HELD** - prepared + unit-tested, never executed | **RED** until the document run passes |
| D2 | OCR engine: Tesseract recovery | `.data/tools/tesseract/tesseract.exe` **installed in-project**, engine_state/rasterizer_state/ocr_status, per-unit recovery | Python | documents.ocr | tesseract 5.5.3.20260724, tessdata **eng + osd only**, pypdfium2 5.6.0 | `py339` | **engine-level**: 2 real pages @200 dpi, WER 0.0 both, `missing_content_words: []` (`tess-exec`) | CPU only, small | trigger fallback *inside a production job*; report real language coverage honestly | **ORANGE** - installed and executed standalone | ORANGE - eng/osd only, not a general-language claim |
| D3 | OCR escalation + fallback ladder + provenance | primary -> <=1 deterministic repair -> release primary -> Tesseract; typed non-retryable set per D-044; `ocr_units` provenance | Python | documents.ocr + TS capability doc | both engines | `py339` ladder tests | **ladder never run** (HELD) | n/a | live ladder evidence | **ORANGE** | RED |
| E1 | ASR (CPU, Python) | `speech/whisper_ct2.py` (faster-whisper 1.2.1 / ctranslate2 4.9.0), language tags from the pinned backend via `speech/languages.py` | Python | `workers/speech_jobs.py` -> ml_job -> upload/attach | `Systran/faster-whisper-base` CT2 snapshot, **prepared** | `py339` | **live**: `e03` ok, failures [], WER 0.0769 / 0.0; silence -> `payload_state: silence`; typed `unsupported_input` x3, `corrupt_input`, `model_unavailable`, `license_acceptance_required`; no-track vs silence distinguished | **peak WS 388.0 MiB**, `gpu_violations: null` | none required for tested scope | **GREEN** for tested scope | GREEN with recorded limits |
| E2 | Forced alignment | adapter alignment path + `speech/alignment.py` exclusion fix keyed to the real registered aligner | Python | speech.align | same CT2 asset | `py339` | `words` arrays present in live ASR payloads; standalone align round trip **not probed** | inside the 388 MiB ASR peak | probe alignment separately from ASR | **ORANGE** | ORANGE - honest segment timestamps preserved when word timing unavailable |
| E3 | Speaker diarization | none executed; gated external dependency | gated service | speech.diarize | HF token + licence acceptance | - | returns typed `license_acceptance_required` - stays visibly unavailable | none | user licence acceptance or an unlicensed alternative | **BLOCKED** | RED and stays RED |
| F | Video: decode, cuts, timeline honesty, observations, hints | `video/scenes.py` (real cut scan, dual-pipe drain, `prefix_measured`), runner plan-vs-measured coverage, `attachindex/timeline.ts` mirror, frame OCR reuses the CPU OCR worker | Python + TS/Rust | video.*, attach index build | ffmpeg probe | `py339`, `__tests__/attach-timeline-f04.test.ts` (24), shared fixture `rust-backend/fixtures/media/measured-prefix-v1.json` | declared cuts 3/3, decode prefix 11.9/12.0 s, honest plan note | not measured per stage | frame OCR never run through a video job (HELD with D1); no visual-understanding claim | **ORANGE** | ORANGE - plan/decode honesty GREEN, semantic video understanding absent |
| G1 | Embeddings (lexical baseline) | hashed lexical vectors, labelled lexical | Python | retrieval capability | none | `py339` | retrieval integration tests | not yet | keep labelled as fallback | **GREEN** as *lexical* only | ORANGE - never presented as neural |
| G2 | Embeddings (neural) | `retrieval/nn_embed.py` real ONNX MiniLM executor | Python | embeddings capability | `Xenova/all-MiniLM-L6-v2`, sha256 `759c3cd2...c469c46e`, prepared | `py339` | **executed standalone** (384-d, CPUExecutionProvider, 164 MiB) but **no production caller** - TS `attachindex/{retrieve,embed}.ts` remains the live owner (D-046, `store_compat` byte-exactness of `fixture_01_rust_block_is_ts_block`) | peak RSS 164 MiB | decide + execute the swap, then re-run store_compat and retrieval integration | **ORANGE** - executed, not wired | ORANGE |
| G3 | Reranking | neural cross-encoder adapter coded; lexical fallback labelled | Python | rerank capability | cross-encoder weights **absent** | `py339` | adapter correctly **refused** to claim readiness; hybrid RRF justified by `g04` (neural picked "61 crates" over "99 crates", BM25 ranked numeric-correct first) - threshold **not** relaxed | n/a | obtain weights or keep hybrid-lexical and say so | **ORANGE** for hybrid/bi-encoder, **RED** for cross-encoder | ORANGE lexical / RED neural rerank |
| H1 | Artifact XLSX/DOCX/PPTX writers | TypeScript `lib/documents/{xlsxEngine,docxEngine,pptxEngine}.ts` | **retained TS** (architectural decision, not a migration) | artifact endpoints / render modes | npm deps | `vit2461` | render + reopen tests | not measured | Python parity not attempted | **RED (not migrated)** - deliberately retained | ORANGE/GREEN functionally |
| H2 | Created PDF/DOCX generation + resume/chart engines | `pdfEngine.ts`, `resumeHtml.ts`, `chartHtml.ts` + existing resume engine, `recalc.ts` | **retained TS** | renderer validators, resume/chart integration | npm deps | `vit2461`, `build0` | no duplicate engines built (as required) | not measured | reopen+render inspection at acceptance | **RED (not migrated)** | ORANGE |
| I1 | think-tag separation, literal code preservation | `lib/stream/thinkTags.ts` + Rust `chat/scrubber.rs` parity fixtures | TS + Rust | real chat stream + persisted answer | none | `__tests__/think-splitter.test.ts`, `rust-backend/fixtures/sse/02-think-split-matrix.json`, `cargo351` | code-owned scope green; live stream consumer re-check HELD with browser work | n/a | live re-check | **GREEN** code-owned | ORANGE until live re-check |
| I2 | Activity states tied to real jobs (reading/OCR/thinking/answering), stale-event rejection, no duplicate terminal | run/job IDs + explicit transitions in the TS/Rust chat loops | TS + Rust | chat stream | none | `vit2461`, `cargo351` | **not browser-verified this session** | n/a | browser acceptance (HELD) | **ORANGE** | ORANGE, unverified |
| I3 | Scroll ownership, copy/export text | `lib/ui/scrollFollow.ts` (single owner) + `__tests__/scroll-follow.test.ts` | TS | chat UI | none | `vit2461` | offline only; long-stream + delayed image/code layout not observed | n/a | Playwright exclusive run (HELD) | **ORANGE** | ORANGE, unverified |
| J1 | One-command supervision (Next+Rust+Python) | `scripts/dev-supervisor.mjs` + lazy worker host + idle TTL | Node/Rust/Python | `npm run dev` | capability extras via `[tool.ruke] capability_extras` | `py339`, dev probes | supervisor wiring previously observed (next :3000, ruke-server :3101, python endpoint :54565) | idle once | **the dev tree is not running at this checkpoint** - re-verify next morning | **GREEN** | GREEN |
| J2 | Explicit asset preparation (no startup downloads) | `models/prepare.py` + `models/assets.py` offline scan; startup downloads nothing | Python | explicit setup | huggingface-hub | `py339` | **preparation executed for real**: CT2 whisper, OCR pipeline pair (`ocr-assets`), MiniLM ONNX | n/a | offline-after-prep load check still unmeasured | **GREEN** | GREEN |
| J3 | Resource ceiling (4 GB target / 5 GB hard max, main LLM excluded) | Windows **job object** on owned workers + `memory_pressure` admission + commit-charge clamp (D-048) | Python/Rust | ml_job admission | none | `py339`, `cargo351` | idle baseline only; no cold-load/processing peak measured | idle RSS 1568 MiB / PRIV 2126 MiB | measure peaks during HELD 16.6; note the free-RAM tradeoff (STRATA-RAM.md) | **ORANGE** - ceiling coded + unit-tested, **not** peak-verified | ORANGE |
| J4 | Resource-aware device choice + main-LLM unload/reload handoff (amendment 5) | `.ai-coordination/llm-handoff.lock` lease across Rust/TS/Python, `models/{devices,resources}.py`, `handoff.py`, journal `.data/python/handoff-journal.json`, progress states waiting -> unloading -> processing -> releasing -> restoring -> ready | Rust+TS+Python, provider-independent coordinator (Strata first) | ml_job admission + Strata lifecycle | Strata lifecycle endpoints | `py339`, `cargo351`, `test_handoff_devices.py` (769 lines) | **never executed live** (HELD, D-052) - needs an attended screen and the capacity-1 endpoint | n/a | run 17.8 acceptance matrix | **ORANGE / HELD** | ORANGE |
| J5 | GPU execution when it fits (amendment 5 supersedes CPU-only) | device planner prefers a compatible GPU when RAM+VRAM fit, falls back to CPU | Python | worker launcher | CUDA-capable paddle build | - | **not possible with the pinned build**: `paddle-dev` shows `compiled_with_cuda:false` | CPU only, zero GPU observed | either keep CPU and report the limit, or pin a separate CUDA build (not done) | **ORANGE** | GPU path RED; CPU path works |

## Global verdict at this checkpoint

**PARTIAL.** Not COMPLETE. The mandatory items below are not GREEN:

1. **Primary OCR (D1/C2/D3)** - prepared and unit-tested, never executed on a real document. HELD for an
   attended run (D-052), because the provisional 3300 MiB cold-load peak plus the resident main LLM
   exceeds the free-RAM headroom on this host and needs supervision.
2. **Strata unload/reload handoff (J4)** - code-complete, unit-tested, never executed live. HELD.
   **CORRECTED at F51:** the unload/reload half WAS executed live at F32 - `POST /unload` returned 200
   and freed **51,079 MiB of physical RAM and 9,483 MiB of VRAM**, `GET /health` then reported
   `loaded: false`, the plan was recomputed inside the window, restore returned 200 "loaded and ready",
   and the lease was removed (`logs/f32-ocr-stageA-1.log`, `logs/j4-handoff-20261117-052759.json`).
   What is still owed is the **content** half: primary OCR on a real page, and the chat-continuation
   trace after restoration. See the F51 ledger at the end of this file.
3. **No production-triggered Tesseract fallback** - the engine ran standalone, not as a recovery inside a job.
4. **Neural retrieval (G2/G3) has no production caller**; cross-encoder weights absent. Artifact writers
   (H1/H2) are **retained TypeScript**, so their Python-migration status is RED by definition, not "done".
5. **Diarization (E3) BLOCKED** on licence acceptance - deliberately not bypassed and not faked.
6. **No browser acceptance this session** - I2/I3 live behaviour unverified.
7. **Per-stage worker RSS and offline-after-prep loading not measured**; the memory ceiling is coded and
   unit-tested but its peak has never been observed.

**No acceptance threshold was relaxed to obtain any of the passing results.** The `g04` neural numeric
error was kept as a failing check, and `tess-exec` ground truth was authored before the engine output
existed.

Deferred by instruction: HTML viewer, questionnaire, interactive browser features.

---

## F26 authoritative status table (supersedes the rows above wherever they differ)

Migration status and functional status stay separate. A retained-but-working TypeScript owner is
**not** a completed Python migration. HELD means the code exists and is unit-tested but the acceptance
run was deliberately deferred to an attended session; a HELD item is never GREEN.

| area | migration | functional | what is true now | evidence | what is still owed |
|---|---|---|---|---|---|
| A model-led intent | **ORANGE** | GREEN in parts | model-side tool selection, structured validation and one bounded correction exist; explicit UI export stays deterministic; Strata capacity-one respected | `py375`, `vit2477`, decision-ownership doc | the phrase rules in `lib/web-search/search-gate.ts` are still live; retiring them needs a real-model run that cannot overlap the coding agent |
| B code-led upload processing | **GREEN** (mechanics) | GREEN | signature/container/track inspection, reader registry, native-first with per-unit escalation, permission and resource admission in code | `py375`, `vit2477`, `ho-h` | nothing open in scope; live refresh owed with the dev tree |
| C1 PDF native | **GREEN** | GREEN | pypdf 7.1.0 per-page units, rotation, column order, page_failures | `py375`, `ho-h` | - |
| C2 scanned/mixed PDF through production | **ORANGE / HELD** | ORANGE | cascade + escalation + provenance wired; production upload path never executed with a real engine | `py375`, d1 corpus + probe self-check 14/14 | attended run: `scripts\run-ocr-acceptance.ps1 -AllowUnload -ConfirmUnload UNLOAD`, engine **and** `-StartDev` production path |
| C3-C5 DOCX/PPTX/XLSX reading | **GREEN** | GREEN | native paragraphs/tables/notes/cell types + formulas + cached values + merges, honest `not_extracted` | `py375`, `ho-h`, `f06-h` | - |
| C6 legacy DOC/PPT | **RED** | honest unsupported | no in-project CPU converter; the reader returns an unsupported-format result instead of guessing | `py375` | a tested converter or an explicit "not supported" product decision |
| D1 PaddleOCR-VL 1.6 full pipeline | **ORANGE / HELD** | **not verified** | assets pinned and complete on disk, isolated CPU runtime pinned, worker + device pinning coded, readiness CLI says ready | `f25-ocr-readiness-1.log`, `ocr-assets`, `paddle-dev` | the pipeline has **never executed** on this host: no content/structure/coverage evidence, no measured cold-load peak (est. 3300 MiB RAM / 6000 MiB VRAM, explicitly provisional) |
| D2 Tesseract recovery | **GREEN** (engine) | GREEN at engine level | project-local `v5.5.3.20260724`, languages `eng, osd` reported live, reproducible prepare/verify script, real image->text run 20/20 key words | **`f26-tess-verify-5.log` exit 0**, `f26-tess-pin-recheck-1.log`, `tess-exec` WER 0.0 | a *triggered* fallback inside a production upload (HELD, attended) |
| D3 escalation/fallback ladder + provenance | **ORANGE** | ORANGE | primary -> <=1 repair -> release primary -> Tesseract, typed non-retryable set, `engines_used` / `units_unresolved` / `units_not_read` | `py375` (fault path unit-tested) | real fault injection through the live worker (HELD) |
| E1 ASR | **GREEN** | GREEN | faster-whisper 1.2.1 / ctranslate2 4.9.0 live on real audio, WER 0.0769 / 0.0, peak 388 MiB, zero GPU | `e03` | - |
| E2 alignment | **ORANGE** | ORANGE | adapter + exclusion fix keyed to the registered aligner; segment timestamps preserved when word timing is unavailable | `py375` | live word-timing evidence on real speech |
| E3 diarization | **BLOCKED** | unavailable | returns typed `license_acceptance_required`; never bypassed, never accepted for the user | `py375` | pyannote token + licence acceptance |
| F video | **ORANGE / HELD** | ORANGE | real cut scan, plan-vs-measured coverage honesty, `video.frame_ocr` dispatched in Python **and** called from the TS timeline with frame/text caps | `py375`, frame-OCR + s60 tests | real slide-heavy video with `frameRead.recognised > 0`; late-event evidence; semantic interpretation stays explicitly limited |
| G1 lexical retrieval | **GREEN (as lexical)** | GREEN | hashed lexical vectors, labelled lexical, hybrid RRF kept because the neural numeric gate did not pass | `py375` | - |
| G2 neural embeddings | **ORANGE** | ORANGE | ONNX MiniLM real executor, 384-d, CPU EP, 164 MiB, **7/9 checks with the numeric failure kept** | `g04` | owner decision (D-046: TS still owns production retrieval) |
| G3 reranking | **RED (neural) / GREEN (labelled lexical)** | ORANGE | cross-encoder weights absent; adapter refuses rather than posing as neural | `py375` | weights |
| H1-H2 artifact creation | **RED for Python migration** | GREEN | XLSX/DOCX/PPTX/PDF/chart/resume writers **retained in TypeScript** and working; reopen/render checks exist | `vit2477`, `build0` | this is a retained-owner decision (D-042 style), so its Python-migration status stays incomplete by definition |
| I1-I3 streaming/UI | **ORANGE** | ORANGE | think-tag separation with TS/Rust parity fixtures, rotation declared through delivery, activity/ownership rules coded | `vit2477`, `tsc0`/`f26-typecheck-1.log`, cargo 351 | live browser verification (HELD): long streams, delayed image/code layout, copy/export text, scroll stability |
| J1-J2 startup/preparation | **GREEN** | GREEN | one `npm run dev` supervises Next+Rust+Python, lazy workers, explicit asset preparation, nothing downloaded at startup | `py375`, earlier live dev trees | re-verify with the dev tree tomorrow |
| J3 memory ceiling | **ORANGE** | ORANGE | job object on owned workers + admission + commit clamp; whole-tree idle 1568 MiB WS / 2126 MiB PRIV measured | `memtree` | **hard 5 GB ceiling not proven under OCR load** - the OCR peak has never been measured; today's headroom is only 7308 MiB free |
| J4 unload/reload handoff | **ORANGE** (was "ORANGE / HELD, never executed live") | partial, safe | lease across Rust/TS/Python, phases journaled, recovery for restart, **no process-killing path at all** (D-054); the unload/restore round trip **was executed live at F32** (51,079 MiB RAM + 9,483 MiB VRAM freed, restore "loaded and ready", lease removed) | `j4-safe-console-2.txt` 14 scenarios 0 misses; `f32-ocr-stageA-1.log` | primary OCR content inside a real window, the chat-continuation trace, and the 5 attended fault/cancel/restore-failure scenarios; also only PARTIAL for the internal-completion 503 gate (per-run bridge secret) |
| J5 GPU when it fits | **BLOCKED today** | CPU only | 2633 MiB free VRAM and a `compiled_with_cuda False` pin; policy `allow_gpu=False` with a documented unblock path | `f19-paddle-device-1.log`, today's `nvidia-smi` | a CUDA-enabled pinned build in the isolated runtime + `RUKE_OCR_ALLOW_GPU=1`, then re-measure |

New F26 evidence keys: `py375` = `logs/f26-python-1.log` (375 tests OK, exit 0);
`vit2477` = `logs/f26-vitest-2.log` (2477 passed / 19 skipped, exit 0; run 1 had the one load flake,
isolated pass in `logs/f26-vitest-audio-isolated.log`); `tsc-f26` = `logs/f26-typecheck-1.log` exit 0;
`contracts-f26` = `logs/f26-contracts-1.log` exit 0; `j4safe` = `logs/j4-safe-console-2.txt` +
`logs/j4-handoff-20261117-052759.json`; `tess-verify` = `logs/f26-tess-verify-5.log` exit 0;
`tess-pins` = `logs/f26-tess-pin-recheck-1.log`.

## F27 authoritative delta (supersedes the G3/J2 rows above wherever they differ)

Same rules: migration status and functional status stay separate, and HELD is never GREEN.

| area | migration | functional | what is true now | evidence | what is still owed |
|---|---|---|---|---|---|
| G3 reranking | **ORANGE** (was RED for neural) | ORANGE | a **real neural cross-encoder** now exists and executes: `retrieval/nn_rerank.py`, `Xenova/ms-marco-MiniLM-L-6-v2` @ commit `a09144355adeed5f58c8ed011d209bf8ee5a1fec`, `onnx/model.onnx` 90,992,115 B sha256 `c623d0bc...881870` re-verified at every load, CPUExecutionProvider enforced, joint (query,passage) scoring, 256-token window with **reported** truncation. Registry row names the same ids/adapter and records `beats_dense_biencoder_on_g05_set: False`, `numeric_fact_case_fixed: False`, `production_caller_wired: False` | `f27-rerank-download-1.log`, `f27-rerank-prepare-2.log`, `f27-g05-rerank-2.log` (mechanics 7/7; top-1 9/10, MRR 0.950, ties the bi-encoder, lexical 7/10; peak WS 267.7 MiB; 481 ms for 30 reranks), `f27-g04-rerun-1.log` (7/9 with both numeric failures kept), `f27-python-2.log` 383 OK | **no production caller**: `rerank` is excluded from the Rust ml-job allowlist and TS `attachindex/{retrieve,embed}.ts` still owns live retrieval (D-046 open). The numeric-fact miss is a documented regression, and English-only coverage is a measured limitation, not a claim |
| J2 asset preparation | **GREEN** (strengthened) | GREEN | `models/prepare.py --local` + `assets.prepare_local()` write **`asset-manifest.json`** with pinned commit, retrieval time, staging cache and per-file sha256 next to the asset. The MiniLM **embedder** asset previously had no origin record on disk at all; that provenance gap is now closed for it too by the same mechanism | `f27-rerank-prepare-2.log` exit 0 + `.data/models/Xenova/ms-marco-MiniLM-L-6-v2/asset-manifest.json` | offline-after-preparation load check still unmeasured (it is a startup-path check, owed with the dev tree) |
| C6 legacy DOC/PPT | **RED** (unchanged, now a recorded decision) | honest unsupported | Office 16 is installed and `Word.Application`/`PowerPoint.Application` are registered, so COM conversion is feasible on CPU - but it was **not** built: the acceptance corpus is frozen with no legacy ground truth authored, and COM `Quit()` can discard the user's unsaved Office documents. The reader returns typed `unsupported_input` naming the real blocker | `py375`, DECISIONS **D-057** | explicit user authorisation for Office COM conversion (or an in-project LibreOffice), **plus** a frozen legacy fixture set with expected text/tables, then a bounded converter implementation |

Unchanged from F26 and still the honest bottom line: the whole **HELD** set (live primary OCR run, live
Strata unload/reload, browser/Playwright, frame-OCR live evidence, model-led routing live validation) is
**coded, unit-tested and operator-wrapped but not executed**, so C2/D1/D3/F/J4/I1-I3 stay ORANGE and the
overall verdict stays **PARTIAL**. Verdict: **PARTIAL**, roughly 80% complete.

## F51 done-state ledger (supersedes any older "never executed live" claim in this file)

The older wide tables above were written at different times and drift; this ledger is the current
four-state record. It does not restate the 26 rows, it says what is actually true now and where each
older contradiction is resolved. A capability is GREEN only when the acceptance-passed column is filled.

| area | implemented | production-wired | actually executed | acceptance-passed | status / what is owed |
|---|---|---|---|---|---|
| A model-led decisions, tool loops, artifact intent | yes | yes (chat SSE tool loop, fence router, contract injection) | yes for web research and attachment reading in past live sessions; **semantic-selection acceptance is an attended live-model item** | no | ORANGE. `detectDeliverableIntent` is advisory only (D-070); search availability is model-authoritative with deterministic force layers; the prose-instead-of-fence catalogue fix stays designed work with a named path |
| B code-led upload processing (sniff/registry/native-first/escalation) | yes | yes (`extractFileFromPath`, attach index, capability rows) | yes, held-out fixtures with 0 misses | yes for the structural layer | GREEN for the structural layer; OCR escalation is the open part |
| C1 native PDF/DOCX/PPTX/XLSX | yes | yes (`documents.parse` via ml_job) | yes - the reopen-parity test spawns the venv and reads writer output back | partial: reader fidelity measured on D1 fixtures; **late-document evidence now asserted, not assumed** | ORANGE. Speaker-note writer gap recorded in D-071; merged-cell extraction still declared `not_extracted` |
| C2/D1 scanned + mixed PDF through production | yes | yes (cascade via `run_ocr_stage`) | **no - zero pages from the primary engine** | no | ORANGE. The last real attempt died on the protobuf ABI contradiction; the venv now pins 7.36.2 and readiness reports it, which is readiness, not execution |
| D3 escalation ladder, provenance, fallback | yes, one window including the recovery unit | yes | Tesseract executed at engine level (WER 0.0) and standalone; **not yet as a recovery inside a production job** | no | ORANGE; `-Pass fallback_*`, `-ResumeResults` and `-InjectPrimaryFailurePage` are attended |
| E ASR / alignment / diarization | ASR yes, alignment yes, diarization adapter gated | yes for the audio and video branches | yes, live CPU execution (WER 0.0769 / 0.0, peak 388 MiB, zero new GPU) | yes for ASR | ORANGE only where diarization is named (`license_acceptance_required` - a human must accept the terms) |
| F video pipeline | yes | yes | decode and transcript evidence measured; **frame OCR and interpreted coverage not executed** | no | ORANGE. Planned / decoded / transcribed / OCR-read / interpreted stay separate columns; a sampling plan is never presented as understanding (the synthetic probe carries its own SCOPE line saying so) |
| G retrieval: lexical baseline | yes | yes | yes, live | yes | GREEN, with its `lexical` label kept |
| G2/G3 neural embed + rerank | yes, pinned assets with sha256 re-verified at load | **no production caller** | executed standalone on CPU (mechanics 7/7, top-1 9/10, MRR 0.950, peak 267.7 MiB) | no - it does not beat the bi-encoder on the g05 set and the two numeric-fact misses stay failures | ORANGE (migration) and ORANGE (functional). Never relabelled as neural-in-production |
| H1/H2 artifact creation and export | retained TypeScript writers | yes (artifact endpoints, render modes) | yes, and now **reopened and inspected by the independent Python reader** (D-071) | content parity passed for docx/xlsx/pdf, with the pptx notes gap recorded instead of asserted away | functional GREEN, **Python migration RED by definition** - a retained owner is a recorded deviation, not a migration |
| I streaming/UI | yes (think-tag separation with TS/Rust parity, fence repair, scroll ownership, status states) | yes | unit and integration yes; **live browser verification not run this session** | no | ORANGE until the browser stage runs behind the Playwright lock |
| J1-J2 startup, preparation, portability | yes | yes | yes: one `npm run dev` tree with cargo build, lazy Python workers, no startup downloads | yes | GREEN, now documented in `SETUP.md`, with `.env.example` completing the provider contract |
| J3 memory ceiling | job object + admission + commit clamp | yes | whole-tree idle 1568 MiB WS / 2126 MiB PRIV measured; **the 5 GB ceiling under OCR load has never been measured** | no | ORANGE - no ceiling claim is made until an attended OCR run measures cold-load and processing peaks |
| J4 handoff | yes, one window per job covering primary and fallback | yes (Rust admission, TS lease, Python before workers) | **yes for unload/restore**: 51,079 MiB RAM plus 9,483 MiB VRAM freed, restore "loaded and ready", lease removed | no for content, no for the continuation trace | ORANGE, not "never executed". The continuation trace (upload, evidence, pending request, streamed answer) is the named acceptance item |
| J5 GPU when it fits | policy exists with `allow_gpu=False` | yes | no | no | BLOCKED today: the pinned `paddlepaddle 3.2.1` is `compiled_with_cuda False`, and 2,633 MiB free VRAM would not fit even the provisional estimate |

Gate baseline as of F51, each with a recorded exit code: typecheck **0** (`f51-typecheck-3.log`); full
vitest **196 files and 2529 tests passed, 2 files and 19 tests skipped** (`f51-vitest-full-1.log`);
Python **432 OK** (`f51-py-discover-1.log`); Rust **263 + 40 + 4** and `npm run build` from F48
(`f48-cargo-server-1.log`, `f48-cargo-core-1.log`, `f48-cargo-handoff-1.log`, `f48-build-1.log`), not
re-run because no Rust or Next source changed since.

Honest bottom line, unchanged in kind: verdict **PARTIAL**. The single highest-value remaining action is
the attended primary-OCR run, because it is simultaneously the gate for C2, D1, D3, J3 and the J4
content/continuation half. Nothing here may be turned GREEN by installation, readiness, a dry run, a
mock, or fallback-only success.


## F58c delta (sessions F54, F55, F56, F57, F58, F58b, F58c) - supersedes the named rows above where they differ

Same rules: **implemented / production-wired / actually executed / acceptance passed** stay separate.
HELD is never GREEN. A retained TypeScript owner is never a completed Python migration. No acceptance
threshold was relaxed to obtain any pass recorded below.

| area | migration | functional | what is true now (this row supersedes the E1 / F / C4 / H1 / J3 / J4 / A rows above where they differ) | evidence |
|---|---|---|---|---|
| E1 ASR + speech honesty | **GREEN** for tested scope | GREEN | real CPU engine run through the production worker path; VAD gating is on by default with an honest `vad_state` token, and the decode-window fragment merge is fixed; the TypeScript owner now carries `window_truncated` / `vad_filter` / `vad_state` / `superseded_fragments` through into the user-visible engine note instead of dropping them | `f58c-e03-3.log` + `e03-speech-20261117T18483297955.json` (`ok:true failures:[]`), `f58-g33-asr-vad-1.log`, `f58b-py-asrvad-2.log` 14 OK, `f58c-ts-speech-1.log` 15 OK |
| F video evidence chain | ORANGE for semantic interpretation | ORANGE, with the evidence chain GREEN on the frozen fixture | frame OCR read real text with the project-local tesseract; the tail event near the end was found; the silent head was not reported as speech; the one unresolved sample is reported as `out_of_range` | `f53-video-probe-4.log`, `f53-video-probe-5.log` (both "all checks passed"), `f53-video-evidence.json`, `f58b-g36-fixture-fix-1.log` |
| C4 PPTX + H1 pptx writer | **RED for Python migration** (retained TS owner) | GREEN for tested scope, speaker notes now included | the speaker-note gap recorded at F50/D-071 is closed in the retained TypeScript writer; the reopen-parity test asserts authored notes on the right slides, no note block where there is no note, and that managed placeholders never masquerade as note text | `f56-vitest-reopen-1.log` 4 OK, `f56-py-notes-3.log` 28 OK, `f56-golden-{1,update-2,3}.log` (sanctioned re-record, 3 lines, then pass without the flag) |
| J3 resource accounting | ORANGE | ORANGE | the unknown-not-zero class sweep is done: missing/unreadable measurements return unknown with a basis token instead of 0, and every provisional estimate now says "provisional" out loud | `f58-py-unknown-4.log` 17 OK, `f55-py-mem-{kinds,targeted-2}.log`, D-076 |
| B provider configuration | GREEN | GREEN | one shared resolution order for TS and Python, prefix-preserving `RUKE_LIFECYCLE_BASE`; the settings.json-vs-env split that could point chat and the lifecycle client at different servers is closed | `f55-py-provcfg-1.log` 20 OK, D-074, `.env.example`, `SETUP.md` |

Corrections to numbers stated in this file earlier, stated plainly rather than edited silently:

- E1 "peak 388 MiB" is superseded by the current real-engine run: peak working set **395.0 MiB**, peak
  commit **1,294.0 MiB** over the owned child tree, simultaneous peak 332.0 MiB across 35 samples,
  181.0 MiB resident after the job, `tree_pids_at_job_end: []`, `gpu_violations: null`.
- The C1 WER stays **0.0769** and the tail WER is **0.0769 over 13 truth words**; the F53 run reports the
  same 0.0769 with the speech at **33.62-38.1 s** and a silent head of **0-33.883 s** that is explicitly
  not claimed as speech.
- F53 frame OCR counts are **planned 5 / decoded 4 / recognised 3 / glyph-free 1 / unresolved 1** with
  `coverage.complete: false` - that is the honest ceiling of a 5-instant sample of a 40 s source, and the
  probe's own note says a sampled instant is not visual coverage.
- Gate baseline as of **F58c**, replacing the "as of F51" paragraph: typecheck exit 0
  (`f58c-typecheck-1.log`); full vitest **196 files / 2,534 passed / 19 skipped**, exit 0
  (`f58c-vitest-full-1.log`); full python discover **503 OK** (`f58c-py-discover-1.log`); Rust 263 + 40 + 4
  and `npm run build` from F48 still stand (`f48-cargo-{server,core,handoff}-1.log`, `f48-build-1.log`)
  with `f56-cargo-decision-1.log` and `f56-contracts-check-1.log` exit 0 added. Cargo and `npm run build`
  were NOT re-run in F54-F58c because no Rust or Next application file changed.
- Recorded so the arithmetic error is not repeated: `f55-py-discover-2.log` is **453 OK**, not 459. And
  `f56-py-notes-1.log` is a harness error of mine - an `IndentationError` I introduced in
  `tests/test_retrieval_documents.py` - not a product failure; the product run is `f56-py-notes-3.log`.
- F57 left no log block of its own. The work it did (the unknown-not-zero sweep) is recorded under D-076
  inside the F58 TASKS block. That is stated, not back-filled.

What is still ORANGE / RED / BLOCKED after F58c, unchanged in kind: the primary PaddleOCR-VL pipeline has
produced **zero pages**; the 5 GB ceiling has never been measured under OCR load; `est_peak_mib 3300` and
`est_peak_vram_mib 6000` remain **provisional**; the chat-continuation-after-handoff trace has never been
run end to end; neural embed/rerank still have **no production caller** and keep their two numeric-fact
failures; diarization stays `license_acceptance_required`; the artifact writers stay TypeScript owners;
GPU OCR stays blocked on `paddlepaddle 3.2.1 compiled_with_cuda False` plus ~2.6 GiB free VRAM.

## F60 / F61 delta (2026-11-18 ~01:33 and 2026-11-20 ~13:09) - supersedes the earlier OCR-resource rows wherever they differ

Same rule as every other delta here: migration status and functional status stay separate, and
**implemented / production-wired / actually-executed / acceptance-passed** are four different claims.

| capability | corrected row as of F61 | evidence |
|---|---|---|
| OCR resource admission (`models/job_limits.py`) | **implemented, unit-tested, production-wired, acceptance-NOT-passed.** Two explicit budgets in one place: normal 4 GB target / 5 GB hard tree ceiling (`normal_ceiling_bytes()` :357) and a separately configured **exclusive** ceiling (`EXCLUSIVE_LIMIT_ENV` :63, default 7,000,000,000 B, clamped by free commit - `SYSTEM_RESERVE_ENV` 2 GiB, band 5-12 GB, :371), plus `worker_ceiling_bytes(...)` that returns either a bounded OS ceiling **or** a typed refusal with the arithmetic spelled out. The **effective** limit is therefore not a constant: on this host's current commit headroom the clamp bites at **3,952 MiB** (4,143,972,352 B) for the normal window and **5,974 MiB** minimum viable for the exclusive window at the provisional demand | `f61-py-window-3.log` (29 OK), `f61-py-ocrfocus-1.log` (137 OK), D-079, D-080 |
| OCR worker enforcement + pre-spawn refusal (`documents/ocr_paddle.py`) | **implemented, production-wired, and the refusal path is the only one actually executed on this host.** `per_worker_limit_bytes` (:342) resolves the ceiling **before the child exists** and raises `OcrUnavailable("resource_limit", "refusing to spawn: ...", RESOURCE_LIMIT_STEP)` (:436) when the offerable ceiling is under the declared demand. One death classifier `classify_worker_death` (:95) at all three observation sites (:638, :657, :825), with `suspected_under_attached_ceiling` (:138) for an unknown exit under a nearly-reached ceiling. `device_echo` (:677) and `dtype_policy` (:683) record what the build actually resolved | `f59-ocr-coldload-1.log` + `ocr-paddle-15388/worker-1794943495.log` (the zero-page death that motivated this), `f61-py-window-3.log` |
| allocation-refusal vocabulary | **one authority, implemented and pinned across the process boundary.** `ruke_ml/allocations.py::ALLOCATED_REFUSED_MARKERS` (module path is `ruke_ml/allocations.py`, **not** `ruke_ml/models/allocations.py`) is matched item-for-item by the worker's `DEFAULT_MEMORY_REFUSAL_MARKERS`, and the parent passes its list into the child. Adds `mkl_malloc`, `the paging file`, `0x8007000e`, `0x800705af`, `cuda out of memory`, `cudnn out of memory`, `std::alloc`, `std::bad_alloc` | `f61-py-window-3.log` class `TheAllocationClassifierIsOneAuthorityAcrossProcessBoundaries` |
| funnel classification of a memory refusal | **implemented, production-wired.** `workers/jobs.py`:87 `KIND_TO_REASON["resource_limit"] = ("memory_pressure", True, ...)` - retryable memory condition, not an engine fault, not `input_rejected`, not a skip. On the TS side the reason is carried verbatim (`ml-job.ts`:185, :257 with `CACHEABLE_REASONS` deliberately excluding it, `extract/document-capability.ts`:374-381, `attachindex/timeline.ts`:447, `extract/speech-capability.ts`:398, `rerank.ts`:122) | `f61-ts-doccap-1.log` (49 OK, previously 48) - the suspected gap was **investigated and is not a defect** |
| OCR cascade lifecycle (production vs CLI) | **implemented, unit-tested; one windowed body shared.** `_operation(...)` = primary -> per-unit Tesseract recovery -> durable write, inside one window, called by the lease path, the no-lease path and `handoff.py`'s CLI. `inside_window` is kept distinct from `inside_handoff` (a lease does not imply freed RAM). Durable `ruke.ocr-result.v1` (`_RESULT_SCHEMA` :484, `_result_key` :539 content identity + request with explicit `hash_basis`, `_write_result` :567-636 `fsync`+`os.replace`, `_read_result` :640+ ABSENT/UNREADABLE/MALFORMED/STALE, `_page_from_record` :697 never replays a FAILED unit). **Not acceptance-passed**: no engine has written a record on this host | `f61-py-ocrfocus-1.log`, amendment 15 sections 25.1-25.2, D-080 |
| primary PaddleOCR-VL-1.6 quality | **unchanged: zero pages, ever.** Still RED-functionally, still BLOCKED for an unattended green: the CPU weight floor is float32 ~3.8 GiB (pinned paddlex picks bf16 only for gpu/npu/xpu/mlu/metax/iluvatar; `precision` -> `pptrt_precision`, TensorRT only), the checkpoint is 1,917,255,968 B bf16 + 130,806,572 B layout pdiparams, and GPU is impossible (`compiled_with_cuda False`, ~2.8 GiB free VRAM vs 9,256 MiB wanted) | `f59-pb-import-1.log` (protobuf **not** the blocker), `f59-ocr-coldload-1.log`, SPEC 24.3, 25.3 |
| enforcement parity across adapters | **ORANGE, recorded not fixed.** Only the Paddle worker gets an OS job-object ceiling. Tesseract, ffmpeg/ffprobe and frame OCR share the `workers/jobs.py` funnel and the `runner.py`:41 allocation-text guard, and `frame_ocr.py` handles `resource_limit`/`input_rejected` (:112, :250), so classification parity is real while **enforcement** parity is not | the amendment-15 class audit, SPEC 25.2 |
| gate baseline | **the F58c numbers are a baseline, not current verification.** python **503 OK** and TS **196 files / 2,534 passed / 19 skipped** pre-date the F60/F61 test edits; the 29 new python tests and 1 new TS case have only run in targeted sets (`f61-py-window-3.log`, `f61-py-ocrfocus-1.log`, `f61-ts-doccap-1.log`). Rust 263/40/4 and `npm run build` from F48 stand because no Rust/contract/Next source changed | `f58c-py-discover-1.log`, `f58c-vitest-full-1.log`, `f48-cargo-{server,core,handoff}-1.log`, `f48-build-1.log` |

**Unchanged in kind and still ORANGE/RED/BLOCKED after F61:** `est_peak_mib 3300` / `est_peak_vram_mib 6000`
remain **provisional** (a measured peak is what would drop the 1.5x charge and the 1,024 MiB margin, and until then
the admission decision rests on an estimate that is honestly labelled an estimate); the 4 GB / 5 GB ceiling has
never been measured under OCR load; the chat-continuation-after-handoff trace has never been run end to end; neural
embed/rerank still have **no production caller** and keep their two numeric-fact failures; diarization stays
`license_acceptance_required`; the PDF/DOCX/PPTX/XLSX artifact writers stay **retained TypeScript** owners, so their
Python-migration status is RED by definition and is recorded as a scope deviation; GPU OCR stays unavailable; legacy
DOC/PPT conversion still does not exist and returns an honest unsupported result.

## F66 delta (2026-11-20 ~23:15) - the G2/G3 ledger row splits in two: rerank changes columns, embeds does not

Same vocabulary as everywhere in this file: **implemented / production-wired / actually-executed /
acceptance-passed** are four different claims. F66 moved exactly two of those claims, for exactly one capability,
and supersedes the F51-ledger G2/G3 row and the :265 "no production caller" item **for the rerank half only**;
every older row and sentence above stays as dated history, superseded wherever it differs.

| capability | corrected row as of F66 | evidence |
|---|---|---|
| G3 neural rerank (cross-encoder, `nn_rerank`) | **implemented (pinned assets, sha256 re-verified at load), production-wired, actually-executed - and acceptance-passed = NO.** The F51 ledger's "no production caller" column is superseded: the caller has existed since **D-058** - `lib/server/attachindex/rerank.ts::makeRerankStage` is wired into the retrieval owner at `turn.ts:344-373`, transports `mlJob("rerank")` to `POST /api/ruke/ml/job` (this route **accepts** `rerank`; the D-046-era "the Rust ml-job route deliberately excludes rerank" premise is false, corrected in `models/registry.py`) and executes on the supervisor's `nn_rerank` worker. F66 ran that chain live: the env-gated test file is **5/5 green** (skips without env, so the standing gates and thresholds are untouched), pinned identity held (`Xenova/ms-marco-MiniLM-L-6-v2`, `sha256:c623d0bc...881870`, `onnxruntime-cpu`), warm repeat byte-identical, bad mode -> typed-refusal envelope (HTTP 200 `state:"failed"` + non-empty reason + no scores; supervisor access log exactly 5x 200 + 1x 552). F29's acceptance wording - "one real ONNX cross-encoder job executed through `POST /api/ruke/ml/job` on the live tree with the worker's peak RSS recorded" - is **satisfied for route execution**: supervisor tree baseline 36 MiB, **peak working set 204 MiB / peak commit 157 MiB**, `pids_at_peak` includes the worker pids; the registry's 267.7 MiB `est_peak_mib` stays the g05-probe figure incl. both engines and their import overhead, consistent with the route-only number. What does NOT move: the two numeric-fact misses stay failures (now characterized **through the live route**: `order[0].idx !== truth` and the test fails on purpose if that ever flips), the engine ties-and-does-not-beat the dense bi-encoder on the g05 set, and the assets are English-only | `f66-rerank-live-route-1.log`, `f66-supervisor-1.log`, `f66-ruke-server-1.log`, `f66-rss.json`, `__tests__/server/attach-rerank-live-route.test.ts`, `f27-g05-rerank-2.log` (quality numbers unchanged), D-058, D-082 |
| G2 neural embeddings (`nn_embed`) | **unchanged: still no production caller.** `mlJob("embeddings")` appears nowhere in `lib/`; the Python adapter was never wired; TS `attachindex/embed.ts` (`embedOne`) remains the production owner - the same reported class as the retained-TS artifact writers - and this half stays ORANGE/RED for migration by definition. The Rust server logs "attachment query-embedder not configured: retrieval degrades like the TS embedOne catch (BM25-alone)" - a Rust-side degrade, not an owner change | `f66-ruke-server-1.log`:2; `lib/` search finds no `mlJob("embeddings")` call; the F51 ledger row stays correct for this half |

**The registry truth surface moved with the fact**, not the other way around: cross-encoder row
`production_caller_wired: False -> True` with the stale comment corrected, while
`beats_dense_biencoder_on_g05_set` and `numeric_fact_case_fixed` stay False and keep their assertions; the
python truthfulness assertion flipped to True with a "fix the truth, not the assertion" note — targeted
`test_retrieval_neural.py` **Ran 25 tests, OK** (same file, count unchanged, so the 532-baseline stands).
**Gate delta for the final full run:** the new live test skips cleanly without env, so full Vitest must now
expect **Test Files 196 passed / 3 skipped** and **Tests 2,535 passed / 24 skipped** (was 196/2 + 2,535/19 at
F63). Nothing else in the "Unchanged in kind" paragraph above changes in this delta.
