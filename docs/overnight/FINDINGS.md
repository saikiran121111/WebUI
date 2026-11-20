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

## Session F12 - held-out HTTP score exposes five delivery defects (F12-1 .. F12-5)
Source: `docs/overnight/probes/f09_heldout_http_probe.mjs` over the 8 held-out fixtures, evidence
`docs/overnight/logs/f09-heldout-2026-11-16T132850712Z.json`. The reader-level score
(`python-backend/tests/test_heldout_readers.py`) passes every one of these facts, so each miss is a
**delivery-layer** defect: the fact is true inside the worker and is lost, contradicted or reversed on
the way to the browser.

| # | Defect (file) | Measured evidence | Why it matters | Fix, without weakening |
|---|---|---|---|---|
| F12-1 | The promotion law **rewards fabrication**: TS placeholder lines are protected as "content the capability reader loses" (`lib/server/extract/document-capability.ts`) | ho-corrupt.xlsx note: `ooxml-cellwise refused as the body: it loses 2 content item(s) the TS reader read (shared, missing)`; delivered body `A1=(shared string #99 missing) A2=only string A3=#REF!` | An honest reader that reports corruption by reference and reason loses to a reader that turns an out-of-range shared-string index into invented text and passes `#REF!` through as if readable. must_not `A3=#REF!` failed. | Placeholder/error-value lines must not count as protected content; capability-reported corruption is additional honest content, so the honest reader wins. Assert the delivered body names each unread cell and never presents `#REF!` as content. |
| F12-2 | **Silently wrong coverage wording** for an empty document, and a hard 422 instead of an honest empty report (`lib/server/extract/pdf.ts` + `document-capability.ts`) | ho-empty.pdf -> HTTP 422: `has no text layer — all 2 page(s) are scanned images` and `the capability backend reported a successful document parse that carries no readable units, which is refused` | The fixture has **no image XObject at all**: "all 2 page(s) are scanned images" is an invented measurement, and a 422 contract-mismatch error tells the user nothing about the document. All three authored honest-refusal groups failed. | Wording must come from the reader's measured evidence (units_empty vs units_needing_ocr), and an empty-but-honest capability result must be delivered as an empty extraction with its coverage note, not as an internal contract error. |
| F12-3 | For XLSX the **Python reader never wins**, so its fidelity never reaches the user (`document-capability.ts` "adds nothing" comparison) | ho-inventory.xlsx note: `ooxml-cellwise carries the same 54 content item(s) as the TS reader and adds nothing (317 vs 292 non-whitespace characters), so the merge kept the TS reader` | The Python reader adds explicit empty-cell declarations, per-cell corruption reports, merged geometry in both directions and sheet-part failure reasons; a comparison on item counts and character counts cannot see that, so the delivered body is the TS one and 3 authored must-strings fail. | Make the comparison structure-aware: honest failure/empty/merge/formula evidence counts as additional content, not as noise. Then re-score; do not lower the fixture expectation. |
| F12-4 | A corrupt sheet part yields **unflagged data** from the TS fallback | ho-badxml.xlsx delivered `### worksheet: Torn A1=1 A2=2` with an **empty** coverageNote | The sheet part is not well-formed XML; the honest answer is "sheet 1 failed to parse". Instead the user gets two cells of unknown provenance and no coverage statement at all. | When the capability reports units_failed with a reason, that reason must survive in the delivered note even if another reader supplies partial text; and the TS fallback must not present partial reads of a malformed part as clean content. |
| F12-5 | Renderer punctuation: a formula cell prints `E5==SUM(...)` | ho-inventory.xlsx delivered `E5==SUM(B5:C5) (cached 1234.5)` | A doubled `=` makes the formula text ambiguous in copy/export and in citations. | Emit the cell reference once, then the formula text; assert `E5=SUM(B5:C5) (cached 1234.5)` and the absence of `==` on a formula line. |

Additionally recorded, **not** a product defect: two authored strings in the answer key guessed the
delivery punctuation (`[merged A1:C1]` vs the delivered `### merged cells (2): A1:C1, B3:B4`, and the
PDF `units: 6 of 7 read` phrasing). The underlying conditions were correctly delivered. Amending the
key to assert the **condition** with an AND-group is a holdout change and is therefore reported
separately in D-039, never counted as untouched.

## F24-F26 findings

