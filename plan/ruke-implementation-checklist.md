# Ruke ChatGPT-like Implementation — Execution Checklist

Overnight implementation run. Source of truth: `plan/ruke-chatgpt-like-implementation-plan.md`
(published at commit `41fe8118cb6cf1a533d24ead0caa0d7340caf9f0`).

- **Starting commit:** `41fe8118cb6cf1a533d24ead0caa0d7340caf9f0` (branch `develop`, clean tree)
- **Run started:** 2026-11-06 (overnight, unattended)
- **Model baseline:** llama.cpp OpenAI server `http://127.0.0.1:8080/v1/chat/completions`,
  model `qwen3.8-flash-next-iq3_s`, n_ctx 131072, **vision-capable**
  (`input_modalities: ["text","image"]`), prompt ≈74 tk/s, gen ≈43 tk/s (speculative draft on).

## Environment baseline (recorded at run start)

| Item | Value |
| --- | --- |
| Node / npm | v26.12.1 / 12.2.0 (≥22.18 ⇒ Office Kit engines OK) |
| Rust | cargo/rustc 1.99.0 (run cargo from `rust-backend/`) |
| Python | 3.14.7 (Docling support window must be checked in 5B) |
| Playwright (npm) | 1.63.0; Chromium vendored under `.data/ms-playwright/chromium-<n>` |
| App chain | `npm run dev` → Next :3000 (dev-supervisor) + ruke-server :3101 (`RUKE_BACKEND_PORT`), prebuilt debug binary `rust-backend/target/debug/ruke-server.exe` exists |
| PowerPoint COM | PRESENT (`POWERPOINT-OK`) ⇒ real slideshow playback verification possible |
| LibreOffice | NOT installed (evaluate in 5B; install via winget if adopted) |
| Key deps | pptxgenjs ^4.0.1, exceljs ^4.4.0, docx ^9.12.0, fflate 0.8.3, playwright 1.63.0 |
| Upstream packages | `@playwright/mcp@0.0.84` (Apache-2.0), `@office-kit/pptx@0.28.0` (MIT), rmcp latest stable 3.9.0 (crates.io; pin verified at Phase 2) |
| Playwright lock | `.ai-coordination/playwright.lock` — absent at run start; launcher `scripts/run-browser-e2e-exclusive.ps1 -TestFiles <spec> [-Grep "<regex with a space>"]` |
| E2E specs | `tests/browser-easy|medium|hard|model-acceptance|scope-matrix.spec.ts` + `tests/browser-e2e-helpers.ts` (playwright.config.ts testDir `./tests`) |

### Environmental laws discovered

- **Rust ignored browser tests need `RUST_MIN_STACK=33554432` and `--test-threads=1`**
  (default thread stacks ⇒ `STATUS_STACK_OVERFLOW` in `fixture_journeys` debug build).
- Never stage `tsconfig.tsbuildinfo`, `repomix-browser.xml`, `.playwright-cli` logs.
- Never `npm run build` while a test-reused dev server is live.
- `cargo fmt` only crates touched (workspace is not rustfmt-clean).
- Golden fixtures: drift ⇒ delete + re-record, never hand-edit.

## Phase 0 — Baseline

