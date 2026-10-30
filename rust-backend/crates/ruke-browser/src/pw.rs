//! Phase 7 — the Playwright-style locator runtime.
//!
//! This module is a behavioral-equivalent CDP port of the reference
//! `playwright_*` command surface (probe-pinned against the bundled
//! Chromium, see `docs/STATE.md` §8.4): aria snapshots (`mode:"ai"`
//! shape) mint `[ref=eN]` tokens stored per tab, selectors are
//! `aria-ref=eN` or CSS chains joined by ` >> `, and the
//! ` >> internal:control=enter-frame >> ` literal hops the resolution
//! scope into a matched iframe host.
//!
//! Probe-pinned CDP laws this module depends on:
//! - isolated worlds SHARE the DOM but NOT the JS heap: `css:` scope
//!   queries run in the shared DOM world cache (`dom_cua::world_eval`),
//!   while model `playwright_evaluate` scripts run in the MAIN world
//!   (no `contextId`), and element handles from `DOM.resolveNode` are
//!   MAIN-world receivers;
//! - `Runtime.callFunctionOn` with `objectId` binds the node as
//!   `this` (the receiver trick), extra args ride in `arguments`;
//! - `Runtime.getProperties{ownOnly:true}` enumerates NodeList arrays
//!   by numeric names (`/^\d+$/` filter);
//! - `DOM.getFrameOwner{frameId}.backendNodeId` == the host iframe's
//!   `describeNode.backendNodeId` (the enter-frame join ax.rs also uses);
//! - `DOM.getBoxModel` answers in PAGE-space coordinates even for
//!   child-frame nodes (no geometry hop before `Input.dispatchMouseEvent`);
//! - hidden nodes fail box-model computation with "Could not compute
//!   box model" — the invisible signal.
//!
//! Strict-mode semantics: every single-element operation resolves the
//! selector NOW (or with the 30 s default poll loop for actions/waits)
//! and refuses 0/2+ matches with the pinned error strings in
//! `errors::BrowserError` (the "strict mode violation" token and the
//! `Timeout …ms exceeded` grammar are behavioral contracts).

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::ax::PwAxNode;
use crate::cdp::CdpConn;
use crate::engine::BrowserRuntime;
use crate::errors::{payload_invalid, BrowserError};
use crate::schemas::{
    ElementInfoPayload, EvaluatePayload, KeyboardModifier, LoadState, LocatorCheckedPayload,
    LocatorClickPayload, LocatorKeyPayload, LocatorNamePayload, LocatorPayload,
    LocatorSelectPayload, LocatorTextPayload, LocatorValuePayload, LocatorWaitPayload, MouseButton,
    RequiredTimeoutPayload, ScreenshotPayload, SelectOptionInput, SelectOptionOne,
    SelectOptionSingle, SelectorMode, WaitForLoadStatePayload, WaitForState, WaitForUrlPayload,
};
use crate::session::TabRecord;

/// The reference's frame-hop literal (pinned; the KN chain operator).
pub(crate) const ENTER_FRAME_SEP: &str = " >> internal:control=enter-frame >> ";
/// Playwright's engine-chain separator.
/// The aria-snapshot reference selector prefix.
const ARIA_REF: &str = "aria-ref=";
/// Playwright's default locator timeout (behavioral contract).
pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Poll cadence for every wait/strict loop.
const POLL_MS: u64 = 100;
/// Upper bound on matches a single scope query materializes.
const MAX_MATCHES: usize = 100;
/// `networkidle` = no resource-count change for this long (pinned).
const NETWORK_IDLE_QUIET_MS: u64 = 500;
/// Aria-snapshot line budget; beyond it the snapshot reports truncation.
const MAX_SNAPSHOT_LINES: usize = 1_000;
/// Properties an aria line may carry (Playwright's aria snapshot set).
const SNAPSHOT_PROPS: [&str; 13] = [
    "checked",
    "disabled",
    "expanded",
    "level",
    "multiselectable",
    "pressed",
    "readonly",
    "required",
    "selected",
    "valuemax",
    "valuemin",
    "valuenow",
    "valuetext",
];
/// Locator engines the reference exposes but this port does not
/// implement — every one of them must surface an honest parse error,
/// never a silent CSS reinterpretation.
const PW_ENGINES: [&str; 10] = [
    "text", "nth", "visible", "internal", "js", "xpath", "aria", "func", "control", "anchor",
];

#[derive(Default)]
struct PwTabState {
    /// `eN` token → backendNodeId captured at snapshot commit.
    refs: HashMap<String, i64>,
}

/// Per-tab locator registries (mirrors `AxRegistries` lifecycle: every
/// tab-removal path and shutdown calls `forget_tab`/`clear_all`).
#[derive(Default)]
pub struct PwRegistries {
    tabs: Mutex<HashMap<String, PwTabState>>,
}

impl PwRegistries {
    /// Replace the tab's aria reference map with the freshly minted one
    /// (stale tokens die with the snapshot that produced them).
    pub fn set_refs(&self, tab_id: &str, refs: HashMap<String, i64>) {
        let mut tabs = self.tabs.lock();
        if let Some(st) = tabs.get_mut(tab_id) {
            st.refs = refs;
        } else {
            tabs.insert(tab_id.to_string(), PwTabState { refs });
        }
    }

    /// Resolve an `eN` token against the tab's current snapshot.
    pub fn ref_node(&self, tab_id: &str, token: &str) -> Option<i64> {
        self.tabs
            .lock()
            .get(tab_id)
            .and_then(|st| st.refs.get(token).copied())
    }

    pub fn forget_tab(&self, tab_id: &str) {
        self.tabs.lock().remove(tab_id);
    }

    pub fn clear_all(&self) {
        self.tabs.lock().clear();
    }
}

// ── Selector grammar ──────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Seg {
    Css(String),
    Ref(String),
}

/// Parse a full selector into frame groups (`groups[1..]` sit behind
/// an `enter-frame` hop) and each group into its ` >> ` segment chain.
pub(crate) fn parse_selector(selector: &str) -> Result<Vec<Vec<Seg>>, BrowserError> {
    let groups: Vec<&str> = selector.split(ENTER_FRAME_SEP).collect();
    let mut out = Vec::with_capacity(groups.len());
    for g in groups {
        let g = g.trim();
        if g.is_empty() {
            return Err(payload_invalid(
                "locator selector",
                "the enter-frame chain has an empty side",
            ));
        }
        let mut segs = Vec::new();
        for raw in split_segments(g)? {
            segs.push(classify_seg(&raw)?);
        }
        out.push(segs);
    }
    Ok(out)
}

/// Split one frame group on the ` >> ` chain separator, ignoring
/// separators nested inside quotes or `[`/`(` groups.
fn split_segments(text: &str) -> Result<Vec<String>, BrowserError> {
    let b = text.as_bytes();
    let mut parts: Vec<String> = Vec::new();
    let mut start = 0usize;
    let mut depth: i32 = 0;
    let mut quote: Option<u8> = None;
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if c == b'\\' {
                i += 1;
            }
        } else {
            match c {
                b'\'' | b'"' => quote = Some(c),
                b'[' | b'(' => depth += 1,
                b']' | b')' => depth -= 1,
                _ => {}
            }
            // The chain token is a top-level `>>` (any spacing); a CSS
            // `>` combinator never doubles, and quote/bracket depths
            // are handled above.
            if depth <= 0 && c == b'>' && b[i..].starts_with(b">>") {
                push_part(text, start, i, &mut parts)?;
                i += 2;
                start = i;
                continue;
            }
        }
        i += 1;
    }
    push_part(text, start, b.len(), &mut parts)?;
    Ok(parts)
}

fn push_part(
    text: &str,
    from: usize,
    to: usize,
    parts: &mut Vec<String>,
) -> Result<(), BrowserError> {
    let p = text[from..to].trim();
    if p.is_empty() {
        return Err(payload_invalid(
            "locator selector",
            "empty selector segment around the \" >> \" chain separator",
        ));
    }
    parts.push(p.to_string());
    Ok(())
}

fn classify_seg(s: &str) -> Result<Seg, BrowserError> {
    if let Some(tok) = s.strip_prefix(ARIA_REF) {
        if tok.is_empty() {
            return Err(payload_invalid(
                "locator selector",
                "aria-ref= carried no snapshot token",
            ));
        }
        return Ok(Seg::Ref(tok.to_string()));
    }
    if let Some(css) = s.strip_prefix("css:") {
        if css.trim().is_empty() {
            return Err(payload_invalid(
                "locator selector",
                "css: carried no selector",
            ));
        }
        return Ok(Seg::Css(css.trim().to_string()));
    }
    // Private engines (`internal:*`) never parse: the frame-hop literal
    // is their only sanctioned use, split off in parse_selector before
    // this classifier runs (a bare `internal:` here is the hop syntax
    // used out of context).
    if s.starts_with("internal:") {
        return Err(payload_invalid(
            "locator selector",
            "locator engine \"internal\" is not supported here (supported: CSS selectors, aria-ref= snapshot tokens)",
        ));
    }
    // Any `name=` prefix whose head is engine-shaped (an ascii-letter
    // base, optionally colon-namespaced like `internal:control`) is an
    // engine prefix; bare attribute selectors (`[role=button]`) keep
    // the `[` head and fall through to CSS below.
    if let Some(eq) = s.find('=') {
        let head = &s[..eq];
        let base = head.split(':').next().unwrap_or("");
        let engineish = !base.is_empty()
            && base.bytes().all(|c| c.is_ascii_alphabetic())
            && head
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b':');
        if engineish {
            if PW_ENGINES.contains(&base) {
                return Err(payload_invalid(
                    "locator selector",
                    format!(
                        "locator engine \"{base}\" is not supported here (supported: CSS selectors, aria-ref= snapshot tokens)"
                    ),
                ));
            }
            return Err(payload_invalid(
                "locator selector",
                format!("unsupported locator engine \"{base}\""),
            ));
        }
    }
    Ok(Seg::Css(s.to_string()))
}

