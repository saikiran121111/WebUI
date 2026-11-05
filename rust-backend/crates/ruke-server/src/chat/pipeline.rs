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
//! PART-8 (TS-ownership rollback, 2026-11-03): web research is TS-owned;
//!   this pipeline makes ONE authenticated loopback call to the Next-owned
//!   research service (`crate::chat::next_search`) between retrieval and
//!   the strip. No research runs in this crate — what remains here is only
//!   wire-only helper types (`task_scope`, `url_detector`) shared with the
//!   browser-loop contract — and there is NO dormant Rust fallback: an
//!   unwired bridge simply means no web evidence for the turn.
//!   `WEB_SEARCH_GATE_DISABLED=1` (or `WEB_SEARCH_LFM_DISABLED`)
//!   short-circuits the whole block with the verbatim TS log line and NO
//!   slot claim; otherwise the turn's slot is held across the loopback
//!   (`begin_guard`'s Drop ⇔ TS's `finally endUserTurn`), the bridge's
//!   NDJSON progress frames ride `web:<kebab-stage>` via
//!   `ProgressChannel::try_stage`, client abort drops the request mid-
//!   stream (⇔ TS threading the request signal), and a bundle injects
//!   `buildMainModelContext().systemBlock` at `lastUserIdx + 1` and fills
//!   `PipelineOutcome`'s fields — the legacy header pair (Rule 2.2) and
//!   the `web_meta` frame in `pump_progress` consume them. Bridge failures
//!   are log-and-continue (Rule 2.4): the turn proceeds without web
//!   evidence exactly like a failed TS gate.
//!   RECORDED QUIRK: `imageParts` indexes the RAW `lastUserIdx` AFTER the
//!   skill/retrieval injections — on injected turns that is a system
//!   message with no image parts; reproduced, not fixed.

use std::time::Instant;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tracing::Span;

use ruke_attach::{build_attachment_turn, collect_attachment_refs, Cancelled, NotesLlm};
use ruke_contracts::decision::DecisionEnvelope;
use ruke_contracts::stages::{CitationMap, GateQuery, ResearchMeta, StageEvent};
use ruke_decision::skill_block::build_decision_skill_block;
use ruke_skills::jsstr::js_slice_head;
use ruke_skills::lazy::inject_system_before;

use crate::chat::{
    attach, clock, forward,
    next_search::BridgeError,
    sse::ProgressChannel,
};
use crate::AppState;

/// What the web gate contributes: the `[S1]…[Sn]` citation map and the
/// gate summary. `Some` pair ⇔ the gate produced a bundle (an EMPTY map
/// when the bundle had no packets — still "non-null" for the Rule 2.3
/// header pairing). `None`s when the gate was disabled, skipped the
/// search, or failed (log-and-continue; the turn proceeds without web
/// evidence exactly like TS).
#[derive(Debug, Default)]
pub struct PipelineOutcome {
    pub web_citations: Option<CitationMap>,
    pub search_gate: Option<ResearchMeta>,
    /// P2: the depth the gate chose when it produced a bundle — drives the
    /// model-facing web tool loop (`chat/web_loop.rs` ⇔ TS web-tool-loop).
    /// TS-ownership rollback: depth crosses the bridge as the TS wire
    /// string ("quick" | "standard" | "deep") — Rust no longer owns a
    /// Depth type.
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
    // WS05 (audit 2026-11-05 item 5): the conversation half of the marker
    // tuple — the research bridge's journal key. The Next side
    // (app/api/internal/web-research/route.ts) journals completed research
    // turns and rehydrates prior evidence under this id. Identity ONLY:
    // never a routing switch, never proof of a fetch (the journal is
    // server-written; nothing here trusts client text). None ⇒ the field
    // is simply absent and the bridge neither journals nor rehydrates.
    conversation_id: Option<&str>,
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
    let browser_turn =
        browser_marker && crate::task_scope::routes_to_browser_turn(&turn_scope);

