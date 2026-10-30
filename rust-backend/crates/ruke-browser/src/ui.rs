//! ui.rs — the Browser Panel hub (Phase 3): the server side of the live
//! UI socket that shows and steers the SAME browser session the model
//! controls (plan §0: one shared tab/session state, no parallel browser).
//!
//! Three jobs:
//! - **View feed**: ref-counted `Page.startScreencast` per CDP session
//!   (started on the first subscriber, stopped when the last leaves),
//!   frames fanned out only to clients viewing that tab; tab lifecycle
//!   changes broadcast as full `tabs` snapshots (cheap — the panel diffs
//!   and the count is small).
//! - **Input feed**: UI events arrive as JSON and map onto the same CDP
//!   `Input.*` calls the later model-facing action layer will use
//!   ([`input_dispatch`] is pure so the mapping is unit-testable without
//!   a browser).
//! - **Socket admission**: one-shot short-lived tickets
//!   ([`UiHub::mint_ticket`] / [`UiHub::claim_ticket`]) minted by the
//!   authenticated HTTP route; the real guards are the loopback bind and
//!   the Origin allowlist in `ruke-server` (WS handshakes cannot carry
//!   the bridge secret header, so the ticket stands in — single-use and
//!   60 s TTL keeps replay useless). Rule 17: never log a ticket.
//!
//! Authority floor until Phase 9 layers the facet model: a socket client
//! may only *act on* tabs it is currently viewing (`subscribe` first),
//! and every socket already passed loopback + Origin + one-shot ticket.
//! The agent-side ownership rule (`can_act_on`) deliberately does NOT
//! gate the human panel — the human owns their browser; it gates the
//! model, and the panel claims user tabs through the ordinary
//! `browser_user_claim_tab` command when it needs model-visible acting.

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::errors::BrowserError;
use crate::executor::tab_json;
use crate::session::Registry;

/// A UI socket ticket is single-use and short-lived: the panel mints one
/// immediately before each connect (including reconnects).
pub const WS_TICKET_TTL: Duration = Duration::from_secs(60);

struct ClientSlot {
    tx: mpsc::UnboundedSender<Value>,
    /// tab_ids this client is currently viewing.
    subs: HashSet<String>,
}

#[derive(Default)]
struct Inner {
    clients: HashMap<u64, ClientSlot>,
    /// ticket -> expiry
    tickets: HashMap<String, Instant>,
    /// CDP session ids with a live `Page.startScreencast`.
    screencasting: HashSet<String>,
    /// tab_id -> its CDP session, mirrored at subscribe time so viewer
    /// ref-counting stays entirely inside `Inner` (the `registry` and
    /// `inner` locks must never nest in opposite directions — see the
    /// field comment on [`UiHub`]).
    tab_sessions: HashMap<String, String>,
    seed: u64,
}

pub struct UiHub {
    registry: Arc<Mutex<Registry>>,
    next_client: AtomicU64,
    ticket_seq: AtomicU64,
    /// Lock order across the crate: never take `inner` while a
    /// `registry` guard is held; paths that need both either take
    /// `inner` then nest `registry` (close/unsubscribe/fan-out) or drop
    /// the registry guard first (subscribe/frame).
    inner: Mutex<Inner>,
}

impl UiHub {
    pub fn new(registry: Arc<Mutex<Registry>>) -> Self {
        Self {
            registry,
            next_client: AtomicU64::new(1),
            ticket_seq: AtomicU64::new(1),
            inner: Mutex::new(Inner {
                // Entropy stack (the workspace has no rand crate):
                // process-random std hasher keys + wall-clock nanos + a
                // monotonic counter, expanded through splitmix64. The
                // ticket is one of THREE guards (loopback bind + Origin
                // allowlist + ticket), single-use, and 60 s-lived.
                seed: mix_seed(),
                ..Default::default()
            }),
        }
    }

    // ── admission tickets ─────────────────────────────────────────────

