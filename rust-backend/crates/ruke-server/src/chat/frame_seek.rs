//! F153 item 4 visual-seek TRANSPORT (ruke-attach owns the decision,
//! geometry and durability law — see `ruke_attach::frame_seek`). This is
//! the seam the chat pipeline hands to `build_attachment_turn`: it runs ONE
//! bounded `video.frame_ocr` job over EXACTLY the instants it is handed
//! (⇔ the `mlJob` call in `lib/server/attachindex/frame-seek.ts`, wired by
//! `makeFrameSeeker`) and resolves the envelope into a typed [`SeekReply`].
//!
//! The mapping mirrors the TS law exactly: an unconfigured endpoint
//! resolves to `SeekReply::None`; a "ready" envelope is VALIDATED, not
//! trusted — the per-frame rows are decoded (pixels base64-decoded with
//! reread's strict law; a decode failure reads as "pixels not delivered",
//! which the owner names per instant) and a "ready" result with NO
//! per-frame records is refused as a contract mismatch. Cancellation
//! resolves to a `cancelled` unavailability (never a media defect). Every
//! transport fault resolves to a typed unavailability; the seam never
//! throws into the turn.
//!
//! DOCUMENTED DEVIATION: TS `path.resolve` cannot fail while Rust
//! canonicalization can (the file is gone); that resolves to a typed
//! internal unavailability — the same place the fresh-audio transport
//! lands (chat/audio.rs).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use ruke_attach::frame_seek::{FrameSeeker, SeekReply, SeekedFrame, SEEK_DEADLINE_S};

use crate::ml_bridge::endpoint_from_env;
use crate::ml_job::{run_job, JobSpec};

/// ⇔ TS `SPEECH_ASR_*` discipline: capability + bound live with the owner
/// (`ruke_attach::frame_seek`), the transport just rides them.
static NEXT_FRAME_SEEK_ID: AtomicU64 = AtomicU64::new(1);

/// Stateless seeker: each call resolves the backend endpoint from the
/// environment and posts the scoped video.frame_ocr envelope for exactly
/// the handed instants.
pub struct MlFrameSeeker;

