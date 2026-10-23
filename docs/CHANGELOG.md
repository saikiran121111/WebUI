# CHANGELOG

## 2026-10-24 — Fix: browser 422s, universal bare-domain Stage-0 scraping, deterministic gate, engine sharding, ASCII logs
Six diagnosed bugs fixed in one pass (browser launch, `skiran.dev` direct search, gate latency, 429 cascade, log mojibake):
- **Browser launch (lib/browser/agentBrowser.ts + interactiveBrowser.ts)**: removed the broken
  `require("playwright-core/lib/server/registry").Registry.default()` deep import (exports-map blocked →
  3-5 traces/request); safe CJS/ESM interop for `fingerprint-generator`/`fingerprint-injector`
  (`mod?.X ?? mod?.default ?? mod`); filesystem scan for the Chromium executable now matches
  `chrome-win64/` (Chromium 1243 layout, not `chrome-win/`); interactive path now passes the FULL
  `{fingerprint, headers}` wrapper to `attachFingerprintToPlaywright` (raw fingerprint threw
  "Cannot destructure property 'navigator'"). `POST /api/browser` start/navigate/done_login → 200.
- **next.config.mjs**: playwright, playwright-core, @crawlee/playwright, fingerprint-generator/-injector,
  header-generator, got-scraping, impit, youtubei.js, linkedom, tldts added to server-external packages —
  header-generator's `__dirname`-relative `data_files/headers-order.json` no longer ENOENTs under bundling.