    /// Mint a one-shot ticket; returns `(ticket, ttl_ms)`.
    pub fn mint_ticket(&self) -> (String, u64) {
        let mut seq = self.ticket_seq.fetch_add(1, Ordering::Relaxed);
        let mut inner = self.inner.lock();
        let now = Instant::now();
        inner.tickets.retain(|_, exp| *exp > now);
        let a = splitmix64(&mut inner.seed) ^ splitmix64(&mut seq);
        let b = splitmix64(&mut inner.seed);
        let ticket = format!("{a:016x}{b:016x}");
        inner.tickets.insert(ticket.clone(), now + WS_TICKET_TTL);
        (ticket, WS_TICKET_TTL.as_millis() as u64)
    }

    /// Consume a ticket exactly once (expired tickets are purged here).
    pub fn claim_ticket(&self, ticket: &str) -> bool {
        let mut inner = self.inner.lock();
        let now = Instant::now();
        inner.tickets.retain(|_, exp| *exp > now);
        inner.tickets.remove(ticket).is_some()
    }

    // ── sockets ───────────────────────────────────────────────────────

    /// Register a connected UI socket; returns its id and the outbound
    /// frame channel the route drains into the WebSocket.
    pub fn open(&self) -> (u64, mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let id = self.next_client.fetch_add(1, Ordering::Relaxed);
        self.inner.lock().clients.insert(
            id,
            ClientSlot {
                tx,
                subs: HashSet::new(),
            },
        );
        (id, rx)
    }

    pub fn is_connected(&self, client: u64) -> bool {
        self.inner.lock().clients.contains_key(&client)
    }

    pub fn subscribed(&self, client: u64, tab_id: &str) -> bool {
        self.inner
            .lock()
            .clients
            .get(&client)
            .is_some_and(|s| s.subs.contains(tab_id))
    }

    /// Acting gate: the client must be a live socket viewing the tab.
    pub fn require_subscribed(&self, client: u64, tab_id: &str) -> Result<(), BrowserError> {
        let inner = self.inner.lock();
        match inner.clients.get(&client) {
            None => Err(BrowserError::ContextUnavailable),
            Some(slot) if slot.subs.contains(tab_id) => Ok(()),
            Some(_) => Err(BrowserError::CapabilityBlocked {
                reason: format!(
                    "this Browser Panel connection is not viewing tab {tab_id}: subscribe to \
                     it before acting on it"
                ),
            }),
        }
    }

    // ── subscriptions / screencast ref-counting ───────────────────────

    /// Start (or join) viewing a tab. `Ok(Some(cdp_session))` means the
    /// caller must issue `Page.startScreencast` for that session.
    pub fn subscribe(&self, client: u64, tab_id: &str) -> Result<Option<String>, BrowserError> {
        // Registry first, guard released before `inner` (lock order).
        let rec = self.registry.lock().require(tab_id)?;
        let mut inner = self.inner.lock();
        let Some(slot) = inner.clients.get_mut(&client) else {
            return Err(BrowserError::ContextUnavailable);
        };
        if !slot.subs.insert(tab_id.to_string()) {
            return Ok(None); // already viewing: no second startScreencast
        }
        inner
            .tab_sessions
            .insert(tab_id.to_string(), rec.cdp_session_id.clone());
        if inner.screencasting.insert(rec.cdp_session_id.clone()) {
            Ok(Some(rec.cdp_session_id))
        } else {
            Ok(None)
        }
    }

    /// Roll back a `subscribe` whose CDP start failed (no stopScreencast:
    /// there is no running capture to stop).
    pub fn forget_subscribe(&self, client: u64, tab_id: &str, cdp_session_id: &str) {
        let mut inner = self.inner.lock();
        if let Some(slot) = inner.clients.get_mut(&client) {
            slot.subs.remove(tab_id);
        }
        if !self.still_viewing_locked(&inner, cdp_session_id) {
            inner.screencasting.remove(cdp_session_id);
            inner.tab_sessions.remove(tab_id);
        }
    }

