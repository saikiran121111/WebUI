//! F153 item 3 fresh-audio TRANSPORT (ruke-attach owns the decision,
//! geometry and durability law — see `ruke_attach::audio_reread`). This is
//! the seam the chat pipeline hands to `build_attachment_turn`: it runs ONE
//! bounded `speech.asr` job over EXACTLY the interval it is handed
//! (⇔ TS `transcribeViaCapability(src, { startSec, endSec })` in
//! `lib/server/extract/speech-capability.ts`, wired by
//! `makeFreshAsrReader` in `lib/server/attachindex/audio-reread.ts`) and
//! resolves the envelope into a typed [`FreshResult`].
//!
//! The mapping mirrors the TS law exactly: the disabled-capability env and
//! an unconfigured endpoint resolve to `None`; cancellation resolves to a
//! `cancelled` unavailability (never a media defect); a "ready" envelope is
//! VALIDATED, not trusted — segments with no text, a missing/negative start
//! or an end before the start are dropped, the delivery keeps the 20,000
//! head plus a 200-segment tail (F153 cap law), and a "ready" result with
//! no inspectable transcript and no measured audio verdict is refused as a
//! contract mismatch. Every transport fault resolves to a typed
//! unavailability; the seam never throws into the turn.
//!
//! Documented deviation: TS `path.resolve` cannot fail while Rust
//! canonicalization can (the file is gone); that resolves to a typed
//! internal unavailability — the same place python's containment rejection
//! lands for TS.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use ruke_attach::audio_reread::{FreshAsrInspector, FreshAsrSegment, FreshResult};

use crate::ml_bridge::endpoint_from_env;
use crate::ml_job::{run_job, JobSpec};

/// ⇔ TS `SPEECH_ASR_CAPABILITY` / `SPEECH_ASR_DEADLINE_MS` (240 s wall —
/// never a bound on the queryable fraction of the recording).
const SPEECH_ASR_CAPABILITY: &str = "speech.asr";
const SPEECH_ASR_DEADLINE_S: u64 = 240;
/// ⇔ TS `SPEECH_LANGUAGE_ENV` / `SPEECH_CAPABILITY_ENV`.
const SPEECH_LANGUAGE_ENV: &str = "RUKE_SPEECH_LANGUAGE";
const SPEECH_CAPABILITY_ENV: &str = "RUKE_SPEECH_CAPABILITY";
/// ⇔ TS `MAX_SEGMENTS` (delivery head) / `MAX_TAIL_SEGMENTS` (F153 tail).
const MAX_SEGMENTS: usize = 20_000;
const MAX_TAIL_SEGMENTS: usize = 200;

/// ⇔ TS `speechCapabilityDisabled()`.
fn speech_capability_disabled() -> bool {
    std::env::var(SPEECH_CAPABILITY_ENV)
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        == "off"
}

/// Stateless reader: each call resolves the backend endpoint from the
/// environment and posts the scoped speech.asr envelope for exactly
/// [start_sec, end_sec).
pub struct MlAudioReader;

static NEXT_FRESH_ASR_ID: AtomicU64 = AtomicU64::new(1);