// ── Frame topology (enter-frame join) ─────────────────────────────────

#[derive(Clone, Debug)]
struct PwFrame {
    frame_id: String,
    loader_id: Option<String>,
}

/// DFS frame list (main frame first) plus the host-iframe backendNodeId
/// → frame-index map (`DOM.getFrameOwner`, one call per non-root frame;
/// frames that fail the call are simply unaddressable by the chain) and
/// each frame's parent index (`parents[0] == None`, the main frame).
async fn pw_frame_tree(
    conn: &CdpConn,
    session: &str,
) -> Result<(Vec<PwFrame>, HashMap<i64, usize>, Vec<Option<usize>>), BrowserError> {
    let tree = conn.call("Page.getFrameTree", None, Some(session)).await?;
    let mut frames: Vec<PwFrame> = Vec::new();
    let mut parents: Vec<Option<usize>> = Vec::new();
    let mut stack: Vec<(&Value, Option<usize>)> = Vec::new();
    if let Some(root) = tree.get("frameTree") {
        stack.push((root, None));
    }
    while let Some((node, parent)) = stack.pop() {
        let Some(frame) = node.get("frame") else {
            continue;
        };
        let Some(frame_id) = frame.get("frameId").and_then(Value::as_str) else {
            continue;
        };
        let idx = frames.len();
        frames.push(PwFrame {
            frame_id: frame_id.to_string(),
            loader_id: frame
                .get("loaderId")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
        parents.push(parent);
        if let Some(children) = node.get("childFrames").and_then(Value::as_array) {
            for c in children.iter().rev() {
                stack.push((c, Some(idx)));
            }
        }
    }
    let mut owners: HashMap<i64, usize> = HashMap::new();
    for (idx, fr) in frames.iter().enumerate().skip(1) {
        let res = conn
            .call(
                "DOM.getFrameOwner",
                Some(json!({ "frameId": fr.frame_id })),
                Some(session),
            )
            .await;
        if let Ok(v) = res {
            if let Some(b) = v.get("backendNodeId").and_then(Value::as_i64) {
                owners.insert(b, idx);
            }
        }
    }
    Ok((frames, owners, parents))
}

// ── Scope engine (selector → backendNodeIds) ──────────────────────────

#[derive(Clone)]
enum Scope {
    /// Query the whole document of frame index `usize` (main first).
    Frame(usize),
    /// Query inside these specific nodes.
    Nodes(Vec<i64>),
}

impl PwRegistries {
    /// Resolve a selector to ordered, deduplicated backendNodeIds. The
    /// first group matches across every frame; each following group
    /// resolves inside the frames hosted by the previous group's nodes
    /// (the `enter-frame` hop).
    pub(crate) async fn pw_nodes(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        selector: &str,
    ) -> Result<Vec<i64>, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let groups = parse_selector(selector)?;
        let (frames, owners, _) = pw_frame_tree(conn, session).await?;
        let mut scopes: Vec<Scope> = (0..frames.len()).map(Scope::Frame).collect();

        for (gi, group) in groups.iter().enumerate() {
            if gi > 0 {
                let mut host_frames: Vec<usize> = Vec::new();
                let mut seen_f: HashSet<usize> = HashSet::new();
                for sc in &scopes {
                    if let Scope::Nodes(list) = sc {
                        for b in list {
                            if let Some(&fi) = owners.get(b) {
                                if seen_f.insert(fi) {
                                    host_frames.push(fi);
                                }
                            }
                        }
                    }
                }
                if host_frames.is_empty() {
                    return Err(BrowserError::LocatorFailed {
                        selector: selector.to_string(),
                        reason:
                            "the chain before \"enter-frame\" did not resolve to an iframe host"
                                .to_string(),
                    });
                }
                scopes = host_frames.into_iter().map(Scope::Frame).collect();
            }
            for seg in group {
                let mut next: Vec<i64> = Vec::new();
                let mut seen: HashSet<i64> = HashSet::new();
                match seg {
                    Seg::Ref(token) => {
                        let bnid = self.ref_node(&rec.tab_id, token).ok_or_else(|| {
                            BrowserError::LocatorStaleRef {
                                token: token.clone(),
                            }
                        })?;
                        match conn
                            .call(
                                "DOM.describeNode",
                                Some(json!({ "backendNodeId": bnid })),
                                Some(session),
                            )
                            .await
                        {
                            Ok(v) if v.pointer("/node/backendNodeId").is_some() => {}
                            Ok(_) | Err(_) => {
                                return Err(BrowserError::LocatorStaleRef {
                                    token: token.clone(),
                                })
                            }
                        }
                        if seen.insert(bnid) {
                            next.push(bnid);
                        }
                    }
                    Seg::Css(css) => {
                        for sc in &scopes {
                            match sc {
                                Scope::Frame(fi) => {
                                    let expr = format!(
                                        "Array.prototype.slice.call(document.querySelectorAll({}), 0, {MAX_MATCHES})",
                                        json!(css)
                                    );
                                    let fr = &frames[*fi];
                                    let res = rt
                                        .world_eval(
                                            conn,
                                            rec,
                                            &fr.frame_id,
                                            fr.loader_id.as_deref(),
                                            &expr,
                                            false,
                                        )
                                        .await?;
                                    if let Some(oid) =
                                        res.pointer("/result/objectId").and_then(Value::as_str)
                                    {
                                        for b in pw_props_to_bnids(conn, session, oid).await? {
                                            if seen.insert(b) {
                                                next.push(b);
                                            }
                                        }
                                    }
                                }
                                Scope::Nodes(list) => {
                                    let decl = format!(
                                        "function() {{ return Array.prototype.slice.call(this.querySelectorAll({}), 0, {MAX_MATCHES}); }}",
                                        json!(css)
                                    );
                                    for b in list {
                                        let oid = pw_handle(conn, session, *b).await?;
                                        let res = pw_call_raw(
                                            conn,
                                            session,
                                            Some(&oid),
                                            &decl,
                                            None,
                                            false,
                                        )
                                        .await?;
                                        if let Some(sub) =
                                            res.pointer("/result/objectId").and_then(Value::as_str)
                                        {
                                            for bb in pw_props_to_bnids(conn, session, sub).await? {
                                                if seen.insert(bb) {
                                                    next.push(bb);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                scopes = vec![Scope::Nodes(next)];
            }
        }

        let mut out: Vec<i64> = Vec::new();
        let mut seen = HashSet::new();
        for sc in scopes {
            if let Scope::Nodes(list) = sc {
                for b in list {
                    if seen.insert(b) {
                        out.push(b);
                    }
                }
            }
        }
        Ok(out)
    }

    /// Resolve the selector with strict single semantics; 0 matches
    /// polls until the deadline, 2+ matches fail immediately.
    pub(crate) async fn pw_strict_one(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        selector: &str,
        timeout_ms: u64,
    ) -> Result<i64, BrowserError> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let nodes = self.pw_nodes(rt, conn, rec, selector).await?;
            if nodes.len() == 1 {
                return Ok(nodes[0]);
            }
            if nodes.len() > 1 {
                return Err(BrowserError::LocatorStrict {
                    selector: selector.to_string(),
                    count: nodes.len(),
                });
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::LocatorTimeout {
                    selector: selector.to_string(),
                    state: "attached".to_string(),
                    timeout_ms,
                });
            }
            sleep_poll().await;
        }
    }
}

// ── CDP primitives (probe-pinned) ─────────────────────────────────────

/// NodeList-array handles enumerate by numeric property names; join
/// them to backendNodeIds through `DOM.describeNode{objectId}`.
async fn pw_props_to_bnids(
    conn: &CdpConn,
    session: &str,
    object_id: &str,
) -> Result<Vec<i64>, BrowserError> {
    let res = conn
        .call(
            "Runtime.getProperties",
            Some(json!({ "objectId": object_id, "ownOnly": true })),
            Some(session),
        )
        .await?;
    let entries = res
        .pointer("/result")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for e in entries {
        let is_index = e
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()));
        if !is_index {
            continue;
        }
        let Some(sub_oid) = e.pointer("/value/objectId").and_then(Value::as_str) else {
            continue;
        };
        let Ok(d) = conn
            .call(
                "DOM.describeNode",
                Some(json!({ "objectId": sub_oid })),
                Some(session),
            )
            .await
        else {
            continue;
        };
        if let Some(b) = d.pointer("/node/backendNodeId").and_then(Value::as_i64) {
            out.push(b);
        }
    }
    Ok(out)
}

async fn pw_handle(conn: &CdpConn, session: &str, bnid: i64) -> Result<String, BrowserError> {
    match conn
        .call(
            "DOM.resolveNode",
            Some(json!({ "backendNodeId": bnid })),
            Some(session),
        )
        .await
    {
        Ok(res) => res
            .pointer("/object/objectId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| BrowserError::CdpFailed {
                method: "DOM.resolveNode".to_string(),
                reason: "resolved object carried no objectId".to_string(),
            }),
        Err(e) => {
            if e.to_string().contains("No node with given id") {
                Err(BrowserError::StaleDomNode {
                    node_id: bnid.max(0) as u64,
                })
            } else {
                Err(e)
            }
        }
    }
}

fn pw_exception_reason(res: &Value, method: &str) -> Option<BrowserError> {
    let ex = res.pointer("/exceptionDetails")?;
    let reason = ex
        .pointer("/exception/description")
        .and_then(Value::as_str)
        .or_else(|| ex.get("text").and_then(Value::as_str))
        .unwrap_or("page function raised an exception")
        .to_string();
    Some(BrowserError::CdpFailed {
        method: method.to_string(),
        reason,
    })
}

/// `Runtime.callFunctionOn` with the probe-pinned receiver trick:
/// `objectId` binds the node as `this`, extra parameters ride in
/// `arguments: [{ value: … }]`.
async fn pw_call_raw(
    conn: &CdpConn,
    session: &str,
    object_id: Option<&str>,
    declaration: &str,
    args: Option<Vec<Value>>,
    return_by_value: bool,
) -> Result<Value, BrowserError> {
    let mut params = json!({
        "functionDeclaration": declaration,
        "returnByValue": return_by_value,
        "awaitPromise": true,
    });
    if let Some(oid) = object_id {
        params["objectId"] = json!(oid);
    }
    if let Some(a) = args {
        params["arguments"] = Value::Array(a);
    }
    let res = conn
        .call("Runtime.callFunctionOn", Some(params), Some(session))
        .await?;
    if let Some(e) = pw_exception_reason(&res, "Runtime.callFunctionOn") {
        return Err(e);
    }
    Ok(res)
}

async fn pw_call_value(
    conn: &CdpConn,
    session: &str,
    object_id: Option<&str>,
    declaration: &str,
    args: Option<Vec<Value>>,
) -> Result<Value, BrowserError> {
    let res = pw_call_raw(conn, session, object_id, declaration, args, true).await?;
    Ok(pw_value_of(&res))
}

fn pw_value_of(res: &Value) -> Value {
    res.pointer("/result/value").cloned().unwrap_or(Value::Null)
}

/// MAIN-world evaluation (the playwright_evaluate contract: model
/// scripts see the page's JS heap, not the tool world).
async fn pw_eval_main(
    conn: &CdpConn,
    session: &str,
    expression: &str,
) -> Result<Value, BrowserError> {
    let res = conn
        .call(
            "Runtime.evaluate",
            Some(json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
            })),
            Some(session),
        )
        .await?;
    if let Some(e) = pw_exception_reason(&res, "Runtime.evaluate") {
        return Err(e);
    }
    Ok(pw_value_of(&res))
}

// ── Element predicates & geometry ─────────────────────────────────────

const VISIBLE_JS: &str = r"function(){ if (!this.isConnected) return false; const r = this.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(this); if (cs.visibility === 'hidden' || cs.display === 'none') return false; return true; }";
const ENABLED_JS: &str = "function(){ return !this.disabled; }";
const CHECKED_JS: &str = "function(){ return !!this.checked; }";
const FOCUS_JS: &str = "function(){ if (this.focus) this.focus(); }";

async fn pw_pred(
    conn: &CdpConn,
    session: &str,
    object_id: &str,
    js: &str,
) -> Result<bool, BrowserError> {
    let v = pw_call_value(conn, session, Some(object_id), js, None).await?;
    Ok(v.as_bool().unwrap_or(false))
}

/// Page-space click point; hidden nodes surface as `None` (the pinned
/// "Could not compute box model" protocol failure is the signal).
async fn pw_box_center(
    conn: &CdpConn,
    session: &str,
    bnid: i64,
) -> Result<Option<(f64, f64)>, BrowserError> {
    let res = match conn
        .call(
            "DOM.getBoxModel",
            Some(json!({ "backendNodeId": bnid })),
            Some(session),
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            if e.to_string().contains("Could not compute box model") {
                return Ok(None);
            }
            return Err(e);
        }
    };
    let pts = res.pointer("/model/content").and_then(Value::as_array);
    let nums: Vec<f64> = pts
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    if nums.len() < 8 {
        return Ok(None);
    }
    let x = (nums[0] + nums[2] + nums[4] + nums[6]) / 4.0;
    let y = (nums[1] + nums[3] + nums[5] + nums[7]) / 4.0;
    Ok(Some((x, y)))
}

async fn pw_scroll_into_view(conn: &CdpConn, session: &str, bnid: i64) -> Result<(), BrowserError> {
    conn.call(
        "DOM.scrollIntoViewIfNeeded",
        Some(json!({ "backendNodeId": bnid })),
        Some(session),
    )
    .await
    .map(|_| ())
}

/// Real trusted input: press/release pairs with increasing `clickCount`
/// (probe-verified to focus and activate inner-frame targets).
async fn pw_dispatch_click(
    conn: &CdpConn,
    session: &str,
    x: f64,
    y: f64,
    button: &str,
    click_count: u32,
    modifiers: u32,
) -> Result<(), BrowserError> {
    for n in 1..=click_count.max(1) {
        for typ in ["mousePressed", "mouseReleased"] {
            conn.call(
                "Input.dispatchMouseEvent",
                Some(json!({
                    "type": typ,
                    "x": x,
                    "y": y,
                    "button": button,
                    "clickCount": n,
                    "modifiers": modifiers,
                })),
                Some(session),
            )
            .await?;
        }
    }
    Ok(())
}

async fn sleep_poll() {
    tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
}

fn button_str(b: MouseButton) -> &'static str {
    match b {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// CDP event modifier bits (Alt=1, Control=2, Meta=4, Shift=8).
fn modifier_mask(mods: &[KeyboardModifier]) -> u32 {
    mods.iter()
        .map(|m| match m {
            KeyboardModifier::Alt => 1,
            KeyboardModifier::Control | KeyboardModifier::ControlOrMeta => 2,
            KeyboardModifier::Meta => 4,
            KeyboardModifier::Shift => 8,
        })
        .sum()
}

impl PwRegistries {
    /// Playwright click actionability loop: attached (wait), single
    /// (strict), visible+enabled unless `force`, scrolled, box-present,
    /// then real trusted input at the content-box center.
    pub(crate) async fn pw_locator_click(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorClickPayload,
        dblclick: bool,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let timeout = p.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let deadline = Instant::now() + Duration::from_millis(timeout);
        let button = button_str(p.button.unwrap_or(MouseButton::Left));
        let click_count = if dblclick {
            p.click_count.unwrap_or(2).max(2)
        } else {
            p.click_count.unwrap_or(1).max(1)
        };
        let force = p.force.unwrap_or(false);
        let modifiers = modifier_mask(p.modifiers.as_deref().unwrap_or(&[]));
        loop {
            let nodes = self.pw_nodes(rt, conn, rec, &p.selector).await?;
            match nodes.len() {
                0 => {
                    if Instant::now() >= deadline {
                        return Err(BrowserError::LocatorTimeout {
                            selector: p.selector.clone(),
                            state: "attached".to_string(),
                            timeout_ms: timeout,
                        });
                    }
                    sleep_poll().await;
                    continue;
                }
                n if n > 1 => {
                    return Err(BrowserError::LocatorStrict {
                        selector: p.selector.clone(),
                        count: n,
                    })
                }
                _ => {}
            }
            let bnid = nodes[0];
            if !force {
                let oid = pw_handle(conn, session, bnid).await?;
                let visible = pw_pred(conn, session, &oid, VISIBLE_JS).await?;
                let enabled = pw_pred(conn, session, &oid, ENABLED_JS).await?;
                if !(visible && enabled) {
                    let _ = pw_scroll_into_view(conn, session, bnid).await;
                    sleep_poll().await;
                    continue;
                }
            }
            let _ = pw_scroll_into_view(conn, session, bnid).await;
            let (x, y) = match pw_box_center(conn, session, bnid).await? {
                Some(c) => c,
                None => {
                    if force {
                        return Err(BrowserError::LocatorFailed {
                            selector: p.selector.clone(),
                            reason: "element has no layout box to click (hidden?)".to_string(),
                        });
                    }
                    sleep_poll().await;
                    continue;
                }
            };
            pw_dispatch_click(conn, session, x, y, button, click_count, modifiers).await?;
            return Ok(json!({}));
        }
    }
}

// ── aria snapshot (mode:"ai") ─────────────────────────────────────────

/// Render the merged AX tree (`PwAxNode` shape) into the recovered
/// aria-snapshot grammar: `- <role> "<name>" [props] [ref=eN]`, refs
/// minted against backendNodeIds so `aria-ref=eN` can resolve later.
/// Ignored nodes and `RootWebArea` hoist their children (the tree
/// flattens), and empty `generic`/`listitem`/`group`/`none`/
/// `presentation` lines are pruned exactly like the recovered `$te`
/// test; unnamed `img` subtrees drop like the recovered `Gte` test.
/// [adapted]: `StaticText` prints as `text` and the line cap is a
/// Ruke guard; neither appears in the recovered bundle.
fn snapshot_lines(
    nodes: &[PwAxNode],
) -> (Vec<String>, HashMap<String, i64>, Vec<(usize, String, i64)>) {
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    let mut referenced: HashSet<&str> = HashSet::new();
    for (i, n) in nodes.iter().enumerate() {
        by_id.insert(n.node_id.as_str(), i);
    }
    for n in nodes {
        for c in &n.child_ids {
            referenced.insert(c.as_str());
        }
    }
    let mut roots: Vec<usize> = nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| !referenced.contains(n.node_id.as_str()))
        .map(|(i, _)| i)
        .collect();
    if roots.is_empty() && !nodes.is_empty() {
        roots.push(0);
    }

    let mut lines: Vec<String> = Vec::new();
    let mut refs: HashMap<String, i64> = HashMap::new();
    let mut iframe_lines: Vec<(usize, String, i64)> = Vec::new();
    let mut visited: HashSet<&str> = HashSet::new();
    let mut ref_counter: u32 = 0;
    let mut stack: Vec<(usize, usize)> = roots.iter().rev().map(|&i| (i, 0)).collect();

    while let Some((i, depth)) = stack.pop() {
        let n = &nodes[i];
        if !visited.insert(n.node_id.as_str()) {
            continue;
        }
        let role = n.role.to_ascii_lowercase();
        let hoist = n.ignored || role.is_empty() || role == "rootwebarea";
        let has_name = n.name.as_deref().is_some_and(|s| !s.trim().is_empty());
        let props: Vec<String> = n
            .props
            .iter()
            .filter(|(pn, _)| SNAPSHOT_PROPS.contains(&pn.as_str()))
            .map(|(pn, pv)| match pv {
                Value::Bool(b) => (Some(pn.clone()), *b),
                Value::Number(_) | Value::String(_) => (
                    Some(format!("{pn}={}", json_key(pv))),
                    pv.as_bool() != Some(false),
                ),
                _ => (None, false),
            })
            .filter(|(_, keep)| *keep)
            .flat_map(|(s, _)| s)
            .collect();
        if hoist
            || ((role == "generic"
                || role == "listitem"
                || role == "group"
                || role == "none"
                || role == "presentation")
                && !has_name
                && props.is_empty())
        {
            for cid in n.child_ids.iter().rev() {
                if let Some(&ci) = by_id.get(cid.as_str()) {
                    stack.push((ci, depth));
                }
            }
            continue;
        }
        if role == "img" && !has_name {
            continue;
        }
        let role_out = if role == "statictext" {
            "text"
        } else {
            role.as_str()
        };
        let mut line = format!("{}- {}", "  ".repeat(depth), role_out);
        if let Some(nm) = n.name.as_deref().filter(|s| !s.trim().is_empty()) {
            line.push(' ');
            line.push_str(&json!(nm).to_string());
        }
        for p in &props {
            line.push_str(&format!(" [{p}]"));
        }
        if let Some(b) = n.bnid {
            ref_counter += 1;
            let t = format!("e{ref_counter}");
            refs.insert(t.clone(), b);
            line.push_str(&format!(" [ref={t}]"));
            if role == "iframe" {
                iframe_lines.push((lines.len(), t, b));
            }
        }
        lines.push(line);
        for cid in n.child_ids.iter().rev() {
            if let Some(&ci) = by_id.get(cid.as_str()) {
                stack.push((ci, depth + 1));
            }
        }
    }
    if lines.len() > MAX_SNAPSHOT_LINES {
        let extra = lines.len() - MAX_SNAPSHOT_LINES;
        lines.truncate(MAX_SNAPSHOT_LINES);
        lines.push(format!("... (snapshot truncated: {extra} more lines)"));
    }
    (lines, refs, iframe_lines)
}

/// Compact rendering of an AX property value for the `[name=value]`
/// bracket (numbers bare, strings JSON-quoted).
fn json_key(v: &Value) -> String {
    match v {
        Value::String(s) => json!(s).to_string(),
        other => other.to_string(),
    }
}

/// The recovered iframe-line rewrite: insert `[id="…"] [name="…"]`
/// before the `[ref=…]` token (attributes read live from the host).
async fn pw_host_attrs(conn: &CdpConn, session: &str, bnid: i64) -> Result<String, BrowserError> {
    let oid = pw_handle(conn, session, bnid).await?;
    let v = pw_call_value(
        conn,
        session,
        Some(&oid),
        "function(){ const g=[]; const id=this.getAttribute('id'); const nm=this.getAttribute('name'); if (id) g.push(`[id=${JSON.stringify(id)}]`); if (nm) g.push(`[name=${JSON.stringify(nm)}]`); return g.join(' '); }",
        None,
    )
    .await?;
    Ok(v.as_str().unwrap_or("").to_string())
}

impl PwRegistries {
    /// `playwright_dom_snapshot`: aria text with `[ref=eN]` tokens; the
    /// minted map replaces the tab's previous refs (the recovered
    /// `{dom_snapshot}` return shape).
    pub(crate) async fn pw_dom_snapshot(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let nodes = rt.ax.pw_ax_nodes(conn, session).await?;
        let (mut lines, refs, iframe_lines) = snapshot_lines(&nodes);
        for (li, token, bnid) in iframe_lines {
            let attrs = match pw_host_attrs(conn, session, bnid).await {
                Ok(a) if !a.is_empty() => a,
                _ => continue,
            };
            if let Some(pos) = lines[li].find(&format!(" [ref={token}]")) {
                lines[li].insert_str(pos, &format!(" {attrs}"));
            }
        }
        self.set_refs(&rec.tab_id, refs);
        Ok(json!({ "dom_snapshot": lines.join("\n") }))
    }
}

// ── playwright_evaluate ───────────────────────────────────────────────

impl PwRegistries {
    /// `playwright_evaluate` — MAIN-world script execution (the pinned
    /// law: model scripts see the page heap, not the tool world).
    /// Without a selector the script evaluates as a page expression;
    /// with one it is invoked as a function receiving the element
    /// (`selector_mode: "all"` maps to the per-element fan-out, an
    /// [adapted] equivalent of `locator.evaluateAll`).
    pub(crate) async fn pw_evaluate(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &EvaluatePayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        if p.script.trim().is_empty() {
            return Err(payload_invalid(
                "script",
                "playwright_evaluate requires a non-empty script",
            ));
        }
        let timeout = p.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let selector = match p.selector.as_deref() {
            None => {
                let v = pw_eval_main(conn, session, &p.script).await?;
                return Ok(json!({ "result": v }));
            }
            Some(s) => s,
        };
        let all = matches!(p.selector_mode, Some(SelectorMode::All));
        let nodes = if all {
            let deadline = Instant::now() + Duration::from_millis(timeout);
            loop {
                let found = self.pw_nodes(rt, conn, rec, selector).await?;
                if !found.is_empty() {
                    break found;
                }
                if Instant::now() >= deadline {
                    return Err(BrowserError::LocatorTimeout {
                        selector: selector.to_string(),
                        state: "attached".to_string(),
                        timeout_ms: timeout,
                    });
                }
                sleep_poll().await;
            }
        } else {
            vec![self.pw_strict_one(rt, conn, rec, selector, timeout).await?]
        };
        // [adapted]: the script string is evaluated once; if it
        // evaluates to a function it is called with the element as
        // both receiver and first argument, otherwise its value is
        // the result. Element handles are MAIN-world receivers.
        let decl = format!(
            "function(){{ const __fn = ({}); return (typeof __fn === 'function') ? __fn.call(this, this) : __fn; }}",
            p.script
        );
        let mut results = Vec::new();
        for b in nodes {
            let oid = pw_handle(conn, session, b).await?;
            let res = pw_call_raw(conn, session, Some(&oid), &decl, None, true).await?;
            results.push(pw_value_of(&res));
        }
        if all {
            Ok(json!({ "results": results }))
        } else {
            Ok(json!({ "result": results.pop().unwrap_or(Value::Null) }))
        }
    }
}

// ── playwright_element_info / element_screenshot ──────────────────────

const ELEMENT_INFO_JS: &str = r#"function(){
  const e = this;
  const tag = e.tagName.toLowerCase();
  const rect = e.getBoundingClientRect();
  const IMPLICIT = { a: e.href ? 'link' : null, button: 'button', select: 'combobox', textarea: 'textbox', details: 'group', img: 'img', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading' };
  const INPUT_ROLES = { text: 'textbox', email: 'textbox', search: 'searchbox', tel: 'tel', url: 'url', password: 'textbox', number: 'spinbutton', range: 'slider', checkbox: 'checkbox', radio: 'radio', file: 'button', submit: 'button', button: 'button', reset: 'button', color: 'button', date: 'textbox', time: 'textbox' };
  const role = e.getAttribute('role') || (tag === 'input' ? (INPUT_ROLES[e.type] || e.type) : (IMPLICIT[tag] || null));
  let aria = e.getAttribute('aria-label') || null;
  if (!aria) { const lb = e.getAttribute('aria-labelledby'); if (lb) aria = lb.split(/\s+/).map(i => document.getElementById(i)).filter(Boolean).map(x => x.textContent.trim()).join(' ') || null; }
  if (!aria) aria = e.getAttribute('alt') || e.getAttribute('title') || null;
  let vt = null;
  if (tag === 'input' && ['text','email','search','tel','url','password','number'].includes(e.type)) vt = e.value;
  else if (tag === 'select') vt = e.options[e.selectedIndex] ? e.options[e.selectedIndex].text : null;
  if (!vt) { const t = (e.innerText || e.textContent || '').trim(); if (t) vt = t.length > 200 ? t.slice(0, 200) : t; }
  const testId = e.getAttribute('data-testid') || e.getAttribute('data-test-id') || e.getAttribute('data-test') || null;
  const interactable = /^(a|button|input|select|textarea|summary)$/.test(tag) || e.getAttribute('role') !== null || e.hasAttribute('onclick') || e.hasAttribute('tabindex') || e.isContentEditable || (tag === 'a' && !!e.getAttribute('href'));
  const cands = [];
  if (e.id) cands.push('#' + CSS.escape(e.id));
  const nm = e.getAttribute('name');
  if (nm) cands.push(tag + '[name=' + JSON.stringify(nm) + ']');
  const path = [];
  let cur = e, d = 0;
  while (cur && cur.tagName && d < 5) {
    const par = cur.parentElement;
    if (!par) break;
    const sibs = Array.prototype.filter.call(par.children, c => c.tagName === cur.tagName);
    path.unshift(cur.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')' : ''));
    cur = par; d++;
  }
  if (path.length) cands.push(path.join(' > '));
  return {
    tag_name: tag,
    role,
    aria_name: aria,
    visible_text: vt,
    test_id: testId,
    preview: (e.outerHTML || '').replace(/\s+/g, ' ').slice(0, 160),
    interactable,
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    candidates: cands.slice(0, 6),
    primary: cands.length ? cands[0] : null
  };
}"#;

