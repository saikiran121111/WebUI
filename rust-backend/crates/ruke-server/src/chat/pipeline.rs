//! `runTurnPipeline` (route.ts:406) and the progress-path pump
//! orchestration (the body of the ReadableStream `start()` at route.ts:691).
//!
//! PIPELINE ORDER (route.ts): `decision skill block → attachment
//! retrieval → (research availability) → strip → upstream`. Part 5 replaced
//! the retrieval seam with the real step (step 5 below); Part 6 owns the
//! web-gate seam. Part 4 shipped WITHOUT the retrieval frames because the
//! feature did not exist yet ("do not fake success events for pipeline
//! stages that do not exist yet") — the golden corpus was recorded with
//! `WEB_SEARCH_GATE_DISABLED=1` and its chat replays carry no attachment
//! refs, so the Part-4 goldens (`decision_done` [+ `skill`]) stay
//! byte-identical when rerun.
//!
//! PART-5 (implemented): `{"stage":"retrieval"}` opens the pair only
//!   when the last user turn has `attachment_ref` parts — TS computes
//!   `hasAttachmentRefs` in the HANDLER, before the pipeline mutates the
//!   payload. `buildAttachmentTurn` then runs UNCONDITIONALLY with the
//!   handler-computed `lastUserIdx + 1` injection index: with a skill
//!   block inserted above it points after the shifted turn (correct),
//!   without one it is off by one (the recorded quirk — fixture 05 pins
//!   the interaction; REPRODUCED, not fixed). `{"stage":"retrieval_done",
//!   "done":n,"total":n}` closes the pair — honest `0/0` on failure
//!   (log + continue; retrieval NEVER emits `ruke_error`). TS threads
//!   its single combined signal through retrieval, so the Rust side
//!   passes the turn's token unchanged — no child token.
//!
//! RESEARCH AVAILABILITY (repair 2026-11-05, brief §2/§4): the pre-turn
//!   web-research gate is RETIRED for chat turns — the mandatory
//!   gate/prefetch loopback call is gone (it was an auxiliary model call
//!   ahead of the answering model, and tool availability was a mere
//!   by-product of its depth verdict). Step 6 only decides AVAILABILITY:
//!   the model-facing web tool loop (`chat/web_loop.rs` ⇔ TS
//!   `lib/chat/web-tool-loop.ts`) arms on every turn unless an explicit
//!   exclusion fires — `WEB_SEARCH_GATE_DISABLED` (the kill switch), an
//!   OPERATE browser turn (the browser loop owns that turn's tools), or
//!   the Next bridge being unconfigured (honest degradation: no web tools,
//!   never a Rust-side fallback — the rollback law). `web_depth` carries
//!   the verdict as the FIXED "standard" depth; the model itself decides
//!   whether the tools ever fire. No slot claim, no research bridge call,
//!   and no evidence injection happens in this function anymore. The
//!   research bridge (`next_search::research`) is no longer called from
//!   chat; the web-tools RPC (`next_search::TOOLS_PATH`) stays the only
//!   bridge use in the turn.

use std::time::Instant;

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tracing::Span;

use ruke_attach::{build_attachment_turn, collect_attachment_refs, Cancelled, NotesLlm};
use ruke_contracts::decision::DecisionEnvelope;
use ruke_contracts::stages::{CitationMap, ResearchMeta, StageEvent};
use ruke_decision::skill_block::build_decision_skill_block;
use ruke_skills::jsstr::js_slice_head;
use ruke_skills::lazy::inject_system_before;

use crate::chat::{attach, clock, forward, sse::ProgressChannel};
use crate::AppState;

