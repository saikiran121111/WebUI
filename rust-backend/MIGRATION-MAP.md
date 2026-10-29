# Rust Backend Migration Map — Phase 0 Inventory (frozen 2026-10-26)

Generated from the actual working tree on branch `develop` @ 791faed.
**Do not start Part 1 until every open decision point in §9 is resolved.**

---

## 1. Stale assumptions in the migration brief (VERIFIED CORRECTIONS)

| Brief claim | Actual tree (verified by find/git) |
|---|---|
| `lib/browser/**`, `app/api/browser/**` exist | **DELETED** in commits `86daf90`/`5b6ac0a`. Replaced by the `reverse-engineering/internal-browser/` (Codex Internal Browser) spec — a separate project, NOT part of this migration. Rule 2's "don't assume paths still exist" applies directly. |
| `.decision-engine/` Python worker + LFM2.5-1.2B router | **GONE.** Since 2026-10-22 routing is **in-process regex intent matching** (`lib/decision/client.ts`, `decided_by:"in-process-deliverable-match"`, ~0 ms, no model call, `stripped_prompt` is always verbatim). The DecisionEnvelope contract survives; the LFM machinery does not. "decision calls" in the cancellation rules = a local function, not a network hop. |
| `/api/internal/agent-browser` Node bridge exists | **Does not exist.** The only Playwright server usage today is `lib/web-search/agentBrowser.ts` (web-search Tier-3b interactive-profile fallback) and `lib/documents/browser.ts` (Chromium print-to-PDF for document export). The privileged internal RPC + shared secret from Rule 9 is a NEW design, not a port. |
| `src/` removed | Mostly: one vestigial file `src/lib/web-verify/types.ts` (+ `lib/web-verify-types.ts`) remains — cleanup candidates, not migration targets. |
| "existing per-chunk `<think>` parsing bug" | CONFIRMED: `app/api/chat/route.ts` `scrubThinkTags` runs **per chunk** and (a) splits tags/UTF-8 across chunk boundaries (also a `new TextDecoder()` per chunk — multibyte code points mangled), (b) **drops everything after an unterminated `<think>`** including the open tag's prefix handling. Rust state-machine rewrite is the approved fix (Rule 4). Client-side twin: `lib/stream/thinkTags.ts` stays TS. |

Runtime topology right now: Next dev **`:3000`** (PID 13004, node, idle WS ≈ **1,931 MB**), Strata/llama.cpp **`:8080`** (`LLM_API_URL` default `http://127.0.0.1:8080/v1/chat/completions`). `:8790`/`:8791` are DEAD (hard ban per CLAUDE.md §5.2 — do not resurrect).

---

## 2. Wire-contract freeze (the golden-fixture spec)

Extracted from `app/api/chat/route.ts` (780 L), `lib/chat/streamHelpers.ts`, `lib/stream/parser.ts`, `lib/types.ts`.

### 2.1 `POST /api/chat` request handling
- Body parsed as JSON; **non-JSON body → forwarded to upstream verbatim** (no pipeline, no headers metadata beyond `standard_chat` mode).
- `payload.model` (string) used for logging only; body otherwise forwarded `JSON.stringify(payload)` after documented deletions below.
- `payload.purpose === "compact"` → `delete purpose`, `stripAttachmentRefs`, **full passthrough** via `forwardStream` (no decision/skill/retrieval/web stages, no stage frames, `x-decision-mode: standard_chat`).
- `payload.decision_mode` ∈ RendererMode → `passthroughEnvelope(mode, text)`, field deleted before upstream.
- `payload.stream === false` → **legacy path**: single response, metadata travels in headers; any other value (incl. absent) → **progress path**: early-opened SSE, metadata travels in `web_meta` frame, headers carry only `x-decision-mode` + `X-Used-Skill`.
- `attachment_ref` content parts: internal routing hint; `stripAttachmentRefs` removes ALL before upstream (both paths).
- Decision/gate input = `firstTextPart(lastUser.content)` (FIRST text part only); `historyBefore` = user/assistant roles only, each capped `slice(0,500)`.