const HOST_SELECTOR_JS: &str = "function(){ const e=this; if (e.id) return '#'+CSS.escape(e.id); const p=e.parentElement; if (!p) return e.tagName.toLowerCase(); const sibs=Array.prototype.filter.call(p.children,c=>c.tagName===e.tagName); return e.tagName.toLowerCase()+(sibs.length>1?':nth-of-type('+(sibs.indexOf(e)+1)+')':''); }";

impl PwRegistries {
    /// `playwright_element_info`: hit-test with
    /// `DOM.getNodeForLocation` (probe-pinned: hit-tests INTO frames),
    /// walk the ancestor chain via `DOM.describeNode.parentId`, and
    /// return the recovered `ElementInfo` shape for each element
    /// (interactable-only unless `include_non_interactable`).
    pub(crate) async fn pw_element_info(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &ElementInfoPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let (x, y) = match (p.x, p.y) {
            (Some(x), Some(y)) => (x, y),
            _ => {
                return Err(payload_invalid(
                    "element_info",
                    "requires x and y (screenshot coordinates)",
                ))
            }
        };
        let hit = conn
            .call(
                "DOM.getNodeForLocation",
                Some(json!({
                    "x": x,
                    "y": y,
                    "includeUserActionShadow": false,
                    "fromPoint": false,
                })),
                Some(session),
            )
            .await;
        let hit = match hit {
            Ok(v) => v,
            Err(_) => return Ok(json!({ "x": x, "y": y, "elements": [] })),
        };
        let bnid = match hit.get("backendNodeId").and_then(Value::as_i64) {
            Some(b) => b,
            None => return Ok(json!({ "x": x, "y": y, "elements": [] })),
        };
        let hit_frame = hit
            .get("frameId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let mut chain: Vec<i64> = Vec::new();
        let mut describe = conn
            .call(
                "DOM.describeNode",
                Some(json!({ "backendNodeId": bnid })),
                Some(session),
            )
            .await?;
        for _ in 0..40 {
            let node = match describe.get("node") {
                Some(n) => n.clone(),
                None => break,
            };
            if node.get("nodeType").and_then(Value::as_i64) == Some(1) {
                if let Some(b) = node.get("backendNodeId").and_then(Value::as_i64) {
                    chain.push(b);
                }
            }
            match node.get("parentId").and_then(Value::as_i64) {
                Some(pid) => {
                    describe = conn
                        .call(
                            "DOM.describeNode",
                            Some(json!({ "nodeId": pid })),
                            Some(session),
                        )
                        .await?;
                }
                None => break,
            }
        }

        let include_all = p.include_non_interactable.unwrap_or(false);
        let mut elements: Vec<Value> = Vec::new();
        for b in &chain {
            let oid = pw_handle(conn, session, *b).await?;
            let info = pw_call_value(conn, session, Some(&oid), ELEMENT_INFO_JS, None).await?;
            if !include_all && info.get("interactable").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let mut e = info;
            e["node_id"] = json!(b);
            elements.push(e);
        }

        // Reshape flat JS info into the recovered ElementInfo shape
        // (selector object + snake_case bounding box) before the
        // frame-chain pass decorates `selector`.
        for e in &mut elements {
            let selector = json!({
                "candidates": e["candidates"].take(),
                "primary": e["primary"].take(),
            });
            e["selector"] = selector;
            e["bounding_box"] = e["box"].take();
            if let Some(o) = e.as_object_mut() {
                o.remove("candidates");
                o.remove("primary");
                o.remove("box");
                o.remove("interactable");
            }
        }
        // Frame chain (main → hit frame): host selectors for the
        // `enter-frame` prefix, attached to every candidate element
        // (all live in the hit frame).
        if !elements.is_empty() && !hit_frame.is_empty() {
            let (frames, _, parents) = pw_frame_tree(conn, session).await?;
            let mut chain_idx: Vec<usize> = Vec::new();
            if let Some(pos) = frames.iter().position(|f| f.frame_id == hit_frame) {
                let mut cur = Some(pos);
                while let Some(i) = cur {
                    chain_idx.push(i);
                    cur = parents[i];
                }
                chain_idx.reverse();
            }
            let mut frame_selectors: Vec<String> = Vec::new();
            for &fi in chain_idx.iter().skip(1) {
                let owner = conn
                    .call(
                        "DOM.getFrameOwner",
                        Some(json!({ "frameId": frames[fi].frame_id })),
                        Some(session),
                    )
                    .await
                    .ok()
                    .and_then(|v| v.get("backendNodeId").and_then(Value::as_i64));
                if let Some(ob) = owner {
                    if let Ok(oid) = pw_handle(conn, session, ob).await {
                        if let Ok(v) =
                            pw_call_value(conn, session, Some(&oid), HOST_SELECTOR_JS, None).await
                        {
                            if let Some(s) = v.as_str() {
                                frame_selectors.push(s.to_string());
                            }
                        }
                    }
                }
            }
            if !frame_selectors.is_empty() {
                for e in &mut elements {
                    e["selector"]["frame_selectors"] = json!(frame_selectors);
                    if let Some(primary) = e["selector"]["primary"].as_str() {
                        let mut full = frame_selectors.clone();
                        full.push(primary.to_string());
                        e["selector"]["primary"] = json!(full.join(ENTER_FRAME_SEP));
                    }
                }
            }
        }
        Ok(json!({ "x": x, "y": y, "elements": elements }))
    }

    /// `playwright_element_screenshot`: viewport, `clip`, or
    /// beyond-viewport full-page capture (payload-pinned: the target
    /// arrives as `clip`/`full_page`, [adapted] wire keys for the
    /// base64 image).
    pub(crate) async fn pw_element_screenshot(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &ScreenshotPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let mut params = json!({ "format": "png" });
        let mut size: Option<(f64, f64)> = None;
        if let Some(c) = &p.clip {
            params["clip"] = json!({
                "x": c.x,
                "y": c.y,
                "width": c.width,
                "height": c.height,
                "scale": 1,
            });
            size = Some((c.width, c.height));
        } else if p.full_page.unwrap_or(false) {
            let metrics = conn
                .call("Page.getLayoutMetrics", None, Some(session))
                .await?;
            let content = metrics
                .get("cssContentSize")
                .or_else(|| metrics.get("contentSize"))
                .cloned()
                .unwrap_or(json!({"width": 0, "height": 0}));
            let w = content.get("width").and_then(Value::as_f64).unwrap_or(0.0);
            let h = content.get("height").and_then(Value::as_f64).unwrap_or(0.0);
            params["clip"] = json!({ "x": 0, "y": 0, "width": w, "height": h, "scale": 1 });
            params["captureBeyondViewport"] = json!(true);
            size = Some((w, h));
        }
        let shot = conn
            .call("Page.captureScreenshot", Some(params), Some(session))
            .await?;
        let data = shot.get("data").and_then(Value::as_str).unwrap_or("");
        let mut out = json!({ "image_base64": data, "mime_type": "image/png" });
        if let Some((w, h)) = size {
            out["width"] = json!(w);
            out["height"] = json!(h);
        }
        Ok(out)
    }
}

// ── waitFor* family ───────────────────────────────────────────────────

fn load_state_str(s: LoadState) -> &'static str {
    match s {
        LoadState::Load => "load",
        LoadState::DomContentLoaded => "domcontentloaded",
        LoadState::NetworkIdle => "networkidle",
    }
}

