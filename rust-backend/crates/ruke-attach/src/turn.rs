//! `lib/server/attachindex/turn.ts` — the per-turn evidence injection.
//!
//! The `attachment_ref` parts in the client history are resolved to refs,
//! the CURRENT question is anchored + routed, evidence is retrieved, and
//! the whole turn is assembled as ONE ephemeral system block (plus nearest
//! keyframes appended to the user turn) in the request-payload copy only —
//! the stored conversation never sees any of it.
//!
//! `stripAttachmentRefs` is NOT duplicated here: Part 4 froze a single
//! shared implementation in `ruke-server::chat::attach`, and every path
//! must reuse it.
//!
//! Deviations (all documented, none observable in supported configs):
//! - `queryVec` comes from the [`crate::QueryEmbedder`] seam instead of
//!   `embedOne` (Part 8 owns embeddings). `UnavailableEmbedder` ⇔ the TS
//!   `try/catch`: the vec stays empty and BM25 alone ranks.
//! - `anchorQuery`'s `String(part.text ?? "")` runs on truthy values only
//!   (the find predicate demands it); `js_to_string`'s number formatting
//!   follows serde_json's shortest form (JS `Number→String` differs only
//!   for exotic spellings like `1e+21`).
//! - `buildAttachmentTurn`'s ONLY error path is [`Cancelled`] ⇔ the TS
//!   AbortError from the notes fetch; everything else degrades in place.

use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

use ruke_skills::jsstr::{js_len, js_slice_head, js_trim, js_truthy};
use ruke_skills::lazy::inject_system_before;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::audio_reread::{fresh_asr_for_windows, FreshAsrInspector};
use crate::frame_seek::{seek_frames_for_cues, FrameSeekOutcome, FrameSeeker};
use crate::notes::{generate_notes, notes_version, Cancelled, NotesLlm};
use crate::reread::{reread_regions, RereadOutcome, RegionInspector};
use crate::retrieve::{env_number, notes_budget, per_ref_budget, retrieve_evidence, RetrieveOpts};
use crate::router::{
    count_bounded, fingerprint_query, is_continuation_ask, pronoun_re, QueryMode, RouteAxis,
    RoutedQuery, route_query_in,
};
use crate::format::fmt_stamp;
use crate::store;
use crate::types::LoadedIndex;
use crate::QueryEmbedder;

const MAX_FRAMES: usize = 4;
const FOLLOWUP_MAX: usize = 60;

/// D-068: the reason this owner reports when it has NO route to a neural
/// reranker at all. Byte-identical to `RERANK_NO_ROUTE_REASON` in
/// `lib/server/attachindex/rerank.ts`, because the `[ranking: ...]` line is
/// part of the cross-language wire contract (fixtures/attachments replay is
/// byte-exact) and the sentence has to be TRUE on both sides. The Rust
/// attachment turn owner has no rerank stage, so naming one runtime ("the
/// Rust backend is not enabled") would have been a lie in exactly the
/// deployment that mirrors it.
pub(crate) const NO_RERANK_ROUTE: &str =
    "this retrieval owner has no neural rerank route in this deployment";

/// D-068: mirror of the `[ranking: ...]` honesty line in `turn.ts`.
///
/// Only two of the four TS shapes are computable here, and both are decided
/// by STRUCTURE rather than by a candidate count this port does not carry:
///  * `structural_selection` — the same three branches that make
///    `rankCandidates` return `rankable: false` (retrieve.ts:221-270), i.e.
///    a spine range or an explicit time selection, where reordering by
///    "similarity" would be wrong and the order IS the source's structure;
///  * `rrf_only` / `not_attempted` — the fused order stands and no reranker
///    ran, with `NO_RERANK_ROUTE` as the reason.
///
/// Documented divergence: TS's "fewer than two candidates were ranked"
/// wording is not reproducible here — `Evidence` carries the served passages,
/// never the candidate-field size the stage was handed — and no fixture, and
/// no non-degenerate retrieval, reaches it (a field that small produces no
/// evidence block at all). `neural` is unreachable here because this owner
/// has no rerank stage; adding one means extending BOTH sides at once.
pub(crate) fn rank_line(opts: &RetrieveOpts, vector_mode: &str) -> String {
    let structural = if opts.mode == QueryMode::Sequential && opts.range.is_some() {
        Some("this turn selected a spine range, so the order is reading order, not relevance")
    } else if opts.mode == QueryMode::TimeRange && !opts.windows.is_empty() {
        Some("this turn selected explicit time windows, so the order is the timeline")
    } else if opts.mode == QueryMode::TimeRange && opts.from_sec.is_some() {
        Some("this turn selected an explicit time range, so the order is the timeline")
    } else {
        None
    };
    let head = match structural {
        Some(reason) => format!("no neural rerank ({reason})"),
        None => format!(
            "the fused {} order stands; no neural rerank ran ({})",
            if vector_mode == crate::vectors::MODE_HYBRID {
                "semantic + lexical"
            } else {
                "lexical"
            },
            NO_RERANK_ROUTE
        ),
    };
    format!("\n[ranking: {head} -- passages the retrieval did not rank were never seen by the reranker]")
}

/// `TURN_BUDGET` (I05): the ceiling SHARED by every attachment in one turn
/// — notes and retrieved passages alike count against it. `ATTACH_TURN_
/// BUDGET_CHARS` ?? 48000, JS `Number()` semantics via `env_number`. Never
/// unit-tested through env manipulation (process env is global state; the
/// default is asserted through the multi-attachment math instead).
fn turn_budget() -> f64 {
    static T: OnceLock<f64> = OnceLock::new();
    *T.get_or_init(|| env_number("ATTACH_TURN_BUDGET_CHARS", 48000.0))
}

/// JS `Math.min`: NaN-propagating, unlike Rust's `f64::min` (which returns
/// the NON-NaN operand). A NaN cap never truncates — the `> cap` compare
/// is false and the slice branch never evaluates `cap as usize`.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `AttachmentRef` — first occurrence of an att id wins (Map semantics).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRef {
    pub att_id: String,
    pub name: String,
    pub category: String,
}

/// `collectAttachmentRefs` — unique refs across ALL messages, insertion
/// order; name falls back to the att id when absent or empty (JS
/// `typeof === "string" && name`), category defaults on non-string.
pub fn collect_attachment_refs(messages: &[Value]) -> Vec<AttachmentRef> {
    let mut out: Vec<AttachmentRef> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for m in messages {
        let parts = match m.get("content") {
            Some(Value::Array(a)) => a,
            _ => continue, // `!Array.isArray(m?.content)`
        };
        for part in parts {
            if part.get("type").and_then(Value::as_str) != Some("attachment_ref") {
                continue;
            }
            let att = match part.get("att_id").and_then(Value::as_str) {
                Some(s) => s,
                None => continue,
            };
            if !store::valid_att_id(att) || seen.contains(att) {
                continue;
            }
            seen.insert(att.to_string());
            let name = match part.get("name") {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                _ => att.to_string(),
            };
            let category = match part.get("category") {
                Some(Value::String(s)) => s.clone(),
                _ => "text".to_string(),
            };
            out.push(AttachmentRef {
                att_id: att.to_string(),
                name,
                category,
            });
        }
    }
    out
}

