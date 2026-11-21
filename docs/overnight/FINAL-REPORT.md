# FINAL REPORT - Ruke overnight implementation run (P0 -> P11)

Verdict: **PARTIAL** (not COMPLETE). Every feasible engineering task in the brief was
implemented and verified offline; a declared set of gates stays blocked/not_run because
they need human-downloaded model assets, a license acceptance, GPU support this machine
does not expose, or a human-labelled real recording. Nothing blocked was scored as passed.

---

## 1. Identity, and exactly how dirty state was handled

| item | value |
|---|---|
| starting branch / HEAD | `local` / `002b9692b10a3d927933a8514a2245bcf8969001` |
| ending branch / HEAD | `local` / `5a0370a67c8f8c1d327198adff7409cfa15dc82b` (session 62). One commit was created on the local branch **only because the user explicitly authorized it** (DECISIONS **D-031**); every earlier session ran with nothing committed, and **no push / remote operation was ever performed** |
| original audit baseline | `ec256bd726f5dda15e3af9fc3fa3d3d7fa47e3a6` |
| prior implementation commit | `face1f76dca7d34f153f7880e0240c5e8325073c` |
| work-tree status at the FINAL audit (after P10 cleanup, session 61) | **192** porcelain entries = 133 modified tracked + 1 ` D` (the renamed fixture pair) + 58 untracked entries, **441 files when expanded with `-uall`** |
| tracked diff size | `git diff --shortstat` -> **134 files changed, 11764 insertions(+), 2889 deletions(-)** |
| staged at the session-61 FINAL audit | **0** (`git diff --cached --stat` empty) |
| session-62 commit | `5a0370a67c8f8c1d327198adff7409cfa15dc82b` -> **385 files changed, +54720 / -2888**; the only remaining porcelain entries are ` M tsconfig.tsbuildinfo`, `?? mcp-out/`, `?? python-backend/ruke_ml.egg-info/` (build artifacts / run debris, deliberately uncommitted) |

Dirty-file handling:
- Everything dirty is this run's own work. No unrelated user work existed or was touched.
  No `reset`, `stash`, `checkout --`, `clean` or `push` was ever run. The single `git commit` on
  `local` (session 62) was separately authorized by the user and is recorded as D-031.
- Debris removal: this run's own harness/scratch trees outside the repo
  (`scratch-s37/40/43/46/48/53/55/57/59`, `test-data-s48`, `tmp-devcheck-data`) were deleted at
  P10 after copying every cited exit-code file into `docs/overnight/logs/`; `scratch-s49`
  (pristine `nft-index.js.orig`, the frozen holdout corpus/vectors, capacity/dev-measure reports),
  `D:\Projects\WebUI\target-ci` and `.data\e2e-store` were KEPT on purpose. Nothing tracked was
  deleted to make the tree clean, and no user file was removed.
- One entry shows as ` D`: `rust-backend/fixtures/attachments/04-video-time-range-keyframes-dropped.json`.
  It was **renamed**, not silently deleted, to
  `04-video-time-range-standard-chat.json` (untracked). The old name asserted the F07/F08
  DEFECT as expected output; after the fix it is a positive control, so the file name was
  corrected rather than the expectation quietly edited. Rust replay tests reference the new
  name and the suite passes.
- `git diff` warnings are only "LF will be replaced by CRLF" - no line-ending mass rewrite
  the session-62 commit records content changes only; no line-ending configuration was altered.
- Never-modified guard re-verified every session:
  `node_modules/next/dist/compiled/@vercel/nft/index.js` pristine, sha256 prefix
  **`21FDA49AD240564F`** (it had been patched in an early session to work around a build
  EPERM; that patch was reverted and the hash re-checked afterwards).

## 2. Architecture and reachable routes (what actually runs)

- `npm run dev` = `scripts/dev-supervisor.mjs`: port pre-check -> `cargo build` ->
  **Python ML supervisor** -> wait `GET /health` -> **ruke-server** -> wait
  `GET /api/ruke/health` -> `next dev` -> readiness -> supervision/teardown.
- Rust owns chat transport, state, authorization, scheduling, task scope, attachment
  indexing and **upstream admission** (`ruke-core/src/admission.rs` capacity-1 semaphore,
  `slot.rs` logical turn lease). `app/api/**` thin-proxy branches are armed only by
  `RUKE_RUST_BACKEND=1`.
- TypeScript retains the working web-search adapters, artifact engines
  (exceljs / docx / pptxgenjs / Chromium PDF), the decision engine and
  `lib/server/upstream-bridge.ts` (TS-side admission that defers to the Rust authority for
  the same inference resource).
- Python (`python-backend/ruke_ml`) is a stdlib-only supervisor plus lazy heavy workers.
- Reachability classification per brief: default Rust chat = live; retained TS chat = live
  for non-stream/secondary calls; direct model-facing web tools = live (Rust web_loop +
  TS adapters); uploads/attachments = live; artifact generation/export = live;
  background jobs = live; **Python capability jobs = implemented, health/capabilities are
  surfaced, and since session 58-61 the **video baseline path really executes them** (see §9 G1,
  closed at the baseline/scene level; heavy modalities stay gated on model assets).

## 3. Reproduction and gates - exact commands, exit codes

Every row below was executed; nothing here is a claim about an unexecuted command.

| gate | command | result | exit |
|---|---|---|---|
| typecheck | `npm run typecheck` | clean | **0** (session-55, `logs/typecheck-s55.log`) |
| contracts | `npm run contracts:check` | generated == committed | **0** (session-55, `logs/contracts-s55.log`) |
| Next prod build | `npm run build` | "Compiled successfully", type check, 25 static pages, route table, "Finalizing page optimization" | **0** (session-55 `logs/next-build-s55.log`; session-53 `next-build-s53.log` also completed) |
| full Vitest | `npx vitest run` | **183 test files passed, 2 skipped; 2293 tests passed, 19 skipped**, 300.8 s, **zero** FAIL/Failed-Tests markers | 0 (`logs/vitest-full-s53.log`; session 50/51 run: 2293/19, exit 0, 223 s) |
| decision corpus (F02) | `npx vitest run __tests__/decision` | 3 files / **144 passed** | 0 |
| Rust workspace | `cargo test --target-dir D:\Projects\WebUI\target-ci` | **424 passed / 0 failed** | 0 (`logs/rust-full-s48b.log`; no Rust source change after it) |
| Python | `cd python-backend; .\.venv\Scripts\python.exe -m unittest discover -s tests -t .` | **Ran 170 tests, OK** (150 -> +20 `test_video_scan.py`) | 0 (`scratch-s49\py-full-s53b.log`) |
| temporal probe | `.venv\Scripts\python.exe -m ruke_ml.eval.temporal_probe` | declared cut schedule 3/3 detected, hit_rate **1.000**, mean_abs_error **0.000 s**, 0 spurious | 0 (`logs/temporal-probe-2026-11-16.json`) |
| temporal hard negative | same probe, threshold 0.99 | detects nothing -> **fails** with hit_rate 0.000 over n=3 | 1 (expected) |
| retrieval method comparison | esbuild bundle + `ruke_ml.eval.harness --dump-corpus` + `eval-vec-s53.cjs <corpus> <vectors>` + `harness --vectors ... --out ...` | 4/4 exit 0, 29 chunks + 38 query vectors, dim 384 | 0 (`logs/python-eval-methods-s53.{json,log}`) |
| frozen holdout | `python -m ruke_ml.eval.harness` | **7/7 families, 38 cases**, recall@5/mrr/ndcg@5 = 1.000, **7 gated capabilities `gated_not_run` and excluded from the denominator** | 0 |
| integrated startup | `npm run dev` under the measurement harness | python health **1.3 s**, rust **1.3 s**, Next **3.3 s**, `GET /` 200 in **7.1 s**; teardown: 0 listeners on 3000/3101, 0 ruke-server procs, 0 ruke_ml procs, foreign Strata python still 2 | 0 (`logs/dev-integrated-s50-report.txt`) |
| Playwright stage A (fixture RPC, provably zero Strata) | `scripts\run-browser-e2e-exclusive.ps1 -TestFiles ...` under the atomic lock | **11 passed / 0 failed** in 17.2 s; run twice | **0** (`logs/p11-stage-a.log`) |
| Playwright stage B attempt 1 | same launcher, backslash spec paths | "No tests found" - positional args are REGEXES so nothing matched; cleanup still stopped the owned tree and released the lock | **1** (expected failure; decision D-027, `logs/p11-stage-b.log`) |
| Playwright stage B (7 live-model UI specs) | same launcher, forward-slash paths | **31 passed / 0 failed**, 2.1 min, real SSE traffic (`decision_done`, 48 events, `reasoning_content` deltas, `[DONE]`) | **0** (`logs/p11-stage-b2.log`) |
| Playwright stage B re-run under store isolation | same launcher, `.data\e2e-store` | **31 passed / 0 failed**, 4.2 min, **0** files touched in the real user store | **0** (`logs/p11-stage-b-isolated.log`) |
| Rust workspace (current) | `cargo test --target-dir D:\Projects\WebUI\target-ci` | **707 passed / 0 failed** (includes the 23 new `ml_job` tests and the slow-body admission test) | **0** (session-58, `logs/rust-full-s58.log`, exit code in `logs/scratch-s57-rust-full-exit.txt`) |
| media/admission targeted set | `npx vitest run` over 10 named media + admission files | **11 files / 117 tests passed** | **0** (session-61, `logs/s61-targeted.log`) |
| typecheck / contracts / Python (current) | `npx tsc --noEmit --incremental false`; `npm run contracts:check`; unittest discover | clean; generated == committed; **170 tests OK** | **0/0/0** (`logs/s61-typecheck-full.log`, `s61-contracts.log`, `s61-python.log`) |
| full Vitest (current) | `npx vitest run` | **184 files passed / 2 skipped; 2319 tests passed / 19 skipped**, 229 s, zero FAIL markers | **0** (`logs/s61-vitest-full.log`) |
| Next prod build (current) | `npm run build` | Compiled successfully, 25/25 static pages, finalizing | **0** (`logs/s61-build.log`) |
| Playwright stage A / B (current, after the media change) | same exclusive launcher; Stage A fixtures, Stage B the 7 live-model specs | **11 passed** and **31 passed**, 0 failed, Codex idle through Stage B | **0/0** (`logs/p11-stage-a-s61.log`, `logs/p11-stage-b-s61.log`) |

## 4. Admission work (brief section 3) - all six findings

| id | defect | fix (mechanism, not a patch per example) | verification |
|---|---|---|---|
| R01 | `mergeSignal(undefined, timeoutMs)` after acquisition: caller cancel never reached fetch, deadline started after the queue wait | one lifecycle-managed combined controller created **before** admission, used for queue wait, fetch and body consumption; pre-aborted work rejected; timer + external-signal listeners disposed on every outcome; abort / timeout / saturated / upstream-failure kept distinguishable | `__tests__/server/upstream-admission.test.ts`: pre-abort, queued abort, active abort, deadline spent in queue, abort-vs-grant race, timeout during body read, non-2xx body, exactly-once release, listener/timer leak check. Offline **passed** |
| R02 | permit released before `reader.cancel()` settled -> next request admitted while the previous cancellation was still in flight | permit retained until completion or verified failure of cancel/drain; bounded behavior for a transport that never acknowledges; cleanup always runs | test with an explicitly deferred underlying cancel promise; second request must not be admitted. Offline **passed** |
| R03 | `rustEnabled() && !o.targetUrl` let any explicit `targetUrl` (even the shared endpoint) bypass the Rust authority | endpoint **resource identity** resolution (scheme/host/port/normalized path + configured alias registry). Same resource -> same authority, including overrides and aliases; a genuinely different authorized provider gets its own permit **and never receives the configured model bearer token** | TS tests: Rust chat concurrent with a same-resource override; distinct authorized resources; alias/redirect; config change; credential isolation. Callers fixed in `search-gate.ts`, `llm-json.ts`. Offline **passed** |
| R04 | a timeout task spawned per request and never cancelled; fresh CancellationToken driven only by that timer; disconnect not connected in `internal_completion.rs` | scoped deadline + cancellation ownership, validated bounded deadline values, response-body bounds, no orphan timers, no retained permit after success/failure/disconnect/shutdown | Rust unit tests + `crates/ruke-server/tests/admission_slow_body.rs`. Rust 424 passed, exit 0 |
| R05 | `tests/admission_exclusion.rs` decremented ACTIVE before returning the Response, and three unit tests returned early on HTTP 401 while asserting 400/503 | new `admission_slow_body.rs`: headers delivered, gated slow body, active accounting until body completion/cancel, second request attempting admission inside that window; auth isolated with injected config, and an assertion that the intended branch actually ran | Rust suite exit 0 with the intended branches asserted (a 401 can no longer count as a pass) |
| R06 | `lib/persistence/disk.ts` and `research-journal.ts` assumed `process.env.HOME` - native Windows has `USERPROFILE`, no `HOME` | shared resolver `lib/persistence/dataRoot.ts` (`WEBUI_DATA_DIR` -> `os.homedir()` -> documented fallback); **no global HOME was set**, existing conversation locations unchanged | `__tests__/persistence/data-root.test.ts`, `data-root-tracer.test.ts` in isolated processes. Offline **passed**; this was the initial native-Windows collection failure, now resolved |

Invariant re-checked: a **logical turn lease** (slot) is never held while awaiting a child
model request, and the capacity-1 permit is per upstream request.

## 5. Findings F01-F21: cause, implementation, verification class

Classes: **offline** = verified by deterministic tests/logs; **live** = observed against the
running app; **partial** = mechanism fixed, an acceptance criterion still unmet; **blocked**
= needs a human step.

