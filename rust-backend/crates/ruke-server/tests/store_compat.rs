//! PART 5 §27 — deterministic cross-language store compatibility.
//!
//! The store fixture bytes under `fixtures/attachments/store/` were written
//! by the PRODUCTION Node writer (`writeIndex`, recorded by
//! `__tests__/rust-golden/store-fixture.test.ts`) and are copied into a
//! temp ROOT **untouched** — Rust never reconstructs or edits them. The
//! retrieval oracle is the TS-recorded replay fixtures 01–05: Rust's
//! injected `<knowledge_index>` block (and keyframe data-url) is compared
//! BYTE-EXACT against the system/user content TypeScript forwarded upstream.
//!
//! The embedding seam is `FixedEmbedder(QUERY_VEC)` — the same fixed pseudo
//! vector the TS harness mocks (`embedOne -> [1,0,0.05]`).

mod common;

use common::{copy_tree, load_fixture, store_fixture_dir};

use ruke_attach::{build_attachment_turn, has_index, read_index, read_notes, FixedEmbedder, NotesLlm};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use common::PORT9_URL;

const QUERY_VEC: &[f64] = &[1.0, 0.0, 0.05];

/// A temp app root whose `.data/attach-index` holds the committed fixture
/// bytes for `atts`, copied verbatim (mirrors TS `process.cwd()` ROOT).
fn seeded_root(atts: &[&str]) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join(".data").join("attach-index");
    for a in atts {
        copy_tree(&store_fixture_dir(a), &store.join(a));
    }
    tmp
}

fn fixture(rel: &str) -> Value {
    load_fixture(&format!("attachments/{rel}"))
}

/// The forwarded upstream payload of a recorded fixture (the TS oracle).
fn ts_payload(fx: &Value) -> Value {
    serde_json::from_str(fx["upstreamCalls"][0]["bodyText"].as_str().unwrap()).unwrap()
}