/// Standard-alphabet base64 with padding ⇔ Node `buf.toString("base64")`.
/// Hand-rolled: the workspace deliberately carries no base64 crate.
pub(crate) fn b64_std(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// ⇔ `FRAME_WINDOW_SEC` (I18b): a keyframe farther than this from the
/// asked-about moment is NOT served — showing what is on screen minutes
/// away as if it belonged to the discussed time would mislead.
const FRAME_WINDOW: f64 = 180.0;

/// F78/F153 (⇔ `cueMoments` in turn.ts): the asked instants behind a routed
/// time-range question. The router builds each cue window as [c-180, c+180]
/// CLIPPED to the media's length; the midpoint of a clipped window is NOT
/// the asked instant (a cue at 00:00:45 → window [0, 225] → midpoint
/// 00:01:53 would mislabel what the user asked). Un-clip from the clipped
/// edge; midpoint only when the window is full width. At most MAX_FRAMES.
pub fn cue_moments(routed: &RoutedQuery, dur: f64) -> Vec<f64> {
    let cue_at = |w: (f64, f64)| -> f64 {
        let mid = (w.0 + w.1) / 2.0;
        if w.1 - w.0 >= 2.0 * FRAME_WINDOW {
            return mid;
        }
        if w.0 <= 0.5 {
            return (w.1 - FRAME_WINDOW).max(0.0);
        }
        if dur > 0.0 && w.1 >= dur - 0.5 {
            return w.0 + FRAME_WINDOW;
        }
        mid
    };
    let all: Vec<f64> = if !routed.windows.is_empty() {
        routed.windows.iter().copied().map(cue_at).collect()
    } else {
        vec![cue_at((
            routed.from_sec.unwrap_or(0.0),
            routed.to_sec.unwrap_or(0.0),
        ))]
    };
    all.into_iter().take(MAX_FRAMES).collect()
}

/// `nearestFrames` — per timestamp, the nearest UNUSED frame (strict `<`
/// keeps the first minimum in frame order); a used slot stays consumed
/// even when its file read fails (TS `used.add` runs before the `try`).
/// The I18b window check runs BEFORE `used.insert` — a skipped far frame
/// stays available for a closer request (TS `continue` precedes `used.add`).
/// Returns `(data_url, at)` pairs; the caller appends them to images.
fn nearest_frames(root: &Path, index: &LoadedIndex, frame_ats: &[f64]) -> Vec<(String, f64)> {
    let frames = &index.meta.frames;
    if frames.is_empty() || frame_ats.is_empty() {
        return Vec::new();
    }
    // TS calls `indexDir` inside the per-frame `try` (a throw is caught);
    // the id is ATT_RE-valid by construction, so resolving once outside is
    // equivalent — `None` reproduces "every read throws".
    let dir = store::index_dir(root, &index.meta.att_id);
    let mut used: HashSet<usize> = HashSet::new();
    let mut out: Vec<(String, f64)> = Vec::new();
    for &at in frame_ats {
        let mut best: Option<usize> = None;
        let mut best_d = f64::INFINITY;
        for (k, f) in frames.iter().enumerate() {
            if used.contains(&k) {
                continue;
            }
            let d = (f.at - at).abs();
            if d < best_d {
                best_d = d;
                best = Some(k);
            }
        }
        let best = match best {
            Some(k) => k,
            None => break, // all frames used
        };
        if best_d > FRAME_WINDOW {
            continue; // I18b: no anchor in window — serve nothing, burn nothing
        }
        used.insert(best);
        if let Some(dir) = &dir {
            // `join(indexDir, file)` — a `file` that is absolute replaces
            // the dir in BOTH engines (documented, frozen format never emits it).
            let path = dir.join(&frames[best].file);
            if let Ok(buf) = std::fs::read(&path) {
                // Mime-by-extension law ⇔ turn.ts nearestFrames: seeked
                // frames persist as PNG ("s_%05d.png"), build keyframes as
                // JPEG ("f_%05d.jpg") — serve the real mime of what is on
                // disk (nearest_unit_frames already picks by extension).
                let mime = if frames[best].file.to_lowercase().ends_with(".png") {
                    "image/png"
                } else {
                    "image/jpeg"
                };
                out.push((
                    format!("data:{mime};base64,{}", b64_std(&buf)),
                    frames[best].at,
                ));
            }
        }
        if out.len() >= MAX_FRAMES {
            break;
        }
    }
    out
}

/// `unitFrames` ⇔ lib/server/attachindex/turn.ts: labelled document frames
/// ride with the retrieval ONLY for the units the winning passages themselves
/// name. Document frames sit on the UNIT-ordinal axis (pages/slides/sheets),
/// not seconds, so the honesty window is an EXACT match — a frame no passage
/// names is not shown at all. Only labelled frames qualify (video keyframes
/// stay on the `nearest_frames` time axis). Multiple regions of one unit all
/// match its cue, up to MAX_FRAMES.
fn nearest_unit_frames(
    root: &Path,
    index: &LoadedIndex,
    cues: &[f64],
) -> Vec<(String, f64, String)> {
    let frames = &index.meta.frames;
    if frames.is_empty() || cues.is_empty() {
        return Vec::new();
    }
    let dir = store::index_dir(root, &index.meta.att_id);
    let mut used: HashSet<usize> = HashSet::new();
    let mut out: Vec<(String, f64, String)> = Vec::new();
    for &cue in cues {
        for (k, f) in frames.iter().enumerate() {
            if out.len() >= MAX_FRAMES {
                break;
            }
            if used.contains(&k) || f.label.is_none() || f.at != cue {
                continue;
            }
            used.insert(k);
            if let Some(dir) = &dir {
                let path = dir.join(&f.file);
                if let Ok(buf) = std::fs::read(&path) {
                    // Document frames are PNG (renderer output); video
                    // keyframes are JPEG — mime chosen by extension.
                    let mime = if f.file.to_lowercase().ends_with(".png") {
                        "image/png"
                    } else {
                        "image/jpeg"
                    };
                    out.push((
                        format!("data:{};base64,{}", mime, b64_std(&buf)),
                        f.at,
                        f.label.clone().unwrap_or_default(),
                    ));
                }
            }
        }
        if out.len() >= MAX_FRAMES {
            break;
        }
    }
    out
}

/// `regionFrames` ⇔ lib/server/attachindex/turn.ts (F153 §3): the crops of
/// the regions a targeted reread JUST refreshed, in frame order, so the
/// refreshed pixels ride paired to their labels. A frame file missing on disk
/// is skipped — the text evidence stands.
fn region_frames(
    root: &Path,
    index: &LoadedIndex,
    regions: &[String],
) -> Vec<(String, f64, String)> {
    let frames = &index.meta.frames;
    let dir = store::index_dir(root, &index.meta.att_id);
    let mut out: Vec<(String, f64, String)> = Vec::new();
    for f in frames {
        if out.len() >= MAX_FRAMES {
            break;
        }
        let (Some(region), Some(label)) = (f.region.as_ref(), f.label.as_ref()) else {
            continue;
        };
        if !regions.iter().any(|r| r == region) {
            continue;
        }
        let Some(dir) = &dir else { continue };
        if let Ok(buf) = std::fs::read(dir.join(&f.file)) {
            let mime = if f.file.to_lowercase().ends_with(".png") {
                "image/png"
            } else {
                "image/jpeg"
            };
            out.push((
                format!("data:{};base64,{}", mime, b64_std(&buf)),
                f.at,
                label.clone(),
            ));
        }
    }
    out
}

/// F152: lead-in for document pictures, kept separate from the video moments
/// law (video bytes stay golden-frozen). Byte-identical to
/// DOC_FRAMES_LEAD_IN in lib/server/attachindex/turn.ts; the per-frame label
/// format matches lib/chat/client.ts ("<label> — drawn content:").
const DOC_FRAMES_LEAD_IN: &str = concat!(
    "Each picture below is labelled with where it sits in the attached document — the file's own drawn content (chart pages, embedded images), kept separate from the retrieved text passages. Answer questions about appearance from the labelled picture and say which one you read it from:",
);

/// `rules(ref)` — byte-exact four-segment base + variant.
fn rules(r: &AttachmentRef) -> String {
    let is_video = r.category == "video";
    let timed = is_video || r.category == "audio";
    let mut s = String::from(concat!(
        "Rules for this content: answer from the material below whenever it covers the question. ",
        // F152 Part 4 wording law — byte-identical to the TS rules() segment
        // above (direct format, narrow plain unreadable statement after the
        // closer read, no blame, no "not given", engine errors = diagnostics).
        "Answer directly in the form the question asked for. When a closer read of part of the ",
        "content has been attempted and it is still unreadable, say plainly and narrowly which part ",
        "you could not read and where it sits (for example: I couldn't read the small label on page 1); ",
        "never blame the user for how the file was made, never say the file's content was not given to ",
        "you, and keep engine and decoding errors out of the answer — they are diagnostics, not the ",
        "conversation. ",
        "Where passages carry [HH:MM:SS - HH:MM:SS] headers, cite that header for every claim taken from it. ",
        "If the question concerns a time range or section NOT present below, state that you cannot see that ",
        "part of the content clearly enough to answer it — do not guess, and do not explain how the content ",
        "was processed. ",
    ));
    // F76 numeric-fidelity law — byte-identical to the TS rules() base segment
    // above; rides EVERY indexed category (figures live in documents, slides
    // and speech alike).
    s.push_str(concat!(
        "When quoting a figure from the material, keep its exact digits and digit grouping. When restating ",
        "a figure in different units or a different grouping convention, state the exact conversion being ",
        "applied and verify the restated figure has the same value; never give two versions of one figure ",
        "that have different values. This applies to every restated version anywhere in the answer, ",
        "including brief asides. ",
    ));
    s.push_str(if is_video {
        concat!(
            "This video's complete saved record is kept locally and you are shown the parts of it that matter to ",
            "this question — its visuals and its speech are one thing: speak of what the record shows about the ",
            "video as a whole, and never claim to have watched, seen or heard it yourself. Never mention ",
            "transcription, retrieval, indexing, frames, sampled images or keyframes, and never attribute content ",
            "to a particular frame. Give timestamps only when the user asks for them or when a time reference ",
            "genuinely helps.",
        )
    } else if timed {
        concat!(
            "This recording's complete saved record is kept locally and you are shown the parts that matter to ",
            "this question: speak of what the recording says; never claim to have heard it yourself, and never ",
            "mention transcription, retrieval or indexing.",
        )
    } else {
        "You have read this document directly; never mention retrieval or indexing."
    });
    s
}

/// `String(v)` for the anchorQuery fallback (only ever called on TRUTHY
/// values — the find predicate rejects falsy `text` — so null/0/"" never
/// reach here). Number printing follows serde_json (see module doc).
fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(js_to_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `anchorQuery` — short or pronoun-heavy follow-ups inherit the previous
/// user question's topic (first 300 UTF-16 units of its first truthy text
/// part). The scan runs backwards from `user_idx - 1` and stops at the
/// FIRST user message with non-empty trimmed content (quirk kept: an
/// empty-content user turn does NOT stop the scan).
pub fn anchor_query(question: &str, messages: &[Value], user_idx: usize) -> String {
    let q = js_trim(question).to_string();
    if q.is_empty() {
        return q;
    }
    let pronouns = count_bounded(pronoun_re(), &q);
    let qlen = js_len(&q);
    let followup = qlen < FOLLOWUP_MAX || (qlen < 140 && pronouns >= 2);
    if !followup {
        return q;
    }
    let mut i = user_idx;
    while i > 0 {
        i -= 1;
        let m = &messages[i];
        if m.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let prev = match m.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => {
                let found = parts.iter().find(|p| {
                    p.get("type").and_then(Value::as_str) == Some("text")
                        && js_truthy(p.get("text").unwrap_or(&Value::Null))
                });
                match found {
                    Some(p) => js_to_string(p.get("text").unwrap_or(&Value::Null)),
                    None => String::new(), // `find(…) ?? ""`
                }
            }
            _ => String::new(),
        };
        let t = js_trim(&prev);
        if !t.is_empty() {
            return format!("{} {}", js_slice_head(t, 300), q);
        }
    }
    q
}

/// The video keyframes lead-in line appended to the user turn (byte-exact).
/// F76 (2026-11-21): carries the sampling law — the delivered instants say
/// nothing about the time between them, and without the law the model fills
/// that gap ("visible throughout the clip"). Byte-identical to the lead-in in
/// `lib/server/attachindex/turn.ts` (the attachment goldens replay these
/// bytes) and to `VIDEO_MOMENTS_LAW` in `lib/chat/client.ts`.
const FRAME_LEAD_IN: &str = concat!(
    "Moments from the attached video nearest to the discussed time range — they come from the video's saved ",
    "record; describe them as things that happen in the video, never as frames:",
    " The images are isolated moments: the record holds no evidence about the time between, before or after them. ",
    "Never claim that something is visible throughout a video, always or never shown, or unchanged across any ",
    "stretch between two shown moments; when asked about such a stretch, answer from the shown moments and say ",
    "the rest cannot be confirmed.",
);

/// `buildAttachmentTurn` — returns the number of injected system blocks.
/// `user_idx` is the CURRENT index of the last user message. F08 (2026-11-15):
/// the chat route/pipeline now resolve that index once per turn and re-resolve
/// it after every injected block, so it always names the real user turn (the
/// old `lastUserIdx + 1` derivation silently dropped keyframes on the no-skill
/// path). An out-of-range index still degrades in place: frames simply have
/// nowhere to land.
///
/// The ONLY `Err` is [`Cancelled`] ⇔ the TS AbortError out of the notes
/// fetch; every other failure degrades in place exactly like the TS.
// The parameter list mirrors `buildAttachmentTurn(messages, userIdx,
// question, root, embedder, http, llm, token, conversation, reread)`
// one-for-one (parity port); bundling the deps into a struct would rename
// the seam the Part-6 web seam will parallel.
#[allow(clippy::too_many_arguments)]
pub async fn build_attachment_turn(
    messages: &mut Vec<Value>,
    user_idx: usize,
    question: &str,
    root: &Path,
    embedder: &dyn QueryEmbedder,
    http: &reqwest::Client,
    llm: &NotesLlm,
    token: &CancellationToken,
    // F07: the conversation this turn belongs to; the shown ledger is scoped to
    // it (None = the bare attachment key, as before F07).
    conversation: Option<&str>,
    // F152: the targeted-reread transport (reread.ts's RegionReader seam).
    // `None` = no closer-read work is wired: goldens stay byte-identical.
    reread: Option<&dyn RegionInspector>,
    // F153 item 3: the bounded fresh audio read (audio-reread.ts's
    // FreshAsrReader seam). `None` = no fresh decode work is wired:
    // goldens stay byte-identical.
    fresh_asr: Option<&dyn FreshAsrInspector>,
    // F153 item 4: the on-demand visual seek (frame-seek.ts's
    // SeekFramesReader seam). `None` = no seek work is wired: goldens stay
    // byte-identical.
    seek_frames: Option<&dyn FrameSeeker>,
) -> Result<usize, Cancelled> {
    let refs = collect_attachment_refs(messages);
    if refs.is_empty() {
        return Ok(0);
    }

    let mut blocks: Vec<String> = Vec::new();
    let mut images: Vec<(String, f64)> = Vec::new();
    // F152: labelled document frames are kept apart from video keyframes so
    // each kind gets its own lead-in law.
    let mut doc_images: Vec<(String, f64, String)> = Vec::new();
    let mut turn_used: f64 = 0.0;

    // I22 direct-route guard (turn.ts:197-200): when the RAW question by
    // itself carries a routing phrase, it IS the retrieval query —
    // "all mentions of X in the last 5 minutes" must not be glued onto an
    // antecedent, which would blur the phrase past the anchor text.
    // F07 (2026-11-15) RAW-FIRST (turn.ts:210-225). The raw question is the
    // retrieval query, so an explicit phrase ("every mention", "summarize",
    // "at 1:45") still decides the route and the window, and an UNRELATED short
    // follow-up ("what about the CPU fan?") no longer inherits the previous
    // question's topic. anchor_query stays a BOUNDED FALLBACK, consulted only
    // when the raw question retrieved nothing at all for an attachment.
    let trimmed_q = js_trim(question);
    let anchored = anchor_query(question, messages, user_idx);
    let rq = if trimmed_q.is_empty() {
        anchored.clone()
    } else {
        trimmed_q.to_string()
    };

    for r in &refs {
        let mut index = match store::read_index(root, &r.att_id) {
            Some(index) => index,
            None => {
                blocks.push(format!(
                    "<knowledge_index name=\"{name}\">\nThe local knowledge index for this attachment is no longer available on disk. Say so honestly if the question needs it.\n</knowledge_index>",
                    name = r.name,
                ));
                continue;
            }
        };

        // F07: the time axis comes from the INDEX, never from the attachment's
        // name or a category guess. No duration and no timed chunk means this
        // content has no timeline, so a "1:20" ratio inside a document must not
        // invent a video window (mirror of turn.ts:241-249).
        let axis = if index.meta.duration_sec.unwrap_or(0.0) > 0.0
            || index.chunks.iter().any(|c| c.start_sec.is_some())
        {
            RouteAxis::Time
        } else {
            RouteAxis::Text
        };
        let mut routed = route_query_in(&rq, axis);

        // I22: "the last N minutes" carries NO window of its own — the
        // index's own duration resolves it. Without a usable duration the
        // mode falls back to point_qa (TS sets `mode` only; from/to were
        // never set on this branch).
        if let Some(last_sec) = routed.last_sec {
            match index.meta.duration_sec {
                Some(d) if d > 0.0 => {
                    routed.from_sec = Some((d - last_sec).max(0.0));
                    routed.to_sec = Some(d);
                }
                _ => routed.mode = QueryMode::PointQa,
            }
        }

        if routed.mode == QueryMode::WholeVideo {
            // I05: the turn's shared budget is checked BEFORE notes are
            // fetched — an already-full turn says so honestly instead of
            // silently dropping the attachment.
            let remaining = turn_budget() - turn_used;
            if remaining <= 0.0 {
                blocks.push(format!(
                    "<knowledge_index name=\"{name}\">\nThis turn's evidence budget is already full, so no content from this attachment was retrieved for it. Ask the question again in a new turn.\n</knowledge_index>",
                    name = r.name,
                ));
                continue;
            }

            // I24: the cache read is keyed by the notes FINGERPRINT —
            // notes distilled by another model, or for a different
            // chunking/spine, are never served (no unversioned fallback).
            // `!notes` is FALSY (`""` triggers regeneration), while the
            // store returns `Some("")` — the nullish-vs-falsy split lives
            // here, not in `read_notes`.
            let version = notes_version(&index, &llm.model);
            let mut notes = store::read_notes_with_version(root, &r.att_id, &version);
            if !matches!(&notes, Some(s) if !s.is_empty()) {
                let gen = generate_notes(root, &r.att_id, &index, http, llm, token).await?;
                notes = if gen.is_empty() { None } else { Some(gen) }; // `|| null`
            }
            if let Some(notes) = notes {
                let cap = js_min(notes_budget(), remaining);
                let notes = if cap >= 0.0 && (js_len(&notes) as f64) > cap {
                    format!("{}\n[...]", js_slice_head(&notes, cap as usize))
                } else {
                    notes
                };
                // Count against the turn AFTER the slice — the "\n[...]"
                // marker costs too (TS `turnUsed += notes.length`).
                turn_used += js_len(&notes) as f64;
                blocks.push(format!(
                    "<course_notes name=\"{name}\">\nCourse notes distilled from the extracted content of \"{name}\":\n{notes}\n{rules} Cite the [HH:MM:SS] block headers of the notes.\n</course_notes>",
                    name = r.name,
                    notes = notes,
                    rules = rules(r),
                ));
            }
            // UNCONDITIONAL continue (turn.ts:188) — whole_video never
            // falls through to hybrid retrieval, notes or not.
            continue;
        }

        // `try { queryVec = await embedOne(rq, signal) } catch {}` — the
        // seam's Err keeps the vec empty (BM25 alone still ranks). I25:
        // the token lets a cancelled turn abandon the RPC in flight
        // instead of waiting a large ONNX embedding out.
        let query_vec = embedder.embed_one(&rq, token).unwrap_or_default();

        // I20 + F07: the "already shown" ledger is scoped to THIS conversation
        // and records WHICH query produced it. An exact repeat of a question
        // this conversation already answered from this attachment gets its own
        // top passages BACK (reproduced: a repeated exact question lost its
        // answer because the passages it had been shown were demoted below
        // unrelated text). Exhaustive scans and explicit continuation asks
        // rotate instead, so "keep going" still surfaces fresh material.
        let query_fp = fingerprint_query(&rq);
        let entry = store::read_shown_entry(root, &r.att_id, conversation);
        let shown_for: Vec<i64> = entry.clone().map(|e| e.ids).unwrap_or_default();
        let repeat_ask = entry.map(|e| !e.q.is_empty() && e.q == query_fp).unwrap_or(false);
        let scan_mode = routed.mode == QueryMode::Exhaustive;
        let shown = if repeat_ask && !scan_mode && !is_continuation_ask(&rq) {
            Vec::new()
        } else {
            shown_for.clone()
        };

        // I05: the shared turn budget first (honest block when spent),
        // then the per-reference ceiling on top of what's left.
        let remaining = turn_budget() - turn_used;
        if remaining <= 0.0 {
            blocks.push(format!(
                "<knowledge_index name=\"{name}\">\nThis turn's evidence budget is already full, so no passages from this attachment were retrieved for it. Ask the question again in a new turn.\n</knowledge_index>",
                name = r.name,
            ));
            continue;
        }
        let budget = js_min(per_ref_budget(), remaining);

        let opts = if routed.mode == QueryMode::Sequential {
            // `spineBlocks?.[blockIndex ?? -1]` — a negative/absent index
            // is `undefined` in JS ⇒ best-effort point_qa.
            let blk = match routed.block_index {
                Some(b) if b >= 0 => index.meta.spine_blocks.get(b as usize),
                _ => None,
            };
            match blk {
                Some(b) => RetrieveOpts {
                    mode: QueryMode::Sequential,
                    range: Some((b.chunk_from, b.chunk_to)),
                    demote: shown.clone(),
                    budget: Some(budget),
                    ..Default::default()
                },
                None => RetrieveOpts {
                    mode: QueryMode::PointQa,
                    demote: shown.clone(),
                    budget: Some(budget),
                    ..Default::default()
                },
            }
        } else {
            RetrieveOpts {
                mode: routed.mode,
                from_sec: routed.from_sec,
                to_sec: routed.to_sec,
                range: None,
                windows: routed.windows.clone(),
                demote: shown.clone(),
                budget: Some(budget),
            }
        };

        let mut ev = retrieve_evidence(&index, &rq, &query_vec, &opts);

        // F07: anchored fallback, LAZILY and at most once more. Only when the
        // raw question found nothing at all does the previous question's topic
        // get prepended; the routing decision stays the raw question's own.
        if ev.text.is_empty() && !anchored.is_empty() && anchored != rq {
            let fallback_vec = embedder.embed_one(&anchored, token).unwrap_or_default();
            ev = retrieve_evidence(&index, &anchored, &fallback_vec, &opts);
        }

        // F152 targeted reread (⇔ turn.ts): an explicit closer-read request
        // about a picture the retrieved passages name re-inspects EXACTLY
        // that region — the inspector runs with the region ids as scope,
        // refreshes only that region's pixels/state/passage (reread.rs), and
        // the recovered lines answer THIS turn. Ordinary follow-ups never
        // reach work here: the cached evidence is what they reuse. A failed
        // reread leaves the cached evidence standing (never throws). The
        // index is RE-READ after a refresh so the pairing below serves the
        // refreshed pixels and state this same turn.
        let mut reread_out = RereadOutcome::default();
        if let Some(insp) = reread {
            if index
                .meta
                .frames
                .iter()
                .any(|f| f.region.is_some() && f.label.is_some())
            {
                // F153 §3: `ev.text.is_empty()` marks the MISSING-PASSAGE
                // case — retrieval found nothing, which is itself a
                // targeted-read reason (reread.rs enforces the named-unit
                // targeting). ⇔ turn.ts.
                let out = reread_regions(
                    root,
                    embedder,
                    insp,
                    &r.att_id,
                    &trimmed_q,
                    &index,
                    &ev.page_cues,
                    ev.text.is_empty(),
                    token,
                )
                .await;
                if !out.lines.is_empty() {
                    if let Some(fresh) = store::read_index(root, &r.att_id) {
                        index = fresh; // refreshed state/pixels visible to the pairing below
                    }
                }
                reread_out = out;
            }
        }
        let reread_lines = &reread_out.lines;

        // F78 (2026-11-22): a video whose speech could not be read indexes
        // its keyframes + one coverage note — there is NO timed passage for a
        // routed time_range question to retrieve, so an empty `ev.text` below
        // fires and the model receives NOTHING for the exact-time question
        // the router aimed at the frames (reproduced live: "What is on screen
        // at 01:31:00?" over a frames-only index → zero evidence delivered on
        // THIS owner while the TS mirror served the frame). The saved frames
        // ARE this record's only evidence for the asked moment: serve the
        // nearest ones with the requested-vs-sampled attribution law
        // (FRAME_WINDOW honesty intact — nearest_frames already refuses a far
        // moment) and the unconfirmable-between law. Generic: routed window +
        // index meta only, never content inspection. ⇔ turn.ts F78 block.
        if ev.text.is_empty() && routed.mode == QueryMode::TimeRange
            && (!index.meta.frames.is_empty() || seek_frames.is_some())
        {
            // Cue geometry: ⇔ cue_moments (the un-clip law lives there).
            let dur = index.meta.duration_sec.unwrap_or(0.0);
            let cues: Vec<f64> = cue_moments(&routed, dur);
            let mut per_cue: Vec<(f64, Vec<(String, f64)>)> = cues
                .iter()
                .map(|cue| (*cue, nearest_frames(root, &index, &[*cue])))
                .collect();
            // F153 item 4 (2026-11-25): a moment no saved frame covers is NOT
            // "never captured" while the original sits on disk — those instants
            // get ONE bounded on-demand decode (frame_seek.rs): the picture
            // rides THIS turn, and the frame + any on-screen words become part
            // of the record so the next follow-up answers from it. Absent seam
            // = the golden path is byte-identical.
            let missing: Vec<f64> = per_cue
                .iter()
                .filter(|(_, frames)| frames.is_empty())
                .map(|(cue, _)| *cue)
                .collect();
            let mut seek: Option<FrameSeekOutcome> = None;
            if let Some(seeker) = seek_frames {
                if !missing.is_empty() {
                    // The Rust transport is total (frame_seek module docs):
                    // every fault resolves to a named outcome, so the TS
                    // try/catch around the seam has no Rust route.
                    seek = Some(
                        seek_frames_for_cues(
                            root, embedder, seeker, &r.att_id, &index, &missing, token,
                        )
                        .await,
                    );
                }
            }
            if let Some(s) = &seek {
                for (cue, frames) in per_cue.iter_mut() {
                    for (url, at) in &s.images {
                        // Same honesty window as saved frames: a seeked pixel
                        // answers only for the instant it decoded.
                        if (*at - *cue).abs() <= FRAME_WINDOW && !frames.iter().any(|f| f.1 == *at) {
                            frames.push((url.clone(), *at));
                        }
                    }
                }
            }
            let mut shown: Vec<(String, f64)> = Vec::new();
            for (_, frames) in &per_cue {
                for f in frames {
                    if !shown.iter().any(|x| x.0 == f.0 && x.1 == f.1) {
                        shown.push(f.clone());
                    }
                }
            }
            let cue_lines = per_cue
                .iter()
                .map(|(cue, frames)| {
                    let cue_s = fmt_stamp(*cue);
                    if frames.is_empty() {
                        format!("Asked time {cue_s}: NO saved moment lies within this turn's time window, so what is on screen at that time was never captured.")
                    } else {
                        let plural = frames.len() > 1;
                        let stamps = frames
                            .iter()
                            .map(|f| fmt_stamp(f.1))
                            .collect::<Vec<_>>()
                            .join(", ");
                        format!(
                            "Asked time {cue_s}: the saved moment{} nearest {cue_s} {} at {stamps} (the record holds no saved moment closer).",
                            if plural { "s" } else { "" },
                            if plural { "are" } else { "is" },
                        )
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            let seek_lines = match &seek {
                Some(s) if !s.lines.is_empty() => format!("\n{}", s.lines.join("\n")),
                _ => String::new(),
            };
            if !shown.is_empty() {
                let total_chunks = if index.meta.chunk_count != 0 {
                    index.meta.chunk_count
                } else {
                    index.chunks.len() as i64
                };
                // The seeked frames that became saved frames count toward the
                // honest total — the marker reports the record AFTER this turn.
                let total_frames = index.meta.frames.len() as i64
                    + seek.as_ref().map(|s| s.durable as i64).unwrap_or(0);
                let lines = format!("{cue_lines}{seek_lines}");
                let mut block = format!(
                    "<knowledge_index name=\"{name}\">\nThe question asks about a moment on this video's timeline. Its saved record carries no readable speech, so the visual record is the evidence served for the asked time.\n{lines}\nThe saved moments are isolated points: the record holds NO evidence about the time between, before or after them. Answer about the asked moment from the saved moment nearest it, give its time, and state that what happens between saved moments cannot be confirmed.\n",
                    name = r.name,
                    lines = lines,
                );
                // coverageMarker ⇔ turn.ts — the same honest numbers, the
                // frames-only selection counted.
                {
                    let mut c = format!(
                        "\n[coverage: {} of {} indexed passages of \"{}\" were shown this turn",
                        ev.chunk_idxs.len(),
                        total_chunks,
                        r.name
                    );
                    if ev.dropped > 0 {
                        c.push_str(&format!("; {} further matched passages were withheld by this turn's budget (ask to continue and a different set is served)", ev.dropped));
                    } else if ev.truncated {
                        c.push_str("; more passages matched than this turn's budget could show");
                    } else {
                        c.push_str("; no matched passage was withheld from this turn");
                    }
                    c.push_str(&format!(
                        "; ranking mode: {}",
                        if ev.vector_mode == crate::vectors::MODE_HYBRID {
                            "semantic + lexical"
                        } else {
                            "lexical only"
                        }
                    ));
                    if let Some(reason) = &ev.vector_reason {
                        c.push_str(&format!(" ({})", reason));
                    }
                    if total_frames > 0 {
                        c.push_str(&format!(
                            "; {} of {} saved keyframes shown",
                            shown.len(),
                            total_frames
                        ));
                    }
                    c.push_str(" -- anything outside this selection was NOT read this turn]");
                    block.push_str(&c);
                }
                block.push_str(&rank_line(&opts, &ev.vector_mode));
                block.push('\n');
                block.push_str(&rules(r));
                block.push_str("\n</knowledge_index>");
                turn_used += js_len(&block) as f64;
                blocks.push(block);
                images.extend(shown);
                continue;
            }
            // Nothing saved AND the seek delivered no frame: the golden
            // "never captured" sentence rides WITH the seek's named
            // failures, so the answer distinguishes "the record never held
            // this moment" from "the on-demand decode failed for reason X
            // and is retryable" — and the moment is no longer silently
            // unreachable while the original is on disk. ⇔ turn.ts branch.
            if let Some(s) = &seek {
                if !s.lines.is_empty() {
                    let total_chunks = if index.meta.chunk_count != 0 {
                        index.meta.chunk_count
                    } else {
                        index.chunks.len() as i64
                    };
                    let lines = format!("{cue_lines}{seek_lines}");
                    let mut block = format!(
                        "<knowledge_index name=\"{name}\">\nThe question asks about a moment on this video's timeline. Its saved record carries no readable speech, so the visual record is the evidence served for the asked time.\n{lines}\nThe saved moments are isolated points: the record holds NO evidence about the time between, before or after them. Answer about the asked moment from the saved moment nearest it, give its time, and state that what happens between saved moments cannot be confirmed.\n",
                        name = r.name,
                        lines = lines,
                    );
                    // coverageMarker(ev, 0, name, totalChunks, 0) ⇔ turn.ts:
                    // no stored passage and no frame was shown, so the frame
                    // clause is never emitted.
                    {
                        let mut c = format!(
                            "\n[coverage: {} of {} indexed passages of \"{}\" were shown this turn",
                            ev.chunk_idxs.len(),
                            total_chunks,
                            r.name
                        );
                        if ev.dropped > 0 {
                            c.push_str(&format!("; {} further matched passages were withheld by this turn's budget (ask to continue and a different set is served)", ev.dropped));
                        } else if ev.truncated {
                            c.push_str("; more passages matched than this turn's budget could show");
                        } else {
                            c.push_str("; no matched passage was withheld from this turn");
                        }
                        c.push_str(&format!(
                            "; ranking mode: {}",
                            if ev.vector_mode == crate::vectors::MODE_HYBRID {
                                "semantic + lexical"
                            } else {
                                "lexical only"
                            }
                        ));
                        if let Some(reason) = &ev.vector_reason {
                            c.push_str(&format!(" ({})", reason));
                        }
                        c.push_str(" -- anything outside this selection was NOT read this turn]");
                        block.push_str(&c);
                    }
                    block.push_str(&rank_line(&opts, &ev.vector_mode));
                    block.push('\n');
                    block.push_str(&rules(r));
                    block.push_str("\n</knowledge_index>");
                    turn_used += js_len(&block) as f64;
                    blocks.push(block);
                    continue;
                }
            }
        }
        // F153 item 3 (⇔ turn.ts): the UNCOVERED-TIME fresh-read law. An
        // audio index whose routed time_range question retrieved NO passage
        // had nothing to answer from; audio_reread decides honestly from the
        // durable record: a covered window is never re-decoded, a fully
        // decoded recording states the measured absence, an unexamined
        // window gets ONE bounded fresh decode of the ORIGINAL, persisted so
        // follow-ups continue across the boundary. The Rust seam resolves
        // every fault to a typed outcome (reread transport law), so no
        // catch is needed — a failed read leaves the block reporting the
        // failure plainly. Generic: routed window + index meta only.
        if ev.text.is_empty()
            && routed.mode == QueryMode::TimeRange
            && fresh_asr.is_some()
            && index.meta.category == "audio"
            && index.meta.duration_sec.unwrap_or(0.0) > 0.0
        {
            let fresh = fresh_asr_for_windows(
                root,
                embedder,
                fresh_asr.unwrap(),
                &r.att_id,
                &index,
                &cue_moments(&routed, index.meta.duration_sec.unwrap_or(0.0)),
                token,
            )
            .await;
            if !fresh.lines.is_empty() {
                let total_chunks = if index.meta.chunk_count != 0 {
                    index.meta.chunk_count
                } else {
                    index.chunks.len() as i64
                };
                let mut block = format!(
                    "<knowledge_index name=\"{name}\">\nThe question asks about a moment on this recording's timeline. The saved transcript carried no passage for the asked window(s), so this turn consulted the record and, where the window had never been listened to, ran ONE bounded decode of the original. What it found:\n{lines}\n",
                    name = r.name,
                    lines = fresh.lines.join("\n"),
                );
                // coverageMarker ⇔ turn.ts coverageMarker(ev, 0, name,
                // totalChunks, 0): the same honest numbers — no stored
                // passage and no frame was shown for this block, so the
                // frame clause is never emitted.
                {
                    let mut c = format!(
                        "\n[coverage: {} of {} indexed passages of \"{}\" were shown this turn",
                        ev.chunk_idxs.len(),
                        total_chunks,
                        r.name
                    );
                    if ev.dropped > 0 {
                        c.push_str(&format!("; {} further matched passages were withheld by this turn's budget (ask to continue and a different set is served)", ev.dropped));
                    } else if ev.truncated {
                        c.push_str("; more passages matched than this turn's budget could show");
                    } else {
                        c.push_str("; no matched passage was withheld from this turn");
                    }
                    c.push_str(&format!(
                        "; ranking mode: {}",
                        if ev.vector_mode == crate::vectors::MODE_HYBRID {
                            "semantic + lexical"
                        } else {
                            "lexical only"
                        }
                    ));
                    if let Some(reason) = &ev.vector_reason {
                        c.push_str(&format!(" ({})", reason));
                    }
                    c.push_str(" -- anything outside this selection was NOT read this turn]");
                    block.push_str(&c);
                }
                block.push_str(&rank_line(&opts, &ev.vector_mode));
                block.push('\n');
                block.push_str(&rules(r));
                block.push_str("\n</knowledge_index>");
                turn_used += js_len(&block) as f64;
                blocks.push(block);
                continue;
            }
        }
        // F153 §3 (⇔ turn.ts): the retrieval came up empty AND the targeted
        // read produced lines — serve the attempt and its real outcome. When
        // the read recovered text, it IS this turn's evidence; when it
        // recovered none, the reread line names the exact unreadable part
        // plainly (reread.ts law); the refreshed crops ride paired to their
        // labels. No wording change hides missing evidence; no canned reply.
        if ev.text.is_empty() && !reread_lines.is_empty() {
            let crops = region_frames(root, &index, &reread_out.regions);
            let total_chunks = if index.meta.chunk_count != 0 {
                index.meta.chunk_count
            } else {
                index.chunks.len() as i64
            };
            let total_frames = index.meta.frames.len() as i64;
            let mut block = format!(
                "<knowledge_index name=\"{name}\">\nNo passage in this attachment's saved record matched the question, so this turn attempted a targeted closer read of the picture(s) the question names. Its result:\n{lines}\n",
                name = r.name,
                lines = reread_lines.join("\n"),
            );
            // coverageMarker ⇔ turn.ts — the same honest numbers; the
            // refreshed crops are the frames shown.
            {
                let mut c = format!(
                    "\n[coverage: {} of {} indexed passages of \"{}\" were shown this turn",
                    ev.chunk_idxs.len(),
                    total_chunks,
                    r.name
                );
                if ev.dropped > 0 {
                    c.push_str(&format!("; {} further matched passages were withheld by this turn's budget (ask to continue and a different set is served)", ev.dropped));
                } else if ev.truncated {
                    c.push_str("; more passages matched than this turn's budget could show");
                } else {
                    c.push_str("; no matched passage was withheld from this turn");
                }
                c.push_str(&format!(
                    "; ranking mode: {}",
                    if ev.vector_mode == crate::vectors::MODE_HYBRID {
                        "semantic + lexical"
                    } else {
                        "lexical only"
                    }
                ));
                if let Some(reason) = &ev.vector_reason {
                    c.push_str(&format!(" ({})", reason));
                }
                if total_frames > 0 {
                    c.push_str(&format!(
                        "; {} of {} saved keyframes shown",
                        crops.len(),
                        total_frames
                    ));
                }
                c.push_str(" -- anything outside this selection was NOT read this turn]");
                block.push_str(&c);
            }
            block.push_str(&rank_line(&opts, &ev.vector_mode));
            block.push('\n');
            block.push_str(&rules(r));
            block.push_str("\n</knowledge_index>");
            turn_used += js_len(&block) as f64;
            blocks.push(block);
            doc_images.extend(crops);
            continue;
        }
        if ev.text.is_empty() {
            continue;
        }

        // F14: machine-readable COVERAGE inside the block the model reads
        // (byte-identical to turn.ts). Numbers come from THIS turn's
        // retrieval; the ranking mode is reported honestly, so a lexical-only
        // pass is never dressed up as semantic retrieval.
        let frames = nearest_frames(root, &index, &ev.frame_ats);
        let doc_frames = nearest_unit_frames(root, &index, &ev.page_cues);
        let total_chunks = if index.meta.chunk_count != 0 {
            index.meta.chunk_count
        } else {
            index.chunks.len() as i64
        };
        let total_frames = index.meta.frames.len() as i64;
        let covered = {
            let mut c = format!(
                "\n[coverage: {} of {} indexed passages of \"{}\" were shown this turn",
                ev.chunk_idxs.len(),
                total_chunks,
                r.name
            );
            if ev.dropped > 0 {
                c.push_str(&format!("; {} further matched passages were withheld by this turn's budget (ask to continue and a different set is served)", ev.dropped));
            } else if ev.truncated {
                c.push_str("; more passages matched than this turn's budget could show");
            } else {
                c.push_str("; no matched passage was withheld from this turn");
            }
            c.push_str(&format!(
                "; ranking mode: {}",
                if ev.vector_mode == crate::vectors::MODE_HYBRID {
                    "semantic + lexical"
                } else {
                    "lexical only"
                }
            ));
            if let Some(reason) = &ev.vector_reason {
                c.push_str(&format!(" ({})", reason));
            }
            if total_frames > 0 {
                // F152: doc frames shown this turn count alongside keyframes —
                // both live in meta.frames, and TS passes
                // frames.length + docFrames.length into the same marker.
                c.push_str(&format!("; {} of {} saved keyframes shown", frames.len() + doc_frames.len(), total_frames));
            }
            c.push_str(" -- anything outside this selection was NOT read this turn]");
            c
        };

        let mut block = format!(
            "<knowledge_index name=\"{name}\">\nPassages relevant to this question, retrieved from \"{name}\" (its complete text is preserved locally — the passages below are the parts the retrieval matched):\n{text}",
            name = r.name,
            text = ev.text,
        );
        // F152: the close re-read rides the evidence block AFTER the passages
        // and BEFORE the dropped/truncated conditionals — byte-placed as in
        // turn.ts, each entry naming its region and engine.
        if !reread_lines.is_empty() {
            block.push_str("\n[close re-read this turn: only the requested picture(s) were inspected again; each entry names its region and engine]\n");
            block.push_str(&reread_lines.join("\n"));
        }
        if ev.dropped > 0 {
            // I20: the exact count of candidates the budget refused — and
            // the promise of a DIFFERENT set on the follow-up is real
            // because the shown ledger below demotes what ran this time.
            block.push_str(&format!(
                "\n[{} more relevant passages exist in this document that this turn's budget did not show — ask to continue and a different set is served]",
                ev.dropped
            ));
        } else if ev.truncated {
            block.push_str(
                "\n[more relevant passages exist; this turn's budget showed the best ones]",
            );
        }
        block.push_str(&covered);
        // D-058/D-068: the reranker's own honesty line, kept OUT of the
        // mirrored [coverage: ...] marker, ASCII-only, byte-identical to
        // turn.ts's rankLine.
        block.push_str(&rank_line(&opts, &ev.vector_mode));
        block.push('\n');
        block.push_str(&rules(r));
        block.push_str("\n</knowledge_index>");

        turn_used += js_len(&ev.text) as f64;
        if !ev.chunk_idxs.is_empty() {
            // `[...new Set([...shown, ...ev.chunkIdxs])]` — shown first,
            // the Set keeps insertion order.
            let mut seen: HashSet<i64> = HashSet::new();
            let merged: Vec<i64> = shown_for
                .into_iter()
                .chain(ev.chunk_idxs.iter().copied())
                .filter(|id| seen.insert(*id))
                .collect();
            store::write_shown(root, &r.att_id, &merged, conversation, Some(&query_fp));
        }
        blocks.push(block);
        images.extend(frames);
        doc_images.extend(doc_frames);
    }

    if blocks.is_empty() && images.is_empty() && doc_images.is_empty() {
        return Ok(0);
    }

    if !images.is_empty() || !doc_images.is_empty() {
        if let Some(msg) = messages.get_mut(user_idx) {
            let mut parts: Vec<Value> = match msg.get("content") {
                Some(Value::Array(arr)) => arr.clone(),
                Some(Value::String(s)) => vec![json!({ "type": "text", "text": s.clone() })],
                _ => vec![json!({ "type": "text", "text": "" })],
            };
            if !images.is_empty() {
                parts.push(json!({ "type": "text", "text": FRAME_LEAD_IN }));
                for (url, _) in &images {
                    parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
                }
            }
            if !doc_images.is_empty() {
                // F152: the indexed document's drawn content, paired to the
                // passages that name its unit (see nearest_unit_frames).
                // Video lead-in bytes untouched.
                parts.push(json!({ "type": "text", "text": DOC_FRAMES_LEAD_IN }));
                for (url, _, label) in &doc_images {
                    parts.push(json!({ "type": "text", "text": format!("{label} — drawn content:") }));
                    parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
                }
            }
            // `msg.content = parts` — a non-object entry would TypeError in
            // TS too (never produced by the history loader).
            if let Some(obj) = msg.as_object_mut() {
                obj.insert("content".into(), Value::Array(parts));
            }
        }
    }
    if !blocks.is_empty() {
        inject_system_before(messages, user_idx, blocks.join("\n\n"));
    }
    // Images-only turns still return the BLOCK count (0) — the chat route
    // then emits retrieval_done{done:0,total:0} even though frames landed.
    Ok(blocks.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FixedEmbedder, UnavailableEmbedder};

    fn ref_of(att: &str, name: &str, category: &str) -> AttachmentRef {
        AttachmentRef {
            att_id: att.into(),
            name: name.into(),
            category: category.into(),
        }
    }

    #[test]
    fn b64_matches_node_tostring_base64() {
        assert_eq!(b64_std(b""), "");
        assert_eq!(b64_std(b"f"), "Zg==");
        assert_eq!(b64_std(b"fo"), "Zm8=");
        assert_eq!(b64_std(b"foo"), "Zm9v");
        assert_eq!(b64_std(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64_std(b"hello"), "aGVsbG8=");
        assert_eq!(b64_std(b"ABC"), "QUJD");
        // High bytes: 0xFF 0xD8 (JPEG SOI head) — standard alphabet, no line breaks.
        assert_eq!(b64_std(&[0xFF, 0xD8]), "/9g=");
    }

    #[test]
    fn collect_refs_table() {
        let msgs = vec![
            json!({ "role": "user", "content": "plain string" }),
            json!({ "role": "user", "content": [
                { "type": "attachment_ref", "att_id": "att_bad", "name": "too-short-tail" },
                { "type": "attachment_ref", "att_id": "ATT_CAPS1", "name": "caps" },
                { "type": "attachment_ref", "att_id": "att_golden1a", "name": "Notes", "category": "audio" },
                { "type": "attachment_ref", "att_id": "att_golden1a", "name": "Second wins?" },
                { "type": "attachment_ref", "att_id": "att_golden1c", "name": "", "category": 5 },
                { "type": "text", "text": "hi" },
            ] }),
            json!({ "role": "assistant", "content": null }),
        ];
        let refs = collect_attachment_refs(&msgs);
        assert_eq!(
            refs,
            vec![
                ref_of("att_golden1a", "Notes", "audio"),
                // empty name ⇒ att id; non-string category ⇒ "text"
                ref_of("att_golden1c", "att_golden1c", "text"),
            ],
        );
    }

    #[test]
    fn rules_variant_boundaries_are_exact() {
        let v = rules(&ref_of("att_x1", "V", "video"));
        // The base ends "…was processed. ", the F76 numeric-fidelity law rides
        // next, then the variant starts "This video's…" — one space at each
        // boundary, no re-flowing.
        assert!(v.contains("do not explain how the content was processed. When quoting a figure from the material, keep its exact digits and digit grouping."));
        // F152 Part 4 wording law: rides the base (EVERY category), one space
        // at each boundary — never re-flowed.
        assert!(v.contains("whenever it covers the question. Answer directly in the form the question asked for."));
        assert!(v.contains("they are diagnostics, not the conversation. Where passages carry [HH:MM:SS - HH:MM:SS] headers"));
        assert!(v.contains("never give two versions of one figure that have different values. This applies to every restated version anywhere in the answer, including brief asides. This video's complete saved record is kept locally and you are shown the parts of it that matter to this question"));
        assert!(v.ends_with("when a time reference genuinely helps."));
        // The law rides every category, not just video.
        let doc = rules(&ref_of("att_x1", "D", "document"));
        assert!(doc.contains("When quoting a figure from the material") && doc.contains("including brief asides. You have read this document directly"));
        assert!(doc.contains("never blame the user for how the file was made, never say the file's content was not given to you"));
        let a = rules(&ref_of("att_x1", "A", "audio"));
        assert!(a.ends_with("This recording's complete saved record is kept locally and you are shown the parts that matter to this question: speak of what the recording says; never claim to have heard it yourself, and never mention transcription, retrieval or indexing."));
        let d = rules(&ref_of("att_x1", "D", "document"));
        assert!(d.ends_with(
            "You have read this document directly; never mention retrieval or indexing."
        ));
    }

    #[test]
    fn anchor_query_table() {
        let msgs = vec![
            json!({ "role": "user", "content": [
                { "type": "attachment_ref", "att_id": "att_golden1a" },
                { "type": "text", "text": "Explain osmosis in cells" },
            ] }),
            json!({ "role": "assistant", "content": "Sure." }),
        ];
        // Short follow-up anchors onto the previous user turn's text part.
        assert_eq!(
            anchor_query("why does that happen", &msgs, 2),
            "Explain osmosis in cells why does that happen"
        );
        // Empty question returns trimmed-empty.
        assert_eq!(anchor_query("   ", &msgs, 2), "");
        // Long question with few pronouns stays verbatim.
        let long = "Please walk me through the entire photosynthetic light reaction chain in careful detail";
        assert_eq!(anchor_query(long, &msgs, 2), long);
        // user_idx 0 ⇒ nothing before it to scan ⇒ verbatim.
        assert_eq!(anchor_query("and now?", &msgs, 0), "and now?");
        // Empty-content user turns do NOT stop the backward scan (quirk).
        let msgs2 = vec![
            json!({ "role": "user", "content": "Earlier topic here" }),
            json!({ "role": "user", "content": [] }),
        ];
        assert_eq!(
            anchor_query("but why", &msgs2, 2),
            "Earlier topic here but why"
        );
    }

    #[test]
    fn anchor_pronoun_heavy_long_query() {
        let msgs = vec![
            json!({ "role": "user", "content": "Mitosis phases" }),
            json!(null),
        ];
        // 75 chars, pronouns: "why" "it" "that" ⇒ >= 2 ⇒ anchored despite length.
        let q = "why does it do that there during this phase, explain it again please now";
        assert!(js_len(q) >= FOLLOWUP_MAX && js_len(q) < 140);
        assert_eq!(anchor_query(q, &msgs, 1), format!("Mitosis phases {q}"));
    }

    #[test]
    fn nearest_frames_used_before_read_and_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = store::index_dir(root, "att_frame1").unwrap();
        std::fs::create_dir_all(dir.join("frames")).unwrap();
        std::fs::write(dir.join("frames/f1.jpg"), b"ABC").unwrap();
        // f2 intentionally missing on disk.
        let mut index = LoadedIndex::default();
        index.meta.att_id = "att_frame1".into();
        index.meta.frames = vec![
            crate::types::FrameEntry {
                at: 100.0,
                file: "frames/f1.jpg".into(),
                ..Default::default()
            },
            crate::types::FrameEntry {
                at: 200.0,
                file: "frames/missing.jpg".into(),
                ..Default::default()
            },
        ];

        // Nearest pick is used BEFORE the read: the second lookup of the
        // same timestamp must try frame 2 (missing) and get nothing.
        let out = nearest_frames(root, &index, &[105.0, 105.0]);
        assert_eq!(
            out,
            vec![("data:image/jpeg;base64,QUJD".to_string(), 100.0)]
        );

        // All-used ⇒ break out of the timestamp loop.
        let out = nearest_frames(root, &index, &[105.0, 105.0, 105.0]);
        assert_eq!(out.len(), 1);

        // Missing-file read: slot consumed, nothing emitted, loop ends.
        let out = nearest_frames(root, &index, &[195.0]);
        assert!(out.is_empty());
    }

    #[test]
    fn unit_frames_pair_exact_labelled_and_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = store::index_dir(root, "att_unit1").unwrap();
        std::fs::create_dir_all(dir.join("frames")).unwrap();
        std::fs::write(dir.join("frames/d_001.png"), b"ABC").unwrap();
        std::fs::write(dir.join("frames/d_002.jpg"), b"AB").unwrap();
        std::fs::write(dir.join("frames/d_003.png"), b"A").unwrap();
        let mut index = LoadedIndex::default();
        index.meta.att_id = "att_unit1".into();
        index.meta.frames = vec![
            crate::types::FrameEntry {
                at: 1.0,
                file: "frames/d_001.png".into(),
                label: Some("slide 1".into()),
                region: Some("pptx:1:ppt/media/image-3-1.png".into()),
                ..Default::default()
            },
            crate::types::FrameEntry {
                at: 1.0,
                file: "frames/d_003.png".into(),
                label: Some("slide 1".into()),
                ..Default::default()
            },
            // Video keyframe on the seconds axis: NEVER qualifies on the unit axis.
            crate::types::FrameEntry {
                at: 3.0,
                file: "frames/d_002.jpg".into(),
                ..Default::default()
            },
            // Missing on disk: slot consumed, honest degradation.
            crate::types::FrameEntry {
                at: 9.0,
                file: "frames/gone.png".into(),
                label: Some("page 9".into()),
                ..Default::default()
            },
        ];

        // Exact unit match only: cue 3 has NO labelled frame (the jpg has no
        // label) ⇒ nothing served; cue 1 serves BOTH of its regions.
        let out = nearest_unit_frames(root, &index, &[3.0]);
        assert!(out.is_empty());
        let out = nearest_unit_frames(root, &index, &[1.0]);
        assert_eq!(
            out,
            vec![
                ("data:image/png;base64,QUJD".to_string(), 1.0, "slide 1".to_string()),
                ("data:image/png;base64,QQ==".to_string(), 1.0, "slide 1".to_string()),
            ],
        );
        // Used-set dedup: cue 1 twice serves each region once.
        assert_eq!(nearest_unit_frames(root, &index, &[1.0, 1.0]).len(), 2);
        // Missing-file cue: slot consumed, nothing emitted.
        assert!(nearest_unit_frames(root, &index, &[9.0]).is_empty());
        // MAX_FRAMES cap across cues.
        let out = nearest_unit_frames(root, &index, &[1.0, 1.0, 1.0]);
        assert!(out.len() <= MAX_FRAMES);
    }

    #[test]
    fn nearest_frames_serves_png_by_extension() {
        // F153 item 4 mime law: a durable seek frame ("s_%05d.png") serves
        // as image/png; a build keyframe ("f_%05d.jpg") stays image/jpeg.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = store::index_dir(root, "att_frame3").unwrap();
        std::fs::create_dir_all(dir.join("frames")).unwrap();
        std::fs::write(dir.join("frames/s_00000.png"), b"ABC").unwrap();
        std::fs::write(dir.join("frames/f_00000.jpg"), b"ABC").unwrap();
        let mut index = LoadedIndex::default();
        index.meta.att_id = "att_frame3".into();
        index.meta.frames = vec![
            crate::types::FrameEntry { at: 100.0, file: "frames/s_00000.png".into(), ..Default::default() },
            crate::types::FrameEntry { at: 130.0, file: "frames/f_00000.jpg".into(), ..Default::default() },
        ];
        assert_eq!(
            nearest_frames(root, &index, &[105.0]),
            vec![("data:image/png;base64,QUJD".to_string(), 100.0)]
        );
        assert_eq!(
            nearest_frames(root, &index, &[135.0]),
            vec![("data:image/jpeg;base64,QUJD".to_string(), 130.0)]
        );
    }

    #[test]
    fn nearest_frames_cap_four() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = store::index_dir(root, "att_frame2").unwrap();
        std::fs::create_dir_all(dir.join("frames")).unwrap();
        let mut index = LoadedIndex::default();
        index.meta.att_id = "att_frame2".into();
        for k in 0..6 {
            std::fs::write(dir.join("frames").join(format!("f{k}.jpg")), b"x").unwrap();
            index.meta.frames.push(crate::types::FrameEntry {
                at: k as f64 * 10.0,
                file: format!("frames/f{k}.jpg"),
                ..Default::default()
            });
        }
        let ats: Vec<f64> = (0..6).map(|k| k as f64 * 10.0).collect();
        assert_eq!(nearest_frames(root, &index, &ats).len(), MAX_FRAMES);
    }

    // ---- async build_attachment_turn tests -----------------------------

    fn dummy_llm() -> NotesLlm {
        NotesLlm {
            url: "http://127.0.0.1:1/x".into(),
            key: "k".into(),
            model: "default".into(),
            admission: std::sync::Arc::new(ruke_core::admission::UpstreamAdmission::new()),
        }
    }

    fn user_with_ref(att: &str, name: &str, category: &str) -> Vec<Value> {
        vec![json!({ "role": "user", "content": [
            { "type": "attachment_ref", "att_id": att, "name": name, "category": category },
        ] })]
    }

    async fn build(
        msgs: &mut Vec<Value>,
        user_idx: usize,
        q: &str,
        root: &Path,
        embedder: &dyn QueryEmbedder,
        token: &CancellationToken,
    ) -> Result<usize, Cancelled> {
        let http = reqwest::Client::new();
        build_attachment_turn(
            msgs,
            user_idx,
            q,
            root,
            embedder,
            &http,
            &dummy_llm(),
            token,
            None,
            None, // F152: no reread transport wired — goldens stay byte-identical
            None, // F153: no fresh-audio seam wired — goldens stay byte-identical
            None, // F153 item 4: no visual-seam wired — goldens stay byte-identical
        )
        .await
    }

    #[tokio::test]
    async fn missing_index_emits_the_exact_honest_block() {
        let tmp = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let mut msgs = user_with_ref("att_gone01", "Bio I", "document");
        let n = build(&mut msgs, 0, "", tmp.path(), &FixedEmbedder(vec![]), &token)
            .await
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(msgs.len(), 2); // system injected BEFORE the user turn
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(
            msgs[0]["content"].as_str().unwrap(),
            "<knowledge_index name=\"Bio I\">\nThe local knowledge index for this attachment is no longer available on disk. Say so honestly if the question needs it.\n</knowledge_index>",
        );
        // The user turn is untouched (no frames without an index).
        assert!(
            msgs[1]["content"].as_array().unwrap()[0]["type"]
                .as_str()
                .unwrap()
                == "attachment_ref"
        );
    }

    fn seed_index(
        root: &Path,
        att: &str,
        category: &str,
        meta_extra: &str,
        chunks_jsonl: &str,
        frames: &[(&str, &[u8])],
    ) {
        let dir = store::index_dir(root, att).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        // `meta_extra` is a JSON tail beginning with `,` (or empty) — a
        // trailing comma before `}` would make the file unparseable.
        let meta = format!(
            "{{\n  \"attId\": \"{att}\",\n  \"name\": \"Seed\",\n  \"category\": \"{category}\",\n  \"createdAt\": 1,\n  \"chunkCount\": 1,\n  \"spine\": \"\"{meta_extra}\n}}\n"
        );
        std::fs::write(dir.join("meta.json"), meta).unwrap();
        if !chunks_jsonl.is_empty() {
            std::fs::write(dir.join("chunks.jsonl"), format!("{chunks_jsonl}\n")).unwrap();
        }
        for (file, bytes) in frames {
            let p = dir.join(file);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, bytes).unwrap();
        }
    }

    #[tokio::test]
    async fn hybrid_block_and_frame_injection_into_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_index(
            root,
            "att_doc99",
            "document",
            ",\n  \"frames\": [{ \"at\": 10.0, \"file\": \"frames/f1.jpg\" }]",
            "{ \"i\": 0, \"startSec\": 10.0, \"endSec\": 20.0, \"text\": \"mitosis cells divide\", \"vec\": [1.0, 0.0, 0.0] }",
            &[("frames/f1.jpg", b"hello")],
        );
        let token = CancellationToken::new();
        let mut msgs = user_with_ref("att_doc99", "Doc", "document");
        let n = build(
            &mut msgs,
            0,
            "mitosis",
            root,
            &FixedEmbedder(vec![1.0, 0.0, 0.05]),
            &token,
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(msgs.len(), 2);
        let sys = msgs[0]["content"].as_str().unwrap();
        assert!(sys.starts_with("<knowledge_index name=\"Doc\">\nPassages relevant to this question, retrieved from \"Doc\" (its complete text is preserved locally — the passages below are the parts the retrieval matched):\n[00:00:10 - 00:00:20]\nmitosis cells divide\n"));
        assert!(sys.ends_with("You have read this document directly; never mention retrieval or indexing.\n</knowledge_index>"));
        let parts = msgs[1]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0]["type"], "attachment_ref"); // strip runs LATER (shared impl)
        assert_eq!(parts[1]["text"].as_str().unwrap(), FRAME_LEAD_IN);
        assert_eq!(parts[1]["type"], "text");
        assert_eq!(
            parts[2]["image_url"]["url"].as_str().unwrap(),
            "data:image/jpeg;base64,aGVsbG8="
        );
    }

    #[tokio::test]
    async fn unavailable_embedder_degrades_to_bm25_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_index(
            root,
            "att_doc98",
            "document",
            "",
            "{ \"i\": 0, \"text\": \"mitosis cells divide\", \"vec\": [] }",
            &[],
        );
        let token = CancellationToken::new();
        let mut msgs = user_with_ref("att_doc98", "Doc", "document");
        let n = build(&mut msgs, 0, "mitosis", root, &UnavailableEmbedder, &token)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn whole_video_uses_cached_notes_and_never_falls_through() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_index(
            root,
            "att_wv99",
            "video",
            "",
            "{ \"i\": 0, \"text\": \"topic passage\", \"vec\": [] }",
            &[],
        );
        // Cached notes via the store's own writer (unit test — fixture
        // restrictions apply only to the golden store fixture). I24: the
        // cache only reads back under the fingerprint it was written at.
        let seeded = store::read_index(root, "att_wv99").unwrap();
        let ver = notes_version(&seeded, "default"); // matches dummy_llm
        store::write_notes(root, "att_wv99", "Cell cycle notes here.", Some(&ver)).unwrap();
        let token = CancellationToken::new();
        let mut msgs = user_with_ref("att_wv99", "Vid", "video");
        let n = build(
            &mut msgs,
            0,
            "give me a summary",
            root,
            &UnavailableEmbedder,
            &token,
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let sys = msgs[0]["content"].as_str().unwrap();
        assert!(sys.starts_with("<course_notes name=\"Vid\">\nCourse notes distilled from the extracted content of \"Vid\":\nCell cycle notes here.\n"));
        assert!(sys.contains("Cite the [HH:MM:SS] block headers of the notes.\n</course_notes>"));
        assert!(sys.contains("This video's complete saved record is kept locally"));
        // No hybrid knowledge_index block (turn.ts:188 unconditional continue).
        assert!(!sys.contains("Passages relevant to this question"));
        assert!(!sys.contains("<knowledge_index"));
    }

    #[tokio::test]
    async fn whole_video_empty_notes_yields_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // No spine blocks ⇒ generate_notes returns Ok("") (no network).
        seed_index(
            root,
            "att_wv98",
            "video",
            "",
            "{ \"i\": 0, \"text\": \"topic\", \"vec\": [] }",
            &[],
        );
        let token = CancellationToken::new();
        let mut msgs = user_with_ref("att_wv98", "Vid", "video");
        let n = build(
            &mut msgs,
            0,
            "give me a summary",
            root,
            &UnavailableEmbedder,
            &token,
        )
        .await
        .unwrap();
        assert_eq!(n, 0);
        assert_eq!(msgs.len(), 1); // nothing injected
    }

    // ---- I20: dropped marker + shown-ledger rotation -------------------
    #[tokio::test]
    async fn dropped_marker_shown_ledger_and_demote_rotation_i20() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // 30 chunks of EXACTLY 1200 chars, untimed (no headers) and vec
        // -less; pack costs: 1200 for the first, 1202 for each follow-on.
        let mut lines = String::new();
        for i in 0..30 {
            let head = format!("widget {i} ");
            let text = format!("{}{}", head, "x".repeat(1200 - head.len()));
            lines.push_str(&format!(
                "{{ \"i\": {i}, \"text\": \"{text}\", \"vec\": [] }}\n"
            ));
        }
        seed_index(root, "att_ledg01", "document", "", lines.trim_end(), &[]);
        let token = CancellationToken::new();

        // Run 1: per-ref budget 24000 (default): 1200 + 18×1202 = 22836
        // fits, the 19th passage costs 22836+1202 = 24038 > 24000 ⇒ 19.
        let mut msgs = user_with_ref("att_ledg01", "Led", "document");
        let n = build(
            &mut msgs,
            0,
            "list every mention of widget",
            root,
            &UnavailableEmbedder,
            &token,
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let sys = msgs[0]["content"].as_str().unwrap();
        assert!(sys.contains("widget 0 "), "{sys}");
        assert!(!sys.contains("widget 19 "), "{sys}");
        assert!(sys.contains("[11 more relevant passages exist in this document that this turn's budget did not show — ask to continue and a different set is served]"), "{sys}");
        assert_eq!(store::read_shown(root, "att_ledg01", None).len(), 19);

        // Run 2: the 19 shown passages demote; the 11 fresh fit
        // (1200 + 10×1202 = 13220) ⇒ a DIFFERENT set, exactly as the
        // marker promised. The held set stays unserved (budget fits).
        let mut msgs2 = user_with_ref("att_ledg01", "Led", "document");
        let n = build(
            &mut msgs2,
            0,
            "list every mention of widget",
            root,
            &UnavailableEmbedder,
            &token,
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let sys2 = msgs2[0]["content"].as_str().unwrap();
        assert!(sys2.contains("widget 19 "), "{sys2}");
        assert!(!sys2.contains("widget 0 "), "{sys2}");
        assert!(sys2.contains("[19 more relevant passages exist in this document that this turn's budget did not show — ask to continue and a different set is served]"), "{sys2}");
        assert_eq!(store::read_shown(root, "att_ledg01", None).len(), 30);
    }

    // ---- F07 turn layer: query-scoped ledger, raw-first, index axis ----

    fn system_text(msgs: &[Value]) -> String {
        msgs.iter()
            .filter(|m| m["role"].as_str() == Some("system"))
            .filter_map(|m| m["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Which marker phrases actually reached the model-visible block. The
    /// passages below are deliberately huge, so dumping the block on failure
    /// would bury the diff; the marker set IS the observable behaviour.
    fn served_words(sys: &str, words: &[&'static str]) -> Vec<&'static str> {
        words.iter().copied().filter(|w| sys.contains(w)).collect()
    }

    /// `padTo` in the TS oracle: a fixed-width passage.
    fn pad_to(s: &str, n: usize) -> String {
        let l = s.chars().count();
        if l >= n {
            s.chars().take(n).collect()
        } else {
            format!("{}{}", s, "q".repeat(n - l))
        }
    }

    /// Mirror of the TS `seedText` fixtures: every passage is WIDTH characters,
    /// so the per-reference budget serves exactly ONE of them and "which
    /// passage was served" is directly observable in the injected block. A
    /// ledger that demotes the WRONG chunk therefore changes the answer the
    /// model sees, not merely a debug counter.
    fn seed_padded(root: &Path, att: &str, category: &str, texts: &[&str], width: usize) {
        let mut lines = String::new();
        for (i, t) in texts.iter().enumerate() {
            lines.push_str(&format!(
                "{{ \"i\": {i}, \"text\": \"{}\", \"vec\": [] }}\n",
                pad_to(t, width)
            ));
        }
        seed_index(root, att, category, "", lines.trim_end(), &[]);
    }

    fn user_text_and_ref(att: &str, text: &str) -> Value {
        json!({ "role": "user", "content": [
            { "type": "text", "text": text },
            { "type": "attachment_ref", "att_id": att, "name": att, "category": "document" },
        ] })
    }

    async fn build_conv(
        msgs: &mut Vec<Value>,
        user_idx: usize,
        q: &str,
        root: &Path,
        embedder: &dyn QueryEmbedder,
        token: &CancellationToken,
        conversation: Option<&str>,
    ) -> Result<usize, Cancelled> {
        let http = reqwest::Client::new();
        build_attachment_turn(
            msgs,
            user_idx,
            q,
            root,
            embedder,
            &http,
            &dummy_llm(),
            token,
            conversation,
            None, // F152: no reread transport wired — goldens stay byte-identical
            None, // F153: no fresh-audio seam wired — goldens stay byte-identical
            None, // F153 item 4: no visual-seam wired — goldens stay byte-identical
        )
        .await
    }

    /// F07 (reproduced): "repeated exact questions lose their answer because
    /// previously shown evidence is demoted below unrelated fresh text". The
    /// ledger records WHICH query produced it and which conversation owns it,
    /// so an exact repeat gets its own passages BACK while an explicit
    /// continuation ask still rotates to fresh material.
    #[tokio::test]
    async fn query_scoped_ledger_serves_a_repeat_its_own_answer_f07() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_padded(
            root,
            "att_f07rpt01",
            "document",
            &[
                "widget f07zero rating scale explanation ",
                "widget f07one rating scale explanation ",
                "widget f07two rating scale explanation ",
            ],
            13000,
        );
        let token = CancellationToken::new();
        let rep_q =
            "According to the indexed document, which passage explains the widget rating scale?";

        // Turn 1: one passage fits the per-reference budget, and the ledger
        // belongs to conv_a (never the bare attachment key).
        let mut m1 = vec![user_text_and_ref("att_f07rpt01", rep_q)];
        let n = build_conv(
            &mut m1,
            0,
            rep_q,
            root,
            &UnavailableEmbedder,
            &token,
            Some("conv_a"),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(served_words(&system_text(&m1), &["f07zero", "f07one", "f07two"]), ["f07zero"]);
        assert_eq!(
            store::read_shown(root, "att_f07rpt01", Some("conv_a")),
            vec![0i64]
        );

        // Turn 2: the SAME question in the SAME conversation gets its own
        // passage back. Before F07 the ledger demoted it and the model got a
        // different, weaker chunk instead of the answer it had already been
        // given.
        let mut m2 = vec![user_text_and_ref("att_f07rpt01", rep_q)];
        let n = build_conv(
            &mut m2,
            0,
            rep_q,
            root,
            &UnavailableEmbedder,
            &token,
            Some("conv_a"),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(served_words(&system_text(&m2), &["f07zero", "f07one", "f07two"]), ["f07zero"]);
        assert_eq!(
            store::read_shown(root, "att_f07rpt01", Some("conv_a")),
            vec![0i64]
        );

        // Turn 3: an EXPLICIT continuation ask does rotate -- "other passages"
        // is the request for material this conversation has not seen.
        let cq = "show me other passages of the indexed document about widget ratings";
        assert!(is_continuation_ask(cq));
        let mut m3 = vec![user_text_and_ref("att_f07rpt01", cq)];
        let n = build_conv(
            &mut m3,
            0,
            cq,
            root,
            &UnavailableEmbedder,
            &token,
            Some("conv_a"),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(served_words(&system_text(&m3), &["f07zero", "f07one", "f07two"]), ["f07one"]);
        assert_eq!(
            store::read_shown(root, "att_f07rpt01", Some("conv_a")),
            vec![0i64, 1]
        );

        // Turn 4: ANOTHER conversation is never demoted by conv_a's list. Its
        // own ledger starts empty.
        let mut m4 = vec![user_text_and_ref("att_f07rpt01", rep_q)];
        let n = build_conv(
            &mut m4,
            0,
            rep_q,
            root,
            &UnavailableEmbedder,
            &token,
            Some("conv_b"),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(served_words(&system_text(&m4), &["f07zero", "f07one", "f07two"]), ["f07zero"]);
        assert_eq!(store::read_shown(root, "att_f07rpt01", Some("conv_b")), vec![0i64]);
        assert_eq!(
            store::read_shown(root, "att_f07rpt01", Some("conv_a")),
            vec![0i64, 1]
        );
    }

    /// F07 (reproduced): "an unrelated short CPU question gets a previous whale
    /// question prepended". Retrieval is RAW-FIRST; the antecedent survives only
    /// as a bounded fallback when the raw question matched nothing.
    #[tokio::test]
    async fn unrelated_followup_is_not_glued_onto_the_previous_topic_f07() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_padded(
            root,
            "att_f07top01",
            "document",
            &[
                "whale migration routes cross the southern ocean every season ",
                "the cpu fan noise rises when the laptop is under heavy load ",
                "whale calves travel with their pods along the same route ",
            ],
            13000,
        );
        let token = CancellationToken::new();
        let mut msgs = vec![
            json!({ "role": "user", "content": [
                { "type": "text", "text": "why do whales migrate along the southern ocean every year" }
            ] }),
            json!({ "role": "assistant", "content": "because of feeding grounds and water temperature." }),
            user_text_and_ref("att_f07top01", "and the cpu fan noise?"),
        ];
        let n = build_conv(
            &mut msgs,
            2,
            "and the cpu fan noise?",
            root,
            &UnavailableEmbedder,
            &token,
            Some("conv_t"),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        // The block lands immediately BEFORE the user turn it belongs to.
        assert_eq!(msgs[2]["role"].as_str().unwrap(), "system");
        assert_eq!(msgs[3]["role"].as_str().unwrap(), "user");
        assert_eq!(
            served_words(&system_text(&msgs), &["cpu fan", "whale"]),
            ["cpu fan"]
        );
    }

    /// The other half of the same law: when the raw question genuinely matches
    /// NOTHING, the conversation's own topic is still consulted -- the fix must
    /// not turn a real follow-up into an empty answer.
    #[tokio::test]
    async fn an_unanswerable_followup_still_falls_back_to_its_antecedent_f07() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_padded(
            root,
            "att_f07top02",
            "document",
            &[
                "whale migration routes cross the southern ocean every season ",
                "the cpu fan noise rises when the laptop is under heavy load ",
                "whale calves travel with their pods along the same route ",
            ],
            13000,
        );
        let token = CancellationToken::new();
        let mut msgs = vec![
            json!({ "role": "user", "content": [
                { "type": "text", "text": "why do whales migrate along the southern ocean every year" }
            ] }),
            json!({ "role": "assistant", "content": "because of feeding grounds." }),
            user_text_and_ref("att_f07top02", "and in winter?"),
        ];
        let n = build_conv(
            &mut msgs,
            2,
            "and in winter?",
            root,
            &UnavailableEmbedder,
            &token,
            Some("conv_u"),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        assert_eq!(
            served_words(&system_text(&msgs), &["whale migration", "cpu fan"]),
            ["whale migration"]
        );
    }

    /// F07: the time axis belongs to the CONTENT. A document that merely talks
    /// about a "1:20 aspect ratio" has no timeline, so no window may be
    /// invented for it and the passage must still be served.
    #[tokio::test]
    async fn a_document_without_a_timeline_never_routes_to_a_time_window_f07() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_padded(
            root,
            "att_f07doc01",
            "document",
            &["the chart caption states a 1:20 aspect ratio for the figure "],
            13000,
        );
        let token = CancellationToken::new();
        let q = "what does the 1:20 aspect ratio mean in the chart caption";
        let mut msgs = vec![user_text_and_ref("att_f07doc01", q)];
        let n = build_conv(
            &mut msgs,
            0,
            q,
            root,
            &UnavailableEmbedder,
            &token,
            Some("conv_v"),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let sys = system_text(&msgs);
        assert_eq!(served_words(&sys, &["aspect ratio"]), ["aspect ratio"]);
        // No [HH:MM:SS - HH:MM:SS] header was invented for untimed content.
        assert!(!sys.contains("[00:0"), "fabricated time header in {q}");
    }

    /// ...while content that DOES carry a timeline still resolves an explicit
    /// cue, and the window excludes what lies outside it.
    #[tokio::test]
    async fn a_timeline_bearing_attachment_resolves_an_explicit_cue_f07() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut lines = String::new();
        for i in 0..6i64 {
            lines.push_str(&format!(
                "{{ \"i\": {i}, \"startSec\": {}, \"endSec\": {}, \"text\": \"{}\", \"vec\": [] }}\n",
                i * 100,
                i * 100 + 90,
                pad_to(&format!("clip segment {i} about widget thing {i} "), 190)
            ));
        }
        seed_index(
            root,
            "att_f07vid01",
            "video",
            ",\n  \"durationSec\": 600.0",
            lines.trim_end(),
            &[],
        );
        let token = CancellationToken::new();
        let q = "what happens in the clip at 5:30";
        let mut msgs = vec![json!({ "role": "user", "content": [
            { "type": "text", "text": q },
            { "type": "attachment_ref", "att_id": "att_f07vid01", "name": "att_f07vid01", "category": "video" },
        ] })];
        let n = build_conv(
            &mut msgs,
            0,
            q,
            root,
            &UnavailableEmbedder,
            &token,
            Some("conv_w"),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let sys = system_text(&msgs);
        // 5:30 = 330s, +-180s => [150, 510]; segment 0 (0-90) lies outside it.
        assert!(sys.contains("[00:01:40 - 00:03:10]"), "missing window header");
        assert!(!sys.contains("clip segment 0 "), "cue window swept in an out-of-range segment");
        assert!(sys.contains("clip segment 1 "), "cue window served nothing adjacent");
    }

    // ---- I05: the turn-wide budget, honestly reported ------------------
    #[tokio::test]
    async fn exhausted_turn_budget_serves_the_honest_block_i05() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Three whole_video attachments with oversized cached notes: the
        // default turn budget (48000, env untouched) fits TWO sliced
        // notes — 24005 after the first (slice + "\n[...]"), 48005 after
        // the second (cap 23995) — so the third MUST get the honest
        // exhausted block instead of a silently-thinned notes block.
        // ATT_RE needs a 4–32 char tail — `att_x1` would fail valid_att_id
        // and seed_index would seed nothing (the index_dir None throw).
        for att in ["att_budg01", "att_budg02", "att_budg03"] {
            seed_index(
                root,
                att,
                "video",
                "",
                "{ \"i\": 0, \"text\": \"topic\", \"vec\": [] }",
                &[],
            );
            let idx = store::read_index(root, att).unwrap();
            let ver = notes_version(&idx, "default");
            store::write_notes(root, att, &"n".repeat(26000), Some(&ver)).unwrap();
        }
        let token = CancellationToken::new();
        let mut msgs = vec![json!({ "role": "user", "content": [
            { "type": "attachment_ref", "att_id": "att_budg01", "name": "X1", "category": "video" },
            { "type": "attachment_ref", "att_id": "att_budg02", "name": "X2", "category": "video" },
            { "type": "attachment_ref", "att_id": "att_budg03", "name": "X3", "category": "video" },
        ] })];
        let n = build(
            &mut msgs,
            0,
            "give me a summary",
            root,
            &UnavailableEmbedder,
            &token,
        )
        .await
        .unwrap();
        assert_eq!(n, 3);
        let sys = msgs[0]["content"].as_str().unwrap();
        assert!(sys.contains("<course_notes name=\"X1\">"));
        assert!(sys.contains("<course_notes name=\"X2\">"));
        assert!(sys.contains("This turn's evidence budget is already full, so no content from this attachment was retrieved for it. Ask the question again in a new turn."), "{sys}");
        assert!(!sys.contains("<course_notes name=\"X3\">"));
    }

    #[tokio::test]
    async fn cancelled_token_is_the_only_error_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_index(
            root,
            "att_wv97",
            "video",
            ",\n  \"spineBlocks\": [{ \"startSec\": 0.0, \"endSec\": 60.0, \"chunkFrom\": 0, \"chunkTo\": 0, \"keywords\": [], \"opening\": \"o\", \"closing\": \"c\" }]",
            "{ \"i\": 0, \"text\": \"body text for the block\", \"vec\": [] }",
            &[],
        );
        let token = CancellationToken::new();
        token.cancel();
        let mut msgs = user_with_ref("att_wv97", "Vid", "video");
        let r = build(
            &mut msgs,
            0,
            "give me a summary",
            root,
            &UnavailableEmbedder,
            &token,
        )
        .await;
        assert_eq!(r, Err(Cancelled));
        assert_eq!(msgs.len(), 1); // no partial injection
    }

    // ---- D-068: the [ranking: ...] honesty line -------------------------
    #[test]
    fn rank_line_mirrors_turn_ts_byte_for_byte() {
        // The default fused case: no rerank stage exists here, so the line
        // names THIS owner's route, never one runtime.
        assert_eq!(
            rank_line(&RetrieveOpts::default(), crate::vectors::MODE_HYBRID),
            "\n[ranking: the fused semantic + lexical order stands; no neural rerank ran (this retrieval owner has no neural rerank route in this deployment) -- passages the retrieval did not rank were never seen by the reranker]"
        );
        assert_eq!(
            rank_line(&RetrieveOpts::default(), crate::vectors::MODE_LEXICAL_ONLY),
            "\n[ranking: the fused lexical order stands; no neural rerank ran (this retrieval owner has no neural rerank route in this deployment) -- passages the retrieval did not rank were never seen by the reranker]"
        );
        // Structural selections: the order IS the source's structure, and the
        // three reasons are the same three `rankable: false` branches of
        // rankCandidates (retrieve.ts:221-270).
        let spine = RetrieveOpts {
            mode: QueryMode::Sequential,
            range: Some((0, 3)),
            ..Default::default()
        };
        assert!(rank_line(&spine, crate::vectors::MODE_HYBRID).contains(
            "[ranking: no neural rerank (this turn selected a spine range, so the order is reading order, not relevance) --"
        ));
        let windows = RetrieveOpts {
            mode: QueryMode::TimeRange,
            windows: vec![(10.0, 20.0)],
            from_sec: Some(10.0),
            ..Default::default()
        };
        assert!(rank_line(&windows, crate::vectors::MODE_HYBRID).contains(
            "[ranking: no neural rerank (this turn selected explicit time windows, so the order is the timeline) --"
        ));
        let span = RetrieveOpts {
            mode: QueryMode::TimeRange,
            from_sec: Some(4230.0),
            ..Default::default()
        };
        assert!(rank_line(&span, crate::vectors::MODE_HYBRID).contains(
            "[ranking: no neural rerank (this turn selected an explicit time range, so the order is the timeline) --"
        ));
        // A TimeRange ask with NO selection on either axis falls through to
        // the fused branch, exactly like rankCandidates.
        let no_axis = RetrieveOpts {
            mode: QueryMode::TimeRange,
            ..Default::default()
        };
        assert!(rank_line(&no_axis, crate::vectors::MODE_HYBRID).contains("the fused semantic + lexical order stands"));
        // The line is ASCII-only, like the [coverage: ...] marker it sits next to.
        assert!(rank_line(&span, crate::vectors::MODE_LEXICAL_ONLY).is_ascii());
    }

    // ---- F78: frames-only index + exact-time question -------------------
    // The UI runs on THIS owner; the live row "What is on screen at
    // 01:31:00?" over a frames-only index delivered ZERO evidence here while
    // the TS mirror served the frame (model answered NO in 1 s). The mirror
    // must serve the nearest saved moment with the requested-vs-sampled
    // attribution law, refuse a far moment (I18b), and un-clip an edge
    // window so the cue is the asked instant, not a clipped midpoint.
    #[tokio::test]
    async fn frames_only_time_range_serves_the_nearest_saved_moment() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_index(
            root,
            "att_f78frmr",
            "video",
            ",\n  \"durationSec\": 10800.0,\n  \"frames\": [{\"at\": 40.0, \"file\": \"frames/f40.jpg\"}, {\"at\": 5460.0, \"file\": \"frames/f5460.jpg\"}]",
            "",
            &[
                ("frames/f40.jpg", b"ABC"),
                ("frames/f5460.jpg", b"QUJD"),
            ],
        );
        // Frames-only index: the chunks file exists and is EMPTY — there is
        // no timed passage for the routed time_range question to retrieve.
        std::fs::write(
            store::index_dir(root, "att_f78frmr").unwrap().join("chunks.jsonl"),
            "",
        )
        .unwrap();
        let token = CancellationToken::new();

        // Asked 01:31:00 — the saved moment at 5460 is served with the
        // attribution law; the frame rides at the end of the user turn.
        let mut msgs = user_with_ref("att_f78frmr", "lecture.mp4", "video");
        let n = build(
            &mut msgs,
            0,
            "What is on screen at 01:31:00 in the attached video?",
            root,
            &FixedEmbedder(vec![]),
            &token,
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let sys = system_text(&msgs);
        assert!(
            sys.contains("Asked time 01:31:00: the saved moment nearest 01:31:00 is at 01:31:00 (the record holds no saved moment closer)."),
            "attribution line missing: {sys}"
        );
        assert!(sys.contains("no readable speech"), "frames-only framing missing");
        assert!(
            sys.contains("the record holds NO evidence about the time between"),
            "unconfirmable-between law missing"
        );
        assert!(sys.contains("1 of 2 saved keyframes shown"), "coverage frame count wrong");
        assert!(sys.contains("[ranking:"), "ranking honesty line missing");
        assert!(msgs[1]["content"].as_array().unwrap().iter().any(|p| p["type"] == "image_url"), "frame not injected");

        // Edge clip: a cue at 00:00:45 gives window [0, 225]; the cue is the
        // asked instant (45s), NOT the clipped midpoint (00:01:53).
        let mut msgs = user_with_ref("att_f78frmr", "lecture.mp4", "video");
        let n = build(
            &mut msgs,
            0,
            "What is on screen at 00:00:45 in the attached video?",
            root,
            &FixedEmbedder(vec![]),
            &token,
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let sys = system_text(&msgs);
        assert!(sys.contains("Asked time 00:00:45"), "edge cue mislabeled: {sys}");
        assert!(!sys.contains("Asked time 00:01:53"), "clipped midpoint labeled as the ask");

        // I18b near miss: 01:40:00 has no saved moment within 180 s —
        // honesty window refuses; NOTHING is served for the moment.
        let mut msgs = user_with_ref("att_f78frmr", "lecture.mp4", "video");
        let n = build(
            &mut msgs,
            0,
            "What is on screen at 01:40:00 in the attached video?",
            root,
            &FixedEmbedder(vec![]),
            &token,
        )
        .await
        .unwrap();
        assert_eq!(n, 0);
        assert_eq!(msgs.len(), 1, "no system block for a refused moment");
        assert!(msgs[0]["content"].as_array().unwrap().iter().all(|p| p["type"] != "image_url"));
    }
}
