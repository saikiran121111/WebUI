//! dom_cua.rs — the Phase-5 DOM CUA engine: the filtered, interactable
//! page snapshot with stable public `node_id`s, plus the click / scroll /
//! type actions that resolve a public id back to a REAL element and drive
//! it through CDP `Input.*` on the same flattened session the panel sees.
//!
//! This module is a port of the reference engines recovered VERBATIM in
//! `reverse-engineering/internal-browser/dom-snapshot-and-cdp.md` §3
//! (page walker `hY`, driver `vD`/`q_`/`xD`, ref registries `yo`,
//! resolution `ux`/`Xne`, frame geometry `pD`/`dD`/`ui`/`p5`, password
//! guard `Ds`/`no`). Where the recovered minified code and the §3
//! prose-contract disagree, the choice is marked `[adapted]` inline; the
//! page-side semantics (walker source, ref registry, line format,
//! budgets, password redaction) are byte-faithful so later phases
//! (reviewer/credential flow, Phase 9) inherit the same behavior.
//!
//! Coordinate model (contract §3): each frame's snapshot runs inside that
//! frame's isolated world; a frame's `viewportClip` is expressed in the
//! frame's OWN coordinate space (`U_` makes a parent-space iframe rect
//! relative to the iframe origin before it is handed down); a resolved
//! point is lifted frame-local → page space one `parentFrameId` hop at a
//! time (`pD`, applying the iframe anchor's `DOM.getContentQuads`[0] +
//! candidate size scaling through `ui`/`p5` at every hop — `[adapted]`:
//! the recovered `pD` skips a hop for same-target intermediate frames;
//! §3's prose ("walks `framesById` up the `parentFrameId` chain applying
//! `dO`") is the contract, and per-hop is what nested iframes need).
//!
//! Not ported yet (their phases, honest gaps — never silently faked):
//! the reviewer pass + `credentialFrameId` side-path (browser-auth
//! flow, Phase 9 — the budget-discount math `oc-nY`/`ic-oY` is
//! implemented and unit-tested here so the Phase-9 flow can use it);
//! `dom_cua_keypress` (X11 key map, Phase 8 input work) and
//! `dom_cua_download_media` (file pipeline, Phase 8) stay typed
//! `Unsupported`. `dom_cua_type` focuses the resolved element and sends
//! `Input.insertText` `[adapted]` — the reference pastes through a
//! virtual-clipboard service Ruke does not have, and `insertText` is the
//! same primitive the reference's own keypress fallback uses.

use std::collections::HashMap;
use std::time::Instant;

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::cdp::CdpConn;
use crate::engine::BrowserRuntime;
use crate::errors::BrowserError;
use crate::pw::{combo_mask, pw_key_spec, pw_send_key};
use crate::session::TabRecord;

// ── Budget constants (verbatim `oc, ic, nY, oY, bD, gD`) ───────────────
pub const MAX_SNAPSHOT_CHARS: usize = 20_000; // oc
pub const MAX_SNAPSHOT_ELEMENTS: usize = 200; // ic
pub const CREDENTIAL_CHAR_DISCOUNT: usize = 5_000; // nY
pub const CREDENTIAL_ELEMENT_DISCOUNT: usize = 50; // oY
/// `bD`: per-child-frame CDP request budget in the reference's deadline
/// plumbing (`H_` clamps every hop's call timeout to it). Ruke's
/// [`crate::cdp::CdpConn`] enforces one global 30 s call timeout
/// instead; the constant is kept as the documented value of the pair.
pub const CHILD_CALL_BUDGET_MS: u64 = 500; // bD
/// `gD`: child-frame walks stop after this long from the root walk
/// (the `childFrameDeadline` in `vD`/`xD`).
pub const CHILD_FRAME_DEADLINE_MS: u64 = 1_000; // gD
/// `KX`: isolated-world context cache cap (FIFO eviction, `oD`).
pub const WORLD_CACHE_MAX: usize = 50;
/// `XX`: public-id cache cap; a snapshot reset past it clears the map
/// wholesale and restarts ids at 1 (`aD`).
pub const PUBLIC_ID_CACHE_MAX: usize = 5_000;

/// Page-side ref-registry global inside each frame's isolated world
/// (verbatim name; internal to the injected functions, never model- or
/// page-authoring-visible). Kept verbatim so the reviewer pass and the
/// action resolvers share one registry exactly as the reference does.
pub const PAGE_STATE_GLOBAL: &str = "__browserUseVisibleDomState";
/// Ruke analogue of `codexOverlayRootId` (`gA`): the agent's own overlay
/// DOM is never a snapshot candidate or action target.
pub const OVERLAY_ROOT_ID: &str = "ruke-agent-overlay-root";
/// `YX` worldName constant: the named isolated world every DOM-CUA
/// evaluation runs in (per frame).
pub const DOM_WORLD_NAME: &str = "ruke-dom-cua";

/// The credential-frame budget pair: `vD` walks the ROOT with
/// `(oc-nY, ic-oY)` when a credential frame sits below it.
pub fn credential_budget() -> (usize, usize) {
    (
        MAX_SNAPSHOT_CHARS - CREDENTIAL_CHAR_DISCOUNT,
        MAX_SNAPSHOT_ELEMENTS - CREDENTIAL_ELEMENT_DISCOUNT,
    )
}

// ── Viewport clips & geometry (pure ports of `L_`, `U_`, `hp`, `p5`/`ui`) ──

/// A viewport rectangle in a frame's own coordinate space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Clip {
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
    pub top: f64,
}

impl Clip {
    fn to_json(self) -> Value {
        json!({"bottom": self.bottom, "left": self.left, "right": self.right, "top": self.top})
    }
}

/// `L_`: clip intersection; degenerate intersections are `None`.
pub fn clip_intersect(a: Clip, b: Clip) -> Option<Clip> {
    let r = Clip {
        bottom: a.bottom.min(b.bottom),
        left: a.left.max(b.left),
        right: a.right.min(b.right),
        top: a.top.max(b.top),
    };
    (r.right > r.left && r.bottom > r.top).then_some(r)
}

/// `U_`: re-express `clip` relative to `outer`'s origin (this is how a
/// parent-space iframe rect becomes the child frame's viewportClip).
pub fn clip_relative_to(outer: Clip, clip: Clip) -> Option<Clip> {
    let r = clip_intersect(outer, clip)?;
    Some(Clip {
        bottom: r.bottom - outer.top,
        left: r.left - outer.left,
        right: r.right - outer.left,
        top: r.top - outer.top,
    })
}

/// `hp`: axis-aligned bounds of a CDP quad `[x1,y1, x2,y2, x3,y3, x4,y4]`.
pub fn quad_bounds(quad: &[f64]) -> Option<(f64, f64, f64, f64)> {
    if quad.len() < 8 {
        return None;
    }
    let xs = [quad[0], quad[2], quad[4], quad[6]];
    let ys = [quad[1], quad[3], quad[5], quad[7]];
    Some((
        xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        xs.iter().cloned().fold(f64::INFINITY, f64::min),
        ys.iter().cloned().fold(f64::INFINITY, f64::min),
    ))
}

/// `p5`: affine map of a frame-local point through the iframe anchor's
/// quad, scaled by the frame's own viewport size.
pub fn transform_point_scaled(p: (f64, f64), size: (f64, f64), quad: &[f64]) -> Option<(f64, f64)> {
    if quad.len() < 8 || size.0 <= 0.0 || size.1 <= 0.0 {
        return None;
    }
    let n = (quad[0], quad[1]);
    let o = (quad[2], quad[3]);
    let i = (quad[6], quad[7]);
    let sx = p.0 / size.0;
    let sy = p.1 / size.1;
    Some((
        n.0 + sx * (o.0 - n.0) + sy * (i.0 - n.0),
        n.1 + sx * (o.1 - n.1) + sy * (i.1 - n.1),
    ))
}

/// `ui`: the reference's frame-geometry point map — sized frames use the
/// `p5` affine; unsized frames translate by the quad bounds (`hp`).
pub fn transform_point(
    p: (f64, f64),
    size: Option<(f64, f64)>,
    quad: &[f64],
) -> Option<(f64, f64)> {
    if quad.len() < 8 {
        return None;
    }
    if let Some(s) = size {
        return transform_point_scaled(p, s, quad);
    }
    let (_, _, min_x, min_y) = quad_bounds(quad)?;
    Some((min_x + p.0, min_y + p.1))
}

// ── Page-side walker source (verbatim port of `hY` + `Ds`) ─────────────

/// `Ds`: the credential-sensitivity guard the walker embeds for `value`
/// suppression. Field-matching config `no` (verbatim attributes +
/// pattern) is passed as data alongside it.
const PASSWORD_GUARD_FN: &str = r##"(e,t)=>{let r=e.tagName.toLowerCase();if(r!=="input"&&r!=="textarea"&&r!=="select")return!1;if(e.getAttribute("type")?.toLowerCase()==="hidden")return!0;let n="";for(let o of t.attributes)n+=` ${e.getAttribute(o)??""}`;return new RegExp(t.pattern,"i").test(n)}"##;

