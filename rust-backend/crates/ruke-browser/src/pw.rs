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
// Phase 2 (plan): the locator ACT payload imports left with the
// actuators that moved to `bridge.rs`; observation/wait payload
// schemas stay here.
use crate::schemas::{
    DomSnapshotPayload, ElementInfoPayload, EvaluatePayload, LoadState, LocatorNamePayload,
    LocatorPayload, LocatorWaitPayload, RequiredTimeoutPayload, ScreenshotPayload, SelectorMode,
    WaitForLoadStatePayload, WaitForState, WaitForUrlPayload,
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

/// Per-tab locator registries: every tab-removal path and shutdown
/// calls `forget_tab`/`clear_all`.
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
        // Page.Frame spells its identifier `id` (the `frameId` spelling
        // belongs to Page.* EVENTS, not this object — ax.rs/dom_cua.rs
        // already read `id`; pw_frame_tree had it wrong and silently
        // dropped every frame). `frameId` kept as a defensive fallback.
        let Some(frame_id) = frame
            .get("id")
            .or_else(|| frame.get("frameId"))
            .and_then(Value::as_str)
        else {
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
                                    // An evaluation exception must fail
                                    // loudly — never degrade to "0 nodes"
                                    // and masquerade as an attach timeout.
                                    if let Some(e) = pw_exception_reason(&res, "Runtime.evaluate") {
                                        return Err(e);
                                    }
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

pub(crate) async fn pw_handle(
    conn: &CdpConn,
    session: &str,
    bnid: i64,
) -> Result<String, BrowserError> {
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
        // Callers pass RAW values; the protocol demands CallArgument
        // objects ({value: …}). Wrapping here keeps every call site
        // honest and the protocol shape pinned in one place.
        params["arguments"] = Value::Array(a.into_iter().map(|v| json!({ "value": v })).collect());
    }
    let res = conn
        .call("Runtime.callFunctionOn", Some(params), Some(session))
        .await?;
    if let Some(e) = pw_exception_reason(&res, "Runtime.callFunctionOn") {
        return Err(e);
    }
    Ok(res)
}

pub(crate) async fn pw_call_value(
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

/// Invokes a function-declaration body in the session's MAIN world with
/// no receiver (`Runtime.evaluate`: `(function(){...})(args)`).
/// `Runtime.callFunctionOn` requires a receiver (`objectId` /
/// `executionContextId`); page glue that only touches `document` /
/// `window` — the pin probe's title read/write — has none, so it goes
/// here instead. (Root-caused live: a receiver-less `callFunctionOn`
/// is rejected with "Either objectId or executionContextId or
/// uniqueContextId must be specified".)
pub(crate) async fn pw_eval_fn(
    conn: &CdpConn,
    session: &str,
    function_decl: &str,
    args: &[Value],
) -> Result<Value, BrowserError> {
    pw_eval_main(conn, session, &pw_eval_fn_expr(function_decl, args)).await
}

/// The receiver-less IIFE expression: arguments are inlined as compact
/// JSON literals — `Value`'s Display always emits escaped, parseable
/// JSON, so an injected title can never break out of its literal.
fn pw_eval_fn_expr(function_decl: &str, args: &[Value]) -> String {
    let argv: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    format!("({function_decl})({})", argv.join(","))
}

// ── Element predicates & geometry ─────────────────────────────────────

const VISIBLE_JS: &str = r"function(){ if (!this.isConnected) return false; const r = this.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(this); if (cs.visibility === 'hidden' || cs.display === 'none') return false; return true; }";
const ENABLED_JS: &str = "function(){ return !this.disabled; }";
// Phase 2 (plan): `CHECKED_JS`/`FOCUS_JS` retired with the locator
// action actuators — the bridge keeps its own checked/focus helpers
// for the read-backs it still performs natively.

async fn pw_pred(
    conn: &CdpConn,
    session: &str,
    object_id: &str,
    js: &str,
) -> Result<bool, BrowserError> {
    let v = pw_call_value(conn, session, Some(object_id), js, None).await?;
    Ok(v.as_bool().unwrap_or(false))
}

/// CDP input hit-testing is pixel-cell based: the dispatched float x/y is
/// first rounded to an integer, and the event goes to whatever intersects
/// that pixel cell (Phase-26 gap battery, live Chromium: a 1×1 target at
/// x=8..9 receives nothing at the 8.5 box centre — dispatching x=8 lands
/// the click). Pick the centre-rounded coordinate when its cell
/// intersects the box; the centre's floor cell always does.
fn dispatch_point(center: f64, min: f64, max: f64) -> f64 {
    let r = center.round();
    if r >= min && r < max {
        return r;
    }
    let f = center.floor();
    if f >= min && f < max {
        return f;
    }
    if r < max {
        r
    } else {
        f
    }
}

/// Page-space click point, dispatch-snapped (see `dispatch_point`);
/// hidden nodes surface as `None` (the pinned "Could not compute box
/// model" protocol failure is the signal).
pub(crate) async fn pw_box_center(
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
    let xs = [nums[0], nums[2], nums[4], nums[6]];
    let ys = [nums[1], nums[3], nums[5], nums[7]];
    let l = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let r = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let t = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let b = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let cx = (xs[0] + xs[1] + xs[2] + xs[3]) / 4.0;
    let cy = (ys[0] + ys[1] + ys[2] + ys[3]) / 4.0;
    Ok(Some((dispatch_point(cx, l, r), dispatch_point(cy, t, b))))
}

pub(crate) async fn pw_scroll_into_view(
    conn: &CdpConn,
    session: &str,
    bnid: i64,
) -> Result<(), BrowserError> {
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
/// Coordinates are sent as integers: CDP rounds floats to the hit-test
/// pixel cell itself (Phase-26 battery), and snapping the same value
/// here keeps what we send and what Chromium hit-tests identical.
pub(crate) async fn pw_dispatch_click(
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
                    "x": x.round(),
                    "y": y.round(),
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

// Phase 2 (plan): the locator CLICK actuator lives in `bridge.rs` —
// MCP `browser_click` for plain-CSS main-frame targets, MCP
// coordinate clicks for everything the selector cannot address
// directly. The actionability/strictness pre-resolution it builds on
// (`pw_actionable`/`pw_strict_one`) stays here, so typed locator
// errors and waits are unchanged. `button_str`/`modifier_mask` left
// with it (the bridge maps the same typed enums to MCP arguments).

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
/// `snapshot_lines` result: (rendered lines, aria-ref → backendNodeId
/// map, iframe host-attr splices: line index, ref token, backendNodeId).
type SnapshotRender = (Vec<String>, HashMap<String, i64>, Vec<(usize, String, i64)>);

fn snapshot_lines(nodes: &[PwAxNode]) -> SnapshotRender {
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
    /// `{dom_snapshot}` return shape). Phase 1 targeted reads: `search` /
    /// line windows slice the tree instead of dumping the whole page, and
    /// refs mint from the FULL tree, so every returned line stays directly
    /// actionable for `locator_*` even when the caller only sees a slice.
    pub(crate) async fn pw_dom_snapshot(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &DomSnapshotPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let nodes = crate::ax::pw_ax_nodes(conn, session).await?;
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

        let total = lines.len();
        let offset = p.offset_lines.unwrap_or(0);
        let limit = p.limit_lines.unwrap_or(DEFAULT_SNAPSHOT_LIMIT_LINES);
        let needle = p
            .search
            .as_deref()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        let matched: Vec<usize> = match &needle {
            Some(n) => (0..total)
                .filter(|&i| lines[i].to_lowercase().contains(n))
                .collect(),
            None => (0..total).collect(),
        };
        let window: Vec<String> = matched
            .iter()
            .skip(offset)
            .take(limit)
            .map(|&i| lines[i].clone())
            .collect();
        let truncated = offset + window.len() < matched.len();
        let mut out = json!({ "dom_snapshot": window.join("\n") });
        if needle.is_some() || offset > 0 || truncated {
            // Retrieval metadata: the model is told what was NOT shown and
            // exactly how to ask for the rest — never silently truncated.
            out["snapshot_meta"] = json!({
                "total_lines": total,
                "matched_lines": matched.len(),
                "offset_lines": offset,
                "returned_lines": window.len(),
                "truncated": truncated,
                "next_offset_lines": if truncated {
                    json!(offset + window.len())
                } else {
                    Value::Null
                },
            });
        }
        Ok(out)
    }
}

/// Model-visible aria snapshots cap at this many lines unless the caller
/// asks otherwise; overflow reports itself via `snapshot_meta` with the
/// exact `next_offset_lines` to continue from.
const DEFAULT_SNAPSHOT_LIMIT_LINES: usize = 500;

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
                    // CDP declares x/y as INTEGERS — fractional CSS pixels
                    // (what screenshots/rects actually give) fail parameter
                    // validation, so the hit point is rounded to device
                    // pixels before the call.
                    "x": x.round() as i64,
                    "y": y.round() as i64,
                    "includeUserAgentShadowDOM": false,
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

    /// `playwright_element_screenshot` / `tab_screenshot`: viewport, `clip`,
    /// element-`selector`, or beyond-viewport full-page capture.
    /// Phase 1 safe transport (payload-pinned, [adapted] wire keys):
    /// `format`/`quality`/`max_dim` let the caller request a capture a small
    /// vision model can actually afford (jpeg + CDP clip-scale downscale —
    /// no image re-encode, no new dependency), `selector` finally honors the
    /// element crop the tool schema always advertised (main frame), and every
    /// capture answers with tab/frame/viewport/scale/crop metadata so the
    /// model knows exactly where the pixels came from.
    pub(crate) async fn pw_element_screenshot(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        p: &ScreenshotPayload,
    ) -> Result<Value, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let format = match p
            .format
            .as_deref()
            .map(|f| f.to_ascii_lowercase())
            .as_deref()
        {
            None | Some("png") => "png",
            Some("jpeg") | Some("jpg") => "jpeg",
            Some(other) => {
                return Err(BrowserError::PayloadInvalid {
                    command: "tab_screenshot".to_string(),
                    reason: format!(
                        "unknown screenshot format {other:?} (use \"png\" or \"jpeg\")"
                    ),
                })
            }
        };
        let quality = p.quality.unwrap_or(75).clamp(1, 100);

        // Live viewport/page metrics — needed for max_dim on a bare viewport
        // capture, and reported as metadata either way. A dead renderer fails
        // the capture anyway, so a metrics failure only omits metadata.
        let metrics = pw_eval_main(
            conn,
            session,
            "JSON.stringify({iw:window.innerWidth,ih:window.innerHeight,dpr:window.devicePixelRatio||1,sx:window.scrollX,sy:window.scrollY,cw:document.documentElement.scrollWidth,ch:document.documentElement.scrollHeight})",
        )
        .await
        .ok()
        .and_then(|v| {
            v.as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
        })
        .filter(|v| v.is_object());
        let m_f = |k: &str| metrics.as_ref().and_then(|m| m[k].as_f64()).unwrap_or(0.0);

        // Crop region in page-absolute CSS coords: explicit clip wins, then
        // the selector element's rect, then the full page, then (only when
        // max_dim needs a downscale) the visible viewport itself.
        let mut crop: Option<(f64, f64, f64, f64)> = None;
        let mut selector_hit: Option<(f64, f64, f64, f64)> = None;
        if let Some(c) = &p.clip {
            crop = Some((c.x, c.y, c.width, c.height));
        } else if let Some(sel) = &p.selector {
            let expr = format!(
                "(() => {{ const el = document.querySelector({}); if (!el) return null; const r = el.getBoundingClientRect(); return {{ x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }}; }})()",
                serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".to_string())
            );
            let v = pw_eval_main(conn, session, &expr).await?;
            match v.as_object().filter(|o| !o.is_empty()) {
                Some(r) => {
                    let rect = (
                        r["x"].as_f64().unwrap_or(0.0),
                        r["y"].as_f64().unwrap_or(0.0),
                        r["width"].as_f64().unwrap_or(0.0),
                        r["height"].as_f64().unwrap_or(0.0),
                    );
                    if rect.2 <= 0.0 || rect.3 <= 0.0 {
                        return Err(BrowserError::PayloadInvalid {
                            command: "playwright_element_screenshot".to_string(),
                            reason: format!(
                                "selector {sel:?} matched an element with an empty box; take a fresh playwright_dom_snapshot or pick another selector"
                            ),
                        });
                    }
                    crop = Some(rect);
                    selector_hit = Some(rect);
                }
                None => {
                    return Err(BrowserError::PayloadInvalid {
                        command: "playwright_element_screenshot".to_string(),
                        reason: format!(
                            "selector {sel:?} matched no element in the main frame; take a fresh playwright_dom_snapshot"
                        ),
                    })
                }
            }
        } else if p.full_page.unwrap_or(false) {
            let lm = conn
                .call("Page.getLayoutMetrics", None, Some(session))
                .await?;
            let content = lm
                .get("cssContentSize")
                .or_else(|| lm.get("contentSize"))
                .cloned()
                .unwrap_or(json!({"width": 0, "height": 0}));
            crop = Some((
                0.0,
                0.0,
                content.get("width").and_then(Value::as_f64).unwrap_or(0.0),
                content.get("height").and_then(Value::as_f64).unwrap_or(0.0),
            ));
        } else if let Some(md) = p.max_dim.filter(|d| *d > 0) {
            let (iw, ih) = (m_f("iw"), m_f("ih"));
            if iw.max(ih) > f64::from(md) {
                // Downscale the visible viewport: its page-absolute rect is
                // the current scroll origin.
                crop = Some((m_f("sx"), m_f("sy"), iw, ih));
            }
        }

        // Applied downscale (CDP clip scale encodes it — no re-encode pass).
        let mut scale = 1.0f64;
        if let (Some(md), Some((_, _, w, h))) = (p.max_dim.filter(|d| *d > 0), crop) {
            let longest = w.max(h);
            if longest > 1.0 {
                scale = (f64::from(md) / longest).clamp(0.01, 1.0);
            }
        }

        let mut params = json!({ "format": format });
        if format == "jpeg" {
            params["quality"] = json!(quality);
        }
        if let Some((x, y, w, h)) = crop {
            params["clip"] = json!({ "x": x, "y": y, "width": w, "height": h, "scale": scale });
            params["captureBeyondViewport"] = json!(true);
        }
        let shot = conn
            .call("Page.captureScreenshot", Some(params), Some(session))
            .await?;
        let data = shot.get("data").and_then(Value::as_str).unwrap_or("");

        let mut out = json!({
            "image_base64": data,
            "mime_type": if format == "jpeg" { "image/jpeg" } else { "image/png" },
            "tab_id": rec.tab_id,
            "frame": "main",
            "format": format,
            "scale": scale,
            "full_page": p.full_page.unwrap_or(false),
            "captured_at_ms": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
        if let Some((x, y, w, h)) = crop {
            out["width"] = json!(w);
            out["height"] = json!(h);
            out["crop"] = json!({ "x": x, "y": y, "width": w, "height": h });
            out["image_width"] = json!((w * scale).max(1.0).round() as u64);
            out["image_height"] = json!((h * scale).max(1.0).round() as u64);
        } else if m_f("iw") > 0.0 && m_f("ih") > 0.0 {
            // Uncropped full-surface capture: Chromium composites the
            // viewport at the device pixel ratio (no clip ⇒ no scale).
            let dpr = m_f("dpr").max(1.0);
            out["image_width"] = json!((m_f("iw") * dpr).max(1.0).round() as u64);
            out["image_height"] = json!((m_f("ih") * dpr).max(1.0).round() as u64);
        }
        // Honest pixels beat predicted pixels (live-caught: a 138.625 px
        // fractional clip rasterizes to 138 real pixels while `round()`
        // claims 139). Whenever the encoded bytes parse, they win.
        if let Some((iw, ih)) = crate::imgdims::dims_from_b64(data) {
            out["image_width"] = json!(iw);
            out["image_height"] = json!(ih);
        }
        if let Some((x, y, w, h)) = selector_hit {
            out["selector"] = json!(p.selector);
            out["selector_box"] = json!({ "x": x, "y": y, "width": w, "height": h });
        }
        if let Some(m) = metrics {
            out["viewport"] = json!({
                "width": m["iw"], "height": m["ih"],
                "device_scale_factor": m["dpr"],
                "scroll_x": m["sx"], "scroll_y": m["sy"],
            });
            out["page"] = json!({ "width": m["cw"], "height": m["ch"] });
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

// Phase 2 (plan): the locator ACTION actuators (fill / press /
// press_sequentially / select_option / set_checked) live in
// `bridge.rs`, driving the Playwright MCP tool surface on top of the
// native resolution prelude. Their in-page helpers (`FILL_JS`,
// `SELECT_JS`) left with them; the bridge reads selected/checked
// state back natively so response shapes stay byte-identical.

/// One resolved logical key for `Input.dispatchKeyEvent` (Playwright
/// key grammar: named keys plus single characters; printable keys carry
/// `text` and ride the rawKeyDown→char→keyUp sequence).
pub(crate) struct PwKey {
    pub(crate) key: String,
    pub(crate) code: Option<String>,
    pub(crate) vk: Option<u32>,
    pub(crate) text: Option<String>,
}

pub(crate) fn pw_key_spec(raw: &str) -> Option<PwKey> {
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
pub(crate) fn combo_mask(mods: &[&str]) -> Result<u32, BrowserError> {
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
pub(crate) async fn pw_send_key(
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
    fn receiverless_call_is_a_wrapped_iife() {
        assert_eq!(
            pw_eval_fn_expr("function(){ return document.title; }", &[]),
            "(function(){ return document.title; })()"
        );
    }

    #[test]
    fn eval_fn_args_are_escaped_json_literals() {
        // An adversarial title can never break out of its literal.
        let expr = pw_eval_fn_expr("function(t){ document.title = t; }", &[json!("a\"b\\c\nd")]);
        assert_eq!(
            expr,
            "(function(t){ document.title = t; })(\"a\\\"b\\\\c\\nd\")"
        );
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
