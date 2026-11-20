# STATE - Ruke generalization + Python migration (session F11, 2026-11-16)

The previous (session-F05) copy of this file is archived verbatim at
`docs/overnight/logs/STATE-f05-archive.md`. This file is the live resume point.

Verdict for the 2026-11-16 brief: **PARTIAL**. Not COMPLETE while asset-gated adapters
(tesseract OCR binary, whisper CT2 weights, neural embed/rerank weights, pyannote licence) stay
unavailable, while artifact writers stay TypeScript, and while live UI/scroll acceptance is not
freshly re-established.

## Identity (measured at the start of this session, before any edit)
- branch **local**, HEAD **abc988c208a99f4e224250166300f4ff7fb32549** (unchanged from the audit
  checkpoint; nothing committed, no reset/stash/checkout --/clean ever used).
- `git status --porcelain` = **149 entries** (sessions 63..F10 work is uncommitted, so HEAD alone
  is not a usable baseline). Deliberately dirty build artifacts: tsconfig.tsbuildinfo, mcp-out/,
  python-backend/ruke_ml.egg-info/.

## Amendment applied at this checkpoint (SPEC section 13 + DECISIONS D-036)
The mid-run instruction "model-led intent, code-led processing" was incorporated without discarding
in-flight work: the document/speech adapters (sessions 63..F04), the capability extraction seam
(`lib/server/extract/capability-doc.ts`), the F08 worker byte protocol and the F09 promotion /
rendering work are all preserved. New deliverable: `docs/overnight/DECISION-OWNERSHIP.md`.

## Owned processes (started by this run; kill only these PIDs)
- `npm run dev` tree, root **21660** (`node scripts/dev-supervisor.mjs`, cmd parent 16740):
  - `next dev` wrapper **1308**, next server **22836** (listens :3000, 158 MiB RSS)
  - `ruke-server.exe` **25552** (:3101)
  - python supervisor **14424** -> worker host **6620** (:53851, `--idle-ttl 120`)
- dev log: `docs/overnight/logs/f09-dev-1.log`.
- WARNING: `npm run build` clobbers `.next` while dev runs - restart the dev tree before any
  further HTTP/browser probe.
- NEVER kill Strata pythons **16912 / 18364**.

## Current task (F11)
1. Held-out read suite to completion: answer key `docs/overnight/fixtures/f09/answer-key.json`,
   hermetic reader tests `python-backend/tests/test_heldout_readers.py`, HTTP score probe
   `docs/overnight/probes/f09_heldout_http_probe.mjs`. The fixtures regenerate into
   `.data/tmp/f09-heldout/` (that scratch dir was already gone at this session start).
2. Body-provenance disambiguation for xlsx/docx delivery: the Python `ooxml-cellwise` header text
   and the TS `office.ts` header text are near-identical, so the delivered body must carry an
   explicit engine / body_source id.
3. `docs/overnight/DECISION-OWNERSHIP.md` decision-owner table.
4. Memory measurement (baseline / peak / idle release), then the final gate sweep and docs flush.

## Next concrete command
    cd python-backend && .venv\Scripts\python.exe ..\docs\overnight\fixtures\f09\ho_docs.py
run from `D:\Projects\WebUI\WebUI\python-backend` (regenerates the held-out fixtures), then
`node .data\tmp\proc.mjs 21660` from the repo root to confirm the dev tree is still the owned one.

## Gates already green at this checkpoint (re-run only areas a change touches)
- Python `unittest discover` from python-backend: **Ran 216 tests, OK**, exit 0
  (logs/f09-python-full-2.log).
- `npx vitest run` full: **188 files pass / 2 skipped; 2426 tests pass / 19 skipped**, exit 0
  (logs/f09-vitest-full-1.log). Focused 129-pass run: logs/f09-vitest-focused-1.log.
- `cargo test -p ruke-server -p ruke-decision --target-dir D:\Projects\WebUI\target-ci`:
  **348 passed**, every line "test result: ok", exit 0 (logs/f09-rust-all-1.log).
- `npx tsc --noEmit --incremental false` exit 0 (logs/f09-typecheck-1.log);
  `npm run contracts:check` exit 0 (logs/f09-contracts-1.log); `npm run build` exit 0
  (logs/f09-build-1.log).
- HTTP integration probe (logs/f09-dev-1.log + probes/f06-http-*.json): docx table identity,
  xlsx merged/formula/cached values, pdf late evidence / rotated page / two-column page, and an
  honest "page 3 was not read".

## Separated status vocabulary (used consistently across these docs)
- **Implemented** - code exists and is wired into a production route.
- **Unit-tested** - a hermetic test asserts the behaviour.
- **Integrated** - proven through the real HTTP / worker path.
- **Live-verified** - proven in a browser against the real endpoint. NOT re-established this
  session for scroll, long streaming answers or the chat UI.
- **Failed** - reproduced and still unfixed.
- **Blocked** - needs credentials, licence acceptance, a missing binary or model weights.

Per-capability status:
- PDF native parse (pypdf), OOXML xlsx/docx/pptx parse, render + coverage law: Implemented,
  Unit-tested, Integrated(HTTP).
- `documents.ocr`: **Blocked** - no tesseract binary on this host; reports not_installed.
- `speech.asr` / `speech.align`: **Blocked** - CT2 weights not cached; reports not_installed.
- `speech.diarize`: **Blocked** - pyannote licence acceptance required.
- `embeddings` / `rerank`: executable **lexical** baseline only; neural not_configured (no
  weights). Never relabelled neural.
- `artifacts.xlsx` / `artifacts.docx` / `artifacts.pptx`: **retained TypeScript writers**, recorded
  as not-migrated rather than silently claimed as Python.
- video scenes / timeline honesty: Implemented, Unit-tested, Integrated(HTTP probe).
- thinkTags literal preservation, activity labels, scroll ownership: Implemented + Unit-tested,
  **not Live-verified** this session.

## Blockers (recorded, not worked around)
- Tesseract binary absent, whisper CT2 weights absent, sentence-transformers absent, pyannote
  licence not accepted. Runtime/deployment conditions, not "done".
- Playwright live acceptance only through `scripts\run-browser-e2e-exclusive.ps1` under the shared
  lock with Codex idle.
- Strata 127.0.0.1:8080/v1 capacity 1 is shared with this coding agent: no concurrent inference,
  no detached live probes.
- The user is present and engaged: **no host shutdown this session**; record the resumable action
  instead. The overnight shutdown authorization itself stays open.
