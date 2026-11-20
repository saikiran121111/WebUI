//! The two upstream-forwarding shapes of the oracle
//! (`forwardStream` route.ts:107 and `forwardStreamInto` route.ts:221).
//!
//! Both paths:
//! - take the inference slot BEFORE the request leaves (Rule 5: the slot
//!   is held for the whole streamed turn and released EXACTLY once —
//!   `InferenceSlotGuard`'s `Drop` runs on completion, error, abort and
//!   panic alike),
//! - stream the upstream body RAW into a bounded `mpsc` channel (Rule 8: a
//!   slow client suspends the upstream read instead of buffering the whole
//!   response). Raw means RAW: the 2026-11-13 brief §2 retires the Part-4
//!   byte-scrubber deviation — the transport never decodes, rewrites or
//!   deletes bytes; the client's own `lib/stream/thinkTags.ts` splitter
//!   routes `<think>` text inside already-parsed fields (⇔ Rust
//!   [`super::scrubber::ThinkFieldSplitter`] in the audit relays),
//! - propagate client abort: `AbortOnDrop` cancels the request's
//!   cancellation token, the pump's `select!` wakes, dropping the reqwest
//!   response future/body closes the upstream connection (⇔ `signal.aborted`
//!   checks + `inner.abort()` in TS),
//! - never rewrite success bytes: EVERY byte (including any `<think>`
//!   markup and the upstream's own `data: [DONE]`) passes byte-verbatim.
//!
//! Client-visible failure mapping is in `error.rs`; the two shapes differ
//! only in HOW the message surfaces (status+JSON body ⇔ `ruke_error` frame).

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;

use axum::body::Body;
use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::Response;
use bytes::Bytes;
use futures_util::stream::Stream;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use tracing::Span;

use crate::chat::{error, headers::stream_headers, sse::ProgressChannel};
use crate::AppState;

/// Bounded pump queue: ~64 upstream chunks max in flight. Backpressure to
/// the model server happens by simply not polling `chunk()` while the queue
/// is full (the send awaits), which is the reqwest equivalent of TS's
/// queued `ReadableStream` under `writer.write()` backpressure.
pub const PUMP_BUFFER: usize = 64;

/// Wrapper that fires `token.cancel()` when the response body is dropped
/// (axum/hyper drops it when the client disconnects mid-stream). This is
/// the Rust wiring of TS's `cancel()` → `inner.abort()` on the progress
/// stream and of `req.signal` propagation on the legacy path.
pub struct AbortOnDrop<S> {
    inner: S,
    token: CancellationToken,
}

impl<S> AbortOnDrop<S> {
    pub fn new(inner: S, token: CancellationToken) -> Self {
        Self { inner, token }
    }
}

impl<S: Stream + Unpin> Stream for AbortOnDrop<S> {
    type Item = S::Item;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<S::Item>> {
        Pin::new(&mut self.inner).poll_next(cx)
    }
}

impl<S> Drop for AbortOnDrop<S> {
    fn drop(&mut self) {
        // Idempotent; also a no-op when the stream completed normally.
        self.token.cancel();
    }
}

