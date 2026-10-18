# AI-INTERNAL STATE SNAPSHOT (8-Section Deep Compaction Format)
Synced: 2026-10-19 — Hybrid Decision Engine + post-audit hardening patch (lossless strip / determinism / 9-tool Needle)

[8.1 CORE OBJECTIVE & ACTIVE PHASE]
Master architectural upgrade COMPLETE through Phase 6: every hardcoded routing/renderer
condition was ripped out and replaced by a 100% project-local Hybrid Decision Engine.
Stage 1 = Needle 3 (cactus-needle 3.2.5, stateless classify_mode prior), Stage 2 =
LFM2.5-1.2B-Instruct-Q4_K_M via llama-server (escalation when needle conf < 0.85 or
multiple prior intents). Prompt stripping always runs; exactly ONE core skill block is
injected per turn; all validators/renderers are gated on `active_mode` (zero collisions).
Active phase: post-audit HARDENING PATCH COMPLETE (2026-10-19): lossless stripping +
hard-token guard, deterministic LFM (temp0/top_k1/seed42), Needle 9 route_* tools,
llama-server -c 1024/-t 6/batch512/no-warmup, Stage2Out 4 fields. Router suite
11/11, audit table 12/12 (case 10 zero echo, case 11 ALL 10 hard tokens kept),
fallback probe PASS. Playwright browser re-run remains the optional final gate.

[8.2 LOCKED COMPLETED TASKS (DO NOT RE-READ/RE-DO)]
- ./.decision-engine/ fully self-contained: setup scripts, artifacts (libneedle.dll,
  needle3.cact, whistle.cact, LFM2.5-1.2B-Instruct-Q4_K_M.gguf, bin/llama-server.exe,
  Python venv), .gitignore appended. HF_HOME / PIP_CACHE_DIR / TMPDIR all point inside
  ./.decision-engine/.cache. Nothing global.
- Python worker (UPDATED 2026-10-19 hardening patch): schemas.py (MODES, MODE_MAP,
  DecisionEnvelope 12 fields — extracted_entities KEPT for TS compat, Stage2Out now
  4 fields: active_mode/confidence 0..1/stripped_prompt min_length=1/
  task_constraints — extracted_entities REMOVED), decision_server.py (FastAPI
  :8790, POST /decision + GET /health; LFM2.5 ALWAYS decides + strips;
  response_format json_object+Stage2Out schema grammar-lock; 1 self-correction
  retry; on 2nd failure -> Needle prior_modes[0] + RAW prompt, decided_by
  "needle3 (lfm-fail)"; prior = qualitative reliability hint only).
  NEEDLE 3 MULTI-TOOL: 9 route_* tools (route_excel..route_standard_chat,
  1-sentence docstrings) replace classify_mode; TOOL_TO_MODE maps name->mode by
  prefix strip; prior_modes = deduped tool-call sequence (multi-mode).
  DETERMINISTIC _lfm_call: temperature 0.0, top_k 1, top_p 1.0, seed 42,
  max_tokens 180 (kills 0.92-vs-0.23 drift).
  LFM_SYSTEM (tuned over 4 iterations, greedy-sensitive — every sentence shifts
  mode boundaries): NO concrete echoable examples, placeholder-format examples
  only ('Make a <N>-slide deck...' -> ppt, not pdf); LOSSLESS NOISE REMOVAL
  stripping instruction (keep numbers/prices/hex/column names/formulas/
  dimensions VERBATIM, remove only fluff + conflicting secondary triggers);
  pdf def = "printable invoice/receipt or an export-for-print document — an
  invoice is pdf, never docs".
  HARD-TOKEN GUARD _preserve_hard_tokens(raw, stripped): regex currency/hex/
  numbers/acronyms/quoted/mid-sentence-capitals from RAW; missing ones APPENDED
  as "Required Specs: [...]" (append-only, lossless regardless of model).
  llama-server flags: -c 1024 -ngl 0 -t <physical cores via _thread_count(),
  LFM_THREADS env override> --batch-size 512 --ubatch-size 512 --no-warmup
  --no-webui (binary CPU-only, --list-devices none). stripper.py = whitespace
  trim ONLY (fallback path); zero rule-based stripping on the success path.
