# CHECKLIST — FM-20261122 (model manager + GPU-first + regression repair)

**Resume here after compaction.** Brief = the user's 7-section takeover message (2026-11-22):
Settings→Models manager (HF search/download/select/delete for ASR+OCR), replace Whisper
(Parakeet/Granite/Qwen3-ASR), OCR choice + GPU-first scheduling + prompt Strata restoration,
Send gating during processing, fix F62–F75 at first failing layer, frozen full regression +
GREEN/HOLD verdict. Commits/tags/shutdown stay with the user.
SUPERSEDED PORTION (2026-11-22 engine-freeze decision, recorded B5): the Settings→Models
HF manager (search/download/select/delete for ASR+OCR) and multi-model replacement
(Granite/Qwen3) were RETIRED — release ships the FIXED Parakeet + two OCR choices;
marketplace rows are replaced by fixed-engine provisioning, offline reuse, GPU handoff
and recovery proofs. Mid-run user brief 2026-11-22 adds F80–F85 (see testing/ISSUES.md
+ Next action) to the NEXT replay.

## Baseline (established 2026-11-22, this session)
- Branch `local`, HEAD `83bbce3` (F78 release commit). Working tree: F78 docs + `tests/fr-live-regression.spec.ts`
  + regression evidence; `testing/ISSUES.md` modified (F59–F75 register). Nothing committed by this session.
- Historical verdict at 83bbce3: **HOLD** — fr-20261122b: 59/61 tests, 40✓/19✘, CS50 battery killed mid-flight,
  cancellation never ran. Full table: `docs/overnight/FILE-READING-REGRESSION.md`; defects: `testing/ISSUES.md` F62–F75.
- Controls that STAND: 119/119 frozen extraction matrix (g100), gates 2026-11-22: cargo 741/0, vitest 2607/0,
  py 581/0, tsc 0, contracts OK (`.data/tmp/file-regression/fr-20261122b/gates-summary.txt`), 5 F78 live rows PASS.
- Harness laws (from fr-20261122b, keep): forward-slash `-TestFiles`; ASCII-only .ps1 (PS 5.1 ANSI decodes BOM-less UTF-8);
  DONE markers ABSOLUTE paths; exclusive launcher `scripts/run-browser-e2e-exclusive.ps1`, isolated store `.data/e2e-store`;
  pins `RUKE_LLM_AUTOMATIC_HANDOFF=0 RUKE_OCR_ALLOW_UNLOAD=0` except the designed handoff window; :8080 reuse-never-kill.
- Host at session start: RTX 3060 12288 MiB total / **1319 MiB free** (Strata resident); 65,299 MiB physical /
  **~2.3 GiB free physical**, ~21.8 GiB free commit. Strata = :8080 pid 5088 (serves this session).
  :3000/:3101 DOWN (supervisor not running). No locks held.
- venvs: `python-backend/.venv` (3.12, ct2 whisper), `.venv-ocr` (paddleocr 3.6.0, **paddlepaddle CPU-only**, no pip → `uv pip`).
- Scratch counter `.data/tmp`: g102 used (frozen matrix) → next free **g103**.
- fr2 replay: `powershell -NoProfile -ExecutionPolicy Bypass -File .data\tmp\file-regression\fr-20261122b\fr2-submit.ps1`
  (post-fix spec sha 7D1445A6…; V-row budgets must be raised per F70 before trusting V rows).

## Stage A — model-free defect fixes (no :8080 needed)
- [x] A0 F75 harness — DONE 2026-11-22: (b) send() opt-in allowUploadRefusal, fr-G1 takes upload-boundary
      refusal as PASS (fr-G1.refused-at-upload row); (e) reporter list+json → test-results/playwright-report.json
      + spec kill-safe milestone rows (start/ready/first-token/end per test, appendFileSync per event).
      tsc 0; playwright --list 61 tests. Live kill-safety proof = C3. (a),(c),(d) fixed earlier in runner.
- [x] A1 F63 CSV row addressing — DONE (see Completed)
- [x] A2 F64 PPTX native scatter charts — DONE (see Completed; python _chart_lines xVal/yVal fallback,
      scatter.pptx fixture, MacroOoxml-adjacent suite 582 OK at the time)
- [x] A3 F66 multipage TIFF page-2 delivery + F67 animated GIF frame delivery to the model — DONE (see Completed)
- [x] A4 F68 HEIC primary-image dimensions — DONE (see Completed)
- [x] A5 F62 streaming scroll lock — DONE (see Completed)
- [x] A6 F69 — DONE (key defect, see Completed); F73 — DONE 2026-11-22 (KEY defect: "Figure 4.2 / 0–7 °C"
      occurs on NO page of doc-a.pdf; fr-P1 retargeted to Figure SPM.5 precipitation legend p17,
      EXACT –40 %…40 %; evidence-f73-spm-legend.txt); F79 S-P4/fr-P4 — DONE 2026-11-22 (see Completed);
      F74 — DONE 2026-11-22 (harness/key layer: (a) fr-P7 question+assertion extended to the WHERE
      value "kestrel" — REAL coverage gap closed, key strictness KEPT; (b) PREDECLARED ASR-spelling
      tolerance /j[oe]o harper/ U6-only, recorded in key; (c) phrase tolerance price+42 recorded in
      key S-R1. No product change. tsc 0 after spec edits.)
- [x] A7 F71 docm + F72 xlsx follow-up — DONE 2026-11-22 (model-free; live rows fr-D6/fr-X1 = C3 replay; see Completed)
- [x] A8 F70 long-video profile: decode/ASR/frames/index/restore/answer phases; repeated decodes; budgets from measurements

## Stage B — model manager + Whisper replacement + GPU-first OCR
- [x] B1 Settings→Models UI (search/inspect/download+progress+cancel/use/delete; Transcription & OCR selectors; per-upload snapshot)
      DONE 2026-11-22 (UI+control plane; per-upload snapshot field lands with B5/B6, the
      first real consumer). Three slices at the pre-agreed seam:
      lib/models/client.ts (8 tests: ID-only law deep-scanned on every captured request —
      none of the 10 forbidden keys can leave the browser; typed failure envelopes resolve,
      never throw; trackInstall to terminal state); settings keys speech_model/ocr_engine
      (NAMED engine: paddle|tesseract|"")/model_mirror/hf_token on BOTH arms — TS
      app/api/settings/route.ts publicSettings() + Rust settings_routes.rs parity
      (hf_token WRITE-ONLY: every GET/PUT response carries only hf_token_set; new Rust
      test put_persists_model_keys_and_redacts_the_token); contracts ledger regenerated
      + verified both sides (manifest_drift settings_shape_field_ledger extended).
      UI: components/ModelsSettings.tsx (pure ModelsSettingsView + container) mounted as
      the SettingsMenu "Models" tab; 15 renderToStaticMarkup tests incl. registry-id
      vocabulary law (reads registry.py) and "no forecast in visible text".
      Gates: vitest 2673/0 (25 skipped), tsc 0, cargo 758/0, contracts:check OK. py unchanged.
- [x] B2 Bridge API search/inspect/download/installed/validate/delete; Python owns assets+jobs; IDs only from browser
      DONE 2026-11-22: supervisor /models + Rust ml_models.rs (15 tests: gate refuses
      smuggled token/path/mirror keys at any depth, pinned-revision law, settings-store
      credential injection verified on the wire via request-capturing stub, passthrough
      verbatim, typed fault envelopes, route auth+registration) + lib.rs route registration
      + app/api/models/route.ts (7 tests: secret-injection, override-immunity, 400
      passthrough, TS-only not_configured, ID-only gate).
      Gates: cargo 757/0, vitest 2643/0, tsc 0, py 606/0 (unchanged this slice).
