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
- [x] **P4** 3D/CAD retirement: routes, renderers, lib/three3d, lib/cad, Meshy, capability modes, fence routes,
      24-skill core inventory removal (exact list in plan §Phase 4), lock entries, SVG-Anatomy remap OFF `cad_blueprint` FIRST,
      read-only compat for old saves, `contracts:generate` + `contracts:check` green — PROVEN via
      `94f740b`/`499a52a`/`a02c3bf`; compat-card + never-execute proof through `?demo=ui` (browser 21/21 exit 0)
- [ ] **P5A** native PowerPoint motion: `@office-kit/pptx@0.28.0` verified Node-compatible; stable object names
      (`objectName`); native Morph + click reveals + timed entrances + emphasis + reduced-motion; ONE motion sequence for
      preview AND export; native charts (PptxGenJS `addChart`); decks generated through Ruke; playback verified in REAL
      PowerPoint (COM); `scripts/pptx_morph_injector.py` deleted after replacement; simple export works with NO Python
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
| Office Kit PPTX | `integrations/office-kit-pptx/` | — | MIT | — | — |
| LibreOffice | `integrations/libreoffice/` | — | MPL-2.0 | — | — |
| ECharts | `integrations/echarts/` | — | Apache-2.0 | — | — |
| Docling | `integrations/docling/` | — | MIT | — | — |

## Next action (updated as the run proceeds)

1. **Phase 5A (CODE):** native PowerPoint motion — `@office-kit/pptx@0.28.0`: verify the REAL upstream
   npm package first (`npm view @office-kit/pptx` — identity, MIT license, Node compat); keep PptxGenJS
   editable content + `addChart` charts + `POST /api/documents/pptx` contract; stable `objectName`;
   native Morph + click reveals + timed entrances + emphasis + reduced-motion; ONE motion sequence
   drives BOTH preview AND export; generate a deck through Ruke; verify playback in REAL PowerPoint
   COM (`POWERPOINT-OK` baseline); then DELETE `scripts/pptx_morph_injector.py`; prove simple export
   with NO Python; write + run `integrations/office-kit-pptx/` README + smoke test.
2. Then P5B (LibreOffice/ECharts/Docling real-fixture evaluations + fflate consolidation), P6
   (chat-UI preservation audit), P7 (full battery + FINAL locked model-driven Playwright fix-rerun
   loop green vs baselines + CLAUDE.md §4 completion report).
3. Commits: `66b76b9`+`074d6b0` (P1), `fc03609`+`44d9b2c` (P2), `a3206c9` (P3) — all LOCKED-DONE +
   pushed; P4 `a02c3bf`+`499a52a` (pushed) + `94f740b` (this docs commit carries the push).
4. Chat handover snapshot for fresh sessions: `handover/2026-11-06-ruke-plan-handover.md`.
