# Ruke: overnight harness repair and Python document/media migration

Use this entire file as one Claude Code implementation prompt. It replaces the older audit and migration prompts; do not apply their conflicting instructions separately.

## 1. Assignment and boundaries

You are working in my existing Ruke repository, normally `D:\Projects\WebUI\WebUI`, on the **current local branch**. The inspected HEAD was `ec256bd726f5dda15e3af9fc3fa3d3d7fa47e3a6`. Verify the actual checkout, working tree, instructions, and reachable runtime paths before editing. Do not switch to `develop` because an older migration plan named it. Preserve my uncommitted work. Do not push, publish, reset, or discard it.

Implement and validate the repairs and migration in this prompt. This is not a request for another architecture proposal. Work in small coherent increments: inspect → reproduce → fix the mechanism → compile → test → inspect the result. Avoid long speculative planning and repeated narration. Do not reduce implementation quality to finish faster.

The coding model is my Qwen 3.8 Flash Next through Strata. Ruke and Claude Code share the same inference endpoint, which supports **one concurrent inference request**. Do not change the model or its server configuration casually. Do not add another always-loaded router LLM. Verify the actual configured model identifier instead of inventing one from its display name.

Keep Next.js for the UI and Rust for chat transport, state, authorization, scheduling and process ownership. Keep working TypeScript web-search adapters and artifact engines where they remain appropriate. Add Python for document/media parsing, OCR, speech, embeddings and reranking where measured quality warrants it. Python is an implementation choice, not a guarantee of quality.

Interactive browser feature development is deferred. Preserve its existing security and contracts. Headless document rendering and Playwright testing of the chat/file UI remain in scope. Preserve installed skill bodies and hidden/user skill isolation; make routing and contract changes in application-owned code and metadata, not downloaded `SKILL.md` files.

This is an unattended overnight run. Do not ask questions or wait for routine confirmation. Choose reversible, documented defaults. Resolve recoverable failures and continue independent work. If a capability genuinely needs a human credential, license acceptance, unavailable hardware, or authority you do not have, record it as blocked; never invent a token, accept terms for me, bypass access controls, or claim a skipped test passed. Finish all feasible independent work, write the final report, then perform the Windows shutdown in section 12. My instruction to record blockers and shut down supersedes an older repository instruction to stop and ask after a lock timeout.

The goal is broad generalization with explicit uncertainty. **Never claim that a finite run proves zero bugs, zero quality loss, or zero overfitting for every future request.** Do not solve the examples below by adding their words, entities, sites, numbers, or languages to production exception lists.

## 2. Mandatory persistent task state

Before edits, create or resume these application documentation files:

```text
docs/overnight/STATE.md
docs/overnight/TASKS.md
docs/overnight/FINDINGS.md
docs/overnight/DECISIONS.md
docs/overnight/TEST-RESULTS.md
docs/overnight/FINAL-REPORT.md
```

Put the full task specification or a durable repo-local copy alongside them. Add a short pointer in the project instructions if needed; do not duplicate the whole prompt into every instruction file.

`STATE.md` must contain: actual branch/HEAD, current phase, current task ID, last verified checkpoint, next concrete command, current lock owner, owned process IDs with creation times, pending tests, unresolved blockers, and paths to reports. Never store secrets there.

`TASKS.md` must use this structure, expanded into small verifiable subtasks:

```markdown
- [ ] P0 Record baseline, call graph, coverage and dirty files
- [ ] P1 Enforce shared inference ownership and unattended runner
- [ ] P2 Repair streaming, activity, scroll and conversational behavior
- [ ] P3 Repair intent, scope, policy, retrieval and evidence semantics
- [ ] P4 Repair artifact data fidelity and attachment durability
- [ ] P5 Add local Python supervisor, contracts and resource manager
- [ ] P6 Migrate document/OCR/retrieval capabilities
- [ ] P7 Migrate speech and temporal multimodal video capabilities
- [ ] P8 Integrate startup, cancellation, caches and capability UI
- [ ] P9 Run independent regression, held-out and resource evaluations
- [ ] P10 Inspect diff, document actual results and clean owned processes
- [ ] P11 Request Windows shutdown as the final host action
```

Each task needs status (`pending`, `in_progress`, `passed`, `failed`, `blocked`, `not_run`), dependencies, files, acceptance criteria, exact validation commands, exit codes and evidence paths. Check a box only after its criteria pass. A blocker does not become a checked success. Keep an append-only attempt log so a failed approach is not repeated after compaction.

Update these files after each coherent change/test and before a long command or context compaction. On resume/compaction, read STATE → TASKS → DECISIONS → the relevant FINDINGS and completed test logs, inspect the current diff, then continue the recorded task. Revalidate stale state against disk. Do not restart the project, repeat completed expensive tests without cause, or replace an unfinished objective with a narrower one.

## 3. Shared endpoint: enforce the lock before live testing

The existing `rust-backend/crates/ruke-core/src/slot.rs` counts active user turns and cancels title jobs; it is **not a capacity-one semaphore**. Its own tests allow two simultaneous user guards. TypeScript `lib/server/inference-busy.ts` is also process-local accounting. Neither protects Strata from a separate Claude Code process. A lock file that only one client checks cannot guarantee exclusivity.

Implement and verify these distinct protections:

