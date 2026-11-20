# STATE - Ruke generalization + Python migration (session F12, 2026-11-16)

Earlier copies: session F05 at `logs/STATE-f05-archive.md`, session F11 at
`logs/STATE-f11-archive.md` (both verbatim). This file is the live resume point; read TASKS.md and
DECISIONS.md (through D-038) alongside it. Do not replay older patches.

Verdict for the current brief (SPEC sections 1-13 + amendment 14): **PARTIAL**. Not COMPLETE while
the primary OCR pipeline is not executed for real, while Tesseract/ASR/neural-retrieval assets are
not in place, while artifact writers stay TypeScript, and while live UI/scroll acceptance has not
been freshly re-established.

## Identity (measured at this checkpoint, before any edit)
- branch **local**, HEAD **abc988c208a99f4e224250166300f4ff7fb32549** - unchanged since the audit
  checkpoint. Never commit, push, reset, stash, `checkout --` or clean: all F-session work is
  deliberately uncommitted, so HEAD is **not** a usable baseline.
- `git status --porcelain` = **155 entries** at this checkpoint. Deliberately dirty build debris:
  `tsconfig.tsbuildinfo`, `mcp-out/`, `python-backend/ruke_ml.egg-info/`. Root debris `a.txt` and
  `lock-out.txt` are harness scratch, not user data (left in place, not deleted).
- Python 3.12.15 in `python-backend/.venv`; `uv 0.13.0` available. Free disk: D: 59.4 GB, C: 105.7 GB.

## Amendments in force
- Amendment 1 "model-led intent, code-led processing": SPEC section 13, DECISIONS D-036. Still owed:
  `docs/overnight/DECISION-OWNERSHIP.md` and its 13.6 acceptance items.
- Amendment 2 (2026-11-16 F12): SPEC section 14, DECISIONS D-038 - PaddleOCR-VL 1.6 **full
  pipeline** as pinned CPU-only primary OCR, Tesseract as recovery fallback only, 4 GB target /
  **5 GB hard maximum** for the Ruke tree plus processing children excluding the main LLM and this
  coding agent, native reading first with per-unit escalation, and a bounded <=1-step fallback
  ladder. It overrides older OCR/hardware/memory/routing choices. HTML viewer and questionnaire work
  stays deferred.

## Owned processes (started by this run; kill only these PIDs)
- `npm run dev` tree root **21660** (`node scripts/dev-supervisor.mjs`, cmd parent 16740) - alive at
  this checkpoint. Children re-fork as needed: `next dev` wrapper, next server **22836** listening
  :3000; `ruke-server.exe` **25552** listening 127.0.0.1:3101; python supervisor + lazy worker host
  (`--idle-ttl 120`, worker dies and restarts on demand).
- dev log: `docs/overnight/logs/f09-dev-1.log`. Capability surface is
  `GET http://127.0.0.1:3101/api/ruke/ml-status` (NOT served on :3000).
- WARNING: `npm run build` clobbers `.next` while dev runs - restart the dev tree before any HTTP or
  browser probe.
- NEVER kill Strata pythons **16912 / 18364**. Strata `127.0.0.1:8080/v1` capacity **1** is shared
  with this coding agent: no concurrent inference, no detached live probes, no parallel reviewer.

## Current task (F12) and next concrete command
Order is in TASKS.md "Session F12". The immediate next action is the **HTTP held-out probe**.

    cd /d D:\Projects\WebUI\WebUI\python-backend && .venv\Scripts\python.exe ..\docs\overnight\fixtures\f09\ho_docs.py

regenerates the fixtures into `.data/tmp/f09-heldout/` (scratch; may be missing at a session start),
then from the repo root:

    node .data\tmp\proc.mjs 21660
    node docs\overnight\probes\f06_http_probe.mjs

confirms the owned tree still serves extraction. After that, write and run
`docs/overnight/probes/f09_heldout_http_probe.mjs`: POST each regenerated fixture to
`http://localhost:3000/api/files/extract?name=...` (no `att=`, so nothing durable is written), score
`http.must` / `http.must_not` / `coverage_must_any` / `accept_any_of` from
`docs/overnight/fixtures/f09/answer-key.json`, write `docs/overnight/logs/f09-heldout-<ts>.json`, and
exit non-zero on any miss.

## Gates green at this checkpoint (re-run only areas a change touches)
- Python `unittest discover` from `python-backend`: **Ran 220 tests, OK**, exit 0
  (`logs/f11-python-full-1.log`; extra probe output appears after the OK lines and is harmless).
  Command: `cd /d D:\Projects\WebUI\WebUI && python-backend\.venv\Scripts\python.exe -m unittest discover -s python-backend\tests -t python-backend > docs\overnight\logs\<name>.log 2>&1`