/// The TS `num()`: a finite number or nothing (serde's `as_f64` already
/// refuses non-finite JSON, which JSON cannot carry in the first place).
fn num(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// ⇔ TS `normalizeAsr` restricted to the fields the fresh-read outcome
/// consumes: the validated-segment cap law (head 20,000 + bounded 200 tail,
/// F153), the segmentCount honesty rule (`raw.segment_count` when present,
/// the RAW input length otherwise — not the kept length), and the
/// inspectable rule that refuses a "successful" run carrying no transcript
/// and no measured audio verdict.
fn normalize_ready(result: &Value) -> FreshResult {
    let state_raw = result.get("state").and_then(Value::as_str).unwrap_or("");
    // ⇔ asrRan = raw.asr_ran (when boolean) else state !== "silence"; the
    // effective state is `state || (asrRan ? "transcribed" : "silence")`.
    let asr_ran = result
        .get("asr_ran")
        .and_then(Value::as_bool)
        .unwrap_or(state_raw != "silence");
    let state = if state_raw.is_empty() {
        if asr_ran {
            "transcribed"
        } else {
            "silence"
        }
    } else {
        state_raw
    };

    let segments_in = result
        .get("segments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let head_end = segments_in.len().min(MAX_SEGMENTS);
    let tail_start = if segments_in.len() > head_end {
        head_end.max(segments_in.len() - MAX_TAIL_SEGMENTS)
    } else {
        segments_in.len()
    };
    let mut kept: Vec<FreshAsrSegment> = Vec::new();
    for (idx, entry) in segments_in.iter().enumerate() {
        let text = entry.get("text").and_then(Value::as_str).unwrap_or("").trim();
        let start = entry.get("start").and_then(num);
        let end = entry.get("end").and_then(num);
        // ⇔ the drop law: no text, no usable start, or a non-monotonic
        // timing is a broken backend's segment — dropped, not delivered.
        let Some(start) = start.filter(|s| *s >= 0.0) else { continue };
        if text.is_empty() {
            continue;
        }
        if end.map(|e| e < start).unwrap_or(false) {
            continue;
        }
        if idx < head_end || idx >= tail_start {
            kept.push(FreshAsrSegment {
                start,
                end,
                text: text.to_string(),
            });
        }
    }
    let capped_segments = (tail_start - head_end) as i64;
    let text = result.get("text").and_then(Value::as_str).unwrap_or("").trim();
    // Count and list are kept apart on purpose (⇔ TS): the adapter caps the
    // list, so a larger count is honest reporting, not a mismatch to hide.
    let segment_count = result
        .get("segment_count")
        .and_then(num)
        .map(|c| c as i64)
        .unwrap_or(segments_in.len() as i64);
    let audio_level = result
        .get("audio_level")
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty());

    // A "ready" result must carry SOMETHING inspectable (⇔ TS): empty text
    // plus zero segments is only honest when the worker says why — silence
    // or a measured level.
    if text.is_empty() && kept.is_empty() && state != "silence" && audio_level.is_none() {
        return FreshResult::Unavailable {
            reason: "contract_mismatch".into(),
            message: "the speech backend reported a successful run that carries no inspectable transcript and no measured audio verdict, which is refused rather than reported as an empty recording".into(),
            human_step: "report this: the payload shape and the backend version must match".into(),
            retryable: false,
        };
    }
    if state == "silence" {
        return FreshResult::Silence {
            max_volume_db: audio_level
                .and_then(|m| m.get("max_volume_db"))
                .and_then(num),
        };
    }
    FreshResult::Ready {
        text: text.to_string(),
        segments: kept,
        model: result.get("model").and_then(Value::as_str).unwrap_or("").to_string(),
        device: result.get("device").and_then(Value::as_str).unwrap_or("").to_string(),
        segment_count,
        capped_segments,
    }
}

/// ⇔ TS `transcribeViaCapability`'s envelope handling: cancelled →
/// cancellation, ready → [`normalize_ready`], anything else → a typed
/// unavailability from `envelope.error` (reason defaults to "internal",
/// the message to naming the state, retryable only when the envelope says
/// so).
fn outcome_from_envelope(env: &Value) -> FreshResult {
    let state = env.get("state").and_then(Value::as_str).unwrap_or("");
    if state == "cancelled" {
        return FreshResult::Unavailable {
            reason: "cancelled".into(),
            message: "the speech job was cancelled before it produced a transcript".into(),
            human_step: String::new(),
            retryable: false,
        };
    }
    if state == "ready" {
        return normalize_ready(env.get("result").unwrap_or(&Value::Null));
    }
    let error = env.get("error").cloned().unwrap_or(Value::Null);
    let fallback = format!("the speech job ended in state {state}");
    FreshResult::Unavailable {
        reason: error
            .get("reason")
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty())
            .unwrap_or("internal")
            .to_string(),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .unwrap_or(&fallback)
            .to_string(),
        human_step: error
            .get("human_step")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        retryable: error.get("retryable").and_then(Value::as_bool) == Some(true),
    }
}