    /// Stop viewing a tab. `Ok(Some(cdp_session))` means the caller must
    /// issue `Page.stopScreencast` (last viewer left that session).
    pub fn unsubscribe(&self, client: u64, tab_id: &str) -> Result<Option<String>, BrowserError> {
        let mut inner = self.inner.lock();
        let Some(slot) = inner.clients.get_mut(&client) else {
            return Err(BrowserError::ContextUnavailable);
        };
        if !slot.subs.remove(tab_id) {
            return Ok(None); // not viewing (a closed tab's views were purged)
        }
        let Some(session) = inner.tab_sessions.get(tab_id).cloned() else {
            return Ok(None); // tab closed: drop_tab already cleaned up
        };
        if self.still_viewing_locked(&inner, &session) {
            Ok(None)
        } else {
            inner.screencasting.remove(&session);
            inner.tab_sessions.remove(tab_id);
            Ok(Some(session))
        }
    }

    /// Socket closed: drop its views; returns the CDP sessions that lost
    /// their last viewer (callers stop their screencasts).
    pub fn close(&self, client: u64) -> Vec<String> {
        let mut inner = self.inner.lock();
        let Some(slot) = inner.clients.remove(&client) else {
            return Vec::new();
        };
        let mut stops = Vec::new();
        for tab_id in slot.subs {
            let Some(session) = inner.tab_sessions.get(&tab_id).cloned() else {
                continue;
            };
            if !self.still_viewing_locked(&inner, &session) && inner.screencasting.remove(&session)
            {
                inner.tab_sessions.remove(&tab_id);
                stops.push(session);
            }
        }
        stops
    }

    /// A tab died (pump `Target.targetDestroyed`, or an explicit close
    /// path): its views and its capture are gone with it — nothing to
    /// stop over CDP.
    pub fn drop_tab(&self, tab_id: &str, cdp_session_id: &str) {
        let mut inner = self.inner.lock();
        for slot in inner.clients.values_mut() {
            slot.subs.remove(tab_id);
        }
        inner.tab_sessions.remove(tab_id);
        inner.screencasting.remove(cdp_session_id);
    }

    /// The pump only acks/fans frames for sessions someone is watching.
    pub fn watching(&self, cdp_session_id: &str) -> bool {
        self.inner.lock().screencasting.contains(cdp_session_id)
    }

    /// Host died or shut down: every view and capture is dead. Sockets
    /// stay connected (the panel shows an empty browser and can act
    /// again once a later command relaunches).
    pub fn clear_state(&self) {
        let mut inner = self.inner.lock();
        inner.screencasting.clear();
        inner.tab_sessions.clear();
        for slot in inner.clients.values_mut() {
            slot.subs.clear();
        }
    }

    // ── fan-out ───────────────────────────────────────────────────────

    /// One `Page.screencastFrame` to every client viewing the tab.
    pub fn frame(&self, cdp_session_id: &str, data: &str, metadata: Option<&Value>) {
        let Some(tab_id) = self
            .registry
            .lock()
            .by_session(cdp_session_id)
            .map(|r| r.tab_id.clone())
        else {
            return;
        };
        let msg = json!({ "type": "frame", "tab_id": tab_id, "data": data, "metadata": metadata });
        let mut inner = self.inner.lock();
        inner
            .clients
            .retain(|_, slot| !slot.subs.contains(&tab_id) || slot.tx.send(msg.clone()).is_ok());
    }

    /// Full tab listing to every connected client (the panel diffs).
    pub fn tabs_changed(&self) {
        let tabs = self.tabs_snapshot(); // registry only, before `inner`
        let msg = json!({ "type": "tabs", "tabs": tabs });
        let mut inner = self.inner.lock();
        inner
            .clients
            .retain(|_, slot| slot.tx.send(msg.clone()).is_ok());
    }

    /// One protocol error to one client (typed wire error, same codes as
    /// the command RPC — the panel keys off `error_code`).
    pub fn error_to(&self, client: u64, error: &BrowserError) {
        let mut wire = error.to_wire();
        if let Some(obj) = wire.as_object_mut() {
            obj.insert("type".into(), json!("error"));
        }
        let mut inner = self.inner.lock();
        if let Some(slot) = inner.clients.get(&client) {
            if slot.tx.send(wire).is_err() {
                inner.clients.remove(&client);
            }
        }
    }

    pub fn tabs_snapshot(&self) -> Vec<Value> {
        self.registry.lock().list().iter().map(tab_json).collect()
    }

