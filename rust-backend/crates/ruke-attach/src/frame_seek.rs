//! F153 item 4 (2026-11-25) — the on-demand visual seek behind a
//! time-range follow-up. ⇔ `lib/server/attachindex/frame-seek.ts`.
//! "What was on screen at 02:10?" over a recording whose saved keyframes
//! do not reach that instant must get the PICTURE at that instant, a
//! MEASURED fact, or an honest named failure — never the golden sentence
//! "never captured" while the original sits on disk two directories away.
//! The law:
//!  - the asked cue moments (the router's own geometry, ≤ 4 of them, the
//!    same MAX_FRAMES budget a saved-frame turn serves) are the bound; each
//!    decodes ONE frame of the ORIGINAL through the video.frame_ocr
//!    capability with include_image — the worker's keyframe-accurate `-ss`
//!    seek, aligned to the media's own presentation timeline, never a
//!    re-digest of the video;
//!  - a configured text language rides the request (the F17 law: never
//!    defaulted); with no language configured the seek is pixels-only and
//!    the worker states on every frame that the text was NOT read — a color
//!    has no glyphs, so pixels must never be held hostage to an OCR
//!    language;
//!  - a delivered frame is durable: the picture becomes a saved frame
//!    (`store::append_frames`) so the next follow-up answers from the
//!    record and never re-decodes that instant, and recognised on-screen
//!    text becomes a timed searchable chunk (the F153 item-3 append law);
//!  - every non-delivery names its kind (no capability route, backend
//!    refusal, transport-bound omission, decode failure, out-of-range,
//!    cancelled, original gone) with the worker's own reason and whether it
//!    is retryable — a seek failure never voids the frames that DID arrive.
//!
//! DOCUMENTED DEVIATION: the TS owner wraps its runJob call in a try/catch
//! ("the decode call itself failed"); the Rust transport (ruke-server
//! `chat/frame_seek.rs`) is total — every transport fault resolves to an
//! [`SeekReply::Unavailable`] naming its kind — so that TS catch has no
//! Rust route, exactly as the fresh-audio mirror documents.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use tokio_util::sync::CancellationToken;

use crate::format::fmt_stamp;
use crate::store;
use crate::turn::b64_std;
use crate::types::LoadedIndex;
use crate::QueryEmbedder;

/// ⇔ `SEEK_MAX_CUES` / `MAX_FRAMES` (turn.ts, turn.rs): one turn shows at
/// most this many moments, so the seek decodes at most this many instants.
pub const SEEK_MAX_CUES: usize = 4;
/// Chat-time bound. ⇔ `SEEK_DEADLINE_MS` (90 s): half the upload-time
/// frame-OCR deadline — a follow-up is an interactive turn, and the ML job
/// clamps this into its own transport window. The worker bounds the PIXEL
/// budget itself (≤ 8 frames).
pub const SEEK_DEADLINE_S: u64 = 90;
/// ⇔ `FRAME_OCR_CAPABILITY` (timeline.ts).
pub const FRAME_OCR_CAPABILITY: &str = "video.frame_ocr";
/// ⇔ `FRAME_OCR_LANGUAGE_ENV` === `DOCUMENT_OCR_LANGUAGE_ENV`
/// (timeline.ts:92): the operator's switch, never a default.
pub const FRAME_OCR_LANGUAGE_ENV: &str = "RUKE_DOCUMENT_OCR_LANGUAGE";

/// One per-frame record as the worker's normalized contract reports it
/// (⇔ python `FrameReading.to_dict`, base64-decoded by the transport).
#[derive(Debug, Clone, Default)]
pub struct SeekedFrame {
    /// The media time this reading describes; non-finite/negative rows are
    /// no evidence and are dropped by the owner.
    pub time_s: f64,
    /// "recognised" | "pixels" | "duplicate" | "empty" carry pixels;
    /// "out_of_range" | "frame_failed" | "ocr_failed" | "skipped" |
    /// "not_run" name a per-instant failure.
    pub state: String,
    /// The worker's own detail (transport-bound omissions quote it).
    pub detail: String,
    /// Recognised on-screen text (meaningful only for "recognised").
    pub text: String,
    /// The delivered picture bytes; EMPTY = pixels not delivered (over the
    /// transport bound) — the omission names itself, the instant is NOT
    /// claimed durable.
    pub pixels: Vec<u8>,
    /// For "duplicate": the instant the byte-identical copy shows.
    pub copy_of_time: Option<f64>,
}