fn password_guard_config() -> Value {
    json!({
        "attributes": ["type", "autocomplete", "id", "name", "placeholder", "aria-label", "title"],
        "pattern": "user[-_ ]?name|e[-_ ]?mail|one[-_ ]?time[-_ ]?code|password|passcode|passwd|\\botp\\b|\\b(?:2fa|mfa)\\b|phone|mobile|\\btel\\b",
    })
}

/// `hY`: the in-page walker (4,637 B at `browser-service.mjs` 763,967,
/// recovered verbatim — see dom-snapshot-and-cdp.md §3.0.4). Body is
/// byte-faithful: interactive predicate `E`, visibility `I` against the
/// viewport clip `g`, stable local refs `z` (WeakMap, per-snapshot
/// `refToElement.clear()`), line builder `se` (rendered attributes with
/// `value` redaction for credential-ish fields, boolean attributes via
/// IDL for checked/selected, `indeterminate`, 160-char escaped text
/// collector `V`/`L`), iframe candidates `Q` (rect + size + src),
/// shadow-root descent, and the overlay-root exclusion.
const PAGE_WALKER_FN: &str = r##"function(e,t,r){let n=new Set(e.interactiveTags),o=new Set(e.interactiveRoleNames),i=[],s=[],a=0,l=!1,c=globalThis,d=c[e.reviewerOnly?"__browserUseReviewerVisibleDomState":"__browserUseVisibleDomState"]??={elementToRef:new WeakMap,nextId:1,refToElement:new Map};d.refToElement.clear();let p=window.visualViewport,f=p?{bottom:p.offsetTop+p.height,left:p.offsetLeft,right:p.offsetLeft+p.width,top:p.offsetTop}:{bottom:window.innerHeight,left:0,right:window.innerWidth,top:0},g=e.viewportClip==null?f:{bottom:Math.min(f.bottom,e.viewportClip.bottom),left:Math.max(f.left,e.viewportClip.left),right:Math.min(f.right,e.viewportClip.right),top:Math.max(f.top,e.viewportClip.top)},b=R=>(R.localName||R.nodeName||"").toLowerCase(),_=new Set(["noscript","script","style","template"]),x=R=>R.getAttribute("id")===e.codexOverlayRootId,E=R=>{let O=b(R);if(R.getAttribute("aria-hidden")==="true"||R.hasAttribute("hidden")||O==="input"&&R.getAttribute("type")==="hidden")return!1;let U=R.getAttribute("contenteditable"),K=R.getAttribute("role");return n.has(O)||U!=null&&U.toLowerCase()!=="false"||R.hasAttribute("href")||R.hasAttribute("onclick")||K!=null&&o.has(K.trim().toLowerCase())||Number(R.getAttribute("tabindex")??-1)>=0||e.reviewerOnly&&Array.from(R.childNodes).some(Y=>Y.nodeType===Node.TEXT_NODE&&(Y.nodeValue??"").trim().length>0)},T=R=>{let O=b(R);return O==="frame"||O==="iframe"},I=R=>{let O=window.getComputedStyle(R);if(O.visibility!=="visible"||O.display==="none"||O.pointerEvents==="none"||Number(O.opacity)<=.01)return null;for(let U of R.getClientRects())if(!(U.width<=0||U.height<=0||U.right<=g.left||U.left>=g.right||U.bottom<=g.top||U.top>=g.bottom))return{bottom:U.bottom,left:U.left,right:U.right,top:U.top};return null},C=R=>I(R)!=null,B=R=>R.replace(/\s+/g," ").trim(),L=R=>R.replace(/[\t\n\f\r]+/g," ").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"),V=R=>{let O=[],U=0,K=Y=>{if(!(U>=160)){if(Y.nodeType===Node.TEXT_NODE){let M=B(Y.nodeValue||"");M.length>0&&(O.push(M),U+=M.length+1);return}if(!(Y.nodeType===Node.ELEMENT_NODE&&(_.has(b(Y))||e.reviewerOnly&&b(Y)==="textarea"||e.reviewerOnly&&(Y.getAttribute("aria-hidden")==="true"||Y.hasAttribute("hidden"))))){if(Y instanceof HTMLTextAreaElement){if(t(Y,r))return;let M=B(Y.value);M.length>0&&(O.push(M),U+=M.length+1);return}for(let M of Y.childNodes||[]){if(U>=160)break;K(M)}if(Y.nodeType===Node.ELEMENT_NODE){let M=Y;if(!M.shadowRoot)return;for(let pe of M.shadowRoot.childNodes){if(U>=160)break;K(pe)}}}}};return K(R),B(O.join(" ")).slice(0,160)},z=R=>{let O=d.elementToRef.get(R);return O==null&&(O=String(d.nextId++),d.elementToRef.set(R,O)),O},se=(R,O)=>{let U=b(R),K=[`node_id=${O}`];for(let M of e.renderedAttributeNames){if(M==="value"&&(t(R,r)||e.reviewerOnly&&(U==="input"||U==="textarea"||U==="select"))){!e.reviewerOnly&&(R instanceof HTMLInputElement||R instanceof HTMLTextAreaElement||R instanceof HTMLSelectElement)&&R.value&&K.push('value="<redacted>"');continue}let pe=M==="value"&&(R instanceof HTMLInputElement&&R.type!=="checkbox"&&R.type!=="radio"||R instanceof HTMLSelectElement)?R.value:R.getAttribute(M);pe!=null&&pe!==""&&K.push(`${M}="${L(pe)}"`)}for(let M of e.booleanAttributeNames)(M==="checked"&&R instanceof HTMLInputElement?R.checked:M==="selected"&&R instanceof HTMLOptionElement?R.selected:R.hasAttribute(M))&&K.push(`${M}="true"`);R instanceof HTMLInputElement&&R.indeterminate&&K.push('indeterminate="true"');let Y=V(R);return Y.length===0?`<${U} ${K.join(" ")} />`:`<${U} ${K.join(" ")}>${L(Y)}</${U}>`},$=()=>l||s.length>=e.maxElements||a>=e.maxChars,le=R=>{if($())return;let O=z(R),U=se(R,O),K=U.length+(s.length===0?0:1);if(a+K>e.maxChars){l=!0;return}s.push({line:U,ref:O}),d.refToElement.set(O,R),a+=K},Q=R=>{if(i.length>=e.maxElements)return;let O=I(R);if(O==null)return;let U=z(R);if(i.some(ve=>ve.ref===U))return;let K=R.src,Y=R,M=Y.clientWidth>0?Y.clientWidth:O.right-O.left,pe=Y.clientHeight>0?Y.clientHeight:O.bottom-O.top;i.push({rect:O,ref:U,size:{height:pe,width:M},...K.length>0?{url:K}:{}}),d.refToElement.set(U,R)};if(e.reviewerOnly)for(let R of document.querySelectorAll("iframe, frame"))R.closest(`#${e.codexOverlayRootId}`)==null&&Q(R);let Z=R=>{if($())return;if(R.nodeType===Node.DOCUMENT_NODE){let U=R.documentElement;U&&Z(U);return}if(R.nodeType===Node.DOCUMENT_FRAGMENT_NODE){for(let U of R.children){if($())break;Z(U)}return}if(R.nodeType!==Node.ELEMENT_NODE)return;let O=R;if(!x(O)){T(O)&&Q(O),E(O)&&C(O)&&le(O),O.shadowRoot&&!$()&&Z(O.shadowRoot);for(let U of O.children){if($())break;Z(U)}}};return Z(document),{frameElements:i,items:s,viewport:f}}"##;

/// `Xne`: resolve a local ref inside the frame's world to a frame-local
/// point: detached → null (caller raises stale), else `scrollIntoView`
/// nearest and the first `getClientRects()` rect (or the bounding rect)
/// clipped against the snapshot viewport clip, midpoint.
/// [adapted] Phase 26: the midpoint is snapped to the integer coordinate
/// whose pixel cell the CDP hit-test lands on (the raw clipped midpoint
/// is missed by ≤1px targets — same law as `pw::dispatch_point`).
const RESOLVE_POINT_FN: &str = r##"(e,t)=>{let n=globalThis.__browserUseVisibleDomState?.refToElement.get(e);if(!n?.isConnected)return null;n.scrollIntoView({block:"nearest",inline:"nearest"});let p=(v,w)=>{let m=Math.round((v+w)/2);if(m>=v&&m<w)return m;let f=Math.floor((v+w)/2);return f>=v&&f<w?f:m<w?m:f};let o=i=>{if(i.width<=0||i.height<=0)return null;let s=Math.max(i.left,t.left),a=Math.min(i.right,t.right),l=Math.max(i.top,t.top),u=Math.min(i.bottom,t.bottom);return a>s&&u>l?{x:p(s,a),y:p(l,u)}:null};for(let i of n.getClientRects()){let s=o(i);if(s!=null)return s}return o(n.getBoundingClientRect())}"##;