/// Post-repair (2026-11-05): the chat pipeline PREFETCHES NOTHING, so
/// `web_citations`/`search_gate`/`presentation`/`rich_results` stay `None`
/// on every chat path — they remain only because the legacy non-streaming
/// tail still threads the (now always-absent) Rule 2.3 header pair, ⇔ the
/// TS route where `webCitationMap`/`searchGateMeta` are null.
/// `web_depth` is the availability VERDICT that arms the web tool loop in
/// `pump_progress`.
#[derive(Debug, Default)]
pub struct PipelineOutcome {
    pub web_citations: Option<CitationMap>,
    pub search_gate: Option<ResearchMeta>,
    /// Some ⇒ arm the model-facing web tool loop (`chat/web_loop.rs` ⇔ TS
    /// web-tool-loop). Repair (brief §4): the gate is gone — the value is
    /// the FIXED research depth ("standard"), not a classifier verdict.
    pub web_depth: Option<String>,
    /// P5 (Addendum §55/§57 ⇔ TS runTurnPipeline's `presentation`/
    /// `richResults`): the turn's plan + validated surfaces as wire Values.
    /// `rich_results` is only `Some` when NON-empty ⇔ the TS
    /// `length > 0 ? rr : null` gate; `Value` passthrough mirrors the
    /// StageEvent ledger (flat named-type references).
    pub presentation: Option<Value>,
    pub rich_results: Option<Vec<Value>>,
    /// Task-scope audit (brief #1/#6): the ONE per-turn folded contract the
    /// gate ctx was built with — carried to the web tool loop so gate and
    /// session share one scope (⇔ TS route.ts feeding both).
    pub turn_scope: Option<crate::task_scope::TaskScope>,
}