### A safety failure of my own code: a stale-lease breaker killed an unrelated process
The handoff lease breaker in `python-backend/ruke_ml/handoff.py` used to terminate whatever process the
stale pid named, testing only pid liveness. Pids get reused: the number can belong to an unrelated live
process. During the J4 probe, **pid 6088 - a VS Code helper - was terminated by that code.** Impact that
was actually measured afterwards: the VS Code family is still alive (15080, 16644), the editor works,
Strata (`strata.exe` 5272 and its pythons 3176/3180), node 12008 and this session were unaffected, and
`127.0.0.1:8080/health` still returned 200. **If the editor misbehaves, restart VS Code; nothing else
was touched.** The kill path has since been removed outright (no `ctypes`, no `OpenProcess`, no
`TerminateProcess`, no `os.kill`, no `_terminate_holder`) and its absence is now enforced by a test.
Breaking a provably stale lease unlinks the record only. See D-054.

### A fixture that claimed to be a scan was rendering blank
A PDF page that references an XObject but never draws it (`/XObject` in resources, no `Do` in the
content stream) renders as an **empty page**. The d1 "scanned" fixtures initially had that shape, which
would have made every scan-related pass meaningless - the OCR would have honestly reported nothing.
`docs/overnight/fixtures/d1/ocr_docs.py` now emits `q W 0 0 H 0 0 cm /Im0 Do Q`. The probe's
self-validation controls (an independent raster read of the fixture before any engine runs) are what
caught it. Any future fixture generator needs the same self-check.

### OCR language truth, not aspiration
`--list-langs` of the project-local Tesseract reports **eng, osd only**. The code therefore refuses a
requested language whose data is not installed instead of running `eng` and labelling the result with
the requested language (`documents/ocr_tesseract.py:122-143`). Consequence for acceptance: only English
D1 passes can be claimed today; any multilingual OCR claim would be false.

### GPU OCR is not possible on this host right now, and the pinned build could not do it anyway
Measured 2026-11-17: RTX 3060 `total 12288 MiB / used 9483 MiB / free 2633 MiB` (the main LLM holds the
rest), and the pinned `paddlepaddle 3.2.1` CPU wheel reports `compiled_with_cuda False`
(`logs/f19-paddle-device-1.log`). So the coordinator's policy is `allow_gpu = False` with a documented
unblock path: prepare a CUDA-enabled pinned build in the isolated OCR runtime and set
`RUKE_OCR_ALLOW_GPU=1`. GPU placement is never obtained by borrowing the main LLM's device.

### Memory headroom is thin, and the 5 GB hard ceiling is not OS-enforced for children
Measured 2026-11-17: 65299 MiB total, **7308 MiB free**, commit charge about 75774 of 100115 MiB. The
provisional primary-OCR peak estimate is 3300 MiB RAM plus ~6000 MiB VRAM, both printed as "NOT yet
measured". Admission control is cooperative (free-RAM check before admitting a heavy job) rather than a
hard OS job-object limit; that is an **acceptance gap for the hard ceiling**, recorded as such rather
than claimed as met.

### Reproducibility gap closed for the fallback engine
The project-local Tesseract had been installed by hand with no rebuild path. It now has
`scripts/prepare-tesseract-runtime.ps1` (pins, staging, disk check, bounded retries, size + magic +
digest gates, silent `/S /D=` install into the project, kept `tessdata_fast`, manifest rewrite) and a
`-VerifyOnly` mode that runs the installed binary in place. Today's verification: exit 0, version
`v5.5.3.20260724`, languages `eng, osd`, and a real image-to-text run reading 20/20 answer-key words
(`logs/f26-tess-verify-5.log`); the pinned asset URLs were re-fetched and still match size and digest
(`logs/f26-tess-pin-recheck-1.log`).

### Load-sensitive tests are still load-sensitive
`__tests__/hardening-audio.test.ts` > "GPU present but busy and no unload hook -> stays on CPU" failed
in a full vitest run, passed 9/9 in isolation, and passed in the clean second full run. Same class as
D-051 (`attach-turn-budget`). This is environment sensitivity, not a product fix; it needs isolation on
a quiet machine before anyone calls it stable.

