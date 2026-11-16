# FINDINGS — initial classification from brief §4 (2026-11-15)

Classification: REPRO (reproduced by audit) · SRC (source-confirmed) · SUSPECT · ALREADY-FIXED · NT (not tested).
Every fix records route reachability (default Rust chat path vs retained TS path vs secondary routes).

| ID | Class | Owner(s) | Route | Fix posture |
|---|---|---|---|---|
| F01 | FIXED offline (session 12) | lib/chat/response-policy.ts + lib/chat/client.ts + WEB_TOOL_GUIDANCE | prompt assembly | one application-owned response policy (answer what was asked, match requested depth, no unasked capability ads); no canned replies, no greeting whitelist |
| F02 | REPRO | lib/decision/client.ts:165, ruke-decision/engine.rs | decision routing | structured artifact intent fields; abstain on uncertainty |
| F03 | REPRO -> **FIXED offline TS (session 36)** | lib/web-search/domain-constraints.ts (new), lib/web-search/planner-law.ts | web policy (TS only; planner_law.rs mirror was removed 2026-11-03) | typed constraint records (target / polarity / cue-scope / exclusivity / evidence span / authority: user vs quoted-operand vs site-operator / postposed / corrected) + a resolve law (cancel retracts, block beats preference, correction clause retracts an earlier block, allow replaces prefer, prefer never replaces allow). Contrast words END a cue scope, so an exclusion and a later exclusivity no longer drape onto each other; quoted spans are operands only when their whole content IS a host; code/quotes are masked before any cue scan; 18 non-English cue vocabularies with script-aware word guards and postpositional binding (Hindi/Japanese/Chinese/Arabic/Telugu/Vietnamese/German/French/Spanish) |
| F04 | FIXED offline TS+Rust (session 27) | lib/decision/task-scope.ts, ruke-server/src/task_scope.rs, fixtures/task-scope/cases.json | task scope | F04 self-task law: content-verb head + own lexical matter = new task; a pronoun is not action authorization; conversation continuity kept separate from action (220 Rust lib tests + 86 vitest decision tests) |
| F05 | FIXED offline (session 29) | lib/web-search/{normalization,metasearch,reranker,presentation}.ts | retrieval + presentation | shared identity layer (symbol-bearing identifiers survive, C!=C++ both ways); surface corroboration by evidence domains; locale/cache/substring legs recorded NOT reproduced |
| F06 | REPRO -> **FIXED offline TS (session 35)** | segment-filter.ts, range-math.ts (new), tools.ts (retained copy), types.ts | pruned evidence was unrecoverable even by continuation:true, because the session retained the FILTERED view | canonical fetched bytes + stable block ids + byte ranges + FNV content hash are retained; filtered-out spans are disclosed (filteredChars) and recovered by read_page continuation:true (recoveredFilteredChars), provenance composes across repeated filter hops; pinned by __tests__/web-search/segment-canonical-recovery.test.ts (6 cases, real filter hop, zero re-fetch) |
| F07 | REPRO -> **FIXED offline TS+Rust (sessions 31-33)** | lib/server/attachindex/{router,retrieve,store,turn}.ts + ruke-attach {router,retrieve,store,turn}.rs | attachment retrieval (TS attach RPC AND Rust pipeline attach turn) | index-derived time axis (no timeline = no window); comparative asks carry SEPARATE cue windows (retrieve windows[] both sides); clause-local negation + explicit-occurrence exhaustive route; shown ledger v2 = conversation-scoped + query-tagged with an exact-repeat law (repeat gets its own passages back, continuation/exhaustive rotate) behind a cross-process directory mutex in BOTH languages; RAW-FIRST retrieval with the antecedent demoted to a bounded fallback |
| F08 | FIXED offline (session 13) | ruke-server chat/pipeline.rs + TS attach turn | Rust+TS attach turn | skill-insertion-safe target identity; goldens + attachment_replay byte-exact parity |
| F09 (+F09b) | FIXED offline (sessions 21-22) | attachindex/store.ts (immutable generation dir + manifest pointer switch + per-attachment write lock + uniqueTmp beside the target) + ruke-attach mirror | TS+Rust index | transactional publish; fault injection at every commit step; embedding model/dimension/normalization rejection |
| F10 | FIXED offline (session 22) | attachindex build/embed chain (TS) + ruke-attach | TS indexing | cancellation propagates upload->parse->chunk->embed->commit; a cancelled build publishes no generation |
| F11 | FIXED offline (session 16) | contracts.ts, schemas.ts, documents/valueModel.ts, documents/dataQuality.ts, xlsx/powerbi engines | artifacts | typed missing/zero/invalid/numeric values, locale-currency-percent fidelity, explicit imputation, no invented parse success |
| F12 | FIXED offline (sessions 15-16) | extract/pdf.ts, extract/office.ts | extraction | supplementary-Unicode + hex-entity fix, formula AND cached value retention, structure-preserving sheets/slides, honest fallback coverage |
| F13 | SRC | extract/ffmpeg.ts, audio.ts, vision-prepass | video | timeline system (P7) |
| F14 | FIXED offline (session 24) | attachindex/turn.ts + ruke-attach mirror + chat prompt blocks | prompts | machine-readable coverage line (served/total passages, withheld-clause, ranking mode, frames N of M); ADDITIVE only; TS/Rust byte-identical (attach-coverage-metrics + attachment_replay) |
| F15 | FIXED offline (sessions 24-25, TS+Rust) | answer-release.ts scanMarkdown/auditProse + chat/answer_release.rs scan_markdown | answer integrity | ONE markdown segmentation (fence/inline/indented/table = verbatim) shared by release audit and diagnosis; matrix segments section locks both languages byte-exactly |
| F16 | FIXED offline (session 5-8) | web-tool-loop.ts:620-684, web_loop.rs, parser.ts, useChat | streaming | terminal sentinel after all metadata; explicit outcome plumbing |
| F17 | FIXED offline (committed 002b969) | lib/stream/thinkTags.ts | reasoning | protocol-aware, code-aware splitting |
| F18 | REPRO → **FIXED offline (session 9)** | components/ProcessingStatus.tsx + lib/progress/{currentActivity,turnFence}.ts + hooks/useChat.ts | UI activity | single authoritative activity state; superseded-turn frames dropped (live UI check still owed to the blocked Playwright gate) |
| F19 | FIXED offline (session 10) | app/page.tsx:262–375 | scroll | following/free controller |
| F20 | FIXED offline (session 14) | lib/skills/modality.ts + ruke-skills/src/modality.rs | capability gating | declared requiredCapabilities, then protocol evidence, then per-frame evidence; TS/Rust frame splitter byte-equivalent |
| F21 | FIXED offline (session 26) | lib/lifecycle/ownedResource.ts, documents/browser.ts, pdfEngine.ts, attachindex/embed.ts, extract/audio.ts, chat/compact.ts | lifecycle | owned-resource leases + idle TTL + exactly-once teardown; proxy/page/browser destroyed; durable verbatim user constraints across compaction |