/// Mirror of `runTurnPipeline`'s Part-4-visible steps. `ch` is the progress
/// channel (`None` on the legacy path, where TS passes `stage: () => {}`).
#[allow(clippy::too_many_arguments)] // mirrors the oracle's runTurnPipeline arity
pub async fn run_turn_pipeline(
    payload: &mut Value,
    env: &DecisionEnvelope,
    used_skill: Option<&str>,
    last_user_idx: usize,
    has_attachment_refs: bool,
    question: &str,
    history: &[Value],
    state: &AppState,
    token: &CancellationToken,
    mut ch: Option<&mut ProgressChannel>,
    model: &str,
    // P1 clock grounding: the client's IANA zone captured (and stripped
    // from the payload) by the handler — ⇔ TS `opts.turnTimezone`.
    turn_timezone: Option<&str>,
    // Task-scope audit (brief #2/#3): true when the request carried the
    // `browser_session` marker (conversation identity — sent on EVERY
    // chat send, panel visibility irrelevant). Marker + an OPERATE fold
    // makes this a browser turn, and the general research gate is then
    // SKIPPED: the browser turn resolves its destination itself
    // (browser_loop bounded discovery), never behind a blind fan-out.
    browser_marker: bool,
    span: &Span,
) -> PipelineOutcome {
    let mut outcome = PipelineOutcome::default();

    // Brief §5: exactly ONE request instant ⇔ TS `turnInstant` inside
    // prepareTurn — the research bridge's `currentDate` (the gate's date)
    // and the step-7 `<runtime_clock>` block both derive from this same
    // instant, so the gate and the model can never reason against
    // different calendar dates (UTC vs session zone).
    let turn_now = chrono::Utc::now();

    // Step 4 (route.ts:461): exactly ONE skill block reaches the model.
    // A slash-routed user skill already injected its block (in
    // `apply_slash_skill_routing`); the decision-engine block fills in only
    // when no user skill is in play. The block goes BEFORE the last user
    // turn — never after — so the model's next completion is the answer.
    let skill_started = Instant::now();
    let mut skill_block_bytes = 0usize;
    if used_skill.is_none() {
        if let Some(block) = build_decision_skill_block(env, &state.root) {
            if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
                inject_system_before(messages, last_user_idx, block.clone());
                // JS `block.length` counts UTF-16 code units.
                skill_block_bytes = block.encode_utf16().count();
            }
        }
    }
    if used_skill.is_some() || skill_block_bytes > 0 {
        let mut e = StageEvent::new("skill");
        e.detail = used_skill.map(str::to_string); // TS `detail: usedSkill ?? undefined`
        e.ms = Some(skill_started.elapsed().as_millis() as u64);
        if let Some(ch) = ch.as_mut() {
            ch.stage(&e).await;
        }
    }

    // ---- 5) attachment knowledge retrieval — EPHEMERAL (route.ts:443) ----
    // Evidence lands ONLY in this request's payload copy; the user's
    // stored conversation never sees it (persistence reads the original,
    // not this mutated copy — the handler holds the sole owner). The
    // injection index is the handler-computed `lastUserIdx + 1` passed
    // UNCONDITIONALLY: correct when the skill block above shifted the
    // turn, off by one when it did not. Recorded TS behavior, reproduced
    // (module docs). `buildAttachmentTurn` is called even with NO refs
    // exactly like the TS oracle — it fast-returns 0 there.
    let att_ids: Vec<String> = payload
        .get("messages")
        .and_then(Value::as_array)
        .map(|m| {
            collect_attachment_refs(m)
                .into_iter()
                .map(|r| r.att_id)
                .collect()
        })
        .unwrap_or_default();
    if has_attachment_refs {
        if let Some(ch) = ch.as_mut() {
            ch.stage(&StageEvent::new("retrieval")).await;
        }
    }
    let retrieval_started = Instant::now();
    let retrieval: Result<usize, Cancelled> =
        match payload.get_mut("messages").and_then(Value::as_array_mut) {
            Some(messages) => {
                let llm = NotesLlm {
                    url: state.settings.llm_api_url(),
                    key: state.settings.llm_api_key(),
                };
                build_attachment_turn(
                    messages,
                    last_user_idx + 1,
                    question,
                    &state.root,
                    state.attach_embedder.as_ref(),
                    &state.http,
                    &llm,
                    token,
                )
                .await
            }
            None => Ok(0),
        };
    match retrieval {
        Ok(blocks) => {
            if blocks > 0 {
                // §25: ref count + att ids only — never document
                // contents (Rule 17).
                tracing::info!(
                    parent: span,
                    refs = att_ids.len() as u64,
                    atts = %att_ids.join(","),
                    blocks = blocks as u64,
                    ms = retrieval_started.elapsed().as_millis() as u64,
                    "attachment evidence injected (this turn only)"
                );
            }
            if has_attachment_refs {
                let mut e = StageEvent::new("retrieval_done");
                e.done = Some(blocks as u64);
                e.total = Some(blocks as u64);
                if let Some(ch) = ch.as_mut() {
                    ch.stage(&e).await;
                }
            }
        }
        Err(Cancelled) => {
            // TS catch arm (route.ts:455): the ONLY throw is AbortError
            // (client walk-off). Log the category, emit the honest zero
            // frame, and CONTINUE into generation exactly like TS — the
            // forwarder itself dies on the same token downstream.
            tracing::error!(
                parent: span,
                category = "cancelled",
                refs = att_ids.len() as u64,
                atts = %att_ids.join(","),
                ms = retrieval_started.elapsed().as_millis() as u64,
                "attachment retrieval failed"
            );
            if has_attachment_refs {
                let mut e = StageEvent::new("retrieval_done");
                e.done = Some(0);
                e.total = Some(0);
                if let Some(ch) = ch.as_mut() {
                    ch.stage(&e).await;
                }
            }
        }
    }

    // Task-scope audit (brief #1/#6): ONE fold per turn over the
    // conversation's USER turns plus the current question, shared by the
    // gate ctx AND the web tool loop (⇔ TS route.ts: a single
    // foldTaskScope feeds both runTurnPipeline and runWebToolLoop). The
    // fold is deterministic, so hoisting it out of the gate block changes
    // no bytes — it just makes the ONE-contract-per-turn law structural.
    let scope_prompts: Vec<String> = history
        .iter()
        .filter(|h| h.get("role").and_then(Value::as_str) == Some("user"))
        .filter_map(|h| h.get("content").and_then(Value::as_str))
        .map(str::to_string)
        .chain(std::iter::once(question.to_string()))
        .collect();
    let turn_scope = crate::task_scope::fold_task_scope(&scope_prompts);
    outcome.turn_scope = Some(turn_scope.clone());

    // Task-scope audit (brief #2/#3) ordering law: the browser marker
    // (conversation identity) COMBINED with an OPERATE fold makes this a
    // browser turn — and for a browser turn the general research fan-out
    // is SKIPPED entirely. An operational turn must resolve its
    // destination through bounded discovery inside the browser loop,
    // never by paying for a blind web-research pass against an unknown
    // site first. Marker turns with any other intent keep the research
    // path (with the scope enforced through the gate ctx); panel
    // visibility plays no part anywhere in this law.
    let browser_turn = browser_marker && crate::task_scope::routes_to_browser_turn(&turn_scope);

    // ---- 6) research availability (repair 2026-11-05, brief §2/§4) ----
    // THE MODEL DECIDES: no gate, no prefetched bundle, and no auxiliary
    // model call ahead of the answering model. The model-facing web tool
    // loop arms on EVERY turn — at the fixed "standard" research depth —
    // unless one of the explicit exclusion laws fires:
    //   • WEB_SEARCH_GATE_DISABLED — the deployment kill switch (⇔ TS
    //     `gateDisabledByEnv()`; the only surviving non-model verdict);
    //   • an OPERATE browser turn — the browser loop owns that turn's tool
    //     surface (task-scope ordering law, brief #2);
    //   • the Next bridge is not configured — honest degradation: there is
    //     no Rust-side research engine (rollback law), so the turn runs as
    //     a plain forward and the warn below is the whole story.
    // No slot is claimed here: this step touches no inference and no
    // network — the web tool loop claims its own slot when it runs.
    let research_enabled = !browser_turn && !gate_disabled_by_env() && state.next_search.is_some();
    if browser_turn {
        tracing::info!(
            parent: span,
            prompt = %js_slice_head(question, 60),
            "general web tools skipped: operational task scope — the browser turn owns the site-bound work"
        );
    } else if gate_disabled_by_env() {
        tracing::info!(
            parent: span,
            prompt = %js_slice_head(question, 60),
            "web research disabled (WEB_SEARCH_GATE_DISABLED) — no web tools this turn"
        );
    } else if state.next_search.is_none() {
        tracing::warn!(
            parent: span,
            prompt = %js_slice_head(question, 60),
            "web tool bridge not configured: the turn proceeds without web tools"
        );
    }
    // The arm decision in `pump_progress` reads `web_depth`: Some arms the
    // web tool loop. The depth is FIXED ("standard") — no classifier picks
    // quick/deep; the model itself decides whether the tools ever fire.
    outcome.web_depth = research_enabled.then(|| "standard".to_string());

    // Step 7 (route.ts step 7): P1 clock grounding — always on for every
    // model-visible turn (the compaction passthrough never runs this
    // function). Injected LAST among the system blocks so the
    // <runtime_clock> block sits immediately before the user turn.
    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        let block = clock::build_clock_block(turn_timezone, turn_now);
        inject_system_before(messages, last_user_idx + 1, block);
    }

    tracing::info!(
        parent: span,
        mode = env.active_mode.as_str(),
        by = env.decided_by.as_str(),
        skill = used_skill.unwrap_or(""),
        skill_bytes = skill_block_bytes as u64,
        model,
        "turn decision"
    );
    outcome
}

