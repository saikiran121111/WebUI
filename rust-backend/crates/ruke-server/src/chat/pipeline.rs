//! `runTurnPipeline` (route.ts:406) and the progress-path pump
//! orchestration (the body of the ReadableStream `start()` at route.ts:691).
//!
//! PART-4 SCOPE — honest subset. The TS pipeline is
//! `decision skill block → attachment retrieval → web-research gate`; this
//! port implements the skill-block step now and leaves EXACT insertion
//! seams for the other two (Parts 5/6), because emitting their success
//! frames from an unimplemented feature is forbidden ("do not fake success
//! events for pipeline stages that do not exist yet"). The golden corpus
//! was recorded with `WEB_SEARCH_GATE_DISABLED=1` and attachment turns
//! carry no replay fixture, so the Part-4 frame set
//! (`decision_done` [+ `skill`]) is byte-identical to what was recorded:
//!
//! PART-5 SEAM (after the skill block, before the web-gate seam):
//!   if the last user turn has `attachment_ref` parts (see
//!   `attach::turn_has_attachment_ref`), emit `{"stage":"retrieval"}`
//!   before and `{"stage":"retrieval_done","done":n,"total":n}` after
//!   injecting evidence, and take a `turn.child()` token for the retrieval
//!   subtree. The Rust attachment index does not exist yet; Part 5 adds
//!   the feature and its frames together.
//!
//! PART-6 SEAM (after Part 5, before `strip_attachment_refs`):
//!   the web-research gate (frames `web:gate`/`web:source`/`web:search`,
//!   the `web_meta` frame below, `X-Web-Citations`/`X-Search-Gate` headers
//!   on the legacy path, and its own child token). `PipelineOutcome`'s two
//!   fields are the wiring points; they stay `None` here.

use std::path::Path;
use std::time::Instant;

use serde_json::Value;
use tracing::Span;

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
    root: &Path,
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
        if let Some(block) = build_decision_skill_block(env, root) {
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

    // ---- PART-5 SEAM: attachment evidence retrieval (see module docs) ----
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
#[allow(clippy::too_many_arguments)]
pub async fn pump_progress(
    state: AppState,
    mut payload: Value,
    env: DecisionEnvelope,
    decision_ms: u64,
    used_skill: Option<String>,
    model: String,
    last_user_idx: usize,
    span: Span,
    token: tokio_util::sync::CancellationToken,
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
        &state.root,
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
