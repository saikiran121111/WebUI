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
//! PART-8 (implemented): the web-research gate runs between retrieval and
//!   the strip — `WEB_SEARCH_GATE_DISABLED=1` (or `WEB_SEARCH_LFM_DISABLED`)
//!   short-circuits the whole block with the verbatim TS log line and NO
//!   slot claim; otherwise the turn's slot is held across the gate
//!   (`begin_guard`'s Drop ⇔ TS's `finally endUserTurn`), the gate's
//!   progress frames ride `web:<kebab-stage>` via `ProgressChannel::try_stage`,
//!   and a bundle injects `buildMainModelContext().systemBlock` at
//!   `lastUserIdx + 1` and fills `PipelineOutcome`'s two fields — the
//!   legacy header pair (Rule 2.2) and the `web_meta` frame in
//!   `pump_progress` consume them. Client abort reaches the gate through a
//!   flag mirror of the turn token (⇔ TS threading the request signal).
//!   RECORDED QUIRK: `imageParts` indexes the RAW `lastUserIdx` AFTER the
//!   skill/retrieval injections — on injected turns that is a system
//!   message with no image parts; reproduced, not fixed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tracing::Span;

use ruke_attach::{build_attachment_turn, collect_attachment_refs, Cancelled, NotesLlm};
use ruke_contracts::decision::DecisionEnvelope;
use ruke_contracts::stages::{Citation, CitationMap, GateQuery, ResearchMeta, StageEvent};
use ruke_decision::skill_block::build_decision_skill_block;
use ruke_skills::jsstr::js_slice_head;
use ruke_skills::lazy::inject_system_before;
use ruke_websearch::pipeline::{
    build_main_model_context, run_web_research, EvidenceBundle, PipelineProgress, PipelineStage,
};
use ruke_websearch::search_gate::SearchGateOptions;
use ruke_websearch::types::{HistoryTurn, SearchGateContext};

