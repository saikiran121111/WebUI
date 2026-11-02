//! web_loop.rs — P2 model-facing web research loop
//! (⇔ TS `lib/chat/web-tool-loop.ts`). When the search gate produced an
//! evidence bundle for the turn (`run_turn_pipeline` returns a `web_depth`)
//! AND the client is NOT already driving the payload with its own `tools`
//! passthrough, `pump_progress` streams the turn through HERE instead of
//! the plain `forward::forward_into`.
//!
//! The shape mirrors the browser tool loop (`browser_loop.rs`) — this twin
//! is read-only research:
//! - the model gets [`webtools::model_tools`] in `payload["tools"]` plus one
//!   [`webtools::WEB_TOOL_GUIDANCE`] system block, injected in the same slot
//!   the skill block uses (before the last user turn);
//! - upstream SSE is think-scrubbed and forwarded verbatim EXCEPT the
//!   round's `data: [DONE]` is swallowed when that round ended in
//!   `finish_reason: "tool_calls"` — each round is a fresh upstream request
//!   and only the FINAL round's `[DONE]` may reach the client (the frozen
//!   single-`[DONE]` SSE grammar stays intact). This reuses the browser
//!   loop's [`ToolStreamRelay`] and [`tool_content`] verbatim
//!   (`pub(crate)` visibility instead of a second copy);
//! - the busy inference slot is taken for the WHOLE loop (Rule 5 — the
//!   rounds are sequential so no second request ever competes);
//! - tool results are the envelope JSON from `ruke-websearch::tools`
//!   (structured failures, budget accounting, [S#] numbering). Citations
//!   the tools mint are merged into the [S#] map and re-emitted as a
//!   `web_meta` stage frame: the client OVERWRITES the citation map on
//!   every web_meta, so updates must travel downstream or new sources dangle;
//! - budget: the gate's depth picks the round budget
//!   ([`webtools::budget_for_depth`]); DOCUMENTED DEVIATION from the browser
//!   loop at the round cap — the browser loop just ends, the web loop buys
//!   ONE final no-tools round with [`webtools::WEB_TOOL_FINAL_DIRECTIVE`]
//!   appended so the model always answers from the evidence it gathered. If
//!   the model calls tools AGAIN on that final round the relay has already
//!   swallowed the round's `[DONE]`, so a synthetic terminal frame restores
//!   the grammar (still exactly one `[DONE]` per stream).

use std::time::Instant;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tracing::Span;

use ruke_contracts::stages::{CitationMap, ResearchMeta, StageEvent};
use ruke_skills::lazy::inject_system_before;
use ruke_websearch::extractor::Extractor;
use ruke_websearch::tools as webtools;
use ruke_websearch::types::Depth;

use crate::chat::browser_loop::{tool_content, ToolStreamRelay};
use crate::chat::{error, scrubber::ThinkScrubber, sse::ProgressChannel};
use crate::AppState;

/// Outcome of the whole loop, deciding how the channel closes at the end
/// (same three-way as `browser_loop.rs`).
enum Outcome {
    Finished,
    Aborted,
    Failed(String),
}

/// Result of one upstream round: either an assembled relay to inspect, or
/// an outcome that ends the loop (the channel was already failed/closed by
/// `stream_round`).
enum Round {
    Relay(ToolStreamRelay),
    Done(Outcome),
}