- app/api/chat/route.ts: task_constraints now FORWARDED — constraints absent
  from stripped_prompt appended as "\n\nRequired Specs: a; b" before
  replaceLastUserText (was silently dropped).
- TS decision layer: lib/decision/types.ts (RENDERER_MODES, MODE_SKILL, MODE_FENCE,
  DecisionEnvelope), contracts.ts (MODE_CONTRACTS), skill-loader.ts (path-guarded
  loadCoreSkillBundle + buildDecisionSkillBlock -> <decision_skill mode= decided_by=>
  wrapping <core_skill name=> + <output_contract_*>; null for standard_chat),
  client.ts (decisionEngineUrl, ensureWorker singleton, fallbackEnvelope
  standard_chat/conf 0/stripped=original). app/api/decision/route.ts passthrough.
- app/api/chat/route.ts pipeline (locked order): applySlashSkillRouting -> lastUserIdx
  -> fullText -> passthrough check (payload.decision_mode, then delete) ->
  passthroughEnvelope OR getDecision(fullText, historyBefore) -> replaceLastUserText
  (stripped) BEFORE injectSystemBefore(buildDecisionSkillBlock) -> forwardStream with
  "x-decision-mode" header (+ X-Used-Skill user-tier only).
- Legacy purge DONE: lib/skills/coreRouter.ts DELETED, lib/render/systemPrompt.ts
  DELETED; keyword/regex routing removed from frontend+backend. Gating data tables:
  MODE_SCAN_LANGS (lib/render/fenceRepair.ts), MODE_RENDER_KINDS + kindAllowed
  (components/MarkdownRenderer.tsx ~lines 71-81, gated dispatch ~262-273).
- Vitest: 436 passed | 1 skipped (43 files), 0 failed. tsc --noEmit: clean (verified
  AFTER all spec patches, 2026-10-18).
- tests/test-decision-router.mjs: 11/11 ALL PASS (9 modes + 2 multi-intent
  collisions incl. "Build a 500-row Excel budget sheet and explain how 3D CAD
  rendering models work in the notes column" -> excel/xlsx/xlsx, 3D validators
  disabled). Every case decided_by === "needle3+lfm2.5" (asserted), conf
  0.92-0.98. tests/audit-decision-table.mjs: 12/12 — case 10 stripped_prompt is
  the user's own words (ZERO few-shot echo), case 11 keep-token check ALL 10
  hard tokens preserved (500/Date/Vendor/Amount/SUMIFS/1,250/#FF0000/KPI/pie/
  freeze), multi-turn probe (turn-2 pronoun-only) -> 3d_asset ✅. Model-quality
  deltas from 2026-10-18 (paraphrase loss, few-shot echo) are FIXED by the
  2026-10-19 patch (lossless instruction + placeholder examples + hard-token
  guard + task_constraints forwarding).
- tests/test-decision-fallback.py (venv python -I): PASS (re-run 2026-10-19 with
  tools=ds.ROUTE_TOOLS — stale classify_mode ref removed) — stubbed LFM emits
  garbage twice -> retry fires exactly once (2 attempts), envelope = Needle prior
  mode (docs@0.022) + RAW prompt, decided_by "needle3 (lfm-fail)", zero
  standard_chat drop.
- Playwright specs patched for mode gating (mocks now send x-decision-mode header):
  regression_modalities, progress-status (docs for DOCX toast), studio-viewers-visible
  (3d_asset x3, cad_blueprint x3), render.spec (chart x2 "chart"; mermaid valid+invalid
  and widget tests test.skip — no RendererMode allows those kinds BY DESIGN),
  anatomy-repair (cad_blueprint header + repairReq.decision_mode === "cad_blueprint"
  passthrough assertion). NO change needed: chat-stream (diagnostics only),
  edit-stop-collapse (plain-text assertions), skills.spec (X-Used-Skill pill).