    // ---- 6) web-research gate (route.ts:835; PART-8 wired) ----
    // The env short-circuit precedes the slot claim: a disabled gate never
    // touches the inference slot (TS `if (webResearchDisabled) log...
    // else { beginUserTurn(); try {…} finally { endUserTurn(); } }`).
    if browser_turn {
        tracing::info!(
            parent: span,
            prompt = %js_slice_head(question, 60),
            "general web research skipped: operational task scope — the browser turn owns the site-bound work"
        );
    } else if gate_disabled_by_env() {
        tracing::info!(
            parent: span,
            prompt = %js_slice_head(question, 60),
            "web-research pipeline disabled (WEB_SEARCH_GATE_DISABLED)"
        );
    } else if let Some(bridge) = state.next_search.as_ref() {
        // TS-ownership rollback (2026-11-03): the research itself is
        // TypeScript's — it runs in the Next process through the same
        // runWebResearch() the public /api/search route uses, driven over
        // the internal bridge RPC (app/api/internal/web-research). Rust
        // keeps ONLY the generic transport pieces: the slot claim, the
        // progress-frame relay, and the evidence injection here.
        // Drop IS the `finally endUserTurn`. The slot counts turns, so the
        // forwarder's later `begin_guard` nests exactly like the TS
        // handler's second `beginUserTurn` for the same request. The
        // whole research window stays inside the guard.
        let _web_guard = state.slot.clone().begin_guard();

        // Brief §3 law: the current user turn may have SHIFTED off
        // `last_user_idx` — step 4 (decision skill) and step 5 (attachment
        // retrieval) each inject a SYSTEM block before it. The raw read used
        // to land on that SYSTEM block and silently drop the turn's image
        // parts; recompute the real position first (⇔ TS `resolveTurnIndex`).
        let turn_idx = payload
            .get("messages")
            .and_then(Value::as_array)
            .map(|m| resolve_turn_index(m, last_user_idx))
            .unwrap_or(last_user_idx);
        let turn_content = payload
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|m| m.get(turn_idx))
            .and_then(|m| m.get("content"));
        let image_parts: Vec<String> = turn_image_parts(turn_content);
        // §11.2 follow-up: the gate's attachment-evidence flag is the TS
        // oracle's `hasAttachmentRefs || hasInlineAttachment` — unindexed
        // attachments inline their content (no ref) but the turn STILL
        // carries local evidence. Retrieval above stays ref-keyed.
        let inline_attachment = turn_has_inline_attachment(turn_content);
        let history_json: Vec<Value> = history
            .iter()
            .filter_map(|h| {
                let role = h.get("role").and_then(Value::as_str)?;
                let content = h.get("content").and_then(Value::as_str)?;
                Some(json!({ "role": role, "content": content }))
            })
            .collect();
        // Task-scope audit (brief #1/#6): the ONE per-turn fold hoisted
        // above feeds the research ctx — the model cannot broaden it via
        // tool arguments. Crosses the wire verbatim (the shared
        // task-scope fixture matrix pins the shape on both sides).
        let mut body = json!({
            "prompt": question,
            "history": history_json,
            "hasImageAttachment": !image_parts.is_empty(),
            // Part-10 approved deviation: the SAME current-turn flag the
            // retrieval stage above keyed off feeds the attachment-aware
            // gate suppression (TS oracle: hasAttachmentEvidence). §11.2:
            // OR-ed with the inline-attachment flag.
            "hasAttachmentEvidence": has_attachment_refs || inline_attachment,
            "imageDataUrls": image_parts,
            "scope": serde_json::to_value(&turn_scope).unwrap_or(Value::Null),
            // Session-zone date at the turn instant ⇔ TS chat-route
            // `currentDate: sessionDateString(turnInstant, turnTimezone)`:
            // the gate's "today" must equal the date the step-7 clock
            // block shows — never the gate's bare-UTC fallback.
            "currentDate": clock::session_date_string(turn_timezone, turn_now),
        });
        // WS05 (audit item 5): the conversation id rides the research body
        // so the Next bridge can journal the turn and rehydrate prior
        // evidence (⇔ app/api/chat/route.ts passes `conversationId` into
        // runTurnPipeline on the supervisor-off path). Absent/empty ⇒ no
        // field, and the bridge neither journals nor rehydrates — the id
        // never gates routing and never proves a fetch happened.
        if let Some(cid) = conversation_id.map(str::trim).filter(|c| !c.is_empty()) {
            body["conversationId"] = Value::String(cid.to_string());
        }

