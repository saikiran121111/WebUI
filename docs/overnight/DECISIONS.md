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
