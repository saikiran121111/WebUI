# AI-INTERNAL STATE SNAPSHOT (8-Section Deep Compaction Format)
Synced: 2026-10-25 — BUGFIX CYCLE: stale task hijack of live sessions + verbatim URLs + sandboxed launch (no --no-sandbox infobar)
[SUPERSESSION NOTICE 2026-10-26: the interactive/internal browser subsystem was REMOVED
repo-wide (lib/browser/**, app/api/browser/**, browser_api fence surface, settings
browser_engine, public/fixtures/browser-fallback, .data/browser-profile, Tier-2
browser-operator, browser specs + unit tests). Every "browser" LOCKED-DONE line and
8.4 browser contract in the 2026-10-25 sections below is HISTORY ONLY — never
resurrect it from these notes; the replacement architecture is the user's pending
decision (design references: reverse-engineering/internal-browser/). Unaffected:
lib/web-search/agentBrowser.ts + lib/documents/browser.ts headless pools, ssrf
isSafeUrl, the 7-tier web pipeline, and the Part-2 golden fixtures.]
[LOCKED-DONE, ALL VERIFIED]: TASK_TTL_MS=2h enforced in loadTask (raw AND cached
branches, rm's the expired file → an old/test-run flow can never resurface, and its
skip-if-done sigs stop poisoning real clicks); isStaleTask + authContext render a
waiting_for_* park whose page contradicts the live tab as "STALE … Do NOT send
resume_task for it" (park on the CURRENT page or browser closed KEEPS the resume
directive — legit consent/login parks untouched); taskFlowMismatch + clearTask at
chat route step 5b on explicit browser intent (a fresh request supersedes an old
park); intent.extractBrowserUrl injects the user's url VERBATIM ("targets this
EXACT url: … Copy it VERBATIM") + MEDIA play guidance (navigate verbatim → click
player → else keyboard_nav ["k"]); interactiveBrowser BOTH visible launches pass
chromiumSandbox: true — launched automation Chrome cmdline verified FREE of
--no-sandbox, Chrome's warning infobar gone. Prior cycles (speed upgrade, universal
agent, OS-only pivot) stay LOCKED-DONE below.
FINAL VERIFICATION (real exit codes): `npx tsc --noEmit` EXIT:0; `npx vitest run`
66 files / 721 passed / 1 skipped EXIT:0; `npx playwright test
tests/browser-fallback.spec.ts` 17/17 (4.5 s) PW_EXIT:0; `npx playwright test
tests/browser-engine-panel.spec.ts` 4/4 (49.2 s) PW_EXIT:0. Lock released.

[8.1 CORE OBJECTIVE & ACTIVE PHASE]
Mission (delivered this cycle): the LIVE-FAILURE BUGFIX CYCLE — a Playwright
fixture task parked on disk (`exhausted.html`) hijacked real chat turns into
resume_task → about:blank, a youtu.be link was re-typed down to `youtu.be`, and
the automation window showed Chrome's "--no-sandbox" warning infobar. Fixed by
task TTL + STALE directive suppression + route-level supersede + verbatim-url
injection + chromiumSandbox:true. Prior cycles stay locked: the browser-engine
SPEED UPGRADE (six fixes + Tier-2 .cskills/browser-operator skill) and the
universal multi-browser agent + OS-only pivot (user's own Chrome validated). All
complete. Search-first routing
(7-tier web-search pipeline, incl. Tier 3b readWithInteractiveProfile login-wall
fallback) preserved untouched. Explicit browser intent acts immediately
(hasExplicitBrowserIntent in app/api/chat/route.ts → standing "## Browser agent"
block every turn via browserAuthContextBlock). Consent BEFORE private-account reads;
consequential ops enforced SERVER-SIDE (client confirmConsequential never sufficient).
No open phase — all specs green; work is in working tree (uncommitted, develop branch).

[8.2 LOCKED COMPLETED TASKS (DO NOT RE-READ/RE-DO)]
- Universal agent core (LOCKED-DONE, 17/17 E2E on real Chrome — do not re-open):
  - `lib/browser/browserToolProtocol.ts`: VALID_ACTIONS = 13 (navigate, click,
    snapshot, fill, select, check, hover, press, keyboard_nav, fill_form, batch,
    resume_task, authorize_browser_access); extractBrowserApiFence: last valid fence,
    16 KB cap, target-field caps, keys ≤40, fields ≤32, batch steps ≤8, coordinates
    DROPPED, legacy names (scroll/back/reload/type/done_login/start/play_media/
    play_embed) → null.
  - `lib/browser/browserActions.ts`: runExtendedAction dispatcher = EXACTLY the 13
    cases. CONSEQUENTIAL_RE at ~L103 (conservative; `send\b` gates even "Send query"
    — pinned by unit test) + exported `isConsequentialName()`. doClick gate flow:
    skip-if-done (`click:<url>:<name>` sig) → block-with-park (requestConfirmation
    "consequential_action_consent", taskState waiting_for_confirmation) → grant →
    markNonIdempotentDone. probeChallenge parks after every action. Ladder:
    semantic_dom → expanded_dom → keyboard → visual_grounding → authorized_
    alternative → human_handoff. `text` doubles as target AND fill/press content.
  - `lib/browser/browserTargeting.ts` (role+name/label/text/selector/ref,
    frame-qualified `f1:eN`, stale-ref identity guard with role+name recovery),
    `domIndexer.ts` ([eN] refs + snapshotId, password values NEVER surfaced),
    `fallbackController.ts` (classifyFailure/nextStrategy), `keyboardFallback.ts`
    (allow-listed keys), `visualGrounding.ts` (ONE transient jpeg; RUKE_VISION_MOCK=1
    → conf 0.9 hit / "multiple plausible targets" refusal; screenshotsTaken stays 0),
    `highlightOverlay.ts` (`__ruke_ai_highlight__`, fixed, pointer-events:none,
    "AI Click/Fill/Focus", 25 ms fade + 25 ms remove = 50 ms cycle (was 1,100),
    removed BEFORE the real click — dom-basic asserts gone=yes),
    `securityChallengeDetector.ts` (captcha/mfa/403; cookie banner NOT a challenge),
    `taskState.ts` (disk `.data/browser-task.json`; states running|
    waiting_for_user_action|waiting_for_login|waiting_for_confirmation|completed|
    failed; single-use 10-min consequential grant), `authContext.ts`
    (browserAuthContextBlock(ctx: BrowserTurnContext = {}), one block/turn),
    `panelState.ts` (fence outcome feed for next turn), `intent.ts`
    (hasExplicitBrowserIntent).
  - `lib/browser/engineConfig.ts`: BrowserEngine = "brave"|"chrome"|"edge"|"firefox";
    BROWSER_ENGINES order [chrome,brave,edge,firefox]; DEFAULT_BROWSER_ENGINE="chrome";
    labels "{Name} Browser (User's Own Browser)". NO "internal" —
    parseEngineValue("internal") → undefined.
  - `lib/browser/engineLauncher.ts`: OS launch ONLY — executablePath required (throws
    EngineUnavailableError "No substitute browser will be launched."), env override
    RUKE_BROWSER_PATH_<ENGINE>, Windows candidates, profile
    `.data/browser-profiles/<engine>/`, headless:false forced, CDP loopback-only.
  - `lib/browser/telemetry.ts`: DISK-BACKED `.data/browser-telemetry.json` (dev
    per-route bundles don't share memory — same reason taskState is on disk);
    counters+ring ≤100/kind, env labels local_fixture/mock/real_browser, never
    URLs/page text/values.
  - API: `app/api/browser/route.ts` POST = extended semantic protocol only (200
    executed / 422 refused). GET `/api/browser/telemetry` (sanitized snapshot),
    `/api/browser/read` (Tier-3b login-wall read) kept. DELETED: legacy GET/DELETE
    action surface, `/api/browser/stream`, `/api/browser/last-frame` (all now 404),
    `components/RightBrowserPanel.tsx`.
  - Fence loop: ```browser_api fence → `components/render/BrowserApiBlock.tsx`
    (registered in `lib/render/registry.ts` + `components/render/FenceRouter.tsx`)
    POSTs verbatim, chips outcome → next-turn block reports it (act→see→act).
- Live-session hijack + truncated urls + --no-sandbox fix (LOCKED-DONE 2026-10-25
  bugfix cycle, verified — do not re-open):
  - `taskState.ts`: `TASK_TTL_MS = 2*60*60_000` enforced in BOTH loadTask branches
    (raw + cached; expired → current=null + rmSync taskFile) — expired tasks are
    invisible everywhere, their completedNonIdempotent sigs stop skipping real
    clicks; `sameFlowPage` (origin+pathname, trailing slashes trimmed, query/hash
    ignored); `taskFlowMismatch(t, liveUrl?, targetUrl?)` (absent evidence is NOT
    a mismatch — closed-browser parks survive); `isStaleTask` (TTL-expired OR
    waiting_for_* AND live tab contradicts task.url).
  - `authContext.ts`: BrowserTurnContext gains `targetUrl`; a waiting_for_* park
    that isStaleTask passes renders "— STALE: … Do NOT send resume_task for it"
    instead of the resume line; `MEDIA ("play this song/video")` guidance + "The
    user's message targets this EXACT url: … Copy it VERBATIM" lines.
  - `intent.ts`: `extractBrowserUrl(prompt)` — first http(s) match verbatim
    (trailing [.,;:!?] trimmed), else bare tokens that carry a path or start www
    (TLD allow-list) get https:// prefixed; prose domains → null.
  - `app/api/chat/route.ts` step 5b: on explicit intent,
    `taskFlowMismatch(currentTask(), live?.url, targetUrl)` → clearTask() BEFORE
    injectSystemBefore; block receives `targetUrl`.
  - `interactiveBrowser.ts`: `chromiumSandbox: true` in the interactive-session
    launch opts AND in readProfileLaunchArgs (Playwright's default false injects
    --no-sandbox → the infobar). Headless pool (agentBrowser, documents/browser)
    untouched — never visible.
  - Unit pins: `__tests__/browser-task-state.test.ts` staleness describe (fake
    timers: TTL-expired invisible + sigs dead, 1h TTL survival, sameFlowPage,
    taskFlowMismatch incl. about:blank-vs-fixture, isStaleTask);
    `browser-intent.test.ts` extractBrowserUrl describe; `browser-context-
    integration.test.ts` stale-park-suppressed / current-park-kept / verbatim-url
    tests; `browser-engine-launcher.test.ts` source contract (exactly 2
    `chromiumSandbox: true`, no `--no-sandbox` in code, comments stripped).
- Browser speed upgrade + browser-operator skill (LOCKED-DONE 2026-10-25, verified
  last cycle — do not re-open):
  - `components/render/BrowserApiBlock.tsx`: fence dedupe is a `Map<string,number>`
    with `FIRE_COOLDOWN_MS = 1500` — the same fence text in a LATER turn re-fires.
  - Cross-bundle state: `panelState.ts` lastOutcome lives on
    `globalThis.__ruke_last_browser_outcome__` (still client-safe, NO `fs` import —
    BrowserApiBlock loads it); `domIndexer.ts` store/nextId/latestId on
    `globalThis.__ruke_dom_snapshot_store__`; `executeBrowserAction` also records
    the outcome SERVER-side when `!nested` (recordBrowserApiOutcome) — the loop
    closes even if the chip reloads.
  - `highlightOverlay.ts`: FADE_MS 25 + REMOVE_WAIT 25 → 50 ms insert→remove
    cycle (was ~1,100; ~22× faster), DOM invariants byte-identical.
  - `browserTargeting.ts`: `refIdentitySuspect()` — semantic_dom step 1 does NOT
    trust a ref whose `snapshotId < currentSnapshot()` or whose live accessible
    name mismatches `spec.role`+`spec.name` → falls through to expanded_dom
    recovery (`recovered: true`).
  - `browserActions.ts`: `STATE_CHANGING_ACTIONS` (click/fill/select/check/press/
    keyboard_nav/fill_form/batch) AUTO-RE-INDEX on success when `!nested` —
    result gains `snapshotId` + `snapshotText`; telemetry `snapshotsTaken` NOT
    bumped (fallback spec #17 pins this). `submitControlWording()` probes
    `button, input[type="submit"], [role="button"]` labels (pageText ONLY as
    fallback when no such controls exist). `doFillForm` combobox ladder: native
    `<select>` → selectOption; text-entry/CE → fill; else open popup + click
    matching `[role="option"]`/text item; honest per-field error otherwise.
  - Tier-2 skill `.cskills/browser-operator/SKILL.md` +
    `.cskills-scenarios/browser-operator.json` (sourceRepo "composite",
    autoUse true, whenToUse/triggerKeywords set) — fill_form ≤32 fields, batch
    ≤8 steps, always ref+role+name. The GO FAST rules are ALSO mirrored inline
    in `authContext.ts` BROWSER_CONTROL because the standing block (chat route
    5b) is the real per-turn channel; MODE_SKILL unchanged (no browser
    RendererMode; the python decision-engine is absent on this machine).
- OS-only pivot surfaces (LOCKED-DONE, 4/4 E2E — do not re-open):
  - `app/api/settings/route.ts` (PUT browser_engine ∈ chrome|brave|edge|firefox,
    400 "browser_engine must be chrome, brave, edge, or firefox"; closes session on
    change), `lib/server/settings.ts` (stale "internal" → chrome fallback),
    `lib/settings/client.ts`, `components/SettingsMenu.tsx` (four options, testids
    settings-browser-engine / browser-engine-status / settings-tab-browser; static
    hint: "Your own browser opens visibly in its own window and the AI drives that
    real window. There is no built-in WebUI browser and no live mirror.").
  - Fixtures `public/fixtures/browser-fallback/*.html` env-gated by
    `isFixtureAllowed` (lib/web-search/ssrf.ts): RUKE_TEST_FIXTURES=1 +
    localhost:3000 + /fixtures/browser-fallback/<name>.html only.
    dom-poor.html search button is "Run query" (NOT "Send" — deliberately-gated verb).
- Unit tests green (721): browser-{api-fence,challenge,context-integration,
  dom-index-summary,engine-config,engine-launcher,fallback-ladder,intent,task-state,
  telemetry,consequential(new — pins gate vocabulary BOTH directions)}.
- Specs: `tests/browser-fallback.spec.ts` (17: pre-flight, semantic/weak DOM, iframe,
  shadow open/closed, canvas visual + ambiguous refusal, stale-ref, keyboard, CAPTCHA
  park/resume, consequential consent→MFA→no-resubmit, 403, cookie banner, broken
  control, exhausted handoff, popup adoption, telemetry), `tests/browser-engine-panel.spec.ts`
  (4: four-engine dropdown, 400 rejects incl. "internal", zero panel/mirror DOM incl.
  dead `browser-panel:open` event, 404 mirror endpoints). beforeAll rmSync's
  `.data/browser-task.json` + `.data/browser-telemetry.json`.
- Earlier-cycle locks (compaction engine, recents parity, token meter, progress chip)
  stay valid — see git history + older docs entries; contracts preserved in 8.4.

[8.3 ACTIVE GRAPHIFY DEPENDENCY MAP]
- Model text → ```browser_api fence → render/registry+FenceRouter → BrowserApiBlock.tsx
  → POST /api/browser → browserActions.runExtendedAction → {browserTargeting,
  domIndexer, fallbackController, keyboardFallback, visualGrounding, highlightOverlay,
  securityChallengeDetector} over interactiveBrowser page handle (engineLauncher
  resolves the exe; interactiveBrowser launches it — chrome validated — BOTH visible
  launches now chromiumSandbox:true) → {taskState disk, telemetry disk,
  panelState memory}.
- Outcome → panelState → authContext.browserAuthContextBlock ← app/api/chat/route.ts
  (liveTabInfo + currentEngineForSession + intent.hasExplicitBrowserIntent +
  intent.extractBrowserUrl → targetUrl + currentTask/taskFlowMismatch → clearTask
  supersede before inject; exactly ONE "## Browser agent" block/turn —
  chatEngine.test contract).
- authContext staleness reads taskState.isStaleTask(task, ctx.liveUrl); the
  block's task line branches STALE vs resume directive on it.
- GET /api/browser/telemetry reads the SAME disk file the action route writes.
- lib/web-search/pipeline.ts (7 tiers, UNTOUCHED logic; only a directive comment
  reworded) → extractor.ts Tier 3b → interactiveBrowser.readWithInteractiveProfile.
- SettingsMenu → PUT /api/settings → lib/server/settings.ts → engineConfig →
  chat-route block "Engine:" line + engineLauncher.

[8.4 IMMUTABLE CODE CONTRACTS & SCHEMAS]
- Engine: `BrowserEngine = "brave"|"chrome"|"edge"|"firefox"`; DEFAULT chrome;
  settings.json `browser_engine` validated server-side (400 on anything else incl.
  legacy "internal"); profile `.data/browser-profiles/<engine>/` (automation
  profile — never the user's normal Chrome profile; wipe = delete the dir).
- POST /api/browser body = semantic action JSON (same schema as the fence);
  200 ok:true executed | 422 ok:false + {error, strategies?, challenge?, needs_consent?,
  consentReason?, taskState?, guidance?, skipped?, recovered?, snapshotId,
  snapshotText, url, title}. GET/DELETE on /api/browser and the stream/last-frame
  routes DO NOT EXIST (404).
- Consequential gate: CONSEQUENTIAL_RE (pay|payment|purchase|buy now|checkout|
  place order|send|post|publish|delete|remove|transfer|submit application|apply now|
  sign contract/agreement|accept terms) — `isConsequentialName()` exported; grant
  via authorize_browser_access (single-use, 10 min); skip-if-done sig
  `click:<url>:<name>`; task persisted `.data/browser-task.json`.
- Telemetry: `.data/browser-telemetry.json` = {counters{actions,screenshotsTaken,
  snapshotsTaken,humanHandoffs,challengesSeen,fallbacksUsed,consequentialBlocked,
  consequentialGranted,byStrategy}, kinds{kind:Sample[]≤100}}; snapshot via
  GET /api/browser/telemetry = {ok, telemetry{kind stats w/ envs, counters, when}}.
- Env gates: RUKE_TEST_FIXTURES=1 (fixture allow-list), RUKE_VISION_MOCK=1
  (deterministic grounding), RUKE_BROWSER_PATH_<ENGINE> (launcher override).
- Fence protocol: one JSON action per ```browser_api fence; caps per 8.2; `text`
  alias for target AND fill/press content; NO coordinates, NO legacy verbs.
- Speed contracts (pinned): client fence cooldown 1500 ms;
  cross-bundle globalThis keys `__ruke_last_browser_outcome__` +
  `__ruke_dom_snapshot_store__`; every successful state-changing action
  auto-re-indexes and the ActionResult optionally carries `snapshotId`+
  `snapshotText` — but `snapshotsTaken` counts ONLY explicit snapshot actions;
  semantic_dom refuses stale/suspect refs via `refIdentitySuspect` so
  expanded_dom role+name recovery fires (`recovered:true`); consequential
  "submit" probe reads submit-CONTROL wording first; fill_form/select handle
  native AND custom comboboxes.
- Staleness & launch contracts (bugfix cycle, pinned): `TASK_TTL_MS`=2h is the
  ONLY task expiry (loadTask enforces; expired = file rm'd); `isStaleTask`
  suppresses ONLY the resume directive and ONLY when a waiting_for_* park
  contradicts the live tab (or age > TTL); `taskFlowMismatch` NEVER fires on
  absent evidence (closed-browser parks survive); chat 5b injects `targetUrl`
  (verbatim) whenever extractBrowserUrl finds a url; both VISIBLE launches set
  `chromiumSandbox: true` — the automation window must never carry
  --no-sandbox / Chrome's infobar.
- Still-valid pre-browser contracts (unchanged): SSE ruke_stage/ruke_error envelope;
  compact purpose:"compact" passthrough + COMPACTION_ANCHOR_PROMPT; compact_thresholds
  settings; token-meter /api/model-stats; ConversationMeta group/unread; recents/
  progress testids; lock file `.ai-coordination/playwright.lock`; real test command
  `npx playwright test <spec>` (ONE FILE PER foreground call under a single lock;
  capture ${PIPESTATUS[0]}).

[8.5 PLAYWRIGHT & E2E VERIFICATION STATE]
- Dev server :3000 — boot pattern `nohup env RUKE_TEST_FIXTURES=1 RUKE_VISION_MOCK=1
  npm run dev > .ai-coordination/dev8.log 2>&1 & echo $! > .ai-coordination/dev.pid`
  (current pidfile 942, RUNNING — the user's plain-`npm run dev` restart, old pid
  19892, was killed and re-homed WITH the fixture env). RESTART before each TEST
  phase (hot reload can reset in-memory modules; disk stores keep telemetry,
  globalThis stores repopulate on demand). If navigate answers "refused unsafe or
  non-http(s) URL" on a fixture url → the server lacks RUKE_TEST_FIXTURES (the
  isFixtureAllowed gate), that is NOT a code defect.
- VERIFIED 2026-10-25 bugfix cycle (real Chrome, visible, SANDBOXED — the live
  automation Chrome process cmdline was probed clean of --no-sandbox; a direct
  navigate probe returned ok:true before the suites): `npx playwright test
  tests/browser-fallback.spec.ts` 17/17 (4.5 s) PW_EXIT:0 (first attempt was
  17/17 RED — infra only: server without the fixture env); `npx playwright test
  tests/browser-engine-panel.spec.ts` 4/4 (49.2 s) PW_EXIT:0; one spec per
  foreground call under the bash lock (trap EXIT releases). vitest 66 files /
  721 passed / 1 skipped VITEST_EXIT:0; tsc EXIT:0. Post-run hygiene: rm
  .data/browser-task.json (the exhausted.html park is a fixture artifact — the
  new TTL/STALE logic neutralizes it anyway) + taskkill automation chrome.
  Settings left at engine=chrome (specs restore it in afterAll).
- First-run failures since fixed & re-verified: (1) weak-DOM "Send query" hit the
  conservative send\b gate → fixture renamed "Run query" + heuristic pinned by unit
  test; (2) telemetry counters 0 in separate route bundle → disk-backed telemetry;
  (3) getByRole("button",{name:"Settings"}) substring-matched the disabled "Voice
  settings" button → `getByTestId("topbar").getByRole(..., {exact:true})` in spec.
- Fixture env labels stay `local_fixture`; screenshotsTaken=0 across all mock runs.

[8.6 OPEN BUGS, FAILING STACK TRACES & BLOCKERS]
- None open. (Resolved in the bugfix cycle: stale fixture park hijacking live
  chat turns → TTL + STALE directive suppression + route supersede; youtu.be
  re-typed to `youtu.be` → verbatim targetUrl injection; Chrome --no-sandbox
  infobar → chromiumSandbox:true; fallback 17/17 RED → server env, not code.
  Prior cycle: consequential-gate false positive; disk-backed telemetry;
  Settings/Voice-settings locator substring — exact:true.)
- Known limitations (honest, not bugs): brave/edge/firefox launchers configured but
  NOT live-validated (chrome is the user-validated engine per pivot); real vision
  grounding not exercised (RUKE_VISION_MOCK keeps fixtures deterministic); the
  .decision-engine python worker is absent on this machine so the "## Browser agent"
  block is injected directly by the chat route rather than via a RendererMode
  skill_to_load; live public-web journeys not automated (fixtures only).

[8.7 ACTIVE SKILLS & SCENARIO LOCKS]
- None loaded this session (Playwright via npx + project config; lock protocol by
  bash trap; vitest direct). Tier 2 (.cskills): `browser-operator` ADDED this
  cycle (scenario autoUse:true) — model-facing guidance reaches the model via the
  standing authContext block today; skill_to_load wiring awaits the decision
  engine. Never browser-listable/installable (installer rejects ./.cskills/).

[8.8 IMMEDIATE NEXT 3 ATOMIC ACTIONS]
1. Suggest the user re-run the live journey "open my browser and play this song
  <youtu.be url>" in the WebUI — the fixes target exactly that journey; unit
  coverage pins every decision, but the end-to-end model behavior is not
  automated. If they ask us to verify it, run a fresh TEST phase under the lock.
2. NOTHING ELSE REQUIRED — bugfix cycle complete, all suites green. Optional
  only if the user asks: commit the working tree (this cycle + speed upgrade +
  browser-operator + the prior feature/pivot; several files carry pre-existing
  uncommitted edits — stage selectively; end commit msg with
  "Co-Authored-By: Claude Code <noreply@anthropic.com>").
3. Optional: wire the decision-engine worker → browser RendererMode → skill_to_load
  for .cskills/browser-operator when the python backend returns (the inline GO
  FAST block in authContext.ts is the stand-in). Dev server left running at :3000,
  pidfile .ai-coordination/dev.pid = 942 (log dev8.log) — kill that pid to stop it;
  note it was re-homed WITH RUKE_TEST_FIXTURES=1 + RUKE_VISION_MOCK=1.

---

## Session 2026-10-25-B — Browser agent loop (act→see→act auto-continuation)

### 8.1 Objective & milestone
Fix: browser-agent chat stopped silently after the first executed fence. Implemented
client-side bounded agent loop in hooks/useChat.ts. CODE phase complete: tsc exit 0,
vitest 721 passed / 1 skipped / 0 failed. NOT yet verified live (TEST phase pending —
:3000 dev server owned by user's own restart; fixture env state unknown).

### 8.2 Locked completed
- hooks/useChat.ts agent loop (final consolidated version, compiles + suite green):
  BROWSER_CONTINUE_MSG module const; MAX_BROWSER_AGENT_STEPS=10; BROWSER_OUTCOME_WAIT_MS=90s;
  browserLoopRef{round,consumedWhen}; turnGenRef (user-send/Stop supersedes scheduled rounds);
  noteUserSend (fresh-browser-ask regex resets budget, cancels timer);
  runBrowserRound(round,gen): waits for lastBrowserApiOutcome().when > consumedWhen, then
  materializeLlmHistory + visible user(BROWSER_CONTINUE_MSG)+assistant bubbles (step label via
  existing Message.fenceRepair field — renders through ChatMessage fence-repair note), pinned
  decision_mode, rAF flush untouched, deferred llmPendingRef rebuild (base=llmHistoryRef,
  uiLen=uiLenBeforeRound), llm chains naturally because the continue line IS a real UI bubble;
  maybeContinueBrowserLoop(content,isRealUserTurn): acted = any VALID complete browser_api fence
  (extractBrowserApiFence probe); no-fence turn ENDS loop; step-limit bubble at cap; 900ms timer.
  Wiring: send() noteUserSend + post-repair maybeContinue(true); runBrowserRound tail
  maybeContinue(false); stop()/clear()/edit() clearBrowserLoop().
- components/render/BrowserApiBlock.tsx: repeat-navigate guard (identical fence source previously
  fired + freshest outcome is ok navigate same url → skip POST; prevents refill wipe);
  navigate label "Opened <host+path> in the browser (new tab)".
- Root cause (locked): the loop closed because only the NEXT chat turn's server block (route.ts
  step 5b) informs the model of outcomes, and nothing auto-sent that turn.

### 8.5 Verification state
No Playwright run this session. :3000 = user-restarted server (pidfile stale). New client code
is live on next page load (Next dev compile). Next: user re-runs the selenium web-form journey
with Strata-Gated, OR TEST phase: relaunch dev w/ RUKE_TEST_FIXTURES=1 RUKE_VISION_MOCK=1 under
documented pattern + run browser-fallback.spec.ts (17) / browser-engine-panel.spec.ts (4) one per
foreground call under .ai-coordination lock.

### 8.8 Next 3
1. User re-runs live journey (or approve TEST phase relaunch under fixtures).
2. ANALYZE live/Playwright evidence; watch for: model re-emitting navigate after guard skips chip
   (should be gone), step-note text, 90s outcome waits on slow pages.
3. If loop misbehaves: tune BROWSER_CONTINUE_MSG wording and MAX steps; never touch fenceRepair
   machinery.

---

## Session 2026-10-26-A — Rust migration Part 1 (workspace/core foundation)

### 8.1 Objective & milestone
Rule-governed migration of the TS backend to Rust (contract = `rust-backend/MIGRATION-MAP.md`,
frozen §1–§9). Part 1 COMPLETE: Rust workspace scaffold + config/settings + tracing +
CancellationToken core. No TS file touched; TS remains authoritative; no cutover, no proxies,
no Playwright (Parts 1–2 constraint).

### 8.2 Locked completed (do not re-read/re-do)
- `rust-backend/Cargo.toml` workspace (edition 2021, resolver 2, tokio 1.54/axum 0.8.9/serde_json
  1.0.154 preserve_order, [profile.release] lto/strip). Members under `rust-backend/crates/`.
- `crates/ruke-contracts/src/{decision,stages,settings}.rs` — SHARED_CONTRACT types frozen to
  MIGRATION-MAP §2; golden serialization tests pin field order/null-vs-omitted/MODE_SKILL/MODE_FENCE.
- `crates/ruke-core/src/{config,settings,slot,turn}.rs` — RUKE_PROJECT_ROOT repo-root resolution
  (Rule 13); SettingsStore parity of lib/server/settings.ts (mtime cache, corrupted-retry,
  merge-order, 2-space+\n atomic tmp+rename); InferenceSlot parity of lib/server/inference-busy.ts
  (title aborts on begin, saturating end, RAII UserTurnGuard/TitleCallGuard = Rule 6 exactly-once,
  wait_for_user_idle); TurnCounter/TurnContext tokio-util CancellationToken hierarchy + turn_id span.
- `crates/ruke-server/src/main.rs` — scaffold bin ONLY: tracing (RUKE_LOG/RUST_LOG, no secrets),
  AppState{settings,slot,turns}, GET /api/ruke/health on 127.0.0.1:3101 (RUKE_BACKEND_PORT),
  graceful ctrl_c. Test proves POST /api/chat|settings|search|conversations ⇒ 404 (no cut-over).
- VERIFY: `cargo test` = 28 passed (7 contracts + 19 core + 2 server); `cargo clippy --all-targets`
  0 warnings; `cargo build --release` OK (15.7s); live smoke: health JSON ok, :3101, killed clean.
- ENV FIX: machine had NO C linker (rustc msvc, no VS/SDK/mingw; Git Bash coreutils link.exe
  shadowed → "link: extra operand"). Fixed via winget Microsoft.VisualStudio.2022.BuildTools
  + VCTools workload (VC 14.44.35207, Win SDK 10.0.26100). rustc auto-discovers; no config needed.
  Standalone rust 1.99 at `C:/Program Files/Rust stable MSVC 1.99` — NO rustup on this machine.
- MIGRATION-MAP.md §10 now carries the Part status tracker (Part 1 DONE row).

### 8.3 Graphify map (Rust side)
ruke-server→ruke-core→ruke-contracts. Callers of TS contracts frozen in map §2. No Rust symbol
is referenced by any TS file (and vice versa) — fully additive tree.

### 8.4 Immutable contracts added this session
Env vars: RUKE_PROJECT_ROOT (explicit repo root), RUKE_BACKEND_PORT (default 3101), RUKE_LOG.
Rust pub APIs in 8.2 are the Part 2+ foundation (SettingsStore::update_settings(&Map),
InferenceSlot::begin_guard(), TurnCounter::turn()). KNOWN PARITY: serde_json emits `1.0` where
JS emits `1` (DecisionEnvelope.confidence) — handle in Part 2 golden normalization or Part 4.

### 8.5 E2E/verification state
No Playwright. :3000 Next dev untouched; :8080 Strata untouched. ruke-server smoke ran on 3101
and was stopped. No lock at .ai-coordination/.

### 8.6 Open items
- Part 2 not started: golden-fixture harness (19 §6 cases, mock upstream ~ reuse
  scripts/e2e-llm-proxy.mjs idea → rust-backend/fixtures/).
- Untracked: whole `rust-backend/` (user has not asked to commit).

### 8.7 Skills/locks
No Tier-1/Tier-2 skill bodies loaded. No scenario locks.

### 8.8 Next 3
1. Part 2a: mock-upstream harness + record TS baselines for §6 golden cases into
   `rust-backend/fixtures/` (TS remains authoritative; capture via :3000 with RUKE_TEST_FIXTURES).
2. Part 2b: Rust fixture-runner test that replays those goldens against ruke-server contract code.
3. Normalize `confidence` number formatting decision informed by recorded goldens.

---

## Session 2026-10-26-B — Rust migration Part 2 (golden-contract fixtures)

### 8.1 Objective & milestone
PART 2 of the Rust migration (contract = `rust-backend/MIGRATION-MAP.md`, frozen).
Mission: record the DETERMINISTIC TypeScript wire-contract baseline under
`rust-backend/fixtures/` covering ALL 19 frozen §6 scenarios — WITHOUT porting any
feature. COMPLETE 2026-10-26: 44 fixtures + 7 vitest suites (41 tests) under
`__tests__/rust-golden/`, driven in-process against a scripted mock upstream (no
live Strata, no dev server, no Playwright). TS remains authoritative; no cutover,
no proxies, no Rust feature work. Part 3 (decision + skills port) is next.

### 8.2 Locked completed (do not re-read/re-do)
- Harness `__tests__/rust-golden/support/golden.ts`: setGoldenEnv (LOG_LEVEL silent;
  WEB_SEARCH_GATE_DISABLED toggled per suite), scripted mock upstream (upstreamCalls
  ledger; llmApiUrl/llmApiKey mocked to unroutable 127.0.0.1:9 — fetch never
  attempted), parseLogical (LOGICAL SSE frames = the contract, not TCP chunks),
  normalizeBodyMs/normalizeMs (stage `ms` → "<ms>"), headerMap, skill-block ANCHORS
  (sha256 + byte length + source-file hashes replace `<active_skill>`/`<decision_skill>`
  bodies), and `writeJsonFixture` DRIFT GUARD (first-diff line on replay; stale
  fixture = DELETE + re-record, never hand-edit).
- 7 suites → 44 fixtures (scenario map in `rust-backend/fixtures/README.md`):
  chat-core 11 (streaming, legacy, malformed, empty×3, compaction, decision_mode×2,
  abort, search-disabled), errors 8 (4xx/5xx both paths, unreachable both paths,
  empty-body), sse 3 (frame-split, UTF-8 matrix, `<think>` split-at-every-byte
  matrix incl. unterminated — 02/03 APPROVED-DEVIATION recording expectedRust values),
  skills 5 (slash user skill both paths, unknown-slash passthrough, core-tier via
  decision, excel decision_mode passthrough), decision-serialization 5+1 (envelope
  bytes + field ledger), attachments 6 (retrieval success, honest-block empty/missing
  index, video keyframe paths ×2, legacy parity), web 5 (success progress w/ stages+
  evidence+web_meta stage frame; success legacy X-Web-Citations/X-Search-Gate headers;
  starved sentinel; internals-throw non-fatal; image-attachment intent gate w/
  upstreamCalls.length===1 proving no vision hop).
- Web mock boundary: cache/net/engines mocked (I/O seams; impit never loads; real
  isSafeUrl + deduplicateQueries kept); gate, planner, metasearch, extractor, BM25
  reranker, coverage logic REAL → evidence-block bytes derive only from scripted
  SERP + pages.
- Handler-load pattern (all 7 suites, tsc-safe): `setGoldenEnv()` at module top, then
  `let POST: (req: NextRequest) => Promise<Response>; beforeAll(async () => { POST =
  (await import("@/app/api/chat/route")).POST; });` — avoids TS1378 (top-level await
  vs target es2015) and TS2694 (`import(...).POST` type access vs Next `.next/types`
  route files); route import happens AFTER env is set; web-search flag reads verified
  call-time (search-gate.ts gateDisabledByEnv) so ordering is safe.
- VERIFY (real exits): `npx vitest run __tests__/rust-golden` run TWICE — record then
  replay parity: Test Files 7 passed (7) / Tests 41 passed (41), exit 0. Full corpus
  `npx vitest run`: Test Files 1 failed | 60 passed (61); Tests 2 failed | 657 passed |
  1 skipped (660) — both failures in `__tests__/skills/chatEngine.test.ts`, PROVEN
  PRE-EXISTING (fails standalone; tracked file, unmodified; user's in-progress
  internal-browser work). `npx tsc --noEmit` TSC_EXIT:0. `cargo check` 0;
  `cargo test` 28 passed exit 0; `cargo clippy --all-targets -- -D warnings` exit 0.
- Docs: `rust-backend/fixtures/README.md` CREATED (layout, comparison classes,
  determinism/normalization, env preconditions, web mock boundary, 10 pinned
  discoveries, gaps, regeneration commands). MIGRATION-MAP §10 tracker ONLY updated
  (Part 2 DONE 2026-10-26 row; `| 3–10 | PENDING | |`).
- git tree proof of no-production-change: `M tsconfig.tsbuildinfo` (build cache) +
  untracked `__tests__/rust-golden/`, `rust-backend/fixtures/` — zero TS source files
  modified, §8 prohibitions intact.

### 8.3 Graphify map (fixture consumers)
- chat/ + sse/ goldens → future Rust chat-streaming port; errors/ → Rust error
  contract; decision/ + serialization/ + skills/ → Part 3 decision+skills port;
  attachments/ → attachment-retrieval port; web-search/ → web pipeline port. Each
  Rust part replays via `writeJsonFixture`-compatible fixture-runner (Part 2b idea
  from session A now folded into each part's acceptance test).
- Suites import `@/app/api/chat/route` + `@/app/api/decision/route` directly and the
  real lib modules (attachment search, web-search pipeline) — fixtures are ONLY
  produced by these harnesses; nothing in the Rust workspace reads fixtures yet
  (additive tree intact).

### 8.4 Immutable contracts added this session (fixtures pin these bytes)
- SSE grammar: `data: <json>\n\n`; stage frames `{"ruke_stage":<StageEvent>}`; error
  frame `{"ruke_error":{"message"}}` + `data: [DONE]`; the route NEVER appends
  [DONE] after raw upstream bytes. Legacy path = metadata headers + byte-exact body;
  progress path = early-open SSE + stage frames (ms-normalized).
- Error contract: legacy 4xx/5xx → upstream status PRESERVED +
  `{"error":"Upstream returned <N>: <first 200 chars>"}`; empty body legacy → 502
  `No response body from model`; unreachable legacy → 503 `Could not reach the model
  server at 127.0.0.1:9.`; progress path → HTTP 200 + one ruke_error + [DONE].
- Decision envelope: 11-key insertion order (active_mode, confidence, decided_by,
  stripped_prompt, skill_to_load, allowed_code_fence, disable_validators,
  enable_validator, task_constraints, extracted_entities, lfm_latency_ms);
  `lfm_input`/`lfm_raw` OMITTED (absent, not null); `confidence` serializes integer
  `1` — serde_json f64 `1.0` is BYTE-INEQUAL; Rust serializer must emit `1` or carry
  an explicit approved deviation (Part 4 decision); skill_to_load/allowed_code_fence
  nulls serialize as JSON null (present).
- Web evidence block (pipeline.ts): empty bundle → exact sentinel `"No web evidence
  could be retrieved. Proceed with your knowledge only."`; non-empty → block =
  `ANTI_REFUSAL_DIRECTIVE + "\n\n" + <evidence>…</evidence>` guideline header, THEN
  `\n[S#] title (published YYYY-MM-DD)\n    url` + ≤5 `    "…"  (BM25=x.xx)` excerpt
  lines AFTER the closing tag — block NEVER starts with `<evidence>` and
  `</evidence>` precedes `[S1]`.
- `web_meta` = STAGE frame (`stage:"web_meta"` with webCitations map + searchGate)
  emitted AFTER `web:done`; legacy path surfaces it ONLY via encodeURIComponent(JSON)
  headers `X-Web-Citations`/`X-Search-Gate`, and only when citations non-empty.
- Two web-failure shapes (both non-fatal): starved engines → non-null empty bundle →
  sentinel block, NO web_meta/citation headers; internals THROW → route catch
  swallows, NO block at all.
- Skills: user-tier slash → `X-Used-Skill` header + detail block (progress) /
  header-only (legacy); core-tier → `<decision_skill>` injection, NO header/detail.
- RECORDED BUGS (NOT fixed, §8): injection off-by-one family — web-evidence,
  attachment-retrieval and no-skill-block evidence land at `lastUserIdx + 1` (system
  AFTER user; `web-search/01` pins roles `["user","system"]`); attachments carry the
  same off-by-one (`attachments/01,04,06`; `05` shows skill-shifted path is correct).
  `<think>` scrubber is boundary-dependent-buggy — fixtures sse/02 matrix records TS
  mangling + expectedRust incremental-state-machine vectors (approved-deviation).
  `runVisionEntityPrepass` DEAD (zero call sites); `KNOWN_SITE_TOKEN_RE`/
  `DOMAIN_TLD_TOKEN_RE` dead; `metasearch()` leaves an uncleared 15 s hard-cap
  setTimeout per call; `fallbackEnvelope` (in-process-fallback) unreachable via
  public /api/decision (route guard) — internal-only, Rust keeps it internal; gate
  hard-bypass never calls the main model (gateMs 0, decidedBy "deterministic").
- Fixture discipline: comparison classes byte-exact / structural / semantic /
  approved-deviation; logical frames (not TCP boundaries) are the contract EXCEPT the
  think/utf8 matrices; regeneration = `npx vitest run __tests__/rust-golden` (replay,
  first-diff on drift) or `rm -rf rust-backend/fixtures/<dir> && npx vitest run
  __tests__/rust-golden/<suite>` (re-record).
- All pre-browser + Part-1 contracts in the sections above remain in force verbatim.

### 8.5 E2E/verification state
- NO Playwright this session (forbidden by the Part 2 brief); no
  `.ai-coordination/playwright.lock`. :3000 dev server and :8080 Strata never
  touched — fixtures run in-process, mock upstream only (Rule: never consume the
  shared Strata slot).
- vitest golden dir replay-green (two consecutive runs, identical output); fixture
  corpus deterministic on any machine without Strata/sqlite/browser.
- cargo suite unchanged from Part 1 (28 tests) and still green.

### 8.6 Open bugs & gaps (recorded, not skipped)
- PRE-EXISTING repo failure (NOT Part 2, not ours to fix unasked):
  `__tests__/skills/chatEngine.test.ts` 2/7 red standalone ("standard_chat injects
  nothing…" and "engine down -> standard_chat fallback…" both expect a
  `## Browser agent` system block, receive 0) — belongs to the user's in-progress
  internal-browser work.
- Fixture gaps: `whole_video` note path + exhaustive-retrieval mode unexercised;
  sourceClass/extractEntities pinned only indirectly; extractor Tier-3b neutralized
  by the net mock (no browser in Part 2).
- `metasearch()` 15 s uncleared timer delays vitest worker exit (harmless; the Rust
  port must still honour the 15 s cap semantics).
- Part 4 serializer decision OPEN: emit `confidence: 1` byte-exact vs recorded
  deviation (README discovery 1).

### 8.7 Active skills & scenario locks
- No Tier-1/Tier-2 skill bodies loaded this session. No Playwright lock. Tier-2
  `.cskills/browser-operator` (prior session) remains installed, untouched.

### 8.8 Immediate next 3 atomic actions
1. PART 3 (per MIGRATION-MAP): port the decision engine + core-skill loading to Rust
   against `rust-backend/fixtures/decision/` + `serialization/01` + `skills/` goldens;
   Rust fixture-runner test replays them byte-exact (11-key order, `1` integer,
   omitted lfm fields, skill anchors reproduced from the same files).
2. Then Part 4: chat SSE streaming port against `chat/` + `sse/` + `errors/` goldens;
   sse/02/03 conform to the recorded `expectedRust*` vectors, never to the mangled TS
   bytes.
3. Only if the user asks: commit the working tree (untracked `__tests__/rust-golden/`
   + `rust-backend/fixtures/` + modified MIGRATION-MAP/STATE; end commit msg with
   "Co-Authored-By: Claude Code <noreply@anthropic.com>").

---

## Session 2026-10-26-C — browser-subsystem debris cleanup (after user's removal)

### 8.1 Objective & milestone
The user removed the interactive/internal browser implementation entirely (pending
architecture change). This session: purge every remaining debris point and clear the
last failing tests. DONE — the full vitest corpus is green end-to-end for the first
time (61/61 files).

### 8.2 Completed (verified — do not re-open)
- `__tests__/skills/chatEngine.test.ts`: the two surviving `## Browser agent`
  expectations flipped to `toHaveLength(0)` (regression PIN so the deleted subsystem
  cannot silently return), comments de-browsered; 7/7 standalone green.
- `lib/web-search/ssrf.ts`: deleted the DEAD `isFixtureAllowed` export +
  `FIXTURE_PREFIX` (zero call sites repo-wide); `isSafeUrl` untouched — web-pipeline
  SSRF guard intact and golden web fixtures replay byte-identical.
- Deleted: `public/fixtures/browser-fallback/` (17 tracked fixture HTML — git now
  carries 17 `D` entries), `.data/browser-profile` (stale automation profile dir),
  `settings.json` stale `browser_engine` key (file is git-ignored; now carries only
  compact_thresholds).
- Verified already gone via the user's own cleanup: `lib/browser/**`,
  `app/api/browser/**`, BrowserApiBlock + registry/FenceRouter entries, settings
  browser_engine plumbing, `tests/browser-*.spec.ts`, browser unit tests,
  `.cskills`/`.cskills-scenarios` browser-operator.
- KEPT deliberately: `lib/web-search/agentBrowser.ts` + `lib/documents/browser.ts`
  (web-search/documents headless pools — NOT the agent browser);
  `reverse-engineering/internal-browser/**` (user's design references for the
  replacement); docs/CHANGELOG history; graphify-out caches.

### 8.4 Contract deltas
- The chat route's system-block injections are now ONLY skill/evidence/attachment/
  reasoning blocks — a standing browser block NEVER exists; the chatEngine
  zero-length assertions are the pins.
- `ssrf.ts` exports ONLY `isSafeUrl`; the `RUKE_TEST_FIXTURES` fixture allow-list is
  gone from the codebase.

### 8.5 Verification (real exits)
`npx vitest run __tests__/skills/chatEngine.test.ts` 7/7 exit 0;
`npx vitest run __tests__/rust-golden` 41/41 exit 0 (×4 consecutive);
`npx vitest run` (full) Test Files 61 passed (61), Tests 659 passed / 1 skipped,
VITEST_EXIT:0; `npx tsc --noEmit` TSC_EXIT:0. No Playwright; no lock.
CAVEAT (honest): the FIRST golden run after these edits reported 1 file / 3 tests
red; the details were lost to ANSI-filtered grep and NEVER reproduced across the
4 following golden runs + the full corpus. Classified transient flake — if it
reappears, capture the FULL unfiltered log first time.

### 8.8 Next 3
1. Unchanged Part-3 handoff (see Session B 8.8) — the golden corpus is the contract.
2. If the flake reappears: `npx vitest run __tests__/rust-golden 2>&1 | tee .ai-coordination/golden-flake.log` and read the log.
3. Only if the user asks: commit (now also includes the 17 fixture deletions + ssrf
   export removal + chatEngine test update; trailer "Co-Authored-By: Claude Code <noreply@anthropic.com>").
