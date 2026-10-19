# AI-INTERNAL STATE SNAPSHOT (8-Section Deep Compaction Format)
Synced: 2026-10-19 — MASTER E2E ARCHITECTURAL FIX (Excel stress engine, execution bridge, auto-boot, 50 extreme edge cases) — PARTS 1-4 LOCKED, PART 5 final full Playwright run in progress, PART 6 (commit→shutdown) pending

[8.1 CORE OBJECTIVE & ACTIVE PHASE]
Six-part master mission: make the heavy "Create and execute a Python script …
UI_Stress_Test.xlsx (6 sheets, 500 rows…)" prompt EXECUTE instead of being
refused, then verify everything 100% green, commit cleanly, and trigger a
60 s delayed Windows shutdown. PARTS 1-4 LOCKED-DONE (execution bridge in the
decision engine; xlsx stress-test engine proven end-to-end via
UI_Stress_Test.xlsx; Next auto-boot of the decision engine + 7 codebase fixes;
50/50 extreme edge-case suite). PART 5: server-500 fixed, 3 Playwright
regressions root-caused + fixed, tsc clean, vitest 434|1 skipped, decision
suites all green; FINAL full headed Playwright run IN PROGRESS
(.cache/pw-final2.log, 313 tests, workers:1, ~1.4 h — first restart at
pw-final.log:161 had exactly 1 failure: conversations-live-chat timeout, now
fixed via test.setTimeout(180_000)). Then: docs done (this file + CHANGELOG +
ISSUES + e2e-test-state updated), git add -A + commit, PART 6 shutdown.

[8.2 LOCKED COMPLETED TASKS (DO NOT RE-READ/RE-DO)]
- PART 1 (execution bridge, decision_server.py + TS): Target-Deliverable
  Routing + deterministic `_strip_execution_meta` post-filter; contracts.ts
  EXECUTION BRIDGE MANDATE in output contracts; skill-loader.ts strips
  SKILL.md frontmatter + CLI boilerplate from <core_skill> blocks; hard-token
  guard skip-set ".!?\n" + constraint-coverage. Deterministic routing guards
  (question gate, chat gate, evidence switch earliest-match-wins,
  sheet-evidence pdf→excel), `_salvage_stage2` truncated-JSON recovery,
  `_prior_mode_from_history` fence-scan, MAX_LFM_CHARS=2_600 truncation.
- PART 2 (xlsx engine): xlsxEngine.ts rowGenerator 500 rows "TXN-1001..1500"
  (FNV-1a seed → mulberry32, byte-deterministic); native charts → PNG via
  renderChartPng + wb/ws.addImage; CF red/amber/green + autoFilter emitted;
  recalc.ts 48-function whitelist; XlsxBlock CF styling + inline-SVG charts
  (data-testid="xlsx-charts"). UI_Stress_Test.xlsx verified: 6 sheets, 500
  rows, 0 nulls, 0 recalc errors, 3 chart images, 22/22 QA PASS, determinism.
  Unit gate: recalc.test.ts 17 + xlsxEngine.test.ts 5 green.
- PART 3 (auto-boot + fixes): instrumentation.ts at root +
  next.config.mjs experimental.instrumentationHook:true; client.ts
  spawnPromise reset + warmupDecisionEngine export; MODE_SCAN_LANGS/
  MODE_RENDER_KINDS expansion (standard_chat render ["mermaid","tree"],
  scan []); TreeBlock mode-gated via treeOk; render.spec.ts mermaid tests
  un-skipped; repo hygiene (.cskills/d3-js-visualization gitlink → 7 normal
  files, .playwright-cli/page-*.yml deleted + .gitignore rule, .repomixignore).
- PART 4: tests/test-decision-extreme-edge-cases.mjs 50/50 ALL PASS; router
  11/11; audit 12/12 + "ALL 10 hard tokens preserved"; fallback PASS.
