# P7 Closure Handover — Ruke Plan COMPLETE (2026-11-07)

Completion report per CLAUDE.md §4. Audit baseline `5fb34ffadaa0f9169990f2783aafd0d7ebbb3934` → final HEAD
(this cycle's docs commit, stacked on `3296724`). Phases P0→P7 of `plan/ruke-implementation-checklist.md`
are ALL checked; the checklist itself carries the exact per-gate commands + real exit codes.

## 1. Changes made (this closing cycle)

Product code (each root-caused from a locked-loop failure, each with regression coverage):
- `app/page.tsx` (`cfea00e`) — REAL BUG: `getBrowserSession` fallback `"default"` keyed turn 1 of EVERY new
  chat into one shared `default.research.json` journal (24 polluted turns observed) → cross-chat
  rehydration replayed foreign queries into fresh first turns. Fix: lazily mint the real `c_` uid on first
  send so document, journal, and panel share one key; poisoned runtime journal deleted.
- `components/ChatMessage.tsx` + `components/ProcessingStatus.tsx` (`cfea00e`) — REAL DEFECT: the
  `ProcessingStatus` mount gate (`streaming && !content && !reasoning`) can NEVER coincide with MHR
  citations (CoT streams before web rounds; WS06 narration releases content before `web:tools`) → the
  web-search toggle / research-trail card was unreachable on every fresh model-directed chat. Fix: mount
  while streaming once `webCitations` exist (or during the classic first-token wait); `React.memo` law
  (§5.3) untouched.
- `lib/documents/pptxIds.ts` + pptxEngine integration (`82f7c20`) — `ensureUniqueShapeIds(Buffer)`
  renumbers each slide's `<p:cNvPr id>` by document order: PptxGenJS 4.0.1 numbers table/chart graphic
  frames from a PER-TYPE counter, so mixed slides shipped duplicate shape ids = invalid OOXML →
  PowerPoint repair prompt AND the repo's own office-kit `validatePresentation` gate threw → the Download
  button rendered an error alert instead of downloading (hardens EVERY export, motion or not). Also
  strips a model-authored trailing ".pptx" so extensions never double. Regression:
  `__tests__/documents/pptxIds.test.ts` (3 tests incl. upstream-defect retirement pin).
- Anatomy removal (`50bfb30`, user amendment "Remove anatomy entirely") — RendererMode parity 8→7;
  saved ```anatomy fences render the read-only RetiredFenceBlock compat card; 3 Playwright specs +
  6 unit suites + `lib/anatomy/**` + `api/anatomy/export` + `.cskills/anatomy` deleted via the approved
  compat path (inventory 41→38 specs).
- Test-side only: `tests/tier3b-live.spec.ts` redesign (`3296724`) — human-authority pre-open journey,
  two-signal proof (engine DOM + unguessable LATE_MARKER quoted); `tests/search-gate.spec.ts` MHR
  contract pins (`cfea00e`); bounded "reply with exactly:" turn prompts (`92f32bc`) + patience raised to
  measured CPU latency (`a3b4a78`).

## 2. Playwright results (the ONE final locked loop, fix-rerun until green)

Launcher: `powershell -NoProfile -ExecutionPolicy Bypass -Command "& scripts\run-browser-e2e-exclusive.ps1
-TestFiles '…' -AppWaitSeconds 300"` (acquires+releases `.ai-coordination/playwright.lock`; warm-stack
reuse :3000/:3210). Heavy specs split into `-Grep` legs sized under the 600 s shell ceiling. ALL runs
below are real, foreground, PW_EXIT=0 unless stated. Full ledger: `docs/e2e-test-state.md`
§§"P7 final loop…", "P7 post-removal loop…", "P7 loop cont'd…", "P7 loop CLOSED", "P7 loop closure
correction".

- decision-routing + render + interactive-ui → 24 passed / 1 skipped (pre-existing `render.spec.ts:710` design skip)
- settings-stats, skills, search-gate, form-probe, abort-family → green (search-gate 3/3 after the three-layer fix)
- long-doc-retrieval → 3/3 ("Verdanthill-42" deep-marker recall, both turns)
- greeting + browser-easy/medium/hard + scope-matrix → 20/20
- pptx-5a → 4/4: data-heavy deck **3,560,752 B / 11 slides / native chart2.xml+chart3.xml / tier=insane /
  morph×9+fade×2 with plan↔file motion parity** (4.0 m); simple deck 86,819 B / 3 slides / zero motion
- web-search-10k → 4 `WEB_SEARCH_10K_RANGE` legs (0-24 / 25-49 / 50-74 / 75-99), deterministic acquisition
  assertion passed each; honest advisory NOs where WAFs blocked clearance; run blocks appended to
  `docs/web-search-10k-report.md`
- youtube-captions → 1/1 · tier3b-live → 1/1 (30.7 s, after two recorded honest fails + redesign)
- browser-model-acceptance → 5/5 solo legs (EASY 38.0 s / MEDIUM 46.2 s / HARD 38.3 s / VISION 1.5 m / CAPPED 1.3 m)
- universal-websites → 15/15 in five 3-case legs (three-branch proof law: freshRead / honestFailure / evidenceGap)
- file-reading → **215/215** in 13 manifest-verified disjoint legs: extraction 106/106; model half 106/106
  (~7-12 s/turn, reasoning-effort-Off toggle; audio codeword "Zephyr" quoted on all six containers;
  burned-frame markers on all seven video containers); 3 documented-skip tests pass (rar/heic/heif)
- **Closure-correction battery** (the 14 specs whose batch greens predated `cfea00e` — see §3):
  F1 conversations-crud+multi-select-delete+edit-stop-collapse+recents-controls+recents-modal+progress-panel+
  token-meter+auto-compact+retired-fences → **39 passed (2.8 m)**; F2 conversation-title+conversations-live-chat
  → **7 passed (39.3 s)** (live-chat specs green INSIDE the loop for the first time; the 2026-11-04
  hero-panel-layout suspect did not reproduce); F3 chat-stream+reasoning-test+inspect-dup → **4 passed (31.4 s)**.
- Offline gates (exact commands + codes in the checklist P7 box): tsc 0; full vitest 116 files /
  **1,559 passed / 9 skipped** exit 0; `cargo test --workspace` 0 failed; `contracts:check` 0 (7 modes);
  `next build` 0 with 0 anatomy chunks; xlcalc ships ONLY in on-demand chunk `1981.*.js` (First-Load 91.9 kB).

**Post-correction audit: all 38 Playwright specs green against final HEAD, each green post-dating the
latest product-code change relevant to it.** (B4-era regression_modalities / html-isolation / pdf-egress:
35p/3 skips pre-removal; the removal did not touch their surfaces, and html-isolation additionally
carries the finding-6 proof.)

## 3. Failures & honest interruptions (all recorded, all resolved or explained)

- tier3b-live legs 1-2 (PW_EXIT=1): (a) toscrape "first quote" parametrically guessable — no browser turn
  armed, two-signal law correctly failed it; (b) model-issued loopback navigation STRUCTURALLY FORBIDDEN
  (SSRF `unsafe_destination` + task-scope law) — product security as designed; model itself refused alias
  evasion. Redesign (human-authority pre-open) → green first try. No product change.
- search-gate test 3 (PW_EXIT=1) → three layers: dead gate-era badge contract (spec pin fixed WITHOUT
  weakening — badge-ABSENCE pin added), then the two REAL product bugs in §1. Runs A/B failed honestly
  per layer; run C 3/3.
- pptx-5a explainer Download timeout → duplicate-cNvPr root cause (§1), re-run green with motion parity.
- B3-era live-turn budget failures → measured 30-49 tk/s CPU latency + IQ3_S open-ended CoT runaways
  (240 s still reasoning, ctx 11.4k→20.3k) → `a3b4a78` + `92f32bc`, re-run green.
- Ops slips recorded honestly: one combined leg SIGTERM-killed at the 600 s Bash ceiling (PW_EXIT=143,
  orphan lock removed per protocol, result NEVER claimed); the full `scripts/playwright-10k-audit.ts`
  launched by mistake (briefly) and killed — report pollution verified ZERO by header forensics (never
  run it bare; no aggregator exists); file-reading `cs` alternation prefix-matched csv (one double
  attempt, both passes — caught by the partition audit; no other re-runs).
- Closure audit slip (this file's reason to exist): the first "FULLY GREEN" claim inherited 14
  pre-removal/pre-`cfea00e` batch greens; caught same-day, corrected by the F1/F2/F3 battery — all passed.

## 4. Old-vs-new browser path comparison (same tasks)

1. **JS-only page read + dynamic content quoted** (tier3b's task): OLD = TS agentBrowser tier behind
   `Open <url>` via `/api/internal/browser-read` — obsolete under the task-scope law; model-issued
   loopback opens are blocked by the SSRF guard. NEW = human-authority arming (`never_ask` policy PUT +
   engine-RPC pre-opened tab) + browser turn READS the already-open tab, proved by two signals (engine
   innerText carries the JS-appended node; model quotes the unguessable LATE_MARKER). Evidence: both old
   journey legs failed as designed (recorded); new journey 1/1 in 30.7 s.
2. **Fresh chat with a web-search turn** (search-gate task): OLD = gate-era model-gated flow — shared
   `"default"` journal (cross-chat leak), trail mount gate unreachable under MHR, popup carried query
   lines. NEW = per-chat `c_` journals (subject-anchored queries proven), trail mounted alongside
   streamed text, hostname-only popup. Evidence: run A/B failures vs run C 3/3; `greeting` 20/20 batch
   re-proves the toggle contract.
3. **PPTX generation through the normalizer** (finding 8 + 5A): OLD = duplicate shape ids → invalid
   OOXML → download error alert. NEW = `ensureUniqueShapeIds` + office-kit motion tiers → 3.56 MB
   data-heavy deck validates clean with native charts and morph parity; simple decks byte-identical.
4. **Interactive browser journeys** (`Open <site> and do X`): OLD CAPPED leg (2026-10-31/11-04 era) vs
   NEW full acceptance suite EASY/MEDIUM/HARD/VISION/CAPPED 5/5 — human-armed policy, model fills/forms/
   opens tabs/reads screenshots, round-budget "Stopped early" contract real.

## 5. Remaining work / open gates (honest)

- `integrations/libreoffice/` + `integrations/docling/` provider dirs intentionally empty: the LibreOffice
  install was CANCELLED by the user's 2026-11-06 scope amendment ("scoped to the WebUI repository… ask
  before system-wide changes"). Docling/MarkItDown-heavy paths remain repo-side only.
- "Opens correctly in Power BI Desktop" NOT assertable here (Desktop not installed; structural gate is
  the enforced approximation — never overclaimed).
- `.rar/.heic/.heif` are documented-skip tests by design (no decoder on a 16 GB no-GPU laptop budget).
- Model content variance is mitigated (bounded prompts, deterministic acquisition assertions, three-branch
  proof law) but never eliminated — advisory verdicts stay advisory by design.
- Platform coverage: every browser result above was verified on this Windows 11 host; macOS/Linux support
  is code-level (paths/scripts/docs cross-platform), not hardware-verified.
- Machine state per the governing amendment: **LEFT RUNNING** (never `shutdown`); warm dev stack
  (:3000 app, :3210 fixture, :3101 ruke-server, :8080 model) still live; Playwright lock free.
  `handover/2026-11-06-ruke-plan-handover.md` is historical context including its superseded shutdown line.