/// `yD` banner — the reference prepends it to every page-function
/// template (it neutralizes bundler `__name` helpers); kept verbatim.
const PAGE_FN_BANNER: &str = "const __name = (target) => target;";

fn snapshot_expression(
    viewport_clip: Option<Clip>,
    max_chars: usize,
    max_elements: usize,
    reviewer_only: bool,
) -> String {
    let options = json!({
        "booleanAttributeNames": ["checked","disabled","multiple","readonly","required","selected"],
        "codexOverlayRootId": OVERLAY_ROOT_ID,
        "interactiveRoleNames": ["button","checkbox","combobox","link","menuitem","option","radio","slider","spinbutton","switch","tab","textbox"],
        "interactiveTags": ["a","button","details","input","option","select","summary","textarea"],
        "maxChars": max_chars,
        "maxElements": max_elements,
        "renderedAttributeNames": ["aria-disabled","aria-label","contenteditable","href","name","placeholder","role","title","type","value"],
        "reviewerOnly": reviewer_only,
        "viewportClip": viewport_clip.map(Clip::to_json),
    });
    format!(
        "(() => {{\n{PAGE_FN_BANNER}\nreturn ({PAGE_WALKER_FN})({options},{PASSWORD_GUARD_FN},{guard_cfg});\n}})()",
        guard_cfg = password_guard_config(),
    )
}

fn resolve_expression(local_ref: &str, clip: Clip) -> String {
    format!(
        "(() => {{\n{PAGE_FN_BANNER}\nreturn ({RESOLVE_POINT_FN})({ref},{clip});\n}})()",
        ref = Value::String(local_ref.to_string()),
        clip = clip.to_json(),
    )
}

/// `lY`: iframe element → its frame object, for `DOM.describeNode`.
fn frame_object_expression(local_ref: &str) -> String {
    format!(
        "(() => {{\n{PAGE_FN_BANNER}\nconst state = globalThis.{PAGE_STATE_GLOBAL};\nreturn state?.refToElement?.get({ref}) ?? null;\n}})()",
        ref = Value::String(local_ref.to_string()),
    )
}

// ── Per-tab registries (`yo` + world cache `bo`, tab cleanup `sD`) ─────

#[derive(Clone, Debug)]
pub struct FrameRef {
    pub frame_id: String,
    pub loader_id: Option<String>,
    pub parent_frame_id: Option<String>,
    /// Candidate `clientWidth/height` (drives the `p5` scaling in `dD`).
    pub size: Option<(f64, f64)>,
}

#[derive(Clone, Debug)]
pub struct NodeRef {
    pub frame_id: String,
    pub loader_id: Option<String>,
    pub local_ref: String,
    /// The clip the snapshot's point midpoints were taken against; the
    /// resolver clips against the same rect (`ux`/`Xne`).
    pub viewport_clip: Option<Clip>,
}

#[derive(Debug)]
struct DomTabState {
    /// `mainFrameKey`: `${rootFrameId}:${loaderId??""}` — a changed key
    /// means a new main document, so the whole state (including the
    /// public-id cache) starts fresh (`aD`).
    main_frame_key: String,
    frames_by_id: HashMap<String, FrameRef>,
    node_by_public_id: HashMap<u64, NodeRef>,
    public_id_by_frame_local: HashMap<(String, String, String), u64>,
    next_public_id: u64,
}

/// The Phase-5 per-tab DOM state. Every tab-removal path (close command,
/// pump destroy, turn cleanup, host death, shutdown) must call
/// [`DomRegistries::forget_tab`] / `clear_all` — handles fail closed with
/// the pinned stale/`browser_context_unavailable` errors.
/// `bo`: the reference's JS Map preserves insertion order, and `oD`
/// evicts with `keys().next()` (the OLDEST insert) once past `KX`.
/// A Rust HashMap would evict arbitrarily, so the order is tracked
/// explicitly — re-setting an existing key keeps its position exactly
/// like `Map.set`.
#[derive(Default)]
struct WorldCache {
    map: HashMap<String, i64>,
    order: std::collections::VecDeque<String>,
}

#[derive(Default)]
pub struct DomRegistries {
    tabs: Mutex<HashMap<String, DomTabState>>,
    /// `bo`: isolated-world contexts keyed `{tab_id}:{frame_id}:{loader??""}`
    /// (`fD`/`F_`, single-target Ruke), FIFO-capped at `KX`.
    worlds: Mutex<WorldCache>,
}

fn world_key(tab_id: &str, frame_id: &str, loader_id: Option<&str>) -> String {
    format!("{tab_id}:{frame_id}:{}", loader_id.unwrap_or(""))
}

impl DomRegistries {
    /// `aD`: snapshot-start reset. The state object survives across
    /// same-document snapshots (public ids stay stable); a changed main
    /// frame key rebuilds it wholesale. `framesById`/`nodeByPublicId`
    /// always clear; the ref cache evicts past `XX` and restarts ids.
    pub fn reset_for_snapshot(&self, tab_id: &str, main_frame_key: &str) {
        let mut tabs = self.tabs.lock();
        let fresh = tabs
            .get(tab_id)
            .is_none_or(|s| s.main_frame_key != main_frame_key);
        let state = tabs
            .entry(tab_id.to_string())
            .or_insert_with(|| DomTabState {
                main_frame_key: main_frame_key.to_string(),
                frames_by_id: HashMap::new(),
                node_by_public_id: HashMap::new(),
                public_id_by_frame_local: HashMap::new(),
                next_public_id: 1,
            });
        if fresh {
            state.main_frame_key = main_frame_key.to_string();
            state.public_id_by_frame_local.clear();
            state.next_public_id = 1;
        }
        state.frames_by_id.clear();
        state.node_by_public_id.clear();
        if state.public_id_by_frame_local.len() > PUBLIC_ID_CACHE_MAX {
            state.public_id_by_frame_local.clear();
            state.next_public_id = 1;
        }
    }

    /// `lD`: every walked frame reference is registered so `pD` can
    /// climb the parent chain after the snapshot.
    pub fn remember_frame(&self, tab_id: &str, fr: &FrameRef) {
        if let Some(state) = self.tabs.lock().get_mut(tab_id) {
            state.frames_by_id.insert(fr.frame_id.clone(), fr.clone());
        }
    }

    /// `cO`/`uD`: stable public id for (frame, loader, local ref); the
    /// WeakMap-stable local ref keeps an element's public id across
    /// snapshots until the cache resets.
    pub fn assign_public_id(
        &self,
        tab_id: &str,
        frame_id: &str,
        loader_id: Option<&str>,
        local_ref: &str,
        viewport_clip: Clip,
    ) -> Result<u64, BrowserError> {
        let mut tabs = self.tabs.lock();
        let state = tabs.get_mut(tab_id).ok_or_else(|| BrowserError::Internal {
            detail: "DOM CUA snapshot state is missing".into(),
        })?;
        let key = (
            frame_id.to_string(),
            loader_id.unwrap_or("").to_string(),
            local_ref.to_string(),
        );
        let id = match state.public_id_by_frame_local.get(&key) {
            Some(id) => *id,
            None => {
                let id = state.next_public_id;
                state.next_public_id += 1;
                state.public_id_by_frame_local.insert(key, id);
                id
            }
        };
        state.node_by_public_id.insert(
            id,
            NodeRef {
                frame_id: frame_id.to_string(),
                loader_id: loader_id.map(str::to_string),
                local_ref: local_ref.to_string(),
                viewport_clip: Some(viewport_clip),
            },
        );
        Ok(id)
    }

    /// `uO`: public id → node ref. Absent means the element is gone
    /// (new document, evicted cache): the pinned stale error.
    pub fn lookup_node(&self, tab_id: &str, public_id: u64) -> Result<NodeRef, BrowserError> {
        self.tabs
            .lock()
            .get(tab_id)
            .and_then(|s| s.node_by_public_id.get(&public_id))
            .cloned()
            .ok_or(BrowserError::StaleDomNode { node_id: public_id })
    }

    pub fn lookup_frame(&self, tab_id: &str, frame_id: &str) -> Option<FrameRef> {
        self.tabs
            .lock()
            .get(tab_id)
            .and_then(|s| s.frames_by_id.get(frame_id))
            .cloned()
    }

    pub fn has_state(&self, tab_id: &str) -> bool {
        self.tabs.lock().contains_key(tab_id)
    }

    pub fn forget_tab(&self, tab_id: &str) {
        self.tabs.lock().remove(tab_id);
        let prefix = format!("{tab_id}:");
        let mut worlds = self.worlds.lock();
        worlds.map.retain(|k, _| !k.starts_with(&prefix));
        worlds.order.retain(|k| !k.starts_with(&prefix));
    }