/// The seam's typed outcome — ⇔ the TS envelope resolved by the runJob
/// call, total by construction: every transport fault resolves to a
/// variant, the seam never throws.
#[derive(Debug, Clone)]
pub enum SeekReply {
    Ready {
        frames: Vec<SeekedFrame>,
        /// The recogniser that ran ("ocr.engine"); empty = no text pass.
        engine: String,
    },
    /// "ready" with NO per-frame records: success with nothing to credit.
    ContractMismatch,
    /// No capability route is wired in this deployment (⇔ envelope null).
    None,
    Unavailable {
        reason: String,
        message: String,
        human_step: String,
        retryable: bool,
    },
}

/// The injectable decode seam: ONE bounded `video.frame_ocr` job over
/// EXACTLY the handed instants. The BoxFuture shape (and the
/// canonicalize-then-clone-token discipline) follows
/// [`crate::audio_reread::FreshAsrInspector`].
pub trait FrameSeeker: Send + Sync {
    fn seek(
        &self,
        src: &Path,
        times: &[f64],
        duration: f64,
        language: &str,
        token: &CancellationToken,
    ) -> Pin<Box<dyn Future<Output = SeekReply> + Send + '_>>;
}

/// What this turn's seek produced: pixels delivered to THIS turn, the
/// per-instant evidence lines, the instants actually decoded (the
/// invocation proof) and the frames persisted to the record.
/// ⇔ TS `FrameSeekOutcome`.
#[derive(Debug, Clone, Default)]
pub struct FrameSeekOutcome {
    /// (data URL, asked instant) pairs aligned to the cue moments.
    pub images: Vec<(String, f64)>,
    pub lines: Vec<String>,
    pub spans: Vec<f64>,
    pub durable: usize,
}