/// Legacy path (`forwardStream`): returns a real HTTP response carrying the
/// RAW upstream body with `streamHeaders(upstream.content-type)`.
/// `web_citations`/`search_gate` are the Part-8 web-gate pair (Rule 2.3):
/// TS passes `(webCitationMap, webCitationMap ? searchGateMeta : null)`,
/// so the CALLER enforces the pairing — the gate parameter is only ever
/// `Some` together with a `Some` citations map.
#[allow(clippy::too_many_arguments)] // mirrors the oracle's forwardStream arity
pub async fn forward_legacy(
    state: &AppState,
    body: Vec<u8>,
    used_skill: Option<&str>,
    decision_mode: &str,
    web_citations: Option<&ruke_contracts::stages::CitationMap>,
    search_gate: Option<&ruke_contracts::stages::ResearchMeta>,
    model: &str,
    span: &Span,
    token: CancellationToken,
) -> Response {
    let url = state.settings.llm_api_url();
    let api_key = state.settings.llm_api_key();

    // Slot first, before the network — held by `guard` until this fn's
    // early-return paths drop it, or the pump task ends.
    let guard = state.slot.clone().begin_guard();

    tracing::info!(parent: span, model, mode = decision_mode, url = %url, "llm stream start");

    let headers = match error::upstream_headers(&api_key) {
        Some(h) => h,
        None => {
            // Non-ASCII API key: JS `fetch` throws inside the try, landing
            // in the same catch as a connection error ⇒ 503 below.
            tracing::error!(parent: span, "llm server unreachable");
            return error::json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                &error::unreachable_message(&url),
            );
        }
    };

    // Brief §3.1: the CAPACITY-1 admission permit for the upstream
    // generation. Acquired here (just before the POST) and MOVED INTO THE
    // PUMP below, so it is held across the ENTIRE streamed response —
    // never released when headers arrive. Early-return paths (non-2xx,
    // no-body, errors) drop it at fn exit, exactly like `guard`.
    let permit = match state.admission.acquire(&token).await {
        Ok(p) => p,
        Err(ruke_core::admission::AdmissionError::QueueFull) => {
            tracing::warn!(parent: span, "llm stream rejected: shared-endpoint queue full");
            return error::json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Model endpoint is busy; please retry.",
            );
        }
        Err(ruke_core::admission::AdmissionError::Cancelled) => {
            tracing::warn!(parent: span, "llm stream aborted by client");
            return error::json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                &error::unreachable_message(&url),
            );
        }
        Err(ruke_core::admission::AdmissionError::HandoffHeld) => {
            // Honest, distinct refusal: the model is deliberately parked by
            // an exclusive document/media job, so waking it here would break
            // that job's memory/VRAM window. The UI shows this and retries.
            tracing::warn!(
                parent: span,
                "llm stream refused: a document/media job holds the endpoint lease"
            );
            return error::json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "A document or media job has the model parked; retry in a moment.",
            );
        }
    };

    // TS checks `signal.aborted` before/after the fetch; axum cannot
    // observe a disconnect before the response exists, and the abort arm
    // below returns the same 503 the TS fall-through produces, so the
    // race is unobservable either way.
    let sent = tokio::select! {
        biased;
        _ = token.cancelled() => {
            tracing::warn!(parent: span, "llm stream aborted by client");
            return error::json_error(StatusCode::SERVICE_UNAVAILABLE, &error::unreachable_message(&url));
        }
        r = state.http.post(&url).headers(headers).body(body).send() => r,
    };

    let upstream = match sent {
        Ok(u) => u,
        Err(_) => {
            tracing::error!(parent: span, "llm server unreachable");
            return error::json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                &error::unreachable_message(&url),
            );
        }
    };

    let status = upstream.status();
    if !status.is_success() {
        // TS: `await upstream.text()` (catch ⇒ ""), error log, status mirror.
        let err_text = upstream.text().await.unwrap_or_default();
        tracing::error!(parent: span, status = status.as_u16(), "llm upstream error");
        let code =
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        return error::json_error(
            code,
            &error::upstream_error_message(status.as_u16(), &err_text),
        );
    }

    // undici: `res.body === null` for 204/205/304 ⇒ the 502 branch. A 200
    // with `content-length: 0` HAS a body (empty stream) and must NOT 502.
    if matches!(status.as_u16(), 204 | 205 | 304) {
        tracing::error!(parent: span, "llm upstream returned no body");
        return error::json_error(StatusCode::BAD_GATEWAY, "No response body from model");
    }

    let content_type = upstream
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(PUMP_BUFFER);
    let pump_token = token.clone();
    let pump_span = span.clone();
    let pump_model = model.to_string();
    let pump_mode = decision_mode.to_string();
    tokio::spawn(async move {
        run_pump(
            upstream, guard, permit, tx, pump_token, pump_span, pump_model, pump_mode,
        )
        .await;
    });

    let body_stream = AbortOnDrop::new(ReceiverStream::new(rx), token);
    let mut resp = Response::new(Body::from_stream(body_stream));
    *resp.status_mut() = StatusCode::OK; // default, made explicit
    resp.headers_mut().extend(stream_headers(
        content_type.as_deref(),
        used_skill,
        decision_mode,
        web_citations,
        search_gate,
    ));
    resp
}