### Baseline commands actually run (2026-11-06)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | **exit 0** |
| `cargo test -p ruke-browser --lib` | **177 passed, 0 failed** |
| `cargo test -p ruke-server --lib` | **152 passed, 0 failed** |
| `RUST_MIN_STACK=33554432 cargo test -p ruke-browser --test smoke_lifecycle --test fixture_journeys -- --ignored --test-threads=1` | **3 passed** (smoke 4.69 s, journeys 4.54 s — real Chromium cold start + journeys + teardown) |
| Model-driven E2E (TEST #1, locked, current code): `run-browser-e2e-exclusive.ps1` default suite (easy+medium+hard) | **11/11 passed (7.3 s)**, exit 0, lock released |
| Real-model EASY journey (`-Grep "EASY: human-armed"`) | **PASSED (40.6 s)** — pre-change baseline |
| Real-model MEDIUM journey (`-Grep "MEDIUM: model fills"`) | **PASSED (53.9 s)** — **12 rounds, 42.7 s loop**; 3 self-recovered command failures (fill refused before tab claim → `browser_user_claim_tab`; `set_checked` `"True"` string → retried `true`; one fill retry). Round cadence ≈ 1.5–2.5 s over the local model. Server census now captured to `.ai-coordination/dev-supervisor.err.log`+`.out.log` (launcher tooling improvement: supervisor stdio redirect; ruke-server tracing rides stdout) |

### Browser subsystem entry-point map (current code, file:line anchors)

- **Turn routing:** `ruke-server/src/chat/browser_loop.rs::run_tool_loop` — entered only when the
  client sends the `browser_session` marker AND `task_scope::routes_to_browser_turn` derives OPERATE.
  Inference slot held once for the whole loop (`state.slot.begin_guard`).
- **Action loop:** `MAX_TOOL_ROUNDS = 20` (:72), `MAX_TOOL_RESULT_CHARS = 24_000` (:75);
  `ToolStreamRelay` passes SSE verbatim but swallows non-final `[DONE]`; every tool call goes through
  `contract::parse_envelope` → `BrowserRuntime::command` (gates enforced exactly once at the engine boundary).
- **Screenshot omission (Phase-1 target):** `cull_tool_result` (:239) replaces `data`/`image_base64`
  strings > 256 chars with an "[image omitted…]" line; tool messages appended as plain text at :816;
  baseline test `cull_replaces_big_images_keeps_the_rest` (:986) asserts omission.
- **Screenshot capture:** `ruke-browser/src/pw.rs::pw_element_screenshot` (:1411) → `Page.captureScreenshot`
  (PNG; clip w/ hardcoded scale 1, full-page via `Page.getLayoutMetrics` + `captureBeyondViewport`).
  Result fields: `image_base64`, `mime_type`, optional `width`/`height` — **no tab/frame/viewport/scale/crop metadata yet**.
- **Model tool surface:** `ruke-browser/src/tools.rs::model_tools()` — one OpenAI function per command;
  `browser_id` server-injected (browser_loop.rs :750), model never sets it.
- **Command vocabulary (wire contract):** `ruke-browser/src/contract.rs::command_registry!` (~55 commands):
  pool: `tabs, navigate_tab_url/back/forward/reload, tab_new, tab_close`;
  observation: `tab_ax_get_state, playwright_dom_snapshot, playwright_element_info, playwright_locator_read_all/count/inner_text/text_content/all_text_contents/get_attribute/is_enabled/is_visible`, `tab_screenshot, playwright_element_screenshot, tab_get_js_dialog`;
  actuation: `tab_ax_action, playwright_locator_click/dblclick/fill/press/press_sequentially/select_option/set_checked/wait_for/download_media`;
  waits: `playwright_wait_for_load_state/timeout/url`, `playwright_wait_for_download`, `playwright_wait_for_file_chooser`, `playwright_file_chooser_set_files`, `tab_handle_js_dialog`;
  sessions/user: `browser_session_name, browser_history, browser_clear_data, browser_user_open_tabs, browser_user_claim_tab, browser_annotation_capture, browser_visibility_get`;
  lifecycle/handoff: `tab_mark_deliverable, tab_mark_handoff, tab_browser_auth_handoff, tab_bot_detection_report, tab_manual_handoff_request`;
  escape hatches/exports: `tab_cdp_call, tab_cdp_events, tab_content_export(_gsuite/_youtube_transcript), tab_clipboard_*, tab_page_assets_*, tab_dev_logs, playwright_download_path`;
  page-declared tools: `webmcp_list_tools, webmcp_invoke_tool`.
  *(Phase-2 annotation: the snapshot above lists code as of run start — `tab_ax_get_state` and
  `tab_ax_action` were retired in Phase 2 (`RETIRED_REFERENCE_COMMANDS` in contract.rs; registry now
  81 commands); `playwright_locator_click/dblclick/fill/press/press_sequentially/select_option/
  set_checked` actuators now execute through the MCP bridge, command names unchanged.)*
- **Guidance + scope:** `BROWSER_GUIDANCE` (:83) + `scope_guidance` (:292) injected as one system block before the
  last user message; server-owned `TaskScope` enforced at the command boundary via `authority::TurnAffinity` hosts;
  destination resolution runs BEFORE round 1 through the TS bridge (`/api/internal/web-tools` action `discover`).
- **Session ownership:** `ruke-browser/src/session.rs::TabRegistry` — `claim`, `can_act_on` (model-opened OR claimed
  human tab), `end_turn` releases claims, `mark_deliverable/mark_handoff` exempt from turn-end close.
- **Authority/permissions:** `authority.rs` (1536 l.) classifies commands observe/act, saved site-permission store,
  one-shot human approvals for gated acts, navigation-affinity parking.
- **Login handoff:** `auth_handoff.rs` — human supplies credentials in the panel; values never reach the model.
- **Live panel:** `ui.rs::UiHub` (ticketed WS: `mint_ticket/claim_ticket`, `frame`, `tabs_changed`, `event`) ←
  `lib/browser-client/browserClient.ts` (RPC `POST /api/browser` via Next proxy `app/api/browser/route.ts` → :3101,
  WS ticket `POST /api/browser/ticket`, policy `GET/PUT /api/browser/policy`) → `components/browser/BrowserPanel.tsx`.
- **Browser process host:** `host.rs` — launches Playwright-vendored Chromium with
  `--remote-debugging-port=0` + `DevToolsActivePort` handshake; persistent profile `.data/ruke-browser-profile`;
  discovery list covers win64/win/linux/linux64 + all three macOS `.app` layouts (Phase-1 fix);
  headless-shell bundles are never candidates.
- **Cleanup:** `turn_guard.finish()` → engine `end_turn` unparks approval/handoff waits, releases claims,
  closes turn tabs except deliverable/handoff marks.

**Phase 0 status: [LOCKED-DONE] code map + non-model baselines + model-driven baselines (EASY/MEDIUM journeys) recorded under the exclusive lock; both real-model journeys passed on the CURRENT action driver (E2E 11/11, EASY 40.6 s, MEDIUM 12 rounds / 42.7 s).**

## Phase 1 — Screenshot transport, targeted reads, portability — [LOCKED-DONE] (commit `66b76b9`)

### Endpoint probe (live :8080, `.ai-coordination/probe-tool-image.mjs`)

- Probe A (user-role image) ⇒ "Red" — endpoint accepts images at all.
- Probe B (tool-role image content array) ⇒ "Red" (168 tk) — **tool-role multimodal content accepted**.
- Probe C (tool-role image + tools) ⇒ `finish_reason:"tool_calls"`, reasoning "The page background is
  red, not green, so I did not click SUBMIT", follow-up `answer {"text":"No"}` — images are not just
  accepted, they are **actionable inside the tool loop**. Transport shape settled: multimodal tool messages.

### Implementation (all in `66b76b9`; cargo fmt hunks included)

- `browser_loop.rs`: `cull_tool_result` → **`split_tool_result`** (KEEP_INLINE=256; image parts re-emitted
  as `{"type":"image_url","image_url":{"url":"data:<mime>;base64,…"}}` inside the tool message;
  MAX_IMAGE_B64_CHARS=1.4M ⇒ replaced with retake-hint text); per-round trace `browser tool result … images=N`;
  BROWSER_GUIDANCE teaches screenshot knobs + claim law. 3 new tests (154 ruke-server total).
- `pw.rs` screenshot rewrite (raw CDP): `format` png/jpeg (jpeg gets `quality`), `max_dim` downscale via
  `clip.scale`, selector targeting (empty-box + no-match refusals carry actionable messages),
  clip/full_page geometry (`getLayoutMetrics` + `captureBeyondViewport`); honest `image_width/height`
  (clip: `w*scale`; uncropped: `viewport*dpr`); `crop`/`selector_box`/`viewport`/`page` metadata emitted.
- `schemas/contract/executor`: `ScreenshotPayload` (+clip/full_page/selector/format/quality/max_dim) for
  `tab_screenshot` + `playwright_element_screenshot`; new `DomSnapshotPayload` for `playwright_dom_snapshot`.
- Targeted dom reads: `search` + `offset_lines`/`limit_lines` (default 500-line cap) + `snapshot_meta`
  {total_lines, matched_lines, offset_lines, returned_lines, truncated, next_offset_lines} emitted only
  when needle/offset/truncated — default shape unchanged.
- `tools.rs`: model-facing schemas teach jpeg/quality 60/max_dim 900 + targeted reads.
- `host.rs`: `PLATFORM_EXE_CANDIDATES` win64/win/linux/linux64/mac/mac-x64/mac-arm64 (`.app/Contents/MacOS/Chromium`);
  headless-shell bundles never candidates; 3 discovery tests incl. mac layout + fail-closed.

### Verification actually run

| Command | Result |
| --- | --- |
| `cargo test -p ruke-browser --lib` | **180 passed** (incl. host discovery + split transport) |
| `cargo test -p ruke-server --lib` | **154 passed** (3 new `split_tool_result` tests) |
| `RUST_MIN_STACK=33554432 cargo test -p ruke-browser --test fixture_journeys -- --ignored --test-threads=1` | **2 passed** — Phase-1 battery vs REAL Chromium: jpeg/quality/max_dim honest dims (base64 decoded, JPEG SOF headers parsed — metadata proven honest), selector crop + `selector_box`, stale-selector refusal ("matched no element"), `search` snapshot window + `snapshot_meta` |
| Real-model VISION journey (locked launcher, `tests/browser-model-acceptance.spec.ts`, `-Grep "VISION: model"`) | run 1 **FAILED** (fixture bug: echo rendered at `/vision/choose` but spec asserted URL `/vision/echo`); run 2 after fixture fix **PASSED 48.9 s, exit 0**. Transport census both runs: `round=2 tab_screenshot ok=true images=1 args={"format":"jpeg","quality":60,"max_dim":900}`; model named the swatch color from pixels among confusable labels (run 1 want=Sea Green vs Teal/Slate Blue/Magenta — answer text proved `match=yes`; run 2 random want=Violet, server verdict `match=yes` asserted) |

Fixture: `tests/fixtures/browser/server.mjs` `/vision?want=1..12` (pixel-only swatch, opaque palette,
4 named buttons, verdict echo `pick=… want=… match=yes|no`, marker `VISION-PIXEL-9K31`) — gitignored dir,
local-only; VISION palette mirrored in the spec, `want` randomized per run (blind-guess luck ≤ 1/4).
Known cheat channel: `playwright_evaluate` is model-exposed (tools.rs); prompt forbids it for color ID and
the `images=` census + verdict assertions keep the gate meaningful.

**Operational law discovered: the launcher REUSES any already-listening :3210 — after editing the fixture
server, kill the stale instance first (it carries old routes).**

## Phase 2 — Playwright MCP replaces custom interactive actions — [LOCKED-DONE] (commit `fc03609`)

### Implementation (all in `fc03609`)

- **Pin + client:** `@playwright/mcp@0.0.84` (exact pin, root `package.json`; live identity verified
  `npm ls` + package.json/LICENSE read ⇒ Apache-2.0), driven by **rmcp 3.9.0**
  (`default-features=false, features=["client","transport-child-process","base64"]`).
  `mcp.rs` spawns the CLI from `node_modules` with **version attestation** (mismatch ⇒ refuse,
  `npm ci` remediation; `RUKE_MCP_CLI` override) and attaches with
  `--cdp-endpoint http://127.0.0.1:<port>` ⇒ **the SAME authorized Chromium** (no second browser;
  one global `BrowserRuntime` = one Chromium + one MCP child = 16 GB law),
  `--caps vision --no-webmcp --image-responses allow --output-dir <root>/mcp-out`,
  `--timeout-action 10000 --timeout-navigation 30000 --timeout-settle 500`,
  `--allow-unrestricted-file-access` (file-upload path guard root-caused; Ruke validates upload
  paths before the call), conditional `--headless`, `kill_on_drop`.
- **`bridge.rs` (new, the ONE interactive action driver):** model-facing actuation commands map onto
  MCP tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_fill_form`,
  `browser_select_option`, `browser_hover`, `browser_drag`, `browser_drop`, `browser_press_key`,
  mouse_* xy set, `browser_wait_for`, `browser_tabs`, `browser_file_upload`, `browser_handle_dialog`,
  `browser_find`, `browser_navigate_back`); **tab pin law** (url-unique match else title-nonce probe —
  probe writes title via CDP into its OWN tab, finds the marker in MCP's tab list, selects, restores);
  modal-state recovery (chooser/dialog orphan ⇒ clear + retry exactly once; Ruke-owned state ⇒
  verbatim refusal naming the owner); `McpUnavailable` ⇒ reset + reattach + re-pin once; per-command
  engine lock (`mcp_call` holds the bridge lock once); `map_tool_error` keeps the typed error contract.
- **Retired:** `ax_action.rs` deleted; `tab_ax_action`/`tab_ax_get_state` removed from the command
  registry (`RETIRED_REFERENCE_COMMANDS` ledger; `CommandKind::ALL.len()` 83 → **81**); pw.rs locator
  click/fill/press/select actuators removed (observation, capture, waits, CDP glue stay native).
- **Retained app glue (plan §Phase 2 rationale):** pre-resolution/actionability/typed locator errors,
  tab ownership + permission gates, download attribution (MCP drives the page; Ruke's CDP listeners
  capture the artifact per tab), login handoff, live preview panel, read-back-of-outcome — MCP never
  feeds a blind next action. `browser_snapshot`/`browser_take_screenshot`/`browser_run_code_unsafe`
  are never called by the bridge (Ruke's observation contract + honest-metadata capture stay in force).
- **Honest metadata law (new `imgdims.rs`):** `image_width`/`image_height` parse from the encoded
  bytes (PNG IHDR / JPEG SOF, dependency-free bounded base64); computed estimates only when bytes
  don't parse.

### Bugs caught live by the new proofs (fixed in-product, then re-greened)

| Bug | Root cause | Fix |
| --- | --- | --- |
| Two-session journey: `CDP command Runtime.callFunctionOn failed: Either objectId or executionContextId or uniqueContextId must be specified` | `mcp_pin_probe`'s four title get/set calls passed `object_id: None` (receiverless `callFunctionOn` is invalid); ambiguous-URL tabs forced the probe path for the first time | new `pw_eval_fn`/`pw_eval_fn_expr` (session-scoped IIFE via `Runtime.evaluate`), 4 call sites swapped, 2 unit tests |
| Two-session journey: `B's #dl-link crop: metadata 139x17 lies about real pixels (138, 17)` | clip rect 138.625 px ⇒ Chromium rasterizes 138; prediction `round(w*scale)` claimed 139 | `imgdims::dims_from_b64` override — encoded bytes win (test pins the exact live vector `138x17`) |

### Verification actually run (2026-11-06, all exit codes real)

| Command | Result |
| --- | --- |
| `cargo test -p ruke-browser --lib` | **180 passed** (incl. 2 new pw_eval_fn tests + imgdims suite) |
| `cargo test --workspace --no-fail-fast` | **all ok** (ruke-browser 180, ruke-server 154, golden_replay 19, …) |
| `RUST_MIN_STACK=33554432 cargo test -p ruke-browser --test fixture_journeys -- --ignored --test-threads=1` | **3 passed** — incl. the **new two-session scoping journey vs real Chromium** (plan gate: tabs, snapshots, screenshots, downloads, profile state; cross-session act refused `CapabilityBlocked` until `browser_user_claim_tab`; per-session fill read-back exact; concurrent per-tab downloads distinct + content-verified; profile state shared both ways; end_turn cleanup) |
| `RUST_MIN_STACK=33554432 cargo test -p ruke-browser --test smoke_lifecycle -- --ignored --test-threads=1` | **1 passed** (5.77 s) |
| `node integrations/playwright-mcp/smoke.mjs` | **17/17 PASS, `SMOKE: ALL GREEN`, exit 0** (upstream identity+license, host.rs-style Chromium launch + DevToolsActivePort, MCP stdio handshake, 31-tool inventory, navigate/tabs/fill_form-batch/click/readback/tabs-list-select/vision screenshot/wait_for, raw-CDP same-browser proof). Two smoke bugs fixed en route: tool names invented from memory (`browser_go_back/forward` don't exist in 0.0.84 — corrected from live `tools/list`), Chrome GET submit replaces the action query (fixture corrected) |
| Non-model E2E suite (locked launcher, easy+medium+hard specs) | **11/11 passed (16.2 s)**, exit 0 — popup adoption, chooser round-trip, exact download bytes, dialog mirror, iframe/shadow reads, CUA pixel click, dev-log mirror, assets/export: preserved features all green through the normal entry point |
| Real-model EASY journey (`-Grep "EASY: human-armed"`) | **PASSED 37.1 s** vs baseline 40.6 s |
| Real-model MEDIUM journey (`-Grep "MEDIUM: model fills"`) | **PASSED ~66 s** wall vs baseline 53.9 s (42.7 s loop) — **0 command-failure markers** (baseline had 3 self-recoveries); extra wall time is local-model generation cadence |
| Real-model HARD journey (`-Grep "HARD: model opens"`) | **PASSED 37.5 s** (first model-driven HARD leg; popup-adopt + deliverable survive turn end) |
| Real-model VISION journey (`-Grep "VISION: model reads"`) | **PASSED ~84 s** vs baseline 48.9 s — verdict `want=<name> match=yes` asserted; census: 1 `tab_screenshot`, 2 dom snapshots, 4 clicks, 2 claim-tab (model cadence variance, no failure storm, no retry loop) |

**Phase 2 status: [LOCKED-DONE] — one interactive action driver (MCP bridge) with retained app glue;
two-session proof green; upstream pin + smoke durable in `integrations/playwright-mcp/`; no regressions
on the preserved-feature battery or the four real-model legs.**

## Phase 3 — Fast small browser tasks on the surviving MCP driver — [LOCKED-DONE]

### Implementation

- **Batch actuation (`playwright_fill_form`, registry 81 → 82):** one command over MCP
  `browser_fill_form` (`mcp::tool::FILL_FORM`); 1–16 fields per batch (`MAX_FORM_FIELDS`),
  field kinds textbox/checkbox/radio/combobox/slider. Schemas: `FillFormPayload`/
  `FormFormField`/`FormFieldType`; registry row + `PHASE3_ADDITION_COMMANDS` ledger (additions,
  not adapted-pool); tool schema `minItems`/`maxItems` bounds.
- **Preconditions before acting (plan law):** three-stage contract in `bridge_fill_form` —
  (1) payload validation: empty batch, >16 cap names the count, blank name/target rejected BY NAME,
  checkbox/radio value must be literal `"true"/"false"` (the baseline's `"True"` failure class is
  now impossible); (2) **probe-before-apply** (`FORM_PROBE_JS` via raw CDP): per target — valid
  selector / exists / unique (`target is not a unique` counts matches) / visible / enabled / kind
  match / read-only refusal — first bad field aborts with **ZERO side-effects** and an actionable
  message ("Fix the batch (single-field commands still work) or re-observe the page");
  (3) ONE driver call, then **live read-back** (`FORM_READ_JS`): per field `{name,target,intended,
  actual,verified}`; combobox verifies on option TEXT with selected-option `value` attr fallback;
  mid-batch halt ⇒ `applied/total` counts + read-back + "Do NOT blindly re-apply" honesty.
- **State-based waits + read-back laws (BROWSER_GUIDANCE, 9 → 12 bullets):** one-batch fill law
  (≤16 observed fields, pre-validated, trust the read-back); read-back-of-outcome law (verify the
  final page state, never trust a tool echo alone); state-wait law (prefer `playwright_wait_for_url
  /wait_for_load_state/locator_wait_for` over fixed `wait_for_timeout`).
- **Bounded retries / configurable budgets (browser_loop):** `max_tool_rounds()`
  `RUKE_BROWSER_MAX_TOOL_ROUNDS` (default 20, clamp 3..64), `max_tool_result_chars()`
  `RUKE_BROWSER_MAX_TOOL_RESULT_CHARS` (24 000, 2 000..200 000), split-tool images
  `RUKE_BROWSER_MAX_IMAGE_B64_CHARS` (1.4 M, 200 000..6 000 000) — `bounded_env`+`clamp_parsed`:
  any bad/negative/oversized override falls back to the safe default, never crashes.
- **Stable prompt/tool prefixes + cache measurement (new probe):** `stream_options
  {"include_usage":true}` now rides every loop request (endpoint honors it); relay captures
  `usage`/`timings` on metrics frames BEFORE the empty-choices guard; per-round probe log pairs
  llama.cpp `prompt_n` (tokens actually re-evaluated) with OpenAI `usage.cached_tokens`.
  **Measured live (MEDIUM run):** prompt_n per round **349 / 231 / 98 / 325 / 68 / 218** against
  prompt_tokens 12 550–13 465 with cached_tokens **12 201–13 247 ⇒ ~97 % KV reuse** — the
  byte-stable prefix (fixed-order tools + append-only messages) is proven, not assumed.
- **Warm sessions:** persistent Chromium + MCP child already survive turns; the launcher reuses a
  live :3000/:3101/:3210 stack (this phase used a warm manually-started stack; operator killed the
  servers afterward — recorded law).

### Verification actually run (2026-11-06, all exit codes real)

| Command | Result |
| --- | --- |
| `cargo test -p ruke-browser --lib` | **187 passed** (+7 fill_form unit tests: payload errors name-by-name, cap, wire shape pinned, combobox dual-hold, state description) |
| `cargo test -p ruke-server --lib` | **155 passed** (+1 `clamp_parsed_falls_back_and_clamps_every_override`) |
| `cargo test --workspace --no-fail-fast` | **all ok** |
| E2E run 1 (locked): `-TestFiles easy,medium,hard,scope-matrix` | **18 passed (4.6 m)**, exit 0 — 11 non-model + 7 scope-matrix legs (6 model-driven scope journeys + omnibox) all green through the normal entry point |
| Real-model MEDIUM (`-Grep "MEDIUM: model fills"`) | **PASSED 49.5 s (8 rounds)** vs baseline 53.9 s / 12 rounds / 42.7 s loop — model **spontaneously chose `playwright_fill_form`** (census: batch at rounds 3/5, `ok=true`, all four fields) after ONE claim-law refusal it self-recovered in a single round |
| Real-model EASY | **PASSED 29.7 s** vs 40.6 s → 37.1 s (new best; guidance laws caused no regression) |
| Real-model HARD | **PASSED 39.9 s** vs 37.5 s — within noise; popup-adopt + deliverable intact |
| Real-model VISION | **PASSED ~90 s** — inside the known post-P2 cadence band (~84 s); verdict assertion unchanged |

**New comparison baselines (post-P3):** non-model+scope-matrix **18/18 (4.6 m)**; EASY **29.7 s**;
MEDIUM **49.5 s / 8 rounds**; HARD **~40 s**; VISION **~90 s**. These supersede the Phase-2 numbers
for the Phase-7 final-loop comparison.

**Phase 3 status: [LOCKED-DONE] — batch form actuation with probe-before-apply and live read-back;
preconditions before acting; state-wait + read-back guidance laws; bounded configurable budgets with
safe fallbacks; warm-stack reuse; cache-prefix reuse MEASURED (~97 %). Five locked launcher
invocations, all exit 0, no app defects.**

## Phase 4 — Retire built-in 3D/CAD — [LOCKED-DONE]

### Implementation (commits `a02c3bf`, `499a52a`, `94f740b`)

- **Anatomy mode first (remap BEFORE removal, plan law):** `anatomy` renderer mode added with full TS↔Rust parity — `lib/decision/{types,client,contracts}.ts` match `rust-backend/crates/ruke-decision/src/engine.rs` + `ruke-contracts/src/decision.rs`; `MODE_SKILL[anatomy]="anatomy"`, `MODE_FENCE[anatomy]="anatomy"`; precedence chart→anatomy→html_render pinned.
- **FINAL 8-mode decision set:** `RENDERER_MODES = ["excel","docs","pdf","ppt","anatomy","chart","html_render","standard_chat"]`. `3d_asset`/`cad_blueprint` deleted from types, matchers (`ASSET3D_RE`/`CAD_RE` gone), tables, skill/fence maps; the old spellings now parse to NOTHING (negative pins in `decision.rs` + `contracts.rs` mirror + vitest tables). `contracts_generated.rs` + `contracts/manifest.json` regenerated: `npm run contracts:generate` → 8 modes (shas: excel `7f162016c34aaa90…` 3528 B, docs `6255cb04aa73f57c…` 1502, pdf `37f30a31ec491e47…` 1633, ppt `6152553f909dfb15…` 1864, anatomy `954b7100f104a00c…` 4147, chart `34756d1cc2739854…` 1561, html_render `242788dcf1c899e4…` 1461, standard_chat null). `contracts:check` OK on both artifacts.
- **Goldens re-recorded (never hand-edited):** four drifted fixtures (`decision/01,02,06`, `skills/06-mode-contracts-hashes`) deleted and re-recorded from the live TS oracle via `npx vitest run __tests__/rust-golden` (10 files / 56 tests green); Rust replay + manifest-drift gates re-passed against the new bytes.
- **Retirement surface deleted:** `app/api/3d/**`, `lib/three3d/**`, `lib/cad/**`, six studio viewers + `styles/cad-studio.css`, studio/three3d/cad specs, Meshy provider + `MESHY_API_KEY` (+5 `.env.example` lines), `three` + `@types/three` (`npm uninstall`), capability advertising, fence routing + repair (`runRepairRounds` KEPT for anatomy + document fences only; progress label now generic "Auto-repairing the output").
- **24 core skills removed** exactly per plan §Phase 4 list (archify, 11 r3f-*, 12 threejs-*) with their scenario JSONs and `skills-lock.json` entries; `SCRIPT_CONTRACT_SKILLS` shrank to xlsx/docx/pdf/pptx (TS + Rust mirror + fixtures). Retired names cannot activate, auto-download, or surface in UI (loader/inventory negatives).
- **Saved conversations preserved:** `components/render/RetiredFenceBlock.tsx` renders `scene3d`/`asset3d`/`threejs`/`cad` fences as an honest read-only compatibility card (copy + download of the verbatim source; source disclosed in `<details>`; NEVER executed). 2D charts, Mermaid, SVG anatomy, independent illustrations kept; NO FreeCAD/JSCAD/Maker.js/LibreCAD/model-viewer/glTF Transform/Blender installed (future Blender = separate MCP request).
- **Normal-entry-point proof (`94f740b`):** the `?demo=ui` showcase now embeds a legacy `scene3d` fence; `tests/interactive-ui.spec.ts` asserts the card (text, copy/download, disclosed `THREE.Mesh` source) AND never-execution: zero `<canvas>` on the page and `window.THREE === "undefined"`.
- **fmt note:** `cargo fmt -p` (touched crates only) reformatted previously-unformatted files inside ruke-decision/skills/contracts (stages/jspath/jsstr/lazy/modality/registry/skill_block/fixture_replay/manifest_drift) — inspected: line-wrapping only, knowingly included in `499a52a`.

### Verification actually run (2026-11-06)

| Check | Result |
| --- | --- |
| `npm run contracts:generate` + `npm run contracts:check` | 8-mode artifacts generated; drift gates **OK** |
| `npx vitest run __tests__/rust-golden` | **10 files / 56 tests passed** (4 drifted goldens deleted + re-recorded from oracle) |
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **117 files / 1540 passed / 9 skipped** |
| `cargo test` (ruke-contracts + ruke-decision + ruke-skills + ruke-server) | all green (server **155**; replay + manifest-drift against new goldens) |
| Locked browser run (launcher released lock cleanly) | `powershell -NoProfile -Command "& 'scripts/run-browser-e2e-exclusive.ps1' -TestFiles tests/anatomy.spec.ts, tests/anatomy-repair.spec.ts, tests/interactive-ui.spec.ts"` → **21 passed (40.7 s)**, exit 0 |

Launcher invocation law (learned the hard way): `-TestFiles` is a PowerShell ARRAY — pass via `-Command "& '…' -TestFiles a.ts, b.ts"`; a quoted comma-string becomes one argument ⇒ "No tests found". There is no `-Help`; unknown params are ignored and the default suite (easy/medium/hard) runs (11/11, 16.7 s).

**Retained-bundle provenance (no lock entries — verified, not fabricated):** `d3-js-visualization`, `html-viewer`, `powerbi` bundles + scenario JSONs predate `skills-lock.json`; they were retained untouched (html-viewer still routed from `MODE_SKILL[html_render]`), so they legitimately have NO lock hash to record.

**New comparison baseline (post-P4):** Phase-4 regression suite (anatomy + anatomy-repair + interactive-ui) **21/21 (40.7 s)** — feeds the Phase-7 final-loop comparison.

**Phase 4 status: [LOCKED-DONE] — 3D/CAD fully retired through the normal entry point; anatomy is the only illustration route; old saves render read-only compat cards that never execute; TS↔Rust 8-mode parity with regenerated contracts + re-recorded goldens; 24 core skills removed with lock entries; zero regressions (tsc 0, vitest 1540, cargo green, browser 21/21).**

**2026-11-06 audit addendum:** the evidence above did NOT cover the persisted-conversation history path, and a stale
`tests/cad.spec.ts` was left asserting the deleted viewer — so the gate was reopened and re-closed by the repair in
"Audit repair phase" below (stale suite removed, `tests/retired-fences.spec.ts` seeds old saves through
`POST /api/conversations` and proves card + reload + real Download + zero execution, label now "Download source").

## Phase 5A — Native PowerPoint motion (PptxGenJS + @office-kit/pptx) — [LOCKED-DONE]

### Implementation

| File | Change |
| --- | --- |
| `package.json` / `package-lock.json` | `@office-kit/pptx@0.28.0` pinned (MIT, ESM-only, `engines.node >=22.18.0`, sole runtime dep `fflate ^0.8.3` — already a Ruke dep); PptxGenJS 4.0.1 kept for editable text/charts |
| `lib/documents/schemas.ts` | contract fields `motion:{transition,reveal}`, `morphGroup`, `reducedMotion`; `pptxSpecIssues` rejects bad spellings (`transition:"explode"`, `reveal:"sometimes"`) |
| `lib/documents/pptxMotion.ts` | **ONE** motion planner (`buildMotionPlan`) whose output drives preview AND export; stable semantic `objectName` ids (`OBJ.*`, `!!` prefix, pair ids shared verbatim by both slides of a Morph pair); `clickRevealCount`, `stepFor`, `stepSchedule`, `TRANSITION_MS = { morph: 900, fade: 450 }` |
| `lib/documents/pptxEngine.ts` | native motion pass through office-kit (`findShapeByName` + `setShapeAnimation` + transition write), structural Morph art (crop-fill entry instances, punched `custGeom` spotlights, rotated split masks), transition durations from `TRANSITION_MS`, `validatePresentation` **error gate**, spawns nothing (no `child_process`) |
| `lib/documents/pptxPackageMotion.ts` | **NEW** shared plan↔file predicates (`inspectSlideMotion`, `motionPlanDiff`, `motionSummary`, `planClickReveals`) used by BOTH the deterministic engine tests and the model-driven journeys — one definition of "what a click build is" |
| `components/render/PptxSlideBody.tsx` (new) + `PptxBlock.tsx` | preview renders the SAME plan (`stepSchedule`/`stepFor`); slideshow `advance()` consumes exactly `clickRevealCount` presses before the slide counter moves; reduced-motion path |
| `app/api/documents/pptx/route.ts` | finding 8 closed: the spec goes through `pptxSpecIssues`/`normalizePptx` before the builder — a truthy `slides` array is no longer trusted |
| `scripts/pptx_morph_injector.py` | **DELETED** (`git rm`) after replacement coverage landed |
| `integrations/office-kit-pptx/README.md` + `smoke.mjs` | official upstream source, license, pinned version, platforms, setup, smoke test |
| `tests/pptx-5a.spec.ts` | 4 model-driven journeys (pitch / explainer / data-heavy / simple) through the chat UI |
| `__tests__/documents/pptxMotion.test.ts` (9) + `pptxEngine.test.ts` (10) | deterministic plan + package round-trip proofs |

### Verification actually run (2026-11-06, all exit codes real)

| Check | Result |
| --- | --- |
| `node integrations/office-kit-pptx/smoke.mjs` | **17 PASS / "SMOKE: ALL GREEN"**, exit **0** (identity `@office-kit/pptx@0.28.0` + upstream git URL, license MIT, lockfile integrity, fflate-only dep, Node engine gate on v26.12.1, native chart part survives, `objectName` resolves, morph pair one name on both slides, `morph/byObject` round-trip `durationMs:900`, animation effect/start/duration round-trip, crop-fill round-trip, `custGeom` round-trip, 0 validation errors, motion lives in OOXML `<p:transition>/<p:timing>`, `p:spTgt spid` targets the NAMED shape) |
| `npx vitest run __tests__/documents/pptxEngine.test.ts __tests__/documents/pptxMotion.test.ts` | **19 passed**, exit 0 — incl. the NEW parity test: `motionPlanDiff(...) === []`, file transitions `[none,morph×4]`, `p14:dur` `[0,900,900,900,900]`, per-slide click gates `[0,0,2,0,3]` == the plan's byParagraph reveals, reducedMotion ⇒ `[none,fade×4]` @450 ms with zero gates, `TRANSITION_MS` exact |
| `npx vitest run` (whole repo) | **118 files / 1557 passed / 9 skipped (1 skipped file)**, exit 0 |
| `npx tsc --noEmit` | exit **0** (tsconfig `**/*.ts` covers `tests/`) |
| `npm run contracts:check` | OK — `ppt` contract sha `dd1a703a…` bytes 2423; manifest up to date |
| `npx vitest run __tests__/rust-golden` | **10 files / 56 passed**, exit 0 |
| Simple export with **NO Python** | PATH stripped of python (`mcp-out/pystub.ps1` proves the stub is never called); app started with no interpreter resolvable; `mcp-out/no-python-proof.mjs` verifier **10/10 PASS "NO-PYTHON EXPORT: ALL GREEN"**, exit **0**; artifact carried `ppt/charts/chart1.xml` + `ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx` |
| Locked model-driven journeys — **one launcher invocation each, serial** (`powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'scripts/run-browser-e2e-exclusive.ps1' -TestFiles tests/pptx-5a.spec.ts -Grep '<title>' -AppWaitSeconds 60"`) | **4/4 passed, each launcher exit 0, lock acquired+released every time**: simple **31.1 s** (`simple-ui.pptx` 109,508 B, 3 slides, zero motion); pitch **2.6 m** (`pitch.pptx` 1,204,020 B, 6 slides, plan `none,morph×5`, clicks preview=file=`0/4/4/0/0/0`, file durs all 900); explainer **3.3 m** (`explainer.pptx` 34,072 B, 5 slides); data-heavy **1.6 m** (`data-heavy.pptx` 3,561,257 B, 10 slides, native `ppt/charts/chart8..10.xml` + embedded workbooks). Every journey read the model's OWN `pptx` fence back out of the persisted conversation, re-normalized + re-planned it, and asserted `motionPlanDiff === []` + preview press gating vs the plan. |
| **REAL PowerPoint slideshow playback** (installed PowerPoint via COM; observer `mcp-out/pptx-playback.ps1`, show rendered on `\\.\DISPLAY2 1920x1080`) | Structural opening is NOT the proof — live shows were driven and screenshotted mid-transition. **pitch:** `SlideShowTransition.EntryEffect` = `0, 3954×5` (3954 = Morph) matching the plan; `MainSequence` items `1/5/5/9/1/1` (a 2-step plan with a 4-bullet `byParagraph` build = 5 sequence items); 16/16 in-between frames captured; title text edit round-trip True; 1 chart `ChartType=1` series values `2.61…19.27` from a live embedded workbook. **explainer:** `3954×4`, 15/15 in-between frames, 28 `!!` shapes, chart `65` values `13.65/17.11/97.37`. **data-heavy:** `3954×9`, 16/24 in-between frames, 68 `!!` shapes, **3 charts** `51`/`65`/`-4120` all with live values. **simple-ui:** `EntryEffect=0` on all 3 slides, 0 in-between frames, 0 `!!` shapes, text still editable — honest zero motion. |
| Timing evidence (`mcp-out/dump-timing.mjs` reads the OOXML PowerPoint actually parses) | `<p:timing>` carries real durations: 400 ms entrances, 300 ms `flyIn` staggered 400/700/1000/1300 ms, 600 ms `growShrink` at 1600/2200/2800/3400 ms; transitions `p14:dur="900"` (Morph, inside `mc:Choice Requires="p159"` with a `mc:Fallback` fade) and `"450"` (fade); per-slide `<p:cond delay="indefinite"/>` counts equalled PowerPoint's live `View.GetClickCount()` (4/5/6/4 on the earlier deck set) and `View.Next()` consumed exactly that many presses before the show position advanced — the same gating the preview performs. There is no literal `evt="onClick"` attribute in OOXML. |

### Laws / corrections discovered in 5A

- Normal-tier Morph is the **model's** signal, not the tier's: the model may declare `motion.transition` per slide AND `morphGroup`. A journey assertion of "morph count == morphGroup pairs" failed one real run (3 morphs vs 2 pairs) because the model explicitly overrode transitions — the engine honoring explicit overrides is correct, so the assertion was fixed (at the test) to per-slide signal equality: a slide morphs iff the model said so. Re-ran green (3.3 m).
- `office-kit` reports effect `Name`/`Duration`/`Timing.Duration` as `0`/`''` through the COM interop path — durations had to be verified in the exported `<p:timing>` tree instead of trusting COM.
- The plan↔file predicates must be shared (one module) — two regex copies is how the preview/export split stayed hidden.

**Phase 5A status: [LOCKED-DONE] — native Morph + click reveals + timed entrances + emphasis + reduced-motion through one motion plan; preview and export agree per slide (transition, duration, animation, click gates) in deterministic tests AND in four real-model journeys; decks generated through Ruke were opened AND played in real PowerPoint (Morph observed running, on-click reveals gated live, charts/text editable); charts are native parts with embedded workbooks; the Python injector is deleted and simple export proven with no interpreter on PATH.**

## Audit repair phase (2026-11-06) — the 8-finding brief

Audit baseline `5fb34ffadaa0f9169990f2783aafd0d7ebbb3934`; repair started at HEAD `f1092c1` (5A). Every finding was
re-verified against the working tree BEFORE editing it — three of them were re-confirmed as still reproducing, and
finding 4 contradicted a locked gate, so that gate was reopened first.

### Finding 4 — stale CAD suite + legacy download label ⇒ P4 gate REOPENED, then re-closed

* `git rm tests/cad.spec.ts` — 9 tests still asserting the DELETED CAD viewer (`cad-block`/`cad-stage`/`cad-3d`,
  layer solo, measure, DXF export). The suite contradicted the retirement gate it was cited as proof of.
* `components/render/RetiredFenceBlock.tsx`: the action label is now **"Download source"**, not "Download" — what
  comes down is the saved fence TEXT, never a runnable 3D/CAD artifact (the label is part of the card's honesty contract).
* `tests/interactive-ui.spec.ts`: the card's Download is now actually CLICKED and the downloaded file's CONTENTS are
  checked (`retired-scene3d.json` contains `THREE.Mesh`), next to the zero-`<canvas>` + `window.THREE === undefined` proofs.
* NEW `tests/retired-fences.spec.ts` (deterministic, ZERO model traffic): seeds `scene3d` and `cad` conversations
  through `POST /api/conversations` — the real entry point for old saves, same document shape as
  `conversations-crud.spec.ts` — opens them from the sidebar, asserts the honest card, asserts
  `[data-testid=cad-block|cad-stage|cad-3d|scene3d-block|asset3d-block|threejs-block]` all absent, zero `<canvas>`,
  `window.THREE === undefined`, clicks Download and byte-checks the saved source, then RELOADS and repeats.
  That covers the PERSISTED-history path the P4 gate had never exercised, and it replaces the retired-CAD coverage
  the deleted suite used to give — by proving the old viewer can no longer materialize at all.

### Findings 1 + 2 — form-batch false verification + pre-flight accepting unusable targets

All in `rust-backend/crates/ruke-browser/src/bridge.rs`.

* **Finding 1 root cause:** `FORM_READ_JS` answers `{found:false, actual:""}` when the target vanished, matched twice
  or was an invalid selector, and the success path counted `field_holds` alone — so an intended `""` (clearing a text
  box) was reported `verified: true` without the page ever having been read.
* **Repair:** `field_verdict()` gives each field one of exactly three states — `applied` / `not-applied` /
  `unverifiable` — and `form_readback_response()` emits per-row `state` + `verified`, counts `applied` ONLY from
  `verified`, and returns `"READ-BACK NOT FULLY CONFIRMED: …"` unless `all_verified`. An unverifiable field can never
  inflate the applied count. Kept as pure functions so the honesty law is unit-testable without a browser.
* **Finding 2 root cause:** the pre-apply probe's only enabled check was `el.disabled`, and the caller treated the
  response as "is there any string in it" — so a custom `[role=combobox]` with `aria-disabled`, a control inside a
  disabled `<fieldset>` (whose own `disabled` property stays `false`), or an element that cannot receive pointer
  input passed pre-flight and failed mid-batch; and a missing/malformed probe response read as ALL-CLEAR.
* **Repair:** the probe now also rejects `aria-disabled="true"`, controls inside `<fieldset disabled>` (LEGEND excepted),
  and computed `pointer-events:none` / `visibility:hidden` / `display:none`; `probe_verdicts()` requires EXACTLY one
  verdict per field (`null` = usable, a string = the reason) and converts any other shape into a typed `LocatorFailed`
  that states nothing was applied.
* NEW `tests/form-probe.spec.ts` (deterministic: `page.setContent` fixtures, no dev server, no model): extracts
  `FORM_PROBE_JS` / `FORM_READ_JS` straight out of `bridge.rs` and instantiates THAT text, so there is no copy in the
  test to drift. In real Chromium it proves the probe rejects the aria-disabled combobox, the disabled-fieldset control,
  `visibility:hidden`, `pointer-events:none`, `display:none`, `disabled`, `readonly`, a missing target, a non-unique
  target (`not unique (2 elements match)`) and an invalid selector (`##oops`), plus five type mismatches — while the
  eight genuinely usable controls (including a custom `[role=combobox]` and `aria-disabled="false"`) read as `null`.
  The read-back test distinguishes filled / genuinely-cleared (`found:true, actual:""`) / UNVERIFIABLE
  (`found:false` for missing, ambiguous and invalid targets), and a third test proves pre-flight and read-back never
  write to the page.

### Finding 3 — browser-loop false completion + raw tool args in production logs

Reproduced first: at `RUKE_BROWSER_MAX_TOOL_ROUNDS` exhaustion the loop broke out of `'outer` with
`Outcome::Finished`, the ending block sent `browser:done`, `lib/progress/turnProgress.ts` mapped that frame to
`browser:done` → `done("browser")` → 100 % + chip "Done", and the round whose `finish_reason:"tool_calls"`
swallowed its own `data: [DONE]` left the SSE stream with **no terminal frame at all**. Separately, both tool loops
logged `args = %arguments.chars().take(200)` — the text typed into live pages (queries, form values, names,
addresses) in production logs.

Repair, three layers:

* **`chat/browser_loop.rs` — the outcome is now honest.** `Outcome` gained `Capped` ("the round budget ran out while
  the last round still ended in tool calls … NOT completion"). A pure `terminal_stage_event()` picks the terminal
  stage frame from the outcome: `browser:done` (finished / human-stopped), **`browser:capped`** with
  `detail: "stopped after N browser tool rounds without a final answer round"`, **`browser:failed`** on an errored
  loop. `Aborted` deliberately keeps `browser:done` — the human stopped a turn whose browser work was already at
  rest and the client's own Stop path already reads "Stopped". Cap path now warns "browser tool loop hit the round
  cap; ending the turn WITHOUT a final answer round".
* **`chat/sse.rs` — the grammar is repaired.** `ProgressChannel::ensure_terminal_done(done_already_sent)` backfills
  the missing `data: [DONE]\n\n` exactly once (no-op when a sentinel already reached the client, when the latch is
  closed, or after `fail`). Cross-round accounting rides `ToolStreamRelay.done_forwarded`, set inside
  `accept_frame()` — the same place the swallow decision lives, so the accounting cannot drift from the rule.
  Mirrors the precedent the TS web loop already set (`lib/chat/web-tool-loop.ts:783-787`). Deliberately NOT
  adding a forced final no-tools round to the browser loop: that would change Phase-7 round accounting and is
  outside this finding.
* **`chat/log_safety.rs` (NEW) — log privacy.** `arg_shape()` logs sorted parameter NAMES + byte size, never
  values; unparseable/non-object blobs report size only (tool arguments are model output, never trusted content).
  Wired into both `browser_loop.rs` tool-result logs and `web_loop.rs` "web tool result" (the web arguments ARE the
  user's search queries).
* **Client half (the frames are new names, so both consumers had to learn them).**
  `lib/progress/turnProgress.ts`: `browser:capped` → "Browser task stopped early" band 95, `browser:failed` →
  "Browser task failed" band 95; a `browserCapped` flag makes `finish("complete")` downgrade the turn to the new
  `"capped"` state (chip "Stopped early", overall < 100 %, the browser step frozen ≤ 95) — because the stream
  closing cleanly is NOT evidence the task finished. `lib/browser-client/browserStore.ts`: the turn-end arm now also
  accepts `browser:capped`/`browser:failed`, otherwise the panel would latch `agentActive: true` on a turn that
  already stopped (the regression this repair would otherwise have introduced).

### Verification actually run in this repair phase (real exit codes)

| Check | Result |
| --- | --- |
| `cargo fmt -p ruke-browser` then `cargo test -p ruke-browser --no-fail-fast` | **190 passed / 0 failed** (187 baseline + 3 new honesty tests), exit 0 |
| `npx tsc --noEmit` | **exit 0** |
| Locked launcher, three suites | `& 'scripts/run-browser-e2e-exclusive.ps1' -TestFiles tests/form-probe.spec.ts,tests/retired-fences.spec.ts,tests/interactive-ui.spec.ts -AppWaitSeconds 120` → **4 passed / 2 failed**, "Playwright exit code: 1", lock released. The 4 passes were `retired-fences` 2/2 and `interactive-ui` 1/1 (finding 4 green) plus one probe test; both failures were in MY OWN new harness — `page.evaluate` given a bare string expression returns `undefined` instead of invoking it — not in the product. |
| Locked launcher, form-probe after the harness fix (`new Function` around bridge.rs's own text) | **3 passed (767 ms)**, "Playwright exit code: 0", lock released |
| `cargo test -p ruke-server --lib --no-fail-fast` (finding 3) | **164 passed / 0 failed** (155 baseline + 5 `log_safety` + 3 `ensure_terminal_done` + 1 terminal-frame mapping), exit 0, after `cargo fmt -p ruke-server`. `--lib` because a running `ruke-server.exe` (PID 7968) holds `target/debug/ruke-server.exe`; every changed line is lib code, and the bin target is rebuilt before the model-driven journeys re-run. |
| `npx vitest run __tests__/turn-progress.test.ts __tests__/browser-store.test.ts` (finding 3) | **40 passed / 0 failed** (turn-progress 25 = 21 + 4 new capped/failed/done honesty tests; browser-store 15 = 13 + 2 new turn-end-frame tests), exit 0 |
| `npx tsc --noEmit` after the client half | **exit 0** |

### Still open in this phase

**3** (browser-loop false completion + raw tool args) is REPAIRED and unit-verified (ledger above). Its last gate is
model-driven: a `RUKE_BROWSER_MAX_TOOL_ROUNDS`-capped journey that must show the chip reading "Stopped early" with the
panel back to `agentActive:false` — that spec runs inside the final locked Playwright loop, after `ruke-server` is
rebuilt. **5** (anatomy over-trigger) is REPAIRED and verified in both production engines (ledger below); its remaining
gate is HTTP-level (`/api/decision` + a real chat turn), which rides the same locked browser run as finding 6.
Findings **6** (HTML preview origin isolation + fullscreen fallback) and **7** (PDF export trust boundary) are
reproduced-but-not-yet-repaired; **8** closed in 5A.

### Finding 5 — anatomy route over-triggers on a bare keyword

Reproduced first, at `b4f9db0`: the new deterministic suite `__tests__/decision/anatomy-intent.test.ts` went
**3 failed / 12 passed** — `AssertionError: what is the anatomy of the knee: expected 'anatomy' to be
'standard_chat'`, and the same for the brief's other example. Root cause: the anatomy intent was ONE regex
(`/\b(?:anatomy|cutaway|cross-section|isometric|exploded)\b/i`), so a turn that merely *names a topic* got the anatomy
renderer + its skill block. Anatomy is the only intent whose vocabulary names a SUBJECT rather than a DELIVERABLE —
"spreadsheet" is always a spreadsheet, "anatomy" is usually just what the user wants to talk about — and the two
words have other senses entirely (fitness "isometric exercise", school subject "anatomy exam").

Repair shape — vocabulary **MINUS conversational frames**, applied identically in both engines:

* **`lib/decision/client.ts`** — `ANATOMY_FRAMES` (7) + `anatomyIntent()`; `detectDeliverableIntent` special-cases the
  anatomy arm of `INTENT_ORDER` (`continue` on a rejected frame so it never falls through to a later matcher by
  accident). Frames: interrogative+copula (`what/how/why is|are|does … <vocab>`), contraction (`what's anatomy`),
  `define / definition / (meaning) of <vocab>`, `tell me about <vocab>`, `explain / describe / discuss <vocab>`,
  `isometric` + fitness words, `anatomy` + school words.
* **`crates/ruke-decision/src/engine.rs`** — `ANATOMY_VOCAB_SRC` / `BRIDGE` / `ARTICLE`, `vocab_tail()`, static
  `ANATOMY_FRAMES`, `anatomy_intent()`, and `match_intent` restructured to keep `INTENT_ORDER` first-match semantics
  (excel→docs→pdf→ppt→chart, then anatomy, then html_render). Module doc updated to state the guard.
* **Why frames instead of an ask-verb whitelist:** the golden corpus positive `"anatomy of a jet turbine"` is a bare
  noun phrase, indistinguishable in shape from a topic mention — requiring a verb would have destroyed it. Frames are
  *tight word sequences* over the shared bridge class (`[^A-Za-z0-9_]`, the JS-ASCII-`\b` equivalent) with **no
  unbounded gaps and no lookaheads**, so the Rust `regex` crate (which has no lookahead, and whose `.` also matches
  `\r`/`\u{2028}`/`\u{2029}` where JS `.` does not) can mirror them pattern-for-pattern: the rule is a plain
  match-then-reject pair.
* **Deliberately accepted false negative:** an unframed bare mention (`"knee anatomy"`) still routes to anatomy —
  cheap, because the UI never hard-gates fences (`MarkdownRenderer.kindAllowed` is always true) so a mis-picked mode
  cannot suppress a block the model chose to emit. Documented in the test file and in `client.ts` rather than
  papered over with an assertion that would contradict the golden corpus.

### Verification actually run for finding 5 (real exit codes)

| Check | Result |
| --- | --- |
| `npx vitest run __tests__/decision/anatomy-intent.test.ts` (pre-repair) | **3 failed / 12 passed**, exit 1 — both brief prompts routed to `anatomy`; kept as the reproduction record |
| `npx vitest run __tests__/decision/anatomy-intent.test.ts` (post-repair) | **15 passed / 0 failed**, exit 0 |
| `rm rust-backend/fixtures/decision/06-intent-matcher-vectors.json` → `npx vitest run __tests__/rust-golden` | **10 files / 56 tests passed**, exit 0 — the corpus (4 anatomy positives + 14 negatives + new spot-checks: both brief prompts → `standard_chat`, `isometric illustration of the server rack` → `anatomy`) re-recorded from the live TS oracle; the harness refuses silent drift ("Fixture drift detected"), so a deliberate behavior change is a delete-then-re-record, never a hand-edit |
| `cargo fmt -p ruke-decision` → `cargo test -p ruke-decision --no-fail-fast` (run twice: old fixture, then re-recorded) | **12 unit + 9 fixture-replay passed / 0 failed**, exit 0 both times — the Rust engine reproduces the re-recorded TS corpus, and the new `anatomy_requires_a_request_not_a_topic_mention` test pins the same expectations independently (2 brief examples + 10 frames → `standard_chat`/`None`; 11 illustration asks → `anatomy`) |
| `npm run contracts:check` | OK — `contracts_generated.rs` and `rust-backend/fixtures/contracts/manifest.json` already current (no regeneration needed) |
| `cargo test -p ruke-server --lib --no-fail-fast` | **164 passed / 0 failed**, exit 0 |
| `npx vitest run` (full suite) | **119 files passed / 1 skipped; 1578 passed / 9 skipped**, exit 0 — was 117 files / 1540 tests; +1 file, +38 tests, zero regressions |
| `npx tsc --noEmit` | **exit 0** |

Graphify note on reachability: both production routing paths are fixed, not just one — TS `getDecisionSync` feeds
`app/api/chat/route.ts:662`, `app/api/decision/route.ts:31` and `scripts/e2e-search.ts`; Rust `match_intent` feeds
`ruke-server/src/chat/handler.rs:209` and `decision_routes.rs:34`. No Playwright anatomy journey depends on routing
(`tests/anatomy*.spec.ts` all drive `?demo=anatomy` fixtures), so this repair could not regress those gates — and no
existing test asserted the buggy behavior, so nothing had to be renegotiated.

## Phase gates (check only when verified through the feature's normal entry point)

- [x] **P0** baseline recorded (this doc + locked non-model suite + two real-model journeys)
- [x] **P1** screenshot transport: real image parts to the model through the ACTUAL Qwen endpoint
      (probe C + real-model VISION journey `images=1`); capture metadata (tab/viewport/scale/crop/full-page/
      format + honest pixel dims proven by header decode); compact DOM/a11y snapshots kept; targeted
      search/offset/limit + `snapshot_meta`; stale-ref refusal actionable; portable discovery (win/linux/mac
      layouts unit-proven; live mac gate blocked — no macOS hardware)
- [x] **P2** Playwright MCP replaces custom interactive actions: pinned `@playwright/mcp` + rmcp stdio client in
      ruke-browser; SAME authorized Chromium (loopback CDP attach); lifecycle/preview/permissions/downloads/login
      preserved; session isolation; timeouts/cancellation/cleanup; superseded custom code removed per-regression;
      ONE interactive action driver at the end
- [x] **P3** fast small browser tasks: warm sessions (launcher-reused stack; persistent Chromium+MCP child),
      `browser_fill_form` batch (1–16 fields, one driver call), bounded batches (cap names the count),
      preconditions probed BEFORE acting (zero side-effects on bad batches), partial-progress honesty +
      live per-field read-back, state-based waits (guidance law), stable prompt/tool prefixes (~97 % cached
      tokens MEASURED via stream_options + prompt_n probe), final-state readback law, preview frames
      untouched by model requests (scope-matrix WORKING TAB green)
- [x] **P4 (reopened AND re-closed by the 2026-11-06 audit — finding 4; full ledger in "Audit repair phase")** 3D/CAD retirement: routes, renderers, lib/three3d, lib/cad, Meshy,
      capability modes, fence routes,
      24-skill core inventory removal (exact list in plan §Phase 4), lock entries, SVG-Anatomy remap OFF `cad_blueprint` FIRST,
      read-only compat for old saves, `contracts:generate` + `contracts:check` green — PROVEN via
      `94f740b`/`499a52a`/`a02c3bf`; compat-card + never-execute proof through `?demo=ui` (browser 21/21 exit 0)
      REOPENED BECAUSE: `tests/cad.spec.ts` (9 tests) was left on disk still asserting the deleted CAD viewer
      (`cad-block`/`cad-stage`/`cad-3d`), so the suite contradicted the retirement gate; and the compat path was only
      ever proven on the client-side `?demo=ui` fixture — the PERSISTED-conversation history path and the card's
      Download action were never exercised. Repair: stale suite removed (`git rm`), new deterministic
      `tests/retired-fences.spec.ts` seeds `scene3d` + `cad` conversations through `POST /api/conversations` and
      proves the compat card from persisted history survives reload, never executes, and downloads the real source;
      `interactive-ui.spec.ts` now CLICKS Download and checks the file contents. RE-Locked on that evidence: the locked
      launcher run of `tests/retired-fences.spec.ts,tests/interactive-ui.spec.ts` (with `tests/form-probe.spec.ts`)
      showed retired-fences **2/2** and interactive-ui **1/1** — i.e. the compat card renders from PERSISTED history
      after a reload, no retired viewer chrome/canvas/THREE ever appears, and the downloaded file really is the saved
      source (`retired-scene3d.json` contains `THREE.Mesh`). The pre-existing P4 evidence (21/21 anatomy/anatomy-repair/
      interactive-ui, contracts, goldens, cargo) predates only the label change, which these same specs now assert.
      The whole 40-suite Playwright inventory is re-run in the P7 final battery.
- [x] **P5A** native PowerPoint motion — PROVEN in the 5A ledger above: pinned `@office-kit/pptx@0.28.0` (MIT) smoke
      17/17 exit 0; stable `objectName` ids; native Morph (`EntryEffect 3954`, `p14:dur=900`) + on-click reveals
      (`<p:cond delay="indefinite"/>` == live `GetClickCount()`) + timed entrances (400/300/600 ms + staggers) +
      emphasis + reduced-motion (fade 450, zero gates); ONE plan drives preview AND export — `motionPlanDiff === []`
      in vitest and in 4 real-model journeys; native editable charts + embedded workbooks; decks generated through
      Ruke and PLAYED in real PowerPoint (mid-Morph frames captured, text/charts edited live); injector deleted and
      simple export proven with NO Python on PATH
- [ ] **P5B** evaluate LibreOffice (recalc/convert), ECharts (vs Ruke chart schema), Docling (scanned PDF/tables) on real
      fixtures; adopt only where comparison wins; record decisions; keep ExcelJS/docx/Chromium-PDF; fflate consolidation of
      zipWriter/extract paths preserving decompression limits + 7-Zip fallback; verify actual Power BI exports before claims
- [ ] **P6** chat-UI preservation: streaming, stop/retry, attachments, citations, reasoning prefs, history/titles/recents,
      browser status, artifact edit/export; keyboard/focus/scroll/responsive/a11y; lazy loading + dispose; core-skill
      invisibility; HtmlArtifactBlock sandbox fix
- [ ] **P7** full verification: tsc, vitest, cargo, contracts:check, build; old-vs-new browser path comparison on the same
      tasks; final model-driven Playwright loop (locked, fix-rerun until green); completion report §4
- [ ] **Handoff artifacts:** this checklist completed, commit IDs, exact commands + results, sample artifact paths,
      comparison results, playback evidence, platform coverage, open gates

## Provider integration status

| Provider | Dir | Package pinned | License | README | Smoke test |
| --- | --- | --- | --- | --- | --- |
| Playwright MCP | `integrations/playwright-mcp/` | `@playwright/mcp@0.0.84` (+ rmcp 3.9.0 client) | Apache-2.0 (verified) | ✓ | ✓ ALL GREEN exit 0 (2026-11-06) |
| Office Kit PPTX | `integrations/office-kit-pptx/` | `@office-kit/pptx@0.28.0` (ESM-only, node>=22.18.0, sole dep fflate ^0.8.3) | MIT (verified in package.json) | ✓ | ✓ `node integrations/office-kit-pptx/smoke.mjs` → **17 PASS ALL GREEN**, exit 0 (2026-11-06) |
| LibreOffice | `integrations/libreoffice/` | — | MPL-2.0 | — | — |
| ECharts | `integrations/echarts/` | — | Apache-2.0 | — | — |
| Docling | `integrations/docling/` | — | MIT | — | — |

## Next action (updated as the run proceeds)

1. **STOP — bug phase (per the governing brief: "after finising this phase stop there and resolve these
   bugs").** Audit baseline `5fb34ffadaa0f9169990f2783aafd0d7ebbb3934`; re-verify each of the 8 findings
   against the working tree before touching it, and reopen any gate the evidence contradicts (finding 4:
   `tests/cad.spec.ts` still expects the deleted viewer ⇒ the P4 gate must be reopened until that test is
   corrected). Findings 1–7 = form-batch false verification, preflight accepting unusable targets, browser
   loop false completion on budget exhaustion, stale CAD tests + legacy download label, anatomy
   over-trigger ("What is the anatomy of the knee?" / "What is an isometric exercise?" must stay
   conversational), HTML preview origin isolation + fullscreen fallback, PDF export trust boundary.
   Finding 8 (PPTX bypassed the normalizer) is closed in 5A.
   **Progress: findings 4, 1, 2, 3 and 5 are REPAIRED and verified (see the "Audit repair phase" ledger; finding 3's
   remaining gate is the capped-round model journey in the final locked loop, finding 5's remaining gate is HTTP-level
   proof through `/api/decision` + a real chat turn, which rides the same locked browser run as finding 6). Remaining:
   finding 6 — `HtmlArtifactBlock.tsx` renders
   model HTML in a srcDoc iframe with `allow-scripts allow-same-origin` (same-origin escape); finding 7 —
   `app/api/documents/pdf/route.ts` + `lib/documents/pdfEngine.ts` hand raw HTML to Chromium with JS and networking
   enabled. Each gets deterministic tests at the source; the model-driven browser journeys re-run afterwards under
   the lock, and the rebuilt `ruke-server` must pick up the ruke-browser changes before those journeys are trusted.**
2. Then P5B (LibreOffice/ECharts/Docling real-fixture evaluations + fflate consolidation), P6
   (chat-UI preservation audit), P7 (full battery + FINAL locked model-driven Playwright fix-rerun
   loop green vs baselines + CLAUDE.md §4 completion report).
3. Commits: `66b76b9`+`074d6b0` (P1), `fc03609`+`44d9b2c` (P2), `a3206c9` (P3), P4
   `a02c3bf`+`499a52a`+`94f740b`+`5fb34ff` — all LOCKED-DONE + pushed; **P5A = this commit** (the
   short SHA is the 2026-11-06 HEAD entry in `git log --oneline`).
4. Chat handover snapshot for fresh sessions: `handover/2026-11-06-ruke-plan-handover.md`.