1. **Runtime request serialization:** one authoritative admission mechanism for every Ruke request to the shared endpoint: chat, web rounds, title generation, attachment notes, compaction, artifact repairs, vision observations, research helpers, warmup and evaluation. Map all call sites first. At most one upstream generation may be active, including the entire streaming response and actual cancellation completion. Bound queues; propagate queue cancellation and timeouts. Do not release the permit merely because response headers arrived. Avoid deadlock from a parent holding a non-reentrant permit while awaiting its own notes/repair child. A logical turn lease and an upstream request permit are different things.
2. **Development phase ownership:** mutually exclusive CODE → TEST → ANALYZE phases. While TEST owns inference, Claude Code performs no coding, reasoning requests, unrelated tools, progress generation, or parallel agent work. Run live tests in one foreground native orchestrator, with one Playwright worker and serialized model cases. Return only after the process completes, requests drain, cleanup completes and ownership is released. No detached test jobs or background poll-and-code loop.
3. **External-client coordination:** inspect the actual Claude Code launcher/endpoint integration. If a common local admission proxy is required, route both Claude Code and Ruke through it using session/project configuration and document the change; preserve the upstream address separately. A TEST lease must block competing Claude inference rather than send it to Strata. Do not pretend a Rust-only mutex or prompt instruction controls an unmodified external client. Verify with mock competing clients before live use. If the currently running CLI cannot be safely coordinated without a human relaunch, finish offline work and record live validation as blocked instead of risking concurrency or shutting down its model mid-generation.
4. **Atomic ownership:** retain `.ai-coordination/playwright.lock` compatibility, but acquire using exclusive create or an OS mutex, not `Test-Path` then overwrite. Record run ID, owner token, PID/start time, phase and heartbeat. Only the owner releases it in `finally`. A stale lease requires proof the original process has ended; elapsed time alone is insufficient. Do not delete a live foreign lock.
5. **Resource swaps:** only a native runner that can finish without another LLM request may unload Strata, run a heavy helper, terminate it and restore Strata. Verify unload/reload support from the actual installation. Do not invent endpoints or unload Strata during Claude inference. Restoration is required in `finally` after failure/cancel. If swapping cannot be made safe, queue the job or report the capability blocked; do not silently downgrade quality.

Test contention, two UI tabs, titles racing chat, cancellation while queued/streaming, process crash, stale owner identity, resource exhaustion, nested helper calls and lock release after nonzero exit. Observe upstream active request count; it must never exceed one. All this must work without loading a second router model.

## 4. Baseline and evidence from the current audit

The audit scanned 340 application/script/Rust source files (about 108,198 lines), with detailed inspection and execution of selected paths. This was not a line-by-line proof of the whole repository. The interactive browser internals were not comprehensively audited.

Actual completed validation against the local source:

- TypeScript `tsc --noEmit --incremental false`: exit 0.
- Twelve selected existing Vitest suites: **235 passed, 0 failed**, exit 0. Suites covered task scope, planner law, answer support, normalization, presentation, stream partitions, think splitting, progress, Office cells and attachment routing/retrieval.
- A separate generated diagnostic matrix: **156 cases, 48 met the stated expectations, 108 did not**. These are 13 template families over 12 novel subject/domain combinations, deliberately targeting suspect boundaries. They are not an unbiased overall accuracy score.
- Additional direct local-function, mocked-stream, React server-render and synthetic Office probes reproduced the findings below. No live Strata request was made by the audit. Full Rust build, end-to-end UI behavior and heavy Python/model quality were not validated by it.

Several earlier fixes are real: simple PDF noun discussion, separate-sentence negation, Unicode web tokens, short identifiers and some domain clauses improved; automatic whole-answer regeneration from heuristic diagnosis was removed. Do not revert these. The earlier missing `ThinkScrubber` import error is historical; verify the present build rather than reporting it as still active.

Create a current call graph distinguishing: default Rust chat, retained TS chat, nonstreaming requests, direct model-facing web tools, secondary search/research routes, uploads, artifact export, and background jobs. A failure in a secondary query planner is not automatically proof that every normal chat turn uses it. Record route reachability beside every finding. Classify each finding as reproduced, source-confirmed, suspected, fixed already, or not tested.

### F01 — Greeting verbosity is a behavior issue, not yet a proven hardcoded template

The supplied “what are you doing” reply unnecessarily repeats a capability menu. `lib/chat/client.ts:44` has no standing conversational system prompt. Direct decision probes return `standard_chat` for both greetings and that question. The audit did not find that literal reply as a production template. `WEB_TOOL_GUIDANCE` is injected into ordinary tool-enabled chat and overgeneralizes web-evidence rules. Model priors, history and effective prompt composition must be separated before assigning cause.

Capture the assembled request with private content redacted. Under the TEST lock, compare short clean-session and follow-up replies against the same model/settings with the minimal prompt and with Ruke's assembled prompt. Inspect defaults, generation parameters, compaction/history contamination and skill injection. Add one minimal application-owned response policy: respond to the actual intent; match requested detail; use a brief natural response for small talk; do not advertise capabilities unless asked; do not claim activities that are not running. Preserve detailed answers when requested. Do not add a greeting whitelist, canned “idle” reply, fixed sentence count, post-generation phrase deletion, or another model rewrite pass for every answer.

The pasted `svgCopy` / `svgView reasoning` is **not yet a proven model-output defect**. `ChatMessage.tsx:60` copies canonical content. Compare raw SSE content, saved message, DOM selection, Copy button output and exported conversation. Fix decorative SVG accessibility/copy serialization only if it is the source. Never globally remove the string `svg`, which is valid in code and SVG documents.

### F02 — Artifact intent still depends on brittle English grammar

Owners: `lib/decision/client.ts:165`, `rust-backend/crates/ruke-decision/src/engine.rs`, skill loader and contracts.

Reproduced:

| Request | Current routing | Required interpretation |
| --- | --- | --- |
| Explain how to create a PDF. | PDF artifact | Explain the procedure |
| I created a PDF yesterday; explain compression. | PDF artifact | Discuss compression |
| Create a summary in PDF. | Standard chat | PDF deliverable |
| Create a PDF summary. | PDF artifact | Same deliverable as preceding row |
| Without using Excel, create a PDF. | Standard chat | PDF; Excel is excluded |
| Make a Word document from this PDF. | Ambiguous standard chat | DOCX destination; PDF source |
| Create a deck of cards. | PowerPoint | Card deck, not slide deck |
| Create a plan for my garden deck. | PowerPoint | Garden planning |
| Give me the answer as "PDF". | Standard chat | Quoted output format is authoritative |

Fix requested operation, source format, destination format, discussion/tutorial, negation, quotation role and multiple deliverables as separate fields. Explicit supported format options are protocols; a regex score is not semantic certainty. Fast paths may handle unambiguous syntax, but must abstain on uncertainty. Use the existing answering model's typed capability selection when necessary, with validated arguments and on-demand skill loading. Do not add a mandatory extra classifier inference for every turn. Multiple deliverables need a supported per-artifact plan, not arbitrary priority or silent feature loss. Validate actual emitted artifact types even when initial routing abstained; `standard_chat: []` in `lib/render/fenceRepair.ts` must not leave a real generated artifact outside validation. Literal tutorial examples must not be executed as artifacts.

