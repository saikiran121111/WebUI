//! `POST /api/chat` — the Rust port of the oracle handler
//! (`app/api/chat/route.ts:566`). The TS route stays authoritative; this
//! endpoint exists for isolated parity testing only (MIGRATION-MAP §25/26).
//!
//! Flow (mirrors the oracle line-for-line):
//! 1. read the raw body — NOT inside the JSON try; a read failure is the
//!    Next 500 equivalent;
//! 2. `JSON.parse` best-effort: `null` (or parse failure) ⇒ the payload
//!    stays `null` and the raw bytes are forwarded verbatim (fixture 03);
//!    non-object parse results (numbers/strings) survive exactly like JS
//!    so `JSON.stringify(payload)` reproduces them;
//! 3. `model` = non-empty string or `"default"`;
//! 4. compaction (`purpose === "compact"` strictly) ⇒ strip the marker +
//!    attachment refs, forward VERBATIM on the legacy shape (fixture 05);
//! 5. the decision gate, entered ONLY when `messages` is a NON-EMPTY array
//!    (fixture 04c skips it entirely): slash-skill routing, pinned
//!    `decision_mode` repair-passthrough (key ALWAYS deleted inside the
//!    gate), history, decision, then the progress path unless
//!    `stream === false` strictly (fixture 06a vs 06b);
//! 6. the common tail: strip attachment refs, re-serialize the (mutated)
//!    payload or fall back to the raw bytes, forward on the legacy shape.

use std::time::Instant;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::stream::StreamExt;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tracing::Instrument;

use ruke_contracts::decision::{DecisionEnvelope, RendererMode};
use ruke_core::turn::TurnContext;
use ruke_decision::engine::get_decision_sync;
use ruke_skills::jsstr::js_trim;
use ruke_skills::lazy::{apply_slash_skill_routing, last_user_index};

use crate::chat::{attach, forward, headers::stream_headers, pipeline, sse::ProgressChannel};
use crate::AppState;

/// Body cap protecting the process (Next imposes no equivalent limit; see
/// the module docs in `tests/` notes and STATE.md for this documented
/// deviation — chat payloads carry attachment *refs*, not bytes, so the
/// real ceiling is orders of magnitude below this).
pub const MAX_CHAT_BODY: usize = 128 * 1024 * 1024;

pub async fn chat_post(State(state): State<AppState>, req: Request) -> Response {
    // Rule 6/17: one cancellation tree + one turn id per request. The
    // shared root token drives response-body drop ⇒ upstream abort; the
    // span carries `turn_id` into every log line (instrumented below so
    // `parent:`-attached logs in the forwarders land in the same context).
    let turn = state.turns.turn();
    chat_inner(state, &turn, req)
        .instrument(turn.span.clone())
        .await
}