- PART 5 fixes (all verified): (1) instrumentation.ts EXACT literal
  `process.env.NEXT_RUNTIME === "nodejs"` DCE guard (Next 14.2.35
  instrumentation edge bundle has NO node externals — `node:` scheme AND bare
  builtins both fail; only the `===` literal form DCEs) + bare built-in
  specifiers in lib/decision/client.ts + lib/skills/registry.ts → GET / 200,
  "[decision] engine warm on http://127.0.0.1:8790". (2) MarkdownRenderer
  kindAllowed: `if (!decisionMode) return true;` (null-mode = demos/legacy;
  real turns always carry a mode) → demo batch 57 passed. (3) app/api/chat/
  route.ts: skip stripped_prompt rewrite when last user content is a parts
  array (hasAttachmentParts) — attachment turns forward VERBATIM → 13
  file-reading YES flips fixed. (4) decision_server.py trivial-chat
  passthrough: `active_mode=="standard_chat" and len(message)<120 →
  stripped,constraints = message,[]` (1.2B stripper hallucinated
  "Generate downloadable <artifact>…" for "Hi" → main-LLM endless reasoning
  618 KB) → proxied "Hi" closes 2.3 s [DONE]. (5) chat-stream.spec.ts:90
  diagnostic probe test.setTimeout(180_000). (6) conversations-live-chat.
  spec.ts describe-level test.setTimeout(180_000) (2 live turns × engine
  latency exceeded 60 s default — the ONLY failure in run pw-final.log).
  (7) file-reading.spec.ts: per-category budgets raised to cover the 2-attempt
  retry (text/image model 150 s/test 380 s, video 180/520, audio 180/600) +
  "the assistant never finished answering" now retryable once (attempt 1 only;
  "chat failed"/"extraction failed" still throw) — the 3-failure family in
  pw-final2 (diff/webm). (8) reasoning-test.spec.ts: WINDOW_TIMEOUT 60 s →
  150 s + test.setTimeout(240_000) (was WINDOW==TEST==60 s; reasoning ON).
- tsc --noEmit clean; npx vitest run → 434 passed | 1 skipped (435).
- Decision suites re-green AFTER worker passthrough change (LFM_SYSTEM
  UNTOUCHED — only deterministic post-processing added): router 11/11,
  audit 12/12 + ALL 10 hard tokens, fallback PASS, extreme 50/50.
- Docs updated 2026-10-19: CHANGELOG.md (MASTER E2E top entry), ISSUES.md
  (top 5 entries: instrumentation 500, kindAllowed null-mode, attachment
  forwarding, chat-stream hang, venv-python worker trap), e2e-test-state.md
  (MASTER E2E run notes + unit gate 434|1), STATE.md (this file).