### F03 — Domain policy attaches restrictions to the wrong target

Owner: `lib/web-search/planner-law.ts:138,151,184,309,341` and callers.

Reproduced: “Do not use alpha.com, but only use beta.com” blocks both; “Trust alpha.com, but also consult beta.com” becomes hard exclusivity; “Explain \"site:alpha.com\" syntax” creates an allow-list; “Only use \"alpha.com\"” loses the restriction; “Don't exclude alpha.com” blocks it; “Search everything except alpha.com” misses the exclusion.

Represent constraints with target, polarity, scope, exclusivity, evidence span and authority. Quoting a target in my own command differs from quoting an instruction for analysis. Parse site operators in their role, not a second pass over raw quoted text. Treat preference/trust as ranking unless explicit exclusivity exists. Resolve contradictory instructions using conversational scope or uncertainty, not permanent sticky negation. Keep SSRF and explicit source exclusions enforced. Add conjunction, punctuation, reported-speech, correction and translated variants; do not patch commas one by one.

### F04 — Old scope leaks into unrelated work

Owner: `lib/decision/task-scope.ts:408,1026,1065` and `ruke-server/src/task_scope.rs`.

After “Order milk on alpha.com”, “Create a poem about this city” retains `operate` plus alpha.com. “Write a poem and explain its rhyme” carries the old target into research. Pronouns inside a new request do not necessarily refer to the previous task. Derive current-task identity and actual antecedents; separate conversational continuity, evidence scope and action authorization. A new topic resets only the appropriate fields. Do not infer permission from topic similarity. This probe establishes scope leakage, not that the guarded browser actually performed an unauthorized action.

### F05 — Lexical signals still masquerade as semantics

Owners: `lib/web-search/normalization.ts`, `metasearch.ts`, `reranker.ts`, `query-planner.ts:531`, `presentation.ts:76`, attachment BM25 and history reuse.

- C++ and C# both reduce to `c`; both accept C-language evidence. Preserve symbol-bearing identifiers, meaningful numbers and versions using shared field-aware normalization. Avoid substring relevance and mismatched tokenizers. Preserve Unicode combining marks and support scripts without spaces.
- “Novara supports rust, zig and nim” produces unsupported/gap search, while capitalization to Rust/Zig/Nim produces supported/no gap. Capitalization and English predicate shapes must not prove support or completeness. Use explicit unknown states and appropriate evidence evaluation. Separate topic coverage, claim support and complete enumeration.
- Generic profile searches force LinkedIn; an explicit Italy request still produces `in.linkedin.com` on the machine's India locale and quotes Italy as part of the person's name. `local-context.ts` recognizes selected multiword/alias regions but misses singleword countries. Respect explicit platform/region; locale is a fallback hint, not identity or physical location. Use a maintained geography representation with ambiguity handling, not endless ad hoc additions.
- “Explain pattern match scores in a parser” selects a sports plan; “Explain package version updates in Python” selects a tracker plan. Select UI surfaces from task meaning and validated data capabilities. These probes show plan misclassification, not proof that a fabricated widget was rendered.
- Reaudit source authority lists, official-site inference, publisher independence, contradiction grouping by entity/unit/time, cache keys, freshness, future/invalid dates and research-journal relevance. Reproduce current behavior before fixing; do not assume every older finding remains present.

### F06 — Preserved web text is not reachable by consumers

Owners: `segment-filter.ts:164`, `tools.ts:852,923`, `reranker.ts:480`, `types.ts`.

`originalPassageText` stores the source before filtering, but the audit found writes/definition and **no consumer reading it**. Model-facing and retained continuation blocks use filtered `passageText`. A long paragraph describing battery range through pronouns/synonyms was excluded despite containing the answer. A unit test that checks only the backup field cannot prove recoverability.

Keep canonical source blocks immutable and addressable. Rank bounded views with neighboring context, but let read/continue/deepen retrieve omitted blocks by stable IDs/ranges. Preserve URLs, document offsets, hash and provenance. Prove an answer omitted from the first window is recoverable through the actual model tool interface. Do not fix this by sending whole pages unbounded or merely adding another unused backup field.

### F07 — Attachment routing and continuation suppress relevant evidence

Owners: `lib/server/attachindex/router.ts`, `turn.ts:161,299`, `retrieve.ts:69`, `store.ts:211`; Rust `ruke-attach` counterparts.

Reproduced: a document ratio `1:20` selects a video time window; “Do not summarize; find the invoice number” selects whole-video summary; “Find every occurrence of the logo” remains point QA; comparing two distant times collapses them into one large range. An unrelated short CPU question gets the previous whale question prepended by `anchorQuery`. A repeated exact serial-number question loses its answer when chunk 0 is in `demote`, while unrelated fresh chunk 1 is retained.

Use modality/context-aware retrieval intents, separate compare-ranges from continuous ranges, and use actual continuation intent. Preserve top relevant evidence on normal follow-ups. The shown ledger must be scoped to conversation + attachment revision + query/task + continuation cursor, not just attachment ID globally. Do not label every vector candidate as a proven relevant omitted passage. Support resuming an exhaustive scan with honest coverage; exhausted top-K is not proof of no more matches.

### F08 — Attachment injection index is knowingly off by one

`ruke-server/src/chat/pipeline.rs:155–200` unconditionally passes `last_user_idx + 1` after an optional skill insertion; comments explicitly preserve the off-by-one case when no skill loaded. `build_attachment_turn` uses the supplied index to add images to the user message. Inspect and reproduce TS and Rust paths for no skill, slash skill, matched skill, compaction and historical attachments. Recompute the actual target user message after insertion or use stable turn identity. Repair fixtures that codify the bug; preserve valid protocol parity.

### F09 — Attachment indexes can be torn and model-incompatible

