# RUKE INTERACTIVE BROWSER — IMPLEMENTATION PLAN (LIVE)

Status legend: `NOT STARTED` → `IN PROGRESS` → `IMPLEMENTED` → `UNIT TESTED` → `INTEGRATION TESTED` → `E2E TESTED`.
This document is a live working artifact, updated as each phase completes. Not a planning-only artifact.

Reference contracts consumed (Phase 0, CLOSED — do NOT re-reverse-engineer):
- `schemas-and-ipc.md` — envelope, ~60-command vocabulary (§2.1), turn-metadata rule (§2.2),
  authority gate + facets (§2.3/§5), claims/deliverable/handoff/turn cleanup (§2.4),
  annotation channels + `document.oai` (§3/§4), api.json tool schemas (Appendix A),
  documents.json (Appendix B), capability docs (Appendix C).
- `dom-snapshot-and-cdp.md` — DOM CUA walker constants, ref registries, frame chain,
  typing-via-clipboard, AX capture state machine, action union + verbatim error strings,
  CDP event buffer semantics, screencast (§1–§7).
- `annotation-and-ui.md`, `session-log.md` — Phase 12 inputs (read at Phase 12).

---

## 0. ARCHITECTURE DECISION (locked)

Current stack stays: **Next.js 14 (:3000) + Rust axum (:3101)**. No Electron, no Tauri,
no Node browser backend, no resurrected `lib/browser/**`/WebContentsView/nativePipe mapping.

- **New Rust crate `rust-backend/crates/ruke-browser`** — the browser engine:
  - Subordinate runtime: Playwright-installed Chromium (`.data/ms-playwright/chromium-1243/…`,
    already in-repo, gitignored `.data/`) launched as an external process by Rust,
    controlled exclusively over CDP-over-WebSocket (`--remote-debugging-port=0` +
    `DevToolsActivePort` handshake). Rust is the sole controller; no Playwright library
    drives the agent browser (Playwright stays a dev/test dependency only).
  - Default launch: `--headless=new` (laptop CPU/GPU budget); `RUKE_BROWSER_HEADED=1` opts
    into a visible OS window. The *user-visible* browser is the in-app Browser Panel
    (Phase 3) fed by CDP `Page.startScreencast` — same live session the model controls
    (single tab/session state for model and human; no hidden parallel browser).
  - Profile dir: `.data/ruke-browser-profile/` (persistent: user cookies/history/site data
    belong to the user; per §13 semantics). Per-conversation browser *sessions* are a Rust
    construct (tab groups + claims), matching the reference session/tab/turn ids.
- **Server wiring**: `ruke-browser` state mounted in `AppState` (lazy Chromium start on
  first browser command; clean `Browser.close` on supervisor shutdown / server exit).
  New routes on the Rust server: command RPC `POST /api/browser/command` (loopback +
  internal-secret header, same `x-ruke-internal-secret` precedent), UI socket
  `GET /api/browser/ws` (Origin `http://localhost:3000` allowlist + loopback bind +
  one-time shared secret from `RUKE_BROWSER_BRIDGE_SECRET`, loopback-only :3101 bind —
  WS cannot set headers; secret rides the query).
- **Agent loop (Phase 10)**: a new seam in the Rust chat pipeline. Non-browser turns keep
  the byte-verbatim `forward_into` fast path untouched. Browser turns: tools array injected
  into the upstream payload, SSE bytes pass through verbatim (client ignores
  `delta.tool_calls`), while a parallel parser accumulates tool calls; on
  `finish_reason:"tool_calls"` the loop executes the command via the browser engine,
  appends `role:"tool"` results, re-requests upstream, iterating (cap `MAX_TOOL_ROUNDS`)
  until a content finish. The whole loop is ONE foreground user turn: the `UserTurnGuard`
  is held across model↔browser iterations (titles keep yielding); every model call and
  every browser wait is a `TurnContext::child()` token; client disconnect / Stop cancels
  the root token ⇒ loop aborts, browser waits unwind, tabs get turn-cleanup.
- **Frontend**: `components/browser/BrowserPanel.tsx` (tab strip, omnibox, back/forward/
  reload, agent activity state, screencast canvas, input forwarding), auto-opens on the
  `browser:*` stage frames emitted by the loop (mirrors `web:<stage>` precedent).
- **Security (Phase 9)**: facets `access|uploads|downloads|full_cdp_access` per origin
  (psl), gate mirrors `acquireAuthority().observeContent(url).assert()` / `.actInFrame(url)`,
  UI = Block / Requires approval / Always allow (deny/alwaysAsk/neverAsk), deny-floor merge,
  access-deny cascade, persisted `.data/ruke-browser-policy.json`. Model-facing strings kept
  verbatim from the reference docs where they are behavioral contracts (staleness messages,
  click-failure message, JS-dialog interrupt message); product-name tokens adapt to Ruke
  where the string names the reference product itself.
