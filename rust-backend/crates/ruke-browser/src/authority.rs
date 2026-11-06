//! authority.rs — Phase 9: the per-origin authority model.
//!
//! Recovered shape (schemas-and-ipc §2.3/§5, H-BS-4/H-BS-19): every
//! tab-driving handler begins with an authority assertion over the
//! tab's *current* URL, keyed by registrable domain. The facets are
//! the recovered set — `access`, `uploads`, `downloads`,
//! `full_cdp_access` — and the per-facet decision is
//! `deny | always_ask | never_ask`, where `always_ask` is the default
//! and a site rule can pin a facet to the other two. The recovered
//! denial for a persisted deny (H-BS-19) is kept verbatim:
//! **"A saved permission or managed policy denies access."**
//!
//! [adapted] reference wiring: Ruke has no enterprise network-policy
//! layer, so "managed policy" collapses into the user-persisted rules
//! file (`<root>/ruke-browser-policy.json`, written by the Panel's
//! Block / Always-allow answers and the human-side policy routes).
//! The approval UX is the Browser Panel socket: an `always_ask` hit
//! broadcasts an `approval_request` frame and waits for the human's
//! `approval` response. No panel connected ⇒ fail closed (a headless
//! approval queue would either hang the model turn or silently allow).
//! The human's own panel commands (turn id `UI_TURN_ID` — the same
//! constant the Next client exports) are never gated: per the Phase-3
//! contract the human owns their browser; the gates police the *model*.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use url::Url;

use crate::contract::Command;
use crate::engine::BrowserRuntime;
use crate::errors::BrowserError;
use crate::session::TurnKey;
use crate::ui::{mix_seed, splitmix64};

/// How long a `tab`-driving command waits for the human to answer an
/// approval card before it fails closed. [adapted] — the reference
/// approval lifetime is UI-managed and not pinned in the capture.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// The turn id the human panel drives commands under (must stay in
/// lock-step with `UI_TURN_ID` exported by lib/browser-client). Human
/// commands skip the authority gates: the gates exist to police the
/// model, and a human cannot usefully approve their own clicks.
pub const HUMAN_TURN_ID: &str = "ui";

/// Persisted policy file, under the engine root. [adapted] location;
/// the recovered settings live in the desktop app's store, which has
/// no Ruke equivalent.
const POLICY_FILE: &str = "ruke-browser-policy.json";

/// The recovered capability facets (schemas-and-ipc §5, names
/// verbatim). `access` gates page observation and in-frame action;
/// the other three are the escalation facets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Facet {
    Access,
    Uploads,
    Downloads,
    FullCdpAccess,
    /// Phase 13 [adapted]: the recovered browsing-history authority
    /// verb (`readBrowsingHistory`) spans every origin — browsing data
    /// belongs to the session, not to a page — so this facet keys the
    /// global `"*"` policy row instead of a registrable host.
    History,
}

impl Facet {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Access => "access",
            Self::Uploads => "uploads",
            Self::Downloads => "downloads",
            Self::FullCdpAccess => "full_cdp_access",
            Self::History => "history",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "access" => Some(Self::Access),
            "uploads" => Some(Self::Uploads),
            "downloads" => Some(Self::Downloads),
            "full_cdp_access" => Some(Self::FullCdpAccess),
            "history" => Some(Self::History),
            _ => None,
        }
    }
}

/// Per-(domain, facet) decision (recovered decision values verbatim;
/// the capture's other decision constants were not recovered, so the
/// three that drive this model are the three implemented —
/// [adapted] completeness note).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Deny,
    AlwaysAsk,
    NeverAsk,
}

impl Decision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::AlwaysAsk => "always_ask",
            Self::NeverAsk => "never_ask",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "deny" => Some(Self::Deny),
            "always_ask" => Some(Self::AlwaysAsk),
            "never_ask" => Some(Self::NeverAsk),
            _ => None,
        }
    }
}

/// Registrable domain for a URL string (the `psl::domain_str` precedent
/// from `ruke_server::url_detector`, moved there 2026-11-03): `sub.example.co.uk` keys on
/// `example.co.uk`. Unknown suffixes and single-label hosts (e.g.
/// `localhost`) fall back to the full host so local dev fixtures still
/// get stable policy rows.
pub fn registrable_host(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    Some(
        psl::domain_str(host)
            .map(str::to_string)
            .unwrap_or_else(|| host.to_string()),
    )
}

/// Origin (`scheme://host[:port]`) of a parsed URL — the browserAuth
/// origin floor compares these, not full URLs.
pub fn origin_of(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    }
}

// ── persisted policy store ─────────────────────────────────────────────

/// The persisted (domain → facet → decision) rules, loaded once at
/// engine start. Missing or corrupt files are an *empty* store — the
/// all-`always_ask` default — never a startup failure.
#[derive(Debug)]
pub struct AuthorityStore {
    path: PathBuf,
    rules: Mutex<HashMap<String, HashMap<Facet, Decision>>>,
}

impl AuthorityStore {
    pub fn load(root: &std::path::Path) -> Self {
        let path = root.join(POLICY_FILE);
        let rules = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|v| parse_rules(&v))
            .unwrap_or_default();
        Self {
            path,
            rules: Mutex::new(rules),
        }
    }

    /// Decision for one (url, facet) with the two recovered merge
    /// laws: an explicit `deny` on ANY facet of the domain never
    /// re-enables (deny floor), and denying `access` cascades over
    /// the escalation facets (no uploads/downloads/CDP on a site the
    /// page itself is blocked from).
    pub fn decision_for(&self, url: &str, facet: Facet) -> Decision {
        let Some(host) = registrable_host(url) else {
            return Decision::AlwaysAsk;
        };
        self.decision(&host, facet)
    }

    pub fn decision(&self, host: &str, facet: Facet) -> Decision {
        let rules = self.rules.lock();
        let Some(facets) = rules.get(host) else {
            return Decision::AlwaysAsk;
        };
        if matches!(facets.get(&Facet::Access), Some(Decision::Deny)) {
            return Decision::Deny;
        }
        facets.get(&facet).copied().unwrap_or(Decision::AlwaysAsk)
    }

    /// Set one rule and persist the whole store (best effort: a failed
    /// write leaves the in-memory rules live and is logged, never a
    /// command failure — the decision already made this turn stands).
    pub fn set(&self, host: &str, facet: Facet, decision: Decision) {
        {
            let mut rules = self.rules.lock();
            rules
                .entry(host.to_string())
                .or_default()
                .insert(facet, decision);
        }
        self.persist();
    }

    /// Remove a whole domain's rules (policy UI "forget this site").
    pub fn clear_host(&self, host: &str) {
        self.rules.lock().remove(host);
        self.persist();
    }

    fn persist(&self) {
        let value = json!({
            "rules": self.rules.lock().iter().map(|(host, facets)| {
                (
                    host.clone(),
                    Value::Object(
                        facets
                            .iter()
                            .map(|(f, d)| {
                                (f.as_str().to_string(), Value::String(d.as_str().to_string()))
                            })
                            .collect(),
                    ),
                )
            }).collect::<serde_json::Map<_, _>>(),
        });
        if let Err(e) = std::fs::write(&self.path, value.to_string()) {
            tracing::warn!(error = %e, "browser policy file write failed (in-memory rules stand)");
        }
    }

    /// Human-side listing for the policy GET route.
    pub fn list(&self) -> Vec<Value> {
        self.rules
            .lock()
            .iter()
            .flat_map(|(host, facets)| {
                facets.iter().map(move |(f, d)| {
                    json!({ "host": host, "facet": f.as_str(), "decision": d.as_str() })
                })
            })
            .collect()
    }
}

