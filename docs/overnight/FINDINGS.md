# FINDINGS — initial classification from brief §4 (2026-11-15)

Classification: REPRO (reproduced by audit) · SRC (source-confirmed) · SUSPECT · ALREADY-FIXED · NT (not tested).
Every fix records route reachability (default Rust chat path vs retained TS path vs secondary routes).

| ID | Class | Owner(s) | Route | Fix posture |
|---|---|---|---|---|
| F01 | SUSPECT | lib/chat/client.ts:44, decision probes | prompt assembly | minimal response-policy instruction; no canned replies |
| F02 | REPRO | lib/decision/client.ts:165, ruke-decision/engine.rs | decision routing | structured artifact intent fields; abstain on uncertainty |
| F03 | REPRO | lib/web-search/planner-law.ts | web policy | constraint objects (target/polarity/scope/exclusivity/span) |
| F04 | REPRO | task-scope.ts + ruke-server/task_scope.rs | scope carryover | antecedent resolution; field-scoped reset |
| F05 | REPRO | normalization/metasearch/reranker/query-planner/presentation | retrieval | field-aware normalization; unknown states; locale≠identity |
| F06 | SRC | segment-filter.ts:164, tools.ts, retrieve | evidence recovery | addressable canonical blocks; continuation by ID |
| F07 | REPRO | attachindex/router.ts, turn.ts, retrieve.ts | attachment retrieval | modality-aware intents; scoped ledger |
| F08 | SRC | ruke-server chat/pipeline.rs:155–200 | Rust attach turn | recompute target index / stable identity |
| F09 | SRC | attachindex/store.ts:34–60, retrieve.ts:25 | TS index | generation dirs + manifest switch; dim/version validation |
| F10 | SRC | attachindex build/embed | TS indexing | cancellation through parse→commit |
| F11 | REPRO | contracts.ts, schemas.ts, xlsx/powerbi engines | artifacts | typed missingness/units; capability honesty |
| F12 | REPRO | extract/pdf.ts, extract/office.ts | extraction | entity decode fix, formula+cached preservation |
| F13 | SRC | extract/ffmpeg.ts, audio.ts, vision-prepass | video | timeline system (P7) |
| F14 | SRC | lib/chat/client.ts:135,191; turn.ts:119; Rust mirror | prompts | coverage-honest machine-readable claims |
| F15 | REPRO | answer-release.ts:120 + Rust mirror; WEB_TOOL_GUIDANCE | answer integrity | code-fence-aware, provenance-based validation |
| F16 | SRC | web-tool-loop.ts:620-684, web_loop.rs, parser.ts, useChat | streaming | terminal sentinel after all metadata; explicit outcome plumbing |
| F17 | REPRO | lib/stream/thinkTags.ts | reasoning | protocol-aware, code-aware splitting |
| F18 | REPRO | components/ProcessingStatus.tsx:115 | UI activity | single authoritative activity state |
| F19 | SRC | app/page.tsx:262–375 | scroll | following/free controller |
| F20 | REPRO | lib/skills/modality.ts | capability gating | declared capabilities, not brand blacklist |
| F21 | SRC | pdfEngine.ts:109, browser.ts, singletons | lifecycle | owned cleanup + idle release |

## Call-graph audit (P1.1) — in progress
(to be filled as call sites are mapped)

## P1.1 Upstream call-graph audit (2026-11-15)
Production sites — after P1.3 every one sits behind ONE door (mode column: which authority admits it):
| Site | File | Mode/authority |
|---|---|---|
| chat stream (forwardStream / forwardStreamInto) | app/api/chat/route.ts | Rust mode: whole handler proxied (route.ts:573 rustProxy) → Rust admission. TS-only mode: sharedUpstreamStream → LocalUpstreamAdmission |
| web tool loop rounds (streamRound) | lib/chat/web-tool-loop.ts | TS-only mode only (Rust runs its own loop) → sharedUpstreamStream |
| search gate plan | lib/web-search/search-gate.ts | sharedUpstreamCompletion (targetUrl when WEB_SEARCH_LLM_ENDPOINT set) |
| jsonCompletion (decision titles, misc JSON helpers) | lib/web-search/llm-json.ts | sharedUpstreamCompletion; `endpoint` override → targetUrl (bridge cannot reach alt endpoints — honest documented escape hatch, local admission only) |
| vision prepass | lib/web-search/vision-prepass.ts | sharedUpstreamCompletion |
| title generation | lib/server/titles/generate.ts | sharedUpstreamCompletion (Rust mode: titles owned Rust-side) |
| attach notes block distill | lib/server/attachindex/notes.ts | sharedUpstreamCompletion (Rust mode: Rust attach-notes owns) |
| audio LLM warmup (1-token) | lib/server/extract/audio.ts | sharedUpstreamCompletion — even a 1-token warm-up is a generation |
| Rust: forward_legacy / forward_into / web stream_round / browser round / titles / attach notes | rust-backend ruke-server six loci | ruke_core::admission::UpstreamAdmission (the ONE authority; active count never > 1) |
Non-upstream (no permit needed): LLM_UNLOAD_URL / LLM_RELOAD_URL postJson hooks (lifecycle, not generations); model-stats parses origin only.
Test-scope (NOT rewired, never production): scripts/playwright-10k-audit.ts:73 (harness upstream), __tests__/** fetch mocks, rust-golden fixtures.
Zero unmanaged production upstream sites remain (grep-audited: no `fetch(llmApiUrl`, no stray Bearer upstream calls outside the door).

## P1.6 — Strata unload/reload support (verified from the ACTUAL install, 2026-11-15)
- Live instance: PID 19584 = `D:\AI\Strata\.venv\Scripts\python.exe D:\AI\Strata\serve\server.py --engine strata --config strata-iq3_s.json --port 8080`; `/health`: model `qwen3.8-flash-next-iq3_s`, engine 0.1.59, `api_key: false`, `loaded: true`, `concurrency.serving: 1` (server-side FIFO capacity-1 — corroborates the admission premise).
- Routes in the running source: `POST /unload[?wait=0|1|<s>]` (server.py:8342; 409 `busy` while a turn runs — NEVER evicts mid-turn; `?wait=1` waits up to UNLOAD_WAIT_S=300 s), `POST /load` (idempotent, GpuBusy→503 Retry-After), plus `/v1/load`/`/v1/unload` OpenAI-dialect twins (model-checked). Guards: `_own_page` = JSON content-type + no foreign Origin; **no Origin = non-browser client → allowed**. `_authorized`: api_key unset on this instance → no auth needed.
- Live safe probe: `POST /load` → 200 `{"status":"loaded"}` and `POST /v1/load` → 200 full metadata, model stayed loaded, zero state change. Live `POST /unload` probe deliberately NOT sent (brief: never unload Strata during Claude inference); its semantics are pinned by the install's own suite (serve/test_web_load_unload.py: "never interrupts a turn") + source reading.
- WebUI hooks (`lib/server/extract/audio.ts` postJson: POST {} + content-type: application/json, no Origin) match the guard exactly. Enabled in `.env.local` (gitignored; LLM_API_URL/KEY set to the SAME values as code fallbacks — zero behavior change): LLM_UNLOAD_URL=http://127.0.0.1:8080/unload, LLM_RELOAD_URL=http://127.0.0.1:8080/load. Restoration is already finally-guarded and adversarially tested (audio-stage-guard tests).
- Verdict: **P1.6 passed** — swap support proven; hooks live-capable; /unload live-fire left unexercised BY DESIGN, not by inability.
