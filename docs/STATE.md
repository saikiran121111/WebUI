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

---

## Session 2026-10-26-D — Rust migration Part 3 (decision engine + core skill loading)

### 8.1 Objective & milestone
PART 3 of the Rust migration (contract = `rust-backend/MIGRATION-MAP.md`, frozen). Mission:
Rust reproduces the TypeScript oracle BYTE-FOR-BYTE — same DecisionEnvelope wire bytes and
same `<decision_skill>` injection block — given identical inputs and skill files. A parity
port, NOT a redesign. COMPLETE 2026-10-26: crates `ruke-decision` + `ruke-skills` live,
golden replay 9/9, §20 check matrix all green. NO cutover: `app/api/chat/route.ts` and every
TS decision/skill module untouched; Rust routes remain DISCONNECTED from live traffic.
Part 4 (chat core SSE) is next.

### 8.2 Locked completed (do not re-read/re-do)
- `crates/ruke-decision/src/engine.rs` — port of `lib/decision/client.ts`: INTENT_MATCHERS +
  INTENT_ORDER first-match precedence [excel, docs, pdf, ppt, chart, 3d_asset, cad_blueprint,
  html_render], `get_decision_sync`, `decision_route` (400 error strings byte-pinned),
  `DecisionEnvelope::passthrough` (confidence 1, decided_by "repair-passthrough",
  allowed_code_fence=MODE_FENCE[mode], skill=MODE_SKILL[mode]), fallbackEnvelope
  ("in-process-fallback") INTERNAL-only (matches §8 discovery 9). §14 RESOLVED: narrow
  JS-compatible number serializer — integral f64 → `1`, never `1.0`; `lfm_input`/`lfm_raw`
  OMITTED; 11-key insertion order preserved.
- `crates/ruke-decision/src/contracts.rs` + `contracts_generated.rs` — MODE_CONTRACTS
  embedded as Rust literals, generated by `rust-backend/scripts/gen-mode-contracts.mjs`
  (imports the SAME lib/decision/contracts module); sha256/bytes/utf16 pinned by
  `skills/06-mode-contracts-hashes.json`.
- `crates/ruke-decision/src/skill_block.rs` — `build_decision_skill_block`: composes
  `<decision_skill>…</decision_skill>` from `.cskills/<skill>/SKILL.md` via ruke-skills
  loaders; returns None for no-skill envelopes.
- `crates/ruke-skills/src/{jsstr,jspath,registry,lazy,core_skill}.rs` — JS-semantics helpers
  (js_trim with JS whitespace set incl. FEFF/NBSP excl. U+0085, UTF-16 unit lengths/slices),
  lexical path resolve + strict-child guard, safe-name gate + LINK_RE, §11 user-tier slash
  helpers (extract_user_text, last_user_index, inject_system_before, apply_slash_skill_routing)
  kept DISCONNECTED from live routes, and `load_core_skill_bundle` parity of
  `lib/decision/skill-loader.ts` (strip_frontmatter, strip_executable_sections for
  SCRIPT_CONTRACT_SKILLS = xlsx|docx|pdf|pptx|archify, 9000 UTF-16-unit cap with
  lastIndexOf("\n",9000)>4500 newline-cut else hard slice).
