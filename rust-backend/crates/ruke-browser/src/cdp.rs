//! cdp.rs — the CDP-over-WebSocket client: Rust's sole control channel to
//! the subordinate Chromium (plan §0 — no Playwright library drives the
//! agent browser). One WebSocket multiplexes flat sessions (`sessionId`),
//! matching CDP's flattened attach model (`Target.attachToTarget
//! flatten:true`).
//!
//! Design notes:
//! - Request/response correlation via a monotonic id + oneshot waiters;
//!   every `call` carries a fixed transport deadline so a wedged renderer
//!   can never hang the engine forever (per-command budgets arrive with
//!   their phases; turn cancellation aborts at the loop layer, Phase 10).
//! - Events are forwarded on an unbounded channel; the engine's pump
//!   consumer is the sole drain, so the queue depth tracks live browser
//!   activity, not an unbounded firehose (the bounded replay buffer of
//!   §"CDP buffer" is Phase 4 and layers on top of this channel).
//! - A dead socket (or failed write) marks the conn dead and fails every
//!   parked waiter — "stale handles fail closed" starts here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::errors::BrowserError;

/// One browser-emitted CDP event, kept generic (raw params) until the
/// phase that consumes it gives it meaning.
#[derive(Clone, Debug)]
pub struct CdpEvent {
    pub method: String,
    pub session_id: Option<String>,
    pub params: Value,
}

/// Transport deadline for a single CDP RPC. Generous: page-less browser
/// calls (Target.*/Browser.*) answer in milliseconds; a renderer-domain
/// call that legitimately takes long (evaluate on a busy page) gets its
/// own phase-level budget later — this only bounds the socket round-trip.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
struct WireError {
    message: String,
}

struct Inner {
    next_id: AtomicU64,
    alive: AtomicBool,
    out: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, WireError>>>>,
}

impl Inner {
    /// Socket died: stop accepting new calls and fail every waiter.
    fn kill(&self) {
        self.alive.store(false, Ordering::Relaxed);
        let drained: Vec<_> = self.pending.lock().drain().map(|(_, w)| w).collect();
        for w in drained {
            let _ = w.send(Err(WireError {
                message: "CDP socket closed".into(),
            }));
        }
    }
}

/// A live CDP connection. Cheap to clone-share via `Arc`.
pub struct CdpConn {
    inner: Arc<Inner>,
}

/// Everything `connect` spawns/returns; the host owns the task handles so
/// shutdown can abort them (they also self-terminate when the socket dies).
pub struct Opened {
    pub conn: Arc<CdpConn>,
    pub events: mpsc::UnboundedReceiver<CdpEvent>,
    pub writer: JoinHandle<()>,
    pub reader: JoinHandle<()>,
}

impl CdpConn {
    pub async fn connect(ws_url: &Url) -> Result<Opened, BrowserError> {
        // `&str` implements IntoClientRequest (tungstenite's own URI type,
        // not `url::Url` — which does not).
        let (ws, _resp) = tokio_tungstenite::connect_async(ws_url.as_str())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, url = %ws_url, "CDP WebSocket connect failed");
                BrowserError::HostUnavailable
            })?;
        let (mut sink, mut stream) = ws.split();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        let (ev_tx, ev_rx) = mpsc::unbounded_channel::<CdpEvent>();
        let inner = Arc::new(Inner {
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            out: out_tx,
            pending: Mutex::new(HashMap::new()),
        });

        let w_inner = inner.clone();
        let writer = tokio::spawn(async move {
            while let Some(text) = out_rx.recv().await {
                if sink.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
            w_inner.kill();
        });

        let r_inner = inner.clone();
        let reader = tokio::spawn(async move {
            while let Some(msg) = stream.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(v) = serde_json::from_str::<Value>(text.as_str()) {
                            route_frame(v, &ev_tx, &r_inner);
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {} // Ping/Pong/Binary: CDP frames are text; keep-alives are answered by tungstenite internally.
                    Err(e) => {
                        tracing::debug!(error = %e, "CDP socket read error");
                        break;
                    }
                }
            }
            r_inner.kill();
        });

        Ok(Opened {
            conn: Arc::new(CdpConn { inner }),
            events: ev_rx,
            writer,
            reader,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::Relaxed)
    }

    /// Send one CDP method and await its result. `session_id` targets a
    /// flattened session (per-tab domain calls); `None` is browser-level.
    pub async fn call(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> Result<Value, BrowserError> {
        if !self.is_alive() {
            return Err(BrowserError::HostUnavailable);
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().insert(id, tx);

        let mut frame = Map::new();
        frame.insert("id".into(), json!(id));
        frame.insert("method".into(), json!(method));
        if let Some(p) = params {
            frame.insert("params".into(), p);
        }
        if let Some(s) = session_id {
            frame.insert("sessionId".into(), json!(s));
        }
        if self
            .inner
            .out
            .send(Value::Object(frame).to_string())
            .is_err()
        {
            self.inner.pending.lock().remove(&id);
            return Err(BrowserError::HostUnavailable);
        }

        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Err(_) => {
                self.inner.pending.lock().remove(&id);
                Err(BrowserError::TimedOut {
                    what: format!("CDP method {method}"),
                })
            }
            Ok(Err(_)) => {
                self.inner.pending.lock().remove(&id);
                Err(BrowserError::HostUnavailable)
            }
            Ok(Ok(Err(e))) => Err(BrowserError::CdpFailed {
                method: method.to_string(),
                reason: e.message,
            }),
            Ok(Ok(Ok(v))) => Ok(v),
        }
    }
}