### Legacy DOC/PPT: honest unsupported today, and the one converter this host could actually run
`documents/parser.py:102` returns `kind = "unsupported"` and `workers/document_jobs.py:83-89` turns that
into a typed `unsupported_input` failure - never "ready with zero blocks", which downstream used to read
as "this document is empty". That satisfies the brief's "otherwise report unsupported honestly" branch.
What this host *could* support: there is **no** LibreOffice anywhere (`soffice` missing, no
`C:\Program Files\LibreOffice`), but Microsoft Office 16 **is** installed
(`C:\Program Files\Microsoft Office\root\Office16\{WINWORD,EXCEL,POWERPNT}.EXE`). A COM-automation
converter (hidden app, `AutomationSecurity = force-disable`, `DisplayAlerts = none`, hard timeout,
killing only the pid it started) is technically feasible and would be CPU-only. It was **not** built
tonight because it could not be tested without launching the user's own Office, a corrupt legacy file can
make Office present a modal dialog, and an untested converter is worse than a truthful refusal. Smallest
external action if the user wants DOC/PPT: authorise Office COM conversion (or install LibreOffice) and
then it becomes a bounded implementation plus fixture tests.

## F27 findings - one capability moved from "absent" to "executed", plus two measurement problems

- **A cross-encoder was obtainable after all, at MiniLM size.** The earlier "cross-encoder weights
  absent" blocker was a *preparation* gap, not an external one. `Xenova/ms-marco-MiniLM-L-6-v2` @ commit
  `a09144355adeed5f58c8ed011d209bf8ee5a1fec` came down unauthenticated into the project cache, is
  90,992,115 B (`sha256 c623d0bc...881870`), and runs in **0.29 s cold** at a 267.7 MiB whole-process
  peak. Ledger lesson: "blocked" was the wrong label; the honest label was "not yet prepared".
- **It ties the bi-encoder; it does not beat it, and the interesting failure survives it.** On the
  frozen n=10 set the cross-encoder and the dense bi-encoder both score top-1 9/10 (MRR 0.950); lexical
  BM25 is 7/10. The numeric-fact case - "how many crates arrived on Tuesday", with a "61 crates"
  distractor and a "99 crates" truth - ranks **wrong for all three engines** (rank 2 each). The g04 case
  that BM25 once got right had the number *in the query* ("Tuesday 99"), which is a different problem
  from answering a question whose answer is a number the query never contains. Joint attention did not
  fix that at this model size, so the hybrid RRF design that keeps the lexical channel is still
  justified by measurement rather than taste. **This stays an open regression and is not counted as
  fixed anywhere.**
- **Two engines at 91 MB each is not free.** Both ONNX sessions in one process measured 267.7 MiB peak
  working set. Under the 4 GB target with only ~7.3 GiB free RAM right now, a worker holding embedder
  *and* cross-encoder *and* anything else is a real budget question, which is why the registry carries
  `est_peak_mib 268` with a basis string that admits it is a two-session whole-process figure rather
  than pretending it is an isolated engine cost.
- **A measurement bug class, now found twice:** Windows memory probes written as
  `ctypes.windll.kernel32.K32GetProcessMemoryInfo(...)` with **no `argtypes`** raise
  `OverflowError: int too long to convert` (the pseudo-handle does not fit a C int), and because the
  probes catch broad exceptions they printed `peak_memory_unavailable` and reported `0.0`. Some earlier
  "memory not measured" entries were partly this bug, not a missing measurement. Fixed in `g05`;
  `g04`'s variant additionally passes a `cb=0` struct with size 0 in a first call, which is pointless
  but harmless. Any future probe must set `argtypes`/`restype`.
- **Provenance was living only in source code.** The MiniLM embedder asset had no origin record on disk
  - the pinned commit and digest existed only in `nn_embed.py`, so anyone inspecting
  `.data/models/Xenova/all-MiniLM-L6-v2/` could not tell where the bytes came from. `asset-manifest.json`
  written by `prepare_local()` fixes that for newly prepared assets and is the mechanism to reuse.
- **Still unresolved, not glossed:** a node process seen at pid **5528** running
  `@playwright/test/cli.js test-server --host 127.0.0.1` appeared during a full vitest run and was never
  attributed (`git grep test-server` finds no project caller), and it is not one of the known
  never-touch pids. Nothing was killed by image name, so it was left alone; whoever resumes should
  confirm whether vitest/Playwright spawns it and whether the runner should reap it. An ownership gap in
  the **test harness**, not a product bug.
- **Retrieval ownership is the real blocker for G2/G3, and it is a decision, not a missing engine.**
  Nothing in production calls the Python `rerank`/`embeddings` capabilities: the Rust ml-job allowlist
  excludes them and `lib/server/attachindex/{retrieve,embed}.ts` owns retrieval. Writing more Python
  engines will not change that. The next step on that line is the D-046 owner decision, taken with the
  numeric-fact regression visible in front of it.