    pub fn clear_all(&self) {
        self.tabs.lock().clear();
        let mut worlds = self.worlds.lock();
        worlds.map.clear();
        worlds.order.clear();
    }

    // World cache (`oD`/`bo`): FIFO eviction at KX; `ZX` context-gone
    // errors drop the entry (next call rebuilds once, like `wa`).
    pub fn cached_world(
        &self,
        tab_id: &str,
        frame_id: &str,
        loader_id: Option<&str>,
    ) -> Option<i64> {
        self.worlds
            .lock()
            .map
            .get(&world_key(tab_id, frame_id, loader_id))
            .copied()
    }

    pub fn put_world(
        &self,
        tab_id: &str,
        frame_id: &str,
        loader_id: Option<&str>,
        context_id: i64,
    ) {
        let mut worlds = self.worlds.lock();
        let key = world_key(tab_id, frame_id, loader_id);
        if worlds.map.insert(key.clone(), context_id).is_none() {
            worlds.order.push_back(key);
        }
        while worlds.order.len() > WORLD_CACHE_MAX {
            if let Some(oldest) = worlds.order.pop_front() {
                worlds.map.remove(&oldest);
            }
        }
    }

    pub fn drop_world(&self, tab_id: &str, frame_id: &str, loader_id: Option<&str>) {
        let key = world_key(tab_id, frame_id, loader_id);
        let mut worlds = self.worlds.lock();
        worlds.map.remove(&key);
        worlds.order.retain(|k| k != &key);
    }
}

/// `ZX`: CDP "world is gone" signatures that justify ONE cache rebuild.
pub fn context_gone(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("cannot find context")
        || m.contains("execution context was destroyed")
        || (m.contains("context") && (m.contains("destroyed") || m.contains("not found")))
}

// ── Snapshot machinery (`vD`/`q_`/`xD`) ────────────────────────────────

#[derive(Default)]
struct WalkOut {
    lines: Vec<String>,
    chars: usize,
}

/// `j_`: the global snapshot budget is still open.
fn budget_open(out: &WalkOut) -> bool {
    out.lines.len() < MAX_SNAPSHOT_ELEMENTS && out.chars < MAX_SNAPSHOT_CHARS
}

/// `q_`/`xD` receive a single parameter object in the reference; the
/// shared socket/tab/output plus the child deadline ride along the
/// same way here.
struct WalkCtx<'a> {
    conn: &'a CdpConn,
    rec: &'a TabRecord,
    out: &'a mut WalkOut,
    child_frame_deadline: Instant,
}

/// One shape-validated walker item (`mY`): rendered line + local ref.
struct WalkItem {
    line: String,
    local_ref: String,
}

/// Shape-validated walker payload (`cY`).
struct WalkPayload {
    items: Vec<WalkItem>,
    frame_elements: Vec<Value>,
    viewport: Clip,
}

/// `q_`'s return: the frame's iframe candidates, its remembered
/// reference, and the effective clip (`None` = the clip went
/// degenerate, so the frame contributed no usable viewport).
struct WalkedFrame {
    candidates: Vec<Value>,
    frame: FrameRef,
    clip: Option<Clip>,
}

/// The service-side line emit (verbatim node-id pass): public id
/// replaces the local `node_id=` token (JS `String.replace` with a
/// string needle = FIRST occurrence only, hence `replacen`); a line
/// whose cost (`len + newline-withholding`) crosses the cap returns
/// false — the reference `break`s the item loop there, it never
/// skips-and-continues and never truncates mid-line.
fn emit_line(
    registries: &DomRegistries,
    out: &mut WalkOut,
    tab_id: &str,
    fr: &FrameRef,
    item: &WalkItem,
    clip: Clip,
    cap: usize,
) -> Result<bool, BrowserError> {
    let public = registries.assign_public_id(
        tab_id,
        &fr.frame_id,
        fr.loader_id.as_deref(),
        &item.local_ref,
        clip,
    )?;
    let rendered = item.line.replacen(
        &format!("node_id={}", item.local_ref),
        &format!("node_id={public}"),
        1,
    );
    let cost = rendered.len() + usize::from(!out.lines.is_empty());
    if out.chars + cost > cap {
        return Ok(false);
    }
    out.chars += cost;
    out.lines.push(rendered);
    Ok(true)
}

/// `TD`: pull a readable message out of Runtime.evaluate's
/// `exceptionDetails` (verbatim fallback shape).
fn eval_exception_message(err: &Value) -> String {
    err.pointer("/exception/exception/value")
        .and_then(Value::as_str)
        .or_else(|| {
            err.pointer("/exceptionDetails/exception/value")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            err.pointer("/exceptionDetails/exception/description")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            err.pointer("/exceptionDetails/text")
                .and_then(Value::as_str)
        })
        .unwrap_or("Visible DOM evaluation failed")
        .to_string()
}

/// `mY`/`fY`/`dY`/`pY`/`cY`: the walker payload is UNTRUSTED page-side
/// data — shape-validate every field before using it (never trust what
/// a page's DOM script could have poisoned).
fn as_clip(v: Option<&Value>) -> Option<Clip> {
    let o = v?;
    let g = |k: &str| o.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
    Some(Clip {
        bottom: g("bottom")?,
        left: g("left")?,
        right: g("right")?,
        top: g("top")?,
    })
}

fn parse_walk_payload(value: Value) -> Option<WalkPayload> {
    let items = value.get("items")?.as_array()?.clone();
    let viewport = as_clip(value.get("viewport"))?;
    let mut parsed = Vec::new();
    for it in items {
        let r = it.get("ref").and_then(Value::as_str)?;
        let l = it.get("line").and_then(Value::as_str)?;
        parsed.push(WalkItem {
            line: l.to_string(),
            local_ref: r.to_string(),
        });
    }
    let frames = value
        .get("frameElements")
        .cloned()
        .unwrap_or_else(|| json!([]))
        .as_array()
        .cloned()
        .unwrap_or_default();
    // drop malformed candidates the way dY does (shape check per field)
    let frames = frames
        .into_iter()
        .filter(|f| {
            f.get("ref").and_then(Value::as_str).is_some()
                && as_clip(f.get("rect")).is_some()
                && f.get("size").is_none_or(|s| {
                    s.get("width")
                        .and_then(Value::as_f64)
                        .is_some_and(|w| w > 0.0)
                        && s.get("height")
                            .and_then(Value::as_f64)
                            .is_some_and(|h| h > 0.0)
                })
                && f.get("url").is_none_or(|u| u.is_string())
        })
        .collect();
    Some(WalkPayload {
        items: parsed,
        frame_elements: frames,
        viewport,
    })
}

/// `hD`/target join: Ruke has exactly one CDP target per tab, so the
/// reference's target-equality walk is trivially true — kept as the
/// documented single-target simplification (no fabricated multi-target
/// state).
impl BrowserRuntime {
    /// Evaluate a page function inside the frame's named isolated
    /// world (`wa`: create-once per (tab,frame,loader), FIFO cache,
    /// ONE rebuild on a context-gone error). `pub(crate)`: the Phase-7
    /// locator scope engine (`pw.rs`) runs its per-frame CSS queries
    /// through the exact same world cache.
    pub(crate) async fn world_eval(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        frame_id: &str,
        loader_id: Option<&str>,
        expression: &str,
        return_by_value: bool,
    ) -> Result<Value, BrowserError> {
        let context_id = match self.dom.cached_world(&rec.tab_id, frame_id, loader_id) {
            Some(c) => c,
            None => self.ensure_world(conn, rec, frame_id, loader_id).await?,
        };
        let attempt = Self::world_eval_with(
            conn,
            &rec.cdp_session_id,
            context_id,
            expression,
            return_by_value,
        )
        .await;
        let err = match attempt {
            Ok(v) => return Ok(v),
            Err(e) => e,
        };
        if !context_gone(&err.to_string()) {
            return Err(err);
        }
        self.dom.drop_world(&rec.tab_id, frame_id, loader_id);
        let context_id = self.ensure_world(conn, rec, frame_id, loader_id).await?;
        Self::world_eval_with(
            conn,
            &rec.cdp_session_id,
            context_id,
            expression,
            return_by_value,
        )
        .await
    }

    async fn world_eval_with(
        conn: &CdpConn,
        cdp_session_id: &str,
        context_id: i64,
        expression: &str,
        return_by_value: bool,
    ) -> Result<Value, BrowserError> {
        conn.call(
            "Runtime.evaluate",
            Some(json!({
                "expression": expression,
                "awaitPromise": true,
                "contextId": context_id,
                "returnByValue": return_by_value,
            })),
            Some(cdp_session_id),
        )
        .await
    }