fn ready_state_ok(want: LoadState, rs: &str) -> bool {
    match want {
        LoadState::Load => rs == "complete",
        LoadState::DomContentLoaded => rs == "interactive" || rs == "complete",
        LoadState::NetworkIdle => rs == "complete",
    }
}

impl PwRegistries {
    /// `playwright_wait_for_timeout` — a plain bounded sleep.
    pub(crate) async fn pw_wait_for_timeout(
        &self,
        p: &RequiredTimeoutPayload,
    ) -> Result<Value, BrowserError> {
        tokio::time::sleep(Duration::from_millis(p.timeout_ms)).await;
        Ok(json!({}))
    }

    /// `playwright_wait_for_load_state` — `document.readyState` polling;
    /// `networkidle` additionally requires the resource-timing entry
    /// count to hold still for the pinned 500 ms quiet window.
    pub(crate) async fn pw_wait_for_load_state(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &WaitForLoadStatePayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let state = p.state.unwrap_or(LoadState::Load);
        let timeout = p.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let what = format!("load state \"{}\"", load_state_str(state));
        let deadline = Instant::now() + Duration::from_millis(timeout);
        loop {
            let rs = pw_eval_main(conn, session, "document.readyState")
                .await?
                .as_str()
                .unwrap_or("loading")
                .to_string();
            let mut settled = ready_state_ok(state, &rs);
            if state == LoadState::NetworkIdle && settled {
                let c1 = pw_eval_main(
                    conn,
                    session,
                    "performance.getEntriesByType('resource').length",
                )
                .await?
                .as_u64()
                .unwrap_or(0);
                tokio::time::sleep(Duration::from_millis(NETWORK_IDLE_QUIET_MS)).await;
                let c2 = pw_eval_main(
                    conn,
                    session,
                    "performance.getEntriesByType('resource').length",
                )
                .await?
                .as_u64()
                .unwrap_or(0);
                settled = c1 == c2;
            }
            if settled {
                return Ok(json!({ "state": load_state_str(state) }));
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::PwTimeout {
                    what,
                    timeout_ms: timeout,
                });
            }
            sleep_poll().await;
        }
    }

    /// `playwright_wait_for_url` — exact match or `*`/`?` glob
    /// [adapted: minimal glob engine for Playwright string matchers],
    /// then the `wait_until` gate on `document.readyState`.
    pub(crate) async fn pw_wait_for_url(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &WaitForUrlPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let timeout = p.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let what = format!("navigation to \"{}\"", p.url);
        let deadline = Instant::now() + Duration::from_millis(timeout);
        loop {
            let href = pw_eval_main(conn, session, "location.href")
                .await?
                .as_str()
                .unwrap_or("")
                .to_string();
            if href == p.url || pw_glob(&p.url, &href) {
                let gate = match p.wait_until {
                    None | Some(crate::schemas::WaitUntil::Commit) => true,
                    Some(crate::schemas::WaitUntil::Load) => ready_state_ok(
                        LoadState::Load,
                        pw_readystate(conn, session).await?.as_str().unwrap_or(""),
                    ),
                    Some(crate::schemas::WaitUntil::DomContentLoaded) => ready_state_ok(
                        LoadState::DomContentLoaded,
                        pw_readystate(conn, session).await?.as_str().unwrap_or(""),
                    ),
                    Some(crate::schemas::WaitUntil::NetworkIdle) => {
                        pw_eval_main(conn, session, "document.readyState")
                            .await?
                            .as_str()
                            .unwrap_or("")
                            == "complete"
                    }
                };
                if gate {
                    return Ok(json!({ "url": href }));
                }
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::PwTimeout {
                    what,
                    timeout_ms: timeout,
                });
            }
            sleep_poll().await;
        }
    }
}

