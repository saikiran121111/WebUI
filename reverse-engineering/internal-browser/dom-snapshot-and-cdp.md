# DOM Snapshot, Ref/Node-id Engines & CDP Dispatch

Sources: `plugins/browser/scripts/browser-service.mjs` (1,611,121 B), `main-BPBEjAxi.js`
(5,082,185 B), `docs/capabilities/tab/cdp.md`, `docs/accessibility.md`. Quoted bytes are verbatim
from the target unless labeled otherwise. **[verified]/[inferred]/[unknown]** per claim.

## 1. Where the engines live **[verified]**
The agent-facing engine (`browser-service.mjs`) runs inside the plugin `node_repl` process — NOT in
Electron main: literal `dom_cua_get_visible_dom` / `tab_ax_get_state` / `playwright_dom_snapshot`
occurrence count in main bundle = 0 (only `tab_cdp_call`×1). The service reaches the page through a
native pipe:
```js
function Zle(){let e=globalThis.nodeRepl?.nativePipe;return e==null||typeof e.createConnection!="function"?null:e}
var Vo=class extends us{constructor(t){super(t,{decodeMessage:c6})}
static async create(t){return await ab(t,{decodeMessage:c6})}}
async function ab(e,t,r){let n=Zle();if(n==null)throw new Error(r??Jle());return new us(await n.createConnection(e),t)}
function c6(e){if(e==null||typeof e!="object"||Array.isArray(e))throw new Error("invalid native pipe transport message");return e}
```
Electron main only owns `webContents.debugger`:
```js
let r=!e.debugger.isAttached(),i=e.debugger;r&&e.debugger.attach(`1.3`);
let a={users:new Set,browserUseUsers:new Set,childSessions:new Set,ownsAttachment:r,annotati…}
e.debugger.isAttached()||(e.debugger.attach(`1.3`),a=!0),e.debugger.on(`message`,u),c=!0,
e.debugger.sendCommand(`Network.enable`,{maxPostDataSi…})
```
`cua_node` runtimes: `browser-accessibility.wasm.br` (4,084,148 B) + `zxing_reader.wasm` (1,065,866 B, QR/barcode
decoder loaded from `./zxing_reader.wasm`, fallback `../../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm`,
CDN fallback `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.2/dist/${name}/${file}`).

## 2. CDP method inventory (service, call-count census) **[verified]**
```
Page: getFrameTree(30) frameNavigated(19) enable(8) createIsolatedWorld(8) startScreencast/stopScreencast/
  screencastFrame(+FrameAck) captureScreenshot(2) addScriptToEvaluateOnNewDocument(2)
  setInterceptFileChooserDialog(4) javascriptDialogOpening/handleJavaScriptDialog navigate(·)
  navigateToHistoryEntry getNavigationHistory resetNavigationHistory
Runtime: evaluate(17) callFunctionOn(8) releaseObject(7)
DOM: describeNode(10) getBoxModel(6) getContentQuads(5) resolveNode(5) getNodeForLocation(2)
  scrollIntoViewIfNeeded(2) setFileInputFiles(3)
Input: dispatchMouseEvent(7) dispatchKeyEvent(5) insertText dispatchDragEvent
Target: setAutoAttach getTargets attachedToTarget detachedFromTarget
Fetch: enable continueRequest continueResponse fulfillRequest failRequest disable
Network: getAllCookies enable
Accessibility: enable(1) getFullAXTree(1) loadComplete(1) nodesUpdated(1)   // corrects earlier census
```
Emulation domain absent (viewport override is app-side, not CDP `Emulation`).
CDP wrapper: `t.cdp.call(tabId, method, params?, {deadlineMs?, timeoutMs?})` + `sD(t)` (ensure-domain) **[inferred names]**.