- Carried from F09, untouched since: vitest full **2426 pass / 19 skip** exit 0; `cargo test -p
  ruke-server -p ruke-decision --target-dir D:\Projects\WebUI\target-ci` **348 passed** exit 0;
  `npx tsc --noEmit --incremental false` 0; `npm run contracts:check` 0; `npm run build` 0.
- NOT yet re-run after the `lib/server/extract/document-capability.ts` provenance change:
  `__tests__/server/extract-document-capability.test.ts` (37 tests). Run it with the next TS pass.

## Done this session (F12 so far)
- `python-backend/tests/test_heldout_readers.py`: strict interpreter over the independent answer key
  (`reader_kind`, coverage id lists, ocr route, meta_checks, unit attribution, block field checks,
  must-not facts, HTTP sub-key declarations). Unknown key fields fail loudly.
- `docs/overnight/fixtures/f09/ho_docs.py` generator fixes + `documents/parser.py::_xlsx`
  `meta.sheet_failures` (D-037). Verified: inventory keeps `C4=0` distinct from declared-empty cells,
  merges in both directions, `E5` formula/cached separated, `units_succeeded=[1]`; corrupt keeps 2
  `corrupt_cells` entries and delivers only A2; badxml reports `units_failed=[1]` with a reason.

## Separated status vocabulary (used consistently)
- **Implemented** - code exists and is wired into a production route.
- **Unit-tested** - a hermetic test asserts it.
- **Integrated** - proven through the real HTTP / worker path.
- **Live-verified** - proven in a browser against the real endpoint. NOT re-established for scroll,
  long streaming answers or the chat UI.
- **Failed** - reproduced and still unfixed.
- **Blocked** - needs a credential, licence acceptance, a missing binary or model weights.

Per-capability status at this checkpoint:
- PDF native parse (pypdf 7.1.0), OOXML xlsx/docx/pptx parse, render + coverage law: Implemented,
  Unit-tested (reader level), Integrated over HTTP for the F06 fixtures; the held-out fixtures are
  Unit-tested only until the HTTP probe scores them.
- `documents.ocr`: **Blocked** - no Tesseract binary on this host; PaddleOCR-VL 1.6 CPU feasibility
  is not yet measured. Reports not_installed honestly, with no fake adapter.
- `speech.asr` / `speech.align`: adapter `speech/whisper_ct2.py` Implemented + Unit-tested;
  **Blocked** at integration only because the CTranslate2 weights are not prepared (faster-whisper
  1.2.1 and ctranslate2 4.9.0 are already installed, so this is preparation work, not a missing
  implementation).
- `speech.diarize`: **Blocked** - pyannote licence acceptance required, never accepted on the user's
  behalf.
- `embeddings` / `rerank`: executable **lexical** baseline only, labelled as such; neural rows
  `not_configured` (no weights). Never relabelled neural.
- `artifacts.xlsx/docx/pptx`: **retained TypeScript writers**, reported as not-migrated.
- video scenes / timeline honesty: Implemented, Unit-tested, Integrated(HTTP probe).
- thinkTags literal preservation, activity labels, scroll ownership: Implemented + Unit-tested,
  **not Live-verified**.

## Blockers / risks (recorded, not worked around)
- Tesseract binary absent; PaddleOCR-VL CPU install not yet attempted or measured; whisper CT2 weights
  not prepared; sentence-transformers weights absent; pyannote licence not accepted. These are
  deployment conditions, never "done".
- The 5 GB hard maximum has **no verified OS-level aggregate ceiling** yet; if none can be enforced on
  this host, that is an acceptance failure to report rather than hide.
- Playwright live acceptance only through `scripts\run-browser-e2e-exclusive.ps1` with Codex idle.
- The user is present and engaged: **no host shutdown this session**. The end-of-run shutdown
  authorization (`shutdown.exe /s /t 0`, no `/f`, record `shutdown_requested`, no endless retry)
  stays open.

## Harness notes that repeatedly cost time (read before running commands)
- Use `shell:"cmd"` with `workdir`; double quotes are passed **literally**, so `python -c "..."`
  breaks. `|`, `(a|b)` and `^` inside args break cmd, so use separate invocations and char classes.
  `&&` sometimes lands in PowerShell: one command per call, or `&`.
- Search with `python-backend\.venv\Scripts\python.exe .data\tmp\gr.py <regex-no-spaces> <path-or-glob>`
  (`g.mjs`/`gg.mjs` are unreliable). Readers: `.data/tmp/show.mjs <path> [from] [to]`,
  `.data/tmp/last.mjs <path> [n]`.
- `apply_patch`: Add File needs `+` on every line; multiple hunks of one file must be in file order,
  otherwise split the patch.