| F | cause found | implementation | class |
|---|---|---|---|
| F01 | no standing conversational response policy; `WEB_TOOL_GUIDANCE` over-generalized web-evidence rules into ordinary chat | `lib/chat/response-policy.ts` + Rust `chat/policy.rs`: answer what was asked, match depth, small talk stays short, capabilities advertised only on request, never claim unstarted work. No greeting whitelist, no canned idle reply, no fixed sentence count, no extra rewrite call | offline (prompt-assembly tests). Same-prompt A/B on the live model = **not_run** (needs exclusive live window) |
| F02 | artifact intent from brittle English grammar; word order and negation decided deliverables | typed intent model: requested operation / source format / destination format / discuss-vs-execute / negation scope / quotation role / multiple deliverables, with provenance + uncertainty; deterministic fast path only when unambiguous, **abstain** otherwise; multi-deliverable explicit (no arbitrary priority); literal tutorial fences never execute (`fenceRepair` path) | offline (`artifact-intent-f02`, `multi-deliverable-injection`, decision corpus 144 exit 0). Live = not_run |
| F03 | domain constraints attached to the wrong target; preference read as exclusivity | `lib/web-search/domain-constraints.ts`: target, polarity, scope, exclusivity, evidence span, instruction authority; quoted target in a command vs quoted instruction being analyzed; `site:` interpreted in context; trust/preference = ranking unless explicit exclusivity; SSRF controls intact | offline (`domain-constraints-f03`). Live = not_run |
| F04 | previous task's operate-intent + site leaked into a new topic | task identity + real antecedents in TS `task-scope.ts` and Rust `task_scope.rs`; conversation continuity separated from evidence scope and from **action authorization**; topic change resets only the right fields; permission never inferred from topic similarity | offline. Probe shows scope containment, **not** proof an unauthorized browser action would have occurred |
| F05 | lexical signals read as semantics (`c++`/`c#` -> `c`, case-sensitive language names, forced LinkedIn, region from machine locale, wrong presentation surface) | field-aware normalization preserving symbol-bearing identifiers, versions, Unicode combining marks; no substring relevance; explicit unknown states; topic coverage vs claim support vs exhaustive coverage separated; explicit platform/region respected; locale = fallback hint; maintained geography with ambiguity handling; surface chosen from task meaning + validated data capabilities (`surface-corroboration`) | offline (`token-identity`, `surface-corroboration`). Live = not_run |
| F06 | `originalPassageText` kept but consumers used filtered text - preserved text unreachable | immutable addressable canonical blocks with stable ids, URL/offsets/content hash; bounded ranked views with neighbours; read / continue / deepen tools that actually recover omitted blocks | offline (`segment-canonical-recovery` - an answer-bearing passage excluded from the first window and recovered **through the model-facing tool interface**) |
| F07 | retrieval intent from ratios/phrases; shown-history keyed by attachment id | modality/context-aware intent; comparative ranges vs continuous ranges (`range-math.ts`); real continuation detection; repeat-question evidence preserved; history scoped to conversation + attachment revision + task/query + cursor; vector candidates no longer labelled "proven relevant"; resumable exhaustive scan with honest coverage (top-K exhaustion != "no more matches") | offline (`attach-intent-f07`, `attach-coverage-metrics`) |
| F08 | `last_user_idx + 1` passed unconditionally after optional skill insertion; comments preserved the wrong index | recompute the target message after insertion / stable turn identity, TS and Rust; fixtures updated where they encoded the defect | offline; Rust attachment replay passes; new fixture `04-video-time-range-standard-chat.json`, `05-...skill-shift` exercised |
| F09 | per-file atomic replacement, not a multi-file transaction; embedding vectors mixed across dimensions | immutable generation directory + single atomic manifest pointer switch, validate-before-publish, reader consistency, crash recovery, bounded GC, staged frames with unique temp names, per-index write ownership (`publish.ts`, `vectors.ts`, Rust `vectors.rs`); embedding metadata carries model identity/revision, dimension, normalization, pipeline fingerprint; incompatible vectors rejected, no silent dot product over the shorter axis, rebuild from durable originals | offline (`attach-index-tx`, fault injection at each commit step, dimension mismatch) |
| F10 | `embedTexts` took a signal that `buildAttachmentIndex`/`indexContent` dropped | cancellation propagated across upload -> parse -> chunk -> embed -> commit; a cancelled build never publishes a generation | offline (`attach-index-cancel`) |
| F11 | nulls/blanks/invalid text coerced to 0; currency hardcoded to dollars; percent scale guessed; PPTX/PDF defaults presented as mandates; artifact spec treated as proof of execution | `lib/documents/valueModel.ts` (missing / zero / invalid-text / numeric kept distinct), `dataQuality.ts` (locale, currency, units, percent convention, explicit imputation decision, parse errors reported rather than invented measurements); formulas recalculated and dependent values verified; preview/export agreement verified; leading `=` in untrusted imported text is **not** an executable formula; presentation defaults preserved but explicit page size / slide count / branding / accessibility / motion honored; an artifact spec is a **request**, creation reported only after the job succeeds; repairs bounded with real diagnostics | offline: xlsx 6-sheet workbook with 500 rows, 0 nulls, 0 recalc errors; `value-model`, `print-css-page-size` tests |
| F12 | PDF text-layer only (no OCR), Office XML flattened, formulas lost when cached values exist, `String.fromCharCode` corrupting supplementary Unicode (`&#128512;` -> wrong char) | format-aware parsing preserving page/section/table/cell/slide relationships, formulas **and** cached values, cell types, merged ranges, notes, links where supported; correct code-point handling incl. surrogates and hex entities; honest fallback coverage statements; archive/security limits retained | offline (`extract-office-structure`: `2+3` formula with cached 5 keeps both) |
| F13 | 2-frame video constant, 4-frame delivery cap, English-only whisper-base.en default, unused vision-prepass, no read side for scene detection | durable originals + cheap upload baseline (streams, duration, stream start offsets, tracks, embedded subtitles, anchors, coverage); query-driven enrichment; `video/scenes.py` scan + parse + offset + bounds + typed refusals feeding real window plans; `video/timeline.py`, `observations.py`, `search_hints.py`; honest coverage; ASR language capability reported, not assumed | offline + **measured synthetically** (probe above). **partial**: see gap G1/G2 - the hints-to-search-tool-argument path is not wired in production, and no human-labelled real video was scored |
| F14 | prompts described sampled material as a complete saved record | machine-readable coverage objects (examined seconds, truncated, escalation reason, per-page/per-interval status) and natural limitation reporting; file existence never means "was read"; original-file availability separated from semantic index completeness | offline; probe asserts "examined 8.0s of 12.0s; unexamined intervals may contain further occurrences", `claims_completeness=False` |
| F15 | literal text rewritten: a code string containing "according to my searches" triggered a blanket disclaimer; tilde-fenced `[S9]` mutated; literal `[S1]` read as a citation | whole-answer regeneration removal **preserved**; markdown/code-aware validation consistent with rendering; citation provenance explicit; claim kinds separated (external research / user-provided evidence / local tool output / calculation / model inference); web-evidence requirement scoped only to claims needing it; source-id resolution proves identity, not support; weak heuristics kept as telemetry | offline (`answer-release` matrix fixture). No whole-answer erasure reintroduced |
| F16 | held terminal frames released before final metadata; metadata after DONE lost when split across reads; parser error yielded as event -> normal resolve -> repair ran on failed turns | exactly one turn-terminal sentinel per turn, after final metadata/usage/justified revisions/action closures; intermediate tool rounds never terminate the stream; explicit final outcome (success / error / cancelled / truncated / incomplete-tool-round) carried through parser -> client -> hook -> persistence; artifact repair never runs on failed/cancelled turns; TS and Rust aligned | offline (`stream-terminal-ownership`, `web-tool-loop-terminal-ownership`); invariance under byte splits / multi-event reads / UTF-8 boundaries. Live hook+persistence = pending Stage B |
| F17 | (already improved: top-level fences preserve literal tags; `reasoning_details` preferred per delta; duplicate structured reasoning emitted once) - remaining: inline code, 4-space indented code, blockquoted XML fences losing literal tag content | provider-defined structured channels preferred; inline-tag fallback only for an explicit supported protocol; arbitrary tags in answer data are not channel delimiters; coherent incremental splitter with bounded buffering + explicit ambiguity policy, in TS (`createThinkSplitter`) and Rust (`ThinkFieldSplitter`); no per-example regex | offline fence matrix incl. the new inline/indented/blockquote cases, multibyte UTF-8, chunk partitions, mixed structured/legacy fields. **The verified improvements were not undone** |
| F18 | citations + completed page action re-rendered as current work ("Reading web sources", "Page read complete") | one authoritative current-activity state per turn/round (`lib/progress/currentActivity.ts`), action ids + lifecycle closure, source history stays history, stale events from old turns rejected (`turnFence.ts`), concurrency shown only when work overlaps | offline (`current-activity`, `turn-fence`). **Live status labels pending Stage B** |
| F19 | upward position changes read as user intent; following ref overwritten during render; jump-to-bottom not synchronously enabling following | one following/free controller (`lib/ui/scrollFollow.ts`): user vs programmatic scroll distinguished, anchor preservation, rAF-coalesced writes, content + viewport observation, synchronous enable on jump-to-bottom, observer/scheduled-work cleanup | offline (`scroll-follow`). Real-browser jitter measurement = **Stage B/pending**; no jitter rate is claimed |
| F20 | capability gating by brand-name mentions | declared required capabilities vs actually configured adapters; text classification only a hint; provider names count only when they identify a real provider protocol; unavailable capabilities stay honestly unavailable | offline (`modality.test.ts`: a CSV guide about NOT using Midjourney is not blocked; a Leonardo da Vinci text guide is not blocked) |
| F21 | PDF document proxies not destroyed, guards awaited outside cleanup, browser promises retained, embedding/ASR singletons resident, compaction instructions overstated | owned-resource registry with crash recovery and idle release (`lib/lifecycle/ownedResource.ts`, `tempFiles.ts`, `documents/browser.ts`), cleanup in `finally`, repeated-run resource checks, durable structured constraints/provenance across compaction; no "zero knowledge loss" claim from a 95% target | offline (`render-lifecycle`, `temp-files`, `owned-resource`, `compaction-durability`). Long-run soak = not_run |

## 6. Before -> after, concrete

| behavior | before | after (measured offline) |
|---|---|---|
| TS override of the shared endpoint | bypassed Rust admission entirely | shares the single Rust authority for the same resource; a different authorized resource gets its own permit and no bearer-token reuse |
| request queued behind a held permit, `timeoutMs=5` | stayed queued after 25 ms, uncancellable | deadline covers queueing; queued abort and pre-abort both terminate; exactly-once release |
| permit vs cancellation lifetime | released while `reader.cancel()` pending | retained until cancel/drain settles; hard negative proves a never-acknowledging transport cannot leak a permit |
| `<think>` inside inline code / indented code / blockquote fence | contents swallowed into reasoning | literal contents preserved; top-level fences remain positive controls |
| post-DONE usage metadata split across reads | silently lost | delivered before the single terminal sentinel regardless of chunking |
| "Reading web sources" during thinking after citations | shown | rejected; reasoning is the current activity, citations are history |
| C++ vs C evidence | `c++`/`c#` collapsed to `c` | identifier preserved; C-language evidence no longer accepted for a C++ question |
| "Do not use alpha.com, but only use beta.com" | both blocked | alpha excluded, beta allowed exclusively |
| formula 2+3 with cached 5 in XLSX | `A1=5` only | formula and cached value both retained |
| `&#128512;` in Office XML | wrong character | correct supplementary code point |
| scene detection | command exited -22 / silently found nothing | 3/3 declared cuts at exact timestamps, mean_abs_error 0.000 s |
| `video.timeline` capability | `not_installed` false negative (PATH-only probe) | `available`, source `project-local`, path published relative, no host path leaked |
| dense-vs-hybrid retrieval | assumed dense is better | measured: hybrid is not worse and is the only method that can abstain -> **no migration** |
| live e2e conversation store (F22) | 14 files written into the real user conversations store | launcher-owned isolation to `.data\e2e-store` plus a hard refusal guard; isolated re-run verified **0** real-store writes |

## 7. Legitimate hard rules retained (deliberately not removed)

Schema validation at every boundary (Zod TS, serde Rust, dataclass validation Python);
tool authorization; SSRF and loopback/egress controls (incl. the PDF export egress canary
that proves an artifact cannot reach network, loopback or a local file); path containment
including Windows junctions/reparse points, symlinks and UNC/device paths; archive
expansion bounds (member size, count, Zip64 + 7za fallback behavior); page/pixel/subprocess/
temp-storage bounds; resource bounds and deadlines; loopback-only ML endpoint with a
per-run `X-Ruke-Token`; capacity-1 upstream admission for a shared inference resource;
no parent permit held while awaiting a child request. These are contracts, not heuristics,
and each is covered by a test that fails if it is removed.

## 8. Component selection, versions, licenses, language support

- Interpreter: **CPython 3.12.15** (MSC v.1944, AMD64) in a project-local uv venv
  (`python-backend/.python-version` = 3.12, committed `python-backend/uv.lock`).
  Core `dependencies = []`; heavy capabilities are optional extras
  (sentence-transformers, docling, qwen-asr + faster-whisper, pyannote.audio) that are
  **not installed and not locked**, by the `measure-before-pinning` policy.
- Node v26.12.1; next 14.2.35, exceljs ^4.4.0, docx ^9.12.0, pptxgenjs ^4.0.1,
  @huggingface/transformers ^4.3.1, ffmpeg-static ^5.3.0 (ships **ffmpeg 6.1.1**
  essentials, resolved project-locally), playwright + @playwright/test **1.63.0** with
  repo-local chromium-1243 (`PLAYWRIGHT_BROWSERS_PATH = .data/ms-playwright`).
- Embedder actually used: **Xenova/all-MiniLM-L6-v2** (mean pooling + L2 normalize,
  `embedRevision()` = "unpinned" stated honestly). Multilingual candidates
  (Qwen3-Embedding-0.6B, Qwen3-Reranker-0.6B, BGE-M3) report **not_installed**.
- ASR: the old English-only `Xenova/whisper-base.en` default is no longer a universal
  default; per-language capability is declared and Qwen3-ASR/whisper-large-v3 are
  **not_installed**. Telugu/Hindi ASR quality = not measured (Qwen3-ASR's published table
  omits Telugu and excludes Telugu/Hindi from its aligner languages).
- Docling / PaddleOCR / PaddleOCR-VL: **evaluation_required** - not pinned, because
  Indic/RTL coverage claims could not be verified on this machine.
