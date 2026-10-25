# Session Log — Codex Internal Browser Reverse-Engineering

Chronological record of every tool operation performed against the target, with exact paths,
commands, artifact digests, and evidence IDs. Digest prefixes are recorded as observed; full
values are preserved in the live REA session evidence and the conversation transcript
(`C:\Users\Ruku\.claude\projects\D--Projects-WebUI-WebUI\89ed50ff-8c2f-4dce-bb18-59b70289ae5f.jsonl`).

Target root: `D:\Projects\openAI code\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0`
(MSIX-extracted OpenAI Codex desktop package; codename "owl"; app version 26.1021.3705.0;
plugin bundle version 26.1021.31345).

Working dirs (all created fresh, scripts kept separate from extracted data per untrusted-archive rules):
- `C:\Users\Ruku\AppData\Local\Temp\codex_re\scripts\` — our tooling (`asar_header.mjs`, `asar_extract.mjs`)
- `C:\Users\Ruku\AppData\Local\Temp\codex_re\out\` — `asar_header.json`, `asar_files.tsv`, `extract_list.txt`
- `C:\Users\Ruku\AppData\Local\Temp\codex_re\extract\app_asar\` — 94 byte-exact asar members

---

## Phase 1 — REA-MCP only (strict mode, per original directive)

| # | Tool | Call detail | Result / evidence |
|---|------|-------------|-------------------|
| 1 | `mcp__rea__binary_session` | identity probe | server connected; no active target |
| 2 | `mcp__rea__open_binary` | `path=...\app.asar` (initial wrong path guess) | error `ENOENT` — corrected to `...\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0\app\resources\app.asar` |
| 3 | `mcp__rea__open_binary` (retry) | `path=...\app\resources\app.asar` | success; asar opened as archive; artifact sha-256 begins `04862a65…`; signed native members raised `artifact_integrity_mismatch` |
| 4 | `mcp__rea__open_binary` (retry) | + `integrity_policy="record-and-continue"` | success; mismatches retained as explicitly untrusted observations |
| 5 | `mcp__rea__inspect_artifact` | default complete inventory | evidence `ev_f3434692…`; artifact graph incl. `.vite/build/*.js`, `resources/plugins/**` |
| 6 | `mcp__rea__inspect_analysis_view` | `kind="inventory"`, `collection="nodes"` | evidence `ev_737efab3…`; output 84,486 chars auto-spooled to `C:/Users/Ruku/.claude/projects/D--Projects-WebUI-WebUI/89ed50ff-8c2f-4dce-bb18-59b70289ae5f/tool-results/mcp-rea-inspect_analysis_view-1792949479632.txt` |
| 7 | `mcp__rea__analyze_javascript_application` | `input_path=...\app\resources\app.asar` (then on extracted webview dir) full-bundle attempt | `provider_timeout` at 300 000 ms/source (~5 MB minified bundle); PARTIAL evidence `ev_73b22028…`; remediation: narrow `source_paths` — superseded by direct byte extraction (Phase 2) |
| 8 | `mcp__rea__inspect_analysis_view` | `kind="javascript"` on partial evidence, `collection` omitted first | error missing `collection` → fixed with `collection:"nodes"` |
| 9 | `mcp__rea__inspect_electron_fuses` | considered; skipped (no running packaged app to attach) | — |
| 10 | (direct Read of plugin docs) | `plugins/browser/docs/api.json` | read in full verbatim (66,615 B, 2,090 lines) — complete agent-facing API graph; see `schemas-and-ipc.md` |

Notes on tool-schema gotchas encountered (kept so they are not re-hit):
- `inspect_artifact` accepts only `detail` + `integrity_policy`; it operates on the ACTIVE session, not a path argument.
- `open_binary` on a directory → `directory_requires_file`; use `analyze_javascript_application` for directories.
- TSV search quirk: `grep -P '^\.vite/'` returned nothing on `asar_files.tsv`; `awk '$1 ~ /^\.vite\//'` works.
- `jq` is not installed on this host; python 3.14.7 and node are available.

## Phase 2 — Pragmatic Hybrid Mode (user superseded REA-only directive)

User directive: standard `Read`/`Grep`/`Glob`/`Bash` permitted against the spooled REA tool-results
AND the target files; stop emitting raw tool-call XML tags; process spooled REA output; complete the
10-point specification; write all six output files.

| # | Operation | Command / detail | Result |
|---|-----------|------------------|--------|
| 11 | `node scripts/asar_header.mjs <asar> out/` | brace-balance scan of asar pickle header (persistent depth/inStr/esc state across 4 MiB chunks) | `{headerBytes, bodyBase: 6053836, entries: 21791}`; wrote `out/asar_header.json` + `out/asar_files.tsv` (`path\tsize\t{offset|U|L:link}`) |
| 12 | `awk '$1 ~ /^\.vite\//' out/asar_files.tsv` | enumerated 38 `.vite/build/*.js` bundles with sizes+offsets | main-BPBEjAxi.js 5,082,185 B @1,970,111; browser-page-preload.js 560,978 B @1,066,365; mcp-annotation-runtime.js 522,158 B @7,052,296; worker.js 2,244,879 B; browser-background-switches-IQUsnzYP.js 146,511 B @919,854 |
| 13 | `node scripts/asar_extract.mjs <asar> <app.asar.unpacked> out/extract_list.txt extract/app_asar` | byte-exact slicer (bodyBase+offset, 1 MiB chunks; `U` entries copied from `app.asar.unpacked`; `L:` links resolved) | `{"count":94,"errors":0,"bodyBase":6053836}` — 94 members incl. all 38 main/preload/renderer `.vite` bundles, package.json, webview/index.html, detached-window.html, service-worker/events.js, ~52 named webview/assets chunks |
| 14 | grep census `extract/app_asar/.vite/build/main-BPBEjAxi.js` | WebContentsView / sessions / debugger contexts | verbatim fragments recovered: `new O.WebContentsView({webPreferences:{session:e,sandbox:!0,nodeIntegration:!1}})`; `O.session.fromPartition(gu("app"),{permissionHandling:"browser",enableBrowserPolicies:!0})`; MCP-app sessions via `/a-f0-9]{48}$/` + `{persist:!0}`; `e.debugger.attach("1.3")` with attachment registry `{users,browserUseUsers,childSessions,ownsAttachment,annotation…}`; `Network.enable {maxPostDataSize…}` |
| 15 | grep census `browser-page-preload.js` | envelope-type inventory on channel `Sm` | full `browser-sidebar-runtime-*` event set (annotation-selection-modifier-state, annotation-suspension, cancel-editor, capture-text-selection, close-comment-preview, comment-screenshot-ready, design-modifier-state, exit-comment-mode, focus-editor, image-drag-ended, image-drag-started, mouse-navigation, open-comment-preview, open-design-editor, open-editor, request-annotation-permission, toggle-annotation-mode, update-anchor) + `site_annotation_features_changed`, `webmcp_changed`; expose names `electronBridge`, `codexWindowType`, `__SENTRY_IPC__`; oai-* class census: oai-annotatable×7, oai-annotation-container×6, oai-annotation-container-text×6, oai-annotation-editor-default-mode×1, oai-annotation-metadata×4 |
| 16 | grep census `plugins/browser/scripts/browser-service.mjs` (1,611,121 B) | CDP method + id-scheme census | ~60 CDP methods inventoried with call counts (Page.getFrameTree 30, Page.frameNavigated 19, Runtime.evaluate 17, DOM.describeNode 10, Runtime.callFunctionOn 8, Page.enable 8, Page.createIsolatedWorld 8, Input.dispatchMouseEvent 7, Runtime.releaseObject 7, DOM.getBoxModel 6, Input.dispatchKeyEvent 5, DOM.getContentQuads 5, DOM.resolveNode 5, DOM.setFileInputFiles 3, DOM.getNodeForLocation 2, DOM.scrollIntoViewIfNeeded 2, Page.captureScreenshot 2, Page.startScreencast/stopScreencast/screencastFrame, Page.addScriptToEvaluateOnNewDocument 2, Page.setInterceptFileChooserDialog 4, Page.javascriptDialogOpening/handleJavaScriptDialog, Page.navigate/navigateToHistoryEntry/getNavigationHistory/resetNavigationHistory, Target.setAutoAttach/getTargets/attachedToTarget/detachedFromTarget, Fetch.enable/continueRequest/continueResponse/fulfillRequest/failRequest/disable, Network.getAllCookies/enable, Input.insertText/dispatchDragEvent). Literal `Accessibility.*` ABSENT (AX engine is `browser-accessibility.wasm.br`, 4,084,148 B). id schemes: `tab_id`×324, `tabId`×369, `turn_id`×46, `turnId`×24, `ref:`×12, `ref=`×22, `node_id`×10, `nodeId`×9; literal `sendCommand`×0 in this file (CDP transport wrapper lives in the main-process bundle) |
| 17 | grep `plugins/**` flags | policy flag location | `browser_use_full_cdp_access` found ×2 in webview chunk `browser-use-policy-site-permissions-10a21ebc34a0.js` |
| 18 | direct Read of plugin metadata | `plugins/browser/.codex-plugin/plugin.json`, `plugins/chrome/.codex-plugin/plugin.json`, `plugins/computer-use/.codex-plugin/plugin.json`, `plugins/codex-app-tools/.mcp.json`, `scripts/launch_codex_app_tools_mcp.cmd` | hooks verbatim (Interrupt/SubagentStop/Stop → mcp_tool `node_repl` tool `turn_ended`, input `{hook_event_name, session_id, turn_id}`); browser/chrome/computer-use declare NO `.mcp.json` (tools surface through node_repl/cua_node runtime JS API); codex-app-tools declares `mcpServers.codex_app` via `cmd.exe /d /s /c call ./scripts/launch_codex_app_tools_mcp.cmd ./server.mjs`, `enabled:false`, `omit_tools_from:["deferred"]`, `default_tools_approval_mode:"approve"`, per-tool `approval_mode:"prompt"` for automation_update/create_thread/send_message_to_thread/fork_thread/handoff_thread/move_thread_to_project; env chain CODEX_APP_TOOLS_PIPE_PATH / CODEX_MCP_NODE_PATH / CODEX_BROWSER_USE_NODE_PATH / CODEX_ELECTRON_RESOURCES_PATH / CODEX_CLI_PATH; startup_timeout_sec 10, tool_timeout_sec 3600 |
| 19 | plugin scripts inventory | sizes | browser-service.mjs 1,611,121 B; browser-client.mjs 170,116 B; `browser-accessibility.wasm.br` 4,084,148 B; `zxing_reader.wasm` 1,065,866 B; docs/api.json 66,615 B; docs/documents.json 4,156 B |
| 20 | cat browser docs (batch 1) | documents.json, accessibility.md, api-use-behavior.md, visibility.md | verbatim into spec appendix; documents.json = document-routing manifest (`mode: model|included|lookup`, `when.browserTypes/requiredApiMembers/requiredTabCapabilities`, `requiredFor` tool names: `tab_cdp_call`, `tab_cdp_events`, `webmcp_list_tools`, `webmcp_invoke_tool`, `tab_browser_auth_handoff`) |

## Environment / constraint ledger

- Untrusted-archive protocol enforced: extracted files isolated in fresh dir; scripts in separate dir;
  paths passed as args; `python -I` for any Python reading target bytes.
- Project CLAUDE.md three-phase CODE/TEST/ANALYZE + `.ai-coordination/playwright.lock`: no Playwright
  runs were launched this session (analysis-only, no app code modified).
- No target file was ever modified; all reads were read-only.

## Evidence-to-checklist coverage snapshot (as of this log point)

1. Tool schemas + system instructions → api.json (verbatim read), documents.json, docs/*.md (batches 1–2), plugin.json hooks, codex-app-tools/.mcp.json.
2. Electron main viewport/sessions → main-BPBEjAxi.js fragments (row 14). Split-pane math + accelerators pending (row 21+).
3. IPC contract table → preload envelope inventory (row 15); main channel string constants still minified (`Sm`, `_.mn`, `_.Xt`) — resolution open.
4. DOM snapshot & ref engine → accessibility.md verbatim + browser-accessibility.wasm.br identified; walker/ref details open.
5. Per-tab state machine → tab_id/turn_id counts located; lifecycle extraction open.
6. CDP dispatch → method census (row 16); attach registry (row 14); `browser_use_full_cdp_access` in policy chunk.
7. `document.oai.annotation` API → oai-* class census (row 15); API surface extraction open.
8. Adjust/comment mode → envelope names captured; annotation-comment-editor-card chunk read open.
9. Security policy engine → browser-safety.md/confirmations.md + browser-use-policy-site-permissions chunk reads open/partial.
10. History/omnibox/clear-data/profile → named chunks identified (history-*.js, browser-address-suggestion-overlay, browser-clear-browsing-data-dialog-view, codex_browser_profile_import); content reads open.

## Open items carried into next-steps.md
- Resolve minified IPC channel string pool in main bundle.
- Ref-engine internals (ref numbering, node registry invalidation) from browser-service.mjs.
- `document.oai` exact shape from mcp-annotation-runtime.js / browser-page-preload.js.
- Remaining doc batch: capabilities/*, tab-cleanup/mentions/claiming (batch 2), troubleshooting docs (list only), SKILL.md files, @oai/browser-desktop environment docs.
- Renderer chunk reads: browser-146ddb5c0a89.js (UI), policy-site-permissions, clear-browsing-data, history, agent-history, profile-import, address-suggestion.

| 21 | grep main: accelerators/geometry | CmdOrCtrl set, `createGeometry→u$e`, `qH/JH/YH` verbatim | split-pane math recovered: viewport=contentBounds+browserBounds; getDisplayMatching workArea; surfaceMode editor\|preview; preview inset FH; guards zH/BH/VH; setIgnoreMouseEvents policy |
| 22 | grep main: toggle/shortcuts | `N('toggleSidebar')`→`{type:'toggle-sidebar'}`; `getAppShellShortcutState` booleans; `globalShortcut.register(registrationHotkey)`; mac layout map | Ctrl+Shift+B/Ctrl+T literals NOT in main → renderer keymap (A6) |
| 23 | grep main: history/clear/autocomplete | `eFe` class verbatim (searchHistory dedupeByDay/alwaysPrefix paging, topSites block/restore, cookies.get, getCacheSize, getDownloadHistory); `yu` clearData 7-type map+timeRange; `xPe` coordinator surface:'composer' + `autocomplete.createController` | checklist-10 engine DONE |
| 24 | grep main: composer lifecycle | `addAnnotationsToComposer` full body; closePage/transferConversation | comment→composer hand-off DONE; text grammar = A5 |
| 25 | grep policy chunk: decision enum | census `access/uploads/downloads/full_cdp_access === deny/allow` | allow/deny verified; third state open (A9) |
| 26 | grep main: addAnnotationsToComposer + history census | (row 23/24 evidence) | — |
| 27 | find target: canonical plugin path | `app/resources/cua_node/bin/node_modules/@oai/browser-desktop/{scripts,environment-docs/{codex-app,cloud,orbit,training}}`; also `@oai/cua/dist/lib/js/oai_js_browser/dist/skill/references/api.json` | corrected paths (session-log row 16/19 used these) |
| 28 | grep service: walker opts + dom_cua schemas | opts literal {booleanAttributeNames:tJ, codexOverlayRootId:gA, interactiveRoleNames:rJ, interactiveTags:[…QX], renderedAttributeNames:eJ, reviewerOnly, viewportClip}; `se=(k,O)=>{K=[node_id=…]}` builder verbatim; uR/pR/fR+tn (`node_id must…`) ; dR/mR; `actInFrame` vs `observeContent`; `followSessionTab`; `Mh` validator; `cua.clickDomCuaNode`; command-capability Sets; `browser_visibility_get` | A1 partial (const contents pending), A3 DONE |
| 29 | cat append: codex-app api.json + documents.json + 29 instruction .md | into schemas-and-ipc.md Appendices A/C | file now 160,593 B |
| 30 | deliverables written | spec.md, schemas-and-ipc.md, dom-snapshot-and-cdp.md, annotation-and-ui.md, next-steps.md, session-log.md | 6/6 files present |
| 31 | grep service constants (A1 CLOSED) | `QX=new Set(["a","button","details","input","option","select","summary","textarea"])`, eJ 10 rendered attrs, tJ 6 boolean attrs, rJ 12 roles, `gA="codex-agent-overlay-root"`; dup copy budgets ou/iu/nJ/oJ/bO/gO + `yO="const __name = (target) => target;"` banner | walker injection inputs complete |
| 32 | grep+node-slice service (A2 CLOSED) | page state `__browserUse{Reviewer}VisibleDomState {elementToRef:WeakMap,nextId,refToElement:Map}` per-snapshot clear; service `yo` per-tab `{framesById,nodeByPublicId,publicIdByFrameLocalRef,nextPublicId}`, `cO/uO/lO`, XX eviction; ux→Kne/Xne page resolver (scrollIntoView nearest, clip-intersect center, getClientRects); pO parent-frame chain + dO getFrameOwner/getBoxModel/getContentQuads/`ci` transform; `wa` ctx-cache `bo`/`fO` + one-shot rebuild; Mh/TN/SN validators; mte viewport-center scroll; dom_cua_keypress Bs/Yy/Tp; dom_cua_type clipboard-paste `qs` pipeline | ref→coords engine DONE |
| 33 | grep main: annotation focus lease | attachment rec fields + `annotationRequested` gate + `Emulation.setFocusEmulationEnabled` + `$d` lease Symbol.dispose | checklist 6/9 cross-link |
| 34 | webview chunk census (A5) | annotation-appearance / comment-editor-card / comment-input-surface / annotation-editor ×2 / mode-icon / batch-controls / annotation-label / composer-disclaimer ×2 / site-annotation-permission-dialog / source-annotation-host / use-diff-annotations | A5 targets enumerated; grammar pending |
| 35 | main-bundle composer boundary scan (scripts/frag_bounds*.mjs, brace/template-aware tokenizer): TEe, EEe, DEe/OEe/kEe, AEe/jEe/MEe/NEe, JS, IEe/LEe/REe/YS/XS, ZS, QS/zEe, BEe/$S, VEe, eC, PS/ITe, IS/LS, RS/VS/zS/HS, cr/lr/ur/dr, gr/Mee, JTe, KTe/qn/Kn probes | `main-BPBEjAxi.js` byte ranges TEe[1199643,1199866) EEe[1199866,1200052) kEe[1200394,1201273) JS[1205652,1212412) ZS[1212933,1217975) eC→Aee site | exact verbatim ranges resolved; prompt envelope = `JS(ctx)` + `\n## My request:\n` + `JTe(prompt,selectedText)` (`TEe`); checklist 8 core engine |
| 36 | constant var-chain captured verbatim [1195122,1199642): YTe..hEe + CEe + $Te + IAB block (nEe/rEe/iEe/aEe/oEe/sEe/cEe/lEe/uEe/dEe/fEe/pEe/mEe) + wEe full (2,228 B, ends "…committed native comment.") | `main-BPBEjAxi.js` | CEe + wEe residuals closed; `i.go/i.ho.BROWSER` gate (`HS`), `$S` Google-Docs block, `VEe` worktree-state builder all verbatim |
| 37 | app-shared renderer mirror: raw window [406119,408203) in `webview/assets/app-shared-955d52676f9c.js` (6,070,124 B; asar off 68569973) — `Jae`(ua clone)/`toe`/`Pv()` lazy-init grammar incl. `aoe=``<page-comment-context>\n``` + `goe`; export alias `aoe as gFt` @6004667 (protobuf `gFt` name-collision @2088841/2254636 noted, different scope); whole-asar byte scan `page-comment-context` = exactly 5 hits (2× prompt-context, 3× app-shared @406984/407573/407604) | `extract2/webview/assets/` | renderer mirror verbatim; open tag emitted only via grammar chunks; A5 CLOSED |
| 38 | doc sync: `annotation-and-ui.md` §2.3 spliced (33,896 B verbatim, 12 quad-fence blocks, quad-fence depth auto-sized vs embedded ``` fences; doc 52,361 B); `next-steps.md` A1/A2/A3/A5→CLOSED + §B rewrite; `spec.md` matrix rows 4/6/8 + evidence ledger composer row → verified | `reverse-engineering/internal-browser/` | A5 fully closed (residual: gFt consumer chunk unpinned; `i.Fo/i.Io` in src-CTNXdakG.js); resume queue at A4 |
| 39 | A4 probes 1–12 (`a4_probe*.mjs`, never inline `node -e` with backslashes — shell mangling): statement-boundary resolution; registration-style census — direct `L("tab_…")` vs sub-ns `L(Mi.Bundle`/`L(Mi.List` (@1799684/@1799947) vs top-ns `L(oe.WebMcpInvokeTool` (@1379427)/`L(oe.WebMcpListTools` (@1380370); breakthrough: two registry maps — command→handler export table @875221 (`TabCdpCallCommand:()=>nF,…TabPageAssetsBundleCommand:()=>RF,…WebMcpListToolsCommand:()=>xN}`) + `var oe={};H(oe,{…TabContentExport:()=>_m,…WebMcpListTools:()=>Js})` @1057459; `var P=class{constructor(t,r,n){this.type=t…}` @1059635 (mirror of main `NU=class` @2628665); pageAssets service class `var fg=class` @1826050 (list/bundle/getAssets/inventoriesById, "Asset inventory is no longer valid for this page"); negatives: 0× `L(Sk,`/`L(_m,`/`L(oe.TabContentExport,`/`oe.Tab*,` registrations; `PayloadSchema.parse` = exactly 4 sites (1514454 raw-CDP, 1515717 oF, 1520960 dF, 1166075 bot client class `report()`) | browser-service.mjs + main-BPBEjAxi.js | plain `tab_content_export` ns ships without handler (GSuite sF + YouTube aF only); webmcp handlers = Oh/xN |
| 40 | `build_a4.mjs` (tokenizer-aware scanners: string/template/comment/regex skip, depth-0 `;` stmt end, brace-balance bodies, boundary fixes: `){` anchor for destructuring params, class/decl brace ends) → 35 frags 43,458 B `out/frag_a4.txt`; `append_d.mjs` wrote `## Appendix D — tab capability command surface (A4) verbatim` (dupe-guarded, fence-balanced 70) + inventory table + 6 architecture notes → schemas-and-ipc.md now **210,386 B**; `next-steps.md` A4+A15→CLOSED; `spec.md` ledger: client-SDK-mirror nuance + command-surface row | `reverse-engineering/internal-browser/` | A4+A15 closed; next queue: A6 (chords), A7 (omnibox xPe/wPe), A8 (history backend), A9 (ask-state), A10 (i.Br), A11–A14, A16 (AX grammar) |