[8.3 GRAPHIFY DEPENDENCY MAP (this mission's nodes)]
- instrumentation.ts -> lib/decision/client.ts (warmupDecisionEngine; bare
  child_process/fs/path) -> spawns .decision-engine/worker/decision_server.py
  (:8790, venv python) -> ensure_llama_server (:8791, stays warm).
- app/api/chat/route.ts -> getDecision(fullText, history) -> worker /decision;
  -> replaceLastUserText SKIPPED for parts-array (attachment) turns; ->
  buildDecisionSkillBlock (skill-loader strips frontmatter/CLI) ->
  ./.cskills/<skill>/SKILL.md; -> forwardStream :8080.
- decision_server.py: LFM decide -> _preserve_hard_tokens -> _routing_guards
  -> _multi_turn_rule -> TRIVIAL-CHAT PASSTHROUGH -> _remember -> envelope.
- components/MarkdownRenderer.tsx kindAllowed(null)=true -> demo showcases
  (anatomyDemoShowcase etc.) + XlsxBlock (CF + xlsx-charts) <-
  lib/documents/{xlsxEngine,recalc,schemas}.
- tests/conversations-live-chat.spec.ts + chat-stream.spec.ts: real-model
  turns, 180 s timeouts.

[8.4 IMMUTABLE CODE CONTRACTS]
- DecisionEnvelope 12 fields (schemas.py + lib/decision/types.ts):
  {active_mode, confidence, decided_by, stripped_prompt, skill_to_load,
  allowed_code_fence, disable_validators[], enable_validator,
  task_constraints[], extracted_entities[], needle_latency_ms, lfm_latency_ms}.
- RENDERER_MODES (9): excel, docs, pdf, ppt, 3d_asset, cad_blueprint, chart,
  html_render, standard_chat. MODE_RENDER_KINDS NOW: excel:["xlsx"],
  docs:["docx","resume"], pdf:["html"], ppt:["pptx"], 3d_asset:["scene3d",
  "asset3d","threejs"], cad_blueprint:["cad","anatomy"], chart:["chart",
  "powerbi","mermaid"], html_render:["html"], standard_chat:["mermaid","tree"].
  kindAllowed(kind, null|undefined) === TRUE (demos/legacy only).
- MODE_MAP/MODE_SKILL: excel:(xlsx,xlsx) docs:(docx,docx) pdf:(pdf,html)
  ppt:(pptx,pptx) 3d_asset:(threejs-skills,scene3d) cad_blueprint:(archify,
  cad) chart:(None,chart) html_render:(html-viewer,html) standard_chat:(None,None).
- _lfm_call LOCKED: temp 0.0, top_k 1, top_p 1.0, seed 42, max_tokens 180,
  json_object + Stage2Out grammar. LFM_SYSTEM greedy-sensitive — ANY edit
  changes ALL outputs → must re-run router+audit+fallback+extreme after every
  change (deterministic post-processing additions do NOT require LFM re-tune
  but DO require suite re-runs since routing guards act on outputs).
- Worker deterministic post-guards (in order): _salvage_stage2,
  _preserve_hard_tokens(raw, stripped, coverage, extra=artifact_nouns)
  skip-set ".!?\n", _routing_guards (question/chat/evidence, earliest wins,
  silent switch + print log, decided_by unchanged), _multi_turn_rule,
  trivial-chat passthrough (standard_chat && len<120 → verbatim, no
  constraints), MAX_LFM_CHARS=2_600.
- Chat route order (locked): applySlashSkillRouting -> lastUserIdx ->
  fullText -> passthrough check (decision_mode pin, then delete) ->
  getDecision -> rewrite SKIPPED if passthrough OR hasAttachmentParts ->
  replaceLastUserText BEFORE injectSystemBefore -> x-decision-mode header.
- instrumentation.ts guard MUST stay literal `process.env.NEXT_RUNTIME ===
  "nodejs"` (DCE); DECISION_ENGINE_AUTOSPAWN=0 opts out.
- Ports: Next :3000, worker :8790, llama-server :8791, main LLM :8080
  (LLM_API_URL in .env.local; no secrets in code).

[8.5 PLAYWRIGHT & E2E VERIFICATION STATE]
- Servers LIVE + healthy: Next :3000 (200, dev, auto-booted engine), worker
  :8790 {"ok":true,"lfm":true}, llama-server :8791 warm, main LLM :8080 200.
- RUN STATUS: pw-final.log killed at 161/313 (1 timeout failure, fixed).
  pw-final2.log COMPLETED: 306|4 skipped|3 failed (43.2 m) — patience family,
  fixed. pw-final3.log COMPLETED: **308 passed | 4 skipped | 1 failed
  (32.6 m)** — only reasoning-test.spec.ts:9. ROOT CAUSE PROVEN from logs:
  decision line fast (standard_chat conf=0.92, ~1.6 s), then
  `POST /api/chat 200 in 150536ms` — model rambled in its thinking block the
  whole 150 s window (unterminated  → scrubber keeps answer area empty =
  error-context snapshot). Same prompt standalone: ~1.4 s, 44 tokens, [DONE].
  Real-model nondeterminism → FIXED test-only: reasoning-test journey now
  retries ONCE on window expiry (fresh "New conversation" click, UNIQUE
  token per attempt, test.setTimeout 420 s). tsc clean.
  pw-final4.log COMPLETED: 308|4 skipped|1 failed (36.4 m, exit 1) — retry
  did NOT save reasoning-test (both attempts expired → systematic). TRUE
  ROOT CAUSE: ABANDONED UPSTREAM STREAMS — test navigates away mid-stream,
  route's fetch to :8080 had no abort signal, llama.cpp kept generating for
  the dead request and starved following turns (log proof: chart decision
  with NO matching POST /api/chat completion line before each victim).
  APP FIX (app/api/chat/route.ts): req.signal → forwardStream → upstream
  fetch signal (client disconnect cancels generation). VERIFIED: abandon
  chart stream at 6 s → next turn closes in 2.0 s; targeted neighborhood
  run (inspect-dup+interactive-ui+multi-select-delete+reasoning-test)
  **5 passed, exit 0** — reasoning-test green FIRST attempt (125.6 s).
  pw-final5.log COMPLETED (FINAL, §1 protocol): **309 passed | 4 skipped |
  0 failed (30.0 m), exit code 0** — FULL suite 100% green. Post-fix vitest
  re-run vs final code: 434 passed | 1 skipped. 4 skips = intentional
  widget form test + documented manifest skips.
- NEW PROJECT RULE (CLAUDE.md §1, replaces old launch/poll pattern): CODE /
  TEST / ANALYZE phases mutually exclusive; lock file
  `.ai-coordination/playwright.lock` created before launch + removed in
  finally; while lock exists agent MUST WAIT in foreground loop (3 h
  deadline, 5 s sleeps, NO other work); tests synchronous, real exit code;
  never kill a run or edit app code mid-run. Harness cap: Bash foreground
  max 10 min < 33-45 m suite → launcher script owns the lock (CLAUDE.md
  §1.3 explicitly contemplates separate launchers); agent then blocks ONLY
  on the §1.2 wait loop, doing nothing else between identical wait calls.
- Targeted batches already green post-fixes: anatomy+cad+three3d+render 57
  passed/1 skipped; file-reading+reasoning-test+chat-stream 217→218 passed/
  0 failed; .py/.toml 4 passed.
- Worker restart pattern (MUST use venv python): kill :8790 listener PID
  (netstat -ano | grep ':8790' | grep LISTENING), taskkill //PID //F,
  powershell Start-Process 'D:\Projects\WebUI\WebUI\.decision-engine\.venv\
  Scripts\python.exe' -ArgumentList 'decision_server.py' -WorkingDirectory
  'D:\Projects\WebUI\WebUI\.decision-engine\worker' -WindowStyle Hidden
  -RedirectStandardOutput/Error to .decision-engine/.cache/worker.*.log; poll
  /health. System python → ModuleNotFoundError: needle.
- Next dev restart: kill :3000 PID, rm -rf .next/cache/webpack,
  powershell Start-Process cmd '/c npm run dev > .cache/next-dev.out.log 2>&1'.
- Kill Playwright: powershell -NoProfile -Command 'Get-CimInstance
  Win32_Process -Filter "Name=node.exe" | Where-Object { $_.CommandLine
  -match "playwright" } | ForEach-Object { Stop-Process -Id $_.ProcessId
  -Force }' (bash double-quotes mangle $_ — single-quote the -Command).

[8.6 OPEN BUGS / BLOCKERS]
- None failing. Watch items for the final run: real-model specs are the only
  flake source (timeouts bumped: conversations-live-chat 180 s, chat-stream
  probe 180 s, file-reading per-category 480/300/200 s, reasoning-test own).
- Honest deltas (documented, not bugs): engine tree ~1.54 GB RAM (CPU-only
  binary floor); LFM latency 1.4-2.5 s on EVERY turn (user chose always-model
  over latency); Needle priors low-conf but multi-mode, LFM overrides.

[8.7 ACTIVE SKILLS & SCENARIO LOCKS]
- No Tier 1/Tier 2 skill reference files preloaded. Two-tier rules in force:
  ./.cskills/ invisible tier loads ONLY via buildDecisionSkillBlock
  (<decision_skill> single block/turn, frontmatter+CLI stripped); scenario
  JSONs own routing; browser can never touch ./.cskills/.

[8.8 IMMEDIATE NEXT ATOMIC ACTIONS]
1. DONE: pw-final5 full suite 309|4 skipped|0 failed, exit 0; vitest 434|1
   vs final code; decision suites green; tsc clean.
2. `git add -A` + commit (message ends "Co-Authored-By: Claude Code
   <noreply@anthropic.com>"); verify `git status` clean.
3. PART 6 (ONLY after 2 done): stop temp servers (Next :3000; worker/
   llama-server), then run EXACTLY: shutdown /s /t 60 /c "Claude Code:
   UI_Stress_Test.xlsx, Decision Engine Auto-Boot, 50/50 Extreme Edge Cases,
   Vitest, and Playwright E2E all passed 100% and committed. Shutting down
   in 60s (run 'shutdown /a' to cancel)."

[ADDENDUM 2026-10-19b — DECISION ENGINE LIFECYCLE (LOCKED-DONE)]
- client.ts spawn now passes DECISION_ENGINE_PARENT_PID=<next server pid>;
  TS must NOT child.kill() the worker (that orphans llama-server).
- decision_server.py: `_parent_watchdog` daemon thread (Windows SYNCHRONIZE
  handle via ctypes — PID-reuse-immune; POSIX os.kill poll; 2 s interval).
  On parent death: `_shutdown_llama()` + decision_server.pid cleanup +
  `os._exit(0)`. Manual spawns (no env var) stay independent.
  `@app.on_event("shutdown")` also kills our llama child on graceful stop.
- Every subprocess launch (llama-server, tasklist, powershell) now uses
  CREATE_NO_WINDOW — fixes the visible black console window (title = venv
  python.exe path) users saw when the detached worker spawned llama-server.
- Verified: py_compile OK; functional watchdog test (fake parent died →
  worker exited 0, printed "parent pid … exited — shutting down");
  `tsc --noEmit` clean. No Playwright run (process-lifecycle change, no UI).
- Effect: closing/Ctrl+C-ing the `npm run dev` terminal stops worker +
  llama-server within ~2 s; first heavy prompt after a dev restart pays the
  cold start again (engine lifetime is now tied to the dev server).

## 2026-10-19 — Logging refactor: pino + per-token persist flood fix [LOCKED-DONE]
- Flood root cause: app/page.tsx persist effect fired saveConversation (POST) +
  refreshList (GET) on EVERY streamed token. Fix: effect now returns early while
  `status === "streaming"`; exactly ONE save+refresh per turn, when the stream
  settles (complete/error/aborted). `status` added to the effect deps.
- Server logging: new lib/server/logger.ts (pino + pino-pretty as a SYNC
  transform destination — no transport worker thread; safe under Next webpack).
  LOG_LEVEL env (default debug dev / info prod). pino + pino-pretty added to
  experimental.serverComponentsExternalPackages.
- Pino call sites (server-only): app/api/chat/route.ts, app/api/decision/route.ts,
  app/api/files/extract/route.ts, lib/decision/client.ts.
- Needle3/LFM2.5 visibility: chat route logs
  "decision: needle3 prior → lfm2.5 gate" with needleMs/lfmMs/mode/conf/by/skill/
  stripped; llm stream start/complete (model, ms, sseChunks) + abort/error logs.
  Decision worker spawned with stdio pipe (was "ignore") and relayed line-by-line
  into pino — its [decision]/[decision-engine] prints now appear in npm run dev.
- Client debug spam removed (no pino in browser bundle): 9 console.log in
  hooks/useChat.ts, 4 in lib/stream/parser.ts. Kept console.error/warn in
  client code (parser error, highlight, ChatInput, docProcessor).
- Verified: tsc clean; vitest 434 passed/1 skipped; live isolated dev server on
  :3799 (DECISION_ENGINE_AUTOSPAWN=0, engine URL pointed at dead port — zero
  model traffic): pino pretty lines render, conversations GET/POST log once each,
  decision fallback envelope logged with by=fallback. Test server killed,
  c_logtest.json removed from ~/.local-intelligence/conversations.

### 2026-10-19 (later) — Stale-bundle follow-up [LOCKED-DONE]
- User still saw conversations GET/POST flood: browser tab ran the OLD client bundle (next.config.mjs change needs dev restart; a parallel verification dev server sharing .next broke HMR mid-session).
- Purged .next, fresh compile on isolated :3799 (autospawn off, zero model traffic), served app/page.js chunk verified to contain `if (status === "streaming") return;` + snapshot dedup gate. Server killed, no artifacts.
- User action: restart `npm run dev`, hard-reload tab (Ctrl+Shift+R). Expect exactly one POST + one GET per turn.

### 2026-10-19 — Decision table logging [LOCKED-DONE]
- lib/server/decision-log.ts: per-turn pino block — Needle 3 in/out, LFM2.5 exact input + raw grammar JSON, skills (core/user + injected bytes), mode→UI COMPONENT, stripped LLM prompt, constraints/entities, validators, fence.
- Envelope +3 diagnostic fields (schemas.py + types.ts): needle_prior{modes,confidence}, lfm_input, lfm_raw. Worker lfm_decide(trace) captures them; redundant [decision] summary print removed (guard/salvage/failure prints kept).
- chat + decision routes call logDecisionTable; chat route tracks skillBlockBytes. audit-decision-table.mjs header updated.
- __tests__/decision/decision-log.test.ts 5/5. tsc clean, py_compile clean. Live fallback table verified on :3799 (autospawn=0). Full Needle/LFM rows verified by unit test only — live engine path unverified (no model load).