/// Shared pump loop for both shapes: RAW upstream chunks into `tx`
/// (byte-for-byte transport — the 2026-11-13 brief §2 retires the
/// byte-scrubber deviation: the transport is never rewritten; the client's
/// own `lib/stream/thinkTags.ts` splitter routes `<think>` text inside
/// already-parsed fields), exactly one guard release, client-abort and
/// mid-error handling.
///
/// `_permit` is the §3.1 capacity-1 upstream-generation permit: it drops
/// HERE — when the response body has fully drained or the pump aborted —
/// never at headers-arrival, so the shared endpoint is exclusively ours for
/// the ENTIRE streamed response.
async fn run_pump(
    mut upstream: reqwest::Response,
    _guard: ruke_core::slot::UserTurnGuard,
    _permit: ruke_core::admission::AdmissionPermit,
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
    token: CancellationToken,
    span: Span,
    model: String,
    mode: String,
) {
    let started = Instant::now();
    let mut chunks_in = 0u64;
    let mut bytes_out = 0u64;
    let mut aborted = false;
    let mut failed = false;

    loop {
        let chunk = tokio::select! {
            biased;
            _ = token.cancelled() => {
                aborted = true;
                break;
            }
            c = upstream.chunk() => c,
        };
        match chunk {
            Ok(Some(bytes)) => {
                chunks_in += 1;
                if !bytes.is_empty() {
                    bytes_out += bytes.len() as u64;
                    if tx.send(Ok(bytes)).await.is_err() {
                        // the response body is gone ⇒ the client disconnected
                        aborted = true;
                        break;
                    }
                }
            }
            Ok(None) => break,
            Err(_) => {
                // TS: the TransformStream errors ⇒ the client body aborts
                // mid-stream (no trailer). Err item ends the body stream.
                tracing::error!(parent: &span, "llm stream chunk error");
                failed = true;
                let _ = tx
                    .send(Err(io::Error::other("upstream stream error")))
                    .await;
                break;
            }
        }
    }

    if aborted {
        tracing::warn!(parent: &span, "llm stream aborted by client");
    } else if !failed {
        // No scrubber tail: the transport never buffers or rewrites bytes,
        // so whatever arrived is exactly what the client saw.
        tracing::info!(
            parent: &span,
            model = model.as_str(),
            mode = mode.as_str(),
            sse_chunks = chunks_in,
            bytes_out,
            ms = started.elapsed().as_millis() as u64,
            "llm stream complete"
        );
    }

    // ORDERED teardown (R02/R05 law: never admit the next request while the
    // previous generation's upstream is still open). Rust drops function
    // parameters in REVERSE declaration order, so `_permit` — declared AFTER
    // `upstream` — would otherwise be released BEFORE the (abandoned) upstream
    // response is dropped, letting a queued request reach the shared endpoint
    // while the old connection/handler is still alive. Dropping `upstream`
    // explicitly closes our side of that connection first; the permit is
    // released only afterwards.
    drop(upstream);

    // `_guard` drops HERE: exactly once, on every exit path.
}

