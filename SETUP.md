# SETUP - Ruke on a fresh clone

Ruke is three runtimes in one repository: a **Next.js** app (`app/`, `lib/`, `__tests__/`), a **Rust**
capability server (`rust-backend/`, axum) and a **Python** capability backend (`python-backend/ruke_ml`:
documents, OCR, speech, video, retrieval behind a stdlib-only supervisor). One command starts all three;
heavy processing workers start lazily and download nothing.

## 1. Prerequisite runtimes

| needed | why | verified on this host |
|---|---|---|
| Node.js + npm | Next.js, the dev supervisor, all TS tests | Node **v26.12.1**, npm **12.2.0**, TypeScript 5.9.3 as a devDependency |
| A Rust toolchain (`cargo`) | `npm run dev` **always** runs `cargo build --manifest-path rust-backend/Cargo.toml` before starting anything, so a missing toolchain is a startup failure, not a warning | cargo **1.99.0** / rustc **1.99.0**, builds green (`docs/overnight/logs/f48-build-1.log`) |
| [uv](https://docs.astral.sh/uv/) | the dev supervisor auto-syncs the pinned Python capability stack; without uv only the stdlib supervisor runs and every heavy family reports `not_configured` | uv 0.13.0 |
| CPython 3.12 | `python-backend/pyproject.toml` requires `>=3.12,<3.13` (`av==19.0.2` made a 3.11 split unsatisfiable); `.python-version` pins 3.12 | 3.12.15 in `python-backend/.venv` |
| ffmpeg (optional, media only) | video/audio paths need a validated copy. It is **not vendored**; without it those paths return the typed reason `ffmpeg_not_installed` ("install ffmpeg or set `RUKE_FFMPEG` to a validated copy") | not installed on this host |
| Playwright browsers (optional) | only for browser/UI checks; there is a shared coordination lock, see `CODEX.md` | `.data/ms-playwright` present |

## 2. First run

```
git clone <your remote> && cd WebUI
npm install
copy .env.example .env.local        # or leave it: the Settings UI writes settings.json instead
npm run dev
```

`npm run dev` is `node scripts/dev-supervisor.mjs`. Its deterministic order, taken from that file:

1. Resolve repo root, `PORT` (default **3000**) and `RUKE_BACKEND_PORT` (default **3101**), then a
   fail-fast **wildcard-bind** pre-check. Next must never silently move 3000 to 3001: the proxy and
   bridge contracts pin both ports. A held port aborts before the build.
2. `cargo build` (always). A build failure aborts before any child exists, so no stale exe can run.
   The exe is found via `CARGO_TARGET_DIR` (resolved against the repo root) or `rust-backend/target`,
   debug profile. `RUKE_SERVER_BIN` is an advanced override that uses the given exe verbatim and skips
   the build.
3. Prepare the Python stack: reuse `python-backend/.venv` when it imports `ruke_ml` **and** the reuse
   stamp `.data/python/setup-node-<fingerprint>.json` matches the fingerprint of
   `uv.lock` + `.python-version` + `pyproject.toml`; otherwise `uv sync --inexact --extra <name>` for
   exactly the `capability_extras` listed in `pyproject.toml [tool.ruke]`
   (`documents`, `speech`, `media`, `onnx`, `hub`). The DECLARED-ONLY extras (`embeddings`,
   `diarization`, `qwen`) are **never** synced here: they are uninstalled on purpose so those registry
   rows answer `not_configured` instead of pretending to be available.
4. Start the **Python supervisor** first (stdlib-only, imports no torch/paddle/transformers, picks a
   free loopback port and publishes `.data/python/supervisor.json` for discovery), then spawn
   `ruke-server` as a direct child and wait for `GET /api/ruke/health` 200, then spawn `next dev` and
   wait for the Next port to accept connections. The ready banner prints only once both are up.
5. Teardown is PID/tree-scoped: `taskkill /PID <pid> /T /F` for trees this supervisor spawned, on
   SIGINT/SIGBREAK/SIGTERM, on exit, or when either child dies. It never kills by image name.

Useful environment switches: `RUKE_PYTHON` (interpreter override, ignored if it cannot import
`ruke_ml`), `RUKE_ML_REQUIRED=1` (fail startup if the Python stack is unusable), `RUKE_SERVER_BIN`,
`CARGO_TARGET_DIR`, `PORT`, `RUKE_BACKEND_PORT`.

## 3. Model/provider configuration (one source of truth)

Chat **and** lifecycle resolution share one precedence chain, implemented in
`python-backend/ruke_ml/models/provider_config.py` and mirrored in `lib/server/settings.ts`:

1. `settings.json` (`llm_api_url`, `llm_api_key`) - what the user chose in the Settings UI. Gitignored;
   delete the file to fall back to env/defaults.
2. Process environment.
3. `.env.local`.
4. Built-in fallback (`http://127.0.0.1:8080/v1/chat/completions`).

The unload/reload URLs are **derived from the chat URL origin**, so chat and lifecycle can never name
different servers - an earlier defect. `.env.example` lists every **provider/lifecycle** name the code
reads; dev/ops switches (`PORT`, `RUKE_BACKEND_PORT`, `RUKE_PYTHON`, `RUKE_SERVER_BIN`,
`RUKE_ML_REQUIRED`, `RUKE_ML_IDLE_TTL_S`, `RUKE_PY_RUNTIME_DIR`, `CARGO_TARGET_DIR`, `RUKE_LOG`,
`RUKE_HANDOFF_WAIT_MS`/`RUKE_HANDOFF_STALE_MS`, plus the OCR/speech run switches in
`docs/overnight/STATE.md`) all have working code defaults and are documented where they run - so an
unset switch never blocks a fresh clone. Nothing in
`lib/**`, `rust-backend/**` or `python-backend/**` references a personal install directory such as
`D:\AI\Strata`: the endpoint is configuration, not a path.

## 4. Asset and dependency preparation is explicit, never at startup

Ordinary startup downloads nothing. Preparation is an authorized setup process, and everything it
writes stays inside the repository.

| command | produces | measured on this host |
|---|---|---|
| `powershell -NoProfile -File scripts\prepare-ocr-runtime.ps1` | the isolated CPU OCR interpreter `python-backend\.venv-ocr`, uv cache in `.data\cache\uv`, manifest `.data\models\ocr\ocr-runtime.json` | pins `paddlepaddle 3.2.1` from the x64 CPU wheel index, `paddleocr 3.6.0`, and **`protobuf 7.36.2` explicitly** - the resolver's 6.33.4 contradicts sentencepiece 0.2.3's generated 7.36.1 stubs and killed a real OCR window with a `VersionError`; probe records `compiled_with_cuda False`, device `cpu` |
| `python-backend\.venv-ocr\Scripts\python.exe -m ruke_ml.models.prepare --pipeline PaddleOCR-VL-1.6 --local` | both halves of the pipeline (recognition **and** layout) at pinned revisions, staged then promoted, incomplete snapshots rejected | `.data\ml-cache\huggingface\hub\models--PaddlePaddle--PaddleOCR-VL-1.6` 1,841 MiB and `models--PaddlePaddle--PP-DocLayoutV3` 126 MiB |
| `... -m ruke_ml.models.prepare --model Systran/faster-whisper-base --local` | CPU ASR weights | 141 MiB, plus `asset-manifest.json` provenance for pinned assets |
| `powershell -NoProfile -File scripts\prepare-tesseract-runtime.ps1` | a **project-local** Tesseract: `tesseract.exe`, its runtime DLLs and `tessdata` | `.data\tools\tesseract` (126 MiB for `.data\tools`); `-VerifyOnly` re-checks version, installed language list and a real image-to-text result with explicit local paths |

`--pipeline` exists because a pipeline adapter needs more than one weight repository and its display id
is not its Hugging Face repository id. `--model` takes a repository id; both accept `--revision`,
`--force` and `--local`. Child workers get cache roots pinned by `ruke_ml/config.py`:
`HF_HOME=<repo>/.data/ml-cache/huggingface` and `PADDLE_PDX_CACHE_HOME=<repo>/.data/ml-cache/paddle`;
`RUKE_ML_CACHE_DIR` relocates the whole cache. No setup step changes `HOME`, `USERPROFILE` or any global
environment variable, and no step deletes an existing external cache.

Project-local storage, all gitignored: `.data/` (models, `ml-cache`, `tools`, `cache`, `tmp`, uploads,
exports), `python-backend/.venv` and `python-backend/.venv-ocr` (each carries a self-ignoring
`.gitignore` written by uv), `node_modules/`, `.next/`, `.env`, `.env.local`, `settings.json`,
`.ai-coordination/` (the handoff lease), `.local-search/`, `.cache/`.

## 5. Checks a contributor should run

```
npm run typecheck                      # tsc --noEmit
npx vitest run                         # 196 files / 2529 tests as of 2026-11-17
npm run contracts:check                # cross-runtime contract drift check
cd rust-backend
cargo test -p ruke-server --lib        # 263
cargo test -p ruke-core --lib          # 40
cargo test -p ruke-attach --lib        # 87
cargo test --test handoff_lease_gate   # 4
cd ../python-backend
.venv\Scripts\python.exe -m unittest discover -s tests -t .    # 432 OK
```

`npm run build` is a production Next build. Vitest has a harness guard
(`__tests__/support/live-provider-guard.ts`) that fails the run if a suite tries to generate against, or
unload/reload, the endpoint the operator has configured on disk.

## 6. What a fresh clone does NOT get for free (honest limits)

- **Primary OCR has never produced a page on this host.** The pipeline, its assets, the per-page
  escalation ladder and the coordinated model handoff are implemented and wired, and the load/unload
  round trip was executed live once; the engine itself has not yet completed a real document. Readiness
  output, a non-empty asset folder or a dry run is not evidence of execution.
- **GPU OCR is unavailable**: the pinned `paddlepaddle 3.2.1` build reports `compiled_with_cuda False`,
  so the CPU path is the only executed path. `allow_gpu=False` with a documented unblock path.
- **Diarization stays gated** on `license_acceptance_required`: a human has to accept the model terms.
- **Neural embedding and reranking adapters have no production caller**; live retrieval is the lexical
  baseline and keeps that label.
- **Artifact writers (PDF/DOCX/PPTX/XLSX) are TypeScript-owned by decision.** They are verified by
  reopening the files through the Python reader in
  `__tests__/documents/artifact-reopen-parity.test.ts`, but that makes them retained owners, not
  Python-migrated. That generated `.pptx` files carry no authored speaker notes is a recorded defect of
  the current writer.
- The 4 GB target / 5 GB hard ceiling for the Ruke tree excluding the main LLM is enforced with a job
  object plus admission, but it has **not** been measured under a real OCR load. `est_peak_*` in
  `python-backend/ruke_ml/models/registry.py` are labelled provisional and stay provisional until an
  attended run measures them.
- The main LLM is configured separately and is never used for OCR. All document/media/ML workers run on
  CPU; `FLAGS_selected_gpus=-1` is set for OCR children.
- Inference stays on the configured provider. There is no fallback to a hosted model, and the coding
  agent and this app share one capacity-1 endpoint, so heavy runs are serialized behind the handoff
  lease (`docs/overnight/STRATA-RAM.md`, `CODEX.md`).