- pyannote Community-1 diarization: **license_acceptance_required** (HF terms not accepted;
  startup unaffected by design; no terms accepted on the user's behalf).
- Language support verified only where checked: retrieval per-language recall@5 = 1.000 for
  ar, en, es, fr, hi, ja, te, vi, zh **on the frozen 38-case identifier suite** - that is
  not evidence about prose, ASR or OCR in those languages.

Measured component-selection evidence: the dense-vs-hybrid comparison table in
`logs/python-eval-methods-s53.json` (D-024) and the temporal probe (D-025). Every other
capability candidate stayed unpinned because it could not be measured here.

## 9. Honest gaps and remaining failures

**G1 (found by reading the wiring) - CLOSED at the baseline/scene level in sessions 58-61.**
What was true: `ml_bridge.rs` only read `/health` and `/capabilities` and never ran a job, so
`video.*`, `embeddings`, `rerank` and `documents.*` had no production caller. What exists now:
`crates/ruke-server/src/ml_job.rs` posts `/api/ruke/ml/job` with the internal bridge secret, a
clamped deadline and typed failures (23 unit tests); `lib/server/ml-job.ts` gives TypeScript
the same contract with a per-capability negative cache; the video branch of
`lib/server/extract/index.ts` builds a **durable timeline record + scene observations** for every
uploaded video through that seam (`buildBaseline`/`publishBaseline`, published under the
per-attachment write lock after the generation switch); those observations reach
`attachindex/media-hints.ts` -> web-tool sessions -> **real `web_search` arguments**, and text-less
scene observations are dropped there so coordinates/thresholds can never become query text.
Pinned by `__tests__/attach-timeline-s60.test.ts` (26 tests) plus the 117-test targeted gate.
**What G1 still does not claim:** the heavy enrichment stages (video ASR, video OCR, vision
observation, embeddings/rerank, documents.*) remain `not_configured`/`evaluation_required`
because the model assets are not on this disk (see sec 13), so brief section 8's full
multimodal-timeline acceptance is still **PARTIAL**, and `temporal_video_localisation` stays
not_run for lack of human-labelled media.

**G2** No human-labelled real video, no real-recording ASR/OCR/document quality. Synthetic
evidence measures clocks, parsing and cut detection only. The frozen
`temporal_video_localisation` family stays **not_run**.

**G3** onnxruntime-node on this host reports `Unsupported device "cuda"` (available:
dml/webgpu/cpu), so heavy ML would run in CPU/DML mode. That is reported, never silently
upgraded, and means full-quality large-model latency on this machine is unmeasured.

**G4** Updated after the final Playwright stage (see sec 10): the live UI gates ran, so
current-activity status labels (F18), stream terminal ownership and post-DONE metadata
(F16) and literal thinking tags under real streaming (F17) are **live-verified**. Still
not live-measured: **F19 scroll jitter** and the **F01** same-prompt verbosity A/B.

**G5** Native Ctrl+C could not be injected into a console-less child (proved: SIGINT and
SIGBREAK never reach it), so graceful teardown was verified through the critical-child
failure path and the PID-tree ownership path instead.

**G6** Resource-swap testing (unloading Strata to run a heavy helper) was **not** performed:
no runner could complete and restore the load without another inference request, and this
turn's own model is that resource. Capability is queued/deferred and reported, not faked.
The 4096 MiB additional-footprint target is therefore reported by measurement
(§below), not by parameter-count arithmetic.

**G7** (closed during the Playwright stage) F22: the first live e2e run wrote into the
user's real conversation store. Fixed in `scripts/run-browser-e2e-exclusive.ps1`
(`-DataDir`, default `.data\e2e-store`, hard refusal when the resolved store is the real
user store, environment set after lock acquisition and before the owned child starts).
Verified by the isolated re-run: 31/31 passed, 18 files in the e2e store, 0 files touched
in the real store. G2-G6 above stay exactly as written; G1 was closed later (sessions 58-61) at the
baseline/scene level, as recorded in its own block above.

Measured footprint (integrated `npm run dev`, no heavy worker started):
owned tree **2445 MB at ready / 2454 MB after 20 s idle**, breakdown Next 2396/2405 MB,
Rust 14 MB, Python supervisor 30-35 MB, browser 0 MB, other 79 MB; VRAM
**9485 / 12288 MiB - entirely Strata**, unchanged by startup; free RAM 7000 MB before and
6847 MB after the run, i.e. no leak across start/stop. A supervisor deliberately loads
**zero heavy imports** (`heavy_imports_at_startup = []`), so the remaining budget for a
worker is the ~4.4 GB of free RAM plus headroom, not a claim that any model fits.

## 10. Playwright (final stage, under the exclusive lock)

Status at the time this section was first written: **NOT_RUN** - deliberately last, per the
user's instruction, because Ruke and Codex share the same capacity-1 Strata endpoint.
The rule is recorded in `CODEX.md`: while a model-driven Playwright run is live, Codex holds
completely idle (one long blocking wait; no edits, no analysis, no polling), and the session
is not ended. Fixture-driven specs that provably cannot reach Strata may be polled.

Lock guarantees (verified by the lock self-test, `scripts/playwright-lock.psm1`):
atomic `FileMode CreateNew` acquire; owner token `runId` + PID + **process start time**
identity; fixed-width 512-byte record so the heartbeat can rewrite in place; handle kept
without `FileShare.Delete` so a live lock is physically undeletable; owner-token-verified
release; stale lease only with printed proof the holder process ended (or PID reuse);
anything unprovable is treated as live. Never an image-wide kill; never a foreign lock delete.

Results, appended after the runs (see the append below; each row is a real exit code):

Stage A - fixture RPC specs that provably cannot reach Strata: **11 passed / 0 failed**,
  17.2 s, exit **0**, executed twice (`logs/p11-stage-a.log`). A third invocation issued
  with `-LockInfo` only, while no foreign lock existed, correctly fell through to the
  default fixture suite; inspected and **not** an ownership defect.

- Stage B attempt 1 - the 7 live-model specs were passed with backslash paths. Playwright
  positional args are **regexes**, so `tests\chat-stream.spec.ts` matched nothing:
  "No tests found", exit **1**. The launcher still stopped its owned process tree and
  released the lock on that failure path, proving ownership hygiene under failure
  (`logs/p11-stage-b.log`). Recorded as decision D-027.

- Stage B attempt 2 - forward-slash paths, 7 live-model specs (`chat-stream`,
  `progress-panel`, `edit-stop-collapse`, `reasoning-test`, `recents-modal`,
  `html-isolation`, `conversations-crud`): **31 passed / 0 failed**, 2.1 min, exit **0**,
  with real upstream SSE traffic visible in the log (`decision_done`, 48 events,
  `reasoning_content` deltas, `[DONE]`). Codex stayed completely idle for that window.

- Stage B re-run under data isolation, after finding F22 below: **31 passed / 0 failed**,
  4.2 min, exit **0**, log line "e2e conversation store isolated:
  ...\.data\e2e-store (source: launcher default)". Afterwards 18 files exist in the e2e
  store and **0** files were touched in the real user store (775 files, unchanged count).

- **Final re-run after the media-wiring change (session 61), production code changed:**
  Stage A **11 passed / 0 failed**, 15.1 s, exit **0**; Stage B (same 7 live-model specs)
  **31 passed / 0 failed**, 2.1 min, exit **0**. Codex held completely idle for the whole
  Stage B window (one blocking wait, no edits/analysis/polls). First Stage B attempt failed on
  argument passing (a bare PS array expanded into positional binding and hit `-AppWaitSeconds`:
  "Cannot convert value ... Int32", exit **1**) - the launcher still stopped its owned tree and
  released the lock; fixed by passing one comma-joined quoted list. After the green run: lock
  absent, ports 3000/3101/3210 free, real user store **775 files unchanged**, `.data\e2e-store`
  32 files.
- **Totals: 126 browser tests passed, 0 failed, across 6 test-running exclusive invocations**
  (Stage A 11 x3, Stage B 31 x3), all exit 0; 2 further invocations failed on launcher argument
  syntax and are recorded as exit 1, not as application failures. Every UI run logs one
  cosmetic 404; recorded here rather than hidden.

- What these runs changed in the verification ledger: **F16, F17 and F18 are now
  LIVE-verified** (terminal ownership plus post-DONE metadata; literal thinking tags under
  real streaming; current-activity status labels). **F19 scroll jitter remains not_run** -
  no jitter rate is claimed anywhere - and the **F01** same-prompt live A/B comparison
  remains **not_run**.

- **F22, found by this stage and fixed in the launcher rather than in the specs:** the
  live specs drive the real app and the launcher set no `WEBUI_DATA_DIR`, so the first live
  run wrote 14 files into the real conversation store
  `%USERPROFILE%\.local-intelligence\conversations` (775 files; no user chat was deleted -
  titles verified still on disk - but the brief isolation gate was unmet). The launcher now
  takes `-DataDir` with resolution order `-DataDir > inherited WEBUI_DATA_DIR >
  .data\e2e-store`, hard-throws when the resolved store **is** the real user store, and
  sets the directory/env **after** acquiring the lock and **before** starting the app child
  (Rust `main.rs` and `lib/persistence/dataRoot.ts` both honour it). Settings live in the
  project-root `settings.json`, so isolation cannot disable the live model. It also warns
  when a foreign :3000 is reused. Script re-validated as parse-clean.

## 11. Evaluation definition, denominators, and scores

Held-out suite: the frozen retrieval/decision families in `python-backend/ruke_ml/eval/`
and the TS decision/domain/answer matrices, **frozen before implementation**; a frozen case
that became a regression is not re-used as held-out evidence. Definition of the
denominator: 38 cases across 7 families; 7 gated capabilities are reported as
`gated_not_run` and are **excluded** from every score rather than counted as passes.

Scores: recall@5 1.000, mrr 1.000, ndcg@5 1.000, abstention accuracy 1.000 (hybrid);
dense_only recall@5 1.000 / mrr 0.984 / ndcg@5 0.988 / abstention 0.000. Unsupported-task
rate: 7 of 7 gated capabilities unmeasured. Deterministic safety/transport/integrity
invariants: 100% of their defined tests (0 failures in 2319 TS tests, 707 Rust, 170 Python, and the
browser totals above).
The 99% objective is an engineering target, **not** a promise about future requests, and a
finite run cannot prove the absence of model errors.

## 12. How to run and how to resume

- `npm install` then `npm run dev`: resolves the repo root, pre-checks ports, builds Rust,
  bootstraps/syncs the project-local uv environment only when the lock/interpreter/platform
  fingerprint says it is stale, starts the Python supervisor, waits for `/health`, starts
  ruke-server, waits for `/api/ruke/health`, starts Next, confirms readiness, then supervises
  its own children. No model download, no heavy import at startup. Offline startup after the
  first setup is supported.
- Tests: `npm run typecheck`, `npm run contracts:check`, `npx vitest run`, `npm run build`,
  `cd python-backend; .\.venv\Scripts\python.exe -m unittest discover -s tests -t .`,
  `cd rust-backend; cargo test --target-dir D:\Projects\WebUI\target-ci`.
- Browser e2e: **there is no `test:e2e` npm script and none was invented.** Use
  `powershell -NoProfile -File scripts\run-browser-e2e-exclusive.ps1` (fixture specs) or
  `-Command "& 'scripts\run-browser-e2e-exclusive.ps1' -TestFiles 'a.spec.ts','b.spec.ts'"`
  for multiple live-model specs.
- Resume: read `docs/overnight/STATE.md` -> `TASKS.md` -> `DECISIONS.md` (through **D-030**) ->
  the F- ledger in `FINDINGS.md` -> the newest gate logs
  `logs/{s61-vitest-full.log, s61-build.log, s61-typecheck-full.log, s61-contracts.log,
  s61-python.log, s61-targeted.log, rust-full-s58.log, p11-stage-a-s61.log,
  p11-stage-b-s61.log, dev-integrated-s50-report.txt, temporal-probe-2026-11-16.json}`,
  then re-verify HEAD `002b969`, the porcelain count, the nft hash and that
  `.ai-coordination/playwright.lock` is absent before continuing at the recorded next task.

## 13. Human steps for the genuine blockers

1. Download (into `.data/models`, or set `RUKE_MODEL_DIR`): Qwen3-Embedding-0.6B,
   Qwen3-Reranker-0.6B or BGE-M3, Qwen3-ASR (0.6B/1.7B) and a multilingual Whisper
   (large-v3) for Telugu/Hindi, plus Docling + an Indic/RTL-capable OCR extra. Then re-run
   `python -m ruke_ml.eval.harness` with those families enabled.
2. Accept the pyannote/speaker-diarization-community-1 terms on Hugging Face with the user's
   own account, then `uv sync --extra diarization`.
3. Provide human-labelled media (real recordings, target-language speech, OCR-only and
   visual-only clues, head/middle/tail events) to score `temporal_video_localisation`, ASR
   WER/CER and OCR CER. Synthetic speech alone was treated as insufficient.
4. If GPU inference for helpers matters: install an onnxruntime build exposing CUDA, or
   accept DML/CPU and re-measure; nothing was silently upgraded.
5. ~~Close gap G1~~ - done in code (sessions 58-61: `ml_job.rs` + `lib/server/ml-job.ts` + the
   video baseline path). What still needs the human steps above is the **enrichment quality**
   side: with the assets present, `video.timeline`/`video.scenes`/ASR/OCR/embeddings can be
   evaluated instead of reported as `not_configured`.

## 14. P10 cleanup, process ownership at the end, and the final host action

Owned-vs-foreign check immediately before the shutdown step:
- No process started by this run survived: ports 3000 / 3101 / 3210 had **no listener**, no
  `ruke-server.exe`, no `ruke_ml` supervisor, no `next dev`, no dev supervisor. The Playwright
  launcher had already printed "Stopping dev supervisor tree" and "Stopping fixture server" for
  its own PIDs and released the lock (`.ai-coordination\playwright.lock` absent).
- Foreign processes deliberately left running: Strata `python.exe` **15484 + 24300**
  (`D:\AI\Strata\.venv ... serve\server.py --port 8080`, still the only owner of 127.0.0.1:8080,
  model **loaded** - no resource swap was ever performed, so there was nothing to restore);
  Codex's own runtime node processes; and `node.exe` **28540** (`@playwright/test test-server`,
  127.0.0.1:56853) whose parent process is the user's **VS Code** (created a day earlier) - it is
  user-owned, was never treated as ours, and was left running. No image-wide kill (`taskkill /IM
  node.exe`, `/IM cargo.exe`, etc.) was ever used, at any point in the run.
- Guard re-verified at the end: `node_modules/next/dist/compiled/@vercel/nft/index.js` sha256
  prefix **21FDA49AD240564F** (pristine).
- Final host action, executed once after this report, STATE.md and the log flush:
  `shutdown.exe /s /t 0`. The issuing timestamp and the captured exit code are recorded in
  `docs/overnight/logs/shutdown-s61.log` (written by the same command line), never a scheduled
  timer and never a forced kill of unrelated applications. A non-zero result would have been
  recorded as `shutdown_failed` with the reason; the run does not retry indefinitely.
- Verdict for the whole run: **PARTIAL (~99% of the declared scope)**. Deterministic gates
  (typecheck, contracts, 2319 Vitest, 707 Rust, 170 Python, Next build, 126 browser tests) all
  exit 0; the open items are the asset/licence-gated model qualities and the two live
  measurements deliberately not taken (F01 A/B, F19 jitter), each with its human step in sec 13.

---

# FINAL REPORT - sessions F20/F21 (2026-11-17 ~03:20 Asia/Calcutta)

Verdict: **PARTIAL**. Not COMPLETE. See MIGRATION-MATRIX.md for the per-capability status and the seven
numbered blockers. The two held suites (OCR document acceptance, Strata unload/reload handoff) are
**code-complete and unit-tested but never executed**, by explicit instruction, because they need an
attended screen.

## 1. Which supplied patches were applied vs adapted