- **Universal bare-domain detection (lib/web-search/url-detector.ts, new + tldts)**: all 1,440+ IANA TLDs +
  multi-part public suffixes; subdomains under registrable domains and wildcard suffixes (vercel.app/github.io)
  accepted; code-filename guard (ts/tsx/js/…/gguf excluded unless http(s):// or www.); paths preserved;
  `.sh` (Saint Helena ccTLD) deliberately NOT guarded. Stage 0 Direct Target in pipeline.ts: prompt URLs are
  fetched DIRECTLY (engine "direct-target", unshifted before the SERP pool → [S1]) even when every engine 429s;
  extractor tier cascade auto-renders SPA/blocked shells via the Playwright pool.
- **Search gate (search-gate.ts + llm-json.ts)**: 0 ms deterministic bypass when a URL/bare domain is present
  (`gateMs:0 source:"deterministic"` live); gate LLM calls send reasoning_effort/chat_template_kwargs/thinking/
  response_format off-flags; `<think|thinking>` blocks stripped before JSON parse (unclosed blocks included);
  silent fallback to rulesBasedPlan (no WARN).
- **Engines (engines.ts)**: DDG Lite POST (form + cookie prime), GitHub users endpoint, sharded tiering with
  150-300 ms stagger — no same-millisecond 5-engine burst; per-engine circuit breakers contain 429s
  (google/brave/ddg 429'd on this IP → breakers trip, direct target + RSS/JSON engines still deliver evidence).
- **Logs**: `…` → `...` across lib/web-search, lib/browser, lib/server (live logs: zero `ΓÇª`, zero ellipsis).
- **Test**: `__tests__/web-search/url-detector.test.ts` (8 cases: exact user sentence, TLD spread, wildcard
  subdomains, paths/dedup, file guard, version noise, prose). tsc 0; vitest 618 passed | 1 skipped; live
  skiran.dev chat → 200 with S1=skiran.dev (stage-0 SUCCESS_DIRECT) + S2=github profile evidence.

## 2026-10-23 — Feature: Live token meter in the composer footer (Speed tk/s · Context used/max)
User request: replace the static "Output varies based on model that's being used." note with
real, API-sourced stats — `Speed: 56.45 tk/s · Context: 3456/131072` — with no fabricated numbers.
- **Custom endpoint** (`app/api/model-stats/route.ts`, new): server-side proxy so the browser
  never sees the model URL/key; zero inference cost (status reads only).
  `GET /api/model-stats` → upstream `/props` (3 s timeout) → `{ok, model_alias, n_ctx, total_slots}`
  (n_ctx = real max context, 131072 live); `?live=1` → upstream `/slots` → `{ok, processing,
  prompt_tokens, n_ctx}` (exact in-flight prompt size). Upstream unreachable → `{ok:false}` with a
  200 → honest dashes in the UI.
- **Pure logic** (`lib/chat/tokenMeter.ts`, new): `TokenMeterSnapshot {maxContext, contextUsed,
  speedTps, source:"exact"|"measured"|"estimate"|null, backendOk}`; `latestRealUsage` (exact
  prompt+completion from persisted usage frames), `measureLiveSpeed` (real tokens ÷ real elapsed),
  `estimateTokensFromChars` (reuses CHARS_PER_TOKEN), `meterText`/`meterTooltip` (provenance tooltip).
- **Hook** (`hooks/useTokenMeter.ts`, new): /props once per page load; during streaming ONE 1 Hz
  poll (`?live=1`) + EMA-smoothed real rate measured over poll windows; exact server usage takes
  over the instant the turn ends (usage already persists on messages, so exact numbers survive
  reloads). No per-delta state churn — rAF rule §5.3 untouched.
- **UI** (`components/ChatInput.tsx`, `app/page.tsx`): static span replaced by
  `[data-testid="token-meter"]` with tabular-nums + fixed min-width footprint (zero jitter); hero
  variant unchanged (no meta row).
- **Honesty model:** after a turn = server-measured `timings.predicted_per_second` + exact usage
  tokens; mid-stream = exact `n_prompt_tokens` + measured output (this llama.cpp build exposes no
  live generated-token counter via /slots) — the tooltip states exactly this.
- Verified: tsc 0; vitest 14 new units (`__tests__/token-meter.test.ts`); Playwright
  `tests/token-meter.spec.ts` model-free (paced fake SSE with a real-shaped usage+timings frame +
  fulfilled /api/model-stats JSON) — 1/1, 5.0 s, PW_EXIT=0 under §1 lock; endpoint curl smoke:
  real n_ctx 131072 / live prompt_tokens 60770.

## 2026-10-23 — Fix: Compaction actually runs on the real backend (bypass, anchor prompt, visible failures)
User report: "compact is not working at all — context crossed ~100k, auto-compact set at
32k; even manual compact is not working". Four stacked causes fixed end-to-end:
- **Route bypass** (`lib/chat/types.ts`, `lib/chat/client.ts`, `app/api/chat/route.ts`):
  compaction's own /api/chat call now carries `purpose:"compact"`; the route forwards it
  VERBATIM — no slash routing, no Decision Engine, no skill injection, no web-research
  gate. Previously the router classified the stale last message of the history being
  folded and could inject a renderer skill contract mid-payload, destroying the
  `<compacted_context>` output, while the web gate burned minutes of the timeout.
- **Model compliance** (`lib/chat/compact.ts`): `COMPACTION_ANCHOR_PROMPT` — an
  "END OF CONVERSATION… output ONLY the block" user turn appended AFTER the folded
  history. The small local model otherwise treats the payload as a conversation to
  continue (observed: it replayed the last assistant line). The anchor is ephemeral and
  never enters the replacement history. Timeout raised 120 s → 300 s for large prefills.
- **Failures are visible** (`hooks/useChat.ts`, `components/ui/CompactDividerBadge.tsx`):
  `badgeAt` now publishes with `isCompacting` (in-flight "Compacting context…" spinner
  finally mounts) and on failure/no-op runs; the divider renders `data-state="failed"`
  (red, error in tooltip) or `"noop"` ("Context already fits") instead of vanishing.
  Previously every failure was indistinguishable from "nothing happened".
- **Test gap closed** (`tests/auto-compact.spec.ts`): all earlier compaction tests
  intercepted `**/api/chat`, so the real route never ran. Added two unmocked tests
  against the real shared backend: route contract (`purpose=compact` → zero `ruke_stage`
  frames; identical plain turn → frames) and full manual `/compact` end-to-end (settles
  "done", "Context compacted (x -> y tokens)", follow-up replies). Verified 5/5, real
  exit 0, single foreground run under the `.ai-coordination` lock; the user's live
  32k auto setting (wiped by the spec's afterEach reset) was restored.

## 2026-10-22g — Feature: Auto-Compact Context (threshold UI, /compact command, pre-send gate, divider badge)
Per the "Auto-Compact Context" spec:
- **Settings → new "Context" tab** (`components/SettingsMenu.tsx`): auto-compact toggle,
  32k/64k/128k/256k preset chips, Custom input with inline error + Save disabled outside
  8,000–1,000,000, status line "On · 32k"/"Off", and a "Compact now" button for manual
  compaction (`onCompactNow`). Values persist to `settings.json` as
  `compact_thresholds:{auto,tokens}` (`app/api/settings/route.ts` + `lib/server/settings.ts`;
  the server only stores them — the chat UI is the sole reader).
- **Token tracking** (`lib/chat/tokens.ts`): ~4 chars/token + 4 framing per message; the
  gate projects the model-facing history plus the pending user message, so the compared
  number is what the model would actually receive (estimate, not an exact tokenizer).
- **Triggers** (`hooks/useChat.ts`): the pre-send gate in `send()` awaits
  `fetchCompactThresholds()` (module cache; a Settings save calls
  `primeCompactThresholds()` so the very next send sees the new value) and runs
  `compact("auto")` first when estimate ≥ threshold. `/compact` (`components/ChatInput.tsx`)
  and the Settings "Compact now" button both route `app/page.tsx` → `compact("manual")`
  (guarded while streaming/compacting).
- **Pipeline** (`lib/chat/compact.ts`): folds everything except the last 4 raw messages
  (RECENT_TAIL = 4) into the exact "Context Compaction Engine" system prompt;
  `extractCompactedContext()` keeps ONLY `<compacted_context>` and strips the `<analysis>`
  scratchpad (tolerant of a missing close tag); when everything already fits, no model
  call is made ("Context already fits…").
- **History replacement:** the model-facing `llmHistoryRef` becomes
  [system messages…, compacted context as one user message, …last 4]; the next send ships
  exactly `[compacted block, 4 tail, new user]` and later turns do NOT re-fold (lazy
  `llmPendingRef` rebuild applied at the start of the next send/compact). Persisted +
  rendered history is untouched — the full conversation stays scrollable.
- **Divider badge** (`components/ui/CompactDividerBadge.tsx`): "Context compacted
  (128.4k -> 5.2k tokens)" (`compact-divider`, data-state compacting → done) rendered at
  the fold point in the transcript; `/compact` never reaches the model as a chat turn.
- **Real bug found + fixed via E2E:** the SettingsMenu menu-open `fetchSettings()`
  (~566 ms cold dev compile) raced a just-clicked preset — resolving after the click it
  reset compact state to the on-disk value, silently swallowing the user's choice. Fixed
  with a `compactDirtyRef` guard: a late fetch never overwrites a selection.
- **Tests:** `__tests__/compact-pipeline.test.ts` (split/extract/label units) +
  `tests/auto-compact.spec.ts` (3 browser tests: Context-tab validation + save round-trip
  + reload; manual `/compact` fold/badge/no-bubble/full-history-intact; auto gate folds
  once past threshold, ships `[block, 4 tail, user]` with no folded-turn markers and never
  re-compacts on the following send). Fake paced SSE upstream via `route.continue` — zero
  inference-backend load.
- **Verification:** auto-compact 3/3, edit-stop-collapse 5/5, progress-panel 6/6 (all
  lock-protocol, PW_EXIT=0); vitest 595 passed | 1 skipped (52 files); tsc --noEmit EXIT=0.

## 2026-10-22f — UX: web-research trail is a click-to-open popup (gradient card removed)
Reported symptom: the cyan "Web research · 10 sources · 5 domains [Model-gated ⌄]"
gradient bar above the reply "feels pretty bad — completely".
- `components/render/ResearchTrailCard.tsx` DELETED; `ChatMessage.tsx` no longer
  renders it. After the answer streams, sources stay reachable through the [S#]
  citation pills in the reply.
- `components/ProcessingStatus.tsx`: while a gated search runs, the RUKE
  processing line itself is clickable (`web-search-toggle`) and opens a popup
  listing the queries and every source with its link; clicking anywhere outside
  the popup (or pressing Escape) closes it. Testids `research-trail-card` /
  `-gate-badge` / `-source` are kept inside the popup; the gate badge is plain
  grey (no cyan).
- Tests: `search-gate.spec.ts` migrated to the popup contract (click the line
  during the search phase); greeting/search-gate `[data-domain]` assertions fixed
  to `a[data-citation]` — the old locator never matched the rendered pills.
- Verification: search-gate 3/3 (2.4 m real model traffic), greeting 2/2,
  vitest 595/596 (1 skip), tsc EXIT=0 — all lock-protocol, PW_EXIT=0.

## 2026-10-22f — UX: View-all Recents modal is a centered ~60% popup (was full-screen)
- `components/ui/RecentsModal.tsx`: dimmed backdrop + centered dialog
  (`min(60vw,1000px) × min(60vh,680px)`), rounded border + shadow, backdrop
  click closes; conversation rows sit in a centered `max-w-2xl` column a bit
  below the header instead of pinned top-left. All testids unchanged.
- Playwright recents specs → 11/11 green, exit 0.

## 2026-10-22 — Fix: sidebar edge drag no longer collapses/rebounds; open/close is top-bar only
Reported symptom: dragging the sidebar's right border "glitches — it instantly
collapses or comes back to normal size" in both directions.
- Root cause: the edge drag had a hidden collapse gesture (drag left below
  `SIDEBAR_MIN - COLLAPSE_SLACK` = 232 px closed the rail and snapped the
  width back to the pre-drag value), plus an invisible 8 px drag-to-reveal
  strip at the left screen edge when closed. Combined with the ¼-viewport
  width ceiling (at 1280 px windows the 316 px default leaves only 4 px of
  rightward travel), most drags felt dead or springy.
- `hooks/useSidebarResize.ts`: collapse-on-drag and the "reveal" drag mode
  removed; `beginDrag(clientX)` now only resizes, clamped
  `[SIDEBAR_MIN, innerWidth/4]` with the floor winning when a tiny window
  pushes the ceiling below it (matches the CSS, so the handle stays glued to
  the border). `SIDEBAR_MIN` is now 232 — the width the collapse used to fire
  at — so leftward travel is smooth all the way down with no snap-back.
- `components/ui/Sidebar.tsx`: left-edge reveal strip deleted; `onOpen` prop
  dropped; CSS `sm:min-w-[280px]` → `sm:min-w-[232px]`. Top-bar
  "Toggle sidebar" button is now the only open/close control.
- `app/page.tsx`: stopped passing `onOpen`.
- Playwright (ms-playwright chromium, 1600×900): drag right +184 px → 400
  (¼ ceiling), held on mouseup; drag left −300 → 232 and stayed open;
  dragged 82 px past 232 → stayed 232 (no collapse); re-drag right → 400.
  Toggle closed → zero separators (no reveal strip) and rail off-canvas;
  toggle re-opened at saved width; reload persisted 400 (`sidebar-width=400`).
  Console: only the pre-existing favicon.ico 404. Typecheck clean.

## 2026-10-21e — Fix: web-search gate is decided by the MAIN model, not the 1.2B router
Reported symptom: a pure LeetCode algorithm prompt ("partition s … minimum cuts …
palindrome" plus a Rust `impl Solution` stub) triggered a web search whose cited
sources were WhatsApp Web, YouTube Help, Waze (French), Output.com, a Reddit
ChatGPT-custom-instructions thread and a ChatGPT GitHub topic page — i.e. garbage
results for a query that needed no search at all.
- **Root cause 1 — inverted authority.** The LFM2.5-1.2B router was the *sole*
  gate decider. Benchmarked on 44 scenarios (`scripts/eval-search-gate.mjs`):
  **router accuracy 55 % (15 tp / 9 tn / 13 fp / 7 fn, ~479 ms) vs main model
  100 % (22 tp / 22 tn, ~3.3 s), agreement only 24/44.** The main model is now
  authoritative: it returns the verdict *and* the keyword-form query plan in one
  `:8080` call (`MAIN_GATE_SYSTEM_PROMPT`, 35 s cap, 320 max tokens). The router
  still runs, in parallel, purely as telemetry — it can never veto a main-model
  "yes", a main-model "no" beats a router "yes" (logged `agreement:"disagree"`),
  and it is waited on for at most 3 s. It is fallback authority only when the
  main model is unreachable, then deterministic rules.
- **Root cause 2 — garbage query text.** Verbatim prompt echoes were replaced by
  entity-anchored keyword queries (live example: `best biryani restaurants
  Manikonda Hyderabad`).
- **Root cause 3 — no per-result relevance filter on the fused pool.** The lexical
  threshold previously guarded only the vertical engines. `metasearch()` now drops
  any RRF-fused result that shares no core subject token with the queries *or* the
  raw prompt (`SearchPlan.relevanceAnchor`, never searched/cached), with a
  starvation guard. A/B telemetry proves it works: E-Commerce scenario 12 relevant
  sources with the floor vs 1 without; Jobs 14 vs 11.
- **Latency note:** the gate now costs 2.4–6.5 s instead of ~0.5 s. Accepted
  deliberately (correctness over speed); the trivial-greeting short-circuit and
  `WEB_SEARCH_LFM_DISABLED` escape hatch remain, and the router call no longer
  awaits engine warmup.
- **UI:** the Research Trail badge now names the authority that actually decided —
  `Model-gated` / `LFM-gated` / `Rule-gated` (`researchLfm.decidedBy` over
  `X-Research-Lfm`).
- **Regression coverage:** new `tests/search-gate.spec.ts` (algorithm prompt must
  produce no trail card/badge/citation pills; LeetCode-23 sources must be
  on-topic; a live-fact question must search, show `Model-gated` and cite
  on-topic sources). Verified: `tsc --noEmit` clean, `vitest` 545 passed / 1
  skipped, `scripts/e2e-web-search.ts` 0 failures.

## 2026-10-20 — Fix: `npm run dev` now fully owns the LFM2.5 engine lifecycle
Closing the dev terminal left `llama-server.exe` (~500 MB, :8791) and the
decision-engine python pair running, and a black console popup (title = the
venv `python.exe` path) flashed at startup. Strata (:8080) untouched
throughout — every kill is cmdline-verified against `./.decision-engine`.
- **Popup:** the worker was spawned `detached:true`, and DETACHED_PROCESS
  makes Windows ignore `CREATE_NO_WINDOW`, giving console-subsystem python
  its own visible window. Now `detached:false, windowsHide:true` — zero new
  windows (EnumWindows found no python/llama/decision windows in two runs).
- **Orphan root cause (empirically proven):** closing the dev window
  destroys the console and TerminateProcess()es everything attached to it
  (cmd, npm, node, the python pair) with NO handlers running — probes
  verified Node `exit`/SIGINT and Python `atexit`/parent-PID watchdog/
  `SetConsoleCtrlHandler` never fire on that path. llama.cpp additionally
  calls `detach_console()` at startup, so llama-server sits outside EVERY
  console-teardown group: no in-process shutdown can ever reclaim it, and
  console inheritance cannot fix it either.
- **Ownership layers** (`lib/decision/client.ts`): (1) boot reclaim — a
  stale engine holding :8790 is `taskkill /F /T`'d (cmdline-matched to
  `decision_server.py`/`\.decision-engine\`) before any adoption, so dev
  always OWNS the engine it starts; (2) in-process kill-switch on Node
  `exit` (covers Ctrl+C/crash paths where JS still runs); (3) NEW
  `.decision-engine/worker/engine_reaper.ps1` — launched hidden through a
  throwaway PowerShell (`Start-Process -WindowStyle Hidden` +
  `-EncodedCommand`) so its console lives OUTSIDE the dev console group
  (a directly-spawned reaper was itself killed mid-wait); it kernel-waits
  on the dev PID, tree-kills the launcher only if still ours (StartTime +
  cmdline recycled-PID guards), then `taskkill /F /T`'s llama straight from
  `.decision-engine/.cache/llama_server.pid` (its parent is already dead by
  then). Transcript: `%TEMP%\webui-engine-reaper.log`. The script must stay
  pure ASCII and use `${LASTEXITCODE}` — two PowerShell 5.1 parse traps
  (BOM-less ANSI read of an em-dash; `$LASTEXITCODE:` parsed as a scope
  variable) silently killed earlier drafts at parse time.
- **Verified — two consecutive E2E runs of the exact user scenario** (real
  cmd terminal → `npm run dev` → warm (:8791 `/health` 200) → window closed
  via the console-destroy path): ENGINE_COUNT=0 within ~2 s both times,
  :8790/:8791 free, reaper logs `llama taskkill exit=0` then `reaper done`
  (self-exit), Strata pids 2260/17812 + :8080 LISTENING in every snapshot.

## 2026-10-20 — Feat+Fix: Conversation titles — full-conversation semantic auto-titles
Sidebar titles are no longer copies of the first message ("Can you watch
this video an..."). Root cause: the persist effect in `app/page.tsx` froze
`messages[0].content.slice(0,40)` into `meta.title` forever.
- **Server-owned generation** (`lib/server/titles/`): titles come from the
  SAME main conversation model as chat (`LLM_API_URL` :8080 — never the
  LFM2.5 JEV router; JEV routing untouched). The model sees the FULL
  chronological conversation (user+assistant turns, attachment names;
  never system prompts, inlined file content, or reasoning). Long
  histories use chronological chunk summaries → final title (map-reduce);
  never a first/last-only fallback. Writing rules enforced by
  `normalizeTitle` (3–7 words preferred, hard 60-char word-boundary cut,
  quotes/"Title:" prefixes/intros/prose/refusals stripped or rejected —
  an explanation can never reach the sidebar). Tiny budget: 24 output
  tokens (48 per summary), non-streaming, `reasoning_effort:"none"`
  (mandatory: the main model is a thinking model — without it the budget
  goes to reasoning and `content` comes back null).
- **Background queue** (`queue.ts`): serial global chain + per-conversation
  coalescing; initial title once a meaningful assistant reply exists,
  refresh every 4 new messages (`REFRESH_MESSAGE_DELTA`); jobs survive
  navigation, bounded retries (2, 3 s apart); failures keep the last
  valid title; a stale job can never overwrite a newer title
  (`titleGenCount` guard). Title writes never bump `updatedAt`.
- **Inference-slot preemption** (`lib/server/inference-busy.ts`): the chat
  route brackets every user turn; starting a turn aborts all in-flight
  title calls, and title jobs wait for an idle slot first — background
  titling never competes with (or starves) the user's stream. Chat route
  now releases its slot on every path via `pipeTo(...).finally`.
- **Ownership & merge protection**: `meta.titleSource` auto|manual;
  user-renamed titles are never auto-overwritten; `mergeProtectedTitle`
  (`lib/persistence/merge.ts`) stops PUT payloads from clobbering
  server-owned titles. `POST /api/conversations/[id]/title?force=1`
  regenerates on demand.
- **Backfill**: `npm run titles:backfill` (`scripts/backfill-titles.mjs`)
  re-runnable over the HTTP API; corrected 4/4 existing conversations
  with first-message copies, skipped manual ones; never deletes messages,
  recreates conversations, or changes IDs.
- **UI**: sidebar updates live (no reload) via the save-triggered
  `requestTitleGeneration` helper; selection/search/sorting/history
  unaffected.
- **Tests**: 48 new vitest title tests (fake transport — no real
  inference) + 5 Playwright tests (`conversation-title.spec.ts`);
  `conversations-live-chat.spec.ts` locators moved to
  `data-conversation-id` (title text now legitimately changes). Full
  results in `docs/STATE.md` 8.5: vitest 545|1; targeted Playwright
  batches 14 passed / 9 passed, both EXIT=0.

## 2026-10-20 — Hardening: parallel keyframes, 3-stage Whisper VRAM lifecycle, retrieval payload guards
Production hardening pass over `lib/server/extract/{ffmpeg,audio,index}.ts` +
`lib/server/attachindex/turn.ts`:
- **Keyframes parallel + fast-decode**: `videoKeyframesFromPath()` scene pass now
  tries `-hwaccel auto -skip_frame nokey` → `-skip_frame nokey` → full decode
  (partial frames cleared between variants), so a 3-6 h 60 fps lecture decodes
  only container I-frames. In `extractFileFromPath()` the keyframe pass runs
  CONCURRENTLY with audio decode+transcription (`Promise.all`-style eager start
  when `att` present; framesDir cleaned up when the transcript needs no index) —
  zero added sequential wait. 120 s fast-seek fill + 150-frame cap unchanged.
- **3-stage GPU/VRAM Whisper lifecycle** (`audio.ts`): `getFreeVramMb()` via
  nvidia-smi (2 s timeout, null without NVIDIA). Stage 1 ≥1500 MB free →
  cuda/fp16 + `batch_size:8`; Stage 2 GPU busy → optional `LLM_UNLOAD_URL`
  unload, re-probe, and ALWAYS `LLM_RELOAD_URL`/1-token warmup in a `finally`;
  Stage 3 no GPU / still tight / any CUDA error → clean CPU fallback (never
  crashes; one `cudaBroken` flag per process). GPU pipeline `dispose()`d after
  every job — whisper never hogs VRAM during chat. CPU singleton now requests
  `dtype:"q8"` (verified: video-narration "zephyr" still passes).
- **Silence skip + continuous timeline**: pure-silence 30 s windows skipped via
  RMS probe (`WHISPER_SILENCE_RMS` 0.004; windowed decode only when ≥20% silent,
  else single stride call); `normalizeSegmentTimeline()` repairs per-chunk
  0..30 s resets onto one continuous master timeline (6 s stride tolerance).
- **Payload guards**: `attachment_ref` strip verified immediately before
  `forwardStream` (contract test pins the order); keyframe `image_url` parts
  proven user-turn-only (never inside the system block); NEW `anchorQuery()` —
  short (<60 ch) or pronoun-heavy follow-ups inherit the previous user question
  for BM25/vector retrieval.
- New env: `WHISPER_VRAM_FLOOR_MB` 1500, `WHISPER_SILENCE_RMS` 0.004,
  `LLM_UNLOAD_URL`, `LLM_RELOAD_URL` (all optional).
VERIFIED: vitest 497 passed | 1 skipped (46 files, +16 new hardening tests);
tsc only the 4 pre-existing render.spec.ts errors; extraction-API Playwright
(headed, §1 lock) 106 passed EXIT=0.

## 2026-10-20 — Feat: Timestamp-aware knowledge index for oversized attachments (zero knowledge loss)
Long content (3 h course video ≈ 900k chars) used to be hard-truncated at
TEXT_CHAR_LIMIT (48k) AT EXTRACTION — the rest was destroyed. Now anything over
48k chars is INDEXED instead: full text preserved forever under
`.data/attach-index/<attId>/` (full.txt byte-identical to source), sentence-aware
~1200-char chunks (±150 overlap) with whisper timestamps, local MiniLM vectors
(@huggingface/transformers, `.data/models` cache) + BM25, hybrid retrieval fused
via RRF with ±1 neighbor expansion, chronological packing ≤ ATTACH_RETRIEVE_CHARS
(24k). A zero-LLM "spine" TOC + ≤4k-char preview + an invisible `attachment_ref`
content part ride in the prompt every turn; per-turn evidence is injected
EPHEMERALLY into the server-side payload copy only (client history stays slim —
verified: 0 `knowledge_index` blocks in persisted conversations). Regex query
router (0 LLM): point_qa / time_range / sequential / exhaustive / whole_video;
whole_video lazily generates LLM course notes (cached notes.json). Scene-change
keyframes for video (ffmpeg, fallback 120 s seek, cap 150) — nearest ≤4 frames
attach to visual questions. `[HH:MM:SS - HH:MM:SS]` citation headers + explicit
"not inspected" honesty rule. Index GC on conversation DELETE (verified).
INVARIANT: files ≤ 48k chars are byte-identical to the old path. New chip badge
"indexed · N chunks". Env (all optional): EMBED_MODEL, ATTACH_INDEX_CHUNK(1200),
ATTACH_INDEX_OVERLAP(150), ATTACH_RETRIEVE_CHARS(24000), ATTACH_TOP_K(8),
ATTACH_SPINE_BLOCKS(40). Verified: vitest 481|1 (26 unit + 5 recall-integration
incl. head/middle/tail marker recall + time-range window + timestamp headers);
tsc only the 4 pre-existing render.spec errors; curl extract 60k doc → indexed
59 chunks, full.txt byte-identical; curl chat marker turn HTTP 200 marker echoed
through Strata (ref stripped upstream cleanly); whole_video live → notes.json
11.8k chars generated + injected, model summarized from notes and honestly
declared no timestamped citations for an un-timed text doc; DELETE GC removed the
index; Playwright under §1 lock: extraction-API regression 106 passed EXIT=0
(12.4 s) + NEW tests/long-doc-retrieval.spec.ts 3 passed EXIT=0 (32.1 s) —
indexed badge visible, deep marker (58k chars in) answered turn 1, answered AGAIN
turn 2 with no re-attach via history ref. Files: lib/server/attachindex/*
(types/chunk/bm25/embed/spine/router/retrieve/store/build/turn/notes),
lib/server/extract/{audio,ffmpeg,index}.ts, app/api/files/extract/route.ts,
app/api/attach/[id]/notes/route.ts, app/api/chat/route.ts,
app/api/conversations/[id]/route.ts, lib/chat/client.ts, lib/files/docProcessor.ts,
lib/types.ts, components/ChatInput.tsx, __tests__/attach-index.test.ts,
__tests__/attach-retrieval-integration.test.ts, tests/long-doc-retrieval.spec.ts.

## 2026-10-19 — Feat: ALL attachment size/duration limits removed (unbounded uploads + full-length transcription)
Follow-up to the large-upload fix, per user request ("no file size or
duration limits for video or audio"). `MAX_ATTACHMENT_BYTES` deleted: the
client gate (`validateAttachment`) and the server 413 guard are gone — the
upload stream is unbounded and the only real limit is free disk space for
the `.data/tmp` scratch file (empty files still refused). `MAX_AUDIO_SECONDS
(180)` deleted: `audioPcmFromPath` now decodes the WHOLE track — ffmpeg
writes f32le PCM to a scratch file (no maxBuffer ceiling) and the file is
mapped into a Float32Array with a zero-copy view (f32le == native LE
float32); whisper processes it in 30 s chunks, so transcription time simply
scales with recording length. Kept deliberately: the 512 MB guard on the
buffer-based pdf/office/archive/legacy parsers (OOM protection, not media),
and TEXT_CHAR_LIMIT (prompt budget, not extraction). Verified: NEW unit
test "decodes a 200 s track whole — past the old 180 s ceiling" (7/7 in
video-narration); curl 240 s wav → 200 with full-length whisper pass in
2.2 s; extraction-API Playwright block 106 passed (10.9 s) EXIT=0 under
lock; live browser 660 MB video → chip `data-status="ready"`, console only
favicon 404; vitest 450|1; tsc: only the 4 pre-existing render.spec errors.
Files: lib/files/{extensions,docProcessor}.ts, app/api/files/extract/
route.ts, lib/server/extract/ffmpeg.ts, __tests__/video-narration.test.ts.

## 2026-10-19 — Fix: large video/media uploads (32 MB wall removed, uploads stream to disk)
Attachments over 32 MB were rejected ("File is larger than 32 MB") and the
extract route buffered the whole upload twice in RAM (`formData()` →
`arrayBuffer()` → `Buffer`) before ffmpeg copied it to a temp file again.
Now the upload is POSTed as RAW BYTES (`POST /api/files/extract?name=<file>`,
no multipart) and streamed straight to a scratch file under `.data/tmp`;
ffmpeg/whisper read media from that path (`videoFramesFromPath`,
`audioPcmFromPath`, `imageToDataUrlFromPath`) — a multi-GB video is seeked
inside the file, never buffered whole. Text-like files read only a 2 MB head
(prompt caps at 48k chars anyway); buffer-based parsers (pdf/office/archive/
legacy) guard at 512 MB. `MAX_ATTACHMENT_BYTES` raised 32 MB → 4 GB (local
app: the cap is a fat-finger guard, not a hosting limit); `sizeLimitLabel()`
formats the message ("4 GB"). The original file on disk is never moved —
browsers cannot expose a picked file's absolute path, so the bytes cross the
local HTTP boundary exactly once, streamed both ends. Buffer contract
`extractFile(name, buf)` kept as a wrapper (tests unaffected). Verified:
curl 40 MB text 200 (was 413), 660 MB silent video 200 in 2.1 s (2 frames,
60 s duration, scratch cleaned), empty → 400; real-browser upload of the
660 MB clip → chip `data-status=ready`, extract request 200; vitest 449|1
(6/6 video-narration incl. whisper "zephyr"); extraction-API Playwright
block 106/106 exit 0. Files: app/api/files/extract/route.ts,
lib/server/extract/{index,ffmpeg}.ts, lib/files/{extensions,docProcessor}.ts,
tests/file-reading.spec.ts.

## 2026-10-19 — Fix: stopping `npm run dev` now guarantees the contained engine dies (watchdog hardening + orphan reclaim)
Three teardown holes in `.decision-engine/worker/decision_server.py` closed:
(1) startup `_reclaim_orphan_llama()` — a llama-server orphaned by a worker
that died uncleanly used to be ADOPTED via the `/health` early-return
(`_llm_proc` stays None → `_shutdown_llama()` no-op → it outlived every
future worker); now any live :8791 listener at boot is killed (netstat/taskkill
scoped to LFM_PORT only — Strata :8080 is never touched) and replaced by our
own child the watchdog can guarantee to kill; (2) watchdog `OpenProcess`
failure (parent already dead race) now shuts down instead of lingering
forever, and the wait tick dropped 2s→1s; (3) `llama_server.pid` now stores
the LLAMA pid, not the worker's. Plus `atexit.register(_shutdown_llama)` for
manual Ctrl+C. Verified: 2-phase lifecycle script (parent-death watchdog;
taskkill-/F orphan → startup reclaim → new worker's llama watchdog-killed on
parent death) ALL PASS, and a real `npm run dev` boot → `taskkill /T` →
node/worker/llama all gone, :8790/:8791 DOWN, Strata :8080 untouched.

## 2026-10-19 — Fix: folder-structure trees stay interactive at any size, zero mid-stream flicker
`looksLikeTree` counted `│`-only spacer lines as non-tree lines (tolerance
2), so trees with 3+ spacers fell back to a plain CodeBlock (collapsed body
= raw text) and the streaming counts crossing that threshold remounted
CodeBlock↔TreeBlock every few tokens. Detection now treats guide-only and
`...` lines as neutral, `parseTree` skips them, and a monotonic
`looksLikeTreeStart` fast-path mounts the interactive TreeBlock the moment
the first branch line completes — it never flips back mid-generation.
Guarded by 9 new vitest cases (incl. a character-by-character monotonicity
walk) and a new render.spec.ts watcher test asserting no flicker mid-stream.

## 2026-10-19 — Feat+Fix: COMPLETE NEEDLE 3 REMOVAL — single-model LFM2.5-1.2B decision engine
Needle 3 (`cactus-needle` / `needle3.cact`) is dropped from the project
entirely: it cost ~185 MB of resident `_worker.py --child` processes and
150–900 ms of CPU latency per turn while producing low-confidence priors
(0.01–0.04). **LFM2.5-1.2B-Instruct is now the sole, direct decision
model.** (Supersedes the Needle references in every entry below — those
remain as the historical record.)
- **Worker rewired** (`.decision-engine/worker/decision_server.py`): the
  Needle import, `NEEDLE_*` env vars, `CLASSIFY_SYSTEM`, the 9 `route_*`
  tool functions, `ROUTE_TOOLS`, `TOOL_TO_MODE`, `_agent` and
  `_NEEDLE_LOCK` are deleted. `warm()` only ensures llama-server and logs
  `[decision-engine] warm: lfm2.5 on :8791, worker on :8790`;
  `decision()` calls `lfm_decide()` directly with `decided_by = "lfm2.5"`.
- **2-strike failure guard**: the one self-correction retry is kept; when
  both attempts fail validation, the mode resolves deterministically via
  new `_fallback_mode_from_evidence(message)` — the earliest STRICT
  container-noun hit wins ("Build a 500-row transaction tracker with
  SUMIFS …" → `excel`), `standard_chat` only when no container noun
  appears anywhere. `decided_by = "lfm-fail-guard"`, the raw prompt stays
  untouched — never a silent drop to `standard_chat`.
- **Contract slimmed**: `needle_latency_ms` + `needle_prior` removed from
  `DecisionEnvelope` (schemas.py + `lib/decision/types.ts` + every
  envelope builder and test fixture). `lib/server/decision-log.ts` renders
  a single-model box: `LFM2.5-1.2B · decision router · <ms>` with IN/OUT,
  then `ROUTE → WHAT THE UI DOES`. `app/api/decision/route.ts` logs
  `decision: mode=… by=… lfm=…ms total=…ms`.
- **Setup + disk purge**: `setup-engine.sh`/`.bat` now install only
  huggingface_hub/fastapi/uvicorn/pydantic and download the LFM2.5 GGUF —
  no needle mkdir/fetch/download/copy. Deleted: `models/needle3` (34 MB),
  HF needle cache (~35 MB), whistle weights (17 MB, referenced only by the
  removed `NEEDLE_WHISTLE_WEIGHTS`), `site-packages/needle` remnants;
  `pip uninstall cactus-needle` (verified `import needle` fails).
- **Resource win**: engine tree ≈1.54 GB → ≈1.36 GB (llama-server only);
  −150–900 ms/turn; decision latency now ~0.3–1.2 s.
- **Tests re-green**: `decision-log.test.ts` LFM-only fixtures +
  `not.toContain("NEEDLE")`; `tests/test-decision-fallback.py` rewritten
  (stubbed `_lfm_call` fails twice on the SUMIFS prompt → asserts 2
  attempts, `lfm-fail-guard`, `excel`, raw prompt verbatim); router
  11/11, extreme-edge 64/64, audit 12/12 all with `decided_by=lfm2.5`;
  `tsc --noEmit` clean; vitest 439 passed | 1 skipped. Zero needle /
  `_worker.py --child` processes on the live machine.

## 2026-10-19 — Feat+Fix: FINAL MASTER ARCHITECTURE FIX (single-field LFM2.5 container classifier, zero prompt rewriting, clean Needle-3 decoupling)
Six-phase mission: replace the 4-field Stage-2 generation (mode collapse, echo,
hallucinated constraints) and PRIOR-injection pollution with a pure container
classifier; standard_chat forwards the user's message 100% verbatim.
- **PHASE 1 — Single-field classifier (`schemas.py` + `decision_server.py`)**:
  `Mode` Literal lists `"standard_chat"` FIRST; `Stage2Out` is now ONLY
  `active_mode: Mode` (grammar-constrained single-field json-schema, `_lfm_call`
  max_tokens 24). `lfm_input` = optional `[Previous turn artifact mode: <prev>]`
  prefix + the RAW message — the Needle-3 PRIOR string is NEVER injected (Needle 3
  still runs for needle_prior/latency/fallback). `LFM_SYSTEM` replaced with the
  verbatim DEFAULT-chat prompt (chat/Q&A/math/ALL programming default; 8 STUDIO
  containers only when explicitly requested; multi-turn rule keyed on the
  prev-mode prefix; `Reply with JSON only: {"active_mode": "<mode>"}`). LFM
  success → confidence 0.95, `task_constraints=[]`, `extracted_entities=[]`.
  DecisionEnvelope contract UNCHANGED (12 + 3 diagnostic fields).
- **PHASE 2 — Deterministic cleaner + strict container gate**: standard_chat →
  `" ".join(raw.split())` (100% untouched). Studio modes → `_clean_artifact_prompt`
  keeps every spec/number/formula/sheet-name/color verbatim, strips only hostile
  sandbox-refusal sentences and replaces the "Create and execute a Python script
  using openpyxl to generate " lead-in (docx/pptx/reportlab equivalents) with
  "Generate ". Strict container nouns per mode (`_STRICT_CONTAINER_RX` — never
  generic "python/code/calculator/math/table/formula" for excel) + hard coding
  override (code verb + code noun + language/CS term AND zero studio container
  nouns → force standard_chat). NEW promotion guard (deviation, required):
  `_RX_EXPLICIT_ARTIFACT` (routing guard 5) — the verbatim DEFAULT-chat prompt
  made the 1.2B return standard_chat even for explicit deliverable asks
  ("downloadable Excel file named UI_Stress_Test.xlsx…"), and every existing
  guard only DEMOTES; when Stage 2 says chat but the message names a studio
  container in deliverable position, promote back to that studio mode. A guard
  flip also flips the cleaning policy (stripped recompute).
- **PHASE 3 — FastAPI lifespan**: `@app.on_event` → `@asynccontextmanager
  async def lifespan(app)` — zero DeprecationWarning.
- **PHASE 4 — VERIFIED already satisfied (no changes)**: per-message
  `decisionMode` from `x-decision-mode` (useChat.ts → ChatMessage.tsx →
  MarkdownRenderer.tsx; standard_chat renders code fences in shiki CodeBlock,
  never artifact viewers); XLSX_CONTRACT EXECUTION BRIDGE MANDATE + rowGenerator
  in force; skill-loader injects no conflicting openpyxl CLI instructions.
- **PHASE 5 — Fresh-in-RAM verification**: killed old worker (:8790) +
  llama-server (:8791) before probing so the new code loaded fresh. 4/4 live
  probes pass (greeting verbatim + empty constraints; python scientific
  calculator → standard_chat 0B skills; round robin → standard_chat 0B;
  UI_Stress_Test.xlsx → excel + core:xlsx skill, refusal trap stripped, all 6
  sheet names preserved, "Generate" lead-in). Suites: vitest **439 passed | 1
  skipped**; router 11/11; LFM-fail fallback PASS; extreme edge cases extended
  to **64/64** (new #51–64: greeting, scientific calculator, round robin, 10
  coding languages, multi-turn pivots, xlsx stress prompt); audit 12/12 + ALL
  10 hard tokens preserved.
- **PHASE 6 — Full E2E + commit**: headed full suite under the §1 lock protocol
  (`.cache/run-playwright.ps1` owns `.ai-coordination/playwright.lock`):
  **309 passed | 4 skipped | 0 failed, exit 0 (23.4 m)** — 100% green.
- Known deviation to be aware of: for the UI_Stress_Test prompt the 1.2B LFM
  itself still answers `standard_chat`; the excel mode comes from promotion
  guard 5 (the DEFAULT-chat paragraph over-corrects on explicit asks).

## 2026-10-19 — Feat+Fix: MASTER E2E ARCHITECTURAL FIX (Excel stress-test engine, execution bridge, auto-boot, 50 extreme edge cases)
Six-part mission: make the heavy "Create and execute a Python script … UI_Stress_Test.xlsx"
prompt EXECUTE instead of being refused, and harden the whole stack around it.
- **PART 1 — Execution bridge (decision engine)**: `decision_server.py` gained
  Target-Deliverable Routing (an "execute the code / generate a downloadable file"
  intent routes to the artifact mode even amid chat noise) + a deterministic
  `_strip_execution_meta` post-filter (removes "execute rather than describe"
  meta-instructions from stripped_prompt so the main LLM sees a build task, not a
  debate prompt). `lib/decision/contracts.ts` output contracts now carry the
  EXECUTION BRIDGE MANDATE ("write AND run the generator; emit the artifact
  fence; never answer 'I can't execute'"). `lib/decision/skill-loader.ts` strips
  SKILL.md frontmatter + CLI boilerplate from injected core-skill blocks.
- **PART 2 — Excel stress-test engine (xlsxEngine/recalc/XlsxBlock)**:
  `lib/documents/xlsxEngine.ts` rowGenerator deterministically emits 500-row
  sheets ("TXN-1001…TXN-1500", FNV-1a seed → mulberry32 PRNG — byte-identical
  output every run); native charts render to PNG via `renderChartPng` and ride
  into the workbook via ExcelJS `addImage`; conditional formatting (red/amber/
  green) + autoFilter emitted. `lib/documents/recalc.ts` whitelist expanded to
  48 functions. `components/render/XlsxBlock.tsx` applies CF styling in the
  preview + renders chart images inline (SVG, `data-testid="xlsx-charts"`).
  Proven end-to-end: UI_Stress_Test.xlsx = 6 sheets, 500 rows, 0 nulls, 0 recalc
  errors, 3 embedded chart images, 22/22 QA checks PASS, determinism verified.
- **PART 3 — Auto-boot + 7 codebase fixes**: NEW root `instrumentation.ts` +
  `experimental.instrumentationHook: true` — the Decision Engine (worker :8790 +
  llama-server :8791) warm-boots with `npm run dev` (`warmupDecisionEngine()`
  in `lib/decision/client.ts`; `DECISION_ENGINE_AUTOSPAWN=0` opts out).
  `client.ts` spawnPromise reset (failed spawn no longer poisons the singleton).
  Mode gating expanded: `MODE_SCAN_LANGS`/`MODE_RENDER_KINDS` — standard_chat
  now renders mermaid + box-drawing trees (TreeBlock mode-gated via `treeOk`);
  previously-unskipped mermaid tests in render.spec.ts re-enabled. Repo hygiene:
  `.cskills/d3-js-visualization` gitlink → 7 normal files, stale
  `.playwright-cli/page-*.yml` deleted + gitignored, `.repomixignore` added.
- **PART 4 — 50 extreme edge cases**: NEW `tests/test-decision-extreme-edge-cases.mjs`
  — 50 adversarial prompts (empty-ish, unicode, injection-shaped, multi-intent
  collisions, 2600+ char truncation, fence-injection, multilingual) against the
  live worker: **50/50 ALL PASS** (valid envelope every time, mode sane,
  stripped_prompt never empty, no crash). Router 11/11, audit 12/12 + ALL 10
  hard tokens preserved, LFM-fail fallback probe PASS.
- **PART 5 — server 500 fix + Playwright regressions (3 root-caused fixes)**:
  1. `GET /` → 500 `UnhandledSchemeError "node:child_process"`: Next 14's
     instrumentation bundle (edge variant) has NO node externals — bare
     built-ins fail too. FIX: `instrumentation.ts` must use the EXACT literal
     `process.env.NEXT_RUNTIME === "nodejs"` guard (compile-time DCE removes
     the import from the edge bundle; the `!==` early-return form does NOT
     DCE). `lib/decision/client.ts` + `lib/skills/registry.ts` use bare
     built-in specifiers. Result: "Compiled /instrumentation (30 modules)",
     "[decision] engine warm on http://127.0.0.1:8790", GET / 200.
  2. 31 demo showcase tests (anatomy/anatomy-export/cad) went red:
     `kindAllowed(kind, null)` returned false, but demo conversations carry no
     `decisionMode`. FIX (MarkdownRenderer.tsx): `if (!decisionMode) return
     true;` — real chat turns ALWAYS carry a mode (engine-down fallback =
     standard_chat), so the zero-collision guard still covers model replies.
  3. 13 file-reading YES→NO flips: the LFM's 180-token stripped_prompt of an
     attachment turn DROPS the inlined `[file content]` block and invents
     constraint filler, derailing the main model. FIX (app/api/chat/route.ts):
     attachment (parts-array) turns forward the user's text VERBATIM — the
     decision still picks the render mode, only the rewrite is skipped.
  4b. Full-run flakes root-caused as real-model turn patience (not app
     defects): `fixture-txt.diff` + `fixture-video.webm` died on
     "the assistant never finished answering" (model deadline 120/150 s
     expired mid-stream, and the 2-attempt retry loop only caught marker
     MISSES — a timeout threw unretryable); `reasoning-test` had
     WINDOW_TIMEOUT == test timeout == 60 s (assertion could never get its
     full patience; reasoning deliberately ON). FIXES: per-category budgets
     raised to cover 2 attempts (text/image model 150 s/test 380 s, video
     180/520, audio 180/600), slow-turn timeout now retryable once (same
     nondeterminism family as truncated markers — extraction-API test
     proves server text exact), reasoning-test window 150 s + test 240 s.
     pw-final3's last failure was the same family: decision fast, then
     `POST /api/chat 200 in 150536ms` — model rambled in its thinking block
     the whole window (unterminated think → scrubber keeps answer area
     empty); same prompt standalone closes in ~1.4 s. reasoning-test now
     retries the journey once on window expiry (fresh "New conversation",
     new UNIQUE token, test 420 s).
  4c. pw-final4 STILL failed reasoning-test (308|4|1, exit 1) — both retry
     attempts expired → systematic. TRUE root cause: ABANDONED UPSTREAM
     STREAMS. A test that navigates away mid-stream left the route's
     upstream fetch to :8080 running (no abort signal): llama.cpp kept
     generating for the dead request and starved/polluted every following
     turn on the single inference slot (log proof: chart decision with NO
     matching `POST /api/chat` completion line immediately before each
     victim). FIX (app/api/chat/route.ts): `req.signal` → forwardStream →
     upstream fetch signal, so client disconnect cancels generation.
     VERIFIED: abandon a chart stream at 6 s → next turn closes in 2.0 s;
     targeted neighborhood batch (inspect-dup + interactive-ui +
     multi-select-delete + reasoning-test) 5 passed / 0 failed, exit 0 —
     reasoning-test green on its FIRST attempt (125.6 s turn).
  5. `chat-stream` "direct API call" hung ~10 min: worker stripped("Hi") →
     hallucinated "Generate downloadable <artifact>…" boilerplate, which sent
     the main model into an endless reasoning loop (618 KB stream, never
     closed). FIX (decision_server.py): trivial-chat passthrough —
     `standard_chat && len(message) < 120` forwards the message verbatim with
     no constraints. Proxied "Hi" now closes in 2.3 s with [DONE].
- **Verified this session**: `tsc --noEmit` clean; `npx vitest run` → **434
  passed | 1 skipped (435)**; decision suites router 11/11, audit 12/12,
  extreme 50/50, fallback PASS; targeted Playwright re-runs: demo/render batch
  57 passed, file-reading+reasoning+chat-stream batch 218 passed / 0 failed,
  failure neighborhood (inspect-dup + interactive-ui + multi-select-delete +
  reasoning-test) 5 passed / 0 failed exit 0; FULL headed suite (pw-final5,
  §1 lock protocol): **309 passed | 4 skipped | 0 failed, exit 0** (30.0 m)
  — 100% green; vitest re-run vs final code 434 passed | 1 skipped.

## 2026-10-19 — Fix: Decision Engine hardening (lossless stripping, determinism, 9-tool Needle, RAM/latency)
Post-audit targeted patch addressing detail loss, few-shot echo, confidence drift,
weak Needle priors and resource cost:
- **Lossless stripping**: LFM_SYSTEM now demands "LOSSLESS NOISE REMOVAL, never
  summarization" — 100% of numbers/prices/hex colors/column names/formulas/
  dimensions kept verbatim; only conversational fluff + conflicting secondary
  renderer triggers removed. Concrete few-shot examples (the 500-row tracker)
  removed — greedy decoding echoed them verbatim into stripped_prompt; replaced
  with placeholder-format examples only. Deterministic hard-token guard
  (`_preserve_hard_tokens` in decision_server.py) regex-extracts currency/hex/
  numeric/acronym/quoted/capitalized-identifier tokens from the RAW message and
  APPENDS any the model dropped as `Required Specs: [...]` (append-only — zero
  rule-based stripping preserved). `app/api/chat/route.ts` now also forwards
  `task_constraints` the same way instead of dropping them.
- **100% deterministic LFM**: `_lfm_call` pins `temperature 0, top_k 1, top_p 1,
  seed 42, max_tokens 180` — identical prompts now yield identical mode +
  confidence (kills the 0.92-vs-0.23 run-to-run drift).
- **Needle 3 multi-tool router**: single `classify_mode` replaced by 9 distinct
  `route_*` tools (one per RendererMode, 1-sentence descriptions);
  `TOOL_TO_MODE` maps the picked tool back to the mode. Priors are now
  multi-mode (e.g. `['excel','html_render','cad_blueprint']` on the collision
  prompt) and Stage-1 latency dropped to ~135-370 ms.
- **RAM/latency flags**: llama-server now runs `-c 1024 -ngl 0 -t <physical
  cores=6> --batch-size 512 --ubatch-size 512 --no-warmup --no-webui` (bundled
  binary is CPU-only — `-ngl 99` impossible, `--list-devices` reports none).
  `extracted_entities` removed from Stage2Out (4 fields; envelope keeps it for
  TS-contract compatibility).
- **Proven**: router suite **11/11 ALL PASS**; audit table case 10
  stripped_prompt = user's own words (zero few-shot echo); case 11 preserves
  ALL 10 hard tokens (500/Date/Vendor/Amount/SUMIFS/1,250/#FF0000/KPI/pie/
  freeze); multi-turn probe stays 3d_asset; fallback probe PASS with
  `ROUTE_TOOLS` (retry once → Needle prior + RAW prompt). Honest RAM: engine
  tree ≈ 1.54 GB total (llama-server 1355 MB post-load + needle `_worker.py`
  child runtime ~121 MB + uvicorn worker ~63 MB) — the <850 MB target is not
  reachable on this CPU-only binary (Q4_K_M weights alone ≈ 760 MB).

## 2026-10-18 — Feat: Hybrid Decision & Prompt-Stripping Engine (Needle 3 + LFM2.5-1.2B)
All routing/mode decisions now happen BEFORE the main LLM; every hardcoded if/else,
regex and keyword router is gone. 100% project-local: weights, venv, binaries and
caches live strictly inside ./.decision-engine/ (HF_HOME/PIP_CACHE_DIR/TMPDIR
overridden into ./.decision-engine/.cache).
- **Stage 1**: Needle 3 (cactus-needle 3.2.5, stateless `classify_mode` tool) — fast
  prior (top modes + calibrated confidence) fed to Stage 2 as a weak hint only.
- **Stage 2**: LFM2.5-1.2B-Instruct-Q4_K_M.gguf via llama-server (127.0.0.1:8791) —
  ALWAYS runs on every non-empty request: receives raw prompt + Needle prior,
  makes the final mode decision AND generates `stripped_prompt` under
  schema-constrained generation (`response_format json_object + Stage2Out JSON
  Schema` — grammar-verified: the model is token-locked to the 9 Mode literals +
  non-empty stripped_prompt). One self-correction retry on invalid output; on
  second failure the envelope falls back to **Needle 3's top prior mode with the
  RAW prompt** — never a silent drop to `standard_chat`.
- **Zero rule-based stripping**: `stripper.py` regex engine deleted; only
  whitespace normalization remains for the LFM-fail fallback path.
- **Worker**: FastAPI on 127.0.0.1:8790 (`POST /decision`, `GET /health`);
  `.decision-engine/worker/{schemas,decision_server,stripper}.py`. Prompt stripping
  ALWAYS runs; `decision_mode` passthrough pin for repair rounds (engine never re-sees
  error text).
- **DecisionEnvelope**: {active_mode, confidence, decided_by, stripped_prompt,
  skill_to_load, allowed_code_fence, disable_validators[], enable_validator} across
  9 exclusive RendererModes (excel, docs, pdf, ppt, 3d_asset, cad_blueprint, chart,
  html_render, standard_chat).
- **Chat pipeline** (`app/api/chat/route.ts`): engine first → replace last user text
  with stripped prompt → inject ONLY the matched core-skill block
  (`lib/decision/skill-loader.ts`, from ./.cskills/) + output contract → stream
  `x-decision-mode` header. Frontend (`MarkdownRenderer.tsx` MODE_RENDER_KINDS,
  `fenceRepair.ts` MODE_SCAN_LANGS) mounts/validates ONLY the mode-matching
  renderers — an excel turn can never trigger 3D/CAD auto-repair.
- **Removed**: `lib/skills/coreRouter.ts` (keyword router),
  `lib/render/systemPrompt.ts` (static router prompt). Renderers with no matching
  mode (mermaid, widget, resume, powerbi) stay gated off by design.
- **Proven**: `node tests/test-decision-router.mjs` **10/10 ALL PASS** (9 modes +
  ambiguous multi-intent stress "Excel budget sheet + 3D explanation in a note
  column" → excel, 3D validators disabled); every envelope `decided_by =
  needle3+lfm2.5`. `python -I tests/test-decision-fallback.py` PASS (retry fires
  once, Needle-prior fallback, raw prompt kept, zero standard_chat drop). Grammar
  enforcement verified live on :8791 (enum trap). Vitest 436 passed | 1 skipped;
  `tsc --noEmit` clean; Playwright mocks carry `x-decision-mode`.
- Known deltas (honest): worker+llama-server RAM ≈ 940 MB (target 800); Needle
  Stage-1 120–670 ms (target <15 ms) — kept as prior only; LFM2.5 now runs on
  EVERY request (+1.3–2.6 s/turn by design — user chose model-made decisions over
  latency). Needle priors are noisy (`['docs']@0.02` for an excel prompt) — LFM
  anchoring on them was fixed with a qualitative reliability hint + tie-break
  few-shot (never echoes Needle's raw confidence number into the prompt).

## 2026-10-18 — Fix: document-modality batch (dark viewers, pagination, native fullscreen, XLSX values, CAD layout)
22-screenshot issue batch. Every dark override is PREVIEW-ONLY — download
paths are untouched, so files stay professional white paper.
- **PDF/Resume viewer** (`ResumeBlock.tsx`, `globals.css`): PREVIEW_CSS injected
  into the iframe srcDoc — dark #141414 paper, light ink, 44/48 px inner
  margins; fullscreen gets 48 px padding and full-height paper. Downloaded
  PDF stays white (server renders raw `resumeHtml`).
- **Resume certifications/jobs misalignment** (`lib/documents/resumeHtml.ts`):
  `.resume-item-head` float:right → flex row (heading left, date/location
  right, same line, baseline) — an issue date can never wrap under the NEXT
  entry again.
- **Downloaded-PDF pagination** (`lib/documents/printCss.ts`): tables MAY split
  (`table { break-inside:auto }`) but `tr` never breaks and `thead` repeats on
  every page (`display:table-header-group`); charts/flowcharts/figures/cards
  stay whole; orphans/widows 3. Kills the dead-zone page inflation.
- **HTML artifact** (`HtmlArtifactBlock.tsx`, `globals.css`): body-luma probe —
  white reports get `invert(1) hue-rotate(180deg)` in the VIEWER only; content
  taller than the 2400 px clamp now scrolls internally (`scrolling=yes`, fixes
  unreachable split-page tails); fullscreen uses the native Fullscreen API.
- **PPTX** (`PptxBlock.tsx`, `DocumentCard.tsx`, `globals.css`): card-level
  Fullscreen button removed (`hideFullscreen` prop); Run Slideshow now takes
  NATIVE fullscreen (browser chrome hidden; Esc exits via fullscreenchange);
  preview carousel wrapped in `.pptx-stage-clip` (overflow:hidden) — fast
  arrow-clicking can no longer flicker slide text outside the stage.
- **XLSX** (`XlsxBlock.tsx`, `lib/documents/xlsxEngine.ts`, `globals.css`):
  preview runs the SAME pure-JS recalc as the engine (`recalcWorkbook`) —
  formula cells show computed VALUES (with an `fx` badge + formula tooltip),
  never raw "=..." text; the downloaded workbook caches `{formula, result}` so
  Excel/viewers show values immediately (no blank/"####" cells); column widths
  are measured on the FORMATTED display text ("$12,345.67"), not the formula
  source length; fullscreen stretches the grid to the bottom edge.
- **DOCX** (`DocxBlock.tsx`, `globals.css`): preview paper dark #141414 with
  light ink + dark table/chart chrome (download keeps the light print theme);
  fullscreen paper keeps the A4 aspect ratio (width = (100dvh−64px)×0.7071,
  centered) instead of stretching edge-to-edge with dead space below.
- **Architecture CAD** (`ArchitectureCadViewer.tsx`): new `layoutFix` pass —
  labels inside a box re-center (middle anchor + central baseline, so text no
  longer grows right from the center), the box grows symmetrically to fit its
  text, line/flow endpoints buried in a labeled box slide out to its edge
  (slab-method `trimPointToRect`), hotspot rings move to the box's top-right
  corner instead of covering the label. Maps keyed by entity OBJECT IDENTITY
  (renderEntity's index key is layer-local). `lib/skills/coreRouter.ts`
  ARCH_CONTRACT now instructs the model to author centered labels, fitted
  boxes, edge-to-edge connectors and corner hotspots.
- Proven HEADED: `regression_modalities.spec.ts` extended with new guards —
  resume preview bg `rgb(20,20,20)` + flex item heads; xlsx Summary shows
  computed "$215,000.00"/"$0.44" and zero "=SUM(" cell text; pptx card has NO
  Fullscreen button; NEW test: html light-report invert + over-tall
  `scrolling="yes"` → 8 passed + 1 skipped. Full headed suite re-run in
  batches: **314 Playwright tests, 0 failures** (cad 13/13, studio CAD 3/3,
  studio Three 3/3, render/interactive-ui/skills/chat-stream 28/28,
  crud/edit-stop/inspect 13/13, file-reading+reasoning 216/216, live-chat
  2/2, anatomy×3+three3d 28/28). Unit gate 445 passed | 1 skipped; tsc clean.

## 2026-10-18 — Fix: sidebar Select all / Delete toolbar scrolled out of view
- `components/ui/Sidebar.tsx`: the select-mode toolbar (Select all / Delete N /
  Cancel / Select) lived INSIDE the `overflow-y-auto` conversation list, so
  after scrolling down to tick items users had to scroll back up to delete.
  Toolbar moved OUT of the scroll container, pinned directly under the search
  box (same fixed position as search). Scroll container now carries
  `data-testid="conversation-list"` as an explicit test contract.
- `tests/multi-select-delete.spec.ts`: new assertion — scroll list to bottom,
  `select-mode-toggle` + `select-all` MUST stay visible. Proven: 2/2 HEADED
  (`npx playwright test tests/multi-select-delete.spec.ts`, 9.4s).

## 2026-10-17 — Fix: 3D viewport rendered solid black + dock controls only toggled React state
- Two stacked root causes for the black canvas (HUD said 180 FPS · 180 meshes
  yet pixels were all #000):
  1. Buffer level: `preserveDrawingBuffer` was false and the scene had no
     `scene.background` — fixed earlier (stage wrapper 520px `#0b1020`,
     canvas absolute inset:0 z:1, docks z:10, permanent light rig).
  2. On-screen: three r186 `ViewHelper` moved to
     `three/examples/jsm/helpers/ViewHelper.js` and its `render()` has NO
     scissor/clear guard — its internal `renderer.render()` autoCleared the
     WHOLE canvas to black every frame, wiping the main pass. Fixed in
     `lib/three3d/studioEngine.ts` `renderGizmo()`: render the gizmo as a
     depth-cleared top-right overlay (`renderer.autoClear=false` + patched
     `setViewport` to `dw-size, dh-size`; ViewHelper clears depth itself).
- Selection died on every dock click (material sliders never bound): pointer
  handlers were attached to the stage WRAPPER, so dock-button pointerups
  bubbled in → raycast pick → null → deselect. Fixed in
  `components/render/ThreeStudioViewer.tsx`: `if (e.target !== canvasEl)
  return;` guards in `onPointerUp`/`onPointerMove`.
- `lib/cad/normalizeCad.ts`: always emit layer `visible`/`opacity`/`locked`
  defaults (omitting them left the CAD stage empty). `studioEngine.ts`:
  `this.axes.visible=false` (grid/axes default mismatch).
- Proven: new `tests/studio-viewers-visible.spec.ts` 2/2 HEADED
  (`playwright.config.ts` headless:false + slowMo:350) — Test 1 cyberpunk
  hover drone: canvas pixels non-black (all-black MUST fail), shading cycle,
  presets/FOV/projection, gizmos, overlays, Eye/Solo, live Material sliders,
  Explode 0→80→0, GLB+OBJ downloads >100 B; Test 2 coffee kiosk CAD: SVG
  bbox+zone names, layer Eye/Solo, 2D/iso/BIM/split (BIM canvas non-black),
  themes, Tape Measure, Area, .dxf contains SECTION/ENTITIES/LAYER + .svg.
  Visual proof: `test-results/canvas-proof.png` shows the drone on screen.
  `tsc --noEmit` clean, `npx vitest run` 402 passed | 1 skipped.

## 2026-10-17 — Fix: 3D/CAD fences stop rejecting valid model output (Step 8)
- Root cause of "3D scene data did not validate" + "entities.12.content:
  Required (+115 more)": strict zod rejected drift (sphere segs 48 > old
  cap, unknown animation target, cad `text` instead of `content`, `""`-key
  layer). New fault-tolerant normalizers `lib/three3d/normalizeScene.ts` +
  `lib/cad/normalizeCad.ts` (aliases, defaults, caps raised to 64, unknown
  anim targets dropped+warned, single malformed entity skipped);
  `Scene3DBlock.tsx`/`CadBlock.tsx` rewritten to use them; `sceneSchema.ts`
  gains torusKnot/ring/polyhedra/group + material.* slider bindings;
  `geometryKit.ts`/`sceneBuilder.ts`/`materials.ts` updated.
- Dual-mode viewer: new `lib/three3d/codeRunner.ts` (sandboxed
  `new Function("THREE","root","api",…)` — syntax/runtime/empty-scene
  errors reported) + `components/render/ThreeCodeBlock.tsx`;
  `ThreeStudioViewer.tsx` now takes `spec` OR `code`, runs ```threejs
  fences, indexes named parts, drives `onUpdate(delta,elapsed)`;
  `MarkdownRenderer.tsx` routes ```threejs + ```js-that-looks-like-Three;
  `registry.ts` FENCE_OWNERS gains `threejs`.
- Auto-heal: `lib/render/fenceRepair.ts` rewritten
  (`findBrokenRenderFences`, `fenceFixRequest`, `findFenceByLang`,
  `extractFenceBody`; anatomy contract untouched); `hooks/useChat.ts`
  `runRepairRounds` (post-stream, ≤2 rounds, 3D/CAD shows
  "🔄 Auto-repairing 3D/CAD model…", anatomy stays silent) +
  `requestFenceRepair` for runtime failures; `Message.fenceRepair` +
  note in `ChatMessage.tsx` + "🔧 Fix with AI" buttons; `.fence-repair-note`
  / `.scene3d-code-error` in `globals.css`; coreRouter THREE_CONTRACT +
  `systemPrompt.ts` teach both fence modes + cad leniency.
- Proven: `scripts/test-validators.mjs` (both exact failing fixtures →
  valid:true, 0 errors), `tsc --noEmit` clean, full `npx vitest run`
  402/402 (1 skipped), `npm run build` clean.

## 2026-10-17 — Feat: ArchitectureCadViewer (AutoCAD/BIM-grade CAD module, Step 6)
- New `lib/cad/`: `cadSchema.ts` (strict zod `cad` fence contract +
  CAD_BUDGETS), `cad2d.ts` (bbox / shoelace area / angle / iso projection /
  sun position / thermal color + metric & imperial formatting), `svgToDxf.ts`
  (real DXF R2000 with LINE/LWPOLYLINE/CIRCLE/ARC/TEXT on L-* layers),
  `pdfExport.ts` (hand-built vector PDF, spec-correct xref entries),
  `cadStandalone.ts` (offline interactive HTML).
- New `components/render/ArchitectureCadViewer.tsx`: 2D/iso/3D/split views,
  4 themes, layer manager dock (eye/lock/color/opacity/Solo), pan/zoom/wheel,
  Zoom Fit/100/200/400%, measure/area/protractor, snap grid/vertex, crosshair
  + live X/Y, north arrow, scale bar, explode, X/Y/Z section sliders, sun
  06:00–20:00 + compass, hotspot inspector + Ask AI. Exports DXF/SVG/PDF/PNG/
  HTML/GLB/OBJ — all genuine client-side. `CadBlock.tsx` + `cad` fence kind
  wired into `lib/render/{registry,systemPrompt,demoShowcase}`,
  `MarkdownRenderer.tsx`, `globals.css`.
- Fixed `cad2d.ts` imperial length math (2.5 ft now renders 2'-6").
- Proven: `__tests__/cad/` 5 files 31/31, `tests/cad.spec.ts` 9/9 (layer
  hide/solo, measure label, zoom readout, hotspot inspector, iso faces,
  DXF export note, WebGL 3D stats), `tsc --noEmit` clean.
- Step 7 verified: `.cskills/` 27 skills + `.cskills-scenarios/` 27 JSONs,
  `./skills/` = humanizer only, `tests/skills.spec.ts` 4/4.

## 2026-10-17 — Feat: ThreeStudioViewer (Blender/Maya-grade 3D studio, Step 5)
- New `lib/three3d/studioEngine.ts` (`StudioViewer`): shading modes (Rendered
  PBR+postFX / Solid-MatCap / Wireframe / Wireframe-on-Shaded / Normals /
  UV checker / Unlit / X-Ray), Perspective+Orthographic, FOV 20–110, named
  views + top-right ViewCube gizmo, outliner tree with hide/solo, raycast
  select + TransformControls (Q/G/R/S, Local/World), material editor, 6 env
  presets (`studioEnv.ts`, PMREM), 3-point lighting sliders, bloom/SSAO/
  vignette/tonemap, timeline + speed + clips + universal Explode (radial
  bbox-center cache), HUD (FPS/meshes/verts/tris/calls/bbox), 4K PNG.
- New `lib/three3d/standaloneExport.ts` (standalone .html w/ three CDN +
  R3F .tsx component), `components/render/ThreeStudioViewer.tsx`,
  `Scene3DBlock.tsx` now a thin wrapper; `exporters.ts` gains
  `exportMesh` (obj/stl/ply/usdz via official addon exporters);
  `sceneSchema.ts` export formats widened; `systemPrompt.ts` +
  `globals.css` (`.studio-*`) updated.
- Proven: `__tests__/three3d/meshExporters.test.ts` 4/4 +
  `__tests__/three3d/standaloneExport.test.ts` 6/6, `tests/three3d.spec.ts`
  3/3 (HUD, labels, outliner select, shading/views/explode, GLB re-import
  note, 9 export formats), `tsc --noEmit` clean.

## 2026-10-17 — Feat: Two-tier skill architecture + Core Skill Intent Router
- `CLAUDE.md` + `AGENTS.md`: STRICT SKILL MANAGEMENT RULES now describe two
  tiers — user skills (`./skills/` + `./skill-scenarios/`, visible in UI) and
  core hidden skills (`./.cskills/` + `./.cskills-scenarios/`, installed ONLY
  by the developer via `npm run cskill:add`), 100% invisible in GET
  /api/skills, the Skills Modal, slash autocomplete and the load_skill enum.
- `./skills/` + `./skill-scenarios/` reduced to humanizer only; new
  `scripts/install-core-skill.mjs` wired as `"cskill:add"`;
  `app/api/skills/install/route.ts` hardened to reject `.cskills` tampering.
- 27 real core skills installed under `./.cskills/` (11 threejs-*, 11 r3f-*,
  archify, anatomy, architecture-diagram, diagram-design) — every folder has
  a genuine downloaded SKILL.md; all 27 `./.cskills-scenarios/*.json`
  populated (autoUse true + whenToUse + triggerKeywords).
- New `lib/skills/coreRouter.ts`: the only reader of the core tier. Pure
  `selectCoreSkills` picks sub-skill bundles (3d base/conditional, R3F swap +
  twins, image→blender-glb-pipeline, arch per-keyword); `applyCoreSkillRouting`
  injects one `<core_skill_routing>` system block (9 KB/skill, 56 KB total)
  + the matching output contract. Wired into `app/api/chat/route.ts`.
- Proven: `__tests__/skills/coreRouter.test.ts` 13/13 (pure selection + real
  `./.cskills/` injection + zero-token no-op + never routes humanizer),
  `tsc --noEmit` clean. `openai/plugins` `three-webgl-game` does not exist
  upstream — not installed, not fabricated.

## 2026-10-17 — Feat: Universal Skill Installation & Lazy-Loading Engine
- Fake skill packs moved to `archive/skills/**`; deleted `lib/skills/{intent,
  loader,anatomyIntent}.ts` + `__tests__/{anatomy,three3d}/{intent,loader,
  skillLoader}.test.ts`. Root `CLAUDE.md` + `AGENTS.md` carry the mandatory
  STRICT SKILL MANAGEMENT RULES (never fabricate SKILL.md, downloads only via
  `npx -y skills add`, routing lives only in `skill-scenarios/*.json`).
- New engine `lib/skills/{types,frontmatter,modality,registry,lazy}.ts`:
  registry moves CLI installs out of `.agents/skills`/`.claude/skills` into
  `./skills/` (zero duplicates, dangling-symlink cleanup via `isBrokenLink`),
  never overwrites an existing scenario, blocks external image/video-gen
  skills (`modality.ts` STRONG/WEAK + code-viz allow), lazy loader enforces
  Mode 1 `/skill-name` intercept and Mode 2 `<skill_router>` + `load_skill`
  tool + keyword pre-router (SKILL.md body never in prompt unless matched).
- New routes `app/api/skills/{,install,[skillName]/scenario,[skillName]}`
  (GET/POST/PATCH/DELETE); chat route emits `X-Used-Skill` → pill in
  `components/ChatMessage.tsx` (wired through `lib/stream/parser.ts` onMeta,
  `lib/chat/client.ts`, `hooks/useChat.ts`, `lib/types.ts`).
- New UI `components/SkillsModal.tsx` (install + installed tabs, Manual/
  Auto-Scenario/Blocked badges, autoUse toggle, whenToUse edit, delete) and
  `components/ChatInput.tsx` skills button + floating slash autocomplete.
- Live proof: installed `blader/humanizer` through the running service —
  `skills/humanizer/SKILL.md` genuine download, `skill-scenarios/humanizer.json`
  exactly the 7-field spec (autoUse true, 4 triggerKeywords).
- Proven: `__tests__/skills/` 4 files 29 tests (1 skipped — Windows symlink
  privilege), full `npx vitest run` 348/348, `tsc --noEmit` clean, new
  `tests/skills.spec.ts` 4/4 (pill via fulfilled SSE, modal badges, slash
  menu open/Escape/Enter-insert).

## 2026-10-16 — Feat: silent anatomy fence auto-repair
- New `lib/render/fenceRepair.ts`: locate broken ```anatomy fences by
  offset, phrase the exact validation error as a repair request, splice
  the model's corrected fence back into the same bubble (MAX_FENCE_REPAIRS=2).
- `hooks/useChat.ts`: `repairAnatomyFences` runs post-stream, pre-finalize,
  reusing the send AbortController (stop() cancels repair rounds); the
  repair turn never enters visible or persisted state — the user sees the
  finished figure, not the error. AnatomyBlock's error note remains as the
  honest last resort after both rounds fail.
- `skills/anatomy/SKILL.md`: top-level `title`+`label` marked REQUIRED
  (anatomySchema.ts:385/388 — a fixture without `label` failed zod).
- Proven: `__tests__/render/fenceRepair.test.ts` 11/11 (incl. guard that
  the repair prompt still triggers Anatomy pack injection), new
  `tests/anatomy-repair.spec.ts` 2/2 (broken→corrected renders
  `svg.anatomy-svg`, zero `anatomy-error`; always-broken = exactly 3 chat
  calls + honest fallback), render+anatomy vitest 277/277, tsc clean.

## 2026-10-16 — Fix: anatomy skill docs caused the model's invalid fences
- `skills/anatomy/SKILL.md`: rod line now documents REQUIRED `r` (the schema
  always demanded it — 37 model rods failed `parts.N.r: Required` because the
  docs omitted it); new "JSON emission discipline" section (compact
  single-line JSON, no `...` skeletons, fixed-length coord arrays,
  required-field cheat sheet, ≤20k-char fence size); iteration rule now
  references the exact error the UI shows. `lib/render/systemPrompt.ts`:
  anatomy line demands compact, never-abbreviated JSON.

## 2026-10-16 — Fix: anatomy fallback now names the exact validation error
- `lib/render/schemas.ts` `parseJsonFence`: JSON syntax errors return V8's
  message (offending token + position); zod errors return `path: message
  (+N more)` instead of a bare first message.
- `components/render/AnatomyBlock.tsx`: error note shows that detail and tells
  the user to ask the model to fix the exact error and re-emit the fence.
- Proven: `__tests__/render/schemas.test.ts` 18/18 (new path/count assertions).

## 2026-10-16 — Feat: Anatomy advanced architectural runtime (v2)
- `lib/anatomy/anatomySchema.ts`: `profile` ("standard" default | "advanced")
  + `budgetsFor`; advanced budgets ≤240 logical / ≤700 rendered parts, ≤14
  controls, ≤100 floors, ≤8 modules, ≤48 connections+flows; new `groups`,
  `floors`, `modules`, part `group`/`floor`/`visibleWhen`/`info`, control
  `toggle.group` / `button.action` / `select.target`, `connections` + `flows`.
- New `lib/anatomy/floorModules.ts` (`expandFloorModules`: one authored module
  reused by many floors, instance ids `floor__part`). `anatomyBuilder.ts`:
  renderer-side rendered-part cap throws instead of silently truncating +
  aggregated explode warnings. `liveEngine.mjs`: layer toggles, floor select
  dims other floors (building context kept), system isolation, flow
  play/pause/reset, click-to-inspect info panel, wheel zoom/pan/reset +
  fullscreen. `AnatomyBlock.tsx`: collapsible layer sections, fullscreen,
  info panel. `skills/anatomy/SKILL.md`: advanced-profile contract section.
- Fixed `standaloneSvgMarkup` in `AnatomyBlock.tsx`: `querySelector("svg")`
  matched a lucide download-icon svg, so SVG/PNG downloads exported the icon;
  now `svg.anatomy-svg`. PNG test asserts IHDR 1280×1040 (2× the 640×520
  figure).
- Showcase: FIG 5 six-level service-core cutaway (advanced profile).
- Tests: `__tests__/anatomy/` 7 files 74/74 (new `floorModules.test.ts`,
  `stress.test.ts` — AETHERION 80-floor/497-part benchmark, 44.9 ms);
  `tests/anatomy.spec.ts` 18/18; new `tests/anatomy-export.spec.ts` 5/5 +
  `tests/helpers/aetherion.ts` — HTML/SVG/PNG/TSX downloads proven
  standalone (file:// interactivity), incl. AETHERION through
  `/api/anatomy/export`.

## 2026-10-16 — Fix: Anatomy routing honors explicit "Anatomy skill" invocation
- `lib/skills/anatomyIntent.ts`: an explicit invocation ("use the Anatomy
  skill/runtime/…") now overrides the mode-D subject exclusion (a user
  knowingly asking for a building cutaway gets Anatomy) and neutralizes
  weak mesh wording ("not a genuine 3D mesh" disclaimers); a NAMED mesh
  format (GLB/GLTF/FBX/USDZ/3MF/STL) still routes to the 3D pack.
  Implicit architecture/C4/chart requests stay excluded (mode D intact).
- `__tests__/anatomy/intent.test.ts`: +3 tests (explicit-over-exclusion,
  disclaimer wording, named-format-wins). anatomy vitest 44/44, tsc clean.

## 2026-10-16 — Feat: Anatomy isometric technical-illustration skill (WebUI-only)
- New `lib/anatomy/`: upstream kit vendored verbatim (MIT v1.1.0, commit
  e9488296…, `LICENSE` + `NOTICE.md`), `anatomySchema.ts` (strict zod
  `anatomy` fence contract: 11 part kinds, budgets, formula whitelist,
  dup-id/parent/slide/accent validation), `anatomyBuilder.ts` (spec → SVG
  plate + liveSpec, painter's-order depth sort, fit projection),
  `liveEngine.mjs` (zero-import vanilla runtime: rAF gated by
  IntersectionObserver, sliders/explode/needle/readouts from one state
  model, reduced-motion stillness, destroy() cleanup).
- New `components/render/AnatomyBlock.tsx` (lazy builder+engine import,
  light/dark theme, part-click → refinement send, honest "SVG vector
  illustration — not a 3D mesh" badge, SVG/PNG/HTML/TSX downloads) +
  `app/api/anatomy/export/route.ts` (standalone HTML with the engine
  inlined, self-contained React component; zod-strict request).
- Skill pack `skills/anatomy/**` (3 SKILL.md) added to `skills/manifest.json`;
  `lib/skills/anatomyIntent.ts` + domain-gated `lib/skills/loader.ts`;
  anatomy instructions replace the 3D pack in `app/api/chat/route.ts`.
  `lib/render/registry.ts` + `MarkdownRenderer.tsx` route ```anatomy fences;
  `lib/render/systemPrompt.ts` router rules updated (anatomy vs scene3d vs
  asset3d vs "not for architecture/C4/charts").
- Showcase: `/demo-anatomy` + `?demo=anatomy`
  (`lib/render/anatomyDemoShowcase.ts`, 4 figures: single-cyl head, dial
  indicator, hydraulic pump, connection pool).
- Tests: `__tests__/anatomy/` 5 files 41/41; `tests/anatomy.spec.ts` 7/7
  (slider→readout 30.0→42.0 + piston transform, explode, theme, downloads,
  mobile 390px, reduced-motion). Fixed `tests/conversations-crud.spec.ts`
  unarchive reload race (see ISSUES.md). No new npm deps.

## 2026-10-16 — Feat: AI 3D design system (procedural scenes + genuine AI meshes)
- New `lib/three3d/`: `sceneSchema.ts` (strict zod v2 `scene3d` + `asset3d`
  contracts, budgets), `geometryKit.ts` (lathe/extrude/tube/primitives),
  `materials.ts`, `lighting.ts`, `camera.ts`, `sceneBuilder.ts` (deterministic
  spec→Object3D + animation clips + stats + dispose), `exporters.ts`
  (GLTFExporter GLB/GLTF + `validateGlb` + `reimportGlb` proof), `zipWriter.ts`
  (store-only zip, no new dep), `viewerCore.ts` (orbit/pan/zoom, grid/axes/
  wireframe/playback/reset/fullscreen/stats/pick), `providers/{types,meshy}.ts`
  (Meshy v2 text-to-3d, preview→PBR refine, OBJ+MTL+textures→zip).
- New `app/api/3d/assets/{,[id],[id]/download}` routes: key stays server-side,
  honest 503 when unconfigured, 409 on not-ready/absent format; the browser
  only ever sees opaque `meshy:pv|rf:<id>` job ids and same-origin URLs.
- New `components/render/Asset3DBlock.tsx`; `Scene3DBlock.tsx` rewritten to
  the v2 contract; `components/MarkdownRenderer.tsx` routes `asset3d` fences;
  `lib/render/{registry,systemPrompt,demoShowcase}.ts` updated; `.env.example`
  gains `MESHY_API_KEY=` (empty).
- New WebUI-local skill pack: `skills/manifest.json` + 8 `skills/3d/**/SKILL.md`
  served by `lib/skills/{intent,loader}.ts`; `injectThreeSkills` in
  `app/api/chat/route.ts` splices matched skill text before the last user
  message. Never registered as Claude Code skills.
- Tests: `__tests__/three3d/` 7 files 49/49; `tests/three3d.spec.ts` 3/3
  (viewer tools, export re-import proof, honest 503 path, credit-safe API
  probes via route mocks). Full regression 45/45 across 10 specs.
- Fixed `tests/conversations-crud.spec.ts` archive test (see ISSUES.md).

## 2026-10-16 — Feat: 60fps smooth motion for all chart interactions
- New `hooks/useTweenedNumbers.ts`: rAF easeOutCubic tween of numeric vectors;
  snaps instantly on vector-shape change or `prefers-reduced-motion`.
- `components/render/ChartBlock.tsx`: AxisMarks/BarMarks/ScatterMarks/PieMarks
  now render from tweened values, axis scales, and bar layout scalars —
  slider drags, legend toggles, rescales and pie sweeps glide at native
  refresh rate; chart-type switch crossfades (`chart-marks-enter`).
- `app/globals.css`: opacity-only enter fades (marks, ticks, tooltip),
  `.chart-mark:hover` fill-opacity lift, reduced-motion disables all fades.
- Proven: frame-sampling shows 21 distinct height+width frames per legend
  toggle (~320ms ease-out); reduced-motion browser context snaps instantly.
  Chart e2e 3/3 green, `tsc --noEmit` clean.

## 2026-10-16 — Fix: header-click sorting dead on tables under 5 rows
- `components/render/MarkdownTable.tsx`: sort gate `rows >= 5` → `rows >= 2`
  (the footer hint always advertised sorting; 4-row tables silently ignored
  header clicks). New e2e "markdown table with 4 rows still sorts on header
  click" in `tests/render.spec.ts`; markdown-table specs 3/3 green.

## 2026-10-16 — Task 7: Live KPI value cards & formula calculators
- `lib/render/schemas.ts`: `kpiSliderSchema` + `kpiCardSchema` joined the
  `widgetSpecSchema` union as `kind:"kpi"` (sliders max 8, cards 1–12; value/
  unit/prefix/delta/trend/sparkline/formula/detail/bindSlider/operation).
- `components/render/WidgetBlock.tsx`: `KpiWidget` — responsive Obsidian grid
  (#0d0d12 cards, `rgba(255,255,255,0.08)` border, tabular-nums), trend badges
  (up #34D399 / down #FB7185 / neutral #38BDF8), inline SVG sparkline
  (viewBox 0 0 100 30, `.toFixed(2)` coords), sliders recompute bound card
  values and scale sparklines live (multiply/add/percent), card click →
  #38BDF8 border + formula/detail callout + "Ask AI about this metric" → onSend.
- `lib/render/systemPrompt.ts`: kpi fence instructions; `lib/render/demoShowcase.ts`:
  KPI showcase (growth/extra sliders; mrr/cogs/margin/forecast cards);
  `app/globals.css`: `.kpi-*` chunk with reduced-motion guard.
- `components/render/MarkdownTable.tsx`: rolled back to `308188f` per the user
  (row-ask bar gone); `.md-row-ask-bar` CSS left in place.
- Verified: `tests/interactive-ui.spec.ts` 1/1 (4.5 s) — slider recalc
  ($52k→$104k, forecast +10k→$62k), callout text, `is-selected`, ask →
  message appended, zero NaN SVG attrs, zero console/page errors. Test clicks
  "Stop generating" before the 2nd ask (useChat `sendBusyRef` allows one send
  at a time) and whitelists the `[PARSER] AbortError` stop diagnostic.

## 2026-10-16 — Fix: orphaned mermaid error boxes at page bottom
- `components/render/MermaidBlock.tsx`: added `suppressErrorRendering: true` to
  `mermaid.initialize`. Mermaid 12.2.0 injected its "Syntax error in text" SVG into
  `document.body` on parse failure and threw before removing the temp `div#d<id>`,
  leaving error boxes stuck at the page bottom (one per failed render attempt).
  Our own error fallback (source code block) already covers the failure.
  Verified: `npx tsc --noEmit` clean, `npx vitest run tests/render.spec.ts __tests__/render`
  → 189/189 pass.

## 2026-10-16 — Open Intelligent UI + Gemini Interactive UI upgrade
- New interactive render layer + showcase, all verified by
  `tests/interactive-ui.spec.ts` (1/1, zero console errors, zero NaN SVG attrs):
  chart type switcher + mark-click explainer + Ask AI hand-off + legend switches +
  param sliders (`components/render/ChartBlock.tsx`), mermaid `%%step:` playback
  with synced node/edge glow + click-to-inspect (`components/render/MermaidBlock.tsx`),
  lazy three.js scene with attitude sliders + raycast inspect
  (`components/render/Scene3DBlock.tsx`, three + @types/three installed locally),
  table row-click → "Ask AI about this row" bar (`components/render/MarkdownTable.tsx`).
- `lib/render/themes.ts`: `OBSIDIAN_SERIES_COLORS` + `OBSIDIAN_MERMAID_THEME`
  (pure-black `#050507`/`#0d0d12`, luminous accents); `app/globals.css`:
  `.viz-active-node`/`.viz-dimmed-node`/`.viz-active-edge` glow classes +
  `viz-edge-flow` under `prefers-reduced-motion: no-preference`.
- `lib/render/systemPrompt.ts`: `VISUAL_ROUTER_SYSTEM_PROMPT` (when/how to emit
  chart/mermaid/scene3d/table blocks + `%%step:` comments) prepended to every
  request in `lib/chat/client.ts` `buildBody()`.
- `/demo-ui` page + `?demo=ui` query (`app/page.tsx`, `lib/render/demoShowcase.ts`)
  exercise every interaction client-side — no model server needed.
- MermaidBlock fixes (see ISSUES.md): mermaid-12 node/edge id parsing
  (`normalizeNodeId`, `edgeEndpoints`) and imperative `stage.innerHTML = svg`
  replacing `dangerouslySetInnerHTML` so highlight classes + listeners survive
  React re-renders. Typecheck clean.

## 2026-10-16 — filter menu All/Clear redundancy fixed
- User: in the right-click filter dropdown, "Clear" and "All" do the same
  thing. True: `clearColumnFilter` deleted the value filter AND re-checked
  every box — identical to All unless a text term happened to be set.
- `components/render/MarkdownTable.tsx`: Clear now unchecks every value
  (`commitMenuChecked(new Set())`) so you can tick one value without
  unticking the rest; `clearColumnFilter` deleted. The "contains" term
  button toggles off when its term is active. `updateFilterMarks` keys on
  `has(col)` not `size > 0` — an empty selection hides all rows and must
  still mark the header filter-active.
- `tests/render.spec.ts`: filter test extended (term toggle off → 6 rows,
  Clear → 0 rows + "0 of 6 rows" chip, All → 6 rows). Suite 9/9, tsc clean.

## 2026-10-16 — expanded-table tall-row gaps fixed
- User: right after expanding a wide table, every row is ~120px of empty
  space; it only compacts after the first drag. Root cause: in auto layout
  cells wrap, and the row's tallest cell was an OFF-screen column's long
  text (Best For/Community) wrapping to 4-5 lines — invisible, yet it set
  every visible row's height. `cols-resized` (drag) sets td nowrap, which is
  why dragging "fixed" it.
- `components/render/MarkdownTable.tsx`: `syncOverflowClass` toggles
  `cols-nowrap` on the table whenever it overflows the scroller; runs in the
  resync effect, on drag pointerup and on dblclick reset.
- `app/globals.css`: `cols-nowrap td` = nowrap + ellipsis (same one-line
  grid look as hand-sized columns, from the first moment).
- Regression: new e2e "expanding a wide table keeps rows compact before any
  drag" (overflow true, rows 37px ≤48). Table+drag suite 9/9, typecheck clean.

## 2026-10-16 — expanded-table column drag fixed
- User: on an expanded (wide) table, dragging header edges left/right does
  nothing and columns snap to ~56px with headers overlapping. Root cause:
  `startResize`'s clamp computed available width from `scroller.clientWidth`
  — valid only while the table fits the scroller. Expanded tables overflow
  it, so `availW` went ≈0/negative and every drag pinned the column to
  MIN_COL_WIDTH; the last column (no explicit width) also collapsed to 0.
- `components/render/MarkdownTable.tsx`: two regimes — fits scroller: old
  filler/clamp behavior kept; overflows scroller: every visible column
  (last included) gets a fixed width and the drag grows/shrinks the table
  itself (scroller scrolls further), floor stays MIN_COL_WIDTH.
- `app/globals.css`: `cols-resized th` gets `overflow: clip` +
  `overflow-clip-margin: 8px` so narrow headers clip instead of bleeding
  over the neighbour (clip-margin keeps the -6px resize handle grabbable).
- Regression: `tests/render.spec.ts` 20-col test now drags expanded edges
  (+150 → 96→246px, −100 → 246→146px). Table suite 6/6 + drag specs 3/3,
  typecheck clean. (Earlier red runs were a stale/cold dev server, not code.)

## 2026-10-16 — mid-stream edit/stop fixed + collapsible user bubble
- User: editing the input while generating "redirects to homepage" and the
  generation can't be stopped. Root cause: `edit()` never aborted the
  in-flight stream — slicing to `slice(0, idx)` could empty `messages` (hero
  EmptyState returns), and the orphaned send held `sendBusyRef`, swallowing
  the regeneration; `stop()` never finalized the partial bubble (cursor
  blinked forever); the composer textarea was `disabled` mid-generation.
- `hooks/useChat.ts`: `edit()` aborts first, then `setTimeout(() => send(...), 0)`
  (the old send's finally is pure microtasks, so the guard is released before
  the macrotask); `stop()` and send's aborted branch flip the bubble to
  `complete`; send guard uses `sendBusyRef` (the old `status === "streaming"`
  check read a stale closure value).
- `components/ChatInput.tsx`: textarea no longer disabled while streaming
  (send button already swaps to the stop button; `handleSend` still guards).
- `components/ChatMessage.tsx` + `app/globals.css`: user messages ≥600 chars
  or ≥12 lines render clamped (6-line `-webkit-line-clamp` + fade mask) with
  a Show more/less toggle — collapsed the moment the message is sent.
- `tests/edit-stop-collapse.spec.ts` (new, 5/5): stop mid-stream finalizes +
  content stops growing; composer editable mid-generation, Enter doesn't
  double-send; edit mid-stream → no hero, old upstream connection closed,
  only the SECOND_REPLY survives; long bubble collapses/expands/re-collapses
  (scrollHeight vs clientHeight); short messages get no toggle. Regression:
  chat-stream + conversations-live-chat + render + reasoning specs 24/24.

## 2026-10-15 — table round 8: funnel filter button removed
- User: right-click already does filtering, the funnel icon is dead weight.
- `components/render/MarkdownTable.tsx`: deleted the funnel button, `filtering`
  state, `toggleFilter`, `buildFilterRow`, `syncFilterRow`, every
  `.md-filter-row` guard/skip, and simplified `thead tr:not(.md-filter-row)`
  → `thead tr`. Row-count chip now shows when a right-click filter is active
  (`filterMenu || visibleRows < rowCount`). `app/globals.css`: filter-row
  block + reduced-motion entry removed. Test rewritten to the right-click
  flow (menu search → contains term → Clear).

## 2026-10-15 — table round 7: no raw-pipe flash before the table appears
- User screenshot: for ~1s the header line of a 22-col table shows as plain
  pipe text before becoming a table. Root cause: remark-gfm only recognizes a
  GFM table once the whole `| --- | … |` delimiter row has streamed in.
- `components/MarkdownRenderer.tsx`: `stabilizeStreamingTables(content)` runs
  only while `streaming` (finished messages parse exactly as written; open
  code fences skipped). If the tail is the header line → append a synthesized
  delimiter; if the tail is delimiter-ish (`|`, `-`, `:`, spaces only) →
  replace it with a full one sized to the header above. First test run still
  failed: a short `| --- | --- |` is syntactically complete but mismatches a
  22-cell header, so the guard must be cell count, not syntax.
- New paced-SSE e2e "a streaming table renders as a table immediately, never
  as raw pipe text": 10 chars/frame, DOM sampled every 80ms — no paragraph
  ever contains pipe text, wrap appears while `data-state="streaming"`.
  Render spec 19/19, tsc clean.

## 2026-10-15 — table round 6: wide tables stay collapsed while generating
- User screenshot mid-generation: 15-col table showed rows 1–3 collapsed to
  4 columns but rows 4–5 exposing columns 5–8 with no headers. Root cause:
  `measure` (one-shot, on pointer-enter) + `applyColHidden` toggled
  `col-hidden` only on rows that existed at that moment — rows React
  streamed in afterwards got none of the component's imperative state.
- `components/render/MarkdownTable.tsx`: deleted `measure`/`onPointerEnter`;
  added a `useLayoutEffect` resync (no dep array) that after every render
  recomputes counts/sortable, re-applies collapse (widths reset only when
  the hide flag flips), re-applies active filters, re-syncs resize handles,
  and grows/shrinks the filter row (`syncFilterRow`) when columns drift.
  `useLayoutEffect` not `useEffect`: passive effects run after paint, so a
  streamed row would flash full-width for one frame before collapsing —
  the first test run proved exactly that (`row 12 leaked 15 columns`).
  `toggleCols`/`toggleFullscreen` simplified to flipping `expanded` only.
- New e2e "a wide table stays collapsed while it is still generating":
  paced SSE server streams a 15×30 table at 15ms/frame; the DOM is sampled
  every 120ms while `data-state="streaming"` — header ≤4 visible columns,
  zero rows past 4 visible cells, table fills the wrap (no blank gutter);
  after DONE, expand toggle still reaches 15. Render spec 18/18, tsc clean.

## 2026-10-15 — table round 5: 20-column stress table stays readable
- User screenshot of a 20-col × 40-row table: expanded columns squeezed into
  41–88px one-character-per-line slivers with 138–158px rows. The blank
  gutter in the collapsed shot did NOT reproduce — round 4's flex filler
  already fills the wrap (probe: tableW == scrollerW).
- `app/globals.css`: `table.md-table:not(.cols-resized) th/td { min-width: 6rem }`
  — columns keep a readable floor and the scroller takes horizontal scroll
  instead of crushing them; skipped while hand-resizing (drag clamp owns the
  56px floor there).
- New e2e "a 20-column table stays readable collapsed and expanded": collapsed
  fills the wrap, expanded every column ≥90px, rows ≤80px (734px wrap →
  1920px scrollable grid). Render spec 17/17, tsc clean.

## 2026-10-15 — table round 4: last column absorbs slack, no blank gutter / infinite drag
- Reproduced with e2e: dragging the last column's handle left left a blank
  gutter (table narrower than the wrap) and right grew the table without
  bound — the round-3 width pinning made the grid a fixed block inside a
  scrollable wrap.
- `components/render/MarkdownTable.tsx`: Excel rule — the last visible column
  is the flexible filler: no explicit width (fixed layout hands it the
  container's leftover, so the table always fills it) and no resize handle
  (its edge is the grid edge). Middle drags are clamped so the filler never
  drops below `MIN_COL_WIDTH` (56px). `addResizeHandles` → `syncResizeHandles`
  (adds/removes handles when the visible set changes; called from
  `applyColHidden` + `measure`). Bug caught by the test: capture must measure
  widths *before* adding `.cols-resized` (fixed layout equalizes auto columns
  first — captured 122px instead of 78/61/57/71).
- Test rewritten: widen/runaway(+900px clamp)/shrink/fullscreen phases assert
  `tableW == scroller.clientWidth` after every drag, filler absorbs the delta,
  last column has no handle in fullscreen. Render spec 16/16, tsc clean.

## 2026-10-15 — table round 3: spreadsheet-grade column dragging (Playwright-proven)
- Reproduced the complaint with e2e geometry sampling: shrinking a column made
  row heights jump 57/37 → 77px (fullscreen: whole table reflowed) because
  `width:100%` + `table-layout:fixed` redistributed the freed space across every
  column, re-wrapping text mid-drag.
- `components/render/MarkdownTable.tsx` `startResize`: pins `table.style.width`
  to the exact sum of column widths at drag start and on every move — freed
  space stays freed, other columns never budge.
- `app/globals.css`: once `.cols-resized` is active, tbody cells clip with
  `nowrap + text-overflow: ellipsis` (Excel semantics) — row heights are
  constant while dragging; widening a column reveals the text again.
- Grab ergonomics: handle widened 8→12px (`right:-6px`), faint grip line on
  header hover, solid accent guide on the active edge, `body.md-col-dragging`
  keeps the col-resize cursor and blocks text selection across the whole page.
- A drag no longer fires a phantom sort on release (`suppressSortAfterDragRef`);
  manual widths are reset when columns expand/collapse (hidden cells were
  captured at 0px) and on double-click reset (`resetColWidths`).
- Test extended: widen + shrink + fullscreen drag phases, asserting other
  columns ±2px and row heights ±1px throughout. Render spec 16/16, `tsc` clean.

## 2026-10-15 — table round 2: drag-resize columns, right-click value filters, sticky fullscreen header
- Column resizing: drag handle on each header's right edge (`.md-col-resize`); first
  drag switches the table to `table-layout: fixed` with captured widths; double-click
  resets. Excel-like per-column sizing.
- Right-click a header → filter dropdown: checkbox list of unique values (sorted,
  capped 200) + search box that doubles as a custom "contains" text term; All/Clear
  footer; filtered headers get a `.filter-active` accent mark; state survives menu
  re-open. Left-click still sorts; bottom hint now spells out all three gestures.
- Fullscreen: sticky `thead` with opaque background while scrolling rows.
- Bug found by e2e: `applyFilter` only looped columns that had filter-row inputs, so
  dropdown filters did nothing while the funnel row was closed — now loops all header
  columns. Proven by new spec "right-click header filter and drag column resize
  work like a spreadsheet" — render spec 15/15 green.

## 2026-10-15 — table toolbar: filters, column collapse, fullscreen, grid lines
- `components/render/MarkdownTable.tsx`: top toolbar (row count + filter/columns/
  fullscreen icon buttons, fullscreen at top right). Per-column filter row injected
  into `thead` imperatively (`.md-filter-row`), live substring filtering with
  "x of y rows" count. Tables with 5+ columns collapse columns past the 4th behind
  a "+N" expand toggle (`.col-hidden`). Fullscreen = `is-fullscreen` fixed overlay
  on the wrap (Esc closes, body scroll locked, columns auto-expand while open).
  CSV now exports visible (unfiltered) rows and skips the filter row.
- `app/globals.css`: column partition lines (`th+th`/`td+td` border-left), topbar/
  ctl/filter-row styles, `.col-hidden`, `.md-table-wrap.is-fullscreen` overlay,
  reduced-motion guards.
- `tests/render.spec.ts`: new e2e "collapses wide columns, filters rows and opens
  fullscreen" — render spec 14/14 green.

## 2026-10-15 — crash on math messages + free scrolling during stream
- "Expected usable value but received an empty preset" (unified): `lib/render/math.ts`
  returned `rehypePlugins` as a flat `[plugin, options]` pair and `MarkdownRenderer`
  spread both as separate entries → unified received the KaTeX options object as a
  standalone preset (no plugins/settings) and threw. Now a proper `[[plugin, options]]`
  tuple passed through untouched. Proven by `__tests__/render/mathPlugins.test.ts`.
- Unable to scroll up mid-generation (`app/page.tsx`): the 120px dead zone re-pinned
  any upward scroll closer than 120px to the bottom, and wheel-up unpin raced a
  same-frame rAF pin (React state flushes after the rAF). Now direction-aware
  hysteresis (any upward move unpins; re-pin only within 8px of bottom) + synchronous
  `stickToBottomRef` clear in the wheel handler.

## 2026-10-15 — six rendering fixes from user screenshots + all-139-language proof
- No colors/indentation for html/css/most languages: TextMate grammars embed others
  (cpp→regexp…, vue→vue-directives…, typst→tex…) and only the requested one loaded →
  "Missing languages"; one failed load poisoned every later one. `loadGrammarTree` in
  `lib/render/highlight.ts` loads embeddedLangs recursively (canonical names, new
  `grammarDependencyLoader` map in `lib/render/languages.ts`) and resets the highlighter
  on any load failure. Re-keying a grammar to its registry key now strips that key from
  its own aliases (proto→protobuf, lean→lean4 threw "Circular alias"). Proven by
  `__tests__/render/allLanguages.test.ts`: all 139 keys load and emit line spans.
- Double line spacing in code: Shiki emits "\n" text nodes between block-level .line
  spans → extra anonymous line boxes. `stripLineNewlines` transformer removes them.
- Dull colors: vivid dark/light palettes in `lib/render/themes.ts`.
- Folder-structure fences → interactive IDE tree: `lib/render/treeParse.ts` parses
  box-drawing/ASCII trees; `components/render/TreeBlock.tsx` adds icons, CSS guide rails,
  click-to-collapse (grid `minmax(0,1fr)`→`minmax(0,0fr)` — a bare `0fr` keeps the
  track's auto minimum and left a 15.6px gap), collapse-all, exact-source copy.
- List markers invisible: Tailwind preflight strips list-style → globals.css restores
  disc/decimal in markdown prose. Heading inline code now scales 0.85em (the stray "5."
  next to a tiny chip).
- Highlighting only appeared when the fence closed: debounce → throttle-with-trailing
  (200ms) in `components/render/CodeBlock.tsx`; the `seq === highlightSeq` guard also
  discarded every result resolving during a fast stream — replaced with monotonic
  `appliedSeq` so the newest-resolving highlight always paints.
- Verified: `tsc --noEmit` clean; `__tests__/render` 187/187; `tests/render.spec.ts`
  13/13 (mid-stream test uses a paced SSE server — `route.fulfill` delivers in one chunk).

## 2026-10-15 — project-wide rendering upgrade (Shiki, tables, mermaid, charts, widgets)
- Root cause of white code: Prism emitted token spans but no theme CSS existed anywhere.
  Replaced with Shiki core + JS regex engine, dual dark/light themes (`lib/render/themes.ts`),
  ~110-language lazy registry with aliases + honest "Plain text" fallback (`lib/render/languages.ts`).
- New `lib/render/` (highlight LRU cache, clipboard helper, fence registry, math detection,
  zod chart/widget schemas) and `components/render/` (CodeBlock with line numbers/wrap/
  collapse/download + exact-source copy; MermaidBlock with pan/zoom/inspect/fullscreen/SVG
  export + source-preserving invalid fallback; ChartBlock hand-built SVG + data table;
  WidgetBlock form/tabs/accordion with validation + follow-up send; MarkdownTable with
  sorting + CSV).
- `components/MarkdownRenderer.tsx` rewritten: fences route through the registry (fixes
  language-less fences rendering as inline code), lazy KaTeX gated by `mathDetect`.
  `ChatMessage.tsx`/`app/page.tsx` pass streaming + onSend, copy via `copyText`.
- `app/globals.css` chunks 1–4: Shiki dual-theme override, gutter/diff/wrap, tables,
  diagram stage, charts, widgets, prose typography, KaTeX.
- Tests: 5 vitest files under `__tests__/render/` + `tests/render.spec.ts` (8 e2e).
- Deps installed (user ran npm install). Grammar ids audited against the installed
  @shikijs/langs dist: fortran→fortran-free-form, postgresql key now loads the `sql`
  grammar, sshconfig→ssh-config, systemverilog→system-verilog; removed 9 languages with
  no grammar in the pack (meson, prql, antlr4, gitignore, svg, mustache, sed, reason,
  purebasic) plus their aliases/labels. Prism dropped from package.json.
- Verified: `tsc --noEmit` clean; vitest 57/57; `npm run build` clean;
  `tests/render.spec.ts` 8/8 green (dev server :3000 + mocked SSE, no model).
  Test fixes along the way: wait for the first colored token before counting
  (async grammar chunk load) and normalize LF→CRLF before the clipboard
  fidelity compare (Windows rewrites line endings at the OS layer).
  `types/prismjs.d.ts` deleted. Full suite not run — file-reading layer 2
  needs a live model on :8080.

## 2026-10-14 — videos now carry their audio (Whisper transcript) into the prompt
- `lib/server/extract/index.ts` — the `video` case only sampled frames; the audio track was
  dropped entirely. It now also runs `audioPcm()` + `transcribePcm()` when the clip has a
  decodable audio stream (try/catch keeps silent videos frames-only), capping the transcript
  to `TEXT_CHAR_LIMIT`.
- `lib/chat/client.ts` — the `video` prompt branch ignored `transcript` even when present;
  it now appends an "Audio transcript:" part. Exported `attachmentParts` for testing.
- `__tests__/video-narration.test.ts` — 4 new unit tests: narrated mp4 (muxed with the
  spoken-codeword fixture wav via bundled ffmpeg) yields frames + a transcript containing
  "zephyr"; silent mp4 stays frames-only with no error; prompt parts include/omit the
  transcript accordingly. 19/19 unit tests + typecheck pass.

## 2026-10-14 — fixed stream scroll jitter (top/bottom oscillation during generation)
- `app/page.tsx` — replaced the per-chunk `messagesEndRef.scrollIntoView()` auto-scroll with a
  single rAF-coalesced bottom pin (`pinToBottom` + `stickToBottomRef`), a scroll listener that
  disengages past 120px, and a wheel-up listener that disengages immediately on scroll-up.
  "Jump to latest" re-engages the pin. `messagesEndRef` removed entirely; added
  `data-testid="messages-scroll"` to the scroll container.
- `scripts/scroll-verify/{mock-upstream,check}.mjs` — SSE mock (:8081, 350 chunks @8ms) +
  Playwright sampler (40ms): FAILs on >120px drift, visible pill, or upward scrollTop jumps.
  Before/after proof: old code FAIL (2311px drift, pill 157/164 frames), fixed PASS
  (maxDist 24px, 0 pill frames, 0 up jumps). Kept as regression tooling.

## 2026-10-14 — sidebar multi-select delete
- `components/ui/Sidebar.tsx` — "Select" button enters select mode (checkboxes on every
  row, "Select all" toggle); once ≥1 selected the button becomes "Delete N". Selection
  state self-prunes when conversations disappear. Removed unused imports.
- `app/page.tsx` — `confirmDeleteIds` state + `confirmDeleteMany` (parallel DELETEs,
  deletedRef tombstones, clears open chat if it was among them) + second ConfirmDialog.
- `tests/multi-select-delete.spec.ts` — 2 tests: full UI flow (cancel path) and a real
  seeded delete verified via API 404.
- Note: the dev server's compiler worker had crashed ("Jest worker encountered 2 child
  process exceptions") making all API routes 500 — restarted; all 7 CRUD tests pass again.

## 2026-10-14 — file reading verified end to end
- `playwright.config.ts` — pins `PLAYWRIGHT_BROWSERS_PATH` to `.data/ms-playwright` so the
  Chromium download stays inside the codebase instead of the user profile.
- `.data/ms-playwright/` — Chromium 153 + headless shell + winldd downloaded (gitignored).
- Ran the suite headed, in four slices, while the user watched:
  - Layer 1 `extraction API`: 106/106 (12.3 s).
  - Layer 2 `the model reads the file`: 22 + 13 + 58 + 13 = 106/106.
  - Layer 3 `formats that cannot be tested`: 3/3 (documents the .rar/.heic/.heif skips).
- `docs/STATE.md`, `docs/ISSUES.md` — created (neither existed before).

## Earlier this task (already verified, kept for the record)
- Added `lib/server/extract/` (office, rtf, notebook, archives, strings, pdf, ffmpeg,
  audio) behind `app/api/files/extract/route.ts`; deleted `app/api/files/extract-pdf/route.ts`.
- Added `lib/files/extensions.ts` (extension-first classification for the full format list)
  and rewired the client pipeline + attachment chips.
- In-repo deps only: `ffmpeg-static`, `@huggingface/transformers` (whisper), `7zip-bin`,
  `node-unrar-js`, `unpdf`. Nothing installed globally.
- `scripts/make-fixtures.mjs` — 106 fixtures + manifest; `tests/file-reading.spec.ts` — the suite.
- `.gitignore` += `.data/`, `tests/fixtures/`; `tsconfig.json` excludes `.next`, `tests/fixtures`.
