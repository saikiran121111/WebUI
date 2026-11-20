# STATE - Ruke generalization + Python migration (session F05, 2026-11-16)

Prior session-62 STATE content is superseded by this file; the session-62/61 blocks stay readable
in docs/overnight/TASKS.md and FINAL-REPORT.md.

Verdict for the 2026-11-16 brief scope: **PARTIAL**. Never COMPLETE while asset-gated adapters
(OCR binary, whisper CT2 weights, neural embed/rerank weights, pyannote licence) stay unavailable
and while production callers for the document/speech capability jobs are still being wired.

## Identity (measured this session)
- branch **local**, HEAD **abc988c208a99f4e224250166300f4ff7fb32549** (docs-only commit over
  5a0370a; D-031 authorized the commit chain, never pushed).
- Working tree: ~74 changed/untracked entries from sessions 63..F04 (git status --porcelain).
  Nothing was committed this session; no reset/stash/checkout --/clean ever used.
- Build artifacts intentionally uncommitted: tsconfig.tsbuildinfo, mcp-out/, python-backend/ruke_ml.egg-info/.

## Sessions 63 - F04 (all uncommitted, evidence in docs/overnight/logs/)
- Brief section 3 kernels A-E applied in python-backend: new ruke_ml/language_tables.py,
  documents/{pdf,ocr_tesseract}.py, speech/{languages,whisper_ct2}.py,
  models/{assets,prepare}.py, workers/{jobs,document_jobs,speech_jobs}.py; modified
  documents/{parser,ocr,structures}, models/registry.py (AdapterReadiness + catalog
  readiness/executable_for/blockers_for/status_for/claim_problems), speech/{asr,alignment},
  video/scenes.py (measured_prefix_end, parse_decoder_progress, prefix_measured, dual-pipe
  drain, honest plan note), workers/runner.py (unsupported_input, plan-only Coverage, real
  document/speech dispatch).
- F02b/F02 generalisation frames: __tests__/decision/generalization-f02b.test.ts,
  lib/decision/client.ts, rust-backend/crates/ruke-decision/src/engine.rs,
  rust-backend/fixtures/decision/06-intent-matcher-vectors.json.
- F03b domain policy: __tests__/web-search/domain-policy-f03b.test.ts (15 cases) +
  lib/web-search/domain-constraints.ts (elliptical bare negator, exclusive "restrict...to",
  supersession withdrawal, preference vs exclusion). TS-only, no Rust mirror.
- F04 (section 3-D TS half): __tests__/attach-timeline-f04.test.ts (24 tests) + shared
  cross-language fixture rust-backend/fixtures/media/measured-prefix-v1.json (12 cases) +
  Python binding tests/test_video_scan.py::MeasuredPrefixContractTests;
  lib/server/attachindex/timeline.ts exports measuredPrefixEnd, unmeasured cut boundary means
  POINT evidence only, both "truncated && scannedSec > 0 ? scannedSec : durationSec" fallbacks
  removed; types.ts TimelineSummary.sceneScan gained prefixMeasured.

## Gates recorded (exit codes in logs/)
- npx vitest run __tests__/attach-timeline-f04 __tests__/attach-timeline-s60 -> 50 passed, exit 0 (f04-impl-2.log)
- cargo test -p ruke-decision --lib -> 38 passed, exit 0 (f04-rust-decision.log)
- cargo test -p ruke-server --lib -> 251 passed, exit 0 (f04-rust-server.log)
- npx tsc --noEmit --incremental false -> exit 0 (f04-typecheck.log)
- python unittest (s63-s68 logs) -> OK, exit 0; real-ffmpeg probe prints in s68-python-01.log
- Known non-product failure: __tests__/rust-golden/attachments.test.ts > "03 empty index -> zero
  evidence" fails only in whole-directory runs (shared knowledge_index state) -> test-isolation
  issue, recorded as such, never as a pass.

## Asset/tool gates on this host (measured, not assumed)
- No tesseract binary anywhere (PATH, Program Files, project-local bin) -> documents.ocr = tool_unavailable.
- .data\models holds only the Xenova TS embedder cache -> no CT2 whisper weights ->
  speech.asr / speech.align = not_configured.
- sentence-transformers not installed -> neural embedding/rerank non-executable; the honest
  lexical baseline stays labelled lexical.
- pyannote -> licence_acceptance_required.

## Current task (this session, F05)
1. P2/P3 production wiring: a capability-first document/speech extraction seam
   (lib/server/extract/capability-doc.ts) called from lib/server/extract/index.ts, with the TS
   engines kept as named fallbacks and engine provenance recorded in the delivered text.
2. Section 6 thinkTags literal preservation (inline code, indented code, blockquoted fences)
   TS<->Rust with the shared recorded vectors.
3. Full gates (TS, Rust, Python, contracts, build), startup/memory measurement, doc rewrite.

## Next concrete command
    npx vitest run __tests__/extract-capability-doc __tests__/think-splitter
run from D:\Projects\WebUI\WebUI with WEBUI_DATA_DIR=D:\Projects\WebUI\scratch-f05-data

## Blockers (kept honest)
- OCR / ASR / neural retrieval / diarization model quality: not_configured, evaluation_required,
  licence_acceptance_required. These are runtime/deployment conditions, not "done".
- Playwright live acceptance = FINAL stage only, under .ai-coordination/playwright.lock, Codex idle.
- Strata 127.0.0.1:8080/v1 capacity 1 is shared with this coding agent: no concurrent inference,
  no detached model probes.

## Owned processes
- None started yet this session. Ports 3000/3101/3210 are not owned by me; nothing to drain.