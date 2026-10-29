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

use ruke_skills::jsstr::{js_len, js_slice_head, js_trim, js_truthy};
use ruke_skills::lazy::inject_system_before;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::notes::{generate_notes, Cancelled, NotesLlm};
use crate::retrieve::{notes_budget, retrieve_evidence, RetrieveOpts};
use crate::router::{count_bounded, pronoun_re, route_query, QueryMode};
use crate::store;
use crate::types::LoadedIndex;
use crate::QueryEmbedder;

const MAX_FRAMES: usize = 4;
const FOLLOWUP_MAX: usize = 60;

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
            out.push(AttachmentRef { att_id: att.to_string(), name, category });
        }
    }
    out
}

/// Standard-alphabet base64 with padding ⇔ Node `buf.toString("base64")`.
/// Hand-rolled: the workspace deliberately carries no base64 crate.
fn b64_std(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// `nearestFrames` — per timestamp, the nearest UNUSED frame (strict `<`
/// keeps the first minimum in frame order); a used slot stays consumed
/// even when its file read fails (TS `used.add` runs before the `try`).
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
        used.insert(best);
        if let Some(dir) = &dir {
            // `join(indexDir, file)` — a `file` that is absolute replaces
            // the dir in BOTH engines (documented, frozen format never emits it).
            let path = dir.join(&frames[best].file);
            if let Ok(buf) = std::fs::read(&path) {
                out.push((format!("data:image/jpeg;base64,{}", b64_std(&buf)), frames[best].at));
            }
        }
        if out.len() >= MAX_FRAMES {
            break;
        }
    }
    out
}

