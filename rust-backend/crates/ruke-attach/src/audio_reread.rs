//! F153 item 3 (2026-11-25) — the bounded fresh audio read behind a
//! time-range follow-up. ⇔ `lib/server/attachindex/audio-reread.ts`; the
//! law lives there, this is the mirror for the route Rust owns. "What did
//! she say around 58:40?" over an hour of audio must get an ANSWER, a
//! MEASURED fact, or an honest failure — never silence, and never a
//! re-digest of the whole recording:
//!  - the routed cue window ([cue±180 s, clipped to the duration) is the
//!    bound; never the whole file;
//!  - a window the durable record already covers (meta.speech.examined, or
//!    a timed chunk) is NEVER re-decoded — the record (and the Python span
//!    cache keyed on source bytes + interval + engine settings) is the
//!    authority;
//!  - a fully-decoded recording (speech.complete) answers a timed gap as a
//!    MEASURED absence; a window inside a PARTIAL decode's examined span
//!    says what really covers it — never an end-to-end decode that did not
//!    happen;
//!  - an unexamined window schedules ONE bounded decode of the ORIGINAL
//!    through the selected-engine path;
//!  - a completed decode is durable: the timed passage becomes a searchable
//!    chunk and the window merges into meta.speech.examined (store.rs), so
//!    adjacent follow-ups continue across the boundary and a timeout keeps
//!    every interval it finished;
//!  - every failure names its kind with the worker's own reason and whether
//!    it is retryable — "no speech found" and "this window was never
//!    listened to" are different sentences.
//!
//! The transcribe seam is injectable so the acceptance fixtures can force
//! each failure deterministically (the [`crate::reread::RegionInspector`]
//! precedent, including its BoxFuture shape and its never-throws law: a
//! transport fault resolves to a typed [`FreshResult::Unavailable`] instead
//! of the TS seam throwing — same honest line, documented deviation).

use std::future::Future;
use std::pin::Pin;
use std::path::Path;

use tokio_util::sync::CancellationToken;

use crate::format::fmt_stamp;
use crate::store;
use crate::types::LoadedIndex;
use crate::QueryEmbedder;

/// The router's cue geometry (⇔ `FRESH_ASR_WINDOW_SEC`, router.ts
/// [c-180, c+180]); one law, not a copy that can drift.
pub const FRESH_ASR_WINDOW_SEC: f64 = 180.0;
/// Per-ask decode bound: a multi-cue question decodes at most this many windows.
const MAX_FRESH_WINDOWS: usize = 3;
/// Sub-windows decoded per cue at most (continuation covers the rest on the next ask).
const MAX_SUB_WINDOWS: usize = 2;
/// Span tolerance shared with the store's merge/gap law.
const SPAN_EPS: f64 = 0.001;

/// One timed segment as the worker's normalized contract reports it.
#[derive(Debug, Clone)]
pub struct FreshAsrSegment {
    pub start: f64,
    pub end: Option<f64>,
    pub text: String,
}

/// The seam's typed outcome — ⇔ TS `AsrOutcome`, total by construction:
/// every transport fault resolves to a variant, the seam never throws.
#[derive(Debug, Clone)]
pub enum FreshResult {
    Ready {
        text: String,
        segments: Vec<FreshAsrSegment>,
        model: String,
        device: String,
        segment_count: i64,
        capped_segments: i64,
    },
    Silence {
        max_volume_db: Option<f64>,
    },
    /// No speech backend is configured in this deployment (⇔ state "none").
    None,
    Unavailable {
        reason: String,
        message: String,
        human_step: String,
        retryable: bool,
    },
}

/// The injectable transcribe seam: one bounded decode of `src` over
/// [start_sec, end_sec]. The BoxFuture shape (and the canonicalize-then-
/// clone-token discipline) follows [`crate::reread::RegionInspector`].
pub trait FreshAsrInspector: Send + Sync {
    fn transcribe(
        &self,
        src: &Path,
        start_sec: f64,
        end_sec: f64,
        token: &CancellationToken,
    ) -> Pin<Box<dyn Future<Output = FreshResult> + Send + '_>>;
}

/// What this turn's fresh read produced: per-window evidence lines and the
/// windows the decode ACTUALLY covered — the invocation proof.
#[derive(Debug, Clone, Default)]
pub struct FreshAsrOutcome {
    pub lines: Vec<String>,
    pub spans: Vec<[f64; 2]>,
}

