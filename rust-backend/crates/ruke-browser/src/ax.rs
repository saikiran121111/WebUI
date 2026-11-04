//! ax.rs — the Accessibility (AX) capture engine (Phase 6).
//!
//! Ported from the recovered reference engine (`reverse-engineering/
//! internal-browser/dom-snapshot-and-cdp.md` §5.1, classes recovered as
//! H-BS-23 state, H-BS-27 navigation bookkeeping, H-BS-26 `capture()`,
//! H-BS-28 the J2 read loop): every tab keeps a navigation state machine
//! fed by Page/Accessibility CDP events, and a capture runs the reference
//! stabilization sequence (wait for navigation → first paint → AX quiet →
//! candidate → freshness gate → commit) before rendering the tree.
//!
//! The model-facing rendering grammar is the Ruke `[id=N]` revision
//! format: 0-based DFS pre-order over the kept tree (identical to the
//! CDP `nodes` array order), one indented line per kept AX node with the
//! role, an optional JSON-quoted name, `[id=N]`, property groups, and a
//! trailing `:` when the node has kept children. Diffing against the
//! previously committed revision (same document) emits the recovered
//! `~`/`+`/removed-range format; the full tree is used when the diff
//! saves less than `MIN_SAVED_BYTES`.
//!
//! Explicitly documented adaptations (never silent):
//! - `MIN_SAVED_BYTES = 500` binds the recovered diff-savings knob
//!   (`$re`) whose call site is unreferenced in the recovered JS; the
//!   companion knob (`Wre`) has no recoverable role and is not ported.
//! - One flattened CDP session per tab, but frame descent still runs:
//!   the bundled build answers `Accessibility.getFullAXTree` with only
//!   the queried frame's subtree (live-probed), so every child frame
//!   gets its own `{frameId}` read stitched through the
//!   `DOM.getFrameOwner` join — no separate frame targets needed for
//!   same-process iframes. Per-frame `DOMSnapshot` metas (credential
//!   scan, closed-shadow) still key off the main-frame snapshot; the
//!   frame-target sweep lands with the Phase 8 input work.
//! - `Page.setLifecycleEventsEnabled` is NOT turned on: the discrete
//!   load events plus the `withPaint`/`probeNavigationState` document
//!   probes cover `painted`/element-count without the lifecycle stream.
//!   `Page.lifecycleEvent` is still handled (tolerant `loaderProgress`
//!   form) for browsers that emit it anyway.
//! - Subframe `frameNavigated`/`frameDetached` invalidate the committed
//!   revision wholesale (`invalidateFrame` equivalent) instead of
//!   per-target frame sweeps (Phase 8).
//! - The dialog-aware `j2` branch of `capture()` (synthetic dialog
//!   nodes) rides the Phase 8 dialog work; the revision bump itself
//!   (`Page.javascriptDialogOpening/Closed`) is wired here.
//! - AX line postprocessors (table row/column trimming, focus/
//!   selection banners) are deferred to Phase 10 with the model-facing
//!   tool surface, per plan; the raw revision grammar and diff engine
//!   are complete here.
//! - The credential attribute matcher mirrors the DOM CUA password
//!   guard (`dom_cua::password_guard_config` needles; that regex is not
//!   reusable from `ax.rs`, and this crate has no regex dependency, so
//!   the needle/bounded-token semantics are re-derived — pinned by the
//!   unit tests beside the original).
//! - The Fv identity string is byteLength-prefixed segments joined by
//!   `|` exactly as recovered; where a node has no `backendDOMNodeId`
//!   the fallback namespaces the CDP node id with an `n` prefix
//!   (`[adapted]`: keeps fallback ids from colliding with raw integer
//!   ids in the same map).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::{sleep, Duration, Instant};

use crate::cdp::CdpConn;
use crate::errors::BrowserError;
use crate::session::TabRecord;

// ── Recovered constants (§5.1, exact) ─────────────────────────────────

/// DIFF_HEADER verbatim from the recovered renderer.
const DIFF_HEADER: &str = "The following is a diff from the previous accessibility tree with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.";
/// "no change" sentinel verbatim from the recovered renderer.
const NO_CHANGE_TEXT: &str = "There has been no change in the accessibility tree.";
/// Removed-element summary prefix, verbatim.
const REMOVED_PREFIX: &str = "Removed element IDs: ";

/// Diff-savings floor in bytes ([adapted] — binds the recovered `$re`
/// knob; the full tree wins when a diff would save less than this).
const MIN_SAVED_BYTES: usize = 500;

/// `waitForNavigation`: revision-change detection window (ms) when the
/// snapshot was taken outside a load, then the settle deadline (ms);
/// both poll at `POLL_MS`.
const NAV_DETECT_MS: u64 = 25;
const NAV_DEADLINE_MS: u64 = 5_000;
const POLL_MS: u64 = 10;

/// `waitForFirstPaint`: settle deadline (ms).
const PAINT_DEADLINE_MS: u64 = 5_000;

/// `waitForAXQuiet`: deadline (ms), quiet thresholds (ms) for the
/// forced (50) and normal (100) modes, poll period (ms).
const AX_QUIET_DEADLINE_MS: u64 = 750;
const AX_QUIET_THRESHOLD_MS: u64 = 100;
const AX_QUIET_THRESHOLD_FORCED_MS: u64 = 50;
const AX_QUIET_POLL_MS: u64 = 25;

/// Large-DOM replacement probe: the 100 ms pause after a hit.
const LARGE_DOM_PAUSE_MS: u64 = 100;
/// Candidate element count below which the replacement probe runs.
const LARGE_DOM_PROBE_UNDER: usize = 100;

/// Paint-timing names the `Page.lifecycleEvent` handler accepts (the
/// recovered `Hre` set).
const PAINT_LIFECYCLE_NAMES: [&str; 4] = [
    "firstMeaningfulPaint",
    "firstContentfulPaint",
    "firstPaint",
    "firstImagePaint",
];

/// `withPaint` document probe — the recovered single-line expression.
/// NEVER split these across source lines: `;`-vs-newline matters in
/// minified-JS string literals.
const WITH_PAINT_PROBE: &str = "({ href: window.location.href, readyState: document.readyState, painted: performance.getEntriesByType('paint').some(entry => entry.name === 'first-paint' || entry.name === 'first-contentful-paint') })";

/// `probeNavigationState` — the recovered single-line expression.
const NAVIGATION_STATE_PROBE: &str = "(() => { const body = document.body; return { readyState: document.readyState, elementCount: body?.querySelectorAll('*').length ?? 0, textLength: body?.innerText?.length ?? 0 }; })()";

/// AX property allowlist: only these properties render (plus the
/// Expand/Collapse secondary actions derived from `expanded`).
const PROP_ALLOWLIST: [&str; 21] = [
    "checked",
    "selected",
    "pressed",
    "expanded",
    "focused",
    "focusable",
    "disabled",
    "readonly",
    "required",
    "multiline",
    "multiselectable",
    "invalid",
    "level",
    "modal",
    "editable",
    "hidden",
    "valuemax",
    "valuemin",
    "valuenow",
    "valuetext",
    "autocomplete",
];

/// The maximum capture attempts inside one `capture()` call (the
/// recovered loop is `while(true)`; J2 in the reference retries this
/// call forever — [adapted] the bound is finite so a pathological page
/// cannot spin the read loop indefinitely).
const CAPTURE_ATTEMPTS: u32 = 3;

// ── Per-tab state (H-BS-23 / H-BS-27) ─────────────────────────────────

/// Closed-shadow relation of an element (from `DOMSnapshot`
/// `shadowRootType`), used by the revision builder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClosedMark {
    /// The node is (or is inside) a closed shadow-root subtree.
    Inside,
    /// The node directly hosts a closed shadow root; kept, and its
    /// `contents`-sourced names are suspect (Blink would fold the
    /// hidden subtree's text into them).
    Ancestor,
}

/// Per-backendNodeId page evidence collected from `DOMSnapshot`.
#[derive(Clone, Debug)]
pub(crate) struct NodeMeta {
    pub(crate) tag_name: Option<String>,
    pub(crate) credential: bool,
    pub(crate) closed: Option<ClosedMark>,
}

#[derive(Clone, Debug)]
struct Provisional {
    navigation_revision: u64,
    committed: bool,
    painted: bool,
    tab_status: Option<String>,
    document_id: Option<String>,
}

#[derive(Clone, Debug)]
struct RevEntry {
    identity: String,
    sig: String,
    line: String,
}

/// The committed revision of one document: everything the next capture
/// diffs against, plus the element index → target map Phase 8 actions
/// consume.
#[derive(Clone, Debug)]
struct CommittedRev {
    document_key: String,
    entries: Vec<RevEntry>,
    // The Phase-8 `tab_ax_action` path resolves elements through this
    // map (`ax_element` below); recorded so a committed revision is
    // self-contained.
    targets: HashMap<String, AxTargetInfo>,
}

/// AX action surface recorded per kept element (Phase 8 consumes
/// `targets`; the secondary-action vocabulary is exactly Expand/
/// Collapse derived from the recovered `expanded` prop rule).
#[derive(Clone, Debug)]
// Consumed by the Phase-8 AX action surface (`ax_element` below); it is
// recorded with each committed revision.
pub(crate) struct AxTargetInfo {
    pub(crate) element_index: u64,
    // Kept per committed revision for identity bookkeeping; the action
    // path addresses elements by index + backend node id.
    #[allow(dead_code)]
    pub(crate) identity: String,
    pub(crate) backend_dom_node_id: Option<i64>,
    pub(crate) action_descriptions: Vec<String>,
    pub(crate) is_option_element: bool,
}

/// A committed-revision element resolved for the Phase-8 action path:
/// the target surface plus BOTH document keys so the caller can tell
/// "index not on this page" (lookup returns `None`) from "the page
/// changed under the committed revision" (the keys differ).
pub(crate) struct AxElementRef {
    pub(crate) committed_document_key: String,
    pub(crate) current_document_key: String,
    pub(crate) target: AxTargetInfo,
}

/// A flattened snapshot of the tab's navigation state (the recovered
/// `nav_state()` result — passed around by value so no registry guard
/// ever lives across an `.await`).
#[derive(Clone, Debug)]
pub(crate) struct NavState {
    revision: i64,
    navigation_revision: u64,
    loading: bool,
    committed: bool,
    painted: bool,
    tab_status: Option<String>,
    url: Option<String>,
    /// The main frame's latest loaderId — the document identity half of
    /// `documentKey` (the recovered `Lr` = `${main ?? ""}:${loader ?? ""}`).
    /// The snapshot mirrors the recovered `nav_state()` payload; the
    /// live reads the settle path performs today go straight to the
    /// registry (see `wait_for_ax_quiet`).
    #[allow(dead_code)]
    document_id: Option<String>,
    #[allow(dead_code)]
    last_ax_update_ms: i64,
    document_element_count: Option<usize>,
    document_text_length: Option<usize>,
}

