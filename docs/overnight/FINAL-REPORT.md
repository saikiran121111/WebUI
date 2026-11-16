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
| ending branch / HEAD | `local` / `002b9692b10a3d927933a8514a2245bcf8969001` - **nothing committed, staged, pushed or reset**, per instruction |
| original audit baseline | `ec256bd726f5dda15e3af9fc3fa3d3d7fa47e3a6` |
| prior implementation commit | `face1f76dca7d34f153f7880e0240c5e8325073c` |
| work-tree status at the FINAL audit (after P10 cleanup, session 61) | **192** porcelain entries = 133 modified tracked + 1 ` D` (the renamed fixture pair) + 58 untracked entries, **441 files when expanded with `-uall`** |
| tracked diff size | `git diff --shortstat` -> **134 files changed, 11764 insertions(+), 2889 deletions(-)** |
| staged | **0** (`git diff --cached --stat` empty) |

Dirty-file handling:
- Everything dirty is this run's own work. No unrelated user work existed or was touched.
  No `reset`, `stash`, `checkout --`, `clean`, `commit` or `push` was ever run.
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
  was committed because nothing was committed.
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