/// Reader-side demux: an `id` frame answers a parked waiter; a `method`
/// frame is an event and goes to the pump.
fn route_frame(v: Value, ev_tx: &mpsc::UnboundedSender<CdpEvent>, inner: &Inner) {
    let Some(obj) = v.as_object() else { return };
    if let Some(id) = obj.get("id").and_then(Value::as_u64) {
        let waiter = inner.pending.lock().remove(&id);
        let Some(waiter) = waiter else { return }; // late reply after timeout: drop
        let outcome = if let Some(err) = obj.get("error") {
            Err(WireError {
                message: err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown CDP error")
                    .to_string(),
            })
        } else {
            Ok(obj
                .get("result")
                .cloned()
                .unwrap_or(Value::Object(Map::new())))
        };
        let _ = waiter.send(outcome);
        return;
    }
    if let Some(method) = obj.get("method").and_then(Value::as_str) {
        let _ = ev_tx.send(CdpEvent {
            method: method.to_string(),
            session_id: obj
                .get("sessionId")
                .and_then(Value::as_str)
                .map(String::from),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal stand-in for the live socket pair: an `Inner` with an
    /// empty pending map, plus the event channel (sender + receiver) the
    /// reader task would own.
    struct Harness {
        inner: Inner,
        ev_tx: mpsc::UnboundedSender<CdpEvent>,
        ev_rx: mpsc::UnboundedReceiver<CdpEvent>,
    }

    impl Harness {
        fn new() -> Self {
            let (out_tx, _out_rx) = mpsc::unbounded_channel::<String>();
            let (ev_tx, ev_rx) = mpsc::unbounded_channel::<CdpEvent>();
            Self {
                inner: Inner {
                    next_id: AtomicU64::new(2),
                    alive: AtomicBool::new(true),
                    out: out_tx,
                    pending: Mutex::new(HashMap::new()),
                },
                ev_tx,
                ev_rx,
            }
        }

        /// Park a waiter under `id` and return its reply channel. Takes
        /// `&self`: the pending map is already behind a mutex, exactly
        /// like the real `Inner`.
        fn park(&self, id: u64) -> oneshot::Receiver<Result<Value, WireError>> {
            let (tx, rx) = oneshot::channel();
            self.inner.pending.lock().insert(id, tx);
            rx
        }
    }

    /// Contract every eval reader in the engine assumes: the waiter
    /// receives the *command* result (wire `result` unwrapped once), so
    /// a Runtime.evaluate value sits at `result.value` of the awaited
    /// value — not two levels deep. The real-Chromium smoke surfaced a
    /// reader that forgot this unwrap; this pins the contract.
    #[test]
    fn route_frame_delivers_the_unwrapped_command_result() {
        let mut h = Harness::new();
        let mut rx = h.park(1);
        route_frame(
            json!({
                "id": 1,
                "result": { "result": { "type": "string", "value": "Ruke Smoke Page A" } }
            }),
            &h.ev_tx,
            &h.inner,
        );
        let got = rx.try_recv().expect("waiter answered").expect("ok result");
        assert_eq!(
            got.pointer("/result/value").and_then(Value::as_str),
            Some("Ruke Smoke Page A")
        );
        assert!(h.inner.pending.lock().is_empty(), "waiter slot drained");
        assert!(h.ev_rx.try_recv().is_err(), "reply frames are not events");
    }

    #[test]
    fn route_frame_maps_error_frames_to_a_typed_wire_error() {
        let h = Harness::new();
        let mut rx = h.park(7);
        route_frame(
            json!({"id": 7, "error": {"code": -32000, "message": "Not found"}}),
            &h.ev_tx,
            &h.inner,
        );
        let err = rx.try_recv().expect("waiter answered").unwrap_err();
        assert_eq!(err.message, "Not found");
    }

    /// A frame whose id has no parked waiter (reply arrived after the
    /// call's deadline) must be dropped, not panicked on or buffered.
    #[test]
    fn route_frame_drops_late_replies() {
        let mut h = Harness::new();
        route_frame(json!({"id": 99, "result": {}}), &h.ev_tx, &h.inner);
        assert!(h.ev_rx.try_recv().is_err());
    }

    #[test]
    fn route_frame_forwards_method_frames_as_events() {
        let mut h = Harness::new();
        route_frame(
            json!({"method": "Page.loadEventFired", "sessionId": "s-1", "params": {"timestamp": 1.0}}),
            &h.ev_tx,
            &h.inner,
        );
        let got = h.ev_rx.try_recv().expect("event forwarded");
        assert_eq!(got.method, "Page.loadEventFired");
        assert_eq!(got.session_id.as_deref(), Some("s-1"));
        assert_eq!(got.params["timestamp"], json!(1.0));
    }
}