impl NavState {
    fn from_state(st: &TabAx) -> NavState {
        NavState {
            revision: st.revision,
            navigation_revision: st.navigation_revision,
            loading: st.loading,
            committed: st.committed,
            painted: st.painted,
            tab_status: st.tab_status.clone(),
            url: st.url.clone(),
            document_id: st.loader_id.clone(),
            last_ax_update_ms: st.last_ax_update_ms,
            document_element_count: None,
            document_text_length: None,
        }
    }
}

/// The per-tab navigation/AX state machine (H-BS-23).
#[derive(Clone, Debug, Default)]
struct TabAx {
    initialized: bool,
    loading: bool,
    committed: bool,
    painted: bool,
    revision: i64,
    navigation_revision: u64,
    tab_status: Option<String>,
    url: Option<String>,
    main_frame_id: Option<String>,
    loader_id: Option<String>,
    provisional: Option<Provisional>,
    pending_navigation: Option<NavState>,
    last_ax_update_ms: i64,
    committed_rev: Option<CommittedRev>,
}

/// One candidate observation: the state snapshot taken BEFORE the tree
/// read plus the (possibly absent — empty tree) rendered build.
#[derive(Clone, Debug)]
struct Candidate {
    doc_key: String,
    nav: NavState,
    build: Option<Build>,
}

#[derive(Clone, Debug)]
struct Build {
    entries: Vec<RevEntry>,
    targets: HashMap<String, AxTargetInfo>,
    element_count: usize,
    text: String,
    used_diff: bool,
}

/// The committed capture result handed to the executor.
pub(crate) struct AxCaptureResult {
    pub(crate) state: String,
    pub(crate) document_key: String,
    pub(crate) element_count: usize,
    pub(crate) used_diff: bool,
}

/// Registries keyed by tab id. Every tab-removal path forgets here so
/// stale handles fail closed.
#[derive(Default)]
pub struct AxRegistries {
    inner: Mutex<HashMap<String, TabAx>>,
}

impl AxRegistries {
    fn with_state<R>(&self, tab_id: &str, f: impl FnOnce(&mut TabAx) -> R) -> R {
        let mut inner = self.inner.lock();
        let st = inner.entry(tab_id.to_string()).or_default();
        f(st)
    }

    fn nav_state(&self, tab_id: &str) -> NavState {
        self.with_state(tab_id, |st| NavState::from_state(st))
    }

    /// Phase-8 action entry: resolve an element index against the LAST
    /// COMMITTED AX revision (the one whose rendered tree the model was
    /// shown), returning the target surface and both document keys.
    /// Absent → `StaleAxElement`; committed ≠ current key → the page
    /// moved (`AxPreviousPage`) — the recovered staleness contract.
    pub(crate) fn ax_element(&self, tab_id: &str, element_index: u64) -> Option<AxElementRef> {
        let inner = self.inner.lock();
        let st = inner.get(tab_id)?;
        let rev = st.committed_rev.as_ref()?;
        let target = rev
            .targets
            .values()
            .find(|t| t.element_index == element_index)?
            .clone();
        Some(AxElementRef {
            committed_document_key: rev.document_key.clone(),
            current_document_key: document_key(st),
            target,
        })
    }

    pub(crate) fn forget_tab(&self, tab_id: &str) {
        self.inner.lock().remove(tab_id);
    }

    pub(crate) fn clear_all(&self) {
        self.inner.lock().clear();
    }

    // ── Event hooks (pump calls these; all synchronous, guards never
    //    live across an await) ───────────────────────────────────────

    /// `Accessibility.loadComplete` / `Accessibility.nodesUpdated`:
    /// refresh the last-AX-update clock (the quiet window's baseline).
    pub(crate) fn note_ax_update(&self, tab_id: &str) {
        self.with_state(tab_id, |st| st.last_ax_update_ms = epoch_ms());
    }

    /// `Page.frameStartedLoading` (main frame only). Seeds the
    /// provisional snapshot on the FIRST provisional load of a cycle
    /// (the recovered rule: no provisional yet → copy the pre-nav
    /// state + this event's loaderId), then `lv()`.
    pub(crate) fn on_frame_started_loading(
        &self,
        tab_id: &str,
        frame_id: &str,
        loader_id: Option<&str>,
    ) {
        self.with_state(tab_id, |st| {
            if !is_main(st, frame_id) {
                return;
            }
            if st.provisional.is_none() {
                st.provisional = Some(Provisional {
                    navigation_revision: st.navigation_revision,
                    committed: st.committed,
                    painted: st.painted,
                    tab_status: st.tab_status.clone(),
                    document_id: loader_id.map(|s| s.to_string()),
                });
            }
            lv(st);
        });
    }

    /// `Page.frameNavigated` (main frame). The pending-navigation
    /// snapshot is taken BEFORE the mutation (recovered: `pending ??=
    /// NavState.from(this)`); the provisional is dropped; `loading ||
    /// lv()` — an already-loading state means the start event already
    /// bumped revisions, so the nav event must not bump again; the
    /// document identity fields land; then `committed = true` and the
    /// BackForwardCacheRestore shape is already painted.
    pub(crate) fn on_main_frame_navigated(
        &self,
        tab_id: &str,
        frame_id: &str,
        loader_id: Option<&str>,
        url: Option<&str>,
        bfcache_restore: bool,
    ) {
        self.with_state(tab_id, |st| {
            if !is_main(st, frame_id) {
                return;
            }
            if st.pending_navigation.is_none() {
                st.pending_navigation = Some(NavState::from_state(st));
            }
            st.provisional = None;
            if !st.loading {
                lv(st);
            }
            st.main_frame_id = Some(frame_id.to_string());
            st.loader_id = loader_id.map(|s| s.to_string());
            if let Some(url) = url {
                st.url = Some(url.to_string());
            }
            st.committed = true;
            if bfcache_restore {
                st.loading = false;
                st.painted = true;
            }
        });
    }

    /// `Page.navigatedWithinDocument` (main frame). A same-loader
    /// provisional pairing rolls the revision bump back (the recovered
    /// popstate/fragment bookkeeping); `loading = false` always; the
    /// `fragment` type updates the URL without any revision bump or
    /// pending entry; everything else bumps the revision and records a
    /// pending snapshot.
    pub(crate) fn on_navigated_within_document(
        &self,
        tab_id: &str,
        frame_id: &str,
        url: &str,
        nav_type: &str,
    ) {
        self.with_state(tab_id, |st| {
            if !is_main(st, frame_id) {
                return;
            }
            if let (Some(loader), Some(prov)) = (st.loader_id.clone(), st.provisional.as_ref()) {
                if prov.document_id.as_deref() == Some(loader.as_str()) {
                    let prov = st.provisional.take().expect("checked above");
                    st.revision -= 1;
                    st.navigation_revision = prov.navigation_revision;
                    st.committed = prov.committed;
                    st.painted = prov.painted;
                    st.tab_status = prov.tab_status;
                }
            }
            st.loading = false;
            st.url = Some(url.to_string());
            if nav_type.eq_ignore_ascii_case("fragment") {
                return;
            }
            if st.pending_navigation.is_none() {
                st.pending_navigation = Some(NavState::from_state(st));
            }
            st.revision += 1;
        });
    }

    /// `Page.domContentEventFired` → loading cleared.
    pub(crate) fn on_dom_content_loaded(&self, tab_id: &str) {
        self.with_state(tab_id, |st| st.loading = false);
    }

    /// `Page.loadEventFired` → loading cleared, status complete.
    pub(crate) fn on_load_event(&self, tab_id: &str) {
        self.with_state(tab_id, |st| {
            st.loading = false;
            st.tab_status = Some("complete".to_string());
        });
    }

    /// `Page.frameStoppedLoading` (main frame) → loading cleared.
    pub(crate) fn on_frame_stopped_loading(&self, tab_id: &str, frame_id: &str) {
        self.with_state(tab_id, |st| {
            if is_main(st, frame_id) {
                st.loading = false;
            }
        });
    }

    /// `Page.lifecycleEvent`: a committed-progress paint-timing event
    /// for the tracked document marks it painted. The
    /// `loaderProgress` tolerance ([adapted]) defaults to committed when
    /// the field is absent.
    pub(crate) fn on_lifecycle_event(
        &self,
        tab_id: &str,
        frame_id: &str,
        loader_id: Option<&str>,
        name: &str,
        progress_committed: bool,
    ) {
        self.with_state(tab_id, |st| {
            if !progress_committed || !is_main(st, frame_id) {
                return;
            }
            if let (Some(ld), Some(tracked)) = (loader_id, st.loader_id.as_deref()) {
                if ld != tracked {
                    return;
                }
            }
            if PAINT_LIFECYCLE_NAMES.contains(&name) {
                st.painted = true;
            }
        });
    }

    /// `Page.javascriptDialogOpening` / `Page.javascriptDialogClosed`
    /// bump the revision (a dialog reshapes the hittable tree). The
    /// dialog-aware capture branch is Phase 8.
    pub(crate) fn on_dialog_event(&self, tab_id: &str) {
        self.with_state(tab_id, |st| st.revision += 1);
    }

    /// Subframe navigation/detach invalidation ([adapted] — the whole
    /// committed revision is dropped; the per-target frame sweep rides
    /// the Phase 8 frame-target work).
    pub(crate) fn invalidate_subtree(&self, tab_id: &str) {
        self.with_state(tab_id, |st| st.committed_rev = None);
    }
}

/// The recovered document key (`Lr`): `${main ?? ""}:${loader ?? ""}`.
fn document_key(st: &TabAx) -> String {
    format!(
        "{}:{}",
        st.main_frame_id.as_deref().unwrap_or(""),
        st.loader_id.as_deref().unwrap_or("")
    )
}

/// The main frame is the tracked frame until seeded; before seeding
/// every main-frame signal is accepted (the seeding probe filters).
fn is_main(st: &TabAx, frame_id: &str) -> bool {
    st.main_frame_id.as_deref().is_none_or(|mf| mf == frame_id)
}

