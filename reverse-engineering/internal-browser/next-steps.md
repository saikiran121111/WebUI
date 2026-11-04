# Next Steps — Remaining Extraction & Replication Plan

## A. Outstanding extraction items (target: `OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0`)

| # | Item | Where / how | Status |
|---|------|-------------|--------|
| A1 | Walker rendered-attribute + interactive-tag constants injected into the per-frame dom_cua function | service closure: `QX=new Set(["a","button","details","input","option","select","summary","textarea"])`, `eJ` (10 rendered attrs), `tJ` (6 boolean attrs), `rJ` (12 roles), budgets `oc=2e4`/`ic=200` + dup copy, overlay root id `gA="codex-agent-overlay-root"` | **CLOSED** (dom-snapshot-and-cdp §3.0.1) |
| A2 | stable node-id / ref registries (per-tab ref → stable id, invalidation on navigation) | page `__browserUse{Reviewer}VisibleDomState {elementToRef:WeakMap,nextId,refToElement:Map}`; service per-tab `yo {framesById,nodeByPublicId,publicIdByFrameLocalRef,nextPublicId}` + `cO/uO/lO/XX` eviction; `ux→Kne/Xne` (scrollIntoView + viewportClip centers), `pO` parent-frame chain `dO` (getFrameOwner/getBoxModel/getContentQuads, `ci` transform), isolated-world cache `wa/bo/fO`; validators `Mh/TN/SN` | **CLOSED** (dom-snapshot-and-cdp §3.0.1–3.0.3) |
| A3 | `dom_cua_click/scroll/type/keypress` payload schemas + ref→coordinates path | `ux→Kne/Xne` (refToElement, scrollIntoView nearest, viewportClip-intersected client-rect centers), `wa/bo/fO` isolated-world cache + one-shot rebuild, `pO/dO` frame-chain transform, `clickDomCuaNode/scrollDomCuaNode/mte`, keypress `Bs` (`Yy` modifier stacks, others `Input.insertText`, map `Tp(e,t="linux")`), type `qs` clipboard-paste (`clipboard.runExclusive` + `mc {action:"paste"}`), validators `Mh/TN/SN` | **CLOSED** (dom-snapshot-and-cdp §3.0.3) |
| A4 | `getJsDialog`/`handleJsDialog` + content export (gsuite/youtube) + `tab_page_assets_list/bundle` + `bot_detection_report` + `browser_auth_handoff` schemas | DONE via build_a4.mjs → schemas-and-ipc **Appendix D** (35 frags, 43,458 B): schemas/builders/capability factories (SVC D2–D4), all handlers (D5–D8, D12–D13, D23, D27), cdp-class dialog cluster (D9–D11), pageAssets service class `fg` (D24), registry maps (D25/D26) + dispatch `i3` (D19), gating sets (D17/D18), telemetry (D20/D21), envelope classes D28+MAIN-D4; docs were already verbatim in Appendix C; client mirror MAIN-D1..D6; negative: plain `tab_content_export` has no handler | CLOSED |
| A5 | Comment→composer text serialization format | main `TEe` envelope + `JS` section builder + `ZS` per-comment serializer + `kEe` Adjust/styling serializer + `EEe`/`$Te` response annotations + IAB ambient constants [1195122,1199642) + full `wEe`; prompt-context grammar §2.2; app-shared mirror [406119,408203) w/ `aoe as gFt` alias; asar byte scan 5 hits | **CLOSED** (annotation-and-ui §2.2–2.3; residual: gFt importing chunk unpinned, `i.Fo/i.Io` in src-CTNXdakG.js) |
| A6 | Ctrl+Shift+B / Ctrl+T + app-shell chords | registry chain SRC `var Ux=[…]…Qx=new Map;` [507986,555593) + resolvers tS/nS/oS/pS/mS/gS/xS/SS/$S + user-keybinding contract (CS `keybindings.json`, ES zod, OS `codex-command-keymap`, tC writer); MAIN menu bridge N()/j() + je-chain (toggle-sidebar, open-browser-tab IPC, Le stepWorkspaceLayout native accel, BrowserHostManager runFocusedVisiblePageCommand, appShellShortcutStates); SH runtime Lhn/Rhn/Bhn/$kn/A5/s6 + capture-phase keydown dispatcher R + effect V. 22 frags 72,879 B → schemas-and-ipc **Appendix E** | **CLOSED** |
| A7 | Omnibox ranking | main `xPe` coordinator [1774648,1778959) + DTO mapper `SPe`/`fD`/dedup `dD` + IPC service `wPe` [1778960,1780123) + factory wiring [3090186,3090721) + registry entry [4596262,4596348); native-pipe boundary `ji` (win32 `\\.\pipe\codex-browser-use` / `/tmp/codex-browser-use`) + `CODEX_APP_TOOLS_PIPE_PATH`; SH client subsystem + state machine `_Ln` [4558460,4569023); popup engine `h/y/x` (whole `popup-f6fcaa7fb85a.js`); composer provider `nOa` + ProseMirror runtime [6641312,6642445)+[9616104,9618600); overlay + address-shortcut chunks whole. **Ranking engine itself is NATIVE (Rust app-server browser module) — no Chromium-omnibox vocab in any JS; the JS contract is the replication target.** 16 frags 55,210 B → schemas-and-ipc **Appendix F** | **CLOSED** |
| A8 | History storage engine (classic-level? SQLite?) | **CLOSED via schemas-and-ipc Appendix G** (9 frags, 34,666 B): app-side service `eFe` [1804065,1806699) — every history verb delegates to the native Electron `BrowserSession` (`yu(session,dataTypes,timeRange)` clear, `searchHistory{deduplicateByDay,matchingAlgorithm:"alwaysPrefix",maxResults:0,startTime,text}` over-fetch 100 pagination, `topSites` bridge `QPe`, `cookies.get({})`, `getCacheSize`, `getDownloadHistory`); range mapper `tFe`/`wD`/`nFe` [1806700,1807748); downloadStore searchHistory/clearHistory/removeFromHistory [2612553,2613657)/[2615280,2615686); native store internals = Electron `session` partition `persist:codex-browser…` boundary (contract-locked). Agent-side path CLOSED via Appendix H: `F("browser_user_history")` + `L9` + `readBrowsingHistory` gate + runtime `history(r)` provider. `classic-level` in plugin = extension `extensionInstanceId` reader only (Appendix H note 11 — corrected) | **CLOSED** |
| A9 | Site-permission third decision value (ask/auto?) | policy chunk: `access/uploads/downloads/fullCdpAccess` compare against `` `deny` ``/`` `allow` ``; `Gc`,`jt`,`o` slots; settings UI chunk `browser-use-settings-ad82191e3391.js` + `browser-use-policy-site-permissions-10a21ebc34a0.js` label strings | **CLOSED** — third state = `alwaysAsk`/`neverAsk` (UI labels **Block / Requires approval / Always allow**) making the per-origin default_origin_policy cell tri-state; default-cell toggle (g?_[e]:void 0)==='neverAsk'&&y?'neverAsk':'alwaysAsk' @P1 10,200; labels @12,700–13,600; merge engine `o` @13,960–14,700 (`jt(i?.access,a?.access,'deny')??'allow'` for access/uploads/downloads/fullCdpAccess/autoReview; `jt(…,'turn')??'thread'` for persistentApproval; access==='deny' forces uploads/downloads/fullCdpAccess/autoReview to deny); `At` wire mapper →{access,uploads,downloads,full_cdp_access} + `jt` fallback-priority merge @15,060–15,620; chromium map {origin:access,download:downloads,upload:uploads,fullCdp:full_cdp_access} with 'denied'→deny / 'allowed' or 'ask'→allow / else null @17,860–18,140; `Ut` changed-policy detector @19,760; `qr` danger-message regex \`/policy\|permission\|prohibit\|denied\|not allowed\|restricted/i\` @P2 24,450. **Facet wire contract itself stays allow/deny (chromium 'ask' maps to allow)** — WHOLE chunks in Appendix I |
| A10 | `i.Br` placement solver source | imported namespace in main; grep `Br=` / `function Br(` in other `.vite/build` chunks — SOLVED: rolldown-CJS `Object.defineProperty(exports,"Br",{get:()=>Xa})` in `.vite/build/src-CTNXdakG.js` @176,873 (main `require("./src-CTNXdakG.js")` → namespace `i`); solver cluster `var H=16,Ya=12;` + `Xa/Za/Qa/$a/eo/to/no/ro/U` [57,310,61,631); constants `Ze={width:344,height:344}`, `Qe` hotspot 26, `$e` 68-vs-44 line height @11,531–11,644; MAIN call sites `createFrame` [2,543,856,2,544,279) (`placementContext:qH({ownerWindow,browserBounds,viewportScale})`) + `u$e` [2,548,441,2,549,713); PRE `My` anchor clipper [441,598,442,411) + placement cluster hS/gS/_S/vS/yS [470,080,472,469); MCP twins `Vg` [410,848,411,661) + gy/_y [439,143,439,911); WHOLE src chunk + both MAIN fragments in Appendix I | **CLOSED** |
| A11 | Clear browsing data dialog option set | chunk `browser-clear-browsing-data-dialog-view` — dataTypes labels map to `yu`: cookies/siteData/cache/downloads/history/formData/siteSettings + timeRange | **CLOSED** — WHOLE dialog chunk (31,298 B) in Appendix I: `dataTypes`@21,187 + `timeRange`@21,199 option vocabulary; cookies/siteData/cache/downloads/history/formData/siteSettings label set + timeRange options (lastHour @20,461… / allTime @30,628…) feeding the `yu` clearData map (Appendix G) |
| A12 | Profile import flow | chunk `codex_browser_profile_import`; main grep `import` + chrome/edge profile readers — SOLVED: chunk = protobuf-analytics enum module ONLY (WHOLE 8,996 B in Appendix I): `CodexBrowserProfileImport`{CookieItemResult,CookieStatus,DataOutcome,DialogExitState,DismissalReason,EntryPoint,LifecycleStep,LifecycleStepType,PasswordStatus,RequestOutcome,Source} over `protobuf_analytics_events.v1`; in-chunk grep chrome/edge/Profiles/bookmark/partition = NONE → the actual profile-file readers live on the native side | **CLOSED-contract** (JS enum/analytics contract verbatim; no JS profile reader exists) |
| A13 | Agent history search | chunk `agent-history*`; main `deletePersistedBrowserConversation`, `persistedAtomStateKeys` — SOLVED: WHOLE agent-history chunk (1,736 B) in Appendix I: `pageAgentHistory` Command (apply/invert/map/toJSON, undo↔redo direction flip) + Yjs-style document store (`collect`/`sync` → pops manager.undoStack item; `apply` swaps stacks and re-pops counterpart; `destroy`) — full undo/redo step engine | **CLOSED** |
| A14 | Extension ids / background switches | `scripts/extension-ids.json` embedded **whole** in Appendix H (11,890 B, sha16 7e321e8c9d1ce031) + full native-host toolchain embedded (check-extension-installed.js, check-native-host-manifest.js, installed-browsers.js, chrome-is-running.js, open-chrome-window.js, chromium-browser-diagnostics .mjs/.d.mts); `browser-background-switches-IQUsnzYP.js` (146,511 B) window-switch list → **WHOLE in Appendix I** | **CLOSED** |
| A17 | browser-use plugin engine (agent control plane) | schemas-and-ipc **Appendix H** (2026-10-26): 63 fragments, 488,738 B appended (doc 403,249→891,987). browser-service.mjs slices H-BS-1..20 (processShim, pipe-client constants, F() factory, PX/IX maps, authority builder chain, SX/De/sn gate-error contract, VB environment security profiles + site-status D_/NX engine + bf gateProviders full run, WebMCP modelContext module, frame-chain selector source, AX capture pipeline, wasm facade+Fre loader+10-export ABI, Wte ref/cursor strippers + download/file-chooser cmds, browser_user_history+L9, vS/Go/i6 registry, Hue cloud, profile/extension-instance reader, docs loader) + census 60 F()-commands / 129 quoted CDP methods + whole-include: plugin.json, extension-ids.json, api.json, documents.json, all 30 docs/**/*.md, 7 diagnostic scripts, browser-client.mjs (170,116 B), SKILL.md, openai.yaml + sha256 integrity record; browser-accessibility.wasm decompressed to extract5/wasm/ | **CLOSED** |
| A15 | `webmcp_list_tools/invoke_tool` service handlers + `document.modelContext` protocol details | CLOSED via A4 batch: handlers `xN`/`Oh` verbatim in schemas-and-ipc Appendix D (D27 [1380370,1380609) / [1379427,1380361), registered via `L(oe.WebMcpListTools,` / `L(oe.WebMcpInvokeTool,`); `webmcp.md` docs already verbatim in Appendix C; preload `document.modelContext` bootstrap verbatim (schemas-and-ipc §…/line 130) | CLOSED |
| A16 | AX snapshot line format (rendered revision text grammar) + element_index→CDP join + capture/action engine | **CLOSED 2026-10-26.** REA `inspect-wasm-artifact` hard 8,388,608 B cap (no override) vs 20,208,690 B decompressed wasm → recorded boundary (`out/wasm_rea.json`, ev_bfc0d6af…); REA tool_profile prescribed WABT 1.0.42 installed+sha256-verified → module identity (11 exports incl. 10-export glue ABI, 34 WASI imports, Swift autolink, sha256 `489ab336…`); grammar string pool verbatim (`out/wasm_pool_A.txt` 16,424,000–16,438,000: diff header/~+ legend, "Removed element IDs: ", "The focused UI element is ", "Scroll to Visible", "Secondary Actions", TINYSKY_* diff knobs, AccessibilityDifferenceLineBudgetExceeded); join chain proven verbatim: element_index →wasm `identityForElement`→ identity →`Fv(tabId,node)`-keyed targets Map→backendNodeId/frameId/loaderId/javaScriptDialog/actionDescriptions(Expand/Collapse from AX `expanded`)/isOptionElement; full capture state machine + action engine + all error strings; 8 fragments H-BS-21..28 (+52,868 B) → Appendix H; write-up dom-snapshot-and-cdp §5.1. **Residual boundary (CLOSED-contract): exact per-line id-tag literals compiled in Swift short-literal pools (invisible in printable segments) — line shape replicated from $te/Gte regexes + pool-A literals + accessibility.md examples** | **CLOSED** |

## B. Deliverable status (2026-10-26, post-Appendix-H)
- `session-log.md` — complete through row 49 (p35–p42 closure chain + Appendix I whole-file append;
  earlier coverage: docs batches, command census, walker/AX/wasm, channel
  pool, oai API, geometry, history eFe/searchHistory, clear-data yu, plugin path correction, ref
  registries, action fns, composer engine JS/ZS/kEe/EEe/TEe, constants var-chain, app-shared mirror,
  A4 command surface, A6 command registry + chords, A7 omnibox Appendix F, A8 Appendix G +
  classic-level correction, A17 plugin Appendix H census/ABI/gate engine).
- `schemas-and-ipc.md` — **2,586,328 B, 12,493 lines, 492 fences EVEN** (measured 2026-10-26): body +
  Appendices A/C/D/E/F/G/H/**I**. F = omnibox (16 frags 55,210 B, native-ranking boundary); G =
  browsing-history service (9 frags 34,666 B, BrowserSession verbs); H = browser-use plugin engine
  (**71 frags**, 60-command + 129-CDP censuses, gate/authority engine, WebMCP + AX + wasm ABI,
  A16 batch H-BS-21..28 +52,868 B: text postprocessor, service tab_ax_action DTO, readDocumentState,
  AX action engine fre→H2, $2 handler, zh capture class head, zh tail, J2 handler; full plugin corpus).
  **I = 13 whole-file/fragment entries, +1,641,053 B (2026-10-26)**: WHOLE browser-use-policy-site-permissions
  58,120 B + browser-use-settings 94,020 B (A9); WHOLE src-CTNXdakG.js 206,622 B (A10 `Br`→`Xa` solver);
  WHOLE browser-page-preload.js 560,978 B (items 3/7/8: complete oai.annotation `request`/`registerControls`/
  `registerSurface` API + `codex:open-annotation` CustomEvent detail + policy/webmcp sendSyncs + annotation
  surface events + `contextBridge.executeInMainWorld` + My/hS placement cluster); WHOLE mcp-annotation-runtime.js
  522,158 B (Vg/gy/_y twins); WHOLE browser-background-switches 146,511 B (A14); WHOLE clear-browsing-data
  dialog 31,298 B (A11); WHOLE codex_browser_profile_import 8,996 B (A12); WHOLE agent-history 1,736 B (A13);
  MAIN `createFrame`/`u$e` fragments (A10 call sites) + 2 SVC residual fragments (zod-array library,
  transcript/caption validators). Integrity table: bytes/chars/sha256(64-hex)/maxBacktickRun per entry;
  dynamic fences; all files CRLF-verified clean. Every earlier window citation is now a subrange of retained
  WHOLE bytes — extraction is 100%, nothing paraphrased remains.
- `dom-snapshot-and-cdp.md` — DONE for checklist 4/6: walker constants (A1), ref registries +
  eviction (A2), ref→coords + click/scroll/keypress/type + validators (A3) all §3.0.1–3.0.3;
  **A16 closed §5.1** (wasm identity + grammar pool + element_index→backendNodeId join + capture
  state machine + full action engine + Swift-literal boundary).
- `annotation-and-ui.md` — DONE for checklist 7/8: anchor schemas §2.1, prompt-context grammar §2.2,
  main composer engine §2.3 (TEe/JS/ZS/kEe/EEe/IAB constants + app-shared mirror verbatim); A6 CLOSED
  (chords via Appendix E); A11 CLOSED (clear-data dialog WHOLE via Appendix I).
- `spec.md` — architecture + Mermaid + evidence ledger + checklist matrix + Ruke blueprint: written,
  ledger updated (composer grammar verified); 2026-10-26: all 10 checklist matrix rows **CLOSED**
  (rows 3/7/9/10 flipped this cycle) + ledger rows flipped (A9 tri-state → verified, A10 solver → verified,
  history backend → CLOSED-contract boundary, oai `request()` payload → verified) + blueprint deviation
  note now "`i.Br`/`Xa` solver ported verbatim from Appendix I (no reimplementation needed)".
- `next-steps.md` — this file.

## C. Replication sequence for Ruke WebUI (`lib/browser/`)
1. `engine/commands.ts` + `engine/transport.ts` — envelope + zod mirrors + nativePipe equivalent
   (IPC socket between Next server process and Electron main host).
2. `engine/cdpBridge.ts` — debugger attach registry + event ring buffer (tab_cdp_call/events contract).
3. `engine/domCua.ts` — frame-tree walker + budgets + node-id registry (A1–A3 closed; port from
   dom-snapshot-and-cdp §3.0.1–3.0.3 verbatim).
4. `engine/ax.ts` — AX tree collector + revision diff (JS port; match `accessibility.md` text grammar).
5. `engine/pw.ts` — vendored playwright-core aria-snapshot (mode:"ai", `aria-ref=`, enter-frame control).
6. `security/policy.ts` — acquireAuthority equivalent, site facets access/downloads/uploads/
   full_cdp_access (facet wire = allow/deny — A9 CLOSED: settings tri-state deny/alwaysAsk/neverAsk,
   `jt` fallback-merge with deny floor + access-deny cascade, `At` wire mapper, chromium
   denied→deny / allowed-or-ask→allow map), turn metadata requirement, blocklists.
7. `session/` — profile partition `persist:` + clearData map + searchHistory/topSites store (A8) +
   autocomplete controller (A7).

FINAL OBLIGATION (user directive 2026-10-26, survives compaction): once and ONLY once every
checklist item 1–10 is CLOSED/100% extracted and docs synced, run `shutdown /s /t 60` (Windows)
to power off the user's PC — the user is away from the machine. Do NOT shut down while any
queue item is open — **the queue is EMPTY (2026-10-26)**: A9/A10/A11/A12/A13 all CLOSED; preload
browser-page-preload.js, mcp-annotation-runtime.js, src-CTNXdakG.js, browser-background-switches and every
residual cluster retained WHOLE/verbatim in Appendix I; A1/A2/A3/A4/A5/A6/A7/A8/A14/A15/A16/A17 CLOSED.
The only non-recoverable items are the documented CLOSED-contract native boundaries: omnibox ranking engine
(A7 — native Rust over the codex-browser-use pipe), history storage internals (A8 — Electron BrowserSession
partition), Swift per-line id-tag literal pools (A16 — REA wasm-size cap recorded + WABT-verified module
identity), chrome/edge profile-file readers behind the A12 analytics enums. Each boundary is documented in
spec.md per the directive.
remains open. If any item is found impossible-to-extract (native-only internals without
symbols), document the exact boundary in spec.md, mark it CLOSED-contract, and only then shut down.
8. `annotation/` — page runtime (verbatim install + attributes), surfaces placement port, composer
   hand-off (A5 format), context menu i18n, accelerators (A6).
9. E2E per CLAUDE.md phases: CODE → Playwright lock/TEST → ANALYZE before any `[LOCKED-DONE]`.