## Call-graph audit (P1.1) — in progress
(to be filled as call sites are mapped)

## P1.1 Upstream call-graph audit (2026-11-15)
Production sites — after P1.3 every one sits behind ONE door (mode column: which authority admits it):
| Site | File | Mode/authority |
|---|---|---|
| chat stream (forwardStream / forwardStreamInto) | app/api/chat/route.ts | Rust mode: whole handler proxied (route.ts:573 rustProxy) → Rust admission. TS-only mode: sharedUpstreamStream → LocalUpstreamAdmission |
| web tool loop rounds (streamRound) | lib/chat/web-tool-loop.ts | TS-only mode only (Rust runs its own loop) → sharedUpstreamStream |
| search gate plan | lib/web-search/search-gate.ts | sharedUpstreamCompletion (targetUrl when WEB_SEARCH_LLM_ENDPOINT set) |
| jsonCompletion (decision titles, misc JSON helpers) | lib/web-search/llm-json.ts | sharedUpstreamCompletion; `endpoint` override → targetUrl (bridge cannot reach alt endpoints — honest documented escape hatch, local admission only) |
| vision prepass | lib/web-search/vision-prepass.ts | sharedUpstreamCompletion |
| title generation | lib/server/titles/generate.ts | sharedUpstreamCompletion (Rust mode: titles owned Rust-side) |
| attach notes block distill | lib/server/attachindex/notes.ts | sharedUpstreamCompletion (Rust mode: Rust attach-notes owns) |
| audio LLM warmup (1-token) | lib/server/extract/audio.ts | sharedUpstreamCompletion — even a 1-token warm-up is a generation |
| Rust: forward_legacy / forward_into / web stream_round / browser round / titles / attach notes | rust-backend ruke-server six loci | ruke_core::admission::UpstreamAdmission (the ONE authority; active count never > 1) |
Non-upstream (no permit needed): LLM_UNLOAD_URL / LLM_RELOAD_URL postJson hooks (lifecycle, not generations); model-stats parses origin only.
Test-scope (NOT rewired, never production): scripts/playwright-10k-audit.ts:73 (harness upstream), __tests__/** fetch mocks, rust-golden fixtures.
Zero unmanaged production upstream sites remain (grep-audited: no `fetch(llmApiUrl`, no stray Bearer upstream calls outside the door).

## P1.6 — Strata unload/reload support (verified from the ACTUAL install, 2026-11-15)
- Live instance: PID 19584 = `D:\AI\Strata\.venv\Scripts\python.exe D:\AI\Strata\serve\server.py --engine strata --config strata-iq3_s.json --port 8080`; `/health`: model `qwen3.8-flash-next-iq3_s`, engine 0.1.59, `api_key: false`, `loaded: true`, `concurrency.serving: 1` (server-side FIFO capacity-1 — corroborates the admission premise).
- Routes in the running source: `POST /unload[?wait=0|1|<s>]` (server.py:8342; 409 `busy` while a turn runs — NEVER evicts mid-turn; `?wait=1` waits up to UNLOAD_WAIT_S=300 s), `POST /load` (idempotent, GpuBusy→503 Retry-After), plus `/v1/load`/`/v1/unload` OpenAI-dialect twins (model-checked). Guards: `_own_page` = JSON content-type + no foreign Origin; **no Origin = non-browser client → allowed**. `_authorized`: api_key unset on this instance → no auth needed.
- Live safe probe: `POST /load` → 200 `{"status":"loaded"}` and `POST /v1/load` → 200 full metadata, model stayed loaded, zero state change. Live `POST /unload` probe deliberately NOT sent (brief: never unload Strata during Claude inference); its semantics are pinned by the install's own suite (serve/test_web_load_unload.py: "never interrupts a turn") + source reading.
- WebUI hooks (`lib/server/extract/audio.ts` postJson: POST {} + content-type: application/json, no Origin) match the guard exactly. Enabled in `.env.local` (gitignored; LLM_API_URL/KEY set to the SAME values as code fallbacks — zero behavior change): LLM_UNLOAD_URL=http://127.0.0.1:8080/unload, LLM_RELOAD_URL=http://127.0.0.1:8080/load. Restoration is already finally-guarded and adversarially tested (audio-stage-guard tests).
- Verdict: **P1.6 passed** — swap support proven; hooks live-capable; /unload live-fire left unexercised BY DESIGN, not by inability.

## Verification ledger as of session 52 (the row above is the ORIGINAL classification, kept as history)
Legend: **impl** = implemented; **off** = offline verified by a deterministic gate; **live** = verified
against the real endpoint/UI; **not_run** = deliberately not measured; **blocked** = needs a human.
No row below claims more than the named gate proves.

| ID | Impl | Offline | Live | Gate that proves the offline claim |
|---|---|---|---|---|
| R01-R06 | yes | yes | no (P11) | TS admission suites + `cargo test -p ruke-server` incl. `admission_exclusion.rs` and the new `admission_slow_body.rs` (active count held through a gated slow body) |
| F01 | yes | yes | no (P11) | response-policy tests + golden/behaviour corpora; no canned reply, no greeting whitelist |
| F02 | yes | yes | no (P11) | `__tests__/decision/artifact-intent-f02.test.ts` 49 cases (frozen first, red first) + 9 multi-deliverable + `__tests__/decision` 144/144 exit 0 this session |
| F03 | yes | yes | no (P11) | `domain-constraints-f03.test.ts` 45 cases; `__tests__/web-search` 909 passed / 2 skipped |
| F04 | yes | yes | no (P11) | TS 86 decision tests + Rust `task_scope` lib tests, `fixtures/task-scope/cases.json` |
| F05 | yes (reproduced legs only) | yes | no (P11) | identity/surface tests; locale, cache-key and substring legs recorded NOT reproduced |
| F06 | yes | yes | no (P11) | `segment-canonical-recovery.test.ts` 6 cases, real filter hop, recovery with zero re-fetch |
| F07 | yes | yes | no (P11) | `attach-intent-f07.test.ts` + Rust mirror; TS attach gate 89, `ruke-attach` lib 86, `store_compat` 6, `attachment_replay` 6 |
| F08 | yes | yes | no (P11) | skill-insertion-safe target index + attachment goldens byte-exact |
| F09 (+b) | yes | yes | no (P11) | fault injection at every commit step; dim/normalization/model mismatch rejection |
| F10 | yes | yes | no (P11) | cancellation upload->parse->chunk->embed->commit; no partial generation published |
| F11 | yes | yes | no (P11) | value-model + contract suites; missing/zero/invalid/numeric distinguished, percent/currency preserved |
| F12 | yes | yes | no (P11) | supplementary-Unicode/hex-entity, formula AND cached value retention, structure-preserving sheets/slides |
| F13 | yes | code+tests yes; **quality not_run** | no | python `tests/test_video.py` (timeline timestamps, separate ranges, coverage honesty) + `test_binaries.py`; a working ffmpeg proves nothing about localisation quality |
| F14 | yes | yes | no (P11) | coverage line additive, TS/Rust byte-identical |
| F15 | yes | yes | no (P11) | one markdown segmentation shared by audit and diagnosis in both languages |
| F16 | yes | yes | no (P11) | terminal-ownership suites 13+3 + stream suite; golden corpus re-recorded through the sanctioned seam |
| F17 | yes | yes | no (P11) | fence matrix TS<->Rust parity, committed as `002b969`; the full ruke-server gate is green (`logs/rust-full-s48b.log`) |
| F18 | yes | yes | **owed to P11** | activity-state suites 148/148; the actual on-screen label sequence is a browser check |
| F19 | yes | yes | **owed to P11** | controller suites 153/153; jitter/anchor behaviour needs the browser |
| F20 | yes | yes | no (P11) | declared requiredCapabilities + protocol evidence; TS/Rust frame splitter byte-equivalent |
| F21 | yes | yes | no (P11) | owned-resource leases, idle TTL, exactly-once teardown, compaction durability (170 tests) |

Two further defects found by the run's own gates, not in the original list:

| ID | Class | Owner | Fix |
|---|---|---|---|
| F22 | REPRO (build gate) | `lib/persistence/dataRoot.ts` read sites + `@vercel/nft` tracer behaviour | a raw `os.homedir()`/`process.env` value became an unresolved FS root in nft, which emitted a glob of the whole user profile and killed `npm run build` on `C:\Users\Ruku\Application Data` (EPERM/GLOBF). Fixed at the read site with `String(...)` coercion (runtime-identical), the vendored tracer restored to pristine, and a tracer guard test added. Build exit 0 (`logs/next-build-s50.log`). Also the F06 class of the same root cause: native Windows has USERPROFILE but no HOME (`lib/persistence/disk.ts`, `research-journal.ts`). |
| F23 | REPRO (capability report) | `ruke_ml/models/registry.py` `requires_binary` probe | PATH-only detection reported `video.timeline` = `not_installed` although ffmpeg exists project-locally. Replaced with a validated, provenance-carrying resolver (`ruke_ml/models/binaries.py`): override -> PATH -> project-local (incl. `PLAYWRIGHT_BROWSERS_PATH`), each candidate proven by `<program> -version`, non-executable candidates refused, repository-relative path published and outside paths reduced to a file name. 14 tests; live payload check this session. |

Honest not-tested list (never flipped to passed): every Qwen3 / whisper-large-v3 / Docling /
PaddleOCR quality measurement (`evaluation_required`), pyannote (`license_acceptance_required`),
the Python artifact writers (`not-migrated`: no measured deficit justifies replacing the verified
TypeScript engines), and every browser-level F18/F19 behaviour check until P11 runs.


## Session 53 - F13 read side (2026-11-16, append-only)
| Finding | New status | Evidence |
|---|---|---|
| F13 (video: temporal evidence) | SRC-CONFIRMED gap CLOSED offline + measured synthetically | scenes.py gained parse_cut_timestamps / apply_stream_offset / CutScan / scan_scene_cuts; ffmpeg command corrected against pinned 6.1.1 (loglevel, stderr, -fps_mode passthrough); video.scenes job now consumes real cuts (detect_cuts) and reports truncated/error in Coverage.note; eval/temporal_probe.py measured declared schedule 3/3, mean_abs_error 0.000 s, 0 spurious; hard-negative threshold run fails honestly. tests/test_video_scan.py = 20 tests; python suite 150 -> 170, exit 0. |
| F05/P6 (retrieval quality claim) | measured, NOT migrated | eval/methods.py + scripts/eval-embed-vectors.ts: dense_only vs hybrid over the frozen 38 cases (D-024). Hybrid is not worse and is the only method that can abstain. |
| Still NOT tested | temporal_video_localisation on a human-labelled real video, ASR/OCR quality on real media, Qwen3-ASR/Embedding/Reranker, Docling, PaddleOCR, pyannote | remain not_run / license_acceptance_required / not_installed with the exact human step in FINAL-REPORT.md |

## Session 55 - F22 (2026-11-16, append-only)
| Finding | Status | Evidence |
|---|---|---|
| **F22 (new) e2e runs write into the real user conversation store** | **REPRODUCED, FIXED, verified live** | Stage B (live model) ran the real product with no WEBUI_DATA_DIR, so both resolvers used %USERPROFILE%\.local-intelligence\conversations: 14 store files touched in one run. No user chat lost (verified by title: every sidebar chat seen during the run is still on disk; 775 files before and after), but brief section 10's isolation gate was unmet. Fixed in scripts/run-browser-e2e-exclusive.ps1 (-DataDir, default .data\e2e-store, real-store refusal, honoured by Rust + Next by inheritance, no side effects before the lock is held, warning when a foreign :3000 is reused). Re-run: 31/31 passed, isolated store got all 18 files, 0 writes to the real store. |
| F16/F17/F18 live confirmation | **live** (was offline-only) | 31/31 live browser tests twice: reasoning cleared -> response complete; SSE 48 events with reasoning_content deltas then [DONE]; progress chip/panel steps + monotonic honest percent + a real PPTX output row; stop mid-stream finalizes the partial reply; editing a user message mid-stream regenerates without redirect; artifact frame in an opaque origin. |
| F19 scroll jitter | still **not measured** | no spec measures scroll following under delayed layout growth; the controller is offline-tested only (__tests__/ui/scroll-follow.test.ts). Honest status: not_run, no jitter rate claimed. |
| F01 verbosity A/B on the live model | still **not_run** | needs an exclusive same-model prompt A/B; not performed because it competes with the shared capacity-1 endpoint and the fixture/live suites had priority. |
## Session 61 - G1 ledger update (append-only, no new finding number)
| Ledger item | Status after this session | Evidence |
|---|---|---|
| G1 "no production caller for Python capability jobs" | **closed at the baseline + scene level**; heavy modalities still gated | ruke-server/src/ml_job.rs (23 tests) + lib/server/ml-job.ts + the video branch in lib/server/extract/index.ts publish a durable timeline record and scene observations for every uploaded video; those observations flow through attachindex/media-hints.ts into web-tool sessions and real web_search arguments (web-search/media-hints-search test + this session's 117-test targeted gate). ASR/OCR/vision enrichment on video stays not_configured because the model assets are not on disk - reported, not faked. |
| F13 coverage honesty | **fixed + tested** | A truncated cut scan now reports only the examined horizon and puts the remainder in coverage.skipped; sceneObservations clips to the scanned horizon; two tests assert examined=[[0,60]] / skipped=[] only for a full scan and [[40,60]] for a truncated one. |
| Media hints pollution | **fixed + tested** | scene observations carry no text, so both the Python hint builder and the TS OBSERVATION_KIND_MAP drop them; a test asserts no coordinate, kind-name or threshold string reaches mediaHintQueries. |
| Timeline publish durability | **fixed + tested** | per-attachment index write lock, staged copy + rename on EXDEV, symlink rejection, 4096-entry / depth-6 bounds, scratch discarded on every failure path. |
| Still not tested (unchanged) | Qwen3-ASR/Embedding/Reranker, Docling, PaddleOCR, pyannote, real-media ASR/OCR/document/video quality, frozen temporal_video_localisation, F01 live A/B, F19 jitter | not_run / license_acceptance_required / not_installed, with the exact human step in FINAL-REPORT.md section 13. |
