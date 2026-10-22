# AI-INTERNAL STATE SNAPSHOT (8-Section Deep Compaction Format)
Synced: 2026-10-22e — RECENTS CLAUDE-DESKTOP PARITY (filter-menu Delete, full-screen View-all modal, groups + unread) — IMPLEMENTED, E2E GREEN, DELIVERED.

[8.1 CORE OBJECTIVE & ACTIVE PHASE]
Latest cycle (2026-10-22e) mission was: Claude-desktop parity for the sidebar Recents
section — filter popover gains a Delete row under Status (enters select mode; header
Select icon swaps to red Trash2 while selecting), "View all" opens a full-screen Recents
modal (serif heading, Active | Shared-disabled | Archived tabs, search, Groups chip bar,
select toolbar: Pin / Move-to-group inline "Name your group"+Save panel / Mark unread /
Archive / red trash / × exit, New session, relative-time labels), plus new optional
ConversationMeta fields `group` / `unread` (sidebar + modal unread dots, Groups flyout
filter in the sidebar popup, opening an unread chat clears it). Status: IMPLEMENTED +
FULLY VERIFIED — tsc 0, vitest 573 green, Playwright recents-controls 6/6, recents-modal
5/5 (first run), conversations-crud 7/7, multi-select-delete 2/2 (all exit 0). No open
work. Prior-cycle progress-chip work stays locked. Original chip mission paragraph kept
below for contract context: reproduce the Claude-desktop "Step X of N" progress popup in the top-right
window bar — white-bordered pill chip (explicit user deviation from the reference's blue)
opening a "Progress" panel (timeline: dim done dots / bright active step with live % /
pending, overall bar, "K earlier steps" collapse, Outputs section with real artifacts) —
with 100% honest data: every label/percent from real server phase events (ruke_stage SSE),
real counters (query pools, pages x/y, coverage) and measured per-user ETAs (median
reasoningMs / completionTokens), never fake timers. Status: IMPLEMENTED + FULLY VERIFIED
(vitest 573 green, tsc clean, 3 Playwright specs green at real exit 0, incl. regression
fixed). No open work on this feature.

[8.2 LOCKED COMPLETED TASKS (DO NOT RE-READ/RE-DO)]
- 2026-10-22e Recents parity (ALL E2E GREEN, do not re-open):
  - `lib/types.ts` ConversationMeta += `group?: string`, `unread?: boolean` (round-trip
    via whole-doc JSON store, no API change).
  - `app/page.tsx`: persist meta rebuild CARRIES `group: existing?.group,
    unread: existing?.unread` (omitting them erases them on next save); handleSelect
    clears unread (save + state); `viewAllOpen` state; bulk handlers
    `applyMetaBulk(ids, mutate, bumpUpdatedAt)` = per-id GET→mutate→save then ONE
    refreshList (unread/group use bumpUpdatedAt=false); RecentsModal wired with
    handleSelect/handleNew/handleDeleteSelected + 4 bulk handlers.
  - `lib/chat/recentsFilters.ts`: `RecentsFilters.groupFilter` ("all"|name, persisted+
    validated), filterConversations honors it; `listGroups()`, `formatActivityLabel()`
    ("Just now"/"N hours ago"/"N days ago" <7d else medium date).
  - `components/ui/RecentsFilterMenu.tsx`: Delete row under Status
    (`recents-filter-delete` → onStartSelect), Groups flyout row
    (`recents-filter-row-groups`/`recents-filter-groups`) only when groups exist.
  - `components/ui/Sidebar.tsx`: collapsed header = `recents-view-all` pill (opens modal)
    + `recents-expand` chevron; expanded right group has `recents-browse` Maximize2;
    select-mode-toggle swaps SquareCheck→red Trash2 (text contract "Select"/"Cancel"/
    "Delete N" unchanged); unread dot `data-testid="unread-dot"` before title; aside
    keeps z-50 on desktop (stacking fix, locked).
  - `components/ui/RecentsModal.tsx` (~330 lines, new): `recents-modal` z-[200],
    tabs/search/chips/rows/toolbar testids — see §8.4.
  - `tests/recents-modal.spec.ts` (5 tests, new, green) +
    `tests/recents-controls.spec.ts` (6 tests incl. filter-Delete-row + collapsed-pill
    opens modal, green) + `tests/multi-select-delete.spec.ts` test 1 now seeds TWO chats
    (one row-click must not pre-satisfy select-all) and cleans both.
- `lib/types.ts`: `StageEvent {stage, detail?, mode?, ms?, done?, total?, coverage?, webCitations?, researchLfm?}` + `StreamEvent.stage?`.
- `lib/stream/parser.ts`: `ruke_stage` → `{stage}` passthrough; `ruke_error` → finishReason "error"; plain SSE untouched (additive branch).
- `app/api/chat/route.ts`: dual path — `payload.stream !== false` → ReadableStream Response
  emitting ruke_stage frames (decision_done/skill/retrieval/web:<pipeline stages>/web_meta)
  pre-first-byte then piping scrubbed upstream; inner AbortController merged with req.signal,
  `cancel(){inner.abort()}`; upstream failure → `ruke_error` frame. Legacy path keeps real
  status codes + web headers (protects conversation-title warmModel). `runTurnPipeline` shared.
- `lib/web-search/pipeline.ts` + `extractor.ts`: PipelineProgress carries counters (searching
  {total: plans}, reading {total, done per page via onPage}, gap-search/done {coverage, total passages}).
- `lib/progress/turnProgress.ts`: pure TurnProgressTracker (steps/weights WEBSEARCH 3,
  WRITING 3.5, THINKING 1.5, others 1; WEB_BAND bands lfm10/planning25/searching55/recovery65/
  reading80→(80+done/total*12 capped 92)/rerank92/gap96/done100; skipped REMOVES step;
  per-step monotonic `floor`; `overallFloor` keeps aggregate monotonic — a newly discovered
  phase must never make the bar walk backwards; active clamps 5..95; complete→100,
  error/aborted freeze at last measured; MODE_LABEL + MODE_OUTPUT + MODE_DEFAULT_CHARS tables).
- `hooks/useChat.ts`: tracker created in send() with computeBaselines(messagesRef);
  handleEvent feeds ev.stage + web_meta (sets webCitations/researchLfm exactly like the old
  header path) + stores ev.usage on the message; noteContent(len)/noteReasoningStart/End/
  openOutput on mode-fence open/setRepair; `turnProgress` React state (1 s tick + event
  driven, rAF-safe); `dismissProgress()` exposed.
- `components/ProgressChip.tsx` + TopBar `progress` slot (`ml-auto` row before {settings}) +
  app/page.tsx wiring. testids `progress-chip` (aria-expanded/aria-haspopup, white classes
  `border-[rgba(255,255,255,0.55)] text-white`) / `progress-panel` (role dialog).
  PANEL OPENS ONLY ON CHIP CLICK — auto-open REMOVED (2026-10-22d): the auto-opened 300px
  z-50 popup occluded the fresh-thread user bubble's "Edit message" button (broke
  edit-stop-collapse :124 with a 60 s click hang; also a genuine UX hazard).
