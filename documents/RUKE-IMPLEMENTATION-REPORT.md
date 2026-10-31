# Ruke Internal Browser — Implementation Report

Date: 2026-10-31 · Branch: `develop` · Scope: the interactive Browser Use capability of the
local AI WebUI — the feature set reverse-engineered from the ChatGPT/Codex desktop
internal-browser (see `reverse-engineering/internal-browser/` for the evidence documents).

This report is the human-readable deliverable. The AI-internal state memory and the
command↔test coverage matrix live separately in `docs/` and
`reverse-engineering/internal-browser/RUKE-IMPLEMENTATION-PLAN.md`.

---

## 1. What was built

The WebUI now embeds a real, model- drivable **and** human-controllable Chromium browser:
model and human share the same tab/session state — a tab the agent opens is visible in the
user's panel, a tab the user opened can be claimed by the agent, and handoffs/marks decide
what survives a conversation turn.

**Backend (Rust, `rust-backend/crates/ruke-browser`)** — a single crate owning the whole
browser domain:

| Module | Responsibility |
|---|---|
| `contract.rs` | The 83-command registry (macro-enforced): command names, wire payloads, validation |
| `executor.rs` | One real arm per command (rustc-enforced exhaustive match) |
| `engine.rs` | Chromium lifecycle (launch/attach via CDP), target pump, per-tab state, turn model |
| `authority.rs` | Per-host permission facets + the gate map for every command |
| `session.rs` | Tab registry, ownership, marks (deliverable/handoff), turn cleanup, claims |
| `ax.rs` / `ax_action.rs` | Accessibility-tree snapshot and node actions |
| `dom_cua.rs` / `cua.rs` | DOM-node pixel input and pure pixel (mouse/keyboard) input |
| `pw.rs` | Playwright-style locator/wait engine implemented over raw CDP |
| `cdp.rs` / `cdp_buffer.rs` | Raw CDP passthrough + capped event buffer |
| `history.rs` | Native Chromium History DB reads + clear-data (incl. the settings-dialog drive) |
| `page_runtime.rs` | Page-side runtime: annotation bridge, WebMCP shim, capture/export JS |
| `content_api.rs` | Clipboard, content exports, asset inventory, dev-log reads |
| `io_state.rs` | Downloads, file choosers, JS dialogs state machine |
| `ui.rs` / `tools.rs` | WebSocket panel protocol; model-facing tool schemas + visibility partition |
| `errors.rs` | Typed error contract shared across the crate |

**Frontend (Next.js/TS)** — `BrowserPanel` (live screencast tab strip, omnibox with history
suggestions, session title, panel shortcuts, WebMCP badge), `BrowserCards` (approval cards +
comment cards), `PolicySettings` (host × facet permission table), and the
`lib/browser-client/` store/RPC/pure leaves (`browserStore.ts`, `browserClient.ts`,
`omniboxSuggest.ts`, `panelShortcuts.ts`, `annotationPrompt.ts`).

**Wire envelope (unchanged law):** every command is
`{commandType, session_id, turn_id, payload:{browser_id:"default", …}}` answered
`{ok:true,data:…}` or `{ok:false,…}`; the turn `"ui"` means the human panel (bypasses model
gates by design).

## 2. Command surface — 83 commands

- **73 commands use the reference's verbatim §2.1 names** (navigate/screenshot/ax/locator/
  CUA/playwright_*/webmcp/site/clipboard/export/asset/dev-log families …).
- **10 [adapted] lifecycle commands** complete the api.json Tab/Browser surface:
  `tab_mark_deliverable`, `tab_mark_handoff`, `tab_new`, `tab_close`,
  `browser_session_name`, `browser_history`, `browser_clear_data`,
  `browser_user_open_tabs`, `browser_user_claim_tab`, `browser_annotation_capture`.
- **78 are exposed to the model** as tool schemas; **5 are never model-exposed**
  (`tab_cdp_call`, `tab_cdp_events`, `browser_user_open_tabs`, `browser_user_claim_tab`,
  `browser_annotation_capture`) — raw CDP stays an operator/panel capability, the user-tab
  pair and annotation capture are panel RPCs.
- The full command → payload → gate → test matrix (with per-command test columns) is the
  "Coverage matrix" section of the implementation plan.

## 3. Authority model

