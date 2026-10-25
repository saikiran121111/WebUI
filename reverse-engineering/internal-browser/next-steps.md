# Next Steps — Remaining Extraction & Replication Plan

## A. Outstanding extraction items (target: `OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0`)

| # | Item | Where / how | Status |
|---|------|-------------|--------|
| A1 | Walker rendered-attribute + interactive-tag constants injected into the per-frame dom_cua function | service closure: `QX=new Set(["a","button","details","input","option","select","summary","textarea"])`, `eJ` (10 rendered attrs), `tJ` (6 boolean attrs), `rJ` (12 roles), budgets `oc=2e4`/`ic=200` + dup copy, overlay root id `gA="codex-agent-overlay-root"` | **CLOSED** (dom-snapshot-and-cdp §3.0.1) |
| A2 | stable node-id / ref registries (per-tab ref → stable id, invalidation on navigation) | page `__browserUse{Reviewer}VisibleDomState {elementToRef:WeakMap,nextId,refToElement:Map}`; service per-tab `yo {framesById,nodeByPublicId,publicIdByFrameLocalRef,nextPublicId}` + `cO/uO/lO/XX` eviction; `ux→Kne/Xne` (scrollIntoView + viewportClip centers), `pO` parent-frame chain `dO` (getFrameOwner/getBoxModel/getContentQuads, `ci` transform), isolated-world cache `wa/bo/fO`; validators `Mh/TN/SN` | **CLOSED** (dom-snapshot-and-cdp §3.0.1–3.0.3) |
| A3 | `dom_cua_click/scroll/type/keypress` payload schemas + ref→coordinates path | `ux→Kne/Xne` (refToElement, scrollIntoView nearest, viewportClip-intersected client-rect centers), `wa/bo/fO` isolated-world cache + one-shot rebuild, `pO/dO` frame-chain transform, `clickDomCuaNode/scrollDomCuaNode/mte`, keypress `Bs` (`Yy` modifier stacks, others `Input.insertText`, map `Tp(e,t="linux")`), type `qs` clipboard-paste (`clipboard.runExclusive` + `mc {action:"paste"}`), validators `Mh/TN/SN` | **CLOSED** (dom-snapshot-and-cdp §3.0.3) |
| A4 | `getJsDialog`/`handleJsDialog` + content export (gsuite/youtube) + `tab_page_assets_list/bundle` + `bot_detection_report` + `browser_auth_handoff` schemas | DONE via build_a4.mjs → schemas-and-ipc **Appendix D** (35 frags, 43,458 B): schemas/builders/capability factories (SVC D2–D4), all handlers (D5–D8, D12–D13, D23, D27), cdp-class dialog cluster (D9–D11), pageAssets service class `fg` (D24), registry maps (D25/D26) + dispatch `i3` (D19), gating sets (D17/D18), telemetry (D20/D21), envelope classes D28+MAIN-D4; docs were already verbatim in Appendix C; client mirror MAIN-D1..D6; negative: plain `tab_content_export` has no handler | CLOSED |
| A5 | Comment→composer text serialization format | main `TEe` envelope + `JS` section builder + `ZS` per-comment serializer + `kEe` Adjust/styling serializer + `EEe`/`$Te` response annotations + IAB ambient constants [1195122,1199642) + full `wEe`; prompt-context grammar §2.2; app-shared mirror [406119,408203) w/ `aoe as gFt` alias; asar byte scan 5 hits | **CLOSED** (annotation-and-ui §2.2–2.3; residual: gFt importing chunk unpinned, `i.Fo/i.Io` in src-CTNXdakG.js) |
| A6 | Ctrl+Shift+B / Ctrl+T + app-shell chords | renderer bundle (`webview/index.html` entry + `thread-app-shell-chrome` chunk) grep `KeyB`,`metaKey`+`shiftKey`, `keybindings` | open |
| A7 | Omnibox ranking | main `xPe` autocomplete coordinator + `wPe` service + `n.autocomplete.createController(surface:'composer')`; chunks `browser-address-suggestion-overlay`, `address-utils`; backend `getBrowserAutocompleteCoordinator()` | open (structure found) |
| A8 | History storage engine (classic-level? SQLite?) | `getBrowserSession()` members `searchHistory/topSites/cookies/getCacheSize/getDownloadHistory`; storage under Electron `session` partition `gu("app")` userData — locate DB files under profile dir at runtime; plugin `classic-level` copy in cua_node node_modules | open |
| A9 | Site-permission third decision value (ask/auto?) | policy chunk: `access/uploads/downloads/fullCdpAccess` compare against `` `deny` ``/`` `allow` ``; `Gc`,`jt`,`o` slots; settings UI chunk `browser-use-settings-ad82191e3391.js` + `browser-use-policy-site-permissions-10a21ebc34a0.js` label strings | allow/deny verified; third state open |
| A10 | `i.Br` placement solver source | imported namespace in main; grep `Br=` / `function Br(` in other `.vite/build` chunks (service-B9aFX97S.js, worker.js) | open |
| A11 | Clear browsing data dialog option set | chunk `browser-clear-browsing-data-dialog-view` — dataTypes labels map to `yu`: cookies/siteData/cache/downloads/history/formData/siteSettings + timeRange | engine verified; dialog labels pending |
| A12 | Profile import flow | chunk `codex_browser_profile_import`; main grep `import` + chrome/edge profile readers | open |
| A13 | Agent history search | chunk `agent-history*`; main `deletePersistedBrowserConversation`, `persistedAtomStateKeys` | open (plumbing names found) |
| A14 | Extension ids / background switches | `scripts/extension-ids.json` (package root), `browser-background-switches-IQUsnzYP.js` window switches list | open |
| A15 | `webmcp_list_tools/invoke_tool` service handlers + `document.modelContext` protocol details | CLOSED via A4 batch: handlers `xN`/`Oh` verbatim in schemas-and-ipc Appendix D (D27 [1380370,1380609) / [1379427,1380361), registered via `L(oe.WebMcpListTools,` / `L(oe.WebMcpInvokeTool,`); `webmcp.md` docs already verbatim in Appendix C; preload `document.modelContext` bootstrap verbatim (schemas-and-ipc §…/line 130) | CLOSED |
| A16 | AX snapshot line format (rendered revision text grammar) | wasm is compiled; derive from `accessibility.md` examples + `revision_copy_text` consumers; grep service for `element_index`/line join | open |

