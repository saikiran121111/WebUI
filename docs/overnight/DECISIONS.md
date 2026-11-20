# DECISIONS — overnight 2026-11-15

- D-001 Work continues on `local` branch at HEAD ec256bd (brief: do not switch to develop). Dirty `tsconfig.tsbuildinfo` preserved untouched.
- D-002 Verbatim brief stored at docs/overnight/SPEC.md (Downloads prompt (11)==(10) byte-identical).
- D-003 Playwright live gate: proceed only under the exclusive launcher + lock. Since Claude Code itself uses the shared Strata endpoint and cannot be relaunched/reproxied unattended, per brief §3.3 the live model gate is recorded BLOCKED if coordination cannot be verified; offline gates (vitest/tsc/cargo/contracts) carry the verification load.
- D-004 Shutdown at end per brief §12 (memory: 2026-11-14 directive). Supersedes 2026-11-06 "machine left running" note in old docs.
- D-005 Never run `cargo fmt --all` (memory); fmt only touched crates.

## D-010 Bridge route is non-streaming-only (2026-11-15)
`/api/ruke/internal/completion` rejects stream:true with 400. Streaming via a polling bridge would re-buffer SSE and break the raw-passthrough law (2026-11-13 §2); instead TS streaming runs ONLY in TS-only mode (Rust mode proxies the whole chat handler, so the two authorities can never race — verified route.ts:573) and takes the process-local permit there.
## D-011 ONE TS door: lib/server/upstream-bridge.ts (2026-11-15)
All TS upstream generations go through sharedUpstreamCompletion/sharedUpstreamStream. Rust mode → loopback bridge route with internal secret headers + timeout_ms queue control (504/503/502 honest statuses; verbatim upstream passthrough). TS-only mode → LocalUpstreamAdmission: capacity-1 FIFO, MAX_WAITERS=4 (same bound as Rust DEFAULT_MAX_WAITERS), cancel-safe, exactly-once release with FIFO hand-off. No mode mixes both authorities.
## D-012 Deadlock law TS mirror (2026-11-15)
Stream permit releases when the response body FULLY drains (wrapBodyReleasing once() on done/error/cancel) — never at headers arrival — strictly before tool executors and helper generations run. Non-ok paths drain then release. Parent never awaits its own child: title/notes/gate calls are sequenced after prior releases, never nested under a held permit.
## D-013 Golden header byte-lock honored (2026-11-15)
Bridge stream fetch sends content-type → authorization → accept, byte-locked to Rust error::upstream_headers, because rust-golden fixtures record header order. Unit stubs were made Response-faithful (headers field) rather than loosening the door.

## D-014 — Lock protocol is filesystem-enforced, fail-safe-liveness (P1.4)
Chose `[File]::Open(CreateNew)` atomic acquire (two launchers can never both hold) over Test-Path/Set-Content races. Holder keeps its handle open with FileShare Read|Write but NO Delete share: a live lock is physically undeletable, so §1.2 "never delete a live foreign lock" is enforced by the OS, not politeness. Fixed-width 512-byte record lets the heartbeat child rewrite in place without truncation. Staleness is PROOF-based only: PID absent, or PID whose process started clearly after the lock (reuse); StartTime unreadable or malformed record ⇒ treated LIVE. Release verifies our runId token before deleting; a replaced lock is warned about and kept. The launcher gains -LockInfo (inspect, exit 3) and -BreakStaleLock (proof-gated), and releases owner-only in finally. Tests never touch Playwright or inference.

## D-015a - repair: DECISIONS.md had been clobbered (session 27)
- Discovery: the working copy of docs/overnight/DECISIONS.md contained only blank lines; D-001..D-014
  survived only in git HEAD. Cause: an earlier session's doc update wrote the file instead of appending
  (append-only law broken). Restored from HEAD:git show and re-appended D-015. All future doc updates
  read-modify-write with an explicit append and a size check after write.
## D-015 (session 27) F04: a pronoun is not a permission
- Decision: scope continuation is gated by a SELF-TASK predicate instead of cue presence alone. If a turn's
  leading slot holds a token that is in NONE of this law's vocabularies (scaffolding, shopping/UI nouns,
  site/research verbs, anaphora cues) AND the turn names further lexical matter, the turn carries its own
  task and inherits nothing: not the previous ACTION (operate intent, browser routing, mandatoryHosts wall)
  and not the previous destination.
- Why general: no word list for poems/translation/landlords. The discrimination comes from the closed-class
  vocabulary the law already owns for the site/shopping domain, so the only way a turn reads as continuation
  is by speaking that vocabulary ('add bread too', 'on the checkout page', 'the chargers again').
- Kept: subject continuity for anaphoric research asks. Conversation continuity, evidence scope and action
  authorization stay separate: a research carry is never operational and never routes the browser.
- Cost: an imperative continuation using a word outside the domain vocabulary ('recalculate the cart') resets
  the session - a conservative direction that loses a convenience, not an authorization.
- Pinned in both languages: shared fixture (12 merge cases), 3 Rust inline tests, 3 vitest law tests.


## D-016 (2026-11-15, session 29) - identifier identity is shape-preserving, and surfaces need evidence
- Decision: put word/token identity in ONE place (lib/web-search/normalization.ts) where a "+"/"#"
  modifier run is part of the identifier and only . _ - ' generate alternate spellings.
- Why: every query-side and text-side matcher had been collapsing C++/C# to "c", so C-language evidence
  answered C++ questions in both directions. A keyword table for language aliases would be the brittle
  alternative and cannot cover every symbol-bearing identifier.
- Second half: presentation surfaces that depend on LIVE STATE (finance, sports, tracker) are only kept
  when an unambiguous prompt pattern or a vertical evidence domain supports them. Ambiguity in the
  prompt is resolved with retrieval data instead of a third keyword tier, and corroboration can never
  add a surface, only decline one.
- Cost: a genuinely ambiguous state ask whose evidence happens to be non-vertical now renders as plain
  text (never a wrong vertical card); symbol identifiers no longer match their stem-only spellings.


## D-017 (2026-11-16, sessions 31-33) - evidence ledger identity, index-derived axis, raw-first retrieval
- Decision: the "already shown" ledger is a QUERY+CONVERSATION fact, not an attachment fact. v2 stores
  {"q": fingerprint, "ids": [...]} under "<attId>|<conversation>" and an exact repeat of the question that
  produced the list gets its own passages BACK, while an explicit continuation ask or an exhaustive scan
  rotates to fresh material. A v1 bare-array file is still readable (q = "") so old indexes keep working.
- Second decision: every ledger WRITE takes a cross-process directory mutex (".shown.json.lock" SIBLING of
  ".shown.json", CreateNew + owner token + mtime-age stale break + owner-only release) in BOTH TypeScript and
  Rust, and the mutation re-reads the map INSIDE the lock. Vitest workers and the Rust server share one root
  ledger, so a language-local mutex loses keys; reads stay lock-free (atomic rename publish).
- Third decision: the TIME AXIS belongs to the CONTENT. The route derives it from the index (durationSec or
  any timed chunk), never from the attachment name/category, so a document discussing a "1:20 aspect ratio"
  cannot be routed to a fabricated video window.
- Fourth decision: comparative asks carry SEPARATE windows (retrieve opts.windows) instead of one hull span, so
  "compare the intro at 0:30 with the recap at 9:00" stops sweeping in everything in between (pinned with a
  positive control on the same from/to pair).
- Fifth decision: retrieval is RAW-FIRST. The previous question is a BOUNDED FALLBACK consulted only when the
  raw question matched nothing at all, instead of being prepended to every short follow-up (which had made an
  unrelated CPU question retrieve whale passages).
- Why general: no phrase whitelist per example. The laws are shared fingerprints (FNV-1a over the normalized
  UTF-8 query), continuation regexes, index self-description and window lists, mirrored byte-for-byte in
  TypeScript and Rust and pinned by the same goldens.