/// Progress path (`forwardStreamInto`): pumps RAW bytes into the
/// `ProgressChannel`; every failure is a `ruke_error` frame with the SAME
/// message the legacy path puts in its JSON body.
pub async fn forward_into(
    state: &AppState,
    body: Vec<u8>,
    decision_mode: &str,
    model: &str,
    span: &Span,
    token: &CancellationToken,
    ch: &mut ProgressChannel,
) {
    let url = state.settings.llm_api_url();
    let api_key = state.settings.llm_api_key();
    // Named `_guard` (not `_`): it must live to the END of the function so
    // the slot is held across the whole pump and released exactly once.
    let _guard = state.slot.clone().begin_guard();

    tracing::info!(parent: span, model, mode = decision_mode, url = %url, "llm stream start");

    let headers = match error::upstream_headers(&api_key) {
        Some(h) => h,
        None => {
            tracing::error!(parent: span, "llm server unreachable");
            ch.fail(&error::unreachable_message(&url)).await;
            return;
        }
    };

    // §3.1: capacity-1 upstream permit, named `_permit` so it lives to the
    // END of the function — held across the whole inline pump, released
    // exactly once on every exit path (mirrors `_guard` above).
    let _permit = match state.admission.acquire(token).await {
        Ok(p) => p,
        Err(ruke_core::admission::AdmissionError::QueueFull) => {
            tracing::warn!(parent: span, "llm stream rejected: shared-endpoint queue full");
            ch.fail("Model endpoint is busy; please retry.").await;
            return;
        }
        Err(ruke_core::admission::AdmissionError::Cancelled) => {
            tracing::warn!(parent: span, "llm stream aborted by client");
            ch.close();
            return;
        }
        Err(ruke_core::admission::AdmissionError::HandoffHeld) => {
            tracing::warn!(
                parent: span,
                "llm stream refused: a document/media job holds the endpoint lease"
            );
            ch.fail("A document or media job has the model parked; retry in a moment.")
                .await;
            return;
        }
    };

    let sent = tokio::select! {
        biased;
        _ = token.cancelled() => {
            tracing::warn!(parent: span, "llm stream aborted by client");
            ch.close();
            return;
        }
        r = state.http.post(&url).headers(headers).body(body).send() => r,
    };

    let mut upstream = match sent {
        Ok(u) => u,
        Err(_) => {
            tracing::error!(parent: span, "llm server unreachable");
            ch.fail(&error::unreachable_message(&url)).await;
            return;
        }
    };

    let status = upstream.status();
    if !status.is_success() {
        let err_text = upstream.text().await.unwrap_or_default();
        tracing::error!(parent: span, status = status.as_u16(), "llm upstream error");
        ch.fail(&error::upstream_error_message(status.as_u16(), &err_text))
            .await;
        return;
    }
    if matches!(status.as_u16(), 204 | 205 | 304) {
        tracing::error!(parent: span, "llm upstream returned no body");
        ch.fail("No response body from model").await;
        return;
    }

    let started = Instant::now();
    let mut chunks_in = 0u64;
    let mut bytes_out = 0u64;
    let mut aborted = false;

    loop {
        let chunk = tokio::select! {
            biased;
            _ = token.cancelled() => {
                aborted = true;
                break;
            }
            c = upstream.chunk() => c,
        };
        match chunk {
            Ok(Some(bytes)) => {
                chunks_in += 1;
                if !bytes.is_empty() {
                    bytes_out += bytes.len() as u64;
                    ch.raw(bytes.to_vec()).await;
                    if ch.is_closed() {
                        // the client is gone (write failed): stop reading
                        // upstream — ⇔ inner.abort() closing the fetch
                        token.cancel();
                        aborted = true;
                        break;
                    }
                }
            }
            Ok(None) => break,
            Err(_) => {
                tracing::error!(parent: span, "llm stream chunk error");
                ch.fail(&error::unreachable_message(&url)).await;
                return; // guard drops at fn end
            }
        }
    }

    if aborted {
        tracing::warn!(parent: span, "llm stream aborted by client");
        ch.close();
    } else {
        // No scrubber tail — raw transport, nothing is held back.
        tracing::info!(
            parent: span,
            model,
            mode = decision_mode,
            sse_chunks = chunks_in,
            bytes_out,
            ms = started.elapsed().as_millis() as u64,
            "llm stream complete"
        );
        ch.close(); // no [DONE] here: the upstream's rode the raw bytes
    }
    // guard drops here too: exactly once.
}