- Amendment section-3 kernel **A (speech-language metadata)**: applied as designed, but placed in a shared
  module `python-backend/ruke_ml/speech/languages.py` (`normalize_language`, `language_is_supported`)
  rather than duplicated in `registry.py`/`asr.py`/`alignment.py`. `language_route` now calls
  `language_is_supported(spec.claims.get("languages", []), lang)`; the character-by-character iteration
  and the prose-based multilingual wildcard are gone. Aligner exclusions key on the registered **aligner**
  id, not ASR model ids. Malformed optional capability metadata is reported without crashing the
  supervisor; automatic/unknown routes to real detection; English-only models are never silently chosen;
  published support is kept separate from measured quality, and unsupported `verified=True` claims were
  removed. Verified by `python-backend/tests/test_speech.py` (incl. an explicit Telugu "unverified, not
  silently supported" case and an aligner-exclusion case).
- Amendment kernel **B (unsupported PDF returned as ready)**: applied at
  `python-backend/ruke_ml/workers/runner.py` immediately after `parser.load_document`, before
  `ocr.assess`, returning `StructuredError("unsupported_input", ...)` for `doc.kind == "unsupported"`.
  Real PDF support was then implemented separately (`documents/pdf.py`), so the guard is a safety net,
  not the whole fix - as the amendment required.
- Amendment section-2 (one shared validated language helper, manifest validation, bounded adapter set):
  applied; we deliberately limited ourselves to faster-whisper CT2 for ASR, PaddleOCR-VL 1.6 +
  PP-DocLayoutV3 for OCR with Tesseract recovery, MiniLM ONNX for embeddings. No open-ended model search.
- Amendment section-3 thinking-tag/scroll kernels: **adapted**, not pasted - the repo already had
  `lib/stream/thinkTags.ts` + Rust `chat/scrubber.rs` with parity fixtures, so the work went into fixture
  coverage (`fixtures/sse/02-think-split-matrix.json`) and the single scroll owner
  `lib/ui/scrollFollow.ts` rather than a second implementation.
- Amendment 5 (resource-aware GPU/CPU + handoff): implemented as a provider-independent coordinator
  (Strata first), because the pinned paddle build has `compiled_with_cuda:false` - the GPU preference is
  therefore **reported unavailable**, not pretended.

## 1b. Actual changed files in this working tree (all uncommitted; `M` modified, `A` added)

Frontend/TS - `M lib/decision/client.ts`, `M lib/server/extract/{index,office,pdf,audio}.ts`,
`M lib/server/attachindex/{timeline,types}.ts`, `M lib/stream/thinkTags.ts`,
`M lib/web-search/domain-constraints.ts`, `A lib/server/extract/document-capability.ts`,
`A lib/server/extract/speech-capability.ts`, `A lib/server/coordination/llm-lease.ts`;
tests `A __tests__/attach-timeline-f04.test.ts`, `A __tests__/decision/generalization-f02b.test.ts`,
`A __tests__/server/{extract-document-capability,extract-speech-capability,llm-handoff-lease}.test.ts`,
`A __tests__/web-search/domain-policy-f03b.test.ts`, `M __tests__/{think-splitter,attach-timeline-s60}.test.ts`,
`M __tests__/rust-golden/{decision-parity,sse-vectors}.test.ts`.

Rust - `M crates/ruke-core/src/admission.rs`, `M crates/ruke-decision/src/engine.rs`,
`M crates/ruke-server/src/{main,ml_job,internal_completion}.rs`,
`M crates/ruke-server/src/chat/{browser_loop,forward,scrubber,web_loop}.rs`,
`M crates/ruke-server/src/titles/generate.rs`, `M crates/ruke-attach/src/notes.rs`,
`A crates/ruke-server/tests/handoff_lease_gate.rs`, `M tests/scrubber_vectors.rs`,
`M fixtures/decision/06-intent-matcher-vectors.json`, `M fixtures/sse/02-think-split-matrix.json`,
`A fixtures/media/measured-prefix-v1.json`.

Python - `A ruke_ml/documents/{pdf,render,ocr_cascade,ocr_paddle,ocr_paddle_worker,ocr_tesseract}.py`,
`A ruke_ml/speech/{languages,levels,whisper_ct2}.py`, `A ruke_ml/workers/{jobs,speech_jobs,document_jobs}.py`,
`A ruke_ml/models/{assets,prepare,ocr_runtime,devices,resources,job_limits,main_model}.py`,
`A ruke_ml/{handoff,processes,language_tables}.py`, `A ruke_ml/retrieval/nn_embed.py`,
`A ruke_ml/eval/embed_vectors.py`, `M ruke_ml/{config,supervisor}.py`,
`M ruke_ml/documents/{ocr,parser,structures}.py`, `M ruke_ml/models/{binaries,lifecycle,registry,resources}.py`,
`M ruke_ml/retrieval/{embeddings,fusion,reranker}.py`, `M ruke_ml/speech/{alignment,asr}.py`,
`M ruke_ml/video/scenes.py`, `M ruke_ml/workers/runner.py`, `M ruke_ml/eval/{datasets,temporal_probe}.py`;
tests `A tests/{test_handoff_devices,test_job_limits,test_memory_policy,test_resources,
test_retrieval_neural,test_speech_audio,test_worker_protocol,test_document_render,test_heldout_readers}.py`,
`M tests/{test_binaries,test_retrieval_documents,test_speech,test_supervisor_workers,test_video,test_video_scan}.py`,
`M pyproject.toml`, `M uv.lock`.

Scripts/docs/deps - `A scripts/prepare-ocr-runtime.ps1`, `A scripts/strata-low-ram.ps1`,
`M scripts/dev-supervisor.mjs`, `M package.json`, `M package-lock.json`, plus the
`docs/overnight/*` ledger and this matrix/probes (`docs/overnight/probes/{e03_speech_probe,
g04_neural_embed_probe,f09_heldout_http_probe,f06_http_probe}`) and `docs/overnight/fixtures/f09/*`.

## 2. Engine owners: migrated vs retained

**Now owned by the Python supervisor (executed in production or live probes):**
PDF native reading, DOCX/PPTX/XLSX reading, PDF page rasterisation, ASR, language routing, alignment
payload shape, video scene/plan honesty, retrieval fusion (RRF) + lexical embeddings, OCR status/assess
layer, OCR engines (Paddle worker + Tesseract executor), neural embedder (standalone), asset preparation,
resource admission + job-object limits, handoff lease.

**Retained on purpose (not migrated - migration status RED by definition, see D-046/H1/H2):**
`lib/server/attachindex/{retrieve,embed}.ts` for the live retrieval path (a committed `store_compat`
golden asserts the Rust block is byte-identical to the TS block, so swapping owners is a decision with a
contract consequence, not a status edit); `lib/documents/{xlsxEngine,docxEngine,pptxEngine,pdfEngine,
resumeHtml,chartHtml,recalc}.ts` artifact writers; `lib/web-search/search-gate.ts` availability
regexes (still live, retirement HELD until the model-selected path is proven end to end); the resume and
chart engines (reused, not rebuilt).

## 3. Pinned versions, revisions, assets, paths

| component | pin | location |
|---|---|---|
| OCR interpreter | `python-backend/.venv-ocr` (isolated, wired into the worker launcher) | project-local |
| paddlepaddle / paddleocr / paddlex / opencv-contrib | 3.2.1 / 3.6.0 / 3.6.1 / 4.10.0.84 | `.venv-ocr` |
| recognition model | `PaddlePaddle/PaddleOCR-VL-1.6` @ `132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd`, `model.safetensors` 1,917,255,968 B | `.data/ml-cache/huggingface/hub/...` |
| layout model | `PaddlePaddle/PP-DocLayoutV3` @ `241f8bdfc77a7c7bee915a5057aaee58c235a8d3`, `inference.pdiparams` 130,806,572 B, `inference.json` 1,196,890 B | same cache root |
| Tesseract | 5.5.3.20260724, DLLs bundled, tessdata **eng + osd** | `.data/tools/tesseract/` |
| rasteriser | pypdfium2 5.6.0 | `.venv` |
| ASR | faster-whisper 1.2.1 / ctranslate2 4.9.0, `Systran/faster-whisper-base` CT2 snapshot | project cache |
| embeddings | `Xenova/all-MiniLM-L6-v2` ONNX, sha256 `759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e`, CPUExecutionProvider | project cache |
| PDF reader | pypdf 7.1.0 | `.venv` |

Preparation commands (explicit, never part of startup):
`python-backend\.venv\Scripts\python.exe -m ruke_ml.models.prepare --pipeline PaddleOCR-VL-1.6`,
`scripts\prepare-ocr-runtime.ps1` (add `-Probe` to also write a device-verified manifest; the venv-ocr
package set is recorded verbatim in `logs/f19-ocr-setup-1.err.log`: paddlepaddle 3.2.1 plus 13 pinned
deps into `python-backend/.venv-ocr`). **Reproducibility gap:** there is no committed
`prepare-tesseract-runtime.ps1` - the UB-Mannheim build was fetched and unpacked into
`.data/tools/tesseract/` by an interactive command that was never turned into a script, so a fresh
machine cannot reproduce that step from the repo. Recorded as a real gap, not hidden behind the fact
that the local install works. **One-command startup:** `npm run dev` (supervises Next, `ruke-server`,
and the lightweight Python supervisor; heavy workers stay lazy and idle-unload).

## 4. Measured resources

- Host: 63.77 GiB total. While the main LLM (`strata.exe`, ~52 GiB WS) is resident, only ~3.7-6.4 GiB is
  free. Documented honestly in `docs/overnight/STRATA-RAM.md`; the `scripts\strata-low-ram.ps1
  --ram-keep-gib` lever was **not applied** because it needs a Strata restart that was not authorised.
- Idle Ruke tree, main LLM excluded: **RSS 1568 MiB / private 2126 MiB** (`logs/f18-tree-1.log`).
- ASR worker cold+processing peak: **388.0 MiB working set, zero GPU** (`gpu_violations: null`).
- Neural embedding worker: **164 MiB RSS peak, CPUExecutionProvider only**.
- OCR primary: `est_peak_mib 3300`, `est_peak_vram_mib 6000` - **provisional estimates, never measured by
  an actual run**, which is exactly why the ceiling claim is ORANGE and the run is HELD.
- No new GPU allocation was observed in any executed worker; the pinned paddle build cannot select CUDA
  (`compiled_with_cuda:false`, `device:cpu`) - `logs/f19-paddle-device-1.log`.
- The 4 GB target / 5 GB maximum now has a real mechanism (Windows job object on owned children +
  `memory_pressure` admission + commit-charge clamp), unit-tested; **its peak has never been observed**,
  so the acceptance statement stays "mechanism implemented, ceiling unverified".

## 5. Tests: exact commands, exit codes, evidence

`tsc0` 0 errors; `cargo351` 351 passed; `py339` 339 OK; `contracts0`; `build0`; `vit2461` 2461 passed /
19 skipped / 0 failed (a first attempt failed 2 load-sensitive specs, re-ran clean, both recorded - D-051).
All exit 0. Logs named in TEST-RESULTS.md. The full vitest count **included** a debug scratch spec
`__tests__/server/tmp-dbg.test.ts` that emitted console noise; a removal attempt was refused by the
sandbox, so it is still present and should be deleted by hand.

**Real engine execution (not mocks):** ASR live with real weights (WER 0.0769 / 0.0), Tesseract live on
real rasterised pages (WER 0.0, eng+osd only), ONNX MiniLM live (7/9 checks, numeric failure kept).
**Mocked/fixture only:** readers over generated fixtures, handoff device planning, job-object limits,
think-tag parity, scroll-follow unit logic. **Not executed at all:** PaddleOCR-VL pipeline, in-job
Tesseract fallback, handoff lease against a live Strata endpoint, browser/Playwright acceptance.

## 6. Supported and verified coverage (honest)

- ASR: the language tags come from the pinned backend's published metadata; **measured** WER exists only
  for the two probe clips. Published != measured quality, and that distinction is in the payload.
- Tesseract: **eng + osd installed**, and that is what we report.
- Cross-encoder rerank: unavailable, adapter refuses to claim readiness.
- Diarization: **BLOCKED** on licence acceptance; returns a typed `license_acceptance_required`. Not
  bypassed, not simulated.
- Video: decode/plan honesty measured (declared cuts 3/3, decode prefix 11.9/12.0 s); **frame OCR through
  a video job never ran**, so no visual-understanding claim is made.

## 7. Remaining blockers and smallest next action

1. Primary OCR never executed -> run SPEC 16.6 attended; then `-ManifestOnly -Probe` to clear
   `cpu_only_verified:false`.
2. Handoff never live -> run SPEC 17.8 attended, one exclusive foreground runner, Codex idle.
3. In-job Tesseract fallback never triggered -> force one page failure in a mixed PDF.
4. G2 neural retrieval has no production caller -> decide the owner swap, then re-run `store_compat`.
5. H1/H2 writers retained TS -> migration stays RED unless parity work is scheduled.
6. E3 diarization -> needs the user's licence acceptance.
7. No browser acceptance -> `scripts\run-browser-e2e-exclusive.ps1` after checking the shared Playwright lock.

Stray files left in the repo root: `a.txt`, `lock-out.txt`, `__tests__/server/tmp-dbg.test.ts` - my own
scratch/harness artifacts; deletion was refused by the sandbox policy, so they remain for manual removal.
The working tree stays **deliberately uncommitted** (~273 entries) at HEAD `abc988c2...`.

## 8. What this report does not claim

No zero-bug claim, no "99% overfitting removed", no universal-best OCR, no quality parity without
evidence, no migration completion from mocks, and no physical power-off from an accepted shutdown
command. HELD items are HELD, not GREEN.

---

# FINAL REPORT - session F26 close (2026-11-17 ~06:05)

## Verdict: **PARTIAL**
Not COMPLETE. Two mandatory acceptance groups were deliberately **held** because they need a human
watching the screen (a multi-GB primary OCR run that may park the main model, and the Strata
unload/reload handoff). The artifact writers are a **retained TypeScript owner**, so the Python
migration of artifact creation is explicitly incomplete. Diarization is blocked on a licence that was
never accepted on the user's behalf. Neural reranking has no weights. GPU OCR is impossible on this host
right now. The hard 5 GB ceiling is **not proven under OCR load** because the OCR peak has never been
measured. Progress is roughly **78-80%**: the unattended implementation and gate work is finished; the
attended evidence is what remains.

## Files changed in this arc (F22-F26), from the working tree
Python: `ruke_ml/documents/ocr_paddle.py`, `ocr_paddle_worker.py`, `ocr_cascade.py` (readiness CLI),
`ruke_ml/handoff.py` (kill path removed), `ruke_ml/models/registry.py`, `ruke_ml/contracts.py`,
`ruke_ml/workers/runner.py`, `workers/video_jobs.py`, `ruke_ml/video/frame_ocr.py`,
`tests/test_ocr_fallback.py`, `tests/test_handoff_devices.py`, `tests/test_frame_ocr.py`.
Rust: `crates/ruke-server/src/ml_job.rs`, `crates/ruke-server/src/lib.rs`.
TypeScript: `lib/progress/capabilityStatus.ts`, `lib/server/attachindex/types.ts`,
`lib/server/attachindex/timeline.ts`, `lib/server/extract/document-capability.ts`,
`__tests__/attach-timeline-s60.test.ts`, `__tests__/attach-timeline-frameocr.test.ts`,
`__tests__/server/extract-document-capability.test.ts`.
Scripts: `scripts/run-handoff-acceptance.ps1`, `scripts/run-ocr-acceptance.ps1`,
`scripts/prepare-tesseract-runtime.ps1` (new).
Fixtures/probes (new, untracked dirs): `docs/overnight/fixtures/d1/` (5 PDFs + `answer-key.json` +
`ocr_docs.py`), `docs/overnight/probes/d1_ocr_acceptance_probe.py`,
`docs/overnight/probes/j4_handoff_probe.py`. Docs: SPEC, STATE, TASKS, DECISIONS (D-053..D-055),
FINDINGS, TEST-RESULTS, MIGRATION-MATRIX, DECISION-OWNERSHIP, FINAL-REPORT. Nothing was committed.

## Engine owners that actually executed on this host (live) vs coded-only
Executed live: pypdf 7.1.0; DOCX/PPTX/XLSX Python readers; pypdfium2 5.6.0 rasterisation;
faster-whisper 1.2.1 / ctranslate2 4.9.0 on `Systran/faster-whisper-base` (WER 0.0769 / 0.0, peak
388 MiB, no GPU); project-local Tesseract `v5.5.3.20260724` (`eng`, `osd`) with WER 0.0 on an
independently authored two-page key **and** today's 20/20 key-word run; ONNX `Xenova/all-MiniLM-L6-v2`
embedder (164 MiB, 7/9 checks, numeric failure kept); hybrid RRF.
**Prepared but never executed: the PaddleOCR-VL 1.6 primary pipeline.** It is pinned, downloaded,
size-verified and wired, and the readiness CLI reports it ready - which is asset readiness, not
functional evidence.
Retained TypeScript (Python-migration incomplete by definition): `lib/documents/{xlsxEngine,docxEngine,
pptxEngine,pdfEngine,resumeHtml,chartHtml,recalc}.ts` and `lib/server/attachindex/{retrieve,embed}.ts`.

## Pinned assets and the commands that rebuild them
- Primary OCR assets: `PaddlePaddle/PaddleOCR-VL-1.6 @ 132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd`
  (`model.safetensors` 1,917,255,968 B) and `PaddlePaddle/PP-DocLayoutV3 @
  241f8bdfc77a7c7bee915a5057aaee58c235a8d3` under `.data/ml-cache/huggingface/hub`.
  Prepare: `python -m ruke_ml.models.prepare --pipeline PaddleOCR-VL-1.6` (project-local cache root).
  Readiness: `python -m ruke_ml.documents.ocr_cascade`.
- Isolated OCR runtime `python-backend/.venv-ocr`: `paddlepaddle==3.2.1` (CPU wheel),
  `paddleocr==3.6.0`, `paddlex==3.6.1`, `opencv-contrib-python==4.10.0.84`; prepared by
  `scripts/prepare-ocr-runtime.ps1` with the uv cache at `.data/cache/uv`.
  `paddle.is_compiled_with_cuda()` is False, so `allow_gpu = False` honestly.
- Recovery Tesseract: `.data/tools/tesseract`, `v5.5.3.20260724`, languages `eng, osd`; rebuild with
  `scripts/prepare-tesseract-runtime.ps1`, verify with the same script `-VerifyOnly`.
- ASR: `Systran/faster-whisper-base` inside `python-backend/.venv`.
- Startup: **`npm run dev`** supervises Next + `ruke-server` + the lightweight Python supervisor; heavy
  workers are lazy and idle-unloaded; ordinary startup downloads nothing.

## Measured resources (2026-11-17, no dev tree running)
RAM 65299 MiB total, **7308 MiB free**; commit charge ~75774 of 100115 MiB.
VRAM RTX 3060: 12288 MiB total, 9483 used, **2633 free** - GPU OCR cannot fit while the main model is
resident. Ruke tree with the main LLM excluded: 1568 MiB working set / 2126 MiB private at idle
(`f18-tree-1.log`). Budget is 4,000,000,000 B target / 5,000,000,000 B hard; **not** proven under the
primary OCR load because that load has never run. The OCR estimates (3300 MiB RAM, 6000 MiB VRAM) are
labelled provisional everywhere they appear.

## Live vs mocked validation
Unit/mocked: 375 Python tests, 2477 TS tests, 351 Rust tests, contracts + build + typecheck exit 0.
Real-engine executed: ASR, Tesseract, ONNX embedder, native PDF/Office readers (listed above).
Real-model decisions and browser UI checks: **not run this session** (need the dev tree plus an idle
coding agent). Primary OCR and the unload/reload handoff: **held**.

## Real blocker list (nothing here is "not downloaded yet")
1. pyannote diarization: token + licence acceptance - a human decision, never taken for the user.
2. GPU OCR: needs a CUDA-enabled pinned paddle build; then `RUKE_OCR_ALLOW_GPU=1` and re-measure.
3. Neural reranking: cross-encoder weights absent.
4. `scripts\strata-low-ram.ps1 --ram-keep-gib` unapplied - needs a Strata restart that was not
   authorised (`docs/overnight/STRATA-RAM.md`, D-048). It would buy RAM headroom for the primary OCR.
5. Hard 5 GB ceiling for children is cooperative, not OS-enforced end-to-end (J3).
6. The internal-completion inference gate (503 while OCR owns the lease) is only PARTIAL because the
   bridge secret is per-run (`scripts/dev-supervisor.mjs`).

## Resumable next action (attended, tomorrow)
1. `npm run dev`, then refresh `node docs/overnight/probes/f09_heldout_http_probe.mjs` and check
   `:3101/api/ruke/health` (now includes `handoff_held`) and `/api/ruke/ml-status`.
2. `scripts\run-ocr-acceptance.ps1 -AllowUnload -ConfirmUnload UNLOAD` for the engine path, then with
   `-StartDev` for the production upload path, plus `--inject-primary-failure-page 3` and the
   `--max-free-mib` valve. Record content, structure, page provenance, coverage, fallback reason and
   peak RAM/VRAM.
3. `scripts\run-handoff-acceptance.ps1 -Attended -ConfirmUnload UNLOAD` with the coding agent idle.
4. Frame-OCR live check on a slide-heavy video; then the Playwright stage through
   `scripts\run-browser-e2e-exclusive.ps1` after checking the shared lock.
5. Only after those: G2 retrieval owner decision (D-046) and retiring the `search-gate.ts` phrase rules.

---

# FINAL REPORT - session F27 close (2026-11-17 ~06:55 Asia/Calcutta)

## Verdict: **PARTIAL**, about **80%** of the brief

Split exactly the way the user's last instruction implies. **Everything that can be finished without a
human watching a screen is implemented and gated.** What is left is deliberately **HELD** because it
needs attendance (and would fight the coding agent for the capacity-one Strata endpoint), plus a short
list of genuinely external blockers. A HELD item is never GREEN, and 80% is not a quality claim.

| band | share | what it contains |
|---|---|---|
| implemented, gated, evidence on disk | ~80% | the Python supervisor + document/OCR/speech/video/retrieval engines, resource admission, the handoff coordinator, Tesseract runtime executed, ASR executed, native PDF/Office readers, cross-encoder reranker (new this session), all offline gates |
| coded + unit-tested, **deliberately not run** | ~15% | live PaddleOCR-VL pipeline (engine path and production upload path), live Strata unload/reload scenarios, frame-OCR live evidence, browser/Playwright stage, model-led routing live validation |
| genuinely blocked | ~5% | pyannote diarization licence, GPU OCR build for the pinned paddle wheel, Python rewrite of the four artifact writers (retained TS owner) |

## What this session actually changed

| file | change |
|---|---|
| `python-backend/ruke_ml/retrieval/nn_rerank.py` | **new** - digest-pinned CPU-only ONNX cross-encoder: pins model id, upstream, commit `a09144355adeed5f58c8ed011d209bf8ee5a1fec`, `sha256 c623d0bc...881870`, re-verifies at every load, refuses non-CPU first provider, pair tokenization + sigmoid(logit), 256-token window with reported truncation, bounded threads, typed `CrossEncoderError(reason=...)` |
| `python-backend/ruke_ml/retrieval/reranker.py` | added the cross-encoder mode family and `_cross_encode()`, `cross_encoder_ready()`; refusal message now names the three installed engines |
| `python-backend/ruke_ml/workers/runner.py` | `_do_rerank` payload gains `engine` (real ModelIdentity for neural modes), per-mode `quality_note`, and `truncation_note` for the cross-encoder |
| `python-backend/ruke_ml/models/registry.py` | new `rerank` row matching the code exactly, with `verified` recording the **negative** results (`beats_dense_biencoder...`, `numeric_fact_case_fixed`, `production_caller_wired` all False) and `languages: []` + English-MS-MARCO note; `est_peak_mib 268` with an honest basis string |
| `python-backend/ruke_ml/models/assets.py` | `local_asset_dir()`, `prepare_local()` → writes **`asset-manifest.json`** with commit, retrieval time, staging cache and per-file sha256 |
| `python-backend/ruke_ml/models/prepare.py` | `--local` flag, `_allow_patterns_for()`, richer report (`layout`, `manifest_ok`, `files`, `weights_sha256`, `problems`) |
| `docs/overnight/probes/g05_cross_encoder_probe.py` | **new** frozen probe: 10 hand-authored queries / 6 domains, expected answer fixed before any engine ran; peak-memory ctypes bug fixed |
| `docs/overnight/probes/g04_neural_embed_probe.py` | obsolete expectation replaced: refuses an explicitly **unpinned** mode now; prints cross-encoder pin status |
| `python-backend/tests/test_retrieval_neural.py` | stale refusal test replaced + **8 new tests** (see gates) |
| docs | DECISIONS **D-056**, **D-057**; FINDINGS F27; TEST-RESULTS F27 table; MIGRATION-MATRIX F27 delta; TASKS F27 block plus corrections to stale boxes; this section; STATE rewrite |

No TypeScript, Rust, contract or UI file was touched this session.

## Engines: executed for real vs retained vs HELD

**Executed live on this host (evidence in `docs/overnight/logs/`):** pypdf 7.1.0; DOCX/PPTX/XLSX native
readers; pypdfium2 5.6.0 rasterisation; Tesseract `v5.5.3.20260724` project-local (langs `eng, osd`,
real image→text 20/20 key words); faster-whisper 1.2.1 / ctranslate2 4.9.0 (WER 0.0769 / 0.0, peak
388 MiB, zero new GPU); ONNX MiniLM embedder (`all-MiniLM-L6-v2`, 7/9 with the numeric failure kept);
and now **ONNX MiniLM cross-encoder** (`ms-marco-MiniLM-L-6-v2`, mechanics 7/7, 9/10 top-1, MRR 0.950,
481 ms for 30 reranks, peak WS 267.7 MiB).

**Prepared but never executed (HELD):** PaddleOCR-VL 1.6 + PP-DocLayoutV3 in the isolated
`python-backend/.venv-ocr` (paddlepaddle 3.2.1 CPU, paddleocr 3.6.0, paddlex 3.6.1). The 1,917,255,968 B
safetensors and 130,806,572 B layout params are on disk and a readiness CLI says ready. **A nonempty
model folder is not a passed OCR gate** - D1 stays ORANGE until a real complex document runs through it.

**Retained by decision, therefore not "migrated":** XLSX/DOCX/PPTX/PDF/chart/resume writers in
TypeScript (`lib/documents/*Engine.ts`, `resumeHtml`, `chartHtml`, `recalc`), and retrieval ownership in
`lib/server/attachindex/{retrieve,embed}.ts`. Working ≠ migrated, and both lines stay RED/ORANGE for
migration status.

## Exact commands and exit codes from this session

```
python-backend\.venv\Scripts\python.exe docs\overnight\probes\g05_cross_encoder_probe.py   -> exit 1, 9/10 (the numeric case FAILS on purpose)   logs/f27-g05-rerank-2.log
python-backend\.venv\Scripts\python.exe -m ruke_ml.models.prepare --model Xenova/ms-marco-MiniLM-L-6-v2 --local -> exit 0, manifest_ok true       logs/f27-rerank-prepare-2.log
python-backend\.venv\Scripts\python.exe docs\overnight\probes\g04_neural_embed_probe.py     -> exit 1, 7/9 (both numeric failures reproduced)     logs/f27-g04-rerun-1.log
cd python-backend && .venv\Scripts\python.exe -m unittest discover -s tests -t .           -> exit 0, Ran 383 tests, OK                          logs/f27-python-2.log
   (first attempt exit 1: one wrong attribute `.code` in the new test - fixed, not excused)                                              logs/f27-python-1.log
```
TS/Rust gates were **not** re-run this session and the reason is edit scope, not convenience: no `.ts`,
`.tsx` or `.rs` file changed, and `rerank` is not in the Rust `ALLOWED_CAPABILITIES` list, so no
consumer of the new payload keys exists. The last runs of those surfaces remain
`f26-vitest-2.log` (2477 passed / 19 skipped, exit 0), `f26-typecheck-1.log` (exit 0),
`f26-contracts-1.log` (exit 0), `f23-cargo-4.log` (351 passed), `f23-build-1.log` (exit 0).

## Held: exactly what to run tomorrow, and why it was held

The user's instruction was explicit: *"finish the rest but testing this ocr and strata load and unload
hold it finish the code but do not test it yet... this test requires user to stay and monitor the screen
which I am currently not going to do."* So these were left at the last safe checkpoint:

1. `scripts\run-ocr-acceptance.ps1 -AllowUnload -ConfirmUnload UNLOAD` (engine path), then add
   `-StartDev` for the production upload path; plus `--inject-primary-failure-page 3` and the
   `--max-free-mib` valve. Readiness first:
   `python-backend\.venv-ocr\Scripts\python.exe -m ruke_ml.documents.ocr_cascade`.
   It loads multiple GB and may require the main model to be parked - hence attendance.
2. `scripts\run-handoff-acceptance.ps1 -Attended -ConfirmUnload UNLOAD` - five scenarios, needs the
   coding agent idle (capacity-one Strata) and someone watching RAM/VRAM.
3. Frame-OCR live evidence on a slide-heavy video (`RUKE_DOCUMENT_OCR_LANGUAGE=eng`, expect
   `frameRead.recognised > 0`).
4. `scripts\run-browser-e2e-exclusive.ps1` after checking the shared Playwright lock.
5. Model-led routing live validation, then retiring the `lib/web-search/search-gate.ts` phrase rules.

Both wrappers refuse to unload unattended (exit 2 with a reason); only the safe/DryRun branches have
ever executed here (`j4-safe-console-2.txt`, 14 scenarios, 0 misses).

## Real blockers and smallest next external action

- **pyannote diarization**: needs the user's Hugging Face token and licence acceptance. Never accepted
  on the user's behalf; stays `license_acceptance_required`.
- **GPU OCR**: the pinned `paddlepaddle 3.2.1` wheel reports `compiled_with_cuda False`, and VRAM free
  was 2633 MiB with 9483 MiB used by the main LLM. Policy is honestly `allow_gpu=False`. Smallest
  action: pin a CUDA-enabled paddle build in `.venv-ocr` (separate decision) or park the LLM and run CPU.
- **5 GB hard ceiling**: coded (job object on owned workers + admission + commit clamp) but **not
  proven under load**, because the load case is the HELD OCR run. This is an acceptance gap, stated as
  one. Do not read the idle figure (1568 MiB WS / 2126 MiB PRIV) as compliance.
- **Legacy DOC/PPT**: honest typed `unsupported_input`. Office 16 is installed, but COM conversion was
  deliberately not built (D-057): the frozen suite has no legacy ground truth, and `Quit()` on an
  automation object can discard the user's unsaved documents. Needs explicit authorisation plus fixtures.
- **Retrieval ownership (D-046)**: the engines exist and execute; production retrieval is still
  TypeScript. This is an owner decision the user should make, with the numeric-fact regression visible.

## What this report does not claim

No zero-bug claim, no "99% of overfitting removed", no universal-best OCR, no quality parity for the
cross-encoder (it **tied** the bi-encoder on a 10-query set and still fails the numeric case), no
multilingual claim for the reranker or Tesseract (`eng, osd` only), no claim that a synthetic clip or a
scene plan establishes visual understanding, and no claim that the OCR/handoff paths work end to end -
they have never been run. The shutdown below is a shutdown **request**, not an observed power-off.

## F27 final close-out, pre-shutdown verification (2026-11-17 06:43 +05:30)

Status given to the user on request: **about 80%**, verdict **PARTIAL**. Bands:

| portion | state | examples |
|---|---|---|
| ~55% | implemented, unit-tested, gate-passing, with a production caller | native PDF/DOCX/PPTX/XLSX reading, code-led input inspection, capability registry + typed errors, decision ownership split, streaming/status lifecycle, cancellation/caching, one-command startup supervision |
| ~25% | coded and unit-tested but **HELD** for an attended run (never called GREEN) | primary PaddleOCR-VL pipeline run, Tesseract fallback trigger, Strata unload/reload handoff, frame-OCR evidence, browser/Playwright, model-led routing live check |
| ~10% | genuinely blocked or intentionally retained | pyannote diarization licence, GPU paddle build, unproven 5 GB ceiling, Python artifact writers (TS owners retained), legacy DOC/PPT (D-057), retrieval owner decision (D-046) |

Estimated remaining **human-supervised** time: about **2.5-4 h** tomorrow - readiness check, primary OCR
over the d1 corpus plus fault injection and the memory valve, handoff scenarios (needs this coding agent
idle because Strata capacity is 1), frame-OCR, Playwright stage, then the two owner decisions. Unattended
implementation work is finished; nothing in that estimate is waiting on code I could have written tonight.

Verified immediately before the shutdown request, all from this session:
- `git rev-parse HEAD` = `abc988c208a99f4e224250166300f4ff7fb32549`, branch `local`,
  `git status --porcelain` = **341** entries. Nothing committed, pushed, reset, stashed or cleaned.
- Last gate: Python `Ran 383 tests ... OK` exit 0 (`logs/f27-python-2.log`). TS/Rust logs from F26/F23
  stand because this session touched no `.ts/.tsx/.rs` and `rerank` is not on the Rust ml-job allowlist.
- No owned process: no Next dev server, no `ruke-server.exe`, no Ruke Python supervisor
  (`Get-CimInstance Win32_Process` for those names returned only `strata.exe` 5272).
- No owned lease or journal: `.ai-coordination/llm-handoff.lock` absent,
  `.data/python/handoff-journal.json` absent. Nothing of mine holds the Strata endpoint.
- Left running and untouched: `strata.exe` 5272, pythons 3176/3180 (Strata server, capacity 1),
  node 12008 (Codex artifact host daemon), node 15164 (this CLI), VS Code family. The F26 note about a
  `@playwright/test` test-server (pid 5528) is now stale: that process is gone. No process was killed by
  image name at any point.
- Resources at 06:43: RAM 65299 MiB total / **8313 MiB free**; commit 73953 of 100115 MiB; RTX 3060
  2633 MiB VRAM free (F26 nvidia-smi). Nothing was uploaded to the GPU and no inference was run tonight.
- Docs flushed before shutdown: STATE.md rewritten for F27 (previous copy archived verbatim at
  `logs/STATE-f26-archive.md`), plus TASKS, DECISIONS (D-056, D-057), FINDINGS, TEST-RESULTS,
  MIGRATION-MATRIX (F27 delta) and this report.

Authorized shutdown, issued as the last action of this session, no `/f` (applications are not forced
closed) and no retry loop:

    cmd /c "shutdown.exe /s /t 0"

shutdown_requested: YES - 2026-11-17 06:4x +05:30. The exit code and any OS refusal are recorded on the
next line, appended after the call returned. An accepted request proves a **request**, not an observed
physical power-off. No coding, tests, downloads or inference follow it.
*** End of File
RESULT LINE: shutdown.exe /s /t 0 exit_code=0 issued 2026-11-17 06:46:57 +05:30 - request accepted means a shutdown REQUEST, not observed power-off. No coding/tests/inference after this.


---

# F54-F58c section (sessions 2026-11-17 ~22:00 to 2026-11-18 ~00:40 +05:30)

Written at the F58c checkpoint. Everything below is separated into **changed files**, **owner**,
**executed or not**, and **measured or not**. Nothing here issues a shutdown; the earlier authorized
shutdown at 06:46 on 2026-11-17 was a prior session's last action, and the machine is running now.

## What changed and why

1. **ASR allocation root cause (F54, D-073).** Windows job objects cap **commit charge**, but
   `ModelSpec.est_peak_mib` is a **resident** figure. Two 388 MiB-resident ASR workers produced a 776 MiB
   commit ceiling against a **measured 1,276 MiB commit peak**, so the run died in `mkl_malloc` and was
   misreported as `model_unavailable`. Fixed by making the ceiling commit-aware and classifying allocation
   refusals by what actually happened: `ruke_ml/allocations.py` (`est_peak_commit_mib`, `_basis`,
   `_ceiling_bytes`, `_commit_ceiling_shortfall`, `_admission_refusal`), `workers/jobs.py::typed_from_kind`,
   `speech/whisper_ct2.py`, `documents/ocr_paddle.py::load_refusal`, `retrieval/nn_embed.py`,
   `retrieval/nn_rerank.py`, `workers/runner.py::_retrieval_failure`, plus
   `KIND_TO_REASON["allocation_failed"]`. New `tests/test_memory_kinds.py` 21 OK.
   **Real execution, no override:** the production pool derived a **1,914 MiB** ceiling from
   `measured_commit_peak_mib: 1276` and produced the same real transcript in 1.53 s
   (`logs/f55-g26-asr-fixed-1.log`).
2. **Unknown-is-not-zero (F57/F58, D-076).** A missing measurement used to render as `0`, and provisional
   estimates were rendered beside measured ones with no distinction. Swept across
   `models/{resources,devices,job_limits,lifecycle}.py`, `documents/ocr_paddle.py`, `handoff.py`; every
   provisional figure now carries a basis token that says "provisional". New
   `tests/test_measurement_unknown.py` 17 OK. Same class as the TS lease reader, which was audited the same way.
3. **PPTX speaker notes (F56, D-075).** The F50 reopen probe proved the writer created three `notesSlide`
   parts whose only text was the slide-number placeholder, i.e. authored notes were silently dropped.
   `lib/documents/pptxEngine.ts` now calls `addNotes()`; `ruke_ml/documents/parser.py` surfaces note text
   with slide provenance; the round trip is asserted from the **reader** side in
   `python-backend/tests/test_retrieval_documents.py` and cross-runtime in
   `__tests__/documents/artifact-reopen-parity.test.ts`. The byte-pinned contract fixture failed first, was
   re-recorded only with the sanctioned `RUKE_GOLDEN_UPDATE=1` (3 lines), then passed without the flag.
4. **One provider configuration (F55/F56, D-074).** Chat preferred `settings.json` while the Python
   lifecycle client preferred environment/`.env.local`, so the two could target different servers.
   `models/provider_config.py` and `lib/server/settings.ts` now share one resolution order and
   `RUKE_LIFECYCLE_BASE` **preserves the URL path prefix** instead of stripping to origin. 20 OK.
5. **Speech-activity gating (F58/F58b, D-077).** An ungated 40 s window invented the word `You` over
   2.0 s of digital silence. Gating is now on by default in `speech/whisper_ct2.py` using the silero VAD
   asset already shipped inside the pinned `faster_whisper` package (`assets/silero_vad_v6.onnx`,
   verified present) - no new download, no new dependency, no network in the worker. `vad_filter` and
   `vad_state` say what actually happened; if the pinned backend signature rejects the argument, the run
   continues ungated with that refusal recorded instead of failing the job. `tests/test_asr_vad.py` 14 OK.
6. **Transcript duplication at a decode-window boundary (F58c, D-078).** `_merge_windows` only dropped
   identical-text duplicates, so a fragment cut at the end of a window (`16.30-19.30`) was concatenated
   alongside the complete reading of the same span (`16.26-21.26`) - production duplication, not a probe
   artifact. Fixed with a provenance rule: internal `_window` provenance (never on the wire),
   `BOUNDARY_CLIP_TOLERANCE_S = 0.35`, supersession only by an **untruncated** reading from a **different
   window** covering >= 0.9 of the span with real audio beyond the cut edge; otherwise the fragment is kept
   and marked `window_truncated`. Superseded fragments are **reported**, not silently discarded.
   `tests/test_asr_windows.py` 14 OK.
7. **The last hop (F58c).** The same honesty fields stopped at the Python/TS boundary, so the user-visible
   engine note could not mention truncation or supersession. `lib/server/extract/speech-capability.ts` now
   parses `window_truncated` / `vad_filter` / `vad_state` / `superseded_fragments` / `superseded[]`, drops
   malformed fragments rather than citing them, and `speechEngineNote()` claims "applied per window" only
   when the worker's own token says `applied`. A payload without the new fields renders unchanged - the
   consumer invents nothing.

## Actual engine owners after these sessions

| capability | owner that actually runs in production | note |
|---|---|---|
| ASR | Python `faster_whisper 1.2.1` / `ctranslate2 4.9.0`, CPU, int8 | real weights `Systran/faster-whisper-base`, live |
| speech-activity gating | silero VAD `v6` inside the pinned `faster_whisper` package | CPU, project venv, no separate service |
| video frame OCR | **Tesseract** `v5.5.3.20260724`, project-local `.data\tools\tesseract\`, langs `eng, osd` | executed for real on 4 sampled instants; PaddleOCR never ran |
| PDF/Office native reading | Python `pypdf 7.1.0` + stdlib OOXML readers | live |
| primary OCR | **no owner yet - zero pages produced** | PaddleOCR-VL 1.6 is pinned and prepared, never executed |
| artifact writers | **retained TypeScript** | a recorded deviation, not a completed Python migration |
| retrieval | **retained TypeScript** `attachindex` (lexical + hybrid RRF) | Python neural adapters have no production caller |

## Pinned versions and the commands that prepare them

- `.venv`: `faster-whisper 1.2.1`, `ctranslate2 4.9.0`, `onnxruntime 1.32.0`, `pypdf 7.1.0`,
  `pypdfium2 5.6.0/5.15.2`. `.venv-ocr`: `paddleocr 3.6.0`, `paddlepaddle 3.2.1`
  (`compiled_with_cuda False`), `paddlex 3.6.1`, `opencv-contrib 4.10.0.84`, `protobuf 7.36.2`.
  That venv has **no pip**; list it with `uv pip list -p python-backend\.venv-ocr\Scripts\python.exe --format freeze`.
- OCR assets: PaddleOCR-VL-1.6 @ `132c45f5...` (`model.safetensors` 1,917,255,968 B) and PP-DocLayoutV3 @
  `241f8bdf...` (`inference.pdiparams` 130,806,572 B) under `.data\models\ocr\`, each with an
  `asset-manifest.json` holding the pinned commit and per-file sha256.
- Prepare explicitly, never at startup: `python-backend\.venv\Scripts\python.exe -m ruke_ml.models.prepare
  --pipeline PaddleOCR-VL-1.6`, `scripts\prepare-ocr-runtime.ps1`, `scripts\prepare-tesseract-runtime.ps1`.
- Runtimes resolve through `ruke_ml/models/binaries.py::path_for`: ffmpeg
  `node_modules\ffmpeg-static\ffmpeg.exe` (6.1.1-essentials_build), ffprobe
  `node_modules\@ffprobe-installer\win32-x64\ffprobe.exe`, tesseract
  `.data\tools\tesseract\tesseract.exe`.

## Measured resources (measured, not estimated)

- Real ASR job through the production pool: **peak working set 395.0 MiB, peak commit 1,294.0 MiB**,
  simultaneous peak 332.0 MiB over 35 samples, 181.0 MiB resident afterwards,
  `tree_pids_at_job_end: []`, `gpu_violations: null`
  (`logs/e03-speech-20261117T18483297955.json`).
- Real video job: owned child peak **361.0 MiB WS / 1,225.0 MiB commit**, no new GPU compute app
  (`logs/f53-video-evidence.json`, limit 4,768 MiB WS).
- Machine at the F58c checkpoint: RAM 65,299 MiB total, **5,358 MiB free**; commit 100,115 MiB limit,
  **25,175 MiB free**. The dominant consumer is the main LLM: pid 9632 `strata`, **49,656 MiB working set
  / 62,533 MiB private**, i.e. about 90 % of physical RAM. Ruke's own workers are two orders of magnitude
  smaller. The authorized relief, `scripts\strata-low-ram.ps1 --ram-keep-gib <n>`, is still **unapplied**
  because applying it restarts Strata, which is the endpoint this coding session runs on (D-048).
- Still **not measured**: the OCR cold-load and processing peaks, and therefore the 4 GB/5 GB ceiling under
  OCR load. `est_peak_mib 3300` / `est_peak_vram_mib 6000` remain **provisional estimates** and every
  renderer of them now says so.

## Quality results, with live and mocked kept apart

- **Live, real engine:** ASR C1 word error rate **0.0769**; tail word error rate **0.0769 over 13 truth
  words** (it was **0.538** before the window-merge fix, which is why that fix is not cosmetic); the same
  0.0769 tail figure in the video probe, with the speech correctly located at **33.62-38.1 s** and the
  **0-33.883 s silent head not reported as speech**.
- **Live, real engine:** Tesseract read real text off real rasterised frames - `MID-ROLL CARD B 14 s` and
  `quarterly throughput rose 3.5 percent` (`logs/f58b-g36-fixture-fix-1.log`), and earlier
  word-error-rate 0.0 on two pages with `eng` only.
- **Live, real engine, video:** planned 5 / decoded 4 / recognised 3 / glyph-free 1 / unresolved 1, the
  unresolved one reported as `out_of_range` because the 61 s sample is outside the 40 s source.
  `coverage.complete: false` is printed by the probe itself.
- **Mocked / standalone only, therefore not accepted:** neural embedding and cross-encoder rerank mechanics
  (7/7 mechanics, top-1 9/10, MRR 0.950, **two numeric-fact misses kept as failures**), the Rust
  handoff-lease gate scenarios, and every device-plan refusal path.
- **Never executed at all:** the PaddleOCR-VL primary pipeline. Zero pages. The last real attempt failed on
  `Protobuf gencode 7.36.1 / runtime 6.33.4`; the venv now pins 7.36.2, which is a **readiness** fact, not
  evidence that the failure is fixed.

## Fallback cases that actually happened, and what did not

- Happened: a backend signature rejection (`vad_merge_silence_duration_s` -> `TypeError`) is classified,
  recorded in `vad_state`, and the job continues ungated with that stated. Allocation refusals are now
  typed as allocation failures rather than `model_unavailable`. An out-of-range video sample is typed
  `out_of_range` rather than silently dropped.
- Did **not** happen: a Tesseract recovery triggered from inside a production document job. The engine ran
  standalone and for video frames; the primary-to-fallback handover inside a job is still unexecuted, so
  the "release the primary before retrying the unit" law is proven only by unit tests.

## Limitations still standing at this checkpoint

Primary OCR is RED-functional (zero pages). The 5 GB ceiling is unproven under OCR load. The
chat-continuation-after-handoff trace is untraced. Neural retrieval has no production caller and still
loses two numeric-fact cases. Diarization is gated on licence acceptance and not claimed. Artifact writers
stay TypeScript, so their Python-migration status is RED by definition. GPU OCR is unavailable on the
pinned CPU paddle build and on ~2.6 GiB free VRAM. Legacy DOC/PPT conversion does not exist and returns an
honest unsupported result. Browser-side streaming/scroll verification has not been run. The remaining
phrase rules in `detectDeliverableIntent` and the search gate are still live because retiring them needs a
live model-selection run that cannot overlap this coding session. No claim is made that model-led routing
removes all model mistakes or that any OCR quality is universally best.

# F59 - F61 (2026-11-18 ~00:45 -> 2026-11-20 ~13:40) - the OCR resource window made honest, then the records brought up to date

## What changed and why
The blocking question was not "can we install PaddleOCR" but "what is allowed to claim what when the engine
cannot fit". F59 measured that the primary worker dies while reading the recognition weights; F60/F61 moved the
decision **earlier** (before the child exists), gave it **one** owner at every place a death can be observed, and
made the durable-result requirement real. Full reasoning is in SPEC amendment 14 (24.1-24.4) and amendment 15
(25.1-25.5), plus **D-079** and **D-080**.

## Changed files (this range)
- `python-backend/ruke_ml/models/job_limits.py` - two explicit bounded budgets: `EXCLUSIVE_LIMIT_ENV` (:63),
  `SYSTEM_RESERVE_ENV` (:64), `normal_ceiling_bytes()` (:357), `exclusive_ceiling_bytes()` (:371),
  `worker_ceiling_bytes(...)` returning a bounded ceiling **or** a typed refusal with the arithmetic written out.
- `python-backend/ruke_ml/documents/ocr_paddle.py` - ceiling chosen and checked before spawning
  (`per_worker_limit_bytes` :342, `OcrUnavailable("resource_limit", "refusing to spawn: ...", RESOURCE_LIMIT_STEP)`
  :436); one death classifier `classify_worker_death` (:95) at :638/:657/:825; `suspected_under_attached_ceiling`
  (:138); `stats["device_echo"]` (:677) and `stats["dtype_policy"]` (:683).
- `python-backend/ruke_ml/documents/ocr_paddle_worker.py` - allocation-refusal markers aligned with
  `ruke_ml/allocations.py` and handed down by the parent instead of duplicated privately.
- `python-backend/ruke_ml/workers/jobs.py`:87 - `KIND_TO_REASON["resource_limit"] = ("memory_pressure", True, ...)`.
- `python-backend/ruke_ml/documents/ocr_cascade.py` + `python-backend/ruke_ml/handoff.py` - one windowed
  `_operation` body (primary -> per-unit Tesseract recovery -> durable write) shared by the lease path, the
  no-lease path and the CLI; `inside_window` distinct from `inside_handoff`; durable
  `ruke.ocr-result.v1` write/read with resume and a FAILED unit never replayed as an answer.
- `python-backend/tests/test_ocr_resource_window.py` (new, 29 tests) and
  `__tests__/server/extract-document-capability.test.ts` (+1 case) - pin the above without importing the engine.
- Records: SPEC amendment 15, DECISIONS D-079/D-080, TEST-RESULTS F60/F61 rows, MIGRATION-MATRIX and
  DECISION-OWNERSHIP deltas, TASKS F59/F60/F61/F62 blocks, `STATE.md` archived forward, and the dated
  `docs/overnight/HANDOVER-2026-11-20.md`.

## Engine owners and pinned assets (verbatim from the manifests, not from memory)
- OCR runtime: **`python-backend/.venv-ocr`**, Python 3.12.15, prepared by
  `scripts\prepare-ocr-runtime.ps1` (params `-PythonVersion 3.12 -PaddlePaddle 3.2.1 -PaddleOCR 3.6.0
  -Protobuf 7.36.2`; `-ManifestOnly`, `-Probe`, `-Force`). Manifest
  `.data\models\ocr\ocr-runtime.json` records `paddlepaddle==3.2.1` from
  `https://www.paddlepaddle.org.cn/packages/stable/cpu/`, `paddleocr==3.6.0`, `paddlex==3.6.1`,
  `protobuf==7.36.2` (pinned explicitly: the resolver landed on 6.33.4 while `sentencepiece 0.2.3`'s
  `sentencepiece_model_pb2.py` carries gencode 7.36.1, which PaddleX imports while building the VL tokenizer),
  `numpy==2.3.5`, `pillow==12.1.0`, `uv 0.13.0`, `uv_cache_dir = .data/cache/uv`, and the device probe
  `{paddle 3.2.1, compiled_with_cuda false, device cpu}`. The venv has **no pip**; inventory with
  `uv pip list -p <exe> --format freeze`.
- Model assets, pinned by immutable revision (real repository ids, not the display id):
  `PaddlePaddle/PaddleOCR-VL-1.6 @ 132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd` (recognition, 17 files,
  1,930,469,491 B; `model.safetensors` alone = 1,917,255,968 B **bfloat16**) and
  `PaddlePaddle/PP-DocLayoutV3 @ 241f8bdfc77a7c7bee915a5057aaee58c235a8d3` (layout, inference trio,
  `inference.pdiparams` = 130,806,572 B), under `.data\ml-cache\huggingface\hub\...`.
- Fallback: **project-local** Tesseract `v5.5.3.20260724` (leptonica 1.87.0) at
  `.data\tools\tesseract\tesseract.exe`, silently installed project-locally from the UB Mannheim
  `tesseract-ocr-w64-setup-5.5.3.20260724.exe` (26,573,224 B, sha256 `BEE9E343...270AE4` **computed by us**, a
  pin not an upstream digest; `MZ` header checked before running); language data
  `tessdata/eng.traineddata` 15,400,601 B from `tesseract-ocr/tessdata_best` (sha256 `8280AED0...CB66BA`, ours;
  the raw.githubusercontent ETag is **not** a checksum) plus `osd.traineddata` 10,562,727 B from the package.
  **Installed language coverage is eng and osd only** - nothing else is claimed. Verify with
  `scripts\prepare-tesseract-runtime.ps1 -VerifyOnly`, which does a real image-to-text run over a rasterised
  `d1_scanned.pdf` page scored against the d1 answer key.
- Still TypeScript owners, not migrated: the PDF/DOCX/PPTX/XLSX artifact writers (recorded as a scope
  deviation, so their Python-migration status stays RED by definition).

## Measured resource behaviour (definitions stated; unknown stays unknown)
- Host on 2026-11-20: 65,299 MiB physical total, **3,632 MiB free physical**, 26,117 MiB free commit charge.
- Main model engine pid 19400 `strata`: **working set (resident) 49,673 MiB / private (commit) 61,301 MiB**;
  the :8080 listener is pid 20332 `python` at 262 MiB. Capacity **1**, one shared lock, automatic reload on the
  next request - the operator's own console showed the reload cost: 46.84 GiB of experts at 5.75 GiB/s plus a
  777-expert / 1.50 GiB GPU expert-cache refill. **Nothing in this range changed the main LLM's configuration.**
- Ruke's own heaviest measured worker (F58c speech, still the only real worker peak on record): peak working set
  **395.0 MiB**, peak commit **1,294.0 MiB**, simultaneous peak 332.0 MiB over 35 samples, 181.0 MiB resident
  after the jobs, `tree_pids_at_job_end: []`, `gpu_violations: null`, which is that probe's own way of saying zero new GPU allocations were observed.
- **The 4 GB target / 5 GB hard maximum has never been measured under OCR load.** The clamp arithmetic is pinned
  by tests (3,952 MiB effective in the normal window at the current commit headroom; 5,974 MiB minimum viable in
  the exclusive window at the provisional demand), and `est_peak_mib 3300` / `est_peak_vram_mib 6000` remain
  **provisional** estimates carrying their basis token. No number in this report is presented as measured unless
  a named log contains it.

## Live-executed versus mocked, kept separate
- Actually executed for real: Tesseract standalone image-to-text with local paths; the d1 fixtures being real
  files; the OCR cold-load **failure** (`f59-ocr-coldload-1.log`); speech ASR on CPU with VAD; the video probe;
  the pre-spawn resource refusal path's arithmetic.
- Mocked / structural only: the 29 new resource-window tests and the 137-test targeted set (no engine import),
  the TS passthrough tests, the fault-injection hooks. They pin decision structure, not recognition quality.
- **Primary PaddleOCR-VL has recognised zero pages on this host, before and after this range.** No gate in
  SPEC 15 / D1 corpus is passed for the primary engine, and no threshold was loosened to change that.

## Fallback cases, and what they do not prove
- A Tesseract recovery triggered from inside a production document job has **still never run**; the
  "release the primary worker before retrying that unit" rule is proven only by unit tests and by the
  standalone CLI shape.
- Device fallback and engine fallback stay distinct claims: GPU Paddle -> CPU Paddle is a device change
  (unavailable here: `compiled_with_cuda False`, ~2.8 GiB free VRAM against 9,256 MiB wanted), and
  Paddle -> Tesseract is an engine change that must disclose reduced layout/formula fidelity.
- `needs_language` is a typed refusal, not a silent English default (`workers/document_jobs.py`:161-166 names
  `RUKE_DOCUMENT_OCR_LANGUAGE`), and the installed Tesseract language set is eng + osd, reported live.

## Limitations standing at this checkpoint (unchanged unless stated)
Primary OCR zero pages; the memory ceiling unproven under OCR load; the OCR-window `est_peak_*` provisional;
enforcement parity for tesseract/ffmpeg/frame-OCR open (classification shared, OS ceiling not); the
chat-continuation-after-handoff trace never run end to end; neural embed/rerank with no production caller and
two numeric-fact failures kept; diarization gated on licence acceptance; artifact writers retained TypeScript;
legacy DOC/PPT unsupported by design; live-model routing checks and every browser gate held behind capacity 1 and
the shared Playwright lock.

## Shutdown status
No shutdown was issued in F59-F62. The earlier end-of-run shutdown authorization was **superseded** by the user's
later instruction ("I will be monitoring if something goes wrong complete 100 %"), and the attended OCR/handoff
gates that remain need the user at the screen. So the run ends with the records saved, the owned jobs drained and
the owned locks released, and **no OS shutdown requested**. Nothing was forced, retried or bypassed.

## F66 addendum (2026-11-20 ~23:15) - one sentence in the Limitations above is now superseded; the rest stands
"neural embed/rerank with no production caller" was stale for the **rerank** half at the time it was written
(the caller has existed since D-058) and stopped being stale-as-a-report at F66: the chain
`turn.ts -> rerank.ts -> mlJob -> POST /api/ruke/ml/job -> supervisor -> nn_rerank worker` was **executed
end-to-end on the live tree** with the supervisor tree's peak RSS recorded (36 -> 204 MiB working set,
`logs/f66-rss.json`), pinned identity, warm-repeat determinism and a typed-refusal envelope verified
(`__tests__/server/attach-rerank-live-route.test.ts`, env-gated, 5/5 green; details in TASKS F66,
MIGRATION-MATRIX + DECISION-OWNERSHIP F66 deltas, D-082). **What did not change in this addendum:** the two
numeric-fact misses stay failures (now pinned by a characterization that fails on purpose if the ranking ever
flips); quality acceptance is still NOT passed (g05 tie-not-beat, English-only); the `nn_embed` Python adapter
was still never wired - TS `attachindex/embed.ts` remains the production owner, reported alongside the
retained-TS artifact writers; and every other line of the Limitations paragraph above stands unless a dated
TASKS/STATE entry supersedes it.