/// The recovered `lv()` ("load vertex") transition.
fn lv(st: &mut TabAx) {
    if !st.loading {
        st.revision += 1;
        st.navigation_revision += 1;
    }
    st.loading = true;
    st.committed = false;
    st.painted = false;
    st.tab_status = Some("loading".to_string());
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Raw CDP AX tree shapes ────────────────────────────────────────────

/// `Accessibility.AXNode`. `nodeId` (an AXNodeId primitive) is read
/// tolerantly: the JSON wire form varies between string and number
/// across Chromium builds.
#[derive(Clone, Debug, Deserialize)]
struct RawNode {
    #[serde(rename = "nodeId", deserialize_with = "de_node_id")]
    node_id: String,
    #[serde(default)]
    ignored: bool,
    role: Option<RawObj>,
    name: Option<RawName>,
    value: Option<RawObj>,
    #[serde(default)]
    properties: Vec<RawProp>,
    #[serde(rename = "childIds", default, deserialize_with = "de_opt_ids")]
    child_ids: Option<Vec<String>>,
    #[serde(rename = "backendDOMNodeId")]
    backend_dom_node_id: Option<i64>,
}

/// The compact merged-AX-tree node shape the Phase-7 aria-snapshot
/// renderer walks (`pw.rs`). It exists so the raw wire structs above
/// stay private to ax.rs; `pw_ax_nodes` is the cross-module contract.
#[derive(Clone, Debug)]
pub(crate) struct PwAxNode {
    pub(crate) node_id: String,
    pub(crate) ignored: bool,
    pub(crate) role: String,
    pub(crate) name: Option<String>,
    pub(crate) props: Vec<(String, Value)>,
    pub(crate) child_ids: Vec<String>,
    pub(crate) bnid: Option<i64>,
}

fn node_id_from_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn de_node_id<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Value::deserialize(d)?;
    Ok(node_id_from_value(&v))
}

fn de_opt_ids<'de, D>(d: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<Vec<Value>>::deserialize(d)?;
    Ok(v.map(|vs| vs.iter().map(node_id_from_value).collect()))
}

/// `Accessibility.AXValue` (role/value/description form).
#[derive(Clone, Debug, Deserialize)]
struct RawObj {
    value: Option<Value>,
}

/// `name` when `includeAXNodeSources: true` (the sources drive the
/// recovered `hre` name-source classification the mre hide rules key
/// off).
#[derive(Clone, Debug, Deserialize)]
struct RawName {
    value: Option<Value>,
    sources: Option<Vec<RawSource>>,
}

#[derive(Clone, Debug, Deserialize)]
struct RawSource {
    #[serde(rename = "type")]
    kind: Option<String>,
    attribute: Option<String>,
    value: Option<Value>,
    #[serde(rename = "attributeValue")]
    attribute_value: Option<Value>,
    #[serde(default)]
    superseded: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
struct RawProp {
    name: String,
    #[serde(default)]
    value: RawPropVal,
}

/// AX property values: the wire carries `value`; the reference's
/// post-processed form also carried a `bool` convenience field — both
/// shapes are accepted.
#[derive(Clone, Debug, Default, Deserialize)]
struct RawPropVal {
    #[serde(default)]
    value: Option<Value>,
    #[serde(rename = "bool", default)]
    b: Option<bool>,
}

fn scalar_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// `JSON.stringify` for the model-facing quoted fields.
fn json_quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

impl RawNode {
    fn role_name(&self) -> String {
        self.role
            .as_ref()
            .and_then(|r| r.value.as_ref())
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string()
    }

    fn name_str(&self) -> Option<String> {
        self.name
            .as_ref()
            .and_then(|n| n.value.as_ref())
            .and_then(Value::as_str)
            .map(|s| s.to_string())
    }

    fn value_str(&self) -> Option<String> {
        self.value
            .as_ref()
            .and_then(|v| v.value.as_ref())
            .and_then(scalar_text)
    }

    /// The Fv identity: byteLength-prefixed `tab | target | id`
    /// segments joined by `|` (the target segment is always the empty
    /// string for this flattened session).
    fn identity(&self, tab_id: &str) -> String {
        let part = match self.backend_dom_node_id {
            Some(b) => b.to_string(),
            None => format!("n{}", self.node_id),
        };
        format!(
            "{}:{}|{}:{}|{}:{}",
            tab_id.len(),
            tab_id,
            0,
            "",
            part.len(),
            part
        )
    }
}

/// The recovered `hre` name-source classification over the chosen
/// source: first non-superseded source that carries a value, else the
/// first non-superseded, else the first; attribute
/// `placeholder`/`value` beat the source `type`.
fn name_source(name: Option<&RawName>) -> Option<&'static str> {
    let srcs = name?.sources.as_ref()?;
    let chosen = srcs
        .iter()
        .find(|s| s.superseded != Some(true) && (s.value.is_some() || s.attribute_value.is_some()))
        .or_else(|| srcs.iter().find(|s| s.superseded != Some(true)))
        .or_else(|| srcs.first())?;
    match chosen.attribute.as_deref() {
        Some("placeholder") => Some("placeholder"),
        Some("value") => Some("value"),
        _ => match chosen.kind.as_deref() {
            Some("contents") => Some("contents"),
            Some("placeholder") => Some("placeholder"),
            Some("relatedElement") => Some("relatedElement"),
            _ => Some("attribute"),
        },
    }
}

// ── Credential attribute matcher ──────────────────────────────────────
// Mirrors the DOM CUA password guard needles (see the `Ds` guard
// installed by `dom_cua::password_guard_config`): unbounded needles are
// plain substrings; the short/ambiguous tokens are substring matches
// bounded by non-word characters on both sides (the `\b…\b` forms).
// Re-derived here because that regex is private and this crate has no
// regex dependency; the unit tests beside the original pin parity.

fn credential_needles() -> &'static [String] {
    static NEEDLES: OnceLock<Vec<String>> = OnceLock::new();
    NEEDLES.get_or_init(|| {
        let base = [
            "username",
            "user name",
            "user-name",
            "user_name",
            "email",
            "e-mail",
            "e mail",
            "e_mail",
            "password",
            "passcode",
            "passwd",
            "phone",
            "mobile",
        ];
        let mut v: Vec<String> = base.iter().map(|s| s.to_string()).collect();
        for s1 in ["", "-", " ", "_"] {
            for s2 in ["", "-", " ", "_"] {
                v.push(format!("one{s1}time{s2}code"));
            }
        }
        v
    })
}

const BOUNDED_TOKENS: [&str; 4] = ["otp", "2fa", "mfa", "tel"];

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn bounded_substring(text: &str, needle: &str) -> bool {
    let bytes = text.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(needle) {
        let i = from + rel;
        let before_ok = i == 0 || !is_word_byte(bytes[i - 1]);
        let after = i + needle.len();
        let after_ok = after == bytes.len() || !is_word_byte(bytes[after]);
        if before_ok && after_ok {
            return true;
        }
        from = i + 1;
    }
    false
}

/// True when an element's attribute text marks it credential-bearing:
/// its name/value must never reach the model, and `valuetext` is
/// dropped alongside it (the recovered mre deletes both).
pub(crate) fn credential_hit(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if credential_needles()
        .iter()
        .any(|n| lower.contains(n.as_str()))
    {
        return true;
    }
    BOUNDED_TOKENS.iter().any(|t| bounded_substring(&lower, t))
}

// ── DOMSnapshot page evidence (metas) ─────────────────────────────────