- Regex parity (validated by the 74-vector fixture `decision/06`): the `regex` crate has NO
  look-around — every JS `\b`/`(?!…)` ported as consuming boundary classes (span-equivalent
  when the whole region is removed); ASCII-only `\b` ("caféexcel" matches, "pdfx" doesn't);
  é-ending `résumé` demands a WORD char next ("résumé" misses, "résumé2"/"résumébuilder"
  hit); dotted alternatives `\.xlsx|\.docx|\.pptx` are DOMINATED by bare siblings
  (existence-equivalent uniform group classes); ASSET3D bridge `NBline (?:M* NBline)?` —
  "render scene" hits, "render\nscene" misses (JS `.` never crosses \n).
- Golden harness: `__tests__/rust-golden/decision-parity.test.ts` records `decision/06`
  (74 vectors + blankMessage fallback) and `skills/06` (contract hashes) from the LIVE oracle.
- Rust replay: `crates/ruke-decision/tests/fixture_replay.rs` — 9 tests, all green: decision
  01–05 status+bodyBytes byte-exact; `"confidence":1,` + key-order + lfm-omission pins;
  74 vectors field-for-field; skills/06 sha/bytes/utf16; skills/01 slash block byte-identical
  + x-used-skill "humanizer" + source sha; skills/02 sibling-key preservation; skills/03
  total payload noop; skills/04 `<decision_skill>` block string-equal (js_len 11144 units vs
  block_bytes 11204 UTF-8; block sha 82fc8045…; .cskills/xlsx source sha 111e0652…);
  skills/05 passthrough block sha ed1baf3f….
- Docs: MIGRATION-MAP §10 tracker `| 3 | **DONE 2026-10-26** |` row + `| 4–10 | PENDING | |`;
  fixtures README discovery-1 marked RESOLVED (§14 serializer).
- VERIFY (real exits, ${PIPESTATUS[0]} discipline): `cargo test --workspace` 81 passed
  (contracts 8, core 19, decision 11 unit + 9 replay, server 2, skills 32) exit 0;
  `cargo clippy --all-targets -- -D warnings` exit 0; `cargo check` exit 0;
  `npx tsc --noEmit` exit 0; `npx vitest run` (full) 661 passed / 1 skipped exit 0 (rerun
  after flake triage — see 8.6).

### 8.3 Graphify map (Rust side)
- ruke-decision→ruke-contracts (RendererMode/DecisionEnvelope/mode_fence/mode_skill — §15
  reuse, no duplicate structs) + ruke-skills (core bundle loading for the decision block).
- ruke-skills→(jsstr,jspath,registry) internal; lazy.rs is the §11 user-tier port (no live
  caller yet — Part 4/5 wires it).
- TS oracle callers (unchanged, authoritative): lib/decision/{client,contracts,types,
  skill-loader}.ts + app/api/decision/route.ts + app/api/chat/route.ts (decision gate,
  slash routing, core injection) — Rust mirrors them, nothing in TS calls Rust.
- Fixture producers: decision-parity.test.ts → decision/06 + skills/06; consumers:
  fixture_replay.rs (all decision/ + skills/ fixtures). Harness drift guard: re-record =
  `rm` fixture + rerun vitest (never hand-edit bytes; never weaken fixtures).

### 8.4 Immutable contracts added this session
- RendererMode::parse + as_str (9 modes); DecisionEnvelope.skill_to_load/allowed_code_fence
  are `Option<&'static str>` (mode_fence/mode_skill return statics — compare directly
  `Some("xlsx")`, NO as_deref); MODE_SKILL includes 3d_asset→threejs-skills.
- decision_route: 400 bodies pinned byte-for-byte by fixtures 03–05.
- Caps: core bundle 9000 UTF-16 units; user skill block 160000 units.
- Anchors (pinned): decision-skill block sha 82fc80452e7a…0fa1 (11204 bytes, 11144 units);
  passthrough block sha ed1baf3fab23…596d (11194 bytes); .cskills/xlsx/SKILL.md sha
  111e06521941…fb5a; humanizer skills/humanizer/SKILL.md sha 3ac977c2… (fixture 01 anchor).
- §14 confidence serializer RESOLVED and pinned (`envelope_confidence_and_key_order_bytes`);
  fixtures/README discovery-1 closed. All Part-1/2 contracts above remain in force verbatim.

### 8.5 E2E/verification state
- NO Playwright (Part 3 brief forbids it; Part 10 only). No `.ai-coordination/playwright.lock`.
  :3000 Next dev and :8080 Strata never touched — replays are in-process, fixtures + real
  repo skill files only.
- Full vitest corpus green (661/1 skipped, exit 0). cargo 81 green. tsc green.

### 8.6 Open bugs & gaps (recorded, not skipped)
- Vitest parallel-load FLAKES (first full-suite sampling): chatEngine 5000 ms timeouts ×2 +
  web.test 01/02 false "fixture drift" (mock-server race dropped `"stream":false` from the
  recorded payload). Both files 12/12 standalone; full rerun 661/1 exit 0. Classified
  contention flakes — if they reappear, capture the FULL unfiltered log first time
  (`| tee .ai-coordination/flake.log`).
- Documented parity deviations (never exercised by the corpus): lone-`\r` line separators in
  the multi-line strip regexes (JS `^`/`$` fire around \r, Rust `(?m)` doesn't — repo skill
  corpus is LF/CRLF only, `cat -A` verified); hard-slice cap fallback snapping mid-surrogate
  pair below (JS emits a lone surrogate); astral-heavy bundle at the 9000 cap unexercised.
- No Rust HTTP surface for decision/skills is wired (intentional — §11 kept disconnected).

### 8.7 Active skills & scenario locks
- No Tier-1/Tier-2 skill bodies loaded. No scenario locks. `.cskills/xlsx` read as fixture
  data only (loader parity), never injected into this session's prompt.

### 8.8 Immediate next 3 atomic actions
1. PART 4 (per MIGRATION-MAP §10): chat core SSE port — stream scrubber state machine
   (conform to sse/02 expectedRust* vectors, NEVER the mangled TS bytes), legacy + progress
   response paths, error contract (4xx/5xx/unreachable/empty-body per errors/ fixtures),
   headers — replayed against `rust-backend/fixtures/{chat,errors,sse}/`.
2. §20 matrix rerun after Part 4 code lands (cargo test/clippy/check + tsc + golden replays).
3. Only if the user asks: commit (untracked: `__tests__/rust-golden/decision-parity.test.ts`,
   `rust-backend/crates/ruke-decision/`, `ruke-skills/`, `rust-backend/scripts/`, fixtures
   06 ×2; modified: MIGRATION-MAP, fixtures README, Cargo.toml/lock, tsconfig.tsbuildinfo;
   trailer "Co-Authored-By: Claude Code <noreply@anthropic.com>").

---

## Session 2026-10-26-E — Rust migration Part 4 (chat core: SSE transport, scrubber, error contract)

### 8.1 Objective & milestone
PART 4 complete 2026-10-26: the chat transport/core runs inside `ruke-server`
(`crates/ruke-server/src/chat/`) and reproduces the frozen `POST /api/chat` wire contract —
oracle `app/api/chat/route.ts` (780 L) FROZEN and untouched. Both response paths, the full
error contract, application headers, abort propagation, slot discipline and the approved-
deviation scrubber are ported and replayed green against `fixtures/{chat,errors,sse}`.
Golden replays 19/19 + scrubber vectors 2/2; §28 check matrix ALL green with real exit codes.
NO cutover: Next still serves 100% of live traffic; Rust `/api/chat` exists only inside the
isolated ruke-server (direct-router oneshot + one real-socket test); no Playwright; Strata
`:8080` never contacted (scripted mock upstreams only). Next: Part 5 (attachment retrieval).

### 8.2 Locked completed (do not re-read/re-do)
- `src/chat/mod.rs` + `handler.rs` — request parse (capped read `read_capped`, MAX_CHAT_BODY
  128 MiB), malformed-JSON ⇒ raw bytes forwarded VERBATIM (gate never runs), `model` default
  `"default"`, compaction passthrough (purpose deleted + `attachment_ref` parts stripped ⇒
  always legacy + `standard_chat` gate result), pinned `decision_mode` passed into the gate
  then ALWAYS deleted inside the gate, strict `payload.stream === false` ⇒ legacy path else
  early-open progress path (spawned pump + `AbortOnDrop`), gate snapshot + decisionMs.
- `src/chat/attach.rs` — port of `strip_attachment_refs` + `attachment_ref` part detection.
- `src/chat/forward.rs` — `forward_legacy` (slot `begin_guard` BEFORE network; select!-biased
  cancel ⇒ 503; error status ⇒ `text()` then `error::json_error` mirroring upstream status;
  `matches!(204|205|304)` ⇒ 502 `No response body from model` — a 200 with `content-length:0`
  HAS a body and must NOT 502, pinned comment; success ⇒ `stream_headers` + spawned
  `run_pump` + `Body::from_stream(AbortOnDrop(ReceiverStream))`); `forward_into` (fail ⇒
  `ch.fail`; client abort ⇒ silent `ch.close`; success ⇒ finish flush + `ch.close` — the route
  NEVER self-appends `[DONE]` after raw upstream bytes); PUMP_BUFFER=64 bounded mpsc
  backpressure; NO upstream response-header copying (the oracle copies none).
- `src/chat/scrubber.rs` — `ThinkScrubber`: incremental byte-level state machine = ATOMIC
  scrub semantics at every split (the §10/§21 APPROVED DEVIATION — never the mangled TS
  per-chunk bytes; UTF-8-safe by construction: tags pure ASCII, continuation bytes ≥ 0x80);
  unterminated `<think>` swallows to EOF; holdback = longest tail that is a PROPER PREFIX of
  the open/close tag via `proper_prefix_suffix` (a fixed `len(tag)-1` holdback STALLED the
  literal tail bytes of a final SSE frame when upstream went quiet before EOF — chat/07
  pinned the stall; fixed this session). Unit tests: pass-through, split matrices,
  byte-at-a-time, `a<thi`+`n>`⇒`a<thin>`, unterminated, nested openers, utf8.
- `src/chat/sse.rs` — `ProgressChannel` (early-open, closed latch, `ruke_stage`/`ruke_error`/
  `[DONE]` grammar; error path = ONE `ruke_error` frame + exactly ONE `[DONE]`);
  `src/chat/headers.rs` — success set exactly {cache-control `no-cache, no-transform`,
  connection `keep-alive`, content-type `text/event-stream`, x-accel-buffering `no`,
  x-decision-mode `<mode>`} + x-used-skill only for user-skill turns;
  `src/chat/error.rs` — `upstream_headers` trio (accept/authorization/content-type ONLY on
  the forwarded request), `unreachable_message` (url::Url host + non-default port else
  `"the configured port"`), `upstream_error_message` (`errText.slice(0,200)` counts UTF-16
  UNITS), `json_error` (see 8.4 content-length contract).
- `src/chat/pipeline.rs` — Part-4 honest subset (decision skill block via Part-3 crates) +
  DOCUMENTED PART-5 SEAM (attachment retrieval frames) and PART-6 SEAM (web gate;
  `PipelineOutcome{web_citations, search_gate}` always None in Part 4). NO fake success
  frames for stages that don't exist.
- Tests: `crates/ruke-server/tests/common/mod.rs` (fixture loader, `normalize_body_ms`,
  `parse_logical`, `assert_response` EXACT BTreeMap header-set equality, `assert_upstream_call`
  trio-subset + byte-identical body, `Script::{stream,http_error,no_body(=204),hold}` +
  `HoldStream` drop-witness, real-router oneshot driver 20 s timeouts, `STD_UPSTREAM` 181 B,
  `test_state` root = real repo root so 06a/06b load real `.cskills`);
  `golden_replay.rs` 19/19 (chat 01,02,03,04a-c,05,06a,06b,08 + errors 01–08 + chat/07 real
  socket: partial frame strict-read, `logicalFramesBeforeAbort` equal, zero `ruke_error`,
  drop ⇒ upstream-abort witness ≤5 s ⇒ `assert_slot_idle`); `scrubber_vectors.rs` 2/2
  (sse/02+03 every split + byte-at-a-time vs `expectedRust*`).
- Docs: MIGRATION-MAP §10 `| 4 | **DONE 2026-10-26** |` + `| 5–10 | PENDING | |`; fixtures
  README new "Part-4 Rust replay status" section (deviation RESOLVED, 204 mapping,
  content-length note, unreachable-pair note).
- VERIFY (real exits, `${PIPESTATUS[0]}` discipline): `cargo test -p ruke-server` lib 26 +
  golden 19 + vectors 2 all ok; `cargo test --workspace` **126 passed / 0 failed exit 0**
  (contracts 8, core 19, decision 11 + replay 9, server 26 + 19 + 2, skills 32);
  `cargo clippy --workspace --all-targets -- -D warnings` exit 0 (after scrubber.rs `op_ref`
  fix); `cargo check --workspace --all-targets` exit 0; `npx tsc --noEmit` exit 0;
  `npx vitest run __tests__/rust-golden` **43/43 exit 0** on rerun (see 8.6 flakes).

### 8.3 Graphify map (Part 4)
- `lib.rs::build_router(AppState{settings,slot,turns,root,http})` (bare Router, NO layers —
  harness adds none) wires GET `/api/ruke/health` + POST `/api/chat` → `chat::handler`;
  ONLY caller of the chat module. `handler`→{attach,error,forward,headers,pipeline,
  scrubber,sse}; forward+pipeline→scrubber/sse/headers/error; pipeline→`ruke_decision`
  skill block + `ruke_skills::lazy::inject_system_before` (Part-3 crates); slot RAII
  `UserTurnGuard::Drop` = exactly-once release (`ruke-core`). Live Next traffic never
  reaches Rust.
- Test consumers: `golden_replay`/`scrubber_vectors` → `tests/common` + `ruke_server::chat`
  public surface (`src/lib.rs` `pub mod chat`).
- Fixture consumers extended: fixtures/chat/*, errors/*, sse/02+03 `expectedRust*`; producers
  unchanged (Part-2 TS harness; drift guard intact).

### 8.4 Immutable code contracts added this session
- **content-length contract:** fixtures pin the APPLICATION-level header set —
  `NextResponse.json` errors expose `{content-type: application/json}` ONLY. axum 0.8's
  top-level `RouteFuture::poll` inserts `content-length` from the body's EXACT size hint
  (no opt-out, runs after all middleware) and hyper 1.12 derives one for known-length bodies;
  so `json_error` presents its body as a ONE-FRAME STREAM (unknown hint) ⇒ app-level set
  verbatim; wire chunked vs Node's CL — invisible to fetch (status+bytes identical).
- Error strings: `"Upstream returned <status>[: <errText≤200 UTF-16 units>]"`; 502 `"No
  response body from model"` ONLY from 204/205/304; 503 `"Could not reach the model server
  at <host>."` / `"… at the configured port."`; progress error = same strings via ONE
  `ruke_error` + exactly one `[DONE]`; client abort = silent close, ZERO error frames.
- Upstream forwarded request headers = accept `text/event-stream` / authorization `Bearer
  <key>` / content-type `application/json` (trio; subset-compared); forwarded body
  byte-identical. Success headers exactly the five above.
- Mock `Script::no_body()` ⇒ HTTP **204** (undici `body===null` class). `chat/07`
  `logicalFramesBeforeAbort` = [stage `decision_done`, {kind:"data", obj:null, raw:"partial"}].
- `STD_UPSTREAM` 181 B (3 SSE frames `c1`/`Hello!`) == recorded utf8Lossy legacy bodies.
- Scrubber atomicy: output invariant under ANY split; `finish()` flushes retained proper-
  prefix fragments as literal text. Part-1/2/3 contracts above remain verbatim.

### 8.5 Playwright & E2E verification state
- NO Playwright this session (Part-4 brief forbids it; Part 10 only). No
  `.ai-coordination/playwright.lock`. `:3000`/`:8080` NEVER touched — mock upstreams on
  127.0.0.1:0 ephemeral; chat/07 on a real `axum::serve` socket + reqwest `bytes_stream`.
- rust-golden vitest corpus 43/43 exit 0 (rerun); cargo matrix green (8.2 VERIFY).

### 8.6 Open bugs, failing traces & blockers
- Wire-level divergence ONLY: legacy JSON errors chunked (Rust) vs content-length (Node).
  App-level parity preserved; revisit only if Part-10 cutover measurement objects.
- `MAX_CHAT_BODY` 128 MiB is a Rust-side cap; Next's body-parser limit is config-dependent —
  recorded for the Part-10 parity sweep (corpus bodies are tiny).
- Legacy-path pre-response client disconnect is unobservable in Rust (no early headers on
  legacy; matches TS semantics).
- Vitest parallel-load FLAKES (same family as Session-D 8.6): first `__tests__/rust-golden`
  batch run aborted web.test ×3 on "Fixture drift detected" (drift guard throws BEFORE
  writing; `git status --porcelain` showed ZERO fixture changes); web.test standalone +
  full-dir rerun 43/43 exit 0. Not reproducible standalone; no code/fixture change made.
- Attachment-turn replay fixtures don't exist yet (Part 5 adds them with retrieval); web-gate
  seam untouched (Part 6). No BLOCKED golden items.

### 8.7 Active skills & scenario locks
- No Tier-1/Tier-2 skill bodies loaded; no scenario locks. `.cskills` read as fixture DATA
  only (Part-3 loader parity), never injected into this session's prompt.

### 8.8 Immediate next 3 atomic actions
1. Commit the Part-4 tree (modified: MIGRATION-MAP, fixtures README, Cargo.toml/lock,
   ruke-core/settings.rs, ruke-server/{Cargo.toml,main.rs}; new: `src/lib.rs`,
   `src/chat/`, `tests/`; trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`).
2. PART 5 (MIGRATION-MAP §10): attachment retrieval port against the frozen
   `.data/attach-index/` store + retrieval/retrieval_done frames wired at the documented
   PART-5 SEAM in `pipeline.rs` (child tokens; retrieval non-fatal per attachments/02,03) —
   replay against `fixtures/attachments/01–06` (injection-index off-by-one recorded in §8
   discovery 2 is RECORDED, not fixed).
3. §28 matrix rerun after Part 5 lands (workspace test/clippy/check + tsc + vitest replays).

---

## Session 2026-10-27 — Rust migration Part 5 (attachment read/retrieval side + pipeline wiring)

### 8.1 Objective & milestone
Port the attachment READ/RETRIEVAL side to Rust (`ruke-attach` crate) and wire it into the
Part-4 chat pipeline seam: store READING of the frozen Node-written disk format, BM25+cosine+RRF
retrieval, query routing, formatting, notes, `build_attachment_turn`, `stripAttachmentRefs`,
retrieval/retrieval_done frames. Node keeps extraction/chunking/ONNX embeddings/index BUILD.
Milestone reached: PART 5 COMPLETE — ruke-attach 43/43 unit tests, attachment_replay 6/6
(fixtures 01–06 through the full pipeline), store_compat 6/6 (§27 cross-language), notes route
4/4, full §31 checks green. No cutover; Next.js owns all live traffic.

### 8.2 Locked completed (do not re-read/re-do)
- `rust-backend/crates/ruke-attach/` — 8 modules, 43/43 tests, clippy clean: `store.rs`
  (index_dir/has_index/read_index/read_notes/write_notes/valid_att_id
  `ATT_RE ^att_[a-z0-9]{4,32}$` — direct read of the FROZEN Node format: meta.json pretty,
  chunks.jsonl lines, full.txt, notes.json, frames/), `bm25.rs`+`pack.rs` (TOP_K=8,
  BUDGET=24000, neighbor expansion, RRF — NO better-variant substitution), `route.rs`
  (point_qa/time_range/whole_video; single-HMS timestamp windows ±180 s), `evidence.rs`
  (`retrieve_evidence`, honest missing-index block, formatted knowledge_index blocks +
  text/video rules), `notes.rs` (`generate_notes` + `NotesLlm`), `turn.rs`
  (`build_attachment_turn` incl. the RECORDED unconditional `lastUserIdx+1` quirk,
  frames-before-splice order, keyframe data-url), `refs.rs` (`collect_attachment_refs`,
  `anchor_query`), `embed.rs` (`QueryEmbedder` trait, `UnavailableEmbedder`, `FixedEmbedder`).
- `ruke-server` Part-5 integration: `src/attach_notes.rs` (direct Rust-only route
  `/api/ruke/attach/{id}/notes` + 4 tests; NOT proxied by Next — Part 8), `src/lib.rs`
  (`pub attach_embedder: Arc<dyn ruke_attach::QueryEmbedder>` on AppState), `src/main.rs`
  (production seam = `UnavailableEmbedder` — no second embedding model),
  `src/chat/pipeline.rs` (step-5 seam after skill injection, before the Part-6 web seam:
  refs → retrieval frame → `build_attachment_turn(messages, last_user_idx + 1, …)` →
  retrieval_done done/total; Err → log + `{done:0,total:0}` + continue; NEVER ruke_error),
  `src/chat/handler.rs` (4-tuple `(idx, full_text, pinned, has_refs)` pre-mutation snapshot;
  legacy runs the SAME pipeline, headers only), `src/chat/attach.rs` (shared strip — no
  attachment_ref reaches upstream).
- Tests: `tests/attachment_replay.rs` 6/6; `tests/store_compat.rs` 6/6; Part-4 suite rerun
  green (golden_replay 19, scrubber 2) inside workspace 187.
- Fixture/harness: `rust-backend/fixtures/attachments/store/` (production-writer bytes, 10
  files, 1b absent = missing-index); `__tests__/rust-golden/store-fixture.test.ts` (drift
  guard + `RUKE_WRITE_STORE_FIXTURE=1` regen); `__tests__/rust-golden/support/attach-seeds.ts`
  (SINGLE seed source for attachments.test.ts + store fixture); `attachments.test.ts`
  refactored onto it (6 fixtures still reproduce — seeds proven identical);
  `tests/common/mod.rs` gained `store_fixture_dir` + `copy_tree`.

### 8.3 Graphify map (Part 5)
- `pipeline.rs::run_turn_pipeline` ← callers: `handler.rs` (progress spawn + legacy call) —
  gate snapshot tuple extended `(idx, full_text, pinned, has_refs)`.
- `ruke-server` → `ruke-attach` (new dep): `collect_attachment_refs`, `build_attachment_turn`,
  re-exported notes API; refs non-empty drives the retrieval frame.
- `AppState.attach_embedder` ← `main.rs` (UnavailableEmbedder) / `tests/common` +
  `attachment_replay` (FixedEmbedder [1,0,0.05]).
- `store-fixture.test.ts` → `attach-seeds.ts` ← `attachments.test.ts` (single-source seeds);
  `store_compat.rs` + `attachment_replay.rs` → `fixtures/attachments/store/` (verbatim copies)
  + `fixtures/attachments/01–06` (TS oracles).
- Notes route = standalone (axum router in `lib.rs`); zero Next.js callers by design.

### 8.4 Immutable code contracts added this session
- `ruke_attach::build_attachment_turn(&mut Vec<Value>, user_idx: usize, question: &str,
  root: &Path, &dyn QueryEmbedder, &reqwest::Client, &NotesLlm, &CancellationToken)
  -> Result<usize, Cancelled>` — returns the INJECTED BLOCK COUNT (= retrieval_done done/total);
  honest missing-index block counts as 1; empty evidence → 0 blocks.
- Frames emitted between decision_done/skill and the Part-6 web seam: `{stage:"retrieval"}`
  only when refs present; `{stage:"retrieval_done",done:N,total:N}` on Ok; `{done:0,total:0}`
  on Err (non-fatal; log-only, never ruke_error).
- Store format FROZEN (Node writes, Rust reads): dir `.data/attach-index/<attId>/`
  {`meta.json` (2-space pretty; field order attId,name,category,createdAt,durationSec?,
  chunkCount,spine,spineBlocks,frames), `chunks.jsonl` (JSON lines + trailing newline; empty
  file = 0 chunks), `full.txt` (non-atomic), `notes.json`, `frames/*`}; att ids gated by
  `^att_[a-z0-9]{4,32}$` (invalid id → no index, not an error).
- `AttachmentRef{attId,name,category}`; parts `{type:"attachment_ref", att_id, name, category}`
  stripped from the forwarded payload by the SAME `ruke-server::chat::attach` implementation on
  both response paths; evidence NEVER persisted (request-payload copy only).
- `NotesLlm{url,key}`; notes route direct-Rust only (no Next proxy until Part 8).
- Golden seeds (attach-seeds.ts, single source): QUERY_VEC [1,0,0.05]; att ids att_golden1a
  (text, 3 chunks vecs e0/e1/e2), 1b NEVER seeded, 1c (text, 0 chunks), 1d (video, 3 chunks,
  6300/6360 overlap chunk, frame at 6310 → `frames/f_golden1.jpg` = fixed 1x1 JPEG); meta
  createdAt 0, spine "". Replay fixtures 01–06 and store bytes MUST regen together.
- Injection quirk REPRODUCED: route passes `lastUserIdx + 1` UNCONDITIONALLY; frames append to
  `messages[user_idx]` BEFORE the block splice at `user_idx`. DO NOT FIX (parity first;
  cleanup later).

### 8.5 Playwright & E2E verification state
- NO Playwright (Part-5 brief §29: full manual regression stays scheduled AFTER Part 8); no
  `.ai-coordination/playwright.lock`. Strata `:8080` never touched — mock upstreams ephemeral
  + PORT9 unroutable (`golden-key`).
- §31 record: `cargo test --manifest-path rust-backend/Cargo.toml --workspace` = 187 passed
  (ruke-attach 43, ruke-server lib 30, golden_replay 19, scrubber_vectors 2, attachment_replay
  6, store_compat 6, ruke_skills 34, ruke_decision 11 incl. fixture_replay 9, …); clippy
  `--workspace --all-targets -- -D warnings` exit 0; `cargo check --workspace --all-targets`
  exit 0; `npx tsc --noEmit` exit 0; `npx vitest run __tests__/rust-golden` 43/46 (3 = web.test
  parallel-load flakes; standalone rerun 5/5 exit 0); attachments + store-fixture suites 9/9.
- `attachment_replay` seeds the repo's `.data/attach-index` once per test-binary (OnceLock,
  gitignored, same ids the TS harness cleans in afterAll); run vitest and cargo test
  SEQUENTIALLY to avoid store contention.

### 8.6 Open bugs, failing traces & blockers
- web.test.ts parallel-load flakes (pre-existing family, §31: rerun standalone, do not fix
  unrelated code): 3 "Fixture drift detected" under load — live-page ARIA snapshot text varies
  ("Server error. Try again later." banner) — drift guard throws BEFORE writing, zero fixture
  mutation (git-verified). Standalone 5/5.
- Part-5 Err branch (retrieval THROW → `{0,0}` + continue) is near-unreachable by design
  (matches TS; buildAttachmentTurn never throws) — not exercised by a fixture.
- `attachment_replay` leaves the seeded store in `.data/attach-index` after cargo runs (same
  ids; harmless; a later vitest attachments run cleans + reseeds).
- No BLOCKED golden items; §29/§30 honored (no cutover, notes route not proxied).

### 8.7 Active skills & scenario locks
- No Tier-1/Tier-2 skill bodies loaded this session; `.cskills` read as fixture DATA only
  (excel decision_skill block bytes for fixture 05/06b), never injected into this prompt.

### 8.8 Immediate next 3 atomic actions
1. Commit the Part-5 tree (modified: attachments.test.ts, Cargo.toml/lock, ruke-server
   attach.rs/handler.rs/pipeline.rs/lib.rs/main.rs, ruke-skills jsstr.rs, tests/common/mod.rs,
   MIGRATION-MAP, fixtures README; new: ruke-attach/, attach_notes.rs, attachment_replay.rs,
   store_compat.rs, store-fixture.test.ts, attach-seeds.ts, fixtures/attachments/store/;
   trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`).
2. PART 6 (MIGRATION-MAP §10): web-search port (net/ssrf/cache/engines/metasearch + pipeline
   stages, Tier-3b Node bridge) into the documented web seam in `pipeline.rs` between
   retrieval_done and strip — replay `fixtures/web-search/01–05` (keep the seam intact until
   then; honour the 15 s metasearch cap semantics + both failure shapes).
3. Re-run the §31 matrix after Part 6 lands; rerun attachment + Part-4 goldens (regression).

---

## Session 2026-10-27-B — Rust migration Part 6 (full web-search pipeline port, `ruke-websearch`)

### 8.1 Objective & milestone
Port the ENTIRE web-search pipeline (`lib/web-search/**`) to Rust in crate
`rust-backend/crates/ruke-websearch`: gate → query planner → metasearch engines →
redirect unwrap → platform APIs (YouTube/Maps) → universal extractor cascade (HTTP tiers +
Tier-3b browser RPC seam) → rerank/pack/evidence-block, per MIGRATION-MAP §10 Part 6.
Milestone reached: **PART 6 COMPLETE** — `cargo test -p ruke-websearch` **274/274**
(15 new `pipeline.rs` tests), workspace **461 passed**, clippy `-D warnings` clean,
`tsc` exit 0, full vitest **664 passed / 1 skipped** exit 0. No cutover: the
`ruke-server` chat web-seam remains unwired (Part 8); Next.js owns all live traffic.

### 8.2 Locked completed (do not re-read/re-do)
- Crate commits (oldest→newest): `fc35afc` W0 scaffold, `273a40d` reranker/search-gate/
  charset/schema/hydration/engines, `8d1f6ac` metasearch, `4be037a` query_planner +
  universal_extractor, `7d4bf05` platform_api + redirect_unwrap, `a39272d` google_maps +
  youtube, `b3ec3ba` Tier-3b bridge seam + vision-prepass dead-proof, `08feb45` extractor
  cascade, then the pipeline commit (`pipeline.rs` + `extractor.rs` Send-completeness).
- `crates/ruke-websearch/src/` modules ALL green & clippy-clean: `net.rs` (`Net` trait
  object-safe BoxFuture, `ScriptedNet` w/ `calls: Mutex<Vec<(String,String)>>`),
  `ssrf.rs`, `cache.rs` (`SearchCache`, hashed `query_cache_key` → "q:" write lines carry
  NO plaintext (cache.rs:168–175); "p:{url}" page writes unconditional in ScriptedCache),
  `engines.rs`, `metasearch.rs` (15 s hard-cap timer semantics), `query_planner.rs`,
  `universal_extractor.rs`, `platform_api.rs`, `redirect_unwrap.rs`, `google_maps.rs`,
  `youtube.rs` (`parse_youtube_video_id` lowercases HOSTNAME only; companion query
  `"<title>" "<channel>"` or `"<title>" youtube` sliced 200, youtube.rs:769–781),
  `url_detector.rs` (pass-1/pass-2 double-detection quirk verified against oracle),
  `extractor.rs` (cascade; `on_page: Option<&(dyn Fn(usize,usize)+Send+Sync)>`;
  `done_pages` AtomicUsize Relaxed — RECORDED MICRO-DIVERGENCE in module header),
  `browser_bridge.rs` + `vision_prepass.rs` (dead-module proof — NEVER call a vision
  pre-pass), `pipeline.rs` (full port, ~1900 lines).
- pipeline.rs shipped quirks pinned by tests (`youtube_prompt_hop_merges_despite_dedup_quirk`
  etc.): scheme-`www.` prompt URL → TWO direct targets (raw + `"https://"+raw.to_lowercase()`);
  dedup key = `parse_youtube_video_id(url) ?? url` yields an OBJECT in TS ⇒ identity never
  collides ⇒ prompt packets ALWAYS merge — Rust `MergeKey::Obj(nonce)`/`Url(String)`;
  `evidence_block` keeps `"</evidence>"` as the LAST HEADER array element with [S#] source
  blocks appended AFTER it (block never ends with the close tag; pipeline.ts:215–225);
  charBudget 35_000 / 60_000 deep; `rrf: Number.MAX_SAFE_INTEGER` Stage-0; gap-search
  `.chain(gap_packets)`; cache writes for that fixture = 1 "q:" + 2 "p:" = 3.
- `js_to_fixed2` (production fix this session — REAL parity bug): naive
  `scaled.fract()==0.5` fired on f64 multiply artifacts (2.675·100 rounds to 267.5 while the
  exact value is below the half) → wrong "2.68" vs JS "2.67". Correct form: exact tie via
  IEEE-754 bit decomposition (`exact_tie_hundredths`: bits→(num,e), subnormal e=1074,
  normal e=1075−exp_field, NO std `frexp`; tie ⇔ e in 1..=62 ∧ `100·num mod 2^e == 2^(e-1)`,
  u128); tie → ceil candidate, non-tie → `format!("{a:.2}")`. Verified vectors: 0.125→"0.13",
  2.675→"2.67", 1.005→"1.00", 0.375→"0.38", −0.125→"-0.13", −0.001→"-0.00", −0.0→"0.00".
- Test-design locks: sequential asserts mask later failures (BM25 masked the
  `ends_with("</evidence>")` wrong expectation); adjudicate EVERY expectation against the
  TS oracle text (`lib/web-search/*.ts`), not memory — fixed 3 wrong test expectations this
  session (evidence tail, youtube 2-vs-3 packets, cache-write count) + 1 production bug.

### 8.3 Graphify dependency map (Part 6 nodes)
- `pipeline.rs::run_web_research` ← (future) `ruke-server/src/chat/pipeline.rs` web seam
  (Part 8 wiring point between retrieval_done and strip) — currently UNWIRED, no callers.
- `pipeline.rs` → `extractor.rs::Extractor{net,cache,verticals,bridge}` → `net.rs::Net`,
  `cache.rs::SearchCache`, `platform_api.rs::Verticals`, `browser_bridge.rs::BrowserBridge`.
- `browser_bridge.rs::HttpBrowserBridge` → Part 8 NEW Next route
  `app/api/internal/browser-read` (loopback + secret + SSRF re-validation, §7).
  Production default TODAY: `NoBrowserBridge` (Tier-3b disabled-tier degradation).
- `extractor.rs` `on_page` progress callback ← `pipeline.rs` progress emit.
- `url_detector.rs` → `youtube.rs::parse_youtube_video_id` (hostname-only lowercase).
- `cache.rs::query_cache_key` ← ScriptedCache write log ("q:") + real store rows.

### 8.4 Immutable code contracts & schemas (Part 6, verbatim)
- `pub async fn run_web_research(http: &reqwest::Client, gate_options: &SearchGateOptions,
  net: &dyn Net, cache: &dyn SearchCache, verticals: &dyn Verticals,
  bridge: &dyn BrowserBridge, ctx: &SearchGateContext,
  on_progress: Option<&(dyn Fn(&PipelineProgress) + Send + Sync)>,
  cancel: Option<&AtomicBool>) -> Result<Option<EvidenceBundle>, CacheError>`
  (gate-not-required → `Ok(None)`; `Ok(Some(bundle))` carries evidence).
- `pub struct EvidenceBundle { search_gate: SearchGateResult,
  search_results: Vec<RankedResult>, packets: Vec<EvidencePacket>,
  top_passages: Vec<EvidencePassage>, from_cache: bool,
  coverage: f64 (js_number_ser serialize_with), gap_search_fired: bool,
  auth_required: Vec<AuthRequiredEntry> }` — camelCase wire via serde rename_all.
- `pub const PIPELINE_CEILING_MS: u64 = 240_000;` (deadline || cancel Relaxed flag).
- `pub const ANTI_REFUSAL_DIRECTIVE: &str = concat!(…)`.
- Bridge env/constants: `SECRET_HEADER = "x-ruke-internal-secret"`,
  `READ_PATH = "/api/internal/browser-read"`, `ENV_BASE_URL =
  "RUKE_BROWSER_BRIDGE_BASE_URL"`, `ENV_SECRET = "RUKE_BROWSER_BRIDGE_SECRET"`;
  client deadline = `timeout_ms.unwrap_or(40_000) + 20_000` (RECORDED micro-divergence;
  url field force-echoed = request url).
- `js_to_fixed2` contract as pinned in §8.2 (exact-ECMA-262 `toFixed(2)`).
- Cache keys: `"q:"+sha(query_cache_key)` (lowercase+trim each query, sort, join "|"),
  `"p:{url}"`. Part-4/5 contracts unchanged (chat pipeline seam points intact; attach notes
  route `/api/ruke/attach/{id}/notes`).

### 8.5 Playwright & E2E verification state
- NO Playwright this run (brief: Tier-3b bridge tested ONLY via `ScriptedBridge` mocks; real
  browser = Part 10). No `.ai-coordination/playwright.lock` present (dir holds only
  historical artifacts). Strata `:8080` never contacted — all upstreams scripted/mock.
- §31-matrix record (Part 6): `cargo test -p ruke-websearch` = 274 passed / 0 failed;
  `cargo test --manifest-path rust-backend/Cargo.toml --workspace` = **461 passed / 0
  failed**; `cargo clippy -p ruke-websearch --all-targets -- -D warnings` exit 0 (3 lints
  fixed: manual_range_contains, unnecessary_cast, useless_conversion);
  `npx tsc --noEmit` exit 0; `npx vitest run` (FULL suite) = **63 files / 664 passed /
  1 skipped / 0 failed, exit 0**.
- web.test.ts drift event (this session): one rust-golden sampling flagged
  "Fixture drift detected" in web-search/01 (line 28), 02 (27), 05 (28) — reruns with
  UNCHANGED files/fixtures: standalone web.test.ts 5/5 exit 0, then full suite 664/665
  green. Non-reproducible ⇒ matches the pre-existing parallel-load flake family recorded in
  Part-4/Part-5 8.6 entries. Zero fixture mutation (git status showed only the two Rust
  files). Gate PASSED with this flake recorded.

### 8.6 Open bugs, failing traces & blockers
- web.test.ts shared-state flake family REMAINS (pre-existing, not caused by Part 6):
  under parallel load the mocked-Strata `bodyText` replay can diverge in fixtures 01/02/05;
  drift guard throws BEFORE writing so fixtures are never mutated. Protocol: rerun
  standalone; only a DETERMINISTIC standalone failure would block.
- `extractor.rs` `on_page` Send bound + AtomicUsize `done_pages`: RECORDED micro-divergence
  (cell-ordering of the progress counter not observable in TS single-thread semantics).
- Tier-3b live path degraded until Part 8 (`NoBrowserBridge` = pool-kill-switch tier);
  InnerTube/oEmbed-only YouTube degradation risk on real traffic — watch in Part 10.
- No BLOCKED goldens; no orphan RUKE processes started this session.

### 8.7 Active skills & scenario locks
- No Tier-1/Tier-2 skill bodies loaded. `lib/web-search/*.ts` oracle sections read as data.
- TS oracle sections already in-context/summarized (pipeline.ts evidenceBlock 202–247,
  Stage-0 336–520, dedup 680–700; url-detector.ts full; youtube.ts 42–64) — do not re-read
  unless hash changes.

### 8.8 Immediate next 3 atomic actions
1. Commit the Part-6 tree (modified: `rust-backend/crates/ruke-websearch/src/extractor.rs`,
   `pipeline.rs`, `rust-backend/MIGRATION-MAP.md`, `docs/STATE.md`; message
   `feat: port RUKE web search pipeline to Rust`; trailer
   `Co-Authored-By: Claude Code <noreply@anthropic.com>`).
2. PART 7 (MIGRATION-MAP §10): conversations/titles queue (slot begin_guard/title_call/
   wait_for_user_idle)/model-stats/remaining server state → temp/fixture storage ONLY, no
   live user data; commit `feat: port RUKE server state services to Rust`.
3. PART 8: thin proxies + raw streaming proxy + unified `npm run dev` lifecycle + Windows
   process supervision + browser-read route + env handoff (`RUKE_BROWSER_BRIDGE_BASE_URL/
   SECRET`) + web_citations/gate-frame wiring; curl-based smokes with fixtures web-search/
   01–05; NO Playwright; then OVERNIGHT-REPORT.md + STOP before Part 9.

---

## Session 2026-10-27-C — Rust migration Part 7 (server state: persistence/conversations/titles/settings/skills/model-stats)

### 8.1 Objective & milestone
PART 7 of the Rust migration (contract = `rust-backend/MIGRATION-MAP.md`, frozen). Ported
the remaining TS server-state services into `ruke-server` WITHOUT cutover: disk
persistence + title-ownership merge, conversation CRUD routes, the full titles subsystem
(policy/transcript/generate/queue), settings routes, model stats, skills list/install, and
the Rust-only attach-notes route. Next: PART 8 (thin-proxy cutover + `npm run dev`
lifecycle + browser-read route + env handoff). Part 9/10 NOT started; old TS
implementations intact.

### 8.2 Locked completed (do not re-read/re-do)
- `rust-backend/crates/ruke-server/src/persistence.rs` — port of `lib/persistence/disk.ts`
  + `lib/persistence/merge.ts`. `file(id)` per-char `[^a-zA-Z0-9_-]`→`_` sanitize; list
  reads RAW filenames then RE-STATS the sanitized path (the `we!rd.json` lists-as-`we!rd`
  / updatedAt-0 / get-None quirk pinned); tombstone Map keyed RAW id, `now-deletedAt<5000`
  drops the racing save else tombstone removed; `js_ms_number` (JSON.stringify never
  prints `.0`); `merge_protected_title` full catch matrix (falsy stored / unparseable
  either side / non-object meta strict-mode-throw ⇒ incoming verbatim; stored truthy title
  + titleSource/titleGenCount/titleGenAt copied when `!== undefined`; parsed path ALWAYS
  re-serializes). Test-only clock seams `save_at`/`delete_at` (production `save`/`delete`
  stamp `now_ms()`).
- `src/conversations_routes.rs` — GET list (+GET enrichment), GET/POST/DELETE
  `/api/ruke/conversations[/{id}]`; POST gate order: null body ⇒ 500 (`body.id` TypeError
  parity), truthy-non-string id ⇒ 500, else 400; save path runs `merge_protected_title`;
  title route delegates to `titles` (skip-reason JSON per TS).
- `src/titles/mod|policy|transcript|generate|queue.rs` — port of `lib/server/titles/**`:
  `looks_auto_title` two-arm slice(0,40) table (UTF-16 units, collapse arm
  `js_slice_head(js_collapse(first.trim()),40)`); `should_generate` (manual⇒false,
  force⇒true, non-number stored count ⇒ `count>=2`, else `count-gen>=4`);
  `apply_title_to_doc` guarded write (titleSource:"auto", titleGenCount, titleGenAt);
  transcript caps 500/400 UTF-16 + `[attached: …]` note + `String([1,null,"x"])`=="1,,x"
  join quirk; normalize-title guard ladder (prefix/bullet/num/intro strip, prose guard
  `/\.\s+\S/`, refusal regex, 60-cut `sp>=40`, >12 words ⇒ null); title call body
  model/stream:false/temperature:0.2/max_tokens/reasoning_effort:"none", 150000 ms
  timeout; map-reduce plan; `queue.rs` global serial chain + per-conversation coalescing
  + slot-aware yield + bounded retries.
- `src/settings_routes.rs`, `src/model_stats.rs`, `src/skills_routes.rs`,
  `src/skills_install.rs` (npx skills add via tokio::process, stdout/stderr pump
  `pump_output<R: AsyncReadExt+Unpin+Send>`), `src/attach_notes.rs` route;
  `src/main.rs`/`src/lib.rs` wiring — ALL Part-7 routes under `/api/ruke/*` ONLY (lib.rs
  guard test pins `/api/settings`, `/api/search`, `/api/conversations` = 404 on the Rust
  server); `ruke-skills` gains `frontmatter.rs` + `modality.rs`.
- WITNESS FIX (production): the title normalize regex statics embed the JS-`\s` class
  `WSI` — they MUST be bracketed `[{WSI}]`; a bare `{WSI}` in `format!` is a literal
  escape SEQUENCE (never matches TS `\s` semantics). TITLE_PREFIX/BULLET/NUM/INTRO/
  REFUSAL bracketed; PROSE/CUT_TRAIL already were.
- Gate results (final, this session): `cargo test --workspace` **540 passed / 0 failed**
  (ruke-server 123 = 90 lib + 19+6+2+6 integration); `cargo clippy --workspace
  --all-targets -- -D warnings` exit 0 (8 lints fixed: unused `put`/`HashMap`,
  redundant-closure⇒`is_some_and(jsstr::js_truthy)`, `map_or`⇒`is_none_or`, doc
  overindent, 2 needless_borrow, complex-type⇒`OnCall` alias); `npx tsc --noEmit` exit 0;
  full `npx vitest run` **63 files / 664 passed / 1 skipped** on rerun.
- Ten Part-7 test failures adjudicated against freshly-read TS oracles (`policy.ts`,
  `generate.ts`, `disk.ts` read VERBATIM — in-context, do not re-read): 6 were WRONG TEST
  expectations (sanitizer "we_rd____x", `\\ufeff` fixture escape, looks_auto_title
  slice(0,40) math — dynamic pins, "1,,x", first-time title rule queued⇒ok, m2 "user"
  title IS overwritten by auto-gen), 4 were PRODUCTION bugs fixed (regex WSI bracketing ×
  statics, null-body 500 arm, array-meta Ok(true) arm). Tombstone test made deterministic
  via `delete_at` seam (prior pass raced the ms boundary by luck).

### 8.3 Graphify dependency map (Part 7 nodes)
- `conversations_routes.rs` → `persistence.rs::{ConversationStore, merge_protected_title,
  js_ms_number}` + `titles::{policy, queue}`; `titles/generate.rs` → main-model HTTP seam
  (Strata base from SettingsStore) — mock-only in tests, Strata :8080 never contacted.
- `titles/queue.rs` shares the inference-slot coordination (ruke-core `UserTurnGuard`
  family); `attach_notes.rs` → ruke-attach `generate_notes`.
- Callers: none outside ruke-server (zero cut-over; Next owns all live traffic until
  Part 8). `ruke-skills::jsstr` extended (js_collapse/js_slice_head used by transcript
  and policy).

### 8.4 Immutable code contracts & schemas (Part 7, verbatim)
- `pub struct ConversationStore { dir, recently_deleted: Mutex<HashMap<String,i64>> }`;
  `list()->Result<Vec<ListedConversation{id,updated_at:f64}>,String>`; `get()->Option<String>`
  (lossy utf-8); `save->Result<(),String>` tombstone-guarded; `delete->()` tombstone-first.
- `pub fn merge_protected_title(stored_raw: Option<&str>, incoming_json:&str)->String`.
- Title policy: `looks_auto_title(t,first) = t==first[0..40] ||
  t==collapse(first)[0..40]` (UTF-16 units); `should_generate`: manual⇒false;
  force⇒true; `titleGenCount` not-a-number⇒`msgCount>=2`; else `msgCount-gen>=4`.
  `apply_title_to_doc` sets meta.title/titleSource:"auto"/titleGenCount/titleGenAt.
- RECORDED divergences (in-module headers): array-`meta` title write ⇒ `Ok(true)` doc
  byte-unchanged (JS expando dropped by stringify); primitive-`meta` ⇒ Err ⇒ 500
  (strict-mode TypeError); astral sanitizer 2-vs-1 underscore (unreachable UI ids);
  DATA_DIR resolve WEBUI_DATA_DIR→HOME→USERPROFILE→repo-root+warn (TS `HOME!` crash
  replaced by degrade); integer-ms tombstone stamps.
- Bridge/env unchanged from Part 6; new this part: none (Part 8 adds
  RUKE_BROWSER_BRIDGE_* + RUKE_PROJECT_ROOT handoff).

### 8.5 Playwright & E2E verification state
- NO Playwright, NO `.ai-coordination/playwright.lock` (never created this run). Tier-3b
  bridge still mock-only. Strata :8080 untouched (title calls scripted mock upstream).
- Rust integration = axum in-process + temp dirs (no ports bound in tests). No orphan
  processes started this session.

### 8.6 Open bugs, failing traces & blockers
- Vitest parallel-load flake family extended: `__tests__/skills/chatEngine.test.ts`
  "spreads deliverable-intent word…" hit the 5000 ms timeout in one FULL run (collect
  27 s, 63 files); passes standalone 7/7 in 550 ms and full rerun 664/1 skipped green ⇒
  non-deterministic load flake (same family as web.test.ts Part-4/5/6 records). No test
  weakened, no production touched. Protocol stands: standalone rerun; only a DETERMINISTIC
  standalone failure blocks.
- rust-analyzer diagnostics LAG cargo (stale "unused HashMap" fired after removal) —
  cargo test/clippy remain authoritative.
- No open production bugs; no blockers.

### 8.7 Active skills & scenario locks
- No Tier-1/Tier-2 skill bodies loaded. TS oracles `lib/server/titles/{policy,generate,
  transcript,queue}.ts`, `lib/persistence/{disk,merge}.ts` read VERBATIM this session
  (in-context/summarized) — do not re-read unless hash changes.

### 8.8 Immediate next 3 atomic actions
1. Commit Part-7 tree (modified: `rust-backend/Cargo.lock`, `ruke-attach/src/{lib,store}.rs`,
   `ruke-server/Cargo.toml`, `ruke-server/src/{attach_notes,lib,main}.rs`,
   `ruke-server/tests/common/mod.rs`, `ruke-skills/src/{jsstr,lib,registry}.rs`,
   `rust-backend/MIGRATION-MAP.md`, `docs/STATE.md`; new: `ruke-server/src/{conversations_routes,
   model_stats,persistence,settings_routes,skills_install,skills_routes}.rs`,
   `ruke-server/src/titles/*`, `ruke-skills/src/{frontmatter,modality}.rs`; message
   `feat: port RUKE server state services to Rust` + trailer
   `Co-Authored-By: Claude Code <noreply@anthropic.com>`).
2. PART 8 per MIGRATION-MAP (thin proxies MOVE_TO_RUST→:3101 KEEP_NODE_REQUIRED untouched;
   raw streaming proxy no SSE re-serialization; `npm run dev` spawns ruke-server.exe +
   Windows teardown; `app/api/internal/browser-read` route loopback+secret+SSRF re-check;
   env handoff; web_citations/gate frames; curl smokes fixtures web-search/01–05; NO
   Playwright) → commit `feat: cut RUKE backend over to Rust`.
3. FINAL: rerun checks from committed state; `rust-backend/OVERNIGHT-REPORT.md`; STATE.md
   sync; final report (Parts 6/7/8 statuses, hashes, test totals, "manually regression-test
   RUKE Part 8. Do NOT start Part 9 yet."); then `shutdown.exe /s /t 60 /c "RUKE overnight
   Parts 6-8 run finished. See rust-backend/OVERNIGHT-REPORT.md"`. NEVER Part 9/10.

---

## SESSION 2026-10-27 (Part 8 — thin-proxy cutover + unified dev lifecycle) — 8.1–8.8

### 8.1 Core objective & active phase
Parts 6 (`00597ba`) and 7 (`7e405b5`) committed and locked. PART 8 EXECUTED TO COMPLETION:
(a) Rust side landed in the PRIOR segment (chat web seam live, `/api/ruke/{search,search-more,
decision}` + `WebRuntime` + bridge env wiring, cargo 548/0, clippy clean); (b) TS cutover
machinery this segment — `lib/server/rustProxy.ts` (env-gated thin proxy, honest-502 no-fallback),
14 route files / 20 handlers gained early-return proxy branches, `app/api/internal/browser-read/
route.ts` (Tier-3b RPC seam), `scripts/dev-supervisor.mjs` (unified `npm run dev`: ruke-server +
next dev as DIRECT children, env+secret handoff, `taskkill /T /F` teardown), `package.json`
`dev`→supervisor + `dev:next` legacy kept. ALL GATES GREEN (tsc 0; vitest 664 passed / 1 skipped
exit 0 on rerun; cargo build OK; Rust 548/0 carried — Rust tree untouched this segment). ALL CURL
SMOKES GREEN (direct-binary + supervisor live, incl. byte-identical proxied settings vs live TS
control). NO Playwright at any point. STATUS: implementation + gates + smokes DONE; docs (this
file + MIGRATION-MAP Part-8 row — DONE) → commit → final verification → OVERNIGHT-REPORT → final
report → shutdown. STOP BEFORE PART 9.

### 8.2 Locked completed tasks (do not re-read / re-do)
- Parts 1–7 (all prior MIGRATION-MAP rows; commits `c53d442`…`7e405b5`) — LOCKED.
- Part-8 RUST side — LOCKED (unchanged on disk this segment; 548/0 + clippy evidence carried):
  `chat/{handler,pipeline,sse,forward,headers}.rs` (web seam LIVE), `search_routes.rs`,
  `decision_routes.rs`, `lib.rs` (WebRuntime + router + 2 new tests), `main.rs` (web boot +
  boolean-only bridge logging), `tests/common/mod.rs`, `ruke-server/Cargo.toml`, `Cargo.lock`.
- Part-8 TS side — LOCKED, gate- and smoke-verified this segment: `lib/server/rustProxy.ts` (new),
  `app/api/internal/browser-read/route.ts` (new), `scripts/dev-supervisor.mjs` (new; wildcard port
  probe FIXED — a 127.0.0.1-only probe misses Windows wildcard holders), 14 route files (`chat`,
  `search`, `search-more`, `decision`, `settings`, `model-stats`, `conversations`,
  `conversations/[id]`, `conversations/[id]/title`, `attach/[id]/notes`, `skills`,
  `skills/install`, `skills/[skillName]`, `skills/[skillName]/scenario`), `package.json`
  (dev/dev:next), `rust-backend/MIGRATION-MAP.md` (Part-8 DONE row + §7 records).
- Smoke evidence goes to OVERNIGHT-REPORT (next step) — do not re-run smokes.

### 8.3 Active graphify dependency map
- `app/api/**` 20 handlers → `rustEnabled()`/`rustProxy()` (new leaf; zero deps beyond node fetch)
  → `http://127.0.0.1:<RUKE_BACKEND_PORT>` (default 3101) → ruke-server router → Rust services.
- `scripts/dev-supervisor.mjs` → spawns `rust-backend/target/{debug,release}/ruke-server[.exe]`
  (RUKE_SERVER_BIN override) + `node_modules/next/dist/bin/next dev`; exports RUKE_RUST_BACKEND,
  RUKE_BACKEND_PORT, RUKE_PROJECT_ROOT, RUKE_BROWSER_BRIDGE_{BASE_URL,SECRET}.
- Rust `HttpBrowserBridge::from_env()` → POST `http://127.0.0.1:<nextPort>/api/internal/browser-read`
  (+ `x-ruke-internal-secret`) → `extractPageInOnePass` (lib/web-search/agentBrowser — untouched).
- `/api/chat` proxied to the SAME path `/api/chat` on the Rust server (Rust guard test pins other
  plain paths at 404).
- Callers unaffected: vitest goldens invoke handlers in-process (env unset ⇒ TS verbatim); the
  user's pre-session :3000 TS server (pid 5672, NEVER kill) lacks RUKE_RUST_BACKEND ⇒ live TS oracle.

### 8.4 Immutable code contracts & schemas (in force)
- Proxy: `rustEnabled()` ⇔ `process.env.RUKE_RUST_BACKEND === "1"`; `rustBaseUrl()` =
  `http://127.0.0.1:${RUKE_BACKEND_PORT?.trim() || "3101"}`; hop-by-hop strips both legs (incl.
  content-length; accept-encoding request-leg only, so undici negotiates); non-GET/HEAD body
  `duplex:"half"`; failure ⇒ console.error + 502 `{"error":"Rust backend unreachable at <base>"}`
  application/json; NO silent TS fallback (one turn never spans two backends). Streams pass
  through untouched (SSE re-emitted, never re-serialized).
- Route→Rust path map (dynamic segments encodeURIComponent'd by the caller; query preserved):
  chat → `/api/chat` (same path); search/search-more/decision → `/api/ruke/*`; settings GET/DELETE
  optional `req?` (argument-less vitest callers keep working) + PUT → `/api/ruke/settings`;
  model-stats → `/api/ruke/model-stats`; conversations family → `/api/ruke/conversations[/:id[/title]]`;
  attach notes → `/api/ruke/attach/:id/notes`; skills → `/api/ruke/skills[/install|/:name[/scenario]]`.
- browser-read RPC: header `x-ruke-internal-secret`; secret env unset ⇒ 401 for EVERY caller; 401
  `{"error":"unauthorized"}`; 400 `{"error":"Malformed JSON body"}` / `{"error":"url required"}`;
  success = `extractPageInOnePass(url, timeoutMs ? {timeoutMs} : {})` JSON (infallible by design;
  errors travel in the payload).
- Rust wire (unchanged): DecisionEnvelope snake_case (confidence integral `1`); search no-q ⇒
  `{"results":[]}`; search-more empty ⇒ `{"error":"queries array is required (1-3 string entries)"}`;
  decision bad-json ⇒ `{"error":"invalid JSON body"}`; health ⇒
  `{"ok":true,"version":"0.1.0","user_turn_active":false}`.
- Env vars: RUKE_RUST_BACKEND (Next proxy only; supervisor-exported), RUKE_BACKEND_PORT (3101),
  RUKE_PROJECT_ROOT (rust child), RUKE_BROWSER_BRIDGE_BASE_URL/SECRET (rust→Next hop; secret shared
  to the next child; random 24-byte hex per run; NEVER logged), RUKE_SERVER_BIN (supervisor
  override), PORT (Next port).
- Supervisor: fail-fast pre-spawn on WILDCARD-bind port clash (`net.createServer().listen(port)`
  with NO host); first-child-exit wins teardown; SIGINT⇒130 / SIGTERM⇒143; Windows `taskkill /T /F`
  cascade; exit codes propagated.

### 8.5 Playwright & E2E verification state
- NO PLAYWRIGHT THIS RUN (brief). `.ai-coordination/playwright.lock` NEVER created. Tier-3b bridge
  verified by curl only (401 no-secret arm). Real Tier-3b browser-pool testing deferred to Part 10.
- Smoke ports 3001/3101/3200/3998/3999 ALL released (taskkill cascades verified; ports re-probed free).
- User's pre-session TS server :3000 = pid 5672 (parent 716, started 2026-10-27 11:08:56 — NOT
  session-started ⇒ NEVER kill; stays up as the live oracle). Nothing session-started remains running.

### 8.6 Open bugs, failing traces & blockers
- None open. Vitest parallel-load flake family now ×3 (web.test.ts; chatEngine.test.ts ×2 — this
  session: one full run failed `chatEngine` "spreads deliverable-intent word…" at the 5000 ms
  timeout; standalone green; full rerun 664 passed / 1 skipped exit 0). Adjudicated
  non-deterministic load flake; zero test mutation (brief rule honored).
- Windows gotchas recorded (fixed): MSYS `$!` ≠ Windows PID (locate real pids via
  Get-CimInstance CommandLine match before taskkill); 127.0.0.1-only port probe FALSE-PASSES beside
  a wildcard holder ⇒ supervisor probe is now wildcard; `next dev` silent port fallback
  (3000→3001) breaks bridge/proxy contracts — pre-spawn refusal is the fix.

### 8.7 Active skills & scenario locks
- No Tier-1/Tier-2 skill bodies loaded. Part-8 TS oracles (`app/api/**` route files,
  `lib/web-search/agentBrowser.ts` contract, `lib/server/logger.ts` DELETE_AFTER_PARITY status) all
  consumed; do not re-read unless hashes change.

### 8.8 Immediate next 3 atomic actions
1. COMMIT: stage the Part-8 file set (14 routes + `package.json` + `tsconfig.tsbuildinfo` (tracked)
   + all modified `rust-backend/**` files + new `app/api/internal/`, `lib/server/rustProxy.ts`,
   `scripts/dev-supervisor.mjs`, `decision_routes.rs`, `search_routes.rs` + MIGRATION-MAP +
   STATE.md); message `feat: cut RUKE backend over to Rust` + trailer
   `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
2. FINAL VERIFICATION from committed state: `cargo test --manifest-path rust-backend/Cargo.toml
   --workspace` (expect 548/0); `git status` clean; write `rust-backend/OVERNIGHT-REPORT.md` with
   "USER MANUAL REGRESSION CHECKPOINT — manually regression-test RUKE Part 8; DO NOT START PART 9"
   + recommended manual journeys + risks.
3. FINAL REPORT (Part 6 DONE `00597ba`, Part 7 DONE `7e405b5`, Part 8 DONE + new hash; totals
   cargo 548/0, clippy clean, tsc 0, vitest 664/1 skipped; NO Playwright) then
   `shutdown.exe /s /t 60 /c "RUKE overnight Parts 6-8 run finished. See rust-backend/OVERNIGHT-REPORT.md"`
   (fallback `powershell.exe -Stop-Computer -Force`). NOTHING after shutdown. NEVER Part 9/10.

---

# PART-8 LIFECYCLE CORRECTION — session segment 2026-10-27 (post-OVERNIGHT-REPORT)

### 8.1 Core objective & active phase
PART-8 FIX (not Part 9): `npm run dev` alone must BUILD + START + STOP the Rust backend
automatically. Corrected `scripts/dev-supervisor.mjs`: ports pre-checked fail-fast BEFORE any
build; `cargo build --manifest-path rust-backend/Cargo.toml` ALWAYS run as a supervised child
(always wait for completion); built `ruke-server.exe` located (CARGO_TARGET_DIR resolved against
repo root, else `rust-backend/target/debug`); bridge secret generated; ruke-server + Next spawned
as DIRECT supervised children (never `cargo run`); bounded health poll gates the banner; either
child's death or Ctrl+C/Ctrl+Break/terminal-close tears down BOTH trees, PID/tree-scoped (never
image-name kills). Status: **implementation DONE, scenario-verified A–H, gates green/adjudicated;
commit pending this segment.** Parts 9/10 NOT started; no Playwright; no golden/test mutation.

### 8.2 Locked completed tasks (do not re-read / re-do)
- `scripts/dev-supervisor.mjs` corrected lifecycle — verified by scenario harness (Temp\ruke-p8):
  A missing-binary auto-rebuild; B up-to-date incremental; C source-change rebuild (reverted, zero
  residue); D compile-failure (clear message, cargo output preserved, NOTHING started, non-zero
  exit, repo restored compilable); E teardown (CTRL_BREAK end-to-end 9/9 PASS, exit 130 captured,
  ports freed, 0 orphans); F ruke-server killed → Next terminated + ports free; G Next killed →
  Rust terminated; H port occupied → fail-fast before cargo, Next never moves to 3001.
- MIGRATION-MAP §7 supervision bullet extended + `8-fix` DONE row added (before `9–10` row).
- OVERNIGHT-REPORT §3/§5/§7 prereqs rewritten (`npm run dev` alone; no manual cargo build), §5
  signal-delivery facts appended, §8 flake note updated with ROOT CAUSE + "## 10. PART-8 LIFECYCLE
  CORRECTION" section appended. Checkpoint marker intact.
- Gates actually run: cargo test **548 passed / 0 failed exit 0**; clippy -D warnings exit 0;
  cargo check --workspace --all-targets exit 0; `npx tsc --noEmit` exit 0; vitest full suite final
  run exit 1 — **2 failed | 662 passed | 1 skipped (665)** — both failures web.test.ts, ADJUDICATED
  environmental (see 8.6), web.test standalone **5 passed (5)** green in four consecutive dedicated
  runs (incl. immediately after the red full run and on a git-stashed clean HEAD).
- Rulings R1–R15 ledger delivered in the final report (supervisor semantics, signal facts, flake
  adjudication). Zero product-behavior change: chat/search/attachments/decisions/skills/
  conversations/titles/settings/SSE/route contracts/Tier-3b untouched; `npm run dev:next` still
  pure Next (never launches Rust).

### 8.3 Graphify dependency map
- `package.json` "dev" → `scripts/dev-supervisor.mjs` (THE deliverable; no other file modified for
  the fix). Supervisor → cargo child (added to `children` set; interrupt kills exactly the
  supervisor-owned cargo/rustc/linker tree) → exe at CARGO_TARGET_DIR|repo-root-relative or
  `rust-backend/target/debug/ruke-server.exe` → env handoff (`RUKE_RUST_BACKEND=1`,
  `RUKE_PROJECT_ROOT`, `RUKE_BACKEND_PORT`, Tier-3b pair) → ruke-server child + `next dev` child →
  `lib/server/rustProxy.ts` thin-proxy topology UNCHANGED. `RUKE_SERVER_BIN` set ⇒ cargo build
  SKIPPED, exe must exist (`die` otherwise). Product modules: zero edges touched.

### 8.4 Immutable code contracts & schemas
- Supervisor exit codes: SIGINT/SIGBREAK → 130, SIGTERM → 143; first-child-exit propagates
  (clean-0 child exit ⇒ 1, ruling R3). Readiness gates: Rust `GET http://127.0.0.1:<port>/api/ruke/health`
  bounded 30 s poll; Next ready = TCP probe of its listener bounded 60 s; banner prints ONLY when
  both actually ready. Port pre-check: wildcard bind probes BEFORE cargo build (fail-fast; no
  silent 3001 fallback). `RUKE_SERVER_BIN` contract: advanced override, skips build, existence
  required. Env names unchanged. No new env vars, no route/schema changes anywhere.

### 8.5 Playwright & E2E verification state
- **NO Playwright used at any point in this segment** (brief forbids it; no
  `.ai-coordination/playwright.lock` ever created; `npx playwright test` never invoked).
- Scenario harness lives OUTSIDE the repo: `%TEMP%\ruke-p8` (sup.ps1 scenarios A/B/C/D/F/G/H/N,
  e5-driver.ps1 CTRL_BREAK E proof 9/9, consctrl.cs C# witness, gate logs). Disposable.
- All temp supervisors/ports torn down; ports 3000/3001/3101/3200/3998/3999 probed free; the
  user's pre-session :3000 TS server remains the only listener (never touched).

### 8.6 Open bugs, failing stack traces & blockers
- Vitest flake family adjudicated a 4th time, ROOT CAUSE FOUND: `web.test.ts` drift-guard failures
  (fixture 01 timeout 5002 ms, 02 first-diff) come from `[Context]` passages in fixtures 01/02/05
  rendered LIVE by the extractor's in-house browser pool (old.reddit.com login page — the scripted
  `net`/PAGES mocks do NOT cover that tier). Live content shifts BM25 digits (fixture pins 11.01;
  runs recorded 11.16 and 11.35 — different even within ONE process for identical pipelines) and
  reddit intermittently appends `- text: Server error. Try again later. - button "close error
  button"` to the ARIA snapshot. Pre-existing at HEAD (clean-HEAD stash run green; with-change run
  green minutes apart). Fix belongs in Part 10 (mock the browser tier), not here. No fixture/test
  mutated.
- Signal facts: `process.kill(pid,"SIGBREAK")` = ENOSYS; automated `CTRL_C_EVENT` UNDELIVERABLE in
  this environment (compiled C# SetConsoleCtrlHandler witness recorded `[1]` = BREAK only, across
  8+ variants); CTRL_BREAK_EVENT broadcast works end-to-end (exit 130 captured via
  `cmd /v:on /c "... & echo EXITCODE=!ERRORLEVEL!"`; PS `Start-Process .ExitCode` can be `$null`).
  Live interactive Ctrl+C is manual journey §7.7.
- Windows Defender flagged a `bash.exe -c` heredoc-embedded harness string as
  Trojan:Win32/SuspExec.SE — FALSE POSITIVE on a disposable Temp helper (command never executed);
  rule since: helper files are created via the Write tool, never heredoc-in-command.

### 8.7 Active skills & scenario locks
- No Tier-1/Tier-2 skill bodies loaded this segment.
- Supervisor internals (build/target/override/signal lines) and OVERNIGHT-REPORT/STATE anchors in
  context; do not re-read. `__tests__/rust-golden/web.test.ts` fully analyzed (428 lines) — do not
  re-read or mutate (brief).

### 8.8 Immediate next 3 atomic actions
1. COMMIT: `git add scripts/dev-supervisor.mjs rust-backend/MIGRATION-MAP.md
   rust-backend/OVERNIGHT-REPORT.md docs/STATE.md` (verify `git status --porcelain` shows nothing
   else first); message exactly `fix: auto-build Rust backend in RUKE dev supervisor` + trailer
   `Co-Authored-By: Claude Code <noreply@anthropic.com>`. No push.
2. FINAL §19 REPORT: user-workflow confirmation (`npm run dev` alone; `dev:next` untouched),
   startup/shutdown lifecycle, exact test commands + exit codes (scenarios A–H, gates incl. the
   honest exit-1 vitest run + adjudication chain), explicit no-behavior-change statement,
   rulings R1–R15, Defender false-positive note.

---

# PART-8 MANUAL-REGRESSION PROXY-CLASSIFICATION FIX — session segment 2026-10-28

### Core objective & active phase
PART-8 FIX at the USER MANUAL REGRESSION CHECKPOINT (NOT Part 9): false diagnostic during title
generation — Next logged `[rust-proxy] POST /api/ruke/conversations/<id>/title -> …: unreachable
[ResponseAborted]` while the Rust title queue was successfully generating the title (browser had
merely navigated away). Fixed failure CLASSIFICATION in `lib/server/rustProxy.ts` ONLY. Status:
**implementation DONE, gates green, §13 manual repros DONE; commit pending this segment.** The
Part-8 manual checkpoint is NOT marked passed (user approval required). Parts 9/10 untouched.

### Root cause
`rustProxy` forwards `signal: req.signal` to the upstream fetch. When the browser abandons the
request, Next's Node 26 web layer aborts `req.signal` with a `DOMException` whose name is
`ResponseAborted`; per the fetch spec undici rejects the in-flight upstream fetch with the
signal's ABORT REASON — so the proxy's single unconditional catch stamped EVERY rejection
"unreachable" + 502, including pure downstream cancellations.

### Fix & three-class classification (exact)
Two helpers + classified catch in `lib/server/rustProxy.ts` (hop-by-hop filtering,
`duplex:"half"`, `signal: req.signal` wiring all UNCHANGED):
- `isDownstreamCancellation(err, signal)`: checks `signal.aborted` FIRST (name-independent — the
  forwarded signal is the only possible aborter of the upstream fetch), then names
  `AbortError`/`ResponseAborted`. Never relies on the error name alone.
- `connectivityCode(err)`: `err.cause?.code ?? err.cause?.name ?? err.name ?? "unknown"`
  (undici puts the errno on `cause`).
- **A. downstream cancellation** ⇒ `console.debug("[rust-proxy] <METHOD> <path> -> <base>:
  cancelled by downstream client")` (low severity; the word "unreachable" NEVER used) + `204`
  (never actually delivered). Rust-side semantics keep running.
- **B. genuine connectivity failure** ⇒ Part-8 stance EXACTLY preserved:
  `console.error("… unreachable [<code>]")` + honest 502
  `{"error":"Rust backend unreachable at <base>"}`. UNKNOWN errors FAIL CLOSED into class B —
  a real Rust crash/socket failure can never be swallowed as a cancellation.
- **C. genuine Rust response** (4xx/5xx/streamed/normal) passes through untouched — the catch
  never sees those legs.
Title semantics unchanged (queue, policy, gen_count, force, persistence, MAX_ATTEMPTS=2,
timing); chat cancellation chain browser→Next→Rust→Strata keeps propagating.

### Gates (actually run; NO Playwright anywhere, no lock ever created)
`npx tsc --noEmit` exit 0; `npx vitest run __tests__/rust-proxy.test.ts __tests__/titles
__tests__/rust-golden` → 13 files / 101 passed; FULL `npx vitest run` → **64 files / 671 passed /
1 skipped / 0 failed** exit 0 (~13.8 s — web.test.ts + chatEngine.test.ts green under parallel
load THIS run; no flake adjudication needed; zero test/fixture mutations);
`cargo test --manifest-path rust-backend/Cargo.toml --workspace` → 548 passed / 0 failed exit 0;
`cargo clippy --manifest-path rust-backend/Cargo.toml --workspace --all-targets -- -D warnings`
exit 0 clean. NEW `__tests__/rust-proxy.test.ts` (7 tests) 7/7 green: real loopback HTTP (no
fetch mocks), mock Rust mirrors the real title route's accept-then-hold; dead-backend arm uses
loopback **:3**, not the Rust-side `127.0.0.1:9` convention — undici rejects WHATWG blocked
ports at parse time with a code-less "bad port" TypeError, so that convention cannot cross the
undici seam.

### §13 manual reproduction results (live supervisor `PORT=3210` `RUKE_BACKEND_PORT=3102`
`LLM_API_URL=http://127.0.0.1:8799/v1/chat/completions` model stub; Strata down; ports pre-probed
free; the user's pre-session :3000 server never listened and was never touched)
1. Title + navigate-away: `POST …/api/conversations/repro-p8/title?force=1` abandoned
   mid-generation ⇒ witness `[rust-proxy] POST /api/ruke/conversations/repro-p8/title ->
   http://127.0.0.1:3102: cancelled by downstream client`; ZERO "unreachable" lines, no false
   502. Queue survival witness: a follow-up POST answered `{"queued":true,"coalesced":true}` —
   the job was STILL alive after the client abandoned it.
2. Chat + stop midway: curl killed 2 s into a streaming turn ⇒ stub witness
   `MODEL STREAM TORN MID-STREAM after 4 tokens` + same-millisecond Rust
   `WARN … llm stream aborted by client` (chat/forward.rs); ZERO rust-proxy lines — cancellation
   propagates browser→Next→Rust→model, no false message.
3. Real backend failure: killed ONLY the supervised ruke-server (by PID) ⇒ the FIRST proxied
   request returned **502 `{"error":"Rust backend unreachable at http://127.0.0.1:3102"}`** +
   log `[rust-proxy] GET /api/ruke/conversations -> http://127.0.0.1:3102: unreachable
   [ECONNREFUSED]`; supervisor first-child-exit cascade ("ruke-server exited (1); stopping next
   dev") then all ports freed.

### Honest caveats & classified noise
- The end-to-end persisted-title-after-release cycle was NOT cleanly captured in the live
  harness: harness stub RESTARTS dropped in-flight title model calls (Rust logged
  `WARN title generation produced nothing usable` across the queue's MAX_ATTEMPTS=2 ladder) —
  harness artifact, not a product defect. The survival requirement is witnessed at queue level
  (coalescing after abandonment) and by the untouched Rust title-queue tests (green).
- Stub-garbage search-gate answers triggered the pre-existing 35 s MAIN_GATE_TIMEOUT ⇒
  rules-default plan ⇒ REAL web searches + `ruke_websearch::search_gate` "gate unreachable /
  timeout" WARN vocabulary — pre-existing websearch wording at a DIFFERENT seam, not the proxy,
  untouched by this fix; avoided afterwards with a stage-0 trivial prompt ("hi" bypasses the
  gate: zero LLM/web traffic). The ~118 s web-search turn remains OUT of scope per brief.
- Repro hygiene: `repro-p8.json` created in the user's conversation store and DELETED after the
  runs (user's 40 `c_*` conversations intact, store back to pre-session state); repo-root repro
  logs removed after evidence copy to `%TEMP%\ruke-p8-fix\`; `8-fix2` MIGRATION-MAP row added;
  OVERNIGHT-REPORT history NOT rewritten.

### Immediate next 3 atomic actions
1. COMMIT: stage ONLY `lib/server/rustProxy.ts __tests__/rust-proxy.test.ts tsconfig.tsbuildinfo
   docs/STATE.md rust-backend/MIGRATION-MAP.md`; message exactly
   `fix: distinguish Rust proxy cancellation from backend failure` + trailer
   `Co-Authored-By: Claude Code <noreply@anthropic.com>`. No push.
2. FINAL §16 REPORT: root cause / fix / title behavior / chat cancellation / real backend
   failure / tests (exact commands + counts) / product-changes statement, ending verbatim:
   `Part 8 still requires user approval. Part 9 has NOT started.`
3. Do NOT start Part 9.
3. Close verbatim: "Part 8 still awaits user manual regression. Part 9 has NOT started."