# F62 - F71 (2026-11-20 ~13:40 -> 2026-11-21 ~01:10) - the 2026-11-20 handover mandate, closed as far as unattended work reaches

Four states kept separate below, as the mandate requires. Nothing blocked was scored as passed.
No commit/push/stash/reset/clean/PC-shutdown was performed in this range (git stayed read-only);
`docs/overnight/TASKS.md` F62-F71 blocks and `STATE.md` carry the per-step evidence with exact logs.

## A. Implemented (code exists, contracts pinned)
- **Engine-level OCR scorer** `docs/overnight/probes/d1_engine_scoring_probe.py` (F63): 17-control
  self-check **broken 0**; answer-key text and fixture rules kept out of production code (mandate law).
- **Typed pre-spawn resource admission for the exclusive OCR window** (F63/F64): `resource_limit` refused
  BEFORE spawning with measured free-commit math (D-079/D-080 windows), and the handoff lease seam
  (`lib/server/coordination/llm-lease.ts` 512-byte record <-> `admission.rs`/`ml_job.rs` <->
  `handoff.py`/`ocr_cascade.py`) implemented for post-handoff chat continuation (F64, item 5a).
- **D-070 fence-catalogue gap closed** (F65, item 5b): always-on compact `<fence_catalogue>` injected as the
  ONLY standard_chat block in BOTH runtimes (`contracts.ts:112` sha d4f2910b.../1309 B byte-pinned;
  `pipeline.rs` mirror; nameless core-tier anchor; retired fences named honestly). Knowledge, never keyword
  rules (mandate: "do not fix individual examples by adding phrases").