impl FreshAsrInspector for MlAudioReader {
    fn transcribe(
        &self,
        src: &Path,
        start_sec: f64,
        end_sec: f64,
        token: &CancellationToken,
    ) -> Pin<Box<dyn Future<Output = FreshResult> + Send + '_>> {
        // The trait's `+ '_` pins the future to `&self`: take owned copies
        // of the call's arguments BEFORE the block (same law as
        // `MlRegionInspector`); a cloned token stays linked to the caller's.
        if speech_capability_disabled() {
            return Box::pin(std::future::ready(FreshResult::None)); // ⇔ state "none"
        }
        let token = token.clone();
        let canonical = match std::fs::canonicalize(src) {
            Ok(p) => p,
            Err(_) => {
                return Box::pin(std::future::ready(FreshResult::Unavailable {
                    reason: "internal".into(),
                    message: "the recording path could not be resolved, so no window was decoded".into(),
                    human_step: String::new(),
                    retryable: false,
                }))
            }
        };
        Box::pin(async move {
            let Ok(endpoint) = endpoint_from_env() else {
                return FreshResult::None; // ⇔ TS mlJob returns null: bridge disabled
            };
            let root: PathBuf = canonical
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."));
            let n = NEXT_FRESH_ASR_ID.fetch_add(1, Ordering::Relaxed);
            let mut payload = json!({
                "path": canonical.to_string_lossy(),
                "root": root.to_string_lossy(),
            });
            if let Some(lang) = std::env::var(SPEECH_LANGUAGE_ENV)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
            {
                payload["language"] = json!(lang);
            }
            // ⇔ TS span law: the interval travels as the worker's own
            // payload keys, and only a real pair of finite numbers is
            // serialized — a lone bound would make the run an open-ended
            // inspection. The caller guarantees a valid pair; the guard
            // keeps that law in the transport.
            if start_sec.is_finite()
                && start_sec >= 0.0
                && end_sec.is_finite()
                && end_sec > start_sec
            {
                payload["start_s"] = json!(start_sec);
                payload["end_s"] = json!(end_sec);
            }
            let spec = JobSpec {
                request_id: format!("asr-req-{n}"),
                run_id: format!("asr-run-{n}"),
                job_id: format!("asr-job-{n}"),
                capability: SPEECH_ASR_CAPABILITY.to_string(),
                payload,
                deadline_s: SPEECH_ASR_DEADLINE_S,
            };
            let env = tokio::select! {
                biased;
                _ = token.cancelled() => {
                    return FreshResult::Unavailable {
                        reason: "cancelled".into(),
                        message: "the speech job was cancelled before it produced a transcript".into(),
                        human_step: String::new(),
                        retryable: false,
                    };
                }
                r = run_job(&endpoint, &spec) => r,
            };
            match env {
                Ok(env) => outcome_from_envelope(&env),
                // ⇔ TS mlJob's catch: transport faults become typed local
                // envelopes (deadline_exceeded / unreachable /
                // input_rejected / contract_mismatch) BEFORE
                // transcribeViaCapability ever sees them.
                Err(crate::ml_job::JobFault::Timeout(detail)) => FreshResult::Unavailable {
                    reason: "deadline_exceeded".into(),
                    message: detail,
                    human_step: "retry, or ask for a narrower range".into(),
                    retryable: true,
                },
                Err(crate::ml_job::JobFault::Unreachable(detail)) => FreshResult::Unavailable {
                    reason: "unreachable".into(),
                    message: detail,
                    human_step: "restart `npm run dev`; the capability route lives in the Rust server".into(),
                    retryable: true,
                },
                Err(crate::ml_job::JobFault::TooLarge(detail)) => FreshResult::Unavailable {
                    reason: "input_rejected".into(),
                    message: detail,
                    human_step: String::new(),
                    retryable: false,
                },
                Err(crate::ml_job::JobFault::Contract(detail)) => FreshResult::Unavailable {
                    reason: "contract_mismatch".into(),
                    message: detail,
                    human_step: String::new(),
                    retryable: true,
                },
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cancelled_envelope_is_cancellation_not_a_media_defect() {
        let out = outcome_from_envelope(&json!({ "state": "cancelled" }));
        match out {
            FreshResult::Unavailable { reason, retryable, .. } => {
                assert_eq!(reason, "cancelled");
                assert!(!retryable, "a cancelled job is not a retryable media defect");
            }
            other => panic!("expected cancelled, got {other:?}"),
        }
    }

    #[test]
    fn ready_envelope_carries_engine_device_and_timed_segments() {
        let out = outcome_from_envelope(&json!({
            "state": "ready",
            "result": {
                "state": "transcribed",
                "text": "she names the closing sponsor VOLTAGE-240",
                "segments": [{ "start": 3541.0, "end": 3547.0, "text": "she names the closing sponsor VOLTAGE-240" }],
                "segment_count": 1,
                "model": "parakeet-tdt",
                "device": "cuda",
            }
        }));
        match out {
            FreshResult::Ready { text, segments, model, device, segment_count, capped_segments } => {
                assert!(text.contains("VOLTAGE-240"));
                assert_eq!(segments.len(), 1);
                assert_eq!(segments[0].start, 3541.0, "absolute timestamps survive");
                assert_eq!(model, "parakeet-tdt");
                assert_eq!(device, "cuda");
                assert_eq!(segment_count, 1);
                assert_eq!(capped_segments, 0);
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn cap_law_keeps_head_and_tail_and_counts_the_middle() {
        // F153: 20,001 valid segments with a unique fact in the LAST one.
        // The TS formula keeps EVERYTHING here: tailStart = max(20000,
        // 20001-200) = 20000, so the tail window starts at the head edge
        // and nothing is capped — the old slice(0, 20000) was the lie.
        let segs: Vec<Value> = (0..20_001)
            .map(|i| json!({ "start": i as f64, "end": i as f64 + 1.0, "text": format!("seg {i}") }))
            .collect();
        let out = normalize_ready(&json!({ "state": "transcribed", "segments": segs }));
        match out {
            FreshResult::Ready { segments, segment_count, capped_segments, .. } => {
                assert_eq!(segment_count, 20_001, "the count survives the cap (honest reporting)");
                assert_eq!(capped_segments, 0);
                assert_eq!(segments.len(), 20_001);
                assert_eq!(segments.last().unwrap().text, "seg 20000");
            }
            other => panic!("expected ready, got {other:?}"),
        }
        // Past 20,200 the middle is skipped: head 20,000 + the bounded
        // 200-segment tail, the middle counted — the final fact keeps its
        // place instead of silently vanishing.
        let segs: Vec<Value> = (0..22_500)
            .map(|i| json!({ "start": i as f64, "end": i as f64 + 1.0, "text": format!("seg {i}") }))
            .collect();
        let out = normalize_ready(&json!({ "state": "transcribed", "segments": segs }));
        match out {
            FreshResult::Ready { segments, segment_count, capped_segments, .. } => {
                assert_eq!(segment_count, 22_500);
                assert_eq!(capped_segments, 2_300);
                assert_eq!(segments.len(), 20_000 + 200);
                assert_eq!(segments.first().unwrap().text, "seg 0");
                assert_eq!(
                    segments.last().unwrap().text,
                    "seg 22499",
                    "the final fact keeps its timestamp — it is not silently unreachable"
                );
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn broken_segments_are_dropped_not_delivered() {
        let out = normalize_ready(&json!({
            "state": "transcribed",
            "text": "x",
            "segments": [
                { "start": 0.0, "end": 1.0, "text": "  " },
                { "start": -5.0, "end": 1.0, "text": "negative start" },
                { "end": 1.0, "text": "no start" },
                { "start": 9.0, "end": 4.0, "text": "end before start" },
                { "start": 10.0, "text": "kept, no end" },
            ],
        }));
        match out {
            FreshResult::Ready { segments, .. } => {
                assert_eq!(segments.len(), 1);
                assert_eq!(segments[0].text, "kept, no end");
                assert_eq!(segments[0].end, None);
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn a_ready_run_with_nothing_inspectable_is_refused() {
        let out = normalize_ready(&json!({ "state": "transcribed", "text": "", "segments": [] }));
        match out {
            FreshResult::Unavailable { reason, message, .. } => {
                assert_eq!(reason, "contract_mismatch");
                assert!(message.contains("no inspectable transcript"));
            }
            other => panic!("expected refusal, got {other:?}"),
        }
        // A measured level (or a silence state) IS the honest verdict.
        assert!(matches!(
            normalize_ready(&json!({ "state": "transcribed", "audio_level": { "max_volume_db": -95.2 } })),
            FreshResult::Ready { .. }
        ));
    }

    #[test]
    fn silence_reports_the_measured_level() {
        let out = normalize_ready(&json!({
            "state": "silence",
            "text": "",
            "segments": [],
            "audio_level": { "max_volume_db": -95.2, "noise_floor_db": -90.0 },
        }));
        match out {
            FreshResult::Silence { max_volume_db } => assert_eq!(max_volume_db, Some(-95.2)),
            other => panic!("expected silence, got {other:?}"),
        }
        // Silence without a level stays silence (the worker's own claim).
        assert!(matches!(
            normalize_ready(&json!({ "state": "silence" })),
            FreshResult::Silence { max_volume_db: None }
        ));
    }

    #[test]
    fn non_ready_states_carry_their_own_verdict() {
        let out = outcome_from_envelope(&json!({
            "state": "unavailable",
            "error": { "reason": "gpu_refused", "message": "the GPU declined the run", "retryable": true },
        }));
        match out {
            FreshResult::Unavailable { reason, retryable, human_step, .. } => {
                assert_eq!(reason, "gpu_refused");
                assert!(retryable);
                assert_eq!(human_step, "");
            }
            other => panic!("expected unavailable, got {other:?}"),
        }
        // No error block: reason "internal", the message names the state.
        let out = outcome_from_envelope(&json!({ "state": "input_rejected" }));
        match out {
            FreshResult::Unavailable { reason, message, retryable, .. } => {
                assert_eq!(reason, "internal");
                assert_eq!(message, "the speech job ended in state input_rejected");
                assert!(!retryable);
            }
            other => panic!("expected unavailable, got {other:?}"),
        }
    }
}