- **Untrusted-evidence rule (global)**: DOM/AX/screenshots/page text/downloads are
  evidence, never permission. Passwords/OTPs/cookies/tokens never surface to the model
  (password inputs: `type` emitted, value suppressed; credential-frame budget discount).
  CAPTCHA ⇒ manual handoff only.

## Phase status board

| Phase | Scope | Status | REA used? |
|---|---|---|---|
| 0 | Current-repo audit + RE docs | DONE | no (docs sufficient) |
| 1 | Contract manifest + typed schemas + errors (`crates/ruke-browser/src/{contract,schemas,errors}.rs`) | UNIT TESTED (21/21; clippy -D warnings clean) | no |
| 2 | Browser host + session/tab manager (claims, deliverable/handoff, turn cleanup, stale handles fail closed) | NOT STARTED | |
| 3 | Interactive Browser Panel UI (tab strip, omnibox, nav, activity state, auto-open) | NOT STARTED | |
| 4 | CDP bridge + bounded event buffer (sequence/cursor/hasMore/truncated) | NOT STARTED | |
| 5 | DOM CUA engine (walker constants, ref registries, frames, scroll→click, budget+credential math) | NOT STARTED | |
| 6 | AX engine (CDP Accessibility behavioral equivalent of the wasm revision; capture stabilization state machine; verbatim strings) | NOT STARTED | |
| 7 | Playwright-style locator runtime (`mode:"ai"` aria snapshot, aria-ref, enter-frame, waitFor*) | NOT STARTED | |
| 8 | Input/screenshots/dialogs/file chooser/uploads/downloads | NOT STARTED | |
| 9 | Security/authority/confirmations/browser-auth handoff/manual handoff | NOT STARTED | |
| 10 | Model-facing tools + Rust agent loop seam in chat pipeline | NOT STARTED | |
| 11 | Shared-slot + cancellation hardening (RAII, no zombies) | NOT STARTED | |
| 12 | Annotation/comment/Adjust (`document.oai`, codex:open-annotation ⇒ ruke:open-annotation, DOM contract attrs) | NOT STARTED | |
| 13 | History/profile/clear-data/omnibox (native Chromium History DB via rusqlite; clearData types) | NOT STARTED | |
| 14 | Remaining documented UI/runtime behavior (shortcuts, session naming, site status, submission-verified, WebMCP surface) | NOT STARTED | |
| 15–18 | Validation: Rust unit/contract, engine integration vs deterministic fixture server, TS typecheck/vitest, no-model E2E | NOT STARTED | |
| 19–24 | Locked real-model acceptance: EASY / MEDIUM / HARD (one blocking invocation each, full idle between) | NOT STARTED | |
| 25 | Regression battery (chat/SSE/stop/research/citations/attachments/skills/compaction-bypass/titles/routing) | NOT STARTED | |
| 26 | Coverage matrix + placeholder scan | NOT STARTED | |
| 27 | RUKE-IMPLEMENTATION-REPORT.md | NOT STARTED | |
| 28–29 | Shutdown preflight ⇒ `shutdown /s /t 60` | NOT STARTED | |

### Phase 1 locked notes (2026-10-30)
- Wire envelope: `{commandType, session_id, turn_id, payload:{…}}` — nested payload `[adapted]`; metadata gate faithful to §2.2 (non-string ⇒ missing; empty string ⇒ present); missing-keys error verbatim modulo the "Ruke" product token.
- Registry = 82 rows via the `command_registry!` macro (single source: kind ↔ wire name ↔ payload type): 73 §2.1 pool names verbatim (`REFERENCE_COMMAND_POOL`) + 9 lifecycle names `[adapted]` (`ADAPTED_COMMAND_POOL`: `tab_mark_deliverable`, `tab_mark_handoff`, `tab_new`, `tab_close`, `browser_session_name`, `browser_history`, `browser_clear_data`, `browser_user_open_tabs`, `browser_user_claim_tab`). Tests pin round-trip of every kind, pool coverage, and per-row payload decode.
- `AxAction` union carries an explicit `"kind"` discriminator `[adapted]` (paste vs type_text field shapes are identical; structural discrimination is impossible). All other recovered unions/enums keep verbatim wire values (`"axState"`, `"cursor_before"`, `"ControlOrMeta"`, `l|r|m`, …).
- `ClickNotSettled`/`ClickCovered` messages are `[adapted]` compositions of recovered fragments; every other engine string is verbatim and unit-pinned (stale DOM/AX, previous-page, settable-value, dialog-blocking, JS-dialog interrupt, 3000 ms input-prepare, select-text, select-changed).
- Validation-order contract (pinned by test): envelope → commandType → metadata → payload decode → numeric bounds (positive timeouts, CDP event page cap 1..=1000, cua button 1..=5, press_key duration 0..=30 s).
- Workspace: `crates/ruke-browser` member added; `tokio-tungstenite` (loopback ws only, TLS off) declared in workspace deps for Phase 2.