## B. Deliverable status (2026-10-26)
- `session-log.md` — complete through row 38 (docs batches, command census, walker/AX/wasm, channel
  pool, oai API, geometry, history eFe/searchHistory, clear-data yu, plugin path correction, ref
  registries, action fns, composer engine JS/ZS/kEe/EEe/TEe, constants var-chain, app-shared mirror).
- `schemas-and-ipc.md` — body + Appendices A/C written (api.json/documents.json/env-docs verbatim).
- `dom-snapshot-and-cdp.md` — DONE for checklist 4/6: walker constants (A1), ref registries +
  eviction (A2), ref→coords + click/scroll/keypress/type + validators (A3) all §3.0.1–3.0.3.
- `annotation-and-ui.md` — DONE for checklist 7/8: anchor schemas §2.1, prompt-context grammar §2.2,
  main composer engine §2.3 (TEe/JS/ZS/kEe/EEe/IAB constants + app-shared mirror verbatim); A6/A11 pending.
- `spec.md` — architecture + Mermaid + evidence ledger + checklist matrix + Ruke blueprint: written,
  ledger updated (composer grammar verified).
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
   full_cdp_access (allow/deny now; ask pending A9), turn metadata requirement, blocklists.
7. `session/` — profile partition `persist:` + clearData map + searchHistory/topSites store (A8) +
   autocomplete controller (A7).
8. `annotation/` — page runtime (verbatim install + attributes), surfaces placement port, composer
   hand-off (A5 format), context menu i18n, accelerators (A6).
9. E2E per CLAUDE.md phases: CODE → Playwright lock/TEST → ANALYZE before any `[LOCKED-DONE]`.