/// ⇔ `seekFramesForCues`. Cancellation follows the reread durability law:
/// a cancelled turn writes NOTHING durable — a dead turn gets no picture
/// (it may be torn) and claims no spans, while the per-instant naming stays.
pub async fn seek_frames_for_cues(
    root: &Path,
    embedder: &dyn QueryEmbedder,
    seeker: &dyn FrameSeeker,
    att_id: &str,
    index: &LoadedIndex,
    cues: &[f64],
    token: &CancellationToken,
) -> FrameSeekOutcome {
    let mut out = FrameSeekOutcome::default();
    let dur = index.meta.duration_sec.unwrap_or(0.0);
    // ⇔ `[...new Set(cues.filter(c => Number.isFinite(c) && c >= 0))].slice(0, 4)`
    let mut moments: Vec<f64> = Vec::new();
    for c in cues {
        if c.is_finite() && *c >= 0.0 && !moments.contains(c) {
            moments.push(*c);
        }
        if moments.len() == SEEK_MAX_CUES {
            break;
        }
    }
    if moments.is_empty() {
        return out;
    }
    let asked = moments
        .iter()
        .map(|m| fmt_stamp(*m))
        .collect::<Vec<_>>()
        .join(", ");
    let src = store::upload_path(root, att_id);
    let Some(src) = src else {
        out.lines.push(format!(
            "[visual seek of {asked}: the original recording is no longer on disk, so these \
             moments cannot be decoded on demand. Everything the record DID capture is in the \
             saved frames.]"
        ));
        return out;
    };
    if token.is_cancelled() {
        out.lines.push(format!(
            "[visual seek of {asked}: the request was cancelled before any frame was decoded; \
             the moments stay unviewed and this is retryable: ask again.]"
        ));
        return out;
    }
    // The F17 law: the language is the operator's switch, never a default.
    // Empty = pixels-only (the worker states on every frame that text was not read).
    let language = std::env::var(FRAME_OCR_LANGUAGE_ENV)
        .unwrap_or_default()
        .trim()
        .to_string();

    let reply = seeker.seek(&src, &moments, dur, &language, token).await;
    let (frames, engine) = match reply {
        SeekReply::None => {
            out.lines.push(format!(
                "[visual seek of {asked}: this deployment has no capability route, so the frames \
                 behind these moments cannot be decoded on demand.]"
            ));
            return out;
        }
        SeekReply::ContractMismatch => {
            out.lines.push(format!(
                "[visual seek of {asked}: contract_mismatch: the seek reported success with no \
                 per-frame records, so nothing is credited and the moments stay unviewed.]"
            ));
            return out;
        }
        SeekReply::Unavailable {
            reason,
            message,
            human_step,
            retryable,
        } => {
            let retry = if retryable {
                "this is retryable: ask again".to_string()
            } else if !human_step.is_empty() {
                human_step
            } else {
                "not retryable".to_string()
            };
            out.lines.push(format!(
                "[visual seek of {asked}: {reason}: {message} — {retry}]"
            ));
            return out;
        }
        SeekReply::Ready { frames, engine } => (frames, engine),
    };
    let eng = if engine.is_empty() {
        String::new()
    } else {
        format!(" (recogniser {engine})")
    };

    let mut updates: Vec<store::SeekedFrameUpdate> = Vec::new();
    let mut read_text: Vec<(f64, String)> = Vec::new();
    for f in &frames {
        if !f.time_s.is_finite() || f.time_s < 0.0 {
            continue; // an unusable timestamp is no evidence in front of the model
        }
        if !moments.iter().any(|m| (m - f.time_s).abs() < 0.5) {
            continue; // only the asked instants
        }
        let stamp = fmt_stamp(f.time_s);
        let state = if f.state.is_empty() { "unknown" } else { f.state.as_str() };
        let detail = f.detail.as_str();
        let text = if state == "recognised" {
            f.text.trim().to_string()
        } else {
            String::new()
        };
        let read_states = matches!(state, "recognised" | "pixels" | "duplicate" | "empty");
        if !f.pixels.is_empty() && read_states {
            updates.push(store::SeekedFrameUpdate {
                at: f.time_s,
                bytes: f.pixels.clone(),
                state: state.to_string(),
            });
            out.images.push((
                format!("data:image/png;base64,{}", b64_std(&f.pixels)),
                f.time_s,
            ));
            out.spans.push(f.time_s);
            let scope = match state {
                "recognised" => format!(
                    "the recogniser read this on-screen text: \"{text}\"{eng}"
                ),
                "pixels" => "on-screen text was NOT read (no text language is configured), so the \
                            picture is the whole evidence"
                    .to_string(),
                "duplicate" => {
                    let copy = fmt_stamp(f.copy_of_time.unwrap_or(f.time_s));
                    let tail = if detail.contains("pixels omitted") {
                        format!("; {detail}")
                    } else {
                        String::new()
                    };
                    format!("the picture is byte-identical to the frame at {copy}{tail}")
                }
                _ => "the recogniser ran on this frame and found no glyphs".to_string(),
            };
            out.lines.push(format!(
                "[asked {stamp}: the seek decoded the frame at {stamp} from the original \
                 recording and delivered its pixels; {scope}]"
            ));
            if !text.is_empty() {
                read_text.push((f.time_s, text));
            }
            continue;
        }
        if read_states {
            // Decoded, pixels NOT delivered (over the transport bound): the
            // omission is the worker's own detail, never a silent gap. The
            // instant is NOT claimed durable — the next follow-up re-seeks.
            let omitted = if detail.is_empty() {
                "no pixels in the response"
            } else {
                detail
            };
            let read = if text.is_empty() {
                String::new()
            } else {
                format!("; the recogniser read: \"{text}\"")
            };
            out.lines.push(format!(
                "[asked {stamp}: the frame at {stamp} decoded but its pixels were not delivered \
                 ({omitted}){read} — the picture at that moment stays unviewed; this is \
                 retryable: ask again.]"
            ));
            if !text.is_empty() {
                read_text.push((f.time_s, text));
            }
            continue;
        }
        // out_of_range, frame_failed, ocr_failed, skipped, not_run: named per instant.
        let named = if detail.is_empty() {
            state.to_string()
        } else {
            format!("{state}: {detail}")
        };
        out.lines.push(format!(
            "[asked {stamp}: the frame at {stamp} was not decoded ({named}) — what is on screen \
             at that time was not seen this turn; this is retryable: ask again.]"
        ));
    }

    if token.is_cancelled() && (!updates.is_empty() || !out.images.is_empty()) {
        // Cancelled mid-seek: a dead turn gets nothing (the picture may be
        // torn, and a cancelled ask claims no spans). Keep the naming.
        out.lines.push(
            "[visual seek: the request was cancelled during the decode; the frames decoded so \
             far were not saved; this is retryable: ask again.]"
                .to_string(),
        );
        updates.clear();
        read_text.clear();
        out.images.clear();
        out.spans.clear();
    }

    if !updates.is_empty() {
        match store::append_frames(root, att_id, &updates) {
            Ok(n) => out.durable = n,
            Err(err) => out.lines.push(format!(
                "[visual seek: the decoded frame(s) could not be saved to the record ({err}) — \
                 this turn still shows them; a later follow-up may decode the same moment again.]"
            )),
        }
    }
    let chunks: Vec<store::TimedChunkUpdate> = read_text
        .into_iter()
        .map(|(at, text)| {
            let chunk_text = format!(
                "[on-screen text decoded at {} by on-demand visual seek]\n{text}",
                fmt_stamp(at)
            );
            // embed unavailable: lexical-only chunk — the words stay searchable.
            let vec = embedder.embed_one(&chunk_text, token).unwrap_or_default();
            store::TimedChunkUpdate {
                text: chunk_text,
                start_sec: at,
                end_sec: at,
                vec,
            }
        })
        .collect();
    if !chunks.is_empty() {
        // The words ride THIS turn's lines regardless; persistence is best
        // effort (the store writer degrades silently, ⇔ TS try/catch).
        store::append_timed_chunks(root, att_id, &chunks, &[]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEmbedder;
    use parking_lot::Mutex;
    use serde_json::{json, Value};

    /// Opaque picture bytes (durability never parses the PNG; the encode
    /// law itself is pinned by the turn.rs goldens).
    fn pix() -> Vec<u8> {
        b"PNGx".to_vec()
    }

    struct FakeSeeker {
        calls: Mutex<Vec<(Vec<f64>, f64, String)>>,
        reply: SeekReply,
        cancel_during: bool,
    }

    impl FakeSeeker {
        fn new(reply: SeekReply) -> Self {
            FakeSeeker { calls: Mutex::new(Vec::new()), reply, cancel_during: false }
        }
        fn cancelling(reply: SeekReply) -> Self {
            FakeSeeker { calls: Mutex::new(Vec::new()), reply, cancel_during: true }
        }
    }

    impl FrameSeeker for FakeSeeker {
        fn seek(
            &self,
            _src: &Path,
            times: &[f64],
            duration: f64,
            language: &str,
            token: &CancellationToken,
        ) -> Pin<Box<dyn Future<Output = SeekReply> + Send + '_>> {
            self.calls.lock().push((times.to_vec(), duration, language.to_string()));
            if self.cancel_during {
                token.cancel();
            }
            Box::pin(std::future::ready(self.reply.clone()))
        }
    }

    /// Seed one video attachment: meta (durationSec, saved frames), no
    /// chunks yet, and optionally the durable upload on disk.
    fn seed(root: &Path, att: &str, dur: f64, frames: Value, with_upload: bool) {
        let dir = store::index_dir(root, att).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let meta = json!({
            "attId": att, "name": "lecture.mp4", "category": "video", "createdAt": 0,
            "chunkCount": 0, "spine": "", "spineBlocks": [], "frames": frames,
            "durationSec": dur,
        });
        std::fs::write(dir.join("meta.json"), meta.to_string()).unwrap();
        // read_index requires the chunks file to exist (⇔ TS readFileSync).
        std::fs::write(dir.join("chunks.jsonl"), "").unwrap();
        if with_upload {
            let up = root.join(".data").join("uploads");
            std::fs::create_dir_all(&up).unwrap();
            std::fs::write(up.join(format!("{att}.mp4")), b"video bytes").unwrap();
        }
    }

    fn read_meta(root: &Path, att: &str) -> Value {
        let dir = store::index_dir(root, att).unwrap();
        serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap()
    }

    fn read_chunk_lines(root: &Path, att: &str) -> Vec<Value> {
        let dir = store::index_dir(root, att).unwrap();
        std::fs::read_to_string(dir.join("chunks.jsonl"))
            .unwrap_or_default()
            .split('\n')
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn ready(frames: Vec<SeekedFrame>, engine: &str) -> SeekReply {
        SeekReply::Ready { frames, engine: engine.to_string() }
    }

    #[tokio::test]
    async fn delivered_pixels_become_a_saved_frame_and_a_png_data_url() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_seek1", 3600.0, json!([]), true);
        let index = store::read_index(root, "att_seek1").unwrap();
        let seeker = FakeSeeker::new(ready(
            vec![SeekedFrame { time_s: 130.0, state: "pixels".into(), pixels: pix(), ..Default::default() }],
            "",
        ));
        let out = seek_frames_for_cues(root, &FixedEmbedder(vec![0.5, 0.25]), &seeker, "att_seek1", &index, &[130.0], &CancellationToken::new()).await;
        assert_eq!(out.durable, 1);
        let dir = store::index_dir(root, "att_seek1").unwrap();
        assert_eq!(std::fs::read(dir.join("frames/s_00000.png")).unwrap(), pix());
        let frames = read_meta(root, "att_seek1")["frames"].as_array().unwrap().clone();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["at"], json!(130.0));
        assert_eq!(frames[0]["file"], json!("frames/s_00000.png"));
        assert_eq!(frames[0]["state"], json!("pixels"));
        assert_eq!(out.images, vec![(format!("data:image/png;base64,{}", b64_std(&pix())), 130.0)]);
        assert_eq!(out.spans, vec![130.0]);
        let line = &out.lines[0];
        assert!(line.contains("[asked 00:02:10: the seek decoded the frame at 00:02:10 from the original recording and delivered its pixels"), "{line}");
        // The pixels-only scope of the F153 frame-OCR contract.
        assert!(line.contains("on-screen text was NOT read (no text language is configured)"), "{line}");
    }

    #[tokio::test]
    async fn recognised_text_becomes_a_timed_searchable_chunk() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_seek2", 3600.0, json!([]), true);
        let index = store::read_index(root, "att_seek2").unwrap();
        let seeker = FakeSeeker::new(ready(
            vec![SeekedFrame { time_s: 130.0, state: "recognised".into(), text: "  TOTAL 42 ".into(), pixels: pix(), ..Default::default() }],
            "tesseract-ocr",
        ));
        let out = seek_frames_for_cues(root, &FixedEmbedder(vec![0.5, 0.25]), &seeker, "att_seek2", &index, &[130.0], &CancellationToken::new()).await;
        assert!(out.lines[0].contains("the recogniser read this on-screen text: \"TOTAL 42\" (recogniser tesseract-ocr)"), "{}", out.lines[0]);
        let chunks = read_chunk_lines(root, "att_seek2");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0]["startSec"], json!(130.0));
        assert_eq!(chunks[0]["endSec"], json!(130.0));
        assert_eq!(chunks[0]["vec"], json!([0.5, 0.25]));
        let text = chunks[0]["text"].as_str().unwrap();
        assert!(text.starts_with("[on-screen text decoded at 00:02:10 by on-demand visual seek]\n"), "{text}");
        assert!(text.contains("TOTAL 42"), "{text}");
        assert_eq!(read_meta(root, "att_seek2")["chunkCount"], json!(1));
        assert_eq!(out.durable, 1);
    }

    #[tokio::test]
    async fn undelivered_pixels_name_the_omission_and_stay_unviewed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_seek3", 3600.0, json!([]), true);
        let index = store::read_index(root, "att_seek3").unwrap();
        let seeker = FakeSeeker::new(ready(
            vec![SeekedFrame {
                time_s: 130.0,
                state: "pixels".into(),
                detail: "pixels omitted: 4.1 MB over the transport bound".into(),
                ..Default::default()
            }],
            "",
        ));
        let out = seek_frames_for_cues(root, &FixedEmbedder(vec![0.5, 0.25]), &seeker, "att_seek3", &index, &[130.0], &CancellationToken::new()).await;
        // The instant is NOT claimed durable — the next follow-up re-seeks.
        assert!(out.images.is_empty());
        assert_eq!(out.durable, 0);
        assert!(out.spans.is_empty());
        assert!(read_meta(root, "att_seek3")["frames"].as_array().unwrap().is_empty());
        let line = &out.lines[0];
        assert!(line.contains("decoded but its pixels were not delivered (pixels omitted: 4.1 MB over the transport bound)"), "{line}");
        assert!(line.contains("stays unviewed; this is retryable: ask again."), "{line}");
    }

    #[tokio::test]
    async fn every_reply_kind_names_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_seek4", 3600.0, json!([]), true);
        let index = store::read_index(root, "att_seek4").unwrap();
        let embed = FixedEmbedder(vec![]);
        let token = CancellationToken::new();

        let s = FakeSeeker::new(SeekReply::None);
        let out = seek_frames_for_cues(root, &embed, &s, "att_seek4", &index, &[130.0], &token).await;
        assert!(out.lines[0].contains("no capability route"), "{}", out.lines[0]);

        let s = FakeSeeker::new(SeekReply::ContractMismatch);
        let out = seek_frames_for_cues(root, &embed, &s, "att_seek4", &index, &[130.0], &token).await;
        assert!(out.lines[0].contains("contract_mismatch: the seek reported success with no per-frame records"), "{}", out.lines[0]);

        let s = FakeSeeker::new(SeekReply::Unavailable {
            reason: "gpu_refused".into(),
            message: "GPU busy".into(),
            human_step: String::new(),
            retryable: true,
        });
        let out = seek_frames_for_cues(root, &embed, &s, "att_seek4", &index, &[130.0], &token).await;
        assert!(out.lines[0].contains("gpu_refused: GPU busy — this is retryable: ask again"), "{}", out.lines[0]);

        let s = FakeSeeker::new(SeekReply::Unavailable {
            reason: "original_gone".into(),
            message: "no file".into(),
            human_step: "re-upload the recording".into(),
            retryable: false,
        });
        let out = seek_frames_for_cues(root, &embed, &s, "att_seek4", &index, &[130.0], &token).await;
        assert!(out.lines[0].contains("original_gone: no file — re-upload the recording"), "{}", out.lines[0]);
        // No reply ever wrote to the record.
        assert!(read_meta(root, "att_seek4")["frames"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn per_frame_states_name_their_evidence() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_seek5", 3600.0, json!([]), true);
        let index = store::read_index(root, "att_seek5").unwrap();
        let s = FakeSeeker::new(ready(
            vec![
                SeekedFrame { time_s: 130.0, state: "duplicate".into(), pixels: pix(), copy_of_time: Some(40.0), ..Default::default() },
                SeekedFrame { time_s: 200.0, state: "empty".into(), pixels: pix(), ..Default::default() },
                SeekedFrame { time_s: 260.0, state: "frame_failed".into(), detail: "decode at 260 s failed".into(), ..Default::default() },
            ],
            "",
        ));
        let out = seek_frames_for_cues(root, &FixedEmbedder(vec![]), &s, "att_seek5", &index, &[130.0, 200.0, 260.0], &CancellationToken::new()).await;
        assert!(out.lines.iter().any(|l| l.contains("the picture is byte-identical to the frame at 00:00:40")), "{:?}", out.lines);
        assert!(out.lines.iter().any(|l| l.contains("the recogniser ran on this frame and found no glyphs")), "{:?}", out.lines);
        assert!(out.lines.iter().any(|l| l.contains("was not decoded (frame_failed: decode at 260 s failed) — what is on screen at that time was not seen this turn; this is retryable: ask again.")), "{:?}", out.lines);
        // A frame failure never voids the frames that DID arrive.
        assert_eq!(out.images.len(), 2);
        assert_eq!(out.durable, 2);
    }

    #[tokio::test]
    async fn unusable_timestamps_are_no_evidence() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_seek6", 3600.0, json!([]), true);
        let index = store::read_index(root, "att_seek6").unwrap();
        let s = FakeSeeker::new(ready(
            vec![
                SeekedFrame { time_s: -5.0, state: "pixels".into(), pixels: pix(), ..Default::default() },
                SeekedFrame { time_s: f64::NAN, state: "pixels".into(), pixels: pix(), ..Default::default() },
                SeekedFrame { time_s: 999.0, state: "pixels".into(), pixels: pix(), ..Default::default() }, // never asked
            ],
            "",
        ));
        let out = seek_frames_for_cues(root, &FixedEmbedder(vec![]), &s, "att_seek6", &index, &[130.0], &CancellationToken::new()).await;
        assert!(out.images.is_empty() && out.lines.is_empty() && out.spans.is_empty());
        assert_eq!(out.durable, 0);
        assert_eq!(s.calls.lock()[0].0, vec![130.0]);
    }

    #[tokio::test]
    async fn a_dead_turn_gets_nothing_durable() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_seek7", 3600.0, json!([]), true);
        let index = store::read_index(root, "att_seek7").unwrap();
        let s = FakeSeeker::cancelling(ready(
            vec![SeekedFrame { time_s: 130.0, state: "pixels".into(), pixels: pix(), ..Default::default() }],
            "",
        ));
        let out = seek_frames_for_cues(root, &FixedEmbedder(vec![]), &s, "att_seek7", &index, &[130.0], &CancellationToken::new()).await;
        // Cancelled mid-seek: nothing persists, nothing claims a span,
        // naming survives so the model can say WHY to the user.
        assert!(out.images.is_empty());
        assert!(out.spans.is_empty());
        assert_eq!(out.durable, 0);
        assert!(read_meta(root, "att_seek7")["frames"].as_array().unwrap().is_empty());
        let dir = store::index_dir(root, "att_seek7").unwrap();
        assert!(!dir.join("frames/s_00000.png").exists());
        assert!(out.lines.iter().any(|l| l.contains("cancelled during the decode; the frames decoded so far were not saved")), "{:?}", out.lines);
    }

    #[tokio::test]
    async fn cues_dedup_and_cap_at_the_frame_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_seek8", 3600.0, json!([]), true);
        let index = store::read_index(root, "att_seek8").unwrap();
        let s = FakeSeeker::new(ready(vec![], ""));
        let out = seek_frames_for_cues(
            root, &FixedEmbedder(vec![]), &s, "att_seek8", &index,
            &[10.0, 10.0, f64::NAN, -1.0, 20.0, 30.0, 40.0, 50.0, 60.0],
            &CancellationToken::new(),
        ).await;
        assert_eq!(s.calls.lock()[0].0, vec![10.0, 20.0, 30.0, 40.0]);
        assert_eq!(s.calls.lock()[0].1, 3600.0);
        assert!(out.lines.is_empty()); // empty ready rows: nothing per-instant to say
    }

    #[test]
    fn no_decode_without_cues_the_original_or_a_live_turn() {
        // Runs on a tiny current-thread runtime; the seeds are isolated.
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            let embed = FixedEmbedder(vec![]);

            // No cues: the seam is never contacted.
            seed(root, "att_seek9", 3600.0, json!([]), true);
            let index = store::read_index(root, "att_seek9").unwrap();
            let s = FakeSeeker::new(SeekReply::None);
            let out = seek_frames_for_cues(root, &embed, &s, "att_seek9", &index, &[], &CancellationToken::new()).await;
            assert!(out.lines.is_empty() && s.calls.lock().is_empty());

            // Original gone: named before any decode, seam never contacted.
            seed(root, "att_seek10", 3600.0, json!([]), false);
            let index = store::read_index(root, "att_seek10").unwrap();
            let out = seek_frames_for_cues(root, &embed, &s, "att_seek10", &index, &[130.0], &CancellationToken::new()).await;
            assert!(out.lines[0].contains("the original recording is no longer on disk"), "{}", out.lines[0]);
            assert!(s.calls.lock().is_empty());

            // Pre-cancelled: retryable naming, seam never contacted.
            let token = CancellationToken::new();
            token.cancel();
            let out = seek_frames_for_cues(root, &embed, &s, "att_seek9", &index, &[130.0], &token).await;
            assert!(out.lines[0].contains("cancelled before any frame was decoded"), "{}", out.lines[0]);
            assert!(s.calls.lock().is_empty());
        });
    }

    #[tokio::test]
    async fn the_language_is_the_operators_switch_never_a_default() {
        // Env is process-global; cargo runs tests on threads, so the set /
        // remove window is serialized (no other test asserts on language).
        static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_seek11", 600.0, json!([]), true);
        let index = store::read_index(root, "att_seek11").unwrap();
        let embed = FixedEmbedder(vec![]);

        std::env::set_var(FRAME_OCR_LANGUAGE_ENV, " en ");
        let s = FakeSeeker::new(SeekReply::None);
        seek_frames_for_cues(root, &embed, &s, "att_seek11", &index, &[130.0], &CancellationToken::new()).await;
        assert_eq!(s.calls.lock()[0].2, "en");

        std::env::remove_var(FRAME_OCR_LANGUAGE_ENV);
        let s = FakeSeeker::new(SeekReply::None);
        seek_frames_for_cues(root, &embed, &s, "att_seek11", &index, &[130.0], &CancellationToken::new()).await;
        assert_eq!(s.calls.lock()[0].2, "", "no language configured is the legal pixels-only mode");
    }
}