    /// Any remaining client viewing a tab whose mirrored CDP session is
    /// `cdp_session_id`? Caller must already hold `inner`; the session
    /// mirror keeps this entirely inside `Inner` (no registry nesting).
    fn still_viewing_locked(&self, inner: &Inner, cdp_session_id: &str) -> bool {
        inner.clients.values().any(|slot| {
            slot.subs.iter().any(|tab_id| {
                inner
                    .tab_sessions
                    .get(tab_id)
                    .is_some_and(|s| s == cdp_session_id)
            })
        })
    }
}

/// Map one panel UI event onto the CDP call that produces it. Pure (no
/// browser) so the mapping is unit-pinned; the same primitives become
/// the model-facing action layer's floor (Phase 8 reuses this).
///
/// Coordinate space: viewport CSS pixels (C `Input.dispatchMouseEvent`
/// takes client-space CSS px; the panel's canvas→viewport scaling is the
/// client's job and is unit-tested there). Wheel deltas follow the DOM
/// `WheelEvent` convention the panel forwards (positive deltaY scrolls
/// down), which is also `Playwright.mouse.wheel`'s contract — passed
/// straight through to CDP `mouseWheel`.
pub(crate) fn input_dispatch(event: &Value) -> Result<(&'static str, Value), BrowserError> {
    let bad = |reason: String| BrowserError::PayloadInvalid {
        command: "browser_ui_input".into(),
        reason,
    };
    let kind = event
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("event.kind is required".into()))?;

    let point = |event: &Value| -> Result<(f64, f64), BrowserError> {
        let x = event.get("x").and_then(Value::as_f64);
        let y = event.get("y").and_then(Value::as_f64);
        match (x, y) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0 => {
                Ok((x, y))
            }
            _ => Err(bad(
                "event.x/event.y must be non-negative finite numbers".into()
            )),
        }
    };
    let modifiers = |event: &Value| -> u32 {
        let m = event.get("modifiers").and_then(Value::as_object);
        let on = |k: &str| {
            m.and_then(|m| m.get(k))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        (u32::from(on("alt")))
            | (u32::from(on("ctrl")) << 1)
            | (u32::from(on("meta")) << 2)
            | (u32::from(on("shift")) << 3)
    };

    match kind {
        "mouse" => {
            let (x, y) = point(event)?;
            let action = event.get("action").and_then(Value::as_str);
            let cdp_type = match action {
                Some("move") => "mouseMoved",
                Some("press") => "mousePressed",
                Some("release") => "mouseReleased",
                _ => return Err(bad("event.action must be move | press | release".into())),
            };
            let button = match event.get("button").and_then(Value::as_str) {
                None | Some("left") => "left",
                Some("middle") => "middle",
                Some("right") => "right",
                Some("none") => "none",
                Some(other) => return Err(bad(format!("unknown mouse button {other:?}"))),
            };
            // CDP counts the DOWN as the click: press carries clickCount,
            // the matching release carries the same count.
            let click_count = event
                .get("click_count")
                .and_then(Value::as_u64)
                .unwrap_or(if cdp_type == "mouseMoved" { 0 } else { 1 });
            Ok((
                "Input.dispatchMouseEvent",
                json!({
                    "type": cdp_type,
                    "x": x,
                    "y": y,
                    "button": if cdp_type == "mouseMoved" { "none" } else { button },
                    "clickCount": click_count,
                    "modifiers": modifiers(event),
                }),
            ))
        }
        "wheel" => {
            let (x, y) = point(event)?;
            Ok((
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": x,
                    "y": y,
                    "deltaX": event.get("delta_x").and_then(Value::as_f64).unwrap_or(0.0),
                    "deltaY": event.get("delta_y").and_then(Value::as_f64).unwrap_or(0.0),
                    "modifiers": modifiers(event),
                }),
            ))
        }
        "key" => {
            let action = event.get("action").and_then(Value::as_str);
            let cdp_type = match action {
                Some("down") => "keyDown",
                Some("up") => "keyUp",
                _ => return Err(bad("event.action must be down | up".into())),
            };
            let key = event
                .get("key")
                .and_then(Value::as_str)
                .filter(|k| !k.is_empty())
                .ok_or_else(|| bad("event.key is required".into()))?;
            let mut params = json!({
                "type": cdp_type,
                "key": key,
                "modifiers": modifiers(event),
            });
            // The panel forwards a real DOM KeyboardEvent, so the physical
            // code and legacy keyCode ride along when present; text rides
            // on keydown so Chromium synthesizes the char event.
            if let Some(code) = event.get("code").and_then(Value::as_str) {
                params["code"] = json!(code);
            }
            if let Some(vk) = event.get("key_code").and_then(Value::as_u64) {
                params["windowsVirtualKeyCode"] = json!(vk);
                params["nativeVirtualKeyCode"] = json!(vk);
            }
            if cdp_type == "keyDown" {
                if let Some(text) = event.get("text").and_then(Value::as_str) {
                    params["text"] = json!(text);
                }
            }
            Ok(("Input.dispatchKeyEvent", params))
        }
        "insert_text" => {
            let text = event
                .get("text")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                .ok_or_else(|| bad("event.text must be a non-empty string".into()))?;
            Ok(("Input.insertText", json!({ "text": text })))
        }
        other => Err(bad(format!("unknown input event kind {other:?}"))),
    }
}