async fn chat_inner(state: AppState, turn: &TurnContext, req: Request) -> Response {
    let token = turn.root_token().clone();
    let span = turn.span.clone();

    // (1) `const raw = await req.text()` — outside any catch: a failed
    // body read is a 500 in Next, mirrored here.
    let raw_bytes = match read_capped(req.into_body(), MAX_CHAT_BODY).await {
        Some(b) => b,
        None => {
            tracing::warn!("chat request body read failed or exceeded the size cap");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // Lossy decode mirrors what `req.text()` would surface for invalid
    // UTF-8; the ORIGINAL bytes are what gets forwarded verbatim when the
    // payload is unparseable, so the only divergence is for inputs the
    // browser fetch could not have produced.
    let raw_s = String::from_utf8_lossy(&raw_bytes).into_owned();

    // (2) JSON.parse with the same "null stays null" semantics.
    let mut payload: Option<Value> = serde_json::from_str::<Value>(&raw_s)
        .ok()
        .filter(|v| !v.is_null());

    // (3)
    let model: String = payload
        .as_ref()
        .and_then(|p| p.get("model"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string();
    let mut used_skill: Option<String> = None;
    let mut decision_mode: RendererMode = RendererMode::StandardChat;
    // The web gate's outputs, fed to the legacy tail's header pair
    // (Rule 2.3). Stays default (None/None) on every path except the
    // legacy decision fall-through where the pipeline actually ran the gate.
    let mut web_outcome = pipeline::PipelineOutcome::default();

    // (4) compaction passthrough (strict === "compact")
    if let Some(p) = payload.as_mut() {
        if p.get("purpose").and_then(Value::as_str) == Some("compact") {
            attach::remove_key(p, "purpose"); // transport marker: never forwarded
            if let Some(messages) = p.get_mut("messages").and_then(Value::as_array_mut) {
                attach::strip_attachment_refs(messages);
            }
            tracing::info!(
                model = model.as_str(),
                "compaction passthrough: skipping decision pipeline"
            );
            let body = serde_json::to_vec(p).unwrap_or_default();
            return forward::forward_legacy(
                &state,
                body,
                None,
                RendererMode::StandardChat.as_str(),
                None,
                None,
                &model,
                &span,
                token,
            )
            .await;
        }
    }

    // (5) the decision gate: NON-EMPTY messages array only (04c skips it).
    if let Some(p) = payload.as_mut() {
        if p.get("messages")
            .and_then(Value::as_array)
            .is_some_and(|m| !m.is_empty())
        {
            // TS wraps this in try/catch; the Rust port degrades internally
            // (every IO failure in routing already yields None), so there
            // is nothing to catch here — same observable outcome.
            used_skill = apply_slash_skill_routing(p, &state.root);

            // Snapshot the gate inputs first (the borrow ends here), then
            // mutate `p` — TS's dynamic object needs no such dance; this is
            // purely Rust borrow structure, same observable order.
            let gate = {
                let messages = p.get("messages").and_then(Value::as_array).unwrap();
                last_user_index(messages).map(|idx| {
                    let full_text = attach::first_text_part(messages[idx].get("content"));
                    // Pinned mode (client repair-passthrough) — read BEFORE
                    // the delete.
                    let pinned = p
                        .get("decision_mode")
                        .and_then(Value::as_str)
                        .and_then(RendererMode::parse);
                    // Pre-mutation snapshot for the Part-5 retrieval
                    // frames: `hasAttachmentRef` rides the LAST USER
                    // TURN's parts, evaluated before the pipeline
                    // injects anything (route.ts:644 / :758).
                    let has_refs = attach::turn_has_attachment_ref(messages[idx].get("content"));
                    (idx, full_text, pinned, has_refs)
                })
            };
            if let Some((idx, full_text, pinned, has_refs)) = gate {
                // `delete payload.decision_mode` runs UNCONDITIONALLY
                // inside this gate, on both paths (fixture 06a proves the
                // forwarded upstream body has the key gone on legacy too).
                attach::remove_key(p, "decision_mode");

                let history = attach::history_before(
                    p.get("messages").and_then(Value::as_array).unwrap(),
                    idx,
                );
                let decision_started = Instant::now();
                let env = match pinned {
                    Some(m) => DecisionEnvelope::passthrough(m, &full_text),
                    None => get_decision_sync(
                        if js_trim(&full_text).is_empty() {
                            ""
                        } else {
                            &full_text
                        },
                        &history,
                    ),
                };
                let decision_ms = decision_started.elapsed().as_millis() as u64;
                decision_mode = env.active_mode;

                // env.stripped_prompt is always the verbatim message (the
                // in-process router never rewrites); the user turn stays
                // untouched, so it is intentionally not applied.

                // stream === false STRICTLY selects the legacy shape.
                if p.get("stream") != Some(&json!(false)) {
                    // Progress path: EARLY-OPEN response — headers first,
                    // the decision frame follows asynchronously.
                    let (tx, rx) = mpsc::channel::<Bytes>(forward::PUMP_BUFFER);
                    // The progress path's headers are built BEFORE the web
                    // gate runs (route.ts), so the citation/gate pair can
                    // never ride them — the citations travel in the
                    // `web_meta` frame instead (Rule 2.2/2.3).
                    let resp_headers = stream_headers(
                        None,
                        used_skill.as_deref(),
                        decision_mode.as_str(),
                        None,
                        None,
                    );
                    let payload_owned = std::mem::replace(p, Value::Null);
                    tokio::spawn(pipeline::pump_progress(
                        state.clone(),
                        payload_owned,
                        env,
                        decision_ms,
                        used_skill.clone(),
                        model.clone(),
                        idx,
                        has_refs,
                        full_text,
                        // Pre-mutation snapshot (the same one the decision
                        // used): recomputing it inside the pipeline after
                        // injections would shift the window and drop turns.
                        history,
                        span.clone(),
                        token.clone(),
                        ProgressChannel::new(tx),
                    ));
                    // Dropping this body (client walked away) cancels the
                    // token: the pump stops reading upstream and the
                    // upstream connection closes — ⇔ the ReadableStream's
                    // `cancel()` calling `inner.abort()`.
                    let body_stream = forward::AbortOnDrop::new(
                        ReceiverStream::new(rx).map(Ok::<_, std::io::Error>),
                        token.clone(),
                    );
                    let mut resp = Response::new(Body::from_stream(body_stream));
                    *resp.status_mut() = StatusCode::OK;
                    resp.headers_mut().extend(resp_headers);
                    return resp;
                }

                // Legacy fall-through with the decision already made: the
                // pipeline still runs (skill block + web gate) but emits
                // NO frames — TS passes `stage: () => {}` here. The gate's
                // outputs feed the tail's header pair (Rule 2.3).
                web_outcome = pipeline::run_turn_pipeline(
                    p,
                    &env,
                    used_skill.as_deref(),
                    idx,
                    has_refs,
                    &full_text,
                    &history,
                    &state,
                    &token,
                    None,
                    &model,
                    &span,
                )
                .await;
            }
        }
    }

    // (6) common tail.
    if let Some(p) = payload.as_mut() {
        if let Some(messages) = p.get_mut("messages").and_then(Value::as_array_mut) {
            attach::strip_attachment_refs(messages);
        }
    }
    let body = match payload.as_ref() {
        // JSON.stringify(payload) — Map order preserved end-to-end.
        Some(p) => serde_json::to_vec(p).unwrap_or_else(|_| raw_bytes.clone()),
        None => raw_bytes.clone(), // "Not JSON: forward as-is"
    };
    // TS's call: `forwardStream(..., webCitationMap, webCitationMap ? searchGateMeta : null)`
    // — the gate header ONLY rides when the citations map is non-null
    // (even an EMPTY map counts as non-null for this pairing).
    let search_gate_hdr = if web_outcome.web_citations.is_some() {
        web_outcome.search_gate.as_ref()
    } else {
        None
    };
    forward::forward_legacy(
        &state,
        body,
        used_skill.as_deref(),
        decision_mode.as_str(),
        web_outcome.web_citations.as_ref(),
        search_gate_hdr,
        &model,
        &span,
        token,
    )
    .await
}

/// Chunked read with a hard cap. `frame.into_data()` discards trailers,
/// which the TS text() read effectively does too.
pub(crate) async fn read_capped(mut body: Body, limit: usize) -> Option<Vec<u8>> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.ok()?;
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > limit {
                return None;
            }
            buf.extend_from_slice(&data);
        }
    }
    Some(buf)
}