/// Merge overlapping/adjacent spans into a sorted disjoint list (⇔ TS
/// `mergeSpans`; the store carries the same private law for the durable
/// merge, exactly as TS keeps its own copy).
fn merge_spans(spans: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut sorted: Vec<[f64; 2]> = spans
        .iter()
        .filter(|s| s[0].is_finite() && s[1].is_finite() && s[1] > s[0])
        .copied()
        .collect();
    sorted.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<[f64; 2]> = Vec::new();
    for s in sorted {
        match out.last_mut() {
            Some(last) if s[0] <= last[1] + SPAN_EPS => last[1] = last[1].max(s[1]),
            _ => out.push(s),
        }
    }
    out
}

/// win minus spans: the parts of the window the record has NOT listened to.
pub fn subtract_spans(win: [f64; 2], spans: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let merged = merge_spans(spans);
    let mut out: Vec<[f64; 2]> = Vec::new();
    let mut cursor = win[0];
    for &[lo, hi] in &merged {
        if hi <= cursor + SPAN_EPS {
            continue;
        }
        if lo > cursor + SPAN_EPS {
            out.push([win[0].max(cursor), win[1].min(lo)]);
        }
        cursor = cursor.max(hi);
        if cursor >= win[1] {
            break;
        }
    }
    if win[1] - cursor > SPAN_EPS {
        out.push([win[0].max(cursor), win[1]]);
    }
    out.into_iter().filter(|s| s[1] > s[0]).collect()
}

/// The cue window, clipped to the recording — the router's geometry exactly.
pub fn window_for_cue(cue: f64, dur: f64) -> Option<[f64; 2]> {
    let lo = (cue - FRESH_ASR_WINDOW_SEC).max(0.0);
    let hi = dur.min(cue + FRESH_ASR_WINDOW_SEC);
    if hi > lo {
        Some([lo, hi])
    } else {
        None
    }
}

/// Timed spans the searchable record already carries (a point chunk keeps
/// width — the same 0.5 s floor TS `chunkSpans` applies).
fn chunk_spans(index: &LoadedIndex) -> Vec<[f64; 2]> {
    index
        .chunks
        .iter()
        .filter(|c| c.start_sec.is_some())
        .map(|c| {
            let s = c.start_sec.unwrap_or(0.0);
            [s, (c.end_sec.unwrap_or(s)).max(s + 0.5)]
        })
        .collect()
}

/// What the record says about one asked moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FreshPlanKind {
    /// Un-listened sub-windows exist: ONE bounded decode is scheduled.
    Read,
    /// The record listened through this window and its transcript carries
    /// NO passage — a measured absence.
    Decoded,
    /// A timed passage inside the window is searchable through retrieval.
    Covered,
}

#[derive(Debug, Clone)]
pub struct FreshAsrPlan {
    pub cue: f64,
    pub win: [f64; 2],
    pub kind: FreshPlanKind,
    /// Un-listened sub-windows of `win` (non-empty only for [`FreshPlanKind::Read`]).
    pub need: Vec<[f64; 2]>,
}

/// The pure decision, deterministic and content-free (meta + chunks only):
/// for each asked moment, is the window covered by the searchable record,
/// measured-and-silent by a complete decode, or unexamined (fresh read)?
pub fn plan_fresh_windows(cues: &[f64], index: &LoadedIndex) -> Vec<FreshAsrPlan> {
    let dur = index.meta.duration_sec.unwrap_or(0.0);
    if !(dur > 0.0) {
        return Vec::new();
    }
    let speech = index.meta.speech.clone();
    let spans = chunk_spans(index);
    let mut sorted_cues: Vec<f64> = cues.to_vec();
    sorted_cues.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<FreshAsrPlan> = Vec::new();
    for cue in sorted_cues.into_iter().take(MAX_FRESH_WINDOWS) {
        let Some(win) = window_for_cue(cue, dur) else {
            continue;
        };
        let overlap = spans.iter().any(|s| s[0] < win[1] && s[1] > win[0]);
        if speech.as_ref().is_some_and(|s| s.complete) {
            let kind = if overlap { FreshPlanKind::Covered } else { FreshPlanKind::Decoded };
            out.push(FreshAsrPlan { cue, win, kind, need: Vec::new() });
            continue;
        }
        let examined: Vec<[f64; 2]> = match &speech {
            Some(s) => s.examined.clone(),
            None => spans.clone(),
        };
        let need = subtract_spans(win, &merge_spans(&examined));
        let kind = if !need.is_empty() {
            FreshPlanKind::Read
        } else if overlap {
            FreshPlanKind::Covered
        } else {
            FreshPlanKind::Decoded
        };
        out.push(FreshAsrPlan { cue, win, kind, need });
    }
    out
}

