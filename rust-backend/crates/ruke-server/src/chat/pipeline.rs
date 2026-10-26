//! `runTurnPipeline` (route.ts:406) and the progress-path pump
//! orchestration (the body of the ReadableStream `start()` at route.ts:691).
//!
//! PIPELINE ORDER (route.ts): `decision skill block → attachment
//! retrieval → (web-research gate) → strip → upstream`. Part 5 replaced
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
//! PART-6 SEAM (after Part 5, before `strip_attachment_refs`):
//!   the web-research gate (frames `web:gate`/`web:source`/`web:search`,
//!   the `web_meta` frame below, `X-Web-Citations`/`X-Search-Gate` headers
//!   on the legacy path, and its own child token). `PipelineOutcome`'s two
//!   fields are the wiring points; they stay `None` here.

use std::time::Instant;

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tracing::Span;

use ruke_attach::{build_attachment_turn, collect_attachment_refs, Cancelled, NotesLlm};
use ruke_contracts::decision::DecisionEnvelope;
use ruke_contracts::stages::{CitationMap, ResearchMeta, StageEvent};
use ruke_decision::skill_block::build_decision_skill_block;
use ruke_skills::lazy::inject_system_before;

use crate::chat::{attach, forward, sse::ProgressChannel};
use crate::AppState;

/// What the (future) web gate contributes: the `[S1]…[Sn]` citation map
/// and the gate summary. Part 4 always returns `None`s.
#[derive(Debug, Default)]
pub struct PipelineOutcome {
    pub web_citations: Option<CitationMap>,
    pub search_gate: Option<ResearchMeta>,
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
    state: &AppState,
    token: &CancellationToken,
    mut ch: Option<&mut ProgressChannel>,
    model: &str,
    span: &Span,
) -> PipelineOutcome {
    let outcome = PipelineOutcome::default();

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
        .map(|m| collect_attachment_refs(m).into_iter().map(|r| r.att_id).collect())
        .unwrap_or_default();
    if has_attachment_refs {
        if let Some(ch) = ch.as_mut() {
            ch.stage(&StageEvent::new("retrieval")).await;
        }
    }
    let retrieval_started = Instant::now();
    let retrieval: Result<usize, Cancelled> = match payload.get_mut("messages").and_then(Value::as_array_mut) {
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

    // ---- PART-6 SEAM: web-research gate (see module docs) ----

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
    span: Span,
    token: CancellationToken,
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
    run_turn_pipeline(
        &mut payload,
        &env,
        used_for_stage.as_deref(),
        last_user_idx,
        has_attachment_refs,
        &question,
        &state,
        &token,
        Some(&mut ch),
        &model,
        &span,
    )
    .await;

    // TS emits a `web_meta` frame when the gate produced citations. Part 4
    // implements no gate and the corpus was recorded with the gate
    // disabled, so citations are always None and NO frame is emitted —
    // exactly the recorded bytes. (Part 6 wires `outcome.web_citations`
    // into `web_meta_frame` here.)

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
    forward::forward_into(&state, body, decision_mode, &model, &span, &token, &mut ch).await;
}