/// The `<knowledge_index…>` system block TS forwarded (retrieval output
/// including the formatting rules — the full formatted oracle).
fn ts_block(fx: &Value) -> String {
    ts_payload(fx)["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m.get("content"))
        .filter_map(Value::as_str)
        .find(|c| c.starts_with("<knowledge_index"))
        .unwrap_or_else(|| panic!("fixture has no knowledge_index block"))
        .to_string()
}

fn ts_image_url(fx: &Value) -> String {
    for m in ts_payload(fx)["messages"].as_array().unwrap() {
        if let Some(parts) = m.get("content").and_then(Value::as_array) {
            for p in parts {
                if p["type"].as_str() == Some("image_url") {
                    return p["image_url"]["url"].as_str().unwrap().to_string();
                }
            }
        }
    }
    panic!("fixture has no image_url part");
}

/// The request payload's messages (fresh per call).
fn rust_messages(fx: &Value) -> Vec<Value> {
    let req: Value = serde_json::from_str(fx["request"]["rawBody"].as_str().unwrap()).unwrap();
    req["messages"].as_array().unwrap().clone()
}

/// The request's question (first text part of the last user turn — what
/// route.ts passes as `fullText`).
fn question_of(fx: &Value) -> String {
    let req: Value = serde_json::from_str(fx["request"]["rawBody"].as_str().unwrap()).unwrap();
    let last = req["messages"].as_array().unwrap().last().unwrap();
    for p in last["content"].as_array().unwrap() {
        if let Some(t) = p.get("text").and_then(Value::as_str) {
            if !t.trim().is_empty() {
                return t.to_string();
            }
        }
    }
    panic!("no text part in the request turn");
}

/// Drive the Rust turn assembly (spine is empty in every seeded index, so
/// the notes LLM is never contacted — port 9 pins it off live inference).
async fn rust_turn(fx: &Value, user_idx: usize, root: &std::path::Path) -> (Vec<Value>, usize) {
    let mut messages = rust_messages(fx);
    let http = reqwest::Client::new();
    let llm = NotesLlm { url: PORT9_URL.to_string(), key: "golden-key".into() };
    let embedder = FixedEmbedder(QUERY_VEC.to_vec());
    let n = build_attachment_turn(
        &mut messages,
        user_idx,
        &question_of(fx),
        root,
        &embedder,
        &http,
        &llm,
        &CancellationToken::new(),
    )
    .await
    .expect("retrieval must never fail here");
    (messages, n)
}

fn rust_block(messages: &[Value]) -> String {
    messages
        .iter()
        .filter_map(|m| (m["role"] == "system").then(|| m.get("content")).flatten())
        .filter_map(Value::as_str)
        .find(|c| c.starts_with("<knowledge_index"))
        .unwrap_or_else(|| panic!("Rust injected no knowledge_index block"))
        .to_string()
}

// ---------------------------------------------------------------------------

#[test]
fn node_written_meta_and_chunks_parse_field_by_field() {
    let tmp = seeded_root(&["att_golden1a", "att_golden1c", "att_golden1d"]);
    let root = tmp.path();

    assert!(has_index(root, "att_golden1a"));
    assert!(has_index(root, "att_golden1c"));
    assert!(has_index(root, "att_golden1d"));
    assert!(!has_index(root, "att_golden1b"), "fixture 02: never seeded");
    assert!(!has_index(root, "xyz"), "ATT_RE gate (store parity, not an error)");

    let idx = read_index(root, "att_golden1a").unwrap();
    assert_eq!(idx.meta.att_id, "att_golden1a");
    assert_eq!(idx.meta.name, "intro-biology.pdf");
    assert_eq!(idx.meta.category, "text");
    assert_eq!(idx.meta.created_at, 0.0);
    assert_eq!(idx.meta.duration_sec, None);
    assert_eq!(idx.meta.chunk_count, 3);
    assert_eq!(idx.meta.spine, "");
    assert!(idx.meta.spine_blocks.is_empty());
    assert!(idx.meta.frames.is_empty());
    assert_eq!(idx.chunks.len(), 3);
    assert_eq!(idx.chunks[1].i, 1);
    assert_eq!(idx.chunks[1].text, "The Calvin cycle fixes carbon dioxide using ATP and NADPH.");
    assert_eq!(idx.chunks[1].start_sec, None);
    assert_eq!(idx.chunks[1].vec, vec![0.0, 1.0, 0.0]);

    let idx = read_index(root, "att_golden1c").unwrap();
    assert_eq!(idx.meta.chunk_count, 0);
    assert!(idx.chunks.is_empty(), "empty chunks.jsonl -> no chunks");

    let idx = read_index(root, "att_golden1d").unwrap();
    assert_eq!(idx.meta.category, "video");
    assert_eq!(idx.meta.chunk_count, 3);
    assert_eq!(idx.meta.frames.len(), 1);
    assert_eq!(idx.meta.frames[0].at, 6310.0);
    assert_eq!(idx.meta.frames[0].file, "frames/f_golden1.jpg");
    assert_eq!(idx.chunks[1].start_sec, Some(6300.0));

    // The golden corpus never writes notes.json.
    for a in ["att_golden1a", "att_golden1c", "att_golden1d"] {
        assert_eq!(read_notes(root, a), None);
    }
}

#[tokio::test]
async fn fixture_01_rust_block_is_ts_block_byte_exact() {
    let tmp = seeded_root(&["att_golden1a"]);
    let fx = fixture("01-retrieval-success.json");
    // The recorded injection-index quirk (lastUserIdx + 1, REPRODUCED).
    let (messages, n) = rust_turn(&fx, 1, tmp.path()).await;
    assert_eq!(n, 1, "one knowledge block -> retrieval_done done=total=1");
    assert_eq!(rust_block(&messages), ts_block(&fx), "formatted evidence block must match TS byte-for-byte");
    assert_eq!(messages[0]["role"], "user", "block lands AFTER the user turn (quirk)");
    assert_eq!(messages[1]["role"], "system");
}

#[tokio::test]
async fn fixture_02_missing_index_honest_block_matches_ts() {
    // The root intentionally has NO att_golden1b — same bytes as the other
    // tests never touched it.
    let tmp = seeded_root(&["att_golden1a"]);
    let fx = fixture("02-missing-index-honest-block.json");
    let (messages, n) = rust_turn(&fx, 1, tmp.path()).await;
    assert_eq!(n, 1, "the honest block still counts as an injected block");
    assert_eq!(rust_block(&messages), ts_block(&fx));
}

#[tokio::test]
async fn fixture_03_empty_index_injects_nothing() {
    let tmp = seeded_root(&["att_golden1c"]);
    let fx = fixture("03-empty-index-zero-evidence.json");
    let (messages, n) = rust_turn(&fx, 1, tmp.path()).await;
    assert_eq!(n, 0, "empty evidence -> no block -> retrieval_done done=total=0");
    assert_eq!(messages.len(), 1, "no system message was injected");
}

#[tokio::test]
async fn fixture_04_video_time_range_block_matches_ts() {
    let tmp = seeded_root(&["att_golden1d"]);
    let fx = fixture("04-video-time-range-keyframes-dropped.json");
    let (messages, n) = rust_turn(&fx, 1, tmp.path()).await;
    assert_eq!(n, 1);
    assert_eq!(rust_block(&messages), ts_block(&fx), "time_range header + video rules must match");
    // The quirk: frames target messages[1] (the string block) -> silently
    // dropped, exactly as fixture 04 records.
    assert_eq!(messages[1]["role"], "system");
    let user_parts = messages[0]["content"].as_array().unwrap();
    assert!(!user_parts.iter().any(|p| p["type"] == "image_url"), "keyframe must be DROPPED here");
}

#[tokio::test]
async fn fixture_05_shift_correct_path_lands_block_and_keyframe() {
    let tmp = seeded_root(&["att_golden1d"]);
    let fx = fixture("05-video-frames-with-skill-shift.json");
    // Raw fixture 05 has NO skill block; pass the turn's real index (0) to
    // exercise the shift-CORRECT arm: frames land on the user turn (added
    // BEFORE the splice), the block splices at user_idx.
    let (messages, n) = rust_turn(&fx, 0, tmp.path()).await;
    assert_eq!(n, 1);
    assert_eq!(messages[0]["role"], "system", "block BEFORE the user turn when the index is valid");
    assert_eq!(rust_block(&messages), ts_block(&fx));
    let user_parts = messages[1]["content"].as_array().unwrap();
    assert!(user_parts
        .iter()
        .any(|p| p["type"] == "text" && p["text"].as_str().unwrap().starts_with("Moments from the attached video")));
    let img = user_parts.iter().find(|p| p["type"] == "image_url").expect("keyframe must land");
    assert_eq!(img["image_url"]["url"].as_str().unwrap(), ts_image_url(&fx), "frame bytes -> data-url must match TS byte-for-byte");
}