/// `rules(ref)` — byte-exact four-segment base + variant.
fn rules(r: &AttachmentRef) -> String {
    let is_video = r.category == "video";
    let timed = is_video || r.category == "audio";
    let mut s = String::from(concat!(
        "Rules for this content: answer from the material below whenever it covers the question. ",
        "Where passages carry [HH:MM:SS - HH:MM:SS] headers, cite that header for every claim taken from it. ",
        "If the question concerns a time range or section NOT present below, state that you cannot see that ",
        "part of the content clearly enough to answer it — do not guess, and do not explain how the content ",
        "was processed. ",
    ));
    s.push_str(if is_video {
        concat!(
            "You have watched this video from start to finish — its visuals and its speech are one thing: ",
            "speak of what you see and hear in the video as a whole. Never mention transcription, retrieval, ",
            "indexing, frames, sampled images or keyframes, and never attribute content to a particular frame. ",
            "Give timestamps only when the user asks for them or when a time reference genuinely helps.",
        )
    } else if timed {
        "You have heard this recording directly: speak of what you hear; never mention transcription, retrieval or indexing."
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
const FRAME_LEAD_IN: &str = concat!(
    "Moments from the attached video nearest to the discussed time range — they are part of the video you ",
    "watched; describe them as things that happen in the video, never as frames:",
);

/// `buildAttachmentTurn` — returns the number of injected system blocks.
/// `user_idx` is the CURRENT index of the last user message (callers pass
/// the skill-shifted index; the chat route's `lastUserIdx + 1` off-by-one
/// is RECORDED, not fixed — frames mutate `messages[userIdx]` and are
/// dropped when it points past the user turn).
///
/// The ONLY `Err` is [`Cancelled`] ⇔ the TS AbortError out of the notes
/// fetch; every other failure degrades in place exactly like the TS.
// The parameter list mirrors `buildAttachmentTurn(messages, userIdx,
// question, root, embedder, http, llm, token)` one-for-one (parity port);
// bundling the deps into a struct would rename the seam the Part-6 web
// seam will parallel.
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
) -> Result<usize, Cancelled> {
    let refs = collect_attachment_refs(messages);
    if refs.is_empty() {
        return Ok(0);
    }

    let mut blocks: Vec<String> = Vec::new();
    let mut images: Vec<(String, f64)> = Vec::new();
    let rq = anchor_query(question, messages, user_idx);

    for r in &refs {
        let index = match store::read_index(root, &r.att_id) {
            Some(index) => index,
            None => {
                blocks.push(format!(
                    "<knowledge_index name=\"{name}\">\nThe local knowledge index for this attachment is no longer available on disk. Say so honestly if the question needs it.\n</knowledge_index>",
                    name = r.name,
                ));
                continue;
            }
        };

        let routed = route_query(&rq);

        if routed.mode == QueryMode::WholeVideo {
            // `!notes` is FALSY (`""` triggers regeneration), while the
            // store returns `Some("")` — the nullish-vs-falsy split lives
            // here, not in `read_notes`.
            let mut notes = store::read_notes(root, &r.att_id);
            if !matches!(&notes, Some(s) if !s.is_empty()) {
                let gen = generate_notes(root, &r.att_id, &index, http, llm, token).await?;
                notes = if gen.is_empty() { None } else { Some(gen) }; // `|| null`
            }
            if let Some(notes) = notes {
                let nb = notes_budget();
                let notes = if nb >= 0.0 && (js_len(&notes) as f64) > nb {
                    format!("{}\n[...]", js_slice_head(&notes, nb as usize))
                } else {
                    notes
                };
                blocks.push(format!(
                    "<course_notes name=\"{name}\">\nCourse notes distilled from the COMPLETE content of \"{name}\" (every part was read):\n{notes}\n{rules} Cite the [HH:MM:SS] block headers of the notes.\n</course_notes>",
                    name = r.name,
                    notes = notes,
                    rules = rules(r),
                ));
            }
            // UNCONDITIONAL continue (turn.ts:188) — whole_video never
            // falls through to hybrid retrieval, notes or not.
            continue;
        }

        // `try { queryVec = await embedOne(rq) } catch {}` — the seam's
        // Err keeps the vec empty (BM25 alone still ranks).
        let query_vec = embedder.embed_one(&rq).unwrap_or_default();

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
                    ..Default::default()
                },
                None => RetrieveOpts { mode: QueryMode::PointQa, ..Default::default() },
            }
        } else {
            RetrieveOpts { mode: routed.mode, from_sec: routed.from_sec, to_sec: routed.to_sec, range: None }
        };

        let ev = retrieve_evidence(&index, &rq, &query_vec, &opts);
        if ev.text.is_empty() {
            continue;
        }

        let mut block = format!(
            "<knowledge_index name=\"{name}\">\nPassages retrieved from the complete content of \"{name}\" (the full text is preserved locally — nothing was truncated):\n{text}",
            name = r.name,
            text = ev.text,
        );
        if ev.truncated {
            block.push_str("\n[more relevant passages exist; this turn's budget showed the best ones]");
        }
        block.push('\n');
        block.push_str(&rules(r));
        block.push_str("\n</knowledge_index>");
        blocks.push(block);
        images.extend(nearest_frames(root, &index, &ev.frame_ats));
    }

    if blocks.is_empty() && images.is_empty() {
        return Ok(0);
    }

    if !images.is_empty() {
        if let Some(msg) = messages.get_mut(user_idx) {
            let mut parts: Vec<Value> = match msg.get("content") {
                Some(Value::Array(arr)) => arr.clone(),
                Some(Value::String(s)) => vec![json!({ "type": "text", "text": s.clone() })],
                _ => vec![json!({ "type": "text", "text": "" })],
            };
            parts.push(json!({ "type": "text", "text": FRAME_LEAD_IN }));
            for (url, _) in &images {
                parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
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
        AttachmentRef { att_id: att.into(), name: name.into(), category: category.into() }
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
        // Segment 4 of the base ends "…was processed. " and the video
        // variant starts "You have watched…" — one space, no re-flowing.
        assert!(v.contains("do not explain how the content was processed. You have watched this video"));
        assert!(v.ends_with("when a time reference genuinely helps."));
        let a = rules(&ref_of("att_x1", "A", "audio"));
        assert!(a.ends_with("You have heard this recording directly: speak of what you hear; never mention transcription, retrieval or indexing."));
        let d = rules(&ref_of("att_x1", "D", "document"));
        assert!(d.ends_with("You have read this document directly; never mention retrieval or indexing."));
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
        assert_eq!(anchor_query("why does that happen", &msgs, 2), "Explain osmosis in cells why does that happen");
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
        assert_eq!(anchor_query("but why", &msgs2, 2), "Earlier topic here but why");
    }

    #[test]
    fn anchor_pronoun_heavy_long_query() {
        let msgs = vec![json!({ "role": "user", "content": "Mitosis phases" }), json!(null)];
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
            crate::types::FrameEntry { at: 100.0, file: "frames/f1.jpg".into() },
            crate::types::FrameEntry { at: 200.0, file: "frames/missing.jpg".into() },
        ];

        // Nearest pick is used BEFORE the read: the second lookup of the
        // same timestamp must try frame 2 (missing) and get nothing.
        let out = nearest_frames(root, &index, &[105.0, 105.0]);
        assert_eq!(out, vec![("data:image/jpeg;base64,QUJD".to_string(), 100.0)]);

        // All-used ⇒ break out of the timestamp loop.
        let out = nearest_frames(root, &index, &[105.0, 105.0, 105.0]);
        assert_eq!(out.len(), 1);

        // Missing-file read: slot consumed, nothing emitted, loop ends.
        let out = nearest_frames(root, &index, &[195.0]);
        assert!(out.is_empty());
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
            index.meta.frames.push(crate::types::FrameEntry { at: k as f64 * 10.0, file: format!("frames/f{k}.jpg") });
        }
        let ats: Vec<f64> = (0..6).map(|k| k as f64 * 10.0).collect();
        assert_eq!(nearest_frames(root, &index, &ats).len(), MAX_FRAMES);
    }

    // ---- async build_attachment_turn tests -----------------------------

    fn dummy_llm() -> NotesLlm {
        NotesLlm { url: "http://127.0.0.1:1/x".into(), key: "k".into() }
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
        build_attachment_turn(msgs, user_idx, q, root, embedder, &http, &dummy_llm(), token).await
    }

    #[tokio::test]
    async fn missing_index_emits_the_exact_honest_block() {
        let tmp = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let mut msgs = user_with_ref("att_gone01", "Bio I", "document");
        let n = build(&mut msgs, 0, "", tmp.path(), &FixedEmbedder(vec![]), &token).await.unwrap();
        assert_eq!(n, 1);
        assert_eq!(msgs.len(), 2); // system injected BEFORE the user turn
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(
            msgs[0]["content"].as_str().unwrap(),
            "<knowledge_index name=\"Bio I\">\nThe local knowledge index for this attachment is no longer available on disk. Say so honestly if the question needs it.\n</knowledge_index>",
        );
        // The user turn is untouched (no frames without an index).
        assert!(msgs[1]["content"].as_array().unwrap()[0]["type"].as_str().unwrap() == "attachment_ref");
    }

    fn seed_index(root: &Path, att: &str, category: &str, meta_extra: &str, chunks_jsonl: &str, frames: &[(&str, &[u8])]) {
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
        let n = build(&mut msgs, 0, "mitosis", root, &FixedEmbedder(vec![1.0, 0.0, 0.05]), &token).await.unwrap();
        assert_eq!(n, 1);
        assert_eq!(msgs.len(), 2);
        let sys = msgs[0]["content"].as_str().unwrap();
        assert!(sys.starts_with("<knowledge_index name=\"Doc\">\nPassages retrieved from the complete content of \"Doc\" (the full text is preserved locally — nothing was truncated):\n[00:00:10 - 00:00:20]\nmitosis cells divide\n"));
        assert!(sys.ends_with("You have read this document directly; never mention retrieval or indexing.\n</knowledge_index>"));
        let parts = msgs[1]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0]["type"], "attachment_ref"); // strip runs LATER (shared impl)
        assert_eq!(parts[1]["text"].as_str().unwrap(), FRAME_LEAD_IN);
        assert_eq!(parts[1]["type"], "text");
        assert_eq!(parts[2]["image_url"]["url"].as_str().unwrap(), "data:image/jpeg;base64,aGVsbG8=");
    }

    #[tokio::test]
    async fn unavailable_embedder_degrades_to_bm25_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_index(root, "att_doc98", "document", "", "{ \"i\": 0, \"text\": \"mitosis cells divide\", \"vec\": [] }", &[]);
        let token = CancellationToken::new();
        let mut msgs = user_with_ref("att_doc98", "Doc", "document");
        let n = build(&mut msgs, 0, "mitosis", root, &UnavailableEmbedder, &token).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn whole_video_uses_cached_notes_and_never_falls_through() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        seed_index(root, "att_wv99", "video", "", "{ \"i\": 0, \"text\": \"topic passage\", \"vec\": [] }", &[]);
        // Cached notes via the store's own writer (unit test — fixture
        // restrictions apply only to the golden store fixture).
        store::write_notes(root, "att_wv99", "Cell cycle notes here.").unwrap();
        let token = CancellationToken::new();
        let mut msgs = user_with_ref("att_wv99", "Vid", "video");
        let n = build(&mut msgs, 0, "give me a summary", root, &UnavailableEmbedder, &token).await.unwrap();
        assert_eq!(n, 1);
        let sys = msgs[0]["content"].as_str().unwrap();
        assert!(sys.starts_with("<course_notes name=\"Vid\">\nCourse notes distilled from the COMPLETE content of \"Vid\" (every part was read):\nCell cycle notes here.\n"));
        assert!(sys.contains("Cite the [HH:MM:SS] block headers of the notes.\n</course_notes>"));
        assert!(sys.contains("You have watched this video from start to finish"));
        // No hybrid knowledge_index block (turn.ts:188 unconditional continue).
        assert!(!sys.contains("Passages retrieved"));
        assert!(!sys.contains("<knowledge_index"));
    }

    #[tokio::test]
    async fn whole_video_empty_notes_yields_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // No spine blocks ⇒ generate_notes returns Ok("") (no network).
        seed_index(root, "att_wv98", "video", "", "{ \"i\": 0, \"text\": \"topic\", \"vec\": [] }", &[]);
        let token = CancellationToken::new();
        let mut msgs = user_with_ref("att_wv98", "Vid", "video");
        let n = build(&mut msgs, 0, "give me a summary", root, &UnavailableEmbedder, &token).await.unwrap();
        assert_eq!(n, 0);
        assert_eq!(msgs.len(), 1); // nothing injected
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
        let r = build(&mut msgs, 0, "give me a summary", root, &UnavailableEmbedder, &token).await;
        assert_eq!(r, Err(Cancelled));
        assert_eq!(msgs.len(), 1); // no partial injection
    }
}