async fn pw_readystate(conn: &CdpConn, session: &str) -> Result<Value, BrowserError> {
    pw_eval_main(conn, session, "document.readyState").await
}

/// Minimal `*`/`?` glob matcher (full-string, no regex metacharacters
/// interpretation) for the URL string-matcher surface.
fn pw_glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    if !pattern.contains('*') && !pattern.contains('?') {
        return pattern == text;
    }
    fn m(p: &[char], t: &[char]) -> bool {
        match p.split_first() {
            None => t.is_empty(),
            Some(('*', rest)) => {
                for skip in 0..=t.len() {
                    if m(rest, &t[skip..]) {
                        return true;
                    }
                }
                false
            }
            Some((pc, rest)) => match t.split_first() {
                Some((tc, trest)) => (*pc == '?' || *pc == *tc) && m(rest, trest),
                None => false,
            },
        }
    }
    m(&p, &t)
}

// ── locator read surface ──────────────────────────────────────────────

impl PwRegistries {
    /// Strict single-element actionability prelude for every mutating
    /// locator command: wait-attached (poll), strict, visible+enabled,
    /// scrolled into view; returns the node and its MAIN-world handle.
    pub(crate) async fn pw_actionable(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        selector: &str,
        timeout_ms: u64,
    ) -> Result<(i64, String), BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let nodes = self.pw_nodes(rt, conn, rec, selector).await?;
            match nodes.len() {
                0 => {
                    if Instant::now() >= deadline {
                        return Err(BrowserError::LocatorTimeout {
                            selector: selector.to_string(),
                            state: "attached".to_string(),
                            timeout_ms,
                        });
                    }
                    sleep_poll().await;
                    continue;
                }
                n if n > 1 => {
                    return Err(BrowserError::LocatorStrict {
                        selector: selector.to_string(),
                        count: n,
                    })
                }
                _ => {}
            }
            let bnid = nodes[0];
            let oid = pw_handle(conn, session, bnid).await?;
            let visible = pw_pred(conn, session, &oid, VISIBLE_JS).await?;
            let enabled = pw_pred(conn, session, &oid, ENABLED_JS).await?;
            if visible && enabled {
                let _ = pw_scroll_into_view(conn, session, bnid).await;
                return Ok((bnid, oid));
            }
            let _ = pw_scroll_into_view(conn, session, bnid).await;
            if Instant::now() >= deadline {
                return Err(BrowserError::LocatorTimeout {
                    selector: selector.to_string(),
                    state: if visible { "enabled" } else { "visible" }.to_string(),
                    timeout_ms,
                });
            }
            sleep_poll().await;
        }
    }

    /// `playwright_locator_count` — no strict semantics, immediate.
    pub(crate) async fn pw_locator_count(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorPayload,
    ) -> Result<Value, BrowserError> {
        let n = self.pw_nodes(rt, conn, rec, &p.selector).await?.len();
        Ok(json!({ "count": n }))
    }

    /// `playwright_locator_all_text_contents` — `textContent` of every
    /// match (no strict semantics).
    pub(crate) async fn pw_locator_all_text_contents(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let nodes = self.pw_nodes(rt, conn, rec, &p.selector).await?;
        let mut texts = Vec::new();
        for b in nodes {
            let oid = pw_handle(conn, session, b).await?;
            let v = pw_call_value(
                conn,
                session,
                Some(&oid),
                "function(){ return this.textContent === null ? '' : this.textContent; }",
                None,
            )
            .await?;
            texts.push(v);
        }
        Ok(json!({ "texts": texts }))
    }

    /// `playwright_locator_read_all` — compact grounded rows for every
    /// match ([adapted]: preview shape; the reference names the
    /// command but its row schema is not recovered).
    pub(crate) async fn pw_locator_read_all(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorPayload,
    ) -> Result<Value, BrowserError> {
        const READ_ALL_JS: &str = r#"function(){
  const e = this;
  const out = { tag_name: e.tagName.toLowerCase() };
  for (const a of ['id','name','type','placeholder','role','href','src','alt','value']) {
    const v = a === 'value' ? e.value : e.getAttribute(a);
    if (v !== null && v !== undefined && v !== '') out[a] = v;
  }
  if (typeof e.checked === 'boolean') out.checked = e.checked;
  if (typeof e.disabled === 'boolean') out.disabled = e.disabled;
  const t = (e.textContent || '').trim();
  out.text = t.length > 1000 ? t.slice(0, 1000) : t;
  return out;
}"#;
        let session = rec.cdp_session_id.as_str();
        let nodes = self.pw_nodes(rt, conn, rec, &p.selector).await?;
        let mut rows = Vec::new();
        for b in nodes {
            let oid = pw_handle(conn, session, b).await?;
            rows.push(pw_call_value(conn, session, Some(&oid), READ_ALL_JS, None).await?);
        }
        Ok(json!({ "elements": rows }))
    }

    /// `playwright_locator_is_visible` — immediate, strict-violation
    /// honest, missing match answers false.
    pub(crate) async fn pw_locator_is_visible(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let nodes = self.pw_nodes(rt, conn, rec, &p.selector).await?;
        if nodes.is_empty() {
            return Ok(json!({ "visible": false }));
        }
        if nodes.len() > 1 {
            return Err(BrowserError::LocatorStrict {
                selector: p.selector.clone(),
                count: nodes.len(),
            });
        }
        let oid = pw_handle(conn, session, nodes[0]).await?;
        Ok(json!({ "visible": pw_pred(conn, session, &oid, VISIBLE_JS).await? }))
    }

    /// `playwright_locator_is_enabled` — same immediate strict shape.
    pub(crate) async fn pw_locator_is_enabled(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let nodes = self.pw_nodes(rt, conn, rec, &p.selector).await?;
        if nodes.is_empty() {
            return Ok(json!({ "enabled": false }));
        }
        if nodes.len() > 1 {
            return Err(BrowserError::LocatorStrict {
                selector: p.selector.clone(),
                count: nodes.len(),
            });
        }
        let oid = pw_handle(conn, session, nodes[0]).await?;
        Ok(json!({ "enabled": pw_pred(conn, session, &oid, ENABLED_JS).await? }))
    }

    /// `playwright_locator_get_attribute` — auto-waiting strict read.
    pub(crate) async fn pw_locator_get_attribute(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorNamePayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let bnid = self
            .pw_strict_one(rt, conn, rec, &p.selector, DEFAULT_TIMEOUT_MS)
            .await?;
        let oid = pw_handle(conn, session, bnid).await?;
        let v = pw_call_value(
            conn,
            session,
            Some(&oid),
            "function(n){ const v=this.getAttribute(n); return v === null ? null : v; }",
            Some(vec![json!(p.name)]),
        )
        .await?;
        Ok(json!({ "value": v }))
    }

    /// `playwright_locator_text_content` — auto-waiting strict read.
    pub(crate) async fn pw_locator_text_content(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let bnid = self
            .pw_strict_one(rt, conn, rec, &p.selector, DEFAULT_TIMEOUT_MS)
            .await?;
        let oid = pw_handle(conn, session, bnid).await?;
        let v = pw_call_value(
            conn,
            session,
            Some(&oid),
            "function(){ return this.textContent === null ? '' : this.textContent; }",
            None,
        )
        .await?;
        Ok(json!({ "text": v }))
    }

    /// `playwright_locator_inner_text` — auto-waiting strict read.
    pub(crate) async fn pw_locator_inner_text(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let bnid = self
            .pw_strict_one(rt, conn, rec, &p.selector, DEFAULT_TIMEOUT_MS)
            .await?;
        let oid = pw_handle(conn, session, bnid).await?;
        let v = pw_call_value(
            conn,
            session,
            Some(&oid),
            "function(){ return this.innerText !== undefined ? this.innerText : (this.textContent === null ? '' : this.textContent); }",
            None,
        )
        .await?;
        Ok(json!({ "text": v }))
    }
}