Facets per host (plus a global `"*"` row for history): **observe page content**, **act in the
page**, **uploads**, **downloads**, **full CDP access**, **history**. Reads that only touch
the engine's own state (tab lists, marks, handoffs, session name, site policy reads,
visibility, pure waits) are never gated — gating them deadlocks the model against its own
bookkeeping. Clipboard pair, auth handoff and WebMCP invoke use the Access facet with an
explicit one-off label ("read the clipboard", "hand a sign-in to you", "run a page-declared
model tool"). `Facet::History` for `browser_history`/`browser_clear_data` is applied
globally in the executor. Denied ⇒ honest typed refusal; Ask ⇒ an approval card in the chat
with Allow/Block (120 s window). Site status answers **local saved-permission truth** — the
report's CLOSED-contract note: there is no remote site-status/reputation service in this
product. `site_submission_verified` answers only from session-observed 2xx top-level
navigation evidence.

## 4. Lifecycle & sharing rules

- Tabs are owned by an agent turn unless created by (or claimed from) the user; turn cleanup
  closes unmarked agent tabs; `tab_mark_deliverable` (latest wins) and `tab_mark_handoff`
  protect results and handed-off sessions.
- The user can park a tab for themselves (`tab_manual_handoff_request`), list their tabs and
  claim agent tabs (`browser_user_open_tabs` / `browser_user_claim_tab`, claims released at
  turn end).
- Comments: select page text/element → "Comment on page selection" → anchored comment card;
  the composer grammar marks page evidence as untrusted; the human's request always governs.
- WebMCP: pages may declare tools (`document.modelContext`, verbatim TypeError grammar);
  tool *instructions* can never grant authorization — use is gated and page-declared schema
  text is treated as untrusted.

## 5. History & clear-data

- History reads query the **native Chromium History SQLite DB** (rusqlite) — copy-the-file law
  (Chromium locks the live DB; WAL replayed). Entries newest-first, url/title match, bounded
  queries, capped limits.
- `browser_clear_data` categories: `cookies`, `cache`, `history`, `downloads`; every
  requested type lands in exactly one of `cleared`/`skipped` (honest reasons).
  Cookies/cache go through CDP (`Network.clearBrowserCookies/Cache`); history/downloads go
  through **Chromium's own settings clear-data dialog** — the live History DB holds an
  exclusive lock for the whole browser session, so an external DELETE would corrupt or hang.
  The drive is a privileged, engine-initiated, constant-URL (`chrome://settings/clearBrowserData`)
  automation that only runs after the `Facet::History` gate has passed.

## 6. Defects the test battery found (all fixed, all pinned)

1. `playwright_element_info` built the CDP call with the wrong parameter typing/name.
2. Chromium's dispatched-click coordinates are **integer pixel cells** — a fractional-device-pixel
   assumption mis-clicked; the dispatch-point law now applies to all five click paths.
3. WebMCP: pages using the **native `document.modelContext`** (not the shim) were invisible;
   a native mirror was added (9 page_runtime pins).
4. Submission-verified evidence: recent Chromium (`chromium-1243/1247`) sends **no
   `response.type`** on `Network.responseReceived`; the 2xx-document check now falls back to
   mimeType or it silently never stamped.
5. Clear-data: the live-History exclusive lock made direct DB deletes impossible ⇒ replaced by
   the in-product settings-dialog drive (Polymer `.root` template traversal, visible
   `$.deleteButton` probe, "All time" revealed only via the time-picker "More" menu, category
   checkboxes toggled through the `checked` property — host clicks are inert, rows scoped to
   the dialog subtree, an abort gate if any requested checkbox fails to set *before* the
   confirm click).

## 7. CLOSED-contract adaptations (documented, never silent)

| Reference behavior | Ruke equivalent |
|---|---|
| Remote site-status/reputation lookup | Local saved-permission truth + verbatim "no remote service" disclosure |
| WebMCP policy IPC gating the shim install | Shim always installed; USE is what the gates police |
| Electron global keyboard accelerators | Panel-scoped exact-chord subset (Ctrl/Cmd L/R/T/W, Alt+arrows) |
| Swift/OS-level history store & id pools | Native Chromium History DB + numeric string tab ids |
| External History-DB DELETE for clearData | Chromium's own settings clear-data dialog drive (§5) |

## 8. Verification state (as of 2026-10-31)

- Rust: 170/170 lib unit tests (19 modules); integration `smoke_lifecycle` 1/1;
  `fixture_journeys` (15 deterministic journeys E1–E15 + the 8-section gap battery G1–G8)
  2/2 against real Chromium, 14.25 s.
- TS: `tsc --noEmit` clean; vitest 790 passed / 1 skipped / 0 failed (76 files);
  `contracts:check` OK (generated contracts + fixture manifest up to date).
- clippy at baseline (pre-existing `ruke-websearch` warnings only; ruke-browser clean),
  `cargo fmt` clean.
- No-model Playwright E2E specs (`tests/browser-easy/medium/hard.spec.ts`) are written and
  type-checked; they — plus the real-model EASY/MEDIUM/HARD acceptance journeys (plan rows
  19–24) — run in ONE final exclusive locked session (`scripts/run-browser-e2e-exclusive.ps1`,
  `.ai-coordination/playwright.lock`) so the shared local inference backend is never
  competing with development. Until that loop records green, those rows stay open; today
  `tab_ax_action` and `tab_browser_auth_handoff` have unit-level (not real-browser) coverage
  only.
- Coverage tallies: smoke 16/83 commands; fixture journeys 71/83; gap battery 49/83;
  written specs 24/83; placeholder scan CLEAN (zero TODO/FIXME/stub bodies).

## 9. Known limitations

- Real-model acceptance (rows 19–24) is intentionally deferred to the single final locked
  loop; results will be reported here once recorded.
- Model tool selection is journey-level: the 78 exposed commands are reachable by the model,
  but per-command model exercise depends on what the model chooses during the acceptance
  runs.
- WebMCP/annotation surfaces honestly report absence on older Chromium builds (best-effort
  runtime install).