- CLAUDE.md + AGENTS.md updated: core skills fire via Hybrid Decision Engine
  mode->skill_to_load table, not the removed coreRouter keyword router.

[8.3 GRAPHIFY DEPENDENCY MAP (modified files)]
- app/api/chat/route.ts -> lib/decision/client.ts (getDecision) ->
  .decision-engine/worker/decision_server.py (:8790 -> :8791); -> lib/decision/
  skill-loader.ts (buildDecisionSkillBlock) -> ./.cskills/<skill>/SKILL.md; ->
  lib/chat/client.ts (replaceLastUserText/injectSystemBefore order FIXED); ->
  hooks/useChat.ts reads x-decision-mode -> message.decisionMode.
- components/MarkdownRenderer.tsx <- message.decisionMode (kindAllowed gate);
  lib/render/fenceRepair.ts <- MODE_SCAN_LANGS gate + sends decision_mode pin on
  repair rounds -> chat route passthroughEnvelope (skips engine).
- __tests__/skills/chatEngine.test.ts (7 tests, mock server plays worker+upstream);
  __tests__/documents/lazyLoad.test.ts (loader exclusivity vs real ./.cskills/).

[8.4 IMMUTABLE CODE CONTRACTS]
- DecisionEnvelope: {active_mode, confidence, decided_by, stripped_prompt,
  skill_to_load, allowed_code_fence, disable_validators[], enable_validator, ...}
  (12 fields; exact shape in .decision-engine/worker/schemas.py + lib/decision/types.ts).
- RENDERER_MODES (exclusive, 9): excel, docs, pdf, ppt, 3d_asset, cad_blueprint,
  chart, html_render, standard_chat.
- MODE_RENDER_KINDS (MarkdownRenderer): excel:["xlsx"], docs:["docx"], pdf:["html"],
  ppt:["pptx"], 3d_asset:["scene3d","asset3d","threejs"], cad_blueprint:["cad",
  "anatomy"], chart:["chart"], html_render:["html"], standard_chat:[].
  kindAllowed(kind, null) === false. mermaid/widget/resume/powerbi kinds are in NO
  mode -> those renderers can never mount under the 9-mode contract (branches kept,
  gated).
- MODE_MAP (schemas.py): excel:(xlsx,xlsx) docs:(docx,docx) pdf:(pdf,html)
  ppt:(pptx,pptx) 3d_asset:(threejs-skills,scene3d) cad_blueprint:(archify,cad)
  chart:(None,chart) html_render:(html-viewer,html) standard_chat:(None,None).
- Stage2Out (schema-constrained generation, 4 fields): {active_mode: one of 9
  Mode literals, confidence: 0..1, stripped_prompt: min_length 1,
  task_constraints[]} — extracted_entities REMOVED 2026-10-19 (DecisionEnvelope
  keeps it, default [], so lib/decision/types.ts:61 + client.ts:88 +
  route.ts:126 + fixtures stay valid). _lfm_call params LOCKED: temperature
  0.0, top_k 1, top_p 1.0, seed 42, max_tokens 180. decided_by values:
  "needle3+lfm2.5" (success), "needle3 (lfm-fail)" (LFM failed after retry ->
  Needle prior + raw prompt), "fallback (no prior)" (both models gave nothing),
  "repair-passthrough", "fallback" (TS client). No CONFIDENCE_GATE skip — LFM
  runs on every non-empty request. Needle tools LOCKED: ROUTE_TOOLS = 9
  route_* functions; TOOL_TO_MODE = prefix strip; CLASSIFY_SYSTEM asks for
  "exactly one route_* tool".