use crate::chat::{attach, forward, sse::ProgressChannel};
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
    span: &Span,
) -> PipelineOutcome {
    let mut outcome = PipelineOutcome::default();

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

    // ---- 6) web-research gate (route.ts:835; PART-8 wired) ----
    // The env short-circuit precedes the slot claim: a disabled gate never
    // touches the inference slot (TS `if (webResearchDisabled) log...
    // else { beginUserTurn(); try {…} finally { endUserTurn(); } }`).
    if ruke_websearch::search_gate::gate_disabled_by_env() {
        tracing::info!(
            parent: span,
            prompt = %js_slice_head(question, 60),
            "web-research pipeline disabled (WEB_SEARCH_GATE_DISABLED)"
        );
    } else {
        // Drop IS the `finally endUserTurn`. The slot counts turns, so the
        // forwarder's later `begin_guard` nests exactly like the TS
        // handler's second `beginUserTurn` for the same request.
        let _web_guard = state.slot.clone().begin_guard();

        // `imageParts` indexes the RAW `lastUserIdx` AFTER the skill and
        // retrieval injections above — on injected turns that slot holds a
        // SYSTEM message (no image parts). The TS oracle reads
        // `payload.messages[lastUserIdx]?.content` at exactly this point;
        // reproduced verbatim (module docs).
        let image_parts: Vec<String> = payload
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|m| m.get(last_user_idx))
            .map(|m| turn_image_parts(m.get("content")))
            .unwrap_or_default();
        let history_turns: Vec<HistoryTurn> = history
            .iter()
            .map(|h| HistoryTurn {
                role: h.get("role").and_then(Value::as_str).unwrap_or_default().to_string(),
                content: h.get("content").and_then(Value::as_str).unwrap_or_default().to_string(),
            })
            .collect();
        let ctx = SearchGateContext {
            user_prompt: question.to_string(),
            history: Some(history_turns),
            has_image_attachment: Some(!image_parts.is_empty()),
            // Part-10 approved deviation: the SAME current-turn flag the
            // retrieval stage above keyed off feeds the attachment-aware
            // gate suppression (TS oracle: hasAttachmentEvidence).
            has_attachment_evidence: Some(has_attachment_refs),
            // Universal search pre-gate (approved deviation): None ⇒ the
            // gate uses the real runtime date (never hardcoded).
            current_date: None,
            image_data_urls: Some(image_parts),
        };
        // Settings are read PER CALL (llmApiUrl/llmApiKey): a settings.json
        // edit lands without a restart (Rule 2.5).
        let gate_options = SearchGateOptions {
            endpoint: state.settings.llm_api_url(),
            api_key: state.settings.llm_api_key(),
            gate_disabled: None,
        };

        // ⇔ TS `onProgress: (p) => { log.info({…}, "web-research progress");
        //    stage("web:"+p.stage, { detail, total, done, coverage, url,
        //    domain }) }`. On the legacy path `pc` is None (TS's no-op
        //    `stage`) but the log still runs. `try_stage` is the sync
        //    escape hatch (its docs record the full-queue drop divergence).
        let pc: Option<&ProgressChannel> = ch.as_deref();
        let progress_fn = |p: &PipelineProgress| {
            let label = stage_label(p.stage);
            tracing::info!(
                parent: span,
                stage = %label,
                detail = %p.detail.clone().unwrap_or_default(),
                "web-research progress"
            );
            if let Some(pc) = pc {
                let mut e = StageEvent::new(format!("web:{label}"));
                e.detail = p.detail.clone();
                e.total = p.total.map(|t| t as u64);
                e.done = p.done.map(|d| d as u64);
                e.coverage = p.coverage;
                e.url = p.url.clone();
                e.domain = p.domain.clone();
                pc.try_stage(&e);
            }
        };

        // TS threads the request's combined AbortSignal into the pipeline;
        // the Rust seam mirrors the turn's token into a flag the pipeline
        // polls (`cancel` checks in run_web_research ⇔ `signal.aborted`).
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_watcher = {
            let cancel = cancel.clone();
            let token = token.clone();
            tokio::spawn(async move {
                token.cancelled().await;
                cancel.store(true, Ordering::Relaxed);
            })
        };
        let result = run_web_research(
            &state.http,
            &gate_options,
            &state.web.net,
            state.web.cache.as_ref(),
            &state.web.verticals,
            state.web.bridge.as_ref(),
            &ctx,
            Some(&progress_fn as &(dyn Fn(&PipelineProgress) + Send + Sync)),
            Some(&cancel),
        )
        .await;
        cancel_watcher.abort();

        // TS catch arm around the whole step: ANY pipeline failure logs
        // and proceeds WITHOUT web evidence — the turn never gets a
        // `ruke_error` from the web stage (Rule 2.4).
        match result {
            Err(err) => {
                tracing::error!(
                    parent: span,
                    err = %err,
                    "web research pipeline failed — proceeding without web evidence"
                );
            }
            Ok(None) => {}
            Ok(Some(bundle)) => {
                let mm = build_main_model_context(&bundle);
                if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
                    inject_system_before(messages, last_user_idx + 1, mm.system_block);
                }
                outcome.web_citations = Some(citation_map_from(&bundle));
                outcome.search_gate = Some(research_meta(&bundle));
                tracing::info!(
                    parent: span,
                    passages = bundle.top_passages.len() as u64,
                    results = bundle.search_results.len() as u64,
                    gate_source = %wire_str(&bundle.search_gate.source),
                    from_cache = bundle.from_cache,
                    citations = bundle.packets.len() as u64,
                    gap_search = bundle.gap_search_fired,
                    "web research evidence injected"
                );
            }
        }
        // `_web_guard` drops here ⇔ the finally.
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
    let outcome = run_turn_pipeline(
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
        &span,
    )
    .await;

    // TS start(): `if (webCitations && Object.keys(webCitations).length >
    // 0) write web_meta` — the gate summary rides as
    // `searchGate: searchGateMeta ?? undefined` (skip-if-none matches).
    // With the corpus env (gate disabled) the outcome stays None-pair and
    // the recorded golden bytes carry no such frame, exactly as before.
    if let Some(cits) = &outcome.web_citations {
        if !cits.is_empty() {
            let mut ev = StageEvent::new("web_meta");
            ev.web_citations = Some(cits.clone());
            ev.search_gate = outcome.search_gate.clone();
            ch.stage(&ev).await;
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
    forward::forward_into(&state, body, decision_mode, &model, &span, &token, &mut ch).await;
}

/* ── web-gate helpers (⇔ the inline TS blocks in route.ts step 6) ─────── */

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
        .filter_map(|p| p.get("image_url").and_then(|i| i.get("url")).and_then(Value::as_str))
        .filter(|u| u.starts_with("data:"))
        .map(str::to_string)
        .collect()
}

/// `webCitationMap[p.sourceId] = { sourceId, url, title, domain,
/// publishedAt }` over the PRE-gap packets in order (the bundle's
/// `packets` list is already the pre-gap one — the recorded quirk).
pub(crate) fn citation_map_from(bundle: &EvidenceBundle) -> CitationMap {
    let mut map = CitationMap::new();
    for p in &bundle.packets {
        let c = Citation {
            source_id: p.source_id.clone(),
            url: p.url.clone(),
            title: p.title.clone(),
            domain: p.domain.clone(),
            published_at: p.published_at.clone(),
        };
        map.insert(p.source_id.clone(), serde_json::to_value(&c).unwrap_or_default());
    }
    map
}