        // ⇔ TS `onProgress: (p) => { log.info({…}, "web-research progress");
        //    stage("web:"+p.stage, { detail, total, done, coverage, url,
        //    domain }) }`. On the legacy path `pc` is None (TS's no-op
        //    `stage`) but the log still runs. `try_stage` is the sync
        //    escape hatch (its docs record the full-queue drop divergence).
        // The bridge relays PipelineProgress frames verbatim — the stage
        // labels are the TS wire strings (gate/planning/searching/...).
        let pc: Option<&ProgressChannel> = ch.as_deref();
        let on_progress = |f: &Value| {
            let label = f.get("stage").and_then(Value::as_str).unwrap_or_default();
            let detail = f.get("detail").and_then(Value::as_str).unwrap_or_default();
            tracing::info!(
                parent: span,
                stage = %label,
                detail = %detail,
                "web-research progress"
            );
            if let Some(pc) = pc {
                let mut e = StageEvent::new(format!("web:{label}"));
                e.detail = f.get("detail").and_then(Value::as_str).map(str::to_string);
                e.total = f.get("total").and_then(Value::as_u64);
                e.done = f.get("done").and_then(Value::as_u64);
                e.coverage = f.get("coverage").and_then(Value::as_f64);
                e.url = f.get("url").and_then(Value::as_str).map(str::to_string);
                e.domain = f.get("domain").and_then(Value::as_str).map(str::to_string);
                pc.try_stage(&e);
            }
        };

        // Cancellation ⇔ TS threading the request's AbortSignal: dropping
        // the response future closes the socket, Next observes the request
        // abort and stops retrieval (next_search.rs).
        let result = bridge.research(&body, token, on_progress).await;