- **Rerank production caller verified end-to-end** (F66, item 5c; F66 addendum above): chain executed on the
  live tree, peak RSS recorded 204 MiB; `nn_embed` stays honestly unwired (TS `embed.ts` is the owner);
  rerank quality acceptance is still NOT passed and the characterization keeps that.
- **SETUP.md portability claim re-scoped** (F70): the only code-adjacent fix of four audits.

## B. Exercised through production paths (executed, with artifacts)
- The resource refusal observed in a REAL OCR window attempt (`logs/f63-ocr-window-1.log`), not a mock.
- Golden cross-runtime replay chain re-recorded under sanction then RE-EXECUTED: TS re-records, Rust replays
  agree (chat/skills/attachments/web/errors + `scrubber_vectors` 3/3 + `fixture_replay` js_len 12077 pin).
- F71 four gates on final source (see D).
- Honesty token chains re-executed where they had suites: diarization refusal 70 py + 31 TS (F68),
  splitter parity 70 TS + 39 Rust (F69), follow/progress 46 TS (F69), artifact reopen 4/4 inside the
  standing vitest gate (F67), `contracts:check` OK (f70).

## C. Audited CLEAN with zero changes (mandate: audits, not patches)
F67 artifacts (TS-only writers are the honest truth BY CONSTRUCTION: `revision="not-migrated"` rows + typed
refusals; reopen parity green; viewers lazy + no live WebGL renderer); F68 ASR/align/diarization honesty
(licence-first blocker order is the anti-lie mechanism; alignment never invents word timing); F69
streaming/reasoning/activity/scroll (parser structural exclusivity, single-authority activity resolver,
pure-reducer scroll follow with programmatic-pin tagging, rAF-batched deltas + memoized messages all intact);
F70 fresh-clone portability (1,660 tracked files, ZERO tracked weights, lockfiles + `.python-version`
committed, gitignore + LF-pinned golden corpus verified, no machine-local paths, every undeclared env var
has a code default; no physical clone-install run - a HEAD-only clone lacks the 588 pending tree entries,
honestly stated).

