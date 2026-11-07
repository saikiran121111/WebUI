# HANDOVER — Interactive Browser Line STOPPED (2026-11-08, user directive)

User stopped the implementation/testing of interactive-browser issues mid-cycle and
asked for this file. No further legs were run; no shutdown performed. Everything below
is evidence-backed; hypotheses are labeled as such.

## 1. Status scoreboard at stop (real results only)

| Tier | Result | Evidence |
|---|---|---|
| L1 unit/type | GREEN | vitest 117 files / 1564 passed (1 skipped file / 17 skipped); `npx tsc --noEmit` exit 0 |
| L2 model eval (MHR-G) | GREEN 16/16 | `.data/` eval logs |
| L3 acceptance (browser real-model) | GREEN 5/5 | EASY/MEDIUM/HARD/VISION ledgered; CAPPED passed with round-census proof (`round=3` WARN under `RUKE_BROWSER_MAX_TOOL_ROUNDS=3`) |
| L3 scope matrix (8 rows) | NEVER FULLY GREEN | matrix3: 3 passed + HOP failed; matrix4 (final run, exit 1): ROUTING ✓ 9.7m, RESCOPE ✘ 900s stall, 6 did not run. Ledger `.data/l3-ledger.txt` |
| MUNU-1..4, MHR-1..5, MPR-1..3 legs | NOT STARTED | queue never reached |

Program context: MHR-A..H + budget-unblock + MPR law are all shipped/committed
(through `afb49ac`). Only the interactive-browser E2E hardening below is mid-flight.

## 2. Issue ledger — interactive browser

### I1. Tab-close ownership block (FIXED in working tree, UNCOMMITTED)
`tab_close` under the human RPC identity (`turn_id:"ui"`) is refused for
model-created tabs — `can_act_on` (`rust-backend/crates/ruke-browser/src/session.rs:174-179`)
requires `created_by_turn == key` or a claim. The matrix's `sweepTabs` silently
swallowed the refusal, leaving debris that broke RESCOPE.
**Fix (test-side, correct product law untouched):** `closeTab()` helper does
claim-then-close (`browser_user_claim_tab` → `tab_close`, proven sequence via RPC
probe), and the sweep seeds a blank spare tab before closing junk (CDP window-death
guard). Product law is RIGHT — do not change `can_act_on`/TabClose.

### I2. RESCOPE negative-guard shape (FIXED in working tree, UNCOMMITTED)
`Array.find` returns `undefined`, not `null` — `toBeNull()` failed with
"Received: undefined". `tabBySuffix` now ends with `?? null`. Verified green in matrix3.