/// One upstream request/response round: serialize `payload`, stream the
/// scrubbed bytes through a fresh relay, forward complete frames to `ch`.
/// The request/stream block is the browser loop's verbatim (same error
/// contract via `error::*`); factored into a helper here because the web
/// loop runs it both for normal rounds and for the forced final round.
async fn stream_round(
    state: &AppState,
    payload: &Value,
    url: &str,
    span: &Span,
    token: &CancellationToken,
    ch: &mut ProgressChannel,
) -> Round {
    let body = match serde_json::to_vec(payload) {
        Ok(b) => b,
        Err(e) => {
            tracing::error!(parent: span, "web turn payload re-serialize failed: {e}");
            return Round::Done(Outcome::Failed("Generation failed".to_string()));
        }
    };
    let headers = match error::upstream_headers(&state.settings.llm_api_key()) {
        Some(h) => h,
        None => {
            tracing::error!(parent: span, "llm server unreachable");
            return Round::Done(Outcome::Failed(error::unreachable_message(url)));
        }
    };

    let sent = tokio::select! {
        biased;
        _ = token.cancelled() => None,
        r = state.http.post(url).headers(headers).body(body).send() => Some(r),
    };
    let mut upstream = match sent {
        None => return Round::Done(Outcome::Aborted),
        Some(Ok(u)) => u,
        Some(Err(_)) => {
            tracing::error!(parent: span, "llm server unreachable");
            return Round::Done(Outcome::Failed(error::unreachable_message(url)));
        }
    };
    let status = upstream.status();
    if !status.is_success() {
        let err_text = upstream.text().await.unwrap_or_default();
        tracing::error!(parent: span, status = status.as_u16(), "web round upstream error");
        return Round::Done(Outcome::Failed(error::upstream_error_message(
            status.as_u16(),
            &err_text,
        )));
    }
    if matches!(status.as_u16(), 204 | 205 | 304) {
        tracing::error!(parent: span, "web round upstream returned no body");
        return Round::Done(Outcome::Failed("No response body from model".to_string()));
    }

    // Stream the round: scrubbed bytes pass through the relay so the
    // model's text answer streams verbatim while tool calls are assembled
    // out-of-band.
    let mut scrubber = ThinkScrubber::default();
    let mut relay = ToolStreamRelay::new();
    let mut aborted = false;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = token.cancelled() => { aborted = true; break; }
            c = upstream.chunk() => c,
        };
        match chunk {
            Ok(Some(bytes)) => {
                let out = scrubber.feed(&bytes);
                if !out.is_empty() {
                    for piece in relay.feed(&out) {
                        ch.raw(piece).await;
                    }
                    if ch.is_closed() {
                        token.cancel();
                        aborted = true;
                        break;
                    }
                }
            }
            Ok(None) => break,
            Err(_) => {
                tracing::error!(parent: span, "web round stream chunk error");
                return Round::Done(Outcome::Failed(error::unreachable_message(url)));
            }
        }
    }
    if aborted {
        return Round::Done(Outcome::Aborted);
    }
    let tail = scrubber.finish();
    if !tail.is_empty() {
        for piece in relay.feed(&tail) {
            ch.raw(piece).await;
        }
    }
    if let Some(frame) = relay.finish(&[]) {
        ch.raw(frame).await;
    }
    if ch.is_closed() {
        token.cancel();
        return Round::Done(Outcome::Aborted);
    }
    Round::Relay(relay)
}