// ── locator action surface ────────────────────────────────────────────

const FILL_JS: &str = r#"function(v){
  if (this.focus) this.focus();
  if (this.isContentEditable) {
    const r = document.createRange(); r.selectNodeContents(this);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertText', false, v);
  } else if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
    this.value = v;
  } else {
    return 'not-editable';
  }
  this.dispatchEvent(new Event('input', {bubbles:true}));
  this.dispatchEvent(new Event('change', {bubbles:true}));
  return 'filled';
}"#;

const SELECT_JS: &str = r#"function(opts){
  if (this.tagName !== 'SELECT') return { error: 'target is not a <select>' };
  const arr = Array.prototype.slice.call(this.options);
  const picked = [];
  for (const o of opts) {
    let m = null;
    if (o.index !== null && o.index !== undefined) m = arr[o.index] || null;
    if (!m && o.any != null) m = arr.find(x => x.value === o.any || x.text.trim() === o.any) || null;
    if (!m && o.value != null) m = arr.find(x => x.value === o.value) || null;
    if (!m && o.label != null) m = arr.find(x => x.text.trim() === o.label) || null;
    if (!m) return { error: 'no matching option: ' + (o.value ?? o.label ?? String(o.index)) };
    if (!this.multiple) { this.selectedIndex = arr.indexOf(m); picked.push(m.value); break; }
    m.selected = true; picked.push(m.value);
  }
  this.dispatchEvent(new Event('input', {bubbles:true}));
  this.dispatchEvent(new Event('change', {bubbles:true}));
  return { ok: true, values: picked };
}"#;