- Cost: an exact repeat re-shows the same passages instead of rotating (the caller can still say "show me
  other passages"), a comparative ask whose cues were never indexed serves nothing instead of a hull, and a
  genuinely topic-following question pays one extra retrieval pass before the antecedent is consulted.
- Pinned: __tests__/server/attach-intent-f07.test.ts (25 TS tests), Rust ruke-attach store(2)+router+retrieve+turn(5)
  tests, plus the untouched rust-golden byte-parity replay suite.

## D-018 (2026-11-16, session 35) - canonical addressable evidence, not a second backup field

The 2026-11-13 preservation law put the pre-filter bytes on `originalPassageText`, and
`git grep` proved no consumer read them: the read_page "retained copy" was built from the
already-filtered view, so `continuation: true` could only ever re-serve what the focus
filter had kept. Chosen fix (mechanism, not example):

- `scanBlocks` now reports exact [start, end) spans of every block (a flushed run is
  always contiguous in the scanned string, only the outer trim moves the ends).
- `filterPassageSegmentsReport` returns text + `changed` + `kept` spans in the LF-normalized
  canonical space; `filterPassageSegments` stays a thin wrapper so every pinned vector
  (retrieval-quality.test.ts) is untouched.
- `EvidencePassage.filterKeptRanges` records surviving spans against the ONE original;
  a second filter hop COMPOSES through `mapSpansThroughKept` instead of re-basing, so
  addresses never drift off the original bytes.
- `RetainedBlock` = canonical bytes + servedRanges + filteredOutRanges + contentHash
  (FNV-1a 32) + stable id ("S3#b2" == block 2 of [S3]). Window arithmetic still runs on
  the working view; served ranges are translated once, at the hand-off.
- Honesty: a focus-pruned page now reports `filteredChars` and `truncated:true`; a
  continuation that hands back pruned bytes reports `recoveredFilteredChars`; the
  continuation path re-hashes the retained bytes and exposes `provenanceMismatch` rather
  than silently serving bytes it can no longer vouch for.
- `mapSpansThroughKept` lives in a new leaf module `lib/web-search/range-math.ts`
  re-exported by segment-filter, because three suites replace segment-filter with a
  test double and address math must survive that double (discovered by a red run).
No envelope strings, citation ids, budgets or fixtures were changed: the model-facing
address stays the block ref (the shipped read_page tool description is byte-pinned in
rust-backend/fixtures/web-search, so it was deliberately NOT edited).


## D-019 (session 36) - F03: typed domain constraints replace the flat cue scan
Decision: the domain-policy law moves OUT of planner-law into a new leaf module
`lib/web-search/domain-constraints.ts`, and planner-law only seeds
allowed/blocked/preferred from `resolveDomainPolicy(deriveDomainConstraints(prompt))`.
Why a separate module: the semantics are testable without importing the
query-planner/metasearch/net chain (native impit binary), and the record type is a
contract other layers (task scope, reranker ranking) can consume later.
Mechanism (no per-example regex anywhere):
- Cue CLASSES, not allow/block booleans: negator / block / exclusion / exclusive /
  prefer / correction. Polarity is composed mechanically, and the NEAREST governing
  cue wins - the retired rule "an earlier block beats a later allow in the same
  segment" is what blocked BOTH domains in
  "Do not use alpha.com, but only use beta.com".
- CONTRAST words are scope terminators, never policy makers. A contrast only ends a
  scope when a cue follows it inside a bounded lookahead (120 chars); a contrast that
  overlaps a cue ("but not") belongs to that cue.
- QUOTATION ROLE is decided by CONTENT, not by quoting: masking blanks quotes, then a
  quoted span re-enters as an occurrence ONLY if its entire trimmed content is a host
  or a bare site: operator (authority "quoted-operand"). Explaining the syntax
  "site:alpha.com" therefore yields zero records, while Only use "alpha.com" binds.
- AUTHORITY is separate from polarity: a typed site: operator is user scoping even
  with no cue; a mention with no cue and no operator is NOTHING.
- POSTPOSED cues (SOV scripts) bind backwards only across pure filler AND only when
  the clause ends right after the cue, which is what keeps English "check X, do not
  use Y" from draping the block onto X. Multiword postpositions are vocabulary, not
  special cases ("ke sirvaay").
- EXCLUSIVITY is its own axis: prefer = ranking; prefer + an exclusivity marker in the
  same scope = wall. "Trust alpha.com, but also consult beta.com" now produces two
  preferences and zero walls.
- Contradiction/correction law: a cancel record retracts a previously recorded policy
  ("Do not exclude X" makes NO policy instead of blocking X; a "Actually ..." clause
  retracts the earlier block) and lands in `withdrawn` for observability.
Deliberate NOT-changes:
- `PlannerLaw` keeps its exact wire shape (allowedDomains/blockedDomains/... + the
  byte-pinned JSON golden in planner-law.test.ts). Provenance/uncertainty stays in the
  constraint layer, NOT in the wire shape, because the plan-consumer contracts
  (route-adblock-law, scope-wave-admission, locale-scope, task-scope-planner,
  destination-affinity, presentation, sufficiency-axes) consume that shape unchanged.
- Vocabulary growth is script-aware word guards, not domain lists: no domain name was
  added to any production rule, and the platform-name map stays a TARGET resolver for
  cues the user wrote (never a default block list - weak sources stay softly ranked in
  reranker.ts).
- planner-law keeps its own `DOMAIN_TOKEN_RE` because `hostOf()` still needs a
  domain-shaped fallback parse for malformed URLs; SEGMENT_SPLIT_RE, SITE_OP_RE,
  ALLOW_CUE_RE, BLOCK_CUE_RE, FENCED_CODE_RE, QUOTE_SPAN_RE, maskNonUserSpans, CuePos,
  tokenPolarity, BLOCK_NAMES_RE and NAME_TO_DOMAIN were deleted (grep: zero references
  anywhere in lib/ or __tests__).

## D-020 (session 37, recorded session 52) - F02: artifact intent is a typed relation
Chosen design (pinned by `__tests__/decision/artifact-intent-f02.test.ts`, 49 cases that
were frozen BEFORE the implementation, red first per `logs/f02-repro-1.log`):
- the scanner records ROLES, not grammar luck: tutorial frame, reported past action,
  negation scope, source-vs-destination role, container role, polysemy guard, quotation
  role, multiple deliverables, desire phrasing / cognitive frame;
- a didactic marker EARLIER than the production cue reclassifies the clause ("explain how
  to create a PDF" asks about producing, it does not request a deliverable);
- an explicit subject + past-tense production verb is a statement about an existing file,
  but a desire verb is exempt, so the polite past ("I wanted a PDF") stays a request;
- negation governs its own phrase only, so "Without using Excel, create a PDF" still
  requests the PDF; "from/based on <format>" marks a SOURCE role, so a docx-from-pdf ask
  is one destination plus one source rather than an ambiguity;
- a container preposition ("summary in PDF") names the deliverable, so an intervening
  content word never vetoes it; "summary of the pdf" stays discussed material;
- a lexeme with a strong competing sense needs its own domain in reach ("deck of cards",
  "garden deck" suppress; "deck of slides", "quarterly deck" route);
- multiple deliverables are recorded explicitly and stay in `standard_chat` because one
  mode validator cannot own two fences - no arbitrary winner, nothing silently dropped.
Rejected: per-example keyword patches, a mandatory extra classifier inference per turn,
and resolving multi-deliverable asks by priority.

## D-021 (session 50) - fix the read site, do not patch the vendored tracer
`npm run build` died in @vercel/nft with an EPERM/GLOBF walk over the whole user profile.
Root cause (bisected, `scratch-s49/nft-*.cjs`): nft treats the raw return of
`os.homedir()` / `process.env.X` as an unresolved filesystem root and emits a glob of the
profile, which then hits `C:\Users\Ruku\Application Data`.
Decision: fix the DATA, not the vendored tool. `lib/persistence/dataRoot.ts` coerces at the
read site (`String(os.homedir?.() ?? "")`,
`String(process.env.USERPROFILE ?? process.env.HOME ?? "")`) - runtime-identical, keeps
WEBUI_DATA_DIR precedence, never moves user data and never sets a global HOME. The vendored
`node_modules/next/dist/compiled/@vercel/nft/index.js` was patched only during diagnosis and
RESTORED to pristine (sha256 prefix `21FDA49AD240564F`); `__tests__/persistence/data-root-tracer.test.ts`
now fails the build if anyone reintroduces a raw assignment that re-opens the tracer hole.

## D-022 (session 52) - external programs are resolved with provenance and validated
`ruke_ml/models/registry.py` asked `shutil.which("ffmpeg")`, so `video.timeline` reported
`not_installed` on a host that HAS ffmpeg twice over (npm `ffmpeg-static`, and Playwright's
`ffmpeg-1011`). That is a capability report that lies in the negative direction, which is
exactly as harmful as claiming a missing tool.
Decision: `ruke_ml/models/binaries.py` resolves in order (explicit `RUKE_FFMPEG` override ->
PATH -> project-local patterns, including `PLAYWRIGHT_BROWSERS_PATH`), and ONLY a candidate
that survives `<program> -version` under a bounded timeout is accepted; on Windows a
non-executable extension is refused outright, so a text file named `ffmpeg.exe` can never
make a capability claim `available`. The published payload carries `source` + a repository-
relative path, and reduces anything outside the repository to its file name, because the
capability panel is browser-visible. `video.scenes.ffmpeg_scene_command()` builds its command
with the SAME validated executable, so the command we advertise is the command we can run.
Rejected: hardcoding a localhost/install-specific path, adding ffmpeg to PATH from inside
the app, and trusting a bare PATH hit.

## D-023 (session 52) - Playwright is the FINAL stage and Codex holds idle during it
Ruke and Codex-local share one Strata endpoint whose serving concurrency is 1 (verified in
the install: `concurrency.serving: 1`). Starting a model-driven UI run while Codex is
thinking breaks both. Decision, already written into `CODEX.md`: Playwright runs last, under
the atomic `.ai-coordination/playwright.lock`, one worker, and while a model-driven run is
alive Codex performs no analysis, no edits and no polling turns - it waits in one long
blocking wait and resumes only after the runner exits, its requests drain and the owner-
verified lock is released. Fixture-driven specs (no Strata traffic) may be watched normally.


## D-024 (session 53) - retrieval stays hybrid; the dense path is measured, not assumed
The brief allows Python/dense retrieval only where measured quality warrants it, so the
comparison was run inside one process, on the frozen corpus (29 chunks / 38 cases), with
the production embedder (Xenova/all-MiniLM-L6-v2, mean pooling, L2 normalize,
embedRevision()="unpinned"). Vectors came from scripts/eval-embed-vectors.ts and were
scored by ruke_ml/eval/methods.py, which REFUSES a vector set that lacks a named model,
declared dimension, declared normalization that is not actually true (norm within 1e-3),
full corpus coverage, no stale ids, or any frozen query.
Measured: dense_only recall@5 1.000 / mrr 0.984 / ndcg@5 0.988, but
abstention_accuracy 0.000 (a dense view has no corpus-support test at all); hybrid
dense+lexical (the shipped RRF law, RRF_K=60, dense 0.6 / lexical 1.0) recall@5 1.000 /
mrr 1.000 / ndcg@5 1.000 / abstention 1.000. Per-language recall@5 = 1.000 for ar, en,
es, fr, hi, ja, te, vi, zh under BOTH methods.
Decision: do NOT migrate retrieval to a dense-only path, and do not claim dense is better.
Honest caveat: this is a small identifier/hard-negative suite, so it cannot rule out dense
gains on paraphrase or long documents; the multilingual candidates (Qwen3-Embedding,
Qwen3-Reranker, BGE-M3) stay asset-blocked and continue to report not_installed rather
than a borrowed score.

## D-025 (session 53) - scene detection gets a read side, and the command is fixed against the pinned build
ruke_ml/video/scenes.py built ffmpeg_scene_command() but NOTHING parsed its output, which
is the "unused helper" the brief forbids. Two further defects were MEASURED against the
pinned ffmpeg 6.1.1 rather than guessed: (1) the command used -loglevel error, and showinfo
logs at AV_LOG_INFO on STDERR, so a correctly-exiting scan reported zero cuts - the most
plausible kind of wrong answer; (2) -vsync v0 is rejected by this build
("Expected number for vsync but found: v0"), which made the scan exit -22 every time.
The command is now -loglevel info -nostats -nostdin ... -fps_mode passthrough, the scan
parses BOTH pipes, and the parser guards the best_eff_pts_time double-count with a
lookbehind while allowing showinfo's padded numbers.
scan_scene_cuts() returns a CutScan that states its own limits: scanned_seconds,
truncated, error (ffmpeg_not_installed / spawn_failed / decode_failed / timeout), partial
cuts kept on timeout, bounded cut count and bounded read, and stream_start_offset applied
so decode stamps land on the presentation timeline. video.scenes jobs with detect_cuts
now feed real cuts into the window plan and put the scan's honesty into Coverage.note.
Measured with ruke_ml/eval/temporal_probe.py on a synthetic clip whose cut schedule is
DECLARED (segments of 3 s): detected cuts [3.0, 6.0, 9.0] against declared [3.0, 6.0, 9.0],
hit_rate 1.000, mean_abs_error 0.000 s, 0 spurious cuts, all 3 declared events inside a
sampled window, exit 0. Hard negative control: threshold 0.99 detects nothing and therefore
FAILS with hit_rate 0.000 over n=3 rather than scoring "no events" as perfect.
Scope, stated so nobody over-reads it: this measures decode clocks, timestamp parsing and
cut detection. It is not evidence about semantic event understanding, and the frozen
temporal_video_localisation family stays not_run until a human-labelled real video is used.

## D-026 (session 55) - the exclusive launcher owns test-data isolation, not the specs
Every previous green e2e run had been writing into the user's real conversation store, because
isolation was nobody's job: the specs seed their own rows, the app resolves its store from
WEBUI_DATA_DIR, and the launcher started the app with whatever environment it inherited. The
fix belongs in the launcher (the only component that both starts the app and knows it is a
test), so it now: resolves a store (-DataDir > inherited WEBUI_DATA_DIR > .data\e2e-store),
REFUSES to run if that store is the real user store, materialises it only after the lock is
held, and exports it before starting the app child so the Rust server and Next inherit one
identical path. Model configuration was checked first and lives in project-root settings.json,
so isolation cannot silently disable the live model. A reused foreign :3000 app is now a
printed warning rather than an assumed-isolated run.

## D-027 (session 55) - Playwright positional args are regexes
Passing 'tests\a.spec.ts' to the launcher produced "Error: No tests found" (exit 1): the
paths are matched as REGEX, so backslash-letter sequences never match. Recorded so nobody
re-tries it: use forward slashes in -TestFiles, and note that a failed selection still ran
the full ownership teardown (owned tree stopped, owner-verified lock released).
## D-028 (session 58) - Rust got a real capability-job client, not only a health reader
ml_bridge.rs only read /health and /capabilities and explicitly never ran a job, so every
Python capability (video.timeline, video.scenes, embeddings, rerank, documents.*) had no
production caller - that was gap G1. Added ruke-server/src/ml_job.rs (23 unit tests): POST
/api/ruke/ml/job with the internal bridge secret, a clamped deadline (1 s..600 s plus a 5 s
grace), typed failure reasons, and a per-capability negative cache so a not_configured
supervisor is not re-queried on every upload. reqwest 0.12.28 has no is_connect_timeout(), so
"nothing listening on the port" is detected with is_connect() and reported as unreachable
rather than deadline_exceeded - the distinction is what keeps the capability panel honest.
TypeScript mirrors it in lib/server/ml-job.ts (mlJob() returns null ONLY when the Rust backend
is disabled, never for a typed failure) so both backends share one contract.

## D-029 (session 60) - durable media baseline; text-less observations never become search clues
Three rules, each pinned by __tests__/attach-timeline-s60.test.ts (26 tests, exit 0):
1. Observations carry real source intervals; a scene observation intentionally has no text,
   and both search_hints.build_hints (Python) and OBSERVATION_KIND_MAP (media-hints.ts) drop
   empty text, so scene anchors cannot put coordinates or the 0.35 cut threshold into
   mediaHintQueries.
2. A truncated cut scan claims only what it examined: horizon = min(scanned_seconds, duration)
   and the unscanned remainder goes to coverage.skipped. A bounded scan can no longer present
   itself as whole-video coverage.
3. attachTimelineDir falls back to a staged copy + rename when rename crosses volumes (EXDEV),
   bounded to 4096 entries / depth 6 and rejecting symlinks, rather than publishing half a
   record.

## D-030 (session 61) - the video extract branch owns one probe and publishes after the switch
extract/index.ts case "video" used to probe ffmpeg twice. It now uses one lazy probe
(probeOnce) shared by the audio-failure path and the baseline builder; buildBaseline runs the
capability-job seam and publishBaseline installs the timeline record under the per-attachment
index write lock AFTER indexContent has switched the generation, discarding scratch on any
failure. Rationale: a durable record must not exist for an index generation that was never
installed, and a second probe costs a second ffmpeg subprocess for zero new information. The
byte-exact coverageNote/transcript assertions stayed untouched and still pass.

## D-031 (session 62) - one commit on the local branch, authorized by the user, no push
The original brief said "Commit unless separately authorized" / do not commit, and sessions 1-61
therefore ran with **zero** commits (every gate ran against the dirty tree, which is why the
FINAL-REPORT work-tree rows quoted 192 porcelain entries). At session 62 the user explicitly asked:
"if the requirement is done can you push the changes into git local branch". Read against the repo
layout (branch `local`, remote `origin` = github.com/saikiran121111/WebUI.git, upstream
`origin/local`), that authorizes **a commit onto the local branch**, not a remote publish, so the
brief's standing "no push / no publish / no deploy" rule still holds. Executed:
```
git add -A -- lib app components hooks scripts __tests__ rust-backend docs python-backend CODEX.md
git reset -q -- python-backend/ruke_ml.egg-info
git commit -m "overnight run P0-P11: admission + streaming + evidence/artifact repairs, python capability jobs, media timeline seam, gates + e2e evidence"
```
-> exit **0**, `HEAD = 5a0370a67c8f8c1d327198adff7409cfa15dc82b`, **385 files changed,
+54720 insertions / -2888 deletions**. Deliberately left out of the commit: `tsconfig.tsbuildinfo`
(incremental build cache), `mcp-out/` (Playwright/MCP page + console snapshots from run debris),
`python-backend/ruke_ml.egg-info/` (setuptools build metadata). `.venv` self-ignores (uv writes a
`.gitignore` inside it); `.data/`, `.ai-coordination/`, `.cache/`, `settings.json` and
`node_modules/` are already gitignored, so no user data or secret entered the commit. A secret
scan of `docs/overnight/logs/*` and `docs/overnight/*.md` (sk- prefixes, Bearer values, api-key
keys, RUKE_BROWSER_BRIDGE_SECRET=) returned **no matches**. No file was deleted or staged to make
the tree look clean; the renamed fixture pair (the ` D` entry plus its new untracked name) was
committed as a rename. Nothing was pushed.

## D-032 (session F09) - document promotion follows a coverage law, not a character ratio
- The TS seam that decides whether a delivered document body comes from the Python capability or
  the retained TS engine used to compare raw character counts (`OFFICE_PROMOTION_RATIO`). A larger
  blob is not better evidence: the Python reader adds per-unit structure, coverage statements and
  named lost items, so the decision is now "does the candidate body preserve content the incumbent
  lost, or group lines the incumbent fragmented".
- `lib/server/extract/document-capability.ts` dedupes content items, computes `lostTokens` and
  `newTokens`, and promotes when `newTokens > 0 || groupedLines > 0`, reporting up to
  `LOST_ITEMS_NAMED = 6` lost items by name. `ContentCoverage{tsLines, capLines}` records which
  body is which.
- Consequence proved at HTTP level: the docx case now delivers `Payments | Ana` and `Ledger | 99.9`
  (defect #2 closed) instead of a flattened blob.
- Evidence: `__tests__/server/extract-document-capability.test.ts` (37 tests),
  logs/f09-vitest-focused-1.log, logs/f09-dev-1.log.

## D-033 (session F09) - rendering lives beside the blocks, never replaces them
- `python-backend/ruke_ml/documents/render.py` renders one line per block with the identity the
  reader parsed (cell ref, merged range, table/row/cell list, unit headers for worksheet/slide/table
  counts, explicit "this reader did NOT extract" lists). The block list stays the source of truth;
  `render_units()` output is a derived view with `engine`, `provenance`, `blocks` and `truncated`
  fields, so a truncated rendering can never imply the blocks disappeared.
- Test: `python-backend/tests/test_document_render.py` (11 tests).

## D-034 (session F08) - the worker frame protocol is bytes, with the codec pinned
- Symptom: a job whose text contained non-ASCII failed as "worker closed its output stream mid-job".
  Root cause: `runner._emit` wrote through the locale ANSI codec on Windows, the write raised
  `UnicodeEncodeError` inside a swallowed handler, and the reader saw a torn stream.
- Fix: `runner._emit` writes UTF-8 through `sys.stdout.buffer`; `config.child_env` pins
  `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` for every child; `lifecycle._spawn` opens pipes with
  `errors="replace"` so a hostile child cannot wedge the supervisor's reader thread; crash messages
  now carry a bounded stderr tail (`Owned.drained` event + `_worker_stderr()`).
- Test: `python-backend/tests/test_worker_protocol.py` (cp1252-codec frame survival, legacy
  text-write regression guard, lone-surrogate handling, real WorkerPool unicode round trip).

## D-035 (session F09) - pipe fd lifetime: stdout always closes, stdin only after the child is gone
- `lifecycle._pump` used to close *both* streams when the reader loop ended. Closing **stdin** from
  the reader thread while the worker was still alive made
  `tests/test_contracts_security.WorkerOwnership.test_a_worker_that_announces_a_dead_control_channel_fails_fast`
  fail with "worker pipe failed: I/O operation on closed file", which replaced the real diagnosis
  with an artifact of our own cleanup.
- Rule now: the reader closes stdout unconditionally (it is the read side of a finished stream), and
  closes stdin only when `o.proc.poll() is not None`, i.e. after the child is actually gone;
  `_terminate` closes stdin in its `finally` once termination is confirmed. A module-level
  `_close_stream()` helper does the swallow-and-log close so the two call sites cannot drift.
- This is a real Windows handle-semantics decision, not a test accommodation: an open stdin on a live
  child is a live keep-alive, and closing it from the wrong thread races with the child's own reads.

## D-036 (session F11) - model-led intent, code-led processing; ownership recorded not re-litigated
- The mid-run amendment (SPEC section 13) is authoritative for routing conflicts. It was applied at a
  checkpoint: no job was mid-flight, nothing was discarded, and the uncommitted sessions 63..F10 work
  (document/speech/video adapters, AdapterReadiness, capability seam, byte protocol) is preserved.
- Boundary: the model decides *what* is wanted; code decides what the input contains, what can
  execute, what prerequisites are required, and how authorized work runs. Evidence-based
  auto-processing stays in code, so "PDF uploaded" does not imply "run OCR" and "video uploaded"
  does not imply "ASR + OCR + align + diarize".
- Deliverable `docs/overnight/DECISION-OWNERSHIP.md` names, per component: the semantic decision
  owner, the structural executor, the production caller and the verification status, with
  legacy/unreachable paths marked separately.
- Phrase matchers are retired only after their replacement production path works; enums, schemas,
  magic-byte checks, validators and scheduling rules are kept as legitimate constraints.

## D-037 (session F12) - held-out fixture generator bugs fixed, not reader assertions
- Two defects were in the *fixture authoring*, discovered because the reader produced an empty
  result for a fixture that the independent answer key says must contain facts. Both were verified
  against the OOXML/PDF specifications, not against reader output.
  1. xlsx: `ho_docs.py` wrote `<sheet r:id="rIdA">` while the rels part defined `rId1`. Every xlsx
     fixture therefore resolved to a missing sheet part and produced `units_failed=[1]` plus zero
     blocks. `_rels()` now takes `first_id`, and the three workbooks pass `first_id="rIdA"`.
     The reader is now explicit about this class of corruption: `_xlsx` records
     `meta.sheet_failures` entries `{sheet, sheet_index, part, why}` for (a) a relationship id that
     the rels part does not define, (b) a sheet part missing from the package, and (c) a sheet part
     that is not well-formed XML. Previously (b)/(c) shared one `except (KeyError, ET.ParseError)`.
  2. PDF: the bare font dict omitted `/Encoding`, so pypdf used StandardEncoding, which maps byte
     0x27 to U+2019. `'kestrel'` came back as `’kestrel’` and a verbatim answer-key fact failed.
     The font now declares `/WinAnsiEncoding` and the fixture text comment was corrected.
- Answer-key convention recorded here so it is not mistaken for a weakened assertion: when the key
  omits an id list (`units_succeeded`, `units_needing_ocr`, `units_empty`, `units_failed`), the
  reader must report that list **empty**. A missing key entry is a claim of absence, not a wildcard.
- No existing assertion was relaxed. `Ran 220 tests, OK` exit 0 (logs/f11-python-full-1.log).

## D-038 (session F12) - second mid-run amendment: quality-first CPU OCR, hard memory budget
- Incorporated into SPEC section 14 at this checkpoint without discarding in-flight work.
- OCR: the complete **PaddleOCR-VL 1.6 pipeline** (layout analysis + element recognition +
  structured assembly) is the intended primary; it must be verified for this runtime and then
  **pinned** (release, model revision, dependencies, config). Ordinary PaddleOCR text recognition
  may never be labelled PaddleOCR-VL. **Tesseract is the recovery fallback only**; a successful
  Tesseract result does not establish that the primary met its requirements, and it may not claim
  equivalent formula/table/layout fidelity.
- Strictly **CPU** for all new document/media/ML workers: no automatic CUDA/DirectML/GPU selection,
  no GPU OCR fallback, and no routing OCR through the main LLM's GPU. The main LLM configuration
  and its GPU allocation are untouched. The selected device must be validated and zero new GPU
  compute allocations observed during processing.
- Bounded comparison only: the documented CPU primary, at most one memory-efficient CPU variant if
  necessary, and Tesseract. Reduced precision, quantization, tiling or resizing must be evaluated
  for fidelity and never described as automatically lossless. Any configuration that cannot fit or
  run on this Windows host is documented as a measured blocker.
- Runtime memory budget: target **4,000,000,000 bytes**, hard maximum **5,000,000,000 bytes** for
  the combined Ruke runtime plus processing children (Next, Rust, Python, renderers/converters,
  FFmpeg, OCR services, other job children), **excluding** the existing main LLM and this coding
  agent. Dedicated browser-test overhead and build-time usage are reported separately. Resident and
  committed/private memory are defined explicitly; swapping and misleading aggregates are not
  evidence. Measure baseline, cold-load peak, processing peak and post-job release.
  Heavy workers are serialized; page/region processing is bounded; intermediates are disk-backed;
  the primary OCR job is released before the fallback runs. Where an enforceable OS limit is not
  available for the aggregate, that is reported as an acceptance failure rather than hidden.
  Pages, video duration, resolution and small-text quality are never silently dropped to fit; a
  typed resource-limit result is returned instead.
- Native reading first: PDF/DOCX/PPTX/XLSX native structure is preserved and OCR is chosen per
  page/region from measured evidence; legacy DOC/PPT use a tested CPU conversion path if one exists,
  otherwise an honest unsupported-format status.
- Fallback ladder per failed/deficient unit: primary OCR with the validated config -> at most one
  targeted deterministic repair (orientation, bounded tiling) -> on missing assets, crash, timeout,
  memory rejection or failed output validation stop and release the primary job before Tesseract is
  attempted for that unit. Successful units are preserved; unresolved units stay marked unresolved.
  Structured results carry backend/model/version, processing state, page/region provenance, actual
  coverage, fallback reason and limitations.


## D-039 (session F13) - the held-out ANSWER KEY had an unsatisfiable scoring group, not the reader
- `ho-inventory.xlsx` scored `accept_any_of` as a list of independent single-item groups, which
  demanded that one sheet satisfy two mutually exclusive claims at once. Fixed to a single
  OR-of-AND group (`accept_any_of = [[...facts...]]`), matching how every other fixture entry is
  written. The reader assertions and the delivery-layer criteria were not changed; the reader still
  has to deliver the facts, it just no longer has to contradict itself.
- Held-out HTTP score after the fix: 8 fixtures, 0 misses, exit 0
  (`docs/overnight/logs/f09-heldout-2026-11-16T142705900Z.json`).

## D-040 (session F13) - CPU device policy for CTranslate2, project-local HF asset root
- `speech/whisper_ct2.py::device_choice` now defaults to `("cpu", "int8")`. GPU is never
  auto-selected: the host GPU belongs to the main LLM and amendment 2 forbids new GPU compute for
  document/media workers. An operator override exists only through `RUKE_ML_DEVICE` /
  `RUKE_ML_COMPUTE_TYPE`, an invalid value falls back to cpu, and the chosen pair is reported in the
  job result so the claim is auditable rather than assumed.
- `models/assets.py::hf_hub_root()` resolves `$HF_HOME/hub` when set, otherwise
  `<repo>/.data/ml-cache/huggingface/hub`, and `config.child_env` pins `HF_HOME` for every owned
  worker. Preparation, readiness and runtime therefore read the same project-local root; an
  inherited user cache can no longer satisfy (or fake) an asset claim.

## D-041 (session F13) - model revisions are pinned in the registry and validated at asset level
- `Systran/faster-whisper-base` is pinned to revision
  `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66` in one place (`registry.SPEECH_REVISION`), used by both
  the `speech.asr` and `speech.align` rows. The duplicate `revision="unpinned"` asr row was removed:
  two rows for one asset made "prepared" ambiguous.
- `assets.asset_state(model_id, expected_revision=...)` refuses a snapshot whose directory name is
  not the pinned revision, with an explicit mismatch message; `Catalog._pinned_revision` maps the
  sentinel values (`""`, `unpinned`, `not-migrated`, `builtin`) to "no revision claim" so
  `assets_validated` cannot silently pass a stale snapshot.
- Consequence recorded here: `npm install @ffprobe-installer/ffprobe` added a dependency to
  `package.json` / `package-lock.json` (uncommitted). `models/binaries.py` resolves that copy
  (validated by running `-version`, not by PATH presence). This made the previous
  `ffmpeg_not_installed`/ffprobe-missing blocker disappear for real: ffprobe is now project-local.

## D-042 (session F14) - third mid-run amendment: OCR engines must be prepared AND executed
- Incorporated as SPEC section 16. Key correction to my own earlier position: **a missing
  downloadable asset is preparation work, not an external blocker.** "Not downloaded yet" is not an
  acceptable final blocker; the exact attempted command and its failure output are.
- Sources supplied by the user and treated as the authoritative entry points (each must be read,
  its actual asset links resolved, and never guessed):
  - `https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6` (recognition/VL component)
  - `https://huggingface.co/PaddlePaddle/PP-DocLayoutV3` (layout component)
  - `https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PaddleOCR-VL.html` (pipeline + CPU install)
  - `https://tesseract-ocr.github.io/tessdoc/Installation.html`,
    `https://github.com/UB-Mannheim/tesseract/wiki` (Windows build),
    `https://github.com/tesseract-ocr/tessdata_best` (language data)
- Project-local layout for this work: `.data/models/ocr/` (assets + pinned manifests),
  `.data/tools/tesseract/` (+ `tessdata/`), `.data/cache/`, `.data/tmp/` (downloads/scratch),
  `python-backend/.venv/` (or an isolated `python-backend/.venv-ocr/` wired into the worker
  launcher when dependencies genuinely conflict). No system-wide Tesseract; no HOME/USERPROFILE/
  CODEX_HOME changes; existing external caches are neither relocated nor deleted.
- Status vocabulary for OCR: preparation evidence (downloaded, versioned, validated) is separate
  from execution evidence (a real page rendered and read), which is separate from production-caller
  evidence (the upload path actually invoking it). GREEN requires all three plus measured memory
  and zero new GPU allocations.


## D-043 (F17/F18) - the Python ASR adapter is now the PRODUCTION owner of audio transcription
- `lib/server/extract/speech-capability.ts` calls the Python `speech.asr` capability
  (`SPEECH_ASR_DEADLINE_MS = 240000`); `lib/server/extract/index.ts::deliverSpoken`/`case "audio"` and
  the video branch call it **before** any retained TypeScript path. `normalizeAsr` drops malformed
  segments into `droppedSegments`, refuses a `ready` result that has nothing inspectable as
  `contract_mismatch`, and re-bases chunk offsets onto source time.
- The retained TS whisper path stays as an explicitly labelled fallback; when it runs, only its
  blocker line is appended, and the engine note names only the engine that actually ran.
- Verified live (CPU, zero new GPU compute apps): word error rate 0.0769 on the explicit-English clip
  and 0.0 on the container-with-audio clip, worker peak working set 388.0 MiB
  (`logs/f18-e03-1.log`, `logs/e03-speech-20261116T16564630343.json`).
- Measured limitation kept on the record: the ASR emitted `. . . . . .` for a non-speech tone. There
  is no content-type classifier, so silence/music/no-track stay distinguished by probe + loudness
  evidence, not by pretending the transcript is meaningful.

## D-044 (F20) - structural ASR failures never trigger a second engine; retryable ones do
`STRUCTURAL_REASONS = unsupported_input | input_rejected | corrupt_input | unsupported_language`.
A structural reason means the request itself was wrong: retrying with another engine would either
waste a heavy worker or produce a fake transcript, so the extraction throws instead. Cancellation
aborts the extraction. Only backend/resource reasons fall through to the retained TS path.

## D-045 (F20) - regression found and fixed in the XLSX cell formula notation
An uncommitted edit had collapsed `A1==SUM(A2)` to `A1=SUM(A2)`, breaking two tests that were already
green (`__tests__/server/extract-office-cells.test.ts:56`, `extract-office-structure.test.ts:73,76`).
Restored `${ref}=${flat}` with a comment: the value's own leading `=` is what distinguishes a formula
from a text cell that happens to start with `=`, so collapsing it silently destroys the type
information. Verified: office cells/structure + document-capability = 57 tests pass.

## D-046 (F20) - retrieval ownership: TS stays the production owner, Python is implemented but unwired
- `lib/server/attachindex/retrieve.ts` + `embed.ts` remain the production retrieval path, because the
  Rust/TS retrieve parity fixtures assert **byte-exact** block output
  (`store_compat fixture_01_rust_block_is_ts_block_byte_exact`); an async Python rerank call inside a
  synchronous, deterministic retrieve would break that contract, not just slow it down.
- `python-backend/ruke_ml/retrieval/nn_embed.py` and `reranker.py` are real adapters (not lexical
  stand-ins), the MiniLM asset is pinned, and the adapter has been EXECUTED standalone on CPU.
  They have **no production caller**, so area G's *migration* status stays ORANGE/RED even though
  *functional* retrieval is GREEN. This is the "retained owner, migration incomplete" case the
  amendment requires to be reported as such.

## D-047 (F20) - measured neural weakness: dense MiniLM ranks the wrong NUMBER, and the fix is fusion
The answer key was written before the probe. Running the pinned ONNX model
(`Xenova/all-MiniLM-L6-v2`, sha256 `759c3cd2...c469c46e`, dim 384, mean pool + L2, CPUExecutionProvider,
peak RSS 164 MiB) scored **7/9**: it chose "61 crates" over the correct "99 crates" for a numeric-fact
question, and the neural bi-encoder rerank inherited that error. In the same probe the lexical BM25
channel ranked the numeric-correct candidate first.
- Decision: **keep the failing check failing.** It is now the documented reason the hybrid RRF fusion
  exists (justified by measurement, not taste), and the reason a cross-encoder is still required for
  numeric precision. Not weakened, not moved to a "known-limitation pass".
- The cross-encoder request was correctly *refused* rather than silently answered by the bi-encoder.

## D-048 (F18) - memory: an enforceable OS ceiling plus a resident-RAM admission gate
- The 5,000,000,000 B hard maximum is enforced with a Windows **job object** on the supervisor tree
  (children inherit at create time) plus a per-worker private job ceiling - polling alone was rejected
  as insufficient.
- A **resident free-RAM admission gate** refuses a weight-loading worker *before* it can page the main
  model, returning `memory_pressure` (retryable) with the numbers and what would change the answer.
  Native readers (measured 22 MiB peak commit) are not refused for RAM they do not use.
- A heavy worker's commit ceiling is clamped to `free physical RAM - floor`, which is a resident-RAM
  guarantee because commit >= resident set.
Why this exists at all: `strata.exe` holds a 52,217 MiB working set and the host had **3.66-6.4 GiB
free**, so the 5 GB budget only "fits" by paging. Full measurement and the quality-preserving
`--ram-keep-gib` lever are in `STRATA-RAM.md`; the config was **not** changed (that requires restarting
the endpoint this session shares).

## D-049 (F19) - resource-aware device placement + the cross-client LLM handoff lease (amendment 5)
- `models/devices.py` computes a device plan from measured free RAM, free commit and measured free VRAM,
  with an explicit `needs_handoff` flag; `ruke_ml/handoff.py` implements the exclusive lease,
  heartbeat, journal, phases, unload/restore of the main model through Strata's lifecycle endpoints,
  and `recover()` for an interrupted handoff after a supervisor restart.
- The SAME lease file is consulted by Rust (`ruke-core::admission`, wired in `ruke-server/src/main.rs`
  with `UpstreamAdmission::with_lease`), by TypeScript (`lib/server/coordination/llm-lease.ts`, used by
  `lib/server/extract/audio.ts` so it never unloads a model a Python handoff already parked) and by
  Python. A Playwright lock outranks the handoff.
- The OCR cascade never requests a nested lease when it is already inside one
  (`inside_handoff=True` + `device_override`), because a nested lease deadlocks against its own holder.
- `ocr_paddle_worker.py` echoes the device paddle actually resolved and the parent **refuses** a
  mismatch against the plan; a plan that said cpu and an echo of gpu is never reported as success.
- Mechanics are unit-tested (`python-backend/tests/test_handoff_devices.py`, 769 lines, plus
  `test_memory_policy.py`, `rust-backend/crates/ruke-server/tests/handoff_lease_gate.rs`,
  `__tests__/server/llm-handoff-lease.test.ts`). **The live load/unload run is held by user
  instruction** (amendment 6) and therefore the feature is not GREEN.

## D-050 (F19/F21) - the OCR pipeline is PREPARED, and preparation is recorded as preparation
- Isolated interpreter `python-backend/.venv-ocr` (created by `scripts/prepare-ocr-runtime.ps1`, uv
  cache project-local at `.data/cache/uv`): `paddlepaddle==3.2.1` from the documented CPU wheel index,
  `paddleocr==3.6.0`, `paddlex==3.6.1`, `opencv-contrib-python==4.10.0.84`, plus the full resolved set
  recorded in `.data/models/ocr/ocr-runtime.json` (`freeze` array).
- Independent static probe (`logs/f19-paddle-device-1.log`):
  `{"paddle": "3.2.1", "compiled_with_cuda": false, "device": "cpu", "mkl-dnn": false}` - i.e. the
  pinned build physically cannot select a GPU provider, which is the honest answer to amendment 5's
  GPU preference: GPU placement needs a CUDA-enabled pinned build, and `RUKE_OCR_ALLOW_GPU=1` alone
  cannot conjure one.
- Both pinned snapshots verified **present with real blobs** (not LFS pointers):
  `PaddlePaddle/PaddleOCR-VL-1.6 @ 132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd`,
  `model.safetensors = 1,917,255,968 B` (listed on disk), plus tokenizer/processor/config/modeling
  files; `PaddlePaddle/PP-DocLayoutV3 @ 241f8bdfc77a7c7bee915a5057aaee58c235a8d3`,
  `inference.pdiparams = 130,806,572 B`, `inference.json = 1,196,890 B`.
  Readiness probe `logs/f21-ocr-readiness-1.log`: `"ready": true, "blockers": []`.
- Tesseract is project-local and real: `.data/tools/tesseract/tesseract.exe`,
  `tesseract v5.5.3.20260724`, languages captured from `--list-langs` = **eng, osd only** (reported as
  such, never inflated). Rasterizer `pypdfium2 5.6.0`.
- **Real fallback execution happened** (`logs/f19-tesseract-exec-20261116T223657.json`): an
  independently authored two-page answer key, rasterised at 200 dpi, read by the project Tesseract at
  **word_error_rate 0.0** on both pages (25 ref / 25 hyp words, mean engine confidence 0.9631,
  `missing_content_words: []`). That is engine-level execution evidence; it is NOT yet a triggered
  fallback inside a production upload, and NOT primary-engine evidence.
- Open honesty item: `ocr_runtime.cpu_only_verified` reports **false** because the manifest was written
  with `-ManifestOnly` (no probe, to avoid a multi-GB framework import on a host with 6 GB free), while
  the CPU claim is independently evidenced in `logs/f19-paddle-device-1.log`. Do not hand-edit the
  manifest; re-run `scripts/prepare-ocr-runtime.ps1 -ManifestOnly -Probe` when RAM permits. Runtime
  enforcement (the worker device echo) is what actually protects CPU placement today.

## D-051 (F20) - two full-suite failures were load-flaky, not product regressions
`attach-turn-budget` and `hardening-audio` ("GPU present but busy") failed in the first full vitest run
and passed in isolation and in the clean second full run (2461 pass / 19 skip / 0 failed). Recorded as
environment/load sensitivity; the second run is the one quoted, with this note attached rather than
presented as a clean suite that never had a problem.

## D-052 (F21) - scope actually held, and the shutdown decision
Per amendment 6 the live OCR run and the live Strata unload/reload acceptance are held until the user can
watch them; diarization remains blocked on pyannote licence acceptance (never accepted on the user's
behalf); the artifact writers remain a retained TS owner. The overall verdict is therefore **PARTIAL**,
and the authorized normal shutdown (`shutdown.exe /s /t 0`) is the last action after the docs flush.

## D-053 (F22-F23) - a frozen D1 OCR corpus, cascade coverage honesty, and real frame-OCR wiring
- The D1 corpus (`docs/overnight/fixtures/d1/`) is frozen with `answer-key.json`
  (`key_version d1-ocr-1`, `authored_before_engine_run: true`, thresholds fixed before any result:
  primary WER <= 0.10, fallback WER <= 0.15, coverage fraction 1.0). Five PDFs: `d1_native` (text
  layer control), `d1_scanned`, `d1_mixed`, `d1_rotated_scan`, `d1_scan_nolang`. The key itself states
  the limit: clean synthetic renders at 200 dpi establish routing, page attribution, fallback selection
  and coverage honesty - **not** general OCR quality.
- Genuine-scan construction fix: a referenced-but-never-drawn `/XObject` renders as a **blank page**,
  which would have made every "scan" fixture worthless. `ocr_docs.py` now emits a real content stream
  (`q W 0 0 H 0 0 cm /Im0 Do Q`) so the page actually draws the raster. The same file records the
  failure mode as a comment so it cannot silently return.
- `documents/ocr_cascade.py` reports coverage honestly instead of reporting "some text produced":
  `engines_used`, `units_unresolved` (pages whose state is not `recognised`/`empty`) and
  `units_not_read` (pages in state `skipped`). A nonempty text result is no longer treated as complete
  extraction.
- `video.frame_ocr` is a real capability on both sides: the Python worker dispatches it
  (`workers/runner.py:363,392`, gated like `documents.ocr`) and the TypeScript timeline stage calls it
  (`lib/server/attachindex/timeline.ts:82` onwards, `FRAME_OCR_MAX_FRAMES = 12`, 180 s deadline,
  4 000-char text cap) producing a `FrameReadOutcome` with `recognised` counts. Plan/decode/OCR-read
  coverage stay separate.
- Language truthfulness: `documents/ocr_tesseract.py:122-143` maps a requested ISO tag only onto
  language data the engine actually has, read live from `--list-langs`; an unmappable tag is refused
  ("refusing to run it with a different language and present the result as that language"). There is
  no silent English fallback anywhere in the OCR path.
- Status strings name the engine that actually produced the content (`tesseract@5.5.3.20260724/eng`),
  never an aspirational `paddle:pending` as if it were evidence of a run.
- Rust gate: 351 passed (`logs/f23-cargo-4.log`, run from `rust-backend` with
  `--target-dir D:\Projects\WebUI\target-ci`). One earlier cargo failure
  (`internal_completion::tests::dropped_handler_future_while_queued_leaks_nothing`) did not reproduce in
  the clean run and is recorded as load sensitivity, not fixed-away.

## D-054 (F24-F25) - a real safety incident in the handoff lease, and what it changed
- **What happened:** the stale-lease breaker in `python-backend/ruke_ml/handoff.py` used to terminate
  the process named by the stale pid. The staleness test was pid liveness only. Under **pid reuse** the
  number can belong to an unrelated live process, and one such process (pid 6088, a VS Code helper) was
  terminated by my probe. The VS Code family (15080/16644) survived and the editor still works; Strata
  (5272 and its pythons), the node dev process and this session were unaffected. This is recorded as a
  safety failure of my code, not a product feature.
- **Fix (applied, F26):** the process-killing path is gone entirely. `_terminate_holder()` is deleted,
  `import ctypes` removed. `acquire(break_stale=True)` now only unlinks a **provably** stale lease
  record (generation mismatch, including the pid-reuse case detected via `pid_created`), touching no
  process. Two regression tests lock this in:
  `test_stale_by_pid_reuse_breaks_the_record_and_touches_no_process` (spawns its own child, leases its
  pid with a wrong creation time, breaks the record, asserts the child is still alive, then terminates
  only the child it owns) and `test_the_lease_module_has_no_process_termination_path` (greps the module
  and fails if `TerminateProcess`, `OpenProcess`, `os.kill`, `_terminate_holder` or `import ctypes`
  ever come back).
- The J4 probe scenario `stale_holder_broken_with_proof` was rewritten to be deterministic and now
  checks 10 things, including `innocent_process_not_terminated`. Safe set: **14 scenarios, 0 misses**
  (`logs/j4-safe-console-2.txt`, `logs/j4-handoff-20261117-052759.json`); the five attended scenarios
  each ran only their refusal guard (1/1) because they unload the shared main model.
- Probe self-validation is what caught the d1 page-collapse bug (a fixture that claimed to be a scan
  but rendered blank); the control checks are part of the probe, not an afterthought.
- **Typecheck lesson:** `normalizeDocument` began emitting a required `rotation` field on
  `ocr.pages[*].raster`; `npm run typecheck` went to exit 2 with six pre-existing fixture literals
  missing it. Fixed by adding `rotation: null` to all six, then typecheck exit 0
  (`logs/f25-typecheck-2.log`) and that suite 48/48 (`logs/f25-vitest-doccap-3.log`). Rule recorded:
  adding a required field to a produced shape means re-running typecheck in the same session.
- Added an operator readiness CLI: `python -m ruke_ml.documents.ocr_cascade` prints the full readiness
  JSON (both engines, pins, snapshots, rasterizer, policy) and exits 0 only when the **primary** engine
  is ready (`logs/f25-ocr-readiness-1.log`). The provisional peaks are printed with the words "NOT yet
  measured", which is the honest state.
- Two operator wrappers were written for tomorrow's attended runs (`scripts/run-handoff-acceptance.ps1`,
  `scripts/run-ocr-acceptance.ps1`) and were **only** DryRun/parse-validated
  (`PARSE_ERRORS=0`, `logs/f25-handoff-wrapper-dry.log`, `logs/f25-ocr-wrapper-dry.log`). Both refuse
  unattended unload: they exit 2 with a reason unless `-Attended`/`-AllowUnload` **and**
  `-ConfirmUnload UNLOAD` are given.

## D-055 (F26) - what the user asked for at the end of the night, and the split it implies
- Instruction: finish everything **except** the OCR live run and the Strata unload/reload live run,
  because those need the user to watch the screen; then shut the machine down. So those two acceptance
  groups stay **HELD**, their code stays written and unit-tested, and no GREEN status is claimed for
  them. Verdict stays **PARTIAL**.
- Completed unattended this session: full Python suite (375 tests, OK, exit 0, `logs/f26-python-1.log`);
  D-054 fix + regression tests + deterministic probe (already in the tree, verified by grep that
  `handoff.py` contains no termination call); the J4 safe set; the operator readiness CLI; both
  operator wrappers; the project-local Tesseract preparation/verification script (below); full vitest
  twice, and the documentation flush.
- New `scripts/prepare-tesseract-runtime.ps1` (closes a real reproducibility gap: the fallback runtime
  had been installed by hand in F16 with no way to rebuild it). It carries the pins recorded from that
  run (UB Mannheim setup exe URL + 26,573,224 B + our own sha256; `tessdata_best` `eng.traineddata`
  URL + 15,400,601 B + our own sha256), stages downloads under `.data/tmp/tesseract-stage`, checks free
  disk, does 3 bounded retries, verifies size + magic + digest before running anything, installs with
  `/S /D=<project path>` only, keeps the installer's `tessdata_fast` file instead of deleting it, and
  rewrites the provenance manifest from values it actually verified. `-VerifyOnly` runs the existing
  runtime in place (`--version`, `--list-langs`, then a REAL rasterise-and-read of page 1 of
  `d1_scanned.pdf` scored against answer-key words): **exit 0**, `tesseract v5.5.3.20260724`,
  languages `eng, osd`, 34 words read with 20/20 key words present
  (`logs/f26-tess-verify-5.log`). Two bugs found while validating it: the rasteriser used `to_pil()`
  which needs Pillow (not installed) so it now writes a binary PPM with numpy, and `ErrorActionPreference
  = 'Stop'` turned tesseract's stderr progress lines into a terminating error, so the preference is
  narrowed for that call only. The pinned URLs were also re-fetched today and their size/digest/magic
  re-checked (`logs/f26-tess-pin-recheck-1.log`: both `size_match=True`, `sha_match=True`, MZ header
  for the setup exe). The install branch itself was **not** re-executed today: a working project-local
  runtime is already installed and re-installing unattended near shutdown is an avoidable risk.
- Full vitest: run 1 `logs/f26-vitest-1.log` = **1 failed / 2476 passed / 19 skipped**, the single
  failure being the already-documented load-sensitive case `hardening-audio` > "GPU present but busy
  and no unload hook -> stays on CPU"; that file passes **9/9 in isolation**
  (`logs/f26-vitest-audio-isolated.log`) and the clean second full run
  `logs/f26-vitest-2.log` = **2477 passed / 19 skipped / 0 failed**, exit 0. Both runs are reported;
  the clean one is quoted as the gate, with the flake attached rather than hidden (same treatment as
  D-051).
- Decision at the end: after the docs flush, no owned jobs, no lease and no journal, the authorized
  normal shutdown (`shutdown.exe /s /t 0`, never `/f`) is the last action. An accepted shutdown command
  proves a shutdown **request**, not an observed power-off.

## D-056 (F27) - the rerank capability now has a REAL neural cross-encoder, plus asset provenance

- **What was RED.** `rerank` had only (a) BM25 labelled lexical, (b) a dense **bi-encoder** reusing the
  MiniLM embedder, and (c) a refusal for anything cross-encoder shaped, because no cross-encoder asset
  was pinned. The brief's rule - never relabel lexical/bi-encoder as neural, and validate against the
  **actual pinned backend's** API - meant the honest status was RED for cross-encoder scoring.
- **Asset actually obtained and pinned** (authorized preparation process, project-local, log
  `logs/f27-rerank-download-1.log`): Hugging Face **`Xenova/ms-marco-MiniLM-L-6-v2`** (the ONNX export of
  upstream **`cross-encoder/ms-marco-MiniLM-L-6-v2`**), commit
  **`a09144355adeed5f58c8ed011d209bf8ee5a1fec`**. On disk:
  `.data/models/Xenova/ms-marco-MiniLM-L-6-v2/onnx/model.onnx` = **90,992,115 B**,
  sha256 **`c623d0bcb99f4622beb413eaef00cfbe5db20df9f1dd982da4b4f26022881870`**, plus
  `tokenizer.json` (711,396 B), `vocab.txt`, `config.json`, `tokenizer_config.json`,
  `special_tokens_map.json`. Staged through `.data/ml-cache/huggingface`; inference downloads nothing.
- **Runtime identity is the bytes, not a tag.** `retrieval/nn_rerank.py` pins that sha256 and
  re-verifies it before every session creation; an incomplete download (below 90,000,000 B), a missing
  tokenizer, or a digest mismatch raises `CrossEncoderError(reason="model_unavailable")`. It refuses a
  session whose first provider is not `CPUExecutionProvider`. No GPU compute for processing jobs.
- **Protocol matched to the checkpoint, not invented.** `[CLS] query [SEP] passage [SEP]` pair
  tokenization, the graph's declared `input_ids/attention_mask/token_type_ids`, one logit per pair,
  sigmoid into (0,1), `max_tokens=256`, batch 16, tail truncation **counted and reported** in the payload
  (`truncation_note`) rather than hidden. Bounded threads (inter=1, intra<=4).
- **The registry row matches the code** (`models/registry.py`): id/revision/provider/package/adapter/asset
  are the same values the worker imports, `languages: []` with an explicit English-MS-MARCO
  `language_note`, and `verified` records only what was measured. Notably it records
  `beats_dense_biencoder_on_g05_set: False`, `numeric_fact_case_fixed: False` and
  `production_caller_wired: False` - three things a status-string edit would have hidden.
- **Measured, on this host, before any implementation claim** (`logs/f27-g05-rerank-2.log`, exit 1 by
  design - see the failure below): mechanics 7/7 PASS (probability bounds, CPU-only providers,
  reproducible ordering, digest verified at load, >256-token truncation reported, missing asset raises
  instead of substituting, unknown mode refused). Quality on a **frozen n=10** hand-authored set spanning
  6 domains whose expected answer was fixed **before any engine ran**: cross-encoder top-1 **9/10**,
  top-3 10/10, MRR **0.950**; bi-encoder 9/10, 0.950 (a **tie**, so no parity claim); lexical 7/10, 0.850.
  Latency: cold load + 4 pairs 0.29 s; 30 reranks of 4 candidates 481 ms.
  `peak_working_set_mib = 267.7` for the whole probe process (both ONNX sessions plus
  numpy/onnxruntime/tokenizers) - the registry's `est_peak_mib 268` is that figure, described honestly,
  not an isolated single-engine number.
- **The motivating failure is STILL a failure and was not weakened.** The g04 numeric-fact case ("how
  many crates arrived at the depot on Tuesday") ranks the wrong number first for the cross-encoder
  exactly as it did for the bi-encoder and BM25 (`g04_numeric_case: cross_encoder_rank=2`), so the probe
  exits 1 and the registry says `numeric_fact_case_fixed: False`. A reranker only reorders candidates it
  was given; it cannot recover dropped evidence, and that sentence is in the returned `coverage.note`.
- **A second engine at the same size class, deliberately not a model-search exercise.** MiniLM-class was
  chosen because it fits the RAM budget (268 MiB measured) and executes here; Qwen3-Reranker stays
  `revision="unpinned"` and is **not** executable in the registry, so "available" cannot mean it.
- **Provenance gap closed for every prepared asset.** `models/assets.py` gained
  `prepare_local(...)` which writes `asset-manifest.json` (model id, pinned commit, retrieval time,
  staging cache, per-file bytes + sha256), and `models/prepare.py` gained `--local`.
  `python -m ruke_ml.models.prepare --model Xenova/ms-marco-MiniLM-L-6-v2 --local` now exits 0 and
  produced `.data/models/Xenova/ms-marco-MiniLM-L-6-v2/asset-manifest.json`
  (`logs/f27-rerank-prepare-2.log`). Previously the MiniLM **embedder** asset had no origin record on
  disk at all - the pin lived only in source. That is fixed by the same mechanism.
- **Why G3 is still ORANGE, not GREEN.** There is **no production caller** of the Python `rerank`
  capability: the Rust ml-job allowlist (`rust-backend/crates/ruke-server/src/ml_job.rs`,
  `ALLOWED_CAPABILITIES`) deliberately excludes `embeddings`/`rerank`, and TypeScript
  `lib/server/attachindex/{retrieve,embed}.ts` remains the live retrieval owner (owner decision D-046,
  still open). Engine executed with real weights + no production caller = ORANGE. It is not a completed
  migration and is not reported as one.
- **Test/fixture honesty.** `docs/overnight/probes/g04_neural_embed_probe.py` asserted that
  `mode="cross_encoder"` must be REFUSED. That assertion is obsolete the moment the asset is pinned, so
  the probe now refuses an explicitly **unpinned** mode and prints `cross_encoder_now_pinned=...`
  instead; re-run `logs/f27-g04-rerun-1.log` reproduces the recorded **7/9 with both numeric failures
  kept**. The stale unit test was replaced, not deleted, and 8 new tests were added (mode routing and
  self-naming, refusal when the asset dir is empty via `RUKE_RERANK_DIR`, incomplete-download and
  digest-mismatch refusal, determinism, joint-scoring behaviour that a dot product cannot express,
  typed empty-query rejection, registry truthfulness, and the worker payload's `engine`/`quality_note`/
  `truncation_note`). Suite: **383 tests OK**, exit 0 (`logs/f27-python-2.log`, was 375).
- **Probe bug found and fixed:** `peak_working_set_mib()` swallowed an `OverflowError` because
  `K32GetProcessMemoryInfo` had no `argtypes`, so the pseudo-handle was marshalled as a C int. Peak
  memory had therefore never been reported for the reranker. Fixed, and the number above is real.

## D-057 (F27) - legacy DOC/PPT conversion: still not built, and the reason is a decision not an excuse

Microsoft Office 16 is installed on this host (`C:\Program Files\Microsoft Office\root\Office16\`), and
`Word.Application` / `PowerPoint.Application` COM classes are registered, so COM conversion is
technically feasible and CPU-only. Two reasons it was not built in the last hours of the run:
1. The acceptance corpus is **frozen** (brief SS8/SS3: freeze the suite, then stop expanding). No
   independent ground truth was ever authored for legacy `.doc`/`.ppt`, so shipping a converter now would
   produce an engine whose quality is unmeasured by construction - the exact pattern the brief forbids.
2. It launches **the user's own Office**. If an Office instance is already open, `Quit()` on the
   automation object can discard unsaved documents; a corrupt legacy file can raise a modal dialog that
   hangs an unattended run. That collides with "preserve unrelated processes and unsaved user work", so
   it needs explicit authorisation from the user, not a silent choice made at 06:40 before a shutdown.

Current behaviour stays honest: `documents/parser.py` returns `kind="unsupported"` and
`workers/document_jobs.py` returns a typed `unsupported_input` with the real blocker. Smallest external
action if wanted: authorise Office COM conversion (or install LibreOffice in-project), then author a
frozen legacy fixture set with expected text/tables, then implement the bounded converter
(hidden app, macro security forced off, no alerts, hard timeout, terminate only the pid it started).

## D-058 (F28) - retrieval ownership: TS keeps the owner role, Python gets a real rerank caller

The F20 decision (D-046) left `lib/server/attachindex/{retrieve,embed}.ts` as the production owner because
the Rust/TS fixtures assert byte-exact block output and a synchronous retrieve could not host an async
Python call. The pinned cross-encoder now exists and executes (`retrieval/nn_rerank.py`, F27), so "no
production caller" was the only thing keeping area G short of done.

Decision (implemented this session, reported honestly either way):
1. **TS remains the owner of candidate generation, fusion, budget packing and output formatting.** The
   byte-exact store/build contract and the ASCII turn marker are not touched, so the Rust mirror stays
   valid. No rewrite of the retrieval path.
2. **Python owns neural scoring.** `embeddings` and `rerank` are added to the Rust ml-job
   `ALLOWED_CAPABILITIES` so the capability gate can no longer be the reason they are unused, and the new
   `lib/server/attachindex/rerank.ts` calls `mlJob("rerank", ...)` with the same pinned mode name the
   worker publishes (`neural_cross_encoder_minilm`).
3. **The rerank stage is additive and non-destructive.** It reorders already-ranked candidates *before*
   budget packing, so it cannot recover dropped evidence (that limitation is stated in the code, not
   hidden). Any typed failure, timeout, `not_configured` or malformed result leaves the existing RRF order
   untouched and is reported as `rerankReason`.
4. **Truthfulness in the marker.** The turn reports which ranker actually ran (`cross_encoder_minilm` /
   `neural_biencoder_minilm` / `lexical_rrf`) plus why. A lexical fallback is never called neural, and
   `vectorMode` semantics are unchanged.
5. **Migration status stays separate from functional status.** `embeddings` keeps a TS production owner
   (the TS ONNX embedder is live and its asset now carries digest-pinned provenance); the Python
   `embeddings` adapter is executed standalone but is not wired into the index-build path this run, so
   area G's *migration* row is at best ORANGE, not GREEN.

---

## D-059 (F32, 2026-11-17 15:15 +05:30) - the attended hold is lifted by the user
The user rebooted the machine (`Win32_OperatingSystem.LastBootUpTime = 17-11-2026 15:16:17`) and said
"Now you can start working on remaining available work. I will be monitoring if something goes wrong -
complete 100%". Decision: the previously HELD live groups (primary OCR, Strata unload/reload handoff,
production OCR path, frame-OCR, browser stage, live held-out probe) are run **attended**, each with its
own log, and each stays ORANGE until that log exists. Consequence: the F28 dev tree is gone (the reboot
ended it, not any agent action) and no owned process exists at this checkpoint.

## D-060 (F30) - the supervisor pre-imports each neural worker's native graph
Measured cause, not a guess: a first `rerank`/`embeddings` job spent 95-155 s inside the first ONNX
`InferenceSession`/tokenizer construction while the job deadline was already running, so every neural
retrieval call ended as HTTP 552 `deadline_exceeded` even though the assets and code were correct. Fix:
`ruke_ml/workers/runner.py` `_PRELUDE` pre-imports `numpy,onnxruntime,tokenizers` for those two
capabilities inside the lazy worker before it starts serving, and
`tests/test_supervisor_workers.py::test_the_neural_retrieval_workers_also_prelude_import_their_native_graph`
pins it. Evidence: python suite 384 tests OK exit 0 (`f30-python-1.log`), and the live cross-encoder job
that previously timed out completed (`f29-rerank-live-2.json`). Not a status change: it changed how long
the real adapter takes, which is what the acceptance gate measures.

## D-061 (F31) - the OCR acceptance script defects and the honest typed refusal
Two script defects are fixed and verified in F32: (a) a native command's stdout joins a PowerShell
function's output stream, so `Run-EnginePass`/`Run-ProductionPass` returned `System.Object[]` and the
script's final `exit` threw `ConvertToFinalInvalidCastException`, hiding the real per-pass exit codes;
child output is now streamed to the host and one int is returned, with ErrorActionPreference relaxed
only around the child because PS 5.1 promotes native stderr records to terminating errors under Stop.
(b) A production pass against a tree that is not answering is recorded as `code 3
precondition_not_met` after an explicit reachability probe, instead of raising ConnectionRefusedError
and looking like a crash. Separately, F31's engine pass is kept as evidence of the **memory valve
working**: it returned the typed `resource_limit` with `needs_handoff: true`, released the lease and
processed nothing. The primary pipeline has still never executed; the OCR row is not raised.

## D-062 (F32) - staged attended OCR instead of one long unbounded window
The whole 6-page `d1_scanned.pdf` pass has a worst case of about 37 min
(`--load-timeout 420` + 6 x `--page-timeout 240` + unload wait 60 + `DEFAULT_READY_TIMEOUT_S` 300), and
while the lease is held the coding agent must issue no inference request at all: Strata loads the model
again on the next request, and its 61.3 GiB commit cannot coexist with an OCR worker under this host's
100115 MiB commit limit. Decision: run **Stage A with `--pages 1` first** (worst case ~17 min) to
measure the real cold-load peak and per-page cost, verify the unload/reload lifecycle end to end, and
then size Stage B from the measurement. The frozen answer key is still scored over the whole document,
so if only part of it is covered the report says so explicitly instead of calling it a pass.


---

## D-063 (F33, 17-11-2026): the coordinated OCR window WORKED end to end; the primary engine died on a protobuf ABI contradiction readiness could not see

**First, the correction.** The Stage-A run launched detached by F32 did not "blow up". It completed at
17-11-2026 15:45:03 (`docs/overnight/logs/f32-stageA-marker.txt`: `STAGE-A DONE exitlevel=1`), with
engine pass exit 0 and production pass exit 3 (`code 3 precondition_not_met`: no dev tree was answering
http://localhost:3000 - a precondition, not an engine result). Evidence:
`docs/overnight/logs/f32-ocr-stageA-1.log` + `docs/overnight/logs/d1-engine-content-20261117-101358.json`.

**What the window proved (amendment 5 lifecycle, on the real host, first time):**
- admission refused the load BEFORE taking the lease: "free physical RAM is 2948 MiB, under the 3556 MiB
  this load needs"; GPU branch refused because GPU execution is disabled for the run;
- `POST /unload` on Strata returned HTTP 200 status `unloaded` - the unload path is not own-page/CSRF-blocked;
- measured release, both quantities: free physical 2,943 -> 54,022 MiB (`freed_physical_mib` 51,079) and
  VRAM free 2,613 -> 12,096 MiB (used 9,675 -> 192 MiB). VRAM was released too, so the unload decision is
  justified by both axes, not one;
- the plan was recomputed inside the window (`plan_after_unload.device=cpu fits=true`,
  `main_model.loaded=false`) before any worker was spawned;
- the worker was released, then the original model was brought back: `restore.status=loaded`,
  `restore_ready` 200 "qwen3.8-flash-next-iq3_s loaded and ready", `lease_release.released=true`, and no
  half-open journal afterwards (checked this session: `.ai-coordination/llm-handoff.lock` absent,
  `.data/python/handoff-journal.json` absent, /health `loaded:true`).
- The Strata console lines the operator pasted ("model unloaded; the next request loads it again ...
  experts loaded: 46.84 GiB at 5.75 GiB/s ... the engine is running again") are this window's own unload
  and restore: restore answered at 15:44:59, marker written 15:45:03.
- Separately established: ANY new user message makes the coding harness sample, which auto-loads ~47 GiB.
  Inside a window that has already unloaded, that is survivable (54 GiB was free), but it consumes exactly
  the headroom the processing peak is measured in. So a peak number is only trustworthy while nothing else
  samples - which is why the run is launched detached and the agent does not sample until it returns.

**The real defect (dependency, not resource).** The primary pipeline died 30 s into `processing`:
`load_failed: VersionError: Detected incompatible Protobuf Gencode/Runtime versions when loading
sentencepiece_model.proto: gencode 7.36.1 runtime 6.33.4`. Root cause chain, read off the files rather
than guessed: `sentencepiece 0.2.3` ships `sentencepiece/sentencepiece_model_pb2.py` with gencode 7.36.1;
`paddlex/inference/models/common/tokenizer/llama_tokenizer.py:100` imports that stub while the
PaddleOCR-VL VLM tokenizer is being built; uv had resolved `protobuf==6.33.4` into `.venv-ocr`.
`paddlepaddle 3.2.1` declares `protobuf>=3.20.2` with no upper bound, so the resolver's choice was legal
and unusable at the same time. Scanned the whole venv: exactly two packages carry gencode validators
(`google/protobuf/*_pb2.py` at 6.33.4 - self-consistent - and sentencepiece at 7.36.1), so nothing else
in that environment demanded a newer runtime.

**The cascade contract held under it.** The whole-run primary failure was recorded as `load_failed`, the
worker was released, and only then did real Tesseract recovery run for the affected unit: page 1 read by
`tesseract v5.5.3.20260724` at 200 dpi with per-line bboxes, confidences, raster provenance
(pypdfium2, 1700x2200, rotation 0), `engines_used=[tesseract v5.5.3.20260724]` and the recorded fidelity
note that recovery does not claim equivalent table/formula/layout fidelity. `--pages 1` restricts this to
one unit: it is a real fallback demonstration, never a primary-OCR acceptance and never a corpus pass.

**Fix applied (F33).**
1. `protobuf==7.36.2` installed into the project-local isolated OCR venv (`uv pip install --cache-dir
   .data/cache/uv --python python-backend/.venv-ocr/Scripts/python.exe protobuf==7.36.2`; resolved from
   the project uv cache, no new external cache). 7.36.2 is the version the main backend venv already runs
   on this host, and it is >= the 7.36.1 gencode floor.
2. `protobuf` added to `PINNED` in `ruke_ml/models/ocr_runtime.py`, and to
   `scripts/prepare-ocr-runtime.ps1` (parameter, an explicit install AFTER the resolver so a transitive
   choice cannot land under the stubs, and the pin recorded in both manifest branches).
3. Manifest re-recorded with a REAL device probe: `scripts/prepare-ocr-runtime.ps1 -ManifestOnly -Probe`
   -> `{"paddle":"3.2.1","compiled_with_cuda":false,"device":"cpu"}` - paddle 3.2.1 still imports under
   protobuf 7.36.2, and the CPU-only claim is a measured probe, not a hope.
4. Real ABI verification, not an import success claim: the stub now imports, and a `ModelProto`
   round-trip through serialize/parse preserved unicode pieces (`hello`, U+0905, `<unk>`, 50 bytes);
   `paddlex...llama_tokenizer` and `tokenizers 0.23.3` import clean.
5. New pre-flight gate so this class of failure can never again be discovered inside an exclusive
   window: `ocr_runtime.gencode_floor()` reads the protobuf runtime version each shipped `*_pb2` stub
   demands and refuses the environment when the installed runtime is older; the refusal is a readiness
   blocker (`OCR venv dependency ABI: ...`), and readiness now says `ready=False` with that reason.
   Pinned by `python-backend/tests/test_ocr_runtime_env.py` (9 tests) built on a FAKE venv tree - no
   interpreter, no weights, no network - including the assertion that answering this never imports paddle.

**What this run did NOT prove (still open, unchanged status):** the primary engine has still never
produced a page. `work_peak` reported 0/0 MiB because the primary never loaded (peak comes from the
paddle adapter's tree accounting), so `est_peak_mib 3300` and `est_peak_vram_mib 6000` remain
provisional; the 4 GB target / 5 GB hard ceiling for the OCR path is still unproven; the GPU branch, the
CPU-also-insufficient typed failure, concurrent-inference-during-window, worker crash/timeout recovery
and supervisor-restart recovery are untested. `documents.ocr` stays ORANGE: recovery engine verified,
primary engine never executed.

---

## D-064 (F36, 2026-11-17 ~19:40): amendment 8 incorporated; one measurement owner (`resources.PeakSampler`); semantic intent stays model-led

**Recorded because** the user sent a further continuation amendment while this task was running, and
an earlier mid-run amendment had already fixed the routing boundary. Neither is a restart.

**Boundary decision (unchanged, restated so later sessions stop re-litigating it).** The model decides
WHAT is wanted: which semantic task, which tools, which output format, whether to search or read more
evidence. Code establishes what the input actually contains (signature, container, tracks, decoder
probe), which capabilities can execute here (registry + pinned assets + measured device plan), which
prerequisites are necessary, and how authorized work runs reliably. Structural routing and measured
processing decisions stay in code; brittle natural-language intent guessing is replaced by
model-selected, validated capabilities - not by new phrase tables. Code then validates calls and
results with independent checks (artifact type and reopenability, valid source references, actual
processing coverage, required outputs, permission and resource compliance) and returns typed errors
with at most ONE targeted model correction per failed action, with duplicate side effects prevented
by existing job/tool-call identity. Valid JSON proves dispatch, never that the chosen action matched
the goal. Diagnostics record whether a capability came from explicit UI, model intent, or a processing
dependency, plus the measured fact or validated request that justified it - never raw reasoning.
This is a repair limit, not a prohibition on legitimate multi-step tool use, and it does not claim
zero model mistakes or the elimination of all future overfitting.

**Amendment 8 (SPEC section 18 header "Amendment 8")** is the authoritative restatement of the
resource/lifecycle contract: one exclusive window for the whole operation, durable persistence before
restoration, crash-safe cross-client coordination, separately configured ordinary and exclusive
budgets, one provider configuration, and the four separate done-states in the migration matrix.

**New decision - one owner for memory measurement.** Every heavy path used its own sampling loop and
its own zero-defaults, which is how "peak 0" came to be reported as if it were a fact. Decision: the
single owner is `ruke_ml/models/resources.PeakSampler` (0.5 s cadence, per-stage peaks plus overall,
`process_tree_memory` based, resident = working set and committed = pagefile-backed private charge,
`None` + an explicit "peak is UNKNOWN ... not zero" note when no sample was obtainable). Adapters keep
their own child-tree accounting only because they own the child process; where a caller needs one
number it takes the maximum of the adapter's child peak and this process's owned-tree peak, and that
composition (`ocr_cascade._operation_peak`) is the only place allowed to combine them.

**Not decided here:** pyannote diarization (still `license_acceptance_required` - never accepted on
the user's behalf), legacy DOC/PPT conversion (D-057 stands), and retained TS artifact writers
(D-058-style deviation: retained is not migrated).


## D-065 (F41, 2026-11-17 ~18:20): the flattened test file was recovered losslessly, and the record reader no longer calls "cannot read" the same as "nobody holds it"

**Incident.** F38 flattened `python-backend/tests/test_handoff_devices.py` with
`Get-Content` piped into `Set-Content -NoNewline`: 1,285 physical lines became ONE line
(70,969 bytes, UTF-8 BOM). Only newline characters were destroyed - every other byte
survived. That is the second self-inflicted source mutation from a PowerShell text pipe
in this migration, so the rule is now explicit: **never rewrite a source file through a
PowerShell text pipe. Use `apply_patch`, or Python `pathlib.write_text(..., newline="\n")`.**
The same pipe had also silently created a doubled `WebUI\WebUI\.data\tmp` tree (an
`apply_patch` path is relative to cwd, and the prefix was repeated).

**Recovery, with an oracle rather than a guess.** The file was reconstructed by replaying
its own history out of the F38 rollout JSONL: 18 `apply_patch` events (only the 15 whose
output contained `Success.`, the three failed ones skipped), plus the two scratch scripts
that mutated it inside `exec_command` runs (`add_handoff_tests.py`, `add_cascade_test.py`;
their `'''...'''` literals are read with `ast.literal_eval`, and the D-054 pid-reuse tests
were anchored on the `owner="recovered", break_stale=True` insert), plus the final
`CoordinationRecordIntegrity` class with the amended oversized-payload assertion.

Two independent checks say the reconstruction is right:
- **character oracle** - whitespace-stripped character count of the last pre-mangling
  snapshot equals the rebuilt file exactly (`snapshot=54354 rebuilt=54354`, CONTENT MATCH).
  A single wrong or missing non-whitespace character would break this.
- **structural oracle** - `python-backend/tests/__pycache__/test_handoff_devices.cpython-312.pyc`
  (the 17-11 16:57:39 run that printed `Ran 57 tests OK`) gives every code object's
  `co_firstlineno`. All 86 old definitions are present; 20 sit at delta 0 and 66 at a
  constant delta +91, i.e. exactly one 91-line insertion happened between the
  `DevicePlacement` block and `LeaseAndHandoff`, and nothing after it shifted. This is what
  proves blank-line placement, which the character oracle cannot.
  Restored file: 72,251 bytes, LF, no BOM, 1,285 lines.

**Result.** `python -X utf8 -m unittest tests.test_handoff_devices` -> **Ran 63 tests, OK**
(57 pre-existing + 6 new `CoordinationRecordIntegrity` methods). `tests.test_ocr_fallback`
and `tests.test_memory_policy` -> **Ran 25 tests, OK**.

**The one real failure the restored file exposed was the defect, not the recovery.**
`test_absent_unreadable_and_malformed_are_three_different_answers` asserted
`unreadable` and got `absent`: `read_lease_record()` caught EVERY `OSError` and fed
`raw=None` into `_classify_record`, which then returned the `absent` state. On Windows a
record that exists but cannot be read (a directory in its place, a sharing violation, a
permission denial) therefore looked like "unlocked" - amendment-7 defect 4 exactly.

**Fixes in `ruke_ml/handoff.py` (the shared reader, so every consumer inherits them):**
- `_classify_record(..., missing_state=)` - "no bytes" now carries WHY it has no bytes.
  `FileNotFoundError` -> `absent` (free); any other `OSError` -> `unreadable` (never free).
- `_record_age_s()` replaces the inline `time.time() - _record_mtime()`: a failed `stat()`
  returns **None, not 0.0**. A fabricated huge age used to "age out" an unreadable record
  into `abandoned` and hand the endpoint to inference - the same fail-open, one layer down.
  Unknown age now means unknown: it stays HELD-UNCERTAIN and only an operator's bounded
  `--break-stale` can clear it. `age_s` reports `None` rather than a number.
- Both `lease_state()` and `playwright_state()` share that rule, so a torn browser-lock
  heartbeat blocks a handoff instead of permitting one.

**Still open, deliberately:** the same class of defect in the TypeScript lease
(`lib/server/coordination/llm-lease.ts`) and the Rust endpoint gate
(`rust-backend/crates/ruke-core/src/admission.rs`), whose tests currently *assert* the
fail-open behaviour. Tracked in TASKS; not a Python concern and not yet fixed.

---

## D-066 (F44, 2026-11-17 ~19:10): ONE provider configuration, and the automatic-handoff policy stops being an acceptance-script flag

**Why.** Amendment 8 review finding 3 said chat resolved its endpoint from
`settings.json` while the Python lifecycle resolved from environment/`.env.local`, so a
handoff could unload a DIFFERENT server than the one chat was talking to. That is not a
cosmetic split: the whole resource-handoff design assumes one endpoint. Fixing it by making
Python read the same env file would have kept two resolvers that merely happen to agree.

**What was implemented (all three clients, one resolver per language).**
- Python: new `python-backend/ruke_ml/models/provider_config.py`. Precedence
  **settings.json > process env > .env.local > built-in fallback**, with a per-key
  `config_source` so any refusal can name where its number came from. Exposes `chat_url`
  (path prefix preserved, never stripped to origin), `api_key`, `control_origin`,
  `unload_url`, `load_url`, `lifecycle_explicit`, `provider_hint`, `model_id`,
  `automatic_handoff`, and `as_dict()` with the api key replaced by `"<redacted>"`.
  mtime-gated reads; an unreadable or corrupt settings file keeps the last good parse
  instead of failing open to an empty config.
- `main_model.endpoint()` now returns `provider_config.load().control_origin`; its private
  `_dotenv_lines()` chain and `DEFAULT_ENDPOINT` fallback order are deleted. `provider_for()`
  honours `RUKE_LLM_PROVIDER` only for the config-derived endpoint, so an explicit base_url is
  still probed honestly.
- TypeScript `lib/server/settings.ts`: the same four layers (`readDotenv`, `resolveLayer`,
  `providerConfig()`, `llmLifecycleUrls()`); `llmApiUrl()/llmApiKey()` were moved onto it.
  The derived reload path is **`/load`**, which is what Strata actually serves - the earlier
  `/reload` guess would have 404'd and left the model parked.
- Rust `ruke-core/src/settings.rs`: `DotenvCache`, `dotenv_path()`, `dotenv_value()`
  (unreadable keeps the last parse, absence clears) and `resolve_layered()` behind
  `llm_api_url()/llm_api_key()`; the dead `resolve_string` was removed.

**Lifecycle URLs are DERIVED from the chat URL's origin** (`originOf(chatUrl) + /unload`,
`+ /load`) unless an explicit `LLM_UNLOAD_URL`/`LLM_RELOAD_URL` is configured. Two resolvers
that could drift were replaced by a structural impossibility of drifting.

**The policy default changed on purpose.** `documents/ocr_cascade.policy()` now takes
`allow_unload` from `cfg.automatic_handoff`, default **true** for a supported deployment,
instead of requiring the acceptance script's `-AllowUnload`/`RUKE_OCR_ALLOW_UNLOAD`. Amendment
8 section 2 explicitly asked for the automatic policy in normal operation rather than a flag
only a test sets. The evidence keeps saying where the value came from
(`allow_unload_source`) and the refusal text names the policy, not a missing flag.

**One window per job, with fallback inside it.** A new test in
`tests/test_handoff_devices.py` asserts a job that does not fit asks for exactly ONE
`run_exclusive` window and that Tesseract recovery ran inside it (`windows[0][1] == [[1]]`),
which is the behaviour amendment 7 defect 1 demanded. The old
`test_resource_limit_without_authorised_unload_refuses_the_primary` was not deleted but
re-expressed honestly as `..._with_the_handoff_policy_off_refuses_the_primary`, with
`RUKE_LLM_AUTOMATIC_HANDOFF=0` set explicitly and `main_model.snapshot` patched so mocked
tests stop performing real HTTP against :8080.

**Reconciling D-065's open item.** D-065 recorded the TS/Rust readers as still fail-open.
That is now out of date and was verified rather than assumed: `lib/server/coordination/
llm-lease.ts` has `LeaseRecordState = "absent" | "unreadable" | "corrupt" | "ok"` with
`uncertain`/`abandoned` and an unknown-mtime rule, and `admission.rs` has
`LeaseReading::Uncertain` plus tests `unreadable_or_unparseable_lease_records_are_not_free`
and `an_unreadable_record_ages_out_so_a_broken_lease_cannot_park_forever`. Four clients now
answer absent/unreadable/corrupt/ok the same way.

**Evidence.** `python -X utf8 -m unittest` on `tests/test_provider_config.py` **16 OK**;
`tests/test_handoff_devices + test_ocr_fallback + test_provider_config` **95 OK**
(`logs/f44-py-handoff-3.log`); full discover **432 tests OK** (`logs/f44_py_discover3.log`);
`cargo test -p ruke-core --lib` **40 passed** (`logs/f44-cargo-core-1.log`);
`__tests__/server/provider-config.test.ts` **7 OK** (sandbox cwd via `process.chdir`, never
the repo's own settings.json).

## D-067 (F45, 2026-11-17 ~19:25): a test process must never be able to park the user's live model - the interlock D-066 made necessary

**The regression was caused by D-066 itself.** Once `unloadUrl`/`reloadUrl` are derived from
the chat URL, `LLM_UNLOAD_URL` in `lib/server/extract/audio.ts` became **always non-empty**.
The stage-2 gate was `LLM_UNLOAD_URL !== "" && automaticHandoff`, so any vitest test that
called `transcribePcmSegments` with a low VRAM probe and NO injected `unload` seam sent a
real `POST http://127.0.0.1:8080/unload` at the user's running main model. It happened in
`__tests__/server/llm-handoff-lease.test.ts` ("without an unload hook it never claims the
lease"); the test failed on a 5 s timeout and `/health` afterwards still reported
`"loaded": true`, so nothing was evicted - that is luck, not a safety property.

**Fix at the cause, not per test.** `audio.ts` now exposes `llmParkPermission()`, which
answers WHY this process may or may not park the model, with three distinct refusals:
`the provider handoff policy is switched off`, `no lifecycle unload endpoint is configured`,
and `a test process may not call the live provider lifecycle endpoint (set
RUKE_ALLOW_LIVE_LIFECYCLE=1 to allow it)`. The test detection is `VITEST`/`NODE_ENV=test`;
production never sets the opt-in, so this narrows only what a test runner can do.
`tryLlmUnload` refuses instead of POSTing, and `tryLlmReload` refuses too - including the
1-token warm-up, which is itself an upstream generation through the shared door. `canPark`
is `opts.unload !== undefined || permission.allowed`, and the stage note now quotes the real
reason rather than "no LLM unload hook is configured".

**The test proves the absence of the side effect, not just the state.** The rewritten case
runs with the DEFAULT policy inside the test process, asserts the refusal reason, asserts the
lease is never held, asserts the transcript still comes back from the CPU pipeline, and spies
on global `fetch` to assert that **no** URL ending `/unload` or `/load` was requested. The
other case keeps the policy-off scenario honestly (`RUKE_LLM_AUTOMATIC_HANDOFF=0`, saved and
restored around the import).

**Evidence.** `npx vitest run llm-handoff-lease hardening-audio audio-stage-guard
provider-config` -> **Test Files 4 passed, Tests 37 passed** (`logs/f45-vitest-audio-1.log`).

**Rule this leaves behind.** Any future caller of a provider lifecycle endpoint must go
through the same permission answer, because derivation means "an endpoint exists" is no
longer evidence that parking it was requested.


---

## D-068 (2026-11-17 ~20:00, session F46) - the `[ranking:]` honesty line becomes part of the attachment wire contract, with Rust parity

**Why this was a real defect, not a fixture drift.** The golden diff that had been read as "the Rust
port is missing the D-058 honesty line" was inverted: in `__tests__/rust-golden/support/golden.ts` the
fixture writer compares `existing` (bytes already on disk) against `recorded` (bytes the CURRENT
TypeScript oracle just produced). So the NEW TypeScript output already contained the
`[coverage: ...]` / `[ranking: ...]` lines, and the committed `attachments/*` fixtures recorded 15-11
bytes without them. Re-reading the harness before patching is what flipped the diagnosis; the F45 note
had the direction backwards and would have produced a Rust change that broke parity instead of
restoring it.

**Contract change (not a bug fix).** The `[ranking: ...]` line is now part of what the retrieval owner
sends upstream, so it is part of the byte-exact attachment corpus. The TypeScript law was unchanged in
shape: `rankCandidates` emits the honest line whenever the fused order stands and no neural rerank
ran, plus the structural branches for `Sequential` + range, `TimeRange` + windows and `TimeRange` +
`from_sec` (turns that were never rankable). What changed is the *reason string*: the old
`"no capability route in this deployment (the Rust backend is not enabled)"` is a deployment-specific
claim that is wrong for the Python-owned retrieval path, so it is now the exported
`RERANK_NO_ROUTE_REASON = "this retrieval owner has no neural rerank route in this deployment"`. That
old string exists nowhere else in the repo, so this is a rename with no other consumers.

**Rust parity.** `crates/ruke-attach/src/turn.rs` gained `pub(crate) const NO_RERANK_ROUTE` with the
same text and `pub(crate) fn rank_line(opts: &RetrieveOpts, vector_mode: &str) -> String`, inserted at
the same position as TypeScript - after `block.push_str(&covered)` and before the blank line plus
`rules(r)` - with the same three structural branches and the same fused-mode wording
(`MODE_HYBRID ? "semantic + lexical" : "lexical"`).

**Documented divergence, not a silent one.** TypeScript has a fourth wording for "fewer than two
candidates were ranked". `Evidence` in Rust does not carry the candidate-field size, so that branch is
not computable there. No golden fixture query reaches it, and the Rust unit test
`rank_line_mirrors_turn_ts_byte_for_byte` pins only the branches both runtimes can compute. If a future
fixture reaches that branch, the fix is to carry the candidate count into `Evidence`, not to fake a line.

**Sanctioned re-record, and its proof.** `RUKE_GOLDEN_UPDATE=1 npx vitest run
__tests__/rust-golden/attachments.test.ts` re-recorded fixtures 01/04/05/06 through the live TypeScript
oracle (never hand-edited). A character-level `git diff` was then reviewed by hand: the change is a
**pure insertion of the `[ranking: ...]` line** in 4 fixtures - 8 changed lines, because each fixture
records the same content twice (`bodyText` and `bodyJson`) - with no other byte moved.

**Execution evidence.** `cargo test -p ruke-attach --lib` **87 passed** (`logs/f46-cargo-attach-1.log`);
re-record run 6 passed (`logs/f46-golden-rr-1.log`);
`cargo test -p ruke-server --test attachment_replay` **6 passed**
(`logs/f46-cargo-replay-1.log`), i.e. cross-runtime byte-identical replay after the contract change.
This is *parity* evidence for the retrieval block, not retrieval-quality evidence: the neural reranker
still has no production route, which is exactly what the new line tells the model.

**Rule this leaves behind.** A golden mismatch is read from the harness's own comparison direction
before anyone changes a runtime; and when the emitted honesty text changes, the change lands in both
runtimes plus the fixtures in one pass, with the re-record justified in the fixture `_meta` notes and
`rust-backend/fixtures/README.md`.

## D-069 - the "vitest reached the live model" finding was a phantom; a test-harness guard replaced a production deny-path

**Date:** 2026-11-17 (session F48). **Supersedes the "new requirement" paragraph of SPEC amendment 9 as originally written.**

**What F47 believed:** `docs/overnight/logs/f45-gates-1.log` contained real `connect ECONNREFUSED
127.0.0.1:8080` failures from `lib/stream/parser.ts` and the title generator, "which proves vitest was
issuing completions against the shared capacity-1 Strata endpoint", and that generation therefore needed
the same explicit permission answer that lifecycle calls got in D-067. A production deny-path
(`lib/server/provider-call-policy.ts::liveGenerationPermission`) applied at the top of
`sharedUpstreamCompletion` and `sharedUpstreamStream` was already queued as the fix.

**Why it is wrong** (each log line traced to the test source that emitted it):
1. `[PARSER] error: TypeError: fetch failed: ECONNREFUSED 127.0.0.1:8080` - the case "a transport failure
   is an ERROR, never a silent success" in `__tests__/stream-terminal-ownership.test.ts` calls
   `vi.stubGlobal("fetch", ...)` with a transport that throws that literal string. The message is data
   the test wrote, not a socket failure.
2. `WARN (titles): title model call failed  err: "connect ECONNREFUSED 127.0.0.1:8080"` - `planTitle`'s
   `catch` logs `err.message`; the message came from the injected fake in the case "model call throwing
   (server down) resolves null and never throws". `callModel` is a seam precisely so unit tests never
   touch real inference.
3. The second `(titles)` WARN, `err: "This operation was aborted"` - the already-aborted-signal case.
   `sharedUpstreamCompletion` checks `lc.signal?.aborted` BEFORE the queue and before `fetch`, so nothing
   is sent; `callMainModel` does the same for an already-aborted caller signal.
   Total `ECONNREFUSED` occurrences in that log: 2, both accounted for above.

**Decision.**
- The claim is retracted **in the document that made it** (SPEC amendment 9), not just in a later entry,
  so a future session cannot find the old instruction and implement it.
- **No production deny-path ships.** It would add a branch to the shared inference door for a defect that
  does not exist, and it would have MASKED the two transport-failure tests that are the actual evidence in
  that log (one of them also asserts `sameResourceAsConfigured("http://127.0.0.1:8080/...") === false`
  with the configured endpoint on port 1234, i.e. it deliberately names 8080 as a foreign resource).
- What is true is weaker and still worth fixing: the suite is hermetic only **by accident**. Two title
  tests use the real transport and pass because an aborted signal rejects pre-flight and because the
  operator port happened to be unreachable at that moment. Under the shared capacity-1 Strata endpoint
  that is a live hazard for the next refactor, not for today.
- The honest fix is a **test-harness guard**: `test.setupFiles: ["__tests__/support/live-provider-guard.ts"]`
  wraps each test file's `fetch` and, at `afterAll`, fails the file if any POST reached the operator
  origin on a `.../completions`, `/unload` or `/load` path. It OBSERVES and reports; it does not block,
  because blocking would change what the code under test does and could hide a genuine transport path.
  `RUKE_ALLOW_LIVE_PROVIDER=1` is the attended escape hatch.
- The operator resource is resolved from **disk only**: `settings.json` (`llm_api_url`) then `.env.local`
  (`LLM_API_URL`) then the built-in fallback. `process.env` is deliberately NOT a layer here, unlike
  `lib/server/settings.ts`, because suites set `LLM_API_URL` in `process.env` to point at fakes; a guard
  that read those would name a fake as the operator and stop protecting the real server.
- To avoid importing the shared-door module (and its process-local capacity state) into the harness,
  `LOOPBACK_ALIASES` and `resourceKey` moved **verbatim** to the leaf module
  `lib/server/resource-identity.ts`; `lib/server/upstream-bridge.ts` re-exports them, so its 7 internal
  uses and `__tests__/server/upstream-admission.test.ts`'s import are unchanged.
- The guard's own logic is not trusted on faith: it lives in `live-provider-guard-core.ts` and is covered
  by `live-provider-guard.test.ts`. Detector detail worth recording: vitest 2.1 marks a double with
  `_isMockFunction === true` and a **`mock` stats OBJECT** (not a function) - the first version tested
  `typeof fn.mock === "function"` and its own test caught it.
- Hermeticity of the two real-transport title tests is now an **assertion** (zero `fetch` calls via
  `vi.spyOn(globalThis, "fetch")`), not an accident.

**Stated limits of the guard.** A test file whose `fetch` is already a double before the guard installs
(module-scope stub) is declined rather than wrapped, so fixtures that merely name port 8080 cannot become
false failures - the cost is that such a file is unobserved. Only POST on the operator origin is judged,
so `/health` probes stay legal. And the guard cannot see through a suite that both replaces `fetch` and
talks to the operator through some other client.

**Collateral fix.** `npm run typecheck` had never had its exit code recorded (F45 truncated the tail), so
its status was UNVERIFIED. Running it for real produced 2 errors, one of them introduced by F46's
`extract-zip.test.ts` fixture-cache patch (`NodeJS.ExecFileException` is not exported by this @types/node)
and one by the new guard test. Both fixed; `tsc --noEmit -p tsconfig.json` now exits 0.

**Evidence:** `docs/overnight/logs/f48-guard-targeted-1.log` (6 files / 98 tests with the guard active),
`f48-guard-test-2.log` (19/19), `f48-typecheck-1.log` (the 2 errors) and the clean rerun.

## D-070 (2026-11-17 ~21:15, session F51) - the semantic-gate audit, done against real callers, and one designed gap recorded instead of half-fixed

Amendment 10 named two production suspects and required an audit at the **real callers**, not at the file
names. The audit is now done and its result is mostly negative for the suspicion, which is a legitimate
outcome that has to be written down rather than turned into a cosmetic patch.

**`lib/decision/client.ts::detectDeliverableIntent` (line 372, used at 518-535) is advisory only.** It
scans the message for deliverable shapes and the resulting modes select `skill_to_load`
(`MODE_SKILL[single]`) and which mode contract is injected. It does **not** gate whether a renderer or a
tool is available: `components/chat/FenceRouter.tsx` mounts every fence that validates, regardless of the
proposed mode, and the Rust mirror (`crates/ruke-decision/src/engine.rs::detect_deliverable_intent`,
vectors in `rust-backend/fixtures/decision/06-intent-matcher-vectors.json`) is a parity mirror of the same
advisory function. Deleting it would remove the skill/contract suggestion, not add model authority; the
model already has the final say about what it emits. So the honest finding is: **no semantic phrase rule
here decides an outcome**, and no replacement is owed. The rule's real defect is upstream of it: it can
under-suggest a skill, which costs quality, not capability.

**`lib/web-search/search-gate.ts` is already model-authoritative,** contrary to the still-uncorrected row
in `DECISION-OWNERSHIP.md` (that row predates the 2026-11-04 redesign and said "the phrase matchers are
NOT retired ... area A is ORANGE"). The shipped flow is: escape-guarded FORCE-NO layers (explicit
no-search, quoted instruction scope, closed small-talk set), then FORCE-YES **evidence-shape** layers
(a URL in the prompt, an attribution noun with a basis contract, an explicit release-note instruction),
then the **main-model gate** decides for everything undecided, with attachment presence explicitly
refused the status of evidence sufficiency. `rulesBasedPlan()` runs only when the model is unreachable or
unparseable, i.e. it is a degraded mode, not the router. Those surviving matchers are deterministic
permission/scope/evidence rules, which the amendment explicitly protects - they are not intent guesses.
The row is corrected in DECISION-OWNERSHIP.md this session.

**Repair is content-driven, not model-driven.** `lib/render/fenceRepair.ts` fires only when a validator
actually fails a fence (`MAX_FENCE_REPAIRS = 2`), through `hooks/useChat.ts` (673-722) into
`app/api/chat/route.ts` (654-677). That is the bounded one-correction rule, and it is driven by a failed
check rather than by a phrase.

**The recorded gap, deliberately not half-fixed:** an answer that renders prose where a fence was
appropriate never reaches that repair path, because nothing fails a validator - the answer is valid
prose. The clean fix is an always-on compact capability/fence **catalogue** block so the model knows what
fences exist without being told by keyword scan. That block's bytes are part of a cross-runtime contract:
`MODE_CONTRACTS` (`lib/decision/contracts.ts`) is hashed by `__tests__/rust-golden/decision-parity.test.ts`
and regenerated into `crates/ruke-decision/src/contracts_generated.rs`, needs the `maskRuntimeClock` /
`mask_runtime_clock` masked-block rule, sanctioned fixture re-record (`rust-backend/fixtures/chat/*`,
`golden_replay.rs`, `__tests__/rust-golden/chat-core.test.ts`) and a full regression. Doing that halfway
would break byte parity while leaving the behaviour unchanged, so it stays **designed work with a named
path**, exactly as F45's phantom "live-provider leak" was recorded rather than patched.

## D-071 (2026-11-17 ~21:12, session F50) - generated artifacts are reopened and inspected by the Python reader, and the inspection found a real writer gap

Amendment 10 requires that generated PDF/DOCX/PPTX/XLSX files be reopened and their rendered content
inspected, and forbids calling a retained TypeScript writer "Python migrated". Rather than invent a new
mechanism, F50 made the **existing Python document reader** the independent inspector of what the TS
writers emit: the writers produce the artifact, the Python `documents.parse` reader reads it back, and a
TypeScript test asserts what the reader saw. That is cross-runtime parity evidence, not a self-report.

- `docs/overnight/probes/reopen_probe.py` rewritten: `reopen_probe.py [--expect TEXT]... <file>...`.
  Per file it reports `ok, kind, blocks, kinds, matched{count,first_kind,first_loc}`,
  `formula_cells[{sheet,cell,formula,cached_value}]`, a bounded `meta`, `coverage`
  (`units_total / extracted / succeeded / empty / needing_ocr / failed / method / note`) and a block
  sample. Provenance is explicit: `d1_native.pdf` reports method `pypdf-7.1.0-plain`.
- New test `__tests__/documents/artifact-reopen-parity.test.ts` (4 tests, passing) is the first test in
  this repo that spawns the project venv. It writes real files from the retained TS writers
  (`buildDocx`, `buildPptx` at the "simple" tier, `buildXlsx`, `renderPdf`) into `.data/tmp/reopen_parity_*`
  and parses them with `python-backend/.venv`. It skips honestly if that interpreter is absent.
- Asserted observations, none weakened to pass: docx yields 10 blocks
  (`heading:3, paragraph:4, table_row:3`), `meta.tables = 1`, the heading
  `Executive Summary` is kind `heading` at paragraph 2, Unicode `Élan café 25 %` survives exactly once,
  the table row `Kandla` comes back as `table_row` with cells `["Kandla","18.4","12.7"]`, late evidence
  `arbitration award of 14 November 2021` is found at paragraph 10 (so a long-document tail is
  reachable, not just the first pages), and `meta.not_extracted` still says merged cells are not
  extracted. xlsx yields `C2 {formula "B2*2", cached_value "10"}`, `SUM(B2:B3) = 15`,
  `SUM(C2:C3) = 25`, and typed cells keep `loc.cell`. pdf yields 3 pages with a method naming
  `pypdf`, and the late marker on a page index at least 2.
- **Real gap found by the inspection, recorded as a defect rather than asserted away:** the generated
  pptx has three `notesSlide` parts, but every block of `kind:"note"` contains only the slide-number
  placeholder (matched by `/^\d+$/`). The writer therefore does **not** carry authored speaker notes
  into the file, even though the parts exist. The test asserts that fact, so the gap cannot be
  silently "fixed" by a later assertion change without a code change.
- Architectural consequence, recorded as a scope deviation and not a migration: the artifact writers
  stay TypeScript-owned because they pass content parity through the independent reader today; the
  Python artifact rows in the registry remain non-executable retained-owner markers. A retained,
  working TS owner is not a completed Python migration, and MIGRATION-MATRIX says so per row.

**Evidence:** `logs/f50-reopen-probe.json` (the probe's own JSON for all four artifact kinds),
`logs/f50-reopen-{1,2,3}.log`; the file then survived the F51 full vitest run
(196 files / 2529 tests, `logs/f51-vitest-full-1.log`).

## D-072 (2026-11-17 ~22:05, session F52/F53) - two stale doc rows corrected against newer measured code

Amendment 10/11 require reconciling the tables against newer logs instead of letting an older "not wired"
or "not installed" row override later reality. Two rows were stale, both verified at the source and by
executing the resolver:

1. **ffmpeg and ffprobe ARE installed and validated project-locally.** An earlier note claimed video work
   failed with `ffmpeg_not_installed`. Measured: `python -c` over `ruke_ml.models.binaries.path_for`
   (scratch `.data/tmp/g20.py`) resolved
   `ffmpeg -> D:\Projects\WebUI\WebUI\node_modules\ffmpeg-static\ffmpeg.exe`
   (6.1.1-essentials_build, www.gyan.dev build, `drawtext` and `lavfi` present, `-version` probe passes),
   `ffprobe -> node_modules\@ffprobe-installer\win32-x64\ffprobe.exe`,
   `tesseract -> .data\tools\tesseract\tesseract.exe` (DLLs plus `tessdata` with `eng`/`osd`). The only
   `ffmpeg_not_installed` string left in tests is the deliberately **mocked** case
   (`python-backend/tests/test_video_scan.py:375`), which is separated from real behaviour. Consequence:
   `video.frame_ocr`, the real cut scan and Tesseract OCR are all executable **without unloading the main
   LLM**, which is what makes the F53 real-execution evidence possible at all.
2. **The neural cross-encoder reranker already has a production caller on the TypeScript retrieval owner.**
   `lib/server/attachindex/rerank.ts` (`makeRerankStage`, mode `neural_cross_encoder_minilm`, window 24,
   3000-char per-candidate cap under the Rust gate's 4096, 60 s deadline, abort-honouring) is called by
   `lib/server/attachindex/turn.ts:344-365` through `retrieveEvidenceWithRerank`, and `turn.ts` is reached
   from `app/api/chat/route.ts`. `rerank` is **on** the Rust capability allowlist
   (`rust-backend/crates/ruke-server/src/ml_job.rs:93`, with the D-058 comment explaining it was moved on
   once the pinned cross-encoder became real). MIGRATION-MATRIX row G3 and DECISION-OWNERSHIP line 27 said
   "no production caller"; that is now wrong as written.
   What **is** still true, and stays recorded: the **Rust** attachment turn owner
   (`rust-backend/crates/ruke-attach/src/turn.rs`, `NO_RERANK_ROUTE`, `rank_line`) has no rerank stage and
   emits the honest line "no neural rerank ran (this retrieval owner has no neural rerank route in this
   deployment)"; and the rerank stage in the TS path has never been measured **live** end to end, only
   mocked in `__tests__/server/attach-rerank-neural.test.ts`. So production-wired = yes (TS owner),
   actually-executed/acceptance-passed = no. Do not add a Rust rerank stage casually: the `[ranking:]`
   string is a byte-pinned wire contract (D-068) with fixture re-record requirements.

No product source was changed by this decision; it is a status correction plus the evidence that supports it.

## D-073 (2026-11-17 ~22:10-23:30, sessions F54/F55) - an allocation refusal is a resource condition, not an asset condition

**Root cause, measured.** The ASR job through the production `models.lifecycle.WorkerPool` failed in
1.5-1.7 s with `state failed`, `reason model_unavailable`, `detail load_failed: RuntimeError:
mkl_malloc: failed to allocate memory`, and a human step telling the user to re-prepare a pinned asset
that is already on disk. Controlled experiment (scratch `.data/tmp/g26.py`, a `WorkerPool` subclass that
only prints/overrides the ceiling) on `.data/tmp/e03/speech.wav`:

- `logs/f54-g26-asr-default-1.log` - ceiling **776 MiB** (`{"measured_load_peak_mib":388,
  "estimate":"measured"}`) - mkl_malloc failure, `model_unavailable`.
- `logs/f54-g26-asr-raised-1.log` - same job, ceiling **3,072 MiB** - `state ready`, payload
  `transcribed`, device `cpu`, compute `int8`, real text "The Kestral Depot Inventory lists 11 crates
  of copper cable worth 2400 euros." in 1.57 s.

**The mechanism is a unit error, not a memory-pressure accident.** A Windows job object caps **commit**
charge; `ModelSpec.est_peak_mib` is a **resident** working-set peak. `_ceiling_bytes` derived the ceiling
as 2 x the resident peak (2 x 388 = 776 MiB) while the same load's measured commit peak is **1,276 MiB**
(`worker_peak_commit: 1276.0` in `logs/e03-speech-20261116T16564630343.json`, whose definition block
states "working set = resident RAM, commit = pagefile charge"). The whole ceiling block is new
uncommitted code, which is why the older E03 run had succeeded. A second defect rode along: the whisper
rows carried an **empty `est_peak_basis`**, so `admission()` charged a **measured** number as
provisional (1.5x plus a 1 GiB margin).

**The fix is the class, not the example** (amendment 11 section "audit the class, not the examples"):

1. `ruke_ml/allocations.py` (new leaf module, imports nothing from the package so every layer can use it
   without a cycle): one shared `is_allocation_failure()` classifier over the refusal vocabulary, plus
   `describe()`, with the measurement above in its docstring.
2. `models/registry.py`: `est_peak_commit_mib` / `est_peak_commit_basis` on `ModelSpec`, populated with
   the measured 1,276 MiB on **both** `Systran/faster-whisper-base` rows (`speech.asr`, `speech.align`),
   and `est_peak_basis` filled in so those rows are charged as measured.
3. `models/lifecycle.py`: `_ceiling_bytes` is commit-aware - `base = max(commit + 256, commit x 3/2,
   resident x 2)`, with `commit_estimate`/`commit_basis` in the note so an unmeasured capability says so
   in words instead of presenting 2 x resident as a measurement. A clamp that would fall under a known
   commit demand sets `ceiling_below_measured_commit_demand` + `commit_shortfall_mib`;
   `_commit_ceiling_shortfall()` and `_admission_refusal()` then **refuse typed** (`memory_pressure`,
   `payload.refused_for = commit_ceiling_below_measured_demand`, a human step that explicitly forbids
   re-downloading) instead of squeezing the worker into a ceiling it cannot load under.
4. `workers/jobs.py`: `KIND_TO_REASON["allocation_failed"]`, and a funnel in `typed_from_kind` that
   reclassifies **any** adapter kind whose mapped reason is `model_unavailable` / `internal` /
   `corrupt_input` / `not_configured` when the message is an allocation refusal, dropping the adapter's
   own (wrong) human step while keeping the adapter kind in the message for provenance.
5. The adapters now classify at the source instead of relying on the funnel:
   `speech/whisper_ct2.py` (`load_model` classifies **before** the loose local/cache/network asset branch,
   and `transcribe` does the same), `documents/ocr_paddle.py` (`load_refusal()` over the three load sites:
   load timeout, exited-before-ready stderr tail, and the worker error event),
   `retrieval/nn_embed.py` and `retrieval/nn_rerank.py` (the onnxruntime session-load except maps an
   allocation refusal to `memory_pressure`, because the asset already passed digest verification), and
   `workers/runner.py` has one `_retrieval_failure()` used by **both** retrieval handlers instead of two
   hard-coded "prepare the pinned asset" strings.

**Executed evidence (this session, not mocked):**
`logs/f55-g26-asr-fixed-1.log` runs the SAME probe with **no override**: derived ceiling
`1914 MiB` with `measured_commit_peak_mib: 1276` and `commit_estimate: measured`, `state ready`, device
`cpu`, compute `int8`, the same real transcript, 1.53 s. That is real execution through the production
pool path (`WorkerPool.run` - spawn, job-object ceiling, worker protocol), not a unit test.

**Tests:** `python-backend/tests/test_memory_kinds.py`, **21 tests OK**
(`logs/f55-py-memkinds-1.log`): classifier positives/negatives (a missing asset is never read as an
allocation and vice versa), the funnel, the ceiling derivation, refuse-don't-squeeze, the whisper stub
classification, the onnx reason, the OCR parent's three load sites, and `_retrieval_failure`.
Full-suite result is recorded in TEST-RESULTS.

**Honest limits.** This fixes a *misreported resource failure and a ceiling unit error*; it does not make
the primary OCR engine work (PaddleOCR-VL has still produced zero pages) and it does not prove the
aggregate 4 GB/5 GB ceiling. `est_peak_mib` / `est_peak_vram_mib` for the OCR window stay **provisional**
until an attended run measures them. Diarization stays `license_acceptance_required`.

## D-074 (2026-11-17 ~22:35, session F55) - one provider configuration, and a lifecycle base that keeps its path prefix

Amendment 12 finding 3 said chat resolved from `settings.json` while Python lifecycle resolution read
environment/`.env.local`, so the two could name **different servers**. It was already closed for the
origin (D-056/D-066): the chat URL origin is the only input to the lifecycle URLs. What was still wrong
is narrower and was fixed here: deriving the lifecycle URL from the chat URL's *origin* throws away a
prefix, so a deployment served under `http://host/ruke/v1` would control the model at `http://host/unload`.

- `python-backend/ruke_ml/models/provider_config.py`: `RUKE_LIFECYCLE_BASE` names **one base for both**
  `unload_url` and `reload_url`, and the base's path prefix is preserved. An explicit full URL still wins
  verbatim and is reported as `explicit`; the default stays root-anchored off the chat origin and says why;
  both URLs always report the same base so the pair cannot drift; an operator may pin the *control* origin
  without moving the chat origin; the API key is never serialised into a report.
- `lib/server/settings.ts` gained the matching `llmLifecycleUrls` resolution reading the same variable, so
  Next/TS and Python derive the same pair from the same configured value. Rust resolves chat only - no Rust
  code builds a lifecycle URL - so there is no third chain to reconcile.
- Tests: `python-backend/tests/test_provider_config.py` **20 OK** (`logs/f55-py-provcfg-1.log`), including
  `LifecycleBasePreservesItsPrefix` (4 cases) and `HandoffPolicyIsConfiguredNotFlagged` (4 cases: the
  automatic handoff policy is a property of the configured deployment, defaulting to on, with the legacy
  per-run override still winning, and the cascade *reporting which source* decided).
- The resolver never opens a socket (`ResolverDoesNotContactTheEndpoint`), which is what keeps reading
  configuration safe inside a capacity-1 deployment.

Precedence itself is unchanged and still deliberate: `settings.json` > process environment > `.env.local` >
packaged fallback, per key, with `config_source` reported per key and a corrupt file keeping the last good
parse instead of becoming an empty config.

## D-075 (2026-11-17 ~22:55-23:06, session F56) - the PPTX speaker-notes gap is closed at the writer, and the writer stays TypeScript

The F50 reopen probe recorded a real defect in the generated PPTX (see its row in TEST-RESULTS): the file
contained three `notesSlide` parts but every `kind:"note"` block was only the slide-number placeholder -
authored speaker notes were **not** in the deck. That is a writer gap, not a reader gap.

- `lib/documents/pptxEngine.ts` (retained TypeScript owner) now writes the authored notes text into the
  notes slide, and the Python reader (`ruke_ml/documents/parser.py`) surfaces it as a note block with
  slide provenance, so the assertion is about the round trip rather than about either side alone.
- `python-backend/tests/test_retrieval_documents.py` and
  `__tests__/documents/artifact-reopen-parity.test.ts` were extended so the pptx case asserts the note
  **text** survives reopen, not merely that a notes part exists. Python targeted runs
  `logs/f56-py-notes-{1,2,3}.log`, TS targeted run `logs/f56-vitest-reopen-1.log`.
- Because the mode contract text for a pptx mode changed, the byte-pinned contract fixture drifted:
  `logs/f56-golden-1.log` failed with `Fixture drift detected in
  skills/06-mode-contracts-hashes.json` (first difference at line 35, sha `7e7f4dd3...` -> `6c8601f6...`).
  The re-record was **sanctioned explicitly**, not silently accepted:
  `$env:RUKE_GOLDEN_UPDATE="1"` produced `logs/f56-golden-update-2.log` ("re-recorded
  skills/06-mode-contracts-hashes.json: 3 line(s) changed, first at line 35"), and the re-recorded fixture
  then passed without the update flag (`logs/f56-golden-3.log`, 2 OK).
- Contracts regenerated and checked, not assumed: `logs/f56-contracts-gen-1.log`,
  `logs/f56-contracts-check-1.log`; Rust decision crate `logs/f56-cargo-decision-1.log`; typecheck
  `logs/f56-typecheck-1.log`.

**Scope deviation, recorded as a deviation.** This capability is now *functional* end to end, but the
migration status of PPTX generation stays **not migrated**: the owner is TypeScript. Functional status and
migration status are tracked separately in MIGRATION-MATRIX and must not be merged.

## D-076 (2026-11-17 ~23:08-23:30, sessions F56/F57) - a missing measurement is unknown, never zero

Amendment 12 finding 6 (rendering a **missing** memory measurement as `0`) was only partially closed at F50.
The class sweep is now done, and it is a class sweep: the same "0 means unknown" mistake was found and
removed in every measurement-shaped default in the resource path, not in the two places that were already
demonstrated.

- Files changed in this sweep: `models/lifecycle.py`, `models/job_limits.py`, `models/resources.py`,
  `models/devices.py`, `documents/ocr_paddle.py`, `handoff.py`. The rule applied everywhere: a device,
  ceiling, peak, sample count or GPU-state probe that did not produce a number reports `None`/unknown with
  a reason, and the *reporting* layer says "not measured" in words. Only an actual observed zero is zero.
- Provisional estimates keep their basis token (`_basis` / `est_peak_basis` / `est_peak_commit_basis`), so
  a provisional figure can never be rendered as measured. `est_peak_mib 3300` and
  `est_peak_vram_mib 6000` on the OCR window in `models/registry.py` are still **provisional** and stay
  that way until an attended run measures them.
- New `python-backend/tests/test_measurement_unknown.py`: **17 tests OK** (`logs/f58-py-unknown-4.log`);
  the intermediate runs `logs/f58-py-unknown-{1,2,3}.log` are the investigation, kept because they show
  which call sites were actually carrying the zero default.
- The TypeScript equivalent (the lease/coordination reader treating a missing record as "unlocked") was
  audited in the same pass: amendment 12 items 4 and 5 are already closed in `handoff.py`
  (`_classify_record` distinguishing absent / unreadable / corrupt / stale-but-valid, `uncertain` refusing
  admission; `_pack_record` raising `RecordTooLarge` instead of truncating), and the TS side reads the same
  record classification rather than re-deriving "unlocked" from a read failure.

This decision changes no product behaviour for a working run. It changes what a **broken or unavailable**
run is allowed to claim, which is the difference between an honest budget report and a flattering one.

## D-077 (2026-11-17 ~23:35-00:02, sessions F58/F58b) - speech-activity gating is on by default, and what it did is recorded

**The measured defect** (scratch `.data/tmp/g33.py`, `logs/f58-g33-asr-vad-1.log`, one 40 s window over
`.data/tmp/f53_video/audio.wav`, whose real speech sits at 33-38 s):

- `vad_filter` left at the library default (`False`): the model returned a segment at **0.0-2.0 s of pure
  digital silence** reading `"You"`, and the real sentence at **30.0-37.0 s** - i.e. an invented word over
  silence *and* the real speech localised ~3.8 s early.
- `vad_filter=True`: exactly one segment, `33.62-38.62` s, the sentence whole. 0.43 s instead of 0.69 s.

So this is a quality and honesty defect in the default configuration, not a tuning nicety: an ungated window
over silence produces words, and "no segment" after an ungated window cannot be read as "no speech".

Implementation in `python-backend/ruke_ml/speech/whisper_ct2.py`:
- `transcribe(..., vad_filter: bool = True)` is now gated by default; `Transcript.vad_filter` records whether
  any window **actually** ran gated, and `Transcript.vad_state` is one of `VAD_STATES`
  (`not_requested`, `available`, `applied`, `asset_missing`, `runtime_missing`,
  `unsupported_by_backend`, `backend_rejected`) and says what really happened.
- The asset is the one already shipped inside the pinned package
  (`python-backend/.venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx`, existence verified in
  `logs/f58b-g34-vad-probe-1.log`). **No new download, no new dependency, no network in the worker.**
- Gated runs report `complete`/coverage with the honest sentence the amendment demands: a decoded interval
  with no segment after gating is a claim about **speech presence**, not a claim that the audio went
  unexamined; and when gating could not run, the coverage note says so in those terms.
- `vad_merge_silence_duration_s` was tried and **rejected by the pinned signature** (`TypeError:
  WhisperModel.transcribe() got an unexpected keyword argument ...`, same log). It is not used. A
  `TypeError` naming `vad_filter` is classified as a backend refusal, recorded in `vad_state`, and the run
  continues ungated with that stated, rather than failing the whole job.
- `workers/speech_jobs.py` and `allocations.py` carry the state through the worker protocol; the TS
  `lib/server/extract/speech-capability.ts` consumer keeps its five-way separation untouched.
- Tests: `python-backend/tests/test_asr_vad.py` **14 OK** (`logs/f58b-py-asrvad-2.log`), speech-targeted set
  **138 OK** (`logs/f58b-py-speech-targeted-1.log`), full suite at that point **475 OK**
  (`logs/f58-py-discover-1.log`).
- Downstream effect proven, not argued: the video evidence probe had been failing V3 with a segment at
  **27.48-28.88 s inside the silent head** plus a mislabelled tail (`logs/f53-video-probe-3.log`); after
  gating and the fixture rebuild (`logs/f58b-g36-fixture-fix-1.log` shows real frame OCR reading
  `MID-ROLL CARD B 14 s` / `quarterly throughput rose 3.5 percent` off a decoded frame with the
  project-local tesseract) run 4 passed (`logs/f53-video-probe-4.log`).

**Two harness fixes rode along and are recorded separately, because they were harness bugs, not product
wins:** the f53 fixture always rebuilds now (`build_fixture(ffmpeg)`), and V1's earlier OCR miss was a
fixture rendering problem (the authored card text rendered with a y-offset that put the line under the
crop), not an OCR-engine problem. The engine read the rebuilt fixture correctly.

**Still gated and not claimed:** diarization stays `license_acceptance_required` (probe case
`c12_diarize_gated`), and standalone alignment is `speech.align` with word timing only where the provider
supplied it.

## D-078 (2026-11-18 ~00:05-00:30, session F58c) - a decode-window fragment must not be presented as a sentence

**The measured defect.** The frozen E03 probe's C2 check (tail content accuracy over a 21.717 s source)
started failing at 0.538 WER over 13 words once windows became speech-gated. Reading the evidence JSON
(`logs/e03-speech-20261117T18323288777.json`) rather than guessing showed the transcript contained **both**:

- `16.26-21.26` - the complete tail sentence, and
- `16.30-19.30` - `Embrose Finch Park, DeMarune Bicycle Behind`, the **same audio** read by the window that
  ends at 19.0 s, cut mid-word at the window edge.

Windows are `[0,12] [7,19] [14,21.7]` with `window_s=12`, so this is not a model-quality problem at all:
`_merge_windows` only dropped *identical-text* duplicates, so a fragment cut by our own chunking survived as
if it were new content. In production that means a transcript that repeats a sentence mid-word whenever a
sentence straddles a decode-window edge - the exact failure mode a bounded-window ASR design is supposed to
prevent.

**The fix is three provenance rules, none of them text-content heuristics** (`_merge_windows`):
1. each captured segment carries internal window provenance (`entry["_window"] = [window_start,
   window_end]`, computed from decoded sample length, popped before any payload leaves the adapter, pinned
   by a test that asserts it never reaches the wire);
2. `_window_edge_clipped()` says whether a span's edge coincides with a window edge that is **not** the
   source start/end (`BOUNDARY_CLIP_TOLERANCE_S = 0.35`); an edge that *is* the end of the source is not a
   cut and is never treated as one;
3. a clipped fragment is superseded only when an **untruncated** reading from a **different window** covers
   at least `SUPERSEDED_COVER_FRACTION = 0.9` of its span **and** that reading has real audio beyond the
   edge this one was cut at. Readings from the same window never supersede each other (`window_of` map).
   A fragment with no such covering reading is **kept** and marked `window_truncated: true`, because partial
   evidence beats none - and then no caller can read its last word as the end of a sentence.

The superseded fragments are not thrown away: `Transcript.superseded` keeps text, window, which edge was
cut, and which reading replaced it (capped at `MAX_REPORTED_SUPERSEDED = 24` on the wire), the payload gains
`superseded_fragments`, and the coverage note states it in words: "1 reading(s) cut off at a decode-window
edge were superseded by a complete reading of the same span (spans [(16.3, 19.3)])".

**The last hop mattered.** The same amendment class as finding 2: the fields were real in Python and would
have been silently dropped by the production TypeScript caller. `lib/server/extract/speech-capability.ts`
now carries `windowTruncated` per segment, plus `vadFilter`, `vadState`, `supersededFragments`, the
`superseded` fragment list (with malformed fragments dropped rather than cited) and `truncatedSegments`, and
`speechEngineNote()` states what the run actually did - "speech-activity gating applied per window" only when
the worker's own state token says `applied`, `speech-activity gating asset_missing` when it could not run,
and the truncation/supersession counts. A payload with none of these fields renders exactly as before: the
consumer invents nothing.

**Executed evidence, real CTranslate2 on CPU, no mocks:**
- `logs/f58c-e03-2.log` and `logs/f58c-e03-3.log`: `ok: true`, `failures: []`; C1 WER **0.0769**, C2 tail WER
  **0.0769** over 13 words (was the failing 0.538); C2 payload now has exactly two segments
  (`0.0-6.0`, `16.26-21.26`), `vad_filter: true`, `vad_state: "applied"`, `superseded_fragments: 1` with the
  fragment reported rather than transcripted; three decoded windows covering the whole 21.717 s,
  `complete: true`.
- Memory for that run, with the definitions the probe prints: worker peak **working set 395.0 MiB**
  (resident), peak **commit 1,294.0 MiB**, simultaneous peak working set 332.0 MiB over 35 samples,
  resident 181.0 MiB after the jobs, `tree_pids_at_job_end: []` (cleaned up), `gpu_violations: null`.
- `logs/f53-video-probe-5.log`: **all checks passed** after re-running the video probe, because the
  production ASR path changed (run 4 passed too; run 3 is the failure record).

**Tests:** new `python-backend/tests/test_asr_windows.py`, **14 tests OK**, reproducing the exact artifact
through the adapter with named windows and a fake model: merged spans are `[(0.0,6.0),(16.26,21.26)]`, the
fragment text is absent from the transcript, `cut_at == "end"`, `window == [7.0,19.0]`, `superseded_by ==
{start:16.26,end:21.26}`, the tail has exactly one reading, `_window` never leaks, coverage still says three
windows and complete, word timing is retained, and the boundaries where nothing may be superseded (a lone
cut fragment is kept and flagged; two mutually-clipped readings supersede nothing; a reading that ends at
the source end is never "truncated"; partial cover keeps both; a segment with no provenance is never marked;
legitimate repetition survives; overlapping readings inside one window survive; identical-text dedupe stays
the only content-based rule). TS side: two new cases in `__tests__/server/extract-speech-capability.test.ts`
(15 OK, `logs/f58c-ts-speech-1.log`).

**Full gates after the change:** python **503 tests OK** (`logs/f58c-py-discover-1.log`, up from 475), TS
**196 files / 2,534 tests passed, 19 skipped** (`logs/f58c-vitest-full-1.log`), typecheck clean
(`logs/f58c-typecheck-1.log`).

**Limits this does not remove.** This is a *merge-rule* fix over bounded windows. It does not improve
recognition accuracy, does not make the transcript right about content the model misheard, and does not
change that the primary OCR path has produced zero pages. The 1.06 ms "gap" reported between windows is
rounding in the reported float spans, and the probe says so in words instead of silently snapping.

## D-079 (2026-11-18 ~01:10-01:33, session F60) - two explicit bounded budgets, and refuse before spawning rather than let the allocator die mid-load

**The measured trigger.** `logs/f59-ocr-coldload-1.log` plus the worker log
`.data/python/tmp/ocr-paddle-15388/worker-1794943495.log`: the primary OCR worker reached
`model.safetensors` and died with exit code `None` under a **3,814 MiB** job-object commit ceiling. Zero pages.
Amendment 14 section 24.3 had already established why: the pinned paddlex 3.6.1 uses bfloat16 only for
gpu/npu/xpu/mlu/metax/iluvatar, so on CPU the 1,917,255,968-byte bfloat16 checkpoint materialises as **float32
(~3.8 GiB)** of weights before a single page is rasterised, and `precision` cannot shrink that because the pinned
`paddleocr/_common_args.py` maps it to `pptrt_precision` (TensorRT only).

**The decision.**
1. **Two budgets, both explicit, both bounded, in code rather than in prose.**
   `models/job_limits.py` now owns `EXCLUSIVE_LIMIT_ENV = "RUKE_EXCLUSIVE_LIMIT_BYTES"` (:63) and
   `SYSTEM_RESERVE_ENV = "RUKE_SYSTEM_RESERVE_BYTES"` (:64), with `normal_ceiling_bytes()` (:357 - the 4 GB target /
   5 GB hard maximum for the Ruke tree **excluding** the main LLM) and `exclusive_ceiling_bytes(reserve_bytes=...)`
   (:371 - default 7,000,000,000 B, clamped by free commit minus the 2 GiB system reserve, config band 5-12 GB).
   The exclusive ceiling is a **separate configured window** that may use RAM freed by the coordinated unload; it is
   not a removal of protection, and it is never unlimited.
2. **Refuse before spawning.** `documents/ocr_paddle.py::per_worker_limit_bytes` (:342) resolves
   `job_limits.worker_ceiling_bytes(inside_window=..., declared_demand_bytes=..., demand_basis=...,
   ceiling_override_bytes=...)` **before the child exists**, and raises
   `OcrUnavailable("resource_limit", "refusing to spawn: <refuse_reason>", RESOURCE_LIMIT_STEP)` (:436) when the
   ceiling this host can offer is under the demand the capability declares. The old behaviour - spawn, let the
   allocator fail at weight-load, then report a mystery exit code - is gone.
3. **`code None` under an attached ceiling becomes a typed resource condition**, carrying the ceiling and the
   kernel peak charge, and it stays a resource condition in the step text the operator sees: this is not an engine
   fault, raising the hard maximum is not the fix, and units already valid are kept.
4. **Record the dtype the build actually resolved.** `stats["dtype_policy"]` (:683) and `stats["device_echo"]`
   (:677) are what the pinned build reported, so no later agent can claim bf16 CPU execution that this runtime
   cannot do.

**Why not the alternatives.** Raising the ceiling is not a fix - the host has 65,299 MiB total and the main model
already holds 49.6-62.5 GiB of it. Silently skipping pages or downscaling the raster was forbidden by the task and
would have destroyed the quality signal. `enable_mkldnn` / `cpu_threads` / `engine=paddle_static` change speed and
buffers, not the fp32 weight floor. So the honest options were: a typed `resource_limit` result, or the coordinated
exclusive window.

**Consequence that had to be pinned, not assumed.** `device_plan("documents.ocr", 3300, 6000)` = `device:none,
fits:false, needs_handoff:true` - 5,974 MiB required (the **provisional** 3,300 MiB estimate charged 1.5x plus a
1,024 MiB margin) against 5,306 MiB free physical at that moment; 9,256 MiB of VRAM wanted against 2,805 MiB free.
Scratch: `.data/tmp/g42_plan.py`. A measured `est_peak_*` would drop both the 1.5x and the margin, which is exactly
why the measurement run is on the open list and why the provisional numbers are labelled provisional.

**Limits.** This decision makes the refusal correct; it does **not** make OCR work. Primary PaddleOCR-VL-1.6 has
produced zero pages, the exclusive ceiling has never been measured under a real OCR load, and the pre-spawn refusal
is not an acceptance pass.

## D-080 (2026-11-20 ~12:50-13:09, session F61) - one resource-window lifecycle: one death classifier, one allocation-marker authority, one shared funnel reason, one windowed cascade body

Amendment 15 demanded that the fix be applied to the **class**, not the named files. Three separate
"who-decides-what-happened-on-a-memory-failure" authorities existed, and each could disagree.

**The decision.**
1. **One worker-death classifier at every site.** `documents/ocr_paddle.py::classify_worker_death(...)` (:95) with
   `RESOURCE_LIMIT_STEP` (:169) is now the only place that decides whether a dead child was a resource event, and it
   is called at all three sites that can observe a death (:638, :657, :825). `suspected_under_attached_ceiling`
   (:138) fires when the attached ceiling was never reached and the exit code is unknown - and it still says
   *resource*, because an unknown exit under a ceiling that the kernel peak nearly reached is not evidence of an
   engine bug. Pinned structurally so a fourth call site cannot appear silently: the test counts
   `classify_worker_death(` occurrences (>= 3) and `RESOURCE_LIMIT_STEP` (>= 4).
2. **One allocation-refusal vocabulary across the process boundary.** `allocations.py::ALLOCATED_REFUSED_MARKERS`
   is the single authority, and `documents/ocr_paddle_worker.py::DEFAULT_MEMORY_REFUSAL_MARKERS` matches it
   item-for-item (`mkl_malloc`, `the paging file`, `0x8007000e`, `0x800705af`, `cuda out of memory`,
   `cudnn out of memory`, `std::alloc`, `std::bad_alloc`). The parent passes its own list into the child
   (`"memory_refusal_markers": list(allocations.ALLOCATED_REFUSED_MARKERS)`) instead of letting the child keep a
   private copy that could drift. Note for future agents: the module is `ruke_ml/allocations.py`, **not**
   `ruke_ml/models/allocations.py`.
3. **One funnel reason for the whole application.** `workers/jobs.py`:87 maps
   `KIND_TO_REASON["resource_limit"] -> ("memory_pressure", True, ...)`, so every capability that routes through the
   shared job funnel reports a memory refusal as a **retryable memory condition**. Not an engine fault (which would
   blame the model), not `input_rejected` (which would blame the user), not a silent skip.
4. **One windowed cascade body, used by production and by the CLI.** `documents/ocr_cascade.py::_operation(...)`
   wraps primary attempt -> per-unit Tesseract recovery -> durable write inside **one** resource window; the lease
   path, the no-lease path and `handoff.py`'s CLI all call it. `run(..., inside_window=...)` is kept separate from
   `inside_handoff` because those are different facts: holding a coordination lease does not mean the RAM was freed,
   and the ceiling has to follow the latter. `casc["resource_window"]` records which ceiling applied and why.

**What the class audit found (and did not pretend to fix).** Only `documents/ocr_paddle.py` spawns a
ceiling-bounded child. Tesseract, ffmpeg/ffprobe and frame OCR run under the same funnel and the same
allocation-text guard (`runner.py`:41), and `frame_ocr.py` already handles `resource_limit` / `input_rejected`
(:112, :250), but they get **no OS job-object ceiling**. Classification parity is real; enforcement parity is not,
and it is recorded as an open item rather than claimed closed.

**The TypeScript side: investigated, and the reported gap is not a defect.** The suspicion was that
`memory_pressure` got flattened on its way back to the caller. Reading the actual path showed verbatim passthrough
at `lib/server/ml-job.ts`:185 and :257 - with `CACHEABLE_REASONS` **deliberately** excluding it, so a memory
condition is never negatively cached as if the document were unprocessable - plus `extract/document-capability.ts`:374-381,
`attachindex/timeline.ts`:447, `extract/speech-capability.ts`:398 and `lib/rerank.ts`:122 (which treats
`memory_pressure` as an engine refusal, not a skip). It is now pinned by a test rather than by this paragraph.

**Evidence.** `python-backend/tests/test_ocr_resource_window.py` **29 OK** (`logs/f61-py-window-3.log`; the earlier
`logs/f60-py-window-1.log` and `logs/f61-py-window-2.log` are three test-expectation arithmetic fixes, not product
regressions): the low-commit clamp at **3,952 MiB** (4,143,972,352 B); the minimum viable exclusive ceiling for a
provisional 3,300 MiB demand at **5,974 MiB** with `6186598400` and `6264193024` asserted present in
`refuse_reason`; a peak at 98 % of the ceiling reading as *reached* and 95.2 % as *not reached*. Targeted set
**137 OK** (`logs/f61-py-ocrfocus-1.log`). `__tests__/server/extract-document-capability.test.ts` **49 OK**
(`logs/f61-ts-doccap-1.log`, previously 48).

**Limits.** Every one of those tests runs **without importing the OCR engine**. They pin the decision structure;
they are not evidence that a page was ever recognised, that a real fallback ever fired inside a job, or that the
exclusive window actually fits the pipeline. The attended gates remain the only route to green for `documents.ocr`.

## D-081 (2026-11-20 ~21:15-21:35, session F63) - enforcement parity for tesseract / ffmpeg / frame OCR: the D-080 sentence was wrong as an absolute; containment-by-inheritance is real

- **Why the item existed.** The D-080 class audit recorded that tesseract, ffmpeg/ffprobe and frame OCR run under
  the shared funnel and allocation guard "but they get **no OS job-object ceiling**" (DECISIONS.md:1782), with
  classification parity real and enforcement parity "not". Open item 4 asked to record the parity or the reason.
- **The audit against current source shows the sentence is wrong as an absolute - the OS ceiling DOES cover them,
  through inheritance:**
  1. `supervisor.py`:230 installs `job_limits.install_process_job(args.mem_ceiling_bytes)` on the supervisor
     itself **before any worker can spawn** (default `LIMITS.mem_ceiling_bytes` - config.py:147, aggregate
     5,000,000,000 B). The live production proof is the real startup line `logs/f28-dev-1.log`:11: "ruke-ml
     commit ceiling enforced: 5000000000 bytes via windows-job-object (ruke-runtime)".
  2. `job_limits.py`:191-199: processes created later by job members **join the job at create time, with no
     window** - which is exactly why the tree job is installed on the supervisor. Every tesseract grandchild
     (`ocr_tesseract.py`:261 `processes.run_captured`), ffmpeg/ffprobe grandchild (`video/scenes.py`:218 Popen)
     and frame-OCR grandchild is a child of a job member (the supervisor itself or an attached worker).
  3. Every spawned capability worker is attached to **its own private job** or the tree job by
     `models/lifecycle.py::_apply_ceiling` (:316-334; ceiling policy :292-314: free-physical clamp, 256 MiB
     floor, capped by the aggregate). The CreateProcess-to-attach first-kilobytes window is recorded, not hidden
     (:317-322).
- **The precise parity statement (what is now recorded as parity): tesseract / ffmpeg / frame OCR are contained,
  not separately capped.** Only the Paddle worker gets a *private* ceiling plus the pre-spawn
  `worker_ceiling_bytes` refusal, because only it declares a large per-worker demand. The tool-run grandchildren
  are bounded by the containing job's ceiling plus their own per-call bounds (`OCR_TIMEOUT_S`, the 64 MiB PNG
  input cap, `MAX_TSV_BYTES`) and by funnel classification (`OcrUnavailable` kinds at `ocr_tesseract.py`:245-279;
  `workers/jobs.py`:79/:87 maps `allocation_failed` / `resource_limit` -> retryable `memory_pressure`).
- **The ffmpeg row carries a host reason, not a gap.** This host has **no validated ffmpeg copy** (probe verdict:
  "probe blocked: ffmpeg_not_installed no validated ffmpeg copy (override, PATH or project-local)"), so
  `binaries.path_for` refuses before any spawn and containment cannot be demonstrated here; the spawn path is the
  same `processes` funnel, so containment follows automatically once a validated copy exists.
- **What cannot be live-proved from this session today.** The Claude Code sandbox puts every process this session
  spawns into its own job (measured 2026-11-20 21:14: `in_a_job` -> `{'in_job': True, 'pid': 6892}`), and Windows
  allows exactly one job per process - so `install_process_job` on any process started here is refused, and the
  `RuntimeTreeJob` enforcement tests (`tests/test_job_limits.py`:117-148) honestly **skip with the reason and
  win32_error named** instead of faking enforcement. Today's 532-OK discover **includes those skips**. The live
  enforcement evidence remains the production supervisor startup line, re-provable at the next real dev-server
  start and inside the attended OCR run.
- **No code change was made.** The mechanism, the refusal path and the honest skip are already pinned by
  `test_job_limits.py` and by `test_speech_audio.py`:183 (the `spawn_kwargs` stdin/console invariants); adding a
  test that asserts OS semantics the sandbox forbids would fake or skip - it would prove nothing.
- **Corrections and drift noted while auditing.** `logs/f61-py-window-2.log`:52's "commit ceiling" hit is a
  test-assert diff, not a startup line - f28-dev-1.log:11 stays the only genuine one on record. And the :8080
  chain's pids changed between the STATE snapshot (listener 20332 / engine 19400) and the 21:14 tasklist
  (server.py pythons **20956 / 17528**): the Strata chain restarted itself in between; still capacity-1, still
  hands off, still never touched from inside a turn.
- **Item 4 status: recorded.** Parity (containment under an OS ceiling) is real; per-worker private caps are
  not-applicable-by-design for tool runs; the ffmpeg row carries the no-validated-copy reason; live re-proof of
  enforcement from inside this session is structurally blocked by the sandbox job and is scheduled for the
  attended run.

## D-082 (2026-11-20 ~23:05-23:15, session F66) - the rerank caller stopped being hypothetical: four states stated separately, and the registry claim moved with the fact

- **The decision.** Item 5c ("neural embed/rerank production callers - still none") was resolved by auditing
  current source rather than inheriting the doc premise, and by executing the chain live instead of writing a
  status string. The one row split into honest halves: **rerank = implemented, production-wired (since D-058),
  actually-executed (F66) = yes; acceptance-passed = NO. Embeds = Python adapter never wired; TS owner retained.**
- **What the audit found (current source, not memory).** The rerank caller has existed since D-058:
  `turn.ts:344-373` -> `attachindex/rerank.ts::makeRerankStage` -> `ml-job.ts::mlJob("rerank")` ->
  `POST /api/ruke/ml/job` -> supervisor `nn_rerank` worker. The D-046-era sentences ("the Rust ml-job route
  deliberately excludes `rerank`", "only ever executed standalone/mocked") were stale premises; D-068's
  design law (the Rust attach-turn owner has no rerank stage; the wiring is TS retrieval owner -> capability
  route) is what the code actually does. `mlJob("embeddings")` appears nowhere in `lib/` - the `nn_embed`
  adapter was never wired, and TS `attachindex/embed.ts` stays the production owner.
- **The F66 execution (F29's acceptance wording for the route, satisfied).** Scoped supervisor+ruke-server
  topology (exact `dev-supervisor.mjs` spawn/handoff shape, RAM-gated pre-spawn, no :8080 contact, token bytes
  never logged) + `__tests__/server/attach-rerank-live-route.test.ts` (env-gated; skips without env, so the
  standing gates skip it and thresholds stay intact): **5/5 green, VITEST_EXIT=0**. Pinned identity,
  warm-repeat determinism and the bad-mode typed-refusal envelope all hold through the live route; the
  supervisor tree's peak RSS was recorded (**204 MiB working set / 157 MiB commit**, worker pids present at
  peak), which is exactly the "with the worker's peak RSS recorded" clause F29 set.
- **What did NOT move, deliberately.** Acceptance-passed stays NO: the two numeric-fact misses stay failures
  and are now pinned as characterizations **through the live route** by a test that fails on purpose if the
  ranking ever flips (a flip forces the registry/DECISION-OWNERSHIP/FINAL-REPORT reporting to be updated in
  the same change - no silent upgrade); g05 quality numbers (tie, not beat, English-only) are unchanged; no
  phrase was added anywhere ("Do not fix individual examples by adding phrases").
- **Claim-follows-fact on the truth surface.** `models/registry.py` cross-encoder row
  `production_caller_wired: False -> True` (ml-status renders it, so leaving it False was a live user-facing
  lie), the stale comment corrected, the other negatives kept False, and `test_retrieval_neural.py`'s
  truthfulness assertion flipped to True with a note that a future False must come from fixing reality, not
  the assertion. Targeted 25 OK; counts unchanged, so the 532-baseline stands; the new vitest file adds only
  skips without env (final full run must expect 196 passed / 3 skipped files, 2,535 passed / 24 skipped tests).
- **Harness laws learned the expensive way (both fixed in the helper before the green run):** Node >= 18.19
  refuses `spawnSync` of `.cmd` shims (EINVAL) - route through `cmd.exe /d /s /c`; the supervisor re-execs a
  child interpreter (spawn-stub pid != record pid, tree from the stub includes the child) - sample and tear
  down from the pid we spawned, killing both roots.