## D. Acceptance passed (offline acceptance gates, final source, F71)
Vitest **196 files passed / 3 skipped (199), 2,535 tests / 24 skipped (2,559)** `logs/f71-vitest-full-2.log`;
python discover **532 OK** `logs/f71-py-discover-1.log`; cargo full workspace **27 binaries all ok, 739
passed / 0 failed** `logs/f71-rust-test-1.log`; **tsc exit 0** `logs/f71-tsc-1.log`;
`contracts:check` OK `logs/f70-contracts-check-1.log`. Thresholds untouched. The FIRST capture
(`f71-vitest-full-1.log`) FAILED 3 tests in 2 files - real catches: `lazyLoad.test.ts` +
`chatEngine.test.ts` still asserted the PRE-D-070 "standard_chat injects zero blocks" law; repaired to the
F65-precedent shape (block exists, catalogue ONLY, no skill/contract; verbatim-user + active_skill-zero +
browser-zero assertions kept intact), targeted-proven `logs/f71-vitest-d070fix-1.log`, then the green
full run. No test was disabled, deleted or weakened.

## E. BLOCKED - each with observed reason and the smallest clearing action
1. **Primary PaddleOCR acceptance** - engine has recognised ZERO pages, ever: CPU worker dies (exit None)
   reading `model.safetensors` under the 3,814 MiB job-object floor; `device_plan` fits:false; GPU pinned
   CPU-only (`compiled_with_cuda False`). **Clear:** the attended sequence in STATE "The blocker that is not
   a code gap", as the session's LAST action, operator watching.
2. **OCR cold-load PEAK measurement** - same memory floor; decision half done, peak unmeasured.
   **Clear:** RSS sampling inside the same attended exclusive window; registry stays "provisional"-labelled
   until then.
3. **Item-3 live PDF flow** (one streamed answer, no second click, no duplicate) - needs the browser pass
   that can contact :8080-adjacent flows; :8080 hosts THIS coding session (capacity-1).
   **Clear:** final Playwright pass via the exclusive launcher in the attended window (no lock held now).
4. **Chat-continuation-after-handoff, live half** - the handoff literally unloads the model this session
   runs on. **Clear:** same attended window (seam itself implemented + tested at F64).
5. **Fence-selection live proof** (does the catalogue make prose-where-fence-fits emit a catalogue fence) -
   live-model run; until it passes, `detectDeliverableIntent` + `search-gate.ts` phrase rules stay live as
   designed. **Clear:** one live-model-selection pass in the attended window.
6. **Frozen video temporal gate** - CORRECTED 2026-11-21 (F75): the `ffmpeg_not_installed` blocker is
   OBSOLETE. ffmpeg/ffprobe resolve project-locally through `ruke_ml/models/binaries.py::path_for`
   (`node_modules\ffmpeg-static\ffmpeg.exe` 6.1.1, `@ffprobe-installer` ffprobe - rows in section above
   already stated this; this row contradicted them). The f53 evidence probe re-ran green on the current
   tree: synthetic clip built via project-local ffmpeg, frame-OCR + evidence checks executed through the
   REAL worker pool, "all checks passed" (`logs/f75-f53-video-rerun.log`, `logs/f53-video-evidence.json`;
   honest scope note preserved: frame OCR reads visible text only, the synthetic clip measures decode
   clocks/timestamp parsing/cut scheduling, not semantic event understanding). What REMAINS open here is
   only the frozen gate's other precondition: a human-labelled real video.
   **Clear:** human-labelled clip (the ffmpeg precondition is cleared).
7. **Diarization** - `license_acceptance_required` refused by design at both entry points; the refusal IS
   the tested behaviour. **Clear:** human accepts pyannote terms, sets `HF_TOKEN`.
8. **GPU support** - stays **unverified** while the pinned stack is CPU-only (mandate law); no action on
   this host beyond honest reporting.

## F. Run-state facts
No commits this range (HEAD stayed `abc988c`; the user's constraint forbade commits). Working tree preserved
whole; the user's commit sweep should exclude root debris `a.txt`, `lock-out.txt`, `mcp-out/` (flagged at
F70, not deleted). Zero requests were issued to :8080 for the entire range. No `RUKE_*` handoff/OCR switch
was set unattended. PC left on per the current overnight scope; the shutdown call stays the user's.
Harness laws stored in STATE.md: bare `cmd /c` under MSYS bash exits 0 VACUOUSLY (`cmd //c` is mandatory);
the full-suite gate itself exposed the two stale-premise files - the suite doing its job, not a regression.
One blocked cleanup: an empty scratch file `D:\overnight-placeholder-check` (a mistyped redirect in this
segment) could NOT be deleted - `rm` is blocked by the current permission policy - flagged here for the
user's sweep; it is empty and harmless.

# F72 - F75c (2026-11-21 ~01:10 -> ~05:05) - OCR measured at engine AND production level; six root-cause fixes; the same answer re-proved on regenerated fixtures; final gates + exclusive Playwright loop green

Detail lives in TASKS.md F73/F74/F75 (+addenda, F75b, F75c); this is the state table. Nothing in the frozen
acceptance matrix (answer-key `d1-ocr-1`, sha256 `2a82713e...156b6e`, thresholds, scorer, probes) was weakened
anywhere in this range - page-5 stays a recorded miss, the numeric-fact pair stays a kept characterization.

## A. Implemented and fixed (every one RED-first, frozen contracts untouched)
1. OCR operation-accounting drift - the CLI reported `persisted_path ""` for a run whose unit WAS persisted
   (`ocr_cascade.py`; one shared `_account()` on both lifecycles).
2. Persist-before-attribution - every durable record declared `coverage.read 0` / `engines_used []`; records now
   derive read + engines from the units the write is about. Live proof: `read:1`, engines
   `['tesseract v5.5.3.20260724']`.
3. Fixture honesty - `d1_scanned` page-6 raster physically ended MID-SENTENCE at "rupees with" (a 152-char
   LATE_FACT was never wrapped); the key demanded text the image never contained. `_wrap` added to the generator;
   PAGE_TEXTS and the ANSWER KEY untouched; regenerated fixtures verify the key BYTE-IDENTICAL.
4. Rotation applied twice - pypdfium2 `render(rotation=)` is ADDITIVE over the page's own /Rotate; /Rotate 90
   pages came out 180 degrees (upside-down garbage in production, correct via CLI - the discriminator that found
   it). Fixed in `ocr_tesseract.render_page_png`; signature and the honest `info["rotation"]` unchanged.
5. Heading-only text layer killed OCR eligibility - d1_mixed p1 (heading + raster body) was marked fully read and
   the imagery never reached OCR. Such pages are now recorded read AND stay OCR-eligible (two-flag honesty).
6. TS second-reader dropped the OCR body - the variant search re-printed pdf.js's own text layer. Now prefers the
   `provenance == "ocr"` unit and drops already-delivered lines.
7. 422 DELIVERY gap - a refusal carries ONLY `{error}`, so the needsLanguage clause could never reach a user. The
   product refusal itself now names the switch ("OCR needs an explicit language (set RUKE_DOCUMENT_OCR_LANGUAGE)
   ..."); a vitest delivery pin was added; the frozen no_language case went 0/4 -> 2/4 -> 4/4 IN PRODUCTION (f74h).
8. The declared-language path was silently fake on BOTH sides: fixtures wrote `/Lang` on /Pages (a Catalog entry
   per ISO 32000-1 s14.3.1 - spec readers never see it), and `pdf.py` never read the Catalog /Lang at all (must be
   read INSIDE the open-file `with` - pypdf lazy indirection). Both fixed; the declared path now reports language
   `en-US` named "declared by the document (/Lang)".
9. Harness scalar-string bug (`g60/g61`: `.Split | ForEach` on a scalar yields characters, so single-action boots
   never applied per-pass env) - fixed with `@(...)`; the honest consequence (f74e/f74f vacuous, f74c/f74d
   mislabeled as crash/primary injection) is recorded as RELABELS, not buried.
10. Retrieval numeric-fact UNSEEN pair (new env-gated characterization test): two candidates identical except the
    number score 0.9999770 vs 0.9999740 on the pinned engine (margin 2.98e-06) - ordering inside the pair is
    noise, so the route's contract is SCORE-BOTH + KEEP-BOTH (the conflict is surfaced to the answer stage, never
    dropped). The authoring confound (the first draft varied wording too) and the corrected 4-decimal misread are
    documented in-test.
11. FINAL-REPORT ffmpeg/ffprobe blocker row corrected (it was stale and contradicted section B); the f53 re-run
    proves the correction.
12. Safety: the language pin test now FORCES `RUKE_OCR_ALLOW_UNLOAD=0` + `RUKE_LLM_AUTOMATIC_HANDOFF=0`. An
    ad-hoc unguarded dispatch unloaded/restored the coding endpoint mid-turn (recorded incident; self-restored;
    aftermath clean - no lock, no journal left).

## B. Exercised through production (executed; artifacts in docs/overnight/logs)
- D1 four passes, production HTTP path, REGENERATED fixtures, UNCHANGED key (f74i): d1_native 8/8, d1_scanned
  14/16 (both misses = the same honest page-5 equation-line miss, WER 0.471 vs the frozen 0.10), d1_mixed 8/8,
  d1_rotated 5/5. The engine-level scorer 20/22 with its self-check 17/17 controls unbroken.
- ANSWER PASS re-proved on current source + regenerated bytes (f74i answer boot): scanned upload -> real OCR
  (6/6 pages, per-engine {tesseract v5.5.3.20260724: 6}) -> ONE streamed answer (finish=stop, single terminal)
  with the exact late fact "4,18,25,000" + "within ninety days" + page-6 attribution + an honest OCR caveat.
- no_language refusal 4/4 in production (422 in 0.96 s naming the switch); f74j key-sanctioned `not-registered`
  primary trigger 15/17 on BOTH fallback passes (same page-5 miss vs the fallback 0.15 limit; per-unit engine
  reporting + unresolved-stay-unresolved + the reduced-fidelity note all PASS).
- Video evidence probe on the current tree: the fixture was built through PROJECT-LOCAL ffmpeg
  (`models.binaries.path_for`), frame-OCR + evidence checks ran through the real WorkerPool, all checks passed;
  honest accounting (planned 5 / decoded 4 / recognised 3 / glyph-free 1 / unresolved [61.0 out_of_range]).
- Retrieval production route: 6/6 live tests through the scoped g58 topology (turn.ts composition -> Rust
  `POST /api/ruke/ml/job` -> supervisor -> the pinned MiniLM worker; pinned id/revision/provider + CPU verified;
  supervisor 7x POST /job 200 + 1x 552 for the typed refusal; peak 207 MiB WS / 161 MiB commit).
- The FULL handoff lifecycle was observed end-to-end exactly once (the recorded incident): acquire lease ->
  unload main model -> launch primary -> resource_limit -> tesseract recovery for all 6 units -> RESTORE main
  model -> release. It works; it must only ever run in an attended exclusive window.