/// The progress path's whole-turn pump: the body of `start()` plus the
/// `cancel()` wiring effect (client disconnect ⇒ `inner.abort()` ⇔ the
/// cancellation token firing, owned by `AbortOnDrop` in the handler).
/// `has_attachment_refs` and `question` (the last user turn's extracted
/// text ⇔ TS `fullText`) are the handler's pre-mutation snapshot — TS
/// computes `hasAttachmentRefs` before the pipeline touches the payload.
#[allow(clippy::too_many_arguments)]
pub async fn pump_progress(
    state: AppState,
    mut payload: Value,
    env: DecisionEnvelope,
    decision_ms: u64,
    used_skill: Option<String>,
    model: String,
    last_user_idx: usize,
    has_attachment_refs: bool,
    question: String,
    history: Vec<Value>,
    span: Span,
    token: CancellationToken,
    // Some((conversation, turn)) whenever the client sent the
    // `browser_session` marker (conversation identity — presence alone
    // does NOT route; task-scope audit brief #2). The browser tool loop
    // runs only when the folded turn scope ALSO derives an OPERATE
    // intent; every other marker turn takes the research/plain path.
    // (handler computes this before stripping the marker).
    browser: Option<(String, String)>,
    // P1 clock grounding: handler-captured IANA zone (already stripped
    // from the payload there) — threaded to the pipeline like `browser`.
    turn_timezone: Option<String>,
    mut ch: ProgressChannel,
) {
    let decision_mode = env.active_mode.as_str();

    // First frame: the routing wait the client has been measuring since
    // send(), reported with its REAL elapsed ms.
    let mut ev = StageEvent::new("decision_done");
    ev.mode = Some(env.active_mode);
    ev.ms = Some(decision_ms);
    ch.stage(&ev).await;

    let used_for_stage = used_skill.clone();
    let mut outcome = run_turn_pipeline(
        &mut payload,
        &env,
        used_for_stage.as_deref(),
        last_user_idx,
        has_attachment_refs,
        &question,
        &history,
        &state,
        &token,
        Some(&mut ch),
        &model,
        turn_timezone.as_deref(),
        // Brief #2: the marker's mere PRESENCE feeds the ordering law
        // (identity halves of the routing conjunction; the routing
        // conjunction itself is re-checked at the arms below against the
        // fold — one fold, one truth).
        browser.is_some(),
        &span,
    )
    .await;

    // Repair (brief 2026-11-05): the pipeline prefetches NOTHING, so no
    // web_meta / surface frames are emitted here. web_meta now originates
    // INSIDE the web tool loop: journaled prior citations (from the TS
    // create RPC) ride before the first model byte, and the map OVERWRITES
    // itself after every retrieval round. ⇔ TS route.ts, which deleted its
    // own web_meta/surface block in the same repair.

    // Every attachment_ref must be gone before the payload leaves (route.ts
    // emits this inside start() on the progress path).
    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        attach::strip_attachment_refs(messages);
    }
    let body = serde_json::to_vec(&payload).unwrap_or_default();

    // TS wraps the rest of start() in try/catch ⇒ `ch.fail(err.message ||
    // "Generation failed")`. The Rust pipeline above has no throwing IO
    // (every fallible load already degrades to `None`/empty the way the TS
    // catch arms do), and `forward_into` performs its own `ch.fail` for
    // every upstream failure — so no synthetic frame is needed here.
    //
    // Browser-ROUTED turns (marker ∧ Operate scope) take the browser
    // tool-loop path with the SAME stripped payload.
    // Repair (brief §2/§4): the model-facing web tool loop (web_loop.rs ⇔
    // TS web-tool-loop.ts) arms on every OTHER turn that carries no
    // client-supplied `tools` — `web_depth` is the pipeline's FIXED
    // availability verdict, not a gate output. A browser-routed turn keeps
    // priority, and a client passthrough `tools` array is never
    // overwritten (client-provided schemas alone never authorize
    // execution — they only keep the Browser Panel passthrough intact).
    //
    // Brief #2: the routing conjunction completes HERE against the ONE
    // fold the pipeline already made — no second derivation anywhere.
    // The browser loop runs only when marker presence AND an Operate
    // scope agree; a marker turn with any other intent falls through to
    // the web tool loop like any other turn (the browser loop no longer
    // swallows research turns — brief #3), and panel visibility enters
    // nowhere in this law. `turn_scope` moves into whichever tool loop
    // runs.
    let turn_scope = outcome.turn_scope.take();
    let browser_take = browser.is_some()
        && turn_scope
            .as_ref()
            .is_some_and(crate::task_scope::routes_to_browser_turn);
    let web_tools = !browser_take && outcome.web_depth.is_some() && payload.get("tools").is_none();
    match browser {
        Some((session_id, turn_id)) if browser_take => {
            crate::chat::browser_loop::run_tool_loop(
                &state,
                payload,
                last_user_idx,
                &model,
                &span,
                &token,
                &mut ch,
                session_id,
                turn_id,
                turn_scope,
            )
            .await;
        }
        _ if web_tools => {
            let depth = outcome
                .web_depth
                .take()
                .expect("web_tools arm implies a depth");
            // Repair (brief §5): the loop starts with ZERO prefetched
            // evidence — no citation map, no gate meta, no surfaces. The
            // create RPC rehydrates this conversation's journaled prior
            // evidence and merges its citations into the loop's map.
            // Conversation identity ⇔ TS `opts.conversationId/currentDate`:
            // the marker's conversation half (absent marker ⇒ no
            // journaling) plus the session-zone date at the turn instant.
            let conversation = browser.as_ref().map(|b| {
                (
                    b.0.clone(),
                    clock::session_date_string(turn_timezone.as_deref(), chrono::Utc::now()),
                )
            });
            crate::chat::web_loop::run_web_tool_loop(
                &state,
                payload,
                last_user_idx,
                &model,
                depth,
                &question,
                // The SAME fold the pipeline hoisted — one contract per
                // turn (brief #6: failure and recovery paths never
                // re-widen it).
                turn_scope,
                conversation,
                &span,
                &token,
                &mut ch,
            )
            .await;
        }
        _ => {
            forward::forward_into(&state, body, decision_mode, &model, &span, &token, &mut ch)
                .await;
        }
    }
}