/// One resolved logical key for `Input.dispatchKeyEvent` (Playwright
/// key grammar: named keys plus single characters; printable keys carry
/// `text` and ride the rawKeyDown→char→keyUp sequence).
struct PwKey {
    key: String,
    code: Option<String>,
    vk: Option<u32>,
    text: Option<String>,
}

fn pw_key_spec(raw: &str) -> Option<PwKey> {
    let named: &[(&str, u32)] = &[
        ("Enter", 13),
        ("Tab", 9),
        ("Escape", 27),
        ("Backspace", 8),
        ("Delete", 46),
        ("Insert", 45),
        ("Home", 36),
        ("End", 35),
        ("PageUp", 33),
        ("PageDown", 34),
        ("ArrowLeft", 37),
        ("ArrowUp", 38),
        ("ArrowRight", 39),
        ("ArrowDown", 40),
    ];
    if raw == "Space" {
        return Some(PwKey {
            key: " ".to_string(),
            code: Some("Space".to_string()),
            vk: Some(32),
            text: Some(" ".to_string()),
        });
    }
    if let Some(f) = raw.strip_prefix('F') {
        if let Ok(n) = f.parse::<u32>() {
            if (1..=12).contains(&n) {
                return Some(PwKey {
                    key: format!("F{n}"),
                    code: Some(format!("F{n}")),
                    vk: Some(111 + n),
                    text: None,
                });
            }
        }
    }
    for (name, vk) in named {
        if raw == *name {
            return Some(PwKey {
                key: (*name).to_string(),
                code: Some((*name).to_string()),
                vk: Some(*vk),
                text: None,
            });
        }
    }
    let mut it = raw.chars();
    let (Some(c), None) = (it.next(), it.next()) else {
        return None;
    };
    let code = match c {
        'a'..='z' | 'A'..='Z' => Some(format!("Key{}", c.to_ascii_uppercase())),
        '0'..='9' => Some(format!("Digit{c}")),
        _ => None,
    };
    let vk = match c {
        'a'..='z' | 'A'..='Z' => Some(c.to_ascii_uppercase() as u32),
        '0'..='9' => Some(c as u32),
        _ => None,
    };
    Some(PwKey {
        key: c.to_string(),
        code,
        vk,
        text: Some(c.to_string()),
    })
}

/// Modifier bit accumulation for `Input.dispatchKeyEvent`.
fn combo_mask(mods: &[&str]) -> Result<u32, BrowserError> {
    let mut m = 0u32;
    for md in mods {
        m |= match *md {
            "Alt" => 1,
            "Control" | "ControlOrMeta" | "Ctrl" => 2,
            "Meta" | "Command" | "Super" => 4,
            "Shift" => 8,
            other => {
                return Err(payload_invalid(
                    "key",
                    format!("unknown modifier \"{other}\" in the key combo"),
                ))
            }
        };
    }
    Ok(m)
}

impl PwRegistries {
    /// `playwright_locator_fill` — actionability prelude, then focus +
    /// value set + `input`/`change` events (the pinned Playwright fill
    /// behavior; not trusted key input by design).
    pub(crate) async fn pw_locator_fill(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorValuePayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let (_bnid, oid) = self
            .pw_actionable(rt, conn, rec, &p.selector, DEFAULT_TIMEOUT_MS)
            .await?;
        let v = pw_call_value(
            conn,
            session,
            Some(&oid),
            FILL_JS,
            Some(vec![json!(p.value)]),
        )
        .await?;
        if v.as_str() == Some("not-editable") {
            return Err(BrowserError::LocatorFailed {
                selector: p.selector.clone(),
                reason: "fill targets an <input>, <textarea> or contenteditable only".to_string(),
            });
        }
        Ok(json!({}))
    }

    /// `playwright_locator_press` — focus the resolved element, then
    /// real `Input.dispatchKeyEvent` traffic (named keys, single
    /// characters, and `Modifier+Key` combos).
    pub(crate) async fn pw_locator_press(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorKeyPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let (_bnid, oid) = self
            .pw_actionable(rt, conn, rec, &p.selector, DEFAULT_TIMEOUT_MS)
            .await?;
        pw_call_raw(conn, session, Some(&oid), FOCUS_JS, None, false).await?;
        let (base, mods) = match p.key.rsplit_once('+') {
            Some((m, k)) if !m.is_empty() && !k.is_empty() => (k, m),
            _ => (p.key.as_str(), ""),
        };
        let parts: Vec<&str> = if mods.is_empty() {
            Vec::new()
        } else {
            mods.split('+').collect()
        };
        let mask = combo_mask(&parts)?;
        let spec = pw_key_spec(base)
            .ok_or_else(|| payload_invalid("key", format!("unknown key \"{}\"", p.key)))?;
        pw_send_key(conn, session, &spec, mask, p.delay.unwrap_or(0)).await?;
        Ok(json!({}))
    }

    /// `playwright_locator_press_sequentially` — focus, then one
    /// `Input.insertText` per character (real renderer-side input,
    /// probe-equivalent to the keyDown/char/keyUp triple that reaches
    /// inner-frame inputs), with `delay` between characters.
    pub(crate) async fn pw_locator_press_sequentially(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorTextPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let (_bnid, oid) = self
            .pw_actionable(rt, conn, rec, &p.selector, DEFAULT_TIMEOUT_MS)
            .await?;
        pw_call_raw(conn, session, Some(&oid), FOCUS_JS, None, false).await?;
        let delay = p.delay.unwrap_or(0);
        for ch in p.text.chars() {
            if ch == '\n' || ch == '\r' {
                let spec = PwKey {
                    key: "Enter".to_string(),
                    code: Some("Enter".to_string()),
                    vk: Some(13),
                    text: None,
                };
                pw_send_key(conn, session, &spec, 0, 0).await?;
            } else {
                conn.call(
                    "Input.insertText",
                    Some(json!({ "text": ch.to_string() })),
                    Some(session),
                )
                .await?;
            }
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
        }
        Ok(json!({}))
    }

    /// `playwright_locator_select_option` — actionability, then in-page
    /// option matching by index, exact value/label, or value-or-label
    /// (string form), with `input`/`change` dispatch.
    pub(crate) async fn pw_locator_select_option(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorSelectPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let (_bnid, oid) = self
            .pw_actionable(rt, conn, rec, &p.selector, DEFAULT_TIMEOUT_MS)
            .await?;
        let opt_json = |s: &SelectOptionSingle| json!({ "index": s.index, "label": s.label, "value": s.value });
        let opts: Vec<Value> = match &p.option {
            SelectOptionInput::Many(list) => list
                .iter()
                .map(|o| match o {
                    SelectOptionOne::Single(s) => opt_json(s),
                    SelectOptionOne::Text(t) => json!({ "any": t }),
                })
                .collect(),
            SelectOptionInput::Single(s) => vec![opt_json(s)],
            SelectOptionInput::Text(t) => vec![json!({ "any": t })],
        };
        let v = pw_call_value(
            conn,
            session,
            Some(&oid),
            SELECT_JS,
            Some(vec![json!(opts)]),
        )
        .await?;
        if let Some(err) = v.get("error").and_then(Value::as_str) {
            return Err(BrowserError::LocatorFailed {
                selector: p.selector.clone(),
                reason: err.to_string(),
            });
        }
        Ok(json!({ "selected_values": v.get("values").cloned().unwrap_or(json!([])) }))
    }