        // TS catch arm around the whole step: ANY failure logs and
        // proceeds WITHOUT web evidence — the turn never gets a
        // `ruke_error` from the web stage (Rule 2.4). Same for a bridge
        // transport failure: there is no retry and no second engine.
        let frame = match result {
            Err(BridgeError::Cancelled) => {
                tracing::info!(parent: span, "web research cancelled with the turn");
                None
            }
            Err(err) => {
                tracing::error!(
                    parent: span,
                    err = %err,
                    "web research bridge failed — proceeding without web evidence"
                );
                None
            }
            Ok(frame) => Some(frame),
        };
        if let Some(frame) = frame.as_ref() {
            match frame.get("status").and_then(Value::as_str) {
                Some("bundle") => {
                    let system_block = frame
                        .get("systemBlock")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if !system_block.is_empty() {
                        if let Some(messages) =
                            payload.get_mut("messages").and_then(Value::as_array_mut)
                        {
                            inject_system_before(messages, last_user_idx + 1, system_block.to_string());
                        }
                    }
                    // The TS route serializes citations as the sourceId →
                    // {sourceId,url,title,domain,publishedAt} object —
                    // byte-compatible with the old CitationMap contents.
                    outcome.web_citations = frame.get("citations").and_then(Value::as_object).cloned();
                    // ResearchMeta/GateQuery are Serialize-only contracts:
                    // rebuild them from the camelCase frame (⇔ the retired
                    // research_meta wire strings).
                    let gate = frame.get("searchGate");
                    outcome.search_gate = gate.map(|g| ResearchMeta {
                        depth: g
                            .get("depth")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        freshness: g
                            .get("freshness")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        decided_by: g.get("decidedBy").and_then(Value::as_str).map(str::to_string),
                        queries: g
                            .get("queries")
                            .and_then(Value::as_array)
                            .map(|qs| {
                                qs.iter()
                                    .filter_map(|q| {
                                        Some(GateQuery {
                                            query: q.get("query").and_then(Value::as_str)?.to_string(),
                                            intent: q.get("intent").and_then(Value::as_str)?.to_string(),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    });
                    outcome.web_depth = frame.get("depth").and_then(Value::as_str).map(str::to_string);
                    // P5 §55/§57: plan + validated surfaces travel as wire
                    // Values; the TS frame already gates empty surfaces out
                    // (presentation null / richResults [] ⇔ the length>0
                    // law) — Rust mirrors "absent when empty".
                    outcome.presentation = frame.get("presentation").filter(|v| !v.is_null()).cloned();
                    if let Some(rr) = frame.get("richResults").and_then(Value::as_array) {
                        if !rr.is_empty() {
                            outcome.rich_results = Some(rr.clone());
                        }
                    }
                    // shortcut: closures instead of `Value::as_*` paths —
                    // inside tracing macro fields that path resolves to
                    // the tracing `Value` TRAIT (E0782), not serde's type.
                    let stats = frame.get("stats");
                    let stat_u64 = |key: &str| {
                        stats.and_then(|s| s.get(key)).and_then(|v| v.as_u64()).unwrap_or(0)
                    };
                    tracing::info!(
                        parent: span,
                        passages = stat_u64("passages"),
                        results = stat_u64("results"),
                        gate_source = %stats.and_then(|s| s.get("gateSource")).and_then(|v| v.as_str()).unwrap_or(""),
                        from_cache = stats.and_then(|s| s.get("fromCache")).and_then(|v| v.as_bool()).unwrap_or(false),
                        citations = frame.get("citations").and_then(|v| v.as_object()).map(|m| m.len()).unwrap_or(0) as u64,
                        "web research evidence injected (TS-owned pipeline via the internal bridge)"
                    );
                }
                Some("no_bundle") => {}
                Some("error") => {
                    tracing::error!(
                        parent: span,
                        err = %frame.get("message").and_then(|v| v.as_str()).unwrap_or(""),
                        "TS web research pipeline failed — proceeding without web evidence"
                    );
                }
                _ => {
                    tracing::error!(
                        parent: span,
                        "web research bridge sent an unexpected terminal frame"
                    );
                }
            }
        }
        // `_web_guard` drops here ⇔ the finally.
    } else {
        // Bridge not configured (env pair unset): honest degradation — no
        // Rust-side search fallback exists (rollback law).
        tracing::warn!(
            parent: span,
            prompt = %js_slice_head(question, 60),
            "web-research bridge not configured: the turn proceeds without web evidence"
        );
    }

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
        // WS05: the identity half carries on to the bridge as the journal
        // key (⇔ TS chat-route conversationId). No marker ⇒ no key.
        browser.as_ref().map(|b| b.0.as_str()),
        &span,
    )
    .await;

    // TS start(): `if (webCitations && Object.keys(webCitations).length >
    // 0) write web_meta` — the gate summary rides as
    // `searchGate: searchGateMeta ?? undefined` (skip-if-none matches).
    // With the corpus env (gate disabled) the outcome stays None-pair and
    // the recorded golden bytes carry no such frame, exactly as before.
    // P5 (§57): the frame also fires when the turn minted rich surfaces
    // but no citation packets (e.g. news items from ranked results alone) —
    // surfaces must still reach the UI. webCitations parity ⇔ TS `??`:
    // no-bundle (None) omits the key; a bundle with zero packets (Some(
    // empty)) serializes `{}` exactly like TS's truthy empty object.
    let surfaces: Vec<Value> = outcome.rich_results.clone().unwrap_or_default();
    let has_citations = outcome
        .web_citations
        .as_ref()
        .is_some_and(|c| !c.is_empty());
    if has_citations || !surfaces.is_empty() {
        let mut ev = StageEvent::new("web_meta");
        ev.web_citations = outcome.web_citations.clone();
        ev.search_gate = outcome.search_gate.clone();
        ev.presentation = outcome.presentation.clone();
        if !surfaces.is_empty() {
            ev.rich_results = Some(surfaces.clone());
        }
        ch.stage(&ev).await;
        // §58 per-surface lifecycle frames: the frame payload is ONLY
        // id/kind/revision — the envelope itself rode once on web_meta,
        // never repeated per frame. Surfaces derive server-side before any
        // model byte, so discovered→ready arrive back-to-back;
        // `web:surface_updated` is the reserved mid-turn revision path
        // (none minted yet — the P2 tool loop does not regenerate).
        for rr in &surfaces {
            let sid = rr
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let kind = rr
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mut d = StageEvent::new("web:surface_discovered");
            d.surface_id = Some(sid.clone());
            d.surface_kind = Some(kind.clone());
            d.surface_revision = Some(1);
            ch.stage(&d).await;
            let mut r = StageEvent::new("web:surface_ready");
            r.surface_id = Some(sid);
            r.surface_kind = Some(kind);
            r.surface_revision = Some(1);
            ch.stage(&r).await;
        }
    }

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
    // tool-loop path with the SAME stripped payload; every other turn is
    // byte-identical to before.
    // P2: a gate-produced bundle additionally arms the model-facing web
    // tool loop (web_loop.rs ⇔ TS web-tool-loop.ts) for turns that carry
    // no client-supplied `tools` — a browser-routed turn keeps priority,
    // and a client passthrough `tools` array is never overwritten.
    //
    // Brief #2: the routing conjunction completes HERE against the ONE
    // fold the pipeline already made — no second derivation anywhere.
    // The browser loop runs only when marker presence AND an Operate
    // scope agree; a marker turn with any other intent falls through to
    // the research/plain path like any other turn (the browser loop no
    // longer swallows research turns — brief #3), and panel visibility
    // enters nowhere in this law. `turn_scope` moves into whichever tool
    // loop runs.
    let turn_scope = outcome.turn_scope.take();
    let browser_take = browser.is_some()
        && turn_scope
            .as_ref()
            .is_some_and(|s| crate::task_scope::routes_to_browser_turn(s));
    let web_tools =
        !browser_take && outcome.web_depth.is_some() && payload.get("tools").is_none();
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
            let depth = outcome.web_depth.expect("web_tools gate implies a depth");
            let merged = outcome.web_citations.take().unwrap_or_default();
            let gate = outcome.search_gate.take();
            // P5 §57: the surface set continues through the loop's re-emits
            // (OVERWRITE law — every updated web_meta carries the full set).
            let presentation = outcome.presentation.take();
            let rich_results = outcome.rich_results.take().unwrap_or_default();
            crate::chat::web_loop::run_web_tool_loop(
                &state,
                payload,
                last_user_idx,
                &model,
                depth,
                merged,
                gate,
                presentation,
                rich_results,
                &question,
                // The SAME fold the gate ctx was built with — one
                // contract per turn, hoisted once at the arms (brief #6:
                // failure and recovery paths never re-widen it).
                turn_scope,
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

/* ── web-gate helpers (⇔ the inline TS blocks in route.ts step 6) ─────── */

/// Brief §3 law ⇔ TS `resolveTurnIndex`: the REAL position of the current
/// user turn at read time. `last_user_idx` is computed at turn entry, but
/// the step-4 skill block and the step-5 retrieval evidence each inject a
/// SYSTEM block BEFORE that turn and shift it — a raw read after them lands
/// on the injected SYSTEM message. Only injected SYSTEM blocks can sit at
/// or after `last_user_idx` (it was the LAST user turn), so skipping the
/// contiguous SYSTEM run starting exactly there is exact for 0, 1, or 2
/// injections.
pub(crate) fn resolve_turn_index(messages: &[Value], last_user_idx: usize) -> usize {
    let mut i = last_user_idx;
    while i < messages.len()
        && messages[i].get("role").and_then(Value::as_str) == Some("system")
    {
        i += 1;
    }
    i
}

/// `imageParts`: array content parts that are `image_url` parts whose
/// `imageUrl.url` is a `data:` URL (TS `typeof u === "string" &&
/// u.startsWith("data:")`). Non-array content ⇒ `[]`.
pub(crate) fn turn_image_parts(content: Option<&Value>) -> Vec<String> {
    let parts = match content {
        Some(Value::Array(parts)) => parts,
        _ => return Vec::new(),
    };
    parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("image_url"))
        .filter_map(|p| {
            p.get("image_url")
                .and_then(|i| i.get("url"))
                .and_then(Value::as_str)
        })
        .filter(|u| u.starts_with("data:"))
        .map(str::to_string)
        .collect()
}

/// §11.2 follow-up (⇔ TS `turnHasInlineAttachment`): unindexed (small)
/// attachments carry NO `attachment_ref` — the client inlines their
/// content instead, and EVERY `attachmentParts` variant (indexed or not)
/// begins with a text part "Attached file: …" (lib/chat/client.ts). This
/// feeds the GATE's attachment-evidence flag only; retrieval stays keyed
/// on real refs (there is nothing to retrieve — the content is inline).
pub(crate) fn turn_has_inline_attachment(content: Option<&Value>) -> bool {
    match content {
        Some(Value::Array(parts)) => parts.iter().any(|p| {
            p.get("type").and_then(Value::as_str) == Some("text")
                && p.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|t| t.starts_with("Attached file: "))
        }),
        _ => false,
    }
}

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
    use super::*;

    #[test]
    fn image_parts_keep_only_data_url_image_parts() {
        let content = serde_json::json!([
            { "type": "text", "text": "hi" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
            { "type": "image_url", "image_url": { "url": "https://x.example/a.png" } },
            { "type": "image_url" },
            { "type": "image_url", "image_url": { "url": 7 } },
        ]);
        assert_eq!(
            turn_image_parts(Some(&content)),
            vec!["data:image/png;base64,AAA"]
        );
        // String content and missing content are BOTH `[]` (TS `?.`).
        assert!(turn_image_parts(Some(&serde_json::json!("s"))).is_empty());
        assert!(turn_image_parts(None).is_empty());
    }

    /// Brief §3 law, real request shape: the step-4 skill block and the
    /// step-5 evidence block are injected BEFORE the current user turn
    /// (exactly like `inject_system_before(messages, last_user_idx, …)` at
    /// the step-4 site and the retrieval site). The RAW index read — the
    /// pre-fix behavior — lands on a SYSTEM block and drops the turn's
    /// images; `resolve_turn_index` must find the shifted user turn.
    #[test]
    fn current_turn_image_parts_survive_skill_and_evidence_injections() {
        let image_turn = serde_json::json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "Attached file: notes.txt\nwho is this person?" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
            ],
        });
        let last = 2usize;
        let mut messages: Vec<Value> = vec![
            serde_json::json!({ "role": "user", "content": "hi" }),
            serde_json::json!({ "role": "assistant", "content": "yo" }),
            image_turn.clone(),
        ];

        // No injections: the index is already the user turn.
        assert_eq!(resolve_turn_index(&messages, last), last);

        // Step 4 (skill) at `last`, step 5 (evidence) at `last + 1` — the
        // user turn lands at last + 2.
        inject_system_before(&mut messages, last, "<core_skill>…".to_string());
        inject_system_before(&mut messages, last + 1, "<attachment_evidence>…".to_string());
        // The DEFECT the fix kills: the raw slot is now a SYSTEM block.
        assert!(
            turn_image_parts(messages.get(last).and_then(|m| m.get("content"))).is_empty(),
            "raw last_user_idx read must be the injected SYSTEM block"
        );
        let idx = resolve_turn_index(&messages, last);
        assert_eq!(idx, last + 2);
        assert_eq!(messages[idx].get("role").and_then(Value::as_str), Some("user"));
        let content = messages[idx].get("content");
        assert_eq!(turn_image_parts(content), vec!["data:image/png;base64,AAA"]);
        assert!(turn_has_inline_attachment(content));

        // Only the skill injection (no evidence): single shift.
        let mut one: Vec<Value> = vec![
            serde_json::json!({ "role": "user", "content": "hi" }),
            serde_json::json!({ "role": "assistant", "content": "yo" }),
            image_turn,
        ];
        inject_system_before(&mut one, last, "<core_skill>…".to_string());
        assert_eq!(resolve_turn_index(&one, last), last + 1);
        assert_eq!(
            turn_image_parts(one[last + 1].get("content")),
            vec!["data:image/png;base64,AAA"]
        );
    }

    // The citation-map / research_meta / stage-label parity tests retired
    // with the Rust search engine (2026-11-03 TS ownership rollback): the
    // values now arrive as TS wire JSON, so the TS suite owns those
    // shapes (web-tools-rpc + research-route vectors pin the grammar).
}