/// The snapshot string table: plain strings (the dialect the bundled
/// build answers, matching the recovered `domSnapshot.strings` reads),
/// with a `{value}`-entry fallback for other protocol revisions.
fn string_table(v: &Value) -> Vec<&str> {
    v.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| match s {
                    Value::String(t) => Some(t.as_str()),
                    _ => s.get("value").and_then(Value::as_str),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Sparse `{index, value}` sideband lists.
fn sparse_ids(v: Option<&Value>) -> Vec<i64> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

/// Collect per-backendNodeId {tag, credential attrs, closed-shadow}
/// from a `DOMSnapshot.captureSnapshot` response. The dialect is the
/// one the recovered caller pinned (`computedStyles: [],
/// includePaintOrder: false, includeDOMRects: false`) and the bundled
/// build answers — verified live: top-level plain `strings` table,
/// dense `parentIndex`/`nodeName` string-index arrays, dense
/// `attributes` as flat name/value string-index pairs per node, and
/// sparse `{index, value}` pairs for `shadowRootType`.
fn snapshot_meta(snapshot: &Value) -> HashMap<i64, NodeMeta> {
    let mut out = HashMap::new();
    let Some(docs) = snapshot.get("documents").and_then(Value::as_array) else {
        return out;
    };
    let top_strings: Vec<&str> = snapshot
        .get("strings")
        .map(string_table)
        .unwrap_or_default();
    for doc in docs {
        let doc_strings;
        let strings: &[&str] = if top_strings.is_empty() {
            doc_strings = doc.get("strings").map(string_table).unwrap_or_default();
            &doc_strings
        } else {
            &top_strings
        };
        let sget = |idx: Option<i64>| -> &str {
            idx.and_then(|i| strings.get(i as usize).copied())
                .unwrap_or("")
        };
        let Some(nodes) = doc.get("nodes") else {
            continue;
        };
        let dense = |key: &str| -> Vec<i64> {
            nodes
                .get(key)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default()
        };
        let backend = dense("backendNodeId");
        let n = backend.len();
        if n == 0 {
            continue;
        }
        let parent = dense("parentIndex");
        // Children fall out of the dense parentIndex array — this
        // dialect carries no childNodeIndex/Count pair.
        let mut kids: Vec<Vec<usize>> = vec![Vec::new(); n];
        for i in 0..n {
            if let Some(p) = parent
                .get(i)
                .copied()
                .filter(|p| *p >= 0 && (*p as usize) < n)
            {
                kids[p as usize].push(i);
            }
        }
        let parent_of = |i: usize| -> Option<usize> {
            parent
                .get(i)
                .copied()
                .filter(|p| *p >= 0 && (*p as usize) < n)
                .map(|p| p as usize)
        };
        let children_of = |i: usize| -> Vec<usize> { kids.get(i).cloned().unwrap_or_default() };

        // nodeName is a dense string-index array, one entry per node.
        let node_name = dense("nodeName");
        let mut tag_names: Vec<Option<String>> = vec![None; n];
        for (i, &si) in node_name.iter().enumerate().take(n) {
            tag_names[i] = Some(sget(Some(si)).to_ascii_lowercase());
        }

        // shadowRootType is the sparse {index, value} dialect.
        let mut closed_host = vec![false; n];
        if let Some(shadow) = nodes.get("shadowRootType") {
            let idx = sparse_ids(shadow.get("index"));
            let vals = sparse_ids(shadow.get("value"));
            for (k, &node_i) in idx.iter().enumerate() {
                if (node_i as usize) < n && sget(vals.get(k).copied()) == "closed" {
                    closed_host[node_i as usize] = true;
                }
            }
        }

        // attributes is dense, one entry per node: a flat list of
        // alternating name/value STRING INDICES ([name, value, ...]).
        let mut credential = vec![false; n];
        if let Some(entries) = nodes.get("attributes").and_then(Value::as_array) {
            for (i, entry) in entries.iter().enumerate().take(n) {
                let mut text = String::new();
                if let Some(pair_ids) = entry.as_array() {
                    let mut it = pair_ids.iter().filter_map(Value::as_i64);
                    while let (Some(name_i), Some(val_i)) = (it.next(), it.next()) {
                        text.push(' ');
                        text.push_str(sget(Some(name_i)));
                        text.push(' ');
                        text.push_str(sget(Some(val_i)));
                    }
                }
                if credential_hit(&text) {
                    credential[i] = true;
                }
            }
        }

        // Closed subtrees: the host plus every descendant is Inside
        // (the whole subtree is dropped from the revision); the host's
        // parent (unless itself inside) gets the Ancestor mark — its
        // `contents`-sourced names fold the hidden subtree's text.
        let mut inside = vec![false; n];
        for (i, is_host) in closed_host.iter().enumerate() {
            if !*is_host {
                continue;
            }
            let mut stack = vec![i];
            while let Some(x) = stack.pop() {
                if inside[x] {
                    continue;
                }
                inside[x] = true;
                stack.extend(children_of(x));
            }
        }
        let mut ancestor = vec![false; n];
        for (i, is_host) in closed_host.iter().enumerate() {
            if !*is_host {
                continue;
            }
            if let Some(p) = parent_of(i) {
                if !inside[p] {
                    ancestor[p] = true;
                }
            }
        }

        for i in 0..n {
            let b = backend[i];
            if b == 0 {
                continue;
            }
            out.insert(
                b,
                NodeMeta {
                    tag_name: tag_names[i].clone(),
                    credential: credential[i],
                    closed: if inside[i] {
                        Some(ClosedMark::Inside)
                    } else if ancestor[i] {
                        Some(ClosedMark::Ancestor)
                    } else {
                        None
                    },
                },
            );
        }
    }
    out
}

// ── The revision builder (the recovered J2 read loop's pure half) ─────

fn build_line(
    depth: usize,
    role: &str,
    name_json: Option<&str>,
    id_tag: Option<usize>,
    props: &[String],
    colon: bool,
) -> String {
    let mut s = "  ".repeat(depth);
    s.push_str("- ");
    s.push_str(role);
    if let Some(n) = name_json {
        s.push(' ');
        s.push_str(n);
    }
    if let Some(i) = id_tag {
        s.push_str(&format!(" [id={}]", i));
    }
    for p in props {
        s.push(' ');
        s.push_str(p);
    }
    if colon {
        s.push(':');
    }
    s
}

/// Render one revision from the raw AX tree plus page metas, diffing
/// against `prev` when a committed revision exists for the same
/// document.
fn build_revision(
    tab_id: &str,
    raws: &[RawNode],
    metas: &HashMap<i64, NodeMeta>,
    prev: Option<&CommittedRev>,
) -> Build {
    let mut by_id: HashMap<&str, &RawNode> = HashMap::new();
    for r in raws {
        by_id.insert(r.node_id.as_str(), r);
    }
    let mut children_of: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut is_child: HashSet<&str> = HashSet::new();
    for r in raws {
        let mut kids = Vec::new();
        if let Some(ids) = r.child_ids.as_ref() {
            for c in ids.iter().map(|s| s.as_str()) {
                if by_id.contains_key(c) {
                    kids.push(c);
                    is_child.insert(c);
                }
                // Unknown child ids are dropped silently (a truncated
                // tree must not fabricate nodes).
            }
        }
        children_of.insert(r.node_id.as_str(), kids);
    }
    let meta_of = |id: &str| -> Option<&NodeMeta> {
        by_id[id].backend_dom_node_id.and_then(|b| metas.get(&b))
    };

    // Closed-shadow exclusion: entire subtrees rooted at Inside nodes
    // (hosts included) stay out of the revision.
    let mut excluded: HashSet<&str> = HashSet::new();
    for r in raws {
        if meta_of(&r.node_id).and_then(|m| m.closed) != Some(ClosedMark::Inside) {
            continue;
        }
        let mut stack = vec![r.node_id.as_str()];
        while let Some(x) = stack.pop() {
            if excluded.insert(x) {
                if let Some(kids) = children_of.get(x) {
                    stack.extend(kids.iter().copied());
                }
            }
        }
    }
    let kept_set: HashSet<&str> = raws
        .iter()
        .filter(|r| !r.ignored && !excluded.contains(r.node_id.as_str()))
        .map(|r| r.node_id.as_str())
        .collect();
    let is_kept = |id: &str| kept_set.contains(id);

    // Nearest kept ancestor per node (ignored nodes are transparent:
    // their children attach to the nearest kept ancestor above — the
    // mre behavior that hides ignored wrappers while keeping depth
    // stable).
    let mut nearest: HashMap<&str, Option<&str>> = HashMap::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut queue: VecDeque<(&str, Option<&str>)> = VecDeque::new();
    for r in raws {
        if !is_child.contains(r.node_id.as_str()) {
            queue.push_back((r.node_id.as_str(), None));
            seen.insert(r.node_id.as_str());
        }
    }
    while let Some((x, anc)) = queue.pop_front() {
        let carry = if is_kept(x) {
            nearest.insert(x, anc);
            Some(x)
        } else {
            anc
        };
        if let Some(kids) = children_of.get(x) {
            for c in kids.iter().copied() {
                if !seen.contains(c) {
                    seen.insert(c);
                    queue.push_back((c, carry));
                }
            }
        }
    }

    // Entries in CDP array order (kept only): element_index == the id
    // tag == the position, exactly like the recovered numbering.
    let mut entries: Vec<RevEntry> = Vec::new();
    let mut targets: HashMap<String, AxTargetInfo> = HashMap::new();
    let kept_ids: Vec<&str> = raws
        .iter()
        .filter(|r| is_kept(&r.node_id))
        .map(|r| r.node_id.as_str())
        .collect();
    for (idx, &id) in kept_ids.iter().enumerate() {
        let r = by_id[id];
        let own_meta = meta_of(id);

        // Walk the kept-ancestor chain: depth + credential context +
        // closed-ancestor context. The step cap guards malformed
        // cyclic childIds (CDP trees are acyclic; defense only).
        let mut depth = 0usize;
        let mut cred_anc = false;
        let mut closed_anc = false;
        let mut cur = nearest.get(id).copied().flatten();
        let mut steps = 0usize;
        while let Some(a) = cur {
            if steps > raws.len() {
                break;
            }
            depth += 1;
            steps += 1;
            if let Some(m) = meta_of(a) {
                if m.credential {
                    cred_anc = true;
                }
                if m.closed == Some(ClosedMark::Ancestor) {
                    closed_anc = true;
                }
            }
            cur = nearest.get(a).copied().flatten();
        }
        let b_ctx = own_meta.is_some_and(|m| m.credential) || cred_anc;
        let closed_anc_ctx =
            closed_anc || matches!(own_meta.and_then(|m| m.closed), Some(ClosedMark::Ancestor));

        let role = r.role_name();
        let name_str = r.name_str();
        let val_str = r.value_str();
        let ns = name_source(r.name.as_ref());
        // The mre hide rules: under a closed-ancestor context a
        // `contents`-sourced name folds hidden text; in a credential
        // context a `value`-sourced name or a name equal to the value
        // is hidden outright.
        let hide_name = name_str.is_some()
            && ((closed_anc_ctx && ns == Some("contents"))
                || (b_ctx && (ns == Some("value") || name_str == val_str)));
        let name_json = if hide_name {
            None
        } else {
            name_str.as_deref().map(json_quote)
        };

        let mut props: Vec<String> = Vec::new();
        let mut actions: Vec<String> = Vec::new();
        for p in &r.properties {
            let eff = p.value.value.clone().or_else(|| p.value.b.map(Value::Bool));
            // Secondary actions come only from `expanded` (the
            // recovered H2 surface: Expand/Collapse, nothing else).
            match (p.name.as_str(), eff.as_ref()) {
                ("expanded", Some(Value::Bool(true))) => actions.push("Collapse".to_string()),
                ("expanded", Some(Value::Bool(false))) => actions.push("Expand".to_string()),
                _ => {}
            }
            if !PROP_ALLOWLIST.contains(&p.name.as_str()) {
                continue;
            }
            if b_ctx && p.name == "valuetext" {
                continue;
            }
            match eff.as_ref() {
                Some(Value::Bool(false)) => {}
                Some(Value::Bool(true)) => props.push(format!("[{}]", p.name)),
                Some(Value::String(s)) => props.push(format!("[{}={}]", p.name, s)),
                Some(Value::Number(num)) => props.push(format!("[{}={}]", p.name, num)),
                _ => {}
            }
        }

        let colon = children_of
            .get(id)
            .map(|kids| kids.iter().any(|c| is_kept(c)))
            .unwrap_or(false);
        let line = build_line(depth, &role, name_json.as_deref(), Some(idx), &props, colon);
        let sig = build_line(depth, &role, name_json.as_deref(), None, &props, colon);
        let identity = r.identity(tab_id);
        targets.insert(
            identity.clone(),
            AxTargetInfo {
                element_index: idx as u64,
                identity: identity.clone(),
                backend_dom_node_id: r.backend_dom_node_id,
                action_descriptions: actions,
                is_option_element: own_meta.and_then(|m| m.tag_name.as_deref()) == Some("option"),
            },
        );
        entries.push(RevEntry {
            identity,
            sig,
            line,
        });
    }
    let text_full = entries
        .iter()
        .map(|e| e.line.as_str())
        .collect::<Vec<&str>>()
        .join("\n");

    let (text, used_diff) = match prev {
        None => (text_full.clone(), false),
        Some(p) => {
            let prevmap: HashMap<&str, (&str, usize)> = p
                .entries
                .iter()
                .enumerate()
                .map(|(i, e)| (e.identity.as_str(), (e.sig.as_str(), i)))
                .collect();
            let new_ids: HashSet<&str> = entries.iter().map(|e| e.identity.as_str()).collect();
            let mut out_lines: Vec<String> = Vec::new();
            let mut changed = false;
            for e in &entries {
                match prevmap.get(e.identity.as_str()) {
                    // Unchanged element — omitted from the diff
                    // entirely. The recovered accessibility.md
                    // contract states the diff returns "listing only
                    // the elements that were removed, added, or
                    // changed": the model still holds the unchanged
                    // lines from the previous tree, and omitting them
                    // is what lets the savings gate below pass at all.
                    Some((psig, _)) if *psig == e.sig => {}
                    Some(_) => {
                        // The line's first "- " is the marker (the
                        // indent is all spaces); JSON names with "- "
                        // would come later.
                        out_lines.push(e.line.replacen("- ", "~ ", 1));
                        changed = true;
                    }
                    None => {
                        out_lines.push(e.line.replacen("- ", "+ ", 1));
                        changed = true;
                    }
                }
            }
            let mut removed: Vec<usize> = p
                .entries
                .iter()
                .enumerate()
                .filter(|(_, e)| !new_ids.contains(e.identity.as_str()))
                .map(|(i, _)| i)
                .collect();
            if !changed && removed.is_empty() {
                (NO_CHANGE_TEXT.to_string(), true)
            } else {
                removed.sort_unstable();
                let mut t = String::from(DIFF_HEADER);
                if !out_lines.is_empty() {
                    t.push('\n');
                    t.push_str(&out_lines.join("\n"));
                }
                if !removed.is_empty() {
                    t.push('\n');
                    t.push_str(REMOVED_PREFIX);
                    t.push_str(&compact_id_ranges(&removed));
                }
                let saved = text_full.len().saturating_sub(t.len());
                if saved < MIN_SAVED_BYTES {
                    (text_full.clone(), false)
                } else {
                    (t, true)
                }
            }
        }
    };

    Build {
        entries,
        targets,
        element_count: kept_ids.len(),
        text,
        used_diff,
    }
}

/// Contiguous id ranges ("0-2,5,7-8") — the removed-summary form.
fn compact_id_ranges(ids: &[usize]) -> String {
    if ids.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    let mut start = ids[0];
    let mut prev = ids[0];
    for &id in &ids[1..] {
        if id == prev + 1 {
            prev = id;
            continue;
        }
        if !out.is_empty() {
            out.push(',');
        }
        if start == prev {
            out.push_str(&start.to_string());
        } else {
            out.push_str(&format!("{}-{}", start, prev));
        }
        start = id;
        prev = id;
    }
    if !out.is_empty() {
        out.push(',');
    }
    if start == prev {
        out.push_str(&start.to_string());
    } else {
        out.push_str(&format!("{}-{}", start, prev));
    }
    out
}

/// The recovered `q2` large-DOM replacement probe: the page grew to at
/// least `max(150, 3×candidate)` elements, or the candidate was tiny
/// and the document has ≥4000 chars of text.
fn q2(candidate_count: usize, probe: &NavState) -> bool {
    let count = probe.document_element_count.unwrap_or(0);
    let text_len = probe.document_text_length.unwrap_or(0);
    count >= std::cmp::max(150, candidate_count.saturating_mul(3))
        || (candidate_count < 50 && text_len >= 4_000)
}

/// The recovered `j2` settled-state predicate: painted (or complete),
/// ≥10 document elements, and the candidate URL's host+path still
/// match the live URL (unparseable URLs fall back to string equality).
fn j2(candidate_url: Option<&str>, ns: &NavState) -> bool {
    if !(ns.painted || ns.tab_status.as_deref() == Some("complete")) {
        return false;
    }
    if ns.document_element_count.unwrap_or(0) < 10 {
        return false;
    }
    let live = match ns.url.as_deref() {
        Some(u) => u,
        None => return false,
    };
    let cand = candidate_url.unwrap_or("");
    match (url::Url::parse(live), url::Url::parse(cand)) {
        (Ok(a), Ok(b)) => a.host_str() == b.host_str() && a.path() == b.path(),
        _ => live == cand,
    }
}

// ── Async capture engine (H-BS-26) ────────────────────────────────────

impl AxRegistries {
    /// `Runtime.evaluate` returning the evaluated JSON value. A
    /// page-side exception becomes a `CdpFailed` carrying the
    /// recovered exceptionDetails reason chain.
    async fn evaluate_json(
        &self,
        conn: &CdpConn,
        session: &str,
        expression: &str,
    ) -> Result<Value, BrowserError> {
        let res = conn
            .call(
                "Runtime.evaluate",
                Some(json!({ "expression": expression, "returnByValue": true })),
                Some(session),
            )
            .await?;
        if let Some(exc) = res.get("exceptionDetails") {
            let reason = exc
                .pointer("/exception/description")
                .and_then(Value::as_str)
                .or_else(|| exc.pointer("/exception/value").and_then(Value::as_str))
                .or_else(|| exc.pointer("/text").and_then(Value::as_str))
                .unwrap_or("page script raised an exception")
                .to_string();
            return Err(BrowserError::CdpFailed {
                method: "Runtime.evaluate".to_string(),
                reason,
            });
        }
        // Shape trap (smoke-verified for the DOM walkers): the value
        // nests under /result/value — one level deeper than the wire
        // `result` CdpConn::call already unwrapped.
        Ok(res.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }

    /// The `withPaint` document probe: absent (non-object) when the
    /// page environment refuses the expression.
    async fn read_document_state(
        &self,
        conn: &CdpConn,
        session: &str,
    ) -> Result<Option<Value>, BrowserError> {
        let v = self.evaluate_json(conn, session, WITH_PAINT_PROBE).await?;
        Ok(v.is_object().then_some(v))
    }

    /// Seed the tracked main frame/loader via `Page.getFrameTree`,
    /// then the `withPaint` probe. Guarded both before seeding and
    /// after the probe (the recovered `(!loading || committed) &&
    /// navRev == snap.navRev && documentKey == key` freshness check):
    /// when any event moved the state the seed is skipped without
    /// marking `initialized`, so the next capture retries.
    pub(crate) async fn ensure_tracked(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
    ) -> Result<(), BrowserError> {
        if self.with_state(&rec.tab_id, |st| st.initialized) {
            return Ok(());
        }
        let (nrev0, dk0) =
            self.with_state(&rec.tab_id, |st| (st.navigation_revision, document_key(st)));
        let tree = conn
            .call("Page.getFrameTree", None, Some(&rec.cdp_session_id))
            .await?;
        let frame = tree.pointer("/frameTree/frame");
        let (frame_id, loader_id) = match (
            frame.and_then(|f| f.get("id")).and_then(Value::as_str),
            frame
                .and_then(|f| f.get("loaderId"))
                .and_then(Value::as_str),
        ) {
            (Some(f), Some(l)) => (f.to_string(), l.to_string()),
            // No frame tree (the tab is closing under us): stay
            // unseeded; the next capture retries.
            _ => return Ok(()),
        };
        let (l1, c1, n1, dk1) = self.with_state(&rec.tab_id, |st| {
            (
                st.loading,
                st.committed,
                st.navigation_revision,
                document_key(st),
            )
        });
        if l1 || !c1 || n1 != nrev0 || dk1 != dk0 {
            return Ok(());
        }
        self.with_state(&rec.tab_id, |st| {
            st.main_frame_id = Some(frame_id);
            st.loader_id = Some(loader_id);
        });
        // Snapshot the identity right after seeding, then re-guard
        // after the probe (the recovered post-snapshot freshness check).
        let (nrev2, dk2) =
            self.with_state(&rec.tab_id, |st| (st.navigation_revision, document_key(st)));
        let probe = self.read_document_state(conn, &rec.cdp_session_id).await?;
        let (nrev3, dk3) =
            self.with_state(&rec.tab_id, |st| (st.navigation_revision, document_key(st)));
        if nrev3 != nrev2 || dk3 != dk2 {
            return Ok(());
        }
        let Some(p) = probe else {
            return Ok(());
        };
        self.with_state(&rec.tab_id, |st| {
            if let Some(href) = p.get("href").and_then(Value::as_str) {
                st.url = Some(href.to_string());
            }
            if p.get("painted").and_then(Value::as_bool) == Some(true) {
                st.painted = true;
            }
            match p.get("readyState").and_then(Value::as_str) {
                Some("complete") => {
                    st.tab_status = Some("complete".to_string());
                    st.painted = true;
                }
                Some(other) => {
                    st.loading = true;
                    st.tab_status = Some(other.to_string());
                }
                None => {}
            }
            st.initialized = true;
        });
        Ok(())
    }

    /// `probeNavigationState`: the nav state plus the live document
    /// element/text counts (feeds `q2` and `j2`).
    async fn probe_navigation_state(
        &self,
        conn: &CdpConn,
        session: &str,
        tab_id: &str,
    ) -> Result<NavState, BrowserError> {
        let mut ns = self.nav_state(tab_id);
        let v = self
            .evaluate_json(conn, session, NAVIGATION_STATE_PROBE)
            .await?;
        if let Some(obj) = v.as_object() {
            ns.document_element_count = obj
                .get("elementCount")
                .and_then(Value::as_u64)
                .map(|n| n as usize);
            ns.document_text_length = obj
                .get("textLength")
                .and_then(Value::as_u64)
                .map(|n| n as usize);
        }
        Ok(ns)
    }

    /// Read the tab's AX tree nodes with frame descent — the recovered
    /// `captureSessions`/`captureDocuments` sweep adapted to one flat
    /// tab session. Live-probed dialect law of the bundled build:
    /// `Accessibility.getFullAXTree` answers with ONLY the queried
    /// frame's subtree (the flat read leaves the `Iframe` node's
    /// `childIds` empty), so every child frame from
    /// `Page.getFrameTree` gets its own `getFullAXTree {frameId}`
    /// read, stitched onto the host `<iframe>` AX node through the
    /// `DOM.getFrameOwner` backendNodeId join (probe-verified equal
    /// both sides). Node ids are frame-local small integers that
    /// collide across frames, so each subtree is renumbered into a
    /// fresh id space before stitching. A frame whose reads fail
    /// degrades the way the recovered code warns (`Iframe …
    /// accessibility unavailable`): the capture proceeds without that
    /// frame's subtree rather than fabricating one.
    /// Phase 7: the merged cross-frame AX tree (see `full_ax_nodes`)
    /// re-expressed as the compact [`PwAxNode`] shape the aria-snapshot
    /// renderer walks. The raw wire decode stays here so `pw.rs` never
    /// touches `Accessibility` wire types.
    pub(crate) async fn pw_ax_nodes(
        &self,
        conn: &CdpConn,
        session: &str,
    ) -> Result<Vec<PwAxNode>, BrowserError> {
        let raw = self.full_ax_nodes(conn, session).await?;
        let nodes: Vec<RawNode> =
            serde_json::from_value(Value::Array(raw)).map_err(|e| BrowserError::Internal {
                detail: format!("merged AX tree decode failed: {e}"),
            })?;
        Ok(nodes
            .into_iter()
            .map(|n| PwAxNode {
                ignored: n.ignored,
                role: n.role_name(),
                name: n.name_str(),
                props: n
                    .properties
                    .iter()
                    .map(|p| {
                        let v = p
                            .value
                            .value
                            .clone()
                            .or_else(|| p.value.b.map(Value::Bool))
                            .unwrap_or(Value::Null);
                        (p.name.clone(), v)
                    })
                    .collect(),
                child_ids: n.child_ids.unwrap_or_default(),
                bnid: n.backend_dom_node_id,
                node_id: n.node_id,
            })
            .collect())
    }

    async fn full_ax_nodes(
        &self,
        conn: &CdpConn,
        session: &str,
    ) -> Result<Vec<Value>, BrowserError> {
        let main = conn
            .call(
                "Accessibility.getFullAXTree",
                Some(json!({ "includeAXNodeSources": true })),
                Some(session),
            )
            .await?;
        let mut nodes: Vec<Value> = match main.get("nodes") {
            Some(Value::Array(arr)) => arr.clone(),
            _ => return Ok(Vec::new()),
        };
        if nodes.is_empty() {
            return Ok(nodes);
        }
        let tree = conn
            .call("Page.getFrameTree", None, Some(session))
            .await
            .unwrap_or(Value::Null);
        // Flatten child frames breadth-first: a host `Iframe` node
        // must already be in `nodes` when its frame stitches onto it.
        let mut queue: Vec<String> = Vec::new();
        {
            let mut frontier: Vec<&Value> = tree
                .pointer("/frameTree/childFrames")
                .and_then(Value::as_array)
                .map(|a| a.iter().collect())
                .unwrap_or_default();
            while !frontier.is_empty() {
                let mut next: Vec<&Value> = Vec::new();
                for entry in frontier {
                    if let Some(id) = entry
                        .get("frame")
                        .and_then(|f| f.get("id"))
                        .and_then(Value::as_str)
                    {
                        queue.push(id.to_string());
                    }
                    if let Some(kids) = entry.get("childFrames").and_then(Value::as_array) {
                        next.extend(kids.iter());
                    }
                }
                frontier = next;
            }
        }
        let mut cursor = 0usize;
        // Fresh id space for frame subtrees (CDP axNodeIds are small
        // frame-local integers; negatives are InlineTextBox pseudo-ids).
        let mut next_id: i64 = 1_000_000_000;
        while cursor < queue.len() {
            let fid = queue[cursor].clone();
            cursor += 1;
            let owner = match conn
                .call(
                    "DOM.getFrameOwner",
                    Some(json!({ "frameId": fid.as_str() })),
                    Some(session),
                )
                .await
            {
                Ok(v) => v,
                Err(_) => continue,
            };
            let sub = match conn
                .call(
                    "Accessibility.getFullAXTree",
                    Some(json!({ "frameId": fid.as_str(), "includeAXNodeSources": true })),
                    Some(session),
                )
                .await
            {
                Ok(v) => v,
                Err(_) => continue,
            };
            let mut sub_nodes: Vec<Value> = match sub.get("nodes").and_then(Value::as_array) {
                Some(arr) if !arr.is_empty() => arr.clone(),
                _ => continue,
            };
            // Renumber the subtree into the fresh id space.
            let mut map: HashMap<String, String> = HashMap::with_capacity(sub_nodes.len());
            for n in sub_nodes.iter() {
                let old = n.get("nodeId").map(node_id_from_value).unwrap_or_default();
                let new = next_id.to_string();
                next_id += 1;
                if !old.is_empty() {
                    map.insert(old, new);
                }
            }
            let mut sub_root: Option<String> = None;
            for n in sub_nodes.iter_mut() {
                let Some(obj) = n.as_object_mut() else {
                    continue;
                };
                let old = obj
                    .get("nodeId")
                    .map(node_id_from_value)
                    .unwrap_or_default();
                let Some(new) = map.get(&old).cloned() else {
                    continue;
                };
                if sub_root.is_none()
                    && obj
                        .get("role")
                        .and_then(|r| r.get("value"))
                        .and_then(Value::as_str)
                        == Some("RootWebArea")
                    && obj.get("ignored").and_then(Value::as_bool) != Some(true)
                {
                    sub_root = Some(new.clone());
                }
                obj.insert("nodeId".to_string(), Value::String(new));
                if let Some(ch) = obj.get("childIds").cloned() {
                    // Unknown child ids drop silently (same law as the
                    // tree walk); never leave a stale frame-local id
                    // that could alias a main-tree node.
                    let rewritten: Vec<Value> = ch
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|c| {
                                    map.get(&node_id_from_value(c))
                                        .map(|n| Value::String(n.clone()))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    obj.insert("childIds".to_string(), Value::Array(rewritten));
                }
            }
            // Stitch onto the host <iframe> AX node. The join search
            // covers only the nodes present BEFORE this frame was
            // merged: backendNodeId uniqueness across frame snapshots
            // is not guaranteed, so never join against a just-merged
            // subtree.
            let host_idx = owner
                .get("backendNodeId")
                .and_then(Value::as_i64)
                .and_then(|b| {
                    nodes
                        .iter()
                        .position(|n| n.get("backendDOMNodeId").and_then(Value::as_i64) == Some(b))
                });
            if let (Some(h), Some(root_id)) = (host_idx, sub_root) {
                if let Some(o) = nodes[h].as_object_mut() {
                    match o.get_mut("childIds") {
                        Some(Value::Array(arr)) => arr.push(Value::String(root_id)),
                        _ => {
                            o.insert("childIds".to_string(), json!([root_id]));
                        }
                    }
                }
            }
            nodes.extend(sub_nodes);
        }
        Ok(nodes)
    }

    /// One candidate observation: the doc key + state snapshot taken
    /// BEFORE the tree read (so the freshness gate can tell a
    /// mid-read navigation apart), the merged tree read
    /// (`full_ax_nodes`: main frame + stitched child frames), the
    /// `DOMSnapshot` metas, and the diff against the committed
    /// same-document revision unless diffing is disabled.
    async fn capture_candidate(
        &self,
        conn: &CdpConn,
        session: &str,
        tab_id: &str,
        disable_diffing: bool,
    ) -> Result<Candidate, BrowserError> {
        let (doc_key, nav) =
            self.with_state(tab_id, |st| (document_key(st), NavState::from_state(st)));
        let tree_nodes = self.full_ax_nodes(conn, session).await?;
        let build = if tree_nodes.is_empty() {
            // Absent or empty tree → no build; capture() turns the
            // final candidate's missing build into the empty-capture
            // error (never an empty success).
            None
        } else {
            let raws: Vec<RawNode> =
                serde_json::from_value(Value::Array(tree_nodes)).map_err(|e| {
                    BrowserError::Internal {
                        detail: format!("Accessibility.getFullAXTree nodes parse failed: {e}"),
                    }
                })?;
            // The recovered literal is the exact dialect the
            // bundled build answers (live-probed: the modern
            // `computed` name is rejected outright).
            let snap = conn
                .call(
                    "DOMSnapshot.captureSnapshot",
                    Some(json!({
                        "computedStyles": [],
                        "includePaintOrder": false,
                        "includeDOMRects": false
                    })),
                    Some(session),
                )
                .await?;
            let metas = snapshot_meta(&snap);
            let prev = if disable_diffing {
                None
            } else {
                self.with_state(tab_id, |st| {
                    st.committed_rev
                        .as_ref()
                        .filter(|c| c.document_key == doc_key)
                        .cloned()
                })
            };
            Some(build_revision(tab_id, &raws, &metas, prev.as_ref()))
        };
        Ok(Candidate {
            doc_key,
            nav,
            build,
        })
    }

    /// `waitForNavigation`: when the snapshot was taken outside a
    /// load, first watch briefly for a revision bump (a navigation
    /// that started between the snapshot and now), then settle until
    /// loading clears or the document commits.
    async fn wait_for_navigation(&self, tab_id: &str, s: &NavState) -> NavState {
        if !s.loading {
            let deadline = Instant::now() + Duration::from_millis(NAV_DETECT_MS);
            loop {
                let cur = self.nav_state(tab_id);
                if cur.loading || cur.revision != s.revision {
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
                sleep(Duration::from_millis(POLL_MS)).await;
            }
        }
        let o = self.nav_state(tab_id);
        if !o.loading || o.committed {
            return o;
        }
        let deadline = Instant::now() + Duration::from_millis(NAV_DEADLINE_MS);
        loop {
            let cur = self.nav_state(tab_id);
            if !cur.loading || cur.committed {
                return cur;
            }
            if Instant::now() >= deadline {
                return cur;
            }
            sleep(Duration::from_millis(POLL_MS)).await;
        }
    }

    /// `waitForFirstPaint` from a known snapshot: settle while the
    /// document is committed-but-unpainted.
    async fn wait_for_first_paint_from(&self, tab_id: &str, s: &NavState) -> NavState {
        if !(s.committed && !s.painted) {
            return self.nav_state(tab_id);
        }
        let deadline = Instant::now() + Duration::from_millis(PAINT_DEADLINE_MS);
        loop {
            let cur = self.nav_state(tab_id);
            if cur.painted || cur.tab_status.as_deref() == Some("complete") {
                return cur;
            }
            if Instant::now() >= deadline {
                return cur;
            }
            sleep(Duration::from_millis(POLL_MS)).await;
        }
    }

    async fn wait_for_first_paint(&self, tab_id: &str) -> NavState {
        let s = self.nav_state(tab_id);
        self.wait_for_first_paint_from(tab_id, &s).await
    }

    /// `waitForAXQuiet`: quiet against the LAST AX-update clock. The
    /// baseline `max(now, last update)` is captured once at entry;
    /// the window closes when that baseline is `threshold` ms in the
    /// past (forced captures use the shorter threshold).
    async fn wait_for_ax_quiet(&self, tab_id: &str, forced: bool) -> NavState {
        let threshold = if forced {
            AX_QUIET_THRESHOLD_FORCED_MS
        } else {
            AX_QUIET_THRESHOLD_MS
        };
        let base = epoch_ms().max(self.with_state(tab_id, |st| st.last_ax_update_ms));
        let deadline = Instant::now() + Duration::from_millis(AX_QUIET_DEADLINE_MS);
        loop {
            if epoch_ms().saturating_sub(base) >= threshold as i64 {
                return self.nav_state(tab_id);
            }
            if Instant::now() >= deadline {
                return self.nav_state(tab_id);
            }
            sleep(Duration::from_millis(AX_QUIET_POLL_MS)).await;
        }
    }

    /// The H-BS-26 `capture()` state machine (module docs carry the
    /// [adapted] finite-attempt bound). The reference's `while(true)`
    /// read loop is bounded here; the executor's own retry (H-BS-28)
    /// sits on top.
    pub(crate) async fn capture(
        &self,
        conn: &CdpConn,
        rec: &TabRecord,
        disable_diffing: bool,
    ) -> Result<AxCaptureResult, BrowserError> {
        let session = rec.cdp_session_id.as_str();
        let tab_id = rec.tab_id.as_str();
        self.ensure_tracked(conn, rec).await?;

        // The pending-navigation snapshot (recorded by the nav events
        // themselves) is the anchor when one exists; otherwise the
        // current state anchors, with a fast-path capture when the
        // page is not loading at all.
        let s = match self.with_state(tab_id, |st| st.pending_navigation.clone()) {
            Some(s) => s,
            None => {
                let f = self.nav_state(tab_id);
                if !f.loading {
                    let cand = self
                        .capture_candidate(conn, session, tab_id, disable_diffing)
                        .await?;
                    if let Some(r) = self.commit_capture(tab_id, rec, &cand) {
                        return Ok(r);
                    }
                }
                self.with_state(tab_id, |st| {
                    if st.pending_navigation.is_none() {
                        st.pending_navigation = Some(f.clone());
                    }
                });
                f
            }
        };

        let mut a = self.wait_for_navigation(tab_id, &s).await;
        let mut l = s.loading || s.navigation_revision != a.navigation_revision;
        if l {
            // The wait is the point; the quiet window below re-anchors
            // the nav state, so its return value is not consumed here.
            self.wait_for_first_paint(tab_id).await;
        }
        a = self.wait_for_ax_quiet(tab_id, l).await;

        let mut replaced = false;
        for _ in 0..CAPTURE_ATTEMPTS {
            let cand = self
                .capture_candidate(conn, session, tab_id, disable_diffing)
                .await?;
            let build = cand.build.as_ref().ok_or(BrowserError::AxCaptureEmpty)?;
            let mut ns = self.nav_state(tab_id);
            if l && !replaced && build.element_count < LARGE_DOM_PROBE_UNDER {
                let probe = self.probe_navigation_state(conn, session, tab_id).await?;
                if q2(build.element_count, &probe) {
                    // The tree read lagged a large-DOM growth:
                    // discard this candidate, let the page breathe,
                    // and re-anchor on the probe.
                    replaced = true;
                    sleep(Duration::from_millis(LARGE_DOM_PAUSE_MS)).await;
                    a = probe;
                    continue;
                }
                ns = probe;
            }
            let settled_same_page = j2(cand.nav.url.as_deref(), &ns);
            if (!ns.loading && ns.revision == a.revision) || settled_same_page {
                if let Some(r) = self.commit_capture(tab_id, rec, &cand) {
                    return Ok(r);
                }
                // The freshness gate failed (the document changed
                // mid-read): re-anchor with a forced short quiet
                // window and try again.
                l = true;
                self.wait_for_first_paint(tab_id).await;
                a = self.wait_for_ax_quiet(tab_id, true).await;
                continue;
            }
            a = if ns.loading || ns.navigation_revision != a.navigation_revision {
                self.wait_for_first_paint_from(tab_id, &ns).await
            } else {
                ns
            };
        }

        // Final commit attempt: the last candidate must belong to the
        // current document or the capture errors out honestly.
        let cand = self
            .capture_candidate(conn, session, tab_id, disable_diffing)
            .await?;
        if cand.build.is_none() {
            return Err(BrowserError::AxCaptureEmpty);
        }
        self.commit_capture(tab_id, rec, &cand)
            .ok_or(BrowserError::AxCaptureChangedBeforeCommitted)
    }

    /// Freshness gate + commit: the candidate must belong to the
    /// CURRENT document (the recovered `captureFrame.name ===
    /// documentKey` check); success records the revision for the next
    /// diff and clears the pending navigation. The header follows the
    /// recovered template; a missing state URL falls back to the
    /// literal "Unknown" ([adapted] fallback naming).
    fn commit_capture(
        &self,
        tab_id: &str,
        rec: &TabRecord,
        cand: &Candidate,
    ) -> Option<AxCaptureResult> {
        let build = cand.build.as_ref()?;
        let outcome = self.with_state(tab_id, |st| -> Option<String> {
            if document_key(st) != cand.doc_key {
                return None;
            }
            st.committed_rev = Some(CommittedRev {
                document_key: cand.doc_key.clone(),
                entries: build.entries.clone(),
                targets: build.targets.clone(),
            });
            st.pending_navigation = None;
            Some(st.url.clone().unwrap_or_else(|| "Unknown".to_string()))
        })?;
        let title = if rec.title.is_empty() {
            "Unknown"
        } else {
            rec.title.as_str()
        };
        let header = format!(
            "Browser tab: {}, Title: {}, URL: {}.",
            rec.tab_id,
            json_quote(title),
            json_quote(&outcome)
        );
        Some(AxCaptureResult {
            state: format!("{header}\n{}", build.text),
            document_key: cand.doc_key.clone(),
            element_count: build.element_count,
            used_diff: build.used_diff,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes(v: Value) -> Vec<RawNode> {
        serde_json::from_value(v).expect("fixture AX nodes parse")
    }

    fn ns(
        painted: bool,
        count: Option<usize>,
        url: Option<&str>,
        status: Option<&str>,
    ) -> NavState {
        NavState {
            revision: 0,
            navigation_revision: 0,
            loading: false,
            committed: true,
            painted,
            tab_status: status.map(|s| s.to_string()),
            url: url.map(|s| s.to_string()),
            document_id: None,
            last_ax_update_ms: 0,
            document_element_count: count,
            document_text_length: None,
        }
    }

    #[test]
    fn document_key_separates_frame_and_loader() {
        assert_eq!(document_key(&TabAx::default()), ":");
        let st = TabAx {
            main_frame_id: Some("F".to_string()),
            loader_id: Some("L".to_string()),
            ..TabAx::default()
        };
        assert_eq!(document_key(&st), "F:L");
    }

    #[test]
    fn ax_element_resolves_committed_targets_with_both_document_keys() {
        let reg = AxRegistries::default();
        reg.with_state("t1", |st| {
            st.main_frame_id = Some("F".into());
            st.loader_id = Some("L".into());
            let mut targets = HashMap::new();
            targets.insert(
                "id-1".to_string(),
                AxTargetInfo {
                    element_index: 3,
                    identity: "id-1".into(),
                    backend_dom_node_id: Some(77),
                    action_descriptions: vec!["Expand".into()],
                    is_option_element: false,
                },
            );
            st.committed_rev = Some(CommittedRev {
                document_key: "F:L".into(),
                entries: Vec::new(),
                targets,
            });
        });
        let r = reg.ax_element("t1", 3).expect("element 3 resolves");
        assert_eq!(r.committed_document_key, "F:L");
        assert_eq!(r.current_document_key, "F:L");
        assert_eq!(r.target.backend_dom_node_id, Some(77));
        assert!(r.target.action_descriptions.contains(&"Expand".to_string()));
        // Index not on the committed page → absent (StaleAxElement).
        assert!(reg.ax_element("t1", 9).is_none());
        assert!(reg.ax_element("no-tab", 3).is_none());
        // A loader swap under the same revision surfaces the
        // previous-page distinction to the action path.
        reg.with_state("t1", |st| st.loader_id = Some("L2".into()));
        let r2 = reg.ax_element("t1", 3).expect("still resolvable");
        assert_eq!(r2.committed_document_key, "F:L");
        assert_eq!(r2.current_document_key, "F:L2");
    }

    /// Parity with the DOM CUA password guard needles: the unbounded
    /// ones are plain substrings (`telephone` hits through `phone`),
    /// the short tokens are word-boundary-bounded (`telnet`/`hotel`/
    /// `x2fa` must NOT hit).
    #[test]
    fn credential_matcher_parity_with_dom_guard() {
        for hit in [
            "telephone",
            "tel",
            " Password ",
            "Email",
            "user name",
            "one_time_code",
            "OTP",
            "your otp",
            "username",
            "e-mail",
            "smartphone",
            "auth-2fa",
            "2FA",
            "mfa",
            "mobile",
            "passcode",
            "passwd",
        ] {
            assert!(credential_hit(hit), "expected credential hit: {hit}");
        }
        for miss in ["telnet", "hotel", "x2fa", "compare", "amount"] {
            assert!(!credential_hit(miss), "expected no hit: {miss}");
        }
    }

    #[test]
    fn q2_large_dom_probe() {
        assert!(q2(
            4,
            &NavState {
                document_element_count: Some(160),
                ..ns(false, None, None, None)
            }
        ));
        assert!(!q2(
            60,
            &NavState {
                document_element_count: Some(179),
                ..ns(false, None, None, None)
            }
        ));
        assert!(q2(
            40,
            &NavState {
                document_text_length: Some(4_000),
                ..ns(false, None, None, None)
            }
        ));
    }

    #[test]
    fn j2_settled_same_document() {
        let settled = ns(true, Some(10), Some("http://x.test/a?q=1"), None);
        assert!(j2(Some("http://x.test/a"), &settled));
        assert!(!j2(Some("http://x.test/b"), &settled));
        let weird = ns(true, Some(10), Some("not a url"), None);
        assert!(j2(Some("not a url"), &weird));
        assert!(!j2(
            Some("http://x.test/a"),
            &ns(true, Some(9), Some("http://x.test/a"), None)
        ));
        assert!(j2(
            Some("http://x.test/a"),
            &ns(false, Some(10), Some("http://x.test/a"), Some("complete"))
        ));
    }

    #[test]
    fn compact_id_ranges_collapses_runs() {
        assert_eq!(compact_id_ranges(&[]), "");
        assert_eq!(compact_id_ranges(&[0, 1, 2, 5, 7, 8]), "0-2,5,7-8");
        assert_eq!(compact_id_ranges(&[5]), "5");
    }

    #[test]
    fn identity_is_bytelength_prefixed_segments() {
        let with_backend = nodes(json!([{"nodeId": 1, "backendDOMNodeId": 123}]));
        // "{}:{}" with an empty target segment renders as "0:" (one
        // colon), so the middle segment is "0:", not "0::".
        assert_eq!(with_backend[0].identity("3"), "1:3|0:|3:123");
        let fallback = nodes(json!([{"nodeId": 9}]));
        assert_eq!(fallback[0].identity("3"), "1:3|0:|2:n9");
    }

    #[test]
    fn revision_grammar_and_targets() {
        let raws = nodes(json!([
            {"nodeId": 1, "role": {"type": "role", "value": "RootWebArea"}, "childIds": [2, 3]},
            {"nodeId": 2, "ignored": true, "childIds": [4]},
            {"nodeId": 3, "role": {"type": "role", "value": "button"},
             "name": {"type": "string", "value": "say \"x\""}, "backendDOMNodeId": 30},
            {"nodeId": 4, "role": {"type": "role", "value": "textbox"},
             "name": {"type": "string", "value": "hi"}, "backendDOMNodeId": 40,
             "properties": [
                 {"name": "focused", "value": {"type": "boolean", "value": true}},
                 {"name": "disabled", "value": {"type": "boolean", "value": false}}
             ]}
        ]));
        let b = build_revision("t3", &raws, &HashMap::new(), None);
        assert_eq!(b.element_count, 3);
        // Ignored wrappers are transparent (node 4 attaches at depth 1
        // beside node 3), false props drop, and names JSON-quote.
        assert_eq!(
            b.text,
            "- RootWebArea [id=0]:\n  - button \"say \\\"x\\\"\" [id=1]\n  - textbox \"hi\" [id=2] [focused]"
        );
        let t = b.targets.get("2:t3|0:|2:30").expect("button target");
        assert_eq!(t.element_index, 1);
        assert!(!t.is_option_element);
        assert!(t.action_descriptions.is_empty());
        for e in &b.entries {
            assert!(!e.sig.contains("[id="), "sig must not carry the id tag");
        }
    }

    #[test]
    fn credential_fields_never_render() {
        let raws = nodes(json!([
            {"nodeId": 7, "role": {"value": "textbox"},
             "name": {"type": "string", "value": "hunter2",
                      "sources": [{"attribute": "value", "value": "hunter2"}]},
             "value": {"type": "string", "value": "hunter2"},
             "backendDOMNodeId": 20,
             "properties": [{"name": "valuetext", "value": {"type": "string", "value": "hunter2"}}]}
        ]));
        let mut metas: HashMap<i64, NodeMeta> = HashMap::new();
        metas.insert(
            20,
            NodeMeta {
                tag_name: Some("input".to_string()),
                credential: true,
                closed: None,
            },
        );
        let b = build_revision("t8", &raws, &metas, None);
        // The name (value-sourced) hides and valuetext drops: the
        // secret never reaches the model at all (mre rule port).
        assert_eq!(b.text, "- textbox [id=0]");
        assert!(!b.text.contains("hunter2"));
    }

    #[test]
    fn closed_shadow_ancestor_and_inside() {
        let raws = nodes(json!([
            {"nodeId": 1, "role": {"value": "RootWebArea"}, "childIds": [2]},
            {"nodeId": 2, "role": {"value": "generic"}, "childIds": [3], "backendDOMNodeId": 20},
            {"nodeId": 3, "role": {"value": "textbox"},
             "name": {"type": "string", "value": "secret text",
                      "sources": [{"type": "contents", "value": "secret text"}]}}
        ]));
        // Ancestor: the closed-shadow HOST is kept, but its
        // contents-sourced descendants' names fold hidden text → hide.
        let mut metas: HashMap<i64, NodeMeta> = HashMap::new();
        metas.insert(
            20,
            NodeMeta {
                tag_name: None,
                credential: false,
                closed: Some(ClosedMark::Ancestor),
            },
        );
        let b = build_revision("t9", &raws, &metas, None);
        assert_eq!(
            b.text,
            "- RootWebArea [id=0]:\n  - generic [id=1]:\n    - textbox [id=2]"
        );
        assert!(!b.text.contains("secret text"));
        // Inside: the host plus every descendant leaves the revision.
        let mut metas2: HashMap<i64, NodeMeta> = HashMap::new();
        metas2.insert(
            20,
            NodeMeta {
                tag_name: None,
                credential: false,
                closed: Some(ClosedMark::Inside),
            },
        );
        let b2 = build_revision("t9", &raws, &metas2, None);
        assert_eq!(b2.element_count, 1);
        assert_eq!(b2.text, "- RootWebArea [id=0]");
    }

    #[test]
    fn diff_format_and_saved_budget() {
        // The 900-char node is KEPT in both trees: a diff only wins
        // the savings gate when omitting unchanged lines makes it at
        // least MIN_SAVED_BYTES smaller than the full tree it
        // replaces. (A tree that merely shrinks can never diff-win —
        // the header alone outweighs it — so the full payload is the
        // correct fallback there, as the small-change test pins.)
        let big = "x".repeat(900);
        let rawa = nodes(json!([
            {"nodeId": 1, "role": {"value": "RootWebArea"}, "childIds": [2, 3, 4]},
            {"nodeId": 2, "role": {"value": "generic"},
             "name": {"type": "string", "value": big}, "backendDOMNodeId": 21},
            {"nodeId": 3, "role": {"value": "generic"},
             "name": {"type": "string", "value": "ttt"}, "backendDOMNodeId": 31},
            {"nodeId": 4, "role": {"value": "generic"},
             "name": {"type": "string", "value": "gone"}, "backendDOMNodeId": 60}
        ]));
        let builda = build_revision("t10", &rawa, &HashMap::new(), None);
        assert!(!builda.used_diff);
        let prev = CommittedRev {
            document_key: "F:L".to_string(),
            entries: builda.entries.clone(),
            targets: builda.targets.clone(),
        };
        let rawb = nodes(json!([
            {"nodeId": 1, "role": {"value": "RootWebArea"}, "childIds": [2, 3, 4]},
            {"nodeId": 2, "role": {"value": "generic"},
             "name": {"type": "string", "value": big}, "backendDOMNodeId": 21},
            {"nodeId": 3, "role": {"value": "searchbox"},
             "name": {"type": "string", "value": "ttt2"}, "backendDOMNodeId": 31},
            {"nodeId": 4, "role": {"value": "generic"},
             "name": {"type": "string", "value": "new"}, "backendDOMNodeId": 50}
        ]));
        let buildb = build_revision("t10", &rawb, &HashMap::new(), Some(&prev));
        assert!(buildb.used_diff);
        assert_eq!(buildb.element_count, 4);
        // ~ for a changed sig at a matched identity, + for a new
        // identity, unchanged elements (the root line and the big
        // node) omitted entirely, and the removed position collapsed
        // into an id range. Ids stay positional ([id=2]/[id=3] count
        // the omitted lines too).
        assert_eq!(
            buildb.text,
            format!(
                "{DIFF_HEADER}\n  ~ searchbox \"ttt2\" [id=2]\n  + generic \"new\" [id=3]\n{REMOVED_PREFIX}3"
            )
        );
    }

    #[test]
    fn small_diff_falls_back_to_full_tree() {
        let rawa = nodes(json!([
            {"nodeId": 1, "role": {"value": "RootWebArea"}, "childIds": [2]},
            {"nodeId": 2, "role": {"value": "generic"},
             "name": {"type": "string", "value": "a"}, "backendDOMNodeId": 21}
        ]));
        let builda = build_revision("t11", &rawa, &HashMap::new(), None);
        let prev = CommittedRev {
            document_key: "F:L".to_string(),
            entries: builda.entries.clone(),
            targets: builda.targets.clone(),
        };
        let rawb = nodes(json!([
            {"nodeId": 1, "role": {"value": "RootWebArea"}, "childIds": [2]},
            {"nodeId": 2, "role": {"value": "generic"},
             "name": {"type": "string", "value": "b"}, "backendDOMNodeId": 21}
        ]));
        let buildb = build_revision("t11", &rawb, &HashMap::new(), Some(&prev));
        assert!(!buildb.used_diff);
        assert_eq!(
            buildb.text,
            "- RootWebArea [id=0]:\n  - generic \"b\" [id=1]"
        );
    }

    #[test]
    fn unchanged_document_renders_the_no_change_sentinel() {
        let rawa = nodes(json!([
            {"nodeId": 1, "role": {"value": "RootWebArea"}, "childIds": [2]},
            {"nodeId": 2, "role": {"value": "generic"},
             "name": {"type": "string", "value": "steady"}, "backendDOMNodeId": 21}
        ]));
        let builda = build_revision("t12", &rawa, &HashMap::new(), None);
        let prev = CommittedRev {
            document_key: "F:L".to_string(),
            entries: builda.entries.clone(),
            targets: builda.targets.clone(),
        };
        let buildb = build_revision("t12", &rawa, &HashMap::new(), Some(&prev));
        assert!(buildb.used_diff);
        assert_eq!(buildb.text, NO_CHANGE_TEXT);
    }

    fn name_src(sources: Value) -> Option<&'static str> {
        let n = nodes(json!([{"nodeId": 1, "name": {"value": "x", "sources": sources}}]));
        name_source(n[0].name.as_ref())
    }

    #[test]
    fn name_source_classification() {
        assert_eq!(
            name_src(json!([
                {"superseded": true, "attribute": "data-x", "value": "z"},
                {"attribute": "placeholder"}
            ])),
            Some("placeholder")
        );
        assert_eq!(
            name_src(json!([{"superseded": true, "attribute": "data-x", "value": "z"}])),
            Some("attribute")
        );
        assert_eq!(
            name_src(
                json!([{"attribute": "aria-labelledby", "type": "relatedElement", "value": "x"}])
            ),
            Some("relatedElement")
        );
    }

    #[test]
    fn navigation_state_machine_pins() {
        let reg = AxRegistries::default();
        reg.on_frame_started_loading("t1", "F", Some("L1"));
        let n = reg.nav_state("t1");
        assert_eq!(n.revision, 1);
        assert_eq!(n.navigation_revision, 1);
        assert!(n.loading);
        assert_eq!(
            reg.with_state("t1", |st| st
                .provisional
                .as_ref()
                .and_then(|p| p.document_id.clone())),
            Some("L1".to_string())
        );
        // A second provisional load in the same cycle neither
        // re-seeds the provisional nor bumps the revision (already
        // loading → lv() does not bump).
        reg.on_frame_started_loading("t1", "F", Some("L2"));
        assert_eq!(reg.nav_state("t1").revision, 1);
        assert_eq!(
            reg.with_state("t1", |st| st
                .provisional
                .as_ref()
                .and_then(|p| p.document_id.clone())),
            Some("L1".to_string())
        );
        reg.on_main_frame_navigated("t1", "F", Some("L2"), Some("http://a.test/"), false);
        let n = reg.nav_state("t1");
        assert!(n.committed);
        // loading stays true until domContent/load/stop fires (the
        // main-frame nav event itself only clears it for bfcache).
        assert!(n.loading);
        assert_eq!(n.url.as_deref(), Some("http://a.test/"));
        assert_eq!(
            reg.with_state("t1", |st| (
                st.pending_navigation.is_some(),
                st.provisional.is_none()
            )),
            (true, true)
        );
        reg.on_load_event("t1");
        assert_eq!(reg.nav_state("t1").tab_status.as_deref(), Some("complete"));
        // Fragment nav: URL updates, no revision bump.
        reg.on_navigated_within_document("t1", "F", "http://a.test/#x", "fragment");
        assert_eq!(reg.nav_state("t1").revision, 1);
        // History-style same-document nav: revision bumps.
        reg.on_navigated_within_document("t1", "F", "http://a.test/", "");
        assert_eq!(reg.nav_state("t1").revision, 2);
        reg.note_ax_update("t1");
        assert!(reg.nav_state("t1").last_ax_update_ms > 0);
        reg.on_dialog_event("t1");
        assert_eq!(reg.nav_state("t1").revision, 3);

        // BackForwardCacheRestore: the nav event flips loading off and
        // the restored document is already painted.
        let reg2 = AxRegistries::default();
        reg2.on_frame_started_loading("t2", "F", Some("L1"));
        reg2.on_main_frame_navigated("t2", "F", Some("L2"), None, true);
        let n2 = reg2.nav_state("t2");
        assert!(n2.painted);
        assert!(!n2.loading);

        reg.with_state("t1", |st| {
            st.committed_rev = Some(CommittedRev {
                document_key: "x".to_string(),
                entries: Vec::new(),
                targets: HashMap::new(),
            })
        });
        reg.invalidate_subtree("t1");
        assert!(reg.with_state("t1", |st| st.committed_rev.is_none()));
    }
}