/// Lenient parse: unknown keys/facets/decisions are skipped, so a
/// future-format file never poisons the current one.
fn parse_rules(value: &Value) -> HashMap<String, HashMap<Facet, Decision>> {
    let mut out = HashMap::new();
    let Some(rules) = value.get("rules").and_then(Value::as_object) else {
        return out;
    };
    for (host, facets) in rules {
        let Some(facets) = facets.as_object() else {
            continue;
        };
        for (facet, decision) in facets {
            let (Some(facet), Some(decision)) = (
                Facet::parse(facet),
                decision.as_str().and_then(Decision::parse),
            ) else {
                continue;
            };
            out.entry(host.clone()).or_default().insert(facet, decision);
        }
    }
    out
}

// ── pending human approvals ────────────────────────────────────────────

/// One waiter parked on a panel decision. `kind` distinguishes the
/// permission card (`"permission"`) from the sign-in handoff form
/// (`"auth_handoff"`) — the panel answers with the same
/// `{id, …}` response frame either way.
#[derive(Debug)]
struct PendingApproval {
    tab_id: String,
    /// The turn that parked this card (Phase 11): `end_turn` and the
    /// turn guard's Drop fail it closed when its owner is gone.
    key: TurnKey,
    tx: oneshot::Sender<Value>,
}

#[derive(Debug, Default)]
pub struct ApprovalRegistry {
    seed: Mutex<u64>,
    pending: Mutex<HashMap<String, PendingApproval>>,
}