`lib/server/attachindex/store.ts:34–60` atomically replaces each file separately. A simulated failure replacing chunks after full text succeeds leaves **full.txt NEW, chunks OLD, metadata OLD**. This is not a transaction. Use immutable generation directories and one atomic manifest/pointer switch, with validation, reader consistency, crash recovery and bounded garbage collection. Stage frame files too. Use unique temporary names and per-index write ownership.

`IndexMeta` lacks embedding revision/dimension/normalization metadata. `retrieve.ts:25` computes a dot product over the shorter dimension instead of rejecting incompatible vectors. Changing the embedding model can silently mix spaces. Version schemas and embedder fingerprints; rebuild incompatible indexes from originals. Add fault-injection tests at each commit step, mismatched dimensions, concurrent readers/writers and disk-full recovery.

### F10 — Extraction and indexing cancellation is incomplete

`embedTexts` accepts a signal, but `buildAttachmentIndex` has no signal and calls it without one; `indexContent` does not forward extraction cancellation. Propagate cancellation through upload → parse → chunk → embed → commit. Never publish a partial generation on cancel. Uninterruptible library work must run in an owned worker process with a bounded cancellation/termination path.

### F11 — Artifact contracts corrupt data or overpromise execution

Owners: `lib/decision/contracts.ts`, `lib/documents/schemas.ts:523`, `xlsxEngine.ts:15–45`, `powerbiEngine.ts`, preview/export paths, generated Rust contracts.

- XLSX numeric null/blank/invalid values become zero; Power BI probes convert null, unknown and `₹1,200` to zero. `12%` becomes 12 without unit semantics. Missing data, real zero, invalid text and percent units are different values. Preserve typed missingness, locale/currency and explicit imputation choices; report parse errors instead of inventing measurements. Recalculate dependent formulas and test preview/export agreement. Do not globally interpret every leading `=` in untrusted imported text as an executable formula.
- Currency is hardcoded to dollars; preview percent formatting guesses scale from magnitude. Encode currency, locale, units and percentage convention explicitly.
- PPTX contract forces 8–14 slides, dark theme and “insane” animation by default. PDF forces A4; HTML forces a fixed aesthetic. Keep available themes and my established default preferences, but make request-specific page size, slide count, accessibility, branding and motion override them. Defaults are not universal requirements.
- The execution bridge mandate forbids admitting inability and treats a fenced spec as successful execution. Replace it with truthful capability guidance: a supported spec requests generation; only a successful artifact job proves creation. Do not imply arbitrary Python scripts were executed by a JSON artifact engine. Failed export must remain failed with bounded repair and actual diagnostics.
- Keep useful TS ExcelJS/DOCX/PPTX/PDF code unless a measured deficit justifies migration. Python `openpyxl` does not itself calculate formulas; choosing it does not solve recalculation. Distinguish invalid formulas, unsupported evaluator functions and intentional spreadsheet error values. Preserve editable structures where promised; a raster chart is not an editable native chart.

### F12 — Office/PDF parsing loses structure and meaning

`extract/pdf.ts` handles the text layer and exposes empty pages; it has no OCR. Nonempty text alone does not establish reading-order accuracy or complete coverage. `extract/office.ts` strips XML into text, omits formulas when cached values exist and decodes numeric entities with `String.fromCharCode`. Reproduced: a cell with formula `2+3` and cached value 5 returns only `A1=5`; `&#128512;` becomes the wrong character.

Use proper parsers and preserve page/section/table/cell/slide relationships, formulas plus cached values, date systems, cell types, merged ranges, notes and links when available. Test supplementary Unicode and hex entities. Keep safe lightweight fallbacks with truthful coverage. This is a quality reason for Python document adapters, not a reason to erase the existing archive/security layer.

### F13 — Video processing is not yet a general temporal evidence system

`extract/ffmpeg.ts` has `VIDEO_FRAMES = 2`; the indexed turn path caps delivered frames at four. `extract/index.ts` eagerly transcribes video during upload, and long-text indexing differs from short/no-speech paths. `audio.ts` defaults to English-only `Xenova/whisper-base.en`. The existing `vision-prepass.ts` is profile-oriented; the audit found its export but no production caller. Merely adding another prepass file will not connect video evidence to web queries.

Preserve FFmpeg's useful decoding, cancellation and actual timestamps. Build the unified query-driven timeline described in section 8. Do not equate no ASR text with silence, no sound, no useful content or failed video understanding. Do not optimize around the motivating song, watermark, anime character, language or website.

### F14 — Attachment prompts hide coverage gaps

`lib/chat/client.ts:135,191`, `attachindex/turn.ts:119` and Rust counterparts call sampled/selected material a “complete saved record” and forbid mentioning processing limitations. A durable original file is not a complete semantic index. Replace blanket claims with machine-readable coverage and natural, relevant limitations. Distinguish observed visual evidence, OCR, transcript, generated summary and unexamined regions. Do not claim a page/frame/interval was read merely because its file exists.

### F15 — Answer integrity still rewrites valid literal content

`lib/chat/answer-release.ts:120` and Rust mirror no longer regenerate whole answers on a heuristic flag; preserve that improvement. Remaining reproduced defects: a code string containing “according to my searches” triggers the blanket no-retrieval disclaimer; `~~~js` fenced code containing `[S9]` is modified to remove the marker. Literal `[S1]` data can also be mistaken for a citation.

Parse Markdown/code boundaries consistently with the renderer. Validate citations using explicit provenance, not arbitrary text coincidences. The R3 disclaimer must not relabel user-provided sources, local observations or calculations as unverified web background. Current `WEB_TOOL_GUIDANCE` says every key claim without fetched support is unverified and requires retrieved citations for all numbers/dates; scope that instruction to external evidence claims. A resolved source ID proves identity, not semantic support. Keep speculative heuristics as telemetry until a justified action exists. Never resurrect whole-answer erasure or synthetic-user harness lectures.

### F16 — Streaming terminal ownership is still inconsistent

Owners: `lib/chat/web-tool-loop.ts:620,670,684`, Rust `chat/web_loop.rs:730,761`, `lib/stream/parser.ts`, `lib/chat/client.ts`, `hooks/useChat.ts:632,876`.

The web loop releases held terminal frames before final research metadata. A mocked wire with final metadata after DONE delivers it if coalesced into one read, but loses it when split into the next read. Emit all metadata, usage, revisions and closures before exactly one turn-terminal sentinel. Intermediate tool rounds must not end the conversation stream. Verify every error/cap/abort path and both streaming implementations.