// ── ticket entropy (std-only; see UiHub::new) ───────────────────────────

fn mix_seed() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0);
    let hasher1 = std::collections::hash_map::RandomState::new().build_hasher();
    let hasher2 = std::collections::hash_map::RandomState::new().build_hasher();
    let stack = std::thread::current().id();
    let mut thread_hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&stack, &mut thread_hasher);
    nanos.wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ hasher1.finish()
        ^ hasher2.finish().rotate_left(17)
        ^ thread_hasher.finish()
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub_with_tab(tab_id_hint: &str) -> (Arc<UiHub>, Arc<Mutex<Registry>>) {
        let registry = Arc::new(Mutex::new(Registry::default()));
        {
            let mut r = registry.lock();
            let rec = r.add_tab("target-1", "cdp-1", "https://example.test", "Example", None);
            assert_eq!(rec.tab_id, tab_id_hint);
        }
        (Arc::new(UiHub::new(Arc::clone(&registry))), registry)
    }

    #[test]
    fn tickets_are_single_use() {
        let (hub, _r) = hub_with_tab("1");
        let (ticket, ttl) = hub.mint_ticket();
        assert_eq!(ttl, WS_TICKET_TTL.as_millis() as u64);
        assert_eq!(ticket.len(), 32);
        assert!(hub.claim_ticket(&ticket), "first claim admits");
        assert!(
            !hub.claim_ticket(&ticket),
            "the same ticket cannot be replayed"
        );
        assert!(!hub.claim_ticket("00000000000000000000000000000000"));
    }

    #[test]
    fn tickets_distinct_across_mints() {
        let (hub, _r) = hub_with_tab("1");
        let (a, _) = hub.mint_ticket();
        let (b, _) = hub.mint_ticket();
        assert_ne!(a, b);
    }

    #[test]
    fn expired_tickets_are_refused_and_purged() {
        let (hub, _r) = hub_with_tab("1");
        let ticket = "deadbeefdeadbeefdeadbeefdeadbeef".to_string();
        hub.inner
            .lock()
            .tickets
            .insert(ticket.clone(), Instant::now());
        assert!(!hub.claim_ticket(&ticket), "expired tickets fail closed");
        assert!(hub.inner.lock().tickets.is_empty(), "expired entries purge");
    }

    #[test]
    fn screencast_starts_once_per_tab_and_stops_with_the_last_viewer() {
        let (hub, _r) = hub_with_tab("1");
        let (c1, _rx1) = hub.open();
        let (c2, _rx2) = hub.open();
        assert_eq!(
            hub.subscribe(c1, "1").unwrap().as_deref(),
            Some("cdp-1"),
            "first viewer starts the capture"
        );
        assert_eq!(
            hub.subscribe(c2, "1").unwrap(),
            None,
            "second viewer joins without restarting"
        );
        assert!(hub.watching("cdp-1"));
        assert_eq!(
            hub.unsubscribe(c1, "1").unwrap(),
            None,
            "one viewer remains: capture stays up"
        );
        assert_eq!(
            hub.unsubscribe(c2, "1").unwrap().as_deref(),
            Some("cdp-1"),
            "last viewer leaves: capture stops"
        );
        assert!(!hub.watching("cdp-1"));
    }

    #[test]
    fn socket_close_stops_only_sessions_left_without_viewers() {
        let (hub, _r) = hub_with_tab("1");
        let (c1, _rx1) = hub.open();
        let (c2, _rx2) = hub.open();
        hub.subscribe(c1, "1").unwrap();
        hub.subscribe(c2, "1").unwrap();
        assert!(
            hub.close(c1).is_empty(),
            "c2 still views the tab: nothing to stop"
        );
        let stopped = hub.close(c2);
        assert_eq!(stopped, vec!["cdp-1".to_string()]);
        assert!(!hub.is_connected(c2));
    }

    #[test]
    fn acting_requires_a_live_subscribed_socket() {
        let (hub, _r) = hub_with_tab("1");
        let (c1, _rx1) = hub.open();
        assert!(matches!(
            hub.require_subscribed(c1, "1"),
            Err(BrowserError::CapabilityBlocked { .. })
        ));
        hub.subscribe(c1, "1").unwrap();
        hub.require_subscribed(c1, "1").unwrap();
        assert!(matches!(
            hub.require_subscribed(999, "1"),
            Err(BrowserError::ContextUnavailable)
        ));
        // A stale tab handle fails closed like every other tab path.
        assert!(matches!(
            hub.subscribe(c1, "404"),
            Err(BrowserError::ContextUnavailable)
        ));
    }

    #[test]
    fn frames_fan_out_only_to_viewers_of_that_tab() {
        let (hub, _r) = hub_with_tab("1");
        let (watcher, mut wrx) = hub.open();
        let (_other, mut orx) = hub.open();
        hub.subscribe(watcher, "1").unwrap();
        hub.frame("cdp-1", "aW1n", Some(&json!({"timestamp": 1.0})));
        let got = wrx.try_recv().expect("viewer gets the frame");
        assert_eq!(got["type"], json!("frame"));
        assert_eq!(got["tab_id"], json!("1"));
        assert_eq!(got["data"], json!("aW1n"));
        assert!(
            orx.try_recv().is_err(),
            "non-viewers never receive frames (no cross-tab leak)"
        );
        // A frame for an unknown session is dropped, not fanned.
        hub.frame("cdp-gone", "x", None);
        assert!(wrx.try_recv().is_err());
    }

    #[test]
    fn tabs_snapshots_broadcast_to_every_connected_socket() {
        let (hub, _r) = hub_with_tab("1");
        let (_c1, mut rx1) = hub.open();
        let (_c2, mut rx2) = hub.open();
        hub.tabs_changed();
        for rx in [&mut rx1, &mut rx2] {
            let got = rx.try_recv().expect("broadcast reaches every client");
            assert_eq!(got["type"], json!("tabs"));
            assert_eq!(got["tabs"][0]["tab_id"], json!("1"));
            assert_eq!(got["tabs"][0]["created_by_agent"], json!(false));
        }
    }

    #[test]
    fn closed_sockets_evict_from_broadcast_instead_of_growing_queues() {
        let (hub, _r) = hub_with_tab("1");
        let (c1, rx1) = hub.open();
        drop(rx1);
        hub.tabs_changed();
        assert!(!hub.is_connected(c1), "dead socket evicted on send failure");
    }

    #[test]
    fn drop_tab_purges_views_and_capture_bookkeeping() {
        let (hub, registry) = hub_with_tab("1");
        let (c1, _rx1) = hub.open();
        hub.subscribe(c1, "1").unwrap();
        // The pump removes the registry row first, then notifies the hub.
        registry.lock().remove_tab("1");
        hub.drop_tab("1", "cdp-1");
        assert!(!hub.watching("cdp-1"));
        assert!(!hub.subscribed(c1, "1"));
        assert!(matches!(
            hub.unsubscribe(c1, "1"),
            Err(BrowserError::ContextUnavailable) | Ok(None)
        ));
    }

    // ── input mapping ────────────────────────────────────────────────

    #[test]
    fn mouse_press_release_map_to_cdp_dispatches() {
        let (method, press) =
            input_dispatch(&json!({"kind":"mouse","action":"press","x":200.0,"y":150.0})).unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(press["type"], json!("mousePressed"));
        assert_eq!(press["x"], json!(200.0));
        assert_eq!(press["button"], json!("left"));
        assert_eq!(press["clickCount"], json!(1));
        let (_, release) =
            input_dispatch(&json!({"kind":"mouse","action":"release","x":200.0,"y":150.0}))
                .unwrap();
        assert_eq!(release["type"], json!("mouseReleased"));
        let (_, mv) =
            input_dispatch(&json!({"kind":"mouse","action":"move","x":1.0,"y":2.0})).unwrap();
        assert_eq!(mv["type"], json!("mouseMoved"));
        assert_eq!(mv["button"], json!("none"));
    }

    #[test]
    fn modifier_names_pack_into_the_cdp_bitmask() {
        let (_, press) = input_dispatch(&json!({
            "kind": "mouse", "action": "press", "x": 0.0, "y": 0.0,
            "modifiers": {"ctrl": true, "shift": true}
        }))
        .unwrap();
        assert_eq!(press["modifiers"], json!(2 | 8));
    }

    #[test]
    fn wheel_deltas_pass_through_dom_convention() {
        // Panel sends DOM WheelEvent deltas (positive delta_y = scroll
        // down); CDP mouseWheel takes the same orientation as
        // Playwright's mouse.wheel — straight through, no inversion.
        let (method, wheel) = input_dispatch(&json!({
            "kind": "wheel", "x": 400.0, "y": 300.0, "delta_x": 0.0, "delta_y": 120.0
        }))
        .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(wheel["type"], json!("mouseWheel"));
        assert_eq!(wheel["deltaY"], json!(120.0));
    }

    #[test]
    fn key_events_forward_the_real_dom_keyboard_event_fields() {
        let (method, down) = input_dispatch(&json!({
            "kind": "key", "action": "down", "key": "a", "code": "KeyA",
            "key_code": 65, "text": "a"
        }))
        .unwrap();
        assert_eq!(method, "Input.dispatchKeyEvent");
        assert_eq!(down["type"], json!("keyDown"));
        assert_eq!(down["key"], json!("a"));
        assert_eq!(down["code"], json!("KeyA"));
        assert_eq!(down["windowsVirtualKeyCode"], json!(65));
        assert_eq!(down["text"], json!("a"));
        let (_, up) = input_dispatch(&json!({
            "kind": "key", "action": "up", "key": "a", "code": "KeyA", "key_code": 65
        }))
        .unwrap();
        assert_eq!(up["type"], json!("keyUp"));
        assert!(
            up.get("text").is_none(),
            "keyup must not carry text (no second char event)"
        );
    }

    #[test]
    fn insert_text_maps_to_the_paste_channel() {
        let (method, params) =
            input_dispatch(&json!({"kind": "insert_text", "text": "Ruke"})).unwrap();
        assert_eq!(method, "Input.insertText");
        assert_eq!(params["text"], json!("Ruke"));
    }

    #[test]
    fn malformed_events_are_typed_payload_refusals() {
        for bad in [
            json!({"kind":"mouse","action":"press","x":"200","y":150}),
            json!({"kind":"mouse","action":"press","x":-1.0,"y":150.0}),
            json!({"kind":"mouse","action":"shake","x":1.0,"y":1.0}),
            json!({"kind":"mouse","action":"press","x":1.0,"y":1.0,"button":"pinky"}),
            json!({"kind":"key","action":"down"}),
            json!({"kind":"insert_text","text":""}),
            json!({"kind":"telekinesis"}),
            json!({"action":"press","x":1.0,"y":1.0}),
        ] {
            let err = input_dispatch(&bad).expect_err("refused");
            assert!(
                matches!(err, BrowserError::PayloadInvalid { .. }),
                "{bad} produced {err:?}"
            );
        }
    }
}