impl ApprovalRegistry {
    pub fn new() -> Self {
        Self {
            seed: Mutex::new(mix_seed()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Mint a decision id + its waiter. Ids are 16 hex chars from the
    /// same std-only splitmix stream the WS tickets use ([adapted]
    /// shape; the reference ids are Gc-managed opaque handles).
    pub fn register(&self, tab_id: &str, key: &TurnKey) -> (String, oneshot::Receiver<Value>) {
        let id = {
            let mut seed = self.seed.lock();
            loop {
                let candidate = format!("{:016x}", splitmix64(&mut seed));
                if !self.pending.lock().contains_key(&candidate) {
                    break candidate;
                }
            }
        };
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(
            id.clone(),
            PendingApproval {
                tab_id: tab_id.to_string(),
                key: key.clone(),
                tx,
            },
        );
        (id, rx)
    }

    /// Answer a pending card. False = unknown or already-answered id.
    pub fn resolve(&self, id: &str, value: &Value) -> bool {
        match self.pending.lock().remove(id) {
            Some(pending) => pending.tx.send(value.clone()).is_ok(),
            None => false,
        }
    }

    /// Tab vanished (closed / destroyed / turn cleanup): park no more.
    /// Dropping the sender makes the waiting command fail closed.
    pub fn forget_tab(&self, tab_id: &str) {
        self.pending.lock().retain(|_, p| p.tab_id != tab_id);
    }

    /// Drop one parked waiter by id (the waiter timed out engine-side;
    /// a late panel answer for it must read as "unknown approval id").
    pub fn forget(&self, id: &str) -> bool {
        self.pending.lock().remove(id).is_some()
    }

    /// The turn that parked these cards is over (`end_turn` / guard
    /// Drop, Phase 11): park no more for it. Returns the forgotten ids
    /// so the engine can tell the panel to prune exactly those cards.
    pub fn forget_turn(&self, key: &TurnKey) -> Vec<String> {
        let mut forgotten = Vec::new();
        self.pending.lock().retain(|id, p| {
            if p.key == *key {
                forgotten.push(id.clone());
                false
            } else {
                true
            }
        });
        forgotten
    }

    /// Host death / engine shutdown: every waiter fails closed.
    pub fn cancel_all(&self) {
        self.pending.lock().clear();
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().len()
    }
}

// ── parked waits: answer | timeout | turn-cancel ──────────────────────

/// How a parked panel-card wait ended (Phase 11).
#[derive(Debug)]
pub(crate) enum Parked {
    /// The human answered; the value is the answer frame.
    Answer(Value),
    /// The wait budget elapsed; the registry entry was dropped.
    Expired,
    /// The turn that parked the wait ended (Stop, disconnect, round
    /// cap, task abort); the registry entry was dropped.
    Cancelled,
    /// The tab or panel vanished while parked (sender closed).
    SenderClosed,
}

impl BrowserRuntime {
    /// Park a panel-card waiter on ALL of its exits: the human's
    /// answer, the timeout, and — Phase 11 — the owning turn's
    /// cancellation. A parked wait must never outlive the turn that
    /// parked it, so it also selects on the token registered by
    /// [`begin_turn`](Self::begin_turn); `end_turn` and the turn
    /// guard's Drop fire it. On Expired/Cancelled the entry is
    /// forgotten and the panel is told the card went stale, so
    /// too-late answers can't surface as panel errors.
    pub(crate) async fn park_approval(
        &self,
        key: &TurnKey,
        id: &str,
        rx: oneshot::Receiver<Value>,
        timeout: Duration,
    ) -> Parked {
        let outcome = match self.turn_cancel(key) {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => Parked::Cancelled,
                r = tokio::time::timeout(timeout, rx) => match r {
                    Err(_elapsed) => Parked::Expired,
                    Ok(Ok(answer)) => Parked::Answer(answer),
                    Ok(Err(_closed)) => Parked::SenderClosed,
                },
            },
            None => match tokio::time::timeout(timeout, rx).await {
                Err(_elapsed) => Parked::Expired,
                Ok(Ok(answer)) => Parked::Answer(answer),
                Ok(Err(_closed)) => Parked::SenderClosed,
            },
        };
        if matches!(outcome, Parked::Expired | Parked::Cancelled) {
            self.approvals.forget(id);
            self.ui.event(json!({ "type": "approval_stale", "id": id }));
        }
        outcome
    }
}

// ── turn task affinity (task-scope audit #7) ─────────────────────────

/// The sites THIS turn's task is about, registered with the engine by
/// the SERVER at the turn boundary — ruke-server owns and resolves the
/// scope; this crate never parses one. Affinity answers "is this turn
/// about this site"; the AuthorityStore answers "may Ruke use this
/// site, always". The two checks are deliberately separate (the audit
/// law): a saved never-ask never buys an off-scope hop, and an
/// accepted hop never writes a saved permission. The registration
/// lives exactly as long as the turn's cancellation token and is
/// NEVER persisted to disk.
#[derive(Clone, Debug, Default)]
pub struct TurnAffinity {
    /// Lowercase hosts in first-seen scope order: PSL registrable
    /// hosts with a literal-host fallback for hosts the PSL cannot
    /// reduce (IPs, `localhost`). Ports never participate — both
    /// sides key on the bare host, matching how facet policy rows are
    /// keyed.
    pub hosts: Vec<String>,
}

/// The approval-card `facet` value an off-scope hop carries. It is
/// NOT a `Facet`: it must never read or write the persisted per-origin
/// rule store (separate-checks law). The Panel's card grammar for it
/// is one-shot — Accept authorizes exactly this hop.
pub const AFFINITY_FACET: &str = "task_scope";

/// Is a destination's host key covered by one scope host? Exact match,
/// or the destination is a subdomain of a scope host that stayed
/// literal — the wildcard-suffix family (`*.vercel.app`-style) and
/// IP/localhost hosts, where no PSL collapse happens on either side.
/// Ordinary subdomains already collapse to the same registrable host,
/// so the exact arm covers them. Narrowing only: a scope host DEEPER
/// than the destination authorizes nothing (the server resolves scope
/// hosts at registrable level, so this only bites hand-authored
/// scopes, and the honest answer there is to ask, not to widen).
pub(crate) fn host_in_scope(dest: &str, scope_host: &str) -> bool {
    let dest = dest.trim().to_lowercase();
    let scope = scope_host.trim().to_lowercase();
    !scope.is_empty() && (dest == scope || dest.ends_with(&format!(".{scope}")))
}

// ── the gate itself ────────────────────────────────────────────────────

/// One gate request: which facet, and the human-readable action label
/// for the approval card ("navigate to …", "click …").
pub struct Gate {
    pub facet: Facet,
    pub label: &'static str,
}

impl BrowserRuntime {
    /// The recovered handler preamble —
    /// `acquireAuthority().observeContent(currentTabUrl).assert()` —
    /// over the tab's CURRENT url (the registry url, kept live by the
    /// lifecycle pump and every settle read, is Ruke's
    /// follow-session-tab equivalent). Deny is a typed refusal, always
    /// ask parks on the panel, never ask proceeds.
    pub(crate) async fn apply_gate(
        &self,
        key: &TurnKey,
        tab_id: &str,
        facet: Facet,
        label: &str,
    ) -> Result<(), BrowserError> {
        if key.1 == HUMAN_TURN_ID {
            return Ok(());
        }
        let url = {
            let reg = self.registry.lock();
            reg.require(tab_id)?.url.clone()
        };
        if url.is_empty() {
            return Err(BrowserError::ContextUnavailable);
        }
        let parsed = Url::parse(&url).map_err(|_| BrowserError::ContextUnavailable)?;
        // Non-web schemes (about:blank) carry no host to key policy
        // on; the navigation floor (`check_navigable`) is their gate.
        if !matches!(parsed.scheme(), "http" | "https") {
            return Ok(());
        }
        let host = registrable_host(&url)
            .unwrap_or_else(|| parsed.host_str().unwrap_or_default().to_string());
        self.gate_on_host(
            key,
            &host,
            facet,
            label,
            tab_id,
            (json!(origin_of(&parsed)), json!(url)),
        )
        .await
    }

    /// Task-scope audit #8: the facet gate keyed on the DESTINATION
    /// url instead of the tab's current one. For navigations whose
    /// target is known ahead of time, the saved rule for the origin
    /// ABOUT TO LOAD is consulted before that origin's page ever
    /// loads — keying the source tab meant a saved deny on the
    /// destination could be preceded by a full visit to the denied
    /// site. Commands with no knowable-in-advance destination keep
    /// `apply_gate` (an honest post-landing check).
    pub(crate) async fn apply_gate_url(
        &self,
        key: &TurnKey,
        tab_id: &str,
        dest_url: &str,
        facet: Facet,
        label: &str,
    ) -> Result<(), BrowserError> {
        if key.1 == HUMAN_TURN_ID {
            return Ok(());
        }
        let parsed = Url::parse(dest_url).map_err(|_| BrowserError::InvalidUrl {
            url: dest_url.to_string(),
        })?;
        // Non-web schemes carry no host to key policy on; the
        // navigation floor (`check_navigable`) rejects them, and its
        // error is the honest one.
        if !matches!(parsed.scheme(), "http" | "https") {
            return Ok(());
        }
        let host = registrable_host(dest_url)
            .unwrap_or_else(|| parsed.host_str().unwrap_or_default().to_string());
        self.gate_on_host(
            key,
            &host,
            facet,
            label,
            tab_id,
            (json!(origin_of(&parsed)), json!(dest_url)),
        )
        .await
    }

    /// Browser-level gate (Phase 13): browsing history and browsing
    /// data belong to the session, not to any single origin (the
    /// recovered `readBrowsingHistory` authority verb spans the whole
    /// profile — [adapted] keying), so these commands key the global
    /// `"*"` policy row instead of a tab's registrable host. Their
    /// approval card carries an empty `tab_id`: a panel card with no
    /// tab is browser-level and is never pruned by tab frames.
    pub(crate) async fn apply_global_gate(
        &self,
        key: &TurnKey,
        facet: Facet,
        label: &str,
    ) -> Result<(), BrowserError> {
        if key.1 == HUMAN_TURN_ID {
            return Ok(());
        }
        self.gate_on_host(
            key,
            "*",
            facet,
            label,
            "",
            (json!("all sites"), Value::Null),
        )
        .await
    }

    /// Shared decision + park core of every facet gate (the recovered
    /// handler preamble tail; factored out in Phase 13 so tab-level
    /// and browser-level gates answer with identical grammar).
    async fn gate_on_host(
        &self,
        key: &TurnKey,
        host: &str,
        facet: Facet,
        label: &str,
        tab_id: &str,
        scope: (Value, Value), // (origin, url) — per-tab or browser-level
    ) -> Result<(), BrowserError> {
        match self.authority.decision(host, facet) {
            Decision::NeverAsk => Ok(()),
            Decision::Deny => Err(BrowserError::CapabilityBlocked {
                reason: "A saved permission or managed policy denies access.".into(),
            }),
            Decision::AlwaysAsk => {
                if !self.ui.has_clients() {
                    return Err(BrowserError::CapabilityBlocked {
                        reason: format!(
                            "{label} needs your approval, but no Browser Panel is connected \
                             to grant it (open the panel and try again)"
                        ),
                    });
                }
                let (id, rx) = self.approvals.register(tab_id, key);
                self.ui.event(json!({
                    "type": "approval_request",
                    "id": id,
                    "action": label,
                    "facet": facet.as_str(),
                    "origin": scope.0,
                    "url": scope.1,
                    "tab_id": tab_id,
                }));
                match self.park_approval(key, &id, rx, APPROVAL_TIMEOUT).await {
                    Parked::Expired => Err(BrowserError::CapabilityBlocked {
                        reason: format!(
                            "{label} timed out after {}s waiting for a Browser Panel decision",
                            APPROVAL_TIMEOUT.as_secs()
                        ),
                    }),
                    Parked::SenderClosed => Err(BrowserError::CapabilityBlocked {
                        reason: format!(
                            "{label} was cancelled: the tab or panel closed before a decision"
                        ),
                    }),
                    Parked::Cancelled => Err(BrowserError::CapabilityBlocked {
                        reason: format!(
                            "{label} was cancelled: the agent turn ended before a Browser Panel decision arrived"
                        ),
                    }),
                    Parked::Answer(answer) => {
                        let decision = answer.get("decision").and_then(Value::as_str);
                        match decision {
                            Some("accept") => Ok(()),
                            Some("always_allow") => {
                                self.authority.set(host, facet, Decision::NeverAsk);
                                Ok(())
                            }
                            Some("block") => {
                                self.authority.set(host, facet, Decision::Deny);
                                Err(BrowserError::CapabilityBlocked {
                                    reason: "A saved permission or managed policy denies access."
                                        .into(),
                                })
                            }
                            Some("decline") => Err(BrowserError::CapabilityBlocked {
                                reason: "The user declined this action.".into(),
                            }),
                            other => Err(BrowserError::PayloadInvalid {
                                command: "browser_ui_approval".into(),
                                reason: format!("unrecognized approval decision {other:?}"),
                            }),
                        }
                    }
                }
            }
        }
    }

    /// Task-scope audit #7: enforce the turn's registered affinity
    /// against a navigation DESTINATION before the page is touched. An
    /// off-scope hop is never a silent deny and never a blanket grant:
    /// exactly one card parks naming the exact destination, and an
    /// accept authorizes THIS action only — nothing persists, the next
    /// hop asks again, and the AuthorityStore is never consulted or
    /// written (saved permissions are a separate check by law). No
    /// affinity registered ⇒ no check: a scope the server never
    /// promised this turn cannot invent enforcement out of nothing.
    pub(crate) async fn check_task_affinity(
        &self,
        key: &TurnKey,
        tab_id: &str,
        dest_url: &str,
    ) -> Result<(), BrowserError> {
        if key.1 == HUMAN_TURN_ID {
            return Ok(()); // the human owns their browser; the gates police the model
        }
        let registered = self.turn_affinity.lock().get(key).cloned();
        let Some(affinity) = registered else {
            return Ok(()); // no scope registered for this turn
        };
        if affinity.hosts.is_empty() {
            return Ok(()); // an unresolved scope has nothing to enforce
        }
        let Ok(parsed) = Url::parse(dest_url) else {
            return Ok(()); // `check_navigable` owns the malformed-url floor
        };
        if !matches!(parsed.scheme(), "http" | "https") {
            return Ok(()); // no host to scope-check; the floor rejects non-web schemes
        }
        // Registrable collapse everywhere EXCEPT IP literals: the PSL
        // has no notion of an address and would reduce `127.0.0.1` to
        // label soup, while the server's scope hosts carry IPs as bare
        // literals (its own PSL floor returns None there) — so the
        // two sides agree on the address as written.
        let dest = match parsed.host() {
            Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_)) => {
                parsed.host_str().unwrap_or_default().to_string()
            }
            _ => registrable_host(dest_url)
                .unwrap_or_else(|| parsed.host_str().unwrap_or_default().to_string()),
        };
        if affinity.hosts.iter().any(|h| host_in_scope(&dest, h)) {
            return Ok(());
        }
        if !self.ui.has_clients() {
            return Err(BrowserError::CapabilityBlocked {
                reason: format!(
                    "{dest_url} is outside this task's site scope, and no Browser Panel \
                     is connected to authorize the hop (open the panel and try again)"
                ),
            });
        }
        let (id, rx) = self.approvals.register(tab_id, key);
        self.ui.event(json!({
            "type": "approval_request",
            "id": id,
            "action": format!("visit {dest_url}"),
            "facet": AFFINITY_FACET,
            "origin": origin_of(&parsed),
            "url": dest_url,
            "tab_id": tab_id,
        }));
        match self.park_approval(key, &id, rx, APPROVAL_TIMEOUT).await {
            Parked::Expired => Err(BrowserError::CapabilityBlocked {
                reason: format!(
                    "visiting {dest_url} (outside this task's site scope) timed out after \
                     {}s waiting for your authorization",
                    APPROVAL_TIMEOUT.as_secs()
                ),
            }),
            Parked::SenderClosed => Err(BrowserError::CapabilityBlocked {
                reason: format!(
                    "visiting {dest_url} (outside this task's site scope) was cancelled: \
                     the tab or panel closed before a decision"
                ),
            }),
            Parked::Cancelled => Err(BrowserError::CapabilityBlocked {
                reason: format!(
                    "visiting {dest_url} (outside this task's site scope) was cancelled: \
                     the agent turn ended before a Browser Panel decision arrived"
                ),
            }),
            Parked::Answer(answer) => {
                affinity_answer(dest_url, answer.get("decision").and_then(Value::as_str))
            }
        }
    }
}