    /// `playwright_locator_set_checked` — actionability, then a real
    /// trusted click only when the state differs, verified afterwards.
    pub(crate) async fn pw_locator_set_checked(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorCheckedPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let (_bnid, oid) = self
            .pw_actionable(rt, conn, rec, &p.selector, DEFAULT_TIMEOUT_MS)
            .await?;
        if pw_pred(conn, session, &oid, CHECKED_JS).await? == p.checked {
            return Ok(json!({ "checked": p.checked }));
        }
        let click = LocatorClickPayload {
            browser_id: p.browser_id.clone(),
            tab_id: p.tab_id.clone(),
            selector: p.selector.clone(),
            button: None,
            click_count: None,
            force: None,
            modifiers: None,
            timeout_ms: None,
        };
        self.pw_locator_click(rt, conn, rec, &click, false).await?;
        let bnid = self
            .pw_strict_one(rt, conn, rec, &p.selector, 2_000)
            .await?;
        let oid = pw_handle(conn, session, bnid).await?;
        let now = pw_pred(conn, session, &oid, CHECKED_JS).await?;
        if now != p.checked {
            return Err(BrowserError::LocatorFailed {
                selector: p.selector.clone(),
                reason: "checked state did not change after the click".to_string(),
            });
        }
        Ok(json!({ "checked": now }))
    }

    /// `playwright_locator_wait_for` — attached/detached/visible/hidden
    /// polling with the pinned timeout grammar.
    pub(crate) async fn pw_locator_wait_for(
        &self,
        rt: &BrowserRuntime,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &LocatorWaitPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let timeout = p.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let label = match p.state {
            WaitForState::Attached => "attached",
            WaitForState::Detached => "detached",
            WaitForState::Visible => "visible",
            WaitForState::Hidden => "hidden",
        };
        let deadline = Instant::now() + Duration::from_millis(timeout);
        loop {
            let nodes = self.pw_nodes(rt, conn, rec, &p.selector).await?;
            let done = match p.state {
                WaitForState::Attached => !nodes.is_empty(),
                WaitForState::Detached => nodes.is_empty(),
                WaitForState::Visible => {
                    if nodes.len() > 1 {
                        return Err(BrowserError::LocatorStrict {
                            selector: p.selector.clone(),
                            count: nodes.len(),
                        });
                    }
                    if nodes.is_empty() {
                        false
                    } else {
                        let oid = pw_handle(conn, session, nodes[0]).await?;
                        pw_pred(conn, session, &oid, VISIBLE_JS).await?
                    }
                }
                WaitForState::Hidden => {
                    if nodes.is_empty() {
                        true
                    } else {
                        let mut all_hidden = true;
                        for b in nodes {
                            if let Ok(oid) = pw_handle(conn, session, b).await {
                                if pw_pred(conn, session, &oid, VISIBLE_JS).await? {
                                    all_hidden = false;
                                    break;
                                }
                            }
                        }
                        all_hidden
                    }
                }
            };
            if done {
                return Ok(json!({ "state": label }));
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::LocatorTimeout {
                    selector: p.selector.clone(),
                    state: label.to_string(),
                    timeout_ms: timeout,
                });
            }
            sleep_poll().await;
        }
    }
}

/// keyDown → [char] → keyUp for printable keys; keyDown → keyUp for
/// named keys, with the optional down→up `delay`.
async fn pw_send_key(
    conn: &CdpConn,
    session: &str,
    spec: &PwKey,
    modifiers: u32,
    delay: u64,
) -> Result<(), BrowserError> {
    let mut down = json!({
        "type": if spec.text.is_some() { "rawKeyDown" } else { "keyDown" },
        "key": &spec.key,
        "modifiers": modifiers,
    });
    if let Some(c) = &spec.code {
        down["code"] = json!(c);
    }
    if let Some(vk) = spec.vk {
        down["windowsVirtualKeyCode"] = json!(vk);
        down["nativeVirtualKeyCode"] = json!(vk);
    }
    if let Some(t) = &spec.text {
        down["text"] = json!(t);
    }
    conn.call("Input.dispatchKeyEvent", Some(down), Some(session))
        .await?;
    if let Some(t) = &spec.text {
        conn.call(
            "Input.dispatchKeyEvent",
            Some(json!({ "type": "char", "key": &spec.key, "text": t, "modifiers": modifiers })),
            Some(session),
        )
        .await?;
    }
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let mut up = json!({
        "type": "keyUp",
        "key": &spec.key,
        "modifiers": modifiers,
    });
    if let Some(c) = &spec.code {
        up["code"] = json!(c);
    }
    if let Some(vk) = spec.vk {
        up["windowsVirtualKeyCode"] = json!(vk);
        up["nativeVirtualKeyCode"] = json!(vk);
    }
    conn.call("Input.dispatchKeyEvent", Some(up), Some(session))
        .await
        .map(|_| ())
}

// ── unit tests (pure logic; CDP behavior is probe-verified) ──────────

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(selector: &str) -> Vec<Vec<Seg>> {
        parse_selector(selector).unwrap()
    }

    #[test]
    fn plain_css_is_one_group() {
        assert_eq!(segs("button.go"), vec![vec![Seg::Css("button.go".into())]]);
        assert_eq!(segs("css:div > p"), vec![vec![Seg::Css("div > p".into())]]);
    }

    #[test]
    fn aria_ref_token() {
        assert_eq!(segs("aria-ref=e7"), vec![vec![Seg::Ref("e7".into())]]);
    }

    #[test]
    fn enter_frame_pinned_literal_splits_groups() {
        let parsed = segs("iframe#outer >> internal:control=enter-frame >> button");
        assert_eq!(
            parsed,
            vec![
                vec![Seg::Css("iframe#outer".into())],
                vec![Seg::Css("button".into())]
            ]
        );
    }

    #[test]
    fn chain_separator_respects_quotes_and_parens() {
        // The ` >> ` inside the parens must NOT split the segment.
        let parsed = segs(":has-text(\"a >> b\")");
        assert_eq!(parsed.len(), 1);
        // `[role=button]` keeps its head (`[` head, not an engine).
        assert_eq!(
            segs("[role=button]"),
            vec![vec![Seg::Css("[role=button]".into())]]
        );
    }

    #[test]
    fn unsupported_engines_reject_honestly() {
        for e in [
            "text=hi",
            "nth=0",
            "visible=true",
            "internal:foo",
            "js:el=>1",
        ] {
            let err = parse_selector(e).unwrap_err().to_string();
            assert!(
                err.contains("locator engine") || err.contains("unsupported locator engine"),
                "{e}"
            );
        }
        // Playwright parity: `xpath://*` has no `=` engine form, so it
        // stays a CSS selector and fails at query time, not parse time.
        assert_eq!(
            parse_selector("xpath://*").unwrap()[0][0],
            Seg::Css("xpath://*".into())
        );
        // the bare enter-frame fragment (not joined around it) is the
        // `internal` engine → honest rejection
        assert!(parse_selector("internal:control=enter-frame").is_err());
    }

    #[test]
    fn empty_chain_sides_rejected() {
        assert!(parse_selector("button >> ").is_err());
        assert!(parse_selector(" >> button").is_err());
        assert!(parse_selector(&format!(" >> {ENTER_FRAME_SEP} button")).is_err());
    }

    fn axn(
        id: &str,
        ignored: bool,
        role: &str,
        name: Option<&str>,
        children: &[&str],
        bnid: Option<i64>,
    ) -> PwAxNode {
        PwAxNode {
            node_id: id.into(),
            ignored,
            role: role.into(),
            name: name.map(str::to_string),
            props: Vec::new(),
            child_ids: children.iter().map(|c| (*c).to_string()).collect(),
            bnid,
        }
    }

    #[test]
    fn snapshot_renders_refs_and_hoists_ignored_generic() {
        let nodes = vec![
            axn("1", false, "RootWebArea", None, &["2"], None),
            axn("2", false, "generic", None, &["3"], None),
            axn("3", false, "button", Some("Submit"), &[], Some(41)),
            axn("4", true, "LayoutObject", None, &["5"], None),
            axn("5", false, "StaticText", Some("hi"), &[], Some(42)),
        ];
        let (lines, refs, iframe_lines) = snapshot_lines(&nodes);
        assert!(iframe_lines.is_empty());
        assert_eq!(lines[0], "- button \"Submit\" [ref=e1]");
        assert_eq!(lines[1], "- text \"hi\" [ref=e2]");
        assert_eq!(refs.get("e1"), Some(&41));
        assert_eq!(refs.get("e2"), Some(&42));
    }

    #[test]
    fn snapshot_keeps_named_generic_and_props() {
        let mut n = axn("1", false, "RootWebArea", None, &["2"], None);
        let mut g = axn("2", false, "generic", Some("wrapper"), &["3"], Some(9));
        g.props = vec![
            ("level".into(), json!(2)),
            ("disabled".into(), json!(false)),
        ];
        n.child_ids = vec!["2".into()];
        let c3 = axn("3", false, "heading", Some("T"), &[], Some(10));
        let tree = vec![n, g, c3];
        let (lines, refs, _) = snapshot_lines(&tree);
        assert_eq!(lines[0], "- generic \"wrapper\" [level=2] [ref=e1]");
        assert_eq!(lines[1], "  - heading \"T\" [ref=e2]");
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn key_specs_and_globs() {
        assert_eq!(pw_key_spec("Enter").unwrap().vk, Some(13));
        assert_eq!(pw_key_spec("a").unwrap().code, Some("KeyA".to_string()));
        assert_eq!(pw_key_spec("F5").unwrap().vk, Some(116));
        assert_eq!(pw_key_spec("Space").unwrap().text.as_deref(), Some(" "));
        assert!(pw_key_spec("Bogus").is_none());
        assert!(pw_glob("https://ex.com/*", "https://ex.com/a/b"));
        assert!(!pw_glob("https://ex.com/a", "https://ex.com/ab"));
        assert!(pw_glob("exact", "exact"));
        assert!(!pw_glob("exact", "exactly"));
    }

    #[test]
    fn combo_masks() {
        assert_eq!(combo_mask(&["Control", "Shift"]).unwrap(), 10);
        assert!(combo_mask(&["Nope"]).is_err());
    }
}