## C. Final standing gates on the final tree (run once, F75b)
tsc --noEmit exit 0; full vitest 2,537 passed / 25 skipped / 196 files exit 0; cargo 739 passed; python
`discover -s tests -t .` 539 OK. (+1/+1 vs the F71 baseline = the F75 delivery-pin case and the env-gated live
route file.)

## D. Exclusive Playwright final loop (scoped, F75c - lock created/held/removed by this run; teardown DONE: ports 3000/3101/3210 down, zero repo-path chromium)
- chat-stream + decision-routing + search-gate + greeting: 9/9 (one search-gate live-fact flake = an EXTERNAL
  google 429 wall + a 141 s read_page stall; green on targeted rerun; no product change).
- file-reading: 215/215 green - every layer-1 extraction check AND every layer-2 model turn, all fixture families
  including pdf/docx/pptx/odf/epub/rtf/ipynb/legacy .doc/.xls/.ppt/mat/archives/12 image types/6 audio containers
  (wav transcription 41 s)/7 video containers/xlsx+xlsm.
- long-doc-retrieval 3/3; pdf-egress 1/1 (the egress-fixture server on :3210 is a launcher prerequisite - this
  scoped loop initially missed it; with it up, green in 5.8 s).
- regression_modalities: honest skip (needs scripts/e2e-llm-proxy.mjs; the prerequisite was respected).
- Harness law recorded: an exit-143 foreground kill can leave the playwright tree RUNNING - the orphan wrote its
  own full summary AFTER the wrapper died; all 60 apparent failures were worker kill-cascade artifacts
  (0xC0000002) and every one of them was rerun green; mtime forensics confirmed my browser sweep postdated the
  orphan's completion.

## E. BLOCKED / still awaiting a live run - observed reason + smallest clearing action
1. First genuine PaddleOCR-VL primary page. Observed: the launch dies at kernel-job peak commit 7,812 MiB vs the
   6,675 MiB ceiling WITH the main model resident (incident); pre-spawn, the provisional 3,300 MiB estimate
   charges 5,190 MiB + 1,024 margin = 6.26 GB vs the normal 5.0 GB ceiling - the normal window can NEVER admit
   it. Smallest action: an attended exclusive window (coding endpoint idle):
   `run-ocr-acceptance.ps1 -StartDev -Pass content -AllowUnload -ConfirmUnload` - AFTER fixing E4, since that
   runner currently boots fault passes vacuously.
2. TRUE crash injection (`RUKE_OCR_FAULT=crash`). Observed: injection requires an admitted registered primary
   producing results; under the unattended safety switches the primary is never admitted, so there is nothing to
   crash. Smallest action: the same attended window as E1.
3. Real-video frozen gate. Observed: the pipeline is production-real (f53 green, project-local ffmpeg); the
   frozen temporal gate's precondition is a HUMAN-LABELLED real upload. Smallest action: the user supplies one
   real video with human-checked early/middle/late timestamps plus one speech-only and one frame-only fact; run
   the f53-form probe against it.
4. `run-ocr-acceptance.ps1 -StartDev` fault-env gap (open). Observed: it never sets `RUKE_OCR_FAULT` /
   `RUKE_OCR_PRIMARY` / language per pass, so fault passes through the authoritative runner run VACUOUSLY (proved
   by the f74e/f74f relabel). Smallest action: port the g61 `@(...)` per-lead env application into the runner;
   single-action boots.
5. Browser-level scanned-page journey. Observed: the scanned answer is proven at production HTTP+stream level
   (f74i probe), and the browser file-upload journey is green for native-text pdf; the scanned-OCR journey IN the
   browser was not part of the final loop (it needs an OCR-enabled dev boot + the D1 upload in the UI). Smallest
   action: one Playwright journey folding the f73_scanned_answer_probe flow into the real upload UI, in a window
   that boots dev with the safety switches.
6. Reload/reattach + in-flight-bubble observation. During the 141 s external stall the main area showed no
   in-flight assistant bubble (the snapshot had the step header, only the user paragraph in main). Consistent with
   the attended chat-continuation proof; NOT established as a regression. Smallest action: one attended look at
   that state (long-stall turn + reload).
7. Fresh-clone portability + offline startup: NOT RUN this segment (a multi-hour dependency rebuild past the
   >5 h wrap-up rule; partial artifacts exist from earlier segments). Exact commands for the next window:
   robocopy the source (exclude node_modules, .next, .data, rust-backend/target, python-backend/.venv*) to a
   DIFFERENT path; in the copy: `npm ci`; create the python-backend venv from the pinned requirements only (no
   weights/caches copied); `cargo build` in rust-backend; `npm run dev`; smoke chat + one upload + one
   attach-index turn; offline startup = the same `npm run dev` with networking disabled (partial truth already
   observed: the dev supervisor tolerates a dead python supervisor - the "chat continues" line in the dev log -
   and capability endpoints report typed not_installed).
8. Embedders: no production caller (D-046 owner decision, reconfirmed F66/F75) - stays the honest half.
9. regression_modalities live-modality suite needs `node scripts/e2e-llm-proxy.mjs` running; the next loop starts
   it first or keeps the honest skip.

Run-hygiene flags for the user's sweep: root debris `a.txt`, `lock-out.txt`, `mcp-out/`,
`D:\overnight-placeholder-check` (the rm policy blocked deletion; empty), plus .data/tmp scratch (g5x/g58/g60-
g67, f74-prod-*, pin-discrim*, f75-flist.txt, the f72-f75c report section file itself), test-results/, and three
historical "RTX 5090 Price in India" chats created by search tests. The regenerated D1 fixture bytes
(docs/overnight/fixtures/d1/pdfs/*.pdf + ocr_docs.py) MUST be included in the user's eventual commit sweep - the
answer key they verify is byte-identical. The ghidra MCP server is ECONNREFUSED (a connection failure, not
unconfigured) - no work this run depended on it. No commits were made; the working tree carries all changes
uncommitted per the mandate.

## F. The five brief questions (current answer)
1. Can I upload a scanned PDF today and get a correct page-grounded answer? YES at production level: f74i proved
   scanned upload -> real OCR -> one streamed answer with the exact late fact, page-6 attribution and an honest
   caveat, on current source and regenerated fixtures; the frozen matrix scores 14/16 with the equation page an
   honest recorded miss (the primary engine's own target). Quality today comes from the tesseract RECOVERY engine
   (the primary is still blocked, E1); the same journey inside the browser UI awaits one scoped run (E5).
2. Can I upload a real video today and get a correct timestamp-grounded answer? PIPELINE YES, frozen acceptance
   PARTIAL: decode/sample/OCR/timestamp evidence runs production-real through project-local ffmpeg + WorkerPool
   (f53 green on this tree, honest accounting); the frozen gate additionally needs the user's human-labelled real
   upload (E3).
3. Which capabilities now run through Python in production? documents.parse (pypdf per-page outcomes + the OCR
   cascade, tesseract live; declared/undeclared language contracts live), retrieval rerank (D-058 default ON, the
   production route live-executed incl. refusal semantics), media decode/sample/transcribe (ffmpeg/ffprobe
   project-local; audio transcription green), resource admission + worker lifecycle (supervisor, commit ceilings).
   NOT Python: the artifact writers stay TS (a recorded deviation); embedders have no production caller; the
   PaddleOCR-VL primary is registered but only admitted in exclusive windows.
4. Which checks still fail or await a live run? Nothing fails on the final tree offline (gates + loops green).
   Awaiting live: E1 primary first page, E2 crash injection, E3 human-labelled video, E5 the browser scanned
   journey, E6 the stall/reattach observation, E7 fresh-clone portability + full offline startup. Watch-list: the
   search-gate external wall flaked once (green on rerun).
5. For every remaining blocker, what was observed and what is the smallest clearing action? Section E rows 1-9,
   each with its observed evidence and the single smallest action.

# F76 (2026-11-21 ~09:00 -> ~14:15 Asia/Calcutta) - takeover validation+repair run: two live-UI defects fixed and acceptance-closed, migration + failure handling re-proved, four gates + 227/0 exclusive Playwright on the final tree

## Verdict (everyday use first)
- **PDF numbers (the user's defect): usable; defect class closed at delivery-contract level; residual model
  slip-rate honestly measured.** Upload a grouped-figure PDF and ask for a restatement: extraction was already
  verbatim-exact; the 10x restatement defect lived at the ANSWER stage. The universal numeric-fidelity law shipped
  on all three delivery surfaces; the frozen 6-case probe suite scored **6/6 twice consecutively** (closure pair),
  and a brand-new held-out UI fixture (`9,34,72,150`, in no prior fixture, answer key or prompt) passed the real
  chat UI first-try. Honest residual: law-on model compliance is **51/54 case samples** across nine live runs -
  3 genuine defects kept failing instead of being papered over; for value-critical documents a quick human check
  of the restated line is still the safe practice.
- **PDF reading generally (scanned/native, page-grounded answers): YES** (F72-F75c production-level proof stands;
  F76 re-ran the extraction paths on the final tree: 109/109 extraction/skip rows; the native-text fixture read
  verbatim through the live extract route).
- **Video (the user's defect): closed.** The unfounded "visible throughout" claim was a DELIVERY-CONTRACT gap
  (two sampled instants, no gap statement); VIDEO_MOMENTS_LAW shipped on all surfaces; the gap-clip probe flipped
  from 2x-repro to 3-consecutive-correct + control-run PASS (no over-correction); the 7 video UI journeys are
  green in the final Playwright stage. Long-course retrieval journeys green (3/3, deep marker pinned both turns).
- **No commits** were made; everything rides the uncommitted `local` tree per the mandate.

## Defect 1 - PDF figure restated 10x (user saw 4,18,25,000 as 418,250,000 / "41.825 crore")
- **Repro:** the d1 document through the real UI / probe (cases A/B), reproduced live; extraction evidence was
  verified exact first, so the first wrong component is the model answer stage.
- **Root cause:** no numeric-fidelity requirement in the delivery contract - `lib/chat/client.ts` (the inline-
  attachment branch of `attachmentParts`), the `rules()` base in `lib/server/attachindex/turn.ts`, and the
  `concat!` law block in `rust-backend/crates/ruke-attach/src/turn.rs` all lacked it; the model then re-grouped
  and rescaled freely. The run-7 answer also proved that self-verification text alone cannot force real
  arithmetic: "Check: 41.825 x 10^7 = 41,825,000 (checkmark)" is arithmetically FALSE - digit-run string-matching,
  not computation.
- **Fix (universal):** NUMERIC_FIDELITY_LAW, byte-identical on all three surfaces (scratch g74 proves equality
  incl. the probe mirror; goldens + `rules_variant_boundaries_are_exact` pin TS<->Rust). The v2 sentence "This
  applies to every restated version anywhere in the answer, including brief asides." was added after two
  independent live aside incidents. No currency, unit, value or fixture string in production code or prompts.
  Deployment note: the running :3101 binary predates the rules() text - it activates at the NEXT ruke-server
  start (the running one was never killed).
- **Regression:** frozen model-free answer key `docs/overnight/fixtures/f76/numeric-answer-key.json`
  (`f76-numeric-8`) + the value-auditing scorer (v2->v8; every relaxation pinned KEEP-FAILING; selftest 16/16
  pass + 20/20 fail) + nine live probe runs (closure pair runs 8+9 both 6/6) + the law-presence vitest pin +
  the new UI journey `tests/numeric-fidelity-ui.spec.ts` (held-out amount, generic arithmetic audit mirroring
  the scorer, every attempt audited standalone). Scoreboard: 4/6, 5/6, 3/6, 5/6, 4/6, 5/6, 5/6, 6/6, 6/6.
- **Recommended hardening (NOT implemented this run):** a deterministic server-side post-answer numeric guard -
  re-check every restated scale-word figure against the extracted evidence before delivery. Not done because it
  touches the streaming path; the law + audits measurably reduce but cannot eliminate the measured residual.

## Defect 2 - video "visible throughout 0:00-0:06" unfounded (found earlier this run; closed here by re-verification)
- **Repro:** gap-clip fixture (marker present at BOTH sampled instants, absent mid-clip) failed live twice with
  exactly the user's failure shape.
- **Root cause:** delivery contract, not extraction: the two preview instants (20%/70% sampling in the ffmpeg
  step) ride as `image_url` parts with zero gap statement on all three surfaces; the frames-only `coverageNote`
  even invited generalizing "at a given time".
- **Fix (universal):** `VIDEO_MOMENTS_LAW` on both client.ts video shapes + a byte-identical retrieval lead-in
  (TS/Rust); the coverageNote invitation replaced.
- **Regression:** law-presence vitest pin (content-neutral), re-recorded goldens + Rust replay 6/6, live loop 3x
  ideal + control PASS, and this run's final Playwright stage: the 7 video UI journeys green (C2 chunk, 25/25).

## Migration + generalization (workstreams 3-4) - executed evidence
- Failure-handling spot-checks mapped to owning tests and RUN: **206 OK / 0 failed** across the seven owning
  files (cancellation stays distinct from empty success; absent, unreadable and malformed stay three different
  answers; missing engine = typed configuration problem, never a zero vector; ceiling-killed worker =
  `resource_limit`, not engine fault; one-retry discipline; a cancelled job starts no recovery; unresolved or
  partial units never become answers). Log `.data/tmp/f76-py-failurefamily.log`; full discover 539 OK.
- Generalization: the opposite-intent pair (convert vs quote-only on one document) lived in all 9 runs; held-out
  material at probe AND UI level; audits are value-arithmetic at both levels, never phrase matchers; production
  law texts carry zero fixture strings (byte-identity + content-neutral pins). No phrase matcher was added to
  production routing or prompts anywhere this run.

## Gates + UI stage on the FINAL tree (exact rows in TEST-RESULTS.md "Session F76 rows")
vitest 2,539 passed / 25 skipped (196+3 files, exit 0) - python discover 539 OK skipped=2 - cargo workspace
739 passed / 0 failed - `contracts:check` OK (standard_chat sha d4f2910b833ecf05..., html_render sha
1eee54fa63cde6c0...) - tsc exit 0 x2 - nine exclusive Playwright runs **227 passed / 0 failed** incl. both
defect journeys; lock protocol clean, zero orphans, every :3210 fixture server started+stopped by the launcher.
The first cargo attempt's log is a known target-dir lock-contention artifact and is quarantined from citation.
Nothing owned by this run is left running; :3000/:3101/:8080 (pids 20220/6672/15232) untouched; PC left on per
project instruction.

## One consolidated list: what still needs the exclusive Strata window (capacity-1; the coding session lives there)
Prerequisite code fix first (no Strata needed): the `run-ocr-acceptance.ps1` per-pass fault-env gap (F75c
section E row 4 - port the g61 `@(...)` pattern, single-action boots).
1. First genuine PaddleOCR-VL primary page (still ZERO ever) + the measured `est_peak_*` registry values it
   produces + the cold-load peak measurement - one window:
   `run-ocr-acceptance.ps1 -StartDev -Pass content -AllowUnload -ConfirmUnload`.
2. True crash injection (`RUKE_OCR_FAULT=crash`) - needs an admitted primary; same window.
3. Workstream 5, memory + Strata handoff lifecycle for heavy workers (BLOCKED-attended): automatic-unload
   acceptance + post-handoff chat continuation live trace (seams traced at F64; the F75 incident proved manual
   unload/reload, the automatic path is unimplemented).
4. Fence-catalogue "model actually picks the right fence" live proof + the `detectDeliverableIntent` /
   search-gate phrase-rule replacement decision (live-model selection evidence).
5. Rerank QUALITY acceptance (mechanics already live-executed; quality acceptance was explicitly NOT claimed).
6. If the post-answer numeric guard is later implemented: its live end-to-end proof rides this window too.
Nearby attended items that do NOT need the Strata swap (kept from F72-F75c section E): human-labelled real video
for the frozen temporal gate (E3); the browser scanned-OCR journey with an OCR-enabled boot (E5); the
reload/reattach in-flight-bubble look during a long stall (E6); fresh-clone portability + offline startup (E7,
multi-hour); `regression_modalities` with `scripts/e2e-llm-proxy.mjs` up (E9); embedder quality half-metrics
still have no production caller (E8).

## What this F76 report does not claim
No OCR-quality claim for the primary engine (still zero pages). No claim that numeric fidelity is guaranteed -
it is a shipped delivery law with measured 51/54 live compliance, pinned audits and a named guard
recommendation. No invented percentages: every fraction above is an exact executed count. No claim that any
attended item passed. The F75c "9 chat tests" figure was a different tree's count - the current tree has 6;
only current-tree numbers are claimed here.