/// `searchGateMeta = { depth, freshness, decidedBy: gate.source,
/// queries: decision.queries.map(q => ({ query, intent })) }`.
pub(crate) fn research_meta(bundle: &EvidenceBundle) -> ResearchMeta {
    let d = &bundle.search_gate.decision;
    ResearchMeta {
        depth: wire_str(&d.depth),
        freshness: wire_str(&d.freshness),
        decided_by: Some(wire_str(&bundle.search_gate.source)),
        queries: d
            .queries
            .iter()
            .map(|q| GateQuery { query: q.query.clone(), intent: wire_str(&q.intent) })
            .collect(),
    }
}

/// The enum's WIRE string (`depth`/`freshness`/`intent`/`source` on the
/// header/frame values). All four enums serialize to a single string.
pub(crate) fn wire_str<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        _ => String::new(),
    }
}

/// `stage("web:" + p.stage)` — the kebab-case wire labels (`gap-search`,
/// `auth_required`) that the TS pipeline emits (pipeline.ts:137).
fn stage_label(s: PipelineStage) -> String {
    wire_str(&s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruke_websearch::types::{
        Depth, EvidencePacket, ExtractionKind, Freshness, GateSource, Intent, SearchDecision,
        SearchGateResult, SearchQuery,
    };

    fn bundle_with(packets: Vec<EvidencePacket>) -> EvidenceBundle {
        EvidenceBundle {
            search_gate: SearchGateResult {
                decision: SearchDecision {
                    search_required: true,
                    reason: "r".into(),
                    freshness: Freshness::Week,
                    depth: Depth::Deep,
                    queries: vec![
                        SearchQuery { query: "q one".into(), intent: Intent::News, preferred_domains: None },
                        SearchQuery { query: "q two".into(), intent: Intent::Docs, preferred_domains: None },
                    ],
                },
                source: GateSource::MainModel,
                gate_ms: 1.0,
            },
            search_results: vec![],
            packets,
            top_passages: vec![],
            from_cache: false,
            coverage: 0.0,
            gap_search_fired: false,
            auth_required: vec![],
        }
    }

    #[test]
    fn image_parts_keep_only_data_url_image_parts() {
        let content = serde_json::json!([
            { "type": "text", "text": "hi" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
            { "type": "image_url", "image_url": { "url": "https://x.example/a.png" } },
            { "type": "image_url" },
            { "type": "image_url", "image_url": { "url": 7 } },
        ]);
        assert_eq!(turn_image_parts(Some(&content)), vec!["data:image/png;base64,AAA"]);
        // String content and missing content are BOTH `[]` (TS `?.`).
        assert!(turn_image_parts(Some(&serde_json::json!("s"))).is_empty());
        assert!(turn_image_parts(None).is_empty());
    }

    #[test]
    fn citation_map_follows_packet_order_and_drops_absent_published_at() {
        let bundle = bundle_with(vec![
            EvidencePacket {
                source_id: "S1".into(), url: "https://a.example".into(), title: "A".into(),
                domain: "a.example".into(), published_at: Some("2026-01-01".into()),
                extraction: ExtractionKind::SnippetOnly, passages: vec![], classification: None,
            },
            EvidencePacket {
                source_id: "yt".into(), url: "https://yt.example".into(), title: "Y".into(),
                domain: "yt.example".into(), published_at: None,
                extraction: ExtractionKind::Direct, passages: vec![], classification: None,
            },
        ]);
        let map = citation_map_from(&bundle);
        let keys: Vec<&String> = map.keys().collect();
        assert_eq!(keys, ["S1", "yt"]); // insertion order ⇔ Map insertion order
        assert_eq!(map["S1"]["publishedAt"], serde_json::json!("2026-01-01"));
        assert!(map["yt"].get("publishedAt").is_none()); // TS undefined drops
    }

    #[test]
    fn research_meta_uses_wire_strings() {
        let meta = research_meta(&bundle_with(vec![]));
        assert_eq!(meta.depth, "deep");
        assert_eq!(meta.freshness, "week");
        assert_eq!(meta.decided_by.as_deref(), Some("main-model"));
        assert_eq!(
            serde_json::to_string(&meta.queries).unwrap(),
            r#"[{"query":"q one","intent":"news"},{"query":"q two","intent":"docs"}]"#
        );
    }

    #[test]
    fn stage_labels_match_the_ts_wire() {
        assert_eq!(stage_label(PipelineStage::GapSearch), "gap-search");
        assert_eq!(stage_label(PipelineStage::AuthRequired), "auth_required");
        assert_eq!(stage_label(PipelineStage::Gate), "gate");
        assert_eq!(stage_label(PipelineStage::Reranking), "reranking");
    }
}