Parser errors are yielded as events, so `ChatClient.chat()` can resolve normally. `useChat` then runs repair and sets complete when the AbortController was not cancelled. Carry an explicit final outcome through every layer; never turn error, truncation, length limit or orphaned tool-call EOF into successful completion. Keep partial text and useful retry behavior. Do not run artifact repair after a failed or cancelled primary turn.

### F17 — Reasoning normalization damages code and can duplicate text

`lib/stream/thinkTags.ts` blindly recognizes tags anywhere in content. Reproduced: literal `<think>literal</think>` inside an XML code fence becomes reasoning and disappears from the answer. If a provider sends both reasoning_content and equivalent reasoning_details, the parser appends both. Support provider-specific structured channels preferentially; make inline-tag fallback protocol-aware, stateful and code-aware. Do not deduplicate legitimate repeated thoughts by arbitrary string matching. Test UTF-8 split points, code fences/backticks/tilde fences, partial tags, structured channels, tools and cancellation across Rust and TS. Never run text filtering against raw SSE envelopes.

### F18 — Activity UI reports historical evidence as current work

Actual React render of `components/ProcessingStatus.tsx:115` with active reasoning and existing citations says “Reading web sources”; with a completed page action it says “Page read complete”. The separately improved progress tracker does not fix this component's priority order. Use one authoritative per-turn/per-round current activity state with action IDs. Sources and the completed action trail are history, not current activity. Show thinking/writing/reading only from actual events; close every action on success/error/cancel and reopen reasoning on later rounds. Show concurrent work only when it actually exists. Do not infer activity from elapsed time or presence of old reasoning text.

### F19 — Scroll following still needs intent ownership

`app/page.tsx:262–375` now observes content resize and unpins on wheel/touch; preserve those improvements. It still treats upward scroll-position changes as user intent, writes the following ref from React state during render, and jump-to-bottom does not synchronously set that ref. These are source risks requiring browser reproduction, not a measured current jitter rate.

Implement one following/free controller that distinguishes user intent from programmatic scrolling, anchoring and height changes. Jump-to-bottom synchronously enables following. Coalesce writes with rAF; observe both content and viewport. Preserve the visible anchor while free. Cover image load, expanding/collapsing reasoning, table reflow, output revision, window resize, keyboard/scrollbar/touch, nested scroll boundaries, chat switching and cleanup. Do not fix this with a larger threshold or alternating smooth-scroll calls.

### F20 — Capability detection uses brand mentions as requirements

`lib/skills/modality.ts` blocks any strong provider word anywhere in a skill. Reproduced: a CSV guide explaining why not to use Midjourney is blocked; a text guide to Leonardo da Vinci is blocked. Use declared required capabilities and actual configured adapters, with uncertain text classification as a hint. Provider-specific protocols may name providers; generic capability availability must not be a blacklist of words. Keep unavailable external generation honestly unavailable.

### F21 — Remaining lifecycle and retention risks

Inspect and test these source-confirmed omissions: `lib/documents/pdfEngine.ts:109` does not destroy its PDF document proxy; render-page guards are awaited before entering some cleanup `try/finally` blocks; `documents/browser.ts` keeps a resolved browser promise after a later browser disconnect; embedding/ASR singletons can remain resident after first use. Add owned cleanup, crash recovery, idle release and repeated-run resource tests. Inspect compaction's aggressive compression instructions and selected-history handling: preserve constraints/provenance with a durable structured state, do not promise zero knowledge loss from a 95% compression target.

## 5. Generalization mechanisms and test design

Before changing behavior, write invariants independent of example strings. Keep these separate:

- protocol parsing and explicit user constraints;
- uncertain semantic intent and language understanding;
- resource budgets and scheduling;
- evidence relevance, source identity, authority, claim support and coverage;
- presentation preferences and actual artifact capability.

Legitimate hard rules remain hard: schemas, tool authorization, SSRF, path containment, archive limits, genuine explicit restrictions and bounded resources. Do not remove all regexes or all rules. Do not move the same English keyword cascade into Python or replace it with a single unchecked model verdict. Preserve original requests; derived intent must carry provenance and uncertainty rather than silently rewriting user instructions.

Fix the call chain, not only a helper: intent → selection → skill loading → generation → validation → render/export → persistence. For evidence: extraction → canonical store → selection → model-visible tool result → continuation → citation/support. Repair TS/Rust equivalents and contracts together. Do not preserve known semantic defects merely to keep an old oracle byte-identical.

Maintain known regression cases plus an independent held-out evaluation partition. Freeze the latter before implementation; after a failed case becomes a regression, create a fresh holdout. Generate novel names/hosts/identifiers and compositional cases. Production must not inspect fixture IDs or test-only names. Check paraphrase, clause order, polite/terse wording, reported past action, tutorial vs command, negation and correction, quoted targets vs quoted instructions, source vs output, multiple artifacts, topic reset, code/literal mentions and unknown tasks. Use meaning-preserving transformations only where valid: case changes are not invariant for passwords, code identifiers or case-sensitive paths.

Include English, Telugu, Hindi, Japanese, Chinese, Arabic, Spanish and Vietnamese with fluent/verified expectations. Tests must not consist only of English translated by the same model being evaluated. Use deterministic contracts and independently checked fixtures where possible. The same LLM judging itself is supplementary evidence, not the sole pass criterion. Report results by family, language, precision/recall and abstention rate; avoid a misleading single accuracy number.

A golden test that asserts the old mistake is not quality evidence. Examples in the current suites explicitly accept zero-null coercion, permanent demotion of old evidence, or backup fields without consumer recovery. Update their semantic expectations with reasons while retaining genuine wire-format compatibility tests.

## 6. Python foundation and contracts

Create a repo-contained package, adapting this layout to existing conventions:

```text
python-backend/
  pyproject.toml
  uv.lock
  .python-version
  README.md
  ruke_ml/
    supervisor.py
    config.py
    contracts.py
    security.py
    health.py
    models/{registry,lifecycle,resources}.py
    retrieval/{embeddings,reranker,chunking}.py
    documents/{parser,ocr,structures}.py
    speech/{asr,alignment,diarization}.py
    video/{scenes,observations,timeline,search_hints}.py
    workers/
    eval/
  tests/
.data/python/{bin,runtime,env,cache,tmp}/
.data/models/
.data/ml-cache/
```

Use a pinned project-local uv and managed Python with a committed lock. Verify Windows, Python, CUDA and dependency compatibility before selecting the interpreter. Start with one environment; split document/retrieval/speech workers only for demonstrated dependency conflicts. No global pip/Conda pollution, mandatory manual venv activation, automatic WSL migration, or always-running vector database. Configure runtime/model/cache/temp paths per child process, not global machine environment. Verify actual supported uv variables and version semantics from official docs. Reuse already downloaded compatible assets.

The persistent supervisor must not import Torch, Paddle, Transformers, Docling ML or pyannote at startup. Heavy imports/models live in lazily spawned processes; process exit is the primary allocator reclamation mechanism. Zero heavy models at idle is achievable; zero RAM for a running supervisor is not. Expose health/capabilities without loading/downloading models.

Use a canonical versioned schema to generate or validate TS/Rust/Python contracts. Include request/run/job IDs, capabilities, progress, structured errors, retryability, cancellation, model revision, actual coverage and artifact provenance. Embed/rerank results include dimension and normalization. Document chunks include stable source ID/hash, page/slide/sheet/cell/section, block type, bounding box when known, original text and time intervals when applicable. Do not invent locations or confidence values unsupported by the provider.

Rust normally owns calls to Python. Bind RPC to loopback with a per-run secret kept off browser JS and out of logs; support deadlines and bounded payloads. Send validated local references rather than huge base64 copies. Resolve paths against explicit roots, including Windows junction/symlink/reparse escapes, UNC/device paths and time-of-check/use hazards. Prefer scoped handles or staged owned files. Bound archive expansion, page/pixel counts and subprocess outputs. Disable unrequested macros, external document links and network access from render/parse workers. Do not allow OCR/page text to become control instructions.

## 7. Documents, retrieval and artifact quality

Preserve fast native text extraction for clean text/code/logs. Use structured parsing for rich documents and OCR for pages/regions that need it. Evaluate Docling plus format-specific adapters; do not assume one parser preserves every spreadsheet formula or slide animation. Preserve canonical rich representations before deriving Markdown/text views.

OCR cascade: inspect text-layer quality and layout → native extraction when adequate → language-appropriate light OCR → heavier layout/document recognition where warranted. Mixed/scanned/rotated/multicolumn pages, tables, formulas, screenshots, charts, forms, receipts and code need real fixtures. Retain per-page failures and confidence, source coordinates and reading order. Do not stop escalation merely because some text exists or one provider returns high confidence.

Candidate models/libraries, **not unconditional defaults**:

- Retrieval: evaluate `Qwen/Qwen3-Embedding-0.6B` against the actual MiniLM baseline and a multilingual alternative such as BGE-M3. Use the model's documented pooling, instruction and normalization protocol; do not reuse MiniLM mean pooling blindly.
- Reranking: evaluate `Qwen/Qwen3-Reranker-0.6B` against a multilingual alternative such as `bge-reranker-v2-m3`. Follow its real scoring protocol. A reranker cannot recover evidence already discarded by an overly aggressive lexical filter.
- Documents: Docling with selected extras and format-specific readers; PaddleOCR light recognition and `PaddleOCR-VL-1.6`/layout components when compatible and useful. Verify the exact pipeline/model distinction, releases, dependencies and license before pinning.
- The published PP-OCRv6 small/medium coverage lists Chinese, Japanese and Latin-script languages; it is **not sufficient evidence of Telugu/Hindi OCR support**. Register and evaluate appropriate Indic-capable routes. “Multilingual” does not mean every language.

Use hybrid lexical+dense retrieval, measured candidate fusion and optional neural reranking, then neighbor/section expansion within a token budget. Preserve exact identifiers, rare names, code, numeric units and source references. Support lexical fallback explicitly when a model is unavailable; mark its quality mode rather than claiming identical quality.

Separate dense vectors from JSON into a versioned compact binary store or suitable local index. Bound caches by bytes, not only number of attachments. Memory-map where supported and measured; this does not make resident pages free. Keep sufficient text/block metadata for recovery. Cache deterministic derived artifacts by original content hash + pipeline version + model revision + language/options + relevant precision/configuration. Do not cache stochastic summaries as if they were source evidence. Include access scope in lookup authorization, bounded disk usage, reference-counted deletion and failed-build cleanup.

For creation/edit/export, first fix F11 and validate the actual binary output. Use Python document writers where they demonstrate a quality/coverage advantage; keep working TS paths and the PDF Chromium renderer unless a tested replacement is better. Preserve formulas and styles when editing rather than reconstituting a lossy text extract. Support true document/spreadsheet/slide output contracts. Verify save → reopen → structural/content checks and render representative/all relevant pages for layout QA. Check clipping, missing glyphs, overflowing tables, unsupported formulas, stale cached results and editable-vs-image charts. Bound repair attempts and report the real error. Do not load a vision model for every trivial artifact.

## 8. Speech and universal temporal video understanding

Treat video as a timestamped multimodal document with independent evidence channels. Retain durable originals so deeper queries do not require re-upload.

At upload, create a cheap baseline: media metadata, streams/default tracks, duration/start times, rotation, embedded subtitles, scene/timeline anchors, frame references and processing coverage. Avoid running every heavy modality before the user can ask a question. Keep FFmpeg for decoding/seeking. Consider PySceneDetect adaptive/content detection where it improves coverage; cuts alone miss static lectures and brief events.

Add query-driven enrichment for speech, OCR, visuals, audio events, temporal neighborhoods, comparative intervals, whole-video summaries and exhaustive occurrence scans. Query understanding must not be another closed list of English phrases. Preserve head, middle and tail coverage with hierarchical sampling; use visual novelty and OCR changes, then query-directed seeks. Deduplicate expensive analysis of near-identical frames while retaining all temporal occurrences. A bounded sample cannot prove an event never happened.