### 2.2 Response headers
Always on both stream paths: `Content-Type` (upstream's, else `text/event-stream`), `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`, `x-decision-mode: <mode>` (lowercase spelling as written).
Conditional: `X-Used-Skill: <name>` only when a **user-tier slash skill** was applied (core skills never appear — invisibility rule). `X-Web-Citations` / `X-Search-Gate`: only on the **legacy non-stream path** (progress path sends them as the `web_meta` stage frame instead). Both are `encodeURIComponent(JSON.stringify(value))` only when non-null/non-empty.

### 2.3 SSE frame grammar (progress path)
- Frames: `data: <json>\n\n`. Stage: `{"ruke_stage":<StageEvent>}`. Error: `{"ruke_error":{"message":<string>}}` then `data: [DONE]\n\n`.
- Stage sequence: `decision_done {mode,ms}` → optional `skill {detail?,ms}` → optional `retrieval` / `retrieval_done {done,total}` → `web:<PipelineStage>…` (carries `detail,total,done,coverage,url,domain`) → optional `web_meta {webCitations,searchGate?}` → raw upstream SSE bytes (scrubbed) → stream closes. Upstream's own `data: [DONE]` passes through inside the raw bytes; **the route never appends its own `[DONE]` after raw bytes** — only `fail()` does, and never twice (`closed` latch).
- `StageEvent` exact fields: `stage, detail?, mode?, ms?, done?, total?, coverage?, url?, domain?, webCitations?{sourceId,url,title,domain,publishedAt?}` (+ see `lib/types.ts:272`).

### 2.4 Error semantics (Rule 7)
- Legacy path: upstream `!ok` → `JSON {error:"Upstream returned <status>[: <errText≤200 chars>]"}` **with upstream's status**; no body → `502 {error:"No response body from model"}`; unreachable → `503 {error:"Could not reach the model server at <host>."}` (host = URL host, or literal `"the configured port"` if URL unparsable).
- Progress path: same conditions become `ruke_error` frames (message strings identical: `"Upstream returned…"`, `"No response body from model"`, `"Could not reach the model server at <host>."`).
- Attachment retrieval failure → `retrieval_done {done:0,total:0}`, continue. Web-research failure → log + continue. Client abort → `AbortError` expected, release slot, no error frame beyond close.

### 2.5 Other server contracts
- `settings.json` (repo root): `{llm_api_url?, llm_api_key?, compact_thresholds?:{auto:0|1,tokens:number}}`; priority file > env > fallback; atomic tmp+rename; corrupt file keeps last parse.
- Inference slot: single llama.cpp slot; `beginUserTurn/endUserTurn` (chat + web-gate + vision + title calls), `activeUserTurns` counter, background title AbortControllers aborted on `beginUserTurn`. Titles wait `waitForUserIdle` (poll 1 s).
- Env vars in force: `LLM_API_URL`, `LLM_API_KEY`, `MESHY_API_KEY`, `EMBED_MODEL` (default `Xenova/all-MiniLM-L6-v2`), `WEB_SEARCH_GATE_DISABLED` (via `gateDisabledByEnv`), `RUKE_TEST_FIXTURES=1` (fixture allow-list `lib/web-search/ssrf.ts:isFixtureAllowed`).

---

## 3. Server-side dependency graph (compact)

```
chat/route.ts → {skills/lazy, decision/client, decision/skill-loader, server/inference-busy,
                 server/attachindex/turn, web-search/pipeline, web-search/search-gate,
                 server/settings, server/logger, lib/types(StageEvent)}
attachindex/turn → {skills/lazy, attachindex/{embed,notes,router,retrieve,store,types}}
attachindex/build (called from files/extract) → {chunk, embed, spine, store, files/extensions, types}
attachindex/{retrieve→bm25,format,router} ; spine→{bm25,format}
files/extract/route → {server/extract/index→(office,rtf,notebook,archives→zip,strings,pdf,ffmpeg,audio,build,store,types),
                       files/extensions, server/logger}
web-search/pipeline → {search-gate→(settings,llm-json→(settings,inference-busy),url-detector),
                       metasearch→(net→ssrf, engines→net, cache→metasearch, better-sqlite3),
                       engines, net→ssrf(impit), extractor→(net,cache,schema-extract,platform-api→
                       (net,redirect-unwrap,google-maps,youtube), hydration-unpacker,
                       universal-extractor→charset-normalizer, charset-normalizer, agentBrowser→playwright),
                       reranker, youtube→net, google-maps→(net,redirect-unwrap), query-planner→(metasearch,reranker),
                       cache, url-detector(tldts)}
search-gate/vision-prepass → llm-json → fetch(llmApiUrl) + inference-busy
skills/registry → (frontmatter, modality, types, fs, child_process[npx installer])
decision/skill-loader → (skills/registry, contracts, types, fs)
conversations routes → persistence/{disk,merge} ; [id]/title → server/titles/queue→(disk,inference-busy,policy,generate→(settings,transcript))
documents routes → documents/{http,engines…, pdfEngine→documents/browser[playwright]}
3d routes → three3d/{sceneSchema, providers/{index,meshy,types}}
model-stats → server/settings ; settings route → server/settings ; decision route → decision/client
```
Client-only graph (hooks/useChat, lib/stream/*, lib/chat/client, lib/progress, lib/render, components) is FROZEN per Rule 1 — it defines the consuming end of §2.

---

## 4. Classification — app/api routes (25)

| Route | Class | Notes |
|---|---|---|
| `chat/route.ts` | **MOVE_TO_RUST** | The heart. §2 is its spec. Ends as thin proxy (Rule 11). |
| `search/route.ts`, `search-more/route.ts` | **MOVE_TO_RUST** | Delegate to Rust pipeline; Next route becomes thin proxy. |
| `decision/route.ts` | **MOVE_TO_RUST** | Trivial (returns `getDecisionSync` envelope). |
| `settings/route.ts` | **MOVE_TO_RUST** | Owns settings.json; Next keeps UI calling same URL. |
| `model-stats/route.ts` | **MOVE_TO_RUST** | Trivial HTTP passthrough to Strata stats. |
| `conversations/route.ts`, `conversations/[id]/route.ts`, `conversations/[id]/title/route.ts` | **MOVE_TO_RUST** | Server-owned disk state (Rule 1) + titles queue. |
| `attach/[id]/notes/route.ts` | **MOVE_TO_RUST** | Notes live in attach store (read side moves). |
| `files/extract/route.ts` | **KEEP_NODE_REQUIRED** | Extraction parsers + index BUILD stay Node (see §7). Becomes the Node sidecar's public ingest route. |
| `skills/route.ts`, `skills/[skillName]/route.ts`, `skills/[skillName]/scenario/route.ts` | **MOVE_TO_RUST** | Registry fs reads; invisibility rule enforced here (never list `.cskills`). |
| `skills/install/route.ts` | **MOVE_TO_RUST (spawn)** | Shells `npx -y skills add`; Rust `Command` spawn is parity-safe; must keep rejecting `./.cskills/` paths. Golden fixture: installer rejection contract. |
| `documents/{docx,pdf,powerbi,pptx,resume,xlsx}/route.ts` | **KEEP_NODE_REQUIRED** | docx/exceljs/pptxgenjs + Chromium print-to-PDF. Materially superior in JS (Rule 10). |
| `anatomy/export/route.ts` | **KEEP_NODE_REQUIRED** | `liveEngine.mjs` + headless-gl (`.mjs` kit). |
| `3d/assets/[…]/route.ts` (3) | **KEEP_NODE_REQUIRED** (deferrable) | Meshy provider HTTP + fs; port only in an optional late part. |
| `app/layout.tsx`, `app/page.tsx` | **KEEP_CLIENT_TS** | Next frontend. |
| `app/api/browser/**` | **n/a — deleted** | Do not port ghosts. |

## 5. Classification — lib/ modules

| Module | Class | Notes |
|---|---|---|
| `lib/server/settings.ts` | **MOVE_TO_RUST** | SettingsShape = SHARED_CONTRACT. |
| `lib/server/inference-busy.ts` | **MOVE_TO_RUST** | Rule 6: one CancellationToken per turn; slot exactly-once release. Rust: Notify/Barrier + abort handles. |
| `lib/server/logger.ts` | **DELETE_AFTER_PARITY** | Rust uses `tracing` (Rule 17). pino stays until Node-only modules remain. |
| `lib/server/attachindex/{store,types}.ts` | **SHARED_CONTRACT** | Disk format under `.data/attach-index/` frozen; both sides read/write it. |
| `lib/server/attachindex/{build,chunk,embed,spine}.ts` | **KEEP_NODE_REQUIRED** | Index BUILD side stays Node (embed = ONNX `@huggingface/transformers`). See §7 ingest flow. |
| `lib/server/attachindex/{bm25,format,router,retrieve,notes,turn}.ts` | **MOVE_TO_RUST** | Read/retrieval side + turn injection. Golden fixtures: `__tests__/attach-*.test.ts` outputs re-run against Rust on the SAME fixture store. |
| `lib/server/extract/**` | **KEEP_NODE_REQUIRED** | unpdf, own office-XML parsers (node:zlib), 7z/xz/tar via `7zip-bin` child_process, ffmpeg+whisper audio. Text-extraction parity (not byte parity). |
| `lib/server/titles/*` | **MOVE_TO_RUST** | Queue + policy + transcript + LLM generate; yield-to-user semantics per §2.5. |
| `lib/decision/types.ts` | **SHARED_CONTRACT** | `RENDERER_MODES`, `MODE_SKILL`, `MODE_FENCE`, `DecisionEnvelope` — generate TS from Rust (ts-rs) or drift-test (Rule 14). |
| `lib/decision/client.ts` | **MOVE_TO_RUST** | Regex INTENT_MATCHERS table must be ported EXACTLY (crate `regex`; fixture pins each matcher both directions). |
| `lib/decision/contracts.ts` | **SHARED_CONTRACT** | JSON contract for envelope. |
| `lib/decision/skill-loader.ts` | **MOVE_TO_RUST** | Reads `.cskills/<name>/SKILL.md`, one `<decision_skill>` block. |
| `lib/skills/{registry,frontmatter,lazy,modality}.ts` | **MOVE_TO_RUST** | Slash routing = zero-token-when-unused contract; `applySlashSkillRouting`, `injectSystemBefore`, `lastUserIndex`, `extractUserText` are wire-visible behavior. |
| `lib/skills/types.ts` | **SHARED_CONTRACT** | |
| `lib/skills/client-cache.ts` | **KEEP_CLIENT_TS** | |
| `lib/web-search/net.ts` | **MOVE_TO_RUST** | `impit` IS a Rust HTTP client — port natively (redirect policy + TLS parity pinned by fixtures). |
| `lib/web-search/ssrf.ts` | **MOVE_TO_RUST** | + duplicated SSRF at Node bridge (Rule 9). Fixture allow-list contract included. |
| `lib/web-search/{engines,metasearch,cache,redirect-unwrap,url-detector,schema-extract,hydration-unpacker,charset-normalizer,reranker,query-planner,google-maps,platform-api,youtube}.ts` | **MOVE_TO_RUST** | Parse parity is fixture-driven (linkedom/cheerio/turndown → Rust crates; `tldts` → tldrs crate). cache.ts better-sqlite3 schema = SHARED_CONTRACT (rusqlite same file, WAL check). |
| `lib/web-search/search-gate.ts` | **MOVE_TO_RUST** | Gate LLM call via Rust llm-json; `WEB_SEARCH_GATE_DISABLED` honored. |
| `lib/web-search/llm-json.ts` | **MOVE_TO_RUST** | |
| `lib/web-search/vision-prepass.ts` | **MOVE_TO_RUST** | Vision pre-pass is Strata HTTP, not Node-local vision; RUKE_VISION_MOCK is the deleted browser subsystem — do not port. |
| `lib/web-search/universal-extractor.ts` | **MOVE_TO_RUST** | readability/turndown parity is the highest-risk port — dedicated fixtures from live corpus (`web-search-10k`). |
| `lib/web-search/extractor.ts` | **MOVE_TO_RUST** (Tier-3b hop) | Tier that calls `agentBrowser` becomes an RPC to the Node sidecar (§7). |
| `lib/web-search/pipeline.ts` | **MOVE_TO_RUST** | 7-tier orchestrator; every `web:<stage>` event must fire identically. |
| `lib/web-search/agentBrowser.ts` | **KEEP_NODE_REQUIRED** | Playwright. Behind internal RPC, shared secret, loopback, double SSRF, nav/response/operation timeouts (Rule 9). |
| `lib/web-search/types.ts` | **SHARED_CONTRACT** | zod → serde + ts-rs. |
| `lib/web-search/index.ts` | **DELETE_AFTER_PARITY** | Barrel. |
| `lib/chat/client.ts`, `compact.ts`, `compactConfig.ts`, `tokens.ts`, `tokenMeter.ts`, `recentsFilters.ts`, `streamHelpers.ts`, `types.ts` | **KEEP_CLIENT_TS** | Compaction CLIENT decision logic stays (Rule 1); Rust only passthroughs `purpose:"compact"`. |
| `lib/stream/{parser,sse,thinkTags,index}.ts` | **KEEP_CLIENT_TS** | Server-side scrubber is NEW Rust state machine (Rule 4 fix), not a port of these files. |
| `lib/progress/turnProgress.ts` | **KEEP_CLIENT_TS** | Client aggregation of server stages; StageEvent = SHARED_CONTRACT. |
| `lib/render/**` | **KEEP_CLIENT_TS** | Fence renderers/validators run in browser. (`lib/render/schemas.ts` mirrors SHARED_CONTRACTs.) |
| `lib/persistence/{disk,merge}.ts` | **MOVE_TO_RUST** | Conversations disk state. `persistence/index.ts` = SHARED_CONTRACT types. |
| `lib/files/extensions.ts` | **SHARED_CONTRACT** | |
| `lib/files/docProcessor.ts`, `index.ts` | **KEEP_CLIENT_TS** | Browser-side attachment prep. |
| `lib/documents/**` | **KEEP_NODE_REQUIRED** | Engines + Chromium; `documents/schemas.ts` = SHARED_CONTRACT (DTO validation on Rust edge). |
| `lib/three3d/**` | **KEEP_CLIENT_TS** (viewer) / providers KEEP_NODE_REQUIRED (3d routes) | |
| `lib/anatomy/**` | **KEEP_CLIENT_TS** + export engine KEEP_NODE_REQUIRED | |
| `src/lib/web-verify/types.ts`, `lib/web-verify-types.ts` | **DELETE_AFTER_PARITY** | vestigial. |

## 6. Tests (classification)

- **Contract/golden candidates (vitest)**: `sse.test.ts`, `sse-stage-events.test.ts`, `parser-multi-chunk.test.ts` (→ Rule 4 split-frame fixtures), `compact-pipeline.test.ts`, `chatEngine.test.ts`, `citation-pills.test.ts`, `attach-index.test.ts`, `attach-retrieval-integration.test.ts`, `titles/*` (3), `token-meter.test.ts`, `turn-progress.test.ts`, `web-search/url-detector.test.ts`, `hardening-payload.test.ts`, `hardening-audio.test.ts`.
- **Node-only regression (keep as-is)**: documents/*, cad/*, three3d/*, anatomy/*, render/* (client), skills/{registry,installer,modality}.
- **Playwright (Part 10 only, per brief)**: all `tests/*.spec.ts` run unchanged against cutover stack; `tests/helpers/`, `tests/fixtures/**` reused.
- **Fixture assets available now**: `scripts/e2e-llm-proxy.mjs` (:8099 recording proxy — reuse for upstream-request-body goldens), `tests/fixtures/**` (archives/audio/images/docs for extract parity).

### Rule 3 golden-fixture checklist (status)
All PENDING against Rust; TS baseline harness = existing vitest suites + a new `rust-backend/fixtures/` corpus recorded from TS with a **mock upstream** (deterministic SSE server):
streaming | non-streaming | malformed/non-JSON passthrough | empty/minimal payload | compaction passthrough (assert purpose deleted + stripAttachmentRefs + no stage frames) | slash skill (X-Used-Skill + injection) | decision-mode passthrough | attachment retrieval | attachment retrieval failure (non-fatal) | web-search disabled | web-search success (web_meta/citations) | web-search failure (non-fatal) | image pre-pass (payload hasImage) | upstream 4xx/5xx (both paths) | unreachable upstream (both paths) | client abort | split SSE frames | split UTF-8 code points | `<think>` split at EVERY byte boundary (incl. unterminated — Rust fixes TS behavior; dedicated tests + explicit "approved deviation" record).

## 7. Node sidecar design (KEEP_NODE_REQUIRED consumers)

Rust owns: chat orchestration, decision, skills registry/injection, retrieval+notes, web-search pipeline (HTTP+parse+cache), settings, conversations, titles queue, model-stats, inference slot.
Node keeps (single Next server, existing routes): `files/extract` (parse+index-build), attach INDEX STORE writing (embed ONNX), documents export, anatomy export, 3d assets, Playwright Tier-3b.
- **Attach parity path**: Node continues BUILDING the index (extract → chunk → embed → store). Rust reads the same `.data/attach-index/` format (SHARED_CONTRACT §5) and owns RETRIEVE/turn/notes. Zero new RPC; parity fixtures pin the store JSON.
- **Tier-3b hop**: Rust → `POST http://127.0.0.1:<next>/api/internal/browser-read` (NEW, loopback-only, random process-local secret generated by Next at startup, env/IPC handoff to Rust, SSRF re-validation, nav+response-size+operation timeouts) wrapping `extractor` Tier-3b/`agentBrowser.readWithInteractiveProfile` semantics. Rule 9 applies here — this is a NEW endpoint, not a port of a deleted one.
- Windows process supervision: `npm run dev` must spawn `ruke-server.exe` as a DIRECT child (Rule 12) and kill it on exit. **IMPLEMENTED Part 8** as `scripts/dev-supervisor.mjs` (spawn both children non-detached; `taskkill /PID <pid> /T /F` cascade on SIGINT/SIGTERM/exit/first-child-exit; wildcard dual-stack port pre-check — a 127.0.0.1-only probe can SUCCEED on Windows beside a `0.0.0.0`/`[::]` holder, which previously let Next fall back to :3001 and break the bridge base-URL contract). `npm run dev` → supervisor; plain `next dev` preserved as `npm run dev:next`. **LIFECYCLE CORRECTION 2026-10-27 (`8-fix` row):** the supervisor now runs `cargo build --manifest-path rust-backend/Cargo.toml` itself as a supervised child BEFORE anything starts (interrupt tears down exactly the supervisor-owned cargo/rustc/linker tree, PID-scoped; a compile failure preserves cargo output, starts nothing, exits non-zero) — `npm run dev` alone is sufficient, no manual build ever required. `CARGO_TARGET_DIR` is resolved against the repo root for exe lookup; `RUKE_SERVER_BIN` set ⇒ cargo build SKIPPED (advanced override, exe must exist). SIGBREAK (Ctrl+Break) added to the teardown signal set.
- **Cutover switch (Part 8, implemented):** `lib/server/rustProxy.ts` — all 20 migrated handlers across 14 `app/api/**` route files early-return `rustProxy(req, <rust path>)` ONLY when `RUKE_RUST_BACKEND=1` (exported solely by the supervisor). Unset ⇒ every vitest run and plain `next dev` executes the TS handler verbatim (Rule 18: TS intact; in-process goldens untouched). Proxy failure stance: log via console (NOT pino — logger.ts is DELETE_AFTER_PARITY) + honest 502 `{"error":"Rust backend unreachable at <base>"}`; NO silent TS fallback (one turn must not span two backends).
- **Bridge endpoint (Part 8, implemented):** `app/api/internal/browser-read/route.ts` answers the `HttpBrowserBridge` wire (`{"url","timeoutMs?"}` + `x-ruke-internal-secret`, `timingSafeEqual`; secret env unset ⇒ 401 for every caller). Rust-side facts: deadline `timeout_ms.unwrap_or(40_000)+20_000` ms; client-side `ssrf::is_safe_url` pre-check returns a zeroed extraction WITHOUT the hop; Rust force-echoes `out.url = request url` (micro-divergence: TS sets `out.url` from the argument). SSRF re-validation on the Next leg runs the same `extractPageInOnePass` guard chain as native TS reads.
- **Env handoff (Part 8):** supervisor → rust child: `RUKE_PROJECT_ROOT`, `RUKE_BACKEND_PORT`, `RUKE_BROWSER_BRIDGE_BASE_URL` (= `http://127.0.0.1:<PORT>`), `RUKE_BROWSER_BRIDGE_SECRET` (random per-run hex). supervisor → next child: `RUKE_RUST_BACKEND=1`, `RUKE_BACKEND_PORT`, `RUKE_BROWSER_BRIDGE_SECRET`. Ports: Next `PORT` (3000), Rust `RUKE_BACKEND_PORT` (3101, loopback). Rule 17: neither the secret nor settings contents are ever logged (`ruke-server` logs bridge config as boolean only).

## 8. Performance baseline (Rule 15) — **RECORDED 2026-10-26, `rust-backend/perf/baseline-measure.sh` → `results-*.log` + `ws-13004.csv`**

TS stack (Next dev `:3000` PID 13004, dev-mode; Strata `:8080` PID 14904 external, excluded):

| Metric | Value |
|---|---|
| Idle WS | **1,931 MB** |
| Peak WS across probe run | **2,514 MB** (504 samples @400 ms) |
| Repeated-turn WS growth ×10 tiny non-stream | 2,212 → 2,156 MB — **no leak** |
| GET routing latency (warm) | conversations 5.3–5.7 ms; settings 4.5–4.9 ms; model-stats 6.3–6.6 ms (first-hit cold: 0.68 s / 0.19 s) |
| Time-to-first-progress-event (warm) | **39–47 ms** (`decision_done`, ms=0 — in-process router) |
| TTFT tiny turn (gate unexpectedly searched: full research cycle) | **28.6 s** |
| TTFT post-cancel tiny turn (no research) | **2.9 s** |
| TTFT forced research turn | **12.7 s**; 18 stage frames (gate→planning→searching(3 pools)→reading(11)→reranking→done) |
| Each tiny non-stream turn total | ≈ 4.0 s (gate generation + answer generation — the gate is a MAIN-MODEL call every turn; budget 2 generations per turn in Rust parity) |
| Cancellation latency | curl killed at +3 s (175 bytes received); next turn first-stage at **47 ms** → slot released promptly, **no zombie turn** (TS behavior to match) |

Caveats (honest): dev-mode Next (HMR/cache) inflates RSS — the Rust comparison MUST re-run this same harness on dev-mode for apples-to-apples, and additionally report prod `next start` numbers if the brief's RAM claims need justification. One "tiny" probe unexpectedly triggered the full research pipeline (gate misfire on a reply-only prompt) — logged as genuine baseline behavior the Rust gate port will be judged against. Rust re-measure post-Part 10 uses the identical script; report real deltas only (Rule 15).

## 9. Architecture decisions — **FROZEN 2026-10-26 (user-approved)**

1. **Embedding**: ONNX-in-Node (`@huggingface/transformers`, `.data/models`) — stays Node.
2. **Attach index build**: stays Node (extract→chunk→embed→store); Rust owns read/retrieve/notes against the frozen store format.
3. **3d/assets + anatomy + documents export**: stay Node.
4. **Tier-3b browser access**: NEW loopback RPC with process-local secret (Rule 9).
5. **Baseline load probes**: run now, as the closing step of Phase 0 (results in §8).

## 10. Part sequence (proposal)

### Part status tracker

| Part | Status | Evidence / notes |
|---|---|---|
| 1 | **DONE 2026-10-26** | Workspace `rust-backend/` (`ruke-contracts`, `ruke-core`, `ruke-server` bin). 28 unit/contract tests green (`cargo test`), clippy clean, release build + loopback smoke: `GET /api/ruke/health` OK on 127.0.0.1:3101, `POST /api/chat` → 404 (zero cut-over). Env: machine had **no C linker**; installed VS 2022 Build Tools (VC++ 14.44 + Win SDK 10.0.26100) via winget — `x86_64-pc-windows-msvc` now builds. KNOWN PARITY NOTE: serde_json writes `confidence: 1` as `1.0` (JS writes `1`) — Part 2 goldens must normalize or Part 4 adds a JS-number serializer. |
| 2 | **DONE 2026-10-26** | Golden-contract corpus `rust-backend/fixtures/` (44 JSON fixtures, layout per §5: chat 11 / errors 8 / sse 3 / skills 5 / decision 5 + serialization 1 / attachments 6 / web-search 5) + deterministic harness `__tests__/rust-golden/` (7 suites, 41 tests; scripted mock upstream, zero live Strata). ALL 19 §6-Rule-3 scenarios covered; every fixture carries inline `_meta` (scenario/semantics/comparison class/harness/env/normalization); drift-guard re-records (first-diff) + replay-parity proven by double-run. Comparison classes: byte-exact / structural / semantic / approved-deviation (sse 02/03 think+UTF-8 split matrices = approved-deviation targets for Part 4, incl. unterminated-block semantics). Contract discoveries pinned: `confidence: 1` integer vs serde `1.0` (Part 4 serializer must emit `1`; `lfm_input`/`lfm_raw` OMITTED not null); web-evidence + attachment + skill injection at `lastUserIdx+1` off-by-one family (RECORDED, TS untouched); `runVisionEntityPrepass` DEAD (zero call sites; route comment lies); gate never runs the main model under hard-bypass; evidence block layout quirk: `</evidence>` closes the guideline header BEFORE the [S#] passages; two web-failure shapes (starved sentinel vs route catch); metasearch 15s uncleared hard-cap timer. KNOWN-PRE-EXISTING failure (not Part 2): `__tests__/skills/chatEngine.test.ts` 2/7 red standalone (`## Browser agent` block expected, 0 injected — internal-browser subsystem, since REMOVED repo-wide 2026-10-26; test expectations updated to pin the removal — chatEngine 7/7 green post-cleanup). Full corpus (at Part-2 recording): 657 passed / 2 failed / 1 skipped; `npx tsc --noEmit` exit 0; cargo check/test/clippy exit 0. No TS behavior changed, no cutover, no Playwright (lock protocol uninvoked). |
| 3 | **DONE 2026-10-26** | Decision engine + core-skill loading ported to Rust: new crates `ruke-decision` (engine.rs INTENT_MATCHERS/INTENT_ORDER/getDecisionSync/decisionRoute + contracts.rs generated MODE_CONTRACTS/MODE_FENCE/MODE_SKILL via `scripts/gen-mode-contracts.mjs`; skill_block.rs `<decision_skill>` builder) and `ruke-skills` (jsstr UTF-16/JS-trim/truthiness, jspath lexical resolve, registry, lazy.rs slash routing §11, core_skill.rs `.cskills` loader with strip/cap parity). Regex parity without look-around documented per-port (consuming-boundary classes; ASSET3D verb/target bridge; `résumé` é-ending boundary polarity — demands a WORD char next, matching JS; dotted `\.xlsx|\.docx|\.pptx` alternatives proven DOMINATED by bare siblings in JS too, so uniform group classes are existence-equivalent). §14 RESOLVED NOW: narrow JS-compatible number serializer emits integral `confidence:1` + omits `lfm_input`/`lfm_raw` (fixtures untouched, `envelopeKeyOrder` pinned). New golden suites `decision-parity.test.ts` (74 intent vectors `decision/06` + MODE_CONTRACTS sha256 hashes `skills/06`) recorded from live TS oracle; Rust integration replay `crates/ruke-decision/tests/fixture_replay.rs` **9/9 green**: decision 01–05 byte-exact, 06 vectors field-for-field, skills 01–03 slash-routing string-equal + header, 04 decision_skill block string-identical (sha `82fc8045…`, 11204 B), 05 passthrough block string-identical (sha `ed1baf3f…`, 11194 B), skills/06 contract constants hash-verified. §20: cargo test --workspace 81 passed; clippy `--all-targets -D warnings` exit 0; cargo check exit 0; `npx tsc --noEmit` exit 0; full vitest **661 passed / 1 skipped** exit 0 (one earlier full-run sampling showed 4 load-contention flakes in chatEngine/web.test — 5 s timeouts + mock race; NOT reproducible standalone or on rerun). NO cutover: `app/api/chat/route.ts` untouched, Rust slash routing kept DISCONNECTED; TS decision/skill implementations intact; no Playwright (lock protocol uninvoked), Strata :8080 untouched. |
| 4 | **DONE 2026-10-26** | Chat core ported into `ruke-server` (`src/chat/{mod,handler,pipeline,attach,forward,scrubber,sse,headers,error}.rs`): request parse + capped read, malformed-JSON raw-bytes passthrough, `model` default `"default"`, compaction passthrough (purpose deleted + `attachment_ref` parts stripped, always legacy), pinned `decision_mode` consumed by the gate then always deleted, BOTH response paths (legacy strict `stream === false`; progress early-open `ruke_stage`/`ruke_error`/`[DONE]` grammar, closed latch, route NEVER self-appends `[DONE]` after raw upstream bytes), application headers, full error contract (legacy mirrors upstream status `{"error":"Upstream returned N[: errText≤200 UTF-16 units]"}`; 502 `No response body from model` from 204/205/304 only — 200+`content-length:0` HAS a body; 503 `Could not reach the model server at <host>|the configured port`; progress = same strings in ONE `ruke_error` frame + exactly one `[DONE]`), client-abort propagation, exactly-once inference-slot release (RAII `UserTurnGuard`), cancellation-tree child tokens, bounded-backpressure pump (64-deep mpsc). Scrubber = the §10/§21 approved deviation implemented: byte-level incremental state machine reproduces **atomic** scrub semantics at every split point (never the mangled TS per-chunk bytes; UTF-8-safe by construction). New replays: `crates/ruke-server/tests/golden_replay.rs` **19/19** (chat 01–06b,08 byte-exact incl. byte-identical forwarded upstream body; 06a/06b reproduce the recorded `<decision_skill>` block byte-for-byte from the real `.cskills` → Part-3 parity end-to-end; errors 01–08 full app header-set + body; chat/07 over a REAL socket: client drop → upstream-abort witness + slot release) and `tests/scrubber_vectors.rs` **2/2** (sse/02+03 every split point, byte-at-a-time). Two contract discoveries: (a) **content-length** — axum 0.8's top-level `RouteFuture` inserts CL from the body's exact size hint (hyper derives it for known-length bodies too), while the oracle's `NextResponse.json` app-level set is content-type ONLY ⇒ `json_error` presents a one-frame-stream body (unknown hint): app-level set matches fixtures verbatim, wire is chunked vs Node's CL (invisible to fetch clients); (b) no-body fixtures = undici `body===null` ⇒ replays script HTTP **204**. Replay-driven fix: scrubber holdback = longest tail that is a PROPER prefix of a tag (a fixed `len(tag)-1` holdback stranded the literal tail bytes of an SSE frame when upstream went quiet before EOF — chat/07 pinned the stall). PART-5/6 insertion seams documented in `pipeline.rs` (retrieval/web-gate frame + token wiring points; NO fake success frames — corpus was recorded gate-disabled and attachment turns have no replay fixture, so the Part-4 frame set is byte-identical). §28: `cargo test --workspace` **126 passed** exit 0 (new 21: 19 replay + 2 vectors); `cargo clippy --workspace --all-targets -- -D warnings` exit 0; `cargo check` exit 0; `npx tsc --noEmit` exit 0; `npx vitest run __tests__/rust-golden` **43/43** exit 0 on rerun (first batch run: web.test ×3 drift-guard FLAKES under parallel load — same family recorded in STATE Session-D 8.6; standalone 5/5; zero fixture mutation, git-verified). NO cutover: `app/api/chat/route.ts` untouched, Next still owns ALL live traffic; Rust `/api/chat` exists only inside the isolated `ruke-server`; no Playwright (lock protocol uninvoked); Strata `:8080` never contacted (mock upstreams only). |
| 5 | **DONE 2026-10-27** | Attachment READ side ported: new crate `ruke-attach` (8 modules: store reader for the FROZEN Node disk format — `meta.json`/`chunks.jsonl`/`full.txt`/`notes.json`/frames, no second index DB; BM25 + cosine + RRF pack TOP_K=8/BUDGET=24000/MAX_FRAMES=4 — no "better" BM25 variant; `route_query` point_qa/time_range/whole_video; `generate_notes` spine notes w/ LLM seam; `build_attachment_turn`/`collect_attachment_refs`; `QueryEmbedder` seam — production is `UnavailableEmbedder`, NO second embedding model) wired into the Part-4 pipeline seam in `ruke-server` (`src/chat/pipeline.rs` step-5: skill→decision→skill-inject→retrieval→web seam→strip→upstream; `retrieval`/`retrieval_done` frames; nonfatal on failure — never `ruke_error`; direct Rust-only notes route `/api/ruke/attach/{id}/notes` — NOT proxied by Next, cutover stays Part 8). The `lastUserIdx + 1` unconditional injection quirk is REPRODUCED, not fixed (§8). Cross-language store fixture: `rust-backend/fixtures/attachments/store/` holds PRODUCTION-Node-writer bytes (recorded by `__tests__/rust-golden/store-fixture.test.ts`, drift guard + `RUKE_WRITE_STORE_FIXTURE=1` regen; seeds shared with `attachments.test.ts` via `support/attach-seeds.ts`); Rust copies them VERBATIM, never reconstructs. New Rust tests: `attachment_replay.rs` 6/6 (fixtures 01–06 through the FULL chat pipeline, byte-identical forwarded bodies), `store_compat.rs` 6/6 (field-by-field parse + BYTE-EXACT `<knowledge_index>` blocks vs TS oracle incl. honest-missing block, dropped-keyframe quirk, shift-correct keyframe data-url), notes route 4/4. Checks: `cargo test --workspace` **187 passed**; clippy `--workspace --all-targets -- -D warnings` exit 0; `cargo check --workspace --all-targets` exit 0; `npx tsc --noEmit` exit 0; `npx vitest run __tests__/rust-golden` 43/46 (web.test ×3 = known parallel-load drift-guard flakes, standalone 5/5 — zero fixture mutation); Part-4 goldens rerun green inside the 187. NO cutover, no Playwright, Strata untouched. |
| 6 | **DONE 2026-10-27** | Full `lib/web-search/**` port into crate `ruke-websearch` (8 incremental commits `fc35afc`→`08feb45` + final pipeline commit): `net.rs`/`ssrf.rs`/`cache.rs` (hashed `query_cache_key` "q:" writes, "p:" page writes, ScriptedNet/ScriptedCache), `engines.rs` (quorum/cooldown/breaker + charset/schema/hydration + reranker + search-gate), `metasearch.rs` (15 s uncleared hard-cap honored), `query_planner.rs`, `universal_extractor.rs`, `platform_api.rs`, `redirect_unwrap.rs`, `google_maps.rs`, `youtube.rs` (companion query `"<title>" "<channel>"` ≤200 chars), `url_detector.rs` (pass-1/pass-2 double-detection quirk: a scheme `www.` prompt URL becomes TWO Stage-0 direct targets incl. `"https://"+raw.toLowerCase()`), `extractor.rs` (tier cascade; `on_page` made Send-complete; `done_pages` AtomicUsize — RECORDED micro-divergence), `browser_bridge.rs` (§7 Tier-3b RPC seam: `NoBrowserBridge` production default until Part 8, `HttpBrowserBridge` w/ `x-ruke-internal-secret` + env `RUKE_BROWSER_BRIDGE_BASE_URL/SECRET`, `ScriptedBridge` mock-only — real Playwright Part 10), `vision_prepass.rs` (DEAD-module proof: `runVisionEntityPrepass` never called; Rust also never calls), `pipeline.rs` (`run_web_research` entry, 240 s ceiling, `evidence_block` byte-exact incl. the `</evidence>`-stays-in-header quirk, `ANTI_REFUSAL_DIRECTIVE`, `MergeKey::Obj(nonce)` = pipeline.ts:687 object-identity dedup quirk — prompt video packets never merge, `js_to_fixed2` = exact ECMA-262 `toFixed(2)` via IEEE bit-decomposition tie detection (2.675→"2.67", 0.125→"0.13"; replaces the earlier naive-rounding bug)). Checks: `cargo test -p ruke-websearch` **274 passed** (15 new pipeline tests pinning hops/dedup/cache-write/evidence bytes); `cargo test --workspace` **461 passed**; clippy `--all-targets -D warnings` exit 0; `npx tsc --noEmit` exit 0; full `npx vitest run` **664 passed / 1 skipped** exit 0 (an earlier rust-golden sampling showed fixtures 01/02/05 drift — non-reproducible on unchanged rerun; matches the recorded pre-existing parallel-load flake family, STATE 8.6; zero fixture mutation, git-verified). No cutover (web seam in `ruke-server` still unwired — Part 8), no Playwright/lock, Strata `:8080` untouched, TS modules intact. |
| 7 | **DONE 2026-10-27** | Server-state services ported into `ruke-server`: `persistence.rs` (disk.ts + merge.ts — sanitized `file(id)`, raw-name-list/re-stat quirk, 5000 ms raw-keyed tombstone w/ `save_at`/`delete_at` clock seams, `js_ms_number`, `mergeProtectedTitle` incl. strict-mode-throw catch), `conversations_routes.rs` (GET list + GET/POST/DELETE single + `X-Web-*`-free plain JSON contract; null-body `body.id` TypeError ⇒ 500 arm; truthy-non-string id ⇒ 500), `titles/{policy,transcript,generate,queue}.rs` (ownership + refresh eligibility verbatim incl. first-time `count>=2` rule, guarded write, UTF-16-capped transcript w/ join-quirk `String([1,null,"x"])`="1,,x", normalize-title guard ladder — the WSI-class regexes are BRACKETED `[{WSI}]` (bare `{WSI}` compiles to a literal escape run; recorded fix), map-reduce plan, global serial queue w/ per-conv coalescing + slot-aware yield + bounded retries), `settings_routes.rs`, `model_stats.rs`, `skills_routes.rs` + `skills_install.rs` (`npx skills add` pump, tokio::process, secret-free), `attach_notes.rs` route; `ruke-skills` gains `frontmatter.rs` + `modality.rs` + jsstr additions. Contract/parity decisions pinned in-module: array-`meta` title write ⇒ Ok(true) doc-unchanged (JS expando dropped by stringify), primitive-`meta` ⇒ Err ⇒ 500 (strict-mode TypeError), astral sanitizer 2-vs-1 underscore micro (unreachable UI ids), DATA_DIR HOME-fallback resolve (no crash). Checks: `cargo test --workspace` **540 passed** (ruke-server 123: 90 lib + 19/6/2/6 integration); clippy `--workspace --all-targets -- -D warnings` exit 0; `npx tsc --noEmit` exit 0; full `npx vitest run` **664 passed / 1 skipped** on rerun (first run: ONE `chatEngine.test.ts` 5 s timeout flake — passes standalone 550 ms + rerun green; same parallel-load family as the recorded web.test.ts flakes, zero test/fixture mutation). NO cutover: routes live ONLY under `/api/ruke/*` inside the isolated server (guard test pins legacy paths 404); Next still owns all live traffic; no Playwright/lock; Strata `:8080` untouched; TS modules intact. |
| 8 | **DONE 2026-10-27** | Cutover machinery + the last backend seam. RUST: chat web-research seam LIVE in `chat/pipeline.rs` (full `ruke-websearch` gate/retrieval, `web:<stage>` try_stage frames, `web_meta` frame, citation/gate header pairing §2.2/2.3 — progress-path headers built BEFORE the gate ⇒ progress path never carries web headers; cancel AtomicBool + AbortOnDrop pump watcher); new `search_routes.rs` (GET `/api/ruke/search`: no-q `{"results":[]}` incl. empty `?q=`, `raw=1` engine-pool, else full research; 502 `Search pipeline failed:`; Ok(None) ⇒ `No web evidence could be retrieved.`; POST `/api/ruke/search-more`: 400 malformed/empty-queries arms, filter-then-take(3), integer `ms`) + `decision_routes.rs` (`/api/ruke/decision`; both 400 bodies byte-pinned; snake_case envelope — `DecisionEnvelope` has no `rename_all`); `AppState.web = WebRuntime` (`RealNet` + `SqliteSearchCache` under project root + purge sweep + `RealVerticals` + bridge). TS: `lib/server/rustProxy.ts` (hop-by-hop filtering both legs; body `duplex:"half"` stream pass-through; `req.signal`; streamed Response re-emit keeps SSE) armed ONLY by `RUKE_RUST_BACKEND=1` — unset ⇒ TS handlers verbatim everywhere (vitest, `dev:next`, any non-supervisor process); `app/api/internal/browser-read/route.ts` (Tier-3b RPC per §7); `scripts/dev-supervisor.mjs` (Rule 12 direct children, env+secret handoff, wildcard port pre-check, `taskkill /T /F` cascade, first-child-exit ownership, exit-code propagation); `package.json` `dev`→supervisor, old `next dev` kept as `dev:next`, `predev` kept. RECORDED divergences: (a) `?raw=1` TS 502-catch unreachable in Rust (`runGeneralWebSearch` infallible); (b) `search-more`: TS `req.signal` unwired — Rust does not abort mid-call either; TS uncaught throw ⇒ Next-500-HTML vs Rust logged bare-500-JSON; (c) proxy-failure honest 502 + console.error-not-pino stance above; (d) `try_stage` can drop a progress frame under a full pump queue (sse.rs MICRO-DIVERGENCE). Env: see §7 records. Checks: `cargo test --workspace` **548 passed** (incl. 8 new Part-8 route/pipeline tests); clippy `--workspace --all-targets -- -D warnings` exit 0; `cargo build` exe present; `npx tsc --noEmit` exit 0; full `npx vitest run` **664 passed / 1 skipped** exit 0 on rerun (first run ONE `chatEngine.test.ts` 5 s timeout flake — standalone 565 ms green + rerun green; same parallel-load family, zero test mutation). Curl-only smokes (NO Playwright, no lock): binary vs temp `RUKE_PROJECT_ROOT`+`WEBUI_DATA_DIR` — health/settings/decision 200+400 byte-exact/search short-circuit/search-more 400/conversations CRUD/model-stats dead-upstream `{"ok":false}`/bridge-degrades-without-env; supervisor live smokes (default ports AND `PORT=3200`+`RUKE_BACKEND_PORT=3998`) — proxied `GET /api/settings` payload **byte-identical** to the TS control answered by the user's untouched pre-session :3000 server, decision/search 400/short-circuit arms via proxy, `browser-read` no-secret ⇒ 401, supervisor refuses boot pre-spawn when a port is held (verified against the real :3000 holder), teardown cascades free both ports while :3000 survives. Strata `:8080` never contacted; live settings/conversations only READ during smokes (all writes into temp dirs); all TS implementations intact (Rule 18); Parts 9/10 untouched. |
| 8-fix | **DONE 2026-10-27** | PART-8 LIFECYCLE CORRECTION (`fix: auto-build Rust backend in RUKE dev supervisor`; ONLY `scripts/dev-supervisor.mjs` — zero product behavior touched). The original Part-8 supervisor REQUIRED a pre-built `ruke-server.exe` and pointed at a manual `cargo build` when missing — `npm run dev` was NOT self-sufficient from a clean checkout. Corrected lifecycle: root → ports → validate → pre-spawn port pre-check (fail-fast, BEFORE cargo) → `cargo build --manifest-path rust-backend/Cargo.toml` ALWAYS (supervised child; SIGINT/SIGBREAK/SIGTERM tears down exactly the supervisor-owned cargo/rustc/linker tree via PID-scoped `taskkill /T /F` — never image-name kills; failure ⇒ cargo output preserved + "Rust backend build failed" + nothing started + non-zero exit) → exe located (`CARGO_TARGET_DIR` resolved against repo root else `rust-backend/target/debug`; `RUKE_SERVER_BIN` ⇒ build SKIPPED, existence required) → bridge secret → env → spawn `ruke-server.exe` directly (NOT `cargo run`; 30 s `/api/ruke/health` gate) → spawn `next dev` (60 s TCP gate; no silent 3001 fallback) → ready banner ONLY when both actually ready → supervise (either child exits ⇒ both trees torn down, non-zero exit; `process.on("exit")` safety net). Windows SIGBREAK handler added (Ctrl+Break ⇒ teardown(130)). AUTOMATED SCENARIOS A–H ALL PASS (no Playwright, no lock): A deleted exe ⇒ cargo auto-rebuilds, READY; B up-to-date ⇒ READY <60 s, cargo prints no "Compiling"; C source-change ⇒ "Compiling ruke-server v0.1.0" (marker reverted, git clean); D injected `E0308` ⇒ clear failure message, no children, ports never occupied, non-zero exit, repo restored; E CTRL_BREAK_EVENT ⇒ captured exit 130 (proves JS SIGBREAK teardown, not node's default 0xC000013A break-kill), ports freed, 0 orphans — automated CTRL_C_EVENT is UNDELIVERABLE to any process in this environment (kernel32 broadcast returns true but nothing receives it; compiled-C#-handler witness recorded only the BREAK event), live Ctrl+C covered by manual regression journey §7.7; F ruke-server killed by PID ⇒ Next torn down, exit 1, 0 orphans; G next killed ⇒ Rust torn down, exit 1, 0 orphans; H stale real holders (ruke-server.exe :3101 / node wildcard :3000) ⇒ refuse boot BEFORE cargo, no fallback. Gates: cargo test --workspace 548/0; clippy -D warnings exit 0; cargo check --all-targets exit 0; tsc exit 0; vitest full 662 passed/1 skipped + 2 web.test flakes (adjudicated; root cause FOUND: fixtures 01/02/05 pin live browser-pool renderings of old.reddit.com — BM25 digits shift with live content, standalone 5/5 green repeatedly, zero mutations). `npm run dev:next` untouched. Parts 9/10 untouched. |
| 8-fix2 | **DONE 2026-10-28** | PART-8 MANUAL-REGRESSION FIX (`fix: distinguish Rust proxy cancellation from backend failure`; ONLY `lib/server/rustProxy.ts` + new `__tests__/rust-proxy.test.ts` — Rust title/chat/search semantics ZERO touched). Manual-checkpoint false diagnostic: a browser abandoning a title request makes Next abort `req.signal` with a `DOMException` named `ResponseAborted`; that signal is forwarded to the upstream fetch, and per the fetch spec undici rejects the in-flight fetch with the signal's ABORT REASON — so the proxy's single unconditional catch stamped a healthy Rust title queue with `unreachable [ResponseAborted]` + false 502. The catch now classifies THREE failure classes: (A) downstream cancellation — `isDownstreamCancellation(err, signal)` checks `signal.aborted` FIRST (name-independent; the forwarded signal is the only possible aborter of the upstream fetch) then names `AbortError`/`ResponseAborted` ⇒ `console.debug … cancelled by downstream client` (low severity; the word "unreachable" NEVER appears) + 204 (never actually delivered); Rust-side semantics keep running. (B) genuine connectivity — ALL unknown errors FAIL CLOSED here ⇒ unchanged Part-8 honest 502 `{"error":"Rust backend unreachable at <base>"}` + `console.error … unreachable [<code>]`, `connectivityCode` = `err.cause?.code ?? cause?.name ?? name ?? "unknown"` (undici puts the errno on `cause`). (C) genuine Rust responses (4xx/5xx/stream/normal) pass through untouched — the catch never sees those legs. Tests: `__tests__/rust-proxy.test.ts` 7/7 green (real loopback HTTP, no fetch mocks; mock Rust mirrors the real title route's accept-then-hold; dead-backend arm uses loopback port :3 NOT the Rust-side `127.0.0.1:9` convention — undici rejects WHATWG-blocked ports at parse time with a code-less "bad port" TypeError, so the reqwest convention cannot cross the undici seam). Gates: tsc 0; targeted vitest (rust-proxy + titles + rust-golden) 13 files/101 passed; FULL vitest **64 files / 671 passed / 1 skipped / 0 failed** exit 0 (web.test/chatEngine green under parallel load this run — no flake adjudication needed, zero test mutations); cargo test --workspace 548/0 exit 0; clippy `-D warnings` clean. MANUAL REPRO (§13, live supervisor `PORT=3210`/`RUKE_BACKEND_PORT=3102` + model stub :8799, Strata down, NO Playwright, no lock): (1) title POST abandoned mid-generation ⇒ `… cancelled by downstream client` debug line, ZERO "unreachable", no false 502, queue survival witness `{"queued":true,"coalesced":true}` after abandonment; (2) chat stopped 2 s mid-stream ⇒ stub `MODEL STREAM TORN MID-STREAM after 4 tokens` + same-ms Rust WARN `llm stream aborted by client`, ZERO rust-proxy lines; (3) killed ONLY the supervised ruke-server by PID ⇒ first proxied request **502 `{"error":"Rust backend unreachable at http://127.0.0.1:3102"}`** + `unreachable [ECONNREFUSED]` code-tag log, supervisor first-child-exit cascade then all ports free. Honest caveats: the end-to-end persisted-title-after-release cycle was not cleanly captured in the live harness (stub restarts dropped in-flight model calls — harness artifact; the persistence path is Rust-side, untouched, covered by Rust queue tests); stub-garbage search-gate answers fired the pre-existing 35 s MAIN_GATE_TIMEOUT + real web searches (`ruke_websearch::search_gate` "gate unreachable/timeout" vocabulary — DIFFERENT seam, not the proxy, untouched). Parts 9/10 untouched; the Part-8 manual checkpoint is NOT marked passed. |
| 9 | **DONE 2026-10-28** | Rust↔TypeScript contract-drift protection. Repository-evidence SHARED_CONTRACT inventory (no invented deps — the repo's established TS-oracle→generated-file + hash-fixture + golden-drift pattern, no ts-rs exists here): `RENDERER_MODES`/`MODE_SKILL`/`MODE_FENCE`, `DecisionRequest`/`DecisionEnvelope` (omitted-vs-explicit-null classes, snake_case wire, integral `confidence:1`), `StageEvent` + nested webCitations/searchGate/queries ledgers (Rust emits manifest minus documented `legacyReadOnlyFields:[researchLfm]`), `SettingsShape`+`compact_thresholds`, SSE frame keys `ruke_stage`/`ruke_error`/`[DONE]`, chat headers x-decision-mode/x-used-skill/x-web-citations/x-search-gate (RECORDED rule: HTTP field names are case-insensitive; Rust http crate forces lowercase, TS route historically PascalCase ⇒ binders compare case-insensitively; manifest `headersCaseRule`), internal RPC seam (`x-ruke-internal-secret`, paths `/api/internal/{browser-read,youtube-evidence,media-transcript}` + exact error bodies + request/response field ledgers, deadline rules browser-read `timeoutMs` default 40000 + 20000 slack & youtube `RPC_DEADLINE_MS 90000` compile-guarded 70000..120000, env handoff `RUKE_BROWSER_BRIDGE_BASE_URL/SECRET` + `RUKE_RUST_BACKEND/BACKEND_PORT/PROJECT_ROOT/SERVER_BIN`, honest-502 proxy-failure contract; per-mode contractBlocks deliberately NOT duplicated here — stay pinned by `skills/06` hashes + `ruke-decision/tests/fixture_replay.rs`). New `scripts/contractParse.mjs` (dependency-free TS-interface extractor: brace-match, top-level member split, optional/nullable classification, inline-object ledger ≤2 deep) shared by generator + vitest binder. New `scripts/gen-contract-manifest.mjs` → deterministic `fixtures/contracts/manifest.json` (no timestamps, fixed insertion order, 2-space JSON; `--check` = byte-compare with first-differing-line report); `gen-mode-contracts.mjs` gains `--check`; npm `contracts:generate`/`contracts:check` run both. THREE binders: Rust `crates/ruke-contracts/tests/manifest_drift.rs` **6/6** (document-order `top_level_keys` scanner proves envelope serialized key ORDER == TS declaration order; fallback omits optionals while always-present nullables render explicit null; `Some(None)`→null not omission; integral confidence byte `1`; nested Citation/ResearchMeta/GateQuery ledgers; SettingsShape `{}` when default); Rust `crates/ruke-websearch/tests/manifest_drift.rs` **5/5** (RPC consts vs live `SECRET_HEADER/READ_PATH/EVIDENCE_PATH/ENV_*`; `deadline_ms` (pub-widened, behavior unchanged) reproduces manifest deadline rule; `OnePassExtraction` accepts EXACTLY the manifest responseFields key set and rejects renames via `deny_unknown_fields`; Rule-17 mechanical scan: no log-macro line mentions `secret` in either bridge module); TS `__tests__/rust-golden/contract-manifest.test.ts` **8/8** (live runtime tables vs manifest; the four interfaces RE-EXTRACTED from live TS sources ⇒ TS-side drift fails without regeneration; RPC route sources contain the secret header + exact quoted error bodies + request fields; `extractor.ts` produces every responseFields key; supervisor sets all six env names; header names present BOTH sides; DecisionRequest camelCase cross-binds ruke-decision `engine.rs` `.get("conversationHistory")`; Rule-17 console-args scan strips string literals then flags bare `secret` identifier leaks; honest-502 literal prefix + status). Binder caught two facts on first run and documented rather than forced: DecisionRequest leg is camelCase (Rust engine reads it as such) and the header-casing asymmetry. Gates: `cargo test --workspace` **564 passed / 0 failed**; clippy `--workspace --all-targets -- -D warnings` exit 0; `npx tsc --noEmit` exit 0; `npm run contracts:check` OK both generators; determinism proven (generate→hash→generate→byte-identical); `npx vitest run __tests__/rust-golden` 54/54 on rerun (2 first-run failures = recorded parallel-load flake family: standalone `web.test.ts` 5/5 green, zero test/fixture mutation); full `npx vitest run` 68/69 files (same `web.test.ts` family, standalone green). Only product-source change: one `pub` visibility widening (`browser_bridge.rs::deadline_ms`). No cutover change, no TS handler retired, no Playwright (lock protocol uninvoked), Strata `:8080` untouched. |
| 10 | PENDING | |

1. Rust workspace scaffold + config/settings + `tracing` + CancellationToken core.
2. Golden-fixture harness (TS baseline recorded; mock upstream server; all §6 rows green vs TS).
3. Decision + skills/lazy + skill-loader + `passthroughEnvelope` parity.
4. Chat core: stream scrubber state machine, both response paths, error contract, headers.
5. Attach retrieval + notes + store reader (fixtures vs same `.data` store).
6. Web-search: net/ssrf/cache/engines/metasearch + pipeline stages (Node bridge for Tier-3b).
7. Conversations/titles/model-stats + inference-slot coordination.
8. Thin proxies (Rule 11) + `npm run dev`/`build` supervision (Rules 12–13).
9. Contract drift tests (ts-rs generation for SHARED_CONTRACT set).
10. Playwright full suite (lock protocol) + perf re-measure + deletion pass (Rule 18).

## 11. APPROVED PARITY DEVIATION LOG (user-approved 2026-10-28, Part-10)

### 11.1 Universal deterministic search pre-gate + runtime date-aware freshness

**Approved parity deviation: universal deterministic search pre-gate + runtime
freshness awareness.** Intentionally changes BOTH the TS oracle
(`lib/web-search/search-gate.ts`) and Rust behavior
(`ruke-websearch/src/search_gate.rs`) **identically** — parity is preserved by
deviating both epochs in lockstep, never one.

- **Root cause (observed in Part-10 Playwright recon):** the probabilistic
  gate model VETOED deterministic turns. 36/36 attachment meta-prompt turns
  ("Read the attached file and reply YES if you can read it.") received
  main-model `search_required: YES` and the planner searched the user's own
  operational INSTRUCTION (top results: geeksforgeeks/cfengine/howtosayguide).
  The attachment-only suppression rule (epoch 1) fixed the attachment case but
  left the same bug class live for prompts WITHOUT an attachment; and the gate
  prompt had no notion of the present date, so staleness questions were judged
  against frozen training knowledge (the model could neither confirm nor
  reliably deny "still maintained").
- **Previous behavior:** Stage-0 bypass covered only URLs/known domains/narrow
  web-intent words/image-intent/attachment-evidence; everything else (codegen,
  math, supplied-content transforms, explicitly-local-only turns, freshness
  questions) went to the 35 s main-model gate, whose verdict was
  probabilistic in BOTH directions.
- **New three-layer flow (both epochs, same order — FRESHNESS NEVER LOSES):**
  url → **FRESHNESS force-YES** (phrase-anchored high-confidence staleness
  shapes: weather/forecast, how-much…cost/price/worth ≤40 chars, this
  week/month/year, most recent, as-of-now, up-to-date, still
  supported/available/maintained/…, who is/are the [office holder],
  current/latest version/release) → **E1 local-only force-NO** (user
  explicitly scoped the turn: "do not search", "only from the attached…";
  DELIBERATELY has no escape hatch — its own phrase list contains "web", so an
  escape check would self-cancel the user's instruction; guarded instead by a
  RESIDUAL RE-TEST: the matched span is stripped from the prompt and the
  narrowed web/freshness regexes re-run against the residual, so
  "Do not search the web; answer from the pasted code only." skips but a
  residual live-intent would not) → web-intent → image → attachment →
  **E2 self-contained task force-NO** (supplied-content transforms
  verb…demonstrative…artifact-noun within one sentence, prompt-defined
  code-gen, pure arithmetic; guarded by the EXPLICIT_WEB_INTENT escape hatch —
  "Translate this paragraph; check the web…" falls through to the model) →
  else UNDECIDED → date-aware model gate.
- **Query guard (structural):** every force-NO verdict carries `queries: []`
  — an operational instruction can no longer become an engine query in ANY
  direction.
- **Web-intent narrowing (same deviation):** the bare `search` token was
  REMOVED from `re_web_intent`/`WEB_INTENT_RE` (kept: "search the web|internet|
  online", "web/google/internet search", look-up, who-won, latest/current/
  today/price/…) because "Write Python code for binary search." was being
  force-YESed — the SAME bug class (engine searching the user's instruction),
  now in the opposite direction. Consequence, accepted: bare "search for X"
  prompts now reach the model gate (its explicit-search rule still answers
  YES — one extra gate call, documented latency trade-off).
- **Runtime date (never hardcoded):** `SearchGateContext.current_date`
  (Rust, `Option<String>`, serde default+skip) / `currentDate?` (TS); the gate
  system message is prefixed `Current date: YYYY-MM-DD (year NNNN).`; absent ⇒
  real UTC clock (`chrono::Utc::now()` / `new Date().toISOString().slice(0,10)`
  — identical semantics); tests inject, never couple to the wall clock. There
  is NO equivalent date mechanism for the main response model anywhere in the
  repo (grep-verified in both epochs) — deliberately NOT invented; absence is
  a documented limitation for the final report.
- **Evidence:** Rust 6 new unit tests (bypass_freshness_forces_search,
  bypass_local_task_forces_no_search, bypass_local_task_escapes_on_external_
  intent, ambiguous_prompts_reach_the_model_gate, gate_messages_carry_the_
  current_date, universal_pre_gate_never_calls_the_llm) + TS mirror spec
  `__tests__/web-search/search-gate-universal.test.ts` (identical prompt
  matrices/labels/reasons) + updated attachment spec. Battery at landing:
  cargo test --workspace **576 passed / 0 failed**; clippy `-D warnings` 0;
  `npx tsc --noEmit` 0; `npx vitest run __tests__/rust-golden` **54/54**
  (zero fixture mutation — bypass `matched` labels are not serialized, so
  golden bytes unchanged); full `npx vitest run` **726 passed / 1 skipped,
  71 files**. Regex portability fix during landing: negated `[^.!?]` gap
  classes must stay OUTSIDE `(?-u:)` byte-scopes (the regex crate rejects
  byte-mode negated classes as able to match invalid UTF-8); TS bodies are
  byte-equivalent modulo that scoping.

### 11.2 Attached-media meta-instructions never masquerade as web intent

**Approved parity deviation (user-approved 2026-10-28 mid-run after a live
Part-10 report): attached-media self-references never arm the web-intent
force-YES.** Deviates BOTH epochs identically (TS `lib/web-search/
search-gate.ts` + `app/api/chat/route.ts`, Rust `ruke-websearch/src/
search_gate.rs` + `ruke-server/src/chat/pipeline.rs`).

- **Observed (user screenshot, 2026-10-28):** prompt "Listen to the attached
  audio and reply with exactly YES followed by the codeword that is spoken,
  or NO if you cannot hear it. Nothing else." with `fixture-audio.ogg` was
  main-model-gated YES and web-searched master/TOEFL/scribd transcription
  sites (geeksforgeeks-class noise).
- **Root cause:** `attachment_ref` parts exist ONLY for INDEXED attachments;
  small audio/video/image inline as text+content parts, so
  `turnHasAttachmentRef`/`has_attachment_refs` stayed false and the §11.1
  Stage-0 attachment rule never armed — the turn reached the model gate.
  The narrow `video` token in `WEB_INTENT_RE` additionally collides with
  "attached audio/video" wording, force-YESing media self-refs even before
  the model gate.
- **Behavior before:** inline-attached media meta-prompts were probabilistic
  (model gate YES→search) or force-YESed by the media token; after: they are
  deterministic Stage-0 NO (`AttachmentEvidence` when the flag arms, else
  `LocalTask` via E1 "nothing else"/E2 supplied-task) with `queries: []` and
  `gate_ms=0`.
- **The fix, three parts, both epochs:**
  1. **Inline-evidence flag:** any text part starting `"Attached file: "` (the
     `client.ts` invariant for EVERY attachmentParts variant, indexed or not)
     sets `hasAttachmentEvidence`/`has_attachment_evidence` (OR with the ref
     flag) at the gate call site ONLY — hybrid retrieval stays strictly
     ref-keyed (1cca12d untouched).
  2. **Self-reference probe (`webIntentProbe`/`web_intent_probe`):** before
     ONLY the web-intent arm and the E1 residual re-test, strips
     `attached|attachment|uploaded|pasted|provided|supplied (+≤2 words)+ media
     noun` and, when the flag is set, anaphora `this|these|my|the + media
     noun`. Media nouns: audio|video|recording|clip|footage|image|photo|
     picture|screenshot|pdf|doc(ument)?|file|transcript|log|code. The
     FRESHNESS arm and the query planner still see the FULL prompt —
     "freshness never loses" is not weakened; genuine external intent
     survives the strip ("…search the web for the latest news about the
     actor", "latest field recordings", "this video on youtube" without the
     flag).
  3. **Vocabulary:** SUPPLIED_TASK gains listen/hear + audio/video/… nouns;
     E1 gains `\bnothing\s+else\b` (residual re-test guards false skips —
     "Watch the launch event tomorrow, nothing else." still force-YES web).
- **Escape laws preserved:** explicit-web escape hatch outranks the
  attachment force-NO unchanged; URL detector unchanged; image-intent arm
  unchanged.
- **Evidence:** Rust `bypass_media_self_reference_never_masquerades_as_web_
  intent` + extended matrices ⇔ TS mirror describe in
  `search-gate-attachment.test.ts` (12/12 both gate specs); cargo test
  --workspace 577 passed / 0 failed (576 baseline + 1); clippy `-D warnings`
  0; `tsc --noEmit` 0; golden suite 54/54.
- **Harness flake classified this landing (NOT a regression):** the golden
  batch run in DEFAULT PARALLEL mode fails web.test.ts 01/02/05 with
  "Fixture drift detected" deterministically **at HEAD f5d5a89 with all
  §11.2 edits stashed** (identical signature) and passes solo;
  `npx vitest run __tests__/rust-golden --no-file-parallelism` → **54/54
  with §11.2 applied**. Root cause class: pre-existing cross-file coupling
  in the golden harness (per-file scripted global-`fetch` stubs share
  process-level state under parallel workers), environmental/test-infra.
  Part-10 accounting runs the golden dir with `--no-file-parallelism`.
  Full-suite accounting at this landing: non-golden 675 passed + 1 skipped
  (61 files) + golden 54/54 = **729 = 726 baseline + 3 new §11.2 TS tests**.

### 11.3 Per-page extraction wall-clock budget (user-reported "stuck / taking forever")

- **Class: PRE-EXISTING bug, fixed in BOTH epochs together (parity law).**
  Reported symptom: a Playwright turn hung minutes mid-suite. Supervisor
  evidence (turn_id=2, RTX-price prompt): `Read 9 of 10 pages` at
  14:37:40, then a **3m51s silence** to `stage=reranking` at 14:41:26 —
  `web_meta` (and the client's search-toggle UI) arrived only after that,
  past the test's 170s window; the LLM stream was then "aborted by client".
- **Root cause (inherited from the TS oracle, ported faithfully):** every
  extractor timeout is PER REQUEST (`TIER1/LINK_PREVIEW/JINA/WAYBACK =
  45_000 ms`, extractor.ts 71–75 ⇔ extractor.rs), while a page runs the
  tier chain SEQUENTIALLY: tier1 + 4 link-preview bots + Jina + Wayback
  (avail + CDX + snapshot) stack to minutes for one dead/unreachable host.
  `extractAll`/`extract_all` uses Promise.all/join_all, so the slowest page
  holds the whole evidence bundle hostage. A warm page-cache replay of the
  same turn passed in 2.9s — proof the shape is timing, not logic.
- **Deviation (both epochs, same semantics):** `PAGE_BUDGET_DEFAULT_MS =
  60_000` — TOTAL per-page wall clock applied in `extractAll` after the
  concurrency permit (a queued page never burns budget; TS:
  `extractUrlWithBudget` Promise.race + symbol sentinel + rejection
  guard; Rust: `tokio::time::timeout` wrapper in `extract_all`, the dropped
  future cancels every in-flight tier). On expiry the page is ABANDONED and
  settles to `timeoutFallbackPacket` / `timeout_fallback_packet` — the SAME
  snippet-baseline terminal shape extractUrl already returns on full
  cascade failure (baseline first; title or "(page read timed out — no
  content extracted)" only when no baseline). New classification string
  `PAGE_BUDGET_TIMEOUT` emitted ONLY by this path. The page still counts
  toward `onPage` progress and still gets its S-id — bundle shape unchanged.
  Optional `pageBudgetMs` param (TS 4th arg, Rust 4th arg `Option<u64>`,
  production always default; tests inject 300ms).
- **Fixture safety:** golden replays are in-process scripted fetches — the
  timer can never fire there — verified **54/54 byte-identical**
  (`--no-file-parallelism`) at this landing.
- **Evidence:** Rust `page_budget_abandons_slow_page_into_snippet_fallback`
  (SlowNet: every tier hangs 30s; budget 300ms caps the page in <10s real
  time) + `timeout_fallback_packet_shape_mirrors_terminal_fallback` ⇔ TS
  `__tests__/web-search/extractor-page-budget.test.ts` (2 mirror tests).
  Batteries: cargo test --workspace **579 passed / 0 failed** (577 + 2);
  clippy `-D warnings` 0; `tsc --noEmit` 0; non-golden vitest **677 passed
  | 1 skipped** (62 files = 675 + 2); golden 54/54. Vitest grand total
  **731 = 729 + 2 new §11.3 TS tests** (the 2 new Rust tests are inside the
  cargo 579 count, not the vitest count).
- **AMENDMENT 2026-10-29 (user-reported regression: "TS era accessed
  sites Rust now can't" — BookMyShow/HackerNews turns rendered snippet-
  starved fallbacks):** the hard cut above proved too blunt for JS-heavy
  and bot-challenged sites. A page whose slow HTTP tiers burn the 60 s
  budget was abandoned BEFORE the stealth-Chromium browser tier — the
  epoch's generic bot-shield bypass (fingerprint rotation, challenge-page
  rendering, SPA hydration unpacking; zero site-specific rules) — could
  even start. The TS era had NO per-page budget, so its browser tier was
  always reachable; the regression was the budget, not the Rust port's
  fetching. The budget is now **tier-boundary-cooperative** in BOTH
  epochs (extractor.rs `capped`/`extract_url_capped` ⇔ extractor.ts
  `withDeadline` + `deadline?` param on `extractUrl`): every HTTP tier
  await (direct, link-preview, Jina, Wayback, slug-triangulation,
  exact-URL fallback) is capped by the REMAINING deadline; on expiry the
  tier takes its failure shape (direct gets the status-0 crash shape) and
  marks `budget_hit`/`budgetHit`; the BROWSER tier is never capped — it
  always runs when the direct read thinned/blocked, bounded by its own
  45 s bridge timeout. Worst-case per page = `PAGE_BUDGET_DEFAULT_MS +
  BROWSER_ALLOWANCE_MS` (60 s + 46 s), still a hard bound preserving the
  original anti-stall guarantee. `PAGE_BUDGET_TIMEOUT` now also emits
  from the in-cascade tail when the allowance fails — still the ONLY
  classification with that value, still impossible in golden fast-path
  replays. The uncapped `extractUrl(result)` path (golden, pipeline.ts
  direct calls) is byte-parity with the original. New Rust proof test
  `budget_exhausted_page_still_gets_browser_allowance` (SlowNet burns
  the budget; scripted browser renders → SUCCESS_BROWSER where the old
  semantics yielded PAGE_BUDGET_TIMEOUT). TS mirror tests stay green:
  they pin the terminal packet shape, which is unchanged.