/* ── research kill-switch check ─────────────────────────────────────────── */

// Repair (brief 2026-11-05): the step-6 gate helpers retired with the
// gate itself — `resolveTurnIndex`, `turn_image_parts`, and
// `turn_has_inline_attachment` existed ONLY to feed the mandatory search
// gate's ctx (inline images/attachments as gate evidence). Chat turns
// have no gate anymore; the model decides research through the tool
// loop, and the tool executors do their own admission. Retrieval
// (step 5) keys on real attachment refs, not these flags, so nothing
// downstream needed them.

/// Test/CI escape hatch ⇔ the retired crate helper (TS owns the real
/// `gateDisabledByEnv`; this is the pre-bridge check with identical
/// semantics — `WEB_SEARCH_GATE_DISABLED`, with the legacy
/// `WEB_SEARCH_LFM_DISABLED` still working).
fn gate_disabled_by_env() -> bool {
    std::env::var("WEB_SEARCH_GATE_DISABLED").as_deref() == Ok("1")
        || std::env::var("WEB_SEARCH_LFM_DISABLED").as_deref() == Ok("1")
}

#[cfg(test)]
mod tests {
    // Repair (brief 2026-11-05): the gate-ctx tests (image parts,
    // inline-attachment flag, shifted-turn read) retired with the gate
    // helpers they pinned. Chat availability is a plain three-condition
    // verdict now; the live contract tests for the repaired arm live in
    // the TS suite (route-tool-availability + web-tool-loop vectors).

    use super::*;

    #[test]
    fn kill_switch_reads_both_env_names() {
        // The disable setting is an explicit deployment/user contract
        // (brief §2: retire the gate as a chat PREREQUISITE, keep the
        // kill switch honest). Both spellings must fire; anything else
        // must not.
        std::env::set_var("WEB_SEARCH_GATE_DISABLED", "0");
        std::env::remove_var("WEB_SEARCH_LFM_DISABLED");
        assert!(!gate_disabled_by_env());
        std::env::set_var("WEB_SEARCH_GATE_DISABLED", "1");
        assert!(gate_disabled_by_env());
        std::env::remove_var("WEB_SEARCH_GATE_DISABLED");
        std::env::set_var("WEB_SEARCH_LFM_DISABLED", "1");
        assert!(gate_disabled_by_env());
        std::env::remove_var("WEB_SEARCH_LFM_DISABLED");
        assert!(!gate_disabled_by_env());
    }

    // The citation-map / research_meta / stage-label parity tests retired
    // with the Rust search engine (2026-11-03 TS ownership rollback): the
    // values now arrive as TS wire JSON, so the TS suite owns those
    // shapes (web-tools-rpc + research-route vectors pin the grammar).
}