Honor presentation timestamps, VFR, rotation, stream offsets and multiple audio/subtitle tracks. Do not compute all times from frame index/fps or assume track zero is the desired audio. Preserve source track and timebase through resampling, ASR chunk offsets and alignment. Never shift legitimate overlapping speakers merely to force a monotonic transcript. Distinguish no track, silence, speech, music, nonspeech audio, unknown and processing failure.

Evaluate Qwen3-ASR 1.7B and 0.6B with appropriate resource ownership; quality wins where feasible. **Official Qwen3-ASR language coverage currently omits Telugu, and Qwen3-ForcedAligner lists 11 languages excluding both Telugu and Hindi.** Do not route all languages through them or fabricate precise word timestamps. Evaluate a verified Telugu-capable multilingual fallback, for example a multilingual Whisper checkpoint with measured quality, and capability-aware alignment alternatives. A published language list establishes claimed support, not good quality on my recordings. Test code-switching, accents, music, noise and no-speech hallucinations.

Preserve the useful existing disk-backed PCM, bounded windows, overlap handling and cancellation; move ownership into the shared scheduler. Run alignment only when needed for exact timestamps/subtitles. Add pyannote Community-1 diarization if access requirements are already satisfied; otherwise record `license_acceptance_required`/`not_configured` without breaking startup. Use anonymous speaker labels, not guessed real identities. Avoid loading ASR+aligner+diarization together when sequential stages can persist intermediates and free memory.

Persist atomic timeline evidence: speech/subtitles, OCR text+bbox, visual observations, source frames, audio events, confidence/provenance, interval and coverage status. Build hierarchical segment/chapter summaries linked back to raw evidence, not replacements for it. Deliver adaptive bounded image sets appropriate to point/range/comparison/summary tasks. Allow explicit deeper scans and truthful exhaustive/partial coverage.

Connect media evidence to web tools through a real `MediaSearchHints` contract: observed names, visible text/URLs, distinctive speech/lyrics, scene clues and uncertain audio candidates. Test the entire path from an uploaded video through stored timeline to the actual search tool arguments. Do not add an unused helper. Use the existing main multimodal model only when needed under the shared lock; no permanent second giant vision model. Optional CLAP and Chromaprint may generate candidates, not truth. External identification services remain optional; corroborate candidate identities, and do not require a specific song/site/character.

## 9. Memory, lifecycle and unified startup

Target a configurable **4096 MiB additional Ruke footprint while Strata stays resident**. Report both total Ruke process-tree memory (Next, Rust, Python, render browser and workers) and incremental helper memory, plus baseline, peak, steady idle, commit/private bytes where available and VRAM. Do not report only one worker's RSS or conceal Next dev overhead. Also report disk/cache/download costs separately. OS accounting can double-count shared mappings; describe measurement method.

Use streaming, bounded batches, disk-backed intermediates, no duplicate weight copies, scoped work, one heavy worker at a time and short configurable idle TTLs. Terminate idle helpers immediately under memory pressure. Resource estimates require measured load-time peaks and safety headroom, not just parameter count. Unloading Strata frees resources but does not prove the helper itself uses less than 4 GB. If the full-quality task cannot fit, safely swap only when supported, queue/defer it or record a blocker. Do not silently shrink models, resolution, pages, regions or candidate sets. Equivalent quality must be evaluated, not asserted.

Modify `scripts/dev-supervisor.mjs` so **one `npm run dev`** resolves root/config, preflights ports, bootstraps/syncs the local Python environment only when needed, builds Rust, starts the lightweight Python supervisor and waits for health, starts Rust and waits for health, then starts Next and confirms readiness. Do not download all models or import heavy frameworks at boot. Cache installation state by lock/interpreter/platform; detect incomplete/corrupt installs. Support offline startup after setup.

Give every child a clear owner. On Ctrl+C or a critical service crash, stop only owned process trees and propagate the real exit status. One heavy worker crash should return a typed failure and permit a clean later worker restart, not crash the app. Verify no orphan worker or Ruke-owned render browser holds memory/ports. Never kill all `python.exe`, `node.exe`, `chrome.exe`, Cargo or Strata processes by image name.

Surface real events: queued, preparing/download needed, extracting, OCR, transcribing, indexing, retrieving, thinking, writing, ready, failed, cancelled. Avoid fake percentage/time guesses. Include job IDs so stale events cannot update a new turn. Cleanup must survive client disconnect, server crash, disk full, download failure and cancellation. Downloads need bounded retries, progress and resumability where supported; no infinite retry loop.

## 10. Validation gates

Use actual package scripts/configuration; do not invent a `test:e2e` script. At the audited HEAD, relevant scripts include `typecheck`, `test`, `build`, `contracts:check` and `dev`; Playwright is configured separately. Keep all tests isolated from real user conversations/uploads and from the shared inference server unless explicitly in TEST phase.

