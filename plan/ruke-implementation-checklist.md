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
| Model-driven browser baseline E2E | **pending** — scheduled as TEST phase #1 (`browser-easy.spec.ts`, one locked run) before Phase 1 edits land, to capture rounds/latency/task-success on the CURRENT action driver |

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
  discovery list (win64/win/linux/linux64) is **missing macOS `chrome-mac/Chromium.app`** (Phase-1 portability fix).
- **Cleanup:** `turn_guard.finish()` → engine `end_turn` unparks approval/handoff waits, releases claims,
  closes turn tabs except deliverable/handoff marks.

**Phase 0 status: [x] code map + non-model baselines recorded · [ ] model-driven baseline run (TEST #1)**

## Phase gates (check only when verified through the feature's normal entry point)

- [ ] **P0** baseline recorded (this doc + model-driven run)
- [ ] **P1** screenshot transport: real image parts to the model through the ACTUAL Qwen endpoint;
      capture metadata (tab/frame/viewport/scale/crop/full-page/format); compact DOM/a11y snapshots kept;
      targeted reads/search/pagination + truncation metadata w/ retrieval; stale-ref refusal; portable browser discovery
- [ ] **P2** Playwright MCP replaces custom interactive actions: pinned `@playwright/mcp` + rmcp stdio client in
      ruke-browser; SAME authorized Chromium (loopback CDP attach); lifecycle/preview/permissions/downloads/login
      preserved; session isolation; timeouts/cancellation/cleanup; superseded custom code removed per-regression;
      ONE interactive action driver at the end
- [ ] **P3** fast small browser tasks: warm sessions, `browser_fill_form`, bounded batches, preconditions,
      partial-progress + fresh observation, state-based waits, stable prompt/tool prefixes, final-state readback,
      preview frames independent of model requests
- [ ] **P4** 3D/CAD retirement: routes, renderers, lib/three3d, lib/cad, Meshy, capability modes, fence routes,
      24-skill core inventory removal (exact list in plan §Phase 4), lock entries, SVG-Anatomy remap OFF `cad_blueprint` FIRST,
      read-only compat for old saves, `contracts:generate` + `contracts:check` green
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
| Playwright MCP | `integrations/playwright-mcp/` | — | — | — | — |
| Office Kit PPTX | `integrations/office-kit-pptx/` | — | MIT | — | — |
| LibreOffice | `integrations/libreoffice/` | — | MPL-2.0 | — | — |
| ECharts | `integrations/echarts/` | — | Apache-2.0 | — | — |
| Docling | `integrations/docling/` | — | MIT | — | — |

## Next action (updated as the run proceeds)

1. **TEST phase #1 (locked, foreground):** boot app (`npm run dev`), run `scripts/run-browser-e2e-exclusive.ps1
   -TestFiles browser-easy.spec.ts` against CURRENT code; capture per-task rounds/latency from ruke-server logs
   as the pre-change baseline; ANALYZE before any edit.
2. Phase 1 implementation (screenshot transport + metadata + portability), then targeted vitest/cargo checks.
3. Then Phase 2 (MCP) — includes `integrations/playwright-mcp/` scaffold + rmcp pin `rmcp = "3.9.0"` (verify MSRV).