- [x] B3 Compatibility catalog from architecture/weights/processor/runtime; reason shown for adapter-needed
      DONE 2026-11-22: published tag tables as provenanced data (ruke_ml/data/
      parakeet_tdt_06b_v3_languages.json 25 European langs+auto-detect;
      granite_speech_5_470m_turboctc_languages.json 7 langs post-2026-10-21,
      English-only at rev 947f59a; qwen3_asr_languages.json 30 langs+22 zh
      dialects, hi included) captured from the model cards 2026-11-22;
      registry rows for parakeet/granite/Qwen3-0.6B + 1.7B updated (claims =
      captured tables, verified all False, adapter empty → readiness blockers
      show "no adapter code is registered"); compat.py catalog from inspect
      (format gguf/paddle/safetensors/onnx/ct2/unknown, shard-summed weight
      bytes, tag+fallback runtime, registry cross-check) wired into the
      inspect action. DECISION: Granite registers under ibm-granite/granite-
      speech-5.0-470m-turboctc — the brief's "IBM …" form does not resolve on
      the hub (fictional ids are the documented PaddleOCR-VL failure mode).
      Gates: py 622/0 (16 new: test_asr_candidates 8, test_models_compat 8;
      routing law incl. "Hindi never reaches Parakeet/Granite"). No TS/Rust
      touched this slice.
- [x] B4 huggingface_hub/Xet pinned-revision resumable downloads, project-local cache, atomic install; token in backend store; mirror law
      DONE 2026-11-22: ruke_ml/models/hfhub.py, 11 tests (test_models_hub.py) green.