- HTTP: POST /api/decision passthrough; POST /api/chat streams header
  "x-decision-mode: <active_mode>"; ChatRequest.decision_mode pins mode (repair
  rounds; passthrough uses UNSTRIPPED text). Worker: :8790 /decision /health;
  llama-server decision: :8791; main LLM upstream: :8080 (LLM_API_URL).
  DECISION_ENGINE_URL env overrides worker base.
- Env: no secrets hardcoded; LLM_API_URL via .env.local.

[8.5 PLAYWRIGHT & E2E VERIFICATION STATE]
- Servers running: Next dev :3000, decision worker :8790, llama-server :8791,
  main LLM :8080.
- tests/test-decision-router.mjs: `node tests/test-decision-router.mjs` -> 11/11 PASS.
- tests/audit-decision-table.mjs: `node tests/audit-decision-table.mjs` -> 12-row
  Markdown table (9 modes + collision + detail-preservation + multi-turn),
  12/12 ✅ + "Detail-preservation (case 11): ALL 10 hard tokens preserved".
- Worker restart pattern (prompt changes only): kill :8790 listener, relaunch
  venv python -I decision_server.py (llama-server :8791 stays warm —
  ensure_llama_server skips when healthy). llama-server restart needs killing
  :8791 too; flags apply only on fresh spawn.
- All /api/chat mocks in tests/*.spec.ts MUST send x-decision-mode or renderers gate
  off (previews never mount). Plain code fences/tables/lists are NOT gated.
- Specs patched + compile (tsc clean) but NOT re-executed in a browser this segment:
  progress-status, studio-viewers-visible, render, anatomy-repair,
  regression_modalities. Skipped-by-design: 2 mermaid + 1 widget tests in render.spec.

[8.6 OPEN BUGS / BLOCKERS]
- None failing. Honest-report deltas (documented, not bugs):
  * RAM (2026-10-19 full accounting): engine tree = llama-server 1355.2MB
    (post-suite; 1232.4MB idle — new flags saved ~130MB) + needle's own
    _worker.py --child runtime pair 121.3MB (16412+16152, previously UNCOUNTED)
    + uvicorn worker 59.3 + launcher 4.1 = ~1.54GB TOTAL vs user's <850MB
    target. NOT reachable: bundled llama-server binary is CPU-only
    (--list-devices -> none, -ngl 99 impossible) and LFM2.5 Q4_K_M weights
    alone ≈760MB + CPU compute buffers + KV set the floor.
  * Latency post-flags: Needle 135-370ms (was 120-670; one 1499ms outlier on
    first cold call), LFM 1.44-2.51s (batch/no-warmup flags cut startup, not
    per-token CPU decode). LFM runs on EVERY request — deliberate: user chose
    zero rule-based stripping + always-model decisions over latency.
  * Needle priors still low-conf (0.02-0.36) and often wrong mode, but now
    MULTI-MODE (route_* tool sequence, e.g. ['excel','html_render',
    'cad_blueprint']@0.14 on collision prompt); LFM reliably overrides them
    (anti-anchoring block + never raw-conf echo).
  * Legacy history messages (no decisionMode) render fences as plain code — by design.

[8.7 ACTIVE SKILLS & SCENARIO LOCKS]
- No Tier 1/Tier 2 skill reference files preloaded. Project two-tier skill rules
  (CLAUDE.md) in force: ./.cskills/ invisible tier loaded ONLY via
  buildDecisionSkillBlock; ./.cskills-scenarios/ now maintained by installer only
  (runtime firing = decision engine mode table).

[8.8 IMMEDIATE NEXT 3 ATOMIC ACTIONS]
1. (Optional verification gate) Re-run patched Playwright specs against :3000:
   `npx playwright test tests/progress-status.spec.ts tests/studio-viewers-visible.spec.ts tests/render.spec.ts tests/anatomy-repair.spec.ts tests/regression_modalities.spec.ts`.
2. (Optional) vitest full pass after route.ts task_constraints change (tsc clean).
3. If user approves, commit the decision-engine change set (nothing committed yet).