/// ⇔ TS `frame-seek.ts` envelope handling: cancelled → cancellation,
/// ready → [`normalize_ready`], anything else → a typed unavailability
/// from `envelope.error` (reason defaults to "internal", the message to
/// naming the state, retryable only when the envelope says so).
fn outcome_from_envelope(env: &Value) -> SeekReply {
    let state = env.get("state").and_then(Value::as_str).unwrap_or("");
    if state == "cancelled" {
        return SeekReply::Unavailable {
            reason: "cancelled".into(),
            message: "the visual seek job was cancelled before it produced frames".into(),
            human_step: String::new(),
            retryable: false,
        };
    }
    if state == "ready" {
        return normalize_ready(env.get("result").unwrap_or(&Value::Null));
    }
    let error = env.get("error").cloned().unwrap_or(Value::Null);
    let fallback = format!("the visual seek job ended in state {state}");
    SeekReply::Unavailable {
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

/// ⇔ TS "ready" handling in `seekFramesForCues`: `result.frames` must be
/// an ARRAY (missing/non-array is the contract mismatch TS names), rows
/// carry the worker's own `time_s`/`state`/`detail`/`text`, pixels ride as
/// `image_b64` (strict decode; failure = "no pixels", named by the owner),
/// and the recogniser name comes from `result.ocr.engine`. Timestamp
/// filtering and per-instant naming stay in the owner (ruke-attach) — the
/// transport validates SHAPE, never the evidence.
fn normalize_ready(result: &Value) -> SeekReply {
    let Some(rows) = result.get("frames").and_then(Value::as_array) else {
        return SeekReply::ContractMismatch;
    };
    let frames = rows
        .iter()
        .map(|f| SeekedFrame {
            time_s: f.get("time_s").and_then(Value::as_f64).unwrap_or(f64::NAN),
            state: f.get("state").and_then(Value::as_str).unwrap_or("").to_string(),
            detail: f.get("detail").and_then(Value::as_str).unwrap_or("").to_string(),
            text: f.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            pixels: f
                .get("image_b64")
                .and_then(Value::as_str)
                .and_then(crate::chat::reread::b64_decode)
                .unwrap_or_default(),
            copy_of_time: f.get("copy_of_time").and_then(Value::as_f64),
        })
        .collect();
    let engine = result
        .get("ocr")
        .and_then(Value::as_object)
        .and_then(|m| m.get("engine"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    SeekReply::Ready { frames, engine }
}

impl FrameSeeker for MlFrameSeeker {
    fn seek(
        &self,
        src: &Path,
        times: &[f64],
        duration: f64,
        language: &str,
        token: &CancellationToken,
    ) -> Pin<Box<dyn Future<Output = SeekReply> + Send + '_>> {
        // The trait's `+ '_` pins the future to `&self`: take owned copies
        // of the call's arguments BEFORE the block (same law as
        // `MlAudioReader`); a cloned token stays linked to the caller's.
        let token = token.clone();
        let times = times.to_vec();
        let language = language.to_string();
        let canonical = match std::fs::canonicalize(src) {
            Ok(p) => p,
            Err(_) => {
                return Box::pin(std::future::ready(SeekReply::Unavailable {
                    reason: "internal".into(),
                    message: "the recording path could not be resolved, so no frame was decoded".into(),
                    human_step: String::new(),
                    retryable: false,
                }))
            }
        };
        Box::pin(async move {
            let Ok(endpoint) = endpoint_from_env() else {
                return SeekReply::None; // ⇔ TS mlJob returns null: bridge disabled
            };
            let root: PathBuf = canonical
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."));
            let n = NEXT_FRAME_SEEK_ID.fetch_add(1, Ordering::Relaxed);
            // ⇔ TS payload law: the language ALWAYS rides (empty is the
            // legal pixels-only mode of the F153 frame-OCR contract), the
            // instants travel as the worker's own `times`, and the pixel
            // request is explicit.
            let payload = json!({
                "path": canonical.to_string_lossy(),
                "root": root.to_string_lossy(),
                "language": language,
                "duration": duration,
                "times": times,
                "max_frames": times.len(),
                "include_image": true,
            });
            let spec = JobSpec {
                request_id: format!("seek-req-{n}"),
                run_id: format!("seek-run-{n}"),
                job_id: format!("seek-job-{n}"),
                capability: ruke_attach::frame_seek::FRAME_OCR_CAPABILITY.to_string(),
                payload,
                deadline_s: SEEK_DEADLINE_S,
            };
            let env = tokio::select! {
                biased;
                _ = token.cancelled() => {
                    return SeekReply::Unavailable {
                        reason: "cancelled".into(),
                        message: "the visual seek job was cancelled before it produced frames".into(),
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
                // input_rejected / contract_mismatch) BEFORE the owner's
                // envelope handling ever sees them.
                Err(crate::ml_job::JobFault::Timeout(detail)) => SeekReply::Unavailable {
                    reason: "deadline_exceeded".into(),
                    message: detail,
                    human_step: "retry, or ask about one moment at a time".into(),
                    retryable: true,
                },
                Err(crate::ml_job::JobFault::Unreachable(detail)) => SeekReply::Unavailable {
                    reason: "unreachable".into(),
                    message: detail,
                    human_step: "restart `npm run dev`; the capability route lives in the Rust server".into(),
                    retryable: true,
                },
                Err(crate::ml_job::JobFault::TooLarge(detail)) => SeekReply::Unavailable {
                    reason: "input_rejected".into(),
                    message: detail,
                    human_step: String::new(),
                    retryable: false,
                },
                Err(crate::ml_job::JobFault::Contract(detail)) => SeekReply::Unavailable {
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

    #[test]
    fn cancelled_envelope_is_cancellation_not_a_media_defect() {
        match outcome_from_envelope(&json!({ "state": "cancelled" })) {
            SeekReply::Unavailable { reason, retryable, .. } => {
                assert_eq!(reason, "cancelled");
                assert!(!retryable, "a cancelled job is not a retryable media defect");
            }
            other => panic!("expected cancelled, got {other:?}"),
        }
    }

    #[test]
    fn ready_without_frame_rows_is_a_contract_mismatch() {
        // ⇔ TS: "ready" with no per-frame records is refused, never credited.
        assert!(matches!(
            normalize_ready(&json!({ "note": "done" })),
            SeekReply::ContractMismatch
        ));
        // An EMPTY array is not a mismatch: rows exist, the owner reports
        // per-instant outcomes (⇔ TS `Array.isArray([])` is truthy).
        assert!(matches!(
            normalize_ready(&json!({ "frames": [] })),
            SeekReply::Ready { .. }
        ));
    }

    #[test]
    fn ready_rows_decode_pixels_and_name_the_recogniser() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let reply = normalize_ready(&json!({
            "frames": [{
                "time_s": 130.0,
                "state": "pixels",
                "detail": "",
                "text": "",
                "image_b64": png,
            }],
            "ocr": { "engine": "tesseract-ocr", "text_pass": false },
        }));
        match reply {
            SeekReply::Ready { frames, engine } => {
                assert_eq!(engine, "tesseract-ocr");
                assert_eq!(frames.len(), 1);
                assert_eq!(frames[0].time_s, 130.0);
                assert_eq!(frames[0].state, "pixels");
                assert_eq!(frames[0].pixels.first(), Some(&0x89), "PNG magic decoded");
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn corrupt_pixels_read_as_not_delivered_not_garbage() {
        // Strict decode (the reread law): a non-base64 payload yields NO
        // pixels — the owner then names the per-instant omission.
        let reply = normalize_ready(&json!({
            "frames": [{ "time_s": 5.0, "state": "pixels", "image_b64": "QUJ*" }],
        }));
        match reply {
            SeekReply::Ready { frames, engine } => {
                assert!(frames[0].pixels.is_empty());
                assert_eq!(engine, "");
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn failure_envelope_keeps_the_worker_reason_and_retry_law() {
        let out = outcome_from_envelope(&json!({
            "state": "failed",
            "error": { "reason": "gpu_refused", "message": "GPU busy", "retryable": true },
        }));
        match out {
            SeekReply::Unavailable { reason, message, retryable, .. } => {
                assert_eq!(reason, "gpu_refused");
                assert_eq!(message, "GPU busy");
                assert!(retryable);
            }
            other => panic!("expected unavailable, got {other:?}"),
        }
        // No error block: the state names itself, retryable stays false.
        match outcome_from_envelope(&json!({ "state": "timeout" })) {
            SeekReply::Unavailable { reason, message, retryable, .. } => {
                assert_eq!(reason, "internal");
                assert_eq!(message, "the visual seek job ended in state timeout");
                assert!(!retryable);
            }
            other => panic!("expected unavailable, got {other:?}"),
        }
    }
}