/// One timed line, the citation form every per-turn rule knows.
fn timed_line(text: &str, start: f64, end: Option<f64>) -> String {
    format!("[{} - {}] {}", fmt_stamp(start), fmt_stamp(end.unwrap_or(start)), text.trim())
}

/// The reader behind `build_attachment_turn`'s fresh-audio block (⇔
/// `freshAsrForWindows`). Cancellation follows the reread durability law:
/// a cancelled turn writes NOTHING durable — the intervals a finished
/// decode produced ride this turn's lines only.
pub async fn fresh_asr_for_windows(
    root: &Path,
    embedder: &dyn QueryEmbedder,
    inspector: &dyn FreshAsrInspector,
    att_id: &str,
    index: &LoadedIndex,
    cues: &[f64],
    token: &CancellationToken,
) -> FreshAsrOutcome {
    let plan = plan_fresh_windows(cues, index);
    if plan.is_empty() {
        return FreshAsrOutcome::default();
    }
    let src = store::upload_path(root, att_id);
    let mut lines: Vec<String> = Vec::new();
    let mut spans: Vec<[f64; 2]> = Vec::new();
    let mut updates: Vec<store::TimedChunkUpdate> = Vec::new();

    for p in &plan {
        let [lo, hi] = p.win;
        let span_txt = format!("{}–{}", fmt_stamp(lo), fmt_stamp(hi));
        let cue_s = fmt_stamp(p.cue);
        match p.kind {
            FreshPlanKind::Decoded => {
                // Honest scope: only a COMPLETE decode says "end-to-end"; a
                // window inside a PARTIAL decode's examined coverage says
                // what really covers it.
                let why = if index.meta.speech.as_ref().is_some_and(|s| s.complete) {
                    "this recording was decoded end-to-end when it was indexed"
                } else {
                    "this window lies inside the span the record has already decoded"
                };
                lines.push(format!(
                    "[around {cue_s}: {why}. The timed transcript carries NO speech in {span_txt} — \
                     the engine listened there and found no words, so the absence of speech in that \
                     window is MEASURED, not an unexamined gap.]"
                ));
            }
            FreshPlanKind::Covered => {
                lines.push(format!(
                    "[around {cue_s}: the saved timed transcript covers {span_txt}; its passages are \
                     searchable — ask the question and they are retrieved.]"
                ));
            }
            FreshPlanKind::Read => {
                for sub in p.need.iter().take(MAX_SUB_WINDOWS) {
                    let (s_lo, s_hi) = (sub[0], sub[1]);
                    let sub_txt = format!("{}–{}", fmt_stamp(s_lo), fmt_stamp(s_hi));
                    let Some(path) = &src else {
                        lines.push(format!(
                            "[fresh read of {sub_txt} (around {cue_s}): the original recording is no \
                             longer on disk, so this unexamined window cannot be decoded. Everything \
                             the recording DID yield is in the saved record.]"
                        ));
                        continue;
                    };
                    let out = inspector.transcribe(path, s_lo, s_hi, token).await;
                    match out {
                        FreshResult::Ready {
                            text,
                            segments,
                            model,
                            device,
                            segment_count,
                            capped_segments,
                        } => {
                            let eng = format!(
                                "{}{}",
                                if model.is_empty() { "the selected engine".to_string() } else { model.clone() },
                                if device.is_empty() { String::new() } else { format!(" on {device}") },
                            );
                            let body = {
                                let ls: Vec<String> = segments
                                    .iter()
                                    .filter(|s| !s.text.trim().is_empty())
                                    .map(|s| timed_line(&s.text, s.start, s.end))
                                    .collect();
                                let joined = ls.join("\n");
                                if joined.is_empty() { text.clone() } else { joined }
                            };
                            lines.push(format!(
                                "[fresh decode of {sub_txt} around {cue_s} on this turn's request ({eng}):\n{body}]"
                            ));
                            if capped_segments > 0 {
                                lines.push(format!(
                                    "[decode cap: {segment_count} segments produced and {capped_segments} middle \
                                     segment(s) exceeded the delivery window — the full timed decode was indexed.]"
                                ));
                            }
                            let chunk_text = format!("[fresh decode {sub_txt} by {eng}]\n{body}");
                            let vec = embedder.embed_one(&chunk_text, token).unwrap_or_default();
                            updates.push(store::TimedChunkUpdate {
                                text: chunk_text,
                                start_sec: s_lo,
                                end_sec: s_hi,
                                vec,
                            });
                            spans.push([s_lo, s_hi]);
                        }
                        FreshResult::Silence { max_volume_db } => {
                            // The silence verdict is durable: never re-decode
                            // this span.
                            let measured = match max_volume_db {
                                Some(v) => format!("decoded and measured at {v:.1} dBFS peak, at or below the noise floor"),
                                None => "decoded with no speech detected".to_string(),
                            };
                            lines.push(format!(
                                "[fresh decode of {sub_txt} around {cue_s}: the window was {measured}. \
                                 No speech exists in that window — a MEASURED fact, not an unexamined gap.]"
                            ));
                            spans.push([s_lo, s_hi]);
                        }
                        FreshResult::Unavailable { reason, message, human_step, retryable } => {
                            let tail = if retryable {
                                "this is retryable: ask again".to_string()
                            } else if !human_step.is_empty() {
                                human_step
                            } else {
                                "not retryable".to_string()
                            };
                            let msg = if message.is_empty() { String::new() } else { format!(" ({message})") };
                            lines.push(format!(
                                "[fresh decode of {sub_txt} around {cue_s} produced no speech: reason \
                                 {reason}{msg} — {tail}.]"
                            ));
                        }
                        FreshResult::None => {
                            lines.push(format!(
                                "[no speech backend is configured in this deployment, so {sub_txt} \
                                 (around {cue_s}) cannot be decoded on demand.]"
                            ));
                        }
                    }
                }
            }
        }
    }

    if (!updates.is_empty() || !spans.is_empty()) && !token.is_cancelled() {
        store::append_timed_chunks(root, att_id, &updates, &spans);
    }
    FreshAsrOutcome { lines, spans }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEmbedder;
    use parking_lot::Mutex;
    use serde_json::json;
    use std::path::PathBuf;

    const FACT: &str = "she names the closing sponsor VOLTAGE-240";

    /// The frozen TS spec's cue: "around 58:40" over a one-hour recording.
    const CUE: f64 = 3520.0;

    struct MockReader {
        calls: Mutex<Vec<(f64, f64)>>,
        scripted: Mutex<Vec<FreshResult>>,
    }

    impl MockReader {
        fn new(scripted: Vec<FreshResult>) -> Self {
            MockReader { calls: Mutex::new(Vec::new()), scripted: Mutex::new(scripted) }
        }
    }

    impl FreshAsrInspector for MockReader {
        fn transcribe(
            &self,
            _src: &Path,
            start_sec: f64,
            end_sec: f64,
            _token: &CancellationToken,
        ) -> Pin<Box<dyn Future<Output = FreshResult> + Send + '_>> {
            Box::pin(async move {
                self.calls.lock().push((start_sec, end_sec));
                let mut scripted = self.scripted.lock();
                if scripted.is_empty() {
                    panic!("fresh-asr seam over-consumed");
                }
                scripted.remove(0)
            })
        }
    }

    fn ready(text: &str) -> FreshResult {
        FreshResult::Ready {
            text: text.to_string(),
            segments: vec![FreshAsrSegment { start: 3541.0, end: Some(3547.0), text: text.to_string() }],
            model: "parakeet".into(),
            device: "cuda".into(),
            segment_count: 1,
            capped_segments: 0,
        }
    }

    /// Seed one audio attachment: meta (durationSec + optional speech
    /// coverage), one timed chunk far from the cue, and optionally the
    /// durable upload — the frozen TS spec's shape.
    fn seed(root: &Path, att: &str, dur: f64, speech: Option<serde_json::Value>, with_upload: bool) {
        let dir = crate::store::index_dir(root, att).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let mut meta = json!({
            "attId": att, "name": "podcast.mp3", "category": "audio", "createdAt": 0,
            "chunkCount": 1, "spine": "", "spineBlocks": [], "frames": [],
            "durationSec": dur,
        });
        if let Some(s) = speech {
            meta["speech"] = s;
        }
        std::fs::write(dir.join("meta.json"), meta.to_string()).unwrap();
        let line = json!({
            "i": 0, "startSec": 300.0, "endSec": 600.0, "vec": [0.5, 0.25],
            "text": "the opening segment: the host introduces the season finale lineup",
        });
        std::fs::write(dir.join("chunks.jsonl"), format!("{}\n", line)).unwrap();
        if with_upload {
            let up = root.join(".data").join("uploads");
            std::fs::create_dir_all(&up).unwrap();
            std::fs::write(up.join(format!("{att}.mp3")), b"audio bytes").unwrap();
        }
    }

    fn read_meta(root: &Path, att: &str) -> serde_json::Value {
        let dir: PathBuf = crate::store::index_dir(root, att).unwrap();
        serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap()
    }

    fn read_chunk_lines(root: &Path, att: &str) -> Vec<serde_json::Value> {
        let dir: PathBuf = crate::store::index_dir(root, att).unwrap();
        std::fs::read_to_string(dir.join("chunks.jsonl"))
            .unwrap()
            .split('\n')
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    // ---- pure geometry law (⇔ the frozen TS spec's table) ----

    #[test]
    fn window_for_cue_clips_to_the_recording() {
        assert_eq!(window_for_cue(3520.0, 3600.0), Some([3340.0, 3600.0]));
        assert_eq!(window_for_cue(45.0, 3600.0), Some([0.0, 225.0]));
        assert_eq!(window_for_cue(3540.0, 3600.0), Some([3360.0, 3600.0]));
        assert_eq!(window_for_cue(5940.0, 3600.0), None); // cue past the end
        assert_eq!(window_for_cue(10.0, 15.0), Some([0.0, 15.0]));
    }

    #[test]
    fn subtract_spans_is_exact_at_the_edges() {
        // A cue whose window starts exactly at an examined edge must decode
        // the WHOLE window (adjacent coverage does not extend inward).
        assert_eq!(
            subtract_spans([3700.0, 4060.0], &merge_spans(&[[3340.0, 3700.0]])),
            vec![[3700.0, 4060.0]]
        );
        assert_eq!(subtract_spans([3340.0, 3600.0], &[[3340.0, 3600.0]]), Vec::<[f64; 2]>::new());
        assert_eq!(
            subtract_spans([3340.0, 3600.0], &[[3400.0, 3500.0]]),
            vec![[3340.0, 3400.0], [3500.0, 3600.0]]
        );
    }

    #[test]
    fn plan_reads_covers_and_measured_absences() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_fplan", 4200.0, None, true);
        let index = crate::store::read_index(root, "att_fplan").unwrap();
        // Unexamined cue → one read over the whole window. dur is 4200 here,
        // so the [cue±180] window is NOT edge-clipped (the TS spec's
        // [3340,3600] clip only exists for a 3600 s recording).
        let p = &plan_fresh_windows(&[CUE], &index)[0];
        assert_eq!(p.kind, FreshPlanKind::Read);
        assert_eq!(p.need, vec![[3340.0, 3700.0]]);
        // ⇔ TS planFreshWindows:127 — need (window minus merged examined)
        // decides first: a chunk that covers only the MIDDLE of a window is
        // a READ of the uncovered edges, never a free "covered".
        let p = &plan_fresh_windows(&[450.0], &index)[0];
        assert_eq!(p.kind, FreshPlanKind::Read);
        assert_eq!(p.need, vec![[270.0, 300.0], [600.0, 630.0]]);
        // Full examined coverage + a timed chunk in the window → covered:
        // searchable from the record, zero decodes.
        seed(
            root,
            "att_fplan3",
            4200.0,
            Some(json!({"durationSec": 4200.0, "complete": false,
                        "examined": [[270.0, 630.0]],
                        "unexamined": [[0.0, 270.0], [630.0, 4200.0]]})),
            true,
        );
        let index3 = crate::store::read_index(root, "att_fplan3").unwrap();
        let p = &plan_fresh_windows(&[450.0], &index3)[0];
        assert_eq!(p.kind, FreshPlanKind::Covered);
        assert!(p.need.is_empty());
        // Complete decode → a timed gap is a measured absence.
        seed(
            root,
            "att_fplan2",
            3600.0,
            Some(json!({"durationSec": 3600.0, "complete": true, "examined": [[0.0, 3600.0]], "unexamined": []})),
            true,
        );
        let index2 = crate::store::read_index(root, "att_fplan2").unwrap();
        assert_eq!(plan_fresh_windows(&[CUE], &index2)[0].kind, FreshPlanKind::Decoded);
        // Empty cue list / zero duration plan nothing.
        assert!(plan_fresh_windows(&[], &index).is_empty());
    }

    // ---- flow law: every outcome names what ran and what it proved ----

    #[tokio::test]
    async fn unexamined_window_runs_one_bounded_decode_and_persists_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_fresh1", 3600.0, None, true);
        let reader = MockReader::new(vec![ready(FACT)]);
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_fresh1").unwrap();
        let out = fresh_asr_for_windows(root, &embed, &reader, "att_fresh1", &index, &[CUE], &token).await;

        // ONE bounded decode of the ORIGINAL, exactly the clipped cue window.
        assert_eq!(reader.calls.lock().clone(), vec![(3340.0, 3600.0)]);
        let joined = out.lines.join("\n");
        assert!(joined.contains(&format!("fresh decode of 00:55:40–01:00:00 around {}", fmt_stamp(CUE))));
        assert!(joined.contains("(parakeet on cuda)"));
        assert!(joined.contains(&format!("[00:59:01 - 00:59:07] {FACT}")));
        assert_eq!(out.spans, vec![[3340.0, 3600.0]]);

        // Durable: the timed passage is a searchable chunk (next id, real
        // bounds) and the window merges into meta.speech.
        let chunks = read_chunk_lines(root, "att_fresh1");
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[1]["i"], json!(1));
        assert_eq!(chunks[1]["startSec"], json!(3340.0));
        assert_eq!(chunks[1]["endSec"], json!(3600.0));
        let m = read_meta(root, "att_fresh1");
        assert_eq!(
            m["speech"],
            json!({"durationSec": 3600.0, "examined": [[3340.0, 3600.0]],
                   "unexamined": [[0.0, 3340.0]], "complete": false})
        );
        assert_eq!(m["chunkCount"], json!(2));
    }

    #[tokio::test]
    async fn adjacent_followups_continue_across_the_covered_edge() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_fresh2", 4200.0, None, true);
        let reader = MockReader::new(vec![
            ready("the 59-minute sponsor read"),
            ready("the 68-minute sign-off"),
        ]);
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_fresh2").unwrap();
        let a = fresh_asr_for_windows(root, &embed, &reader, "att_fresh2", &index, &[CUE], &token).await;
        assert_eq!(reader.calls.lock().len(), 1);
        assert_eq!(a.spans, vec![[3340.0, 3700.0]]);
        // The next ask sits fully past the covered edge: the fresh reader
        // reads ONLY the remainder window — continuation, no re-decode.
        let index1 = crate::store::read_index(root, "att_fresh2").unwrap();
        let b = fresh_asr_for_windows(root, &embed, &reader, "att_fresh2", &index1, &[4060.0], &token).await;
        assert_eq!(reader.calls.lock().clone(), vec![(3340.0, 3700.0), (3880.0, 4200.0)]);
        assert_eq!(b.spans, vec![[3880.0, 4200.0]]);
        let m = read_meta(root, "att_fresh2");
        assert_eq!(
            m["speech"],
            json!({"durationSec": 4200.0, "examined": [[3340.0, 3700.0], [3880.0, 4200.0]],
                   "unexamined": [[0.0, 3340.0], [3700.0, 3880.0]], "complete": false})
        );
        assert_eq!(read_chunk_lines(root, "att_fresh2").len(), 3);
    }

    #[tokio::test]
    async fn partial_decode_coverage_never_claims_an_end_to_end_decode() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(
            root,
            "att_fr1b",
            3600.0,
            Some(json!({"durationSec": 3600.0, "complete": false, "examined": [[3340.0, 3600.0]],
                        "unexamined": [[0.0, 3340.0]]})),
            true,
        );
        let reader = MockReader::new(vec![]);
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_fr1b").unwrap();
        let out = fresh_asr_for_windows(root, &embed, &reader, "att_fr1b", &index, &[CUE], &token).await;
        assert!(reader.calls.lock().is_empty()); // covered span: never re-decoded
        let joined = out.lines.join("\n");
        assert!(joined.contains("this window lies inside the span the record has already decoded"));
        assert!(joined.contains("MEASURED, not an unexamined gap"));
        assert!(!joined.contains("decoded end-to-end"));
    }

    #[tokio::test]
    async fn complete_decode_states_the_measured_absence() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(
            root,
            "att_fresh3",
            3600.0,
            Some(json!({"durationSec": 3600.0, "complete": true, "examined": [[0.0, 3600.0]], "unexamined": []})),
            true,
        );
        let reader = MockReader::new(vec![]);
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_fresh3").unwrap();
        let out = fresh_asr_for_windows(root, &embed, &reader, "att_fresh3", &index, &[CUE], &token).await;
        assert!(reader.calls.lock().is_empty());
        let joined = out.lines.join("\n");
        assert!(joined.contains("decoded end-to-end when it was indexed"));
        assert!(joined.contains("MEASURED, not an unexamined gap"));
    }

    #[tokio::test]
    async fn silence_is_a_measured_fact_and_durable() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_fresh4", 3600.0, None, true);
        let reader = MockReader::new(vec![FreshResult::Silence { max_volume_db: Some(-95.2) }]);
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_fresh4").unwrap();
        let out = fresh_asr_for_windows(root, &embed, &reader, "att_fresh4", &index, &[CUE], &token).await;
        assert_eq!(reader.calls.lock().len(), 1);
        let joined = out.lines.join("\n");
        assert!(joined.contains("-95.2 dBFS peak"));
        assert!(joined.contains("a MEASURED fact, not an unexamined gap"));
        // The span is durable; no passage exists, so no chunk is added.
        assert_eq!(out.spans, vec![[3340.0, 3600.0]]);
        assert_eq!(read_chunk_lines(root, "att_fresh4").len(), 1);
        let m = read_meta(root, "att_fresh4");
        assert_eq!(m["speech"]["examined"], json!([[3340.0, 3600.0]]));
    }

    #[tokio::test]
    async fn every_failure_names_its_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // GPU refusal: the worker's own reason, retryable.
        seed(root, "att_fresh5", 3600.0, None, true);
        let reader = MockReader::new(vec![FreshResult::Unavailable {
            reason: "gpu_refused".into(),
            message: "GPU busy".into(),
            human_step: "".into(),
            retryable: true,
        }]);
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_fresh5").unwrap();
        let out = fresh_asr_for_windows(root, &embed, &reader, "att_fresh5", &index, &[CUE], &token).await;
        let joined = out.lines.join("\n");
        assert!(joined.contains("reason gpu_refused (GPU busy)"));
        assert!(joined.contains("this is retryable: ask again"));
        assert_eq!(out.spans, Vec::<[f64; 2]>::new());
        assert_eq!(out.lines.len(), 1);
        assert!(read_meta(root, "att_fresh5").get("speech").is_none()); // failed window stays unexamined

        // No backend configured.
        seed(root, "att_fresh6", 3600.0, None, true);
        let reader = MockReader::new(vec![FreshResult::None]);
        let index = crate::store::read_index(root, "att_fresh6").unwrap();
        let out = fresh_asr_for_windows(root, &embed, &reader, "att_fresh6", &index, &[CUE], &token).await;
        assert!(out.lines.join("\n").contains("no speech backend is configured in this deployment"));

        // Original gone: the window cannot be decoded, the seam never runs.
        seed(root, "att_fresh7", 3600.0, None, false);
        let reader = MockReader::new(vec![]);
        let index = crate::store::read_index(root, "att_fresh7").unwrap();
        let out = fresh_asr_for_windows(root, &embed, &reader, "att_fresh7", &index, &[CUE], &token).await;
        assert!(reader.calls.lock().is_empty());
        assert!(out.lines.join("\n").contains("the original recording is no longer on disk"));
    }

    #[tokio::test]
    async fn cancelled_turn_writes_nothing_durable() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed(root, "att_freshc", 3600.0, None, true);
        let reader = MockReader::new(vec![ready(FACT)]);
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        token.cancel();
        let index = crate::store::read_index(root, "att_freshc").unwrap();
        let out = fresh_asr_for_windows(root, &embed, &reader, "att_freshc", &index, &[CUE], &token).await;
        // The decode ran (mock answers); the finished work is NOT persisted
        // on a cancelled turn (reread.rs durability law).
        assert_eq!(out.spans, vec![[3340.0, 3600.0]]);
        assert_eq!(read_chunk_lines(root, "att_freshc").len(), 1);
        assert!(read_meta(root, "att_freshc").get("speech").is_none());
    }
}