    async fn ensure_world(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        frame_id: &str,
        loader_id: Option<&str>,
    ) -> Result<i64, BrowserError> {
        // `grantUniveralAccess` keeps Chromium's own protocol spelling
        // (the real parameter name), value false: no cross-frame access.
        let res = conn
            .call(
                "Page.createIsolatedWorld",
                Some(json!({
                    "frameId": frame_id,
                    "grantUniveralAccess": false,
                    "worldName": DOM_WORLD_NAME,
                })),
                Some(&rec.cdp_session_id),
            )
            .await?;
        let context_id = res
            .get("executionContextId")
            .and_then(Value::as_i64)
            .ok_or_else(|| BrowserError::Internal {
                detail: "Page.createIsolatedWorld returned no executionContextId".into(),
            })?;
        self.dom
            .put_world(&rec.tab_id, frame_id, loader_id, context_id);
        Ok(context_id)
    }

    /// `q_`: walk one frame; appends public-id lines into `out`.
    /// `[adapted]` the reference's per-call deadline plumbing
    /// (`W_`/`H_`/`bD`) rides on a bridge with per-call timeouts; Ruke's
    /// socket has one global call timeout, so deadlines gate the LOOP.
    async fn walk_frame(
        &self,
        ctx: &mut WalkCtx<'_>,
        fr: &FrameRef,
        max_chars: Option<usize>,
        max_elements: Option<usize>,
        viewport_clip: Option<Clip>,
    ) -> Result<Option<WalkedFrame>, BrowserError> {
        if ctx.out.lines.len() >= MAX_SNAPSHOT_ELEMENTS
            || ctx.out.chars >= MAX_SNAPSHOT_CHARS
            || (fr.parent_frame_id.is_some() && Instant::now() >= ctx.child_frame_deadline)
        {
            return Ok(None);
        }
        self.dom.remember_frame(&ctx.rec.tab_id, fr);
        let r = (MAX_SNAPSHOT_ELEMENTS - ctx.out.lines.len())
            .min(max_elements.unwrap_or(MAX_SNAPSHOT_ELEMENTS));
        let n = (MAX_SNAPSHOT_CHARS - ctx.out.chars).min(max_chars.unwrap_or(MAX_SNAPSHOT_CHARS));
        let expr = snapshot_expression(viewport_clip, n, r, false);
        let res = match self
            .world_eval(
                ctx.conn,
                ctx.rec,
                &fr.frame_id,
                fr.loader_id.as_deref(),
                &expr,
                true,
            )
            .await
        {
            Ok(res) => res,
            Err(e) => {
                // child-frame walks are best-effort (`q_`'s catch),
                // mirroring how an unstable/crashing frame must not
                // sink the whole snapshot; the root walk re-throws.
                if fr.parent_frame_id.is_some() {
                    return Ok(None);
                }
                return Err(e);
            }
        };
        if let Some(details) = res.get("exceptionDetails") {
            let reason = eval_exception_message(details);
            if fr.parent_frame_id.is_some() {
                return Ok(None);
            }
            return Err(BrowserError::CdpFailed {
                method: "Runtime.evaluate".into(),
                reason,
            });
        }
        let Some(payload) =
            parse_walk_payload(res.pointer("/result/value").cloned().unwrap_or(Value::Null))
        else {
            if fr.parent_frame_id.is_some() {
                return Ok(None);
            }
            return Err(BrowserError::Internal {
                detail: "DOM CUA walker returned an invalid payload".into(),
            });
        };
        let clip = match viewport_clip {
            None => payload.viewport,
            Some(vc) => match clip_intersect(vc, payload.viewport) {
                Some(c) => c,
                None => {
                    return Ok(Some(WalkedFrame {
                        candidates: Vec::new(),
                        frame: fr.clone(),
                        clip: None,
                    }))
                }
            },
        };
        let line_cap = ctx.out.chars + n;
        let element_cap = ctx.out.lines.len() + r;
        for item in &payload.items {
            if ctx.out.lines.len() >= element_cap || ctx.out.chars >= line_cap {
                break;
            }
            if !emit_line(
                &self.dom,
                ctx.out,
                &ctx.rec.tab_id,
                fr,
                item,
                clip,
                line_cap,
            )? {
                break;
            }
        }
        Ok(Some(WalkedFrame {
            candidates: payload.frame_elements,
            frame: fr.clone(),
            clip: Some(clip),
        }))
    }