- `__tests__/turn-progress.test.ts` (incl. "overall never walks backwards" regression) +
  `__tests__/sse-stage-events.test.ts` (4 parser tests).
- `tests/progress-panel.spec.ts`: 6 model-free tests via PACED ruke_stage SSE (Node http
  server on ephemeral port + route.continue — route.fulfill delivers at once, useless
  mid-stream; x-decision-mode header set; REPLY contains a VALID ```pptx fence so no repair
  round fires).
- VERIFIED THIS CYCLE (real exit codes): progress-panel 6/6 (35.6 s, PW_EXIT=0);
  edit-stop-collapse 5/5 (18.2 s, PW_EXIT=0); search-gate 3/3 (2.4 m real model traffic,
  PW_EXIT=0); vitest 573 passed | 1 skipped; tsc --noEmit EXIT=0.
- Earlier-cycle locks still hold (TopBar/Sidebar/ChatInput/ProcessingStatus/greeting/
  multi-select/conversations-crud work) — see 2026-10-22 docs entries; do not re-open.

[8.3 ACTIVE GRAPHIFY DEPENDENCY MAP]
- app/api/chat/route.ts → lib/stream/parser.ts (client) → hooks/useChat.ts →
  lib/progress/turnProgress.ts → components/ProgressChip.tsx → components/TopBar.tsx (progress slot) ← app/page.tsx.
- route.ts → lib/web-search/pipeline.ts (onProgress bridge) → extractor.ts onPage counter.
- web_meta stage → useChat message.webCitations/researchLfm → ResearchTrailCard (search-gate.spec guards).
- ProgressChip dismiss → page.tsx dismissProgress → useChat.turnProgress=null (chip hides).
- tests/progress-panel.spec + edit-stop-collapse.spec + search-gate.spec → the three changed surfaces.
- 2026-10-22e Recents graph: app/page.tsx → components/ui/Sidebar.tsx (onViewAll,
  filterMenu{groupNames,onStartSelect}) → RecentsFilterMenu.tsx; app/page.tsx →
  RecentsModal.tsx → lib/chat/recentsFilters.ts (listGroups/formatActivityLabel) ←
  lib/types.ts (meta group/unread); page bulk handlers → lib/persistence
  (getConversation/saveConversation); specs recents-controls/recents-modal →
  testids recents-* + conversation-item + confirm-dialog-confirm.

[8.4 IMMUTABLE CODE CONTRACTS & SCHEMAS]
- SSE stage envelope: `data: {"ruke_stage":{...StageEvent}}\n\n` before first upstream byte;
  `data: {"ruke_error":{"message":...}}` on upstream failure; `data: [DONE]` always last.
- Chip label: "Step {activeIdx+1} of {n}" running; "Done"/"Stopped"/"Failed" terminal.
- Panel contract: testids progress-chip/progress-panel; X aria-label "Close progress";
  overall row is the FIRST `.tabular-nums` in the panel (per-step % come after);
  closePanel: running→panel only, terminal→dismiss chip too.
- White chip (user requirement): border rgba(255,255,255,0.55), text white — NEVER blue.
- Chat route dual path: stream!==false → stage-channel Response; stream===false → legacy
  headers/status (title-gen warmModel depends on it).
- Sidebar menu = plain buttons (no ARIA roles); ConfirmDialog "Delete conversation?";
  hero placeholder "How can I help you today?", bar placeholder "Reply"; testids
  send-button/file-input/attachment-chip/conversation-item/select-mode-toggle intact.
- Recents parity contracts: ConversationMeta `group?: string` / `unread?: boolean`;
  RecentsFilters `groupFilter` (persisted). Modal testids: recents-modal /
  recents-tab-active|archived / recents-modal-search|-select|-new|-close /
  recents-modal-select-all / recents-modal-bulk-pin|-group|-unread|-archive|-delete /
  recents-modal-exit-select / recents-modal-move-panel / recents-modal-group-name /
  recents-modal-group-save / recents-modal-move-remove / recents-group-chip-all /
  recents-group-chip-{name} / recents-modal-row / recents-modal-unread-dot.
  Sidebar: recents-view-all / recents-expand / recents-browse / unread-dot.
  Z-layers: aside z-50 (desktop), modal z-[200], ConfirmDialog z-[999] (above modal).
- Lock file `.ai-coordination/playwright.lock`; no npm test:e2e — real command
  `npx playwright test <specs>` (baseURL :3000, workers:1, headless:false, slowMo 300,
  PLAYWRIGHT_BROWSERS_PATH=.data/ms-playwright). Bash foreground runs are capped at 600 s —
  run specs ONE FILE PER CALL under a single lock; capture `${PIPESTATUS[0]}` (plain
  `| tail` swallows the exit code).

[8.5 PLAYWRIGHT & E2E VERIFICATION STATE]
- Dev server on :3000 (node PID observed 10304 this session; restart one-liner in
  docs/e2e-test-state.md). All Recents specs green at exit 0 (see 8.2);
  recents-controls 6/6, recents-modal 5/5, conversations-crud 7/7,
  multi-select-delete 2/2 (2026-10-22e). No playwright-cli sessions left open.
- Lock released (rm after each session). Store holds many conversations incl. real ones — do not wipe.
- Mock-SSE pattern for future progress specs: paced http upstream + route.continue (NOT
  route.fulfill); readingDelay override widens the reading window for label asserts.

[8.6 OPEN BUGS, FAILING STACK TRACES & BLOCKERS]
- None open. Resolved 2026-10-22e: multi-select-delete test 1 failed on
  `Delete ${total}` after the select-all click — store was empty + single seed → the
  one row-click already satisfied select-all so the click DESELECTED. Fix: seed TWO
  chats (+cleanup both) → 2/2 green. Resolved earlier (2026-10-22d): (a) overall % regressed 60→33 when the weight-3 websearch
  step opened at band 10 → overallFloor (unit test added); (b) auto-opened panel occluded
  the user bubble Edit button → edit-stop-collapse :124 click hang (60 s timeout) → removed
  auto-open, spec updated to click-to-open, re-run green.
- Not run wholesale: other specs (skills/studio/cad/...) don't exercise changed surfaces;
  ProgressChip is inert unless turnProgress is set and no longer auto-shows, so overlay
  interference with other specs is now impossible.

[8.7 ACTIVE SKILLS & SCENARIO LOCKS]
- None loaded this session (Playwright via npx + project config directly). Tier 2 untouched.

[8.8 IMMEDIATE NEXT 3 ATOMIC ACTIONS]
1. DONE — Recents parity delivered; all four specs green; docs/state.md +
  docs/e2e-test-state.md synced (2026-10-22e).
2. §4 completion report delivered to the user (this session).
3. Optional follow-ups ONLY IF USER ASKS: commit the uncommitted Recents work (git
  status shows app/page.tsx, SettingsMenu/TopBar/Sidebar/ui files, lib/types.ts +
  new RecentsModal/RecentsFilterMenu/recentsFilters + 4 specs; stage selectively —
  SettingsMenu/TopBar carry PRE-EXISTING unrelated edits), Shared-tab real
  implementation when sharing exists, bulk-archive e2e coverage (handler wired,
  untested in modal).