### I3. HOP row: cleanup of unmarked handoff tab (UNRESOLVED; test is brittle)
matrix3 HOP failed: the model marked only the deliverable (loqal) and skipped
`tab_mark_handoff` on zeeta → turn cleanup reaped zeeta → spec line 348
`(...)!tab_id` TypeError-crashed on the null. **The product behaved exactly per the
pw-57 two-slot mark law** (unmarked agent tabs are reaped — correct).
Working tree already hardens `HOP_PROMPT` with the explicit two-slot instruction
(lines 315-317 of the spec). Remaining brittleness: line 348 still derefs a possibly-null tab.
**Proposed fix (NOT applied):** capture zeeta's `#scope-marker` text DURING the turn
(after the Accept, before `waitTurnEnd`) — the law being tested ("the authorized hop
opens a new tab and leaves the in-scope tab intact") doesn't depend on mark-prompt
compliance, and the null-deref crash disappears. HOP's single honest rerun was spent:
matrix4 died upstream on RESCOPE before HOP ran → HOP verdict still inconclusive.

### I4. Leaked-tab masking (historical lesson)
HOP "passed" in older cycles only because a leaked tab satisfied the lookup. Any
future green must come with a tab-list/census check, not just the assertion.

### I5. RESCOPE stream stall (NEW, UNVERIFIED — top open bug)
matrix4 RESCOPE: server census shows the web-only turn routed correctly and
COMPLETED — `web_loop ... round=3 finish="stop" ms=116260`, no engine tabs
(rescope law ✓). Yet the UI "Stop generating" button stayed visible for the entire
900 000 ms window (147 polls, then page teardown). So the SSE/UI never released the
stream after the loop finished.
Ranked hypotheses (neither verified):
1. **UI stream-release stall** on a web-loop turn that follows a browser-loop turn
   in the same chat session (`session=default`, turn0 browser → turn1 web). Candidate
   for `hooks/useChat.ts` / SSE end-of-stream handling.
2. Inference latency variance (this run ROUTING took 9.7m vs ~2.5-4m usual — the
   backend was clearly degraded; a final-answer stage hanging outside the loop's
   `finish=stop` line can't be excluded from the census alone).
Single occurrence. First repro step: replay "Open http://127.0.0.1:3210/scope/quipqort
and tell me the exact text inside #scope-marker" on a panel-CLOSED chat after a
browser turn in the same chat, and watch whether the Stop button ever clears while
`dev-supervisor.out.log` already shows `web tool loop complete`.

### I6. Inference-backend variance (environment reality)
matrix4: ROUTING 9.7m (turn0 loop itself only 2.3m — queueing/first-token dominated),
RESCOPE web-loop turn 1.9m server-side. Model-driven legs need the patience
contract (below) and one honest rerun before any blame.

## 3. Product laws CONFIRMED correct — do not "fix" these
- Ownership: `TurnKey=(session_id,turn_id)`; human panel rides turn `"ui"`
  (`authority.rs:49`); claim (`browser_user_claim_tab`, no guard) is the human's
  prerogative and lets `can_act_on` pass afterwards.
- Two-slot mark law: cleanup protects ONE deliverable + ONE handoff (latest call
  wins); unmarked agent tabs reaped at end_turn.
- Web search NEVER drives the interactive browser (user rescope 2026-11-07) —
  census-proven in both matrix runs (turn1 = web_loop only, zero engine tabs).
- Off-scope hop parks a task_scope card BEFORE load; Decline blocks (DENIAL green
  in matrix3); Accept authorizes exactly one hop.
- CAPPED ending is honest ("Stopped early" chip, `agentActive` cleared).
- Budgets: quick {1,8,4} / standard {3,16,8} / deep {6,32,14}, `WEB_TOOL_MAX_ROUNDS_CAP=20`
  (`lib/web-search/tools.ts:170-173`); extract caps 24/8000/48000/8.

## 4. NEW capability requirements (user, 2026-11-08) — NOT implemented, NOT tested
The browser must handle, per user: **query multiple websites in one task; fill
multiple forms (across sites); play multiple videos; seek to a requested timestamp**.
Gap analysis at stop:
- No spec anywhere covers HTML5 video play/pause/seek. The engine's tool surface
  (`playwright_locator_*`, navigate, evaluate) has no proven media-control path —
  UNVERIFIED whether video seek is possible at all today (likely needs
  `playwright_evaluate` with `video.currentTime`, or engine-level support).
- Multi-site / multi-form is only partially exercised: MEDIUM fills ONE form on ONE
  site; HOP touches two origins sequentially. A journey that fills forms on 2+ sites
  in one turn was never written; watch the standard depth (3 rounds) budget —
  multi-site work may starve rounds.
- Multi-website reading via web search is governed by `READ_PAGE_MAX_URLS=8` and the
  budget table — multi-site lineup work now fits (budget-unblock shipped), but a
  dedicated multi-site browser spec row is missing.
**Suggested new fixtures/rows:** `/media` fixture (two `<video>` elements + seek
target), multi-form journey (same chat, two fixture sites), and census-check that
round budgets suffice or the loop says so honestly. All universal — no vocabulary
patches per standing user law.

## 5. Working tree at stop (committed? NO)
- `tests/browser-scope-matrix.spec.ts` — 3 UNCOMMITTED test-hygiene edits:
  `closeTab` claim-then-close + sweep blank-seed (I1), `tabBySuffix` `?? null` (I2),
  `HOP_PROMPT` two-slot hardening + comments (I3). Verified: ROUTING/RESCOPE/DENIAL
  green in matrix3 with these. `tsc --noEmit` exit 0.
- No application-code changes were pending; nothing was edited during any run.
- Do NOT stage: `tsconfig.tsbuildinfo`, `mcp-out/`, `test-results/`, `.data/`.

## 6. Ops contracts for resuming (validated this cycle)
- Stack: WebUI :3000 (manual dev supervisor, pid was 4516 — launcher REUSES it),
  fixture :3210, ruke-server :3101, inference :8080 (ONE slot, single owner).
- Legs: `nohup bash .data/run-leg.sh <leg> -TestFiles "<spec>" [-Grep "<title with a space>"] -AppWaitSeconds 120`
  → log `.data/l3-<leg>.log`, exit `.data/l3-<leg>.exit`; lock
  `.ai-coordination/playwright.lock` owned by launcher; Monitor-waiter pattern with
  1700s re-arm guard (detached-leg deviation from CLAUDE.md §1.3 rationale is
  documented in `docs/e2e-test-state.md`).
- Census (ground truth): strip ANSI then grep
  `.ai-coordination/dev-supervisor.out.log` for `browser_loop|web_loop|round=|finish=`.
- Timeout contract (4f489c0): turn waits 900 000; test.setTimeout 950 000 / 1 900 000 /
  2 850 000; L2 `CASE_TIMEOUT` 1 200 000.
- `powershell -Command` from bash must be SINGLE-quoted or use `-File` (env-var
  mangling killed the first CAPPED attempt).

## 7. Exact next actions if the line is resumed (in order)
1. Apply I3 during-turn zeeta probe at HOP (~line 348) — test file only.
2. Run full matrix with the working-tree spec (matrix5). If RESCOPE stalls again
   per I5 signature, that's an APP bug candidate: use the §2-I5 repro; fix stream
   release in `hooks/useChat.ts`/SSE path — never by loosening the spec.
3. Ledger each green row in `.data/l3-ledger.txt`; commit the spec fixes once the
   matrix is fully green.
4. Only then the web-journey queue: MUNU-1..4, MHR-1..5, MPR-1..3
   (`-Grep` titles: "MUNU-1 Amazon phones", "MUNU-2 Best Buy", "MUNU-3 local-area",
   "MUNU-4 AI/ML", "MHR-1 Find jobs", "MHR-2 Find apartments", "MHR-3 Research how",
   "MHR-4 Find Amul", "MHR-5 purchase request", "MPR-1/2/3" — cursor auto-rotates).
5. New §4 capability rows (multi-site, multi-form, video + timestamp) after the
   existing queue is green, with fresh fixtures under `tests/fixtures` server :3210.
6. On any model-variance failure: ONE honest rerun before touching anything.

## 8. Cycle closure note
This cycle ended EARLY by user stop directive (2026-11-08). The prior "shutdown
when 100%" instruction was NOT executed (user present; stop directive supersedes).
No shutdown performed; the dev stack (:3000/:3210/:3101) was left running.