    /// `SD`: iframe candidate ref → the child frame's id (describeNode
    /// on the world-side object; the objectId is always released).
    async fn frame_id_for_candidate(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        parent: &FrameRef,
        candidate_ref: &str,
    ) -> Option<String> {
        let expr = frame_object_expression(candidate_ref);
        let res = self
            .world_eval(
                conn,
                rec,
                &parent.frame_id,
                parent.loader_id.as_deref(),
                &expr,
                false,
            )
            .await
            .ok()?;
        if res.get("exceptionDetails").is_some() {
            return None;
        }
        let object_id = res.pointer("/result/objectId")?.as_str()?.to_string();
        let described = conn
            .call(
                "DOM.describeNode",
                Some(json!({"objectId": &object_id})),
                Some(&rec.cdp_session_id),
            )
            .await
            .ok()?;
        let frame_id = described
            .pointer("/node/frameId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let _ = conn
            .call(
                "Runtime.releaseObject",
                Some(json!({"objectId": object_id})),
                Some(&rec.cdp_session_id),
            )
            .await;
        frame_id
    }

    /// `xD`: descend into iframe candidates while budget and the
    /// child-frame deadline allow (viewportClip of a child = the
    /// parent-space iframe rect made frame-relative, `U_`).
    async fn walk_child_frames(
        &self,
        ctx: &mut WalkCtx<'_>,
        frame: &FrameRef,
        candidates: &[Value],
        clip: Clip,
    ) -> Result<(), BrowserError> {
        if !budget_open(ctx.out) {
            return Ok(());
        }
        for cand in candidates {
            if !budget_open(ctx.out) || Instant::now() >= ctx.child_frame_deadline {
                break;
            }
            let rect = match as_clip(cand.get("rect")) {
                Some(r) => r,
                None => continue,
            };
            let child_clip = match clip_relative_to(rect, clip) {
                Some(c) => c,
                None => continue,
            };
            let Some(ref_str) = cand.get("ref").and_then(Value::as_str) else {
                continue;
            };
            let Some(child_frame_id) = self
                .frame_id_for_candidate(ctx.conn, ctx.rec, frame, ref_str)
                .await
            else {
                continue;
            };
            let size = cand.get("size").and_then(|s| {
                let w = s.get("width")?.as_f64()?;
                let h = s.get("height")?.as_f64()?;
                Some((w, h))
            });
            let child = FrameRef {
                frame_id: child_frame_id,
                loader_id: None, // faithful: xD's child references carry no loaderId
                parent_frame_id: Some(frame.frame_id.clone()),
                size,
            };
            let walked = self
                .walk_frame(ctx, &child, None, None, Some(child_clip))
                .await?;
            if let Some(walked) = walked {
                if let Some(cc) = walked.clip {
                    // Async recursion needs pinned indirection (E0733);
                    // the `gD` deadline above already bounds real
                    // nesting time.
                    Box::pin(self.walk_child_frames(ctx, &walked.frame, &walked.candidates, cc))
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// `dom_cua_get_visible_dom` (`wD`/`vD`): filtered interactable DOM
    /// with stable public node ids. Authority note: the reference's
    /// `observeContent` gate lands in Phase 9; the current floor is the
    /// live-tab requirement (stale handles fail closed) and
    /// user-tab mutation refusal in the executor.
    pub(crate) async fn dom_visible_dom(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
    ) -> Result<Value, BrowserError> {
        let tree = conn
            .call("Page.getFrameTree", None, Some(&rec.cdp_session_id))
            .await?;
        // CDP's answer wraps the tree: `{frameTree:{frame,childFrames}}`.
        let root = tree
            .pointer("/frameTree/frame")
            .cloned()
            .unwrap_or(Value::Null);
        let root_id =
            root.get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| BrowserError::Internal {
                    detail: "Page.getFrameTree returned no root frame id".into(),
                })?;
        let root_loader = root
            .get("loaderId")
            .and_then(Value::as_str)
            .map(str::to_string);
        // `uY`: the main-document key drives the public-id stability.
        let main_key = format!("{root_id}:{}", root_loader.as_deref().unwrap_or(""));
        self.dom.reset_for_snapshot(&rec.tab_id, &main_key);

        let root_ref = FrameRef {
            frame_id: root_id.to_string(),
            loader_id: root_loader,
            parent_frame_id: None,
            size: None,
        };
        let mut out = WalkOut::default();
        // `vD`: the root walk gets a fresh `gD` child deadline.
        let deadline = Instant::now() + std::time::Duration::from_millis(CHILD_FRAME_DEADLINE_MS);
        let mut ctx = WalkCtx {
            conn,
            rec,
            out: &mut out,
            child_frame_deadline: deadline,
        };
        let walked = self
            .walk_frame(&mut ctx, &root_ref, None, None, None)
            .await?;
        // `vD`: descent only when the root viewport clip survived and
        // the global budget is still open (in that order).
        if let Some(walked) = walked {
            if let Some(clip) = walked.clip {
                if budget_open(ctx.out) {
                    self.walk_child_frames(&mut ctx, &walked.frame, &walked.candidates, clip)
                        .await?;
                }
            }
        }
        Ok(json!({
            "tab_id": rec.tab_id,
            "element_count": out.lines.len(),
            "dom": out.lines.join("\n"),
        }))
    }

    /// `dD` (unsized/`getContentQuads` variant): lift one frame-local
    /// point through the iframe anchor that hosts `frame`.
    async fn frame_geometry_hop(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        frame: &FrameRef,
        point: (f64, f64),
    ) -> Result<(f64, f64), BrowserError> {
        let owner = conn
            .call(
                "DOM.getFrameOwner",
                Some(json!({"frameId": &frame.frame_id})),
                Some(&rec.cdp_session_id),
            )
            .await?;
        let backend_node_id = owner
            .get("backendNodeId")
            .and_then(Value::as_i64)
            .ok_or_else(|| BrowserError::Internal {
                detail: format!(
                    "Missing frame geometry for DOM CUA frame {}",
                    frame.frame_id
                ),
            })?;
        let quads = conn
            .call(
                "DOM.getContentQuads",
                Some(json!({"backendNodeId": backend_node_id})),
                Some(&rec.cdp_session_id),
            )
            .await?;
        let quad: Vec<f64> = quads
            .pointer("/quads/0")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_f64())
            .collect();
        transform_point(point, frame.size, &quad).ok_or_else(|| BrowserError::Internal {
            detail: format!(
                "Missing frame geometry for DOM CUA frame {}",
                frame.frame_id
            ),
        })
    }

    /// `ux` + `pD`: public node id → a page-space CDP `Input.*` point.
    /// Stale/absent refs answer the pinned `DOM node N is stale or
    /// missing` error (both the registry miss and a detached element).
    async fn resolve_dom_point(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        node_id: u64,
    ) -> Result<(f64, f64), BrowserError> {
        let node = self.dom.lookup_node(&rec.tab_id, node_id)?;
        let clip = node
            .viewport_clip
            .ok_or(BrowserError::StaleDomNode { node_id })?;
        let expr = resolve_expression(&node.local_ref, clip);
        let res = self
            .world_eval(
                conn,
                rec,
                &node.frame_id,
                node.loader_id.as_deref(),
                &expr,
                true,
            )
            .await?;
        if let Some(details) = res.get("exceptionDetails") {
            return Err(BrowserError::CdpFailed {
                method: "Runtime.evaluate".into(),
                reason: eval_exception_message(details),
            });
        }
        let point = res
            .pointer("/result/value")
            .and_then(|v| {
                let x = v.get("x")?.as_f64()?;
                let y = v.get("y")?.as_f64()?;
                (x.is_finite() && y.is_finite()).then_some((x, y))
            })
            .ok_or(BrowserError::StaleDomNode { node_id })?;
        // `pD` chain, one hop per parentFrameId ([adapted] per-hop
        // instead of the recovered same-target skip — see §3 prose).
        let mut point = point;
        let mut current = self
            .dom
            .lookup_frame(&rec.tab_id, &node.frame_id)
            .ok_or_else(|| BrowserError::Internal {
                detail: format!("Missing DOM CUA frame {}", node.frame_id),
            })?;
        while let Some(parent_id) = current.parent_frame_id.clone() {
            let parent = self
                .dom
                .lookup_frame(&rec.tab_id, &parent_id)
                .ok_or_else(|| BrowserError::Internal {
                    detail: format!("Missing parent DOM CUA frame {}", current.frame_id),
                })?;
            point = self.frame_geometry_hop(conn, rec, &current, point).await?;
            current = parent;
        }
        Ok(point)
    }

    /// `dom_cua_click` / `dom_cua_double_click` (`clickDomCuaNode`):
    /// resolve → real `Input.dispatchMouseEvent` press+release with
    /// `clickCount` 1/2 on the tab's own session (the hit-test settle
    /// loop belongs to the AX action engine, Phase 6).
    pub(crate) async fn dom_click(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        node_id: u64,
        click_count: i64,
    ) -> Result<Value, BrowserError> {
        let (x, y) = self.resolve_dom_point(conn, rec, node_id).await?;
        for event_type in ["mousePressed", "mouseReleased"] {
            conn.call(
                "Input.dispatchMouseEvent",
                Some(json!({
                    "type": event_type,
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": click_count,
                    "modifiers": 0,
                })),
                Some(&rec.cdp_session_id),
            )
            .await?;
        }
        Ok(json!({"tab_id": rec.tab_id, "node_id": node_id, "x": x, "y": y}))
    }

    /// `dom_cua_scroll` (`scrollDomCuaNode` + the node-less `mte`):
    /// a node scrolls at its resolved point; without a node the wheel
    /// lands at the visual viewport center (`Page.getLayoutMetrics`).
    pub(crate) async fn dom_scroll(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        node_id: Option<u64>,
        scroll_x: i64,
        scroll_y: i64,
    ) -> Result<Value, BrowserError> {
        let point = match node_id {
            Some(id) => self.resolve_dom_point(conn, rec, id).await?,
            None => {
                let metrics = conn
                    .call("Page.getLayoutMetrics", None, Some(&rec.cdp_session_id))
                    .await?;
                let vp = metrics
                    .get("cssVisualViewport")
                    .cloned()
                    .unwrap_or_else(|| {
                        metrics
                            .get("visualViewport")
                            .cloned()
                            .unwrap_or(Value::Null)
                    });
                let w = vp
                    .get("clientWidth")
                    .and_then(Value::as_f64)
                    .unwrap_or(1000.0);
                let h = vp
                    .get("clientHeight")
                    .and_then(Value::as_f64)
                    .unwrap_or(1000.0);
                (w / 2.0, h / 2.0)
            }
        };
        // Wheels only service the composited (foreground) tab — raise
        // it before the dispatch (engine::raise_wheel_target).
        crate::engine::raise_wheel_target(conn, &rec.cdp_session_id).await;
        conn.call(
            "Input.dispatchMouseEvent",
            Some(json!({
                "type": "mouseWheel",
                "x": point.0,
                "y": point.1,
                "deltaX": scroll_x,
                "deltaY": scroll_y,
                "modifiers": 0,
            })),
            Some(&rec.cdp_session_id),
        )
        .await?;
        Ok(
            json!({"tab_id": rec.tab_id, "x": point.0, "y": point.1, "deltaX": scroll_x, "deltaY": scroll_y}),
        )
    }

    /// `dom_cua_type` `[adapted]`: `Input.insertText` on the tab
    /// session — text lands in the FOCUSED element, matching the
    /// pinned Phase-1 payload contract (`TextPayload` carries no node:
    /// the model clicks a snapshot node to focus first, then types).
    /// The reference's clipboard-paste flow needs a virtual clipboard
    /// service Ruke has no reason to grow; `insertText` is the same
    /// input primitive its own keypress fallback uses.
    pub(crate) async fn dom_type(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        text: &str,
    ) -> Result<Value, BrowserError> {
        conn.call(
            "Input.insertText",
            Some(json!({"text": text})),
            Some(&rec.cdp_session_id),
        )
        .await?;
        Ok(json!({"tab_id": rec.tab_id, "typed_chars": text.chars().count()}))
    }

    /// `dom_cua_keypress` `[adapted]`: xdotool key-token combos
    /// (`KeysPayload.keys`, each combo a `+`-chain — e.g.
    /// `["ctrl+shift+t", "Return"]`; xdotool names normalize to
    /// Playwright key grammar). Ruke drives CDP directly, so there is
    /// no xdotool layer to shell out to: modifier tokens accumulate
    /// the `Input.dispatchKeyEvent` mask (the same primitive
    /// `playwright_locator_press` combos use — modifier *state*, not
    /// held physical keys, is what the wire contract needs), and the
    /// final token rides `pw_send_key` on the tab session.
    pub(crate) async fn dom_cua_keypress(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        keys: &[String],
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        for combo in keys {
            let (mods, final_tok) = split_combo(combo);
            let mut names: Vec<&str> = Vec::with_capacity(mods.len());
            for m in mods {
                names.push(normalize_modifier(m).ok_or_else(|| {
                    crate::errors::payload_invalid(
                        "dom_cua_keypress",
                        format!("\"{m}\" is not a modifier in combo position (combo \"{combo}\")"),
                    )
                })?);
            }
            let mask = combo_mask(&names)?;
            let key = normalize_key_token(final_tok);
            let spec = pw_key_spec(&key).ok_or_else(|| {
                crate::errors::payload_invalid(
                    "dom_cua_keypress",
                    format!("unknown key \"{combo}\" (xdotool token grammar)"),
                )
            })?;
            pw_send_key(conn, session, &spec, mask, 0).await?;
        }
        Ok(json!({"tab_id": rec.tab_id, "keys_sent": keys.len()}))
    }

    /// `dom_cua_download_media`: trigger the element's media download
    /// with a real click, then hand back only after the file is on
    /// disk. The engine set `Page.setDownloadBehavior
    /// {allowAndName}` on every tab session at attach, so the pump
    /// records `downloadWillBegin`/`downloadProgress` and the bytes
    /// land at `<download-dir>/<guid>`; waiting for completion is what
    /// makes any path handed back later name a real file.
    pub(crate) async fn dom_cua_download_media(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        node_id: u64,
        timeout_ms: Option<u64>,
    ) -> Result<Value, BrowserError> {
        let timeout = timeout_ms.unwrap_or(30_000);
        // Generation BEFORE the click: only downloads that begin after
        // the trigger count (pump-recorded, race-free).
        let gen = self.io.download_generation(&rec.tab_id);
        // A single left click is the media-download trigger primitive
        // — exactly `dom_cua_click`'s dispatch path.
        self.dom_click(conn, rec, node_id, 1).await?;
        let began = self.io.wait_for_download(&rec.tab_id, gen, timeout).await?;
        self.io
            .wait_for_download_complete(&began.guid, timeout)
            .await?;
        Ok(json!({}))
    }
}

/// Split one `dom_cua_keypress` combo into held-modifier tokens and
/// the final actioned token (xdotool `+`-chain grammar; a lone `"+"`
/// is the plus key itself).
fn split_combo(combo: &str) -> (Vec<&str>, &str) {
    if combo == "+" {
        return (Vec::new(), "+");
    }
    let toks: Vec<&str> = combo.split('+').collect();
    match toks.split_last() {
        Some((last, init)) => (init.to_vec(), last),
        None => (Vec::new(), ""),
    }
}

/// xdotool modifier token → the modifier name `combo_mask` accepts.
fn normalize_modifier(tok: &str) -> Option<&'static str> {
    match tok.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Some("Control"),
        "alt" | "option" => Some("Alt"),
        "shift" => Some("Shift"),
        "super" | "meta" | "cmd" | "command" | "win" => Some("Meta"),
        _ => None,
    }
}

/// xdotool key aliases → Playwright key names (`pw_key_spec`'s
/// grammar). Keypad digits normalize to plain digits; unknown tokens
/// pass through so `pw_key_spec` decides (and errors honestly).
fn normalize_key_token(tok: &str) -> String {
    match tok {
        "Enter" | "Return" | "Linefeed" | "KP_Enter" => "Enter".into(),
        "BackSpace" => "Backspace".into(),
        "Up" => "ArrowUp".into(),
        "Down" => "ArrowDown".into(),
        "Left" => "ArrowLeft".into(),
        "Right" => "ArrowRight".into(),
        "Prior" | "Page_Up" => "PageUp".into(),
        "Next" | "Page_Down" => "PageDown".into(),
        "Esc" => "Escape".into(),
        "space" => "Space".into(),
        "plus" => "+".into(),
        t if t.starts_with("KP_") && t.len() == 4 && t.as_bytes()[3].is_ascii_digit() => {
            t[3..].to_string()
        }
        t => t.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keypress_combo_grammar_pins_split_and_normalization() {
        assert_eq!(split_combo("ctrl+shift+t"), (vec!["ctrl", "shift"], "t"));
        assert_eq!(split_combo("Return"), (vec![], "Return"));
        // A lone plus is the key, not an empty combo chain.
        assert_eq!(split_combo("+"), (vec![], "+"));
        // `ctrl+plus` is the plus-with-ctrl spelling.
        assert_eq!(split_combo("ctrl+plus"), (vec!["ctrl"], "plus"));

        assert_eq!(normalize_modifier("ctrl"), Some("Control"));
        assert_eq!(normalize_modifier("CTRL"), Some("Control"));
        assert_eq!(normalize_modifier("super"), Some("Meta"));
        assert_eq!(normalize_modifier("t"), None);

        assert_eq!(normalize_key_token("Return"), "Enter");
        assert_eq!(normalize_key_token("KP_Enter"), "Enter");
        assert_eq!(normalize_key_token("BackSpace"), "Backspace");
        assert_eq!(normalize_key_token("Prior"), "PageUp");
        assert_eq!(normalize_key_token("Page_Down"), "PageDown");
        assert_eq!(normalize_key_token("Next"), "PageDown");
        assert_eq!(normalize_key_token("Esc"), "Escape");
        assert_eq!(normalize_key_token("space"), "Space");
        assert_eq!(normalize_key_token("plus"), "+");
        assert_eq!(normalize_key_token("KP_7"), "7");
        assert_eq!(normalize_key_token("t"), "t");
        // Normalized tokens all resolve through the Phase-7 grammar.
        for tok in ["Return", "Up", "Prior", "Esc", "space", "plus", "KP_5", "a"] {
            let norm = normalize_key_token(tok);
            assert!(pw_key_spec(&norm).is_some(), "token {tok} → {norm}");
        }
    }

    #[test]
    fn budget_constants_match_the_reference_verbatim() {
        assert_eq!(MAX_SNAPSHOT_CHARS, 20_000); // oc = 2e4
        assert_eq!(MAX_SNAPSHOT_ELEMENTS, 200); // ic
        assert_eq!(CREDENTIAL_CHAR_DISCOUNT, 5_000); // nY = 5e3
        assert_eq!(CREDENTIAL_ELEMENT_DISCOUNT, 50); // oY
        assert_eq!(CHILD_CALL_BUDGET_MS, 500); // bD
        assert_eq!(CHILD_FRAME_DEADLINE_MS, 1_000); // gD = 1e3
        assert_eq!(WORLD_CACHE_MAX, 50); // KX
        assert_eq!(PUBLIC_ID_CACHE_MAX, 5_000); // XX = 5e3
        assert_eq!(DOM_WORLD_NAME, "ruke-dom-cua");
        assert_eq!(credential_budget(), (15_000, 150)); // oc-nY, ic-oY
    }

    #[test]
    fn snapshot_expression_carries_the_verbatim_constants() {
        let expr = snapshot_expression(
            Some(Clip {
                bottom: 9.0,
                left: 0.0,
                right: 5.0,
                top: 1.0,
            }),
            1234,
            42,
            false,
        );
        // Option object mirrors the captured one (iY): every pinned
        // constant list is embedded, and the page banner is prepended.
        for token in [
            "const __name = (target) => target;",
            "\"interactiveTags\":[\"a\",\"button\",\"details\",\"input\",\"option\",\"select\",\"summary\",\"textarea\"]",
            "\"renderedAttributeNames\":[\"aria-disabled\",\"aria-label\",\"contenteditable\",\"href\",\"name\",\"placeholder\",\"role\",\"title\",\"type\",\"value\"]",
            "\"booleanAttributeNames\":[\"checked\",\"disabled\",\"multiple\",\"readonly\",\"required\",\"selected\"]",
            "\"interactiveRoleNames\":[\"button\",\"checkbox\",\"combobox\",\"link\",\"menuitem\",\"option\",\"radio\",\"slider\",\"spinbutton\",\"switch\",\"tab\",\"textbox\"]",
            "\"codexOverlayRootId\":\"ruke-agent-overlay-root\"",
            "\"maxChars\":1234",
            "\"maxElements\":42",
            "\"reviewerOnly\":false",
            "{\"bottom\":9.0,\"left\":0.0,\"right\":5.0,\"top\":1.0}",
            "__browserUseVisibleDomState",
            "elementToRef:new WeakMap",
            "value=\"<redacted>\"",
            "slice(0,160)",
            "getClientRects()",
            "ruke-agent-overlay-root",
        ] {
            assert!(expr.contains(token), "walker expression missing {token:?}");
        }
    }

    #[test]
    // (reference geometry symbols L_ and U_)
    fn clip_intersect_and_relative_match() {
        let a = Clip {
            bottom: 100.0,
            left: 0.0,
            right: 100.0,
            top: 0.0,
        };
        let b = Clip {
            bottom: 80.0,
            left: 20.0,
            right: 200.0,
            top: 30.0,
        };
        let i = clip_intersect(a, b).expect("overlapping");
        assert_eq!(
            i,
            Clip {
                bottom: 80.0,
                left: 20.0,
                right: 100.0,
                top: 30.0
            }
        );
        // degenerate (edge-touch) intersections are None
        let edge = Clip {
            bottom: 0.0,
            left: 50.0,
            right: 100.0,
            top: -10.0,
        };
        assert_eq!(clip_intersect(a, edge), None);
        // U_: intersect, then re-express relative to the OUTER rect's
        // origin — this is what makes a parent-space iframe clip usable
        // (frame-local) inside the child walk.
        let r = clip_relative_to(b, a).expect("non-degenerate");
        // intersect = {bottom:80,left:20,right:100,top:30}; shifted by
        // the outer rect's origin (left 20, top 30):
        assert_eq!(
            r,
            Clip {
                bottom: 50.0,
                left: 0.0,
                right: 80.0,
                top: 0.0
            }
        );
    }

    #[test]
    fn quad_math_matches_hp_and_p5() {
        let quad = vec![10.0, 20.0, 110.0, 20.0, 110.0, 120.0, 10.0, 120.0];
        assert_eq!(quad_bounds(&quad), Some((110.0, 120.0, 10.0, 20.0)));
        // p5: sx=x/width, sy=y/height — (5,5) of a 100×100 frame lands
        // 5% along each axis from the quad origin (10,20) → (15,25)
        assert_eq!(
            transform_point((5.0, 5.0), Some((100.0, 100.0)), &quad),
            Some((15.0, 25.0))
        );
        // A frame whose viewport differs from the quad's size scales:
        // (50,50) of a 200×200 viewport = a quarter → (35,45).
        assert_eq!(
            transform_point((50.0, 50.0), Some((200.0, 200.0)), &quad),
            Some((35.0, 45.0))
        );
        // unsized (getContentQuads default path): translate by bounds origin
        assert_eq!(transform_point((5.0, 5.0), None, &quad), Some((15.0, 25.0)));
        // degenerate inputs
        assert_eq!(transform_point((5.0, 5.0), None, &[1.0, 2.0]), None);
        assert_eq!(transform_point((5.0, 5.0), Some((0.0, 10.0)), &quad), None);
    }

    fn fr(id: &str, parent: Option<&str>) -> FrameRef {
        FrameRef {
            frame_id: id.into(),
            loader_id: Some("L1".into()),
            parent_frame_id: parent.map(str::to_string),
            size: None,
        }
    }

    #[test]
    fn public_ids_are_stable_across_same_document_snapshots() {
        let r = DomRegistries::default();
        let clip = Clip {
            bottom: 600.0,
            left: 0.0,
            right: 800.0,
            top: 0.0,
        };
        r.reset_for_snapshot("1", "F1:LOAD1");
        r.assign_public_id("1", "F1", Some("LOAD1"), "7", clip)
            .unwrap();
        let id = r
            .assign_public_id("1", "F1", Some("LOAD1"), "9", clip)
            .unwrap();
        // snapshot 2, same main document: the per-action map
        // (nodeByPublicId) resets with the snapshot…
        r.reset_for_snapshot("1", "F1:LOAD1");
        assert!(r.lookup_node("1", id).is_err());
        // …while the ref cache persists (same id) and re-binds lookup
        // once this snapshot re-emits the element (cO).
        assert_eq!(
            r.assign_public_id("1", "F1", Some("LOAD1"), "9", clip)
                .unwrap(),
            id
        );
        let n = r.lookup_node("1", id).unwrap();
        assert_eq!(n.local_ref, "9");
        assert_eq!(n.viewport_clip, Some(clip));
    }

    #[test]
    fn new_main_document_resets_ids_and_a_full_cache_restart_happens() {
        let r = DomRegistries::default();
        let clip = Clip {
            bottom: 600.0,
            left: 0.0,
            right: 800.0,
            top: 0.0,
        };
        r.reset_for_snapshot("1", "F1:LOAD1");
        let first = r
            .assign_public_id("1", "F1", Some("LOAD1"), "1", clip)
            .unwrap();
        assert_eq!(first, 1);
        // navigation: a new loader means a new main-document state →
        // even a previously-stable local ref starts at 1 again.
        r.reset_for_snapshot("1", "F1:LOAD2");
        assert_eq!(
            r.assign_public_id("1", "F1", Some("LOAD2"), "1", clip)
                .unwrap(),
            1
        );
        assert_eq!(
            r.assign_public_id("1", "F1", Some("LOAD2"), "2", clip)
                .unwrap(),
            2
        );
        // XX eviction: crossing 5000 cached refs restarts the counter.
        for i in 3..=(PUBLIC_ID_CACHE_MAX as u64 + 1) {
            r.assign_public_id("1", "F1", Some("LOAD2"), &i.to_string(), clip)
                .unwrap();
        }
        r.reset_for_snapshot("1", "F1:LOAD2");
        assert_eq!(
            r.assign_public_id("1", "F1", Some("LOAD2"), "1", clip)
                .unwrap(),
            1
        );
    }

    #[test]
    fn stale_public_ids_answer_the_pinned_error() {
        let r = DomRegistries::default();
        let err = r.lookup_node("1", 42).unwrap_err();
        assert_eq!(err.to_string(), "DOM node 42 is stale or missing");
        assert!(matches!(err, BrowserError::StaleDomNode { node_id: 42 }));
    }

    #[test]
    fn world_cache_is_fifo_and_tab_scoped() {
        let r = DomRegistries::default();
        for i in 0..(WORLD_CACHE_MAX as i64) {
            r.put_world("1", &format!("F{i}"), None, i);
        }
        r.put_world("1", "F-new", None, 999);
        assert_eq!(r.worlds.lock().map.len(), WORLD_CACHE_MAX);
        assert_eq!(r.cached_world("1", "F0", None), None); // oldest evicted
        assert_eq!(r.cached_world("1", "F-new", None), Some(999));
        r.put_world("2", "Fx", None, 7);
        r.forget_tab("2");
        assert_eq!(r.cached_world("2", "Fx", None), None);
        // re-setting an existing key must NOT re-order the FIFO
        r.put_world("1", "F1", None, 111);
        r.put_world("1", "F-tail", None, 222);
        assert_eq!(r.worlds.lock().map.len(), WORLD_CACHE_MAX);
        assert_eq!(r.cached_world("1", "F1", None), Some(111));
        r.forget_tab("1");
        assert!(!r.has_state("1"));
        assert_eq!(r.cached_world("1", "F-new", None), None);
        assert_eq!(r.worlds.lock().map.len(), 0);
    }

    #[test]
    // (reference context-gone signature table ZX)
    fn context_gone_matches_reference_signatures() {
        assert!(context_gone("Cannot find context with specified id"));
        assert!(context_gone(
            "Execution context was destroyed, most likely because of a navigation."
        ));
        assert!(context_gone("Missing copied object: context not found"));
        assert!(!context_gone("DOM agent not available"));
        assert!(!context_gone("Invalid parameters"));
    }

    #[test]
    fn emit_line_enforces_the_cap_without_truncation() {
        let r = DomRegistries::default();
        r.reset_for_snapshot("1", "F1:LOAD1");
        let f = fr("F1", None);
        let clip = Clip {
            bottom: 600.0,
            left: 0.0,
            right: 800.0,
            top: 0.0,
        };
        let wi = |local_ref: &str, line: &str| WalkItem {
            line: line.to_string(),
            local_ref: local_ref.to_string(),
        };
        let mut out = WalkOut::default();
        emit_line(
            &r,
            &mut out,
            "1",
            &f,
            &wi("1", "<a node_id=1 href=\"/x\">x</a>"),
            clip,
            500,
        )
        .unwrap();
        emit_line(
            &r,
            &mut out,
            "1",
            &f,
            &wi("2", "<b node_id=2>y</b>"),
            clip,
            500,
        )
        .unwrap();
        // cost includes the joining newline (len + 1 for non-first
        // lines): 28-char first line + newline + 18-char second
        assert_eq!(out.chars, 28 + 1 + 18);
        assert!(out.lines[0].contains("node_id=1"));
        assert!(out.lines[1].contains("node_id=2") && !out.lines[1].contains("node_id=22"));
        // the cap drops an over-budget line whole (never a partial
        // emit) and reports false so the reference's item-loop `break`
        // fires; the id is still consumed (uD runs before the check).
        let tight_cap = out.chars + 3;
        assert!(!emit_line(
            &r,
            &mut out,
            "1",
            &f,
            &wi("3", "<c node_id=3>nope</c>"),
            clip,
            tight_cap
        )
        .unwrap());
        assert_eq!(out.lines.len(), 2);
        assert!(r.lookup_node("1", 3).is_ok());
        // first-occurrence-only replace (JS String.replace semantics):
        // ref "9" maps to public 4 (1,2,3 already consumed); a naive
        // replace-all would corrupt the `node_id=99` text below.
        emit_line(
            &r,
            &mut out,
            "1",
            &f,
            &wi("9", "<d node_id=9>see node_id=99</d>"),
            clip,
            500,
        )
        .unwrap();
        assert_eq!(out.lines[2], "<d node_id=4>see node_id=99</d>");
    }

    #[test]
    fn budget_open_tracks_both_caps() {
        let mut out = WalkOut {
            lines: vec!["x".into(); MAX_SNAPSHOT_ELEMENTS],
            chars: 1,
        };
        assert!(!budget_open(&out));
        out.lines.clear();
        out.chars = MAX_SNAPSHOT_CHARS;
        assert!(!budget_open(&out));
        out.chars = 0;
        assert!(budget_open(&out));
    }
}