## Key locked facts (do not re-derive)

- Envelope: `{ commandType, payload, ... }` with required `session_id`/`turn_id` for
  session-scoped commands; metadata-missing error enumerates the missing keys.
- Vocabulary (§2.1) is the exact tool/command surface — Phase 1 registry must cover it all.
- DOM CUA: tags {a,button,details,input,option,select,summary,textarea}; 10 rendered attrs
  (`aria-disabled,aria-label,contenteditable,href,name,placeholder,role,title,type,value`);
  6 booleans (`checked,disabled,multiple,readonly,required,selected`); budgets 20 000 chars /
  200 elements, credential frame −5 000 / −50; exclude `codex-agent-overlay-root` analog
  (Ruke overlay root class); `elementToRef` WeakMap + `refToElement` Map (cleared per
  snapshot); per-tab frame/public-id registries; stale error verbatim
  `DOM node N is stale or missing`; click = scrollIntoView(nearest) → client rects ∩
  viewport ∩ frame chain → hit-test settle (25 ms poll / 500 ms cap / 0.5 px) →
  Input.dispatchMouseEvent; type = clipboard paste (`Input.insertText` fallback for
  non-rich); never guess after stale.
- AX: CDP `Accessibility.getFullAXTree` + `nodesUpdated`, stabilization loop
  (250 ms nav recheck, AX-quiet 750 ms, ≤3 restabilize attempts, min 150 ms), commit state
  string `Browser tab: N, Title: "…", URL: "…".\n<rendered>`, target join = byte-prefixed
  `|`-join of [tabId, targetID, backendDOMNodeID]; staleness strings verbatim;
  Secondary Actions Expand/Collapse; focus-then-input 3 000 ms budget verbatim message.
- Action union: paste / click / drag / perform_secondary_action(Expand|Collapse) /
  press_key (0..30 s) / scroll / select_text / set_value / type_text — verbatim errors
  incl. `Element … couldn't be clicked. Try another element.` and the JS-dialog race
  wrapper `Browser action … interrupted by JavaScript … do not retry it.`
- CDP buffer: sequence numbers, cursor paging (1..1000), hasMore, truncated,
  source{sessionId,tabId,targetId}.
- Authority: facet per-origin decisions; read gate `observeContent(currentTabUrl).assert()`,
  mutation gate `actInFrame(frameUrl)`; follow-session-tab rule; turn-scoped command caps.
- Cleanup: claims release at turn end; deliverable/handoff tabs survive (latest wins);
  turn cleanup closes unmarked agent-created tabs.
- Chat pipeline invariants to preserve: decision frames → retrieval frames → web gate →
  strip → forward; `ruke_stage`/`ruke_error` grammar; exactly one `[DONE]`; header pair
  rule; slot guard released exactly once; compaction bypasses ALL of this (browser loop
  must never trigger on `purpose==="compact"`).

## Validation assets (created during Phases 14–18)

- `tests/fixtures/browser/` deterministic fixture server (Node, standalone, port 3210):
  navigation / forms (EASY link page = local equivalent; MEDIUM form w/ exact expected
  values; HARD: new-tab popup, nested iframe verification code, delayed content, dynamic
  DOM, INTENTIONAL stale-ref, scroll, select/checkbox/radio, upload echo, shadow DOM, JS
  dialog, download, final success page). Production code contains ZERO fixture knowledge.
- `scripts/run-browser-e2e-exclusive.ps1` — atomic lock acquire
  (`.ai-coordination/playwright.lock`), start supervisor + fixture only if not running,
  foreground Playwright, artifacts, stop-what-it-started, release in `finally`, exit =
  Playwright exit code.
- Specs: `tests/browser-easy.spec.ts`, `tests/browser-medium.spec.ts`,
  `tests/browser-hard.spec.ts` — assertions inspect REAL state (values before submit,
  URLs, tab lists, downloaded file, upload echo, stale-recovery sequence), never model text.

## Coverage matrix (Phase 26 fills tool↔test columns)

Every §2.1 command name → Ruke tool schema → engine method → owning test. Any command not
implementable against the native boundary (omnibox ranking, history store format, Swift id
pools) is a documented CLOSED-contract behavioral equivalent, never a stub.