1. **Build gates:** targeted checks after each change, then appropriate TypeScript/Next production build, Rust build/test/fmt/clippy, contract generation/check and Python locked-environment tests. Complete repository-required checks. New API migrations must compile every consumer, including tests; do not repeat the deleted-ThinkScrubber integration mistake. Do not “fix” it by bypassing the scrubber.
2. **Harness gates:** known regressions, independent heldouts, entity/domain substitution and adversarial distractors. Check source/output format, exclusions, quoted examples, new-topic transitions, generic profiles, arbitrary sites and unavailable capabilities. Preserve explicit search requests and explicit no-search restrictions; static discussion of search/current prices is not automatically a live lookup. Direct URLs that are examples/code are not automatically fetch commands.
3. **Stream gates:** deterministic mocked upstream, all byte split positions plus multi-event reads, Unicode, multiple tool rounds, late usage, all reasoning channels, literal tags, malformed/oversized events, EOF, errors, cancellation and stale events. Final content/status/history/metadata must be invariant under network chunking. A parser-only pass is insufficient: test through the real hook and persisted conversation. Revisions must not silently erase accepted answers.
4. **UI gates:** Playwright with mocked upstream first. Verify actual status text, source history, thinking resumption, scroll following/free behavior, delayed layout, modal/focus/keyboard behavior, copy/export SVG contamination, chat switching, stop/retry, reload and generated artifact downloads. Keep screenshots/traces and console errors. Interactive browser feature acceptance is deferred.
5. **Document gates:** native/scanned/mixed/rotated/multicolumn PDFs; long tables, merged cells, formulas and cached values; DOCX tables/styles; PPTX notes/charts; ODF/EPUB/legacy conversions; supplementary Unicode/RTL/Indic text; encrypted/corrupt/huge inputs; archive members. Use typed ground truth, roundtrip/reopen and visual checks, not only nonempty text assertions.
6. **Media gates:** short/long/multi-hour synthetic timelines, head/middle/tail events, cuts and static scenes, OCR-only/speech-only/visual-only clues, music-only/silent clips, mixed languages, subtitles, multiple tracks, VFR, rotation, A/V offset, corrupt regions, cancellation, compare ranges and exhaustive search. A randomized synthetic visible clue and a different speech clue must both reach search hints. Include real human recordings where available; synthetic speech alone is insufficient quality evidence.
7. **Quality gates:** paired old/new Recall@K, MRR/nDCG, answer-bearing passage recall, evidence faithfulness, OCR CER and table structure, ASR WER/CER by language, diarization DER where applicable and temporal QA localization. Define acceptance tolerances before comparing, and report sample sizes and unsupported tasks. No universal superiority claim from a few examples. Do not silently score skipped/gated languages as passed.
8. **Resource/security gates:** no heavy startup imports/downloads; ordinary chat loads no helper; OCR does not load ASR; correct queue reuse and TTL; crash/cancel recovery; repeated load/unload stabilizes memory; cache isolation/version invalidation; transactional index fault injection; path traversal/reparse escapes; archive bombs; untrusted document egress; concurrent endpoint clients never exceed one active generation.
9. **Live gate:** only after deterministic gates stabilize and external-client locking is verified, run a small serial real Strata suite covering short chat, artifact generation, search, document QA and video QA. Keep the coding agent idle throughout. Run expensive model evaluations in bounded batches, not on every code edit. If downloads/licenses/environment prevent a test, record exact cause and finish feasible work.

Run startup and shutdown/cleanup tests without actually powering off until the final phase. Inspect the diff for accidental user-data changes, exposed secrets, dead code, duplicated loaders, new example-specific rules and documentation that overstates behavior. Remove old implementations/dependencies only after replacement parity and rollback paths are established.

## 11. Final report and completion criteria

Write `docs/overnight/FINAL-REPORT.md` before shutdown. Include:

- actual starting/ending HEAD and dirty-file handling;
- architecture and reachable routes before/after;
- each finding's reproduced cause, files changed, mechanism and before/after examples;
- remaining legitimate hard rules and why they remain;
- exact commands, exit codes, pass/fail/blocked/not-run counts, logs and held-out split/results;
- model/library/interpreter revisions, licenses/access status, language support and measured selection rationale;
- document/ASR/video/retrieval quality comparisons and visual validation;
- total/incremental memory, VRAM, load peaks, idle release and startup latency;
- how Claude/Ruke endpoint ownership and resource restoration were actually enforced;
- fallback behavior, unresolved failures and the precise human step needed for genuine blockers;
- one-command startup and how to resume work from STATE/TASKS.

Use status **COMPLETE** only if all required feasible gates pass and remaining optional limitations are explicitly scoped. Otherwise use **PARTIAL/BLOCKED**, preserve resumable work and list it honestly. Do not stop early because a test first failed; diagnose and repair it. Do not loop forever on a license or missing credential that cannot be resolved unattended. Keep valid independent improvements even when one capability is blocked.

## 12. Authorized Windows shutdown — last action

I authorize shutdown of my actual Windows PC after this run finishes, including a genuinely blocked terminal state after all feasible independent work has been completed and documented. Do not ask me again. Do not shut down now merely because a plan or first failing test exists. Do not use a fixed timer that may power off mid-write or mid-test.

Before shutdown: persist all edits/reports/task state; record remaining blockers; flush artifacts and test results; inspect the working tree; finish or cancel/drain owned jobs; release only owned leases; stop the dev supervisor and its owned children; restore Strata if a resource swap left it unloaded and restoration is still relevant; verify no owned helper is still writing. Do not stage/commit unrelated work or destroy files to make the tree appear clean.

Use the actual Windows host, not a container, CI runner or unrelated remote machine. The final native host command is:

```powershell
shutdown.exe /s /t 0
```

Have the native runner record that shutdown was requested and capture immediate command failure if it returns nonzero. If rejected, attempt only a bounded documented supported alternative within existing authorization; do not bypass OS permissions or endlessly retry. Do not force-kill unrelated applications to claim success. Record `shutdown_failed` if the OS prevents shutdown. A successful command means shutdown was requested; it is not proof that an agent still running afterward has observed physical power-off. Once shutdown is accepted, do not return to coding or request another model response. This is the final action of the overnight implementation run.

## Primary references for migration decisions

Recheck exact versions and compatibility at implementation time. These sources substantiate capability candidates, not quality guarantees on this PC.

- Qwen embedding/reranking model protocols: https://github.com/QwenLM/Qwen3-Embedding and https://huggingface.co/Qwen/Qwen3-Reranker-0.6B
- Qwen ASR and forced-aligner language tables: https://github.com/QwenLM/Qwen3-ASR
- Whisper language registry, including Telugu: https://github.com/openai/whisper/blob/main/whisper/tokenizer.py
- Docling formats/required extras: https://docling-project.github.io/docling/usage/supported_formats/ and https://docling-project.github.io/docling/getting_started/installation/
- PP-OCRv6 language coverage: https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html
- PaddleOCR-VL pipeline/model distinction: https://paddlepaddle.github.io/PaddleX/3.7/en/pipeline_usage/tutorials/ocr_pipelines/PaddleOCR-VL.html
- Pyannote Community-1 access requirements: https://huggingface.co/pyannote/speaker-diarization-community-1
- uv project storage/environment: https://docs.astral.sh/uv/reference/storage/ and https://docs.astral.sh/uv/reference/environment/

Start with P0 and P1. Implement, test and persist progress through P11. Fix general mechanisms rather than memorizing the examples.
