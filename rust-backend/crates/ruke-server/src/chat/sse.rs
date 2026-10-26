//! `ProgressChannel` — the early-open SSE writer of the progress path
//! (`app/api/chat/route.ts:666`). Frame grammar (Rule 2.3):
//!
//! ```text
//! data: {"ruke_stage":{…}}\n\n     stage events
//! data: {"ruke_error":{"message":"…"}}\n\n   terminal failure (then [DONE])
//! data: [DONE]\n\n                 exactly once, error path only (fail)
//! ```
//!
//! Raw model bytes go through `raw` with NO framing of their own — the
//! upstream's `data: [DONE]` arrives inside those bytes, and the channel
//! never appends a second one (the closed latch also prevents a `fail`
//! after the stream completed from duplicating `[DONE]`).
//!
//! The `closed` latch mirrors the TS closure variable: every write after
//! closure is a no-op, and a failed write (client gone: the receiver was
//! dropped ⇒ axum/hyper tore the connection down) closes the latch.

use bytes::Bytes;
use tokio::sync::mpsc;

use ruke_contracts::stages::{error_frame, stage_frame, StageEvent};

use crate::chat::headers::DONE_FRAME;

pub struct ProgressChannel {
    tx: mpsc::Sender<Bytes>,
    closed: bool,
}

impl ProgressChannel {
    pub fn new(tx: mpsc::Sender<Bytes>) -> Self {
        Self { tx, closed: false }
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// `frame(obj)`: `data: ` + compact JSON + `\n\n`, guarded by the latch.
    async fn frame(&mut self, obj: &serde_json::Value) {
        if self.closed {
            return;
        }
        let text = match serde_json::to_string(obj) {
            Ok(t) => t,
            // TS marks the channel closed when stringify/enqueue throws.
            // Our frame values are built from enums/strings and cannot
            // fail to serialize; the branch only mirrors the latch anyway.
            Err(_) => {
                self.closed = true;
                return;
            }
        };
        if self.tx.send(Bytes::from(format!("data: {text}\n\n"))).await.is_err() {
            self.closed = true; // the client is gone: stop writing
        }
    }

    pub async fn stage(&mut self, e: &StageEvent) {
        self.frame(&stage_frame(e)).await;
    }

    /// Model bytes pass through UNFRAMED (the scrubbed upstream stream).
    pub async fn raw(&mut self, bytes: Vec<u8>) {
        if self.closed {
            return;
        }
        if self.tx.send(Bytes::from(bytes)).await.is_err() {
            self.closed = true;
        }
    }

    /// Terminal failure: the error frame, then exactly one `[DONE]`.
    /// A `fail` after a normal `close` (or a second `fail`) writes nothing.
    pub async fn fail(&mut self, message: &str) {
        self.frame(&error_frame(message)).await;
        if !self.closed {
            self.closed = true;
            let _ = self.tx.send(Bytes::from_static(DONE_FRAME)).await;
        }
    }

    /// Normal end: close the stream WITHOUT emitting `[DONE]` — the
    /// upstream's own `[DONE]` already rode the raw bytes.
    pub fn close(&mut self) {
        self.closed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruke_contracts::decision::RendererMode;

    /// Reads until the channel closes — callers must `drop(ch)` first so
    /// the sender half actually closes (else `recv` waits forever).
    async fn drain(rx: &mut mpsc::Receiver<Bytes>) -> String {
        let mut out = String::new();
        while let Some(b) = rx.recv().await {
            out.push_str(std::str::from_utf8(&b).unwrap());
        }
        out
    }

    #[tokio::test]
    async fn stage_frames_use_the_ruke_stage_envelope() {
        let (tx, mut rx) = mpsc::channel(8);
        let mut ch = ProgressChannel::new(tx);
        let mut e = StageEvent::new("decision_done");
        e.mode = Some(RendererMode::StandardChat);
        e.ms = Some(7);
        ch.stage(&e).await;
        ch.close();
        drop(ch);
        assert_eq!(
            drain(&mut rx).await,
            "data: {\"ruke_stage\":{\"stage\":\"decision_done\",\"mode\":\"standard_chat\",\"ms\":7}}\n\n"
        );
    }

    #[tokio::test]
    async fn fail_emits_error_frame_then_exactly_one_done() {
        let (tx, mut rx) = mpsc::channel(8);
        let mut ch = ProgressChannel::new(tx);
        ch.fail("Could not reach the model server at 127.0.0.1:9.").await;
        ch.fail("again").await; // latch: nothing more, no duplicate [DONE]
        ch.close();
        drop(ch);
        assert_eq!(
            drain(&mut rx).await,
            concat!(
                "data: {\"ruke_error\":{\"message\":\"Could not reach the model server at 127.0.0.1:9.\"}}\n\n",
                "data: [DONE]\n\n",
            )
        );
    }

    #[tokio::test]
    async fn fail_after_close_writes_nothing() {
        // The upstream completed (its own [DONE] rode the raw bytes); a late
        // fail must NOT duplicate the sentinel.
        let (tx, mut rx) = mpsc::channel(8);
        let mut ch = ProgressChannel::new(tx);
        ch.raw(b"data: [DONE]\n\n".to_vec()).await;
        ch.close();
        ch.fail("late").await;
        drop(ch);
        assert_eq!(drain(&mut rx).await, "data: [DONE]\n\n");
    }

    #[tokio::test]
    async fn writes_after_the_receiver_drops_close_the_latch() {
        let (tx, rx) = mpsc::channel::<Bytes>(1);
        drop(rx); // models hyper dropping the response body
        let mut ch = ProgressChannel::new(tx);
        ch.raw(b"x".to_vec()).await;
        assert!(ch.is_closed());
        ch.fail("boom").await; // frame no-ops; the [DONE] branch is gated too
        assert!(ch.is_closed());
    }
}