/// The answer grammar for an off-scope hop card (task-scope audit #7).
/// `accept` and `always_allow` both authorize THIS navigation and
/// nothing else: an off-scope authorization is never persisted, and
/// writing a facet rule here would be a blanket grant wearing a saved
/// permission's clothes — so no answer touches the AuthorityStore,
/// not even `block` (whose refusal is about this hop; standing rules
/// are the facet gate's domain, where the Panel offers Block). The
/// Panel hides Always-allow/Block on these cards; treating them as
/// one-shot keeps the engine honest if such an answer ever arrives.
fn affinity_answer(dest: &str, decision: Option<&str>) -> Result<(), BrowserError> {
    match decision {
        Some("accept") | Some("always_allow") => Ok(()),
        Some("block" | "decline") => Err(BrowserError::CapabilityBlocked {
            reason: format!(
                "The user declined visiting {dest}: it is outside this task's site scope."
            ),
        }),
        other => Err(BrowserError::PayloadInvalid {
            command: "browser_ui_approval".into(),
            reason: format!("unrecognized approval decision {other:?}"),
        }),
    }
}

/// Which gates a command runs before dispatch ([adapted] mapping of
/// the recovered IX gates onto the implemented command surface):
/// page reads assert `access` (observeContent), page mutations assert
/// `access` (actInFrame), the file trio asserts `uploads`, the
/// download family asserts `downloads`, the raw CDP pair asserts
/// `full_cdp_access`. Lifecycle/ownership bookkeeping
/// (`tabs`/`get_tab`/`tab_new`/`tab_close`/claim/marks/manual
/// handoff) carries no page-content authority and is not gated. Since
/// Phase 15 every registry command has a real arm, so there are no
/// unimplemented commands left to skip; the remaining `_ => None`
/// rows are reads of Ruke's OWN engine state — never page content
/// (see the comment above the fallthrough).
pub(crate) fn gate_for(cmd: &Command) -> Option<(String, Vec<Gate>)> {
    let gates = |tab_id: String, g: Vec<Gate>| Some((tab_id, g));
    let observe = |tab_id: String| {
        gates(
            tab_id,
            vec![Gate {
                facet: Facet::Access,
                label: "observe page content",
            }],
        )
    };
    let act = |tab_id: String| {
        gates(
            tab_id,
            vec![Gate {
                facet: Facet::Access,
                label: "act in the page",
            }],
        )
    };
    match cmd {
        // ── observeContent (access) ───────────────────────────────────
        Command::DomCuaGetVisibleDom(p) => observe(p.tab_id.clone()),
        Command::PlaywrightDomSnapshot(p) => observe(p.tab_id.clone()),
        Command::PlaywrightElementInfo(p) => observe(p.tab_id.clone()),
        Command::PlaywrightElementScreenshot(p) => observe(p.tab_id.clone()),
        Command::TabScreenshot(p) => observe(p.tab_id.clone()),
        Command::TabGetJsDialog(p) => observe(p.tab_id.clone()),
        Command::PlaywrightLocatorAllTextContents(p) => observe(p.tab_id.clone()),
        Command::PlaywrightLocatorCount(p) => observe(p.tab_id.clone()),
        Command::PlaywrightLocatorGetAttribute(p) => observe(p.tab_id.clone()),
        Command::PlaywrightLocatorInnerText(p) => observe(p.tab_id.clone()),
        Command::PlaywrightLocatorIsEnabled(p) => observe(p.tab_id.clone()),
        Command::PlaywrightLocatorIsVisible(p) => observe(p.tab_id.clone()),
        Command::PlaywrightLocatorReadAll(p) => observe(p.tab_id.clone()),
        Command::PlaywrightLocatorTextContent(p) => observe(p.tab_id.clone()),
        Command::PlaywrightLocatorWaitFor(p) => observe(p.tab_id.clone()),
        Command::PlaywrightWaitForLoadState(p) => observe(p.tab_id.clone()),
        Command::PlaywrightWaitForUrl(p) => observe(p.tab_id.clone()),
        Command::TabBotDetectionReport(p) => observe(p.tab_id.clone()),
        // ── actInFrame (access) ───────────────────────────────────────
        Command::NavigateTabUrl(p) => act(p.tab_id.clone()),
        Command::NavigateTabBack(p) => act(p.tab_id.clone()),
        Command::NavigateTabForward(p) => act(p.tab_id.clone()),
        Command::NavigateTabReload(p) => act(p.tab_id.clone()),
        Command::DomCuaClick(p) => act(p.tab_id.clone()),
        Command::DomCuaDoubleClick(p) => act(p.tab_id.clone()),
        Command::DomCuaScroll(p) => act(p.tab_id.clone()),
        Command::DomCuaType(p) => act(p.tab_id.clone()),
        Command::DomCuaKeypress(p) => act(p.tab_id.clone()),
        Command::PlaywrightEvaluate(p) => act(p.tab_id.clone()),
        Command::PlaywrightLocatorClick(p) => act(p.tab_id.clone()),
        Command::PlaywrightLocatorDblclick(p) => act(p.tab_id.clone()),
        Command::PlaywrightLocatorFill(p) => act(p.tab_id.clone()),
        Command::PlaywrightLocatorPress(p) => act(p.tab_id.clone()),
        Command::PlaywrightLocatorPressSequentially(p) => act(p.tab_id.clone()),
        Command::PlaywrightLocatorSelectOption(p) => act(p.tab_id.clone()),
        Command::PlaywrightLocatorSetChecked(p) => act(p.tab_id.clone()),
        Command::TabHandleJsDialog(p) => act(p.tab_id.clone()),
        Command::TabBrowserAuthHandoff(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::Access,
                label: "hand a sign-in to you",
            }],
        ),
        // ── uploads ───────────────────────────────────────────────────
        Command::PlaywrightWaitForFileChooser(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::Uploads,
                label: "pick files to upload",
            }],
        ),
        Command::PlaywrightFileChooserSetFiles(p) => gates(
            p.tab_id.clone(),
            vec![
                Gate {
                    facet: Facet::Access,
                    label: "act in the page",
                },
                Gate {
                    facet: Facet::Uploads,
                    label: "upload files",
                },
            ],
        ),
        // ── downloads ────────────────────────────────────────────────
        Command::PlaywrightWaitForDownload(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::Downloads,
                label: "wait for a download",
            }],
        ),
        Command::PlaywrightDownloadPath(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::Downloads,
                label: "read a downloaded file path",
            }],
        ),
        Command::DomCuaDownloadMedia(p) => gates(
            p.tab_id.clone(),
            vec![
                Gate {
                    facet: Facet::Access,
                    label: "act in the page",
                },
                Gate {
                    facet: Facet::Downloads,
                    label: "download media",
                },
            ],
        ),
        Command::PlaywrightLocatorDownloadMedia(p) => gates(
            p.tab_id.clone(),
            vec![
                Gate {
                    facet: Facet::Access,
                    label: "act in the page",
                },
                Gate {
                    facet: Facet::Downloads,
                    label: "download media",
                },
            ],
        ),
        // ── full CDP ─────────────────────────────────────────────────
        Command::TabCdpCall(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::FullCdpAccess,
                label: "use raw CDP",
            }],
        ),
        Command::TabCdpEvents(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::FullCdpAccess,
                label: "read raw CDP events",
            }],
        ),
        // ── WebMCP (Phase 14) ────────────────────────────────────────
        // The reference policed WebMCP with a get-browser-webmcp-policy
        // IPC; Ruke always installs the shim and polices USE instead:
        // listing is a page read (access/observe — it only reveals what
        // the page already advertises), while invoking runs PAGE-
        // DECLARED code — acting in the page under a name a hostile
        // page chose, so it carries an explicit label on the card.
        Command::WebmcpListTools(p) => observe(p.tab_id.clone()),
        Command::WebmcpInvokeTool(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::Access,
                label: "run a page-declared model tool",
            }],
        ),
        // ── Phase 15: CUA pixel input (actInFrame) ─────────────────
        // Raw trusted-pointer drives on the shared visible session:
        // the same access/act gate as every locator click, because
        // the pixels address the very page the locators address.
        Command::CuaClick(p) => act(p.tab_id.clone()),
        Command::CuaDoubleClick(p) => act(p.tab_id.clone()),
        Command::CuaDrag(p) => act(p.tab_id.clone()),
        Command::CuaKeypress(p) => act(p.tab_id.clone()),
        Command::CuaMove(p) => act(p.tab_id.clone()),
        Command::CuaScroll(p) => act(p.tab_id.clone()),
        Command::CuaType(p) => act(p.tab_id.clone()),
        // ── Phase 15: clipboard (access, explicit labels) ──────────
        // The system clipboard is cross-site state: the approval card
        // says exactly what gets read or replaced — it never borrows
        // the generic page labels for a cross-surface capability.
        // (read pair shares `TabTarget`; the write pair does not:
        // `ClipboardWritePayload` vs `TextPayload`, so separate arms)
        Command::TabClipboardRead(p) | Command::TabClipboardReadText(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::Access,
                label: "read the clipboard",
            }],
        ),
        Command::TabClipboardWrite(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::Access,
                label: "replace the clipboard contents",
            }],
        ),
        Command::TabClipboardWriteText(p) => gates(
            p.tab_id.clone(),
            vec![Gate {
                facet: Facet::Access,
                label: "replace the clipboard contents",
            }],
        ),
        // ── Phase 15: content exports + dev logs (observe) ─────────
        // Page-derived reads (exported content, Google/YouTube
        // exports, asset inventory, the console/dev-log mirror):
        // reads, so access/observe — the bytes are evidence, never
        // permission.
        Command::TabContentExport(p) => observe(p.tab_id.clone()),
        Command::TabContentExportGsuite(p) => observe(p.tab_id.clone()),
        Command::TabContentExportYoutubeTranscript(p) => observe(p.tab_id.clone()),
        Command::TabPageAssetsList(p) => observe(p.tab_id.clone()),
        Command::TabPageAssetsBundle(p) => observe(p.tab_id.clone()),
        Command::TabDevLogs(p) => observe(p.tab_id.clone()),
        // site_status / site_submission_verified read Ruke's OWN policy
        // store and engine-observed session evidence, and
        // browser_visibility_get reads the engine's host state — none
        // of them touches page content or the network, so they
        // deliberately fall into `_ => None` (gating them on the state
        // they report would deadlock the UI that manages that state).
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn facet_and_decision_names_are_verbatim() {
        for f in [
            Facet::Access,
            Facet::Uploads,
            Facet::Downloads,
            Facet::FullCdpAccess,
        ] {
            assert_eq!(Facet::parse(f.as_str()), Some(f));
        }
        assert_eq!(Facet::Access.as_str(), "access");
        assert_eq!(Facet::FullCdpAccess.as_str(), "full_cdp_access");
        assert_eq!(Decision::Deny.as_str(), "deny");
        assert_eq!(Decision::AlwaysAsk.as_str(), "always_ask");
        assert_eq!(Decision::NeverAsk.as_str(), "never_ask");
        assert!(Facet::parse("network").is_none());
        assert!(Decision::parse("ask_first").is_none());
    }

    #[test]
    fn webmcp_use_is_gated_and_policy_reads_are_not() {
        use crate::contract::Command;
        use crate::schemas::{SiteQueryPayload, TabTarget, WebmcpInvokePayload};
        let list = gate_for(&Command::WebmcpListTools(TabTarget {
            browser_id: "default".into(),
            tab_id: "t1".into(),
        }))
        .expect("listing page tools is a gated page read");
        assert_eq!(list.0, "t1");
        assert_eq!(list.1[0].facet, Facet::Access);
        assert_eq!(list.1[0].label, "observe page content");
        let invoke = gate_for(&Command::WebmcpInvokeTool(WebmcpInvokePayload {
            browser_id: "default".into(),
            tab_id: "t1".into(),
            tool: "submit_form".into(),
            args: None,
        }))
        .expect("running page-declared code is gated");
        assert_eq!(invoke.1.len(), 1);
        assert_eq!(invoke.1[0].facet, Facet::Access);
        // The card states what is about to run in OUR words — the tool
        // name is page-chosen and untrusted, the label never is.
        assert_eq!(invoke.1[0].label, "run a page-declared model tool");
        // Policy/evidence reads answer about the gate itself: gating
        // them on that gate would deadlock the UI that manages it.
        for cmd in [
            Command::SiteStatus(SiteQueryPayload {
                browser_id: None,
                url: "https://x.dev/".into(),
            }),
            Command::SiteSubmissionVerified(SiteQueryPayload {
                browser_id: None,
                url: "https://x.dev/".into(),
            }),
        ] {
            assert!(gate_for(&cmd).is_none(), "{cmd:?} must not gate");
        }
    }

    #[test]
    fn phase15_input_and_read_commands_are_gated_by_surface() {
        use crate::contract::Command;
        use crate::schemas::{
            BrowserOnly, CuaClickPayload, DevLogsPayload, TabTarget, TextPayload,
        };
        // Pixel input drives the page: the same act gate as locators.
        let click = gate_for(&Command::CuaClick(CuaClickPayload {
            browser_id: "default".into(),
            tab_id: "t1".into(),
            x: 10.0,
            y: 20.0,
            button: None,
            keys: None,
        }))
        .expect("cua pixel input is gated");
        assert_eq!(click.0, "t1");
        assert_eq!(click.1[0].facet, Facet::Access);
        assert_eq!(click.1[0].label, "act in the page");
        // Clipboard is cross-site state: its cards carry explicit
        // labels, never the generic page wording.
        let read_cb = gate_for(&Command::TabClipboardRead(TabTarget {
            browser_id: "default".into(),
            tab_id: "t1".into(),
        }))
        .expect("clipboard read is a gated read");
        assert_eq!(read_cb.1[0].facet, Facet::Access);
        assert_eq!(read_cb.1[0].label, "read the clipboard");
        let write_cb = gate_for(&Command::TabClipboardWriteText(TextPayload {
            browser_id: "default".into(),
            tab_id: "t1".into(),
            text: "hi".into(),
        }))
        .expect("clipboard write is gated");
        assert_eq!(write_cb.1[0].label, "replace the clipboard contents");
        // The dev-log mirror surfaces PAGE output: an observe read.
        let logs = gate_for(&Command::TabDevLogs(DevLogsPayload {
            browser_id: "default".into(),
            tab_id: "t1".into(),
            filter: None,
            levels: None,
            limit: None,
        }))
        .expect("dev logs are a gated read");
        assert_eq!(logs.1[0].label, "observe page content");
        // Engine host state is not page content: gating the read of
        // it on the page gate would be theater over our own process.
        assert!(gate_for(&Command::BrowserVisibilityGet(BrowserOnly {
            browser_id: "default".into(),
        }))
        .is_none());
    }

    #[test]
    fn registrable_host_collapses_subdomains() {
        assert_eq!(
            registrable_host("https://www.example.com/path?q=1").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            registrable_host("https://deep.sub.example.co.uk/").as_deref(),
            Some("example.co.uk")
        );
        // Unknown suffixes / single-label hosts keep the full host.
        assert_eq!(
            registrable_host("http://localhost:3210/x").as_deref(),
            Some("localhost")
        );
        assert_eq!(registrable_host("about:blank").as_deref(), None);
    }

    // ── task-scope audit #7/#8: affinity + destination-keyed gates ──

    #[test]
    fn host_in_scope_matches_exact_literal_and_subdomain_hops() {
        assert!(host_in_scope("example.com", "example.com"));
        // Subdomains of a scope host that stayed literal (wildcard-
        // suffix sites keep their full host on both sides).
        assert!(host_in_scope(
            "app.my-site.vercel.app",
            "my-site.vercel.app"
        ));
        // …and never wider: a scope host one label DEEPER than the
        // destination authorizes nothing, and suffix look-alikes fail.
        assert!(!host_in_scope("example.com", "shop.example.com"));
        assert!(!host_in_scope("notexample.com", "example.com"));
        assert!(!host_in_scope("evil.test", "example.com"));
        // IP literals carry no PSL floor: exact literal match, and
        // hosts arrive port-stripped from both sides.
        assert!(host_in_scope("127.0.0.1", "127.0.0.1"));
        // Case-insensitive by law.
        assert!(host_in_scope("EXAMPLE.COM", "example.com"));
    }

    #[test]
    fn affinity_answer_is_one_shot_and_never_persists() {
        // accept/always_allow authorize THIS hop only — a saved
        // permission is a different check entirely (separate-checks
        // law), so no affinity-card answer can ever write one.
        for d in ["accept", "always_allow"] {
            assert!(affinity_answer("https://hop.test/x", Some(d)).is_ok());
        }
        for d in ["block", "decline"] {
            let e = affinity_answer("https://hop.test/x", Some(d)).unwrap_err();
            assert!(matches!(&e, BrowserError::CapabilityBlocked { reason }
                if reason.contains("outside this task's site scope")));
        }
        assert!(matches!(
            affinity_answer("https://hop.test/x", Some("yes")),
            Err(BrowserError::PayloadInvalid { .. })
        ));
    }

    #[tokio::test]
    async fn check_task_affinity_matrix_no_panel_human_and_expiry_ladder() {
        let dir = tempfile::tempdir().unwrap();
        let rt = BrowserRuntime::new(dir.path().to_path_buf());
        let key = ("s".to_string(), "t7".to_string());
        rt.set_turn_affinity(
            "s",
            "t7",
            Some(TurnAffinity {
                hosts: vec![
                    "zepto.com".into(),
                    "127.0.0.1".into(),
                    "my-site.vercel.app".into(),
                ],
            }),
        );
        // In-scope destinations pass: registrable collapse, IP literal
        // with a port, a subdomain of a literal scope host, and the
        // no-host floor (about:blank) that `check_navigable` owns.
        for url in [
            "https://www.zepto.com/cart",
            "http://127.0.0.1:3210/easy",
            "https://app.my-site.vercel.app/x",
            "about:blank",
        ] {
            assert!(
                rt.check_task_affinity(&key, "t1", url).await.is_ok(),
                "{url} must stay in scope"
            );
        }
        // Off-scope with NO panel connected ⇒ a typed refusal naming
        // the exact destination — never silent, never blanket.
        let e = rt
            .check_task_affinity(&key, "t1", "https://blinkit.com/x")
            .await
            .unwrap_err();
        assert!(matches!(&e, BrowserError::CapabilityBlocked { reason }
            if reason.contains("outside this task's site scope")
                && reason.contains("https://blinkit.com/x")));
        // Human turns skip (the gates police the model); turns with no
        // registered affinity skip (nothing was ever promised to them).
        let human = ("s".to_string(), HUMAN_TURN_ID.to_string());
        assert!(rt
            .check_task_affinity(&human, "t1", "https://blinkit.com/x")
            .await
            .is_ok());
        let unregistered = ("s".to_string(), "t8".to_string());
        assert!(rt
            .check_task_affinity(&unregistered, "t1", "https://blinkit.com/x")
            .await
            .is_ok());
        // end_turn unwinds the registration with the rest of the turn…
        rt.end_turn("s", "t7").await;
        assert!(rt
            .check_task_affinity(&key, "t1", "https://blinkit.com/x")
            .await
            .is_ok());
        // …and affinity NEVER consulted or wrote the saved-permission
        // store (separate-checks law): every host is still default.
        for host in ["zepto.com", "blinkit.com"] {
            assert_eq!(
                rt.authority.decision(host, Facet::Access),
                Decision::AlwaysAsk
            );
        }
    }

    #[tokio::test]
    async fn destination_gate_keys_the_destination_origin() {
        let dir = tempfile::tempdir().unwrap();
        let rt = BrowserRuntime::new(dir.path().to_path_buf());
        let key = ("s".to_string(), "t".to_string());
        rt.authority
            .set("example.com", Facet::Access, Decision::Deny);
        rt.authority
            .set("example.org", Facet::Access, Decision::NeverAsk);
        // A saved DENY on the DESTINATION origin refuses before the
        // denied page ever loads (audit #8 — the source-tab gate could
        // not catch this until after the visit had already happened)…
        let e = rt
            .apply_gate_url(
                &key,
                "t1",
                "https://checkout.example.com/pay",
                Facet::Access,
                "act in the page",
            )
            .await
            .unwrap_err();
        assert!(matches!(&e, BrowserError::CapabilityBlocked { reason }
            if reason.contains("denies access")));
        // …while a saved NEVER-ASK on the destination origin proceeds.
        assert!(rt
            .apply_gate_url(
                &key,
                "t1",
                "https://news.example.org/x",
                Facet::Access,
                "act in the page"
            )
            .await
            .is_ok());
        // The navigation floor stays the floor: an unparseable url is
        // the command's typed error, not the gate's to invent.
        assert!(matches!(
            rt.apply_gate_url(&key, "t1", "not a url", Facet::Access, "act in the page")
                .await,
            Err(BrowserError::InvalidUrl { .. })
        ));
        // Human turns still skip every gate.
        let human = ("s".to_string(), HUMAN_TURN_ID.to_string());
        assert!(rt
            .apply_gate_url(
                &human,
                "t1",
                "https://checkout.example.com/pay",
                Facet::Access,
                "act in the page"
            )
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn navigate_runs_affinity_then_destination_gate_before_the_arm() {
        let dir = tempfile::tempdir().unwrap();
        let rt = BrowserRuntime::new(dir.path().to_path_buf());
        let key = ("s".to_string(), "t".to_string());
        rt.set_turn_affinity(
            "s",
            "t",
            Some(TurnAffinity {
                hosts: vec!["zepto.com".into()],
            }),
        );
        rt.authority
            .set("example.com", Facet::Access, Decision::Deny);
        let nav = |url: &str| {
            Command::NavigateTabUrl(crate::schemas::NavigateUrlPayload {
                browser_id: "default".into(),
                tab_id: "t9".into(),
                url: url.into(),
            })
        };
        // Affinity fires FIRST: the scope-hop refusal, not the saved-
        // permission one. The destination page was never loaded — that
        // is the whole point of a pre-gate (audit #8's "a check after
        // an unauthorized page has loaded is insufficient").
        let e = rt
            .execute(&key, &nav("https://shop.example.com/"))
            .await
            .unwrap_err();
        assert!(matches!(&e, BrowserError::CapabilityBlocked { reason }
            if reason.contains("outside this task's site scope")));
        // In scope now: the facet gate answers keyed on the
        // DESTINATION origin — tab "t9" does not exist at all, so the
        // old source-tab `apply_gate` could only have said
        // ContextUnavailable, never "denies access".
        rt.set_turn_affinity(
            "s",
            "t",
            Some(TurnAffinity {
                hosts: vec!["example.com".into()],
            }),
        );
        let e = rt
            .execute(&key, &nav("https://shop.example.com/"))
            .await
            .unwrap_err();
        assert!(matches!(&e, BrowserError::CapabilityBlocked { reason }
            if reason.contains("denies access")));
        // `tab_new` with an explicit off-scope url is pre-checked too:
        // tab lifecycle carries no facet gate by design, but the hop
        // is still the model's doing, so affinity applies.
        let e = rt
            .execute(
                &key,
                &Command::TabNew(crate::schemas::TabNewPayload {
                    browser_id: "default".into(),
                    url: Some("https://blinkit.com/x".into()),
                }),
            )
            .await
            .unwrap_err();
        assert!(matches!(&e, BrowserError::CapabilityBlocked { reason }
            if reason.contains("outside this task's site scope")));
    }

    #[test]
    fn known_destination_covers_only_pre_knowable_navigations() {
        use crate::contract::Command;
        use crate::executor::known_destination;
        use crate::schemas::{NavigateUrlPayload, TabNewPayload, TabTarget};
        let nav_cmd = Command::NavigateTabUrl(NavigateUrlPayload {
            browser_id: "default".into(),
            tab_id: "t1".into(),
            url: "https://x.example/".into(),
        });
        assert_eq!(
            known_destination(&nav_cmd),
            Some(("t1", "https://x.example/"))
        );
        // A blank new tab has no host to scope-check…
        assert_eq!(
            known_destination(&Command::TabNew(TabNewPayload {
                browser_id: "default".into(),
                url: None,
            })),
            None
        );
        assert_eq!(
            known_destination(&Command::TabNew(TabNewPayload {
                browser_id: "default".into(),
                url: Some("about:blank".into()),
            })),
            None
        );
        // …but an explicit one does.
        assert_eq!(
            known_destination(&Command::TabNew(TabNewPayload {
                browser_id: "default".into(),
                url: Some("https://x.example/".into()),
            })),
            Some(("", "https://x.example/"))
        );
        // Back/forward/reload destinations are not knowable in advance:
        // they keep the source-tab gate (documented post-landing check).
        assert_eq!(
            known_destination(&Command::NavigateTabBack(TabTarget {
                browser_id: "default".into(),
                tab_id: "t1".into(),
            })),
            None
        );
        assert_eq!(
            known_destination(&Command::NavigateTabReload(TabTarget {
                browser_id: "default".into(),
                tab_id: "t1".into(),
            })),
            None
        );
        // Not a navigation at all.
        assert_eq!(
            known_destination(&Command::TabClose(TabTarget {
                browser_id: "default".into(),
                tab_id: "t1".into(),
            })),
            None
        );
    }

    #[test]
    fn store_default_is_always_ask_and_persists_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuthorityStore::load(dir.path());
        assert_eq!(
            store.decision("example.com", Facet::Access),
            Decision::AlwaysAsk
        );
        store.set("example.com", Facet::Downloads, Decision::NeverAsk);
        store.set("evil.test", Facet::Access, Decision::Deny);
        let reloaded = AuthorityStore::load(dir.path());
        assert_eq!(
            reloaded.decision("example.com", Facet::Downloads),
            Decision::NeverAsk
        );
        assert_eq!(
            reloaded.decision("evil.test", Facet::Access),
            Decision::Deny
        );
        // Corrupt file ⇒ empty store, never a panic.
        std::fs::write(dir.path().join(POLICY_FILE), "not json").unwrap();
        assert!(AuthorityStore::load(dir.path()).list().is_empty());
    }

    #[test]
    fn access_deny_cascades_over_escalation_facets() {
        let dir = tempfile::tempdir().unwrap();
        let store = AuthorityStore::load(dir.path());
        store.set("shop.test", Facet::Access, Decision::Deny);
        for f in [Facet::Uploads, Facet::Downloads, Facet::FullCdpAccess] {
            assert_eq!(store.decision("shop.test", f), Decision::Deny);
        }
        // A facet-level deny never leaks into its siblings…
        store.set("news.test", Facet::Uploads, Decision::Deny);
        assert_eq!(
            store.decision("news.test", Facet::Access),
            Decision::AlwaysAsk
        );
        // …while a saved deny IS the deny floor: AlwaysAsk answers can
        // not overwrite a stored Deny except by an explicit set.
        assert_eq!(store.decision("news.test", Facet::Uploads), Decision::Deny);
    }

    #[test]
    fn approvals_resolve_once_and_forget_tab_fails_closed() {
        let reg = ApprovalRegistry::new();
        let key = ("s".to_string(), "t".to_string());
        let (id, rx) = reg.register("7", &key);
        assert_eq!(reg.pending_count(), 1);
        assert!(!reg.resolve("nope", &json!({"decision": "accept"})));
        assert!(reg.resolve(&id, &json!({"decision": "accept"})));
        assert!(rx.blocking_recv().is_ok());
        assert!(!reg.resolve(&id, &json!({}))); // single-shot
        let (_id2, rx2) = reg.register("7", &key);
        reg.forget_tab("7");
        assert!(rx2.blocking_recv().is_err());
        let (_id3, rx3) = reg.register("9", &key);
        reg.cancel_all();
        assert!(rx3.blocking_recv().is_err());
    }

    #[test]
    fn forget_turn_prunes_only_that_turns_cards() {
        let reg = ApprovalRegistry::new();
        let mine = ("s".to_string(), "7".to_string());
        let theirs = ("s".to_string(), "8".to_string());
        let (id, rx) = reg.register("7", &mine);
        let (keep_id, keep_rx) = reg.register("8", &theirs);
        assert_eq!(reg.forget_turn(&mine), vec![id]);
        assert!(rx.blocking_recv().is_err()); // failed closed
        assert_eq!(reg.pending_count(), 1); // the other turn is untouched
        assert!(reg.resolve(&keep_id, &json!({"decision": "accept"})));
        assert!(keep_rx.blocking_recv().is_ok());
        assert!(reg.forget_turn(&mine).is_empty());
    }

    #[test]
    fn origin_floor_compares_origins_not_urls() {
        let a = Url::parse("https://acct.example.com/login?next=1").unwrap();
        let b = Url::parse("https://acct.example.com/dashboard").unwrap();
        let c = Url::parse("https://evil.example.com/login").unwrap();
        assert_eq!(origin_of(&a), origin_of(&b));
        assert_ne!(origin_of(&a), origin_of(&c));
        let d = Url::parse("http://localhost:3210/").unwrap();
        assert_eq!(origin_of(&d), "http://localhost:3210");
    }
}