- [ ] B5 FINAL DECISION 2026-11-22 (second user directive; supersedes BOTH the
      per-family plan AND the earlier same-day single-runtime pivot incl. its
      unlisted-checkpoint proof requirement and multilingual routing law):
      FREEZE ENGLISH RELEASE SCOPE.
      LAW: (1) English ASR = NVIDIA Parakeet-TDT-0.6B-v3 through Hugging Face
      Transformers. English OCR = the pinned PaddleOCR-VL pipeline with its
      matching layout model. Settings offers exactly "PaddleOCR (recommended)"
      and "Tesseract only"; Paddle page failures recover per-page via Tesseract
      while successful Paddle pages are preserved; Tesseract-only bypasses ALL
      Paddle init/probe/load. (2) ONE Transformers ASR integration + ONE
      PaddleOCR document integration + the Tesseract fallback. A new checkpoint
      is selectable only if the installed engine runs it through the SAME
      integration with zero Ruke source/registry changes; if unproven, ship the
      FIXED DEFAULTS. No more model-specific adapters. Trace callers before
      retiring Whisper/Granite/Qwen dispatch+deps. Preserve transcripts, user
      downloads, unrelated settings; migrate an obsolete ASR preference VISIBLY
      to Parakeet. (3) Adapt in-progress code: speech_jobs.py per-model dispatch,
      compat.py/registry.py exact-repo gates, documents/ocr_cascade.py
      fixed-primary decisions+reporting; reuse documents/ocr_paddle_worker.py
      and its local recognition/layout paths; trace document_jobs.py +
      video_jobs.py through the live Rust routes into Settings + attachment
      composer; capture engine selection ONCE per job; record which engine,
      revision and device processed each page/audio segment. (4) Engines live in
      Ruke's lifecycle: project-local model store + worker envs; tracked
      bootstrap+version metadata under engine/; source checkouts (if needed) at
      engine/vendor/transformers/ (github.com/huggingface/transformers.git) and
      engine/vendor/PaddleOCR/ (github.com/PaddlePaddle/PaddleOCR.git); paths
      resolve from checkout root; scripts/dev-supervisor.mjs checks stable
      updates in BACKGROUND on every `npm run dev`; stage+validate a new runtime
      BEFORE activating; working version survives active jobs/offline/failed
      updates; model revisions pinned independently; reuse assets, resumable
      downloads, safe deletion, no reinstall of unchanged deps. (5) Upload flow:
      native extraction first, OCR only where needed; audio uploads AND video
      audio tracks → the same Parakeet path; frame evidence + real timestamps
      preserved; GPU preferred for Paddle+Parakeet; measured free VRAM/RAM +
      job needs replace the fixed 5 GB rejection; Strata STAYS LOADED when the
      job fits; unload only if it makes the job fit, via exclusive lease +
      idle-inference check + one unload + released-resources confirmation; CPU
      when GPU can't safely proceed; worker loaded once per job, released
      promptly. (6) Handoff: persist extracted evidence, release worker,
      IMMEDIATELY request Strata reload when Ruke unloaded it and no other job
      owns the lease; record worker-exit / reload-request / model-ready times
      SEPARATELY; failed reload retryable from saved evidence; composer stays
      editable, draft preserved, Send enables at attachments+handoff ready,
      NEVER auto-send. (7) Update THIS checklist in place; run the English
      acceptance set on the production path (scanned/mixed/native PDFs, rotated
      text+tables, page-level fallback, strict Tesseract, English MP3, real 3+ h
      English video w/ keyed beginning/middle/end facts, timestamp boundaries,
      visual-only fact; GPU coexistence, unload/reload, CPU fallback,
      cancellation, restore failure, typing during upload, Send timing; replay
      F65+F70; existing regression gates; exclusive launcher, Claude endpoint
      slot yielded until lock release). Remaining failures -> testing/ISSUES.md
      with repro commands. Multilingual, extra checkpoints, marketplace are
      DEFERRED - they must not hold up completion.
      STATE under final decision: probe groundwork DONE - torch==2.14.1+cu126 +
      transformers==5.24.0 installed repo-venv (ParakeetForTDT shipped in
      transformers v5.9.0, PR #44171); torch.cuda True on RTX 3060; hub pins
      intact; Strata POST /unload→200 (VRAM 11147→319 MiB) + POST /load→200
      (→10959 MiB) measured. First probe run FAILED on probe-side bug only
      (map_location kwarg; use device_map= per model card) - rerun pending.
      SUPERSEDED items (do NOT revive): dedicated Whisper/Granite/Qwen adapters
      (deleted 2026-11-22), multilingual language routing acceptance (deferred),
      unlisted-checkpoint live test (conditional: ship fixed defaults if the
      zero-code selectability is unproven), B12 candidate-comparison benchmark.
      Granite/Qwen registry rows+extras REMOVED 2026-11-22 (registry.py,
      pyproject.toml, uv lock re-resolved); test_asr_candidates rewritten to
      the single-recommendation law (8/8 green).
      FINAL ADDENDUM 2026-11-22 (same run, supersedes the optional Hugging Face
      model-selection work): Settings OCR has EXACTLY two choices - "PaddleOCR"
      (default, automatic per-page Tesseract fallback) and "Tesseract only"
      (never loads Paddle). Parakeet is the SOLE English audio/video
      transcription engine: remove the ASR model selector, the Whisper
      fallback, obsolete ASR adapters. REMOVE the OCR/ASR Hugging Face search,
      model picker, arbitrary repo/revision entry, token + mirror fields and
      user-facing download/delete controls - trace their routes, settings,
      storage and deps; delete code used EXCLUSIVELY by them; PRESERVE the main
      chat model's provider settings. Keep AUTOMATIC project-local provisioning
      of the pinned Parakeet, PaddleOCR/layout and Tesseract English assets:
      reuse verified local files, show preparation progress on first use, work
      offline afterward; preserve existing transcripts + user-downloaded files.
      Migrate obsolete selections to fixed defaults while PRESERVING an explicit
      Tesseract-only preference. Verify fresh install, existing install, offline
      reuse, and both OCR modes through the live upload path. Keep agreed GPU,
      Strata handoff and upload-readiness behavior.
      VALIDATED 2026-11-22 (g103 probe, .data/tmp/g103/probe-result.json):
      checkpoint nvidia/parakeet-tdt-0.6b-v3 rev 541d1f99c6b0c3cd0b11a95167540bb8edefd82b
      on transformers==5.24.0 + torch==2.14.1+cu126, Windows/RTX 3060 driver 621.35.
      CUDA: 11.04 s clip, load 3.7 s, generate 0.4 s, correct text, 40 token
      timestamps, peak alloc 2463 MiB (2845 MiB device-used w/ context) -> fits
      after Strata POST /unload (200; VRAM 11147->210 MiB). CPU recovery: same
      checkpoint, same text+timestamps, load 3.2 s, generate 0.3 s. POST /load
      200 -> Strata resident (10.3 GiB) at exit. Load via from_pretrained(dtype=
      "auto")+model.to(device) - device_map needs accelerate, NOT installed, do
      not add it.
      DONE 2026-11-22: (1) transformers_asr entry green 10/10 (test_transformers_asr:
      English gate before load, GPU→CPU recovery w/ honest note, one load/job, VRAM
      release, absolute token timestamps, hub-offline default, no remote code, typed
      asset/dependency failures, cancel-stops-generation w/ kept partial, no-speech
      verdict). (2) speech_jobs fixed-default dispatch: payload "model" selector
      REMOVED (obsolete values ignored, law comment records why), per-segment
      engine/revision/device recorded; test_asr_dispatch 9/9 incl. obsolete-selector
      immunity. (3) registry English freeze: Parakeet row pinned to g103 revision +
      MEASURED admission figures (g104 CPU probe .data/tmp/g104: peak working set
      3142 MiB / peak commit 4283 MiB; g103 VRAM 2845 MiB device-used), Whisper ASR
      rows removed (silent-switch law), NeMo parakeet_tdt adapter retired, speech.align
      Systran row kept (388/1276 facts live there). Eval gate retargeted
      (asr_multilingual→asr_english_quality on Parakeet, honest installed_but_unmeasured);
      compat cross-check updated (row+adapter → executable, blockers empty);
      memory-kinds retargeted to the 4283 measured commit (gate strength unchanged).
      Full py suite GREEN: Ran 641 tests, OK. Speech area 101/101.
      DONE 2026-11-22 (removal sweep + migration): HF search/picker/token/mirror/
      download surface DELETED — app/api/models, lib/models, components/
      ModelsSettings, ml_models.rs + its /api/ruke/ml/models route, 3 model tests
      (chat provider settings + model-stats PRESERVED; python side verified clean
      at F79 start). Settings migration BOTH sides with parity
      (app/api/settings/route.ts ↔ settings_routes.rs): stored hf_token/
      model_mirror PURGED on first read via new replaceSettings/replace_settings
      (merge-patch cannot express purge); retired writes IGNORED; non-Parakeet
      speech_model rewritten to nvidia/parakeet-tdt-0.6b-v3 ONCE, persisted, and
      VISIBLE — migrating response carries speech_model_migrated:<old>, consumed
      by lib/settings/client getEngineMigrationNotice(); explicit Tesseract-only
      preserved; ""/paddle = PaddleOCR default; responses never carry hf_token/
      model_mirror/hf_token_set. New Settings→Engines tab (components/
      EnginesSettings.tsx: fixed Parakeet row, exactly PaddleOCR (recommended) /
      Tesseract only radios, migration note; SettingsMenu tab models→engines).
      Gates on this tree: settings_routes 6/6 incl. migration-visibility pins;
      ruke-contracts 6/6; ruke-server+core full GREEN; manifest regenerated
      (settings ledger = 5 live fields, retired keys gone) + contracts:check OK;
      tsc exit 0; vitest FULL 2652 passed/25 skipped/0 failed (rewritten
      settings-model-keys 10/10 + new engines-settings-view 7/7, PARAKEET_ID
      pinned cross-language).
      DONE 2026-11-22 (F79, law (4) engine/ bootstrap + dev-supervisor):
      engine/manifest.json is the tracked bootstrap+version metadata: ASR
      (nvidia/parakeet-tdt-0.6b-v3 @541d1f99…, measured stack transformers
      5.24.0 + torch 2.14.1+cu126, integration path), OCR-Paddle runtime pins
      mirroring ocr_runtime.PINNED + Paddle index + asset revisions
      (PaddleOCR-VL-1.6 @132c45f5…, PP-DocLayoutV3 @241f8bdf…), Tesseract
      installer pin 5.5.3.20260724 + tessdata_best, declared-optional vendor
      slots (engine/vendor/transformers, engine/vendor/PaddleOCR; gitignored,
      nothing auto-downloads), per-engine stable update_channels.
      scripts/engine-updates.mjs: report-only stable check (PyPI JSON, Paddle
      PEP-503 wheel index, GitHub releases) → .data/python/engine-updates.json;
      15 s per-request timeout; offline = RECORDED unreachable; NEVER installs
      or activates. dev-supervisor spawns it DETACHED+unref'd after the ready
      banner (stdio→.data/python/engine-updates.log, deliberately NOT in the
      teardown children set, opt-out RUKE_ENGINE_UPDATES=0); the exact spawn
      options were run standalone: child finished cleanly, parent never waited.
      Fresh-machine ASR bootstrap GAP CLOSED: pyproject gains the INSTALLED
      extra asr = [transformers==5.24.0, torch==2.14.1] with the torch source
      routed to the explicit PyTorch cu126 index (==2.14.1 accepts the measured
      2.14.1+cu126 local version), conflicts rows [asr,embeddings]+[asr,parakeet]
      (verified unsatisfiable families from the resolved lock: embeddings lands
      on transformers 4.57.6+tokenizers 0.22.2), capability_extras += "asr" →
      `npm run dev`'s uv sync now provisions the SOLE ASR engine. uv lock OK
      in an isolated copy first, then in place; `uv lock --check` OK;
      `uv sync --inexact --extra asr` = no-op on this venv (transformers 5.24.0
      + torch 2.14.1+cu126 confirmed present).
      Gates: new tests/test_engine_manifest.py 10/10, mutation-checked (a
      protobuf pin flip in the manifest → RED, restored → GREEN); speech+
      engine+ocr_fixed_primary 49/49; contract-manifest+engines-settings-view
      vitest 15/15; FULL py 633/633 OK (623+10, -t . runner). Checker run live:
      transformers current-stable at pin; honest findings torch 2.15.0,
      paddlepaddle 3.4.0, paddleocr 3.7.0, tesseract 5.5.4 — recorded, NOT
      installed.
      DONE 2026-11-22 (F79, automatic provisioning w/ first-use progress).
      The owner is speech_jobs.asr_job — the ONLY place first use can happen
      (one engine, weights NOT pre-installed, no model page). At the
      readiness gate: when the ONLY unmet condition is the pinned asset
      (implemented+deps+config+access all satisfied), the job provisions NOW:
      ctx.progress("preparing_model", "<repo>@<pinned-revision>: downloading
      the pinned model for first use…") → assets.prepare at the ROW's pinned
      revision (never floating main) → ctx.cancel checked after the minutes-
      long download → failed preparation is model_unavailable with an
      actionable resume-the-download step and the engine is NEVER invoked
      over invalid weights. Every other blocker keeps the old shared-readiness
      refusal (downloading weights fixes no missing adapter/licence).
      Warm path: assets.asset_state (offline, pinned revision, required
      files) supplies snapshot_dir so the adapter loads with ZERO network;
      injection is signature-gated by _accepts_kwarg — whisper_ct2.transcribe
      declares no snapshot_dir/**kwargs, so it is called exactly as declared
      (B6-compat law). transformers_asr's asset_missing human_step ("the
      first upload prepares it automatically (progress is shown in the
      composer)") is now literally true. Vocabulary: preparing_model added
      to contracts.PROGRESS_STATES + capabilityStatus JOB_STAGES/label
      ("Preparing the pinned model (first use)"), drift-pinned; wire chain
      verified: runner _progress → lifecycle current_stage/current_note →
      capabilityStatus.ts record.
      Gates: TDD red→green (3 of the 5 new Provisioning tests failed on real
      code pre-implementation); test_asr_dispatch 14/14; speech+dispatch+
      engine_manifest 53/53; capability-status+frameocr+contract-manifest
      vitest 64/64; FULL vitest 2652/0 (25 skipped); tsc 0; FULL py 638/638
      OK (633+5, -t . runner, .data/tmp/py-full-f79e.log).
      NEXT: measured admission (B8) → handoff (B10) → Send gating (B11) →
      English acceptance set. (B6 Whisper-removal also still open.)
- [x] B6 DONE 2026-11-22 (F79): Whisper is out of the production transcription path.
      Four implicit doors closed, each pinned by tests/test_b6_whisper_out_of_production.py (6 laws):
      * EXECUTION: runner._PRELUDE["speech.asr"] was ("numpy","faster_whisper") - every ASR
        worker imported CT2's native lib at the handshake, ahead of dispatch. Now
        ("numpy","torch","transformers"): the SOLE engine's graph, single-threaded per the
        measured hang law (numpy builds its pool alone). test_supervisor_workers handshake
        pin retargeted to the engine graph + asserts faster_whisper NEVER preloads;
        OwnedWorkers ready-timeout 10s->30s (measured torch+transformers import, far under
        production 45s). Registry law (no speech.asr row names whisper in id/package/adapter)
        pinned as a regression lock.
      * DOWNLOADS: the `speech` extra (faster-whisper==1.2.1, ctranslate2==4.9.0) sat in
        [tool.ruke].capability_extras, so `npm run dev`'s `uv sync --inexact --extra speech`
        downloaded Whisper on every fresh machine. DEMOTED to DECLARED-ONLY (pins kept as
        the aligner row's declared dependency; pyproject law: a row naming a DECLARED-ONLY
        extra answers not_configured). `uv pip uninstall faster-whisper ctranslate2` from
        .venv (project-local) so the claim is TRUE on this host: Systran align row now
        answers executable=False / not_installed with the dependency blocker,
        alignment.decide -> not_executable, whisper_ct2.import_backend -> typed
        dependency_missing. dev-supervisor.mjs reads capability_extras from pyproject
        (no hardcoded name), and the `asr` extra stays bootstrapped (engine provisioning
        law pinned in the same test file).
      * REPORT: speech_status() answered its language_table from Whisper's captured table.
        Now the SOLE engine's published table (candidate_language_tags(PARAKEET_ID), 25 tags,
        card provenance) - the ASR capability report carries zero whisper provenance.
        Whisper's table stays as data for the aligner row (B5 law).
      * HUMAN SURFACE: prepare.py --model help example Systran/faster-whisper-base ->
        nvidia/parakeet-tdt-0.6b-v3; language_route's non-English human_step no longer
        recommends "a multilingual Whisper checkpoint" (names the deferral instead);
        ocr_runtime/ocr_paddle_worker venv-isolation comments + registry dual-role comment
        retargeted to the current base-venv set.
      MP3/audio/video -> selected-model contract and segment times/channels/cancel/
      provenance ride the B5 dispatch law (the engine that runs is the module the ROW
      names) and stay green in test_asr_dispatch/test_transformers_asr/test_speech.
      KEEP (not implicit execution): whisper_ct2.py as the declared aligner adapter,
      supervisor startup-import guard list, ASR_TO_ALIGNER data, whisper data table,
      historical measurement evidence comments (allocations/resources/lifecycle/registry).
      Gates: new B6 file 6/6 (red 4 on real code first); speech/ASR suites
      (b6+speech+asr_vad+speech_audio+memory_kinds+asr_dispatch+transformers_asr+
      worker_protocol) 119/119 (1 skip = ctranslate2 guard, expected post-uninstall);
      test_supervisor_workers 26/26 (real ASR handshake on the new prelude);
      FULL py 651/651 OK (645 baseline + 6, -t . runner, docs/overnight/logs/f79-b6-fullpy.log).
      NEXT: B9 (CUDA paddle GPU-first build) -> B10 -> B11 -> C1-C6.
- [x] B7 OCR choice: PaddleOCR default → Tesseract fallback only for unread pages; Tesseract-only = ZERO Paddle probes; native text kept
      DONE 2026-11-22 (F79, ocr_cascade fixed-primary law).
      policy(): the primary is FIXED to the two release choices, resolved through
      the app-side chain settings.json(ocr_engine) > env(RUKE_OCR_PRIMARY) >
      default; env aliases normalised; an arbitrary engine/repo pin (the removed
      model-manager surface) is REPORTED in selection_source and NOT honoured;
      corrupt/junk settings.json = unset, never an OCR-job error.
      Tesseract-only: run() and status_report() carry ZERO Paddle probes
      (ocr_paddle.engine_state is monkeypatched-to-raise in the tests as proof);
      the primary block reports probed:False + "the user chose Tesseract only";
      the recovery reason names the CHOICE, not "pipeline unavailable";
      the persisted record self-describes primary_engine=tesseract.
      status_report/main(): exit answers the SELECTED engine (tesseract
      availability under Tesseract-only; Paddle readiness under the default —
      recovery-available-is-not-a-pass kept intact).
      run() now acts on the policy RECORDED in its report (no second policy() read).
      Gates: new tests/test_ocr_fixed_primary.py 11/11; test_ocr_resource_window +
      test_handoff_devices 94/94; test_ocr_fallback + test_ocr_runtime_env +
      test_provider_config 50/50; FULL py 623/623 OK (runner:
      `.venv/Scripts/python.exe -m unittest discover -s tests -t .` from
      python-backend — plain `-s tests` breaks test_handoff_devices' relative
      import at discovery; known quirk, use -t .).
- [x] B8 DONE 2026-11-22 (F79): fixed 5 GB ceiling retired - MEASURED budget law in job_limits.py.
      normal_ceiling_bytes() is now measured like the exclusive window: min(configured normal
      cap RUKE_LIMIT_BYTES default 7 GB (band 1 GiB..12 GB), free commit - 2 GiB reserve,
      free physical - 1,024 MiB floor - reserve); the physical clamp IS the Strata-resident
      reservation (job object bounds commit, commit >= resident RAM, commit-only cap pages the
      model); measured host with no headroom -> CEILING_FLOOR_BYTES 256 MiB + reserve-naming
      reason (demand check refuses typed, never squeezes); unmeasurable host -> AGGREGATE 5 GB
      as the DOCUMENTED FALLBACK, measured=False, reason says fallback. Every figure in the
      report (commit_budget_bytes/physical_budget_bytes/bound_by/budgets). exclusive_ceiling_bytes
      now decides widened_beyond_normal/window_gained_nothing against the MEASURED normal
      ceiling, not the constant. install_process_job default 0 resolves the tree cap from the
      EXCLUSIVE ceiling (nested jobs compose by minimum - a startup-tight tree cap would veto
      every future unload); limit_source provenance in report + supervisor startup line;
      RUKE_ML_MEM_CEILING_BYTES honored as operator cap (CLI default 0). lifecycle
      _ceiling_bytes upper bound = measured window (note: window_ceiling_bytes/window_bound_by)
      + shared CEILING_FLOOR_BYTES. status() reports normal_ceiling_bytes + fallback_limit_bytes.
      VRAM term verified pre-existing: devices.device_plan gates GPU on measured nvidia-smi free
      VRAM (est_vram unmeasured disqualifies GPU), CPU passes resources.admission, needs_handoff
      only when RAM does not fit with the main model resident -> "Strata STAYS LOADED when the
      job fits" is the admission answer, unload path is the exclusive window.
      TDD: red 7 (NormalBudgetArithmetic + widens-for-real-unload) -> green; test_job_limits
      pins rewritten to the new constants; test_memory_policy clamp test updated to
      free-floor-reserve law; WorkerCeilingArithmetic now deterministic (mocked hosts, no
      host-luck pins). Gates: test_ocr_resource_window 36/36, affected 8-suite run 195,
      FULL py 645/645 OK (logs/f79-b8-fullpy.log). Python-local - grep confirmed zero TS/Rust
      consumers of the constants.
- [x] B9 GPU-first: CUDA paddle build (project-local venv); verify real GPU inference; Strata release/handoff per section 4 — DONE 2026-11-22
      Pin paddlepaddle-gpu==3.2.1 from the model card's cu126 index; x64 CPU wheel is the
      RECORDED FALLBACK (PADDLE_FALLBACK_DIST), never a co-equal pin. prepare-ocr-runtime.ps1
      installs GPU-first with CPU-index fallback + records paddle_build/paddle_index;
      engine/manifest.json runtime.index=cu126 + index_fallback=cpu (test rewritten as the
      law change); engine-updates.mjs matches PEP 425-normalised wheel names
      (paddlepaddle_gpu-3.2.1). venv installed (nvidia cu126 deps; stock safetensors 0.7.0
      kept - the special wheel is the model-card SERVER path, the pipeline is measured
      working). Probe: is_compiled_with_cuda true, gpu compute ok (sm_86); ocr-runtime.json
      records {"paddle":"3.2.1","compiled_with_cuda":true,"device":"gpu:0"}; resolver
      True|gpu:0|True (GpuFirstRuntime 5 tests).
      LIVE GPU inference verified in a coordinated exclusive window (window 2, 22:09):
      Strata unloaded (freed 53,893 MiB phys / 10,833 MiB VRAM), paddle ran device gpu:0
      with plan/echo agreement, load 7.46 s, page 1 recognised (engine paddleocr-vl-1.6,
      structured bboxes, coverage complete), worker released, Strata restored + ready 200.
      Window 1 showed the ceiling law working: worker killed at commit peak 7,278 MiB
      against the 6,675 MiB configured ceiling -> Tesseract fallback read the page.
      Registry calibrated to MEASURED figures: est_peak_mib 2,620 (resident peak; commit
      peak 10,327 recorded in basis), est_peak_vram_mib 8,100 (sampler phase peak 8,241
      minus ~200 baseline; does NOT fit beside the resident main model -> unload window).
      Admission law fix found by the gate: the pool never charges a caller-gated
      capability (documents.ocr) the registry engine estimate (lifecycle._admission) -
      the exclusive handoff charges the engine; the cascade/Tesseract recovery survives.
      Handshake test stub widened to the ceiling per the B8 law (documented at the seam;
      production typed refusal untouched). Strata maintenance during the gate: unload
      freed 53,975 MiB, reload ready 200, steady-state WS 49,218 MiB recorded.
      Gates: FULL py 657/657 OK (logs/f79-b9-py-gate.txt); evidence docs/overnight/logs/
      f79-b9-gpu2-{p1.json,window.log} + persisted .data/python/ocr-results/6e69b220...json.
- [x] B10 Strata restoration dispatch from worker completion (no UI poll); one reload owner; measured dispatch latency; evidence retained on failed reload — DONE 2026-11-22
      Four laws pinned red->green in tests/test_b10_restoration.py (9 tests, new):
      (1) DISPATCH AT WORKER COMPLETION + MEASURED LATENCY: mid-work the provider
      calls are ["unload"] only; by run_exclusive's return ["unload","load","ready"].
      The window report carries restore_dispatch_ms (releasing_worker ->
      restoring_main_model, from journalled phase timestamps) and restore_ready_ms
      (dispatch -> verified ready), wired at all three restore sites via
      handoff._restore_timings; timings ride into the cascade report as
      casc["handoff_restore"]. +1 timing test in test_handoff_devices.
      (2) ONE RELOAD OWNER ON RESTART: handoff.recover_at_startup() yields to a LIVE
      lease (loads nothing, journal left to its holder), restores exactly the
      journal-recorded model on a stale/absent lease (never loads what the journal
      says was not loaded), clears the journal only on verified ready. Wired in
      supervisor.main() as a daemon thread (a real load takes minutes; must not
      block /job); source-contract test asserts supervisor.py is the ONLY
      server-side journal-recovery caller. ruke_ml.handoff stays startup-light -
      StartupContract green in the same run.
      (3) EVIDENCE RETAINED ON FAILED RELOAD: reason restore_failed, persisted work
      path named before the reload attempt, journal survives with original.loaded,
      lease released; startup recovery RETRIES FROM THE JOURNAL (fail-once stub:
      first retry fails -> journal kept, calls ["load"]; second succeeds -> cleared).
      (4) NO UI POLL: tree scan of app/, components/, lib/ for
      /load|reloadUrl|LLM_RELOAD_URL - zero offenders outside the three allowed
      owners (settings.ts derivation, extract/audio.ts + coordination/llm-lease.ts
      lease-holder paths).
      Gates: FULL py 667/667 OK skipped=1 (logs/f79-b10-py-gate.txt); baseline 657
      + 10 new. No TS/Rust touched - py gates are the B10 gates.
- [x] B11 Send gating: chip immediate, textarea editable, phases shown, Send disabled while processing, Enter never queues, enable at evidence+restore done, Retry/Remove — DONE 2026-11-22
      Law as a PURE decision (lib/chat/composerGate.ts, new) + component wiring in
      components/ChatInput.tsx; 7 tests red->green in __tests__/ui/composer-send-gate.test.ts.
      (1) CHIP IMMEDIATE: validateAttachment is synchronous, status starts "pending" -
      from that first state moment the gate is closed on the chip.
      (2) TEXTAREA EDITABLE: the gate never disables the textarea; a closed gate
      swallows Enter/Click, draft untouched.
      (3) PHASES SHOWN: chipPhase label rendered inside the chip
      (data-testid="chip-phase": "Queued"/"Reading…"; ready/error show no spinner label).
      (4) SEND DISABLED WHILE PROCESSING / ENABLE AT EVIDENCE+RESTORE DONE:
      canSend = content && !isLoading && attachments.every(status==="ready");
      "ready" is the SERVER contract - /api/files/extract answers only after the
      evidence is persisted AND run_exclusive restored Strata inside the request
      (B10), so the composer enables exactly at evidence+restore completion with
      NO UI poll. Behavior change: an errored chip now KEEPS THE GATE CLOSED
      (previously sends shipped over unread files); the user Retries or Removes.
      (5) ENTER NEVER QUEUES: Enter is preventDefault + the same gated handleSend;
      enterSends IS canSend (pinned by test).
      (6) RETRY/REMOVE: every chip removable (canRemove); failed reads get a Retry
      (canRetry, RotateCw) backed by a retained File-ref map (attachFiles) -
      retry moves the chip to "processing", re-closing the gate; remove aborts
      the in-flight read (I15c) and drops the File ref.
      Gates: vitest 2659/2659 passed (25 skipped, 0 failed; baseline 2652 + 7),
      tsc exit 0. Existing live specs inspect-compat: fr rows click SEND only at
      chip data-status="ready"; chipLabel rides the progress panel, not the chip.
      DOM journey = C5 exclusive Playwright row.
- [ ] B12 SUPERSEDED 2026-11-22 (final decision): ASR candidate comparison is out of
      scope - English release ships fixed defaults; extra checkpoints/marketplace deferred.

## Stage C — live proof (exclusive, single-slot, Claude dormant)
- [x] C1 RESCOPED+COVERED 2026-11-22: "select Parakeet → selected revision" is RETIRED UI —
      the 2026-11-22 engine freeze (B5) removed the HF model manager (search/picker/download);
      Speech is the FIXED Parakeet with automatic project-local provisioning
      (components/EnginesSettings.tsx `engines-speech-fixed`, FIXED_SPEECH_MODEL; no selector
      exists to select). The live MP3 → keyed timestamped answer proof on the shipped fixed
      engine = fr-U7 (audio middle: stated weight, F78 transcript law) inside the C3 replay.
- [ ] C2 Vertical slice #2: scanned PDF with selected OCR — = fr-P10 (OCR cascade) inside C3,
      + the Tesseract-only half now lives in the rescoped C4 row
- [x] C3 DONE 2026-11-23 (overnight): frozen 61-row replay via .data/tmp/file-regression/f79-c3/
      f79-submit.ps1 — GATE=PASS EXIT=1, lock acquired/released cleanly; 61/61 executed,
      47 PASS / 14 FAIL (results-live.jsonl + test-results/playwright-report.json).
      Attribution (all evidence-backed, ledgers F80–F89): scorer/harness — X1/S-X4 + U6
      card-chrome reader, P9 refusal scorer; fixture/key — P10 (F81), S3/S4 deck-4 (F83),
      S-V1 audio-question keyed to frame fact, S-V5 begin-card text, R1 strict key;
      window — U1 (first-token 681 ms, streaming, 360 s model window; content quality proven
      06:01 run); product — F80 web-escape CONFIRMED via Rust dispatch events (P1 turn 27
      rounds 1–7 18:13–18:17; P2/P3 nine web rounds 19:46–19:53; ZERO web in U1 window),
      F86 Z1 spec-vs-B11-gate collision, F87 .mat key needs structured MAT parse (product
      contract = legacy strings recovery, extensions.ts:66), F88 O3 notes self-censorship.
      Zero product regressions vs 83bbce3: every F5x–F79 law row passed (T/G/D/S1/S2/X2/X3/
      X6/N/A/I/P5/P6/P4/U4/U7/V2/L/O1/O2/A/P11 groups).
- [ ] C4 RESCOPED 2026-11-22; ROWS SET 2026-11-23 (F97, per run brief "Replace retired
      Hugging Face marketplace tests with fixed-engine provisioning, offline reuse, GPU
      handoff and recovery"): search/download/cancel/resume/switch/delete rows are RETIRED
      with the HF model manager (source evidence: components/EnginesSettings.tsx header,
      B5 sweep STATE.md) — no UI owner remains. C4 now carries exactly these replacement
      rows, one per brief column:
      (a) FIXED-ENGINE PROVISIONING — Settings shows exactly two OCR options + fixed
          Parakeet, retired model browser absent, unrelated provider settings preserved;
          fresh preparation from an isolated empty project cache with progress
          (carrier: existing engines-settings live row + C1 provisioning evidence).
      (b) OFFLINE REUSE — warm restart with the engine cache present and network off:
          capability report stays ready, zero download probes (carrier: py
          engine-manifest offline vectors + live settings restart row).
      (c) GPU HANDOFF / COEXISTENCE — one BROWSER journey: displaced-Strata handoff,
          immediate restore request on final owner release, cancellation during a real
          job then a successful short job, failed restore retryable from saved evidence
          without re-OCR/re-ASR, worker-exit/reload-init/provider-ready/Send-enabled
          timestamps distinct (carrier: F91 tests/fr-gpu-handoff row; deterministic
          worker proof f79-b9-gpu2-p1.json job 60918300b06202a4 cuda:0 5967 MB peak).
      (d) RECOVERY / ENGINE ISOLATION — Tesseract-only ZERO-probe: radio
          `engines-ocr-tesseract` ⇒ scanned PDF answered, Paddle worker never launched,
          per-page engine recorded, primary+fallback provenance + mixed-document
          behavior in one live journey (carrier: F90 tests/ocr-tesseract-only.spec.ts);
          restoration-failure fail-closed half stays pinned model-free
          (cargo restore-dispatch + py, B10).
      (a)+(b) reuse existing live rows; (c)+(d) are the new exclusive rows to author
      after C3 releases the lock.
- [x] C5 typing-during-upload test — DONE-PASS 2026-11-22: tests/composer-send-gate.spec.ts, exclusive run exit 0 (lock 55e25d6d, fixture doc-a.pdf ~12 s window, chip visible with phase label, SEND disabled + Enter x2 → 0 chat requests + draft kept, ready → 1 click = 1 /api/chat request, draft consumed; model turn stopped to free the slot). Pure decision half pinned model-free in __tests__/ui/composer-send-gate.test.ts (7/7).
- [x] C6 Final table + GREEN/HOLD recommendation — DONE 2026-11-24: final scoreboard + **GREEN (conditional)** recommendation appended to `docs/overnight/FILE-READING-REGRESSION.md` (supersedes Nov-22 mid-stop HOLD); matrix reconciliation + F143/F123 classification appended to `testing/ISSUES.md`. Condition = F143 pagefile (system-state user decision); product layer fully green.

## Completed (this session)
- **A1 F63 CSV row addressing — DONE (model-free; live row = C3).** Shared RFC4180 annotator
  `lib/files/csv-records.ts` (Row 0 header + Row N labels, one physical line per logical record,
  escaped embedded breaks, unclosed-quote ⇒ passthrough). Wired: docProcessor browser path (the
  18 KB fixture's REAL path), `transformText` server path, `chunkRecords` (build.ts routes csv/tsv).
  Tests `__tests__/server/extract-csv-rows.test.ts` 6/6 GREEN; full vitest **2613/0** (2026-11-22 13:09).
  Real fixture verified: Row 50 = key cell. Spec fr-T3 question retargeted to labelled "Row 50"
  (fixture never had the R-50 id — spec fingerprint change, record sha at C3 freeze). ISSUES.md F63 updated.

- **A2 F64 PPTX native scatter charts — DONE (model-free; live row = C3).** Root cause: scatter/bubble
  series cache PAIRED points under `c:xVal`/`c:yVal` (NOT `c:cat`/`c:val`); python `_chart_lines`
  emitted nothing for them (TS pptx reader is text-only; python body wins the content-coverage merge,
  so python IS the live layer). Fix in `parser.py::_chart_lines`: xVal/yVal fallback emitting
  `(x, y)` pairs + "scatter points" label, cached values verbatim. Held-out coverage: frozen
  `fixtures/f78/all-readers/scatter.pptx` (generator `.data/tmp/g103_scatter/make-scatter.py`,
  mirrors deck-4 chart1.xml) + `test_scatter_xval_yval_points_reach_the_body`; PptxLaws 5/5; full py
  suite **Ran 582 OK** (2026-11-22). Ground truth on the REAL audit fixture deck-4.pptx:
  `[chart chart1.xml series "Sales" scatter points] (1st Qtr, 8.200000000000001), (2nd Qtr, 3.2),
  (3rd Qtr, 1.4), (4th Qtr, 1.2)` lands in the rendered body (bar-chart control sample.pptx
  `East=83, West=42` still green → cat/val path untouched). Rust payload check: no mirror change —
  the chart line is plain indexed text; the defect was extraction. ISSUES.md F64 updated.

- **A3 F66 multipage TIFF + F67 animated GIF delivery — DONE (model-free; live rows = C3).**
  Root cause was ONE seam: the decoder (F78-B libvips pages) and docProcessor already carried every
  page/frame in `att.frames`, but `attachmentParts` case "image" (lib/chat/client.ts) shipped ONLY
  `att.dataUrl` — the model truthfully said "I can only see the first page" (fr-I1) and answered the
  last-frame question from frame-1 content (fr-I3 trap). Second gap at the decoder: MAX_IMAGE_PAGES=8
  sliced the FIRST 8 of 24 frames, so the fr-I3 last-frame fact was undeliverable and `pages` lied
  (8, not 24). Fixes: (1) client.ts sequence delivery — every kept image IN ORDER with
  `Image k of N:` labels, intro maps page N/frame N → Image N, coverage disclosed when capped
  ("Showing N of them IN ORDER, including the first and the LAST"); (2) ffmpeg.ts `pagePicks(n,cap)`
  spread decoder window {0, n-1} + evenly spaced, TRUE-total `pages`, frames carry 1-based true
  positions; sharp + sharp-heic paths routed through it. n≤cap (3-page TIFF, 2-page panels) stays
  contiguous → old labels untouched. Rust payload: no mirror change (parts pass through verbatim).
  Tests: attachment-frame-labels new describe 6/6 (11/11 file), extract-images-pages 12/24-frame
  spread laws (last at = true total), extract-image-ffmpeg I07 law UPDATED to the spread
  (pages 20, ats [4,6,9,12,15,17,20]). Gates 2026-11-22: full vitest **2620/0** (25 skipped),
  tsc exit **0**. Live fixtures: img-2.gif 24 frames, img-1.tiff 3 pages. ISSUES.md F66/F67 updated.

- **A4 F68 HEIC dimension fidelity — DONE (model-free; live row = C3).** Probe verdict at the first
  failing layer: the decoder was ALREADY honest — live img-3.heic ispe = 1280×720 and the production
  decode shipped a 1280×720 raster. "1250 × 612" was a vision estimate: NO verified dimensions ever
  reached the model (server path set none; browser set the DOWNSCALED overview size; delivery never
  mentioned them). Fix: `ImageDecode.width/height` = primary image SOURCE dims (sharp container
  metadata / wasm `imgs[0]` decoded raster / ffmpeg-fallback first-PNG metadata; never the ≤1280
  delivery raster, never a thumbnail, omitted when unestablished); carried through `ExtractResult` →
  `docProcessor.extractOnServer` → `Attachment.width/height` (type already had the fields; no
  component consumers — safe redefinition); browser `encodeImage` reports the SOURCE bitmap size
  (1080×19000 screenshot ≠ 72×1280 overview); `attachmentParts` states `— W × H pixels` in the
  image label / sequence intro, claims nothing when unknown. Tests RED→GREEN: decoder dims equal
  the ispe parsed from the container boxes (reference.heic 1280×854, .heif; thumbnail 320×212 not
  chosen), flat fixtures = file metadata, 1080×4000 portrait keeps SOURCE dims; delivery verbatim +
  omission law. Live fixture re-probe: DECLARED 1280×720 = fr-I4 key. Gates 2026-11-22: full vitest
  **2626/0** (25 skipped), tsc exit **0**. ISSUES.md F68 updated.

- **A6 (part 1) F69 late-month PDF fidelity — DONE (KEY defect at first failing layer; live row =
  C3 replay).** Model-free probe (pdfjs full render: 61,168 chars, 36 pages — evidence
  `file-regression-fr-20261122a/evidence-f69-page-month-map.txt`): "March 2026" occurs ONLY on the
  cover (p1); every late "direction" mention is OfS/academies boilerplate or the future CAD 2026-27
  → the key's "late-in-file relationship" premise is FALSE. The file states its coverage period
  literally — "financial year ending 31 July 2026" (p3, body idx 760). Cover + coverage fact both
  sit inside the opening 4,000-char preview of the indexed body (PREVIEW_CHARS=4000, index.ts:124),
  so the live payload carried BOTH and "July 2026" was a SUPPORTED reading of "cover" — extraction
  and retrieval never failed. Fix = harness/key only: fr-P5 question retargeted to the ANSWER-KEY
  P5 cover wording ("What month and year is printed on the cover…"; EXACT March 2026 kept, its only
  occurrence = cover), S-P5 key row marked SUPERSEDED. No product change (content-neutral law).
  Gates 2026-11-22: full vitest **2631/0** (25 skipped), tsc exit **0**. ISSUES.md F69 updated.
  Spec+key fingerprint changes recorded for C3 freeze.

- **A5 F62 streaming scroll lock — DONE (harness fix at first failing layer; live row = C3
  replay).** Probe verdict: the PRODUCT law is not the defect. Pure reducer (F19
  `lib/ui/scrollFollow.ts`) is green, and the live release was already verified at F77 by
  `scripts/scroll-verify/check-upscroll.mjs` (wheel −60 mid-stream → no yank-back, pill; exclusive
  Playwright green at 3295f43). The fr-T1 ROW was unmeasurable: recorded answer 81 chars (one
  sentence) → content fit the viewport (maxScrollTop=0) → the harness's programmatic
  `scrollTop=0` at TTFT was a no-op; law 4 (only real gestures create intent) + `clampedAtEnd`
  keep following when everything is visible → bottomGap=0 is forced, gap>160 unreachable.
  Fixes: (1) harness `scrollUpMidStream` now drives the live-verified real-gesture shape — wheel
  −400 over the scroller, gated on content exceeding the viewport by 200 px; (2) fr-T1 question
  retargeted to a TALL answer (code block: first 40 lines verbatim + final sentence; key
  assertion "copying conditions" unchanged; spec fingerprint change, sha at C3 freeze);
  (3) focused regression at the pure seam: 5 tests replaying the fr-T1 event orders (fitting-
  content no-op lesson, wheel-up release + pins stay OFF through stream end with gap>160,
  scrollable programmatic jump releases by geometry, synchronous unpin beats the queued rAF pin
  (caller re-reads `shouldPin`), return-to-bottom re-engages). Gates 2026-11-22: focused 28/28,
  full vitest **2631/0** (25 skipped), tsc exit **0**. ISSUES.md F62 updated.

## Completed (this session, cont.)
- **F79 S-P4/fr-P4 242 MB late-page citation — DONE at the build seam (model-free; live row = C3
  replay).** Probe (production path, ATTACH_EMBED=off, index deleted after): build is SYNCHRONOUS
  before ready (no readiness race) — the live 240 s build was a genuine LEXICAL build (embedder
  failed under host pressure; 4 live store indexes carry embed=None); AMS citation = chunk 14205,
  BM25 rank 203/13,965 → structurally outside the 20-candidate/8-seed/24k point_qa lens; old PASS
  run = 6.2-min HYBRID build. Model WEB-SEARCHED mid-turn (supervisor 3871–3959). Retrieval math
  NOT touched (faithful; byte-exact Rust mirror). Product defect = silent degradation: build.ts
  embedNote generated but never persisted → now persisted into meta.json (+ operator-switch
  message verbatim); vectors.ts reason quotes the cause → real reason rides every "lexical only
  (…)" coverage marker (store.ts:155); Rust mirror embed_note (serde-tolerant) + identical
  quoting + mirror test. RED→GREEN 2→23/23. Gates 2026-11-22: cargo **742/0**, full vitest
  **2635/0** (25 skipped; includes 3 tmp probes pending deletion), tsc exit **0**. Evidence +
  residual law (fr-P4 hybrid-only; C3 records per-row stamp):
  evidence-sp4-glossary-citation.txt; ISSUES.md F79; ANSWER-KEY S-P4 p3949→p3948.

- **A6 (part 2) F73 SPM legend key — DONE (KEY defect at first failing layer; live row = C3
  replay).** pdfjs text-layer census of EVERY page of doc-a.pdf: "Figure 4.2" on NO page,
  "0 to 7" regex on NO page; physical p16 = text page (the key's "7" = B.2.4 rate 7 % per °C);
  physical p17 = Figure SPM.5, precipitation legend end ticks –40…40 (% per °C). Product was
  faithful. fr-P1 question retargeted (p17, Figure SPM.5 precipitation legend, EXACT –40 %…40 %
  incl. percent sign), key P1 SUPERSEDED. No product change. Evidence:
  evidence-f73-spm-legend.txt. Spec+key fingerprint changes recorded for C3 freeze.

- **A7 (part 1) F71 docm readiness — DONE (product defect at 3 gates; live row fr-D6 = C3 replay).**
  ISSUES premise "extraction exceeds 180 s" FALSE twice: supervisor line 757 = extract 200 in 6.9 s;
  fr-D6 error-context = turn IN-FLIGHT ("Searching the web…", Context 86048/131072, Stop generating).
  Real chain: docm/dotm/pptm/potm/ppsm/xltm/xlam unmapped in EXT_CATEGORY → "archive" raw-XML member
  dump → 86k-token payload → web-search confabulation → model-budget overrun. Fixed at every gate:
  extensions.ts routes the macro family to "office" (ACCEPT_EXTENSIONS auto-derives → upload boundary
  now offers macro files); office.ts ZipLimits include-filters + switch serve the twins (vbaProject.bin
  in NO filter); parser.py load_document → _parse_ooxml for the family (also gained xlsm/xltm/xlam it
  refused despite TS mapping xlsm→office). TDD red→green: extract-docm.test.ts 5/5, MacroOoxmlLaws 3/3.
  Live fixture: macro-1.docm extracts 4 ms, category "office", 3845-char Russian body (25900 ✓ 1400 ✓)
  under the 4000-char preview cap. ISSUES.md F71 rewritten.

- **A7 (part 2) F72 xlsx follow-up — DONE (KEY defect at first failing layer; live row fr-X1 = C3
  replay).** S-X4 premise false: `A9:A19` occurs 0× in data-5.xlsx raw XML (all members; A1 census —
  only sheet3 A1 stores a formula: `'Input sheet'!B4` → Almarai). The formula is data-6.xlsx ToC A1
  (f=`IF(SUM(A9:A19)=0, 0, 1)` v=0 — key X4 [mid] row correct for THAT file); S-X4 copied it onto the
  wrong workbook (F69/F73 family). Retargeted to Valuation output B10
  `IF('Input sheet'!B61="Yes",'Input sheet'!B62,0)` cached `0` — 1 occurrence in workbook, chunk-22
  render + point_qa delivery verified; strict `0` assertion KEPT (absent-cached-vs-zero law preserved).
  Key S-X4 SUPERSEDED with replacement row; spec follow-up retargeted (fingerprint change → C3 sha).
  Evidence: evidence-f72-first-layer.txt. No product change.

  Gates 2026-11-22 after F71+F72: full vitest **2636/0** (25 skipped), tsc exit **0**,
  py **Ran 585 OK** (gate command: cwd python-backend, `-m unittest discover -s tests -t .
  -p test_*.py` — discovery rooted at tests/ breaks test_handoff_devices relative import),
  cargo **742/0**. All tmp probes deleted (a7b, dbg; a7/f73/sp4 earlier).

- **A8 F70 long-video readiness — DONE (harness budget defect; live V rows = C3 replay).**
  No live probe needed: the fr2 supervisor log IS .ai-coordination/dev-supervisor.out.log
  (verified: line 757 = macro-1.docm 200 in 6927 ms; span 3871-3959 = F71 turn-56 web-search).
  Route walls 900,791/1,200,557 ms == the 900 s/1,200 s client extract budgets + abort →
  the fr2 V-row ✘ are BUDGET expiries ("Transcription cancelled"), not hangs. Whisper RTF 0.30
  calibrated from au-1/2/3 walls (166.1/209.1/170.7 s on 532/752/550 s audio, ffmpeg-probed)
  ⇒ honest video walls ≈ 2,300 s vid-1 / ≈ 4,900 s vid-2; 333.9 s frames-complete vid-1 route
  (att_33gj225b91, 150 staged frames) puts the I17 scene pass at ~320 s. Decode census: exactly
  TWO heavy passes per upload (keyframe scan on the video stream, full audio decode in the
  python worker) run CONCURRENTLY; timeline = 12 bounded seeks; no repeated full decode.
  Budgets raised from measurements: extract 2,700 s (vid-1 rows) / 5,400 s (vid-2 row),
  timeouts 3,120/3,720/6,900 s. C3: tighten from B12 Parakeet numbers (project ~1,200/~2,400 s
  extract). Evidence: evidence-f70-video-profile.txt; ISSUES F70 rewritten. Spec V rows edited
  (fingerprint change → C3 sha). No product change; gates re-run below after Stage-B work.

## Stage B seam map (locked 2026-11-22, after full recon)
Model management is a CONTROL PLANE, not a capability job: contracts.CAPABILITIES and
ml_job.rs's job contract stay untouched. New authenticated /models surface parallel to /job.
- Python engine `ruke_ml/models/hfhub.py` (deep module, injected transport):
  search/inspect/install(job: progress+cancel+resume+sha256 verify+atomic manifest)/installed/remove.
  Mirror law IN the engine: the HF token is attached ONLY to the official endpoint's requests;
  mirror file bytes are verified against OFFICIAL revision/hash metadata fetched first;
  trust_remote_code=False always (never execute repo code). Delete = project-owned snapshot
  dirs only; shared content-addressed blobs preserved (HF cache layout).
- Supervisor `POST /models` (token_ok, action-routed, bounded body, huggingface_hub imported
  lazily — startup stays zero-heavy).
- Rust `ml_models.rs` route `POST /api/ruke/ml/models`: bridge_ok auth; action allowlist;
  request body may NEVER carry token/path keys (browser sends IDs only); Rust reads hf_token
  from SettingsStore (= the backend credential store, settings.json, same place llm_api_key
  lives) and injects it server-side; Rule 17 (never log the token); X-Ruke-Token to supervisor;
  typed envelope passthrough like ml_job.
- Next `app/api/models/route.ts`: rustProxy("/api/ruke/ml/models",
  extraHeaders=internalSecretHeaders()) — the bridge secret is injected server-side,
  never through the browser (no app/api route carries its own session auth; the Rust
  bridge_ok gate is the authority).
  DECISION 2026-11-22 (deviation from "call the supervisor directly in TS-only mode"):
  rustEnabled()=false answers a TYPED not_configured envelope (source ts-models-route)
  instead of dialing the supervisor. Reasons: the supervisor only exists under
  `npm run dev` (plain `next dev` has none to dial); the per-run supervisor token must
  never enter a Node module that serves browser code (ml-job.ts law); one authority for
  the capability backend. The TS gate still enforces the ID-only law with the SAME 400
  shape and ordering as ml_models.rs (forbidden keys first, then action name).
- UI B1: Settings→Models section (components/SettingsMenu.tsx + lib/models client);
  selectors persisted as settings keys (speech_model / ocr_engine); hf_token write-only.
- B3: registry ModelSpec carries published language tags + adapter/binary readiness
  (AdapterReadiness.blockers() = the "reason shown" mechanism, already built).
Test seams (pre-agreed bridge seam): hfhub engine with fake transport; supervisor /models
auth+gate; Rust ml_models pure gate + stub loopback; Next route passthrough.

## Next action (updated 2026-11-22, mid-C3)
Stage B DONE (B1–B11; B12 SUPERSEDED). The B5 engine freeze (2026-11-22 final decision)
RETIRED the HF model-manager UI: Settings→Engines shows the FIXED Parakeet
(automatic provisioning, no selector) + the two OCR choices — the original brief's
"search/download/select/delete" rows are replaced by fixed-engine provisioning,
offline reuse, GPU handoff and recovery (see C1/C4 rows).
C3 frozen 61-row replay IN FLIGHT (.data/tmp/file-regression/f79-c3, DONE sentinel
f79-c3-DONE). C5 ✅. C2 = fr-P10 inside C3. C1 = fr-U7 inside C3 (rescoped).
NEXT on the completion ping (per user mid-run brief 2026-11-22): score the replay
model-free vs ANSWER-KEY.md; keep THIS run's fixture hashes/answers/failures as
evidence; then apply F80–F85 (testing/ISSUES.md) to the NEXT run — F80 product
source-scope rule (attachment vs web, dispatch-enforced, Rust/TS parity), F81
scan-1.pdf fixture/key mismatch, F82 P9 refusal scorer + date-discrimination
fixture, F83 deck-4 identity key, F84 answer-reader scores UI card, F85 fixture
preflight + per-question verdicts. Run scorer/fixture checks FIRST, then exclusive
replay of affected PDF/PPTX/XLSX rows + held-out attachment + paired
file-only/external-verification journey. Then C4 Tesseract-only zero-probe row,
C6 final table + GREEN/HOLD + FILE-READING-REGRESSION.md. Migration/release gates
finish per the run brief. C3 freeze records spec+key shas (fr-X1/fr-P1/fr-P7/fr-U6/fr-X3
rows + V-row budgets + S-X4/S-P5/S-X10 key edits).