/// Run the model-facing web research turn. Owns the busy-slot claim for
/// the whole loop and closes/fails the channel exactly once — the pump
/// never calls `forward::forward_into` after this returns.
#[allow(clippy::too_many_arguments)]
pub async fn run_web_tool_loop(
    state: &AppState,
    mut payload: Value,
    last_user_idx: usize,
    model: &str,
    depth: Depth,
    mut merged: CitationMap,
    search_gate: Option<ResearchMeta>,
    // P5 (§57 ⇔ TS WebToolLoopOptions.presentation/richResults): the turn's
    // plan + validated surfaces, re-carried verbatim on every updated
    // web_meta frame so the OVERWRITE law never drops them. The loop mints
    // no new surfaces — no `web:surface_*` frames here (parity with TS).
    presentation: Option<Value>,
    rich_results: Vec<Value>,
    question: &str,
    // Task-scope audit (brief #1/#6): the turn's server-owned contract,
    // folded from the conversation prompts upstream (⇔ TS web-tool-loop.ts
    // `opts.scope`). The session carries it; model tool arguments can only
    // ever NARROW it (targets resolving against real SERP evidence).
    scope: Option<ruke_websearch::task_scope::TaskScope>,
    span: &Span,
    token: &CancellationToken,
    ch: &mut ProgressChannel,
) {
    // Slot for the WHOLE loop: taken before the first request, dropped
    // exactly once when this function returns (Rule 5).
    let _guard = state.slot.clone().begin_guard();

    // Citation seed: continue the pipeline's [S#] numbering. Keys such as
    // "yt" carry no number and never collide with session numbering.
    let mut seed = 0usize;
    for key in merged.keys() {
        if let Some(rest) = key.strip_prefix('S') {
            if let Ok(n) = rest.parse::<usize>() {
                seed = seed.max(n);
            }
        }
    }
    let mut session = webtools::make_web_tool_session(depth, seed + 1, question, scope);
    // The production Extractor construction (⇔ ruke-websearch pipeline's
    // run_web_research): the same shared net/cache/verticals/bridge.
    let extractor = Extractor {
        net: &state.web.net,
        cache: state.web.cache.as_ref(),
        verticals: &state.web.verticals,
        bridge: state.web.bridge.as_ref(),
    };

    // Guidance block + tool surface (same slot as the skill block).
    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        inject_system_before(
            messages,
            last_user_idx,
            webtools::WEB_TOOL_GUIDANCE.to_string(),
        );
    }
    payload["tools"] = webtools::model_tools();

    tracing::info!(
        parent: span,
        model,
        depth = ?depth,
        session = session.search_session_id.as_str(),
        "web tool loop start"
    );

    let url = state.settings.llm_api_url();
    let started = Instant::now();
    let max_rounds = session
        .budget
        .max_tool_rounds
        .min(webtools::WEB_TOOL_MAX_ROUNDS_CAP);
    let outcome = 'outer: {
        for round in 0..max_rounds {
            if token.is_cancelled() {
                break 'outer Outcome::Aborted;
            }
            let relay = match stream_round(state, &payload, &url, span, token, ch).await {
                Round::Done(o) => break 'outer o,
                Round::Relay(r) => r,
            };

            if relay.finish.as_deref() != Some("tool_calls") || relay.calls.is_empty() {
                tracing::info!(
                    parent: span,
                    round = round + 1,
                    finish = relay.finish.as_deref().unwrap_or("none"),
                    ms = started.elapsed().as_millis() as u64,
                    "web tool loop complete"
                );
                break 'outer Outcome::Finished;
            }

            // ── assistant turn + tool execution (⇔ browser_loop.rs shapes)
            let messages = payload
                .get_mut("messages")
                .and_then(Value::as_array_mut)
                .expect("messages array present (tool loop only runs with it)");
            let calls: Vec<(String, String, String)> = relay
                .calls
                .values()
                .map(|c| (c.id.clone(), c.name.clone(), c.arguments.clone()))
                .collect();
            let tool_calls_json: Vec<Value> = calls
                .iter()
                .map(|(id, name, arguments)| {
                    json!({"id": id, "type": "function", "function": {"name": name, "arguments": arguments}})
                })
                .collect();
            messages.push(json!({
                "role": "assistant",
                "content": if relay.content.is_empty() { Value::Null } else { json!(relay.content) },
                "tool_calls": tool_calls_json
            }));
            // One round consumed per model tool round — the executors never
            // touch this counter.
            session.rounds_used += 1;

            let census: Vec<String> = calls.iter().map(|c| c.1.clone()).collect();
            let mut ev = StageEvent::new("web:tools");
            ev.detail = Some(census.join(","));
            ev.done = Some(session.rounds_used as u64);
            ev.total = Some(max_rounds as u64);
            ch.stage(&ev).await;
            tracing::info!(
                parent: span,
                round = round + 1,
                calls = %census.join(","),
                "web round tool calls"
            );

            let mut added = 0usize;
            for (id, name, arguments) in calls {
                if token.is_cancelled() {
                    break 'outer Outcome::Aborted;
                }
                let args: Value = match serde_json::from_str(&arguments) {
                    Ok(Value::Object(m)) => Value::Object(m),
                    _ => {
                        messages.push(
                            json!({"role": "tool", "tool_call_id": id, "content": tool_content(
                                json!({
                                    "ok": false,
                                    "tool": name,
                                    "error": "invalid_arguments",
                                    "detail": "tool arguments are not a JSON object",
                                    "remainingBudget": webtools::remaining_budget(&session),
                                })
                            )}),
                        );
                        continue;
                    }
                };
                let mut fresh: Vec<webtools::CitationSeed> = Vec::new();
                let result = match name.as_str() {
                    "web_search" => {
                        webtools::exec_web_search(&extractor, &mut session, &args, &mut fresh).await
                    }
                    "read_page" => {
                        webtools::exec_read_page(&extractor, &mut session, &args, &mut fresh).await
                    }
                    _ => json!({
                        "ok": false,
                        "tool": name,
                        "error": "unknown_tool",
                        "detail": "only web_search and read_page are available in this turn",
                        "remainingBudget": webtools::remaining_budget(&session),
                    }),
                };
                let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
                tracing::info!(
                    parent: span,
                    round = round + 1,
                    tool = name.as_str(),
                    ok,
                    args = %arguments.chars().take(200).collect::<String>(),
                    "web tool result"
                );
                // Merge the [S#] citations these calls minted. Tools number
                // packets from the session, so keys never collide with the
                // pipeline's map.
                for c in fresh {
                    let mut obj = serde_json::Map::new();
                    obj.insert("sourceId".to_string(), json!(c.source_id));
                    obj.insert("url".to_string(), json!(c.url));
                    obj.insert("title".to_string(), json!(c.title));
                    obj.insert("domain".to_string(), json!(c.domain));
                    if let Some(p) = &c.published_at {
                        obj.insert("publishedAt".to_string(), json!(p));
                    }
                    if !merged.contains_key(&c.source_id) {
                        added += 1;
                    }
                    merged.insert(c.source_id.clone(), Value::Object(obj));
                }
                messages.push(
                    json!({"role": "tool", "tool_call_id": id, "content": tool_content(result)}),
                );
            }

            if added > 0 {
                // OVERWRITE law (hooks/useChat): a later web_meta REPLACES
                // the citation map — re-emit the merged map so every new
                // [S#] is clickable the moment the model cites it.
                let mut ev = StageEvent::new("web_meta");
                ev.web_citations = Some(merged.clone());
                ev.search_gate = search_gate.clone();
                // P5: the OVERWRITE law demands the FULL set each time —
                // plan and surfaces ride along (empty set serializes absent
                // ⇔ the TS length>0 gate).
                ev.presentation = presentation.clone();
                if !rich_results.is_empty() {
                    ev.rich_results = Some(rich_results.clone());
                }
                ch.stage(&ev).await;
            }
            // Next round re-serializes `payload` with the extended
            // messages; the same tool array stays injected.
        }

        // DOCUMENTED DEVIATION from browser_loop.rs (which just ends at its
        // cap): the web loop buys ONE final no-tools round so the model
        // always answers from the evidence it gathered.
        tracing::warn!(
            parent: span,
            rounds = max_rounds,
            session = session.search_session_id.as_str(),
            "web tool loop hit the round cap; forcing the no-tools final round"
        );
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("tools");
        }
        if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
            messages.push(json!({"role": "system", "content": webtools::WEB_TOOL_FINAL_DIRECTIVE}));
        }
        if token.is_cancelled() {
            break 'outer Outcome::Aborted;
        }
        match stream_round(state, &payload, &url, span, token, ch).await {
            Round::Done(o) => break 'outer o,
            Round::Relay(r) => {
                if r.finish.as_deref() == Some("tool_calls") {
                    // The relay swallowed this round's [DONE] (the model
                    // called tools again, which we never execute). The
                    // grammar still carries exactly one [DONE] for the
                    // whole stream: restore the terminal frame.
                    ch.raw(b"data: [DONE]\n\n".to_vec()).await;
                }
                tracing::info!(
                    parent: span,
                    ms = started.elapsed().as_millis() as u64,
                    "web tool loop final round complete"
                );
                Outcome::Finished
            }
        }
    };

    match outcome {
        Outcome::Finished | Outcome::Aborted => ch.close(),
        Outcome::Failed(msg) => ch.fail(&msg).await,
    }
    // `_guard` drops here: exactly once.
}