## 3. `dom_cua_get_visible_dom` — filtered interactable DOM with `node_id` **[verified]**
```js
wD=F("dom_cua_get_visible_dom",async(e,t)=>{
  let r=W(e.tab_id);
  return await t.acquireAuthority().observeContent(await t.security.currentTabUrl(r)).assert(),
         await vD(r,t.cdp)})
async function _D(e,t,r,n=new Set){return await vD(W(e.tab_id),t.cdp,{credentialFrameId:r,
  reviewer:{capturedFrameIds:n,nextNodeId:1},timeoutMs:Ve(e)})}
```
`get_visible_dom(): Promise<unknown>; // Return a filtered DOM with node ids for interactable elements.` (api.json)
Budget constants (verbatim): `oc=2e4, ic=200, nY=5e3, oY=50, bD=500, gD=1e3`.
Walker driver (verbatim):
```js
function vD(e,t,r={}){sD(t);
 let n=r.timeoutMs==null?void 0:Date.now()+r.timeoutMs,
 {frameTree:o}=await t.call(e,"Page.getFrameTree",void 0,n==null?{}:{deadlineMs:n,timeoutMs:r.timeoutMs}),
 i=uY(o.frame);
 r.reviewer==null&&aD(e,i);
 let s=r.credentialFrameId===o.frame.id?void 0:r.credentialFrameId,
 a={chars:0,lines:[],...r.reviewer==null?{}:{reviewer:r.reviewer}},
 l=await q_({cdp:t,childFrameDeadline:Date.now()+gD,deadlineMs:n,
   frameReference:{frameId:o.frame.id,loaderId:o.frame.loaderId,target:{tabId:e}},
   ...s==null?{}:{maxChars:oc-nY,maxElements:ic-oY}, output:a, tabId:e, viewportClip:void 0});
```
Per-frame walker runs as an injected page function. Captured option object (verbatim):
```js
{attributeNames: …, booleanAttributeNames:tJ, codexOverlayRootId:gA, interactiveRoleNames:rJ,
 interactiveTags:[…QX], maxChars:e, maxElements:t, renderedAttributeNames:eJ, reviewerOnly:n, viewportClip:r}
return `(() => {`   // page-function template, closed with the option object inlined
```
Line builder inside the page function (verbatim; note UNMINIFIED literals survive in the template body):
```js
se=(k,O)=>{let U=b(k),K=[`node_id=${O}`];
 for(let M of e.renderedAttributeNames){
   if(M==="value"&&(t(k,r)||e.reviewerOnly&&(U==="input"||U==="textarea"||U==="select"))){
     !e.reviewerOnly&&(k instanceof HTMLInputElement||k instanceof HTMLTextAreaElement||k instanceof HTMLSelectElement)…
```
Constant definitions (verbatim — A1 CLOSED; the bundle carries two identical copies with different
minified names, second copy: `ou=2e4,iu=200,nJ=5e3,oJ=50,bO=500,gO=1e3,yO="const __name = (target) => target;"`
— `yO` is the page-function banner prepended before the injected template):
```js
QX=new Set(["a","button","details","input","option","select","summary","textarea"])
eJ=["aria-disabled","aria-label","contenteditable","href","name","placeholder","role","title","type","value"]
tJ=["checked","disabled","multiple","readonly","required","selected"]
rJ=["button","checkbox","combobox","link","menuitem","option","radio","slider","spinbutton","switch","tab","textbox"]
gA="codex-agent-overlay-root"   // codexOverlayRootId
```
### 3.0.1 Page-side ref registry (inside the injected walker, verbatim)
```js
u=globalThis,
d=u[e.reviewerOnly?"__browserUseReviewerVisibleDomState":"__browserUseVisibleDomState"]
   ??={elementToRef:new WeakMap,nextId:1,refToElement:new Map};
d.refToElement.clear();                       // per-snapshot action map reset; stable refs survive via WeakMap
V=k=>{let O=d.elementToRef.get(k);return O==null&&(O=String(d.nextId++),d.elementToRef.set(k,O)),O}   // stable local ref
s.push({line:U,ref:O}),d.refToElement.set(O,k)                       // interactive line path
Q=k=>{…let U=V(k);if(i.some(ve=>ve.ref===U))return;…
   i.push({rect:O,ref:U,size:{height:pe,width:M},…K.length>0?{url:K}:{}}),d.refToElement.set(U,k)}  // iframe candidate path
```
Walker viewport clip: `window.visualViewport` → `{bottom:offsetTop+height,left:offsetLeft,right:offsetLeft+width,top:offsetTop}`
fallback `{bottom:innerHeight,left:0,right:innerWidth,top:0}`. Overlay exclusion
`k.closest(\`#${e.codexOverlayRootId}\`)==null`.

### 3.0.2 Service-side stable-id state `yo` (checklist 5, verbatim — A2 CLOSED)
```js
// per-tab state, reset each snapshot:
n.framesById.clear(),n.nodeByPublicId.clear(),
n.publicIdByFrameLocalRef.size>XX&&(n.publicIdByFrameLocalRef.clear(),n.nextPublicId=1),yo.set(e,n)
lO(e,t){yo.get(e)?.framesById.set(t.frameId,t)}
cO(e,t,r,n){let o=yo.get(e);if(o==null)throw new Error("DOM CUA snapshot state is missing");
 let i=YX(t,r),s=o.publicIdByFrameLocalRef.get(i);
 return s==null&&(s=String(o.nextPublicId++),o.publicIdByFrameLocalRef.set(i,s)),
 o.nodeByPublicId.set(s,{frameId:t.frameId,loaderId:t.loaderId,localRef:r,target:t.target,viewportClip:n}),s}
uO(e,t){let r=yo.get(e)?.nodeByPublicId.get(t);if(r==null)throw new Error(`DOM node ${t} is stale or missing`);return r}
```
The emitter's `uD(tabId,frameRef,ref,clip)` = `cO`: public id keyed on frame+localRef, monotonic
`nextPublicId`, wholesale cache eviction past `XX` entries restarts ids at 1.

### 3.0.3 ref→coordinates resolution (service, verbatim)
```js
function ux(e,t,r,n=!1){let o=uO(e,r),
 i=await wa(t,o.target,o.frameId,o.loaderId,Kne(o.localRef,o.viewportClip),{returnByValue:!0});
 if(i.exceptionDetails!=null)throw new Error(Yne(i.exceptionDetails));
 let s=Jne(i.result.value);if(s==null)throw new Error(`DOM node ${r} is stale or missing`);
 return{inputPoint:await mO(e,t,o.frameId,s,n),point:await pO(e,t,o.frameId,s,n),target:o.target}}
function wa(e,t,r,n,o,i){let s=await oO(e,t,r,n,i.timeoutMs);   // isolated-world ctx; cache bo keyed fO(target,frameId,loaderId)
 try{return await iO(e,t,s,o,i)}catch(a){if(!ZX(a))throw a;
   return bo.delete(fO(t,r,n)),s=await oO(e,t,r,n,i.timeoutMs),await iO(e,t,s,o,i)}} // context-gone → rebuild once
function Kne(e,t){return`(() => {\n ${Vne}\n return (${Xne.toString()})(${JSON.stringify(e)}, ${JSON.stringify(t)});\n})()`}
function Xne(e,t){let n=globalThis.__browserUseVisibleDomState?.refToElement.get(e);
 if(!n?.isConnected)return null;
 n.scrollIntoView({block:"nearest",inline:"nearest"});
 let o=i=>{if(i.width<=0||i.height<=0)return null;
   let s=Math.max(i.left,t.left),a=Math.min(i.right,t.right),l=Math.max(i.top,t.top),u=Math.min(i.bottom,t.bottom);
   return a>s&&u>l?{x:s+(a-s)/2,y:l+(u-l)/2}:null};
 for(let i of n.getClientRects()){let s=o(i);if(s!=null)return s}
 return o(n.getBoundingClientRect())}
```
- Frame-local→page-space (`pO`): walks `framesById` up the `parentFrameId` chain applying `dO`:
  iframe anchor `DOM.getFrameOwner`→`backendNodeId`; sized frames use `DOM.getBoxModel`(model.content)
  + in-page `({width:innerWidth,height:innerHeight})`, else `DOM.getContentQuads`[0]; point transform `ci(n,s,a)`;
  errors `Could not inspect the DOM CUA frame viewport` / ``Missing frame geometry for DOM CUA frame ${frameId}``.
- `clickDomCuaNode`: `let{inputPoint:r,point:n,target:o}=await ux(…); At(o)? clickPoint({clickCount,inputPoint:r,
  inputTarget:o,loadTarget:o,modifiers:0,point:n,…}) : clickPoint({modifiers:0,point:n,…})`.
- `scrollDomCuaNode` → ux → `scrollPoint({modifiers:0,point,scrollX,scrollY,tabId})`; node-less scroll →
  `mte` = `Page.getLayoutMetrics` → `{x:cssVisualViewport.clientWidth/2,y:clientHeight/2}`.
- `dom_cua_keypress` → `dispatchKeyPress` → `Bs(cdp,tabId,keys,{blockClosedShadowInput})`: modifier down/up
  stacks (`Yy` keys need down+up, others `Input.insertText`); X11-style map `Tp(e,t="linux")`.
- `dom_cua_type` = clipboard-based typing (verbatim):
```js
function qs(e,t,r){if(typeof e.text!="string")throw new Error(`${r} requires text`);
 let n=W(e.tab_id),o=e.includeRichText!==!1&&await DG(n,t),i=MG(e.text,o);
 await t.clipboard.runExclusive(async()=>{await mc({args:{action:"paste",clipboardItems:i,
   ...e.inputTargetToken==null?{}:{iabInputTargetToken:e.inputTargetToken},replaceInputValue:e.replaceInputValue,
   documentOnly:t.playwright.executionPolicy.documentOnly,requireDocumentFocus:e.executionContextId!=null,
   ...o?{richTextFallback:!0}:{}},commandType:r,ctx:t,executionContextId:e.executionContextId,
   pageFunction:Cp,tabId:n,...e.target!=null?{target:e.target}:{}})})}
```
- Node-id validation pair: required `Mh` / optional `TN(e,t){return e===void 0?void 0:SN(e,t)}`,
  `SN` = `oe.DomCuaClick.DomNodeIdSchema.safeParse` → `` `${command} ${issue.message??"has an invalid node_id"}` ``.
- Main debugger attachment record (annotation focus lease):
  `{users,browserUseUsers,childSessions,ownsAttachment,annotationRequested:!1,annotationLease:null,debuggerSync:Promise.resolve()}`;
  `annotationRequested=t&&n.ownsAttachment&&n.browserUseUsers.size===0`; lease `$d(e)`,
  `Emulation.setFocusEmulationEnabled{enabled}` serialized on the `debuggerSync` chain, `[Symbol.dispose]` release.

Node-id emission (verbatim):
```js
let c=e.output.reviewer==null?uD(e.tabId,t,l.ref,a):String(e.output.reviewer.nextNodeId++),
    d=l.line.replace(`node_id=${l.ref}`,`node_id=${c}`),
    p=d.length+(e.output.lines.length===0?0:1);
if(e.output.chars+p>i)break;
e.output.lines.push(d),e.output.chars+=p,e.output.reviewer?.capturedFrameIds.add(t.frameId)
```
- Stable per-tab ids come from `uD(tabId, frameRef, ref, aux)`; a "reviewer" pass instead allocates sequential
  `nextNodeId++` starting at 1, with `capturedFrameIds` tracking frames included.
- Element→ref registry in reviewer mode: `O==null&&(O=String(d.nextId++),d.elementToRef.set(R,O))`.
- Per-line attributes: `K=[`node_id=${O}`];for(let M of e.renderedAttributeNames){...}` — `value` suppressed for
  password-ish inputs (`t(R,r)` guard) and (reviewerOnly) for input/textarea/select.
- Frame key format seen: `` `${e.targetId}:${e.frame.frameId}:${p.nodeId}` ``; DOM node refs `` `node:${e}` ``.
- `node_id=` appears inside each rendered line; lines are appended until `maxChars` budget `i` is hit (line truncated by break).
- Credential-frame protection: when a `credentialFrameId` is set, that frame gets reduced budget
  (`oc-nY`=15,000 chars, `ic-oY`=150 elements) **[inferred]** — Ruke applies the reduced budget
  whenever the credential-guard config is active for the snapshot (Phase 5, `credential_budget()`;
  the per-frame `credentialFrameId` plumbing is a Chromium-iab multi-frame concern Ruke does not have).

### 3.0.4 Phase-5 re-verification: reference-copy identity + the `ci`/`ui`/`hp` geometry trio (verbatim)

**File identity law (load-bearing for all future RE in this area):** the dom-CUA walker and
geometry helpers live in
`app/resources/plugins/openai-bundled/plugins/browser/scripts/browser-service.mjs`
(byte length 1,611,121; `function hY(` at char 763,971; `"Missing frame geometry for DOM CUA frame"`
at 754,791). The `plugins/chrome` copy is byte-identical in that region. The
`@oai/browser-desktop` and `@oai/cua` copies of `browser-service.mjs` carry `hY` at char 729,080 —
their byte range 160,150–160,850 is ElementInfo API-doc TEXT, not code; the previously pinned
"p5@160,335 / ui@160,527 / hp@160,669" offsets belong to NO currently-existing copy and must not be
reused. Re-extractions must pass the target path as a process argument, never inline in `-e` strings.

Point transform trio used by `dO` (`ci(n,s,a)` above; `n`=quad, `s`=frame-local point, `a`=frame size):
```js
p5(e,t,r){let n={x:r[0]??0,y:r[1]??0},o={x:r[2]??0,y:r[3]??0},i={x:r[6]??0,y:r[7]??0},
 s=e.x/t.width,a=e.y/t.height;
 return{x:n.x+s*(o.x-n.x)+a*(i.x-n.x),y:n.y+s*(o.y-n.y)+a*(i.y-n.y)}}
ui(e,t,r){if(r==null||r.length<8)return null;
 return t!=null?p5(e,t,r):(()=>{const n=hp(r);if(!n)return null;return{x:n.left+e.x,y:n.top+e.y}})()}
hp(e){if(e.length<8)return null;
 const xs=[e[0],e[2],e[4],e[6]].filter(v=>v!=null),ys=[e[1],e[3],e[5],e[7]].filter(v=>v!=null);
 if(xs.length!==4||ys.length!==4)return null;
 return{bottom:Math.max(...ys),left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys)}}
```
Ruke ports these byte-faithfully (`transform_point_scaled` / `transform_point` / `quad_bounds` in
`rust-backend/crates/ruke-browser/src/dom_cua.rs`); the unit table
(quad `[10,20,110,20,110,120,10,120]`: (5,5)@(100,100)→(15,25); (50,50)@(200,200)→(35,45);
(5,5) unsized→(15,25)) matches the reference semantics exactly — the earlier summary expectation
"sized (5,5)→(60,70)" was a mis-pin, NOT a port bug. The page walker `hY` is ported BYTE-EXACT
(EXACT_MATCH against the raw extraction `walker_hy.txt`); the `dD` frame-hop chain (`getFrameOwner`
→ sized `getBoxModel.content` + in-page `({width:innerWidth,height:innerHeight})` else
`getContentQuads[0]`, then `ui(n,s,a)`) is ported as `frame_geometry_hop`, and Ruke applies the
parent-frame chain per hop (`pD` [adapted]: the reference's same-target skip is a Chromium-iab
multi-target concern; Ruke has one CDP target per tab). Real-Chromium smoke (`smoke_lifecycle`,
Phase-5 block) proves the transform end-to-end: a walker node inside a fixed iframe is clicked and
focuses `inner-in` inside the iframe document.

### 3.1 `dom_cua_*` action schemas + ref→coordinates dispatch (client side, verbatim)
```js
tn = /* DomNodeIdSchema */ …(`node_id must be a string`).min(1,`node_id must not be empty`)
uR = m.object({browser_id:m.string(),tab_id:m.string(),node_id:tn})        dR="dom_cua_click"
pR = m.object({browser_id,tab_id,node_id:tn,timeout_ms:m.number().int().positive().optional()})
     mR="dom_cua_download_media"; VV=m.object({})  (empty result schema)
fR = m.object({browser_id,tab_id,node_id:tn})                              (dom_cua_scroll/type variants)
// handler (service):
CN=L("dom_cua_click",async(e,t)=>{
  await t.acquireAuthority().actInFrame(await t.security.currentTabUrl(Number(e.tab_id))).assert(),
  await t.followSessionTab(Number(e.tab_id));
  let r=Mh(e.node_id,"dom_cua_click");
  return await t.cua.clickDomCuaNode({clickCount:1,nodeId:r,tabId:W(e.tab_id),timeoutMs:e.timeout_ms}),{}})
// validation: DomNodeIdSchema.safeParse → `${t} ${err.issues[0]?.message} has an invalid node_id`
```
- Mutating commands authorize via `acquireAuthority().actInFrame(url)` (reads use `observeContent`).
- `followSessionTab` enforces turn-claim ownership before acting.
- `cua.clickDomCuaNode({clickCount,nodeId,tabId,timeoutMs})` resolves the stored node-id → element
  (registry internals = A2 open: grep `clickDomCuaNode` ±900, `Mh=`).
- Command-capability Sets (verbatim, role **[inferred: turn-scoped command allowlists]**):
  `get_tab, tab_screenshot, tab_handle_js_dialog, cua_*, dom_cua_*, tab_ax_*, playwright_dom_snapshot,
  playwright_evaluate, playwright_locator_*…`.
- Also located: `af="browser_visibility_get"`, payload `{browser_id}`, result `{visible:boolean}`.

## 4. Playwright `dom_snapshot` (aria-snapshot engine) **[verified]**
```js
var KN=" >> internal:control=enter-frame >> ",Lte=500,Ute=1e3,
JN=F("playwright_dom_snapshot",async(e,t)=>{
  await t.acquireAuthority().observeContent(await t.security.currentTabUrl(Number(e.tab_id))).assert();
  let r=Ve(e), n=await t.playwright.evaluateOnPlaywrightPage(e.tab_id,s=>{
       let a=document.body||document.documentElement; ... ot(c,{mode:"ai"}) ...});
  // iframe line rewrite:
  l.iframeRefs.filter(p=>{ if(!(p in l.iframeDepths))return!1;
    let[f]=s.querySelectorAll(s.parseSelector(`aria-ref=${p}`),a); if(f==null)return!1;
    let g=f.getAttribute("id"),b=f.getAttribute("name"),
        _=[...g?[`[id=${JSON.stringify(g)}]`]:[],...b?[`[name=${JSON.stringify(b)}]`]:[]].join(" ");
    return _&&(c=c.replace(/^([ \t]*- iframe(?: [^\r\n]*)?) \[ref=([^\]\r\n]+)\]/gm,
      (x,E,T)=>T===p?`${E} ${_} [ref=${p}]`:x)),
      f.getAttribute("aria-hidden")!=="true" && s.elementState(f,"visible").matches===!0}),
  ...
  if(t.playwright.executionPolicy.documentOnly)return{dom_snapshot:XN(n.full)};
  let o=t.isIabBackend?Date.now()+Ute:void 0, i=await ZN(t,e.tab_id,n,r,void 0,o);
  return{dom_snapshot:XN(i)}})
```
Key facts:
- Snapshot rendered with Playwright `mode:"ai"` aria-snapshot options; elements carry `[ref=…]` tokens;
  `aria-ref=` is a registered selector engine; frames are entered via the Playwright internal control
  ` >> internal:control=enter-frame >> ` with waits `Lte=500ms` cap, `Ute=1e3ms` IAB deadline.
- Telemetry attrs confirm: `"browser_use.playwright.snapshot.mode":"ai"`, `"browser_use.playwright.snapshot.target":"body_or_document"`.
- Post-processing helpers (verbatim regexes):
  `Wte = e=>e.replace(/ \[ref=[^\]]+\]/g,"").replace(/ \[cursor=[^\]]+\]/g,"")` (strip refs/cursor)
  `$te = /^- (generic|listitem|group)(?: \[[^\]]+\])*:?$/.test` (prune empty generics)
  `Gte = /^- img…/` (img pruning), `XN = e=>!e.startsWith("- ")&&!e.includes("\n")?-1:…` single-line filter **[inferred]**,
  `jte` extracts ref from `- iframe ... [ref=X]` lines.
- Playwright core is embedded in the service and driven over the CDP bridge (`evaluateOnPlaywrightPage/
  evaluateOnPlaywrightSelector`, `parseSelector`, `elementState`, `queryAll`) — Playwright never runs in the page **[verified call names]**.
- Locator actions map 1:1 to `playwright_locator_*` commands (§2 of schemas-and-ipc.md). File chooser:
  `Page.setInterceptFileChooserDialog` + `playwright_file_chooser_set_files` → `DOM.setFileInputFiles`;
  download anchors built in page (verbatim createElement("a")+download attr flow).

## 5. Accessibility (AX) engine **[verified]**
```
CDP: Accessibility.enable → loadComplete → getFullAXTree → nodesUpdated
wasm module: ./browser-accessibility.wasm.br
exports: computer_use_browser_wasm_allocate | _deallocate | _revision_create | _revision_release
         | _revision_copy_text | _revision_copy_identity | _revision_identity_length
         | _revision_text_length | _revision_is_value_settable
lifecycle: Nre=new FinalizationRegistry(({runtime:e,pointer:t})=>{e.exports.computer_use_browser_wasm_revision_release(t)})
capture handler (tab_ax_get_state):
let i=await t.ax.capture(r,e.content,{disableDiffing:e.disable_diffing||o>0},()=>Ui({tab_id:e.tab_id},t,"css"));
... t.ax.validateCapture(r,i) ... retry loop o<=1 with session-id stability check (getCurrentSessionId)
snapshot internals: {tab, nodes:b, warnings:s, frames, targets, documentKey:Lr(mainFrameId,loaderId),
  active:o?.active??!1}
rendering: x=this.accessibilityCore.buildRevision(t.accessibilityRevision,_,{mode:r.disableDiffing?"full":"auto"});
           return{tab:_.tab,rendered:x.text,elementCount:b.length,url:n.frame.url,documentKey:d,...}
```
- Revision objects live in wasm memory; JS keeps identity/text via copy_* exports + length probes;
  `is_value_settable` gates `set_value` (`o.isValueSettable===!1 → "Accessibility element N has no settable value"`).
- Diffing is **incremental state machine** (`buildRevision(prevRevision, current)`) with `auto` default, `full`
  on `disableDiffing` **[verified]**; per-node `element_index` = wasm revision element index, resolved back via
  `identityForElement` → targets Map join (§5.1) **[verified — A16 closed, was inferred]**.
- Action dispatch union `WR` (zod, verbatim fields): `paste{element_index?, text, format?:text|md|html}`,
  `click{target, mouse_button?:left|right|middle|l|r|m, click_count}`, `drag{from,to}`,
  `perform_secondary_action{element_index, action}` (only `Expand`/`Collapse` validated against
  `actionDescriptions`), `press_key{element_index?, key, duration?0..30}` (xdotool-style keys),
  `scroll{target, direction, pages?}`, `select_text{element_index, text, prefix?, suffix?, selection_type?:text|cursor_before|cursor_after}`,
  `set_value{element_index, value}`, `type_text{element_index?, text}`.
  Envelope `$R={browser_id,tab_id,action:WR}`. Resolution: `e.ax.targetForElement(tabId, element_index)`.
- Dialog awareness: `captureJavaScriptDialog(t,r,n)`; when an AX target has `javaScriptDialog`,
  throws `"A JavaScript dialog is blocking the requested page element"` **[verified]**.
- Input coordinates from AX: `Hv(...)` focus-then-input; mouse: `Input.dispatchMouseEvent` with
  `{x,y}` from quad/box (`$v(e,t,r.element_index,{clickCount:1})`).

### 5.1 A16 closure — revision text grammar, wasm identity join, capture state machine, full action engine **[verified 2026-10-26; one boundary CLOSED-contract]**

**REA instrument boundary (deciding instrument, recorded first):** `rea@6.8.0` `inspect-wasm-artifact`
has a hard input cap of 8,388,608 B with **no runtime override**; decompressed
`browser-accessibility.wasm` = 20,208,690 B → REA refused inline analysis (`out/wasm_rea.json`,
evidence `ev_bfc0d6af…`). REA's returned tool_profile prescribes WABT 1.0.42
(`--enable-all --ignore-custom-section-errors`; sha256: wasm-validate `4939f4bc…`,
wasm-objdump `7f9cf21c…`, wasm2wat `9ccce93d…`, source_commit `ff0ef7e0…`); per that prescription
WABT 1.0.42 was installed and sha256-verified at
`C:/Users/Ruku/AppData/Local/Temp/codex_re/tools/wabt1042/` (user-authorized 2026-10-26) and used as
REA's designated instrument (`out/wasm_objdump_x.txt`, `out/wasm_strings.txt`, `out/wasm_pool_A.txt/B.txt`).

**Wasm module identity** (sha256 `489ab336ff6956ff66af93ad997e75f3d29fad395bc06e10afb1d68c60fec346`):
34 WASI preview1 imports; **11 exports** = `memory` + `_initialize` + the exact 10-export glue manifest
(H-BS-11 REQUIRED MANIFEST — corrects the earlier "9 exports" ledger row); Swift-compiled
(`.swift1_autolink_entries`); 21 data segments.

**Rendered-grammar string pool (verbatim, `out/wasm_pool_A.txt`, file offsets 16,424,000–16,438,000):**
diff header "The following is a diff from the previous accessibility tree with ~ and + representing
changed and added elements, respectively. Removed elements are summarized by ID range.";
"There has been no change in the accessibility tree."; "Scroll to Visible"; "Removed element IDs: ";
"The focused UI element is "; selected-text fence literal ```` `"Selected text: ```"` ````;
selected-content Note ×2; "Secondary Actions"; "Remove unused rows"/"columns";
`BrowserAccessibility*` type names; `ChromeAccessibilityWire*` = CDP Accessibility.getFullAXTree wire
DTOs (carry `backendDOMNodeID`); role-token→AX-enum table; env knobs
`TINYSKY_AX_TREE_DIFF_MIN_SAVED_RATIO`/`TINYSKY_AX_TREE_DIFF_MIN_SAVED_BYTES`;
failure label `AccessibilityDifferenceLineBudgetExceeded`.

**Line shape (JS-side half verbatim: Appendix H H-BS-12 Wte/$te/Gte + H-BS-21 jte/XN/Hte/YN/QN/e2):**
2-space indent + `- <role>` + ` [attr]` groups + optional trailing `:`; JS post-processing strips
`[ref=…]`/`[cursor=…]` (Wte), drops/tests iframe·generic·listitem·group·img lines ($te/Gte/XN/Hte/QN/e2),
rebuilds removed-ID summary lines (e2). No ref/cursor/id format literals exist in the wasm printable
pools — exact per-line id-tag emission lives in compiled Swift (short literals). That is the one
**CLOSED-contract boundary**: replicate the line shape from the regexes + pool-A literals +
`documents/**/accessibility.md` examples (already verbatim in Appendix C).

**element_index → CDP join chain (proven verbatim; H-BS-24):**
`zh.targetForElement(t,r)` → `n.accessibilityRevision.identityForElement(r)` (wasm
`revision_identity_length`/`revision_copy_identity` ABI maps element_index → revision identity string) →
`n.targets.get(identity)` → `{target, backendNodeId, frameId, loaderId, javaScriptDialog?,
actionDescriptions, isOptionElement}`. Staleness errors: "Accessibility element ${r} is stale or
missing"; "Accessibility element ${r} belongs to a previous page" (documentKey !==
`Lr(mainFrameId,loaderId)` = `` `${mainFrameId}:${loaderId}` ``). Targets Map built in buildAXCandidate
keyed by `Fv(tabId,node)` = join "|" over `[String(tabId), targetID??"", backendDOMNodeID??nodeID]`
with TextEncoder byte-length prefixes. `actionDescriptions`: AX property
`expanded===true→["Collapse"]`, `===false→["Expand"]` (origin of the Expand/Collapse secondary-action
labels); `isOptionElement` via DOMSnapshot metadata tagName==="option";
`isValueSettable` via wasm `revision_is_value_settable`.

**Capture freshness state machine (`zh` head, H-BS-26) — constants verbatim:**
`Hre=new Set(["firstMeaningfulPaint","firstContentfulPaint","firstPaint","firstImagePaint"])`,
`Wre=1000`, `$re=500`; `nl=class extends Error{super("Accessibility capture belongs to a previous page")}`.
capture(): screenshot-only fast path → 250 ms pendingNavigationState recheck → waitForNavigation
(25 ms detect, then 5e3 until committed) → waitForFirstPaint (5e3 until painted/complete) →
waitForAXQuiet (750 ms deadline; quiet threshold 50 ms when forced else 100 ms since
lastAXUpdateMilliseconds; 25 ms poll) → 3-attempt captureCandidate loop (empty AX → "Accessibility
capture was empty"; elementCount<100 && q2(probe) → 100 ms + one re-probe; j2 match or
revision-stable/painted/screenshotUnavailable → commit; else repaint+quiet retry) → terminal
"Accessibility capture changed before it stabilized". `q2` large-page probe:
`documentElementCount>=Math.max(150,e*3)` or `e<50 && documentTextLength>=4e3`. `j2` worth-capture:
dialog→elementCount>=3; else painted/complete + elementCount>=10 + same host+path.
commitCapture state string: `Browser tab: ${a.id}, Title: ${JSON.stringify(title??"Unknown")}, URL:
${JSON.stringify(url??"Unknown")}${", Site Specific Instructions: …"}.\n${rendered}` (getSiteInstruction
hook) + captureProvenance WeakMap → validateCapture→nl. `ensureTracked`: Page.getFrameTree,
Accessibility.enable per target (Wh key `` `${tabId}:${sessionId??targetId??"root"}` ``),
Page.setLifecycleEventsEnabled, readDocumentState{includePaint}. probeNavigationState JS:
`(() => { const body = document.body; return { readyState: document.readyState, elementCount:
body?.querySelectorAll('*').length ?? 0, textLength: body?.innerText?.length ?? 0 }; })()`.
performAction: prompt-dialog set_value/type_text bumps `revision+=1` (invalidates the diff).

**Action engine (H-BS-24/H-BS-25, all verbatim):** `$h.perform()` serializes pendingInput per tab and
races JavaScript dialogs via the `tl` wrapper (Page.javascriptDialogOpening, beforeunload skipped) —
error: "Browser action \"${r.kind}\" interrupted by JavaScript ${s.type}: ${a} The action may already
have taken effect; do not retry it. Inspect or dismiss the dialog before continuing.". `_re` kind switch:
click `$v` (target = element_index | {point}; IAB owner chain `Ic` attach, errors "Click target is no
longer available"/"Could not check the click target's shadow root"; option → `Bre` →
"select-option" via `playwright.evaluateOnPlaywrightNode(Dre)` selectOptions ("Select changed before
option activation") or "physical-click" when multiple/size>1/:open&&appearance==="base-select";
`W2` hit-test settle loop: DOM.scrollIntoViewIfNeeded then poll `bre=25 ms`, deadline `yre=500 ms`,
settle tolerance `wre=.5` across point/width/height — "Element ${id} couldn't be clicked. Try another
element." / "did not settle after scrolling" / "is covered by ${hitTag??"another element"} or otherwise
not hittable"), drag (8-point interpolated `dragPath`), `perform_secondary_action` `Tre` (only
Expand/Collapse allowed AND must be in actionDescriptions → synthesized click), type_text `Hv`
(3e3 ms; "Could not prepare accessibility element ${r} for input within 3000 ms. No input was sent."),
paste `Zy` (virtual clipboard: clipboard.runExclusive paste/paste-plain-text/copy/cut cutToken
crypto.randomUUID; `{mime_type:"text/plain"[,"text/html"]}`), press_key (`oo`/`Sp` keypress map else
dom_cua `Bs`), scroll `Sre` (Input.dispatchMouseEvent mouseWheel; axis size `Math.max(dimension,100)*pages`;
left/l/up/u negative), select_text `Oo+kre` (uniqueness `${prefix}${text}${suffix}` indexOf — "Text to
select was not found"/"matches multiple locations"; input/textarea setSelectionRange else TreeWalker
SHOW_TEXT + Range; text→end, cursor_before/after), set_value `Ere` (`isValueSettable===false → "has no
settable value"`; in-page selector `H2`: checkbox/radio/switch value ∈ 0/1/false/true via native
`HTMLInputElement` checked setter from getOwnPropertyDescriptor + indeterminate cleared + input/change
dispatch + "did not retain the requested state"; select single = value match then unique label/text
match with ambiguous/disabled errors + native option selected setter; input/textarea native value setter,
color lowercased #rrggbb, file input refused, rollback+rejected error; role=tab "1"/"true" branch).
All in-page selectors run through `Oo` = DOM.resolveNode + Runtime.callFunctionOn with wrapper
`function (argument) { const __name = (target) => target; return (${r.toString()}).call(this, argument); }`
returnByValue + userGesture + releaseObject. Coordinates validated via Page.getLayoutMetrics
cssVisualViewport ("Coordinate is outside the active tab content viewport"; `Cre` array guard +
telemetry `ar("tab_ax_action",t)`). Hit-test frame walk `Wv`: DOM.getContentQuads/getBoxModel per frame,
`ui` clip into per-frame viewport, owner-node `Ire` shadow-root elementFromPoint loop →
kinds hittable/covered(hitTag)/unpositioned; errors "Accessibility frame ${id} is unavailable" /
"has no content bounds". `Rre` activation/point solver: getClientRects + Text ranges, visualViewport
clamp midpoint, 17-selector control list, labels union, shadow `x()` slot/assignedSlot/host walk,
pointerEvents:none rule, label-rect fallbackPoint. `Pre` activation: closest
'a[href],button,input,select,textarea,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"]',
label.control, contenteditable true/""/plaintext-only, detached/disabled/read-only errors, focus
preventScroll + shadow activeElement verify else click. `Are` = Element.prototype.scrollIntoView
instant-center. `L2` DOMSnapshot→maps (shadowRootType closed → "inside"), `U2` frame-owner join
(warning `Iframe ${frameId} owner was not present in the accessibility tree`). JS-dialog AX surface:
`F2` dialog nodes, frameId `javascript-dialog:${id}`, controls accept|dismiss|prompt, backendNodeId:0,
Return/Enter→accept unless control==="dismiss", Escape→dismiss, prompt → updateJsDialogPrompt; fallback
text: "Screenshot unavailable while a JavaScript ${s.type} dialog is open. Use tab.ax.get(\"state\") and
tab.ax.click(elementIndex) to interact with its controls." Command layer: `$2=F("tab_ax_action")` —
acquireAuthority().actInFrame assert, followSessionTab, Do catch → ax.capture("axState") +
validateCapture → rethrow `` `${n.message}\n\n\n${o.state}` ``; `G2` no-op telemetry passthrough
{withSpan,withCommandTelemetry,currentCommandAttrs,currentPlaywrightOperation};
`J2=F("tab_ax_get_state")` — capture retry loop `for(let o=0;;o+=1)` re-throwing on session-id change
(getCurrentSessionId). zh tail (H-BS-27) event wiring: Page.frameNavigated (main frame) →
pendingNavigationState; Accessibility.loadComplete/nodesUpdated → lastAXUpdateMilliseconds=Date.now();
Page.frameDetached + Target.detachedFromTarget → invalidateFrame/enabledTargets.delete;
handleTabDetached → sessions.delete. readDocumentState (H-BS-23) evaluateJavascript probe:
`{ href, readyState, painted: performance.getEntriesByType('paint').some(...'first-paint'...
'first-contentful-paint') }` + topLevelUrlsByTabId href cache.
Residual `BROWSER_USE_AUTOMATED_SAFETY_PRECHECKS_ENABLED` cluster (Uy/ci/gp @~156164) tracked in the
Appendix I residual queue.

**Checklist items 4 & 6: AX half now CLOSED** (only boundary = compiled-Swift id-tag literal emission,
documented above as CLOSED-contract).

## 6. `tab_cdp_call` / `tab_cdp_events` raw capability **[verified contract, docs verbatim in annotation file]**
Main buffers CDP events per tab with `sequence` + cursor paging (`limit` 1..1000, `hasMore`, `truncated`,
`source:{extensionId?,sessionId?,tabId?,targetId?}`); child targets via `Target.attachedToTarget`;
`send(method, params, {target:{sessionId}|{targetId}, timeoutMs})`. Gated by `browser_use_full_cdp_access`
feature requirement + per-site `full_cdp_access` decision facet (`deny` observed value).

## 7. Screencast & screenshots
`Page.startScreencast/stopScreencast` + `screencastFrame`/`FrameAck` streaming **[verified names]**;
`screenshot_unavailable` field in ax result; screenshots are JPEG per docs/screenshots.md;
`tab_screenshot` command; virtual screenshot cancel: `interactionMode!==\`comment\`)&&this.cancelVirtualScreenshot`.

## 8. Ruke WebUI 1:1 blueprint (implementation mapping)
- `lib/browser/engine/commands.ts` — reproduce the `P(commandType, zodPayload)` envelope + command list §2.1 exactly
  (same wire names; zod mirrors).
- `lib/browser/engine/cdpBridge.ts` — per-`webContents` debugger manager mirroring main's registry
  `{users, browserUseUsers, childSessions, ownsAttachment}` + shared `Network.enable`; one `debugger.attach("1.3")`
  owner with refcounting; event ring buffer `{sequence, hasMore, truncated}` for `tab_cdp_events`.
- `lib/browser/engine/domCua.ts` — port vD/q_: Page.getFrameTree → injected per-frame walker → lines with
  `node_id=`; budgets 2e4/200/5e3/50/500/1e3; reviewer sequential ids; stable registry uD equivalent.
- `lib/browser/engine/ax/` — Accessibility.enable+loadComplete+getFullAXTree+nodesUpdated collector;
  revision diff builder (wasm optional: JS reimplementation acceptable if output text format matches).
- `lib/browser/engine/pw/` — embedded playwright-core (v1 vendored to match `aria-ref`, `internal:control=enter-frame`,
  mode:"ai" snapshot); post-regexes Wte/$te/Gte/XN verbatim.
- Keep `browser_use_full_cdp_access` + per-site `access|downloads|uploads|full_cdp_access` decision facets (see spec.md §security).
